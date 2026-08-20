// The trade engine.
//
// Most trade calculators answer one question -- "which pile of players is worth
// more?" -- and that question is close to useless on its own, because value is
// zero sum. If I send you 100 and you send me 90, the ledger says I won, and
// the ledger is often wrong: the 90 might start for me every week while the 100
// rode my bench behind better players.
//
// So this engine answers three separate questions and reports them separately:
//
//   1. VALUE   -- the ledger. Strictly zero sum between the two sides.
//   2. FIT     -- what each side's optimal starting lineup actually gains.
//                 NOT zero sum: a good trade improves both lineups, which is
//                 the entire reason trades happen.
//   3. IMPACT  -- how each side's playoff and title odds move once the new
//                 lineups are run through the rest of the real schedule.
//
// Impact is the headline. Value is the sanity check. Fit explains the gap
// between them.

import { optimizeLineup, positionalReport, teamScoringProfile } from './lineup.js';
import { valuePlayer } from './valuation.js';
import { simulateSeason } from './sim.js';
import { clamp, round, sortBy, sum } from './util.js';

const SIM_SEED = 4815162342;

/** Value + projection for one player, given the user's rankings. */
export function evaluateRosterEntry(player, rankings, ctx) {
    const posRank = rankings.get(player.id) ?? 999;
    const v = valuePlayer(player, posRank, ctx);
    return { player, posRank, score: v.effectivePpg, value: v.value, detail: v };
}

export function buildEntries(players, rankings, ctx) {
    return players.map((p) => evaluateRosterEntry(p, rankings, ctx));
}

/**
 * Evaluate a trade.
 *
 * @param {object} input
 * @param {object} input.cfg        normalized league config
 * @param {object} input.ctx        valuation context
 * @param {Array}  input.teams      [{rosterId, name, owner, players, wins, losses, ties, pointsFor}]
 * @param {Array}  input.offers     [{rosterId, sending:[playerId], receiving?:[playerId]}]
 * @param {Map}    input.rankings   playerId -> positional rank
 * @param {Array}  [input.schedule] remaining schedule; omit to skip odds simulation
 */
