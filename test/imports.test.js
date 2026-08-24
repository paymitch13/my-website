import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

// `node --check` parses a file; it does not resolve anything in it. A view can
// reference an identifier it never imported and pass every syntax check, then
// throw the moment a user opens that tab -- which is exactly what happened to
// the Start/Sit tab. The views cannot simply be imported here to find out,
// because they reach app.js, which touches `document` at module scope.
//
// So this reads the imports and the exports and checks them against each other.
const root = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(dir = 'js') {
    const out = [];
    for (const name of readdirSync(resolve(root, dir), { withFileTypes: true })) {
        const path = `${dir}/${name.name}`;
        if (name.isDirectory()) out.push(...sourceFiles(path));
        else if (name.name.endsWith('.js')) out.push(path);
    }
    return out;
}

/** Every name a module exports, however it spells the export. */
function exportsOf(src) {
    const names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    // export { a, b as c }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
        for (const part of m[1].split(',')) {
            const bits = part.trim().split(/\s+as\s+/);
            if (bits.length > 1) names.add(bits[1].trim());
            else if (bits[0]) names.add(bits[0].trim());
        }
    }
    if (/export\s+default/.test(src)) names.add('default');
    return names;
}

/** Every local module a file imports, and the names it takes from each. */
function importsOf(src) {
    const out = [];
    const re = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*(?:from\s*)?['"](\.[^'"]*)['"]/g;
    for (const m of src.matchAll(re)) {
        const [, defaultWith, braces, namespace, bareDefault, spec] = m;
        const names = [];
        if (defaultWith || bareDefault) names.push('default');
        if (braces) {
            for (const part of braces.split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (name) names.push(name);
            }
        }
        out.push({ spec, names, namespace: !!namespace });
    }
    return out;
}

test('every import resolves to a file that exists', () => {
    const missing = [];
    for (const file of sourceFiles()) {
        const src = readFileSync(resolve(root, file), 'utf8');
        for (const imp of importsOf(src)) {
            const target = resolve(dirname(resolve(root, file)), imp.spec);
            if (!existsSync(target)) missing.push(`${file} imports "${imp.spec}", which does not exist`);
        }
    }
    assert.deepEqual(missing, [], missing.join('\n'));
});

test('every imported name is actually exported', () => {
    const cache = new Map();
    const exportsFor = (path) => {
        if (!cache.has(path)) cache.set(path, exportsOf(readFileSync(path, 'utf8')));
        return cache.get(path);
    };

    const broken = [];
    for (const file of sourceFiles()) {
        const src = readFileSync(resolve(root, file), 'utf8');
        for (const imp of importsOf(src)) {
            const target = resolve(dirname(resolve(root, file)), imp.spec);
            if (!existsSync(target)) continue;
            const available = exportsFor(target);
            for (const name of imp.names) {
                if (!available.has(name)) {
                    broken.push(`${file} imports { ${name} } from "${imp.spec}", which does not export it`);
                }
            }
        }
    }
    assert.deepEqual(broken, [], broken.join('\n'));
});

