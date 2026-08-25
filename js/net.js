// One polite front door for every third-party request.
//
// This app calls four services straight from the visitor's browser: Sleeper,
// FantasyCalc, ESPN and Open-Meteo. All four are free, and two of them are
// undocumented or explicitly non-commercial. With one user that arrangement is
// invisible. With a thousand it is a way to get quietly blocked -- and because
// every failure path here is deliberately silent, the app would degrade without
// anybody noticing why.
//
// Four things, all of them about being a good guest:
//
//   1. BACK OFF WHEN TOLD TO. A 429 or a 503 sets a cool-off for that host and
//      every later call fails fast until it lifts, rather than piling more
//      requests onto a service that has just asked us to stop. Retry-After is
//      honoured when the server sends it.
//   2. DO NOT FLOOD. Requests are capped per host, so scanning a sixteen-game
//      slate makes a few requests at a time instead of sixteen at once.
//   3. DO NOT ASK TWICE. Identical URLs in flight at the same moment share one
//      request. Several views want the same week's odds on the same tick.
//   4. GIVE UP EVENTUALLY. A hung request that never settles is worse than a
//      failed one, because the caller's fallback never runs.

/** How many requests may be in flight to one host at a time. */
const CONCURRENCY = 4;

/** How long to wait on a request before treating it as failed. */
const TIMEOUT_MS = 15000;

/** Cool-off when a server rate-limits us without saying for how long. */
const DEFAULT_COOLOFF_MS = 60000;

/** Longest we will sit out, however dramatic the Retry-After header. */
const MAX_COOLOFF_MS = 10 * 60 * 1000;

const coolOff = new Map(); // host -> timestamp
const queues = new Map(); // host -> { active, waiting[] }
const inFlight = new Map(); // url -> Promise

export class RateLimited extends Error {
    constructor(host, until) {
        super(`${host} is rate-limiting us; backing off until ${new Date(until).toISOString()}`);
        this.name = 'RateLimited';
        this.host = host;
        this.until = until;
    }
}

const hostOf = (url) => {
    try {
        return new URL(url, globalThis.location?.href).host;
    } catch {
        return 'unknown';
    }
};

/** Whether a host is currently in the penalty box, and for how much longer. */
export function coolingOff(url) {
    const until = coolOff.get(hostOf(url)) ?? 0;
    return until > Date.now() ? until - Date.now() : 0;
}

/** Clear every cool-off and queue. Tests only. */
export function resetNet() {
    coolOff.clear();
    queues.clear();
    inFlight.clear();
}

function slot(host) {
    if (!queues.has(host)) queues.set(host, { active: 0, waiting: [] });
    const q = queues.get(host);
    if (q.active < CONCURRENCY) {
        q.active++;
        return Promise.resolve();
    }
    return new Promise((resolve) => q.waiting.push(resolve));
}

function release(host) {
    const q = queues.get(host);
    if (!q) return;
    const next = q.waiting.shift();
    if (next) next();
    else q.active--;
}

/**
 * Seconds from a Retry-After header, which may be a delay or an HTTP date.
 * Anything unparseable falls back to the default rather than to zero, because
 * "retry immediately" is the one interpretation a rate-limited server did not
 * mean.
 */
function retryAfterMs(header) {
    if (!header) return DEFAULT_COOLOFF_MS;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_COOLOFF_MS);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_COOLOFF_MS);
    return DEFAULT_COOLOFF_MS;
}

/**
 * Fetch, politely.
 *
 * Returns the Response exactly as `fetch` would, so callers keep their own
 * status handling. Throws RateLimited when the host is in a cool-off, which
 * every caller already treats as "no data this time" -- the point is that it
 * costs nothing and reaches nobody.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout]
 * @param {boolean} [opts.dedupe] share an identical in-flight request
 * @param {Function} [opts.fetchImpl] injected for tests
 */
export async function politeFetch(url, { timeout = TIMEOUT_MS, dedupe = true, fetchImpl = null } = {}) {
    const host = hostOf(url);
    const until = coolOff.get(host) ?? 0;
    if (until > Date.now()) throw new RateLimited(host, until);

    if (dedupe && inFlight.has(url)) return inFlight.get(url).then((res) => res.clone());

    const run = (async () => {
        await slot(host);
        const doFetch = fetchImpl || fetch;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => controller?.abort(), timeout);
        try {
            const res = await doFetch(url, controller ? { signal: controller.signal } : undefined);
            // 429 is the explicit ask; 503 usually means the same thing with
            // less ceremony. Both earn the whole host a rest.
            if (res.status === 429 || res.status === 503) {
                const wait = retryAfterMs(res.headers?.get?.('retry-after'));
                coolOff.set(host, Date.now() + wait);
            }
            return res;
        } finally {
            clearTimeout(timer);
            release(host);
        }
    })();

    if (dedupe) {
        inFlight.set(url, run);
        run.finally(() => {
            if (inFlight.get(url) === run) inFlight.delete(url);
        }).catch(() => {});
        return run.then((res) => res.clone());
    }
    return run;
}
