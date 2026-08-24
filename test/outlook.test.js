import test from 'node:test';
import assert from 'node:assert/strict';

import {
    impliedTotalsOverWeeks, scheduleStrength, describeSchedule, playoffOutlook,
    playoffWeeksFor, DEFAULT_PLAYOFF_WEEKS,
} from '../js/outlook.js';
import { extractWeekOdds } from '../js/schedule.js';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';

/** One week of the schedule map: team -> environment. */
const week = (rows) => new Map(rows.map(([team, implied, opponent]) => [team, { team, implied, opponent, home: true, total: implied * 2 }]));

/** A season where LAR is in shootouts and NYJ is not. */
function season() {
    const schedule = new Map();
    for (let w = 4; w <= 18; w++) {
        schedule.set(w, week([
            ['LAR', 27, 'SF'],
            ['SF', 22, 'LAR'],
            ['NYJ', 17, 'NE'],
            ['NE', 22, 'NYJ'],
            ['BUF', 26, 'MIA'],
            ['MIA', 21, 'BUF'],
        ]));
    }
    return schedule;
}

// --- Parsing the payload the bye sweep already downloads --------------------

test('implied totals come out of the scoreboard the bye sweep already fetches', () => {
    // This is the whole point: eleven requests were being spent to produce a
    // bye map while the season's posted lines went in the bin.
    const games = extractWeekOdds({
        events: [{
            competitions: [{
                odds: [{ overUnder: 48.5, spread: -3.5 }],
                competitors: [
                    { homeAway: 'home', team: { abbreviation: 'KC' } },
                    { homeAway: 'away', team: { abbreviation: 'BUF' } },
                ],
            }],
        }],
    });

    assert.equal(games.size, 2);
    // ESPN quotes the spread from the home side, so KC -3.5 means KC scores
    // more: 48.5/2 + 1.75.
    assert.ok(Math.abs(games.get('KC').implied - 26) < 1e-9, `got ${games.get('KC').implied}`);
    assert.ok(Math.abs(games.get('BUF').implied - 22.5) < 1e-9);
    assert.equal(games.get('KC').opponent, 'BUF');
    assert.equal(games.get('KC').home, true);
    assert.equal(games.get('BUF').home, false);
});

test('an unpriced game contributes nothing rather than a zero', () => {
    const games = extractWeekOdds({
        events: [{
            competitions: [{
                odds: [],
                competitors: [
                    { homeAway: 'home', team: { abbreviation: 'KC' } },
                    { homeAway: 'away', team: { abbreviation: 'BUF' } },
                ],
            }],
        }],
    });
    assert.equal(games.size, 0);
});

test('ESPN’s abbreviation for Washington is normalized to Sleeper’s', () => {
    const games = extractWeekOdds({
        events: [{
            competitions: [{
                odds: [{ overUnder: 44, spread: 0 }],
                competitors: [
                    { homeAway: 'home', team: { abbreviation: 'WSH' } },
                    { homeAway: 'away', team: { abbreviation: 'DAL' } },
                ],
            }],
        }],
    });
    assert.ok(games.has('WAS'), 'a team the rest of the app cannot find is a team with no outlook');
});

// --- Aggregating ------------------------------------------------------------

test('the rest of the season is averaged per team', () => {
    const totals = impliedTotalsOverWeeks(season(), { from: 4, to: 18 });
    assert.equal(totals.get('LAR').games, 15);
    assert.ok(Math.abs(totals.get('LAR').average - 27) < 1e-9);
    assert.ok(totals.get('LAR').average > totals.get('NYJ').average);
});

test('a bye is skipped, not counted as a zero', () => {
    // A team with a week-9 bye does not have a worse offense, and averaging a
    // zero into its schedule would say exactly that.
    const schedule = season();
    const nine = new Map(schedule.get(9));
    nine.delete('LAR');
    schedule.set(9, nine);

    const totals = impliedTotalsOverWeeks(schedule, { from: 4, to: 18 });
    assert.equal(totals.get('LAR').games, 14, 'one fewer game');
    assert.ok(Math.abs(totals.get('LAR').average - 27) < 1e-9, 'and the same average');
});

