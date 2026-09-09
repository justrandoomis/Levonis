/**
 * THE EXPIRY SWEEP NEVER TAKES AN ORDER SOMEBODY IS STILL PAYING FOR
 * (owner decision 5).
 *
 * The owner's words: *"expire only genuinely unpaid/unconfirmed temporary
 * reservations; never expire confirmed, fulfilled, COD-confirmed, or
 * legitimately pending operational orders … The customer must never lose a
 * legitimately confirmed order because a cleanup job ran."*
 *
 * The trap this file exists to hold shut is that `pending` DOES NOT MEAN
 * UNPAID. Checkout writes `status = 'pending'` for a fully wallet-prepaid
 * order too, and an admin may walk an order backwards from `confirmed` to
 * `pending` — so a status-only filter would cancel a paid order and refund it
 * as though nobody had ever confirmed it. Every negative test below is one of
 * those orders, and each asserts the order is untouched.
 *
 * The positive cases are just as load-bearing: an expiry that never fires is
 * a feature that does not exist, and a released component that stayed reserved
 * would mean a bundle reading "sold out" while nobody has paid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, json, row, count, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { sweepExpiredOrders } from '../worker/lib/orderExpirySweep';
import { resolveOrderExpiry, DEFAULT_ORDER_EXPIRY, MIN_TTL_MINUTES } from '../worker/lib/orderExpiry';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { addBundle, seedCatalogue, orderBody } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

const ON = { enabled: true, ttl_minutes: 60, batch_limit: 100 };
const NOW = '2026-03-01T12:00:00.000Z';
/** Two hours before NOW: past a 60-minute TTL. */
const LONG_AGO = '2026-03-01T10:00:00.000Z';

const envOf = (db: unknown) => ({ DB: db }) as unknown as Parameters<typeof sweepExpiredOrders>[0];

const orderOf = (raw: DatabaseSync, id: string) =>
  row<{ status: string; stage: string }>(raw, 'SELECT status, stage FROM orders WHERE id = ?', id)!;

const reserved = (raw: DatabaseSync, productId: string) =>
  Number(row<{ stock_reserved: number }>(raw, 'SELECT stock_reserved FROM products WHERE id = ?', productId)!.stock_reserved);

/**
 * ONE GENUINELY ABANDONED COD ORDER, left untouched since `at`.
 *
 * Two things the fixture has to arrange, and both are the reason this is a
 * helper rather than three lines inline. The seeded buyer has a funded wallet
 * and checkout SPENDS it whenever it covers the total, so a "COD" order made
 * the naive way is in fact fully prepaid — which the sweep correctly refuses
 * to touch. And a bundle holding a printer demands an advance payment, so it
 * cannot be COD at all. Hence: empty the wallet, and a printer-free bundle.
 */
async function abandonedOrder(raw: DatabaseSync, at = LONG_AGO, body: Record<string, unknown> = {}) {
  raw.exec("DELETE FROM wallet_transactions WHERE user_id = 'buyer'");
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    priceIqd: 60_000,
    components: [
      { id: 'bc_pla', product: 'p_pla', qty: 2 },
      { id: 'bc_nozzle', product: 'p_nozzle', qty: 1 },
    ],
  });
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(await post(appFor(db), '/api/orders', orderBody(body)));
  assert.equal(res.success, true, JSON.stringify(res));
  const id = res.order.id as string;
  raw.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(at, id);
  return { db, raw, orderId: id };
}

/** A PREPAID order: the wallet is left funded, so checkout spends it. */
async function prepaidOrder(raw: DatabaseSync, at = LONG_AGO) {
  addBundle(raw, { id: 'prd_b2', slug: 'prepaid', priceIqd: 60_000, components: [{ id: 'bc_pla2', product: 'p_pla', qty: 1 }] });
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b2', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(await post(appFor(db), '/api/orders', orderBody({ useWallet: true })));
  assert.equal(res.success, true, JSON.stringify(res));
  const id = res.order.id as string;
  raw.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(at, id);
  return { db, raw, orderId: id };
}

// ------------------------------------------------------------ it is OFF

