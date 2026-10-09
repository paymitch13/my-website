import test from 'node:test';
import assert from 'node:assert/strict';

import { seedOrder, toRankMap, toCsv, autoTiers, normalizeName, boardVintage, preseasonRanks } from '../js/rankings.js';
import { normalizeScoring } from '../js/league.js';

const players = {
    a: { id: 'a', name: 'Aaron Ace', pos: 'RB', team: 'KC', searchRank: 1 },
    b: { id: 'b', name: 'Bob Best', pos: 'RB', team: 'BUF', searchRank: 5 },
    c: { id: 'c', name: 'Carl Core', pos: 'RB', team: 'SF', searchRank: 9 },
    w1: { id: 'w1', name: "Dee'Andre O'Neal Jr.", pos: 'WR', team: 'MIA', searchRank: 2 },
    w2: { id: 'w2', name: 'Eli East', pos: 'WR', team: 'NYJ', searchRank: 7 },
};

test('seed order follows Sleeper search rank', () => {
    const o = seedOrder(players);
    assert.deepEqual(o.RB, ['a', 'b', 'c']);
    assert.deepEqual(o.WR, ['w1', 'w2']);
});

test('rank map is 1-indexed per position', () => {
    const m = toRankMap(seedOrder(players));
    assert.equal(m.get('a'), 1);
    assert.equal(m.get('c'), 3);
    assert.equal(m.get('w1'), 1, 'each position numbers from 1 independently');
});

test('name matching ignores suffixes, case and punctuation', () => {
    // Still used to join betting-market athletes to Sleeper players, which is
    // why it survives the removal of CSV import.
    assert.equal(normalizeName("Dee'Andre O'Neal Jr."), normalizeName('deeandre oneal'));
    assert.equal(normalizeName('A.J. Brown'), normalizeName('aj brown'));
});

test('auto tiers break at the biggest value gaps', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const values = { p1: 100, p2: 98, p3: 96, p4: 60, p5: 58, p6: 56 };
    const breaks = autoTiers(ids, (id) => values[id]);
    assert.deepEqual(breaks, [2], 'the cliff between p3 and p4 is the only real tier break');
});

test('auto tiers spread across the board instead of bunching at the top', () => {
    // A realistic decay curve: the steepest absolute drops are all at the top,
    // which is exactly the case that produces a wall of one-player tiers.
    const ids = Array.from({ length: 60 }, (_, i) => `p${i}`);
    const value = (id) => 100 * Math.exp(-0.06 * Number(id.slice(1)));
    const breaks = autoTiers(ids, value);
    assert.ok(breaks.length >= 2, 'should find some tiers');
    const sizes = [];
    let prev = -1;
    for (const b of [...breaks, ids.length - 1]) { sizes.push(b - prev); prev = b; }
    assert.ok(Math.min(...sizes) >= 2, `no tier may hold a single player, got sizes ${sizes}`);
    assert.ok(breaks[breaks.length - 1] > 12, `tiers must reach past the top of the board, last break ${breaks[breaks.length - 1]}`);
});

test('auto tiers no-op on a board too short to tier', () => {
    assert.deepEqual(autoTiers(['a', 'b'], () => 1), []);
});

test('csv export writes the model ranking, quoting awkward names', () => {
    // Export survived the board's removal: a ranking is still worth taking
    // somewhere else. Import did not -- there is nothing to import into.
    const tricky = { ...players, x: { id: 'x', name: 'Smith, John', pos: 'TE', team: 'LV', searchRank: 3 } };
    const csv = toCsv({ TE: ['x'], RB: ['a', 'b'] }, tricky);
    assert.match(csv, /"Smith, John"/);
    assert.match(csv, /Aaron Ace/);
    // One header plus one line per ranked player.
    assert.equal(csv.trim().split('\n').length, 4);
});

// --- What the board says it knows -----------------------------------------

