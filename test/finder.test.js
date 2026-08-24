import test from 'node:test';
import assert from 'node:assert/strict';

import { findTrades, postureOf, acceptanceNote, spread, undominated } from '../js/finder.js';
import { createValuationContext } from '../js/valuation.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { syntheticSchedule } from '../js/sim.js';
import { createTradeValueScale } from '../js/tradevalue.js';
import { valuePlayer } from '../js/valuation.js';

/** The market scale the app builds, so tests judge value the way the UI does. */
function marketScale(teams, rankings, ctx) {
    const raw = [];
    for (const t of teams) for (const p of t.players) raw.push(valuePlayer(p, rankings.get(p.id) ?? 999, ctx).value);
    return createTradeValueScale(raw);
}

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
    // Four even receivers and no ceiling, against one real WR1 and nothing
    // after him. The numbers are close enough that two of mine for his one is
    // a FAIR trade -- a WR-9 for a WR-24 would be robbery, and the value gate
    // rejects it however well it fits a lineup slot.
    //
    // Exactly two backs, so the only pieces I can add without opening a hole in
    // my own lineup are receivers. The search is position-blind by design now:
    // it pairs on value, and an interchangeable RB-11 priced identically to the
    // WR-12 would make which one it picks a coin toss rather than a property
    // worth asserting.
    add(1, 'Flat', [
        ['QB', 17], ['RB', 13], ['RB', 12],
        ['WR', 14], ['WR', 13], ['WR', 13], ['WR', 12],
        ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    add(2, 'Top Heavy', [
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 6],
        ['WR', 19], ['WR', 5], ['WR', 4],
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
        cfg, ctx, teams, myRosterId: 1, rankings, iterations: 80,
        limits: { stage2Keep: 200, stage3Keep: 2 },
    });
    const all = [...res.trades, ...res.others];
    const samePos = all.find(
        (t) => t.gives.every((e) => e.player.pos === 'WR') && t.gets.every((e) => e.player.pos === 'WR')
    );
    assert.ok(samePos, 'my WR2 and WR3 for your WR1 is the most ordinary trade there is');
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
        for (const bigger of group) {
            // Only a package built ON another one can be compared to it. Since
            // the search pairs on value rather than growing outward from a
            // chosen chip, two packages with the same return often share no
            // pieces at all -- and "sending two of mine beats sending one of
            // someone else's" is not a property, it is a coincidence.
            const ids = new Set(bigger.gives.map((e) => e.player.id));
            const smaller = group.filter(
                (t) => t !== bigger && t.gives.length < bigger.gives.length &&
                    t.gives.every((e) => ids.has(e.player.id))
            );
            for (const solo of smaller) {
                assert.ok(
                    bigger.theirGain > solo.theirGain,
                    `adding ${bigger.gives.length - solo.gives.length} more for the same return must gain ` +
                        `them more (${bigger.theirGain.toFixed(2)} vs ${solo.theirGain.toFixed(2)})`
                );
            }
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

// --- Naming a player -------------------------------------------------------
//
// The open search infers what I need from roster shape. Naming a player is a
// different question -- I have declared the need, and the answer is a price.

/** A league where team 2 owns a clear stud and team 1 has pieces to pay with. */
function targetLeague() {
    const { projections, mk, rank } = pool();
    const teams = [];
    const add = (rosterId, name, spec) => {
        const players = spec.map(([pos, ppg]) => mk(pos, ppg));
        teams.push({ rosterId, name, players, wins: 3, losses: 3, ties: 0, pointsFor: 700 });
    };
    add(1, 'Me', [
        ['QB', 18], ['RB', 15], ['RB', 14], ['RB', 13], ['RB', 12],
        ['WR', 12], ['WR', 11], ['WR', 10], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    add(2, 'Star Owner', [
        ['QB', 17], ['WR', 26], ['WR', 8], ['WR', 7], ['RB', 7], ['RB', 6],
        ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    for (let i = 3; i <= 10; i++) {
        add(i, `Team ${i}`, [
            ['QB', 16], ['RB', 12], ['RB', 11], ['WR', 13], ['WR', 12], ['WR', 11],
            ['TE', 8], ['K', 6], ['DEF', 6],
        ]);
    }
    const rankings = rank(teams);
    const star = teams[1].players.find((p) => p.pos === 'WR' && p.name === 'WR-26');
    return { teams, rankings, projections, star, mine: teams[0] };
}

test('naming a target answers what he would cost', async () => {
    const { teams, rankings, projections, star } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        want: [star.id],
        iterations: 80, limits: { stage2Keep: 60, stage3Keep: 3 },
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(res.mode, 'target');
    const all = [...res.trades, ...res.others];
    assert.ok(all.length, 'a funded roster should be able to make an offer');

    for (const t of all) {
        assert.ok(t.gets.some((e) => e.player.id === star.id), 'every package has to contain him');
        assert.equal(t.other.rosterId, 2, 'and go to the man who owns him');
        // Something has to be in it for them, but "their starting lineup goes
        // up" is only one of the two ways that happens. Prying a star loose is
        // usually paid for in value, and a manager who banks a clear profit on
        // the ledger will wear a fractional dip in Sunday's points to do it.
        const paid = t.valueOut - t.valueIn;
        assert.ok(
            t.theirGain > 0 || paid > 0.04 * Math.max(t.valueIn, t.valueOut),
            `and be one they would actually take (lineup ${t.theirGain.toFixed(2)}, ledger ${paid.toFixed(0)})`
        );
    }
});

test('the cheapest acceptable offer is ranked first', async () => {
    const { teams, rankings, projections, star } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        want: [star.id],
        iterations: 80, limits: { stage2Keep: 60, stage3Keep: 4 },
    });

    const all = [...res.trades, ...res.others];
    // "What would it take" wants the least painful version at the top, and the
    // cost to my lineup is exactly how painful it is.
    const best = all[0];
    for (const t of all) assert.ok(best.myGain >= t.myGain - 1e-9, 'the top offer must be the one that costs me least');
});

test('an offer that costs me lineup points is shown, not hidden', async () => {
    // The open search drops anything that lowers my odds. Asking what a player
    // costs and being shown nothing because every version costs something is
    // not an answer -- the cost IS the answer.
    const { teams, rankings, projections, star } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        want: [star.id],
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 7, 14),
        iterations: 100, limits: { stage2Keep: 40, stage3Keep: 4 },
    });
    assert.ok([...res.trades, ...res.others].length, 'a price exists even when it is a steep one');
});

test('naming a player I already have is refused with a reason', async () => {
    const { teams, rankings, projections, mine } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, want: [mine.players[1].id], iterations: 50,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /already have him/);
});

