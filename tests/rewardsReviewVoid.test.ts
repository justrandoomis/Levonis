/**
 * A REVIEW CODE DIES WITH ITS PRINTER (owner, 2026-11-09; DECISIONS row 303 R1; rewards policy 8.16).
 *
 * The integration run reviewed a printer, approved it at 100, resolved a full refund of the printer,
 * and then wrote the code: it opened every level, and a 320,000 gift went to the cart for delivery
 * only. Now, once the reviewed printer went back with a refund or its order was cancelled — by the
 * printers' own «returned» (worker/lib/rewards/earning.ts) — the code door refuses with its own code
 * (GIFT_CODE_VOID, with why), the customer's printers stop offering the code and say why, the team's
 * queue says the code is void and why, no new code is made for it, and a gift the code already
 * opened and nobody ordered is cancelled when the return resolves, or when the printer's order is
 * cancelled by any door from any state (the integration re-verifier's R1-cancel: a delivered order is
 * walked back to «shipped» first, so the team's guard on «delivered» never ran), and «هداياي» says
 * why. A gift ordered before its printer went back stays, until its OWN order is cancelled: then it
 * goes too, by every door, instead of coming back to be ordered again for delivery only (round 2's
 * major; the lead's L1, 2026-11-09). Real migrations, real routers.
 *
 * Run: node --import tsx --test tests/rewardsReviewVoid.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../src/LanguageContext';
import { all, asD1, count, row, stubApp, type Mount } from './fixtures/app';
import { BOSS, BUYER, NOZZLE_04_RED, PLAIN, addGiftToCart, addLevelItem, choose, get, grantOk, grantProduct, json, mountGifts, patch, placeOrder, post, redeem, type J } from './fixtures/giftWorld';
import { DAY, envOf, looseRow, printerOrder, rewardsWorld } from './fixtures/rewardsWorld';
import { rewardProgramRoutes } from '../worker/routes/rewardsProgram';
import { newGiftCode, reviewPrinterVoid, voidReviewGiftsOfLine, voidReviewGiftsOfOrder, PRINTER_RETURNED_CANCEL } from '../worker/lib/gifts/reviewCode';
import { slotJoins, slotReturnedSql, slotStoppedSql } from '../worker/lib/rewards/earning';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { sweepExpiredOrders } from '../worker/lib/orderExpirySweep';
import { COPY } from '../src/components/rewards/copy';
import { doorLines, nextAction } from '../src/components/rewards/model';
import type { RewardsHubData } from '../src/components/rewards/types';
import { reviewGiftText } from '../src/components/adminReviews/reviewGiftStrings';
import { adminText } from '../src/components/adminGifts/strings';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import GiftCard, { type GiftView } from '../src/components/reviews/gifts/GiftCard';
import { giftText, type GiftLang } from '../src/components/reviews/gifts/giftStrings';

const NOW = Date.parse('2026-11-05T09:00:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const src = (file: string) => readFileSync(file, 'utf8');

const mount: Mount = (a) => {
  mountGifts(a);
  a.route('/api/rewards/program', rewardProgramRoutes);
};

/**
 * The buyer's printer line of `qty`, a gift on level 1, and the buyer's review of it approved at 26 with a code
 * the team handed over — written as the approval writes it (tests/reviewGiftCode.test.ts walks that road).
 */
async function codedPrinter(qty = 1) {
  const raw = rewardsWorld(NOW);
  const { orderId, itemId } = await printerOrder(raw, qty, at(0));
  const db = asD1(raw);
  const buyer = stubApp(db, BUYER, mount, { publishV2: 'always' });
  const admin = stubApp(db, BOSS, mount, { publishV2: 'always' });
  const item = await addLevelItem(admin, 1, NOZZLE_04_RED);
  const code = newGiftCode();
  looseRow(raw, 'reviews', {
    id: 'rv_1', user_id: 'buyer', product_id: 'p_printer', order_id: orderId, order_item_id: itemId, stars: 5,
    body: 'A real review of the printer, its noise and its first layer.', media: '[]', status: 'published', source: 'user', quality_summary: '{}',
  });
  looseRow(raw, 'review_rewards', {
    id: 'rr_1', review_id: 'rv_1', user_id: 'buyer', kind: 'printer_gift', state: 'approved', final_score: 26, redeem_code: code,
    code_issued_at: at(1), reason: 'Clear and useful.', decided_by: 'boss', decided_at: at(1), quality_snapshot: '{}', eligibility: '{}', instagram_evidence: '',
  });
  return { raw, db, buyer, admin, orderId, itemId, code, item };
}

const printerOf = async (app: ReturnType<typeof stubApp>): Promise<J> =>
  (await json(await get(app, '/api/rewards/program'))).printers.find((p: J) => p.product_id === 'p_printer');

/** A refund the returns desk resolved for `qty` printers of the line. */
const refund = (raw: DatabaseSync, orderId: string, itemId: string, qty: number, id = 'rc_1') =>
  looseRow(raw, 'return_cases', { id, order_id: orderId, order_item_id: itemId, user_id: 'buyer', state: 'resolved', resolution: 'refund', qty });

// ------------------------------------------------------------------ the code door

