import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTrade, buildEntries, suggestAddOns, suggestPackages, createEvalCache, suggestFaab } from '../js/trade.js';
import { faabModel } from '../js/faab.js';
import { createValuationContext } from '../js/valuation.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { syntheticSchedule } from '../js/sim.js';

const cfg = normalizeLeague({
    league_id: 'test',
    name: 'Test League',
    settings: { num_teams: 12, playoff_teams: 6, playoff_week_start: 15, type: 0 },
    scoring_settings: { rec: 0.5 },
    roster_positions: defaultRosterPositions(),
});
const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 10 });

let uid = 0;
const mk = (pos, rank, extra = {}) => ({
    id: `p${++uid}`, name: `${pos}${rank}`, pos, team: 'KC', age: 26, injury: null, _rank: rank, ...extra,
});

/** Builds a roster of the given [pos, rank] pairs and registers their rankings. */
function roster(rankings, spec) {
    return spec.map(([pos, rank, extra]) => {
        const p = mk(pos, rank, extra);
        rankings.set(p.id, rank);
        return p;
    });
}

function league(rankings, teamSpecs) {
    return teamSpecs.map((spec, i) => ({
        rosterId: i + 1,
        name: spec.name || `Team ${i + 1}`,
        owner: `owner${i + 1}`,
        players: roster(rankings, spec.players),
        wins: spec.wins ?? 3,
        losses: spec.losses ?? 3,
        ties: 0,
        pointsFor: spec.pointsFor ?? 700,
    }));
}

const BALANCED = [
    ['QB', 8], ['RB', 14], ['RB', 22], ['WR', 15], ['WR', 24], ['WR', 33],
    ['TE', 10], ['K', 10], ['DEF', 10], ['RB', 40], ['WR', 45], ['TE', 20],
];

test('value ledger is zero sum between two sides', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'A', players: [['RB', 2], ...BALANCED] },
        { name: 'B', players: [['WR', 3], ...BALANCED] },
    ]);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [teams[1].players[0].id] },
        ],
    });
    assert.equal(res.ok, true);
    const [a, b] = res.sides;
    assert.ok(Math.abs(a.valueNet + b.valueNet) < 1e-9, 'net value must cancel');
    assert.equal(a.valueIn, b.valueOut);
});

test('a clearly lopsided offer is called lopsided', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'Fleecer', players: [['RB', 55], ...BALANCED] },
        { name: 'Victim', players: [['RB', 1], ...BALANCED] },
    ]);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [teams[1].players[0].id] },
        ],
    });
    assert.equal(res.verdict.winner, 1);
    assert.ok(res.verdict.gap > 0.2, `gap ${res.verdict.gap}`);
    assert.ok(/Fleecer/.test(res.verdict.label));
});

test('an even swap of equals reads as even', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'A', players: [['WR', 9], ...BALANCED] },
        { name: 'B', players: [['WR', 9], ...BALANCED] },
    ]);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [teams[1].players[0].id] },
        ],
    });
    assert.ok(Math.abs(res.verdict.gap) < 0.08, `gap ${res.verdict.gap}`);
    assert.ok(['Even', 'Win-win'].includes(res.verdict.label));
});

test('need-based trade: swapping surplus for a hole helps both sides', async () => {
    const rankings = new Map();
    // A is stacked at WR and starts a replacement-level TE.
    // B is stacked at TE and starts a replacement-level WR.
    const teams = league(rankings, [
        {
            name: 'WR Rich',
            players: [
                ['QB', 8], ['RB', 14], ['RB', 22],
                ['WR', 2], ['WR', 4], ['WR', 6], ['WR', 8],
                ['TE', 34], ['K', 10], ['DEF', 10], ['RB', 44], ['WR', 50],
            ],
        },
        {
            name: 'TE Rich',
            players: [
                ['QB', 9], ['RB', 15], ['RB', 23],
                ['TE', 1], ['TE', 3], ['TE', 6],
                ['WR', 48], ['WR', 52], ['K', 11], ['DEF', 11], ['RB', 45], ['WR', 60],
            ],
        },
    ]);
    const wr = teams[0].players[6]; // WR8
    const te = teams[1].players[4]; // TE3
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [{ rosterId: 1, sending: [wr.id] }, { rosterId: 2, sending: [te.id] }],
    });
    const [a, b] = res.sides;
    assert.ok(a.lineupNet > 0.5, `WR-rich team should gain from the TE (${a.lineupNet})`);
    assert.ok(b.lineupNet > 0.5, `TE-rich team should gain from the WR (${b.lineupNet})`);
    assert.equal(res.verdict.bothGainLineup, true);
    assert.ok(res.reasons.some((r) => /upgrades at TE/.test(r.title)));
});

