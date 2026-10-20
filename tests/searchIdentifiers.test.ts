/**
 * THE IDENTIFIER LANE (smart search 1.5; worker/lib/search/identifiers.ts,
 * migration 0206) — acceptance rows 5–7 of the assistant plan, through the
 * listing route, on a D1 stand-in that refuses what D1 refuses (more than 100
 * bound parameters, more than five compound terms, more than 32 arguments to
 * one function).
 *
 *   5  an unknown colour code «10102» → "no exact match for 10102"
 *      (`exact_miss`), and 10100/10101 are NOT shown as exact;
 *   6  «10101» → PLA Basic with THAT colour preselected (`matched.color_id`),
 *      never another colour;
 *   7  the part code «FAP035» → its product exactly, or an honest miss —
 *      never the cutting mats one character away as a "match".
 *
 * Plus what keeps those answers honest: a hidden product's code is a miss,
 * not a leak; a discontinued colour's code is not an exact answer; a code
 * still being typed is not a miss while a code starts with it; a SKU names
 * its variant; a size preselects the option value named with it; the save
 * and the catch-up write the same rows; a token-only rewrite is repaired by
 * the catch-up; and a database without 0206 answers exactly as before.
 *
 * Run: node --import tsx --test tests/searchIdentifiers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, ctx, dbThrough, freshDb, json, stubApp } from './fixtures/app';
import { limitD1, maxParams, violations } from './fixtures/d1Limits';
import {
  codePieces,
  extractIdentifiers,
  IDENTIFIER_ROWS_PER_STATEMENT,
  IDENTIFIER_STAMP,
  identifierKey,
  identifierRows,
  planSearchIdentifiers,
  resolveIdentifier,
} from '../worker/lib/search/identifiers';
import { backfillSearchIndex, INDEX_STAMP, planSearchIndex, searchDocColumns, searchDocsForRows, searchIndexStatus } from '../worker/lib/search/store';
import { toSearchDoc } from '../worker/lib/search/document';
import { planProductSave } from '../worker/lib/productPersistence';
import { parseProductRow } from '../worker/lib/productModel';

// =========================================================================
// THE KEY AND THE QUERY: PURE
// =========================================================================

test('one key for a code, however it is typed — and no key for a word or a size', () => {
  for (const [typed, key] of [
    ['FAP035', 'FAP035'],
    ['fap-035', 'FAP035'],
    ['ＦＡＰ０３５', 'FAP035'],
    ['١٠١٠١', '10101'],
    ['۱۰۱۰۱', '10101'],
    ['X2D-COMBO-01', 'X2DCOMBO01'],
  ] as const) {
    assert.equal(identifierKey(typed), key, typed);
  }
  // A word is a word: no digit, no key. «ABS» must never be "exactly" a product whose SKU is ABS.
  for (const word of ['ABS', 'AMS', 'PETG', 'بامبو', 'نوزل', '']) assert.equal(identifierKey(word), '', word);
  // Too short to be a code.
  assert.equal(identifierKey('0.4'), '');
});

test('which chunks may be called a miss: codes yes; words, sizes, quantities and short numbers never', () => {
  const reportable = (q: string) => extractIdentifiers(q).codes.filter((c) => c.reportable).map((c) => c.text);
  assert.deepEqual(reportable('10102'), ['10102']);
  assert.deepEqual(reportable('FAP035'), ['FAP035']);
  assert.deepEqual(reportable('PLA Basic 10101'), ['10101']);
  assert.deepEqual(reportable('RTX4090'), ['RTX4090']);
  for (const q of ['nozzle 0.4mm', 'PLA1.75', 'X1-Carbon', 'A1 mini', '2024', '1000g', '24v', 'مغناطيس 6×2', 'نوزل ٠.٤', 'PLA']) {
    assert.deepEqual(reportable(q), [], q);
  }
  // Sizes are measures (never exact, never a miss): they preselect an option value.
  assert.deepEqual(extractIdentifiers('nozzle 0.4mm').measures, ['0.4']);
  assert.deepEqual(extractIdentifiers('نوزل ٠.٤').measures, ['0.4']);
  assert.deepEqual(extractIdentifiers('6 x 2').measures, ['6X2']);
});

test('the rows a product is keyed by: codes at their scope, a product-scoped colour code placed on the one colour that names it', () => {
  const rows = identifierRows({
    sku: 'BL-PLA-01',
    variants: [{ id: 'v1', sku: 'X2D-COMBO-01' }],
    externalIds: [
      // As the live PLA Basic merge stored them: product scope (0194 cannot scope to a product_colors colour).
      { scope_kind: 'product', scope_id: '', id_type: 'color_code', value: '10100' },
      { scope_kind: 'product', scope_id: '', id_type: 'color_code', value: '10101' },
      { scope_kind: 'product', scope_id: '', id_type: 'color_code', value: '10200' },
      { scope_kind: 'option_value', scope_id: 'ov_g', id_type: 'color_code', value: '10900' },
      // Opaque and identity rows are not identifiers.
      { scope_kind: 'product', scope_id: '', id_type: 'bambu_product_id', value: '6945419460744' },
      { scope_kind: 'product', scope_id: '', id_type: 'identity.model', value: 'H2D' },
    ],
    options: [{ id: 'ov_04', names: ['0.4mm', 'نوزل 0.4 ملم'] }],
    colors: [
      { id: 'jade-white-10100', names: ['Jade White'] },
      { id: 'c_black', names: ['Black (10101)', 'أسود'] },
      // Two colours claim 10200: neither receives it.
      { id: 'red-10200', names: ['Red'] },
      { id: 'c_red2', names: ['Red (10200)'] },
    ],
  });
  const at = (key: string) => rows.filter((r) => r.key === key).map((r) => `${r.scope_kind}:${r.scope_id}:${r.kind}`);
  assert.deepEqual(at('10100'), ['product::color_code', 'color:jade-white-10100:color_code'], 'placed by the id that ends with it');
  assert.deepEqual(at('10101'), ['product::color_code', 'color:c_black:color_code'], 'placed by the name that carries it');
  assert.deepEqual(at('10900'), ['option_value:ov_g:color_code']);
  assert.deepEqual(at('BLPLA01'), ['product::sku']);
  assert.deepEqual(at('X2DCOMBO01'), ['variant:v1:variant_sku']);
  assert.deepEqual(at('0.4'), ['option_value:ov_04:measure']);
  assert.ok(!rows.some((r) => r.key === '6945419460744' || r.key === 'H2D'));
  // The name «Red (10200)» is a code of its own colour; the id «red-10200» alone places nothing.
  assert.deepEqual(at('10200'), ['product::color_code', 'color:c_red2:color_code']);
});

test('the packed writer: 500 rows a statement, two bound values each', () => {
  const raw = freshDb();
  const db = asD1(raw);
  raw.prepare(`INSERT INTO products (id, slug, name, price_iqd, status) VALUES ('p_big', 'p_big', 'Big', 1000, 'active')`).run();
  const rows = Array.from({ length: 1201 }, (_, i) => ({
    key: `K${String(i).padStart(5, '0')}`,
    scope_kind: 'product' as const,
    scope_id: '',
    kind: 'part_code' as const,
    source: 'external_id',
  }));
  const stmts = planSearchIdentifiers(db, 'p_big', rows);
  assert.equal(stmts.length, 1 + Math.ceil(rows.length / IDENTIFIER_ROWS_PER_STATEMENT));
  return db.batch(stmts).then(() => {
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM search_identifiers WHERE product_id = 'p_big'").get() as { n: number }).n, 1201);
  });
});

// =========================================================================
// A SHOP WITH CODES, THROUGH THE ROUTE
// =========================================================================

const colour = (id: string, name: string, active = 1) => ({ id, name, active });

/** The catalogue of rows 5–7, written as the stores write it, then indexed by the catch-up. */
async function codedShop(raw: DatabaseSync = freshDb()): Promise<DatabaseSync> {
  const product = (id: string, name: string, extra: { status?: string; sku?: string; options?: unknown[]; colors?: unknown[] } = {}) =>
    raw
      .prepare(`INSERT INTO products (id, slug, name, description, price_iqd, status, sku, options, colors) VALUES (?, ?, ?, '', 1000, ?, ?, ?, ?)`)
      .run(id, id, name, extra.status ?? 'active', extra.sku ?? null, JSON.stringify(extra.options ?? []), JSON.stringify(extra.colors ?? []));
  const external = (pid: string, type: string, value: string, scope: [string, string] = ['product', '']) =>
    raw
      .prepare(`INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value, searchable) VALUES (?, ?, ?, ?, ?, 1)`)
      .run(pid, scope[0], scope[1], type, value);

  // PLA Basic as the live merge left it: colours in product_colors, their codes at PRODUCT scope.
  const pla = [colour('jade-white-10100', 'Jade White'), colour('black-10101', 'Black'), colour('grey-10103', 'Grey', 0)];
  product('p_pla', 'Bambu PLA Basic', { colors: pla.map((c) => ({ id: c.id, name_en: c.name, name_ar: '', name_ckb: '', hex: '#000000', active: !!c.active })) });
  for (const c of pla) {
    raw.prepare(`INSERT INTO product_colors (id, product_id, name_en, hex, active) VALUES (?, 'p_pla', ?, '#000000', ?)`).run(c.id, c.name, c.active);
    external('p_pla', 'color_code', c.id.slice(-5));
  }
  // A created import: the colour is an option value, its code scoped to it.
  product('p_grad', 'Bambu PLA Basic Gradient', { options: [{ id: 'ov_arctic', name_en: 'Arctic Whisper (10900)', active: true }] });
  raw.prepare(`INSERT INTO product_option_groups (id, product_id, name_en) VALUES ('g_grad', 'p_grad', 'Color')`).run();
  raw.prepare(`INSERT INTO product_option_values (id, product_id, group_id, name_en) VALUES ('ov_arctic', 'p_grad', 'g_grad', 'Arctic Whisper (10900)')`).run();
  external('p_grad', 'color_code', '10900', ['option_value', 'ov_arctic']);
  // Row 7: the part code, and the cutting mats one character away.
  product('p_hotend', 'Hotend Heating Assembly');
  external('p_hotend', 'part_code', 'FAP035');
  product('p_mat1', 'Cutting Mat A3');
  external('p_mat1', 'part_code', 'FAP030');
  product('p_mat2', 'Cutting Mat A4');
  external('p_mat2', 'part_code', 'FAP031');
  // A SKU names its variant.
  product('p_x2d', 'Bambu Lab X2D', { options: [{ id: 'ov_combo', name_en: 'Combo', active: true }] });
  raw.prepare(`INSERT INTO product_option_groups (id, product_id, name_en) VALUES ('g_x2d', 'p_x2d', 'Package')`).run();
  raw.prepare(`INSERT INTO product_option_values (id, product_id, group_id, name_en) VALUES ('ov_combo', 'p_x2d', 'g_x2d', 'Combo')`).run();
  raw.prepare(`INSERT INTO product_variants (id, product_id, combo_key, sku) VALUES ('v_combo', 'p_x2d', 'o:ov_combo', 'X2D-COMBO-01')`).run();
  // A hidden product's code must not leak.
  product('p_hidden', 'Secret Part', { status: 'hidden' });
  external('p_hidden', 'part_code', 'FAP099');
  // A size preselects the option value named with it.
  const sizes = [['ov_02', '0.2mm'], ['ov_04', '0.4mm'], ['ov_06', '0.6mm']];
  product('p_nozzle', 'Hardened Steel Nozzle', { options: sizes.map(([id, name_en]) => ({ id, name_en, active: true })) });
  raw.prepare(`INSERT INTO product_option_groups (id, product_id, name_en) VALUES ('g_d', 'p_nozzle', 'Diameter')`).run();
  for (const [id, name] of sizes) {
    raw.prepare(`INSERT INTO product_option_values (id, product_id, group_id, name_en) VALUES (?, 'p_nozzle', 'g_d', ?)`).run(id, name);
  }
  // The catch-up indexes the hidden product too (the index holds every product; the route filters).
  raw.prepare(`UPDATE products SET status = 'active' WHERE id = 'p_hidden'`).run();
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  raw.prepare(`UPDATE products SET status = 'hidden' WHERE id = 'p_hidden'`).run();
  assert.deepEqual(run.failed, []);
  return raw;
}

