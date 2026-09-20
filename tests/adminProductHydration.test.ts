/**
 * Admin product form — hydration and the TXT apply counters
 * (docs/TXT_IMPORT_PARITY.md §5.3, §5.4).
 *
 * Pure tests in the farmClient.test.ts style: the two loaders the form runs
 * over what `GET /api/admin/products-v2/:id` and
 * `GET /api/admin/products/:id/relations` return, and the reader of the
 * `POST /api/admin/template/apply` result. The rules pinned here are the
 * owner's: a value the API returned is shown (never dropped, never defaulted
 * away), a count is only ever a number the server READ BACK (a missing block
 * is "unreported", never 0), and a mismatch is a failure named by section
 * even when the HTTP status was 200. The static checks read the components
 * the way a reviewer would, so a hurried edit cannot quietly reintroduce the
 * losses the parity table lists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { ApiError } from '../src/lib/api';
import type { ProductDocV2 } from '../src/lib/productTypes';
import {
  blankDoc,
  importedTexts,
  preservedGroups,
  specIdsOutsideTemplate,
  toEditorDoc,
  type ApplyResponse,
} from '../src/components/adminProducts/types';
import {
  deriveInventoryMode,
  docHasStructure,
  hasRelationStructure,
  hydrateRelations,
  relationsFromDoc,
  relationsFromWire,
  relationsToWire,
  type RelationsResponse,
} from '../src/components/adminProducts/form/model';
import {
  applyFailure,
  applyOutcome,
  mismatchSections,
  mismatchText,
  summarizeApply,
  verificationLine,
  type VerificationWords,
} from '../src/components/adminProducts/applyResult';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ------------------------------------------------------------------ fixtures

/** Every field the admin document carries, with a distinct value in each. */
function fullDoc(): ProductDocV2 & { catalog_ids: string[] } {
  return {
    id: 'prod_txt1',
    slug: 'bambu-a1',
    status: 'active',
    doc_version: 2,
    content_rev: 4,
    name_ar: 'بامبو A1',
    name_en: 'Bambu A1',
    name_ckb: 'بامبو A1 کوردی',
    description_ar: 'وصف عربي',
    description_en: 'English description',
    description_ckb: 'وەسفی کوردی',
    price_iqd: 450000,
    pro_price_iqd: 400000,
    prime_price_iqd: 420000,
    original_price_iqd: 500000,
    product_cost_iqd: 300000,
    selling_type: 'pre_order',
    sale_types: ['pre_order', 'direct_sale'],
    preorder_transports: [
      { method: 'air', commission_iqd: 25000, active: true },
      { method: 'sea', commission_iqd: null, active: false },
    ],
    direct_surcharge_iqd: 50000,
    stock: 7,
    low_stock_threshold: 2,
    brand_id: 'brand_bambu',
    category_id: 'cat_printers',
    sub_category_id: 'cat_fdm',
    template_family: 'devices',
    sku: 'BL-A1',
    spec_fields: { build_volume: '256x256x256', nozzle: '0.4', made_up_field: 'x' },
    media: [
      { id: 'img_1', url: 'https://cdn/1.jpg', key: 'r2/1', alt_ar: 'صورة', alt_en: 'Front', alt_ckb: 'وێنە', primary: true, order: 0, width: 800, height: 600, source_url: 'https://vendor/1', option_value_id: 'ov_a', color_id: '' },
      { id: 'img_2', url: 'https://cdn/2.jpg', key: '', alt_ar: '', alt_en: 'Side', alt_ckb: '', primary: false, order: 1, width: null, height: null, source_url: '', color_id: 'col_1' },
    ] as ProductDocV2['media'],
    options: [
      { id: 'ov_a', name_ar: 'أ١', name_en: 'A1', name_ckb: 'A1', image: '', order: 0, active: true, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, group_en: 'Model', stock: 3, availability_type: 'direct_sale', sku_part: 'A1' },
      { id: 'ov_b', name_ar: 'أ١ كومبو', name_en: 'A1 Combo', name_ckb: '', image: '', order: 1, active: true, regular_price_iqd: 550000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, group_en: 'Model', stock: null, lead_time_text: '2 weeks' },
      { id: 'ov_n', name_ar: '٠.٤', name_en: '0.4', name_ckb: '', image: '', order: 2, active: false, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, group_en: 'Nozzle', regular_adjust_iqd: 5000 },
    ] as ProductDocV2['options'],
    colors: [
      { id: 'col_1', name_ar: 'أخضر', name_en: 'Green', name_ckb: 'سەوز', hex: '#00ff00', image: '', option_id: null, option_ids: ['ov_a', 'ov_b', 'ov_missing'], order: 0, active: true, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, stock: 2 },
    ] as ProductDocV2['colors'],
    spec_groups: [
      { id: 'sg_1', title_ar: 'الأبعاد', title_en: 'Dimensions', title_ckb: '', order: 0, rows: [{ id: 'r1', label_ar: 'العرض', label_en: 'Width', label_ckb: '', value_ar: '', value_en: '38', value_ckb: '', unit: 'cm', order: 0 }] },
    ],
    labels: [{ id: 'lb_1', key: 'new', text_ar: 'جديد', text_en: 'New', text_ckb: '', icon: 'star', order: 0, visible: true }],
    warranty_plans: [
      { id: 'wp_ext12', title_ar: '', title_en: 'Extended +12', title_ckb: '', terms_ar: '', terms_en: '', terms_ckb: '', duration_months: 12, duration_kind: 'extension', fee_iqd: 0, fee_percent: 7.5, order: 0, active: true },
    ],
    warranty_base_months: 12,
    serialized: true,
    content_blocks: [{ id: 'cb_1', kind: 'text', order: 0, body_ar: 'نص', body_en: 'Body text', body_ckb: '', caption_ar: '', caption_en: '', caption_ckb: '', alt_ar: '', alt_en: '', alt_ckb: '', url: '', media_key: '' }],
    translation_meta: { name_en: { en: { status: 'imported', src_rev: 4 } } },
    is_featured: true,
    display_order: 5,
    payment_options: ['wallet', 'cash'],
    hashtags: ['bambu', 'fdm'],
    how_to_use: 'Plug and print',
    how_to_use_ar: 'وصّلها واطبع',
    how_to_use_ckb: '',
    usage_guide: { official_url: 'https://wiki/a1', steps: [{ id: 'st_1', kind: 'setup', title: 'Unbox', body: 'Remove the foam',
      title_ar: 'فك التغليف', title_ckb: '', body_ar: 'أزل الإسفنج', body_ckb: '',
      images: [], video_url: '', link_url: '', order: 0 }] },
    catalog_ids: ['cat_printers', 'cat_fdm'],
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-08T00:00:00Z',
  };
}

