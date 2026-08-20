// League — settings, standings and roster inspection.

import { optimizeLineup, positionalReport } from '../lineup.js';
import { buildEntries } from '../trade.js';
import { scoringLabel, slotLabel } from '../league.js';
import { openSyncModal } from '../app.js';
import {
    el, emptyState, fmtDelta, modal, playerCell, posBadge, round, sortBy, tag, tile, toast,
} from '../ui.js';

export default function renderLeague(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'League'),
            el('p', { class: 'sub' }, 'Every setting the calculator reads, and how each roster grades out under your rankings.')
        )
    );

    if (!app.league) {
        root.append(
            emptyState(
                '🔗',
                'No league connected',
                'Sync your Sleeper league to unlock roster analysis, power rankings, playoff odds and the full trade engine.',
                el('button', { class: 'btn btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        return root;
    }

    const { cfg, teams, currentWeek, weeksLeft } = app.league;

    // ---- Settings ---------------------------------------------------------

    root.append(
        el(
            'div',
            { class: 'tiles' },
            tile('League', cfg.name, `${cfg.teams} teams · ${cfg.format}`),
            tile('Scoring', scoringLabel(cfg.scoring), cfg.superflex ? 'Superflex' : 'Single QB'),
            tile('Week', currentWeek, `${weeksLeft} regular-season week${weeksLeft === 1 ? '' : 's'} left`),
            tile('Playoffs', `${cfg.playoffTeams} teams`, `start week ${cfg.playoffWeekStart}`)
        )
    );

    root.append(
        el(
            'div',
            { class: 'card', style: 'margin-top:16px' },
            el('h3', {}, 'Starting lineup'),
            el(
                'div',
                { class: 'row', style: 'gap:6px' },
                ...cfg.starterSlots.map((s) => tag(slotLabel(s))),
                tag(`${cfg.benchSize} BN`, ''),
                cfg.medianScoring ? tag('median win', 'accent') : null,
                cfg.hasIdp ? tag('IDP slots — not valued', 'warn') : null
            ),
            cfg.hasIdp
                ? el(
                      'p',
                      { class: 'tiny dim', style: 'margin-top:10px;margin-bottom:0' },
                      'This league starts IDP slots. Rankings and values cover offense, kickers and team defenses only, so IDP contributions are excluded from every calculation.'
                  )
                : null
        )
    );

    // ---- Standings --------------------------------------------------------

    const analyzed = sortBy(
        teams.map((t) => {
            const entries = buildEntries(t.players, app.rankings, app.ctx);
            const lineup = optimizeLineup(entries, cfg.starterSlots);
            return { team: t, entries, lineup, report: positionalReport(entries, cfg.starterSlots) };
        }),
        (a) => a.team.wins * 10000 + a.team.pointsFor,
        -1
    );

    const leagueAvgLineup = analyzed.reduce((s, a) => s + a.lineup.points, 0) / (analyzed.length || 1);

    root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Standings & roster strength')));
    root.append(
        el(
            'div',
            { class: 'card' },
            el(
                'div',
                { class: 'table-scroll' },
                el(
                    'table',
                    { class: 'table' },
                    el(
                        'thead',
                        {},
                        el(
                            'tr',
                            {},
                            el('th', {}, 'Team'),
                            el('th', {}, 'Record'),
                            el('th', { class: 'right' }, 'PF'),
                            el('th', { class: 'right' }, 'PA'),
                            el('th', { class: 'right' }, 'Lineup'),
                            el('th', { class: 'right' }, 'vs avg'),
                            el('th', {}, 'Weak spot')
                        )
                    ),
                    el(
                        'tbody',
                        {},
                        ...analyzed.map((a) => {
                            const weakest = sortBy(
                                Object.entries(a.report.byPosition).filter(([, v]) => v.starting > 0),
                                ([, v]) => v.startingPoints / Math.max(1, v.starting)
                            )[0];
                            const diff = a.lineup.points - leagueAvgLineup;
                            const tr = el(
                                'tr',
                                { style: 'cursor:pointer' },
                                el('td', { style: 'font-weight:600' }, a.team.name),
                                el('td', { class: 'nowrap small' }, `${a.team.wins}-${a.team.losses}${a.team.ties ? `-${a.team.ties}` : ''}`),
                                el('td', { class: 'num right small' }, round(a.team.pointsFor, 0)),
                                el('td', { class: 'num right small' }, round(a.team.pointsAgainst, 0)),
                                el('td', { class: 'num right' }, round(a.lineup.points, 1)),
                                el('td', { class: `num right small ${diff >= 0 ? 'good' : 'bad'}` }, fmtDelta(diff)),
                                el('td', {}, weakest ? posBadge(weakest[0]) : '—')
                            );
                            tr.addEventListener('click', () => showRoster(app, a));
                            return tr;
                        })
                    )
                )
            ),
            el('p', { class: 'tiny dim', style: 'margin:12px 0 0' }, 'Lineup is the optimal starting total per week under your rankings. Click a row for the full roster.')
        )
    );

    return root;
}

function showRoster(app, a) {
    const { cfg } = app.league;
    const startingIds = new Set(a.lineup.starters.map((s) => s.entry.player.id));

    const starterRows = a.lineup.slots.map((s) =>
        el(
            'tr',
            {},
            el('td', { class: 'tiny dim nowrap' }, s.label),
            el('td', {}, s.entry ? playerCell(s.entry.player, { rank: s.entry.posRank }) : el('span', { class: 'dim' }, 'empty')),
            el('td', { class: 'num right small' }, s.entry ? round(s.entry.score, 1) : '—')
        )
    );

    const bench = sortBy(a.entries.filter((e) => !startingIds.has(e.player.id)), (e) => e.score, -1);

    modal({
        title: `${a.team.name} — ${a.team.owner}`,
        width: '700px',
        body: el(
            'div',
            {},
            el(
                'div',
                { class: 'tiles', style: 'margin-bottom:18px' },
                tile('Record', `${a.team.wins}-${a.team.losses}`, `${round(a.team.pointsFor, 0)} PF`),
                tile('Optimal lineup', round(a.lineup.points, 1), 'pts/week'),
                tile('Roster', a.entries.length, `${cfg.rosterSize} max`)
            ),
            el('h3', {}, 'Starters'),
            el('table', { class: 'table' }, el('tbody', {}, ...starterRows)),
            el('h3', { style: 'margin-top:20px' }, `Bench (${bench.length})`),
            bench.length
                ? el(
                      'table',
                      { class: 'table' },
                      el(
                          'tbody',
                          {},
                          ...bench.map((e) =>
                              el(
                                  'tr',
                                  {},
                                  el('td', {}, playerCell(e.player, { rank: e.posRank })),
                                  el('td', { class: 'num right small' }, round(e.score, 1))
                              )
                          )
                      )
                  )
                : el('p', { class: 'muted small' }, 'Empty bench.'),
            el('h3', { style: 'margin-top:20px' }, 'Injury exposure'),
            el(
                'table',
                { class: 'table' },
                el('thead', {}, el('tr', {}, el('th', {}, 'Pos'), el('th', { class: 'right' }, 'Starting pts'), el('th', { class: 'right' }, 'Rostered'), el('th', { class: 'right' }, 'Cost if top man is out'))),
                el(
                    'tbody',
                    {},
                    ...Object.entries(a.report.byPosition).map(([pos, v]) =>
                        el(
                            'tr',
                            {},
                            el('td', {}, posBadge(pos)),
                            el('td', { class: 'num right small' }, round(v.startingPoints, 1)),
                            el('td', { class: 'num right small' }, v.count),
                            el('td', { class: `num right small ${v.dropoff > 10 ? 'bad' : ''}` }, round(v.dropoff, 1))
                        )
                    )
                )
            )
        ),
    });
}