test('two targets on different rosters is refused as a three-team trade', async () => {
    const { teams, rankings, projections, star } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const other = teams[2].players[0];
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, want: [star.id, other.id], iterations: 50,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /three-team/);
});

test('a player nobody rosters is refused rather than silently returning nothing', async () => {
    const { teams, rankings, projections } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, want: ['not-a-player'], iterations: 50,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /not on a roster/);
});

// --- Shopping a player ------------------------------------------------------

test('offering a player searches the whole league for what comes back', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const bait = teams[0].players.find((p) => p.pos === 'RB');

    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        offer: [bait.id],
        requireMutualGain: false,
        iterations: 80, limits: { stage2Keep: 80, stage3Keep: 3 },
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(res.mode, 'offer');
    const all = [...res.trades, ...res.others];
    assert.ok(all.length, 'a startable back should draw some interest');
    for (const t of all) {
        assert.ok(t.gives.some((e) => e.player.id === bait.id), 'every offer has to contain the bait');
    }
    // The whole league is in play, not one counterparty.
    assert.ok(new Set(all.map((t) => t.other.rosterId)).size >= 1);
});

test('shopping a stud can bring back two starters', async () => {
    // One good player back is not the only answer to "what can I get for him".
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    // The RB-rich team's best back: the piece a rebuilding team would want
    // quantity for.
    const stud = teams[0].players.filter((p) => p.pos === 'RB')[0];

    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        offer: [stud.id], requireMutualGain: false,
        iterations: 60, limits: { stage2Keep: 120, stage3Keep: 2 },
    });
    const all = [...res.trades, ...res.others];
    assert.ok(all.some((t) => t.gets.length === 2), 'one for two must be reachable');
});

