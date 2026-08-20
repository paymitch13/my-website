// News & Live — what changed around the league, and the scoreboard as it moves.

import { injuryReport, trendingReport, transactionFeed, buildFeed, diffScoreboard } from '../news.js';
import { loadScoreboard } from '../data.js';
import * as store from '../store.js';
import { openSyncModal } from '../app.js';
import {
    el, emptyState, headshot, playerCell, playerLink, posBadge, round, sortBy, spinnerRow, tag, tile, toast,
} from '../ui.js';

const REFRESH_MS = 45000;

export default function renderNews(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'News & Live'),
            el(
                'p',
                { class: 'sub' },
                'Injuries, waiver momentum and league moves — filtered to the players who matter in your league, ',
                'and scored by how many points per week they actually cost the roster holding them.'
            )
        )
    );

    if (!app.league) {
        root.append(
            emptyState(
                '📰',
                'Connect a league',
                'The feed is built from your league’s rosters, transactions and live matchups.',
                el('button', { class: 'btn btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        return root;
    }

    const scoreHost = el('div', {});
    const feedHost = el('div', {});
    root.append(scoreHost, feedHost);

    let timer = null;
    let previousBoard = null;

    // The view is replaced wholesale on navigation, so hang cleanup off the
    // node being removed from the document.
    const observer = new MutationObserver(() => {
        if (!root.isConnected) {
            clearInterval(timer);
            observer.disconnect();
        }
    });
    observer.observe(document.getElementById('view'), { childList: true });

    async function paintScoreboard({ announce = false } = {}) {
        try {
            const board = await loadScoreboard(app.league.cfg.id, app.league.currentWeek, app.league.teams, app.players);
            if (announce && previousBoard) {
                const changes = diffScoreboard(previousBoard, board);
                if (changes.length) {
                    const top = changes[0];
                    toast(`${top.name} +${top.delta} pts`, 'good');
                }
            }
            previousBoard = board;
            scoreHost.replaceChildren(scoreboardSection(app, board));
        } catch (err) {
            scoreHost.replaceChildren(
                el('div', { class: 'card' }, el('p', { class: 'muted' }, `Live scoring unavailable: ${err.message}`))
            );
        }
    }

    function scoreboardSection(app, board) {
        const wrap = el('div', {});
        const auto = store.state.settings.autoRefreshLive;

        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, `Week ${app.league.currentWeek} scoreboard`),
                el('span', { class: 'hint grow' }, auto ? `refreshing every ${REFRESH_MS / 1000}s` : 'auto-refresh off'),
                el(
                    'button',
                    {
                        class: 'btn btn-sm',
                        'aria-pressed': String(auto),
                        onclick: (e) => {
                            const next = !store.state.settings.autoRefreshLive;
                            store.state.settings.autoRefreshLive = next;
                            store.save();
                            setupTimer();
                            paintScoreboard();
                        },
                    },
                    auto ? 'Pause' : 'Auto-refresh'
                ),
                el('button', { class: 'btn btn-sm', onclick: () => paintScoreboard() }, 'Refresh')
            )
        );

        if (!board.length) {
            wrap.append(el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No matchups posted for this week yet.')));
            return wrap;
        }

        const notStarted = board.every((m) => m.sides.every((s) => !s.points));
        if (notStarted) {
            wrap.append(
                el('div', { class: 'banner' }, 'Nothing has kicked off yet this week — scores will start moving once games begin.')
            );
        }

        const grid = el('div', { class: 'grid grid-2' });
        for (const m of board) {
            const sides = sortBy(m.sides, (s) => s.points, -1);
            const lead = sides[0];
            grid.append(
                el(
                    'div',
                    { class: 'matchup' },
                    ...sides.map((s, i) =>
                        el(
                            'div',
                            { class: `side${s === lead && sides.length > 1 && s.points > sides[1].points ? ' lead' : ''}${i ? ' vs' : ''}` },
                            el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.name),
                            el('span', { class: 'pts' }, round(s.points, 2))
                        )
                    )
                )
            );
        }
        wrap.append(grid);
        return wrap;
    }

    function setupTimer() {
        clearInterval(timer);
        if (store.state.settings.autoRefreshLive) {
            timer = setInterval(() => paintScoreboard({ announce: true }), REFRESH_MS);
        }
    }

    async function paintFeed() {
        feedHost.replaceChildren(
            el('div', { class: 'section-head' }, el('h2', {}, 'Around the league')),
            el('div', { class: 'card' }, spinnerRow('Gathering injuries, waiver trends and transactions…'))
        );

        const injuries = injuryReport({
            cfg: app.league.cfg,
            ctx: app.ctx,
            teams: app.league.teams,
            rankings: app.rankings,
        });

        const [trending, transactions] = await Promise.all([
            trendingReport(app.players, app.league.teams).catch(() => ({ adds: [], drops: [] })),
            transactionFeed(app.league.cfg.id, app.league.currentWeek, app.league.teams, app.players).catch(() => []),
        ]);

        const costly = injuries.filter((i) => i.weeklyCost > 0.5);

        const wrap = el('div', {});
        wrap.append(
            el(
                'div',
                { class: 'tiles' },
                tile('Injury designations', injuries.length, `${costly.length} affecting a starting lineup`),
                tile('Waiver risers', trending.adds.length, `${trending.adds.filter((t) => !t.owner).length} available in your league`),
                tile('Recent moves', transactions.length, 'last two weeks')
            )
        );

        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Injury report'), el('span', { class: 'hint' }, 'cost is points per week to the roster holding him')));
        wrap.append(
            injuries.length
                ? el('div', { class: 'card' }, ...injuries.slice(0, 20).map((i) => injuryRow(i)))
                : el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Nobody on a roster in this league carries an injury designation right now.'))
        );

        wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Waiver wire momentum'), el('span', { class: 'hint' }, 'adds across all of Sleeper, last 24h')));
        wrap.append(
            el(
                'div',
                { class: 'grid grid-2' },
                trendColumn('Most added', trending.adds.slice(0, 10), 'good'),
                trendColumn('Most dropped', trending.drops.slice(0, 10), 'bad')
            )
        );

        if (transactions.length) {
            wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'League transactions')));
            const card = el('div', { class: 'card' });
            for (const t of transactions.slice(0, 25)) {
                card.append(
                    el(
                        'div',
                        { class: 'feed-item' },
                        el('div', { class: 'feed-icon' }, t.kind === 'trade' ? '🤝' : t.kind === 'waiver' ? '📝' : '➕'),
                        el(
                            'div',
                            { style: 'min-width:0' },
                            el('div', { style: 'font-weight:600;font-size:14px' }, t.headline),
                            el('div', { class: 'small muted' }, t.detail),
                            t.at ? el('div', { class: 'tiny dim' }, new Date(t.at).toLocaleString()) : null
                        )
                    )
                );
            }
            wrap.append(card);
        }

        feedHost.replaceChildren(el('div', { class: 'section-head' }, el('h2', {}, 'Around the league')), wrap);
    }

    function injuryRow(i) {
        return el(
            'div',
            { class: 'feed-item' },
            el('div', { class: 'feed-icon' }, i.severity >= 4 ? '🚑' : '⚠️'),
            el(
                'div',
                { style: 'min-width:0;flex:1' },
                el(
                    'div',
                    { class: 'row', style: 'gap:8px' },
                    posBadge(i.player.pos),
                    el('span', { style: 'font-weight:600' }, playerLink(i.player)),
                    tag(i.status, i.severity >= 4 ? 'bad' : 'warn'),
                    i.bodyPart ? el('span', { class: 'tiny dim' }, i.bodyPart) : null,
                    i.practice ? tag(i.practice, '') : null
                ),
                el('div', { class: 'small muted' }, i.detail)
            ),
            i.weeklyCost > 0.5
                ? el('div', { class: 'num bad nowrap', style: 'font-size:15px' }, `-${round(i.weeklyCost, 1)}/wk`)
                : null
        );
    }

    function trendColumn(title, rows, kind) {
        return el(
            'div',
            { class: 'card' },
            el('h3', {}, title),
            rows.length
                ? el(
                      'div',
                      {},
                      ...rows.map((t) =>
                          el(
                              'div',
                              { class: 'feed-item' },
                              el(
                                  'div',
                                  { style: 'min-width:0;flex:1' },
                                  el(
                                      'div',
                                      { class: 'row', style: 'gap:8px' },
                                      posBadge(t.player.pos),
                                      el('span', { style: 'font-weight:600' }, playerLink(t.player)),
                                      el('span', { class: 'tiny dim' }, t.player.team)
                                  ),
                                  el('div', { class: 'tiny muted' }, t.detail)
                              ),
                              el('span', { class: `num small ${kind}` }, t.count.toLocaleString())
                          )
                      )
                  )
                : el('p', { class: 'muted small' }, 'Sleeper has no trend data right now.')
        );
    }

    paintScoreboard();
    setupTimer();
    paintFeed();

    return root;
}
