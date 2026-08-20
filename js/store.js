// Persistent app state.
//
// Everything lives in localStorage: the user's rankings are the product here,
// and they should survive a refresh without an account, a server or a login.

const KEY = 'ffc:state:v1';
const PLAYERS_KEY = 'ffc:players:v1';
const SNAPSHOT_KEY = 'ffc:power-snapshots:v1';
const PROJECTIONS_KEY = 'ffc:projections:v1';

const DEFAULTS = {
    username: '',
    userId: null,
    leagueId: null,
    season: null,
    // Positional order the user has arranged. Position -> [playerId].
    order: {},
    // Position -> [{ afterIndex, label }]
    tiers: {},
    settings: {
        showAvatars: true,
        simIterations: 2000,
        autoRefreshLive: true,
    },
    updatedAt: null,
};

const listeners = new Set();

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
    emit();
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    for (const fn of listeners) {
        try {
            fn(state);
        } catch (err) {
            console.error('store listener failed', err);
        }
    }
}

export function update(patch) {
    Object.assign(state, patch);
    save();
}

export function resetRankings() {
    state.order = {};
    state.tiers = {};
    save();
}

export function resetAll() {
    Object.assign(state, structuredClone(DEFAULTS));
    localStorage.removeItem(PLAYERS_KEY);
    localStorage.removeItem(SNAPSHOT_KEY);
    localStorage.removeItem(PROJECTIONS_KEY);
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

// --- Power ranking history -------------------------------------------------

/** Keeps the last 20 weekly snapshots so the board can show movement arrows. */
export function saveSnapshot(leagueId, week, ranking) {
    const all = read(SNAPSHOT_KEY, {});
    const forLeague = all[leagueId] || [];
    const existing = forLeague.findIndex((s) => s.week === week);
    const entry = { week, at: Date.now(), ranking };
    if (existing >= 0) forLeague[existing] = entry;
    else forLeague.push(entry);
    forLeague.sort((a, b) => a.week - b.week);
    all[leagueId] = forLeague.slice(-20);
    write(SNAPSHOT_KEY, all);
}

export function getSnapshots(leagueId) {
    return read(SNAPSHOT_KEY, {})[leagueId] || [];
}

/** The most recent snapshot from a week before `week`, for movement arrows. */
export function previousSnapshot(leagueId, week) {
    const snaps = getSnapshots(leagueId).filter((s) => s.week < week);
    return snaps.length ? snaps[snaps.length - 1] : null;
}
