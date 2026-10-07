// Advanced stats: the numbers underneath the fantasy points.
//
// Everything else in this app reports a points total after the league's
// scoring has been applied. That is the right output and the wrong diagnostic:
// "11.4 points" tells you what happened and nothing about whether it will
// happen again. A running back on 68% of snaps with eight red-zone carries and
// one touchdown is a different asset from one on 31% of snaps with one red-zone
// carry and three touchdowns, and they can post the same line for a month.
//
// ON SOURCES, because this matters and is easy to overstate. The NFL's own Next
// Gen Stats feed is not usable here -- it requires authentication (its public
// endpoint answers 401), so there is no honest way to serve it from a static
// page. What this module uses instead is Sleeper's weekly stat rows, which are
// considerably richer than they first appear: 195 distinct keys per week
// including air yards, yards after contact, broken tackles, red-zone targets
// and attempts, drops, first downs, and offensive snaps against team snaps.
// Those cover most of what is meant by "advanced" for fantasy purposes --
// opportunity, efficiency and leverage -- without the tracking-derived metrics
// (separation, time to throw, rush yards over expected) that genuinely do need
// NGS. The UI says so rather than implying a source it does not have.
//
// The metrics are organised around one distinction that decides how to read
// everything else:
//
//   OPPORTUNITY  snap share, target share, carry share, red-zone share.
//                Stable week to week, largely decided by coaches, and the
//                thing that actually predicts next week. This is the signal.
//   EFFICIENCY   yards per target, yards after contact, broken tackles,
//                catch rate. Noisy, partly skill and partly luck, and the
//                thing that regresses. This is the warning.
//
// A player whose opportunity is climbing is going up in value. A player whose
// points are being held up by efficiency is going down, and usually before
// anybody notices.

import { scoreStats } from './projections.js';
import { indexWeeklyStats } from './usage.js';
import { sortBy, mean, round } from './util.js';

/**
 * Every metric this module knows how to compute, with how to read it.
 *
 * `kind` drives interpretation: an opportunity metric rising is a buy signal
 * and an efficiency metric rising is a regression warning, so the UI must never
 * present them with the same colour.
 */
