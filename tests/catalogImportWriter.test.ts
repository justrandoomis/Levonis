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
 *     the invocation has already spent its share; every statement ≤ 100 params;
 *     /stage's estimate equal to the write's; with the event bus on, the counted
 *     binding still emits ProductAdded and dual-writes its audits;
 *   - review 6a: the money probe reads every guarded column; a legacy warranty
 *     plan / route without `active` fingerprints equal; family members on
 *     existing Levonis printers keyed apart (ux_prel), a fit per relation; a
 *     JSON-only gallery refused; merged representatives name the product's own
 *     variants; the collapse (and a representative kept through it), the aux
 *     HEAD, the owner's primary, no self relation; facet mirrors; one heading per
 *     section; no body-less usage step.
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
import { fixtureJson, sample } from './fixtures/bambu/load';
import type { CompatTargets } from '../packages/catalog/src/bambuImport/relations';
import { recomputeD1Checks } from '../worker/lib/catalogImport/verifyD1';
import { publishV2, isV2Published } from './fixtures/v2Publish';
import { planProductSave, saveProductAtomic } from '../worker/lib/productPersistence';
import { validateProductDoc } from '../worker/lib/productModel';
import {
  FINGERPRINT_QUERIES,
  importWriteContext,
  ImportWriteRefused,
  IMPORT_ACTOR,
  MONEY_PROBE_SQL,
  moneyProbeAtDefault,
  planImportWrite,
  runImportWrite,
  spoolOptionOf,
} from '../worker/lib/catalogImport/writer';
import { colourFacet } from '../packages/catalog/src/bambuImport/registry/colours';
import { contradicts } from '../packages/catalog/src/bambuImport/media';
import { IMPORT_INVOCATION_LIMIT } from '../worker/lib/catalogImport/budget';
import { GUARDED_ROW_TABLES, IMPORT_GUARD_ID } from '../worker/lib/catalogImport/protectedTables';
import { payloadSha256, parseReviewedBundle, emptyReviewedTexts, resolveTaxonomy } from '../worker/lib/catalogImport/reviewed';
import { INDEX_STAMP } from '../worker/lib/search/store';
import { busFor, configureEventBus, resetEventBus } from '../worker/lib/eventBus';

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

test('the money-default probe reads every guarded column of the product and of its value, variant and colour rows', async () => {
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  const { result } = await write(w, s);
  assert.equal(result.after_money_default, true);
  const pid = s.payload.product_id;
  // A colour row at its defaults, so its columns are read as well (a create writes none).
  w.raw.prepare("INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex) VALUES ('c_probe', ?, 'Probe', 'Probe', 'Probe', '#000000')").run(pid);
  const probe = () => moneyProbeAtDefault({ ...(w.raw.prepare(MONEY_PROBE_SQL).get(pid) as object) });
  assert.equal(probe(), true, 'every row at its defaults');
  const away: Record<string, unknown> = { null: 1, zero: 1, zero_or_null: 1, empty_object: '{"prime":1}', empty_array: '[{"fee_iqd":1}]' };
  let read = 0;
  for (const t of GUARDED_ROW_TABLES) {
    for (const c of [...t.money, ...t.stock, ...t.package]) {
      w.raw.exec('SAVEPOINT probe');
      w.raw.prepare(`UPDATE ${t.table} SET ${c.name} = ? WHERE ${t.table === 'products' ? 'id' : 'product_id'} = ?`).run(away[c.insertDefault] as never, pid);
      const atDefault = probe();
      w.raw.exec('ROLLBACK TO probe');
      w.raw.exec('RELEASE probe');
      assert.equal(atDefault, false, `${t.table}.${c.name} away from its default is seen`);
      read++;
    }
  }
  assert.ok(read >= 60, `${read} guarded columns`);
  w.raw.prepare("UPDATE product_source_refs SET stock_decision = 'not_required' WHERE product_id = ?").run(pid);
  assert.equal(probe(), false, 'the stock decision too');
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
  // The facet mirrors of its option groups (§C.6, §G.5): base colours and spool words, ' | '-joined.
  const fields = JSON.parse(String(one(w, 'SELECT spec_fields FROM products WHERE id = ?', pid).spec_fields)) as Record<string, string>;
  const colours = s.payload.groups.filter((g) => g.kind === 'color').flatMap((g) => g.values.map((v) => v.name_en));
  assert.ok(colours.length >= 20);
  assert.equal(fields.color_name, colourFacet(colours));
  assert.match(fields.color_name, /^white \| .*\| black$/);
  assert.deepEqual(s.payload.groups.find((g) => g.kind === 'spool')?.values.map((v) => v.name_en), ['Refill', 'Filament with spool']);
  assert.equal(fields.spool_type, 'Refill | With spool', 'both, as the select\'s own option words');
});

