import test from 'node:test';
import assert from 'node:assert/strict';

import { parseScoreboard } from '../js/odds.js';

// --- Deeper Vegas ----------------------------------------------------------

test('american odds convert to probability', async () => {
    const { americanToProbability, devig, parseLine, gameScript } = await import('../js/odds.js');
    assert.ok(Math.abs(americanToProbability('+100') - 0.5) < 1e-9);
    assert.ok(Math.abs(americanToProbability('-200') - 0.6667) < 0.001);
    assert.equal(americanToProbability('nonsense'), null);

    // Removing the vig makes the two sides sum to exactly one.
    const d = devig('-180', '+150');
    assert.ok(Math.abs(d.a + d.b - 1) < 1e-9);
    assert.ok(d.vig > 0, 'the book takes a margin');
    assert.ok(d.a > d.b, 'the favorite is more likely');

    assert.equal(parseLine('o37.5'), 37.5);
    assert.equal(parseLine('+3.5'), 3.5);
    assert.equal(parseLine('-1.5'), -1.5);
});

test('game script reads the spread the way a manager does', async () => {
    const { gameScript } = await import('../js/odds.js');
    assert.equal(gameScript({ ownSpread: -13 }).kind, 'heavy-favorite');
    assert.equal(gameScript({ ownSpread: 13 }).kind, 'heavy-underdog');
    assert.equal(gameScript({ ownSpread: -1 }).kind, 'even');
    assert.match(gameScript({ ownSpread: 13 }).text, /throwing/);
});

test('opening and closing lines produce movement, and a flipped favorite is flagged', async () => {
    const { parseScoreboard, buildTeamContext, describeMovement } = await import('../js/odds.js');
    const games = parseScoreboard({
        events: [{
            id: '1', shortName: 'CHI @ CIN', date: '2026-10-04T17:00Z',
            competitions: [{
                neutralSite: false,
                venue: { fullName: 'Paycor Stadium', indoor: false },
                competitors: [
                    { homeAway: 'home', team: { abbreviation: 'CIN' } },
                    { homeAway: 'away', team: { abbreviation: 'CHI' } },
                ],
                odds: [{
                    overUnder: 37.5, spread: 3.5, details: 'CHI -3.5',
                    provider: { name: 'DraftKings' },
                    awayTeamOdds: { favorite: true, favoriteAtOpen: false },
                    homeTeamOdds: { favorite: false, favoriteAtOpen: true },
                    pointSpread: { home: { open: { line: '-1.5' }, close: { line: '+3.5' } } },
                    total: { over: { open: { line: 'o40.5' }, close: { line: 'o37.5' } } },
                    moneyline: { home: { close: { odds: '+150' } }, away: { close: { odds: '-180' } } },
                }],
            }],
        }],
    });
    const g = games[0];
    assert.equal(g.movement.total.change, -3, 'the total dropped three points');
    assert.equal(g.movement.spread.change, 5, 'the home spread moved five points');
    assert.equal(g.favoriteFlipped, true);
    assert.equal(g.indoor, false);
    assert.ok(g.winProbability.CHI > g.winProbability.CIN);

    const ctx = buildTeamContext(games).get('CHI');
    assert.equal(ctx.isFavorite, true);
    assert.equal(ctx.ownSpread, -3.5, 'a favorite is quoted negative');
    const notes = describeMovement(ctx);
    assert.ok(notes.some((n) => n.kind === 'total'));
    assert.ok(notes.some((n) => n.kind === 'flip'));
});

test('a stable line reports no movement', async () => {
    const { describeMovement } = await import('../js/odds.js');
    assert.deepEqual(
        describeMovement({ movement: { total: { open: 44, close: 44.5, change: 0.5 }, spread: null } }),
        []
    );
});
