// Small shared helpers. No dependencies, no framework.

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const sum = (arr, f = (x) => x) => arr.reduce((a, b) => a + f(b), 0);

export const mean = (arr, f = (x) => x) => (arr.length ? sum(arr, f) / arr.length : 0);

export function stdev(arr, f = (x) => x) {
    if (arr.length < 2) return 0;
    const m = mean(arr, f);
    return Math.sqrt(sum(arr, (x) => (f(x) - m) ** 2) / (arr.length - 1));
}

/** Sort helper that never mutates the input. */
export const sortBy = (arr, f, dir = 1) => [...arr].sort((a, b) => (f(a) - f(b)) * dir);

export const groupBy = (arr, f) => {
    const out = new Map();
    for (const item of arr) {
        const k = f(item);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(item);
    }
    return out;
};

export const round = (n, places = 1) => {
    const m = 10 ** places;
    return Math.round(n * m) / m;
};

export const pct = (n, places = 0) => `${(n * 100).toFixed(places)}%`;

export const signed = (n, places = 1) => (n >= 0 ? `+${round(n, places)}` : `${round(n, places)}`);

/**
 * Box-Muller. Returns a standard normal deviate.
 * Used heavily by the season simulator, so it avoids allocation.
 */
export function randNorm() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Standard normal CDF, Abramowitz & Stegun 26.2.17. */
export function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
    const p =
        d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
}

export const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Fires `fn` at most once per `ms`, on the trailing edge. */
export function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

/** `el('div', {class:'x'}, 'text')` -> HTMLElement */
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Deterministic PRNG so a given sim result can be reproduced when we want it to be. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
