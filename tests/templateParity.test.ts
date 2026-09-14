/**
 * TXT TEMPLATE ↔ PRODUCT FORM — the four integration tests of
 * docs/TXT_IMPORT_PARITY.md §5.5 (A create, B first relation on a legacy
 * product, C round trip, D result honesty), plus the semantics and guard
 * tests §5.1 pins.
 *
 * What separates this file from tests/templateApplyParity.test.ts (which
 * judges the database and the two admin endpoints) is the LAST hop: every
 * verdict here is taken after running the CLIENT transforms the admin form
 * runs — `toEditorDoc` over `GET /api/admin/products-v2/:id` and
 * `hydrateRelations` / `relationsFromWire` over
 * `GET /api/admin/products/:id/relations` — so a value that reaches the
 * database but not the screen still fails. That was the owner's complaint:
 * the import "succeeded" and the product opened empty.
 *
 * The rule the whole file is written under: parser success is not import
 * success. Nothing here asserts on a parse result; the parse endpoint is used
 * only where the round trip needs it (test C) and even there the verdict is
 * read back from the product afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, get, json, all, count, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { productRoutes } from '../worker/routes/products';
import { ApiError } from '../src/lib/api';
import { importedTexts, preservedGroups, specIdsOutsideTemplate, toEditorDoc } from '../src/components/adminProducts/types';
import type { ApplyResponse } from '../src/components/adminProducts/types';
import {
  deriveInventoryMode,
  hasRelationStructure,
  hydrateRelations,
  relationsFromWire,
  type RelationsResponse,
  type RelationsState,
} from '../src/components/adminProducts/form/model';
import { applyFailure, applyOutcome, summarizeApply, verificationLine } from '../src/components/adminProducts/applyResult';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };
const ASSISTANT = { id: 'usr_assist', role: 'admin' as const, email: 'helper@x.co', admin_scope: 'assistant' };

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
  a.route('/api/admin/taxonomy', adminTaxonomyRoutes);
  a.route('/api/products', productRoutes);
};

function setup(db?: unknown) {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو','Bambu Lab')").run();
  const handle = db ?? asD1(raw);
  return { raw, db: handle, app: stubApp(handle, OWNER, mount), assistant: stubApp(handle, ASSISTANT, mount) };
}

const put = (a: App, path: string, body: unknown) =>
  a.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify(body),
  });

const apply = async (a: App, text: string, mode: 'draft' | 'update' = 'draft', extra: Record<string, unknown> = {}) => {
  const res = await post(a, '/api/admin/template/apply', { text, mode, confirm: true, ...extra });
  return { status: res.status, body: await json(res) };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>;

/**
 * EXACTLY what ProductForm does on open: the two GETs, then `toEditorDoc` and
 * `hydrateRelations`. Everything asserted below is read off `doc` / `rel` —
 * the React state itself — not off the wire.
 */
async function formState(a: App, id: string) {
  const p = await json(await get(a, `/api/admin/products-v2/${id}`));
  const r = await json(await get(a, `/api/admin/products/${id}/relations`));
  assert.equal(p.success, true, `products-v2 GET failed: ${JSON.stringify(p)}`);
  assert.equal(r.success, true, `relations GET failed: ${JSON.stringify(r)}`);
  const doc = toEditorDoc(p.product as Wire);
  const rel = hydrateRelations(r as RelationsResponse, p.product as Wire);
  return { wireDoc: p.product as Wire, wireRel: r as Wire, doc, rel };
}

/** The spec ids the section's template declares — the form's own source. */
async function templateFieldIds(a: App, categoryId: string): Promise<string[]> {
  const res = await json(await get(a, `/api/admin/taxonomy/templates?category=${encodeURIComponent(categoryId)}`));
  return ((res.groups ?? []) as Array<{ fields: Array<{ id: string }> }>).flatMap((g) => g.fields.map((f) => f.id));
}

