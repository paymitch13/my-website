// Trade finder: a three-stage funnel.
//
// A twelve-team league is roughly 16 of your players against 176 of theirs.
// One-for-one alone is ~2,800 combinations, and a 2,000-iteration double
// simulation on each is out of the question. So the cost of evaluation is
// matched to the number of candidates that survive:
//
//   Stage 1  need/surplus filter        microseconds   ~2,800 -> ~200
//   Stage 2  lineup solve, both ways    milliseconds     ~200 -> ~40
//   Stage 3  full evaluation with odds  seconds           ~40 -> ~8
//
// Throughout, the counterparty's roster is valued on the NEUTRAL board (each
// player's projected rank), never on the user's. Otherwise a player the user
// happens to rank low looks cheap to pry loose, and the whole tool recommends
// offers nobody would accept.

import { buildEntries, buildNeutralEntries, evaluateTrade } from './trade.js';
import { optimizeLineup, marginalValue } from './lineup.js';
import { buildLeagueNeeds, matchingPositions } from './needs.js';
import { sortBy } from './util.js';

const TRADEABLE = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * @param {object} input
 * @param {object} input.cfg          normalized league
 * @param {object} input.ctx          valuation context
 * @param {Array}  input.teams        all teams
 * @param {number} input.myRosterId
 * @param {Map}    input.rankings     the user's board
 * @param {Array}  [input.schedule]
 * @param {Map}    [input.odds]       rosterId -> playoff odds, for posture
 * @param {object} [input.limits]
 */
