import test from 'node:test';
import assert from 'node:assert/strict';

import { critiqueRoster } from '../js/critique.js';
import { createValuationContext } from '../js/valuation.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { buildEntries } from '../js/trade.js';

const cfg = normalizeLeague({
    settings: { num_teams: 10, playoff_teams: 4, playoff_week_start: 15 },
    scoring_settings: { rush_yd: 0.1, rec_yd: 0.1, rec: 0.5 },
    roster_positions: defaultRosterPositions(),
});

let uid = 0;
function pool() {
    const projections = {};
    const mk = (pos, ppg) => {
        const id = `p${++uid}`;
        projections[id] = { id, pos, games: 17, stats: { rush_yd: ppg * 170 }, ptsHalfPpr: 1 };
        return { id, name: `${pos}-${ppg}`, pos, team: 'KC', age: 26, injury: null };
    };
    const rank = (teams) => {
        const rankings = new Map();
        const byPos = {};
        for (const t of teams) for (const p of t.players) (byPos[p.pos] ||= []).push(p);
        for (const list of Object.values(byPos)) {
            list.sort((a, b) => projections[b.id].stats.rush_yd - projections[a.id].stats.rush_yd);
            list.forEach((p, i) => rankings.set(p.id, i + 1));
        }
        return rankings;
    };
    return { projections, mk, rank };
}

/** `me` is roster 1; everyone else is a league-average filler. */
function league(mySpec, { fillers = 9, fillerSpec = null } = {}) {
    const { projections, mk, rank } = pool();
    const teams = [];
    const add = (rosterId, name, spec) =>
        teams.push({
            rosterId, name, wins: 3, losses: 3, ties: 0, pointsFor: 700,
            players: spec.map(([pos, ppg]) => mk(pos, ppg)),
        });

    add(1, 'Me', mySpec);
    const base = fillerSpec || [
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 10],
        ['WR', 14], ['WR', 13], ['WR', 12], ['WR', 10],
        ['TE', 9], ['K', 7], ['DEF', 6],
    ];
    for (let i = 2; i <= fillers + 1; i++) add(i, `T${i}`, base);

    const rankings = rank(teams);
    const ctx = createValuationContext(cfg, { week: 7, weeksLeft: 8, projections });
    const entriesFor = (team) => buildEntries(team.players, rankings, ctx);
    return { teams, rankings, ctx, entriesFor, team: teams[0], projections };
}

const run = (fixture, extra = {}) =>
    critiqueRoster({
        team: fixture.team,
        teams: fixture.teams,
        cfg,
        ctx: fixture.ctx,
        rankings: fixture.rankings,
        entriesFor: fixture.entriesFor,
        currentWeek: 7,
        ...extra,
    });

const kinds = (res) => res.findings.map((f) => f.kind);

// --- The rules the whole thing is built on ---------------------------------