const tableCounts = (raw: DatabaseSync, id: string) => ({
  groups: count(raw, 'SELECT COUNT(*) AS n FROM product_option_groups WHERE product_id = ?', id),
  values: count(raw, 'SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = ?', id),
  colors: count(raw, 'SELECT COUNT(*) AS n FROM product_colors WHERE product_id = ?', id),
  links: count(
    raw,
    'SELECT COUNT(*) AS n FROM product_color_option_links l JOIN product_colors c ON c.id = l.color_id WHERE c.product_id = ?',
    id
  ),
  images: count(raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', id),
  catalogs: count(raw, 'SELECT COUNT(*) AS n FROM product_catalogs WHERE product_id = ?', id),
});

const allValues = (rel: RelationsState) => rel.groups.flatMap((g) => g.values);

// =========================================================================
// The file test A applies: every section of the template in one product.
// =========================================================================

const A_TXT = `template_version=2
slug=parity-full
name_ar=طابعة كاملة
name_en=Full Parity Printer
name_ckb=چاپکەری تەواو
status=draft
description_ar=وصف عربي كتبه المالك
description_en=Owner-written English description
description_ckb=وەسفی کوردی نووسراو
how_to_use=Level the bed, load filament, print.
price_iqd=500000
pro_price_iqd=450000
prime_price_iqd=480000
original_price_iqd=650000
brand=bambu
catalogs=printers,fdm-printers
category=printers
sub_category=fdm-printers
template_family=devices
sku=FULL-PARITY-01
hashtags=bambu,parity
is_featured=true
display_order=4
selling_type=mixed
stock=9
low_stock_threshold=2
inventory_mode=OPTION
direct_surcharge_iqd=15000
payment_options=cod,card,wallet
transports.1.method=air
transports.1.commission_iqd=25000
transports.1.active=true
transports.2.method=sea
transports.2.commission_iqd=9000
transports.2.active=true
images.1.id=img_front
images.1.url=https://example.com/front.jpg
images.1.alt_ar=الواجهة
images.1.alt_en=Front
images.1.alt_ckb=پێشەوە
images.1.primary=true
images.1.key=products/front.jpg
images.1.source_url=https://vendor.example/front.jpg
images.1.width=1200
images.1.height=900
images.2.id=img_combo
images.2.url=https://example.com/combo.jpg
images.2.alt_en=Combo
images.2.option_value_id=opt_combo
images.3.id=img_black
images.3.url=https://example.com/black.jpg
images.3.alt_en=Black
images.3.color_id=col_black
options.1.id=opt_base
options.1.group=Model
options.1.name_ar=أساسي
options.1.name_en=A1
options.1.name_ckb=بنەڕەتی
options.1.active=true
options.1.stock=4
options.1.sku_part=A1
options.2.id=opt_combo
options.2.group=Model
options.2.name_ar=كومبو
options.2.name_en=A1 Combo
options.2.name_ckb=کۆمبۆ
options.2.active=true
options.2.regular_price_iqd=+150000
options.2.stock=3
options.3.id=opt_n04
options.3.group=Nozzle
options.3.name_ar=فوهة ٠٫٤
options.3.name_en=0.4mm
options.3.active=true
options.4.id=opt_n06
options.4.group=Nozzle
options.4.name_ar=فوهة ٠٫٦
options.4.name_en=0.6mm
options.4.active=false
options.4.regular_price_iqd=+25000
colors.1.id=col_black
colors.1.name_ar=أسود
colors.1.name_en=Black
colors.1.name_ckb=ڕەش
colors.1.hex=#000000
colors.1.option_ids=opt_base,opt_combo
colors.1.sku_part=BLK
colors.1.active=true
colors.1.regular_price_iqd=+5000
spec.technology=FDM
spec.model=A1
spec.build_volume=256 x 256 x 256
spec_groups.1.id=sg_general
spec_groups.1.title_ar=عام
spec_groups.1.title_en=General
spec_groups.1.rows.1.id=sr_weight
spec_groups.1.rows.1.label_ar=الوزن
spec_groups.1.rows.1.label_en=Weight
spec_groups.1.rows.1.value_en=8.3
spec_groups.1.rows.1.unit=kg
labels.1.id=lbl_w
labels.1.key=warranty_included
labels.1.text_ar=ضمان سنة
labels.1.text_en=1-year warranty
labels.1.visible=true
warranty_base_months=12
serialized=true
warranty_plans.1.id=wp_ext12
warranty_plans.1.title_ar=ضمان إضافي ١٢
warranty_plans.1.title_en=Extended +12
warranty_plans.1.duration_months=12
warranty_plans.1.duration_kind=extension
warranty_plans.1.fee_percent=7.5
warranty_plans.1.fee_iqd=0
warranty_plans.1.active=true
content_blocks.1.id=cb_text
content_blocks.1.kind=text
content_blocks.1.body_ar=كتلة محتوى عربية
content_blocks.1.body_en=English content block
usage_official_url=https://wiki.example/full
usage_steps.1.id=ustep_unbox
usage_steps.1.kind=setup
usage_steps.1.title=فك التغليف
usage_steps.1.body=أخرج الجهاز من الصندوق
usage_steps.2.id=ustep_print
usage_steps.2.kind=usage
usage_steps.2.title=الطباعة الأولى
usage_steps.2.body=اطبع نموذج الاختبار
`;

// =========================================================================
// TEST A — create from TXT, read back through the form's own eyes
// =========================================================================

test('TEST A: a TXT create fills EVERY section the file wrote, read back through the form transforms', async () => {
  const { raw, app } = setup();
  const { status, body } = await apply(app, A_TXT);
  assert.equal(status, 200, JSON.stringify(body));
  const id = body.product_id as string;

  // ---- the relation tables really hold the rows -------------------------
  assert.deepEqual(tableCounts(raw, id), { groups: 2, values: 4, colors: 1, links: 2, images: 3, catalogs: 2 });
  assert.deepEqual(
    all<{ id: string; name_en: string; name_ar: string; name_ckb: string }>(
      raw,
      'SELECT id, name_en, name_ar, name_ckb FROM product_option_values WHERE product_id = ? ORDER BY id',
      id
    ).map((v) => [v.id, v.name_en, v.name_ar, v.name_ckb]),
    [
      ['opt_base', 'A1', 'أساسي', 'بنەڕەتی'],
      ['opt_combo', 'A1 Combo', 'كومبو', 'کۆمبۆ'],
      ['opt_n04', '0.4mm', 'فوهة ٠٫٤', ''],
      ['opt_n06', '0.6mm', 'فوهة ٠٫٦', ''],
    ]
  );
  assert.deepEqual(
    all<{ option_value_id: string }>(
      raw,
      'SELECT option_value_id FROM product_color_option_links WHERE color_id = ? ORDER BY option_value_id',
      'col_black'
    ).map((l) => l.option_value_id),
    ['opt_base', 'opt_combo']
  );

  // ---- the form's own state --------------------------------------------
  const { doc, rel, wireDoc } = await formState(app, id);

  // Structure (sections 5 and 6): groups, values, colours, links, images.
  assert.equal(hasRelationStructure(rel), true);
  assert.deepEqual(rel.groups.map((g) => g.name_en), ['Model', 'Nozzle']);
  assert.deepEqual(rel.groups.map((g) => g.values.map((v) => v.name_en)), [['A1', 'A1 Combo'], ['0.4mm', '0.6mm']]);
  const base = allValues(rel).find((v) => v.id === 'opt_base')!;
  assert.equal(base.name_ar, 'أساسي');
  assert.equal(base.name_ckb, 'بنەڕەتی');
  assert.equal(base.stock, 4);
  assert.equal(base.sku_part, 'A1');
  assert.equal(base.active, true);
  const combo = allValues(rel).find((v) => v.id === 'opt_combo')!;
  assert.equal(combo.regular_adjust_iqd, 150000, 'a +N option price must reach the form as an adjustment');
  assert.equal(combo.stock, 3);
  assert.equal(allValues(rel).find((v) => v.id === 'opt_n06')!.active, false);

  assert.equal(rel.colors.length, 1);
  assert.equal(rel.colors[0].name_en, 'Black');
  assert.equal(rel.colors[0].name_ar, 'أسود');
  assert.equal(rel.colors[0].name_ckb, 'ڕەش');
  assert.equal(rel.colors[0].hex, '#000000');
  assert.equal(rel.colors[0].sku_part, 'BLK');
  assert.equal(rel.colors[0].regular_adjust_iqd, 5000);
  assert.deepEqual([...rel.colors[0].option_value_ids].sort(), ['opt_base', 'opt_combo']);

  assert.deepEqual(rel.images.map((i) => i.id), ['img_front', 'img_combo', 'img_black']);
  const front = rel.images[0];
  assert.equal(front.is_primary, true);
  assert.equal(front.url, 'https://example.com/front.jpg');
  assert.equal(front.alt_en, 'Front');
  assert.equal(front.alt_ar, 'الواجهة');
  assert.equal(front.alt_ckb, 'پێشەوە');
  assert.equal(front.r2_key, 'products/front.jpg');
  assert.equal(front.source_url, 'https://vendor.example/front.jpg');
  assert.equal(front.width, 1200);
  assert.equal(front.height, 900);
  assert.equal(rel.images[1].option_value_id, 'opt_combo');
  assert.equal(rel.images[2].color_id, 'col_black');

  // Stock level: the file said OPTION and the form derives the same.
  assert.equal(rel.inventory_mode, 'OPTION');
  assert.equal(deriveInventoryMode(rel), 'OPTION');
  assert.equal(body.relations.inventory_mode, 'OPTION');

  // Document half (sections 1-4, 7-9) as the editor holds it.
  assert.equal(doc.name_ar, 'طابعة كاملة');
  assert.equal(doc.name_en, 'Full Parity Printer');
  assert.equal(doc.name_ckb, 'چاپکەری تەواو');
  assert.equal(doc.description_ar, 'وصف عربي كتبه المالك');
  assert.equal(doc.description_en, 'Owner-written English description');
  assert.equal(doc.description_ckb, 'وەسفی کوردی نووسراو');
  assert.equal(doc.how_to_use, 'Level the bed, load filament, print.');
  assert.equal(doc.sku, 'FULL-PARITY-01');
  assert.equal(doc.template_family, 'devices');
  assert.equal(doc.category_id, 'cat_printers');
  assert.equal(doc.sub_category_id, 'cat_printers_fdm');
  assert.equal(doc.brand_id, 'brd_bambu');
  assert.deepEqual(doc.catalog_ids, ['cat_printers', 'cat_printers_fdm']);
  assert.equal(doc.stock, 9);
  assert.equal(doc.low_stock_threshold, 2);
  assert.equal(doc.original_price_iqd, 650000);
  assert.equal(doc.pro_price_iqd, 450000);
  assert.equal(doc.prime_price_iqd, 480000);
  assert.deepEqual(doc.hashtags, ['bambu', 'parity']);
  assert.deepEqual(doc.payment_options, ['cod', 'card', 'wallet']);
  assert.deepEqual([...doc.sale_types].sort(), ['direct_sale', 'pre_order'], 'selling_type=mixed must reach the form as both sale types');
  assert.equal(doc.direct_surcharge_iqd, 15000);
  assert.deepEqual(
    doc.preorder_transports.filter((t) => t.active).map((t) => [t.method, t.commission_iqd]),
    [['air', 25000], ['sea', 9000]]
  );
  assert.deepEqual(doc.spec_fields, { technology: 'FDM', model: 'A1', build_volume: '256 x 256 x 256' });
  assert.equal(doc.spec_groups.length, 1);
  assert.equal(doc.spec_groups[0].rows?.length, 1);
  assert.equal(doc.spec_groups[0].rows?.[0].unit, 'kg');
  assert.equal(doc.labels.length, 1);
  assert.equal(doc.labels[0].key, 'warranty_included');
  assert.equal(doc.warranty_base_months, 12);
  assert.equal(doc.serialized, true);
  assert.equal(doc.warranty_plans.length, 1);
  assert.equal(doc.warranty_plans[0].duration_months, 12);
  assert.equal(doc.warranty_plans[0].fee_percent, 7.5);
  assert.equal(doc.content_blocks.length, 1);
  assert.equal(doc.content_blocks[0].body_en, 'English content block');
  assert.equal(doc.usage_guide.official_url, 'https://wiki.example/full');
  assert.deepEqual(doc.usage_guide.steps.map((s) => s.id), ['ustep_unbox', 'ustep_print']);

  // ---- NO expected section is empty ------------------------------------
  // The owner's own test: open the imported product and look at every panel.
  const sections: Array<[string, number]> = [
    ['option groups', rel.groups.length],
    ['option values', allValues(rel).length],
    ['colours', rel.colors.length],
    ['colour links', rel.colors[0].option_value_ids.length],
    ['images', rel.images.length],
    ['spec fields', Object.keys(doc.spec_fields).length],
    ['spec groups', doc.spec_groups.length],
    ['labels', doc.labels.length],
    ['warranty plans', doc.warranty_plans.length],
    ['content blocks', doc.content_blocks.length],
    ['usage steps', doc.usage_guide.steps.length],
    ['sale types', doc.sale_types.length],
    ['transports', doc.preorder_transports.filter((t) => t.active).length],
    ['payment options', doc.payment_options.length],
    ['hashtags', doc.hashtags.length],
    ['catalogs', doc.catalog_ids.length],
    ['imported ar/ckb texts', importedTexts(doc).length],
    ['preserved groups', preservedGroups(doc).length],
  ];
  for (const [name, n] of sections) assert.ok(n > 0, `section "${name}" is EMPTY in the form after a TXT import`);

  // The panels that have no editor yet are shown as preserved. Payment options
  // are NOT one of them: they have their own paragraph in section 4
  // (`data-form="payment-options-preserved"`), and listing them here as well
  // printed the same list twice under two different labels.
  assert.deepEqual(preservedGroups(doc).map((g) => g.key), ['spec_groups', 'labels', 'content_blocks']);
  assert.ok(doc.payment_options.length > 0, 'the file authored payment options and they are stored');
  assert.deepEqual(importedTexts(doc).map((t) => t.key), ['name_ar', 'name_ckb', 'description_ar', 'description_ckb']);

  // Section 7 renders the union of the template's fields and what is stored.
  const ids = await templateFieldIds(app, doc.sub_category_id!);
  assert.ok(ids.length > 0, 'the printers section declares no template fields');
  const outside = specIdsOutsideTemplate(doc.spec_fields, ids);
  assert.deepEqual(outside, body.spec_fields.outside_section, 'the form and the server disagree about which spec ids are off-template');

  // The overlay makes the document and the rows agree — one source on screen.
  assert.equal((wireDoc.options as unknown[]).length, 4);
  assert.equal((wireDoc.colors as unknown[]).length, 1);
  assert.equal((wireDoc.media as unknown[]).length, 3);
  const fromWire = relationsFromWire((await json(await get(app, `/api/admin/products/${id}/relations`))) as RelationsResponse);
  assert.deepEqual(fromWire.groups.map((g) => g.values.length), [2, 2]);
  assert.equal(fromWire.hydration_issues, undefined, 'the relations response carries a row the form cannot place');
});

// =========================================================================
// TEST B — a legacy product with no relation rows at all
// =========================================================================

const B_UPDATE = (id: string) => `template_version=2
product_id=${id}
name_en=Legacy Grown Up
description_en=Now it has structure
images.1.id=img_legacy
images.1.url=https://example.com/legacy.jpg
images.1.alt_en=Legacy
images.1.primary=true
images.2.id=img_legacy2
images.2.url=https://example.com/legacy-2.jpg
images.2.alt_en=Second
options.1.id=opt_s
options.1.group=Size
options.1.name_ar=صغير
options.1.name_en=Small
options.1.active=true
options.1.stock=6
options.2.id=opt_l
options.2.group=Size
options.2.name_ar=كبير
options.2.name_en=Large
options.2.active=true
options.2.stock=2
options.2.regular_price_iqd=+40000
colors.1.id=col_red
colors.1.name_ar=أحمر
colors.1.name_en=Red
colors.1.hex=#ff0000
colors.1.option_ids=opt_s
colors.1.active=true
`;

test('TEST B: a TXT update gives a legacy product with NO relations its first options, colour and images', async () => {
  const { raw, app } = setup();
  // A product created the way the form creates one, with nothing else.
  const created = await json(
    await post(app, '/api/admin/products-v2', {
      name_en: 'Legacy',
      name_ar: 'قديم',
      price_iqd: 200000,
      status: 'draft',
      sku: 'LEGACY-1',
      hashtags: ['legacy'],
      how_to_use: 'Old instructions',
    })
  );
  const id = created.product.id as string;
  assert.deepEqual(tableCounts(raw, id), { groups: 0, values: 0, colors: 0, links: 0, images: 0, catalogs: 0 });
  const before = await formState(app, id);
  assert.equal(hasRelationStructure(before.rel), false);

  const { status, body } = await apply(app, B_UPDATE(id), 'update');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.created, false);
  assert.deepEqual(body.mismatches, []);

  // The rows now exist — the "first relation" case the old gate made impossible.
  assert.deepEqual(tableCounts(raw, id), { groups: 1, values: 2, colors: 1, links: 1, images: 2, catalogs: 0 });

  const { doc, rel } = await formState(app, id);
  assert.deepEqual(rel.groups.map((g) => g.name_en), ['Size']);
  assert.deepEqual(rel.groups[0].values.map((v) => [v.id, v.name_en, v.name_ar, v.stock]), [
    ['opt_s', 'Small', 'صغير', 6],
    ['opt_l', 'Large', 'كبير', 2],
  ]);
  assert.equal(rel.groups[0].values[1].regular_adjust_iqd, 40000);
  assert.deepEqual(rel.colors.map((c) => [c.id, c.name_en, c.hex, c.option_value_ids]), [['col_red', 'Red', '#ff0000', ['opt_s']]]);
  assert.deepEqual(rel.images.map((i) => [i.id, i.is_primary]), [['img_legacy', true], ['img_legacy2', false]]);
  // Stock is stated on the options, so the tracked level follows them.
  assert.equal(rel.inventory_mode, 'OPTION');
  assert.equal(deriveInventoryMode(rel), 'OPTION');

  // Omitted keys preserved everything the file did not mention.
  assert.equal(doc.name_en, 'Legacy Grown Up');
  assert.equal(doc.description_en, 'Now it has structure');
  assert.equal(doc.name_ar, before.doc.name_ar);
  assert.equal(doc.sku, 'LEGACY-1');
  assert.equal(doc.how_to_use, 'Old instructions');
  assert.deepEqual(doc.hashtags, ['legacy']);
  assert.equal(doc.price_iqd, before.doc.price_iqd);
  assert.equal(doc.slug, before.doc.slug);
  assert.equal(doc.status, before.doc.status);
  assert.ok(body.preserved_fields.includes('sku'), `sku was not reported as preserved: ${JSON.stringify(body.preserved_fields)}`);

  // And the response's own counters equal what the form just read.
  assert.deepEqual(body.relations, {
    groups: 1, values: 2, colors: 1, links: 1, variants: 0, images: 2,
    primary_image: 'img_legacy', inventory_mode: 'OPTION',
  });
});

