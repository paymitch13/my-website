import test from 'node:test';
import assert from 'node:assert/strict';

import { seedOrder, mergeOrder, toRankMap, reorder, nudge, toCsv, fromCsv, autoTiers, normalizeName } from '../js/rankings.js';

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

test('reorder moves a player and shifts everyone else', () => {
    const o = seedOrder(players);
    const moved = reorder(o, 'RB', 'c', 0);
    assert.deepEqual(moved.RB, ['c', 'a', 'b']);
    assert.deepEqual(o.RB, ['a', 'b', 'c'], 'original order is not mutated');
});

test('nudge moves by relative spots and clamps at the ends', () => {
    const o = seedOrder(players);
    assert.deepEqual(nudge(o, 'RB', 'a', -1).RB, ['a', 'b', 'c'], 'cannot go above first');
    assert.deepEqual(nudge(o, 'RB', 'a', 1).RB, ['b', 'a', 'c']);
    assert.deepEqual(nudge(o, 'RB', 'a', 99).RB, ['b', 'c', 'a']);
});

test('merge keeps the saved board and slots new players in by seed rank', () => {
    const saved = { RB: ['c', 'a'], WR: ['w2'] };
    const merged = mergeOrder(saved, players);
    // The user hand-ranked 'c' first even though Sleeper seeds him third.
    // Newcomer 'b' must slot in below every player the user actually ranked
    // ahead of him, and must never displace the user's #1.
    assert.deepEqual(merged.RB, ['c', 'a', 'b']);
    assert.deepEqual(merged.WR, ['w1', 'w2'], 'w1 seeds ahead of w2');
});

test('merge drops players who are no longer in the database', () => {
    const merged = mergeOrder({ RB: ['ghost', 'a', 'b', 'c'] }, players);
    assert.ok(!merged.RB.includes('ghost'));
    assert.equal(merged.RB[0], 'a');
});

test('csv round-trips exactly', () => {
    const order = { RB: ['b', 'a', 'c'], WR: ['w1'] };
    const parsed = fromCsv(toCsv(order, players), players);
    assert.deepEqual(parsed.order.RB, ['b', 'a', 'c']);
    assert.deepEqual(parsed.order.WR, ['w1']);
    assert.equal(parsed.unmatched.length, 0);
});

test('csv export quotes names containing commas', () => {
    const tricky = { ...players, x: { id: 'x', name: 'Smith, John', pos: 'TE', team: 'LV', searchRank: 3 } };
    const csv = toCsv({ TE: ['x'] }, tricky);
    assert.match(csv, /"Smith, John"/);
    assert.deepEqual(fromCsv(csv, tricky).order.TE, ['x']);
});

test('csv import matches by name when there is no id column', () => {
    const csv = 'Rank,Player,Pos\n1,Carl Core,RB1\n2,Aaron Ace,RB2\n';
    const parsed = fromCsv(csv, players);
    assert.deepEqual(parsed.order.RB, ['c', 'a']);
    assert.equal(parsed.matched, 2);
});

test('name matching ignores suffixes, case and punctuation', () => {
    assert.equal(normalizeName("Dee'Andre O'Neal Jr."), normalizeName('deeandre oneal'));
    const parsed = fromCsv('Player\ndeeandre oneal\n', players);
    assert.deepEqual(parsed.order.WR, ['w1']);
});

test('csv import reports names it could not match', () => {
    const parsed = fromCsv('Player\nAaron Ace\nNobody At All\n', players);
    assert.deepEqual(parsed.unmatched, ['Nobody At All']);
    assert.equal(parsed.matched, 1);
});

test('csv import honours an explicit rank column out of order', () => {
    const csv = 'player,rank\nCarl Core,3\nAaron Ace,1\nBob Best,2\n';
    assert.deepEqual(fromCsv(csv, players).order.RB, ['a', 'b', 'c']);
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
