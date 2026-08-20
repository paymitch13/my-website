// Vegas game lines, from ESPN's public scoreboard feed (DraftKings numbers).
//
// A word on what this is and is not for.
//
// Vegas is excellent at one thing: predicting how many points a team will score
// in a specific game. That makes it a genuinely useful WEEKLY signal -- a back
// on a 27-point implied team in a shootout is in a different situation than the
// same back on a 16-point implied team getting buried. It is a poor SEASON-LONG
// signal, because this week's spread says nothing about a player's rest-of-
// season worth, and the season projections already price in team quality and
// offensive environment.
//
// So odds are surfaced as matchup context and never folded into trade value.

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

/** ESPN abbreviations that differ from Sleeper's. */
const TEAM_ALIAS = { WSH: 'WAS', LAR: 'LAR', JAX: 'JAX' };
const normalizeTeam = (t) => TEAM_ALIAS[t] || t;

/**
 * Implied team totals from the spread and the over/under.
 *
 *   favorite  = total/2 + |spread|/2
 *   underdog  = total/2 - |spread|/2
 *
 * which is just the pair of scores that hits the total and covers the spread.
 */
export function impliedTotals(overUnder, spread) {
    if (!Number.isFinite(overUnder) || !Number.isFinite(spread)) return null;
    const half = overUnder / 2;
    const edge = Math.abs(spread) / 2;
    return { favorite: half + edge, underdog: half - edge };
}

export function parseScoreboard(payload) {
    const games = [];
    for (const event of payload?.events || []) {
        const comp = event?.competitions?.[0];
        if (!comp) continue;

        const home = comp.competitors?.find((c) => c.homeAway === 'home');
        const away = comp.competitors?.find((c) => c.homeAway === 'away');
        if (!home || !away) continue;

        const homeAbbr = normalizeTeam(home.team?.abbreviation);
        const awayAbbr = normalizeTeam(away.team?.abbreviation);

        const odds = comp.odds?.[0] || null;
        const overUnder = odds?.overUnder ?? null;
        const spread = odds?.spread ?? null;
        const favoriteAbbr = odds?.awayTeamOdds?.favorite
            ? awayAbbr
            : odds?.homeTeamOdds?.favorite
              ? homeAbbr
              : null;

        const totals = impliedTotals(overUnder, spread);
        const implied = {};
        if (totals && favoriteAbbr) {
            const dog = favoriteAbbr === homeAbbr ? awayAbbr : homeAbbr;
            implied[favoriteAbbr] = totals.favorite;
            implied[dog] = totals.underdog;
        } else if (totals) {
            // Pick'em: no favorite, so both sides sit at half the total.
            implied[homeAbbr] = overUnder / 2;
            implied[awayAbbr] = overUnder / 2;
        }

        games.push({
            id: event.id,
            name: event.shortName,
            date: event.date,
            status: comp.status?.type?.description || null,
            home: homeAbbr,
            away: awayAbbr,
            spread,
            overUnder,
            favorite: favoriteAbbr,
            detail: odds?.details || null,
            provider: odds?.provider?.name || null,
            implied,
        });
    }
    return games;
}

/**
 * team abbreviation -> { impliedTotal, opponent, spread, overUnder, ... }
 * for the requested week.
 */
export function buildTeamContext(games) {
    const byTeam = new Map();
    for (const g of games) {
        for (const [team, opponent] of [
            [g.home, g.away],
            [g.away, g.home],
        ]) {
            if (!team) continue;
            byTeam.set(team, {
                team,
                opponent,
                home: team === g.home,
                impliedTotal: g.implied[team] ?? null,
                opponentImplied: g.implied[opponent] ?? null,
                spread: g.spread,
                overUnder: g.overUnder,
                isFavorite: g.favorite === team,
                detail: g.detail,
                kickoff: g.date,
                status: g.status,
            });
        }
    }
    return byTeam;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.week] NFL week; omit for whatever ESPN considers current
 * @param {number} [opts.season]
 */
export async function fetchOdds({ week, season, seasonType = 2 } = {}) {
    const params = new URLSearchParams();
    if (week) params.set('week', String(week));
    if (season) params.set('dates', String(season));
    params.set('seasontype', String(seasonType));

    const res = await fetch(`${SCOREBOARD}?${params}`);
    if (!res.ok) throw new Error(`Odds fetch failed (${res.status})`);
    const games = parseScoreboard(await res.json());
    return { games, byTeam: buildTeamContext(games) };
}

/** Plain-language read on a team's week: "shootout", "buried", etc. */
export function describeEnvironment(ctx, leagueAverageTotal = 22.5) {
    if (!ctx || ctx.impliedTotal === null) return null;
    const t = ctx.impliedTotal;
    const diff = t - leagueAverageTotal;
    if (diff > 4) return { tone: 'good', text: `Great spot — ${t.toFixed(1)} implied points is one of the highest on the slate.` };
    if (diff > 1.5) return { tone: 'good', text: `Favorable game environment at ${t.toFixed(1)} implied points.` };
    if (diff < -4) return { tone: 'bad', text: `Rough spot — only ${t.toFixed(1)} implied points, near the bottom of the slate.` };
    if (diff < -1.5) return { tone: 'warn', text: `Below-average game environment at ${t.toFixed(1)} implied points.` };
    return { tone: 'neutral', text: `Neutral spot at ${t.toFixed(1)} implied points.` };
}