test('depth that never starts is flagged as value that does not score', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        {
            name: 'Stacked',
            players: [
                ['QB', 8], ['RB', 14], ['RB', 20], ['WR', 2], ['WR', 3], ['WR', 5],
                ['TE', 8], ['K', 10], ['DEF', 10], ['RB', 40], ['WR', 55], ['TE', 25],
            ],
        },
        { name: 'Other', players: [['WR', 7], ...BALANCED] },
    ]);
    // Stacked trades a bench body for a WR7 who still cannot crack its lineup.
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [
            { rosterId: 1, sending: [teams[0].players[10].id] },
            { rosterId: 2, sending: [teams[1].players[0].id] },
        ],
    });
    const stacked = res.sides[0];
    assert.ok(stacked.valueNet > 0, 'the ledger says they won');
    assert.ok(stacked.lineupNet < 0.6, 'but the lineup barely moves');
    assert.ok(res.reasons.some((r) => /"wins" the value but not the lineup/.test(r.title)));
});

test('injured incoming players are discounted and called out', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'A', players: [['RB', 5], ...BALANCED] },
        { name: 'B', players: [['RB', 5, { injury: 'IR' }], ...BALANCED] },
    ]);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [teams[1].players[0].id] },
        ],
    });
    assert.equal(res.verdict.winner, 2, 'the team sending the IR player wins');
    assert.ok(res.reasons.some((r) => /is IR/.test(r.title)));
    assert.ok(res.sides[0].valueIn < res.sides[0].valueOut / 2);
});

test('roster crunch charges the team that has to make cuts', async () => {
    const rankings = new Map();
    const small = normalizeLeague({
        settings: { num_teams: 12, playoff_teams: 6 },
        scoring_settings: { rec: 0.5 },
        roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'],
    });
    const smallCtx = createValuationContext(small, { week: 5, weeksLeft: 10 });
    const teams = league(rankings, [
        { name: 'A', players: [['RB', 3], ['QB', 8], ['RB', 20], ['WR', 15], ['WR', 25], ['TE', 12], ['K', 10], ['DEF', 10], ['WR', 35], ['RB', 42], ['WR', 60]] },
        { name: 'B', players: [['RB', 18], ['WR', 19], ['WR', 21], ['QB', 9], ['RB', 24], ['TE', 14], ['K', 11], ['DEF', 11], ['WR', 38], ['RB', 47], ['WR', 62]] },
    ]);
    const res = await evaluateTrade({
        cfg: small, ctx: smallCtx, teams, rankings,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [teams[1].players[0].id, teams[1].players[1].id, teams[1].players[2].id] },
        ],
    });
    const a = res.sides[0];
    assert.equal(a.overflow, 2, '11 - 1 + 3 = 13 against an 11-man roster');
    // Depth still carries option value, so a forced cut is never literally
    // free -- but squeezing off two bench bodies must stay a minor cost next
    // to the players actually changing hands.
    assert.ok(a.crunchCost > 0, 'bench depth is worth something');
    assert.ok(
        a.crunchCost < Math.abs(a.valueIn) * 0.5,
        `crunch (${a.crunchCost}) must be small beside the incoming value (${a.valueIn})`
    );
    const cut = res.reasons.find((r) => /has to cut 2 players/.test(r.title));
    assert.ok(cut, 'roster crunch must be reported');
    assert.match(cut.detail, /deep bench pieces/);
});

