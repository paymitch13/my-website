// Trade Calculator, players-only mode.
//
// No rosters, no lineups, no league. Two piles of players and a format, which
// is the shape the question actually arrives in: "who won this trade" about a
// deal that already happened, or "would you do this" about one that never will.
//
// This is the surface where the FORMAT controls earn their place. Roster fit is
// gone, so format is the only thing left that moves the numbers -- and it moves
// them a lot. A quarterback is worth roughly double in superflex and a tight
// end is a different asset entirely with a premium attached, so a calculator
// that silently assumes twelve-team half-PPR is answering a question nobody
// asked about half the leagues that exist.

import {
    DEFAULT_SHAPE, PPR_PRESETS, TE_PREMIUM_CHOICES,
    buildVacuumContext, describeShape, scoreVacuumTrade, shapeToCfg, vacuumVerdict,
} from '../vacuum.js';
import { marketKey, fetchMarketValues } from '../market.js';
import * as store from '../store.js';
import { formatValue } from '../tradevalue.js';
import {
    el, gradeClass, pickPlayer, playerLink, posBadge, round, sortBy, toast,
} from '../ui.js';

const POS_LABEL = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'D/ST' };

export default function vacuumMode(app) {
    const wrap = el('div', {});
    const sideA = [];
    const sideB = [];

    // Seeded from the connected league when there is one, because the format
    // somebody wants to price a hypothetical in is almost always their own.
    const shape = { ...DEFAULT_SHAPE, ...shapeFromLeague(app.league?.cfg) };
    let labels = { a: 'Side A', b: 'Side B' };

    let vac = null;
    let loading = false;

    const formatHost = el('div', { class: 'card' });
    const boardHost = el('div', { class: 'card', style: 'margin-top:16px' });
    const out = el('div', { style: 'margin-top:20px' });
    wrap.append(formatHost, boardHost, out);

    /**
     * Rebuild the pricing context for the current format.
     *
     * The market is per-shape -- superflex prices are a different dataset from
     * one-quarterback prices -- so a format change refetches it. The store
     * caches several shapes, so flipping a toggle back and forth is free after
     * the first look.
     */
    async function reprice() {
        loading = true;
        paint();
        const cfg = shapeToCfg(shape);
        let market = app.market;
        // Only refetch when the chosen shape is a different market from the
        // one already in hand. The store keeps several shapes, so flipping a
        // toggle back and forth costs nothing after the first look.
        if (!market || marketKey(cfg) !== marketKey(app.league?.cfg || cfg)) {
            market = await fetchMarketValues(cfg, {
                store: { load: store.loadCachedMarket, save: store.cacheMarket },
            }).catch(() => null);
        }

        vac = buildVacuumContext({
            players: app.players,
            projections: app.projections,
            actuals: app.actuals,
            market,
            shape,
            week: app.league?.currentWeek || app.nflState?.week || 1,
            weeksLeft: Math.max(1, app.league?.weeksLeft ?? 14),
        });
        loading = false;
        paint();
    }

    // --- Format controls ----------------------------------------------------

    function paintFormat() {
        const field = (label, control, hint = null) =>
            el(
                'div',
                { class: 'vac-field' },
                el('label', { class: 'tiny dim' }, label),
                control,
                hint ? el('div', { class: 'tiny dim' }, hint) : null
            );

        const onChange = (key) => (e) => {
            const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
            shape[key] = key === 'teams' || key === 'tePremium' ? Number(v) : v;
            reprice();
        };

        formatHost.replaceChildren(
            el(
                'div',
                { class: 'row', style: 'justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px' },
                el('h2', { style: 'margin:0;font-size:17px' }, 'League format'),
                el('span', { class: 'hint' }, describeShape(shape))
            ),
            el(
                'p',
                { class: 'small muted', style: 'margin:8px 0 14px' },
                'With no roster to fit, format is the only thing left that changes these numbers — and it changes ',
                'them more than most people expect. Set it to the league the trade happened in.'
            ),
            el(
                'div',
                { class: 'vac-format' },
                field(
                    'TEAMS',
                    el(
                        'select',
                        { onchange: onChange('teams') },
                        ...[4, 6, 8, 10, 12, 14, 16, 18, 20].map((n) =>
                            el('option', { value: String(n), selected: n === shape.teams }, String(n))
                        )
                    ),
                    'Shallower leagues make everyone cheaper'
                ),
                field(
                    'RECEPTIONS',
                    el(
                        'select',
                        { onchange: onChange('ppr') },
                        ...PPR_PRESETS.map((pr) =>
                            el('option', { value: pr.id, selected: pr.id === shape.ppr }, pr.label)
                        )
                    )
                ),
                field(
                    'TE PREMIUM',
                    el(
                        'select',
                        { onchange: onChange('tePremium') },
                        ...TE_PREMIUM_CHOICES.map((n) =>
                            el('option', { value: String(n), selected: Number(n) === Number(shape.tePremium) },
                                n === 0 ? 'None' : `+${n} per catch`)
                        )
                    )
                ),
                field(
                    'QUARTERBACKS',
                    el(
                        'select',
                        {
                            onchange: (e) => {
                                shape.superflex = e.target.value === 'sf';
                                reprice();
                            },
                        },
                        el('option', { value: '1', selected: !shape.superflex }, 'One QB'),
                        el('option', { value: 'sf', selected: shape.superflex }, 'Superflex')
                    )
                ),
                field(
                    'FORMAT',
                    el(
                        'select',
                        {
                            onchange: (e) => {
                                shape.dynasty = e.target.value === 'dynasty';
                                reprice();
                            },
                        },
                        el('option', { value: 'redraft', selected: !shape.dynasty }, 'Redraft'),
                        el('option', { value: 'dynasty', selected: shape.dynasty }, 'Dynasty / keeper')
                    ),
                    shape.dynasty ? 'Values carry to next year' : 'Values are for this season only'
                )
            )
        );
    }

    // --- The two piles ------------------------------------------------------

    async function add(list) {
        if (!vac) return;
        const taken = new Set([...sideA, ...sideB].map((e) => e.player.id));
        const entries = sortBy(
            Object.values(app.players)
                .filter((p) => !taken.has(p.id) && (vac.ranks.get(p.id) ?? 999) < 900)
                .map((p) => ({
                    player: p,
                    posRank: vac.ranks.get(p.id),
                    value: vac.pricePlayer(p),
                })),
            (e) => e.value,
            -1
        );
        const chosen = await pickPlayer({
            title: 'Add a player',
            entries,
            formatValue: (v) => formatValue(v),
        });
        if (!chosen) return;
        list.push(chosen);
        paint();
    }

    function column(which, list) {
        const name = labels[which];
        const zone = el('div', { class: `picklist${list.length ? '' : ' empty'}` });
        if (!list.length) zone.append('Nobody selected yet');

        // Re-priced on every paint, because the format may have changed since
        // the player was added. A chip showing a stale price next to a total
        // computed from a fresh one is the bug that makes a calculator look
        // broken.
        for (const e of list) {
            e.value = vac ? vac.pricePlayer(e.player) : 0;
            e.posRank = vac ? vac.ranks.get(e.player.id) : null;
            zone.append(
                el(
                    'div',
                    { class: 'chip' },
                    posBadge(e.player.pos),
                    el('span', { class: 'grow', style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, playerLink(e.player)),
                    e.posRank ? el('span', { class: 'tiny dim' }, `${POS_LABEL[e.player.pos] || e.player.pos}${e.posRank}`) : null,
                    el('span', { class: 'num tiny', style: 'color:var(--accent)' }, formatValue(e.value)),
                    el(
                        'button',
                        {
                            class: 'x',
                            title: 'Remove',
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
            el(
                'input',
                {
                    class: 'vac-name',
                    value: name,
                    'aria-label': `Name for ${name}`,
                    oninput: (e) => {
                        labels[which] = e.target.value.trim() || (which === 'a' ? 'Side A' : 'Side B');
                        repaintVerdict();
                    },
                }
            ),
            el('div', { class: 'tiny dim', style: 'margin:12px 0 6px' }, 'SENDS AWAY'),
            zone,
            el(
                'button',
                { class: 'btn btn-sm', style: 'margin-top:10px;width:100%', onclick: () => add(list) },
                '+ Add player'
            )
        );
    }

    // --- Verdict ------------------------------------------------------------

    function repaintVerdict() {
        if (!vac) {
            out.replaceChildren();
            return;
        }
        const price = (e) => e.value;
        const res = scoreVacuumTrade({ a: sideA, b: sideB, price });
        const verdict = vacuumVerdict(res, { labelA: labels.a, labelB: labels.b });

        if (res.empty) {
            out.replaceChildren(
                el('p', { class: 'muted small', style: 'margin-top:4px' }, verdict.headline)
            );
            return;
        }

        const total = res.receivesA + res.receivesB || 1;

        out.replaceChildren(
            el(
                'div',
                { class: `verdict tone-${verdict.tone}` },
                el(
                    'div',
                    { class: 'row', style: 'justify-content:space-between;align-items:center;gap:10px' },
                    el('div', { class: 'label' }, verdict.label),
                    verdict.grade ? el('div', { class: `grade ${gradeClass(verdict.grade)}` }, verdict.grade) : null
                ),
                el('div', { class: 'headline' }, verdict.headline),
                el(
                    'div',
                    { class: 'meter' },
                    el('i', { class: 'fill-a', style: `width:${(res.receivesA / total) * 100}%` }),
                    el('i', { class: 'fill-b', style: `width:${(res.receivesB / total) * 100}%` })
                ),
                el(
                    'div',
                    { class: 'row small', style: 'justify-content:space-between;margin-top:8px' },
                    el('span', {}, `${labels.a} receives ${formatValue(res.receivesA)}`),
                    el('span', {}, `${labels.b} receives ${formatValue(res.receivesB)}`)
                )
            ),
            el(
                'div',
                { class: 'vac-ledger' },
                ledgerSide(labels.b, res.sentB, `${labels.a} receives`),
                ledgerSide(labels.a, res.sentA, `${labels.b} receives`)
            ),
            el(
                'div',
                { class: 'row', style: 'margin-top:16px;gap:8px;flex-wrap:wrap' },
                el('button', { class: 'btn btn-sm', onclick: () => copySummary(res, verdict) }, 'Copy summary'),
                el('button', { class: 'btn btn-sm', onclick: clearAll }, 'Clear')
            ),
            // The one thing this tool cannot do, said where it matters rather
            // than buried. Scoring an old trade with today's prices is a
            // genuinely different claim from scoring it with the prices of the
            // day, and the difference is often the whole argument.
            el(
                'p',
                { class: 'small muted', style: 'margin-top:14px' },
                'These are what each player is worth ',
                el('strong', {}, 'now'),
                `, under ${describeShape(shape)}. For a trade that already happened that answers ` +
                '“who would win it today”, which is not the same as who won it at the time — a player who has ' +
                'since got hurt or broken out was priced differently on the day. There is no historical price ' +
                'feed behind this, so it does not pretend to have one.'
            )
        );
    }

    function ledgerSide(sender, rows, heading) {
        return el(
            'div',
            { class: 'card', style: 'margin:0' },
            el('div', { class: 'tiny dim', style: 'margin-bottom:8px' }, heading.toUpperCase()),
            rows.length
                ? el(
                      'table',
                      { class: 'table' },
                      el(
                          'tbody',
                          {},
                          ...rows.map((r) =>
                              el(
                                  'tr',
                                  {},
                                  el('td', {}, posBadge(r.player.pos), ' ', playerLink(r.player)),
                                  el('td', { class: 'num dim tiny' },
                                      r.entry?.posRank ? `${POS_LABEL[r.player.pos] || r.player.pos}${r.entry.posRank}` : ''),
                                  el('td', { class: 'num', style: 'color:var(--accent)' }, formatValue(r.value))
                              )
                          )
                      )
                  )
                : el('p', { class: 'muted small' }, `${sender} sends nobody.`)
        );
    }

    function copySummary(res, verdict) {
        const side = (name, rows) =>
            `${name} gets: ${rows.map((r) => `${r.player.name} (${formatValue(r.value)})`).join(', ') || 'nothing'}`;
        const text = [
            `${verdict.label} — ${describeShape(shape)}`,
            side(labels.a, res.sentB),
            side(labels.b, res.sentA),
            `${labels.a} ${formatValue(res.receivesA)} vs ${labels.b} ${formatValue(res.receivesB)} (${round(res.gap * 100, 0)}% gap)`,
        ].join('\n');

        // Clipboard access is denied outright in some browsers and contexts,
        // so the failure path has to say something rather than appear to work.
        navigator.clipboard?.writeText(text).then(
            () => toast('Summary copied', 'good'),
            () => toast('Could not copy — your browser blocked clipboard access.', 'bad')
        ) ?? toast('Clipboard not available in this browser.', 'bad');
    }

    function clearAll() {
        sideA.length = 0;
        sideB.length = 0;
        paint();
    }

    function paint() {
        paintFormat();
        boardHost.replaceChildren(
            loading
                ? el('p', { class: 'muted small', style: 'margin:0' }, 'Pricing players for this format…')
                : el(
                      'div',
                      { class: 'trade-grid' },
                      column('a', sideA),
                      el('div', { class: 'trade-mid' }, el('div', { class: 'swap-arrows' }, '⇄'), el(
                          'button',
                          { class: 'btn btn-sm', title: 'Swap sides', onclick: swapSides },
                          'Swap'
                      )),
                      column('b', sideB)
                  )
        );
        if (!loading) repaintVerdict();
    }

    function swapSides() {
        const a = sideA.splice(0, sideA.length);
        const b = sideB.splice(0, sideB.length);
        sideA.push(...b);
        sideB.push(...a);
        paint();
    }

    reprice();
    return wrap;
}

/** Seed the format controls from a connected league, when there is one. */
function shapeFromLeague(cfg) {
    if (!cfg) return {};
    const rec = cfg.scoring?.rec ?? 0.5;
    return {
        teams: cfg.teams || 12,
        ppr: rec >= 0.75 ? 'full' : rec <= 0.25 ? 'std' : 'half',
        superflex: !!cfg.superflex,
        tePremium: cfg.scoring?.bonus_rec_te || 0,
        dynasty: !!cfg.format && cfg.format !== 'redraft',
    };
}
