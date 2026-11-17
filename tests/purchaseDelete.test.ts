/**
 * «حذف نهائي» — A CANCELLED PURCHASE, OR AN UNCONFIRMED DRAFT, IS DELETED
 * PERMANENTLY (owner request 2026-11-17: «Purchase orders for orders has
 * cancelled can not be remove permanently»).
 *
 * `POST /api/admin/procurement/documents/:id/delete` with `{ version }`, owner
 * only. It takes away the purchase, its lines, charges, incoming rows and
 * unreceived piece origins in one batch with the `purchase.deleted` audit row;
 * it refuses with a code from the cost contract (three languages) and writes
 * nothing while anything real hangs on the purchase: a receipt, money,
 * investor funding, a registered serial — or when the screen is stale.
 *
 * Run: TZ=UTC node --import tsx --test tests/purchaseDelete.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, all, count, row, type StubUser } from './fixtures/app';
import type { SqliteStatement } from './fixtures/d1';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { baghdadDay } from '../worker/lib/operations';
import { COST_REFUSALS, serverMessage } from '../packages/contracts/src/costRefusals';

const OWNER: StubUser = { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' };
const FULL: StubUser = { id: 'full', email: 'full@x.co', role: 'admin', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'asst', email: 'asst@x.co', role: 'admin', admin_scope: 'assistant' };

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('owner','boss@x.co','Owner','admin','full'),('full','full@x.co','Full','admin','full'),('asst','asst@x.co','Asst','admin','assistant'),('investor','investor@x.co','Investor','admin','assistant');
    INSERT INTO inventory_suppliers(id,name) VALUES ('germany','Germany');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('part','Part','delete-part',50000,NULL,0,'BASE'),('tool','Tool','delete-tool',80000,NULL,0,'BASE');`);
  const real = asD1(raw);
  // Runs `between` after the route read the purchase and before its batch commits (a concurrent write).
  let between: (() => void) | null = null;
  const db = {
    prepare: (sql: string) => real.prepare(sql),
    async batch(statements: SqliteStatement[]) {
      if (between && statements.some((s) => s.sql.startsWith('DELETE FROM purchase_orders'))) {
        const run = between;
        between = null;
        run();
      }
      return real.batch(statements as unknown as D1PreparedStatement[]);
    },
  } as unknown as D1Database;
  const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
    a.route('/p', adminProcurementRoutes);
    a.route('/i', adminInvestmentFinanceRoutes);
  };
  const app = stubApp(db, OWNER, mount);
  const full = stubApp(db, FULL, mount);
  const assistant = stubApp(db, ASSISTANT, mount);
  const payload = (extra: Record<string, unknown> = {}) => ({
    operation_id: crypto.randomUUID(),
    supplier_id: 'germany',
    invoice_no: 'شحنة للحذف',
    currency: 'IQD',
    purchase_day: baghdadDay(),
    status: 'ordered',
    cost_state: 'final',
    lines: [
      { product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 2, source_unit_amount: 10000 },
      { product_id: 'tool', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: 30000, unit_origins: [{ unit_index: 1, supplier_order_no: 'ORDER-1', tracking_no: 'TRACK-1' }] },
    ],
    charges: [{ title: 'Freight', amount_iqd: 6000, basis: 'quantity' }],
    ...extra,
  });
  const create = async (body: Record<string, unknown> = payload()) => {
    const res = await post(app, '/p/documents', body);
    const out = await json(res);
    assert.equal(res.status, 200, JSON.stringify(out));
    return String(out.id);
  };
  const close = async (id: string) => assert.equal((await post(app, `/p/documents/${id}/close`, { reason: 'ألغى المورد الشحنة' })).status, 200);
  const version = (id: string) => row<{ version: number }>(raw, 'SELECT version FROM purchase_orders WHERE id=?', id)?.version ?? 0;
  const remove = async (id: string, who = app, v = version(id)) => {
    const res = await post(who, `/p/documents/${id}/delete`, { version: v });
    return { status: res.status, body: await json(res) };
  };
  /** Every row the purchase owns, by table. */
  const owned = (id: string) => ({
    purchase: count(raw, 'SELECT COUNT(*) AS n FROM purchase_orders WHERE id=?', id),
    lines: count(raw, 'SELECT COUNT(*) AS n FROM purchase_lines WHERE purchase_id=?', id),
    charges: count(raw, 'SELECT COUNT(*) AS n FROM purchase_charges WHERE purchase_id=?', id),
    origins: count(raw, 'SELECT COUNT(*) AS n FROM inventory_unit_origins WHERE purchase_id=?', id),
  });
  return { raw, app, full, assistant, payload, create, close, version, remove, owned, setBetween: (f: () => void) => { between = f; } };
}

