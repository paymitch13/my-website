// Usage trends and touchdown dependence.
//
// Every completed week's full stat lines are already downloaded for the
// defensive matchup profiles, and then thrown away. Those rows carry snap
// counts, targets, air yards and red-zone volume -- which is to say, everything
// needed to tell the two stories a trade recommender actually has to tell:
//
//   Buy low.  Role is expanding, box score has not caught up yet. Snap and
//             target share rising while fantasy points sit flat or fall.
//   Sell high. Points are being carried by touchdowns, which is the least
//             sticky thing in fantasy. Usage says WR30, scoring says WR8.
//
// Nothing in the valuation chain knows whether a role is growing or collapsing.
// For a calculator that is defensible. For a recommender it is the whole point.

import { mean, sortBy } from './util.js';
import { scoreStats } from './projections.js';

/** Per-week usage for one player, oldest first. */
export function playerUsageSeries(weeklyStats, playerId, scoring) {
    const rows = [];
    for (const [week, entries] of weeklyStats || []) {
        const row = (entries || []).find((r) => String(r.player_id) === String(playerId));
        if (!row?.stats) continue;
        const st = row.stats;
        const snaps = st.off_snp ?? null;
        const teamSnaps = st.tm_off_snp ?? null;
        rows.push({
            week,
            points: scoreStats(st, scoring),
            snaps,
            snapShare: snaps && teamSnaps ? snaps / teamSnaps : null,
            targets: st.rec_tgt ?? 0,
            carries: st.rush_att ?? 0,
            touches: (st.rush_att ?? 0) + (st.rec ?? 0),
            airYards: st.rec_air_yd ?? 0,
            redZone: (st.rush_rz_att ?? 0) + (st.rec_rz_tgt ?? 0),
            tds: (st.rush_td ?? 0) + (st.rec_td ?? 0) + (st.pass_td ?? 0),
        });
    }
    return sortBy(rows, (r) => r.week);
}

const avg = (rows, key) => {
    const vals = rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? mean(vals) : null;
};

/**
 * Compare a player's recent window against everything before it.
 *
 * @param {number} [window] how many recent games count as "recent"
 */
export function usageTrend(series, { window = 3, minGames = 5 } = {}) {
    if (!series || series.length < minGames) return null;
    const recent = series.slice(-window);
    const earlier = series.slice(0, -window);
    if (!earlier.length) return null;

    const delta = (key) => {
        const a = avg(earlier, key);
        const b = avg(recent, key);
        if (a === null || b === null) return null;
        return { earlier: a, recent: b, change: b - a, ratio: a > 0 ? b / a : null };
    };

    return {
        games: series.length,
        snapShare: delta('snapShare'),
        touches: delta('touches'),
        targets: delta('targets'),
        redZone: delta('redZone'),
        points: delta('points'),
    };
}

/**
 * How much of a player's scoring is touchdowns.
 *
 * A high share is not skill, it is variance waiting to end. Expressed as the
 * fraction of total points that came from touchdown scoring.
 */
export function touchdownDependence(series, scoring) {
    if (!series?.length) return null;
    const totalPoints = series.reduce((a, r) => a + r.points, 0);
    if (totalPoints <= 0) return null;
    const tdValue = Math.max(scoring.rush_td ?? 6, scoring.rec_td ?? 6);
    const tdPoints = series.reduce((a, r) => a + r.tds, 0) * tdValue;
    return {
        share: Math.min(1, tdPoints / totalPoints),
        tds: series.reduce((a, r) => a + r.tds, 0),
        pointsPerGame: totalPoints / series.length,
        games: series.length,
    };
}

/** Volume-only production: what the player scored excluding touchdowns. */
export function nonTdPointsPerGame(series, scoring) {
    if (!series?.length) return null;
    const tdValue = Math.max(scoring.rush_td ?? 6, scoring.rec_td ?? 6);
    const total = series.reduce((a, r) => a + (r.points - r.tds * tdValue), 0);
    return total / series.length;
}

