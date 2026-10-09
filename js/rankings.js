// The rankings: the model's ordering, which every other number derives from.
//
// A ranking is just an ordered list of player ids per position; a player's
// positional rank is his index + 1.
//
// This used to be a board the user could drag. It is not any more, and the
// reason is worth recording: saving an edit persisted the WHOLE ordering, so a
// single drag froze every one of the ~500 ranked players at that moment's
// opinion, and the merge that ran on every later load preserved those frozen
// positions by design. Somebody who nudged one receiver in September had an
// app that silently stopped incorporating results from then on -- which is
// exactly what "it doesn't feel updated through week 4" turned out to mean.
//
// A model that re-derives its ordering from the evidence every load cannot go
// stale that way. The trade-off is real -- there is no way to tell the app it
// is wrong about a player -- and it is the right trade: an opinion you can
// express once and then cannot see is worse than no opinion at all.

import { sortBy } from './util.js';
import { actualsWeight, blendedPpg, projectedPpg, scoreStats } from './projections.js';

export const RANKABLE = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/**
 * How deep the board goes per position. Beyond this, everyone is waiver fodder.
 *
 * Sized for the biggest league anybody actually plays, not the common one. A
 * player off the end of the board has no rank, and a player with no rank was
 * being valued at the 999th spot on the curve -- which is zero. Sixteen teams
 * carrying seven receivers is 112 of them rostered, so a 90-deep receiver board
 * quietly priced a real starter at nothing.
 */
const DEPTH = { QB: 72, RB: 130, WR: 160, TE: 72, K: 40, DEF: 40 };

/**
 * Sort key for the starting board: lower is better.
 *
 * Three sources, in descending order of how much they actually know about a
 * player, because seeding from a preseason forecast alone goes stale the moment
 * the season starts:
 *
 *   1. WHAT HE IS DOING. The preseason projection updated by this season's real
 *      production, under this league's scoring. In week three the projection
 *      still leads, but a back who has taken over a backfield is not the player
 *      August thought he was, and the board has to notice.
 *   2. WHAT HE COSTS. A player with no projection row at all -- and Sleeper
 *      publishes none for roughly 2,400 of the 3,000 active fantasy players --
 *      still has a market price if anybody is trading him. Ranking him behind
 *      every projected body is how a genuinely rostered waiver add ended up
 *      priced at nothing.
 *   3. WHO HE IS. Sleeper's `search_rank`, a popularity ordering rather than a
 *      forecast, and the last resort it always was.
 *
 * The bands are kept far apart on purpose so a player never crosses from one
 * source into another's territory: within a band the ordering is meaningful,
 * between bands it is a statement about how much we know.
 */
/**
 * How much of the outlook the MARKET gets, where it has an opinion.
 *
 * Fitted, not asserted. Scored on next-week points across two folds and 325
 * market-priced players, the market on its own beat the projection-plus-results
 * blend by 12.3%, improving monotonically as its weight rose, and the effect
 * held at every position: QB -17.5%, RB -12.4%, WR -10.7%, TE -10.0%. That is
 * an order of magnitude larger than the noise every other estimator change
 * landed inside, and it makes sense -- a market price is the consensus of
 * people who watched the games, so it absorbs a role change or a coaching
 * decision in days, while a preseason projection cannot absorb one at all.
 *
 * The measured optimum was 1.0, and this is deliberately not 1.0. Three
 * reasons, all of them about not betting the ordering on one feed: the sample
 * is a single season, roughly half the player pool has no market price at all
 * so the blend is still needed there, and the market reaches these units
 * through our own rank curve, so some of its measured edge may belong to the
 * curve. 0.65 keeps about three quarters of the gain and keeps the projection
 * as a hedge. Shrinking inward when the optimum sits on a boundary and the
 * sample is small is the ordinary discipline.
 */
export const MARKET_WEIGHT = 0.65;

/**
 * What the board currently knows, in one sentence.
 *
 * "It doesn't feel like the calc reflects week 4" was a reasonable thing to
 * think about a product that never said what it had read. The board is rebuilt
 * from scratch on every load and it does move -- measured on week-5 data, four
 * fifths of players shift the way their production says, by a median of seven
 * positional ranks -- but nothing anywhere stated the vintage of the inputs,
 * so there was no way to tell a fresh number from a stale one. State it.
 *
 * @param {object} input
 * @param {number} input.lastPlayed  last completed week, 0 before kickoff
 * @param {number|string} input.season
 * @param {number} [input.games]     games of results the average starter has
 * @param {boolean} [input.market]   whether a market price was reached
 * @param {boolean} [input.projected] whether real projections loaded
 */
export function boardVintage({ lastPlayed = 0, season, games = null, market = false, projected = true }) {
    if (!projected) {
        return 'Projections could not be loaded, so this ordering comes from the fallback rank model rather than real projected stat lines.';
    }
    if (!lastPlayed) {
        return (
            `Nothing has been played yet in ${season}, so every value here is the preseason projection` +
            `${market ? ' blended with what the market is paying' : ''}. They will start moving after week 1.`
        );
    }

    const n = games ?? lastPlayed;
    const weight = Math.round(actualsWeight(n) * 100);
    const parts = [
        `Through week ${lastPlayed} of ${season}.`,
        `Each player's ${n === 1 ? 'one game' : `${n} games`} of real production carries ${weight}% against his preseason projection, rising as the season goes.`,
    ];
    if (market) {
        parts.push(
            `That estimate is then blended ${Math.round((1 - MARKET_WEIGHT) * 100)}/${Math.round(MARKET_WEIGHT * 100)} with what leagues are actually paying, which predicted next week better than our own blend did in backtesting.`
        );
    } else {
        parts.push('Market prices could not be reached this load, so the ordering is projection and results only.');
    }
    return parts.join(' ');
}

