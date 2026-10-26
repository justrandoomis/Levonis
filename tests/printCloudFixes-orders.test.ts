/**
 * LEVONIS PRINT CLOUD — regression tests for the orders review findings:
 *
 *   c2   two delivery lines of one variant made an order that could never be
 *        paid (a duplicate active reservation), and an unexpected refusal in
 *        the fulfilment batch answered 500 forever with nothing recorded;
 *   c7   a shipment cancelled while its fee was unpaid left the fee order
 *        payable, and paying it was 'applied' to a cancelled shipment;
 *   c8   the manual receipt key was the reference alone: a mistyped amount
 *        or a reference shared by two orders blocked the right confirmation;
 *   c20  two concurrent equal refunds both committed while the order counted
 *        only one of them.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-orders.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, API, buy, call, idem, ok, owned, pcWorld, reconcileClean, row, rows, seedCatalog, type Json, type World } from './fixtures/printCloud';
import { expireUnpaidOrders } from '../worker/lib/printCloud/orders';

const H = 3600;
const ADDRESS = { recipient_name: 'Ali', phone: '07700000000', governorate: 'baghdad', city: 'Baghdad', address_line: 'Karrada, street 62' };

const needingRefund = async (w: World): Promise<Json[]> =>
  (await ok(w.owner, 'GET', `${ADMIN}/reconcile`)).checks.find((c: Json) => c.name === 'payments_needing_refund').issues;

/** A delivery of owned white PLA whose 5,000 IQD fee is its own unpaid order. */
async function awaitingFee(w: World, white: string, payment = 'dev'): Promise<{ shipment_id: string; fee_order_id: string }> {
  await buy(w.a, [{ kind: 'material', variant_id: white, quantity: 500 }]);
  const ship = await ok(w.a, 'POST', `${API}/shipments`, { kind: 'delivery', items: [{ variant_id: white, qty: 200 }], payment_method: payment, delivery_address: ADDRESS }, idem('ship'));
  assert.deepEqual([ship.status, ship.fee_iqd], ['awaiting_payment', 5000]);
  assert.equal((await owned(w.a, white)).reserved_qty, 200);
  return { shipment_id: String(ship.shipment_id), fee_order_id: String(ship.fee_order_id) };
}

// ------------------------------------------------------------------ c2

