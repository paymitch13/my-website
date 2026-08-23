// Roster needs and surpluses.
//
// Extracted from the power rankings, where it was a private helper, because the
// trade finder needs exactly the same numbers: which positions is a team weak
// at, and which does it have more of than it can start.
//
// Surplus is deliberately NOT "few starting points". A team with three startable
// running backs and one flex spot has surplus at running back even when its
// starting production looks fine -- the third back is worth more to somebody
// else than he is on their bench. That is measured with bench depth relative to
// how much the position would actually lose if the top man vanished.

import { mean, sortBy } from './util.js';
import { optimizeLineup, positionalReport } from './lineup.js';

export const NEED_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * League-wide reference points: average starting production at each position.
 *
 * @param {Array} reports [{ rosterId, report }] from positionalReport
 */
export function leagueAverages(reports, positions = NEED_POSITIONS) {
    const avg = {};
    for (const pos of positions) {
        avg[pos] = mean(reports.map((r) => r.report.byPosition[pos]?.startingPoints ?? 0));
    }
    return avg;
}

/**
 * Average production PER STARTING SLOT at each position. Comparing raw totals
 * punishes a team purely for its lineup shape -- put a running back in the flex
 * and you have two starting receivers where everyone else has three, which
 * looks like a receiver hole and is not one.
 */
export function leaguePerSlotAverages(reports, positions = NEED_POSITIONS) {
    const avg = {};
    for (const pos of positions) {
        const vals = reports
            .map((r) => r.report.byPosition[pos])
            .filter((v) => v && v.starting > 0)
            .map((v) => v.startingPerSlot ?? v.startingPoints / Math.max(1, v.starting));
        avg[pos] = vals.length ? mean(vals) : 0;
    }
    return avg;
}

/**
 * Average of each team's BEST player at a position. The reference point for
 * "do they own a piece worth prying loose", which is a different question from
 * "do they score well there" and the one that same-position trades turn on.
 */
export function leagueBestAverages(reports, positions = NEED_POSITIONS) {
    const avg = {};
    for (const pos of positions) {
        avg[pos] = mean(reports.map((r) => r.report.byPosition[pos]?.bestPoints ?? 0));
    }
    return avg;
}

/**
 * Average of each team's WEAKEST starter at a position -- the league's typical
 * WR2, RB2, and so on. The reference point for "is there a hole in the lineup",
 * which the per-slot mean hides whenever a room is top-heavy.
 */
export function leagueWeakStarterAverages(reports, positions = NEED_POSITIONS) {
    const avg = {};
    for (const pos of positions) {
        const vals = reports
            .map((r) => r.report.byPosition[pos])
            .filter((v) => v && v.starting > 0)
            .map((v) => v.weakStarterPoints ?? 0);
        avg[pos] = vals.length ? mean(vals) : 0;
    }
    return avg;
}

/**
 * Per-position need and surplus for one roster.
 *
 * `deficit` is starting points below the league average at that position:
 * positive means they are short there.
 *
 * `surplus` is the value sitting behind the starters that the lineup cannot
 * use, scaled by how replaceable the position is.
 */
