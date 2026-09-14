import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_URL } from '../src/translations';

/**
 * T1 (automated half) — the store/community bundle must carry ZERO slicer
 * payload, and the LEVO Studio entry must be a plain `<a>` navigation to the
 * standalone subdomain (docs/STUDIO_PLAN.md decision 6; owner mandate §2).
 *
 * This is a STATIC test: it walks the real store sources (src/, worker/,
 * index.html), extracts every module specifier from import/require/dynamic-
 * import statements, and pins them against the real slicer module names
 * (`three-slicer`, `occt-import-js`, `three`, `vinext`) and against any path
 * that resolves into the studio/ workspace. It cannot prove what a browser
 * downloads at runtime — that half of T1 is the network-trace evidence the
 * verify agent captures (zero three-slicer/occt/three.js/wasm requests on
 * store pages).
 *
 * Honest deviation from the one-line spec ("no fflate references in src/"):
 * the STORE ITSELF legitimately uses `fflate` for the admin product-template
 * ZIP import (src/components/adminProducts/ImportPanel.tsx,
 * worker/routes/template.ts) — it predates Studio and is not slicer payload.
 * Banning the name outright would fail on day one for the wrong reason, so
 * instead fflate imports are pinned to that exact allowlist: any NEW fflate
 * usage (e.g. 3MF/slicer handling creeping into the store) fails this test
 * and must be justified here.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Module names whose appearance in any store import is a T1 violation. */
const FORBIDDEN_MODULES = ['three-slicer', 'occt-import-js', 'three', 'vinext', '@react-three/fiber', '@react-three/drei'];

/** fflate is allowed ONLY in the admin template/import features.
 *
 *  worker/routes/adminImport.ts is the §10 Devices/Materials pipeline: it
 *  zips a template (data.csv + README.txt + images/) for download and unzips
 *  an uploaded one to read data.csv and the product photographs beside it.
 *  That is product-catalogue packaging, not slicer payload — no mesh, no 3MF,
 *  no G-code passes through it — so it is the same justification the two
 *  entries below already carry, for the file that replaces them as the
 *  primary flow.
 *
 *  worker/lib/modelGeometry.ts measures a customer's uploaded model so a print
 *  request can be priced. A 3MF file IS a ZIP archive whose payload is one XML
 *  part, so unzipping it is not an optional convenience — it is the only way to
 *  read the geometry at all, and the same is true of a zipped AMF. This is the
 *  ONE case where fflate touches a mesh, and it is admitted deliberately: the
 *  rule this list enforces is "no slicer ENGINE in the store", and a 60-line
 *  vertex reader with no `three`, no WASM and no engine coupling is the exact
 *  opposite of the payload the rule was written against. The file imports
 *  nothing else and is served entirely by the Worker.
 *
 *  NOTE THE ABSENCE OF A CLIENT-SIDE ENTRY. The browser never parses a model:
 *  measurement decides a price, so it happens on the server where the customer
 *  cannot edit it, and the viewer receives a derived mesh rather than a parser.
 *  That is why this entry is under worker/ and there is no src/ counterpart. */
const FFLATE_ALLOWLIST = new Set([
  join('src', 'components', 'adminProducts', 'ImportPanel.tsx'),
  join('worker', 'routes', 'template.ts'),
  join('worker', 'routes', 'adminImport.ts'),
  join('worker', 'lib', 'modelGeometry.ts'),
]);

const SCAN_DIRS = ['src', 'worker'];
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.html'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

function storeSourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);
  files.push(join(ROOT, 'index.html'));
  return files;
}

/** Every module specifier used by import/export-from/require/dynamic import. */
function moduleSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // import x from '...'; export ... from '...'
    /\bimport\s+['"]([^'"]+)['"]/g, // bare side-effect import '...'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('...')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('...')
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) out.push(m[1]);
  }
  return out;
}

function isForbiddenModule(spec: string): string | null {
  for (const name of FORBIDDEN_MODULES) {
    if (spec === name || spec.startsWith(`${name}/`)) return name;
  }
  return null;
}