async function listing(db: D1Database, query: string) {
  const { productRoutes } = await import('../worker/routes/products');
  const app = stubApp(db as never, null, (x) => x.route('/api/products', productRoutes), { host: APEX, env: { DB: db } });
  const res = await app.request(`/api/products?${query}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  return { status: res.status, body: (await json(res)) as Record<string, unknown> };
}

type Body = {
  products: { id: string }[];
  exact?: { product_id: string; key: string; kind: string; scope: { kind: string; id: string } }[];
  matched?: Record<string, { option_value_ids: string[]; color_id: string | null; variant_id: string | null }>;
  exact_miss?: string[];
};

/** A finished search (trailing space), through the route, on the limits D1 enforces. */
async function search(db: D1Database, q: string, opts: { typing?: boolean } = {}): Promise<Body> {
  const res = await listing(db, `search=${encodeURIComponent(opts.typing ? q : `${q} `)}&limit=50`);
  assert.equal(res.status, 200, `${q}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body as unknown as Body;
}

test('row 5: an unknown colour code says "no exact match", and its neighbours are not shown as exact', async () => {
  const db = limitD1(await codedShop());
  for (const q of ['10102', '١٠١٠٢']) {
    const b = await search(db, q);
    assert.deepEqual(b.exact_miss, [q], q);
    assert.equal(b.exact, undefined, `${q}: nothing is exact`);
    assert.deepEqual(b.products, [], `${q}: 10100 and 10101 are not answers`);
  }
  // Beside words: the miss is still said, and the words still answer.
  const mixed = await search(db, 'PLA 10102');
  assert.deepEqual(mixed.exact_miss, ['10102']);
  assert.equal(mixed.exact, undefined);
  assert.deepEqual(violations, []);
});

test('row 6: «10101» is PLA Basic with THAT colour preselected — never another colour', async () => {
  const db = limitD1(await codedShop());
  for (const q of ['10101', '١٠١٠١', 'PLA Basic 10101']) {
    const b = await search(db, q);
    assert.equal(b.products[0]?.id, 'p_pla', `${q}: PLA Basic heads the list`);
    assert.deepEqual(b.exact, [{ product_id: 'p_pla', key: '10101', kind: 'color_code', scope: { kind: 'color', id: 'black-10101' } }], q);
    assert.deepEqual(b.matched?.p_pla, { option_value_ids: [], color_id: 'black-10101', variant_id: null }, q);
    assert.equal(b.exact_miss, undefined, q);
  }
  // A colour that is an option value: the value is preselected.
  const grad = await search(db, '10900');
  assert.deepEqual(grad.exact?.map((h) => [h.product_id, h.scope.kind, h.scope.id]), [['p_grad', 'option_value', 'ov_arctic']]);
  assert.deepEqual(grad.matched?.p_grad, { option_value_ids: ['ov_arctic'], color_id: null, variant_id: null });
  assert.deepEqual(violations, []);
});

test('row 7: a part code is its product exactly, or an honest miss — never the cutting mats one edit away', async () => {
  const db = limitD1(await codedShop());
  for (const q of ['FAP035', 'fap-035', 'ＦＡＰ０３５']) {
    const b = await search(db, q);
    assert.deepEqual(b.exact?.map((h) => h.product_id), ['p_hotend'], q);
    assert.deepEqual(b.products.map((p) => p.id), ['p_hotend'], `${q}: no cutting mat`);
    assert.equal(b.matched, undefined, `${q}: a product-scope code preselects nothing`);
  }
  // A code beside words: the exact product first, then the ranking.
  const worded = await search(db, 'FAP035 hotend');
  assert.equal(worded.products[0]?.id, 'p_hotend');
  assert.deepEqual(worded.exact?.map((h) => h.product_id), ['p_hotend']);
  // Nobody carries FAP036: the miss is said first; whatever the ranking still shows (the mats share
  // «FAP») is a NEAR result — none of it is in `exact`.
  const none = await search(db, 'FAP036');
  assert.deepEqual(none.exact_miss, ['FAP036']);
  assert.equal(none.exact, undefined);
  assert.equal(none.matched, undefined);
  assert.deepEqual(violations, []);
});

test('a hidden product’s code is a miss, not a leak', async () => {
  const db = limitD1(await codedShop());
  const b = await search(db, 'FAP099');
  assert.equal(b.exact, undefined);
  assert.deepEqual(b.exact_miss, ['FAP099']);
  assert.ok(!JSON.stringify(b).includes('p_hidden'));
});

test('a discontinued colour’s code is not an exact answer, though the product still carries it', async () => {
  const db = limitD1(await codedShop());
  const b = await search(db, '10103');
  assert.equal(b.exact, undefined, 'grey-10103 is inactive');
  assert.equal(b.matched?.p_pla, undefined);
  // The code is written in PLA Basic's index (its alias), so "no product carries it" would be false too: silence.
  assert.equal(b.exact_miss, undefined);
});

test('a SKU names its variant: the variant and its options are the selection', async () => {
  const db = limitD1(await codedShop());
  for (const q of ['X2D-COMBO-01', 'x2d-combo-01']) {
    const b = await search(db, q);
    assert.deepEqual(b.exact?.map((h) => [h.product_id, h.kind, h.scope.kind, h.scope.id]), [['p_x2d', 'variant_sku', 'variant', 'v_combo']], q);
    assert.deepEqual(b.matched?.p_x2d, { option_value_ids: ['ov_combo'], color_id: null, variant_id: 'v_combo' }, q);
  }
});

test('a size preselects the option value named with it (row 1’s selection), and is never a miss', async () => {
  const db = limitD1(await codedShop());
  for (const q of ['nozzle 0.4', 'نوزل ٠.٤', 'nozzle 0.4mm']) {
    const b = await search(db, q);
    assert.deepEqual(b.matched?.p_nozzle, { option_value_ids: ['ov_04'], color_id: null, variant_id: null }, q);
    assert.equal(b.exact, undefined, `${q}: a size is not an identifier`);
    assert.equal(b.exact_miss, undefined, q);
  }
});

test('a code still being typed is not a miss while a code starts with it; finished, it is', async () => {
  const db = limitD1(await codedShop());
  assert.equal((await search(db, 'FAP03', { typing: true })).exact_miss, undefined, 'FAP035 starts with it');
  assert.deepEqual((await search(db, 'FAP03')).exact_miss, ['FAP03'], 'a trailing space: the shopper meant FAP03');
  assert.deepEqual((await search(db, '10102', { typing: true })).exact_miss, ['10102'], 'no code starts with 10102');
});

test('a search without a code answers exactly as before: no new keys', async () => {
  const db = limitD1(await codedShop());
  const b = await search(db, 'Cutting Mat');
  assert.deepEqual(b.products.map((p) => p.id).sort(), ['p_mat1', 'p_mat2']);
  for (const k of ['exact', 'matched', 'exact_miss']) assert.ok(!(k in b), k);
});

// -------------------------------------------------------------------------
// A code written in a product's own text (review of 1.5)
// -------------------------------------------------------------------------

/** Codes written in names, with separators, in pieces, beside the rows-7 shop's identifier rows. */
async function spelledShop(): Promise<DatabaseSync> {
  const raw = await codedShop();
  const product = (id: string, name: string) =>
    raw.prepare(`INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES (?, ?, ?, '', 1000, 'active')`).run(id, id, name);
  product('p_cr10', 'Creality CR-10 SE 3D Printer');
  product('p_pa12', 'Polymaker PA12-CF Filament');
  product('p_tpu', 'Bambu TPU 95A HF');
  product('p_tpu2', 'Bambu TPU 85A/90A');
  product('p_x1c', 'Hotend for X1C/P1S');
  // Row 7's code, written in another product's NAME: not an identifier row, but the code the shopper typed.
  product('p_kit', 'Hotend Kit with FAP035 heater (2 pcs)');
  // And a product that has FAP and 035 nowhere together.
  product('p_far', 'FAP Cleaning Kit');
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, []);
  return raw;
}