export function rosterNeeds(
    report,
    avgByPos,
    positions = NEED_POSITIONS,
    { perSlotAvg = null, bestAvg = null, weakAvg = null } = {}
) {
    const out = {};
    for (const pos of positions) {
        const v = report.byPosition[pos];
        if (!v) continue;

        // Measure the hole per starting slot where we can, so a different
        // lineup shape does not masquerade as a deficit.
        const perSlot = v.startingPerSlot ?? (v.startingPoints ?? 0) / Math.max(1, v.starting || 1);
        const deficit = perSlotAvg && v.starting > 0
            ? ((perSlotAvg[pos] ?? 0) - perSlot) * Math.max(1, v.starting)
            : (avgByPos[pos] ?? 0) - (v.startingPoints ?? 0);

        // Surplus is bench value ABOVE REPLACEMENT, not absolute bench scoring.
        // Two backup quarterbacks out-score spare running backs and are worth
        // nothing, because their production is free on waivers.
        const depth = v.benchAboveReplacement ?? v.benchDepth ?? 0;
        const dropoff = v.dropoff ?? 0;
        const surplus = Math.max(0, depth - dropoff * 0.5);

        // Production per starting slot above the league's, which is a
        // different thing from spare bodies. A team whose receiver room is one
        // superstar and two spares has no bench surplus at receiver and is
        // still the obvious place to buy one -- they will sell quality for
        // quantity, which is exactly what a consolidation trade is.
        const strength = perSlotAvg && v.starting > 0 ? perSlot - (perSlotAvg[pos] ?? 0) : 0;

        // How far the best player in the room sits above the typical best in
        // the league. This is what "my WR3 for your WR1" is actually about:
        // the buyer is not short of receivers, he is short of a good one, and
        // the seller has one to price. A room can be average in total and
        // still be the only place in the league to get an elite piece.
        const bestPoints = v.bestPoints ?? v.best?.score ?? 0;
        const topEdge = bestAvg ? bestPoints - (bestAvg[pos] ?? 0) : 0;

        // The hole in the lineup, as opposed to the hole in the average. A
        // roster whose WR1 is a monster and whose WR2 is a waiver body has no
        // per-slot deficit at all -- the star covers for the hole in the mean
        // -- and is nonetheless shopping for a receiver, which is the whole
        // reason same-position trades happen.
        const weakStarter = v.weakStarterPoints ?? 0;
        const slotDeficit = weakAvg && v.starting > 0 ? (weakAvg[pos] ?? 0) - weakStarter : 0;

        out[pos] = {
            pos,
            startingPoints: v.startingPoints ?? 0,
            perSlot,
            deficit,
            strength,
            bestPoints,
            topEdge,
            weakStarter,
            slotDeficit,
            surplus,
            rostered: v.count ?? 0,
            starting: v.starting ?? 0,
            dropoff,
            benchDepth: depth,
        };
    }
    return out;
}

/**
 * Build the whole league's need/surplus table in one pass.
 *
 * @returns {Map<number, {report, needs, lineup}>}
 */
export function buildLeagueNeeds({ teams, entriesFor, cfg, replacementPpg = null }) {
    const reports = teams.map((team) => {
        const entries = entriesFor(team);
        return {
            rosterId: team.rosterId,
            team,
            entries,
            lineup: optimizeLineup(entries, cfg.starterSlots),
            report: positionalReport(entries, cfg.starterSlots, NEED_POSITIONS, { replacementPpg }),
        };
    });

    const avgByPos = leagueAverages(reports);
    const perSlotAvg = leaguePerSlotAverages(reports);
    const bestAvg = leagueBestAverages(reports);
    const weakAvg = leagueWeakStarterAverages(reports);
    const byRoster = new Map();
    for (const r of reports) {
        byRoster.set(r.rosterId, {
            ...r,
            needs: rosterNeeds(r.report, avgByPos, NEED_POSITIONS, { perSlotAvg, bestAvg, weakAvg }),
        });
    }
    // A plain object, not a property bolted onto a Map: that survives cloning,
    // shows up in iteration and does not vanish in a refactor.
    return { byRoster, avgByPos, perSlotAvg, bestAvg, weakAvg };
}

/**
 * Positions where `buyer` is short and `seller` has spare bodies. This is the
 * cheap filter that removes most of the search space before any lineup solving
 * happens.
 */
/**
 * Positions where the buyer is short and the seller has something to give.
 *
 * "Something to give" is three different situations, and matching only the
 * first of them silently forbids the two most valuable trade shapes there are:
 *
 *   surplus   spare bodies the lineup cannot use -- the classic depth trade.
 *   strength  above-average production per slot, even with a bare bench. This
 *             is the team that will move a star for two starters, because
 *             quantity is what they are missing.
 *   star      one player well above the league's typical best at the position.
 *             This is the only one of the three that can fire when BOTH teams
 *             are short at a position, which is exactly the situation "my WR3
 *             for your WR1" describes: neither room is good, but only one of
 *             them contains somebody worth having.
 */
