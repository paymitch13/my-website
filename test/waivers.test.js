import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWaiverBoard, dropCandidates, suggestBid, ROLE_LABEL, ROLES, HORIZONS } from '../js/waivers.js';
import { normalizeLeague, defaultRosterPositions, normalizeScoring } from '../js/league.js';

const cfg = normalizeLeague({
    settings: { num_teams: 12 },
    scoring_settings: { rec: 0.5, rec_yd: 0.1, rush_yd: 0.1, rec_td: 6, rush_td: 6 },
    roster_positions: defaultRosterPositions(),
});
const scoring = cfg.scoring;

const player = (id, pos, extra = {}) => ({
    id, name: `${pos} ${id}`, pos, team: 'KC', age: 25, injury: null, ...extra,
});

/** A roster entry the lineup solver understands. */
const entry = (id, pos, points, value = points * 40) => ({
    player: player(id, pos),
    points,
    score: points,
    value,
});

/** A full, unremarkable roster so marginal value means something. */
function roster() {
    return [
        entry('qb1', 'QB', 18), entry('rb1', 'RB', 14), entry('rb2', 'RB', 11),
        entry('wr1', 'WR', 15), entry('wr2', 'WR', 12), entry('te1', 'TE', 8),
        entry('k1', 'K', 7), entry('def1', 'DEF', 6),
        entry('rb3', 'RB', 9), entry('wr3', 'WR', 8),
        entry('wr4', 'WR', 3), entry('te2', 'TE', 2),
    ];
}

/** A free agent in the shape `freeAgentEntries` produces. */
const fa = (id, pos, points, value = points * 40) => ({
    player: player(id, pos),
    posRank: 40,
    score: points,
    value,
    points,
});

/**
 * Weekly stat rows in Sleeper's shape, as a Map of week -> rows.
 * `opts.ramp` grows snap share and targets over the weeks, which is the
 * breakout signal the whole module is built to notice.
 */
function weeklyStats(id, weeks, opts = {}) {
    const { ramp = false, tdHeavy = false, shrinking = false, flatPoints = false } = opts;
    const map = new Map();
    for (let w = 1; w <= weeks; w++) {
        const t = (w - 1) / Math.max(1, weeks - 1);
        const snap = shrinking ? 0.8 - 0.4 * t : ramp ? 0.25 + 0.5 * t : 0.5;
        const targets = shrinking ? 9 - 5 * t : ramp ? 2 + 7 * t : 5;
        // `flatPoints` is the stash shape specifically: the role grows while
        // the box score does not. That is a different player from one whose
        // usage AND production are both climbing, and the two now classify
        // differently, so the fixture has to be able to express both.
        const yards = flatPoints ? 45 : tdHeavy ? 20 : Math.round(targets * 9);
        map.set(w, [
            {
                player_id: id,
                stats: {
                    off_snp: Math.round(snap * 60),
                    tm_off_snp: 60,
                    rec_tgt: targets,
                    // Receptions are held flat too under `flatPoints`: they
                    // score in PPR, so ramping them kept total points rising
                    // even with yards pinned. The shape being described is a
                    // player seeing more snaps and more targets without
                    // converting them yet.
                    rec: flatPoints ? 3 : Math.round(targets * 0.65),
                    rec_yd: yards,
                    rec_td: tdHeavy ? 1 : 0,
                    rush_att: 0,
                    gp: 1,
                },
            },
        ]);
    }
    return map;
}

/**
 * Merge several players' weekly stats into one Map.
 *
 * Spreading two of these into `new Map([...a, ...b])` does NOT work: both use
 * the same week numbers as keys, so the second silently overwrites the first
 * and one of the players ends up with no usage history at all.
 */
function mergeWeekly(...maps) {
    const out = new Map();
    for (const m of maps) {
        for (const [week, rows] of m) out.set(week, [...(out.get(week) || []), ...rows]);
    }
    return out;
}

test('an empty league config yields an empty board rather than throwing', () => {
    const board = buildWaiverBoard({ cfg: null });
    assert.deepEqual(board.targets, []);
    assert.deepEqual(board.fades, []);
});

