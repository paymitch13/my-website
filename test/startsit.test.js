import test from 'node:test';
import assert from 'node:assert/strict';

import { vegasImpact, defenseVegasImpact, evaluatePlayerWeek, buildStartSitReport, lineupChanges, slateAverage } from '../js/startsit.js';
import { buildDefenseProfiles, matchupImpact, rankDefenses, describeMatchup } from '../js/matchup.js';
import { weatherImpact, pickHour, STADIUMS } from '../js/weather.js';
import { normalizeScoring, normalizeLeague, defaultRosterPositions } from '../js/league.js';

const scoring = normalizeScoring({ rec: 0.5 });
const cfg = normalizeLeague({
    settings: { num_teams: 12 }, scoring_settings: { rec: 0.5 },
    roster_positions: defaultRosterPositions(),
});

// --- Vegas -----------------------------------------------------------------

test('a high implied total lifts a player, a low one drags him down', () => {
    assert.ok(vegasImpact(30, 'WR').multiplier > 1.1);
    assert.ok(vegasImpact(15, 'WR').multiplier < 0.9);
    assert.equal(vegasImpact(22.5, 'WR').multiplier, 1, 'the league-average total is neutral');
});

test('defenses are not moved by their own offense', () => {
    assert.equal(vegasImpact(30, 'DEF').multiplier, 1);
});

test('a defense improves when its OPPONENT is expected to score less', () => {
    assert.ok(defenseVegasImpact(13).multiplier > 1.1, 'facing a bad offense is good for a DST');
    assert.ok(defenseVegasImpact(32).multiplier < 0.95);
});

test('vegas impact is bounded so one line cannot dominate a projection', () => {
    assert.ok(vegasImpact(60, 'QB').multiplier <= 1.25);
    assert.ok(vegasImpact(1, 'QB').multiplier >= 0.78);
});

test('missing lines leave the projection untouched', () => {
    assert.equal(vegasImpact(null, 'RB').multiplier, 1);
    assert.equal(vegasImpact(undefined, 'RB').known, false);
});

// --- Weather ---------------------------------------------------------------

test('domes are excluded rather than given a bonus', () => {
    const w = weatherImpact({ dome: true }, 'QB');
    assert.equal(w.multiplier, 1);
    assert.equal(w.severity, 'none');
});

test('wind hurts passing and kicking far more than rushing', () => {
    const wx = { dome: false, wind: 25, precipProbability: 0, temp: 50 };
    const qb = weatherImpact(wx, 'QB').multiplier;
    const k = weatherImpact(wx, 'K').multiplier;
    const rb = weatherImpact(wx, 'RB').multiplier;
    assert.ok(k < qb, 'kickers suffer most in wind');
    assert.ok(qb < 0.95, `25mph wind should hurt a QB, got ${qb}`);
    assert.ok(rb > qb, 'a back barely notices');
});

test('light wind is not treated as weather', () => {
    assert.equal(weatherImpact({ dome: false, wind: 6, precipProbability: 0, temp: 60 }, 'QB').severity, 'none');
});

test('heavy rain downgrades passing and slightly helps the run', () => {
    const wx = { dome: false, wind: 0, precipProbability: 90, temp: 55 };
    assert.ok(weatherImpact(wx, 'WR').multiplier < 1);
    assert.ok(weatherImpact(wx, 'RB').multiplier >= 1);
});

test('every NFL team maps to a stadium', () => {
    const teams = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
    assert.equal(teams.length, 32);
    for (const t of teams) {
        assert.ok(STADIUMS[t], `missing stadium for ${t}`);
        assert.ok(Number.isFinite(STADIUMS[t].lat) && Number.isFinite(STADIUMS[t].lon), `bad coords for ${t}`);
    }
});

test('forecast picks the hour nearest kickoff', () => {
    const data = {
        hourly: {
            time: ['2026-10-04T14:00', '2026-10-04T17:00', '2026-10-04T20:00'],
            temperature_2m: [50, 60, 70],
            wind_speed_10m: [5, 15, 25],
            precipitation_probability: [0, 40, 80],
        },
    };
    const wx = pickHour(data, '2026-10-04T16:40', { name: 'X' }, 'BUF');
    assert.equal(wx.temp, 60);
    assert.equal(wx.wind, 15);
});

test('a kickoff beyond the forecast window is reported as unavailable, not guessed', () => {
    const data = { hourly: { time: ['2026-10-04T14:00'], temperature_2m: [50], wind_speed_10m: [5], precipitation_probability: [0] } };
    const wx = pickHour(data, '2026-12-25T17:00', { name: 'X' }, 'BUF');
    assert.equal(wx.unavailable, true);
});

// --- Matchup ---------------------------------------------------------------