export function matchingPositions(
    buyer,
    seller,
    { minDeficit = 0.75, minSurplus = 0.75, minStrength = 1.5, minTopEdge = 2.5, minSlotDeficit = 2 } = {}
) {
    const hits = [];
    for (const pos of NEED_POSITIONS) {
        const need = buyer.needs[pos];
        const have = seller.needs[pos];
        if (!need || !have) continue;

        // Short on average, or short in one starting slot. The second is the
        // reason a team with a stud receiver still answers a receiver offer.
        const wants =
            need.deficit >= minDeficit || (need.slotDeficit ?? 0) >= minSlotDeficit;
        if (!wants) continue;

        const surplus = have.surplus ?? 0;
        const strength = have.strength ?? 0;
        const topEdge = have.topEdge ?? 0;

        const bySurplus = surplus >= minSurplus;
        const byStrength = strength >= minStrength;
        const byStar = topEdge >= minTopEdge;
        if (!bySurplus && !byStrength && !byStar) continue;

        const gap = Math.max(need.deficit, need.slotDeficit ?? 0);
        hits.push({
            pos,
            deficit: need.deficit,
            slotDeficit: need.slotDeficit ?? 0,
            surplus,
            strength,
            topEdge,
            via: bySurplus ? 'surplus' : byStrength ? 'strength' : 'star',
            score: gap + Math.max(surplus, strength, topEdge),
        });
    }
    return sortBy(hits, (h) => h.score, -1);
}

/**
 * Positions worth exploring between two teams that have no hard need/surplus
 * match at all.
 *
 * Absolute need is not the only reason to trade, and treating it as one has an
 * ugly failure mode: the best roster in the league is above average everywhere,
 * so it registers no deficit anywhere, so the finder tells the team most able
 * to make a deal that no deal exists. Every roster is nonetheless weakest at
 * SOMETHING relative to its own baseline, and that is what consolidation
 * trades run on.
 *
 * Measured against each team's own average edge, so it says nothing about
 * whether the trade is good -- stage 2's mutual-gain filter decides that. This
 * only decides what is worth looking at.
 */
export function relativeMatches(buyer, seller, limit = 2) {
    const rows = [];
    for (const pos of NEED_POSITIONS) {
        const need = buyer.needs[pos];
        const have = seller.needs[pos];
        if (need && have) rows.push({ pos, need, have });
    }
    if (rows.length < 2) return [];

    const buyerMean = mean(rows.map((r) => r.need.strength ?? 0));
    const sellerMean = mean(rows.map((r) => r.have.strength ?? 0));

    const hits = rows
        .map((r) => ({
            pos: r.pos,
            deficit: r.need.deficit,
            slotDeficit: r.need.slotDeficit ?? 0,
            surplus: r.have.surplus ?? 0,
            strength: r.have.strength ?? 0,
            topEdge: r.have.topEdge ?? 0,
            via: 'relative',
            // Weak for the buyer by its own standards, strong for the seller by
            // its own -- the two halves of a trade both sides can rationalize.
            score: (buyerMean - (r.need.strength ?? 0)) + ((r.have.strength ?? 0) - sellerMean),
        }))
        .filter((h) => h.score > 0.25);

    return sortBy(hits, (h) => h.score, -1).slice(0, limit);
}

/** The single position a roster most needs help at, for display. */
export function biggestNeed(entry) {
    const rows = Object.values(entry.needs || {});
    return rows.length ? sortBy(rows, (r) => r.deficit, -1)[0] : null;
}

/** The position a roster can most afford to trade from. */
export function biggestSurplus(entry) {
    const rows = Object.values(entry.needs || {});
    return rows.length ? sortBy(rows, (r) => r.surplus, -1)[0] : null;
}
