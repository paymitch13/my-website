import test from 'node:test';
import assert from 'node:assert/strict';

import { extractByes, isOnBye, byeConflicts } from '../js/schedule.js';
import { parseScoreboard } from '../js/odds.js';

// --- Bye weeks -------------------------------------------------------------

test('byes come out of the payload the app already downloads', () => {
    const payload = { week: { number: 5, teamsOnBye: [{ abbreviation: 'ATL' }, { abbreviation: 'CHI' }] }, events: [] };
    assert.deepEqual(extractByes(payload), ['ATL', 'CHI']);
});

test('ESPN abbreviations are normalized to Sleeper’s', () => {
    assert.deepEqual(extractByes({ week: { teamsOnBye: [{ abbreviation: 'WSH' }] } }), ['WAS']);
});

test('a week with no byes yields none, not a crash', () => {
    assert.deepEqual(extractByes({ week: { number: 1 } }), []);
    assert.deepEqual(extractByes({}), []);
    assert.deepEqual(extractByes(null), []);
});

test('parseScoreboard now surfaces the bye list alongside games', () => {
    const games = parseScoreboard({
        week: { teamsOnBye: [{ abbreviation: 'GB' }] },
        events: [{
            id: '1', shortName: 'KC @ BUF',
            competitions: [{
                competitors: [
                    { homeAway: 'home', team: { abbreviation: 'BUF' } },
                    { homeAway: 'away', team: { abbreviation: 'KC' } },
                ],
            }],
        }],
    });
    assert.equal(games.length, 1);
    assert.deepEqual(games.teamsOnBye, ['GB']);
});

test('isOnBye matches team and week', () => {
    const byes = new Map([['GB', 5]]);
    assert.equal(isOnBye(byes, 'GB', 5), true);
    assert.equal(isOnBye(byes, 'GB', 6), false);
    assert.equal(isOnBye(byes, 'KC', 5), false);
});

test('bye conflicts find the weeks that actually hurt', () => {
    const byes = new Map([['GB', 7], ['KC', 7], ['SF', 7], ['BUF', 9]]);
    const players = [
        { id: 'a', name: 'A', team: 'GB' }, { id: 'b', name: 'B', team: 'KC' },
        { id: 'c', name: 'C', team: 'SF' }, { id: 'd', name: 'D', team: 'BUF' },
    ];
    const hits = byeConflicts(players, byes, { minPlayers: 2 });
    assert.equal(hits.length, 1, 'only week 7 stacks up');
    assert.equal(hits[0].week, 7);
    assert.equal(hits[0].players.length, 3);
});

test('bye conflicts ignore weeks already gone', () => {
    const byes = new Map([['GB', 3], ['KC', 3]]);
    const players = [{ id: 'a', team: 'GB' }, { id: 'b', team: 'KC' }];
    assert.equal(byeConflicts(players, byes, { fromWeek: 8, minPlayers: 2 }).length, 0);
});
