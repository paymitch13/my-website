// Roster-slot interpretation: which positions can start where, and everything
// the app derives from it.
//
// This is load-bearing for every number in the product. A league with two
// flexes and no dedicated tight end slot prices tight ends completely
// differently from one with a TE slot, and both the reading of the slot names
// and the consequences used to be wrong in ways nothing surfaced.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeLeague,
    inferSlotEligibility,
    hasDedicatedSlot,
    slotEligibility,
    flexGroups,
    replacementRanks,
    SLOT_ELIGIBILITY,
} from '../js/league.js';
import { optimizeLineup, positionalReport } from '../js/lineup.js';
import {
    rosterNeeds,
    leagueAverages,
    leaguePerSlotAverages,
    leagueBestAverages,
    leagueWeakStarterAverages,
    NEED_POSITIONS,
} from '../js/needs.js';

const league = (roster, extra = {}) =>
    normalizeLeague({
        settings: { num_teams: 12, playoff_teams: 6, playoff_week_start: 15, ...extra },
        scoring_settings: { rec: 0.5, rec_yd: 0.1, rush_yd: 0.1 },
        roster_positions: roster,
    });

// The shape the user reported: a RB/WR/TE flex and a WR/TE flex, no dedicated
// tight end slot anywhere.
const TWO_FLEX = ['QB', 'RB', 'RB', 'WR', 'WR', 'FLEX', 'REC_FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const STANDARD = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

const mk = (id, pos, score) => ({ player: { id, pos, name: `${pos}${id}` }, points: score, score, value: score * 10 });

// --- Reading slot names ----------------------------------------------------

test('position tokens are read out of an unfamiliar slot name', () => {
    assert.deepEqual(inferSlotEligibility('TE_WR_FLEX'), ['WR', 'TE']);
    assert.deepEqual(inferSlotEligibility('TE_RB_WR_FLEX'), ['RB', 'WR', 'TE']);
    assert.deepEqual(inferSlotEligibility('FLEX_RB_WR'), ['RB', 'WR']);
    assert.deepEqual(inferSlotEligibility('QB/RB/WR/TE'), ['QB', 'RB', 'WR', 'TE']);
});

test('a superflex is read as quarterback-eligible however it is spelled', () => {
    assert.deepEqual(inferSlotEligibility('SUPERFLEX'), ['QB', 'RB', 'WR', 'TE']);
    assert.deepEqual(inferSlotEligibility('OP_SUPER_FLEX'), ['QB', 'RB', 'WR', 'TE']);
});

test('a longer token is never mistaken for a shorter one inside it', () => {
    // DEF contains no position token but D and E; DST must not read as a TE.
    assert.deepEqual(inferSlotEligibility('DST'), ['DEF']);
    assert.deepEqual(inferSlotEligibility('DEF'), ['DEF']);
});

test('single-letter conventions are understood', () => {
    assert.deepEqual(inferSlotEligibility('W/R/T'), ['RB', 'WR', 'TE']);
    assert.deepEqual(inferSlotEligibility('Q/W/R/T'), ['QB', 'RB', 'WR', 'TE']);
});

test('a name with nothing positional in it is reported, not guessed at', () => {
    assert.equal(inferSlotEligibility('MYSTERY'), null);
    assert.equal(inferSlotEligibility(''), null);
    assert.equal(inferSlotEligibility(null), null);
});

test('an uninterpretable starting slot is surfaced rather than dropped', () => {
    const cfg = league(['QB', 'RB', 'WR', 'ZZZ', 'K', 'DEF', 'BN']);
    assert.deepEqual(cfg.unreadableSlots, ['ZZZ']);
    assert.deepEqual(cfg.slotPositions.ZZZ, []);
    // And it is still listed, so the League tab can say so.
    assert.ok(cfg.starterSlots.includes('ZZZ'));
});

test('every slot the app starts is accounted for in slotPositions', () => {
    const cfg = league(TWO_FLEX);
    for (const slot of cfg.starterSlots) {
        assert.ok(slot in cfg.slotPositions, `${slot} missing from slotPositions`);
    }
    assert.deepEqual(cfg.unreadableSlots, []);
    assert.deepEqual(cfg.slotPositions.REC_FLEX, ['WR', 'TE']);
    assert.deepEqual(cfg.slotPositions.FLEX, ['RB', 'WR', 'TE']);
});

test('a renamed flex fills its slot in the lineup', () => {
    const cfg = league(['QB', 'RB', 'RB', 'WR', 'WR', 'TE_RB_WR_FLEX', 'TE_WR_FLEX', 'K', 'DEF', 'BN']);
    const roster = [
        mk('1', 'QB', 20), mk('2', 'RB', 16), mk('3', 'RB', 13), mk('4', 'RB', 11),
        mk('5', 'WR', 17), mk('6', 'WR', 14), mk('7', 'WR', 12),
        mk('8', 'K', 8), mk('9', 'DEF', 7),
    ];
    const lineup = optimizeLineup(roster, cfg.starterSlots);
    const empty = lineup.slots.filter((s) => !s.entry);
    assert.deepEqual(empty, [], 'a renamed flex must not sit empty forever');
    // Best nine: 20+16+13+17+14 in the fixed slots, then the two best spares.
    assert.equal(lineup.points, 20 + 16 + 13 + 17 + 14 + 12 + 11 + 8 + 7);
});

// --- Required versus flex-only --------------------------------------------

test('a position is only required when some slot exclusively takes it', () => {
    const twoFlex = league(TWO_FLEX);
    assert.equal(hasDedicatedSlot(twoFlex, 'TE'), false, 'no TE slot means TE is not required');
    assert.equal(hasDedicatedSlot(twoFlex, 'RB'), true);
    assert.equal(hasDedicatedSlot(twoFlex, 'QB'), true);

    const standard = league(STANDARD);
    assert.equal(hasDedicatedSlot(standard, 'TE'), true);
});

test('a renamed flex does not make its positions required', () => {
    const cfg = league(['QB', 'RB', 'WR', 'TE_WR_FLEX', 'K', 'DEF', 'BN']);
    assert.equal(hasDedicatedSlot(cfg, 'TE'), false);
    assert.deepEqual(slotEligibility(cfg, 'TE_WR_FLEX'), ['WR', 'TE']);
});

// --- Flex groups -----------------------------------------------------------

const groupFor = (cfg, pos) => flexGroups(cfg).find((g) => g.positions.includes(pos));

test('two flexes pool the same positions as one', () => {
    const g = groupFor(league(TWO_FLEX), 'TE');
    assert.deepEqual(g.positions.sort(), ['RB', 'TE', 'WR']);
    // 2 RB + 2 WR + 2 flex.
    assert.equal(g.startersPerTeam, 6);
});

test('renaming the flexes does not switch the pooling off', () => {
    const named = groupFor(league(TWO_FLEX), 'TE');
    const renamed = groupFor(
        league(['QB', 'RB', 'RB', 'WR', 'WR', 'TE_RB_WR_FLEX', 'TE_WR_FLEX', 'K', 'DEF', 'BN']),
        'TE'
    );
    assert.deepEqual(renamed.positions.sort(), named.positions.sort());
    assert.equal(renamed.startersPerTeam, named.startersPerTeam);
});

test('a league with no flex gives every position its own group', () => {
    const cfg = league(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'DEF', 'BN']);
    for (const g of flexGroups(cfg)) {
        assert.equal(g.positions.length, 1, `${g.positions} should not be pooled without a flex`);
    }
});

