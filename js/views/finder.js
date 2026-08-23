// Trade Finder — the whole league searched for deals worth sending.

import { findTrades, acceptanceNote } from '../finder.js';
import { scanUsage, describeBuyLow, describeSellHigh } from '../usage.js';
import { buildNeutralEntries } from '../trade.js';
import { loadWeekContext } from '../data.js';
import { byeConflicts } from '../schedule.js';
import { openSyncModal } from '../app.js';
import * as store from '../store.js';
import { formatValue } from '../tradevalue.js';
import { encodeOffer, offerUrl } from '../share.js';
import {
    banner, el, emptyState, fmtDelta, fmtPct, fmtPctDelta, playerLink, posBadge,
    round, sortBy, spinnerRow, tag, tile, toast,
} from '../ui.js';

export default function renderFinder(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Trade Finder'),
            el(
                'p',
                { class: 'sub' },
                'Searches every roster in the league for deals that improve both teams. Your side is valued on ',
                'your rankings; the other side is valued on a neutral board, because they do not share your ',
                'opinions — which is what makes the difference between a deal you like and one they accept.'
            )
        )
    );

    if (!app.league) {
        root.append(
            emptyState(
                '🔎',
                'Connect a league first',
                'The finder needs every roster in your league to search against.',
                el('button', { class: 'btn btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        return root;
    }

    const teams = sortBy(app.league.teams, (t) => t.name.toLowerCase());
    let mine = teams.find((t) => t.ownerId && t.ownerId === app.userId) || teams[0];

    let requireMutual = store.state.settings.finderMutualOnly !== false;

    const host = el('div', {});
    const picker = el(
        'select',
        {
            style: 'max-width:min(340px,100%)',
            onchange: (e) => {
                mine = teams.find((t) => String(t.rosterId) === e.target.value);
                run();
            },
        },
        ...teams.map((t) => el('option', { value: String(t.rosterId), selected: t.rosterId === mine.rosterId }, t.name))
    );

    root.append(
        el(
            'div',
            { class: 'card card-tight' },
            el(
                'div',
                { class: 'row' },
                el('span', { class: 'tiny dim' }, 'MY ROSTER'),
                picker,
                el('div', { class: 'grow' }),
                el(
                    'button',
                    {
                        class: 'btn btn-sm btn-toggle',
                        'aria-pressed': String(requireMutual),
                        title: 'Only show deals that improve both lineups. Turn off to include lopsided offers.',
                        onclick: (e) => {
                            requireMutual = !requireMutual;
                            store.state.settings.finderMutualOnly = requireMutual;
                            store.save();
                            e.currentTarget.setAttribute('aria-pressed', String(requireMutual));
                            run();
                        },
                    },
                    'Balanced only'
                ),
                el('button', { class: 'btn btn-sm', onclick: () => run() }, 'Search again')
            )
        ),
        host
    );

    let token = 0;
    async function run() {
        const mineNow = ++token;
        const target = mine;
        host.replaceChildren(el('div', { class: 'card' }, spinnerRow('Searching every roster — needs, lineups, then full simulations…')));
        try {
            const built = await build(app, target, requireMutual);
            if (mineNow !== token) return;
            host.replaceChildren(built);
        } catch (err) {
            if (mineNow !== token) return;
            console.error(err);
            host.replaceChildren(emptyState('⚠️', 'Search failed', err.message));
        }
    }

    run();
    return root;
}

async function build(app, me, requireMutual = true) {
    const { cfg, currentWeek, lastPlayed, raw, teams, schedule } = app.league;

    const wrap = el('div', {});

    // Playoff odds give each counterparty a buying or selling posture.
    const playoffOdds = app.powerOdds || null;

    const res = await findTrades({
        cfg,
        ctx: app.ctx,
        teams,
        myRosterId: me.rosterId,
        rankings: app.rankings,
        schedule,
        playoffOdds,
        iterations: Math.min(store.state.settings.simIterations || 2000, 1200),
        requireMutualGain: requireMutual,
    });

    if (!res.ok) {
        wrap.append(banner(res.error, 'bad'));
        return wrap;
    }

    wrap.append(
        el(
            'div',
            { class: 'tiles' },
            tile('Pairings considered', res.scanned ?? 0, 'after the need/surplus filter'),
            tile('Trades found', res.shortlisted ?? 0, requireMutual ? 'both lineups improve' : 'your lineup improves'),
            tile('Simulated in full', res.trades.length, 'ranked by your title odds')
        )
    );

    // --- Best available trades ---------------------------------------------
    wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Best available trades'),
        el('span', { class: 'hint' }, 'their side shown on neutral values')));

    if (!res.trades.length) {
        wrap.append(
            el(
                'div',
                { class: 'card' },
                el('p', { class: 'muted' },
                    'No deal in this league improves both rosters right now. That usually means your team is ',
                    'shaped like everyone else’s — the finder only proposes trades the other manager has a ',
                    'reason to accept.')
            )
        );
    } else {
        for (const t of res.trades) wrap.append(tradeCard(app, me, t));
    }

    if (res.others?.length) {
        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, 'Also possible'),
                el('span', { class: 'hint' }, 'lineup numbers only — not run through the season simulation')
            )
        );
        const card = el('div', { class: 'card' });
        for (const t of res.others) card.append(otherRow(app, me, t));
        wrap.append(card);
    }

    // --- Buy low / sell high ------------------------------------------------
    if (lastPlayed >= 4) {
        const { weeklyStats } = await loadWeekContext(raw.season, currentWeek, lastPlayed);
        const rostered = new Map();
        for (const t of teams) for (const p of t.players) rostered.set(p.id, t);

        const others = teams.filter((t) => t.rosterId !== me.rosterId).flatMap((t) => t.players);
        const buyRows = scanUsage({ weeklyStats, players: others, scoring: cfg.scoring })
            .filter((r) => r.buyLow !== null && r.buyLow > 1.5);
        const sellRows = scanUsage({ weeklyStats, players: me.players, scoring: cfg.scoring })
            .filter((r) => r.sellHigh !== null && r.sellHigh > 1.5);

        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Buy low'),
            el('span', { class: 'hint' }, 'role growing faster than the box score')));
        wrap.append(usageCard(sortBy(buyRows, (r) => r.buyLow, -1).slice(0, 6), rostered, describeBuyLow, 'good',
            'Nobody on another roster is showing a clear usage-up, points-down profile yet.'));

        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Sell high'),
            el('span', { class: 'hint' }, 'your players carried by touchdowns')));
        wrap.append(usageCard(sortBy(sellRows, (r) => r.sellHigh, -1).slice(0, 6), rostered, describeSellHigh, 'warn',
            'None of your players are unusually touchdown-dependent right now.'));
    } else {
        wrap.append(
            banner('Buy-low and sell-high signals need at least four completed weeks of usage data. They appear once the season is under way.', 'warn')
        );
    }

    // --- Bye trouble --------------------------------------------------------
    const conflicts = byeConflicts(me.players, app.byeWeeks, { fromWeek: currentWeek, minPlayers: 3 });
    if (conflicts.length) {
        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Bye week trouble')));
        wrap.append(
            el(
                'div',
                { class: 'card' },
                ...conflicts.slice(0, 3).map((c) =>
                    el(
                        'div',
                        { class: 'reason k-warn' },
                        el(
                            'div',
                            {},
                            el('div', { class: 'r-title' }, `Week ${c.week}: ${c.players.length} of your players are on bye`),
                            el('div', { class: 'r-detail' }, c.players.map((p) => p.name).join(', '))
                        )
                    )
                )
            )
        );
    }

    return wrap;
}

