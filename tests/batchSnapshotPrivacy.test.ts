/**
 * A BATCH'S PURCHASE SNAPSHOT IS THE OWNER'S ALONE (FX programme plan §4.3
 * "The lot list route becomes an explicit column list", §4.5, §14.2 S1;
 * critique F14a; push FX-6).
 *
 * The lot reads open to assistant admins select the pre-0182 columns by
 * name, so no snapshot column — a private rate, or a merely generic
 * `snapshot_source` / `purchase_id` — can reach them through `SELECT l.*`;
 * the owner reads the snapshot on GET /api/admin/pricing/batches, which every
 * other caller is refused with the same bytes for a real lot and an invented
 * one; and every snapshot name that carries a figure is in FINANCIAL_FIELDS.
 *
 * Run: node --import tsx --test tests/batchSnapshotPrivacy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, stubApp } from './fixtures/app';
import { OWNER, ROLES, call, seededCopy } from './fixtures/roleMatrix';
import { BATCH_SENTINELS, BATCH_SENTINEL_LOT, seedBatchSentinels } from './fixtures/fxSentinels';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { LOT_SNAPSHOT_ALL_COLUMNS, PRE_SNAPSHOT_LOT_COLUMNS } from '../worker/lib/batchSnapshot';
import type { StubUser } from './fixtures/app';

const NET = new Set<string>(FINANCIAL_FIELDS as readonly string[]);

function world(user: StubUser | null) {
  const raw = seededCopy();
  seedBatchSentinels(raw);
  const app = stubApp(asD1(raw), user, (a) => {
    a.route('/api/admin/inventory', adminInventoryRoutes);
    a.route('/api/admin/stock-operations', adminStockOperationsRoutes);
    a.route('/api/admin/investment-finance', adminInvestmentFinanceRoutes);
    a.route('/api/admin/pricing', adminPricingRoutes);
  });
  return { raw, app };
}

const keysOf = (rows: Array<Record<string, unknown>>) => [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
const ROUTE_EXTRAS = ['consumed', 'supplier_name'];

test('assistant lot list has exactly the pre-FX-6 key set (less the cost the strip removes) — no snapshot column, private or generic', async () => {
  const { app } = world(ROLES.assistant);
  const res = await call(app, 'GET', '/api/admin/inventory/lots?product_id=p_a1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const lots = (res.body as { lots: Array<Record<string, unknown>> }).lots;
  assert.ok(lots.some((l) => l.id === BATCH_SENTINEL_LOT), 'the sentinel batch is listed');
  const expected = [...PRE_SNAPSHOT_LOT_COLUMNS, ...ROUTE_EXTRAS].filter((k) => !NET.has(k)).sort();
  assert.deepEqual(keysOf(lots), expected);
  const text = JSON.stringify(res.body);
  for (const s of BATCH_SENTINELS) assert.equal(text.includes(s), false, s);
});

test('the owner\'s lot list is the same column list, cost included — the snapshot lives on /pricing/batches only', async () => {
  const { app } = world(OWNER);
  const res = await call(app, 'GET', '/api/admin/inventory/lots?product_id=p_a1');
  assert.equal(res.status, 200);
  const lots = (res.body as { lots: Array<Record<string, unknown>> }).lots;
  assert.deepEqual(keysOf(lots), [...PRE_SNAPSHOT_LOT_COLUMNS, ...ROUTE_EXTRAS].sort());
  for (const k of LOT_SNAPSHOT_ALL_COLUMNS) assert.equal(keysOf(lots).includes(k), false, k);
});

test('a lot scan answers the pre-0182 columns to whoever receives; the investment lot list keeps its explicit non-owner shape', async () => {
  const { app } = world(ROLES.assistant);
  const scan = await call(app, 'POST', '/api/admin/stock-operations/scan', { code: BATCH_SENTINEL_LOT });
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  const lot = (scan.body as { lot: Record<string, unknown> }).lot;
  for (const k of LOT_SNAPSHOT_ALL_COLUMNS) assert.equal(k in lot, false, `scan carries ${k}`);
  for (const s of BATCH_SENTINELS) assert.equal(JSON.stringify(scan.body).includes(s), false, s);
  const inv = await call(app, 'GET', '/api/admin/investment-finance/lots');
  if (inv.status === 200) {
    const lots = (inv.body as { lots: Array<Record<string, unknown>> }).lots;
    for (const k of LOT_SNAPSHOT_ALL_COLUMNS) assert.equal(keysOf(lots).includes(k), false, `investment lots carry ${k}`);
    for (const s of BATCH_SENTINELS) assert.equal(JSON.stringify(inv.body).includes(s), false, s);
  }
});

test('non-owner sees nothing: GET /pricing/batches refuses every other caller with the same bytes for a real batch and an invented one', async () => {
  for (const [role, user] of Object.entries(ROLES)) {
    const { app } = world(user);
    const real = await call(app, 'GET', `/api/admin/pricing/batches?lot_id=${BATCH_SENTINEL_LOT}`);
    const fake = await call(app, 'GET', '/api/admin/pricing/batches?lot_id=zz-no-such-lot');
    assert.ok(real.status === 401 || real.status === 403, `${role}: ${real.status}`);
    assert.equal(fake.status, real.status, role);
    assert.deepEqual(fake.body, real.body, `${role}: the refusal tells a real batch from an invented one`);
    for (const s of BATCH_SENTINELS) assert.equal(JSON.stringify(real.body).includes(s), false, `${role}: ${s}`);
    assert.match(real.headers.get('cache-control') ?? '', /no-store/, role);
  }
});

test('the owner reads every snapshot figure, privately, and nothing is written', async () => {
  const { raw, app } = world(OWNER);
  const before = JSON.stringify(raw.prepare('SELECT * FROM inventory_lots ORDER BY id').all());
  const res = await call(app, 'GET', `/api/admin/pricing/batches?lot_id=${BATCH_SENTINEL_LOT}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.headers.get('cache-control') ?? '', /private/);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const text = JSON.stringify(res.body);
  for (const s of BATCH_SENTINELS) assert.ok(text.includes(s), `the owner sees ${s}`);
  assert.equal(JSON.stringify(raw.prepare('SELECT * FROM inventory_lots ORDER BY id').all()), before);
  for (const q of ['', 'lot_id=a&product_id=b', 'lot_id=' + 'x'.repeat(61), "lot_id=a'b"]) {
    const bad = await call(app, 'GET', `/api/admin/pricing/batches?${q}`);
    assert.equal(bad.status, 400, q);
    assert.equal((bad.body as { code?: string }).code, 'BATCH_FILTER_REQUIRED', q);
  }
});

test('every snapshot column that carries a figure, a rate, a version or its source is in FINANCIAL_FIELDS; the generic ones are kept out by the column lists', () => {
  const figures = [
    'supplier_original_currency', 'supplier_original_amount', 'supplier_cost_mode', 'supplier_line_total_original',
    'exchange_rate_at_purchase', 'supplier_cost_usd_at_purchase', 'usd_iqd_rate_at_purchase', 'eur_usd_rate_at_purchase',
    'cny_usd_rate_at_purchase', 'usd_iqd_fx_version', 'eur_usd_fx_version', 'cny_usd_fx_version', 'fx_snapshot_at',
    'fx_snapshot_source', 'historical_usd_equivalent', 'fx_usd_iqd_version_at_purchase', 'fx_eur_usd_version_at_purchase',
    'fx_cny_usd_version_at_purchase', 'actual_landed_cost_iqd', 'actual_landed_total_iqd',
  ];
  assert.deepEqual(figures.filter((k) => !NET.has(k)), []);
  const generic = ['snapshot_version', 'snapshot_source', 'purchase_id', 'calculated_at', 'split_from_lot_id'];
  assert.deepEqual(generic.filter((k) => NET.has(k)), [], 'generic names stay out of the net (purchase_id is investor vocabulary)');
  assert.deepEqual([...LOT_SNAPSHOT_ALL_COLUMNS].filter((k) => !figures.includes(k) && !generic.includes(k)), [], 'every 0182 lot column is classified here');
});
