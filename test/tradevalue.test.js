import test from 'node:test';
import assert from 'node:assert/strict';

import { createTradeValueScale, TOP_VALUE, packageValue, shortValue, formatValue, fairness } from '../js/tradevalue.js';

test('the best player anchors the scale at the top value', () => {
    const scale = createTradeValueScale([120, 80, 40, 5]);
    assert.equal(scale(120), TOP_VALUE);
    assert.ok(scale(80) < TOP_VALUE);
});

test('values land in the thousands, like the sites people are used to', () => {
    const scale = createTradeValueScale([120, 80, 40, 10]);
    assert.ok(scale(80) > 1000, `expected thousands, got ${scale(80)}`);
    assert.ok(Number.isInteger(scale(80)), 'whole numbers only');
});

test('the curve is convex: one elite player beats two good ones', () => {
    // Raw points above replacement are near-linear, so on that scale two
    // half-value players tie one full-value player. A real market never trades
    // that way, because only one of them can hold your best starting slot.
    const scale = createTradeValueScale([100]);
    const elite = scale(100);
    const twoGood = scale(50) * 2;
    assert.ok(elite > twoGood, `elite ${elite} must beat two halves ${twoGood}`);
});

test('the premium is a premium, not a cliff', () => {
    const scale = createTradeValueScale([100]);
    // Two 60s should still beat one 100: consolidation costs extra, it is not
    // infinitely valuable.
    assert.ok(scale(60) * 2 > scale(100));
});

test('value increases monotonically with raw value', () => {
    const scale = createTradeValueScale([100]);
    let prev = -1;
    for (let raw = 0; raw <= 100; raw += 5) {
        const v = scale(raw);
        assert.ok(v >= prev, `value must not decrease at ${raw}`);
        prev = v;
    }
});

test('worthless and negative raw values floor at zero', () => {
    const scale = createTradeValueScale([100]);
    assert.equal(scale(0), 0);
    assert.equal(scale(-5), 0);
    assert.equal(scale(NaN), 0);
});

test('an empty league does not divide by zero', () => {
    const scale = createTradeValueScale([]);
    assert.equal(scale(10), TOP_VALUE, 'with no reference, the only player is the best');
    assert.equal(scale(0), 0);
});

test('packages add', () => {
    assert.equal(packageValue([1200, 800, 0]), 2000);
    assert.equal(packageValue([]), 0);
});

test('fairness reports each side’s share and the gap', () => {
    const f = fairness(6000, 4000);
    assert.equal(f.aShare, 0.6);
    assert.ok(Math.abs(f.gap - 0.3333) < 0.001);
    assert.deepEqual(fairness(0, 0), { aShare: 0.5, bShare: 0.5, gap: 0 });
});

test('formatting is readable at every magnitude', () => {
    assert.equal(formatValue(8450), '8,450');
    assert.equal(formatValue(NaN), '—');
    assert.equal(shortValue(8450), '8.5k');
    assert.equal(shortValue(420), '420');
});

test('the meter split and the printed values agree', () => {
    // The bar used to be sized from raw points above replacement while the
    // labels underneath quoted scaled values, so a 67/33 bar sat above text
    // that read 72/28.
    const scale = createTradeValueScale([120]);
    const rawA = 100;
    const rawB = 50;
    const scaledA = scale(rawA);
    const scaledB = scale(rawB);

    const split = fairness(scaledA, scaledB);
    const rawSplit = fairness(rawA, rawB);
    assert.ok(
        Math.abs(split.aShare - rawSplit.aShare) > 0.02,
        'the two bases genuinely differ, which is why mixing them was visible'
    );

    // What the meter must use: the same numbers it prints.
    const barPercent = split.aShare * 100;
    const labelPercent = (scaledA / (scaledA + scaledB)) * 100;
    assert.ok(Math.abs(barPercent - labelPercent) < 1e-9);
});

test('a value gap computed in scaled space reconciles with scaled parts', () => {
    const scale = createTradeValueScale([120]);
    const valueIn = 90;
    const valueOut = 60;
    // Right: difference of the scaled values.
    const scaledGap = scale(valueIn) - scale(valueOut);
    // Wrong: the raw difference pushed through a per-player convex curve.
    const categoryError = scale(valueIn - valueOut);
    assert.notEqual(scaledGap, categoryError);
    // The correct gap is exactly what a listed add-on of that size would show.
    assert.equal(scale(valueIn) - scaledGap, scale(valueOut));
});

// --- Calibrating the curve to real prices ----------------------------------
//
// The power curve was tuned by intuition and never fitted to anything.
// Measured against real market prices at matched rank it crushed everyone
// below the elite -- the WR12 at 30% of the WR1 where the market pays 52%, the
// RB30 at 4% against 12% -- which is how a WR1-plus-WR12 package came to lose
// to a single tight end. With prices in hand the spacing is no longer guessed.

