/**
 * Services V2 survey — trade-in MONEY CONTROLS, reproduced (ported from the
 * survey worktree onto the default branch for stage S-P0). Each test states
 * the behaviour the store needs («لا تثبت خسائر للشركة», an admin review that
 * can only lower or confirm). LOCAL ONLY.
 *
 * Ported here: M1 (owner decision 3: a value above the estimate is the
 * owner's) and M2 (owner decision 2: the credit ends). M3 (credit only after
 * intake), M4 (completion on delivery) and M5 (the device booked into stock)
 * land with S-P2; M6 (the customer reads the offer, not the formula) is
 * already green on the default branch (DECISIONS rows 219/220).
 *
 * Run: node --import tsx --test tests/sv2_tradein_money.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, row } from './fixtures/app';
import { STAFF, adminApp, customerApp, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

test('M1 a non-owner admin cannot raise the value above the formula — today any full-scope admin can make the new P1S free', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const est = row<{ estimated_iqd: number }>(raw, 'SELECT estimated_iqd FROM trade_in_requests WHERE id = ?', id)!.estimated_iqd;
  // 1,500,000 = the whole price of the new device; the formula said `est`.
  const res = await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 1_500_000, reason: '' });
  const accepted = res.status === 200 ? await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/accept`, { offer_no: 1 })) : null;
  assert.notEqual(res.status, 200, `staff raised ${est} → 1,500,000; accepted difference = ${accepted?.request?.difference_iqd}`);
});

test('M2 the trade-in credit expires (coupons.ends_at) — today it is valid for ever while the device and prices age', async () => {
  const raw = seed();
  const id = await submitted(raw);
  await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`);
  const c = row<{ ends_at: string | null }>(raw, 'SELECT ends_at FROM coupons WHERE trade_in_id = ?', id)!;
  assert.ok(c.ends_at, 'a fixed credit with no end date');
});
