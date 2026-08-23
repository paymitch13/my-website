import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// There are two number scales in this app and they look identical in source.
//
//   raw     points above replacement, what valuePlayer returns  (e.g. 47)
//   scaled  the convex market value the UI shows                (e.g. 6,240)
//
// Both are plain numbers, so nothing in the language catches a mix-up. It
// happened: the player picker rendered raw and the panel behind it rendered
// scaled, so choosing a player changed his number from 47 to 6,240 with one
// click, and because the scale is share ** 1.35 the two could not even be
// mentally converted. This is a lint, not a unit test, because the failure is
// a missing call at a render site and no amount of arithmetic testing can see
// that. It is narrow on purpose: it only looks at places that PRINT a value.
const dir = fileURLToPath(new URL('../js/', import.meta.url));

/** Every source file that renders UI. */
function renderSources() {
    const files = [['ui.js', readFileSync(`${dir}ui.js`, 'utf8')]];
    for (const name of readdirSync(`${dir}views`)) {
        if (name.endsWith('.js')) files.push([`views/${name}`, readFileSync(`${dir}views/${name}`, 'utf8')]);
    }
    return files;
}

test('no display site prints a raw player value', () => {
    // A value reaching the screen must go through the market scale first --
    // app.tradeValue for a raw number, formatValue for one already scaled, or
    // an injected formatter for a module that cannot see the app singleton.
    const offenders = [];
    for (const [name, src] of renderSources()) {
        src.split('\n').forEach((line, i) => {
            // Only lines that build a rendered element out of a value.
            if (!/\bel\(/.test(line)) return;
            if (/tradeValue|formatValue|shortValue|\bfmt\(/.test(line)) return;
            // `.value` on a form control is the DOM's, not a player's.
            const reads = [...line.matchAll(/\b(\w+)\.value\b(?!\s*=[^=])/g)]
                .map((m) => m[1])
                .filter((name) => !/^(search|input|textarea|select|target|field|box|node)$/.test(name));
            if (!reads.length) return;
            offenders.push(`${name}:${i + 1}  ${line.trim()}`);
        });
    }
    assert.deepEqual(
        offenders,
        [],
        `these render a player value without putting it on the market scale:\n${offenders.join('\n')}`
    );
});

test('the picker takes a formatter rather than hardcoding a scale', () => {
    // ui.js cannot import the app singleton that holds the scale, so the only
    // way it can print the same number as the view around it is to be handed
    // the formatter. If that parameter disappears, the picker silently falls
    // back to raw values and the mismatch is back.
    const src = readFileSync(`${dir}ui.js`, 'utf8');
    assert.match(src, /export function pickPlayer\(\{[^}]*formatValue/s, 'pickPlayer must accept formatValue');
});

test('every pickPlayer caller passes the scale', () => {
    for (const [name, src] of renderSources()) {
        if (name === 'ui.js') continue;
        // Each call site's object literal, up to its closing brace.
        for (const call of src.matchAll(/pickPlayer\(\{([\s\S]*?)\n\s*\}\)/g)) {
            assert.match(
                call[1],
                /formatValue:/,
                `${name}: a pickPlayer call omits formatValue, so it will print raw values`
            );
        }
    }
});