test('players are ranked by what they add to YOUR lineup, not by raw value', () => {
    // The spine of the whole thing: a better player who cannot crack this
    // lineup is worth less to this team than a worse one who starts.
    const entries = roster();
    const board = buildWaiverBoard({
        cfg,
        entries,
        freeAgents: [
            // Would start at TE immediately: the roster's tight ends are 8 and 2.
            fa('teGood', 'TE', 13),
            // A better player in the abstract, but the roster already starts
            // three better receivers.
            fa('wrBlocked', 'WR', 11, 11 * 80),
        ],
    });
    assert.equal(board.targets[0].player.id, 'teGood');
    assert.ok(
        board.targets[0].lineupGain > board.targets[1].lineupGain,
        'the tight end must add more to this lineup than the blocked receiver'
    );
});

test('a rising role is recognised and said out loud', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('riser', 'WR', 9)],
        weeklyStats: weeklyStats('riser', 6, { ramp: true }),
        week: 7,
    });
    const row = board.targets[0];
    assert.ok(row.usage, 'usage must be computed when weekly stats are available');
    assert.equal(row.usage.rising, true);
    assert.ok(
        row.reasons.some((r) => r.kind === 'usage' && /snap share up/i.test(r.text)),
        `expected a snap-share reason, got: ${row.reasons.map((r) => r.text).join(' | ')}`
    );
});

test('a player whose role is growing ahead of the box score is a stash', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        // 4 points a week cannot start on this roster.
        freeAgents: [fa('prospect', 'WR', 4)],
        // Usage up, production flat: the role is arriving before the results.
        weeklyStats: weeklyStats('prospect', 6, { ramp: true, flatPoints: true }),
        week: 7,
    });
    assert.equal(board.targets[0].role, 'stash');
    assert.ok(
        board.targets[0].reasons.some((r) => /bet on what he becomes/.test(r.text)),
        'a stash must say it is a bet rather than implying he starts'
    );
});

test('a player who starts for you and is still growing is a must-add', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('both', 'TE', 14)],
        weeklyStats: weeklyStats('both', 6, { ramp: true }),
        week: 7,
    });
    assert.equal(board.targets[0].role, 'must-add');
});

test('touchdown-propped production is flagged rather than recommended', () => {
    // The classic trap, and the most-added player most weeks: the box score
    // looks wonderful because it is all touchdowns and the volume is thin.
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('mirage', 'WR', 9)],
        weeklyStats: weeklyStats('mirage', 5, { tdHeavy: true }),
        trending: new Map([['mirage', 40000]]),
        week: 6,
    });
    assert.equal(board.targets.length, 0, 'a flagged trap must not sit in the targets list');
    assert.equal(board.fades.length, 1);
    assert.equal(board.fades[0].player.id, 'mirage');
    assert.match(board.fades[0].caution.text, /touchdowns/);
});

test('a shrinking role is flagged as a caution', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('fading', 'WR', 9)],
        weeklyStats: weeklyStats('fading', 6, { shrinking: true }),
        week: 7,
    });
    const row = [...board.targets, ...board.fades].find((r) => r.player.id === 'fading');
    assert.ok(row.caution, 'a falling snap share must be caught');
    assert.equal(row.caution.kind, 'role-shrinking');
});

test('a trap is only called a fade when the league is actually chasing him', () => {
    // Without demand there is nobody to warn. He is just a bad pickup, and
    // belongs in the ranked list where his score can speak for itself.
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('quietMirage', 'WR', 9)],
        weeklyStats: weeklyStats('quietMirage', 5, { tdHeavy: true }),
        trending: new Map([['quietMirage', 12]]),
        week: 6,
    });
    assert.equal(board.fades.length, 0);
    assert.equal(board.targets.length, 1);
});

