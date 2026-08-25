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
import { SLOT_ELIGIBILITY } from './league.js';
import { scoreStats } from './projections.js';
import { weeklyPlayProbability, ruledOutThisWeek } from './valuation.js';
import { matchupImpact, describeMatchup } from './matchup.js';
import { weatherImpact, describeWeather } from './weather.js';
import { describeEnvironment, describeMovement, gameScript } from './odds.js';
import { marketPoints, disagreement, blendMarket } from './props.js';
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
        defenseRanks, weeksLeft = 1, neutralImplied = null, onBye = false,
        marketRow = null,
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

    // --- Game script ------------------------------------------------------
    // A heavy favorite runs it out; a heavy underdog throws forty times. Both
    // move fantasy production, in opposite directions, per position.
    const script = gameScript(odds);
    if (script && script.kind !== 'even') {
        const pass = player.pos === 'WR' || player.pos === 'TE' || player.pos === 'QB';
        const table = {
            'heavy-favorite': pass ? 0.955 : 1.06,
            favorite: pass ? 0.985 : 1.02,
            'heavy-underdog': pass ? 1.05 : 0.93,
            underdog: pass ? 1.02 : 0.975,
        };
        const mult = table[script.kind] ?? 1;
        if (mult !== 1) {
            multiplier *= mult;
            factors.push({
                kind: 'script',
                label: 'Script',
                multiplier: mult,
                detail: script.text,
                tone: mult > 1 ? 'good' : 'bad',
            });
        }
    }

    // --- Line movement ----------------------------------------------------
    // A total that has fallen since opening reflects weather, injury or news a
    // preseason projection has not absorbed.
    const moves = describeMovement(odds);
    const totalMove = moves.find((m) => m.kind === 'total');
    if (totalMove && odds?.movement?.total) {
        const change = odds.movement.total.change;
        const mult = clamp(1 + change * 0.006, 0.94, 1.06);
        if (Math.abs(mult - 1) > 0.005) {
            multiplier *= mult;
            factors.push({
                kind: 'movement',
                label: 'Line move',
                multiplier: mult,
                detail: totalMove.text,
                tone: change > 0 ? 'good' : 'bad',
            });
        }
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
    // Weekly probability of playing, NOT the rest-of-season discount.
    const playProbability = weeklyPlayProbability(player);
    const ruledOut = ruledOutThisWeek(player);
    if (player.injury) {
        multiplier *= playProbability;
        factors.push({
            kind: 'health',
            label: 'Health',
            multiplier: playProbability,
            detail: ruledOut
                ? `${player.injury}${player.injuryBody ? ` (${player.injuryBody})` : ''} — not playing this week.`
                : `${player.injury}${player.injuryBody ? ` (${player.injuryBody})` : ''}${player.practice ? ` · ${player.practice} in practice` : ''}. Roughly ${Math.round(playProbability * 100)}% to suit up.`,
            tone: 'bad',
        });
    }

    // A player who is not playing cannot be started, exactly like a bye.
    const hasGame = !!weekly && !!opponent && !ruledOut && !onBye;
    let adjusted = base === null || ruledOut || onBye ? null : base * multiplier;

    // --- The betting market as a second projection -------------------------
    // Every other number here descends from one consensus projection. A posted
    // player prop is a number with money behind it, so where the two disagree
    // that is worth both blending in and saying out loud -- it is the single
    // most actionable line a start/sit tool can print.
    const market = marketRow ? marketPoints(marketRow, scoring) : null;
    const gap = market !== null && base !== null ? disagreement(market, base) : null;
    if (market !== null && adjusted !== null) {
        // Blend the RAW projections, then re-apply the situational multiplier:
        // the market line already prices the opponent, but not the weather or
        // the injury discount this engine adds on top.
        adjusted = blendMarket(market, base) * multiplier;
        if (gap) {
            factors.push({
                kind: 'market',
                label: 'Vegas props',
                // Reported as the ratio it actually moved the number by.
                multiplier: base > 0 ? blendMarket(market, base) / base : 1,
                detail: gap.text,
                tone: gap.direction === 'higher' ? 'good' : 'bad',
            });
        }
    }

    return {
        player,
        opponent,
        hasGame,
        ruledOut,
        onBye,
        playProbability,
        baseProjection: base,
        marketProjection: market,
        marketDisagreement: gap,
        marketMovement: marketRow?.movement ?? null,
        adjusted,
        multiplier,
        factors: sortBy(factors, (f) => Math.abs(f.multiplier - 1), -1),
        weather: wx || null,
        odds,
        confidence: confidenceOf({ base, factors, hasGame, injury: player.injury, ruledOut }),
    };
}

/**
 * Confidence is about how much we know, not how good the player is. A healthy
 * player in a dome with a well-sampled matchup is a confident call; a
 * questionable player in a windy game with no matchup history is not.
 */