test('the pieces a code is written in: separators split, letter and digit runs split, a lone character joins its neighbour', () => {
  assert.deepEqual(codePieces('CR-10'), ['cr', '10']);
  assert.deepEqual(codePieces('CR10'), ['cr', '10']);
  assert.deepEqual(codePieces('PA12-CF'), ['pa', '12', 'cf']);
  assert.deepEqual(codePieces('TPU95A'), ['tpu', '95a']);
  assert.deepEqual(codePieces('85A/90A'), ['85a', '90a']);
  assert.deepEqual(codePieces('X1C/P1S'), ['x1c', 'p1s']);
  assert.deepEqual(codePieces('FAP035'), ['fap', '035']);
  assert.deepEqual(codePieces('١٠١٠٢'), ['10102']);
});

test('a code a listed product writes in its own name is not "no exact match" — CR-10, CR10, PA12-CF, TPU95A, 85A/90A, X1C/P1S', async () => {
  const db = limitD1(await spelledShop());
  for (const [q, pid] of [
    ['CR-10', 'p_cr10'],
    ['CR10', 'p_cr10'],
    ['Creality CR-10', 'p_cr10'],
    ['PA12-CF', 'p_pa12'],
    ['TPU95A', 'p_tpu'],
    ['85A/90A', 'p_tpu2'],
    ['X1C/P1S', 'p_x1c'],
  ] as const) {
    for (const typing of [false, true]) {
      const b = await search(db, q, { typing });
      assert.ok(b.products.some((p) => p.id === pid), `${q}${typing ? ' (typing)' : ''}: ${pid} listed — ${b.products.map((p) => p.id).join(' ')}`);
      assert.equal(b.exact_miss, undefined, `${q}${typing ? ' (typing)' : ''}: the listed product carries it`);
    }
  }
  // Pieces that do not occur together are not the code: FAP and 035 apart, or a different number.
  assert.deepEqual((await search(db, 'FAP036')).exact_miss, ['FAP036']);
  assert.deepEqual((await search(db, 'CR-11')).exact_miss, ['CR-11']);
  assert.deepEqual(violations, []);
});

