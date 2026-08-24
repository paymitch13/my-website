// Roster Check — what a rival manager sees when they look at your team.

import { critiqueRoster } from '../critique.js';
import { buildEntries } from '../trade.js';
import { openSyncModal } from '../app.js';
import {
    banner, el, emptyState, fmtDelta, posBadge, round, sortBy, spinnerRow, tag, tile,
} from '../ui.js';

const TONE = { critical: 'bad', warning: 'warn', note: 'neutral', good: 'good' };
const LABEL = { critical: 'Fix this', warning: 'Worth fixing', note: 'Worth knowing', good: 'Working' };

export default function renderCritique(app) {
    const root = el('div', {});

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Roster Check'),
            el(
                'p',
                { class: 'sub' },
                'An honest read on your team. Every other tab answers a question you brought to it; this one ',
                'goes looking. No finding without a number behind it, no criticism without the move that ',
                'fixes it, and no invented problems to pad the page out.'
            )
        )
    );

    if (!app.league) {
        root.append(
            emptyState(
                '🔍',
                'Connect a league first',
                'A roster can only be criticised against the league it plays in.',
                el('button', { class: 'btn btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        return root;
    }

    const teams = sortBy(app.league.teams, (t) => t.name.toLowerCase());
    let selected = teams.find((t) => t.ownerId && t.ownerId === app.userId) || teams[0];

    const host = el('div', {});
    root.append(
        el(
            'div',
            { class: 'card card-tight' },
            el(
                'div',
                { class: 'row' },
                el('span', { class: 'tiny dim' }, 'ROSTER'),
                el(
                    'select',
                    {
                        style: 'max-width:min(340px,100%)',
                        onchange: (e) => {
                            selected = teams.find((t) => String(t.rosterId) === e.target.value);
                            paint();
                        },
                    },
                    ...teams.map((t) =>
                        el('option', { value: String(t.rosterId), selected: t.rosterId === selected.rosterId }, t.name)
                    )
                ),
                el('div', { class: 'grow' }),
                el('span', { class: 'small dim' }, `Week ${app.league.currentWeek}`)
            )
        ),
        host
    );

    function paint() {
        host.replaceChildren(el('div', { class: 'card' }, spinnerRow('Reading the roster…')));
        try {
            host.replaceChildren(build(app, selected));
        } catch (err) {
            console.error(err);
            host.replaceChildren(emptyState('⚠️', 'Could not read that roster', err.message));
        }
    }

    paint();
    return root;
}

function build(app, team) {
    const res = critiqueRoster({
        team,
        teams: app.league.teams,
        cfg: app.league.cfg,
        ctx: app.ctx,
        rankings: app.rankings,
        entriesFor: (t) => buildEntries(t.players, app.rankings, app.ctx),
        byeWeeks: app.byeWeeks,
        restOfSeason: app.restOfSeason,
        playoffSchedule: app.playoffSchedule,
        currentWeek: app.league.currentWeek,
        playoffOdds: app.powerOdds,
    });

    const wrap = el('div', {});
    if (!res.ok) {
        wrap.append(banner(res.error, 'bad'));
        return wrap;
    }

    const problems = res.findings.filter((f) => f.severity !== 'good');
    const critical = problems.filter((f) => f.severity === 'critical').length;

    wrap.append(
        el(
            'div',
            { class: 'tiles' },
            tile('Lineup strength', round(res.lineup.points, 1), `${res.rank} of ${res.of} in the league`),
            tile(
                'Things to fix',
                problems.length,
                critical ? `${critical} of them urgent` : problems.length ? 'none urgent' : 'nothing structural',
                critical ? 'bad' : problems.length ? 'warn' : 'good'
            ),
            tile('Starters', res.lineup.starters.length, `${res.lineup.emptySlots.length} slots unfilled`)
        )
    );

    // The verdict, in one sentence, written from what was actually found.
    wrap.append(
        el(
            'div',
            { class: `verdict tone-${critical ? 'bad' : problems.length ? 'warn' : 'good'}`, style: 'margin-top:20px' },
            el('div', { class: 'label' }, problems.length ? 'The read' : 'Nothing structural'),
            el('div', { class: 'headline' }, res.summary)
        )
    );

    if (!res.findings.length) {
        wrap.append(
            el('div', { class: 'card', style: 'margin-top:20px' },
                el('p', { class: 'muted' },
                    'Nothing to criticise. That is rarer than it sounds and it does not mean the season is ' +
                    'safe — it means your risk is injury rather than construction.'))
        );
        return wrap;
    }

    wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'What a rival sees')));

    for (const f of res.findings) {
        wrap.append(
            el(
                'div',
                { class: 'card', style: 'margin-bottom:12px' },
                el(
                    'div',
                    { class: 'row', style: 'gap:10px;align-items:flex-start' },
                    f.pos ? posBadge(f.pos) : null,
                    el(
                        'div',
                        { style: 'min-width:0;flex:1' },
                        el('div', { style: 'font-weight:650' }, f.title),
                        el('p', { class: 'small muted', style: 'margin:6px 0 0' }, f.detail)
                    ),
                    tag(LABEL[f.severity], TONE[f.severity])
                ),
                el(
                    'div',
                    { class: 'row', style: 'margin-top:12px;gap:10px;align-items:flex-start' },
                    el('span', { class: 'tiny good', style: 'min-width:34px;padding-top:2px' }, 'FIX'),
                    el('span', { class: 'small grow', style: 'min-width:0' }, f.fix),
                    f.action?.view
                        ? el(
                              'button',
                              {
                                  class: 'btn btn-sm',
                                  style: 'white-space:nowrap',
                                  onclick: () => { location.hash = `#/${f.action.view}`; },
                              },
                              f.action.view === 'finder' ? 'Find a trade' : f.action.view === 'vegas' ? 'See the lines' : 'Open'
                          )
                        : null
                )
            )
        );
    }

    wrap.append(
        el('p', { class: 'tiny dim', style: 'margin-top:4px' },
            'Every position number is measured against the other rosters in this league, not against a ' +
            'league-agnostic baseline — a receiver room that is average here may be a hole somewhere else.')
    );

    return wrap;
}
