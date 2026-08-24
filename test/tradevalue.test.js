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
