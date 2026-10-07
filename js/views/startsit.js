// Start/Sit — weekly lineup decisions.

import {
    buildStartSitReport, compareField, describeField, evaluatePlayerWeek,
    lineupChanges, slateAverage,
} from '../startsit.js';
import { buildDefenseProfiles, rankDefenses } from '../matchup.js';
import { fetchWeatherForGames } from '../weather.js';
import { loadSlateProps } from '../props.js';
import * as store from '../store.js';
import { loadWeekContext, loadOdds } from '../data.js';
import { isOnBye } from '../schedule.js';
import { slotLabel } from '../league.js';
import { openSyncModal } from '../app.js';
import {
    banner, el, emptyState, fmtDelta, idpNotice, pickPlayer, playerLink, posBadge,
    round, sortBy, spinnerRow, tag, tile,
} from '../ui.js';

/** Readable names for the market keys, for the movement line. */
const PROP_LABEL = {
    pass_yd: 'pass yds', pass_td: 'pass TDs', pass_att: 'attempts', pass_int: 'INTs',
    rush_yd: 'rush yds', rush_td: 'rush TDs', rush_att: 'carries',
    rec_yd: 'rec yds', rec_td: 'rec TDs', rec: 'receptions',
};

export default function renderStartSit(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Start / Sit'),
            el(
                'p',
                { class: 'sub' },
                'This week’s projection is the starting point, not the answer. Every player is adjusted for ',
                'his team’s Vegas implied total, how this defense has actually treated the position, stadium ',
                'weather, and health — and every adjustment is shown so you can disagree with it.'
            )
        )
    );

    if (!app.league) {
        root.append(
            emptyState(
                '🧠',
                'Connect a league first',
                'Start/Sit works on your actual roster and your league’s scoring.',
                el('button', { class: 'btn btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        return root;
    }

    const teams = sortBy(app.league.teams, (t) => t.name.toLowerCase());
    let selected =
        teams.find((t) => t.ownerId && t.ownerId === app.userId) || teams[0];

    const host = el('div', {});
    const picker = el(
        'select',
        {
            style: 'max-width:min(340px, 100%)',
            onchange: (e) => {
                selected = teams.find((t) => String(t.rosterId) === e.target.value);
                run();
            },
        },
        ...teams.map((t) => el('option', { value: String(t.rosterId), selected: t.rosterId === selected.rosterId }, t.name))
    );

    root.append(
        el(
            'div',
            { class: 'card card-tight' },
            el(
                'div',
                { class: 'row' },
                el('span', { class: 'tiny dim' }, 'ROSTER'),
                picker,
                el('div', { class: 'grow' }),
                el('span', { class: 'small dim' }, `Week ${app.league.currentWeek}`)
            )
        ),
        host
    );

    // Guards against a slow request for one roster painting over a newer one.
    let renderToken = 0;

    async function run() {
        const token = ++renderToken;
        const target = selected;
        host.replaceChildren(el('div', { class: 'card' }, spinnerRow('Pulling projections, lines, weather and matchup history…')));
        try {
            const built = await build(app, target);
            if (token !== renderToken) return;
            host.replaceChildren(built);
        } catch (err) {
            if (token !== renderToken) return;
            console.error(err);
            host.replaceChildren(emptyState('⚠️', 'Could not build the report', err.message));
        }
    }

    run();
    return root;
}

async function build(app, team) {
    const { cfg, currentWeek, lastPlayed, raw } = app.league;
    const season = raw.season;

    const [weekCtx, odds] = await Promise.all([
        loadWeekContext(season, currentWeek, lastPlayed),
        app.odds ? Promise.resolve(app.odds) : loadOdds(currentWeek, season),
    ]);

    const weekly = weekCtx.weekly;
    const games = odds?.games || [];
    const oddsByTeam = odds?.byTeam || new Map();

    // Posted player markets, which are a second projection with money behind
    // it. Preseason and early in a week there are none, and that is a normal
    // state rather than a failure -- everything below simply falls back to the
    // consensus projection it already had.
    const [weatherByHome, marketProps] = await Promise.all([
        fetchWeatherForGames(games),
        loadSlateProps(games, app.players, { store }).catch(() => new Map()),
    ]);

    const defenseProfiles = buildDefenseProfiles(weekCtx.weeklyStats, cfg.scoring);
    const defenseRanks = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) defenseRanks[pos] = rankDefenses(defenseProfiles, pos);

    const neutralImplied = slateAverage(oddsByTeam);

    // Scoring ONE player for this week, as a closure over the whole week's
    // context. Pulled out so the comparison card can score players who are not
    // on this roster -- somebody else's starter, a waiver pickup, a name from
    // a league the user is not even in. Nothing in the engine ever needed the
    // player to be rostered; only this function's shape implied it.
    const evaluateOne = (player) =>
        evaluatePlayerWeek({
            neutralImplied,
            player,
            weekly: weekly?.[player.id] || null,
            scoring: cfg.scoring,
            oddsByTeam,
            weatherByHome,
            defenseProfiles,
            defenseRanks,
            weeksLeft: Math.max(1, app.league.weeksLeft),
            onBye: isOnBye(app.byeWeeks, player.team, currentWeek),
            marketRow: marketProps.get(player.id) || null,
        });

    const evaluations = team.players.map(evaluateOne);

    const report = buildStartSitReport({ team, cfg, evaluations });
    const changes = lineupChanges(report, team.starterIds);

    const wrap = el('div', {});

    // --- Data availability, stated plainly ---------------------------------
    const notes = [];
    if (!weekly) notes.push('weekly projections unavailable');
    if (!games.length) notes.push('no Vegas lines posted yet');
    if (!defenseProfiles.size) notes.push('not enough games played for matchup history');
    if (notes.length) {
        wrap.append(
            banner(
                `Working with partial data — ${notes.join(', ')}. Recommendations fall back to whatever is available.`,
                'warn'
            )
        );
    }

    const idp = idpNotice(cfg);
    if (idp) wrap.append(idp);

    // --- Headline ----------------------------------------------------------
    wrap.append(
        el(
            'div',
            { class: 'tiles' },
            tile('Projected total', round(report.projectedTotal, 1), 'adjusted points, optimal lineup'),
            changes
                ? tile(
                      'Changes suggested',
                      changes.swaps.filter((s) => s.paired || s.add).length,
                      changes.swaps.length ? `worth ${round(changes.pointsGained, 1)} pts this week` : 'your lineup is already optimal',
                      changes.swaps.length ? 'warn' : 'good'
                  )
                : null,
            tile('Unavailable', report.unavailable.length, 'bye, no game, or ruled out'),
            tile('Close calls', report.closeCalls.length, `of ${report.decisions.length} slot decisions`)
        )
    );

    // --- Actionable swaps --------------------------------------------------
    if (changes && changes.swaps.length) {
        const card = el('div', { class: 'card' });
        card.append(el('h3', {}, 'Change your lineup'));
        const paired = changes.swaps.filter((s) => s.paired);
        const movingIn = changes.swaps.filter((s) => !s.paired && s.add).map((s) => s.add);
        const movingOut = changes.swaps.filter((s) => !s.paired && s.drop).map((s) => s.drop);

        for (const s of paired) {
            card.append(
                el(
                    'div',
                    { class: 'swap' },
                    swapSide('START', 'good', s.add),
                    el('div', { class: 'swap-arrow' }, '→'),
                    swapSide('SIT', 'bad', s.drop),
                    el('div', { class: `swap-gain num ${s.gain >= 0 ? 'good' : 'bad'}` }, `${fmtDelta(s.gain)} pts`)
                )
            );
        }

        // Cross-position moves are one restructure, not a list of individual
        // recommendations, and they have no meaningful head-to-head margin.
        if (movingIn.length || movingOut.length) {
            card.append(
                el(
                    'div',
                    { class: 'reshuffle' },
                    el('div', { class: 'tiny dim', style: 'margin-bottom:8px' }, 'FLEX AND SLOT RESHUFFLE'),
                    el(
                        'div',
                        { class: 'row', style: 'gap:6px;margin-bottom:6px' },
                        el('span', { class: 'tiny good', style: 'width:34px' }, 'IN'),
                        ...movingIn.map((e) =>
                            el('span', { class: 'chip', style: 'padding:4px 8px' }, posBadge(e.player.pos), playerLink(e.player), el('span', { class: 'tiny dim' }, round(e.score, 1)))
                        )
                    ),
                    el(
                        'div',
                        { class: 'row', style: 'gap:6px' },
                        el('span', { class: 'tiny bad', style: 'width:34px' }, 'OUT'),
                        ...movingOut.map((e) =>
                            el('span', { class: 'chip', style: 'padding:4px 8px' }, posBadge(e.player.pos), playerLink(e.player), el('span', { class: 'tiny dim' }, round(e.score, 1)))
                        )
                    )
                )
            );
        }

        card.append(
            el(
                'p',
                { class: 'small muted', style: 'margin:12px 0 0' },
                `Your current lineup projects to ${round(changes.currentTotal, 1)}. The recommendation projects to ${round(changes.recommendedTotal, 1)} — a gain of ${round(changes.pointsGained, 1)} points.`
            )
        );
        wrap.append(card);
    } else if (changes) {
        wrap.append(banner('Your Sleeper lineup already matches the recommendation. Nothing to change.', ''));
    }

    // --- The whole roster, one table ---------------------------------------
    //
    // Starters and bench together, in the same table, with the same columns.
    //
    // They used to be two sections with the bench far below the per-slot
    // decision cards, and that made the comparison the page exists for into a
    // scrolling exercise: the projections were "at the top" for the nine men
    // already starting and nowhere near them for the fifteen the manager is
    // deciding between. Numbers you have to hold in your head while you scroll
    // are numbers you cannot compare.
    //
    // The margin column carries the whole decision in one number: how clear a
    // starter is, or how far off the lineup a bench player is.
    wrap.append(
        el(
            'div',
            { class: 'section-head' },
            el('h2', {}, 'Your roster this week'),
            el('span', { class: 'hint' }, `${report.lineup.slots.filter((s) => s.entry).length} starting · ${report.bench.length} on the bench · same numbers throughout`)
        )
    );
    wrap.append(
        el(
            'div',
            { class: 'card' },
            el(
                'div',
                { class: 'table-scroll' },
                el(
                    'table',
                    { class: 'table' },
                    el(
                        'thead',
                        {},
                        el(
                            'tr',
                            {},
                            el('th', {}, 'Slot'),
                            el('th', {}, 'Player'),
                            el('th', { class: 'hide-sm' }, 'Matchup'),
                            el('th', { class: 'right hide-sm' }, 'Base'),
                            el('th', { class: 'right' }, 'Adjusted'),
                            el('th', { class: 'right hide-sm' }, 'Margin'),
                            el('th', {}, 'Why')
                        )
                    ),
                    el(
                        'tbody',
                        {},
                        ...report.lineup.slots.map((slot) =>
                            slot.entry
                                ? rosterRow({ entry: slot.entry, slot, report })
                                : emptySlotRow(slot)
                        ),
                        ...(report.bench.length
                            ? [
                                  el(
                                      'tr',
                                      { class: 'row-divider' },
                                      el('td', { colspan: '7', class: 'tiny dim' }, 'BENCH')
                                  ),
                                  ...report.bench.map((entry) => rosterRow({ entry, report })),
                              ]
                            : [])
                    )
                )
            )
        )
    );

    // --- Every decision on the roster --------------------------------------
    //
    // One card per starting slot, with everyone eligible to take it. This
    // replaced a "close calls" list that showed only benched players within
    // 2.5 points of a starter, drawn from the top eight on the bench -- so two
    // quarterbacks four points apart, the only two you own, were never put next
    // to each other at all.
    wrap.append(
        el(
            'div',
            { class: 'section-head' },
            el('h2', {}, 'Every decision'),
            el('span', { class: 'hint' }, 'each slot, and everyone who could take it')
        )
    );

    const decisions = report.decisions.filter((d) => d.alternatives.length);
    if (!decisions.length) {
        wrap.append(
            el(
                'div',
                { class: 'card' },
                el('p', { class: 'muted' }, 'Every slot has exactly one eligible player, so there is nothing to decide this week.')
            )
        );
    }
    for (const d of decisions) {
        const tight = d.margin !== null && d.margin <= 2.5;
        const card = el('div', { class: 'card card-tight', style: 'margin-bottom:10px' });
        card.append(
            el(
                'div',
                { class: 'row', style: 'gap:8px;align-items:center' },
                el('span', { class: 'tiny dim', style: 'min-width:42px' }, d.label),
                posBadge(d.starter.player.pos),
                el('span', { style: 'font-weight:650;min-width:0;overflow-wrap:anywhere' }, playerLink(d.starter.player)),
                el('span', { class: 'num small', style: 'color:var(--accent)' }, round(d.starter.score, 1)),
                el('div', { class: 'grow' }),
                tight
                    ? tag(`${round(d.margin, 1)} clear`, 'warn')
                    : tag(`${round(d.margin, 1)} clear`, 'good')
            )
        );

        // How many alternatives are worth printing depends on how close the
        // call is. Listing five names under a slot the starter leads by ninety
        // points is padding; under a slot he leads by one, every one of them is
        // a real option. Always at least two, so the comparison the manager
        // came for is on the page either way.
        const inContention = d.alternatives.filter((a) => a.gap <= 8);
        const shown = d.alternatives.slice(0, Math.min(4, Math.max(2, inContention.length)));
        const hidden = d.alternatives.length - shown.length;

        const list = el('div', { style: 'margin-top:8px' });
        for (const alt of shown) {
            const ev = alt.entry.evaluation;
            list.append(
                el(
                    'div',
                    { class: 'row', style: 'gap:8px;align-items:center;padding:4px 0;min-width:0' },
                    el('span', { class: 'tiny dim', style: 'min-width:42px' }, 'instead'),
                    posBadge(alt.entry.player.pos),
                    el('span', { class: 'small ellipsis', style: 'min-width:0;flex:1' }, playerLink(alt.entry.player)),
                    ev?.opponent ? el('span', { class: 'tiny dim nowrap hide-sm' }, `vs ${ev.opponent}`) : null,
                    el('span', { class: 'num small muted' }, round(alt.entry.score, 1)),
                    el(
                        'span',
                        { class: `num tiny ${alt.gap <= 1 ? 'warn' : 'dim'}`, style: 'min-width:52px;text-align:right' },
                        `−${round(alt.gap, 1)}`
                    )
                )
            );
        }
        card.append(list);
        if (hidden > 0) {
            card.append(
                el('p', { class: 'tiny dim', style: 'margin:6px 0 0' },
                    `${hidden} more eligible, all further behind.`)
            );
        }
        wrap.append(card);
    }


    // --- Compare players ----------------------------------------------------
    // The question people actually type into a group chat. Two to four names,
    // one call, and they do not have to be players the user owns.
    wrap.append(
        el(
            'div',
            { class: 'section-head' },
            el('h2', {}, 'Compare players'),
            el('span', { class: 'hint' }, 'two to four, any player in the league')
        )
    );
    wrap.append(compareCard(app, evaluations, evaluateOne));

    // --- Bench and byes ----------------------------------------------------
    if (report.unavailable.length) {
        wrap.append(
            el(
                'div',
                { class: 'card' },
                el('h3', {}, 'No game this week'),
                el(
                    'div',
                    { class: 'row', style: 'gap:6px' },
                    // The guard above and the list here have to be the same
                    // field: they were not, so the section threw whenever it
                    // was the section that had something to say.
                    ...report.unavailable.map((e) =>
                        el('span', { class: 'chip', style: 'padding:4px 8px' }, posBadge(e.player.pos), playerLink(e.player))
                    )
                )
            )
        );
    }

    // --- Where the market disagrees with the projection --------------------
    // Everything else on this page descends from one consensus projection.
    // These are the players the betting market prices differently, and that is
    // the most actionable single thing a start/sit tool can say: the people
    // with money at risk are not where the projection is.
    const disagreements = sortBy(
        evaluations.filter((e) => e.marketDisagreement),
        (e) => Math.abs(e.marketDisagreement.share),
        -1
    ).slice(0, 6);

    if (disagreements.length) {
        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, 'Where Vegas disagrees'),
                el('span', { class: 'hint' }, 'posted player props against the projection')
            )
        );
        const card = el('div', { class: 'card' });
        for (const ev of disagreements) {
            const d = ev.marketDisagreement;
            const moves = Object.entries(ev.marketMovement || {});
            card.append(
                el(
                    'div',
                    { class: `reason k-${d.direction === 'higher' ? 'good' : 'warn'}`, style: 'align-items:center' },
                    el(
                        'div',
                        { style: 'min-width:0;flex:1' },
                        el(
                            'div',
                            { class: 'row', style: 'gap:8px' },
                            posBadge(ev.player.pos),
                            el('span', { style: 'font-weight:600' }, playerLink(ev.player)),
                            ev.opponent ? el('span', { class: 'tiny dim' }, `vs ${ev.opponent}`) : null
                        ),
                        el('div', { class: 'r-detail' },
                            d.text,
                            moves.length
                                ? ` Lines have moved since open: ${moves
                                      .map(([k, m]) => `${PROP_LABEL[k] || k} ${m.change > 0 ? '+' : ''}${round(m.change, 1)}`)
                                      .join(', ')}.`
                                : '')
                    ),
                    el(
                        'div',
                        { class: 'num nowrap', style: 'text-align:right' },
                        el('div', { class: d.direction === 'higher' ? 'good' : 'bad' },
                            `${d.share > 0 ? '+' : ''}${Math.round(d.share * 100)}%`),
                        el('div', { class: 'tiny dim' }, `${round(d.market, 1)} vs ${round(d.projection, 1)}`)
                    )
                )
            );
        }
        wrap.append(card);
    }

    // --- Slate weather -----------------------------------------------------
    const outdoor = [...weatherByHome.values()].filter((w) => w && !w.dome && !w.unavailable);
    if (outdoor.length) {
        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Around the slate'), el('span', { class: 'hint' }, 'outdoor venues only')));
        wrap.append(
            el(
                'div',
                { class: 'card' },
                el(
                    'div',
                    { class: 'table-scroll' },
                    el(
                        'table',
                        { class: 'table' },
                        el('thead', {}, el('tr', {}, el('th', {}, 'Venue'), el('th', { class: 'right' }, 'Temp'), el('th', { class: 'right' }, 'Wind'), el('th', { class: 'right' }, 'Precip'))),
                        el(
                            'tbody',
                            {},
                            ...sortBy(outdoor, (w) => -(w.wind ?? 0)).map((w) =>
                                el(
                                    'tr',
                                    {},
                                    el('td', { class: 'small' }, w.venue),
                                    el('td', { class: 'num right small' }, w.temp === null ? '—' : `${Math.round(w.temp)}°`),
                                    el('td', { class: `num right small ${w.wind >= 15 ? 'warn' : ''}` }, w.wind === null ? '—' : `${Math.round(w.wind)} mph`),
                                    el('td', { class: 'num right small' }, w.precipProbability === null ? '—' : `${Math.round(w.precipProbability)}%`)
                                )
                            )
                        )
                    )
                )
            )
        );
    }

    wrap.append(
        el(
            'p',
            { class: 'tiny dim', style: 'margin-top:18px' },
            'Adjustments are multiplicative on the weekly projection. Vegas uses implied team totals; matchup uses how each ',
            'defense has performed against the position relative to each player’s own baseline; weather applies only to outdoor ',
            'venues and is weighted by position. Individual player props are not available from a free data source, so they are ',
            'not part of this.'
        )
    );

    return wrap;
}

