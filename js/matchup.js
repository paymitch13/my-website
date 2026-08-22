// Opponent difficulty, computed rather than asserted.
//
// "Points allowed to the position" is the standard matchup metric and it is
// usually computed badly: raw totals reward defenses that happened to face weak
// offenses. This normalizes two ways before comparing anything.
//
//   1. Each performance is measured against what that PLAYER normally does,
//      not against a league average. A defense that holds a WR1 to 9 points has
//      done something; a defense that holds a WR60 to 9 points has not.
//   2. The result is expressed as a multiplier around 1.0, so it composes
//      cleanly with the weather and Vegas adjustments.

import { mean, ordinal, sortBy } from './util.js';
import { scoreStats } from './projections.js';

/**
 * Build per-defense, per-position difficulty from weekly stat lines.
 *
 * @param {Map<number, Array>} weeklyStats week -> raw Sleeper stats rows
 * @param {object} scoring league scoring settings
 * @param {object} [opts]
 */
export function buildDefenseProfiles(weeklyStats, scoring, { minSamples = 4 } = {}) {
    // playerId -> [points...] so we know each player's own baseline.
    const playerGames = new Map();
    const rows = [];

    for (const [week, entries] of weeklyStats || []) {
        for (const r of entries || []) {
            const pos = r.player?.position || (r.player?.fantasy_positions || [])[0];
            const opp = r.opponent;
            const id = r.player_id;
            if (!pos || !opp || !id || !r.stats) continue;
            const pts = scoreStats(r.stats, scoring);
            if (!Number.isFinite(pts)) continue;
            if (!playerGames.has(id)) playerGames.set(id, []);
            playerGames.get(id).push(pts);
            rows.push({ id, pos, opp, pts, week });
        }
    }

    // defense -> position -> ratios of actual to that player's own average
    const buckets = new Map();
    for (const r of rows) {
        const games = playerGames.get(r.id) || [];
        if (games.length < 3) continue; // too small a sample to have a baseline

        // Leave-one-out: the game being measured must not be part of the
        // baseline it is measured against. Including it made every performance
        // a fraction of its own yardstick and pulled every ratio toward 1,
        // systematically flattening the difference between defenses.
        const total = games.reduce((a, b) => a + b, 0);
        const own = (total - r.pts) / (games.length - 1);

        // Fringe players' ratios are wild and meaningless; require real usage.
        if (!Number.isFinite(own) || own < 4) continue;
        const ratio = r.pts / own;

        if (!buckets.has(r.opp)) buckets.set(r.opp, {});
        const byPos = buckets.get(r.opp);
        (byPos[r.pos] ||= []).push(ratio);
    }

    const profiles = new Map();
    for (const [def, byPos] of buckets) {
        const entry = {};
        for (const [pos, ratios] of Object.entries(byPos)) {
            if (ratios.length < minSamples) continue;
            // Trim the extremes: one 40-point outlier should not define a defense.
            const sorted = ratios.slice().sort((a, b) => a - b);
            const trim = Math.floor(sorted.length * 0.1);
            const kept = sorted.slice(trim, sorted.length - trim || sorted.length);
            entry[pos] = { ratio: mean(kept), samples: ratios.length };
        }
        profiles.set(def, entry);
    }
    return profiles;
}

/**
 * Rank each defense against the others at a position, so the UI can say
 * "3rd-toughest matchup for a tight end" rather than quoting a bare ratio.
 */
export function rankDefenses(profiles, pos) {
    const rows = [];
    for (const [def, byPos] of profiles) {
        const e = byPos[pos];
        if (e) rows.push({ def, ratio: e.ratio, samples: e.samples });
    }
    // Lowest ratio = toughest defense = rank 1.
    return sortBy(rows, (r) => r.ratio).map((r, i) => ({ ...r, rank: i + 1, total: rows.length }));
}

/**
 * Matchup multiplier for one player against one defense.
 * Damped toward 1.0: a defense's rate over a handful of games is a noisy
 * estimate, and applying it at full strength would swamp the projection.
 */
export function matchupImpact(profiles, defense, pos, { damping = 0.55 } = {}) {
    const entry = profiles?.get(defense)?.[pos];
    if (!entry) return { multiplier: 1, rank: null, samples: 0, known: false };

    const raw = entry.ratio;
    const damped = 1 + (raw - 1) * damping;
    return {
        multiplier: Math.max(0.7, Math.min(1.3, damped)),
        raw,
        samples: entry.samples,
        known: true,
    };
}

export function describeMatchup(rankInfo, pos) {
    if (!rankInfo || !rankInfo.total) return null;
    const { rank, total } = rankInfo;
    const pct = rank / total;
    if (pct <= 0.2) return { tone: 'bad', text: `One of the toughest ${pos} matchups on the board (${ordinal(rank)} of ${total}).` };
    if (pct <= 0.4) return { tone: 'warn', text: `A difficult ${pos} matchup (${ordinal(rank)} of ${total}).` };
    if (pct >= 0.8) return { tone: 'good', text: `A smash spot — this defense is ${ordinal(total - rank + 1)}-most generous to ${pos}s.` };
    if (pct >= 0.6) return { tone: 'good', text: `A favorable ${pos} matchup (${ordinal(rank)} of ${total}).` };
    return { tone: 'neutral', text: `A neutral ${pos} matchup.` };
}
