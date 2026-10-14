/**
 * Services V2, S-P0 review findings on lines that hold two or more of the same
 * device, and on the channel a direct line is compared on (DECISIONS row 223,
 * plan §1.3):
 *
 *   F7  price protection credited for ONE unit of a two-unit line (the other
 *       was in a trade-in) comes off that unit's trade-in base in full, not
 *       half of it spread over both units.
 *   F8  a direct-sale line whose direct cell was removed is not compared with
 *       another channel's price: no credit when no price fell on its channel.
 *   R1  a return on one device of a line no longer holds the trade-in of the
 *       OTHER device, and a finished return holds nothing.
 *   R2  a return that names no device (what the customer screen sends) is
 *       refused for a device on the repair desk only when it cannot be another
 *       device of the line — and the warranty door counts the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { json, post, get, row, send, ctx, stubApp } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';
import { deviceRoutes } from '../worker/routes/devices';
import { ppWorld } from './sv2_price-protection_fixture';
import { CUSTOMER, STAFF, adminApp, customerApp, restoreFetch, seed, submitted } from './sv2_tradein_fixture';
import { REQUIRED_PHOTOS, blankInputs } from '../packages/pricing/src/tradeIn';

test.after(restoreFetch);

const dbOf = (raw: DatabaseSync) => new LimitD1(raw) as unknown as D1Database;

/** Sara's A1 line becomes two A1s (unit_a1, unit_a2), both delivered and registered to her. */
function twoUnits(raw: DatabaseSync, paid = 850_000) {
  raw.exec(`
    UPDATE order_items SET qty = 2, line_total_iqd = ${2 * paid} WHERE id = 'oi_a1';
    UPDATE orders SET subtotal_iqd = ${2 * paid}, total_iqd = ${2 * paid} WHERE id = 'ORD-OLD';
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      SELECT 'unit_a2',order_id,order_item_id,product_id,owner_user_id,2,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version
        FROM order_item_units WHERE id = 'unit_a1';`);
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
/** A submitted «whole» trade-in of slot `unitIndex` of the A1 line, toward the P1S. */
async function submittedUnit(raw: DatabaseSync, unitIndex: number): Promise<string> {
  const a = customerApp(raw);
  const r = await json(await post(a, '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: unitIndex, scope: 'whole' }));
  assert.ok(r.success, JSON.stringify(r));
  const id = r.request.id as string;
  const comps = r.request.components as Array<{ role: 'device' | 'ams'; family: 'fdm' | 'ams' }>;
  const saved = await send(a, 'PATCH', `/api/trade-in/requests/${id}`, {
    components: Object.fromEntries(comps.map((c) => [c.role, blankInputs(c.family)])),
    target: { product_id: 'p_p1s', option_value_ids: [], color_id: null },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  for (const c of comps) {
    for (const angle of REQUIRED_PHOTOS[c.family]) {
      const f = new FormData();
      f.set('file', new File([JPEG as unknown as BlobPart], 'p.jpg', { type: 'image/jpeg' }));
      f.set('component', c.role);
      f.set('angle', angle.id);
      const res = await a.request(`/api/trade-in/requests/${id}/photos`, { method: 'POST', body: f, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
      assert.equal(res.status, 201, await res.clone().text());
    }
  }
  const s = await post(a, `/api/trade-in/requests/${id}/submit`);
  assert.equal(s.status, 200, await s.clone().text());
  return id;
}

// ---------------------------------------------------------------- F7
test('F7: the protection credited for unit 2 alone comes off unit 2’s trade-in base in full', async () => {
  const paid = 850_000;
  const raw = seed({ paid, deliveredDaysAgo: 2 });
  twoUnits(raw, paid);
  // Unit 1 goes into a trade-in (its base frozen at what was paid).
  const t1 = await submitted(raw);
  assert.equal(row<{ base_iqd: number }>(raw, "SELECT base_iqd FROM trade_in_components WHERE request_id = ? AND role = 'device'", t1)!.base_iqd, paid);
  // The A1 drops 50,000; the claim covers the one unit not in a trade-in.
  raw.exec(`UPDATE products SET price_iqd = 800000 WHERE id = 'p_a1'; UPDATE product_option_values SET regular_price_iqd = 800000 WHERE id = 'v_a1';`);
  const pp = (who: typeof CUSTOMER) => stubApp(dbOf(raw), who, (a) => a.route('/api/price-protection', priceProtectionRoutes));
  const filed = await json(await post(pp(CUSTOMER), '/api/price-protection/claims', { orderItemId: 'oi_a1' }));
  assert.equal(filed.success, true, JSON.stringify(filed));
  assert.equal(filed.claim.qty, 1);
  const decided = await json(await post(pp(STAFF), `/api/price-protection/admin/claims/${filed.claim.id}/decide`, { decision: 'approved' }));
  assert.equal(decided.success, true, JSON.stringify(decided));
  const credited = decided.credit.amount_iqd as number;
  assert.equal(credited, 50_000);
  // Unit 1 carries on at its frozen base; unit 2 is listed at paid − the whole credit it received.
  const a1 = await json(await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${t1}/approve`));
  assert.equal(a1.request.status, 'awaiting_payment', JSON.stringify(a1));
  const units = (await json(await get(customerApp(raw), '/api/trade-in/eligible'))).units as Array<{ order_item_id: string; unit_index: number; paid_iqd: number }>;
  assert.equal(units.find((u) => u.order_item_id === 'oi_a1' && u.unit_index === 2)!.paid_iqd, paid - credited);
  const t2 = await json(await post(customerApp(raw), '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 2, scope: 'whole' }));
  assert.equal(t2.success, true, JSON.stringify(t2));
  assert.equal(row<{ base_iqd: number }>(raw, "SELECT base_iqd FROM trade_in_components WHERE request_id = ? AND role = 'device'", t2.request.id)!.base_iqd, paid - credited);
});

test('F7: a claim over the whole line still comes off every unit, as before', async () => {
  const paid = 850_000;
  const raw = seed({ paid, deliveredDaysAgo: 2 });
  twoUnits(raw, paid);
  raw.exec(`UPDATE products SET price_iqd = 800000 WHERE id = 'p_a1'; UPDATE product_option_values SET regular_price_iqd = 800000 WHERE id = 'v_a1';`);
  const pp = (who: typeof CUSTOMER) => stubApp(dbOf(raw), who, (a) => a.route('/api/price-protection', priceProtectionRoutes));
  const filed = await json(await post(pp(CUSTOMER), '/api/price-protection/claims', { orderItemId: 'oi_a1' }));
  assert.equal(filed.claim.qty, 2, JSON.stringify(filed));
  const decided = await json(await post(pp(STAFF), `/api/price-protection/admin/claims/${filed.claim.id}/decide`, { decision: 'approved' }));
  assert.equal(decided.credit.amount_iqd, 100_000, JSON.stringify(decided));
  const units = (await json(await get(customerApp(raw), '/api/trade-in/eligible'))).units as Array<{ order_item_id: string; unit_index: number; paid_iqd: number }>;
  for (const i of [1, 2]) assert.equal(units.find((u) => u.order_item_id === 'oi_a1' && u.unit_index === i)!.paid_iqd, paid - 50_000, `unit ${i}`);
});

// ---------------------------------------------------------------- F8
test('F8: a direct line is compared on its own channel — a removed direct cell is a closed channel, not the model price', async () => {
  const w = ppWorld();
  w.raw.exec(`
    INSERT INTO products (id, slug, name, status, price_iqd, stock, sale_types) VALUES ('pf', 'pf', 'Printer', 'active', 900000, 5, '["direct_sale","pre_order"]');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('pf_g', 'pf', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, regular_price_iqd)
      VALUES ('pf_a', 'pf', 'pf_g', 'A', 0, 1, 5, 900000);
    INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd)
      VALUES ('pf_a_d', 'pf', 'pf_a', 'direct_sale', 1, 950000), ('pf_a_p', 'pf', 'pf_a', 'pre_order', 1, 900000);
    INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled, surcharge_iqd, regular_price_iqd)
      VALUES ('pf_a_p_air', 'pf', 'pf_a_p', 'air', 1, 0, 900000);`);
  const direct = { pricing_basis: 'direct', fulfillment: { type: 'direct_sale' }, price_source: 'fulfillment' };
  const { itemId } = w.deliveredLine({ productId: 'pf', unit: 950_000, optionId: 'pf_a', pricing: direct });
  assert.equal((await w.claim(itemId)).body.code, 'NO_ELIGIBLE_DROP');
  // The shop removes the direct cell (pre-order only now). No price fell on the direct channel.
  w.raw.exec(`DELETE FROM product_option_fulfillment WHERE id = 'pf_a_d'; UPDATE products SET sale_types = '["pre_order"]' WHERE id = 'pf'`);
  const closed = await w.claim(itemId);
  assert.equal(closed.status, 400, JSON.stringify(closed.body));
  assert.equal(closed.body.code, 'NO_ELIGIBLE_DROP');
  // A real drop on the direct channel is still paid (a second direct line, its cell lowered).
  w.raw.exec(`INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd)
                VALUES ('pf_a_d2', 'pf', 'pf_a', 'direct_sale', 1, 920000);
              UPDATE products SET sale_types = '["direct_sale","pre_order"]' WHERE id = 'pf'`);
  const second = w.deliveredLine({ productId: 'pf', unit: 950_000, optionId: 'pf_a', pricing: direct });
  const paid = await w.claim(second.itemId);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.claim.observed_unit_iqd, 920_000);
});

// ---------------------------------------------------------------- R1
test('R1: a return on unit 1 does not hold the trade-in of unit 2, and a finished return holds nothing', async () => {
  const raw = seed({ deliveredDaysAgo: 3 });
  twoUnits(raw);
  const id = await submittedUnit(raw, 2);
  const ret = stubApp(dbOf(raw), CUSTOMER, (a) => a.route('/api/returns', returnRoutes));
  const opened = await post(ret, '/api/returns', { orderItemId: 'oi_a1', unitId: 'unit_a1', qty: 1, reason: 'defective' });
  assert.equal(opened.status, 200, await opened.clone().text());
  const approve = await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/approve`);
  assert.equal(approve.status, 200, await approve.clone().text());
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'awaiting_payment');
});

test('R1: a resolved return on the other device of the line no longer blocks the approval', async () => {
  const raw = seed({ deliveredDaysAgo: 3 });
  twoUnits(raw);
  const id = await submittedUnit(raw, 2);
  const ret = stubApp(dbOf(raw), CUSTOMER, (a) => a.route('/api/returns', returnRoutes));
  assert.equal((await post(ret, '/api/returns', { orderItemId: 'oi_a1', unitId: 'unit_a1', qty: 1, reason: 'defective' })).status, 200);
  raw.prepare("UPDATE return_cases SET state = 'resolved', resolution = 'declined' WHERE order_item_id = 'oi_a1'").run();
  const approve = await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/approve`);
  assert.equal(approve.status, 200, await approve.clone().text());
});

test('R1: a return that names no device holds the trade-in only when it cannot be the other device', async () => {
  const raw = seed({ deliveredDaysAgo: 3 });
  twoUnits(raw);
  const id = await submittedUnit(raw, 2);
  // One of two, line-level: the other device can be the returned one.
  raw.exec(`INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state)
              VALUES ('ret_line', 'ORD-OLD', 'oi_a1', NULL, 'cust', 1, 'defective', 'requested')`);
  assert.equal((await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/approve`)).status, 200);
  // Both of two: it covers the traded device too.
  const raw2 = seed({ deliveredDaysAgo: 3 });
  twoUnits(raw2);
  const id2 = await submittedUnit(raw2, 2);
  raw2.exec(`INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, state)
               VALUES ('ret_both', 'ORD-OLD', 'oi_a1', NULL, 'cust', 2, 'defective', 'requested')`);
  const held = await post(adminApp(raw2, STAFF), `/api/admin/trade-in/requests/${id2}/approve`);
  assert.equal(held.status, 409, await held.clone().text());
  assert.equal((await json(held)).code, 'TRADE_IN_RETURN_OPEN');
});

