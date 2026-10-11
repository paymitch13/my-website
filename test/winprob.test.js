// Winning the week rather than scoring the most points.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    POSITION_CV,
    PAIRWISE_CORRELATION,
    playerSigma,
    lineupSpread,
    normalCdf,
    winProbability,
    matchupPosture,
    describePosture,
    opponentFor,
    winProbSwaps,
    contrarianSwaps,
} from '../js/winprob.js';
import { teamScoringProfile } from '../js/lineup.js';

const mk = (id, pos, score, sigma = null) => ({
    player: { id, pos, name: `${pos}-${id}` },
    score,
    points: score,
    value: score * 10,
    ...(sigma === null ? {} : { sigma }),
});

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];

// --- The spread model ------------------------------------------------------

test('a quarterback is steadier than a tight end at the same level', () => {
    assert.ok(
        playerSigma({ pos: 'QB', mu: 15 }) < playerSigma({ pos: 'TE', mu: 15 }),
        'measured weekly variation says QB 0.324 against TE 0.68'
    );
});

test('a player’s own history pulls his spread away from his position’s', () => {
    const level = 12;
    const baseline = playerSigma({ pos: 'RB', mu: level });
    // A metronome and a boom-bust back, same mean, same projected level.
    const steady = playerSigma({ pos: 'RB', mu: level, scores: [12, 12, 11, 13, 12] });
    const wild = playerSigma({ pos: 'RB', mu: level, scores: [2, 28, 1, 25, 4] });
    assert.ok(steady < baseline, `${steady} should sit below the ${baseline} baseline`);
    assert.ok(wild > baseline, `${wild} should sit above the ${baseline} baseline`);
    assert.ok(wild > steady * 2);
});

test('one or two games is not enough to override the position', () => {
    const baseline = playerSigma({ pos: 'WR', mu: 10 });
    assert.equal(playerSigma({ pos: 'WR', mu: 10, scores: [] }), baseline);
    assert.equal(playerSigma({ pos: 'WR', mu: 10, scores: [30] }), baseline);
    // Two games move it, but only a little: the sample carries 2/(2+4).
    const two = playerSigma({ pos: 'WR', mu: 10, scores: [0, 30] });
    assert.ok(two > baseline && two < baseline * 2.2, `two games gave ${two} against ${baseline}`);
});

test('an unknown position still gets a spread rather than zero', () => {
    assert.ok(playerSigma({ pos: 'LB', mu: 10 }) > 0);
});

test('the correlation model reproduces the fitted team spread', () => {
    // `teamScoringProfile` was fitted to real weekly team scores. Summing
    // per-player variances as if independent lands about 1.41x below it, and
    // one average pairwise correlation closes that gap -- which is the whole
    // justification for PAIRWISE_CORRELATION being a measured constant rather
    // than a guess.
    const parts = [
        ['QB', 21], ['RB', 17], ['RB', 14], ['WR', 16], ['WR', 13],
        ['TE', 11], ['RB', 12], ['K', 9], ['DEF', 8],
    ].map(([pos, mu]) => ({ mu, sigma: POSITION_CV[pos] * mu }));

    const modelled = lineupSpread(parts);
    const fitted = teamScoringProfile(modelled.mu);
    assert.ok(
        Math.abs(modelled.sigma / fitted.sigma - 1) < 0.05,
        `modelled ${modelled.sigma.toFixed(1)} against fitted ${fitted.sigma.toFixed(1)}`
    );
    assert.ok(PAIRWISE_CORRELATION > 0, 'ignoring correlation would understate every matchup’s uncertainty');
});

test('a lineup spread exceeds the independent sum', () => {
    const parts = [{ mu: 10, sigma: 5 }, { mu: 10, sigma: 5 }, { mu: 10, sigma: 5 }];
    const independent = Math.sqrt(3 * 25);
    assert.ok(lineupSpread(parts).sigma > independent);
});

test('a one-man lineup has that man’s spread, not an inflated one', () => {
    assert.equal(lineupSpread([{ mu: 10, sigma: 4 }]).sigma, 4);
    assert.equal(lineupSpread([]).mu, 0);
});

// --- Win probability -------------------------------------------------------

test('the normal CDF is accurate at the textbook points', () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(normalCdf(1.645) - 0.95) < 1e-3);
    assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
    assert.ok(Math.abs(normalCdf(2.326) - 0.99) < 1e-3);
});

test('two identical teams are a coin flip', () => {
    const me = { mu: 110, sigma: 25 };
    assert.ok(Math.abs(winProbability(me, { ...me }) - 0.5) < 1e-9);
});

test('being ahead on projection is worth less when the spread is wide', () => {
    const lead = { mu: 120, sigma: 25 };
    const tight = winProbability({ mu: 120, sigma: 5 }, { mu: 110, sigma: 5 });
    const loose = winProbability(lead, { mu: 110, sigma: 25 });
    assert.ok(tight > loose, 'a ten-point edge is nearly safe at low variance and barely an edge at high');
});

test('a matchup with no opponent has no probability to report', () => {
    assert.equal(winProbability({ mu: 100, sigma: 20 }, null), null);
    assert.equal(winProbability({ mu: 100, sigma: 20 }, { mu: NaN }), null);
});

// --- Posture ---------------------------------------------------------------

test('posture asks for ceiling when behind and floor when ahead', () => {
    assert.equal(matchupPosture(0.1).wants, 'ceiling');
    assert.equal(matchupPosture(0.3).wants, 'ceiling');
    assert.equal(matchupPosture(0.5).wants, 'points');
    assert.equal(matchupPosture(0.7).wants, 'floor');
    assert.equal(matchupPosture(0.9).wants, 'floor');
});

