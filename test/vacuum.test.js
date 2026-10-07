import test from 'node:test';
import assert from 'node:assert/strict';

import {
    shapeToCfg, describeShape, scoreVacuumTrade, vacuumVerdict,
    DEFAULT_SHAPE, PPR_PRESETS, buildVacuumContext,
} from '../js/vacuum.js';
import { createValuationContext, valuePlayer } from '../js/valuation.js';
import { scoreStats } from '../js/projections.js';

const p = (id, pos, name = id) => ({ id, name, pos, team: 'KC', age: 26, injury: null });
/** Price straight off the entry, so these tests measure the ledger not the scale. */
const price = (e) => e.value;

test('a trade is scored from players alone, with no roster anywhere', () => {
    const res = scoreVacuumTrade({
        a: [{ player: p('a1', 'RB'), value: 6000 }],
        b: [{ player: p('b1', 'WR'), value: 3000 }, { player: p('b2', 'WR'), value: 3000 }],
        price,
    });
    // A sends 6000 and so RECEIVES 6000 -- the inversion everybody gets wrong.
    assert.equal(res.receivesA, 6000);
    assert.equal(res.receivesB, 6000);
    assert.equal(res.gap, 0);
    assert.equal(res.winner, null);
});

test('who receives what is not confused with who sends what', () => {
    const res = scoreVacuumTrade({
        a: [{ player: p('cheap', 'WR'), value: 1000 }],
        b: [{ player: p('stud', 'RB'), value: 9000 }],
        price,
    });
    assert.equal(res.receivesA, 9000, 'A sent the cheap player, so A receives the stud');
    assert.equal(res.receivesB, 1000);
    assert.equal(res.winner, 'a');
});

test('the best player in the deal is named, and which side gets him', () => {
    const res = scoreVacuumTrade({
        a: [{ player: p('a1', 'RB', 'Sent Away'), value: 8000 }],
        b: [{ player: p('b1', 'WR'), value: 4000 }, { player: p('b2', 'WR'), value: 4000 }],
        price,
    });
    assert.equal(res.best.player.name, 'Sent Away');
    assert.equal(res.best.to, 'b', 'A sent him, so B receives him');
    assert.equal(res.best.clear, true, '8000 against 4000 is a clear best player');
});

test('a level field does not claim anybody got the best player', () => {
    const res = scoreVacuumTrade({
        a: [{ player: p('a1', 'RB'), value: 5000 }],
        b: [{ player: p('b1', 'WR'), value: 4800 }],
        price,
    });
    assert.equal(res.best.clear, false, '4% apart is not a clear best player');
});

test('an empty side is reported rather than scored as a shutout', () => {
    const res = scoreVacuumTrade({ a: [], b: [{ player: p('b1', 'WR'), value: 100 }], price });
    assert.equal(res.empty, true);
    assert.equal(vacuumVerdict(res).label, 'Incomplete');
});

test('players are listed best first on each side', () => {
    const res = scoreVacuumTrade({
        a: [
            { player: p('small', 'WR'), value: 100 },
            { player: p('big', 'RB'), value: 900 },
            { player: p('mid', 'TE'), value: 500 },
        ],
        b: [{ player: p('b1', 'WR'), value: 1500 }],
        price,
    });
    assert.deepEqual(res.sentA.map((r) => r.player.id), ['big', 'mid', 'small']);
});

// --- Verdict bands ---------------------------------------------------------

test('the verdict bands follow the gap, and name the winning side', () => {
    const at = (ra, rb) =>
        vacuumVerdict(
            scoreVacuumTrade({
                a: [{ player: p('a', 'RB'), value: rb }],
                b: [{ player: p('b', 'WR'), value: ra }],
                price,
            }),
            { labelA: 'Me', labelB: 'Them' }
        );

    assert.equal(at(1000, 1000).label, 'Even');
    assert.match(at(1000, 900).label, /Me/);
    assert.equal(at(1000, 900).tone, 'warn');
    // 1000 against 800 is a 20% gap: won, but not a fleecing.
    assert.match(at(1000, 800).label, /Me wins it/);
    // 1000 against 500 is 50%, which is.
    assert.match(at(1000, 500).label, /fleeces/);
    assert.equal(at(1000, 200).tone, 'bad');
    // And the loser is named in the sentence that tells them to pass.
    assert.match(at(1000, 800).headline, /Them needs a reason beyond value/);
});