test('a query of nothing but a code keeps the products that write it in their own text, after the exact one; the near matches stay out', async () => {
  const db = limitD1(await spelledShop());
  for (const q of ['FAP035', 'fap-035']) {
    const b = await search(db, q);
    assert.deepEqual(b.exact?.map((h) => h.product_id), ['p_hotend'], q);
    assert.deepEqual(b.products.map((p) => p.id), ['p_hotend', 'p_kit'], `${q}: the exact product, then the kit that names FAP035 — no cutting mat, no FAP-only kit`);
    assert.equal(b.exact_miss, undefined);
  }
  assert.deepEqual(violations, []);
});

test('the whole lane binds far under D1’s 100 parameters, whatever the query holds', async () => {
  const db = limitD1(await codedShop());
  const many = Array.from({ length: 13 }, (_, i) => `FAP${String(100 + i)}`).join(' ');
  const b = await search(db, many);
  assert.equal(b.exact_miss?.length, 12, 'twelve codes looked up at most');
  assert.deepEqual(violations, []);
  assert.ok(maxParams <= 100, `worst statement bound ${maxParams}`);
  // The lane itself: seven, however many codes.
  const raw = await codedShop();
  const counted: number[] = [];
  const spy = {
    prepare: (sql: string) => {
      const st = asD1(raw).prepare(sql);
      return { bind: (...v: unknown[]) => (counted.push(v.length), st.bind(...v)), first: () => st.first(), all: () => st.all() };
    },
  } as unknown as D1Database;
  await resolveIdentifier(spy, many);
  assert.ok(counted.every((n) => n <= 7), `bound ${counted.join(', ')}`);
});

