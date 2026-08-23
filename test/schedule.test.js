import test from 'node:test';
import assert from 'node:assert/strict';

import { extractByes, isOnBye, byeConflicts } from '../js/schedule.js';
import { parseScoreboard } from '../js/odds.js';
import {
    playerUsageSeries, usageTrend, touchdownDependence, nonTdPointsPerGame,
    buyLowScore, sellHighScore, scanUsage, describeBuyLow, describeSellHigh,
} from '../js/usage.js';
import { normalizeScoring } from '../js/league.js';
import { encodeOffer, decodeOffer, offerUrl } from '../js/share.js';

// --- Bye weeks -------------------------------------------------------------

test('byes come out of the payload the app already downloads', () => {
    const payload = { week: { number: 5, teamsOnBye: [{ abbreviation: 'ATL' }, { abbreviation: 'CHI' }] }, events: [] };
    assert.deepEqual(extractByes(payload), ['ATL', 'CHI']);
});

test('ESPN abbreviations are normalized to Sleeper’s', () => {
    assert.deepEqual(extractByes({ week: { teamsOnBye: [{ abbreviation: 'WSH' }] } }), ['WAS']);
});

test('a week with no byes yields none, not a crash', () => {
    assert.deepEqual(extractByes({ week: { number: 1 } }), []);
    assert.deepEqual(extractByes({}), []);
    assert.deepEqual(extractByes(null), []);
});

test('parseScoreboard now surfaces the bye list alongside games', () => {
    const games = parseScoreboard({
        week: { teamsOnBye: [{ abbreviation: 'GB' }] },
        events: [{
            id: '1', shortName: 'KC @ BUF',
            competitions: [{
                competitors: [
                    { homeAway: 'home', team: { abbreviation: 'BUF' } },
                    { homeAway: 'away', team: { abbreviation: 'KC' } },
                ],
            }],
        }],
    });
    assert.equal(games.length, 1);
    assert.deepEqual(games.teamsOnBye, ['GB']);
});

test('isOnBye matches team and week', () => {
    const byes = new Map([['GB', 5]]);
    assert.equal(isOnBye(byes, 'GB', 5), true);
    assert.equal(isOnBye(byes, 'GB', 6), false);
    assert.equal(isOnBye(byes, 'KC', 5), false);
});

test('bye conflicts find the weeks that actually hurt', () => {
    const byes = new Map([['GB', 7], ['KC', 7], ['SF', 7], ['BUF', 9]]);
    const players = [
        { id: 'a', name: 'A', team: 'GB' }, { id: 'b', name: 'B', team: 'KC' },
        { id: 'c', name: 'C', team: 'SF' }, { id: 'd', name: 'D', team: 'BUF' },
    ];
    const hits = byeConflicts(players, byes, { minPlayers: 2 });
    assert.equal(hits.length, 1, 'only week 7 stacks up');
    assert.equal(hits[0].week, 7);
    assert.equal(hits[0].players.length, 3);
});

test('bye conflicts ignore weeks already gone', () => {
    const byes = new Map([['GB', 3], ['KC', 3]]);
    const players = [{ id: 'a', team: 'GB' }, { id: 'b', team: 'KC' }];
    assert.equal(byeConflicts(players, byes, { fromWeek: 8, minPlayers: 2 }).length, 0);
});

// --- Usage signals ---------------------------------------------------------

const scoring = normalizeScoring({ rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6 });

/** A receiver whose role grows every week while his points stay flat. */
function risingRole() {
    const weeks = new Map();
    for (let w = 1; w <= 8; w++) {
        weeks.set(w, [{
            player_id: 'wr', player: { position: 'WR' },
            stats: {
                off_snp: 20 + w * 5, tm_off_snp: 70,
                rec_tgt: 2 + w * 0.8, rec: 2 + w * 0.5, rec_yd: 60, rec_rz_tgt: w * 0.4,
                pts_half_ppr: 10,
            },
        }]);
    }
    return weeks;
}

test('usage series reads snaps, targets and red-zone work', () => {
    const s = playerUsageSeries(risingRole(), 'wr', scoring);
    assert.equal(s.length, 8);
    assert.ok(s[0].snapShare < s[7].snapShare, 'snap share climbs');
    assert.ok(s[7].snapShare > 0.8);
});

