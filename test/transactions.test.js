import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTransaction, playerHistory, tradesOnly, summarizeTrade, newTradesSince } from '../js/transactions.js';

const players = {
    p1: { id: 'p1', name: 'Alpha Back', pos: 'RB', team: 'KC' },
    p2: { id: 'p2', name: 'Beta Wideout', pos: 'WR', team: 'BUF' },
    p3: { id: 'p3', name: 'Gamma End', pos: 'TE', team: 'SF' },
};
const teamsById = new Map([
    [1, { rosterId: 1, name: 'Gridiron Gang' }],
    [2, { rosterId: 2, name: 'Backfield Bandits' }],
]);
const ctx = { teamsById, players };

const trade = {
    transaction_id: 't1', type: 'trade', status: 'complete', leg: 5,
    status_updated: 1000, roster_ids: [1, 2],
    adds: { p1: 2, p2: 1 },
    drops: { p1: 1, p2: 2 },
    draft_picks: [{ season: '2027', round: 1, previous_owner_id: 2, owner_id: 1 }],
    waiver_budget: [{ sender: 1, receiver: 2, amount: 15 }],
};

test('a trade is reshaped into per-team gives and gets', () => {
    const n = normalizeTransaction(trade, ctx);
    const a = n.sides.find((s) => s.rosterId === 1);
    const b = n.sides.find((s) => s.rosterId === 2);
    assert.deepEqual(a.gets.map((p) => p.name), ['Beta Wideout']);
    assert.deepEqual(a.gives.map((p) => p.name), ['Alpha Back']);
    assert.deepEqual(b.gets.map((p) => p.name), ['Alpha Back']);
    assert.equal(n.isTrade, true);
    assert.equal(n.week, 5);
});

test('draft picks and FAAB ride along with a trade', () => {
    const n = normalizeTransaction(trade, ctx);
    assert.deepEqual(n.picks, [{ season: '2027', round: 1, from: 2, to: 1 }]);
    assert.deepEqual(n.faab, [{ from: 1, to: 2, amount: 15 }]);
    const summary = summarizeTrade(n);
    assert.match(summary, /2027 R1/);
    assert.match(summary, /\$15 FAAB/);
});

test('incomplete transactions are ignored', () => {
    assert.equal(normalizeTransaction({ ...trade, status: 'failed' }, ctx), null);
    assert.equal(normalizeTransaction(null, ctx), null);
});

test('a waiver claim records who added and who was dropped', () => {
    const n = normalizeTransaction({
        transaction_id: 'w1', type: 'waiver', status: 'complete', leg: 3,
        roster_ids: [1], adds: { p3: 1 }, drops: { p1: 1 },
        settings: { waiver_bid: 22 },
    }, ctx);
    assert.equal(n.label, 'Waiver claim');
    assert.equal(n.bid, 22);
    const gets = n.sides[0].gets.map((p) => p.name);
    const gives = n.sides[0].gives.map((p) => p.name);
    assert.deepEqual(gets, ['Gamma End']);
    assert.deepEqual(gives, ['Alpha Back']);
});

test('a straight drop with no add is still recorded', () => {
    const n = normalizeTransaction({
        transaction_id: 'd1', type: 'free_agent', status: 'complete',
        roster_ids: [2], adds: null, drops: { p2: 2 },
    }, ctx);
    const move = n.movements.find((m) => m.player.id === 'p2');
    assert.equal(move.to, null);
    assert.equal(move.from, 2);
});

test('unknown players do not crash the log', () => {
    const n = normalizeTransaction({
        transaction_id: 'x', type: 'waiver', status: 'complete',
        roster_ids: [1], adds: { ghost: 1 }, drops: null,
    }, ctx);
    assert.equal(n.sides[0].gets[0].name, 'Player ghost');
});

test('player history reads oldest first and follows one player only', () => {
    const txs = [
        normalizeTransaction({ ...trade, transaction_id: 't1', status_updated: 2000 }, ctx),
        normalizeTransaction({
            transaction_id: 'w9', type: 'waiver', status: 'complete', leg: 1,
            status_updated: 1000, roster_ids: [1], adds: { p1: 1 }, drops: null,
        }, ctx),
    ];
    const hist = playerHistory(txs, 'p1');
    assert.equal(hist.length, 2);
    assert.equal(hist[0].type, 'waiver', 'earliest event first');
    assert.equal(hist[1].type, 'trade');
    assert.equal(hist[1].from, 1);
    assert.equal(hist[1].to, 2);
    assert.equal(playerHistory(txs, 'p3').length, 0);
});

test('trade log filters out waivers', () => {
    const txs = [
        normalizeTransaction(trade, ctx),
        normalizeTransaction({ transaction_id: 'w', type: 'waiver', status: 'complete', roster_ids: [1], adds: { p3: 1 } }, ctx),
    ];
    assert.equal(tradesOnly(txs).length, 1);
    assert.equal(tradesOnly(txs)[0].type, 'trade');
});

test('new trades are detected against what has already been seen', () => {
    const older = normalizeTransaction(trade, ctx);
    const newer = normalizeTransaction({ ...trade, transaction_id: 't2' }, ctx);
    const added = newTradesSince([older, newer], ['t1']);
    assert.equal(added.length, 1);
    assert.equal(added[0].id, 't2');
    assert.equal(newTradesSince([older, newer], ['t1', 't2']).length, 0);
});

test('a trade summary names both sides', () => {
    const summary = summarizeTrade(normalizeTransaction(trade, ctx));
    assert.match(summary, /Gridiron Gang gets Beta Wideout/);
    assert.match(summary, /Backfield Bandits gets Alpha Back/);
});