test('every verdict names a side rather than saying "Side A" regardless', () => {
    const res = scoreVacuumTrade({
        a: [{ player: p('a', 'RB'), value: 100 }],
        b: [{ player: p('b', 'WR'), value: 5000 }],
        price,
    });
    const v = vacuumVerdict(res, { labelA: 'Pay', labelB: 'Rival' });
    assert.match(v.headline, /Pay/);
    assert.ok(!v.headline.includes('Side A'), 'the custom labels must be used throughout');
});

// --- Format is what actually moves these numbers ---------------------------

test('a format produces a usable league with no Sleeper league anywhere', () => {
    const cfg = shapeToCfg(DEFAULT_SHAPE);
    assert.equal(cfg.teams, 12);
    assert.ok(cfg.starterSlots.includes('FLEX'));
    assert.ok(!cfg.starterSlots.includes('SUPER_FLEX'));
    assert.equal(cfg.scoring.rec, 0.5);
});

test('superflex swaps the flex rather than adding a slot', () => {
    const one = shapeToCfg({ superflex: false });
    const two = shapeToCfg({ superflex: true });
    assert.equal(one.starterSlots.length, two.starterSlots.length);
    assert.ok(two.starterSlots.includes('SUPER_FLEX'));
});

test('superflex is worth roughly double for a quarterback', () => {
    // The single biggest format effect there is, and the reason the knob has
    // to exist: a QB2 is a bench body in one format and a starter in the other.
    const projections = {};
    for (let i = 1; i <= 30; i++) {
        projections[`qb${i}`] = { id: `qb${i}`, pos: 'QB', games: 17, stats: { pass_yd: 4800 - i * 120, pass_td: 38 - i } };
    }
    for (let i = 1; i <= 60; i++) {
        projections[`rb${i}`] = { id: `rb${i}`, pos: 'RB', games: 17, stats: { rush_yd: 1400 - i * 18 } };
        projections[`wr${i}`] = { id: `wr${i}`, pos: 'WR', games: 17, stats: { rec_yd: 1400 - i * 18, rec: 95 - i } };
    }

    const valueOf = (superflex) => {
        const cfg = shapeToCfg({ superflex });
        const ctx = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });
        return valuePlayer(p('qb14', 'QB'), 14, ctx).value;
    };

    const single = valueOf(false);
    const sf = valueOf(true);
    assert.ok(sf > single, `QB14 must be worth more in superflex: ${sf} vs ${single}`);
    assert.ok(sf > single * 1.5, `and substantially more, got ${(sf / single).toFixed(2)}x`);
});

test('a TE premium reaches the scoring rather than being a label', () => {
    const plain = shapeToCfg({ tePremium: 0 });
    const prem = shapeToCfg({ tePremium: 1 });
    assert.equal(prem.scoring.bonus_rec_te, 1);
    // And it scores. Sleeper's projection rows carry a `bonus_rec_te` stat
    // equal to the reception count, which is how a TE premium reaches the
    // numbers at all: it rides the same dot product as every other rule, with
    // no special casing. So the stat line here mirrors a real row rather than
    // carrying `rec` alone. A premium that does not show up in the dot product
    // is decoration.
    const line = { rec: 80, bonus_rec_te: 80, rec_yd: 900 };
    assert.equal(
        scoreStats(line, prem.scoring) - scoreStats(line, plain.scoring),
        80
    );
});

