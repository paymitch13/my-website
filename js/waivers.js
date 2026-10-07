// Waiver wire recommendations.
//
// What this replaces: eighteen lines that ranked every free agent by how much
// he would add to the optimal lineup, kept the top eight, and printed them in
// a panel about FAAB. Not wrong -- marginal lineup value is the right spine,
// and ranking by it is what stops a tool recommending a better player who
// cannot crack the lineup. But it answered one question out of the five a
// manager actually has, and it answered that one with a single number and no
// reason attached.
//
// The signals needed to do better were all already being fetched for other
// screens and simply never joined up:
//
//   usage.js      snap share, targets, touches and red-zone work, trending
//                 over the last three games against the ones before. A role
//                 expanding is the earliest honest signal there is, and it
//                 shows up a week or two before the box score does.
//   usage.js      touchdown dependence. Nine points a game that are all
//                 touchdowns is variance waiting to end, and it is exactly
//                 what the whole league is bidding on.
//   startsit.js   this week's matchup, Vegas line, weather and injury. For a
//                 streamer that IS the recommendation.
//   outlook.js    rest-of-season and playoff-week schedule strength.
//   sleeper       how many managers across the whole site added him in the
//                 last 24 hours -- competition, and a sanity check.
//   faab.js       what this league actually pays, measured from its own bids.
//
// The other half of being useful is saying what KIND of add each one is.
// "Must add", "stash for the breakout", "stream him this week", "he will be
// great in the playoffs" and "everyone is bidding on him and they are wrong"
// are five different decisions, and flattening them into one ranked list makes
// the list useless: the speculative stash and the week-winning streamer sit
// next to each other with no way to tell them apart.

import { marginalValue, optimizeLineup } from './lineup.js';
import {
    usageTrend, touchdownDependence, nonTdPointsPerGame, playerUsageSeries, indexWeeklyStats,
} from './usage.js';
import { outlookFor } from './outlook.js';
import { sortBy, round } from './util.js';

/** Roles a pickup can play, in the order they are worth reading. */
export const ROLES = ['must-add', 'starter', 'streamer', 'stash', 'playoff', 'depth'];

export const ROLE_LABEL = {
    'must-add': 'Must add',
    starter: 'Starts for you',
    streamer: 'Stream this week',
    stash: 'Stash for the breakout',
    playoff: 'Playoff schedule',
    depth: 'Depth',
};

export const ROLE_BLURB = {
    'must-add': 'Improves your lineup now and the role is still growing.',
    starter: 'Walks into your starting lineup this week.',
    streamer: 'A one-week play on the matchup, not a long-term hold.',
    stash: 'Not a starter yet. The usage says he is about to be.',
    playoff: 'Worth a roster spot for weeks 15-17 specifically.',
    depth: 'Bench insurance — useful if somebody above him gets hurt.',
};

/** Lineup points per week below which an add is not a starter in any real sense. */
const STARTER_GAIN = 1.0;
/** ...and below which he is not even a near-miss. */
const DEPTH_GAIN = 0.1;

/**
 * Score and classify every available player.
 *
 * @param {object} input
 * @param {Array}  input.freeAgents     [{player, posRank, value, score}]
 * @param {Array}  input.entries        the user's valued roster entries
 * @param {object} input.cfg            normalized league
 * @param {object} [input.weeklyStats]  week -> rows, for usage trends
 * @param {Map}    [input.trending]     playerId -> adds across Sleeper, 24h
 * @param {Map}    [input.weekEval]     playerId -> evaluatePlayerWeek result
 * @param {Map}    [input.restOfSeason] team -> schedule strength
 * @param {Map}    [input.playoffs]     team -> playoff-week schedule strength
 * @param {object} [input.faab]         faabModel(), for a bid estimate
 * @param {number} [input.week]
 * @param {number} [input.limit]
 */
