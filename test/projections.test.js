import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreStats, normalizeProjections, projectedPpg, actualsWeight, blendedPpg } from '../js/projections.js';
import { normalizeScoring, normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { createValuationContext, valuePlayer, softplusPar } from '../js/valuation.js';
import { buildSeedKeys, seedOrder } from '../js/rankings.js';
import { impliedTotals, parseScoreboard, buildTeamContext } from '../js/odds.js';

const row = (id, pos, stats) => ({
    player_id: id,
    player: { position: pos, first_name: 'A', last_name: id },
    stats: { pts_half_ppr: 100, gp: 17, ...stats },
});

test('scoring a stat line is a dot product over the league rules', () => {
    const scoring = normalizeScoring({ rec: 0.5, rec_yd: 0.1, rec_td: 6 });
    const pts = scoreStats({ rec: 100, rec_yd: 1200, rec_td: 10 }, scoring);
    assert.equal(pts, 50 + 120 + 60);
});

test('custom scoring rules are honoured, not dropped', () => {
    // First-down bonuses are a real Sleeper option and were silently discarded
    // by the old scoring normalizer.
    const scoring = normalizeScoring({ rec: 0.5, rec_fd: 0.5, bonus_rec_te: 0.5 });
    assert.equal(scoring.rec_fd, 0.5, 'unknown-but-real keys must survive normalization');
    assert.equal(scoreStats({ rec: 10, rec_fd: 6 }, scoring), 5 + 3);
});

test('kicker and defense rules survive normalization', () => {
    const scoring = normalizeScoring({ fgm_50p: 5, xpm: 1, sack: 1, int: 2, pts_allow_0: 10 });
    assert.equal(scoring.fgm_50p, 5);
    assert.equal(scoring.sack, 1);
    assert.equal(scoreStats({ fgm_50p: 4, xpm: 30 }, scoring), 20 + 30);
    assert.equal(scoreStats({ sack: 40, int: 15, pts_allow_0: 1 }, scoring), 40 + 30 + 10);
});

test('stats a projection does not carry contribute nothing', () => {
    const scoring = normalizeScoring({ rec: 1, rush_yd: 0.1 });
    assert.equal(scoreStats({ rec: 5 }, scoring), 5);
});

test('normalizeProjections keeps only rows with real projections', () => {
    const out = normalizeProjections([
        row('a', 'RB', { rush_yd: 1000 }),
        { player_id: 'empty', player: { position: 'RB' }, stats: { adp_ppr: 120 } },
        { player_id: 'nostats', player: { position: 'WR' } },
    ]);
    assert.deepEqual(Object.keys(out), ['a']);
    assert.equal(out.a.pos, 'RB');
});

test('ADP and rank keys are stripped so they cannot be scored by accident', () => {
    const out = normalizeProjections([row('a', 'RB', { adp_ppr: 12, pos_rank_ppr: 4, rank_ppr: 40, rush_yd: 900 })]);
    assert.equal(out.a.stats.adp_ppr, undefined);
    assert.equal(out.a.stats.pos_rank_ppr, undefined);
    assert.equal(out.a.stats.rush_yd, 900);
});

test('games played is clamped to something physically possible', () => {
    // Sleeper says 18 for offense (there are 17 games) and 1 for defenses.
    const out = normalizeProjections([
        row('off', 'RB', { gp: 18 }),
        row('def', 'DEF', { gp: 1 }),
        row('hurt', 'WR', { gp: 9 }),
    ]);
    assert.equal(out.off.games, 17);
    assert.equal(out.def.games, 17, 'a defense projected for one game is a season total');
    assert.equal(out.hurt.games, 9, 'a genuine partial season is left alone');
});

test('per-game projection divides by games, not by 18', () => {
    const scoring = normalizeScoring({ rush_yd: 0.1 });
    const out = normalizeProjections([row('a', 'RB', { gp: 18, rush_yd: 1700 })]);
    assert.equal(round2(projectedPpg(out.a, scoring)), 10);
});
const round2 = (n) => Math.round(n * 100) / 100;

test('actuals gain weight as the season goes on, but never fully take over', () => {
    assert.equal(actualsWeight(0), 0);
    assert.ok(actualsWeight(3) < actualsWeight(10));
    assert.ok(actualsWeight(17) <= 0.65, 'the preseason prior never fully retires');
});

test('blended outlook moves toward what a player has actually done', () => {
    const scoring = normalizeScoring({ rush_yd: 0.1 });
    const projection = normalizeProjections([row('a', 'RB', { gp: 17, rush_yd: 850 })]).a; // 5 ppg
    const actual = normalizeProjections([row('a', 'RB', { gp: 10, rush_yd: 1500 })]).a;    // 15 ppg
    const early = blendedPpg({ projection, actual, scoring, week: 1 });
    const late = blendedPpg({ projection, actual, scoring, week: 11 });
    assert.equal(round2(early), 5, 'before any games are played the projection stands alone');
    assert.ok(late > 8 && late < 15, `by week 11 results should pull it up, got ${late}`);
});

// --- The Pollard bug -------------------------------------------------------

test('softplus keeps depth players distinct and never worthless', () => {
    // The old model clamped everything below replacement to a single floor, so
    // a starting running back and a fourth-stringer showed the same number.
    const atReplacement = softplusPar(0);
    assert.ok(atReplacement > 0, 'a replacement-level player is not worth zero');
    const a = softplusPar(-0.5);
    const b = softplusPar(-1.5);
    const c = softplusPar(-4);
    assert.ok(a > b && b > c, 'the tail must stay strictly ordered');
    assert.ok(c > 0, 'and stay positive');
    // Well above replacement it should behave like plain points-above-replacement.
    assert.ok(Math.abs(softplusPar(12) - 12) < 0.01);
});

test('a player at exactly replacement level has a usable, non-zero value', () => {
    const projections = {};
    // 60 running backs on a smooth decline.
    for (let i = 0; i < 60; i++) {
        projections[`rb${i}`] = {
            id: `rb${i}`, pos: 'RB', games: 17,
            stats: { rush_yd: (200 - i * 2) * 17 / 10, pts_half_ppr: 1 },
        };
    }
    const cfg = normalizeLeague({
        settings: { num_teams: 12 }, scoring_settings: { rush_yd: 0.1 },
        roster_positions: defaultRosterPositions(),
    });
    const ctx = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });
    assert.equal(ctx.projected, true);

    // Where the replacement LINE falls on the running back curve. It is not
    // simply the count of rostered backs any more: the flex slot means backs,
    // receivers and tight ends are all fighting for the same last startable
    // spot, so they share one line and it is read off the pooled board.
    const replRank = ctx.curves.RB.findIndex((ppg) => ppg <= ctx.replacementPpg.RB) + 1;
    assert.ok(replRank > 0, 'the replacement line must land somewhere on the curve');
    const p = { id: 'x', name: 'Replacement Guy', pos: 'RB', age: 26, injury: null };
    const atRepl = valuePlayer(p, replRank, ctx);
    assert.equal(round2(atRepl.parPerGame), 0, 'this rank IS replacement level');
    assert.ok(atRepl.value > 0, `value at replacement must be > 0, got ${atRepl.value}`);

    // And everyone below him must still be strictly ordered.
    const below = [replRank + 1, replRank + 5, replRank + 15].map((r) => valuePlayer(p, r, ctx).value);
    assert.ok(below[0] > below[1] && below[1] > below[2], `tail collapsed: ${below}`);
    assert.ok(below[2] > 0);
});