test('a refunded printer’s code opens no gift: GIFT_CODE_VOID with why, to its owner only; the printers stop offering it and say why', async () => {
  const w = await codedPrinter();
  const before = await printerOf(w.buyer);
  assert.equal(before.state, 'code_ready');
  assert.equal(before.code_void, null);

  refund(w.raw, w.orderId, w.itemId, 1);
  const after = await printerOf(w.buyer);
  assert.equal(after.state, 'rated', 'nothing to write: the code is not offered');
  assert.equal(after.code_void, 'returned', 'and the row says why');

  const res = await post(w.buyer, '/api/rewards/program/gift-code', { code: w.code });
  const out = await json(res);
  assert.equal(res.status, 409, JSON.stringify(out));
  assert.equal(out.code, 'GIFT_CODE_VOID');
  assert.equal(out.details?.reason ?? out.reason, 'returned');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements WHERE reward_id = ?', 'rr_1'), 0, 'no gift is born');
  assert.equal(row<{ at: string | null }>(w.raw, 'SELECT code_redeemed_at AS at FROM review_rewards WHERE id = ?', 'rr_1')!.at, null, 'and the code is not stamped');

  // Someone else typing it learns nothing: the one sentence of every wrong code.
  const stranger = stubApp(w.db, { id: 'other', role: 'customer', email: 'other@x.co' }, mount, { publishV2: 'always' });
  const theirs = await post(stranger, '/api/rewards/program/gift-code', { code: w.code });
  assert.equal(theirs.status, 404);
  assert.equal((await json(theirs)).code, 'GIFT_CODE_INVALID');

  // The hub: no «أدخل الكود» card, and the rate door says why once nothing else waits.
  const hub = (await json(await get(w.buyer, '/api/rewards/program'))) as unknown as RewardsHubData;
  assert.notEqual(nextAction(hub)?.kind, 'gift-code');
  assert.deepEqual(doorLines(hub).rate.lines, [{ key: 'door.rate.void.returned' }]);
});

test('a cancelled order voids the code too, and says so in its own words', async () => {
  const w = await codedPrinter();
  w.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(w.orderId);
  assert.equal((await reviewPrinterVoid(w.db, ['rv_1'])).get('rv_1'), 'cancelled');
  const out = await json(await post(w.buyer, '/api/rewards/program/gift-code', { code: w.code }));
  assert.equal(out.code, 'GIFT_CODE_VOID');
  assert.equal(out.details?.reason ?? out.reason, 'cancelled');
  // The printer stays on «قيّم طابعتك» while its review holds that reward, so the page can say why.
  const row = await printerOf(w.buyer);
  assert.equal(row?.state, 'rated');
  assert.equal(row?.code_void, 'cancelled');
  // An order cancelled with no approved review on it lists nothing new.
  const plain = await codedPrinter();
  plain.raw.prepare("UPDATE review_rewards SET state = 'rejected' WHERE id = 'rr_1'").run();
  plain.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(plain.orderId);
  assert.equal(await printerOf(plain.buyer), undefined);
});

test('the printers’ own «returned» decides: a device closed by a return voids it, another closure does not, and a line of two keeps its code while one printer stays', async () => {
  const w = await codedPrinter();
  w.raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'owner_override' WHERE order_id = ?").run(at(2), w.orderId);
  assert.equal((await reviewPrinterVoid(w.db, ['rv_1'])).get('rv_1'), undefined, 'a warranty closed for another reason is still the customer’s printer');
  w.raw.prepare("UPDATE order_item_units SET warranty_closed_reason = 'returned' WHERE order_id = ?").run(w.orderId);
  assert.equal((await reviewPrinterVoid(w.db, ['rv_1'])).get('rv_1'), 'returned', 'the device went back');

  const two = await codedPrinter(2);
  refund(two.raw, two.orderId, two.itemId, 1);
  assert.equal((await reviewPrinterVoid(two.db, ['rv_1'])).get('rv_1'), undefined, 'one of two refunded: the other is still theirs');
  assert.equal((await printerOf(two.buyer)).state, 'code_ready');
  refund(two.raw, two.orderId, two.itemId, 1, 'rc_2');
  assert.equal((await reviewPrinterVoid(two.db, ['rv_1'])).get('rv_1'), 'returned', 'both gone');

  // A line with no unit rows is judged by its refunds alone: a missing row never voids a code.
  const bare = await codedPrinter();
  bare.raw.prepare('DELETE FROM order_item_units WHERE order_id = ?').run(bare.orderId);
  assert.equal((await reviewPrinterVoid(bare.db, ['rv_1'])).get('rv_1'), undefined);
  refund(bare.raw, bare.orderId, bare.itemId, 1);
  assert.equal((await reviewPrinterVoid(bare.db, ['rv_1'])).get('rv_1'), 'returned');
});

