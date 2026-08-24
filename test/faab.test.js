import test from 'node:test';
import assert from 'node:assert/strict';

import {
    observedFaabRate, marketClearingRate, effectiveFaabRate, meanRemaining,
    faabModel, describeFaab, bidHistory, waiverTargets, estimateBid, MIN_OBSERVATIONS,
} from '../js/faab.js';
import { createValuationContext } from '../js/valuation.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';

const projections = {};
let uid = 0;
const mk = (pos, ppg) => {
    const id = `p${++uid}`;
    projections[id] = { id, pos, games: 17, stats: { rush_yd: ppg * 170 }, ptsHalfPpr: 1 };
    return { id, name: `${pos}-${ppg}`, pos, team: 'KC', age: 26, injury: null };
};

const faabLeague = (over = {}) =>
    normalizeLeague({
        settings: { num_teams: 12, waiver_budget: 100, waiver_type: 2, trade_deadline: 12, ...over },
        scoring_settings: { rush_yd: 0.1, rec: 0.5 },
        roster_positions: defaultRosterPositions(),
    });

/** A completed waiver claim of `player` for `bid`. */
const claim = (player, bid, week = 5) => ({
    type: 'waiver',
    bid,
    week,
    movements: [{ player, to: 1, from: null }],
});

function world(specs) {
    const players = {};
    const rankings = new Map();
    const list = specs.map(([pos, ppg]) => mk(pos, ppg));
    const byPos = {};
    for (const p of list) {
        players[p.id] = p;
        (byPos[p.pos] ||= []).push(p);
    }
    for (const group of Object.values(byPos)) {
        group.sort((a, b) => projections[b.id].stats.rush_yd - projections[a.id].stats.rush_yd);
        group.forEach((p, i) => rankings.set(p.id, i + 1));
    }
    return { players, rankings, list };
}

// --- League settings -------------------------------------------------------

test('FAAB is only recognised where the league actually uses it', () => {
    assert.equal(faabLeague().usesFaab, true);
    assert.equal(faabLeague().faabBudget, 100);

    // Rolling waivers with a leftover budget in settings is NOT a FAAB league,
    // and every cash feature has to stay off. Reading the budget alone would
    // turn cash on for a league that cannot spend it.
    assert.equal(faabLeague({ waiver_type: 0 }).usesFaab, false);
    assert.equal(faabLeague({ waiver_type: 1 }).usesFaab, false);
    // FAAB nominally on with no money is also not a FAAB league.
    assert.equal(faabLeague({ waiver_budget: 0 }).usesFaab, false);
});

test('waiver settings survive normalization', () => {
    const cfg = faabLeague({ waiver_day_of_week: 3, waiver_clear_days: 2 });
    assert.equal(cfg.waiverDay, 3);
    assert.equal(cfg.waiverClearDays, 2);
    assert.equal(cfg.tradeDeadline, 12);
});

// --- Observed rate ---------------------------------------------------------

test('the rate is fitted from the league’s own winning bids', () => {
    const cfg = faabLeague();
    const { players, rankings, list } = world([['RB', 14], ['WR', 12], ['WR', 10], ['RB', 9], ['TE', 8]]);
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });

    // Bids roughly proportional to value: the fit should recover the slope.
    const tx = list.map((p, i) => claim(p, (i + 1) * 5));
    const fit = observedFaabRate(tx, players, ctx, rankings);

    assert.ok(fit, 'five priced claims is enough to fit');
    assert.equal(fit.samples, 5);
    assert.ok(fit.rate > 0, 'a dollar buys something');
    assert.equal(fit.max, 25);
});

test('too little history is reported as no measurement, not a bad one', () => {
    const cfg = faabLeague();
    const { players, rankings, list } = world([['RB', 14], ['WR', 12]]);
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });
    assert.ok(list.length < MIN_OBSERVATIONS);
    assert.equal(observedFaabRate(list.map((p) => claim(p, 10)), players, ctx, rankings), null);
});

test('free agent pickups are not bids and do not drag the fit down', () => {
    const cfg = faabLeague();
    const { players, rankings, list } = world([['RB', 14], ['WR', 12], ['WR', 10], ['RB', 9], ['TE', 8]]);
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });

    const real = list.map((p, i) => claim(p, (i + 1) * 5));
    const withFreebies = [
        ...real,
        ...list.map((p) => ({ type: 'free_agent', bid: null, week: 6, movements: [{ player: p, to: 2, from: null }] })),
    ];

    const a = observedFaabRate(real, players, ctx, rankings);
    const b = observedFaabRate(withFreebies, players, ctx, rankings);
    assert.equal(b.samples, a.samples, 'costless adds are not price observations');
    assert.equal(b.rate, a.rate);
});