test('the spool option words: refill / no spool, cardboard, spool — anything else says nothing', () => {
  assert.deepEqual(
    ['Refill', 'Filament with spool', 'With Spool', 'Refill (No Spool)', 'Without Spool', 'Cardboard Spool', 'Spool', 'Standard'].map(spoolOptionOf),
    ['Refill', 'With spool', 'With spool', 'Refill', 'Refill', 'Cardboard', 'With spool', null]
  );
});

test('content: a section heading opens its section once, not every text piece of it; a usage step with no body is never written', async () => {
  const w = new Map<string, Record<string, unknown>>();
  const world = newWorld();
  for (const h of ['a1', 'h2d'] as const) {
    const s = stage(world, h);
    await write(world, s);
    complete(world, s.itemId);
    w.set(h, { ...(world.raw.prepare('SELECT content_blocks, usage_guide FROM products WHERE id = ?').get(s.payload.product_id) as object), payload: s.payload });
  }
  for (const [h, row] of w) {
    const payload = row.payload as { content_blocks: Array<{ kind: string; title_en: string; section_path: string }> };
    const blocks = JSON.parse(String(row.content_blocks)) as Array<{ kind: string; body_en: string }>;
    const text = blocks.filter((b) => b.kind === 'text').map((b) => b.body_en);
    // Every (section, title) of the payload's text blocks opens exactly one stored block.
    const sections = new Map<string, string>();
    for (const b of payload.content_blocks) if (b.kind === 'text' && b.title_en) sections.set(`${b.section_path}|${b.title_en}`, b.title_en);
    assert.ok(sections.size > 2, `${h}: sections with titles`);
    const repeated = [...sections.values()].filter((title) => {
      const opening = text.filter((t) => t === title || t.startsWith(`${title}\n`)).length;
      const sameTitle = [...sections.values()].filter((x) => x === title).length;
      return opening > sameTitle;
    });
    assert.deepEqual(repeated, [], `${h}: a heading repeated inside its own section`);
  }
  const a1 = (JSON.parse(String(w.get('a1')!.content_blocks)) as Array<{ kind: string; body_en: string }>).filter((b) => b.kind === 'text');
  assert.equal(a1.filter((b) => b.body_en.startsWith('Why Choose Bambu Lab A1\n')).length, 1, 'the A1 grip section: one heading, six pieces');
  assert.ok(a1.filter((b) => /^(Full-auto Calibration|Large Print Volume) - /.test(b.body_en)).length >= 2, 'the later pieces start with their own text');
  // H2D's instructions section held only a video: its title-only step is not an empty numbered card.
  const guide = (JSON.parse(String(w.get('h2d')!.usage_guide ?? 'null')) ?? { steps: [] }) as { steps: Array<{ title: string; body: string }> };
  assert.deepEqual(guide.steps.filter((st) => !st.body.trim()), []);
  assert.ok(!guide.steps.some((st) => st.title === 'Instruction'));
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
  // A representative names the merged product's OWN variant (0194, R6), never the payload's pv_ id; one whose source
  // variant maps to no existing variant is a plain value binding.
  const variantIds = new Set(rows<{ id: string }>(w, 'SELECT id FROM product_variants WHERE product_id = ?', 'p_a1old').map((v) => v.id));
  const reps = rows<{ via_variant_id: string }>(w, "SELECT via_variant_id FROM product_option_source_refs WHERE product_id = 'p_a1old' AND binding_rule = 'representative'");
  assert.ok(reps.length > 0, 'the A1 representatives are kept');
  for (const r of reps) assert.ok(variantIds.has(r.via_variant_id), `${r.via_variant_id} is a variant of the merged product`);
  for (const i of result.images.filter((x) => x.binding_rule === 'representative')) assert.ok(i.option_value_id || i.variant_id || i.color_id);
  // The source row of a merge: never gated (§B.10).
  assert.equal(one(w, 'SELECT stock_decision FROM product_source_refs WHERE product_id = ?', 'p_a1old').stock_decision, 'not_required');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_protected WHERE phase = 'write' AND subject = 'p_a1old'"), 1, 'the write digest, stored');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_option_source_refs WHERE product_id = 'p_a1old' AND kind = 'value' AND levonis_id IN ('v_std','v_combo')"), 2);
  assert.deepEqual(violations, []);
});