test('this week’s matchup is a tiebreaker, never the whole ranking', () => {
    const entries = roster();
    const soft = fa('soft', 'WR', 6);
    const strong = fa('strong', 'TE', 13);
    const board = buildWaiverBoard({
        cfg,
        entries,
        freeAgents: [soft, strong],
        weekEval: new Map([
            ['soft', { hasGame: true, opponent: 'NYJ', multiplier: 1.3, factors: [{ kind: 'matchup', detail: 'Softest matchup on the slate.' }] }],
            ['strong', { hasGame: true, opponent: 'SF', multiplier: 1.0, factors: [] }],
        ]),
        week: 6,
    });
    assert.equal(
        board.targets[0].player.id,
        'strong',
        'a soft matchup must not outrank a player who actually improves the lineup'
    );
});

test('between equal players, the one who actually plays this week wins', () => {
    // Deliberately EQUAL, because the stronger claim is false and worth being
    // explicit about: a player who is a point a week better for the rest of
    // the season is still the better add even if he is on bye right now. One
    // missed week does not undo ten better ones. The bye breaks a tie and is
    // always disclosed; it does not override the lineup.
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('bye', 'TE', 12), fa('plays', 'TE', 12)],
        weekEval: new Map([
            ['bye', { hasGame: false, onBye: true, multiplier: 1, factors: [] }],
            ['plays', { hasGame: true, opponent: 'NYJ', multiplier: 1, factors: [] }],
        ]),
        week: 6,
    });
    assert.equal(board.targets[0].player.id, 'plays');
    const byeRow = board.targets.find((r) => r.player.id === 'bye');
    assert.ok(byeRow.reasons.some((r) => /On bye/.test(r.text)), 'and the bye is always said out loud');
});

test('a clearly better player on bye is still the better add', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('byeBetter', 'TE', 16), fa('playsWorse', 'TE', 10)],
        weekEval: new Map([
            ['byeBetter', { hasGame: false, onBye: true, multiplier: 1, factors: [] }],
            ['playsWorse', { hasGame: true, opponent: 'NYJ', multiplier: 1, factors: [] }],
        ]),
        week: 6,
    });
    assert.equal(board.targets[0].player.id, 'byeBetter');
});

test('a playoff schedule only counts once it is close enough to plan for', () => {
    const playoffs = new Map([['KC', { rank: 1, of: 32, multiplier: 1.12, average: 28 }]]);
    const early = buildWaiverBoard({
        cfg, entries: roster(), freeAgents: [fa('p', 'WR', 3)], playoffs, week: 3,
    });
    const late = buildWaiverBoard({
        cfg, entries: roster(), freeAgents: [fa('p', 'WR', 3)], playoffs, week: 10,
    });
    assert.notEqual(early.targets[0].role, 'playoff', 'in week 3 a week-16 stash is a wasted roster spot');
    assert.equal(late.targets[0].role, 'playoff');
    assert.ok(late.targets[0].reasons.some((r) => r.kind === 'playoff'));
});

test('a mid-pack playoff schedule is not sold as a good one', () => {
    // The bug this covers: the strength row carries a rank and a multiplier
    // near 1, not a 0-1 score. Read as a score, every team in the league
    // qualified as having a great playoff schedule.
    const playoffs = new Map([['KC', { rank: 16, of: 32, multiplier: 1.0, average: 22 }]]);
    const board = buildWaiverBoard({
        cfg, entries: roster(), freeAgents: [fa('mid', 'WR', 3)], playoffs, week: 10,
    });
    assert.notEqual(board.targets[0].role, 'playoff');
    assert.ok(!board.targets[0].reasons.some((r) => r.kind === 'playoff'));
});

test('heavy demand is reported as competition, light demand as a bargain', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('hot', 'TE', 12), fa('cold', 'TE', 11)],
        trending: new Map([['hot', 42000], ['cold', 40]]),
        week: 6,
    });
    const hot = board.targets.find((r) => r.player.id === 'hot');
    const cold = board.targets.find((r) => r.player.id === 'cold');
    assert.match(hot.reasons.find((r) => r.kind === 'demand').text, /outbid/);
    assert.match(cold.reasons.find((r) => r.kind === 'demand').text, /cheap/);
});