test('slotReturnedSql is the printers’ «returned», slot by slot, wherever the slot is neither traded in nor in the shop', async () => {
  const raw = rewardsWorld(NOW);
  const { orderId, itemId } = await printerOrder(raw, 2, at(0));
  const read = () =>
    all<{ unit_index: number; stopped: string | null; returned: number }>(
      raw,
      `SELECT d.unit_index, ${slotStoppedSql({ now: '?1', months: '?2' })} AS stopped, ${slotReturnedSql()} AS returned
         FROM (SELECT u.*, 0 AS week FROM order_item_units u WHERE u.replacement_of_unit_id IS NULL) AS d
         ${slotJoins()}
        WHERE d.order_id = ?3 ORDER BY d.unit_index`,
      at(1),
      '12',
      orderId
    );
  const agree = (why: string) => {
    const rows = read();
    assert.equal(rows.length, 2, why);
    for (const r of rows) {
      if (r.stopped === 'traded_in' || r.stopped === 'in_shop') continue;
      assert.equal(r.returned === 1, r.stopped === 'returned', `${why}: unit ${r.unit_index} reads ${r.stopped} but returned=${r.returned}`);
    }
    return rows;
  };
  assert.deepEqual(agree('both held').map((r) => r.returned), [0, 0]);
  looseRow(raw, 'return_cases', { id: 'rc_s', order_id: orderId, order_item_id: itemId, user_id: 'buyer', state: 'resolved', resolution: 'refund', qty: 1 });
  assert.deepEqual(agree('one refunded, no unit named').map((r) => r.returned), [0, 1], 'the highest slot is the one the refund took');
  raw.prepare('DELETE FROM return_cases').run();
  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'returned' WHERE order_id = ? AND unit_index = 1").run(at(0.5), orderId);
  assert.deepEqual(agree('the first closed by a return').map((r) => r.returned), [1, 0]);
  raw.prepare("UPDATE order_item_units SET warranty_closed_reason = 'owner_override' WHERE order_id = ? AND unit_index = 1").run(orderId);
  assert.deepEqual(agree('the first closed for another reason').map((r) => r.returned), [0, 0]);
});

// ------------------------------------------------------------------ the gift it opened

