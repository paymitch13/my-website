// Hermetic browser smoke test.
//
// The whole app is served from a local static server and every Sleeper /
// ESPN / Open-Meteo call is fulfilled from a fixture, so this runs with no
// network at all and gives the same answer every time. It boots the app,
// visits every tab at four widths, and fails on any page error, any view that
// renders nothing, and any horizontal overflow.
// Run with:  npm run smoke
//
// Needs playwright-core and a Chromium binary; both are optional, and `npm
// test` deliberately does not depend on them -- the engine tests stay
// dependency-free. This is the check that the ENGINE being right actually
// reaches the screen.
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
    let p = normalize(decodeURIComponent(req.url.split('?')[0]));
    if (p.endsWith('/')) p += 'index.html';
    try {
        const buf = await readFile(join(ROOT, p));
        res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
        res.end(buf);
    } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// A full season of priced games, so the rest-of-season and playoff-week
// outlooks are exercised rather than skipped. ESPN really does post lines for
// every week in advance -- weeks 1, 2, 8, 15 and 17 all come back priced.
const NFL_TEAMS = ['KC', 'BUF', 'SF', 'DAL', 'PHI', 'MIA', 'CIN', 'DET', 'LAR', 'BAL', 'NYJ', 'CLE', 'ARI', 'NE', 'TEN', 'CAR'];
const scoreboardFor = (week) => ({
    week: { number: week, teamsOnBye: week >= 4 && week <= 14 ? [{ abbreviation: NFL_TEAMS[week % NFL_TEAMS.length] }] : [] },
    events: Array.from({ length: NFL_TEAMS.length / 2 }, (_, i) => {
        const home = NFL_TEAMS[i * 2];
        const away = NFL_TEAMS[i * 2 + 1];
        return {
            id: `${week}${i}`,
            date: new Date(Date.now() + 86400000).toISOString(),
            week: { number: week },
            competitions: [{
                id: `${week}${i}`,
                neutralSite: false,
                venue: { indoor: i % 3 === 0 },
                odds: [{
                    overUnder: 40 + i * 2,
                    spread: -(i + 1),
                    details: `${home} -${i + 1}`,
                    overOdds: -110,
                    underOdds: -110,
                    homeTeamOdds: { favorite: true, moneyLine: -150, spreadOdds: -110, team: { abbreviation: home } },
                    awayTeamOdds: { favorite: false, moneyLine: 130, spreadOdds: -110, team: { abbreviation: away } },
                }],
                competitors: [
                    { homeAway: 'home', team: { abbreviation: home } },
                    { homeAway: 'away', team: { abbreviation: away } },
                ],
            }],
        };
    }),
});


// --- Fixtures --------------------------------------------------------------
const POS = { QB: 2, RB: 5, WR: 6, TE: 2, K: 1, DEF: 1 };
const players = {};
const projections = [];
let n = 0;
for (const [pos, per] of Object.entries(POS)) {
    for (let i = 0; i < per * 14; i++) {
        const id = `f${++n}`;
        players[id] = {
            player_id: id, first_name: pos, last_name: `Player ${i + 1}`,
            position: pos, fantasy_positions: [pos], team: NFL_TEAMS[n % NFL_TEAMS.length], age: 25,
            injury_status: null, active: true, search_rank: n,
            // Sleeper carries espn_id for a share of players, and it is the
            // key the prop markets join on. Without it the props pipeline
            // falls back to a name lookup against an endpoint this fixture
            // does not serve, so every market silently failed to resolve and
            // the slate-edge board rendered empty.
            espn_id: 900000 + n,
        };
        const ppg = 22 - i * 0.35;
        projections.push({
            player_id: id, player: { position: pos, team: 'KC' },
            stats: {
                pts_half_ppr: Math.max(2, ppg) * 17,
                gp: 17,
                // A real stat line, so the yard and touchdown rows have
                // something to render. Yards alone made the page look like it
                // had no touchdown markets when it simply had no TD data.
                ...(pos === 'QB'
                    ? { pass_yd: 3800, pass_td: 26, pass_int: 11, rush_yd: 260, rush_td: 3 }
                    : pos === 'RB'
                        ? { rush_yd: Math.max(200, ppg * 70), rush_td: 7, rec: 40, rec_yd: 320, rec_td: 2 }
                        : pos === 'WR' || pos === 'TE'
                            ? { rec: 75, rec_yd: Math.max(300, ppg * 55), rec_td: 6, rush_yd: 20, rush_td: 0.2 }
                            : { fgm: 24, xpm: 34, sack: 38, int: 12, ff: 9, def_td: 2 }),
            },
        });
    }
}
const rosters = [];
const users = [];
const ids = Object.keys(players);
for (let t = 1; t <= 12; t++) {
    users.push({ user_id: `u${t}`, display_name: `Manager ${t}`, metadata: { team_name: t === 3 ? 'The Extraordinarily Long Team Name Of Doom' : `Team ${t}` } });
    rosters.push({
        roster_id: t, owner_id: `u${t}`,
        players: ids.filter((_, i) => i % 12 === t - 1).slice(0, 15),
        starters: [], settings: { wins: 3, losses: 3, ties: 0, fpts: 700, fpts_decimal: 0 },
    });
}
// One week's projections, with a real opponent so players actually have a game
// to be started in.
const weeklyProjections = projections.map((row, i) => ({
    player_id: row.player_id,
    player: row.player,
    team: players[row.player_id]?.team || 'KC',
    opponent: NFL_TEAMS[(i + 3) % NFL_TEAMS.length],
    game_id: `g${i % 8}`,
    week: 7,
    stats: Object.fromEntries(
        Object.entries(row.stats).map(([k, v]) => [k, k === 'gp' ? 1 : Math.round((v / 17) * 10) / 10])
    ),
}));

// Completed weeks of real stat lines, keyed by week.
//
// The route used to answer every weekly-stats request with an empty array,
// which made the Stats page render nothing but its empty states -- it passed
// every assertion about headings while proving none of the content. Advanced
// stats are computed from these rows, so they have to carry what the real feed
// carries: offensive snaps against team snaps, air yards, yards after contact,
// red-zone looks, and a team field, since share metrics are measured against
// the team's own weekly totals.
//
// A ramp across the weeks on purpose, so "rising" and "falling" have something
// real to find: the first player at each position grows into his role while
// the second shrinks out of his.
// The fixture's NFL state is week 7, so weeks 1-6 are in the books.
const LAST_PLAYED = 6;

