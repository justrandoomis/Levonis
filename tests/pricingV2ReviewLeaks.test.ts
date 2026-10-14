/**
 * PRICING V2 CLEAN START — NO OLD DINAR PRICE REACHES ANY ADMIN SCREEN (review of feat/pricing-v2-core,
 * 2026-10-14). A product still «يحتاج تسعيرًا» keeps its old prices only as an archive:
 *   - the «يحتاج تسعيرًا» queue's `image` is the product's picture, never the engine's price image;
 *   - the product, relations and order-type reads answer every legacy price EMPTY;
 *   - the products list's price band and price sorts read the V2 from-price (a hidden product's old price
 *     cannot be found by narrowing the band);
 *   - the stock selection's reference price is the V2 direct price, or null;
 *   - the product save's audit detail carries no price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, json, row, type StubUser } from './fixtures/app';
import { AMS, pricingWorld } from './fixtures/procurementPricing';
import { v2App, writeV2 } from './fixtures/pricingV2';
import { referencePriceOf } from '../worker/lib/inventorySelection';
import { LEGACY_PRICE_KEY, isLegacyPriceFileKey, nullLegacyPricesDeep, withoutLegacyPriceLines } from '../worker/lib/pricingEngine/v2/legacyMoney';

const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };

/** Every number at a legacy price key, at any depth. */
function legacyPrices(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) for (const v of value) legacyPrices(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (LEGACY_PRICE_KEY.test(k) && typeof v === 'number') out.push(v);
      else legacyPrices(v, out);
    }
  }
  return out;
}

test('the queue answers the product\'s picture, never the price image (a fingerprint of every old dinar price)', async () => {
  const w = pricingWorld();
  const editor = v2App(w.raw, EDITOR);
  const first = await json(await get(editor, '/api/admin/products-v2/needs-pricing'));
  assert.equal(first.success, true, JSON.stringify(first));
  const pid = (first.products as Array<{ id: string }>)[0]!.id;
  w.raw.exec(`INSERT INTO product_images (id, product_id, url, r2_key, is_primary, sort_order) VALUES ('img_q', '${pid}', '/files/products/q/main.webp', 'products/q/main.webp', 1, 0)`);
  const out = await json(await get(editor, '/api/admin/products-v2/needs-pricing'));
  const shown = (out.products as Array<{ id: string; image: string }>).find((p) => p.id === pid)!;
  assert.equal(shown.image, '/files/products/q/main.webp');
  for (const p of out.products as Array<{ image: string }>) assert.doesNotMatch(p.image, /^\[|commission_iqd|null,/, 'never the price image');
});

test('the product, relations and order-type reads answer a needs-pricing product\'s old prices EMPTY; a V2 product reads its V2 cells', async () => {
  const w = pricingWorld();
  const old = row<{ p: number }>(w.raw, 'SELECT price_iqd AS p FROM products WHERE id = ?', AMS)!.p;
  assert.ok(old > 0);
  const editor = v2App(w.raw, EDITOR);
  const product = await json(await get(editor, `/api/admin/products-v2/${AMS}`));
  assert.equal(product.success, true, JSON.stringify(product));
  assert.equal(product.pricing_v2.needs_pricing, true);
  assert.equal(product.product.price_iqd, null, 'the key stays (the form keeps its shape), the value is empty');
  assert.deepEqual(legacyPrices(product.product), [], 'no old price at any depth');
  const relations = await json(await get(editor, `/api/admin/products/${AMS}/relations`));
  assert.equal(relations.success, true, JSON.stringify(relations));
  assert.deepEqual(legacyPrices(relations), []);
  const fulfillment = await json(await get(editor, `/api/admin/products/${AMS}/fulfillment`));
  assert.deepEqual(legacyPrices(fulfillment), []);

  // Published in V2: the cells are the V2 writer's, read as they are.
  await writeV2(w.db, AMS, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }] });
  const priced = await json(await get(editor, `/api/admin/products-v2/${AMS}`));
  assert.equal(priced.pricing_v2.needs_pricing, false);
  assert.equal(priced.product.price_iqd, 1_600_000);
});

