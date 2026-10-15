/**
 * Services S-P2 (DECISIONS row 238; spec §6.13, §13.3) — the desk's queue v2 and the owner's doors.
 *
 *   GET /api/admin/trade-in/requests   one search over the customer (name, e-mail, the phone's last
 *                                      digits), the ids, both serials and both device names; work
 *                                      chips with counts; keyset pages of 30; staff figures only
 *   GET /api/admin/services/badge      what waits on the desk
 *   owner doors                        valuation record, policy, component references, P&L —
 *                                      COST_ACCESS_DENIED / OWNER_REQUIRED for everyone else
 *
 * LOCAL ONLY. Run: node --import tsx --test tests/sv2_p2_admin_queue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { get, json, post, row, send, stubApp, type StubUser } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { adminServicesRoutes } from '../worker/routes/myServices';
import { OWNER, STAFF, adminApp, approvedAndOrdered, delivered, received, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const code = async (res: Response) => [res.status, (await json(res)).code] as const;
const queue = async (raw: DatabaseSync, qs: string, who: StubUser = ASSISTANT) => {
  const res = await get(adminApp(raw, who), `/api/admin/trade-in/requests${qs}`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  return body as { requests: Array<Record<string, any>>; counts: Record<string, number>; next_cursor: string | null };
};
const ids = (b: { requests: Array<Record<string, any>> }) => b.requests.map((r) => r.id as string);

function world() {
  const raw = seed();
  raw.exec(`UPDATE users SET phone_e164 = '+9647701234567' WHERE id = 'cust';
            INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale,admin_scope)
              VALUES ('helper','Helper','helper@x.co','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');`);
  return raw;
}

test('the search finds a request by the customer’s name, e-mail, phone’s last digits, request id, order id, the scanned serial, the serial on record, the device and the target names', async () => {
  const raw = world();
  const id = await submitted(raw);
  raw.prepare("INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('01P00A7766554433', '01P00A7766554433', 'unit_a1', 'staff')").run();
  for (const q of ['سارة', 'SARA@x', '1234567', '07701234567', id.slice(0, 12), 'ORD-OLD', '7766554433', 'bambu lab a1', 'P1S']) {
    assert.deepEqual(ids(await queue(raw, `?q=${encodeURIComponent(q)}`)), [id], q);
  }
  assert.deepEqual(ids(await queue(raw, '?q=nobody-here')), []);
  // LIKE wildcards are the customer's characters, not the database's.
  assert.deepEqual(ids(await queue(raw, `?q=${encodeURIComponent('%_%')}`)), []);
  // Received: the serial the desk scanned is searchable too.
  await received(raw, id, { body: { serial: '01P00A7766554433' } });
  assert.deepEqual(ids(await queue(raw, '?q=01p00a77665')), [id]);
});

test('chips and their counts: awaiting device → inspecting → credit ready → awaiting the new device → completed; the row carries staff figures and flags, never a cost', async () => {
  const raw = world();
  const id = await submitted(raw);
  let b = await queue(raw, '');
  assert.equal(b.requests[0].chip, 'awaiting_device');
  assert.equal(b.counts.awaiting_device, 1);
  assert.equal(b.counts.overdue, 0);
  // The device is due within a day: overdue.
  raw.prepare('UPDATE trade_in_requests SET offer_expires_at = ? WHERE id = ?').run(new Date(Date.now() + 6 * 3_600_000).toISOString(), id);
  b = await queue(raw, '?chip=overdue');
  assert.deepEqual(ids(b), [id]);
  assert.deepEqual([b.counts.overdue, b.requests[0].flags.overdue], [1, true]);
  await received(raw, id);
  b = await queue(raw, '?chip=inspecting');
  assert.deepEqual(ids(b), [id]);
  assert.equal(b.counts.inspecting, 1);
  assert.deepEqual(ids(await queue(raw, '?chip=awaiting_device')), [], 'the counts still read every chip');
  const r = (await queue(raw, '')).requests[0];
  assert.deepEqual([r.flags.serial, r.flags.hours, r.flags.above_ceiling, r.flags.overdue], ['match', false, false, false]);
  assert.ok(typeof r.ceiling_iqd === 'number' && typeof r.offer_iqd === 'number');
  for (const k of ['store_cap_iqd', 'expected_margin_iqd', 'resale_iqd', 'costs_iqd', 'cost_basis_iqd', 'params', 'components_json']) assert.equal(k in r, false, k);
  assert.deepEqual(ids(await queue(raw, '?chip=overdue')), [], 'received: no longer due (inspecting turns overdue after 48 hours)');

  await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/approve`);
  assert.equal((await queue(raw, '')).requests[0].chip, 'credit_ready');

  const raw2 = world();
  const id2 = await submitted(raw2);
  const { orderId } = await approvedAndOrdered(raw2, id2);
  assert.equal((await queue(raw2, '')).requests[0].chip, 'awaiting_new_device');
  await delivered(raw2, orderId);
  const done = await queue(raw2, '?chip=completed');
  assert.deepEqual(ids(done), [id2]);
  assert.equal(done.requests[0].stage, 'completed');
});

test('keyset pages of 30, newest first, nothing twice and nothing skipped', async () => {
  const raw = world();
  const id = await submitted(raw);
  const insert = raw.prepare(
    `INSERT INTO trade_in_requests (id, user_id, status, order_id, order_item_id, unit_index, family, scope, created_at, updated_at, submitted_at)
     VALUES (?, 'cust', 'submitted', 'ORD-OLD', ?, 1, 'fdm', 'whole', ?, ?, ?)`
  );
  for (let i = 0; i < 40; i++) {
    const at = new Date(Date.parse('2026-09-01T00:00:00.000Z') + (i % 20) * 3_600_000).toISOString(); // ties on purpose
    insert.run(`tin_page_${String(i).padStart(3, '0')}`, `oi_page_${i}`, at, at, at);
  }
  const first = await queue(raw, '');
  assert.equal(first.requests.length, 30);
  assert.equal(first.requests[0].id, id, 'newest first');
  assert.ok(first.next_cursor);
  const second = await queue(raw, `?cursor=${encodeURIComponent(first.next_cursor!)}`);
  assert.equal(second.requests.length, 11);
  assert.equal(second.next_cursor, null);
  const all = [...ids(first), ...ids(second)];
  assert.equal(new Set(all).size, 41);
  assert.equal(first.counts.awaiting_device, 41);
  // A forged cursor is ignored, never an error or an injection.
  assert.equal((await queue(raw, `?cursor=${encodeURIComponent("x'|1 OR 1=1")}`)).requests.length, 30);
  assert.deepEqual(await code(await get(adminApp(raw, ASSISTANT), '/api/admin/trade-in/requests?chip=everything')), [400, undefined]);
});

test('the desk badge: devices due within a day, received and undecided, to hand back; any admin, counts only', async () => {
  const raw = world();
  const badge = async () => {
    const app = stubApp(new LimitD1(raw) as unknown as D1Database, ASSISTANT, (a) => a.route('/api/admin/services', adminServicesRoutes));
    const res = await get(app, '/api/admin/services/badge');
    assert.equal(res.status, 200);
    return json(res);
  };
  const id = await submitted(raw);
  assert.equal((await badge()).trade_in, 0, 'a week to hand it in');
  raw.prepare('UPDATE trade_in_requests SET offer_expires_at = ? WHERE id = ?').run(new Date(Date.now() + 6 * 3_600_000).toISOString(), id);
  assert.equal((await badge()).trade_in, 1);
  await received(raw, id);
  const b = await badge();
  assert.deepEqual([b.trade_in, b.price_protection], [1, 0]);
  const guest = stubApp(new LimitD1(raw) as unknown as D1Database, { id: 'cust', role: 'customer', email: 'sara@x.co' }, (a) => a.route('/api/admin/services', adminServicesRoutes));
  assert.equal((await get(guest, '/api/admin/services/badge')).status, 403);
});

test('the owner’s doors: the valuation record and the stock it became, the policy, the component references, the P&L — refused to every other admin with the same body for a real and an invented id', async () => {
  const raw = world();
  const id = await submitted(raw);
  const { orderId } = await approvedAndOrdered(raw, id);
  await delivered(raw, orderId);
  const credit = row<{ credit_iqd: number }>(raw, 'SELECT credit_iqd FROM trade_in_requests WHERE id = ?', id)!.credit_iqd;

  const v = await json(await get(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/valuation`));
  assert.ok(v.valuations.length >= 2, 'submit and intake');
  assert.ok(v.valuations.some((x: any) => x.phase === 'intake' && typeof x.store_cap === 'number'));
  assert.deepEqual(v.stock, { lot_id: `ilot_ti_${id}`, draft_product_id: `prd_ti_${id}`, cost_basis_iqd: credit, order_id: orderId, booked_at: v.stock.booked_at });

  for (const who of [STAFF, ASSISTANT]) {
    const real = await get(adminApp(raw, who), `/api/admin/trade-in/requests/${id}/valuation`);
    const fake = await get(adminApp(raw, who), '/api/admin/trade-in/requests/tin_00000000000000000000/valuation');
    assert.equal(real.status, 403);
    assert.deepEqual(await json(real), await json(fake));
    for (const path of ['/policy', '/component-refs', '/pnl']) assert.deepEqual(await code(await get(adminApp(raw, who), `/api/admin/trade-in${path}`)), [403, 'COST_ACCESS_DENIED'], path);
    assert.deepEqual(await code(await send(adminApp(raw, who), 'PUT', '/api/admin/trade-in/policy', { offer_valid_days: 3 })), [403, who === STAFF ? 'OWNER_REQUIRED' : 'FINANCIAL_SCOPE_REQUIRED']);
  }

  // The policy: ranges enforced, saved whole.
  assert.deepEqual(await code(await send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/policy', { offer_valid_days: 0 })), [400, 'TRADE_IN_POLICY_INVALID']);
  const saved = await json(await send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/policy', { offer_valid_days: 10, pickup_fee_iqd: 7500 }));
  assert.deepEqual([saved.policy.offer_valid_days, saved.policy.pickup_fee_iqd, saved.policy.credit_valid_days], [10, 7500, 7]);
  assert.equal((await json(await get(adminApp(raw, OWNER), '/api/admin/trade-in/policy'))).policy.offer_valid_days, 10);

  // The component references.
  assert.deepEqual(await code(await send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/component-refs', { product_id: 'p_a1', option_value_id: 'v_a1c', role: 'ams', ref_price_usd: '1.234' })), [400, 'TRADE_IN_REF_INVALID']);
  const put = await send(adminApp(raw, OWNER), 'PUT', '/api/admin/trade-in/component-refs', { product_id: 'p_a1', option_value_id: 'v_a1c', role: 'ams', ref_price_usd: '199.50' });
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal((await json(await get(adminApp(raw, OWNER), '/api/admin/trade-in/component-refs'))).refs[0].ref_price_usd, '199.50');
  const gone = await send(adminApp(raw, OWNER), 'DELETE', '/api/admin/trade-in/component-refs', { product_id: 'p_a1', option_value_id: 'v_a1c', role: 'ams' });
  assert.equal(gone.status, 200);
  assert.deepEqual((await json(gone)).refs, []);

  // The P&L: the device in stock at the credit.
  const pnl = (await json(await get(adminApp(raw, OWNER), '/api/admin/trade-in/pnl'))).pnl;
  assert.deepEqual(pnl.in_stock, { count: 1, cost_iqd: credit });
  assert.equal(pnl.credits_fixed.count, 1);
  assert.equal(pnl.credits_fixed.total_iqd, credit);
});
