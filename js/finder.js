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
// Throughout, the counterparty's roster is valued at MARKET price -- what the
// player actually costs in real leagues -- and never on the user's board.
// Otherwise a player the user happens to rank low looks cheap to pry loose, and
// the whole tool recommends offers nobody would accept. The ledger is market on
// both sides for the same reason: what you think of your own player decides
// whether you want the deal, never whether it is even.

import { buildEntries, buildNeutralEntries, evaluateTrade, createEvalCache, marketPrice } from './trade.js';
import { optimizeLineup } from './lineup.js';
import { buildLeagueNeeds, matchingPositions, relativeMatches, biggestNeed, biggestSurplus } from './needs.js';
import { fairness } from './tradevalue.js';
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
        tradeValue = null,
        limits = {},
    } = input;

    // Player VALUE, on the same market scale the rest of the app shows. Without
    // it the search only ever knew about lineup points, so it would happily
    // propose sending a 6,000 for a 2,400 whenever the 2,400 happened to fit a
    // starting slot better -- a deal nobody would send and the numbers on the
    // card contradicted.
    const scale = typeof tradeValue === 'function' ? tradeValue : (v) => Math.max(0, v);

    // Generous by default: the funnel exists to make the search affordable, not
    // to hide what it found. Everything that survives stage 2 is returned; only
    // the top slice gets the expensive odds simulation.
    const {
        stage2Keep = 150, stage3Keep = 25, maxPieces = 3,
        // How lopsided a deal may be on the value ledger before it stops being
        // worth showing.
        //
        // This used to sit at 30%, on a measurement taken while every position
        // carried its own replacement level -- which inflated cross-positional
        // gaps by about that much on its own. With one replacement line per
        // flex group the ledger means what it says, and 30% is simply a bad
        // trade: it let the search offer a 3,200 back for a 4,800, and the
        // manager on the other end of that offer does not reply.
        //
        // 15% is the width of a real negotiation. Deals inside it read as
        // "close enough, and it fills my hole"; deals outside it read as
        // someone trying it on.
        maxValueGap = 0.15,
        // How far a side may go BACKWARDS on starting points to take a deal
        // that pays them in value. This is the consolidation trade -- two
        // starters for one better one leaves a hole in the flex this week and
        // wins the season -- and without the allowance the search cannot
        // propose one.
        lineupSlack = 0.6,
        // ...and how big that value edge has to be to count as a reason on its
        // own, as a share of the deal. Any edge at all used to qualify, which
        // is how two bench backs for a bench receiver -- fourteen points of
        // value on an eight-hundred-point deal, both lineups unmoved -- ended
        // up on the board as a recommendation.
        minValueEdge = 0.04,
        // How many results may feature the same incoming player. Without this
        // the whole board fills with variations on acquiring one man, because
        // the best available target produces the most acceptable packages.
        perTargetCap = 2,
        perPieceCap = 3,
        perTeamCap = 4,
    } = limits;
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

    // --- Who to talk to -----------------------------------------------------
    //
    // Needs decide the ORDER counterparties are worked through and the sentence
    // a card puts on the pairing. They no longer decide which players get
    // looked at. Enumerating candidates by position and checking the ledger
    // afterwards was backwards: with a real gate on value, almost everything
    // position-matching generated was unaffordable, and the roster with the
    // fewest holes -- the good one, the one most able to trade -- got the
    // fewest candidates. Value comes first now, which is also what the numbers
    // on the cards have always claimed was happening.
    const pairs = [];
    if (targeted) {
        // One counterparty, no filter at all: they own the player.
        pairs.push({ other: targetTeam, theirs: targetNeeds, score: Infinity, pinned: true });
    } else {
        for (const other of others) {
            const theirs = needsMap.get(other.rosterId);
            if (!theirs) continue;
            // Falling back to relative shape when there is no absolute match is
            // what keeps a strong roster -- above average everywhere, short of
            // nothing -- from sorting last behind teams it has no business
            // trading with.
            const iWant = orRelative(matchingPositions(mine, theirs), mine, theirs);
            const theyWant = orRelative(matchingPositions(theirs, mine), theirs, mine);
            const score = (iWant[0]?.score ?? 0) + (theyWant[0]?.score ?? 0);
            pairs.push({ other, theirs, score });
        }
    }

    /** Can these two ledgers possibly clear the gate? */
    const withinLedger = (a, b) => fairness(a, b).gap <= maxValueGap;

    // --- Stage 2: lineup solve, both directions ----------------------------
    const candidates = [];
    let pairings = 0;
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

        // The value ledger, on the market scale the cards print. Scaled rather
        // than raw because the scale is convex on purpose: one stud is worth
        // more than two of half his value, so a consolidation trade reads as
        // fair here and would read as robbery on raw points.
        //
        // Priced at MARKET on both sides. My players used to be priced on my
        // board and theirs on the neutral one, which is two yardsticks in a
        // single fairness number: being higher than the league on my own guy
        // made the ledger say I was giving up more than I was, and the search
        // rejected deals that were fine. What I think of him decides whether I
        // want the trade, never whether it is even.
        const valueIn = sum(gets, (e) => scale(marketPrice(e, ctx)));
        const valueOut = sum(gives, (e) => scale(marketPrice(e, ctx)));
        const split = fairness(valueIn, valueOut);

        // Lopsided on value is lopsided however well it fits a lineup slot.
        // A named target is looser -- the user has declared they want him, and
        // paying over the odds is a legitimate answer to "what would it take"
        // -- but not unbounded, because a 3x overpay is nobody's trade.
        if (split.gap > (pinned ? maxValueGap * 3 : maxValueGap)) return gains;

        // --- Would each manager actually press accept? ----------------------
        //
        // The old test was "both starting lineups go up", and it was wrong in
        // both directions at once. It rejected the majority of real trades --
        // 1,421 of 1,450 candidates in a twelve-team league, because two
        // lineups rarely both improve on points alone -- and the handful that
        // squeezed through were the odd corners where a bad asset happened to
        // fit a slot. A search that thin has nothing left to be selective
        // with, which is how a 3,200-for-4,800 ended up on the board.
        //
        // What a manager actually weighs is two things: the ledger, and the
        // lineup. Value is zero-sum, so somebody is always giving up a little
        // of it -- that side has to be paid in fit, and the side collecting
        // the value has to not be wrecking its Sunday to do it. Each manager
        // therefore needs a reason to say yes on one axis and no reason to say
        // no on the other.
        const material = minValueEdge * Math.max(valueIn, valueOut);
        const accepts = (lineupGain, valueNet) =>
            lineupGain > -lineupSlack && (lineupGain > minGain || valueNet > material);

        // A named target is a declared want. "This costs you 1.2 points a week
        // of lineup" is the ANSWER to what it would take, not a reason to hide
        // the offer -- so my own side of the test is dropped and the cost is
        // reported on the card instead.
        if (!pinned && !accepts(myGain, valueIn - valueOut)) return gains;
        if (requireMutualGain && !accepts(theirGain, valueOut - valueIn)) return gains;
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
            // Kept so a card can print the ledger it was actually judged on.
            valueIn,
            valueOut,
            valueGap: split.gap,
            valueNet: valueIn - valueOut,
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
        const offers = shopping ? offerEntries : tradeablePool(mine.entries, 14);
        const targets = shopping
            ? theirs.entries.filter((e) => TRADEABLE.has(e.player.pos))
            : tradeablePool(theirs.entries, 14);
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

        // One-for-one, but only against the players a manager could plausibly
        // ask for in return. Everything outside the ledger window is skipped
        // before a lineup is ever solved, which is what pays for the wider
        // player pool above.
        for (const give of offers) {
            const gv = scale(give.value);
            pairings++;

            for (const target of targets) {
                if (give.player.id === target.player.id) continue;
                const tv = scale(target.value);

                const solo = withinLedger(tv, gv)
                    ? consider({ other, theirs, gives: [give], gets: [target] })
                    : null;

                // Two-for-one, in both directions. Consolidation is the trade
                // that wins leagues and the convex value curve exists to price
                // it, but the second piece has to be chosen so the ledger
                // lands -- picking "my five cheapest" and hoping was why the
                // search could never build one that survived.
                //
                // Either way the extra body still has to buy something: a
                // second player who leaves the receiving lineup exactly where
                // the one-for-one left it has been given away for nothing.
                if (tv > gv) {
                    for (const second of completing(offers, [give, target], gv, tv, true)) {
                        consider({ other, theirs, gives: [give, second], gets: [target], mustBeat: solo });
                    }
                } else if (gv > tv) {
                    for (const second of completing(targets, [give, target], tv, gv, false)) {
                        consider({ other, theirs, gives: [give], gets: [target, second], mustBeatMine: solo });
                    }
                }
            }
        }
    }

    /**
     * The pieces that would close a ledger gap, cheapest first.
     *
     * `have` is the smaller side of a lopsided one-for-one and `need` the
     * larger; anything that brings `have` into the window without overshooting
     * it is a candidate for the throw-in.
     *
     * The piece has to actually close the gap, not merely land inside the
     * window from the other side of it -- otherwise a package that was already
     * fair gets a body added to make it less fair. Note that it may legitimately
     * cross parity: a fair two-for-one usually costs slightly MORE than the man
     * coming back, because consolidation carries a premium, and demanding the
     * two pieces stay under his price rejects the most ordinary trade there is.
     */
    function completing(pool, exclude, have, need, mine_) {
        const skip = new Set(exclude.map((e) => e.player.id));
        const before = fairness(have, need).gap;
        const out = [];
        for (const e of pool) {
            if (skip.has(e.player.id)) continue;
            const filled = have + scale(e.value);
            if (fairness(filled, need).gap < before && withinLedger(filled, need)) out.push(e);
        }

        // Two different offers are worth making out of the same window, and
        // taking only one end of it loses the other. The piece that lands the
        // ledger closest to even is the offer a manager sends when they want a
        // yes; the piece at the end that favours me -- the least of mine, the
        // most of theirs -- is the one they send when they want a bargain.
        // Slicing the cheapest two alone was quietly dropping the receiver that
        // made the trade and pairing a spare back instead.
        const fairest = sortBy(out, (e) => fairness(have + scale(e.value), need).gap).slice(0, 2);
        const greedy = sortBy(out, (e) => e.value, mine_ ? 1 : -1)[0];
        return greedy && !fairest.includes(greedy) ? [...fairest, greedy] : fairest;
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

    const best = undominated(unique);

    // Spread the board across different players.
    //
    // The best available target generates the most acceptable packages, so an
    // unfiltered top-N is N ways to acquire one man -- which reads as a broken
    // search even though every row is a real trade. A search of the whole
    // league should answer "who can I get", not "here are nine prices for the
    // same guy". Capped per incoming player and per counterparty, then
    // everything else is appended below so nothing is actually lost.
    const diverse = targeted ? best : spread(best, { perTargetCap, perTeamCap, perPieceCap });
    const shortlist = diverse.slice(0, stage2Keep);
    if (!shortlist.length) {
        // Same shape whether or not anything was found, so callers never have
        // to guard for missing fields.
        return {
            ok: true,
            trades: [],
            others: [],
            scanned: targeted ? pairs.length : pairings,
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

    // Ranked by what actually decides a season, then spread again.
    //
    // The stage-2 spread orders what gets SIMULATED; this one orders what gets
    // READ. Without the second pass the odds ranking quietly undoes the first,
    // and the top of the finished board fills back up with one player over and
    // over -- which is the complaint the caps were added to answer.
    const ranked = sortBy(
        worthSending,
        (e) => (e.myTitleDelta ?? 0) * 2 + (e.myPlayoffDelta ?? 0) + e.myGain / 40,
        -1
    );
    const board = targeted ? ranked : spread(ranked, { perTargetCap, perTeamCap, perPieceCap });

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
        trades: board,
        others: targeted
            ? sortBy(alsoPossible, (o) => o.myGain, -1)
            : spread(sortBy(alsoPossible, (o) => o.myGain, -1), { perTargetCap, perTeamCap, perPieceCap }),
        scanned: targeted ? pairs.length : pairings,
        shortlisted: shortlist.length,
        simulated: evaluated.length,
        rejected: evaluated.length - worthSending.length,
        mode: modeOf(targeted, shopping),
        want: wantEntries,
        offer: offerEntries,
    };
}

/**
 * Drop every package that another package beats outright.
 *
 * One deal can be reached from several starting pairings, and the ones reached
 * from a silly pairing arrive with a spare body attached: pair a 168-point
 * backup quarterback against a 4,173 running back, "complete" the ledger with
 * the 3,659 receiver, and out comes the receiver-for-back trade with the backup
 * thrown in for nothing. Six of those, identical in both gain columns, was what
 * the board actually looked like.
 *
 * No arithmetic is needed to reject them. If another live package sends a
 * subset of these players and receives a superset, it is better for me by
 * construction -- fewer of mine leave, no less of theirs arrives -- and the
 * counterparty has already accepted it, or it would not be in the list.
 *
 * The mirror image needs a second pass. Six ways to buy the same tight end,
 * each with a different bench back stapled on for change, are not supersets of
 * one another and none dominates the rest -- but they are one trade, and the
 * honest version of it is the one whose ledger comes closest to even. So
 * packages about the same two players collapse to their best representative.
 */
export function undominated(list) {
    const ids = (side) => new Set(side.map((e) => e.player.id));
    const covers = (a, b) => a.size <= b.size && [...a].every((id) => b.has(id));

    const marked = list.map((c) => ({ c, gives: ids(c.gives), gets: ids(c.gets), size: c.gives.length + c.gets.length }));
    // Smallest first, so a package is only ever compared against ones already
    // known to be minimal.
    const kept = [];
    for (const m of sortBy(marked, (m) => m.size)) {
        const beaten = kept.some(
            (k) =>
                k.c.other.rosterId === m.c.other.rosterId &&
                covers(k.gives, m.gives) &&
                covers(m.gets, k.gets)
        );
        if (!beaten) kept.push(m);
    }

    // One representative per (counterparty, who leaves, who arrives): the deal
    // that helps my lineup most, and among equals the one closest to even.
    const bestOf = new Map();
    for (const { c } of kept) {
        const key = `${c.other.rosterId}:${headline(c.gives)}>${headline(c.gets)}`;
        const held = bestOf.get(key);
        const better =
            !held ||
            c.myGain > held.myGain + 0.05 ||
            (c.myGain > held.myGain - 0.05 && c.valueGap < held.valueGap);
        if (better) bestOf.set(key, c);
    }

    const survivors = new Set(bestOf.values());
    // Back into the caller's order, which carries the ranking.
    return list.filter((c) => survivors.has(c));
}

/**
 * Reorder so the strongest DISTINCT options come first: at most `perTargetCap`
 * ways to acquire the same player, `perTeamCap` deals with the same manager,
 * and `perPieceCap` appearances for any one player on either side of the
 * ledger. Everything over the caps is kept, just demoted -- the caps decide
 * what is seen first, never what exists.
 *
 * The per-piece cap is what stops a board that is technically nine different
 * trades from reading as one trade nine times. Value-matched search makes this
 * worse, not better: the two or three pieces whose price happens to line up
 * against the rest of the league turn up in nearly every affordable package,
 * so without a cap the answer to "who can I get" is nine ways to send the same
 * spare running back.
 */
/** The player a package is actually about: the most valuable piece on a side. */
const headline = (side) =>
    side.reduce((a, b) => (b.value > a.value ? b : a), side[0])?.player.id ?? '';

export function spread(list, { perTargetCap = 2, perTeamCap = 4, perPieceCap = 3 } = {}) {
    const byTarget = new Map();
    const byTeam = new Map();
    const byPiece = new Map();
    const front = [];
    const back = [];

    for (const c of list) {
        // Identity is the headline player, not the exact set. Getting him
        // alone, getting him with a bench back attached, and getting him with a
        // different bench back attached are one acquisition wearing three hats
        // -- and keying on the full set let all three onto the board.
        const targetKey = headline(c.gets);
        const t = (byTarget.get(targetKey) ?? 0) + 1;
        const m = (byTeam.get(c.other.rosterId) ?? 0) + 1;
        const pieces = [...c.gives, ...c.gets].map((e) => e.player.id);
        const overused = pieces.some((id) => (byPiece.get(id) ?? 0) >= perPieceCap);

        if (t <= perTargetCap && m <= perTeamCap && !overused) {
            byTarget.set(targetKey, t);
            byTeam.set(c.other.rosterId, m);
            for (const id of pieces) byPiece.set(id, (byPiece.get(id) ?? 0) + 1);
            front.push(c);
        } else {
            back.push(c);
        }
    }
    return [...front, ...back];
}

const modeOf = (targeted, shopping) =>
    targeted && shopping ? 'target+offer' : targeted ? 'target' : shopping ? 'offer' : 'open';

/** The tradeable players on a roster worth pricing, best first. */
function tradeablePool(entries, limit) {
    return sortBy(
        entries.filter((e) => TRADEABLE.has(e.player.pos) && e.value > 0),
        (e) => e.value,
        -1
    ).slice(0, limit);
}

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
