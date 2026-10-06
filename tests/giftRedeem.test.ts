/**
 * «اختر هديتك» → «استرداد الهدية» → «تم استرداد الهدية» — THE CUSTOMER'S
 * STATE MACHINE (owner brief 2026-10-06 §1; docs/GIFTS_QUICK_BUY.md D4, §1.2).
 *
 *   «لا يمكن استرداد الهدية مرتين — لا من الواجهة ولا من الـ API ولا بطلبين
 *    متزامنين.»
 *
 * Every transition is one conditional write with its fence and its audit row;
 * a replay answers with the gift as it stands and writes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, row } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import {
  NOZZLE_04_RED,
  PLAIN,
  PLATE_AIR,
  addLevelItem,
  apps,
  appsFor,
  auditActions,
  choose,
  get,
  giftRow,
  giftWorld,
  grantOk,
  json,
  legacyBox,
  myGift,
  post,
  put,
  redeem,
  send,
} from './fixtures/giftWorld';

/** A JSON body as the routes answer it, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

test('a level gift: choose, change the choice, redeem — each one write with its audit row', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const nozzle = await addLevelItem(a.admin, 3, NOZZLE_04_RED);
  const plain = await addLevelItem(a.admin, 3, PLAIN);
  const elsewhere = await addLevelItem(a.admin, 4, PLATE_AIR);
  const g = await grantOk(a.admin, { mode: 'level', level: 3, reason: 'review' });

  // GRANTED: the level's alternatives, today's availability on each.
  const card = await myGift(a.buyer, g.id);
  assert.equal(card?.status, 'GRANTED');
  assert.equal(card?.can_change_choice, true);
  assert.deepEqual(card?.choices.map((c: J) => [c.item_id, c.available]), [[nozzle.id, true], [plain.id, true]]);
  assert.equal(card?.chosen, null);

  // Redeem before a choice: refused, nothing written.
  const early = await redeem(a.buyer, g.id);
  assert.equal(early.status, 409);
  assert.equal((await json(early)).code, 'GIFT_CHOICE_REQUIRED');

  // An item of another level is not a choice of this gift.
  const wrong = await choose(a.buyer, g.id, elsewhere.id);
  assert.equal(wrong.status, 409);
  assert.equal((await json(wrong)).code, 'GIFT_ITEM_UNAVAILABLE');

  const first = await json(await choose(a.buyer, g.id, nozzle.id));
  assert.equal(first.gift.status, 'READY_TO_REDEEM');
  assert.equal(first.gift.chosen.product_id, 'p_nozzle');
  assert.equal(first.gift.chosen.item_id, nozzle.id);
  // The choice may change until the gift is redeemed.
  const second = await json(await choose(a.buyer, g.id, plain.id));
  assert.equal(second.gift.chosen.product_id, 'p_plain');
  const replay = await json(await choose(a.buyer, g.id, plain.id));
  assert.equal(replay.replay, true, 'the same choice again writes nothing');

  const redeemed = await json(await redeem(a.buyer, g.id));
  assert.equal(redeemed.gift.status, 'REDEEMED');
  assert.equal(redeemed.gift.can_change_choice, false);
  assert.equal(redeemed.gift.choices, null, 'no alternatives once redeemed');
  assert.ok(redeemed.gift.redeemed_at);
  const stored = giftRow(raw, g.id);
  assert.equal(stored.state, 'redeemed');
  assert.equal(stored.gift_product_id, 'p_plain');
  assert.equal(stored.gift_item_id, plain.id);

  // After the redemption the choice is final, and a second redemption is a replay.
  const late = await choose(a.buyer, g.id, nozzle.id);
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'GIFT_STATE');
  const again = await json(await redeem(a.buyer, g.id));
  assert.equal(again.replay, true);
  assert.equal(again.gift.status, 'REDEEMED');

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_redemptions WHERE entitlement_id = ?', g.id), 1);
  assert.deepEqual(auditActions(raw, g.id), ['gift.grant', 'gift.choose', 'gift.choose', 'gift.redeem']);
  const redeemAudit = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'gift.redeem'")!.detail);
  assert.equal(redeemAudit.user_id, 'buyer');
  assert.equal(redeemAudit.product_id, 'p_plain');
  assert.equal(redeemAudit.level, 3);
  // NOTHING IS RESERVED BY A REDEMPTION (D6): stock moves only with the order.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
  assert.equal(row(raw, "SELECT stock FROM products WHERE id = 'p_plain'")?.stock, 3);
});

test('the frozen choice: an item edited or withdrawn after the choice never changes the gift', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const nozzle = await addLevelItem(a.admin, 2, NOZZLE_04_RED);
  const g = await grantOk(a.admin, { mode: 'level', level: 2, reason: 'review' });
  await choose(a.buyer, g.id, nozzle.id);

  // The admin re-pins the item to blue: the customer's choice stays red.
  await put(a.admin, `/api/gifts/admin/items/${nozzle.id}`, { colorId: 'c_blue' });
  assert.equal(giftRow(raw, g.id).gift_color_id, 'c_red');
  assert.equal((await myGift(a.buyer, g.id))?.chosen.color.en, 'Red');

  // Withdrawn before the redemption: the gift cannot be redeemed against it…
  await send(a.admin, 'DELETE', `/api/gifts/admin/items/${nozzle.id}`);
  const res = await redeem(a.buyer, g.id);
  const out = await json(res);
  assert.equal(res.status, 409);
  assert.equal(out.code, 'GIFT_ITEM_UNAVAILABLE');
  assert.equal(out.details.reason, 'ITEM_WITHDRAWN');
  assert.equal(giftRow(raw, g.id).state, 'ready_to_redeem', 'nothing written');
  // …and choosing another item of the level is still possible.
  const plain = await addLevelItem(a.admin, 2, PLAIN);
  assert.equal((await json(await choose(a.buyer, g.id, plain.id))).gift.chosen.product_id, 'p_plain');
  assert.equal((await redeem(a.buyer, g.id)).status, 200);
});

test('a product the store cannot sell today is neither chosen nor redeemed', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const soldOut = await addLevelItem(a.admin, 1, { ...NOZZLE_04_RED, optionValueIds: ['v_06'] });
  const plain = await addLevelItem(a.admin, 1, PLAIN);
  const g = await grantOk(a.admin, { mode: 'level', level: 1, reason: 'review' });

  const card = await myGift(a.buyer, g.id);
  assert.deepEqual(card?.choices.map((c: J) => [c.item_id, c.available, c.reason]), [
    [soldOut.id, false, 'OUT_OF_STOCK'],
    [plain.id, true, null],
  ]);
  const res = await choose(a.buyer, g.id, soldOut.id);
  const out = await json(res);
  assert.equal(res.status, 409);
  assert.equal(out.code, 'GIFT_ITEM_UNAVAILABLE');
  assert.equal(out.details.reason, 'OUT_OF_STOCK');

  // Chosen while on sale, hidden before the redemption: refused at the redemption.
  await choose(a.buyer, g.id, plain.id);
  raw.prepare("UPDATE products SET status = 'hidden' WHERE id = 'p_plain'").run();
  const hidden = await redeem(a.buyer, g.id);
  assert.equal(hidden.status, 409);
  assert.equal((await json(hidden)).code, 'GIFT_ITEM_UNAVAILABLE');
  assert.equal(giftRow(raw, g.id).state, 'ready_to_redeem');
  raw.prepare("UPDATE products SET status = 'active' WHERE id = 'p_plain'").run();
  assert.equal((await redeem(a.buyer, g.id)).status, 200);
});

test('two concurrent redemptions write exactly one; the other is answered as a replay', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const g = await grantOk(a.admin, { mode: 'product', level: 2, product: { ...NOZZLE_04_RED, qty: 1 }, reason: 'admin_gift' });
  const s = appsFor(serialD1(raw));
  const results = await Promise.all([redeem(s.buyer, g.id), redeem(s.buyer, g.id), redeem(s.buyer, g.id)]);
  const bodies = await Promise.all(results.map((r) => json(r)));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200], JSON.stringify(bodies));
  assert.equal(bodies.filter((b) => b.replay === true).length, 2, 'two of the three were replays');
  assert.ok(bodies.every((b) => b.gift.status === 'REDEEMED'));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_redemptions WHERE entitlement_id = ?', g.id), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.redeem'"), 1);
  assert.equal(giftRow(raw, g.id).version, 2, 'one transition, one version step');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0, 'every fence row was cleaned up');

  // Two concurrent choices of one level gift: both answer, one item wins, no lost write is half-done.
  const item1 = await addLevelItem(a.admin, 5, PLAIN);
  const item2 = await addLevelItem(a.admin, 5, NOZZLE_04_RED);
  const lg = await grantOk(a.admin, { mode: 'level', level: 5, reason: 'review' });
  const picks = await Promise.all([choose(s.buyer, lg.id, item1.id), choose(s.buyer, lg.id, item2.id)]);
  const statuses = picks.map((p) => p.status).sort();
  assert.ok(statuses[0] === 200, JSON.stringify(statuses));
  const final = giftRow(raw, lg.id);
  assert.equal(final.state, 'ready_to_redeem');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.choose' AND target = ?", lg.id), picks.filter((p) => p.status === 200).length);
});

test('another customer’s gift and an unknown id answer alike; a cancelled gift goes nowhere', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const item = await addLevelItem(a.admin, 1, PLAIN);
  const g = await grantOk(a.admin, { mode: 'level', level: 1, reason: 'review' });
  for (const [app, id] of [[a.other, g.id], [a.buyer, 'gift_nope']] as const) {
    for (const res of [await choose(app, id, item.id), await redeem(app, id)]) {
      assert.equal(res.status, 404);
      assert.equal((await json(res)).code, 'GIFT_NOT_FOUND');
    }
  }
  assert.deepEqual(await json(await get(a.other, '/api/gifts')), { success: true, gifts: [] });

  await post(a.admin, `/api/gifts/admin/grants/${g.id}/cancel`, { reason: 'granted twice' });
  for (const res of [await choose(a.buyer, g.id, item.id), await redeem(a.buyer, g.id)]) {
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'GIFT_STATE');
  }
  assert.equal((await post(a.buyer, `/api/gifts/${g.id}/choose`, {})).status, 400, 'an item id is required');
});

test('a legacy review box opens the old way, at the new URL and the old one, once', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  legacyBox(raw, 'ge_box', { maxLevel: 1 });
  const pool = await json(await post(a.admin, '/api/reviews/admin/pools', { level: 1, kind: 'accessory', label_ar: 'حامل بكرة', stock: 2 }));
  assert.equal(pool.success, true, JSON.stringify(pool));
  // A product item of level 1 is never drawn into a legacy box.
  await addLevelItem(a.admin, 1, PLAIN);

  const card = await myGift(a.buyer, 'ge_box');
  assert.equal(card?.status, 'LEGACY');
  assert.deepEqual(card?.legacy.levels.map((l: J) => [l.level, l.available]), [[1, true]]);

  const res = await post(a.buyer, '/api/gifts/ge_box/redeem', { level: 1, options: {} });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(giftRow(raw, 'ge_box').state, 'selected');
  assert.equal(row(raw, 'SELECT stock FROM gift_pool_items WHERE id = ?', pool.item.id)?.stock, 1, 'the label row’s own counter, as before');
  const contents = JSON.parse(giftRow(raw, 'ge_box').contents);
  assert.deepEqual(contents.map((c: J) => c.item_id), [pool.item.id]);

  // The old URL answers the same box as a replay; nothing is drawn twice.
  const old = await json(await post(a.buyer, '/api/reviews/gifts/ge_box/redeem', { level: 1, options: {} }));
  assert.equal(old.success, true, JSON.stringify(old));
  assert.equal(old.replay, true);
  assert.equal(row(raw, 'SELECT stock FROM gift_pool_items WHERE id = ?', pool.item.id)?.stock, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM gift_redemptions WHERE entitlement_id = 'ge_box'"), 1);
  // A legacy box is never ordered through the cart.
  const cart = await post(a.buyer, '/api/cart/gift-items', { giftId: 'ge_box' });
  assert.equal(cart.status, 409);
  assert.equal((await json(cart)).code, 'GIFT_NOT_AVAILABLE');
});