// --- Replacement ranks -----------------------------------------------------

test('replacement ranks stay positional ranks', () => {
    // They index a position's own curve, so they must not be swapped for a
    // pooled group depth: the group's line is applied in valuation.js, where
    // it is read off the combined board it actually belongs to.
    const cfg = league(TWO_FLEX);
    const ranks = replacementRanks(cfg);
    for (const [pos, rank] of Object.entries(ranks)) {
        assert.ok(rank >= 1, `${pos} rank must be at least 1`);
        assert.ok(
            rank <= cfg.teams * 4,
            `${pos} rank ${rank} is deeper than four rounds of this position league-wide`
        );
    }
    // A position startable only through flexes is shallower on its own board
    // than one with two dedicated slots.
    assert.ok(ranks.TE < ranks.RB);
});

// --- The hole that was not there ------------------------------------------

test('a team that legally starts no tight end is not told it has a hole', () => {
    const cfg = league(TWO_FLEX);

    // Eleven teams that each start a tight end in a flex.
    const withTe = () => [
        mk('a', 'QB', 20), mk('b', 'RB', 16), mk('c', 'RB', 13), mk('d', 'RB', 9),
        mk('e', 'WR', 17), mk('f', 'WR', 14), mk('g', 'WR', 8),
        mk('h', 'TE', 12), mk('i', 'TE', 5),
        mk('j', 'K', 8), mk('k', 'DEF', 7),
    ];
    // One that owns none and fills both flexes with a back and a receiver.
    const withoutTe = () => [
        mk('a', 'QB', 20), mk('b', 'RB', 16), mk('c', 'RB', 13), mk('d', 'RB', 12),
        mk('e', 'WR', 17), mk('f', 'WR', 14), mk('g', 'WR', 12), mk('l', 'WR', 9),
        mk('j', 'K', 8), mk('k', 'DEF', 7),
    ];

    const rosters = [];
    for (let i = 0; i < 11; i++) rosters.push(withTe());
    rosters.push(withoutTe());

    const reports = rosters.map((entries, i) => ({
        rosterId: i + 1,
        report: positionalReport(entries, cfg.starterSlots, NEED_POSITIONS),
    }));
    const opts = {
        perSlotAvg: leaguePerSlotAverages(reports),
        bestAvg: leagueBestAverages(reports),
        weakAvg: leagueWeakStarterAverages(reports),
        cfg,
    };
    const avgByPos = leagueAverages(reports);

    const teless = reports[11];
    // The premise: his lineup is not worse for having no tight end.
    assert.ok(
        teless.report.lineup.points > reports[0].report.lineup.points,
        'fixture must have the TE-less roster scoring at least as well'
    );
    assert.equal(teless.report.byPosition.TE.starting, 0);

    const needs = rosterNeeds(teless.report, avgByPos, NEED_POSITIONS, opts);
    assert.equal(needs.TE.deficit, 0, 'a position the league never requires cannot be a deficit');
    // And it must not be the biggest thing wrong with the roster either.
    const worst = Object.values(needs).sort((a, b) => b.deficit - a.deficit)[0];
    assert.notEqual(worst.pos, 'TE');
});

