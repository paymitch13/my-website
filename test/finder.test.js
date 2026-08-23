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
//
// One pool PER FIXTURE, never a module-level one. The rank-to-points curve is
// built from whatever projections it is handed, so a shared pool makes each
// test's player values depend on how many players earlier tests happened to
// create: a fixture's "worst receiver in the league" silently becomes WR14 of
// fifty and prices like a starter. Tests that pass or fail based on their
// position in the file are worse than no tests.
let uid = 0;
function pool() {
    const projections = {};
    const mk = (pos, ppg) => {
        const id = `p${++uid}`;
        projections[id] = { id, pos, games: 17, stats: { rush_yd: ppg * 170 }, ptsHalfPpr: 1 };
        return { id, name: `${pos}-${ppg}`, pos, team: 'KC', age: 26, injury: null };
    };
    /** Rank every player against the rest of his position, best first. */
    const rank = (teams) => {
        const rankings = new Map();
        const byPos = {};
        for (const t of teams) for (const p of t.players) (byPos[p.pos] ||= []).push(p);
        for (const list of Object.values(byPos)) {
            list.sort((a, b) => projections[b.id].stats.rush_yd - projections[a.id].stats.rush_yd);
            list.forEach((p, i) => rankings.set(p.id, i + 1));
        }
        return rankings;
    };
    return { projections, mk, rank };
}

/** Team A: stacked at RB, threadbare at WR. Team B: the mirror image. */
function buildLeague() {
    const { projections, mk, rank } = pool();
    const teams = [];

    const add = (rosterId, name, spec) => {
        const players = spec.map(([pos, ppg]) => mk(pos, ppg));
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
    return { teams, rankings: rank(teams), projections };
}

test('the funnel finds the mirror-image swap both sides want', async () => {
    const { teams, rankings, projections } = buildLeague();
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
    const { teams, rankings, projections } = buildLeague();
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
    const { teams, rankings, projections } = buildLeague();
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
    const { projections, mk, rank } = pool();
    const same = (rosterId) => {
        const players = [
            ['QB', 15], ['RB', 11], ['RB', 10], ['WR', 11], ['WR', 10],
            ['TE', 7], ['K', 6], ['DEF', 6],
        ].map(([pos, ppg]) => mk(pos, ppg));
        return { rosterId, name: `T${rosterId}`, players, wins: 3, losses: 3, ties: 0, pointsFor: 700 };
    };
    const teams = [1, 2, 3, 4].map(same);
    const rankings = rank(teams);
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
    const { teams, rankings, projections } = buildLeague();
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

test('everything found is returned, not just the simulated few', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 7, 14),
        iterations: 120, limits: { stage2Keep: 50, stage3Keep: 3 },
    });
    // The invariant that matters: nothing found is thrown away. Everything that
    // survived the lineup solve is either fully simulated and ranked, or listed
    // as also-possible -- reporting "9 found" and rendering one was the bug.
    assert.ok(res.trades.length <= 3, 'only the top slice gets simulated');
    assert.equal(
        res.trades.length + res.others.length,
        res.shortlisted,
        `every shortlisted candidate must be returned (${res.trades.length} + ${res.others.length} != ${res.shortlisted})`
    );
    for (const o of res.others) assert.ok(o.reason === 'not-simulated' || o.reason === 'lowers-odds');
});

test('lopsided offers can be included on request', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const strict = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, iterations: 100,
        limits: { stage2Keep: 60, stage3Keep: 2 },
    });
    const loose = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, iterations: 100,
        requireMutualGain: false, limits: { stage2Keep: 60, stage3Keep: 2 },
    });
    const strictTotal = strict.trades.length + strict.others.length;
    const looseTotal = loose.trades.length + loose.others.length;
    assert.ok(looseTotal >= strictTotal, `loose ${looseTotal} should not be fewer than strict ${strictTotal}`);
    // Even loose, I must always gain.
    for (const t of [...loose.trades, ...loose.others]) assert.ok(t.myGain > 0);
});

