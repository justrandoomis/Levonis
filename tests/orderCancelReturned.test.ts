/**
 * «أُرجع، لا يُلغى» — AN ORDER A REFUNDED RETURN ALREADY GAVE PART OF BACK IS NOT CANCELLED (owner
 * 2026-11-11, Q7's default; DECISIONS row 319).
 *
 * Until now a delivered order whose return was refunded could still be walked back one step and
 * cancelled — the status dropdown, the stage panel, a courier status mapped to «cancelled», or the
 * customer's own cancel after a walk-back to pending — and the cancel gave back the WHOLE order
 * again: the wallet advance a second time (`wtx_refund_<order>_usd` on top of `wtx_ret_<case>`), the
 * returned unit to the shelf a second time (the counter one above its batch), and the journal
 * reversed the sale twice. Measured here through the real returns desk and the real doors, before
 * the fix: a 20,000 wallet order whose 15,000 line was refunded got 20,000 more. The mirror — a
 * return still open when the order is cancelled, refunded afterwards — paid twice the same way.
 *
 * Now every cancel door asks one shared question (worker/lib/orderCancelOps.ts `orderReturnMoved`)
 * and refuses with 409 ORDER_CANCEL_RETURNED; the courier sync leaves the order as it is and stores
 * the code as its sync error; the cancel batch carries the same question as a fence for a refund
 * that lands in between; and the returns desk refuses a refund on a cancelled order
 * (RETURN_ORDER_CANCELLED). A return still open, rejected, or resolved without a refund moved
 * nothing and blocks nothing. Invented data only.
 *
 * Run: node --import tsx --test tests/orderCancelReturned.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, asD1, count, json, post, row, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { appsFor, giftWorld, mountGifts, paidLine, patch, placeOrder } from './fixtures/giftWorld';
import { returnRoutes } from '../worker/routes/returns';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import {
  ORDER_CANCEL_RETURNED, RETURN_ORDER_CANCELLED, cancelledOrderRefundStatements, cancelledOrderReturnRefusal,
  orderReturnMoved, returnedOrderCancelRefusal,
} from '../worker/lib/orderCancelOps';
import { setStatusMapping, upsertRemoteStatuses } from '../worker/lib/delivery/statusMap';
import { sweepDeliveryStatuses, syncOrderDelivery } from '../worker/lib/delivery/sync';
import { REFUSAL_STRINGS, refusalText } from '../src/lib/refusalStrings';
import type { DeliveryDriver, DriverResult, RemoteShipmentStatus, RemoteStatus, CreatedShipment } from '../worker/lib/delivery/types';
import type { Env } from '../worker/lib/types';

const ACCOUNTS = ['1100', '1200', '2200', '2300', '4000', '4100', '5000'] as const;
const BOSS = { id: 'boss', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };
const BUYER = { id: 'buyer', email: 'buyer@x.co', role: 'customer' as const };

/** A courier that answers one status for every shipment (tests/deliverySync.test.ts). */
class StubCourier implements DeliveryDriver {
  readonly provider = 'alwaseet';
  constructor(private statusId: string) {}
  async listStatuses(): Promise<DriverResult<RemoteStatus[]>> { return { ok: true, value: [{ id: this.statusId, text: 'راجع' }] }; }
  async createShipment(): Promise<DriverResult<CreatedShipment>> { return { ok: false, retryable: false, error: 'not used' }; }
  async getShipment(): Promise<DriverResult<RemoteShipmentStatus>> { return { ok: true, value: { remoteId: 'AW-T1', statusId: this.statusId, statusText: 'راجع' } }; }
}

/** A D1 whose first batch holding `marker` waits until `between` has run: another request landing between a door's read and its write. */
function racing(db: D1Database, marker: string, between: () => Promise<unknown>) {
  const seen = { raced: false };
  const d1 = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (s: D1PreparedStatement[]) => {
      if (!seen.raced && s.some((x) => String((x as unknown as { sql?: string }).sql ?? '').includes(marker))) { seen.raced = true; await between(); }
      return db.batch(s);
    },
  } as D1Database;
  return { d1, seen };
}

