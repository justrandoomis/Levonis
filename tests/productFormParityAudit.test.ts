/**
 * THE PARITY AUDIT (mandate §5): «أي شيء يمكن إدخاله يدويًا في ProductForm يجب
 * أن ينجو من TXT Create → Save → Reload بنفس النتيجة».
 *
 * WHY THIS IS A TEST AND NOT A DOCUMENT. A written audit is true on the day it
 * is written. The owner's rule is a property of the software, so it is checked
 * the way properties are checked: one product carrying every section the
 * template can express is created from TXT, read back through the transforms
 * ProductForm runs, SAVED BACK UNCHANGED through the form's own save path, and
 * reloaded — and the two exports are compared key by key.
 *
 * That comparison is the audit. Every field of every one of the fifteen areas
 * the owner listed is in the export, so a field that a form save drops shows up
 * as a named key in the diff rather than as a paragraph nobody re-reads. And it
 * stays current by construction: a field added to the template next month joins
 * the audit with no edit here.
 *
 * ONE KNOWN BLIND SPOT, STATED RATHER THAN HIDDEN. `product_variants` (the
 * combinations table: stock and four price columns, all editable in the form)
 * has no group in the TXT template, so it appears in no export key and the
 * diff below cannot see it. `tests/productSaveParity.test.ts` covers the
 * variant rows through the database instead.
 *
 * WHAT SEPARATES THIS FROM ITS NEIGHBOURS:
 *   tests/templateApplyParity.test.ts  judges the DATABASE after a TXT apply.
 *   tests/templateParity.test.ts       judges the FORM STATE after a TXT apply,
 *                                      and TXT → export → apply (test C).
 *   this file                          judges TXT → form state → FORM SAVE →
 *                                      reload, which is the hop the owner named
 *                                      and the only one none of them covered.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, row, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { toEditorDoc } from '../src/components/adminProducts/types';
import {
  hydrateRelations,
  relationsToWire,
  type RelationsResponse,
  type RelationsState,
} from '../src/components/adminProducts/form/model';
import { productMediaFixtureEnv } from './fixtures/productMedia';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
  a.route('/api/admin/taxonomy', adminTaxonomyRoutes);
};

function setup() {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو','Bambu Lab')").run();
  const media = productMediaFixtureEnv();
  return { raw, app: stubApp(asD1(raw), OWNER, mount, { env: media.env }) };
}

const apply = async (a: App, text: string, extra: Record<string, unknown> = {}) => {
  const res = await post(a, '/api/admin/template/apply', { text, mode: 'draft', confirm: true, ...extra });
  return { status: res.status, body: await json(res) };
};

const stamp = (raw: DatabaseSync, id: string) =>
  String(row(raw, 'SELECT updated_at FROM products WHERE id = ?', id)!.updated_at);

/** The store's own export, which is the field inventory this audit walks. */
async function exportOf(a: App, id: string): Promise<string> {
  const res = await get(a, `/api/admin/template/export/${id}`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return text;
}

/** Every `key=value` line of an export, as a map, ignoring comments/blanks. */
function entries(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out.set(t.slice(0, i), t.slice(i + 1));
  }
  return out;
}

/**
 * THE BODY `ProductForm.save` ACTUALLY POSTS.
 *
 * It strips `options`, `colors` and `media` from the document on purpose: they
 * are derived copies of the structure with no editor of their own, and the
 * server rebuilds the product's JSON mirror from the ROWS the same request
 * writes. Sending the copy the form happened to be holding is how a deleted
 * option came back on the next read (ProductForm.tsx, and the regression is
 * pinned in tests/productSaveParity.test.ts).
 *
 * The audit builds it the same way rather than posting the whole document,
 * because the difference is exactly where a mirror-rebuild regression would
 * live — and a test that posts something the form never posts cannot see one.
 */
function savePayload(doc: Record<string, unknown>, rel: RelationsState, stamp: string) {
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o;
  void _c;
  void _m;
  return { ...docFields, status: 'draft', relations: relationsToWire(rel), expected_updated_at: stamp };
}

