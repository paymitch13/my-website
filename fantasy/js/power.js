// The Payton Mitchell Power Rankings.
//
// A record is a bad power ranking. Two teams at 4-2 can be completely different
// teams: one has the best roster in the league and has been beaten by the
// week's high score twice, the other has been squeaking out wins with the
// eighth-best roster and a friendly schedule. This engine separates the two by
// blending what a team *is* (roster strength, depth) with what it has actually
// *done*, corrected for luck, and where it is *going*.
//
// Every component is exposed on the result so the board can show its work.

import { optimizeLineup, positionalReport, teamScoringProfile } from './lineup.js';
import { buildEntries } from './trade.js';
import { simulateSeason, scheduleStrength } from './sim.js';
import { clamp, mean, round, sortBy, stdev, sum } from './util.js';

const WEIGHTS = {
    roster: 0.4,
    allPlay: 0.2,
    title: 0.2,
    form: 0.1,
    depth: 0.1,
};

/**
 * @param {object}  input
 * @param {Array}   input.teams        [{rosterId, name, owner, players, wins, losses, ties, pointsFor, pointsAgainst}]
 * @param {Map}     input.weeklyScores rosterId -> [{week, points}]
 * @param {Array}   [input.schedule]   remaining schedule for the odds component
 */
export function computePowerRankings(input) {
    const { cfg, ctx, teams, rankings, weeklyScores = new Map(), schedule = null, iterations = 2000, week = 1 } = input;

    const rows = teams.map((team) => {
        const entries = buildEntries(team.players, rankings, ctx);
        const lineup = optimizeLineup(entries, cfg.starterSlots);
        const report = positionalReport(entries, cfg.starterSlots);
        const profile = teamScoringProfile(lineup.points);

        return {
            team,
            rosterId: team.rosterId,
            entries,
            lineup,
            report,
            mu: profile.mu,
            sigma: profile.sigma,
            starters: lineup.starters,
            depthScore: resilience(entries, cfg.starterSlots, lineup.points),
        };
    });

    // --- Luck correction: all-play record ----------------------------------
    const allPlay = computeAllPlay(teams, weeklyScores);
    for (const r of rows) {
        const ap = allPlay.get(r.rosterId) || { winPct: 0.5, expectedWins: 0, games: 0 };
        r.allPlayWinPct = ap.winPct;
        r.expectedWins = ap.expectedWins;
        r.actualWins = (r.team.wins || 0) + 0.5 * (r.team.ties || 0);
        r.luck = r.actualWins - ap.expectedWins;
        r.games = ap.games;

        const scores = (weeklyScores.get(r.rosterId) || []).slice().sort((a, b) => a.week - b.week);
        r.scores = scores;
        r.form = recentForm(scores);
        r.pointsFor = r.team.pointsFor ?? sum(scores, (s) => s.points);
    }

    // --- Forward-looking: playoff and title odds ---------------------------
    if (schedule && schedule.length) {
        const simTeams = rows.map((r) => ({
            rosterId: r.rosterId,
            wins: r.team.wins || 0,
            losses: r.team.losses || 0,
            ties: r.team.ties || 0,
            pointsFor: r.pointsFor || 0,
            mu: r.mu,
            sigma: r.sigma,
        }));
        const sim = simulateSeason(simTeams, schedule, {
            iterations,
            playoffTeams: cfg.playoffTeams,
            medianScoring: cfg.medianScoring,
        });
        const byId = new Map(sim.map((s) => [s.rosterId, s]));
        const sos = scheduleStrength(simTeams, schedule);
        for (const r of rows) {
            const s = byId.get(r.rosterId);
            r.playoffOdds = s.playoffOdds;
            r.titleOdds = s.titleOdds;
            r.byeOdds = s.byeOdds;
            r.projectedWins = s.projectedWins;
            r.projectedSeed = s.projectedSeed;
            r.sos = sos.get(r.rosterId) || { relative: 0, games: 0 };
        }
    } else {
        for (const r of rows) {
            r.playoffOdds = null;
            r.titleOdds = null;
            r.sos = { relative: 0, games: 0 };
        }
    }

    // --- Composite ---------------------------------------------------------
    const z = makeZ(rows);
    const leagueFormAvg = mean(rows.map((r) => r.form.avg).filter((n) => n > 0));

    for (const r of rows) {
        r.components = {
            roster: z('mu', r.mu),
            allPlay: r.games ? z('allPlayWinPct', r.allPlayWinPct) : 0,
            title: r.titleOdds === null ? 0 : z('titleOdds', r.titleOdds),
            form: r.form.games ? clamp((r.form.avg - leagueFormAvg) / (leagueFormAvg * 0.18 || 1), -2.5, 2.5) : 0,
            depth: z('depthScore', r.depthScore),
        };

        // If the season has not started there is no performance signal at all,
        // so roster strength has to carry the whole ranking.
        const live = r.games > 0;
        const w = live ? WEIGHTS : { roster: 0.78, allPlay: 0, title: 0.12, form: 0, depth: 0.1 };

        r.score = Object.entries(w).reduce((acc, [k, weight]) => acc + weight * r.components[k], 0);
    }

    const ranked = sortBy(rows, (r) => r.score, -1);
    ranked.forEach((r, i) => {
        r.rank = i + 1;
        // 0-100 for display; the raw score is a weighted z-score around zero.
        r.rating = clamp(Math.round(50 + r.score * 16), 1, 99);
    });

    assignTiers(ranked);
    const context = leagueContext(ranked);
    for (const r of ranked) r.blurb = writeBlurb(r, ranked, cfg, week, context);

    return ranked;
}