test('full PPR is worth more than standard to a receiver', () => {
    const rec = (id) => PPR_PRESETS.find((x) => x.id === id).rec;
    const line = { rec: 100, rec_yd: 1200 };
    assert.ok(
        scoreStats(line, shapeToCfg({ ppr: 'full' }).scoring) >
            scoreStats(line, shapeToCfg({ ppr: 'std' }).scoring)
    );
    assert.equal(rec('std'), 0);
    assert.equal(rec('full'), 1);
});

test('dynasty is carried into the config, since it changes what value means', () => {
    assert.equal(shapeToCfg({ dynasty: true }).format === 'redraft', false);
    assert.equal(shapeToCfg({ dynasty: false }).format, 'redraft');
});

test('team count is clamped to something a league could be', () => {
    assert.equal(shapeToCfg({ teams: 2 }).teams, 4);
    assert.equal(shapeToCfg({ teams: 400 }).teams, 20);
    assert.equal(shapeToCfg({ teams: 10 }).teams, 10);
});

test('the format is described in the words managers use for it', () => {
    assert.equal(describeShape({ teams: 12, ppr: 'half' }), '12-team · Half PPR · redraft');
    assert.match(describeShape({ superflex: true }), /superflex/);
    assert.match(describeShape({ tePremium: 0.5 }), /TE \+0\.5/);
    assert.match(describeShape({ dynasty: true }), /dynasty/);
});

// --- Pricing a player under a chosen format, with no league at all ---------

/** A pool big enough that replacement level means something at every position. */
function pool() {
    const players = {};
    const projections = {};
    const add = (pos, i, stats) => {
        const id = `${pos}${i}`;
        players[id] = { id, name: `${pos} ${i}`, pos, team: 'KC', age: 26, injury: null, searchRank: i };
        projections[id] = { id, pos, games: 17, stats };
    };
    for (let i = 1; i <= 32; i++) add('QB', i, { pass_yd: 4800 - i * 110, pass_td: 38 - i });
    for (let i = 1; i <= 70; i++) add('RB', i, { rush_yd: 1500 - i * 17, rec: 50 - i * 0.4, bonus_rec_te: 0 });
    for (let i = 1; i <= 80; i++) add('WR', i, { rec_yd: 1500 - i * 15, rec: 100 - i * 0.8 });
    for (let i = 1; i <= 32; i++) add('TE', i, { rec_yd: 1000 - i * 25, rec: 85 - i * 2, bonus_rec_te: 85 - i * 2 });
    return { players, projections };
}

/**
 * A market spanning the whole pool, descending by position rank.
 *
 * Has to be league-wide: `createTradeValueScale` calibrates the display scale
 * against the market's own curve, so a market containing only one position
 * makes that position's best player the most valuable asset in the sport. It
 * also needs at least eight entries, below which the scale cannot calibrate
 * at all and no market pricing is offered.
 */
function wholeMarket(players, overrides = {}) {
    const byId = new Map();
    const ranks = new Map();
    const perPos = {};
    const ordered = Object.values(players).sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
    for (const p of ordered) {
        const rank = (perPos[p.pos] = (perPos[p.pos] ?? 0) + 1);
        const value = overrides[p.id] ?? Math.max(20, Math.round(9000 * Math.exp(-0.06 * rank)));
        byId.set(p.id, { id: p.id, value, posRank: rank, pos: p.pos });
        ranks.set(p.id, rank);
    }
    return { byId, ranks };
}

test('a player can be priced with no league, no roster and no board', () => {
    const { players, projections } = pool();
    const v = buildVacuumContext({ players, projections, shape: DEFAULT_SHAPE });
    const price = v.pricePlayer(players.WR1);
    assert.ok(price > 0 && Number.isFinite(price), `WR1 must carry a price, got ${price}`);
    // And the best player at a position outranks the worst by a wide margin.
    assert.ok(v.pricePlayer(players.WR1) > v.pricePlayer(players.WR70) * 3);
});

test('the vacuum ignores the user’s board entirely', () => {
    // The whole point: "who won this trade" must not move because the person
    // asking happens to rank somebody low. There is no board input at all, so
    // the only way to verify is that identical inputs give identical prices.
    const { players, projections } = pool();
    const a = buildVacuumContext({ players, projections });
    const b = buildVacuumContext({ players, projections });
    assert.equal(a.pricePlayer(players.RB5), b.pricePlayer(players.RB5));
});