test('a gift the code opened and nobody ordered is cancelled when the return resolves, cart line and all; once; an ordered one stays', async () => {
  const w = await codedPrinter();
  const opened = await json(await post(w.buyer, '/api/rewards/program/gift-code', { code: w.code }));
  assert.ok(opened.gift?.id, JSON.stringify(opened));
  const giftId = opened.gift.id as string;
  assert.equal((await choose(w.buyer, giftId, w.item.id)).status, 200);
  assert.equal((await redeem(w.buyer, giftId)).status, 200);
  assert.equal((await addGiftToCart(w.buyer, giftId)).status, 200);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', giftId), 1);

  // Before the printer goes, the hook moves nothing.
  assert.deepEqual(await voidReviewGiftsOfLine(envOf(w.raw), { orderItemId: w.itemId, actorId: 'boss', ref: 'return:rc_0' }), { cancelled: [] });

  refund(w.raw, w.orderId, w.itemId, 1);
  const out = await voidReviewGiftsOfLine(envOf(w.raw), { orderItemId: w.itemId, actorId: 'boss', ref: 'return:rc_1' }, at(3));
  assert.deepEqual(out, { cancelled: [giftId] });
  const g = row<{ state: string; cancel_reason: string; cancelled_by: string }>(w.raw, 'SELECT state, cancel_reason, cancelled_by FROM gift_entitlements WHERE id = ?', giftId)!;
  assert.deepEqual(g, { state: 'cancelled', cancel_reason: PRINTER_RETURNED_CANCEL, cancelled_by: 'boss' });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', giftId), 0, 'its cart line went with it');
  assert.ok(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.cancel' AND target = ?", giftId) >= 1, 'with its audit row');
  assert.deepEqual(await voidReviewGiftsOfLine(envOf(w.raw), { orderItemId: w.itemId, actorId: 'boss', ref: 'return:rc_1' }), { cancelled: [] }, 'twice cancels nothing more');
  const after = await printerOf(w.buyer);
  assert.equal(after.state, 'rated');
  assert.equal(after.code_void, 'returned');
  // A replay of the code says why, not «used»: the printer left.
  assert.equal((await json(await post(w.buyer, '/api/rewards/program/gift-code', { code: w.code }))).code, 'GIFT_CODE_VOID');

  // An ordered gift stays what it is: chapter 13 is the remedy, not this hook.
  const o = await codedPrinter();
  const g2 = (await json(await post(o.buyer, '/api/rewards/program/gift-code', { code: o.code }))).gift.id as string;
  await choose(o.buyer, g2, o.item.id);
  await redeem(o.buyer, g2);
  await addGiftToCart(o.buyer, g2);
  await placeOrder(o.buyer);
  assert.equal(row<{ state: string }>(o.raw, 'SELECT state FROM gift_entitlements WHERE id = ?', g2)!.state, 'ordered');
  refund(o.raw, o.orderId, o.itemId, 1);
  assert.deepEqual(await voidReviewGiftsOfLine(envOf(o.raw), { orderItemId: o.itemId, actorId: 'boss', ref: 'return:rc_1' }), { cancelled: [] });
  const kept = await printerOf(o.buyer);
  assert.equal(kept.gift.status, 'ORDERED');
  assert.equal(kept.code_void, null, 'the row keeps saying the gift was ordered');
});

test('the returns desk runs the hook beside the coupons’ own', () => {
  const returns = src('worker/routes/returns.ts');
  const coupons = returns.indexOf('await revokeRewardsForReturn(c.env, { caseId: id, orderItemId: kase.order_item_id, qty: kase.qty });');
  const gifts = returns.indexOf("await voidReviewGiftsOfLine(c.env, { orderItemId: kase.order_item_id, actorId: admin.id, ref: `return:${id}` }, nowIso);");
  assert.ok(coupons > 0 && gifts > coupons, 'after the coupons, in the same refund branch');
});

// ------------------------------------------------------------------ the order cancelled by the team

/**
 * The integration re-verifier's road (R1-cancel): the printer delivered for real — its stage too, as the
 * courier or the team leaves it — reviewed, approved, its code written and a gift chosen, redeemed and put
 * in the cart. Only then does the team cancel the printer's order.
 */
async function giftInCartOfDelivered() {
  const w = await codedPrinter();
  w.raw.prepare("UPDATE orders SET stage = 'delivered' WHERE id = ?").run(w.orderId);
  const opened = await json(await post(w.buyer, '/api/rewards/program/gift-code', { code: w.code }));
  assert.ok(opened.gift?.id, JSON.stringify(opened));
  const giftId = opened.gift.id as string;
  assert.equal((await choose(w.buyer, giftId, w.item.id)).status, 200);
  assert.equal((await redeem(w.buyer, giftId)).status, 200);
  assert.equal((await addGiftToCart(w.buyer, giftId)).status, 200);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', giftId), 1);
  return { ...w, giftId };
}

/** The gift went with its printer: cancelled for that reason, its cart line gone, one audit row naming the cancelled order. */
async function goneWithItsPrinter(w: Awaited<ReturnType<typeof giftInCartOfDelivered>>, by = 'boss') {
  const g = row<{ state: string; cancel_reason: string; cancelled_by: string }>(w.raw, 'SELECT state, cancel_reason, cancelled_by FROM gift_entitlements WHERE id = ?', w.giftId)!;
  assert.deepEqual(g, { state: 'cancelled', cancel_reason: PRINTER_RETURNED_CANCEL, cancelled_by: by });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', w.giftId), 0, 'its cart line went with it');
  const audits = all<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'gift.cancel' AND target = ?", w.giftId);
  assert.equal(audits.length, 1, 'one audit row, however many doors ran');
  const detail = JSON.parse(audits[0].detail) as Record<string, unknown>;
  assert.equal(detail.reason, PRINTER_RETURNED_CANCEL);
  assert.equal(detail.printer, 'cancelled');
  assert.equal(detail.ref, `order_cancelled:${w.orderId}`);
  // The customer's side: the printer says why, and the cart holds no gift to order for delivery only.
  const printer = await printerOf(w.buyer);
  assert.equal(printer.state, 'rated');
  assert.equal(printer.code_void, 'cancelled');
  const mine = (await json(await get(w.buyer, '/api/gifts'))).gifts.find((x: J) => x.id === w.giftId);
  assert.equal(mine.status, 'CANCELLED');
  assert.equal(mine.cancel_why, 'printer_returned', '«هداياي» can say why');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ? AND gift_entitlement_id IS NOT NULL', 'buyer'), 0);
  // Once: the hook again finds nothing to cancel, and writes nothing.
  assert.deepEqual(await voidReviewGiftsOfOrder(envOf(w.raw), { orderId: w.orderId, actorId: 'boss', ref: `order_cancelled:${w.orderId}` }), { cancelled: [] });
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.cancel' AND target = ?", w.giftId), 1);
}

test('R1: the team cancelling a once-delivered printer’s order through the status door (delivered → shipped → cancelled) cancels the gift its code opened, cart line and all, once', async () => {
  const w = await giftInCartOfDelivered();
  const back = await patch(w.admin, `/api/admin/orders/${w.orderId}`, { status: 'shipped' });
  assert.equal(back.status, 200, JSON.stringify(await json(back)));
  assert.equal(row<{ state: string }>(w.raw, 'SELECT state FROM gift_entitlements WHERE id = ?', w.giftId)!.state, 'redeemed', 'a walk back from delivered is no cancellation');
  const cancel = await patch(w.admin, `/api/admin/orders/${w.orderId}`, { status: 'cancelled' });
  assert.equal(cancel.status, 200, JSON.stringify(await json(cancel)));
  assert.equal(row<{ status: string }>(w.raw, 'SELECT status FROM orders WHERE id = ?', w.orderId)!.status, 'cancelled');
  await goneWithItsPrinter(w);
});

test('R1: the same through the stage door (delivered → out for delivery → cancelled), once', async () => {
  const w = await giftInCartOfDelivered();
  const back = await patch(w.admin, `/api/admin/orders/${w.orderId}/stage`, { stage: 'out_for_delivery' });
  assert.equal(back.status, 200, JSON.stringify(await json(back)));
  const cancel = await patch(w.admin, `/api/admin/orders/${w.orderId}/stage`, { stage: 'cancelled' });
  assert.equal(cancel.status, 200, JSON.stringify(await json(cancel)));
  assert.equal(row<{ status: string }>(w.raw, 'SELECT status FROM orders WHERE id = ?', w.orderId)!.status, 'cancelled');
  await goneWithItsPrinter(w);
});

test('R1: and through the customer’s own cancel, when the team walked the order back to pending first', async () => {
  const w = await giftInCartOfDelivered();
  for (const status of ['shipped', 'pending']) {
    const res = await patch(w.admin, `/api/admin/orders/${w.orderId}`, { status });
    assert.equal(res.status, 200, JSON.stringify(await json(res)));
  }
  const cancel = await post(w.buyer, `/api/orders/${w.orderId}/cancel`, {});
  assert.equal(cancel.status, 200, JSON.stringify(await json(cancel)));
  await goneWithItsPrinter(w, 'buyer');
});

test('R1: and when the courier’s sync reports the delivered order cancelled (the stage machine, forced, nobody signed in): the system cancels it', async () => {
  const w = await giftInCartOfDelivered();
  const moved = await moveOrderStage(envOf(w.raw), { orderId: w.orderId, to: 'cancelled', source: 'delivery_api', changedBy: '', note: 'courier: returned to sender', force: true });
  assert.equal(moved.moved, true, JSON.stringify(moved));
  assert.equal(row<{ status: string }>(w.raw, 'SELECT status FROM orders WHERE id = ?', w.orderId)!.status, 'cancelled');
  await goneWithItsPrinter(w, 'system');
});

test('R1: a cancelled order takes only what 8.16 names — an ordered gift stays while its own order stands, and an order with neither reads nothing', async () => {
  const o = await codedPrinter();
  const g = (await json(await post(o.buyer, '/api/rewards/program/gift-code', { code: o.code }))).gift.id as string;
  await choose(o.buyer, g, o.item.id);
  await redeem(o.buyer, g);
  await addGiftToCart(o.buyer, g);
  const giftOrder = await placeOrder(o.buyer);
  assert.equal(row<{ state: string }>(o.raw, 'SELECT state FROM gift_entitlements WHERE id = ?', g)!.state, 'ordered');
  for (const status of ['shipped', 'cancelled']) {
    const res = await patch(o.admin, `/api/admin/orders/${o.orderId}`, { status });
    assert.equal(res.status, 200, JSON.stringify(await json(res)));
  }
  assert.equal(row<{ state: string }>(o.raw, 'SELECT state FROM gift_entitlements WHERE id = ?', g)!.state, 'ordered', 'chapter 13 is its remedy');
  assert.equal(count(o.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.cancel' AND target = ?", g), 0);
  // While the gift's own order stands the gift is ordered, and the hook leaves it there whichever order it reads.
  assert.deepEqual(await voidReviewGiftsOfOrder(envOf(o.raw), { orderId: String(giftOrder.id), actorId: 'boss', ref: 'x' }), { cancelled: [] });
  assert.equal(row<{ state: string }>(o.raw, 'SELECT state FROM gift_entitlements WHERE id = ?', g)!.state, 'ordered');
  // Restated for L1 (the lead, 2026-11-09; round 2's major): this said cancelling the gift's own order was «the gift
  // road's business, not this hook's», and the road handed the gift back to be ordered again for delivery only. Now
  // that order cancelled takes the gift with it, because its code died with its printer's cancelled order.
  const gone = await patch(o.admin, `/api/admin/orders/${giftOrder.id}`, { status: 'cancelled' });
  assert.equal(gone.status, 200, JSON.stringify(await json(gone)));
  assert.deepEqual(row(o.raw, 'SELECT state, cancel_reason FROM gift_entitlements WHERE id = ?', g), { state: 'cancelled', cancel_reason: PRINTER_RETURNED_CANCEL });
  const audits = all<{ detail: string }>(o.raw, "SELECT detail FROM audit_log WHERE action = 'gift.cancel' AND target = ?", g);
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0].detail).printer, 'cancelled', 'its printer’s order was cancelled');
  assert.equal(JSON.parse(audits[0].detail).ref, `order_cancelled:${giftOrder.id}`);
  assert.deepEqual(await voidReviewGiftsOfOrder(envOf(o.raw), { orderId: 'ORD-NONE', actorId: 'boss', ref: 'x' }), { cancelled: [] });
});

