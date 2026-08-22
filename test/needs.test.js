import test from 'node:test';
import assert from 'node:assert/strict';

import { leagueAverages, rosterNeeds, matchingPositions, biggestNeed, biggestSurplus, buildLeagueNeeds } from '../js/needs.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';

const cfg = normalizeLeague({
    settings: { num_teams: 12 }, scoring_settings: { rec: 0.5 },
    roster_positions: defaultRosterPositions(),
});

const mkReport = (byPosition) => ({ byPosition });

test('league averages are per position', () => {
    const avg = leagueAverages([
        { report: mkReport({ RB: { startingPoints: 30 }, WR: { startingPoints: 40 } }) },
        { report: mkReport({ RB: { startingPoints: 10 }, WR: { startingPoints: 20 } }) },
    ]);
    assert.equal(avg.RB, 20);
    assert.equal(avg.WR, 30);
});

test('deficit is starting points below the league average', () => {
    const needs = rosterNeeds(
        mkReport({ RB: { startingPoints: 12, benchDepth: 0, dropoff: 4, count: 3, starting: 3 } }),
        { RB: 20 }
    );
    assert.equal(needs.RB.deficit, 8);
});

test('surplus counts bench depth the lineup cannot use', () => {
    // Three startable backs, small dropoff: the extra one is genuinely spare.
    const spare = rosterNeeds(
        mkReport({ RB: { startingPoints: 30, benchDepth: 14, dropoff: 3, count: 5, starting: 3 } }),
        { RB: 30 }
    );
    assert.ok(spare.RB.surplus > 10, `expected real surplus, got ${spare.RB.surplus}`);

    // Same bench value, but the position collapses without its starter: that
    // depth is insurance, not surplus.
    const insurance = rosterNeeds(
        mkReport({ RB: { startingPoints: 30, benchDepth: 14, dropoff: 22, count: 5, starting: 3 } }),
        { RB: 30 }
    );
    assert.ok(insurance.RB.surplus < spare.RB.surplus);
});

test('a team can have surplus at a position it is not weak at', () => {
    // The point of measuring surplus separately from starting points.
    const needs = rosterNeeds(
        mkReport({ RB: { startingPoints: 40, benchDepth: 16, dropoff: 4, count: 5, starting: 3 } }),
        { RB: 30 }
    );
    assert.ok(needs.RB.deficit < 0, 'they are above average at RB');
    assert.ok(needs.RB.surplus > 0, 'and still have spare bodies');
});

test('matching positions pairs one team’s hole with another’s spare', () => {
    const buyer = { needs: rosterNeeds(mkReport({
        RB: { startingPoints: 12, benchDepth: 1, dropoff: 8, count: 3, starting: 3 },
        WR: { startingPoints: 40, benchDepth: 12, dropoff: 4, count: 6, starting: 3 },
    }), { RB: 30, WR: 30 }) };
    const seller = { needs: rosterNeeds(mkReport({
        RB: { startingPoints: 34, benchDepth: 15, dropoff: 3, count: 6, starting: 3 },
        WR: { startingPoints: 14, benchDepth: 1, dropoff: 9, count: 3, starting: 3 },
    }), { RB: 30, WR: 30 }) };

    const hits = matchingPositions(buyer, seller);
    assert.ok(hits.some((h) => h.pos === 'RB'), 'buyer needs RB and seller has spare RBs');
    assert.ok(!hits.some((h) => h.pos === 'WR'), 'buyer is not short at WR');

    // And the reverse direction finds the mirror match.
    const back = matchingPositions(seller, buyer);
    assert.ok(back.some((h) => h.pos === 'WR'));
});

test('no match when neither side has anything the other wants', () => {
    const even = { needs: rosterNeeds(mkReport({
        RB: { startingPoints: 30, benchDepth: 2, dropoff: 6, count: 3, starting: 3 },
    }), { RB: 30 }) };
    assert.deepEqual(matchingPositions(even, even), []);
});

test('biggest need and surplus pick the extremes', () => {
    const entry = { needs: rosterNeeds(mkReport({
        RB: { startingPoints: 10, benchDepth: 0, dropoff: 5, count: 2, starting: 2 },
        WR: { startingPoints: 45, benchDepth: 18, dropoff: 3, count: 6, starting: 3 },
    }), { RB: 30, WR: 30 }) };
    assert.equal(biggestNeed(entry).pos, 'RB');
    assert.equal(biggestSurplus(entry).pos, 'WR');
});

test('buildLeagueNeeds produces one entry per team', () => {
    const mkPlayer = (id, pos, score) => ({ player: { id, name: id, pos, team: 'KC', injury: null }, score, value: score * 10 });
    const teams = [1, 2].map((rosterId) => ({ rosterId, name: `T${rosterId}`, players: [] }));
    const entriesFor = (t) => [
        mkPlayer(`${t.rosterId}qb`, 'QB', 20), mkPlayer(`${t.rosterId}rb1`, 'RB', 15),
        mkPlayer(`${t.rosterId}rb2`, 'RB', 12), mkPlayer(`${t.rosterId}wr1`, 'WR', 14),
        mkPlayer(`${t.rosterId}wr2`, 'WR', 11), mkPlayer(`${t.rosterId}te`, 'TE', 8),
        mkPlayer(`${t.rosterId}k`, 'K', 7), mkPlayer(`${t.rosterId}d`, 'DEF', 6),
    ];
    const map = buildLeagueNeeds({ teams, entriesFor, cfg });
    assert.equal(map.size, 2);
    assert.ok(map.get(1).needs.RB);
    assert.ok(map.avgByPos.RB > 0);
});
