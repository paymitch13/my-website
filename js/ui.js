// Shared UI primitives. Plain DOM -- no framework, no build step.

import { el, round, sortBy } from './util.js';
import { headshotUrl } from './sleeper.js';

// Set once at boot by app.js. Kept as a hook rather than an import so the
// shared primitives never have to reach back into the app module.
let playerClickHandler = null;
export function onPlayerClick(fn) {
    playerClickHandler = fn;
}

/** Wrap a player's name so clicking it opens the profile card. */
export function playerLink(player, text = player.name) {
    if (!playerClickHandler) return el('span', {}, text);
    return el(
        'button',
        {
            type: 'button',
            class: 'plink',
            title: `Profile: ${player.name}`,
            onclick: (e) => {
                e.stopPropagation();
                e.preventDefault();
                playerClickHandler(player);
            },
        },
        text
    );
}

export function toast(message, kind = '') {
    const host = document.getElementById('toasts');
    if (!host) return;
    const node = el('div', { class: `toast ${kind}` }, message);
    host.append(node);
    setTimeout(() => {
        node.style.transition = 'opacity .25s, transform .25s';
        node.style.opacity = '0';
        node.style.transform = 'translateX(16px)';
        setTimeout(() => node.remove(), 260);
    }, kind === 'bad' ? 6000 : 3200);
}

export function posBadge(pos) {
    return el('span', { class: `pos pos-${pos}` }, pos === 'DEF' ? 'DST' : pos);
}

export function tag(text, kind = '') {
    return el('span', { class: `tag ${kind ? `tag-${kind}` : ''}` }, text);
}

export function tile(label, value, detail, cls = '') {
    // Numeric values keep the tabular mono face; names get the prose face so
    // they wrap like words instead of like a serial number.
    const isNumeric = /^[+-]?[\d.,%\s]+$/.test(String(value));
    return el(
        'div',
        { class: 'tile' },
        el('div', { class: 'k' }, label),
        el('div', { class: `v ${isNumeric ? '' : 'text'} ${cls}` }, value),
        detail ? el('div', { class: 'd' }, detail) : null
    );
}

export function emptyState(icon, title, body, action) {
    return el(
        'div',
        { class: 'empty' },
        el('div', { class: 'icon' }, icon),
        el('h3', {}, title),
        el('p', { class: 'muted' }, body),
        action || null
    );
}

export function banner(text, kind = '') {
    return el('div', { class: `banner ${kind ? `banner-${kind}` : ''}` }, text);
}

/**
 * The one limitation this app cannot hide: individual defensive players are not
 * valued, so an IDP league sees starting slots nothing can fill.
 *
 * It was disclosed on the League tab only, which is not where anybody starts.
 * A manager opens Start/Sit or the Trade Calculator, finds three empty rows and
 * no explanation, and concludes the tool is broken. It is a real limitation and
 * it belongs next to the hole it makes.
 */
export function idpNotice(cfg) {
    if (!cfg?.hasIdp) return null;
    return banner(
        'This league starts individual defensive players. Sleeper does not publish projections for them, ' +
            'so IDP slots are left empty and IDP players carry no value here — everything else on this page ' +
            'is unaffected.',
        'warn'
    );
}

export function skeleton(count = 4, height = 42) {
    return el(
        'div',
        {},
        ...Array.from({ length: count }, () => el('div', { class: 'skeleton', style: `height:${height}px` }))
    );
}

export function spinnerRow(text) {
    return el('div', { class: 'row', style: 'padding:16px 0' }, el('span', { class: 'spinner' }), el('span', { class: 'muted' }, text));
}

/** Player name cell with position badge, team and injury flag. */
export function playerCell(player, { rank = null, showTeam = true } = {}) {
    const bits = [];
    if (showTeam) bits.push(player.team || 'FA');
    if (rank) bits.push(`${player.pos}${rank}`);
    if (player.age) bits.push(`${player.age}y`);

    return el(
        'div',
        { class: 'row', style: 'gap:10px;flex-wrap:nowrap;min-width:0' },
        posBadge(player.pos),
        el(
            'div',
            { style: 'min-width:0' },
            el(
                'div',
                { class: 'pname', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' },
                playerLink(player),
                player.injury ? el('span', { class: 'tag tag-bad', style: 'margin-left:6px' }, player.injury) : null
            ),
            el('div', { class: 'pmeta' }, bits.join(' · '))
        )
    );
}

/** Modal with a promise-based result. */
export function modal({ title, body, footer, onClose, width }) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', { class: 'modal', style: width ? `width:min(${width},100%)` : null });

    const close = () => {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        onClose?.();
    };
    const onKey = (e) => {
        if (e.key === 'Escape') close();
    };

    box.append(
        el(
            'header',
            {},
            el('h3', { class: 'grow', style: 'margin:0' }, title),
            el('button', { class: 'btn btn-ghost btn-icon', onclick: close, 'aria-label': 'Close' }, '✕')
        ),
        el('div', { class: 'body' }, body)
    );
    if (footer) box.append(el('footer', {}, footer));

    backdrop.append(box);
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);

    return { close, box };
}

