// Start/Sit engine.
//
// The weekly projection is the starting point, not the answer. Four adjustments
// are layered on top of it, each computed from real data and each reported
// separately so a recommendation can always be explained:
//
//   Vegas    -- implied team total. The best available proxy for how many
//               points a player's offense will actually have to distribute.
//   Matchup  -- how this defense has treated the position, normalized against
//               each player's own baseline.
//   Weather  -- wind and precipitation, position-weighted. Domes excluded.
//   Health   -- injury designation discounted by expected availability.
//
// The output is an adjusted projection, a confidence level, and a lineup built
// by the same optimizer the trade engine uses.

import { optimizeLineup } from './lineup.js';
import { scoreStats } from './projections.js';
import { availability } from './valuation.js';
import { matchupImpact, rankDefenses, describeMatchup } from './matchup.js';
import { weatherImpact, describeWeather } from './weather.js';
import { describeEnvironment } from './odds.js';
import { clamp, round, sortBy } from './util.js';

/**
 * Fallback neutral implied total, used only when no slate is available.
 * The real neutral point is computed from the week's actual lines: comparing a
 * team against a hardcoded 22.5 makes every player look like a bad spot in a
 * low-scoring week, which is exactly backwards -- a start/sit call is a
 * comparison between the options on THIS slate.
 */
const FALLBACK_IMPLIED = 22.5;

/** Mean implied team total across every game with a posted line. */
export function slateAverage(oddsByTeam) {
    const totals = [];
    for (const ctx of oddsByTeam?.values() || []) {
        if (Number.isFinite(ctx.impliedTotal)) totals.push(ctx.impliedTotal);
    }
    if (!totals.length) return FALLBACK_IMPLIED;
    return totals.reduce((a, b) => a + b, 0) / totals.length;
}

/**
 * Vegas adjustment. A player's ceiling is bounded by how many points his team
 * scores, so the implied total moves everyone on that offense together --
 * more for the positions that depend on touchdowns.
 */
export function vegasImpact(impliedTotal, pos, neutral = FALLBACK_IMPLIED) {
    if (!Number.isFinite(impliedTotal)) return { multiplier: 1, known: false };
    const ratio = impliedTotal / (neutral || FALLBACK_IMPLIED);
    const sensitivity = { QB: 0.55, RB: 0.45, WR: 0.5, TE: 0.5, K: 0.7, DEF: 0 }[pos] ?? 0.45;
    const multiplier = clamp(1 + (ratio - 1) * sensitivity, 0.78, 1.25);
    return { multiplier, known: true, impliedTotal };
}

/**
 * A defense is the one position whose outlook improves when its OPPONENT is
 * expected to score less, so it gets the inverted treatment.
 */
export function defenseVegasImpact(opponentImplied, neutral = FALLBACK_IMPLIED) {
    if (!Number.isFinite(opponentImplied)) return { multiplier: 1, known: false };
    const ratio = (neutral || FALLBACK_IMPLIED) / Math.max(10, opponentImplied);
    return { multiplier: clamp(1 + (ratio - 1) * 0.6, 0.75, 1.3), known: true };
}

/**
 * Evaluate one player for one week.
 *
 * @param {object} input
 * @param {object} input.player      trimmed Sleeper player
 * @param {object} input.weekly      this week's projection row for him
 * @param {object} input.scoring     league scoring settings
 * @param {Map}    input.oddsByTeam  team -> game context
 * @param {Map}    input.weatherByHome home team -> forecast
 * @param {Map}    input.defenseProfiles
 * @param {Map}    input.gamesByTeam team -> game (for venue/home lookup)
 */
