import test from 'node:test';
import assert from 'node:assert/strict';

import { computePowerRankings, computeAllPlay, applyMovement, toSnapshot, toShareText } from '../js/power.js';
import { createValuationContext } from '../js/valuation.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { syntheticSchedule } from '../js/sim.js';

const cfg = normalizeLeague({
    league_id: 'pr', name: 'PR League',
    settings: { num_teams: 10, playoff_teams: 4, playoff_week_start: 15 },
    scoring_settings: { rec: 0.5 },
    roster_positions: defaultRosterPositions(),
});
const ctx = createValuationContext(cfg, { week: 8, weeksLeft: 7 });

let uid = 0;
function makeTeam(rankings, i, quality, record) {
    const spec = [
        ['QB', 4 + quality], ['RB', 5 + quality * 2], ['RB', 15 + quality * 2],
        ['WR', 5 + quality * 2], ['WR', 16 + quality * 2], ['WR', 30 + quality],
        ['TE', 4 + quality], ['K', 8], ['DEF', 8],
        ['RB', 40], ['WR', 50], ['TE', 22],
    ];
    const players = spec.map(([pos, rank]) => {
        const p = { id: `t${i}_${++uid}`, name: `${pos}${rank}`, pos, team: 'KC', age: 26, injury: null };
        rankings.set(p.id, rank);
        return p;
    });
    return { rosterId: i, name: `Team ${i}`, owner: `o${i}`, players, ...record };
}

/** 10 teams, quality 0 (best) .. 9 (worst). */
function buildLeague(records = {}) {
    const rankings = new Map();
    const teams = Array.from({ length: 10 }, (_, k) =>
        makeTeam(rankings, k + 1, k, records[k + 1] || { wins: 4, losses: 3, ties: 0, pointsFor: 800 })
    );
    return { rankings, teams };
}

function weeklyScores(teams, scoreFor) {
    const m = new Map();
    for (const t of teams) {
        m.set(t.rosterId, Array.from({ length: 7 }, (_, w) => ({ week: w + 1, points: scoreFor(t, w + 1) })));
    }
    return m;
}

test('all-play strips schedule luck out of a record', async () => {
    const teams = [1, 2, 3, 4].map((rosterId) => ({ rosterId }));
    // Team 1 scores the most every single week.
    const scores = new Map([
        [1, [{ week: 1, points: 150 }, { week: 2, points: 150 }]],
        [2, [{ week: 1, points: 120 }, { week: 2, points: 120 }]],
        [3, [{ week: 1, points: 110 }, { week: 2, points: 110 }]],
        [4, [{ week: 1, points: 100 }, { week: 2, points: 100 }]],
    ]);
    const ap = computeAllPlay(teams, scores);
    assert.equal(ap.get(1).winPct, 1, 'league high every week is a perfect all-play record');
    assert.equal(ap.get(4).winPct, 0);
    assert.equal(ap.get(1).expectedWins, 2);
});

test('all-play splits ties evenly', async () => {
    const teams = [1, 2].map((rosterId) => ({ rosterId }));
    const scores = new Map([[1, [{ week: 1, points: 100 }]], [2, [{ week: 1, points: 100 }]]]);
    assert.equal(computeAllPlay(teams, scores).get(1).winPct, 0.5);
});

test('better rosters rank higher when records are identical', async () => {
    const { rankings, teams } = buildLeague();
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 8, iterations: 400,
        weeklyScores: weeklyScores(teams, () => 110),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    });
    assert.equal(ranked[0].rosterId, 1, 'the strongest roster should lead');
    assert.equal(ranked[ranked.length - 1].rosterId, 10);
    assert.equal(ranked[0].rank, 1);
    ranked.forEach((r, i) => assert.equal(r.rank, i + 1));
});

