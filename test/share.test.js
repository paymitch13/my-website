import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeOffer, decodeOffer, offerUrl } from '../js/share.js';

// --- Shareable trade links -------------------------------------------------

test('a trade round-trips through a URL hash', () => {
    const offer = { leagueId: '987654321', aRoster: 3, aSend: ['111', '222'], bRoster: 7, bSend: ['333'] };
    const decoded = decodeOffer(encodeOffer(offer));
    assert.deepEqual(decoded, offer);
});

test('the league id travels with the offer', () => {
    // Roster 3 is a different team in every league, so a link that omits the
    // league is only readable by somebody already synced to it -- who did not
    // need the link.
    const url = encodeOffer({ leagueId: '123', aRoster: 1, aSend: ['9'], bRoster: 2, bSend: ['8'] });
    assert.match(url, /[?&]l=123(&|$)/);
    assert.equal(decodeOffer(url).leagueId, '123');
});

test('a link made without a league still decodes, with none', () => {
    const decoded = decodeOffer(encodeOffer({ aRoster: 3, aSend: ['1'], bRoster: 4, bSend: ['2'] }));
    assert.equal(decoded.leagueId, null);
    assert.equal(decoded.aRoster, 3);
});

test('offerUrl builds an absolute, pasteable link', () => {
    const url = offerUrl({ aRoster: 1, aSend: ['9'], bRoster: 2, bSend: ['8'] }, 'https://example.com/app/');
    assert.equal(url, 'https://example.com/app/#/trade?a=1&as=9&b=2&bs=8');
});

test('a malformed hash decodes to nothing rather than throwing', () => {
    assert.equal(decodeOffer('#/trade'), null);
    assert.equal(decodeOffer(''), null);
    assert.equal(decodeOffer('#/trade?a=&b='), null);
});
