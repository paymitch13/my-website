import test from 'node:test';
import assert from 'node:assert/strict';

import { politeFetch, coolingOff, resetNet, RateLimited } from '../js/net.js';

/** A Response-alike, since these tests never touch the network. */
const reply = (status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone() {
        return this;
    },
});

test.beforeEach(() => resetNet());

test('a normal response passes straight through', async () => {
    const res = await politeFetch('https://example.test/a', { fetchImpl: async () => reply(200) });
    assert.equal(res.status, 200);
    assert.equal(coolingOff('https://example.test/a'), 0);
});

test('a 429 puts the whole host in the penalty box', async () => {
    // The point is that the NEXT call costs nothing and reaches nobody. Piling
    // more requests onto a service that has just asked us to stop is how a free
    // API stops being available to anyone.
    let calls = 0;
    const impl = async () => {
        calls++;
        return reply(429, { 'retry-after': '30' });
    };
    await politeFetch('https://limited.test/a', { fetchImpl: impl });
    assert.equal(calls, 1);

    const left = coolingOff('https://limited.test/b');
    assert.ok(left > 25000 && left <= 30000, `expected ~30s of cool-off, got ${left}ms`);

    await assert.rejects(
        () => politeFetch('https://limited.test/b', { fetchImpl: impl }),
        RateLimited
    );
    assert.equal(calls, 1, 'the second call must not reach the network at all');
});

test('a 503 is treated as the same request to back off', async () => {
    await politeFetch('https://flaky.test/a', { fetchImpl: async () => reply(503) });
    assert.ok(coolingOff('https://flaky.test/a') > 0);
});

test('one host backing off does not silence the others', async () => {
    await politeFetch('https://limited.test/a', { fetchImpl: async () => reply(429) });
    const res = await politeFetch('https://fine.test/a', { fetchImpl: async () => reply(200) });
    assert.equal(res.status, 200);
});

test('Retry-After as an HTTP date is understood', async () => {
    const when = new Date(Date.now() + 45000).toUTCString();
    await politeFetch('https://dated.test/a', { fetchImpl: async () => reply(429, { 'retry-after': when }) });
    const left = coolingOff('https://dated.test/a');
    assert.ok(left > 35000 && left <= 46000, `expected ~45s, got ${left}ms`);
});

test('an unparseable Retry-After backs off rather than retrying at once', async () => {
    // "Immediately" is the one thing a rate-limited server did not mean.
    await politeFetch('https://odd.test/a', { fetchImpl: async () => reply(429, { 'retry-after': 'soon-ish' }) });
    assert.ok(coolingOff('https://odd.test/a') > 30000);
});

test('a theatrical Retry-After is capped', async () => {
    await politeFetch('https://drama.test/a', { fetchImpl: async () => reply(429, { 'retry-after': '999999' }) });
    const left = coolingOff('https://drama.test/a');
    assert.ok(left <= 10 * 60 * 1000, `cool-off must be capped, got ${left}ms`);
});

test('identical requests in flight share one call', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const impl = async () => {
        calls++;
        await gate;
        return reply(200);
    };

    const a = politeFetch('https://dedupe.test/same', { fetchImpl: impl });
    const b = politeFetch('https://dedupe.test/same', { fetchImpl: impl });
    release();
    await Promise.all([a, b]);
    assert.equal(calls, 1, 'several views wanting the same week of odds is one request');
});

test('different urls on one host are not deduplicated into each other', async () => {
    let calls = 0;
    const impl = async () => { calls++; return reply(200); };
    await Promise.all([
        politeFetch('https://dedupe.test/one', { fetchImpl: impl }),
        politeFetch('https://dedupe.test/two', { fetchImpl: impl }),
    ]);
    assert.equal(calls, 2);
});

test('requests to one host are capped rather than fired all at once', async () => {
    let active = 0;
    let peak = 0;
    const impl = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return reply(200);
    };
    // Sixteen games on a slate, which is the real case.
    await Promise.all(
        Array.from({ length: 16 }, (_, i) => politeFetch(`https://slate.test/g${i}`, { fetchImpl: impl }))
    );
    assert.ok(peak <= 4, `expected at most 4 in flight, saw ${peak}`);
});

test('the queue drains even when requests fail', async () => {
    const impl = async (url) => {
        if (url.endsWith('3')) throw new Error('boom');
        return reply(200);
    };
    const results = await Promise.allSettled(
        Array.from({ length: 9 }, (_, i) => politeFetch(`https://drain.test/g${i}`, { fetchImpl: impl }))
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 8);
    // A slot leak would show up as the next call never resolving.
    const after = await politeFetch('https://drain.test/after', { fetchImpl: impl });
    assert.equal(after.status, 200);
});

test('a request that never settles is abandoned', async () => {
    const impl = (url, init) =>
        new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
    await assert.rejects(() => politeFetch('https://hang.test/a', { fetchImpl: impl, timeout: 30 }));
    // And the slot it held is back, or everything behind it would hang too.
    const res = await politeFetch('https://hang.test/b', { fetchImpl: async () => reply(200) });
    assert.equal(res.status, 200);
});
