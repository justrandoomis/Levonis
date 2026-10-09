/**
 * CURRENCY ROLES: USD PRICES, IQD ACCOUNTS (FX programme plan §9 §1, §19, §36).
 *
 * Pricing inputs are USD, EUR or CNY and move with the exchange rates; the
 * accounting — orders, order lines, lots, the wallet, finance — stays in the
 * IQD that actually changed hands and is NEVER recomputed from a rate. So no
 * accounting write path may read the central rates: the 0179 tables are read
 * only by the FX module, the pricing workspace, the public display rate and
 * the purchase snapshot; and the profit and lot code import nothing from the
 * FX module or the engine.
 *
 * (FX-2/FX-3 add 'pricing inputs refuse IQD as a stored supplier currency'
 * here, with the inputs table.)
 *
 * Run: node --import tsx --test tests/pricingCurrencyRoles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const worker = tsFiles(join(ROOT, 'worker')).map((f) => ({ f: relative(ROOT, f), src: readFileSync(f, 'utf8') }));

const ALLOWED_READERS = (f: string) =>
  f.startsWith('worker/lib/fx/') ||
  f.startsWith('worker/lib/pricingEngine/') ||
  f === 'worker/routes/adminPricing.ts' ||
  // the purchase snapshot (§17, L6) reads the effective pairs once, when ordered
  f === 'worker/routes/adminProcurement.ts' ||
  // the media-reference classifier names columns, it reads no rate
  f === 'worker/lib/mediaRefs.ts';

test('no accounting write path reads the central rates: only the FX module, the pricing workspace and the purchase snapshot name the 0179 tables', () => {
  const readers = worker.filter(({ src }) => /\b(pricing_fx_rates|fx_rate_pairs|fx_rate_log|pricing_shipping_rates)\b/.test(src)).map(({ f }) => f);
  assert.deepEqual(readers.filter((f) => !ALLOWED_READERS(f)), []);
  assert.ok(readers.includes('worker/lib/fx/displayRate.ts'));
});

test('the FX module is imported only by the cron, the pricing workspace, the public display rate and the money-free edge seam', () => {
  const importers = worker.filter(({ f, src }) => !f.startsWith('worker/lib/fx/') && /from\s+['"][^'"]*\/fx\/[^'"]+['"]/.test(src)).map(({ f }) => f).sort();
  assert.deepEqual(importers, ['worker/index.ts', 'worker/routes/adminPricing.ts', 'worker/routes/misc.ts', 'worker/routes/products.ts']);
  // The storefront routes import the ONE display-rate reader, nothing else of FX.
  for (const f of ['worker/routes/misc.ts', 'worker/routes/products.ts']) {
    const src = worker.find((w) => w.f === f)!.src;
    const fx = [...src.matchAll(/from\s+['"]([^'"]*\/fx\/[^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual(fx, ['../lib/fx/displayRate'], f);
  }
});

test('orderProfit and the lot code import nothing from the engine or FX; the engine and FX read no inventory_lots column (§19)', () => {
  for (const f of ['worker/lib/orderProfit.ts', 'worker/lib/inventoryLots.ts', 'worker/lib/inventoryReceiving.ts', 'worker/lib/walletOps.ts']) {
    const src = worker.find((w) => w.f === f)?.src;
    if (!src) continue;
    assert.doesNotMatch(src, /from\s+['"][^'"]*\/(fx|pricingEngine)\//, f);
  }
  for (const { f, src } of worker.filter(({ f }) => f.startsWith('worker/lib/fx/') || f.startsWith('worker/lib/pricingEngine/'))) {
    assert.doesNotMatch(src, /\binventory_lots\b|\bwallet_transactions\b|\border_items\b/, f);
  }
});

test('FX-1 writes no product price: the FX module never names a price column or the product tables', () => {
  for (const { f, src } of worker.filter(({ f }) => f.startsWith('worker/lib/fx/'))) {
    assert.doesNotMatch(src, /\bUPDATE\s+(products|product_options|product_colors|product_option_cells|product_preorder_routes|price_history)\b/i, f);
    assert.doesNotMatch(src, /\bprice_iqd\b/, f);
  }
});