test('an injury designation is never left off the card', () => {
    const hurt = fa('hurt', 'TE', 12);
    hurt.player.injury = 'Questionable';
    hurt.player.injuryBody = 'hamstring';
    const board = buildWaiverBoard({ cfg, entries: roster(), freeAgents: [hurt] });
    assert.ok(board.targets[0].reasons.some((r) => /Questionable \(hamstring\)/.test(r.text)));
});

test('a bid is quoted in what this league actually pays', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('target', 'TE', 12, 800)],
        faab: { usable: true, rate: 40, max: 60 },
    });
    assert.equal(board.targets[0].bid.dollars, 20, '800 of value at 40 per dollar is $20');
});

test('a bid is never quoted above what anyone in the league has paid', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('stud', 'TE', 20, 5000)],
        faab: { usable: true, rate: 40, max: 55 },
    });
    assert.equal(board.targets[0].bid.dollars, 55);
    assert.equal(board.targets[0].bid.capped, true);
});

test('no FAAB model means no invented price', () => {
    const board = buildWaiverBoard({ cfg, entries: roster(), freeAgents: [fa('x', 'TE', 12)] });
    assert.equal(board.targets[0].bid, null);
});

test('reasons are capped so the one that mattered is not buried', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('everything', 'TE', 14)],
        weeklyStats: weeklyStats('everything', 6, { ramp: true }),
        trending: new Map([['everything', 40000]]),
        weekEval: new Map([['everything', { hasGame: true, opponent: 'NYJ', multiplier: 1.2, factors: [{ kind: 'matchup', detail: 'Soft.' }] }]]),
        week: 10,
    });
    assert.ok(board.targets[0].reasons.length <= 5, 'six reasons is not six times as convincing as two');
});

// --- Who to drop -----------------------------------------------------------

test('the drop list is who costs least to lose, not who is worth least', () => {
    // Those are different players, and the difference is the whole point.
    const entries = roster();
    const drops = dropCandidates(entries, cfg);
    assert.ok(drops.length > 0);
    // The deep bench pieces cost nothing to lose; the starters cost real points.
    const cheapest = drops[0];
    assert.equal(cheapest.cost, 0, `the first drop must be free, cost ${cheapest.cost}`);
    const qb = entries.find((e) => e.player.id === 'qb1');
    const qbCost = dropCandidates(entries, cfg, 99).find((d) => d.player.id === 'qb1').cost;
    assert.ok(qbCost > 0, 'losing the only quarterback must cost something');
    void qb;
});

test('between two equally useless players the one with no future goes first', () => {
    const entries = [
        entry('qb1', 'QB', 18), entry('rb1', 'RB', 14), entry('rb2', 'RB', 11),
        entry('wr1', 'WR', 15), entry('wr2', 'WR', 12), entry('te1', 'TE', 8),
        entry('k1', 'K', 7), entry('def1', 'DEF', 6), entry('rb3', 'RB', 9),
        // Both score nothing this week. One is a young asset, the other is not.
        entry('keep', 'WR', 1, 3000),
        entry('cut', 'WR', 1, 10),
    ];
    const drops = dropCandidates(entries, cfg, 99);
    const cutIdx = drops.findIndex((d) => d.player.id === 'cut');
    const keepIdx = drops.findIndex((d) => d.player.id === 'keep');
    assert.ok(cutIdx < keepIdx, 'the one with no value should be dropped first');
});

test('an empty roster has nobody to drop', () => {
    assert.deepEqual(dropCandidates([], cfg), []);
    assert.deepEqual(dropCandidates(null, cfg), []);
});

// --- Shape -----------------------------------------------------------------

test('every role has a label, and roles are grouped for reading', () => {
    for (const role of ROLES) assert.ok(ROLE_LABEL[role], `${role} needs a label`);
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('a', 'TE', 14), fa('b', 'WR', 2)],
    });
    assert.ok(board.byRole instanceof Map);
    for (const [role, list] of board.byRole) {
        assert.ok(ROLES.includes(role));
        assert.ok(list.length > 0);
    }
});