// ------------------------------------------------------------------ the gift's own order cancelled (L1)

const stateOf = (raw: DatabaseSync, giftId: string) => row<{ state: string }>(raw, 'SELECT state FROM gift_entitlements WHERE id = ?', giftId)!.state;

/**
 * ROUND 2'S MAJOR (the lead's L1, 2026-11-09; policy 8.16). The gift was ordered while its printer was the
 * customer's; the returns desk then refunded the printer, and the ordered gift stayed (8.16). Only then is the
 * GIFT'S own order cancelled, by the customer or by the team: the gift trigger (0175) put it back to «redeemed»,
 * and the customer ordered it again for delivery only. Now it goes with its printer.
 */
async function giftOrderedThenPrinterRefunded() {
  const w = await codedPrinter();
  const giftId = (await json(await post(w.buyer, '/api/rewards/program/gift-code', { code: w.code }))).gift.id as string;
  assert.equal((await choose(w.buyer, giftId, w.item.id)).status, 200);
  assert.equal((await redeem(w.buyer, giftId)).status, 200);
  assert.equal((await addGiftToCart(w.buyer, giftId)).status, 200);
  const giftOrderId = String((await placeOrder(w.buyer)).id);
  refund(w.raw, w.orderId, w.itemId, 1);
  // The returns desk's own hook: an ordered gift stays (8.16), and «قيّم طابعتك» says it was ordered.
  assert.deepEqual(await voidReviewGiftsOfLine(envOf(w.raw), { orderItemId: w.itemId, actorId: 'boss', ref: 'return:rc_1' }), { cancelled: [] });
  assert.equal(stateOf(w.raw, giftId), 'ordered');
  assert.equal((await printerOf(w.buyer)).gift.status, 'ORDERED');
  return { ...w, giftId, giftOrderId };
}

