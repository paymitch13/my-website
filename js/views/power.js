// Payton Mitchell Power Rankings.

import { computePowerRankings, applyMovement, toSnapshot, toShareText, WEIGHT_PRESETS } from '../power.js';
import * as store from '../store.js';
import { openSyncModal } from '../app.js';
import {
    banner, componentBar, copyToClipboard, el, emptyState, fmtPct, playerCell,
    posBadge, round, sortBy, spinnerRow, tag, tile,
} from '../ui.js';

const LABELS = {
    roster: 'roster strength',
    allPlay: 'all-play record',
    title: 'simulated title odds',
    form: 'recent form',
    depth: 'injury resilience',
};

export default function renderPower(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Payton Mitchell Power Rankings'),
            el(
                'p',
                { class: 'sub' },
                'Records lie. This blends roster strength from your rankings with an all-play record that strips out ',
                'schedule luck, recent form, injury exposure, and simulated title odds.'
            )
        )
    );

    if (!app.league) {
        root.append(
            emptyState(
                '🏆',
                'Connect a league first',
                'Power rankings need real rosters, records and a schedule. Sync a Sleeper league and this fills in immediately.',
                el('button', { class: 'btn btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        return root;
    }

    let preset = store.state.settings.powerPreset || 'balanced';

    const presetSeg = el(
        'div',
        { class: 'seg' },
        ...Object.entries(WEIGHT_PRESETS).map(([key, cfg]) =>
            el(
                'button',
                {
                    type: 'button',
                    'aria-pressed': String(key === preset),
                    class: key === preset ? 'accent' : '',
                    title: cfg.blurb,
                    disabled: false,
                    onclick: () => {
                        preset = key;
                        store.state.settings.powerPreset = key;
                        store.save();
                        for (const b of presetSeg.children) {
                            const on = b.textContent === WEIGHT_PRESETS[key].label;
                            b.setAttribute('aria-pressed', String(on));
                            b.className = on ? 'accent' : '';
                        }
                        render();
                    },
                },
                cfg.label
            )
        )
    );

    const blurbLine = el('span', { class: 'hint' });
    root.append(
        el(
            'div',
            { class: 'card card-tight' },
            el('div', { class: 'row' }, el('span', { class: 'tiny dim' }, 'WEIGHTING'), presetSeg, blurbLine)
        )
    );

    const host = el('div', {});
    root.append(host);

    function render() {
        blurbLine.textContent = WEIGHT_PRESETS[preset].blurb;
        host.replaceChildren(el('div', { class: 'card' }, spinnerRow('Simulating the rest of the season…')));
        setTimeout(async () => {
            try {
                host.replaceChildren(await build(app, preset));
            } catch (err) {
                console.error(err);
                host.replaceChildren(emptyState('⚠️', 'Could not build the rankings', err.message));
            }
        }, 30);
    }

    render();
    return root;
}

async function build(app, preset = 'balanced') {
    const { league } = app;
    const week = league.currentWeek;

    let ranked = await computePowerRankings({
        cfg: league.cfg,
        ctx: app.ctx,
        teams: league.teams,
        rankings: app.rankings,
        weeklyScores: league.weeklyScores,
        schedule: league.schedule,
        iterations: store.state.settings.simIterations || 2000,
        week,
        preset,
    });

    // The finder uses these to decide who is buying and who is selling.
    app.powerOdds = new Map(ranked.map((r) => [r.rosterId, r.playoffOdds]));
    const presetLive = ranked.length ? ranked[0].presetApplied !== false : true;
    const prev = store.previousSnapshot(league.cfg.id, week, preset);
    ranked = applyMovement(ranked, prev);
    store.saveSnapshot(league.cfg.id, week, toSnapshot(ranked), preset);

    const wrap = el('div', {});

    if (!presetLive) {
        wrap.append(
            banner(
                'No games have been played yet, so there is no performance signal to weight — every preset ranks on roster strength alone right now. The selector starts mattering in week 1.',
                'warn'
            )
        );
    }

    // Summary tiles
    const best = ranked[0];
    const unluckiest = sortBy(ranked, (r) => r.luck)[0];
    const luckiest = sortBy(ranked, (r) => r.luck, -1)[0];
    const favorite = sortBy(ranked, (r) => r.titleOdds ?? 0, -1)[0];

    wrap.append(
        el(
            'div',
            { class: 'tiles' },
            tile('Top of the board', best.team.name, `${best.team.wins}-${best.team.losses} · rating ${best.rating}`),
            favorite.titleOdds !== null
                ? tile('Title favorite', favorite.team.name, `${fmtPct(favorite.titleOdds, 1)} to win it all`)
                : null,
            unluckiest.games
                ? tile('Most unlucky', unluckiest.team.name, `${round(unluckiest.luck, 1)} wins vs. all-play expectation`, 'bad')
                : null,
            luckiest.games
                ? tile('Living right', luckiest.team.name, `+${round(luckiest.luck, 1)} wins above expectation`, 'good')
                : null
        )
    );

    // Header + share
    wrap.append(
        el(
            'div',
            { class: 'section-head' },
            el('h2', {}, `Week ${week}`),
            el(
                'span',
                { class: 'hint grow' },
                prev
                    ? `movement vs. week ${prev.week}${week - prev.week > 1 ? ` (${week - prev.week} weeks ago — the last time you opened this view)` : ''}`
                    : 'first snapshot for this weighting — movement starts once there is a week to compare against'
            ),
            el(
                'button',
                {
                    class: 'btn btn-sm',
                    onclick: () => copyToClipboard(toShareText(ranked, league.cfg.name, week), 'Power rankings copied — paste them in the league chat.'),
                },
                'Copy for league chat'
            )
        )
    );

    // Rows
    let tier = -1;
    for (const r of ranked) {
        if (r.tier !== tier) {
            tier = r.tier;
            wrap.append(el('div', { class: 'tier-break' }, r.tierName));
        }
        wrap.append(row(app, r, ranked.length));
    }

    wrap.append(
        el(
            'p',
            { class: 'tiny dim', style: 'margin-top:20px' },
            'Rating is a 0-100 scale built from a weighted z-score: 40% roster strength, 20% all-play record, ',
            '20% simulated title odds, 10% recent form, 10% injury resilience. Before week 1 it is almost entirely roster strength.'
        )
    );

    return wrap;
}

function row(app, r, total) {
    const move =
        r.movement > 0
            ? el('span', { class: 'pr-move good' }, `▲${r.movement}`)
            : r.movement < 0
              ? el('span', { class: 'pr-move bad' }, `▼${Math.abs(r.movement)}`)
              : el('span', { class: 'pr-move dim' }, '—');

    const record = `${r.team.wins}-${r.team.losses}${r.team.ties ? `-${r.team.ties}` : ''}`;

    const node = el(
        'div',
        { class: 'pr-row' },
        el('div', { class: 'pr-rank' }, el('span', { class: 'n' }, r.rank), move),
        el(
            'div',
            { style: 'min-width:0' },
            el(
                'div',
                { class: 'row', style: 'gap:8px' },
                el('span', { class: 'pr-name' }, r.team.name),
                el('span', { class: 'small dim' }, record),
                r.playoffOdds !== null ? tag(`${fmtPct(r.playoffOdds)} playoffs`, r.playoffOdds > 0.6 ? 'good' : r.playoffOdds < 0.15 ? 'bad' : '') : null,
                r.titleOdds > 0.15 ? tag(`${fmtPct(r.titleOdds, 1)} title`, 'accent') : null
            ),
            el('div', { class: 'pr-blurb' }, r.blurb)
        ),
        el(
            'div',
            { class: 'bars' },
            componentBar('Roster', r.components.roster),
            componentBar('All-play', r.components.allPlay),
            componentBar('Odds', r.components.title),
            componentBar('Form', r.components.form),
            componentBar('Depth', r.components.depth)
        ),
        el(
            'div',
            {},
            el('div', { class: 'pr-rating' }, r.rating),
            el('div', { class: 'tiny dim right' }, `${round(r.mu, 1)} pts/wk`)
        )
    );

    node.style.cursor = 'pointer';
    node.addEventListener('click', () => showDetail(app, r));
    return node;
}

function showDetail(app, r) {
    const starters = r.lineup.starters.map((s) =>
        el(
            'tr',
            {},
            el('td', { class: 'tiny dim' }, s.label),
            el('td', {}, playerCell(s.entry.player, { rank: s.entry.posRank })),
            el('td', { class: 'num right small' }, round(s.entry.score, 1))
        )
    );

    const positions = Object.entries(r.report.byPosition).map(([pos, v]) =>
        el(
            'tr',
            {},
            el('td', {}, posBadge(pos)),
            el('td', { class: 'num right small' }, round(v.startingPoints, 1)),
            el('td', { class: 'num right small' }, v.count),
            el('td', { class: 'num right small', title: 'Points per week lost if the top player at this position went down' }, round(v.dropoff, 1))
        )
    );

    import('../ui.js').then(({ modal }) => {
        modal({
            title: `${r.team.name} — #${r.rank}`,
            width: '680px',
            body: el(
                'div',
                {},
                el('p', { class: 'muted' }, r.blurb),
                el(
                    'div',
                    { class: 'tiles', style: 'margin-bottom:18px' },
                    tile('Rating', r.rating, `${r.tierName}`),
                    tile('Lineup', round(r.mu, 1), 'projected pts/week'),
                    r.games ? tile('All-play', fmtPct(r.allPlayWinPct), `${round(r.expectedWins, 1)} expected wins`) : null,
                    r.playoffOdds !== null ? tile('Playoffs', fmtPct(r.playoffOdds), `${fmtPct(r.titleOdds, 1)} title`) : null
                ),
                el('h3', {}, 'Optimal lineup'),
                el('table', { class: 'table' }, el('tbody', {}, ...starters)),
                el('h3', { style: 'margin-top:20px' }, 'By position'),
                el(
                    'table',
                    { class: 'table' },
                    el('thead', {}, el('tr', {}, el('th', {}, 'Pos'), el('th', { class: 'right' }, 'Starting'), el('th', { class: 'right' }, 'Rostered'), el('th', { class: 'right' }, 'Injury cost'))),
                    el('tbody', {}, ...positions)
                )
            ),
        });
    });
}
