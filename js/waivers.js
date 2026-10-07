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
export const ROLES = [
    'must-add', 'starter', 'opportunity', 'rising', 'stash', 'playoff', 'stream', 'depth',
];

export const ROLE_LABEL = {
    'must-add': 'Must add',
    starter: 'Starts for you now',
    opportunity: 'Opportunity just opened',
    rising: 'Rising in value',
    stash: 'Stash for the breakout',
    playoff: 'Playoff schedule',
    stream: 'Good weekly option',
    depth: 'Depth',
};

export const ROLE_BLURB = {
    'must-add': 'Improves your lineup now, and the role is still growing. Spend here.',
    starter: 'Walks straight into your starting lineup this week.',
    opportunity: 'Somebody ahead of him is hurt, so the touches are there to be taken.',
    rising: 'Producing more than he was, with the usage to back it up.',
    stash: 'Not a starter yet. The usage says he is about to be.',
    playoff: 'Worth a roster spot for the fantasy playoff weeks specifically.',
    stream: 'A one-week play on the matchup, not a long-term hold.',
    depth: 'Bench insurance — useful if somebody above him gets hurt.',
};

/**
 * Which question a pickup answers.
 *
 * These are genuinely different decisions and they compete for different
 * things. A season-long add is worth a permanent roster spot and real FAAB; a
 * weekly stream is worth a dollar and the spot you will use again next week on
 * somebody else. Ranking them together buries one in the other -- the streamed
 * defense with a great matchup outranks the running back who will start for you
 * in week 12, or the other way round, and either way the list is wrong for one
 * of the two questions.
 */
export const HORIZONS = ['season', 'week'];
const WEEKLY_ROLES = new Set(['stream']);
/** Kickers and defenses are streamed by definition: nobody holds a third one. */
const STREAM_POSITIONS = new Set(['K', 'DEF']);

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
 * @param {object} [input.players]      the whole player database, for spotting
 *   an injured teammate ahead of a free agent on the depth chart
 * @param {number} [input.budget]       the user's remaining FAAB
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
    players = null,
    budget = null,
    week = 1,
    limit = 24,
}) {
    if (!cfg) return emptyBoard();

    // Who is hurt, by team and position. Built once: for each free agent this
    // answers "is somebody ahead of him on his own depth chart injured", which
    // is the single most reliable source of a genuinely new opportunity and the
    // thing experienced managers actually scan the wire for.
    const injuredAhead = buildInjuryMap(players);

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
            streamer: !!fa.streamer || STREAM_POSITIONS.has(player.pos),
            opportunity: opportunityFor(player, injuredAhead, fa.posRank),
        };

        row.role = classify(row, { week });
        row.horizon = horizonOf(row);
        row.reasons = reasonsFor(row, { cfg, week });
        row.score = rankScore(row);
        row.caution = cautionFor(row);
        row.bid = suggestBid(row, faab, budget);
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
    const live = ranked.filter((r) => !fadeIds.has(r.player.id));

    // Two lists, ranked separately.
    //
    // Mixing them buries one in the other: a streamed defence with a dream
    // matchup outscores the running back who will start for you in week 12, or
    // the other way round, and either way the single list is wrong for one of
    // the two questions being asked.
    const season = live.filter((r) => r.horizon === 'season').slice(0, limit);
    const weekly = sortBy(
        live.filter((r) => r.horizon === 'week'),
        (r) => weeklyScore(r),
        -1
    ).slice(0, Math.max(8, Math.round(limit / 2)));

    return {
        // `targets` is the season-long list. Kept under its original name
        // because the FAAB panel and its tests consume it.
        targets: season,
        season,
        weekly,
        fades,
        drops: dropCandidates(entries, cfg),
        byRole: groupByRole(season),
        byWeeklyPosition: groupByPosition(weekly),
    };
}

const emptyBoard = () => ({
    targets: [], season: [], weekly: [], fades: [], drops: [],
    byRole: new Map(), byWeeklyPosition: new Map(),
});

function groupByRole(targets) {
    const map = new Map();
    for (const role of ROLES) {
        const list = targets.filter((t) => t.role === role);
        if (list.length) map.set(role, list);
    }
    return map;
}

/**
 * Weekly targets grouped by position, because a stream is a per-slot decision:
 * nobody wants eight defences when the question is "who do I start at kicker".
 */