/**
 * How much of the starting lineup survives losing its most important player at
 * each position. A team that collapses when one man goes down is not as good as
 * its top-end suggests.
 */
function resilience(entries, slots, basePoints) {
    if (!basePoints) return 0;
    const positions = ['QB', 'RB', 'WR', 'TE'];
    const retained = [];
    for (const pos of positions) {
        const best = sortBy(entries.filter((e) => e.player.pos === pos), (e) => e.score, -1)[0];
        if (!best) continue;
        const without = optimizeLineup(entries.filter((e) => e !== best), slots).points;
        retained.push(without / basePoints);
    }
    return retained.length ? mean(retained) : 0;
}

/**
 * All-play: what a team's record would be if it played every other team every
 * week. It strips out schedule luck almost entirely, and the gap between it and
 * the real record is the single most useful number in a power ranking.
 */
export function computeAllPlay(teams, weeklyScores) {
    const out = new Map();
    const weeks = new Set();
    for (const list of weeklyScores.values()) for (const s of list) weeks.add(s.week);

    const tally = new Map(teams.map((t) => [t.rosterId, { beat: 0, opportunities: 0, games: 0 }]));

    for (const week of [...weeks].sort((a, b) => a - b)) {
        const scores = [];
        for (const t of teams) {
            const rec = (weeklyScores.get(t.rosterId) || []).find((s) => s.week === week);
            if (rec && Number.isFinite(rec.points)) scores.push({ rosterId: t.rosterId, points: rec.points });
        }
        if (scores.length < 2) continue;
        for (const s of scores) {
            const beat = scores.filter((o) => o.rosterId !== s.rosterId && s.points > o.points).length;
            const tied = scores.filter((o) => o.rosterId !== s.rosterId && s.points === o.points).length;
            const t = tally.get(s.rosterId);
            if (!t) continue;
            t.beat += beat + tied * 0.5;
            t.opportunities += scores.length - 1;
            t.games += 1;
        }
    }

    for (const [rosterId, t] of tally) {
        const winPct = t.opportunities ? t.beat / t.opportunities : 0.5;
        out.set(rosterId, { winPct, expectedWins: winPct * t.games, games: t.games });
    }
    return out;
}

/** Weighted average of the last three weeks, most recent week heaviest. */
function recentForm(scores) {
    const last = scores.slice(-3);
    if (!last.length) return { avg: 0, games: 0, trend: 0 };
    const weights = [0.2, 0.3, 0.5].slice(-last.length);
    const wsum = sum(weights);
    const avg = last.reduce((a, s, i) => a + s.points * weights[i], 0) / wsum;
    const early = mean(scores.slice(0, -3).map((s) => s.points));
    return { avg, games: last.length, trend: early ? avg - early : 0 };
}

/** z-score helper that memoizes each field's mean and spread across the league. */
function makeZ(rows) {
    const cache = new Map();
    return (field, value) => {
        if (!cache.has(field)) {
            const vals = rows.map((r) => r[field]).filter((v) => Number.isFinite(v));
            cache.set(field, { m: mean(vals), s: stdev(vals) || 1 });
        }
        const { m, s } = cache.get(field);
        return clamp((value - m) / s, -3, 3);
    };
}

const TIER_NAMES = ['Contenders', 'In the hunt', 'Bubble', 'Longshots', 'Rebuilding'];