/** `GET /products/:id/relations` for a product with rows — one value orphaned. */
function fullRelations(): RelationsResponse {
  return {
    success: true,
    product: { inventory_mode: 'OPTION' },
    groups: [
      { id: 'og_model', name_en: 'Model', sort: 0, active: 1 },
      { id: 'og_nozzle', name_en: 'Nozzle', sort: 1, active: 1 },
    ],
    values: [
      { id: 'ov_b', group_id: 'og_model', name_en: 'A1 Combo', name_ar: 'أ١ كومبو', name_ckb: '', sku_part: 'A1C', image: '', sort: 1, active: 1, stock: null, low_stock_threshold: null, regular_price_iqd: 550000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 400000, lead_time_text: '2 weeks', lead_time_min_days: 10, lead_time_max_days: 14, availability_type: 'pre_order', variant_key: 'a1-combo', variant_label: 'A1 Combo' },
      { id: 'ov_a', group_id: 'og_model', name_en: 'A1', name_ar: 'أ١', name_ckb: 'A1', sku_part: 'A1', image: 'https://cdn/a1.jpg', sort: 0, active: 1, stock: 3, low_stock_threshold: 1, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, availability_type: 'direct_sale' },
      { id: 'ov_n', group_id: 'og_nozzle', name_en: '0.4', sku_part: '', image: '', sort: 0, active: 0, stock: null, low_stock_threshold: null, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: 5000 },
      { id: 'ov_orphan', group_id: 'og_gone', name_en: 'Hotend', sku_part: '', image: '', sort: 0, active: 1, stock: null, low_stock_threshold: null, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
    ],
    colors: [
      { id: 'col_1', name_en: 'Green', name_ar: 'أخضر', name_ckb: 'سەوز', hex: '#00ff00', image: '', sku_part: 'GR', sort: 0, active: 1, stock: 2, low_stock_threshold: null, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
    ],
    links: [
      { color_id: 'col_1', option_value_id: 'ov_a', group_id: 'og_model' },
      { color_id: 'col_1', option_value_id: 'ov_b', group_id: 'og_model' },
    ],
    variants: [
      { id: 'var_1', combo_key: 'o:ov_a|c:col_1', sku: 'A1-GR', active: 1, stock: 1, low_stock_threshold: null, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
    ],
    images: [
      { id: 'img_1', url: 'https://cdn/1.jpg', alt_en: 'Front', alt_ar: 'صورة', alt_ckb: 'وێنە', r2_key: 'r2/1', source_url: 'https://vendor/1', sort_order: 0, is_primary: 1, option_value_id: 'ov_a', color_id: null, variant_id: null, width: 800, height: 600 },
      { id: 'img_2', url: 'https://cdn/2.jpg', alt_en: 'Side', sort_order: 1, is_primary: 0, option_value_id: null, color_id: 'col_1', variant_id: null, width: null, height: null },
    ],
  };
}

function fullApply(): ApplyResponse {
  return {
    success: true,
    created: true,
    already_applied: false,
    fingerprint: 'abc',
    product_id: 'prod_txt1',
    product: null,
    applied_fields: ['name_ar', 'price_iqd', 'options', 'images'],
    cleared_fields: ['sku'],
    preserved_fields: ['brand'],
    unknown_keys: ['options.1.colour'],
    warnings: ['status forced to draft'],
    relations: { groups: 2, values: 4, colors: 1, links: 2, variants: 0, images: 3, primary_image: 'img_1', inventory_mode: 'OPTION' },
    spec_fields: {
      stored: 7,
      visible_in_form: 6,
      outside_section: ['made_up_field'],
      family: 'devices',
      warnings: ['spec.made_up_field: not a field of this section'],
    },
    images: { requested: 3, stored: 3 },
    option_groups: { requested: 2, stored: 2 },
    option_values: { requested: 4, stored: 4 },
    colors: { requested: 1, stored: 1 },
    mismatches: [],
    price_history_rows: 1,
    hashtags_registered: 2,
    translation_review_needed: [],
  };
}

const WORDS: VerificationWords = {
  groups: 'groups', values: 'values', colors: 'colours', links: 'links', images: 'images', specs: 'specs',
  outside: 'visible', outsideSection: 'outside the section template',
  variants: 'variants', inventory: 'inventory', unreported: 'no counts from the server',
};

// ------------------------------------------------------------ toEditorDoc

test('toEditorDoc: every stored field of the admin document reaches the form state unchanged', () => {
  const p = fullDoc();
  const d = toEditorDoc(p);
  for (const key of Object.keys(p) as Array<keyof typeof p>) {
    assert.deepEqual(d[key as keyof typeof d], p[key], `field ${String(key)} must round-trip`);
  }
  // The groups the form has no editor for are present, not emptied.
  assert.equal(d.spec_groups.length, 1);
  assert.equal(d.labels.length, 1);
  assert.equal(d.content_blocks.length, 1);
  assert.deepEqual(d.payment_options, ['wallet', 'cash']);
  assert.equal(d.description_ar, 'وصف عربي');
  assert.equal(d.name_ckb, 'بامبو A1 کوردی');
  assert.equal(d.warranty_base_months, 12);
  assert.equal(d.serialized, true);
  assert.equal(d.original_price_iqd, 500000);
  assert.equal(d.template_family, 'devices');
  assert.equal(d.usage_guide.steps[0].title, 'Unbox');
  assert.deepEqual(Object.keys(d.spec_fields), ['build_volume', 'nozzle', 'made_up_field']);
});

test('toEditorDoc: shape repairs only — absent arrays become empty, an empty sale_types falls back to the row scalar, nothing is invented', () => {
  const d = toEditorDoc({ id: 'p', selling_type: 'pre_order', sale_types: [] });
  assert.deepEqual(d.sale_types, ['pre_order']);
  assert.equal(d.selling_type, 'pre_order');
  assert.deepEqual(d.media, []);
  assert.deepEqual(d.preorder_transports, []);
  assert.deepEqual(d.usage_guide, { official_url: '', steps: [] });
  assert.equal(d.warranty_base_months, null);
  assert.equal(d.serialized, null);
  assert.equal(d.direct_surcharge_iqd, null);
  assert.equal(d.stock, null);
  // A null string column is an empty input, never the literal "null".
  const n = toEditorDoc({ id: 'p', description_ar: null as unknown as string, how_to_use: undefined });
  assert.equal(n.description_ar, '');
  assert.equal(n.how_to_use, '');
  // The blank document has every key the full one has.
  assert.deepEqual(Object.keys(blankDoc()).sort(), Object.keys(toEditorDoc({})).sort());
});

test('importedTexts / preservedGroups / specIdsOutsideTemplate: what the form has no input for is listed, never hidden', () => {
  const d = toEditorDoc(fullDoc());
  assert.deepEqual(importedTexts(d).map((r) => r.key), ['name_ar', 'name_ckb', 'description_ar', 'description_ckb']);
  assert.deepEqual(importedTexts(toEditorDoc({ id: 'p' })), []);

  const groups = preservedGroups(d);
  // payment_options is deliberately absent: section 4 already prints it, and
  // two homes for one list is a design departure, not extra honesty.
  assert.deepEqual(groups.map((g) => [g.key, g.count]), [['spec_groups', 1], ['labels', 1], ['content_blocks', 1]]);
  assert.match(groups[0].lines[0], /Dimensions \(1\) — Width: 38 cm/);
  assert.match(groups[1].lines[0], /new: New/);
  assert.match(groups[2].lines[0], /text: Body text/);
  assert.equal(groups.length, 3, 'payment options are not a preserved group — section 4 owns them');
  assert.deepEqual(d.payment_options, ['wallet', 'cash'], 'and they are still on the document');
  assert.deepEqual(preservedGroups(toEditorDoc({ id: 'p' })), []);

  assert.deepEqual(specIdsOutsideTemplate(d.spec_fields, ['build_volume', 'nozzle']), ['made_up_field']);
  assert.deepEqual(specIdsOutsideTemplate(d.spec_fields, []), ['build_volume', 'nozzle', 'made_up_field']);
  assert.deepEqual(specIdsOutsideTemplate(undefined, ['x']), []);
});

// -------------------------------------------------------- relationsFromWire

test('relationsFromWire: every row the API returns is shown — values per group in sort order, the orphaned value surfaced, names and provenance carried', () => {
  const rel = relationsFromWire(fullRelations());
  assert.equal(rel.inventory_mode, 'OPTION');
  assert.deepEqual(rel.groups.map((g) => g.name_en), ['Model', 'Nozzle', '']);
  assert.deepEqual(rel.groups[0].values.map((v) => v.id), ['ov_a', 'ov_b']);
  assert.deepEqual(rel.groups[1].values.map((v) => v.id), ['ov_n']);
  // The orphan: stored under a group id the response does not carry.
  assert.deepEqual(rel.groups[2].values.map((v) => v.id), ['ov_orphan']);
  assert.equal(rel.groups[2].id, 'og_gone');
  assert.equal(rel.hydration_issues?.length, 1);
  assert.match(rel.hydration_issues![0], /Hotend/);

  const a = rel.groups[0].values[0];
  assert.equal(a.name_ar, 'أ١');
  assert.equal(a.name_ckb, 'A1');
  assert.equal(a.stock, 3);
  assert.equal(a.low_stock_threshold, 1);
  assert.equal(a.availability_type, 'direct_sale');
  assert.equal(a.image, 'https://cdn/a1.jpg');
  const b = rel.groups[0].values[1];
  assert.equal(b.name_ar, 'أ١ كومبو');
  assert.equal(b.name_ckb, undefined, "an empty stored name is not carried as ''");
  assert.equal(b.regular_price_iqd, 550000);
  assert.equal(b.cost_iqd, 400000);
  assert.equal(b.lead_time_text, '2 weeks');
  assert.equal(b.lead_time_min_days, 10);
  assert.equal(b.variant_key, 'a1-combo');
  assert.equal(rel.groups[1].values[0].regular_adjust_iqd, 5000);
  assert.equal(rel.groups[1].values[0].active, false);

  assert.equal(rel.colors.length, 1);
  assert.deepEqual(rel.colors[0].option_value_ids, ['ov_a', 'ov_b']);
  assert.equal(rel.colors[0].name_ar, 'أخضر');
  assert.equal(rel.colors[0].stock, 2);

  assert.deepEqual(rel.variants[0].option_value_ids, ['ov_a']);
  assert.equal(rel.variants[0].color_id, 'col_1');
  assert.equal(rel.variants[0].sku, 'A1-GR');

  assert.equal(rel.images.length, 2);
  const img = rel.images[0];
  assert.equal(img.is_primary, true);
  assert.equal(img.alt_ar, 'صورة');
  assert.equal(img.alt_ckb, 'وێنە');
  assert.equal(img.r2_key, 'r2/1');
  assert.equal(img.source_url, 'https://vendor/1');
  assert.equal(img.option_value_id, 'ov_a');
  assert.equal(rel.images[1].color_id, 'col_1');
  assert.equal(rel.images[1].source_url, '');
  assert.equal(rel.images[1].alt_ar, undefined);
});

test('relationsToWire: what was read is sent back — the form never blanks a stored ar/ckb name or image provenance it does not edit', () => {
  const rel = relationsFromWire(fullRelations());
  const wire = relationsToWire(rel);
  const a = wire.groups[0].values[0];
  assert.equal(a.name_ar, 'أ١');
  assert.equal(a.name_ckb, 'A1');
  assert.equal(wire.groups[0].values[1].name_ckb, '');
  assert.equal(wire.colors[0].name_ar, 'أخضر');
  assert.equal(wire.images[0].alt_ar, 'صورة');
  assert.equal(wire.images[0].alt_ckb, 'وێنە');
  assert.equal(wire.images[0].r2_key, 'r2/1');
  assert.equal(wire.images[0].source_url, 'https://vendor/1');
  assert.equal(wire.images[1].r2_key, '');
  // Sort is array position, groups keep their order, the orphan group is sent
  // so the next save writes the missing row.
  assert.deepEqual(wire.groups.map((g) => g.sort), [0, 1, 2]);
  assert.equal(wire.groups[2].id, 'og_gone');
  // The PUT states the mode the stock placement implies (deriveInventoryMode):
  // the fixture's colour carries stock, so COLOR — the loaded OPTION is not
  // echoed back blindly.
  assert.equal(wire.inventory_mode, 'COLOR');
});

test('relationsFromWire: an empty response is empty — no invented group, colour or image', () => {
  const rel = relationsFromWire({ success: true, product: { inventory_mode: 'BASE' } });
  assert.deepEqual(rel, {
    inventory_mode: 'BASE', groups: [], colors: [], variants: [], images: [], quarantined_images: [],
  });
  assert.equal(hasRelationStructure(rel), false);
});

// --------------------------------------------------------- relationsFromDoc

test('relationsFromDoc: the document copy the storefront sells from becomes form state under the same ids, grouped by group_en, links and bindings to missing ids dropped', () => {
  const doc = fullDoc();
  const rel = relationsFromDoc(doc);
  assert.equal(docHasStructure(doc), true);
  assert.deepEqual(rel.groups.map((g) => g.name_en), ['Model', 'Nozzle']);
  assert.deepEqual(rel.groups[0].values.map((v) => v.id), ['ov_a', 'ov_b']);
  assert.deepEqual(rel.groups[0].values.map((v) => v.sort), [0, 1]);
  assert.equal(rel.groups[0].values[0].name_ar, 'أ١');
  // CARRIED VERBATIM, even when it equals the English name. The old rule
  // dropped it as a "fake translation" — but `relationsFromDoc` only ever runs
  // on a product with NO relation rows, so the document IS the raw JSON and
  // nothing has copied English into those slots; and in this catalogue an
  // Arabic or Kurdish option name is routinely a latin model token ('A1',
  // '0.4mm'). Dropping it made `relationsToWire` send '' and the writer, which
  // now honours an explicit clear, BLANKED the row on the first save
  // (docs/TXT_IMPORT_PARITY.md, root cause 7 — client twin).
  assert.equal(rel.groups[0].values[0].name_ckb, 'A1', 'a stored ckb name is carried even when it equals the English one');
  assert.equal(rel.groups[0].values[0].stock, 3);
  assert.equal(rel.groups[0].values[0].availability_type, 'direct_sale');
  assert.equal(rel.groups[0].values[1].regular_price_iqd, 550000);
  assert.equal(rel.groups[0].values[1].lead_time_text, '2 weeks');
  assert.equal(rel.groups[1].values[0].regular_adjust_iqd, 5000);
  assert.equal(rel.groups[1].values[0].active, false);

  assert.equal(rel.colors[0].id, 'col_1');
  assert.deepEqual(rel.colors[0].option_value_ids, ['ov_a', 'ov_b'], 'a link to an id the document does not hold is not shown');
  assert.equal(rel.colors[0].name_ckb, 'سەوز');
  assert.equal(rel.colors[0].stock, 2);

  assert.equal(rel.images.length, 2);
  assert.equal(rel.images[0].is_primary, true);
  assert.equal(rel.images[1].is_primary, false);
  assert.equal(rel.images[0].option_value_id, 'ov_a');
  assert.equal(rel.images[1].color_id, 'col_1');
  assert.equal(rel.images[0].alt_ar, 'صورة');
  assert.equal(rel.images[0].r2_key, 'r2/1');
  assert.equal(rel.images[0].width, 800);
  assert.deepEqual(rel.variants, [], 'the document never carries combinations');
  // Colour stock present → COLOR wins, exactly as deriveInventoryMode says.
  assert.equal(rel.inventory_mode, 'COLOR');
  assert.equal(deriveInventoryMode(rel), 'COLOR');
});

test('relationsFromDoc: values naming no group join the first group, or a group called Options; no primary flag → the first image is primary', () => {
  const rel = relationsFromDoc({
    options: [
      { id: 'o1', name_ar: 'س', name_en: 'S', name_ckb: '', image: '', order: 0, active: true, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      { id: 'o2', name_ar: 'ل', name_en: 'L', name_ckb: '', image: '', order: 1, active: true, regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
    ],
    colors: [],
    media: [
      { id: 'm2', url: 'u2', role: 'gallery', key: '', alt_ar: '', alt_en: '', alt_ckb: '', primary: false, order: 1, width: null, height: null, source_url: '' },
      { id: 'm1', url: 'u1', role: 'gallery', key: '', alt_ar: '', alt_en: '', alt_ckb: '', primary: false, order: 0, width: null, height: null, source_url: '' },
    ],
  });
  assert.deepEqual(rel.groups.map((g) => [g.name_en, g.values.length]), [['Options', 2]]);
  assert.deepEqual(rel.images.map((i) => [i.id, i.is_primary]), [['m1', true], ['m2', false]]);
  assert.equal(rel.inventory_mode, 'BASE');
});

test('hydrateRelations: rows win; with no rows the document copy is shown and the fallback is stated; with neither the state is empty', () => {
  const doc = fullDoc();
  const fromRows = hydrateRelations(fullRelations(), doc);
  assert.equal(fromRows.groups[0].id, 'og_model', 'relation rows take precedence over the document');
  assert.equal(fromRows.variants.length, 1);

  const empty: RelationsResponse = { success: true, product: { inventory_mode: 'BASE' }, groups: [], values: [], colors: [], links: [], variants: [], images: [] };
  const fromDoc = hydrateRelations(empty, doc);
  assert.equal(fromDoc.groups.length, 2);
  assert.equal(fromDoc.colors.length, 1);
  assert.equal(fromDoc.images.length, 2);
  assert.equal(fromDoc.hydration_issues?.length, 1);
  assert.match(fromDoc.hydration_issues![0], /\(3\).*\(1\).*\(2\)/, 'the notice names the counts read from the document');

  const none = hydrateRelations(empty, { options: [], colors: [], media: [] });
  assert.equal(hasRelationStructure(none), false);
  assert.equal(none.hydration_issues, undefined);
});

// ------------------------------------------------------------ apply result

test('summarizeApply / verificationLine: counts are the read-back numbers; a missing block is "unreported", never 0', () => {
  const full = summarizeApply(fullApply());
  assert.equal(full.reported, true);
  assert.deepEqual([full.groups, full.values, full.colors, full.links, full.images, full.variants], [2, 4, 1, 2, 3, 0]);
  assert.equal(full.inventory_mode, 'OPTION');
  assert.equal(full.primary_image, 'img_1');
  assert.equal(full.spec_stored, 7);
  assert.equal(full.spec_visible, 6);
  assert.deepEqual(full.spec_outside, ['made_up_field']);
  assert.deepEqual(full.requested, { images: 3, option_groups: 2, option_values: 4, colors: 1 });
  const line = verificationLine(full, WORDS);
  assert.equal(line, '2 groups · 4 values · 1 colours · 2 links · 3 images · 7 specs (6 visible) · inventory OPTION');

  // An older server (no verification block): nothing is counted as zero.
  const legacy = summarizeApply({ created: true, product_id: 'p', applied_fields: [], cleared_fields: [], preserved_fields: [], warnings: [] });
  assert.equal(legacy.reported, false);
  assert.equal(legacy.groups, null);
  assert.equal(legacy.images, null);
  assert.equal(verificationLine(legacy, WORDS), WORDS.unreported);
  assert.doesNotMatch(verificationLine(legacy, WORDS), /\b0\b/);

  // A block with one count missing writes "?" for that count, not 0.
  const partial = summarizeApply({ relations: { groups: 1, values: 2 } as ApplyResponse['relations'] });
  assert.match(verificationLine(partial, WORDS), /^1 groups · 2 values · \? colours · \? links · \? images$/);
  assert.equal(summarizeApply(null).reported, false);
});

test('applyOutcome: created / updated / skipped follow the response; ANY mismatch is a failure named by section, whatever created says', () => {
  const words = { alreadyApplied: 'already applied', mismatched: 'Section not stored:' };
  const ok = applyOutcome(fullApply(), words);
  assert.equal(ok.action, 'created');
  assert.equal(ok.productId, 'prod_txt1');
  assert.equal(ok.detail, 'prod_txt1');
  assert.deepEqual(ok.unknownKeys, ['options.1.colour']);
  assert.deepEqual(ok.warnings, ['status forced to draft']);
  assert.deepEqual([ok.appliedFields.length, ok.preservedFields.length, ok.clearedFields.length], [4, 1, 1]);
  assert.equal(ok.verify.images, 3);

  assert.equal(applyOutcome({ ...fullApply(), created: false }, words).action, 'updated');
  const skipped = applyOutcome({ ...fullApply(), already_applied: true }, words);
  assert.equal(skipped.action, 'skipped');
  assert.equal(skipped.detail, 'already applied');

  const bad = applyOutcome(
    {
      ...fullApply(),
      relations: { ...fullApply().relations!, values: 0, groups: 0 },
      mismatches: [
        { section: 'options', key: 'values', requested: 4, stored: 0 },
        { section: 'images', key: 'count', requested: 3, stored: 0 },
      ],
    },
    words
  );
  assert.equal(bad.action, 'failed');
  assert.match(bad.detail, /^Section not stored: options, images — options\.values: requested 4, stored 0 ; images\.count: requested 3, stored 0$/);
  assert.equal(bad.productId, 'prod_txt1', 'the product exists — the row still names it');
  assert.deepEqual(mismatchSections(bad.mismatches), ['options', 'images']);
  assert.equal(mismatchText([]), '');
  assert.equal(mismatchText([{ section: 'scalars', key: 'sku', requested: null, stored: { a: 1 } }]), 'scalars.sku: requested —, stored {"a":1}');
});

test('applyFailure: the server message is shown verbatim; APPLY_VERIFY_FAILED adds the product id and the mismatch list from details', () => {
  const words = { duplicate: 'Duplicate', inProgress: 'In progress', productExists: 'the product exists:' };
  const verify = applyFailure(
    new ApiError(500, 'options: requested 3 values, stored 0', 'APPLY_VERIFY_FAILED', {
      product_id: 'prod_new',
      created: true,
      mismatches: [{ section: 'options', key: 'values', requested: 3, stored: 0 }],
      relations: { groups: 1, values: 0, colors: 0, links: 0, variants: 0, images: 2, primary_image: null, inventory_mode: 'BASE' },
      warnings: ['w1'],
      unknown_keys: ['zzz'],
    }),
    words
  );
  assert.equal(verify.action, 'failed');
  assert.equal(verify.productId, 'prod_new');
  assert.match(verify.detail, /^options: requested 3 values, stored 0/);
  assert.match(verify.detail, /options\.values: requested 3, stored 0/);
  assert.match(verify.detail, /the product exists: prod_new/);
  assert.equal(verify.verify.reported, true);
  assert.equal(verify.verify.values, 0);
  assert.equal(verify.verify.images, 2);
  assert.deepEqual(verify.warnings, ['w1']);
  assert.deepEqual(verify.unknownKeys, ['zzz']);

  const dup = applyFailure(new ApiError(409, 'dup', 'DUPLICATE'), words);
  assert.equal(dup.detail, 'Duplicate');
  assert.equal(dup.verify.reported, false);
  const busy = applyFailure(new ApiError(409, 'busy', 'APPLY_IN_PROGRESS'), words);
  assert.equal(busy.detail, 'In progress');
  const refused = applyFailure(new ApiError(400, 'name_ar is required (NEEDS_REVIEW)', 'NEEDS_REVIEW'), words);
  assert.equal(refused.detail, 'name_ar is required (NEEDS_REVIEW)', 'a refusal is shown verbatim');
  assert.equal(applyFailure(new Error('network down'), words).detail, 'Error: network down');
});

test('summarizeApply: the spec report and a "requested nothing" count are read as the server states them', () => {
  const v = summarizeApply(fullApply());
  assert.equal(v.spec_family, 'devices');
  assert.deepEqual(v.spec_warnings, ['spec.made_up_field: not a field of this section']);

  // An update that wrote no structure: requested is null (not asked), stored
  // is the number of rows the product still has.
  const untouched = summarizeApply({
    ...fullApply(),
    images: { requested: null, stored: 3 },
    option_groups: { requested: null, stored: 2 },
    option_values: { requested: null, stored: 4 },
    colors: { requested: null, stored: 1 },
  });
  assert.deepEqual(untouched.requested, { images: null, option_groups: null, option_values: null, colors: null });
  assert.equal(untouched.values, 4, 'the stored counts still come from the read-back');

  // The confirm-once answer carries the relation counts and nothing else.
  const repeat = summarizeApply({
    success: true,
    already_applied: true,
    created: false,
    product_id: 'prod_txt1',
    product: null,
    applied_fields: [],
    cleared_fields: [],
    preserved_fields: [],
    unknown_keys: [],
    warnings: ['already applied'],
    relations: fullApply().relations,
    mismatches: [],
  });
  assert.equal(repeat.reported, true);
  assert.equal(repeat.values, 4);
  assert.equal(repeat.spec_stored, null, 'a block the answer omits is unreported, never 0');
});

test('applyFailure: the refusal body reaches the row even though the route sends it at the TOP LEVEL, not under details', () => {
  const words = { duplicate: 'Duplicate', inProgress: 'In progress', productExists: 'the product exists:' };
  // Exactly what worker/routes/template.ts `refused()` produces: success:false
  // plus the verification block, flat. src/lib/api.ts hands it to ApiError as
  // `body`; `details` is absent.
  const body = {
    success: false,
    code: 'APPLY_VERIFY_FAILED',
    error: 'options: requested 3, stored 0 (values)',
    section: 'options',
    field: 'values',
    expected: 3,
    stored: 0,
    product_id: 'prod_txt1',
    created: false,
    mismatches: [{ section: 'options' as const, key: 'values', requested: 3, stored: 0 }],
    relations: { groups: 1, values: 0, colors: 0, links: 0, variants: 0, images: 2, primary_image: null, inventory_mode: 'BASE' },
    spec_fields: { stored: 7, visible_in_form: 6, outside_section: ['made_up_field'], family: 'devices', warnings: [] },
    warnings: ['status forced to draft'],
    unknown_keys: ['options.1.colour'],
  };
  const out = applyFailure(new ApiError(500, body.error, body.code, undefined, body), words);
  assert.equal(out.action, 'failed');
  assert.equal(out.productId, 'prod_txt1');
  assert.match(out.detail, /^options: requested 3, stored 0 \(values\)/, 'the message is verbatim, section first');
  assert.match(out.detail, /options\.values: requested 3, stored 0/);
  assert.match(out.detail, /the product exists: prod_txt1/);
  assert.equal(out.verify.reported, true);
  assert.equal(out.verify.values, 0);
  assert.equal(out.verify.images, 2);
  assert.equal(out.verify.spec_stored, 7);
  assert.deepEqual(out.warnings, ['status forced to draft']);
  assert.deepEqual(out.unknownKeys, ['options.1.colour']);
});

test('applyFailure: a refused write names its section and lists every row-level reason', () => {
  const words = { duplicate: 'Duplicate', inProgress: 'In progress', productExists: 'the product exists:' };
  const relations = applyFailure(
    new ApiError(400, 'colors.1.hex: not a colour', 'RELATIONS_VALIDATION', undefined, {
      code: 'RELATIONS_VALIDATION',
      error: 'colors.1.hex: not a colour',
      section: 'relations',
      field: 'colors.1.hex',
      errors: ['colors.1.hex: not a colour', 'options.2.name_en: required'],
      warnings: [],
      unknown_keys: [],
    }),
    words
  );
  assert.equal(relations.detail, 'relations.colors.1.hex: colors.1.hex: not a colour');
  assert.deepEqual(relations.issues, ['colors.1.hex: not a colour', 'options.2.name_en: required']);
  assert.equal(relations.verify.reported, false, 'a refusal before the write reports no counts');

  const review = applyFailure(
    new ApiError(400, 'Template needs review — nothing was written', 'NEEDS_REVIEW', undefined, {
      code: 'NEEDS_REVIEW',
      error: 'Template needs review — nothing was written',
      needs_review: [{ key: 'brand', line: 12, value: 'bambu-lab', message: 'unknown brand' }],
      unknown_keys: ['options.1.colour'],
    }),
    words
  );
  assert.equal(review.detail, 'Template needs review — nothing was written');
  assert.deepEqual(review.issues, ['12: brand="bambu-lab" — unknown brand']);
  assert.deepEqual(review.unknownKeys, ['options.1.colour']);

  const errs = applyFailure(
    new ApiError(400, 'Template has errors — nothing was written', 'TEMPLATE_ERRORS', undefined, {
      errors: [{ line: 4, key: 'price_iqd', message: 'must be a whole number of dinars' }],
    }),
    words
  );
  assert.deepEqual(errs.issues, ['4: price_iqd — must be a whole number of dinars']);
  // A 200 outcome carries no refusal issues.
  assert.deepEqual(applyOutcome(fullApply(), { alreadyApplied: 'a', mismatched: 'm' }).issues, []);
});

// ------------------------------------------------------------ static checks

test('ApplyResponse mirrors the verified result the apply route returns (parity §5.2) — every field the counters read is declared', () => {
  const src = read('src/components/adminProducts/types.ts');
  const block = src.slice(src.indexOf('export interface ApplyResponse'), src.indexOf('export interface ApplyVerifyFailure'));
  for (const key of ['success: true', 'created', 'product_id', 'applied_fields', 'cleared_fields', 'preserved_fields', 'unknown_keys', 'warnings', 'relations: ApplyRelationSummary | null', 'spec_fields?: ApplySpecReport', 'images?: ApplyCount', 'option_groups?: ApplyCount', 'option_values?: ApplyCount', 'colors?: ApplyCount', 'mismatches: ApplyMismatch[]', 'price_history_rows', 'hashtags_registered', 'translation_review_needed']) {
    assert.ok(block.includes(key), `ApplyResponse.${key}`);
  }
  const summary = src.slice(src.indexOf('export interface ApplyRelationSummary'), src.indexOf('export interface ApplyCount'));
  for (const key of ['groups', 'values', 'colors', 'links', 'variants', 'images', 'primary_image', 'inventory_mode']) {
    assert.match(summary, new RegExp(`\\b${key}:`), `ApplyRelationSummary.${key}`);
  }
  // The counted collections: "requested" is nullable because an update that
  // wrote no structure requested nothing — that is not "zero stored".
  assert.match(src, /export interface ApplyCount \{\s*requested: number \| null;\s*stored: number;/);
  // The spec report is the server's, family and per-field notes included.
  const spec = src.slice(src.indexOf('export interface ApplySpecReport'), src.indexOf('export type ApplyMismatchSection'));
  for (const key of ['stored', 'visible_in_form', 'outside_section', 'family', 'warnings']) {
    assert.match(spec, new RegExp(`\\b${key}:`), `ApplySpecReport.${key}`);
  }
  assert.match(src, /section: ApplyMismatchSection/);
  // Every section worker/lib/productPersistence.ts Mismatch can name.
  const union = src.slice(src.indexOf('export type ApplyMismatchSection'), src.indexOf('/** One requested value'));
  for (const sec of ['scalars', 'options', 'colors', 'images', 'variants', 'spec', 'catalogs', 'inventory', 'slug']) {
    assert.ok(union.includes(`'${sec}'`), `ApplyMismatchSection ${sec}`);
  }
  const worker = read('worker/lib/productPersistence.ts');
  const serverUnion = worker.slice(worker.indexOf('export interface Mismatch'), worker.indexOf('export interface Mismatch') + 400);
  for (const sec of ['scalars', 'options', 'colors', 'images', 'variants', 'spec', 'catalogs', 'inventory', 'slug']) {
    assert.ok(serverUnion.includes(`'${sec}'`), `the server still names ${sec}`);
  }
  // The refusal body the route sends at the TOP LEVEL, not under `details`.
  const fail = src.slice(src.indexOf('export interface ApplyVerifyFailure'), src.indexOf('export interface ZipFileResult'));
  for (const key of ['code', 'error', 'section', 'field', 'expected', 'stored', 'product_id', 'created', 'mismatches', 'relations', 'errors', 'needs_review', 'warnings', 'unknown_keys']) {
    assert.match(fail, new RegExp(`\\b${key}\\??:`), `ApplyVerifyFailure.${key}`);
  }
  assert.match(read('src/lib/api.ts'), /public body\?: Record<string, unknown>/, 'ApiError carries the refusal body');
});

test('ImportPanel: the ids OUTSIDE the section template get their own word, and the check step states the plan before the write', () => {
  const src = read('src/components/adminProducts/ImportPanel.tsx');
  // TWO DIFFERENT THINGS, TWO DIFFERENT WORDS. `outside` is the parenthetical
  // in verificationLine — «5 spec fields (3 visible in the form)» — and named
  // the count the template DOES render. Reusing it for `spec_outside`, the ids
  // the template does NOT render, told the admin the exact opposite about the
  // one thing §5.4 asks the panel to be honest about.
  assert.match(src, /outside: 'ظاهرة في النموذج', outsideSection: 'خارج قالب القسم'/);
  assert.match(src, /outside: 'visible in the form', outsideSection: 'outside the section template'/);
  assert.match(src, /\{t\.vw\.outsideSection\}: \{v\.spec_outside\.length\}/);
  assert.doesNotMatch(src, /\{t\.vw\.outside\}: −/, 'the visible-in-the-form word never labels the hidden ids');

  const ar = src.slice(src.indexOf("vw: { groups: 'مجموعة'"), src.indexOf('mismatched:'));
  const en = src.slice(src.indexOf("vw: { groups: 'groups'"), src.indexOf("mismatched: 'Section not stored:'"));
  for (const [lang, block] of [['ar', ar], ['en', en]] as const) {
    const outside = /outside: '([^']+)'/.exec(block)?.[1];
    const outsideSection = /outsideSection: '([^']+)'/.exec(block)?.[1];
    assert.ok(outside && outsideSection && outside !== outsideSection, `${lang}: the two words must differ`);
  }

  // §7.3: /parse and /parse-zip both answer with the spec report and the
  // planned stock level, and the check report now RENDERS them — the claim
  // that the check step says what the apply will do is true or it is not made.
  assert.match(src, /plan: planOf\(res\.spec_fields, res\.inventory_mode\)/);
  assert.match(src, /plan: planOf\(f\.spec_fields, f\.inventory_mode\)/);
  assert.match(src, /data-import-plan=/);
  assert.match(src, /function planLine\(/);
  assert.match(read('worker/routes/template.ts'), /inventory_mode: plannedInventoryMode\(a, !!a\.existing\),[\s\S]{0,80}summary:/);
});

test('ProductForm: emptying an outside-template spec really deletes the key, and the counters stop counting it', () => {
  const src = read('src/components/adminProducts/ProductForm.tsx');
  // «أفرغ القيمة لحذف الحقل» used to be false: the key was stored with an
  // empty value, so the field came back on every reload and every counter kept
  // counting it. The hint is now what the code does.
  assert.match(src, /hint="أفرغ القيمة لحذف الحقل"/);
  assert.match(src, /delete rest\[id\];/);
  assert.match(src, /spec_fields: e\.target\.value \? \{ \.\.\.rest, \[id\]: e\.target\.value \} : rest/);
  assert.match(src, /Object\.values\(doc\.spec_fields \?\? \{\}\)\.filter\(\(v\) => \(v \?\? ''\)\.trim\(\) !== ''\)\.length/);
  // And the English label slot carries ENGLISH — the only Field in the form
  // that had Arabic in the ar/en convention's English half.
  assert.match(src, /en="Outside this section's template"/);
  assert.doesNotMatch(src, /en="خارج القالب/);
});

test('ImportPanel: the result row is the server read-back — never the file text — and unknown keys need an explicit acknowledgement', () => {
  const src = read('src/components/adminProducts/ImportPanel.tsx');
  const applyTxt = src.slice(src.indexOf('async function applyTxt'), src.indexOf('function mergeResults'));
  assert.doesNotMatch(applyTxt, /countTxtImages/, 'the apply lane must not count images from the file');
  assert.match(applyTxt, /applyOutcome\(out/);
  assert.match(applyTxt, /applyFailure\(e/);
  assert.match(applyTxt, /summary\[outcome\.action\] \+= 1/, 'a mismatched 200 counts as failed in the summary');
  assert.match(src, /verificationLine\(v, t\.vw/);
  assert.match(src, /data-import-verify=\{v\.reported \? 'reported' : 'unreported'\}/);
  assert.match(src, /!v\.reported && o\.action !== 'failed' && <p className="text-amber-300">\{t\.verifyUnreported\}/);
  assert.match(src, /data-import-unknown-keys/);
  assert.match(src, /data-import-apply-warnings/);
  // A refusal's row-level reasons (validation errors, unresolved references)
  // are listed under the row, not swallowed by the one-line message.
  assert.match(src, /data-import-apply-issues/);
  assert.match(src, /t\.fieldsLine, \{ a: o\.appliedFields\.length, p: o\.preservedFields\.length, c: o\.clearedFields\.length \}/);
  // Unknown keys: reported at check time and acknowledged before the import.
  assert.match(src, /unknownKeys: res\.unknown_keys \?\? \[\]/);
  assert.match(src, /unknownKeys: f\.unknown_keys \?\? \[\]/);
  assert.match(src, /if \(unknownKeysPending\.length > 0 && !ackUnknown\) \{ setErr\(t\.ackRequired\); return; \}/);
  assert.match(src, /const canImport = importable > 0 && \(unknownKeysPending\.length === 0 \|\| ackUnknown\)/);
  assert.match(src, /data-import="ack-unknown-input"/);
  // Every string exists in both languages.
  const ar = src.slice(src.indexOf('  ar: {'), src.indexOf('  en: {'));
  const en = src.slice(src.indexOf('  en: {'), src.indexOf('type Strings'));
  for (const key of ['verifyTitle', 'verifyUnreported', 'vw', 'mismatched', 'productExists', 'fieldsLine', 'warningsAtApply', 'unknownAtApply', 'ackUnknown', 'ackRequired', 'openInForm']) {
    assert.match(ar, new RegExp(`\\n\\s+${key}:`), `ar.${key}`);
    assert.match(en, new RegExp(`\\n\\s+${key}:`), `en.${key}`);
  }
  // The result table offers the form, and the host wires it.
  assert.match(src, /onOpenProduct\(r\.outcome!\.productId\)/);
  assert.match(read('src/components/AdminProducts.tsx'), /onOpenProduct=\{\(id\) => \{\s*closeImport\(\);\s*setEditing\(\{ open: true, id \}\);/);
});

test('ProductForm: loads through hydrateRelations, keeps a stored section/family, gates warranty on catalog_ids too, and renders the stored groups', () => {
  const src = read('src/components/adminProducts/ProductForm.tsx');
  assert.match(src, /const rs = hydrateRelations\(r, p\.product\)/);
  assert.match(src, /data-form="hydration-issues"/);
  // template_family: fill when empty, never overwrite.
  assert.match(src, /setDoc\(\(d\) => \(d\.template_family \? d : \{ \.\.\.d, template_family: res\.template_family \}\)\)/);
  assert.doesNotMatch(src, /res\.template_family !== doc\.template_family/);
  assert.match(src, /data-form="adopt-section-family"/);
  // Catalog selects keep the stored (possibly inactive) section.
  assert.match(src, /c\.active \|\| c\.id === doc\.category_id/);
  assert.match(src, /c\.id === doc\.sub_category_id/);
  // Printer identity from the catalogs list as well as the section pair.
  assert.match(src, /doc\.catalog_ids\.includes\(c\.id\)/);
  // Specs outside the template, preserved groups, imported texts, gated values.
  assert.match(src, /specIdsOutsideTemplate\(doc\.spec_fields, templateFieldIds\)/);
  assert.match(src, /data-form="spec-outside-template"/);
  assert.match(src, /data-form="preserved-groups"/);
  assert.match(src, /data-form="imported-texts"/);
  // Product-level fulfilment controls were retired: direct/pre-order pricing
  // and availability now live on each option, so hidden legacy values must not
  // recreate the removed surcharge/transport UI.
  assert.doesNotMatch(src, /data-form="surcharge-preserved"/);
  assert.doesNotMatch(src, /data-form="transports-preserved"/);
  const options = read('src/components/adminProducts/form/OptionsSection.tsx');
  assert.match(options, /value\.fulfillments\.find\(\(f\) => f\.fulfillment_type === type\)/);
  assert.match(src, /data-form="warranty-preserved"/);
  assert.match(src, /data-form="payment-options-preserved"/);
  // The stored specs render even when the section has no template.
  assert.match(src, /storedSpecCount > 0\s*\?\s*`\$\{storedSpecCount\} مواصفة محفوظة بلا قالب قسم`/);
  // One source on screen: the price preview lists what sections 5–6 show.
  assert.match(src, /<PricePreview productId=\{doc\.id\} savedDoc=\{doc\} rel=\{rel\} dirty=\{dirty\} \/>/);
  assert.match(read('src/components/adminProducts/PricePreview.tsx'), /hasRelationStructure\(rel\)/);
  // Stored placements and the struck-through price the form has no input for.
  assert.match(src, /data-form="catalogs-preserved"/);
  assert.match(src, /data-form="original-price-preserved"/);
  // Alt text authored in Arabic / Kurdish is shown beside the English input.
  assert.match(read('src/components/adminProducts/form/ImagesSection.tsx'), /data-form="image-imported-alt"/);
});

test('ProductForm: ONE request saves the document and the structure, and what is shown afterwards is READ BACK from the relations endpoint', () => {
  const src = read('src/components/adminProducts/ProductForm.tsx');
  const save = src.slice(src.indexOf('const save = async'), src.indexOf('const valueCount'));
  // ONE BATCH OR NOTHING. The structure travels WITH the document, because the
  // server plans both into a single db.batch; the old second request left a
  // bare product row behind whenever the relations were refused on a rule only
  // the server knows (docs/TXT_IMPORT_PARITY.md).
  assert.match(save, /relations: relationsToWire\(rel\)/, 'the structure is part of the create/update request');
  assert.doesNotMatch(save, /api\.put<[^>]*>\(\s*`\/api\/admin\/products\/\$\{savedId\}\/relations`/, 'no second write');
  assert.doesNotMatch(save, /حُفظ المنتج، لكن تعذّر حفظ/, 'a half-saved product can no longer happen, so the note is gone');
  // The derived copies of the structure never travel with the document: the
  // server rebuilds the JSON mirror from the rows this same request writes.
  assert.match(save, /const \{ options: _o, colors: _c, media: _m, \.\.\.docFields \} = next/);
  // The answer is a read-back, not an echo: the save response carries the
  // document, and the structure comes from the endpoint the form LOADS from.
  assert.match(save, /const fresh = await api\.get<RelationsResponse>\(`\/api\/admin\/products\/\$\{savedId\}\/relations`\)/);
  assert.match(save, /const savedRel = relationsFromWire\(fresh\)/, 'the rows are the truth right after a save');
  assert.doesNotMatch(save, /hydrateRelations/, 'the document fallback belongs to the load, never after a delete-and-save');
  assert.match(save, /setBaseline\(JSON\.stringify\(\{ d: freshDoc, rs: savedRel \}\)\)/, 'the baseline is what the server now holds');
  assert.match(save, /res\.warnings/, "the save's warnings are shown, not dropped");
  // A refusal names the ROW, not «Server error (400)».
  assert.match(save, /refusalIssues\(/, 'the row-level reasons in the refusal body reach the admin');
});