test('the same pair of players is never listed twice', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, iterations: 100,
        limits: { stage2Keep: 80, stage3Keep: 5 },
    });
    // Identity is the whole package, not its headline player: "my RB2 for your
    // WR1" and "my RB2 plus my TE for your WR1" are different offers.
    const ids = (side) => side.map((e) => e.player.id).sort().join('+');
    const keys = [...res.trades, ...res.others].map((t) => `${t.other.rosterId}:${ids(t.gives)}>${ids(t.gets)}`);
    assert.equal(new Set(keys).size, keys.length);
});

test('consolidation trades are produced, not just one-for-ones', async () => {
    // A roster with several mid backs and a thin receiver room, against one
    // holding an elite receiver. The deal that wins leagues is two of mine for
    // one of theirs, and the search could not produce it at all.
    const { projections, mk, rank } = pool();
    const teams = [];
    const add = (rosterId, name, spec) => {
        const players = spec.map(([pos, ppg]) => mk(pos, ppg));
        teams.push({ rosterId, name, players, wins: 3, losses: 3, ties: 0, pointsFor: 700 });
    };
    add(1, 'Depth', [
        ['QB', 18], ['RB', 15], ['RB', 14.5], ['RB', 14], ['RB', 13.5],
        ['WR', 7], ['WR', 6], ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    add(2, 'Star', [
        ['QB', 17], ['WR', 24], ['WR', 8], ['WR', 7], ['RB', 8],
        ['RB', 7], ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    for (let i = 3; i <= 6; i++) {
        add(i, `T${i}`, [['QB', 15], ['RB', 11], ['RB', 10], ['WR', 11], ['WR', 10], ['TE', 7], ['K', 6], ['DEF', 6]]);
    }
    const rankings = rank(teams);
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        requireMutualGain: false, iterations: 100,
        limits: { stage2Keep: 200, stage3Keep: 4 },
    });

    const all = [...res.trades, ...res.others];
    const twoForOne = all.find((t) => t.gives.length === 2 && t.gets.length === 1);
    assert.ok(twoForOne, 'the funnel must be able to propose a two-for-one');
    assert.ok(twoForOne.myGain > 0);
});

test('same-position trades are allowed', async () => {
    // Two mediocre receiver rooms, one of which contains a genuine WR1. I have
    // four interchangeable nines and no ceiling; they have a twenty-four and
    // two spares. Both of us are below average per slot, so a surplus-only
    // stage 1 sees two teams with nothing to sell each other -- and the most
    // ordinary trade in fantasy never gets proposed.
    const { projections, mk, rank } = pool();
    const teams = [];
    const add = (rosterId, name, spec) => {
        const players = spec.map(([pos, ppg]) => mk(pos, ppg));
        teams.push({ rosterId, name, players, wins: 3, losses: 3, ties: 0, pointsFor: 700 });
    };
    add(1, 'Flat', [
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 11],
        ['WR', 9], ['WR', 9], ['WR', 9], ['WR', 9],
        ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    add(2, 'Top Heavy', [
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 6],
        ['WR', 24], ['WR', 5], ['WR', 4],
        ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    for (let i = 3; i <= 8; i++) {
        add(i, `Team ${i}`, [
            ['QB', 16], ['RB', 12], ['RB', 11], ['WR', 15], ['WR', 13], ['WR', 12],
            ['TE', 8], ['K', 6], ['DEF', 6],
        ]);
    }

    const rankings = rank(teams);
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        requireMutualGain: false, iterations: 80,
        limits: { stage2Keep: 200, stage3Keep: 2 },
    });
    const all = [...res.trades, ...res.others];
    const samePos = all.find(
        (t) => t.gives.every((e) => e.player.pos === 'WR') && t.gets.every((e) => e.player.pos === 'WR')
    );
    assert.ok(samePos, 'my WR3 for your WR1 is the most ordinary trade there is');
    assert.equal(samePos.other.rosterId, 2);
    assert.ok(samePos.myGain > 0);
});

test('the best roster in the league still gets suggestions', async () => {
    // Above average at every position, so short of nothing, so -- with need
    // measured only against the league -- the finder had nothing to pair and
    // told the team most able to make a deal that no deal existed. Every roster
    // is weakest at SOMETHING by its own standards, and that is what
    // consolidation trades are made of.
    const { projections, mk, rank } = pool();
    const teams = [];
    const add = (rosterId, name, spec) => {
        const players = spec.map(([pos, ppg]) => mk(pos, ppg));
        teams.push({ rosterId, name, players, wins: 5, losses: 1, ties: 0, pointsFor: 900 });
    };
    add(1, 'Juggernaut', [
        ['QB', 19], ['RB', 16], ['RB', 15], ['RB', 13], ['WR', 16], ['WR', 15], ['WR', 14],
        ['TE', 11], ['K', 8], ['DEF', 8],
    ]);
    // One rival owns a genuine stud back and is threadbare everywhere else --
    // the deal is right there, and the juggernaut used to be told it wasn't.
    add(2, 'One Star', [
        ['QB', 13], ['RB', 21], ['RB', 7], ['RB', 6], ['WR', 9], ['WR', 8], ['WR', 7],
        ['TE', 6], ['K', 6], ['DEF', 6],
    ]);
    for (let i = 3; i <= 10; i++) {
        add(i, `Team ${i}`, [
            ['QB', 15 + (i % 3)], ['RB', 12 - (i % 4)], ['RB', 10], ['RB', 8],
            ['WR', 13 - (i % 3)], ['WR', 11], ['WR', 9],
            ['TE', 7 + (i % 3)], ['K', 6], ['DEF', 6],
        ]);
    }

    const rankings = rank(teams);
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        requireMutualGain: false, iterations: 80,
        limits: { stage2Keep: 200, stage3Keep: 2 },
    });

    assert.ok(res.scanned > 0, 'stage 1 must find something to look at');
    const all = [...res.trades, ...res.others];
    assert.ok(all.length > 0, 'and the search must return something');
    assert.ok(
        all.some((t) => t.other.rosterId === 2 && t.gets.some((e) => e.player.pos === 'RB')),
        'specifically the upgrade at running back that is sitting right there'
    );
});

