/**
 * NO PRICE, COST, STOCK OR PROMOTION FROM THE SOURCE — THREE LAYERS (Bambu
 * import spec §C.10).
 *
 *   1. The validator: every FINANCIAL_FIELDS key and every key of source-analysis
 *      §3.3 / §3.9, injected at every depth of a valid payload, is refused by
 *      `assertImportPayload` — and the writer, which runs it first, writes nothing.
 *   2. The writer: with the validator bypassed (the test-only seam), the same
 *      payloads write a product at its defaults — the writer builds the document
 *      from defaults and never forwards an unknown key.
 *   3. The database: with the validator bypassed AND a statement that forwards
 *      the injected value spliced into the batch (what a writer bug would do),
 *      the 0195 guard triggers abort the whole batch with
 *      IMPORT_FINANCIAL_WRITE_REFUSED and zero rows are written — for every
 *      guarded money, stock and package column, the stock decision, and every
 *      protected table.
 *   End state: price 0, every other money column and stock and package NULL,
 *   stock_decision 'not_configured', no pricing / inventory / price-history row,
 *   and catalog-only's own predicate reads the product as catalog_only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFor, count, newWorld, plan, setWriting, stage, write, type World } from './fixtures/catalogImportWorld';
import { assertImportPayload, ImportPayloadRefused, type ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { GUARDED_ROW_TABLES, PROTECTED_TABLES } from '../worker/lib/catalogImport/protectedTables';
import { ImportWriteRefused, runImportWrite } from '../worker/lib/catalogImport/writer';
import { listing } from '../worker/lib/listing';

/** source-analysis §3.3 "Do not import" and §3.9: the store's money, stock and promotion keys. */
const SOURCE_KEYS = [
  'price', 'salePrice', 'originalPrice', 'discountPrice', 'priceRange', 'discount', 'discountRate', 'discountAmount', 'trackingQuantity',
  'availableStock', 'stock', 'quantityLimit', 'quantityLimitNum', 'points', 'pointsDeduction', 'flashSale', 'flashSalePrice', 'preSale',
  'buyAndGet', 'isSoldOut', 'outOfStockMsg', 'eta', 'requiresNotify', 'saleTime', 'currency', 'amount', 'coupon', 'msrp',
];
const FUZZ_KEYS = [...new Set([...FINANCIAL_FIELDS, ...SOURCE_KEYS])];

/** One object per depth of the payload: the first object at each distinct path shape (list indices collapsed). */
function depths(payload: ImportPayload): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, path: string[], shape: string) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, String(i)], `${shape}[]`));
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (!seen.has(shape)) {
      seen.add(shape);
      out.push(path);
    }
    for (const [k, x] of Object.entries(v)) walk(x, [...path, k], `${shape}.${k}`);
  };
  walk(payload, [], '$');
  return out;
}

function inject(payload: ImportPayload, path: string[], key: string, value: unknown): ImportPayload {
  const copy = structuredClone(payload) as unknown as Record<string, unknown>;
  let at: Record<string, unknown> = copy;
  for (const p of path) at = at[p] as Record<string, unknown>;
  at[key] = value;
  return copy as unknown as ImportPayload;
}

let base: { world: World; staged: ReturnType<typeof stage> } | null = null;
function world() {
  if (!base) {
    const w = newWorld();
    base = { world: w, staged: stage(w, 'ams-2-pro-feeder-unit') };
  }
  return base;
}

test('layer 1 — the validator refuses every financial and source key at every depth', () => {
  // The A1: every kind of object a payload holds (in-the-box items, checked sources, relations, swatch-less groups …).
  const payload = buildFor({ queue: 0 }, 'a1').payload;
  assert.doesNotThrow(() => assertImportPayload(payload));
  const at = depths(payload);
  assert.ok(at.length >= 12, `a payload with ${at.length} object depths`);
  assert.ok(at.some((p) => p.includes('value_list')) && at.some((p) => p.includes('checked_sources')), 'nested spec objects are reached');
  let tried = 0;
  for (const path of at) {
    for (const key of FUZZ_KEYS) {
      tried++;
      assert.throws(
        () => assertImportPayload(inject(payload, path, key, 990000)),
        (e: unknown) => e instanceof ImportPayloadRefused && e.code === 'IMPORT_PAYLOAD_KEY_REFUSED' && e.path.endsWith(`.${key}`) && (e.reason === 'forbidden_key' || e.reason === 'unknown_key'),
        `${['$', ...path].join('.')}.${key}`
      );
    }
  }
  assert.ok(tried > 1000);
});