test('offering somebody else’s player is refused', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, offer: [teams[1].players[0].id], iterations: 50,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /your own roster/);
});

test('naming both sides fixes the target and the bait together', async () => {
    const { teams, rankings, projections, star, mine } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const bait = mine.players.find((p) => p.pos === 'RB');

    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings,
        want: [star.id], offer: [bait.id],
        iterations: 80, limits: { stage2Keep: 60, stage3Keep: 3 },
    });

    assert.equal(res.ok, true, res.error);
    assert.equal(res.mode, 'target+offer');
    const all = [...res.trades, ...res.others];
    assert.ok(all.length, '"here is my piece, what else do I add" has to have an answer');
    for (const t of all) {
        assert.ok(t.gives.some((e) => e.player.id === bait.id), 'the named bait is in every package');
        assert.ok(t.gets.some((e) => e.player.id === star.id), 'and so is the target');
    }
});

test('what it takes means the CHEAPEST package, not every superset of it', async () => {
    // Losing a player can never raise my optimal lineup, so once an offer is
    // accepted every superset of it costs me more and buys me nothing. The
    // search used to list four versions of the same deal, identical in both
    // gain columns, with the extra bodies thrown in free.
    const { teams, rankings, projections, star } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, want: [star.id],
        iterations: 60, limits: { stage2Keep: 200, stage3Keep: 3 },
    });

    const all = [...res.trades, ...res.others];
    const sets = all.map((t) => new Set(t.gives.map((e) => e.player.id)));
    for (let i = 0; i < sets.length; i++) {
        for (let j = 0; j < sets.length; j++) {
            if (i === j) continue;
            const strictSuperset =
                sets[i].size > sets[j].size && [...sets[j]].every((id) => sets[i].has(id));
            assert.ok(
                !strictSuperset,
                `offer ${i} sends everything offer ${j} sends and more, for the same player`
            );
        }
    }
});

test('an extra piece has to buy something on the get side too', async () => {
    // The mirror of the give-side rule: taking an extra body back that leaves
    // my lineup exactly where it was is a roster spot spent on nothing.
    const { teams, rankings, projections, star } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, want: [star.id],
        iterations: 60, limits: { stage2Keep: 200, stage3Keep: 2 },
    });

    const all = [...res.trades, ...res.others];
    const key = (t) => t.gives.map((e) => e.player.id).sort().join('+');
    const byGive = new Map();
    for (const t of all) {
        const k = key(t);
        if (!byGive.has(k)) byGive.set(k, []);
        byGive.get(k).push(t);
    }
    for (const group of byGive.values()) {
        const solo = group.find((t) => t.gets.length === 1);
        if (!solo) continue;
        for (const bigger of group.filter((t) => t.gets.length > 1)) {
            assert.ok(
                bigger.myGain > solo.myGain,
                `taking ${bigger.gets.length} back for the same price must beat taking 1 ` +
                    `(${bigger.myGain.toFixed(2)} vs ${solo.myGain.toFixed(2)})`
            );
        }
    }
});

test('a package never sends and receives the same player, in any mode', async () => {
    const { teams, rankings, projections, star } = targetLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, want: [star.id],
        iterations: 60, limits: { stage2Keep: 80, stage3Keep: 2 },
    });
    for (const t of [...res.trades, ...res.others]) {
        const give = new Set(t.gives.map((e) => e.player.id));
        for (const g of t.gets) assert.ok(!give.has(g.player.id));
    }
});

