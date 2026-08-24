// Yards and touchdowns, per player, from both places that know.
//
// The app has two sources for what a player will do, and until now neither was
// ever shown as a stat line -- only as a points total after the league's
// scoring had been applied. That hides the thing people actually argue about.
// "He is projected for 62 receiving yards and half a touchdown" is a claim you
// can agree or disagree with; "he is projected for 9.2 points" is not.
//
//   PROJECTION  Sleeper's, which is always there.
//   MARKET      the posted betting lines, which exist for the current week once
//               a book puts them up, and never in preseason.
//
// Where both exist they are shown together, because the interesting number is
// the gap between them.

import { sortBy } from './util.js';

/** The lines worth showing, per position, in the order a manager reads them. */
const LINES = {
    QB: ['pass_yd', 'pass_td', 'rush_yd', 'rush_td', 'pass_int'],
    RB: ['rush_yd', 'rush_td', 'rec', 'rec_yd', 'rec_td'],
    WR: ['rec', 'rec_yd', 'rec_td', 'rush_yd', 'rush_td'],
    TE: ['rec', 'rec_yd', 'rec_td'],
    K: ['fgm', 'xpm'],
    DEF: ['sack', 'int', 'ff', 'def_td'],
};

export const STAT_LABEL = {
    pass_yd: 'Pass yds', pass_td: 'Pass TD', pass_int: 'INT',
    rush_yd: 'Rush yds', rush_td: 'Rush TD', rush_att: 'Carries',
    rec: 'Rec', rec_yd: 'Rec yds', rec_td: 'Rec TD',
    fgm: 'FG', xpm: 'XP', sack: 'Sacks', int: 'INT', ff: 'FF', def_td: 'DEF TD',
};

/** Whole numbers for counting stats, one decimal for the fractional ones. */
export function formatStat(key, value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    if (key.endsWith('_yd')) return Math.round(value).toString();
    return value >= 10 ? Math.round(value).toString() : value.toFixed(1);
}

/**
 * One player's expected line for a single week, from whichever sources have one.
 *
 * The projection is divided down to a per-game rate: Sleeper's season row is a
 * season total, and putting a 1,100-yard season next to a 62-yard betting line
 * would compare two different units and make the market look absurdly low.
 *
 * @param {object} input
 * @param {object} input.player
 * @param {object} [input.weekly]     this week's projection row, if loaded
 * @param {object} [input.season]     the season projection row
 * @param {object} [input.marketRow]  parsed props for this player
 */
export function weeklyStatLine({ player, weekly = null, season = null, marketRow = null }) {
    const keys = LINES[player?.pos] || LINES.WR;

    // A weekly row is already per-game. A season row has to be divided by the
    // games it covers.
    const perGame = (row) => {
        if (!row?.stats) return null;
        const games = row.games && row.games > 1 ? row.games : 1;
        const out = {};
        for (const [k, v] of Object.entries(row.stats)) out[k] = v / games;
        return out;
    };

    const projected = weekly?.stats ? { ...weekly.stats } : perGame(season);
    const market = marketRow?.stats || null;

    const rows = [];
    for (const key of keys) {
        const p = projected?.[key];
        const m = market?.[key];
        if (!Number.isFinite(p) && !Number.isFinite(m)) continue;
        const move = marketRow?.movement?.[key] || null;
        rows.push({
            key,
            label: STAT_LABEL[key] || key,
            projected: Number.isFinite(p) ? p : null,
            market: Number.isFinite(m) ? m : null,
            // Positive means the market is higher than the projection.
            diff: Number.isFinite(p) && Number.isFinite(m) ? m - p : null,
            movement: move,
        });
    }

    return {
        player,
        rows,
        hasMarket: rows.some((r) => r.market !== null),
        hasProjection: rows.some((r) => r.projected !== null),
    };
}

/**
 * Season-long expected line: the whole year, not one Sunday.
 *
 * The betting market has nothing to say about a season, so this is the
 * projection alone and says so. It is the number that belongs next to a trade,
 * where the question is what a player does over months rather than on Sunday.
 */
export function seasonStatLine({ player, season = null, weeksLeft = null }) {
    const keys = LINES[player?.pos] || LINES.WR;
    if (!season?.stats) return { player, rows: [], hasProjection: false, remaining: null };

    const games = season.games && season.games > 1 ? season.games : 1;
    const rows = [];
    for (const key of keys) {
        const total = season.stats[key];
        if (!Number.isFinite(total)) continue;
        rows.push({
            key,
            label: STAT_LABEL[key] || key,
            total,
            perGame: total / games,
            // What is actually still to come, which is what a trade buys.
            remaining: weeksLeft ? (total / games) * weeksLeft : null,
        });
    }
    return { player, rows, hasProjection: rows.length > 0, games, remaining: weeksLeft };
}

/**
 * Every player on a roster, with the market lines they have.
 *
 * Sorted so the players the market has an opinion about come first: those are
 * the rows worth reading, and a table that buries them under twelve
 * projection-only lines is a table nobody scrolls.
 */
export function rosterStatLines({ players, weekly = null, projections = null, marketProps = null, weeksLeft = null, mode = 'week' }) {
    const rows = (players || []).map((player) => {
        const line =
            mode === 'season'
                ? seasonStatLine({ player, season: projections?.[player.id] || null, weeksLeft })
                : weeklyStatLine({
                      player,
                      weekly: weekly?.[player.id] || null,
                      season: projections?.[player.id] || null,
                      marketRow: marketProps?.get?.(player.id) || null,
                  });
        return line;
    });

    return sortBy(
        rows.filter((r) => r.rows.length),
        (r) => (r.hasMarket ? 1 : 0),
        -1
    );
}

/**
 * Where a number came from, in words.
 *
 * A tool that shows a betting line without saying which book posted it is
 * asking to be trusted on nothing. One book is named; several are called a
 * consensus and counted.
 */
export function describeSource({ books = [], fallback = 'Sleeper projections' } = {}) {
    const names = [...new Set((books || []).map((b) => b?.provider).filter(Boolean))];
    if (!names.length) return { text: fallback, kind: 'projection', names: [] };
    if (names.length === 1) return { text: names[0], kind: 'book', names };
    return {
        text: `consensus of ${names.length} books — ${names.join(', ')}`,
        kind: 'consensus',
        names,
    };
}

/** Every distinct book that priced anything on the slate. */
export function slateBooks(games) {
    const names = new Set();
    for (const g of games || []) for (const b of g.books || []) if (b?.provider) names.add(b.provider);
    return [...names];
}
