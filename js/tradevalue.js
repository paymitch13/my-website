// Market-style trade values.
//
// The engine works in points above replacement, which is the right unit for
// deciding anything: it composes with lineups, schedules and simulations. It is
// a poor unit for *reading*, because the numbers are small and close together —
// a 63 next to a 58 does not feel like the gap it represents.
//
// Sites people are used to (FantasyCalc and friends) quote values in the
// thousands. That is partly presentation, and this module says so plainly: a
// linear rescale adds no accuracy at all.
//
// The part that IS substantive is the curve. Trade markets are convex: one
// elite player costs more than two good ones, because a roster has a fixed
// number of starting slots and only one of them can hold your best player.
// Points above replacement is close to linear, so on the raw scale two RB20s
// look equal to one RB4 — and no manager alive makes that trade. Raising value
// to a power greater than one reproduces the premium the market actually
// charges for consolidation.

import { clamp } from './util.js';

/** The best player in the league lands here, as on the sites people know. */
export const TOP_VALUE = 10000;

/**
 * Convexity, used only when there is no market to calibrate against. 1.0 would
 * be a pure rescale of points above replacement; above 1.0 charges a premium
 * for elite players. 1.35 was tuned by intuition -- "one elite player is worth
 * roughly two solid starters" -- and never fitted to anything, which is exactly
 * the problem the calibrated curve below exists to fix.
 */
const CURVE = 1.35;

/** How many values are needed before rank-matching against the market means
 *  anything. Below this the power curve is the honest answer. */
const MIN_FOR_CALIBRATION = 8;

/**
 * Build a scaler for a whole league at once.
 *
 * Two curves, and the difference between them was worth about a fivefold error
 * on ordinary starters.
 *
 * The old one raised each player's share of the top raw value to a power. Both
 * halves of that are steep: points above replacement is already a difference,
 * which amplifies relative gaps, and the exponent amplifies them again.
 * Measured against real market prices at matched rank, the result crushed
 * everyone below the elite -- the WR12 came out at 30% of the WR1 where the
 * market pays 52%, the RB30 at 4% against 12%, the TE5 at 12% against 34%. A
 * genuine WR1-plus-WR12 package therefore lost to a single elite tight end,
 * because the second piece had been priced at almost nothing.
 *
 * The new one keeps our ORDERING and takes the market's SPACING: a player who
 * sits Nth on this league's board is priced at what the Nth-best asset actually
 * costs. That is the same division of labour the rest of the app already runs
 * on -- the board supplies the opinion, something external supplies the scale
 * -- and it means positional premiums, superflex and scoring quirks all land
 * automatically, because they move a player's rank and the curve does the rest.
 *
 * @param {number[]} values raw rest-of-season values for the whole league
 * @param {object} [opts]
 * @param {number[]} [opts.marketCurve] observed market prices, best first
 */
export function createTradeValueScale(values, { marketCurve = null } = {}) {
    const positive = (values || []).filter((v) => Number.isFinite(v) && v > 0);
    const top = positive.length ? Math.max(...positive) : 1;

    const curve = (marketCurve || []).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => b - a);
    if (curve.length >= MIN_FOR_CALIBRATION && positive.length >= MIN_FOR_CALIBRATION) {
        return calibrated(positive, curve);
    }

    return function tradeValue(raw) {
        if (!Number.isFinite(raw) || raw <= 0) return 0;
        const share = clamp(raw / top, 0, 1);
        return Math.round(TOP_VALUE * share ** CURVE);
    };
}

/**
 * Price by rank against the observed market.
 *
 * Ranks are matched absolutely rather than by percentile: our board and the
 * market's are both "every asset in a league of this shape, best first", so the
 * Nth entry means the same thing on each. Past the end of the market's coverage
 * the tail decays, which is the same thing the projection curves do and for the
 * same reason -- a deep bench player still needs a distinct, small, positive
 * number rather than a cliff.
 */
function calibrated(values, curve) {
    const board = [...values].sort((a, b) => b - a);
    const top = curve[0];
    const TAIL = 0.06;

    /** Market price at a fractional 0-based rank. */
    const priceAt = (rank) => {
        // Above the board's best. Rare, but it must not flatten into a tie at
        // the ceiling: two assets both better than everything else are still
        // not worth the same. Extrapolated on the curve's own leading slope,
        // which is the only evidence available up there.
        if (rank < 0) return curve[0] + (curve[0] - curve[1]) * -rank;
        if (rank === 0) return curve[0];
        const last = curve.length - 1;
        if (rank >= last) return curve[last] * Math.exp(-TAIL * (rank - last));
        const lo = Math.floor(rank);
        const frac = rank - lo;
        return curve[lo] + (curve[lo + 1] - curve[lo]) * frac;
    };

    return function tradeValue(raw) {
        if (!Number.isFinite(raw) || raw <= 0) return 0;
        return Math.round((TOP_VALUE * priceAt(fractionalRank(board, raw))) / top);
    };
}

/**
 * Where `raw` sits on a descending board, as a 0-based rank that may fall
 * between two entries.
 *
 * Interpolating rather than snapping matters: two players a hair apart in raw
 * value must not be handed the same price, or the ordering the whole app is
 * built on quietly collapses into ties.
 */
function fractionalRank(board, raw) {
    let lo = 0;
    let hi = board.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (board[mid] > raw) lo = mid + 1;
        else hi = mid;
    }
    // `lo` is the first entry not greater than raw. Interpolate against the one
    // above it so the rank moves smoothly between them.
    if (lo === 0) {
        // Better than anything on the board: extrapolate above rank 0 so a
        // genuinely top asset is not capped at the same price as the board's
        // best. Bounded, because there is no market data up there.
        const best = board[0];
        return best > 0 ? -Math.min(0.9, (raw - best) / best) : 0;
    }
    const above = board[lo - 1];
    const below = lo < board.length ? board[lo] : 0;
    const span = above - below;
    const frac = span > 0 ? (above - raw) / span : 0;
    return lo - 1 + clamp(frac, 0, 1);
}

/**
 * Sum a package the way a market does. Convexity already lives in the
 * per-player values, so adding them is correct: two 2,000s total 4,000 against
 * one 5,000, and the single player wins — which is the whole point.
 */
export const packageValue = (values) => (values || []).reduce((a, b) => a + b, 0);

/** Compact display: 8,450 -> "8.5k" for tight columns. */
export function shortValue(v) {
    if (!Number.isFinite(v)) return '—';
    // Round explicitly: (8450/1000).toFixed(1) is "8.4", because 8.45 is not
    // representable and lands just below the midpoint.
    if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
    return String(Math.round(v));
}

export const formatValue = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

/**
 * How lopsided a package swap is, in market terms. Returns the share of total
 * value each side receives, which is what a fairness meter should show.
 */
export function fairness(aValue, bValue) {
    const total = aValue + bValue;
    if (total <= 0) return { aShare: 0.5, bShare: 0.5, gap: 0 };
    return {
        aShare: aValue / total,
        bShare: bValue / total,
        gap: Math.abs(aValue - bValue) / Math.max(aValue, bValue),
    };
}
