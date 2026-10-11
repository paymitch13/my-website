// Winning the week, rather than scoring the most points.
//
// Every lineup decision in this app used to maximize expected points, and that
// is the wrong objective in a large minority of matchups. You do not get paid
// for points; you get paid for beating one specific opponent. When you are a
// twenty-point underdog, the lineup that maximizes expected points is close to
// the worst thing you can do -- it maximizes the chance of losing by twelve
// instead of giving you a chance of winning. When you are a heavy favourite
// the reverse holds: you want the smallest spread, not the biggest mean,
// because the only way to lose is to be caught.
//
// So: model each side's weekly total as a distribution, and choose the lineup
// that maximizes the probability of ending up ahead.
//
// Two measured inputs make that honest rather than hand-waved.
//
// PER-PLAYER SPREAD. Measured from weeks 1-5 of live data, as a coefficient of
// variation so it applies to any projected level. Startable players only --
// deep bench players have tiny means and absurd ratios. Quarterbacks are the
// steadiest thing in fantasy and tight ends the least steady, which is what
// every manager already believes and is now a number:
//
//     QB 0.324   RB 0.43   WR 0.60   TE 0.68   K 0.42   DEF 0.65
//
// They are scoring-dependent in the direction you would expect: full PPR damps
// a receiver's week to 0.56 by paying for the floor of a six-catch game.
//
// CORRELATION. Summing nine independent player variances gives a team spread
// about 1.41 times smaller than the team-level figure in `teamScoringProfile`,
// which was fitted to real weekly team scores -- and the ratio holds at 1.40
// to 1.42 across strong, average and weak lineups. A stable ratio across
// lineup quality is the signature of correlation rather than of a bad
// per-player number: players share a slate, and a whole week of football runs
// hot or cold together. One average pairwise correlation of 0.125 reproduces
// the fitted team figure exactly for a nine-starter lineup, and unlike a flat
// multiplier it keeps scaling correctly for leagues that start five or twelve.

import { optimizeLineup, positionsFor } from './lineup.js';

/**
 * Weekly standard deviation as a share of a player's own level, by position.
 * Measured; see the note above.
 */
export const POSITION_CV = { QB: 0.324, RB: 0.43, WR: 0.6, TE: 0.68, K: 0.42, DEF: 0.65 };
const DEFAULT_CV = 0.55;

/**
 * Average pairwise correlation between two starters' weekly scores.
 *
 * Calibrated so that summing per-player variances reproduces the team-level
 * spread already fitted in `teamScoringProfile`.
 */
export const PAIRWISE_CORRELATION = 0.125;

/**
 * How many games before a player's own scores outweigh his position's typical
 * spread. A four-game sample deviation is mostly noise, so it is shrunk.
 */
const SAMPLE_WEIGHT_K = 4;

/**
 * One player's weekly standard deviation.
 *
 * His own history where there is enough of it, the position baseline where
 * there is not, and a blend in between -- because four games of a genuinely
 * volatile player and four games of a metronome look far more alike than they
 * are.
 *
 * @param {object} input
 * @param {string} input.pos
 * @param {number} input.mu      his projected level for this week
 * @param {number[]} [input.scores] his actual weekly scores this season
 */
export function playerSigma({ pos, mu, scores = null }) {
    const level = Math.max(0, Number(mu) || 0);
    const baseline = (POSITION_CV[pos] ?? DEFAULT_CV) * level;

    const played = (scores || []).filter((s) => Number.isFinite(s));
    if (played.length < 2) return baseline;

    const mean = played.reduce((a, b) => a + b, 0) / played.length;
    const variance =
        played.reduce((a, b) => a + (b - mean) ** 2, 0) / (played.length - 1);
    // Scaled to his PROJECTED level rather than used raw: the spread we want
    // is around what he is expected to do this week, and a player whose role
    // has changed has a mean that no longer applies.
    const observed = mean > 0 ? (Math.sqrt(variance) / mean) * level : Math.sqrt(variance);

    const w = played.length / (played.length + SAMPLE_WEIGHT_K);
    return Math.max(0, observed * w + baseline * (1 - w));
}

/**
 * The distribution of a lineup's weekly total.
 *
 * @param {Array<{mu:number, sigma:number}>} parts one per starter
 */
export function lineupSpread(parts) {
    const used = (parts || []).filter((p) => p && Number.isFinite(p.mu));
    const mu = used.reduce((a, p) => a + p.mu, 0);
    if (used.length < 2) {
        return { mu, sigma: used[0]?.sigma ?? 0 };
    }
    const sumVar = used.reduce((a, p) => a + (p.sigma || 0) ** 2, 0);
    // Σσ² + ρ · Σ_{i≠j} σᵢσⱼ, with one average ρ. The second term is what the
    // independent sum misses.
    const sumSigma = used.reduce((a, p) => a + (p.sigma || 0), 0);
    const crossTerms = sumSigma ** 2 - sumVar;
    const variance = sumVar + PAIRWISE_CORRELATION * crossTerms;
    return { mu, sigma: Math.sqrt(Math.max(0, variance)) };
}

/** Standard normal CDF. Abramowitz & Stegun 26.2.17, good to ~7.5e-8. */
export function normalCdf(z) {
    if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y =
        1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
            0.254829592) *
            t *
            Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
}

/**
 * The chance this lineup outscores that one.
 *
 * Both totals are treated as normal and independent of each other, which is
 * the standard model and is why a tie is split rather than handled: two real
 * teams playing different games are very nearly independent even though the
 * players inside one lineup are not.
 */
