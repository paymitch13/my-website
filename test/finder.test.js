import test from 'node:test';
import assert from 'node:assert/strict';

import { findTrades, postureOf, acceptanceNote } from '../js/finder.js';
import { createValuationContext } from '../js/valuation.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { syntheticSchedule } from '../js/sim.js';

const cfg = normalizeLeague({
    settings: { num_teams: 10, playoff_teams: 4, playoff_week_start: 15 },
    scoring_settings: { rush_yd: 0.1, rec_yd: 0.1, rec: 0.5 },
    roster_positions: defaultRosterPositions(),
});

// A projection pool so the neutral board has something to work from.
const projections = {};
function project(id, pos, ppg) {
    projections[id] = { id, pos, games: 17, stats: { rush_yd: ppg * 170 }, ptsHalfPpr: 1 };
}

let uid = 0;
const mk = (pos, ppg) => {
    const id = `p${++uid}`;
    project(id, pos, ppg);
    return { id, name: `${pos}-${ppg}`, pos, team: 'KC', age: 26, injury: null };
};

/** Team A: stacked at RB, threadbare at WR. Team B: the mirror image. */
function buildLeague() {
    const rankings = new Map();
    const teams = [];

    const add = (rosterId, name, spec) => {
        const players = spec.map(([pos, ppg]) => mk(pos, ppg));
        players.forEach((p) => rankings.set(p.id, 1));
        teams.push({ rosterId, ownerId: `o${rosterId}`, name, players, wins: 3, losses: 3, ties: 0, pointsFor: 700 });
    };

    add(1, 'RB Rich', [
        ['QB', 18], ['RB', 17], ['RB', 15], ['RB', 14], ['RB', 13],
        ['WR', 6], ['WR', 5], ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    add(2, 'WR Rich', [
        ['QB', 17], ['WR', 17], ['WR', 15], ['WR', 14], ['WR', 13],
        ['RB', 6], ['RB', 5], ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    for (let i = 3; i <= 8; i++) {
        add(i, `Team ${i}`, [
            ['QB', 15], ['RB', 11], ['RB', 10], ['WR', 11], ['WR', 10],
            ['TE', 7], ['K', 6], ['DEF', 6], ['RB', 5], ['WR', 5],
        ]);
    }

    // Rank everyone by projected points so the user's board is sane.
    const byPos = {};
    for (const t of teams) for (const p of t.players) (byPos[p.pos] ||= []).push(p);
    for (const list of Object.values(byPos)) {
        list.sort((a, b) => projections[b.id].stats.rush_yd - projections[a.id].stats.rush_yd);
        list.forEach((p, i) => rankings.set(p.id, i + 1));
    }
    return { teams, rankings };
}

test('the funnel finds the mirror-image swap both sides want', async () => {
    const { teams, rankings } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 7, 14),
        iterations: 200, limits: { stage2Keep: 20, stage3Keep: 4 },
    });

    assert.equal(res.ok, true);
    assert.ok(res.trades.length > 0, 'should find at least one trade');

    // The obvious deal is sending a surplus RB to the WR-rich team for a WR.
    const withTeam2 = res.trades.find((t) => t.other.rosterId === 2);
    assert.ok(withTeam2, 'the mirror-image partner should surface');
    assert.equal(withTeam2.give.player.pos, 'RB');
    assert.equal(withTeam2.get.player.pos, 'WR');
});

test('every suggested trade improves BOTH lineups', async () => {
    const { teams, rankings } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 7, 14),
        iterations: 150, limits: { stage2Keep: 15, stage3Keep: 5 },
    });
    for (const t of res.trades) {
        assert.ok(t.myGain > 0, `my gain must be positive, got ${t.myGain}`);
        assert.ok(t.theirGain > 0, `their gain must be positive, got ${t.theirGain}`);
    }
});

test('the counterparty is valued neutrally, not on the user’s board', async () => {
    const { teams, rankings } = buildLeague();
    // Sabotage the user's board: rank every opposing WR as worthless.
    for (const p of teams[1].players) if (p.pos === 'WR') rankings.set(p.id, 400);

    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 7, 14),
        iterations: 150, limits: { stage2Keep: 15, stage3Keep: 4 },
    });

    // Their gain is computed on the neutral board, so trashing them on MY board
    // must not make them look thrilled to give their receivers away.
    for (const t of res.trades.filter((x) => x.other.rosterId === 2)) {
        assert.ok(t.theirGain > 0, 'their side is still evaluated on its own terms');
        assert.ok(
            t.get.value > 0,
            'the WR I am acquiring still carries neutral value despite my ranking'
        );
    }
});

test('teams with nothing to offer each other are filtered out in stage 1', async () => {
    const rankings = new Map();
    const same = (rosterId) => {
        const players = [
            ['QB', 15], ['RB', 11], ['RB', 10], ['WR', 11], ['WR', 10],
            ['TE', 7], ['K', 6], ['DEF', 6],
        ].map(([pos, ppg]) => mk(pos, ppg));
        players.forEach((p, i) => rankings.set(p.id, i + 1));
        return { rosterId, name: `T${rosterId}`, players, wins: 3, losses: 3, ties: 0, pointsFor: 700 };
    };
    const teams = [1, 2, 3, 4].map(same);
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        schedule: syntheticSchedule([1, 2, 3, 4], 7, 14), iterations: 100,
    });
    assert.equal(res.ok, true);
    // Identical rosters have no complementary need, so the funnel empties early.
    assert.equal(res.trades.length, 0);
});

test('posture reads playoff odds the way a manager would', () => {
    assert.equal(postureOf(0.05).kind, 'seller');
    assert.equal(postureOf(0.92).kind, 'buyer');
    assert.equal(postureOf(0.5).kind, 'bubble');
    assert.equal(postureOf(null), null);
    assert.match(postureOf(0.05).detail, /trading away win-now/);
});

test('the acceptance note is framed from their side', () => {
    const note = acceptanceNote({ theirGain: 2.1, theirPlayoffDelta: 0.06 }, 'Backfield Bandits');
    assert.match(note, /Backfield Bandits gain 2\.1 pts\/wk on neutral values/);
    assert.match(note, /\+6\.0% playoff odds/);
});

test('a trade that lowers my own odds is never recommended', async () => {
    const { teams, rankings } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 7, 14),
        iterations: 250, limits: { stage2Keep: 25, stage3Keep: 8 },
    });
    for (const t of res.trades) {
        if (t.myTitleDelta !== null) {
            assert.ok(t.myTitleDelta >= -0.0005, `title odds must not fall: ${t.myTitleDelta}`);
        }
        if (t.myPlayoffDelta !== null) {
            assert.ok(t.myPlayoffDelta >= -0.0005, `playoff odds must not fall: ${t.myPlayoffDelta}`);
        }
    }
    assert.ok(typeof res.rejected === 'number');
});
