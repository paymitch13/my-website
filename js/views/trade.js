// Trade Calculator.
//
// Two modes. Connected to a league, it runs the full engine: value, lineup fit
// and simulated playoff/title odds. Without a league it falls back to a value
// ledger, and says so plainly rather than pretending the missing analysis is
// there.

import { evaluateTrade, suggestAddOns, suggestPackages } from '../trade.js';
import { valuePlayer } from '../valuation.js';
import { slotLabel, scoringLabel } from '../league.js';
import { openSyncModal } from '../app.js';
import * as store from '../store.js';
import { byeConflicts } from '../schedule.js';
import { formatValue } from '../tradevalue.js';
import {
    banner, el, fmtDelta, fmtPct, fmtPctDelta, gradeClass, pickPlayer, playerCell,
    playerLink, posBadge, round, sortBy, spinnerRow, tag, tile, toast,
} from '../ui.js';

export default function renderTrade(app) {
    const root = el('div', {});
    const connected = !!app.league;

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Trade Calculator'),
            el(
                'p',
                { class: 'sub' },
                'Value is only a third of the answer. This weighs what each side gives up, what it actually adds to the ',
                'starting lineup, and what it does to the odds of making the playoffs and winning the league.'
            )
        )
    );

    if (!connected) {
        root.append(
            el(
                'div',
                { class: 'banner banner-warn' },
                el('span', { class: 'grow' }, 'Not connected to a league. You can still compare player values, but roster fit, schedule and playoff odds need a synced league.'),
                el('button', { class: 'btn btn-sm btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
            )
        );
        root.append(quickMode(app));
        return root;
    }

    // ---- Full mode --------------------------------------------------------

    const teams = sortBy(app.league.teams, (t) => t.name.toLowerCase());
    // Start on the user's own roster: they are one side of almost every trade
    // they evaluate.
    const mine = teams.find((t) => t.ownerId && t.ownerId === app.userId);
    const stateA = { team: mine || teams[0], sending: [] };
    const stateB = { team: teams.find((t) => t.rosterId !== stateA.team.rosterId) || teams[0], sending: [] };

    // A link from the finder, or pasted from a league chat, pre-fills the deal.
    const shared = app.pendingOffer;
    if (shared) {
        const a = teams.find((t) => t.rosterId === shared.aRoster);
        const b = teams.find((t) => t.rosterId === shared.bRoster);
        if (a && b) {
            const owned = (team, ids) => ids.filter((id) => team.players.some((p) => p.id === id));
            stateA.team = a;
            stateA.sending = owned(a, shared.aSend);
            stateB.team = b;
            stateB.sending = owned(b, shared.bSend);
        }
        app.pendingOffer = null;
    }

    const resultHost = el('div', { style: 'margin-top:24px' });
    const panelA = el('div', { class: 'side-panel' });
    const panelB = el('div', { class: 'side-panel' });

    root.append(
        el(
            'div',
            { class: 'card' },
            el(
                'div',
                { class: 'trade-grid' },
                panelA,
                el(
                    'div',
                    { class: 'trade-mid' },
                    el('div', { class: 'swap-arrows' }, '⇄'),
                    el('button', { class: 'btn btn-sm', title: 'Swap sides', onclick: swapSides }, 'Swap')
                ),
                panelB
            ),
            el(
                'div',
                { class: 'row', style: 'margin-top:18px;justify-content:space-between' },
                el('span', { class: 'small dim' }, `${app.league.cfg.teams}-team ${scoringLabel(app.league.cfg.scoring)}${app.league.cfg.superflex ? ' superflex' : ''} · week ${app.league.currentWeek} · ${app.ctx.weeksLeft} week${app.ctx.weeksLeft === 1 ? '' : 's'} left`),
                el(
                    'div',
                    { class: 'row' },
                    el('button', { class: 'btn btn-sm', onclick: clearAll }, 'Clear'),
                    el('button', { class: 'btn btn-primary', onclick: evaluate }, 'Analyze trade')
                )
            )
        ),
        resultHost
    );

    function paintPanels() {
        paintSide(panelA, stateA, stateB);
        paintSide(panelB, stateB, stateA);
    }

    function paintSide(host, side, other) {
        const select = el(
            'select',
            {
                onchange: (e) => {
                    side.team = teams.find((t) => String(t.rosterId) === e.target.value);
                    side.sending = [];
                    paintPanels();
                    resultHost.replaceChildren();
                },
            },
            ...teams.map((t) =>
                el('option', { value: String(t.rosterId), selected: t.rosterId === side.team.rosterId }, t.name)
            )
        );

        const zone = el('div', { class: `picklist${side.sending.length ? '' : ' empty'}` });
        if (!side.sending.length) {
            zone.append('Nobody selected yet');
        } else {
            for (const id of side.sending) {
                const p = app.players[id];
                if (!p) continue;
                const v = valuePlayer(p, app.rankings.get(p.id) ?? 999, app.ctx);
                zone.append(
                    el(
                        'div',
                        { class: 'chip' },
                        posBadge(p.pos),
                        el('span', { class: 'grow', style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, playerLink(p)),
                        el('span', { class: 'num tiny', style: 'color:var(--accent)' }, formatValue(app.tradeValue(v.value))),
                        el(
                            'button',
                            {
                                class: 'x',
                                title: 'Remove',
                                onclick: () => {
                                    side.sending = side.sending.filter((x) => x !== id);
                                    paintPanels();
                                },
                            },
                            '✕'
                        )
                    )
                );
            }
        }

        host.replaceChildren(
            el(
                'div',
                { class: 'row', style: 'margin-bottom:10px' },
                el('span', { class: 'tiny dim grow' }, `${side.team.wins}-${side.team.losses}${side.team.ties ? `-${side.team.ties}` : ''} · ${round(side.team.pointsFor, 0)} PF`)
            ),
            select,
            el('div', { class: 'tiny dim', style: 'margin:12px 0 6px' }, 'SENDS AWAY'),
            zone,
            el(
                'button',
                { class: 'btn btn-sm', style: 'margin-top:10px;width:100%', onclick: () => addPlayer(side) },
                '+ Add player'
            )
        );
    }

    async function addPlayer(side) {
        const taken = new Set(side.sending);
        const entries = sortBy(
            side.team.players
                .filter((p) => !taken.has(p.id))
                .map((p) => {
                    const posRank = app.rankings.get(p.id) ?? 999;
                    return { player: p, posRank, value: valuePlayer(p, posRank, app.ctx).value };
                }),
            (e) => e.value,
            -1
        );

        const chosen = await pickPlayer({
            title: `${side.team.name} sends…`,
            entries,
            emptyText: 'Every player on this roster is already in the deal.',
        });
        if (!chosen) return;
        side.sending.push(chosen.player.id);
        paintPanels();
    }

    function swapSides() {
        const t = stateA.team;
        const s = stateA.sending;
        stateA.team = stateB.team;
        stateA.sending = stateB.sending;
        stateB.team = t;
        stateB.sending = s;
        paintPanels();
        resultHost.replaceChildren();
    }

    function clearAll() {
        stateA.sending = [];
        stateB.sending = [];
        paintPanels();
        resultHost.replaceChildren();
    }

    function evaluate() {
        if (!stateA.sending.length || !stateB.sending.length) {
            toast('Add at least one player to each side.', 'bad');
            return;
        }
        if (stateA.team.rosterId === stateB.team.rosterId) {
            toast('Pick two different teams.', 'bad');
            return;
        }

        resultHost.replaceChildren(el('div', { class: 'card' }, spinnerRow('Simulating the rest of the season both ways…')));

        (async () => {
            const result = await evaluateTrade({
                cfg: app.league.cfg,
                ctx: app.ctx,
                teams: app.league.teams,
                rankings: app.rankings,
                schedule: app.league.schedule,
                iterations: store.state.settings.simIterations || 2000,
                offers: [
                    { rosterId: stateA.team.rosterId, sending: stateA.sending },
                    { rosterId: stateB.team.rosterId, sending: stateB.sending },
                ],
            });

            if (!result.ok) {
                resultHost.replaceChildren(banner(result.error, 'bad'));
                return;
            }
            resultHost.replaceChildren(renderResult(app, result, () => paintPanels()));
            panelA.classList.toggle('is-winner', result.verdict.winner === stateA.team.rosterId);
            panelB.classList.toggle('is-winner', result.verdict.winner === stateB.team.rosterId);
        })().catch((err) => {
            console.error(err);
            resultHost.replaceChildren(banner(`Could not evaluate the trade: ${err.message}`, 'bad'));
        });
    }

    paintPanels();
    // A pre-filled deal should show its verdict without another click.
    if (stateA.sending.length && stateB.sending.length) setTimeout(evaluate, 0);
    return root;
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

function renderResult(app, result, repaint) {
    const wrap = el('div', {});
    const [a, b] = result.sides;

    // Verdict banner
    const totalIn = Math.abs(a.valueIn) + Math.abs(b.valueIn) || 1;
    const shareA = Math.max(4, (Math.abs(a.valueIn) / totalIn) * 100);

    wrap.append(
        el(
            'div',
            { class: `verdict tone-${result.verdict.tone}` },
            el(
                'div',
                { class: 'row', style: 'align-items:flex-start;gap:20px' },
                el(
                    'div',
                    { class: 'grow' },
                    el('div', { class: 'label' }, result.verdict.label),
                    el('div', { class: 'headline' }, result.verdict.headline)
                ),
                el(
                    'div',
                    { class: 'row', style: 'gap:10px' },
                    gradeBlock(a),
                    gradeBlock(b)
                )
            ),
            el(
                'div',
                { class: 'meter' },
                el('i', { class: 'fill-a', style: `width:${shareA}%` }),
                el('i', { class: 'fill-b', style: `width:${100 - shareA}%` })
            ),
            el(
                'div',
                { class: 'meter-labels' },
                el('span', {}, `${a.team.name} receives ${formatValue(app.tradeValue(a.valueIn))}`),
                el('span', {}, `${formatValue(app.tradeValue(b.valueIn))} to ${b.team.name}`)
            )
        )
    );

    // Headline tiles
    const tiles = el('div', { class: 'tiles', style: 'margin-top:20px' });
    for (const side of result.sides) {
        tiles.append(
            tile(
                `${side.team.name} — lineup`,
                fmtDelta(side.lineupNet),
                `pts/week · ${fmtDelta(side.rosLineupPoints, 0)} rest of season`,
                side.lineupNet >= 0 ? 'good' : 'bad'
            )
        );
    }
    if (result.mode === 'full') {
        for (const side of result.sides) {
            tiles.append(
                tile(
                    `${side.team.name} — playoffs`,
                    fmtPctDelta(side.playoffDelta),
                    `${fmtPct(side.playoffBefore)} → ${fmtPct(side.playoffAfter)}`,
                    side.playoffDelta >= 0 ? 'good' : 'bad'
                )
            );
        }
        for (const side of result.sides) {
            tiles.append(
                tile(
                    `${side.team.name} — title`,
                    fmtPctDelta(side.titleDelta),
                    `${fmtPct(side.titleBefore, 1)} → ${fmtPct(side.titleAfter, 1)}`,
                    side.titleDelta >= 0 ? 'good' : 'bad'
                )
            );
        }
    }
    wrap.append(tiles);

    // Bye stacking is invisible in a value ledger and decides real weeks.
    for (const side of result.sides) {
        const after = side.after.map((e) => e.player);
        const before = side.before.map((e) => e.player);
        const week = app.league.currentWeek;
        const newTrouble = byeConflicts(after, app.byeWeeks, { fromWeek: week, minPlayers: 3 })
            .filter((c) => {
                const had = byeConflicts(before, app.byeWeeks, { fromWeek: week, minPlayers: 3 })
                    .find((x) => x.week === c.week);
                return !had || c.players.length > had.players.length;
            });
        for (const c of newTrouble.slice(0, 2)) {
            wrap.append(
                banner(
                    `${side.team.name} would have ${c.players.length} players on bye in week ${c.week} after this trade: ${c.players.map((p) => p.name).join(', ')}.`,
                    'warn'
                )
            );
        }
    }

    // Why
    wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Why'), el('span', { class: 'hint' }, 'ranked by how much it matters')));
    const reasons = el('div', { class: 'card' });
    for (const r of result.reasons.slice(0, 12)) {
        reasons.append(
            el(
                'div',
                { class: `reason k-${r.kind}` },
                el('div', {}, el('div', { class: 'r-title' }, r.title), el('div', { class: 'r-detail' }, r.detail))
            )
        );
    }
    if (!result.reasons.length) reasons.append(el('p', { class: 'muted' }, 'Nothing notable — this deal barely moves either roster.'));
    wrap.append(reasons);

    // Lineup impact side by side
    wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'Lineup impact')));
    wrap.append(
        el(
            'div',
            { class: 'grid grid-2' },
            lineupCard(app, a),
            lineupCard(app, b)
        )
    );

    // How to actually get this accepted
    const loser = result.sides.find((s) => s.team.rosterId === result.verdict.loser);
    const winner = result.sides.find((s) => s.team.rosterId === result.verdict.winner);
    if (loser && winner && result.verdict.gap > 0.08) {
        const gap = Math.max(1, winner.valueNet);
        const picks = suggestAddOns({ cfg: app.league.cfg, ctx: app.ctx, giver: winner, receiver: loser, gap, limit: 4 });
        const packages = suggestPackages({ cfg: app.league.cfg, ctx: app.ctx, giver: winner, receiver: loser, gap, limit: 2 });

        if (picks.length || packages.length) {
            wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'How to get this accepted')));
            const card = el('div', { class: 'card' });
            card.append(
                el(
                    'p',
                    { class: 'muted small' },
                    `${loser.team.name} is short about ${formatValue(app.tradeValue(gap))} in value. These are players ${winner.team.name} can most afford to lose that ${loser.team.name} can most use:`
                )
            );

            for (const p of picks) {
                card.append(
                    el(
                        'div',
                        { class: 'suggest' },
                        el(
                            'div',
                            { class: 'suggest-main' },
                            playerCell(p.player, { rank: p.posRank }),
                            el('div', { class: 'suggest-why' }, p.rationale)
                        ),
                        el(
                            'div',
                            { class: 'suggest-meta' },
                            p.mutual ? tag('helps both', 'good') : p.overshoot ? tag('overshoots', 'warn') : tag(`closes ~${p.closes}%`, ''),
                            el(
                                'div',
                                { class: 'tiny dim nowrap' },
                                `+${p.gainToReceiver} pts/wk to ${loser.team.name.split(' ')[0]} · −${p.costToGiver} to give up`
                            )
                        )
                    )
                );
            }

            if (packages.length) {
                card.append(el('h3', { style: 'margin-top:18px' }, 'Or as a package'));
                for (const pk of packages) {
                    card.append(
                        el(
                            'div',
                            { class: 'suggest' },
                            el(
                                'div',
                                { class: 'suggest-main' },
                                el(
                                    'div',
                                    { class: 'row', style: 'gap:6px' },
                                    ...pk.players.map((pl) =>
                                        el('span', { class: 'chip', style: 'padding:4px 8px' }, posBadge(pl.pos), playerLink(pl))
                                    )
                                ),
                                el('div', { class: 'suggest-why' }, `Together they add ${pk.gainToReceiver} pts/wk to the lineup receiving them.`)
                            ),
                            el('div', { class: 'suggest-meta' }, tag(`closes ~${pk.closes}%`, pk.closes >= 85 && pk.closes <= 120 ? 'good' : ''))
                        )
                    );
                }
            }
            wrap.append(card);
        }
    }

    if (result.mode !== 'full') {
        wrap.append(
            banner('Playoff and title odds need a synced league with a remaining schedule — this trade was scored on value and roster fit only.', 'warn')
        );
    }

    return wrap;
}