/**
 * Searchable player picker. `players` is an array of {player, subtitle, value}.
 * Resolves with the chosen entry, or null if dismissed.
 *
 * `formatValue` exists because there are two number scales in this app -- raw
 * points above replacement, and the convex market scale -- and a player must
 * never show one here and the other a click later. This module cannot import
 * the app singleton that holds the scale, so the caller supplies the formatter.
 */
export function pickPlayer({
    title,
    entries,
    emptyText = 'Nobody available.',
    formatValue: fmt = (v) => round(v, 0),
}) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            m.close();
            resolve(v);
        };

        const list = el('div', { class: 'pick-list' });
        const search = el('input', {
            type: 'search',
            placeholder: 'Search by name…',
            oninput: () => paint(search.value),
        });

        function paint(query) {
            const q = query.trim().toLowerCase();
            const shown = entries.filter((e) => !q || e.player.name.toLowerCase().includes(q));
            list.replaceChildren();
            if (!shown.length) {
                list.append(el('div', { class: 'muted small', style: 'padding:12px' }, emptyText));
                return;
            }
            for (const e of shown.slice(0, 120)) {
                list.append(
                    el(
                        'button',
                        { class: 'pick', type: 'button', onclick: () => finish(e) },
                        playerCell(e.player, { rank: e.posRank }),
                        el('div', { class: 'grow' }),
                        e.value !== undefined
                            ? el('span', { class: 'num small', style: 'color:var(--accent)' }, fmt(e.value))
                            : null
                    )
                );
            }
        }

        paint('');
        const m = modal({
            title,
            body: el('div', {}, el('div', { style: 'margin-bottom:12px' }, search), list),
            onClose: () => finish(null),
        });
        setTimeout(() => search.focus(), 30);
    });
}

/** Small centered bar used by the power rankings component breakdown. */
export function componentBar(label, z) {
    const width = Math.min(50, Math.abs(z) * 16);
    const style = z >= 0 ? `left:50%;width:${width}%` : `left:${50 - width}%;width:${width}%`;
    return el(
        'div',
        { class: 'bar-line' },
        el('span', {}, label),
        el('div', { class: 'bar' }, el('i', { class: z >= 0 ? '' : 'neg', style }))
    );
}

export function headshot(player, size = 34) {
    const img = el('img', {
        src: headshotUrl(player.id, player.pos, player.team),
        alt: '',
        loading: 'lazy',
        style: `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;background:var(--surface-3);flex-shrink:0`,
    });
    img.addEventListener('error', () => img.remove(), { once: true });
    return img;
}

export function copyToClipboard(text, successMessage = 'Copied to clipboard') {
    const done = () => toast(successMessage, 'good');
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();

    function fallback() {
        const ta = el('textarea', { style: 'position:fixed;opacity:0' });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        try {
            document.execCommand('copy');
            done();
        } catch {
            toast('Could not copy automatically — select the text and copy it manually.', 'bad');
        }
        ta.remove();
    }
}

export function download(filename, text, mime = 'text/csv') {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// One percent formatter and one signed-number formatter for the whole app.
// There were previously three of the former and two functions named fmtDelta
// meaning different units, which is a correctness hazard, not a tidiness one.
export const fmtPct = (n, places = 0) => `${(n * 100).toFixed(places)}%`;
/** Signed plain number: +2.4 */
export const fmtDelta = (n, places = 1) => `${n >= 0 ? '+' : ''}${round(n, places)}`;
/** Signed percentage from a 0-1 ratio: +2.4% */
export const fmtPctDelta = (n, places = 1) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(places)}%`;

export function gradeClass(letter) {
    if (letter.startsWith('A')) return 'g-a';
    if (letter.startsWith('B')) return 'g-b';
    if (letter.startsWith('C')) return 'g-c';
    return 'g-d';
}

export { el, sortBy, round };
