// Client for the simulation worker, with a synchronous fallback.
//
// Two thousand simulated seasons over fourteen weeks is millions of random
// draws. Run inline it locks the page for seconds: the spinner paints and then
// nothing moves, which reads as a crash. In a worker the UI stays alive.

import { simulateSeason } from './sim.js';

let worker = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
    if (worker !== null) return worker;
    if (typeof Worker === 'undefined') {
        worker = false;
        return worker;
    }
    try {
        worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
            const { id, ok, result, error } = e.data || {};
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            if (ok) entry.resolve(result);
            else entry.reject(new Error(error));
        };
        worker.onerror = () => {
            // Module workers are unavailable in a few environments; fall back
            // rather than leaving the caller hanging.
            for (const { resolve, args } of pending.values()) resolve(simulateSeason(...args));
            pending.clear();
            worker = false;
        };
    } catch {
        worker = false;
    }
    return worker;
}

/** Same signature as simulateSeason, but returns a promise. */
export function runSimulation(teams, schedule, opts) {
    const w = ensureWorker();
    if (!w) return Promise.resolve(simulateSeason(teams, schedule, opts));

    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, args: [teams, schedule, opts] });
        w.postMessage({ id, teams, schedule, opts });
    });
}
