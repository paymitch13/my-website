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

/** Value + projection for one player, given a ranking board. */
export function evaluateRosterEntry(player, rankings, ctx) {
    const posRank = rankings.get(player.id) ?? 999;
    const v = valuePlayer(player, posRank, ctx);
    return { player, posRank, score: v.effectivePpg, value: v.value, detail: v };
}

export function buildEntries(players, rankings, ctx) {
    return players.map((p) => evaluateRosterEntry(p, rankings, ctx));
}

/**
 * Value a player the way the rest of the league would, not the way you do.
 *
 * This is the difference between "do I want this deal" and "will they accept
 * it". Valuing a counterparty's roster with YOUR board means that if you are
 * low on a player, the app decides his own manager is low on him too, and
 * cheerfully reports that they will hand him over. They will not.
 *
 * Which second opinion, in order of preference:
 *
 *   1. THE MARKET. What players actually cost in real leagues. This is the
 *      right answer to "will they accept", because it is the only input that
 *      knows what other managers believe rather than what a spreadsheet
 *      concludes -- workload security, injury history, a changed offense.
 *   2. THE PROJECTION. Each player's projected rank, computed independently of
 *      the user's ordering. Sound, auditable, and blind to all of the above.
 *
 * The market arrives as a ranking, not as a price, and enters the pipeline at
 * exactly the point the user's own board does. That is deliberate: the market
 * supplies the opinion and this league supplies the scale, so a market value
 * automatically respects the scoring, the roster slots and the replacement
 * level here instead of importing someone else's league shape along with it.
 */
export function neutralEntry(player, ctx) {
    const market = ctx.marketRanks?.get(player.id) ?? null;
    const proj = ctx.projections?.[player.id] || null;
    const projected = proj ? valuePlayer(player, 1, ctx).projectedRank : null;

    // What he will SCORE and what he will COST are different questions and they
    // take different boards. Points come from the projection, because a lineup
    // solve and a season simulation are meant to model what actually happens on
    // Sunday, and sentiment does not put points on the board. Price comes from
    // the market, because that is what his manager will ask for.
    //
    // Running both off one number is a real error either way round: price the
    // lineup at market and a player the league is high on inflates his team's
    // simulated season; price the ask at projection and the app decides a
    // manager will hand over the guy everyone wants for what a spreadsheet
    // says he is worth.
    const scoringRank = projected ?? market ?? 999;
    const priceRank = market ?? projected ?? 999;
    const scoring = valuePlayer(player, scoringRank, ctx);
    const price = priceRank === scoringRank ? scoring : valuePlayer(player, priceRank, ctx);

    return {
        player,
        posRank: priceRank,
        score: scoring.effectivePpg,
        value: price.value,
        detail: price,
        neutral: true,
        // Which board priced him, so a card never implies a market number it
        // did not have. Both ranks are carried whether or not they were used --
        // the gap between them is the whole buy-low signal.
        priced: market ? 'market' : projected ? 'projection' : 'unranked',
        marketRank: market,
        projectedRank: projected,
    };
}

export function buildNeutralEntries(players, ctx) {
    return players.map((p) => neutralEntry(p, ctx));
}

/**
 * What one player costs on the open market, whoever currently owns him and
 * whatever the user thinks of him.
 *
 * Memoised on the context because the ledger asks for the same handful of
 * players repeatedly across a search, and each miss is a full valuation.
 */
export function marketPrice(entry, ctx) {
    if (entry.neutral) return entry.value;
    if (!ctx.marketRanks && !ctx.projections) return entry.value;

    if (!ctx._marketPrices) ctx._marketPrices = new Map();
    const hit = ctx._marketPrices.get(entry.player.id);
    if (hit !== undefined) return hit;

    const priced = neutralEntry(entry.player, ctx).value;
    ctx._marketPrices.set(entry.player.id, priced);
    return priced;
}

