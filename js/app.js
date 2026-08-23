// Bootstrap, routing and the Sleeper connection flow.

import * as store from './store.js';
import * as data from './data.js';
import * as api from './sleeper.js';
import { normalizeLeague, defaultRosterPositions, scoringLabel } from './league.js';
import { createValuationContext } from './valuation.js';
import { buildSeedKeys, mergeOrder, seedOrder, toRankMap } from './rankings.js';
import { el, toast, modal, emptyState, skeleton, banner, spinnerRow, onPlayerClick } from './ui.js';
import { openPlayerCard } from './views/player.js';
import { loadSeasonTransactions, tradesOnly, newTradesSince } from './transactions.js';

import renderTrade from './views/trade.js';
import renderPower from './views/power.js';
import renderRankings from './views/rankings.js';
import renderLeague from './views/league.js';
import renderNews from './views/news.js';
import renderStartSit from './views/startsit.js';
import renderFinder from './views/finder.js';
import renderVegas from './views/vegas.js';
import { decodeOffer } from './share.js';
import { fetchByeWeeks } from './schedule.js';
import { createTradeValueScale } from './tradevalue.js';
import { valuePlayer } from './valuation.js';

const VIEWS = {
    trade: { render: renderTrade, title: 'Trade Calculator' },
    finder: { render: renderFinder, title: 'Trade Finder' },
    startsit: { render: renderStartSit, title: 'Start/Sit' },
    vegas: { render: renderVegas, title: 'Vegas' },
    power: { render: renderPower, title: 'Power Rankings' },
    rankings: { render: renderRankings, title: 'My Rankings' },
    league: { render: renderLeague, title: 'League' },
    news: { render: renderNews, title: 'News & Live' },
};

/** Single shared app context handed to every view. */
export const app = {
    userId: store.state.userId || null,
    players: null,
    playersAt: null,
    projections: null,
    actuals: null,
    odds: null,
    byeWeeks: new Map(),
    powerOdds: null,
    pendingOffer: null,
    transactions: [],
    season: null,
    league: null,
    order: {},
    rankings: new Map(),
    ctx: null,
    tradeValue: (v) => Math.round(v),
    view: 'trade',
    busy: false,

    /**
     * Recompute the derived rankings + valuation context. Called after any
     * board edit and after a league loads, since valuation depends on both.
     */
    rebuild() {
        if (!this.players) return;
        const cfg = this.league?.cfg || normalizeLeague(null, { rosterPositions: defaultRosterPositions() });

        // The seed order depends on league scoring, so it has to be rebuilt
        // whenever the league changes -- a player's projected rank is not the
        // same in half PPR as it is in superflex.
        const seedKeys = buildSeedKeys(this.players, {
            projections: this.projections,
            scoring: cfg.scoring,
        });
        this.order = Object.keys(store.state.order || {}).length
            ? mergeOrder(store.state.order, this.players, { seedKeys })
            : seedOrder(this.players, { seedKeys });
        this.rankings = toRankMap(this.order);

        this.ctx = createValuationContext(cfg, {
            week: this.league?.currentWeek || 1,
            weeksLeft: Math.max(1, this.league?.weeksLeft ?? 14),
            projections: this.projections,
            actuals: this.actuals,
        });
        this.cfg = cfg;

        // One market scale for the whole league, anchored to the most valuable
        // player on the board, so every view quotes the same numbers.
        const raw = [];
        for (const pos of Object.keys(this.order)) {
            (this.order[pos] || []).forEach((id, i) => {
                const player = this.players[id];
                if (player) raw.push(valuePlayer(player, i + 1, this.ctx).value);
            });
        }
        this.tradeValue = createTradeValueScale(raw);
    },

    /** Persist the current board. */
    saveOrder(order) {
        this.order = order;
        store.state.order = order;
        store.save();
        this.rankings = toRankMap(order);
    },

    render() {
        renderView(this.view);
    },
};

// --- Routing ---------------------------------------------------------------

function currentViewFromHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const key = raw.split('?')[0];
    // A shared trade link carries the offer in the hash; stash it for the view.
    const offer = decodeOffer(location.hash || '');
    app.pendingOffer = offer;
    return VIEWS[key] ? key : 'trade';
}