test('a merge into a printer with a legacy warranty plan and a pre-order route without `active`: fingerprinted by the fee tuples, equal', async () => {
  const w = newWorld();
  const x = sample('a1');
  w.raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, category_id, options, colors, images, warranty_plans, preorder_transports)
    VALUES ('p_leg', 'bambu-a1-old', 'Bambu Lab A1', 'بامبو A1', 'بامبو A1', 'active', 0, 'cat_printers', '[]', '[]', '[]',
            '[{"name":"سنة إضافية","price_iqd":50000}]', '[{"method":"air","commission_iqd":0}]')`);
  const before = one<{ warranty_plans: string; preorder_transports: string }>(w, 'SELECT warranty_plans, preorder_transports FROM products WHERE id = ?', 'p_leg');
  w.matches.push({ source_product_id: x.sourceProductId, source_handle: x.handle, levonis_product_id: 'p_leg', decision: 'merge', value_map: {}, unmapped_variants: [], reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  const s = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_leg' });
  const { result } = await write(w, s);
  const after = one<{ warranty_plans: string; preorder_transports: string }>(w, 'SELECT warranty_plans, preorder_transports FROM products WHERE id = ?', 'p_leg');
  assert.notEqual(after.warranty_plans, before.warranty_plans, 'the save path re-serialised the legacy plan (the case under test)');
  assert.notEqual(after.preorder_transports, before.preorder_transports, 'and the route');
  assert.equal(result.before_fp_equal, true, 'no fee, percentage, commission or active flag moved');
  // The fingerprint still reads the money: a fee, a commission or a route switched off changes it.
  const fp = () => JSON.stringify(w.raw.prepare(FINGERPRINT_QUERIES.find((q) => q.table === 'products')!.sql).all('p_leg'));
  const base = fp();
  for (const change of [
    `UPDATE products SET warranty_plans = json_set(warranty_plans, '$[0].fee_iqd', 60000) WHERE id = 'p_leg'`,
    `UPDATE products SET preorder_transports = json_set(preorder_transports, '$[0].commission_iqd', 1000) WHERE id = 'p_leg'`,
    `UPDATE products SET preorder_transports = json_set(preorder_transports, '$[0].active', json('false')) WHERE id = 'p_leg'`,
  ]) {
    w.raw.exec('SAVEPOINT fp');
    w.raw.exec(change);
    assert.notEqual(fp(), base, change);
    w.raw.exec('ROLLBACK TO fp');
    w.raw.exec('RELEASE fp');
  }
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
  // An empty facet mirror is filled from the option groups (§E.2 fill-if-empty), like every other mirror.
  const fields = JSON.parse(String(one(w, 'SELECT spec_fields FROM products WHERE id = ?', 'p_pla').spec_fields)) as Record<string, string>;
  assert.equal(fields.spool_type, 'Refill | With spool');
  assert.ok(fields.color_name?.includes('white'));
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

/** An owner gallery as products.images JSON (a TXT-born or legacy product never re-saved through the form). */
const OWNER_GALLERY = JSON.stringify([
  { id: 'm_owner_1', url: '/files/products/owner-hero.webp', key: 'products/owner-hero.webp', role: 'gallery', alt_ar: 'صورتنا', alt_en: 'Our photo', alt_ckb: 'وێنەی ئێمە', order: 0, primary: true, width: 800, height: 800, content_type: 'image/webp', bytes: 1000, source_url: '', option_value_id: '', color_id: '', variant_id: '' },
  { id: 'm_owner_2', url: '/files/products/owner-2.webp', key: 'products/owner-2.webp', role: 'gallery', alt_ar: '', alt_en: 'Second', alt_ckb: '', order: 1, primary: false, width: 800, height: 800, content_type: 'image/webp', bytes: 1000, source_url: '', option_value_id: '', color_id: '', variant_id: '' },
]);

test('a merge into a gallery kept only in products.images is refused (the owner pictures and hero stay), with or without option rows', async () => {
  // No relation row at all.
  const w = newWorld();
  const x = sample('pla-basic-filament');
  w.raw
    .prepare(
      `INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, inventory_mode, category_id, options, colors, images)
       VALUES ('p_pla', 'pla-basic', 'PLA Basic', 'PLA Basic', 'PLA Basic', 'active', 25000, 'BASE', 'cat_materials', '[]', '[]', ?)`
    )
    .run(OWNER_GALLERY);
  w.matches.push({ source_product_id: x.sourceProductId, source_handle: x.handle, levonis_product_id: 'p_pla', decision: 'merge', value_map: {}, unmapped_variants: [], reason: 'same_model', reviewed_by: 't', reviewed_at: 'd' });
  const s = stage(w, 'pla-basic-filament', { writeMode: 'merge', mergeProductId: 'p_pla' });
  const e = await refused(() => write(w, s), 'IMPORT_REVIEWED_SCOPE_REFUSED');
  assert.equal(e.reason, 'merge_target_legacy_gallery');
  assert.equal(e.blocker, 'REVIEWED_SCOPE_REFUSED');
  await refused(() => plan(w, s, { mode: 'stage' }), 'IMPORT_REVIEWED_SCOPE_REFUSED');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id = 'p_pla'"), 0, 'no row appended');
  assert.equal(one(w, 'SELECT images FROM products WHERE id = ?', 'p_pla').images, OWNER_GALLERY, 'the owner gallery untouched');
  assert.equal(one(w, 'SELECT processing_state FROM catalog_import_items WHERE id = ?', s.itemId).processing_state, 'WRITING');

  // Option rows, but the pictures still only in the JSON (the overlay falls back to the JSON with no image row).
  const w2 = newWorld();
  await existingA1(w2);
  w2.raw.prepare("UPDATE products SET images = ? WHERE id = 'p_a1old'").run(OWNER_GALLERY);
  w2.matches.push(a1Match());
  const s2 = stage(w2, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1old' });
  const e2 = await refused(() => write(w2, s2), 'IMPORT_REVIEWED_SCOPE_REFUSED');
  assert.equal(e2.reason, 'merge_target_legacy_gallery');
  assert.equal(count(w2.raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id = 'p_a1old'"), 0);
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

/** The fixture's compat file with the step-2 snapshot's ids filled in for existing Levonis printers. */
function compatWithLevonis(ids: Record<string, string>): CompatTargets {
  const t = structuredClone(fixtureJson<CompatTargets & { levonis_existing_printers: Record<string, { levonis_product_id: string | null }> }>('compat-targets.json'));
  for (const entry of Object.values(t.labels)) {
    for (const m of (entry.members ?? []) as Array<{ levonis_model?: string; levonis_product_id?: string | null }>) if (m.levonis_model && ids[m.levonis_model]) m.levonis_product_id = ids[m.levonis_model];
  }
  for (const [model, e] of Object.entries(t.levonis_existing_printers)) if (ids[model]) e.levonis_product_id = ids[model];
  return t;
}

/** Two existing Levonis printers (X1C, X1E) filed in a printer catalog, and the compat file naming them. */
function existingX1Printers(w: World): void {
  for (const id of ['p_x1c', 'p_x1e']) {
    w.raw.prepare("INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, options, colors, images, category_id) VALUES (?, ?, ?, ?, ?, 'active', 0, '[]', '[]', '[]', 'cat_printers')").run(id, id, id, id, id);
    w.raw.prepare("INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES (?, 'cat_printers', (SELECT COALESCE(MAX(position), 0) + 1 FROM product_catalogs WHERE catalog_id = 'cat_printers'))").run(id);
  }
  w.raw.exec("UPDATE catalogs SET is_printer_catalog = 1 WHERE id = 'cat_printers'");
  w.compat = compatWithLevonis({ X1C: 'p_x1c', X1E: 'p_x1e' });
}

test('a family of two existing Levonis printers (X1 Series → X1C, X1E): a relation and a printer fit per member, counts equal to D1', async () => {
  const w = newWorld();
  existingX1Printers(w);
  const s = stage(w, 'build-plate-combo');
  const members = s.payload.relations.filter((r) => r.target_family === 'x1_series' && r.state === 'resolved');
  assert.deepEqual([...new Set(members.map((r) => r.target_product_id))].sort(), ['p_x1c', 'p_x1e'], 'the payload names both members');
  for (const r of members) {
    assert.equal(r.target_source, '', 'never read by the incoming resolution');
    assert.equal(r.target_source_handle, `levonis:${r.target_product_id}`, 'each member keyed by its own product');
  }
  const { plan: p } = await write(w, s);
  const pid = s.payload.product_id;
  for (const t of ['p_x1c', 'p_x1e']) {
    assert.equal(
      count(w.raw, "SELECT COUNT(*) AS n FROM product_relations WHERE product_id = ? AND target_product_id = ? AND state = 'resolved' AND target_family = 'x1_series'", pid, t),
      members.filter((r) => r.target_product_id === t).length,
      `${t}: every member row written`
    );
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_printer_fits WHERE product_id = ? AND printer_id = ?', pid, t), 1, `${t}: its fit, beside its relation`);
  }
  assert.equal(p.counts.relations, count(w.raw, 'SELECT COUNT(*) AS n FROM product_relations WHERE product_id = ?', pid), 'stage_data.written.relations is what D1 holds');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE field LIKE '%:duplicate_key'"), 0);
  const checks = await recomputeD1Checks(w.db, { bundle: w.bundle, runId: RUN_ID, itemId: s.itemId, media: w.media as never });
  assert.equal(checks.checks.counts, true, JSON.stringify(checks.failed));
});

test('two rows on one ux_prel key are never planned twice: the first is written, the other reported, counts and fits agree', async () => {
  const w = newWorld();
  existingX1Printers(w);
  // The step-4 shape before the member token: both members on the same key (a builder that regresses).
  const s = stage(w, 'build-plate-combo', {
    mutate: (p) => {
      for (const r of p.relations) if (r.target_source_handle.startsWith('levonis:')) r.target_source_handle = '';
    },
  });
  const { plan: p } = await write(w, s);
  const pid = s.payload.product_id;
  assert.equal(p.counts.relations, count(w.raw, 'SELECT COUNT(*) AS n FROM product_relations WHERE product_id = ?', pid), 'the count is the rows planned, every one written');
  const fits = rows<{ printer_id: string }>(w, 'SELECT printer_id FROM product_printer_fits WHERE product_id = ?', pid).map((r) => r.printer_id);
  const related = new Set(rows<{ t: string }>(w, "SELECT target_product_id AS t FROM product_relations WHERE product_id = ? AND relation = 'compatible_with' AND state = 'resolved'", pid).map((r) => r.t));
  assert.ok(fits.length > 0);
  for (const f of fits) assert.ok(related.has(f), `the fit to ${f} has its relation`);
  assert.ok(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE kind = 'relation_unresolvable' AND field = 'compatible_with:duplicate_key'") > 0, 'the dropped member is reported');
});

test('a family member that resolves to the merge target itself writes no relation to itself', async () => {
  const w = newWorld();
  await existingA1(w);
  // The step-2 snapshot names the merge target as an "A1 Series" member: the A1's own family row would point at itself.
  const compat = structuredClone(fixtureJson<CompatTargets>('compat-targets.json'));
  (compat.labels['A1 Series'].default!.members as Array<Record<string, unknown>>).push({ levonis_model: 'A1', levonis_product_id: 'p_a1old' });
  w.compat = compat;
  w.matches.push(a1Match());
  const s = stage(w, 'a1', {
    writeMode: 'merge',
    mergeProductId: 'p_a1old',
    mutate: (p) => {
      // And a reviewed `requires` row naming the product itself (a part target is never a printer fit).
      const r0 = p.relations[0];
      p.relations.push({ ...r0, id: 'pr_self_requires_0001', relation: 'requires', target_kind: 'part', state: 'resolved', target_product_id: 'p_a1old', target_source: '', target_source_handle: 'levonis:p_a1old', target_family: '', target_label: 'Bambu Lab A1', scope_kind: 'product', scope_id: '' });
    },
  });
  assert.ok(s.payload.relations.some((r) => r.target_product_id === 'p_a1old'), 'the payload names the product itself');
  await write(w, s);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_relations WHERE product_id = 'p_a1old' AND target_product_id = 'p_a1old'"), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_printer_fits WHERE product_id = 'p_a1old' AND printer_id = 'p_a1old'"), 0);
});

// ---------------------------------------------------------------- media: the content-duplicate collapse, the aux HEAD, the merge primary (§C.4, §E.2)

/** Points a medium at another's object, as /media's content addressing does for two files with the same bytes. */
function sameBytes(w: World, copy: string, canonical: string): void {
  const c = w.raw.prepare('SELECT r2_key, width, height, bytes, sha256 FROM catalog_import_media WHERE run_id = ? AND source_media_id = ?').get(RUN_ID, canonical) as Record<string, unknown>;
  w.raw
    .prepare('UPDATE catalog_import_media SET r2_key = ?, width = ?, height = ?, bytes = ?, sha256 = ? WHERE run_id = ? AND source_media_id = ?')
    .run(c.r2_key as string, c.width as number, c.height as number, c.bytes as number, c.sha256 as string, RUN_ID, copy);
}

test('the content-duplicate collapse (§C.4 step 1): A1 #6/#7, general copies of the bound heroes, fold into them', async () => {
  const w = newWorld();
  const s = stage(w, 'a1');
  sameBytes(w, '698796116085157888', '753811089383063552');
  sameBytes(w, '698796170866409472', '753811089272295424');
  const { plan: p, result } = await write(w, s);
  const pid = s.payload.product_id;
  const imgs = rows<{ r2_key: string; is_primary: number; option_value_id: string | null; variant_id: string | null }>(w, 'SELECT r2_key, is_primary, option_value_id, variant_id FROM product_images WHERE product_id = ?', pid);
  assert.equal(imgs.length, s.payload.images.length - 2, 'two general copies gone');
  assert.equal(result.images.length, imgs.length, 'the answer lists the rows after the collapse');
  assert.ok(p.warnings.includes('content duplicates collapsed: 2'));
  for (const canonical of ['753811089383063552', '753811089272295424']) {
    const key = (w.raw.prepare('SELECT r2_key FROM catalog_import_media WHERE run_id = ? AND source_media_id = ?').get(RUN_ID, canonical) as { r2_key: string }).r2_key;
    assert.equal(imgs.filter((i) => i.r2_key === key && !i.option_value_id && !i.variant_id).length, 0, 'no general copy of a bound hero (it would show for every selection)');
  }
  assert.equal(imgs.filter((i) => i.is_primary === 1).length, 1);
});

test('the collapse keeps a representative\'s rule and its via variant (R6): the hotend\'s 0.4 mm hero never shows for a 0.6 mm selection', async () => {
  const shownFor = async (duplicate: boolean) => {
    const w = newWorld();
    const s = stage(w, 'bambu-hotend-a1-a2');
    const p = s.payload;
    const general = p.images.find((i) => i.sort_order === 0)!;
    const hero = p.images.find((i) => i.sort_order === 2)!;
    assert.equal(general.binding_rule, 'general');
    if (duplicate) sameBytes(w, general.source_media_id, hero.source_media_id);
    await write(w, s);
    const heroKey = (w.raw.prepare('SELECT r2_key FROM catalog_import_media WHERE run_id = ? AND source_media_id = ?').get(RUN_ID, hero.source_media_id) as { r2_key: string }).r2_key;
    const imgs = rows<{ option_value_id: string | null; variant_id: string | null; r2_key: string; binding_rule: string; via_variant_id: string }>(
      w,
      `SELECT i.option_value_id, i.variant_id, i.r2_key, r.binding_rule, r.via_variant_id
         FROM product_images i JOIN product_option_source_refs r ON r.product_id = i.product_id AND r.kind = 'image' AND r.levonis_id = i.id
        WHERE i.product_id = ?`,
      p.product_id
    );
    const model = { groups: p.groups.map((g) => ({ id: g.id, values: g.values.map((v) => ({ id: v.id })) })), variants: p.variants.map((v) => ({ id: v.id, valueIds: v.value_ids })) } as never;
    const a1 = p.groups[0].values.find((v) => v.name_en === 'A1')!.id;
    const n06 = p.groups[1].values.find((v) => v.name_en === '0.6mm Hardened Steel')!.id;
    const shown = imgs.filter((i) => !contradicts({ optionValueId: i.option_value_id, variantId: i.variant_id, viaVariantId: i.via_variant_id || null }, model, [a1, n06]));
    return { heroShown: shown.filter((i) => i.r2_key === heroKey).length, heroRows: imgs.filter((i) => i.r2_key === heroKey) };
  };
  assert.equal((await shownFor(false)).heroShown, 0, 'control: no duplicate');
  const dup = await shownFor(true);
  assert.ok(dup.heroRows.some((r) => r.binding_rule === 'representative' && r.via_variant_id !== ''), 'the moved representative keeps its rule and via variant');
  assert.equal(dup.heroShown, 0, 'and the page still drops it for a 0.6 mm selection');
});

test('an aux medium (a swatch) is proven by its R2 object: gone, the swatch is not written and the item says so', async () => {
  const w = newWorld();
  const s = stage(w, 'pla-basic-filament');
  const sw = s.payload.swatches[0];
  assert.ok(!s.payload.images.some((i) => i.source_media_id === sw.source_media_id), 'a swatch medium, not a gallery one');
  const key = (w.raw.prepare('SELECT r2_key FROM catalog_import_media WHERE run_id = ? AND source_media_id = ?').get(RUN_ID, sw.source_media_id) as { r2_key: string }).r2_key;
  assert.ok(w.bucket.objects.delete(key));
  await write(w, s);
  const pid = s.payload.product_id;
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_option_value_swatches WHERE product_id = ? AND r2_key = ?', pid, key), 0, 'no swatch on a missing object');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_option_value_swatches WHERE product_id = ?', pid), s.payload.swatches.length - 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM catalog_import_conflicts WHERE item_id = ? AND kind = 'image_review' AND field = 'media.not_stored'", s.itemId), 1);
});

test('a merge into a product that has its primary picture: the owner\'s stays the only primary, every appended row is written', async () => {
  const w = newWorld();
  await existingA1(w);
  w.raw.exec(`INSERT INTO product_images (id, product_id, url, r2_key, content_type, width, height, bytes, sort_order, is_primary)
    VALUES ('img_owner', 'p_a1old', '/files/products/owner.webp', 'products/owner.webp', 'image/webp', 64, 48, 100, 0, 1)`);
  w.matches.push(a1Match());
  const s = stage(w, 'a1', { writeMode: 'merge', mergeProductId: 'p_a1old' });
  const { result } = await write(w, s);
  const prim = rows<{ id: string }>(w, "SELECT id FROM product_images WHERE product_id = 'p_a1old' AND is_primary = 1").map((r) => r.id);
  assert.deepEqual(prim, ['img_owner']);
  assert.ok(result.images.length > 0 && result.images.every((i) => !i.is_primary));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_images WHERE product_id = 'p_a1old'"), 1 + result.images.length, 'the owner picture and every appended row: none lost');
  assert.equal(
    count(w.raw, "SELECT COUNT(*) AS n FROM product_option_source_refs r WHERE r.product_id = 'p_a1old' AND r.kind = 'image' AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.id = r.levonis_id)"),
    0,
    'no image source row without its picture'
  );
  assert.equal(one(w, "SELECT MIN(sort_order) AS m FROM product_images WHERE product_id = 'p_a1old' AND id <> 'img_owner'").m, 1, 'appended after the owner\'s');
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
  // Every medium stored and distinct (nothing dropped or collapsed): /stage answers exactly what /write counts (§A.5).
  assert.deepEqual(
    { reads: staged.plan.estimate.reads, batch: staged.plan.estimate.batch, postCommit: staged.plan.estimate.postCommit, total: staged.plan.estimate.total },
    { reads: p.estimate.reads, batch: p.estimate.batch, postCommit: p.estimate.postCommit, total: p.estimate.total },
    'the stage estimate is the write\'s'
  );
  assert.equal(p.estimate.total, p.estimate.reads + p.estimate.batch + p.estimate.postCommit);
  // The side rows are packed: 130 option source refs and 74 external ids ride in a handful of statements.
  assert.ok(p.counts.source_refs > 100 && p.counts.external_ids > 70);
  assert.ok(maxParams <= 100);
  assert.deepEqual(violations, []);
  assert.equal(staged.plan.statements.length > 0 && count(w.raw, 'SELECT COUNT(*) AS n FROM products'), 1, 'stage wrote nothing; the write wrote one product');
});

test('with the event bus on, the counted binding is still the binding: ProductAdded in the batch, the audits dual-written, the estimate covering it', async () => {
  const w = newWorld();
  configureEventBus({ DB: w.db, EVENT_BUS_ENABLED: 'on', INITIAL_ADMIN_EMAIL: 'x@x.co', EXTRA_ALLOWED_ORIGINS: '' } as never);
  try {
    const s = stage(w, 'ams-2-pro-feeder-unit');
    const ctx = importWriteContext(w.db, w.media as never);
    assert.ok(busFor(w.db) && busFor(ctx.db), 'the bus sees the binding through the import\'s counting view');
    const details = count(w.raw, 'SELECT COUNT(*) AS n FROM core_audit_details');
    const p = await planImportWrite(ctx, { mode: 'write', payload: s.payload, bundle: w.bundle, runId: RUN_ID, itemId: s.itemId, leaseToken: LEASE });
    await runImportWrite(ctx, p);
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM core_outbox_events WHERE aggregate_id = ?', s.payload.product_id), 1, 'one ProductAdded, as every product writer emits');
    assert.ok(count(w.raw, 'SELECT COUNT(*) AS n FROM core_audit_details') >= details + 2, 'catalog_import.write and product.relations.save dual-written');
    assert.ok(ctx.counter.count <= p.estimate.total, `executed ${ctx.counter.count} within the estimate ${p.estimate.total}`);
  } finally {
    resetEventBus();
  }
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

// ---------------------------------------------------------------- the step 5 review rule, and the document checks

/** A published price on a product under the given id (only a raw write or a past release could put one there). */
function pricedProduct(w: World, id: string): void {
  w.raw.prepare("INSERT INTO products (id, slug, name, price_iqd, status) VALUES (?, ?, 'Owner product', 0, 'active')").run(id, `owner-${id.slice(-6)}`);
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${id}', 1);
    INSERT INTO pricing_v2_sku_results (product_id, combo_key, channel, method, anchor, final_price_iqd, exact_iqd, direct_price_iqd, direct_exact_iqd, usd_ceil6, usd_iqd_rate, usd_fx_version, inputs_seq, config_version, write_seq, computed_at)
      VALUES ('${id}', '', 'direct_sale', 'usd', 'product_fixed', 1000, '1000', 1000, '1000', '1', '1600', 1, 1, 1, 9, 'x');
    DELETE FROM ops_guards WHERE id = 'engine-price:${id}';`);
}

