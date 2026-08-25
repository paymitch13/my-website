// The betting market as a second projection.
//
// Every projection in this app comes from one source: Sleeper's. That is a
// consensus number produced by people with an opinion. A player prop is a
// number produced by people with money at risk, and when the two disagree the
// disagreement is the most actionable single line a start/sit tool can print.
//
// ESPN's core API carries all of it, CORS-open and keyless:
//
//   .../events/{id}/competitions/{id}/odds              total & spread juice
//   .../events/{id}/competitions/{id}/odds/100/propBets player props
//   .../events/{id}/competitions/{id}/predictor         ESPN's own model
//
// The scoreboard endpoint the app already reads gives the total and the spread
// but NOT the juice on them, and a total posted at -120/+100 is not the total
// it appears to be. Implied team totals are the single input the whole Start/Sit
// engine hangs on, so half a point of free precision is worth taking.

import { americanToProbability, devig } from './odds.js';
import { politeFetch } from './net.js';
import { scoreStats } from './projections.js';
import { mean } from './util.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';

/**
 * Prop market -> Sleeper stat key.
 *
 * Sleeper's projections and a league's scoring_settings use the same keys, so
 * a market line expressed in these keys can be scored by the league's own rules
 * with no special casing -- the same dot product that prices a projection.
 *
 * Names are matched loosely because ESPN decorates them ("Total Rushing Yards
 * (incl. overtime)") and has changed the decoration before.
 */
const PROP_STATS = [
    [/passing\s+yards/i, 'pass_yd'],
    [/passing\s+touchdowns/i, 'pass_td'],
    [/passing\s+attempts/i, 'pass_att'],
    [/interceptions\s+thrown|passing\s+interceptions/i, 'pass_int'],
    [/rushing\s+yards/i, 'rush_yd'],
    [/rushing\s+touchdowns/i, 'rush_td'],
    [/rushing\s+attempts|carries/i, 'rush_att'],
    [/receiving\s+yards/i, 'rec_yd'],
    [/receiving\s+touchdowns/i, 'rec_td'],
    [/receptions/i, 'rec'],
];

/** Which Sleeper stat key a prop market name describes, if any. */
export function statKeyFor(name) {
    if (!name) return null;
    for (const [re, key] of PROP_STATS) if (re.test(name)) return key;
    return null;
}

/** The athlete id out of a $ref, without fetching it. */
export function athleteIdFrom(ref) {
    const m = /\/athletes\/(\d+)/.exec(String(ref || ''));
    return m ? m[1] : null;
}

/**
 * Player props, grouped by athlete.
 *
 * Preseason payloads carry only game-level markets (halves, quarters, team
 * totals) and no athlete at all, so an empty result here is normal and not an
 * error -- the caller degrades to the projection it already had.
 */
export function parseProps(payload) {
    const byAthlete = new Map();

    for (const item of payload?.items || []) {
        const athleteId = athleteIdFrom(item?.athlete?.$ref);
        if (!athleteId) continue;

        const key = statKeyFor(item?.type?.name);
        if (!key) continue;

        const current = item?.current?.target?.value;
        if (!Number.isFinite(current)) continue;
        const open = item?.open?.target?.value;

        if (!byAthlete.has(athleteId)) byAthlete.set(athleteId, { athleteId, stats: {}, movement: {} });
        const row = byAthlete.get(athleteId);
        row.stats[key] = current;
        if (Number.isFinite(open) && open !== current) {
            row.movement[key] = { open, current, change: current - open };
        }
    }

    return byAthlete;
}

/**
 * Fantasy points per game implied by a player's posted markets, under this
 * league's own scoring.
 *
 * Returns null when the markets are too thin to be a projection: a lone
 * receiving-yards line is a fact about receiving yards, not a fantasy
 * projection, and pretending otherwise would systematically under-project
 * everyone whose touchdown market has not been posted.
 */
export function marketPoints(row, scoring, { minMarkets = 2 } = {}) {
    if (!row?.stats) return null;
    const keys = Object.keys(row.stats);
    if (keys.length < minMarkets) return null;
    return scoreStats(row.stats, scoring);
}

/**
 * Where the market and the projection disagree, and by how much.
 *
 * Reported as a share of the projection, because two points of disagreement on
 * a 20-point quarterback and on a 5-point tight end are not the same finding.
 */
export function disagreement(marketPpg, projectedPpg, { threshold = 0.12 } = {}) {
    if (!Number.isFinite(marketPpg) || !Number.isFinite(projectedPpg) || projectedPpg <= 0) return null;
    const diff = marketPpg - projectedPpg;
    const share = diff / projectedPpg;
    if (Math.abs(share) < threshold) return null;
    return {
        market: marketPpg,
        projection: projectedPpg,
        diff,
        share,
        direction: diff > 0 ? 'higher' : 'lower',
        text:
            diff > 0
                ? `Vegas is HIGHER on him than the projection: the posted lines imply ${marketPpg.toFixed(1)} against a projected ${projectedPpg.toFixed(1)}.`
                : `Vegas is LOWER on him than the projection: the posted lines imply ${marketPpg.toFixed(1)} against a projected ${projectedPpg.toFixed(1)}.`,
    };
}

