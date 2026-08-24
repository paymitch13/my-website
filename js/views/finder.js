// Trade Finder — the whole league searched for deals worth sending.

import { findTrades, acceptanceNote } from '../finder.js';
import { scanUsage, indexWeeklyStats, describeBuyLow, describeSellHigh } from '../usage.js';
import { loadWeekContext } from '../data.js';
import { byeConflicts } from '../schedule.js';
import { openSyncModal } from '../app.js';
import * as store from '../store.js';
import { encodeOffer, offerUrl } from '../share.js';
import { valuePlayer } from '../valuation.js';
import { formatValue } from '../tradevalue.js';
import { marketEdge, describeEdge } from '../market.js';
import {
    banner, el, emptyState, fmtDelta, fmtPctDelta, pickPlayer, playerLink, posBadge,
    sortBy, spinnerRow, tag, tile, toast,
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

    // Named players. Empty means the open search: infer what I need from roster
    // shape. Naming somebody replaces the inference with a declaration, which
    // is a different and usually better-informed question.
    let want = [];
    let offer = [];

    const host = el('div', {});
    const chips = el('div', {});
    const picker = el(
        'select',
        {
            style: 'max-width:min(340px,100%)',
            onchange: (e) => {
                mine = teams.find((t) => String(t.rosterId) === e.target.value);
                // Named players belong to the roster they were named from.
                want = [];
                offer = [];
                paintChips();
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
                el('button', { class: 'btn btn-sm', onclick: () => run() }, 'Search again')
            ),
            el(
                'div',
                { class: 'row', style: 'margin-top:12px;gap:8px' },
                el('button', { class: 'btn btn-sm', onclick: addWant }, '＋ Target a player'),
                el('button', { class: 'btn btn-sm', onclick: addOffer }, '＋ Offer a player'),
                el('span', { class: 'tiny dim grow' },
                    'Name a player to ask what he would cost, or name your own to ask what he would fetch.')
            ),
            chips
        ),
        host
    );

    /** The named players, as removable chips, so the search is legible. */
    function paintChips() {
        chips.replaceChildren();
        if (!want.length && !offer.length) return;

        const row = (label, tone, list, drop) =>
            list.length
                ? el(
                      'div',
                      { class: 'row', style: 'gap:6px;margin-top:10px' },
                      el('span', { class: `tiny ${tone}`, style: 'min-width:64px' }, label),
                      ...list.map((p) =>
                          el(
                              'span',
                              { class: 'chip', style: 'padding:4px 8px' },
                              posBadge(p.pos),
                              el('span', {}, p.name),
                              el('button', {
                                  class: 'x',
                                  title: `Remove ${p.name}`,
                                  onclick: () => { drop(p.id); paintChips(); run(); },
                              }, '✕')
                          )
                      )
                  )
                : null;

        chips.append(
            row('I WANT', 'good', want, (id) => { want = want.filter((p) => p.id !== id); }),
            row('I’LL SEND', 'bad', offer, (id) => { offer = offer.filter((p) => p.id !== id); })
        );
    }

    async function addWant() {
        // Everyone in the league except my own roster: the point is to name
        // somebody I do not have.
        const mineIds = new Set(mine.players.map((p) => p.id));
        const entries = [];
        for (const t of teams) {
            if (t.rosterId === mine.rosterId) continue;
            for (const p of t.players) {
                if (mineIds.has(p.id)) continue;
                const posRank = app.rankings.get(p.id) ?? 999;
                entries.push({
                    player: p,
                    posRank,
                    subtitle: t.name,
                    value: valuePlayer(p, posRank, app.ctx).value,
                });
            }
        }
        const chosen = await pickPlayer({
            title: 'Who do you want?',
            entries: sortBy(entries.filter((e) => !want.some((w) => w.id === e.player.id)), (e) => e.value, -1),
            emptyText: 'Nobody else is rostered in this league.',
            formatValue: (v) => formatValue(app.tradeValue(v)),
        });
        if (!chosen) return;
        // One counterparty at a time: two targets on different rosters is a
        // three-team trade, and saying so after the search wastes a click.
        const owner = teams.find((t) => t.players.some((p) => p.id === chosen.player.id));
        if (want.length && owner && !want.every((w) => owner.players.some((p) => p.id === w.id))) {
            toast('Pick targets from one roster — two owners would be a three-team trade.', 'bad');
            return;
        }
        want.push(chosen.player);
        paintChips();
        run();
    }

    async function addOffer() {
        const taken = new Set(offer.map((p) => p.id));
        const entries = mine.players
            .filter((p) => !taken.has(p.id))
            .map((p) => {
                const posRank = app.rankings.get(p.id) ?? 999;
                return { player: p, posRank, value: valuePlayer(p, posRank, app.ctx).value };
            });
        const chosen = await pickPlayer({
            title: 'Who are you willing to send?',
            entries: sortBy(entries, (e) => e.value, -1),
            emptyText: 'Every player on this roster is already in the offer.',
            formatValue: (v) => formatValue(app.tradeValue(v)),
        });
        if (!chosen) return;
        offer.push(chosen.player);
        paintChips();
        run();
    }

    let token = 0;
    async function run() {
        const mineNow = ++token;
        const target = mine;
        host.replaceChildren(el('div', { class: 'card' }, spinnerRow('Searching every roster — needs, lineups, then full simulations…')));
        try {
            const built = await build(app, target, {
                want: want.map((p) => p.id),
                offer: offer.map((p) => p.id),
            });
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

async function build(app, me, named = { want: [], offer: [] }) {
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
        // Balanced only, always. An offer the other manager would refuse is
        // not a trade idea, it is a daydream, and a toggle that produced them
        // just made the good results harder to find.
        requireMutualGain: true,
        // Deals are judged on player value as well as lineup fit, on the same
        // market scale every card in the app prints.
        tradeValue: app.tradeValue,
        want: named.want,
        offer: named.offer,
    });

    if (!res.ok) {
        wrap.append(banner(res.error, 'bad'));
        return wrap;
    }

    const targeted = res.mode === 'target' || res.mode === 'target+offer';
    const shopping = res.mode === 'offer' || res.mode === 'target+offer';
    const wantNames = (res.want || []).map((e) => e.player.name).join(' and ');
    const offerNames = (res.offer || []).map((e) => e.player.name).join(' and ');

    wrap.append(
        el(
            'div',
            { class: 'tiles' },
            targeted
                ? tile('Packages priced', res.shortlisted ?? 0, `offers that get them to say yes for ${wantNames}`)
                : tile('Players priced', res.scanned ?? 0, 'of yours checked against every rival roster'),
            targeted
                ? tile('Cheapest costs you', res.trades[0] || res.others[0]
                    ? `${fmtDelta((res.trades[0] || res.others[0]).myGain)}`
                    : '—', 'pts/wk to your lineup')
                : tile('Offers that work', res.shortlisted ?? 0, 'values within 15% and something in it for both of you'),
            tile('Recommended', res.trades.length, 'after the full season simulation')
        )
    );

    // --- The headline -------------------------------------------------------
    // A named player changes the question from "find me a deal" to "what would
    // this cost", so the answer has to be worded as a price rather than as a
    // recommendation.
    wrap.append(
        el(
            'div',
            { class: 'section-head' },
            el('h2', {},
                targeted ? `What it takes to get ${wantNames}`
                    : shopping ? `What ${offerNames} could bring back`
                    : 'Best available trades'),
            el('span', { class: 'hint' },
                targeted ? 'cheapest acceptable offer first' : 'their side shown on neutral values')
        )
    );

    if (!res.trades.length && !res.others.length) {
        wrap.append(
            el(
                'div',
                { class: 'card' },
                el('p', { class: 'muted' },
                    targeted
                        ? `Nothing on your roster gets ${res.want[0]?.player.name}'s owner to yes at a fair price. ` +
                          'That is an answer: he is either untouchable, or the piece it would take is one you do not have.'
                        : shopping
                            ? `Nobody in the league both improves their lineup by taking ${offerNames} and can pay ` +
                              'fairly for him. He is either too good for what they can spare, or not good enough to want.'
                            : 'No deal in this league improves both rosters at a fair price right now. That usually ' +
                              'means your team is shaped like everyone else’s — the finder only proposes trades the ' +
                              'other manager has a reason to accept.')
            )
        );
    } else if (!res.trades.length) {
        wrap.append(
            el('div', { class: 'card' },
                el('p', { class: 'muted' },
                    'Nothing survived the season simulation, but the packages below did improve the lineups. ' +
                    'They are listed with lineup numbers only.'))
        );
    } else {
        for (const t of res.trades) wrap.append(tradeCard(app, me, t, { targeted }));
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
    // --- Priced wrong -------------------------------------------------------
    //
    // Where the market and the projection disagree about the same player. This
    // is a different signal from the usage sections below and a stronger one:
    // usage tells you a role is changing, price tells you nobody has charged
    // for it yet. It also works from week one, where usage needs a month of
    // box scores before it can say anything.
    if (app.ctx?.marketRanks?.size) {
        const rostered = new Map();
        for (const t of teams) for (const p of t.players) rostered.set(p.id, t);
        const mineIds = new Set(me.players.map((p) => p.id));

        const edges = [];
        for (const t of teams) {
            for (const p of t.players) {
                const edge = marketEdge({
                    marketRank: app.ctx.marketRanks.get(p.id) ?? null,
                    projectedRank: app.projections?.[p.id]
                        ? valuePlayer(p, 1, app.ctx).projectedRank
                        : null,
                    pos: p.pos,
                });
                if (edge && edge.kind !== 'fair') edges.push({ player: p, edge, mine: mineIds.has(p.id) });
            }
        }

        const cheap = sortBy(edges.filter((r) => !r.mine && r.edge.kind === 'buy-low'), (r) => r.edge.strength, -1);
        const dear = sortBy(edges.filter((r) => r.mine && r.edge.kind === 'sell-high'), (r) => -r.edge.strength, -1);

        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Priced below their projection'),
            el('span', { class: 'hint' }, 'the league is charging less than they should score')));
        wrap.append(usageCard(cheap.slice(0, 6), rostered, (r) => describeEdge(r.edge, r.player.name), 'good',
            'Nothing on another roster is trading meaningfully below what it projects for.',
            (r) => {
                const owner = rostered.get(r.player.id);
                if (!owner || owner.rosterId === me.rosterId) return null;
                return {
                    label: 'Trade for',
                    hash: encodeOffer({ leagueId: cfg.id, aRoster: me.rosterId, aSend: [], bRoster: owner.rosterId, bSend: [r.player.id] }),
                };
            }));

        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Priced above their projection'),
            el('span', { class: 'hint' }, 'your players the league is paying a premium for')));
        wrap.append(usageCard(dear.slice(0, 6), rostered, (r) => describeEdge(r.edge, r.player.name), 'warn',
            'None of your players are carrying a premium over what they project for.',
            (r) => {
                const other = teams.find((t) => t.rosterId !== me.rosterId);
                if (!other) return null;
                return {
                    label: 'Shop him',
                    hash: encodeOffer({ leagueId: cfg.id, aRoster: me.rosterId, aSend: [r.player.id], bRoster: other.rosterId, bSend: [] }),
                };
            }));
    }

    if (lastPlayed >= 4) {
        const { weeklyStats } = await loadWeekContext(raw.season, currentWeek, lastPlayed);
        const rostered = new Map();
        for (const t of teams) for (const p of t.players) rostered.set(p.id, t);

        // One pass over everyone: the baselines sell-high compares against are
        // computed from the scanned pool, so scanning rosters separately would
        // measure each against a different yardstick.
        const index = indexWeeklyStats(weeklyStats);
        const everyone = teams.flatMap((t) => t.players);
        const scanned = scanUsage({ weeklyStats, players: everyone, scoring: cfg.scoring, index });
        const mineIds = new Set(me.players.map((p) => p.id));

        const buyRows = scanned.filter((r) => !mineIds.has(r.player.id) && r.buyLow !== null && r.buyLow > 1.5);
        const sellRows = scanned.filter((r) => mineIds.has(r.player.id) && r.sellHigh !== null && r.sellHigh > 1.5);

        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Buy low'),
            el('span', { class: 'hint' }, 'role growing faster than the box score')));
        wrap.append(usageCard(sortBy(buyRows, (r) => r.buyLow, -1).slice(0, 6), rostered, describeBuyLow, 'good',
            'Nobody on another roster is showing a clear usage-up, points-down profile yet.',
            // A name and a reason is half an answer. The button opens the
            // calculator already holding the deal, with the balancer ready to
            // say what it would take -- which is the question the row raises.
            (r) => {
                const owner = rostered.get(r.player.id);
                if (!owner || owner.rosterId === me.rosterId) return null;
                return {
                    label: 'Trade for',
                    hash: encodeOffer({ leagueId: cfg.id, aRoster: me.rosterId, aSend: [], bRoster: owner.rosterId, bSend: [r.player.id] }),
                };
            }));

        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Sell high'),
            el('span', { class: 'hint' }, 'your players carried by touchdowns')));
        wrap.append(usageCard(sortBy(sellRows, (r) => r.sellHigh, -1).slice(0, 6), rostered, describeSellHigh, 'warn',
            'None of your players are unusually touchdown-dependent right now.',
            (r) => {
                // Shop him at whoever is thinnest at the position; the picker
                // in the calculator changes it in one click if that is wrong.
                const other = teams.find((t) => t.rosterId !== me.rosterId);
                if (!other) return null;
                return {
                    label: 'Shop him',
                    hash: encodeOffer({ leagueId: cfg.id, aRoster: me.rosterId, aSend: [r.player.id], bRoster: other.rosterId, bSend: [] }),
                };
            }));
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