test('the fit passes through the origin: a bigger bid buys proportionally more', () => {
    const cfg = faabLeague();
    const { players, rankings, list } = world([['RB', 14], ['WR', 13], ['WR', 12], ['RB', 11]]);
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });
    const fit = observedFaabRate(list.map((p, i) => claim(p, 10 + i)), players, ctx, rankings);

    // No intercept means value is strictly proportional to dollars: $20 is
    // exactly twice $10, with no entry fee and nothing free.
    assert.ok(Math.abs(fit.rate * 20 - 2 * (fit.rate * 10)) < 1e-9);
});

// --- Market clearing fallback ---------------------------------------------

test('with no bid history, cash is priced against the free agent pool', () => {
    const cfg = faabLeague();
    const teams = [
        { rosterId: 1, faabRemaining: 100 },
        { rosterId: 2, faabRemaining: 100 },
    ];
    const freeAgents = [
        { player: mk('RB', 12), score: 12, value: 40 },
        { player: mk('WR', 10), score: 10, value: 20 },
    ];
    const rate = marketClearingRate({ freeAgents, teams, cfg });
    assert.ok(rate > 0);
    // 60 points of value chasing $200 is 0.3 a dollar. More cash, cheaper points.
    assert.ok(Math.abs(rate - 60 / 200) < 1e-9);

    const richer = marketClearingRate({
        freeAgents,
        teams: teams.map((t) => ({ ...t, faabRemaining: 200 })),
        cfg,
    });
    assert.ok(richer < rate, 'the same pool split over more money is worth less per dollar');
});

test('a league with nothing left to spend has no clearing rate', () => {
    const cfg = faabLeague();
    const freeAgents = [{ player: mk('RB', 12), score: 12, value: 40 }];
    assert.equal(marketClearingRate({ freeAgents, teams: [{ rosterId: 1, faabRemaining: 0 }], cfg }), null);
});

// --- Effective rate --------------------------------------------------------

test('cash decays as the season runs out', () => {
    const early = effectiveFaabRate({ rate: 1, remaining: 50, leagueMean: 50, weeksLeft: 12 });
    const late = effectiveFaabRate({ rate: 1, remaining: 50, leagueMean: 50, weeksLeft: 2 });
    assert.ok(late < early, 'a dollar in week 14 has fewer weeks to cash in');
    assert.equal(effectiveFaabRate({ rate: 1, remaining: 50, leagueMean: 50, weeksLeft: 0 }), 0,
        'FAAB expires worthless');
});

test('the first dollars are worth more than the last', () => {
    const opts = { rate: 1, leagueMean: 50, weeksLeft: 10 };
    const broke = effectiveFaabRate({ ...opts, remaining: 4 });
    const average = effectiveFaabRate({ ...opts, remaining: 50 });
    const loaded = effectiveFaabRate({ ...opts, remaining: 200 });

    assert.ok(broke < average, 'a team at $4 cannot win a contested claim');
    assert.ok(loaded > average);
    // Concave: quadrupling the budget does not quadruple the per-dollar rate.
    assert.ok(loaded < average * 4, 'the marginal dollar is not the average dollar');
});

test('a team with no money has worthless cash', () => {
    assert.equal(effectiveFaabRate({ rate: 2, remaining: 0, leagueMean: 50, weeksLeft: 10 }), 0);
});

// --- The assembled model ---------------------------------------------------

test('the model is null in a league that does not use FAAB', () => {
    assert.equal(faabModel({ cfg: faabLeague({ waiver_type: 0 }), teams: [], ctx: { weeksLeft: 8 } }), null);
});

test('the model prices a specific team’s dollars and says where the number came from', () => {
    const cfg = faabLeague();
    const { players, rankings, list } = world([['RB', 14], ['WR', 12], ['WR', 10], ['RB', 9], ['TE', 8]]);
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });
    const teams = [
        { rosterId: 1, faabRemaining: 80 },
        { rosterId: 2, faabRemaining: 20 },
    ];

    const model = faabModel({
        cfg, teams, players, ctx, rankings,
        transactions: list.map((p, i) => claim(p, (i + 1) * 5)),
    });

    assert.equal(model.usable, true);
    assert.equal(model.source, 'observed');
    assert.equal(model.samples, 5);
    assert.equal(meanRemaining(teams), 50);

    const rich = model.valueOf(10, teams[0]);
    const poor = model.valueOf(10, teams[1]);
    assert.ok(rich > poor, 'the same $10 does more for the team that can outbid the room');
    assert.ok(model.valueOf(0, teams[0]) === 0);
});