test('c2: two delivery lines of the same variant are paid, reserved once for their sum and shipped once', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const quote = await ok(w.a, 'POST', `${API}/quotes`, {
    lines: [
      { kind: 'material', variant_id: cat.white, quantity: 1000, fulfillment: 'delivery' },
      { kind: 'material', variant_id: cat.white, quantity: 250, fulfillment: 'delivery' },
    ],
  });
  assert.equal(quote.orderable, true);
  const order = await ok(w.a, 'POST', `${API}/orders`, { quote_id: quote.quote_id, payment_method: 'dev', delivery_address: ADDRESS }, idem('o'));
  assert.equal(order.total_iqd, 37250);
  const paid = await call(w.a, 'POST', `${API}/orders/${order.order_id}/dev-pay`, {});
  assert.equal(paid.status, 200, JSON.stringify(paid.json).slice(0, 400));
  assert.equal(paid.json.data.outcome, 'applied');
  const shipmentId = row(w, 'SELECT shipment_id FROM pc_orders WHERE id = ?', order.order_id)?.shipment_id as string;
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', shipmentId)?.status, 'preparing');
  const reservations = rows(w, "SELECT variant_id, qty_reserved FROM pc_inventory_reservations WHERE purpose = 'delivery' AND ref_id = ? AND state = 'active'", shipmentId);
  assert.deepEqual(reservations, [{ variant_id: cat.white, qty_reserved: 1250 }], 'one reservation, for the sum of both lines');
  assert.deepEqual(rows(w, 'SELECT variant_id, qty FROM pc_shipment_items WHERE shipment_id = ? AND live = 1', shipmentId), [{ variant_id: cat.white, qty: 1250 }]);
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [0, 1250]);
  // Handed over once: both lines leave the customer and the shelf together.
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${shipmentId}/advance`, { to: 'shipped', tracking_ref: 'T-2' });
  assert.equal((await owned(w.a, cat.white)).reserved_qty, 0);
  await reconcileClean(w);
});

test('c2: a fulfilment batch the database refuses for good is recorded for the refund desk, not answered 500 forever; an outage is still a 500', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const quote = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'material', variant_id: cat.white, quantity: 250, fulfillment: 'delivery' }] });
  const order = await ok(w.a, 'POST', `${API}/orders`, { quote_id: quote.quote_id, payment_method: 'manual', delivery_address: ADDRESS }, idem('o'));
  // An outage (an error that is no refusal of ours) is a 500: nothing is recorded, so the provider's retry can still apply it.
  w.raw.exec("CREATE TRIGGER tst_outage BEFORE INSERT ON pc_shipments BEGIN SELECT RAISE(ABORT, 'D1_ERROR: Network connection lost'); END");
  const outage = await call(w.full, 'POST', `${ADMIN}/orders/${order.order_id}/confirm-payment`, { reference: 'RCPT-1', amount_iqd: order.total_iqd });
  assert.equal(outage.status, 500);
  assert.equal(row(w, 'SELECT COUNT(*) AS n FROM pc_payment_events')?.n, 0);
  // A refusal no retry changes (here the duplicate active reservation c2 hit): recorded once, listed for refund.
  w.raw.exec('DROP TRIGGER tst_outage');
  w.raw.exec(
    "CREATE TRIGGER tst_refusal BEFORE INSERT ON pc_shipments BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: pc_inventory_reservations.purpose, pc_inventory_reservations.ref_id, pc_inventory_reservations.account_id'); END"
  );
  const refused = await call(w.full, 'POST', `${ADMIN}/orders/${order.order_id}/confirm-payment`, { reference: 'RCPT-1', amount_iqd: order.total_iqd });
  assert.equal(refused.status, 200, JSON.stringify(refused.json).slice(0, 400));
  assert.equal(refused.json.data.outcome, 'order_not_payable');
  assert.equal(row(w, 'SELECT status, paid_iqd FROM pc_orders WHERE id = ?', order.order_id)?.paid_iqd, 0);
  assert.deepEqual((await needingRefund(w)).map((e) => [e.order_id, e.outcome]), [[order.order_id, 'order_not_payable']]);
  assert.equal(row(w, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'print_cloud.payment.order_not_payable'")?.n, 1);
});

// ------------------------------------------------------------------ c7

test('c7: an operator cancelling a shipment that awaits its fee closes the fee order in the same batch; a late payment is listed for refund', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const ship = await awaitingFee(w, cat.white);
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${ship.shipment_id}/advance`, { to: 'cancelled', note: 'customer called' });
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', ship.shipment_id)?.status, 'cancelled');
  assert.equal(row(w, 'SELECT notes FROM pc_shipments WHERE id = ?', ship.shipment_id)?.notes, 'customer called');
  assert.equal(row(w, 'SELECT status FROM pc_orders WHERE id = ?', ship.fee_order_id)?.status, 'cancelled', 'the fee order went with its shipment');
  assert.deepEqual(rows(w, 'SELECT status FROM pc_payments WHERE order_id = ?', ship.fee_order_id), [{ status: 'rejected' }]);
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [500, 0], 'the 200 g came back once');
  const late = await ok(w.a, 'POST', `${API}/orders/${ship.fee_order_id}/dev-pay`, {});
  assert.equal(late.outcome, 'order_not_payable');
  assert.deepEqual(row(w, 'SELECT status, paid_iqd FROM pc_orders WHERE id = ?', ship.fee_order_id), { status: 'cancelled', paid_iqd: 0 });
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', ship.shipment_id)?.status, 'cancelled');
  assert.deepEqual((await needingRefund(w)).map((e) => [e.order_id, e.outcome]), [[ship.fee_order_id, 'order_not_payable']]);
  await reconcileClean(w);
});

