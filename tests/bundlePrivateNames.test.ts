/**
 * THE BUILT JAVASCRIPT CARRIES NO FX INTERNALS (FX programme plan §14.2 S2,
 * in its FX-1 scope; §15).
 *
 * Reads `dist/` after `npm run build`:
 *   - the FIRST PAINT (the entry chunk and everything index.html preloads)
 *     carries nothing of the exchange-rate machinery — no owner route, no
 *     private field name, no provider endpoint, not even the attribution link
 *     (that lives in the lazy top-bar menu chunk) and none of the owner
 *     panel's words;
 *   - NO customer chunk — every chunk that does not speak to
 *     /api/admin/pricing — names a provider endpoint, the provider key, or a
 *     private FX field.
 * The owner's pricing chunks may carry field NAMES (they are the panel's
 * types); a VALUE can never be in a bundle, because none exists at build time.
 *
 * Without a build it skips; with REQUIRE_DIST=1 (workflow 7's step, push SR-2)
 * a missing build fails.
 *
 * Run: npm run build && npx tsx --test tests/bundlePrivateNames.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');
const built = existsSync(join(DIST, 'index.html')) && existsSync(ASSETS);
const skip = !built && process.env.REQUIRE_DIST !== '1' ? 'no dist/ — run npm run build first (REQUIRE_DIST=1 makes this a failure)' : false;

/** Names that exist only on the server or in the owner's panel. */
const NEVER_IN_CUSTOMER_CODE = [
  'iraqsm.com/api',
  'eurofxref',
  'IRAQ_PARALLEL_FX_API_KEY',
  'X-API-Key',
  'last_known_good_rate',
  'drift_anchor_rate',
  'pending_effective_rate',
  'adjustment_iqd_per_usd',
  'market_adjustment_iqd',
  'formula_holds',
  'settings_diff',
  'provider_calls',
  'canonical_supplier_cost_usd',
  'supplier_cost_amount',
];

/** Also absent from the first paint: the owner routes and the owner panel's own words. */
const NEVER_AT_FIRST_PAINT = [
  ...NEVER_IN_CUSTOMER_CODE,
  'product_cost_iqd',
  'purchase_unit_iqd',
  'target_profit_iqd',
  'printServicePricing',
  'margin_percent',
  'iraqsm',
  '/rates/fx',
  '/api/admin/pricing',
  'إعدادات الحماية',
  'Safety settings',
  'ڕێکخستنەکانی پاراستن',
  'Automatic USD tracking',
];

function firstPaintFiles(): string[] {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
  return [...new Set(refs)];
}

test('the first paint carries no FX internals and none of the owner panel', { skip }, () => {
  assert.ok(built, 'dist/ is missing');
  const files = firstPaintFiles();
  assert.ok(files.length > 0, 'index.html references no script');
  for (const rel of files) {
    const code = readFileSync(join(DIST, rel), 'utf8');
    for (const name of NEVER_AT_FIRST_PAINT) assert.ok(!code.includes(name), `${rel} carries «${name}»`);
  }
});

test('no customer chunk names a provider endpoint, the key or a private FX field', { skip }, () => {
  assert.ok(built, 'dist/ is missing');
  const chunks = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  assert.ok(chunks.length > 10, `only ${chunks.length} chunks`);
  let owner = 0;
  for (const f of chunks) {
    const code = readFileSync(join(ASSETS, f), 'utf8');
    // The owner's chunks: the pricing tab, the dashboard rates card, and the
    // chunk they share (the one that speaks to /api/admin/pricing). Property
    // names survive minification, so the panel's chunk carries the field
    // NAMES it reads — never a value.
    // The product data file's field table (DECISIONS row 204) names the owner pricing block's TXT
    // keys — the words the owner types in «تحديث البيانات» — and only the admin product form and
    // its data-file sheet import it.
    if (/^(AdminPricing|OwnerRatesCard|dataFileStrings)-/.test(f) || code.includes('/api/admin/pricing')) {
      owner++;
      // Even the owner's chunks never hold a provider endpoint or the key: the browser never calls a provider.
      for (const name of ['iraqsm.com/api', 'eurofxref', 'IRAQ_PARALLEL_FX_API_KEY', 'X-API-Key']) assert.ok(!code.includes(name), `${f} carries «${name}»`);
      continue;
    }
    for (const name of NEVER_IN_CUSTOMER_CODE) assert.ok(!code.includes(name), `${f} carries «${name}»`);
  }
  assert.ok(owner >= 1, 'the owner pricing chunk was not found');
  // The attribution link is in exactly the menu chunk(s), never more widely.
  const attributed = chunks.filter((f) => readFileSync(join(ASSETS, f), 'utf8').includes('https://iraqsm.com'));
  assert.ok(attributed.length >= 1 && attributed.length <= 2, `the IQWealth link is in ${attributed.length} chunks`);
});
