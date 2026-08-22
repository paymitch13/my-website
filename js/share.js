// Shareable trade links.
//
// A trade encoded in the URL hash can be pasted into a league chat, which is
// where trades actually get discussed. Kept separate from the views so it stays
// pure: no DOM, no app singleton, importable from a test.

/** #/trade?a=<roster>&as=<ids>&b=<roster>&bs=<ids> */
export function encodeOffer({ aRoster, aSend, bRoster, bSend }) {
    return `#/trade?a=${aRoster}&as=${(aSend || []).join('.')}&b=${bRoster}&bs=${(bSend || []).join('.')}`;
}

export function decodeOffer(hash) {
    const q = String(hash || '').split('?')[1];
    if (!q) return null;
    const p = new URLSearchParams(q);
    const aRoster = Number(p.get('a'));
    const bRoster = Number(p.get('b'));
    if (!aRoster || !bRoster) return null;
    const split = (v) => (v ? v.split('.').filter(Boolean) : []);
    return { aRoster, aSend: split(p.get('as')), bRoster, bSend: split(p.get('bs')) };
}

/** Absolute link to a trade, for pasting somewhere else. */
export const offerUrl = (offer, base = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '') =>
    `${base}${encodeOffer(offer)}`;
