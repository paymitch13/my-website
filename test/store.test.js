import test from 'node:test';
import assert from 'node:assert/strict';

// `store.js` reads localStorage at import time, so the shim has to exist
// before the module does -- hence the dynamic import below rather than a
// static one at the top of the file.
function installStorage() {
    const map = new Map();
    globalThis.localStorage = {
        getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
        setItem: (k, v) => map.set(String(k), String(v)),
        removeItem: (k) => map.delete(String(k)),
        clear: () => map.clear(),
        get length() {
            return map.size;
        },
    };
    return map;
}

const storage = installStorage();
const store = await import('../js/store.js');

test.beforeEach(() => storage.clear());

test('a browser that really persists is reported as persisting', () => {
    assert.equal(store.persists, true);
});

// --- Projections are week-scoped -------------------------------------------
//
// Projections had a six-hour shelf life and nothing else. That is right within
// a week and wrong across one: somebody who opened the app on Tuesday was
// shown Sunday's numbers because the clock still had hours left on them, and
// the whole app read as a week stale. A new NFL week is a new set of facts, so
// it invalidates outright rather than waiting out a timer.

test('a cached projection set is reused inside the same week', () => {
    store.cacheProjections(2026, { a: { id: 'a' } }, 4);
    const hit = store.loadCachedProjections(2026, 6 * 60 * 60 * 1000, 4);
    assert.ok(hit, 'the same week must come back from cache');
    assert.equal(hit.stale, false);
    assert.deepEqual(hit.projections, { a: { id: 'a' } });
});

test('a new week throws the cache away even while the timer is still running', () => {
    store.cacheProjections(2026, { a: { id: 'a' } }, 3);
    // Cached seconds ago, so no TTL has expired -- only the week has moved.
    assert.equal(
        store.loadCachedProjections(2026, 6 * 60 * 60 * 1000, 4),
        null,
        "week 3's projections must not be served in week 4"
    );
});

test('a new season throws the cache away too', () => {
    store.cacheProjections(2025, { a: { id: 'a' } }, 4);
    assert.equal(store.loadCachedProjections(2026, 6 * 60 * 60 * 1000, 4), null);
});

test('a cache written before weeks were tracked is still usable', () => {
    // Upgrade path: an entry from the previous version carries no week. It is
    // no less fresh than it was, so it stays valid and ages out on the timer
    // rather than being discarded for a field it could not have had.
    store.cacheProjections(2026, { a: { id: 'a' } });
    const hit = store.loadCachedProjections(2026, 6 * 60 * 60 * 1000, 4);
    assert.ok(hit, 'a week-less entry must not be treated as a week mismatch');
});

test('not knowing the week is not a reason to discard', () => {
    store.cacheProjections(2026, { a: { id: 'a' } }, 4);
    assert.ok(store.loadCachedProjections(2026, 6 * 60 * 60 * 1000, null));
});

test('an old entry from the right week is served but flagged stale', () => {
    store.cacheProjections(2026, { a: { id: 'a' } }, 4);
    const hit = store.loadCachedProjections(2026, -1, 4);
    assert.ok(hit);
    assert.equal(hit.stale, true, 'callers refresh in the background on this flag');
});
