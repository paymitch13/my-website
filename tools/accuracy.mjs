// How wrong are we, and where?
//
// Run with:  node tools/accuracy.mjs [season] [--week N] [--scoring half|full|std]
//
// Scores the app's own weekly predictions against what actually happened, one
// week at a time, and breaks the error down far enough to act on. Nothing here
// is used by the app itself -- it exists so that every change to the model has
// a number attached instead of an argument.
//
// WHAT IT CAN AND CANNOT SEE. The weekly projection, the season blend and the
// defensive-matchup adjustment are all reconstructible after the fact, because
// their inputs are box scores. The Vegas multiplier, the game-script table,
// the line-movement nudge, the weather discount, the injury discount and the
// player-prop blend are NOT: ESPN strips odds from completed games, weather
// APIs do not serve the past cheaply, and Sleeper reports today's injury
// designations rather than last Sunday's. Those six adjustments are applied to
// every number the app shows and have never been validated, and they cannot be
// validated retrospectively -- which is why `tools/predlog.mjs` records them
// as they are made.

import { readFileSync, existsSync } from 'node:fs';
import { normalizeLeague, defaultRosterPositions } from '../js/league.js';
import { normalizeProjections, scoreStats, projectedPpg, blendedPpg, actualsWeight } from '../js/projections.js';
import { trimPlayers } from '../js/sleeper.js';
import { createValuationContext } from '../js/valuation.js';
import { parseMarketValues, marketRanks } from '../js/market.js';
import { buildDefenseProfiles, matchupImpact } from '../js/matchup.js';
import { MARKET_WEIGHT } from '../js/rankings.js';

const SCORINGS = {
    half: { rec: 0.5, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6, pass_td: 4, pass_int: -2, fum_lost: -2, fgm: 3, xpm: 1, sack: 1, int: 2, def_td: 6, pts_allow_7_13: 4 },
    full: { rec: 1, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6, pass_td: 4, pass_int: -2, fum_lost: -2, fgm: 3, xpm: 1, sack: 1, int: 2, def_td: 6, pts_allow_7_13: 4 },
    std: { rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6, pass_td: 4, pass_int: -2, fum_lost: -2, fgm: 3, xpm: 1, sack: 1, int: 2, def_td: 6, pts_allow_7_13: 4 },
};

const args = process.argv.slice(2);
const season = args.find((a) => /^\d{4}$/.test(a)) || '2026';
const scoringKey = args.includes('--scoring') ? args[args.indexOf('--scoring') + 1] : 'half';
const onlyWeek = args.includes('--week') ? Number(args[args.indexOf('--week') + 1]) : null;
const DIR = args.find((a) => a.startsWith('--data='))?.slice(7) || '.';

