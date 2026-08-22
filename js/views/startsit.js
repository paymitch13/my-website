// Start/Sit — weekly lineup decisions.

import { buildStartSitReport, evaluatePlayerWeek, lineupChanges, slateAverage } from '../startsit.js';
import { buildDefenseProfiles, rankDefenses } from '../matchup.js';
import { fetchWeatherForGames } from '../weather.js';
import { loadWeekContext, loadOdds } from '../data.js';
import { isOnBye } from '../schedule.js';
import { slotLabel } from '../league.js';
import { openSyncModal } from '../app.js';
import {
    banner, el, emptyState, fmtDelta, playerLink, posBadge, round, sortBy,
    spinnerRow, tag, tile,
} from '../ui.js';

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
    const weatherByHome = await fetchWeatherForGames(games);

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
            tile('Close calls', report.closeCalls.length, 'within 2.5 points')
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

    // --- Close calls -------------------------------------------------------
    if (report.closeCalls.length) {
        const card = el('div', { class: 'card' });
        card.append(
            el('h3', {}, 'Close calls'),
            el('p', { class: 'muted small' }, 'These are within 2.5 points — the decisions actually in doubt.')
        );
        for (const c of report.closeCalls) {
            card.append(
                el(
                    'div',
                    { class: 'reason k-neutral' },
                    el(
                        'div',
                        {},
                        el(
                            'div',
                            { class: 'r-title' },
                            `${c.start.player.name} over ${c.sit.player.name} by ${round(c.gap, 1)} at ${c.slot}`
                        ),
                        el('div', { class: 'r-detail' }, closeCallReason(c))
                    )
                )
            );
        }
        wrap.append(card);
    }

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
                    ...report.benchedByBye.map((e) =>
                        el('span', { class: 'chip', style: 'padding:4px 8px' }, posBadge(e.player.pos), playerLink(e.player))
                    )
                )
            )
        );
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

function closeCallReason(c) {
    const a = c.start.evaluation;
    const b = c.sit.evaluation;
    const bits = [];
    const topA = a.factors[0];
    const topB = b.factors[0];
    if (topA && Math.abs(topA.multiplier - 1) > 0.03) bits.push(`${c.start.player.name}: ${topA.detail}`);
    if (topB && Math.abs(topB.multiplier - 1) > 0.03) bits.push(`${c.sit.player.name}: ${topB.detail}`);
    if (!bits.length) bits.push('Nothing separates them beyond the raw projection — a genuine coin flip.');
    return bits.join(' ');
}