function gradeBlock(side) {
    return el(
        'div',
        { class: 'center' },
        el('div', { class: `grade ${gradeClass(side.grade.letter)}` }, side.grade.letter),
        el('div', { class: 'tiny dim', style: 'margin-top:4px;max-width:90px' }, side.team.name)
    );
}

function lineupCard(app, side) {
    const slots = side.lineupAfter.slots;
    const beforeById = new Map(
        side.lineupBefore.slots.filter((s) => s.entry).map((s) => [s.index, s.entry.player.id])
    );

    const rows = slots.map((s) => {
        const p = s.entry?.player;
        const changed = p && beforeById.get(s.index) !== p.id;
        return el(
            'tr',
            { style: changed ? 'background:rgba(79,209,197,0.07)' : null },
            el('td', { class: 'tiny dim nowrap' }, slotLabel(s.slot)),
            el(
                'td',
                {},
                p
                    ? el(
                          'div',
                          { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
                          posBadge(p.pos),
                          el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, playerLink(p)),
                          changed ? tag('new', 'accent') : null
                      )
                    : el('span', { class: 'dim' }, 'empty')
            ),
            el('td', { class: 'num right small' }, s.entry ? round(s.entry.score, 1) : '—')
        );
    });

    const swing = Object.entries(side.positionSwing)
        .filter(([, v]) => Math.abs(v.startingDelta) > 0.05)
        .sort((x, y) => y[1].startingDelta - x[1].startingDelta);

    return el(
        'div',
        { class: 'card' },
        el(
            'div',
            { class: 'row', style: 'margin-bottom:12px' },
            el('h3', { class: 'grow', style: 'margin:0' }, side.team.name),
            el(
                'span',
                { class: `num ${side.lineupNet >= 0 ? 'good' : 'bad'}` },
                `${fmtDelta(side.lineupNet)} pts/wk`
            )
        ),
        swing.length
            ? el(
                  'div',
                  { class: 'row', style: 'margin-bottom:12px;gap:6px' },
                  ...swing.map(([pos, v]) =>
                      tag(`${pos} ${fmtDelta(v.startingDelta)}`, v.startingDelta > 0 ? 'good' : 'bad')
                  )
              )
            : null,
        el('div', { class: 'table-scroll' }, el('table', { class: 'table' }, el('tbody', {}, ...rows))),
        el(
            'div',
            { class: 'tiny dim', style: 'margin-top:10px' },
            `Roster ${side.rosterBefore} → ${side.rosterAfter}. Projected starting total ${round(side.lineupBefore.points, 1)} → ${round(side.lineupAfter.points, 1)} pts/week.`
        )
    );
}

