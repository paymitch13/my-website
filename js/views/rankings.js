// Rankings — the model's ordering, which every other number is derived from.
//
// This was a board the user could drag, and it is not any more. Saving an edit
// persisted the WHOLE ordering, so one drag froze every ranked player at that
// moment's opinion and the merge on each later load preserved it -- an app that
// silently stopped incorporating results from the day you first touched it.

import { RANKABLE, autoTiers, toCsv } from '../rankings.js';
import { valuePlayer } from '../valuation.js';
import { scoringLabel } from '../league.js';
import { banner, download, el, emptyState, playerCell, toast } from '../ui.js';
import { formatValue } from '../tradevalue.js';
import { priceOf } from '../trade.js';

const POS_LABEL = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'D/ST' };

export default function renderRankings(app) {
    const root = el('div', {});
    let pos = sessionStorage.getItem('ffc:rankPos') || 'RB';
    let query = '';
    let showTiers = true;

    const listHost = el('div', { class: 'board' });
    const countLabel = el('span', { class: 'hint' });

    // ---- Header -----------------------------------------------------------

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'Rankings'),
            el(
                'p',
                { class: 'sub' },
                'The model’s ordering, re-derived from the evidence every time this loads: the preseason ',
                'projection updated by what each player has actually done this season, under your league’s ',
                'scoring. Two numbers per player — what he costs in a trade, and what he adds to a starting ',
                'lineup. They are different questions and they disagree most for bench players.'
            )
        )
    );

    if (app.league) {
        root.append(
            banner(
                `Ranked for ${app.league.cfg.name} — ${app.league.cfg.teams} teams, ${scoringLabel(app.league.cfg.scoring)}${app.league.cfg.superflex ? ', superflex' : ''}. Scoring and roster slots both move these numbers, so the order here is specific to this league.`
            )
        );
    } else {
        root.append(
            banner('Not connected to a league yet — values assume a standard 12-team, half-PPR setup. Connect a Sleeper league to make them exact.', 'warn')
        );
    }

    // Nothing below can run without a valuation context. That only happens when
    // the player database never downloaded, and the boot screen already says so
    // -- but the tab is still there to click, and throwing at it is not an
    // answer.
    if (!app.ctx || !app.players) {
        root.append(
            emptyState(
                '📡',
                'Player data has not loaded',
                'Rankings need the player database and season projections. Reload once you are back online.',
                el('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Reload')
            )
        );
        return root;
    }

    // Never let the numbers be silently synthetic.
    if (!app.ctx.projected) {
        root.append(
            banner(
                'Season projections could not be loaded, so values are coming from the fallback rank model instead of real projected stat lines. Reload to try again.',
                'warn'
            )
        );
    }

    // ---- Controls ---------------------------------------------------------

    const posSeg = el(
        'div',
        { class: 'seg' },
        ...RANKABLE.map((p) =>
            el(
                'button',
                {
                    type: 'button',
                    'aria-pressed': String(p === pos),
                    class: p === pos ? 'accent' : '',
                    onclick: () => {
                        pos = p;
                        sessionStorage.setItem('ffc:rankPos', p);
                        for (const b of posSeg.children) {
                            const on = b.textContent === POS_LABEL[p];
                            b.setAttribute('aria-pressed', String(on));
                            b.className = on ? 'accent' : '';
                        }
                        paint();
                    },
                },
                POS_LABEL[p]
            )
        )
    );

    const search = el('input', {
        type: 'search',
        placeholder: 'Filter by name…',
        style: 'max-width:220px',
        oninput: (e) => {
            query = e.target.value.trim().toLowerCase();
            paint();
        },
    });

    root.append(
        el(
            'div',
            { class: 'card card-tight' },
            el(
                'div',
                { class: 'row' },
                posSeg,
                search,
                el('div', { class: 'grow' }),
                el(
                    'button',
                    {
                        class: 'btn btn-sm btn-toggle',
                        'aria-pressed': String(showTiers),
                        onclick: (e) => {
                            showTiers = !showTiers;
                            e.currentTarget.setAttribute('aria-pressed', String(showTiers));
                            paint();
                        },
                    },
                    'Tiers'
                ),
                el('button', { class: 'btn btn-sm', onclick: doExport }, 'Export CSV')
            )
        )
    );

    root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Model ranking'), countLabel));
    root.append(
        el(
            'div',
            { class: 'prow prow-head' },
            el('span', { class: 'rank' }, ''),
            el('span', { class: 'grow' }, 'PLAYER'),
            el('span', { class: 'val' }, 'TRADE'),
            el('span', { class: 'val' }, 'LINEUP'),
            el('span', { style: 'min-width:68px' }, '')
        )
    );
    root.append(listHost);

    // ---- Painting ---------------------------------------------------------

    function valuesFor(ids) {
        const map = new Map();
        ids.forEach((id, i) => {
            const p = app.players[id];
            if (!p) return;
            map.set(id, valuePlayer(p, i + 1, app.ctx));
        });
        return map;
    }

    function paint() {
        const ids = app.order[pos] || [];
        const values = valuesFor(ids);
        // Tiers break on the number the rows actually show, or the gaps the
        // reader sees and the gaps the tiers mark are measuring different
        // things and the dividers land in arbitrary places.
        const breaks = showTiers
            ? new Set(autoTiers(ids, (id) => priceFor(app.players[id], values.get(id)) ?? 0))
            : new Set();

        listHost.replaceChildren();

        // Which rows survive the filter, and which tier each one belongs to.
        let tierOf = [];
        let t = 1;
        ids.forEach((id, i) => {
            tierOf[i] = t;
            if (breaks.has(i)) t++;
        });

        const visible = ids
            .map((id, i) => ({ id, i }))
            .filter(({ id }) => {
                const p = app.players[id];
                return p && (!query || p.name.toLowerCase().includes(query));
            });

        countLabel.textContent = query
            ? `${visible.length} of ${ids.length} at ${POS_LABEL[pos]}`
            : `${ids.length} ranked at ${POS_LABEL[pos]}`;

        if (!ids.length) {
            listHost.append(emptyState('📋', 'Nothing here yet', 'No players at this position in the database.'));
            return;
        }
        if (!visible.length) {
            listHost.append(
                emptyState(
                    '🔍',
                    'No matches',
                    `Nobody at ${POS_LABEL[pos]} matches “${query}”.`,
                    el('button', { class: 'btn', onclick: () => { search.value = ''; query = ''; paint(); } }, 'Clear filter')
                )
            );
            return;
        }

        // Emit a tier header only when that tier actually has a visible row, so
        // filtering can never produce "Tier 1" followed by a jump to "Tier 5"
        // with no separators in between.
        let lastTier = null;
        for (const { id, i } of visible) {
            if (showTiers && tierOf[i] !== lastTier) {
                lastTier = tierOf[i];
                listHost.append(el('div', { class: 'tier-break' }, `Tier ${lastTier}`));
            }
            listHost.append(row(app.players[id], i, values.get(id)));
        }
    }

    /**
     * What this player would COST in a trade, which is not the same number as
     * what he is worth to your starting lineup.
     *
     * The column has always said "trade value" and always showed the second
     * number -- points above replacement on your own board. For a starter the
     * two roughly agree. For anyone behind a starter they do not agree at all:
     * a backup quarterback in a one-quarterback league is worth almost nothing
     * to your lineup, so he read as 99 of 10,000, next to worthless, while
     * real leagues were trading him at 795 and the finder's own ledger priced
     * him there too. Showing a number nobody would trade at, under a label
     * saying trade value, is what made perfectly ordinary players look
     * valueless.
     */
    const priceFor = (player, val) => {
        if (!val) return null;
        return priceOf({ player, value: val.value }, app.ctx, app.tradeValue);
    };

    function row(player, index, val) {
        const cost = priceFor(player, val);
        const lineup = val ? app.tradeValue(val.value) : null;
        // Shown side by side rather than one in a tooltip. They answer
        // different questions and they disagree most exactly where a reader is
        // most likely to be surprised: a backup quarterback costs real money
        // and contributes nothing to a starting lineup, and both facts are
        // true at once.
        const diverges =
            cost !== null && lineup !== null && Math.abs(cost - lineup) > Math.max(50, cost * 0.2);

        return el(
            'div',
            { class: 'prow prow-static', dataset: { id: player.id } },
            el('span', { class: 'rank' }, `${POS_LABEL[pos]}${index + 1}`),
            playerCell(player, { showTeam: true }),
            el(
                'span',
                { class: 'val', title: 'What he costs in a trade in this league.' },
                cost !== null ? formatValue(cost) : '—'
            ),
            el(
                'span',
                {
                    class: `val ${diverges ? 'dim' : 'dim'}`,
                    title: 'What he adds to a starting lineup — points above replacement, scaled. Near zero for anyone behind a starter, which is correct and is why it is not the price.',
                },
                lineup !== null ? formatValue(lineup) : '—'
            ),
            // Where the projection disagrees with where he is ranked, which is
            // the whole buy-low signal and worth surfacing rather than hiding.
            el(
                'span',
                { class: 'tiny dim', style: 'min-width:68px;text-align:right' },
                val?.projectedRank && Math.abs(val.projectedRank - (index + 1)) >= 8
                    ? `proj ${POS_LABEL[pos]}${val.projectedRank}`
                    : ''
            )
        );
    }

    // ---- Export -----------------------------------------------------------

    function doExport() {
        download(`payton-rankings-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(app.order, app.players));
        toast('Rankings exported.', 'good');
    }

    paint();
    return root;
}