const load = (name) => {
    const path = `${DIR}/${name}`;
    if (!existsSync(path)) {
        console.error(`missing ${path}. Fetch it first — see the header of this file.`);
        process.exit(2);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
};

const players = trimPlayers(load('players.json'));
const seasonProjections = normalizeProjections(load('proj2026.json'));
const marketBy = parseMarketValues(load('fc2026.json'));
const market = { byId: marketBy, ranks: marketRanks(marketBy) };

const cfg = normalizeLeague({
    settings: { num_teams: 12, playoff_teams: 6, playoff_week_start: 15, type: 0 },
    scoring_settings: SCORINGS[scoringKey] || SCORINGS.half,
    roster_positions: defaultRosterPositions(),
});
const scoring = cfg.scoring;

// Every week we have both a projection and a result for.
const weeks = [];
for (let w = 1; w <= 18; w++) {
    if (existsSync(`${DIR}/wk${w}.json`) && existsSync(`${DIR}/wkproj${w}.json`)) weeks.push(w);
}
if (!weeks.length) {
    console.error('no weekly files found.');
    process.exit(2);
}

const actualRows = new Map();
const projRows = new Map();
for (const w of weeks) {
    actualRows.set(w, load(`wk${w}.json`));
    projRows.set(w, load(`wkproj${w}.json`));
}

/** Weekly stats keyed by player, for the weeks strictly before `week`. */
const statsBefore = (week) => {
    const out = new Map();
    for (const w of weeks) {
        if (w >= week) continue;
        out.set(w, actualRows.get(w));
    }
    return out;
};

/** Season-to-date actuals in the shape the app's own blend expects. */
const seasonActualsBefore = (week) => {
    const rows = new Map();
    for (const w of weeks) {
        if (w >= week) continue;
        for (const row of actualRows.get(w)) {
            if (!row?.stats?.gp) continue;
            const id = String(row.player_id);
            let acc = rows.get(id);
            if (!acc) { acc = { player_id: id, player: row.player, stats: {} }; rows.set(id, acc); }
            for (const [k, v] of Object.entries(row.stats)) {
                if (typeof v === 'number') acc.stats[k] = (acc.stats[k] || 0) + v;
            }
        }
    }
    return normalizeProjections([...rows.values()], { kind: 'actual' });
};

const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const byId = (rows) => {
    const m = new Map();
    for (const r of rows || []) {
        if (r?.player_id === undefined || r?.player_id === null) continue;
        m.set(String(r.player_id), r);
    }
    return m;
};

// --- Build one case per (player, week) -------------------------------------
//
// A case is only usable when the player was projected AND played: a projection
// for somebody who was inactive measures roster news, not the model, and
// mixing the two makes every error figure look worse than the model is.
const cases = [];
for (const week of weeks) {
    if (onlyWeek && week !== onlyWeek) continue;

    const projIdx = byId(projRows.get(week));
    const actIdx = byId(actualRows.get(week));
    const prior = statsBefore(week);
    const defenses = buildDefenseProfiles(prior, scoring);
    const seasonActuals = seasonActualsBefore(week);
    // The app's own board for that week, built knowing only what had happened.
    const ctx = createValuationContext(cfg, {
        week,
        weeksLeft: Math.max(1, 15 - week),
        projections: seasonProjections,
        actuals: Object.keys(seasonActuals).length ? seasonActuals : null,
        market,
    });

    for (const [id, projRow] of projIdx) {
        const p = players[id];
        if (!p || !POS.includes(p.pos)) continue;
        const actRow = actIdx.get(id);
        if (!actRow?.stats?.gp) continue;

        const base = scoreStats(projRow.stats || {}, scoring);
        if (!Number.isFinite(base)) continue;
        const real = scoreStats(actRow.stats, scoring);

        // How many games he had behind him going into this week.
        let games = 0;
        for (const [, rows] of prior) {
            for (const r of rows) {
                if (String(r.player_id) === id && r?.stats?.gp) games += 1;
            }
        }

        // The matchup multiplier, which IS reconstructible: it is computed
        // from the defensive box scores of the weeks before this one.
        const opponent = projRow.opponent || actRow.opponent || null;
        const mi = matchupImpact(defenses, opponent, p.pos);

        // The season-level blend, as the board uses it.
        const seasonBlend = blendedPpg({
            projection: seasonProjections[id] || null,
            actual: seasonActuals[id] || null,
            scoring,
            week,
        });
        const augustPpg = projectedPpg(seasonProjections[id] || null, scoring);
        const mRank = market.ranks.get(id) ?? null;
        const marketPpg = mRank ? ctx.ppgAtRank(p.pos, mRank) : null;

        cases.push({
            id, week, pos: p.pos, name: p.name, games, real, base,
            matchupMult: mi.known ? mi.multiplier : 1,
            matchupKnown: mi.known,
            seasonBlend: Number.isFinite(seasonBlend) ? seasonBlend : null,
            augustPpg: Number.isFinite(augustPpg) ? augustPpg : null,
            marketPpg: Number.isFinite(marketPpg) ? marketPpg : null,
        });
    }
}

if (!cases.length) {
    console.error('no scoreable cases.');
    process.exit(2);
}

// --- Error measures --------------------------------------------------------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const stats = (sel, predict) => {
    const rows = sel.map((c) => ({ p: predict(c), r: c.real })).filter((x) => Number.isFinite(x.p));
    if (!rows.length) return null;
    const errs = rows.map((x) => x.p - x.r);
    const mae = mean(errs.map(Math.abs));
    const bias = mean(errs);
    const rmse = Math.sqrt(mean(errs.map((e) => e * e)));
    // The standard error on the bias, because a bias inside two of these is
    // noise and correcting it would be fitting this sample rather than the
    // game. This is the difference between learning something and inventing
    // something.
    const sd = Math.sqrt(mean(errs.map((e) => (e - bias) ** 2)));
    const se = sd / Math.sqrt(rows.length);
    return { n: rows.length, mae, bias, rmse, se, z: se > 0 ? bias / se : 0 };
};
/** Is a measured bias big enough to act on? */
const real = (s) => Math.abs(s.z) >= 2;

