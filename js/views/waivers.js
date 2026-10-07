// Waiver Wire.
//
// The recommendations used to be five rows in a FAAB panel on the trade page,
// each saying "adds 1.2 pts/wk". That is the right spine and nothing else, and
// it left four of the five questions a manager has unanswered: is this real or
// a hot streak, who do I drop for him, what should I bid, and which of this
// week's popular names is a trap.
//
// Grouped by what KIND of add each one is, because flattening a speculative
// stash and a week-winning streamer into one ranked list makes the list
// useless -- they sit next to each other with no way to tell them apart.

import { buildWaiverBoard, ROLE_LABEL, ROLE_BLURB } from '../waivers.js';
import { evaluatePlayerWeek, slateAverage } from '../startsit.js';
import { buildDefenseProfiles, rankDefenses } from '../matchup.js';
import { fetchWeatherForGames } from '../weather.js';
import { bidHistory } from '../faab.js';
import { buildEntries } from '../trade.js';
import { isOnBye } from '../schedule.js';
import { loadWeekContext, loadOdds } from '../data.js';
import { playoffOutlook, playoffWeeksFor, scheduleStrength } from '../outlook.js';
import { openSyncModal } from '../app.js';
import {
    banner, el, emptyState, playerCell, playerLink, posBadge, round, spinnerRow, tag, tile,
} from '../ui.js';

