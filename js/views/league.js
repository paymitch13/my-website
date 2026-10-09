// League — settings, standings and roster inspection.

import { optimizeLineup, positionalReport } from '../lineup.js';
import { buildEntries } from '../trade.js';
import { ALL_POS, hasDedicatedSlot, scoringLabel, slotLabel } from '../league.js';
import { openSyncModal } from '../app.js';
import {
    banner, el, emptyState, fmtDelta, modal, playerCell, posBadge, round, sortBy, tag, tile,
} from '../ui.js';

export default function renderLeague(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'League'),
            el('p', { class: 'sub' }, 'Every setting the calculator reads, and how each roster grades out under the model’s rankings.')
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
                : null,
            slotReading(app, cfg)
        )
    );

    // ---- Standings --------------------------------------------------------

    const analyzed = sortBy(
        teams.map((t) => {
            const entries = buildEntries(t.players, app.rankings, app.ctx);
            const lineup = optimizeLineup(entries, cfg.starterSlots);
            return { team: t, entries, lineup, report: positionalReport(entries, cfg.starterSlots) };
        }),
        // Half a win per tie, matching how the simulator seeds standings.
        (a) => (a.team.wins + 0.5 * (a.team.ties || 0)) * 10000 + a.team.pointsFor,
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
                            el('th', { class: 'right hide-sm' }, 'PF'),
                            el('th', { class: 'right hide-sm' }, 'PA'),
                            el('th', { class: 'right' }, 'Lineup'),
                            el('th', { class: 'right' }, 'vs avg'),
                            // Remaining budget is a real strategic dimension
                            // nobody tracks: it says who can still win a claim
                            // and who cannot, and it is what makes the cash
                            // numbers in the calculator mean anything.
                            cfg.usesFaab ? el('th', { class: 'right hide-sm' }, 'FAAB') : null,
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
                                el('td', { class: 'team-cell' }, el('span', { class: 'team-name', title: a.team.name }, a.team.name)),
                                el('td', { class: 'nowrap small' }, `${a.team.wins}-${a.team.losses}${a.team.ties ? `-${a.team.ties}` : ''}`),
                                el('td', { class: 'num right small hide-sm' }, round(a.team.pointsFor, 0)),
                                el('td', { class: 'num right small hide-sm' }, round(a.team.pointsAgainst, 0)),
                                el('td', { class: 'num right' }, round(a.lineup.points, 1)),
                                el('td', { class: `num right small ${diff >= 0 ? 'good' : 'bad'}` }, fmtDelta(diff)),
                                cfg.usesFaab
                                    ? el(
                                          'td',
                                          {
                                              class: `num right small ${(a.team.faabRemaining ?? 0) <= 5 ? 'bad' : ''}`,
                                              title: `$${a.team.faabUsed ?? 0} of $${cfg.faabBudget} spent`,
                                          },
                                          `$${a.team.faabRemaining ?? 0}`
                                      )
                                    : null,
                                el('td', {}, weakest ? posBadge(weakest[0]) : '—')
                            );
                            tr.addEventListener('click', () => showRoster(app, a));
                            return tr;
                        })
                    )
                )
            ),
            el(
                'p',
                { class: 'tiny dim', style: 'margin:12px 0 0' },
                'Lineup is the optimal starting total per week under the model’s rankings. Click a row for the full roster.',
                cfg.usesFaab ? ' FAAB is what each manager has left to bid with — a team near zero cannot answer a waiver run, and cash is worth less in their hands.' : ''
            )
        )
    );

    return root;
}

/**
 * How the app read this league's roster slots, shown rather than assumed.
 *
 * Every value in the app hangs off which positions can start where. A league
 * with two flexes and no dedicated tight end slot is a completely different
 * pricing problem from one with a TE slot, and until this panel existed a
 * manager who thought the app had it wrong had no way to check -- the
 * interpretation only ever showed up as numbers several steps downstream. So
 * the chain is printed in full: the slot, the positions the app believes can
 * fill it, how many starters a team that follows the league's habits ends up
 * with at each position, and the waiver line that follows from it.
 */
