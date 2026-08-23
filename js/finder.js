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

import { buildEntries, buildNeutralEntries, evaluateTrade, createEvalCache } from './trade.js';
import { optimizeLineup } from './lineup.js';
import { buildLeagueNeeds, matchingPositions, relativeMatches, biggestNeed, biggestSurplus } from './needs.js';
import { sortBy, sum } from './util.js';

const TRADEABLE = new Set(['QB', 'RB', 'WR', 'TE']);

/** Identity of a candidate: who, and exactly which players each way. */
const packageKey = (c) =>
    `${c.other.rosterId}:${c.gives.map((e) => e.player.id).sort().join('+')}` +
    `>${c.gets.map((e) => e.player.id).sort().join('+')}`;

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

    // Generous by default: the funnel exists to make the search affordable, not
    // to hide what it found. Everything that survives stage 2 is returned; only
    // the top slice gets the expensive odds simulation.
    const { stage2Keep = 150, stage3Keep = 25 } = limits;
    const { requireMutualGain = true, minGain = 0.05 } = input;

    const me = teams.find((t) => t.rosterId === myRosterId);
    if (!me) return { ok: false, error: 'Unknown roster.' };
    const others = teams.filter((t) => t.rosterId !== myRosterId);

    // --- Stage 1: need and surplus -----------------------------------------
    // My roster is judged on my board (it is my opinion that matters for what I
    // want); every other roster is judged neutrally (their opinion is not mine).
    // One valuation policy, used by every stage: my roster on my board, every
    // other roster on the neutral board.
    const entriesFor = (team) =>
        team.rosterId === myRosterId
            ? buildEntries(team.players, rankings, ctx)
            : buildNeutralEntries(team.players, ctx);

    const { byRoster: needsMap } = buildLeagueNeeds({
        teams,
        cfg,
        entriesFor,
        replacementPpg: ctx.replacementPpg,
    });

    const mine = needsMap.get(myRosterId);
    const pairs = [];

    for (const other of others) {
        const theirs = needsMap.get(other.rosterId);
        if (!theirs) continue;

        // What I need that they can spare, and what they need that I can spare.
        // Falling back to relative shape when there is no absolute match is
        // what keeps a strong roster -- above average everywhere, short of
        // nothing -- from being told that no trade in the league exists. It
        // only widens what gets LOOKED at; stage 2 still has to find a deal
        // that improves both lineups before anything is proposed.
        const iWant = orRelative(matchingPositions(mine, theirs), mine, theirs);
        const theyWant = orRelative(matchingPositions(theirs, mine), theirs, mine);
        if (!iWant.length || !theyWant.length) continue;

        for (const want of iWant.slice(0, 4)) {
            for (const give of theyWant.slice(0, 4)) {
                // Same-position deals are the most common shape there is --
                // my WR3 plus a piece for your WR1 -- and were forbidden
                // outright. They are allowed now; stage 2's mutual-gain filter
                // is what decides whether they are any good.
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

        for (const target of sortBy(targets, (e) => e.value, -1).slice(0, 8)) {
            for (const offer of sortBy(offers, (e) => e.value, -1).slice(0, 8)) {
                if (offer.player.id === target.player.id) continue;

                // 1-for-1
                const solo = consider([offer], [target]);

                // 2-for-1 consolidation: two of my pieces for one of theirs.
                // This is the trade that wins leagues, and the value model was
                // built to price it -- the convex curve exists precisely so a
                // stud beats two good players -- but the search could not
                // produce one. The second piece comes from my surplus.
                if (target.value > offer.value * 1.15) {
                    for (const second of sweeteners(mine.entries, [offer, target], 5)) {
                        // The extra piece has to buy something. A second player
                        // who leaves their lineup exactly where the one-for-one
                        // left it is a player given away for nothing, and the
                        // search was proposing five of those in a row above the
                        // deal they were variations of.
                        consider([offer, second], [target], solo);
                    }
                }
            }
        }

        /** Extra pieces I can most afford to include, cheapest useful first. */
        function sweeteners(entries, exclude, limit) {
            const skip = new Set(exclude.map((e) => e.player.id));
            return sortBy(
                entries.filter(
                    (e) => !skip.has(e.player.id) && TRADEABLE.has(e.player.pos) && e.value > 0
                ),
                (e) => e.value
            ).slice(0, limit);
        }

        /**
         * Solve both lineups for one candidate package and keep it if it works.
         * Returns the gains either way, so a bigger package can be measured
         * against the smaller one it is built on.
         */
        function consider(giveEntries, getEntries, mustBeat = null) {
            const giveIds = new Set(giveEntries.map((e) => e.player.id));
            const getIds = new Set(getEntries.map((e) => e.player.id));

            const myAfter = optimizeLineup(
                [...mine.entries.filter((e) => !giveIds.has(e.player.id)), ...getEntries],
                cfg.starterSlots
            ).points;
            const theirAfter = optimizeLineup(
                [...theirs.entries.filter((e) => !getIds.has(e.player.id)), ...giveEntries],
                cfg.starterSlots
            ).points;

            const myGain = myAfter - myBase;
            const theirGain = theirAfter - theirBase;
            const gains = { myGain, theirGain };

            if (myGain <= minGain) return gains;
            if (requireMutualGain && theirGain <= minGain) return gains;
            if (mustBeat && theirGain <= mustBeat.theirGain + minGain) return gains;

            candidates.push({
                other,
                // Kept as arrays throughout so multi-player packages are a
                // first-class shape rather than a special case.
                gives: giveEntries,
                gets: getEntries,
                give: giveEntries[0],
                get: getEntries[0],
                myGain,
                theirGain,
                // Why this partner: the shape of their roster, so a card can
                // say "thin at RB, deep at WR" instead of asking the reader to
                // take the pairing on faith.
                theirNeed: biggestNeed(theirs),
                theirSurplus: biggestSurplus(theirs),
                jointGain: myGain + theirGain,
                neutralGap: sum(getEntries, (e) => e.value) - sum(giveEntries, (e) => e.value),
                mutual: theirGain > minGain,
            });
            return gains;
        }
    }

    // Deduplicate: identical packages can surface from several position
    // pairings.
    const seen = new Set();
    const unique = [];
    for (const c of sortBy(candidates, (x) => x.jointGain, -1)) {
        const key = packageKey(c);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(c);
    }

    const shortlist = unique.slice(0, stage2Keep);
    if (!shortlist.length) {
        // Same shape whether or not anything was found, so callers never have
        // to guard for missing fields.
        return { ok: true, trades: [], others: [], scanned: pairs.length, shortlisted: 0, simulated: 0, rejected: 0 };
    }

    // --- Stage 3: full evaluation with the odds simulation ------------------
    const finalists = shortlist.slice(0, stage3Keep);
    const evaluated = [];

    // One cache for the whole search: the untouched league is simulated once
    // instead of once per candidate, and every roster the deal does not touch
    // is solved once instead of fifty times.
    const cache = createEvalCache();

    for (const c of finalists) {
        const result = await evaluateTrade({
            cache,
            cfg,
            ctx,
            teams,
            rankings,
            schedule,
            iterations,
            // Stage 3 must use the same board as stages 1 and 2, or the
            // acceptance numbers on a single card come from two different
            // yardsticks and can point opposite ways.
            entriesFor,
            offers: [
                { rosterId: myRosterId, sending: c.gives.map((e) => e.player.id) },
                { rosterId: c.other.rosterId, sending: c.gets.map((e) => e.player.id) },
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

    // Everything the simulation rejected, plus everything past the stage-3 cut,
    // is still shown -- with lineup numbers rather than odds, and labelled as
    // such. Reporting "9 found" and rendering one was the wrong trade-off.
    const simulatedKeys = new Set(finalists.map(packageKey));
    const alsoPossible = [
        ...evaluated.filter((e) => !worthSending.includes(e)).map((e) => ({ ...e, reason: 'lowers-odds' })),
        ...shortlist
            .filter((c) => !simulatedKeys.has(packageKey(c)))
            .map((c) => ({ ...c, reason: 'not-simulated' })),
    ];

    return {
        ok: true,
        trades: ranked,
        others: sortBy(alsoPossible, (o) => o.myGain, -1),
        scanned: pairs.length,
        shortlisted: shortlist.length,
        simulated: evaluated.length,
        rejected: evaluated.length - worthSending.length,
    };
}

/**
 * Hard need/surplus matches first, then relative shape for any position they
 * did not already cover. Appending rather than replacing means a strong roster
 * still gets its obvious deals ranked ahead of its speculative ones, and a team
 * with one hard match is not limited to that single position.
 */
function orRelative(hits, buyer, seller) {
    const covered = new Set(hits.map((h) => h.pos));
    return [...hits, ...relativeMatches(buyer, seller, 3).filter((h) => !covered.has(h.pos))];
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
