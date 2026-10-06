/**
 * THE OFFER SLOT COMES BACK ON A GENUINE CANCELLATION — AND NEVER FOR A
 * MYSTERY (owner decision 4, migration 0065).
 *
 * The owner's five rules, and where each is pinned below:
 *
 *   1. a REVEALED mystery allocation never restores its slot   → tests 4 and 5
 *   2. customer cancel after a mystery reveal stays forbidden   → test 5
 *      (and tests/mysteryReveal.test.ts, which owns that guard)
 *   3. a genuinely cancelled/refunded NORMAL BUNDLE order may
 *      restore its slot, when no benefit was consumed           → tests 1 and 2
 *   4. a failed/expired checkout must not permanently consume
 *      a normal bundle entitlement                              → test 3
 *   5. no path enables a free mystery re-roll                   → tests 4, 5, 6
 *
 * Rule 5 is the one that decides the shape of the release statement. It
 * excludes every order carrying a `mystery_allocations` row — revealed or not
 * — rather than testing `revealed_at`, because half of "revealed" is a pure
 * TypeScript milestone check that SQL cannot see. A predicate on `revealed_at`
 * would free the slot of an order the customer has already looked inside.
 *
 * The re-claim is the other half nobody would think to test: `cancelled` is
 * not terminal for an unpaid order. Both admin doors may reopen a cancelled
 * cash-pickup order, which must reclaim its slot. An order whose advance was
 * refunded must instead be purchased again so its payment is collected anew.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, failingD1, stubApp, post, patch, json, row, count, spendable, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { addBundle, seedCatalogue, orderBody } from './lib/bundles';
import { seedMysteryPool, addMysteryOffer } from './lib/mysteryOffer';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const admin: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };

const appFor = (db: unknown, user: StubUser = buyer) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/admin', adminRoutes);
  });

const redemption = (raw: DatabaseSync, subjectId: string) =>
  row<{ state: string; released_at: string | null; qty: number; order_id: string }>(
    raw,
    'SELECT state, released_at, qty, order_id FROM offer_redemptions WHERE subject_id = ? ORDER BY rowid DESC',
    subjectId
  );

/** One bundle, one per customer, bought once. */
async function boughtBundle(raw: DatabaseSync, maxPerUser: number | null = 1, deliveryMethodId: 'standard' | 'pickup' = 'standard') {
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000, limits: { max_per_user: maxPerUser } });
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(await post(appFor(db), '/api/orders', orderBody({ deliveryMethodId })));
  assert.equal(res.success, true, JSON.stringify(res));
  if (deliveryMethodId === 'pickup') {
    // Use an actual unpaid checkout, not a paid order with its refund deleted:
    // these fixtures exercise entitlement reclamation after cancellation.
    assert.deepEqual(row(raw,
      'SELECT wallet_applied_iqd,wallet_applied_usd_cents,points_discount_iqd FROM orders WHERE id=?', res.order.id),
    { wallet_applied_iqd: 0, wallet_applied_usd_cents: 0, points_discount_iqd: 0 });
  }
  return { db, orderId: res.order.id as string };
}

/** One mystery box, one per customer, bought once. */
async function boughtMystery(raw: DatabaseSync, revealStage: 'paid' | 'confirmed' | 'preparing' | 'shipped' | 'delivered' = 'delivered') {
  seedMysteryPool(raw);
  const id = addMysteryOffer(raw, { revealStage });
  raw
    .prepare("INSERT INTO offer_limits (subject_type,subject_id,max_per_user,max_global) VALUES ('product',?,1,NULL)")
    .run(id);
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: id, qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  return { db, orderId: res.order.id as string, productId: id };
}

// ------------------------------------------------- rule 3: the bundle slot

test('cancelling a normal bundle order releases its redemption, and the customer may buy again', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await boughtBundle(raw);

  const before = redemption(raw, 'prd_b1')!;
  assert.equal(before.state, 'active', 'a fresh redemption counts against the limit');
  assert.equal(before.released_at, null);

  // The one-per-customer limit is spent: a second purchase is refused.
  await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  const blocked = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(blocked.success, false, 'the limit must bite while the redemption is active');
  assert.equal(blocked.code, 'PER_USER_LIMIT_REACHED');

  const cancelled = await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, {}));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));

  const after = redemption(raw, 'prd_b1')!;
  assert.equal(after.state, 'released', 'a genuine cancellation frees the slot');
  assert.ok(after.released_at, 'and records when');

  // And the freed slot is really usable — the trigger counts active rows only.
  const again = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(again.success, true, `the freed slot must be spendable: ${JSON.stringify(again)}`);
});

