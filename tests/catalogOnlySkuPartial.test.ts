/**
 * PER-SKU PARTIAL PRICING (DECISIONS row 240 point 3; spec §3.1, §3.3, §3.4,
 * §7.2).
 *
 * A V2-published product of 2 models × 2 colours gains a third colour after
 * publication (the structure-only save), so the new colour's two SKUs have no
 * price row. The product stays sellable; each unpriced selection is shown on
 * its own and never inherits another SKU's price. Proves:
 *   - `unpriced_selections` lists exactly the two new keys;
 *   - `price_levels.combo` is null for them and the new colour's level is null
 *     (never the ladder, which is another SKU's price);
 *   - the card's «from» is the lowest priced SKU — byte-identical to before;
 *   - the quote for a new SKU answers 200 `price_status: 'unpriced'` with no
 *     number at all; a priced SKU quotes exactly as before;
 *   - the cart refuses the new SKU (VARIANT_UNAVAILABLE, unchanged contract)
 *     and takes the priced one;
 *   - `initial_selection` is a priced SKU even when the new colour sorts first.
 *
 * Run: node --import tsx --test tests/catalogOnlySkuPartial.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, post, stubApp, type StubUser } from './fixtures/app';
import { publishV2 } from './fixtures/v2Publish';
import { mountCustomer } from './fixtures/catalogOnly';

const BUYER: StubUser = { id: 'u_buy', role: 'customer', email: 'buy@x.co' };
const key = (v: string, c: string) => `o:${v}|c:${c}`;

async function world() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id, name, email, password_hash, role) VALUES ('u_buy', 'Buyer', 'buy@x.co', 'h', 'customer');
    INSERT INTO products (id, slug, name, name_ar, status, price_iqd, stock, selling_type, sale_types, inventory_mode)
      VALUES ('p_sku', 'sku-printer', 'SKU Printer', 'طابعة', 'active', 500000, 9, 'direct_sale', '["direct_sale"]', 'BASE');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g', 'p_sku', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, regular_price_iqd)
      VALUES ('v_a', 'p_sku', 'g', 'Basic', 'أساسي', 'بنەڕەتی', 0, 1, 500000),
             ('v_b', 'p_sku', 'g', 'Combo', 'كومبو', 'کۆمبۆ', 1, 1, 650000);
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active)
      VALUES ('c_black', 'p_sku', 'Black', 'أسود', 'ڕەش', '#000000', 1, 1),
             ('c_white', 'p_sku', 'White', 'أبيض', 'سپی', '#ffffff', 2, 1);
  `);
  await publishV2(raw, 'p_sku');
  const app = stubApp(asD1(raw), BUYER, mountCustomer, { publishV2: false });
  return { raw, app };
}

const page = async (app: ReturnType<typeof stubApp>) => json(await get(app, '/api/products/sku-printer'));
const card = async (app: ReturnType<typeof stubApp>) =>
  ((await json(await get(app, '/api/products?limit=50'))).products as Array<Record<string, unknown>>).find((p) => p.id === 'p_sku')!;

test('a colour added after publication: its SKUs are unpriced on their own, the rest sells as before', async () => {
  const { raw, app } = await world();
  const before = { card: await card(app), page: await page(app) };
  assert.equal(before.page.price_status, 'priced');
  assert.equal(before.page.unpriced_selections ?? undefined, undefined, 'a fully priced product carries no list');
  const pricedCombos = Object.entries(before.page.price_levels.combo as Record<string, { applied_iqd: number }>);
  assert.equal(pricedCombos.length, 4);
  const lowest = Math.min(...pricedCombos.map(([, l]) => l.applied_iqd));
  assert.equal(before.card.display_price_iqd, lowest, 'the card is «from» the lowest SKU');

  // The structure-only save of a new colour (sorted first): no product_sku_prices row for it.
  raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active)
            VALUES ('c_new', 'p_sku', 'Jade', 'يشمي', 'یەشم', '#00a86b', 0, 1)`);

  const after = await page(app);
  assert.equal(after.price_status, 'priced', 'the product still sells');
  assert.deepEqual([...(after.unpriced_selections as string[])].sort(), [key('v_a', 'c_new'), key('v_b', 'c_new')]);
  assert.equal(after.price_levels.combo['v_a|c_new'], null);
  assert.equal(after.price_levels.combo['v_b|c_new'], null);
  assert.equal(after.price_levels.color.c_new, null, 'never the ladder (another SKU’s price)');
  for (const [k, l] of pricedCombos) assert.deepEqual(after.price_levels.combo[k], l, `${k} unchanged`);
  // No level of the new colour carries any number.
  const newLevels = JSON.stringify([after.price_levels.color.c_new, after.price_levels.combo['v_a|c_new'], after.price_levels.combo['v_b|c_new']]);
  assert.equal(newLevels, '[null,null,null]');
  assert.notEqual(after.initial_selection?.color_id, 'c_new', 'the opening selection is a priced SKU');
  assert.ok(after.initial_selection, 'an opening selection is offered');
  assert.ok(
    pricedCombos.some(([k]) => k === `${after.initial_selection.option_value_ids[0]}|${after.initial_selection.color_id}`),
    JSON.stringify(after.initial_selection)
  );

  assert.equal(JSON.stringify(await card(app)), JSON.stringify(before.card), 'the card is byte-identical');

  // The quote: the new SKU says «unpriced» with no number; a priced one as before.
  const q1 = await post(app, '/api/products/sku-printer/quote', { qty: 1, optionValueIds: ['v_a'], colorId: 'c_new' });
  assert.equal(q1.status, 200);
  const qb1 = await json(q1);
  assert.equal(qb1.price_status, 'unpriced');
  assert.equal(qb1.selection_key, key('v_a', 'c_new'));
  for (const k of ['quote', 'membership_preview', 'pricing_modes', 'availability']) assert.equal(qb1[k], null, k);
  assert.doesNotMatch(JSON.stringify(qb1), /_iqd"\s*:\s*\d/, 'no number at all');
  const q2 = await json(await post(app, '/api/products/sku-printer/quote', { qty: 1, optionValueIds: ['v_a'], colorId: 'c_black' }));
  assert.equal(q2.price_status, 'priced');
  assert.equal(q2.quote.applied_iqd, before.page.price_levels.combo['v_a|c_black'].applied_iqd);
  assert.deepEqual(q2.quote.errors, []);

  // The cart: the unpriced SKU keeps the existing contract; the priced one adds.
  const add1 = await post(app, '/api/cart/items', { productId: 'p_sku', qty: 1, optionValueIds: ['v_a'], colorId: 'c_new' });
  assert.equal((await json(add1)).code, 'VARIANT_UNAVAILABLE');
  const add2 = await post(app, '/api/cart/items', { productId: 'p_sku', qty: 1, optionValueIds: ['v_a'], colorId: 'c_black' });
  assert.equal(add2.status, 200, JSON.stringify(await json(add2.clone())));

  // Its price arrives (a later V2 write): nothing is unpriced any more.
  await publishV2(raw, 'p_sku');
  const priced = await page(app);
  assert.equal(priced.unpriced_selections ?? undefined, undefined);
  assert.ok(priced.price_levels.combo['v_a|c_new']?.applied_iqd > 0);
});
