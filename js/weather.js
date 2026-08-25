// Stadium weather, from Open-Meteo (free, no key, CORS-open).
//
// Weather only matters for a minority of games, but when it matters it matters
// a lot: sustained wind above about 15mph is the single most reliable
// suppressor of passing and kicking production in fantasy football. Cold on its
// own is mostly folklore; wind and heavy precipitation are not.
//
// Domes are excluded outright rather than being given a "nice weather" bonus,
// because a dome is the absence of a weather factor, not a positive one.

import { politeFetch } from './net.js';

const API = 'https://api.open-meteo.com/v1/forecast';

/**
 * NFL venues. `dome: true` covers fixed roofs and retractable roofs, which are
 * closed in bad weather -- the case where weather would otherwise matter.
 */
export const STADIUMS = {
    ARI: { lat: 33.5276, lon: -112.2626, dome: true, name: 'State Farm Stadium' },
    ATL: { lat: 33.7554, lon: -84.4009, dome: true, name: 'Mercedes-Benz Stadium' },
    BAL: { lat: 39.2780, lon: -76.6227, dome: false, name: 'M&T Bank Stadium' },
    BUF: { lat: 42.7738, lon: -78.7870, dome: false, name: 'Highmark Stadium' },
    CAR: { lat: 35.2258, lon: -80.8528, dome: false, name: 'Bank of America Stadium' },
    CHI: { lat: 41.8623, lon: -87.6167, dome: false, name: 'Soldier Field' },
    CIN: { lat: 39.0955, lon: -84.5161, dome: false, name: 'Paycor Stadium' },
    CLE: { lat: 41.5061, lon: -81.6995, dome: false, name: 'Huntington Bank Field' },
    DAL: { lat: 32.7473, lon: -97.0945, dome: true, name: 'AT&T Stadium' },
    DEN: { lat: 39.7439, lon: -105.0201, dome: false, name: 'Empower Field' },
    DET: { lat: 42.3400, lon: -83.0456, dome: true, name: 'Ford Field' },
    GB: { lat: 44.5013, lon: -88.0622, dome: false, name: 'Lambeau Field' },
    HOU: { lat: 29.6847, lon: -95.4107, dome: true, name: 'NRG Stadium' },
    IND: { lat: 39.7601, lon: -86.1639, dome: true, name: 'Lucas Oil Stadium' },
    JAX: { lat: 30.3239, lon: -81.6373, dome: false, name: 'EverBank Stadium' },
    KC: { lat: 39.0489, lon: -94.4839, dome: false, name: 'Arrowhead Stadium' },
    LAC: { lat: 33.9535, lon: -118.3392, dome: true, name: 'SoFi Stadium' },
    LAR: { lat: 33.9535, lon: -118.3392, dome: true, name: 'SoFi Stadium' },
    LV: { lat: 36.0909, lon: -115.1833, dome: true, name: 'Allegiant Stadium' },
    MIA: { lat: 25.9580, lon: -80.2389, dome: false, name: 'Hard Rock Stadium' },
    MIN: { lat: 44.9736, lon: -93.2575, dome: true, name: 'U.S. Bank Stadium' },
    NE: { lat: 42.0909, lon: -71.2643, dome: false, name: 'Gillette Stadium' },
    NO: { lat: 29.9511, lon: -90.0812, dome: true, name: 'Caesars Superdome' },
    NYG: { lat: 40.8135, lon: -74.0745, dome: false, name: 'MetLife Stadium' },
    NYJ: { lat: 40.8135, lon: -74.0745, dome: false, name: 'MetLife Stadium' },
    PHI: { lat: 39.9008, lon: -75.1675, dome: false, name: 'Lincoln Financial Field' },
    PIT: { lat: 40.4468, lon: -80.0158, dome: false, name: 'Acrisure Stadium' },
    SEA: { lat: 47.5952, lon: -122.3316, dome: false, name: 'Lumen Field' },
    SF: { lat: 37.4033, lon: -121.9694, dome: false, name: "Levi's Stadium" },
    TB: { lat: 27.9759, lon: -82.5033, dome: false, name: 'Raymond James Stadium' },
    TEN: { lat: 36.1665, lon: -86.7713, dome: false, name: 'Nissan Stadium' },
    WAS: { lat: 38.9077, lon: -76.8645, dome: false, name: 'Northwest Stadium' },
};

/**
 * Impact multipliers by position. Wind hurts throwing and kicking; it barely
 * touches a running back's carries, and in a downpour a run-heavy game script
 * can even help one.
 *
 * Returns multipliers around 1.0 to apply to a weekly projection.
 */