// =========================================================================
// TEST C — round trip: create from TXT → export → parse → apply → reload
// =========================================================================

/** Bookkeeping the round trip is allowed to move; everything else must not. */
const BOOKKEEPING = new Set(['updated_at', 'created_at', 'content_rev', 'doc_version', 'translation_meta']);
const stripBookkeeping = (o: Wire): Wire => Object.fromEntries(Object.entries(o).filter(([k]) => !BOOKKEEPING.has(k)));

test('TEST C: create from TXT → export → parse → apply as update loses and changes nothing', async () => {
  const { app } = setup();
  const first = await apply(app, A_TXT);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const id = first.body.product_id as string;

  const before = await formState(app, id);

  // The export the owner downloads, checked through /parse exactly as the
  // import window does before applying it.
  const exported = await (await get(app, `/api/admin/template/export/${id}?include_media=false`)).text();
  assert.ok(exported.includes(`product_id=${id}`), 'the export carries no product_id — it cannot be applied as an update');
  const parsed = await json(await post(app, '/api/admin/template/parse', { text: exported }));
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.errors, [], JSON.stringify(parsed.errors));
  assert.deepEqual(parsed.needs_review, [], JSON.stringify(parsed.needs_review));
  assert.deepEqual(parsed.unknown_keys, [], 'the product exports a key its own parser does not know');

  const applied = await apply(app, exported, 'update');
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.mismatches, []);

  const after = await formState(app, id);

  // Deep comparison of everything the form holds. The document is compared
  // whole, minus the bookkeeping columns a save legitimately moves and minus
  // the transport list, which the export deliberately writes in full (all
  // three methods, the undeclared ones inactive) so an admin can switch one
  // on by editing the file — docs/TXT_IMPORT_PARITY.md §2.8 records that as
  // the one round-trip artifact. It is checked immediately below instead of
  // being waved through.
  const drop = (o: Wire) => {
    const { preorder_transports: _t, ...rest } = stripBookkeeping(o);
    return rest;
  };
  assert.deepEqual(drop(after.wireDoc), drop(before.wireDoc));
  assert.deepEqual(after.rel, before.rel);
  assert.deepEqual(after.wireRel, before.wireRel);

  // Every transport the file declared survived with its own numbers, and the
  // entries the export added are inactive with no commission — semantically
  // the same as being absent, never a silent change to a live offer.
  const byMethod = (o: Wire) => new Map((o.preorder_transports as Wire[]).map((t) => [t.method as string, t]));
  const [was, now] = [byMethod(before.wireDoc), byMethod(after.wireDoc)];
  for (const [method, t] of was) assert.deepEqual(now.get(method), t, `transport "${method}" changed on the round trip`);
  for (const [method, t] of now) {
    if (!was.has(method)) assert.deepEqual(t, { method, commission_iqd: null, active: false });
  }

  // A second round trip is a FIXED POINT: identical text in, identical
  // product out — including the transports.
  const exported2 = await (await get(app, `/api/admin/template/export/${id}?include_media=false`)).text();
  // Everything but the freshness stamp the export puts in for the stale-edit
  // guard: the file the owner downloads after applying its own export is the
  // same file.
  const stamp = (t: string) => t.replace(/^expected_updated_at=.*$/m, 'expected_updated_at=<now>');
  assert.equal(stamp(exported2), stamp(exported), 'the export text itself changed after applying it');
  const applied2 = await apply(app, exported2, 'update');
  assert.equal(applied2.status, 200, JSON.stringify(applied2.body));
  const after2 = await formState(app, id);
  assert.deepEqual(stripBookkeeping(after2.wireDoc), stripBookkeeping(after.wireDoc));
  assert.deepEqual(after2.rel, before.rel);
  assert.deepEqual(after2.wireRel, before.wireRel);
});