/** Exactly the two GETs the form issues, through exactly its two transforms. */
async function formState(a: App, id: string) {
  const p = await json(await get(a, `/api/admin/products-v2/${id}`));
  const r = await json(await get(a, `/api/admin/products/${id}/relations`));
  assert.equal(p.success, true, JSON.stringify(p));
  return { doc: toEditorDoc(p.product), rel: hydrateRelations(r as unknown as RelationsResponse, p.product) };
}

// =========================================================================
// One product carrying all fifteen areas the owner listed.
// =========================================================================

const FULL_TXT = `template_version=2
slug=audit-full
name_ar=طابعة كاملة للتدقيق
name_en=Audit Full Printer
name_ckb=چاپکەری تەواو
status=draft
description_ar=وصف عربي كتبه المالك
description_en=Owner-written English description
description_ckb=وەسفی کوردی نووسراو
how_to_use_ar=سوِّ المنصة، حمّل الفلامنت، اطبع.
how_to_use_en=Level the bed, load filament, print.
how_to_use_ckb=تەختەکە ڕێک بخە، فیلامێنت بار بکە، چاپ بکە.
price_iqd=500000
pro_price_iqd=450000
prime_price_iqd=480000
original_price_iqd=650000
brand=bambu
catalogs=printers,fdm-printers
category=printers
sub_category=fdm-printers
template_family=devices
sku=AUDIT-FULL-01
hashtags=bambu,audit
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
images.1.url=/files/products/catalog/gallery/front0001.webp
images.1.alt_ar=الواجهة
images.1.alt_en=Front
images.1.alt_ckb=پێشەوە
images.1.primary=true
images.1.key=products/catalog/gallery/front0001.webp
images.1.source_url=https://vendor.example/front.jpg
images.1.width=1200
images.1.height=900
images.2.id=img_combo
images.2.url=/files/products/catalog/gallery/combo0001.webp
images.2.alt_en=Combo
images.2.option_value_id=opt_combo
images.3.id=img_black
images.3.url=/files/products/catalog/gallery/black0001.webp
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
options.3.stock=0
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
colors.1.option_ids=
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
usage_steps.1.images=https://example.com/step1.jpg https://res.cloudinary.com/x/upload/w_400,h_300/step1b.jpg
usage_steps.1.video_url=https://www.youtube.com/watch?v=abc123
usage_steps.1.link_url=https://wiki.example/full/unbox
usage_steps.2.id=ustep_print
usage_steps.2.kind=usage
usage_steps.2.title=الطباعة الأولى
usage_steps.2.body=اطبع نموذج الاختبار
`;

/**
 * The fifteen areas, each named with the export-key prefixes that carry it.
 * A key that matches none of these is still audited by the whole-file diff —
 * this list is what makes a FAILURE legible, not what limits the check.
 */
const AREAS: Array<{ area: string; match: (k: string) => boolean }> = [
  { area: 'identity', match: (k) => /^(slug|name_|sku|status|is_featured|display_order)/.test(k) },
  { area: 'descriptions', match: (k) => /^(description_|how_to_use)/.test(k) },
  { area: 'pricing', match: (k) => /^(price_iqd|pro_price|prime_price|original_price|direct_surcharge)/.test(k) },
  { area: 'classification', match: (k) => /^(brand|catalogs|category|sub_category|template_family|hashtags)/.test(k) },
  { area: 'availability', match: (k) => /^(selling_type|stock|low_stock_threshold|inventory_mode)/.test(k) },
  { area: 'options', match: (k) => /^options\./.test(k) },
  { area: 'colours', match: (k) => /^colors\./.test(k) },
  { area: 'images', match: (k) => /^images\./.test(k) },
  { area: 'spec_fields', match: (k) => /^spec\./.test(k) },
  { area: 'spec_groups', match: (k) => /^spec_groups\./.test(k) },
  { area: 'labels', match: (k) => /^labels\./.test(k) },
  { area: 'warranty', match: (k) => /^(warranty_base_months|serialized|warranty_plans\.)/.test(k) },
  { area: 'content_blocks', match: (k) => /^content_blocks\./.test(k) },
  { area: 'usage guide', match: (k) => /^usage_/.test(k) },
  { area: 'payment options', match: (k) => /^payment_options/.test(k) },
  { area: 'preorder transports', match: (k) => /^transports\./.test(k) },
];