// ---------------------------------------------------------------------------
// Quick mode (no league connected)
// ---------------------------------------------------------------------------

function quickMode(app) {
    const wrap = el('div', { class: 'card' });
    const sideA = [];
    const sideB = [];
    const out = el('div', { style: 'margin-top:20px' });

    const pool = () =>
        sortBy(
            Object.values(app.players)
                .filter((p) => (app.rankings.get(p.id) ?? 999) < 900)
                .map((p) => {
                    const posRank = app.rankings.get(p.id);
                    return { player: p, posRank, value: valuePlayer(p, posRank, app.ctx).value };
                }),
            (e) => e.value,
            -1
        );

    async function add(list) {
        // A player cannot be on both sides of a trade. Full mode enforces this
        // structurally; quick mode has to do it explicitly.
        const taken = new Set([...sideA, ...sideB].map((e) => e.player.id));
        const chosen = await pickPlayer({
            title: 'Add a player',
            entries: pool().filter((e) => !taken.has(e.player.id)),
        });
        if (!chosen) return;
        list.push(chosen);
        paint();
    }

    function column(title, list) {
        const zone = el('div', { class: `picklist${list.length ? '' : ' empty'}` });
        if (!list.length) zone.append('Nobody selected yet');
        for (const e of list) {
            zone.append(
                el(
                    'div',
                    { class: 'chip' },
                    posBadge(e.player.pos),
                    el('span', { class: 'grow' }, playerLink(e.player)),
                    el('span', { class: 'num tiny', style: 'color:var(--accent)' }, round(e.value, 0)),
                    el(
                        'button',
                        {
                            class: 'x',
                            onclick: () => {
                                list.splice(list.indexOf(e), 1);
                                paint();
                            },
                        },
                        '✕'
                    )
                )
            );
        }
        return el(
            'div',
            { class: 'side-panel' },
            el('div', { class: 'tiny dim', style: 'margin-bottom:8px' }, title),
            zone,
            el('button', { class: 'btn btn-sm', style: 'margin-top:10px;width:100%', onclick: () => add(list) }, '+ Add player')
        );
    }

    function paint() {
        const va = sideA.reduce((s, e) => s + e.value, 0);
        const vb = sideB.reduce((s, e) => s + e.value, 0);
        const total = va + vb || 1;

        wrap.replaceChildren(
            el(
                'div',
                { class: 'trade-grid' },
                column('SIDE A SENDS AWAY', sideA),
                el('div', { class: 'trade-mid' }, el('div', { class: 'swap-arrows' }, '⇄')),
                column('SIDE B SENDS AWAY', sideB)
            ),
            out
        );

        if (!sideA.length || !sideB.length) {
            out.replaceChildren(el('p', { class: 'muted small', style: 'margin-top:16px' }, 'Add at least one player to each side.'));
            return;
        }

        // Side A sends `sideA`, so Side A RECEIVES the value of sideB.
        const receivesA = vb;
        const receivesB = va;
        const diff = receivesA - receivesB;
        const pctGap = Math.abs(diff) / Math.max(receivesA, receivesB);
        const label = pctGap < 0.07 ? 'Even' : `${diff > 0 ? 'Side A' : 'Side B'} wins the value`;
        const tone = pctGap < 0.07 ? 'neutral' : pctGap < 0.2 ? 'warn' : 'bad';

        out.replaceChildren(
            el(
                'div',
                { class: `verdict tone-${tone}`, style: 'margin-top:20px' },
                el('div', { class: 'label' }, label),
                el(
                    'div',
                    { class: 'headline' },
                    `Side A receives ${round(receivesA, 0)}, Side B receives ${round(receivesB, 0)} rest-of-season points above replacement — a gap of ${round(pctGap * 100, 0)}%. This is the ledger only; connect a league to see whether either side can actually start these players.`
                ),
                el(
                    'div',
                    { class: 'meter' },
                    el('i', { class: 'fill-a', style: `width:${(receivesA / total) * 100}%` }),
                    el('i', { class: 'fill-b', style: `width:${(receivesB / total) * 100}%` })
                )
            )
        );
    }

    paint();
    return wrap;
}