// =========================================================================
// TEST D — result honesty
// =========================================================================

const D_UNKNOWN = A_TXT.replace('slug=parity-full', 'slug=parity-unknown')
  .replace('options.1.sku_part=A1', 'options.1.sku_part=A1\noptions.1.colour=black\noptions.1.compare_at_iqd=700000')
  .replace('spec.model=A1', 'spec.model=A1\nspec.made_up_field=nonsense\ncolour_of_box=blue');

test('TEST D: the apply counters equal the file, and unknown / off-template keys are named, never dropped', async () => {
  const { app } = setup();
  const { status, body } = await apply(app, D_UNKNOWN);
  assert.equal(status, 200, JSON.stringify(body));

  // Counters: requested comes from the file, stored from the read-back, and
  // the file really does hold 2 groups, 4 values, 1 colour, 3 images.
  assert.deepEqual(body.option_groups, { requested: 2, stored: 2 });
  assert.deepEqual(body.option_values, { requested: 4, stored: 4 });
  assert.deepEqual(body.colors, { requested: 1, stored: 1 });
  assert.deepEqual(body.images, { requested: 3, stored: 3 });
  assert.equal(body.spec_fields.stored, 4, 'the spec sheet has 4 ids: three template ones and the invented one');
  assert.deepEqual(body.mismatches, []);

  // Unknown keys survive to the apply answer (they used to be parse-only).
  const unknown = body.unknown_keys as string[];
  for (const key of ['options.1.colour', 'options.1.compare_at_iqd', 'colour_of_box']) {
    assert.ok(unknown.includes(key), `"${key}" was dropped in silence — unknown_keys: ${JSON.stringify(unknown)}`);
  }
  // A spec id the section's template does not declare is stored AND named.
  assert.deepEqual(body.spec_fields.outside_section, ['made_up_field']);
  assert.ok(
    (body.warnings as string[]).some((w) => w.includes('made_up_field')),
    `no warning names the off-template spec id: ${JSON.stringify(body.warnings)}`
  );

  // The import window reads exactly this, and says the same thing.
  const outcome = applyOutcome(body as ApplyResponse, { alreadyApplied: 'مطبّق', mismatched: 'لم تُحفَظ' });
  assert.equal(outcome.action, 'created');
  assert.deepEqual(outcome.unknownKeys, unknown);
  assert.equal(outcome.verify.reported, true);
  assert.deepEqual(
    [outcome.verify.groups, outcome.verify.values, outcome.verify.colors, outcome.verify.links, outcome.verify.images],
    [2, 4, 1, 2, 3]
  );
  assert.equal(outcome.verify.spec_stored, 4);
  assert.deepEqual(outcome.verify.spec_outside, ['made_up_field']);
  const line = verificationLine(outcome.verify, {
    groups: 'مجموعة', values: 'قيمة', colors: 'لون', links: 'ربط', images: 'صورة',
    specs: 'مواصفة', outside: 'ظاهرة في النموذج', outsideSection: 'خارج قالب القسم',
    variants: 'تركيبة', inventory: 'المخزون', unreported: 'غير مُبلَّغ',
  });
  assert.ok(line.includes('2 مجموعة') && line.includes('4 قيمة') && line.includes('3 صورة') && line.includes('OPTION'), line);
});