test('a coin flip is told to just start the best lineup', () => {
    // Inside an even matchup the highest-mean lineup is very nearly the
    // highest-win-probability lineup, so inventing advice would be noise.
    assert.match(describePosture(matchupPosture(0.5), 0.5), /highest projected lineup/);
});

test('posture copes with no opponent', () => {
    assert.equal(matchupPosture(null).kind, 'unknown');
    assert.match(describePosture(matchupPosture(null), null), /No opponent/);
});

// --- Finding the opponent --------------------------------------------------

test('the opponent is read off the league schedule, either side of the pair', () => {
    const schedule = [
        { week: 5, pairs: [[1, 2], [3, 4]] },
        { week: 6, pairs: [[1, 3], [2, 4]] },
    ];
    assert.equal(opponentFor(schedule, 5, 1), 2);
    assert.equal(opponentFor(schedule, 5, 2), 1);
    assert.equal(opponentFor(schedule, 6, 1), 3);
    assert.equal(opponentFor(schedule, 5, 99), null, 'a roster not playing has no opponent');
    assert.equal(opponentFor(schedule, 9, 1), null, 'a week with no matchups published');
    assert.equal(opponentFor(null, 5, 1), null);
});

test('a bye or an odd-sized league does not produce a phantom opponent', () => {
    const schedule = [{ week: 5, pairs: [[1, 2], [3]] }];
    assert.equal(opponentFor(schedule, 5, 3), null);
});

// --- The decision itself ---------------------------------------------------

/**
 * A roster with a deliberate choice in the flex: a steady back projected
 * higher, and a boom-bust receiver projected lower with a far wider range.
 */
const rosterWithAChoice = () => [
    mk('qb', 'QB', 20, 6),
    mk('rb1', 'RB', 16, 6),
    mk('rb2', 'RB', 13, 5),
    mk('wr1', 'WR', 15, 8),
    mk('wr2', 'WR', 12, 7),
    mk('te', 'TE', 9, 6),
    mk('k', 'K', 8, 3),
    mk('def', 'DEF', 7, 4),
    // The flex battle.
    mk('steady', 'RB', 11, 3),
    mk('swing', 'WR', 9.5, 14),
];

test('a big underdog is offered the swing player despite fewer points', () => {
    const entries = rosterWithAChoice();
    const strongOpponent = { mu: 150, sigma: 25 };
    const result = winProbSwaps({ entries, slots: SLOTS, opponent: strongOpponent });

    assert.ok(result.baseWin < 0.2, `fixture should be a heavy underdog, got ${result.baseWin}`);
    const picks = contrarianSwaps(result);
    assert.ok(picks.length > 0, 'a heavy underdog must be offered a variance play');
    const swing = picks.find((s) => s.in.player.id === 'swing');
    assert.ok(swing, 'the boom-bust receiver is the variance play here');
    assert.ok(swing.pointsDelta < 0, 'it costs projected points, which is the point');
    assert.ok(swing.winDelta > 0, 'and it raises the chance of winning anyway');
});

test('a heavy favourite is NOT offered the swing player', () => {
    const entries = rosterWithAChoice();
    const weakOpponent = { mu: 70, sigma: 25 };
    const result = winProbSwaps({ entries, slots: SLOTS, opponent: weakOpponent });

    assert.ok(result.baseWin > 0.8, `fixture should be a heavy favourite, got ${result.baseWin}`);
    assert.equal(
        contrarianSwaps(result).length,
        0,
        'with the week already won, giving up points for variance is strictly bad'
    );
});

test('the same roster gets opposite advice from the same code', () => {
    // The point of the whole module: the right lineup depends on the opponent,
    // and nothing in the app could express that before.
    const entries = rosterWithAChoice();
    const behind = winProbSwaps({ entries, slots: SLOTS, opponent: { mu: 150, sigma: 25 } });
    const ahead = winProbSwaps({ entries, slots: SLOTS, opponent: { mu: 70, sigma: 25 } });

    const swingWhenBehind = behind.swaps.find((s) => s.in.player.id === 'swing');
    const swingWhenAhead = ahead.swaps.find((s) => s.in.player.id === 'swing');
    assert.ok(swingWhenBehind.winDelta > 0, 'helps when behind');
    assert.ok(swingWhenAhead.winDelta < 0, 'hurts when ahead');
});

test('a swap is only offered into a slot the player can legally fill', () => {
    const entries = rosterWithAChoice();
    const result = winProbSwaps({ entries, slots: SLOTS, opponent: { mu: 150, sigma: 25 } });
    for (const s of result.swaps) {
        assert.notEqual(s.slot, 'QB', 'nobody on this bench is a quarterback');
        if (s.slot === 'K') assert.equal(s.in.player.pos, 'K');
        if (s.slot === 'DEF') assert.equal(s.in.player.pos, 'DEF');
    }
});

test('without a spread on the entries, one is derived from the position', () => {
    // The view may not have weekly history for everybody.
    const bare = rosterWithAChoice().map(({ player, score, points, value }) => ({ player, score, points, value }));
    const result = winProbSwaps({ entries: bare, slots: SLOTS, opponent: { mu: 150, sigma: 25 } });
    assert.ok(Number.isFinite(result.base.sigma) && result.base.sigma > 0);
    assert.ok(Number.isFinite(result.baseWin));
});

test('no opponent means no win-probability advice, not a crash', () => {
    const result = winProbSwaps({ entries: rosterWithAChoice(), slots: SLOTS, opponent: null });
    assert.equal(result.baseWin, null);
    assert.deepEqual(contrarianSwaps(result), []);
});
