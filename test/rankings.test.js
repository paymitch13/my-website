import test from 'node:test';
import assert from 'node:assert/strict';

import { seedOrder, toRankMap, toCsv, autoTiers, normalizeName } from '../js/rankings.js';

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