export function weatherImpact(wx, pos) {
    if (!wx || wx.dome) return { multiplier: 1, severity: 'none', notes: [] };

    const notes = [];
    let mult = 1;

    const wind = wx.wind ?? 0;
    const precip = wx.precipProbability ?? 0;
    const temp = wx.temp ?? 60;

    // Wind: the effect is negligible until roughly 12mph, then compounds.
    if (wind >= 12) {
        const over = wind - 12;
        const windPenalty = { QB: 0.011, WR: 0.010, TE: 0.007, K: 0.016, RB: 0.002, DEF: 0 }[pos] ?? 0.006;
        const hit = Math.min(0.3, over * windPenalty);
        mult *= 1 - hit;
        if (wind >= 20) notes.push(`${Math.round(wind)} mph wind — a serious problem for throwing and kicking.`);
        else if (wind >= 15) notes.push(`${Math.round(wind)} mph wind will take something off the passing game.`);
        else notes.push(`${Math.round(wind)} mph wind, mild.`);
        // A windy game that turns run-heavy can help the back who gets the carries.
        if (pos === 'RB' && wind >= 18) mult *= 1.03;
    }

    if (precip >= 60) {
        const hit = { QB: 0.05, WR: 0.05, TE: 0.03, K: 0.04, RB: 0, DEF: 0 }[pos] ?? 0.03;
        mult *= 1 - hit;
        notes.push(`${Math.round(precip)}% chance of precipitation.`);
        if (pos === 'RB') mult *= 1.02;
    }

    if (temp <= 20) {
        mult *= { QB: 0.97, WR: 0.97, TE: 0.98, K: 0.95, RB: 1, DEF: 1 }[pos] ?? 0.98;
        notes.push(`${Math.round(temp)}°F — genuinely cold, worth a small downgrade.`);
    }

    const drop = 1 - mult;
    const severity = drop > 0.12 ? 'high' : drop > 0.05 ? 'medium' : drop > 0.01 ? 'low' : 'none';
    return { multiplier: mult, severity, notes };
}

/**
 * Pull the forecast for one venue at one kickoff time.
 * Open-Meteo returns hourly arrays; we take the hour nearest kickoff.
 */
export async function fetchVenueWeather(team, kickoffIso, { neutralSite = false, indoor = null, venueName = null } = {}) {
    // A game in London or Munich is not played at the home team's stadium, and
    // pulling that forecast would be confidently wrong -- including its dome
    // flag. Without a venue feed the honest answer is "unknown".
    if (neutralSite) return { dome: false, team, venue: venueName || 'Neutral site', unavailable: true };

    // ESPN reports whether the actual venue is indoors. Prefer it over the
    // hardcoded table, which cannot know about a relocation or a new roof.
    if (indoor === true) return { dome: true, venue: venueName || STADIUMS[team]?.name || 'Indoors', team };

    const stadium = STADIUMS[team];
    if (!stadium) return null;
    if (indoor !== false && stadium.dome) return { dome: true, venue: stadium.name, team };

    const params = new URLSearchParams({
        latitude: String(stadium.lat),
        longitude: String(stadium.lon),
        hourly: 'temperature_2m,precipitation_probability,wind_speed_10m,weather_code',
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        forecast_days: '8',
    });

    const res = await politeFetch(`${API}?${params}`);
    if (!res.ok) throw new Error(`Weather fetch failed (${res.status})`);
    const data = await res.json();
    return pickHour(data, kickoffIso, stadium, team);
}

export function pickHour(data, kickoffIso, stadium, team) {
    const hourly = data?.hourly;
    if (!hourly?.time?.length) return null;

    const target = kickoffIso ? new Date(kickoffIso).getTime() : Date.now();
    let bestIdx = 0;
    let bestGap = Infinity;
    for (let i = 0; i < hourly.time.length; i++) {
        const gap = Math.abs(new Date(hourly.time[i]).getTime() - target);
        if (gap < bestGap) {
            bestGap = gap;
            bestIdx = i;
        }
    }

    // Beyond the forecast horizon the numbers are meaningless; say so instead
    // of presenting a stale hour as a forecast.
    if (bestGap > 36 * 60 * 60 * 1000) return { dome: false, venue: stadium.name, team, unavailable: true };

    return {
        dome: false,
        team,
        venue: stadium.name,
        time: hourly.time[bestIdx],
        temp: hourly.temperature_2m?.[bestIdx] ?? null,
        precipProbability: hourly.precipitation_probability?.[bestIdx] ?? null,
        wind: hourly.wind_speed_10m?.[bestIdx] ?? null,
        code: hourly.weather_code?.[bestIdx] ?? null,
    };
}

export function describeWeather(wx) {
    if (!wx) return null;
    if (wx.dome) return 'Indoors — weather is not a factor.';
    if (wx.unavailable) return 'Kickoff is beyond the forecast window.';
    const bits = [];
    if (wx.temp !== null) bits.push(`${Math.round(wx.temp)}°F`);
    if (wx.wind !== null) bits.push(`${Math.round(wx.wind)} mph wind`);
    if (wx.precipProbability !== null) bits.push(`${Math.round(wx.precipProbability)}% precip`);
    return bits.join(' · ');
}

/**
 * Forecasts are cached per venue and kickoff: the slate is the same whichever
 * roster you are looking at, and re-requesting sixteen venues on every team
 * switch was the second half of the Start/Sit stampede.
 */
const forecastCache = new Map();

/** Fetch weather for many games at once, tolerating individual failures. */
export async function fetchWeatherForGames(games) {
    const out = new Map();
    await Promise.all(
        (games || []).map(async (g) => {
            try {
                const key = `${g.home}:${g.date}`;
                if (!forecastCache.has(key)) {
                    forecastCache.set(key, fetchVenueWeather(g.home, g.date, {
                        neutralSite: g.neutralSite,
                        indoor: g.indoor,
                        venueName: g.venue,
                    }));
                    forecastCache.get(key).catch(() => forecastCache.delete(key));
                }
                const wx = await forecastCache.get(key);
                if (wx) out.set(g.home, wx);
            } catch {
                /* weather is enrichment; never fail the view over it */
            }
        })
    );
    return out;
}
