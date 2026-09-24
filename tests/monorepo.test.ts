/**
 * The monorepo layout and package purity (`02-MIGRATION-PLAN.md` §1.1, ADR-004):
 * root workspaces are `packages/*` and `services/*`; every package has a
 * manifest, a tsconfig and a README; `@levonis/pricing` and `@levonis/shipping`
 * are PURE (relative imports only, no bindings, no fetch, no Hono); the
 * contracts import nothing but themselves; the platform kit imports only the
 * contracts, hono and its own modules — never `worker/` or `services/`; and the
 * core's moved libraries are one-line re-exports so every import path still works.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSpecifiers, tsFiles } from './lib/boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// `storeLayout` (wave 2, W2-C): the store-page schema shared by the Worker and the
// storefront; pure for the same reason the pricing engine is.
const PURE_PACKAGES = ['pricing', 'shipping', 'storeLayout'];
const ALL_PACKAGES = ['platform-kit', 'contracts', 'pricing', 'shipping', 'storeLayout'];

test('root workspaces and per-package manifests', () => {
  const pkg = JSON.parse(read('package.json')) as { workspaces?: string[]; scripts: Record<string, string> };
  assert.deepEqual(pkg.workspaces, ['packages/*', 'services/*']);
  assert.match(pkg.scripts.check, /check:workspaces/);
  // The guarantee is that `test:unit` RUNS the workspace suites, not that it
  // spells them. It used to be `tsx --test tests/*.test.ts && npm run
  // test:workspaces`, whose `&&` let one red root test hide every workspace
  // suite — the deploy that failed on five assertions never ran a single
  // workspace test. The runner it now names runs both and aggregates, so the
  // assertion follows the indirection one hop instead of pinning the old text.
  const unit = pkg.scripts['test:unit'];
  const runner = /node (scripts\/[\w.-]+\.mjs)/.exec(unit);
  if (runner) {
    assert.ok(existsSync(join(ROOT, runner[1])), `test:unit names ${runner[1]}, which does not exist`);
    assert.match(read(runner[1]), /test-workspaces/, `${runner[1]} must run the workspace suites`);
    assert.match(read(runner[1]), /tests\/\*\.test\.ts/, `${runner[1]} must run the root suite`);
  } else {
    assert.match(unit, /test:workspaces/);
  }
  for (const name of readdirSync(join(ROOT, 'packages'))) {
    const dir = join(ROOT, 'packages', name);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; private: boolean; exports?: unknown };
    assert.equal(manifest.name, `@levonis/${name}`);
    assert.equal(manifest.private, true);
    assert.ok(manifest.exports, `${name}: exports map`);
    assert.ok(existsSync(join(dir, 'tsconfig.json')), `${name}: tsconfig.json`);
    assert.ok(existsSync(join(dir, 'README.md')), `${name}: README.md`);
    assert.ok(existsSync(join(ROOT, 'node_modules', '@levonis', name)), `${name}: linked in node_modules (run npm install)`);
  }
  assert.deepEqual(readdirSync(join(ROOT, 'packages')).sort(), [...ALL_PACKAGES].sort(), 'a new package needs a row in this test and in 02-MIGRATION-PLAN.md §1.1');
});

test('pricing, shipping and storeLayout are pure: relative imports only, no bindings, no fetch, no framework', () => {
  for (const name of PURE_PACKAGES) {
    for (const file of tsFiles(join(ROOT, 'packages', name, 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(src)) assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${file}: non-relative import ${spec}`);
      for (const spec of importSpecifiers(src)) assert.ok(!spec.includes('worker/') && !spec.includes('services/') && !spec.includes('..' + '/' + '..' + '/'), `${file}: escapes the package (${spec})`);
      assert.ok(!/\b(D1Database|R2Bucket|KVNamespace|DurableObject|fetch\s*\(|from ['"]hono|cloudflare:)/.test(src), `${file}: impure (bindings, fetch or Hono)`);
    }
  }
});

test('contracts import only themselves; the platform kit imports only contracts, hono and itself', () => {
  for (const file of tsFiles(join(ROOT, 'packages', 'contracts', 'src'))) {
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) assert.ok(spec.startsWith('.'), `${file}: ${spec}`);
  }
  for (const file of tsFiles(join(ROOT, 'packages', 'platform-kit', 'src'))) {
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      assert.ok(spec.startsWith('.') || spec.startsWith('@levonis/contracts') || spec === 'hono' || spec.startsWith('hono/') || spec.startsWith('cloudflare:'), `${file}: ${spec}`);
      assert.ok(!spec.includes('worker/') && !spec.includes('services/'), `${file}: ${spec}`);
    }
  }
});

test('the core moved libraries are one-line re-exports of the packages, and the files they point at exist', () => {
  const map: Record<string, string> = {
    'worker/lib/pricing.ts': '@levonis/pricing/pricing', 'worker/lib/priceGrid.ts': '@levonis/pricing/priceGrid', 'worker/lib/pinnedPrices.ts': '@levonis/pricing/pinnedPrices',
    'worker/lib/cheapestBase.ts': '@levonis/pricing/cheapestBase', 'worker/lib/shippingType.ts': '@levonis/pricing/shippingType', 'worker/lib/paymentPolicy.ts': '@levonis/pricing/paymentPolicy',
    'worker/lib/availability.ts': '@levonis/pricing/availability', 'worker/lib/shipping.ts': '@levonis/shipping/shipping', 'worker/lib/iraqGovernorates.ts': '@levonis/shipping/iraqGovernorates',
  };
  for (const [file, spec] of Object.entries(map)) {
    const src = read(file).trim();
    assert.equal(src.split('\n').length, 1, `${file} is a one-line re-export`);
    assert.match(src, new RegExp(`^export \\* from '${spec.replace('/', '\\/')}'`));
    const [, pkg, mod] = /^@levonis\/([^/]+)\/(.+)$/.exec(spec)!;
    assert.ok(existsSync(join(ROOT, 'packages', pkg, 'src', `${mod}.ts`)), `${spec} exists`);
  }
  assert.match(read('worker/lib/warrantyPlans.ts'), /from '@levonis\/pricing\/warrantyPlanMath'/);
});