// ---------------------------------------------------------------- R2
function repairWorld() {
  const raw = seed({ deliveredDaysAgo: 3 });
  twoUnits(raw);
  raw.exec(`INSERT INTO device_registrations (unit_id, user_id) VALUES ('unit_a1','cust'), ('unit_a2','cust');`);
  const app = stubApp(dbOf(raw), CUSTOMER, (a) => {
    a.route('/api/returns', returnRoutes);
    a.route('/api/devices', deviceRoutes);
  });
  return { raw, app };
}

test('R2: returning one of two printers (as the return screen sends it) while the other is on the repair desk', async () => {
  const { raw, app } = repairWorld();
  raw.exec(`INSERT INTO warranty_claims (id,user_id,order_item_id,product_name,description,unit_id,stage,status)
              VALUES ('wc_u2','cust','oi_a1','A1','the second printer clicks','unit_a2','diagnosing','in_review');`);
  const one = await post(app, '/api/returns', { orderItemId: 'oi_a1', qty: 1, reason: 'defective', description: 'unit 1 arrived dead' });
  assert.equal(one.status, 200, await one.clone().text());
  // Both of two would include the one on the repair desk.
  const raw2 = repairWorld();
  raw2.raw.exec(`INSERT INTO warranty_claims (id,user_id,order_item_id,product_name,description,unit_id,stage,status)
                   VALUES ('wc_u2','cust','oi_a1','A1','the second printer clicks','unit_a2','diagnosing','in_review');`);
  const both = await post(raw2.app, '/api/returns', { orderItemId: 'oi_a1', qty: 2, reason: 'defective', description: 'both arrived dead' });
  assert.equal(both.status, 409, await both.clone().text());
  assert.equal((await json(both)).code, 'WARRANTY_CLAIM_OPEN');
});

test('R2: the warranty door counts the same way — one device of two under a line-level return can still be claimed', async () => {
  const { raw, app } = repairWorld();
  const ret = await post(app, '/api/returns', { orderItemId: 'oi_a1', qty: 1, reason: 'defective', description: 'unit 1 arrived dead' });
  assert.equal(ret.status, 200, await ret.clone().text());
  const claim = await post(app, '/api/devices/units/unit_a2/claims', {
    subject: 'Extruder clicks', description: 'The extruder clicks and under-extrudes on every print.', idempotencyKey: 'r2-claim-unit2-0001',
  });
  assert.equal(claim.status, 200, await claim.clone().text());
  // A second claim on the other device would leave no device for the open return.
  const second = await post(app, '/api/devices/units/unit_a1/claims', {
    subject: 'Bed does not heat', description: 'The bed never reaches temperature at all.', idempotencyKey: 'r2-claim-unit1-0001',
  });
  assert.equal(second.status, 409, await second.clone().text());
  assert.equal((await json(second)).code, 'RETURN_CASE_OPEN');
  assert.equal(row(raw, "SELECT id FROM warranty_claims WHERE unit_id = 'unit_a1'"), undefined);
});