function tradeCard(app, me, t) {
    const theirName = t.other.name;
    const accept = acceptanceNote(t, theirName);

    return el(
        'div',
        { class: 'card finder-card' },
        el(
            'div',
            { class: 'finder-head' },
            el(
                'div',
                { class: 'finder-legs' },
                el(
                    'div',
                    { class: 'finder-leg' },
                    el('div', { class: 'tiny good' }, 'YOU GET'),
                    el('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap;min-width:0' },
                        posBadge(t.get.player.pos), el('span', { class: 'ellipsis' }, playerLink(t.get.player)))
                ),
                el('div', { class: 'finder-arrow' }, '⇄'),
                el(
                    'div',
                    { class: 'finder-leg' },
                    el('div', { class: 'tiny bad' }, 'YOU SEND'),
                    el('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap;min-width:0' },
                        posBadge(t.give.player.pos), el('span', { class: 'ellipsis' }, playerLink(t.give.player)))
                )
            ),
            el(
                'div',
                { class: 'finder-partner' },
                el('div', { class: 'small', style: 'font-weight:600' }, theirName),
                t.posture ? tag(t.posture.label, t.posture.kind === 'seller' ? 'good' : t.posture.kind === 'buyer' ? 'warn' : '') : null
            )
        ),
        el(
            'div',
            { class: 'finder-numbers' },
            el('div', { class: 'fn' },
                el('div', { class: 'k' }, 'Your lineup'),
                el('div', { class: 'v good num' }, `${fmtDelta(t.myGain)} pts/wk`)),
            t.myPlayoffDelta !== null
                ? el('div', { class: 'fn' },
                    el('div', { class: 'k' }, 'Your playoff odds'),
                    el('div', { class: `v num ${t.myPlayoffDelta >= 0 ? 'good' : 'bad'}` }, fmtPctDelta(t.myPlayoffDelta)))
                : null,
            t.myTitleDelta !== null
                ? el('div', { class: 'fn' },
                    el('div', { class: 'k' }, 'Your title odds'),
                    el('div', { class: `v num ${t.myTitleDelta >= 0 ? 'good' : 'bad'}` }, fmtPctDelta(t.myTitleDelta)))
                : null,
            el('div', { class: 'fn' },
                el('div', { class: 'k' }, 'Their lineup'),
                el('div', { class: 'v num' }, `${fmtDelta(t.theirGain)} pts/wk`))
        ),
        el('p', { class: 'small muted', style: 'margin:10px 0 0' }, 'Why they say yes: ', accept),
        el(
            'div',
            { class: 'row', style: 'margin-top:12px;gap:8px' },
            el('button', {
                class: 'btn btn-sm btn-primary',
                onclick: () => openInCalculator(me, t),
            }, 'Open in calculator'),
            el('button', {
                class: 'btn btn-sm',
                onclick: () => {
                    const url = offerUrl({
                        aRoster: me.rosterId, aSend: [t.give.player.id],
                        bRoster: t.other.rosterId, bSend: [t.get.player.id],
                    });
                    navigator.clipboard?.writeText(url).then(
                        () => toast('Trade link copied — paste it in your league chat', 'good'),
                        () => toast(url, '')
                    );
                },
            }, 'Copy link')
        )
    );
}

