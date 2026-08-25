// NFL bye weeks, from a response the app was already downloading.
//
// The README used to claim byes were unavailable without a paid schedule feed.
// That was wrong: ESPN's scoreboard payload carries `week.teamsOnBye` alongside
// the games, and odds.js was parsing `payload.events` while ignoring
// `payload.week` entirely. One pass over the regular season builds the whole
// map, and it unlocks bye-aware lineups, bye conflict warnings on trades, and
// playoff-week availability -- which is the thing that actually decides leagues.

import { politeFetch } from './net.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

/** ESPN abbreviations that differ from Sleeper's. */
const ALIAS = { WSH: 'WAS' };
const normalize = (t) => ALIAS[t] || t;

/** Byes only happen in the regular season, and never in the last few weeks. */
const FIRST_BYE_WEEK = 4;
const LAST_BYE_WEEK = 14;

// The sweep runs to the end of the regular season rather than stopping at the
// last possible bye. Weeks 15-17 cost four more requests and are the only
// weeks that decide a league, and ESPN posts their lines months in advance --
// verified: weeks 1, 2, 8, 15 and 17 all come back fully priced.
const LAST_SCAN_WEEK = 18;

export function extractByes(payload) {
    const list = payload?.week?.teamsOnBye;
    if (!Array.isArray(list)) return [];
    return list.map((t) => normalize(t?.abbreviation)).filter(Boolean);
}

/**
 * team abbreviation -> bye week number.
 *
 * @param {string|number} season
 * @param {object} [opts]
 * @param {number} [opts.through] last week to scan
 */
/** In-memory guard so concurrent callers share one network pass. */
const inflight = new Map();

/**
 * Cached bye weeks for a season. Hits the network at most once per season, per
 * browser.
 */
export async function loadByeWeeks(season, store) {
    return (await loadSeasonOutlook(season, store)).byes;
}

/**
 * Cached byes AND the season's posted lines. Hits the network at most once per
 * season, per browser, for both.
 */
export async function loadSeasonOutlook(season, store) {
    const cached = store.loadCachedOutlook?.(season);
    if (cached?.byes?.size) return cached;
    if (inflight.has(season)) return inflight.get(season);

    const promise = fetchSeasonOutlook(season)
        .then((outlook) => {
            if (outlook.byes.size) store.cacheOutlook?.(season, outlook);
            return outlook;
        })
        .finally(() => inflight.delete(season));
    inflight.set(season, promise);
    return promise;
}

export async function fetchByeWeeks(season, opts = {}) {
    return (await fetchSeasonOutlook(season, opts)).byes;
}

/**
 * One pass over the regular season, keeping BOTH things the payload carries.
 *
 * This function used to read `payload.week.teamsOnBye` and throw
 * `payload.events` away, which meant eleven requests were being spent to
 * produce a bye map while the whole season's posted lines went in the bin.
 *
 * @returns {{byes: Map<string, number>, schedule: Map<number, Map<string, object>>}}
 */
export async function fetchSeasonOutlook(season, { through = LAST_SCAN_WEEK } = {}) {
    const weeks = [];
    for (let w = FIRST_BYE_WEEK; w <= through; w++) weeks.push(w);

    const results = await Promise.all(
        weeks.map(async (week) => {
            try {
                const params = new URLSearchParams({
                    seasontype: '2',
                    week: String(week),
                    dates: String(season),
                });
                const res = await politeFetch(`${SCOREBOARD}?${params}`);
                if (!res.ok) return null;
                const payload = await res.json();
                return { week, teams: extractByes(payload), games: extractWeekOdds(payload) };
            } catch {
                return null;
            }
        })
    );

    const byes = new Map();
    const schedule = new Map();
    for (const r of results) {
        if (!r) continue;
        for (const team of r.teams) {
            // First week a team is listed wins; a team has exactly one bye.
            if (r.week <= LAST_BYE_WEEK && !byes.has(team)) byes.set(team, r.week);
        }
        if (r.games?.size) schedule.set(r.week, r.games);
    }
    return { byes, schedule };
}

/**
 * Implied totals for one week's games, keyed by team.
 *
 * Deliberately thin: team, opponent, home/away and the implied total, which is
 * all a rest-of-season outlook needs and small enough that a whole season fits
 * comfortably in localStorage.
 */
export function extractWeekOdds(payload) {
    const out = new Map();
    for (const event of payload?.events || []) {
        const comp = (event.competitions || [])[0];
        if (!comp) continue;
        const odds = (comp.odds || [])[0];
        const overUnder = Number(odds?.overUnder);
        const spread = Number(odds?.spread);
        if (!Number.isFinite(overUnder)) continue;

        const home = comp.competitors?.find((c) => c.homeAway === 'home');
        const away = comp.competitors?.find((c) => c.homeAway === 'away');
        const homeAbbr = normalize(home?.team?.abbreviation);
        const awayAbbr = normalize(away?.team?.abbreviation);
        if (!homeAbbr || !awayAbbr) continue;

        // ESPN's spread is always quoted from the home side.
        const half = overUnder / 2;
        const edge = Number.isFinite(spread) ? -spread / 2 : 0;
        const homeImplied = half + edge;
        const awayImplied = half - edge;

        out.set(homeAbbr, { team: homeAbbr, opponent: awayAbbr, home: true, implied: homeImplied, total: overUnder });
        out.set(awayAbbr, { team: awayAbbr, opponent: homeAbbr, home: false, implied: awayImplied, total: overUnder });
    }
    return out;
}

export const isOnBye = (byeWeeks, team, week) =>
    !!team && byeWeeks?.get(team) === week;

/**
 * Bye conflicts on a roster: weeks where several starters are all out at once.
 * A single bye is routine; three starters sharing one is a lost week.
 */
export function byeConflicts(players, byeWeeks, { fromWeek = 1, minPlayers = 2 } = {}) {
    const byWeek = new Map();
    for (const p of players || []) {
        const w = byeWeeks?.get(p.team);
        if (!w || w < fromWeek) continue;
        if (!byWeek.has(w)) byWeek.set(w, []);
        byWeek.get(w).push(p);
    }
    return [...byWeek.entries()]
        .filter(([, list]) => list.length >= minPlayers)
        .map(([week, list]) => ({ week, players: list }))
        .sort((a, b) => b.players.length - a.players.length || a.week - b.week);
}