test('nothing is used that was never imported or defined', () => {
    // The narrow version of the check that matters: a call to a bare
    // identifier that looks like a module function (camelCase, called as
    // `name(`) and is neither imported, declared, nor a known global.
    const GLOBALS = new Set([
        'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
        'requestAnimationFrame', 'structuredClone', 'Worker', 'URL', 'URLSearchParams', 'Promise',
        'Map', 'Set', 'Array', 'Object', 'Number', 'String', 'Boolean', 'Math', 'JSON', 'Date',
        'Error', 'RegExp', 'Intl', 'console', 'document', 'window', 'location', 'localStorage',
        'navigator', 'self', 'performance', 'isNaN', 'parseInt', 'parseFloat', 'Symbol', 'BigInt',
        'Uint8Array', 'Float64Array', 'Int32Array', 'AbortController', 'TextEncoder', 'TextDecoder',
        'Response', 'Request', 'Headers', 'Blob', 'FileReader', 'CustomEvent', 'Event', 'process',
        'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'super', 'await',
        // Keywords that look like calls in `(async () => {…})()` and `import(…)`.
        'async', 'import',
    ]);

    // Comments and string literals are prose, not code. Without stripping them
    // every "the scoreboard (which...)" in a comment reads as a call.
    const strip = (src) =>
        src
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
            .replace(/`(?:[^`\\]|\\.)*`/g, '``')
            .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
            .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

    const broken = [];
    for (const file of sourceFiles()) {
        // Imports are read from the RAW source: stripping string literals also
        // strips the module specifiers they are written with.
        const raw = readFileSync(resolve(root, file), 'utf8');
        const src = strip(raw);

        const known = new Set(GLOBALS);
        for (const imp of importsOf(raw)) for (const n of imp.names) known.add(n);
        for (const m of raw.matchAll(/import\s+\*\s+as\s+([\w$]+)/g)) known.add(m[1]);
        for (const m of raw.matchAll(/import\s+([\w$]+)\s*(?:,|from)/g)) known.add(m[1]);
        // Anything declared in this file, at any depth.
        for (const m of src.matchAll(/(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
        for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
        // Destructured bindings and parameters, taken loosely.
        // Object destructuring, INCLUDING renames: `{ formatValue: fmt = … }`
        // binds fmt, not formatValue, and taking the left half misses it.
        for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
            for (const part of m[1].split(',')) {
                const bits = part.trim().split(':');
                const bound = (bits.length > 1 ? bits[1] : bits[0]).split('=')[0];
                const name = bound.replace(/[{}[\]().]/g, '').trim();
                if (name) known.add(name);
            }
        }
        // Array destructuring: `for (const [stat, f] of …)`.
        for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
            for (const part of m[1].split(',')) {
                const name = part.split('=')[0].replace(/[{}[\]().]/g, '').trim();
                if (name) known.add(name);
            }
        }
        // Renamed bindings anywhere in a destructuring pattern -- including
        // multi-line function parameters, whose default values contain their
        // own parentheses and defeat a single-line parameter match:
        //   function pickPlayer({ formatValue: fmt = (v) => round(v, 0) })
        // This also catches `{ onclick: someHandler }` in a plain object, which
        // slightly weakens the check for names used as values. That is the
        // right trade: the bug worth catching is a call to something never
        // mentioned anywhere, and no object literal makes that look defined.
        for (const m of src.matchAll(/[{,]\s*[\w$]+\s*:\s*([a-z][\w$]*)\s*(?:=|[,}\n])/g)) known.add(m[1]);

        // Destructured callback parameters: `.then(({ modal }) => …)`.
        for (const m of src.matchAll(/\(\s*\{([^}]*)\}\s*\)\s*=>/g)) {
            for (const part of m[1].split(',')) {
                const bits = part.trim().split(':');
                const bound = (bits.length > 1 ? bits[1] : bits[0]).split('=')[0];
                const name = bound.replace(/[{}[\]().]/g, '').trim();
                if (name) known.add(name);
            }
        }
        for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/[:=]/)[0].replace(/[{}[\]().]/g, '').trim();
                if (name) known.add(name);
            }
        }
        for (const m of src.matchAll(/function[^(]*\(([^)]*)\)/g)) {
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/[:=]/)[0].replace(/[{}[\]().]/g, '').trim();
                if (name) known.add(name);
            }
        }
        // Object-literal method shorthand: `rebuild() {`, `async valueOf(x) {`.
        for (const m of src.matchAll(/(?:^|[,{]\s*)(?:async\s+)?([a-z][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
            known.add(m[1]);
        }
        // Property shorthand that takes a function: `onclick: () => …` is not a
        // call, but `foo: bar(…)` names bar, which is covered by imports.

        // Calls to a bare lowerCamelCase identifier, not a method call.
        for (const m of src.matchAll(/(^|[^\w$.'"`])([a-z][\w$]*)\s*\(/gm)) {
            const name = m[2];
            if (known.has(name)) continue;
            broken.push(`${relative(root, resolve(root, file))}: calls ${name}(), which is neither imported nor defined here`);
        }
    }
    assert.deepEqual([...new Set(broken)], [], [...new Set(broken)].join('\n'));
});
