/**
 * `packages/contracts/src/http/<service>.ts` — the response types shared with
 * the SPA (`02-MIGRATION-PLAN.md` §1.1; `01-TARGET.md` §10, API-versioning row).
 *
 * Two rules make them safe to share:
 *   1. one file per service that owns an HTTP surface in Phase 1, re-exported
 *      from the package index, so `src/` has exactly one import path;
 *   2. the per-service files are TYPE-ONLY — no `const`, `function`, `class` or
 *      `enum` — so `import type` is always sufficient and nothing from this
 *      package can be pulled into the browser bundle by writing the import the
 *      wrong way. (`http/common.ts` is the deliberate exception: the header
 *      names are values, and both sides need the same strings.)
 *
 * `tests/store-isolation.test.ts` enforces the SPA half (type-only imports of
 * `@levonis/*`); this enforces that the contracts make that possible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_DIR = join(PKG, 'src', 'http');

/**
 * The services `02-MIGRATION-PLAN.md` §1.1 gives an HTTP surface in Phase 1.
 * `probes/` is throwaway (slice 1.0) and never has a contract. A service added
 * to the tree later must arrive with its contract file, which is why this list
 * is compared in BOTH directions.
 */
const PHASE1_HTTP_SERVICES = ['gateway', 'audit', 'analytics', 'ads', 'notifications'];

/** Files that are not a per-service contract. */
const SHARED = ['common', 'health'];

const read = (name: string) => readFileSync(join(HTTP_DIR, `${name}.ts`), 'utf8');

test('every Phase 1 service with an HTTP surface has a contract file, and nothing else is in http/', () => {
  const present = readdirSync(HTTP_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .sort();
  assert.deepEqual(present, [...PHASE1_HTTP_SERVICES, ...SHARED].sort());
});

test('every contract file is re-exported from the package index', () => {
  const index = readFileSync(join(PKG, 'src', 'index.ts'), 'utf8');
  for (const name of [...PHASE1_HTTP_SERVICES, ...SHARED]) {
    assert.ok(
      index.includes(`from './http/${name}'`),
      `src/index.ts does not re-export http/${name} — the SPA would need a deep import path`
    );
  }
});

test('per-service contract files are type-only: no value survives compilation', () => {
  for (const name of PHASE1_HTTP_SERVICES) {
    const source = read(name)
      // comments carry prose about consts and functions; only code counts
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const kind of ['const', 'let', 'var', 'function', 'class', 'enum']) {
      const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?${kind}\\s`, '');
      assert.ok(
        !re.test(source),
        `http/${name}.ts declares a ${kind} — per-service contracts must be types only so \`import type\` suffices`
      );
    }
    assert.ok(
      /export (?:interface|type) /.test(source),
      `http/${name}.ts exports no type — an empty contract is a mistake, not a boundary`
    );
    // A runtime import would defeat the point even if the file itself is types.
    for (const m of source.matchAll(/\b(?:import|export)\s+([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
      assert.ok(
        /^type\b/.test(m[1].trim()),
        `http/${name}.ts imports ${m[2]} at runtime — use \`import type\``
      );
    }
  }
});
