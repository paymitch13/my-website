// Trade Calculator.
//
// Two modes. Connected to a league, it runs the full engine: value, lineup fit
// and simulated playoff/title odds. Without a league it falls back to a value
// ledger, and says so plainly rather than pretending the missing analysis is
// there.

import { evaluateTrade, suggestAddOns, suggestPackages, suggestFaab } from '../trade.js';
import { valuePlayer } from '../valuation.js';
import { slotLabel, scoringLabel } from '../league.js';
import { openSyncModal, connectLeague } from '../app.js';
import * as store from '../store.js';
import { byeConflicts } from '../schedule.js';
import { formatValue, fairness } from '../tradevalue.js';
import { offerUrl } from '../share.js';
import { bidHistory, waiverTargets, estimateBid } from '../faab.js';
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

    // A pasted link names the league it came from. Roster ids are meaningless
    // without it, so offer the one-click sync rather than showing an empty
    // calculator to somebody who followed a link about a specific deal.
    const linkedLeague = app.pendingOffer?.leagueId || null;

    if (!connected) {
        root.append(
            linkedLeague
                ? el(
                      'div',
                      { class: 'banner banner-warn' },
                      el('span', { class: 'grow' }, 'This trade link is for a league you have not synced yet. Connect it to see roster fit, schedule and playoff odds for the deal.'),
                      el('button', { class: 'btn btn-sm btn-primary', onclick: () => connectLeague(linkedLeague) }, 'Sync that league')
                  )
                : el(
                      'div',
                      { class: 'banner banner-warn' },
                      el('span', { class: 'grow' }, 'Not connected to a league. You can still compare player values, but roster fit, schedule and playoff odds need a synced league.'),
                      el('button', { class: 'btn btn-sm btn-primary', onclick: openSyncModal }, 'Connect Sleeper')
                  )
        );
        root.append(quickMode(app));
        return root;
    }

    // Connected, but to a different league than the link describes. Silently
    // matching roster 3 against whatever roster 3 is here would render a deal
    // between the wrong two teams and look authoritative doing it.
    if (linkedLeague && String(linkedLeague) !== String(app.league.cfg.id)) {
        root.append(
            el(
                'div',
                { class: 'banner banner-warn' },
                el('span', { class: 'grow' }, `This trade link is from a different league than ${app.league.cfg.name}. Switch to it to load the deal.`),
                el('button', { class: 'btn btn-sm btn-primary', onclick: () => connectLeague(linkedLeague) }, 'Switch league')
            )
        );
        app.pendingOffer = null;
    }

    // ---- Full mode --------------------------------------------------------

    const teams = sortBy(app.league.teams, (t) => t.name.toLowerCase());
    // Start on the user's own roster: they are one side of almost every trade
    // they evaluate.
    const mine = teams.find((t) => t.ownerId && t.ownerId === app.userId);
    const stateA = { team: mine || teams[0], sending: [], faab: 0 };
    const stateB = { team: teams.find((t) => t.rosterId !== stateA.team.rosterId) || teams[0], sending: [], faab: 0 };

    // A link from the finder, or pasted from a league chat, pre-fills the deal.
    const shared = app.pendingOffer;
    if (shared) {
        const a = teams.find((t) => t.rosterId === shared.aRoster);
        const b = teams.find((t) => t.rosterId === shared.bRoster);
        if (a && b) {
            const owned = (team, ids) => ids.filter((id) => team.players.some((p) => p.id === id));
            stateA.team = a;
            stateA.sending = owned(a, shared.aSend);
            stateA.faab = Math.min(shared.aFaab || 0, a.faabRemaining ?? 0);
            stateB.team = b;
            stateB.sending = owned(b, shared.bSend);
            stateB.faab = Math.min(shared.bFaab || 0, b.faabRemaining ?? 0);
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
                    // A different roster has a different budget, so any cash
                    // already dialled in may no longer be legal to send.
                    side.faab = 0;
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
            ),
            faabRow(side)
        );
    }

    /**
     * Cash on this side of the deal. Only rendered in a FAAB league, because in
     * a rolling-waiver league there is nothing to send and a disabled stepper
     * is just clutter.
     *
     * The counterparty's remaining budget is shown as well: knowing they have
     * $2 left tells you cash will not move them, and that is the single most
     * useful fact about the other side's wallet.
     */
    function faabRow(side) {
        const cfg = app.league.cfg;
        if (!cfg.usesFaab) return null;

        const budget = side.team.faabRemaining ?? 0;

        const input = el('input', {
            type: 'number',
            min: '0',
            max: String(budget),
            step: '1',
            value: String(side.faab),
            style: 'width:78px;text-align:center',
            'aria-label': `FAAB sent by ${side.team.name}`,
        });
        const minus = el('button', {
            class: 'btn btn-sm', style: 'padding:4px 10px', 'aria-label': 'Send less FAAB',
        }, '−');
        const plus = el('button', {
            class: 'btn btn-sm', style: 'padding:4px 10px', 'aria-label': 'Send more FAAB',
        }, '+');
        const budgetLine = el('div', { class: 'tiny dim', style: 'margin-top:4px' });
        const worthLine = el('div', { class: 'tiny', style: 'margin-top:4px;color:var(--accent)' });

        // Updated IN PLACE rather than by repainting the panel. Repainting from
        // inside the input's own change handler tears out the element the
        // browser is mid-blur on, which throws -- and it also stole focus on
        // every keystroke, so holding the stepper was unusable.
        function sync(next) {
            side.faab = Math.max(0, Math.min(budget, Math.round(next) || 0));
            if (input.value !== String(side.faab)) input.value = String(side.faab);
            minus.disabled = side.faab <= 0;
            plus.disabled = side.faab >= budget;
            budgetLine.textContent = budget > 0
                ? `$${budget - side.faab} of $${cfg.faabBudget} would be left`
                : 'No budget left to send';
            worthLine.textContent = side.faab > 0 && app.faab?.usable
                ? `worth about ${round(app.faab.valueOf(side.faab, side.team), 1)} rest-of-season points`
                : '';
            // The old analysis described a different trade.
            resultHost.replaceChildren();
        }

        input.addEventListener('change', () => sync(Number(input.value)));
        input.addEventListener('input', () => sync(Number(input.value)));
        minus.addEventListener('click', () => sync(side.faab - 1));
        plus.addEventListener('click', () => sync(side.faab + 1));
        sync(side.faab);

        return el(
            'div',
            { style: 'margin-top:12px' },
            el(
                'div',
                { class: 'row', style: 'gap:6px' },
                el('span', { class: 'tiny dim grow' }, 'FAAB'),
                minus,
                input,
                plus
            ),
            budgetLine,
            worthLine
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
            // The picker and the panel show the same player one click apart.
            // They have to be the same number.
            formatValue: (v) => formatValue(app.tradeValue(v)),
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
        // A player-for-cash trade is a real trade, so a side sending only money
        // is complete. A side sending nothing at all is not.
        const empty = (s) => !s.sending.length && !(s.faab > 0);
        if (empty(stateA) || empty(stateB)) {
            toast('Each side has to send a player or some FAAB.', 'bad');
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
                faab: app.faab,
                offers: [
                    { rosterId: stateA.team.rosterId, sending: stateA.sending, faab: stateA.faab },
                    { rosterId: stateB.team.rosterId, sending: stateB.sending, faab: stateB.faab },
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

    // Verdict banner.
    // The meter and the numbers printed under it must be the same quantity.
    // Splitting the bar on raw points while labelling it with scaled values put
    // 67/33 above text that read 72/28.
    const scaledA = app.tradeValue(a.valueIn);
    const scaledB = app.tradeValue(b.valueIn);
    const split = fairness(scaledA, scaledB);
    const shareA = Math.max(4, Math.min(96, split.aShare * 100));

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
                el('span', {}, `${a.team.name} receives ${formatValue(scaledA)}`),
                el('span', {}, `${formatValue(scaledB)} to ${b.team.name}`)
            ),
            // A trade you cannot send is a trade that does not happen. The
            // link carries the league, both sides and any cash, so pasting it
            // in the league chat reproduces exactly this deal.
            el(
                'div',
                { class: 'row', style: 'margin-top:14px' },
                el(
                    'button',
                    {
                        class: 'btn btn-sm',
                        onclick: () => {
                            const url = offerUrl({
                                leagueId: app.league?.cfg?.id ?? null,
                                aRoster: a.team.rosterId,
                                aSend: a.side.sending,
                                aFaab: a.faabOut || 0,
                                bRoster: b.team.rosterId,
                                bSend: b.side.sending,
                                bFaab: b.faabOut || 0,
                            });
                            navigator.clipboard?.writeText(url).then(
                                () => toast('Trade link copied — paste it in your league chat', 'good'),
                                () => toast(url, '')
                            );
                        },
                    },
                    'Copy link to this trade'
                )
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

    // What the cash actually buys, whenever cash is in the deal. A dollar
    // figure means nothing on its own; the players it could claim, at prices
    // this league has actually paid, is the thing a manager can judge.
    const cashSide = result.sides.find((s) => (s.faabIn || 0) > 0);
    if (cashSide && app.faab?.usable) wrap.append(cashBuysCard(app, cashSide));

    // How to actually get this accepted
    const loser = result.sides.find((s) => s.team.rosterId === result.verdict.loser);
    const winner = result.sides.find((s) => s.team.rosterId === result.verdict.winner);
    if (loser && winner && result.verdict.gap > 0.08) {
        // The gap has to be computed in the SAME space it is displayed in.
        // Pushing a difference through a per-player convex curve anchored to
        // the league's best player is a category error: the result cannot be
        // reconciled against the add-on values printed right beneath it.
        const gap = Math.max(1, winner.valueNet);
        const scaledGap = Math.max(
            0,
            app.tradeValue(winner.valueIn) - app.tradeValue(winner.valueOut)
        );
        const picks = suggestAddOns({ cfg: app.league.cfg, ctx: app.ctx, giver: winner, receiver: loser, gap, limit: 4 });
        const packages = suggestPackages({ cfg: app.league.cfg, ctx: app.ctx, giver: winner, receiver: loser, gap, limit: 2 });
        // Cash is often the only thing that closes a gap cleanly: it costs the
        // giver no lineup points and takes no roster spot on the other side.
        const cash = suggestFaab({ faab: app.faab, giver: winner, receiver: loser, gap });

        if (picks.length || packages.length || cash) {
            wrap.append(el('div', { class: 'section-head' }, el('h2', {}, 'How to get this accepted')));
            const card = el('div', { class: 'card' });
            card.append(
                el(
                    'p',
                    { class: 'muted small' },
                    `${loser.team.name} is short about ${formatValue(scaledGap)} in value. These are players ${winner.team.name} can most afford to lose that ${loser.team.name} can most use:`
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

            if (cash) {
                card.append(
                    el(
                        'div',
                        { class: 'suggest' },
                        el(
                            'div',
                            { class: 'suggest-main' },
                            el(
                                'div',
                                { class: 'row', style: 'gap:8px' },
                                el('span', { class: 'chip', style: 'padding:4px 10px;font-weight:700' }, `$${cash.dollars} FAAB`),
                                el('span', { class: 'tiny dim' }, `${winner.team.name} would have $${cash.remainingAfter} left`)
                            ),
                            el('div', { class: 'suggest-why' }, cash.rationale)
                        ),
                        el(
                            'div',
                            { class: 'suggest-meta' },
                            cash.short ? tag(`closes ~${cash.closes}%`, 'warn') : tag('costs no points', 'good'),
                            // On the market scale, like the gap right above it.
                            // Quoting cash in raw points beside a gap quoted in
                            // market value gives the reader two numbers that
                            // cannot be reconciled.
                            el('div', { class: 'tiny dim nowrap' },
                                `${formatValue(Math.max(0, app.tradeValue(loser.valueIn + cash.value) - app.tradeValue(loser.valueIn)))} in value`)
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

/**
 * The waiver wire, from the point of view of the manager being handed money.
 *
 * "$40" is not a fact anybody can weigh against a running back. "$40, and here
 * is what it claims, at what this league has actually paid" is.
 */
function cashBuysCard(app, side) {
    const cfg = app.league.cfg;
    const model = app.faab;
    const history = bidHistory(model);
    const entries = side.after;
    const targets = waiverTargets({
        freeAgents: app.freeAgentEntries(),
        entries,
        cfg,
        trending: app.trendingAdds || null,
        limit: 5,
    });

    const card = el('div', { class: 'card' });

    card.append(
        el(
            'p',
            { class: 'muted small', style: 'margin-top:0' },
            `${side.team.name} would take on $${side.faabIn}, leaving $${(side.team.faabRemaining ?? 0) + side.faabIn - (side.faabOut || 0)} to bid with. `,
            history
                ? `This league has settled ${history.samples} claim${history.samples === 1 ? '' : 's'} at a median of $${history.median}, and nobody has paid more than $${history.max} — ${history.richest.player.name}.`
                : 'Nobody has bid yet this season, so the prices below are modelled rather than observed.'
        )
    );

    if (targets.length) {
        card.append(el('h3', { style: 'margin-top:16px' }, 'What it could claim'));
        for (const t of targets) {
            const estimate = estimateBid(model, t);
            card.append(
                el(
                    'div',
                    { class: 'suggest' },
                    el(
                        'div',
                        { class: 'suggest-main' },
                        playerCell(t.player, { rank: t.posRank }),
                        el(
                            'div',
                            { class: 'suggest-why' },
                            `Adds ${round(t.gain, 1)} pts/wk to this lineup`,
                            t.demand > 0 ? ` · ${t.demand.toLocaleString()} adds across Sleeper today` : ''
                        )
                    ),
                    el(
                        'div',
                        { class: 'suggest-meta' },
                        estimate
                            ? tag(`~$${estimate.dollars}${estimate.capped ? '+' : ''}`, estimate.dollars <= side.faabIn ? 'good' : 'warn')
                            : null,
                        el('div', { class: 'tiny dim nowrap' },
                            estimate && estimate.dollars <= side.faabIn ? 'affordable with this cash' : 'more than this cash covers')
                    )
                )
            );
        }
    } else {
        card.append(
            el('p', { class: 'muted small' },
                'Nothing on the wire would crack this lineup right now, which is the honest case against taking cash for a starter.')
        );
    }

    if (history?.tiers?.length) {
        card.append(el('h3', { style: 'margin-top:18px' }, 'What this league pays'));
        card.append(
            el(
                'div',
                { class: 'table-scroll' },
                el(
                    'table',
                    { class: 'table' },
                    el('thead', {}, el('tr', {},
                        el('th', {}, 'Tier'),
                        el('th', { class: 'right' }, 'Claims'),
                        el('th', { class: 'right' }, 'Median'),
                        el('th', { class: 'right' }, 'Most paid'),
                        el('th', { class: 'hide-sm' }, 'Priciest')
                    )),
                    el('tbody', {}, ...history.tiers.map((t) =>
                        el('tr', {},
                            el('td', { class: 'small' }, t.label),
                            el('td', { class: 'num right small' }, t.count),
                            el('td', { class: 'num right small' }, `$${t.median}`),
                            el('td', { class: 'num right small' }, `$${t.max}`),
                            el('td', { class: 'small hide-sm ellipsis' }, t.topPlayer.name)
                        )
                    ))
                )
            )
        );
    }

    return el('div', {},
        el('div', { class: 'section-head' },
            el('h2', {}, 'What the cash buys'),
            el('span', { class: 'hint' }, 'free agents ranked by what they add to THIS lineup')),
        card);
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
            formatValue: (v) => formatValue(app.tradeValue(v)),
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
                    el('span', { class: 'num tiny', style: 'color:var(--accent)' }, formatValue(app.tradeValue(e.value))),
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
        // Scaled, like everything else on screen. Summing raw points here and
        // printing market values in the chips above put two different scales
        // in one panel and made the split disagree with the pieces.
        const va = sideA.reduce((s, e) => s + app.tradeValue(e.value), 0);
        const vb = sideB.reduce((s, e) => s + app.tradeValue(e.value), 0);

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
        const pctGap = fairness(receivesA, receivesB).gap;
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
                    `Side A receives ${formatValue(receivesA)}, Side B receives ${formatValue(receivesB)} in trade value — a gap of ${round(pctGap * 100, 0)}%. This is the ledger only; connect a league to see whether either side can actually start these players.`
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
