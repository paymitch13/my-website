// My Rankings — the customizable board every other number is derived from.

import { RANKABLE, autoTiers, fromCsv, nudge, reorder, toCsv } from '../rankings.js';
import { valuePlayer } from '../valuation.js';
import { scoringLabel } from '../league.js';
import * as store from '../store.js';
import {
    banner, copyToClipboard, download, el, emptyState, modal, playerCell, posBadge,
    round, toast, tag,
} from '../ui.js';

const POS_LABEL = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'D/ST' };

export default function renderRankings(app) {
    const root = el('div', {});
    let pos = sessionStorage.getItem('ffc:rankPos') || 'RB';
    let query = '';
    let showTiers = true;
    let justMoved = null;

    const listHost = el('div', { class: 'board' });
    const countLabel = el('span', { class: 'hint' });

    // ---- Header -----------------------------------------------------------

    root.append(
        el(
            'div',
            { class: 'page-head' },
            el('h1', {}, 'My Rankings'),
            el(
                'p',
                { class: 'sub' },
                'This board is the opinion the whole app runs on. Drag a player to move him; every trade value, ',
                'power ranking and playoff projection updates from the order you set here.'
            )
        )
    );

    if (app.league) {
        root.append(
            banner(
                `Values shown for ${app.league.cfg.name} — ${app.league.cfg.teams} teams, ${scoringLabel(app.league.cfg.scoring)}${app.league.cfg.superflex ? ', superflex' : ''}. Ranking order is yours; the value column translates it into this league's scoring.`
            )
        );
    } else {
        root.append(
            banner('Not connected to a league yet — values assume a standard 12-team, half-PPR setup. Connect a Sleeper league to make them exact.', 'warn')
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
                        class: 'btn btn-sm',
                        'aria-pressed': String(showTiers),
                        onclick: (e) => {
                            showTiers = !showTiers;
                            e.currentTarget.setAttribute('aria-pressed', String(showTiers));
                            paint();
                        },
                    },
                    'Tiers'
                ),
                el('button', { class: 'btn btn-sm', onclick: openImport }, 'Import CSV'),
                el('button', { class: 'btn btn-sm', onclick: doExport }, 'Export CSV'),
                el('button', { class: 'btn btn-sm btn-danger', onclick: doReset }, 'Reset')
            )
        )
    );

    root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Board'), countLabel));
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
        const breaks = showTiers ? new Set(autoTiers(ids, (id) => values.get(id)?.value ?? 0)) : new Set();

        listHost.replaceChildren();
        countLabel.textContent = `${ids.length} ranked at ${POS_LABEL[pos]}`;

        if (!ids.length) {
            listHost.append(emptyState('📋', 'Nothing here yet', 'No players at this position in the database.'));
            return;
        }

        let tierNo = 1;
        if (showTiers) listHost.append(el('div', { class: 'tier-break' }, `Tier ${tierNo}`));

        ids.forEach((id, i) => {
            const p = app.players[id];
            if (!p) return;
            if (query && !p.name.toLowerCase().includes(query)) {
                if (breaks.has(i) && showTiers) tierNo++;
                return;
            }
            listHost.append(row(p, i, values.get(id)));
            if (breaks.has(i) && showTiers) {
                tierNo++;
                listHost.append(el('div', { class: 'tier-break' }, `Tier ${tierNo}`));
            }
        });
    }

    function row(player, index, val) {
        const node = el(
            'div',
            {
                class: `prow${justMoved === player.id ? ' moved' : ''}`,
                draggable: 'true',
                dataset: { id: player.id, index: String(index) },
            },
            el('span', { class: 'rank' }, `${POS_LABEL[pos]}${index + 1}`),
            el('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
            playerCell(player, { showTeam: true }),
            el(
                'span',
                { class: 'val', title: 'Rest-of-season points above replacement in this league' },
                val ? round(val.value, 0) : '—'
            ),
            el(
                'span',
                { class: 'row', style: 'gap:2px;flex-wrap:nowrap' },
                el('button', { class: 'btn btn-sm btn-icon', title: 'Move up', onclick: () => move(player.id, -1) }, '▲'),
                el('button', { class: 'btn btn-sm btn-icon', title: 'Move down', onclick: () => move(player.id, 1) }, '▼'),
                el('button', { class: 'btn btn-sm btn-icon', title: 'Move to a specific rank', onclick: () => promptRank(player, index) }, '#')
            )
        );

        node.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', player.id);
            e.dataTransfer.effectAllowed = 'move';
            node.classList.add('dragging');
        });
        node.addEventListener('dragend', () => node.classList.remove('dragging'));
        node.addEventListener('dragover', (e) => {
            e.preventDefault();
            node.classList.add('drop-target');
        });
        node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
        node.addEventListener('drop', (e) => {
            e.preventDefault();
            node.classList.remove('drop-target');
            const draggedId = e.dataTransfer.getData('text/plain');
            if (!draggedId || draggedId === player.id) return;
            moveTo(draggedId, index);
        });

        return node;
    }

    function move(id, delta) {
        app.saveOrder(nudge(app.order, pos, id, delta));
        justMoved = id;
        paint();
        setTimeout(() => (justMoved = null), 800);
    }

    function moveTo(id, index) {
        app.saveOrder(reorder(app.order, pos, id, index));
        justMoved = id;
        paint();
        setTimeout(() => (justMoved = null), 800);
    }

    function promptRank(player, index) {
        const input = el('input', { type: 'number', min: '1', max: String((app.order[pos] || []).length), value: String(index + 1) });
        const apply = () => {
            const n = Number(input.value);
            if (Number.isFinite(n) && n >= 1) moveTo(player.id, n - 1);
            m.close();
        };
        const m = modal({
            title: `Move ${player.name}`,
            body: el('div', { class: 'field' }, el('label', {}, `New ${POS_LABEL[pos]} rank`), input),
            footer: el('button', { class: 'btn btn-primary', onclick: apply }, 'Move'),
        });
        input.addEventListener('keydown', (e) => e.key === 'Enter' && apply());
        setTimeout(() => input.select(), 30);
    }

    // ---- Import / export --------------------------------------------------

    function doExport() {
        download(`payton-rankings-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(app.order, app.players));
        toast('Rankings exported.', 'good');
    }

    function doReset() {
        const m = modal({
            title: 'Reset rankings?',
            body: el('p', { class: 'muted' }, 'This clears every manual change and re-seeds the board from Sleeper’s default ordering. It cannot be undone.'),
            footer: el(
                'div',
                { class: 'row' },
                el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
                el(
                    'button',
                    {
                        class: 'btn btn-danger',
                        onclick: () => {
                            store.resetRankings();
                            app.rebuild();
                            m.close();
                            toast('Rankings reset to the Sleeper baseline.');
                            app.render();
                        },
                    },
                    'Reset everything'
                )
            ),
        });
    }

    function openImport() {
        const file = el('input', { type: 'file', accept: '.csv,text/csv' });
        const textarea = el('textarea', { rows: '8', placeholder: '…or paste CSV here.\n\nplayer,position,rank\nJustin Jefferson,WR,1' });
        const status = el('div', { style: 'margin-top:12px' });

        const handle = (text) => {
            const parsed = fromCsv(text, app.players);
            if (!parsed.matched) {
                status.replaceChildren(banner('No players matched. Make sure there is a player-name column.', 'bad'));
                return;
            }
            // Only replace positions the file actually covered, so importing a
            // WR-only cheat sheet does not wipe the other five boards.
            const merged = { ...app.order };
            for (const p of RANKABLE) {
                if (parsed.order[p]?.length) {
                    const imported = parsed.order[p];
                    const rest = (app.order[p] || []).filter((id) => !imported.includes(id));
                    merged[p] = [...imported, ...rest];
                }
            }
            app.saveOrder(merged);

            const touched = RANKABLE.filter((p) => parsed.order[p]?.length);
            status.replaceChildren(
                banner(`Imported ${parsed.matched} players across ${touched.join(', ')}.`, ''),
                parsed.unmatched.length
                    ? el(
                          'div',
                          { class: 'small muted', style: 'margin-top:8px' },
                          `${parsed.unmatched.length} name${parsed.unmatched.length === 1 ? '' : 's'} could not be matched: ${parsed.unmatched.slice(0, 12).join(', ')}${parsed.unmatched.length > 12 ? '…' : ''}`
                      )
                    : null
            );
            paint();
            toast(`Imported ${parsed.matched} rankings.`, 'good');
        };

        file.addEventListener('change', () => {
            const f = file.files?.[0];
            if (!f) return;
            f.text().then(handle);
        });

        modal({
            title: 'Import rankings',
            body: el(
                'div',
                {},
                el('p', { class: 'muted small' }, 'Accepts any CSV with a player-name column. A rank column is used if present, otherwise row order wins. Positions not in the file are left alone.'),
                file,
                el('div', { style: 'margin-top:12px' }, textarea),
                el('button', { class: 'btn btn-primary', style: 'margin-top:10px', onclick: () => handle(textarea.value) }, 'Import pasted text'),
                status
            ),
            width: '600px',
        });
    }

    paint();
    return root;
}