test('a create never records a created source row on a product with V2 results: refused before the plan, and inside the batch', async () => {
  // Before the plan.
  const w = newWorld();
  const s = stage(w, 'ams-2-pro-feeder-unit');
  const pid = s.payload.product_id;
  pricedProduct(w, pid);
  const e = await refused(() => plan(w, s), 'IMPORT_CREATE_ON_PRICED_PRODUCT');
  assert.equal(e.blocker, 'REVIEWED_SCOPE_REFUSED');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_source_refs WHERE product_id = ?', pid), 0);
  // Inside the batch: the price appears between the plan and the write; the guard row's fence aborts it whole.
  const w2 = newWorld();
  const s2 = stage(w2, 'ams-2-pro-feeder-unit');
  const { plan: p, ctx } = await plan(w2, s2);
  pricedProduct(w2, s2.payload.product_id);
  await refused(() => runImportWrite(ctx, p), 'IMPORT_CREATE_ON_PRICED_PRODUCT');
  assert.equal(count(w2.raw, 'SELECT COUNT(*) AS n FROM product_source_refs'), 0, 'no created source row');
  assert.equal(count(w2.raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', s2.payload.product_id), 0);
  assert.equal(count(w2.raw, 'SELECT COUNT(*) AS n FROM ops_guards WHERE id = ?', IMPORT_GUARD_ID), 0);
});

test('the runner\'s document checks land on product_documents; a dead link is written inactive, never shown', async () => {
  const w = newWorld();
  const s = stage(w, 'a1');
  const docs = s.payload.documents;
  assert.ok(docs.length >= 2);
  const checks = docs.map((d, i) => ({
    document_id: d.id,
    check_status: i === 0 ? 404 : 200,
    content_type: i === 0 ? 'text/html' : 'application/pdf',
    byte_size: i === 0 ? null : 2048,
    content_sha256: i === 0 ? '' : 'b'.repeat(64),
    checked_at: '2026-10-15T00:00:00.000Z',
    tracker_source: i === 1 ? 'https://e.bambulab.com/t?c=abc' : '',
  }));
  const ctx = importWriteContext(w.db, w.media as never);
  const p = await planImportWrite(ctx, { mode: 'write', payload: s.payload, bundle: w.bundle, runId: RUN_ID, itemId: s.itemId, leaseToken: LEASE, documentChecks: checks });
  await runImportWrite(ctx, p);
  const rows = w.raw.prepare('SELECT id, active, check_status, content_type, byte_size, content_sha256, tracker_source FROM product_documents WHERE product_id = ? ORDER BY sort').all(s.payload.product_id) as Array<Record<string, unknown>>;
  const dead = rows.find((r) => r.id === docs[0].id)!;
  assert.deepEqual({ ...dead }, { id: docs[0].id, active: 0, check_status: 404, content_type: 'text/html', byte_size: null, content_sha256: '', tracker_source: '' });
  const alive = rows.find((r) => r.id === docs[1].id)!;
  assert.equal(alive.active, 1);
  assert.equal(alive.check_status, 200);
  assert.equal(alive.tracker_source, 'https://e.bambulab.com/t?c=abc');
});