test('value follows YOUR rank, while the projection sets the scale', () => {
    const projections = {};
    // A realistic RB curve: RB1 at 18 pts/game sliding to about 4 at RB40.
    // At 0.1 pts per rushing yard over 17 games, ppg * 170 is the season total.
    for (let i = 0; i < 40; i++) {
        const ppg = 18 - 0.35 * i;
        projections[`rb${i}`] = { id: `rb${i}`, pos: 'RB', games: 17, stats: { rush_yd: ppg * 170, pts_half_ppr: 1 } };
    }
    const cfg = normalizeLeague({
        settings: { num_teams: 12 }, scoring_settings: { rush_yd: 0.1 },
        roster_positions: defaultRosterPositions(),
    });
    const ctx = createValuationContext(cfg, { week: 1, weeksLeft: 14, projections });
    const p = { id: 'rb30', name: 'Underrated', pos: 'RB', age: 26, injury: null };

    const asRanked30 = valuePlayer(p, 30, ctx);
    const asRanked10 = valuePlayer(p, 10, ctx);
    assert.ok(
        asRanked10.value > asRanked30.value * 2,
        `promoting him on your board must raise his value (${round2(asRanked30.value)} -> ${round2(asRanked10.value)})`
    );
    // His own projection is reported independently so disagreement is visible.
    assert.equal(asRanked10.projectedRank, 31);
});

