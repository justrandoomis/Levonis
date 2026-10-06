/**
 * «منح هدية» — THE ADMIN GRANTS A GIFT (owner brief 2026-10-06 §1;
 * docs/GIFTS_QUICK_BUY.md §1.2), through the real routes.
 *
 *   «منح مستخدم هدية يدويًا: المستوى 1–5، منتج محدد اختياري، السبب (تقييم /
 *    مكافأة / تعويض / هدية من الإدارة)، ملاحظة داخلية لا تظهر للزبون.»
 *
 * Every grant is ONE batch — the row, its audit row and the customer's in-app
 * notice — and a retried press under the same idempotency key is the same
 * grant. The internal note never reaches a customer payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, row } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import {
  BOSS,
  NOZZLE_04_RED,
  PLAIN,
  PLATE_AIR,
  addGiftToCart,
  addLevelItem,
  appsFor,
  apps,
  auditActions,
  choose,
  freshKey,
  get,
  giftRow,
  giftWorld,
  grantOk,
  json,
  legacyBox,
  myGift,
  patch,
  placeOrder,
  post,
  redeem,
} from './fixtures/giftWorld';

/** A JSON body as the routes answer it, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

const SECRET = 'INTERNAL-NOTE-7f3a: delayed order, call before delivery';

test('a level grant notifies the customer in three languages, is audited, and its note never reaches the customer', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const item = await addLevelItem(a.admin, 3, NOZZLE_04_RED);
  await addLevelItem(a.admin, 3, PLAIN);

  const g = await grantOk(a.admin, { mode: 'level', level: 3, reason: 'compensation', note: SECRET });
  assert.equal(g.status, 'GRANTED');
  assert.equal(g.state, 'granted');
  assert.equal(g.mode, 'level');
  assert.equal(g.reason, 'compensation');
  assert.equal(g.level.n, 3);
  assert.equal(g.note, SECRET, 'the admin reads the note back');
  assert.equal(g.granted_by.id, BOSS.id);
  assert.equal(g.chosen, null, 'nothing is chosen for the customer');
  const stored = giftRow(raw, g.id);
  assert.equal(stored.reward_id, null, 'a manual grant needs no review');
  assert.equal(stored.version, 1);

  // THE NOTICE — in the same batch, in three languages, pointing at /gifts.
  const notice = row<Record<string, string>>(raw, "SELECT * FROM user_notifications WHERE kind = 'gift_granted'")!;
  assert.equal(notice.user_id, 'buyer');
  assert.equal(notice.link, '/gifts');
  assert.equal(notice.entity_type, 'gift');
  assert.equal(notice.entity_id, g.id);
  assert.match(notice.title_ar, /هدية/);
  assert.match(notice.title_en, /gift/);
  const meta = JSON.parse(notice.meta);
  assert.match(meta.title_ckb, /دیاری/);
  assert.ok(meta.body_ckb.length > 10);
  assert.notEqual(meta.body_ckb, notice.body_ar, 'the Sorani notice is its own sentence');
  assert.ok(!JSON.stringify(notice).includes('INTERNAL-NOTE'), 'the notice never carries the note');

  // THE AUDIT ROW — who, whom, which level, why.
  const audit = row<{ actor_id: string; detail: string }>(raw, "SELECT actor_id, detail FROM audit_log WHERE action = 'gift.grant' AND target = ?", g.id)!;
  assert.equal(audit.actor_id, BOSS.id);
  const detail = JSON.parse(audit.detail);
  assert.equal(detail.user_id, 'buyer');
  assert.equal(detail.level, 3);
  assert.equal(detail.mode, 'level');
  assert.equal(detail.reason, 'compensation');

  // THE CUSTOMER'S PAYLOADS — every one of them, at every step.
  const payloads: string[] = [];
  const keep = async (res: Response) => {
    const text = await res.text();
    payloads.push(text);
    return JSON.parse(text);
  };
  const list = await keep(await get(a.buyer, '/api/gifts'));
  const card = list.gifts.find((x: J) => x.id === g.id);
  assert.equal(card.status, 'GRANTED');
  assert.equal(card.choices.length, 2);
  await keep(await choose(a.buyer, g.id, item.id));
  await keep(await redeem(a.buyer, g.id));
  await keep(await addGiftToCart(a.buyer, g.id));
  await keep(await get(a.buyer, '/api/cart'));
  await keep(await get(a.buyer, '/api/gifts'));
  await keep(await get(a.buyer, '/api/reviews/gifts'));
  const order = await placeOrder(a.buyer);
  payloads.push(JSON.stringify(order));
  await keep(await get(a.buyer, `/api/orders/${order.id}`));
  await keep(await get(a.buyer, '/api/orders'));
  await keep(await get(a.buyer, '/api/gifts'));
  for (const p of payloads) {
    assert.ok(!p.includes('INTERNAL-NOTE'), `the internal note leaked: ${p.slice(0, 200)}`);
    assert.ok(!p.includes('admin_note'), 'no admin_note key in a customer payload');
    assert.ok(!p.includes('granted_by'), 'no granting admin in a customer payload');
    assert.ok(!p.includes('grant_request'), 'no idempotency key in a customer payload');
  }
  // The admin still reads it, unchanged by everything that happened.
  const detailRes = await json(await get(a.admin, `/api/gifts/admin/grants/${g.id}`));
  assert.equal(detailRes.grant.note, SECRET);
  assert.equal(detailRes.grant.status, 'ORDERED');
  assert.deepEqual(
    detailRes.audit.map((x: J) => x.action),
    ['gift.grant', 'gift.choose', 'gift.redeem', 'gift.order'],
    'the timeline names every step'
  );
});

test('a pinned grant — a level item or any store product — starts ready to redeem with its frozen selection', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const item = await addLevelItem(a.admin, 2, NOZZLE_04_RED);
  await addLevelItem(a.admin, 4, PLAIN);

  const byItem = await grantOk(a.admin, { mode: 'level', level: 2, itemId: item.id, reason: 'reward' });
  assert.equal(byItem.state, 'ready_to_redeem');
  assert.equal(byItem.mode, 'product', 'a pinned grant has nothing left to choose');
  assert.equal(byItem.item_id, item.id);
  assert.equal(byItem.chosen.product_id, 'p_nozzle');
  assert.equal(byItem.chosen.value_iqd, 40000);

  const byProduct = await grantOk(a.admin, { mode: 'product', level: 5, product: { ...PLATE_AIR, qty: 2 }, reason: 'admin_gift' });
  assert.equal(byProduct.state, 'ready_to_redeem');
  assert.equal(byProduct.item_id, null);
  assert.equal(byProduct.chosen.qty, 2);
  assert.equal(byProduct.chosen.sale_type, 'pre_order');
  assert.equal(byProduct.chosen.transport_method, 'air');
  const stored = giftRow(raw, byProduct.id);
  assert.equal(stored.gift_option_value_ids, '["v_pei"]');
  assert.equal(stored.gift_qty, 2);
  assert.equal(JSON.parse(stored.gift_snapshot).value_iqd, 120000, 'two units at the regular price');
  // The air route's lead time travels as days, so each language words it itself.
  assert.equal(byProduct.chosen.lead_time_min_days, 10);
  assert.equal(byProduct.chosen.lead_time_max_days, 14);

  // NOTHING IS RESERVED BY A GRANT (D6).
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
  assert.equal(row(raw, "SELECT reserved FROM product_option_values WHERE id = 'v_04'")?.reserved, 0);

  const refuse = async (body: Record<string, unknown>) => {
    const res = await post(a.admin, '/api/gifts/admin/grants', { userId: 'buyer', reason: 'admin_gift', idempotencyKey: freshKey(), ...body });
    return { status: res.status, code: (await json(res)).code as string | undefined };
  };
  assert.deepEqual(await refuse({ mode: 'level', level: 3, itemId: item.id }), { status: 400, code: 'GIFT_ITEM_UNAVAILABLE' }, 'an item of another level');
  assert.deepEqual(await refuse({ mode: 'level', level: 1 }), { status: 409, code: 'GIFT_LEVEL_EMPTY' }, 'a level with nothing to choose');
  assert.deepEqual(await refuse({ mode: 'product', level: 1, product: { ...PLAIN, productId: 'p_bundle' } }), {
    status: 400,
    code: 'GIFT_COMPOSITION_UNSUPPORTED',
  });
  assert.deepEqual(await refuse({ mode: 'product', level: 1, product: { ...PLAIN, productId: 'p_draft' } }), {
    status: 400,
    code: 'GIFT_PRODUCT_INACTIVE',
  });
  assert.deepEqual(await refuse({ mode: 'level', level: 4, userId: 'nobody' }), { status: 404, code: 'USER_NOT_FOUND' });
  assert.deepEqual(await refuse({ mode: 'box', level: 4 }), { status: 400, code: 'GIFT_MODE_INVALID' });
  assert.deepEqual(await refuse({ mode: 'level', level: 4, reason: 'legacy' }), { status: 400, code: 'GIFT_REASON_INVALID' });
  assert.equal((await refuse({ mode: 'level', level: 6 })).status, 400);
  assert.equal((await refuse({ mode: 'level', level: 4, idempotencyKey: 'short' })).status, 400);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 2, 'no refusal granted anything');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted'"), 2);
});

test('the idempotency key makes a retried press the same grant — sequential or concurrent — and refuses a different body', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  await addLevelItem(a.admin, 3, NOZZLE_04_RED);
  const body = { userId: 'buyer', mode: 'level', level: 3, reason: 'review', note: 'n', idempotencyKey: 'grant-press-0001' };

  const first = await json(await post(a.admin, '/api/gifts/admin/grants', body));
  assert.equal(first.success, true, JSON.stringify(first));
  const second = await json(await post(a.admin, '/api/gifts/admin/grants', body));
  assert.equal(second.replay, true);
  assert.equal(second.grant.id, first.grant.id);

  const other = await post(a.admin, '/api/gifts/admin/grants', { ...body, level: 4 });
  assert.equal(other.status, 409);
  assert.equal((await json(other)).code, 'IDEMPOTENCY_KEY_REUSED');

  // Two presses landing together: one grant, one notice, one audit row.
  const s = appsFor(serialD1(raw));
  const twin = { ...body, idempotencyKey: 'grant-press-0002' };
  const [x, y] = await Promise.all([post(s.admin, '/api/gifts/admin/grants', twin), post(s.admin, '/api/gifts/admin/grants', twin)]);
  const [jx, jy] = [await json(x), await json(y)];
  assert.equal(x.status, 200, JSON.stringify(jx));
  assert.equal(y.status, 200, JSON.stringify(jy));
  assert.equal(jx.grant.id, jy.grant.id);

  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 2);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted'"), 2);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.grant'"), 2);
});

test('the grants list filters by status, level, reason and customer and pages with a cursor', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  await addLevelItem(a.admin, 1, PLAIN);
  await addLevelItem(a.admin, 2, PLAIN);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await grantOk(a.admin, { mode: 'level', level: 1, reason: 'review' })).id);
  const pinned = await grantOk(a.admin, { mode: 'product', level: 2, product: { ...NOZZLE_04_RED, qty: 1 }, reason: 'compensation' });
  const forOther = await grantOk(a.admin, { userId: 'other', mode: 'level', level: 2, reason: 'admin_gift' });
  legacyBox(raw, 'ge_legacy');

  const list = async (qs: string) => {
    const res = await get(a.admin, `/api/gifts/admin/grants${qs}`);
    const out = await json(res);
    assert.equal(res.status, 200, JSON.stringify(out));
    return out as { grants: Array<J>; next_cursor: string | null };
  };
  assert.equal((await list('')).grants.length, 8);
  assert.deepEqual((await list('?status=READY_TO_REDEEM')).grants.map((g) => g.id), [pinned.id]);
  assert.deepEqual((await list('?status=LEGACY')).grants.map((g) => g.id), ['ge_legacy']);
  assert.equal((await list('?level=1')).grants.length, 5);
  assert.deepEqual((await list('?reason=compensation')).grants.map((g) => g.id), [pinned.id]);
  assert.deepEqual((await list('?user=other')).grants.map((g) => g.id), [forOther.id]);
  assert.deepEqual((await list('?q=omar')).grants.map((g) => g.id), [forOther.id], 'search by the customer');
  assert.equal((await get(a.admin, '/api/gifts/admin/grants?status=NOPE')).status, 400);

  // Keyset pages: 3 + 3 + 2, no row twice, none missing, newest first.
  const seen: string[] = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const out = await list(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...out.grants.map((g) => g.id));
    if (!out.next_cursor) break;
    cursor = out.next_cursor;
  }
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen).size, 8);
  assert.ok(seen.indexOf(forOther.id) < seen.indexOf(ids[0]), 'newest first');
  assert.equal(seen[seen.length - 1], 'ge_legacy', 'the legacy row (granted before) comes last');
});

test('editing the note and reason is audited with before and after; a legacy row keeps its reason', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  await addLevelItem(a.admin, 1, PLAIN);
  const g = await grantOk(a.admin, { mode: 'level', level: 1, reason: 'review', note: 'first' });

  const res = await patch(a.admin, `/api/gifts/admin/grants/${g.id}`, { note: 'second', reason: 'compensation' });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.grant.note, 'second');
  assert.equal(out.grant.reason, 'compensation');
  const audit = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'gift.note' AND target = ?", g.id)!.detail);
  assert.deepEqual(audit.before, { note: 'first', reason: 'review' });
  assert.deepEqual(audit.after, { note: 'second', reason: 'compensation' });

  const same = await json(await patch(a.admin, `/api/gifts/admin/grants/${g.id}`, { note: 'second' }));
  assert.equal(same.unchanged, true, 'nothing changed, nothing written');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.note'"), 1);
  assert.equal((await patch(a.admin, `/api/gifts/admin/grants/${g.id}`, { reason: 'gift' })).status, 400);

  legacyBox(raw, 'ge_legacy');
  const legacy = await patch(a.admin, '/api/gifts/admin/grants/ge_legacy', { reason: 'review' });
  assert.equal(legacy.status, 409);
  assert.equal((await json(legacy)).code, 'GIFT_STATE');
  const legacyNote = await json(await patch(a.admin, '/api/gifts/admin/grants/ge_legacy', { note: 'called the customer' }));
  assert.equal(legacyNote.grant.note, 'called the customer', 'a legacy row can carry a note');
});

test('cancel: before the order only, the cart line goes with it, and the customer sees «cancelled»', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  await addLevelItem(a.admin, 1, PLAIN);
  const granted = await grantOk(a.admin, { mode: 'level', level: 1, reason: 'review' });
  const inCart = await grantOk(a.admin, { mode: 'product', level: 1, product: { ...NOZZLE_04_RED, qty: 1 }, reason: 'review' });
  await redeem(a.buyer, inCart.id);
  assert.equal((await addGiftToCart(a.buyer, inCart.id)).status, 200);

  assert.equal((await post(a.admin, `/api/gifts/admin/grants/${granted.id}/cancel`, { reason: 'x' })).status, 400, 'a reason is required');
  for (const id of [granted.id, inCart.id]) {
    const res = await post(a.admin, `/api/gifts/admin/grants/${id}/cancel`, { reason: 'granted by mistake' });
    const out = await json(res);
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.grant.status, 'CANCELLED');
    assert.equal(out.grant.cancel_reason, 'granted by mistake');
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0, 'the gift line left the cart in the same batch');
  const card = await myGift(a.buyer, inCart.id);
  assert.equal(card?.status, 'CANCELLED');
  assert.ok(!JSON.stringify(card).includes('granted by mistake'), 'the internal cancel reason is not the customer’s to read');
  assert.equal((await redeem(a.buyer, granted.id)).status, 409);
  assert.equal((await addGiftToCart(a.buyer, inCart.id)).status, 409);
  const again = await post(a.admin, `/api/gifts/admin/grants/${granted.id}/cancel`, { reason: 'twice over' });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'GIFT_STATE');

  // An ORDERED gift is never cancelled here: the order is.
  const ordered = await grantOk(a.admin, { mode: 'product', level: 1, product: { ...PLAIN, qty: 1 }, reason: 'review' });
  await redeem(a.buyer, ordered.id);
  await addGiftToCart(a.buyer, ordered.id);
  await placeOrder(a.buyer);
  const refused = await post(a.admin, `/api/gifts/admin/grants/${ordered.id}/cancel`, { reason: 'too late now' });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'GIFT_ALREADY_ORDERED');
  assert.equal(giftRow(raw, ordered.id).state, 'ordered');
  assert.deepEqual(auditActions(raw, inCart.id), ['gift.grant', 'gift.redeem', 'gift.cancel']);
});

test('a legacy review box: converted into a level grant the customer chooses from, or fulfilled the old way', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const item = await addLevelItem(a.admin, 3, PLAIN);
  legacyBox(raw, 'ge_open', { maxLevel: 3 });
  legacyBox(raw, 'ge_selected', { maxLevel: 2, state: 'selected' });

  // The customer's card reads the old box as it always was.
  const before = await myGift(a.buyer, 'ge_open');
  assert.equal(before?.status, 'LEGACY');
  assert.equal(before?.legacy.state, 'available');
  const old = await json(await get(a.buyer, '/api/reviews/gifts'));
  assert.deepEqual(old.gifts.map((g: J) => [g.id, g.state]).sort(), [['ge_open', 'available'], ['ge_selected', 'selected']]);

  const converted = await json(await post(a.admin, '/api/gifts/admin/grants/ge_open/convert', { note: 'moved to the new gifts' }));
  assert.equal(converted.success, true, JSON.stringify(converted));
  assert.equal(converted.grant.status, 'GRANTED');
  assert.equal(converted.grant.mode, 'level');
  assert.equal(converted.grant.level.n, 3, 'its own level by default');
  assert.equal(converted.grant.reason, 'review');
  assert.equal(giftRow(raw, 'ge_open').reward_id, 'rr_ge_open', 'still linked to its review reward');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted' AND entity_id = 'ge_open'"), 1);

  // …and now it is a gift of the new flow.
  const card = await myGift(a.buyer, 'ge_open');
  assert.equal(card?.status, 'GRANTED');
  assert.deepEqual(card?.choices.map((c: J) => c.item_id), [item.id]);
  assert.equal((await choose(a.buyer, 'ge_open', item.id)).status, 200);
  assert.equal((await redeem(a.buyer, 'ge_open')).status, 200);
  const oldAfter = await json(await get(a.buyer, '/api/reviews/gifts'));
  assert.deepEqual(oldAfter.gifts.map((g: J) => g.id), ['ge_selected'], 'the old screen lists only what it can render');

  const notConvertible = await post(a.admin, '/api/gifts/admin/grants/ge_selected/convert', {});
  assert.equal(notConvertible.status, 409);
  assert.equal((await json(notConvertible)).code, 'GIFT_NOT_CONVERTIBLE');
  const twice = await post(a.admin, '/api/gifts/admin/grants/ge_open/convert', {});
  assert.equal(twice.status, 409);

  // «تم التسليم» for a box handed over outside the order system — the old route and the new.
  assert.equal((await post(a.admin, '/api/gifts/admin/grants/ge_open/fulfill', {})).status, 400, 'only a legacy selected box');
  const fulfilled = await json(await post(a.admin, '/api/gifts/admin/grants/ge_selected/fulfill', {}));
  assert.equal(fulfilled.grant.legacy.state, 'fulfilled');
  assert.deepEqual(auditActions(raw, 'ge_selected'), ['gift.fulfill']);
  assert.deepEqual(auditActions(raw, 'ge_open'), ['gift.convert', 'gift.choose', 'gift.redeem']);
});

test('approving a printer-review reward grants a LEVEL gift of the quality score, linked to the reward, once', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_printer','p1s','P1S','طابعة P1S',900000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','[]');
    INSERT INTO reviews (id,user_id,product_id,stars,body,status,source)
      VALUES ('rv_1','buyer','p_printer',5,'A detailed review of this printer with photos and a video.','published','user');
    INSERT INTO review_rewards (id,review_id,user_id,kind,state,quality_score,quality_snapshot)
      VALUES ('rr_1','rv_1','buyer','printer_gift','submitted',4,'{"score":80,"tier":4,"reasons":[],"suspiciousSignals":[],"rewardEligible":true}');
  `);
  const approve = () =>
    post(a.admin, '/api/reviews/admin/rv_1/reward', { action: 'approve', qualityScore: 4, reason: 'Excellent detailed review with media' });
  const res = await approve();
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  const g = giftRow(raw, out.entitlement_id);
  assert.equal(g.grant_mode, 'level');
  assert.equal(g.state, 'granted');
  assert.equal(g.level, 4);
  assert.equal(g.reason, 'review');
  assert.equal(g.reward_id, 'rr_1');
  assert.equal(g.granted_by, BOSS.id);
  assert.equal(row(raw, "SELECT state FROM review_rewards WHERE id = 'rr_1'")?.state, 'approved');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted'"), 1);
  assert.deepEqual(auditActions(raw, g.id), ['gift.grant']);
  const grantAudit = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'gift.grant'")!.detail);
  assert.equal(grantAudit.reward_id, 'rr_1');
  assert.equal(grantAudit.review_id, 'rv_1');

  // The customer sees a level gift of the new flow.
  const card = await myGift(a.buyer, g.id);
  assert.equal(card?.status, 'GRANTED');
  assert.equal(card?.reason, 'review');
  assert.equal(card?.level.n, 4);

  // A second approval — replayed or concurrent — grants nothing more.
  assert.equal((await approve()).status, 409);
  const s = appsFor(serialD1(raw));
  raw.exec(`
    INSERT INTO reviews (id,user_id,product_id,stars,body,status,source)
      VALUES ('rv_2','other','p_printer',5,'Another detailed review of this printer with photos.','published','user');
    INSERT INTO review_rewards (id,review_id,user_id,kind,state,quality_score,quality_snapshot)
      VALUES ('rr_2','rv_2','other','printer_gift','submitted',2,'{"score":40,"tier":2,"reasons":[],"suspiciousSignals":[],"rewardEligible":true}');
  `);
  const body = { action: 'approve', qualityScore: 2, reason: 'Good review with a clear video' };
  const results = await Promise.all([post(s.admin, '/api/reviews/admin/rv_2/reward', body), post(s.admin, '/api/reviews/admin/rv_2/reward', body)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM gift_entitlements WHERE reward_id = 'rr_2'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'gift_granted' AND user_id = 'other'"), 1);
  assert.equal(all(raw, "SELECT id FROM audit_log WHERE action = 'gift.grant'").length, 2);
});

test('a grant’s detail carries its audit timeline; another admin door answers 404 for an unknown gift', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const g = await grantOk(a.admin, { mode: 'product', level: 1, product: { ...PLAIN, qty: 1 }, reason: 'admin_gift', note: 'n1' });
  await patch(a.admin, `/api/gifts/admin/grants/${g.id}`, { note: 'n2' });
  const res = await json(await get(a.admin, `/api/gifts/admin/grants/${g.id}/audit`));
  assert.deepEqual(res.audit.map((x: J) => x.action), ['gift.grant', 'gift.note']);
  assert.equal(res.audit[0].actor.id, BOSS.id);
  assert.equal(res.audit[1].detail.after.note, 'n2');
  for (const path of ['/api/gifts/admin/grants/nope', '/api/gifts/admin/grants/nope/audit']) {
    assert.equal((await get(a.admin, path)).status, 404, path);
  }
  for (const path of ['cancel', 'convert', 'fulfill']) {
    assert.equal((await post(a.admin, `/api/gifts/admin/grants/nope/${path}`, { reason: 'whatever reason' })).status, 404, path);
  }
  assert.equal((await patch(a.admin, '/api/gifts/admin/grants/nope', { note: 'x' })).status, 404);
});