test('the vintage line states the week, the games and both weights', () => {
    const line = boardVintage({ lastPlayed: 4, season: 2026, games: 4, market: true });
    assert.match(line, /through week 4 of 2026/i);
    // actualsWeight(4) = 4/9 = 44%.
    assert.match(line, /4 games/);
    assert.match(line, /44%/);
    // MARKET_WEIGHT = 0.65, stated as the split it actually is.
    assert.match(line, /35\/65/);
});

test('the vintage line does not claim results before any are played', () => {
    const line = boardVintage({ lastPlayed: 0, season: 2026, market: true });
    assert.match(line, /nothing has been played/i);
    assert.doesNotMatch(line, /through week/i);
});

test('the vintage line says so when the market could not be reached', () => {
    const line = boardVintage({ lastPlayed: 4, season: 2026, games: 4, market: false });
    assert.match(line, /projection and results only/i);
    assert.doesNotMatch(line, /35\/65/);
});

test('the vintage line never passes off the fallback model as projections', () => {
    const line = boardVintage({ lastPlayed: 4, season: 2026, games: 4, market: true, projected: false });
    assert.match(line, /fallback rank model/i);
    assert.doesNotMatch(line, /44%/);
});

test('one game is described as one game, not "1 games"', () => {
    assert.match(boardVintage({ lastPlayed: 1, season: 2026, games: 1, market: true }), /one game/);
});

// --- Where the board had them in August -----------------------------------

const scoring = normalizeScoring({ rush_yd: 0.1 });
const ladder = (yards) => {
    const projections = {};
    yards.forEach((y, i) => {
        projections[`rb${i}`] = { id: `rb${i}`, pos: 'RB', games: 17, stats: { rush_yd: y } };
    });
    return projections;
};

test('preseason ranks follow the preseason projection, not today’s order', () => {
    // Today's board has them backwards against their projections.
    const ids = ['rb2', 'rb1', 'rb0'];
    const was = preseasonRanks(ids, { projections: ladder([1700, 1200, 600]), scoring });
    assert.equal(was.get('rb0'), 1, 'the best projection was first in August');
    assert.equal(was.get('rb1'), 2);
    assert.equal(was.get('rb2'), 3);
});

test('players the projection cannot separate are not reported as moving', () => {
    // This is what broke the curve-lookup version: six identical projections
    // all came back with the rank of the first of them, so the five below read
    // as having fallen past each other on a week where nobody played.
    const yards = [1700, 1600, 900, 900, 900, 900, 900, 900, 400, 300];
    const ids = yards.map((_, i) => `rb${i}`);
    const was = preseasonRanks(ids, { projections: ladder(yards), scoring });
    for (const [i, id] of ids.entries()) {
        assert.equal(was.get(id) - (i + 1), 0, `${id} must show no move`);
    }
});

test('a player August never projected has no preseason position', () => {
    const projections = ladder([1700, 1200]);
    const was = preseasonRanks(['rb0', 'unknown', 'rb1'], { projections, scoring });
    assert.equal(was.has('unknown'), false, 'nothing to compare, so nothing is claimed');
    // And he does not displace anybody: the ranks stay on the board's scale.
    assert.equal(was.get('rb0'), 1);
    assert.equal(was.get('rb1'), 2);
});

test('the unprojected sit at the bottom, where the board already has them', () => {
    const was = preseasonRanks(['rb0', 'ghost', 'rb1'], { projections: ladder([600, 1700]), scoring });
    // rb1 outprojects rb0, so August had rb1 first and rb0 second; the ghost
    // takes the remaining place rather than one in the middle.
    assert.equal(was.get('rb1'), 1);
    assert.equal(was.get('rb0'), 2);
    assert.equal(was.size, 2);
});

test('an empty board is not an error', () => {
    assert.equal(preseasonRanks([], { projections: {}, scoring }).size, 0);
    assert.equal(preseasonRanks(['x'], { projections: null, scoring }).size, 0);
});
