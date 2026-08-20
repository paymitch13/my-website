import test from 'node:test';
import assert from 'node:assert/strict';

import { optimizeLineup, marginalValue, positionalReport } from '../js/lineup.js';
import { simulateSeason, buildSchedule, syntheticSchedule, scheduleStrength } from '../js/sim.js';

const p = (id, pos, score) => ({ player: { id, name: id, pos }, score });

const STD = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];

test('optimizer starts the best legal combination', () => {
    const roster = [
        p('qb1', 'QB', 22), p('qb2', 'QB', 18),
        p('rb1', 'RB', 20), p('rb2', 'RB', 14), p('rb3', 'RB', 12),
        p('wr1', 'WR', 19), p('wr2', 'WR', 16), p('wr3', 'WR', 15),
        p('te1', 'TE', 10),
        p('k1', 'K', 8), p('def1', 'DEF', 7),
    ];
    const out = optimizeLineup(roster, STD);
    const started = out.starters.map((s) => s.entry.player.id);
    assert.ok(started.includes('qb1') && !started.includes('qb2'), 'only one QB starts');
    // FLEX should take wr3 (15), the best remaining flex-eligible player.
    assert.ok(started.includes('wr3'), 'flex takes the best leftover');
    assert.ok(!started.includes('rb3'), 'rb3 (12) loses the flex to wr3 (15)');
    assert.equal(out.points, 22 + 20 + 14 + 19 + 16 + 10 + 15 + 8 + 7);
});

test('superflex starts a second quarterback when he outscores the flex option', () => {
    const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX'];
    const roster = [
        p('qb1', 'QB', 24), p('qb2', 'QB', 19),
        p('rb1', 'RB', 16), p('rb2', 'RB', 13), p('rb3', 'RB', 9),
        p('wr1', 'WR', 17), p('wr2', 'WR', 15), p('wr3', 'WR', 11), p('wr4', 'WR', 10),
        p('te1', 'TE', 9),
    ];
    const started = optimizeLineup(roster, slots).starters.map((s) => s.entry.player.id);
    assert.ok(started.includes('qb2'), 'QB2 (19) belongs in the superflex over WR3 (11)');
});

test('optimizer leaves slots empty rather than starting an ineligible player', () => {
    const out = optimizeLineup([p('wr1', 'WR', 12)], ['QB', 'WR', 'K']);
    assert.equal(out.starters.length, 1);
    assert.deepEqual(out.emptySlots.sort(), ['K', 'QB']);
    assert.equal(out.points, 12);
});

test('optimizer handles crossing eligibility (WRRB_FLEX + REC_FLEX)', () => {
    // Non-nested slots are where naive greedy misplaces players.
    const slots = ['WRRB_FLEX', 'REC_FLEX'];
    const roster = [p('rb1', 'RB', 20), p('te1', 'TE', 15)];
    const out = optimizeLineup(roster, slots);
    assert.equal(out.points, 35, 'RB must take W/R and TE must take W/T');
    assert.equal(out.starters.length, 2);
});

test('marginal value collapses when a position is already stacked', () => {
    const stacked = [
        p('qb1', 'QB', 22),
        p('rb1', 'RB', 20), p('rb2', 'RB', 18),
        p('wr1', 'WR', 21), p('wr2', 'WR', 20), p('wr3', 'WR', 19), p('wr4', 'WR', 18),
        p('te1', 'TE', 11), p('k1', 'K', 8), p('def1', 'DEF', 7),
    ];
    const thin = [
        p('qb1', 'QB', 22),
        p('rb1', 'RB', 20), p('rb2', 'RB', 18),
        p('wr1', 'WR', 21), p('wr2', 'WR', 8), p('wr3', 'WR', 5),
        p('te1', 'TE', 11), p('k1', 'K', 8), p('def1', 'DEF', 7),
    ];
    const target = p('newWr', 'WR', 17);
    const gainStacked = marginalValue(stacked, STD, target);
    const gainThin = marginalValue(thin, STD, target);
    assert.equal(gainStacked, 0, 'a WR17 adds nothing behind four better receivers');
    assert.ok(gainThin > 8, `same player is worth real points to a thin team (${gainThin})`);
});

test('positional report exposes single-player dependence', () => {
    const roster = [
        p('qb1', 'QB', 24), p('qb2', 'QB', 9),
        p('rb1', 'RB', 20), p('rb2', 'RB', 18), p('rb3', 'RB', 16),
        p('wr1', 'WR', 18), p('wr2', 'WR', 16), p('wr3', 'WR', 14),
        p('te1', 'TE', 10), p('k1', 'K', 8), p('def1', 'DEF', 7),
    ];
    const rep = positionalReport(roster, STD);
    // QB has no replacement (24 -> 9); RB slides everyone up one slot (20 -> 14).
    assert.ok(rep.byPosition.QB.dropoff > 14, 'losing the only good QB is catastrophic');
    assert.ok(
        rep.byPosition.RB.dropoff < rep.byPosition.QB.dropoff / 2,
        `deep RB room absorbs the loss (RB ${rep.byPosition.RB.dropoff} vs QB ${rep.byPosition.QB.dropoff})`
    );
    assert.equal(rep.byPosition.RB.starting, 3, 'two RB slots plus the flex');
});