function swapSide(label, tone, entry) {
    return el(
        'div',
        { class: 'swap-side' },
        el('div', { class: `tiny ${tone}` }, label),
        el('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap;min-width:0' }, posBadge(entry.player.pos), el('span', { class: 'ellipsis' }, playerLink(entry.player))),
        el('div', { class: 'tiny dim' }, `${round(entry.score, 1)} projected`)
    );
}

/**
 * One row of the roster table, starter or bench.
 *
 * Deliberately ONE function. There used to be two near-identical ones, and the
 * duplication was not free: the bench row grew a "behind the lineup" column
 * that the starter row never got, so the two halves of the same roster were
 * described with different columns and could not be read against each other.
 *
 * @param {object} input
 * @param {object} input.entry   the scored entry
 * @param {object} [input.slot]  the starting slot, when this player holds one
 * @param {object} input.report  for the per-slot margins
 */
function rosterRow({ entry, slot = null, report }) {
    const ev = entry.evaluation;
    const p = entry.player;
    const delta = ev.adjusted - ev.baseProjection;
    const margin = marginFor({ entry, slot, report });

    return el(
        'tr',
        { class: slot ? '' : 'row-bench' },
        el('td', { class: 'tiny dim nowrap' }, slot ? slot.label : 'BN'),
        el(
            'td',
            {},
            el(
                'div',
                { class: 'row', style: 'gap:8px;flex-wrap:nowrap;min-width:0' },
                posBadge(p.pos),
                el('span', { class: 'ellipsis' }, playerLink(p)),
                p.injury ? tag(p.injury, 'bad') : null
            )
        ),
        el('td', { class: 'small nowrap hide-sm' }, ev.opponent ? `vs ${ev.opponent}` : '—'),
        el('td', { class: 'num right small muted hide-sm' }, round(ev.baseProjection, 1)),
        el(
            'td',
            { class: `num right ${delta > 0.4 ? 'good' : delta < -0.4 ? 'bad' : ''}` },
            round(ev.adjusted, 1)
        ),
        el(
            'td',
            { class: `num right small hide-sm ${margin.tone}`, title: margin.title },
            margin.text
        ),
        el('td', {}, factorChips(ev))
    );
}