test('full mode reports playoff and title odds deltas', async () => {
    const rankings = new Map();
    const specs = Array.from({ length: 12 }, (_, i) => ({
        name: `T${i + 1}`,
        players: [['RB', 6 + i], ['WR', 6 + i], ...BALANCED],
        wins: 3, losses: 3,
    }));
    const teams = league(rankings, specs);
    const schedule = syntheticSchedule(teams.map((t) => t.rosterId), 5, 14);

    // Team 12 (worst) sends a spare part for Team 1's best player: a heist.
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings, schedule, iterations: 600,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 12, sending: [teams[11].players[13].id] },
        ],
    });
    assert.equal(res.mode, 'full');
    const [a, b] = res.sides;
    assert.ok(a.playoffAfter < a.playoffBefore, 'giving away your best player hurts');
    assert.ok(b.playoffAfter > b.playoffBefore, 'receiving him helps');
    assert.ok(typeof a.titleDelta === 'number' && typeof b.titleDelta === 'number');
    assert.ok(res.reasons.some((r) => /playoff odds/.test(r.title)));
});

test('a shared cache changes the cost of a search, never its answer', async () => {
    // The finder evaluates dozens of candidates against one unchanged league.
    // The pre-trade simulation and every untouched roster's lineup are the same
    // every time; caching them is only legitimate if the numbers come out
    // identical, so assert that rather than trusting it.
    const rankings = new Map();
    const specs = Array.from({ length: 12 }, (_, i) => ({
        name: `T${i + 1}`,
        players: [['RB', 6 + i], ['WR', 6 + i], ...BALANCED],
        wins: 3, losses: 3,
    }));
    const teams = league(rankings, specs);
    const schedule = syntheticSchedule(teams.map((t) => t.rosterId), 5, 14);

    const offersFor = (i) => [
        { rosterId: 1, sending: [teams[0].players[0].id] },
        { rosterId: 12, sending: [teams[11].players[13 - i].id] },
    ];
    const run = (offers, cache) =>
        evaluateTrade({ cfg, ctx, teams, rankings, schedule, iterations: 400, offers, cache });

    const cache = createEvalCache();
    for (const i of [0, 1, 2]) {
        const plain = await run(offersFor(i), null);
        const cached = await run(offersFor(i), cache);
        const [pa, pb] = plain.sides;
        const [ca, cb] = cached.sides;
        assert.equal(ca.playoffBefore, pa.playoffBefore);
        assert.equal(ca.playoffAfter, pa.playoffAfter);
        assert.equal(ca.titleDelta, pa.titleDelta);
        assert.equal(cb.playoffDelta, pb.playoffDelta);
    }
    assert.ok(cache.basePoints.size > 0, 'the cache is actually being populated');
});

test('rejects malformed offers', async () => {
    const rankings = new Map();
    const teams = league(rankings, [{ name: 'A', players: BALANCED }, { name: 'B', players: BALANCED }]);
    assert.equal((await evaluateTrade({ cfg, ctx, teams, rankings, offers: [{ rosterId: 1, sending: [] }, { rosterId: 2, sending: [] }] })).ok, false);
    assert.match(
        (await evaluateTrade({ cfg, ctx, teams, rankings, offers: [{ rosterId: 1, sending: ['x'] }] })).error,
        /at least two teams/
    );
});

test('add-on suggestions favour surplus-for-need over raw value matching', async () => {
    const rankings = new Map();
    // Giver is stacked at RB (four good ones) and thin at WR.
    // Receiver is stacked at WR and desperate at RB.
    const teams = league(rankings, [
        {
            name: 'RB Rich',
            players: [
                ['QB', 8], ['RB', 3], ['RB', 6], ['RB', 9], ['RB', 12],
                ['WR', 40], ['WR', 45], ['TE', 12], ['K', 10], ['DEF', 10], ['WR', 55], ['TE', 26],
            ],
        },
        {
            name: 'WR Rich',
            players: [
                ['QB', 9], ['WR', 3], ['WR', 5], ['WR', 8], ['WR', 11],
                ['RB', 44], ['RB', 48], ['TE', 14], ['K', 11], ['DEF', 11], ['RB', 60], ['TE', 28],
            ],
        },
    ]);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [
            { rosterId: 1, sending: [teams[0].players[5].id] },
            { rosterId: 2, sending: [teams[1].players[5].id] },
        ],
    });
    const [giver, receiver] = res.sides;
    const picks = suggestAddOns({ cfg, ctx, giver, receiver, gap: 60, limit: 4 });

    assert.ok(picks.length > 0, 'should find candidates');
    // Never a kicker or a defense.
    assert.ok(picks.every((p) => p.player.pos !== 'K' && p.player.pos !== 'DEF'));
    // The top suggestion should be a running back: the giver has surplus there
    // and the receiver has a hole.
    assert.equal(picks[0].player.pos, 'RB', `expected an RB, got ${picks[0].player.pos}`);
    assert.ok(picks[0].gainToReceiver > 0, 'the add-on must actually help the receiver');
    assert.ok(picks[0].rationale && picks[0].rationale.length > 10);
});