/**
 * Evaluate a trade.
 *
 * @param {object} input
 * @param {object} input.cfg        normalized league config
 * @param {object} input.ctx        valuation context
 * @param {Array}  input.teams      [{rosterId, name, owner, players, wins, losses, ties, pointsFor}]
 * @param {Array}  input.offers     [{rosterId, sending:[playerId], receiving?:[playerId], faab?:number}]
 * @param {Map}    input.rankings   playerId -> positional rank
 * @param {object} [input.faab]     faabModel() for this league, or null. Without
 *   it cash in an offer is validated but priced at zero, which is the honest
 *   answer when nothing is known about what a dollar buys here.
 * @param {Function} [input.entriesFor] team -> valued entries. Defaults to the
 *   user's board for every roster. The finder passes neutral entries for
 *   everyone but the user, so "will they accept" is answered on their terms.
 * @param {Array}  [input.schedule] remaining schedule; omit to skip odds simulation
 * @returns {Promise<object>} async because the simulation runs in a worker
 */
export async function evaluateTrade(input) {
    const {
        cfg, ctx, teams, offers, rankings, schedule = null, iterations = 2000,
        entriesFor = null, cache = null, faab = null,
    } = input;

    // How each roster is valued. Without an override every side is judged on
    // the user's board, which is right for a calculator the user drives and
    // wrong for predicting whether a counterparty accepts.
    const valueRoster = entriesFor || ((team) => buildEntries(team.players, rankings, ctx));

    const byRoster = new Map(teams.map((t) => [t.rosterId, t]));
    const playerIndex = new Map();
    for (const t of teams) for (const p of t.players) playerIndex.set(p.id, { player: p, rosterId: t.rosterId });

    const resolved = resolveOffers(offers, { cfg, byRoster });
    if (resolved.error) return { ok: false, error: resolved.error };
    const sides = resolved.sides;

    // --- Build "before" and "after" rosters for every team in the deal -------
    const analysis = [];
    for (const side of sides) {
        const team = byRoster.get(side.rosterId);
        if (!team) return { ok: false, error: `Unknown team in offer: ${side.rosterId}` };

        const sendingSet = new Set(side.sending);
        const before = valueRoster(team);
        const kept = team.players.filter((p) => !sendingSet.has(p.id));
        const incoming = side.receiving
            .map((id) => playerIndex.get(id)?.player)
            .filter(Boolean);
        // Value the post-trade roster on the SAME board as the pre-trade one,
        // so the delta is the trade and not a change of yardstick.
        const after = valueRoster({ ...team, players: [...kept, ...incoming] });

        const outEntries = before.filter((e) => sendingSet.has(e.player.id));
        const inEntries = after.filter((e) => incoming.some((p) => p.id === e.player.id));

        analysis.push({ side, team, before, after, outEntries, inEntries });
    }

    // --- 1. VALUE: the zero-sum ledger --------------------------------------
    // Cash belongs here and nowhere else. It carries value -- it buys players
    // off waivers -- but it scores no points, so it must not touch the lineup
    // solve, the simulation, or the roster-crunch charge. A deal where you get
    // $40 for a starter should read as positive value and negative lineup fit,
    // and the verdict should say exactly that.
    for (const a of analysis) {
        const priceOf = (dollars, team) =>
            dollars > 0 && faab?.usable ? faab.valueOf(dollars, team) : 0;

        a.faabOut = a.side.faabOut || 0;
        a.faabIn = a.side.faabIn || 0;
        a.faabValueOut = priceOf(a.faabOut, a.team);
        // Cash arriving is worth what the RECEIVING team can do with it, which
        // is not what it was worth to the sender: $20 to a manager holding $3
        // buys a claim he could not otherwise win.
        a.faabValueIn = priceOf(a.faabIn, a.team);

        a.playerValueOut = sum(a.outEntries, (e) => e.value);
        a.playerValueIn = sum(a.inEntries, (e) => e.value);
        a.valueOut = a.playerValueOut + a.faabValueOut;
        a.valueIn = a.playerValueIn + a.faabValueIn;
        a.valueNet = a.valueIn - a.valueOut;

        // The same ledger again at MARKET price, on one yardstick for both
        // sides. "Is this fair" and "is this good for me" are different
        // questions and were being answered with the same number: priced on
        // your own board, being higher than everyone else on your own player
        // made the fairness meter say you were winning the trade. Fairness is a
        // question about price. What you think of him is reported separately,
        // and where the two disagree that gap is the interesting part.
        a.marketOut = sum(a.outEntries, (e) => marketPrice(e, ctx)) + a.faabValueOut;
        a.marketIn = sum(a.inEntries, (e) => marketPrice(e, ctx)) + a.faabValueIn;
        a.marketNet = a.marketIn - a.marketOut;
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
        a.lineupChange = lineupChange(lineupBefore, lineupAfter);
    }

    // --- 3. IMPACT: playoff and title odds, before vs after -----------------
    let odds = null;
    if (schedule && schedule.length && teams.length > 2) {
        odds = await simulateImpact({ cfg, ctx, teams, analysis, rankings, schedule, iterations, valueRoster, cache });
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
        reasons: buildReasons(scored, cfg, ctx, !!odds, iterations, faab),
        leagueOdds: odds,
        weeksLeft: ctx.weeksLeft,
    };
}