test('an unlucky team is ranked above its record and called out', async () => {
    // Team 3 has a strong roster and scores well but is only 1-6.
    const { rankings, teams } = buildLeague({
        3: { wins: 1, losses: 6, ties: 0, pointsFor: 980 },
    });
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 8, iterations: 400,
        weeklyScores: weeklyScores(teams, (t) => (t.rosterId === 3 ? 140 : 100)),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    });
    const t3 = ranked.find((r) => r.rosterId === 3);
    assert.ok(t3.luck < -2, `luck should be sharply negative, got ${t3.luck}`);
    assert.ok(t3.allPlayWinPct > 0.9);
    assert.ok(t3.rank <= 3, `unlucky juggernaut should still rank high, got ${t3.rank}`);
    assert.match(t3.blurb, /unlucky/i);
});

test('a lucky team with a bad roster is called out for it', async () => {
    const { rankings, teams } = buildLeague({
        9: { wins: 7, losses: 0, ties: 0, pointsFor: 560 },
    });
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 8, iterations: 400,
        weeklyScores: weeklyScores(teams, (t) => (t.rosterId === 9 ? 70 : 110)),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    });
    const t9 = ranked.find((r) => r.rosterId === 9);
    assert.ok(t9.luck > 2, `luck should be sharply positive, got ${t9.luck}`);
    assert.match(t9.blurb, /luckiest team in the league/i);
    assert.match(t9.blurb, /did not earn/i);
});

test('luck superlatives are only ever handed to one team', async () => {
    // Three teams all badly unlucky: only the worst may claim the superlative.
    const { rankings, teams } = buildLeague({
        1: { wins: 0, losses: 7, ties: 0, pointsFor: 1000 },
        2: { wins: 1, losses: 6, ties: 0, pointsFor: 980 },
        3: { wins: 1, losses: 6, ties: 0, pointsFor: 960 },
    });
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 8, iterations: 300,
        weeklyScores: weeklyScores(teams, (t) => (t.rosterId <= 3 ? 145 : 95)),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    });
    const claims = ranked.filter((r) => /most unlucky team in the league/i.test(r.blurb));
    assert.equal(claims.length, 1, `expected exactly one "most unlucky", got ${claims.length}`);
});

test('weak spots are league-relative, not just the lowest-scoring position', async () => {
    // Every roster in every league starts fewer points at TE than at RB, so a
    // blurb that flags TE for everyone is saying nothing at all.
    const { rankings, teams } = buildLeague();
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 8, iterations: 300,
        weeklyScores: weeklyScores(teams, () => 110),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    });
    const flaggedTe = ranked.filter((r) => /^TE is a real hole|TE is a real hole/.test(r.blurb)).length;
    assert.ok(flaggedTe < ranked.length / 2, `TE flagged as the hole on ${flaggedTe}/${ranked.length} teams`);
    // The strongest roster must not be described as having a below-average hole
    // at the position it is strongest in.
    const top = ranked[0];
    assert.ok(!/is a real hole/.test(top.blurb) || top.rank > 1, 'the best team should not read as full of holes');
});

test('preseason rankings fall back to roster strength alone', async () => {
    const { rankings, teams } = buildLeague();
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 1, iterations: 300,
        weeklyScores: new Map(),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 1, 14),
    });
    assert.equal(ranked[0].rosterId, 1);
    assert.equal(ranked[0].games, 0);
    assert.equal(ranked[0].components.allPlay, 0, 'no games means no performance signal');
});

test('every team gets a tier and a non-empty blurb', async () => {
    const { rankings, teams } = buildLeague();
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 8, iterations: 300,
        weeklyScores: weeklyScores(teams, () => 110),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    });
    for (const r of ranked) {
        assert.ok(r.blurb && r.blurb.length > 10, `blurb missing for ${r.team.name}`);
        assert.ok(typeof r.tierName === 'string' && r.tierName.length);
        assert.ok(r.rating >= 1 && r.rating <= 99);
    }
    assert.ok(new Set(ranked.map((r) => r.tierName)).size > 1, 'tiers should actually separate teams');
});

