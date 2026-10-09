// The deployed app in a real browser, against real week-5 data, as a visitor
// with no league connected.
//
// The page is served from this checkout, which is the commit GitHub Pages is
// serving. Its outbound calls are fulfilled from Node's fetch rather than the
// browser's, because the sandbox re-terminates TLS at a proxy whose CA this
// Chromium build does not consult -- and weakening the browser's verification
// to get around that is not worth a test.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';

const ROOT = '/home/user/my-website';
const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    try {
        const body = await readFile(join(ROOT, rel));
        res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404).end('not found');
    }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 180)}`);
});

const asked = [];
let upstreamFailures = 0;
await page.route('**', async (route) => {
    const url = route.request().url();
    if (url.includes(`127.0.0.1:${port}`) || url.includes(`localhost:${port}`)) return route.continue();
    asked.push(url);
    try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        const body = Buffer.from(await res.arrayBuffer());
        return route.fulfill({
            status: res.status,
            headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
            body,
        });
    } catch (e) {
        upstreamFailures += 1;
        return route.fulfill({ status: 502, contentType: 'application/json', body: '[]' });
    }
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.querySelector('#view .skel'), { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(20000);

console.log(`live upstreams the page asked for (${asked.length} requests, ${upstreamFailures} failed):`);
for (const [label, re] of [
    ['players database', /players\/nfl(\?|$)/],
    ['season projections', /projections\/nfl\/\d+\?/],
    ['season results', /stats\/nfl\/\d+\?/],
    ['market prices', /fantasycalc/i],
    ['nfl state', /state\/nfl/],
]) {
    const hits = asked.filter((u) => re.test(u));
    console.log(`  ${label.padEnd(20)} ${hits.length ? `yes (${hits.length})` : 'NO'}`);
}

await page.click('#tabs .tab[data-view="rankings"]');
await page.waitForTimeout(4000);

const text = (await page.textContent('#view')) || '';
const vintage = text.match(/(Through week|Nothing has been played)[^|]{0,400}?(backtesting\.|only\.|week 1\.)/);
console.log(`\nthe vintage line the live board prints:`);
console.log(`  ${vintage ? vintage[0].replace(/(.{90}\s)/g, '$1\n  ') : 'MISSING'}`);

const rows = await page.$$eval('#view .prow-static', (els) =>
    els.slice(0, 15).map((e) => ({
        rank: e.querySelector('.rank')?.textContent?.trim() || '',
        name: e.querySelector('.pname')?.textContent?.trim() || '',
        trade: e.querySelectorAll('.val')[0]?.textContent?.trim() || '',
        move: e.querySelector('.move')?.textContent?.trim() || '',
        title: e.querySelector('.move')?.getAttribute('title') || '',
    }))
);
console.log(`\ntop of the live RB board:`);
for (const r of rows) {
    console.log(`  ${r.rank.padEnd(5)} ${r.name.slice(0, 20).padEnd(21)} ${r.trade.padStart(7)}  ${r.move.padStart(4)}   ${r.title.slice(0, 56)}`);
}

const movers = await page.$$eval('#view .prow-static .move', (els) =>
    els.map((e) => e.textContent.trim()).filter((t) => /^[▲▼]\d+$/.test(t)).length
);
const total = await page.$$eval('#view .prow-static', (els) => els.length);
console.log(`\n${movers} of ${total} rows show a move since the preseason.`);

console.log(errors.length ? `\nERRORS:\n${[...new Set(errors)].slice(0, 6).join('\n')}` : '\nno page or console errors');
await browser.close();
server.close();
