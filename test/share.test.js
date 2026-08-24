import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeOffer, decodeOffer, offerUrl } from '../js/share.js';

// --- Shareable trade links -------------------------------------------------

test('a trade round-trips through a URL hash', () => {
    const offer = {
        leagueId: '987654321',
        aRoster: 3, aSend: ['111', '222'], aFaab: 0,
        bRoster: 7, bSend: ['333'], bFaab: 0,
    };
    assert.deepEqual(decodeOffer(encodeOffer(offer)), offer);
});

test('cash survives the paste', () => {
    // A link that drops the $30 describes a different trade than the one that
    // was sent, and the recipient has no way to tell.
    const offer = {
        leagueId: 'L9',
        aRoster: 3, aSend: ['111'], aFaab: 30,
        bRoster: 7, bSend: ['333'], bFaab: 0,
    };
    const url = encodeOffer(offer);
    assert.match(url, /[?&]af=30(&|$)/);
    assert.deepEqual(decodeOffer(url), offer);
});

test('a garbage or negative cash amount decodes to nothing owed', () => {
    const base = decodeOffer('#/trade?a=1&as=9&b=2&bs=8&af=-40&bf=abc');
    assert.equal(base.aFaab, 0);
    assert.equal(base.bFaab, 0);
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
    assert.equal(decoded.aFaab, 0, 'a cashless trade stays cashless');
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
