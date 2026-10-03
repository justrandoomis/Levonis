import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, put, get, json, count } from './fixtures/app';
import type { SqliteStatement } from './fixtures/d1';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { baghdadDay } from '../worker/lib/operations';

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('admin','boss@x.co','admin');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode)
      VALUES ('part','Part','concurrency-part','CONCURRENT',20000,10000,0,'BASE');`);
  const real = asD1(raw);
  let gate: { fragment: string; entered: () => void; resumed: Promise<void> } | undefined;
  const db = {
    prepare: (sql: string) => real.prepare(sql),
    async batch(statements: SqliteStatement[]) {
      const pending = gate;
      if (pending && statements.some((s) => s.sql.includes(pending.fragment))) {
        gate = undefined;
        pending.entered();
        await pending.resumed;
      }
      return real.batch(statements as unknown as D1PreparedStatement[]);
    },
  } as unknown as D1Database;
  const app = stubApp(db, { id: 'admin', email: 'boss@x.co', role: 'admin' }, (a) => {
    a.route('/p', adminProcurementRoutes);
  });
  const pauseOn = (fragment: string) => {
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    gate = { fragment, entered, resumed };
    return { waiting, resume };
  };
  return { raw, app, pauseOn };
}

async function create(app: ReturnType<typeof setup>['app']) {
  const body = {
    operation_id: crypto.randomUUID(),
    supplier_id: 'supplier',
    currency: 'IQD',
    purchase_day: baghdadDay(),
    status: 'ordered',
    cost_state: 'final',
    lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: 10000 }],
    charges: [],
  };
  const result = await post(app, '/p/documents', body);
  assert.equal(result.status, 200, JSON.stringify(await json(result.clone())));
  const { id } = await json(result);
  const detail = await json(await get(app, `/p/documents/${id}`));
  return {
    id: id as string,
    body,
    line: detail.lines[0].line_id as string,
    payment: { operation_id: crypto.randomUUID(), amount_iqd: 10000 },
    receipt: { operation_id: crypto.randomUUID(), lines: [{ line_id: detail.lines[0].line_id as string, qty: 1 }] },
  };
}
function assertSettled(raw: ReturnType<typeof freshDb>) {
  for (const account of ['1300', '2000']) {
    assert.equal(count(raw, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) n FROM accounting_lines WHERE account_code=?', account), 0);
  }
  assert.equal(count(raw, 'SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines'), 0);
  assert.equal(count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1000'"), -10000);
  assert.equal(count(raw, "SELECT SUM(debit_iqd-credit_iqd) n FROM accounting_lines WHERE account_code='1200'"), 10000);
}

test('receipt invalidates an earlier payment plan; retry settles payable once', { timeout: 10000 }, async () => {
  const { raw, app, pauseOn } = setup();
  const p = await create(app);
  const gate = pauseOn('INSERT INTO supplier_payments');
  const stale = post(app, `/p/documents/${p.id}/payments`, p.payment);
  await gate.waiting;
  assert.equal((await post(app, `/p/documents/${p.id}/receive`, p.receipt)).status, 200);
  gate.resume();
  const rejected = await stale;
  assert.equal(rejected.status, 409);
  assert.equal((await json(rejected)).code, 'VERSION_CHANGED');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM supplier_payments'), 0);
  assert.equal((await post(app, `/p/documents/${p.id}/payments`, p.payment)).status, 200);
  assert.equal((await post(app, `/p/documents/${p.id}/payments`, p.payment)).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM supplier_payments'), 1);
  assertSettled(raw);
});

test('payment invalidates an earlier receipt plan; retry clears prepaid once', { timeout: 10000 }, async () => {
  const { raw, app, pauseOn } = setup();
  const p = await create(app);
  const gate = pauseOn('INSERT INTO purchase_receiving_events');
  const stale = post(app, `/p/documents/${p.id}/receive`, p.receipt);
  await gate.waiting;
  assert.equal((await post(app, `/p/documents/${p.id}/payments`, p.payment)).status, 200);
  gate.resume();
  assert.equal((await stale).status, 409);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM purchase_receiving_events'), 0);
  assert.equal(count(raw, "SELECT stock n FROM products WHERE id='part'"), 0);
  assert.equal((await post(app, `/p/documents/${p.id}/receive`, p.receipt)).status, 200);
  assert.equal((await post(app, `/p/documents/${p.id}/receive`, p.receipt)).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM purchase_receiving_events'), 1);
  assert.equal(count(raw, "SELECT stock n FROM products WHERE id='part'"), 1);
  assertSettled(raw);
});

test('document cost edit blocks a stale payment that exceeds its new total', { timeout: 10000 }, async () => {
  const { raw, app, pauseOn } = setup();
  const p = await create(app);
  const gate = pauseOn('INSERT INTO supplier_payments');
  const stale = post(app, `/p/documents/${p.id}/payments`, p.payment);
  await gate.waiting;
  const edit = await put(app, `/p/documents/${p.id}`, {
    ...p.body,
    version: 1,
    lines: [{ ...p.body.lines[0], source_unit_amount: 5000 }],
  });
  assert.equal(edit.status, 200, JSON.stringify(await json(edit)));
  gate.resume();
  assert.equal((await stale).status, 409);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM supplier_payments'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), 0);
  assert.equal((await post(app, `/p/documents/${p.id}/payments`, p.payment)).status, 400);
  assert.equal((await post(app, `/p/documents/${p.id}/payments`, { ...p.payment, amount_iqd: 5000 })).status, 200);
});

test('cancelling an unreceived purchase blocks a previously planned payment', { timeout: 10000 }, async () => {
  const { raw, app, pauseOn } = setup();
  const p = await create(app);
  const gate = pauseOn('INSERT INTO supplier_payments');
  const stale = post(app, `/p/documents/${p.id}/payments`, p.payment);
  await gate.waiting;
  assert.equal((await post(app, `/p/documents/${p.id}/close`, { reason: 'Cancel before receipt' })).status, 200);
  gate.resume();
  assert.equal((await stale).status, 409);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM supplier_payments'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM accounting_entries'), 0);
  assert.equal((await post(app, `/p/documents/${p.id}/payments`, p.payment)).status, 400);
});
