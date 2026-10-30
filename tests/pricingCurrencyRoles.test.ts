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
import { dirname, join, relative, sep } from 'node:path';
import { ROOT } from './fixtures/d1';

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const worker = tsFiles(join(ROOT, 'worker')).map((f) => ({ f: relative(ROOT, f).split(sep).join('/'), src: readFileSync(f, 'utf8') }));

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

test('the FX module is imported only by the cron, the pricing workspace, the public display rate, the profit page\'s rate history, the money-free edge seam and the official-rate readers', () => {
  const importers = worker.filter(({ f, src }) => !f.startsWith('worker/lib/fx/') && /from\s+['"][^'"]*\/fx\/[^'"]+['"]/.test(src)).map(({ f }) => f).sort();
  // The engine's owner writes share the FX owner acts' strict body and decimal parsers, and the
  // versioned rate reader the FX pairs' table probe (USD design §2.6, §4.2) — nothing else of FX.
  const engine = importers.filter((f) => f.startsWith('worker/lib/pricingEngine/'));
  // Resolved against the importing file, so a module one folder deeper (pricingEngine/v2/) is held to the same two.
  for (const f of engine) {
    const src = worker.find((w) => w.f === f)!.src;
    const fx = [...src.matchAll(/from\s+['"]([^'"]*\/fx\/[^'"]+)['"]/g)].map((m) => join(dirname(f), m[1]!).split('\\').join('/'));
    assert.deepEqual(fx.filter((m) => m !== 'worker/lib/fx/ownerActs' && m !== 'worker/lib/fx/pairs'), [], f);
  }
  // THE ONE OFFICIAL RATE (DECISIONS row 252): the wallet, checkout, memberships, escrow, the wallet
  // notices and the admin read U through `fx/officialRate` — that one reader, nothing else of FX.
  // A refund of wallet money taken before the one-time rebase reads it there too (order cancel and its
  // repair, price cut, return), and so does the rebase itself, which lives with the wallet, not with FX.
  // Print Cloud's wallet payments and their refunds (docs/PRINT_CLOUD.md §4.4) read the same rate, the
  // same way, and refund money taken before the rebase across it like an order cancel does.
  const official = ['worker/lib/escrowOps.ts', 'worker/lib/orderCancelOps.ts', 'worker/lib/orderCancelRepair.ts', 'worker/lib/orderPriceAdjust.ts', 'worker/lib/printCloud/wallet.ts', 'worker/lib/walletNotify.ts', 'worker/lib/walletRateRebase.ts', 'worker/routes/admin.ts', 'worker/routes/adminWalletAdjust.ts', 'worker/routes/memberships.ts', 'worker/routes/orders.ts', 'worker/routes/returns.ts', 'worker/routes/wallet.ts'];
  for (const f of official) {
    const src = worker.find((w) => w.f === f)!.src;
    assert.deepEqual([...src.matchAll(/from\s+['"]([^'"]*\/fx\/[^'"]+)['"]/g)].map((m) => m[1]!.replace(/^.*\/fx\//, 'fx/')), ['fx/officialRate'], f);
  }
  assert.deepEqual(importers.filter((f) => !engine.includes(f) && !official.includes(f)), ['worker/index.ts', 'worker/routes/adminFinanceWorkspace.ts', 'worker/routes/adminPricing.ts', 'worker/routes/adminProducts.ts', 'worker/routes/misc.ts', 'worker/routes/products.ts']);
  // P-A (design §8): «الأرباح والتكاليف» reads the shop's USD/IQD AS IT WAS for its
  // display toggle and its promotion-rate suggestion — the ONE history reader,
  // nothing else of FX; it writes no rate and re-derives no dinar figure.
  const workspace = worker.find((w) => w.f === 'worker/routes/adminFinanceWorkspace.ts')!.src;
  assert.deepEqual([...workspace.matchAll(/from\s+['"]([^'"]*\/fx\/[^'"]+)['"]/g)].map((m) => m[1]), ['../lib/fx/historyRate']);
  assert.doesNotMatch(workspace, /\b(pricing_fx_rates|fx_rate_pairs|fx_rate_log)\b/, 'the route names no FX table itself');
  // The storefront routes and the admin price preview (owner decision 9: the shop's rate, never the
  // wallet's) import the ONE display-rate reader, nothing else of FX.
  for (const f of ['worker/routes/misc.ts', 'worker/routes/products.ts', 'worker/routes/adminProducts.ts']) {
    const src = worker.find((w) => w.f === f)!.src;
    const fx = [...src.matchAll(/from\s+['"]([^'"]*\/fx\/[^'"]+)['"]/g)].map((m) => m[1]);
    // The owner's bounded receipt-price recovery uses the statement counter,
    // which reads no currency and changes no exchange rate.
    assert.deepEqual(fx.sort(), (f === 'worker/routes/adminProducts.ts'
      ? ['../lib/fx/displayRate', '../lib/fx/budget'] : ['../lib/fx/displayRate']).sort(), f);
  }
});

test('orderProfit and the lot code import nothing from the engine or FX; the engine and FX read no inventory_lots column (§19)', () => {
  for (const f of ['worker/lib/orderProfit.ts', 'worker/lib/inventoryLots.ts', 'worker/lib/inventoryReceiving.ts', 'worker/lib/walletOps.ts']) {
    const src = worker.find((w) => w.f === f)?.src;
    if (!src) continue;
    assert.doesNotMatch(src, /from\s+['"][^'"]*\/(fx|pricingEngine)\//, f);
  }
  // DECISIONS row 244: a cost-first model with stock is priced from its costliest batch on the shelf — ONE engine
  // module READS the lots (their cost and what remains), in dinars as paid, and never writes one; the accounting
  // still reads no rate, and nothing else of the engine or FX names a lot.
  const SHELF = 'worker/lib/pricingEngine/v2/shelf.ts';
  for (const { f, src } of worker.filter(({ f }) => f.startsWith('worker/lib/fx/') || f.startsWith('worker/lib/pricingEngine/'))) {
    if (f === SHELF) {
      assert.doesNotMatch(src, /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+inventory_lots\b/i, f);
      assert.doesNotMatch(src, /\bwallet_transactions\b|\border_items\b/, f);
      continue;
    }
    assert.doesNotMatch(src, /\binventory_lots\b|\bwallet_transactions\b|\border_items\b/, f);
  }
  assert.match(worker.find((w) => w.f === SHELF)!.src, /\bFROM inventory_lots\b/, 'the shelf is read where row 244 says');
});

test('FX-1 writes no product price: the FX module never names a price column or the product tables', () => {
  for (const { f, src } of worker.filter(({ f }) => f.startsWith('worker/lib/fx/'))) {
    assert.doesNotMatch(src, /\bUPDATE\s+(products|product_options|product_colors|product_option_cells|product_preorder_routes|price_history)\b/i, f);
    assert.doesNotMatch(src, /\bprice_iqd\b/, f);
  }
});
