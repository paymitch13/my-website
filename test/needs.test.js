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
    const { byRoster, avgByPos, perSlotAvg } = buildLeagueNeeds({ teams, entriesFor, cfg });
    assert.equal(byRoster.size, 2);
    assert.ok(byRoster.get(1).needs.RB);
    assert.ok(avgByPos.RB > 0);
    assert.ok(perSlotAvg.RB > 0, 'per-slot averages are returned as data, not bolted onto the Map');
});

test('a team can sell from strength with an empty bench', () => {
    // One superstar receiver and two spares: no bench surplus at all, and the
    // obvious place to go buy a receiver. Matching only on surplus forbade the
    // consolidation trade outright.
    const perSlotAvg = { WR: 11, RB: 11, QB: 18, TE: 8 };
    const avg = { WR: 33, RB: 33, QB: 18, TE: 8 };
    const star = {
        needs: rosterNeeds(
            mkReport({
                WR: { startingPoints: 39, startingPerSlot: 13, benchDepth: 0, benchAboveReplacement: 0, dropoff: 12, count: 3, starting: 3 },
                RB: { startingPoints: 24, startingPerSlot: 8, benchDepth: 0, benchAboveReplacement: 0, dropoff: 4, count: 3, starting: 3 },
            }),
            avg, undefined, { perSlotAvg }
        ),
    };
    const depth = {
        needs: rosterNeeds(
            mkReport({
                WR: { startingPoints: 19, startingPerSlot: 6.5, benchDepth: 0, benchAboveReplacement: 0, dropoff: 3, count: 2, starting: 3 },
                RB: { startingPoints: 43, startingPerSlot: 14.3, benchDepth: 20, benchAboveReplacement: 16, dropoff: 3, count: 5, starting: 3 },
            }),
            avg, undefined, { perSlotAvg }
        ),
    };

    assert.equal(star.needs.WR.surplus, 0, 'the star team has no spare receivers');
    assert.ok(star.needs.WR.strength > 1.5, 'but it is strong at the position');

    const hits = matchingPositions(depth, star);
    const wr = hits.find((h) => h.pos === 'WR');
    assert.ok(wr, 'the depth team must be able to shop for a receiver here');
    assert.equal(wr.via, 'strength');
});

test('a star is tradeable even when both teams are short at the position', () => {
    // Neither receiver room is good. One of them contains a genuine WR1, and
    // that is the whole basis for "my WR3 for your WR1" -- the shape every
    // league sees weekly, and the one a surplus-only match cannot express,
    // because a hole on both sides looks like nobody having anything to sell.
    const perSlotAvg = { WR: 11 };
    const avg = { WR: 33 };
    const bestAvg = { WR: 13 };
    const shape = (byPosition) => rosterNeeds(mkReport(byPosition), avg, ['WR'], { perSlotAvg, bestAvg });

    const topHeavy = {
        needs: shape({
            WR: { startingPoints: 30, startingPerSlot: 10, bestPoints: 22, benchDepth: 0, benchAboveReplacement: 0, dropoff: 14, count: 3, starting: 3 },
        }),
    };
    const flat = {
        needs: shape({
            WR: { startingPoints: 27, startingPerSlot: 9, bestPoints: 9, benchDepth: 8, benchAboveReplacement: 4, dropoff: 2, count: 5, starting: 3 },
        }),
    };

    assert.equal(topHeavy.needs.WR.surplus, 0, 'no spare receivers');
    assert.ok(topHeavy.needs.WR.strength < 0, 'and the room is below average overall');
    assert.ok(topHeavy.needs.WR.topEdge > 2.5, 'but the man at the top is not');

    const hit = matchingPositions(flat, topHeavy).find((h) => h.pos === 'WR');
    assert.ok(hit, 'the flat team must be able to shop for the star');
    assert.equal(hit.via, 'star');

    // And it stays a two-way conversation: the star team wants bodies.
    assert.ok(matchingPositions(topHeavy, flat).some((h) => h.pos === 'WR'));
});

test('deficit is measured per slot, so lineup shape is not a hole', () => {
    // Two starting receivers because a back is in the flex, against a league
    // that starts three. Comparing raw totals invents a receiver deficit.
    const perSlotAvg = { WR: 12 };
    const avg = { WR: 36 };
    const needs = rosterNeeds(
        mkReport({ WR: { startingPoints: 24, startingPerSlot: 12, benchDepth: 0, dropoff: 4, count: 4, starting: 2 } }),
        avg, ['WR'], { perSlotAvg }
    );
    assert.ok(Math.abs(needs.WR.deficit) < 0.001, `same per-slot production is no deficit, got ${needs.WR.deficit}`);
});