test('add-ons never propose a player already in the deal', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'A', players: [['RB', 4], ...BALANCED] },
        { name: 'B', players: [['WR', 4], ...BALANCED] },
    ]);
    const sentId = teams[0].players[0].id;
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [{ rosterId: 1, sending: [sentId] }, { rosterId: 2, sending: [teams[1].players[0].id] }],
    });
    const picks = suggestAddOns({ cfg, ctx, giver: res.sides[0], receiver: res.sides[1], gap: 40, limit: 8 });
    assert.ok(!picks.some((p) => p.player.id === sentId), 'a traded player cannot also be the sweetener');
});

test('add-ons that wildly overshoot the gap are filtered out', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'A', players: [['RB', 1], ['WR', 60], ...BALANCED] },
        { name: 'B', players: [['WR', 30], ...BALANCED] },
    ]);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [{ rosterId: 1, sending: [teams[0].players[1].id] }, { rosterId: 2, sending: [teams[1].players[0].id] }],
    });
    // A tiny gap must not be "balanced" by handing over the best RB in football.
    const picks = suggestAddOns({ cfg, ctx, giver: res.sides[0], receiver: res.sides[1], gap: 5, limit: 8 });
    const elite = picks.find((p) => p.posRank === 1 && p.player.pos === 'RB');
    assert.ok(!elite, 'an elite player must not be proposed to close a trivial gap');
});

test('packages are offered and land near the gap', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'A', players: [['RB', 5], ['RB', 11], ['RB', 16], ['WR', 20], ...BALANCED] },
        { name: 'B', players: [['WR', 6], ...BALANCED] },
    ]);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [{ rosterId: 1, sending: [teams[0].players[3].id] }, { rosterId: 2, sending: [teams[1].players[0].id] }],
    });
    const entries = buildEntries(teams[0].players, rankings, ctx);
    const gap = entries[1].value + entries[2].value;
    const packs = suggestPackages({ cfg, ctx, giver: res.sides[0], receiver: res.sides[1], gap, limit: 3 });
    for (const pk of packs) {
        assert.equal(pk.players.length, 2);
        assert.ok(pk.closes >= 75 && pk.closes <= 145, `package closes ${pk.closes}%`);
    }
});

test('reasons are deduped and capped per team', async () => {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'A', players: [['RB', 2], ['WR', 3], ['TE', 2], ...BALANCED] },
        { name: 'B', players: [['RB', 50], ['WR', 55], ['TE', 30], ...BALANCED] },
    ]);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id, teams[0].players[1].id, teams[0].players[2].id] },
            { rosterId: 2, sending: [teams[1].players[0].id, teams[1].players[1].id, teams[1].players[2].id] },
        ],
    });
    const byTeam = new Map();
    for (const r of res.reasons) byTeam.set(r.team, (byTeam.get(r.team) || 0) + 1);
    for (const [, n] of byTeam) assert.ok(n <= 5, `a team should not get ${n} reasons`);
    const keys = res.reasons.map((r) => `${r.team}:${r.title}`);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate reasons');
});

test('the most important reason comes first', async () => {
    const rankings = new Map();
    const specs = Array.from({ length: 12 }, (_, i) => ({
        name: `T${i + 1}`, players: [['RB', 4 + i], ['WR', 4 + i], ...BALANCED], wins: 3, losses: 3,
    }));
    const teams = league(rankings, specs);
    const res = await evaluateTrade({
        cfg, ctx, teams, rankings,
        schedule: syntheticSchedule(teams.map((t) => t.rosterId), 5, 14),
        iterations: 500,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 12, sending: [teams[11].players[13].id] },
        ],
    });
    // A trade this lopsided should lead with playoff impact or the lineup swing,
    // not with a footnote about roster fragility.
    assert.match(res.reasons[0].title, /playoff odds|pts\/week|hole at/);
});