/**
 * The decision, as one number.
 *
 * For a starter: how far clear he is of the best alternative for his slot --
 * the number that says whether this call is settled or worth a second look.
 * For a bench player: how far off the lineup he is, measured against the
 * closest slot he could legally fill. A receiver 0.3 behind the flex is a live
 * decision; the same receiver 12 behind is depth.
 */
function marginFor({ entry, slot, report }) {
    if (slot) {
        const d = report.decisions.find((x) => x.starter.player.id === entry.player.id);
        if (!d || d.margin === null) {
            return { text: '—', tone: 'dim', title: 'Nobody else on the roster can fill this slot.' };
        }
        const tight = d.margin <= 1.5;
        return {
            text: `+${round(d.margin, 1)}`,
            tone: tight ? 'warn' : 'good',
            title: tight
                ? `Only ${round(d.margin, 1)} clear of the next best option — worth a second look.`
                : `${round(d.margin, 1)} clear of the next best option for this slot.`,
        };
    }

    const gaps = report.decisions
        .filter((d) => d.alternatives.some((a) => a.entry.player.id === entry.player.id))
        .map((d) => d.alternatives.find((a) => a.entry.player.id === entry.player.id).gap);
    if (!gaps.length) {
        return { text: '—', tone: 'dim', title: 'No starting slot on this roster he is eligible for.' };
    }
    const closest = Math.min(...gaps);
    // A negative gap means he is actually ahead of somebody currently starting,
    // which is a recommendation, not depth.
    if (closest < 0) {
        return {
            text: `+${round(-closest, 1)}`,
            tone: 'good',
            title: `Projects ${round(-closest, 1)} AHEAD of a player currently in your lineup.`,
        };
    }
    return {
        text: `−${round(closest, 1)}`,
        tone: closest <= 1.5 ? 'warn' : 'dim',
        title: `${round(closest, 1)} behind the closest slot he could fill.`,
    };
}