/** One side of an offer, however many players it involves. */
function leg(label, tone, entries) {
    return el(
        'div',
        { class: 'finder-leg' },
        el('div', { class: `tiny ${tone}` }, label),
        ...entries.map((e) =>
            el(
                'div',
                { class: 'row', style: 'gap:8px;flex-wrap:nowrap;min-width:0;margin-top:2px' },
                posBadge(e.player.pos),
                el('span', { class: 'ellipsis' }, playerLink(e.player))
            )
        )
    );
}

/** "Thin at RB · deep at WR" — why this manager is worth calling at all. */
function rosterShape(t) {
    const bits = [];
    if (t.theirNeed && t.theirNeed.deficit > 1) bits.push(`thin at ${t.theirNeed.pos}`);
    if (t.theirSurplus && t.theirSurplus.surplus > 1) bits.push(`deep at ${t.theirSurplus.pos}`);
    return bits.length ? el('div', { class: 'tiny dim' }, bits.join(' · ')) : null;
}

function tradeCard(app, me, t, { targeted = false } = {}) {
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
                leg('YOU GET', 'good', t.gets || [t.get]),
                el('div', { class: 'finder-arrow' }, '⇄'),
                leg('YOU SEND', 'bad', t.gives || [t.give])
            ),
            el(
                'div',
                { class: 'finder-partner' },
                el('div', { class: 'small', style: 'font-weight:600' }, theirName),
                t.posture ? tag(t.posture.label, t.posture.kind === 'seller' ? 'good' : t.posture.kind === 'buyer' ? 'warn' : '') : null,
                rosterShape(t)
            )
        ),
        el(
            'div',
            { class: 'finder-numbers' },
            el('div', { class: 'fn' },
                // With a named target the lineup number is the PRICE, and a
                // price that is negative is still the answer to the question
                // that was asked.
                el('div', { class: 'k' }, targeted ? 'Cost to your lineup' : 'Your lineup'),
                el('div', { class: `v num ${t.myGain >= 0 ? 'good' : 'bad'}` }, `${fmtDelta(t.myGain)} pts/wk`)),
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
                el('div', { class: 'v num' }, `${fmtDelta(t.theirGain)} pts/wk`)),
            // The value ledger the deal was actually judged on. Showing the
            // lineup numbers without it was the reason a screen full of real
            // trades could still look like nonsense: nothing on the card said
            // the two piles were worth roughly the same.
            t.valueIn !== undefined
                ? el('div', { class: 'fn' },
                    el('div', { class: 'k' }, 'Value'),
                    el('div', { class: 'v num' }, `${formatValue(t.valueIn)} for ${formatValue(t.valueOut)}`))
                : null
        ),
        el('p', { class: 'small muted', style: 'margin:10px 0 0' }, 'Why they say yes: ', accept),
        el(
            'div',
            { class: 'row', style: 'margin-top:12px;gap:8px' },
            el('button', {
                class: 'btn btn-sm btn-primary',
                onclick: () => openInCalculator(app, me, t),
            }, 'Open in calculator'),
            el('button', {
                class: 'btn btn-sm',
                onclick: () => {
                    const url = offerUrl(offerOf(app, me, t));
                    navigator.clipboard?.writeText(url).then(
                        () => toast('Trade link copied — paste it in your league chat', 'good'),
                        () => toast(url, '')
                    );
                },
            }, 'Copy link')
        )
    );
}