export function evaluateTrade(input) {
    const { cfg, ctx, teams, offers, rankings, schedule = null, iterations = 2000 } = input;

    const byRoster = new Map(teams.map((t) => [t.rosterId, t]));
    const playerIndex = new Map();
    for (const t of teams) for (const p of t.players) playerIndex.set(p.id, { player: p, rosterId: t.rosterId });

    const resolved = resolveOffers(offers);
    if (resolved.error) return { ok: false, error: resolved.error };
    const sides = resolved.sides;

    // --- Build "before" and "after" rosters for every team in the deal -------
    const analysis = [];
    for (const side of sides) {
        const team = byRoster.get(side.rosterId);
        if (!team) return { ok: false, error: `Unknown team in offer: ${side.rosterId}` };

        const sendingSet = new Set(side.sending);
        const before = buildEntries(team.players, rankings, ctx);
        const kept = team.players.filter((p) => !sendingSet.has(p.id));
        const incoming = side.receiving
            .map((id) => playerIndex.get(id)?.player)
            .filter(Boolean);
        const after = buildEntries([...kept, ...incoming], rankings, ctx);

        const outEntries = before.filter((e) => sendingSet.has(e.player.id));
        const inEntries = buildEntries(incoming, rankings, ctx);

        analysis.push({ side, team, before, after, outEntries, inEntries });
    }

    // --- 1. VALUE: the zero-sum ledger --------------------------------------
    for (const a of analysis) {
        a.valueOut = sum(a.outEntries, (e) => e.value);
        a.valueIn = sum(a.inEntries, (e) => e.value);
        a.valueNet = a.valueIn - a.valueOut;
    }

    // --- 2. FIT: optimal-lineup change, plus roster shape -------------------
    const slots = cfg.starterSlots;
    for (const a of analysis) {
        const lineupBefore = optimizeLineup(a.before, slots);
        const lineupAfter = optimizeLineup(a.after, slots);
        a.lineupBefore = lineupBefore;
        a.lineupAfter = lineupAfter;
        a.lineupNet = lineupAfter.points - lineupBefore.points;
        a.rosLineupPoints = a.lineupNet * ctx.weeksLeft;

        a.reportBefore = positionalReport(a.before, slots);
        a.reportAfter = positionalReport(a.after, slots);

        // Roster crunch: a team taking back more bodies than it sends may have
        // to cut someone. Charge the deal for the player they would lose.
        a.rosterBefore = a.before.length;
        a.rosterAfter = a.after.length;
        a.overflow = Math.max(0, a.rosterAfter - cfg.rosterSize);
        if (a.overflow > 0) {
            const worst = sortBy(a.after, (e) => e.value).slice(0, a.overflow);
            a.crunchCost = sum(worst, (e) => Math.max(0, e.value));
            a.crunchCuts = worst;
        } else {
            a.crunchCost = 0;
            a.crunchCuts = [];
        }

        a.positionSwing = positionSwing(a.reportBefore, a.reportAfter);
    }

    // --- 3. IMPACT: playoff and title odds, before vs after -----------------
    let odds = null;
    if (schedule && schedule.length && teams.length > 2) {
        odds = simulateImpact({ cfg, ctx, teams, analysis, rankings, schedule, iterations });
        for (const a of analysis) {
            const o = odds.get(a.side.rosterId);
            a.playoffBefore = o.before.playoffOdds;
            a.playoffAfter = o.after.playoffOdds;
            a.playoffDelta = o.after.playoffOdds - o.before.playoffOdds;
            a.titleBefore = o.before.titleOdds;
            a.titleAfter = o.after.titleOdds;
            a.titleDelta = o.after.titleOdds - o.before.titleOdds;
            a.winsBefore = o.before.projectedWins;
            a.winsAfter = o.after.projectedWins;
        }
    }

    // --- Verdict ------------------------------------------------------------
    const scored = analysis.map((a) => ({ ...a, grade: gradeSide(a, ctx, !!odds) }));
    const verdict = buildVerdict(scored, ctx, cfg, !!odds);

    return {
        ok: true,
        mode: odds ? 'full' : 'value',
        sides: scored,
        verdict,
        reasons: buildReasons(scored, cfg, ctx, !!odds, iterations),
        leagueOdds: odds,
        weeksLeft: ctx.weeksLeft,
    };
}

/** Two-team offers can infer what each side receives; larger deals must be explicit. */
function resolveOffers(offers) {
    if (!offers || offers.length < 2) return { error: 'A trade needs at least two teams.' };
    if (offers.some((o) => !o.sending || !o.sending.length)) {
        return { error: 'Every team in the trade has to send at least one player.' };
    }
    if (offers.length === 2) {
        return {
            sides: [
                { ...offers[0], receiving: offers[0].receiving ?? offers[1].sending },
                { ...offers[1], receiving: offers[1].receiving ?? offers[0].sending },
            ],
        };
    }
    if (offers.some((o) => !o.receiving)) {
        return { error: 'Trades with three or more teams must say who receives what.' };
    }
    return { sides: offers };
}

/**
 * Re-run the whole league with the traded rosters in place. Both simulations
 * share a seed so the two runs see identical weekly randomness -- the
 * difference between them is the trade, not sampling noise.
 */