/**
 * One number out of two opinions.
 *
 * The market gets the larger share because it is the sharper of the two -- it
 * is money rather than consensus -- but not the whole weight, because a posted
 * line is only as complete as the markets that happen to exist for that player.
 */
export function blendMarket(marketPpg, projectedPpg, { marketWeight = 0.6 } = {}) {
    if (!Number.isFinite(marketPpg)) return projectedPpg ?? null;
    if (!Number.isFinite(projectedPpg)) return marketPpg;
    const w = Math.max(0, Math.min(1, marketWeight));
    return marketPpg * w + projectedPpg * (1 - w);
}

/**
 * The total and spread with their juice, which the scoreboard does not carry.
 *
 * A total posted at -120 over / +100 under is not a fair 45.5: the market's
 * real expectation sits above the number. De-vigging the pair recovers it, and
 * since implied team totals drive every Start/Sit multiplier the correction is
 * worth more than its size suggests.
 *
 * The provider list is parsed rather than indexed at [0]: ESPN returns one book
 * today and the shape supports more, so a consensus and a book-disagreement
 * measure come for free the moment a second one appears.
 */
export function parseCoreOdds(payload) {
    const items = payload?.items || [];
    if (!items.length) return null;

    const books = [];
    for (const o of items) {
        const overUnder = Number(o?.overUnder);
        const spread = Number(o?.spread);
        const overOdds = o?.overOdds;
        const underOdds = o?.underOdds;

        const fair =
            Number.isFinite(overUnder) && overOdds != null && underOdds != null
                ? devig(overOdds, underOdds)
                : null;

        books.push({
            provider: o?.provider?.name ?? null,
            overUnder: Number.isFinite(overUnder) ? overUnder : null,
            spread: Number.isFinite(spread) ? spread : null,
            overOdds: Number.isFinite(Number(overOdds)) ? Number(overOdds) : null,
            underOdds: Number.isFinite(Number(underOdds)) ? Number(underOdds) : null,
            // Above 0.5 means the market leans over, so the true total sits
            // above the posted number.
            overProbability: fair ? fair.a : null,
            homeMoneyline: o?.homeTeamOdds?.moneyLine ?? null,
            awayMoneyline: o?.awayTeamOdds?.moneyLine ?? null,
            homeSpreadOdds: o?.homeTeamOdds?.spreadOdds ?? null,
            awaySpreadOdds: o?.awayTeamOdds?.spreadOdds ?? null,
            details: o?.details ?? null,
        });
    }

    const priced = books.filter((b) => b.overUnder !== null);
    if (!priced.length) return { books, consensus: null };

    const totals = priced.map((b) => b.overUnder);
    const spreads = books.filter((b) => b.spread !== null).map((b) => b.spread);
    const leans = priced.filter((b) => b.overProbability !== null).map((b) => b.overProbability);

    const posted = mean(totals);
    const lean = leans.length ? mean(leans) : null;

    return {
        books,
        consensus: {
            providers: books.length,
            overUnder: posted,
            spread: spreads.length ? mean(spreads) : null,
            // Half a point per five points of one-sided juice: a -120/+100
            // total leans about 0.55, which nudges the real total up ~0.5.
            fairTotal: lean !== null ? posted + (lean - 0.5) * 10 : posted,
            overLean: lean,
            // Anything above zero means the books disagree, which is itself
            // information the moment there is more than one of them.
            spreadSpread: spreads.length > 1 ? Math.max(...spreads) - Math.min(...spreads) : 0,
            totalSpread: totals.length > 1 ? Math.max(...totals) - Math.min(...totals) : 0,
        },
    };
}

/**
 * ESPN's own win probability, which is a model rather than a market.
 *
 * Its value is precisely that it is independent: when the model and the
 * moneyline disagree by more than a few points that is genuinely interesting,
 * and nothing else in the app can see it. Preseason and far-out games return
 * nulls, which is not an error.
 */
export function parsePredictor(payload, { homeMoneyline = null, awayMoneyline = null } = {}) {
    // Number(null) is 0, which is finite -- an unmodelled game would parse as
    // "the home side has no chance" rather than as no answer at all.
    const raw = payload?.gameProjection;
    if (raw === null || raw === undefined || raw === '') return null;
    const projection = Number(raw);
    if (!Number.isFinite(projection)) return null;

    const modelHomeWin = projection / 100;
    const fair =
        homeMoneyline != null && awayMoneyline != null ? devig(homeMoneyline, awayMoneyline) : null;
    const marketHomeWin = fair ? fair.a : null;

    const gap = marketHomeWin !== null ? modelHomeWin - marketHomeWin : null;
    return {
        modelHomeWin,
        marketHomeWin,
        matchupQuality: Number.isFinite(Number(payload?.matchupQuality)) ? Number(payload.matchupQuality) : null,
        pointDiff: Number.isFinite(Number(payload?.teamPredPtDiff)) ? Number(payload.teamPredPtDiff) : null,
        gap,
        // Five points is roughly where a disagreement stops being noise.
        notable: gap !== null && Math.abs(gap) >= 0.05,
        text:
            gap === null
                ? null
                : `ESPN's model has the home side at ${(modelHomeWin * 100).toFixed(0)}% against a market price of ${(marketHomeWin * 100).toFixed(0)}%.`,
    };
}

