// What the rest of the world thinks a player is worth.
//
// Every other number in this app is derived: a projection becomes a stat line,
// a stat line becomes points under this league's scoring, points become value
// above replacement. That chain is honest and it is auditable, and there is one
// thing it structurally cannot produce -- what a rival manager will actually
// say yes to.
//
// The gap is not a positional bias you can correct with a constant. Measured
// against the live market: Gibbs and Bijan sit first and second, which a
// projection model agrees with, but Chase is third while Jefferson is tenth and
// Barkley fourteenth. That ordering encodes workload security, offensive
// environment and injury history -- player-specific information that no amount
// of arithmetic over a projection will recover. It can only be imported.
//
// So it is imported, from FantasyCalc's public values endpoint, which is
// derived from real trades in real leagues and is aware of league shape. What
// arrives is treated exactly like the user's own board: an OPINION, expressed
// as a positional ranking. The league still supplies the scale. That keeps one
// valuation pipeline rather than two, and it means a market value automatically
// respects this league's scoring, roster slots and replacement level instead of
// pretending a 12-team half-PPR number fits a superflex.

import { politeFetch } from './net.js';

const BASE = 'https://api.fantasycalc.com/values/current';

/** How long a market snapshot stays fresh. Values move on a scale of days. */
export const MARKET_TTL = 12 * 60 * 60 * 1000;

export class MarketError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'MarketError';
        this.status = status;
    }
}

/**
 * The market is quoted per league shape, so the query has to carry ours.
 *
 * Superflex is the case that proves this matters: the same endpoint prices
 * Josh Allen at 5,866 in a one-quarterback league and 10,539 -- first overall
 * -- in a superflex. A single "market value" column would be wrong for one of
 * those leagues, and silently.
 */
export function marketQuery(cfg) {
    const teams = Math.min(20, Math.max(4, Math.round(cfg?.teams || 12)));
    // The endpoint understands whole quarterback slots. A superflex counts as
    // the second one; fractional flex shares do not map onto anything it knows.
    const numQbs = cfg?.superflex ? 2 : 1;
    // Points per reception, from this league's actual scoring rather than a
    // guess at the format name.
    const ppr = clampPpr(cfg?.scoring?.rec);
    return {
        isDynasty: cfg?.format && cfg.format !== 'redraft',
        numQbs,
        numTeams: teams,
        ppr,
    };
}

const clampPpr = (rec) => {
    const n = Number(rec);
    if (!Number.isFinite(n) || n <= 0.125) return 0;
    if (n < 0.75) return 0.5;
    return 1;
};

export const marketUrl = (cfg) => {
    const q = marketQuery(cfg);
    return `${BASE}?isDynasty=${q.isDynasty}&numQbs=${q.numQbs}&numTeams=${q.numTeams}&ppr=${q.ppr}`;
};

/** A stable identity for one league shape, so a cached snapshot is not reused
 *  across a redraft league and a superflex dynasty one. */
export const marketKey = (cfg) => {
    const q = marketQuery(cfg);
    return `${q.isDynasty ? 'dyn' : 'red'}-${q.numQbs}qb-${q.numTeams}tm-${q.ppr}ppr`;
};

const POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

/**
 * Turn the payload into a table keyed by SLEEPER id.
 *
 * The join is on `sleeperId`, which the feed carries directly. That is worth
 * saying out loud because the last external source wired into this app -- ESPN
 * player props -- had to be matched on normalized names, and covered only about
 * a quarter of rostered players by id. This one is exact, and a player either
 * has a market price or provably does not.
 */
export function parseMarketValues(rows) {
    const byId = new Map();
    if (!Array.isArray(rows)) return byId;

    for (const row of rows) {
        const p = row?.player;
        const sleeperId = p?.sleeperId ? String(p.sleeperId) : null;
        const value = Number(row?.value);
        if (!sleeperId || !Number.isFinite(value) || value <= 0) continue;

        const pos = normalizePos(p.position);
        if (!POS.has(pos)) continue;

        byId.set(sleeperId, {
            id: sleeperId,
            name: p.name || null,
            pos,
            value,
            overallRank: intOr(row.overallRank, null),
            // The market's own positional ordering. This is the number that
            // actually enters the valuation pipeline.
            posRank: intOr(row.positionRank, null),
            trend30: numOr(row.trend30Day, null),
            adp: numOr(row.maybeAdp, null),
            tier: intOr(row.maybeTier, null),
            // How much managers argue about him. A wide band is a player the
            // market itself has not settled on.
            spread: numOr(row.maybeMovingStandardDeviationPerc, null),
        });
    }
    return byId;
}

const normalizePos = (pos) => {
    const p = String(pos || '').toUpperCase();
    return p === 'DST' || p === 'D/ST' || p === 'DEF' ? 'DEF' : p === 'PK' ? 'K' : p;
};
const numOr = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const intOr = (v, fallback) => {
    const n = numOr(v, null);
    return n === null ? fallback : Math.round(n);
};

/**
 * The market's board, in the same shape as the user's: player id -> positional
 * rank.
 *
 * Ranks are recomputed from the values present rather than taken from the
 * feed's own `positionRank`, because the feed ranks against every player it
 * covers and we only care about ordering. Recomputing also closes the gaps left
 * by anyone we could not join, so the ranks handed to the valuation curve are
 * dense -- a board that jumps from RB4 to RB7 would price RB5 and RB6 as though
 * they did not exist.
 */