test('layer 1 — the writer runs the validator first: a refused payload writes nothing', async () => {
  const { world: w, staged } = world();
  for (const [path, key] of [[[], 'price'], [['product'], 'stock'], [['groups', '0', 'values', '0'], 'cost_iqd'], [['variants', '0'], 'availableStock'], [['specs', '0'], 'discount']] as Array<[string[], string]>) {
    await assert.rejects(() => plan(w, staged, { payload: inject(staged.payload, path, key, 1) }), (e: unknown) => e instanceof ImportPayloadRefused);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM products'), 0);
});

/** Statements that forward an injected value into each guarded column or protected table. */
function forwarders(productId: string): Array<{ what: string; sql: string; args: unknown[] }> {
  const out: Array<{ what: string; sql: string; args: unknown[] }> = [];
  for (const t of GUARDED_ROW_TABLES) {
    if (t.table === 'product_colors') continue; // a create has no colour row to move
    const where = t.table === 'products' ? 'id = ?' : 'product_id = ?';
    for (const c of [...t.money, ...t.stock, ...t.package]) {
      const value = c.insertDefault === 'empty_object' ? '{"prime":1}' : c.insertDefault === 'empty_array' ? '[{"fee_iqd":50000,"method":"air","commission_iqd":1}]' : 990000;
      out.push({ what: `${t.table}.${c.name}`, sql: `UPDATE ${t.table} SET ${c.name} = ? WHERE ${where}`, args: [value, productId] });
    }
  }
  out.push({ what: 'stock_decision', sql: "UPDATE product_source_refs SET stock_decision = 'untracked', stock_decided_by = 'x', stock_decided_at = 'y' WHERE product_id = ?", args: [productId] });
  for (const t of PROTECTED_TABLES) out.push({ what: t.table, sql: `INSERT INTO ${t.table} DEFAULT VALUES`, args: [] });
  return out;
}

test('layers 2 and 3 — validator bypassed: unknown keys are dropped by the writer; a forwarded value is refused by the DB guard, zero rows', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  const pid = s.payload.product_id;
  // The payload carries money and stock at several depths; the validator is bypassed (test-only seam).
  let dirty = inject(s.payload, ['product'], 'price_iqd', 990000);
  dirty = inject(dirty, ['groups', '0', 'values', '0'], 'stock', 7);
  dirty = inject(dirty, ['variants', '0'], 'regular_price_iqd', 990000);
  dirty = inject(dirty, [], 'product_cost_iqd', 700000);
  setWriting(w, s.itemId, dirty); // staged as it is: /stage runs the same validator, so only the seam gets this far
  const all = forwarders(pid);
  assert.ok(all.length > 40);
  for (const f of all) {
    const { plan: p, ctx } = await plan(w, s, { payload: dirty, skipAllowList: true });
    p.statements.splice(p.statements.length - 4, 0, w.db.prepare(f.sql).bind(...f.args));
    await assert.rejects(
      () => runImportWrite(ctx, p),
      (e: unknown) => e instanceof ImportWriteRefused && e.code === 'IMPORT_FINANCIAL_WRITE_REFUSED',
      f.what
    );
    for (const t of ['products', 'product_option_values', 'product_variants', 'product_images', 'product_source_refs', 'product_spec_values', 'product_translations', 'search_tokens']) {
      assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'products' ? 'id' : 'product_id'} = ?`, pid), 0, `${f.what}: ${t}`);
    }
  }
  // The same dirty payload, nothing spliced: written at its defaults (the writer never forwards a key).
  const { plan: p, ctx } = await plan(w, s, { payload: dirty, skipAllowList: true });
  const result = await runImportWrite(ctx, p);
  assert.equal(result.after_money_default, true);
  const row = w.raw.prepare('SELECT price_iqd, product_cost_iqd, stock FROM products WHERE id = ?').get(pid) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { price_iqd: 0, product_cost_iqd: null, stock: null });
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = ? AND stock IS NOT NULL', pid), 0);
});

test('end state: every imported product is unpriced, unstocked, not configured for sale, and catalog-only', async () => {
  const w = newWorld();
  const ids: string[] = [];
  for (const h of ['ams-2-pro-feeder-unit', 'pla-basic-filament', 'h2d'] as const) {
    const s = stage(w, h);
    await write(w, s);
    ids.push(s.payload.product_id);
    w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'VERIFYING_LIVE', last_completed_stage = 'PUBLISHING' WHERE id = ?").run(s.itemId);
    w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'COMPLETE', last_completed_stage = 'VERIFYING_LIVE', live_url = 'u', verified_at = 'v', d1_checks = '{\"a\":1}', edge_evidence = '{\"a\":1}' WHERE id = ?").run(s.itemId);
  }
  for (const id of ids) {
    const p = w.raw.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, unknown>;
    assert.equal(p.price_iqd, 0);
    for (const k of ['prime_price_iqd', 'pro_price_iqd', 'original_price_iqd', 'product_cost_iqd', 'stock', 'net_weight_g', 'package_weight_g', 'package_width_mm', 'package_depth_mm', 'package_height_mm']) {
      assert.equal(p[k], null, `${id} ${k}`);
    }
    assert.equal((w.raw.prepare('SELECT stock_decision AS d FROM product_source_refs WHERE product_id = ?').get(id) as { d: string }).d, 'not_configured');
  }
  for (const t of ['product_pricing_state', 'product_sku_prices', 'pricing_v2_sku_results', 'pricing_price_points', 'pricing_preorder_discounts', 'pricing_inputs', 'pricing_rules', 'price_history', 'inventory_lots', 'inventory_ledger', 'product_price_requests']) {
    assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM ${t}`), 0, t);
  }
  const states = await (await listing(w.db)).statesOf(ids);
  for (const id of ids) assert.equal(states.get(id), 'catalog_only', `${id}: visible, not sellable — price_status unpriced`);
});
