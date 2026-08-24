// Player profile card.
//
// Opens from any player name in the app. The job is to answer, in one glance:
// who is this, what is he projected to do, what is he worth here, where do YOU
// have him ranked versus where the projection has him, and what does this week
// look like for him.

import { describeEnvironment } from '../odds.js';
import { slateAverage, vegasImpact } from '../startsit.js';
import { describeSchedule } from '../outlook.js';
import { valuePlayer } from '../valuation.js';
import { projectedPpg } from '../projections.js';
import { formatValue } from '../tradevalue.js';
import { marketEdge, describeEdge } from '../market.js';
import { getTrending } from '../sleeper.js';
import { playerHistory } from '../transactions.js';
import {
    el, fmtDelta, headshot, modal, posBadge, round, tag, tile,
} from '../ui.js';

const POS_LABEL = { DEF: 'D/ST' };

/** Stat rows worth showing, per position, in display order. */
const STAT_ROWS = {
    QB: [
        ['pass_yd', 'Pass yds'], ['pass_td', 'Pass TD'], ['pass_int', 'INT'],
        ['rush_yd', 'Rush yds'], ['rush_td', 'Rush TD'],
    ],
    RB: [
        ['rush_att', 'Carries'], ['rush_yd', 'Rush yds'], ['rush_td', 'Rush TD'],
        ['rec', 'Rec'], ['rec_yd', 'Rec yds'], ['rec_td', 'Rec TD'],
    ],
    WR: [
        ['rec', 'Rec'], ['rec_yd', 'Rec yds'], ['rec_td', 'Rec TD'],
        ['rush_yd', 'Rush yds'], ['rush_td', 'Rush TD'],
    ],
    TE: [['rec', 'Rec'], ['rec_yd', 'Rec yds'], ['rec_td', 'Rec TD']],
    K: [['xpm', 'XP made'], ['fgm_20_29', 'FG 20-29'], ['fgm_30_39', 'FG 30-39'], ['fgm_40_49', 'FG 40-49'], ['fgm_50p', 'FG 50+']],
    DEF: [['sack', 'Sacks'], ['int', 'INT'], ['fum_rec', 'Fum rec'], ['def_td', 'TD']],
};

/**
 * @param {object} app  shared app context
 * @param {object} player trimmed Sleeper player record
 */