function slotReading(app, cfg) {
    const seen = new Map();
    for (const slot of cfg.starterSlots) seen.set(slot, (seen.get(slot) || 0) + 1);

    const slotRows = [...seen.entries()].map(([slot, count]) => {
        const positions = cfg.slotPositions?.[slot] ?? [];
        const unreadable = !positions.length;
        return el(
            'tr',
            {},
            el('td', { class: 'small' }, count > 1 ? `${slotLabel(slot)} ×${count}` : slotLabel(slot)),
            el(
                'td',
                { class: 'small right' },
                unreadable
                    ? el('span', { class: 'bad' }, 'not understood')
                    : el('span', { class: 'row', style: 'gap:4px;justify-content:flex-end' }, ...positions.map((p) => posBadge(p)))
            )
        );
    });

    const ctx = app.ctx;
    const posRows = ALL_POS.filter((pos) => (cfg.startersByPos[pos] || 0) > 0).map((pos) => {
        const starters = cfg.startersByPos[pos] || 0;
        const required = hasDedicatedSlot(cfg, pos);
        const basis = ctx?.replacementBasis?.[pos] ?? null;
        const line = ctx?.replacementPpg?.[pos] ?? null;
        return el(
            'tr',
            {},
            el('td', {}, posBadge(pos)),
            el('td', { class: 'num right small' }, starters.toFixed(2)),
            el(
                'td',
                { class: 'small right' },
                required
                    ? el('span', { class: 'dim' }, 'required')
                    : el('span', { class: 'accent' }, 'flex only')
            ),
            el(
                'td',
                { class: 'num right small' },
                basis
                    ? el(
                          'span',
                          {},
                          `${basis.pooled ? basis.positions.join('/') : pos} ${basis.rank}`,
                          line === null
                              ? null
                              : el('span', { class: 'dim' }, ` · ${round(line, 1)} pts`)
                      )
                    : '—'
            )
        );
    });

    const unreadable = cfg.unreadableSlots || [];

    return el(
        'div',
        { style: 'margin-top:14px' },
        unreadable.length
            ? banner(
                  `This league has starting slot${unreadable.length === 1 ? '' : 's'} named ${unreadable.join(', ')} that the calculator could not interpret. ` +
                      'They are left out of lineup solving, so every roster will look a starter short. Tell me the slot names and I can add them.',
                  'bad'
              )
            : null,
        el(
            'details',
            { class: 'tiny' },
            el('summary', { class: 'dim' }, 'How these slots were read, and what follows from them'),
            el(
                'div',
                { class: 'slot-read' },
                el(
                    'div',
                    {},
                    el('div', { class: 'tiny dim', style: 'margin-bottom:6px' }, 'Who can fill each slot'),
                    el('table', { class: 'table' }, el('tbody', {}, ...slotRows))
                ),
                el(
                    'div',
                    {},
                    el('div', { class: 'tiny dim', style: 'margin-bottom:6px' }, 'What that makes each position worth'),
                    el(
                        'table',
                        { class: 'table' },
                        el(
                            'thead',
                            {},
                            el(
                                'tr',
                                {},
                                el('th', {}, ''),
                                el('th', { class: 'right' }, 'Starters/team'),
                                el('th', { class: 'right' }, 'In your lineup'),
                                el('th', { class: 'right' }, 'Waiver line')
                            )
                        ),
                        el('tbody', {}, ...posRows)
                    )
                )
            ),
            el(
                'p',
                { class: 'tiny dim', style: 'margin:10px 0 0' },
                '“Starters/team” is fractional because a flex is shared: it is how many of that position a team ends up starting on average, not how many slots it has. ' +
                    'A position marked “flex only” is never forced into your lineup, so leaving it empty is a choice and the app will not call it a hole. ' +
                    'Positions that share a flex share one waiver line, read off their combined board — which is why the line is named after the group rather than the position.'
            )
        )
    );
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
