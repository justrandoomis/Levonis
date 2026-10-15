/**
 * EVERY SELLABLE PATH REFUSES A VISIBLE UNPRICED PRODUCT (DECISIONS row 240
 * point 2; spec §2, §7.3).
 *
 * The catalog-only world (tests/fixtures/catalogOnly.ts), a signed-in
 * customer. Each purchase door asks SELLABLE and answers the shown-but-unpriced
 * H2D with 409 PRICE_NOT_AVAILABLE (ar / en / ckb) — the checkout with its own
 * PRODUCT_CURRENTLY_UNAVAILABLE naming the product — and writes nothing: the
 * row count of every money and stock table and the H2D's own money columns are
 * the same afterwards. A product hidden for a catalogue gap (no picture)
 * answers 404 everywhere, as before.
 *
 * Run: node --import tsx --test tests/catalogOnlyPurchaseRefusals.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, post, put } from './fixtures/app';
import { orderBody } from './lib/bundles';
import { P } from './fixtures/liveCatalog';
import {
  CAT,
  CAT_SEL,
  CUSTOMER_ROLES,
  catalogLeaks,
  catalogMoneyFingerprint,
  catalogOnlyWorld,
  moneyCounts,
  type CatalogOnlyWorld,
} from './fixtures/catalogOnly';
import { QUICK_BUY_POLICY_KEYS, requiredPolicies } from '../worker/lib/policyOps';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { loadMaterialPrices } from '../worker/lib/printQuote/repository';
import { publishV2 } from './fixtures/v2Publish';
import { TodayReader } from '../worker/lib/tradeInToday';

const CUSTOMER = CUSTOMER_ROLES.customer!;
const SELECTION = { optionValueIds: [CAT_SEL.std], colorId: CAT_SEL.grey };

let shared: Promise<CatalogOnlyWorld> | null = null;
async function build(): Promise<CatalogOnlyWorld> {
  const w = await catalogOnlyWorld({ alsoUnpriced: [P.PLA] });
  w.raw.exec(`
    INSERT INTO addresses (id, user_id, label, name, phone, address, landmark, is_default, governorate, area)
      VALUES ('addr_c', 'u_cust', 'Home', 'Buyer', '+9647701234567', 'Karrada 12', '', 1, 'Baghdad', 'Karrada');
    INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status) VALUES ('dep_c', 'u_cust', 'deposit', 'USD', 1000000, 'approved');
  `);
  return w;
}
const world = () => (shared ??= build());

async function refusedNotAvailable(res: Response, where: string): Promise<void> {
  assert.equal(res.status, 409, where);
  const body = await json(res);
  assert.equal(body.code, 'PRICE_NOT_AVAILABLE', `${where}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.error, serverMessage('PRICE_NOT_AVAILABLE'), `${where}: the sentence in ar / en`);
  assert.deepEqual(catalogLeaks(body), [], where);
}

test('cart add, quote, price report, stock alert and Quick Buy: 409 PRICE_NOT_AVAILABLE, nothing written', async () => {
  const w = await world();
  const before = { counts: moneyCounts(w.raw), money: catalogMoneyFingerprint(w.raw) };
  const app = w.as(CUSTOMER);

  await refusedNotAvailable(await post(app, '/api/cart/items', { productId: CAT.id, qty: 1, ...SELECTION }), 'cart add');
  await refusedNotAvailable(await post(app, `/api/products/${CAT.slug}/quote`, { qty: 1, ...SELECTION }), 'quote');
  await refusedNotAvailable(await post(app, '/api/price-reports', { productId: CAT.id, priceIqd: 2_000_000, sellerName: 'Shop' }), 'price report');
  await refusedNotAvailable(await post(app, '/api/stock-alerts', { productId: CAT.id, kind: 'product' }), 'stock alert arm');
  await refusedNotAvailable(await put(app, `/api/stock-alerts/product/${CAT.id}`, { wishes: [{ kind: 'product' }] }), 'stock alert set');

  // Quick Buy: switched on with a valid address, the add is refused at the door.
  const activated = await json(
    await post(app, '/api/quick-buy/activate', { policyAcceptance: requiredPolicies(QUICK_BUY_POLICY_KEYS), walletConsent: true, addressId: 'addr_c', idempotencyKey: 'qb-catalog-only-1' })
  );
  assert.equal(activated.success, true, JSON.stringify(activated));
  await refusedNotAvailable(await post(app, '/api/quick-buy/items', { productId: CAT.id, qty: 1, ...SELECTION, idempotencyKey: 'qb-catalog-only-2' }), 'Quick Buy add');
  assert.equal(w.raw.prepare("SELECT COUNT(*) AS n FROM quick_buy_sessions WHERE user_id = 'u_cust'").get()!.n, 0, 'no session opened');

  const after = { counts: moneyCounts(w.raw), money: catalogMoneyFingerprint(w.raw) };
  assert.deepEqual(after.counts, before.counts, 'no money or stock table changed');
  assert.equal(after.money, before.money, 'the archived money columns are untouched');
});

test('an open cart line: shown apart with PRICE_NOT_AVAILABLE and no number; checkout refuses it naming the product', async () => {
  const w = await world();
  w.raw.exec(`INSERT INTO cart_items (id, user_id, product_id, option_value_ids, color_id, qty) VALUES ('ci_cat', 'u_cust', '${CAT.id}', '["${CAT_SEL.std}"]', '${CAT_SEL.grey}', 1)`);
  const app = w.as(CUSTOMER);
  const cart = await json(await get(app, '/api/cart'));
  assert.deepEqual(catalogLeaks(cart), []);
  assert.equal(((cart.items ?? []) as unknown[]).length, 0, 'never priced in the cart');
  const line = (cart.unavailable_lines as Array<Record<string, any>>).find((l) => l.product_id === CAT.id)!;
  assert.equal(line.code, 'PRICE_NOT_AVAILABLE');
  assert.ok(line.name.ar && line.name.en && line.name.ckb && line.name.ckb !== line.name.ar);
  assert.doesNotMatch(JSON.stringify(line), /_iqd|"price"/);

  const before = moneyCounts(w.raw);
  const placed = await post(app, '/api/orders', orderBody({ addressId: 'addr_c', printerStandardDeliveryAcceptance: undefined }));
  assert.equal(placed.status, 409);
  const pb = await json(placed);
  assert.equal(pb.code, 'PRODUCT_CURRENTLY_UNAVAILABLE');
  assert.deepEqual(pb.details.product_ids, [CAT.id]);
  assert.deepEqual(moneyCounts(w.raw), before, 'no order, no hold');
  w.raw.exec("DELETE FROM cart_items WHERE id = 'ci_cat'");
});

test('trade-in: the catalog-only product is not a target, and pricing it is refused', async () => {
  const w = await world();
  const app = w.as(CUSTOMER);
  const targets = await json(await get(app, '/api/trade-in/targets'));
  assert.equal(JSON.stringify(targets).includes(CAT.id), false, 'the targets list excludes it');
  assert.deepEqual(catalogLeaks(targets), []);
  // Services S-P2 (0192, DECISIONS row 238): the target search, the product page's entry and «سعر اليوم»
  // are purchase-side readers too — SELLABLE. A priced device beside it is the control.
  const control = await json(await get(app, `/api/trade-in/targets?product_id=${P.H2C}`));
  assert.deepEqual(
    (control.targets as Array<{ product_id: string }>).map((t) => t.product_id),
    [P.H2C],
    'a priced device is a target (the control)'
  );
  const byId = await json(await get(app, `/api/trade-in/targets?product_id=${CAT.id}`));
  assert.deepEqual(byId.targets, [], 'the search by id excludes it');
  const searched = await json(await get(app, '/api/trade-in/targets?q=H2D'));
  assert.equal(JSON.stringify(searched).includes(CAT.id), false, 'the search by name excludes it');
  assert.deepEqual(catalogLeaks(searched), []);
  const entry = await json(await get(app, `/api/trade-in/entry?product_id=${CAT.id}`));
  assert.equal(entry.target_ok, false, 'the product page draws no trade-in entry for it');
  assert.equal(await new TodayReader({ DB: w.db } as never).product(CAT.id), null, 'no «سعر اليوم» from an unsellable product');
  assert.notEqual(await new TodayReader({ DB: w.db } as never).product(P.H2C), null, 'the priced control has one');
  const quote = await post(app, '/api/trade-in/target-quote', { target: { product_id: CAT.id, option_value_ids: [CAT_SEL.std], color_id: CAT_SEL.grey } });
  const qb = await json(quote);
  assert.equal(qb.code, 'TRADE_IN_TARGET_NOT_LISTED', "S-P2's own sentence for a target a customer cannot buy");
  assert.deepEqual(catalogLeaks(qb), []);
});

test('the print calculator and the print-quote material prices read no unpriced filament', async () => {
  const w = await world();
  // The PLA spool is a materials-family product, shown but not priced (its legacy price still in the row).
  w.raw.exec(`UPDATE products SET template_family = 'materials' WHERE id = '${P.PLA}'`);
  const pla = (w.raw.prepare("SELECT id FROM print_materials WHERE material_type = 'PLA' ORDER BY id LIMIT 1").get() as { id: string }).id;
  w.raw.prepare('UPDATE print_materials SET product_id = ? WHERE id = ?').run(P.PLA, pla);
  const calculator = await json(await get(w.as(null), '/api/products/print-calculator'));
  assert.equal(JSON.stringify(calculator).includes(P.PLA), false, 'an unpriced filament is not offered');
  assert.deepEqual(catalogLeaks(calculator), []);
  const sources = await loadMaterialPrices(w.db, null, [pla], { platformDefaults: false });
  assert.equal(sources.catalogue?.[pla], undefined, 'no catalogue rung from an unpriced product');
  assert.equal(sources.platformByType?.PLA, undefined, 'no type rung either');
  // Once priced, the same reads use it.
  await publishV2(w.raw, P.PLA);
  assert.ok(((await json(await get(w.as(null), '/api/products/print-calculator'))).filaments as unknown[]).length >= 1);
  assert.ok(Number((await loadMaterialPrices(w.db, null, [pla], { platformDefaults: false })).catalogue?.[pla]) > 0);
});

test('a product hidden for a catalogue gap (no picture) answers 404 at every door, as before', async () => {
  const w = await world();
  w.raw.exec(`INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
              VALUES ('${CAT.id}', 0, 1, '[{"c":"IMAGE","o":""}]', 1, '2026-10-15T00:00:00.000Z')`);
  try {
    const app = w.as(CUSTOMER);
    assert.equal((await get(app, `/api/products/${CAT.slug}`)).status, 404, 'its page');
    assert.equal((await post(app, `/api/products/${CAT.slug}/quote`, { qty: 1, ...SELECTION })).status, 404, 'the quote');
    assert.equal((await post(app, '/api/cart/items', { productId: CAT.id, qty: 1, ...SELECTION })).status, 404, 'the cart');
    assert.equal((await post(app, '/api/price-reports', { productId: CAT.id, priceIqd: 2_000_000 })).status, 404, 'a price report');
    const list = await json(await get(app, '/api/products?limit=50'));
    assert.equal((list.products as Array<{ id: string }>).some((p) => p.id === CAT.id), false, 'the listing');
  } finally {
    w.raw.exec(`DELETE FROM product_completeness WHERE product_id = '${CAT.id}'`);
  }
});
