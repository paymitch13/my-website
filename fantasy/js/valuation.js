// Valuation: how a ranking becomes a number you can trade with.
//
// The chain is deliberate:
//
//   positional rank -> estimated per-game stat line -> points under THIS
//   league's scoring -> points above replacement -> rest-of-season value
//
// Going through a stat line rather than a hardcoded points table is what makes
// the calculator league-aware for free: a 6-point-passing-TD superflex league
// and a standard-scoring 10-teamer read the same rankings and get genuinely
// different values, because the scoring settings are applied to the estimated
// production instead of being bolted on as a fudge factor afterwards.

import { clamp, sortBy } from './util.js';
import { ALL_POS, replacementRanks } from './league.js';
import { blendedPpg, projectedPpg } from './projections.js';

/**
 * Least-squares fit of value = a + b*ln(rank + c) through the anchor points,
 * grid-searching c. Production-by-rank curves are close to logarithmic: a steep
 * cliff over the first handful of players, then a long shallow tail.
 *
 * @param {Array<[number, number]>} anchors [rank, value] pairs
 */
export function fitCurve(anchors) {
    let best = null;
    for (let c = 0.25; c <= 40; c += 0.25) {
        let sx = 0;
        let sy = 0;
        let sxx = 0;
        let sxy = 0;
        const n = anchors.length;
        for (const [r, y] of anchors) {
            const x = Math.log(r + c);
            sx += x;
            sy += y;
            sxx += x * x;
            sxy += x * y;
        }
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) < 1e-12) continue;
        const b = (n * sxy - sx * sy) / denom;
        const a = (sy - b * sx) / n;
        let sse = 0;
        for (const [r, y] of anchors) sse += (a + b * Math.log(r + c) - y) ** 2;
        if (!best || sse < best.sse) best = { a, b, c, sse };
    }
    const floor = Math.min(...anchors.map(([, y]) => y)) * 0.12;
    return (rank) => Math.max(floor, best.a + best.b * Math.log(Math.max(1, rank) + best.c));
}

/**
 * Per-game production by positional rank. These are league-average shapes, not
 * projections for any individual -- the user's ranking supplies the opinion,
 * the curve supplies the scale of the gaps between ranks.
 */
const STAT_ANCHORS = {
    QB: {
        passYd: [[1, 268], [6, 252], [12, 236], [24, 206], [40, 168]],
        passTd: [[1, 1.85], [6, 1.62], [12, 1.44], [24, 1.14], [40, 0.85]],
        passInt: [[1, 0.55], [12, 0.62], [24, 0.68], [40, 0.72]],
        rushYd: [[1, 34], [6, 22], [12, 13], [24, 7], [40, 4]],
        rushTd: [[1, 0.42], [6, 0.26], [12, 0.18], [24, 0.1], [40, 0.05]],
        fum: [[1, 0.13], [12, 0.11], [40, 0.09]],
    },
    RB: {
        rushYd: [[1, 88], [6, 74], [12, 62], [24, 45], [48, 26], [72, 14]],
        rushTd: [[1, 0.72], [6, 0.55], [12, 0.42], [24, 0.28], [48, 0.15], [72, 0.08]],
        rec: [[1, 3.6], [6, 3.0], [12, 2.6], [24, 2.1], [48, 1.4], [72, 0.9]],
        recYd: [[1, 30], [6, 24], [12, 20], [24, 15], [48, 10], [72, 6]],
        recTd: [[1, 0.14], [12, 0.09], [24, 0.06], [48, 0.04], [72, 0.02]],
        fum: [[1, 0.07], [24, 0.05], [72, 0.03]],
    },
    WR: {
        rec: [[1, 6.6], [6, 5.6], [12, 5.0], [24, 4.2], [48, 3.1], [72, 2.3]],
        recYd: [[1, 92], [6, 76], [12, 65], [24, 52], [48, 37], [72, 26]],
        recTd: [[1, 0.62], [6, 0.48], [12, 0.4], [24, 0.3], [48, 0.2], [72, 0.13]],
        rushYd: [[1, 3], [24, 1], [72, 0.4]],
        rushTd: [[1, 0.02], [72, 0.005]],
        fum: [[1, 0.04], [72, 0.02]],
    },
    TE: {
        rec: [[1, 5.8], [3, 5.1], [6, 4.6], [12, 3.7], [24, 2.5], [36, 1.8]],
        recYd: [[1, 68], [3, 58], [6, 50], [12, 40], [24, 26], [36, 18]],
        recTd: [[1, 0.48], [6, 0.34], [12, 0.25], [24, 0.15], [36, 0.1]],
        fum: [[1, 0.03], [36, 0.015]],
    },
};

const STAT_CURVES = {};
for (const [pos, stats] of Object.entries(STAT_ANCHORS)) {
    STAT_CURVES[pos] = {};
    for (const [stat, anchors] of Object.entries(stats)) STAT_CURVES[pos][stat] = fitCurve(anchors);
}

/**
 * Kickers and defenses score off events that barely correlate with a stat line
 * (return TDs, safeties, points-allowed brackets), so they get a direct
 * points-per-game curve instead of a modeled box score.
 */
