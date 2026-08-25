// Start/Sit — weekly lineup decisions.

import {
    buildStartSitReport, comparePlayers, describeComparison, evaluatePlayerWeek,
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
    const evaluations = team.players.map((player) =>
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
        })
    );

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

    // --- Recommended lineup ------------------------------------------------
    wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Recommended lineup')));
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
                            el('th', {}, 'Why')
                        )
                    ),
                    el(
                        'tbody',
                        {},
                        ...report.lineup.slots.map((slot) =>
                            slot.entry ? playerRow(slot, slot.entry.evaluation) : emptySlotRow(slot)
                        )
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

    // --- The rest of the roster --------------------------------------------
    //
    // The bench was computed and then never rendered, so most of the roster was
    // invisible on the one page whose entire job is choosing between the
    // players on it. Same columns as the starters, because the comparison only
    // works if the numbers are the same numbers.
    if (report.bench.length) {
        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, 'Bench'),
                el('span', { class: 'hint' }, `${report.bench.length} players, same numbers as above`)
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
                                el('th', {}, 'Player'),
                                el('th', { class: 'hide-sm' }, 'Matchup'),
                                el('th', { class: 'right hide-sm' }, 'Base'),
                                el('th', { class: 'right' }, 'Adjusted'),
                                el('th', { class: 'right hide-sm' }, 'Behind'),
                                el('th', {}, 'Why')
                            )
                        ),
                        el('tbody', {}, ...report.bench.map((e) => benchRow(e, report)))
                    )
                )
            )
        );
    }

    // --- Head to head -------------------------------------------------------
    // The question people actually ask, which nothing on this page could answer
    // before: two names, one call.
    wrap.append(
        el(
            'div',
            { class: 'section-head' },
            el('h2', {}, 'Head to head'),
            el('span', { class: 'hint' }, 'compare any two players on this roster')
        )
    );
    wrap.append(headToHead(app, evaluations));

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

function playerRow(slot, ev) {
    const p = ev.player;
    const delta = ev.adjusted - ev.baseProjection;
    return el(
        'tr',
        {},
        el('td', { class: 'tiny dim nowrap' }, slot.label),
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
        el('td', {}, factorChips(ev))
    );
}

function emptySlotRow(slot) {
    return el(
        'tr',
        {},
        el('td', { class: 'tiny dim nowrap' }, slotLabel(slot.slot)),
        el('td', { class: 'dim', colspan: '5' }, 'Nobody on the roster can fill this slot')
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
function benchRow(entry, report) {
    const ev = entry.evaluation;
    const p = entry.player;
    const delta = ev.adjusted - ev.baseProjection;

    // How far off the lineup he is: the smallest gap to any slot he could
    // legally fill. A receiver 0.3 behind the flex is a live decision; the same
    // receiver 12 behind is depth.
    const behind = report.decisions
        .filter((d) => d.alternatives.some((a) => a.entry.player.id === p.id))
        .map((d) => d.alternatives.find((a) => a.entry.player.id === p.id).gap);
    const closest = behind.length ? Math.min(...behind) : null;

    return el(
        'tr',
        {},
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
            { class: `num right small hide-sm ${closest !== null && closest <= 1.5 ? 'warn' : 'dim'}` },
            closest === null ? '—' : `−${round(closest, 1)}`
        ),
        el('td', {}, factorChips(ev))
    );
}

/**
 * Two players, side by side.
 *
 * Deliberately stateful and local: the picker writes into a pair of slots and
 * repaints just this card, so choosing a player never costs a full re-render of
 * a page that took several network calls to build.
 */
function headToHead(app, evaluations) {
    const startable = sortBy(
        evaluations.filter((e) => e.adjusted !== null),
        (e) => e.adjusted,
        -1
    );
    const host = el('div', { class: 'card' });
    if (startable.length < 2) {
        host.append(el('p', { class: 'muted' }, 'Not enough players with a projection this week to compare.'));
        return host;
    }

    // Open on the closest call there is, so the card is useful before it is
    // touched rather than being two empty boxes.
    let a = startable[0];
    let b = startable[1];
    const opener = bestPair(evaluations);
    if (opener) {
        a = opener.a;
        b = opener.b;
    }

    const pick = async (which) => {
        const chosen = await pickPlayer({
            title: which === 'a' ? 'First player' : 'Second player',
            entries: startable.map((e) => ({ player: e.player, value: e.adjusted, posRank: null })),
            emptyText: 'Nobody on this roster has a projection this week.',
            formatValue: (v) => round(v, 1),
        });
        if (!chosen) return;
        const picked = startable.find((e) => e.player.id === chosen.player.id);
        if (!picked) return;
        if (which === 'a') a = picked;
        else b = picked;
        paint();
    };

    function side(entry, which) {
        const ev = entry;
        return el(
            'div',
            { class: 'h2h-side' },
            el(
                'button',
                { class: 'btn btn-sm', style: 'width:100%;justify-content:flex-start', onclick: () => pick(which) },
                posBadge(ev.player.pos),
                el('span', { class: 'ellipsis', style: 'min-width:0' }, ev.player.name),
                el('span', { class: 'tiny dim' }, '▾')
            ),
            el('div', { class: 'num', style: 'font-size:26px;margin-top:8px' }, round(ev.adjusted, 1)),
            el('div', { class: 'tiny dim' }, ev.opponent ? `vs ${ev.opponent}` : 'no game'),
            el('div', { style: 'margin-top:8px' }, factorChips(ev))
        );
    }

    function paint() {
        const cmp = comparePlayers(a, b);
        host.replaceChildren(
            el(
                'div',
                { class: 'h2h' },
                side(a, 'a'),
                el('div', { class: 'h2h-mid' }, el('span', { class: 'tiny dim' }, 'VS')),
                side(b, 'b')
            ),
            el(
                'div',
                { class: `verdict tone-${cmp.blocked ? 'bad' : cmp.tooClose ? 'warn' : 'good'}`, style: 'margin-top:14px' },
                el('div', { class: 'label' }, cmp.blocked ? 'Not a decision' : cmp.tooClose ? 'Too close to call' : 'Start'),
                el('div', { class: 'headline' }, describeComparison(cmp))
            ),
            cmp.swings.length
                ? el(
                      'div',
                      { style: 'margin-top:12px' },
                      el('div', { class: 'tiny dim', style: 'margin-bottom:6px' }, 'WHAT SEPARATES THEM'),
                      ...cmp.swings.slice(0, 4).map((sw) =>
                          el(
                              'div',
                              { class: 'row', style: 'gap:8px;padding:3px 0;min-width:0' },
                              el('span', { class: 'tiny dim', style: 'min-width:64px' }, FACTOR_LABEL[sw.kind] || sw.kind),
                              el(
                                  'span',
                                  { class: `small ${sw.edge > 0 ? 'good' : 'bad'}`, style: 'min-width:0;flex:1' },
                                  `${(sw.edge > 0 ? a : b).player.name} by ${Math.round(Math.abs(sw.edge) * 100)}%`
                              )
                          )
                      )
                  )
                : el('p', { class: 'tiny dim', style: 'margin-top:10px' }, 'Nothing in the matchup separates them — the gap is the raw projection.')
        );
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
