/**
 * Services S-P2 (DECISIONS row 238; spec §6.6, §13.3, §13.4) — tiered money on the server's CEILING
 * from intake (owner decision 3): a financial admin approves or lowers up to it; above it is the
 * owner's alone, with a private reason that the audit and the owner's valuation record keep, and —
 * past the store's own cap — an acknowledgement that the margin may be a loss. The customer reads
 * the value and their own reason only. LOCAL ONLY.
 *
 * Run: node --import tsx --test tests/sv2_p2_ceiling.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { count, get, json, post, row, stubApp } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { adminTradeInRoutes } from '../worker/routes/tradeIn';
import { INTAKE_REASON } from '../worker/lib/tradeIn';
import { OWNER, STAFF, adminApp, customerApp, received, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const code = async (res: Response) => [res.status, (await json(res)).code] as const;
const req = (raw: DatabaseSync, id: string) => row<Record<string, any>>(raw, 'SELECT * FROM trade_in_requests WHERE id = ?', id)!;

test('approve = the ceiling: equal to the offer, the value is fixed and the credit minted', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  const r0 = req(raw, id);
  assert.equal(r0.ceiling_iqd, r0.offer_iqd);
  const res = await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/approve`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.request.status, 'awaiting_payment');
  assert.equal(body.request.final_value_iqd, r0.offer_iqd);
  const audit = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'trade_in.approve' AND target = ?", id)!.detail);
  assert.deepEqual([audit.authority.tier, audit.authority.amount_iqd, audit.authority.ceiling_iqd], ['financial', r0.offer_iqd, r0.offer_iqd]);
});

test('approve = the ceiling: lower than the offer after intake, the customer is asked — «بعد فحص الجهاز في المتجر» — and accepting fixes the ceiling', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id, { body: { components: { device: { cleanliness: 2, exterior: 2, scratches: 1 } } } });
  const r0 = req(raw, id);
  assert.ok(r0.ceiling_iqd < r0.offer_iqd, `${r0.ceiling_iqd} < ${r0.offer_iqd}`);
  const res = await json(await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(res.request.status, 'value_changed');
  const mine = (await json(await get(customerApp(raw), `/api/trade-in/requests/${id}`))).request;
  assert.deepEqual([mine.value_proposal.value_iqd, mine.value_proposal.reason, mine.stage, mine.can.decide], [r0.ceiling_iqd, INTAKE_REASON, 'decision', true]);
  const accepted = await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/accept`, { offer_no: 1 }));
  assert.equal(accepted.request.status, 'awaiting_payment');
  assert.equal(accepted.request.final_value_iqd, r0.ceiling_iqd);
});

test('value: a financial admin up to the ceiling; above it only the owner — a reason, and past the store’s cap the acknowledgement; flagged and recorded', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  const ceiling = req(raw, id).ceiling_iqd as number;
  const store = row<{ store_cap_iqd: number }>(raw, "SELECT store_cap_iqd FROM trade_in_valuations WHERE request_id = ? AND phase = 'intake'", id)!.store_cap_iqd;
  assert.ok(store >= ceiling, `store cap ${store} ≥ ceiling ${ceiling}`);
  // Up to the ceiling: a financial admin.
  assert.equal((await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: ceiling, reason: 'as inspected' })).status, 200);
  // Above it: the owner's.
  assert.deepEqual(await code(await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: ceiling + 5_000 })), [403, 'OWNER_REQUIRED']);
  assert.deepEqual(await code(await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: ceiling + 5_000 })), [400, 'OWNER_REASON_REQUIRED']);
  const reason = 'loyal customer, every original accessory';
  // Past the store's own cap: the acknowledgement that the margin may be a loss.
  const past = store + 50_000;
  assert.deepEqual(
    await code(await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: past, owner_reason: reason })),
    [400, 'TRADE_IN_MARGIN_ACK_REQUIRED']
  );
  const ok = await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: past, owner_reason: reason, ack_below_margin: true, reason: 'excellent condition' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const r = req(raw, id);
  assert.deepEqual([r.status, r.admin_value_iqd, r.above_ceiling], ['value_changed', past, 1]);
  const audit = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'trade_in.change_value' AND target = ? ORDER BY id DESC", id)!.detail);
  assert.deepEqual([audit.authority.owner_reason, audit.authority.above_ceiling, audit.authority.ceiling_iqd], [reason, true, ceiling]);
  const override = row<{ offer_iqd: number; ceiling_iqd: number; store_cap_iqd: number; params_json: string }>(raw, "SELECT offer_iqd, ceiling_iqd, store_cap_iqd, params_json FROM trade_in_valuations WHERE request_id = ? AND phase = 'override'", id)!;
  assert.deepEqual([override.offer_iqd, override.ceiling_iqd, override.store_cap_iqd], [past, ceiling, store]);
  assert.equal(JSON.parse(override.params_json).owner_reason, reason);
  // The desk sees the flag; the customer reads their reason and the value — never the owner's reason or the ceiling.
  const staff = (await json(await get(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}`))).request;
  assert.equal(staff.above_ceiling, true);
  const mine = JSON.stringify((await json(await get(customerApp(raw), `/api/trade-in/requests/${id}`))).request);
  assert.ok(mine.includes('excellent condition'));
  for (const s of [reason, 'above_ceiling', 'ceiling_iqd', 'store_cap', 'owner_reason']) assert.ok(!mine.includes(s), s);
});

test('approve and value wait for the device; the old inspect door reads TRADE_IN_INTAKE_REQUIRED', async () => {
  const raw = seed();
  const id = await submitted(raw);
  for (const [path, body] of [['approve', {}], ['value', { value_iqd: 10_000 }], ['inspect', {}]] as const) {
    assert.deepEqual(await code(await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/${path}`, body)), [409, 'TRADE_IN_INTAKE_REQUIRED'], path);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', id), 0);
});

test('concurrency: two approvals at once — one fixes the value, the other is stale; one coupon', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await received(raw, id);
  const db = serialD1(raw);
  const app = (who: typeof STAFF) => stubApp(db, who, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes));
  const [a, b] = await Promise.all([
    post(app(STAFF), `/api/admin/trade-in/requests/${id}/approve`),
    post(app(OWNER), `/api/admin/trade-in/requests/${id}/approve`),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses[0], 200);
  assert.equal(statuses[1], 409);
  assert.equal(req(raw, id).status, 'awaiting_payment');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', id), 1);
});