function groupByPosition(weekly) {
    const map = new Map();
    for (const pos of ['DEF', 'K', 'QB', 'RB', 'WR', 'TE']) {
        const list = weekly.filter((r) => r.player.pos === pos);
        if (list.length) map.set(pos, list);
    }
    return map;
}

/**
 * Which question does this pickup answer?
 *
 * A kicker or a defence is a weekly decision by definition -- nobody holds a
 * third one -- and so is anybody whose entire case is this week's matchup.
 * Everything else competes for a permanent roster spot.
 */
function horizonOf(row) {
    if (STREAM_POSITIONS.has(row.player.pos)) return 'week';
    if (WEEKLY_ROLES.has(row.role)) return 'week';
    return 'season';
}

/**
 * Ordering for the weekly list, which is a different question from the
 * season-long one: not "who will be good" but "who scores most THIS Sunday".
 * So it leans on the week's environment and ignores the role trends that
 * decide the season-long board.
 */
function weeklyScore(row) {
    const ev = row.evaluation;
    if (ev && !ev.hasGame) return -100;
    // The adjusted weekly projection is the honest answer where we have one.
    if (Number.isFinite(ev?.adjusted)) return ev.adjusted;
    // Otherwise fall back to the environment multiplier over season-long ppg.
    return (row.ppg ?? 0) * (ev?.multiplier ?? 1);
}

/**
 * Who is hurt, keyed by team and position.
 *
 * The map holds the injured players at each team/position so a free agent can
 * be checked against his own depth chart. Only designations that actually cost
 * somebody playing time count: "Questionable" is a coin flip the player
 * usually wins, and treating it as an opening would mark half the league as an
 * opportunity every week.
 */
const COSTS_PLAYING_TIME = new Set(['Out', 'IR', 'Doubtful', 'PUP', 'Sus', 'NA']);