test('simulator: a stronger team wins more and makes playoffs more often', () => {
    const teams = [
        { rosterId: 1, wins: 0, losses: 0, pointsFor: 0, mu: 130, sigma: 25 },
        { rosterId: 2, wins: 0, losses: 0, pointsFor: 0, mu: 100, sigma: 25 },
        { rosterId: 3, wins: 0, losses: 0, pointsFor: 0, mu: 115, sigma: 25 },
        { rosterId: 4, wins: 0, losses: 0, pointsFor: 0, mu: 95, sigma: 25 },
    ];
    const schedule = syntheticSchedule([1, 2, 3, 4], 1, 12);
    const res = simulateSeason(teams, schedule, { iterations: 1200, playoffTeams: 2 });
    const by = new Map(res.map((r) => [r.rosterId, r]));
    assert.ok(by.get(1).projectedWins > by.get(3).projectedWins);
    assert.ok(by.get(3).projectedWins > by.get(2).projectedWins);
    assert.ok(by.get(1).playoffOdds > by.get(4).playoffOdds + 0.4);
    const totalTitle = res.reduce((a, r) => a + r.titleOdds, 0);
    assert.ok(Math.abs(totalTitle - 1) < 1e-9, `title odds must sum to 1, got ${totalTitle}`);
});

test('simulator: playoff odds sum to the number of playoff spots', () => {
    const teams = Array.from({ length: 12 }, (_, i) => ({
        rosterId: i + 1, wins: 0, losses: 0, pointsFor: 0, mu: 100 + i * 3, sigma: 24,
    }));
    const schedule = syntheticSchedule(teams.map((t) => t.rosterId), 1, 13);
    const res = simulateSeason(teams, schedule, { iterations: 800, playoffTeams: 6 });
    const total = res.reduce((a, r) => a + r.playoffOdds, 0);
    assert.ok(Math.abs(total - 6) < 1e-9, `expected 6.0, got ${total}`);
});

test('simulator is deterministic for a given seed', () => {
    const teams = Array.from({ length: 6 }, (_, i) => ({
        rosterId: i + 1, wins: 1, losses: 1, pointsFor: 200, mu: 100 + i * 4, sigma: 22,
    }));
    const sched = syntheticSchedule([1, 2, 3, 4, 5, 6], 3, 10);
    const a = simulateSeason(teams, sched, { iterations: 300, playoffTeams: 4, seed: 7 });
    const b = simulateSeason(teams, sched, { iterations: 300, playoffTeams: 4, seed: 7 });
    assert.deepEqual(a, b);
});

test('existing record carries into the projection', () => {
    const base = { losses: 0, pointsFor: 900, mu: 110, sigma: 24 };
    const teams = [
        { rosterId: 1, wins: 6, ...base },
        { rosterId: 2, wins: 0, ...base },
        { rosterId: 3, wins: 3, ...base },
        { rosterId: 4, wins: 3, ...base },
    ];
    const res = simulateSeason(teams, syntheticSchedule([1, 2, 3, 4], 7, 13), {
        iterations: 900, playoffTeams: 2,
    });
    const by = new Map(res.map((r) => [r.rosterId, r]));
    assert.ok(by.get(1).playoffOdds > by.get(2).playoffOdds + 0.5, 'a 6-0 start matters');
});

test('buildSchedule pairs rosters by matchup id and skips unplayed weeks', () => {
    const weeks = new Map([
        [5, [
            { matchup_id: 1, roster_id: 1 }, { matchup_id: 1, roster_id: 2 },
            { matchup_id: 2, roster_id: 3 }, { matchup_id: 2, roster_id: 4 },
        ]],
        [6, []],
        [7, [{ matchup_id: 1, roster_id: 1 }, { matchup_id: 1, roster_id: 3 }]],
    ]);
    const sched = buildSchedule(weeks, 5, 7);
    assert.equal(sched.length, 2);
    assert.deepEqual(sched[0].pairs.sort(), [[1, 2], [3, 4]]);
    assert.deepEqual(sched[1].pairs, [[1, 3]]);
});

test('schedule strength ranks the hardest slate correctly', () => {
    const teams = [
        { rosterId: 1, mu: 100 }, { rosterId: 2, mu: 100 },
        { rosterId: 3, mu: 140 }, { rosterId: 4, mu: 60 },
    ];
    const sched = [{ week: 1, pairs: [[1, 3], [2, 4]] }, { week: 2, pairs: [[1, 3], [2, 4]] }];
    const ss = scheduleStrength(teams, sched);
    assert.ok(ss.get(1).relative > 0, 'team 1 faces the juggernaut twice');
    assert.ok(ss.get(2).relative < 0, 'team 2 gets the doormat twice');
});
