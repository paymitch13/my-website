// The rest of the season's game environments, not just this week's.
//
// The Vegas tab only ever loaded the current week, which makes it a lineup
// tool. Trades are not about this week: a player on the offense with the best
// remaining implied totals is worth more than one whose schedule collapses in
// November, and nothing in the app knew that.
//
// The whole thing is free. The bye-week sweep already fetches one scoreboard
// payload per week of the regular season and reads `payload.week.teamsOnBye`
// while throwing `payload.events` away -- and ESPN posts lines for every week
// of the season in advance, verified: weeks 1, 2, 8, 15 and 17 all come back
// fully priced. Parsing what is already on the wire turns a bye map into a
// rest-of-season outlook at no additional cost.

import { mean, sortBy } from './util.js';

/** Weeks 15-17 decide leagues, whatever the regular season looked like. */
export const DEFAULT_PLAYOFF_WEEKS = [15, 16, 17];

/**
 * Per-team average implied total across a range of weeks.
 *
 * Byes are skipped rather than counted as zero: a team with a week-9 bye does
 * not have a worse offense, and averaging a zero into its schedule would say
 * so. What is measured is the environment of the games it actually plays.
 *
 * @param {Map<number, Map<string, object>>} schedule week -> team -> entry
 * @param {object} [opts]
 * @param {number} [opts.from] first week to include
 * @param {number} [opts.to]   last week to include
 * @param {Array<number>} [opts.weeks] an explicit set, overriding from/to
 */
export function impliedTotalsOverWeeks(schedule, { from = 1, to = 18, weeks = null } = {}) {
    const wanted = weeks || [];
    if (!weeks) for (let w = from; w <= to; w++) wanted.push(w);

    const byTeam = new Map();
    for (const week of wanted) {
        const games = schedule?.get(week);
        if (!games) continue;
        for (const [team, entry] of games) {
            if (!Number.isFinite(entry?.implied)) continue;
            if (!byTeam.has(team)) byTeam.set(team, []);
            byTeam.get(team).push({ week, ...entry });
        }
    }

    const out = new Map();
    for (const [team, games] of byTeam) {
        out.set(team, {
            team,
            games: games.length,
            average: mean(games.map((g) => g.implied)),
            best: sortBy(games, (g) => g.implied, -1)[0],
            worst: sortBy(games, (g) => g.implied)[0],
            weeks: sortBy(games, (g) => g.week),
        });
    }
    return out;
}

/**
 * How a team's remaining schedule compares to the league's.
 *
 * Returned as a multiplier on value, deliberately gentle. Lines eleven weeks
 * out are real information but they are not this week's information: they move,
 * injuries happen, and a season-long average of soft numbers is a weaker signal
 * than a posted line on Sunday. A 10% swing in implied points is worth a few
 * percent of trade value, not ten.
 */
export function scheduleStrength(outlook, { sensitivity = 0.35 } = {}) {
    const rows = [...outlook.values()].filter((r) => r.games > 0);
    if (rows.length < 4) return new Map();

    const league = mean(rows.map((r) => r.average));
    if (!(league > 0)) return new Map();

    const out = new Map();
    const ranked = sortBy(rows, (r) => r.average, -1);
    ranked.forEach((row, i) => {
        const ratio = row.average / league;
        out.set(row.team, {
            ...row,
            rank: i + 1,
            of: ranked.length,
            leagueAverage: league,
            edge: row.average - league,
            multiplier: 1 + (ratio - 1) * sensitivity,
        });
    });
    return out;
}

/** One sentence a trade card can use, or null when there is nothing to say. */
export function describeSchedule(row, { label = 'the rest of the season' } = {}) {
    if (!row || !row.games) return null;
    const diff = row.edge;
    if (Math.abs(diff) < 0.6) return null;

    const where = `${row.rank} of ${row.of}`;
    return diff > 0
        ? `${row.team} has one of the better remaining slates — ${row.average.toFixed(1)} implied points a game over ${label}, ${diff.toFixed(1)} above league average and ${where}.`
        : `${row.team}'s remaining slate is a drag — ${row.average.toFixed(1)} implied points a game over ${label}, ${Math.abs(diff).toFixed(1)} below league average and ${where}.`;
}

/**
 * The playoff weeks specifically, which is the argument that closes a trade.
 *
 * "His three playoff-week games are all against top-five scoring environments"
 * is a different and stronger claim than a season average, because those are
 * the only three weeks that decide anything.
 */
export function playoffOutlook(schedule, playoffWeeks = DEFAULT_PLAYOFF_WEEKS) {
    return scheduleStrength(impliedTotalsOverWeeks(schedule, { weeks: [...playoffWeeks] }));
}

/** The playoff weeks a league actually plays, from its own settings. */
export function playoffWeeksFor(cfg, { lastWeek = 17 } = {}) {
    const start = cfg?.playoffWeekStart;
    if (!Number.isFinite(start)) return DEFAULT_PLAYOFF_WEEKS;
    const weeks = [];
    for (let w = start; w <= lastWeek; w++) weeks.push(w);
    return weeks.length ? weeks : DEFAULT_PLAYOFF_WEEKS;
}

/** A player's own outlook, which is his team's. */
export const outlookFor = (strength, team) => strength?.get(team) ?? null;