/** It went with its printer: cancelled, one audit row naming the gift's own cancelled order, nothing to order again. */
async function notOrderableAgain(w: Awaited<ReturnType<typeof giftOrderedThenPrinterRefunded>>, by: string) {
  assert.equal(row<{ status: string }>(w.raw, 'SELECT status FROM orders WHERE id = ?', w.giftOrderId)!.status, 'cancelled');
  assert.deepEqual(row(w.raw, 'SELECT state, cancel_reason, cancelled_by, order_id FROM gift_entitlements WHERE id = ?', w.giftId), {
    state: 'cancelled',
    cancel_reason: PRINTER_RETURNED_CANCEL,
    cancelled_by: by,
    order_id: null,
  });
  const audits = all<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'gift.cancel' AND target = ?", w.giftId);
  assert.equal(audits.length, 1, 'one audit row');
  const detail = JSON.parse(audits[0].detail) as Record<string, unknown>;
  assert.equal(detail.reason, PRINTER_RETURNED_CANCEL);
  assert.equal(detail.printer, 'returned');
  assert.equal(detail.from, 'redeemed', 'after the order’s own trigger put it back');
  assert.equal(detail.ref, `order_cancelled:${w.giftOrderId}`);
  // The trigger's step stays in the gift's timeline: ordered → redeemed, then cancelled here.
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.order_cancelled' AND target = ?", w.giftId), 1);
  // The customer: «هداياي» says why, the gift cannot go back into the cart, and nothing is left to order.
  const mine = (await json(await get(w.buyer, '/api/gifts'))).gifts.find((x: J) => x.id === w.giftId);
  assert.equal(mine.status, 'CANCELLED');
  assert.equal(mine.cancel_why, 'printer_returned');
  const again = await addGiftToCart(w.buyer, w.giftId);
  assert.equal(again.status, 409, JSON.stringify(await json(again)));
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ?', 'buyer'), 0, 'nothing to order for delivery only');
  const printer = await printerOf(w.buyer);
  assert.equal(printer.state, 'rated');
  assert.equal(printer.code_void, 'returned', '«قيّم طابعتك» says why');
  // Once: the hook again finds nothing to cancel, and writes nothing.
  assert.deepEqual(await voidReviewGiftsOfOrder(envOf(w.raw), { orderId: w.giftOrderId, actorId: 'boss', ref: `order_cancelled:${w.giftOrderId}` }), { cancelled: [] });
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.cancel' AND target = ?", w.giftId), 1);
}

test('L1: the customer cancelling the gift’s own order after its printer was refunded: the gift goes with its printer, once, and is not ordered again', async () => {
  const w = await giftOrderedThenPrinterRefunded();
  const cancel = await post(w.buyer, `/api/orders/${w.giftOrderId}/cancel`, {});
  assert.equal(cancel.status, 200, JSON.stringify(await json(cancel)));
  await notOrderableAgain(w, 'buyer');
});

test('L1: the same when the team cancels the gift’s order, through the status door and the stage door, and when the courier’s sync does', async () => {
  const w = await giftOrderedThenPrinterRefunded();
  // The re-verifier's second road: the team confirmed the gift order, then cancelled it «because the printer went back».
  assert.equal((await patch(w.admin, `/api/admin/orders/${w.giftOrderId}`, { status: 'confirmed' })).status, 200);
  const cancel = await patch(w.admin, `/api/admin/orders/${w.giftOrderId}`, { status: 'cancelled' });
  assert.equal(cancel.status, 200, JSON.stringify(await json(cancel)));
  await notOrderableAgain(w, 'boss');

  const s = await giftOrderedThenPrinterRefunded();
  const staged = await patch(s.admin, `/api/admin/orders/${s.giftOrderId}/stage`, { stage: 'cancelled' });
  assert.equal(staged.status, 200, JSON.stringify(await json(staged)));
  await notOrderableAgain(s, 'boss');

  // And the courier's sync: the stage machine, forced, nobody signed in.
  const c = await giftOrderedThenPrinterRefunded();
  const moved = await moveOrderStage(envOf(c.raw), { orderId: c.giftOrderId, to: 'cancelled', source: 'delivery_api', changedBy: '', note: 'courier: returned to sender', force: true });
  assert.equal(moved.moved, true, JSON.stringify(moved));
  await notOrderableAgain(c, 'system');
});