const FLAT_PPG = {
    K: fitCurve([[1, 9.4], [6, 8.3], [12, 7.5], [24, 6.4], [36, 5.6]]),
    DEF: fitCurve([[1, 9.6], [6, 7.7], [12, 6.4], [24, 4.9], [32, 3.9]]),
};

/** Estimated per-game box score for the Nth-ranked player at a position. */
export function statLine(pos, posRank) {
    const curves = STAT_CURVES[pos];
    if (!curves) return null;
    const out = {};
    for (const [stat, f] of Object.entries(curves)) out[stat] = Math.max(0, f(posRank));
    return out;
}

/** Apply a league's scoring settings to an estimated stat line. */
export function scoreStatLine(line, scoring, pos) {
    if (!line) return 0;
    let p = 0;
    p += (line.passYd || 0) * scoring.pass_yd;
    p += (line.passTd || 0) * scoring.pass_td;
    p += (line.passInt || 0) * scoring.pass_int;
    p += (line.rushYd || 0) * scoring.rush_yd;
    p += (line.rushTd || 0) * scoring.rush_td;
    p += (line.rec || 0) * scoring.rec;
    p += (line.recYd || 0) * scoring.rec_yd;
    p += (line.recTd || 0) * scoring.rec_td;
    p += (line.fum || 0) * scoring.fum_lost;
    if (pos === 'TE') p += (line.rec || 0) * (scoring.bonus_rec_te || 0);
    return p;
}

/** Projected points per game for the Nth-ranked player at a position. */
export function ppgFor(pos, posRank, scoring) {
    if (FLAT_PPG[pos]) {
        // Scale the flat curve if the league uses unusual K/DST scoring magnitudes.
        return FLAT_PPG[pos](posRank);
    }
    return scoreStatLine(statLine(pos, posRank), scoring, pos);
}

/** Expected games missed for the rest of the season, by Sleeper injury tag. */
const GAMES_MISSED = {
    Questionable: 0.3,
    Doubtful: 0.8,
    Out: 1,
    IR: 7,
    PUP: 7,
    NA: 3,
    Sus: 2,
    COV: 1,
    DNR: 99,
};

export function availability(player, weeksLeft) {
    if (!player?.injury || weeksLeft <= 0) return 1;
    const missed = GAMES_MISSED[player.injury] ?? 0.5;
    return clamp((weeksLeft - missed) / weeksLeft, 0.03, 1);
}

/** Positional aging curves, used only in dynasty/keeper formats. */
// `decline` is the annual decay in expected production once a player is past
// peak. It is deliberately steeper than raw aging curves because it also
// absorbs survival risk: an aging back does not gently lose 10% a year, he
// loses the job. The running back cliff is the sharpest effect in fantasy and
// the constants say so.
const AGE_CURVE = {
    QB: { peak: 29, decline: 0.09, ramp: 0.05 },
    RB: { peak: 25, decline: 0.3, ramp: 0.03 },
    WR: { peak: 26, decline: 0.14, ramp: 0.06 },
    TE: { peak: 27, decline: 0.12, ramp: 0.08 },
    K: { peak: 30, decline: 0.04, ramp: 0.01 },
    DEF: { peak: 28, decline: 0.02, ramp: 0.01 },
};

export function ageFactor(pos, age) {
    const c = AGE_CURVE[pos] || AGE_CURVE.WR;
    if (age === null || age === undefined) return 1;
    if (age <= c.peak) return clamp(1 - c.ramp * (c.peak - age), 0.6, 1);
    return Math.exp(-c.decline * (age - c.peak));
}

/**
 * Points-per-game by positional rank, taken from where real projections
 * actually land rather than from a fitted shape.
 *
 * The curve is the sorted list of projected per-game points at a position under
 * this league's scoring. Rank 1 is the best projection, rank 2 the second, and
 * so on. This is what gives the gaps between ranks their true size: the drop
 * from QB1 to QB2 and the drop from RB1 to RB2 are different shapes in reality,
 * and no single formula captures both.
 */
function buildCurves({ cfg, projections, actuals, week }) {
    if (!projections) return null;
    const buckets = {};
    for (const pos of ALL_POS) buckets[pos] = [];

    for (const [id, proj] of Object.entries(projections)) {
        if (!buckets[proj.pos]) continue;
        const ppg = blendedPpg({
            projection: proj,
            actual: actuals?.[id] || null,
            scoring: cfg.scoring,
            week,
        });
        if (ppg === null || !Number.isFinite(ppg)) continue;
        buckets[proj.pos].push(ppg);
    }

    const curves = {};
    let any = false;
    for (const pos of ALL_POS) {
        const list = buckets[pos].sort((a, b) => b - a);
        if (list.length >= 8) {
            curves[pos] = list;
            any = true;
        }
    }
    return any ? curves : null;
}

/**
 * Per-game points for the Nth-ranked player at a position.
 *
 * Beyond the end of the projected pool the curve is continued by decaying the
 * last real value, so a deep-bench rank still gets a distinct, sensible number
 * instead of falling off a cliff or colliding with its neighbours.
 */