export default function renderWaivers(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Waiver Wire'),
            el(
                'p',
                { class: 'sub' },
                'Everyone available, ranked by what they would add to ',
                el('em', {}, 'your'),
                ' lineup — with whether the production is real, who to drop, what to bid, ',
                'and which of this week’s popular names to leave alone.'
            )
        )
    );

    if (!app.league) {
        root.append(
            emptyState(
                '📝',
                'Connect a league',
                'Waiver recommendations are about your roster: which free agent improves your lineup, and who ' +
                    'he would replace. Both need a synced league.',
                el('button', { class: 'btn btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        return root;
    }

    const host = el('div', {});
    root.append(host);
    host.append(el('div', { class: 'card' }, spinnerRow('Scanning the wire — usage trends, matchups and bid history…')));

    build(app)
        .then((node) => host.replaceChildren(node))
        .catch((err) => {
            console.error(err);
            host.replaceChildren(banner(err.message || 'Could not build the waiver board.', 'bad'));
        });

    return root;
}

async function build(app) {
    const { cfg, currentWeek, lastPlayed, raw } = app.league;
    const season = raw.season;
    const team = app.league.teams.find((t) => t.ownerId && t.ownerId === app.userId) || app.league.teams[0];

    const [weekCtx, odds] = await Promise.all([
        loadWeekContext(season, currentWeek, lastPlayed),
        app.odds ? Promise.resolve(app.odds) : loadOdds(currentWeek, season).catch(() => null),
    ]);

    const games = odds?.games || [];
    const oddsByTeam = odds?.byTeam || new Map();
    const weatherByHome = await fetchWeatherForGames(games).catch(() => new Map());

    const defenseProfiles = buildDefenseProfiles(weekCtx.weeklyStats, cfg.scoring);
    const defenseRanks = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) defenseRanks[pos] = rankDefenses(defenseProfiles, pos);
    const neutralImplied = slateAverage(oddsByTeam);

    // A wider pool than the FAAB panel's, because this page is the one whose
    // job is to find the name nobody has noticed.
    const freeAgents = app.freeAgentEntries({ limit: 160 });

    // This week's environment for each candidate. Only the ones we will
    // actually show are worth evaluating, so the pool is trimmed first by
    // lineup gain inside buildWaiverBoard -- but the evaluation feeds that
    // ranking, so it has to happen up front. 160 is cheap; the whole database
    // would not be.
    const weekEval = new Map();
    for (const fa of freeAgents) {
        weekEval.set(
            fa.player.id,
            evaluatePlayerWeek({
                neutralImplied,
                player: fa.player,
                weekly: weekCtx.weekly?.[fa.player.id] || null,
                scoring: cfg.scoring,
                oddsByTeam,
                weatherByHome,
                defenseProfiles,
                defenseRanks,
                weeksLeft: Math.max(1, app.league.weeksLeft),
                onBye: isOnBye(app.byeWeeks, fa.player.team, currentWeek),
                marketRow: null,
            })
        );
    }

    // Playoff-week schedule, which is worth a roster spot once it is close
    // enough to plan for.
    let playoffs = null;
    if (app.seasonSchedule) {
        const weeks = playoffWeeksFor(cfg);
        playoffs = scheduleStrength(playoffOutlook(app.seasonSchedule, weeks));
    }

    // Valued on the user's own board, because this is their roster and their
    // opinion is what decides who is expendable.
    const entries = buildEntries(team.players, app.rankings, app.ctx);

    const board = buildWaiverBoard({
        freeAgents,
        entries,
        cfg,
        weeklyStats: weekCtx.weeklyStats,
        trending: app.trendingAdds || null,
        weekEval,
        restOfSeason: app.restOfSeason || null,
        playoffs,
        faab: app.faab,
        week: currentWeek,
        limit: 24,
    });

    const wrap = el('div', {});

    // --- What we are working with ------------------------------------------
    const notes = [];
    if (!weekCtx.weekly) notes.push('no weekly projections yet');
    if (!games.length) notes.push('no Vegas lines posted');
    if (!weekCtx.weeklyStats?.size) notes.push('not enough games played to read usage trends');
    if (!app.trendingAdds) notes.push('league-wide add counts unavailable');
    if (notes.length) {
        wrap.append(
            banner(
                `Working with partial data — ${notes.join(', ')}. Everything below falls back to what is available.`,
                'warn'
            )
        );
    }

    const history = bidHistory(app.faab);
    const mustAdds = board.byRole.get('must-add')?.length ?? 0;
    const starters = board.byRole.get('starter')?.length ?? 0;

    wrap.append(
        el(
            'div',
            { class: 'tiles' },
            tile('Worth adding', mustAdds + starters, 'would start for you this week', mustAdds ? 'good' : ''),
            tile('Scanned', freeAgents.length, 'available players checked against your lineup'),
            tile(
                'Traps flagged',
                board.fades.length,
                board.fades.length ? 'popular adds the usage does not support' : 'nothing popular looks hollow',
                board.fades.length ? 'warn' : ''
            ),
            cfg.usesFaab
                ? tile(
                      'Your budget',
                      `$${team.faabRemaining ?? 0}`,
                      history ? `league median bid $${history.median}` : 'no bids settled yet'
                  )
                : null
        )
    );

    // --- The traps, first ---------------------------------------------------
    //
    // Deliberately above the recommendations. The most valuable thing a waiver
    // tool can say is which of this week's most-added players not to spend on,
    // and that is useless below a fold.
    if (board.fades.length) {
        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, 'Popular, but look closer'),
                el('span', { class: 'hint' }, 'the league is chasing these — the usage does not back it up')
            )
        );
        const card = el('div', { class: 'card' });
        for (const row of board.fades) {
            card.append(
                el(
                    'div',
                    { class: 'suggest' },
                    el(
                        'div',
                        { class: 'suggest-main' },
                        playerCell(row.player, { rank: row.posRank }),
                        el('div', { class: 'suggest-why warn' }, row.caution.text)
                    ),
                    el(
                        'div',
                        { class: 'suggest-meta' },
                        tag(`${compact(row.demand)} adds`, 'warn')
                    )
                )
            );
        }
        wrap.append(card);
    }

    // --- Recommendations, grouped by what kind of add they are --------------
    if (!board.targets.length) {
        wrap.append(
            el(
                'div',
                { class: 'card' },
                el('p', { class: 'muted' },
                    'Nothing on the wire improves this roster right now. That is a real answer, and usually means ' +
                    'your bench is already better than what is available — the upgrade has to come from a trade.')
            )
        );
    }

    // When nothing on the wire would start for this team, say it once at the
    // top rather than letting a reader infer it from twenty-four rows that all
    // happen to read "a bet on what he becomes". Measured against a real
    // week-5 league this is the common case for a strong roster, not an edge
    // case, so it needs to be stated rather than discovered.
    const anyStarter = board.targets.some((r) => r.lineupGain >= 1);
    if (board.targets.length && !anyStarter) {
        wrap.append(
            el(
                'div',
                { class: 'card' },
                el(
                    'p',
                    { class: 'muted', style: 'margin:0' },
                    el('strong', {}, 'Nothing here starts for you this week. '),
                    'Your bench is already better than what is available, which is a good problem. Everything below ' +
                    'is speculative: a bet on a role that is still growing. Worth a spot only if you have one to spare, ' +
                    'and the upgrade to your lineup has to come from a trade instead.'
                )
            )
        );
    }

    for (const [role, rows] of board.byRole) {
        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, ROLE_LABEL[role]),
                el('span', { class: 'hint' }, ROLE_BLURB[role])
            )
        );
        const card = el('div', { class: 'card' });
        rows.forEach((row, i) => card.append(targetRow(app, row, board, i === 0)));
        wrap.append(card);
    }

    // --- Who to drop --------------------------------------------------------
    //
    // "Add him" is not an action. "Add him for this guy" is.
    if (board.drops.length) {
        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, 'Cheapest to drop'),
                el('span', { class: 'hint' }, 'what each one costs your lineup if he goes')
            )
        );
        wrap.append(
            el(
                'div',
                { class: 'card' },
                el(
                    'p',
                    { class: 'small muted', style: 'margin-top:0' },
                    'Measured as the points your optimal lineup loses without him — not his season-long value. ',
                    'Those are different players, and the difference is the whole point of dropping anybody.'
                ),
                el(
                    'table',
                    { class: 'table' },
                    el(
                        'thead',
                        {},
                        el('tr', {},
                            el('th', {}, 'Player'),
                            el('th', { class: 'right' }, 'Lineup cost'),
                            el('th', { class: 'right hide-sm' }, 'Trade value'))
                    ),
                    el(
                        'tbody',
                        {},
                        ...board.drops.map((d) =>
                            el(
                                'tr',
                                {},
                                el('td', {}, posBadge(d.player.pos), ' ', playerLink(d.player)),
                                el(
                                    'td',
                                    { class: `num right ${d.cost <= 0.01 ? 'good' : 'warn'}` },
                                    d.cost <= 0.01 ? 'free' : `−${round(d.cost, 1)}/wk`
                                ),
                                el('td', { class: 'num right dim hide-sm' }, app.tradeValue ? Math.round(app.tradeValue(d.value)).toLocaleString('en-US') : '—')
                            )
                        )
                    )
                )
            )
        );
    }

    return wrap;
}

