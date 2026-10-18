/**
 * «تعبئة أبعاد الشحن من بيانات الاستيراد» — THE OWNER'S FILL OF THE PACKAGE
 * MEASURES FROM THE IMPORTED LOGISTICS ROWS (owner request 2026-10-18;
 * worker/lib/catalogImport/packageMeasures.ts, POST
 * /api/admin/catalog-import/fill-package-measures, the button in
 * src/components/adminImport/PackageMeasuresFill.tsx).
 *
 *   1. the product, an option value and a colour (a variant whose combination
 *      is that colour) are filled from their package.* rows: L → depth,
 *      W → width, H → height; the answer counts them and lists what is still
 *      missing, with the audit row;
 *   2. an owner-entered value is never overwritten, nor a scope whose freight
 *      measure a pricing row holds; a PRICED product is never written (counted
 *      and listed for the product form), even one priced between the read and
 *      the write; a partial box, a row in conflict, an unverified row and
 *      product.* (net) measures are never used; a product the import did not
 *      complete is not touched; no price moves;
 *   3. a second run fills nothing;
 *   4. an editor or an assistant hears 403; while the import's batch guard
 *      stands the owner hears 409 CATALOG_IMPORT_BUSY and nothing is written;
 *   5. the button's answer is read defensively, in three languages, and its
 *      editor link opens the product form at «الأبعاد والوزن» (section 4).
 *
 * Run: node --import tsx --test tests/catalogImportPackageFill.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { all, asD1, freshDb, json, post, row, stubApp, withoutTriggers, type StubUser } from './fixtures/app';
import { ASSISTANT, FULL_ADMIN, OWNER, seedCatalog, seedProduct } from './fixtures/completeness';
import { adminCatalogImportRoutes } from '../worker/routes/adminCatalogImport';
import { FILL_STRINGS, FillResult, editorHref, readFillReport } from '../src/components/adminImport/PackageMeasuresFill';
import { readEditLink } from '../src/components/adminProducts/editLink';
import { ROOT } from './fixtures/d1';

const PATH = '/api/admin/catalog-import/fill-package-measures';
const RUN = 'cir_0123456789abcdef01234567';
const STAMP = '2026-10-01T00:00:00.000Z';

let seq = 0;
function spec(
  raw: DatabaseSync,
  productId: string,
  key: string,
  value: number,
  o: { kind?: 'product' | 'option_value' | 'variant'; id?: string; status?: string; conflict?: string; group?: string; unit?: string } = {}
): void {
  const unit = o.unit ?? (key.endsWith('weight') ? 'g' : 'mm');
  raw
    .prepare(
      `INSERT INTO product_spec_values (id, product_id, canonical_key, group_key, scope_kind, scope_id, region, data_type, value_num, value_text, unit,
                                        status, confidence, source_kind, source_ref, conflict)
       VALUES (?, ?, ?, ?, ?, ?, '', 'number', ?, ?, ?, ?, 'official_page', 'store_page', 'https://store.example/p', ?)`
    )
    .run(`sv_${++seq}`, productId, key, o.group ?? 'logistics', o.kind ?? 'product', o.id ?? '', value, `${value} ${unit}`, unit, o.status ?? 'verified', o.conflict ?? '');
}

/** The owner's V2 method, as the pricing-mode door records it (its guard row, 0189). */
const priceIt = (raw: DatabaseSync, pid: string) =>
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:${pid}', 1);
            INSERT INTO product_pricing_state (product_id, mode, pricing_method) VALUES ('${pid}', 'engine', 'cost');
            DELETE FROM ops_guards WHERE id = 'pricing-mode:${pid}';`);

const box = (raw: DatabaseSync, productId: string, [l, w, h]: [number, number, number], scope: { kind?: 'product' | 'option_value' | 'variant'; id?: string } = {}) => {
  spec(raw, productId, 'package.length', l, scope);
  spec(raw, productId, 'package.width', w, scope);
  spec(raw, productId, 'package.height', h, scope);
};

function world() {
  const raw = freshDb();
  seedCatalog(raw);
  raw.exec("INSERT INTO users (id, name, email, password_hash, role, username) VALUES ('usr_owner', 'Owner', 'boss@x.co', 'h', 'admin', 'usr_owner')");
  const bare = { package_weight_g: null, box: null } as const;
  // p_imp: an imported product with nothing typed; options v1 v2 (v2's weight typed by the owner) v3; a colour c1.
  seedProduct(raw, { id: 'p_imp', slug: 'ams-2-pro', name: 'AMS 2 Pro', ...bare });
  // p_owned: imported, the owner already typed its weight and box.
  seedProduct(raw, { id: 'p_owned', slug: 'owned', name: 'Owned', package_weight_g: 777, box: [10, 20, 30] });
  // p_partial: imported; its package rows are a partial box, a conflict and an unverified edge; its product.* are full.
  seedProduct(raw, { id: 'p_partial', slug: 'partial', name: 'Partial', ...bare });
  // p_native: not imported (no COMPLETE item), with package rows all the same.
  seedProduct(raw, { id: 'p_native', slug: 'native', name: 'Native', ...bare });
  // p_priced: imported, then priced by the owner (an engine state): never written, listed for the form.
  seedProduct(raw, { id: 'p_priced', slug: 'priced', name: 'Priced', ...bare });
  priceIt(raw, 'p_priced');
  raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g1', 'p_imp', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('v1', 'p_imp', 'g1', 'Standard', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, package_weight_g) VALUES ('v2', 'p_imp', 'g1', 'Combo', 1, 1, 900);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('v3', 'p_imp', 'g1', 'Lite', 2, 1);
    INSERT INTO product_colors (id, product_id, name_en, hex) VALUES ('c1', 'p_imp', 'Black', '#000000');
    INSERT INTO product_variants (id, product_id, combo_key) VALUES ('pv_c1', 'p_imp', 'c:c1');
    INSERT INTO product_variants (id, product_id, combo_key) VALUES ('pv_v3', 'p_imp', 'o:v3');
    INSERT INTO product_variants (id, product_id, combo_key) VALUES ('pv_multi', 'p_imp', 'o:v1|c:c1');
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('v4', 'p_imp', 'g1', 'Pro', 3, 1);
    INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, shipping_weight_g, updated_at) VALUES ('p_imp', 'option', 'v4', 'SOURCE', 1800, '${STAMP}');
  `);

  // The ams-2-pro-feeder-unit shape: 100 × 135 × 45 mm at product scope (L, W, H), a fractional weight.
  box(raw, 'p_imp', [100, 135, 45]);
  spec(raw, 'p_imp', 'package.weight', 1500.4);
  spec(raw, 'p_imp', 'product.net_weight', 1000, { group: 'physical' });
  box(raw, 'p_imp', [50, 60, 70], { kind: 'option_value', id: 'v1' });
  spec(raw, 'p_imp', 'package.weight', 300, { kind: 'option_value', id: 'v1' });
  box(raw, 'p_imp', [11, 22, 33], { kind: 'option_value', id: 'v2' });
  spec(raw, 'p_imp', 'package.weight', 400, { kind: 'option_value', id: 'v2' });
  spec(raw, 'p_imp', 'package.weight', 350, { kind: 'variant', id: 'pv_v3' });
  box(raw, 'p_imp', [80, 90, 100], { kind: 'variant', id: 'pv_c1' });
  spec(raw, 'p_imp', 'package.weight', 250, { kind: 'variant', id: 'pv_c1' });
  spec(raw, 'p_imp', 'package.weight', 999, { kind: 'variant', id: 'pv_multi' });
  // Shipment and carton rows are never package measures.
  spec(raw, 'p_imp', 'shipment.gross_weight', 8000);
  spec(raw, 'p_imp', 'carton.length', 600);

  box(raw, 'p_owned', [1, 2, 3]);
  spec(raw, 'p_owned', 'package.weight', 2000);

  spec(raw, 'p_partial', 'package.length', 200);
  spec(raw, 'p_partial', 'package.width', 100);
  spec(raw, 'p_partial', 'package.height', 50, { status: 'unverified' });
  spec(raw, 'p_partial', 'package.weight', 1200, { conflict: 'spec_sources_disagree' });
  for (const [k, v] of [['product.net_weight', 5000], ['product.length', 300], ['product.width', 300], ['product.height', 300]] as const) spec(raw, 'p_partial', k, v);

  // v4's freight measure lives in a pricing row (a purchase's, before row 247): the owner's, kept.
  box(raw, 'p_imp', [40, 40, 40], { kind: 'option_value', id: 'v4' });
  spec(raw, 'p_imp', 'package.weight', 450, { kind: 'option_value', id: 'v4' });
  box(raw, 'p_priced', [70, 80, 90]);
  spec(raw, 'p_priced', 'package.weight', 700);

  box(raw, 'p_native', [5, 6, 7]);
  spec(raw, 'p_native', 'package.weight', 600);

  raw.exec(`INSERT INTO catalog_import_runs (id, source, state) VALUES ('${RUN}', 'bambu_us', 'closed')`);
  ['p_imp', 'p_owned', 'p_partial', 'p_priced'].forEach((pid, i) =>
    withoutTriggers(
      raw,
      ['trg_cii_insert'],
      `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at, processing_state,
                                         levonis_product_id, live_url, verified_at, d1_checks, edge_evidence)
       VALUES ('cii_${i}', '${RUN}', 'bambu_us', 'src${i}', 'h${i}', 'https://store.example/h${i}', ${i}, '${STAMP}', 'COMPLETE',
               '${pid}', 'https://levonis-iq.com/product/${pid}', '${STAMP}', '{"ok":1}', '{"ok":1}')`
    )
  );
  const db = asD1(raw);
  const as = (user: StubUser) => stubApp(db, user, (a) => a.route('/api/admin/catalog-import', adminCatalogImportRoutes));
  return { raw, as };
}

