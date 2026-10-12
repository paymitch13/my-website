// A record of what we predicted, so that next week we can find out how wrong
// we were and why.
//
// The app applies seven adjustments to every weekly number -- the market
// level, the Vegas multiplier, the game-script table, the line-movement nudge,
// the defensive matchup, the weather discount, the injury discount and the
// player-prop blend. Exactly one of them could be checked after the fact, and
// checking it showed it was making predictions worse. The other six cannot be
// checked retrospectively at all, because their inputs are gone within days:
// ESPN strips odds and props from completed games, weather APIs do not serve
// the past cheaply, and Sleeper reports today's injury designations rather
// than last Sunday's.
//
// So the app could not learn from itself. Every adjustment in it was a
// plausible story with no number attached, and a plausible story that moves a
// projection by 29% is a liability. This records each prediction and its
// components as they are made, which is the only moment the inputs exist.
//
// Deliberately small and append-only: one row per player per week, written
// once, never rewritten when the page is reopened. `tools/accuracy.mjs` scores
// an export of this against what actually happened.

const KEY = 'ffc:predlog:v1';
/** Weeks to keep. A season plus playoffs, then the oldest falls off. */
const MAX_WEEKS = 20;

const read = () => {
    try {
        const raw = localStorage.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

const write = (value) => {
    try {
        localStorage.setItem(KEY, JSON.stringify(value));
        return true;
    } catch {
        // A full or blocked store costs the log, never the page. The app has
        // always had to work with localStorage throwing.
        return false;
    }
};

/** The multipliers worth keeping apart, in the order they are applied. */
export const FACTOR_KINDS = ['vegas', 'script', 'movement', 'matchup', 'weather', 'health', 'market'];

/**
 * One row per prediction: enough to re-derive the error and attribute it, and
 * nothing else. Names are left out on purpose -- the player id is the join key
 * and a name would triple the size of the row for no analytic value.
 */
export function rowFor(evaluation) {
    const ev = evaluation;
    if (!ev?.player?.id || ev.adjusted === null || ev.adjusted === undefined) return null;

    const factors = {};
    for (const f of ev.factors || []) {
        if (!FACTOR_KINDS.includes(f.kind)) continue;
        // Rounded: four decimals is far finer than any of these are known to,
        // and it keeps the log readable.
        factors[f.kind] = Math.round(f.multiplier * 1e4) / 1e4;
    }

    return {
        id: String(ev.player.id),
        pos: ev.player.pos || null,
        team: ev.player.team || null,
        opp: ev.opponent || null,
        // The consensus projection, before anything was done to it.
        proj: round4(ev.rawProjection ?? ev.baseProjection),
        // What the trade market said he was worth per game.
        mkt: round4(ev.marketLevel),
        // The level actually used, after the market blend.
        base: round4(ev.baseProjection),
        // What we finally said he would score.
        pred: round4(ev.adjusted),
        factors,
    };
}

const round4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

/**
 * Record this week's predictions, once.
 *
 * Append-only by design. Reopening Start/Sit on Sunday morning after the early
 * games would otherwise overwrite Thursday's predictions with ones made in
 * hindsight, and a log that quietly improves itself is worse than no log --
 * it would make every adjustment look good.
 *
 * @returns {{written: number, skipped: boolean}}
 */
export function recordPredictions({ season, week, evaluations, now = Date.now() }) {
    if (!season || !week || !Array.isArray(evaluations)) return { written: 0, skipped: true };
    const log = read();
    const key = `${season}:${week}`;
    if (log[key]) return { written: 0, skipped: true };

    const rows = evaluations.map(rowFor).filter(Boolean);
    if (!rows.length) return { written: 0, skipped: true };

    log[key] = { at: new Date(now).toISOString(), rows };

    // Oldest weeks fall off first, by season then week rather than by
    // insertion order, so a mid-season reload cannot evict the wrong one.
    const keys = Object.keys(log).sort((a, b) => {
        const [sa, wa] = a.split(':').map(Number);
        const [sb, wb] = b.split(':').map(Number);
        return sa - sb || wa - wb;
    });
    while (keys.length > MAX_WEEKS) delete log[keys.shift()];

    return { written: write(log) ? rows.length : 0, skipped: false };
}

/** Everything logged, oldest first. */
export function readLog() {
    const log = read();
    return Object.entries(log)
        .map(([key, value]) => {
            const [season, week] = key.split(':').map(Number);
            return { season, week, at: value?.at ?? null, rows: value?.rows || [] };
        })
        .filter((e) => Number.isFinite(e.season) && Number.isFinite(e.week))
        .sort((a, b) => a.season - b.season || a.week - b.week);
}

/** How much is banked, for a one-line status. */
export function logSummary() {
    const entries = readLog();
    return {
        weeks: entries.length,
        rows: entries.reduce((a, e) => a + e.rows.length, 0),
        first: entries[0] ? `${entries[0].season} wk ${entries[0].week}` : null,
        last: entries[entries.length - 1]
            ? `${entries[entries.length - 1].season} wk ${entries[entries.length - 1].week}`
            : null,
    };
}

/**
 * The log as a CSV, one row per prediction, every factor its own column.
 *
 * A flat table rather than the stored JSON, because the point of exporting is
 * to score it somewhere else, and every tool that could score it reads a
 * table.
 */
export function logToCsv(entries = readLog()) {
    const head = ['season', 'week', 'player_id', 'pos', 'team', 'opponent', 'projection', 'market', 'level', 'predicted', ...FACTOR_KINDS];
    const lines = [head.join(',')];
    for (const e of entries) {
        for (const r of e.rows) {
            lines.push([
                e.season, e.week, r.id, r.pos ?? '', r.team ?? '', r.opp ?? '',
                r.proj ?? '', r.mkt ?? '', r.base ?? '', r.pred ?? '',
                ...FACTOR_KINDS.map((k) => (r.factors?.[k] ?? '')),
            ].join(','));
        }
    }
    return lines.join('\n');
}

/** Drop everything. Only ever called from an explicit user action. */
export function clearLog() {
    try {
        localStorage.removeItem(KEY);
        return true;
    } catch {
        return false;
    }
}

/**
 * Score the log against what actually happened.
 *
 * Kept here rather than in the tool so the app can show its own accuracy, and
 * so there is one definition of the error rather than two that drift.
 *
 * @param {Array} entries from `readLog()`
 * @param {(season:number, week:number, id:string) => number|null} actualFor
 */
export function scoreLog(entries, actualFor) {
    const errs = [];
    const byPos = new Map();
    // Each factor's error contribution, measured the only way that is honest:
    // the same prediction with that one factor divided back out.
    const byFactor = new Map();

    for (const e of entries || []) {
        for (const r of e.rows) {
            const real = actualFor(e.season, e.week, r.id);
            if (!Number.isFinite(real) || !Number.isFinite(r.pred)) continue;
            const err = r.pred - real;
            errs.push(err);
            if (!byPos.has(r.pos)) byPos.set(r.pos, []);
            byPos.get(r.pos).push(err);

            for (const kind of FACTOR_KINDS) {
                const m = r.factors?.[kind];
                if (!Number.isFinite(m) || m === 0 || m === 1) continue;
                if (!byFactor.has(kind)) byFactor.set(kind, []);
                // |error with it| - |error without it|: negative means the
                // factor earned its place on this prediction.
                byFactor.get(kind).push(Math.abs(err) - Math.abs(r.pred / m - real));
            }
        }
    }

    const summarize = (list) => {
        if (!list.length) return null;
        const mean = list.reduce((a, b) => a + b, 0) / list.length;
        const mae = list.reduce((a, b) => a + Math.abs(b), 0) / list.length;
        const sd = Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length);
        return { n: list.length, mean, mae, se: sd / Math.sqrt(list.length) };
    };

    return {
        overall: summarize(errs),
        byPosition: Object.fromEntries([...byPos].map(([k, v]) => [k, summarize(v)])),
        // For a factor, `mean` is the average damage done; positive means it
        // made predictions worse, and |mean| over se above 2 means we know.
        byFactor: Object.fromEntries([...byFactor].map(([k, v]) => [k, summarize(v)])),
    };
}
