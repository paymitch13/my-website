// Stats — the numbers underneath the fantasy points.
//
// Every other screen reports points. This one reports why: opportunity, which
// predicts next week, and efficiency, which regresses. Keeping those two
// visually separate is most of the job, because conflating them is how a
// manager pays a premium for three weeks of touchdown luck.

import {
    METRICS, buildProfiles, compareProfiles, formatMetric, leaderboard,
    metricsFor, movers,
} from '../advanced.js';
import { loadWeekContext } from '../data.js';
import { openSyncModal } from '../app.js';
import {
    banner, el, emptyState, pickPlayer, playerCell, playerLink, posBadge, round,
    sortBy, spinnerRow, tag, tile,
} from '../ui.js';

const POSITIONS = ['RB', 'WR', 'TE', 'QB'];

/** The leaderboards worth opening on, per position, with their volume floors. */
const FEATURED = {
    RB: [
        { key: 'snapShare', minimum: 6, minimumKey: 'touchesPerGame' },
        { key: 'carryShare', minimum: 6, minimumKey: 'touchesPerGame' },
        { key: 'redZoneShare', minimum: 6, minimumKey: 'touchesPerGame' },
        { key: 'yardsAfterContact', minimum: 8, minimumKey: 'touchesPerGame' },
    ],
    WR: [
        { key: 'targetShare', minimum: 3, minimumKey: 'targetsPerGame' },
        { key: 'airYardsShare', minimum: 3, minimumKey: 'targetsPerGame' },
        { key: 'redZoneShare', minimum: 3, minimumKey: 'targetsPerGame' },
        { key: 'yardsPerTarget', minimum: 4, minimumKey: 'targetsPerGame' },
    ],
    TE: [
        { key: 'targetShare', minimum: 2, minimumKey: 'targetsPerGame' },
        { key: 'snapShare', minimum: 2, minimumKey: 'targetsPerGame' },
        { key: 'redZoneShare', minimum: 2, minimumKey: 'targetsPerGame' },
        { key: 'yardsPerTarget', minimum: 3, minimumKey: 'targetsPerGame' },
    ],
    QB: [
        { key: 'airYardsPerAttempt', minimum: 0 },
        { key: 'yardsPerAttempt', minimum: 0 },
        { key: 'completionPct', minimum: 0 },
        { key: 'passerRating', minimum: 0 },
    ],
};