test('valuation falls back to the model when projections are missing', () => {
    const cfg = normalizeLeague({ settings: { num_teams: 12 }, scoring_settings: { rec: 0.5 }, roster_positions: defaultRosterPositions() });
    const ctx = createValuationContext(cfg, { week: 1, weeksLeft: 14 });
    assert.equal(ctx.projected, false, 'and it says so, rather than pretending');
    const v = valuePlayer({ id: 'a', name: 'A', pos: 'RB', age: 25 }, 5, ctx);
    assert.ok(v.value > 0 && Number.isFinite(v.value));
});

test('board seeds from projections, not from popularity', () => {
    const players = {
        hyped: { id: 'hyped', name: 'Hyped Bust', pos: 'RB', team: 'KC', searchRank: 1 },
        quiet: { id: 'quiet', name: 'Quiet Stud', pos: 'RB', team: 'BUF', searchRank: 90 },
    };
    const projections = {
        hyped: { id: 'hyped', pos: 'RB', games: 17, stats: { rush_yd: 500 } },
        quiet: { id: 'quiet', pos: 'RB', games: 17, stats: { rush_yd: 1600 } },
    };
    const scoring = normalizeScoring({ rush_yd: 0.1 });
    const keys = buildSeedKeys(players, { projections, scoring });
    assert.deepEqual(seedOrder(players, { seedKeys: keys }).RB, ['quiet', 'hyped']);
    // Without projections it falls back to search_rank ordering.
    assert.deepEqual(seedOrder(players, { seedKeys: buildSeedKeys(players, {}) }).RB, ['hyped', 'quiet']);
});

test('projected players always outrank unprojected ones', () => {
    const players = {
        proj: { id: 'proj', name: 'Projected', pos: 'WR', searchRank: 500 },
        noproj: { id: 'noproj', name: 'Unprojected', pos: 'WR', searchRank: 2 },
    };
    const keys = buildSeedKeys(players, {
        projections: { proj: { id: 'proj', pos: 'WR', games: 17, stats: { rec_yd: 100 } } },
        scoring: normalizeScoring({ rec_yd: 0.1 }),
    });
    assert.deepEqual(seedOrder(players, { seedKeys: keys }).WR, ['proj', 'noproj']);
});

// --- Vegas odds ------------------------------------------------------------

test('implied totals split the game total by the spread', () => {
    const t = impliedTotals(47, 7);
    assert.equal(t.favorite, 27);
    assert.equal(t.underdog, 20);
    assert.equal(t.favorite + t.underdog, 47);
});

test('implied totals ignore the sign of the spread', () => {
    assert.deepEqual(impliedTotals(44, -6), impliedTotals(44, 6));
});

test('implied totals return null on missing lines', () => {
    assert.equal(impliedTotals(null, 3), null);
    assert.equal(impliedTotals(44, null), null);
});

test('scoreboard parses into per-team game context', () => {
    const payload = {
        events: [{
            id: '1', shortName: 'KC @ BUF', date: '2026-10-04T17:00Z',
            competitions: [{
                status: { type: { description: 'Scheduled' } },
                competitors: [
                    { homeAway: 'home', team: { abbreviation: 'BUF' } },
                    { homeAway: 'away', team: { abbreviation: 'KC' } },
                ],
                odds: [{
                    overUnder: 51, spread: 3, details: 'BUF -3',
                    provider: { name: 'DraftKings' },
                    homeTeamOdds: { favorite: true }, awayTeamOdds: { favorite: false },
                }],
            }],
        }],
    };
    const byTeam = buildTeamContext(parseScoreboard(payload));
    assert.equal(byTeam.get('BUF').impliedTotal, 27);
    assert.equal(byTeam.get('KC').impliedTotal, 24);
    assert.equal(byTeam.get('BUF').isFavorite, true);
    assert.equal(byTeam.get('KC').opponent, 'BUF');
    assert.equal(byTeam.get('KC').home, false);
});

test('a game with no posted line still yields team context', () => {
    const games = parseScoreboard({
        events: [{
            id: '2', shortName: 'NYJ @ MIA',
            competitions: [{
                competitors: [
                    { homeAway: 'home', team: { abbreviation: 'MIA' } },
                    { homeAway: 'away', team: { abbreviation: 'NYJ' } },
                ],
            }],
        }],
    });
    assert.equal(games.length, 1);
    assert.equal(buildTeamContext(games).get('MIA').impliedTotal, null);
});