test('L1: and when the order nobody confirmed expires, the sweep runs the same hook: the system cancels it', async () => {
  const w = await giftOrderedThenPrinterRefunded();
  w.raw.prepare("UPDATE orders SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(w.giftOrderId);
  const report = await sweepExpiredOrders(envOf(w.raw), { enabled: true, ttl_minutes: 60, batch_limit: 10 }, new Date().toISOString());
  assert.equal(report.cancelled, 1, JSON.stringify(report));
  await notOrderableAgain(w, 'system');
});

test('L1: both sweeps of an order nobody confirmed run the hook only where their own flip won', () => {
  for (const file of ['worker/lib/orderExpirySweep.ts', 'worker/lib/giniSweep.ts']) {
    const s = src(file);
    const won = s.indexOf('if (changes > 0) {');
    const hook = s.indexOf('await voidReviewGiftsOfCancelledOrder(env, id, null, nowIso);');
    const lost = s.indexOf('} else {', won);
    assert.ok(won > 0 && hook > won && hook < lost, `${file}: the hook runs in the branch where the flip won`);
  }
  // The stage machine runs the same helper, so the stage door and the courier's sync read one rule.
  assert.match(src('worker/lib/orderStageOps.ts'), /if \(cancellation && legacyFrom !== 'cancelled'\) \{\s*await voidReviewGiftsOfCancelledOrder\(env, order\.id, opts\.changedBy \|\| null, nowIso\);/);
});

test('L1: only a gift whose code died goes — a gift the team granted, in the same order, comes back to be ordered again, and so does a review gift whose printer stays', async () => {
  const w = await codedPrinter();
  const giftId = (await json(await post(w.buyer, '/api/rewards/program/gift-code', { code: w.code }))).gift.id as string;
  await choose(w.buyer, giftId, w.item.id);
  await redeem(w.buyer, giftId);
  await addGiftToCart(w.buyer, giftId);
  const handed = (await grantProduct(w.admin, PLAIN)).id as string;
  assert.equal((await redeem(w.buyer, handed)).status, 200);
  assert.equal((await addGiftToCart(w.buyer, handed)).status, 200);
  const giftOrderId = String((await placeOrder(w.buyer)).id);
  assert.deepEqual([stateOf(w.raw, giftId), stateOf(w.raw, handed)], ['ordered', 'ordered']);

  // The printer is still the customer's: the order cancelled hands both back, as the gift road always did.
  const first = await post(w.buyer, `/api/orders/${giftOrderId}/cancel`, {});
  assert.equal(first.status, 200, JSON.stringify(await json(first)));
  assert.deepEqual([stateOf(w.raw, giftId), stateOf(w.raw, handed)], ['redeemed', 'redeemed']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.cancel'"), 0);

  // Ordered again, then the printer refunded, then that order cancelled: the review gift goes, the team's gift comes back.
  assert.equal((await addGiftToCart(w.buyer, giftId)).status, 200);
  assert.equal((await addGiftToCart(w.buyer, handed)).status, 200);
  const secondId = String((await placeOrder(w.buyer)).id);
  refund(w.raw, w.orderId, w.itemId, 1);
  const second = await post(w.buyer, `/api/orders/${secondId}/cancel`, {});
  assert.equal(second.status, 200, JSON.stringify(await json(second)));
  assert.deepEqual([stateOf(w.raw, giftId), stateOf(w.raw, handed)], ['cancelled', 'redeemed']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.cancel' AND target = ?", handed), 0);
  assert.equal((await addGiftToCart(w.buyer, handed)).status, 200, 'the team’s gift is the customer’s to order again');
  assert.equal((await addGiftToCart(w.buyer, giftId)).status, 409);
});

test('«هداياي» says why a gift went with its printer, in three languages; a gift the team cancelled keeps its reason to itself', async () => {
  const w = await giftInCartOfDelivered();
  for (const status of ['shipped', 'cancelled']) assert.equal((await patch(w.admin, `/api/admin/orders/${w.orderId}`, { status })).status, 200);
  const gone = (await json(await get(w.buyer, '/api/gifts'))).gifts.find((x: J) => x.id === w.giftId);
  assert.equal(gone.cancel_why, 'printer_returned');

  // A gift the team cancels by hand: its reason is internal, and the card says what it always said.
  const handed = await grantOk(w.admin, { mode: 'product', level: 2, product: { qty: 1, ...NOZZLE_04_RED } });
  const cancelled = await post(w.admin, `/api/gifts/admin/grants/${handed.id}/cancel`, { reason: 'Internal: duplicate grant for the same customer' });
  assert.equal(cancelled.status, 200, JSON.stringify(await json(cancelled)));
  const byHand = (await json(await get(w.buyer, '/api/gifts'))).gifts.find((x: J) => x.id === handed.id);
  assert.equal(byHand.status, 'CANCELLED');
  assert.equal(byHand.cancel_why, null);
  assert.doesNotMatch(JSON.stringify(byHand), /duplicate grant/, 'the team’s reason never reaches the customer');

  const card = (gift: J, lang: GiftLang) =>
    renderToStaticMarkup(
      createElement(LanguageProvider, {
        children: createElement(MemoryRouter, null, createElement(GiftCard, { lang, gift: gift as GiftView, money: (n: number) => String(n), onChoose: async () => true, onRedeem: () => undefined, onAddToCart: () => undefined })),
      })
    );
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const printerCard = card(gone, lang);
    assert.ok(printerCard.includes(giftText(lang, 'bodyCancelledPrinter')), `${lang}: the card says the printer went`);
    assert.ok(!printerCard.includes(giftText(lang, 'bodyCancelled')), `${lang}: not the generic line`);
    const handCard = card(byHand, lang);
    assert.ok(handCard.includes(giftText(lang, 'bodyCancelled')), `${lang}: a hand-cancelled gift keeps the generic line`);
    assert.ok(!handCard.includes(giftText(lang, 'bodyCancelledPrinter')));
  }
  const [ar, en, ckb] = (['ar', 'en', 'ckb'] as const).map((l) => giftText(l, 'bodyCancelledPrinter'));
  assert.ok(ar && en && ckb);
  assert.notEqual(ckb, ar);
  assert.doesNotMatch(ckb, /[ةىيك]/, 'an Arabic-only letter in the Sorani');
});

// ------------------------------------------------------------------ the team's side

test('the team’s queue says the code is void and why, and no new code is made for it', async () => {
  const w = await codedPrinter();
  const queue = async () => (await json(await get(w.admin, '/api/reviews/admin/queue?state=approved'))).queue.find((r: J) => r.review_id === 'rv_1');
  assert.equal((await queue()).code_void, null);
  refund(w.raw, w.orderId, w.itemId, 1);
  assert.equal((await queue()).code_void, 'returned');
  const again = await post(w.admin, '/api/reviews/admin/rv_1/code/regenerate', {});
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'GIFT_CODE_VOID');
  assert.equal(row<{ code: string }>(w.raw, 'SELECT redeem_code AS code FROM review_rewards WHERE id = ?', 'rr_1')!.code, w.code, 'the old code stands, void');
});

// ------------------------------------------------------------------ the words

test('every new sentence exists in three languages, the Sorani its own', () => {
  const own = (ar: string, en: string, ckb: string, why: string) => {
    assert.ok(ar && en && ckb, why);
    assert.notEqual(ckb, ar, why);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${why}: an Arabic-only letter in the Sorani`);
  };
  for (const key of ['rate.codeVoid', 'rate.codeVoid.returned', 'rate.codeVoid.cancelled', 'code.err.void.returned', 'code.err.void.cancelled', 'door.rate.void.returned', 'door.rate.void.cancelled'] as const) {
    const [ar, en, ckb] = COPY[key];
    own(ar, en, ckb, key);
  }
  own(reviewGiftText('ar', 'stateVoidReturned'), reviewGiftText('en', 'stateVoidReturned'), reviewGiftText('ckb', 'stateVoidReturned'), 'stateVoidReturned');
  own(reviewGiftText('ar', 'stateVoidCancelled'), reviewGiftText('en', 'stateVoidCancelled'), reviewGiftText('ckb', 'stateVoidCancelled'), 'stateVoidCancelled');
  own(adminText('ar', 'cancelPrinterReturned'), adminText('en', 'cancelPrinterReturned'), adminText('ckb', 'cancelPrinterReturned'), 'cancelPrinterReturned');
  const refusal = REFUSAL_STRINGS.GIFT_CODE_VOID;
  own(refusal.ar, refusal.en, refusal.ckb, 'GIFT_CODE_VOID');
  // The screens read them where the state is.
  const rate = src('src/components/rewards/RateScreen.tsx');
  assert.match(rate, /refusal === 'GIFT_CODE_VOID'\s*\?\s*t\(voidWhy\)/);
  assert.match(rate, /if \(p\.code_void\) return \{ tone: 'warning', text: t\('rate\.codeVoid'\) \};/);
  const panel = src('src/components/adminReviews/ReviewGiftDecision.tsx');
  assert.match(panel, /data-review-code-state="void"/);
  assert.match(panel, /!row\.code_redeemed_at && !row\.code_void && \(/, 'no ready sentence and no new code for a void one');
});

test('policy 8.16 and 8.5 say it in three languages', async () => {
  const { rewards } = await import('../worker/lib/policies/rewards');
  assert.match(rewards.body.ar, /### 8\.16 الطابعة التي تعود إلى المتجر\n.*بطل كود مراجعتها/);
  assert.match(rewards.body.en, /### 8\.16 A printer that goes back to the Store\n.*the review's code becomes void/);
  assert.match(rewards.body.ckb, /### 8\.16 ئەو چاپکەرەی بۆ فرۆشگا دەگەڕێتەوە\n.*کۆدی پێداچوونەوەکەی بەتاڵ دەبێتەوە/);
  assert.match(rewards.body.ar, /وفي الطابعة التي تعود إلى المتجر وفق المادة 8\.16/);
  assert.match(rewards.body.en, /for a printer that goes back to the Store under article 8\.16/);
  assert.match(rewards.body.ckb, /بەپێی ماددەی 8\.16/);
  // L1: an ordered gift stays, until its own order is cancelled before delivery — one sentence, in the same article.
  assert.match(rewards.body.ar, /### 8\.16 [^\n]*\n[^\n]*ويسري عليها الفصل الثالث عشر\. فإن أُلغي الطلب الذي طُلبت فيه هذه الهدية قبل تسليمها أُلغيت الهدية معه، ولا يمكن طلبها مرة أخرى\./);
  assert.match(rewards.body.en, /### 8\.16 [^\n]*\n[^\n]*chapter 13 applies to it\. If the order holding such a gift is cancelled before the gift is delivered, the gift is cancelled with it and cannot be ordered again\./);
  assert.match(rewards.body.ckb, /### 8\.16 [^\n]*\n[^\n]*بەسەردا دەسەپێت\. ئەگەر ئەو داواکارییەی ئەم دیارییەی تێدا داوا کراوە پێش گەیاندنی هەڵبوەشێنرێتەوە، دیارییەکەش لەگەڵیدا هەڵدەوەشێنرێتەوە و ناتوانرێت دووبارە داوا بکرێتەوە\./);
  assert.equal(rewards.version, 8, 'the unpublished version 8, not a ninth');
});