/** Build weekly stat rows where `def` holds receivers well below their norm. */
function statWeeks() {
    const weeks = new Map();
    for (let w = 1; w <= 8; w++) {
        const rows = [];
        for (let i = 1; i <= 6; i++) {
            // Each WR normally scores 15; against TUF he scores 6, vs SOFT 24.
            const opp = w % 3 === 0 ? 'TUF' : w % 3 === 1 ? 'SOFT' : 'MID';
            const pts = opp === 'TUF' ? 6 : opp === 'SOFT' ? 24 : 15;
            rows.push({
                player_id: `wr${i}`, opponent: opp,
                player: { position: 'WR' }, stats: { rec_yd: pts * 10 },
            });
        }
        weeks.set(w, rows);
    }
    return weeks;
}

test('defense profiles measure players against their own baseline', () => {
    const profiles = buildDefenseProfiles(statWeeks(), normalizeScoring({ rec_yd: 0.1 }), { minSamples: 3 });
    const tough = profiles.get('TUF').WR.ratio;
    const soft = profiles.get('SOFT').WR.ratio;
    assert.ok(tough < 0.8, `tough defense should suppress, got ${tough}`);
    assert.ok(soft > 1.2, `soft defense should inflate, got ${soft}`);
});

test('matchup ranks put the toughest defense first', () => {
    const profiles = buildDefenseProfiles(statWeeks(), normalizeScoring({ rec_yd: 0.1 }), { minSamples: 3 });
    const ranks = rankDefenses(profiles, 'WR');
    assert.equal(ranks[0].def, 'TUF');
    assert.equal(ranks[ranks.length - 1].def, 'SOFT');
});

test('matchup impact is damped so a small sample cannot swamp a projection', () => {
    const profiles = buildDefenseProfiles(statWeeks(), normalizeScoring({ rec_yd: 0.1 }), { minSamples: 3 });
    const raw = profiles.get('TUF').WR.ratio;
    const impact = matchupImpact(profiles, 'TUF', 'WR');
    assert.ok(impact.multiplier > raw, 'the applied multiplier must be pulled toward neutral');
    assert.ok(impact.multiplier >= 0.7 && impact.multiplier <= 1.3);
});

test('an unknown defense is neutral, not a guess', () => {
    const impact = matchupImpact(new Map(), 'XXX', 'WR');
    assert.equal(impact.multiplier, 1);
    assert.equal(impact.known, false);
});

test('matchup descriptions match the rank', () => {
    assert.equal(describeMatchup({ rank: 1, total: 32 }, 'WR').tone, 'bad');
    assert.equal(describeMatchup({ rank: 30, total: 32 }, 'WR').tone, 'good');
});

// --- Player evaluation -----------------------------------------------------

const mkPlayer = (id, pos, team, extra = {}) => ({ id, name: id, pos, team, age: 26, injury: null, ...extra });

/**
 * Vegas impact is relative to the rest of the slate, so a realistic slate has
 * to exist for the comparison to mean anything. These filler games average
 * 22.5 implied points, making that the neutral point.
 */
const SLATE = [
    ['FILL1', 20], ['FILL2', 25], ['FILL3', 21], ['FILL4', 24],
];

function evaluate(player, { impliedTotal = 22.5, weekly = { stats: { rec: 10, rec_yd: 100 }, opponent: 'OPP' }, wx = null, profiles = new Map() } = {}) {
    const oddsByTeam = new Map(SLATE.map(([t, v]) => [t, { impliedTotal: v, opponentImplied: 45 - v, home: true, opponent: 'X' }]));
    oddsByTeam.set(player.team, { impliedTotal, opponentImplied: 45 - impliedTotal, home: true, opponent: 'OPP' });
    return evaluatePlayerWeek({
        player,
        weekly,
        scoring,
        neutralImplied: 22.5,
        oddsByTeam,
        weatherByHome: wx ? new Map([[player.team, wx]]) : new Map(),
        defenseProfiles: profiles,
        defenseRanks: {},
        weeksLeft: 8,
    });
}

test('adjustments compound onto the base projection', () => {
    const p = mkPlayer('wr1', 'WR', 'BUF');
    const neutral = evaluate(p);
    const great = evaluate(p, { impliedTotal: 30 });
    assert.ok(great.adjusted > neutral.adjusted);
    assert.equal(round1(neutral.baseProjection), 15, '10 rec at 0.5 + 100 yds at 0.1');
    assert.ok(great.factors.some((f) => f.kind === 'vegas'));
});

test('a player ruled OUT is never startable', () => {
    // The headline bug: Start/Sit used the rest-of-season availability curve,
    // so an Out player with 14 weeks left lost 7% of his projection instead of
    // being removed from consideration entirely.
    for (const status of ['Out', 'IR', 'PUP', 'DNR', 'Sus', 'NA']) {
        const ev = evaluate(mkPlayer('x', 'RB', 'KC', { injury: status }));
        assert.equal(ev.ruledOut, true, `${status} must count as ruled out`);
        assert.equal(ev.adjusted, null, `${status} must have no startable projection`);
        assert.equal(ev.hasGame, false);
        assert.equal(ev.confidence.level, 'none');
    }
});