export function winProbability({ mu, sigma }, opponent) {
    if (!opponent || !Number.isFinite(opponent.mu)) return null;
    const spread = mu - opponent.mu;
    const combined = Math.sqrt((sigma || 0) ** 2 + (opponent.sigma || 0) ** 2);
    if (combined <= 0) return spread > 0 ? 1 : spread < 0 ? 0 : 0.5;
    return normalCdf(spread / combined);
}

/**
 * What kind of week this is, which decides whether to chase ceiling or floor.
 *
 * The thresholds are where the advice actually changes rather than round
 * numbers: inside a coin flip either way, the highest-mean lineup is also very
 * nearly the highest-win-probability lineup, so there is nothing to say.
 */
export function matchupPosture(winProb) {
    if (!Number.isFinite(winProb)) return { kind: 'unknown', wants: 'points' };
    if (winProb <= 0.2) return { kind: 'heavy-underdog', wants: 'ceiling' };
    if (winProb <= 0.38) return { kind: 'underdog', wants: 'ceiling' };
    if (winProb >= 0.8) return { kind: 'heavy-favorite', wants: 'floor' };
    if (winProb >= 0.62) return { kind: 'favorite', wants: 'floor' };
    return { kind: 'even', wants: 'points' };
}

export function describePosture(posture, winProb) {
    const pct = Number.isFinite(winProb) ? `${Math.round(winProb * 100)}%` : null;
    switch (posture.kind) {
        case 'heavy-underdog':
            return `You are a heavy underdog this week${pct ? ` — about ${pct} to win` : ''}. ` +
                'The lineup that scores the most on average is not the one most likely to win: play for ceiling, ' +
                'because a narrow loss and a blowout loss pay the same.';
        case 'underdog':
            return `You are an underdog this week${pct ? ` — about ${pct} to win` : ''}. ` +
                'Lean to the higher ceiling where two options are close, since you need the good end of someone’s range.';
        case 'heavy-favorite':
            return `You are a heavy favourite this week${pct ? ` — about ${pct} to win` : ''}. ` +
                'The only way to lose is to be caught, so take the safer floor where two options are close rather than the bigger upside.';
        case 'favorite':
            return `You are favoured this week${pct ? ` — about ${pct} to win` : ''}. ` +
                'Prefer the steadier option where two are close; you do not need the upside.';
        case 'even':
            return `This matchup is close to a coin flip${pct ? ` — about ${pct} to win` : ''}. ` +
                'Start the highest projected lineup: with the spread this tight, the most points is also the best chance of winning.';
        default:
            return 'No opponent found for this week, so these are ranked on projected points alone.';
    }
}

/** Which roster this one plays in a given week, or null. */
export function opponentFor(schedule, week, rosterId) {
    for (const entry of schedule || []) {
        if (Number(entry?.week) !== Number(week)) continue;
        for (const pair of entry.pairs || []) {
            if (!Array.isArray(pair) || pair.length !== 2) continue;
            if (pair[0] === rosterId) return pair[1];
            if (pair[1] === rosterId) return pair[0];
        }
    }
    return null;
}

/**
 * Lineup swaps that raise the chance of winning, even where they lower the
 * expected score.
 *
 * This is the whole point of the module. A swap that costs half a point of
 * projection and adds four points of spread is a bad idea at even money and
 * the correct play when you need a miracle, and nothing in the app could say
 * so before.
 *
 * @param {object} input
 * @param {Array} input.entries   the whole roster, each {player, score, sigma}
 * @param {string[]} input.slots  starting slots
 * @param {{mu:number, sigma:number}} input.opponent
 * @returns {{base: object, swaps: Array}} the optimal-points lineup and the
 *          swaps ranked by how much they move win probability
 */
export function winProbSwaps({ entries, slots, opponent }) {
    const lineup = optimizeLineup(entries, slots);
    const partOf = (e) => ({ mu: e.score ?? 0, sigma: e.sigma ?? playerSigma({ pos: e.player.pos, mu: e.score ?? 0 }) });

    const startingIds = new Set(lineup.starters.map((s) => s.entry.player.id));
    const baseParts = lineup.starters.map((s) => partOf(s.entry));
    const base = lineupSpread(baseParts);
    const baseWin = winProbability(base, opponent);

    const bench = entries.filter((e) => !startingIds.has(e.player.id));
    const swaps = [];

    for (const slot of lineup.slots) {
        if (!slot.entry) continue;
        const allowed = positionsFor(slot.slot);
        const others = lineup.starters.filter((s) => s.entry !== slot.entry).map((s) => partOf(s.entry));

        for (const candidate of bench) {
            if (!allowed.includes(candidate.player.pos)) continue;
            const swapped = lineupSpread([...others, partOf(candidate)]);
            const win = winProbability(swapped, opponent);
            if (win === null || baseWin === null) continue;
            swaps.push({
                slot: slot.slot,
                out: slot.entry,
                in: candidate,
                pointsDelta: (candidate.score ?? 0) - (slot.entry.score ?? 0),
                spreadDelta: swapped.sigma - base.sigma,
                winDelta: win - baseWin,
                win,
            });
        }
    }

    swaps.sort((a, b) => b.winDelta - a.winDelta);
    return { base, baseWin, swaps };
}

/**
 * The swaps worth putting in front of someone: they raise the chance of
 * winning while LOWERING the projected score, which is exactly the advice no
 * projection-ranked list can give.
 */
export function contrarianSwaps(result, { minWinDelta = 0.01 } = {}) {
    return (result?.swaps || []).filter((s) => s.winDelta >= minWinDelta && s.pointsDelta < 0);
}
