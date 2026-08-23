// Vegas lines from ESPN's public scoreboard (DraftKings numbers).
//
// The payload carries far more than a spread and a total: opening AND closing
// numbers for the spread, moneyline and total, whether the favorite has flipped
// since the market opened, whether the venue is indoors, and whether the game is
// at a neutral site. All of it is free and CORS-open, and most of it was being
// thrown away.
//
// What each market is actually good for in fantasy:
//
//   Implied team total  how many points an offense is expected to score. The
//                       single best one-number summary of a game environment.
//   Moneyline           win probability, once the vig is removed. Drives game
//                       script: big favorites run, big underdogs throw.
//   Line movement       where the market has moved since it opened. A total
//                       falling three points is information about weather,
//                       injuries or news that has not reached a projection yet.
//   Spread magnitude    blowout risk. A 14-point favorite's starters may not
//                       see the fourth quarter.

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

/** ESPN abbreviations that genuinely differ from Sleeper's. */
const TEAM_ALIAS = { WSH: 'WAS' };
const normalizeTeam = (t) => TEAM_ALIAS[t] || t;

/** "+150" / "-180" -> implied probability, before removing the vig. */
export function americanToProbability(odds) {
    const n = typeof odds === 'string' ? Number(odds.replace('+', '')) : odds;
    if (!Number.isFinite(n) || n === 0) return null;
    return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

/**
 * Two-way market probabilities with the bookmaker's margin removed.
 * Raw implied probabilities sum to more than 1; the overround is the vig.
 */
export function devig(oddsA, oddsB) {
    const a = americanToProbability(oddsA);
    const b = americanToProbability(oddsB);
    if (a === null || b === null) return null;
    const total = a + b;
    if (total <= 0) return null;
    return { a: a / total, b: b / total, vig: total - 1 };
}

/** "o37.5" / "+3.5" / "-1.5" -> number */
export function parseLine(line) {
    if (typeof line === 'number') return line;
    if (typeof line !== 'string') return null;
    const n = Number(line.replace(/^[ou]/i, ''));
    return Number.isFinite(n) ? n : null;
}

/**
 * Implied team totals from the spread and the over/under: the pair of scores
 * that hits the total and covers the spread.
 */
export function impliedTotals(overUnder, spread) {
    if (!Number.isFinite(overUnder) || !Number.isFinite(spread)) return null;
    const half = overUnder / 2;
    const edge = Math.abs(spread) / 2;
    return { favorite: half + edge, underdog: half - edge };
}

const phase = (market, side, which) => market?.[side]?.[which] ?? null;

export function parseScoreboard(payload) {
    const games = [];
    const teamsOnBye = (payload?.week?.teamsOnBye || [])
        .map((t) => normalizeTeam(t?.abbreviation))
        .filter(Boolean);

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

        // --- Opening numbers, for movement --------------------------------
        const openSpreadHome = parseLine(phase(odds?.pointSpread, 'home', 'open')?.line);
        const closeSpreadHome = parseLine(phase(odds?.pointSpread, 'home', 'close')?.line);
        const openTotal = parseLine(phase(odds?.total, 'over', 'open')?.line);
        const closeTotal = parseLine(phase(odds?.total, 'over', 'close')?.line) ?? overUnder;

        // --- Moneyline -> win probability ---------------------------------
        const mlHome = phase(odds?.moneyline, 'home', 'close')?.odds ?? null;
        const mlAway = phase(odds?.moneyline, 'away', 'close')?.odds ?? null;
        const probs = devig(mlHome, mlAway);

        const favoriteAbbr = odds?.awayTeamOdds?.favorite
            ? awayAbbr
            : odds?.homeTeamOdds?.favorite
              ? homeAbbr
              : null;
        // ESPN records who was favored when the market opened, so a flip is
        // detectable: that is the market changing its mind, which is news.
        const favoriteAtOpen = odds?.awayTeamOdds?.favoriteAtOpen
            ? awayAbbr
            : odds?.homeTeamOdds?.favoriteAtOpen
              ? homeAbbr
              : null;

        const totals = impliedTotals(overUnder, spread);
        const implied = {};
        if (totals && favoriteAbbr) {
            const dog = favoriteAbbr === homeAbbr ? awayAbbr : homeAbbr;
            implied[favoriteAbbr] = totals.favorite;
            implied[dog] = totals.underdog;
        } else if (totals) {
            implied[homeAbbr] = overUnder / 2;
            implied[awayAbbr] = overUnder / 2;
        }

        games.push({
            id: event.id,
            name: event.shortName,
            date: event.date,
            status: comp.status?.type?.description || null,
            state: comp.status?.type?.state || null,
            home: homeAbbr,
            away: awayAbbr,
            neutralSite: !!comp.neutralSite,
            // Authoritative, and it handles neutral sites a hardcoded stadium
            // table cannot.
            indoor: comp.venue?.indoor ?? null,
            venue: comp.venue?.fullName || null,
            spread,
            overUnder,
            favorite: favoriteAbbr,
            favoriteAtOpen,
            favoriteFlipped: !!(favoriteAbbr && favoriteAtOpen && favoriteAbbr !== favoriteAtOpen),
            detail: odds?.details || null,
            provider: odds?.provider?.name || null,
            implied,
            moneyline: { home: mlHome, away: mlAway },
            winProbability: probs ? { [homeAbbr]: probs.a, [awayAbbr]: probs.b, vig: probs.vig } : null,
            movement: {
                spread: openSpreadHome !== null && closeSpreadHome !== null
                    ? { open: openSpreadHome, close: closeSpreadHome, change: closeSpreadHome - openSpreadHome }
                    : null,
                total: openTotal !== null && closeTotal !== null
                    ? { open: openTotal, close: closeTotal, change: closeTotal - openTotal }
                    : null,
            },
            // ESPN ships a forecast on the event itself.
            espnWeather: event.weather
                ? {
                      temperature: event.weather.temperature ?? null,
                      condition: event.weather.conditionId || event.weather.displayValue || null,
                  }
                : null,
        });
    }

    games.teamsOnBye = teamsOnBye;
    return games;
}