/**
 * Scratch space shared by many evaluations of the SAME league, schedule, board
 * and iteration count -- which is exactly what a finder search is. Anything
 * else changing (a different week, a re-ranked board, a re-synced league) needs
 * a fresh cache, so make one per search and throw it away afterwards.
 */
export function createEvalCache() {
    return { basePoints: new Map(), baseline: null };
}

/**
 * Two-team offers can infer what each side receives; larger deals must be
 * explicit. Cash is validated here too, against the real budgets, because a
 * deal that cannot legally be sent is not a deal worth analysing.
 */
function resolveOffers(offers, { cfg = null, byRoster = null } = {}) {
    if (!offers || offers.length < 2) return { error: 'A trade needs at least two teams.' };

    // A player-for-cash trade is legal and common, so "sending" may be empty as
    // long as the side is sending money instead.
    const cash = (o) => Number(o.faab) || 0;
    if (offers.some((o) => (!o.sending || !o.sending.length) && cash(o) <= 0)) {
        return { error: 'Every team in the trade has to send a player or FAAB.' };
    }

    for (const o of offers) {
        const amount = cash(o);
        if (amount === 0) continue;
        if (cfg && !cfg.usesFaab) {
            return { error: 'This league does not use FAAB, so cash cannot be traded.' };
        }
        if (amount < 0 || !Number.isInteger(amount)) {
            return { error: 'FAAB has to be a whole number of dollars, and not negative.' };
        }
        const team = byRoster?.get(o.rosterId);
        const budget = team?.faabRemaining;
        if (Number.isFinite(budget) && amount > budget) {
            return { error: `${team.name || `Roster ${o.rosterId}`} only has $${budget} of FAAB left.` };
        }
    }

    if (offers.length === 2) {
        return {
            sides: [
                {
                    ...offers[0],
                    receiving: offers[0].receiving ?? offers[1].sending,
                    faabIn: cash(offers[1]),
                    faabOut: cash(offers[0]),
                },
                {
                    ...offers[1],
                    receiving: offers[1].receiving ?? offers[0].sending,
                    faabIn: cash(offers[0]),
                    faabOut: cash(offers[1]),
                },
            ],
        };
    }
    if (offers.some((o) => !o.receiving)) {
        return { error: 'Trades with three or more teams must say who receives what.' };
    }
    // In a multi-team deal cash has to name its destination, so it is carried
    // per side as a plain out-only amount plus whatever `faabIn` the caller set.
    return {
        sides: offers.map((o) => ({ ...o, faabOut: cash(o), faabIn: Number(o.faabIn) || 0 })),
    };
}

/**
 * Re-run the whole league with the traded rosters in place. Both simulations
 * share a seed so the two runs see identical weekly randomness -- the
 * difference between them is the trade, not sampling noise.
 */