/** The gift world with two priced batches (10 × 6,000 for the nozzle cleaner, 10 × 3,000 for the other thing) and the returns desk. */
function world() {
  const raw = giftWorld();
  raw.exec(`UPDATE users SET admin_scope='full' WHERE id='boss';
    UPDATE products SET stock=10 WHERE id IN ('p_plain','p_other');
    UPDATE product_option_values SET stock=10 WHERE id='o_x';
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
    VALUES ('lot_plain','p_plain','base','',10,10,6000,60000,'received','2026-01-01'),
           ('lot_other','p_other','base','',10,10,3000,30000,'received','2026-01-01');`);
  const db = asD1(raw), a = appsFor(db), env = { DB: db } as Env;
  const desk = stubApp(db, BOSS, (x) => { x.route('/api/returns', returnRoutes); });
  const customer = stubApp(db, BUYER, (x) => { x.route('/api/returns', returnRoutes); });
  const ok = async (res: Response, what: string) => { const body = await json(res.clone()); assert.equal(res.status, 200, `${what}: ${JSON.stringify(body)}`); return body; };
  const refused = async (res: Response, code: string, what: string) => {
    const body = await json(res.clone());
    assert.deepEqual([res.status, body.code], [409, code], `${what}: ${JSON.stringify(body)}`);
    return body;
  };
  const move = async (id: string, status: string) => ok(await patch(a.admin, `/api/admin/orders/${id}`, { status }), status);
  const stage = async (id: string, to: string) => ok(await patch(a.admin, `/api/admin/orders/${id}/stage`, { stage: to }), to);
  let cart = 0;
  async function placed(products: string[] = ['p_plain'], over: Record<string, unknown> = { useWallet: true }) {
    for (const p of products) paidLine(raw, `cart_${++cart}`, p, { qty: 1, optionValueIds: p === 'p_other' ? ['o_x'] : [] });
    return (await placeOrder(a.buyer, over)).id as string;
  }
  async function delivered(products: string[] = ['p_plain'], over: Record<string, unknown> = { useWallet: true }) {
    const id = await placed(products, over);
    await move(id, 'confirmed');
    await move(id, 'delivered');
    return id;
  }
  /** The customer opens a return on one line, and the desk walks it to `to` (resolved = refunded to the wallet). */
  async function returned(id: string, product: string, to: 'refunded' | 'rejected' | 'received' | 'inspected') {
    const line = row<{ id: string }>(raw, 'SELECT id FROM order_items WHERE order_id=? AND product_id=?', id, product)!.id;
    const caseId = String((await ok(await post(customer, '/api/returns', { orderItemId: line, qty: 1, reason: 'defective' }), 'open')).case.id);
    if (to === 'rejected') {
      await ok(await post(desk, `/api/returns/admin/${caseId}/transition`, { to: 'rejected', reason: 'Not faulty on inspection' }), 'reject');
      return caseId;
    }
    for (const step of ['assessment', 'approved', 'received']) await ok(await post(desk, `/api/returns/admin/${caseId}/transition`, { to: step }), step);
    if (to !== 'received') await ok(await post(desk, `/api/returns/admin/${caseId}/transition`, { to: 'inspected' }), 'inspected');
    if (to === 'refunded') await refund(caseId);
    return caseId;
  }
  const refund = async (caseId: string) => ok(await post(desk, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' }), 'refund');
  /** Everything a cancel gives back, for one order: its wallet rows, refund facts, journal, stock rows, points. */
  const books = (id: string) => ({
    wallet: all(raw, 'SELECT id,type,currency,amount,amount_iqd,status FROM wallet_transactions WHERE ref=? ORDER BY id', id).map((r) => ({ ...r })),
    facts: all(raw, 'SELECT case_id,refund_iqd,qty,channel FROM finance_refund_facts WHERE order_id=? ORDER BY case_id', id).map((r) => ({ ...r })),
    journal: all(raw, `SELECT e.event_key,(SELECT group_concat(l.account_code||':'||(l.debit_iqd-l.credit_iqd),' ') FROM accounting_lines l WHERE l.entry_id=e.id) lines
      FROM accounting_entries e WHERE e.source_id=?1 OR e.source_id IN (SELECT id FROM return_cases WHERE order_id=?1) ORDER BY e.event_key`, id).map((r) => ({ ...r })),
    ledger: all(raw, 'SELECT kind,idempotency_key,qty FROM inventory_ledger WHERE order_id=? ORDER BY idempotency_key', id).map((r) => ({ ...r })),
    allocations: all(raw, 'SELECT order_item_id,lot_id,qty,released_at IS NOT NULL released FROM order_item_inventory_allocations WHERE order_id=? ORDER BY released,order_item_id', id).map((r) => ({ ...r })),
    points: all(raw, 'SELECT kind,state,points FROM points_accruals WHERE order_id=? ORDER BY kind', id).map((r) => ({ ...r })),
  });
  /** The order's nets per account: its own entries and its returns'. */
  const nets = (id: string) => Object.fromEntries(ACCOUNTS.map((code) => [code, count(raw, `SELECT COALESCE(SUM(l.debit_iqd-l.credit_iqd),0) n
    FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.state='posted' AND l.account_code=?1
      AND (e.source_id=?2 OR e.source_id IN (SELECT id FROM return_cases WHERE order_id=?2))`, code, id)]));
  /** Money back in the wallet for this order, in dinars (the debit at checkout is negative). */
  const walletNet = (id: string) => count(raw, "SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount_iqd ELSE -amount_iqd END),0) n FROM wallet_transactions WHERE ref=? AND currency='USD' AND status='approved'", id);
  /** The shelf counter and its batch agree: a unit given back twice would make the counter run ahead. */
  const shelf = () => ({
    plain: [count(raw, "SELECT stock n FROM products WHERE id='p_plain'"), count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_plain'")],
    other: [count(raw, "SELECT stock n FROM products WHERE id='p_other'"), count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_other'")],
  });
  async function drainAll() { for (let i = 0; i < 6; i++) if (!(await drainOrderFinanceRecovery(env)).scanned) break; }
  const status = (id: string) => row<{ status: string; stage: string }>(raw, 'SELECT status,stage FROM orders WHERE id=?', id)!;
  async function courier(id: string) {
    raw.prepare("UPDATE orders SET delivery_provider='alwaseet',delivery_remote_id='AW-T1' WHERE id=?").run(id);
    const now = new Date().toISOString();
    await upsertRemoteStatuses(db, 'alwaseet', [{ id: '17', text: 'راجع' }], now);
    await setStatusMapping(db, 'alwaseet', '17', 'cancelled', now);
  }
  return { raw, db, a, env, desk, ok, refused, move, stage, placed, delivered, returned, refund, books, nets, walletNet, shelf, drainAll, status, courier };
}
type World = ReturnType<typeof world>;

/** The four doors, each from a delivered order with a refunded return. */
const DOORS: Record<string, (w: World, id: string) => Promise<string>> = {
  /** The status dropdown: one step back (allowed: a mis-tap is corrected), then cancel. */
  async 'the status door'(w, id) {
    await w.move(id, 'shipped');
    await w.refused(await patch(w.a.admin, `/api/admin/orders/${id}`, { status: 'cancelled' }), ORDER_CANCEL_RETURNED, 'status door');
    return 'shipped';
  },
  async 'the stage panel'(w, id) {
    await w.stage(id, 'out_for_delivery');
    await w.refused(await patch(w.a.admin, `/api/admin/orders/${id}/stage`, { stage: 'cancelled' }), ORDER_CANCEL_RETURNED, 'stage panel');
    return 'shipped';
  },
  /** A courier status the owner mapped to «cancelled» takes a delivered order straight there (forced): not this one. */
  async 'a forced courier sync'(w, id) {
    await w.courier(id);
    const sync = await syncOrderDelivery(w.env, new StubCourier('17'), id);
    assert.deepEqual([sync.outcome, sync.error], ['error', ORDER_CANCEL_RETURNED], JSON.stringify(sync));
    // The trace the sync keeps for a courier failure: the order's own sync error, which its stage panel words.
    assert.equal(row(w.raw, 'SELECT delivery_error FROM orders WHERE id=?', id)?.delivery_error, ORDER_CANCEL_RETURNED);
    return 'delivered';
  },
  /** The team walks it back to pending; the customer's own cancel. */
  async "the customer's cancel"(w, id) {
    await w.move(id, 'shipped');
    await w.move(id, 'pending');
    await w.refused(await post(w.a.buyer, `/api/orders/${id}/cancel`, {}), ORDER_CANCEL_RETURNED, 'customer');
    return 'pending';
  },
};

test('a delivered wallet order whose line was refunded through the returns desk: each of the four doors refuses the cancel, and the wallet, the stock and the books stay as the return left them', async () => {
  const w = world();
  for (const [door, cancel] of Object.entries(DOORS)) {
    const id = await w.delivered();
    assert.equal(w.walletNet(id), -20000, `${door}: 15,000 goods + 5,000 delivery from the wallet`);
    await w.returned(id, 'p_plain', 'refunded');
    // What the return gave back: 15,000 to the wallet once (delivery is not refunded), the unit to its batch once.
    assert.equal(w.walletNet(id), -5000, door);
    assert.deepEqual(w.shelf().plain[0], w.shelf().plain[1], `${door}: the shelf and its batch agree`);
    const returned = w.books(id);
    assert.deepEqual(returned.facts.map((f) => f.refund_iqd), [15000]);
    assert.deepEqual(w.nets(id), { 1100: 0, 1200: 0, 2200: 5000, 2300: 0, 4000: 0, 4100: -5000, 5000: 0 }, door);
    const left = await cancel(w, id);
    // Refused: the walk-back stays, the cancel does not happen, and nothing it would give back moves.
    assert.equal(w.status(id).status, left, door);
    assert.deepEqual(w.books(id), returned, `${door}: nothing moved`);
    assert.equal(count(w.raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_refund_%' AND ref=?", id), 0, `${door}: no cancel refund`);
    assert.deepEqual(w.shelf().plain[0], w.shelf().plain[1], `${door}: the unit went back once`);
  }
  // Four deliveries, four returns: the shelf is back where it started, counter and batch alike.
  assert.deepEqual(w.shelf().plain, [10, 10]);
  // The minute scan has nothing to reverse: none of them is cancelled.
  const journal = all(w.raw, 'SELECT id FROM accounting_entries ORDER BY id').length;
  await w.drainAll();
  assert.equal(all(w.raw, 'SELECT id FROM accounting_entries ORDER BY id').length, journal);
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key LIKE 'order-cancel:%'"), 0);
});

test('the courier sweep counts the refused cancel as an error and leaves the walked-back order where it is; the stage panel words the stored code', async () => {
  const w = world();
  const id = await w.delivered();
  await w.returned(id, 'p_plain', 'refunded');
  await w.stage(id, 'out_for_delivery');
  await w.courier(id);
  const before = w.books(id);
  const report = await sweepDeliveryStatuses(w.env, new StubCourier('17'), 100);
  assert.deepEqual([report.scanned, report.moved, report.errors], [1, 0, 1], JSON.stringify(report));
  assert.equal(report.details[0].error, ORDER_CANCEL_RETURNED);
  assert.deepEqual(w.status(id), { status: 'shipped', stage: 'out_for_delivery' });
  assert.deepEqual(w.books(id), before);
  // OrderStagePanel prints «خطأ المزامنة: …» through the refusal table, so the code reads as a sentence.
  const panel = readFileSync(join(ROOT, 'src/components/adminOrders/OrderStagePanel.tsx'), 'utf8');
  assert.match(panel, /refusalText\(d\.error, refusalLang\(lang\), d\.error\)/);
  assert.equal(refusalText(ORDER_CANCEL_RETURNED, 'ar', 'x'), REFUSAL_STRINGS.ORDER_CANCEL_RETURNED.ar);
  assert.equal(refusalText('Courier timeout', 'ar', 'Courier timeout'), 'Courier timeout', "a courier's own text is shown as it came");
});

test('a partial return (one line of two refunded) refuses the cancel too; the other line still goes back through a return, and the order is refunded once per line', async () => {
  const w = world();
  const id = await w.delivered(['p_plain', 'p_other']);
  assert.equal(w.walletNet(id), -30000, '15,000 + 10,000 goods + 5,000 delivery');
  await w.returned(id, 'p_plain', 'refunded');
  await w.move(id, 'shipped');
  await w.refused(await patch(w.a.admin, `/api/admin/orders/${id}`, { status: 'cancelled' }), ORDER_CANCEL_RETURNED, 'partial');
  assert.equal(w.walletNet(id), -15000, 'only the returned line came back');
  // What is left goes back the way the refusal says: the team moves it forward again and the desk refunds the line.
  await w.move(id, 'delivered');
  await w.returned(id, 'p_other', 'refunded');
  assert.equal(w.walletNet(id), -5000, 'each line refunded once; the delivery stays paid');
  assert.deepEqual(w.shelf(), { plain: [10, 10], other: [10, 10] });
  assert.deepEqual(w.nets(id), { 1100: 0, 1200: 0, 2200: 5000, 2300: 0, 4000: 0, 4100: -5000, 5000: 0 });
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE ref=? AND id LIKE 'wtx_refund_%'", id), 0);
});

test('a return rejected or still open moved nothing: the cancel goes through and gives everything back once; the open return is then not refunded a second time, and the desk declines it', async () => {
  const w = world();
  // Rejected, then cancelled through the status door.
  const rejected = await w.delivered();
  await w.returned(rejected, 'p_plain', 'rejected');
  assert.equal(await orderReturnMoved(w.db, rejected), false);
  await w.move(rejected, 'shipped');
  await w.move(rejected, 'cancelled');
  // Still open (the parcel came back to the shop, not yet inspected), then cancelled through the stage panel.
  const open = await w.delivered();
  const caseId = await w.returned(open, 'p_plain', 'received');
  await w.stage(open, 'out_for_delivery');
  await w.stage(open, 'cancelled');
  for (const id of [rejected, open]) {
    assert.equal(w.status(id).status, 'cancelled');
    assert.equal(w.walletNet(id), 0, 'the whole 20,000 came back, once');
    assert.deepEqual(w.books(id).wallet.map((t) => t.id).filter((t) => String(t).startsWith('wtx_re')), [`wtx_refund_${id}_usd`]);
  }
  assert.deepEqual(w.shelf().plain, [10, 10], 'each unit went back once');
  // The mirror: the desk would now refund the open return on top of the cancel. Refused; nothing moves.
  await w.ok(await post(w.desk, `/api/returns/admin/${caseId}/transition`, { to: 'inspected' }), 'inspected');
  const cancelled = w.books(open);
  const second = await post(w.desk, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' });
  await w.refused(second, RETURN_ORDER_CANCELLED, 'refund after the cancel');
  assert.deepEqual(w.books(open), cancelled);
  assert.equal(row(w.raw, 'SELECT state FROM return_cases WHERE id=?', caseId)?.state, 'inspected');
  // The desk closes it the way the refusal says.
  await w.ok(await post(w.desk, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'declined', reason: 'The order was cancelled and refunded' }), 'decline');
  assert.deepEqual([w.walletNet(open), w.shelf().plain], [0, [10, 10]]);
  // And the minute scan reverses both sales like a return (row 318): every account of each order nets to 0.
  await w.drainAll();
  for (const id of [rejected, open]) assert.deepEqual(w.nets(id), { 1100: 0, 1200: 0, 2200: 0, 2300: 0, 4000: 0, 4100: 0, 5000: 0 }, id);
});

test('which returns block: a refund decided, or a return credit standing — never an open, rejected, repaired, replaced or declined case; an ordinary cancel is unchanged', async () => {
  const w = world();
  const id = await w.delivered();
  const line = row<{ id: string }>(w.raw, 'SELECT id FROM order_items WHERE order_id=?', id)!.id;
  w.raw.prepare("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state) VALUES ('rc_t',?,?,'buyer',1,'defective','requested')").run(id, line);
  const cases: Array<[string, string | null, boolean]> = [
    ['requested', null, false], ['assessment', null, false], ['approved', null, false], ['collection', null, false],
    ['received', null, false], ['inspected', null, false], ['rejected', null, false],
    ['resolved', 'replacement', false], ['resolved', 'repair', false], ['resolved', 'declined', false], ['resolved', 'refund', true],
  ];
  for (const [state, resolution, blocks] of cases) {
    w.raw.prepare('UPDATE return_cases SET state=?,resolution=? WHERE id=?').run(state, resolution, 'rc_t');
    assert.equal(await orderReturnMoved(w.db, id), blocks, `${state}/${resolution}`);
  }
  // A return credit that stands blocks whatever its case says (a repaired or hand-made row); one not approved does not.
  w.raw.prepare("UPDATE return_cases SET state='inspected',resolution=NULL WHERE id='rc_t'").run();
  w.raw.prepare("INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref) VALUES ('wtx_ret_rc_t','buyer','deposit','USD',1000,'rejected',?)").run(id);
  assert.equal(await orderReturnMoved(w.db, id), false);
  w.raw.prepare("INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref) VALUES ('wtx_ret_rc_u','buyer','deposit','USD',1000,'approved',?)").run(id);
  w.raw.prepare("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state) VALUES ('rc_u',?,?,'buyer',1,'defective','received')").run(id, line);
  assert.equal(await orderReturnMoved(w.db, id), true);
  // The fence rides only the batch that cancels: its first statement asks the same question; a replay on an order
  // already cancelled is not fenced.
  const order = row(w.raw, 'SELECT * FROM orders WHERE id=?', id)!;
  const sqlOf = (s: D1PreparedStatement) => String((s as unknown as { sql: string }).sql);
  assert.match(sqlOf((await cancelledOrderRefundStatements(w.env, order, 'admin', new Date().toISOString()))[0]), /AND NOT EXISTS \(SELECT 1 FROM return_cases rc/);
  assert.doesNotMatch(sqlOf((await cancelledOrderRefundStatements(w.env, { ...order, status: 'cancelled' }, 'admin', new Date().toISOString()))[0]), /return_cases/);
  // An ordinary cancel, no return: the customer's own cancel of a pending order gives the wallet back once, as before.
  const plain = await w.placed();
  const before = w.walletNet(plain);
  await w.ok(await post(w.a.buyer, `/api/orders/${plain}/cancel`, {}), 'ordinary cancel');
  assert.deepEqual([before, w.walletNet(plain)], [-20000, 0]);
});

test('a return refunded between a door\'s read and its write: the cancel batch\'s own fence aborts it, nothing is written, and the door refuses', async () => {
  const w = world();
  /** A delivered order with a return waiting for its refund, walked back; the refund lands inside the cancel's batch. */
  async function poised(walk: (id: string) => Promise<unknown>) {
    const id = await w.delivered();
    const caseId = await w.returned(id, 'p_plain', 'inspected');
    await walk(id);
    const race = racing(w.db, 'wallet_applied_iqd IS ?5', async () => { await w.refund(caseId); });
    return { id, race };
  }
  const settled = (id: string, left: string, race: { seen: { raced: boolean } }) => {
    assert.equal(race.seen.raced, true, 'the refund landed inside the cancel batch, after the door read');
    assert.equal(w.status(id).status, left);
    assert.equal(w.walletNet(id), -5000, 'the return refunded once, no cancel refund');
    assert.equal(count(w.raw, "SELECT COUNT(*) n FROM inventory_ledger WHERE order_id=? AND kind='restore'", id), 1, 'the unit went back once');
    assert.deepEqual(w.shelf().plain[0], w.shelf().plain[1]);
  };
  // The status door.
  const s = await poised((id) => w.move(id, 'shipped'));
  const admin = stubApp(s.race.d1, BOSS, mountGifts, { publishV2: false });
  await w.refused(await patch(admin, `/api/admin/orders/${s.id}`, { status: 'cancelled' }), ORDER_CANCEL_RETURNED, 'status door, raced');
  settled(s.id, 'shipped', s.race);
  // The stage machine (the stage panel and the courier sync).
  const m = await poised((id) => w.stage(id, 'out_for_delivery'));
  const moved = await moveOrderStage({ DB: m.race.d1 } as Env, { orderId: m.id, to: 'cancelled', source: 'manual', changedBy: 'boss' });
  assert.deepEqual([moved.moved, moved.reason], [false, ORDER_CANCEL_RETURNED]);
  settled(m.id, 'shipped', m.race);
  // The customer's cancel after a walk-back to pending.
  const c = await poised(async (id) => { await w.move(id, 'shipped'); await w.move(id, 'pending'); });
  const buyer = stubApp(c.race.d1, BUYER, mountGifts, { publishV2: false });
  await w.refused(await post(buyer, `/api/orders/${c.id}/cancel`, {}), ORDER_CANCEL_RETURNED, 'customer, raced');
  settled(c.id, 'pending', c.race);
});

test('the mirror race: the order is cancelled between the desk\'s read and its refund batch; the refund aborts and the desk refuses', async () => {
  const w = world();
  const id = await w.delivered();
  const caseId = await w.returned(id, 'p_plain', 'inspected');
  await w.move(id, 'shipped');
  const race = racing(w.db, 'UPDATE return_cases SET qty = -1 WHERE id = ?1 AND EXISTS (SELECT 1 FROM orders oc', async () => { await w.move(id, 'cancelled'); });
  const desk = stubApp(race.d1, BOSS, (x) => { x.route('/api/returns', returnRoutes); }, { publishV2: false });
  await w.refused(await post(desk, `/api/returns/admin/${caseId}/transition`, { to: 'resolved', resolution: 'refund' }), RETURN_ORDER_CANCELLED, 'refund, raced');
  assert.equal(race.seen.raced, true);
  assert.deepEqual([w.status(id).status, w.walletNet(id)], ['cancelled', 0]);
  assert.deepEqual(w.books(id).wallet.map((t) => t.id).filter((t) => String(t).startsWith('wtx_re')), [`wtx_refund_${id}_usd`], 'the cancel refunded once, the return not at all');
  assert.equal(row(w.raw, 'SELECT state FROM return_cases WHERE id=?', caseId)?.state, 'inspected');
  assert.deepEqual(w.shelf().plain, [10, 10]);
});

test('an order cancelled before this rule with a refunded return (the old double refund, written as rows): a later courier sync still moves its stage, and gives nothing back again', async () => {
  const w = world();
  const id = await w.delivered();
  await w.move(id, 'shipped');
  await w.move(id, 'pending');
  await w.ok(await post(w.a.buyer, `/api/orders/${id}/cancel`, {}), 'cancel');
  assert.deepEqual(w.status(id), { status: 'cancelled', stage: 'received' }, "the customer's cancel leaves the stage");
  // What the old doors allowed: a refunded return on it too (invented rows, as returns.ts writes them).
  const line = row<{ id: string }>(w.raw, 'SELECT id FROM order_items WHERE order_id=?', id)!.id;
  w.raw.prepare("INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution) VALUES ('rc_old',?,?,'buyer',1,'defective','resolved','refund')").run(id, line);
  w.raw.prepare("INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,amount_iqd,exchange_rate_snapshot) VALUES ('wtx_ret_rc_old','buyer','deposit','USD',1000,'approved',?,15000,1500)").run(id);
  const before = w.books(id);
  await w.courier(id);
  const sync = await syncOrderDelivery(w.env, new StubCourier('17'), id);
  assert.deepEqual([sync.outcome, w.status(id).stage], ['moved', 'cancelled'], 'the stage follows the courier; the replayed refund is not fenced');
  assert.deepEqual(w.books(id), before, 'and nothing is given back a third time');
});

test('the two refusals are codes the screens word in Arabic, English and Sorani, and each door that can cancel asks the shared question', () => {
  const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/;
  const ARABIC_ONLY = /[ةىيك]/;
  const placeholders = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();
  for (const [code, server] of [[ORDER_CANCEL_RETURNED, returnedOrderCancelRefusal()], [RETURN_ORDER_CANCELLED, cancelledOrderReturnRefusal()]] as const) {
    assert.deepEqual([server.status, server.code], [409, code]);
    const { ar, en, ckb } = REFUSAL_STRINGS[code];
    assert.notEqual(ckb, ar, `${code}: the Sorani slot carries the Arabic (row 183)`);
    assert.notEqual(ckb, en);
    assert.match(ckb, SORANI_ONLY, `${code}: no Sorani letter`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${code}: an Arabic-only letter in the Sorani`);
    assert.deepEqual(placeholders(ckb), placeholders(ar));
    assert.deepEqual(placeholders(en), placeholders(ar));
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(refusalText(code, lang), REFUSAL_STRINGS[code][lang]);
  }
  assert.ok(REFUSAL_STRINGS.ORDER_CANCEL_RETURNED.ar.startsWith('أُرجع، لا يُلغى'), "the owner's words");
  assert.ok(String(returnedOrderCancelRefusal().message).startsWith('أُرجع، لا يُلغى'));
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
  for (const door of ['worker/routes/admin.ts', 'worker/routes/orders.ts', 'worker/lib/orderStageOps.ts']) {
    assert.match(read(door), /orderReturnMoved\(/, `${door} asks the shared question`);
  }
  assert.match(read('worker/routes/admin.ts'), /res\.reason === 'ORDER_CANCEL_RETURNED'\) throw returnedOrderCancelRefusal\(\)/, 'the stage door answers the stage machine');
  assert.match(read('worker/lib/delivery/sync.ts'), /move\.reason === 'ORDER_CANCEL_RETURNED'/, 'the courier sync keeps its trace');
  assert.match(read('worker/routes/returns.ts'), /orderCancelled\(c\.env\.DB, kase\.order_id\)\) throw cancelledOrderReturnRefusal\(\)/, 'the returns desk asks the mirror question');
});
