import test from 'node:test';
import assert from 'node:assert/strict';

import {
    weeklyStatLine, seasonStatLine, rosterStatLines, describeSource, slateBooks,
    formatStat, STAT_LABEL,
} from '../js/statlines.js';

const wr = { id: 'w1', name: 'Receiver', pos: 'WR', team: 'DAL' };
const qb = { id: 'q1', name: 'Passer', pos: 'QB', team: 'DAL' };

/** A Sleeper season projection row: totals across a whole year. */
const seasonRow = (stats, games = 17) => ({ id: 'w1', pos: 'WR', stats, games });

test('a season projection is divided down before it meets a weekly betting line', () => {
    // A 1,100-yard SEASON next to a 62-yard weekly line compares two different
    // units and makes the market look absurdly low.
    const line = weeklyStatLine({
        player: wr,
        season: seasonRow({ rec_yd: 1105, rec: 85, rec_td: 8.5 }),
        marketRow: { stats: { rec_yd: 62.5, rec: 5.5 } },
    });

    const yards = line.rows.find((r) => r.key === 'rec_yd');
    assert.ok(Math.abs(yards.projected - 65) < 0.01, `expected ~65 per game, got ${yards.projected}`);
    assert.equal(yards.market, 62.5);
    assert.ok(yards.diff < 0, 'the market is a touch lower here');
});

test('a weekly projection is already per game and is not divided again', () => {
    const line = weeklyStatLine({
        player: wr,
        weekly: { stats: { rec_yd: 65, rec: 5 }, games: 1 },
        season: seasonRow({ rec_yd: 1105 }),
    });
    assert.equal(line.rows.find((r) => r.key === 'rec_yd').projected, 65);
});

test('each position shows the lines that position is actually judged on', () => {
    const passer = weeklyStatLine({
        player: qb,
        season: { stats: { pass_yd: 4200, pass_td: 30, rush_yd: 340, rush_td: 4, pass_int: 11 }, games: 17 },
    });
    const keys = passer.rows.map((r) => r.key);
    assert.ok(keys.includes('pass_yd') && keys.includes('pass_td'), 'a quarterback is his passing line');
    assert.ok(keys.includes('rush_yd'), 'and his legs');
    assert.ok(!keys.includes('rec'), 'receptions are not a quarterback stat');

    const catcher = weeklyStatLine({ player: wr, season: seasonRow({ rec: 85, rec_yd: 1105, rec_td: 8 }) });
    assert.deepEqual(catcher.rows.map((r) => r.key), ['rec', 'rec_yd', 'rec_td']);
});

test('a stat nobody has a number for is left out, not shown as zero', () => {
    const line = weeklyStatLine({ player: wr, season: seasonRow({ rec_yd: 900 }) });
    assert.deepEqual(line.rows.map((r) => r.key), ['rec_yd']);
});

test('a market line with no projection still shows, and vice versa', () => {
    const marketOnly = weeklyStatLine({ player: wr, marketRow: { stats: { rec_yd: 62.5, rec: 5.5 } } });
    assert.equal(marketOnly.hasMarket, true);
    assert.equal(marketOnly.hasProjection, false);
    assert.equal(marketOnly.rows.find((r) => r.key === 'rec_yd').projected, null);

    const projOnly = weeklyStatLine({ player: wr, season: seasonRow({ rec_yd: 900 }) });
    assert.equal(projOnly.hasMarket, false);
    assert.equal(projOnly.hasProjection, true);
});

test('line movement rides along with the stat it moved', () => {
    const line = weeklyStatLine({
        player: wr,
        marketRow: {
            stats: { rec_yd: 82.5, rec: 6.5 },
            movement: { rec_yd: { open: 74.5, current: 82.5, change: 8 } },
        },
    });
    assert.equal(line.rows.find((r) => r.key === 'rec_yd').movement.change, 8);
    assert.equal(line.rows.find((r) => r.key === 'rec').movement, null);
});

// --- Season mode -----------------------------------------------------------

test('the season line reports the whole year AND what is still to come', () => {
    // A trade buys the rest of the season, not the part already played.
    const line = seasonStatLine({ player: wr, season: seasonRow({ rec_yd: 1105, rec_td: 8.5 }), weeksLeft: 8 });
    const yards = line.rows.find((r) => r.key === 'rec_yd');
    assert.equal(yards.total, 1105);
    assert.ok(Math.abs(yards.perGame - 65) < 0.01);
    assert.ok(Math.abs(yards.remaining - 520) < 0.01, `8 weeks of 65 is 520, got ${yards.remaining}`);
});

