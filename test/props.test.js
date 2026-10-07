import test from 'node:test';
import assert from 'node:assert/strict';

import {
    statKeyFor, athleteIdFrom, parseProps, marketPoints, disagreement, blendMarket,
    parseCoreOdds, parsePredictor, normalizeName, buildPlayerIndex, resolveAthlete,
    slateEdges, streamingSpots,
} from '../js/props.js';
import { normalizeScoring } from '../js/league.js';
import { applyCoreOdds } from '../js/data.js';

const scoring = normalizeScoring({
    pass_yd: 0.04, pass_td: 4, pass_int: -2,
    rush_yd: 0.1, rush_td: 6,
    rec: 0.5, rec_yd: 0.1, rec_td: 6,
});

// --- Market names ----------------------------------------------------------

test('prop markets map onto the stat keys the league already scores', () => {
    // ESPN decorates its market names and has changed the decoration before,
    // so the match is loose on purpose.
    assert.equal(statKeyFor('Total Rushing Yards (incl. overtime)'), 'rush_yd');
    assert.equal(statKeyFor('Total Receiving Yards (incl. overtime)'), 'rec_yd');
    assert.equal(statKeyFor('Total Passing Yards (incl. overtime)'), 'pass_yd');
    assert.equal(statKeyFor('Total Passing Touchdowns (incl. overtime)'), 'pass_td');
    assert.equal(statKeyFor('Receptions'), 'rec');
});

test('game-level markets are not player props', () => {
    // Preseason payloads are ALL of these, and treating a team total as a
    // player's receiving line would be worse than having no market at all.
    for (const name of ['1st Half Total', 'Team Total Points', '1st Quarter Moneyline', '1st Half Spread']) {
        assert.equal(statKeyFor(name), null, `${name} is not a player market`);
    }
});

test('the athlete id comes out of the ref without a fetch', () => {
    assert.equal(
        athleteIdFrom('http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/4241389?lang=en&region=us'),
        '4241389'
    );
    assert.equal(athleteIdFrom(undefined), null);
    assert.equal(athleteIdFrom('nonsense'), null);
});

// --- Parsing ---------------------------------------------------------------

