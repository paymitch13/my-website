// Sleeper read-only API client.
//
// Sleeper's v1 API needs no key and sends permissive CORS headers, so the whole
// app can run from static hosting. The only endpoint that is genuinely heavy is
// /players/nfl (about 14MB), which Sleeper asks callers to hit at most once a day --
// we trim it to fantasy-relevant fields and cache the result.

const BASE = 'https://api.sleeper.app/v1';

const MEM = new Map();

export class SleeperError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'SleeperError';
        this.status = status;
    }
}

async function get(path, { ttl = 5 * 60 * 1000, force = false } = {}) {
    const key = `sleeper:${path}`;
    const hit = MEM.get(key);
    // `force` exists so a user pressing Refresh always hits the network. A
    // cache TTL longer than the caller's refresh interval turns the button
    // into a no-op, which is worse than no button.
    if (!force && hit && Date.now() - hit.at < ttl) return hit.data;

    let res;
    try {
        res = await fetch(`${BASE}${path}`);
    } catch (cause) {
        throw new SleeperError(`Could not reach Sleeper. Check your connection and try again.`, 0);
    }
    if (res.status === 404) throw new SleeperError(`Not found on Sleeper: ${path}`, 404);
    if (res.status === 429) throw new SleeperError('Sleeper is rate-limiting us. Wait a minute and retry.', 429);
    if (!res.ok) throw new SleeperError(`Sleeper returned ${res.status} for ${path}`, res.status);

    const data = await res.json();
    MEM.set(key, { at: Date.now(), data });
    return data;
}

/** Current NFL week/season/phase. Cheap and changes often during the season. */
export const getState = () => get('/state/nfl', { ttl: 60 * 1000 });

export const getUser = (username) => get(`/user/${encodeURIComponent(username)}`, { ttl: 60 * 60 * 1000 });

export const getLeaguesForUser = (userId, season) =>
    get(`/user/${userId}/leagues/nfl/${season}`, { ttl: 10 * 60 * 1000 });

export const getLeague = (leagueId) => get(`/league/${leagueId}`, { ttl: 10 * 60 * 1000 });

export const getRosters = (leagueId) => get(`/league/${leagueId}/rosters`, { ttl: 2 * 60 * 1000 });

export const getLeagueUsers = (leagueId) => get(`/league/${leagueId}/users`, { ttl: 10 * 60 * 1000 });

/** Live during games -- short TTL so the scoreboard actually moves. */
export const getMatchups = (leagueId, week, { force = false } = {}) =>
    get(`/league/${leagueId}/matchups/${week}`, { ttl: 30 * 1000, force });

// Shorter than the trade poll interval, or two of every three polls would be
// no-ops and detection would lag by up to the TTL rather than the interval.
export const getTransactions = (leagueId, week, { force = false } = {}) =>
    get(`/league/${leagueId}/transactions/${week}`, { ttl: 60 * 1000, force });


/** Waiver-wire buzz. `type` is 'add' or 'drop'. */
export const getTrending = (type = 'add', hours = 24, limit = 40) =>
    get(`/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`, { ttl: 10 * 60 * 1000 });

const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

/**
 * Trim Sleeper's player dump to the fields the app actually uses. The raw
 * payload is about 14MB of mostly-empty metadata; this lands around 300KB, which
 * fits comfortably in localStorage.
 */
export function trimPlayers(raw) {
    const out = {};
    for (const [id, p] of Object.entries(raw)) {
        const pos = p.position || (p.fantasy_positions && p.fantasy_positions[0]);
        if (!pos || !FANTASY_POSITIONS.has(pos)) continue;
        // Retired / practice-squad-only bodies just add noise to the rankings board.
        if (p.status === 'Inactive' && !p.team) continue;
        out[id] = {
            id,
            name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || id,
            pos,
            team: p.team || 'FA',
            age: p.age ?? null,
            exp: p.years_exp ?? null,
            number: p.number ?? null,
            // search_rank is Sleeper's own popularity/ADP-ish ordering. We use it
            // only to seed a starting ranking board that the user then overrides.
            searchRank: p.search_rank ?? 99999,
            injury: p.injury_status || null,
            injuryBody: p.injury_body_part || null,
            practice: p.practice_participation || null,
            depth: p.depth_chart_order ?? null,
        };
    }
    return out;
}

export async function fetchPlayers() {
    const res = await fetch(`${BASE}/players/nfl`);
    if (!res.ok) throw new SleeperError(`Player database fetch failed (${res.status})`, res.status);
    return trimPlayers(await res.json());
}


export const headshotUrl = (playerId, pos, team) =>
    pos === 'DEF'
        ? `https://sleepercdn.com/images/team_logos/nfl/${String(team || '').toLowerCase()}.png`
        : `https://sleepercdn.com/content/nfl/players/thumb/${playerId}.jpg`;

