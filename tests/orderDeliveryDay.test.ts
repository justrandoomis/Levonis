/**
 * THE DELIVERY DAY, WIRED INTO AN ORDER'S LIFE — the parts the foundation's
 * own tests could not reach, because every one of them needs a real order.
 *
 * tests/deliveryDay.test.ts pins the pure rules: the anchor, the frozen
 * ceiling, the three refusal codes, the label, the migration's shape CHECK.
 * What it cannot see is whether anything ever WRITES those columns, or whether
 * the row a customer holds agrees with them. So everything here runs against
 * real migrations through the real routes:
 *
 *   * a pickup and a merchant order are never schedulable — the two order
 *     shapes that have no last mile of ours at all, and the two that a
 *     hardcoded `id === 'pickup'` test gets wrong in opposite directions;
 *   * a pre-order becomes schedulable on entering `at_levo_warehouse`, and
 *     does NOT when that move lost its race — which is the whole reason the
 *     window rides inside the flip statement instead of following it;
 *   * the PATCH is refused once the courier holds the parcel, by either of the
 *     two facts that say so (`delivery_remote_id`, or the stage);
 *   * and — the one that protects the fact the schema was designed around —
 *     scheduling a day leaves `next_stage_at` EXACTLY as `orderStages`
 *     computed it. A day stored in that column defers the order's own
 *     preparation by the length of the postponement, and nothing anywhere
 *     throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, failingD1, freshDb, get, json, patch, post, row, stubApp } from './fixtures/app';
import { acceptedPolicies } from './lib/policies';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { addDays, baghdadDay, baghdadDayOf } from '../worker/lib/baghdadTime';
import type { Env } from '../worker/lib/types';

const SEA = JSON.stringify([{ method: 'sea', commission_iqd: 15_000, active: true }]);
const TODAY = () => baghdadDay(Date.now());

// ------------------------------------------------------------------ fixture

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('stranger','Omar','o@x.co','h','customer'),
      ('boss','Admin','a@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',100000,'approved');
  `);
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,direct_surcharge_iqd,images)
       VALUES ('p_a1','a1','Bambu A1','بامبو A1',100000,'active',10,'[]','[]','direct_sale','["direct_sale","pre_order"]',?,50000,'[]')`
    )
    .run(SEA);
  return { raw, db: asD1(raw) };
}

const envOf = (db: D1Database) => ({ DB: db }) as unknown as Env;

const appAs = (db: D1Database, id: string, role: 'customer' | 'admin' = 'customer') =>
  stubApp(db, { id, role, email: `${id}@x.co` }, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/cart', cartRoutes);
  });

/** One cart line; '' = a direct line, 'sea' = a pre-order one. */
function cartLine(raw: DatabaseSync, id: string, product: string, transport: '' | 'sea') {
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?, 'buyer', ?, '', '[]', '', '', ?, '', 1)`
    )
    .run(id, product, transport);
}

let seq = 0;
const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  itemIds: [],
  useWallet: false,
  usePoints: false,
  idempotencyKey: `dd-${Date.now()}-${++seq}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});

interface OrderDayRow {
  stage: string;
  status: string;
  next_stage_at: string | null;
  delivery_due_day: string | null;
  delivery_day_window_end: string | null;
  delivery_day_schedulable: number;
  delivery_day_source: string;
  delivery_day_changed_at: string | null;
  delivery_day_changes: number;
}
const dayRow = (raw: DatabaseSync, id: string) =>
  row<OrderDayRow>(
    raw,
    `SELECT stage, status, next_stage_at, delivery_due_day, delivery_day_window_end,
            delivery_day_schedulable, delivery_day_source, delivery_day_changed_at, delivery_day_changes
       FROM orders WHERE id = ?`,
    id
  )!;

/**
 * An order row written directly, for the shapes that never pass through
 * platform checkout — a merchant sale, and a pre-order parked mid-journey.
 */