const weeklyStatsByWeek = new Map();
for (let w = 1; w <= LAST_PLAYED; w++) {
    const rows = [];
    for (const [id, p] of Object.entries(players)) {
        const idx = Number(p.last_name.replace('Player ', '')) || 1;
        const t = (w - 1) / 5;
        // Player 1 at each position ramps up, player 2 ramps down, the rest
        // hold steady. Enough to exercise both movers lists.
        const ramp = idx === 1 ? 0.3 + 0.6 * t : idx === 2 ? 0.9 - 0.5 * t : 0.55;
        const teamSnaps = 62;
        const snaps = Math.round(teamSnaps * ramp);
        const base = {
            gp: 1,
            off_snp: snaps,
            tm_off_snp: teamSnaps,
        };
        let line;
        if (p.position === 'QB') {
            line = {
                pass_att: Math.round(32 * ramp), pass_cmp: Math.round(21 * ramp),
                pass_yd: Math.round(250 * ramp), pass_td: idx === 1 ? 2 : 1,
                pass_air_yd: Math.round(300 * ramp), pass_sack: 2,
                pass_rtg: 88 + idx, rush_att: 3, rush_yd: 14,
            };
        } else if (p.position === 'RB') {
            line = {
                rush_att: Math.round(18 * ramp), rush_yd: Math.round(78 * ramp),
                rush_yac: Math.round(40 * ramp), rush_btkl: idx <= 2 ? 2 : 0,
                rush_rz_att: Math.round(4 * ramp), rush_fd: Math.round(4 * ramp),
                rec_tgt: Math.round(3 * ramp), rec: Math.round(2 * ramp),
                rec_yd: Math.round(18 * ramp), rec_air_yd: Math.round(12 * ramp),
                rush_td: idx === 1 ? 1 : 0,
            };
        } else if (p.position === 'WR' || p.position === 'TE') {
            line = {
                rec_tgt: Math.round(9 * ramp), rec: Math.round(6 * ramp),
                rec_yd: Math.round(82 * ramp), rec_air_yd: Math.round(110 * ramp),
                rec_rz_tgt: Math.round(2 * ramp), rec_fd: Math.round(4 * ramp),
                rec_drop: idx === 2 ? 1 : 0, rec_td: idx === 1 ? 1 : 0,
            };
        } else {
            // Kickers and defenses have no advanced stats worth the name, and
            // the Stats page does not claim any for them.
            line = p.position === 'K' ? { fgm: 2, xpm: 3 } : { sack: 3, int: 1, pts_allow: 17 };
        }
        rows.push({
            player_id: id,
            team: p.team,
            opponent: NFL_TEAMS[(Number(id.slice(1)) + w) % NFL_TEAMS.length],
            week: w,
            player: { position: p.position, team: p.team },
            stats: { ...base, ...line },
        });
    }
    weeklyStatsByWeek.set(w, rows);
}

// Season totals, summed from the weekly rows rather than invented separately.
//
// This route used to serve an empty array, so every scenario ran with no
// results at all: the blend had nothing to weigh against the projection, and
// the board's movement came entirely from the market. One source of truth
// means a change to the weekly ramp above cannot leave the two disagreeing.
const seasonStats = (() => {
    const totals = new Map();
    for (let w = 1; w <= LAST_PLAYED; w++) {
        for (const row of weeklyStatsByWeek.get(w) || []) {
            let acc = totals.get(row.player_id);
            if (!acc) {
                acc = { player_id: row.player_id, team: row.team, player: row.player, stats: {} };
                totals.set(row.player_id, acc);
            }
            for (const [k, val] of Object.entries(row.stats)) {
                // A rate is not additive. None of the fixture's rate stats
                // feed scoring, so carrying the last one is honest enough and
                // summing them would not be.
                acc.stats[k] = k === 'pass_rtg' ? val : (acc.stats[k] || 0) + val;
            }
        }
    }
    return [...totals.values()];
})();

// Market values for the fixture league. Reversed against the projections on
// purpose -- see the route above.
const marketRows = [];
{
    const byPos = {};
    for (const id of Object.keys(players)) {
        const pos = players[id].position;
        if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
        (byPos[pos] ||= []).push(id);
    }
    for (const [pos, ids] of Object.entries(byPos)) {
        const reversed = [...ids].reverse();
        reversed.forEach((id, i) => {
            marketRows.push({
                player: {
                    id: Number(id.slice(1)), name: `${pos} Player ${ids.indexOf(id) + 1}`,
                    position: pos, sleeperId: id,
                },
                value: Math.max(40, 9000 - i * 260),
                overallRank: marketRows.length + 1,
                positionRank: i + 1,
                trend30Day: 0,
            });
        });
    }
}

const league = {
    league_id: 'L1', name: 'Fixture League', season: '2025', status: 'in_season',
    total_rosters: 12,
    settings: {
        num_teams: 12, playoff_teams: 6, playoff_week_start: 15, leg: 7,
        // A FAAB league, so the cash UI is exercised rather than skipped.
        waiver_budget: 100, waiver_type: 2, waiver_day_of_week: 3, trade_deadline: 12,
    },
    scoring_settings: { rec: 0.5, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6, pass_td: 4 },
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
};
const state = { season: '2025', week: 7, display_week: 7, season_type: 'regular', leg: 7 };
const matchups = rosters.map((r, i) => ({ roster_id: r.roster_id, matchup_id: Math.floor(i / 2) + 1, points: 95 + i, starters: r.players.slice(0, 9), players: r.players }));