const DIMS = 'package_weight_g AS w, package_depth_mm AS d, package_width_mm AS wd, package_height_mm AS h';
const dims = (raw: DatabaseSync, table: string, id: string) => ({ ...row(raw, `SELECT ${DIMS} FROM ${table} WHERE id = ?`, id) });

test('the product, its option values and a colour are filled from package.* (L → depth, W → width, H → height); the answer lists what is still missing', async () => {
  const w = world();
  const res = await post(w.as(OWNER), PATH);
  assert.equal(res.status, 200);
  const body = await json(res);

  assert.deepEqual(dims(w.raw, 'products', 'p_imp'), { w: 1501, d: 100, wd: 135, h: 45 }, 'the product: 100 × 135 × 45 mm, the weight rounded up');
  assert.deepEqual(dims(w.raw, 'product_option_values', 'v1'), { w: 300, d: 50, wd: 60, h: 70 });
  assert.deepEqual(dims(w.raw, 'product_option_values', 'v3'), { w: 350, d: null, wd: null, h: null }, 'a one-option variant is that option');
  assert.deepEqual(dims(w.raw, 'product_colors', 'c1'), { w: 250, d: 80, wd: 90, h: 100 }, 'a one-colour variant is that colour');

  assert.deepEqual(body.filled, { product: { weight: 1, box: 1 }, option: { weight: 2, box: 2 }, color: { weight: 1, box: 1 } });
  assert.equal(body.imported_products, 4);
  assert.equal(body.products_filled, 1);
  assert.equal(body.skipped.partial_box, 1);
  assert.equal(body.skipped.conflict, 1);
  assert.equal(body.skipped.unverified, 1);
  assert.equal(body.skipped.kept_existing, 5, "v2's weight, p_owned's weight and box, v4's pricing-held weight and box");
  assert.equal(body.skipped_priced, 1);
  assert.deepEqual(body.priced_products, [{ id: 'p_priced', slug: 'priced', name_en: 'Priced', name_ar: 'منتج priced', name_ckb: 'بەرهەمی priced' }]);
  assert.equal(body.skipped.unmapped_scope, 1, 'a variant of two choices is no single row');
  assert.deepEqual(body.still_missing, [
    { id: 'p_partial', slug: 'partial', name_en: 'Partial', name_ar: 'منتج partial', name_ckb: 'بەرهەمی partial', weight: true, box: true },
    { id: 'p_priced', slug: 'priced', name_en: 'Priced', name_ar: 'منتج priced', name_ckb: 'بەرهەمی priced', weight: true, box: true },
  ]);
  assert.equal(body.still_missing_total, 2);

  // The version moved for the filled product only (an open form saves no stale copy).
  assert.notEqual(row<{ u: string }>(w.raw, 'SELECT updated_at AS u FROM products WHERE id = ?', 'p_imp')!.u, STAMP);
  assert.equal(row<{ u: string }>(w.raw, 'SELECT updated_at AS u FROM products WHERE id = ?', 'p_owned')!.u, STAMP);

  // The audit row, with the counts.
  const audits = all<{ actor_id: string; target: string; detail: string }>(w.raw, "SELECT actor_id, target, detail FROM audit_log WHERE action = 'catalog_import.fill_package_measures'");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actor_id, 'usr_owner');
  const detail = JSON.parse(audits[0]!.detail) as Record<string, unknown>;
  assert.deepEqual(detail.filled, body.filled);
  assert.equal(detail.products_filled, 1);
  assert.equal(detail.still_missing, 2);
  assert.equal(detail.skipped_priced, 1);
});