test('a player with no projection has no season line rather than an empty one', () => {
    const line = seasonStatLine({ player: wr, season: null });
    assert.equal(line.hasProjection, false);
    assert.deepEqual(line.rows, []);
});

// --- A whole roster --------------------------------------------------------

test('players the market has priced come first', () => {
    // A table that buries the two rows with betting lines under twelve
    // projection-only rows is a table nobody scrolls.
    const players = [
        { id: 'a', name: 'A', pos: 'WR' },
        { id: 'b', name: 'B', pos: 'WR' },
        { id: 'c', name: 'C', pos: 'WR' },
    ];
    const projections = {
        a: seasonRow({ rec_yd: 800 }),
        b: seasonRow({ rec_yd: 900 }),
        c: seasonRow({ rec_yd: 700 }),
    };
    const marketProps = new Map([['c', { stats: { rec_yd: 55, rec: 4.5 } }]]);

    const rows = rosterStatLines({ players, projections, marketProps });
    assert.equal(rows[0].player.id, 'c', 'the priced player leads');
    assert.equal(rows.length, 3, 'and nobody is dropped');
});

test('season mode ignores the weekly market entirely', () => {
    // The betting market has nothing to say about a season, so pretending it
    // does would be inventing a source.
    const players = [{ id: 'a', name: 'A', pos: 'WR' }];
    const rows = rosterStatLines({
        players,
        projections: { a: seasonRow({ rec_yd: 900, rec_td: 6 }) },
        marketProps: new Map([['a', { stats: { rec_yd: 55 } }]]),
        weeksLeft: 9,
        mode: 'season',
    });
    assert.equal(rows[0].hasMarket, undefined, 'season lines carry no market flag');
    assert.ok(rows[0].rows[0].remaining > 0);
});

// --- Attribution -----------------------------------------------------------

test('one book is named outright', () => {
    const src = describeSource({ books: [{ provider: 'DraftKings' }] });
    assert.equal(src.kind, 'book');
    assert.equal(src.text, 'DraftKings');
});

test('several books are a counted consensus, and all of them are named', () => {
    const src = describeSource({ books: [{ provider: 'DraftKings' }, { provider: 'ESPN BET' }] });
    assert.equal(src.kind, 'consensus');
    assert.match(src.text, /consensus of 2 books/);
    assert.match(src.text, /DraftKings/);
    assert.match(src.text, /ESPN BET/);
});

test('the same book listed twice is still one book', () => {
    const src = describeSource({ books: [{ provider: 'DraftKings' }, { provider: 'DraftKings' }] });
    assert.equal(src.kind, 'book');
    assert.deepEqual(src.names, ['DraftKings']);
});

test('with no book, the source is named honestly rather than left blank', () => {
    // A tool that shows a number without saying where it came from is asking to
    // be trusted on nothing.
    const src = describeSource({ books: [] });
    assert.equal(src.kind, 'projection');
    assert.equal(src.text, 'Sleeper projections');
});

test('the slate reports every distinct book that priced anything on it', () => {
    const games = [
        { books: [{ provider: 'DraftKings' }] },
        { books: [{ provider: 'DraftKings' }, { provider: 'ESPN BET' }] },
        { books: [] },
        {},
    ];
    assert.deepEqual(slateBooks(games).sort(), ['DraftKings', 'ESPN BET']);
});

// --- Formatting ------------------------------------------------------------

test('yards are whole numbers and fractions keep a decimal', () => {
    assert.equal(formatStat('rec_yd', 62.4), '62');
    assert.equal(formatStat('rec_td', 0.55), '0.6');
    assert.equal(formatStat('rec', 5.5), '5.5');
    assert.equal(formatStat('pass_yd', 265.5), '266');
    assert.equal(formatStat('rec_yd', null), '—');
});

test('every stat that can be shown has a readable name', () => {
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
        const line = weeklyStatLine({
            player: { id: 'x', pos },
            season: {
                games: 17,
                stats: {
                    pass_yd: 100, pass_td: 1, pass_int: 1, rush_yd: 100, rush_td: 1,
                    rec: 10, rec_yd: 100, rec_td: 1, fgm: 10, xpm: 10,
                    sack: 10, int: 5, ff: 3, def_td: 1,
                },
            },
        });
        for (const row of line.rows) {
            assert.ok(STAT_LABEL[row.key], `${row.key} has no label`);
            assert.notEqual(row.label, row.key, `${row.key} renders as a raw key`);
        }
    }
});
