import test from 'node:test';
import assert from 'node:assert/strict';

import {
    METRICS, METRIC_BY_KEY, metricsFor, formatMetric, teamWeeklyTotals,
    advancedSeries, advancedProfile, profileTrend, buildProfiles,
    leaderboard, movers, compareProfiles, verdictFor,
} from '../js/advanced.js';
import { normalizeScoring } from '../js/league.js';

const scoring = normalizeScoring({ rec: 0.5, rec_yd: 0.1, rush_yd: 0.1, rec_td: 6, rush_td: 6, pass_td: 4, pass_yd: 0.04 });

const player = (id, pos, team = 'KC') => ({ id, name: `${pos} ${id}`, pos, team });

/**
 * Weekly rows in Sleeper's actual shape, including the team field the share
 * metrics depend on. `gp: 1` matters: a week without it is treated as a week
 * he did not play.
 */
function week(rows) {
    return rows.map((r) => ({
        player_id: r.id,
        team: r.team || 'KC',
        opponent: r.opponent || 'DEN',
        player: { position: r.pos, team: r.team || 'KC' },
        stats: { gp: 1, tm_off_snp: 60, ...r.stats },
    }));
}

test('every metric is readable: label, kind, positions and a format', () => {
    for (const m of METRICS) {
        assert.ok(m.key && m.label && m.short, `${m.key} needs naming`);
        assert.ok(['opportunity', 'efficiency', 'scoring'].includes(m.kind), `${m.key} has kind ${m.kind}`);
        assert.ok(Array.isArray(m.positions) && m.positions.length, `${m.key} needs positions`);
        assert.equal(typeof m.higherBetter, 'boolean', `${m.key} must say which direction is good`);
    }
});

test('opportunity metrics come before efficiency ones', () => {
    // The whole reading of this page depends on the distinction: opportunity
    // predicts, efficiency regresses. Ordering is how that gets communicated.
    const rb = metricsFor('RB');
    const firstEfficiency = rb.findIndex((m) => m.kind === 'efficiency');
    const lastOpportunity = rb.map((m) => m.kind).lastIndexOf('opportunity');
    assert.ok(lastOpportunity < firstEfficiency, 'opportunity must lead');
});

test('a position only gets the metrics that apply to it', () => {
    assert.ok(!metricsFor('QB').some((m) => m.key === 'targetShare'), 'a quarterback has no target share');
    assert.ok(metricsFor('QB').some((m) => m.key === 'completionPct'));
    assert.ok(!metricsFor('WR').some((m) => m.key === 'completionPct'));
});

test('formatting follows the metric, and missing is missing', () => {
    assert.equal(formatMetric('snapShare', 0.675), '68%');
    assert.equal(formatMetric('yardsPerTarget', 9.46), '9.5');
    assert.equal(formatMetric('pointsPerTouch', 1.238), '1.24');
    assert.equal(formatMetric('snapShare', null), '—');
    assert.equal(formatMetric('snapShare', undefined), '—');
    assert.equal(formatMetric('snapShare', NaN), '—');
});

// --- Shares need the team's week ------------------------------------------

test('team totals are summed per week, and snaps are not double counted', () => {
    const stats = new Map([
        [1, week([
            { id: 'a', pos: 'WR', stats: { rec_tgt: 10, rush_att: 0, rec_air_yd: 120 } },
            { id: 'b', pos: 'WR', stats: { rec_tgt: 6, rush_att: 0, rec_air_yd: 60 } },
            { id: 'c', pos: 'RB', stats: { rec_tgt: 4, rush_att: 20, rec_air_yd: 10 } },
        ])],
    ]);
    const totals = teamWeeklyTotals(stats);
    const kc = totals.get(1).get('KC');
    assert.equal(kc.targets, 20);
    assert.equal(kc.carries, 20);
    assert.equal(kc.airYards, 190);
    // Team snaps appear on every row; summing them would triple the count.
    assert.equal(kc.snaps, 60, 'team snaps is a max, not a sum');
});