test('the shipped default expires nothing at all', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);

  const report = await sweepExpiredOrders(envOf(db), DEFAULT_ORDER_EXPIRY, NOW);
  assert.deepEqual(report, { configured: false, scanned: 0, cancelled: 0, skipped: 0, errors: 0 });
  assert.equal(orderOf(raw, orderId).status, 'pending', 'nothing happens until an owner turns it on');
});

test('enabled with ttl 0 is still off — "enabled" alone is not a policy', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);
  const report = await sweepExpiredOrders(envOf(db), { enabled: true, ttl_minutes: 0, batch_limit: 100 }, NOW);
  assert.equal(report.configured, false);
  assert.equal(orderOf(raw, orderId).status, 'pending');
});

// ------------------------------------------------------- it does its job

test('an abandoned COD order is cancelled and every component goes back on the shelf', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);
  assert.equal(reserved(raw, 'p_pla'), 2, 'the checkout is holding both spools');
  assert.equal(reserved(raw, 'p_nozzle'), 1);

  const report = await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(report.cancelled, 1, JSON.stringify(report));
  assert.equal(orderOf(raw, orderId).status, 'cancelled');
  assert.equal(reserved(raw, 'p_pla'), 0, 'the spools are sellable again');
  assert.equal(reserved(raw, 'p_nozzle'), 0);
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind = 'release'", orderId),
    2,
    'every component released — one ledger row each'
  );
  // The customer can see WHY, and the audit trail says who.
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = ? AND source = 'system'", orderId),
    1
  );
});

test('an order still inside its TTL is left alone', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw, '2026-03-01T11:30:00.000Z'); // 30 min < 60
  const report = await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(report.scanned, 0);
  assert.equal(orderOf(raw, orderId).status, 'pending');
});

test('running the sweep twice changes nothing the second time', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);
  const first = await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(first.cancelled, 1);
  const ledgerAfterFirst = count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ?', orderId);

  const second = await sweepExpiredOrders(envOf(db), ON, '2026-03-01T13:00:00.000Z');
  assert.equal(second.scanned, 0, 'a cancelled order is no longer a candidate');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ?', orderId), ledgerAfterFirst);
  assert.equal(reserved(raw, 'p_pla'), 0, 'and nothing was released twice');
});

// ------------------------------------------- it never takes a real order

test('a WALLET-PREPAID pending order is never expired — pending does not mean unpaid', async () => {
  const raw = seedCatalogue();
  const { db, raw: r, orderId } = await prepaidOrder(raw);
  const paid = row<{ wallet_applied_iqd: number }>(r, 'SELECT wallet_applied_iqd FROM orders WHERE id = ?', orderId)!;
  assert.ok(Number(paid.wallet_applied_iqd) > 0, 'the fixture really did pay from the wallet');

  const report = await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(report.scanned, 0, 'money was taken — this is not an abandoned checkout');
  assert.equal(orderOf(r, orderId).status, 'pending');
});

test('a CONFIRMED order is never expired, even after an admin walks it back to pending', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);
  const env = { DB: db } as unknown as Parameters<typeof moveOrderStage>[0];
  await moveOrderStage(env, { orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });

  // The exact case a status-only filter gets wrong: back to pending, with the
  // stock already deducted and the history carrying a human's move.
  raw.prepare("UPDATE orders SET status = 'pending', stage = 'received', updated_at = ? WHERE id = ?").run(LONG_AGO, orderId);

  const report = await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(report.scanned, 0, 'the deduct ledger row and the history both refuse it');
  assert.equal(orderOf(raw, orderId).status, 'pending', 'a confirmed order is never lost to the clock');
});

test('an order with a COLLECTED settlement is never expired', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);
  raw
    .prepare(
      `INSERT INTO order_payment_settlements (id, order_id, event_key, kind, amount_iqd, recorded_by, actor_id, settled_at)
       VALUES ('ops_1', ?, 'cod:x', 'cod_collection', 1000, 'admin', 'boss', ?)`
    )
    .run(orderId, LONG_AGO);

  const report = await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(report.scanned, 0, 'money has been collected on this order');
  assert.equal(orderOf(raw, orderId).status, 'pending');
});

