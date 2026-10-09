// Persistent app state.
//
// Everything lives in localStorage: the user's rankings are the product here,
// and they should survive a refresh without an account, a server or a login.

const KEY = 'ffc:state:v1';
// v2 adds espnId. Every cached database from v1 lacks it, and a player
// without it silently has no betting market, so the cache has to be rebuilt
// rather than merged.
const PLAYERS_KEY = 'ffc:players:v2';
const SNAPSHOT_KEY = 'ffc:power-snapshots:v1';
const PROJECTIONS_KEY = 'ffc:projections:v1';
const BYES_KEY = 'ffc:byes:v1';
const OUTLOOK_KEY = 'ffc:outlook:v1';
const ATHLETES_KEY = 'ffc:espn-athletes:v1';

const DEFAULTS = {
    username: '',
    userId: null,
    leagueId: null,
    season: null,
    settings: {
        simIterations: 2000,
        autoRefreshLive: true,
        powerPreset: 'balanced',
    },
    updatedAt: null,
};

function read(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function write(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (err) {
        // Quota is the realistic failure: the player database is the only large
        // payload, and it is disposable.
        console.warn('Could not persist to localStorage', err);
        return false;
    }
}

/**
 * Whether this browser will actually keep anything.
 *
 * Safari in private mode, and any browser with site data blocked, makes
 * localStorage throw rather than fail quietly. Every read and write here is
 * guarded, so the app runs perfectly well in that state -- it simply forgets
 * everything the moment the tab closes.
 *
 * Silently forgetting is worse than not working. The rankings are the product;
 * somebody who spends twenty minutes ordering their board deserves to know
 * before they lose it, not after. Probed once with a real round trip, because
 * the presence of the API says nothing about whether writing to it succeeds.
 */
function probePersistence() {
    try {
        const probe = '__ffc_probe__';
        localStorage.setItem(probe, '1');
        const ok = localStorage.getItem(probe) === '1';
        localStorage.removeItem(probe);
        return ok;
    } catch {
        return false;
    }
}

export const persists = probePersistence();

export const state = { ...DEFAULTS, ...read(KEY, {}) };
state.settings = { ...DEFAULTS.settings, ...(state.settings || {}) };
dropLegacyOrder();

export function save() {
    state.updatedAt = new Date().toISOString();
    write(KEY, state);
}

export function update(patch) {
    Object.assign(state, patch);
    save();
}

/**
 * Drop a hand-sorted ordering left behind by an older version.
 *
 * The board used to be draggable, and saving an edit persisted the WHOLE
 * ordering -- so one drag froze every ranked player at that moment and the
 * merge on each later load kept it that way. Anyone who used it has a stale
 * board sitting in their browser right now, and it would simply be ignored,
 * which wastes their quota and leaves a confusing artefact behind. Cleared
 * once, on load, rather than migrated: there is nothing to migrate it into.
 */
function dropLegacyOrder() {
    if (!state.order) return;
    delete state.order;
    save();
}

// --- Player database cache -------------------------------------------------

export function loadCachedPlayers(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cached = read(PLAYERS_KEY, null);
    if (!cached || !cached.at || !cached.players) return null;
    if (Date.now() - cached.at > maxAgeMs) return { players: cached.players, stale: true, at: cached.at };
    return { players: cached.players, stale: false, at: cached.at };
}

export function cachePlayers(players) {
    return write(PLAYERS_KEY, { at: Date.now(), players });
}

/**
 * Projections change as news breaks, so they get a much shorter shelf life than
 * the player database: six hours, versus a day.
 */
export function loadCachedProjections(season, maxAgeMs = 6 * 60 * 60 * 1000, week = null) {
    const cached = read(PROJECTIONS_KEY, null);
    if (!cached || cached.season !== String(season) || !cached.projections) return null;
    // A new NFL week is a new set of facts, so it invalidates outright rather
    // than waiting out a timer. Somebody who opens the app on Tuesday should
    // not be shown Sunday's numbers because the clock has six hours left on
    // them.
    if (week !== null && cached.week != null && Number(cached.week) !== Number(week)) return null;
    return { projections: cached.projections, stale: Date.now() - cached.at > maxAgeMs, at: cached.at };
}

export function cacheProjections(season, projections, week = null) {
    return write(PROJECTIONS_KEY, { at: Date.now(), season: String(season), week, projections });
}

/**
 * Bye weeks never change once a season's schedule is published, so they are
 * cached for the season with no expiry. Refetching them meant eleven ESPN
 * requests -- about 2.4MB -- on every league sync, including the silent
 * re-syncs the trade poller triggers.
 */
export function loadCachedByes(season) {
    const cached = read(BYES_KEY, null);
    if (!cached || cached.season !== String(season) || !cached.byes) return null;
    return new Map(Object.entries(cached.byes));
}

export function cacheByes(season, byeMap) {
    return write(BYES_KEY, { at: Date.now(), season: String(season), byes: Object.fromEntries(byeMap) });
}

// --- Season outlook --------------------------------------------------------
//
// Byes plus every posted line for the rest of the season, from the same one
// pass. Lines do move, so this expires -- but not weekly: an eleven-week
// average of implied totals barely notices a half-point drift in one game, and
// re-scanning the season on every visit to spot that would be absurd.
const OUTLOOK_TTL = 3 * 24 * 60 * 60 * 1000;

export function loadCachedOutlook(season) {
    const cached = read(OUTLOOK_KEY, null);
    if (!cached || cached.season !== String(season)) return null;
    if (Date.now() - (cached.at || 0) > OUTLOOK_TTL) return null;
    return {
        byes: new Map(Object.entries(cached.byes || {})),
        schedule: new Map(
            Object.entries(cached.schedule || {}).map(([week, games]) => [
                Number(week),
                new Map(Object.entries(games)),
            ])
        ),
    };
}

export function cacheOutlook(season, { byes, schedule }) {
    return write(OUTLOOK_KEY, {
        at: Date.now(),
        season: String(season),
        byes: Object.fromEntries(byes),
        schedule: Object.fromEntries(
            [...(schedule || new Map())].map(([week, games]) => [week, Object.fromEntries(games)])
        ),
    });
}

// --- Market values ---------------------------------------------------------
//
// What players cost in real leagues, keyed by league SHAPE rather than by
// league id: the same twelve-team half-PPR redraft numbers serve every such
// league, and a superflex snapshot must never be handed to a one-quarterback
// one. Values move on a scale of days, so this is cached hard -- a fresh fetch
// on every visit would be a lot of traffic to learn nothing.
// v2 holds SEVERAL shapes at once rather than one.
//
// The vacuum calculator lets a format be chosen -- superflex, TE premium, PPR,
// team count -- and each of those is a different market. With a single slot,
// flipping superflex on and off refetched the whole board every time, because
// each shape evicted the other. Keyed by shape, with a small cap: a handful of
// shapes is all anyone compares, and the payload is a few hundred kilobytes.
const MARKET_KEY = 'ffc:market:v2';
const MARKET_TTL = 12 * 60 * 60 * 1000;
const MARKET_SHAPES = 6;

export function loadCachedMarket(key) {
    const all = read(MARKET_KEY, null);
    const cached = all?.shapes?.[key];
    if (!cached) return null;
    if (Date.now() - (cached.at || 0) > MARKET_TTL) return null;
    const byId = new Map(Object.entries(cached.byId || {}));
    if (!byId.size) return null;
    return { key, at: cached.at, byId, ranks: new Map(Object.entries(cached.ranks || {})) };
}

export function cacheMarket(key, snapshot) {
    const all = read(MARKET_KEY, null) || { shapes: {} };
    const shapes = { ...(all.shapes || {}) };
    shapes[key] = {
        at: snapshot.at || Date.now(),
        byId: Object.fromEntries(snapshot.byId),
        ranks: Object.fromEntries(snapshot.ranks),
    };

    // Oldest shapes out first once over the cap, so the one just fetched and
    // the one being compared against both survive.
    const keys = Object.keys(shapes);
    if (keys.length > MARKET_SHAPES) {
        const byAge = keys.sort((x, y) => (shapes[x].at || 0) - (shapes[y].at || 0));
        for (const stale of byAge.slice(0, keys.length - MARKET_SHAPES)) delete shapes[stale];
    }
    return write(MARKET_KEY, { shapes });
}

// --- Power ranking history -------------------------------------------------

/** Keeps the last 20 weekly snapshots so the board can show movement arrows. */
export function saveSnapshot(leagueId, week, ranking, preset = 'balanced') {
    const all = read(SNAPSHOT_KEY, {});
    const forLeague = all[leagueId] || [];
    const existing = forLeague.findIndex((s) => s.week === week && (s.preset ?? 'balanced') === preset);
    const entry = { week, at: Date.now(), preset, ranking };
    // Snapshots are per (week, preset): overwriting one preset's history with
    // another's made movement arrows compare against a different ranking
    // system, which is worse than showing nothing.
    if (existing >= 0) forLeague[existing] = entry;
    else forLeague.push(entry);
    forLeague.sort((a, b) => a.week - b.week);
    all[leagueId] = forLeague.slice(-60);
    write(SNAPSHOT_KEY, all);
}

export function getSnapshots(leagueId) {
    return read(SNAPSHOT_KEY, {})[leagueId] || [];
}

/** The most recent snapshot from a week before `week`, for movement arrows. */
export function previousSnapshot(leagueId, week, preset = 'balanced') {
    const snaps = getSnapshots(leagueId)
        .filter((s) => s.week < week && (s.preset ?? 'balanced') === preset)
        .sort((a, b) => a.week - b.week);
    return snaps.length ? snaps[snaps.length - 1] : null;
}


// --- ESPN athlete names ----------------------------------------------------
//
// Sleeper carries `espn_id` for only about a quarter of currently rostered
// skill players, so matching a betting market to a fantasy roster needs a name
// for the rest -- one small request per athlete. A name does not change, so
// every lookup is remembered forever and the cost decays to nothing after the
// first week or two of a season.

let athleteCache = null;
const athletes = () => (athleteCache ||= read(ATHLETES_KEY, {}));

export const getAthleteName = (espnId) => athletes()[String(espnId)]?.name ?? null;
export const getAthletePos = (espnId) => athletes()[String(espnId)]?.pos ?? null;

export function setAthlete(espnId, { name, pos }) {
    if (!espnId || !name) return;
    const all = athletes();
    all[String(espnId)] = { name, pos: pos || null };
    write(ATHLETES_KEY, all);
}