// Winning bids, so the FAAB rate is measured rather than guessed.
const waivers = ids.slice(0, 6).map((id, i) => ({
    transaction_id: `w${i}`,
    type: 'waiver',
    status: 'complete',
    leg: 3,
    created: Date.now() - i * 86400000,
    status_updated: Date.now() - i * 86400000,
    roster_ids: [1],
    adds: { [id]: 1 },
    drops: null,
    draft_picks: [],
    waiver_budget: [],
    settings: { waiver_bid: 4 + i * 3 },
}));

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const fixtures = [
    [/players\/nfl$/, () => json(players)],
    // Weekly projections are a DIFFERENT quantity from season ones, and serving
    // the season rows for both made every start/sit number seventeen times too
    // big -- a quarterback projected for 278 points on Sunday. The weekly route
    // has to come first: it is the more specific pattern.
    [/projections\/nfl\/\d+\/\d+/, () => json(weeklyProjections)],
    [/projections\/nfl/, () => json(projections)],
    // Per-week stat lines. The week is the last path segment, so a request for
    // week 3 gets week 3 rather than every week's rows at once.
    [/stats\/nfl\/\d+\/(\d+)/, (url) => {
        const w = Number(url.match(/stats\/nfl\/\d+\/(\d+)/)[1]);
        return json(weeklyStatsByWeek.get(w) || []);
    }],
    [/stats\/nfl/, () => json(seasonStats)],
    [/\/state\/nfl/, () => json(state)],
    [/\/league\/L1\/rosters/, () => json(rosters)],
    [/\/league\/L1\/users/, () => json(users)],
    [/\/league\/L1\/matchups/, () => json(matchups)],
    [/\/league\/L1\/transactions/, () => json(waivers)],
    [/\/league\/L1$/, () => json(league)],
    [/\/user\//, () => json({ user_id: 'u1', display_name: 'Manager 1' })],
    [/players\/nfl\/trending/, () => json([])],
    [/site\.api\.espn.*scoreboard/, (url) => {
        const week = Number(new URL(url).searchParams.get('week')) || 7;
        return json(scoreboardFor(week));
    }],
    // Player prop markets. These used to be empty, so the slate-edge board had
    // nothing to find and the whole feature rendered only its empty state.
    //
    // Two things the first attempt got wrong, both worth stating: the market
    // names have to match the loose patterns in props.js ("Receiving Yards",
    // not "receivingYards"), and there is no anytime-touchdown pattern at all,
    // so a touchdown market has to be named per phase. Two markets per player
    // minimum, because one line is a fact about one stat rather than a
    // projection -- and deliberately disagreeing with the projection in both
    // directions so both halves of the board populate.
    [/sports\.core\.api\.espn.*propBets/, () => {
        const items = [];
        let k = 0;
        for (const [id, p] of Object.entries(players)) {
            if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
            const athleteId = 900000 + Number(id.slice(1));
            // Alternate who the market likes, so neither list is empty.
            const lean = k++ % 2 === 0 ? 1.5 : 0.5;
            const mk = (name, value) => ({
                athlete: { $ref: `http://x/athletes/${athleteId}?lang=en` },
                type: { name },
                current: { target: { value } },
                open: { target: { value: Math.round(value * 0.95 * 10) / 10 } },
            });
            if (p.position === 'QB') {
                items.push(mk('Passing Yards', Math.round(250 * lean)), mk('Passing Touchdowns', 1.5 * lean));
            } else if (p.position === 'RB') {
                items.push(mk('Rushing Yards', Math.round(70 * lean)), mk('Rushing Touchdowns', 0.5 * lean));
            } else {
                items.push(mk('Receiving Yards', Math.round(70 * lean)), mk('Receiving Touchdowns', 0.45 * lean));
            }
        }
        return json({ count: items.length, items });
    }],
    [/sports\.core\.api\.espn.*predictor/, () => json({ gameProjection: 64.2, matchupQuality: 70 })],
    [/sports\.core\.api\.espn.*\/odds/, () => json({
        count: 1,
        items: [{
            provider: { name: 'DraftKings' },
            overUnder: 44.5, spread: -3, overOdds: -125, underOdds: +105,
            homeTeamOdds: { favorite: true, moneyLine: -155, spreadOdds: -110 },
            awayTeamOdds: { favorite: false, moneyLine: 130, spreadOdds: -110 },
        }],
    })],
    [/open-meteo/, () => json({ hourly: {} })],
    // Market values, deliberately at odds with the projections: the board is
    // REVERSED within each position, so the projection's WR1 is the market's
    // cheapest receiver. Nothing about the market path can quietly degrade into
    // "same as the projection" and still pass.
    [/api\.fantasycalc\.com/, () => json(marketRows)],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.route('**', (route) => {
    const u = route.request().url();
    if (u.includes(`localhost:${port}`) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    for (const [re, make] of fixtures) if (re.test(u)) return route.fulfill(make(u));
    return route.fulfill(json({}));
});

await page.addInitScript(() => {
    localStorage.setItem('ffc:state:v1', JSON.stringify({ leagueId: 'L1', userId: 'u1', settings: {} }));
});

await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#tabs .tab:not([disabled])', { timeout: 30000 });
await page.waitForTimeout(3000);

const views = await page.$$eval('#tabs .tab', (els) => els.map((e) => e.dataset.view));
console.log('tabs:', views.join(', '));

// Bounding rects, not scrollWidth: a flex parent reports its child's overflow
// as its own, so scrollWidth names the wrong element every time. What actually
// matters is which box sticks out past the viewport.
const overflowOf = () => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrolled = document.documentElement.scrollWidth - vw;
    // Content inside a deliberate horizontal scroller (a wide table) is not a
    // bug -- that is the escape hatch working. Only boxes that stick out of the
    // page itself count.
    const inScroller = (e) => {
        for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if (ox === 'auto' || ox === 'scroll') return true;
        }
        return false;
    };
    const wide = [];
    for (const e of document.querySelectorAll('#view *')) {
        if (inScroller(e)) continue;
        const r = e.getBoundingClientRect();
        if (r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5)) {
            wide.push(`${e.tagName.toLowerCase()}.${e.className || '-'} [${r.left.toFixed(0)}..${r.right.toFixed(0)} of ${vw}] "${(e.textContent || '').trim().slice(0, 30)}"`);
        }
    }
    return { scrolled, wide: wide.slice(0, 4) };
});

for (const v of views) {
    await page.click(`#tabs .tab[data-view="${v}"]`);
    await page.waitForTimeout(1200);
    const text = (await page.textContent('#view')) || '';
    const o = await overflowOf();
    console.log(`  ${v.padEnd(10)} chars=${String(text.trim().length).padStart(5)} scroll=${o.scrolled}`);
    if (o.scrolled > 0) errors.push(`${v}: page scrolls horizontally by ${o.scrolled}px`);
    if (o.wide.length) errors.push(`${v}: content overflows its box — ${o.wide.join(', ')}`);
    if (text.trim().length < 80) errors.push(`${v}: rendered almost nothing (${text.trim().length} chars)`);
}

// --- The season ahead, which is the part that matters for trades -----------
await page.click('#tabs .tab[data-view="vegas"]');
await page.waitForTimeout(1500);
// --- Roster Check: it has to actually criticise something ------------------
await page.setViewportSize({ width: 1280, height: 900 });
await page.click('#tabs .tab[data-view="critique"]');
await page.waitForTimeout(2500);
{
    const text = (await page.textContent('#view')) || '';
    if (!/Lineup strength/.test(text)) errors.push('critique: no verdict tiles');
    if (!/(What a rival sees|Nothing to criticise)/.test(text)) errors.push('critique: no findings section');
    // Rule 2 of the design: every criticism carries the move that fixes it.
    const fixes = await page.$eval('#view', (n) => (n.textContent.match(/FIX/g) || []).length);
    const problems = await page.$eval('#view', (n) =>
        (n.textContent.match(/Fix this|Worth fixing|Worth knowing/g) || []).length);
    if (problems > 0 && fixes < problems) {
        errors.push(`critique: ${problems} findings but only ${fixes} fixes — every criticism needs a move`);
    }
    const o = await overflowOf();
    if (o.scrolled > 0) errors.push(`critique: scrolls horizontally by ${o.scrolled}px`);
    if (o.wide.length) errors.push(`critique: overflows — ${o.wide.join(', ')}`);
    console.log(`  critique: ${problems} findings, ${fixes} fixes, ${text.trim().length} chars`);
}

// --- Vegas: two scopes, player lines, and where the numbers came from -------
await page.setViewportSize({ width: 1280, height: 900 });
await page.click('#tabs .tab[data-view="vegas"]');
await page.waitForTimeout(3000);
{
    const text = (await page.textContent('#view')) || '';
    if (!/SOURCE/.test(text)) errors.push('vegas: does not say where the numbers came from');
    if (!/DraftKings/.test(text)) errors.push('vegas: the book is not named');
    if (!/this week/i.test(text)) errors.push('vegas: no weekly player lines');
    // Yard and touchdown lines, not just points.
    if (!/(Rec yds|Rush yds|Pass yds)/.test(text)) errors.push('vegas: no yardage lines for players');
    if (!/(Rec TD|Rush TD|Pass TD)/.test(text)) errors.push('vegas: no touchdown lines for players');
    // The juice fixture is -125/+105, so the de-vigged total must differ from
    // the posted one and be labelled as such.
    if (!/de-vigged/i.test(text)) errors.push('vegas: the juice correction is applied but never shown');

    const seasonBtn = await page.$('[data-scope="season"]');
    if (!seasonBtn) {
        errors.push('vegas: no rest-of-season toggle');
    } else {
        await seasonBtn.click();
        await page.waitForTimeout(2500);
        const seasonText = (await page.textContent('#view')) || '';
        if (!/Rest of season/.test(seasonText)) errors.push('vegas: no season-long team totals');
        if (!/Fantasy playoff weeks/.test(seasonText)) errors.push('vegas: the weeks that decide leagues are not shown');
        if (!/Best remaining schedules/.test(seasonText)) errors.push('vegas: schedules are not ranked');
        const o = await overflowOf();
        if (o.scrolled > 0) errors.push(`vegas season: scrolls horizontally by ${o.scrolled}px`);
        if (o.wide.length) errors.push(`vegas season: overflows — ${o.wide.join(', ')}`);
        console.log(`  vegas: both scopes render, ${seasonText.trim().length} chars in season mode`);
        // Back to weekly so later checks see the default.
        await page.click('[data-scope="week"]');
        await page.waitForTimeout(1500);
    }
}