test('an ADMIN cancellation frees it too — one statement builder, both routes', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await boughtBundle(raw);

  const res = await json(await patch(appFor(db, admin), `/api/admin/orders/${orderId}`, { status: 'cancelled' }));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(redemption(raw, 'prd_b1')!.state, 'released');
});

// --------------------------------------- rule 4: a failed checkout consumes nothing

test('a checkout that fails writes no redemption row at all', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000, limits: { max_per_user: 1 } });
  const { failing, db } = failingD1(raw);

  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));

  failing.failWhen = (stmts) => stmts.some((s) => s.sql.includes('INSERT INTO orders'));
  const failed = await json(await post(appFor(db), '/api/orders', orderBody()));
  failing.failWhen = null;
  assert.notEqual(failed.success, true, 'the checkout was supposed to fail');

  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE subject_id = ?', 'prd_b1'),
    0,
    'the redemption rides INSIDE the committing batch, so a failed checkout consumes nothing'
  );
  // And the entitlement is genuinely still there.
  const retry = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(retry.success, true, `the entitlement must survive a failed checkout: ${JSON.stringify(retry)}`);
});

// ------------------------------------------------ rules 1 and 5: no re-roll

test('cancelling a MYSTERY order never frees its slot — not even before the reveal', async () => {
  const raw = seedCatalogue();
  const { db, orderId, productId } = await boughtMystery(raw, 'delivered');
  // 'delivered' reveal: nothing is revealed yet, so the customer's own cancel
  // is allowed. This is the exact window a re-roll would live in.
  const cancelled = await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, {}));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));

  const after = redemption(raw, productId)!;
  assert.equal(after.state, 'active', 'a mystery redemption is never released');
  assert.equal(after.released_at, null);

  // The re-roll attempt: buy again on a one-per-customer offer.
  await json(await post(appFor(db), '/api/cart/items', { productId, qty: 1 }));
  const reroll = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(reroll.success, false, 'cancelling a mystery box must not buy another draw');
  assert.equal(reroll.code, 'PER_USER_LIMIT_REACHED');
});

test('a REVEALED mystery refuses the customer cancel, and an admin cancel still frees nothing', async () => {
  const raw = seedCatalogue();
  const { db, orderId, productId } = await boughtMystery(raw, 'confirmed');
  const env = { DB: db } as unknown as Parameters<typeof moveOrderStage>[0];
  await moveOrderStage(env, { orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });

  // The customer's own cancel is refused outright once the pick is visible.
  raw.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(orderId);
  const refused = await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, {}));
  assert.equal(refused.code, 'MYSTERY_REVEALED_NO_CANCEL');

  // An admin may still cancel — and the slot stays spent.
  const byAdmin = await json(await patch(appFor(db, admin), `/api/admin/orders/${orderId}`, { status: 'cancelled' }));
  assert.equal(byAdmin.success, true, JSON.stringify(byAdmin));
  assert.equal(redemption(raw, productId)!.state, 'active', 'a revealed mystery NEVER restores its slot');
});

test('a mixed order holding a bundle AND a mystery frees neither', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000, limits: { max_per_user: 1 } });
  seedMysteryPool(raw);
  const mysteryId = addMysteryOffer(raw, { revealStage: 'delivered' });
  const db = asD1(raw);
  await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  await json(await post(appFor(db), '/api/cart/items', { productId: mysteryId, qty: 1 }));
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));

  const cancelled = await json(await post(appFor(db), `/api/orders/${res.order.id}/cancel`, {}));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));
  assert.equal(redemption(raw, 'prd_b1')!.state, 'active', 'the mystery on the order protects the whole order');
  assert.equal(redemption(raw, mysteryId)!.state, 'active');
});

// ------------------------------------------------------------- the re-open

test('re-opening an unpaid cash-pickup bundle order takes its slot back', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await boughtBundle(raw, 1, 'pickup');

  await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, {}));
  assert.equal(redemption(raw, 'prd_b1')!.state, 'released');

  const reopened = await json(await patch(appFor(db, admin), `/api/admin/orders/${orderId}`, { status: 'pending' }));
  assert.equal(reopened.success, true, JSON.stringify(reopened));
  const back = redemption(raw, 'prd_b1')!;
  assert.equal(back.state, 'active', 'a re-opened order holds its entitlement again');
  assert.equal(back.released_at, null);
});

