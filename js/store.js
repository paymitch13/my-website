// Persistent app state.
//
// Everything lives in localStorage: the user's rankings are the product here,
// and they should survive a refresh without an account, a server or a login.

const KEY = 'ffc:state:v1';
const PLAYERS_KEY = 'ffc:players:v1';
const SNAPSHOT_KEY = 'ffc:power-snapshots:v1';
const PROJECTIONS_KEY = 'ffc:projections:v1';
const BYES_KEY = 'ffc:byes:v1';

const DEFAULTS = {
    username: '',
    userId: null,
    leagueId: null,
    season: null,
    // Positional order the user has arranged. Position -> [playerId].
    // Tiers are derived from value gaps rather than stored: there is no manual
    // tiering UI, so a persisted tier map would only ever go stale.
    order: {},
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

export const state = { ...DEFAULTS, ...read(KEY, {}) };
state.settings = { ...DEFAULTS.settings, ...(state.settings || {}) };

export function save() {
    state.updatedAt = new Date().toISOString();
    write(KEY, state);
}

export function update(patch) {
    Object.assign(state, patch);
    save();
}

export function resetRankings() {
    state.order = {};
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
export function loadCachedProjections(season, maxAgeMs = 6 * 60 * 60 * 1000) {
    const cached = read(PROJECTIONS_KEY, null);
    if (!cached || cached.season !== String(season) || !cached.projections) return null;
    return { projections: cached.projections, stale: Date.now() - cached.at > maxAgeMs, at: cached.at };
}

export function cacheProjections(season, projections) {
    return write(PROJECTIONS_KEY, { at: Date.now(), season: String(season), projections });
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
