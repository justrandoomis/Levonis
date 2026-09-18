/**
 * «الضمان والاسترجاع يبدأ من تاريخ تم التوصيل»
 *
 * The owner stated it plainly, and the code already agrees with them about
 * WHICH column answers: `worker/routes/returns.ts:7-8` runs the seven-day
 * window from `delivered_at`, and `worker/routes/warranty.ts:494` starts the
 * twelve months from it. So `orders.delivered_at` is not an audit timestamp —
 * it is the moment two of the customer's rights begin and, more to the point
 * for the shop, the moment they begin to run out.
 *
 * WHICH IS WHY THE TWO DOORS TO IT MUST NOT DISAGREE, AND THEY DID.
 *
 * There are two ways an order becomes delivered. The stage door
 * (`worker/lib/orderStageOps.ts:177`) has always written
 * `COALESCE(NULLIF(delivered_at,''), ?)` — stamp it once, keep the first. The
 * legacy status door (`worker/routes/admin.ts`) wrote `strftime('now')`
 * unconditionally, on every flip.
 *
 * `ORDER_TRANSITIONS` allows delivered → shipped, one step back, expressly so
 * a mis-tap can be corrected. Correct the mis-tap and press deliver again and
 * the old code moved the delivery date to today: a return window that had
 * already closed re-opened, and a warranty that was a month from expiring got
 * a fresh month. Two admins doing the same thing through two buttons produced
 * two different answers to «متى تسلّم الزبون؟».
 *
 * The customer received the goods once. There is one date.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, patch, json, row, pending } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';
import { moveOrderStage } from '../worker/lib/orderStageOps';

const FIRST_DELIVERY = '2026-03-01T09:00:00.000Z';

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Boss','boss@x.co','h','admin'),
      ('cust','Sara','sara@x.co','h','customer');
    INSERT INTO addresses (id,user_id,name,phone,address)
      VALUES ('a1','cust','Sara','+964770','Baghdad');
    /* Already delivered, a month ago: the return window is spent and the
       warranty is a month into its twelve. */
    INSERT INTO orders
      (id,user_id,status,stage,address_snapshot,delivery_method_id,
       delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,
       exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at)
    VALUES
      ('ORD-CLOCK','cust','delivered','delivered','{}','standard','{}','cod',
       100000,0,1400,100000,0,'2026-02-25T09:00:00.000Z','2026-02-25T09:00:00.000Z',
       '${FIRST_DELIVERY}');
  `);
}

const deliveredAt = (raw: DatabaseSync) =>
  row<{ delivered_at: string | null }>(raw, 'SELECT delivered_at FROM orders WHERE id = ?', 'ORD-CLOCK')!.delivered_at;

const adminApp = (db: D1Database) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => {
    a.route('/api/admin', adminRoutes);
  });

test('THE BUG: correcting a mis-tap through the status door restarted the customer\'s clocks', async () => {
  const raw = freshDb();
  seed(raw);
  const app = adminApp(asD1(raw));

  // One step back — which ORDER_TRANSITIONS allows for exactly this reason —
  // and forward again.
  const back = await json(await patch(app, '/api/admin/orders/ORD-CLOCK', { status: 'shipped' }));
  assert.equal(back.success, true, JSON.stringify(back));
  const again = await json(await patch(app, '/api/admin/orders/ORD-CLOCK', { status: 'delivered' }));
  assert.equal(again.success, true, JSON.stringify(again));

  assert.equal(
    deliveredAt(raw),
    FIRST_DELIVERY,
    'the goods arrived once — a re-flip must not move the warranty start or re-open a closed return window'
  );
  await Promise.allSettled(pending);
});

test('the stage door answers the same, because there is only one delivery date', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);

  // Take it back through the status door, then deliver it through the OTHER
  // door. Whichever button the admin reaches for, the answer is the same.
  await json(await patch(adminApp(db), '/api/admin/orders/ORD-CLOCK', { status: 'shipped' }));
  const moved = await moveOrderStage(
    { DB: db } as never,
    { orderId: 'ORD-CLOCK', to: 'delivered', actorId: 'boss', source: 'manual' } as never
  );
  assert.ok(moved, 'the stage move ran');
  assert.equal(deliveredAt(raw), FIRST_DELIVERY, 'two doors, one date');
  await Promise.allSettled(pending);
});

test('and an order delivered for the FIRST time still gets a date', async () => {
  // The guard is COALESCE(NULLIF(...)), so it must not swallow the stamp on an
  // order that has never been delivered — which is the only way this fix could
  // be worse than the bug.
  const raw = freshDb();
  seed(raw);
  raw.exec(`UPDATE orders SET status='shipped', stage='out_for_delivery', delivered_at=NULL WHERE id='ORD-CLOCK'`);
  const app = adminApp(asD1(raw));

  const res = await json(await patch(app, '/api/admin/orders/ORD-CLOCK', { status: 'delivered' }));
  assert.equal(res.success, true, JSON.stringify(res));
  const at = deliveredAt(raw);
  assert.ok(at && at > FIRST_DELIVERY, `a first delivery is stamped now, got ${at}`);
  await Promise.allSettled(pending);
});

test('an empty string counts as never delivered, not as a delivery at the epoch', async () => {
  // The stage door has always written NULLIF(delivered_at,'') and this schema
  // stores '' for "not yet" in several places, so a bare COALESCE would read
  // '' as a real value and leave the order permanently undated.
  const raw = freshDb();
  seed(raw);
  raw.exec(`UPDATE orders SET status='shipped', stage='out_for_delivery', delivered_at='' WHERE id='ORD-CLOCK'`);
  const app = adminApp(asD1(raw));

  await json(await patch(app, '/api/admin/orders/ORD-CLOCK', { status: 'delivered' }));
  const at = deliveredAt(raw);
  assert.ok(at && at.length > 10, `'' must not survive as the delivery date, got ${JSON.stringify(at)}`);
  await Promise.allSettled(pending);
});
