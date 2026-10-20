/**
 * SEARCH ALIASES — ONE LOADER, BOTH INDEX WRITERS (Bambu import spec §C.1,
 * §G.5; docs/DECISIONS.md row 241).
 *
 * A shopper holding a spool types its colour code «10101»; one holding a
 * spare part types its part code «FAP035»; one shopping for a machine types
 * «H2D» or «H2 Series». None of those words is in an imported product's name
 * or option names: they are rows of migration 0194 (`product_external_ids`
 * with `searchable = 1`, the `identity.model` / `identity.series` spec rows),
 * read by `loadSearchAliases` (worker/lib/search/aliases.ts) and indexed in
 * the `model` field beside the option names.
 *
 * The index has two writers, and a token one writes and the other does not is
 * a product that becomes unfindable the day the other rewrites it. So this
 * file proves, on one imported fixture product that carries every alias kind:
 *
 *   1. saved by the admin form (the two GETs the form issues, through its
 *      transforms, and its POST), the product keeps the colour code, the part
 *      code, the SKU code and the model and series tokens, and `searchProducts`
 *      finds it by each of them;
 *   2. rebuilt by the cron backfill (`backfillSearchIndex` →
 *      `searchDocsForRows`), it gets exactly the rows the form save wrote;
 *   3. what is NOT an alias stays out: an opaque store id (`searchable = 0`),
 *      the `identity.family` facet, an owner-only spec row, another product's
 *      codes;
 *   4. `intent.searchAliases` (the step 6 import writer's way: its own batch
 *      writes the alias rows the planner cannot read yet) replaces the read;
 *   5. a database without 0194 indexes exactly what it did before: no alias,
 *      no failed save, no failed backfill (CLAUDE.md rule 2);
 *   6. the read costs one statement per 90 products under D1's limits (100
 *      bound parameters, 5 compound terms), and the presence probe is asked
 *      once per binding.
 *
 * Run: node --import tsx --test tests/searchAliases.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, dbThrough, freshDb, get, hasColumn, json, OWNER, post, row, stubApp, type App } from './fixtures/app';
import { limitD1, violations } from './fixtures/d1Limits';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire, type RelationsResponse } from '../src/components/adminProducts/form/model';
import { docWithoutLegacyMoney, withoutLegacyMoney } from '../src/components/adminProducts/form/v2/v2Model';
import { backfillSearchIndex, INDEX_STAMP, searchDocsForRows, searchProducts } from '../worker/lib/search/store';
import { ALIAS_IN_CHUNK, aliasReadCount, loadSearchAliases } from '../worker/lib/search/aliases';
import { IDENTIFIER_STAMP } from '../worker/lib/search/identifiers';
import { catalogKnowledgeInstalled, catalogKnowledgeKnown } from '../worker/lib/catalogKnowledge';
import { planProductSave } from '../worker/lib/productPersistence';
import { parseProductRow } from '../worker/lib/productModel';
import { countingD1 } from '../worker/lib/d1Count';

const PID = 'p_imp';
const OTHER = 'p_other';

/** The words of every alias kind the fixture carries, as `tokenize` indexes them. */
const ALIAS_TOKENS = {
  colourCode: '10101',
  partCode: 'fap035',
  skuCode: 'spl9q4', // from the SKU code «A00-W1-1.75-SPL9Q4»
  model: 'h2d',
  series: 'h2',
} as const;

/** Words that must never reach the index from the 0194 rows. */
const NEVER = {
  opaqueStoreId: '6945416380552', // bambu_product_id, searchable = 0
  family: 'zz9family', // identity.family is a facet, not a name
  ownerOnly: 'q7ownermodel', // an owner-visibility identity row
  otherProductsCode: '77777', // another product's colour code
} as const;

/**
 * THE IMPORTED PRODUCT, as the import (§B.10, §C.1–§C.3) leaves it: active,
 * unpriced, no stock anywhere, one colour group whose two values carry no code
 * in their names, one variant per value, a created `product_source_refs` row
 * still `not_configured`, and the 0194 rows the aliases come from.
 *
 * Its own names hold none of the alias words, so every alias token the index
 * holds can only have come through the loader.
 */