/** team abbreviation -> everything known about that team's week. */
export function buildTeamContext(games) {
    const byTeam = new Map();
    for (const g of games) {
        for (const [team, opponent] of [
            [g.home, g.away],
            [g.away, g.home],
        ]) {
            if (!team) continue;
            const isHome = team === g.home;
            const isFavorite = g.favorite === team;
            // A team's own spread: negative when favored, as it is quoted.
            const ownSpread = Number.isFinite(g.spread)
                ? (isFavorite ? -Math.abs(g.spread) : Math.abs(g.spread))
                : null;

            byTeam.set(team, {
                team,
                opponent,
                home: isHome,
                neutralSite: g.neutralSite,
                indoor: g.indoor,
                venue: g.venue,
                impliedTotal: g.implied[team] ?? null,
                opponentImplied: g.implied[opponent] ?? null,
                spread: g.spread,
                ownSpread,
                overUnder: g.overUnder,
                isFavorite,
                favoriteFlipped: g.favoriteFlipped,
                winProbability: g.winProbability?.[team] ?? null,
                movement: g.movement,
                detail: g.detail,
                kickoff: g.date,
                status: g.status,
                espnWeather: g.espnWeather,
                game: g,
            });
        }
    }
    return byTeam;
}

export async function fetchOdds({ week, season, seasonType = 2 } = {}) {
    const params = new URLSearchParams();
    if (week) params.set('week', String(week));
    if (season) params.set('dates', String(season));
    params.set('seasontype', String(seasonType));

    const res = await fetch(`${SCOREBOARD}?${params}`);
    if (!res.ok) throw new Error(`Odds fetch failed (${res.status})`);
    const games = parseScoreboard(await res.json());
    return { games, byTeam: buildTeamContext(games), teamsOnBye: games.teamsOnBye || [] };
}

// --- Interpretation --------------------------------------------------------

/** Plain-language read on a team's game environment. */
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

/**
 * Blowout risk. A double-digit favorite may rest starters; a double-digit
 * underdog abandons the run and throws forty times. Both matter, in opposite
 * directions, and they matter per position.
 */
export function gameScript(ctx) {
    if (!ctx || !Number.isFinite(ctx.ownSpread)) return null;
    const s = ctx.ownSpread;
    if (s <= -10) return { kind: 'heavy-favorite', text: `${Math.abs(s)}-point favorite — run-heavy script, and starters may sit late if it gets out of hand.` };
    if (s <= -3.5) return { kind: 'favorite', text: `Favored by ${Math.abs(s)} — mildly run-leaning script.` };
    if (s >= 10) return { kind: 'heavy-underdog', text: `${s}-point underdog — likely trailing and throwing, which lifts pass-catchers and hurts the run.` };
    if (s >= 3.5) return { kind: 'underdog', text: `Underdog by ${s} — modest pass-leaning script.` };
    return { kind: 'even', text: 'Close game expected — neutral script.' };
}

/**
 * Whether the market has moved, and by how much. A total that has fallen three
 * points since opening reflects weather, injury or news that a preseason
 * projection has not absorbed yet.
 */
export function describeMovement(ctx) {
    const notes = [];
    const m = ctx?.movement;
    if (!m) return notes;

    if (m.total && Math.abs(m.total.change) >= 1.5) {
        const dir = m.total.change > 0 ? 'risen' : 'fallen';
        notes.push({
            kind: 'total',
            tone: m.total.change > 0 ? 'good' : 'bad',
            text: `The game total has ${dir} from ${m.total.open} to ${m.total.close} since it opened.`,
        });
    }
    if (m.spread && Math.abs(m.spread.change) >= 1.5) {
        notes.push({
            kind: 'spread',
            tone: 'neutral',
            text: `The spread has moved ${Math.abs(m.spread.change).toFixed(1)} points since opening (${fmtSpread(m.spread.open)} → ${fmtSpread(m.spread.close)}, home side).`,
        });
    }
    if (ctx.favoriteFlipped) {
        notes.push({
            kind: 'flip',
            tone: 'warn',
            text: 'The favorite has flipped since the market opened — something changed.',
        });
    }
    return notes;
}

export const fmtSpread = (n) => (n > 0 ? `+${n}` : `${n}`);

export const fmtMoneyline = (odds) => (typeof odds === 'string' ? odds : odds > 0 ? `+${odds}` : `${odds}`);