test('never an owner value, a partial box, a conflict, an unverified row, product.* or a product the import did not complete; no price moves', async () => {
  const w = world();
  const prices = all(w.raw, 'SELECT id, price_iqd, product_cost_iqd FROM products ORDER BY id');
  const pricing = all(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs');
  assert.equal((await post(w.as(OWNER), PATH)).status, 200);

  assert.deepEqual(dims(w.raw, 'products', 'p_owned'), { w: 777, d: 20, wd: 10, h: 30 }, 'the owner’s values stay');
  assert.deepEqual(dims(w.raw, 'product_option_values', 'v2'), { w: 900, d: 11, wd: 22, h: 33 }, 'the owner’s weight stays; the empty box is filled');
  assert.deepEqual(dims(w.raw, 'products', 'p_partial'), { w: null, d: null, wd: null, h: null }, 'a partial box, a conflict, an unverified edge and product.* fill nothing');
  assert.deepEqual(dims(w.raw, 'products', 'p_native'), { w: null, d: null, wd: null, h: null }, 'not imported: not touched');
  assert.deepEqual(dims(w.raw, 'products', 'p_priced'), { w: null, d: null, wd: null, h: null }, 'priced: left for the form’s reviewed save');
  assert.equal(row<{ u: string }>(w.raw, 'SELECT updated_at AS u FROM products WHERE id = ?', 'p_priced')!.u, STAMP);
  assert.deepEqual(dims(w.raw, 'product_option_values', 'v4'), { w: null, d: null, wd: null, h: null }, 'a pricing row holds its measure');
  assert.deepEqual(
    { ...row<Record<string, unknown>>(w.raw, 'SELECT net_weight_g AS n, width_mm AS w FROM products WHERE id = ?', 'p_partial') },
    { n: null, w: null },
    'product.* never reaches a column'
  );
  assert.deepEqual(all(w.raw, 'SELECT id, price_iqd, product_cost_iqd FROM products ORDER BY id'), prices, 'no price moves');
  assert.deepEqual(all(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), pricing);
});

test('a second run fills nothing', async () => {
  const w = world();
  assert.equal((await post(w.as(OWNER), PATH)).status, 200);
  const before = all(w.raw, `SELECT id, ${DIMS}, updated_at FROM products ORDER BY id`);
  const again = await json(await post(w.as(OWNER), PATH));
  assert.deepEqual(again.filled, { product: { weight: 0, box: 0 }, option: { weight: 0, box: 0 }, color: { weight: 0, box: 0 } });
  assert.equal(again.products_filled, 0);
  assert.equal(again.still_missing_total, 2);
  assert.equal(again.skipped_priced, 1);
  assert.deepEqual(all(w.raw, `SELECT id, ${DIMS}, updated_at FROM products ORDER BY id`), before);
});

test('an editor or an assistant is refused; while the import’s guard stands the owner is told to retry and nothing is written', async () => {
  const w = world();
  for (const user of [FULL_ADMIN, ASSISTANT]) {
    const res = await post(w.as(user), PATH);
    assert.equal(res.status, 403, user.id);
    assert.equal((await json(res)).code, 'OWNER_ONLY');
  }
  assert.deepEqual(dims(w.raw, 'products', 'p_imp'), { w: null, d: null, wd: null, h: null });

  w.raw.exec("INSERT INTO ops_guards (id, ok) VALUES ('catalog-import-batch', 1)");
  const busy = await post(w.as(OWNER), PATH);
  assert.equal(busy.status, 409);
  assert.equal((await json(busy)).code, 'CATALOG_IMPORT_BUSY');
  assert.deepEqual(dims(w.raw, 'products', 'p_imp'), { w: null, d: null, wd: null, h: null });
  assert.deepEqual(dims(w.raw, 'product_colors', 'c1'), { w: null, d: null, wd: null, h: null });
  assert.equal(all(w.raw, "SELECT 1 FROM audit_log WHERE action = 'catalog_import.fill_package_measures'").length, 0);

  w.raw.exec("DELETE FROM ops_guards WHERE id = 'catalog-import-batch'");
  assert.equal((await post(w.as(OWNER), PATH)).status, 200, 'idle again: the retry fills');
  assert.equal(dims(w.raw, 'products', 'p_imp').w, 1501);
});

test('a guard that appears between the check and the write rolls the fill back: 409, nothing written', async () => {
  const w = world();
  const db = asD1(w.raw);
  const racing = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          w.raw.exec("INSERT OR IGNORE INTO ops_guards (id, ok) VALUES ('catalog-import-batch', 1)");
          return target.batch(statements);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const app = stubApp(racing, OWNER, (a) => a.route('/api/admin/catalog-import', adminCatalogImportRoutes));
  const res = await post(app, PATH);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'CATALOG_IMPORT_BUSY');
  assert.deepEqual(dims(w.raw, 'products', 'p_imp'), { w: null, d: null, wd: null, h: null });
  assert.deepEqual(dims(w.raw, 'product_option_values', 'v1'), { w: null, d: null, wd: null, h: null });
});

