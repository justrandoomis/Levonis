/**
 * THE CUSTOM (PRINT-REQUEST) ORDER, AFTER THE END-TO-END REVIEW OF THE LIVE
 * MERCHANT PLATFORM — journey B on the live D1 limits:
 *
 *   F2  an offer whose workshop can no longer make the job is marked on the
 *       customer's list and refused at acceptance (409 OFFER_NOT_ELIGIBLE)
 *       before any money is reserved;
 *   F3  a customer's cancel takes the original file and the customer's
 *       contact away from the merchant; a completed job keeps them;
 *   F4  the lifecycle is told to the other side, once per event: start,
 *       delivered (with the auto-complete date), the customer's cancel, a
 *       merchant's dispute, the admin's decision, and the money it released;
 *   F9  a partial refund is a COMPLETED job counted at the part the merchant
 *       kept, not a `refunded` order the analytics show as 0;
 *   F12 the lifecycle doors refuse with stable codes.
 *
 * Run: node --import tsx --test tests/customOrderReviewFixes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, json, row, all } from './fixtures/app';
import { violations } from './fixtures/d1Limits';
import { seedB, asB, publishedB, acceptedB, MemoryBucket } from './fixtures/reviewE2eWorld';

const notes = (raw: ReturnType<typeof seedB>, user: string) =>
  all<{ kind: string; title_en: string; body_en: string; link: string; event_key: string }>(
    raw,
    'SELECT kind, title_en, body_en, link, event_key FROM user_notifications WHERE user_id = ? ORDER BY created_at, rowid',
    user
  );

// ------------------------------------------------------------------- F2

test('F2: a workshop that can no longer make the job is flagged on the list and refused at acceptance — no hold is taken', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const r = await publishedB(raw, bucket);
  const o = (await json(await post(asB(raw, 'ali'), `/api/marketplace/requests/${r.id}/offers`, { price_iqd: 20_000, completion_days: 3 }))).offer;

  // Before: the offer is a normal, acceptable one.
  const list0 = await json(await get(asB(raw, 'buyer'), `/api/marketplace/requests/${r.id}/offers`));
  assert.equal(list0.offers[0].workshop_unable, false);

  // Ali's only printer goes, through its own route (which re-matches).
  const del = await asB(raw, 'ali').request('/api/merchant/printers/p1', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal(del.status, 200);

  const list = await json(await get(asB(raw, 'buyer'), `/api/marketplace/requests/${r.id}/offers`));
  assert.equal(list.offers[0].id, o.id);
  assert.equal(list.offers[0].workshop_unable, true, 'the customer sees the workshop can no longer make it');

  const holdsBefore = row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE user_id = 'buyer'")!.n;
  const acc = await post(asB(raw, 'buyer'), `/api/marketplace/offers/${o.id}/accept`, { expected_price_iqd: 20_000, offer_revision: 1, address_id: 'a1' });
  const body = await json(acc);
  assert.equal(acc.status, 409);
  assert.equal(body.code, 'OFFER_NOT_ELIGIBLE');
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE user_id = 'buyer'")!.n, holdsBefore, 'nothing was reserved');
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_orders')!.n, 0);
});

test('F2: an offer made by a workshop whose printer is merely offline is refused too (the LIVE verdict, not the stored one)', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const r = await publishedB(raw, bucket);
  const o = (await json(await post(asB(raw, 'ali'), `/api/marketplace/requests/${r.id}/offers`, { price_iqd: 20_000, completion_days: 3 }))).offer;
  // A change no route re-matched: only the acceptance's live verdict sees it.
  raw.exec("UPDATE merchant_printers SET availability = 'offline' WHERE id = 'p1'");
  const acc = await post(asB(raw, 'buyer'), `/api/marketplace/offers/${o.id}/accept`, { expected_price_iqd: 20_000, offer_revision: 1, address_id: 'a1' });
  assert.equal(acc.status, 409);
  assert.equal((await json(acc)).code, 'OFFER_NOT_ELIGIBLE');
  // …and the refusal wrote the verdict back, so the list now says so as well.
  const list = await json(await get(asB(raw, 'buyer'), `/api/marketplace/requests/${r.id}/offers`));
  assert.equal(list.offers[0].workshop_unable, true);
  // Back online: the same offer is accepted.
  raw.exec("UPDATE merchant_printers SET availability = 'available' WHERE id = 'p1'");
  const again = await post(asB(raw, 'buyer'), `/api/marketplace/offers/${o.id}/accept`, { expected_price_iqd: 20_000, offer_revision: 1, address_id: 'a1' });
  assert.equal(again.status, 201, JSON.stringify(await json(again)));
});

// ------------------------------------------------------------------- F3 + F4

test('F3 + F4: the customer cancels — the merchant is told, loses the original file and the customer contact', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket);
  // Engaged: the original file and the contact are the merchant's.
  assert.equal((await get(asB(raw, 'ali', bucket), `/api/marketplace/requests/${a.id}/files/${a.model}`)).status, 200);
  const before = await json(await get(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}`));
  assert.equal(before.contact?.phone, '+9647700000009');

  const c = await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/cancel`);
  assert.equal(c.status, 200, JSON.stringify(await json(c)));

  assert.equal((await get(asB(raw, 'ali', bucket), `/api/marketplace/requests/${a.id}/files/${a.model}`)).status, 404);
  const after = await json(await get(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}`));
  assert.equal(after.order.state, 'cancelled');
  assert.equal(after.contact, null, 'no phone or address after the cancel');
  // The customer still reads their own order.
  assert.equal((await get(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}`)).status, 200);

  const told = notes(raw, 'ali').filter((n) => n.event_key === `custom_order:${a.orderId}:cancelled_by_customer`);
  assert.equal(told.length, 1);
  assert.equal(told[0].kind, 'order_needs_action');
  assert.match(told[0].link, new RegExp(`${a.orderId}$`), 'deep link to the custom order');
  // Replay: the cancel again tells nobody twice.
  await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/cancel`);
  assert.equal(notes(raw, 'ali').filter((n) => n.event_key.includes(':cancelled_by_customer')).length, 1);
});

test('F3: a COMPLETED job keeps the original file for its merchant', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket);
  assert.equal((await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`)).status, 200);
  assert.equal((await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/delivered`)).status, 200);
  assert.equal((await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/confirm`)).status, 200);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', a.orderId)!.state, 'completed');
  assert.equal((await get(asB(raw, 'ali', bucket), `/api/marketplace/requests/${a.id}/files/${a.model}`)).status, 200);
  const view = await json(await get(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}`));
  assert.ok(view.contact, 'the contact stays on a completed job');
});

test('F4: start and delivered reach the customer once each; delivered names «أكّد الاستلام» and the auto-complete date', async () => {
  const raw = seedB();
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityAutoCompleteDays','5')`);
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket);
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`);
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`); // a second tap
  const d = await json(await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/delivered`));

  const mine = notes(raw, 'buyer');
  const started = mine.filter((n) => n.event_key === `custom_order:${a.orderId}:started`);
  const delivered = mine.filter((n) => n.event_key === `custom_order:${a.orderId}:delivered`);
  assert.equal(started.length, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, 'order_update');
  assert.match(delivered[0].title_en, /confirm receipt/i);
  assert.equal(delivered[0].link, `/requests?request=${a.id}`);
  const title_ar = row<{ title_ar: string }>(raw, 'SELECT title_ar FROM user_notifications WHERE event_key = ?', `custom_order:${a.orderId}:delivered`)!.title_ar;
  assert.match(title_ar, /أكّد الاستلام/);
  assert.ok(d.auto_complete_at, 'the owner set five days');
  assert.match(delivered[0].body_en, /completes automatically on \d{1,2} \w+/);
});

test('F4 + F9 + F12: a merchant dispute, then a partial refund — both told, the money announced, the job counted as completed at the kept part', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket, 20_000);
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`);
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/delivered`);
  const d = await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/dispute`, { description: 'Customer is not answering the phone' });
  assert.equal(d.status, 201);
  const complaintId = (await json(d)).complaint_id;
  assert.equal(notes(raw, 'buyer').filter((n) => n.event_key === `custom_order:${a.orderId}:dispute:${complaintId}`).length, 1, 'the customer hears of the merchant\'s dispute');

  // F12: confirming a disputed order is a stable code.
  const cf = await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/confirm`);
  assert.equal(cf.status, 409);
  assert.equal((await json(cf)).code, 'CUSTOM_ORDER_CANNOT_CONFIRM');

  const res = await post(asB(raw, 'boss'), `/api/admin/community/escrows/${a.escrowId}/resolve`, { decision: 'partial_refund', amount_iqd: 10_000, reason: 'half delivered' });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  // F9: completed, with the escrow's own state as the partial flag.
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', a.orderId)!.state, 'completed');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', a.escrowId)!.state, 'partially_refunded');

  // F4: both sides told once; the merchant hears the money that reached them.
  const ali = notes(raw, 'ali');
  assert.equal(ali.filter((n) => n.kind === 'dispute_resolved').length, 1);
  const credited = row<{ n: number }>(raw, "SELECT COALESCE(SUM(amount_iqd),0) AS n FROM merchant_ledger_entries WHERE escrow_id = ? AND kind IN ('escrow_release','commission')", a.escrowId)!.n;
  // F5 (owner decision): the order's 5% on the 10,000 the merchant KEPT — its
  // own commission line — and 9,500 to the merchant. It used to be 0 and 10,000.
  const lines = all<{ kind: string; amount_iqd: number }>(raw, 'SELECT kind, amount_iqd FROM merchant_ledger_entries WHERE escrow_id = ? ORDER BY kind', a.escrowId);
  assert.deepEqual(lines.map((l) => ({ ...l })), [
    { kind: 'commission', amount_iqd: -500 },
    { kind: 'escrow_release', amount_iqd: 10_000 },
  ]);
  assert.equal(credited, 9_500);
  const avail = ali.filter((n) => n.kind === 'payout_available');
  assert.equal(avail.length, 1);
  assert.match(avail[0].title_en, new RegExp(credited.toLocaleString('en-US')));
  assert.equal(notes(raw, 'buyer').filter((n) => n.event_key === `custom_order:${a.orderId}:resolved:partial_refund`).length, 1);

  // A replayed decision tells nobody twice.
  const again = await post(asB(raw, 'boss'), `/api/admin/community/escrows/${a.escrowId}/resolve`, { decision: 'partial_refund', amount_iqd: 10_000, reason: 'half delivered' });
  assert.equal((await json(again)).replayed, true);
  assert.equal(notes(raw, 'ali').filter((n) => n.kind === 'dispute_resolved' || n.kind === 'payout_available').length, 2);

  // F9: the analytics count the job, at the part the merchant kept (= the ledger).
  const lifetime = await json(await get(asB(raw, 'ali'), '/api/merchant/analytics'));
  assert.deepEqual(lifetime.custom_orders, { completed: 1, receivable_iqd: credited });
  const report = await json(await get(asB(raw, 'ali'), '/api/merchant/analytics/report'));
  const requests = report.requests ?? report.report?.requests;
  assert.equal(requests.custom_orders_completed, 1);
  assert.equal(requests.custom_orders_receivable_iqd, credited);
  // The kept part keeps the file; the job was not undone.
  assert.equal((await get(asB(raw, 'ali', bucket), `/api/marketplace/requests/${a.id}/files/${a.model}`)).status, 200);
  assert.deepEqual(violations, []);
});

test('F4: a full refund by the admin tells both sides and announces no money', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket);
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`);
  await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/dispute`, { description: 'The workshop stopped answering' });
  const res = await post(asB(raw, 'boss'), `/api/admin/community/escrows/${a.escrowId}/resolve`, { decision: 'refund', reason: 'no delivery' });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_orders WHERE id = ?', a.orderId)!.state, 'refunded');
  assert.equal(notes(raw, 'ali').filter((n) => n.kind === 'dispute_resolved').length, 1);
  assert.equal(notes(raw, 'ali').filter((n) => n.kind === 'payout_available').length, 0);
  assert.equal(notes(raw, 'buyer').filter((n) => n.event_key === `custom_order:${a.orderId}:resolved:refund`).length, 1);
  // Fully refunded: the file goes back with the money.
  assert.equal((await get(asB(raw, 'ali', bucket), `/api/marketplace/requests/${a.id}/files/${a.model}`)).status, 404);
});

test('F12: the lifecycle doors refuse with stable codes', async () => {
  const raw = seedB();
  const bucket = new MemoryBucket();
  const a = await acceptedB(raw, bucket);
  const del = await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/delivered`);
  assert.equal(del.status, 409);
  assert.equal((await json(del)).code, 'CUSTOM_ORDER_CANNOT_DELIVER');
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`);
  const start = await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/start`);
  assert.equal(start.status, 409, 'a second start meets an order already in progress');
  assert.equal((await json(start)).code, 'CUSTOM_ORDER_CANNOT_START');
  const cancel = await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/cancel`);
  assert.equal(cancel.status, 409);
  assert.equal((await json(cancel)).code, 'CUSTOM_ORDER_CANCEL_NEEDS_DISPUTE');
  await post(asB(raw, 'ali'), `/api/marketplace/orders/${a.orderId}/delivered`);
  await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/confirm`);
  const cancelDone = await post(asB(raw, 'buyer'), `/api/marketplace/orders/${a.orderId}/cancel`);
  assert.equal(cancelDone.status, 409);
  assert.equal((await json(cancelDone)).code, 'CUSTOM_ORDER_CANNOT_CANCEL');
});

test('F5: the commission on a partial refund is the order\'s rate on the KEPT gross, rounded to the dinar', async () => {
  const { partialRefundCommission } = await import('../worker/lib/escrowOps');
  assert.equal(partialRefundCommission(10_000, 500, 1_000, 20_000), 500);
  assert.equal(partialRefundCommission(10_010, 500, 0, 0), 501, '500.5 rounds up');
  assert.equal(partialRefundCommission(10_009, 500, 0, 0), 500, '500.45 rounds down');
  assert.equal(partialRefundCommission(30_000, 1000, 5_000, 50_000), 3_000);
  // No stored rate: the order's own fee, in proportion (10% here).
  assert.equal(partialRefundCommission(30_000, 0, 5_000, 50_000), 3_000);
  assert.equal(partialRefundCommission(0, 500, 1_000, 20_000), 0);
});
