// Optimal starting lineup solver.
//
// This is the hinge the whole trade engine turns on. Raw player value tells you
// who is better; only a lineup solve tells you whether acquiring him actually
// changes what you score on Sunday. Trading for a WR2 upgrade when you already
// start three better receivers is worth almost nothing, and the only way to see
// that is to re-solve the lineup with and without him.

import { SLOT_ELIGIBILITY, slotLabel } from './league.js';
import { sortBy, sum } from './util.js';

const eligible = (slot, pos) => (SLOT_ELIGIBILITY[slot] || []).includes(pos);

/**
 * Fill the starting slots to maximize total projected points.
 *
 * Players are placed best-first into the most restrictive slot they qualify
 * for. For the usual slot set (QB/RB/WR/TE plus FLEX plus SUPER_FLEX) the
 * eligibility sets are nested, and greedy is provably optimal on a nested
 * family. Leagues that mix crossing slots -- WRRB_FLEX alongside REC_FLEX --
 * break that nesting, so a swap-improvement pass runs afterwards to clean up
 * the handful of cases where greedy leaves points on the bench.
 *
 * @param {Array<{player:object, score:number}>} entries roster, any order
 * @param {string[]} slots starting slots (bench slots already removed)
 */
export function optimizeLineup(entries, slots) {
    const assignment = slots.map((slot, i) => ({
        slot,
        index: i,
        label: slotLabel(slot),
        restrictiveness: (SLOT_ELIGIBILITY[slot] || []).length,
        entry: null,
    }));

    const pool = sortBy(entries, (e) => e.score, -1);
    const used = new Set();

    for (const entry of pool) {
        const open = assignment
            .filter((s) => !s.entry && eligible(s.slot, entry.player.pos))
            .sort((a, b) => a.restrictiveness - b.restrictiveness);
        if (open.length) {
            open[0].entry = entry;
            used.add(entry);
        }
    }

    improve(assignment, pool, used);

    const starters = assignment.filter((s) => s.entry);
    const bench = pool.filter((e) => !used.has(e));

    return {
        slots: assignment,
        starters,
        bench,
        points: sum(starters, (s) => s.entry.score),
        emptySlots: assignment.filter((s) => !s.entry).map((s) => s.slot),
    };
}

/**
 * Hill-climb out of the rare non-nested-eligibility case: try promoting a
 * benched player into any slot he fits, and try swapping two starters between
 * slots. Both moves are cheap because rosters are tiny.
 */
function improve(assignment, pool, used) {
    for (let pass = 0; pass < 4; pass++) {
        let changed = false;

        for (const entry of pool) {
            if (used.has(entry)) continue;
            let best = null;
            for (const slot of assignment) {
                if (!eligible(slot.slot, entry.player.pos)) continue;
                const current = slot.entry ? slot.entry.score : 0;
                const gain = entry.score - current;
                if (gain > 1e-9 && (!best || gain > best.gain)) best = { slot, gain };
            }
            if (best) {
                if (best.slot.entry) used.delete(best.slot.entry);
                best.slot.entry = entry;
                used.add(entry);
                changed = true;
            }
        }

        for (let i = 0; i < assignment.length; i++) {
            for (let j = i + 1; j < assignment.length; j++) {
                const a = assignment[i];
                const b = assignment[j];
                if (!a.entry && !b.entry) continue;
                const aFitsB = !a.entry || eligible(b.slot, a.entry.player.pos);
                const bFitsA = !b.entry || eligible(a.slot, b.entry.player.pos);
                if (!aFitsB || !bFitsA) continue;
                // Swapping two filled slots never changes the total, but it can
                // free a flex spot that the promotion pass above then uses.
                if (a.entry && b.entry) continue;
                const filled = a.entry ? a : b;
                const emptySlot = a.entry ? b : a;
                if (eligible(emptySlot.slot, filled.entry.player.pos)) {
                    emptySlot.entry = filled.entry;
                    filled.entry = null;
                    changed = true;
                }
            }
        }

        if (!changed) break;
    }
}

/**
 * Marginal value of adding one player to a roster: how many points he adds to
 * the optimal lineup, which is usually far less than his standalone value.
 */
export function marginalValue(entries, slots, candidate) {
    const before = optimizeLineup(entries, slots).points;
    const after = optimizeLineup([...entries, candidate], slots).points;
    return after - before;
}

/**
 * Per-position report: what a team starts, what backs it up, and how exposed it
 * is if the starter goes down. `dropoff` is the points lost per week if the top
 * player at that position disappeared and the lineup were re-solved.
 */
export function positionalReport(entries, slots, positions = ['QB', 'RB', 'WR', 'TE']) {
    const base = optimizeLineup(entries, slots);
    const report = {};

    for (const pos of positions) {
        const atPos = sortBy(entries.filter((e) => e.player.pos === pos), (e) => e.score, -1);
        const startersAtPos = base.starters.filter((s) => s.entry.player.pos === pos);
        const best = atPos[0];

        let dropoff = 0;
        if (best) {
            const without = entries.filter((e) => e !== best);
            dropoff = base.points - optimizeLineup(without, slots).points;
        }

        report[pos] = {
            count: atPos.length,
            starting: startersAtPos.length,
            startingPoints: sum(startersAtPos, (s) => s.entry.score),
            best: best || null,
            depth: atPos.slice(0, 5),
            // How much of the position's production hangs on one player.
            dropoff,
            benchDepth: sum(atPos.slice(startersAtPos.length, startersAtPos.length + 2), (e) => e.score),
        };
    }

    return { lineup: base, byPosition: report };
}

/**
 * Weekly scoring mean and spread for a team, used by the season simulator.
 * Sigma scales with the mean: better teams have more absolute variance, but the
 * floor keeps a bad roster from becoming deterministically bad.
 */
export function teamScoringProfile(lineupPoints) {
    return {
        mu: lineupPoints,
        sigma: Math.max(17, 0.235 * lineupPoints),
    };
}