test('target share is measured against the team, not the player', () => {
    // Eight targets means one thing on a team that threw twenty and another on
    // one that threw forty-five. That is why this cannot come off one row.
    const stats = new Map([
        [1, week([
            { id: 'star', pos: 'WR', stats: { rec_tgt: 10, rec: 7, rec_yd: 95, off_snp: 55 } },
            { id: 'other', pos: 'WR', stats: { rec_tgt: 10, rec: 5, rec_yd: 40, off_snp: 50 } },
        ])],
    ]);
    const series = advancedSeries(stats, 'star', scoring);
    assert.equal(series.length, 1);
    assert.equal(series[0].targetShare, 0.5);
    assert.equal(series[0].snapShare, 55 / 60);
});

test('a week he did not play is not a week of data', () => {
    // Averaging a zero into a per-game rate is how an injured player's numbers
    // silently collapse and he looks finished when he was just inactive.
    const stats = new Map([
        [1, week([{ id: 'a', pos: 'RB', stats: { rush_att: 20, rush_yd: 100, off_snp: 50 } }])],
        [2, [{ player_id: 'a', team: 'KC', player: { position: 'RB', team: 'KC' }, stats: { gp: 0, tm_off_snp: 60 } }]],
        [3, week([{ id: 'a', pos: 'RB', stats: { rush_att: 18, rush_yd: 90, off_snp: 48 } }])],
    ]);
    const series = advancedSeries(stats, 'a', scoring);
    assert.deepEqual(series.map((r) => r.week), [1, 3], 'the inactive week must be skipped entirely');
    const profile = advancedProfile(player('a', 'RB'), series, scoring);
    assert.equal(profile.games, 2);
    assert.equal(profile.yardsPerCarry, 190 / 38);
});

test('a stat Sleeper omits means zero, not missing', () => {
    // Sleeper drops a key entirely when it is zero -- only 25 of 478 rows in a
    // week carry rush_btkl. Treating absent as missing would make every back
    // who broke no tackles disappear from the leaderboard instead of ranking
    // last, which is a different and wrong claim.
    const stats = new Map([
        [1, week([{ id: 'a', pos: 'RB', stats: { rush_att: 20, rush_yd: 80, rush_yac: 40 } }])],
    ]);
    const profile = advancedProfile(player('a', 'RB'), advancedSeries(stats, 'a', scoring), scoring);
    assert.equal(profile.brokenTackles, 0, 'no broken tackles is zero, which is a real value');
    assert.equal(profile.yardsAfterContact, 2);
});

test('a rate with no denominator stays unknown rather than becoming zero', () => {
    // Zero targets is not a catch rate of 0%.
    const stats = new Map([
        [1, week([{ id: 'a', pos: 'RB', stats: { rush_att: 20, rush_yd: 90 } }])],
    ]);
    const profile = advancedProfile(player('a', 'RB'), advancedSeries(stats, 'a', scoring), scoring);
    assert.equal(profile.catchRate, null);
    assert.equal(profile.yardsPerTarget, null);
    assert.equal(profile.yardsPerCarry, 4.5);
});

test('rates come from season totals, not from averaging weekly rates', () => {
    // Those are different numbers and the second is wrong: a week with one
    // target and a 50-yard catch would otherwise weigh as much as a week with
    // twelve, and yards per target would read like a deep threat.
    const stats = new Map([
        [1, week([{ id: 'a', pos: 'WR', stats: { rec_tgt: 1, rec: 1, rec_yd: 50 } }])],
        [2, week([{ id: 'a', pos: 'WR', stats: { rec_tgt: 11, rec: 7, rec_yd: 60 } }])],
    ]);
    const profile = advancedProfile(player('a', 'WR'), advancedSeries(stats, 'a', scoring), scoring);
    // Totals: 110 yards on 12 targets.
    assert.equal(round2(profile.yardsPerTarget), 9.17);
    // Averaging the weekly rates would give (50 + 5.45) / 2 = 27.7.
    assert.ok(profile.yardsPerTarget < 12, 'the one-target week must not dominate');
});

const round2 = (n) => Math.round(n * 100) / 100;

