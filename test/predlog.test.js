// The prediction log: the record that makes the app's own adjustments
// checkable, since six of them cannot be reconstructed after the fact.

import test from 'node:test';
import assert from 'node:assert/strict';

// predlog.js touches localStorage, so the shim has to exist before the module.
function installStorage() {
    const map = new Map();
    globalThis.localStorage = {
        getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
        setItem: (k, v) => map.set(String(k), String(v)),
        removeItem: (k) => map.delete(String(k)),
        clear: () => map.clear(),
        get length() { return map.size; },
    };
    return map;
}
const storage = installStorage();
const log = await import('../js/predlog.js');

test.beforeEach(() => storage.clear());

const ev = (id, pos, pred, factors = {}, extra = {}) => ({
    player: { id, pos, team: 'KC' },
    opponent: 'BUF',
    rawProjection: extra.proj ?? 10,
    marketLevel: extra.mkt ?? 14,
    baseProjection: extra.base ?? 12,
    adjusted: pred,
    factors: Object.entries(factors).map(([kind, multiplier]) => ({ kind, multiplier })),
});

test('a prediction is stored with the multipliers that produced it', () => {
    const res = log.recordPredictions({
        season: 2026, week: 5,
        evaluations: [ev('a', 'RB', 13.2, { vegas: 1.05, weather: 0.92 })],
    });
    assert.equal(res.written, 1);
    const entries = log.readLog();
    assert.equal(entries.length, 1);
    const row = entries[0].rows[0];
    assert.equal(row.id, 'a');
    assert.equal(row.pred, 13.2);
    assert.equal(row.proj, 10, 'the untouched consensus projection is kept');
    assert.equal(row.mkt, 14, 'so is what the market said');
    assert.equal(row.factors.vegas, 1.05);
    assert.equal(row.factors.weather, 0.92);
});

test('reopening the week does not overwrite what was predicted', () => {
    // The whole point. Reopening on Sunday after the early games and
    // rewriting Thursday's numbers would make every adjustment look good.
    log.recordPredictions({ season: 2026, week: 5, evaluations: [ev('a', 'RB', 10)] });
    const second = log.recordPredictions({ season: 2026, week: 5, evaluations: [ev('a', 'RB', 25)] });
    assert.equal(second.written, 0);
    assert.equal(second.skipped, true);
    assert.equal(log.readLog()[0].rows[0].pred, 10, 'the original prediction stands');
});

test('a player who cannot be started is not a prediction', () => {
    const res = log.recordPredictions({
        season: 2026, week: 5,
        evaluations: [ev('out', 'RB', null), ev('bye', 'WR', undefined), ev('ok', 'TE', 8)],
    });
    assert.equal(res.written, 1);
    assert.deepEqual(log.readLog()[0].rows.map((r) => r.id), ['ok']);
});

test('unknown factor kinds are not recorded', () => {
    // The column set is fixed, so a new factor cannot silently widen the log.
    log.recordPredictions({
        season: 2026, week: 5,
        evaluations: [ev('a', 'RB', 10, { vegas: 1.1, somethingNew: 1.5 })],
    });
    const f = log.readLog()[0].rows[0].factors;
    assert.equal(f.vegas, 1.1);
    assert.equal('somethingNew' in f, false);
});

test('weeks are ordered by season and week, not by when they were written', () => {
    log.recordPredictions({ season: 2026, week: 10, evaluations: [ev('a', 'RB', 1)] });
    log.recordPredictions({ season: 2026, week: 2, evaluations: [ev('b', 'RB', 2)] });
    log.recordPredictions({ season: 2025, week: 17, evaluations: [ev('c', 'RB', 3)] });
    assert.deepEqual(
        log.readLog().map((e) => `${e.season}:${e.week}`),
        ['2025:17', '2026:2', '2026:10']
    );
});