function simulateImpact({ cfg, ctx, teams, analysis, rankings, schedule, iterations }) {
    const overrideBefore = new Map();
    const overrideAfter = new Map();
    for (const a of analysis) {
        overrideBefore.set(a.side.rosterId, a.lineupBefore.points);
        overrideAfter.set(a.side.rosterId, a.lineupAfter.points);
    }

    const mk = (overrides) =>
        teams.map((t) => {
            const points =
                overrides.get(t.rosterId) ??
                optimizeLineup(buildEntries(t.players, rankings, ctx), cfg.starterSlots).points;
            const profile = teamScoringProfile(points);
            return {
                rosterId: t.rosterId,
                wins: t.wins || 0,
                losses: t.losses || 0,
                ties: t.ties || 0,
                pointsFor: t.pointsFor || 0,
                mu: profile.mu,
                sigma: profile.sigma,
            };
        });

    const opts = {
        iterations,
        playoffTeams: cfg.playoffTeams,
        seed: SIM_SEED,
        medianScoring: cfg.medianScoring,
    };
    const before = simulateSeason(mk(overrideBefore), schedule, opts);
    const after = simulateSeason(mk(overrideAfter), schedule, opts);

    const out = new Map();
    const bIdx = new Map(before.map((r) => [r.rosterId, r]));
    const aIdx = new Map(after.map((r) => [r.rosterId, r]));
    for (const t of teams) out.set(t.rosterId, { before: bIdx.get(t.rosterId), after: aIdx.get(t.rosterId) });
    return out;
}

/** Which positions got stronger or weaker, in weekly starting points. */
function positionSwing(before, after) {
    const swing = {};
    for (const pos of Object.keys(before.byPosition)) {
        const b = before.byPosition[pos];
        const a = after.byPosition[pos];
        swing[pos] = {
            startingDelta: a.startingPoints - b.startingPoints,
            dropoffBefore: b.dropoff,
            dropoffAfter: a.dropoff,
            countDelta: a.count - b.count,
        };
    }
    return swing;
}

/**
 * A single 0-100 score per side. Weighted toward what the trade actually does
 * to the team's season rather than what the ledger says.
 */
function gradeSide(a, ctx, hasOdds) {
    const scale = Math.max(40, Math.abs(a.valueIn) + Math.abs(a.valueOut));
    const valueScore = clamp(a.valueNet / scale, -1, 1);
    const fitScore = clamp(a.rosLineupPoints / 45, -1, 1);
    const crunch = clamp(-a.crunchCost / scale, -1, 0);

    let score;
    if (hasOdds) {
        const oddsScore = clamp(a.playoffDelta * 4 + a.titleDelta * 8, -1, 1);
        score = 0.25 * valueScore + 0.3 * fitScore + 0.45 * oddsScore;
    } else {
        score = 0.55 * valueScore + 0.45 * fitScore;
    }
    score += 0.1 * crunch;

    // In a two-team trade the grades are near mirror images, so the scale has to
    // be calibrated around "even = B". A six-point edge on a 150-point deal is a
    // slightly better offer, not a fleecing, and the letter should say so.
    const rating = clamp(Math.round(50 + score * 38), 0, 100);
    return {
        score: clamp(score, -1, 1),
        rating,
        letter: letterGrade(rating),
        components: { valueScore, fitScore, crunch },
    };
}

function letterGrade(n) {
    if (n >= 80) return 'A+';
    if (n >= 70) return 'A';
    if (n >= 62) return 'B+';
    if (n >= 55) return 'B';
    if (n >= 48) return 'C+';
    if (n >= 42) return 'C';
    if (n >= 32) return 'D';
    return 'F';
}

function buildVerdict(sides, ctx, cfg, hasOdds) {
    const ranked = sortBy(sides, (s) => s.grade.score, -1);
    const winner = ranked[0];
    const loser = ranked[ranked.length - 1];
    const gap = winner.grade.score - loser.grade.score;

    const bothGainLineup = sides.every((s) => s.lineupNet > 0.4);
    const bothGainOdds = hasOdds && sides.every((s) => s.playoffDelta > 0.005 || s.titleDelta > 0.003);

    let label;
    let tone;
    let headline;

    if (gap < 0.08 && (bothGainLineup || bothGainOdds)) {
        label = 'Win-win';
        tone = 'good';
        headline = 'Both rosters come out ahead. This is the rare deal that makes sense on both sides.';
    } else if (gap < 0.08) {
        label = 'Even';
        tone = 'neutral';
        headline = 'Close to a coin flip. Neither side is being fleeced.';
    } else if (gap < 0.2) {
        label = `${winner.team.name} slightly ahead`;
        tone = 'neutral';
        headline = `${winner.team.name} gets the better end, but it is close enough to be defensible for both.`;
    } else if (gap < 0.42) {
        label = `${winner.team.name} wins`;
        tone = 'warn';
        headline = `${winner.team.name} comes out clearly ahead. ${loser.team.name} should be asking for more.`;
    } else {
        label = `Lopsided — ${winner.team.name}`;
        tone = 'bad';
        headline = `This is a blowout in ${winner.team.name}'s favor. Who says no? ${loser.team.name} does.`;
    }

    return {
        label,
        tone,
        headline,
        winner: winner.team.rosterId,
        loser: loser.team.rosterId,
        gap: round(gap, 3),
        bothGainLineup,
        bothGainOdds,
    };
}