// --- FAAB ------------------------------------------------------------------

const faabCfg = normalizeLeague({
    settings: { num_teams: 12, waiver_budget: 100, waiver_type: 2 },
    scoring_settings: { rec: 0.5, rush_yd: 0.1, rec_yd: 0.1 },
    roster_positions: defaultRosterPositions(),
});

/** A league whose teams carry real budgets, plus a priced FAAB model. */
function cashLeague({ budgets = [60, 60], claims = 6 } = {}) {
    const rankings = new Map();
    const teams = league(rankings, [
        { name: 'A', players: [['RB', 16], ['WR', 15], ...BALANCED], wins: 3, losses: 3 },
        { name: 'B', players: [['RB', 8], ['WR', 7], ...BALANCED], wins: 3, losses: 3 },
    ]);
    teams.forEach((t, i) => {
        t.faabRemaining = budgets[i] ?? 50;
        t.faabUsed = 100 - t.faabRemaining;
    });

    // Enough priced claims for the rate to be measured rather than guessed.
    const players = {};
    for (const t of teams) for (const p of t.players) players[p.id] = p;
    const claimable = teams[0].players.slice(0, claims);
    const transactions = claimable.map((p, i) => ({
        type: 'waiver',
        bid: 5 + i * 3,
        week: 3,
        movements: [{ player: p, to: 1, from: null }],
    }));

    const faab = faabModel({
        cfg: faabCfg, teams, transactions, players, ctx, rankings,
    });
    return { teams, rankings, faab, players };
}

test('cash carries value but scores no points', async () => {
    const { teams, rankings, faab } = cashLeague();
    assert.ok(faab?.usable, 'the fixture must actually price cash');

    const res = await evaluateTrade({
        cfg: faabCfg, ctx, teams, rankings, faab,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id], faab: 0 },
            { rosterId: 2, sending: [], faab: 40 },
        ],
    });

    assert.equal(res.ok, true, res.error);
    const [a, b] = res.sides;

    // Team A sends a starter and receives $40: value up on the cash, lineup
    // down on the player. Both, at once, is the honest picture.
    assert.ok(a.faabValueIn > 0, 'cash received is worth something');
    assert.equal(a.faabValueOut, 0);
    assert.ok(a.lineupNet < 0, 'cash does not fill the hole he left');
    assert.equal(b.faabOut, 40);
    assert.ok(b.valueOut > b.playerValueOut, 'the sender is charged for the cash');
});

test('a player-for-cash trade is a legal trade', async () => {
    const { teams, rankings, faab } = cashLeague();
    const res = await evaluateTrade({
        cfg: faabCfg, ctx, teams, rankings, faab,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [], faab: 25 },
        ],
    });
    assert.equal(res.ok, true, res.error);
});

test('a side sending neither a player nor cash is rejected', async () => {
    const { teams, rankings, faab } = cashLeague();
    const res = await evaluateTrade({
        cfg: faabCfg, ctx, teams, rankings, faab,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [], faab: 0 },
        ],
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /player or FAAB/);
});

test('nobody can send FAAB they do not have', async () => {
    const { teams, rankings, faab } = cashLeague({ budgets: [60, 12] });
    const res = await evaluateTrade({
        cfg: faabCfg, ctx, teams, rankings, faab,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [teams[1].players[0].id], faab: 40 },
        ],
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /only has \$12/);
});

test('cents and negative amounts are refused rather than rounded', async () => {
    const { teams, rankings, faab } = cashLeague();
    for (const bad of [12.5, -5]) {
        const res = await evaluateTrade({
            cfg: faabCfg, ctx, teams, rankings, faab,
            offers: [
                { rosterId: 1, sending: [teams[0].players[0].id], faab: bad },
                { rosterId: 2, sending: [teams[1].players[0].id] },
            ],
        });
        assert.equal(res.ok, false, `${bad} should be refused`);
        assert.match(res.error, /whole number/);
    }
});

