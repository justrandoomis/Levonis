/**
 * THE COMMUNITY-STORE ORDER, AFTER THE END-TO-END REVIEW OF THE LIVE MERCHANT
 * PLATFORM — journey A on the live D1 limits:
 *
 *   F6  «مبيعات مسجّلة» (Money) and «إجمالي المدفوع» (Analytics) are two
 *       different figures; their relationship is pinned here;
 *   F7  a store order's «delivered» asks for «أكّد الاستلام», promises no
 *       points and opens the order;
 *   F8  a receipt confirmed while a ticket is open is recorded, and the money
 *       stays frozen (the sweep's own rule);
 *   F11 the merchant hears a failed payout and a claw-back that left their
 *       balance negative;
 *   F12 the coupon form and a customer's late cancel refuse with stable codes;
 *   F13 an admin's walk-back shows its stage on the merchant's timeline, once;
 *       DELIVERY_FEE_ABOVE_MAX names the fee(s) over the cap.
 *
 * Run: node --import tsx --test tests/storeOrderReviewFixes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, patch, post, put, json, row, all, pending } from './fixtures/app';
import {
  storeWorld,
  openStore,
  buyerApp,
  merchantApp,
  storeAdminApp,
  buyStoreOrder,
  deliverStoreOrder,
} from './fixtures/reviewE2eWorld';

const settle = () => Promise.allSettled(pending.splice(0));
type Raw = ReturnType<typeof storeWorld>['raw'];
const notes = (raw: Raw, user: string) =>
  all<{ kind: string; title_ar: string; title_en: string; link: string; event_key: string }>(
    raw,
    'SELECT kind, title_ar, title_en, link, event_key FROM user_notifications WHERE user_id = ? ORDER BY created_at, rowid',
    user
  );

// ------------------------------------------------------------------- F6

test('F6: Recorded sales (Money) and Total paid (Analytics) — the relationship, pinned', async () => {
  const { raw, db } = storeWorld();
  const { m, product } = await openStore(db);
  // A: 2 × 14 000 − 10% = 25 200 goods + 4 000 delivery = 29 200 paid.
  const a = await buyStoreOrder(db, product, 'f6-order-a', 2);
  // B: 1 × 14 000 − 10% = 12 600 goods + 4 000 delivery — then cancelled and refunded.
  const b = await buyStoreOrder(db, product, 'f6-order-b', 1);
  await settle();
  const cancel = await post(m, `/api/merchant/orders/${b}/status`, { status: 'cancelled', reason: 'no stock' });
  assert.equal(cancel.status, 200, JSON.stringify(await json(cancel)));
  await settle();

  const money = (await json(await get(m, '/api/merchant/finance/summary'))).summary;
  const report = await json(await get(m, '/api/merchant/analytics/report'));
  const totals = report.orders?.totals ?? report.totals;
  const orderA = row<{ total_iqd: number }>(raw, 'SELECT total_iqd FROM orders WHERE id = ?', a)!;

  // «مبيعات مسجّلة»: goods after the coupon, WITHOUT delivery, INCLUDING the cancelled order…
  assert.equal(money.store_gross, 25_200 + 12_600);
  // …whose money back is its own line (goods + its delivery).
  assert.equal(money.refunds, 12_600 + 4_000);
  assert.equal(money.delivery_fees, 4_000 + 4_000);
  // «إجمالي المدفوع»: what customers paid — order totals WITH delivery, WITHOUT the cancelled one.
  assert.equal(totals.gross_iqd, orderA.total_iqd);
  assert.equal(totals.gross_iqd, 29_200);
  // THE RELATIONSHIP (store orders, every cancelled order refunded in full):
  //   Total paid = Recorded sales + delivery fees − refunds.
  assert.equal(totals.gross_iqd, money.store_gross + money.delivery_fees - money.refunds);
});

test('F6: the two figures carry distinct names and a one-line definition each', async () => {
  const { readFileSync } = await import('node:fs');
  const finance = readFileSync(new URL('../src/components/merchant/finance/strings.ts', import.meta.url), 'utf8');
  const analytics = readFileSync(new URL('../src/components/merchant/shell/sections/AnalyticsSection.tsx', import.meta.url), 'utf8');
  assert.match(finance, /gross: loc\('مبيعات مسجّلة', 'Recorded sales'\)/);
  assert.match(finance, /grossMeans: loc\(/);
  assert.match(analytics, /label=\{loc\('إجمالي المدفوع', 'Total paid'\)\}/);
  assert.match(analytics, /«إجمالي المدفوع» ما دفعه الزبائن/);
  // The best-sellers' revenue is line totals before the coupon — and says so.
  assert.match(analytics, /'المبيعات قبل الخصم', 'Revenue before coupons'/);
});

// ------------------------------------------------------------------- F7 + F8

test('F7: a store order delivered asks «أكّد الاستلام», promises no points, and opens the order', async () => {
  const { raw, db } = storeWorld();
  const { m, product } = await openStore(db);
  const id = await buyStoreOrder(db, product, 'f7-order-1');
  await deliverStoreOrder(m, id);
  await settle();
  const n = notes(raw, 'buyer').find((x) => x.event_key === `order.status.delivered:${id}`);
  assert.ok(n, 'the delivered notice was written');
  assert.match(n.title_ar, /استلمت طلبك؟ أكّد الاستلام/);
  assert.match(n.title_en, /Got your order\? Confirm receipt/);
  assert.doesNotMatch(`${n.title_ar} ${n.title_en}`, /نقاط|points/i);
  assert.equal(n.link, `/orders/${id}`);
});

test('F8: confirming receipt while a support ticket is open records the receipt and keeps the money frozen', async () => {
  const { raw, db } = storeWorld();
  const { m, product } = await openStore(db);
  const id = await buyStoreOrder(db, product, 'f8-order-1');
  await deliverStoreOrder(m, id);
  const b = buyerApp(db);
  const t = await post(b, '/api/support/tickets', { confirm: true, subject: 'Broken item', body: 'Arrived broken', order_id: id, idempotencyKey: 'f8-ticket-1' });
  assert.ok([200, 201].includes(t.status), JSON.stringify(await json(t)));
  await settle();
  const cr = await json(await post(b, `/api/orders/${id}/confirm-receipt`, {}));
  assert.equal(cr.success, true, JSON.stringify(cr));
  assert.equal(cr.released, false, 'no release while the ticket is open');
  assert.ok(row<{ receipt_confirmed_at: string | null }>(raw, 'SELECT receipt_confirmed_at FROM orders WHERE id = ?', id)!.receipt_confirmed_at);
  const money = (await json(await get(m, '/api/merchant/finance/summary'))).summary;
  assert.equal(money.available, 0);
  assert.ok(money.pending > 0 && money.pending_frozen === money.pending, 'the whole credit is pending and frozen');
});

// ------------------------------------------------------------------- F11

test('F11: a failed payout and a claw-back into a negative balance both reach the merchant', async () => {
  const { raw, db } = storeWorld();
  const { m, product } = await openStore(db);
  const id = await buyStoreOrder(db, product, 'f11-order-1', 2);
  await deliverStoreOrder(m, id);
  await post(buyerApp(db), `/api/orders/${id}/confirm-receipt`, {});
  await settle();
  const methods = (await json(await get(m, '/api/merchant/payouts'))).methods;
  const adm = storeAdminApp(db);

  // A payout the admin fails.
  const p1 = (await json(await post(m, '/api/merchant/payouts', { amount_iqd: 5_000, idempotencyKey: 'f11-payout-1', channel: methods[0].id, account: '0770000' }))).payout;
  const fail = await post(adm, `/api/admin/community/payouts/${p1.id}/fail`, { reason: 'wrong card number' });
  assert.equal(fail.status, 200, JSON.stringify(await json(fail)));
  const failed = notes(raw, 'ali').filter((n) => n.kind === 'payout_failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].link, /\/money$/);

  // A payout paid, then the order refunded after release → the balance goes negative.
  const p2 = (await json(await post(m, '/api/merchant/payouts', { amount_iqd: 20_000, idempotencyKey: 'f11-payout-2', channel: methods[0].id, account: '0770000' }))).payout;
  await post(adm, `/api/admin/community/payouts/${p2.id}/approve`, {});
  await post(adm, `/api/admin/community/payouts/${p2.id}/paid`, { reference: 'TRX-1' });
  assert.equal((await patch(adm, `/api/admin/orders/${id}`, { status: 'shipped' })).status, 200);
  const cn = await patch(adm, `/api/admin/orders/${id}`, { status: 'cancelled', adminNote: 'refund' });
  assert.equal(cn.status, 200, JSON.stringify(await json(cn)));
  await settle();
  const available = (await json(await get(m, '/api/merchant/finance/summary'))).summary.available;
  assert.ok(available < 0, `available is ${available}`);
  const neg = notes(raw, 'ali').filter((n) => n.kind === 'balance_reversed');
  assert.equal(neg.length, 1);
  assert.match(neg[0].title_ar, /رصيدك سالب .* — ستُخصم من مبيعاتك القادمة/);
  assert.match(neg[0].title_en, new RegExp((-available).toLocaleString('en-US')));
  // Both kinds are the store's: the notification centre lists them.
  const feed = (await json(await get(m, '/api/merchant/notifications/feed'))).notifications.map((n: { kind: string }) => n.kind);
  assert.ok(feed.includes('payout_failed') && feed.includes('balance_reversed'));
});

// ------------------------------------------------------------------- F12

test('F12: coupon codes and a customer cancel after confirmation refuse with stable codes', async () => {
  const { db } = storeWorld();
  const { m, product } = await openStore(db);
  const dup = await post(m, '/api/merchant/coupons', { code: 'TEN', kind: 'percent', value: 5 });
  assert.equal(dup.status, 409);
  assert.equal((await json(dup)).code, 'COUPON_CODE_TAKEN');
  const bad = await post(m, '/api/merchant/coupons', { code: 'x', kind: 'percent', value: 5 });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'BAD_COUPON_CODE');

  const id = await buyStoreOrder(db, product, 'f12-order-1');
  await post(m, `/api/merchant/orders/${id}/status`, { status: 'confirmed' });
  const late = await post(buyerApp(db), `/api/orders/${id}/cancel`, {});
  assert.equal(late.status, 400);
  assert.equal((await json(late)).code, 'ORDER_NOT_CANCELLABLE');
});

// ------------------------------------------------------------------- F13

test('F13: an admin walk-back is one timeline event, with its stage', async () => {
  const { db } = storeWorld();
  const { m, product } = await openStore(db);
  const id = await buyStoreOrder(db, product, 'f13-order-1');
  await deliverStoreOrder(m, id);
  const r = await patch(storeAdminApp(db), `/api/admin/orders/${id}`, { status: 'shipped' });
  assert.equal(r.status, 200, JSON.stringify(await json(r)));
  const events = (await json(await get(m, `/api/merchant/orders/${id}/timeline`))).events as Array<{ kind: string; status?: string; stage?: string; actor: string }>;
  const statuses = events.filter((e) => e.kind === 'status');
  assert.equal(statuses.filter((e) => e.stage === '').length, 0, 'no status event without its stage');
  const walked = statuses.filter((e) => e.actor === 'levonis');
  assert.equal(walked.length, 1, 'one walk-back, one event');
  assert.equal(walked[0].status, 'shipped');
  assert.equal(walked[0].stage, 'out_for_delivery');
});

test('F13: DELIVERY_FEE_ABOVE_MAX names the fee(s) over the cap', async () => {
  const { db } = storeWorld();
  const m = merchantApp(db);
  await post(m, '/api/merchant/onboard', { name: 'Ali 3D', slug: 'ali3d', governorate: 'baghdad' });
  const cap = await patch(storeAdminApp(db), '/api/admin/community/settings', { merchantDeliveryFeeMaxIqd: 5_000 });
  assert.equal(cap.status, 200, JSON.stringify(await json(cap)));
  const d0 = await json(await get(m, '/api/merchant/delivery'));
  const res = await put(m, '/api/merchant/delivery', {
    version: d0.profile.version,
    profile: { default_mode: 'fee', default_fee_iqd: 3_000, free_over_iqd: null, pickup_enabled: false, prep_days: 1, note: '' },
    rules: [{ governorate_id: 'basra', mode: 'fee', fee_iqd: 7_000 }, { governorate_id: 'erbil', mode: 'fee', fee_iqd: 4_000 }],
  });
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, 'DELIVERY_FEE_ABOVE_MAX');
  assert.deepEqual(body.details.offending, [{ scope: 'rule', governorate_id: 'basra', field: 'fee_iqd', fee_iqd: 7_000 }]);
});