/** A market-shaped price curve: steep at the top, long shallow tail. */
const priceCurve = (n = 60) => Array.from({ length: n }, (_, i) => Math.round(10000 * Math.exp(-0.055 * i)));

test('the calibrated curve prices the Nth player at the Nth market price', () => {
    const curve = priceCurve();
    // Raw values in a completely different unit, and not even the same shape.
    const raw = Array.from({ length: 60 }, (_, i) => 100 - i * 1.5);
    const scale = createTradeValueScale(raw, { marketCurve: curve });

    assert.equal(scale(raw[0]), TOP_VALUE, 'the best asset anchors the scale');
    for (const rank of [3, 12, 24, 40]) {
        const expected = Math.round((TOP_VALUE * curve[rank]) / curve[0]);
        assert.equal(scale(raw[rank]), expected, `rank ${rank + 1} must be priced at the market's rank ${rank + 1}`);
    }
});

test('calibration keeps our ordering and only changes the spacing', () => {
    const raw = Array.from({ length: 40 }, (_, i) => 100 - i * 2);
    const scale = createTradeValueScale(raw, { marketCurve: priceCurve() });
    const priced = raw.map(scale);
    for (let i = 1; i < priced.length; i++) {
        assert.ok(priced[i] < priced[i - 1], `ordering broke at ${i}: ${priced[i - 1]} then ${priced[i]}`);
    }
});

test('two players a hair apart do not collapse to the same price', () => {
    const raw = [100, 80, 60, 40, 20, 10, 8, 6, 4, 2];
    const scale = createTradeValueScale(raw, { marketCurve: priceCurve() });
    assert.ok(scale(79.9) < scale(80.1), 'the rank has to move smoothly between board entries');
});

test('mid-tier players stop being priced at nothing', () => {
    // The regression itself: the twelfth-best asset against the best. Raw
    // values decay the way points above replacement actually do -- steeply --
    // because that steepness is half of what the exponent was compounding.
    const raw = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(-0.1 * i));
    const curve = priceCurve();

    const guessed = createTradeValueScale(raw);
    const fitted = createTradeValueScale(raw, { marketCurve: curve });

    const share = (f) => f(raw[11]) / f(raw[0]);
    assert.ok(
        share(fitted) > share(guessed) * 1.3,
        `calibration must lift the mid-tier: ${(share(guessed) * 100).toFixed(0)}% -> ${(share(fitted) * 100).toFixed(0)}%`
    );
    assert.ok(Math.abs(share(fitted) - curve[11] / curve[0]) < 0.02, 'and land where the market actually is');
});

test('a genuine pair beats a single elite when both are priced properly', () => {
    // What the complaint was actually about. The market pays 52% of the top
    // asset for the twelfth; two of those must clear one 90%-of-top player.
    const raw = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(-0.1 * i));
    const scale = createTradeValueScale(raw, { marketCurve: priceCurve() });
    assert.ok(
        scale(raw[4]) + scale(raw[11]) > scale(raw[1]),
        'a WR5 plus a WR12 has to be worth more than a single WR2'
    );
});

test('past the end of the market the tail decays instead of falling off a cliff', () => {
    const raw = Array.from({ length: 120 }, (_, i) => Math.max(0.5, 120 - i));
    const scale = createTradeValueScale(raw, { marketCurve: priceCurve(40) });
    const deep = [60, 80, 100, 119].map((i) => scale(raw[i]));
    for (let i = 1; i < deep.length; i++) assert.ok(deep[i] < deep[i - 1], 'still strictly decreasing');
    assert.ok(deep[deep.length - 1] > 0, 'and still positive');
});

test('without a market the old power curve is used unchanged', () => {
    const raw = [100, 50, 25];
    const scale = createTradeValueScale(raw);
    assert.equal(scale(100), TOP_VALUE);
    assert.equal(scale(50), Math.round(TOP_VALUE * 0.5 ** 1.35));
    // Too few prices to match ranks against is the same situation.
    assert.equal(createTradeValueScale(raw, { marketCurve: [900, 400] })(50), scale(50));
});

test('a value above everything on the board is not capped at the board price', () => {
    const raw = Array.from({ length: 30 }, (_, i) => 100 - i * 3);
    const scale = createTradeValueScale(raw, { marketCurve: priceCurve() });
    assert.ok(scale(140) > scale(100), 'a better-than-best asset must price above the best');
});

test('junk in the market curve is ignored rather than trusted', () => {
    const raw = Array.from({ length: 30 }, (_, i) => 100 - i * 3);
    const dirty = [...priceCurve(30), NaN, 0, -50, null, undefined];
    const scale = createTradeValueScale(raw, { marketCurve: dirty });
    assert.equal(scale(raw[0]), TOP_VALUE);
    assert.ok(scale(raw[10]) > 0);
});
