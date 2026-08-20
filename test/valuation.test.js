import test from 'node:test';
import assert from 'node:assert/strict';

import { fitCurve, ppgFor, statLine, availability, ageFactor, createValuationContext, valuePlayer } from '../js/valuation.js';
import { normalizeLeague, normalizeScoring, replacementRanks, defaultRosterPositions } from '../js/league.js';

const halfPpr = normalizeScoring({ rec: 0.5 });
const fullPpr = normalizeScoring({ rec: 1 });
const standard = normalizeScoring({});

test('fitCurve passes near its anchor points', () => {
    const f = fitCurve([[1, 20], [12, 11], [24, 7], [48, 4]]);
    assert.ok(Math.abs(f(1) - 20) < 1.5, `f(1)=${f(1)}`);
    assert.ok(Math.abs(f(24) - 7) < 1.0, `f(24)=${f(24)}`);
    assert.ok(f(1) > f(12) && f(12) > f(24) && f(24) > f(48), 'must decrease monotonically');
});

test('points per game land in realistic ranges (half PPR)', () => {
    const qb1 = ppgFor('QB', 1, halfPpr);
    const rb1 = ppgFor('RB', 1, halfPpr);
    const wr1 = ppgFor('WR', 1, halfPpr);
    const te1 = ppgFor('TE', 1, halfPpr);
    assert.ok(qb1 > 20 && qb1 < 27, `QB1 ppg ${qb1}`);
    assert.ok(rb1 > 17 && rb1 < 24, `RB1 ppg ${rb1}`);
    assert.ok(wr1 > 16 && wr1 < 23, `WR1 ppg ${wr1}`);
    assert.ok(te1 > 12 && te1 < 18, `TE1 ppg ${te1}`);
});

test('PPR scoring raises pass catchers and leaves QBs alone', () => {
    const wrStd = ppgFor('WR', 12, standard);
    const wrPpr = ppgFor('WR', 12, fullPpr);
    assert.ok(wrPpr - wrStd > 4, `WR12 should gain ~5 ppg in full PPR, gained ${wrPpr - wrStd}`);
    assert.equal(ppgFor('QB', 1, standard), ppgFor('QB', 1, fullPpr));
});

test('TE premium only moves tight ends', () => {
    const tep = normalizeScoring({ rec: 0.5, bonus_rec_te: 0.5 });
    assert.ok(ppgFor('TE', 5, tep) > ppgFor('TE', 5, halfPpr) + 1.5);
    assert.equal(ppgFor('WR', 5, tep), ppgFor('WR', 5, halfPpr));
});

test('6-point passing TDs raise QB scoring', () => {
    const sixPt = normalizeScoring({ rec: 0.5, pass_td: 6 });
    assert.ok(ppgFor('QB', 1, sixPt) - ppgFor('QB', 1, halfPpr) > 2.5);
});

test('stat lines decline with rank at every position', () => {
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
        const a = ppgFor(pos, 1, halfPpr);
        const b = ppgFor(pos, 10, halfPpr);
        const c = ppgFor(pos, 30, halfPpr);
        assert.ok(a > b && b > c, `${pos}: ${a} ${b} ${c}`);
    }
});

test('superflex pushes the QB replacement level far deeper', () => {
    const oneQb = normalizeLeague({ settings: { num_teams: 12 }, roster_positions: defaultRosterPositions() });
    const sf = normalizeLeague({
        settings: { num_teams: 12 },
        roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'BN', 'BN'],
    });
    assert.equal(sf.superflex, true);
    assert.equal(oneQb.superflex, false);
    const r1 = replacementRanks(oneQb);
    const r2 = replacementRanks(sf);
    assert.ok(r2.QB > r1.QB + 6, `QB replacement ${r1.QB} -> ${r2.QB}`);
});

test('superflex makes an elite QB worth far more', () => {
    const oneQb = normalizeLeague({ settings: { num_teams: 12 }, roster_positions: defaultRosterPositions() });
    const sf = normalizeLeague({
        settings: { num_teams: 12 },
        roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'BN', 'BN'],
    });
    const p = { id: '1', name: 'QB One', pos: 'QB', team: 'KC', age: 28, injury: null };
    const a = valuePlayer(p, 2, createValuationContext(oneQb, { weeksLeft: 12 })).value;
    const b = valuePlayer(p, 2, createValuationContext(sf, { weeksLeft: 12 })).value;
    assert.ok(b > a * 1.5, `superflex QB2 value ${b} should dwarf 1QB value ${a}`);
});

test('injury availability scales with weeks left', () => {
    assert.equal(availability({ injury: null }, 10), 1);
    const out = availability({ injury: 'Out' }, 10);
    assert.ok(out > 0.85 && out < 1);
    assert.ok(availability({ injury: 'IR' }, 10) < 0.35);
    // The same tag costs proportionally more when the season is nearly over.
    assert.ok(availability({ injury: 'Out' }, 2) < availability({ injury: 'Out' }, 12));
});

test('age curves punish old backs hardest', () => {
    assert.ok(ageFactor('RB', 30) < ageFactor('WR', 30));
    assert.ok(ageFactor('WR', 30) < ageFactor('QB', 30));
    assert.ok(ageFactor('RB', 24) > ageFactor('RB', 29));
});

test('dynasty values young players above old ones at equal rank', () => {
    const dyn = normalizeLeague({ settings: { num_teams: 12, type: 2 }, roster_positions: defaultRosterPositions() });
    const ctx = createValuationContext(dyn, { weeksLeft: 12 });
    const young = valuePlayer({ id: 'a', name: 'Young', pos: 'RB', age: 23 }, 3, ctx).value;
    const old = valuePlayer({ id: 'b', name: 'Old', pos: 'RB', age: 30 }, 3, ctx).value;
    assert.ok(young > old * 1.4, `young ${young} vs old ${old}`);
});

test('redraft ignores age entirely', () => {
    const rd = normalizeLeague({ settings: { num_teams: 12, type: 0 }, roster_positions: defaultRosterPositions() });
    const ctx = createValuationContext(rd, { weeksLeft: 12 });
    const young = valuePlayer({ id: 'a', name: 'Young', pos: 'RB', age: 23 }, 3, ctx).value;
    const old = valuePlayer({ id: 'b', name: 'Old', pos: 'RB', age: 30 }, 3, ctx).value;
    assert.equal(young, old);
});