export function evaluatePlayerWeek(input) {
    const {
        player, weekly, scoring, oddsByTeam, weatherByHome, defenseProfiles,
        defenseRanks, weeksLeft = 1, neutralImplied = null,
    } = input;
    const neutral = neutralImplied ?? slateAverage(oddsByTeam);

    const base = weekly ? scoreStats(weekly.stats, scoring) : null;
    const opponent = weekly?.opponent || null;
    const odds = oddsByTeam?.get(player.team) || null;

    const factors = [];
    let multiplier = 1;

    // --- Vegas ------------------------------------------------------------
    const vegas = player.pos === 'DEF'
        ? defenseVegasImpact(odds?.opponentImplied, neutral)
        : vegasImpact(odds?.impliedTotal, player.pos, neutral);
    if (vegas.known) {
        multiplier *= vegas.multiplier;
        factors.push({
            kind: 'vegas',
            label: 'Vegas',
            multiplier: vegas.multiplier,
            detail: player.pos === 'DEF'
                ? `Opponent implied for ${round(odds.opponentImplied, 1)} points.`
                : (describeEnvironment(odds, neutral)?.text ?? `Team implied for ${round(odds.impliedTotal, 1)} points.`),
            tone: vegas.multiplier > 1.04 ? 'good' : vegas.multiplier < 0.96 ? 'bad' : 'neutral',
        });
    }

    // --- Matchup ----------------------------------------------------------
    const matchup = matchupImpact(defenseProfiles, opponent, player.pos);
    if (matchup.known) {
        multiplier *= matchup.multiplier;
        const rankInfo = defenseRanks?.[player.pos]?.find((d) => d.def === opponent) || null;
        const desc = describeMatchup(rankInfo, player.pos);
        factors.push({
            kind: 'matchup',
            label: 'Matchup',
            multiplier: matchup.multiplier,
            detail: desc?.text || `vs ${opponent}.`,
            tone: desc?.tone || 'neutral',
        });
    }

    // --- Weather ----------------------------------------------------------
    const homeTeam = odds?.home ? player.team : odds?.opponent || null;
    const wx = homeTeam ? weatherByHome?.get(homeTeam) : null;
    const weather = weatherImpact(wx, player.pos);
    if (wx && weather.severity !== 'none') {
        multiplier *= weather.multiplier;
        factors.push({
            kind: 'weather',
            label: 'Weather',
            multiplier: weather.multiplier,
            detail: weather.notes.join(' ') || describeWeather(wx),
            tone: weather.multiplier < 0.96 ? 'bad' : 'neutral',
        });
    }

    // --- Health -----------------------------------------------------------
    const avail = availability(player, Math.max(1, weeksLeft));
    const healthMult = player.injury ? clamp(avail, 0.05, 1) : 1;
    if (player.injury) {
        multiplier *= healthMult;
        factors.push({
            kind: 'health',
            label: 'Health',
            multiplier: healthMult,
            detail: `${player.injury}${player.injuryBody ? ` (${player.injuryBody})` : ''}${player.practice ? ` · ${player.practice} in practice` : ''}.`,
            tone: 'bad',
        });
    }

    const hasGame = !!weekly && !!opponent;
    const adjusted = base === null ? null : base * multiplier;

    return {
        player,
        opponent,
        hasGame,
        baseProjection: base,
        adjusted,
        multiplier,
        factors: sortBy(factors, (f) => Math.abs(f.multiplier - 1), -1),
        weather: wx || null,
        odds,
        confidence: confidenceOf({ base, factors, hasGame, injury: player.injury }),
    };
}

/**
 * Confidence is about how much we know, not how good the player is. A healthy
 * player in a dome with a well-sampled matchup is a confident call; a
 * questionable player in a windy game with no matchup history is not.
 */
function confidenceOf({ base, factors, hasGame, injury }) {
    if (!hasGame) return { level: 'none', score: 0, why: 'No game this week.' };
    let score = 0.8;
    const why = [];

    if (injury) {
        score -= 0.3;
        why.push('injury designation');
    }
    const weather = factors.find((f) => f.kind === 'weather');
    if (weather && weather.multiplier < 0.94) {
        score -= 0.12;
        why.push('weather risk');
    }
    if (!factors.some((f) => f.kind === 'matchup')) {
        score -= 0.08;
        why.push('little matchup history');
    }
    if (base !== null && base < 6) {
        score -= 0.1;
        why.push('low projected volume');
    }

    const clamped = clamp(score, 0.05, 0.95);
    return {
        level: clamped > 0.7 ? 'high' : clamped > 0.45 ? 'medium' : 'low',
        score: clamped,
        why: why.length ? `Lowered by ${why.join(', ')}.` : 'Healthy, with a well-understood matchup.',
    };
}