test('TEST D: a dropped relation statement is caught by the read-back — the CREATE is refused and leaves no product', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو','Bambu Lab')").run();
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, OWNER, mount);

  // The batch "succeeds" with one statement quietly missing — the adversary
  // the old response could not see, because it counted the file, not the rows.
  // The dropped row is the one nothing else references, so the write really
  // does commit (a foreign key would otherwise fail the whole batch and the
  // test would be measuring the batch, not the verification).
  failing.beforeBatch = (stmts) => {
    for (let i = stmts.length - 1; i >= 0; i -= 1) {
      if (/INSERT INTO product_option_values/i.test(stmts[i].sql) && stmts[i].params.includes('opt_n06')) stmts.splice(i, 1);
    }
  };
  const res = await post(app, '/api/admin/template/apply', { text: A_TXT, mode: 'draft', confirm: true });
  const body = await json(res);
  assert.equal(res.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.code, 'APPLY_VERIFY_FAILED');
  assert.equal(body.section, 'options');
  assert.ok(String(body.error).includes('options'), body.error);
  assert.ok(Array.isArray(body.mismatches) && body.mismatches.length > 0);

  // Nothing half-saved: no product, no relations, no catalogs, no dependents.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE slug = 'parity-full'"), 0);
  for (const t of ['product_option_groups', 'product_option_values', 'product_colors', 'product_images', 'product_catalogs', 'price_history']) {
    assert.equal(count(raw, `SELECT COUNT(*) AS n FROM ${t}`), 0, `${t} kept rows of a refused create`);
  }

  // The failed row the import window renders carries the section, the field
  // and the numbers — the refusal body arrives at the TOP LEVEL, not in
  // `details`, and the reader must still see all of it.
  const outcome = applyFailure(
    new ApiError(res.status, String(body.error), String(body.code), undefined, body as Record<string, unknown>),
    { duplicate: 'مكرر', inProgress: 'جارٍ', productExists: 'المنتج موجود' }
  );
  assert.equal(outcome.action, 'failed');
  assert.ok(outcome.detail.includes('options'), outcome.detail);
  assert.equal(outcome.mismatches.length, body.mismatches.length);
});