test('ruled-out players are excluded from the recommended lineup', () => {
    const evaluations = roster();
    // The best running back on the roster is Out.
    const ruled = {
        player: mkPlayer('rbOut', 'RB', 'KC', { injury: 'Out' }),
        hasGame: false, ruledOut: true, adjusted: null, baseProjection: 40,
        multiplier: 0, factors: [], opponent: 'OPP', confidence: { level: 'none' },
    };
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations: [...evaluations, ruled] });
    assert.ok(!rep.lineup.starters.some((s) => s.entry.player.id === 'rbOut'), 'an Out player cannot start');
    assert.ok(rep.unavailable.some((e) => e.player.id === 'rbOut'));
});

test('Doubtful is heavily discounted, Questionable only mildly', () => {
    const healthy = evaluate(mkPlayer('h', 'WR', 'BUF')).adjusted;
    const q = evaluate(mkPlayer('q', 'WR', 'BUF', { injury: 'Questionable' })).adjusted;
    const d = evaluate(mkPlayer('d', 'WR', 'BUF', { injury: 'Doubtful' })).adjusted;
    assert.ok(q > d, 'Questionable must beat Doubtful');
    assert.ok(q / healthy > 0.6 && q / healthy < 0.85, `Questionable ratio ${q / healthy}`);
    assert.ok(d / healthy < 0.35, `Doubtful should be gutted, ratio ${d / healthy}`);
});

test('an injury designation both cuts the projection and is surfaced', () => {
    const healthy = evaluate(mkPlayer('a', 'RB', 'KC'));
    const hurt = evaluate(mkPlayer('b', 'RB', 'KC', { injury: 'Questionable', injuryBody: 'Ankle' }));
    assert.ok(hurt.adjusted < healthy.adjusted);
    const health = hurt.factors.find((f) => f.kind === 'health');
    assert.ok(health && /Ankle/.test(health.detail));
    assert.notEqual(hurt.confidence.level, 'high', 'an injury designation must cost confidence');
});

test('a player with no game is flagged and never started', () => {
    const ev = evaluate(mkPlayer('bye', 'WR', 'BUF'), { weekly: null });
    assert.equal(ev.hasGame, false);
    assert.equal(ev.adjusted, null);
});

test('factors are ordered by how much they actually move the number', () => {
    const wx = { dome: false, wind: 28, precipProbability: 0, temp: 40 };
    const ev = evaluate(mkPlayer('qb', 'QB', 'BUF'), { impliedTotal: 23, wx });
    assert.ok(ev.factors.length >= 1);
    const magnitudes = ev.factors.map((f) => Math.abs(f.multiplier - 1));
    assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a));
});

test('confidence drops when we know less', () => {
    const solid = evaluate(mkPlayer('a', 'WR', 'BUF'));
    const shaky = evaluate(mkPlayer('b', 'WR', 'BUF', { injury: 'Doubtful' }), {
        wx: { dome: false, wind: 30, precipProbability: 95, temp: 15 },
    });
    assert.ok(shaky.confidence.score < solid.confidence.score);
    assert.match(shaky.confidence.why, /injury/);
});

// --- Report ----------------------------------------------------------------

function roster() {
    const spec = [
        ['qb1', 'QB', 20], ['qb2', 'QB', 12],
        ['rb1', 'RB', 18], ['rb2', 'RB', 14], ['rb3', 'RB', 13.6],
        ['wr1', 'WR', 17], ['wr2', 'WR', 15], ['wr3', 'WR', 13],
        ['te1', 'TE', 9], ['k1', 'K', 8], ['def1', 'DEF', 7],
    ];
    return spec.map(([id, pos, pts]) => ({
        player: mkPlayer(id, pos, 'BUF'),
        hasGame: true,
        adjusted: pts,
        baseProjection: pts,
        multiplier: 1,
        factors: [],
        opponent: 'OPP',
        confidence: { level: 'high', score: 0.8, why: '' },
    }));
}

test('report builds a legal optimal lineup and a bench', () => {
    const evaluations = roster();
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations });
    const started = rep.lineup.starters.map((s) => s.entry.player.id);
    assert.ok(started.includes('qb1') && !started.includes('qb2'));
    assert.ok(rep.projectedTotal > 0);
    assert.equal(started.length + rep.bench.length, evaluations.length);
});

test('players with no game are separated out and never started', () => {
    const evaluations = roster();
    evaluations.push({ player: mkPlayer('bye1', 'WR', 'NYJ'), hasGame: false, adjusted: null, factors: [], confidence: {} });
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations });
    assert.equal(rep.unavailable.length, 1);
    assert.ok(!rep.lineup.starters.some((s) => s.entry.player.id === 'bye1'));
});