// --- Value, not just lineup fit --------------------------------------------

test('a lopsided deal is refused however well it fits a lineup slot', async () => {
    // The search only ever knew about lineup points, so it would happily
    // propose sending a 6,000 for a 2,400 whenever the 2,400 filled a starting
    // slot better. Nobody sends that, and the value printed on the card
    // contradicted the recommendation above it.
    const { projections, mk, rank } = pool();
    const teams = [];
    const add = (rosterId, name, spec) => {
        teams.push({
            rosterId, name, wins: 3, losses: 3, ties: 0, pointsFor: 700,
            players: spec.map(([pos, ppg]) => mk(pos, ppg)),
        });
    };
    // I have four scrubs at receiver and they have a monster. My lineup would
    // love him; no manager alive trades him for one of my nines.
    add(1, 'Scrubs', [
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 11],
        ['WR', 9], ['WR', 9], ['WR', 9], ['WR', 9], ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    add(2, 'Monster', [
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 6],
        ['WR', 26], ['WR', 5], ['WR', 4], ['TE', 8], ['K', 7], ['DEF', 6],
    ]);
    for (let i = 3; i <= 8; i++) {
        add(i, `T${i}`, [['QB', 16], ['RB', 12], ['RB', 11], ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 8], ['K', 6], ['DEF', 6]]);
    }

    const rankings = rank(teams);
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const scale = marketScale(teams, rankings, ctx);

    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, tradeValue: scale,
        iterations: 60, limits: { stage2Keep: 200, stage3Keep: 2 },
    });

    for (const t of [...res.trades, ...res.others]) {
        assert.ok(
            t.valueGap <= 0.3 + 1e-9,
            `offer is ${(t.valueGap * 100).toFixed(0)}% apart on value: ` +
                `${t.gives.map((e) => e.player.name)} for ${t.gets.map((e) => e.player.name)}`
        );
    }
});

test('every card carries the ledger it was judged on', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, tradeValue: marketScale(teams, rankings, ctx),
        iterations: 80, limits: { stage2Keep: 40, stage3Keep: 3 },
    });
    for (const t of [...res.trades, ...res.others]) {
        assert.ok(Number.isFinite(t.valueIn) && t.valueIn >= 0);
        assert.ok(Number.isFinite(t.valueOut) && t.valueOut >= 0);
        assert.ok(Math.abs(t.valueNet - (t.valueIn - t.valueOut)) < 1e-6);
    }
});

// --- One search, many different players ------------------------------------