test('the board respects its limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => fa(`p${i}`, 'WR', 10 - i * 0.1));
    const board = buildWaiverBoard({ cfg, entries: roster(), freeAgents: many, limit: 7 });
    assert.equal(board.targets.length, 7);
});

test('scoring is not required for a board to be built', () => {
    // Weekly stats need scoring to turn into usage. Without them the module
    // must still rank on lineup gain rather than failing.
    const board = buildWaiverBoard({ cfg, entries: roster(), freeAgents: [fa('x', 'TE', 13)] });
    assert.equal(board.targets.length, 1);
    assert.equal(board.targets[0].usage, null);
    void normalizeScoring;
    void scoring;
});

test('usage can reorder close calls but never jumps a materially better starter', () => {
    // The cap exists for this. Uncapped, a big snap-share swing was worth two
    // points a week of lineup gain, which let a hot role outrank a player who
    // was measurably better for the lineup today -- and made the claim that
    // lineup gain dominates untrue.
    const entries = roster();
    const board = buildWaiverBoard({
        cfg,
        entries,
        freeAgents: [
            // Clearly better for the lineup: the roster's tight ends are 8 and 2.
            fa('better', 'TE', 16),
            // Hot role, worse player.
            fa('hotRole', 'TE', 11),
        ],
        weeklyStats: mergeWeekly(weeklyStats('hotRole', 6, { ramp: true }), weeklyStats('better', 6)),
        week: 7,
    });
    const ids = board.targets.map((r) => r.player.id);
    assert.equal(ids[0], 'better', `a 5 pts/wk edge must survive any usage bonus, got ${ids.join(' > ')}`);
});

test('between players close on lineup gain, the rising role wins', () => {
    const entries = roster();
    const board = buildWaiverBoard({
        cfg,
        entries,
        freeAgents: [fa('flat', 'TE', 12.2), fa('rising', 'TE', 12)],
        weeklyStats: mergeWeekly(weeklyStats('rising', 6, { ramp: true }), weeklyStats('flat', 6)),
        week: 7,
    });
    assert.equal(board.targets[0].player.id, 'rising', 'inside the band, the growing role is the better bet');
});

test('three games is not enough history to call something a trend', () => {
    // With a two-game window, three games leaves ONE game as the baseline: a
    // player inactive in week 2 who started weeks 3 and 4 showed a snap share
    // "climbing" from 17% to 86% off a single observation. That is sometimes a
    // real role change and sometimes one healthy scratch, and this cannot tell
    // the difference -- so it must not present it as a trend.
    const three = buildWaiverBoard({
        cfg, entries: roster(), freeAgents: [fa('thin', 'WR', 5)],
        weeklyStats: weeklyStats('thin', 3, { ramp: true }), week: 4,
    });
    assert.equal(three.targets[0].usage, null, 'three games must not produce a trend');

    const four = buildWaiverBoard({
        cfg, entries: roster(), freeAgents: [fa('thin', 'WR', 5)],
        weeklyStats: weeklyStats('thin', 4, { ramp: true }), week: 5,
    });
    assert.ok(four.targets[0].usage, 'four games is enough for both halves to average two');
});

// --- Season-long and weekly are different questions ------------------------
//
// They compete for different things. A season-long add is worth a permanent
// roster spot and real FAAB; a weekly stream is worth a dollar and a spot you
// will reuse next week on somebody else. Ranking them together buries one in
// the other.

test('kickers and defenses are weekly streams, never season-long holds', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('dst', 'DEF', 9), fa('kicker', 'K', 9), fa('te', 'TE', 13)],
        weekEval: new Map([
            ['dst', { hasGame: true, opponent: 'CAR', adjusted: 11, multiplier: 1.2, factors: [{ kind: 'vegas', detail: 'Opponent implied for 15.5 points.' }] }],
            ['kicker', { hasGame: true, opponent: 'NYJ', adjusted: 9, multiplier: 1.1, factors: [] }],
            ['te', { hasGame: true, opponent: 'SF', adjusted: 13, multiplier: 1, factors: [] }],
        ]),
        week: 6,
    });

    const weeklyIds = board.weekly.map((r) => r.player.id);
    assert.ok(weeklyIds.includes('dst'), 'a defense belongs in the weekly list');
    assert.ok(weeklyIds.includes('kicker'), 'so does a kicker');
    assert.ok(!board.season.some((r) => ['dst', 'kicker'].includes(r.player.id)),
        'neither should compete for a season-long roster spot');
    assert.ok(board.season.some((r) => r.player.id === 'te'), 'the tight end is the season-long add');
});