/**
 * Buy-low score: role expanding faster than results.
 * Positive means usage is rising while scoring is not.
 */
export function buyLowScore(trend) {
    if (!trend) return null;
    const usageUp =
        (trend.snapShare?.change ?? 0) * 22 +
        (trend.touches?.change ?? 0) * 1.1 +
        (trend.targets?.change ?? 0) * 0.9 +
        (trend.redZone?.change ?? 0) * 1.6;
    const pointsUp = trend.points?.change ?? 0;
    // Usage climbing while points are flat or falling is the signal. Usage and
    // points rising together is just a good player being good.
    return usageUp - pointsUp * 0.85;
}

/**
 * Sell-high score: scoring propped up by touchdowns relative to volume.
 */
export function sellHighScore(dependence, trend, { leagueTdShare = 0.35 } = {}) {
    if (!dependence || dependence.games < 4) return null;
    const excessTd = dependence.share - leagueTdShare;
    const usageDown = -((trend?.snapShare?.change ?? 0) * 18 + (trend?.touches?.change ?? 0));
    return excessTd * 24 + usageDown * 0.5;
}

/**
 * Rank every rostered player for buy-low and sell-high signals.
 *
 * @param {object} input
 * @param {Map} input.weeklyStats week -> raw rows
 * @param {Array} input.players candidate players
 * @param {object} input.scoring league scoring
 */
export function scanUsage({ weeklyStats, players, scoring, window = 3 }) {
    const out = [];
    for (const player of players || []) {
        const series = playerUsageSeries(weeklyStats, player.id, scoring);
        if (series.length < 4) continue;
        const trend = usageTrend(series, { window });
        const dependence = touchdownDependence(series, scoring);
        out.push({
            player,
            series,
            trend,
            dependence,
            nonTdPpg: nonTdPointsPerGame(series, scoring),
            buyLow: buyLowScore(trend),
            sellHigh: sellHighScore(dependence, trend),
        });
    }
    return out;
}

/** Human-readable explanation of a buy-low candidate. */
export function describeBuyLow(row) {
    const bits = [];
    const t = row.trend;
    if (t?.snapShare && t.snapShare.change > 0.04) {
        bits.push(`snap share up from ${pct(t.snapShare.earlier)} to ${pct(t.snapShare.recent)}`);
    }
    if (t?.targets && t.targets.change > 0.8) {
        bits.push(`targets up from ${t.targets.earlier.toFixed(1)} to ${t.targets.recent.toFixed(1)} a game`);
    }
    if (t?.touches && t.touches.change > 1) {
        bits.push(`touches up from ${t.touches.earlier.toFixed(1)} to ${t.touches.recent.toFixed(1)}`);
    }
    if (t?.redZone && t.redZone.change > 0.5) {
        bits.push(`more red-zone work (${t.redZone.earlier.toFixed(1)} → ${t.redZone.recent.toFixed(1)})`);
    }
    if (!bits.length) return 'Role is trending up faster than the box score.';
    const pointsNote =
        t?.points && t.points.change < 0
            ? ` — and his points have actually fallen ${Math.abs(t.points.change).toFixed(1)} a game.`
            : ' while his scoring has stayed flat.';
    return `${capitalize(bits.join(', '))}${pointsNote}`;
}

/** Human-readable explanation of a sell-high candidate. */
export function describeSellHigh(row) {
    const d = row.dependence;
    const share = Math.round((d?.share ?? 0) * 100);
    const bits = [`${share}% of his points have come from touchdowns (${d.tds} in ${d.games} games)`];
    if (row.nonTdPpg !== null) bits.push(`strip those out and he is a ${row.nonTdPpg.toFixed(1)}-point-a-game player`);
    if (row.trend?.snapShare && row.trend.snapShare.change < -0.03) {
        bits.push(`and his snap share is falling (${pct(row.trend.snapShare.earlier)} → ${pct(row.trend.snapShare.recent)})`);
    }
    return `${capitalize(bits.join(', '))}. Touchdown rate is the least sticky thing in fantasy.`;
}

const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