export const METRICS = [
    // --- Opportunity -------------------------------------------------------
    { key: 'snapShare', label: 'Snap share', short: 'SNP%', kind: 'opportunity', format: 'pct', positions: ['QB', 'RB', 'WR', 'TE'], higherBetter: true, move: 0.08,
      note: 'Share of his team’s offensive snaps. The most stable number here and the first one to move when a role changes.' },
    { key: 'targetShare', label: 'Target share', short: 'TGT%', kind: 'opportunity', format: 'pct', positions: ['RB', 'WR', 'TE'], higherBetter: true, move: 0.05,
      note: 'Share of his team’s targets. Predicts next week better than any yardage figure.' },
    { key: 'carryShare', label: 'Carry share', short: 'CAR%', kind: 'opportunity', format: 'pct', positions: ['RB', 'QB'], higherBetter: true, move: 0.08,
      note: 'Share of his team’s rushing attempts.' },
    { key: 'airYardsShare', label: 'Air yards share', short: 'AY%', kind: 'opportunity', format: 'pct', positions: ['WR', 'TE', 'RB'], higherBetter: true, move: 0.06,
      note: 'Share of the pass yardage thrown his way, caught or not. Separates a deep threat from a possession receiver.' },
    { key: 'redZoneShare', label: 'Red-zone share', short: 'RZ%', kind: 'opportunity', format: 'pct', positions: ['RB', 'WR', 'TE'], higherBetter: true, move: 0.10,
      note: 'Share of his team’s red-zone touches and targets. Where touchdowns come from.' },
    { key: 'touchesPerGame', label: 'Touches', short: 'TCH', kind: 'opportunity', format: 'one', positions: ['RB', 'WR', 'TE'], higherBetter: true, move: 3,
      note: 'Carries plus receptions per game.' },
    { key: 'targetsPerGame', label: 'Targets', short: 'TGT', kind: 'opportunity', format: 'one', positions: ['RB', 'WR', 'TE'], higherBetter: true, move: 2 },
    { key: 'redZonePerGame', label: 'Red-zone looks', short: 'RZ', kind: 'opportunity', format: 'one', positions: ['RB', 'WR', 'TE'], higherBetter: true, move: 1 },

    // --- Efficiency --------------------------------------------------------
    { key: 'yardsPerTarget', label: 'Yards per target', short: 'Y/T', kind: 'efficiency', format: 'one', positions: ['WR', 'TE', 'RB'], higherBetter: true,
      note: 'Efficiency, not opportunity. Noisy over a few games and it regresses.' },
    { key: 'catchRate', label: 'Catch rate', short: 'CTH%', kind: 'efficiency', format: 'pct', positions: ['WR', 'TE', 'RB'], higherBetter: true },
    { key: 'yardsPerCarry', label: 'Yards per carry', short: 'Y/C', kind: 'efficiency', format: 'one', positions: ['RB', 'QB'], higherBetter: true,
      note: 'Among the noisiest numbers in football over a small sample.' },
    { key: 'yardsAfterContact', label: 'Yards after contact', short: 'YAC', kind: 'efficiency', format: 'one', positions: ['RB'], higherBetter: true,
      note: 'Per carry, and closer to skill than yards per carry is — it strips out the blocking.' },
    { key: 'brokenTackles', label: 'Broken tackles', short: 'BTK', kind: 'efficiency', format: 'one', positions: ['RB', 'WR'], higherBetter: true },
    { key: 'firstDownRate', label: 'First-down rate', short: 'FD%', kind: 'efficiency', format: 'pct', positions: ['RB', 'WR', 'TE'], higherBetter: true,
      note: 'Share of his touches that gained a first down. A proxy for whether the volume is useful volume.' },
    { key: 'dropRate', label: 'Drop rate', short: 'DRP%', kind: 'efficiency', format: 'pct', positions: ['WR', 'TE', 'RB'], higherBetter: false },

    // --- Quarterback -------------------------------------------------------
    { key: 'completionPct', label: 'Completion %', short: 'CMP%', kind: 'efficiency', format: 'pct', positions: ['QB'], higherBetter: true },
    { key: 'yardsPerAttempt', label: 'Yards per attempt', short: 'Y/A', kind: 'efficiency', format: 'one', positions: ['QB'], higherBetter: true },
    { key: 'passerRating', label: 'Passer rating', short: 'RTG', kind: 'efficiency', format: 'one', positions: ['QB'], higherBetter: true },
    { key: 'airYardsPerAttempt', label: 'Air yards per attempt', short: 'aY/A', kind: 'opportunity', format: 'one', positions: ['QB'], higherBetter: true,
      note: 'How far downfield he throws, which drives both ceiling and interception risk.' },
    { key: 'sackRate', label: 'Sack rate', short: 'SK%', kind: 'efficiency', format: 'pct', positions: ['QB'], higherBetter: false },

    // --- Scoring -----------------------------------------------------------
    { key: 'pointsPerGame', label: 'Points', short: 'PTS', kind: 'scoring', format: 'one', positions: ['QB', 'RB', 'WR', 'TE'], higherBetter: true, move: 4 },
    { key: 'pointsPerTouch', label: 'Points per touch', short: 'P/T', kind: 'efficiency', format: 'two', positions: ['RB', 'WR', 'TE'], higherBetter: true },
    { key: 'tdShare', label: 'Points from TDs', short: 'TD%', kind: 'efficiency', format: 'pct', positions: ['QB', 'RB', 'WR', 'TE'], higherBetter: false,
      note: 'The share of his scoring that came from touchdowns. High is a warning, not a compliment: it is the least repeatable part of a stat line.' },
];

export const METRIC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

/** Metrics worth showing for a position, opportunity first. */
export function metricsFor(pos) {
    const order = { opportunity: 0, efficiency: 1, scoring: 2 };
    return sortBy(
        METRICS.filter((m) => m.positions.includes(pos)),
        (m) => order[m.kind] ?? 3
    );
}

