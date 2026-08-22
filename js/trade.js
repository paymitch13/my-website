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
import { DEFAULT_SIM_SEED } from './sim.js';
import { runSimulation } from './simclient.js';
import { clamp, round, sortBy, sum } from './util.js';

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
 * @returns {Promise<object>} async because the simulation runs in a worker
 */
export async function evaluateTrade(input) {
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
        odds = await simulateImpact({ cfg, ctx, teams, analysis, rankings, schedule, iterations });
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
async function simulateImpact({ cfg, ctx, teams, analysis, rankings, schedule, iterations }) {
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
        seed: DEFAULT_SIM_SEED,
        medianScoring: cfg.medianScoring,
    };
    // Both runs go to the worker together; they are independent.
    const [before, after] = await Promise.all([
        runSimulation(mk(overrideBefore), schedule, opts),
        runSimulation(mk(overrideAfter), schedule, opts),
    ]);

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
            const inNames = s.inEntries.map((e) => e.player.name).join(' and ');
            const outNames = s.outEntries.map((e) => e.player.name).join(' and ');
            reasons.push({
                kind: s.lineupNet > 0 ? 'good' : 'bad',
                team: s.team.rosterId,
                weight: 2 + Math.abs(s.lineupNet),
                title: `${name} ${dir} ${Math.abs(round(s.lineupNet, 1))} pts/week in the starting lineup`,
                detail: `Swapping ${outNames} for ${inNames} is worth ${Math.abs(round(s.rosLineupPoints, 0))} points across the ${wk} week${wk === 1 ? '' : 's'} left.`,
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
                const who = s.inEntries.filter((e) => e.player.pos === pos).map((e) => e.player.name).join(', ');
                reasons.push({
                    kind: 'good',
                    team: s.team.rosterId,
                    weight: 1 + sw.startingDelta / 2,
                    title: `${name} upgrades at ${pos} (+${round(sw.startingDelta, 1)} pts/wk)`,
                    detail: who
                        ? `${who} steps straight into the lineup at a position that was costing them points.`
                        : `${pos} was a soft spot and the deal addresses it directly.`,
                });
            } else if (sw.startingDelta <= -1.5) {
                const who = s.outEntries.filter((e) => e.player.pos === pos).map((e) => e.player.name).join(', ');
                reasons.push({
                    kind: 'bad',
                    team: s.team.rosterId,
                    weight: 1 + Math.abs(sw.startingDelta) / 2,
                    title: `${name} opens a hole at ${pos} (${round(sw.startingDelta, 1)} pts/wk)`,
                    detail: who
                        ? `Nobody on the roster replaces what ${who} was producing at ${pos}.`
                        : `There is no comparable replacement to slot in at ${pos}.`,
                });
            }
            // Only worth saying if the position still matters after the trade.
            if (sw.dropoffAfter > sw.dropoffBefore + 3 && sw.dropoffAfter > 6) {
                reasons.push({
                    kind: 'warn',
                    team: s.team.rosterId,
                    weight: 1.2,
                    title: `${name} becomes fragile at ${pos}`,
                    detail: `Losing their top ${pos} would now cost ${round(sw.dropoffAfter, 1)} pts/wk, up from ${round(sw.dropoffBefore, 1)}.`,
                });
            }
        }

        if (s.overflow > 0) {
            const names = s.crunchCuts.map((c) => c.player.name).join(', ');
            // Judge the cut against the size of the deal, not in the abstract:
            // losing a deep bench body out of a blockbuster is noise, the same
            // loss in a swap of spare parts is most of the trade.
            const dealSize = Math.max(1, Math.abs(s.valueIn) + Math.abs(s.valueOut));
            const material = s.crunchCost / dealSize > 0.08;
            reasons.push({
                kind: material ? 'warn' : 'neutral',
                team: s.team.rosterId,
                title: `${name} has to cut ${s.overflow} player${s.overflow === 1 ? '' : 's'}`,
                detail: material
                    ? `The roster only holds ${cfg.rosterSize}. Dropping ${names} costs real value and is part of the price of this deal.`
                    : `The roster only holds ${cfg.rosterSize}, so ${names} would go. They are deep bench pieces — a minor cost next to the rest of the trade.`,
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
                    weight: 3 + Math.abs(pd) * 10 + Math.abs(td) * 20,
                    title: `${name}: playoff odds ${fmtPctDelta(pd)}, title odds ${fmtPctDelta(td)}`,
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

    // Rank by how much each point actually matters, not by category, then cap
    // per team. Twelve variations on "you got worse at receiver" is noise, and
    // burying the one line that explains the verdict underneath them is worse.
    const weight = (r) => (r.weight ?? 1) * ({ bad: 3, warn: 2, good: 2.2, neutral: 0.6 }[r.kind] ?? 1);
    const ranked = sortBy(reasons, weight, -1);

    const perTeam = new Map();
    const seen = new Set();
    const out = [];
    for (const r of ranked) {
        // Two reasons that say the same thing about the same team are one reason.
        const key = `${r.team}:${r.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const count = perTeam.get(r.team) || 0;
        if (count >= 5) continue;
        perTeam.set(r.team, count + 1);
        out.push(r);
    }
    return out;
}

/** Signed percentage from a 0-1 ratio. Named for its unit to avoid the
 * collision with ui.fmtDelta, which formats a signed plain number. */
const fmtPctDelta = (d) => `${d >= 0 ? '+' : ''}${round(d * 100, 1)}%`;

/**
 * Suggest add-ons that would actually get a lopsided offer accepted.
 *
 * The first version of this ranked candidates purely by how close their value
 * was to the gap, which is why it produced nonsense: it happily proposed the
 * giving team's starting running back, or a fourth-string body nobody wants,
 * as long as the number lined up. Closing a value gap is a constraint, not a
 * goal.
 *
 * A suggestion is only useful if all three are true:
 *
 *   1. The giver can spare him -- he costs their optimal lineup little or
 *      nothing, because they have surplus at that position.
 *   2. The receiver actually wants him -- he improves their optimal lineup.
 *   3. He roughly closes the gap without wildly overshooting it.
 *
 * Ranking by (2) minus (1) with a penalty on (3) surfaces genuine
 * surplus-for-need swaps, which are the deals that really get accepted.
 */
export function suggestAddOns({ cfg, ctx, giver, receiver, gap, limit = 4 }) {
    if (!gap || gap <= 0) return [];

    const slots = cfg.starterSlots;
    const inDeal = new Set([...(giver.side?.sending || []), ...(receiver.side?.sending || [])]);

    const giverRoster = giver.after;
    const receiverRoster = receiver.after;
    const giverBase = optimizeLineup(giverRoster, slots).points;
    const receiverBase = optimizeLineup(receiverRoster, slots).points;

    const candidates = giverRoster.filter(
        (e) =>
            !inDeal.has(e.player.id) &&
            // Nobody sweetens a trade with a kicker or a defense.
            e.player.pos !== 'K' &&
            e.player.pos !== 'DEF'
    );

    const scored = candidates.map((entry) => {
        const costToGiver = giverBase - optimizeLineup(giverRoster.filter((e) => e !== entry), slots).points;
        const gainToReceiver = optimizeLineup([...receiverRoster, entry], slots).points - receiverBase;
        const closes = entry.value / gap;
        // Overshooting is worse than undershooting: handing over more than the
        // gap just flips the unfairness around.
        const fitPenalty = closes > 1 ? (closes - 1) * 1.6 : (1 - closes) * 1.1;
        const efficiency = gainToReceiver - costToGiver;

        return {
            entry,
            player: entry.player,
            posRank: entry.posRank,
            value: entry.value,
            costToGiver,
            gainToReceiver,
            efficiency,
            closes,
            score: efficiency - fitPenalty * 5,
        };
    });

    return sortBy(scored, (c) => c.score, -1)
        .filter((c) => c.closes > 0.15 && c.closes < 2.2)
        .slice(0, limit)
        .map((c) => ({
            player: c.player,
            posRank: c.posRank,
            value: c.value,
            closes: Math.round(clamp(c.closes, 0, 2) * 100),
            costToGiver: round(c.costToGiver, 1),
            gainToReceiver: round(c.gainToReceiver, 1),
            // Surplus-for-need is the headline case worth calling out.
            mutual: c.gainToReceiver > 0.3 && c.costToGiver < 0.3,
            overshoot: c.closes > 1.35,
            rationale: rationaleFor(c),
        }));
}

function rationaleFor(c) {
    const pos = c.player.pos;
    if (c.gainToReceiver > 0.5 && c.costToGiver < 0.3) {
        return `Pure surplus — he does not crack the current lineup on one side and adds ${round(c.gainToReceiver, 1)} pts/wk to the other.`;
    }
    if (c.gainToReceiver > 0.5) {
        return `Adds ${round(c.gainToReceiver, 1)} pts/wk at ${pos}, at a cost of ${round(c.costToGiver, 1)} pts/wk to give up.`;
    }
    if (c.costToGiver < 0.2) {
        return `Costs nothing to give up — depth behind an established starter.`;
    }
    return `Balances the value without opening a hole at ${pos}.`;
}

/**
 * When no single add-on closes the gap, try pairs. Kept deliberately small:
 * the point is a realistic counter-offer, not an exhaustive search.
 */
export function suggestPackages({ cfg, ctx, giver, receiver, gap, limit = 3 }) {
    const singles = suggestAddOns({ cfg, ctx, giver, receiver, gap, limit: 8 });
    if (!singles.length) return [];

    const packages = [];
    for (let i = 0; i < singles.length; i++) {
        for (let j = i + 1; j < singles.length; j++) {
            const a = singles[i];
            const b = singles[j];
            const combined = a.value + b.value;
            const closes = combined / gap;
            if (closes < 0.75 || closes > 1.45) continue;

            // Two players added together are worth less than the sum of their
            // separate marginal values -- the second one is competing for a
            // lineup spot the first has already taken. Re-solve with both.
            const slots = cfg.starterSlots;
            const receiverBase = optimizeLineup(receiver.after, slots).points;
            const aEntry = giver.after.find((e) => e.player.id === a.player.id);
            const bEntry = giver.after.find((e) => e.player.id === b.player.id);
            if (!aEntry || !bEntry) continue;
            const jointGain =
                optimizeLineup([...receiver.after, aEntry, bEntry], slots).points - receiverBase;
            const giverBase = optimizeLineup(giver.after, slots).points;
            const jointCost =
                giverBase - optimizeLineup(giver.after.filter((e) => e !== aEntry && e !== bEntry), slots).points;

            packages.push({
                players: [a.player, b.player],
                value: combined,
                closes: Math.round(closes * 100),
                gainToReceiver: round(jointGain, 1),
                costToGiver: round(jointCost, 1),
            });
        }
    }
    return sortBy(packages, (p) => Math.abs(p.closes - 100)).slice(0, limit);
}