/**
 * Plain-language reasoning. Every entry is derived from a number computed
 * above -- nothing here is decorative.
 */
function buildReasons(sides, cfg, ctx, hasOdds, iterations = 2000) {
    const reasons = [];
    const wk = ctx.weeksLeft;

    for (const s of sides) {
        const name = s.team.name;

        if (Math.abs(s.lineupNet) >= 0.4) {
            const dir = s.lineupNet > 0 ? 'gains' : 'loses';
            reasons.push({
                kind: s.lineupNet > 0 ? 'good' : 'bad',
                team: s.team.rosterId,
                title: `${name} ${dir} ${Math.abs(round(s.lineupNet, 1))} pts/week in the starting lineup`,
                detail: `Over the ${wk} week${wk === 1 ? '' : 's'} left that is ${Math.abs(round(s.rosLineupPoints, 0))} points ${s.lineupNet > 0 ? 'gained' : 'given up'}.`,
            });
        }

        // Value moved that never reaches the lineup is the classic trap.
        if (s.valueNet > 0 && s.lineupNet <= 0.2) {
            reasons.push({
                kind: 'warn',
                team: s.team.rosterId,
                title: `${name} "wins" the value but not the lineup`,
                detail: 'The incoming talent sits behind players already starting. Raw value that never cracks the lineup does not score points.',
            });
        }
        if (s.valueNet < 0 && s.lineupNet > 0.6) {
            reasons.push({
                kind: 'good',
                team: s.team.rosterId,
                title: `${name} gives up value but improves the lineup`,
                detail: 'Consolidating depth into a starter is exactly how a team should lose a value ledger on purpose.',
            });
        }

        for (const [pos, sw] of Object.entries(s.positionSwing)) {
            if (sw.startingDelta >= 1.5) {
                reasons.push({
                    kind: 'good',
                    team: s.team.rosterId,
                    title: `${name} upgrades at ${pos} (+${round(sw.startingDelta, 1)} pts/wk)`,
                    detail: `${pos} was a soft spot in the lineup and this deal addresses it directly.`,
                });
            } else if (sw.startingDelta <= -1.5) {
                reasons.push({
                    kind: 'bad',
                    team: s.team.rosterId,
                    title: `${name} opens a hole at ${pos} (${round(sw.startingDelta, 1)} pts/wk)`,
                    detail: `After the trade there is no comparable replacement to slot in at ${pos}.`,
                });
            }
            if (sw.dropoffAfter > sw.dropoffBefore + 3) {
                reasons.push({
                    kind: 'warn',
                    team: s.team.rosterId,
                    title: `${name} becomes fragile at ${pos}`,
                    detail: `Losing the top ${pos} would now cost ${round(sw.dropoffAfter, 1)} pts/wk, up from ${round(sw.dropoffBefore, 1)}. One injury and the lineup falls apart.`,
                });
            }
        }

        if (s.overflow > 0) {
            const names = s.crunchCuts.map((c) => c.player.name).join(', ');
            reasons.push({
                kind: s.crunchCost > 0 ? 'warn' : 'neutral',
                team: s.team.rosterId,
                title: `${name} has to cut ${s.overflow} player${s.overflow === 1 ? '' : 's'}`,
                detail:
                    s.crunchCost > 0
                        ? `The roster only holds ${cfg.rosterSize}. Dropping ${names} is a real cost of this deal.`
                        : `The roster only holds ${cfg.rosterSize}, but the players who go (${names}) are already below replacement level. The crunch is free.`,
            });
        }

        const injured = s.inEntries.filter((e) => e.player.injury);
        for (const e of injured) {
            reasons.push({
                kind: 'warn',
                team: s.team.rosterId,
                title: `${e.player.name} is ${e.player.injury}`,
                detail: `His value here is already discounted to ${Math.round(e.detail.availability * 100)}% for expected missed time. Confirm the timeline before accepting.`,
            });
        }

        if (hasOdds) {
            const pd = s.playoffDelta;
            const td = s.titleDelta;
            if (Math.abs(pd) >= 0.01 || Math.abs(td) >= 0.005) {
                reasons.push({
                    kind: pd + td > 0 ? 'good' : 'bad',
                    team: s.team.rosterId,
                    title: `${name}: playoff odds ${fmtDelta(pd)}, title odds ${fmtDelta(td)}`,
                    detail: `${round(s.playoffBefore * 100, 1)}% → ${round(s.playoffAfter * 100, 1)}% to make the playoffs across ${iterations.toLocaleString()} simulated seasons on the real remaining schedule.`,
                });
            } else {
                reasons.push({
                    kind: 'neutral',
                    team: s.team.rosterId,
                    title: `${name}'s season barely moves`,
                    detail: `Playoff odds stay near ${round(s.playoffBefore * 100, 0)}%. Whatever this trade is about, it is not this year's playoff race.`,
                });
            }

            if (s.playoffBefore > 0.85 && s.titleDelta > 0.005) {
                reasons.push({
                    kind: 'good',
                    team: s.team.rosterId,
                    title: `${name} is already a lock — this is about January`,
                    detail: 'The playoff spot was never in doubt. The right question is title odds, and those go up.',
                });
            }
            if (s.playoffBefore < 0.15 && ctx.dynasty === false && s.valueNet > 0) {
                reasons.push({
                    kind: 'warn',
                    team: s.team.rosterId,
                    title: `${name} is buying in a lost season`,
                    detail: `At ${round(s.playoffBefore * 100, 0)}% to make the playoffs, adding win-now value in a redraft league has almost no payoff.`,
                });
            }
        }
    }

    const order = { bad: 0, warn: 1, good: 2, neutral: 3 };
    return reasons.sort((a, b) => order[a.kind] - order[b.kind]);
}

