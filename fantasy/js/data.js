// Data layer: pulls a league off Sleeper and assembles the exact shapes the
// engines expect. Nothing in here does analysis -- it fetches, joins and
// normalizes, so the engine modules stay pure and testable.

import * as api from './sleeper.js';
import { normalizeLeague, weeksRemaining } from './league.js';
import { buildSchedule, syntheticSchedule } from './sim.js';
import { createValuationContext } from './valuation.js';
import * as store from './store.js';
import { mergeOrder, seedOrder, toRankMap } from './rankings.js';

/**
 * The player database is the one heavy fetch. Serve it from cache when it is
 * fresh, refresh it in the background when it is stale but usable, and only
 * block the user on a cold start.
 */
export async function loadPlayers({ force = false, onProgress = () => {} } = {}) {
    if (!force) {
        const cached = store.loadCachedPlayers();
        if (cached && !cached.stale) return { players: cached.players, from: 'cache', at: cached.at };
        if (cached && cached.stale) {
            onProgress('Refreshing player database in the background…');
            refreshPlayersInBackground();
            return { players: cached.players, from: 'stale-cache', at: cached.at };
        }
    }
    onProgress('Downloading the NFL player database (one time, ~5MB)…');
    const players = await api.fetchPlayers();
    store.cachePlayers(players);
    return { players, from: 'network', at: Date.now() };
}

function refreshPlayersInBackground() {
    api.fetchPlayers()
        .then((players) => store.cachePlayers(players))
        .catch((err) => console.warn('Background player refresh failed', err));
}

/** Resolve a Sleeper username to their leagues for a season. */
export async function findLeagues(username, season) {
    const user = await api.getUser(username.trim());
    if (!user || !user.user_id) throw new Error(`No Sleeper user named "${username}".`);
    const leagues = await api.getLeaguesForUser(user.user_id, season);
    return { user, leagues: leagues || [] };
}

/**
 * Load everything needed to analyze one league: settings, rosters, owners,
 * every week played so far, and the remaining schedule.
 */
export async function loadLeague(leagueId, players, { onProgress = () => {} } = {}) {
    onProgress('Loading league settings…');
    const [raw, rosters, users, state] = await Promise.all([
        api.getLeague(leagueId),
        api.getRosters(leagueId),
        api.getLeagueUsers(leagueId),
        api.getState(),
    ]);

    const cfg = normalizeLeague(raw);
    const season = Number(raw.season);
    const stateSeason = Number(state.season);
    const currentWeek = resolveCurrentWeek(state, cfg, season, stateSeason);
    const lastPlayed = Math.max(0, Math.min(currentWeek - 1, cfg.playoffWeekStart - 1));

    onProgress('Loading matchups…');
    const matchupsByWeek = new Map();
    const weeksToFetch = [];
    for (let w = 1; w <= Math.min(cfg.playoffWeekStart - 1, 18); w++) weeksToFetch.push(w);
    const results = await Promise.all(
        weeksToFetch.map((w) => api.getMatchups(leagueId, w).catch(() => null))
    );
    weeksToFetch.forEach((w, i) => {
        if (results[i]) matchupsByWeek.set(w, results[i]);
    });

    const userById = new Map((users || []).map((u) => [u.user_id, u]));
    const teams = (rosters || []).map((r) => {
        const owner = userById.get(r.owner_id);
        const s = r.settings || {};
        return {
            rosterId: r.roster_id,
            ownerId: r.owner_id,
            name:
                owner?.metadata?.team_name?.trim() ||
                owner?.display_name ||
                `Roster ${r.roster_id}`,
            owner: owner?.display_name || 'Unknown',
            avatar: owner?.avatar || null,
            playerIds: r.players || [],
            starterIds: r.starters || [],
            players: (r.players || []).map((id) => players[id]).filter(Boolean),
            wins: s.wins || 0,
            losses: s.losses || 0,
            ties: s.ties || 0,
            pointsFor: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
            pointsAgainst: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
            waiverBudget: s.waiver_budget_used ?? null,
        };
    });

    const weeklyScores = extractWeeklyScores(matchupsByWeek, lastPlayed);
    const schedule = buildRemainingSchedule(cfg, matchupsByWeek, currentWeek, teams);

    return {
        cfg,
        raw,
        teams,
        state,
        currentWeek,
        lastPlayed,
        matchupsByWeek,
        weeklyScores,
        schedule,
        weeksLeft: weeksRemaining(cfg, currentWeek),
    };
}