test('the weekly list is ranked on this week, not on the season', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('meh', 'DEF', 12), fa('spot', 'DEF', 6)],
        weekEval: new Map([
            // Better season-long player, ordinary matchup.
            ['meh', { hasGame: true, opponent: 'SF', adjusted: 7, multiplier: 1, factors: [] }],
            // Worse player, dream matchup. For ONE week he is the better start.
            ['spot', { hasGame: true, opponent: 'CAR', adjusted: 14, multiplier: 1.4, factors: [{ kind: 'vegas', detail: 'Opponent implied for 14 points.' }] }],
        ]),
        week: 6,
    });
    assert.equal(board.weekly[0].player.id, 'spot');
});

test('a stream’s reasons are about this week, not its season-long role', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('dst', 'DEF', 8)],
        weekEval: new Map([
            ['dst', { hasGame: true, opponent: 'CAR', adjusted: 12, multiplier: 1.3, factors: [{ kind: 'vegas', detail: 'Opponent implied for 14.5 points.' }] }],
        ]),
        week: 6,
    });
    const row = board.weekly[0];
    assert.match(row.reasons[0].text, /12 points this week against CAR/);
    assert.ok(!row.reasons.some((r) => /starting lineup right now/.test(r.text)),
        'a one-week rental must not be sold on its season-long lineup contribution');
});

test('a weekly stream is never ranked without a game', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('bye', 'DEF', 14), fa('plays', 'DEF', 7)],
        weekEval: new Map([
            ['bye', { hasGame: false, onBye: true, multiplier: 1, factors: [] }],
            ['plays', { hasGame: true, opponent: 'CAR', adjusted: 8, multiplier: 1, factors: [] }],
        ]),
        week: 6,
    });
    assert.equal(board.weekly[0].player.id, 'plays', 'a defense on bye cannot be this week’s stream');
});

test('horizons are the two documented ones and nothing else', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('a', 'TE', 13), fa('b', 'DEF', 9), fa('c', 'WR', 2)],
    });
    for (const r of [...board.season, ...board.weekly]) {
        assert.ok(HORIZONS.includes(r.horizon), `${r.player.id} has horizon ${r.horizon}`);
    }
});

// --- An opening in front of him --------------------------------------------

test('an injured teammate ahead of him is spotted and named', () => {
    // The most reliable source of a genuinely new opportunity, and the thing
    // experienced managers actually scan the wire for.
    const players = {
        starter: { id: 'starter', name: 'Hurt Starter', pos: 'RB', team: 'KC', injury: 'Out', searchRank: 20 },
        backup: { id: 'backup', name: 'The Backup', pos: 'RB', team: 'KC', injury: null, searchRank: 200 },
    };
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [{ player: players.backup, posRank: 60, value: 120, score: 4 }],
        players,
        week: 6,
    });
    const row = board.season[0];
    assert.ok(row.opportunity, 'the opening must be detected');
    assert.equal(row.role, 'opportunity');
    assert.match(row.reasons[0].text, /Hurt Starter is out/);
});

test('an injured player BEHIND him on the depth chart changes nothing', () => {
    const players = {
        starter: { id: 'starter', name: 'The Starter', pos: 'RB', team: 'KC', injury: null, searchRank: 20 },
        hurtBackup: { id: 'hurtBackup', name: 'Hurt Backup', pos: 'RB', team: 'KC', injury: 'Out', searchRank: 300 },
    };
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [{ player: players.starter, posRank: 20, value: 400, score: 8 }],
        players,
        week: 6,
    });
    assert.equal(board.season[0].opportunity, null);
});

