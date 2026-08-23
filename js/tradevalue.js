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
 * Convexity. 1.0 would be a pure rescale of points above replacement; above
 * 1.0 charges a premium for elite players. 1.35 is tuned so that one clearly
 * elite player is worth roughly two solid starters, which is where real
 * two-for-one offers tend to settle.
 */
const CURVE = 1.35;

/**
 * Build a scaler for a whole league at once. The curve is anchored to the most
 * valuable player available, so values stay comparable across positions and
 * league formats without any per-position fudging.
 *
 * @param {number[]} values raw rest-of-season values
 */
export function createTradeValueScale(values) {
    const positive = (values || []).filter((v) => Number.isFinite(v) && v > 0);
    const top = positive.length ? Math.max(...positive) : 1;

    return function tradeValue(raw) {
        if (!Number.isFinite(raw) || raw <= 0) return 0;
        const share = clamp(raw / top, 0, 1);
        return Math.round(TOP_VALUE * share ** CURVE);
    };
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
