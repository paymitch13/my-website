// Shareable trade links.
//
// A trade encoded in the URL hash can be pasted into a league chat, which is
// where trades actually get discussed. Kept separate from the views so it stays
// pure: no DOM, no app singleton, importable from a test.

/**
 * #/trade?l=<league>&a=<roster>&as=<ids>&b=<roster>&bs=<ids>
 *
 * The league id travels with the offer. Roster ids mean nothing on their own --
 * roster 3 is a different team in every league -- so a link without one is only
 * readable by somebody already synced to the same league, which is exactly the
 * person who did not need the link.
 */
export function encodeOffer({ leagueId, aRoster, aSend, bRoster, bSend, aFaab = 0, bFaab = 0 }) {
    const league = leagueId ? `l=${encodeURIComponent(leagueId)}&` : '';
    // Cash is part of the offer, so it has to survive the paste. A link that
    // drops the $30 describes a different trade than the one that was sent.
    const cash = (Number(aFaab) || 0) || (Number(bFaab) || 0)
        ? `&af=${Number(aFaab) || 0}&bf=${Number(bFaab) || 0}`
        : '';
    return `#/trade?${league}a=${aRoster}&as=${(aSend || []).join('.')}&b=${bRoster}&bs=${(bSend || []).join('.')}${cash}`;
}

export function decodeOffer(hash) {
    const q = String(hash || '').split('?')[1];
    if (!q) return null;
    const p = new URLSearchParams(q);
    const aRoster = Number(p.get('a'));
    const bRoster = Number(p.get('b'));
    if (!aRoster || !bRoster) return null;
    const split = (v) => (v ? v.split('.').filter(Boolean) : []);
    const cash = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    return {
        leagueId: p.get('l') || null,
        aRoster,
        aSend: split(p.get('as')),
        aFaab: cash(p.get('af')),
        bRoster,
        bSend: split(p.get('bs')),
        bFaab: cash(p.get('bf')),
    };
}

/** Absolute link to a trade, for pasting somewhere else. */
export const offerUrl = (offer, base = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '') =>
    `${base}${encodeOffer(offer)}`;