export function formatMetric(key, value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    const m = METRIC_BY_KEY.get(key);
    switch (m?.format) {
        case 'pct':
            return `${Math.round(value * 100)}%`;
        case 'two':
            return round(value, 2).toFixed(2);
        case 'one':
            return round(value, 1).toFixed(1);
        default:
            return String(round(value, 1));
    }
}

/**
 * Team-level weekly totals, so shares can be computed.
 *
 * Share metrics are the most predictive numbers available and they cannot be
 * read off one player's row: a receiver's eight targets means one thing on a
 * team that threw twenty and another on a team that threw forty-five.
 */
export function teamWeeklyTotals(weeklyStats, index = null) {
    const idx = index || indexWeeklyStats(weeklyStats);
    const out = new Map();

    for (const [week, byPlayer] of idx) {
        const perTeam = new Map();
        for (const row of byPlayer.values()) {
            const team = row.team || row.player?.team;
            const st = row.stats;
            if (!team || !st) continue;
            if (!perTeam.has(team)) {
                perTeam.set(team, { targets: 0, carries: 0, airYards: 0, redZone: 0, snaps: 0 });
            }
            const t = perTeam.get(team);
            t.targets += st.rec_tgt ?? 0;
            t.carries += st.rush_att ?? 0;
            t.airYards += st.rec_air_yd ?? 0;
            t.redZone += (st.rush_rz_att ?? 0) + (st.rec_rz_tgt ?? 0);
            // Team offensive snaps are reported on every row, so the max is the
            // team's count rather than a sum (summing counts each snap once per
            // player on the field).
            t.snaps = Math.max(t.snaps, st.tm_off_snp ?? 0);
        }
        out.set(week, perTeam);
    }
    return out;
}

/**
 * Per-week advanced rows for one player.
 *
 * Note the treatment of absent keys. Sleeper omits a stat entirely when it is
 * zero, so `rush_btkl === undefined` means he broke no tackles, NOT that the
 * data is missing -- only 25 of 478 rows in a given week carry that key. Every
 * counting stat therefore defaults to 0, while every RATE stays null when its
 * denominator is zero, because zero targets does not mean a catch rate of zero.
 */
export function advancedSeries(weeklyStats, playerId, scoring, { index = null, teamTotals = null } = {}) {
    const idx = index || indexWeeklyStats(weeklyStats);
    const teams = teamTotals || teamWeeklyTotals(weeklyStats, idx);
    const key = String(playerId);
    const rows = [];

    for (const [week, byPlayer] of idx) {
        const row = byPlayer.get(key);
        const st = row?.stats;
        if (!st) continue;
        // A week he did not play is not a week of data: averaging a zero into
        // a per-game rate is how an injured player's numbers quietly collapse.
        if (!st.gp) continue;

        const team = row.team || row.player?.team || null;
        const tm = team ? teams.get(week)?.get(team) : null;

        const targets = st.rec_tgt ?? 0;
        const carries = st.rush_att ?? 0;
        const receptions = st.rec ?? 0;
        const touches = carries + receptions;
        const snaps = st.off_snp ?? null;
        const teamSnaps = st.tm_off_snp ?? null;
        const redZone = (st.rush_rz_att ?? 0) + (st.rec_rz_tgt ?? 0);

        rows.push({
            week,
            team,
            opponent: row.opponent || null,
            points: scoreStats(st, scoring),

            // Raw counts.
            snaps, teamSnaps, targets, carries, receptions, touches, redZone,
            recYards: st.rec_yd ?? 0,
            rushYards: st.rush_yd ?? 0,
            airYards: st.rec_air_yd ?? 0,
            yacRush: st.rush_yac ?? 0,
            broken: st.rush_btkl ?? 0,
            drops: st.rec_drop ?? 0,
            firstDowns: (st.rec_fd ?? 0) + (st.rush_fd ?? 0),
            passAtt: st.pass_att ?? 0,
            passCmp: st.pass_cmp ?? 0,
            passYards: st.pass_yd ?? 0,
            passAir: st.pass_air_yd ?? 0,
            sacks: st.pass_sack ?? 0,
            rating: st.pass_rtg ?? null,
            passTds: st.pass_td ?? 0,
            scoreTds: (st.rush_td ?? 0) + (st.rec_td ?? 0),

            // Shares, which need the team's week.
            snapShare: snaps && teamSnaps ? snaps / teamSnaps : null,
            targetShare: tm?.targets ? targets / tm.targets : null,
            carryShare: tm?.carries ? carries / tm.carries : null,
            airYardsShare: tm?.airYards ? (st.rec_air_yd ?? 0) / tm.airYards : null,
            redZoneShare: tm?.redZone ? redZone / tm.redZone : null,
        });
    }
    return sortBy(rows, (r) => r.week);
}