function buildInjuryMap(players) {
    const map = new Map();
    if (!players) return map;
    for (const p of Object.values(players)) {
        if (!p?.injury || !p.team || !p.pos) continue;
        if (!COSTS_PLAYING_TIME.has(p.injury)) continue;
        const key = `${p.team}:${p.pos}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(p);
    }
    return map;
}

/**
 * Is there an opening in front of this player?
 *
 * The test is an injured teammate at the same position who was AHEAD of him,
 * because a hurt player behind him on the depth chart changes nothing. Rank is
 * the proxy for depth order -- there is no public depth chart in any of these
 * feeds -- which is imperfect but right far more often than it is wrong: the
 * better-ranked back is the one taking the carries.
 */
function opportunityFor(player, injuredAhead, posRank) {
    if (!player?.team || !player.pos) return null;
    const hurt = injuredAhead.get(`${player.team}:${player.pos}`);
    if (!hurt?.length) return null;

    const mine = posRank ?? 9999;
    const ahead = hurt.filter((h) => h.id !== player.id && (h.searchRank ?? 9999) < (player.searchRank ?? 9999));
    if (!ahead.length) return null;

    return {
        players: ahead,
        // Named, because "somebody is hurt" is not actionable and "Isiah Pacheco
        // is out" is.
        text:
            `${ahead.map((h) => h.name).join(' and ')} ${ahead.length === 1 ? 'is' : 'are'} ` +
            `${ahead[0].injury === 'IR' ? 'on IR' : ahead[0].injury.toLowerCase()}, which opens up work here.`,
        mine,
    };
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

    // A kicker or a defence is a stream, whatever the numbers say. Nobody
    // holds a second one, so classifying them as season-long starters would
    // put them in competition for a roster spot they will never keep.
    if (STREAM_POSITIONS.has(row.player.pos)) return 'stream';

    // An opening in front of him outranks everything except already starting
    // for you, because it is the one signal that is about to change the usage
    // rather than describing usage that has already happened. This is what
    // gets you the week ahead of the rest of the league.
    if (row.opportunity && lineupGain < STARTER_GAIN) return 'opportunity';

    if (lineupGain >= STARTER_GAIN && rising) return 'must-add';
    if (lineupGain >= STARTER_GAIN) {
        // A starter whose edge is entirely this week's matchup is a stream,
        // however good the number looks. Calling that a season-long starter is
        // how managers end up holding a kicker-grade defence in week 12.
        const matchupDriven = (evaluation?.multiplier ?? 1) > 1.08 && (row.ppg ?? 0) < 9;
        return matchupDriven ? 'stream' : 'starter';
    }

    // Producing more AND seeing more work is a different thing from a role
    // growing ahead of the box score, and it deserves its own name: this is
    // the player whose value is climbing in front of everybody.
    if (rising && (usage?.trend?.points?.change ?? 0) > 1) return 'rising';
    if (rising) return 'stash';

    // Playoff schedules only start mattering once they are close enough to
    // plan for. In week 3 a roster spot held for week 16 is a wasted one.
    if (week >= 8 && topQuartile(playoffSchedule)) return 'playoff';
    if ((evaluation?.multiplier ?? 1) > 1.1 && evaluation?.hasGame) return 'stream';
    if (lineupGain >= DEPTH_GAIN) return 'depth';
    return 'depth';
}

/**
 * What to bid, and why that number.
 *
 * "$12" on its own is not advice -- it is a number with no scale attached.
 * What makes it actionable is what it is a share OF: this league's own going
 * rate, what anybody here has ever actually paid, and what you have left.
 *
 * A weekly stream is priced separately and deliberately cheaply. The going
 * rate is fitted against season-long value, and a defence you will drop on
 * Tuesday has almost none -- so the fit says $1 and the fit is right. Paying
 * real money for a one-week rental is the most common way a FAAB budget gets
 * wasted, so this says so rather than quietly quoting a season-long price.
 */
export function suggestBid(row, faab, budget = null) {
    const streaming = row.horizon === 'week';

    if (streaming) {
        const note =
            'A one-week rental. Bid the minimum — the roster spot comes back next Tuesday and so does the ' +
            'decision, so anything more than a token is money spent twice.';
        return { dollars: 1, minimum: true, capped: false, cap: null, note, ofBudget: null };
    }

    if (!faab?.usable || !(faab.rate > 0) || !(row.value > 0)) {
        return null;
    }

    const raw = Math.max(1, Math.round(row.value / faab.rate));
    // Never quote above what this league has actually paid: the rate is a line
    // through a handful of points, and extrapolating past the observed range
    // invents prices nobody here has ever seen.
    const cap = faab.max ?? raw;
    const dollars = Math.min(raw, Math.max(cap, 1));
    const ofBudget = budget > 0 ? dollars / budget : null;

    const bits = [];
    if (faab.median) bits.push(`this league's median winning bid is $${faab.median}`);
    if (raw > cap) bits.push(`nobody here has paid more than $${cap}`);
    if (ofBudget !== null) bits.push(`${Math.round(ofBudget * 100)}% of your remaining budget`);

    return {
        dollars,
        minimum: dollars <= 1,
        capped: raw > cap,
        cap,
        ofBudget,
        note: bits.length ? `${capitalize(bits[0])}${bits.length > 1 ? `; ${bits.slice(1).join('; ')}` : ''}.` : null,
    };
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

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

    // A stream is judged on this week and nothing else, so leading with its
    // season-long lineup contribution would be answering another question.
    if (row.horizon === 'week') {
        const ev = row.evaluation;
        if (Number.isFinite(ev?.adjusted)) {
            out.push({
                kind: 'week',
                tone: 'good',
                text: `Projects ${round(ev.adjusted, 1)} points this week${ev.opponent ? ` against ${ev.opponent}` : ''}.`,
            });
        }
        const top = (ev?.factors || [])[0];
        if (top?.detail) out.push({ kind: 'matchup', tone: 'good', text: top.detail });
        if (ev && !ev.hasGame) {
            out.push({ kind: 'matchup', tone: 'bad', text: ev.onBye ? 'On bye this week.' : 'No game this week.' });
        }
        if (row.player.injury) {
            out.push({ kind: 'health', tone: 'bad', text: `Listed ${row.player.injury}.` });
        }
        return out.slice(0, 4);
    }

    // An opening ahead of him leads, because it is the only reason here that
    // is about to change the usage rather than describing usage already
    // banked -- and it is why this player is worth having before the rest of
    // the league works it out. Everything else is context for it.
    if (row.opportunity) {
        out.push({ kind: 'opportunity', tone: 'good', text: row.opportunity.text });
    }

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