test('a cancelled purchase and an unconfirmed draft are deleted with every row they own, in one write with one audit row', async () => {
  const x = setup();
  const cancelled = await x.create();
  await x.close(cancelled);
  const draft = await x.create(x.payload({ status: 'draft', lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 3, source_unit_amount: 10000 }] }));
  const kept = await x.create();
  assert.equal(row<{ status: string }>(x.raw, 'SELECT status FROM purchase_orders WHERE id=?', cancelled)?.status, 'cancelled');
  assert.equal(row<{ status: string }>(x.raw, 'SELECT status FROM purchase_orders WHERE id=?', draft)?.status, 'draft');
  const incoming = (id: string) => all<{ incoming_id: string }>(x.raw, 'SELECT incoming_id FROM purchase_lines WHERE purchase_id=?', id).map((r) => r.incoming_id);
  const cancelledIncoming = incoming(cancelled), draftIncoming = incoming(draft);
  assert.equal(cancelledIncoming.length, 2);
  assert.deepEqual(x.owned(cancelled), { purchase: 1, lines: 2, charges: 1, origins: 1 });
  const keptBefore = x.owned(kept);

  for (const id of [cancelled, draft]) {
    const r = await x.remove(id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { success: true, id });
    assert.deepEqual(x.owned(id), { purchase: 0, lines: 0, charges: 0, origins: 0 });
  }
  for (const i of [...cancelledIncoming, ...draftIncoming])
    assert.equal(count(x.raw, 'SELECT COUNT(*) AS n FROM incoming_inventory WHERE id=?', i), 0, 'its incoming rows go with it');
  assert.equal(count(x.raw, "SELECT COUNT(*) AS n FROM pricing_v2_purchase_reviews WHERE purchase_id=? AND state='pending'", cancelled), 0);
  assert.deepEqual(x.owned(kept), keptBefore, 'another purchase is untouched');

  const audits = all<{ target: string; actor_id: string; detail: string }>(x.raw, "SELECT target,actor_id,detail FROM audit_log WHERE action='purchase.deleted' ORDER BY id");
  assert.deepEqual(audits.map((a) => a.target), [cancelled, draft]);
  assert.equal(audits[0].actor_id, 'owner');
  const detail = JSON.parse(audits[0].detail) as Record<string, unknown>;
  assert.equal(detail.status, 'cancelled');
  assert.equal(detail.invoice_no, 'شحنة للحذف');
  assert.equal(detail.lines, 2);
  assert.ok(detail.request && typeof detail.request === 'object', 'the request it was saved from is kept in the audit');

  const register = await json(await get(x.app, '/p/documents'));
  const ids = (register.purchases as Array<{ id: string }>).map((p) => p.id);
  assert.ok(!ids.includes(cancelled) && !ids.includes(draft) && ids.includes(kept), 'the register no longer lists them');
  assert.equal((await x.remove(cancelled, x.app, 1)).status, 404, 'a second delete finds nothing');
});