test('the board is not nine prices for the same man', () => {
    // The best available target generates the most acceptable packages, so an
    // unfiltered top-N was N ways to acquire one player. A search of the whole
    // league should answer "who can I get", not "here are nine prices for him".
    const row = (rosterId, getIds, myGain) => ({
        other: { rosterId },
        gets: getIds.map((id) => ({ player: { id } })),
        gives: [{ player: { id: `g${id_++}` } }],
        myGain,
    });
    let id_ = 0;

    // Nine ways to get one man, then a few other options ranked below them.
    const list = [
        ...Array.from({ length: 9 }, (_, i) => row(2, ['star'], 10 - i)),
        row(3, ['other'], 4),
        row(4, ['third'], 3),
        row(5, ['fourth'], 2),
    ];

    const out = spread(list, { perTargetCap: 2, perTeamCap: 4 });
    const top = out.slice(0, 5);
    const counts = new Map();
    for (const t of top) {
        const key = t.gets.map((e) => e.player.id).join('+');
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    assert.ok(counts.get('star') <= 2, `the top of the board is ${counts.get('star')} prices for one player`);
    assert.ok(counts.size >= 3, `expected several different targets up top, got ${counts.size}`);
});

test('one manager cannot fill the whole board either', () => {
    let n = 0;
    const list = Array.from({ length: 10 }, () => ({
        other: { rosterId: 2 },
        gets: [{ player: { id: `p${n++}` } }],
        gives: [{ player: { id: `g${n++}` } }],
        myGain: 1,
    }));
    // Ten distinct acquisitions, all from one team: still capped, because a
    // board that only ever names one counterparty is not a league search.
    const out = spread(list, { perTargetCap: 2, perTeamCap: 3 });
    assert.equal(out.length, 10, 'nothing is discarded');
    assert.equal(new Set(out.slice(0, 3).map((t) => t.other.rosterId)).size, 1);
    assert.ok(out.slice(0, 3).every((t) => t.other.rosterId === 2));
});

test('spread keeps every trade, it only reorders them', () => {
    const list = Array.from({ length: 20 }, (_, i) => ({
        other: { rosterId: (i % 2) + 2 },
        gets: [{ player: { id: `p${i % 3}` } }],
        gives: [{ player: { id: `g${i}` } }],
        myGain: 20 - i,
    }));
    const out = spread(list, { perTargetCap: 1, perTeamCap: 1 });
    assert.equal(out.length, list.length);
    assert.deepEqual(new Set(out), new Set(list), 'same trades, different order');
});

test('nothing is thrown away to make room for variety', async () => {
    // The caps decide what is seen first, never what exists.
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const scale = marketScale(teams, rankings, ctx);
    const opts = { cfg, ctx, teams, myRosterId: 1, rankings, tradeValue: scale, iterations: 50 };

    const spreadOut = await findTrades({ ...opts, limits: { stage2Keep: 200, stage3Keep: 2 } });
    const unspread = await findTrades({
        ...opts,
        limits: { stage2Keep: 200, stage3Keep: 2, perTargetCap: 999, perTeamCap: 999 },
    });
    assert.equal(spreadOut.shortlisted, unspread.shortlisted, 'the same trades exist either way');
});

// --- Realism: what the search may put in front of a person ------------------
//
// Every one of these is a shape the finder used to produce and a manager would
// have laughed at. The ledger gate, the acceptance model and the dominance pass
// each exist because of one of them.

test('nothing on the board is lopsided on value', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const tradeValue = marketScale(teams, rankings, ctx);
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, tradeValue,
        iterations: 80, limits: { stage2Keep: 200, stage3Keep: 3 },
    });

    for (const t of [...res.trades, ...res.others]) {
        assert.ok(
            t.valueGap <= 0.15 + 1e-9,
            `${t.valueIn.toFixed(0)} for ${t.valueOut.toFixed(0)} is ${(t.valueGap * 100).toFixed(0)}% apart`
        );
    }
});

test('a gap in my favour is no more acceptable than one against me', async () => {
    // Symmetry is the point. Winning a trade by a third is not a recommendation
    // -- it is an offer that gets ignored, and the tool exists to get replies.
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const tradeValue = marketScale(teams, rankings, ctx);
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, tradeValue,
        iterations: 80, limits: { stage2Keep: 200, stage3Keep: 3 },
    });

    for (const t of [...res.trades, ...res.others]) {
        const edge = (t.valueIn - t.valueOut) / Math.max(t.valueIn, t.valueOut);
        assert.ok(edge <= 0.15 + 1e-9, `winning by ${(edge * 100).toFixed(0)}% is not a deal they take`);
    }
});

test('every side of every deal has a reason to say yes', async () => {
    const { teams, rankings, projections } = buildLeague();
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 7, projections });
    const tradeValue = marketScale(teams, rankings, ctx);
    const res = await findTrades({
        cfg, ctx, teams, myRosterId: 1, rankings, tradeValue,
        iterations: 80, limits: { stage2Keep: 200, stage3Keep: 3 },
    });
    assert.ok(res.trades.length + res.others.length > 0, 'and there must BE deals');

    for (const t of [...res.trades, ...res.others]) {
        const material = 0.04 * Math.max(t.valueIn, t.valueOut);
        const reason = (lineup, net) => lineup > -0.6 && (lineup > 0.05 || net > material);
        assert.ok(reason(t.myGain, t.valueIn - t.valueOut), `nothing in it for me: ${t.myGain.toFixed(2)}`);
        assert.ok(reason(t.theirGain, t.valueOut - t.valueIn), `nothing in it for them: ${t.theirGain.toFixed(2)}`);
    }
});