test('c7: a fee paid for a shipment that is no longer awaiting it is never applied, and that unpaid order still expires', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const ship = await awaitingFee(w, cat.white);
  // What the old operator door left behind: the shipment cancelled, its material released, the fee order still open.
  const res = row<{ id: string }>(w, "SELECT id FROM pc_inventory_reservations WHERE purpose = 'delivery' AND ref_id = ?", ship.shipment_id) as { id: string };
  w.raw.prepare("UPDATE pc_shipments SET status = 'cancelled' WHERE id = ?").run(ship.shipment_id);
  w.raw.prepare("UPDATE pc_inventory_reservations SET state = 'released', qty_released = qty_reserved WHERE id = ?").run(res.id);
  w.raw.prepare('UPDATE pc_inventory_accounts SET available_qty = available_qty + 200, reserved_qty = reserved_qty - 200 WHERE user_id = ? AND variant_id = ?').run('usr_pc_a', cat.white);
  const late = await ok(w.a, 'POST', `${API}/orders/${ship.fee_order_id}/dev-pay`, {});
  assert.equal(late.outcome, 'order_not_payable');
  assert.deepEqual(row(w, 'SELECT status, paid_iqd FROM pc_orders WHERE id = ?', ship.fee_order_id), { status: 'awaiting_payment', paid_iqd: 0 });
  assert.equal(row(w, "SELECT COUNT(*) AS n FROM pc_payments WHERE order_id = ? AND status = 'confirmed'", ship.fee_order_id)?.n, 0);
  assert.deepEqual((await needingRefund(w)).map((e) => e.outcome), ['order_not_payable']);
  assert.deepEqual(await expireUnpaidOrders(w.db, new Date(Date.now() + 2 * H * 1000)), { expired: 1, failed: 0, more: false });
  assert.equal(row(w, 'SELECT status FROM pc_orders WHERE id = ?', ship.fee_order_id)?.status, 'expired');
});

test('c7: a shipment that stops awaiting its fee just before the payment batch fails the fence; the payment is recorded for refund, not applied', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const ship = await awaitingFee(w, cat.white);
  w.race.when = (sqls) => sqls.some((s) => s.includes("UPDATE pc_shipments SET status = 'preparing'"));
  w.race.hook = async () => {
    w.raw.prepare("UPDATE pc_shipments SET status = 'cancelled' WHERE id = ?").run(ship.shipment_id);
  };
  const late = await ok(w.a, 'POST', `${API}/orders/${ship.fee_order_id}/dev-pay`, {});
  assert.equal(w.race.hook, null, 'the shipment moved after the payment was planned');
  assert.equal(late.outcome, 'order_not_payable');
  assert.deepEqual(row(w, 'SELECT status, paid_iqd FROM pc_orders WHERE id = ?', ship.fee_order_id), { status: 'awaiting_payment', paid_iqd: 0 });
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', ship.shipment_id)?.status, 'cancelled');
  assert.deepEqual((await needingRefund(w)).map((e) => e.outcome), ['order_not_payable']);
});