test('a product priced between the read and the write is not touched', async () => {
  const w = world();
  let priced = false;
  const pricedOnce = new Proxy(asD1(w.raw), {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          if (!priced) priceIt(w.raw, 'p_imp');
          priced = true;
          return target.batch(statements);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const res = await post(stubApp(pricedOnce, OWNER, (a) => a.route('/api/admin/catalog-import', adminCatalogImportRoutes)), PATH);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.filled, { product: { weight: 0, box: 0 }, option: { weight: 0, box: 0 }, color: { weight: 0, box: 0 } });
  for (const [table, id] of [['products', 'p_imp'], ['product_option_values', 'v1'], ['product_colors', 'c1']] as const) {
    assert.deepEqual(dims(w.raw, table, id), { w: null, d: null, wd: null, h: null }, `${table} ${id}`);
  }
  assert.equal(row<{ u: string }>(w.raw, 'SELECT updated_at AS u FROM products WHERE id = ?', 'p_imp')!.u, STAMP, 'its version stays too');
});

test('the button’s answer is read defensively and drawn in three languages, each product linked to its editor', () => {
  for (const [k, v] of Object.entries(FILL_STRINGS)) {
    assert.ok(v.ar && v.en && v.ckb, k);
    assert.notEqual(v.ckb, v.ar, `${k}: the Sorani copies the Arabic`);
  }
  const view = readFillReport({
    imported_products: 3,
    products_filled: 1,
    filled: { product: { weight: 1, box: 1 }, option: { weight: 2, box: 'x' }, color: { weight: -4, box: 1 } },
    skipped: { kept_existing: 3, conflict: 1, unverified: 1, invalid: 0, partial_box: 1 },
    skipped_priced: 1,
    priced_products: [{ id: 'p_priced', slug: 'priced', name_en: 'Priced', name_ar: 'مسعّر', name_ckb: 'نرخدانراو' }, { id: 'bad id' }],
    still_missing: [
      { id: 'p_partial', slug: 'partial', name_en: 'Partial', name_ar: 'جزئي', name_ckb: 'بەشێک', weight: true, box: true },
      { id: '"><script>', slug: 'x', weight: true },
    ],
    still_missing_total: 7,
  });
  assert.deepEqual(view.filled, { product: { weight: 1, box: 1 }, option: { weight: 2, box: 0 }, color: { weight: 0, box: 1 } });
  assert.equal(view.unused, 3);
  assert.deepEqual(view.missing.map((m) => m.id), ['p_partial'], 'an unsafe id draws no link');
  assert.equal(view.missingTotal, 7);
  assert.deepEqual(view.priced.map((m) => m.id), ['p_priced']);
  assert.equal(view.pricedTotal, 1);
  assert.equal(editorHref('p_partial'), '/admin?tab=products&edit=p_partial&section=4');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = renderToStaticMarkup(createElement(FillResult, { view, lang }));
    assert.match(html, /href="\/admin\?tab=products&amp;edit=p_partial&amp;section=4"/);
    assert.match(html, /data-fill-priced-id="p_priced"[^>]*><a [^>]*href="\/admin\?tab=products&amp;edit=p_priced&amp;section=4"/);
    assert.ok(html.includes(FILL_STRINGS.priced[lang]) && html.includes(FILL_STRINGS.stillMissing[lang]), lang);
    assert.ok(html.includes(FILL_STRINGS.weight[lang]) && html.includes(FILL_STRINGS.box[lang]), lang);
  }
  const none = renderToStaticMarkup(createElement(FillResult, { view: readFillReport({}), lang: 'ckb' }));
  assert.ok(none.includes(FILL_STRINGS.noneMissing.ckb));
});

test('the editor link reaches the product form: «الأبعاد والوزن» (section 4) opens first', () => {
  assert.deepEqual(readEditLink(new URL(editorHref('p_partial'), 'https://levonis-iq.com').search), { id: 'p_partial', section: 4 });
  assert.deepEqual(readEditLink('?tab=products&edit=p_x'), { id: 'p_x', section: null });
  assert.deepEqual(readEditLink('?tab=products&edit=p_x&section=9'), { id: 'p_x', section: null });
  assert.equal(readEditLink('?tab=products&edit=%22%3E'), null);
  // The list hands the section to the form, which opens it first and scrolls to it once loaded.
  const list = readFileSync(join(ROOT, 'src/components/AdminProducts.tsx'), 'utf8');
  assert.match(list, /readEditLink\(window\.location\.search\)/);
  assert.match(list, /initialSection=\{editing\.section \?\? null\}/);
  const form = readFileSync(join(ROOT, 'src/components/adminProducts/ProductForm.tsx'), 'utf8');
  assert.match(form, /useState\(initialSection \?\? 1\)/);
  assert.match(form, /\[data-section="\$\{initialSection\}"\]/);
});
