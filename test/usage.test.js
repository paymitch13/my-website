import test from 'node:test';
import assert from 'node:assert/strict';

import {
    playerUsageSeries, usageTrend, touchdownDependence, nonTdPointsPerGame,
    buyLowScore, sellHighScore, scanUsage, describeBuyLow, describeSellHigh,
} from '../js/usage.js';
import { normalizeScoring } from '../js/league.js';

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