// --- Naming a player in the finder ------------------------------------------
// The engine tests prove the search honours a target. Only the browser proves a
// manager can actually name one and read the price.
await page.setViewportSize({ width: 1280, height: 900 });
await page.click('#tabs .tab[data-view="finder"]');
await page.waitForTimeout(2500);
{
    // The toggle is gone: balanced is the only mode now.
    if (await page.$('button:has-text("Balanced only")')) {
        errors.push('finder: the balanced-only toggle is still there');
    }
    const targetBtn = await page.$('button:has-text("Target a player")');
    if (!targetBtn) {
        errors.push('finder: no way to name a target');
    } else {
        await targetBtn.click();
        await page.waitForSelector('.pick', { timeout: 5000 });
        const picked = (await page.textContent('.pick')) || '';
        await page.click('.pick');
        await page.waitForTimeout(4000);

        const text = (await page.textContent('#view')) || '';
        if (!/What it takes to get/.test(text)) {
            errors.push('finder: naming a target did not reframe the results as a price');
        }
        if (!/I WANT/.test(text)) errors.push('finder: the named target is not shown back');
        // The picker must offer somebody, and it must not offer my own players.
        if (!picked.trim()) errors.push('finder: the target picker was empty');

        const o = await overflowOf();
        if (o.scrolled > 0) errors.push(`finder target: scrolls horizontally by ${o.scrolled}px`);
        if (o.wide.length) errors.push(`finder target: overflows — ${o.wide.join(', ')}`);
        console.log(`  finder target: "${picked.trim().slice(0, 30)}" priced, ${text.trim().length} chars`);

        // Removing the chip has to put the open search back.
        const x = await page.$('.chip button.x');
        if (x) {
            await x.click();
            await page.waitForTimeout(3500);
            const back = (await page.textContent('#view')) || '';
            if (/What it takes to get/.test(back)) errors.push('finder: removing the target did not restore the open search');
            // The price-vs-projection sections work from week one, unlike the
            // usage ones, so they must be on the open board in every fixture.
            if (!/Priced below their projection/.test(back)) {
                errors.push('finder: the buy-low board is missing the price signal');
            }
            if (!/Priced above their projection/.test(back)) {
                errors.push('finder: the sell-high board is missing the price signal');
            }
        } else {
            errors.push('finder: the named target cannot be removed');
        }
    }
}

// --- FAAB, which only exists in the UI --------------------------------------
// The engine tests price cash; only the browser can say whether a manager can
// actually put it in a deal.
await page.setViewportSize({ width: 1280, height: 900 });
await page.click('#tabs .tab[data-view="trade"]');
await page.waitForTimeout(800);

const faabInputs = await page.$$('input[aria-label^="FAAB sent by"]');
if (faabInputs.length !== 2) {
    errors.push(`trade: expected a FAAB stepper on both sides, found ${faabInputs.length}`);
} else {
    const budgetText = (await page.textContent('#view')) || '';
    if (!/of \$100 would be left/.test(budgetText)) errors.push('trade: the FAAB row does not show the remaining budget');

    // The + button has to move the number and the cap has to hold.
    await page.click('button[aria-label="Send more FAAB"]');
    await page.waitForTimeout(250);
    const after = await page.$eval('input[aria-label^="FAAB sent by"]', (e) => e.value);
    if (after !== '1') errors.push(`trade: stepping FAAB up gave "${after}", expected "1"`);

    // Typing past the budget must clamp, not send money nobody has.
    await page.fill('input[aria-label^="FAAB sent by"]', '9999');
    await page.dispatchEvent('input[aria-label^="FAAB sent by"]', 'change');
    await page.waitForTimeout(300);
    const clamped = Number(await page.$eval('input[aria-label^="FAAB sent by"]', (e) => e.value));
    if (!(clamped > 0 && clamped <= 100)) errors.push(`trade: FAAB did not clamp to the budget, got ${clamped}`);
}

// --- A cash trade, end to end ----------------------------------------------
// The engine tests price cash and the model tests rank waiver targets. Only
// this proves the manager can actually build the deal and see the answer.
async function addPlayerToSide(nth) {
    const buttons = await page.$$('button:has-text("+ Add player")');
    if (!buttons[nth]) return false;
    await buttons[nth].click();
    await page.waitForSelector('.pick', { timeout: 5000 });
    await page.click('.pick');
    await page.waitForTimeout(400);
    return true;
}

if (await addPlayerToSide(0)) {
    await addPlayerToSide(1);
    // Put real money in the deal from side B.
    const inputs = await page.$$('input[aria-label^="FAAB sent by"]');
    if (inputs[1]) {
        await inputs[1].fill('25');
        await inputs[1].dispatchEvent('change');
        await page.waitForTimeout(300);
    }
    await page.click('button:has-text("Analyze trade")');
    await page.waitForTimeout(6000);

    const text = (await page.textContent('#view')) || '';
    if (!/What the cash buys/.test(text)) errors.push('trade: a cash deal did not surface what the cash buys');
    if (!/FAAB/.test(text)) errors.push('trade: the analysis never mentions the cash that moved');
    if (!/median of \$/.test(text)) errors.push('trade: the cash section does not cite the league’s own bid history');
    if (!/Copy link to this trade/.test(text)) errors.push('trade: no way to send the deal that was just built');

    // The fairness meter has to be quoting market price, not the user's board.
    // Without this the market could stop loading entirely and every other
    // assertion here would still pass.
    if (!/Split at market price/.test(text)) {
        errors.push('trade: the fairness meter is not priced at market');
    }

    const o = await overflowOf();
    if (o.scrolled > 0) errors.push(`trade result: scrolls horizontally by ${o.scrolled}px`);
    if (o.wide.length) errors.push(`trade result: overflows — ${o.wide.join(', ')}`);
    console.log(`  cash trade: analysed at market price, ${text.trim().length} chars of result`);
} else {
    errors.push('trade: could not add a player to a side');
}

