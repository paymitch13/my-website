// Regressions from the code review. Each test names the wrong answer the bug
// produced, so a reintroduction is obvious rather than merely red.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProjections, blendedPpg, scoreStats } from '../js/projections.js';
import { ppgFor, specialistScale, weeklyPlayProbability, ruledOutThisWeek, availability } from '../js/valuation.js';
import { normalizeScoring, normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { buildDefenseProfiles } from '../js/matchup.js';
import { buildStartSitReport } from '../js/startsit.js';
import { simulateSeason, syntheticSchedule, DEFAULT_SIM_SEED } from '../js/sim.js';
import { fromCsv } from '../js/rankings.js';
import { evaluateRosterEntry, neutralEntry } from '../js/trade.js';
import { createValuationContext } from '../js/valuation.js';

const cfg = normalizeLeague({
    settings: { num_teams: 12 }, scoring_settings: { rec: 0.5 },
    roster_positions: defaultRosterPositions(),
});

// --- 1. Weekly vs rest-of-season availability ------------------------------

test('BUG: Out players were only discounted 7% in a weekly lineup', () => {
    // availability() is a season function and stays that way for trade value.
    const seasonDiscount = availability({ injury: 'Out' }, 14);
    assert.ok(seasonDiscount > 0.9, 'season-long discount is correctly small');
    // The weekly decision must be absolute.
    assert.equal(weeklyPlayProbability({ injury: 'Out' }), 0);
    assert.equal(ruledOutThisWeek({ injury: 'Out' }), true);
    assert.equal(ruledOutThisWeek({ injury: 'Doubtful' }), false);
    assert.ok(weeklyPlayProbability({ injury: 'Doubtful' }) < 0.4);
    assert.equal(weeklyPlayProbability({ injury: null }), 1);
});

// --- 2. Actual stats must not be repaired like projections -----------------

test('BUG: a defense in week 3 had its season total divided by 17', () => {
    const rows = [{
        player_id: 'd1', player: { position: 'DEF' },
        stats: { gp: 3, sack: 9, pts_half_ppr: 30 },
    }];
    const asProjection = normalizeProjections(rows);
    const asActual = normalizeProjections(rows, { kind: 'actual' });
    assert.equal(asProjection.d1.games, 17, 'a season projection saying gp:1 is mislabeled');
    assert.equal(asActual.d1.games, 3, 'actual games played must be trusted');

    const scoring = normalizeScoring({ sack: 1 });
    const ppg = scoreStats(asActual.d1.stats, scoring) / asActual.d1.games;
    assert.equal(ppg, 3, 'three sacks a game, not 0.5');
});

test('blended outlook uses real games played for actuals', () => {
    const scoring = normalizeScoring({ sack: 1 });
    const projection = normalizeProjections([{ player_id: 'd', player: { position: 'DEF' }, stats: { gp: 17, sack: 17, pts_half_ppr: 1 } }]).d;
    const actual = normalizeProjections(
        [{ player_id: 'd', player: { position: 'DEF' }, stats: { gp: 3, sack: 12, pts_half_ppr: 1 } }],
        { kind: 'actual' }
    ).d;
    // 4 sacks a game actual vs 1 projected: the blend must move upward.
    const blended = blendedPpg({ projection, actual, scoring, week: 4 });
    assert.ok(blended > 1.4, `expected the hot start to pull it up, got ${blended}`);
});

// --- 3. K and DEF must respond to league scoring ---------------------------

test('BUG: a league with double kicker scoring got identical kicker values', () => {
    const standard = normalizeScoring({ xpm: 1, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5 });
    const doubled = normalizeScoring({ xpm: 2, fgm_20_29: 6, fgm_30_39: 6, fgm_40_49: 8, fgm_50p: 10 });
    assert.ok(specialistScale('K', doubled) > 1.7, `scale ${specialistScale('K', doubled)}`);
    assert.ok(ppgFor('K', 5, doubled) > ppgFor('K', 5, standard) * 1.7);

    const richDef = normalizeScoring({ sack: 3, int: 6, fum_rec: 6, def_td: 6 });
    assert.ok(ppgFor('DEF', 5, richDef) > ppgFor('DEF', 5, normalizeScoring({ sack: 1, int: 2, fum_rec: 2, def_td: 6 })));
});

test('a league that scores no K/DST keys is left alone rather than zeroed', () => {
    assert.equal(specialistScale('K', normalizeScoring({ rec: 1 })), 1);
    assert.ok(ppgFor('K', 1, normalizeScoring({ rec: 1 })) > 0);
});

// --- 5/6. Matchup baselines ------------------------------------------------

test('BUG: defense baselines included the game being measured', () => {
    // One player, four games: three at 10 points, one at 20 against SOFT.
    // Leave-one-out makes the baseline 10, so the ratio is a clean 2.0.
    // Including the game itself would give 20/12.5 = 1.6, flattened toward 1.
    const weeks = new Map();
    const pts = [10, 10, 10, 20];
    const opps = ['A', 'B', 'C', 'SOFT'];
    pts.forEach((p, i) => {
        weeks.set(i + 1, [{ player_id: 'wr1', opponent: opps[i], player: { position: 'WR' }, stats: { rec_yd: p * 10 } }]);
    });
    const profiles = buildDefenseProfiles(weeks, normalizeScoring({ rec_yd: 0.1 }), { minSamples: 1 });
    const ratio = profiles.get('SOFT').WR.ratio;
    assert.ok(Math.abs(ratio - 2) < 0.01, `expected 2.0 with leave-one-out, got ${ratio}`);
});

// --- 7. Flex close calls ---------------------------------------------------

test('BUG: the flex decision was excluded from close calls by construction', () => {
    const ev = (id, pos, pts) => ({
        player: { id, name: id, pos, team: 'KC', injury: null },
        hasGame: true, ruledOut: false, adjusted: pts, baseProjection: pts,
        multiplier: 1, factors: [], opponent: 'OPP', confidence: { level: 'high' },
    });
    // The flex is held by a WR; a benched RB is 1.2 points behind him.
    const evaluations = [
        ev('qb1', 'QB', 22), ev('rb1', 'RB', 18), ev('rb2', 'RB', 15),
        ev('wr1', 'WR', 17), ev('wr2', 'WR', 16), ev('wr3', 'WR', 13),
        ev('rb3', 'RB', 11.8), ev('te1', 'TE', 9), ev('k1', 'K', 8), ev('def1', 'DEF', 7),
    ];
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations });
    const flexCall = rep.closeCalls.find((c) => c.crossPosition);
    assert.ok(flexCall, `expected a cross-position flex call, got ${JSON.stringify(rep.closeCalls.map((c) => `${c.sit.player.id}<${c.start.player.id}`))}`);
    assert.ok(flexCall.gap <= 2.5);
});

