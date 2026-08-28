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
 * ZIP import (src/components/adminProducts/TemplateImport.tsx,
 * worker/routes/template.ts) — it predates Studio and is not slicer payload.
 * Banning the name outright would fail on day one for the wrong reason, so
 * instead fflate imports are pinned to that exact allowlist: any NEW fflate
 * usage (e.g. 3MF/slicer handling creeping into the store) fails this test
 * and must be justified here.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Module names whose appearance in any store import is a T1 violation. */
const FORBIDDEN_MODULES = ['three-slicer', 'occt-import-js', 'three', 'vinext', '@react-three/fiber', '@react-three/drei'];

/** fflate is allowed ONLY in the pre-existing template-import feature. */
const FFLATE_ALLOWLIST = new Set([
  join('src', 'components', 'adminProducts', 'TemplateImport.tsx'),
  join('worker', 'routes', 'template.ts'),
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

test('the Studio entry is a plain anchor to the configurable STUDIO_URL constant', () => {
  // The constant itself: https, the real subdomain, no path/query baggage.
  assert.equal(STUDIO_URL, 'https://studio.levonis-iq.com');
  assert.ok(STUDIO_URL.startsWith('https://'));

  const home = readFileSync(join(ROOT, 'src', 'pages', 'Home.tsx'), 'utf8');
  const community = readFileSync(join(ROOT, 'src', 'pages', 'Community.tsx'), 'utf8');
  for (const [name, source] of [
    ['src/pages/Home.tsx', home],
    ['src/pages/Community.tsx', community],
  ] as const) {
    // Both entries navigate via a plain <a href={STUDIO_URL}> — full page
    // navigation, target choice left to the user (no forced new tab).
    assert.match(source, /<a\b[^>]*\bhref=\{STUDIO_URL\}/, `${name}: must render <a href={STUDIO_URL}>`);
    assert.match(
      source,
      /import\s*\{[^}]*\bSTUDIO_URL\b[^}]*\}\s*from\s*['"]\.\.\/translations['"]/,
      `${name}: must import STUDIO_URL from the shared constant`
    );
  }

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