test('TEST D: a dropped relation statement on an UPDATE is refused and names the section, and the batch itself is all-or-nothing', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو','Bambu Lab')").run();
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, OWNER, mount);

  const created = await json(await post(app, '/api/admin/template/apply', { text: A_TXT, mode: 'draft', confirm: true }));
  const id = created.product_id as string;
  const before = await formState(app, id);

  // 1. A batch that THROWS (the real D1 failure mode) leaves the product
  //    byte-for-byte unchanged — the update is all-or-nothing.
  failing.failWhen = (stmts) => stmts.some((s) => /product_images/i.test(s.sql));
  const failedText = A_TXT.replace('slug=parity-full', 'slug=parity-full\nproduct_id=' + id).replace('name_en=Full Parity Printer', 'name_en=Renamed');
  const thrown = await post(app, '/api/admin/template/apply', { text: failedText, mode: 'update', confirm: true });
  assert.equal(thrown.status >= 400, true);
  const afterThrow = await formState(app, id);
  assert.deepEqual(stripBookkeeping(afterThrow.wireDoc), stripBookkeeping(before.wireDoc), 'a failed update changed the product');
  assert.deepEqual(afterThrow.rel, before.rel);

  // 2. A batch that silently DROPS one relation statement commits, so the
  //    answer must be the read-back's: refused, naming the section, with the
  //    product id so the admin can go and look.
  failing.failWhen = null;
  failing.beforeBatch = (stmts) => {
    for (let i = stmts.length - 1; i >= 0; i -= 1) if (/INSERT INTO product_images/i.test(stmts[i].sql)) stmts.splice(i, 1);
  };
  const dropped = A_TXT.replace('slug=parity-full', 'slug=parity-full\nproduct_id=' + id).replace(
    'images.3.alt_en=Black',
    'images.3.alt_en=Black\nimages.4.id=img_extra\nimages.4.url=https://example.com/extra.jpg\nimages.4.alt_en=Extra'
  );
  const res = await post(app, '/api/admin/template/apply', { text: dropped, mode: 'update', confirm: true });
  const body = await json(res);
  assert.equal(res.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.code, 'APPLY_VERIFY_FAILED');
  assert.equal(body.section, 'images');
  assert.equal(body.product_id, id, 'an update refusal must name the product that exists');
  assert.equal(body.created, false);
  // The read-back block it carries is the STORED truth, never the file's count.
  const verify = summarizeApply(body as never);
  assert.equal(verify.images, count(raw, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', id));
  assert.equal(verify.requested.images, 4);
});

test('TEST D: the apply answer never claims a section it did not write — counters come from the tables', async () => {
  const { raw, app } = setup();
  const { body } = await apply(app, A_TXT);
  const id = body.product_id as string;
  const t = tableCounts(raw, id);
  assert.deepEqual(
    { groups: body.relations.groups, values: body.relations.values, colors: body.relations.colors, links: body.relations.links, images: body.relations.images },
    { groups: t.groups, values: t.values, colors: t.colors, links: t.links, images: t.images }
  );
  assert.equal(body.spec_fields.stored, 3);
  assert.equal(body.price_history_rows, 0, 'a create writes no price history');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_catalogs WHERE product_id = ?', id), t.catalogs);
});

// =========================================================================
// Semantics — omit / __CLEAR__ / __NULL__ / cost scope / guards
// =========================================================================

test('semantics: an omitted key preserves, __CLEAR__ clears and __NULL__ nulls — read back through the form', async () => {
  const { app } = setup();
  const { body: created } = await apply(app, A_TXT);
  const id = created.product_id as string;
  const before = await formState(app, id);

  const { status, body } = await apply(
    app,
    `template_version=2
product_id=${id}
how_to_use=__CLEAR__
labels=__CLEAR__
original_price_iqd=__NULL__
low_stock_threshold=__NULL__
`,
    'update'
  );
  assert.equal(status, 200, JSON.stringify(body));
  const after = await formState(app, id);

  // Cleared / nulled exactly what was named.
  assert.equal(after.doc.how_to_use, '');
  assert.deepEqual(after.doc.labels, []);
  assert.equal(after.doc.original_price_iqd, null);
  assert.equal(after.doc.low_stock_threshold, null);
  assert.ok((body.cleared_fields as string[]).includes('how_to_use'));

  // Everything else preserved, structure included — an update that names no
  // option must not touch a single row.
  assert.deepEqual(after.rel, before.rel);
  assert.equal(after.doc.description_ar, before.doc.description_ar);
  assert.deepEqual(after.doc.spec_fields, before.doc.spec_fields);
  assert.deepEqual(after.doc.content_blocks, before.doc.content_blocks);
  assert.deepEqual(after.doc.warranty_plans, before.doc.warranty_plans);
  assert.deepEqual(after.doc.payment_options, before.doc.payment_options);
  assert.equal(after.doc.stock, before.doc.stock);
});

/**
 * The registry still describes `colors.N.hex` as "#RRGGBB or empty" while the
 * save path — the SAME rule ProductForm's `validateForm` applies — requires a
 * real code. The mismatch is documented in docs/TXT_IMPORT_PARITY.md §5.1; it
 * is pinned here because what matters for this programme is that the file is
 * REFUSED with the field named and nothing written, never quietly stored as a
 * JSON-only colour the form cannot show.
 */
test('semantics: a value the save path cannot accept is refused by name, not written as JSON', async () => {
  const { raw, app } = setup();
  const res = await post(app, '/api/admin/template/apply', {
    mode: 'draft',
    confirm: true,
    text: `template_version=2
slug=hexless
name_ar=بلا لون
name_en=Hexless
price_iqd=100000
colors.1.id=col_x
colors.1.name_ar=لون
colors.1.name_en=Colour
colors.1.hex=
colors.1.active=true
`,
  });
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.code, 'RELATIONS_VALIDATION');
  assert.equal(body.section, 'relations');
  assert.ok(String(body.field).includes('hex'), JSON.stringify(body));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE slug = 'hexless'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_colors'), 0);
});