test('close calls are deduplicated across slots', () => {
    const ev = (id, pos, pts) => ({
        player: { id, name: id, pos, team: 'KC', injury: null },
        hasGame: true, ruledOut: false, adjusted: pts, baseProjection: pts,
        multiplier: 1, factors: [], opponent: 'OPP', confidence: { level: 'high' },
    });
    const rep = buildStartSitReport({
        team: { name: 'T' }, cfg,
        evaluations: [
            ev('qb1', 'QB', 20), ev('rb1', 'RB', 15), ev('rb2', 'RB', 14.5), ev('rb3', 'RB', 14),
            ev('wr1', 'WR', 15), ev('wr2', 'WR', 14.4), ev('wr3', 'WR', 14.2),
            ev('te1', 'TE', 9), ev('k1', 'K', 8), ev('def1', 'DEF', 7),
        ],
    });
    const keys = rep.closeCalls.map((c) => `${c.start.player.id}:${c.sit.player.id}`);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate pairs');
});

// --- 8. One seed across the app --------------------------------------------

test('BUG: Trade and Power used different seeds, so odds disagreed', () => {
    const teams = Array.from({ length: 8 }, (_, i) => ({
        rosterId: i + 1, wins: 3, losses: 3, ties: 0, pointsFor: 700,
        mu: 100 + i * 4, sigma: 24,
    }));
    const sched = syntheticSchedule(teams.map((t) => t.rosterId), 7, 13);
    const a = simulateSeason(teams, sched, { iterations: 300, playoffTeams: 4 });
    const b = simulateSeason(teams, sched, { iterations: 300, playoffTeams: 4, seed: DEFAULT_SIM_SEED });
    assert.deepEqual(a, b, 'the default seed must be the shared one');
});

