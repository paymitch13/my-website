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
 * Per-position need and surplus for one roster.
 *
 * `deficit` is starting points below the league average at that position:
 * positive means they are short there.
 *
 * `surplus` is the value sitting behind the starters that the lineup cannot
 * use, scaled by how replaceable the position is.
 */
export function rosterNeeds(report, avgByPos, positions = NEED_POSITIONS) {
    const out = {};
    for (const pos of positions) {
        const v = report.byPosition[pos];
        if (!v) continue;
        const deficit = (avgByPos[pos] ?? 0) - (v.startingPoints ?? 0);

        // Bench value at the position that the lineup is not using. A big
        // dropoff means the starter is load-bearing and the depth behind him is
        // insurance, not surplus.
        const depth = v.benchDepth ?? 0;
        const dropoff = v.dropoff ?? 0;
        const surplus = Math.max(0, depth - dropoff * 0.5);

        out[pos] = {
            pos,
            startingPoints: v.startingPoints ?? 0,
            deficit,
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
export function buildLeagueNeeds({ teams, entriesFor, cfg }) {
    const reports = teams.map((team) => {
        const entries = entriesFor(team);
        return {
            rosterId: team.rosterId,
            team,
            entries,
            lineup: optimizeLineup(entries, cfg.starterSlots),
            report: positionalReport(entries, cfg.starterSlots),
        };
    });

    const avgByPos = leagueAverages(reports);
    const out = new Map();
    for (const r of reports) {
        out.set(r.rosterId, { ...r, needs: rosterNeeds(r.report, avgByPos) });
    }
    out.avgByPos = avgByPos;
    return out;
}

/**
 * Positions where `buyer` is short and `seller` has spare bodies. This is the
 * cheap filter that removes most of the search space before any lineup solving
 * happens.
 */
export function matchingPositions(buyer, seller, { minDeficit = 0.75, minSurplus = 0.75 } = {}) {
    const hits = [];
    for (const pos of NEED_POSITIONS) {
        const need = buyer.needs[pos];
        const have = seller.needs[pos];
        if (!need || !have) continue;
        if (need.deficit >= minDeficit && have.surplus >= minSurplus) {
            hits.push({ pos, deficit: need.deficit, surplus: have.surplus, score: need.deficit + have.surplus });
        }
    }
    return sortBy(hits, (h) => h.score, -1);
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
