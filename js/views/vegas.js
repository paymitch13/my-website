// Vegas — the full slate, and what each line means for fantasy.

import { loadOdds } from '../data.js';
import { describeMovement, gameScript, fmtSpread, fmtMoneyline } from '../odds.js';
import { slateAverage } from '../startsit.js';
import { fetchWeatherForGames, describeWeather, weatherImpact } from '../weather.js';
import { el, emptyState, fmtDelta, fmtPct, round, sortBy, spinnerRow, tag, tile } from '../ui.js';

export default function renderVegas(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Vegas'),
            el(
                'p',
                { class: 'sub' },
                'Every posted line on the slate, and what it implies. Implied team totals say how many points ',
                'an offense is expected to score; the moneyline gives a de-vigged win probability; the spread ',
                'sets game script; and the move since the market opened is information a projection has not ',
                'absorbed yet.'
            )
        )
    );

    const host = el('div', {});
    root.append(host);
    host.append(el('div', { class: 'card' }, spinnerRow('Loading lines and forecasts…')));

    (async () => {
        try {
            host.replaceChildren(await build(app));
        } catch (err) {
            console.error(err);
            host.replaceChildren(emptyState('⚠️', 'Could not load lines', err.message));
        }
    })();

    return root;
}

async function build(app) {
    const week = app.league?.currentWeek;
    const season = app.league?.raw?.season || app.season;
    const odds = app.odds || (await loadOdds(week, season));

    const wrap = el('div', {});
    const games = odds?.games || [];
    const priced = games.filter((g) => Number.isFinite(g.overUnder));

    if (!priced.length) {
        wrap.append(
            emptyState(
                '🎲',
                'No lines posted yet',
                'Sportsbooks post most NFL lines a few days before kickoff. This fills in as the week approaches.'
            )
        );
        return wrap;
    }

    const weather = await fetchWeatherForGames(games);
    const neutral = slateAverage(odds.byTeam);

    // --- Slate summary ------------------------------------------------------
    const totals = priced.map((g) => g.overUnder);
    const highest = sortBy(priced, (g) => g.overUnder, -1)[0];
    const lowest = sortBy(priced, (g) => g.overUnder)[0];
    const biggestMove = sortBy(
        priced.filter((g) => g.movement?.total),
        (g) => Math.abs(g.movement.total.change),
        -1
    )[0];

    wrap.append(
        el(
            'div',
            { class: 'tiles' },
            tile('Games priced', priced.length, `of ${games.length} on the slate`),
            tile('Average implied total', round(neutral, 1), 'points per team — the neutral point'),
            tile('Highest total', `${highest.overUnder}`, highest.name),
            tile('Lowest total', `${lowest.overUnder}`, lowest.name),
            biggestMove
                ? tile(
                      'Biggest line move',
                      `${fmtDelta(biggestMove.movement.total.change)}`,
                      `${biggestMove.name} total, since opening`,
                      biggestMove.movement.total.change > 0 ? 'good' : 'bad'
                  )
                : null
        )
    );

    // --- Best and worst spots ----------------------------------------------
    // --- The season ahead, not just this week ------------------------------
    // Every posted line for the rest of the year is already downloaded for the
    // bye map. This is the part that matters for trades rather than lineups.
    if (app.restOfSeason?.size) {
        const ros = sortBy([...app.restOfSeason.values()], (r) => r.rank);
        const playoffs = app.playoffSchedule?.size ? app.playoffSchedule : null;

        wrap.append(
            el(
                'div',
                { class: 'section-head' },
                el('h2', {}, 'Rest of season'),
                el('span', { class: 'hint' }, `average implied points a game, weeks ${ros[0]?.weeks?.[0]?.week ?? ''}–18`)
            )
        );
        wrap.append(
            el(
                'div',
                { class: 'grid grid-2' },
                scheduleCard('Best remaining schedules', ros.slice(0, 6), 'good', playoffs),
                scheduleCard('Worst remaining schedules', ros.slice(-6).reverse(), 'bad', playoffs)
            )
        );

        if (playoffs) {
            const po = sortBy([...playoffs.values()], (r) => r.rank);
            wrap.append(
                el(
                    'div',
                    { class: 'section-head' },
                    el('h2', {}, 'Fantasy playoff weeks'),
                    el('span', { class: 'hint' }, `weeks ${po[0]?.weeks?.map((w) => w.week).join(', ') ?? ''} — the only ones that decide anything`)
                )
            );
            wrap.append(
                el(
                    'div',
                    { class: 'grid grid-2' },
                    scheduleCard('Best playoff-week spots', po.slice(0, 6), 'good', null),
                    scheduleCard('Worst playoff-week spots', po.slice(-6).reverse(), 'bad', null)
                )
            );
        }
    }

    const teamRows = [...odds.byTeam.values()].filter((c) => Number.isFinite(c.impliedTotal));
    const best = sortBy(teamRows, (c) => c.impliedTotal, -1).slice(0, 5);
    const worst = sortBy(teamRows, (c) => c.impliedTotal).slice(0, 5);

    wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Best and worst spots'),
        el('span', { class: 'hint' }, 'by implied team total')));
    wrap.append(
        el(
            'div',
            { class: 'grid grid-2' },
            spotCard('Highest-scoring offenses', best, 'good', neutral),
            spotCard('Offenses to avoid', worst, 'bad', neutral)
        )
    );

    // --- Full board ---------------------------------------------------------
    wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Full board')));

    const board = el('div', {});
    for (const g of sortBy(priced, (x) => -(x.overUnder ?? 0))) {
        board.append(gameCard(g, weather.get(g.home), neutral));
    }
    wrap.append(board);

    wrap.append(
        el(
            'p',
            { class: 'tiny dim', style: 'margin-top:18px' },
            'Lines from ESPN’s public feed (DraftKings). Win probability removes the bookmaker’s margin by ',
            'normalizing both sides of the moneyline. Implied team totals are the pair of scores that hits the ',
            'total and covers the spread. Vegas is used for weekly context and is deliberately not folded into ',
            'season-long trade value.'
        )
    );

    return wrap;
}

