// League news feed.
//
// There is no free, CORS-open NFL wire service, so rather than fake a headline
// crawler this builds a feed out of the live signals Sleeper actually exposes:
// injury designations, waiver-wire momentum, league transactions and in-progress
// scoring. Every item is filtered to players who matter in THIS league and
// scored for impact using the same lineup math as the trade engine -- an injury
// item says how many points per week the owner actually loses, which is more
// use than a headline.

import * as api from './sleeper.js';
import { optimizeLineup } from './lineup.js';
import { buildEntries } from './trade.js';
import { round, sortBy } from './util.js';

const INJURY_SEVERITY = { IR: 5, PUP: 5, DNR: 5, Out: 4, Sus: 4, NA: 3, Doubtful: 3, COV: 2, Questionable: 1 };

/**
 * Injuries to players rostered in this league, with the real cost to the
 * roster that holds them.
 */
export function injuryReport({ cfg, ctx, teams, rankings }) {
    const items = [];

    for (const team of teams) {
        const entries = buildEntries(team.players, rankings, ctx);
        const baseline = optimizeLineup(entries, cfg.starterSlots).points;

        for (const entry of entries) {
            const p = entry.player;
            if (!p.injury) continue;
            const without = optimizeLineup(entries.filter((e) => e !== entry), cfg.starterSlots).points;
            const cost = baseline - without;

            items.push({
                type: 'injury',
                severity: INJURY_SEVERITY[p.injury] ?? 1,
                player: p,
                team,
                status: p.injury,
                bodyPart: p.injuryBody || null,
                practice: p.practice || null,
                posRank: entry.posRank,
                // Zero for a bench player: a designation only costs you points
                // if the player was going to start.
                weeklyCost: cost,
                availability: entry.detail.availability,
                headline: `${p.name} (${p.pos}, ${p.team}) — ${p.injury}${p.injuryBody ? ` (${p.injuryBody})` : ''}`,
                detail:
                    cost > 0.5
                        ? `${team.name} loses ${round(cost, 1)} pts/week with him out of the lineup.`
                        : `Rostered by ${team.name}, but he was not in the optimal lineup — no immediate cost.`,
            });
        }
    }

    return sortBy(items, (i) => i.severity * 100 + i.weeklyCost, -1);
}

/**
 * Waiver-wire momentum. Sleeper's trending endpoint counts adds across every
 * league on the platform, which is the closest thing to a real-time signal that
 * something happened to a player.
 */
/**
 * Raw add counts, playerId -> adds in the window.
 *
 * The same call the news feed makes, exposed as a lookup, because waiver
 * demand is the closest available proxy for what the next contested claim will
 * cost -- and pricing cash without it means pricing it as though nobody else
 * is bidding.
 */
export async function trendingAdds({ hours = 24, limit = 60 } = {}) {
    const rows = await api.getTrending('add', hours, limit).catch(() => []);
    const out = new Map();
    for (const row of rows || []) {
        if (row?.player_id) out.set(row.player_id, row.count ?? 0);
    }
    return out;
}

export async function trendingReport(players, teams, { hours = 24, limit = 30 } = {}) {
    const [adds, drops] = await Promise.all([
        api.getTrending('add', hours, limit).catch(() => []),
        api.getTrending('drop', hours, limit).catch(() => []),
    ]);

    const rostered = new Map();
    for (const t of teams || []) for (const p of t.players) rostered.set(p.id, t);

    const map = (list, kind) =>
        (list || [])
            .map((row) => {
                const p = players[row.player_id];
                if (!p) return null;
                const owner = rostered.get(p.id);
                return {
                    type: 'trending',
                    kind,
                    player: p,
                    count: row.count,
                    owner: owner || null,
                    headline: `${p.name} (${p.pos}, ${p.team}) — ${row.count.toLocaleString()} ${kind === 'add' ? 'adds' : 'drops'}`,
                    detail: owner
                        ? `Already rostered by ${owner.name} in your league.`
                        : 'Available in your league right now.',
                };
            })
            .filter(Boolean);

    return { adds: map(adds, 'add'), drops: map(drops, 'drop') };
}

const TX_LABEL = { trade: 'Trade', waiver: 'Waiver claim', free_agent: 'Free agent' };

/** Recent adds, drops and trades inside the league. */
export async function transactionFeed(leagueId, week, teams, players, { weeksBack = 2 } = {}) {
    const weeks = [];
    for (let w = week; w > week - weeksBack && w > 0; w--) weeks.push(w);

    const batches = await Promise.all(weeks.map((w) => api.getTransactions(leagueId, w).catch(() => [])));
    const byRoster = new Map(teams.map((t) => [t.rosterId, t]));
    const items = [];

    for (const batch of batches) {
        for (const tx of batch || []) {
            if (tx.status !== 'complete') continue;
            const involved = (tx.roster_ids || []).map((id) => byRoster.get(id)?.name || `Roster ${id}`);
            const adds = Object.keys(tx.adds || {}).map((id) => players[id]).filter(Boolean);
            const drops = Object.keys(tx.drops || {}).map((id) => players[id]).filter(Boolean);

            items.push({
                type: 'transaction',
                kind: tx.type,
                at: tx.status_updated || tx.created,
                week: tx.leg,
                teams: involved,
                adds,
                drops,
                headline: `${TX_LABEL[tx.type] || tx.type} — ${involved.join(' / ')}`,
                detail: [
                    adds.length ? `In: ${adds.map((p) => `${p.name} (${p.pos})`).join(', ')}` : null,
                    drops.length ? `Out: ${drops.map((p) => `${p.name} (${p.pos})`).join(', ')}` : null,
                ]
                    .filter(Boolean)
                    .join('  ·  '),
            });
        }
    }

    return sortBy(items, (i) => i.at || 0, -1);
}

/**
 * Diff two scoreboards so the live view can call out what changed since the
 * last poll rather than silently repainting.
 */
export function diffScoreboard(previous, current) {
    if (!previous) return [];
    const prev = new Map();
    for (const m of previous) for (const s of m.sides) prev.set(s.rosterId, s.points);

    const changes = [];
    for (const m of current) {
        for (const s of m.sides) {
            const before = prev.get(s.rosterId);
            if (before === undefined) continue;
            const delta = s.points - before;
            if (delta > 0.05) changes.push({ rosterId: s.rosterId, name: s.name, delta: round(delta, 2) });
        }
    }
    return sortBy(changes, (c) => c.delta, -1);
}