function openInCalculator(me, t) {
    location.hash = encodeOffer({
        aRoster: me.rosterId, aSend: [t.give.player.id],
        bRoster: t.other.rosterId, bSend: [t.get.player.id],
    });
}

/** A candidate that did not get the full simulation, or that the sim rejected. */
function otherRow(app, me, t) {
    return el(
        'div',
        { class: 'suggest' },
        el(
            'div',
            { class: 'suggest-main' },
            el(
                'div',
                { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
                el('span', { class: 'tiny good' }, 'GET'),
                posBadge(t.get.player.pos), playerLink(t.get.player),
                el('span', { class: 'dim' }, '·'),
                el('span', { class: 'tiny bad' }, 'SEND'),
                posBadge(t.give.player.pos), playerLink(t.give.player)
            ),
            el(
                'div',
                { class: 'suggest-why' },
                `${t.other.name} · you ${fmtDelta(t.myGain)} pts/wk, they ${fmtDelta(t.theirGain)} pts/wk`,
                t.reason === 'lowers-odds'
                    ? ' — the season simulation says this lowers your playoff or title odds despite the lineup gain.'
                    : ''
            )
        ),
        el(
            'div',
            { class: 'suggest-meta' },
            t.reason === 'lowers-odds' ? tag('odds down', 'warn') : tag('not simulated', ''),
            el(
                'button',
                {
                    class: 'btn btn-sm',
                    style: 'padding:2px 8px;font-size:12px',
                    onclick: () => openInCalculator(me, t),
                },
                'Open'
            )
        )
    );
}

function usageCard(rows, rostered, describe, tone, emptyText) {
    if (!rows.length) return el('div', { class: 'card' }, el('p', { class: 'muted' }, emptyText));
    return el(
        'div',
        { class: 'card' },
        ...rows.map((r) =>
            el(
                'div',
                { class: `reason k-${tone}` },
                el(
                    'div',
                    { style: 'min-width:0' },
                    el(
                        'div',
                        { class: 'row', style: 'gap:8px' },
                        posBadge(r.player.pos),
                        el('span', { style: 'font-weight:600' }, playerLink(r.player)),
                        el('span', { class: 'tiny dim' }, rostered.get(r.player.id)?.name || 'free agent')
                    ),
                    el('div', { class: 'r-detail' }, describe(r))
                )
            )
        )
    );
}