test('touchdown share is weighted by what a touchdown is actually worth', () => {
    const stats = new Map([
        [1, week([{ id: 'qb', pos: 'QB', stats: { pass_att: 30, pass_cmp: 20, pass_yd: 250, pass_td: 2 } }])],
    ]);
    const p = advancedProfile(player('qb', 'QB'), advancedSeries(stats, 'qb', scoring), scoring);
    // 250 yards * 0.04 = 10, plus 2 passing TDs * 4 = 8. So 8 of 18.
    assert.equal(round2(p.tdShare), round2(8 / 18));
});

// --- Who is going up or down ----------------------------------------------

test('a growing role is called a rise even when the points have not moved', () => {
    const rows = [];
    for (let w = 1; w <= 6; w++) {
        const share = w <= 3 ? 4 : 11;
        rows.push([w, week([
            { id: 'riser', pos: 'WR', stats: { rec_tgt: share, rec: 4, rec_yd: 45, off_snp: w <= 3 ? 25 : 50 } },
            { id: 'filler', pos: 'WR', stats: { rec_tgt: 20 - share, rec: 8, rec_yd: 80, off_snp: 40 } },
        ])]);
    }
    const stats = new Map(rows);
    const series = advancedSeries(stats, 'riser', scoring);
    const trend = profileTrend(player('riser', 'WR'), series, scoring, { window: 3 });
    assert.ok(trend, 'six games with a three-game window is enough');
    assert.equal(trend.verdict.direction, 'up');
    assert.match(trend.verdict.text, /buy window|box score agrees/);
});

test('points up on a flat role is called hollow, not a rise', () => {
    // The call every manager gets wrong in both directions. Efficiency
    // regresses; a role does not.
    const moves = [
        { metric: METRIC_BY_KEY.get('snapShare'), before: 0.6, after: 0.6, change: 0 },
        { metric: METRIC_BY_KEY.get('targetShare'), before: 0.2, after: 0.2, change: 0 },
        { metric: METRIC_BY_KEY.get('pointsPerGame'), before: 9, after: 15, change: 6 },
    ];
    const v = verdictFor(moves);
    assert.equal(v.direction, 'hollow');
    assert.match(v.text, /efficiency regresses/);
});

test('points up on a shrinking role is a sell signal', () => {
    const moves = [
        { metric: METRIC_BY_KEY.get('snapShare'), before: 0.7, after: 0.45, change: -0.25 },
        { metric: METRIC_BY_KEY.get('targetShare'), before: 0.24, after: 0.14, change: -0.1 },
        { metric: METRIC_BY_KEY.get('pointsPerGame'), before: 10, after: 16, change: 6 },
    ];
    const v = verdictFor(moves);
    assert.equal(v.direction, 'down');
    assert.match(v.text, /Sell into the hot streak/);
});

test('points down on a steady role is called cheap rather than broken', () => {
    const moves = [
        { metric: METRIC_BY_KEY.get('snapShare'), before: 0.7, after: 0.7, change: 0 },
        { metric: METRIC_BY_KEY.get('targetShare'), before: 0.22, after: 0.22, change: 0 },
        { metric: METRIC_BY_KEY.get('pointsPerGame'), before: 14, after: 8, change: -6 },
    ];
    const v = verdictFor(moves);
    assert.equal(v.direction, 'cheap');
    assert.match(v.text, /cheap to buy/);
});

test('a trend needs both halves to have real games', () => {
    const stats = new Map([
        [1, week([{ id: 'a', pos: 'WR', stats: { rec_tgt: 5, rec: 3, rec_yd: 40 } }])],
        [2, week([{ id: 'a', pos: 'WR', stats: { rec_tgt: 6, rec: 4, rec_yd: 50 } }])],
        [3, week([{ id: 'a', pos: 'WR', stats: { rec_tgt: 7, rec: 5, rec_yd: 60 } }])],
    ]);
    const series = advancedSeries(stats, 'a', scoring);
    assert.equal(profileTrend(player('a', 'WR'), series, scoring, { window: 3 }), null,
        'three games against a three-game window leaves no baseline');
    assert.ok(profileTrend(player('a', 'WR'), series, scoring, { window: 1 }),
        'a one-game window leaves two games of baseline, which is the minimum');
});

