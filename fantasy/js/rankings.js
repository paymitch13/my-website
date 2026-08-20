// The rankings board: the user's opinion, which every other number derives from.
//
// A ranking is just an ordered list of player ids per position; a player's
// positional rank is his index + 1. The board is seeded from Sleeper's own
// popularity ordering so the app is usable on first load, and every edit after
// that is the user's.

import { sortBy } from './util.js';

export const RANKABLE = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/** How deep the board goes per position. Beyond this, everyone is waiver fodder. */
const DEPTH = { QB: 40, RB: 75, WR: 90, TE: 40, K: 32, DEF: 32 };

/**
 * Starting order straight from Sleeper's search_rank. This is explicitly a
 * seed, not an opinion -- the whole point of the app is that the user replaces
 * it with theirs.
 */
export function seedOrder(players) {
    const byPos = {};
    for (const pos of RANKABLE) byPos[pos] = [];
    for (const p of Object.values(players)) {
        if (byPos[p.pos]) byPos[p.pos].push(p);
    }
    const out = {};
    for (const pos of RANKABLE) {
        out[pos] = sortBy(byPos[pos], (p) => p.searchRank)
            .slice(0, DEPTH[pos])
            .map((p) => p.id);
    }
    return out;
}

/**
 * Merge the saved board with the current player database.
 *
 * Players who retired or changed names drop out; players who did not exist when
 * the board was saved (rookies, waiver risers) get slotted in at roughly where
 * Sleeper ranks them rather than dumped at the bottom, so a board saved in
 * August is still coherent in November.
 */
export function mergeOrder(savedOrder, players) {
    const seeded = seedOrder(players);
    const merged = {};

    for (const pos of RANKABLE) {
        const saved = (savedOrder?.[pos] || []).filter((id) => players[id] && players[id].pos === pos);
        const present = new Set(saved);
        const missing = seeded[pos].filter((id) => !present.has(id));

        const list = saved.slice();
        for (const id of sortBy(missing, (id) => players[id].searchRank)) {
            const rank = players[id].searchRank;
            // Place the newcomer after the last player Sleeper rates ahead of
            // him. Scanning from the bottom rather than the top is deliberate:
            // a player the user never saw must never leapfrog one the user
            // deliberately ranked, so an August board that has been hand-sorted
            // survives a November merge intact.
            let at = list.length;
            for (let i = list.length - 1; i >= 0; i--) {
                if ((players[list[i]]?.searchRank ?? 1e9) < rank) {
                    at = i + 1;
                    break;
                }
                at = i;
            }
            list.splice(at, 0, id);
        }
        merged[pos] = list;
    }
    return merged;
}

/** playerId -> positional rank, for the whole board. */
export function toRankMap(order) {
    const map = new Map();
    for (const pos of RANKABLE) {
        (order[pos] || []).forEach((id, i) => map.set(id, i + 1));
    }
    return map;
}

/** Move a player to a new index within his position. Returns a new order. */
export function reorder(order, pos, playerId, toIndex) {
    const list = (order[pos] || []).slice();
    const from = list.indexOf(playerId);
    if (from < 0) return order;
    list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, playerId);
    return { ...order, [pos]: list };
}

/** Move a player by a relative number of spots. */
export function nudge(order, pos, playerId, delta) {
    const list = order[pos] || [];
    const from = list.indexOf(playerId);
    if (from < 0) return order;
    return reorder(order, pos, playerId, from + delta);
}

// --- Import / export -------------------------------------------------------

export function toCsv(order, players) {
    const rows = ['position,rank,player,team,player_id'];
    for (const pos of RANKABLE) {
        (order[pos] || []).forEach((id, i) => {
            const p = players[id];
            if (!p) return;
            rows.push([pos, i + 1, csvCell(p.name), p.team, id].join(','));
        });
    }
    return rows.join('\n');
}

const csvCell = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);

/**
 * Parse a rankings CSV. Accepts either an explicit `player_id` column (what we
 * export) or a `player` name column, which is what every other site gives you.
 * Name matching is deliberately forgiving about punctuation and suffixes.
 */