export function buildWaiverBoard({
    freeAgents = [],
    entries = [],
    cfg,
    weeklyStats = null,
    trending = null,
    weekEval = null,
    restOfSeason = null,
    playoffs = null,
    faab = null,
    week = 1,
    limit = 24,
}) {
    if (!cfg) return emptyBoard();

    const usageCache = new Map();
    // Indexed ONCE. `playerUsageSeries` rebuilds the whole season's index when
    // it is not given one, which across a few hundred free agents is a few
    // hundred passes over every weekly stat row in the season.
    const statIndex = weeklyStats ? indexWeeklyStats(weeklyStats) : null;
    const rows = [];

    for (const fa of freeAgents) {
        const player = fa.player;
        if (!player) continue;

        const lineupGain = marginalValue(entries, cfg.starterSlots, fa);
        const usage = usageFor(player, weeklyStats, cfg.scoring, usageCache, statIndex);
        const ev = weekEval?.get(player.id) || null;
        const demand = trending?.get(player.id) ?? 0;

        const schedule = outlookFor(restOfSeason, player.team);
        const playoffSchedule = outlookFor(playoffs, player.team);

        const row = {
            player,
            posRank: fa.posRank ?? null,
            value: fa.value ?? 0,
            ppg: fa.score ?? null,
            lineupGain,
            usage,
            evaluation: ev,
            demand,
            schedule,
            playoffSchedule,
            bid: faab ? estimateFrom(faab, fa) : null,
        };

        row.role = classify(row, { week });
        row.reasons = reasonsFor(row, { cfg, week });
        row.score = rankScore(row);
        row.caution = cautionFor(row);
        rows.push(row);
    }

    const ranked = sortBy(rows, (r) => r.score, -1);

    // A player the whole site is adding whose own usage says he is a mirage.
    // Printed separately and deliberately, because the single most valuable
    // thing a waiver tool can tell somebody is which of this week's popular
    // names not to spend on.
    const fades = sortBy(
        rows.filter((r) => r.caution && r.demand >= 1000),
        (r) => r.demand,
        -1
    ).slice(0, 5);

    const fadeIds = new Set(fades.map((r) => r.player.id));
    const targets = ranked.filter((r) => !fadeIds.has(r.player.id)).slice(0, limit);

    return {
        targets,
        fades,
        drops: dropCandidates(entries, cfg),
        byRole: groupByRole(targets),
    };
}

const emptyBoard = () => ({ targets: [], fades: [], drops: [], byRole: new Map() });

function groupByRole(targets) {
    const map = new Map();
    for (const role of ROLES) {
        const list = targets.filter((t) => t.role === role);
        if (list.length) map.set(role, list);
    }
    return map;
}

/** Usage trend and touchdown dependence for one player, memoised per scan. */
function usageFor(player, weeklyStats, scoring, cache, statIndex) {
    if (!weeklyStats || !scoring) return null;
    if (cache.has(player.id)) return cache.get(player.id);

    const series = playerUsageSeries(weeklyStats, player.id, scoring, statIndex);
    // Four games minimum against a two-game window, so BOTH halves of the
    // comparison average at least two games.
    //
    // Three was tempting and wrong: it left one game as the "earlier" half, so
    // a player who was inactive in week 2 and started in weeks 3 and 4 showed
    // a snap share climbing from 17% to 86% on the strength of a single
    // baseline observation. Sometimes that is a genuine role change and
    // sometimes it is one healthy scratch, and this cannot tell the
    // difference -- so it should not present it as a trend.
    if (series.length < 4) {
        cache.set(player.id, null);
        return null;
    }
    const trend = usageTrend(series, { window: 2, minGames: 4 });
    const dependence = touchdownDependence(series, scoring);
    const out = {
        games: series.length,
        trend,
        dependence,
        nonTdPpg: nonTdPointsPerGame(series, scoring),
        // The one number that matters most for a pickup: is his ROLE growing?
        // Snap share first because it leads the others.
        rising:
            (trend?.snapShare?.change ?? 0) > 0.05 ||
            (trend?.targets?.change ?? 0) > 1 ||
            (trend?.touches?.change ?? 0) > 1.5,
    };
    cache.set(player.id, out);
    return out;
}

/** What kind of add is this? */
function classify(row, { week }) {
    const { lineupGain, usage, evaluation, playoffSchedule } = row;
    const rising = !!usage?.rising;

    if (lineupGain >= STARTER_GAIN && rising) return 'must-add';
    if (lineupGain >= STARTER_GAIN) {
        // A starter whose edge is entirely this week's matchup is a streamer,
        // however good the number looks. Calling that a season-long starter is
        // how managers end up holding a kicker-grade defence in week 12.
        const matchupDriven = (evaluation?.multiplier ?? 1) > 1.08 && (row.ppg ?? 0) < 9;
        return matchupDriven ? 'streamer' : 'starter';
    }
    if (rising) return 'stash';
    // Playoff schedules only start mattering once they are close enough to
    // plan for. In week 3 a roster spot held for week 16 is a wasted one.
    if (week >= 8 && topQuartile(playoffSchedule)) return 'playoff';
    if ((evaluation?.multiplier ?? 1) > 1.1 && evaluation?.hasGame) return 'streamer';
    if (lineupGain >= DEPTH_GAIN) return 'depth';
    return 'depth';
}