test('semantics: __NULL__ on a field that cannot be null is refused, and nothing is written', async () => {
  const { app } = setup();
  const { body: created } = await apply(app, A_TXT);
  const id = created.product_id as string;
  const before = await formState(app, id);

  const res = await post(app, '/api/admin/template/apply', {
    text: `template_version=2\nproduct_id=${id}\nprice_iqd=__NULL__\n`,
    mode: 'update',
    confirm: true,
  });
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.code, 'TEMPLATE_ERRORS');
  assert.ok(JSON.stringify(body.errors).includes('price_iqd'), JSON.stringify(body.errors));
  const after = await formState(app, id);
  assert.deepEqual(stripBookkeeping(after.wireDoc), stripBookkeeping(before.wireDoc));
});

test('semantics: an assistant admin cannot write cost from a file — on create or update, row, rows or mirror', async () => {
  const { raw, app, assistant } = setup();
  const withCost = A_TXT.replace('price_iqd=500000', 'price_iqd=500000\nproduct_cost_iqd=333000')
    .replace('options.1.sku_part=A1', 'options.1.sku_part=A1\noptions.1.cost_iqd=111000')
    .replace('colors.1.sku_part=BLK', 'colors.1.sku_part=BLK\ncolors.1.cost_iqd=222000');

  const { status, body } = await apply(assistant, withCost);
  assert.equal(status, 200, JSON.stringify(body));
  const id = body.product_id as string;

  // Nothing anywhere: the row, the relation rows and the JSON mirror.
  const prod = all<Record<string, unknown>>(raw, 'SELECT product_cost_iqd, options, colors FROM products WHERE id = ?', id)[0];
  assert.equal(prod.product_cost_iqd, null);
  assert.ok(!String(prod.options).includes('111000'), 'an option cost reached the JSON mirror');
  assert.ok(!String(prod.colors).includes('222000'), 'a colour cost reached the JSON mirror');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = ? AND cost_iqd IS NOT NULL', id), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_colors WHERE product_id = ? AND cost_iqd IS NOT NULL', id), 0);

  // And the answer says so instead of claiming the write.
  assert.ok((body.cost_refused as string[]).includes('product_cost_iqd'), JSON.stringify(body.cost_refused));
  assert.ok(!(body.applied_fields as string[]).includes('product_cost_iqd'));
  assert.ok((body.preserved_fields as string[]).includes('product_cost_iqd'));
  assert.ok((body.warnings as string[]).some((w) => w.toLowerCase().includes('cost')), JSON.stringify(body.warnings));
  // The assistant's own response carries no cost number at all.
  assert.ok(!JSON.stringify(body).includes('333000'));

  // The owner then sets a real cost, and a later assistant update keeps it.
  const owned = await apply(app, `template_version=2\nproduct_id=${id}\nproduct_cost_iqd=300000\n`, 'update');
  assert.equal(owned.status, 200, JSON.stringify(owned.body));
  const second = await apply(assistant, `template_version=2\nproduct_id=${id}\nproduct_cost_iqd=1\nstock=5\n`, 'update');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(
    (all<{ product_cost_iqd: number | null }>(raw, 'SELECT product_cost_iqd FROM products WHERE id = ?', id)[0]).product_cost_iqd,
    300000,
    'an assistant overwrote a stored cost'
  );
  assert.equal((all<{ stock: number }>(raw, 'SELECT stock FROM products WHERE id = ?', id)[0]).stock, 5);
});

test('guards: a file cannot cut stock below the units live orders reserved, and the refusal moves nothing', async () => {
  const { raw, app } = setup();
  const { body: created } = await apply(app, A_TXT);
  const id = created.product_id as string;

  // Two units of the base option are held for live orders.
  raw.prepare('UPDATE product_option_values SET reserved = 2 WHERE id = ?').run('opt_base');
  const before = await formState(app, id);

  const cut = `template_version=2
product_id=${id}
options.1.id=opt_base
options.1.group=Model
options.1.name_ar=أساسي
options.1.name_en=A1
options.1.stock=1
`;
  const res = await post(app, '/api/admin/template/apply', { text: cut, mode: 'update', confirm: true });
  const body = await json(res);
  assert.equal(res.status >= 400, true, `stock below the reservation was allowed: ${JSON.stringify(body)}`);
  assert.equal(body.success, false);
  assert.ok(JSON.stringify(body).includes('reserved'), JSON.stringify(body));

  // Nothing moved: the rows, the reservation and the form's view are intact.
  const after = await formState(app, id);
  assert.deepEqual(after.rel, before.rel, 'the refusal still moved rows');
  assert.deepEqual(
    all<{ stock: number; reserved: number }>(raw, 'SELECT stock, reserved FROM product_option_values WHERE id = ?', 'opt_base'),
    [{ stock: 4, reserved: 2 }]
  );

  // Removing the same option outright is refused for the same reason.
  const removed = await apply(app, `template_version=2\nproduct_id=${id}\noptions=__CLEAR__\n`, 'update');
  assert.equal(removed.status >= 400, true, `a reserved option was deleted: ${JSON.stringify(removed.body)}`);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_values WHERE id = ?', 'opt_base'), 1);
  assert.deepEqual((await formState(app, id)).rel, before.rel);
});

// =========================================================================
// Regressions for the root causes whose LAST hop is the client transform
// =========================================================================