const sum = (rows, key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
const rate = (num, den) => (den > 0 ? num / den : null);
const avgOf = (rows, key) => {
    const vals = rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? mean(vals) : null;
};

/**
 * Aggregate a series into one profile.
 *
 * Rates are computed from SEASON TOTALS rather than by averaging weekly rates,
 * which are different numbers and the second one is wrong: a week with one
 * target and a 100-yard catch would otherwise count as much as a week with
 * twelve targets, and yards per target would read like a deep threat's.
 */
export function advancedProfile(player, series, scoring) {
    if (!series?.length) return null;
    const games = series.length;

    const targets = sum(series, 'targets');
    const carries = sum(series, 'carries');
    const receptions = sum(series, 'receptions');
    const touches = sum(series, 'touches');
    const recYards = sum(series, 'recYards');
    const rushYards = sum(series, 'rushYards');
    const passAtt = sum(series, 'passAtt');
    const points = sum(series, 'points');

    const tdPoints =
        sum(series, 'scoreTds') * Math.max(scoring?.rush_td ?? 6, scoring?.rec_td ?? 6) +
        sum(series, 'passTds') * (scoring?.pass_td ?? 4);

    return {
        player,
        games,
        series,
        weeks: series.map((r) => r.week),

        // Opportunity.
        snapShare: avgOf(series, 'snapShare'),
        targetShare: avgOf(series, 'targetShare'),
        carryShare: avgOf(series, 'carryShare'),
        airYardsShare: avgOf(series, 'airYardsShare'),
        redZoneShare: avgOf(series, 'redZoneShare'),
        touchesPerGame: touches / games,
        targetsPerGame: targets / games,
        redZonePerGame: sum(series, 'redZone') / games,

        // Efficiency.
        yardsPerTarget: rate(recYards, targets),
        catchRate: rate(receptions, targets),
        yardsPerCarry: rate(rushYards, carries),
        yardsAfterContact: rate(sum(series, 'yacRush'), carries),
        brokenTackles: sum(series, 'broken') / games,
        firstDownRate: rate(sum(series, 'firstDowns'), touches),
        dropRate: rate(sum(series, 'drops'), targets),

        // Quarterback.
        completionPct: rate(sum(series, 'passCmp'), passAtt),
        yardsPerAttempt: rate(sum(series, 'passYards'), passAtt),
        airYardsPerAttempt: rate(sum(series, 'passAir'), passAtt),
        sackRate: rate(sum(series, 'sacks'), passAtt + sum(series, 'sacks')),
        passerRating: avgOf(series, 'rating'),

        // Scoring.
        pointsPerGame: points / games,
        pointsPerTouch: rate(points, touches),
        tdShare: points > 0 ? Math.min(1, tdPoints / points) : null,
    };
}

/**
 * Recent form against everything before it, metric by metric.
 *
 * This is the part that answers "who is going up or down in value". A single
 * season average hides a player who has been a different asset for a month,
 * which is exactly the player worth trading for or away.
 */
export function profileTrend(player, series, scoring, { window = 3 } = {}) {
    // Both halves need at least two games, or the "earlier" baseline is a
    // single observation and one quiet afternoon reads as a collapse.
    if (!series || series.length < window + 2) return null;
    const recent = series.slice(-window);
    const earlier = series.slice(0, -window);

    const a = advancedProfile(player, earlier, scoring);
    const b = advancedProfile(player, recent, scoring);
    if (!a || !b) return null;

    const moves = [];
    for (const m of METRICS) {
        const before = a[m.key];
        const after = b[m.key];
        if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
        const change = after - before;
        if (before === 0 && after === 0) continue;
        moves.push({
            metric: m,
            before,
            after,
            change,
            ratio: before > 0 ? after / before : null,
            // Did it move in the direction that is GOOD for this metric?
            improved: m.higherBetter ? change > 0 : change < 0,
        });
    }

    return {
        player,
        earlier: a,
        recent: b,
        window,
        moves: sortBy(moves, (x) => Math.abs(relativeMove(x)), -1),
        verdict: verdictFor(moves),
    };
}

/**
 * A move's size in units of "what counts as a meaningful move" for that metric.
 *
 * NOT a ratio against the player's own baseline, which was the first attempt
 * and was useless: a receiver going from a 1% target share to 15% scores a
 * 1,400% move, so the rising list filled up with deep-bench bodies who caught
 * two passes and buried every player anybody could act on. Dividing by the
 * metric's own scale instead means +5 points of target share reads the same
 * size whoever it happened to, which is the comparison actually wanted.
 *
 * Clamped, because a move four times larger than significant is not four times
 * more interesting than one three times larger -- it is a role change either
 * way, and leaving it unbounded lets one metric dominate the average.
 */
function relativeMove(move) {
    const scale = move.metric.move || Math.abs(move.before) || 1;
    return Math.max(-3, Math.min(3, move.change / scale));
}

/**
 * Is this player's value going up or down?
 *
 * The honest read is OPPORTUNITY first. Points can rise on efficiency and
 * efficiency regresses; a role does not. So a player whose points are up but
 * whose snaps and targets are flat is going DOWN, and that is the call this is
 * here to make -- it is the one every manager gets wrong in both directions.
 */
export function verdictFor(moves) {
    const byKind = (kind) => moves.filter((m) => m.metric.kind === kind);
    const opp = byKind('opportunity');
    const scoring = moves.find((m) => m.metric.key === 'pointsPerGame');

    if (!opp.length) return { direction: 'unknown', text: 'Not enough opportunity data to say which way he is going.' };

    const oppMoves = opp.map(relativeMove);
    const oppDrift = mean(oppMoves);
    const pointsUp = (scoring?.change ?? 0) > 0.5;
    const pointsDown = (scoring?.change ?? 0) < -0.5;

    if (oppDrift > 0.1) {
        return {
            direction: 'up',
            text: pointsDown
                ? 'His role is growing even though his points have fallen — the production usually follows. This is the buy window.'
                : 'His role is growing and the box score agrees. Value is going up.',
        };
    }
    if (oppDrift < -0.1) {
        return {
            direction: 'down',
            text: pointsUp
                ? 'His points are up while his role is shrinking, which is the combination that does not last. Sell into the hot streak.'
                : 'Role and production both falling. Value is going down.',
        };
    }
    if (pointsUp) {
        return {
            direction: 'hollow',
            text: 'Points up on flat opportunity, so this is efficiency rather than role — and efficiency regresses. Do not pay for it.',
        };
    }
    if (pointsDown) {
        return {
            direction: 'cheap',
            text: 'Points down on a steady role. Nothing has actually changed about his situation, which makes him cheap to buy.',
        };
    }
    return { direction: 'flat', text: 'Role and production both steady — he is what he has been.' };
}

/**
 * Build profiles for a set of players in one pass, sharing the expensive
 * indexes. Indexing per player meant a full sweep of the season for each one.
 */
export function buildProfiles({ weeklyStats, players, scoring, minGames = 2, window = 3 }) {
    const index = indexWeeklyStats(weeklyStats);
    const teamTotals = teamWeeklyTotals(weeklyStats, index);
    const out = [];

    for (const player of players || []) {
        const series = advancedSeries(weeklyStats, player.id, scoring, { index, teamTotals });
        if (series.length < minGames) continue;
        const profile = advancedProfile(player, series, scoring);
        if (!profile) continue;
        profile.trend = profileTrend(player, series, scoring, { window });
        out.push(profile);
    }
    return out;
}

/**
 * Leaderboard for one metric.
 *
 * `minimum` is not optional in spirit: a receiver with two targets and both
 * caught for forty yards leads every efficiency metric in football and tells
 * you nothing, so a volume floor is what makes a leaderboard mean anything.
 */
export function leaderboard(profiles, metricKey, { pos = null, minimum = 0, minimumKey = 'touchesPerGame', limit = 15 } = {}) {
    const metric = METRIC_BY_KEY.get(metricKey);
    if (!metric) return [];

    const eligible = (profiles || []).filter((p) => {
        if (pos && p.player.pos !== pos) return false;
        if (!metric.positions.includes(p.player.pos)) return false;
        if (!Number.isFinite(p[metricKey])) return false;
        if (minimum > 0 && !((p[minimumKey] ?? 0) >= minimum)) return false;
        return true;
    });

    return sortBy(eligible, (p) => p[metricKey], metric.higherBetter ? -1 : 1).slice(0, limit);
}

/**
 * Who is moving, in either direction.
 *
 * Ranked on OPPORTUNITY drift rather than on points, for the reason given in
 * `verdictFor`: a role is a fact and efficiency is mostly weather.
 */
export function movers(profiles, { direction = 'up', pos = null, limit = 10, minTouches = 3 } = {}) {
    const rows = (profiles || [])
        .filter((p) => p.trend && (!pos || p.player.pos === pos))
        // A volume floor, applied to the RECENT window rather than the season.
        //
        // Without it the list is deep-bench bodies: a receiver who caught two
        // passes after catching none is, proportionally, the biggest riser in
        // football every single week. The floor is on the recent half because
        // a player who has just taken over a job has barely any season volume
        // yet -- which is exactly the player worth surfacing.
        .filter((p) => {
            const recent = p.trend.recent;
            if (p.player.pos === 'QB') return (recent.yardsPerAttempt ?? 0) > 0;
            return (recent.touchesPerGame ?? 0) >= minTouches;
        })
        .map((p) => {
            const opp = p.trend.moves.filter((m) => m.metric.kind === 'opportunity');
            return { profile: p, drift: opp.length ? mean(opp.map(relativeMove)) : 0 };
        })
        .filter((r) => r.drift !== 0);

    return sortBy(rows, (r) => r.drift, direction === 'up' ? -1 : 1)
        .filter((r) => (direction === 'up' ? r.drift > 0.2 : r.drift < -0.2))
        .slice(0, limit);
}

/**
 * Side-by-side comparison of two to four players on the metrics that matter
 * for their positions. Shared positions use shared metrics; a mixed field
 * falls back to the metrics they all have.
 */
export function compareProfiles(profiles) {
    const field = (profiles || []).filter(Boolean);
    if (field.length < 2) return null;

    const positions = [...new Set(field.map((p) => p.player.pos))];
    const common = METRICS.filter((m) => positions.every((pos) => m.positions.includes(pos)));
    // A mixed field with nothing in common still has points and snap share.
    const metrics = common.length ? common : METRICS.filter((m) => ['pointsPerGame', 'snapShare'].includes(m.key));

    const rows = metrics.map((metric) => {
        const values = field.map((p) => ({ profile: p, value: p[metric.key] }));
        const usable = values.filter((v) => Number.isFinite(v.value));
        const best = usable.length
            ? usable.reduce((a, b) => (metric.higherBetter ? (b.value > a.value ? b : a) : b.value < a.value ? b : a))
            : null;
        return { metric, values, leader: best?.profile ?? null };
    });

    return { field, positions, rows };
}