test('a package with a free body stapled on is dropped', () => {
    // Reachable from a silly pairing: match a scrub against a star, "complete"
    // the ledger with the player who was the real trade all along, and out
    // comes the clean deal with a spare attached. Six of those, identical in
    // both gain columns, was what the board looked like.
    const e = (id, value) => ({ player: { id }, value });
    const other = { rosterId: 2 };
    const clean = { other, gives: [e('mine', 3659)], gets: [e('star', 4173)], myGain: 0.41, theirGain: 2.25, valueGap: 0.12 };
    const padded = {
        other,
        gives: [e('mine', 3659), e('scrub', 93)],
        gets: [e('star', 4173)],
        myGain: 0.41, theirGain: 2.25, valueGap: 0.08,
    };

    const out = undominated([clean, padded]);
    assert.deepEqual(out, [clean], 'sending more for the same return is never the better deal');
});

test('one acquisition does not appear three times wearing different change', () => {
    // Same two players at the heart of it, different worthless filler coming
    // back. One trade, and the honest version is the one closest to even.
    const e = (id, value) => ({ player: { id }, value });
    const other = { rosterId: 2 };
    const variant = (fillerId, fillerValue, valueGap) => ({
        other,
        gives: [e('cook', 3177)],
        gets: [e('mcbride', 2690), e(fillerId, fillerValue)],
        myGain: 1.25, theirGain: 0.99, valueGap,
    });
    const fairest = variant('stafford', 328, 0.05);
    const list = [variant('charbonnet', 24, 0.15), fairest, variant('downs', 229, 0.08)];

    const out = undominated(list);
    assert.equal(out.length, 1, `expected one representative, got ${out.length}`);
    assert.equal(out[0], fairest, 'and it should be the one whose ledger is closest to even');
});

test('a package that genuinely differs survives the collapse', () => {
    const e = (id, value) => ({ player: { id }, value });
    const other = { rosterId: 2 };
    const a = { other, gives: [e('a', 100)], gets: [e('x', 105)], myGain: 1, theirGain: 1, valueGap: 0.05 };
    const b = { other, gives: [e('b', 100)], gets: [e('y', 105)], myGain: 1, theirGain: 1, valueGap: 0.05 };
    assert.equal(undominated([a, b]).length, 2, 'different players, different trades');
});

test('one player cannot be in every row of the board', () => {
    // Value-matched search makes this worse, not better: the two or three
    // pieces whose price lines up against the rest of the league turn up in
    // nearly every affordable package.
    const e = (id) => ({ player: { id }, value: 100 });
    // Eight ways to send the same man, ranked above three deals that do not
    // involve him at all.
    const list = [
        ...Array.from({ length: 8 }, (_, i) => ({
            other: { rosterId: 2 + i },
            gives: [e('workhorse')],
            gets: [e(`target${i}`)],
            myGain: 20 - i,
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
            other: { rosterId: 2 + i },
            gives: [e(`spare${i}`)],
            gets: [e(`elsewhere${i}`)],
            myGain: 3 - i,
        })),
    ];

    const out = spread(list, { perTargetCap: 2, perTeamCap: 4, perPieceCap: 3 });
    const top = out.slice(0, 5).filter((t) => t.gives.some((g) => g.player.id === 'workhorse'));
    assert.ok(top.length <= 3, `the same player leaves in ${top.length} of the first five rows`);
    assert.equal(out.length, list.length, 'and nothing is actually thrown away');
});
