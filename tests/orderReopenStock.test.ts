/**
 * RE-OPENING A CANCELLED ORDER AND ITS STOCK (owner 2026-11-10; DECISIONS row 310).
 *
 * A re-opened order replayed the keys of its first hold, which its
 * cancellation had spent:
 *   - taken (confirmed) and put back on the shelf, it confirmed again taking
 *     nothing — stock stayed one too high;
 *   - only held, it failed to deduct («Stock could not be deducted») or
 *     silently took another customer's hold, and that order then failed.
 * The owner chose «re-hold, or refuse if taken»:
 *   - only held: the re-open holds its units again (a new hold cycle,
 *     `<kind>:<order>~2:…`) and confirming takes them; refused when they are
 *     no longer free, as checkout refuses;
 *   - taken and put back: the re-open is refused — create a new order.
 * Both admin doors (the status dropdown and the stage panel) behave the same.
 *
 * Run: node --import tsx --test tests/orderReopenStock.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, failingD1, json, row } from './fixtures/app';
import { appsFor, giftWorld, paidLine, patch, placeOrder, type Apps } from './fixtures/giftWorld';
import { deductOrderStock } from '../worker/lib/orderInventory';

type Door = 'status' | 'stage';
const TO_STAGE: Record<string, string> = { pending: 'received', confirmed: 'confirmed', cancelled: 'cancelled' };

function world(db?: (raw: ReturnType<typeof giftWorld>) => { db: D1Database }) {
  const raw = giftWorld();
  const a: Apps = appsFor(db ? db(raw).db : asD1(raw));
  const stock = () => ({ ...row<{ stock: number; reserved: number }>(raw, "SELECT stock, stock_reserved AS reserved FROM products WHERE id='p_plain'")! });
  const ledger = (id: string) => all<{ kind: string; idempotency_key: string }>(raw, 'SELECT kind, idempotency_key FROM inventory_ledger WHERE order_id=? ORDER BY rowid', id)
    .map((r) => `${r.kind}@${r.idempotency_key.split(':')[1]}`);
  const status = (id: string) => row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id=?', id)!.status;
  async function order(cart: string, user: 'buyer' | 'other' = 'buyer') {
    paidLine(raw, cart, 'p_plain', { qty: 1, userId: user });
    return (await placeOrder(user === 'buyer' ? a.buyer : a.other, user === 'buyer' ? {} : { addressId: 'addr_o' })).id as string;
  }
  /** Moves an order through one admin door; returns the HTTP status and the refusal code, if any. */
  async function move(door: Door, id: string, to: string) {
    const res = door === 'status'
      ? await patch(a.admin, `/api/admin/orders/${id}`, { status: to })
      : await patch(a.admin, `/api/admin/orders/${id}/stage`, { stage: TO_STAGE[to] });
    const body = await json(res.clone());
    return { http: res.status, code: (body.code as string | undefined) ?? null, body };
  }
  return { raw, a, stock, ledger, status, order, move };
}

for (const door of ['status', 'stage'] as const) {
  test(`${door} door: an order cancelled while only held is held again when re-opened, and confirming takes its own unit`, async () => {
    const w = world();
    const id = await w.order('ci_1');
    const other = await w.order('ci_2', 'other');
    assert.deepEqual(w.stock(), { stock: 3, reserved: 2 });
    assert.equal((await w.move(door, id, 'cancelled')).http, 200);
    assert.deepEqual(w.stock(), { stock: 3, reserved: 1 }, 'released');
    const reopened = await w.move(door, id, 'pending');
    assert.equal(reopened.http, 200, JSON.stringify(reopened.body));
    assert.deepEqual(w.stock(), { stock: 3, reserved: 2 }, 'held again');
    assert.deepEqual(w.ledger(id), [`reserve@${id}`, `release@${id}`, `reserve@${id}~2`]);
    assert.equal((await w.move(door, id, 'confirmed')).http, 200);
    assert.deepEqual(w.stock(), { stock: 2, reserved: 1 }, 'its own hold became the decrement; the other customer keeps theirs');
    assert.deepEqual(w.ledger(id), [`reserve@${id}`, `release@${id}`, `reserve@${id}~2`, `deduct@${id}~2`]);
    assert.equal((await w.move(door, other, 'confirmed')).http, 200);
    assert.deepEqual(w.stock(), { stock: 1, reserved: 0 });
    assert.deepEqual(w.ledger(other), [`reserve@${other}`, `deduct@${other}`]);
  });

  test(`${door} door: an order whose unit was taken and put back on the shelf is not re-opened`, async () => {
    const w = world();
    const id = await w.order('ci_1');
    assert.equal((await w.move(door, id, 'confirmed')).http, 200);
    assert.equal((await w.move(door, id, 'cancelled')).http, 200);
    assert.deepEqual(w.stock(), { stock: 3, reserved: 0 }, 'the unit is back on the shelf');
    const before = w.ledger(id);
    const refused = await w.move(door, id, 'pending');
    assert.deepEqual([refused.http, refused.code], [409, 'ORDER_REOPEN_STOCK_RETURNED'], JSON.stringify(refused.body));
    assert.equal(w.status(id), 'cancelled');
    assert.deepEqual(w.stock(), { stock: 3, reserved: 0 });
    assert.deepEqual(w.ledger(id), before, 'nothing was held or taken');
  });
}

