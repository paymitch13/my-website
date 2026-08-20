// League transaction history.
//
// Sleeper exposes transactions per week, so a season history means fetching
// every week and stitching them together. Once assembled it answers two
// different questions from the same data: what has the league been doing, and
// what has happened to this specific player.

import { getTransactions } from './sleeper.js';
import { sortBy } from './util.js';

export const TX_LABEL = {
    trade: 'Trade',
    waiver: 'Waiver claim',
    free_agent: 'Free agent',
    commissioner: 'Commissioner move',
};

/**
 * Normalize one raw Sleeper transaction.
 *
 * Sleeper models a trade as a single transaction whose `adds` maps player id ->
 * the roster that received him and whose `drops` maps player id -> the roster
 * that gave him up. Reshaping that into per-team gives/gets is what makes a
 * trade readable.
 */
export function normalizeTransaction(tx, { teamsById, players }) {
    if (!tx || tx.status !== 'complete') return null;

    const rosterIds = tx.roster_ids || [];
    const teamName = (id) => teamsById.get(id)?.name || `Roster ${id}`;
    const playerOf = (id) => players[id] || { id, name: `Player ${id}`, pos: '?', team: 'FA' };

    const movements = [];
    for (const [playerId, toRoster] of Object.entries(tx.adds || {})) {
        movements.push({
            player: playerOf(playerId),
            to: toRoster,
            from: (tx.drops || {})[playerId] ?? null,
        });
    }
    // A drop with no matching add is a straight release.
    for (const [playerId, fromRoster] of Object.entries(tx.drops || {})) {
        if ((tx.adds || {})[playerId] !== undefined) continue;
        movements.push({ player: playerOf(playerId), to: null, from: fromRoster });
    }

    // Per-team ledger: what each side gave and got.
    const sides = rosterIds.map((rosterId) => ({
        rosterId,
        name: teamName(rosterId),
        gets: movements.filter((m) => m.to === rosterId).map((m) => m.player),
        gives: movements.filter((m) => m.from === rosterId).map((m) => m.player),
    }));

    const picks = (tx.draft_picks || []).map((p) => ({
        season: p.season,
        round: p.round,
        from: p.previous_owner_id,
        to: p.owner_id,
    }));

    const faab = (tx.waiver_budget || []).map((w) => ({
        from: w.sender,
        to: w.receiver,
        amount: w.amount,
    }));

    return {
        id: tx.transaction_id,
        type: tx.type,
        label: TX_LABEL[tx.type] || tx.type,
        week: tx.leg ?? null,
        at: tx.status_updated || tx.created || null,
        rosterIds,
        sides,
        movements,
        picks,
        faab,
        bid: tx.settings?.waiver_bid ?? null,
        isTrade: tx.type === 'trade',
    };
}

/**
 * Every completed transaction in the season, newest first.
 * Weeks are fetched in parallel and individual failures are tolerated.
 */
export async function loadSeasonTransactions(leagueId, throughWeek, { teamsById, players }) {
    const weeks = [];
    for (let w = 1; w <= Math.max(1, Math.min(throughWeek, 18)); w++) weeks.push(w);

    const batches = await Promise.all(weeks.map((w) => getTransactions(leagueId, w).catch(() => [])));

    const out = [];
    for (const batch of batches) {
        for (const tx of batch || []) {
            const n = normalizeTransaction(tx, { teamsById, players });
            if (n) out.push(n);
        }
    }
    return sortBy(out, (t) => t.at || 0, -1);
}

/**
 * Everything that has happened to one player, oldest first so it reads as a
 * story: drafted here, traded there, dropped, claimed.
 */
export function playerHistory(transactions, playerId) {
    const events = [];
    for (const tx of transactions || []) {
        const move = tx.movements.find((m) => m.player.id === playerId);
        if (!move) continue;
        events.push({
            at: tx.at,
            week: tx.week,
            type: tx.type,
            label: tx.label,
            from: move.from,
            to: move.to,
            transaction: tx,
        });
    }
    return sortBy(events, (e) => e.at || 0);
}

/** Just the trades, for the league trade log. */
export const tradesOnly = (transactions) => (transactions || []).filter((t) => t.isTrade);

/**
 * A one-line summary of a trade, from the point of view of the whole league.
 * "Team A gets X, Y · Team B gets Z"
 */
export function summarizeTrade(tx, { includePicks = true } = {}) {
    return tx.sides
        .map((side) => {
            const names = side.gets.map((p) => p.name);
            if (includePicks) {
                for (const pick of tx.picks.filter((p) => p.to === side.rosterId)) {
                    names.push(`${pick.season} R${pick.round}`);
                }
            }
            for (const f of tx.faab.filter((f) => f.to === side.rosterId)) {
                names.push(`$${f.amount} FAAB`);
            }
            return `${side.name} gets ${names.length ? names.join(', ') : 'nothing'}`;
        })
        .join('  ·  ');
}

/** Detect trades that are new since a previously seen set of ids. */
export function newTradesSince(transactions, seenIds) {
    const seen = new Set(seenIds || []);
    return tradesOnly(transactions).filter((t) => !seen.has(t.id));
}