// --- Fetching --------------------------------------------------------------

const cache = new Map();

async function getJson(url, { ttl = 15 * 60 * 1000 } = {}) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const res = await politeFetch(url);
    if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
    const value = await res.json();
    cache.set(url, { at: Date.now(), value });
    return value;
}

export const fetchCoreOdds = (eventId) =>
    getJson(`${CORE}/events/${eventId}/competitions/${eventId}/odds`).then(parseCoreOdds);

export const fetchProps = (eventId) =>
    getJson(`${CORE}/events/${eventId}/competitions/${eventId}/odds/100/propBets?limit=200`).then(parseProps);

export const fetchPredictor = (eventId, moneylines) =>
    getJson(`${CORE}/events/${eventId}/competitions/${eventId}/predictor`).then((p) =>
        parsePredictor(p, moneylines)
    );

/**
 * Sleeper player -> ESPN athlete id.
 *
 * Sleeper carries `espn_id` for only about a quarter of currently rostered
 * skill players -- Kyle Pitts and Bucky Irving both lack it -- so an id-only
 * join would silently have no market for most of a roster while appearing to
 * work. Names fill the rest in, normalized hard enough to survive "D.J." vs
 * "DJ" and the suffixes ESPN and Sleeper punctuate differently.
 */
export const normalizeName = (name) =>
    String(name || '')
        .toLowerCase()
        .replace(/[.'`’]/g, '')
        .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
        .replace(/[^a-z ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

/**
 * Index the player database both ways, so a prop can be matched by whichever
 * key it has.
 */
export function buildPlayerIndex(players) {
    const byEspnId = new Map();
    const byName = new Map();
    for (const p of Object.values(players || {})) {
        if (p.espnId) byEspnId.set(String(p.espnId), p);
        const key = `${normalizeName(p.name)}|${p.pos}`;
        // First writer wins; the database is ordered so the active player at a
        // name comes before the retired one of the same name.
        if (!byName.has(key)) byName.set(key, p);
    }
    return { byEspnId, byName };
}

/**
 * Every posted player market on the slate, keyed by Sleeper player id.
 *
 * One request per game -- sixteen a week, ~15KB each, cached alongside the odds
 * -- plus a name lookup for each athlete Sleeper has no ESPN id for, and those
 * are remembered permanently because a player's name does not change.
 *
 * Failures are per-game and swallowed: a slate where one book has not posted is
 * a slate with fewer markets, not a broken Start/Sit tab.
 *
 * @param {Array}  games   parsed scoreboard games, each with an `id`
 * @param {object} players the Sleeper player database
 * @param {object} [opts.store] persistence for resolved athlete names
 */
export async function loadSlateProps(games, players, { store = null, concurrency = 6 } = {}) {
    const index = buildPlayerIndex(players);
    const byPlayerId = new Map();

    const withIds = (games || []).filter((g) => g.id);
    for (let i = 0; i < withIds.length; i += concurrency) {
        const batch = withIds.slice(i, i + concurrency);
        const results = await Promise.all(batch.map((g) => fetchProps(g.id).catch(() => new Map())));

        for (const parsed of results) {
            for (const row of parsed.values()) {
                const player = await resolveAthlete(row.athleteId, index, { store });
                if (player) byPlayerId.set(player.id, { ...row, player });
            }
        }
    }

    return byPlayerId;
}

/** Resolve one athlete id to a Sleeper player, fetching a name only if needed. */
export async function resolveAthlete(athleteId, index, { store = null } = {}) {
    const direct = index.byEspnId.get(String(athleteId));
    if (direct) return direct;

    // Cached name lookups persist: an athlete's name does not change, so this
    // fills in over a week or two and then costs nothing.
    const cached = store?.getAthleteName?.(athleteId);
    let name = cached || null;
    let pos = store?.getAthletePos?.(athleteId) || null;

    if (!name) {
        try {
            const a = await getJson(`${CORE}/athletes/${athleteId}?lang=en&region=us`, { ttl: 30 * 24 * 3600 * 1000 });
            name = a?.displayName || null;
            pos = a?.position?.abbreviation || null;
            if (name) store?.setAthlete?.(athleteId, { name, pos });
        } catch {
            return null;
        }
    }
    if (!name) return null;
    return index.byName.get(`${normalizeName(name)}|${pos}`) || null;
}
