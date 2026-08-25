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

// --- One replacement line per flex group -----------------------------------
//
// The single biggest distortion the app ever shipped: every position carried
// its own replacement level, so the same production was worth more at running
// back than at receiver purely because the RB curve is steeper. Compounded over
// a season and run through the convex trade curve, it priced the RB4 above the
// WR1 and the trade finder duly offered deals nobody would accept.

/** A projection pool with a distinct, controllable curve shape per position. */
function board({ rbTop = 20, wrTop = 20, teTop = 14, qbTop = 24, decay = 0.4, n = 90 } = {}) {
    const projections = {};
    const add = (pos, top, count) => {
        for (let i = 0; i < count; i++) {
            const ppg = Math.max(1, top - i * decay);
            projections[`${pos}${i}`] = {
                id: `${pos}${i}`, pos, games: 17,
                stats: { rush_yd: ppg * 170 }, ptsHalfPpr: 1,
            };
        }
    };
    add('RB', rbTop, n);
    add('WR', wrTop, n);
    add('TE', teTop, n);
    add('QB', qbTop, 40);
    return projections;
}

const flexLeague = (roster) =>
    normalizeLeague({
        settings: { num_teams: 12, playoff_teams: 6, playoff_week_start: 15 },
        scoring_settings: { rush_yd: 0.1 },
        roster_positions: roster,
    });

test('positions that share a flex slot share one replacement line', () => {
    // Receivers fall away faster than backs here, so per-position lines would
    // land at different points and hand one position free value over the other.
    const projections = board({ rbTop: 20, wrTop: 26, teTop: 14 });
    const cfg = flexLeague(defaultRosterPositions());
    const ctx = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });

    assert.equal(ctx.replacementPpg.RB, ctx.replacementPpg.WR, 'RB and WR fill the same flex');
    assert.equal(ctx.replacementPpg.RB, ctx.replacementPpg.TE, 'and so does TE');
    // The quarterback is not flex-eligible in a one-QB league, so he keeps his
    // own line -- a group of one.
    assert.notEqual(ctx.replacementPpg.QB, ctx.replacementPpg.RB);
});

test('equal production is worth the same at running back and receiver', () => {
    const projections = board({ rbTop: 20, wrTop: 26, teTop: 14 });
    const cfg = flexLeague(defaultRosterPositions());
    const ctx = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });

    // The 10th back and the 22nd receiver score within a whisker of each other
    // on this board. Find the pair and check the app agrees.
    const target = ctx.curves.RB[9];
    const wrRank = ctx.curves.WR.findIndex((p) => p <= target) + 1;
    assert.ok(wrRank > 0);

    const rb = valuePlayer({ id: 'a', pos: 'RB', age: 26, injury: null }, 10, ctx);
    const wr = valuePlayer({ id: 'b', pos: 'WR', age: 26, injury: null }, wrRank, ctx);
    assert.ok(
        Math.abs(rb.value - wr.value) < Math.max(rb.value, wr.value) * 0.12,
        `same production must price alike: RB ${rb.value.toFixed(0)} vs WR ${wr.value.toFixed(0)}`
    );
});

test('a league with no flex gives every position its own line', () => {
    const projections = board({ rbTop: 20, wrTop: 26, teTop: 14 });
    const cfg = flexLeague(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN']);
    const ctx = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });

    assert.notEqual(ctx.replacementPpg.RB, ctx.replacementPpg.WR);
    assert.equal(ctx.replacementPpg.RB, ctx.curves.RB[replacementRanks(cfg).RB - 1]);
});

test('superflex pulls quarterbacks onto the shared line', () => {
    const projections = board();
    const cfg = flexLeague([
        'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'BN', 'BN',
    ]);
    const ctx = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });
    assert.equal(ctx.replacementPpg.QB, ctx.replacementPpg.RB, 'superflex makes QBs flex-eligible');
});

test('IDP slots are detected so the app can say it cannot value them', () => {
    // Sleeper publishes no projections for individual defensive players, so an
    // IDP league sees starting slots nothing can fill. That is a real
    // limitation and the only honest thing to do is say so -- which requires
    // noticing it first.
    const idp = normalizeLeague({
        settings: { num_teams: 12 },
        scoring_settings: { rec: 0.5 },
        roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DL', 'LB', 'DB', 'K', 'DEF', 'BN'],
    });
    assert.equal(idp.hasIdp, true);
    // IDP slots must not be counted as startable at a position we DO value, or
    // every replacement level in the league shifts to cover players that were
    // never in the pool.
    assert.equal(idp.startersByPos.DEF, 1, 'the team defense is not an IDP slot');

    const plain = normalizeLeague({
        settings: { num_teams: 12 },
        scoring_settings: { rec: 0.5 },
        roster_positions: defaultRosterPositions(),
    });
    assert.equal(plain.hasIdp, false);
});