export default function renderStats(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Stats'),
            el(
                'p',
                { class: 'sub' },
                'Opportunity and efficiency, kept apart on purpose. Snap share, target share and red-zone work ',
                'are decided by coaches and predict next week. Yards per target and yards after contact are ',
                'noisy and regress. A player whose opportunity is climbing is going up in value; one whose points ',
                'are held up by efficiency is going down, usually before anybody notices.'
            )
        )
    );

    if (!app.league) {
        root.append(
            emptyState(
                '📊',
                'Connect a league',
                'Scoring decides what these numbers are worth, and share metrics need the weekly stat feed for ' +
                    'your season. Both come from a synced league.',
                el('button', { class: 'btn btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        return root;
    }

    const host = el('div', {});
    root.append(host);
    host.append(el('div', { class: 'card' }, spinnerRow('Reading every weekly stat line this season…')));

    build(app)
        .then((node) => host.replaceChildren(node))
        .catch((err) => {
            console.error(err);
            host.replaceChildren(banner(err.message || 'Could not read the stats.', 'bad'));
        });

    return root;
}

async function build(app) {
    const { cfg, currentWeek, lastPlayed, raw } = app.league;
    const ctx = await loadWeekContext(raw.season, currentWeek, lastPlayed);
    const weeklyStats = ctx?.weeklyStats;

    if (!weeklyStats?.size) {
        return el(
            'div',
            { class: 'card' },
            el('p', { class: 'muted' },
                'No completed weeks yet this season, so there is nothing to measure. These numbers need games ' +
                'played — they describe what has happened, not what is projected.')
        );
    }

    // Everyone with a game, not just rostered players: half the value of this
    // page is looking up somebody you are thinking about acquiring.
    const pool = Object.values(app.players).filter(
        (p) => POSITIONS.includes(p.pos) && (app.rankings.get(p.id) ?? 999) < 900
    );

    const profiles = buildProfiles({
        weeklyStats,
        players: pool,
        scoring: cfg.scoring,
        minGames: 2,
        // Two games is a short window but it is the one managers act on, and
        // with four weeks played a three-game window leaves one game of
        // baseline, which is not a baseline.
        window: Math.max(2, Math.min(3, Math.floor((lastPlayed || 1) / 2))),
    });

    const byId = new Map(profiles.map((p) => [p.player.id, p]));
    const wrap = el('div', {});

    const rising = movers(profiles, { direction: 'up', limit: 8 });
    const falling = movers(profiles, { direction: 'down', limit: 8 });

    wrap.append(
        el(
            'div',
            { class: 'tiles' },
            tile('Players measured', profiles.length, `through week ${lastPlayed || currentWeek - 1}`),
            tile('Rising', rising.length, 'role growing — buy before the box score catches up', rising.length ? 'good' : ''),
            tile('Falling', falling.length, 'role shrinking — sell before the points follow', falling.length ? 'warn' : ''),
            tile('Weeks of data', weeklyStats.size, 'completed games read per player')
        )
    );

    // --- What the numbers are, and are not ---------------------------------
    //
    // Said up front because "next gen stats" means something specific and this
    // is not quite it. Claiming otherwise would be the easiest and worst lie
    // this page could tell.
    wrap.append(
        el(
            'details',
            { class: 'card' },
            el('summary', { style: 'cursor:pointer;font-weight:650' }, 'Where these numbers come from'),
            el(
                'p',
                { class: 'small muted', style: 'margin:10px 0 0' },
                'Sleeper’s weekly stat feed, which carries considerably more than a box score: offensive snaps ',
                'against team snaps, air yards, yards after contact, broken tackles, red-zone targets and ',
                'carries, drops and first downs. Shares are computed against the team’s own weekly totals, so ',
                'a receiver’s eight targets is read against what his offence actually threw.'
            ),
            el(
                'p',
                { class: 'small muted', style: 'margin:8px 0 0' },
                'The NFL’s own Next Gen Stats feed is ',
                el('strong', {}, 'not'),
                ' used here: it requires authentication, so there is no honest way to serve it from a page with ',
                'no server. That means the tracking-derived metrics — separation, time to throw, rush yards over ',
                'expected — are genuinely absent rather than approximated. What is here covers opportunity, ',
                'efficiency and leverage, which is most of what decides a fantasy call.'
            )
        )
    );

    // --- Rising and falling -------------------------------------------------
    if (rising.length || falling.length) {
        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, 'Going up and going down'),
                el('span', { class: 'hint' }, 'ranked on opportunity, not points — a role is a fact, efficiency is weather')
            )
        );
        wrap.append(
            el(
                'div',
                { class: 'grid grid-2' },
                moverCard('Rising', rising, 'good'),
                moverCard('Falling', falling, 'bad')
            )
        );
    }

    // --- Comparison ---------------------------------------------------------
    wrap.append(
        el(
            'div',
            { class: 'section-head' },
            el('h2', {}, 'Compare'),
            el('span', { class: 'hint' }, 'two to four players, side by side on the stats that matter')
        )
    );
    wrap.append(compareCard(app, profiles, byId));

    // --- Leaderboards -------------------------------------------------------
    wrap.append(
        el(
            'div',
            { class: 'section-head' },
            el('h2', {}, 'Leaderboards'),
            el('span', { class: 'hint' }, 'volume floors applied — two catches for forty yards leads nothing')
        )
    );
    wrap.append(leaderboardCard(profiles));

    return wrap;
}

/** One side of the rising/falling pair. */
function moverCard(title, rows, tone) {
    const card = el('div', { class: 'card' });
    card.append(el('h3', { style: 'margin:0 0 4px' }, title));

    if (!rows.length) {
        card.append(el('p', { class: 'muted small' }, 'Nobody has moved enough to be worth flagging yet.'));
        return card;
    }

    for (const { profile } of rows) {
        const t = profile.trend;
        // The two biggest OPPORTUNITY moves, named concretely. A composite
        // drift percentage is not something a manager can check against what
        // they already believe; "target share 14% to 26%" is.
        const opp = t.moves.filter((m) => m.metric.kind === 'opportunity').slice(0, 2);
        card.append(
            el(
                'div',
                { class: 'mover' },
                el(
                    'div',
                    { class: 'row', style: 'gap:8px;align-items:center;min-width:0' },
                    posBadge(profile.player.pos),
                    el('span', { class: 'grow ellipsis', style: 'min-width:0;font-weight:600' }, playerLink(profile.player)),
                    tag(round(profile.pointsPerGame, 1), '')
                ),
                ...opp.map((m) =>
                    el(
                        'div',
                        { class: 'tiny', style: 'margin-top:2px' },
                        el('span', { class: 'dim' }, `${m.metric.label}: `),
                        el('span', { class: m.improved ? 'good' : 'bad' },
                            `${formatMetric(m.metric.key, m.before)} → ${formatMetric(m.metric.key, m.after)}`)
                    )
                ),
                el('p', { class: `tiny ${tone === 'good' ? '' : 'warn'}`, style: 'margin:4px 0 0' }, t.verdict.text)
            )
        );
    }
    return card;
}

