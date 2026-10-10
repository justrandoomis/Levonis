/**
 * A PURCHASE REMEMBERS THE CENTRAL RATES OF THE DAY IT WAS ORDERED (FX
 * programme plan §4.1 part 5, §9 §17; critique L6).
 *
 * The first time a purchase document is confirmed 'ordered' it stores the
 * effective USD/IQD, EUR/USD and CNY/USD in force — by a SEPARATE statement
 * guarded on `fx_snapshot_at IS NULL`, never through the header that
 * `planDocument` rewrites on every save. So a later edit of the ordered
 * document, and every later rate change, leave it exactly as it was; a rate
 * not known then is NULL (UNKNOWN). On a database without migration 0179 the
 * snapshot is skipped and the purchase still saves.
 *
 * Run: node --import tsx --test tests/procurementFxSnapshot.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, hasColumn, json, post, put, row, stubApp } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { baghdadDay } from '../worker/lib/operations';

function setup(raw: DatabaseSync = freshDb()) {
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('admin','boss@x.co','admin');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode)
      VALUES ('part','Part','fx-snapshot-part','FXSNAP',20000,10000,0,'BASE');`);
  const app = stubApp(asD1(raw), { id: 'admin', email: 'boss@x.co', role: 'admin' }, (a) => a.route('/p', adminProcurementRoutes));
  return { raw, app };
}

const bodyOf = (status: 'draft' | 'ordered', note = '') => ({
  operation_id: crypto.randomUUID(),
  supplier_id: 'supplier',
  currency: 'IQD',
  purchase_day: baghdadDay(),
  status,
  cost_state: 'final',
  note,
  lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: 10000 }],
  charges: [],
});

const snapshot = (raw: DatabaseSync, id: string) =>
  row<Record<string, unknown>>(raw, 'SELECT fx_usd_iqd_at_purchase AS u, fx_eur_usd_at_purchase AS e, fx_cny_usd_at_purchase AS c, fx_snapshot_at AS at FROM purchase_orders WHERE id = ?', id)!;

async function edit(app: ReturnType<typeof setup>['app'], id: string, base: ReturnType<typeof bodyOf>, patch: Partial<ReturnType<typeof bodyOf>>) {
  const detail = await json(await get(app, `/p/documents/${id}`));
  const res = await put(app, `/p/documents/${id}`, { ...base, ...patch, version: detail.purchase.version });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
}

test('ordered purchase stores the central U/E/C once; a later edit of the ordered document and later rate changes do not alter it', async () => {
  const { raw, app } = setup();
  applyRate(raw, 'USD_IQD', '1660');
  applyRate(raw, 'EUR_USD', '1.1186');
  applyRate(raw, 'CNY_USD', '0.1492023689');
  const draft = bodyOf('draft');
  const created = await json(await post(app, '/p/documents', draft));
  assert.equal(snapshot(raw, created.id).at, null, 'a draft takes no snapshot');
  await edit(app, created.id, draft, { status: 'ordered' });
  const first = snapshot(raw, created.id);
  assert.deepEqual({ u: first.u, e: first.e, c: first.c }, { u: '1660', e: '1.1186', c: '0.1492023689' });
  assert.ok(first.at);
  // Rates move; the ordered document is edited again: the snapshot is the purchase day's.
  raw.exec("UPDATE fx_rate_pairs SET effective_rate = '1700', effective_version = effective_version + 1, drift_anchor_rate = '1700', last_known_good_rate = '1700' WHERE pair = 'USD_IQD'");
  await edit(app, created.id, { ...draft, status: 'ordered' }, { note: 'invoice corrected' });
  assert.deepEqual(snapshot(raw, created.id), first);
});

test('NULL when unset: a purchase ordered before any rate was approved records UNKNOWN, once', async () => {
  const { raw, app } = setup();
  const res = await json(await post(app, '/p/documents', bodyOf('ordered')));
  const s = snapshot(raw, res.id);
  assert.deepEqual({ u: s.u, e: s.e, c: s.c }, { u: null, e: null, c: null });
  assert.ok(s.at, 'the moment is recorded: the rates were unknown then');
  applyRate(raw, 'USD_IQD', '1660');
  await edit(app, res.id, bodyOf('ordered'), { note: 'later' });
  assert.equal(snapshot(raw, res.id).u, null, 'a later rate never back-fills a purchase-time snapshot');
});

test('deploy ahead of 0179: an ordered purchase still saves, with no FX statement', async () => {
  const raw = dbThrough('0177');
  const { app } = setup(raw);
  const res = await post(app, '/p/documents', bodyOf('ordered'));
  assert.equal(res.status, 200);
  assert.equal(hasColumn(raw, 'purchase_orders', 'fx_snapshot_at'), false);
});

test('FX-6 (0182): the snapshot records each rate\'s version beside it, once — a pair with no rate then has none', async () => {
  const { raw, app } = setup();
  applyRate(raw, 'USD_IQD', '1650');
  applyRate(raw, 'USD_IQD', '1660'); // version 2
  applyRate(raw, 'EUR_USD', '1.1186'); // version 1; CNY/USD never approved
  const res = await json(await post(app, '/p/documents', bodyOf('ordered')));
  const versions = () => row<Record<string, unknown>>(raw, 'SELECT fx_usd_iqd_version_at_purchase u, fx_eur_usd_version_at_purchase e, fx_cny_usd_version_at_purchase c FROM purchase_orders WHERE id = ?', res.id)!;
  assert.deepEqual(versions(), { u: 2, e: 1, c: null });
  applyRate(raw, 'USD_IQD', '1700');
  await edit(app, res.id, bodyOf('ordered'), { note: 'later' });
  assert.deepEqual(versions(), { u: 2, e: 1, c: null }, 'a later edit and a later rate leave the versions as they were');
  // …and the database refuses rewriting a snapshot once taken (0182).
  assert.throws(() => raw.exec(`UPDATE purchase_orders SET fx_usd_iqd_version_at_purchase = 3 WHERE id = '${res.id}'`), /PURCHASE_FROZEN/);
});

test('deploy ahead of 0182: on a 0181 database the snapshot is the FX-1 statement, values only', async () => {
  const raw = dbThrough('0181');
  const { app } = setup(raw);
  applyRate(raw, 'USD_IQD', '1660');
  const res = await json(await post(app, '/p/documents', bodyOf('ordered')));
  assert.equal(hasColumn(raw, 'purchase_orders', 'fx_usd_iqd_version_at_purchase'), false);
  assert.equal(snapshot(raw, res.id).u, '1660');
});
