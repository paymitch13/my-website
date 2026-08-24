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
 * @param {Array}  [input.want]       player ids I am trying to acquire. Pins the
 *   counterparty to whoever owns them and every package to include them, which
 *   turns the search from "find me a deal" into "what would this cost".
 * @param {Array}  [input.offer]      player ids I am willing to send. Every
 *   package includes them; the search fills in the rest.
 * @param {object} [input.limits]
 */
export async function findTrades(input) {
    const {
        cfg, ctx, teams, myRosterId, rankings, schedule = null,
        playoffOdds = null, iterations = 1200,
        want = [], offer = [],
        limits = {},
    } = input;

    // Generous by default: the funnel exists to make the search affordable, not
    // to hide what it found. Everything that survives stage 2 is returned; only
    // the top slice gets the expensive odds simulation.
    const { stage2Keep = 150, stage3Keep = 25, maxPieces = 3 } = limits;
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

    // --- Named players ------------------------------------------------------
    // A target changes what the search IS. Instead of inferring what I need
    // from roster shape, I have declared it, so stage 1's whole job -- guessing
    // which positions two teams might match on -- is skipped for that
    // counterparty. Nobody wants to be told their target is unavailable because
    // a need heuristic did not pick that position.
    const named = resolveNamed({ want, offer, mine, needsMap, others, myRosterId });
    if (named.error) return { ok: false, error: named.error };

    const { wantEntries, offerEntries, targetTeam, targetNeeds } = named;
    const targeted = wantEntries.length > 0;
    const shopping = offerEntries.length > 0;

    const pairs = [];
    if (targeted) {
        // One counterparty, no position filter: they own the player.
        pairs.push({ other: targetTeam, theirs: targetNeeds, score: Infinity, pinned: true });
    } else {
        for (const other of others) {
            const theirs = needsMap.get(other.rosterId);
            if (!theirs) continue;

            // What I need that they can spare, and what they need that I can
            // spare. Falling back to relative shape when there is no absolute
            // match is what keeps a strong roster -- above average everywhere,
            // short of nothing -- from being told that no trade in the league
            // exists. It only widens what gets LOOKED at; stage 2 still has to
            // find a deal that improves both lineups before anything is
            // proposed.
            const iWant = orRelative(matchingPositions(mine, theirs), mine, theirs);
            const theyWant = orRelative(matchingPositions(theirs, mine), theirs, mine);
            if (!iWant.length || !theyWant.length) continue;

            for (const wantPos of iWant.slice(0, 4)) {
                for (const givePos of theyWant.slice(0, 4)) {
                    // Same-position deals are the most common shape there is --
                    // my WR3 plus a piece for your WR1 -- and were forbidden
                    // outright. They are allowed now; stage 2's mutual-gain
                    // filter is what decides whether they are any good.
                    pairs.push({
                        other,
                        theirs,
                        wantPos: wantPos.pos,
                        givePos: givePos.pos,
                        score: wantPos.score + givePos.score,
                    });
                }
            }
        }
    }

    // --- Stage 2: lineup solve, both directions ----------------------------
    const candidates = [];
    const myBase = mine.lineup.points;
    const forcedGiveIds = new Set(offerEntries.map((e) => e.player.id));

    /**
     * Solve both lineups for one candidate package and keep it if it works.
     * Returns the gains either way, so a bigger package can be measured against
     * the smaller one it is built on.
     */
    function consider({ other, theirs, gives, gets, mustBeat = null, mustBeatMine = null, pinned = false }) {
        const giveIds = new Set(gives.map((e) => e.player.id));
        const getIds = new Set(gets.map((e) => e.player.id));
        // A package that sends and receives the same man is not a package.
        for (const id of getIds) if (giveIds.has(id)) return null;

        const myAfter = optimizeLineup(
            [...mine.entries.filter((e) => !giveIds.has(e.player.id)), ...gets],
            cfg.starterSlots
        ).points;
        const theirAfter = optimizeLineup(
            [...theirs.entries.filter((e) => !getIds.has(e.player.id)), ...gives],
            cfg.starterSlots
        ).points;

        const myGain = myAfter - myBase;
        const theirGain = theirAfter - theirBaseOf(theirs);
        const gains = { myGain, theirGain };

        // A named target is a declared want. "This costs you 1.2 points a week
        // of lineup" is the ANSWER to what it would take, not a reason to hide
        // the offer -- so the my-gain gate is dropped and the cost is reported.
        if (!pinned && myGain <= minGain) return gains;
        if (requireMutualGain && theirGain <= minGain) return gains;
        // A bigger package has to buy something, on whichever side grew. An
        // extra piece that leaves the lineup exactly where the smaller version
        // left it is a body moved for nothing, and listing four of those above
        // the deal they are variations of is worse than not finding them.
        if (mustBeat && theirGain <= mustBeat.theirGain + minGain) return gains;
        if (mustBeatMine && myGain <= mustBeatMine.myGain + minGain) return gains;

        candidates.push({
            other,
            // Kept as arrays throughout so multi-player packages are a
            // first-class shape rather than a special case.
            gives,
            gets,
            give: gives[0],
            get: gets[0],
            myGain,
            theirGain,
            // Why this partner: the shape of their roster, so a card can say
            // "thin at RB, deep at WR" instead of asking the reader to take the
            // pairing on faith.
            theirNeed: biggestNeed(theirs),
            theirSurplus: biggestSurplus(theirs),
            jointGain: myGain + theirGain,
            neutralGap: sum(gets, (e) => e.value) - sum(gives, (e) => e.value),
            mutual: theirGain > minGain,
            pinned,
        });
        return gains;
    }

    const baseCache = new Map();
    function theirBaseOf(theirs) {
        if (!baseCache.has(theirs)) baseCache.set(theirs, theirs.lineup.points);
        return baseCache.get(theirs);
    }

    for (const pair of sortBy(pairs, (p) => p.score, -1)) {
        const { other, theirs } = pair;

        if (targeted) {
            searchForTarget(other, theirs);
            continue;
        }

        // What I can send: pinned to the named players when there are any, so
        // "here is my trade bait, what can I get" is answered with offers that
        // actually contain the bait.
        const offers = shopping
            ? offerEntries
            : mine.entries.filter((e) => e.player.pos === pair.givePos && TRADEABLE.has(e.player.pos));
        const targets = theirs.entries.filter(
            (e) =>
                TRADEABLE.has(e.player.pos) &&
                (shopping || e.player.pos === pair.wantPos)
        );
        if (!targets.length || !offers.length) continue;

        if (shopping) {
            // The give side is settled, so the search is over what comes back.
            for (const target of sortBy(targets, (e) => e.value, -1).slice(0, 10)) {
                const solo = consider({ other, theirs, gives: offerEntries, gets: [target] });

                // One good player back is not the only answer to "what can I
                // get for him". Two starters for one stud is the same
                // consolidation trade read from the other end, and a team
                // shopping a star is often the team that wants quantity.
                if (solo && sum(offerEntries, (e) => e.value) > target.value * 1.15) {
                    for (const second of cheapest(theirs.entries, [target], 4)) {
                        consider({
                            other, theirs, gives: offerEntries, gets: [target, second],
                            mustBeatMine: solo,
                        });
                    }
                }
            }
            continue;
        }

        for (const target of sortBy(targets, (e) => e.value, -1).slice(0, 8)) {
            for (const give of sortBy(offers, (e) => e.value, -1).slice(0, 8)) {
                if (give.player.id === target.player.id) continue;

                // 1-for-1
                const solo = consider({ other, theirs, gives: [give], gets: [target] });

                // 2-for-1 consolidation: two of my pieces for one of theirs.
                // This is the trade that wins leagues, and the value model was
                // built to price it -- the convex curve exists precisely so a
                // stud beats two good players -- but the search could not
                // produce one. The second piece comes from my surplus.
                if (target.value > give.value * 1.15) {
                    for (const second of cheapest(mine.entries, [give, target], 5)) {
                        // The extra piece has to buy something. A second player
                        // who leaves their lineup exactly where the one-for-one
                        // left it is a player given away for nothing, and the
                        // search was proposing five of those in a row above the
                        // deal they were variations of.
                        consider({ other, theirs, gives: [give, second], gets: [target], mustBeat: solo });
                    }
                }
            }
        }
    }

    /**
     * What it would take to pry a named player loose.
     *
     * This is a different question from "find me a deal", and it wants a
     * different search: the return is fixed, so the whole job is building the
     * cheapest package of MY players that gets them to yes. Packages are
     * enumerated rather than grown greedily, because the cheapest acceptable
     * offer is often not the one built from my most obvious trade chip.
     */
    function searchForTarget(other, theirs) {
        const pool = sortBy(
            mine.entries.filter(
                (e) =>
                    TRADEABLE.has(e.player.pos) &&
                    !forcedGiveIds.has(e.player.id) &&
                    e.value > 0
            ),
            (e) => e.value,
            -1
        ).slice(0, 12);

        const targetValue = sum(wantEntries, (e) => e.value);

        // Minimal packages only.
        //
        // Losing a player can never RAISE my optimal lineup, so any superset of
        // an offer they have already accepted costs me more and buys me
        // nothing -- it is strictly dominated. Enumerating subsets without
        // pruning them produced four versions of the same deal, identical in
        // both gain columns, with the extra bodies thrown in for free. Since
        // packages are visited smallest first, an accepted set can prune every
        // superset that follows it.
        const accepted = [];
        const dominated = (ids) => accepted.some((set) => [...set].every((id) => ids.has(id)));

        for (const gives of packagesOf(pool, offerEntries, maxPieces)) {
            const ids = new Set(gives.map((e) => e.player.id));
            if (dominated(ids)) continue;

            const solo = consider({ other, theirs, gives, gets: wantEntries, pinned: true });
            if (!solo) continue;
            if (solo.theirGain > minGain) accepted.push(ids);

            // Overpaying badly is a signal, not a result. If my package is
            // worth far more than the man I am chasing, the realistic version
            // of the deal has something coming back the other way.
            if (sum(gives, (e) => e.value) > targetValue * 1.2) {
                for (const filler of cheapest(theirs.entries, wantEntries, 3)) {
                    consider({
                        other, theirs, gives, gets: [...wantEntries, filler],
                        pinned: true, mustBeatMine: solo,
                    });
                }
            }
        }
    }

    // Deduplicate: identical packages can surface from several position
    // pairings.
    const seen = new Set();
    const unique = [];
    for (const c of sortBy(candidates, (x) => (targeted ? x.myGain : x.jointGain), -1)) {
        const key = packageKey(c);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(c);
    }

    const shortlist = unique.slice(0, stage2Keep);
    if (!shortlist.length) {
        // Same shape whether or not anything was found, so callers never have
        // to guard for missing fields.
        return {
            ok: true,
            trades: [],
            others: [],
            scanned: pairs.length,
            shortlisted: 0,
            simulated: 0,
            rejected: 0,
            mode: modeOf(targeted, shopping),
            want: wantEntries,
            offer: offerEntries,
        };
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
    //
    // A NAMED TARGET is exempt. Asking what a player would cost and being shown
    // nothing because every version of the deal costs something is not an
    // answer; the cost is the answer, and it is reported on every card.
    const worthSending = targeted
        ? evaluated
        : evaluated.filter((e) => {
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
        mode: modeOf(targeted, shopping),
        want: wantEntries,
        offer: offerEntries,
    };
}

const modeOf = (targeted, shopping) =>
    targeted && shopping ? 'target+offer' : targeted ? 'target' : shopping ? 'offer' : 'open';

/** The pieces I can most afford to add, cheapest useful first. */
function cheapest(entries, exclude, limit) {
    const skip = new Set(exclude.map((e) => e.player.id));
    return sortBy(
        entries.filter((e) => !skip.has(e.player.id) && TRADEABLE.has(e.player.pos) && e.value > 0),
        (e) => e.value
    ).slice(0, limit);
}

/**
 * Every package of up to `max` pieces drawn from `pool`, always containing
 * `forced`.
 *
 * Enumerated rather than grown greedily. The cheapest package a counterparty
 * will accept is frequently not the one built outward from my most obvious
 * trade chip -- two mid-round pieces they can start often beat one better
 * player they cannot -- and a greedy walk never sees that.
 */
export function packagesOf(pool, forced = [], max = 3) {
    const base = [...forced];
    const slots = Math.max(0, max - base.length);
    const out = [];
    if (base.length) out.push(base);

    const walk = (start, current) => {
        if (current.length) out.push([...base, ...current]);
        if (current.length >= slots) return;
        for (let i = start; i < pool.length; i++) walk(i + 1, [...current, pool[i]]);
    };
    if (slots > 0) walk(0, []);

    // Smallest first. Callers prune supersets of an offer that already worked,
    // and that pruning is only correct if the smaller one was seen first.
    return sortBy(out, (p) => p.length);
}

/**
 * Turn the player ids a user typed into entries, and refuse the combinations
 * that cannot mean anything.
 *
 * Every failure here is a sentence a person can act on. "Unknown player" tells
 * nobody anything; "you already have him" and "that would be a three-team
 * trade" tell them exactly what to change.
 */
function resolveNamed({ want, offer, mine, needsMap, others, myRosterId }) {
    const offerEntries = [];
    for (const id of offer || []) {
        const entry = mine.entries.find((e) => e.player.id === id);
        if (!entry) return { error: 'You can only offer players on your own roster.' };
        offerEntries.push(entry);
    }

    if (!want?.length) return { wantEntries: [], offerEntries };

    const owners = new Map();
    const wantEntries = [];
    for (const id of want) {
        if (mine.entries.some((e) => e.player.id === id)) {
            return { error: 'You already have him — pick a player on another roster.' };
        }
        const owner = others.find((t) => t.players.some((p) => p.id === id));
        if (!owner) return { error: 'That player is not on a roster in this league.' };
        const theirs = needsMap.get(owner.rosterId);
        const entry = theirs?.entries.find((e) => e.player.id === id);
        if (!entry) return { error: 'That player could not be valued.' };
        owners.set(owner.rosterId, owner);
        wantEntries.push(entry);
    }

    if (owners.size > 1) {
        return { error: 'Those players are on different rosters, which would be a three-team trade.' };
    }

    const targetTeam = [...owners.values()][0];
    return {
        wantEntries,
        offerEntries,
        targetTeam,
        targetNeeds: needsMap.get(targetTeam.rosterId),
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