export function marketRanks(byId) {
    const byPos = new Map();
    for (const row of byId.values()) {
        if (!byPos.has(row.pos)) byPos.set(row.pos, []);
        byPos.get(row.pos).push(row);
    }
    const ranks = new Map();
    for (const list of byPos.values()) {
        list.sort((a, b) => b.value - a.value);
        list.forEach((row, i) => ranks.set(row.id, i + 1));
    }
    return ranks;
}

/**
 * Where the market and the projection disagree about one player.
 *
 * This difference is the whole reason for importing a market at all. A player
 * the market ranks well below his projection is cheap to acquire relative to
 * what he is likely to score; one ranked well above is expensive, and the time
 * to sell. Neither number alone can tell you that -- the projection has no idea
 * what he costs, and the price has no idea what he will do.
 *
 * Reported in ranks rather than in value because ranks are what a person
 * negotiates in, and because the two scales are not the same unit.
 */
export function marketEdge({ marketRank, projectedRank, pos }) {
    if (!Number.isFinite(marketRank) || !Number.isFinite(projectedRank)) return null;
    const gap = marketRank - projectedRank;

    // A rank is a coarser instrument deep on the board than at the top: QB3
    // against QB6 is a real disagreement, WR63 against WR66 is noise. Scaling
    // by where on the board the argument is happening keeps one threshold
    // honest across the whole range.
    const depth = Math.max(4, Math.min(marketRank, projectedRank));
    const strength = gap / depth;

    return {
        marketRank,
        projectedRank,
        pos,
        gap,
        strength,
        // Positive gap = the market ranks him WORSE than the projection does.
        kind: strength >= 0.25 ? 'buy-low' : strength <= -0.25 ? 'sell-high' : 'fair',
    };
}

/**
 * The observed price distribution for this league shape, best first.
 *
 * This is the market's SPACING rather than its opinion of any individual: how
 * much the best asset is worth against the twelfth, the thirtieth, the
 * hundredth. Fed to the value scale so a player who sits Nth on this league's
 * own board is priced at what an Nth-best asset actually costs, instead of at
 * whatever an invented exponent produced.
 */
export function marketPriceCurve(snapshot) {
    const byId = snapshot?.byId;
    if (!byId?.size) return null;
    return [...byId.values()].map((r) => r.value).sort((a, b) => b - a);
}

/** Every player the market and the projections disagree about, loudest first. */
export function divergences(byId, projectedRankOf, { minStrength = 0.25, limit = 40 } = {}) {
    const out = [];
    for (const row of byId.values()) {
        const projectedRank = projectedRankOf(row.id);
        const edge = marketEdge({ marketRank: row.posRank, projectedRank, pos: row.pos });
        if (!edge || Math.abs(edge.strength) < minStrength) continue;
        out.push({ ...edge, id: row.id, name: row.name, marketValue: row.value, trend30: row.trend30 });
    }
    out.sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength));
    return out.slice(0, limit);
}

/** One sentence a person can act on. */
export function describeEdge(edge, name) {
    if (!edge || edge.kind === 'fair') return null;
    const who = name || 'He';
    const posRank = (n) => `${edge.pos}${n}`;
    if (edge.kind === 'buy-low') {
        return `${who} is priced as ${posRank(edge.marketRank)} but projects as ${posRank(edge.projectedRank)} — ` +
            `the league is charging less than he is likely to score.`;
    }
    return `${who} is priced as ${posRank(edge.marketRank)} but projects as ${posRank(edge.projectedRank)} — ` +
        `the league is paying more than he is likely to score.`;
};

/**
 * Fetch the market for this league shape.
 *
 * Everything about this is best-effort on purpose. The app worked without a
 * market before and has to keep working when this call fails: a rate limit, an
 * outage, or someone offline should cost the extra opinion, never the tool. So
 * failures resolve to null and every caller falls back to the projected board.
 *
 * @param {object} cfg normalized league
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] injected for tests
 * @param {object} [opts.store] { load(key), save(key, rows) } persistence
 * @param {boolean} [opts.force] skip the cache
 */
export async function fetchMarketValues(cfg, { fetchImpl = null, store = null, force = false } = {}) {
    const key = marketKey(cfg);

    if (!force && store?.load) {
        const cached = store.load(key);
        if (cached) return { ...cached, cached: true };
    }

    const doFetch = fetchImpl || ((url) => politeFetch(url));
    let rows;
    try {
        const res = await doFetch(marketUrl(cfg));
        if (!res?.ok) throw new MarketError(`Market returned ${res?.status}`, res?.status ?? 0);
        rows = await res.json();
    } catch (err) {
        // Deliberately quiet. A missing market is a missing second opinion, not
        // an error the user did anything about or can do anything about.
        console.warn('Market values unavailable', err?.message || err);
        return null;
    }

    const byId = parseMarketValues(rows);
    if (byId.size < 24) return null;

    const snapshot = { key, at: Date.now(), byId, ranks: marketRanks(byId) };
    store?.save?.(key, snapshot);
    return snapshot;
}