/**
 * The keys that legitimately move on every save, and the reason each one does.
 * Nothing else may differ — this list is deliberately tiny, and every entry is
 * bookkeeping ABOUT the product rather than a field of it.
 *
 *   updated_at / exported_at   clocks.
 *   content_rev / doc_version  the revision counters the translator watches.
 *   expected_updated_at        the OPTIMISTIC LOCK the export stamps so a
 *                              re-import can be fenced against a concurrent
 *                              edit. It is a copy of `updated_at` by
 *                              definition, so it moves with it; if it did not,
 *                              re-importing the file would always be refused.
 */
const VOLATILE = /^(updated_at|exported_at|content_rev|doc_version|expected_updated_at)$/;

/**
 * A legacy TXT can state selling_type=mixed without spelling the per-option
 * fulfillment cells. Hydration materializes that inherited meaning so the
 * editor can save an explicit, stable contract. Those newly explicit defaults
 * are canonicalization, not a loss of an author-supplied field; the second-save
 * test below still proves they never drift again.
 */
const MATERIALIZED_OPTION_FULFILLMENT = /^options\.\d+\.(?:direct|preorder)\./;

// =========================================================================

test('§5 AUDIT — TXT create → ProductForm save → reload changes nothing, in any of the fifteen areas', async () => {
  const { raw, app } = setup();

  const created = await apply(app, FULL_TXT);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.product_id as string;

  const before = entries(await exportOf(app, id));
  assert.ok(before.size > 80, `the audit is only meaningful over a full product (got ${before.size} keys)`);

  // THE FORM OPENS THE PRODUCT AND SAVES IT WITHOUT TOUCHING A THING. This is
  // the exact request ProductForm issues: the document and the relations in
  // ONE call, through the client transforms, with the optimistic-lock stamp.
  const { doc, rel } = await formState(app, id);
  const saved = await json(
    await post(app, '/api/admin/products-v2', savePayload(doc as unknown as Record<string, unknown>, rel, stamp(raw, id)))
  );
  assert.equal(saved.success, true, JSON.stringify(saved));

  const after = entries(await exportOf(app, id));

  // The diff, reported BY AREA so a failure names what an admin would lose.
  const changed: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (VOLATILE.test(key)) continue;
    const b = before.get(key);
    const a = after.get(key);
    if (b === undefined && a !== undefined && MATERIALIZED_OPTION_FULFILLMENT.test(key)) continue;
    if (b !== a) changed.push(`${key}: "${b ?? '(absent)'}" → "${a ?? '(absent)'}"`);
  }

  if (changed.length) {
    const byArea = new Map<string, string[]>();
    for (const line of changed) {
      const key = line.slice(0, line.indexOf(':'));
      const area = AREAS.find((x) => x.match(key))?.area ?? 'unclassified';
      byArea.set(area, [...(byArea.get(area) ?? []), line]);
    }
    assert.fail(
      'a form save changed the product:\n' +
        [...byArea].map(([area, lines]) => `  [${area}]\n    ${lines.join('\n    ')}`).join('\n')
    );
  }
});

test('§5 AUDIT — every one of the fifteen areas is actually represented in the audited product', () => {
  // A green audit over a product that carries only a name proves nothing. This
  // is the guard on the guard: if a future edit thins the fixture, the audit
  // stops being an audit and this test says so.
  const keys = [...entries(FULL_TXT).keys()];
  for (const { area, match } of AREAS) {
    assert.ok(keys.some(match), `the audit fixture carries nothing for "${area}"`);
  }
});