/** One recommendation, with its reasons and the move it implies. */
function targetRow(app, row, board, lead) {
    const bid = row.bid;
    const drop = board.drops[0] || null;

    return el(
        'div',
        { class: `waiver-row${lead ? ' waiver-lead' : ''}` },
        el(
            'div',
            { class: 'row', style: 'gap:10px;align-items:flex-start;flex-wrap:wrap' },
            el('div', { class: 'grow', style: 'min-width:200px' }, playerCell(row.player, { rank: row.posRank })),
            el(
                'div',
                { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
                row.lineupGain >= 0.1
                    ? tag(`${row.lineupGain > 0 ? '+' : ''}${round(row.lineupGain, 1)} pts/wk`, row.lineupGain >= 1 ? 'good' : '')
                    : null,
                bid ? tag(`~$${bid.dollars}${bid.capped ? '+' : ''}`, 'accent') : null,
                row.demand > 0 ? tag(`${compact(row.demand)} adds`, row.demand >= 5000 ? 'warn' : '') : null,
                row.evaluation?.hasGame && row.evaluation.opponent
                    ? tag(`vs ${row.evaluation.opponent}`, '')
                    : row.evaluation
                      ? tag(row.evaluation.onBye ? 'bye' : 'no game', 'warn')
                      : null
            )
        ),
        el(
            'ul',
            { class: 'waiver-why' },
            ...row.reasons.map((r) =>
                el('li', { class: r.tone === 'good' ? 'good' : r.tone === 'bad' ? 'bad' : r.tone === 'warn' ? 'warn' : '' }, r.text)
            )
        ),
        row.caution ? el('p', { class: 'small warn', style: 'margin:6px 0 0' }, row.caution.text) : null,
        // The actual move, spelled out, for the top recommendation in each
        // group -- repeating it on every row would be noise.
        lead && drop
            ? el(
                  'p',
                  { class: 'small muted', style: 'margin:8px 0 0' },
                  'The move: add ',
                  el('strong', {}, row.player.name),
                  bid ? ` for about $${bid.dollars}` : '',
                  ', drop ',
                  el('strong', {}, drop.player.name),
                  drop.cost <= 0.01 ? ' (costs your lineup nothing).' : ` (costs ${round(drop.cost, 1)} pts/wk).`
              )
            : null
    );
}

/** 42,000 -> 42k, because a waiver card is not a spreadsheet. */
const compact = (n) =>
    n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