function seedImported(raw: DatabaseSync, withKnowledge = true): void {
  raw.exec(`
    INSERT INTO brands (id, slug, name_ar, name_en, name_ckb) VALUES ('brd_bambu', 'bambu-lab', 'بامبو لاب', 'Bambu Lab', 'بامبو لاب');
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, brand_id, category_id, sub_category_id, template_family, inventory_mode)
      VALUES ('${PID}', 'textured-plate-kit', 'Textured Plate Kit', 'Textured Plate Kit', 'Textured Plate Kit', 'active',
              'brd_bambu', 'cat_maint', 'cat_maint_plate', 'devices', 'VARIANT_COMBINATION');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_imp_col', '${PID}', 'Color', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, variant_key, variant_label)
      VALUES ('v_imp_white', '${PID}', 'g_imp_col', 'Jade White', 0, 1, 'bv-white', 'Jade White'),
             ('v_imp_black', '${PID}', 'g_imp_col', 'Charcoal', 1, 1, 'bv-black', 'Charcoal');
    INSERT INTO product_variants (id, product_id, combo_key, active)
      VALUES ('x_imp_white', '${PID}', 'o:v_imp_white', 1),
             ('x_imp_black', '${PID}', 'o:v_imp_black', 1);
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, inventory_mode)
      VALUES ('${OTHER}', 'other-product', 'Other Product', 'منتج آخر', 'بەرهەمی تر', 'active', 'BASE');
  `);
  // 0194's group labels and kind, where the database has them.
  if (hasColumn(raw, 'product_option_groups', 'kind')) {
    raw.exec("UPDATE product_option_groups SET name_ar = 'اللون', name_ckb = 'ڕەنگ', kind = 'color' WHERE id = 'g_imp_col'");
  }
  if (!withKnowledge) return;
  raw.exec(`
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, match_kind, stock_decision,
                                     fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', '${NEVER.opaqueStoreId}', '${PID}', 'textured-plate-kit', 'https://store.example/products/textured-plate-kit',
              'created', 'not_configured', 'fp', '2026-10-15T00:00:00Z', 'run_1');
    INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value, searchable) VALUES
      ('${PID}', 'option_value', 'v_imp_white', 'color_code', '${ALIAS_TOKENS.colourCode}', 1),
      ('${PID}', 'product', '', 'part_code', 'FAP035', 1),
      ('${PID}', 'variant', 'x_imp_white', 'bambu_sku_code', 'A00-W1-1.75-SPL9Q4', 1),
      ('${PID}', 'product', '', 'bambu_product_id', '${NEVER.opaqueStoreId}', 0),
      ('${PID}', 'variant', 'x_imp_white', 'bambu_variant_id', '40475106640008', 0),
      ('${OTHER}', 'product', '', 'color_code', '${NEVER.otherProductsCode}', 1);
    INSERT INTO product_spec_values (id, product_id, canonical_key, group_key, data_type, value_text, status, confidence, source_kind, source_ref, visibility)
      VALUES ('psv_model', '${PID}', 'identity.model', 'identity', 'string', 'H2D', 'verified', 'official_page', 'store_page', 'https://store.example/p', 'public'),
             ('psv_series', '${PID}', 'identity.series', 'identity', 'string', 'H2 Series', 'verified', 'official_page', 'store_page', 'https://store.example/p', 'public'),
             ('psv_family', '${PID}', 'identity.family', 'identity', 'string', '${NEVER.family}', 'verified', 'official_page', 'store_page', 'https://store.example/p', 'public'),
             ('psv_owner', '${OTHER}', 'identity.model', 'identity', 'string', '${NEVER.ownerOnly}', 'verified', 'official_page', 'store_page', 'https://store.example/q', 'owner'),
             ('psv_unknown', '${OTHER}', 'identity.series', 'identity', 'string', '', 'unknown', 'derived', 'derived', '', 'public');
  `);
}

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
};

function world(through: string | null = null, withKnowledge = true) {
  const raw = through === null ? freshDb() : dbThrough(through);
  raw.exec("INSERT INTO users (id, name, email, password_hash, role) VALUES ('usr_owner', 'Owner', 'boss@x.co', 'h', 'admin')");
  seedImported(raw, withKnowledge);
  return { raw, app: stubApp(asD1(raw), OWNER, mount) };
}

/**
 * THE OWNER OPENS THE PRODUCT, ENTERS ITS STOCK AND PRESSES SAVE: exactly the
 * two GETs the form issues, through exactly its transforms, and the body
 * `ProductForm.save` posts (the document without its derived copies, no dinar
 * money key).
 *
 * The stock is the owner's, typed in the form: an imported product's models
 * sell direct by the form's default, and the form (and the server) refuse to
 * save a direct-sale model with no shelf number — the first edit of an
 * imported product with options is always one that enters it.
 */