function renderView(key) {
    app.view = key;
    const host = document.getElementById('view');
    for (const btn of document.querySelectorAll('#tabs .tab')) {
        const on = btn.dataset.view === key;
        btn.setAttribute('aria-selected', String(on));
        if (on) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    app.updateTabFade?.();

    host.replaceChildren();
    try {
        host.append(VIEWS[key].render(app));
    } catch (err) {
        console.error(`View "${key}" failed to render`, err);
        host.append(
            emptyState('⚠️', 'Something broke rendering this view', err.message, el('button', { class: 'btn', onclick: () => renderView(key) }, 'Try again'))
        );
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
}

// --- League connection -----------------------------------------------------

function updateChip() {
    const label = document.getElementById('league-chip-label');
    const dot = document.querySelector('#league-chip .dot');
    if (app.league) {
        label.textContent = app.league.cfg.name;
        dot.classList.remove('off');
    } else {
        label.textContent = 'Connect Sleeper';
        dot.classList.add('off');
    }
}

export async function connectLeague(leagueId, { silent = false } = {}) {
    if (!app.players) return;
    const host = document.getElementById('view');
    if (!silent) {
        host.replaceChildren(el('div', { class: 'page-head' }, el('h1', {}, 'Syncing league…')), skeleton(5, 60));
    }
    try {
        app.league = await data.loadLeague(leagueId, app.players, {
            onProgress: (msg) => !silent && host.querySelector('h1') && (host.querySelector('h1').textContent = msg),
        });
        store.update({ leagueId, season: app.league.raw.season });

        // Once a real league is attached we know the season and the week, so we
        // can blend in what players have actually done and pull this week's
        // game lines.
        const teamsById = new Map(app.league.teams.map((t) => [t.rosterId, t]));
        const [actuals, odds, transactions, byeWeeks] = await Promise.all([
            app.league.lastPlayed > 0 ? data.loadSeasonStats(app.league.raw.season) : Promise.resolve(null),
            data.loadOdds(app.league.currentWeek, app.league.raw.season),
            loadSeasonTransactions(leagueId, app.league.currentWeek, { teamsById, players: app.players }).catch(() => []),
            fetchByeWeeks(app.league.raw.season).catch(() => new Map()),
        ]);
        app.actuals = actuals;
        app.odds = odds;
        app.transactions = transactions;
        app.byeWeeks = byeWeeks;

        app.rebuild();
        updateChip();
        if (!silent) toast(`Synced ${app.league.cfg.name}`, 'good');
        watchForTrades();
        app.render();
    } catch (err) {
        console.error(err);
        app.league = null;
        updateChip();
        app.rebuild();
        toast(err.message || 'Could not load that league.', 'bad');
        app.render();
    }
}

/**
 * Watch for trades accepted in Sleeper while the app is open. Sleeper has no
 * push channel, so this polls -- infrequently, because a trade being a minute
 * late costs nothing.
 */
const TRADE_POLL_MS = 90 * 1000;
let tradePoll = null;

export function watchForTrades() {
    clearInterval(tradePoll);
    if (!app.league) return;
    tradePoll = setInterval(async () => {
        if (!app.league) return;
        try {
            const teamsById = new Map(app.league.teams.map((t) => [t.rosterId, t]));
            const fresh = await loadSeasonTransactions(app.league.cfg.id, app.league.currentWeek, {
                teamsById,
                players: app.players,
                force: true,
            });
            const seen = tradesOnly(app.transactions).map((t) => t.id);
            const added = newTradesSince(fresh, seen);
            app.transactions = fresh;
            if (added.length) {
                for (const t of added) {
                    toast(`New trade: ${t.sides.map((s) => s.name).join(' ↔ ')}`, 'good');
                }
                // Rosters have changed, so anything derived from them is stale:
                // power snapshots, finder results and the open view alike.
                app.powerOdds = null;
                await connectLeague(app.league.cfg.id, { silent: true });
                app.render();
            }
        } catch {
            /* polling is best-effort */
        }
    }, TRADE_POLL_MS);
}

export function disconnectLeague() {
    clearInterval(tradePoll);
    app.league = null;
    store.update({ leagueId: null });
    app.rebuild();
    updateChip();
    toast('Disconnected from the league.');
    app.render();
}

/** Username -> season -> league picker. */
export async function openSyncModal() {
    const state = await api.getState().catch(() => ({ season: new Date().getFullYear() }));
    const seasons = [];
    const thisSeason = Number(state.season) || new Date().getFullYear();
    for (let y = thisSeason; y >= thisSeason - 4; y--) seasons.push(String(y));

    const username = el('input', {
        type: 'text',
        placeholder: 'Your Sleeper username',
        value: store.state.username || '',
        autocomplete: 'username',
    });
    const season = el('select', {}, ...seasons.map((s) => el('option', { value: s }, s)));
    if (store.state.season && seasons.includes(String(store.state.season))) season.value = String(store.state.season);

    const results = el('div', { style: 'margin-top:16px' });
    const go = el('button', { class: 'btn btn-primary', onclick: search }, 'Find my leagues');

    async function search() {
        const name = username.value.trim();
        if (!name) {
            toast('Enter your Sleeper username first.', 'bad');
            return;
        }
        go.disabled = true;
        results.replaceChildren(spinnerRow('Looking up leagues…'));
        try {
            const { user, leagues } = await data.findLeagues(name, season.value);
            app.userId = user.user_id;
            store.update({ username: name, season: season.value, userId: user.user_id });
            if (!leagues.length) {
                results.replaceChildren(
                    banner(`${user.display_name} has no NFL leagues in ${season.value}. Try another season.`, 'warn')
                );
                return;
            }
            results.replaceChildren(
                el('div', { class: 'small muted', style: 'margin-bottom:8px' }, `${leagues.length} league${leagues.length === 1 ? '' : 's'} for ${user.display_name}`),
                el(
                    'div',
                    { class: 'pick-list' },
                    ...leagues.map((lg) => {
                        const cfg = normalizeLeague(lg);
                        return el(
                            'button',
                            {
                                class: 'pick',
                                type: 'button',
                                onclick: () => {
                                    m.close();
                                    connectLeague(lg.league_id);
                                },
                            },
                            el(
                                'div',
                                { style: 'min-width:0' },
                                el('div', { style: 'font-weight:600' }, cfg.name),
                                el(
                                    'div',
                                    { class: 'pmeta' },
                                    `${cfg.teams} teams · ${scoringLabel(cfg.scoring)} · ${cfg.format}${cfg.superflex ? ' · superflex' : ''}`
                                )
                            )
                        );
                    })
                )
            );
        } catch (err) {
            results.replaceChildren(banner(err.message || 'Lookup failed.', 'bad'));
        } finally {
            go.disabled = false;
        }
    }

    username.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') search();
    });

    const m = modal({
        title: 'Connect a Sleeper league',
        body: el(
            'div',
            {},
            el(
                'p',
                { class: 'muted small' },
                'Sleeper’s API is public and read-only. Nothing is sent anywhere except Sleeper, and no password is ever involved.'
            ),
            el(
                'div',
                { class: 'grid grid-2' },
                el('div', { class: 'field' }, el('label', {}, 'Username'), username),
                el('div', { class: 'field' }, el('label', {}, 'Season'), season)
            ),
            el('div', { style: 'margin-top:14px' }, go),
            app.league
                ? el(
                      'div',
                      { style: 'margin-top:20px;padding-top:16px;border-top:1px solid var(--line)' },
                      el('div', { class: 'row' },
                          el('span', { class: 'small muted grow' }, `Currently synced: ${app.league.cfg.name}`),
                          el('button', { class: 'btn btn-sm btn-danger', onclick: () => { m.close(); disconnectLeague(); } }, 'Disconnect')
                      )
                  )
                : null,
            results
        ),
        width: '560px',
    });

    setTimeout(() => username.focus(), 30);
}