export function openPlayerCard(app, player) {
    if (!player) return;

    const posRank = app.rankings.get(player.id) ?? null;
    const v = posRank ? valuePlayer(player, posRank, app.ctx) : null;
    const proj = app.projections?.[player.id] || null;
    const projPpg = proj ? projectedPpg(proj, app.cfg.scoring) : null;
    const projRank = v?.projectedRank ?? null;
    // What the rest of the world pays for him, which is a different question
    // from what he will score and from what you think of him.
    const mkt = app.ctx?.market?.get(player.id) ?? null;
    const mktRank = app.ctx?.marketRanks?.get(player.id) ?? null;
    const edge = marketEdge({ marketRank: mktRank, projectedRank: projRank, pos: player.pos });

    const owner = findOwner(app, player.id);
    const oddsCtx = app.odds?.byTeam?.get(player.team) || null;
    // Compare against this week's actual slate, exactly as Start/Sit does --
    // otherwise the same game reads differently in two places.
    const env = describeEnvironment(oddsCtx, slateAverage(app.odds?.byTeam));

    const body = el('div', {});

    // --- Identity ----------------------------------------------------------
    body.append(
        el(
            'div',
            { class: 'row', style: 'gap:14px;align-items:flex-start;margin-bottom:18px' },
            headshot(player, 58),
            el(
                'div',
                { class: 'grow', style: 'min-width:0' },
                el(
                    'div',
                    { class: 'row', style: 'gap:8px' },
                    posBadge(player.pos),
                    el('span', { style: 'font-size:19px;font-weight:700' }, player.name),
                    player.injury ? tag(player.injury, 'bad') : null
                ),
                el(
                    'div',
                    { class: 'pmeta', style: 'margin-top:2px' },
                    [
                        player.team === 'FA' ? 'Free agent' : player.team,
                        player.age ? `${player.age} years old` : null,
                        player.exp !== null && player.exp !== undefined
                            ? player.exp === 0 ? 'Rookie' : `${player.exp} yr${player.exp === 1 ? '' : 's'} exp`
                            : null,
                        player.number ? `#${player.number}` : null,
                    ].filter(Boolean).join(' · ')
                ),
                owner
                    ? el('div', { class: 'small', style: 'margin-top:6px' }, 'Rostered by ', el('strong', {}, owner.name))
                    : el('div', { class: 'small muted', style: 'margin-top:6px' }, 'Not rostered in this league')
            )
        )
    );

    if (player.injury) {
        body.append(
            el(
                'div',
                { class: 'banner banner-warn' },
                `${player.injury}${player.injuryBody ? ` — ${player.injuryBody}` : ''}${player.practice ? ` · ${player.practice} in practice` : ''}.` +
                    (v ? ` Value here is discounted to ${Math.round(v.availability * 100)}% for expected missed time.` : '')
            )
        );
    }

    // --- Headline numbers --------------------------------------------------
    const tiles = el('div', { class: 'tiles', style: 'margin-bottom:18px' });
    if (v) {
        tiles.append(tile('Trade value', formatValue(app.tradeValue(v.value)), `rest of season · ${app.ctx.weeksLeft} wk left`));
        tiles.append(tile('Your rank', `${POS_LABEL[player.pos] || player.pos}${posRank}`, 'where you have him'));
    }
    if (projPpg !== null) {
        tiles.append(tile('Projected', round(projPpg, 1), 'pts/game in this league'));
    }
    if (projRank) {
        tiles.append(tile('Projected rank', `${POS_LABEL[player.pos] || player.pos}${projRank}`, 'where the projection has him'));
    }
    // The third board. Your rank decides what he is worth TO YOU, the
    // projection estimates what he will SCORE, and this is what he COSTS --
    // the only one of the three that predicts whether his manager says yes.
    if (mktRank) {
        tiles.append(
            tile(
                'Market rank',
                `${POS_LABEL[player.pos] || player.pos}${mktRank}`,
                'what the league pays for him',
                edge?.kind === 'buy-low' ? 'good' : edge?.kind === 'sell-high' ? 'warn' : ''
            )
        );
    }
    // The Vegas multiplier was computed for every Start/Sit decision and never
    // shown as a number anywhere. It is the reason a projection gets moved, so
    // it belongs on the card next to the projection it moves.
    const slateNeutral = slateAverage(app.odds?.byTeam);
    const impact = oddsCtx ? vegasImpact(oddsCtx.impliedTotal, player.pos, slateNeutral) : null;
    if (impact?.known) {
        tiles.append(
            tile(
                'Vegas',
                `${impact.multiplier >= 1 ? '+' : ''}${Math.round((impact.multiplier - 1) * 100)}%`,
                `${round(impact.impliedTotal, 1)} implied, slate average ${round(slateNeutral, 1)}`,
                impact.multiplier > 1.04 ? 'good' : impact.multiplier < 0.96 ? 'bad' : ''
            )
        );
    }
    // The season ahead, not just Sunday. This is the argument that closes a
    // trade: a receiver whose three playoff-week games are all shootouts is
    // worth more than one whose are not, and no other free tool says so.
    const ros = app.restOfSeason?.get(player.team) || null;
    const playoffs = app.playoffSchedule?.get(player.team) || null;
    if (ros?.games) {
        tiles.append(
            tile(
                'Schedule',
                `${round(ros.average, 1)}`,
                `implied pts/game the rest of the way · ${ros.rank} of ${ros.of}`,
                ros.edge > 0.6 ? 'good' : ros.edge < -0.6 ? 'bad' : ''
            )
        );
    }
    if (playoffs?.games) {
        tiles.append(
            tile(
                'Playoff weeks',
                `${round(playoffs.average, 1)}`,
                `weeks ${playoffs.weeks.map((w) => w.week).join(', ')} · ${playoffs.rank} of ${playoffs.of}`,
                playoffs.edge > 0.6 ? 'good' : playoffs.edge < -0.6 ? 'bad' : ''
            )
        );
    }
    body.append(tiles);

    const scheduleNote = describeSchedule(ros);
    const playoffNote = describeSchedule(playoffs, { label: 'the fantasy playoffs' });
    if (scheduleNote || playoffNote) {
        body.append(
            el(
                'div',
                { class: 'card card-tight', style: 'margin-bottom:18px' },
                scheduleNote ? el('div', { class: 'small' }, scheduleNote) : null,
                playoffNote ? el('div', { class: 'small', style: 'margin-top:6px' }, playoffNote) : null
            )
        );
    }

    // --- Where the price and the projection disagree ------------------------
    //
    // The most useful sentence on this card. Neither number can produce it
    // alone: the projection has no idea what he costs, and the price has no
    // idea what he will do. The difference is the trade.
    if (edge && edge.kind !== 'fair') {
        const buy = edge.kind === 'buy-low';
        body.append(
            el(
                'div',
                { class: `verdict tone-${buy ? 'good' : 'warn'}`, style: 'margin-bottom:14px' },
                el('div', { class: 'label' }, buy ? 'Buy low' : 'Sell high'),
                el('div', { class: 'headline' }, describeEdge(edge, player.name)),
                el(
                    'p',
                    { class: 'small muted', style: 'margin:8px 0 0' },
                    buy
                        ? 'His manager is likely to let him go for less than he is projected to be worth. ' +
                          'That gap is the cheapest edge in fantasy, and it closes as soon as he scores.'
                        : 'The league is paying more for him than the projection supports. If you are going ' +
                          'to move him, this is the window.'
                )
            )
        );
    }

    // --- Where you disagree with the projection ----------------------------
    if (posRank && projRank) {
        const gap = projRank - posRank;
        if (Math.abs(gap) >= 4) {
            body.append(
                el(
                    'div',
                    { class: `banner ${gap > 0 ? '' : 'banner-warn'}` },
                    gap > 0
                        ? `You are ${gap} spots higher on him than the projection. Your board is what drives his value here — the projection is only the scale.`
                        : `You have him ${Math.abs(gap)} spots lower than the projection does. His value reflects your ranking, not the projection.`
                )
            );
        }
    }

    // --- Projected production ----------------------------------------------
    const rows = STAT_ROWS[player.pos] || [];
    if (proj && rows.length) {
        const games = proj.games || 17;
        body.append(
            el('h3', {}, 'Projected production'),
            el(
                'div',
                { class: 'table-scroll' },
                el(
                    'table',
                    { class: 'table' },
                    el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', { class: 'right' }, 'Season'), el('th', { class: 'right' }, 'Per game'))),
                    el(
                        'tbody',
                        {},
                        ...rows
                            .filter(([key]) => typeof proj.stats[key] === 'number')
                            .map(([key, label]) =>
                                el(
                                    'tr',
                                    {},
                                    el('td', { class: 'small' }, label),
                                    el('td', { class: 'num right small' }, round(proj.stats[key], 1)),
                                    el('td', { class: 'num right small muted' }, round(proj.stats[key] / games, 1))
                                )
                            )
                    )
                )
            )
        );
    } else {
        body.append(
            el(
                'p',
                { class: 'muted small' },
                'No projection published for this player, so his value comes from the fallback rank curve.'
            )
        );
    }

    // --- Value breakdown ---------------------------------------------------
    if (v) {
        const repl = v.replacementPpg;
        body.append(
            el('h3', { style: 'margin-top:20px' }, 'How the value is built'),
            el(
                'table',
                { class: 'table' },
                el(
                    'tbody',
                    {},
                    row('Projected points/game at your rank', round(v.ppg, 2)),
                    row(`Replacement level (${player.pos}${app.ctx.replacement[player.pos]})`, round(repl, 2)),
                    row('Points above replacement/game', fmtDelta(v.parPerGame, 2), v.parPerGame >= 0 ? 'good' : 'bad'),
                    row('Weeks remaining', app.ctx.weeksLeft),
                    player.injury ? row('Availability', `${Math.round(v.availability * 100)}%`, 'warn') : null,
                    row('Points above replacement, rest of season', round(v.ros, 1)),
                    row('Trade value on your board', formatValue(app.tradeValue(v.value))),
                    // What the deal will actually be priced at. The ledger and
                    // the fairness meter both use this rather than the row
                    // above, because what you think of him decides whether you
                    // want the trade, not whether it is even.
                    mktRank
                        ? row(
                              'What the market charges',
                              formatValue(app.tradeValue(valuePlayer(player, mktRank, app.ctx).value))
                          )
                        : null
                )
            ),
            app.ctx.dynasty
                ? el('p', { class: 'tiny dim' }, `Dynasty league: value also includes future seasons, aged on a ${player.pos} curve.`)
                : null
        );
    }

    // --- This week's game environment --------------------------------------
    if (oddsCtx && oddsCtx.impliedTotal !== null) {
        body.append(
            el('h3', { style: 'margin-top:20px' }, 'This week'),
            el(
                'div',
                { class: 'tiles' },
                tile('Implied team total', round(oddsCtx.impliedTotal, 1), `${oddsCtx.home ? 'vs' : '@'} ${oddsCtx.opponent}`),
                tile('Game total', oddsCtx.overUnder ?? '—', oddsCtx.detail || ''),
                tile('Role', oddsCtx.isFavorite ? 'Favorite' : 'Underdog', oddsCtx.detail || '')
            ),
            env ? el('p', { class: `small ${env.tone === 'neutral' ? 'muted' : env.tone}` }, env.text) : null,
            el('p', { class: 'tiny dim' }, 'Vegas lines describe this week only and are not used in trade value.')
        );
    }

    // --- Transaction history ------------------------------------------------
    const history = playerHistory(app.transactions, player.id);
    if (history.length) {
        const teamName = (id) => app.league?.teams.find((t) => t.rosterId === id)?.name || 'free agency';
        body.append(
            el('h3', { style: 'margin-top:20px' }, 'Transaction history'),
            el(
                'div',
                { class: 'timeline' },
                ...history
                    .slice()
                    .reverse()
                    .map((ev) =>
                        el(
                            'div',
                            { class: `tl-item tl-${ev.type}` },
                            el(
                                'div',
                                { class: 'tl-body' },
                                el(
                                    'div',
                                    { class: 'tl-title' },
                                    ev.type === 'trade'
                                        ? `Traded from ${teamName(ev.from)} to ${teamName(ev.to)}`
                                        : ev.to
                                          ? `${ev.label} by ${teamName(ev.to)}`
                                          : `Dropped by ${teamName(ev.from)}`
                                ),
                                el(
                                    'div',
                                    { class: 'tl-meta' },
                                    [
                                        ev.week ? `Week ${ev.week}` : null,
                                        ev.at ? new Date(ev.at).toLocaleDateString() : null,
                                        ev.transaction.bid ? `$${ev.transaction.bid} bid` : null,
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')
                                )
                            )
                        )
                    )
            )
        );
    }

    // --- Waiver momentum ---------------------------------------------------
    const trendHost = el('div', {});
    body.append(trendHost);
    loadTrend(player, trendHost);

    modal({ title: 'Player profile', body, width: '640px' });
}

function row(label, value, cls = '') {
    return el(
        'tr',
        {},
        el('td', { class: 'small' }, label),
        el('td', { class: `num right small ${cls}` }, value)
    );
}

function findOwner(app, playerId) {
    for (const t of app.league?.teams || []) {
        if (t.players.some((p) => p.id === playerId)) return t;
    }
    return null;
}

async function loadTrend(player, host) {
    try {
        const [adds, drops] = await Promise.all([
            getTrending('add', 24, 100).catch(() => []),
            getTrending('drop', 24, 100).catch(() => []),
        ]);
        const add = (adds || []).find((r) => r.player_id === player.id);
        const drop = (drops || []).find((r) => r.player_id === player.id);
        if (!add && !drop) return;
        host.append(
            el('h3', { style: 'margin-top:20px' }, 'Waiver momentum'),
            el(
                'p',
                { class: 'small' },
                add ? `Added in ${add.count.toLocaleString()} leagues in the last 24 hours. ` : '',
                drop ? `Dropped in ${drop.count.toLocaleString()} leagues in the last 24 hours.` : ''
            )
        );
    } catch {
        /* momentum is a bonus; never let it break the card */
    }
}
