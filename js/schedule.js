// NFL bye weeks, from a response the app was already downloading.
//
// The README used to claim byes were unavailable without a paid schedule feed.
// That was wrong: ESPN's scoreboard payload carries `week.teamsOnBye` alongside
// the games, and odds.js was parsing `payload.events` while ignoring
// `payload.week` entirely. One pass over the regular season builds the whole
// map, and it unlocks bye-aware lineups, bye conflict warnings on trades, and
// playoff-week availability -- which is the thing that actually decides leagues.

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

/** ESPN abbreviations that differ from Sleeper's. */
const ALIAS = { WSH: 'WAS' };
const normalize = (t) => ALIAS[t] || t;

/** Byes only happen in the regular season, and never in the last few weeks. */
const FIRST_BYE_WEEK = 4;
const LAST_BYE_WEEK = 14;

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
export async function fetchByeWeeks(season, { through = LAST_BYE_WEEK } = {}) {
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
                const res = await fetch(`${SCOREBOARD}?${params}`);
                if (!res.ok) return null;
                return { week, teams: extractByes(await res.json()) };
            } catch {
                return null;
            }
        })
    );

    const byTeam = new Map();
    for (const r of results) {
        if (!r) continue;
        for (const team of r.teams) {
            // First week a team is listed wins; a team has exactly one bye.
            if (!byTeam.has(team)) byTeam.set(team, r.week);
        }
    }
    return byTeam;
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