function emptySlotRow(slot) {
    return el(
        'tr',
        {},
        el('td', { class: 'tiny dim nowrap' }, slotLabel(slot.slot)),
        // Six, not five: the roster table gained a margin column when the
        // bench was merged into it, and a short colspan silently shifts every
        // cell to its right.
        el('td', { class: 'dim', colspan: '6' }, 'Nobody on the roster can fill this slot')
    );
}

function factorChips(ev) {
    const chips = ev.factors
        .filter((f) => Math.abs(f.multiplier - 1) > 0.015)
        .slice(0, 3)
        .map((f) =>
            el(
                'span',
                { class: `tag ${f.multiplier > 1 ? 'tag-good' : 'tag-bad'}`, title: f.detail, style: 'margin-right:4px' },
                `${f.label} ${f.multiplier > 1 ? '+' : ''}${Math.round((f.multiplier - 1) * 100)}%`
            )
        );
    if (!chips.length) return el('span', { class: 'tiny dim' }, 'neutral');
    return el('div', { class: 'row', style: 'gap:2px' }, ...chips);
}

/** A bench player, with the same numbers the starters are judged on. */

/**
 * Two players, side by side.
 *
 * Deliberately stateful and local: the picker writes into a pair of slots and
 * repaints just this card, so choosing a player never costs a full re-render of
 * a page that took several network calls to build.
 */