test('close calls only surface genuinely tight decisions', () => {
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations: roster() });
    // rb3 (13.6) wins the flex, so wr3 (13.0) is the benched player closest to
    // a starter: 2.0 behind wr2 (15). qb2 (12) vs qb1 (20) is not close.
    assert.ok(
        rep.closeCalls.some((c) => c.sit.player.id === 'wr3' && c.start.player.id === 'wr2'),
        `expected wr3-vs-wr2, got ${JSON.stringify(rep.closeCalls.map((c) => `${c.sit.player.id}<${c.start.player.id}`))}`
    );
    assert.ok(!rep.closeCalls.some((c) => c.sit.player.id === 'qb2'));
    for (const c of rep.closeCalls) assert.ok(c.gap <= 2.5);
});

test('lineup changes diff the recommendation against what is actually set', () => {
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations: roster() });
    // Manager wrongly started qb2 instead of qb1.
    const current = ['qb2', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3', 'k1', 'def1'];
    const changes = lineupChanges(rep, current);
    assert.equal(changes.swaps.length, 1);
    assert.equal(changes.swaps[0].add.player.id, 'qb1');
    assert.equal(changes.swaps[0].drop.player.id, 'qb2');
    assert.ok(changes.pointsGained > 7);
});

test('an already-optimal lineup suggests nothing', () => {
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations: roster() });
    const current = rep.lineup.starters.map((s) => s.entry.player.id);
    assert.equal(lineupChanges(rep, current).swaps.length, 0);
});

const round1 = (n) => Math.round(n * 10) / 10;

test('a cross-position reshuffle is never reported as a negative-value swap', () => {
    // The manager started a QB where the optimizer wants a TE. Pairing those two
    // and subtracting produced a "recommendation" worth minus ninety-six points.
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations: roster() });
    const current = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'qb2', 'rb3', 'k1', 'def1']; // qb2 sits in the TE slot
    const changes = lineupChanges(rep, current);

    for (const s of changes.swaps) {
        if (s.paired) {
            assert.equal(s.add.player.pos, s.drop.player.pos, 'a paired swap must be like for like');
            assert.ok(s.gain >= 0, `a suggested swap cannot lose points (${s.gain})`);
        } else {
            assert.equal(s.gain, null, 'an unpaired move must not claim a margin');
        }
    }
    assert.ok(changes.pointsGained >= 0, 'the optimal lineup can never score below the current one');
});

test('the reported gain is optimal minus current, not a sum of pair differences', () => {
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations: roster() });
    const current = ['qb2', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rb3', 'k1', 'def1'];
    const changes = lineupChanges(rep, current);
    const expected = rep.projectedTotal - current.reduce((a, id) => {
        const e = [...rep.lineup.starters.map((s) => s.entry), ...rep.bench].find((x) => x.player.id === id);
        return a + (e ? e.score : 0);
    }, 0);
    assert.ok(Math.abs(changes.pointsGained - expected) < 1e-9);
    assert.equal(changes.recommendedTotal, rep.projectedTotal);
});

test('the neutral point is this week’s slate, not a constant', () => {
    // In a low-scoring week, a 21-point team is an ABOVE-average spot even
    // though 21 is below a hardcoded 22.5.
    const lowSlate = new Map([
        ['A', { impliedTotal: 16 }], ['B', { impliedTotal: 17 }],
        ['C', { impliedTotal: 18 }], ['D', { impliedTotal: 21 }],
    ]);
    const neutral = slateAverage(lowSlate);
    assert.ok(neutral < 20, `slate average should be low, got ${neutral}`);
    assert.ok(vegasImpact(21, 'WR', neutral).multiplier > 1, 'a 21 in a cold week is a good spot');
    assert.ok(vegasImpact(21, 'WR', 22.5).multiplier < 1, 'and would look bad against a fixed baseline');
});

test('slate average falls back sanely with no lines', () => {
    assert.equal(slateAverage(new Map()), 22.5);
    assert.equal(slateAverage(null), 22.5);
});

test('the recommended lineup never projects below a legal current lineup', () => {
    const rep = buildStartSitReport({ team: { name: 'T' }, cfg, evaluations: roster() });
    // An illegal "current lineup" (five running backs) must not make the
    // genuine optimum look like a downgrade.
    const illegal = ['rb1', 'rb2', 'rb3', 'qb1', 'qb2', 'wr1', 'wr2', 'wr3', 'te1'];
    const changes = lineupChanges(rep, illegal);
    assert.ok(changes.currentTotal <= rep.projectedTotal + 1e-9,
        `current ${changes.currentTotal} must not exceed optimum ${rep.projectedTotal}`);
    assert.ok(changes.pointsGained >= 0);
});