test('the log is bounded, and drops the oldest week first', () => {
    for (let w = 1; w <= 25; w++) {
        log.recordPredictions({ season: 2026, week: w, evaluations: [ev(`p${w}`, 'RB', w)] });
    }
    const entries = log.readLog();
    assert.ok(entries.length <= 20, `kept ${entries.length} weeks`);
    assert.equal(entries[entries.length - 1].week, 25, 'the newest week survives');
    assert.ok(entries[0].week > 1, 'and week 1 has fallen off');
});

test('a store that refuses to write costs the log, not the page', () => {
    const original = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    const res = log.recordPredictions({ season: 2026, week: 5, evaluations: [ev('a', 'RB', 10)] });
    assert.equal(res.written, 0, 'it reports that nothing was stored');
    globalThis.localStorage.setItem = original;
    // And the app keeps working.
    assert.deepEqual(log.readLog(), []);
    assert.deepEqual(log.logSummary(), { weeks: 0, rows: 0, first: null, last: null });
});

test('a corrupt store reads as empty rather than throwing', () => {
    globalThis.localStorage.setItem('ffc:predlog:v1', '{not json');
    assert.deepEqual(log.readLog(), []);
});

test('the export is a flat table with one column per factor', () => {
    log.recordPredictions({
        season: 2026, week: 5,
        evaluations: [ev('a', 'RB', 13.2, { vegas: 1.05, health: 0.8 })],
    });
    const csv = log.logToCsv();
    const [head, row] = csv.split('\n');
    for (const kind of log.FACTOR_KINDS) assert.ok(head.includes(kind), `${kind} column missing`);
    assert.ok(row.startsWith('2026,5,a,RB,KC,BUF,'));
    // A factor that did not apply leaves its cell empty rather than writing 1,
    // so "not applied" and "applied and did nothing" stay distinguishable.
    assert.equal(head.split(',').length, row.split(',').length);
    assert.match(csv, /,1\.05,/);
});

// --- Scoring ---------------------------------------------------------------

test('scoring attributes error to the factor that caused it', () => {
    // One player, predicted 12 by taking a base of 10 and multiplying by 1.2,
    // who then scored 10. Dividing the factor back out would have been exact,
    // so the factor is charged the whole error.
    log.recordPredictions({
        season: 2026, week: 5,
        evaluations: [ev('a', 'RB', 12, { vegas: 1.2 }, { base: 10 })],
    });
    const scored = log.scoreLog(log.readLog(), () => 10);
    assert.equal(scored.overall.n, 1);
    assert.equal(scored.overall.mean, 2, 'predicted two points too high');
    assert.ok(scored.byFactor.vegas.mean > 0, 'and the multiplier is what did it');
    assert.equal(scored.byFactor.vegas.mean, 2);
});

test('a factor that improved a prediction is credited, not charged', () => {
    // Base 10, multiplied by 1.2 to 12, and he scored 12.
    log.recordPredictions({
        season: 2026, week: 5,
        evaluations: [ev('a', 'RB', 12, { vegas: 1.2 }, { base: 10 })],
    });
    const scored = log.scoreLog(log.readLog(), () => 12);
    assert.equal(scored.overall.mean, 0);
    assert.ok(scored.byFactor.vegas.mean < 0, 'without it we would have been two points low');
});

test('a factor of exactly 1 is not scored, because it did nothing', () => {
    log.recordPredictions({
        season: 2026, week: 5,
        evaluations: [ev('a', 'RB', 10, { matchup: 1 }, { base: 10 })],
    });
    const scored = log.scoreLog(log.readLog(), () => 8);
    assert.equal(scored.byFactor.matchup, undefined);
});

test('players with no result yet are skipped rather than scored as zero', () => {
    log.recordPredictions({
        season: 2026, week: 5,
        evaluations: [ev('played', 'RB', 10), ev('didnt', 'RB', 10)],
    });
    const scored = log.scoreLog(log.readLog(), (s, w, id) => (id === 'played' ? 9 : null));
    assert.equal(scored.overall.n, 1);
});

test('an empty log scores as nothing rather than NaN', () => {
    const scored = log.scoreLog([], () => 10);
    assert.equal(scored.overall, null);
    assert.deepEqual(scored.byFactor, {});
});