// --- 10. Bracket byes ------------------------------------------------------

test('BUG: every playoff team got a first-round bye when the field was a power of two', () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({
        rosterId: i + 1, wins: 3, losses: 3, ties: 0, pointsFor: 700, mu: 110 - i, sigma: 20,
    }));
    for (const size of [4, 8]) {
        const teams = mk(12);
        const res = simulateSeason(teams, syntheticSchedule(teams.map((t) => t.rosterId), 7, 13), {
            iterations: 250, playoffTeams: size,
        });
        const totalBye = res.reduce((a, r) => a + r.byeOdds, 0);
        assert.ok(totalBye < 0.01, `a ${size}-team bracket has no byes, got ${totalBye}`);
    }
    // A 6-team field genuinely has two byes.
    const teams = mk(12);
    const six = simulateSeason(teams, syntheticSchedule(teams.map((t) => t.rosterId), 7, 13), {
        iterations: 250, playoffTeams: 6,
    });
    const total = six.reduce((a, r) => a + r.byeOdds, 0);
    assert.ok(Math.abs(total - 2) < 1e-9, `expected exactly 2 byes, got ${total}`);
});

// --- 9. CSV robustness -----------------------------------------------------

test('BUG: a ragged CSV row crashed the importer', () => {
    const players = {
        a: { id: 'a', name: 'Same Name', pos: 'RB', team: 'KC', searchRank: 1 },
        b: { id: 'b', name: 'Same Name', pos: 'WR', team: 'BUF', searchRank: 2 },
    };
    // Two players share a name, forcing the position lookup, and the row is
    // missing its position cell entirely.
    const csv = 'player,position\nSame Name\n';
    assert.doesNotThrow(() => fromCsv(csv, players));
    const parsed = fromCsv(csv, players);
    assert.equal(parsed.matched, 0, 'an ambiguous name with no position is unmatched, not a crash');
    assert.deepEqual(parsed.unmatched, ['Same Name']);
});

// --- Neutral counterparty valuation ---------------------------------------

test('the other manager does not share your board', () => {
    // You are personally low on a stud: you have him RB40, projections have him
    // near the top. Valuing HIS roster with YOUR board would claim his manager
    // will happily give him away.
    const projections = {};
    for (let i = 0; i < 40; i++) {
        projections[`rb${i}`] = {
            id: `rb${i}`, pos: 'RB', games: 17,
            stats: { rush_yd: (18 - 0.35 * i) * 170 }, ptsHalfPpr: 1,
        };
    }
    const league = normalizeLeague({
        settings: { num_teams: 12 }, scoring_settings: { rush_yd: 0.1 },
        roster_positions: defaultRosterPositions(),
    });
    const ctx = createValuationContext(league, { week: 5, weeksLeft: 10, projections });

    const stud = { id: 'rb1', name: 'Stud', pos: 'RB', age: 25, injury: null };
    const myRankings = new Map([['rb1', 40]]);

    const mine = evaluateRosterEntry(stud, myRankings, ctx);
    const theirs = neutralEntry(stud, ctx);

    assert.ok(theirs.value > mine.value * 2,
        `neutral value ${theirs.value} must far exceed my low ranking ${mine.value}`);
    assert.equal(theirs.posRank, 2, 'neutral rank comes from the projection curve');
    assert.equal(theirs.neutral, true);
});

test('neutral valuation falls back gracefully with no projection', () => {
    const league = normalizeLeague({
        settings: { num_teams: 12 }, scoring_settings: { rec: 0.5 },
        roster_positions: defaultRosterPositions(),
    });
    const ctx = createValuationContext(league, { week: 5, weeksLeft: 10 });
    const e = neutralEntry({ id: 'ghost', name: 'Ghost', pos: 'WR', age: 26 }, ctx);
    assert.ok(Number.isFinite(e.value));
});
