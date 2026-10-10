/**
 * «تغيير الاسم» — A STOCK PURCHASE IS NAMED, AND RENAMED AT ANY STATUS (owner
 * request 2026-10-10: «لا يمكن تسمية المخزون»).
 *
 * `PATCH /api/admin/procurement/documents/:id/name` writes the purchase's name
 * (`purchase_orders.invoice_no`) and the receiving copies
 * (`incoming_inventory.supplier_ref`) in one batch with the audit row, at every
 * status — draft, ordered, investor-funded, partly or fully received,
 * cancelled — never touching a cost column, the version, a lot or the FX
 * snapshot. The same name is `already`; a stale or concurrent rename is a 409;
 * the register, the receiving list and the participant report read the new
 * name.
 *
 * Run: node --import tsx --test tests/purchaseRename.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, patch, get, json, all, count, row, type StubUser } from './fixtures/app';
import type { SqliteStatement } from './fixtures/d1';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { participantReport } from '../worker/lib/financeParticipantReports';
import { baghdadDay } from '../worker/lib/operations';
import { PURCHASE_NAME_STRINGS, purchaseNameFits, purchaseNameText } from '../src/components/adminOperations/purchaseName';

const OWNER: StubUser = { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' };
const RECEIVER: StubUser = { id: 'asst', email: 'asst@x.co', role: 'admin', admin_scope: 'assistant' };
const NAME = 'شحنة ألمانيا — تشرين الأول';

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('owner','boss@x.co','Owner','admin','full'),('investor','investor@x.co','Investor','admin','assistant'),('asst','asst@x.co','Asst','admin','assistant');
    INSERT INTO inventory_suppliers(id,name) VALUES ('germany','Germany');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('a1','Bambu Lab A1','rename-a1',965000,500000,0,'OPTION'),('part','Part','rename-part',50000,NULL,0,'BASE');
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES('model','a1','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,stock) VALUES('combo','a1','model','Combo',0);`);
  const real = asD1(raw);
  // Runs `between` after the route read the name and before its batch commits (a concurrent rename).
  let between: (() => void) | null = null;
  const db = {
    prepare: (sql: string) => real.prepare(sql),
    async batch(statements: SqliteStatement[]) {
      if (between && statements.some((s) => s.sql.startsWith('UPDATE purchase_orders SET invoice_no'))) {
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
  const receiver = stubApp(db, RECEIVER, mount);
  const payload = (extra: Record<string, unknown> = {}) => ({
    operation_id: crypto.randomUUID(),
    supplier_id: 'germany',
    currency: 'IQD',
    purchase_day: baghdadDay(),
    status: 'ordered',
    cost_state: 'final',
    lines: [
      { product_id: 'a1', scope: 'option', scope_id: 'combo', qty_ordered: 5, purchase_cost_mode: 'total', source_total_amount: 2500000 },
      { product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 2, source_unit_amount: 10000 },
    ],
    charges: [{ title: 'Freight', amount_iqd: 500000, basis: 'quantity' }],
    ...extra,
  });
  const create = async (body: Record<string, unknown> = payload()) => {
    const res = await post(app, '/p/documents', body);
    const out = await json(res);
    assert.equal(res.status, 200, JSON.stringify(out));
    return { id: String(out.id), body };
  };
  const detail = async (id: string) => json(await get(app, `/p/documents/${id}`));
  const receive = async (id: string, qty?: number) => {
    const d = await detail(id);
    const res = await post(app, `/p/documents/${id}/receive`, {
      operation_id: crypto.randomUUID(),
      lines: (d.lines as Array<{ line_id: string; qty_ordered: number; qty_received: number }>).map((l) => ({ line_id: l.line_id, qty: qty ?? l.qty_ordered - l.qty_received })),
    });
    assert.equal(res.status, 200, JSON.stringify(await json(res)));
  };
  const rename = async (id: string, body: Record<string, unknown>, who = app) => {
    const res = await patch(who, `/p/documents/${id}/name`, body);
    return { status: res.status, body: await json(res) };
  };
  const state = (id: string) => ({
    name: row<{ invoice_no: string }>(raw, 'SELECT invoice_no FROM purchase_orders WHERE id=?', id)!.invoice_no,
    version: row<{ version: number }>(raw, 'SELECT version FROM purchase_orders WHERE id=?', id)!.version,
    refs: all<{ supplier_ref: string }>(raw, 'SELECT i.supplier_ref FROM purchase_lines l JOIN incoming_inventory i ON i.id=l.incoming_id WHERE l.purchase_id=? ORDER BY l.id', id).map((r) => r.supplier_ref),
    audits: all<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action='purchase.renamed' AND target=? ORDER BY id", id).map((r) => JSON.parse(r.detail) as { before: string; after: string }),
  });
  return { raw, app, receiver, payload, create, detail, receive, rename, state, setBetween: (f: () => void) => { between = f; } };
}

test('renamed at every status — draft, ordered, investor-funded, partly and fully received, cancelled — name and receiving copies in one write, the version kept, one audit row', async () => {
  const x = setup();
  assert.equal((await post(x.app, '/i/profiles', { user_id: 'investor', default_profit_share_bps: 3500, default_loss_share_bps: 0 })).status, 200);
  const draft = await x.create(x.payload({ status: 'draft' }));
  const ordered = await x.create();
  const funded = await x.create(x.payload({ funding: { mode: 'investor', user_id: 'investor', agreed_iqd: 3000000, received_iqd: 3000000, reference: 'CASH', profit_share_bps: 3500, loss_share_bps: 0 } }));
  const partial = await x.create();
  await x.receive(partial.id, 1);
  const received = await x.create();
  await x.receive(received.id);
  const cancelled = await x.create();
  assert.equal((await post(x.app, `/p/documents/${cancelled.id}/close`, { reason: 'لم تصل' })).status, 200);
  const statuses = Object.fromEntries(all<{ id: string; status: string }>(x.raw, 'SELECT id,status FROM purchase_orders').map((r) => [r.id, r.status]));
  assert.deepEqual([draft, ordered, funded, partial, received, cancelled].map((p) => statuses[p.id]), ['draft', 'ordered', 'ordered', 'partial', 'received', 'cancelled']);
  assert.ok((await x.detail(funded.id)).funding, 'the funded purchase has its agreement (the full edit is closed to it)');

  const lotsBefore = JSON.stringify(all(x.raw, 'SELECT * FROM inventory_lots ORDER BY id'));
  const fxBefore = JSON.stringify(all(x.raw, 'SELECT id,fx_snapshot_at,fx_usd_iqd_at_purchase,currency,exchange_rate,cost_state FROM purchase_orders ORDER BY id'));
  for (const p of [draft, ordered, funded, partial, received, cancelled]) {
    const before = x.state(p.id);
    const r = await x.rename(p.id, { name: `  ${NAME}\n ` });
    assert.equal(r.status, 200, `${statuses[p.id]}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.name, NAME, 'whitespace collapsed and trimmed');
    const after = x.state(p.id);
    assert.equal(after.name, NAME);
    assert.deepEqual(after.refs, after.refs.map(() => NAME), `${statuses[p.id]}: every line's receiving copy follows`);
    assert.equal(after.refs.length, 2);
    assert.equal(after.version, before.version, `${statuses[p.id]}: the version fences cost edits, not the name`);
    assert.deepEqual(after.audits, [{ before: '', after: NAME }]);
  }
  // No cost, lot or FX snapshot moved — and no 0182 freeze trigger fired on the received purchases.
  assert.equal(JSON.stringify(all(x.raw, 'SELECT * FROM inventory_lots ORDER BY id')), lotsBefore);
  assert.equal(JSON.stringify(all(x.raw, 'SELECT id,fx_snapshot_at,fx_usd_iqd_at_purchase,currency,exchange_rate,cost_state FROM purchase_orders ORDER BY id')), fxBefore);

  // The same name: `already`, no write, no second audit row. Empty clears it.
  const again = await x.rename(received.id, { name: NAME });
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal(x.state(received.id).audits.length, 1);
  const cleared = await x.rename(received.id, { name: '' });
  assert.equal(cleared.status, 200);
  assert.equal(x.state(received.id).name, '');
  assert.deepEqual(x.state(received.id).refs, ['', '']);
  assert.deepEqual(x.state(received.id).audits.at(-1), { before: NAME, after: '' });
});

test('every reader shows the new name: the register, the receiver’s list (no cost) and the participant report', async () => {
  const x = setup();
  const p = await x.create();
  await x.receive(p.id, 1);
  assert.equal((await x.rename(p.id, { name: NAME })).status, 200);
  const register = await json(await get(x.app, '/p/documents'));
  assert.equal((register.purchases as Array<{ id: string; invoice_no: string }>).find((r) => r.id === p.id)?.invoice_no, NAME);
  const receiving = await json(await get(x.receiver, '/p/receiving'));
  const head = (receiving.purchases as Array<Record<string, unknown>>).find((r) => r.id === p.id)!;
  assert.equal(head.invoice_no, NAME);
  assert.equal('total_cost_iqd' in head, false, 'the receiver still sees no cost');
  assert.equal((await json(await get(x.receiver, `/p/receiving/${p.id}`))).purchase.invoice_no, NAME);
  const report = await participantReport(asD1(x.raw), { from: null, to: null });
  assert.equal(report.batches.find((b) => b.id === p.id)?.name, NAME);
});

test('refusals: over 120 characters, an unknown purchase, a non-owner, an unknown key, a name that is not text', async () => {
  const x = setup();
  const p = await x.create();
  const long = await x.rename(p.id, { name: 'ا'.repeat(121) });
  assert.equal(long.status, 400);
  assert.equal(long.body.code, 'PURCHASE_NAME_TOO_LONG');
  assert.ok(!String(long.body.error).includes('ا'.repeat(10)), 'the refusal never repeats the name');
  assert.equal((await x.rename(p.id, { name: 'ا'.repeat(120) })).status, 200, '120 characters fit');
  assert.equal((await x.rename('po_missing_00000', { name: NAME })).status, 404);
  const assistant = await x.rename(p.id, { name: NAME }, x.receiver);
  assert.equal(assistant.status, 403);
  assert.equal(assistant.body.code, 'COST_ACCESS_DENIED');
  const extra = await x.rename(p.id, { name: NAME, invoice_total_iqd: 1 });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.code, 'UNKNOWN_FIELD');
  assert.equal((await x.rename(p.id, { name: 42 })).status, 400);
  assert.equal((await x.rename(p.id, {})).status, 400, 'a body without the name never clears it');
  assert.equal(x.state(p.id).name, 'ا'.repeat(120), 'no refused call wrote anything');
  assert.equal(x.state(p.id).audits.length, 1);
});

test('a stale screen and a concurrent rename are refused with 409 PURCHASE_NAME_CHANGED; nothing is written', async () => {
  const x = setup();
  const p = await x.create();
  assert.equal((await x.rename(p.id, { name: 'A', before: '' })).status, 200);
  // The screen still shows '' while the purchase is called A.
  const stale = await x.rename(p.id, { name: 'B', before: '' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PURCHASE_NAME_CHANGED');
  assert.equal(x.state(p.id).name, 'A');
  // The same target name from a stale screen is already done, not a conflict.
  assert.equal((await x.rename(p.id, { name: 'A', before: '' })).body.already, true);
  // Another rename lands between the read and the batch: the in-batch fence refuses this one.
  x.setBetween(() => x.raw.prepare("UPDATE purchase_orders SET invoice_no='C' WHERE id=?").run(p.id));
  const raced = await x.rename(p.id, { name: 'B', before: 'A' });
  assert.equal(raced.status, 409, JSON.stringify(raced.body));
  assert.equal(raced.body.code, 'PURCHASE_NAME_CHANGED');
  assert.equal(x.state(p.id).name, 'C');
  assert.deepEqual(x.state(p.id).refs, ['A', 'A'], 'the refused batch left the receiving copies as the last rename wrote them');
  assert.equal(x.state(p.id).audits.length, 1, 'no audit row for a refused rename');
  assert.equal(count(x.raw, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

test('the original POST replayed after a rename is still `already`; a rename leaves request_json alone', async () => {
  const x = setup();
  const p = await x.create();
  const before = row<{ request_json: string }>(x.raw, 'SELECT request_json FROM purchase_orders WHERE id=?', p.id)!.request_json;
  assert.equal((await x.rename(p.id, { name: NAME })).status, 200);
  assert.equal(row<{ request_json: string }>(x.raw, 'SELECT request_json FROM purchase_orders WHERE id=?', p.id)!.request_json, before);
  const replay = await post(x.app, '/p/documents', p.body);
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).already, true);
  assert.equal(count(x.raw, 'SELECT COUNT(*) AS n FROM purchase_orders'), 1);
});

test('the screen’s name helpers and words: collapsed like the server, 120 at most, ar/en and real Sorani', () => {
  assert.equal(purchaseNameText('  a \n  b  '), 'a b');
  assert.equal(purchaseNameFits('ب'.repeat(120)), true);
  assert.equal(purchaseNameFits(`${'ب'.repeat(120)}ب`), false);
  assert.equal(purchaseNameFits(`  ${'ب'.repeat(120)}  `), true, 'surrounding space is not counted');
  const keys = Object.keys(PURCHASE_NAME_STRINGS.ar);
  assert.deepEqual(Object.keys(PURCHASE_NAME_STRINGS.en).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(PURCHASE_NAME_STRINGS.ckb).sort(), [...keys].sort());
  for (const k of keys) {
    const ar = PURCHASE_NAME_STRINGS.ar[k as keyof typeof PURCHASE_NAME_STRINGS.ar];
    const en = PURCHASE_NAME_STRINGS.en[k as keyof typeof PURCHASE_NAME_STRINGS.en];
    const ckb = PURCHASE_NAME_STRINGS.ckb[k as keyof typeof PURCHASE_NAME_STRINGS.ckb];
    assert.ok(ar && en && ckb, k);
    assert.notEqual(ckb, ar, `${k}: ckb copies the Arabic`);
    assert.notEqual(ckb, en, `${k}: ckb copies the English`);
    assert.match(ckb, /[ڕڵێۆەڤگچپژ]/, `${k}: no Sorani letter`);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${k}: an Arabic-only letter in the Sorani`);
    assert.doesNotMatch(en, /[؀-ۿ]/, `${k}: Arabic script in the English`);
  }
  assert.equal(PURCHASE_NAME_STRINGS.ar.label, 'اسم الشراء أو رقم الفاتورة');
  assert.equal(PURCHASE_NAME_STRINGS.ckb.label, 'ناوی کڕین یان ژمارەی پسوولە');
  assert.equal(PURCHASE_NAME_STRINGS.ar.fallback, 'شراء بلا اسم');
});