/** True when a (relative or bare) specifier resolves into the studio workspace. */
function reachesStudioWorkspace(spec: string, fromFile: string): boolean {
  if (spec === 'studio' || spec.startsWith('studio/')) return true;
  if (spec.startsWith('.')) {
    const resolved = resolve(dirname(fromFile), spec);
    const studioRoot = join(ROOT, 'studio');
    return resolved === studioRoot || resolved.startsWith(studioRoot + sep);
  }
  return false;
}

test('store sources import no slicer engine module and no studio workspace code', () => {
  const violations: string[] = [];
  for (const file of storeSourceFiles()) {
    const rel = file.slice(ROOT.length + 1);
    const source = readFileSync(file, 'utf8');
    for (const spec of moduleSpecifiers(source)) {
      const forbidden = isForbiddenModule(spec);
      if (forbidden) violations.push(`${rel}: imports forbidden slicer module '${spec}' (${forbidden})`);
      if (reachesStudioWorkspace(spec, file)) violations.push(`${rel}: imports studio workspace code ('${spec}')`);
      if (spec === 'fflate' || spec.startsWith('fflate/')) {
        if (!FFLATE_ALLOWLIST.has(rel)) {
          violations.push(
            `${rel}: new fflate import outside the pinned template-import allowlist — ` +
              'if this is not slicer payload, extend FFLATE_ALLOWLIST with a justification'
          );
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('store package.json declares no slicer engine dependency', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const name of ['three-slicer', 'occt-import-js', 'three', 'vinext']) {
    assert.ok(!declared.includes(name), `root package.json must not depend on '${name}'`);
  }
});

test('no store source embeds, prefetches, or preloads a Studio asset', () => {
  const studioHost = new URL(STUDIO_URL).host;
  for (const file of storeSourceFiles()) {
    const rel = file.slice(ROOT.length + 1);
    const source = readFileSync(file, 'utf8');
    // Any <iframe> whose markup mentions the studio host is an embedding.
    for (const m of source.matchAll(/<iframe\b[^>]*>/gi)) {
      assert.ok(!m[0].includes(studioHost), `${rel}: <iframe> embedding the Studio host`);
    }
    // <link rel=prefetch/preload/modulepreload/dns-prefetch/preconnect ...>
    // pointing at the Studio host would download/warm Studio assets from
    // store pages — forbidden in either attribute order.
    for (const m of source.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      if (/rel=["']?(?:prefetch|preload|modulepreload|dns-prefetch|preconnect)["']?/i.test(tag)) {
        assert.ok(!tag.includes(studioHost), `${rel}: speculative <link> to the Studio host: ${tag}`);
      }
    }
  }
});

/**
 * The opening `<a ...>` tag of the Studio anchor, or null.
 *
 * WHY THIS IS NOT A REGEX. Two things defeat the obvious one:
 *
 *   1. These files DOCUMENT the anchor in prose — "written out as a LITERAL
 *      `<a href={STUDIO_URL}>`" — so a plain search finds the comment first
 *      and then happily asserts against a sentence. Comments are stripped.
 *   2. A JSX attribute value may legitimately contain a `>`; an
 *      `onClick={() => ...}` is the everyday case. Slicing to the first `>`
 *      would cut the tag in half and report a missing target that is right
 *      there. So the scan tracks brace depth and stops at the first `>` that
 *      is actually outside an expression.
 *
 * Getting this wrong does not make the guard fail open — it makes it fail
 * CLOSED on a valid edit, which is worse: it trains the next person to
 * delete the assertion.
 */
function studioOpenTag(source: string): string | null {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const at = code.search(/href=\{\s*STUDIO_URL\s*\}/);
  if (at < 0) return null;
  const start = code.lastIndexOf('<a', at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return code.slice(start, i + 1);
  }
  return null;
}

test('the Studio entry is a plain anchor to the configurable STUDIO_URL constant', () => {
  // The constant itself: https, the real subdomain, no path/query baggage.
  assert.equal(STUDIO_URL, 'https://studio.levonis-iq.com');
  assert.ok(STUDIO_URL.startsWith('https://'));

  // Every file that offers a Studio entry. The home page used to hold one
  // inline; the hero and the services grid own it now, so the guard follows
  // the link rather than being relaxed to let it slip out of view.
  const entries = [
    ['src/pages/Community.tsx', join(ROOT, 'src', 'pages', 'Community.tsx'), '..'],
    ['src/components/home/Hero.tsx', join(ROOT, 'src', 'components', 'home', 'Hero.tsx'), '../..'],
    ['src/components/home/ServicesGrid.tsx', join(ROOT, 'src', 'components', 'home', 'ServicesGrid.tsx'), '../..'],
  ] as const;

  for (const [name, path, importPrefix] of entries) {
    const source = readFileSync(path, 'utf8');
    // Every entry navigates via a plain <a href={STUDIO_URL}> — a navigation,
    // never a router <Link>, an iframe or a prefetch.
    assert.match(source, /<a\b[^>]*\bhref=\{STUDIO_URL\}/, `${name}: must render <a href={STUDIO_URL}>`);

    // AND it opens in its own tab. This assertion reverses an earlier one:
    // the target used to be left to the visitor, and the owner asked for the
    // Studio to open on its own page instead of replacing the store — losing
    // the cart and the scroll position of whoever clicked it. Pinned here so
    // it cannot quietly revert.
    //
    // rel="noopener noreferrer" is not decoration: without noopener the new
    // tab receives window.opener, a live handle onto the store page that a
    // compromised Studio build could navigate.
    const openTag = studioOpenTag(source);
    assert.ok(openTag, `${name}: no Studio anchor found outside comments`);
    assert.match(openTag!, /\btarget=(["']|\{['"])_blank/, `${name}: the Studio entry must open in a new tab — got ${openTag}`);

    // rel is checked as a SET, not a string: "noreferrer noopener" protects
    // exactly as well as "noopener noreferrer", and a guard that fails on the
    // word order teaches people to fight the test instead of reading it.
    const rel = /\brel=["']([^"']*)["']/.exec(openTag!)?.[1] ?? '';
    const relTokens = new Set(rel.split(/\s+/).filter(Boolean));
    assert.ok(
      relTokens.has('noopener') && relTokens.has('noreferrer'),
      `${name}: a _blank Studio entry needs rel with noopener AND noreferrer — got rel="${rel}"`
    );
    assert.match(
      source,
      new RegExp(
        `import\\s*\\{[^}]*\\bSTUDIO_URL\\b[^}]*\\}\\s*from\\s*['"]${importPrefix.replace(/\./g, '\\.')}/translations['"]`
      ),
      `${name}: must import STUDIO_URL from the shared constant`
    );
  }

  // And the home page must still REACH one of them, or the entry silently
  // disappears from the storefront while every assertion above still passes.
  const home = readFileSync(join(ROOT, 'src', 'pages', 'Home.tsx'), 'utf8');
  assert.match(
    home,
    /from '\.\.\/components\/home\/(Hero|ServicesGrid)'/,
    'src/pages/Home.tsx: must render a component that carries the Studio entry'
  );

  // Within the SPA the raw URL literal lives ONLY in src/translations.ts —
  // every other src/ file must go through the constant so the target stays
  // configurable in one place. (worker/ may name the origin in its own
  // config docs/allowlists — the server side cannot import an SPA constant.)
  for (const file of storeSourceFiles()) {
    const rel = file.slice(ROOT.length + 1);
    if (!rel.startsWith(`src${sep}`)) continue;
    if (rel === join('src', 'translations.ts')) continue;
    const source = readFileSync(file, 'utf8');
    assert.ok(
      !source.includes('studio.levonis-iq.com'),
      `${rel}: hardcodes the Studio URL — import STUDIO_URL from src/translations.ts instead`
    );
  }
});

/**
 * Deployable isolation (`01-TARGET.md` §10, API-versioning row): the SPA and the
 * core may share the CONTRACT of a service — `packages/contracts/src/http/<service>.ts`
 * — but never its CODE. So:
 *
 *   1. nothing under `src/` or `worker/` imports `services/` in any form (a
 *      type-only import would still make a service's source a build input of the
 *      core, and a runtime one would bundle another Worker into this one);
 *   2. `src/` imports `@levonis/*` packages TYPE-ONLY, so no validator, no
 *      envelope canonicaliser and no platform-kit module can reach the browser
 *      bundle by accident. `worker/` may import them at runtime — it already
 *      re-exports `@levonis/pricing` and `@levonis/shipping`.
 *
 * The complement (a service importing `worker/` or a sibling) is
 * `tests/serviceBoundaries.test.ts`; together they close the ring.
 */

/** True when a (relative or bare) specifier resolves into the services/ workspace. */
function reachesServiceWorkspace(spec: string, fromFile: string): boolean {
  if (spec === 'services' || spec.startsWith('services/') || spec.startsWith('@levonis/svc-')) return true;
  if (spec.startsWith('.')) {
    const resolved = resolve(dirname(fromFile), spec);
    const servicesRoot = join(ROOT, 'services');
    return resolved === servicesRoot || resolved.startsWith(servicesRoot + sep);
  }
  return false;
}

/**
 * Every specifier the module graph pulls in AT RUNTIME: `import type …` and
 * `export type … from` are erased by the compiler, so they are excluded; a bare
 * side-effect import, a `import(...)` and a `require(...)` never are.
 */
export function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  // import/export clauses with a `from`: the clause decides whether it survives.
  for (const m of source.matchAll(/\b(?:import|export)\s+([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    if (/^type\b/.test(clause)) continue; // import type X from '…' / export type { X } from '…'
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces) {
      const names = braces[1].split(',').map((s) => s.trim()).filter(Boolean);
      const outsideBraces = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
      // `import { type A, type B } from '…'` is fully erased; a default or
      // namespace binding beside the braces is not.
      if (names.length > 0 && names.every((n) => /^type\s/.test(n)) && outsideBraces === '') continue;
    }
    out.push(m[2]);
  }
  for (const re of [/\bimport\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of source.matchAll(re)) out.push(m[1]);
  }
  return out;
}

test('runtimeSpecifiers erases type-only imports and keeps everything else', () => {
  const kept = (src: string) => runtimeSpecifiers(src);
  assert.deepEqual(kept("import type { A } from 'a';"), []);
  assert.deepEqual(kept("export type { A } from 'a';"), []);
  assert.deepEqual(kept("import { type A, type B } from 'a';"), []);
  assert.deepEqual(kept("import { type A, b } from 'a';"), ['a']);
  assert.deepEqual(kept("import D, { type A } from 'a';"), ['a']);
  assert.deepEqual(kept("import * as ns from 'a';"), ['a']);
  assert.deepEqual(kept("import 'a';"), ['a']);
  assert.deepEqual(kept("const m = await import('a');"), ['a']);
  assert.deepEqual(kept("const m = require('a');"), ['a']);
  assert.deepEqual(kept("export * from 'a';"), ['a']);
});

test('no store or core source imports a service; the SPA imports contracts type-only and the pure model availability helper', () => {
  let scanned = 0;
  for (const file of storeSourceFiles()) {
    const rel = file.slice(ROOT.length + 1);
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(file)) continue;
    scanned++;
    const source = readFileSync(file, 'utf8');

    for (const spec of moduleSpecifiers(source)) {
      assert.ok(
        !reachesServiceWorkspace(spec, file),
        `${rel}: imports a service (${spec}) — share the contract via @levonis/contracts, never the code`
      );
    }

    if (!rel.startsWith(`src${sep}`)) continue;
    for (const spec of runtimeSpecifiers(source)) {
      assert.ok(
        !spec.startsWith('@levonis/') || spec === '@levonis/pricing/fulfillment',
        `${rel}: runtime-imports ${spec} — the SPA may only \`import type\` from @levonis/* (contract types are erased at build time)`
      );
    }
  }
  assert.ok(scanned > 100, `expected the store + core sources to be scanned, saw ${scanned} files`);
});