test('movement is computed against a stored snapshot', async () => {
    const ranked = [
        { rosterId: 1, rank: 1, rating: 80, team: { name: 'A', wins: 5, losses: 1 }, blurb: 'x', movement: 0 },
        { rosterId: 2, rank: 2, rating: 70, team: { name: 'B', wins: 4, losses: 2 }, blurb: 'y', movement: 0 },
    ];
    applyMovement(ranked, { week: 7, ranking: [{ rosterId: 2, rank: 1 }, { rosterId: 1, rank: 4 }] });
    assert.equal(ranked[0].movement, 3, 'rose from 4th to 1st');
    assert.equal(ranked[1].movement, -1);
    assert.equal(ranked[0].previousRank, 4);
});

test('teams absent from the snapshot show no movement', async () => {
    const ranked = [{ rosterId: 5, rank: 1, team: { name: 'New' } }];
    applyMovement(ranked, { week: 3, ranking: [] });
    assert.equal(ranked[0].movement, 0);
    assert.equal(ranked[0].previousRank, null);
});

test('share text is paste-ready and includes movement arrows', async () => {
    const ranked = [
        { rosterId: 1, rank: 1, rating: 82, movement: 2, team: { name: 'Alpha', wins: 5, losses: 1 }, blurb: 'Rolling.' },
        { rosterId: 2, rank: 2, rating: 61, movement: -1, team: { name: 'Beta', wins: 3, losses: 3 }, blurb: 'Fading.' },
    ];
    const txt = toShareText(ranked, 'My League', 8);
    assert.match(txt, /PAYTON MITCHELL POWER RANKINGS — My League, Week 8/);
    assert.match(txt, /1\. Alpha \(5-1\) \(▲2\) — 82/);
    assert.match(txt, /2\. Beta \(3-3\) \(▼1\) — 61/);
    assert.match(txt, /Rolling\./);
});

test('snapshots round-trip through movement', async () => {
    const { rankings, teams } = buildLeague();
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 8, iterations: 250,
        weeklyScores: weeklyScores(teams, () => 110),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    });
    const snap = toSnapshot(ranked);
    assert.equal(snap.length, teams.length);
    applyMovement(ranked, { week: 7, ranking: snap });
    assert.ok(ranked.every((r) => r.movement === 0), 'same ranking means no movement');
});

test('weighting presets actually change the ordering', async () => {
    // A weak roster that has been scoring well vs a strong roster that has not.
    const { rankings, teams } = buildLeague({
        8: { wins: 6, losses: 1, ties: 0, pointsFor: 1000 },
        1: { wins: 1, losses: 6, ties: 0, pointsFor: 600 },
    });
    const scores = weeklyScores(teams, (t) => (t.rosterId === 8 ? 145 : t.rosterId === 1 ? 80 : 105));
    const base = {
        cfg, ctx, teams, rankings, week: 8, iterations: 400,
        weeklyScores: scores,
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    };
    const rosterFirst = await computePowerRankings({ ...base, preset: 'roster' });
    const resultsFirst = await computePowerRankings({ ...base, preset: 'results' });

    const rankOf = (list, id) => list.find((r) => r.rosterId === id).rank;
    // Team 1 has the best roster; team 8 has the best results.
    assert.ok(
        rankOf(rosterFirst, 1) < rankOf(resultsFirst, 1),
        'the strong-but-losing roster should rank better under roster-first'
    );
    assert.ok(
        rankOf(resultsFirst, 8) < rankOf(rosterFirst, 8),
        'the weak-but-winning team should rank better under results-first'
    );
});

test('an unknown preset falls back to balanced rather than throwing', async () => {
    const { rankings, teams } = buildLeague();
    const ranked = await computePowerRankings({
        cfg, ctx, teams, rankings, week: 8, iterations: 200, preset: 'nonsense',
        weeklyScores: weeklyScores(teams, () => 110),
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 8, 14),
    });
    assert.equal(ranked.length, teams.length);
});