function insertOrder(raw: DatabaseSync, id: string, over: Record<string, unknown> = {}) {
  const o = {
    user_id: 'buyer',
    status: 'processing',
    stage: 'en_route_to_levo',
    shipping_type: 'preorder_sea',
    seller_type: 'levonis',
    delivery_method_id: 'standard',
    delivery_method_snapshot: JSON.stringify({ id: 'standard', home_delivery: true }),
    delivery_remote_id: '',
    delivery_day_schedulable: 0,
    delivery_day_window_end: null as string | null,
    delivery_due_day: null as string | null,
    created_at: new Date().toISOString(),
    ...over,
  };
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, stage, shipping_type, seller_type, address_snapshot,
         delivery_method_id, delivery_method_snapshot, delivery_remote_id, payment_method_id,
         subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd,
         delivery_day_schedulable, delivery_day_window_end, delivery_due_day,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,'{"name":"Sara","phone":"+9647701234567"}',?,?,?,'cash',
               100000,5000,1400,105000,105000,?,?,?,?,?)`
    )
    .run(
      id, o.user_id, o.status, o.stage, o.shipping_type, o.seller_type,
      o.delivery_method_id, o.delivery_method_snapshot, o.delivery_remote_id,
      o.delivery_day_schedulable, o.delivery_day_window_end, o.delivery_due_day,
      o.created_at, o.created_at
    );
  return id;
}

// =========================================================================
//  THE TWO ORDER SHAPES THAT NEVER GET A DAY
// =========================================================================

test('a PICKUP order is never schedulable, and a day sent with it is refused rather than dropped', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_pick', 'p_a1', '');
  const a = appAs(db, 'buyer');

  // Sending a day for an order that can never have one is a REFUSAL. Dropping
  // it silently would print a confirmation with no day on it to a customer who
  // is certain they chose Thursday.
  const refused = await json(
    await post(a, '/api/orders', orderBody({ deliveryMethodId: 'pickup', requestedDeliveryDate: addDays(TODAY(), 2) }))
  );
  assert.equal(refused.success, false);
  assert.equal(refused.code, 'DELIVERY_DAY_NOT_OFFERED');

  const created = await json(await post(a, '/api/orders', orderBody({ deliveryMethodId: 'pickup' })));
  assert.equal(created.success, true, JSON.stringify(created));
  const r = dayRow(raw, created.order.id);
  assert.equal(r.delivery_day_schedulable, 0, 'nobody is driving anywhere');
  assert.equal(r.delivery_day_window_end, null, 'and there is no ceiling to freeze');
  assert.equal(r.delivery_due_day, null);

  // The screen gets the SENTENCE, not a disabled control.
  const shown = await json(await get(a, `/api/orders/${created.order.id}`));
  assert.equal(shown.order.delivery_date.can_change, false);
  assert.equal(shown.order.delivery_date.reason, 'PICKUP');
  assert.deepEqual(shown.order.delivery_date.days, []);
  assert.equal(shown.order.delivery_day_schedulable, false);
});

test('a MERCHANT order is never schedulable — its id is not in checkoutDeliveryMethods at all', async () => {
  const { raw, db } = setup();
  // The shape worker/routes/storeOrders.ts writes: no platform delivery method,
  // and a snapshot carrying no id. `deliversToHome`'s id fallback would answer
  // "home delivery" for every one of these, which is exactly why the merchant
  // case is refused by name.
  insertOrder(raw, 'ORD-MERCH', {
    seller_type: 'merchant',
    delivery_method_id: 'merchant',
    delivery_method_snapshot: JSON.stringify({ by: 'merchant', store: 'Some Store' }),
    shipping_type: 'direct',
    stage: 'received',
    status: 'pending',
  });
  const shown = await json(await get(appAs(db, 'buyer'), '/api/orders/ORD-MERCH'));
  assert.equal(shown.order.delivery_day_schedulable, false);
  assert.equal(shown.order.delivery_date.can_change, false);
  assert.equal(shown.order.delivery_date.reason, 'PICKUP', 'no last mile of ours to schedule');
  assert.equal(dayRow(raw, 'ORD-MERCH').delivery_day_schedulable, 0);
});

// =========================================================================
//  CHECKOUT FREEZES THE CEILING
// =========================================================================

test('a direct home delivery is schedulable at checkout, with the ceiling frozen at order day + 7', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_1', 'p_a1', '');
  const a = appAs(db, 'buyer');
  const res = await json(await post(a, '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));

  const r = dayRow(raw, res.order.id);
  const created = row<{ created_at: string }>(raw, 'SELECT created_at FROM orders WHERE id = ?', res.order.id)!;
  assert.equal(r.delivery_day_schedulable, 1);
  assert.equal(
    r.delivery_day_window_end,
    addDays(baghdadDayOf(created.created_at), 7),
    'seven days from the order DAY in Baghdad, not from the sliced UTC string'
  );
  // NO DAY IS FORCED. Absent means "as soon as possible", which is what a
  // checkout with five steps already should not be adding a sixth to.
  assert.equal(r.delivery_due_day, null);
  assert.equal(r.delivery_day_source, '');
  assert.equal(r.delivery_day_changes, 0, 'a first value is not a change to one');
  assert.equal(r.delivery_day_changed_at, null);

  // …and the payload carries all three facts beside next_stage_at.
  assert.equal(res.order.delivery_due_day, null);
  assert.equal(res.order.delivery_day_window_end, r.delivery_day_window_end);
  assert.equal(res.order.delivery_day_schedulable, true);
});

test('a day chosen AT checkout is written with source=customer; one past the ceiling is refused', async () => {
  const { raw, db } = setup();
  const a = appAs(db, 'buyer');

  cartLine(raw, 'ci_far', 'p_a1', '');
  const tooFar = await json(await post(a, '/api/orders', orderBody({ requestedDeliveryDate: addDays(TODAY(), 8) })));
  assert.equal(tooFar.success, false);
  assert.equal(tooFar.code, 'DELIVERY_DAY_BEYOND_WINDOW');

  const past = await json(await post(a, '/api/orders', orderBody({ requestedDeliveryDate: addDays(TODAY(), -1) })));
  assert.equal(past.code, 'DELIVERY_DAY_PAST');

  const junk = await json(await post(a, '/api/orders', orderBody({ requestedDeliveryDate: '2026-02-31' })));
  assert.equal(junk.code, 'DELIVERY_DAY_INVALID', 'the shape passes the GLOB; the calendar does not');

  const ok = await json(await post(a, '/api/orders', orderBody({ requestedDeliveryDate: addDays(TODAY(), 3) })));
  assert.equal(ok.success, true, JSON.stringify(ok));
  const r = dayRow(raw, ok.order.id);
  assert.equal(r.delivery_due_day, addDays(TODAY(), 3));
  assert.equal(r.delivery_day_source, 'customer', '"the customer asked for Thursday" is not "we defaulted to Thursday"');
});

test('THE CEILING IS THE ROW’S, NOT TODAY + 7 — which is what makes the week un-gameable', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_roll', 'p_a1', '');
  const a = appAs(db, 'buyer');
  const res = await json(await post(a, '/api/orders', orderBody()));
  const id = res.order.id;

  // The same row five days later: the ceiling it was SOLD is two days out.
  // A window recomputed from today would offer a whole fresh week here, and
  // the customer would walk the order forward for ever in weekly hops.
  raw.prepare('UPDATE orders SET delivery_day_window_end = ? WHERE id = ?').run(addDays(TODAY(), 2), id);

  const beyond = await json(await patch(a, `/api/orders/${id}/delivery-date`, { date: addDays(TODAY(), 3) }));
  assert.equal(beyond.code, 'DELIVERY_DAY_BEYOND_WINDOW');
  assert.deepEqual(beyond.details, { window_end: addDays(TODAY(), 2) });

  const atTheCeiling = await json(await patch(a, `/api/orders/${id}/delivery-date`, { date: addDays(TODAY(), 2) }));
  assert.equal(atTheCeiling.success, true, 'the ceiling day itself is legal — it is inclusive');
  assert.equal(dayRow(raw, id).delivery_due_day, addDays(TODAY(), 2));

  // And the offer the screen draws stops at the same place.
  const shown = await json(await get(a, `/api/orders/${id}`));
  assert.equal(shown.order.delivery_date.window_end, addDays(TODAY(), 2));
  assert.deepEqual(
    shown.order.delivery_date.days.map((d: { day: string }) => d.day),
    [TODAY(), addDays(TODAY(), 1), addDays(TODAY(), 2)]
  );
  // The server localises; the SPA renders the string it was handed.
  assert.equal(shown.order.delivery_date.days[0].label, 'اليوم');
  assert.equal(shown.order.delivery_date.days[1].label, 'غدًا');
});

// =========================================================================
//  THE CUSTOMER CHANGES IT
// =========================================================================

test('the customer moves the day «في أي وقت يريد» — the destination is bound, the count is only recorded', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_move', 'p_a1', '');
  const a = appAs(db, 'buyer');
  const id = (await json(await post(a, '/api/orders', orderBody()))).order.id;

  for (const n of [1, 4, 2]) {
    const res = await json(await patch(a, `/api/orders/${id}/delivery-date`, { date: addDays(TODAY(), n) }));
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(res.delivery_date.selected, addDays(TODAY(), n));
    assert.equal(res.delivery_date.can_change, true);
    assert.equal(res.delivery_date.reason, null);
  }
  const moved = dayRow(raw, id);
  assert.equal(moved.delivery_due_day, addDays(TODAY(), 2), 'three legal moves, no quota');
  assert.equal(moved.delivery_day_changes, 3, 'but a customer who moves it eleven times is visible');
  assert.ok(moved.delivery_day_changed_at);

  // `null` CLEARS it — "as soon as possible" is a choice like any other.
  const cleared = await json(await patch(a, `/api/orders/${id}/delivery-date`, { date: null }));
  assert.equal(cleared.success, true);
  assert.equal(cleared.delivery_date.selected, null);
  const after = dayRow(raw, id);
  assert.equal(after.delivery_due_day, null);
  assert.equal(after.delivery_day_source, '', 'nobody is claiming a day was chosen');
  assert.equal(after.delivery_day_changes, 4);

  assert.equal(
    (await patch(a, `/api/orders/${id}/delivery-date`, { date: 'next tuesday' })).status,
    400,
    'a day is a civil date, never free text'
  );
});

test('only the OWNER may move the day — a stranger and an admin both get the order’s absence', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_own', 'p_a1', '');
  const id = (await json(await post(appAs(db, 'buyer'), '/api/orders', orderBody()))).order.id;
  const day = { date: addDays(TODAY(), 1) };

  assert.equal((await patch(appAs(db, 'stranger'), `/api/orders/${id}/delivery-date`, day)).status, 404);
  // An admin changing a customer's promised day is a support action with its
  // own trail, not this route — and it must not be a way to enumerate orders.
  assert.equal((await patch(appAs(db, 'boss', 'admin'), `/api/orders/${id}/delivery-date`, day)).status, 404);
  assert.equal(dayRow(raw, id).delivery_due_day, null, 'and nothing was written');
});

// =========================================================================
//  THE SHIPMENT IS A HARD BOUNDARY
// =========================================================================

test('once `delivery_remote_id` is set the day is refused — there is no updateShipment to carry it', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_ship', 'p_a1', '');
  const a = appAs(db, 'buyer');
  const id = (await json(await post(a, '/api/orders', orderBody()))).order.id;

  raw.prepare("UPDATE orders SET delivery_remote_id = 'AW-99', delivery_provider = 'alwaseet' WHERE id = ?").run(id);

  const res = await patch(a, `/api/orders/${id}/delivery-date`, { date: addDays(TODAY(), 2) });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'DELIVERY_DAY_WITH_COURIER');
  assert.equal(dayRow(raw, id).delivery_due_day, null);

  const shown = await json(await get(a, `/api/orders/${id}`));
  assert.equal(shown.order.delivery_date.reason, 'WITH_COURIER');
  assert.equal(shown.order.delivery_date.can_change, false);
});

test('once the stage is out_for_delivery the day is refused, shipment row or not', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_ofd', 'p_a1', '');
  const a = appAs(db, 'buyer');
  const id = (await json(await post(a, '/api/orders', orderBody()))).order.id;

  // The courier sync moves the stage without necessarily leaving a remote id
  // behind on every path, so the stage is checked in its own right.
  raw.prepare("UPDATE orders SET stage = 'out_for_delivery', status = 'shipped' WHERE id = ?").run(id);

  const res = await patch(a, `/api/orders/${id}/delivery-date`, { date: addDays(TODAY(), 2) });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'DELIVERY_DAY_WITH_COURIER');

  raw.prepare("UPDATE orders SET stage = 'delivered', status = 'delivered' WHERE id = ?").run(id);
  const done = await json(await patch(a, `/api/orders/${id}/delivery-date`, { date: addDays(TODAY(), 2) }));
  assert.equal(done.code, 'DELIVERY_DAY_FINISHED');
  assert.equal(dayRow(raw, id).delivery_due_day, null, 'neither refusal wrote anything');
});

// =========================================================================
//  THE PRE-ORDER WINDOW OPENS AT at_levo_warehouse
// =========================================================================

test('a pre-order is NOT schedulable in transit, and becomes schedulable on entering at_levo_warehouse', async () => {
  const { raw, db } = setup();
  insertOrder(raw, 'ORD-PRE', { status: 'shipped' });
  const a = appAs(db, 'buyer');

  const before = await json(await get(a, '/api/orders/ORD-PRE'));
  assert.equal(before.order.delivery_day_schedulable, false);
  assert.equal(before.order.delivery_date.reason, 'PREORDER_NOT_ARRIVED');
  assert.equal(
    before.order.delivery_date.window_end,
    null,
    'a container ninety days out has no honest seven-day window to name'
  );

  const at = '2026-09-19T08:00:00.000Z';
  const moved = await moveOrderStage(envOf(db), {
    orderId: 'ORD-PRE',
    to: 'at_levo_warehouse',
    source: 'manual',
    now: at,
  });
  assert.equal(moved.moved, true);

  const r = dayRow(raw, 'ORD-PRE');
  assert.equal(r.delivery_day_schedulable, 1);
  assert.equal(
    r.delivery_day_window_end,
    addDays(baghdadDayOf(at), 7),
    're-anchored from the day the goods actually arrived, not from the order date'
  );

  // Stepping back and forward again does NOT hand out a second week.
  await moveOrderStage(envOf(db), { orderId: 'ORD-PRE', to: 'en_route_to_levo', source: 'manual', now: at });
  await moveOrderStage(envOf(db), {
    orderId: 'ORD-PRE',
    to: 'at_levo_warehouse',
    source: 'manual',
    now: '2026-10-30T08:00:00.000Z',
  });
  assert.equal(dayRow(raw, 'ORD-PRE').delivery_day_window_end, addDays(baghdadDayOf(at), 7), 'frozen once');
});

test('a pickup pre-order and a merchant order get no window at at_levo_warehouse either', async () => {
  const { raw, db } = setup();
  insertOrder(raw, 'ORD-PICKPRE', {
    status: 'shipped',
    delivery_method_id: 'pickup',
    delivery_method_snapshot: JSON.stringify({ id: 'pickup', home_delivery: false }),
  });
  insertOrder(raw, 'ORD-MPRE', {
    status: 'shipped',
    seller_type: 'merchant',
    delivery_method_id: 'merchant',
    delivery_method_snapshot: JSON.stringify({ by: 'merchant', store: 'Some Store' }),
  });
  for (const id of ['ORD-PICKPRE', 'ORD-MPRE']) {
    const res = await moveOrderStage(envOf(db), { orderId: id, to: 'at_levo_warehouse', source: 'manual' });
    assert.equal(res.moved, true, `${id} still moves`);
    assert.equal(dayRow(raw, id).delivery_day_schedulable, 0, `${id} earns no window`);
    assert.equal(dayRow(raw, id).delivery_day_window_end, null);
  }
});

test('A MOVE THAT LOST ITS RACE OPENS NO WINDOW — which is why the SET rides the flip', async () => {
  const { raw } = setup();
  const { failing, db } = failingD1(raw);
  insertOrder(raw, 'ORD-RACE', { status: 'shipped' });

  // Another mover wins between the read and the flip. The flip's own
  // `WHERE stage = ?` then matches nothing, so the move reports RACED — and a
  // window opened by a SECOND, unfenced UPDATE would have opened anyway, on an
  // order this caller never moved.
  failing.beforeBatch = () => {
    raw.exec("UPDATE orders SET stage = 'at_levo_warehouse' WHERE id = 'ORD-RACE'");
  };
  const res = await moveOrderStage(envOf(db), { orderId: 'ORD-RACE', to: 'at_levo_warehouse', source: 'manual' });
  assert.equal(res.moved, false);
  assert.equal(res.reason, 'RACED');
  assert.equal(dayRow(raw, 'ORD-RACE').delivery_day_schedulable, 0, 'the loser promised the customer nothing');
});

test('re-opening a cancelled order clears the day and re-anchors the ceiling from today', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_reopen', 'p_a1', '');
  const a = appAs(db, 'buyer');
  const id = (await json(await post(a, '/api/orders', orderBody({ requestedDeliveryDate: addDays(TODAY(), 2) })))).order.id;

  await moveOrderStage(envOf(db), { orderId: id, to: 'cancelled', source: 'manual' });
  // Months later — `canMoveStage` puts a cancelled order back at `confirmed`
  // with no time limit, and the ceiling it carries shut long ago. Left alone,
  // the customer reopens the picker to zero legal chips.
  raw.prepare('UPDATE orders SET delivery_day_window_end = ?, delivery_due_day = ? WHERE id = ?')
    .run('2026-01-05', '2026-01-03', id);

  const back = await moveOrderStage(envOf(db), { orderId: id, to: 'confirmed', source: 'manual' });
  assert.equal(back.moved, true);
  const r = dayRow(raw, id);
  assert.equal(r.delivery_due_day, null, 'nobody has chosen a day for THIS attempt');
  assert.equal(r.delivery_day_source, '');
  assert.equal(r.delivery_day_window_end, addDays(TODAY(), 7));
  assert.equal(r.delivery_day_schedulable, 1);

  const shown = await json(await get(a, `/api/orders/${id}`));
  assert.equal(shown.order.delivery_date.can_change, true);
  assert.equal(shown.order.delivery_date.days.length, 8, 'a picker with chips in it again');
});

// =========================================================================
//  THE FACT THE WHOLE SCHEMA WAS BUILT AROUND
// =========================================================================

test('scheduling a day leaves next_stage_at EXACTLY as orderStages computed it', async () => {
  const { raw, db } = setup();
  cartLine(raw, 'ci_clock', 'p_a1', '');
  const a = appAs(db, 'buyer');
  const id = (await json(await post(a, '/api/orders', orderBody()))).order.id;

  // Confirmed is where the clock starts: `preparing` is an AUTOMATIC stage, so
  // the order now carries a real alarm twenty minutes out.
  await moveOrderStage(envOf(db), { orderId: id, to: 'confirmed', source: 'manual' });
  const armed = dayRow(raw, id);
  assert.ok(armed.next_stage_at, 'the sweep has something to promote');

  const res = await json(await patch(a, `/api/orders/${id}/delivery-date`, { date: addDays(TODAY(), 5) }));
  assert.equal(res.success, true, JSON.stringify(res));

  const after = dayRow(raw, id);
  assert.equal(after.delivery_due_day, addDays(TODAY(), 5), 'the day was stored…');
  assert.equal(after.next_stage_at, armed.next_stage_at, '…and the alarm clock did not move by one character');
  /**
   * THE DEFECT THIS PINS. `sweepDueStages` selects
   * `WHERE next_stage_at IS NOT NULL AND next_stage_at <= ?` and then PROMOTES
   * the order. A day written into that column would defer the
   * confirmed→preparing promotion by the whole postponement — five days here —
   * so the customer who asked to receive it on Friday would stop their own
   * order being prepared until Friday, and receive it unpacked. Nothing throws
   * and nothing logs; the only symptom is a box that arrives empty of
   * preparation.
   */
  assert.ok(
    Date.parse(after.next_stage_at!) - Date.now() < 60 * 60_000,
    'still minutes away, not five days — the day never became the alarm'
  );
});