/**
 * One composite number for ordering.
 *
 * Lineup gain dominates, because a player who does not play for you is worth
 * nothing however exciting his snap share is. Everything else breaks ties, and
 * the rising-role bonus is what lets a stash outrank a slightly better body
 * who has peaked.
 */
function rankScore(row) {
    let score = Math.max(0, row.lineupGain) * 10;

    // The usage bonus is CAPPED, and the cap is the whole point.
    //
    // Uncapped, a big snap-share swing was worth two points a week of lineup
    // gain, which let a player with a hot role outrank one who was measurably
    // better for the lineup right now -- and made the claim that lineup gain
    // dominates simply untrue. Ten points is one point a week of equivalent
    // lineup value: enough to reorder players who are close, never enough to
    // jump a materially better starter.
    let usageBonus = 0;
    if (row.usage?.rising) usageBonus += 6;
    usageBonus += Math.max(0, row.usage?.trend?.snapShare?.change ?? 0) * 20;
    usageBonus += Math.max(0, row.usage?.trend?.targets?.change ?? 0) * 1.2;
    score += Math.min(10, usageBonus);

    // This week's environment, but only as a tiebreaker: a soft matchup is
    // worth less than a real role.
    score += ((row.evaluation?.multiplier ?? 1) - 1) * 12;

    // Rest-of-season schedule, scaled small for the same reason. The strength
    // row reports a multiplier around 1, not a 0-1 score.
    if (row.schedule?.multiplier !== undefined) score += (row.schedule.multiplier - 1) * 20;

    // Demand is a weak positive: a thousand managers can be wrong, but a
    // player nobody is adding is usually available for a reason. Logarithmic
    // so a viral add does not outrank a genuine starter.
    if (row.demand > 0) score += Math.min(4, Math.log10(row.demand));

    // Touchdown-propped production is marked down, not excluded.
    if (row.caution) score -= 5;

    // A player who cannot play this week is not this week's pickup.
    if (row.evaluation && !row.evaluation.hasGame) score -= 8;

    return score;
}

/**
 * Is this production real?
 *
 * Touchdowns are the loudest and least repeatable part of a stat line, so a
 * player whose points are mostly touchdowns and whose volume is thin is the
 * classic waiver trap -- and he is usually the most-added player of the week,
 * because the box score looks wonderful.
 */
function cautionFor(row) {
    const d = row.usage?.dependence;
    if (!d || d.games < 3) return null;
    const share = d.share ?? 0;
    const volume = row.usage?.nonTdPpg ?? 0;

    if (share >= 0.6 && volume < 6) {
        return {
            kind: 'td-dependent',
            text:
                `${Math.round(share * 100)}% of his points are touchdowns and he is only scoring ` +
                `${round(volume, 1)} a game without them. That is the part that does not repeat.`,
        };
    }
    if (row.usage?.trend?.snapShare?.change !== undefined && row.usage.trend.snapShare.change < -0.08) {
        return {
            kind: 'role-shrinking',
            text:
                `His snap share has fallen from ${pct(row.usage.trend.snapShare.earlier)} to ` +
                `${pct(row.usage.trend.snapShare.recent)}. The box score has not caught up yet.`,
        };
    }
    return null;
}

/**
 * Why this player, in sentences a manager can check against what they already
 * believe. Ordered strongest first, and capped -- six reasons is not six times
 * as convincing as two, it just buries the one that mattered.
 */