test('root cause 4 (client): the document, the relation rows and the storefront all describe the same product', async () => {
  const { app } = setup();
  const { body } = await apply(app, A_TXT);
  const id = body.product_id as string;
  const { doc, rel, wireDoc } = await formState(app, id);

  // The admin document (overlay) and the form's relation state agree.
  assert.deepEqual(
    (wireDoc.options as Array<{ id: string }>).map((o) => o.id).sort(),
    allValues(rel).map((v) => v.id).sort()
  );
  assert.deepEqual(
    (wireDoc.colors as Array<{ id: string }>).map((c) => c.id),
    rel.colors.map((c) => c.id)
  );
  assert.deepEqual(
    (wireDoc.media as Array<{ id: string }>).map((m) => m.id),
    rel.images.map((i) => i.id)
  );
  // `toEditorDoc` carries them into the editor state unchanged, so the price
  // preview and sections 5-6 cannot disagree on screen.
  assert.equal(doc.options.length, allValues(rel).length);
  assert.equal(doc.media.length, rel.images.length);

  // And the storefront sells exactly what the FORM shows — the third store
  // that used to disagree with the other two.
  await app.request(`/api/admin/products-v2/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ status: 'active' }),
  });
  const pub = await json(await get(app, `/api/products/${doc.slug}`));
  assert.equal(pub.success, true, JSON.stringify(pub));
  assert.equal(pub.relations.option_groups.length, rel.groups.length);
  // The shop lists the values it can sell; the form lists those and the
  // deactivated one — same rows, one filter apart.
  assert.equal(
    (pub.relations.option_groups as Array<{ values: unknown[] }>).reduce((n, g) => n + g.values.length, 0),
    allValues(rel).filter((v) => v.active).length
  );
  assert.equal(pub.relations.colors.length, rel.colors.length);
  assert.equal(pub.relations.images.length, rel.images.length);
  assert.equal(pub.relations.inventory_mode, rel.inventory_mode);
});

test('root cause 10 (client): the Arabic and Kurdish a file wrote are shown as preserved, not silently carried', async () => {
  const { app } = setup();
  const { body } = await apply(app, A_TXT);
  const id = body.product_id as string;
  const { doc } = await formState(app, id);
  assert.deepEqual(
    importedTexts(doc).map((t) => [t.key, t.value]),
    [
      ['name_ar', 'طابعة كاملة'],
      ['name_ckb', 'چاپکەری تەواو'],
      ['description_ar', 'وصف عربي كتبه المالك'],
      ['description_ckb', 'وەسفی کوردی نووسراو'],
    ]
  );

  // A form save of the English fields does not regenerate them.
  const saved = await post(app, '/api/admin/products-v2', {
    ...doc,
    id,
    description_en: 'Owner-written English description',
    expected_updated_at: (await json(await get(app, `/api/admin/products-v2/${id}`))).product.updated_at,
  });
  assert.equal(saved.status, 200, await saved.text());
  const after = await formState(app, id);
  assert.equal(after.doc.description_ar, 'وصف عربي كتبه المالك');
  assert.equal(after.doc.name_ar, 'طابعة كاملة');
});

test('root cause 9 (client): a spec id outside the section template is still rendered by the form', async () => {
  const { app } = setup();
  const { body } = await apply(app, D_UNKNOWN);
  const id = body.product_id as string;
  const { doc } = await formState(app, id);
  const ids = await templateFieldIds(app, doc.sub_category_id!);
  assert.deepEqual(specIdsOutsideTemplate(doc.spec_fields, ids), ['made_up_field']);
  assert.equal(doc.spec_fields.made_up_field, 'nonsense', 'the off-template value never reached the editor');
  // The union of template ids and stored ids is what section 7 renders: the
  // stored count is never larger than what the form can show.
  const rendered = new Set([...ids, ...Object.keys(doc.spec_fields)]);
  for (const k of Object.keys(doc.spec_fields)) assert.ok(rendered.has(k));
});

test('root cause 15: the form save and the TXT apply leave the SAME shape behind', async () => {
  const { raw, app } = setup();
  // Product one: written by the file.
  const fromTxt = await apply(app, A_TXT);
  const txtId = fromTxt.body.product_id as string;
  const txtState = await formState(app, txtId);

  // Product two: the same structure written by the form's own two requests.
  const created = await json(
    await post(app, '/api/admin/products-v2', { name_en: 'By Form', name_ar: 'بالنموذج', price_iqd: 500000, status: 'draft' })
  );
  const formId = created.product.id as string;
  // Row ids belong to one product each (the writer refuses a borrowed id), so
  // the second copy gets its own — the comparison below is by NAME.
  const mine = (x: string | null) => (x ? `fx_${x}` : x);
  const relBody = {
    inventory_mode: 'OPTION',
    groups: txtState.rel.groups.map((g) => ({
      id: mine(g.id), name_en: g.name_en, sort: g.sort, active: g.active,
      values: g.values.map((v) => ({
        id: mine(v.id), name_en: v.name_en, name_ar: v.name_ar, name_ckb: v.name_ckb, sort: v.sort, active: v.active,
        stock: v.stock, sku_part: v.sku_part, regular_adjust_iqd: v.regular_adjust_iqd,
      })),
    })),
    colors: txtState.rel.colors.map((c) => ({
      id: mine(c.id), name_en: c.name_en, name_ar: c.name_ar, name_ckb: c.name_ckb, hex: c.hex, sort: c.sort, active: c.active,
      sku_part: c.sku_part, regular_adjust_iqd: c.regular_adjust_iqd, option_value_ids: c.option_value_ids.map((v) => mine(v)),
    })),
    variants: [],
    images: txtState.rel.images.map((i) => ({
      id: mine(i.id), url: i.url, alt_en: i.alt_en, sort_order: i.sort_order, is_primary: i.is_primary,
      option_value_id: mine(i.option_value_id), color_id: mine(i.color_id),
    })),
  };
  const putRes = await put(app, `/api/admin/products/${formId}/relations`, relBody);
  assert.equal(putRes.status, 200, await putRes.text());
  const formStateNow = await formState(app, formId);

  // The two products' relation state is identical once the ids are read as
  // the names they carry.
  const shape = (s: { rel: RelationsState }) => {
    const valueName = new Map(allValues(s.rel).map((v) => [v.id, v.name_en]));
    const colorName = new Map(s.rel.colors.map((c) => [c.id, c.name_en]));
    return {
      groups: s.rel.groups.map((g) => [g.name_en, g.values.map((v) => [v.name_en, v.name_ar, v.stock, v.regular_adjust_iqd, v.active])]),
      colors: s.rel.colors.map((c) => [c.name_en, c.hex, c.sku_part, c.option_value_ids.map((v) => valueName.get(v)).sort()]),
      images: s.rel.images.map((i) => [
        i.url,
        i.is_primary,
        i.option_value_id ? valueName.get(i.option_value_id) : null,
        i.color_id ? colorName.get(i.color_id) : null,
      ]),
      mode: s.rel.inventory_mode,
    };
  };
  assert.deepEqual(shape(formStateNow), shape(txtState));

  // And the same tables carry them.
  const cols = (id: string) => tableCounts(raw, id);
  assert.deepEqual({ ...cols(formId), catalogs: 0 }, { ...cols(txtId), catalogs: 0 });
});
