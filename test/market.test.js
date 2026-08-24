import test from 'node:test';
import assert from 'node:assert/strict';

import {
    marketQuery, marketUrl, marketKey, parseMarketValues, marketRanks,
    marketEdge, divergences, describeEdge, fetchMarketValues,
} from '../js/market.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { createValuationContext } from '../js/valuation.js';
import { neutralEntry, buildEntries } from '../js/trade.js';

const leagueOf = (roster, scoring = { rec: 0.5, rush_yd: 0.1 }, settings = {}) =>
    normalizeLeague({
        settings: { num_teams: 12, playoff_week_start: 15, ...settings },
        scoring_settings: scoring,
        roster_positions: roster,
    });

const row = (sleeperId, pos, value, extra = {}) => ({
    player: { sleeperId, name: `${pos}-${sleeperId}`, position: pos },
    value,
    overallRank: 1,
    positionRank: 1,
    ...extra,
});

// --- The query has to carry this league's shape ----------------------------

test('the market is quoted for THIS league, not a generic one', () => {
    const half = leagueOf(defaultRosterPositions());
    assert.deepEqual(marketQuery(half), { isDynasty: false, numQbs: 1, numTeams: 12, ppr: 0.5 });

    // Superflex is the case that proves it matters: the same endpoint prices a
    // quarterback at roughly half in a one-QB league.
    const sf = leagueOf(
        ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'BN'],
        { rec: 1 }
    );
    assert.equal(marketQuery(sf).numQbs, 2);
    assert.equal(marketQuery(sf).ppr, 1);
    assert.notEqual(marketKey(sf), marketKey(half), 'the two must never share a cached snapshot');
});

test('scoring decides the ppr bucket, not the format name', () => {
    assert.equal(marketQuery(leagueOf(defaultRosterPositions(), { rec: 0 })).ppr, 0);
    assert.equal(marketQuery(leagueOf(defaultRosterPositions(), { rec: 0.5 })).ppr, 0.5);
    assert.equal(marketQuery(leagueOf(defaultRosterPositions(), { rec: 1 })).ppr, 1);
});

test('dynasty and keeper leagues ask for dynasty values', () => {
    const dyn = leagueOf(defaultRosterPositions(), { rec: 0.5 }, { type: 2 });
    const keeper = leagueOf(defaultRosterPositions(), { rec: 0.5 }, { type: 1 });
    assert.equal(marketQuery(dyn).isDynasty, true);
    assert.equal(marketQuery(keeper).isDynasty, true);
    assert.match(marketUrl(dyn), /isDynasty=true/);
});

test('team count is clamped to something the endpoint understands', () => {
    assert.equal(marketQuery(leagueOf(defaultRosterPositions(), { rec: 0.5 }, { num_teams: 2 })).numTeams, 4);
    assert.equal(marketQuery(leagueOf(defaultRosterPositions(), { rec: 0.5 }, { num_teams: 64 })).numTeams, 20);
});

// --- Parsing ---------------------------------------------------------------

test('rows without a Sleeper id are dropped rather than guessed at', () => {
    const byId = parseMarketValues([
        row('100', 'RB', 5000),
        { player: { name: 'Nobody', position: 'WR' }, value: 4000 },
        row('101', 'WR', 4000),
    ]);
    assert.deepEqual([...byId.keys()], ['100', '101']);
});

test('junk rows do not become zero-value players', () => {
    const byId = parseMarketValues([
        row('1', 'RB', 0),
        row('2', 'RB', -5),
        row('3', 'RB', NaN),
        { player: { sleeperId: '4', position: 'RB' } },
        row('5', 'PUNTER', 900),
        row('6', 'RB', 900),
    ]);
    assert.deepEqual([...byId.keys()], ['6']);
});

test('defense and kicker spellings are normalized', () => {
    const byId = parseMarketValues([row('1', 'DST', 900), row('2', 'PK', 800)]);
    assert.equal(byId.get('1').pos, 'DEF');
    assert.equal(byId.get('2').pos, 'K');
});

test('parsing a non-array is empty, not a crash', () => {
    assert.equal(parseMarketValues(null).size, 0);
    assert.equal(parseMarketValues({}).size, 0);
    assert.equal(parseMarketValues('nope').size, 0);
});