/** Two to four players, side by side. */
function compareCard(app, profiles, byId) {
    const host = el('div', { class: 'card' });

    // Open on the two biggest risers, which is a useful default rather than
    // two empty pickers.
    const opening = movers(profiles, { direction: 'up', limit: 2 }).map((m) => m.profile);
    let field = opening.length === 2 ? opening : sortBy(profiles, (p) => p.pointsPerGame, -1).slice(0, 2);

    if (field.length < 2) {
        host.append(el('p', { class: 'muted' }, 'Not enough players with two games played to compare yet.'));
        return host;
    }

    const pick = async (index) => {
        const taken = new Set(field.map((p) => p.player.id));
        const chosen = await pickPlayer({
            title: index < field.length ? 'Swap this player' : 'Add a player',
            entries: sortBy(
                profiles
                    .filter((p) => !taken.has(p.player.id))
                    .map((p) => ({ player: p.player, posRank: app.rankings.get(p.player.id), value: p.pointsPerGame })),
                (e) => e.value,
                -1
            ),
            emptyText: 'Nobody else has enough games played.',
            formatValue: (v) => round(v, 1),
        });
        if (!chosen) return;
        const profile = byId.get(chosen.player.id);
        if (!profile) return;
        if (index < field.length) field[index] = profile;
        else field.push(profile);
        paint();
    };

    function paint() {
        const cmp = compareProfiles(field);
        host.replaceChildren(
            el(
                'div',
                { class: 'table-scroll' },
                el(
                    'table',
                    { class: 'table stat-compare' },
                    el(
                        'thead',
                        {},
                        el(
                            'tr',
                            {},
                            el('th', {}, ''),
                            ...field.map((p, i) =>
                                el(
                                    'th',
                                    { class: 'right' },
                                    el(
                                        'div',
                                        { class: 'row', style: 'gap:4px;justify-content:flex-end' },
                                        el(
                                            'button',
                                            { class: 'btn btn-sm', style: 'padding:2px 6px', onclick: () => pick(i) },
                                            p.player.name.split(' ').slice(-1)[0],
                                            el('span', { class: 'tiny dim' }, ' ▾')
                                        ),
                                        field.length > 2
                                            ? el('button', {
                                                  class: 'x',
                                                  title: `Remove ${p.player.name}`,
                                                  onclick: () => { field.splice(i, 1); paint(); },
                                              }, '✕')
                                            : null
                                    ),
                                    el('div', { class: 'tiny dim' }, `${p.player.pos} · ${p.games}g`)
                                )
                            )
                        )
                    ),
                    el(
                        'tbody',
                        {},
                        ...cmp.rows.map((r) =>
                            el(
                                'tr',
                                { class: r.metric.kind === 'opportunity' ? 'stat-opp' : '' },
                                el(
                                    'td',
                                    { title: r.metric.note || '' },
                                    r.metric.label,
                                    el('span', { class: `tiny ${r.metric.kind === 'opportunity' ? 'good' : 'dim'}`, style: 'margin-left:6px' },
                                        r.metric.kind === 'opportunity' ? 'opp' : r.metric.kind === 'scoring' ? '' : 'eff')
                                ),
                                ...r.values.map((v) =>
                                    el(
                                        'td',
                                        { class: `num right ${r.leader && v.profile === r.leader ? 'good' : ''}` },
                                        formatMetric(r.metric.key, v.value)
                                    )
                                )
                            )
                        )
                    )
                )
            ),
            el(
                'div',
                { class: 'row', style: 'margin-top:12px;gap:8px;flex-wrap:wrap' },
                field.length < 4
                    ? el('button', { class: 'btn btn-sm', onclick: () => pick(field.length) }, '+ Add a player')
                    : el('span', { class: 'tiny dim' }, 'Four is the most this compares at once.'),
                el('span', { class: 'grow' }),
                el('span', { class: 'tiny dim' }, 'green marks the better number · ‘opp’ predicts, ‘eff’ regresses')
            )
        );
    }

    paint();
    return host;
}