test('§5 AUDIT — the form state itself carries all fifteen, not just the export', async () => {
  // The export is generated from the stored document; the form is generated
  // from two different endpoints. A value could survive the first and be
  // invisible in the second, which was the owner's original complaint.
  const { app } = setup();
  const id = (await apply(app, FULL_TXT)).body.product_id as string;
  const { doc, rel } = await formState(app, id);

  // identity / descriptions / pricing / classification / availability
  assert.equal(doc.name_en, 'Audit Full Printer');
  assert.equal(doc.sku, 'AUDIT-FULL-01');
  assert.equal(doc.description_en, 'Owner-written English description');
  assert.equal(doc.how_to_use, 'Level the bed, load filament, print.');
  // 0079 — the Arabic and Kurdish the FILE states are what is stored, and the
  // form save below must not regenerate over them.
  assert.equal(doc.how_to_use_ar, 'سوِّ المنصة، حمّل الفلامنت، اطبع.');
  assert.equal(doc.how_to_use_ckb, 'تەختەکە ڕێک بخە، فیلامێنت بار بکە، چاپ بکە.');
  assert.equal(doc.price_iqd, 500_000);
  assert.equal(doc.prime_price_iqd, 480_000);
  assert.equal(doc.pro_price_iqd, 450_000);
  assert.equal(doc.original_price_iqd, 650_000);
  assert.equal(doc.direct_surcharge_iqd, 15_000);
  assert.equal(doc.template_family, 'devices');
  assert.deepEqual(doc.hashtags.slice().sort(), ['audit', 'bambu']);
  assert.equal(doc.stock, 9);
  assert.equal(doc.low_stock_threshold, 2);

  // options / colours / images, through hydrateRelations
  const values = rel.groups.flatMap((g) => g.values);
  assert.equal(rel.groups.length, 2, 'Model and Nozzle');
  assert.equal(values.length, 4);
  assert.equal(values.find((v) => v.id === 'opt_combo')?.regular_adjust_iqd, 150_000, 'the surcharge, as an adjustment');
  assert.equal(values.find((v) => v.id === 'opt_n06')?.active, false);
  assert.equal(rel.colors.length, 1);
  assert.deepEqual(rel.colors[0].option_value_ids, [], 'empty option_ids remains the canonical all-options shorthand');
  assert.equal(rel.images.length, 3);
  assert.equal(rel.images.find((i) => i.id === 'img_front')?.is_primary, true);
  assert.equal(rel.images.find((i) => i.id === 'img_front')?.source_url, 'https://vendor.example/front.jpg');
  assert.equal(rel.images.find((i) => i.id === 'img_combo')?.option_value_id, 'opt_combo');
  assert.equal(rel.images.find((i) => i.id === 'img_black')?.color_id, 'col_black');
  assert.equal(rel.inventory_mode, 'OPTION');

  // spec_fields / spec_groups / labels / warranty / content_blocks
  assert.equal(doc.spec_fields.technology, 'FDM');
  assert.equal(doc.spec_groups[0].rows[0].unit, 'kg');
  assert.equal(doc.labels[0].key, 'warranty_included');
  assert.equal(doc.warranty_base_months, 12);
  assert.equal(doc.serialized, true);
  assert.equal(doc.warranty_plans[0].fee_percent, 7.5);
  assert.equal(doc.content_blocks[0].kind, 'text');

  // usage guide, including the media §4 is about
  const step = doc.usage_guide.steps.find((s) => s.id === 'ustep_unbox')!;
  assert.equal(step.images.length, 2, 'the comma inside the Cloudinary transform did not split the URL');
  assert.equal(step.video_url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(step.link_url, 'https://wiki.example/full/unbox');

  // payment options / preorder transports
  assert.deepEqual(doc.payment_options.slice().sort(), ['card', 'cod', 'wallet']);
  assert.equal(doc.preorder_transports.length, 2);
  assert.equal(doc.preorder_transports.find((t) => t.method === 'air')?.commission_iqd, 25_000);
});

test('§5 AUDIT — a SECOND save is still a no-op, so nothing drifts one hop at a time', async () => {
  // A single save could be idempotent by accident while the second one loses
  // something the first quietly normalised.
  const { raw, app } = setup();
  const id = (await apply(app, FULL_TXT)).body.product_id as string;

  const saveOnce = async () => {
    const { doc, rel } = await formState(app, id);
    const res = await json(
      await post(app, '/api/admin/products-v2', savePayload(doc as unknown as Record<string, unknown>, rel, stamp(raw, id)))
    );
    assert.equal(res.success, true, JSON.stringify(res));
  };

  await saveOnce();
  const afterFirst = entries(await exportOf(app, id));
  await saveOnce();
  const afterSecond = entries(await exportOf(app, id));

  const drift = [...new Set([...afterFirst.keys(), ...afterSecond.keys()])]
    .filter((k) => !VOLATILE.test(k))
    .filter((k) => afterFirst.get(k) !== afterSecond.get(k));
  assert.deepEqual(drift, [], 'the product drifts between saves');
});