/**
 * Where each of these players sat on the board before a game was played.
 *
 * The board shows how far this season has moved somebody, and that needs the
 * August ordering of the SAME players -- not a lookup of his old projection
 * against today's curve. Two things go wrong with the lookup. Results lift the
 * top of a curve, because four games of variance always produce somebody hot,
 * so an untouched projection slides down it: measured on week-5 data, a median
 * of four ranks at quarterback. And a curve lookup cannot separate equal
 * projections, so ten players projected alike all come back with the rank of
 * the first of them and the ones below read as having fallen past each other.
 *
 * Re-sorting the board's own ids is exact, costs one sort per repaint, and a
 * tie keeps today's order -- so players the projection cannot tell apart are
 * never reported as having moved.
 *
 * @param {string[]} ids    today's board order for one position
 * @returns {Map<string, number>} id -> August rank, absent if never projected
 */
export function preseasonRanks(ids, { projections, scoring }) {
    const rows = ids.map((id, i) => {
        const proj = projections?.[id] || null;
        const ppg = proj ? projectedPpg(proj, scoring) : null;
        return { id, i, ppg: Number.isFinite(ppg) ? ppg : null };
    });

    // Everyone is ranked, so the scale matches the board's own, but a player
    // August never projected has no position on it to report.
    const ordered = [...rows].sort((a, b) => {
        if (a.ppg === null && b.ppg === null) return a.i - b.i;
        if (a.ppg === null) return 1;
        if (b.ppg === null) return -1;
        return b.ppg - a.ppg || a.i - b.i;
    });

    const out = new Map();
    ordered.forEach((row, idx) => {
        if (row.ppg !== null) out.set(row.id, idx + 1);
    });
    return out;
}

export function buildSeedKeys(players, {
    projections = null,
    scoring = null,
    actuals = null,
    week = 1,
    marketRanks = null,
    /**
     * The market's opinion in points per game: `(pos, marketRank) => ppg`,
     * normally the valuation context's own rank curve. Without it the market
     * stays what it always was -- a fallback for players nobody projected.
     */
    marketPpg = null,
    marketWeight = MARKET_WEIGHT,
} = {}) {
    const keys = new Map();
    const outlook = new Map();
    const produced = new Map();

    if (scoring) {
        for (const p of Object.values(players)) {
            const proj = projections?.[p.id] || null;
            const actual = actuals?.[p.id] || null;

            if (proj) {
                const own = blendedPpg({ projection: proj, actual, scoring, week });
                const mRank = marketRanks?.get(p.id) ?? null;
                const mPpg = mRank && marketPpg ? marketPpg(p.pos, mRank) : null;

                let ppg = own;
                if (Number.isFinite(own) && Number.isFinite(mPpg)) {
                    ppg = own * (1 - marketWeight) + mPpg * marketWeight;
                } else if (!Number.isFinite(own) && Number.isFinite(mPpg)) {
                    ppg = mPpg;
                }
                if (ppg !== null && Number.isFinite(ppg)) outlook.set(p.id, ppg);
                continue;
            }

            // No projection, but he has played and scored. That is evidence,
            // and it is better evidence than a popularity rank.
            const gp = actual?.games ?? 0;
            if (actual && gp > 0) {
                const ppg = scoreStats(actual.stats, scoring) / gp;
                if (Number.isFinite(ppg) && ppg > 0) produced.set(p.id, ppg);
            }
        }
    }

    for (const p of Object.values(players)) {
        if (outlook.has(p.id)) {
            // Negative so that "higher outlook" sorts first, and offset well
            // below every other band so projected players always lead.
            keys.set(p.id, -3e6 - outlook.get(p.id));
        } else if (produced.has(p.id)) {
            keys.set(p.id, -2e6 - produced.get(p.id));
        } else if (marketRanks?.has(p.id)) {
            // Somebody is trading him, so he is worth more than waiver fodder
            // even with nothing else to go on.
            keys.set(p.id, -1e6 + marketRanks.get(p.id));
        } else {
            keys.set(p.id, p.searchRank ?? 99999);
        }
    }
    return keys;
}

/**
 * Starting order for the board. Seeded from projections where available; the
 * user then overrides it, and their overrides always win.
 */
export function seedOrder(players, opts = {}) {
    const keys = opts.seedKeys || buildSeedKeys(players, opts);
    const byPos = {};
    for (const pos of RANKABLE) byPos[pos] = [];
    for (const p of Object.values(players)) {
        if (byPos[p.pos]) byPos[p.pos].push(p);
    }
    const out = {};
    for (const pos of RANKABLE) {
        out[pos] = sortBy(byPos[pos], (p) => keys.get(p.id) ?? 99999)
            .slice(0, DEPTH[pos])
            .map((p) => p.id);
    }
    return out;
}


/** playerId -> positional rank, for the whole board. */
export function toRankMap(order) {
    const map = new Map();
    for (const pos of RANKABLE) {
        (order[pos] || []).forEach((id, i) => map.set(id, i + 1));
    }
    return map;
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