test('changing the format changes what a quarterback costs', () => {
    const { players, projections } = pool();
    const single = buildVacuumContext({ players, projections, shape: { superflex: false } });
    const sf = buildVacuumContext({ players, projections, shape: { superflex: true } });
    const one = single.pricePlayer(players.QB12);
    const two = sf.pricePlayer(players.QB12);
    assert.ok(two > one, `QB12 must cost more in superflex: ${two} vs ${one}`);
});

test('a TE premium raises tight ends and not running backs', () => {
    const { players, projections } = pool();
    const plain = buildVacuumContext({ players, projections, shape: { tePremium: 0 } });
    const prem = buildVacuumContext({ players, projections, shape: { tePremium: 1 } });

    const teLift = prem.pricePlayer(players.TE4) / plain.pricePlayer(players.TE4);
    const rbLift = prem.pricePlayer(players.RB4) / plain.pricePlayer(players.RB4);
    assert.ok(teLift > rbLift, `a TE premium must favour tight ends: TE ${teLift.toFixed(2)}x vs RB ${rbLift.toFixed(2)}x`);
});

test('a full trade can be scored end to end from a format and two lists', () => {
    const { players, projections } = pool();
    const v = buildVacuumContext({ players, projections });
    const entry = (id) => ({ player: players[id], value: v.pricePlayer(players[id]) });

    const res = scoreVacuumTrade({
        a: [entry('WR1')],
        b: [entry('RB6'), entry('TE8')],
        price: (e) => e.value,
    });
    assert.ok(!res.empty);
    assert.ok(res.receivesA > 0 && res.receivesB > 0);
    const verdict = vacuumVerdict(res, { labelA: 'Me', labelB: 'Them' });
    assert.ok(verdict.headline.length > 20, 'a verdict must come with a reason');
    assert.ok(['neutral', 'warn', 'bad'].includes(verdict.tone));
});

test('a format knob the market cannot express still moves prices', () => {
    // Everywhere else in the app an observed market price wins outright,
    // because the question is "what will his manager ask". Here the question
    // is "what is he worth under THIS format", and FantasyCalc can only be
    // queried for team count, quarterback count, PPR and dynasty -- it has no
    // concept of a TE premium. Market-first pricing therefore made that
    // control inert, which a browser test caught when switching to superflex
    // changed nothing at all.
    const { players, projections } = pool();
    // Same market for both shapes, which is exactly the situation: the market
    // cannot be re-queried for a premium it does not model. It has to span the
    // whole player pool, not one position -- the display scale calibrates
    // against the market's own curve, so a ten-entry market of tight ends
    // would make the best tight end the most valuable asset in football.
    const market = wholeMarket(players);

    const plain = buildVacuumContext({ players, projections, market, shape: { tePremium: 0 } });
    const prem = buildVacuumContext({ players, projections, market, shape: { tePremium: 1 } });

    const te = players.TE4;
    assert.ok(
        prem.pricePlayer(te) > plain.pricePlayer(te),
        `a TE premium must raise a tight end even with an identical market: ` +
            `${plain.pricePlayer(te)} -> ${prem.pricePlayer(te)}`
    );
});

test('the market acts as a floor, not a ceiling, in the vacuum', () => {
    // A bench player whose format-derived value is nothing keeps his market
    // price; a player the format rates highly is not held down to it.
    const { players, projections } = pool();
    const deep = players.WR70;
    const market = wholeMarket(players, { [deep.id]: 450 });
    const v = buildVacuumContext({ players, projections, market });

    assert.ok(v.pricePlayer(deep) >= 400, `his market price must survive: got ${v.pricePlayer(deep)}`);
    // And the best receiver, whom the market here does not price at all, is
    // still worth far more than the floor.
    assert.ok(v.pricePlayer(players.WR1) > v.pricePlayer(deep) * 3);
});