/** Leaderboards, one position at a time. */
function leaderboardCard(profiles) {
    const host = el('div', {});
    let pos = 'RB';

    const bar = el(
        'div',
        { class: 'card card-tight' },
        el(
            'div',
            { class: 'row' },
            el('span', { class: 'tiny dim' }, 'POSITION'),
            el(
                'div',
                { class: 'seg' },
                ...POSITIONS.map((p) =>
                    el(
                        'button',
                        {
                            'data-pos': p,
                            'aria-pressed': String(pos === p),
                            onclick: () => {
                                if (pos === p) return;
                                pos = p;
                                paint();
                            },
                        },
                        p
                    )
                )
            )
        )
    );

    const body = el('div', {});
    host.append(bar, body);

    function paint() {
        // Repainted so the segmented control shows the current position.
        for (const b of bar.querySelectorAll('button')) {
            b.setAttribute('aria-pressed', String(b.dataset.pos === pos));
        }

        const boards = (FEATURED[pos] || []).map(({ key, minimum, minimumKey }) => {
            const metric = METRICS.find((m) => m.key === key);
            const rows = leaderboard(profiles, key, {
                pos,
                minimum,
                minimumKey: minimumKey || 'touchesPerGame',
                limit: 10,
            });
            return { metric, rows, minimum, minimumKey };
        });

        body.replaceChildren(
            el(
                'div',
                { class: 'grid grid-2' },
                ...boards.map(({ metric, rows }) =>
                    el(
                        'div',
                        { class: 'card' },
                        el(
                            'div',
                            { class: 'row', style: 'justify-content:space-between;align-items:baseline;gap:8px' },
                            el('h3', { style: 'margin:0' }, metric.label),
                            el('span', { class: `tiny ${metric.kind === 'opportunity' ? 'good' : 'dim'}` },
                                metric.kind === 'opportunity' ? 'predicts' : 'regresses')
                        ),
                        metric.note ? el('p', { class: 'tiny dim', style: 'margin:4px 0 8px' }, metric.note) : null,
                        rows.length
                            ? el(
                                  'div',
                                  {},
                                  ...rows.map((p, i) =>
                                      el(
                                          'div',
                                          { class: 'row', style: 'gap:8px;padding:3px 0;min-width:0' },
                                          el('span', { class: 'tiny dim', style: 'min-width:18px' }, `${i + 1}.`),
                                          el('span', { class: 'small ellipsis grow', style: 'min-width:0' }, playerLink(p.player)),
                                          el('span', { class: 'num small', style: 'min-width:52px;text-align:right' },
                                              formatMetric(metric.key, p[metric.key]))
                                      )
                                  )
                              )
                            : el('p', { class: 'muted small' }, 'Nobody clears the volume floor for this yet.')
                    )
                )
            ),
            // Everything else for this position, for anyone who wants the table
            // rather than the highlights.
            allMetricsTable(profiles, pos)
        );
    }

    paint();
    return host;
}

/** The full table for one position: every metric, every qualifying player. */
function allMetricsTable(profiles, pos) {
    const metrics = metricsFor(pos);
    const rows = sortBy(
        profiles.filter((p) => p.player.pos === pos),
        (p) => p.pointsPerGame,
        -1
    ).slice(0, 40);

    if (!rows.length) return el('div', {});

    return el(
        'div',
        { class: 'card' },
        el('h3', { style: 'margin:0 0 8px' }, `Every ${pos} metric`),
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
                        el('th', { class: 'right' }, 'G'),
                        ...metrics.map((m) =>
                            el('th', { class: `right ${m.kind === 'opportunity' ? 'stat-opp-head' : ''}`, title: `${m.label}${m.note ? ` — ${m.note}` : ''}` }, m.short)
                        )
                    )
                ),
                el(
                    'tbody',
                    {},
                    ...rows.map((p) =>
                        el(
                            'tr',
                            {},
                            el('td', {}, playerCell(p.player, { showTeam: true })),
                            el('td', { class: 'num right dim' }, String(p.games)),
                            ...metrics.map((m) =>
                                el('td', { class: 'num right' }, formatMetric(m.key, p[m.key]))
                            )
                        )
                    )
                )
            )
        ),
        el(
            'p',
            { class: 'tiny dim', style: 'margin:8px 0 0' },
            'Columns tinted green are opportunity metrics: largely coach-decided, stable week to week, and the ',
            'ones that predict. The rest are efficiency, which is noisier and regresses — a month of good ones ',
            'is not a reason to pay up.'
        )
    );
}