function curveLookup(curve, rank, fallback) {
    if (!curve || !curve.length) return fallback();
    const i = Math.max(1, Math.round(rank)) - 1;
    if (i < curve.length) return curve[i];
    const last = curve[curve.length - 1];
    const overshoot = i - curve.length + 1;
    return last * Math.exp(-0.05 * overshoot);
}

/**
 * A below-replacement player is not worthless, and a player sitting exactly at
 * replacement is not worth zero. He is a bye-week fill-in, injury insurance and
 * trade filler, and a hard floor at zero erases the ordering among every depth
 * piece in the league -- which is how a real starting running back ended up
 * displaying the same value as a fourth-string handcuff.
 *
 * Softplus keeps the number strictly decreasing with rank, positive everywhere,
 * and asymptotically equal to points-above-replacement for players who are
 * actually starters.
 */
export function softplusPar(par, k = 1.25) {
    const x = par / k;
    // log1p(exp(x)) computed stably for large |x|.
    return k * (x > 30 ? x : Math.log1p(Math.exp(x)));
}

/**
 * Build a valuation context once per (league, rankings, week) and reuse it for
 * every player lookup. Recomputing replacement levels per player would be the
 * single hottest line in the simulator otherwise.
 */
export function createValuationContext(cfg, {
    week = 1,
    weeksLeft = 14,
    horizonYears = 4,
    discount = 0.85,
    projections = null,
    actuals = null,
} = {}) {
    const replacement = replacementRanks(cfg);
    const curves = buildCurves({ cfg, projections, actuals, week });

    const ppgAtRank = (pos, rank) =>
        curveLookup(curves?.[pos], rank, () => ppgFor(pos, rank, cfg.scoring));

    const replacementPpg = {};
    for (const pos of ALL_POS) replacementPpg[pos] = ppgAtRank(pos, replacement[pos]);

    return {
        cfg,
        week,
        weeksLeft,
        replacement,
        replacementPpg,
        curves,
        projections,
        actuals,
        ppgAtRank,
        // True when values are grounded in real projections rather than the
        // fallback model. Surfaced in the UI so the numbers are never
        // silently synthetic.
        projected: !!curves,
        horizonYears: cfg.format === 'redraft' ? 1 : horizonYears,
        discount,
        dynasty: cfg.format !== 'redraft',
    };
}

/**
 * Everything the rest of the app needs to know about one player's worth.
 *
 * Value follows the user's ranking, not the projection: if you have Pollard as
 * your RB20, he is worth what an RB20 is worth. The projection sets the scale
 * of the curve; your board decides where each player sits on it. Both numbers
 * are returned so the UI can show where you disagree with the projection.
 *
 * @param {object} player  trimmed Sleeper player record
 * @param {number} posRank the user's positional rank for this player
 * @param {object} ctx     from createValuationContext
 */
export function valuePlayer(player, posRank, ctx) {
    const pos = player.pos;
    const ppg = ctx.ppgAtRank ? ctx.ppgAtRank(pos, posRank) : ppgFor(pos, posRank, ctx.cfg.scoring);
    const repl = ctx.replacementPpg[pos] ?? 0;
    const avail = availability(player, ctx.weeksLeft);

    const parPerGame = ppg - repl;
    // Depth still counts for something; see softplusPar.
    const effectivePar = softplusPar(parPerGame);

    const ros = effectivePar * ctx.weeksLeft * avail;

    let value = ros;
    if (ctx.dynasty) {
        const af = ageFactor(pos, player.age);
        const seasonLength = 14;
        for (let y = 1; y < ctx.horizonYears; y++) {
            const future = ageFactor(pos, (player.age ?? 26) + y) / (af || 1);
            value += effectivePar * seasonLength * future * ctx.discount ** y;
        }
    }

    const own = ctx.projections?.[player.id] || null;
    const ownPpg = own ? projectedPpg(own, ctx.cfg.scoring) : null;

    return {
        player,
        posRank,
        ppg,
        effectivePpg: ppg * avail,
        parPerGame,
        availability: avail,
        ros,
        value,
        replacementPpg: repl,
        // The player's own projection, independent of where he is ranked.
        projection: own,
        projectedPpg: ownPpg,
        projectedRank: ownPpg !== null ? projectedRankOf(ctx, pos, ownPpg) : null,
    };
}

/** Where a per-game number would land on the position's projected curve. */
function projectedRankOf(ctx, pos, ppg) {
    const curve = ctx.curves?.[pos];
    if (!curve) return null;
    let lo = 0;
    let hi = curve.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (curve[mid] > ppg) lo = mid + 1;
        else hi = mid;
    }
    return lo + 1;
}

/**
 * Map raw value onto the 0-100 scale people expect from a trade calculator.
 * Anchored so that the best player in the league lands near 100 and a
 * replacement-level body lands at 0.
 */
export function makeValueScaler(values) {
    const top = Math.max(1, ...values);
    return (v) => clamp(Math.round((v / top) * 100 * 10) / 10, -25, 100);
}