test('a move is sized against the metric, not against the player’s own baseline', () => {
    // The bug this covers made the rising list useless. A receiver going from a
    // 1% target share to 15% scored a 1,400% move, so deep-bench bodies who
    // caught two passes buried every player anybody could act on.
    const rows = [];
    for (let w = 1; w <= 6; w++) {
        // Tiny baseline, small absolute move: 1 target to 3.
        const tiny = w <= 3 ? 1 : 3;
        rows.push([w, week([
            { id: 'tiny', pos: 'WR', stats: { rec_tgt: tiny, rec: 1, rec_yd: 10, off_snp: 12 } },
            // Real baseline, real move: 6 targets to 12.
            { id: 'real', pos: 'WR', stats: { rec_tgt: w <= 3 ? 6 : 12, rec: 7, rec_yd: 85, off_snp: 50 } },
            { id: 'filler', pos: 'WR', stats: { rec_tgt: 10, rec: 6, rec_yd: 70, off_snp: 40 } },
        ])]);
    }
    const stats = new Map(rows);
    const profiles = buildProfiles({
        weeklyStats: stats,
        players: [player('tiny', 'WR'), player('real', 'WR'), player('filler', 'WR')],
        scoring,
        window: 3,
    });
    const up = movers(profiles, { direction: 'up', minTouches: 3 });
    const ids = up.map((m) => m.profile.player.id);
    assert.ok(ids.includes('real'), 'the player with a real role change must surface');
    assert.ok(!ids.includes('tiny'), 'a one-to-three target move must not lead the league');
});

test('the mover volume floor is applied to recent form, not the season', () => {
    // A player who has just taken over a job has barely any season volume yet,
    // and he is exactly the one worth surfacing.
    const rows = [];
    for (let w = 1; w <= 6; w++) {
        rows.push([w, week([
            { id: 'newStarter', pos: 'RB', stats: w <= 3
                ? { rush_att: 1, rush_yd: 3, off_snp: 6 }
                : { rush_att: 18, rush_yd: 80, rec: 2, off_snp: 48 } },
            { id: 'filler', pos: 'RB', stats: { rush_att: 10, rush_yd: 40, off_snp: 30 } },
        ])]);
    }
    const profiles = buildProfiles({
        weeklyStats: new Map(rows),
        players: [player('newStarter', 'RB'), player('filler', 'RB')],
        scoring,
        window: 3,
    });
    const ids = movers(profiles, { direction: 'up' }).map((m) => m.profile.player.id);
    assert.ok(ids.includes('newStarter'), 'a player who just took the job must not be filtered out by season volume');
});

// --- Leaderboards ---------------------------------------------------------

test('a leaderboard without a volume floor is meaningless, so it has one', () => {
    // A receiver with two targets and both caught for forty yards leads every
    // efficiency metric in football and tells you nothing.
    const stats = new Map([
        [1, week([
            { id: 'fluke', pos: 'WR', stats: { rec_tgt: 1, rec: 1, rec_yd: 40 } },
            { id: 'real', pos: 'WR', stats: { rec_tgt: 10, rec: 7, rec_yd: 110 } },
        ])],
        [2, week([
            { id: 'fluke', pos: 'WR', stats: { rec_tgt: 1, rec: 1, rec_yd: 35 } },
            { id: 'real', pos: 'WR', stats: { rec_tgt: 11, rec: 8, rec_yd: 120 } },
        ])],
    ]);
    const profiles = buildProfiles({
        weeklyStats: stats,
        players: [player('fluke', 'WR'), player('real', 'WR')],
        scoring,
    });

    const unfiltered = leaderboard(profiles, 'yardsPerTarget', { pos: 'WR' });
    assert.equal(unfiltered[0].player.id, 'fluke', 'with no floor the fluke leads, which is the problem');

    const floored = leaderboard(profiles, 'yardsPerTarget', { pos: 'WR', minimum: 4, minimumKey: 'targetsPerGame' });
    assert.equal(floored.length, 1);
    assert.equal(floored[0].player.id, 'real');
});