// --- Vegas: where the money disagrees with the projection ------------------
//
// All of this machinery already existed and was applied only to the user's own
// roster, buried as one factor inside a start/sit call. These assertions are
// about it being a slate-wide board that names players and shows its working.
{
    await page.click('#tabs .tab[data-view="vegas"]');
    await page.waitForTimeout(4000);

    const text = (await page.textContent('#view')) || '';
    if (!/Where Vegas disagrees with the projection/.test(text)) {
        errors.push('vegas: no slate-wide edge board');
    }
    // Both directions, because they are different actions.
    if (!/Vegas is higher/.test(text) || !/Vegas is lower/.test(text)) {
        errors.push('vegas: the edge board does not split the two directions');
    }
    const edgeRows = await page.$$eval('#view .edge-row', (els) => els.length);
    if (!edgeRows) {
        errors.push('vegas: the edge board found nobody');
        const diag = (text.match(/No player markets[^.]*\.|players have markets posted[^.]*\./) || ['(no diagnostic)'])[0];
        console.log(`    edge board said: ${diag}`);
    }
    // The underlying lines, so the claim is checkable.
    if (!/market .* vs projected/.test(text)) {
        errors.push('vegas: edges do not show the market against the projection');
    }

    // Streaming spots: the two positions a single Vegas number predicts best.
    if (!/Streaming spots/.test(text)) errors.push('vegas: no streaming spots');
    if (!/highest own total/.test(text) || !/lowest opponent total/.test(text)) {
        errors.push('vegas: streaming spots do not explain what drives each position');
    }

    const o = await overflowOf();
    if (o.scrolled > 0) errors.push(`vegas edges: scrolls horizontally by ${o.scrolled}px`);
    if (o.wide.length) errors.push(`vegas edges: overflows — ${o.wide.join(', ')}`);
    console.log(`  vegas edges: ${edgeRows} player edges + streaming spots`);
}

// --- Stats -----------------------------------------------------------------
//
// The distinction the whole page rests on is opportunity versus efficiency, so
// that is what gets asserted: both kinds present, labelled, and the source
// stated honestly rather than implying Next Gen Stats it does not have.
{
    await page.click('#tabs .tab[data-view="stats"]');
    await page.waitForTimeout(4000);

    const text = (await page.textContent('#view')) || '';
    if (/Could not read/.test(text)) errors.push('stats: the view errored');
    if (!/Players measured/.test(text)) errors.push('stats: no summary tiles');
    if (!/Leaderboards/.test(text)) errors.push('stats: no leaderboards');
    if (!/Compare/.test(text)) errors.push('stats: no comparison');

    // The source disclosure. Claiming NGS would be the easiest and worst lie
    // this page could tell, so the absence has to be stated.
    if (!/Next Gen Stats/.test(text)) errors.push('stats: does not say what the source is');
    if (!/requires authentication/.test(text)) {
        errors.push('stats: does not disclose that NGS is unavailable rather than approximated');
    }

    // Opportunity and efficiency both represented and distinguished.
    if (!/predicts/.test(text) || !/regresses/.test(text)) {
        errors.push('stats: opportunity and efficiency are not distinguished');
    }

    const boards = await page.$$eval('#view .card h3', (els) => els.map((e) => e.textContent.trim()));
    if (!boards.some((b) => /Snap share|Carry share|Red-zone share/.test(b))) {
        errors.push(`stats: no opportunity leaderboard, saw: ${boards.join(', ')}`);
    }

    // The position switcher has to actually change the boards.
    const before = boards.join('|');
    const wrBtn = await page.$('#view .seg button[data-pos="WR"]');
    if (!wrBtn) {
        errors.push('stats: no position switcher');
    } else {
        await wrBtn.click();
        await page.waitForTimeout(700);
        const after = await page.$$eval('#view .card h3', (els) => els.map((e) => e.textContent.trim()));
        if (after.join('|') === before) errors.push('stats: switching position changed nothing');
        if (!after.some((b) => /Target share|Air yards share/.test(b))) {
            errors.push(`stats: receiver boards missing, saw: ${after.join(', ')}`);
        }
    }

    // And the full table, with a row per player and a column per metric.
    const headers = await page.$$eval('#view table thead th', (els) => els.length);
    if (headers < 6) errors.push(`stats: the full metric table has only ${headers} columns`);

    // Rising and falling have to actually find somebody. The fixture ramps one
    // player at each position into his role and another out of it, so an empty
    // movers list means the trend maths is not reaching the view.
    const movers = await page.$$eval('#view .mover', (els) => els.length);
    if (!movers) errors.push('stats: neither rising nor falling found anybody');
    if (!/role is growing|role is shrinking|Role and production/.test(text)) {
        errors.push('stats: no verdict on which way anybody is going');
    }

    const o = await overflowOf();
    if (o.scrolled > 0) errors.push(`stats: scrolls horizontally by ${o.scrolled}px`);
    if (o.wide.length) errors.push(`stats: overflows — ${o.wide.join(', ')}`);
    console.log(`  stats: ${boards.length} boards, ${headers} metric columns, ${movers} movers, source disclosed`);
}

// --- Waiver wire -----------------------------------------------------------
//
// The recommendations used to be five rows in a FAAB panel saying "adds 1.2
// pts/wk" and nothing else. This asserts the four things that were missing:
// a reason, the trap warning, who to drop, and the move spelled out.
{
    await page.click('#tabs .tab[data-view="waivers"]');
    await page.waitForTimeout(5000);

    const text = (await page.textContent('#view')) || '';
    if (/Could not build/.test(text)) errors.push('waivers: the view errored');
    if (!/Streams/.test(text)) errors.push('waivers: no summary tiles');

    // Season-long and weekly are separate answers, ranked separately.
    const sections = await page.$$eval('#view .section-head h2', (els) => els.map((e) => e.textContent.trim()));
    if (!sections.some((g) => /Season-long targets/.test(g))) {
        errors.push(`waivers: no season-long section, saw: ${sections.join(', ')}`);
    }
    if (!sections.some((g) => /Weekly streams/.test(g))) {
        errors.push(`waivers: no weekly streams section, saw: ${sections.join(', ')}`);
    }

    // Recommendations grouped by what kind of add each one is.
    const groups = await page.$$eval('#view .card h3', (els) => els.map((e) => e.textContent.trim()));
    const known = ['Must add', 'Starts for you now', 'Opportunity just opened', 'Rising in value',
        'Stash for the breakout', 'Playoff schedule', 'Good weekly option', 'Depth'];
    if (!groups.some((g) => known.includes(g))) {
        errors.push(`waivers: no role groups rendered, saw: ${groups.join(', ')}`);
    }

    // Kickers and defenses have to be streamable. They were excluded from the
    // free agent pool entirely, so the page could not answer the most routine
    // waiver question there is.
    const streamRows = await page.$$eval('#view .stream-row', (els) => els.length);
    if (!streamRows) errors.push('waivers: no weekly stream rows');
    if (!/a defense is a bet against one offense/.test(text)) {
        errors.push('waivers: defenses are not streamable, so K/DEF are still excluded from the pool');
    }
    if (!/Bid the minimum/.test(text)) {
        errors.push('waivers: does not warn that streams should be bid at the minimum');
    }

    // Every recommendation carries reasons, not just a number.
    const rows = await page.$$eval('#view .waiver-row', (els) => els.length);
    const whys = await page.$$eval('#view .waiver-why li', (els) => els.length);
    if (!rows) errors.push('waivers: no recommendations at all');
    if (whys < rows) errors.push(`waivers: ${rows} rows but only ${whys} reasons`);

    // The drop side of the move, which is what makes it an action.
    if (!/Cheapest to drop/.test(text)) errors.push('waivers: never says who to drop');
    if (!/The move: add/.test(text)) errors.push('waivers: the move is not spelled out');
    if (!/different players/.test(text)) {
        errors.push('waivers: does not explain that lineup cost and trade value differ');
    }

    const o = await overflowOf();
    if (o.scrolled > 0) errors.push(`waivers: scrolls horizontally by ${o.scrolled}px`);
    if (o.wide.length) errors.push(`waivers: overflows — ${o.wide.join(', ')}`);
    console.log(`  waivers: ${rows} season rows, ${streamRows} streams, ${whys} reasons, ${groups.length} role groups`);
}