// =========================================================================
// THE WRITERS
// =========================================================================

const identifierSnapshot = (raw: DatabaseSync, pid: string) =>
  (raw.prepare('SELECT key, scope_kind, scope_id, kind, source FROM search_identifiers WHERE product_id = ? ORDER BY key, scope_kind, scope_id').all(pid) as Record<string, unknown>[]).map(
    (r) => ({ ...r })
  );
const hasToken = (raw: DatabaseSync, pid: string, token: string) =>
  !!raw.prepare('SELECT 1 FROM search_tokens WHERE product_id = ? AND token = ?').get(pid, token);

test('one source, both writers: the product save writes the same identifier rows the catch-up wrote, in the same batch', async () => {
  const raw = await codedShop();
  const db = asD1(raw);
  for (const pid of ['p_pla', 'p_grad', 'p_hotend', 'p_x2d', 'p_nozzle']) {
    const before = identifierSnapshot(raw, pid);
    assert.ok(before.length > 0, `${pid} has identifier rows`);
    const doc = parseProductRow(raw.prepare('SELECT * FROM products WHERE id = ?').get(pid) as Record<string, unknown>);
    const plan = await planProductSave(db, { mode: 'update', doc, prev: doc, relations: null, actor: { adminId: 'admin', money: true } });
    raw.prepare('DELETE FROM search_identifiers WHERE product_id = ?').run(pid);
    await db.batch(plan.statements);
    assert.deepEqual(identifierSnapshot(raw, pid), before, pid);
    assert.ok(hasToken(raw, pid, IDENTIFIER_STAMP) && hasToken(raw, pid, INDEX_STAMP), `${pid}: both stamps`);
  }
});