test('a leaderboard sorts by the direction that is good for the metric', () => {
    const stats = new Map([
        [1, week([
            { id: 'clean', pos: 'WR', stats: { rec_tgt: 10, rec: 8, rec_yd: 100 } },
            { id: 'butter', pos: 'WR', stats: { rec_tgt: 10, rec: 5, rec_yd: 60, rec_drop: 3 } },
        ])],
    ]);
    const profiles = buildProfiles({
        weeklyStats: stats, players: [player('clean', 'WR'), player('butter', 'WR')], scoring, minGames: 1,
    });
    // Drop rate is a metric where lower is better, so the clean hands lead.
    const board = leaderboard(profiles, 'dropRate', { pos: 'WR' });
    assert.equal(board[0].player.id, 'clean');
    assert.equal(METRIC_BY_KEY.get('dropRate').higherBetter, false);
});

test('a leaderboard never lists a position the metric does not apply to', () => {
    const stats = new Map([
        [1, week([
            { id: 'qb', pos: 'QB', stats: { pass_att: 30, pass_cmp: 20, pass_yd: 250 } },
            { id: 'wr', pos: 'WR', stats: { rec_tgt: 10, rec: 7, rec_yd: 100 } },
        ])],
    ]);
    const profiles = buildProfiles({
        weeklyStats: stats, players: [player('qb', 'QB'), player('wr', 'WR')], scoring, minGames: 1,
    });
    const board = leaderboard(profiles, 'targetShare', {});
    assert.ok(!board.some((p) => p.player.pos === 'QB'), 'a quarterback has no target share');
});

// --- Comparison -----------------------------------------------------------

test('two players are compared on the metrics they share, with a leader each row', () => {
    const stats = new Map([
        [1, week([
            { id: 'a', pos: 'WR', stats: { rec_tgt: 12, rec: 9, rec_yd: 120, off_snp: 55 } },
            { id: 'b', pos: 'WR', stats: { rec_tgt: 6, rec: 5, rec_yd: 80, off_snp: 40 } },
        ])],
    ]);
    const profiles = buildProfiles({
        weeklyStats: stats, players: [player('a', 'WR'), player('b', 'WR')], scoring, minGames: 1,
    });
    const cmp = compareProfiles(profiles);
    assert.ok(cmp.rows.length > 4);
    const share = cmp.rows.find((r) => r.metric.key === 'targetShare');
    assert.equal(share.leader.player.id, 'a');
    // On a metric where lower is better the leader flips.
    const ypt = cmp.rows.find((r) => r.metric.key === 'yardsPerTarget');
    assert.equal(ypt.leader.player.id, 'b', '80 yards on 6 targets beats 120 on 12');
});

test('a mixed-position field still compares on something', () => {
    const stats = new Map([
        [1, week([
            { id: 'rb', pos: 'RB', stats: { rush_att: 18, rush_yd: 90, off_snp: 45 } },
            { id: 'qb', pos: 'QB', stats: { pass_att: 30, pass_cmp: 21, pass_yd: 260, off_snp: 60 } },
        ])],
    ]);
    const profiles = buildProfiles({
        weeklyStats: stats, players: [player('rb', 'RB'), player('qb', 'QB')], scoring, minGames: 1,
    });
    const cmp = compareProfiles(profiles);
    assert.ok(cmp.rows.length >= 1, 'a quarterback and a back still share points and snap share');
    assert.ok(cmp.rows.every((r) => r.metric.positions.includes('RB') || r.metric.key === 'pointsPerGame'));
});

test('fewer than two players is not a comparison', () => {
    assert.equal(compareProfiles([]), null);
    assert.equal(compareProfiles(null), null);
});

test('profiles are built in one pass over the season', () => {
    const stats = new Map([
        [1, week([{ id: 'a', pos: 'WR', stats: { rec_tgt: 8, rec: 6, rec_yd: 70 } }])],
        [2, week([{ id: 'a', pos: 'WR', stats: { rec_tgt: 9, rec: 7, rec_yd: 80 } }])],
    ]);
    const profiles = buildProfiles({ weeklyStats: stats, players: [player('a', 'WR')], scoring });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].games, 2);
    // Below the minimum, he is left out rather than reported on one game.
    assert.equal(buildProfiles({ weeklyStats: stats, players: [player('a', 'WR')], scoring, minGames: 5 }).length, 0);
});
