// Monte Carlo season simulator.
//
// A trade is not "fair" or "unfair" in the abstract -- it is good or bad for
// what you are trying to do, which is make the playoffs and win the thing. This
// module turns a set of roster strengths plus the actual remaining schedule
// into playoff and title probabilities, so the trade engine can report the only
// number that really matters: how much did this move my odds.

import { mulberry32, sortBy } from './util.js';

/** Shared across every simulation in the app so results agree between views. */
export const DEFAULT_SIM_SEED = 20260101;

/** Box-Muller against a seeded generator, so two scenarios can share draws. */
function normalDraw(rng) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {Array} teams   [{rosterId, wins, losses, ties, pointsFor, mu, sigma}]
 * @param {Array} schedule [{week, pairs: [[rosterIdA, rosterIdB], ...]}]
 * @param {object} opts
 */
export function simulateSeason(teams, schedule, opts = {}) {
    const {
        iterations = 2500,
        playoffTeams = 6,
        // A fixed seed means running the same league twice gives the same
        // answer, and -- more importantly -- lets the trade engine compare
        // "with trade" against "without trade" using identical random weeks.
        // Every caller must share it, or the same team's playoff odds differ
        // between the Trade view and the Power Rankings view.
        seed = DEFAULT_SIM_SEED,
        medianScoring = false,
    } = opts;

    const n = teams.length;
    const idx = new Map(teams.map((t, i) => [t.rosterId, i]));

    const madePlayoffs = new Array(n).fill(0);
    const wonTitle = new Array(n).fill(0);
    const madeFinal = new Array(n).fill(0);
    const gotBye = new Array(n).fill(0);
    const totalWins = new Array(n).fill(0);
    const totalSeed = new Array(n).fill(0);
    const totalPf = new Array(n).fill(0);

    const rng = mulberry32(seed);

    const wins = new Float64Array(n);
    const pf = new Float64Array(n);
    const weekScores = new Float64Array(n);

    for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
            wins[i] = teams[i].wins + 0.5 * (teams[i].ties || 0);
            pf[i] = teams[i].pointsFor || 0;
        }

        for (const wk of schedule) {
            for (let i = 0; i < n; i++) {
                weekScores[i] = Math.max(0, teams[i].mu + teams[i].sigma * normalDraw(rng));
                pf[i] += weekScores[i];
            }
            for (const [a, b] of wk.pairs) {
                const ia = idx.get(a);
                const ib = idx.get(b);
                if (ia === undefined || ib === undefined) continue;
                if (weekScores[ia] > weekScores[ib]) wins[ia] += 1;
                else if (weekScores[ib] > weekScores[ia]) wins[ib] += 1;
                else {
                    wins[ia] += 0.5;
                    wins[ib] += 0.5;
                }
            }
            if (medianScoring) {
                // Some leagues award a second weekly win for beating the median.
                const sorted = Array.from(weekScores).sort((x, y) => x - y);
                const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
                for (let i = 0; i < n; i++) if (weekScores[i] > median) wins[i] += 1;
            }
        }

        const standings = sortBy(
            teams.map((t, i) => ({ i, w: wins[i], pf: pf[i] })),
            (t) => t.w * 1e6 + t.pf,
            -1
        );

        for (let s = 0; s < n; s++) {
            const t = standings[s];
            totalWins[t.i] += t.w;
            totalSeed[t.i] += s + 1;
            totalPf[t.i] += t.pf;
            if (s < playoffTeams) madePlayoffs[t.i] += 1;
        }

        const field = standings.slice(0, playoffTeams).map((t) => t.i);
        const result = simulateBracket(field, teams, rng);
        wonTitle[result.champion] += 1;
        for (const f of result.finalists) madeFinal[f] += 1;
        for (const b of result.byes) gotBye[b] += 1;
    }

    return teams.map((t, i) => ({
        rosterId: t.rosterId,
        playoffOdds: madePlayoffs[i] / iterations,
        titleOdds: wonTitle[i] / iterations,
        finalsOdds: madeFinal[i] / iterations,
        byeOdds: gotBye[i] / iterations,
        projectedWins: totalWins[i] / iterations,
        projectedSeed: totalSeed[i] / iterations,
        projectedPointsFor: totalPf[i] / iterations,
        mu: t.mu,
    }));
}

/**
 * Single-elimination bracket seeded 1..N. When N is not a power of two the top
 * seeds get first-round byes, which is how Sleeper's default bracket works.
 */
