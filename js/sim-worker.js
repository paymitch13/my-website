// Web Worker: runs season simulations off the main thread.
//
// Only the simulation crosses the boundary, because it is the one genuinely
// expensive step and the only one whose inputs are plain data. The valuation
// context and lineup solver stay on the main thread -- they hold closures and
// could not be structured-cloned anyway.

import { simulateSeason } from './sim.js';

self.onmessage = (e) => {
    const { id, teams, schedule, opts } = e.data || {};
    try {
        self.postMessage({ id, ok: true, result: simulateSeason(teams, schedule, opts) });
    } catch (err) {
        self.postMessage({ id, ok: false, error: err?.message || String(err) });
    }
};