/** Tier breaks fall at the largest gaps in composite score. */
function assignTiers(ranked) {
    if (ranked.length < 4) {
        ranked.forEach((r) => {
            r.tier = 0;
            r.tierName = TIER_NAMES[0];
        });
        return;
    }
    const gaps = [];
    for (let i = 0; i < ranked.length - 1; i++) gaps.push({ at: i, drop: ranked[i].score - ranked[i + 1].score });
    const wanted = Math.min(TIER_NAMES.length - 1, Math.max(2, Math.round(ranked.length / 3)));
    const breaks = new Set(
        sortBy(gaps, (g) => g.drop, -1)
            .slice(0, wanted)
            .map((g) => g.at)
    );

    let tier = 0;
    ranked.forEach((r, i) => {
        r.tier = tier;
        r.tierName = TIER_NAMES[Math.min(tier, TIER_NAMES.length - 1)];
        if (breaks.has(i)) tier++;
    });
}

/**
 * League-wide reference points a blurb needs to say anything non-obvious:
 * average starting production at each position, and who actually owns the
 * superlatives. Computed once for the whole board.
 */
function leagueContext(ranked) {
    const positions = ['QB', 'RB', 'WR', 'TE'];
    const avgByPos = {};
    for (const pos of positions) {
        avgByPos[pos] = mean(ranked.map((r) => r.report.byPosition[pos]?.startingPoints ?? 0));
    }
    const played = ranked.filter((r) => r.games >= 3);
    const rosterOrder = sortBy(ranked, (x) => x.mu, -1).map((x) => x.rosterId);
    return {
        positions,
        avgByPos,
        rosterOrder,
        mostUnlucky: played.length ? sortBy(played, (r) => r.luck)[0] : null,
        luckiest: played.length ? sortBy(played, (r) => r.luck, -1)[0] : null,
    };
}

/**
 * The blurb is the product. Rules:
 *
 *  - Lead with the single biggest disconnect between what a team IS and what it
 *    has DONE. That is the only thing a power ranking can tell you that the
 *    standings cannot.
 *  - Strengths and weaknesses are league-relative. Saying "TE is the soft spot"
 *    because tight ends score fewer points than running backs is true of every
 *    roster in every league and therefore worthless.
 *  - Superlatives belong to exactly one team.
 *  - Never stack two claims that argue with each other.
 */