async function simulateImpact({ cfg, ctx, teams, analysis, rankings, schedule, iterations, valueRoster, cache = null }) {
    const overrideBefore = new Map();
    const overrideAfter = new Map();
    for (const a of analysis) {
        overrideBefore.set(a.side.rosterId, a.lineupBefore.points);
        overrideAfter.set(a.side.rosterId, a.lineupAfter.points);
    }

    // Every roster the trade does not touch is solved identically on every
    // call. Across a finder search that is hundreds of repeats of the same
    // lineup solve, each one rebuilding the same valued entries first.
    const basePoints = (t) => {
        if (!cache) return optimizeLineup(valueRoster(t), cfg.starterSlots).points;
        if (!cache.basePoints.has(t.rosterId)) {
            cache.basePoints.set(t.rosterId, optimizeLineup(valueRoster(t), cfg.starterSlots).points);
        }
        return cache.basePoints.get(t.rosterId);
    };

    const mk = (overrides) =>
        teams.map((t) => {
            const points = overrides.get(t.rosterId) ?? basePoints(t);
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
    // The "before" run is the untouched league: identical for every candidate
    // in a search, and half the simulation budget if it is repeated. The
    // promise is cached, not the result, so concurrent callers share one run.
    // Both runs go to the worker together; they are independent.
    const beforePromise = cache
        ? (cache.baseline ||= runSimulation(mk(overrideBefore), schedule, opts))
        : runSimulation(mk(overrideBefore), schedule, opts);
    const [before, after] = await Promise.all([
        beforePromise,
        runSimulation(mk(overrideAfter), schedule, opts),
    ]);

    const out = new Map();
    const bIdx = new Map(before.map((r) => [r.rosterId, r]));
    const aIdx = new Map(after.map((r) => [r.rosterId, r]));
    for (const t of teams) out.set(t.rosterId, { before: bIdx.get(t.rosterId), after: aIdx.get(t.rosterId) });
    return out;
}

/**
 * Who actually entered and left the starting lineup, and what that was worth.
 *
 * This exists because per-position slot accounting cannot describe a trade
 * without lying about it. Swap a running back for a receiver and the RB slots
 * lose his whole score while the WR slots gain the other man's, so a deal worth
 * -0.8 points a week reported as "opens a 15.5 hole at RB" AND "upgrades 14.6
 * at WR" -- two alarming findings, both arithmetically true of the slot
 * columns, describing one lateral move whose real effect was under a point.
 * The flex absorbing the difference is invisible in that view.
 *
 * The starting lineup is the thing that scores, so the diff of the starting
 * lineup is the thing to report. It cannot double count: a player is in it or
 * he is not.
 */
export function lineupChange(before, after) {
    const idsOf = (l) => new Set(l.starters.map((s) => s.entry.player.id));
    const wasStarting = idsOf(before);
    const nowStarting = idsOf(after);

    const arrived = after.starters.filter((s) => !wasStarting.has(s.entry.player.id));
    const departed = before.starters.filter((s) => !nowStarting.has(s.entry.player.id));

    return {
        // Newly in the lineup, best first -- includes players already on the
        // roster who were promoted to cover for someone who left.
        arrived: sortBy(arrived.map((s) => ({ entry: s.entry, slot: s.slot })), (x) => x.entry.score, -1),
        departed: sortBy(departed.map((s) => ({ entry: s.entry, slot: s.slot })), (x) => x.entry.score, -1),
        net: after.points - before.points,
    };
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
 * Plain-language reasoning.
 *
 * Three rules, each of them a bug this function used to have:
 *
 *   1. ONE FACT, ONCE, AT ITS TRUE SIZE. A single swap was being reported as a
 *      hole at one position and an upgrade at another, at twenty times its net
 *      effect, because slot columns double count what the flex absorbs.
 *   2. NOTHING ASSERTED THAT WAS NOT CHECKED. "Nobody replaces him" and "the
 *      incoming talent sits behind players already starting" were written
 *      whether or not they were true.
 *   3. NOTHING THAT IS TRUE OF EVERY TRADE. A 96%-available Questionable tag,
 *      a playoff swing inside simulation noise, and "the season barely moves"
 *      are not findings; they are the weather.
 *
 * A two-team trade is also zero-sum on the ledger, so a fact about one side is
 * usually the same fact about the other. Those are stated once.
 */
function buildReasons(sides, cfg, ctx, hasOdds, iterations = 2000, faab = null) {
    const reasons = [];
    const wk = ctx.weeksLeft;
    // Below this, a simulated odds difference is sampling noise rather than a
    // result.
    //
    // Measured, not guessed. Paired runs share a seed, so a trade that changes
    // no lineup returns a delta of exactly zero -- the two runs see identical
    // weeks. What remains is how much the ESTIMATE moves with the seed: a
    // genuine +0.8 pts/wk edge, run under forty seeds at 2,000 iterations,
    // averaged +2.50% playoff odds with a standard deviation of 0.42% and a
    // spread from +1.6% to +3.8%. Two standard deviations is 0.84%, and
    // 0.38/sqrt(iterations) reproduces that across run lengths.
    const oddsFloor = Math.max(0.005, 0.38 / Math.sqrt(Math.max(1, iterations)));

    for (const s of sides) {
        const name = s.team.name;
        const mine = [];
        const add = (r) => mine.push({ ...r, team: s.team.rosterId });

        // --- Cash ----------------------------------------------------------
        // First when there is any, because it is the part of a deal people are
        // least able to price in their heads.
        if (s.faabIn > 0 || s.faabOut > 0) {
            const net = s.faabIn - s.faabOut;
            const gross = Math.abs(net);
            const receiving = net > 0;
            const worth = Math.abs(s.faabValueIn - s.faabValueOut);
            const perWeek = worth / Math.max(1, wk);

            const basis = faab?.usable
                ? faab.source === 'observed'
                    ? `The median winning bid in this league is $${faab.median} across ${faab.samples} claim${faab.samples === 1 ? '' : 's'}${faab.max ? `, and the highest was $${faab.max}` : ''}.`
                    : 'Nobody has bid yet this season, so that is priced off the value left in the free-agent pool against the cash chasing it.'
                : 'There is no bidding history to price it against yet, so it is carried at zero rather than guessed at.';

            const budgetNote = Number.isFinite(s.team.faabRemaining)
                ? ` ${name} ${receiving ? 'would hold' : 'would be left with'} $${Math.max(0, (s.team.faabRemaining ?? 0) + net)} of $${cfg.faabBudget}.`
                : '';

            add({
                kind: receiving ? 'good' : 'warn',
                code: 'faab',
                weight: 1.5 + worth / 20,
                title: `${receiving ? 'Gets' : 'Sends'} $${gross} of FAAB`,
                detail: faab?.usable
                    ? `That is worth about ${round(worth, 1)} rest-of-season points, roughly ${round(perWeek, 1)} a week. ${basis}` +
                      ` It does nothing for this week's lineup, and it takes no roster spot.${budgetNote}`
                    : `${basis}${budgetNote}`,
            });
        }

        // --- What happens to the lineup ------------------------------------
        // The starting eleven is the only thing that scores, so its diff is the
        // story: who walks in, who walks out, and the one number that is the
        // difference between them.
        const change = s.lineupChange;
        if (change && Math.abs(change.net) >= 0.4) {
            const better = change.net > 0;
            const arrived = change.arrived.map((x) => x.entry.player.name);
            const departed = change.departed.map((x) => x.entry.player.name);

            add({
                kind: better ? 'good' : 'bad',
                code: 'lineup',
                weight: 2 + Math.abs(change.net),
                title: `${better ? 'Gains' : 'Loses'} ${Math.abs(round(change.net, 1))} pts/week in the starting lineup`,
                detail: describeLineupChange({ arrived, departed, net: change.net, weeks: wk, ros: s.rosLineupPoints }),
            });
        } else if (change && change.arrived.length) {
            // Bodies moved and the lineup did not. Worth saying plainly,
            // because it is the most common way a trade that looks exciting
            // turns out not to be one.
            add({
                kind: 'neutral',
                code: 'lineup-flat',
                weight: 0.9,
                title: 'The starting lineup barely changes',
                detail:
                    `The players coming in slot into roughly what was already there — ` +
                    `${Math.abs(round(change.net, 1))} pts/week either way. Whatever this deal is for, it is not this week's points.`,
            });
        }

        // --- Where the lineup change lands ---------------------------------
        // Attributed to a position ONLY when that position drives the net
        // rather than cancelling against another. A lateral swap moves two slot
        // columns hard and the team not at all, and describing that as two
        // findings is how one trade came to read as a crisis.
        const net = change?.net ?? s.lineupNet;
        if (Math.abs(net) >= 1) {
            for (const [pos, sw] of Object.entries(s.positionSwing)) {
                const d = sw.startingDelta;
                // Same direction as the net, and big enough to be most of it.
                if (Math.sign(d) !== Math.sign(net)) continue;
                if (Math.abs(d) < 1.5) continue;
                const share = Math.abs(d) / Math.max(0.1, Math.abs(net));
                // A swing several times the net is being cancelled elsewhere;
                // that is the flex doing its job, not a positional story.
                if (share > 2.5) continue;

                const who = (d > 0 ? s.inEntries : s.outEntries)
                    .filter((e) => e.player.pos === pos)
                    .map((e) => e.player.name)
                    .join(', ');
                if (!who) continue;

                add({
                    kind: d > 0 ? 'good' : 'bad',
                    code: `pos-${pos}`,
                    weight: 1 + Math.abs(d) / 2,
                    title: `${d > 0 ? 'Upgrades' : 'Gets worse'} at ${pos} (${d > 0 ? '+' : ''}${round(d, 1)} pts/wk)`,
                    detail:
                        d > 0
                            ? `${who} goes straight into the lineup at ${pos}.`
                            : replacementNote(s, pos, who),
                });
            }
        }

        // --- Value that never reaches the lineup ---------------------------
        // Only when it is checked rather than assumed: the incoming players
        // really are on the bench afterwards.
        const benchedIn = s.inEntries.filter(
            (e) => !s.lineupAfter.starters.some((st) => st.entry.player.id === e.player.id)
        );
        if (s.valueNet > 0 && net <= 0.2 && benchedIn.length) {
            add({
                kind: 'warn',
                code: 'value-not-lineup',
                weight: 1.4,
                title: 'Wins the ledger but not the lineup',
                detail:
                    `${benchedIn.map((e) => e.player.name).join(' and ')} ${benchedIn.length === 1 ? 'does' : 'do'} not crack the ` +
                    `starting lineup, so the value gained does not score points this season.`,
            });
        }
        if (s.valueNet < 0 && net > 0.6) {
            add({
                kind: 'good',
                code: 'consolidation',
                weight: 1.4,
                title: 'Gives up value but improves the lineup',
                detail: 'Consolidating depth into a starter is exactly how a team should lose a value ledger on purpose.',
            });
        }

        // --- Roster crunch --------------------------------------------------
        if (s.overflow > 0) {
            const names = s.crunchCuts.map((c) => c.player.name).join(', ');
            const dealSize = Math.max(1, Math.abs(s.valueIn) + Math.abs(s.valueOut));
            const material = s.crunchCost / dealSize > 0.08;
            add({
                kind: material ? 'warn' : 'neutral',
                code: 'crunch',
                weight: material ? 1.3 : 0.5,
                title: `Has to cut ${s.overflow} player${s.overflow === 1 ? '' : 's'}`,
                detail: material
                    ? `The roster only holds ${cfg.rosterSize}. Dropping ${names} costs real value and is part of the price of this deal.`
                    : `The roster only holds ${cfg.rosterSize}, so ${names} would go. They are deep bench pieces — a minor cost next to the rest of the trade.`,
            });
        }

        // --- Injuries worth mentioning --------------------------------------
        // A tag is not news. A tag that has already cost the player real
        // expected time is. Questionable at 96% availability was being raised
        // as a warning on both sides of trades it had no bearing on.
        const injured = s.inEntries.filter(
            (e) => e.player.injury && (e.detail?.availability ?? 1) <= 0.85
        );
        if (injured.length) {
            const worst = sortBy(injured, (e) => e.detail.availability)[0];
            const rest = injured.length - 1;
            add({
                kind: 'warn',
                code: 'injury',
                weight: 1.2 + (1 - worst.detail.availability) * 2,
                title:
                    `${worst.player.name} is ${worst.player.injury}` +
                    (rest > 0 ? ` (and ${rest} other incoming player${rest === 1 ? '' : 's'} carry tags)` : ''),
                detail:
                    `His value here is already discounted to ${Math.round(worst.detail.availability * 100)}% for expected ` +
                    `missed time. Confirm the timeline before accepting.`,
            });
        }

        // --- What it does to the season --------------------------------------
        if (hasOdds) {
            const pd = s.playoffDelta;
            const td = s.titleDelta;
            if (Math.abs(pd) >= oddsFloor || Math.abs(td) >= oddsFloor / 2) {
                add({
                    kind: pd + td > 0 ? 'good' : 'bad',
                    code: 'odds',
                    weight: 3 + Math.abs(pd) * 10 + Math.abs(td) * 20,
                    title: `Playoff odds ${fmtPctDelta(pd)}, title odds ${fmtPctDelta(td)}`,
                    detail: `${round(s.playoffBefore * 100, 1)}% → ${round(s.playoffAfter * 100, 1)}% to make the playoffs across ${iterations.toLocaleString()} simulated seasons on the real remaining schedule.`,
                });
            }

            if (s.playoffBefore > 0.85 && s.titleDelta > oddsFloor / 2) {
                add({
                    kind: 'good',
                    code: 'lock',
                    weight: 1.6,
                    title: 'Already a lock — this is about January',
                    detail: 'The playoff spot was never in doubt. The right question is title odds, and those go up.',
                });
            }
            if (s.playoffBefore < 0.15 && ctx.dynasty === false && s.valueNet > 0) {
                add({
                    kind: 'warn',
                    code: 'lost-season',
                    weight: 1.7,
                    title: 'Buying in a lost season',
                    detail: `At ${round(s.playoffBefore * 100, 0)}% to make the playoffs, adding win-now value in a redraft league has almost no payoff.`,
                });
            }
        }

        // Nothing at all to say is itself worth one line, and only one.
        if (!mine.length) {
            add({
                kind: 'neutral',
                code: 'nothing',
                weight: 0.1,
                title: 'This trade does very little here',
                detail: hasOdds
                    ? `Lineup, value and playoff odds all finish within noise of where they started.`
                    : `Neither the lineup nor the value ledger moves enough to matter.`,
            });
        }

        reasons.push(...mine);
    }

    return rankReasons(reasons, sides);
}

/** The lineup diff in a sentence, naming only what actually moved. */
function describeLineupChange({ arrived, departed, net, weeks, ros }) {
    const total = `${Math.abs(round(ros, 0))} points across the ${weeks} week${weeks === 1 ? '' : 's'} left`;
    if (arrived.length && departed.length) {
        return `${departed.join(' and ')} ${departed.length === 1 ? 'comes' : 'come'} out of the lineup and ` +
            `${arrived.join(' and ')} ${arrived.length === 1 ? 'goes' : 'go'} in — ${total}.`;
    }
    if (arrived.length) {
        return `${arrived.join(' and ')} ${arrived.length === 1 ? 'joins' : 'join'} the starting lineup — ${total}.`;
    }
    if (departed.length) {
        return `${departed.join(' and ')} ${departed.length === 1 ? 'leaves' : 'leave'} the starting lineup and ` +
            `nobody incoming replaces ${departed.length === 1 ? 'him' : 'them'} — ${total}.`;
    }
    return `The same players start, but their expected output shifts by ${total}.`;
}

/**
 * Who actually steps into the gap, checked rather than asserted.
 *
 * "Nobody on the roster replaces him" was printed regardless of whether
 * somebody did, on rosters carrying a perfectly good next man up.
 */
function replacementNote(side, pos, who) {
    const heir = side.lineupAfter.starters
        .filter((st) => st.entry.player.pos === pos)
        .map((st) => st.entry)
        .filter((e) => !side.lineupBefore.starters.some((st) => st.entry.player.id === e.player.id));

    if (heir.length) {
        const best = sortBy(heir, (e) => e.score, -1)[0];
        return `${who} leaves and ${best.player.name} takes the ${pos} slot, at ${round(best.score, 1)} pts/wk.`;
    }
    return `${who} leaves and the ${pos} slot is filled from what is already on the roster.`;
}

/**
 * Order by how much each point matters, then cut the repeats.
 *
 * Deduplication keys on the KIND of finding rather than its rendered title.
 * Titles carry numbers, so two versions of the same observation never matched
 * and both survived -- which is how a board came to hold four variations on
 * "you got worse at receiver".
 */
function rankReasons(reasons, sides) {
    const weight = (r) => (r.weight ?? 1) * ({ bad: 3, warn: 2, good: 2.2, neutral: 0.6 }[r.kind] ?? 1);
    const ranked = sortBy(reasons, weight, -1);

    const perTeam = new Map();
    const seen = new Set();
    const out = [];
    for (const r of ranked) {
        const key = `${r.team}:${r.code ?? r.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const count = perTeam.get(r.team) || 0;
        // Four is what fits on a card without scrolling past the verdict, and
        // the fifth was always a restatement of one of the first four.
        if (count >= 4) continue;
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

/**
 * Cash as the gap-closer, when the roster has no player who fits.
 *
 * This is the most common real sweetener there is, and the one the app could
 * not propose: a giver whose only spare pieces are either useless or too good
 * has nothing to offer, and the deal dies over a difference the two managers
 * would happily settle in dollars. Cash is also the cleanest possible
 * sweetener, because it costs the giver no lineup points at all.
 *
 * @param {object} input
 * @param {object} input.faab   faabModel(), or null in a non-FAAB league
 * @param {object} input.giver  the side that owes value
 * @param {object} input.receiver
 * @param {number} input.gap    value the giver needs to send
 */
export function suggestFaab({ faab, giver, receiver, gap }) {
    if (!faab?.usable || !gap || gap <= 0) return null;

    const budget = giver.team?.faabRemaining ?? 0;
    const alreadySending = giver.faabOut || 0;
    const spare = Math.max(0, budget - alreadySending);
    if (spare < 1) return null;

    // Price at the RECEIVER's rate: cash is only worth closing a gap with if it
    // is worth something to the manager being handed it.
    const perDollar = faab.valueOf(1, receiver.team);
    if (!(perDollar > 0)) return null;

    const ideal = Math.ceil(gap / perDollar);
    const dollars = Math.min(ideal, spare);
    if (dollars < 1) return null;

    const value = faab.valueOf(dollars, receiver.team);
    const closes = value / gap;
    // Cash that barely dents the gap is not a proposal, it is a rounding error.
    if (closes < 0.15) return null;

    const perWeek = value / Math.max(1, faab.weeksLeft || 1);

    return {
        dollars,
        value,
        perWeek,
        closes: Math.round(clamp(closes, 0, 2) * 100),
        short: dollars < ideal,
        remainingAfter: Math.max(0, budget - alreadySending - dollars),
        rationale:
            dollars < ideal
                ? `$${dollars} is everything ${giver.team.name} has left. It covers ${Math.round(closes * 100)}% of the gap — about ${round(perWeek, 1)} pts/wk of waiver upgrade — without costing either lineup a point.`
                : `$${dollars} closes the gap without costing ${giver.team.name} a single lineup point, and takes no roster spot on the other side. It is worth roughly ${round(perWeek, 1)} pts/wk of waiver upgrade to ${receiver.team.name}.`,
    };
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