function reasonsFor(row, { cfg, week }) {
    const out = [];
    const t = row.usage?.trend;

    if (row.lineupGain >= STARTER_GAIN) {
        out.push({
            kind: 'lineup',
            tone: 'good',
            text: `Adds ${round(row.lineupGain, 1)} points a week to your starting lineup right now.`,
        });
    } else if (row.lineupGain >= DEPTH_GAIN) {
        out.push({
            kind: 'lineup',
            tone: 'neutral',
            text: `Worth ${round(row.lineupGain, 1)} a week to your lineup as it stands — a bench add, not a starter.`,
        });
    } else {
        out.push({
            kind: 'lineup',
            tone: 'neutral',
            text: 'Does not crack your starting lineup today, so this is a bet on what he becomes.',
        });
    }

    if (t?.snapShare && t.snapShare.change > 0.05) {
        out.push({
            kind: 'usage',
            tone: 'good',
            text: `Snap share up from ${pct(t.snapShare.earlier)} to ${pct(t.snapShare.recent)} over his last two games.`,
        });
    }
    if (t?.targets && t.targets.change > 1) {
        out.push({
            kind: 'usage',
            tone: 'good',
            text: `Targets up from ${round(t.targets.earlier, 1)} to ${round(t.targets.recent, 1)} a game.`,
        });
    }
    if (t?.touches && t.touches.change > 1.5) {
        out.push({
            kind: 'usage',
            tone: 'good',
            text: `Touches up from ${round(t.touches.earlier, 1)} to ${round(t.touches.recent, 1)} a game.`,
        });
    }
    if (t?.redZone && t.redZone.change > 0.5) {
        out.push({
            kind: 'usage',
            tone: 'good',
            text: `Seeing more red-zone work (${round(t.redZone.earlier, 1)} → ${round(t.redZone.recent, 1)} a game).`,
        });
    }

    // Volume-only production, which is the honest floor under a hot streak.
    if (row.usage?.nonTdPpg !== null && row.usage?.nonTdPpg !== undefined && row.usage.nonTdPpg >= 7) {
        out.push({
            kind: 'floor',
            tone: 'good',
            text: `Scoring ${round(row.usage.nonTdPpg, 1)} a game before any touchdowns, so the floor is real.`,
        });
    }

    const ev = row.evaluation;
    if (ev?.hasGame && ev.opponent) {
        const mult = ev.multiplier ?? 1;
        if (mult > 1.06) {
            const top = (ev.factors || [])[0];
            out.push({
                kind: 'matchup',
                tone: 'good',
                text: `Good spot this week against ${ev.opponent}${top ? ` — ${top.detail}` : '.'}`,
            });
        } else if (mult < 0.94) {
            out.push({
                kind: 'matchup',
                tone: 'bad',
                text: `Tough week against ${ev.opponent}, so he may not help immediately.`,
            });
        }
    } else if (ev && !ev.hasGame) {
        out.push({
            kind: 'matchup',
            tone: 'bad',
            text: ev.onBye ? 'On bye this week.' : 'No game this week.',
        });
    }

    if (week >= 8 && topQuartile(row.playoffSchedule)) {
        out.push({
            kind: 'playoff',
            tone: 'good',
            text: 'One of the better playoff-week schedules available, which is worth a roster spot by now.',
        });
    }

    if (row.demand >= 5000) {
        out.push({
            kind: 'demand',
            tone: 'warn',
            text: `${row.demand.toLocaleString('en-US')} managers added him across Sleeper in the last day — expect to be outbid.`,
        });
    } else if (row.demand > 0 && row.demand < 300) {
        out.push({
            kind: 'demand',
            tone: 'good',
            text: 'Barely being added anywhere, so he should be cheap.',
        });
    }

    if (row.player.injury) {
        out.push({
            kind: 'health',
            tone: 'bad',
            text: `Listed ${row.player.injury}${row.player.injuryBody ? ` (${row.player.injuryBody})` : ''}.`,
        });
    }

    void cfg;
    return out.slice(0, 5);
}

/**
 * Who to drop, which is the half of the recommendation that was always
 * missing. "Add him" is not an action; "add him for this guy" is.
 *
 * Measured as the lineup cost of losing each player, so the cheapest to lose
 * is the honest answer rather than whoever has the lowest season-long value --
 * those are different players, and the difference is the whole point of
 * dropping anybody.
 */
export function dropCandidates(entries, cfg, limit = 5) {
    if (!entries?.length || !cfg) return [];
    const base = optimizeLineup(entries, cfg.starterSlots).points;

    const rows = entries.map((e) => {
        const without = optimizeLineup(
            entries.filter((x) => x.player.id !== e.player.id),
            cfg.starterSlots
        ).points;
        return { entry: e, player: e.player, cost: base - without, value: e.value ?? 0 };
    });

    // Cheapest to lose first. Ties broken by season-long value, so between two
    // players who are equally irrelevant this week, the one with no future
    // goes first.
    return sortBy(rows, (r) => r.cost * 1000 + r.value).slice(0, limit);
}

/** A bid, in the currency this league actually bids in. */
function estimateFrom(faab, fa) {
    if (!faab?.usable || !(fa.value > 0) || !(faab.rate > 0)) return null;
    const dollars = Math.max(1, Math.round(fa.value / faab.rate));
    const cap = faab.max ?? dollars;
    return { dollars: Math.min(dollars, Math.max(cap, 1)), capped: dollars > cap, cap };
}

/**
 * A schedule worth planning around: top quarter of the league.
 *
 * `scheduleStrength` reports a rank out of however many teams had games, plus
 * a multiplier near 1 -- not a 0-1 score. Reading it as a score made every
 * team qualify, because a multiplier is always well above 0.6.
 */
function topQuartile(row) {
    if (!row || !row.rank || !row.of) return false;
    return row.rank <= Math.max(1, Math.round(row.of / 4));
}

const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