test('a re-open whose units are no longer free is refused, and the order stays cancelled', async () => {
  const w = world();
  const id = await w.order('ci_1');
  assert.equal((await w.move('status', id, 'cancelled')).http, 200);
  // Everything left on the shelf is held by other orders now.
  w.raw.exec("UPDATE products SET stock_reserved = stock WHERE id='p_plain'");
  const refused = await w.move('stage', id, 'pending');
  assert.deepEqual([refused.http, refused.code], [409, 'ORDER_REOPEN_STOCK_UNAVAILABLE'], JSON.stringify(refused.body));
  assert.equal(w.status(id), 'cancelled');
  assert.deepEqual(w.ledger(id), [`reserve@${id}`, `release@${id}`]);
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM order_reservation_fence WHERE order_id=? AND kind='reserve' AND actual<>expected", id), 0);
});

test('units taken between the plan and the commit: the fence rolls the whole re-open back', async () => {
  let failing!: ReturnType<typeof failingD1>['failing'];
  const w = world((raw) => { const f = failingD1(raw); failing = f.failing; return f; });
  const id = await w.order('ci_1');
  assert.equal((await w.move('status', id, 'cancelled')).http, 200);
  let stolen = false;
  failing.beforeBatch = () => {
    if (stolen) return;
    stolen = true;
    w.raw.exec("UPDATE products SET stock_reserved = stock WHERE id='p_plain'");
  };
  const refused = await w.move('status', id, 'pending');
  assert.ok(stolen, 'the units went between the plan and the commit');
  assert.deepEqual([refused.http, refused.code], [409, 'ORDER_REOPEN_STOCK_UNAVAILABLE'], JSON.stringify(refused.body));
  assert.equal(w.status(id), 'cancelled', 'the flip rolled back with the hold');
  assert.deepEqual(w.ledger(id), [`reserve@${id}`, `release@${id}`]);
});

test('hold cycles: cancelled and re-opened twice, then confirmed once, takes one unit and its FIFO cost; a last cancellation puts it back and closes re-opening', async () => {
  const w = world();
  w.raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
    VALUES ('lot-plain','p_plain','base','',3,3,9000,27000,'received','2026-01-01T00:00:00Z')`);
  const id = await w.order('ci_1');
  for (let i = 0; i < 2; i++) {
    assert.equal((await w.move(i ? 'stage' : 'status', id, 'cancelled')).http, 200);
    assert.equal((await w.move(i ? 'stage' : 'status', id, 'pending')).http, 200);
  }
  assert.deepEqual(w.ledger(id), [`reserve@${id}`, `release@${id}`, `reserve@${id}~2`, `release@${id}~2`, `reserve@${id}~3`]);
  assert.deepEqual(w.stock(), { stock: 3, reserved: 1 });
  assert.equal((await w.move('status', id, 'confirmed')).http, 200);
  assert.deepEqual(await deductOrderStock(w.a.db, id, null), { applied: 0, rejected: 0 }, 'a replayed deduction moves nothing');
  assert.deepEqual(w.stock(), { stock: 2, reserved: 0 });
  assert.deepEqual(all(w.raw, "SELECT qty,cogs_iqd,released_at IS NOT NULL AS released FROM order_item_inventory_allocations WHERE order_id=? ORDER BY rowid", id).map((r) => ({ ...r })),
    [{ qty: 1, cogs_iqd: 9000, released: 0 }]);
  assert.equal(row<{ q: number }>(w.raw, "SELECT qty_remaining q FROM inventory_lots WHERE id='lot-plain'")!.q, 2);
  // Cancelled after it was taken: the unit and its lot come back, and the order is not re-opened again.
  assert.equal((await w.move('stage', id, 'cancelled')).http, 200);
  assert.deepEqual(w.stock(), { stock: 3, reserved: 0 });
  assert.equal(row<{ q: number }>(w.raw, "SELECT qty_remaining q FROM inventory_lots WHERE id='lot-plain'")!.q, 3);
  assert.deepEqual(w.ledger(id).slice(-2), [`deduct@${id}~3`, `restore@${id}~3`]);
  assert.equal((await w.move('status', id, 'pending')).code, 'ORDER_REOPEN_STOCK_RETURNED');
});
