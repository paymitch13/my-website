// Season projections from Sleeper.
//
// This module is why the calculator's numbers mean anything. The first version
// of the app inferred production from a player's rank using a fitted curve --
// workable, but it meant the app's opinion of Tony Pollard was "whatever the
// 32nd-best running back usually does", not "what Tony Pollard is projected to
// do". Sleeper publishes real projected stat lines, so we use those.
//
// The key insight that makes this general: Sleeper uses the SAME stat keys in
// its projections that it uses in a league's `scoring_settings`. So scoring a
// player under any league's rules -- including custom first-down bonuses, big-
// play bonuses, IDP-style kicker distance buckets, whatever -- is a dot product
// between two objects, with no per-rule special casing anywhere.

const BASE = 'https://api.sleeper.com';
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/** Sleeper reports gp inconsistently (18 for offense, 1 for defenses). */
const NFL_GAMES = 17;

/**
 * Score a projected (or actual) stat line under a league's scoring settings.
 *
 * Every key the league scores is multiplied by the matching projected stat.
 * Keys the projection does not carry contribute nothing, which is correct:
 * an unprojected stat is a zero-expectation stat.
 */
export function scoreStats(stats, scoring) {
    if (!stats || !scoring) return 0;
    let total = 0;
    for (const [key, weight] of Object.entries(scoring)) {
        const v = stats[key];
        if (typeof v === 'number' && typeof weight === 'number') total += v * weight;
    }
    return total;
}

/**
 * Normalize the raw projections payload into `playerId -> { stats, games, ... }`.
 * Only rows carrying a real projection are kept; Sleeper returns thousands of
 * empty rows for every practice-squad body in the league.
 */
export function normalizeProjections(rows) {
    const out = {};
    for (const row of rows || []) {
        const stats = row?.stats;
        const player = row?.player;
        const id = row?.player_id || player?.player_id;
        if (!stats || !id) continue;

        // A row with no projected points and no volume is an empty placeholder.
        const hasProjection =
            stats.pts_half_ppr !== undefined ||
            stats.pts_ppr !== undefined ||
            stats.pts_std !== undefined;
        if (!hasProjection) continue;

        // Strip ADP keys: they are market noise, not production, and they would
        // otherwise be picked up by any league that happens to score a like-named
        // stat.
        const clean = {};
        for (const [k, v] of Object.entries(stats)) {
            if (k.startsWith('adp') || k.startsWith('pos_rank') || k.startsWith('rank_')) continue;
            if (typeof v === 'number') clean[k] = v;
        }

        const pos = player?.position || (player?.fantasy_positions || [])[0] || null;
        const games = clampGames(stats.gp, pos);

        out[id] = {
            id,
            pos,
            stats: clean,
            games,
            // Kept for display and as a sanity check against our own scoring.
            ptsHalfPpr: stats.pts_half_ppr ?? null,
            ptsPpr: stats.pts_ppr ?? null,
            ptsStd: stats.pts_std ?? null,
        };
    }
    return out;
}

/**
 * Sleeper's `gp` is not trustworthy: offensive projections say 18 (there are 17
 * games) and team defenses say 1. Normalizing per-game rates off those numbers
 * would silently scale whole positions wrong.
 */
function clampGames(gp, pos) {
    if (typeof gp !== 'number' || gp <= 0) return NFL_GAMES;
    if (gp > NFL_GAMES) return NFL_GAMES;
    // A defense projected for "1 game" is a season total mislabeled.
    if (pos === 'DEF' && gp < 4) return NFL_GAMES;
    if (gp < 1) return NFL_GAMES;
    return gp;
}

/** Per-game projected points for a player under this league's scoring. */
export function projectedPpg(projection, scoring) {
    if (!projection) return null;
    const season = scoreStats(projection.stats, scoring);
    const games = projection.games || NFL_GAMES;
    return season / games;
}

export async function fetchProjections(season) {
    const qs = POSITIONS.map((p) => `position[]=${p}`).join('&');
    const url = `${BASE}/projections/nfl/${season}?season_type=regular&${qs}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Projections fetch failed (${res.status})`);
    return normalizeProjections(await res.json());
}

/**
 * Actual season-to-date production, used to blend real performance into the
 * outlook as the season goes on. A preseason projection is a prior; by week 10
 * it should not be the only thing you believe.
 */
export async function fetchSeasonStats(season) {
    const qs = POSITIONS.map((p) => `position[]=${p}`).join('&');
    const url = `${BASE}/stats/nfl/${season}?season_type=regular&${qs}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Stats fetch failed (${res.status})`);
    return normalizeProjections(await res.json());
}

/**
 * How much to trust actual production over the preseason projection.
 *
 * Early in the year a hot three games is mostly noise, so the projection holds.
 * By the back half of the season what a player has actually done is the better
 * estimate of what he will keep doing. Caps below 1 because even a full season
 * of results does not fully retire the prior -- role changes, injuries and
 * schedule all still matter.
 */
export function actualsWeight(gamesPlayed) {
    if (!gamesPlayed || gamesPlayed <= 0) return 0;
    return Math.min(0.65, gamesPlayed / (gamesPlayed + 5));
}

/**
 * Blended per-game outlook: preseason projection, updated by what has actually
 * happened. Returns null when we have no projection at all, so callers can fall
 * back to the rank-curve model.
 */
export function blendedPpg({ projection, actual, scoring, week = 1 }) {
    const projPpg = projectedPpg(projection, scoring);
    if (projPpg === null && !actual) return null;

    const gp = actual?.games ?? 0;
    const actualPpg = actual ? scoreStats(actual.stats, scoring) / Math.max(1, gp) : null;

    if (projPpg === null) return actualPpg;
    if (actualPpg === null || gp < 1 || week <= 1) return projPpg;

    const w = actualsWeight(gp);
    return projPpg * (1 - w) + actualPpg * w;
}
