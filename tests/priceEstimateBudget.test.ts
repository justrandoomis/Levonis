/**
 * THE INVOCATION BUDGET OF AN ESTIMATE CALL (docs/SMART_PRICING.md §4.8; D1: 1,000 statements per Worker
 * invocation, a batch counting each of its statements; WP6).
 *
 * `countingD1` counts every read and batch of an apply (and a compute); the call stops before 900 statements
 * (1,000 minus a reserve of 100 for the door's reads, the completeness hook and the purge). A product whose
 * reads plus batch would cross the line is NOT attempted: it comes back in `cursor` (apply) or `deferred`
 * (compute), to send again — and then it lands.
 *
 *   - five products in one apply: all applied, spent ≤ 900, and the whole request — the door and the hook
 *     included — under D1's 1,000;
 *   - the same five under a line one statement short of what they took: the last ones come back in the
 *     cursor, in order and untouched, the others applied, nothing over the line; posting the cursor applies
 *     them;
 *   - the same for a compute page.
 *
 * Run: node --import tsx --test tests/priceEstimateBudget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminPriceEstimatesRoutes } from '../worker/routes/adminPriceEstimates';
import { applyEstimates, parseApplyItems } from '../worker/lib/pricingEngine/estimate/apply';
import { computeEstimates } from '../worker/lib/pricingEngine/estimate/compute';
import { ESTIMATE_INVOCATION_LIMIT, ESTIMATE_RESERVE } from '../worker/lib/pricingEngine/estimate/types';
import { countingD1 } from '../worker/lib/catalogImport/budget';
import { D1_INVOCATION_STATEMENT_LIMIT } from '../worker/lib/quarterHourBudget';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const BASE = '/api/admin/pricing/estimates';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const IDS = ['p_b1', 'p_b2', 'p_b3', 'p_b4', 'p_b5'];

/** Five PLA products the import created, each two colours priced from a confirmed Tmall offer. */
function world(): DatabaseSync {
  const { raw } = pricingWorld();
  raw.exec(`
    UPDATE price_estimate_types SET default_weight_g = 1300, default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, min_profit_usd = '2' WHERE key = 'filament';
    UPDATE price_estimate_control SET apply_enabled = 1;
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
      VALUES ('sps_tmall', 'tmall_cn', 'CNY', 'browser_sweep', '${TODAY}', '${'a'.repeat(64)}', 'complete', 'usr_owner', '${NOW}', '${NOW}');
  `);
  IDS.forEach((id, n) => {
    const item = `10531097775${20 + n}`;
    raw.exec(`
      INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
        VALUES ('${id}', 'slug-${id}', 'PLA ${n}', 'منتج', 'بەرهەم', 'active', 0, NULL, 'direct_sale', '["direct_sale"]', '[]', 'COLOR');
      INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock) VALUES
        ('${id}_red', '${id}', 'Red', 'أحمر', 'سوور', '#ff0000', 0, 1, NULL), ('${id}_black', '${id}', 'Black', 'أسود', 'ڕەش', '#000000', 1, 1, NULL);
      INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
        VALUES ('bambu_us', 'sp_${id}', '${id}', 'h-${id}', 'https://us.store.bambulab.com/products/h-${id}', 'created', 'not_configured', 'fp', '2026-10-15T00:00:00.000Z', 'cir_000000000000000000000001');
      INSERT INTO supplier_price_items (snapshot_id, item_key, title, category) VALUES ('sps_tmall', '${item}', 'PLA', 'filament');
      INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_tmall', '${item}', '${item}1', '69'), ('sps_tmall', '${item}', '${item}2', '69');
      INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, decided_by, decided_at, found_in_snapshot, updated_at) VALUES
        ('${id}', 'c:${id}_red', 'tmall_cn', '${item}', '${item}1', 'exact', 'owner', 'confirmed', 'usr_owner', '${NOW}', 'sps_tmall', '${NOW}'),
        ('${id}', 'c:${id}_black', 'tmall_cn', '${item}', '${item}2', 'exact', 'owner', 'confirmed', 'usr_owner', '${NOW}', 'sps_tmall', '${NOW}');
    `);
  });
  return raw;
}