test('a re-open whose freed slot was spent meanwhile is refused, and the order stays cancelled', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await boughtBundle(raw, 1, 'pickup');

  await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, {}));
  // The customer spends the freed slot on a second order.
  await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  const second = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(second.success, true, JSON.stringify(second));

  const reopen = await json(await patch(appFor(db, admin), `/api/admin/orders/${orderId}`, { status: 'pending' }));
  assert.equal(reopen.success, false, 'the entitlement is genuinely gone — the re-open must not invent one');
  assert.equal(reopen.code, 'OFFER_LIMIT_REACHED');
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM orders WHERE id = ? AND status = 'cancelled'", orderId),
    1,
    'the refused re-claim took the whole re-open with it'
  );
  const env = { DB: db } as unknown as Parameters<typeof moveOrderStage>[0];
  const moved = await moveOrderStage(env, { orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  assert.equal(moved.moved, false);
  assert.equal(moved.reason, 'OFFER_LIMIT_REACHED', 'the stage door must enforce the same spent quota');
  assert.equal(row(raw, 'SELECT status FROM orders WHERE id=?', orderId)?.status, 'cancelled');
});

test('the stage machine re-opens an unpaid cash-pickup bundle with the same rule', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await boughtBundle(raw, 1, 'pickup');
  const env = { DB: db } as unknown as Parameters<typeof moveOrderStage>[0];

  await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, {}));
  assert.equal(redemption(raw, 'prd_b1')!.state, 'released');

  const moved = await moveOrderStage(env, { orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  assert.equal(moved.moved, true, JSON.stringify(moved));
  assert.equal(redemption(raw, 'prd_b1')!.state, 'active', 'a stage re-open reclaims the slot too');
});

test('a bundle whose advance was refunded cannot be reopened through either door', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await boughtBundle(raw);
  assert.ok(Number(row(raw, 'SELECT wallet_applied_usd_cents FROM orders WHERE id=?', orderId)?.wallet_applied_usd_cents) > 0);
  const cancelled = await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, {}));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE id=? AND status='approved'", `wtx_refund_${orderId}_usd`), 1);
  const afterRefund = spendable(raw, 'buyer');

  const legacy = await json(await patch(appFor(db, admin), `/api/admin/orders/${orderId}`, { status: 'pending' }));
  assert.equal(legacy.success, false);
  assert.equal(legacy.code, 'REFUNDED_ORDER');
  const env = { DB: db } as unknown as Parameters<typeof moveOrderStage>[0];
  const stage = await moveOrderStage(env, { orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  assert.equal(stage.moved, false);
  assert.equal(stage.reason, 'REFUNDED_ORDER');
  assert.equal(row(raw, 'SELECT status FROM orders WHERE id=?', orderId)?.status, 'cancelled');
  assert.equal(redemption(raw, 'prd_b1')!.state, 'released');
  assert.equal(spendable(raw, 'buyer'), afterRefund, 'neither refusal recharges nor refunds the wallet again');
});

// ------------------------------------------------------------ the mechanism

test('the limit trigger and the friendly advice both count ACTIVE rows only', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await boughtBundle(raw, 1);
  await json(await post(appFor(db), `/api/orders/${orderId}/cancel`, {}));

  // Straight at the trigger: a released row must not block a new one. A second
  // order row, because (subject, order) is unique — the point is the LIMIT,
  // not that identity.
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
                           payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
       VALUES ('ORD-SECOND','buyer','pending','{}','standard','{}','cash',1,1500,1,1)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO offer_redemptions (id, subject_type, subject_id, user_id, order_id, qty)
       VALUES ('ofr_direct', 'product', 'prd_b1', 'buyer', 'ORD-SECOND', 1)`
    )
    .run();
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM offer_redemptions WHERE subject_id = 'prd_b1' AND state = 'active'"),
    1
  );

  // And an unknown state is refused rather than silently counting as neither.
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT INTO offer_redemptions (id, subject_type, subject_id, user_id, order_id, qty, state)
           VALUES ('ofr_bad', 'product', 'prd_b1', 'buyer', ?, 1, 'nonsense')`
        )
        .run(orderId),
    /OFFER_REDEMPTION_STATE/
  );
});
