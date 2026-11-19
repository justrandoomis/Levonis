/**
 * PRINTER ADD-ONS THAT ARE NOT ON THE SHELF (owner, 2026-11-19: «nozzles… if not available put them on
 * pre-order»; DECISIONS row 362).
 *
 * An add-on first goes WITH its printer (the printer's own order type and route) — unchanged. When it
 * cannot (off the shelf, or its product sells by pre-order only) and the printer is a ready one, its
 * product's OWN pre-order is looked up: the answer says `fulfillment: 'pre_order'`, the route and the
 * lead days. It is NOT made a line of the ready printer's order — one order is one journey (the cart's
 * one-shipping-type rule) — so the add door refuses it with its own code, ADDON_PREORDER_SEPARATE,
 * never silently dropping it. No way to sell at all keeps the real reason.
 *
 * Run: node --import tsx --test tests/printerAddonPreorder.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { setup, appAs, json, get, post, smart, type Json } from './fixtures/printerOffers';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { ADDON_PREORDER_SEPARATE } from '../packages/pricing/src/printerServices';

const SEA = JSON.stringify([{ method: 'sea', commission_iqd: 0, active: true, lead_time_min_days: 20, lead_time_max_days: 20 }]);
const SEA_AIR = JSON.stringify([
  { method: 'air', commission_iqd: 0, active: true, lead_time_min_days: 7, lead_time_max_days: 10 },
  { method: 'sea', commission_iqd: 0, active: true, lead_time_min_days: 20, lead_time_max_days: 25 },
]);
/** The lead days are the resolver's own (an option's fulfilment / route row); this fixture's product states none. */
const NO_LEAD = { min: null, max: null };
const nozzleOf = (body: Json) => body.addons.find((x: Json) => x.id === 'nozzle') as Json;
const kits = async (a: ReturnType<typeof appAs>, qs = '') => json(await get(a, `/api/products/a1-printer/kits?qty=1${qs}`));
const setNozzle = (raw: DatabaseSync, sql: string, ...args: Array<string | number>) => raw.prepare(`UPDATE products SET ${sql} WHERE id = 'p_nozzle'`).run(...args);

test('in stock: the add-on goes with the printer, exactly as before', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const n = nozzleOf(await kits(a));
  assert.deepEqual([n.available, n.reason, n.fulfillment, n.transport, n.lead_days, 'preorder' in n], [true, null, 'with_printer', null, { min: null, max: null }, false]);
  assert.deepEqual([n.before_unit_price_iqd, n.unit_price_iqd], [10_000, 8_000], 'the owner\'s 20% is unchanged');
  const added = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), addonIds: ['nozzle'] });
  assert.equal(added.status, 200, JSON.stringify(await json(added.clone())));
  raw.close();
});

test('off the shelf with pre-order enabled: «pre-order, ordered separately» with its route and lead days — refused by its own code, never dropped', async () => {
  const { db, raw } = setup();
  setNozzle(raw, `stock = 0, sale_types = '["direct_sale","pre_order"]', preorder_transports = ?`, SEA);
  const a = appAs(db, 'buyer');
  const n = nozzleOf(await kits(a));
  assert.deepEqual([n.available, n.reason, n.fulfillment, n.transport, n.lead_days], [false, ADDON_PREORDER_SEPARATE, 'pre_order', 'sea', NO_LEAD], JSON.stringify(n));
  assert.deepEqual([n.preorder.transport, n.preorder.unit_price_iqd, n.preorder.lead_days, n.slug], ['sea', 10_000, NO_LEAD, 'nozzle-04']);
  assert.equal(typeof n.with_printer_reason, 'string', 'why it cannot go with the printer (that door answers with its own code)');
  // No line price is promised for the printer's order: nothing would charge it.
  assert.deepEqual([n.unit_price_iqd, n.price_per_printer_iqd, n.total_iqd], [null, null, null]);
  const refused = await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), addonIds: ['nozzle'] });
  const why = await json(refused);
  assert.deepEqual([refused.status, why.code, why.details.addon_id, why.details.product_id, why.details.slug, why.details.transport, why.details.lead_days],
    [409, ADDON_PREORDER_SEPARATE, 'nozzle', 'p_nozzle', 'nozzle-04', 'sea', NO_LEAD]);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM cart_items').get() as { n: number }).n, 0, 'the printer is not added without the add-on the customer ticked');
  // The printer alone is still bought; the part is then ordered from its own page as a pre-order.
  assert.equal((await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart() })).status, 200);
  raw.close();
});

test('a pre-order-only product: the same answer; several routes pick the cheapest, then sea before air', async () => {
  const { db, raw } = setup();
  setNozzle(raw, `selling_type = 'pre_order', sale_types = '["pre_order"]', preorder_transports = ?`, SEA_AIR);
  const a = appAs(db, 'buyer');
  const n = nozzleOf(await kits(a));
  assert.deepEqual([n.available, n.reason, n.fulfillment, n.transport, n.lead_days], [false, ADDON_PREORDER_SEPARATE, 'pre_order', 'sea', NO_LEAD], JSON.stringify(n));
  raw.close();
});

test('no way to sell it: unavailable with the real reason, no pre-order promised', async () => {
  const { db, raw } = setup();
  setNozzle(raw, 'stock = 0');
  const a = appAs(db, 'buyer');
  const n = nozzleOf(await kits(a));
  assert.deepEqual([n.available, n.reason, n.fulfillment, n.transport, 'preorder' in n], [false, 'OUT_OF_STOCK', 'with_printer', null, false]);
  const refused = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), addonIds: ['nozzle'] }));
  assert.deepEqual([refused.code, refused.details.reason], ['ADDON_UNAVAILABLE', 'OUT_OF_STOCK']);
  raw.close();
});

test('the new refusal has words in Arabic, English and Sorani', () => {
  const w = REFUSAL_STRINGS[ADDON_PREORDER_SEPARATE];
  assert.ok(w && w.ar && w.en && w.ckb && w.ckb !== w.ar);
});