const fmtDelta = (d) => `${d >= 0 ? '+' : ''}${round(d * 100, 1)}%`;

/**
 * Find the single add-on from `fromTeam` that best balances a lopsided offer.
 * Returns candidates ranked by how close they get the ledger to even without
 * flipping it the other way.
 */
export function suggestBalancers({ cfg, ctx, rankings, fromTeam, gap, exclude = [], limit = 4 }) {
    const excluded = new Set(exclude);
    const entries = buildEntries(
        // Kickers and defenses carry real replacement-level value but nobody
        // trades them, so proposing one as the sweetener is useless advice.
        fromTeam.players.filter((p) => !excluded.has(p.id) && p.pos !== 'K' && p.pos !== 'DEF'),
        rankings,
        ctx
    );

    return sortBy(
        entries
            .map((e) => ({ entry: e, residual: Math.abs(gap - e.value), overshoot: e.value > gap * 1.35 }))
            .filter((c) => c.entry.value > 0),
        (c) => c.residual
    )
        .slice(0, limit)
        .map((c) => ({
            player: c.entry.player,
            value: c.entry.value,
            posRank: c.entry.posRank,
            closes: round(clamp(c.entry.value / (gap || 1), 0, 2) * 100, 0),
            overshoot: c.overshoot,
        }));
}
