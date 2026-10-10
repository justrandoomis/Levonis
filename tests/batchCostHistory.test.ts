/**
 * A BATCH'S COST IS FIXED IN DINARS, AND IT REMEMBERS THE RATES IT WAS BOUGHT
 * AT (FX programme plan §4.3, §9 §16-§19, §15.1 rows 10-13; push FX-6,
 * migration 0182).
 *
 *   - §17: a purchase received after 0182 writes, in each lot's own INSERT,
 *     the supplier's currency and amount, the document's rate, U / E / C in
 *     force when the purchase was confirmed (with their versions and the
 *     moment), the supplier cost in USD and the historical USD equivalent —
 *     and the batch's landed IQD is unchanged by any of it;
 *   - §16: written ONCE — rates moving afterwards, a shipping-rate change, a
 *     direct UPDATE (NULL → value included), an INSERT OR REPLACE and a DELETE
 *     leave the lot byte-identical or are refused;
 *   - §18: a batch received before 0182 is never back-filled and never
 *     converted at today's rate: «بالدينار فقط», or a figure DERIVED from its
 *     own purchase document / recorded purchase rate, labelled so, not stored;
 *   - the migration itself rewrites no existing lot; a deploy ahead of 0182
 *     receives exactly as before; a transfer split carries the snapshot.
 *
 * Run: node --import tsx --test tests/batchCostHistory.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, dbThrough, freshDb, get, hasColumn, json, post, row, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { applyRate } from './fixtures/fx';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { baghdadDay } from '../worker/lib/operations';
import { LOT_SNAPSHOT_ALL_COLUMNS, iqdAtRate, supplierCostUsd, type BatchDto } from '../worker/lib/batchSnapshot';

const OWNER = { id: 'admin', email: 'boss@x.co', role: 'admin' as const };

function setup(raw: DatabaseSync = freshDb()) {
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('admin','boss@x.co','admin');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode)
      VALUES ('part','Part','batch-history-part','BHP',300000,10000,0,'BASE');
    INSERT INTO stock_locations(id,name,kind) VALUES ('w1','Main','warehouse'),('w2','Shop','warehouse');`);
  const app = stubApp(asD1(raw), OWNER, (a) => {
    a.route('/p', adminProcurementRoutes);
    a.route('/i', adminInventoryRoutes);
    a.route('/s', adminStockOperationsRoutes);
    a.route('/api/admin/pricing', adminPricingRoutes);
  });
  return { raw, app };
}

const document = (over: Record<string, unknown> = {}) => ({
  operation_id: crypto.randomUUID(),
  supplier_id: 'supplier',
  currency: 'EUR',
  exchange_rate: 1850,
  purchase_day: baghdadDay(),
  status: 'ordered',
  cost_state: 'final',
  warehouse_id: 'w1',
  lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 2, source_unit_amount: 100 }],
  charges: [],
  ...over,
});

async function orderAndReceive(app: ReturnType<typeof setup>['app'], body = document(), qty?: number) {
  const created = await post(app, '/p/documents', body);
  assert.equal(created.status, 200, JSON.stringify(await json(created.clone())));
  const id = (await json(created)).id as string;
  const detail = await json(await get(app, `/p/documents/${id}`));
  const res = await post(app, `/p/documents/${id}/receive`, {
    operation_id: crypto.randomUUID(),
    lines: detail.lines.map((l: { line_id: string; qty_ordered: number }) => ({ line_id: l.line_id, qty: qty ?? l.qty_ordered })),
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  return id;
}

const lotsOf = (raw: DatabaseSync, purchaseOrIncoming: string) =>
  all<Record<string, unknown>>(
    raw,
    `SELECT l.* FROM inventory_lots l LEFT JOIN purchase_lines pl ON pl.incoming_id = l.incoming_id
      WHERE pl.purchase_id = ? OR l.incoming_id = ? ORDER BY l.received_at, l.id`,
    purchaseOrIncoming,
    purchaseOrIncoming,
  );

const batches = async (app: ReturnType<typeof setup>['app'], q: string) => {
  const res = await get(app, `/api/admin/pricing/batches?${q}`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.batches as BatchDto[];
};

function seedRates(raw: DatabaseSync) {
  applyRate(raw, 'USD_IQD', '1660');
  applyRate(raw, 'EUR_USD', '1.1186');
  applyRate(raw, 'CNY_USD', '0.1492023689');
}

const lotHash = (raw: DatabaseSync) => JSON.stringify(all(raw, 'SELECT * FROM inventory_lots ORDER BY id'));

// ------------------------------------------------------------- §17

test('batch with historical FX snapshot: supplier_cost_usd_at_purchase and historical_usd_equivalent computed; actual_landed_cost_iqd unchanged', async () => {
  const { raw, app } = setup();
  seedRates(raw);
  const id = await orderAndReceive(app);
  const [lot] = lotsOf(raw, id);
  // The landed IQD the batch is booked at: 100 EUR × 1,850 = 185,000, no charges.
  assert.equal(lot.unit_cost_iqd, 185000);
  assert.equal(lot.total_cost_iqd, 370000);
  const purchase = row<Record<string, unknown>>(raw, 'SELECT * FROM purchase_orders WHERE id = ?', id)!;
  assert.deepEqual(
    {
      version: lot.snapshot_version, source: lot.snapshot_source, purchase: lot.purchase_id,
      currency: lot.supplier_original_currency, amount: lot.supplier_original_amount, mode: lot.supplier_cost_mode,
      doc: lot.exchange_rate_at_purchase, u: lot.usd_iqd_rate_at_purchase, e: lot.eur_usd_rate_at_purchase, c: lot.cny_usd_rate_at_purchase,
      uv: lot.usd_iqd_fx_version, ev: lot.eur_usd_fx_version, cv: lot.cny_usd_fx_version, from: lot.fx_snapshot_source,
      at: lot.fx_snapshot_at, usd: lot.supplier_cost_usd_at_purchase, equivalent: lot.historical_usd_equivalent,
    },
    {
      version: 1, source: 'purchase', purchase: id,
      currency: 'EUR', amount: '100', mode: 'unit',
      doc: '1850', u: '1660', e: '1.1186', c: '0.1492023689',
      uv: 1, ev: 1, cv: 1, from: 'central',
      at: purchase.fx_snapshot_at, usd: '111.86', equivalent: '111.445783',
    },
  );
  assert.ok(lot.calculated_at, 'when the snapshot was computed');
  // The purchase's own snapshot recorded the versions beside the values (0182).
  assert.deepEqual(
    [purchase.fx_usd_iqd_version_at_purchase, purchase.fx_eur_usd_version_at_purchase, purchase.fx_cny_usd_version_at_purchase],
    [1, 1, 1],
  );

  const [b] = await batches(app, `purchase_id=${id}`);
  assert.equal(b.snapshot_state, 'recorded');
  assert.deepEqual(b.unknown_fields, []);
  assert.deepEqual(b.batch_cost, {
    unit_cost_iqd: 185000, actual_landed_cost_iqd: 185000, actual_landed_total_iqd: 370000,
    purchase_unit_iqd: 185000, shipping_share_iqd: 0, internal_share_iqd: 0, total_cost_iqd: 370000,
  });
  assert.equal(b.snapshot!.historical_usd_equivalent, '111.445783');
  assert.equal(b.derived, null);
});

test('a USD document: the batch\'s USD/IQD is the document\'s own rate (source document, no central version)', async () => {
  const { raw, app } = setup();
  seedRates(raw);
  const id = await orderAndReceive(app, document({ currency: 'USD', exchange_rate: 1500, lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: 120.5 }] }));
  const [lot] = lotsOf(raw, id);
  assert.equal(lot.unit_cost_iqd, 180750);
  assert.equal(lot.usd_iqd_rate_at_purchase, '1500');
  assert.equal(lot.fx_snapshot_source, 'document');
  assert.equal(lot.usd_iqd_fx_version, null, 'the document\'s own rate has no central version');
  assert.equal(lot.supplier_cost_usd_at_purchase, '120.5');
  assert.equal(lot.historical_usd_equivalent, '120.5');
  assert.equal(lot.eur_usd_rate_at_purchase, '1.1186', 'the central E and C of the purchase still ride along');
});

test('an IQD document: the supplier cost in USD is its dinar price ÷ U, floored to six places', async () => {
  const { raw, app } = setup();
  seedRates(raw);
  const id = await orderAndReceive(app, document({ currency: 'IQD', exchange_rate: undefined, lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 3, source_unit_amount: 100000 }] }));
  const [lot] = lotsOf(raw, id);
  assert.equal(lot.supplier_original_currency, 'IQD');
  assert.equal(lot.exchange_rate_at_purchase, '1');
  assert.equal(lot.supplier_cost_usd_at_purchase, '60.240963', '100,000 ÷ 1,660 = 60.2409638… → floor6');
  assert.equal(lot.fx_snapshot_source, 'central');
  // The pure rules agree with what was stored.
  assert.equal(supplierCostUsd('IQD', '100000', 100000, '1660', null, null), '60.240963');
  assert.equal(supplierCostUsd('CNY', '700', null, '1660', null, '0.1492023689'), '104.44165823');
  assert.equal(supplierCostUsd('EUR', '100', null, null, null, null), null, 'a rate it needs is unknown → unknown');
  assert.equal(iqdAtRate(185000, '1660'), '111.445783');
  assert.equal(iqdAtRate(null, '1660'), null);
});

// ------------------------------------------------------------- §16

test('batch cost never changes: rates moving, a shipping-rate change and a later receipt leave the lot byte-identical; a direct UPDATE (NULL → value too), an INSERT OR REPLACE and a DELETE are refused', async () => {
  const { raw, app } = setup();
  seedRates(raw);
  const id = await orderAndReceive(app, document(), 1);
  const before = lotHash(raw);
  // FX apply and a central shipping rate change after the receipt.
  applyRate(raw, 'USD_IQD', '1720', '2026-10-05T00:00:00.000Z');
  applyRate(raw, 'EUR_USD', '1.2', '2026-10-05T00:00:00.000Z');
  raw.exec("UPDATE pricing_shipping_rates SET rate_iqd = '15000' WHERE profile = 'GERMANY_LAND'");
  assert.equal(lotHash(raw), before, 'no rate path touches a lot');
  // The second receipt takes the purchase's snapshot again, never today's rates.
  const detail = await json(await get(app, `/p/documents/${id}`));
  const res = await post(app, `/p/documents/${id}/receive`, { operation_id: crypto.randomUUID(), lines: [{ line_id: detail.lines[0].line_id, qty: 1 }] });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const lots = lotsOf(raw, id);
  assert.equal(lots.length, 2);
  assert.deepEqual(lots.map((l) => [l.usd_iqd_rate_at_purchase, l.eur_usd_rate_at_purchase]), [['1660', '1.1186'], ['1660', '1.1186']]);
  const lotId = String(lots[0].id);
  const refused = (sql: string, code: RegExp) => assert.throws(() => raw.exec(sql), code, sql);
  for (const set of [
    "usd_iqd_rate_at_purchase = '1720'",
    "historical_usd_equivalent = '1'",
    'usd_iqd_fx_version = 2',
    "fx_snapshot_source = 'document'",
    "supplier_original_amount = '99'",
    "calculated_at = '2030-01-01T00:00:00.000Z'",
    "split_from_lot_id = 'x'",
    'snapshot_version = NULL',
  ]) refused(`UPDATE inventory_lots SET ${set} WHERE id = '${lotId}'`, /BATCH_COST_IMMUTABLE/);
  refused(`UPDATE inventory_lots SET unit_cost_iqd = 1 WHERE id = '${lotId}'`, /BATCH_COST_IMMUTABLE/);
  refused(`DELETE FROM inventory_lots WHERE id = '${lotId}'`, /BATCH_COST_IMMUTABLE/);
  refused(`INSERT OR REPLACE INTO inventory_lots SELECT * FROM inventory_lots WHERE id = '${lotId}'`, /BATCH_COST_IMMUTABLE/);
  // The live write stays open: FIFO consumption moves qty_remaining only.
  raw.exec(`UPDATE inventory_lots SET qty_remaining = qty_remaining - 1 WHERE id = '${lotId}'`);
  // The purchase's own FX snapshot is frozen once taken.
  refused(`UPDATE purchase_orders SET fx_usd_iqd_at_purchase = '1720' WHERE id = '${id}'`, /PURCHASE_FROZEN/);
  refused(`UPDATE purchase_orders SET fx_usd_iqd_version_at_purchase = 9 WHERE id = '${id}'`, /PURCHASE_FROZEN/);
});

test('an old lot can never be back-filled: NULL → value on any snapshot column is refused', () => {
  const { raw } = setup();
  raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at)
    VALUES ('old','part','base','',2,2,500000,500000,0,0,1000000,'received','2026-01-01T00:00:00.000Z')`);
  assert.throws(() => raw.exec("UPDATE inventory_lots SET usd_iqd_rate_at_purchase = '1660', fx_snapshot_source = 'central' WHERE id = 'old'"), /BATCH_COST_IMMUTABLE/);
  assert.throws(() => raw.exec("UPDATE inventory_lots SET snapshot_version = 1, snapshot_source = 'purchase' WHERE id = 'old'"), /BATCH_COST_IMMUTABLE/);
  // …and a snapshot written half (a writer's mistake) is refused at INSERT.
  assert.throws(
    () => raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at,usd_iqd_rate_at_purchase)
      VALUES ('half','part','base','',1,1,1,'received','2026-01-01T00:00:00.000Z','1660')`),
    /BATCH_SNAPSHOT_SHAPE/,
  );
});

// ------------------------------------------------------------- §18

test('historical batch in IQD: every FX field UNKNOWN; the read model never uses today\'s U', async () => {
  const { raw, app } = setup();
  raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at)
    VALUES ('opening1','part','base','',3,3,400000,400000,0,0,1200000,'opening','2026-01-01T00:00:00.000Z')`);
  seedRates(raw); // today's U is 1,660 — and must not appear
  const [b] = await batches(app, 'lot_id=opening1');
  assert.equal(b.snapshot_state, 'iqd_only');
  assert.equal(b.snapshot, null);
  assert.equal(b.derived, null);
  assert.deepEqual(b.unknown_fields, ['supplier_cost_usd_at_purchase', 'usd_iqd_rate_at_purchase', 'eur_usd_rate_at_purchase', 'cny_usd_rate_at_purchase', 'historical_usd_equivalent']);
  assert.equal(b.batch_cost.unit_cost_iqd, 400000);
  assert.doesNotMatch(JSON.stringify(b), /1660|240\.963855/, 'today\'s rate is nowhere in a historical batch');
});

test('batch without FX snapshot: historical_usd_equivalent UNKNOWN (a purchase confirmed before any rate was approved)', async () => {
  const { raw, app } = setup();
  const id = await orderAndReceive(app, document({ currency: 'IQD', exchange_rate: undefined }));
  seedRates(raw); // approved only after the purchase: never back-dated onto it
  const [lot] = lotsOf(raw, id);
  assert.equal(lot.snapshot_version, 1);
  assert.equal(lot.usd_iqd_rate_at_purchase, null);
  assert.equal(lot.historical_usd_equivalent, null);
  const [b] = await batches(app, `purchase_id=${id}`);
  assert.equal(b.snapshot_state, 'recorded');
  assert.ok(b.unknown_fields.includes('historical_usd_equivalent'));
  assert.ok(b.unknown_fields.includes('usd_iqd_rate_at_purchase'));
  assert.equal(b.snapshot!.supplier_original_currency, 'IQD');
});

function oldLotOf(raw: DatabaseSync, purchase: { id: string; currency: string; rate: number; fx?: string | null }) {
  raw.exec(`INSERT INTO purchase_orders(id,supplier_id,currency,exchange_rate,purchase_day,status,cost_state,created_by,created_at,updated_at,fx_usd_iqd_at_purchase,fx_snapshot_at)
      VALUES ('${purchase.id}','supplier','${purchase.currency}',${purchase.rate},'2026-09-01','received','final','admin','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',${purchase.fx ? `'${purchase.fx}'` : 'NULL'},${purchase.fx ? "'2026-09-01T00:00:00.000Z'" : 'NULL'});
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,source_currency,source_unit_amount,exchange_rate_used,status)
      VALUES ('inc_${purchase.id}','part','base','',1,1,300000,0,0,'${purchase.currency}',200,${purchase.rate},'received');
    INSERT INTO purchase_lines(id,purchase_id,incoming_id,label,source_unit_amount) VALUES ('pl_${purchase.id}','${purchase.id}','inc_${purchase.id}','Part',200);
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,incoming_id,received_at)
      VALUES ('lot_${purchase.id}','part','base','',1,1,300000,300000,0,0,300000,'received','inc_${purchase.id}','2026-09-02T00:00:00.000Z');`);
  return `lot_${purchase.id}`;
}

test('an old USD-document lot shows a derived equivalent labelled derived, not stored', async () => {
  const { raw, app } = setup();
  const lotId = oldLotOf(raw, { id: 'po_usd_old', currency: 'USD', rate: 1500 });
  seedRates(raw);
  const before = lotHash(raw);
  const [b] = await batches(app, `lot_id=${lotId}`);
  assert.equal(b.snapshot_state, 'derived');
  assert.equal(b.snapshot, null, 'nothing is stored on the lot');
  assert.deepEqual(b.derived, { usd_iqd_rate: '1500', historical_usd_equivalent: '200', derived_from: 'purchase_document' });
  assert.deepEqual(b.unknown_fields, ['supplier_cost_usd_at_purchase', 'eur_usd_rate_at_purchase', 'cny_usd_rate_at_purchase']);
  assert.equal(b.purchase_id, 'po_usd_old');
  assert.equal(lotHash(raw), before, 'a read writes nothing');
  assert.equal(row(raw, "SELECT usd_iqd_rate_at_purchase u FROM inventory_lots WHERE id = ?", lotId)!.u, null);
});

test('a lot received between FX-1 and FX-6 shows a derived historical equivalent from its purchase document (critique L10)', async () => {
  const { raw, app } = setup();
  const lotId = oldLotOf(raw, { id: 'po_eur_fx1', currency: 'EUR', rate: 1800, fx: '1600' });
  seedRates(raw);
  const [b] = await batches(app, `lot_id=${lotId}`);
  assert.equal(b.snapshot_state, 'derived');
  assert.deepEqual(b.derived, { usd_iqd_rate: '1600', historical_usd_equivalent: '187.5', derived_from: 'purchase_snapshot' });
  // And one with neither a USD document nor a purchase-time rate: known only in IQD.
  const plain = oldLotOf(raw, { id: 'po_eur_old', currency: 'EUR', rate: 1800 });
  const [p] = await batches(app, `lot_id=${plain}`);
  assert.equal(p.snapshot_state, 'iqd_only');
  assert.equal(p.derived, null);
});

// ------------------------------------------------------------- the migration, deploy-ahead, the other writers

test('0182 rewrites no existing lot: every old column byte-identical, every new column NULL', () => {
  const raw = dbThrough('0181');
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('admin','boss@x.co','admin');
    INSERT INTO products(id,name,slug,sku,price_iqd,stock,inventory_mode) VALUES ('part','Part','m-part','MP',1000,2,'BASE');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at)
      VALUES ('a','part','base','',2,1,700,600,100,0,1400,'received','2026-01-01T00:00:00.000Z'),('b','part','base','',1,1,NULL,NULL,0,0,NULL,'opening_unpriced','2026-01-02T00:00:00.000Z');`);
  const before = all(raw, 'SELECT * FROM inventory_lots ORDER BY id');
  raw.exec(readFileSync(join(ROOT, 'migrations/0182_batch_fx_snapshots.sql'), 'utf8'));
  const after = all<Record<string, unknown>>(raw, 'SELECT * FROM inventory_lots ORDER BY id');
  for (const [i, lot] of after.entries()) {
    for (const [k, v] of Object.entries(before[i])) assert.equal(lot[k], v, `${lot.id}.${k}`);
    for (const k of LOT_SNAPSHOT_ALL_COLUMNS) assert.equal(lot[k], null, `${lot.id}.${k}`);
  }
});

test('deploy ahead of 0182: a purchase receipt on a 0181 database writes the lot exactly as before', async () => {
  const raw = dbThrough('0181');
  const { app } = setup(raw);
  seedRates(raw);
  const id = await orderAndReceive(app);
  assert.equal(hasColumn(raw, 'inventory_lots', 'snapshot_version'), false);
  assert.equal(lotsOf(raw, id)[0].unit_cost_iqd, 185000);
  const [b] = await batches(app, `product_id=part`);
  assert.equal(b.snapshot, null);
  assert.equal(b.snapshot_state, 'iqd_only', 'without 0182 nothing is recorded, and nothing is derived from today');
});

test('a bare incoming record\'s receipt records its own currency and rate (legacy_incoming)', async () => {
  const { raw, app } = setup();
  seedRates(raw);
  raw.exec(`INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,source_currency,source_unit_amount,exchange_rate_used,status)
    VALUES ('incUSD','part','base','',2,150000,0,0,'USD',100,1500,'incoming')`);
  const res = await post(app, '/i/incoming/incUSD/receive', { receipt_id: 'rcpt-usd', qty: 2 });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const [lot] = lotsOf(raw, 'incUSD');
  assert.deepEqual(
    [lot.snapshot_source, lot.purchase_id, lot.supplier_original_currency, lot.supplier_original_amount, lot.usd_iqd_rate_at_purchase, lot.fx_snapshot_source, lot.historical_usd_equivalent, lot.eur_usd_rate_at_purchase],
    ['legacy_incoming', null, 'USD', '100', '1500', 'document', '100', null],
  );
});

test('a transfer split\'s child copies its batch\'s snapshot and names its parent', async () => {
  const { raw, app } = setup();
  seedRates(raw);
  const id = await orderAndReceive(app);
  const [parent] = lotsOf(raw, id);
  const res = await post(app, '/s/transfers', { operation_id: crypto.randomUUID(), lot_id: parent.id, location_id: 'w2', qty: 1 });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const child = row<Record<string, unknown>>(raw, 'SELECT * FROM inventory_lots WHERE split_from_lot_id = ?', parent.id)!;
  assert.ok(child, 'the split wrote a child');
  for (const k of LOT_SNAPSHOT_ALL_COLUMNS.filter((c) => c !== 'split_from_lot_id')) assert.equal(child[k], parent[k], k);
  assert.equal(child.unit_cost_iqd, parent.unit_cost_iqd);
  const kids = (await batches(app, `lot_id=${child.id}`))[0];
  assert.equal(kids.snapshot!.split_from_lot_id, parent.id);
  assert.equal(kids.snapshot!.usd_iqd_rate_at_purchase, '1660');
});