function confidenceOf({ base, factors, hasGame, injury, ruledOut }) {
    if (ruledOut) return { level: 'none', score: 0, why: 'Ruled out — he is not playing.' };
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

    // Players who cannot be started this week: bye, no game, or ruled out.
    const unavailable = evaluations.filter((e) => !e.hasGame);

    const lineup = optimizeLineup(entries, cfg.starterSlots);
    const startingIds = new Set(lineup.starters.map((s) => s.entry.player.id));

    const bench = sortBy(
        entries.filter((e) => !startingIds.has(e.player.id)),
        (e) => e.score,
        -1
    );

    // Every decision on the roster, one per starting slot.
    //
    // This used to be "close calls": benched players within 2.5 points of a
    // starter, drawn from the top eight on the bench. Both limits hid real
    // decisions. Two quarterbacks four points apart are still the only two
    // quarterbacks you own, and the ninth man on the bench is exactly who you
    // are wondering about when somebody is questionable. A start/sit tool that
    // answers only the questions it considers difficult is not answering the
    // question the manager came with.
    //
    // So: for each slot, everyone eligible to fill it, ranked. The gap is
    // reported rather than used as a filter.
    const decisions = lineup.starters.map((slot) => {
        const eligible = SLOT_ELIGIBILITY[slot.slot] || [];
        const alternatives = bench
            .filter((e) => eligible.includes(e.player.pos))
            .map((e) => ({ entry: e, gap: slot.entry.score - e.score }));

        return {
            slot: slot.slot,
            label: slot.label,
            starter: slot.entry,
            alternatives: sortBy(alternatives, (a) => a.gap),
            // How safe the call is: the margin over the best alternative.
            margin: alternatives.length ? Math.min(...alternatives.map((a) => a.gap)) : null,
        };
    });

    // The subset that is genuinely in doubt, kept for the summary tile and for
    // anyone who wants the short version.
    const closeCalls = [];
    const seen = new Set();
    for (const d of decisions) {
        for (const alt of d.alternatives) {
            if (alt.gap < 0 || alt.gap > 2.5) continue;
            const key = `${d.starter.player.id}:${alt.entry.player.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            closeCalls.push({
                start: d.starter,
                sit: alt.entry,
                gap: alt.gap,
                slot: d.label,
                // A cross-position call is the flex question specifically.
                crossPosition: d.starter.player.pos !== alt.entry.player.pos,
            });
        }
    }

    return {
        team,
        lineup,
        bench,
        unavailable,
        decisions,
        closeCalls: sortBy(closeCalls, (c) => c.gap).slice(0, 5),
        projectedTotal: lineup.points,
    };
}

/**
 * Two players, side by side, with the reason one is ahead.
 *
 * Every other surface on this page ranks a list. This answers the question a
 * manager actually types into a group chat -- "Nix or Herbert?" -- which is not
 * the same question as "what is my optimal lineup" and was not answerable here
 * at all: unless the two happened to land within 2.5 points of each other on
 * the same slot, the app had nothing to say about them.
 */
export function comparePlayers(a, b) {
    if (!a || !b) return null;

    const scoreOf = (e) => (Number.isFinite(e.adjusted) ? e.adjusted : null);
    const [sa, sb] = [scoreOf(a), scoreOf(b)];

    // Which factors actually separate them. A factor both players share -- two
    // men in the same game, in the same weather -- explains nothing about the
    // choice between them, however large it is.
    const factorOf = (e, kind) => e.factors?.find((f) => f.kind === kind)?.multiplier ?? 1;
    const kinds = ['vegas', 'matchup', 'weather', 'health', 'market'];
    const swings = kinds
        .map((kind) => ({ kind, a: factorOf(a, kind), b: factorOf(b, kind) }))
        .map((row) => ({ ...row, edge: row.a - row.b }))
        .filter((row) => Math.abs(row.edge) >= 0.02);

    const gap = sa !== null && sb !== null ? sa - sb : null;
    const leader = gap === null ? null : gap > 0 ? a : b;
    const trailer = leader === a ? b : a;

    return {
        a,
        b,
        gap,
        leader,
        trailer,
        // Ranked by how much each factor separates them, biggest first.
        swings: sortBy(swings, (s) => Math.abs(s.edge), -1),
        // A start/sit call inside a point is a coin flip, and saying so is more
        // useful than manufacturing a reason.
        tooClose: gap !== null && Math.abs(gap) < 1,
        blocked: !a.hasGame || !b.hasGame || a.ruledOut || b.ruledOut,
    };
}

/** One sentence explaining a head-to-head. */
export function describeComparison(cmp) {
    if (!cmp) return '';
    if (cmp.blocked) {
        const out = [cmp.a, cmp.b].filter((e) => !e.hasGame || e.ruledOut);
        return `${out.map((e) => e.player.name).join(' and ')} cannot be started this week, so this is not a decision.`;
    }
    if (cmp.gap === null) return 'Neither player has a usable projection this week.';
    if (cmp.tooClose) {
        return `${round(Math.abs(cmp.gap), 1)} points apart — a coin flip. Start whichever you would rather be wrong about.`;
    }

    const top = cmp.swings[0];
    const because = top
        ? {
              vegas: 'his offence is expected to score more',
              matchup: 'the matchup is softer',
              weather: 'the weather is kinder',
              health: 'he is the healthier of the two',
              market: 'the betting market is higher on him',
          }[top.kind]
        : null;

    return (
        `${cmp.leader.player.name} by ${round(Math.abs(cmp.gap), 1)} points` +
        (because ? `, mostly because ${because}.` : '.')
    );
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