/** The real routes on a counted binding (the door counted too), and the library behind a test seam with a chosen line. */
function apps(raw: DatabaseSync) {
  const { db, counter } = countingD1(asD1(raw));
  const real = stubApp(
    db,
    OWNER,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route(BASE, adminPriceEstimatesRoutes);
    },
    { publishV2: false }
  );
  const seam = stubApp(
    asD1(raw),
    OWNER,
    (a) => {
      a.post('/t/apply', async (c) => {
        const body = (await c.req.json()) as Json;
        const limit = Number(c.req.query('limit'));
        return c.json(await applyEstimates(c, parseApplyItems(body.items), { limit }));
      });
      a.post('/t/compute', async (c) => {
        const user = c.get('user')!;
        const body = (await c.req.json()) as Json;
        const limit = Number(c.req.query('limit'));
        return c.json(await computeEstimates(c.env.DB, body, { env: c.env, user, actor: user.id, now: new Date() }, { limit }));
      });
    },
    { publishV2: false }
  );
  return { real, seam, counter };
}

async function previews(app: ReturnType<typeof apps>['real']): Promise<Json[]> {
  const res = await post(app, `${BASE}/compute`, { product_ids: IDS });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  return (body.products as Json[]).map((p) => ({ product_id: p.product_id, preview_hash: p.preview_hash }));
}

const labelled = (raw: DatabaseSync, id: string) => row<{ l: number }>(raw, 'SELECT price_estimate AS l FROM products WHERE id = ?', id)!.l;

test('five products in one apply: all applied, at most 900 statements, the whole request under D1’s 1,000', async () => {
  assert.equal(ESTIMATE_INVOCATION_LIMIT, D1_INVOCATION_STATEMENT_LIMIT - ESTIMATE_RESERVE);
  assert.equal(ESTIMATE_INVOCATION_LIMIT, 900);
  const raw = world();
  const { real, counter } = apps(raw);
  const items = await previews(real);
  const before = counter.count;
  const res = await post(real, `${BASE}/apply`, { items });
  const body = await json(res);
  const request = counter.count - before;
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.deepEqual((body.results as Json[]).map((r) => r.outcome), ['applied', 'applied', 'applied', 'applied', 'applied']);
  assert.equal(body.cursor, null);
  assert.ok(body.spent <= ESTIMATE_INVOCATION_LIMIT, `spent ${body.spent}`);
  assert.ok(request < D1_INVOCATION_STATEMENT_LIMIT, `the request with its door and hook spent ${request}`);
  for (const id of IDS) assert.equal(labelled(raw, id), 1);
});

test('one statement short of what five products take: the last come back in the cursor, nothing crosses the line; the cursor then applies them', async () => {
  const measured = await (async () => {
    const raw = world();
    const { real, seam } = apps(raw);
    const items = await previews(real);
    return (await json(await post(seam, `/t/apply?limit=${ESTIMATE_INVOCATION_LIMIT}`, { items }))).spent as number;
  })();
  const raw = world();
  const { real, seam } = apps(raw);
  const items = await previews(real);
  const limit = measured - 1;
  const body = await json(await post(seam, `/t/apply?limit=${limit}`, { items }));
  const applied = (body.results as Json[]).filter((r) => r.outcome === 'applied').map((r) => r.product_id as string);
  assert.ok(applied.length >= 1 && applied.length < IDS.length, `some applied (${applied.join(', ')})`);
  assert.deepEqual(applied, IDS.slice(0, applied.length), 'in order');
  assert.ok(body.spent <= limit, `spent ${body.spent} ≤ ${limit}`);
  assert.deepEqual((body.cursor as Json[]).map((i) => i.product_id), IDS.slice(applied.length), 'the rest, in order, never attempted');
  for (const id of IDS.slice(applied.length)) assert.equal(labelled(raw, id), 0, `${id} untouched`);
  // Posting the cursor (the real route takes it as is) applies the rest.
  const rest = await json(await post(real, `${BASE}/apply`, { cursor: body.cursor }));
  assert.deepEqual((rest.results as Json[]).map((r) => r.outcome), IDS.slice(applied.length).map(() => 'applied'));
  assert.equal(rest.cursor, null);
  for (const id of IDS) assert.equal(labelled(raw, id), 1);
});

test('a compute page under the same line: the last product is deferred, nothing crosses it', async () => {
  const raw = world();
  const { seam } = apps(raw);
  const cx = (limit: number) => post(seam, `/t/compute?limit=${limit}`, { product_ids: IDS });
  const full = await json(await cx(ESTIMATE_INVOCATION_LIMIT));
  assert.deepEqual(full.deferred, []);
  assert.ok(full.spent <= ESTIMATE_INVOCATION_LIMIT);
  const short = await json(await cx(full.spent - 1));
  assert.ok(short.spent <= full.spent - 1, `spent ${short.spent}`);
  assert.ok(short.deferred.includes('p_b5'), JSON.stringify(short.deferred));
  assert.deepEqual([...short.products.map((p: Json) => p.product_id), ...short.deferred], IDS, 'every product answered or deferred, in order');
});