test('a token-only rewrite (a hashtag rename) drops the identifier stamp, and the catch-up writes the rows again', async () => {
  const raw = await codedShop();
  const db = asD1(raw);
  assert.equal((await backfillSearchIndex(db, { limit: 50 })).indexed, 0, 'nothing stale after the first pass');
  // What worker/lib/hashtags.ts does: the documents without identifiers.
  const [row] = raw.prepare(`SELECT ${searchDocColumns()} FROM products WHERE id = 'p_pla'`).all() as Record<string, unknown>[];
  const [doc] = await searchDocsForRows(db, [row]);
  assert.equal(doc.identifiers, undefined);
  await db.batch(planSearchIndex(db, doc));
  assert.ok(hasToken(raw, 'p_pla', INDEX_STAMP) && !hasToken(raw, 'p_pla', IDENTIFIER_STAMP));
  const again = await backfillSearchIndex(db, { limit: 50 });
  assert.equal(again.indexed, 1, 'only PLA Basic is selected');
  assert.ok(hasToken(raw, 'p_pla', IDENTIFIER_STAMP));
  const status = await searchIndexStatus(db);
  assert.equal(status.coverage, 1);
  assert.equal(status.identifiers.installed, true);
  assert.ok(status.identifiers.rows > 0);
});

test('a database without 0206: the save and the catch-up write the tokens alone, and the route answers as before', async () => {
  const raw = dbThrough('0205');
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_identifiers'").get(), undefined);
  const db = asD1(raw);
  raw.prepare(`INSERT INTO products (id, slug, name, description, price_iqd, status) VALUES ('p_hotend', 'p_hotend', 'Hotend Heating Assembly', '', 1000, 'active')`).run();
  raw
    .prepare(`INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value, searchable) VALUES ('p_hotend', 'product', '', 'part_code', 'FAP035', 1)`)
    .run();
  const run = await backfillSearchIndex(db, { limit: 50 });
  assert.equal(run.indexed, 1);
  assert.deepEqual(run.failed, []);
  assert.ok(hasToken(raw, 'p_hotend', INDEX_STAMP) && !hasToken(raw, 'p_hotend', IDENTIFIER_STAMP));
  assert.equal((await backfillSearchIndex(db, { limit: 50 })).indexed, 0, 'not selected again on every pass');
  const doc = parseProductRow(raw.prepare(`SELECT * FROM products WHERE id = 'p_hotend'`).get() as Record<string, unknown>);
  const plan = await planProductSave(db, { mode: 'update', doc, prev: doc, relations: null, actor: { adminId: 'admin', money: true } });
  await db.batch(plan.statements);
  assert.equal(await resolveIdentifier(db, 'FAP035'), null, 'the lane says nothing it cannot know');

  for (const q of ['FAP035 ', '10102 ']) {
    const res = await listing(limitD1(raw), `search=${encodeURIComponent(q)}&limit=50`);
    assert.equal(res.status, 200);
    for (const k of ['exact', 'matched', 'exact_miss']) assert.ok(!(k in res.body), `${q}: ${k}`);
  }
  const found = await listing(limitD1(raw), 'search=FAP035%20&limit=50');
  assert.deepEqual((found.body.products as { id: string }[]).map((p) => p.id), ['p_hotend'], 'the token index still finds it');
});

test('the catalogue import hands its scoped ids to the save: a created product’s colour code names its value at once', () => {
  // The import writer passes `searchExternalIds` (worker/lib/catalogImport/writer.ts step 11); the rows it
  // derives are the rows the catch-up derives from the stored ids — same function, same input.
  const stored = [{ scope_kind: 'option_value', scope_id: 'ov_1', id_type: 'color_code', value: '10101' }];
  const fromImport = identifierRows({ externalIds: stored, options: [{ id: 'ov_1', names: ['Black (10101)'] }] });
  assert.deepEqual(
    fromImport.map((r) => [r.key, r.scope_kind, r.scope_id, r.source]),
    [
      ['10101', 'option_value', 'ov_1', 'external_id'],
    ]
  );
  assert.equal(toSearchDoc({ id: 'x', aliases: ['10101'] }).fields.model?.includes('10101'), true, 'and the alias token is still written');
});