test('the products list: the price band and the price sorts read the V2 from-price — an old price is never found by narrowing the band', async () => {
  const w = pricingWorld();
  const old = row<{ p: number }>(w.raw, 'SELECT price_iqd AS p FROM products WHERE id = ?', AMS)!.p;
  const editor = v2App(w.raw, EDITOR);
  const band = async (min: number, max: number) => {
    const out = await json(await get(editor, `/api/admin/products-v2?price_min=${min}&price_max=${max}&limit=100`));
    assert.equal(out.success, true, JSON.stringify(out));
    return (out.products as Array<{ id: string }>).map((p) => p.id);
  };
  assert.deepEqual(await band(old, old), [], 'the exact old price finds nothing');
  await writeV2(w.db, AMS, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1000' }] });
  assert.deepEqual(await band(1_600_000, 1_600_000), [AMS], 'the V2 from-price finds it');
  const sorted = await json(await get(editor, '/api/admin/products-v2?sort=price_asc&limit=100'));
  const list = sorted.products as Array<{ id: string; needs_pricing: boolean }>;
  assert.equal(list[0]!.id, AMS, 'the one priced product first');
  assert.ok(list.slice(1).every((p) => p.needs_pricing), 'needs-pricing rows last, in no old-price order');
});

test('the stock selection\'s reference price is the lowest V2 direct price its SKUs sell at, or null', () => {
  const prices = new Map([
    ['o:m1|c:black', 1_000_000],
    ['o:m1|c:white', 1_002_000],
    ['o:m2|c:black', 1_500_000],
  ]);
  assert.equal(referencePriceOf(prices, 'base', '', ''), 1_000_000);
  assert.equal(referencePriceOf(prices, 'option', 'm2', ''), 1_500_000);
  assert.equal(referencePriceOf(prices, 'color', 'white', ''), 1_002_000);
  assert.equal(referencePriceOf(prices, 'variant', 'v', 'c:black|o:m2'), 1_500_000, 'a variant by its own combination');
  assert.equal(referencePriceOf(new Map(), 'base', '', ''), null, 'needs pricing: no reference price');
  const sel = readFileSync(join(import.meta.dirname, '../worker/lib/inventorySelection.ts'), 'utf8');
  assert.doesNotMatch(sel, /direct_surcharge_iqd/, 'no Direct Sale Extra on the reference price');
});

test('the export helpers: price keys are emptied (never the cost, never a warranty fee) and TXT price lines are left out', () => {
  assert.equal(isLegacyPriceFileKey('options.1.direct.price_iqd'), true);
  assert.equal(isLegacyPriceFileKey('preorder_transports.1.commission_iqd'), true);
  assert.equal(isLegacyPriceFileKey('options.1.regular_adjust_iqd'), true);
  assert.equal(isLegacyPriceFileKey('options.1.cost_iqd'), false, 'a cost stays behind the cost gate');
  assert.equal(isLegacyPriceFileKey('warranty_plans.1.fee_iqd'), false);
  assert.equal(isLegacyPriceFileKey('standard_delivery_fee_iqd'), false);
  assert.deepEqual(nullLegacyPricesDeep({ price_iqd: 917001, product_cost_iqd: 5, options: [{ regular_price_iqd: 1, cost_iqd: 2, name: 'x' }] }), {
    price_iqd: null,
    product_cost_iqd: 5,
    options: [{ regular_price_iqd: null, cost_iqd: 2, name: 'x' }],
  });
  assert.equal(withoutLegacyPriceLines('template_version=2\nprice_iqd=917001\nname_en=A\noptions.1.direct.price_iqd=+5000\n# price_iqd=1'), 'template_version=2\nname_en=A\n# price_iqd=1');
  // A heredoc is text: a description line that reads like a price key is kept, and the heredoc stays whole.
  assert.equal(
    withoutLegacyPriceLines('description_en=<<<END\nprice_iqd=99 was the launch price\nEND\nprice_iqd=917001\nhow_to_use=<<<X\nsurcharge_iqd=1\nX'),
    'description_en=<<<END\nprice_iqd=99 was the launch price\nEND\nhow_to_use=<<<X\nsurcharge_iqd=1\nX'
  );
});

test('the product save\'s audit detail names no price', () => {
  const src = readFileSync(join(import.meta.dirname, '../worker/routes/adminProducts.ts'), 'utf8');
  const at = src.indexOf("action: prev ? 'product_v2.update' : 'product_v2.create'");
  assert.ok(at > 0);
  assert.doesNotMatch(src.slice(at, at + 600), /price_iqd: doc\.price_iqd/);
});