test('a teammate at another position is not an opening', () => {
    const players = {
        wr: { id: 'wr', name: 'Hurt Receiver', pos: 'WR', team: 'KC', injury: 'Out', searchRank: 10 },
        rb: { id: 'rb', name: 'A Back', pos: 'RB', team: 'KC', injury: null, searchRank: 200 },
    };
    const board = buildWaiverBoard({
        cfg, entries: roster(),
        freeAgents: [{ player: players.rb, posRank: 60, value: 120, score: 4 }],
        players, week: 6,
    });
    assert.equal(board.season[0].opportunity, null);
});

test('a designation that does not cost playing time is not an opening', () => {
    // "Questionable" is a coin flip the player usually wins. Treating it as an
    // opening would mark half the league as an opportunity every week.
    const players = {
        starter: { id: 'starter', name: 'Maybe Hurt', pos: 'RB', team: 'KC', injury: 'Questionable', searchRank: 20 },
        backup: { id: 'backup', name: 'The Backup', pos: 'RB', team: 'KC', injury: null, searchRank: 200 },
    };
    const board = buildWaiverBoard({
        cfg, entries: roster(),
        freeAgents: [{ player: players.backup, posRank: 60, value: 120, score: 4 }],
        players, week: 6,
    });
    assert.equal(board.season[0].opportunity, null);
});

test('no player database means no opportunity claims, not a crash', () => {
    const board = buildWaiverBoard({ cfg, entries: roster(), freeAgents: [fa('x', 'TE', 13)] });
    assert.equal(board.season[0].opportunity, null);
});

// --- What to bid -----------------------------------------------------------

test('a weekly stream is priced as a rental, whatever the model says', () => {
    // The going rate is fitted against season-long value, and a defense you
    // will drop on Tuesday has almost none. Paying real money for a one-week
    // rental is the most common way a budget gets wasted.
    const bid = suggestBid({ horizon: 'week', value: 900 }, { usable: true, rate: 10, max: 80, median: 12 }, 100);
    assert.equal(bid.dollars, 1);
    assert.equal(bid.minimum, true);
    assert.match(bid.note, /one-week rental/);
});

test('a season-long bid cites the league’s own going rate', () => {
    const bid = suggestBid(
        { horizon: 'season', value: 800 },
        { usable: true, rate: 40, max: 60, median: 14 },
        100
    );
    assert.equal(bid.dollars, 20);
    assert.match(bid.note, /median winning bid is \$14/);
    assert.match(bid.note, /20% of your remaining budget/);
});

test('a bid is never quoted above anything this league has paid', () => {
    const bid = suggestBid(
        { horizon: 'season', value: 5000 },
        { usable: true, rate: 40, max: 55, median: 14 },
        200
    );
    assert.equal(bid.dollars, 55);
    assert.equal(bid.capped, true);
    assert.match(bid.note, /nobody here has paid more than \$55/);
});

test('an unmeasured league gets no invented price', () => {
    assert.equal(suggestBid({ horizon: 'season', value: 800 }, null, 100), null);
    assert.equal(suggestBid({ horizon: 'season', value: 800 }, { usable: false, rate: 0 }, 100), null);
});

test('the share of budget is omitted when the budget is unknown', () => {
    const bid = suggestBid({ horizon: 'season', value: 800 }, { usable: true, rate: 40, max: 60, median: 14 }, null);
    assert.equal(bid.ofBudget, null);
    assert.ok(!/budget/.test(bid.note));
});

test('a rising player whose production is climbing too gets its own label', () => {
    const board = buildWaiverBoard({
        cfg,
        entries: roster(),
        freeAgents: [fa('breakout', 'WR', 5)],
        // Usage AND points climbing: value is going up in front of everybody.
        weeklyStats: weeklyStats('breakout', 6, { ramp: true }),
        week: 7,
    });
    assert.equal(board.season[0].role, 'rising');
    assert.equal(ROLE_LABEL.rising, 'Rising in value');
});