test('ranks are dense within a position', () => {
    // Deliberately out of order, and interleaved across positions.
    const byId = parseMarketValues([
        row('a', 'RB', 100), row('b', 'WR', 900), row('c', 'RB', 500),
        row('d', 'WR', 100), row('e', 'RB', 900),
    ]);
    const ranks = marketRanks(byId);
    assert.equal(ranks.get('e'), 1);
    assert.equal(ranks.get('c'), 2);
    assert.equal(ranks.get('a'), 3);
    assert.equal(ranks.get('b'), 1);
    assert.equal(ranks.get('d'), 2);
});

// --- The edge --------------------------------------------------------------

test('a rank gap deep on the board is noise, the same gap at the top is not', () => {
    // Three spots apart either way. Only one of them is an opinion.
    const top = marketEdge({ marketRank: 6, projectedRank: 3, pos: 'RB' });
    const deep = marketEdge({ marketRank: 66, projectedRank: 63, pos: 'WR' });
    assert.equal(top.kind, 'buy-low');
    assert.equal(deep.kind, 'fair', 'WR63 against WR66 is not a disagreement');
});

test('the market ranking a player WORSE than his projection is a buy-low', () => {
    const e = marketEdge({ marketRank: 51, projectedRank: 16, pos: 'RB' });
    assert.equal(e.kind, 'buy-low');
    assert.ok(e.gap > 0);
    assert.match(describeEdge(e, 'Alvin Kamara'), /charging less/);
});

test('the market ranking a player BETTER than his projection is a sell-high', () => {
    const e = marketEdge({ marketRank: 3, projectedRank: 22, pos: 'WR' });
    assert.equal(e.kind, 'sell-high');
    assert.ok(e.gap < 0);
    assert.match(describeEdge(e, 'Someone'), /paying more/);
});

test('an edge needs both numbers', () => {
    assert.equal(marketEdge({ marketRank: 3, projectedRank: null, pos: 'WR' }), null);
    assert.equal(marketEdge({ marketRank: null, projectedRank: 3, pos: 'WR' }), null);
    assert.equal(describeEdge(null, 'X'), null);
    assert.equal(describeEdge(marketEdge({ marketRank: 4, projectedRank: 4, pos: 'WR' }), 'X'), null);
});

test('divergences are ranked by how loud the disagreement is', () => {
    const byId = parseMarketValues([
        row('quiet', 'WR', 500, { positionRank: 10 }),
        row('loud', 'RB', 400, { positionRank: 40 }),
    ]);
    const projected = { quiet: 11, loud: 5 };
    const out = divergences(byId, (id) => projected[id]);
    assert.equal(out[0].id, 'loud');
    assert.equal(out[0].kind, 'buy-low');
    assert.ok(!out.some((d) => d.id === 'quiet'), 'a one-spot gap is not a signal');
});

// --- Fetching is best-effort ------------------------------------------------

test('an unreachable market costs the second opinion, never the app', async () => {
    const cfg = leagueOf(defaultRosterPositions());
    const boom = async () => { throw new Error('offline'); };
    assert.equal(await fetchMarketValues(cfg, { fetchImpl: boom }), null);

    const notOk = async () => ({ ok: false, status: 503 });
    assert.equal(await fetchMarketValues(cfg, { fetchImpl: notOk }), null);

    const garbage = async () => ({ ok: true, json: async () => ({ error: 'nope' }) });
    assert.equal(await fetchMarketValues(cfg, { fetchImpl: garbage }), null);
});

test('a suspiciously thin payload is refused', async () => {
    const cfg = leagueOf(defaultRosterPositions());
    const thin = async () => ({ ok: true, json: async () => [row('1', 'RB', 900)] });
    assert.equal(await fetchMarketValues(cfg, { fetchImpl: thin }), null, 'one player is not a market');
});

test('a good payload is parsed, ranked and cached', async () => {
    const cfg = leagueOf(defaultRosterPositions());
    const rows = Array.from({ length: 40 }, (_, i) => row(`p${i}`, 'RB', 9000 - i * 100));
    let calls = 0;
    const ok = async () => { calls++; return { ok: true, json: async () => rows }; };

    const saved = new Map();
    const store = { load: (k) => saved.get(k) || null, save: (k, v) => saved.set(k, v) };

    const first = await fetchMarketValues(cfg, { fetchImpl: ok, store });
    assert.equal(first.byId.size, 40);
    assert.equal(first.ranks.get('p0'), 1);
    assert.equal(calls, 1);

    const second = await fetchMarketValues(cfg, { fetchImpl: ok, store });
    assert.equal(calls, 1, 'the second call is served from cache');
    assert.equal(second.cached, true);

    await fetchMarketValues(cfg, { fetchImpl: ok, store, force: true });
    assert.equal(calls, 2, 'force always hits the network');
});