test('only cancelled or draft: an ordered, partly or fully received purchase is refused with PURCHASE_DELETE_STATUS; nothing is written', async () => {
  const x = setup();
  const ordered = await x.create();
  const partial = await x.create();
  const lines = all<{ line_id: string }>(x.raw, 'SELECT id AS line_id FROM purchase_lines WHERE purchase_id=? ORDER BY id', partial);
  assert.equal((await post(x.app, `/p/documents/${partial}/receive`, { operation_id: crypto.randomUUID(), lines: [{ line_id: lines[0].line_id, qty: 1 }] })).status, 200);
  for (const id of [ordered, partial]) {
    const before = x.owned(id);
    const r = await x.remove(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PURCHASE_DELETE_STATUS');
    assert.equal(r.body.error, serverMessage('PURCHASE_DELETE_STATUS'));
    assert.deepEqual(x.owned(id), before);
  }
  // A partly received purchase that is closed becomes «received», never «cancelled»: it stays.
  await x.close(partial);
  assert.equal((await x.remove(partial)).body.code, 'PURCHASE_DELETE_STATUS');
  assert.equal(count(x.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action='purchase.deleted'"), 0);
});

test('a cancelled purchase with a supplier payment, investor funding or a registered serial stays — each with its own code', async () => {
  const x = setup();
  // Paid, then cancelled.
  const paid = await x.create();
  const pay = await post(x.app, `/p/documents/${paid}/payments`, { operation_id: crypto.randomUUID(), amount_iqd: 5000, payment_day: baghdadDay() });
  assert.equal(pay.status, 200, JSON.stringify(await json(pay)));
  await x.close(paid);
  // Investor-funded, then cancelled.
  assert.equal((await post(x.app, '/i/profiles', { user_id: 'investor', default_profit_share_bps: 3500, default_loss_share_bps: 0 })).status, 200);
  const funded = await x.create(x.payload({ funding: { mode: 'investor', user_id: 'investor', agreed_iqd: 76000, received_iqd: 76000, reference: 'CASH', profit_share_bps: 3500, loss_share_bps: 0 } }));
  await x.close(funded);
  // A serial registered on one of its pieces, then cancelled.
  const serial = await x.create();
  x.raw.prepare("UPDATE inventory_unit_origins SET serial_norm='SN-DELETE-1' WHERE purchase_id=?").run(serial);
  await x.close(serial);

  for (const [id, code] of [[paid, 'PURCHASE_DELETE_PAID'], [funded, 'PURCHASE_DELETE_FUNDED'], [serial, 'PURCHASE_DELETE_SERIALS']] as const) {
    assert.equal(row<{ status: string }>(x.raw, 'SELECT status FROM purchase_orders WHERE id=?', id)?.status, 'cancelled');
    const before = x.owned(id);
    const r = await x.remove(id);
    assert.equal(r.status, 409, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code);
    assert.equal(r.body.error, serverMessage(code));
    assert.deepEqual(x.owned(id), before, `${code}: nothing deleted`);
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(COST_REFUSALS[code][lang].length > 0);
  }
  assert.equal(count(x.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action='purchase.deleted'"), 0);
});

test('a stale screen and a concurrent write are refused with INCOMING_CHANGED; nothing is deleted', async () => {
  const x = setup();
  const id = await x.create();
  await x.close(id);
  const before = x.owned(id);
  const stale = await x.remove(id, x.app, x.version(id) - 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'INCOMING_CHANGED');
  assert.deepEqual(x.owned(id), before);
  // A supplier payment lands between the route's read and its batch: the fence refuses the whole batch.
  x.setBetween(() => x.raw.prepare("INSERT INTO supplier_payments(id,purchase_id,amount_iqd,payment_day,reference,actor_id,created_at) VALUES ('raced-pay',?,1000,?,'', 'owner',?)").run(id, baghdadDay(), new Date().toISOString()));
  const raced = await x.remove(id);
  assert.equal(raced.status, 409, JSON.stringify(raced.body));
  assert.equal(raced.body.code, 'INCOMING_CHANGED');
  assert.deepEqual(x.owned(id), before);
  assert.equal(count(x.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action='purchase.deleted'"), 0);
});

test('the owner alone: a full admin and an assistant get the cost refusal, for a real and an invented purchase alike; a missing version is a 400', async () => {
  const x = setup();
  const id = await x.create();
  await x.close(id);
  for (const who of [x.full, x.assistant]) {
    const real = await x.remove(id, who);
    const invented = await post(who, '/p/documents/po_invented_000/delete', { version: 1 });
    assert.equal(real.status, 403);
    assert.equal(real.body.code, 'COST_ACCESS_DENIED');
    assert.deepEqual(await json(invented), real.body, 'one answer, no existence oracle');
  }
  assert.equal((await post(x.app, `/p/documents/${id}/delete`, {})).status, 400);
  assert.equal(x.owned(id).purchase, 1);
});