test('a rising role with flat points is a buy-low', () => {
    const s = playerUsageSeries(risingRole(), 'wr', scoring);
    const t = usageTrend(s);
    assert.ok(t.snapShare.change > 0.15, 'snap share is up sharply');
    assert.ok(buyLowScore(t) > 2, `buy-low score ${buyLowScore(t)}`);
    assert.match(describeBuyLow({ trend: t }), /snap share up/i);
});

test('a player whose usage and points both rise is not a buy-low', () => {
    const weeks = new Map();
    for (let w = 1; w <= 8; w++) {
        weeks.set(w, [{
            player_id: 'wr', player: { position: 'WR' },
            stats: { off_snp: 20 + w * 5, tm_off_snp: 70, rec_tgt: 2 + w, rec: 2 + w, rec_yd: 30 + w * 20, pts_half_ppr: 1 },
        }]);
    }
    const t = usageTrend(playerUsageSeries(weeks, 'wr', scoring));
    const rising = buyLowScore(t);
    const flat = buyLowScore(usageTrend(playerUsageSeries(risingRole(), 'wr', scoring)));
    assert.ok(rising < flat, 'points catching up removes the edge');
});

test('touchdown dependence isolates the unsustainable part of scoring', () => {
    // Six games, modest yardage, four touchdowns.
    const weeks = new Map();
    for (let w = 1; w <= 6; w++) {
        weeks.set(w, [{
            player_id: 'wr', player: { position: 'WR' },
            stats: { rec: 3, rec_yd: 30, rec_td: w <= 4 ? 1 : 0, off_snp: 40, tm_off_snp: 70, pts_half_ppr: 1 },
        }]);
    }
    const s = playerUsageSeries(weeks, 'wr', scoring);
    const d = touchdownDependence(s, scoring);
    assert.equal(d.tds, 4);
    assert.ok(d.share > 0.35, `TD share ${d.share}`);
    const nonTd = nonTdPointsPerGame(s, scoring);
    assert.ok(nonTd < d.pointsPerGame, 'stripping TDs lowers the per-game figure');
    assert.ok(sellHighScore(d, null) > 0);
    assert.match(describeSellHigh({ dependence: d, nonTdPpg: nonTd, trend: null }), /touchdowns/);
});

test('a volume-driven player is not a sell-high', () => {
    const weeks = new Map();
    for (let w = 1; w <= 6; w++) {
        weeks.set(w, [{
            player_id: 'wr', player: { position: 'WR' },
            stats: { rec: 8, rec_yd: 110, off_snp: 55, tm_off_snp: 70, pts_half_ppr: 1 },
        }]);
    }
    const s = playerUsageSeries(weeks, 'wr', scoring);
    const d = touchdownDependence(s, scoring);
    assert.equal(d.share, 0);
    assert.ok(sellHighScore(d, null) < 0, 'no touchdown reliance, nothing to sell');
});

test('scanUsage skips players with too little history', () => {
    const weeks = new Map([[1, [{ player_id: 'x', player: { position: 'WR' }, stats: { rec: 3, pts_half_ppr: 1 } }]]]);
    const rows = scanUsage({ weeklyStats: weeks, players: [{ id: 'x', pos: 'WR' }], scoring });
    assert.equal(rows.length, 0);
});

// --- Shareable trade links -------------------------------------------------

test('a trade round-trips through a URL hash', () => {
    const offer = { aRoster: 3, aSend: ['111', '222'], bRoster: 7, bSend: ['333'] };
    const decoded = decodeOffer(encodeOffer(offer));
    assert.deepEqual(decoded, offer);
});

test('offerUrl builds an absolute, pasteable link', () => {
    const url = offerUrl({ aRoster: 1, aSend: ['9'], bRoster: 2, bSend: ['8'] }, 'https://example.com/app/');
    assert.equal(url, 'https://example.com/app/#/trade?a=1&as=9&b=2&bs=8');
});

test('a malformed hash decodes to nothing rather than throwing', () => {
    assert.equal(decodeOffer('#/trade'), null);
    assert.equal(decodeOffer(''), null);
    assert.equal(decodeOffer('#/trade?a=&b='), null);
});

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
