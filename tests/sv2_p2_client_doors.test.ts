/**
 * Services S-P2 pass B (DECISIONS row 238) — THE THREE READS THE SCREENS ADDED.
 *
 *   GET /api/trade-in/requests        «طلباتي للاستبدال» says where each request stands (`stage`,
 *                                     `stage_label`) — and on a database without 0192 answers as
 *                                     before (no stage, no failure);
 *   GET /api/trade-in/targets?product_id=   the product page's entry preselects ONE listed device,
 *                                     priced like the search; an unknown or malformed id is none;
 *   GET /api/admin/trade-in/rules     the owner's editor reads each family's offer parameters, the
 *                                     code defaults and the ranges (owner-only, cost_read) — the
 *                                     defaults are never shipped in a bundle.
 *
 * LOCAL ONLY. Run: node --import tsx --test tests/sv2_p2_client_doors.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json } from './fixtures/app';
import { OWNER, STAFF, adminApp, customerApp, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

test('«طلباتي للاستبدال»: each request carries its stage and the customer\'s words for it', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const body = await json(await get(customerApp(raw), '/api/trade-in/requests'));
  const row = body.requests.find((r: { id: string }) => r.id === id);
  assert.equal(row.stage, 'awaiting_device');
  assert.deepEqual(row.stage_label, { ar: 'بانتظار جهازك', en: 'Waiting for your device', ckb: 'چاوەڕێی ئامێرەکەتین' });
  assert.ok(row.offer_iqd > 0, 'the offer the customer was told');
  for (const k of ['ceiling_iqd', 'intake_json', 'above_ceiling']) assert.ok(!(k in row), k);
  raw.close();
});

test('on a database without 0192 the list answers as before: no stage, no failure', async () => {
  const raw = seed({ through: '0191' });
  const res = await get(customerApp(raw), '/api/trade-in/requests');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.requests, []);
  raw.close();
});

test('the product page\'s device: ONE listed target by id, priced for this customer; an unknown or malformed id is none', async () => {
  const raw = seed();
  const a = customerApp(raw);
  const one = await json(await get(a, '/api/trade-in/targets?product_id=p_p1s'));
  assert.deepEqual(
    one.targets.map((t: { product_id: string }) => t.product_id),
    ['p_p1s']
  );
  assert.equal(one.targets[0].from_price_iqd, 1_500_000);
  assert.equal(one.next_cursor, null);
  assert.deepEqual((await json(await get(a, '/api/trade-in/targets?product_id=p_nope'))).targets, []);
  assert.deepEqual((await json(await get(a, '/api/trade-in/targets?product_id=%27%20OR%201%3D1'))).targets, []);
  raw.close();
});

test('the owner\'s rules read carries the offer parameters, the defaults and the ranges; staff are refused', async () => {
  const raw = seed();
  const owner = await json(await get(adminApp(raw, OWNER), '/api/admin/trade-in/rules'));
  assert.equal(owner.offer_defaults.fdm.resale_bp, 8000);
  assert.equal(owner.offer_defaults.fdm.min_offer_iqd, 50_000);
  assert.deepEqual(owner.offer_ranges.max_offer_bp, [0, 9500]);
  assert.equal(typeof owner.rules.fdm.offer_params, 'object');
  const staff = await get(adminApp(raw, STAFF), '/api/admin/trade-in/rules');
  assert.equal(staff.status, 403);
  assert.equal((await json(staff)).code, 'COST_ACCESS_DENIED');
  raw.close();
});