/**
 * Which fantasy week this league is actually on.
 *
 * Sleeper's global state reports a week within the CURRENT season type, so
 * during the preseason `week: 2` means the second preseason game, not week 2 of
 * fantasy. Reading it literally would tell the app a third of the season had
 * been played before anyone had scored a point.
 */
function resolveCurrentWeek(state, cfg, season, stateSeason) {
    // A past season is finished: value it from the end of the regular season.
    if (season !== stateSeason) return cfg.playoffWeekStart;
    if (state.season_type === 'pre' || state.season_type === 'off') return 1;
    return Math.max(1, state.week || 1);
}

/** rosterId -> [{week, points}] for every completed week. */
export function extractWeeklyScores(matchupsByWeek, lastPlayed) {
    const out = new Map();
    for (const [week, entries] of matchupsByWeek) {
        if (week > lastPlayed) continue;
        for (const m of entries || []) {
            if (!Number.isFinite(m.points)) continue;
            // Sleeper reports 0.0 for weeks that have not been played.
            if (m.points === 0 && week > lastPlayed) continue;
            if (!out.has(m.roster_id)) out.set(m.roster_id, []);
            out.get(m.roster_id).push({ week, points: m.points });
        }
    }
    return out;
}

function buildRemainingSchedule(cfg, matchupsByWeek, currentWeek, teams) {
    const lastRegular = cfg.playoffWeekStart - 1;
    if (currentWeek > lastRegular) return [];
    const real = buildSchedule(matchupsByWeek, currentWeek, lastRegular);
    // Sleeper publishes future matchups for most leagues, but not all. Falling
    // back to a round robin keeps the odds model running instead of silently
    // reporting nothing.
    if (real.length >= 1) return real;
    return syntheticSchedule(teams.map((t) => t.rosterId), currentWeek, lastRegular);
}

/**
 * Assemble the rankings + valuation context for a loaded league. Called
 * whenever the board changes, so it must stay cheap.
 */
export function buildAnalysisContext(league, players) {
    const order = Object.keys(store.state.order || {}).length
        ? mergeOrder(store.state.order, players)
        : seedOrder(players);
    const rankings = toRankMap(order);
    const ctx = createValuationContext(league.cfg, {
        week: league.currentWeek,
        weeksLeft: Math.max(1, league.weeksLeft),
    });
    return { order, rankings, ctx };
}

/** Live scoreboard for the current week, joined to team names. */
export async function loadScoreboard(leagueId, week, teams, players) {
    const raw = await api.getMatchups(leagueId, week);
    const byRoster = new Map(teams.map((t) => [t.rosterId, t]));
    const byMatchup = new Map();

    for (const m of raw || []) {
        const team = byRoster.get(m.roster_id);
        const entry = {
            rosterId: m.roster_id,
            name: team?.name || `Roster ${m.roster_id}`,
            avatar: team?.avatar || null,
            points: m.points || 0,
            starters: (m.starters || []).map((id, i) => ({
                player: players[id] || null,
                points: (m.starters_points || [])[i] ?? 0,
            })),
        };
        const key = m.matchup_id ?? `bye-${m.roster_id}`;
        if (!byMatchup.has(key)) byMatchup.set(key, []);
        byMatchup.get(key).push(entry);
    }

    return [...byMatchup.entries()].map(([id, sides]) => ({ id, sides }));
}