export function fromCsv(text, players) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return { order: {}, matched: 0, unmatched: [] };

    const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const idCol = header.findIndex((h) => h === 'player_id' || h === 'id' || h === 'sleeper_id');
    const nameCol = header.findIndex((h) => h === 'player' || h === 'name' || h === 'player_name');
    const posCol = header.findIndex((h) => h === 'position' || h === 'pos');
    const rankCol = header.findIndex((h) => h === 'rank' || h === 'overall' || h === 'rk');
    const hasHeader = idCol >= 0 || nameCol >= 0 || posCol >= 0;

    const nameIndex = buildNameIndex(players);
    const buckets = {};
    for (const pos of RANKABLE) buckets[pos] = [];
    const unmatched = [];
    let matched = 0;

    for (const line of lines.slice(hasHeader ? 1 : 0)) {
        const cells = splitCsvLine(line);
        if (!cells.length) continue;

        let id = idCol >= 0 ? cells[idCol]?.trim() : null;
        if (id && !players[id]) id = null;
        if (!id) {
            const raw = (nameCol >= 0 ? cells[nameCol] : cells[0]) || '';
            const hit = nameIndex.get(normalizeName(raw));
            if (hit && hit.length === 1) id = hit[0];
            else if (hit && hit.length > 1 && posCol >= 0) {
                const wantPos = cells[posCol].trim().toUpperCase().replace(/[0-9]/g, '');
                id = hit.find((c) => players[c].pos === wantPos) || null;
            }
        }
        if (!id) {
            const label = (nameCol >= 0 ? cells[nameCol] : cells[0] || '').trim();
            if (label) unmatched.push(label);
            continue;
        }

        const p = players[id];
        if (!buckets[p.pos]) continue;
        const rank = rankCol >= 0 ? Number(cells[rankCol]) : buckets[p.pos].length + 1;
        buckets[p.pos].push({ id, rank: Number.isFinite(rank) ? rank : 9999 });
        matched++;
    }

    const order = {};
    for (const pos of RANKABLE) {
        order[pos] = sortBy(buckets[pos], (b) => b.rank).map((b) => b.id);
    }
    return { order, matched, unmatched };
}

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else if (c === '"') quoted = false;
            else cur += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') {
            out.push(cur);
            cur = '';
        } else cur += c;
    }
    out.push(cur);
    return out;
}

export function normalizeName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
        .replace(/[^a-z]/g, '');
}

function buildNameIndex(players) {
    const idx = new Map();
    for (const p of Object.values(players)) {
        const k = normalizeName(p.name);
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push(p.id);
    }
    return idx;
}

// --- Tiers -----------------------------------------------------------------

/**
 * Auto-tier a position by finding the biggest gaps in projected value.
 *
 * Raw "biggest drops" does not work on its own: the steepest gaps in any
 * fantasy board are between the top few players, so an unconstrained search
 * puts every tier break in the first ten rows and leaves a single tier holding
 * the other sixty. Breaks are therefore chosen greedily by size but must stay
 * at least `minTierSize` apart, which spreads them across the board the way a
 * hand-drawn cheat sheet does.
 */
export function autoTiers(orderedIds, valueOf, maxTiers = 8, minTierSize = 0) {
    const values = orderedIds.map(valueOf);
    if (values.length < 3) return [];

    const gaps = [];
    for (let i = 0; i < values.length - 1; i++) gaps.push({ at: i, drop: values[i] - values[i + 1] });

    const avg = gaps.reduce((a, g) => a + g.drop, 0) / gaps.length;
    const spacing = minTierSize || Math.max(2, Math.floor(values.length / (maxTiers * 1.5)));

    const accepted = [];
    for (const g of sortBy(gaps.filter((x) => x.drop > avg * 1.2), (x) => x.drop, -1)) {
        if (accepted.length >= maxTiers - 1) break;
        const tooCloseToBreak = accepted.some((a) => Math.abs(a - g.at) < spacing);
        const tooCloseToEnd = g.at + 1 < spacing || values.length - (g.at + 1) < spacing;
        if (tooCloseToBreak || tooCloseToEnd) continue;
        accepted.push(g.at);
    }
    return accepted.sort((a, b) => a - b);
}