test('a bigger package has to buy something', async () => {
    // A second player thrown in that leaves the other lineup exactly where the
    // one-for-one left it is a player given away for nothing. The search used
    // to list five of those above the deal they were variations of.
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, requireMutualGain: false,
        iterations: 80, limits: { stage2Keep: 200, stage3Keep: 2 },
    });

    const all = [...res.trades, ...res.others];
    const key = (t) => `${t.other.rosterId}:${t.gets.map((e) => e.player.id).sort().join('+')}`;
    const byTarget = new Map();
    for (const t of all) {
        const k = key(t);
        if (!byTarget.has(k)) byTarget.set(k, []);
        byTarget.get(k).push(t);
    }

    for (const group of byTarget.values()) {
        const solo = group.find((t) => t.gives.length === 1);
        if (!solo) continue;
        for (const bigger of group.filter((t) => t.gives.length > 1)) {
            assert.ok(
                bigger.theirGain > solo.theirGain,
                `sending ${bigger.gives.length} for the same return must gain them more than sending 1 ` +
                    `(${bigger.theirGain.toFixed(2)} vs ${solo.theirGain.toFixed(2)})`
            );
        }
    }
});

test('a package never sends and receives the same player', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, requireMutualGain: false,
        iterations: 80, limits: { stage2Keep: 200, stage3Keep: 2 },
    });
    for (const t of [...res.trades, ...res.others]) {
        const give = new Set(t.gives.map((e) => e.player.id));
        for (const g of t.gets) assert.ok(!give.has(g.player.id));
        assert.equal(new Set(t.gives.map((e) => e.player.id)).size, t.gives.length, 'no duplicate pieces');
    }
});