test('cash cannot be traded in a league that does not use FAAB', async () => {
    const { teams, rankings, faab } = cashLeague();
    const res = await evaluateTrade({
        // Same rosters, rolling waivers.
        cfg, ctx, teams, rankings, faab,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id], faab: 10 },
            { rosterId: 2, sending: [teams[1].players[0].id] },
        ],
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /does not use FAAB/);
});

test('cash never triggers the roster crunch', async () => {
    // Cash takes no roster spot. A team at its roster limit receiving $50 must
    // not be charged for a cut it does not have to make -- that is the one
    // structural advantage cash has over a player and the engine has to know it.
    const { teams, rankings, faab } = cashLeague();
    const res = await evaluateTrade({
        cfg: faabCfg, ctx, teams, rankings, faab,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [], faab: 50 },
        ],
    });
    const a = res.sides.find((s) => s.team.rosterId === 1);
    assert.equal(a.overflow, 0);
    assert.equal(a.crunchCost, 0);
    assert.equal(a.rosterAfter, a.rosterBefore - 1, 'he sent a player and got no body back');
});

test('the same dollars are worth more to the team that can outbid the room', async () => {
    const rich = cashLeague({ budgets: [90, 90] });
    const poor = cashLeague({ budgets: [90, 4] });

    const evaluate = (fx) =>
        evaluateTrade({
            cfg: faabCfg, ctx, teams: fx.teams, rankings: fx.rankings, faab: fx.faab,
            offers: [
                { rosterId: 1, sending: [fx.teams[0].players[0].id] },
                { rosterId: 2, sending: [fx.teams[1].players[0].id], faab: 4 },
            ],
        });

    const [a, b] = await Promise.all([evaluate(rich), evaluate(poor)]);
    const cashTo = (res) => res.sides.find((s) => s.team.rosterId === 1).faabValueIn;
    assert.ok(cashTo(a) > 0 && cashTo(b) > 0);
});

test('the reasons explain the cash rather than restating it', async () => {
    const { teams, rankings, faab } = cashLeague();
    const res = await evaluateTrade({
        cfg: faabCfg, ctx, teams, rankings, faab,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [], faab: 30 },
        ],
    });
    const cashReason = res.reasons.find((r) => /FAAB/.test(r.title));
    assert.ok(cashReason, 'moving $30 has to be explained');
    assert.match(cashReason.detail, /median winning bid/, 'priced off the league’s own bids');
    assert.match(cashReason.detail, /roster spot/, 'and says what cash uniquely does not cost');
});

test('cash closes a gap no player on the roster can', async () => {
    const { teams, rankings, faab } = cashLeague({ budgets: [80, 80] });
    const res = await evaluateTrade({
        cfg: faabCfg, ctx, teams, rankings, faab,
        offers: [
            { rosterId: 1, sending: [teams[0].players[0].id] },
            { rosterId: 2, sending: [teams[1].players[0].id] },
        ],
    });
    const winner = res.sides.find((s) => s.team.rosterId === res.verdict.winner);
    const loser = res.sides.find((s) => s.team.rosterId === res.verdict.loser);
    if (!winner || !loser || res.verdict.gap <= 0.08) return;

    const cash = suggestFaab({ faab, giver: winner, receiver: loser, gap: Math.max(1, winner.valueNet) });
    assert.ok(cash, 'a funded team should always be able to offer cash');
    assert.ok(cash.dollars >= 1 && Number.isInteger(cash.dollars));
    assert.ok(cash.dollars <= winner.team.faabRemaining, 'and never more than it has');
    assert.match(cash.rationale, /lineup point/, 'the reason cash is the clean sweetener');
});

test('a broke team is not told to offer money', () => {
    const { teams, faab } = cashLeague({ budgets: [0, 80] });
    const giver = { team: teams[0], faabOut: 0 };
    const receiver = { team: teams[1] };
    assert.equal(suggestFaab({ faab, giver, receiver, gap: 50 }), null);
});

test('cash already in the deal is not offered a second time', () => {
    const { teams, faab } = cashLeague({ budgets: [20, 80] });
    const giver = { team: teams[0], faabOut: 20 };
    const receiver = { team: teams[1] };
    assert.equal(suggestFaab({ faab, giver, receiver, gap: 50 }), null, 'the budget is already committed');
});