test('an order a human has already moved is never expired', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);
  raw
    .prepare(
      `INSERT INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
       VALUES ('osh_x', ?, 'preparing', 'processing', 'manual', ?, 'boss', '')`
    )
    .run(orderId, LONG_AGO);

  const report = await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(report.scanned, 0, 'somebody is working on this order');
});

test('a merchant store order is never expired by the platform sweep', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);
  raw.prepare("UPDATE orders SET origin = 'store_product', seller_type = 'merchant' WHERE id = ?").run(orderId);

  const report = await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(report.scanned, 0, 'a merchant order is not this job to cancel');
});

test('a re-opened order restarts its clock instead of being swept again every 15 minutes', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await abandonedOrder(raw);
  await sweepExpiredOrders(envOf(db), ON, NOW);
  assert.equal(orderOf(raw, orderId).status, 'cancelled');

  // An admin deliberately re-opens it. `updated_at` moves with the re-open, so
  // the order is fresh again — a sweep keyed on created_at would cancel it
  // again on the very next cron run, for ever, invisibly.
  const reopenedAt = '2026-03-01T12:05:00.000Z';
  raw
    .prepare("UPDATE orders SET status = 'pending', stage = 'received', updated_at = ? WHERE id = ?")
    .run(reopenedAt, orderId);
  raw.prepare('DELETE FROM order_status_history WHERE order_id = ?').run(orderId);
  raw.prepare('DELETE FROM inventory_ledger WHERE order_id = ?').run(orderId);

  const after = await sweepExpiredOrders(envOf(db), ON, '2026-03-01T12:20:00.000Z');
  assert.equal(after.scanned, 0, 'the re-opened order gets its full TTL again');
  assert.equal(orderOf(raw, orderId).status, 'pending');
});

// ---------------------------------------------------------- the config

test('the config is clamped by the same function the admin route validates with', () => {
  assert.deepEqual(resolveOrderExpiry(undefined), DEFAULT_ORDER_EXPIRY);
  assert.deepEqual(resolveOrderExpiry('nonsense'), DEFAULT_ORDER_EXPIRY);
  assert.deepEqual(resolveOrderExpiry({ enabled: 'yes' }), DEFAULT_ORDER_EXPIRY, 'only a real boolean turns it on');

  // A TTL under the cron's own cadence cannot mean what it says.
  assert.equal(resolveOrderExpiry({ enabled: true, ttl_minutes: 5 }).ttl_minutes, MIN_TTL_MINUTES);
  assert.equal(resolveOrderExpiry({ enabled: true, ttl_minutes: -10 }).ttl_minutes, 0, 'negative is not a TTL');
  assert.equal(resolveOrderExpiry({ enabled: true, ttl_minutes: 99_999_999 }).ttl_minutes, 365 * 24 * 60);

  assert.equal(resolveOrderExpiry({ batch_limit: 0 }).batch_limit, DEFAULT_ORDER_EXPIRY.batch_limit);
  assert.equal(resolveOrderExpiry({ batch_limit: 9_000 }).batch_limit, 500);
  assert.equal(resolveOrderExpiry({ enabled: true, ttl_minutes: '120' }).ttl_minutes, 120, 'a form posts strings');
});

test('batch_limit bounds one run, and the rest wait for the next', async () => {
  const raw = seedCatalogue();
  raw.exec("DELETE FROM wallet_transactions WHERE user_id = 'buyer'");
  const db = asD1(raw);
  for (let i = 0; i < 3; i += 1) {
    await json(await post(appFor(db), '/api/cart/items', { productId: 'p_nozzle', qty: 1 }));
    const res = await json(await post(appFor(db), '/api/orders', orderBody()));
    assert.equal(res.success, true, JSON.stringify(res));
    raw.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(LONG_AGO, res.order.id);
  }
  const first = await sweepExpiredOrders(envOf(db), { enabled: true, ttl_minutes: 60, batch_limit: 2 }, NOW);
  assert.equal(first.cancelled, 2, 'exactly the batch limit');
  const second = await sweepExpiredOrders(envOf(db), { enabled: true, ttl_minutes: 60, batch_limit: 2 }, NOW);
  assert.equal(second.cancelled, 1, 'the remainder on the next run');
});