const offerOf = (app, me, t) => ({
    leagueId: app.league?.cfg?.id ?? null,
    aRoster: me.rosterId,
    aSend: (t.gives || [t.give]).map((e) => e.player.id),
    bRoster: t.other.rosterId,
    bSend: (t.gets || [t.get]).map((e) => e.player.id),
});

function openInCalculator(app, me, t) {
    location.hash = encodeOffer(offerOf(app, me, t));
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
                ...(t.gets || [t.get]).flatMap((e) => [posBadge(e.player.pos), playerLink(e.player)]),
                el('span', { class: 'dim' }, '·'),
                el('span', { class: 'tiny bad' }, 'SEND'),
                ...(t.gives || [t.give]).flatMap((e) => [posBadge(e.player.pos), playerLink(e.player)])
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
                    onclick: () => openInCalculator(app, me, t),
                },
                'Open'
            )
        )
    );
}

function usageCard(rows, rostered, describe, tone, emptyText, actionFor = null) {
    if (!rows.length) return el('div', { class: 'card' }, el('p', { class: 'muted' }, emptyText));
    return el(
        'div',
        { class: 'card' },
        ...rows.map((r) => {
            const action = actionFor?.(r) || null;
            return el(
                'div',
                { class: `reason k-${tone}`, style: 'align-items:center' },
                el(
                    'div',
                    { style: 'min-width:0;flex:1' },
                    el(
                        'div',
                        { class: 'row', style: 'gap:8px' },
                        posBadge(r.player.pos),
                        el('span', { style: 'font-weight:600' }, playerLink(r.player)),
                        el('span', { class: 'tiny dim' }, rostered.get(r.player.id)?.name || 'free agent')
                    ),
                    el('div', { class: 'r-detail' }, describe(r))
                ),
                action
                    ? el(
                          'button',
                          {
                              class: 'btn btn-sm',
                              style: 'padding:2px 8px;font-size:12px;white-space:nowrap',
                              onclick: () => { location.hash = action.hash; },
                          },
                          action.label
                      )
                    : null
            );
        })
    );
}