/**
 * Two estimators on the SAME cases, compared pair by pair.
 *
 * Comparing two independent MAEs throws away the fact that both predictions
 * are about the same player in the same week, which is most of what is known.
 * The paired difference in absolute error has a far smaller standard error, so
 * it can detect a real improvement that an unpaired comparison would call a
 * tie -- and, more often around here, call a tie what an unpaired comparison
 * would have called an improvement.
 */
const paired = (sel, a, b) => {
    const diffs = [];
    for (const c of sel) {
        const pa = a(c);
        const pb = b(c);
        if (!Number.isFinite(pa) || !Number.isFinite(pb)) continue;
        diffs.push(Math.abs(pb - c.real) - Math.abs(pa - c.real));
    }
    if (diffs.length < 2) return null;
    const m = mean(diffs);
    const sd = Math.sqrt(mean(diffs.map((d) => (d - m) ** 2)));
    const se = sd / Math.sqrt(diffs.length);
    return { n: diffs.length, gain: m, se, z: se > 0 ? m / se : 0 };
};
/** How to phrase a paired result honestly. */
const verdictOf = (pr, baseMae) => {
    if (!pr) return 'not enough cases';
    const share = baseMae > 0 ? (100 * pr.gain) / baseMae : 0;
    if (Math.abs(pr.z) < 2) return `no effect (${share >= 0 ? '+' : ''}${share.toFixed(1)}%, z ${pr.z.toFixed(1)})`;
    return pr.gain > 0
        ? `HELPS ${share.toFixed(1)}% (z ${pr.z.toFixed(1)})`
        : `HURTS ${Math.abs(share).toFixed(1)}% (z ${pr.z.toFixed(1)})`;
};
const pct = (a, b) => `${a >= b ? '+' : ''}${(100 * (a - b) / b).toFixed(1)}%`;

console.log(`\n${'='.repeat(78)}`);
console.log(`WEEKLY PREDICTION ACCURACY — ${season}, ${scoringKey} PPR, weeks ${weeks.join(',')}`);
console.log(`${cases.length} player-weeks where we projected him and he played.`);
console.log(`${'='.repeat(78)}`);

// --- 1. The baseline we are trying to beat ---------------------------------
console.log(`\n1. THE WEEKLY PROJECTION, AS SHIPPED`);
console.log(`   Sleeper's weekly number scored under this league's rules. Every`);
console.log(`   adjustment in the app multiplies this, so it is the thing to beat.\n`);
const baseAll = stats(cases, (c) => c.base);
console.log(`   ${'pos'.padEnd(5)} ${'n'.padStart(5)} ${'MAE'.padStart(7)} ${'bias'.padStart(8)} ${'+/-'.padStart(6)} ${'z'.padStart(6)}   reading`);
for (const pos of [...POS, 'ALL']) {
    const sel = pos === 'ALL' ? cases : cases.filter((c) => c.pos === pos);
    const s = stats(sel, (c) => c.base);
    if (!s) continue;
    const reading = !real(s)
        ? 'inside the noise'
        : s.bias > 0 ? `projects ${s.bias.toFixed(2)} too HIGH` : `projects ${Math.abs(s.bias).toFixed(2)} too LOW`;
    console.log(
        `   ${pos.padEnd(5)} ${String(s.n).padStart(5)} ${s.mae.toFixed(2).padStart(7)} ` +
        `${((s.bias >= 0 ? '+' : '') + s.bias.toFixed(2)).padStart(8)} ` +
        `${s.se.toFixed(2).padStart(6)} ${s.z.toFixed(1).padStart(6)}   ${reading}`
    );
}
console.log(`\n   z is the bias in standard errors. Anything inside +/-2 is this`);
console.log(`   sample talking, not the model, and correcting it would be fitting noise.`);