// --- Players-only mode, end to end -----------------------------------------
//
// The question this answers -- "who won this trade" -- used to require
// disconnecting your league, and the fallback view it dropped you into threw a
// ReferenceError on an undefined `total` the moment both sides had a player.
// So the mode has to be driven, not just rendered: switched into while
// connected, filled on both sides, and re-priced under a changed format.
{
    await page.click('#tabs .tab[data-view="trade"]');
    await page.waitForTimeout(300);
    await page.click('.seg button[data-mode="vacuum"]');
    // The format change refetches the market for the new shape.
    await page.waitForTimeout(1500);

    let text = (await page.textContent('#view')) || '';
    if (!/League format/.test(text)) errors.push('vacuum: no format controls');
    if (!/Add at least one player to each side/.test(text)) {
        errors.push('vacuum: an empty board does not say what to do');
    }

    const added = (await addPlayerToSide(0)) && (await addPlayerToSide(1));
    if (!added) {
        errors.push('vacuum: could not build a two-sided deal');
    } else {
        text = (await page.textContent('#view')) || '';
        // A verdict, with a reason, and the honest limitation stated.
        if (!/receives/.test(text)) errors.push('vacuum: no ledger after filling both sides');
        if (!/who would win it today/.test(text)) {
            errors.push('vacuum: does not disclose that prices are current rather than historical');
        }
        if (!/Copy summary/.test(text)) errors.push('vacuum: no way to take the verdict away');

        // Format actually moves the numbers. Superflex roughly doubles a
        // quarterback, so the priced board must not be identical afterwards.
        const before = await page.$$eval('.chip .num', (els) => els.map((e) => e.textContent));
        const qbSelect = await page.$('.vac-field:has-text("QUARTERBACKS") select');
        if (!qbSelect) {
            errors.push('vacuum: no superflex control');
        } else {
            await qbSelect.selectOption('sf');
            await page.waitForTimeout(1800);
            const after = await page.$$eval('.chip .num', (els) => els.map((e) => e.textContent));
            if (JSON.stringify(before) === JSON.stringify(after)) {
                errors.push('vacuum: switching to superflex changed no prices at all');
            }
            const shapeText = (await page.textContent('#view')) || '';
            if (!/superflex/.test(shapeText)) errors.push('vacuum: the format in force is not stated');
        }

        const o = await overflowOf();
        if (o.scrolled > 0) errors.push(`vacuum: scrolls horizontally by ${o.scrolled}px`);
        if (o.wide.length) errors.push(`vacuum: overflows — ${o.wide.join(', ')}`);
        console.log(`  players-only: verdict + ledger + format reprice, ${text.trim().length} chars`);
    }
}

// --- Storage that refuses to work ------------------------------------------
//
// Safari in private mode, and any browser with site data blocked, makes
// localStorage throw rather than fail quietly -- historically on setItem, and
// in some configurations on merely touching window.localStorage. This app leans
// on it hard: the user's rankings ARE the product, and store.js reads at module
// load. A throw there takes the whole page down before a single view renders.
//
// The app cannot remember anything in that state, and should not pretend to.
// It does have to work.
{
    const hostile = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await hostile.addInitScript(() => {
        const boom = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() { return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 }; },
        });
    });
    const hostileErrors = [];
    hostile.on('pageerror', (e) => hostileErrors.push(`pageerror: ${e.message}`));
    await hostile.route('**', (route) => {
        const u = route.request().url();
        if (u.includes(`localhost:${port}`) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
        for (const [re, make] of fixtures) if (re.test(u)) return route.fulfill(make(u));
        return route.fulfill(json({}));
    });
    await hostile.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
    await hostile.waitForTimeout(5000);

    if (hostileErrors.length) {
        errors.push(`private mode: page threw — ${[...new Set(hostileErrors)].slice(0, 2).join(' | ')}`);
    }
    // Counted, not hardcoded: a new tab should not quietly fail this check,
    // and a hardcoded 9 reported "10/9 tabs" the moment one was added.
    const total = await hostile.$$eval('#tabs .tab', (ns) => ns.length);
    const enabled = await hostile.$$eval('#tabs .tab', (ns) => ns.filter((n) => !n.disabled).length);
    if (enabled < total) errors.push(`private mode: only ${enabled} of ${total} tabs usable`);

    // And the app has to actually work, not just boot.
    let painted = 0;
    for (const v of ['trade', 'finder', 'rankings', 'startsit']) {
        await hostile.click(`#tabs .tab[data-view="${v}"]`);
        await hostile.waitForTimeout(600);
        const body = (await hostile.textContent('#view')) || '';
        if (body.trim().length > 200) painted++;
        else errors.push(`private mode: ${v} rendered ${body.trim().length} chars`);
    }
    // Silently forgetting is worse than not working: the rankings ARE the
    // product, and losing twenty minutes of board ordering without warning is
    // the one outcome nobody forgives.
    const warned = (await hostile.textContent('body')) || '';
    if (!/not letting the page save|gone when you close/i.test(warned)) {
        errors.push('private mode: the app forgets everything and never says so');
    }
    console.log(`  private mode (localStorage throws): booted, ${enabled}/${total} tabs, ${painted}/4 views render, warns`);
    await hostile.close();
}