/** One column of teams ranked by the environment ahead of them. */
function scheduleCard(title, rows, tone, playoffs) {
    return el(
        'div',
        { class: 'card' },
        el('h3', {}, title),
        ...rows.map((r) =>
            el(
                'div',
                { class: 'row', style: 'padding:6px 0;border-bottom:1px solid var(--line-soft);gap:8px' },
                el('span', { class: 'tiny dim', style: 'min-width:22px' }, `${r.rank}`),
                el('span', { style: 'font-weight:600;min-width:44px' }, r.team),
                el('span', { class: 'tiny dim grow' }, `${r.games} games`),
                playoffs?.get(r.team)
                    ? el('span', { class: 'tiny dim', title: 'rank in the fantasy playoff weeks' },
                        `pl ${playoffs.get(r.team).rank}`)
                    : null,
                el('span', { class: `num ${tone}` }, round(r.average, 1)),
                el('span', { class: 'tiny dim', style: 'min-width:52px;text-align:right' }, fmtDelta(r.edge))
            )
        )
    );
}

function spotCard(title, rows, tone, neutral) {
    return el(
        'div',
        { class: 'card' },
        el('h3', {}, title),
        ...rows.map((c) =>
            el(
                'div',
                { class: 'row', style: 'padding:6px 0;border-bottom:1px solid var(--line-soft)' },
                el('span', { style: 'font-weight:600;min-width:44px' }, c.team),
                el('span', { class: 'tiny dim grow' }, `${c.home ? 'vs' : '@'} ${c.opponent}`),
                el('span', { class: `num ${tone}` }, round(c.impliedTotal, 1)),
                el('span', { class: 'tiny dim', style: 'min-width:52px;text-align:right' },
                    `${fmtDelta(c.impliedTotal - neutral)}`)
            )
        )
    );
}