/** An in-season payload, in the shape ESPN returns. */
const propPayload = (rows) => ({
    count: rows.length,
    items: rows.map(([id, name, current, open]) => ({
        athlete: { $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${id}?lang=en` },
        type: { name },
        current: { target: { value: current } },
        open: open === undefined ? undefined : { target: { value: open } },
    })),
});

test('props are grouped per athlete with their movement', () => {
    const parsed = parseProps(
        propPayload([
            ['4241389', 'Total Receiving Yards (incl. overtime)', 82.5, 74.5],
            ['4241389', 'Receptions', 6.5],
            ['4241389', 'Total Receiving Touchdowns (incl. overtime)', 0.5],
            ['2577417', 'Total Passing Yards (incl. overtime)', 265.5],
        ])
    );

    assert.equal(parsed.size, 2);
    const lamb = parsed.get('4241389');
    assert.deepEqual(lamb.stats, { rec_yd: 82.5, rec: 6.5, rec_td: 0.5 });
    // An eight-yard move off the open is information a projection has not
    // absorbed yet, so it survives parsing rather than being flattened away.
    assert.deepEqual(lamb.movement.rec_yd, { open: 74.5, current: 82.5, change: 8 });
    assert.equal(lamb.movement.rec, undefined, 'an unmoved line has no movement');
});

test('a preseason payload with no player markets parses to nothing, not an error', () => {
    const parsed = parseProps({
        count: 2,
        items: [
            { type: { name: '1st Half Total' }, current: { target: { value: 19.5 } } },
            { type: { name: 'Team Total Points' }, current: { target: { value: 21.5 } } },
        ],
    });
    assert.equal(parsed.size, 0);
});

// --- Market-implied points -------------------------------------------------

test('a posted market line is scored by the league’s own rules', () => {
    const row = { stats: { rec_yd: 80, rec: 6, rec_td: 0.5 } };
    const points = marketPoints(row, scoring);
    // 80 * 0.1 + 6 * 0.5 + 0.5 * 6
    assert.ok(Math.abs(points - (8 + 3 + 3)) < 1e-9, `got ${points}`);
});

test('the same line is worth more in a full-PPR league', () => {
    const row = { stats: { rec_yd: 80, rec: 6, rec_td: 0.5 } };
    const ppr = normalizeScoring({ rec: 1, rec_yd: 0.1, rec_td: 6 });
    assert.ok(marketPoints(row, ppr) > marketPoints(row, scoring));
});

test('one lonely market is not a projection', () => {
    // A receiving-yards line with no touchdown market is a fact about
    // receiving yards. Scoring it as a whole projection would under-project
    // every player whose other markets have not been posted yet.
    assert.equal(marketPoints({ stats: { rec_yd: 80 } }, scoring), null);
    assert.ok(marketPoints({ stats: { rec_yd: 80, rec: 6 } }, scoring) > 0);
});

// --- Disagreement ----------------------------------------------------------

test('a material disagreement is reported with its direction', () => {
    const lower = disagreement(9.2, 13.5);
    assert.ok(lower);
    assert.equal(lower.direction, 'lower');
    assert.match(lower.text, /Vegas is LOWER/);
    assert.match(lower.text, /9\.2/);
    assert.match(lower.text, /13\.5/);

    const higher = disagreement(16, 12);
    assert.equal(higher.direction, 'higher');
});

test('disagreement is relative, so a small gap on a small player still counts', () => {
    // Two points apart on a 20-point quarterback is noise; two points apart on
    // a 5-point tight end is the whole difference between starting him and not.
    assert.equal(disagreement(18, 20), null, 'two points on a 20-point player is noise');
    assert.ok(disagreement(3, 5), 'two points on a 5-point player is not');
});

test('nothing is claimed without both numbers', () => {
    assert.equal(disagreement(null, 12), null);
    assert.equal(disagreement(12, null), null);
    assert.equal(disagreement(12, 0), null);
});

test('the blend leans on the market without ignoring the projection', () => {
    const blended = blendMarket(10, 20);
    assert.ok(blended > 10 && blended < 20, `expected a blend, got ${blended}`);
    assert.ok(blended < 15, 'and one that leans toward the money');
    // Either alone falls back cleanly.
    assert.equal(blendMarket(null, 14), 14);
    assert.equal(blendMarket(14, null), 14);
});

// --- Core odds -------------------------------------------------------------

/** The exact shape ESPN returned for SEA @ TEN, verified live. */
const coreOdds = (over, under, overUnder = 37.5) => ({
    count: 1,
    items: [{
        provider: { name: 'DraftKings' },
        overUnder,
        spread: -3,
        overOdds: over,
        underOdds: under,
        details: 'TEN -3',
        homeTeamOdds: { favorite: true, spreadOdds: -110, moneyLine: -155 },
        awayTeamOdds: { favorite: false, spreadOdds: -110, moneyLine: 130 },
    }],
});

test('juice on the total moves the real number off the posted one', () => {
    // A total is not the number on the board when one side is priced higher.
    // Implied team totals drive every Start/Sit multiplier, so this correction
    // is worth more than its size.
    const juicedOver = parseCoreOdds(coreOdds(-125, +105)).consensus;
    assert.ok(juicedOver.fairTotal > juicedOver.overUnder, 'a juiced over means the true total is higher');

    const juicedUnder = parseCoreOdds(coreOdds(+105, -125)).consensus;
    assert.ok(juicedUnder.fairTotal < juicedUnder.overUnder);

    const balanced = parseCoreOdds(coreOdds(-110, -110)).consensus;
    assert.ok(Math.abs(balanced.fairTotal - balanced.overUnder) < 1e-9, 'an evenly priced total is the posted total');
});

test('the spread juice and both moneylines survive parsing', () => {
    const { books } = parseCoreOdds(coreOdds(-108, -112));
    assert.equal(books[0].homeSpreadOdds, -110);
    assert.equal(books[0].homeMoneyline, -155);
    assert.equal(books[0].awayMoneyline, 130);
});

test('providers are a list, so a second book costs nothing to support', () => {
    const two = parseCoreOdds({
        count: 2,
        items: [
            { provider: { name: 'DraftKings' }, overUnder: 44.5, spread: -3, overOdds: -110, underOdds: -110 },
            { provider: { name: 'FanDuel' }, overUnder: 45.5, spread: -3.5, overOdds: -110, underOdds: -110 },
        ],
    });
    assert.equal(two.consensus.providers, 2);
    assert.equal(two.consensus.overUnder, 45, 'the consensus is the average, not the first one listed');
    assert.equal(two.consensus.totalSpread, 1, 'and the books disagreeing is itself a fact');
    assert.ok(Math.abs(two.consensus.spreadSpread - 0.5) < 1e-9);
});

test('an unpriced game reports no consensus rather than a fake one', () => {
    assert.equal(parseCoreOdds({ items: [] }), null);
    assert.equal(parseCoreOdds({ count: 1, items: [{ provider: { name: 'DK' } }] }).consensus, null);
});

// --- ESPN's model ----------------------------------------------------------

test('the model is compared against the market, which is the point of having it', () => {
    const pred = parsePredictor(
        { gameProjection: 72.4, matchupQuality: 76.2, teamPredPtDiff: 3.6 },
        { homeMoneyline: -155, awayMoneyline: 130 }
    );
    assert.ok(pred.modelHomeWin > 0.7);
    assert.ok(pred.marketHomeWin > 0.5 && pred.marketHomeWin < 0.7);
    assert.ok(pred.notable, 'a 12-point gap between model and market is worth saying');
    assert.match(pred.text, /ESPN's model/);
});

test('model and market agreeing is not a finding', () => {
    const pred = parsePredictor({ gameProjection: 60 }, { homeMoneyline: -155, awayMoneyline: 130 });
    assert.equal(pred.notable, false);
});

test('a game ESPN has not modelled yet returns nothing', () => {
    // Preseason and far-out games carry nulls, verified live. Not an error.
    assert.equal(parsePredictor({ gameProjection: null }), null);
    assert.equal(parsePredictor({}), null);
});

// --- The player join -------------------------------------------------------

test('names normalize hard enough to survive both databases', () => {
    assert.equal(normalizeName('D.J. Moore'), normalizeName('DJ Moore'));
    assert.equal(normalizeName('Marvin Harrison Jr.'), normalizeName('Marvin Harrison'));
    assert.equal(normalizeName("Ja'Marr Chase"), normalizeName('JaMarr Chase'));
    assert.equal(normalizeName('Michael Pittman Jr'), normalizeName('Michael Pittman'));
});

test('a player is found by ESPN id when Sleeper carries one', async () => {
    const players = {
        a: { id: 'a', name: 'CeeDee Lamb', pos: 'WR', espnId: '4241389' },
        b: { id: 'b', name: 'Kyle Pitts', pos: 'TE', espnId: null },
    };
    const index = buildPlayerIndex(players);
    assert.equal((await resolveAthlete('4241389', index)).id, 'a');
});

test('a player is still found when Sleeper has no ESPN id for him', async () => {
    // Sleeper carries espn_id for only about a quarter of rostered skill
    // players -- Kyle Pitts and Bucky Irving both lack it. An id-only join
    // would have no market for most of a roster while appearing to work.
    const players = { b: { id: 'b', name: 'Kyle Pitts', pos: 'TE', espnId: null } };
    const index = buildPlayerIndex(players);

    const store = {
        getAthleteName: () => 'Kyle Pitts',
        getAthletePos: () => 'TE',
        setAthlete: () => {},
    };
    const found = await resolveAthlete('4360248', index, { store });
    assert.equal(found.id, 'b', 'the name join has to carry the players the id join drops');
});

test('an athlete nobody rosters resolves to nothing rather than a wrong player', async () => {
    const players = { b: { id: 'b', name: 'Kyle Pitts', pos: 'TE', espnId: null } };
    const index = buildPlayerIndex(players);
    const store = { getAthleteName: () => 'Some Lineman', getAthletePos: () => 'OT', setAthlete: () => {} };
    assert.equal(await resolveAthlete('999', index, { store }), null);
});

// --- Folding the market back into the board --------------------------------

/** One parsed scoreboard game, in the shape odds.js produces. */
const boardGame = () => ({
    id: '401873297',
    home: 'TEN',
    away: 'SEA',
    favorite: 'TEN',
    spread: -3,
    overUnder: 37.5,
    implied: { TEN: 20.25, SEA: 17.25 },
    moneyline: { home: -155, away: 130 },
});

const teamCtx = () =>
    new Map([
        ['TEN', { team: 'TEN', impliedTotal: 20.25, opponentImplied: 17.25 }],
        ['SEA', { team: 'SEA', impliedTotal: 17.25, opponentImplied: 20.25 }],
    ]);

test('the de-vigged total flows all the way into the team contexts', () => {
    // Two copies of the same total, one corrected and one not, is how a tool
    // starts contradicting itself between the Vegas tab and Start/Sit.
    const game = boardGame();
    const byTeam = teamCtx();
    applyCoreOdds(game, { core: parseCoreOdds(coreOdds(-130, +105)), byTeam });

    assert.ok(game.fairTotal > 37.5, 'the juiced over raises the real total');
    assert.ok(byTeam.get('TEN').impliedTotal > 20.25, 'and the favourite is implied for more');
    assert.equal(byTeam.get('TEN').fairTotal, game.fairTotal);
    assert.equal(byTeam.get('SEA').opponentImplied, byTeam.get('TEN').impliedTotal,
        'each side sees the other’s corrected number, not a stale one');
    // Both sides still add up to the corrected total.
    assert.ok(Math.abs(byTeam.get('TEN').impliedTotal + byTeam.get('SEA').impliedTotal - game.fairTotal) < 1e-9);
});

test('the favourite gets the larger share whichever side he is on', () => {
    const away = { ...boardGame(), favorite: 'SEA' };
    const byTeam = teamCtx();
    applyCoreOdds(away, { core: parseCoreOdds(coreOdds(-110, -110)), byTeam });
    assert.ok(byTeam.get('SEA').impliedTotal > byTeam.get('TEN').impliedTotal);
});

test('a game with no core odds keeps the numbers it already had', () => {
    const game = boardGame();
    const byTeam = teamCtx();
    applyCoreOdds(game, { core: null, byTeam });
    assert.equal(game.fairTotal, undefined);
    assert.equal(byTeam.get('TEN').impliedTotal, 20.25, 'untouched, not zeroed');
});

test('a pick-em with no posted favourite is left alone rather than guessed at', () => {
    const game = { ...boardGame(), favorite: null };
    const byTeam = teamCtx();
    applyCoreOdds(game, { core: parseCoreOdds(coreOdds(-130, +105)), byTeam });
    assert.ok(game.fairTotal > 37.5, 'the total is still corrected');
    assert.equal(byTeam.get('TEN').impliedTotal, 20.25, 'but nobody is handed the favourite’s share');
});

test('ESPN’s model rides along when there is one', () => {
    const game = boardGame();
    applyCoreOdds(game, {
        core: parseCoreOdds(coreOdds(-110, -110)),
        predictor: parsePredictor({ gameProjection: 72.4 }, { homeMoneyline: -155, awayMoneyline: 130 }),
        byTeam: teamCtx(),
    });
    assert.ok(game.predictor.notable);
});

// --- Slate-wide edges ------------------------------------------------------
//
// All of this machinery existed and was applied only to the user's own roster,
// as one factor inside a start/sit call -- the least useful place for it. The
// players the market disagrees with the consensus about are the actionable
// finding on the whole Vegas screen.

const edgeScoring = normalizeScoring({ rec: 0.5, rec_yd: 0.1, rush_yd: 0.1, rec_td: 6, rush_td: 6, pass_yd: 0.04, pass_td: 4 });

const edgePlayers = {
    hot: { id: 'hot', name: 'Market Loves Him', pos: 'WR', team: 'KC' },
    cold: { id: 'cold', name: 'Market Hates Him', pos: 'WR', team: 'DEN' },
    agreed: { id: 'agreed', name: 'Everyone Agrees', pos: 'WR', team: 'SF' },
    tiny: { id: 'tiny', name: 'Barely Plays', pos: 'WR', team: 'NYJ' },
};

/** A prop row carrying two markets, which is the minimum to be a projection. */
const propRow = (yards, tds) => ({ stats: { rec_yd: yards, rec_td: tds }, movement: {} });

test('the slate edge scan finds both directions and ignores agreement', () => {
    const edges = slateEdges({
        marketProps: new Map([
            // 110 yards + 0.6 TD = 11 + 3.6 = 14.6 against a projected 10.
            ['hot', propRow(110, 0.6)],
            // 40 yards + 0.1 TD = 4 + 0.6 = 4.6 against a projected 10.
            ['cold', propRow(40, 0.1)],
            // 100 yards + 0.5 TD = 10 + 3 = 13 against a projected 13.
            ['agreed', propRow(100, 0.5)],
        ]),
        projectedPpg: { hot: 10, cold: 10, agreed: 13 },
        players: edgePlayers,
        scoring: edgeScoring,
    });

    assert.deepEqual(edges.higher.map((r) => r.player.id), ['hot']);
    assert.deepEqual(edges.lower.map((r) => r.player.id), ['cold']);
    assert.equal(edges.counted, 2, 'agreement is not an edge');
});

test('an edge on a tiny projection is arithmetic, not information', () => {
    // 40% of two points is not a finding, and letting it through would fill
    // the board with players nobody is choosing between.
    const edges = slateEdges({
        marketProps: new Map([['tiny', propRow(30, 0.05)]]),
        projectedPpg: { tiny: 2 },
        players: edgePlayers,
        scoring: edgeScoring,
    });
    assert.equal(edges.counted, 0);
});

test('a player with one posted market is not treated as a projection', () => {
    // A lone receiving-yards line is a fact about receiving yards. Scoring it
    // as a full projection would systematically under-project everyone whose
    // touchdown market has not been posted yet.
    const edges = slateEdges({
        marketProps: new Map([['hot', { stats: { rec_yd: 110 }, movement: {} }]]),
        projectedPpg: { hot: 10 },
        players: edgePlayers,
        scoring: edgeScoring,
    });
    assert.equal(edges.counted, 0);
});

test('an edge carries the underlying lines so the claim can be checked', () => {
    const edges = slateEdges({
        marketProps: new Map([['hot', propRow(110, 0.6)]]),
        projectedPpg: { hot: 10 },
        players: edgePlayers,
        scoring: edgeScoring,
    });
    assert.equal(edges.higher[0].stats.rec_yd, 110);
    assert.ok(edges.higher[0].market > edges.higher[0].projected);
});

test('a player with no projection is skipped rather than counted as an edge', () => {
    const edges = slateEdges({
        marketProps: new Map([['hot', propRow(110, 0.6)]]),
        projectedPpg: {},
        players: edgePlayers,
        scoring: edgeScoring,
    });
    assert.equal(edges.counted, 0);
});

test('missing inputs produce an empty scan rather than throwing', () => {
    assert.deepEqual(slateEdges({}), { higher: [], lower: [], counted: 0 });
});

// --- Streaming spots -------------------------------------------------------

test('kickers want their own offense moving, defenses want the opposite', () => {
    const byTeam = new Map([
        ['KC', { team: 'KC', impliedTotal: 29, opponentImplied: 17 }],
        ['CAR', { team: 'CAR', impliedTotal: 15, opponentImplied: 27 }],
        ['SF', { team: 'SF', impliedTotal: 26, opponentImplied: 13 }],
        ['NYJ', { team: 'NYJ', impliedTotal: 18, opponentImplied: 24 }],
    ]);
    const spots = streamingSpots(byTeam, { limit: 2 });
    assert.deepEqual(spots.kickers.map((c) => c.team), ['KC', 'SF'], 'highest own total first');
    assert.deepEqual(spots.defenses.map((c) => c.team), ['SF', 'KC'], 'lowest opponent total first');
});

test('a team with no posted line is not a streaming spot', () => {
    const byTeam = new Map([
        ['KC', { team: 'KC', impliedTotal: 29, opponentImplied: 17 }],
        ['XX', { team: 'XX', impliedTotal: null, opponentImplied: null }],
    ]);
    const spots = streamingSpots(byTeam);
    assert.deepEqual(spots.kickers.map((c) => c.team), ['KC']);
});

test('an empty board yields no streaming spots rather than throwing', () => {
    assert.deepEqual(streamingSpots(null), { kickers: [], defenses: [] });
    assert.deepEqual(streamingSpots(new Map()), { kickers: [], defenses: [] });
});