export async function findTrades(input) {
    const {
        cfg, ctx, teams, myRosterId, rankings, schedule = null,
        playoffOdds = null, iterations = 1200,
        limits = {},
    } = input;

    const { stage2Keep = 40, stage3Keep = 8 } = limits;

    const me = teams.find((t) => t.rosterId === myRosterId);
    if (!me) return { ok: false, error: 'Unknown roster.' };
    const others = teams.filter((t) => t.rosterId !== myRosterId);

    // --- Stage 1: need and surplus -----------------------------------------
    // My roster is judged on my board (it is my opinion that matters for what I
    // want); every other roster is judged neutrally (their opinion is not mine).
    const needsMap = buildLeagueNeeds({
        teams,
        cfg,
        entriesFor: (team) =>
            team.rosterId === myRosterId
                ? buildEntries(team.players, rankings, ctx)
                : buildNeutralEntries(team.players, ctx),
    });

    const mine = needsMap.get(myRosterId);
    const pairs = [];

    for (const other of others) {
        const theirs = needsMap.get(other.rosterId);
        if (!theirs) continue;

        // What I need that they can spare, and what they need that I can spare.
        const iWant = matchingPositions(mine, theirs);
        const theyWant = matchingPositions(theirs, mine);
        if (!iWant.length || !theyWant.length) continue;

        for (const want of iWant.slice(0, 2)) {
            for (const give of theyWant.slice(0, 2)) {
                if (want.pos === give.pos) continue;
                pairs.push({ other, theirs, wantPos: want.pos, givePos: give.pos, score: want.score + give.score });
            }
        }
    }

    // --- Stage 2: lineup solve, both directions ----------------------------
    const candidates = [];
    for (const pair of sortBy(pairs, (p) => p.score, -1)) {
        const { other, theirs } = pair;

        const targets = theirs.entries.filter(
            (e) => e.player.pos === pair.wantPos && TRADEABLE.has(e.player.pos)
        );
        const offers = mine.entries.filter(
            (e) => e.player.pos === pair.givePos && TRADEABLE.has(e.player.pos)
        );
        if (!targets.length || !offers.length) continue;

        const myBase = mine.lineup.points;
        const theirBase = theirs.lineup.points;

        for (const target of sortBy(targets, (e) => e.value, -1).slice(0, 5)) {
            for (const offer of sortBy(offers, (e) => e.value, -1).slice(0, 5)) {
                // What each side's starting lineup actually gains.
                const myAfter = optimizeLineup(
                    [...mine.entries.filter((e) => e !== offer), target],
                    cfg.starterSlots
                ).points;
                const theirAfter = optimizeLineup(
                    [...theirs.entries.filter((e) => e !== target), offer],
                    cfg.starterSlots
                ).points;

                const myGain = myAfter - myBase;
                const theirGain = theirAfter - theirBase;

                // Both sides must gain. A deal that only helps me is one they
                // decline, and the whole point of the finder is offers that get
                // sent and accepted.
                if (myGain <= 0.15 || theirGain <= 0.15) continue;

                candidates.push({
                    other,
                    give: offer,
                    get: target,
                    myGain,
                    theirGain,
                    jointGain: myGain + theirGain,
                    // Neutral value gap: how lopsided it looks on a market board.
                    neutralGap: target.value - offer.value,
                });
            }
        }
    }

    const shortlist = sortBy(candidates, (c) => c.jointGain, -1).slice(0, stage2Keep);
    if (!shortlist.length) return { ok: true, trades: [], scanned: pairs.length };

    // --- Stage 3: full evaluation with the odds simulation ------------------
    const finalists = shortlist.slice(0, stage3Keep);
    const evaluated = [];

    for (const c of finalists) {
        const result = await evaluateTrade({
            cfg,
            ctx,
            teams,
            rankings,
            schedule,
            iterations,
            offers: [
                { rosterId: myRosterId, sending: [c.give.player.id] },
                { rosterId: c.other.rosterId, sending: [c.get.player.id] },
            ],
        });
        if (!result.ok) continue;

        const mySide = result.sides.find((s) => s.team.rosterId === myRosterId);
        const theirSide = result.sides.find((s) => s.team.rosterId === c.other.rosterId);

        evaluated.push({
            ...c,
            result,
            mySide,
            theirSide,
            myPlayoffDelta: mySide?.playoffDelta ?? null,
            myTitleDelta: mySide?.titleDelta ?? null,
            // Reported on the neutral board, because it is the answer to
            // "will they say yes", not "do I like it".
            theirPlayoffDelta: theirSide?.playoffDelta ?? null,
            theirTitleDelta: theirSide?.titleDelta ?? null,
            posture: postureOf(playoffOdds?.get(c.other.rosterId)),
        });
    }

    // A deal that lowers my odds is not a deal I want, however much the other
    // side likes it. Lineup points can rise while odds fall -- giving up depth
    // that mattered in a specific week, for instance -- and the odds are the
    // number that actually decides the season.
    const worthSending = evaluated.filter((e) => {
        if (e.myTitleDelta === null && e.myPlayoffDelta === null) return true;
        const title = e.myTitleDelta ?? 0;
        const playoff = e.myPlayoffDelta ?? 0;
        return title >= -0.0005 && playoff >= -0.0005;
    });

    const ranked = sortBy(
        worthSending,
        (e) => (e.myTitleDelta ?? 0) * 2 + (e.myPlayoffDelta ?? 0) + e.myGain / 40,
        -1
    );

    return {
        ok: true,
        trades: ranked,
        scanned: pairs.length,
        shortlisted: shortlist.length,
        rejected: evaluated.length - worthSending.length,
    };
}

/**
 * Whether a counterparty should be buying or selling. A team at 8% has every
 * reason to move win-now pieces; a team at 90% is shopping for them. Filtering
 * on this is the difference between a plausible suggestion and one that gets a
 * reply.
 */
export function postureOf(playoffOdds) {
    if (playoffOdds === null || playoffOdds === undefined) return null;
    if (playoffOdds < 0.15) return { kind: 'seller', label: 'Selling', detail: `${Math.round(playoffOdds * 100)}% to make the playoffs — they should be trading away win-now pieces.` };
    if (playoffOdds > 0.75) return { kind: 'buyer', label: 'Buying', detail: `${Math.round(playoffOdds * 100)}% to make the playoffs — they are shopping for upgrades.` };
    return { kind: 'bubble', label: 'On the bubble', detail: `${Math.round(playoffOdds * 100)}% to make the playoffs — they could go either way.` };
}

/** One sentence framing whether the other side should say yes. */
export function acceptanceNote(trade, theirName) {
    const bits = [`${theirName} gain ${trade.theirGain.toFixed(1)} pts/wk on neutral values`];
    if (trade.theirPlayoffDelta !== null && Math.abs(trade.theirPlayoffDelta) >= 0.005) {
        bits.push(`${trade.theirPlayoffDelta >= 0 ? '+' : ''}${(trade.theirPlayoffDelta * 100).toFixed(1)}% playoff odds`);
    }
    return `${bits.join(' and ')}.`;
}