/**
 * Compare two to four players for this week.
 *
 * Two things this replaces a pairwise card to do.
 *
 * First, a field rather than a pair. "Who do I start out of these three" has no
 * pairwise answer, and running the pair comparison three times produces three
 * sentences that each pretend the third man is not there.
 *
 * Second, ANY player. The old card could only choose from the user's own
 * roster, which quietly excluded most of the questions people actually ask: a
 * waiver pickup against the man he would replace, a trade target against the
 * starter he would displace, or just settling an argument about somebody
 * else's team. The engine never needed the player to be rostered -- only the
 * picker's player list implied it.
 */
function compareCard(app, evaluations, evaluateOne) {
    const host = el('div', { class: 'card' });

    // State is a list of evaluations, 2 to 4 of them.
    let field = [];
    const opener = bestPair(evaluations);
    if (opener) {
        field = [opener.a, opener.b];
    } else {
        const startable = sortBy(evaluations.filter((e) => e.adjusted !== null), (e) => e.adjusted, -1);
        field = startable.slice(0, 2);
    }
    if (field.length < 2) {
        host.append(
            el('p', { class: 'muted' },
                'Not enough players with a projection this week to compare. Once the week’s projections are posted this ' +
                'will compare any two to four players, on your roster or not.')
        );
        return host;
    }

    /** Everyone in the database worth offering, scored for this week on demand. */
    const poolFor = (exclude) => {
        const taken = new Set(exclude.map((e) => e.player.id));
        // Scored lazily: evaluating two thousand players to populate a picker
        // would cost more than the whole page. The rank is enough to order the
        // list, and the real evaluation happens on the one that gets chosen.
        return sortBy(
            Object.values(app.players)
                .filter((p) => !taken.has(p.id) && (app.rankings.get(p.id) ?? 999) < 900)
                .map((p) => ({ player: p, posRank: app.rankings.get(p.id), value: null })),
            (e) => e.posRank ?? 999
        );
    };

    const pick = async (index) => {
        const chosen = await pickPlayer({
            title: index < field.length ? 'Swap this player' : 'Add a player',
            entries: poolFor(field),
            emptyText: 'No players available.',
            formatValue: () => '',
        });
        if (!chosen) return;
        const ev = evaluateOne(chosen.player);
        if (index < field.length) field[index] = ev;
        else field.push(ev);
        paint();
    };

    function slot(entry, index) {
        const blocked = !entry.hasGame || entry.ruledOut;
        return el(
            'div',
            { class: 'h2h-side' },
            el(
                'div',
                { class: 'row', style: 'gap:4px' },
                el(
                    'button',
                    {
                        class: 'btn btn-sm grow',
                        style: 'justify-content:flex-start;min-width:0',
                        onclick: () => pick(index),
                    },
                    posBadge(entry.player.pos),
                    el('span', { class: 'ellipsis', style: 'min-width:0' }, entry.player.name),
                    el('span', { class: 'tiny dim' }, '▾')
                ),
                field.length > 2
                    ? el(
                          'button',
                          {
                              class: 'x',
                              title: `Remove ${entry.player.name}`,
                              onclick: () => {
                                  field.splice(index, 1);
                                  paint();
                              },
                          },
                          '✕'
                      )
                    : null
            ),
            el(
                'div',
                { class: `num ${blocked ? 'dim' : ''}`, style: 'font-size:26px;margin-top:8px' },
                blocked ? '—' : round(entry.adjusted, 1)
            ),
            el('div', { class: 'tiny dim' },
                entry.ruledOut ? 'ruled out' : !entry.hasGame ? 'no game this week' : `vs ${entry.opponent}`),
            el('div', { style: 'margin-top:8px' }, factorChips(entry))
        );
    }

    function paint() {
        const cmp = compareField(field);
        const leaderId = cmp?.leader?.player.id;

        const sides = [];
        field.forEach((entry, i) => {
            if (i) sides.push(el('div', { class: 'h2h-mid' }, el('span', { class: 'tiny dim' }, 'VS')));
            sides.push(slot(entry, i));
        });

        host.replaceChildren(
            el('div', { class: `h2h h2h-${field.length}` }, ...sides),
            el(
                'div',
                { class: 'row', style: 'margin-top:12px;gap:8px;flex-wrap:wrap' },
                field.length < 4
                    ? el('button', { class: 'btn btn-sm', onclick: () => pick(field.length) }, '+ Add a player')
                    : el('span', { class: 'tiny dim' }, 'Four is the most this compares at once.'),
                el('span', { class: 'grow' }),
                el('span', { class: 'tiny dim' }, 'Any player, on your roster or not')
            ),
            el(
                'div',
                { class: `verdict tone-${!cmp || !cmp.ranked.length ? 'bad' : cmp.tooClose ? 'warn' : 'good'}`, style: 'margin-top:14px' },
                el(
                    'div',
                    { class: 'label' },
                    !cmp || !cmp.ranked.length ? 'Not a decision' : cmp.tooClose ? 'Too close to call' : `Start ${cmp.leader.player.name}`
                ),
                el('div', { class: 'headline' }, describeField(cmp))
            ),
            // The full order, because with three or four players the ranking
            // below first place is the rest of the answer -- which one is the
            // fallback if somebody is a late scratch.
            cmp && cmp.ranked.length > 2
                ? el(
                      'div',
                      { style: 'margin-top:12px' },
                      el('div', { class: 'tiny dim', style: 'margin-bottom:6px' }, 'THE ORDER'),
                      ...cmp.ranked.map((r) =>
                          el(
                              'div',
                              { class: 'row', style: 'gap:8px;padding:3px 0;min-width:0' },
                              el('span', { class: 'tiny dim', style: 'min-width:18px' }, `${r.rank}.`),
                              posBadge(r.player.pos),
                              el('span', { class: 'small ellipsis', style: 'min-width:0;flex:1' }, playerLink(r.player)),
                              el('span', { class: 'num small' }, round(r.score, 1)),
                              el(
                                  'span',
                                  { class: `num tiny ${r.behind === 0 ? 'good' : r.behind <= 1 ? 'warn' : 'dim'}`, style: 'min-width:52px;text-align:right' },
                                  r.behind === 0 ? 'best' : `−${round(r.behind, 1)}`
                              )
                          )
                      )
                  )
                : null,
            cmp && cmp.swings.length
                ? el(
                      'div',
                      { style: 'margin-top:12px' },
                      el(
                          'div',
                          { class: 'tiny dim', style: 'margin-bottom:6px' },
                          cmp.ranked.length > 2 ? 'WHAT SEPARATES THE TOP TWO' : 'WHAT SEPARATES THEM'
                      ),
                      ...cmp.swings.slice(0, 4).map((sw) =>
                          el(
                              'div',
                              { class: 'row', style: 'gap:8px;padding:3px 0;min-width:0' },
                              el('span', { class: 'tiny dim', style: 'min-width:64px' }, FACTOR_LABEL[sw.kind] || sw.kind),
                              el(
                                  'span',
                                  { class: `small ${sw.edge > 0 ? 'good' : 'bad'}`, style: 'min-width:0;flex:1' },
                                  `${(sw.edge > 0 ? cmp.leader : cmp.runnerUp).player.name} by ${Math.round(Math.abs(sw.edge) * 100)}%`
                              )
                          )
                      )
                  )
                : cmp && cmp.ranked.length >= 2
                  ? el('p', { class: 'tiny dim', style: 'margin-top:10px' }, 'Nothing in the matchup separates them — the gap is the raw projection.')
                  : null
        );
        void leaderId;
    }

    paint();
    return host;
}

const FACTOR_LABEL = {
    vegas: 'Vegas',
    matchup: 'Matchup',
    weather: 'Weather',
    health: 'Health',
    market: 'Market',
};

/** The tightest genuine decision on the roster, to open the comparison on. */
function bestPair(evaluations) {
    const usable = evaluations.filter((e) => e.adjusted !== null && e.hasGame && !e.ruledOut);
    let best = null;
    for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
            // Same position, because that is the comparison a manager means
            // when they name two players.
            if (usable[i].player.pos !== usable[j].player.pos) continue;
            const gap = Math.abs(usable[i].adjusted - usable[j].adjusted);
            if (!best || gap < best.gap) best = { a: usable[i], b: usable[j], gap };
        }
    }
    return best;
}