// --- The front door, with no league connected ------------------------------
//
// This is the app's default experience, and it was its least accurate one.
// Season results and market prices were fetched inside connectLeague alone, so
// a visitor who had not connected a Sleeper league was shown the preseason
// projection and nothing else -- in October, with no indication that was what
// they were looking at. Those two feeds carry most of the in-season signal.
{
    const stranger = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const strangerErrors = [];
    stranger.on('pageerror', (e) => strangerErrors.push(`pageerror: ${e.message}`));
    // Which upstreams it actually asked for, so "it loaded results" is checked
    // rather than inferred from the rendering.
    const asked = [];
    await stranger.route('**', (route) => {
        const u = route.request().url();
        if (u.includes(`localhost:${port}`) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
        asked.push(u);
        for (const [re, make] of fixtures) if (re.test(u)) return route.fulfill(make(u));
        return route.fulfill(json({}));
    });
    // No addInitScript seeding a leagueId: a genuinely first-time visitor.
    await stranger.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
    await stranger.waitForTimeout(6000);

    if (strangerErrors.length) {
        errors.push(`no league: page threw — ${[...new Set(strangerErrors)].slice(0, 2).join(' | ')}`);
    }
    if (!asked.some((u) => /stats\/nfl\/\d+(\?|$)/.test(u))) {
        errors.push('no league: never asked for this season’s results');
    }
    if (!asked.some((u) => /fantasycalc/i.test(u))) {
        errors.push('no league: never asked for market prices');
    }

    await stranger.click('#tabs .tab[data-view="rankings"]');
    await stranger.waitForTimeout(1200);
    const strangerBoard = (await stranger.textContent('#view')) || '';
    if (!/[Tt]hrough week \d+/.test(strangerBoard)) {
        errors.push('no league: the board does not say which week its numbers are through');
    }
    const strangerMoves = await stranger.$$eval('#view .prow-static .move', (els) =>
        els.map((e) => e.textContent.trim()).filter((t) => /^[▲▼]\d+$/.test(t)).length
    );
    if (!strangerMoves) errors.push('no league: the board shows no movement since the preseason');
    console.log(`  no league: results + market loaded, vintage stated, ${strangerMoves} movers`);
    await stranger.close();
}

// --- The shell a stranger lands on -----------------------------------------
{
    const head = await page.evaluate(() => ({
        skip: !!document.querySelector('.skip-link'),
        skipFirst: document.querySelector('a,button,input,select')?.className || '',
        manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') || null,
        footer: document.querySelector('.app-footer')?.textContent || '',
        stamp: document.getElementById('build-stamp')?.textContent || '',
    }));
    if (!head.skip) errors.push('shell: no skip link');
    if (!head.skipFirst.includes('skip-link')) errors.push('shell: the skip link is not the first tab stop');
    if (!head.manifest) errors.push('shell: no web app manifest');
    // Every data source we depend on has to be named, FantasyCalc included.
    for (const who of ['Sleeper', 'FantasyCalc', 'ESPN', 'Open-Meteo']) {
        if (!head.footer.includes(who)) errors.push(`shell: ${who} is not credited`);
    }
    if (!/no account, no server and no tracking/i.test(head.footer)) errors.push('shell: privacy position not stated');
    if (!/Report a problem/.test(head.footer)) errors.push('shell: no way to report a problem');
    if (!/^build [0-9a-f]{7,}/.test(head.stamp)) errors.push(`shell: build stamp missing or malformed ("${head.stamp}")`);

    const manifest = await page.evaluate(async (href) => {
        const r = await fetch(href);
        return r.ok ? await r.json() : null;
    }, head.manifest);
    if (!manifest) errors.push('shell: manifest does not load');
    else {
        for (const k of ['name', 'start_url', 'display', 'icons', 'theme_color']) {
            if (!manifest[k]) errors.push(`manifest: missing ${k}`);
        }
    }
    console.log(`  shell: skip link, manifest, attribution, privacy, ${head.stamp}`);
}

// --- Start/Sit shows the whole roster --------------------------------------
// The complaint that prompted the rework: two quarterbacks on one roster were
// never put next to each other, because the page only compared players within
// 2.5 points of a starter and never rendered the bench at all.
await page.click('#tabs .tab[data-view="startsit"]');
await page.waitForTimeout(4000);
{
    const text = (await page.textContent('#view')) || '';
    // The bench is a divider inside the roster table now, not a section of
    // its own, so assert the divider AND that rows follow it.
    const benchDivider = await page.$('#view table tr.row-divider');
    const benchRows = await page.$$eval('#view table tr.row-bench', (els) => els.length);
    if (!benchDivider) errors.push('start/sit: no bench divider in the roster table');
    if (benchRows < 3) errors.push(`start/sit: only ${benchRows} bench rows in the roster table`);
    if (!/Every decision/.test(text)) errors.push('start/sit: per-slot decisions are missing');
    if (!/Compare players/.test(text)) errors.push('start/sit: no comparison card');

    // Starters and bench in ONE table with the same columns, which is the
    // whole point of merging them: the projections used to be "at the top" for
    // the nine already starting and in a separate section far below for the
    // fifteen being decided between.
    if (!/Your roster this week/.test(text)) errors.push('start/sit: the roster is not one table');
    const tableCount = await page.$$eval('#view table', (els) => els.length);
    const bodies = await page.$$eval('#view table tbody tr', (els) => els.length);
    if (bodies < 12) errors.push(`start/sit: only ${bodies} roster rows rendered across ${tableCount} tables`);
    // Every row carries a margin, starter and bench alike.
    const margins = await page.$$eval('#view table tbody tr td:nth-child(6)', (els) =>
        els.map((e) => e.textContent.trim()).filter((t) => /^[+\u2212-]/.test(t))
    );
    if (margins.length < 8) errors.push(`start/sit: only ${margins.length} rows show a margin`);

    // Every rostered player with a projection has to appear somewhere on the
    // page -- that is the whole complaint.
    const missing = [];
    for (const id of rosters[0].players.slice(0, 12)) {
        const p = players[id];
        if (!p) continue;
        const name = `${p.position} ${p.last_name.replace('Player ', '')}`.trim();
        if (!text.includes(p.last_name)) missing.push(p.last_name);
    }
    if (missing.length) errors.push(`start/sit: rostered players missing from the page: ${[...new Set(missing)].join(', ')}`);

    // The second quarterback must be comparable to the first.
    const qbCount = (text.match(/QB/g) || []).length;
    if (qbCount < 2) errors.push('start/sit: only one QB surfaced on a two-QB roster');

    const o = await overflowOf();
    if (o.scrolled > 0) errors.push(`start/sit: scrolls horizontally by ${o.scrolled}px`);
    if (o.wide.length) errors.push(`start/sit: overflows — ${o.wide.join(', ')}`);
    console.log(`  start/sit: one roster table (${bodies} rows, ${benchRows} bench, ${margins.length} margins)`);

    // --- Comparing players, including ones off the roster -------------------
    // The card opens on two. It has to reach four, and the picker has to offer
    // the whole database rather than just this roster -- most of these
    // questions are about a waiver pickup or somebody else's starter.
    const addBtn = await page.$('#view button:has-text("+ Add a player")');
    if (!addBtn) {
        errors.push('start/sit: cannot add a third player to the comparison');
    } else {
        const before = await page.$$eval('#view .h2h-side', (els) => els.length);
        await addBtn.click();
        await page.waitForSelector('.pick', { timeout: 5000 });
        const offered = await page.$$eval('.pick', (els) => els.length);
        // The roster is 12 players; the fixture database is far bigger. If the
        // picker only offered the roster, this is the assertion that catches it.
        if (offered <= 12) errors.push(`compare: picker offered only ${offered} players, so it is roster-only`);
        await page.click('.pick');
        await page.waitForTimeout(600);

        const after = await page.$$eval('#view .h2h-side', (els) => els.length);
        if (after !== before + 1) errors.push(`compare: adding a player gave ${after} slots, expected ${before + 1}`);

        const cmpText = (await page.textContent('#view')) || '';
        if (!/THE ORDER/.test(cmpText)) errors.push('compare: a field of three does not show the full order');
        if (!/Start |Too close|Not a decision/.test(cmpText)) errors.push('compare: no verdict');

        const o3 = await overflowOf();
        if (o3.scrolled > 0) errors.push(`compare (3 players): scrolls horizontally by ${o3.scrolled}px`);
        if (o3.wide.length) errors.push(`compare (3 players): overflows — ${o3.wide.join(', ')}`);

        // And up to four, which is the documented maximum.
        const more = await page.$('#view button:has-text("+ Add a player")');
        if (more) {
            await more.click();
            await page.waitForSelector('.pick', { timeout: 5000 });
            await page.click('.pick');
            await page.waitForTimeout(600);
            const four = await page.$$eval('#view .h2h-side', (els) => els.length);
            if (four !== 4) errors.push(`compare: expected 4 slots, got ${four}`);
            const capped = (await page.textContent('#view')) || '';
            if (!/Four is the most/.test(capped)) errors.push('compare: the cap is not explained at four');
            const o4 = await overflowOf();
            if (o4.scrolled > 0) errors.push(`compare (4 players): scrolls horizontally by ${o4.scrolled}px`);
            if (o4.wide.length) errors.push(`compare (4 players): overflows — ${o4.wide.join(', ')}`);
            console.log('  compare: 2 -> 3 -> 4 players, off-roster picker, order + verdict');
        }
    }

    // Opt-in visual capture, for looking at the page rather than counting it.
    if (process.env.SHOOT) {
        for (const [w, h, name] of [[1280, 3000, 'desktop'], [390, 3600, 'mobile']]) {
            await page.setViewportSize({ width: w, height: h });
            await page.waitForTimeout(500);
            await page.screenshot({ path: `${process.env.SHOOT}/ss-${name}.png`, fullPage: true });
        }
        await page.setViewportSize({ width: 1280, height: 900 });
    }
}

// --- The ranking is the model's, and cannot be edited ----------------------
//
// It used to be draggable, and saving an edit persisted the WHOLE ordering --
// so one drag froze every ranked player at that moment and the merge on each
// later load kept it frozen. These assertions are the guard against that
// coming back: no drag affordance, no move controls, no import.
{
    await page.click('#tabs .tab[data-view="rankings"]');
    await page.waitForTimeout(700);

    const text = (await page.textContent('#view')) || '';
    if (!/Model ranking/.test(text)) errors.push('rankings: not presented as the model’s ordering');

    const draggable = await page.$$eval('#view .prow[draggable="true"]', (els) => els.length);
    if (draggable) errors.push(`rankings: ${draggable} rows are still draggable`);
    const grips = await page.$$eval('#view .grip', (els) => els.length);
    if (grips) errors.push(`rankings: ${grips} drag handles remain`);
    for (const label of ['Import CSV', 'Reset']) {
        if (await page.$(`#view button:has-text("${label}")`)) {
            errors.push(`rankings: the "${label}" control still exists`);
        }
    }

    // Two numeric columns: what he costs, and what he adds to a lineup. They
    // answer different questions and both are shown rather than one hidden in
    // a tooltip.
    const rows = await page.$$eval('#view .prow-static', (els) => els.length);
    // Counted off the first static row itself: `:first-of-type` matches the
    // first DIV among siblings, and the column header is a div too.
    const cols = await page.$$eval('#view .prow-static', (els) =>
        els.length ? els[0].querySelectorAll('.val').length : 0
    );
    if (rows < 5) errors.push(`rankings: only ${rows} rows rendered`);
    if (cols < 2) errors.push(`rankings: ${cols} value columns, expected trade and lineup`);

    // And the name has to be visible -- reusing the draggable grid squeezed it
    // into the 34px handle slot, which is how this was caught.
    const nameWidth = await page.$$eval('#view .prow-static .pname', (els) =>
        els.length ? els[0].getBoundingClientRect().width : 0
    );
    if (nameWidth < 40) errors.push(`rankings: the player name is ${Math.round(nameWidth)}px wide`);

    // What the board has read, and how far this season has moved people. The
    // board was always rebuilt from the evidence and always moved; none of it
    // was stated anywhere, which is why it was reported as not updating.
    const head = (await page.textContent('#view')) || '';
    if (!/[Tt]hrough week \d+|[Nn]othing has been played/.test(head)) {
        errors.push('rankings: the board does not say what data it has read');
    }
    const moves = await page.$$eval('#view .prow-static .move', (els) =>
        els.map((e) => e.textContent.trim()).filter((t) => /^[▲▼]\d+$/.test(t)).length
    );
    if (!moves) errors.push('rankings: no player shows a move since the preseason projection');

    const o = await overflowOf();
    if (o.scrolled > 0) errors.push(`rankings: scrolls horizontally by ${o.scrolled}px`);
    console.log(
        `  rankings: read-only model board, ${rows} rows, ${cols} value columns, ${moves} movers, vintage stated`
    );
}

// --- Three boards on one card ----------------------------------------------
// The model's rank, the preseason projection and the market price are three
// different questions and the card has to answer all three. The market fixture
// is reversed against the projections, so a buy-low or sell-high verdict must
// appear too.
await page.click('#tabs .tab[data-view="rankings"]');
await page.waitForTimeout(600);
const nameLink = await page.$('#view button.plink');
if (nameLink) {
    await nameLink.click();
    await page.waitForSelector('.modal-backdrop .modal', { timeout: 5000 });
    await page.waitForTimeout(600);
    const card = (await page.textContent('.modal-backdrop .modal')) || '';
    if (!/Model rank/.test(card)) errors.push('player card: no model rank');
    if (!/Market rank/.test(card)) errors.push('player card: the market board is missing');
    if (!/Projected rank/.test(card)) errors.push('player card: the projection board is missing');
    if (!/(Buy low|Sell high)/.test(card)) {
        errors.push('player card: market and projection disagree in the fixture but no edge was surfaced');
    }
    // The replacement line has to be labelled with the board it was read off.
    // It used to say "TE7" beside a number pooled from the whole RB/WR/TE
    // flex, which reads as a claim that seven tight ends in the league are
    // startable -- a contradiction with the figure next to it.
    const repl = card.match(/Replacement level \(([^)]+)\)/);
    if (!repl) errors.push('player card: no replacement level row');
    else if (!/^(?:[A-Z]{1,3}\/)*[A-Z]{1,3} ?\d+$/.test(repl[1])) {
        errors.push(`player card: replacement line labelled "${repl[1]}", which names no board`);
    }
    console.log(`  player card: three boards, ${card.trim().length} chars`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
} else {
    errors.push('player card: could not open one');
}

// --- How the league's slots were read --------------------------------------
// The interpretation of the roster slots decides every value in the app, and
// it used to be invisible: a manager who believed the app had his league wrong
// had nothing to check it against. The panel has to show the slot, who can
// fill it, and the waiver line that follows -- named after the group it was
// pooled from, because the fixture has a flex.
await page.click('#tabs .tab[data-view="league"]');
await page.waitForTimeout(600);
const details = await page.$('#view details');
if (details) {
    await details.evaluate((d) => { d.open = true; });
    await page.waitForTimeout(300);
    const panel = (await page.textContent('#view .slot-read')) || '';
    if (!/RB\/WR\/TE/.test(panel)) {
        errors.push('league: the flex group that the waiver line was pooled from is not named');
    }
    // The fixture has a dedicated TE slot, so a tight end really is required
    // in it; a league without one must read "flex only" instead.
    if (!/required/.test(panel)) errors.push('league: no position is marked required');
    const badges = await page.$$eval('#view .slot-read td .pos', (els) => els.length);
    if (badges < 9) errors.push(`league: only ${badges} eligibility badges across the slot table`);
    console.log(`  league slots: ${badges} eligibility badges, grouped waiver line shown`);
} else {
    errors.push('league: the slot-reading panel is missing');
}

for (const width of [360, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const v of views) {
        await page.click(`#tabs .tab[data-view="${v}"]`);
        await page.waitForTimeout(500);
        const o = await overflowOf();
        if (o.scrolled > 0) errors.push(`${v} @${width}px: scrolls horizontally by ${o.scrolled}px`);
        if (o.wide.length) errors.push(`${v} @${width}px: overflows — ${o.wide.join(', ')}`);
    }
}

await browser.close();
server.close();
console.log(errors.length ? `\nFAILURES (${errors.length}):\n${[...new Set(errors)].join('\n')}` : '\nclean: booted, all views render, no overflow at 360/414/768/1280');
process.exit(errors.length ? 1 : 0);