test('the cash sentence says what it is worth, on what basis, and what it is not', () => {
    const cfg = faabLeague();
    const { players, rankings, list } = world([['RB', 14], ['WR', 12], ['WR', 10], ['RB', 9], ['TE', 8]]);
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });
    const teams = [{ rosterId: 1, faabRemaining: 50 }];
    const model = faabModel({ cfg, teams, players, ctx, rankings, transactions: list.map((p, i) => claim(p, (i + 1) * 5)) });

    const text = describeFaab(model, 25, teams[0]);
    assert.match(text, /\$25/);
    assert.match(text, /median winning bid/, 'it names the evidence, not a magic number');
    assert.match(text, /a week/, 'and gives the weekly figure a manager can compare a starter against');
    assert.match(text, /does not take a roster spot/, 'the one real advantage cash has');
});

// --- What the cash buys ----------------------------------------------------

function pricedModel(bids = [4, 9, 14, 22, 31, 6]) {
    const cfg = faabLeague();
    const specs = bids.map((_, i) => ['WR', 16 - i]);
    const { players, rankings, list } = world(specs);
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });
    const teams = [{ rosterId: 1, faabRemaining: 60 }, { rosterId: 2, faabRemaining: 40 }];
    const model = faabModel({
        cfg, teams, players, ctx, rankings,
        transactions: list.map((p, i) => claim(p, bids[i])),
    });
    return { cfg, ctx, model, players, rankings, list, teams };
}

test('bid history answers “what does this league actually pay”', () => {
    const { model } = pricedModel();
    const history = bidHistory(model);

    assert.ok(history, 'six priced claims is a history');
    assert.equal(history.samples, 6);
    assert.equal(history.max, 31, 'the ceiling is a fact, not an estimate');
    assert.equal(history.tiers.length, 3, 'starters, contributors, fliers');
    for (const tier of history.tiers) {
        assert.ok(tier.count > 0);
        assert.ok(tier.median >= tier.min && tier.median <= tier.max);
        assert.ok(tier.topPlayer, 'each tier names the priciest claim in it');
    }
    assert.equal(history.richest.bid, 31);
});

test('a league that has never bid has no history to show', () => {
    const cfg = faabLeague();
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });
    const model = faabModel({ cfg, teams: [{ rosterId: 1, faabRemaining: 100 }], players: {}, ctx, rankings: new Map(), transactions: [] });
    assert.equal(bidHistory(model), null);
});

test('waiver targets are ranked by what they add to THIS lineup', () => {
    const cfg = faabLeague();
    const ctx = createValuationContext(cfg, { week: 5, weeksLeft: 9, projections });

    // A roster stacked at receiver and bare at running back.
    const roster = world([['QB', 20], ['WR', 18], ['WR', 17], ['WR', 16], ['RB', 4], ['TE', 9]]);
    const entries = roster.list.map((p) => ({
        player: p,
        score: projections[p.id].stats.rush_yd / 170,
        value: 40,
    }));

    const faPool = world([['WR', 13], ['RB', 12]]);
    const freeAgents = faPool.list.map((p) => ({
        player: p,
        posRank: 20,
        score: projections[p.id].stats.rush_yd / 170,
        value: 30,
    }));

    const targets = waiverTargets({ freeAgents, entries, cfg });
    assert.ok(targets.length > 0);
    // Equal value on paper; only one of them starts. The better receiver is
    // worth less to this team than the worse back, and raw value cannot see it.
    assert.equal(targets[0].player.pos, 'RB', `expected the back first, got ${targets[0].player.pos}`);
    assert.ok(targets[0].gain > 0);
});

test('a target nobody could start is not a target', () => {
    const cfg = faabLeague();
    // Every starting slot filled, flex included: an empty slot makes ANY body
    // an upgrade, which is true but not what this test is about.
    const roster = world([
        ['QB', 22], ['RB', 20], ['RB', 19], ['RB', 18],
        ['WR', 20], ['WR', 19], ['WR', 18], ['TE', 14],
    ]);
    const entries = roster.list.map((p) => ({ player: p, score: projections[p.id].stats.rush_yd / 170, value: 60 }));
    const scrub = world([['WR', 1]]);
    const freeAgents = scrub.list.map((p) => ({ player: p, posRank: 90, score: 1, value: 1 }));
    assert.deepEqual(waiverTargets({ freeAgents, entries, cfg }), []);
});

test('a bid estimate never quotes a price this league has never paid', () => {
    const { model } = pricedModel();
    // A player worth far more than anything claimed this season.
    const estimate = estimateBid(model, { value: 100000 });
    assert.ok(estimate.capped, 'the extrapolation has to be flagged');
    assert.equal(estimate.dollars, model.max, 'and clamped to the observed ceiling');
    assert.ok(estimate.dollars <= 31);
});

test('a bid estimate for an ordinary target sits inside the observed range', () => {
    const { model, list, ctx, rankings } = pricedModel();
    const mid = { value: 30 };
    const estimate = estimateBid(model, mid);
    assert.ok(estimate.dollars >= 1);
    assert.ok(Number.isInteger(estimate.dollars));
});
