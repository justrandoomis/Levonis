/**
 * THE CATALOGUE IMPORT'S WRITER (Bambu import spec §A.4, §A.5, §A.6, §B.6,
 * §B.8, §B.10, §C.2–§C.10, §E.2–§E.4; worker/lib/catalogImport/writer.ts),
 * through LimitD1 (D1's 100-parameter and 5-term limits) and every real
 * migration on node:sqlite, with the step-4 fixtures built by the real package:
 *
 *   - create: the product at its defaults, the 0194 group columns, `bv-` keys,
 *     the source row with stock_decision 'not_configured', every side table, the
 *     fenced event and the checkpoint, the guard row gone, the money probe true;
 *   - H2D's `Standard` / `standard` values both written, with distinct keys;
 *   - merge into a V2-published product: fingerprints before = after, the V2
 *     results byte-identical, still published, images appended through the value
 *     map, an empty sub-category filled, a non-empty category kept;
 *   - a colour-model merge: images bound by color_id, product_colors untouched;
 *   - the fences: a lost lease, an item not WRITING, a changed payload, a lease
 *     that lapses between the plan and the batch — nothing written;
 *   - the guard triggers: a money write in the batch aborts it whole;
 *   - incoming relations resolve at the target's own write, with printer fits;
 *   - the budget: pla-basic-filament under 900 with margin; PLAN_TOO_LARGE when
 *     the invocation has already spent its share; every statement ≤ 100 params.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxParams, violations } from './fixtures/d1Limits';
import { asD1, dbThrough } from './fixtures/app';
import {
  buildFor,
  complete,
  count,
  LEASE,
  newWorld,
  plan,
  RUN_ID,
  setWriting,
  stage,
  write,
  type World,
} from './fixtures/catalogImportWorld';
import { sample } from './fixtures/bambu/load';
import { publishV2, isV2Published } from './fixtures/v2Publish';
import { planProductSave, saveProductAtomic } from '../worker/lib/productPersistence';
import { validateProductDoc } from '../worker/lib/productModel';
import { importWriteContext, ImportWriteRefused, planImportWrite, runImportWrite, IMPORT_ACTOR } from '../worker/lib/catalogImport/writer';
import { IMPORT_INVOCATION_LIMIT } from '../worker/lib/catalogImport/budget';
import { IMPORT_GUARD_ID } from '../worker/lib/catalogImport/protectedTables';
import { payloadSha256, parseReviewedBundle, emptyReviewedTexts, resolveTaxonomy } from '../worker/lib/catalogImport/reviewed';
import { INDEX_STAMP } from '../worker/lib/search/store';

const one = <T = Record<string, unknown>>(w: World, sql: string, ...p: unknown[]) => ({ ...(w.raw.prepare(sql).get(...(p as never[])) as object) }) as T;
const rows = <T = Record<string, unknown>>(w: World, sql: string, ...p: unknown[]) => (w.raw.prepare(sql).all(...(p as never[])) as object[]).map((r) => ({ ...r })) as T[];

async function refused(fn: () => Promise<unknown>, code: string): Promise<ImportWriteRefused> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof ImportWriteRefused, `expected ImportWriteRefused ${code}, got ${(e as Error)?.message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected ${code}`);
}

const nothingWritten = (w: World, productId: string) => {
  for (const t of ['products', 'product_option_groups', 'product_images', 'product_source_refs', 'product_spec_values', 'product_relations', 'product_external_ids', 'product_documents']) {
    assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'products' ? 'id' : 'product_id'} = ?`, productId), 0, `${t} untouched`);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards WHERE id = ?', IMPORT_GUARD_ID), 0, 'no guard row left behind');
};

test('a create writes the product from defaults, every side table, the fenced event and the checkpoint', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  const { plan: p, result } = await write(w, s);
  const pid = s.payload.product_id;
  assert.equal(result.created, true);
  assert.equal(result.after_money_default, true, 'the money probe inside the batch');
  assert.equal(result.before_fp_equal, null);
  // The product row: defaults, active, the map's sections, the brand.
  const prod = one(w, 'SELECT * FROM products WHERE id = ?', pid);
  assert.equal(prod.status, 'active');
  assert.equal(prod.price_iqd, 0);
  for (const k of ['prime_price_iqd', 'pro_price_iqd', 'original_price_iqd', 'product_cost_iqd', 'stock', 'low_stock_threshold', 'net_weight_g', 'package_weight_g', 'package_width_mm']) assert.equal(prod[k], null, k);
  assert.equal(prod.name, s.payload.product.title_en);
  assert.equal(prod.name_ar, s.payload.product.title_en, '§1 row 15: the English name in every language');
  assert.equal(prod.name_ku, s.payload.product.title_en);
  assert.equal(prod.brand_id, 'brd_bambu');
  assert.equal(prod.slug, 'ams-2-pro-feeder-unit');
  assert.equal(prod.warranty_plans, '[]');
  assert.equal(prod.ops_policy, '{}');
  assert.equal(prod.inventory_mode, 'VARIANT_COMBINATION');
  // Groups with their 0194 columns; values with bv- keys.
  const g = s.payload.groups[0];
  assert.deepEqual(one(w, 'SELECT name_en, name_ar, name_ckb, kind, default_value_id FROM product_option_groups WHERE id = ?', g.id), {
    name_en: g.name_en,
    name_ar: g.name_ar,
    name_ckb: g.name_ckb,
    kind: g.kind,
    default_value_id: g.default_value_id,
  });
  for (const v of rows<{ variant_key: string; regular_price_iqd: number | null; stock: number | null }>(w, 'SELECT variant_key, regular_price_iqd, stock FROM product_option_values WHERE product_id = ?', pid)) {
    assert.match(v.variant_key, /^bv-[0-9a-f]{24}$/);
    assert.equal(v.regular_price_iqd, null);
    assert.equal(v.stock, null);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ? AND regular_price_iqd IS NULL AND stock IS NULL', pid), s.payload.variants.length);
  // Where it came from, and its stock decision (§B.10).
  assert.deepEqual(one(w, 'SELECT match_kind, stock_decision, source_handle, fingerprint, import_run_id FROM product_source_refs WHERE product_id = ?', pid), {
    match_kind: 'created',
    stock_decision: 'not_configured',
    source_handle: s.payload.handle,
    fingerprint: s.payload.extraction_sha256,
    import_run_id: RUN_ID,
  });
  // Option source refs: groups, values, variants, every image row with its binding rule.
  const refs = rows<{ kind: string; binding_rule: string; via_variant_id: string }>(w, 'SELECT kind, binding_rule, via_variant_id FROM product_option_source_refs WHERE product_id = ?', pid);
  assert.equal(refs.filter((r) => r.kind === 'image').length, count(w.raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', pid));
  assert.ok(refs.filter((r) => r.kind === 'image').every((r) => r.binding_rule !== ''));
  // Specs, external ids, relations (pending on the AMS 2 Pro, not yet written), conflicts from the notes.
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_spec_values WHERE product_id = ?', pid), p.counts.specs);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_spec_values WHERE product_id = ? AND status = 'verified' AND source_ref = ''", pid), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_external_ids WHERE product_id = ? AND id_type = 'bambu_product_id' AND searchable = 0", pid), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_relations WHERE product_id = ? AND state = 'pending' AND target_source_handle = 'ams-2-pro'", pid), 2);
  assert.ok(count(w.raw, 'SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE item_id = ?', s.itemId) >= 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE detail <> ''"), 0, 'never a free-text detail');
  // Translations: every row review_needed.
  assert.ok(count(w.raw, 'SELECT COUNT(*) AS n FROM product_translations WHERE product_id = ?', pid) > 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_translations WHERE product_id = ? AND status <> 'review_needed'", pid), 0);
  // Search: the stamp and the aliases the batch itself wrote.
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM search_tokens WHERE product_id = ? AND token = ?', pid, INDEX_STAMP), 1);
  // The event and the checkpoint.
  assert.deepEqual(one(w, "SELECT stage, outcome, code, lease_token FROM catalog_import_events WHERE item_id = ? AND stage = 'WRITTEN'", s.itemId), {
    stage: 'WRITTEN',
    outcome: 'ok',
    code: 'created',
    lease_token: LEASE,
  });
  const item = one<{ processing_state: string; last_completed_stage: string; levonis_product_id: string; slug: string; match_kind: string; stage_data: string }>(
    w,
    'SELECT processing_state, last_completed_stage, levonis_product_id, slug, match_kind, stage_data FROM catalog_import_items WHERE id = ?',
    s.itemId
  );
  assert.deepEqual({ ...item, stage_data: undefined }, { processing_state: 'PUBLISHING', last_completed_stage: 'WRITING', levonis_product_id: pid, slug: 'ams-2-pro-feeder-unit', match_kind: 'created', stage_data: undefined });
  assert.equal(JSON.parse(item.stage_data).written.images, p.counts.images);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM ops_guards WHERE id = ?', IMPORT_GUARD_ID), 0, 'the guard row is gone');
  // The audit row of the system actor.
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'catalog_import.write' AND actor_id = ?", IMPORT_ACTOR.adminId), 1);
  assert.deepEqual(violations, [], 'LimitD1: no statement over 100 parameters or 5 compound terms');
});

test('H2D: the case-only duplicate values Standard / standard are both written, with distinct bv- keys', async () => {
  const w = newWorld();
  const s = stage(w, 'h2d');
  await write(w, s);
  const vals = rows<{ name_en: string; variant_key: string }>(w, "SELECT name_en, variant_key FROM product_option_values WHERE product_id = ? AND lower(name_en) = 'standard'", s.payload.product_id);
  assert.equal(vals.length, 2);
  assert.notEqual(vals[0].variant_key, vals[1].variant_key);
  assert.deepEqual(vals.map((v) => v.name_en).sort(), ['Standard', 'standard']);
  // The us_110v rows are never verified; the group of the printer is a version group.
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_spec_values WHERE product_id = ? AND region = 'us_110v' AND status = 'verified'", s.payload.product_id), 0);
});

test('PLA Basic: colour swatches, SKU codes and colour codes as searchable external ids, the alias tokens indexed', async () => {
  const w = newWorld();
  const s = stage(w, 'pla-basic-filament');
  const { plan: p } = await write(w, s);
  const pid = s.payload.product_id;
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_option_value_swatches WHERE product_id = ?', pid), s.payload.swatches.length);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_option_value_swatches WHERE product_id = ? AND url = '/files/' || r2_key", pid), s.payload.swatches.length);
  assert.ok(count(w.raw, "SELECT COUNT(*) AS n FROM product_external_ids WHERE product_id = ? AND id_type = 'bambu_sku_code' AND searchable = 1", pid) >= 40);
  assert.ok(count(w.raw, "SELECT COUNT(*) AS n FROM product_external_ids WHERE product_id = ? AND id_type = 'color_code' AND searchable = 1", pid) >= 25);
  assert.ok(p.searchAliases.includes('10100'), 'a colour code is an alias');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM search_tokens WHERE product_id = ? AND token = '10100'", pid), 1, 'and a search token, written in the same batch');
  // A representative image row records its source variant (0194's CHECK pairs them).
  assert.ok(count(w.raw, "SELECT COUNT(*) AS n FROM product_option_source_refs WHERE product_id = ? AND binding_rule = 'representative' AND via_variant_id <> ''", pid) > 0);
});

// ---------------------------------------------------------------- merges (§E.2–§E.4)

async function existingA1(w: World): Promise<void> {
  w.raw.exec("INSERT OR IGNORE INTO users (id, name, email, password_hash, role) VALUES ('usr_owner', 'O', 'o@x.co', 'h', 'admin')");
  const db = asD1(w.raw);
  const doc = validateProductDoc({ id: 'p_a1old', slug: 'bambu-lab-a1', name_en: 'Bambu Lab A1', name_ar: 'بامبو A1', name_ckb: 'بامبو A1 (کوردی)', price_iqd: 0, status: 'active', category_id: 'cat_printers', brand_id: 'brd_bambu', description_en: 'Our own description.' });
  const plan0 = await planProductSave(db, {
    mode: 'create',
    doc,
    prev: null,
    relations: {
      inventory_mode: 'VARIANT_COMBINATION',
      groups: [{ id: 'g_model', name_en: 'Model', sort: 0, values: [{ id: 'v_std', name_en: 'A1', sort: 0 }, { id: 'v_combo', name_en: 'A1 Combo', sort: 1 }] }],
      colors: [],
      variants: [
        { id: 'x_std', option_value_ids: ['v_std'], stock: 4 },
        { id: 'x_combo', option_value_ids: ['v_combo'], stock: 2 },
      ],
      images: [],
    },
    catalogIds: ['cat_printers'],
    actor: { adminId: 'usr_owner', money: true },
  });
  await saveProductAtomic(db, plan0);
  await publishV2(w.raw, 'p_a1old');
}

const a1Match = (extra: Record<string, unknown> = {}) => {
  const x = sample('a1');
  return {
    source_product_id: x.sourceProductId,
    source_handle: x.handle,
    levonis_product_id: 'p_a1old',
    levonis_slug: 'bambu-lab-a1',
    decision: 'merge',
    value_map: { '579550514255634444': { option_value_ids: ['v_std'] }, '579550514255634440': { option_value_ids: ['v_combo'] } },
    unmapped_variants: ['776210262809161737'],
    reason: 'same_model',
    reviewed_by: 'test',
    reviewed_at: '2026-10-15',
    ...extra,
  };
};

test('a merge into a V2-published product: protected fingerprints equal, V2 results byte-identical, images appended by the value map', async () => {
  const w = newWorld();
  await existingA1(w);
  w.matches.push(a1Match());
  const v2Before = rows(w, 'SELECT * FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel', 'p_a1old');
  const stateBefore = one(w, 'SELECT * FROM product_pricing_state WHERE product_id = ?', 'p_a1old');
  const structure = () => ({
    values: rows(w, 'SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id', 'p_a1old'),
    variants: rows(w, 'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', 'p_a1old'),
    groups: rows(w, 'SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY id', 'p_a1old'),
  });
  const before = structure();
  const s = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1old' });
  const { result } = await write(w, s);
  assert.equal(result.merged, true);
  assert.equal(result.before_fp_equal, true, 'every protected table read the same before and after, in the same transaction');
  assert.deepEqual(rows(w, 'SELECT * FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel', 'p_a1old'), v2Before, 'V2 results byte-identical');
  assert.deepEqual(one(w, 'SELECT * FROM product_pricing_state WHERE product_id = ?', 'p_a1old'), stateBefore, 'no "stale" queue state');
  assert.equal(isV2Published(w.raw, 'p_a1old'), true);
  assert.deepEqual(structure(), before, 'no group, value or variant added, removed or renamed');
  // Names and the non-empty description are the owner's; the empty sub-category is filled, the category kept.
  const prod = one(w, 'SELECT name, name_ar, name_ku, description, category_id, sub_category_id, status FROM products WHERE id = ?', 'p_a1old');
  assert.deepEqual(prod, { name: 'Bambu Lab A1', name_ar: 'بامبو A1', name_ku: 'بامبو A1 (کوردی)', description: 'Our own description.', category_id: 'cat_printers', sub_category_id: 'cat_printers_fdm', status: 'active' });
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE kind = 'category_filled' AND field = 'sub_category_id'"), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE kind = 'variant_not_merged' AND field = '776210262809161737'"), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE kind = 'field_kept_existing' AND field = 'description'"), 1);
  // Images: appended, bound only through the value map; the first becomes the primary (there was none).
  const imgs = rows<{ option_value_id: string | null; variant_id: string | null; is_primary: number }>(w, 'SELECT option_value_id, variant_id, is_primary FROM product_images WHERE product_id = ?', 'p_a1old');
  assert.ok(imgs.length > 0);
  assert.equal(imgs.filter((i) => i.is_primary === 1).length, 1);
  for (const i of imgs) {
    if (i.option_value_id) assert.ok(['v_std', 'v_combo'].includes(i.option_value_id));
    if (i.variant_id) assert.ok(['x_std', 'x_combo'].includes(i.variant_id));
  }
  assert.ok(imgs.some((i) => i.variant_id === 'x_std') && imgs.some((i) => i.option_value_id === 'v_combo'));
  // The source row of a merge: never gated (§B.10).
  assert.equal(one(w, 'SELECT stock_decision FROM product_source_refs WHERE product_id = ?', 'p_a1old').stock_decision, 'not_required');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_protected WHERE phase = 'write' AND subject = 'p_a1old'"), 1, 'the write digest, stored');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_option_source_refs WHERE product_id = 'p_a1old' AND kind = 'value' AND levonis_id IN ('v_std','v_combo')"), 2);
  assert.deepEqual(violations, []);
});

test('a colour-model merge binds colour images by color_id and leaves product_colors untouched', async () => {
  const w = newWorld();
  const x = sample('pla-basic-filament');
  // An existing PLA sold by colour: two product_colors rows, no option group.
  w.raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, inventory_mode, category_id, sub_category_id, options, colors, images)
      VALUES ('p_pla', 'pla-basic', 'PLA Basic', 'PLA Basic', 'PLA Basic', 'active', 25000, 'COLOR', 'cat_materials', NULL, '[]', '[]', '[]');
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock, regular_price_iqd)
      VALUES ('c_white', 'p_pla', 'Jade White', 'أبيض', 'سپی', '#F0F0F0', 0, 1, 7, 25000),
             ('c_black', 'p_pla', 'Black', 'أسود', 'ڕەش', '#000000', 1, 1, 3, 25000);
  `);
  const built = buildFor(w, 'pla-basic-filament', { writeMode: 'merge', mergeProductId: 'p_pla' });
  const white = built.payload.groups[0].values.find((v) => /^Jade White/.test(v.name_en))!;
  const black = built.payload.groups[0].values.find((v) => /^Black/.test(v.name_en))!;
  const map: Record<string, { color_id: string }> = {};
  for (const v of built.payload.variants) {
    if (v.value_ids.includes(white.id)) map[v.source_id] = { color_id: 'c_white' };
    if (v.value_ids.includes(black.id)) map[v.source_id] = { color_id: 'c_black' };
  }
  w.matches.push({ source_product_id: x.sourceProductId, source_handle: x.handle, levonis_product_id: 'p_pla', decision: 'merge', value_map: map, reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  const colours = rows(w, 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY id', 'p_pla');
  const s = stage(w, 'pla-basic-filament', { writeMode: 'merge', mergeProductId: 'p_pla' });
  const { result } = await write(w, s);
  assert.equal(result.before_fp_equal, true);
  assert.deepEqual(rows(w, 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY id', 'p_pla'), colours, 'product_colors unchanged, hex included');
  const bound = rows<{ color_id: string }>(w, 'SELECT color_id FROM product_images WHERE product_id = ? AND color_id IS NOT NULL', 'p_pla');
  assert.ok(bound.some((b) => b.color_id === 'c_white') && bound.some((b) => b.color_id === 'c_black'), 'colour images bound by color_id');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id = 'p_pla' AND option_value_id IS NOT NULL"), 0, 'no binding to a value the product does not have');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_option_value_swatches WHERE product_id = 'p_pla'"), 0, 'no swatch for a product_colors colour');
  assert.equal(one(w, 'SELECT sub_category_id FROM products WHERE id = ?', 'p_pla').sub_category_id, 'cat_bi_pla', 'the empty sub-category filled from the map');
  assert.equal(one(w, 'SELECT category_id FROM products WHERE id = ?', 'p_pla').category_id, 'cat_materials', 'the non-empty one untouched');
});

test('a merge into a hidden product needs merge_publish; merge_publish publishes it; a legacy-only structure is refused', async () => {
  const w = newWorld();
  await existingA1(w);
  w.raw.exec("UPDATE products SET status = 'hidden' WHERE id = 'p_a1old'");
  w.matches.push(a1Match());
  const s = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1old' });
  await refused(() => write(w, s), 'OWNER_HIDDEN');
  w.matches[0] = a1Match({ decision: 'merge_publish', approval_ref: 'DECISIONS row 242' });
  const s2 = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1old' });
  await write(w, s2);
  assert.equal(one(w, 'SELECT status FROM products WHERE id = ?', 'p_a1old').status, 'active');

  const w2 = newWorld();
  w2.raw.exec(`INSERT INTO products (id, slug, name, status, price_iqd, options, colors, images)
    VALUES ('p_legacy', 'legacy', 'A1', 'active', 0, '[{"id":"o1","name_en":"A1","regular_price_iqd":null}]', '[]', '[]')`);
  w2.matches.push(a1Match({ levonis_product_id: 'p_legacy' }));
  const s3 = stage(w2, 'a1', { writeMode: 'merge', mergeProductId: 'p_legacy' });
  const e = await refused(() => write(w2, s3), 'IMPORT_REVIEWED_SCOPE_REFUSED');
  assert.equal(e.reason, 'merge_target_legacy_structure');
});

// ---------------------------------------------------------------- the fences (§A.5)

test('the fences: a lost lease, an item not WRITING, a changed payload, a lease lapsing before the batch — nothing written', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  const pid = s.payload.product_id;
  await refused(() => plan(w, s, { lease: 'lease_someone_else' }), 'IMPORT_LEASE_LOST');
  w.raw.prepare("UPDATE catalog_import_items SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(s.itemId);
  await refused(() => plan(w, s), 'IMPORT_LEASE_LOST');
  setWriting(w, s.itemId, s.payload);
  // A payload that differs from the staged one.
  const changed = structuredClone(s.payload);
  changed.product.title_en = `${changed.product.title_en} (v2)`;
  await refused(() => plan(w, s, { payload: changed }), 'IMPORT_NOT_STAGED');
  // Planned under a live lease, then the lease lapses: the guard row's fence aborts the whole batch.
  const { plan: p, ctx } = await plan(w, s);
  w.raw.prepare("UPDATE catalog_import_items SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(s.itemId);
  await refused(() => runImportWrite(ctx, p), 'IMPORT_ITEM_CHANGED');
  nothingWritten(w, pid);
  // Planned, then another executor takes the lease: same.
  setWriting(w, s.itemId, s.payload);
  const again = await plan(w, s);
  w.raw.prepare("UPDATE catalog_import_items SET lease_token = 'lease_new_executor' WHERE id = ?").run(s.itemId);
  await refused(() => runImportWrite(again.ctx, again.plan), 'IMPORT_ITEM_CHANGED');
  nothingWritten(w, pid);
  // The trigger fence alone (the guard row's condition dropped): trg_cie_lease_fence refuses the WRITTEN event.
  setWriting(w, s.itemId, s.payload);
  const third = await plan(w, s);
  third.plan.statements[0] = w.db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(IMPORT_GUARD_ID);
  w.raw.prepare("UPDATE catalog_import_items SET lease_token = 'lease_new_executor' WHERE id = ?").run(s.itemId);
  await refused(() => runImportWrite(third.ctx, third.plan), 'IMPORT_LEASE_LOST');
  nothingWritten(w, pid);
  // An item not at WRITING is refused before anything is planned.
  w.raw.prepare("UPDATE catalog_import_items SET lease_token = ? WHERE id = ?").run(LEASE, s.itemId);
  w.raw.prepare("UPDATE catalog_import_items SET processing_state = 'RETRYING' WHERE id = ?").run(s.itemId);
  await refused(() => plan(w, s), 'IMPORT_ILLEGAL_TRANSITION');
  // A closed run.
  w.raw.prepare("UPDATE catalog_import_runs SET state = 'closed' WHERE id = ?").run(RUN_ID);
  await refused(() => plan(w, s), 'IMPORT_RUN_NOT_OPEN');
  nothingWritten(w, pid);
});

test('the guard triggers: a money, stock or package write inside the batch aborts it whole', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  const pid = s.payload.product_id;
  for (const sql of [
    'UPDATE products SET price_iqd = 990000 WHERE id = ?',
    'UPDATE products SET stock = 5 WHERE id = ?',
    'UPDATE products SET package_weight_g = 900 WHERE id = ?',
    'UPDATE product_option_values SET regular_price_iqd = 1000 WHERE product_id = ?',
    'UPDATE product_variants SET stock = 3 WHERE product_id = ?',
    "UPDATE product_source_refs SET stock_decision = 'untracked', stock_decided_by = 'x', stock_decided_at = 'y' WHERE product_id = ?",
    "INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by) VALUES (?, '', 'regular', 0, 1, 'x')",
  ]) {
    const { plan: p, ctx } = await plan(w, s);
    // Spliced in after the product's own statements, before the fenced event — where a writer bug would put it.
    const at = p.statements.length - 4;
    p.statements.splice(at, 0, w.db.prepare(sql).bind(pid));
    await refused(() => runImportWrite(ctx, p), 'IMPORT_FINANCIAL_WRITE_REFUSED');
    nothingWritten(w, pid);
    assert.equal(one(w, 'SELECT processing_state FROM catalog_import_items WHERE id = ?', s.itemId).processing_state, 'WRITING', 'the checkpoint rolled back with it');
  }
  // Without the splice the same plan lands.
  await write(w, s);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', pid), 1);
});

// ---------------------------------------------------------------- relations and fits (§B.6)

test('incoming: the pending relations naming a handle resolve in its own batch, with printer fits for a printer', async () => {
  const w = newWorld();
  const hotend = stage(w, 'bambu-hotend-a1-a2');
  await write(w, hotend);
  complete(w, hotend.itemId);
  const pending = count(w.raw, "SELECT COUNT(*) AS n FROM product_relations WHERE product_id = ? AND state = 'pending' AND target_source_handle = 'a1'", hotend.payload.product_id);
  assert.ok(pending > 0, 'the hotend names the A1 before the A1 exists');
  const a1 = stage(w, 'a1');
  await write(w, a1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_relations WHERE target_source_handle = 'a1' AND state = 'pending'"), 0);
  assert.equal(
    count(w.raw, "SELECT COUNT(*) AS n FROM product_relations WHERE product_id = ? AND target_product_id = ? AND state = 'resolved' AND resolved_at <> ''", hotend.payload.product_id, a1.payload.product_id),
    pending
  );
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_printer_fits WHERE product_id = ? AND printer_id = ?', hotend.payload.product_id, a1.payload.product_id), 1, 'the fit mirrored (the A1 is filed in a printer catalog)');
  complete(w, a1.itemId);
  // A part written AFTER its printer resolves at its own write, and its fits ride on the save.
  const plate = stage(w, 'bambu-textured-pei-plate');
  await write(w, plate);
  assert.ok(count(w.raw, 'SELECT COUNT(*) AS n FROM product_printer_fits WHERE product_id = ? AND printer_id = ?', plate.payload.product_id, a1.payload.product_id) === 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_relations WHERE product_id = ? AND target_source_handle = 'a1' AND state = 'resolved'", plate.payload.product_id) > 0, true);
});

// ---------------------------------------------------------------- taxonomy and media refusals

test('taxonomy, brand and media refusals carry their blocker codes and write nothing', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  const pid = s.payload.product_id;
  // The node prepare-taxonomy would create is missing.
  const leaf = resolveTaxonomy(w.bundle.taxonomy, s.payload.handle, s.payload.route)!.primary;
  w.raw.exec('PRAGMA foreign_keys = OFF');
  const saved = one(w, 'SELECT * FROM catalogs WHERE id = ?', leaf);
  w.raw.prepare('DELETE FROM catalogs WHERE id = ?').run(saved.id as string);
  let e = await refused(() => plan(w, s), 'TAXONOMY_UNMAPPED');
  assert.equal(e.blocker, 'TAXONOMY_UNMAPPED');
  const cols = Object.keys(saved);
  w.raw.prepare(`INSERT INTO catalogs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(cols.map((c) => saved[c]) as never[]));
  w.raw.exec('PRAGMA foreign_keys = ON');
  // The brand is missing.
  w.raw.exec("UPDATE brands SET slug = 'not-bambu' WHERE id = 'brd_bambu'");
  e = await refused(() => plan(w, s), 'TAXONOMY_UNMAPPED');
  assert.equal(e.reason, 'brand_not_prepared');
  w.raw.exec("UPDATE brands SET slug = 'bambu-lab' WHERE id = 'brd_bambu'");
  // The primary image did not store.
  w.raw.prepare("UPDATE catalog_import_media SET status = 'failed' WHERE source_media_id = ?").run(s.payload.images.find((i) => i.is_primary)!.source_media_id);
  e = await refused(() => plan(w, s), 'PRIMARY_MEDIA_FAILED');
  assert.equal(e.blocker, 'PRIMARY_MEDIA_FAILED');
  nothingWritten(w, pid);
  // A secondary image that did not store is optional (R3): the product is written without it, and the owner told.
  w.raw.exec("UPDATE catalog_import_media SET status = 'stored'");
  const secondary = s.payload.images.find((i) => !i.is_primary)!;
  w.raw.prepare("UPDATE catalog_import_media SET status = 'failed' WHERE source_media_id = ?").run(secondary.source_media_id);
  await write(w, s);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_images WHERE id = ?', secondary.id), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE kind = 'image_review' AND field = 'images.not_stored'"), 1);
});

test('a database without 0194/0195 answers IMPORT_NOT_INSTALLED, never a 500', async () => {
  const raw = dbThrough('0193');
  const ctx = importWriteContext(asD1(raw));
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  await refused(
    () => planImportWrite(ctx, { mode: 'write', payload: s.payload, bundle: w.bundle, runId: RUN_ID, itemId: s.itemId, leaseToken: LEASE }),
    'IMPORT_NOT_INSTALLED'
  );
});

// ---------------------------------------------------------------- the budget (§A.5, owner-questions §E.4)

test('pla-basic-filament: the whole invocation under 900 with margin, every packed statement within 100 parameters', async () => {
  const w = newWorld();
  const s = stage(w, 'pla-basic-filament');
  const staged = await plan(w, s, { mode: 'stage' });
  const { plan: p } = await write(w, s);
  assert.equal(p.estimate.limit, IMPORT_INVOCATION_LIMIT);
  assert.equal(IMPORT_INVOCATION_LIMIT, 900);
  assert.ok(p.estimate.total <= 760, `the write's estimate ${p.estimate.total} keeps more than 140 statements of margin (one statement per side row would be ~906)`);
  assert.ok(staged.plan.estimate.total <= 800, `/stage estimates ${staged.plan.estimate.total} before any media is verified`);
  assert.ok(Math.abs(staged.plan.estimate.total - p.estimate.total) <= 40, 'the stage estimate tracks the write');
  assert.equal(p.estimate.total, p.estimate.reads + p.estimate.batch + p.estimate.postCommit);
  // The side rows are packed: 130 option source refs and 74 external ids ride in a handful of statements.
  assert.ok(p.counts.source_refs > 100 && p.counts.external_ids > 70);
  assert.ok(maxParams <= 100);
  assert.deepEqual(violations, []);
  assert.equal(staged.plan.statements.length > 0 && count(w.raw, 'SELECT COUNT(*) AS n FROM products'), 1, 'stage wrote nothing; the write wrote one product');
});

test('PLAN_TOO_LARGE when the invocation has already spent what the write needs; nothing written', async () => {
  const w = newWorld();
  const s = stage(w, 'pla-basic-filament');
  const ctx = importWriteContext(w.db, w.media as never);
  ctx.counter.charge(400); // the route's own reads, a long lease history …
  const e = await refused(
    () => planImportWrite(ctx, { mode: 'write', payload: s.payload, bundle: w.bundle, runId: RUN_ID, itemId: s.itemId, leaseToken: LEASE }),
    'PLAN_TOO_LARGE'
  );
  assert.equal(e.blocker, 'PLAN_TOO_LARGE');
  nothingWritten(w, s.payload.product_id);
});

test('the reviewed scope is enforced by the writer itself: an unlisted source is refused before any write', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  w.bundle = parseReviewedBundle(emptyReviewedTexts());
  const e = await refused(() => plan(w, s), 'IMPORT_REVIEWED_SCOPE_REFUSED');
  assert.equal(e.blocker, 'REVIEWED_SCOPE_REFUSED');
  assert.equal(payloadSha256(s.payload).length, 64);
  nothingWritten(w, s.payload.product_id);
});