/**
 * Full weekly report for one roster: the recommended lineup, who is being sat,
 * and the close calls worth a second look.
 */
export function buildStartSitReport({ team, cfg, evaluations }) {
    const entries = evaluations
        .filter((e) => e.adjusted !== null)
        .map((e) => ({ player: e.player, score: e.adjusted, evaluation: e }));

    // Players with no game this week can never be started.
    const benchedByBye = evaluations.filter((e) => !e.hasGame);

    const lineup = optimizeLineup(entries, cfg.starterSlots);
    const startingIds = new Set(lineup.starters.map((s) => s.entry.player.id));

    const bench = sortBy(
        entries.filter((e) => !startingIds.has(e.player.id)),
        (e) => e.score,
        -1
    );

    // A close call is a benched player within a small margin of a starter he
    // could legally replace -- those are the only decisions actually in doubt.
    const closeCalls = [];
    for (const benched of bench.slice(0, 6)) {
        for (const slot of lineup.starters) {
            const starter = slot.entry;
            if (starter.player.pos !== benched.player.pos) continue;
            const gap = starter.score - benched.score;
            if (gap >= 0 && gap <= 2.5) {
                closeCalls.push({
                    start: starter,
                    sit: benched,
                    gap,
                    slot: slot.label,
                });
            }
        }
    }

    return {
        team,
        lineup,
        bench,
        benchedByBye,
        closeCalls: sortBy(closeCalls, (c) => c.gap).slice(0, 5),
        projectedTotal: lineup.points,
    };
}

/**
 * Difference between the recommended lineup and what the manager currently has
 * set in Sleeper -- the actionable part of the whole view.
 *
 * The naive version of this paired every added player with a dropped one and
 * reported the difference as the "gain", which produced nonsense the moment the
 * positions did not line up: starting a tight end instead of a quarterback came
 * out as a recommendation worth minus ninety-six points. A move is only a swap
 * if the two players compete for the same spot; everything else is an addition
 * or a removal, and the only honest total is the difference between the two
 * complete lineups.
 */
export function lineupChanges(report, currentStarterIds) {
    if (!currentStarterIds?.length) return null;
    const current = new Set(currentStarterIds.filter(Boolean));

    const scoreById = new Map();
    for (const slot of report.lineup.starters) scoreById.set(slot.entry.player.id, slot.entry);
    for (const e of report.bench) scoreById.set(e.player.id, e);

    // Score the current starters through the same slot solver. Summing them
    // raw would count players who cannot legally occupy the slots they are in
    // (Sleeper lineups can be mid-edit, and bye-week players linger), which can
    // make the genuine optimum look like a downgrade.
    const currentEntries = [...current]
        .map((id) => scoreById.get(id))
        .filter(Boolean);
    const currentTotal = optimizeLineup(currentEntries, report.lineup.slots.map((s) => s.slot)).points;

    const toStart = report.lineup.starters
        .filter((s) => !current.has(s.entry.player.id))
        .map((s) => s.entry);
    const toBench = report.bench.filter((e) => current.has(e.player.id));

    // Pair like for like so the UI can show a genuine "start X over Y".
    const swaps = [];
    const unpairedBench = [...toBench];
    for (const add of toStart) {
        const i = unpairedBench.findIndex((d) => d.player.pos === add.player.pos);
        if (i >= 0) {
            const drop = unpairedBench.splice(i, 1)[0];
            swaps.push({ add, drop, gain: add.score - drop.score, paired: true });
        } else {
            swaps.push({ add, drop: null, gain: null, paired: false });
        }
    }
    for (const drop of unpairedBench) {
        swaps.push({ add: null, drop, gain: null, paired: false });
    }

    return {
        swaps: sortBy(swaps, (s) => (s.gain === null ? 0 : -s.gain)),
        // Optimal minus current: always the real number, and never negative
        // for a legal current lineup.
        pointsGained: Math.max(0, report.projectedTotal - currentTotal),
        currentTotal,
        recommendedTotal: report.projectedTotal,
    };
}