test('only the weeks asked for are counted', () => {
    const totals = impliedTotalsOverWeeks(season(), { weeks: [15, 16, 17] });
    assert.equal(totals.get('LAR').games, 3);
});

test('best and worst weeks are kept, because a schedule is not its average', () => {
    const schedule = new Map([
        [4, week([['LAR', 31, 'SF'], ['SF', 14, 'LAR']])],
        [5, week([['LAR', 17, 'SEA'], ['SEA', 20, 'LAR']])],
    ]);
    const row = impliedTotalsOverWeeks(schedule, { from: 4, to: 5 }).get('LAR');
    assert.equal(row.best.implied, 31);
    assert.equal(row.best.week, 4);
    assert.equal(row.worst.implied, 17);
});

// --- Strength ---------------------------------------------------------------

test('schedule strength is league-relative and ranked', () => {
    const strength = scheduleStrength(impliedTotalsOverWeeks(season(), { from: 4, to: 18 }));
    const lar = strength.get('LAR');
    const nyj = strength.get('NYJ');

    assert.equal(lar.rank, 1);
    assert.equal(nyj.rank, strength.size);
    assert.ok(lar.multiplier > 1 && nyj.multiplier < 1);
    assert.ok(lar.edge > 0 && nyj.edge < 0);
});

test('the multiplier is deliberately gentle', () => {
    // Lines eleven weeks out are real information but not Sunday's
    // information: they move, players get hurt, and a season-long average of
    // soft numbers is a weaker signal than a posted line. A 10% swing in
    // implied points must not be a 10% swing in trade value.
    const strength = scheduleStrength(impliedTotalsOverWeeks(season(), { from: 4, to: 18 }));
    for (const row of strength.values()) {
        const swing = Math.abs(row.average / row.leagueAverage - 1);
        const applied = Math.abs(row.multiplier - 1);
        assert.ok(applied < swing, 'the value swing is smaller than the points swing');
        assert.ok(applied < 0.15, `no more than a modest nudge, got ${applied}`);
    }
});

test('too few teams is no measurement at all', () => {
    const thin = new Map([[4, week([['LAR', 27, 'SF'], ['SF', 22, 'LAR']])]]);
    assert.equal(scheduleStrength(impliedTotalsOverWeeks(thin, { from: 4, to: 4 })).size, 0);
});

test('an average schedule gets no sentence written about it', () => {
    const strength = scheduleStrength(impliedTotalsOverWeeks(season(), { from: 4, to: 18 }));
    const middling = [...strength.values()].find((r) => Math.abs(r.edge) < 0.6);
    if (middling) assert.equal(describeSchedule(middling), null, 'nothing to say is better than saying nothing');
    assert.match(describeSchedule(strength.get('LAR')), /better remaining slates/);
    assert.match(describeSchedule(strength.get('NYJ')), /drag/);
});

// --- Playoff weeks ----------------------------------------------------------

test('the playoff weeks are read from the league, not assumed', () => {
    const early = normalizeLeague({
        settings: { playoff_week_start: 14 },
        scoring_settings: {},
        roster_positions: defaultRosterPositions(),
    });
    assert.deepEqual(playoffWeeksFor(early), [14, 15, 16, 17]);
    assert.deepEqual(playoffWeeksFor(null), DEFAULT_PLAYOFF_WEEKS);
});

test('playoff-week environments are ranked separately from the season', () => {
    // A team can be fine all year and collapse in weeks 15-17, and those are
    // the only three weeks that decide anything.
    const schedule = season();
    for (const w of [15, 16, 17]) {
        schedule.set(w, week([
            ['LAR', 15, 'SEA'],
            ['SEA', 15, 'LAR'],
            ['NYJ', 30, 'NE'],
            ['NE', 24, 'NYJ'],
            ['BUF', 21, 'MIA'],
            ['MIA', 21, 'BUF'],
        ]));
    }

    const season_ = scheduleStrength(impliedTotalsOverWeeks(schedule, { from: 4, to: 18 }));
    const playoffs = playoffOutlook(schedule);

    assert.ok(season_.get('LAR').rank < season_.get('NYJ').rank, 'LAR is better across the year');
    assert.ok(playoffs.get('NYJ').rank < playoffs.get('LAR').rank, 'and worse when it counts');
    assert.equal(playoffs.get('LAR').games, 3);
});