// --- Boot ------------------------------------------------------------------

async function boot() {
    const host = document.getElementById('view');

    document.getElementById('tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (!btn) return;
        location.hash = `#/${btn.dataset.view}`;
    });
    document.getElementById('league-chip').addEventListener('click', openSyncModal);
    onPlayerClick((player) => openPlayerCard(app, player));
    window.addEventListener('hashchange', () => renderView(currentViewFromHash()));

    // Mark the tab strip when it has content scrolled out of view, and keep the
    // selected tab visible after navigation.
    const tabsEl = document.getElementById('tabs');
    const wrap = document.getElementById('tabs-wrap');
    const updateFade = () => {
        const more = tabsEl.scrollWidth - tabsEl.clientWidth - tabsEl.scrollLeft;
        wrap.classList.toggle('is-scrollable', more > 4);
    };
    tabsEl.addEventListener('scroll', updateFade, { passive: true });
    window.addEventListener('resize', updateFade);
    app.updateTabFade = updateFade;
    setTimeout(updateFade, 0);

    try {
        const nflState = await api.getState().catch(() => null);
        app.season = nflState?.season || String(new Date().getFullYear());
        app.nflState = nflState;

        const loaded = await data.loadPlayers({
            onProgress: (msg) => {
                const h = host.querySelector('h1');
                if (h) h.textContent = msg;
            },
        });
        app.players = loaded.players;
        app.playersAt = loaded.at;
    } catch (err) {
        console.error(err);
        host.replaceChildren(
            emptyState(
                '📡',
                'Could not reach Sleeper',
                'The player database could not be downloaded, so nothing can be valued yet. Check your connection and reload.',
                el('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Reload')
            )
        );
        return;
    }

    // Projections drive every value in the app; load them before first paint so
    // nothing is ever rendered from the fallback model and then silently
    // replaced a second later.
    const season = String(app.season || new Date().getFullYear());
    const projResult = await data.loadProjections(season, {
        onProgress: (msg) => {
            const h = host.querySelector('h1');
            if (h) h.textContent = msg;
        },
    });
    app.projections = projResult.projections;
    if (!app.projections) {
        console.warn('Projections unavailable, falling back to the modeled curve', projResult.error);
    }

    app.rebuild();
    updateChip();

    if (store.state.leagueId) {
        renderView(currentViewFromHash());
        await connectLeague(store.state.leagueId, { silent: true });
    } else {
        renderView(currentViewFromHash());
    }
}

boot();