function gameCard(g, wx, neutral) {
    const favImplied = g.implied[g.favorite] ?? null;
    const dog = g.favorite === g.home ? g.away : g.home;
    const dogImplied = g.implied[dog] ?? null;
    const moves = describeMovement({ movement: g.movement, favoriteFlipped: g.favoriteFlipped });

    const kickoff = g.date ? new Date(g.date) : null;

    return el(
        'div',
        { class: 'card vegas-game' },
        el(
            'div',
            { class: 'row', style: 'gap:10px;align-items:baseline' },
            el('h3', { style: 'margin:0' }, `${g.away} @ ${g.home}`),
            g.neutralSite ? tag('neutral site', 'warn') : null,
            g.indoor ? tag('indoors', '') : null,
            el('span', { class: 'tiny dim grow' },
                kickoff ? kickoff.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''),
            el('span', { class: 'tiny dim' }, g.detail || '')
        ),
        el(
            'div',
            { class: 'vegas-grid' },
            vegasCell(
                'Total',
                g.overUnder,
                g.movement?.total
                    ? `opened ${g.movement.total.open} (${fmtDelta(g.movement.total.change)})`
                    : 'no movement data'
            ),
            // The posted total is not the market's number when one side is
            // priced higher. Every implied total below is computed off the
            // de-vigged one, so it is shown rather than applied silently.
            Number.isFinite(g.fairTotal) && Math.abs(g.fairTotal - g.overUnder) > 0.01
                ? vegasCell(
                      'Total, de-vigged',
                      round(g.fairTotal, 2),
                      `${g.overLean > 0.5 ? 'over' : 'under'} is juiced — the market sits ${g.fairTotal > g.overUnder ? 'above' : 'below'} the posted ${g.overUnder}`
                  )
                : null,
            vegasCell('Spread', g.detail || fmtSpread(g.spread), g.movement?.spread
                ? `opened ${fmtSpread(g.movement.spread.open)} (home)` : ''),
            vegasCell(`${g.favorite || '—'} implied`, favImplied === null ? '—' : round(favImplied, 1),
                favImplied === null ? '' : `${fmtDelta(favImplied - neutral)} vs slate`),
            vegasCell(`${dog} implied`, dogImplied === null ? '—' : round(dogImplied, 1),
                dogImplied === null ? '' : `${fmtDelta(dogImplied - neutral)} vs slate`),
            g.winProbability
                ? vegasCell('Win probability',
                    `${g.away} ${fmtPct(g.winProbability[g.away] ?? 0)}`,
                    `${g.home} ${fmtPct(g.winProbability[g.home] ?? 0)} · ML ${fmtMoneyline(g.moneyline.away)}/${fmtMoneyline(g.moneyline.home)}`)
                : null
        ),
        moves.length
            ? el('div', { style: 'margin-top:10px' },
                ...moves.map((m) => el('div', { class: `small ${m.tone === 'neutral' ? 'muted' : m.tone}` }, m.text)))
            : null,
        // A model and a market disagreeing is genuinely interesting and nothing
        // else in the app can see it: one is an opinion, the other is money.
        g.predictor?.notable
            ? el('div', { class: 'small warn', style: 'margin-top:8px' },
                `${g.predictor.text} That is a ${Math.abs(Math.round(g.predictor.gap * 100))}-point disagreement between the model and the money.`)
            : g.predictor?.text
                ? el('div', { class: 'small muted', style: 'margin-top:8px' }, `${g.predictor.text} Model and market agree.`)
                : null,
        g.consensus && g.consensus.providers > 1
            ? el('div', { class: 'small muted', style: 'margin-top:8px' },
                `${g.consensus.providers} books priced this game` +
                (g.consensus.totalSpread > 0 ? `, and they disagree by ${round(g.consensus.totalSpread, 1)} on the total` : ' and they agree on the total') + '.')
            : null,
        wx && !wx.dome && !wx.unavailable
            ? el(
                  'div',
                  { class: 'small muted', style: 'margin-top:8px' },
                  `Weather: ${describeWeather(wx)}`,
                  weatherImpact(wx, 'QB').severity !== 'none'
                      ? el('span', { class: 'warn' }, ` — ${weatherImpact(wx, 'QB').notes.join(' ')}`)
                      : null
              )
            : null,
        el(
            'div',
            { class: 'small muted', style: 'margin-top:8px' },
            ...[g.favorite, dog].filter(Boolean).map((team) => {
                const script = gameScript({
                    ownSpread: team === g.favorite ? -Math.abs(g.spread) : Math.abs(g.spread),
                });
                return script ? el('div', {}, `${team}: ${script.text}`) : null;
            })
        )
    );
}

function vegasCell(label, value, detail) {
    return el(
        'div',
        { class: 'vegas-cell' },
        el('div', { class: 'k' }, label),
        el('div', { class: 'v num' }, value),
        detail ? el('div', { class: 'd' }, detail) : null
    );
}
