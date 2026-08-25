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
    [/stats\/nfl/, () => json([])],
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
    [/sports\.core\.api\.espn.*propBets/, () => json({ count: 0, items: [] })],
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
    if (!/Bench/.test(text)) errors.push('start/sit: the bench is not rendered');
    if (!/Every decision/.test(text)) errors.push('start/sit: per-slot decisions are missing');
    if (!/Head to head/.test(text)) errors.push('start/sit: no head-to-head comparison');

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
    console.log(`  start/sit: bench + decisions + head-to-head, ${text.trim().length} chars`);

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

// --- Three boards on one card ----------------------------------------------
// Your rank, the projection and the market price are three different questions
// and the card has to answer all three. The market fixture is reversed against
// the projections, so a buy-low or sell-high verdict must appear too.
await page.click('#tabs .tab[data-view="rankings"]');
await page.waitForTimeout(600);
const nameLink = await page.$('#view button.plink');
if (nameLink) {
    await nameLink.click();
    await page.waitForSelector('.modal-backdrop .modal', { timeout: 5000 });
    await page.waitForTimeout(600);
    const card = (await page.textContent('.modal-backdrop .modal')) || '';
    if (!/Your rank/.test(card)) errors.push('player card: no "your rank"');
    if (!/Market rank/.test(card)) errors.push('player card: the market board is missing');
    if (!/Projected rank/.test(card)) errors.push('player card: the projection board is missing');
    if (!/(Buy low|Sell high)/.test(card)) {
        errors.push('player card: market and projection disagree in the fixture but no edge was surfaced');
    }
    console.log(`  player card: three boards, ${card.trim().length} chars`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
} else {
    errors.push('player card: could not open one');
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