function writeBlurb(r, ranked, cfg, week, context) {
    const n = ranked.length;
    const rec = `${r.team.wins || 0}-${r.team.losses || 0}${r.team.ties ? `-${r.team.ties}` : ''}`;
    const rosterRank = context.rosterOrder.indexOf(r.rosterId) + 1;
    const topHalfRoster = rosterRank <= n / 2;
    const played = r.games >= 3;

    // --- Lead ---------------------------------------------------------------
    let lead;
    if (played && r.luck <= -1.5 && topHalfRoster) {
        const superlative = context.mostUnlucky?.rosterId === r.rosterId && r.luck <= -2;
        lead = `${superlative ? 'The most unlucky team in the league.' : 'Better than the record.'} ${rec} hides an all-play mark of ${pctStr(r.allPlayWinPct)} — on a neutral schedule they are a ${r.expectedWins.toFixed(1)}-win team.`;
    } else if (played && r.luck >= 1.5 && !topHalfRoster) {
        const superlative = context.luckiest?.rosterId === r.rosterId && r.luck >= 2;
        lead = `${superlative ? 'The luckiest team in the league.' : 'The record is running ahead of the roster.'} ${rec} on ${pctStr(r.allPlayWinPct)} all-play means roughly ${r.luck.toFixed(1)} wins they did not earn.`;
    } else if (played && r.luck <= -1.5) {
        // Bad roster AND bad luck. Worth saying, but it is not an argument that
        // the team is secretly good, so it gets its own honest framing.
        // "even at 40%" concedes; "at 66%" does not. Match the word to the number.
        const concessive = r.allPlayWinPct < 0.5 ? 'even at' : 'at';
        lead = `${rec}, and unlucky on top of it — ${concessive} ${pctStr(r.allPlayWinPct)} all-play they project as a ${r.expectedWins.toFixed(1)}-win team with the ${ordinal(rosterRank)}-best roster.`;
    } else if (rosterRank === 1 && r.rank === 1) {
        lead = `Best roster in the league and the record backs it up at ${rec}.`;
    } else if (rosterRank === 1) {
        lead = `The best raw roster in the league at ${round(r.mu, 1)} projected points a week — the results just have not caught up.`;
    } else if (r.rank === 1) {
        lead = `Top of the board at ${rec} with the ${ordinal(rosterRank)}-best roster.`;
    } else if (r.rank <= 3) {
        lead = `${rec} and genuinely good — ${ordinal(rosterRank)}-best roster with ${round(r.mu, 1)} points a week.`;
    } else {
        lead = `${rec}, ${ordinal(rosterRank)}-best roster in the league.`;
    }

    const bits = [lead];

    // --- Roster shape, measured against the rest of the league ---------------
    const deltas = context.positions
        .filter((pos) => (r.report.byPosition[pos]?.starting ?? 0) > 0)
        .map((pos) => ({ pos, delta: (r.report.byPosition[pos]?.startingPoints ?? 0) - context.avgByPos[pos] }));

    if (deltas.length) {
        const worst = sortBy(deltas, (d) => d.delta)[0];
        const best = sortBy(deltas, (d) => d.delta, -1)[0];
        // Rotate phrasing off the roster id so a twelve-team board does not read
        // like the same sentence pasted twelve times. Stable across weeks.
        const pick = (variants) => variants[r.rosterId % variants.length];
        if (worst.delta < -2.5) {
            const gap = round(Math.abs(worst.delta), 1);
            bits.push(
                pick([
                    `${worst.pos} is the hole: ${gap} points a week below what the average team here gets from the spot.`,
                    `They are giving away ${gap} points a week at ${worst.pos} against the rest of the league.`,
                    `${worst.pos} is where the season leaks — ${gap} points a week under league average.`,
                ])
            );
        } else if (best.delta > 4) {
            const edge = round(best.delta, 1);
            bits.push(
                pick([
                    `${best.pos} is the engine, ${edge} points a week clear of league average.`,
                    `They win at ${best.pos}, where they bank an extra ${edge} points a week.`,
                    `${edge} points a week of edge at ${best.pos} is what carries this roster.`,
                ])
            );
        }
    }

    // --- Fragility -----------------------------------------------------------
    const qbDrop = r.report.byPosition.QB?.dropoff ?? 0;
    if (qbDrop > 12) bits.push(`One quarterback injury away from a lost season — there is nothing behind him.`);

    // --- Trajectory ----------------------------------------------------------
    if (r.form.games >= 3 && r.form.trend > 12) bits.push(`Peaking late: the last three weeks are their best stretch of the year.`);
    else if (r.form.games >= 3 && r.form.trend < -12) bits.push(`Fading, and the schedule is running out.`);
    else if (r.sos?.games >= 2 && r.sos.relative > 6) bits.push(`The hardest remaining schedule in the league is still to come.`);
    else if (r.sos?.games >= 2 && r.sos.relative < -6) bits.push(`A soft closing schedule is doing them a favor.`);

    // --- Where the season is going -------------------------------------------
    if (r.titleOdds !== null && r.titleOdds > 0.2) bits.push(`Title odds: ${pctStr(r.titleOdds)}.`);
    else if (r.playoffOdds !== null && r.playoffOdds < 0.08 && week > 6) bits.push(`At ${pctStr(r.playoffOdds)} to make the field, this is a next-year roster.`);
    else if (r.playoffOdds !== null && bits.length < 2) {
        // Never leave a team with a single bare sentence.
        bits.push(`${pctStr(r.playoffOdds)} to make the playoffs, ${pctStr(r.titleOdds)} to win it.`);
    }

    return bits.slice(0, 3).join(' ');
}

const pctStr = (n) => `${Math.round(n * 100)}%`;

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Movement arrows against a stored snapshot from an earlier week. */
export function applyMovement(ranked, snapshot) {
    const prev = new Map((snapshot?.ranking || []).map((r) => [r.rosterId, r.rank]));
    for (const r of ranked) {
        const was = prev.get(r.rosterId);
        r.previousRank = was ?? null;
        r.movement = was ? was - r.rank : 0;
    }
    return ranked;
}

/** Compact form for storing a week's result. */
export const toSnapshot = (ranked) =>
    ranked.map((r) => ({ rosterId: r.rosterId, rank: r.rank, rating: r.rating, name: r.team.name }));

/** Plain-text export, for pasting straight into a league chat. */
export function toShareText(ranked, leagueName, week) {
    const lines = [`PAYTON MITCHELL POWER RANKINGS — ${leagueName}, Week ${week}`, ''];
    for (const r of ranked) {
        const move = r.movement > 0 ? ` (▲${r.movement})` : r.movement < 0 ? ` (▼${Math.abs(r.movement)})` : '';
        lines.push(`${r.rank}. ${r.team.name} (${r.team.wins || 0}-${r.team.losses || 0})${move} — ${r.rating}`);
        lines.push(`   ${r.blurb}`);
    }
    return lines.join('\n');
}