async function saveThroughForm(a: App, id: string): Promise<void> {
  const p = await json(await get(a, `/api/admin/products-v2/${id}`));
  const r = await json(await get(a, `/api/admin/products/${id}/relations`));
  assert.equal(p.success, true, JSON.stringify(p));
  const doc = toEditorDoc(p.product) as unknown as Record<string, unknown>;
  const hydrated = hydrateRelations(r as unknown as RelationsResponse, p.product);
  const rel = { ...hydrated, variants: hydrated.variants.map((v) => ({ ...v, stock: v.stock ?? 4 })) };
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o;
  void _c;
  void _m;
  const res = await post(a, '/api/admin/products-v2', {
    ...docWithoutLegacyMoney(docFields),
    relations: withoutLegacyMoney(relationsToWire(rel)),
    expected_updated_at: p.product.updated_at,
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
}

const tokensOf = (raw: DatabaseSync, id: string) =>
  all<{ token: string; weight: number }>(raw, 'SELECT token, weight FROM search_tokens WHERE product_id = ? ORDER BY token', id);

const tokenSet = (raw: DatabaseSync, id: string) => new Set(tokensOf(raw, id).map((t) => t.token));

const found = async (raw: DatabaseSync, q: string) => (await searchProducts(asD1(raw), q)).ids;

test('saved by the admin form, an imported product keeps its colour code, part code, SKU code, model and series — and is found by each', async () => {
  const { raw, app } = world();
  await saveThroughForm(app, PID);

  const rows = tokensOf(raw, PID);
  const weight = new Map(rows.map((t) => [t.token, t.weight]));
  for (const [kind, token] of Object.entries(ALIAS_TOKENS)) {
    assert.equal(weight.get(token), 6, `the ${kind} «${token}» is indexed at the model field's weight (6), beside the option names`);
  }
  assert.equal(weight.get('jade'), 6, 'the option names are still there, at the same weight');
  assert.ok(weight.has(INDEX_STAMP), 'stamped by the current builder');
  for (const [kind, token] of Object.entries(NEVER)) assert.ok(!weight.has(token), `the ${kind} «${token}» is not a search word of this product`);

  for (const q of ['10101', 'FAP035', 'fap035', 'H2D', 'H2 Series', 'A00-W1-1.75-SPL9Q4', 'SPL9Q4']) {
    assert.deepEqual(await found(raw, q), [PID], `a shopper typing «${q}» finds the imported product`);
  }
  for (const q of [NEVER.opaqueStoreId, NEVER.family, NEVER.ownerOnly]) {
    assert.deepEqual(await found(raw, q), [], `«${q}» finds nothing: it is not an alias`);
  }
});

test('rebuilt by the cron backfill, the same product gets exactly the rows the form save wrote', async () => {
  const { raw, app } = world();
  await saveThroughForm(app, PID);
  const saved = tokensOf(raw, PID);
  assert.ok(saved.some((t) => t.token === ALIAS_TOKENS.partCode), 'precondition: the save indexed the aliases');

  // The stamp bump's effect: every product is stale and the backfill rewrites it.
  raw.exec('DELETE FROM search_tokens');
  const run = await backfillSearchIndex(asD1(raw), { limit: 50 });
  assert.deepEqual(run.failed, [], 'the backfill wrote every product');
  assert.deepEqual(tokensOf(raw, PID), saved, 'one loader, both writers: the backfilled rows ARE the saved rows');
  for (const q of ['10101', 'FAP035', 'H2D']) assert.deepEqual(await found(raw, q), [PID], `«${q}» still finds it after the backfill`);
  assert.ok(tokenSet(raw, OTHER).has(INDEX_STAMP), 'the other product was backfilled too');
  assert.ok(tokenSet(raw, OTHER).has(NEVER.otherProductsCode), "the other product's own colour code is ITS alias");
  assert.ok(!tokenSet(raw, OTHER).has(NEVER.ownerOnly), 'its owner-only identity row is not');
});

test('the loader: distinct, trimmed, sorted aliases per product; public identity model and series only; searchable ids only', async () => {
  const { raw } = world();
  raw.exec(`
    INSERT INTO product_external_ids (product_id, scope_kind, scope_id, id_type, value, searchable)
      VALUES ('${PID}', 'option_value', 'v_imp_black', 'color_code', '  10101 ', 1);
  `);
  const map = await loadSearchAliases(asD1(raw), [PID, OTHER, PID, 'p_missing', '']);
  assert.deepEqual(map.get(PID), ['10101', 'A00-W1-1.75-SPL9Q4', 'FAP035', 'H2 Series', 'H2D'], 'the same code on two values is one alias');
  assert.deepEqual(map.get(OTHER), [NEVER.otherProductsCode], 'the owner-only row and the empty unknown row are not aliases');
  assert.equal(map.has('p_missing'), false, 'a product with no alias is absent from the map');
  assert.deepEqual([...(await loadSearchAliases(asD1(raw), [])).entries()], [], 'no product, no read');
});

test('intent.searchAliases replaces the read: the import writer indexes the aliases its own batch is about to write', async () => {
  const { raw } = world();
  const db = asD1(raw);
  const stored = parseProductRow(row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', PID)!);
  const plan = await planProductSave(db, {
    mode: 'update',
    doc: stored,
    prev: stored,
    relations: null,
    actor: { adminId: 'usr_owner', money: false },
    searchAliases: ['ZX9-77'],
  });
  await db.batch(plan.statements);
  const tokens = tokenSet(raw, PID);
  assert.ok(tokens.has('zx9'), 'the explicit alias is indexed');
  assert.ok(!tokens.has(ALIAS_TOKENS.partCode), 'and the stored rows were not read in its place');

  // Undefined — every ordinary writer — means "read the stored rows".
  const again = await planProductSave(db, { mode: 'update', doc: stored, prev: stored, relations: null, actor: { adminId: 'usr_owner', money: false } });
  await db.batch(again.statements);
  assert.ok(tokenSet(raw, PID).has(ALIAS_TOKENS.partCode), 'without the intent, the loader supplies them');
});

test('a database without migration 0194 indexes exactly what it did before: no alias, no failure, on both writers', async () => {
  const { raw, app } = world('0193', false);
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'product_external_ids'")!.n, 0, 'precondition: no 0194');
  const db = asD1(raw);
  assert.equal(await catalogKnowledgeInstalled(db), false);
  assert.deepEqual([...(await loadSearchAliases(db, [PID, OTHER])).entries()], [], 'an empty map, not an error');

  await saveThroughForm(app, PID);
  const saved = tokensOf(raw, PID);
  assert.ok(saved.some((t) => t.token === 'jade'), 'the save indexed the product as before');
  assert.ok(!saved.some((t) => t.token === ALIAS_TOKENS.colourCode), 'and nothing else');

  raw.exec('DELETE FROM search_tokens');
  const run = await backfillSearchIndex(db, { limit: 50 });
  assert.deepEqual(run.failed, [], 'the backfill does not fail on the missing tables');
  assert.deepEqual(tokensOf(raw, PID), saved, 'and writes the same rows');

  // The document is today's document: the rows a 0194 database writes for the
  // same product WITHOUT any alias row are the rows written here.
  // (A current database also has migration 0206, whose identifier stamp rides beside the tokens: not a token.)
  const withTables = world(null, false);
  await saveThroughForm(withTables.app, PID);
  assert.deepEqual(
    tokensOf(withTables.raw, PID).filter((t) => t.token !== IDENTIFIER_STAMP),
    saved,
    'no alias rows and no 0194 tables index the same product the same way'
  );
});

test('one statement per 90 products, inside D1 limits; the presence probe is asked once per binding', async () => {
  const raw = freshDb();
  const ids: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const id = `p_bulk_${String(i).padStart(3, '0')}`;
    ids.push(id);
    values.push(`('${id}', 'bulk-${i}', 'Bulk ${i}', 'active')`);
  }
  raw.exec(`INSERT INTO products (id, slug, name, status) VALUES ${values.join(',')}`);
  raw.exec(
    `INSERT INTO product_external_ids (product_id, id_type, value) VALUES ${ids.map((id, i) => `('${id}', 'part_code', 'PC${i}')`).join(',')}`
  );
  assert.equal(aliasReadCount(ids), 3);
  assert.equal(aliasReadCount([...ids, ...ids, '']), 3, 'counted over distinct ids');
  assert.equal(ALIAS_IN_CHUNK, 90);

  const before = violations.length;
  const counted = countingD1(limitD1(raw));
  const start = counted.executed;
  const map = await loadSearchAliases(counted.db, ids);
  assert.equal(violations.length, before, 'no statement crossed a D1 limit');
  assert.equal(map.size, 200);
  assert.deepEqual(map.get('p_bulk_199'), ['PC199']);
  assert.equal(counted.executed - start, 1 + 3, 'the probe, then one read per 90 products');
  assert.equal(catalogKnowledgeKnown(counted.db), true, 'remembered for the binding');

  const again = counted.executed;
  await loadSearchAliases(counted.db, ids.slice(0, 10));
  assert.equal(counted.executed - again, 1, 'asked once: the next load is its read alone');
  await loadSearchAliases(counted.db, ids.slice(0, 10), { installed: false });
  assert.equal(counted.executed - again, 1, 'a caller that knows 0194 is absent sends nothing');
});

test('searchDocsForRows carries the aliases into the document the backfill writes', async () => {
  const { raw } = world();
  const rows = all<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id IN (?, ?) ORDER BY id', PID, OTHER);
  const docs = await searchDocsForRows(asD1(raw), rows);
  const model = (id: string, d = docs) => d.find((x) => x.productId === id)!.fields.model ?? [];
  assert.deepEqual(model(PID), ['10101', 'A00-W1-1.75-SPL9Q4', 'FAP035', 'H2 Series', 'H2D'], 'the aliases, sorted, in the model field');
  assert.deepEqual(model(OTHER), [NEVER.otherProductsCode]);
  const skipped = await searchDocsForRows(asD1(raw), rows, { aliasesInstalled: false });
  assert.deepEqual(model(PID, skipped), [], 'a caller that knows 0194 is absent reads nothing');
});