test('an empty REQUIRED slot is still a hole', () => {
    const cfg = league(STANDARD);
    const roster = [
        mk('a', 'QB', 20), mk('b', 'RB', 16), mk('c', 'RB', 13), mk('d', 'RB', 9),
        mk('e', 'WR', 17), mk('f', 'WR', 14), mk('g', 'WR', 8),
        mk('j', 'K', 8), mk('k', 'DEF', 7),
    ];
    const report = positionalReport(roster, cfg.starterSlots, NEED_POSITIONS);
    assert.equal(report.byPosition.TE.starting, 0);

    const needs = rosterNeeds(report, { TE: 11 }, NEED_POSITIONS, { cfg });
    assert.ok(
        needs.TE.deficit > 0,
        'a league that forces a tight end into the lineup must report the empty slot'
    );
});

test('without a league shape the old behaviour is unchanged', () => {
    // rosterNeeds is called from tests and tools without a cfg; it must not
    // start silently zeroing deficits when it cannot tell what is required.
    const report = { byPosition: { TE: { startingPoints: 0, starting: 0, count: 0, benchDepth: 0, dropoff: 0 } } };
    const needs = rosterNeeds(report, { TE: 11 }, ['TE']);
    assert.equal(needs.TE.deficit, 11);
});

// --- The eligibility table and the inference must not disagree ------------

test('inference never contradicts the table it falls back from', () => {
    // Names like FLEX, REC_FLEX and IDP_FLEX carry no position tokens, so
    // inference declines them and the table answers. Anywhere it does answer,
    // it must agree: a disagreement means the same league would be priced two
    // different ways depending on which path ran.
    for (const [slot, expected] of Object.entries(SLOT_ELIGIBILITY)) {
        const inferred = inferSlotEligibility(slot);
        if (!inferred) continue;
        assert.deepEqual(inferred, expected, `${slot}: table says ${expected}, inference says ${inferred}`);
    }
});

test('an ordinary word is never mistaken for a roster slot', () => {
    // Substring matching used to read a tight end out of any name containing
    // "te" and a kicker out of any name containing "k".
    for (const word of ['MYSTERY', 'STARTER', 'BACKUP', 'TAXI', 'UTIL', 'BENCH', 'ROTATE', 'TEAM', 'LATE']) {
        assert.equal(inferSlotEligibility(word), null, `${word} must not read as a roster slot`);
    }
});

test('a concatenated flex name still decomposes', () => {
    assert.deepEqual(inferSlotEligibility('TEWRFLEX'), ['WR', 'TE']);
    assert.deepEqual(inferSlotEligibility('WR/TE'), ['WR', 'TE']);
    assert.deepEqual(inferSlotEligibility('FLEX_RB_WR_TE'), ['RB', 'WR', 'TE']);
});