function simulateBracket(field, teams, rng) {
    if (!field.length) return { champion: 0, finalists: [], byes: [] };
    if (field.length === 1) return { champion: field[0], finalists: [field[0]], byes: [field[0]] };

    const n = field.length;
    const pow = 2 ** Math.floor(Math.log2(n));
    const playInCount = 2 * (n - pow);
    // Only teams that sit out a round have a bye. When the field is already a
    // power of two nobody does -- treating the whole field as "on bye" made
    // byeOdds 100% for every playoff team.
    const byes = playInCount > 0 ? field.slice(0, n - playInCount) : [];

    let alive = field.slice();
    if (playInCount > 0) {
        const playIn = field.slice(n - playInCount);
        const winners = [];
        for (let i = 0; i < playIn.length / 2; i++) {
            winners.push(playGame(playIn[i], playIn[playIn.length - 1 - i], teams, rng));
        }
        alive = [...byes, ...winners];
        // Re-seed so the best remaining team keeps facing the worst.
        alive.sort((a, b) => field.indexOf(a) - field.indexOf(b));
    }

    let finalists = alive.slice();
    while (alive.length > 1) {
        finalists = alive.slice();
        const next = [];
        for (let i = 0; i < alive.length / 2; i++) {
            next.push(playGame(alive[i], alive[alive.length - 1 - i], teams, rng));
        }
        next.sort((a, b) => field.indexOf(a) - field.indexOf(b));
        alive = next;
    }

    return { champion: alive[0], finalists, byes };
}

function playGame(a, b, teams, rng) {
    const sa = teams[a].mu + teams[a].sigma * normalDraw(rng);
    const sb = teams[b].mu + teams[b].sigma * normalDraw(rng);
    if (sa === sb) return rng() < 0.5 ? a : b;
    return sa > sb ? a : b;
}

/**
 * Extract the remaining regular-season schedule from Sleeper matchup payloads.
 * `matchupsByWeek` maps week number -> raw /matchups/<week> response.
 */
export function buildSchedule(matchupsByWeek, fromWeek, throughWeek) {
    const schedule = [];
    for (let week = fromWeek; week <= throughWeek; week++) {
        const raw = matchupsByWeek.get(week);
        if (!raw || !raw.length) continue;
        const byMatchup = new Map();
        for (const m of raw) {
            if (m.matchup_id === null || m.matchup_id === undefined) continue;
            if (!byMatchup.has(m.matchup_id)) byMatchup.set(m.matchup_id, []);
            byMatchup.get(m.matchup_id).push(m.roster_id);
        }
        const pairs = [...byMatchup.values()].filter((p) => p.length === 2);
        if (pairs.length) schedule.push({ week, pairs });
    }
    return schedule;
}

/**
 * Fallback when Sleeper has not published future weeks yet: a round-robin so
 * the simulator still has something structurally sane to run on.
 */
export function syntheticSchedule(rosterIds, fromWeek, throughWeek) {
    const ids = rosterIds.slice();
    if (ids.length % 2) ids.push(null);
    const schedule = [];
    const half = ids.length / 2;
    let rotation = ids.slice(1);

    for (let week = fromWeek; week <= throughWeek; week++) {
        const round = [ids[0], ...rotation];
        const pairs = [];
        for (let i = 0; i < half; i++) {
            const a = round[i];
            const b = round[round.length - 1 - i];
            if (a !== null && b !== null) pairs.push([a, b]);
        }
        schedule.push({ week, pairs });
        rotation = [rotation[rotation.length - 1], ...rotation.slice(0, -1)];
    }
    return schedule;
}

/**
 * Strength of remaining schedule: the average opponent scoring mean each team
 * still has to face, expressed relative to the league average.
 */
export function scheduleStrength(teams, schedule) {
    const muById = new Map(teams.map((t) => [t.rosterId, t.mu]));
    const leagueMu = teams.reduce((a, t) => a + t.mu, 0) / (teams.length || 1);
    const totals = new Map(teams.map((t) => [t.rosterId, { sum: 0, games: 0 }]));

    for (const wk of schedule) {
        for (const [a, b] of wk.pairs) {
            if (totals.has(a) && muById.has(b)) {
                totals.get(a).sum += muById.get(b);
                totals.get(a).games += 1;
            }
            if (totals.has(b) && muById.has(a)) {
                totals.get(b).sum += muById.get(a);
                totals.get(b).games += 1;
            }
        }
    }

    const out = new Map();
    for (const [id, t] of totals) {
        const avg = t.games ? t.sum / t.games : leagueMu;
        out.set(id, { avgOpponent: avg, relative: avg - leagueMu, games: t.games });
    }
    return out;
}
