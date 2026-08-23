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
            position: pos, fantasy_positions: [pos], team: 'KC', age: 25,
            injury_status: null, active: true, search_rank: n,
        };
        const ppg = 22 - i * 0.35;
        projections.push({
            player_id: id, player: { position: pos, team: 'KC' },
            stats: { pts_half_ppr: Math.max(2, ppg) * 17, rush_yd: Math.max(10, ppg) * 100, gp: 17 },
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
    [/site\.api\.espn/, () => json({ events: [], week: {} })],
    [/open-meteo/, () => json({ hourly: {} })],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.route('**', (route) => {
    const u = route.request().url();
    if (u.includes(`localhost:${port}`) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    for (const [re, make] of fixtures) if (re.test(u)) return route.fulfill(make());
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