test('no finding arrives without a number in it', () => {
    // "Weak at running back" is a horoscope. "3.4 points a week below the
    // league, 11th of 12" is a fact somebody can check and argue with.
    const fx = league([
        ['QB', 17], ['RB', 5], ['RB', 4], ['RB', 3],
        ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const res = run(fx);
    assert.equal(res.ok, true);
    assert.ok(res.findings.length, 'a threadbare backfield has to produce findings');

    for (const f of res.findings) {
        assert.match(
            `${f.title} ${f.detail}`,
            /\d/,
            `"${f.title}" makes a claim with no number behind it`
        );
    }
});

test('no finding arrives without a fix', () => {
    // A critique that stops at the diagnosis is just an insult.
    const fx = league([
        ['QB', 17], ['RB', 5], ['RB', 4], ['RB', 3],
        ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    for (const f of run(fx).findings) {
        assert.ok(f.fix && f.fix.length > 20, `"${f.title}" has no fix`);
    }
});

test('a roster with nothing wrong is told so in one line, not padded', () => {
    // Flattery is not feedback, and neither is inventing problems to fill a
    // page. This roster is the league's own average, twice over.
    const balanced = [
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 11],
        ['WR', 14], ['WR', 13], ['WR', 12], ['WR', 11],
        ['TE', 9], ['K', 7], ['DEF', 6],
    ];
    const fx = league(balanced, { fillerSpec: balanced });
    const res = run(fx);
    const real = res.findings.filter((f) => f.severity !== 'good');
    assert.equal(real.length, 0, `expected no complaints, got: ${real.map((f) => f.title).join('; ')}`);
    assert.match(res.summary, /No structural problems/);
});

// --- What it actually catches ----------------------------------------------

test('a genuine hole is named, sized and ranked', () => {
    const fx = league([
        ['QB', 17], ['RB', 4], ['RB', 3], ['RB', 2],
        ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const res = run(fx);
    const hole = res.findings.find((f) => f.kind === 'hole' && f.pos === 'RB');
    assert.ok(hole, `expected a running back hole, found: ${kinds(res).join(', ')}`);
    assert.match(hole.detail, /league average/);
    assert.match(hole.detail, /of \d+/, 'and where this roster ranks');
    assert.equal(hole.action.view, 'finder', 'the fix points somewhere you can act');
});

test('a weak second starter is caught even when the average looks fine', () => {
    // One good receiver and a waiver body averages the same as two real ones
    // and is not the same team.
    const fx = league([
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 11],
        ['WR', 22], ['WR', 4], ['WR', 3], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const res = run(fx);
    const found = res.findings.find((f) => f.kind === 'weak-starter' || f.kind === 'hole');
    assert.ok(found, `expected the receiver room flagged, found: ${kinds(res).join(', ')}`);
});

test('a roster with no difference-maker is told it has no ceiling', () => {
    // Same points per starting slot as the league; nobody who wins a week on
    // his own. A deficit would fire the louder "hole" finding instead, so the
    // room has to be genuinely average for this to be the thing that is wrong.
    // Both rosters start three receivers averaging 17.3 a slot. Theirs has a
    // 24 in it and mine does not, which is the entire finding: a deficit would
    // fire the louder "hole" instead, so the room has to be genuinely average.
    const fx = league([
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 8],
        ['WR', 18], ['WR', 17], ['WR', 17], ['WR', 10],
        ['TE', 9], ['K', 7], ['DEF', 6],
    ], {
        fillerSpec: [
            ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 8],
            ['WR', 24], ['WR', 14], ['WR', 14], ['WR', 10],
            ['TE', 9], ['K', 7], ['DEF', 6],
        ],
    });
    const res = run(fx);
    const ceiling = res.findings.find((f) => f.kind === 'no-ceiling');
    assert.ok(ceiling, `expected a no-ceiling note, found: ${kinds(res).join(', ')}`);
    assert.match(ceiling.fix, /[Cc]onsolidat/);
});

test('a one-man position is called fragile', () => {
    const fx = league([
        ['QB', 17], ['RB', 24], ['RB', 3], ['RB', 2],
        ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const res = run(fx);
    const fragile = res.findings.find((f) => f.kind === 'fragile');
    assert.ok(fragile, `expected a fragility warning, found: ${kinds(res).join(', ')}`);
    assert.match(fragile.detail, /nothing behind him/);
});

test('startable players stuck on the bench are called out as an asset, not depth', () => {
    const fx = league([
        ['QB', 17], ['RB', 15], ['RB', 14], ['RB', 14], ['RB', 13], ['RB', 13],
        ['WR', 15], ['WR', 14], ['WR', 14], ['WR', 13], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const res = run(fx);
    const stranded = res.findings.find((f) => f.kind === 'stranded');
    assert.ok(stranded, `expected stranded depth, found: ${kinds(res).join(', ')}`);
    assert.match(stranded.fix, /[Cc]onsolidat/);
});

test('a bye-week pile-up is found, and a playoff-week one is worse', () => {
    const fx = league([
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 11],
        ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const byes = new Map();
    for (const p of fx.team.players.slice(0, 4)) byes.set(p.team, 9);

    const res = run(fx, { byeWeeks: byes });
    const bye = res.findings.find((f) => f.kind === 'bye');
    assert.ok(bye, `expected a bye conflict, found: ${kinds(res).join(', ')}`);
    assert.match(bye.title, /Week 9/);

    // The same pile-up in a playoff week is a different severity.
    const playoffByes = new Map();
    for (const p of fx.team.players.slice(0, 4)) playoffByes.set(p.team, 16);
    const worse = run(fx, { byeWeeks: playoffByes }).findings.find((f) => f.kind === 'bye');
    assert.equal(worse.severity, 'critical');
    assert.match(worse.detail, /playoff week/);
});

// --- Posture ---------------------------------------------------------------

test('a good roster with bad odds is told to buy', () => {
    const fx = league([
        ['QB', 22], ['RB', 20], ['RB', 19], ['RB', 18],
        ['WR', 21], ['WR', 20], ['WR', 19], ['TE', 14], ['K', 9], ['DEF', 9],
    ]);
    const res = run(fx, { playoffOdds: new Map([[1, 0.22]]) });
    const unlucky = res.findings.find((f) => f.kind === 'unlucky');
    assert.ok(unlucky, `expected a buy signal, found: ${kinds(res).join(', ')}`);
    assert.match(unlucky.fix, /Buy/);
});

test('a bad roster with no odds is told to sell, plainly', () => {
    const fx = league([
        ['QB', 8], ['RB', 5], ['RB', 4], ['RB', 3],
        ['WR', 6], ['WR', 5], ['WR', 4], ['TE', 3], ['K', 4], ['DEF', 3],
    ]);
    const res = run(fx, { playoffOdds: new Map([[1, 0.04]]) });
    const sell = res.findings.find((f) => f.kind === 'sell');
    assert.ok(sell, `expected a sell signal, found: ${kinds(res).join(', ')}`);
    assert.match(sell.detail, /not making the playoffs|% to qualify/);
});

// --- Ordering and shape ----------------------------------------------------

test('the worst problem is at the top', () => {
    const fx = league([
        ['QB', 17], ['RB', 3], ['RB', 2], ['RB', 2],
        ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const res = run(fx);
    const order = res.findings.map((f) => f.severity);
    const rank = { critical: 3, warning: 2, note: 1, good: 0 };
    for (let i = 1; i < order.length; i++) {
        assert.ok(rank[order[i - 1]] >= rank[order[i]], 'findings must be ordered worst first');
    }
});

test('the summary is built from what was found, not from a template', () => {
    const fx = league([
        ['QB', 17], ['RB', 3], ['RB', 2], ['RB', 2],
        ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const res = run(fx);
    assert.match(res.summary, /of \d+ on lineup strength/);
    assert.ok(
        res.summary.includes(res.findings.find((f) => f.severity !== 'good').title),
        'the summary leads with the actual worst finding'
    );
});

test('an unknown roster is refused rather than analysed as an empty one', () => {
    const fx = league([['QB', 17], ['RB', 13], ['WR', 14], ['TE', 9], ['K', 7], ['DEF', 6]]);
    const res = critiqueRoster({
        team: { rosterId: 999, name: 'Ghost', players: [] },
        teams: fx.teams,
        cfg,
        ctx: fx.ctx,
        rankings: fx.rankings,
        entriesFor: fx.entriesFor,
    });
    assert.equal(res.ok, false);
});

test('a schedule nobody has loaded produces no schedule claims', () => {
    // Silence is the honest output when the data is not there. Inventing a
    // "tough schedule" note from nothing would be worse than saying nothing.
    const fx = league([
        ['QB', 17], ['RB', 13], ['RB', 12], ['RB', 11],
        ['WR', 14], ['WR', 13], ['WR', 12], ['TE', 9], ['K', 7], ['DEF', 6],
    ]);
    const res = run(fx, { restOfSeason: null, playoffSchedule: null });
    assert.ok(!res.findings.some((f) => f.kind.includes('schedule')));
});