// --- 2. Does the matchup adjustment help? ----------------------------------
console.log(`\n2. THE DEFENSIVE MATCHUP MULTIPLIER`);
console.log(`   Applied to every projection the app shows. Reconstructible, so`);
console.log(`   measurable: does multiplying by it beat leaving it alone?\n`);
const known = cases.filter((c) => c.matchupKnown);
console.log(`   ${'pos'.padEnd(5)} ${'n'.padStart(5)} ${'MAE off'.padStart(9)} ${'MAE on'.padStart(9)}   verdict (paired)`);
for (const pos of [...POS, 'ALL']) {
    const sel = (pos === 'ALL' ? known : known.filter((c) => c.pos === pos));
    if (sel.length < 25) continue;
    const off = stats(sel, (c) => c.base);
    const on = stats(sel, (c) => c.base * c.matchupMult);
    const pr = paired(sel, (c) => c.base * c.matchupMult, (c) => c.base);
    console.log(
        `   ${pos.padEnd(5)} ${String(sel.length).padStart(5)} ${off.mae.toFixed(3).padStart(9)} ` +
        `${on.mae.toFixed(3).padStart(9)}   ${verdictOf(pr, off.mae)}`
    );
}
// And how hard it is actually pushing, because an adjustment that never moves
// a number cannot help or hurt and should not be in the pipeline at all.
const mults = known.map((c) => c.matchupMult).sort((a, b) => a - b);
console.log(
    `\n   the multiplier itself: median ${mults[Math.floor(mults.length / 2)].toFixed(3)}, ` +
    `5th ${mults[Math.floor(mults.length * 0.05)].toFixed(3)}, 95th ${mults[Math.floor(mults.length * 0.95)].toFixed(3)}`
);

// --- 3. Is the projection even the best weekly estimate? -------------------
console.log(`\n3. WHAT ELSE COULD PREDICT THIS WEEK`);
console.log(`   The weekly projection against the season-level numbers the app`);
console.log(`   already computes. Scored on the same cases, so it is like for like.\n`);
const settled = cases.filter((c) => c.games >= 2 && c.seasonBlend !== null && c.marketPpg !== null);
const candidates = [
    ['the weekly projection (shipped)', (c) => c.base],
    ['the season blend, per game', (c) => c.seasonBlend],
    ['the August projection, per game', (c) => c.augustPpg],
    ['the market, through our curve', (c) => c.marketPpg],
    ['weekly and season, half each', (c) => 0.5 * c.base + 0.5 * c.seasonBlend],
    [`weekly and market at ${MARKET_WEIGHT}`, (c) => (1 - MARKET_WEIGHT) * c.base + MARKET_WEIGHT * c.marketPpg],
];
const ref = stats(settled, (c) => c.base);
console.log(`   ${'estimator'.padEnd(32)} ${'n'.padStart(5)} ${'MAE'.padStart(7)} ${'bias'.padStart(7)}  vs shipped (paired)`);
for (const [label, fn] of candidates) {
    const st = stats(settled, fn);
    if (!st) continue;
    const pr = label.includes('shipped') ? null : paired(settled, fn, (c) => c.base);
    console.log(
        `   ${label.padEnd(32)} ${String(st.n).padStart(5)} ${st.mae.toFixed(3).padStart(7)} ` +
        `${((st.bias >= 0 ? '+' : '') + st.bias.toFixed(2)).padStart(8)}  ` +
        `${pr ? verdictOf(pr, ref.mae) : '--'}`
    );
}

// --- 4. Where the error actually lives -------------------------------------
console.log(`\n4. WHERE THE ERROR LIVES`);
console.log(`   Same estimator, sliced by the things we could condition on.\n`);

const buckets = [
    ['projected tier', (c) => (c.base >= 15 ? 'projected 15+' : c.base >= 10 ? 'projected 10-15' : c.base >= 5 ? 'projected 5-10' : 'projected under 5')],
    ['games of history', (c) => (c.games === 0 ? 'no games yet' : c.games <= 2 ? '1-2 games' : `${c.games} games`)],
    ['week', (c) => `week ${c.week}`],
];
for (const [label, keyOf] of buckets) {
    console.log(`   by ${label}:`);
    const groups = new Map();
    for (const c of cases) {
        const k = keyOf(c);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
    }
    const keys = [...groups.keys()].sort();
    for (const k of keys) {
        const sel = groups.get(k);
        if (sel.length < 20) continue;
        const s = stats(sel, (c) => c.base);
        // Error as a share of the level being predicted, which is the only way
        // to compare a quarterback bucket with a kicker bucket.
        const level = mean(sel.map((c) => c.real));
        console.log(
            `     ${k.padEnd(20)} ${String(s.n).padStart(5)}  MAE ${s.mae.toFixed(2).padStart(6)}  ` +
            `bias ${((s.bias >= 0 ? '+' : '') + s.bias.toFixed(2)).padStart(6)}  ` +
            `MAE/level ${(level > 0 ? s.mae / level : NaN).toFixed(2)}`
        );
    }
    console.log('');
}