test('c7: a customer cancelling an unpaid shipment while its fee is being paid is refused; the paid shipment is not cancelled', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const ship = await awaitingFee(w, cat.white);
  w.race.when = (sqls) => sqls.some((s) => s.includes("UPDATE pc_payments SET status = 'rejected'"));
  w.race.hook = async () => {
    assert.equal((await ok(w.a, 'POST', `${API}/orders/${ship.fee_order_id}/dev-pay`, {})).outcome, 'applied');
  };
  const cancel = await call(w.a, 'POST', `${API}/shipments/${ship.shipment_id}/cancel`);
  assert.equal(w.race.hook, null, 'the payment landed just before the cancellation batch');
  assert.equal(cancel.status, 409, JSON.stringify(cancel.json).slice(0, 400));
  assert.equal(cancel.json.code, 'STATE_CHANGED');
  assert.deepEqual(row(w, 'SELECT status, paid_iqd FROM pc_orders WHERE id = ?', ship.fee_order_id), { status: 'fulfilled', paid_iqd: 5000 });
  assert.equal(row(w, 'SELECT status FROM pc_shipments WHERE id = ?', ship.shipment_id)?.status, 'preparing');
  assert.equal((await owned(w.a, cat.white)).reserved_qty, 200);
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c8

test('c8: a manual confirmation with a mistyped amount does not use up the receipt; the corrected amount is applied', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const q = await ok(w.a, 'POST', `${API}/quotes`, { lines: [{ kind: 'credit_package', package_id: cat.packages.h24 }] });
  const order = await ok(w.a, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'manual' }, idem('o'));
  const confirm = (amount: number) => ok(w.full, 'POST', `${ADMIN}/orders/${order.order_id}/confirm-payment`, { reference: 'RCPT-1001', amount_iqd: amount });
  assert.equal((await confirm(3600)).outcome, 'amount_mismatch');
  const corrected = await confirm(36000);
  assert.equal(corrected.outcome, 'applied');
  assert.deepEqual(row(w, 'SELECT status, paid_iqd FROM pc_orders WHERE id = ?', order.order_id), { status: 'fulfilled', paid_iqd: 36000 });
  // The same receipt submitted twice is still one event, and the answer says what the first one was.
  const again = await confirm(36000);
  assert.deepEqual([again.outcome, again.previous_outcome], ['duplicate_event', 'applied']);
  // Once the receipt is applied, any re-entry of it is that receipt again (printCloudAdmin.ts).
  const typo = await confirm(3600);
  assert.deepEqual([typo.outcome, typo.previous_outcome], ['duplicate_event', 'applied']);
  assert.equal(row(w, "SELECT COUNT(*) AS n FROM pc_payments WHERE order_id = ? AND status = 'confirmed'", order.order_id)?.n, 1);
  await reconcileClean(w);
});

test('c8: one receipt reference used for two orders confirms both', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const place = async (app: typeof w.a) => {
    const q = await ok(app, 'POST', `${API}/quotes`, { lines: [{ kind: 'credit_package', package_id: cat.packages.h6 }] });
    return ok(app, 'POST', `${API}/orders`, { quote_id: q.quote_id, payment_method: 'manual' }, idem('o'));
  };
  const b = await place(w.a);
  const c = await place(w.b);
  for (const o of [b, c]) {
    const out = await ok(w.full, 'POST', `${ADMIN}/orders/${o.order_id}/confirm-payment`, { reference: 'cash', amount_iqd: o.total_iqd });
    assert.equal(out.outcome, 'applied', `order ${o.order_id}`);
    assert.deepEqual(row(w, 'SELECT status, paid_iqd FROM pc_orders WHERE id = ?', o.order_id), { status: 'fulfilled', paid_iqd: 10500 });
  }
  await reconcileClean(w);
});

// ------------------------------------------------------------------ c20

test('c20: two concurrent refunds of equal amounts on two lines both count on the order', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const orderId = await buy(w.a, [
    { kind: 'material', variant_id: cat.white, quantity: 500 },
    { kind: 'material', variant_id: cat.black, quantity: 500 },
  ]);
  const [white, black] = (await ok(w.full, 'GET', `${ADMIN}/orders/${orderId}`)).lines;
  assert.deepEqual([white.final_price_iqd, black.final_price_iqd], [14500, 14500]);
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_refunds'));
  w.race.hook = async () => {
    const other = await call(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: black.id, reason: 'unused' }, idem('r2'));
    assert.equal(other.status, 201, JSON.stringify(other.json).slice(0, 400));
  };
  const first = await call(w.full, 'POST', `${ADMIN}/orders/${orderId}/refunds`, { line_id: white.id, reason: 'unused' }, idem('r1'));
  assert.equal(w.race.hook, null, 'the competing refund committed first');
  assert.equal(first.status, 201, JSON.stringify(first.json).slice(0, 400));
  assert.equal(first.json.data.amount_iqd, 14500);
  assert.equal(row(w, 'SELECT SUM(amount_iqd) AS s FROM pc_refunds WHERE order_id = ?', orderId)?.s, 29000);
  assert.deepEqual(row(w, 'SELECT status, paid_iqd, refunded_iqd FROM pc_orders WHERE id = ?', orderId), { status: 'refunded', paid_iqd: 29000, refunded_iqd: 29000 });
  await reconcileClean(w);
});
