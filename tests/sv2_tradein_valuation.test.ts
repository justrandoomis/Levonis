/**
 * Services V2 survey — trade-in VALUATION gaps, reproduced (ported from the
 * survey worktree onto the default branch for stage S-P0). Each test states
 * the behaviour the owner's brief requires (2026-10-13: «يتم مقارنته بالسعر
 * الحالي فيتم حسابه على أساس السعر الحالي … أن لا تثبت خسائر للشركة»).
 * LOCAL ONLY.
 *
 * Ported here: V2, V3 (the shared paid-net rule, plan §3.2) and V4 (one money
 * process per device, plan §1.3). V1 (the value compared with today's new
 * price) is the store-safe formula of owner decision 1 and lands with S-P2.
 *
 * Run: node --import tsx --test tests/sv2_tradein_valuation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, post, send } from './fixtures/app';
import { blankInputs } from '../packages/pricing/src/tradeIn';
import { customerApp, daysAgo, restoreFetch, seed } from './sv2_tradein_fixture';

test.after(restoreFetch);

test('V1 (S-P2) a used printer is never valued at or above what the SAME model costs new today (bought 850,000, new today 500,000 → offer 300,000)', async () => {
  // Bought 20 days ago at 850,000; the A1 sells new today at 500,000 (V2-published, direct sale).
  const raw = seed({ paid: 850_000, a1Now: 500_000, comboNow: 700_000 });
  const a = customerApp(raw);
  const draft = await json(await post(a, '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' }));
  assert.ok(draft.success, JSON.stringify(draft));
  const id = draft.request.id as string;
  await send(a, 'PATCH', `/api/trade-in/requests/${id}`, { components: { device: blankInputs('fdm') }, target: { product_id: 'p_p1s', option_value_ids: [], color_id: null } });
  const preview = await json(await post(a, `/api/trade-in/requests/${id}/preview`, {}));
  // Before S-P2: base = what was PAID (850,000) → +warranty −market → capped at 85% → 722,000.
  assert.equal(preview.offer?.offer_iqd, 300_000, JSON.stringify(preview));
  assert.ok(preview.offer.offer_iqd < 500_000, `offer ${preview.offer.offer_iqd} must stay below today's new price 500,000`);
  assert.equal(preview.offer.now_price_iqd, 500_000, 'today\'s public price is the customer\'s to read');
  assert.equal(preview.estimate.total_iqd, 300_000, 'the old key answers the same one figure');
  assert.deepEqual(preview.estimate.components, [], 'no per-part value');
  const view = (await json(await get(a, `/api/trade-in/requests/${id}`))).request;
  assert.equal(view.estimated_iqd, null, 'a draft carries no figure (G11)');
});

test('V2 «what the customer actually paid» subtracts an order-level coupon (checkout never writes order_items.coupon_discount_iqd)', async () => {
  const raw = seed({ paid: 850_000 });
  // The order the way checkout stores it: the coupon lives on the ORDER
  // (coupon_snapshot / coupon_discount_iqd), the line keeps the list unit price.
  raw.exec(`UPDATE orders SET coupon_snapshot = '{"coupon_id":"cp_x","code":"SAVE150","discount_iqd":150000}',
                              coupon_code = 'SAVE150', coupon_discount_iqd = 150000, total_iqd = 700000 WHERE id = 'ORD-OLD'`);
  const units = (await json(await get(customerApp(raw), '/api/trade-in/eligible'))).units as Array<{ order_item_id: string; paid_iqd: number }>;
  const a1 = units.find((u) => u.order_item_id === 'oi_a1')!;
  assert.equal(a1.paid_iqd, 700_000, 'paid 850,000 − 150,000 coupon; today it reads 850,000');
});

test('V3 «what the customer actually paid» subtracts a price-protection credit already paid on that line', async () => {
  const raw = seed({ paid: 850_000 });
  raw.exec(`INSERT INTO price_protection_claims (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state,requested_at,decided_at)
            VALUES ('ppc_1','cust','ORD-OLD','oi_a1',850000,750000,1,100000,'credited','${daysAgo(10)}','${daysAgo(9)}')`);
  const units = (await json(await get(customerApp(raw), '/api/trade-in/eligible'))).units as Array<{ order_item_id: string; paid_iqd: number }>;
  assert.equal(units.find((u) => u.order_item_id === 'oi_a1')!.paid_iqd, 750_000, 'the shop already returned 100,000 of it');
});

test('V4 a device with an OPEN warranty claim (at the repair desk) cannot be offered for trade-in until the claim closes', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO warranty_claims (id,user_id,order_item_id,unit_id,product_name,description,status)
            VALUES ('wc_1','cust','oi_a1','unit_a1','Bambu Lab A1','Heating error','in_review')`);
  const res = await post(customerApp(raw), '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' });
  assert.equal(res.status, 409, `opened while the claim is in review: ${res.status}`);
});