// --- 5. Regression to the mean --------------------------------------------
console.log(`5. DO WE CHASE LAST WEEK?`);
console.log(`   Split by how a player did in the week BEFORE the one predicted.`);
console.log(`   A projection that over-reacts to one big game shows up as a`);
console.log(`   negative bias after a boom and a positive one after a bust.\n`);
const prevWeekPoints = new Map();
for (const week of weeks) {
    const idx = byId(actualRows.get(week));
    for (const [id, row] of idx) {
        if (!row?.stats?.gp) continue;
        prevWeekPoints.set(`${id}:${week}`, scoreStats(row.stats, scoring));
    }
}
const withPrev = cases
    .map((c) => ({ ...c, prev: prevWeekPoints.get(`${c.id}:${c.week - 1}`) ?? null }))
    .filter((c) => c.prev !== null && c.base >= 5);
const relative = withPrev.map((c) => ({ ...c, edge: c.prev - c.base }));
const sortedEdge = [...relative].sort((a, b) => a.edge - b.edge);
const third = Math.floor(sortedEdge.length / 3);
for (const [label, sel] of [
    ['busted last week', sortedEdge.slice(0, third)],
    ['about as projected', sortedEdge.slice(third, 2 * third)],
    ['boomed last week', sortedEdge.slice(2 * third)],
]) {
    const s = stats(sel, (c) => c.base);
    if (!s) continue;
    console.log(
        `   ${label.padEnd(22)} ${String(s.n).padStart(5)}  MAE ${s.mae.toFixed(2).padStart(6)}  ` +
        `bias ${((s.bias >= 0 ? '+' : '') + s.bias.toFixed(2)).padStart(6)}`
    );
}

// --- 6. The blend weight, refit on everything we now have -----------------
console.log(`\n6. THE SEASON BLEND WEIGHT`);
console.log(`   actualsWeight caps at 0.65 and reaches g/(g+5). Swept here`);
console.log(`   against what actually happened, on players with a real sample.\n`);
const blendable = cases.filter((c) => c.games >= 2 && c.augustPpg !== null);
const perGameActual = new Map();
{
    // Season-to-date per-game average going into each week.
    for (const week of weeks) {
        const acc = new Map();
        for (const w of weeks) {
            if (w >= week) continue;
            for (const row of actualRows.get(w)) {
                if (!row?.stats?.gp) continue;
                const id = String(row.player_id);
                const a = acc.get(id) || { pts: 0, g: 0 };
                a.pts += scoreStats(row.stats, scoring); a.g += 1;
                acc.set(id, a);
            }
        }
        for (const [id, a] of acc) perGameActual.set(`${id}:${week}`, a.pts / a.g);
    }
}
console.log(`   ${'weight on results'.padEnd(22)} ${'MAE'.padStart(8)}  vs shipped`);
const shippedBlend = stats(blendable, (c) => {
    const seasonPpg = perGameActual.get(`${c.id}:${c.week}`);
    if (!Number.isFinite(seasonPpg)) return NaN;
    const w = actualsWeight(c.games);
    return c.augustPpg * (1 - w) + seasonPpg * w;
});
for (const cap of [0, 0.2, 0.4, 0.5, 0.65, 0.8, 1.0]) {
    const s = stats(blendable, (c) => {
        const seasonPpg = perGameActual.get(`${c.id}:${c.week}`);
        if (!Number.isFinite(seasonPpg)) return NaN;
        const w = Math.min(cap, c.games / (c.games + 5));
        return c.augustPpg * (1 - w) + seasonPpg * w;
    });
    if (!s) continue;
    const tag = Math.abs(cap - 0.65) < 1e-9 ? '  <- shipped cap' : '';
    console.log(
        `   cap ${String(cap).padEnd(18)} ${s.mae.toFixed(3).padStart(8)}  ${pct(s.mae, shippedBlend.mae).padStart(8)}${tag}`
    );
}

console.log(`\n${'='.repeat(78)}`);
console.log(`NOT MEASURED HERE, because the inputs are gone once the week ends:`);
console.log(`  the Vegas multiplier, the game-script table, the line-movement nudge,`);
console.log(`  the weather discount, the injury discount and the player-prop blend.`);
console.log(`  All six multiply every number the app shows. tools/predlog.mjs records`);
console.log(`  them as predictions are made so that next time this report covers them.`);
console.log(`${'='.repeat(78)}\n`);