// --- What it changes downstream --------------------------------------------

/** A projection pool where the market and the projection can be made to differ. */
function fixture() {
    const projections = {};
    const players = {};
    for (let i = 0; i < 60; i++) {
        const id = `rb${i}`;
        projections[id] = { id, pos: 'RB', games: 17, stats: { rush_yd: (200 - i * 2) * 17 }, ptsHalfPpr: 1 };
        players[id] = { id, name: `RB ${i}`, pos: 'RB', team: 'KC', age: 26, injury: null };
    }
    for (let i = 0; i < 60; i++) {
        const id = `wr${i}`;
        projections[id] = { id, pos: 'WR', games: 17, stats: { rush_yd: (190 - i * 2) * 17 }, ptsHalfPpr: 1 };
        players[id] = { id, name: `WR ${i}`, pos: 'WR', team: 'KC', age: 26, injury: null };
    }
    return { projections, players };
}

test('the counterparty is priced at market, not at projection', () => {
    const { projections, players } = fixture();
    const cfg = leagueOf(defaultRosterPositions());

    // The market flatly disagrees: the projection's best back is its worst.
    const rows = Object.keys(players)
        .filter((id) => id.startsWith('rb'))
        // Ascending with index, so the projection's BEST back is the market's
        // cheapest. Reversing the array alone would leave the values in place
        // and quietly test nothing.
        .map((id, i) => row(id, 'RB', 100 + i * 10));
    const byId = parseMarketValues(rows);
    const market = { byId, ranks: marketRanks(byId) };

    const plain = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });
    const priced = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections, market });

    const best = players.rb0;
    const withoutMarket = neutralEntry(best, plain);
    const withMarket = neutralEntry(best, priced);

    assert.equal(withoutMarket.priced, 'projection');
    assert.equal(withMarket.priced, 'market');
    assert.ok(
        withMarket.value < withoutMarket.value,
        'a player the market is down on must cost less to acquire'
    );
});

test('what he SCORES comes from the projection even when the market disagrees', () => {
    // The distinction that keeps the season simulation honest: sentiment moves
    // the price, it does not put points on the board.
    const { projections, players } = fixture();
    const cfg = leagueOf(defaultRosterPositions());
    const rows = Object.keys(players)
        .filter((id) => id.startsWith('rb'))
        // Ascending with index, so the projection's BEST back is the market's
        // cheapest. Reversing the array alone would leave the values in place
        // and quietly test nothing.
        .map((id, i) => row(id, 'RB', 100 + i * 10));
    const byId = parseMarketValues(rows);

    const plain = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });
    const priced = createValuationContext(cfg, {
        week: 1, weeksLeft: 14, projections, market: { byId, ranks: marketRanks(byId) },
    });

    const best = players.rb0;
    assert.equal(
        neutralEntry(best, priced).score,
        neutralEntry(best, plain).score,
        'the market must not change how many points he is expected to score'
    );
});

test('a player the market has never heard of falls back to his projection', () => {
    const { projections, players } = fixture();
    const cfg = leagueOf(defaultRosterPositions());
    const byId = parseMarketValues([row('rb0', 'RB', 9000)]);
    const ctx = createValuationContext(cfg, {
        week: 1, weeksLeft: 14, projections, market: { byId, ranks: marketRanks(byId) },
    });

    const unknown = neutralEntry(players.rb30, ctx);
    assert.equal(unknown.priced, 'projection');
    assert.ok(unknown.value > 0, 'and still carries a usable value');
});

test('the user’s own board is untouched by the market', () => {
    const { projections, players } = fixture();
    const cfg = leagueOf(defaultRosterPositions());
    const byId = parseMarketValues(
        Object.keys(players).filter((id) => id.startsWith('rb')).map((id) => row(id, 'RB', 500))
    );
    const rankings = new Map([[players.rb0.id, 1]]);

    const plain = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });
    const priced = createValuationContext(cfg, {
        week: 1, weeksLeft: 14, projections, market: { byId, ranks: marketRanks(byId) },
    });

    // Your opinion decides what he is worth TO YOU, whatever he costs.
    assert.equal(
        buildEntries([players.rb0], rankings, priced)[0].value,
        buildEntries([players.rb0], rankings, plain)[0].value
    );
});
