/**
 * TXT TEMPLATE APPLY ↔ PRODUCT FORM PARITY — the persistence contract, judged
 * from the database and from the two endpoints ProductForm actually reads.
 *
 * Every test here is the fixed form of a repro from docs/TXT_IMPORT_PARITY.md
 * §6 and is named by the root cause (§4) it guards. The rule the old suite
 * broke — and the reason those root causes survived four releases — is written
 * at the top of §4.15: *parser success is not import success*. So nothing in
 * this file asserts on a parse result. Every verdict is read back through
 * `GET /api/admin/products-v2/:id`, `GET /api/admin/products/:id/relations`
 * and the tables themselves, exactly as the form and the storefront read them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, failingD1, stubApp, post, get, json, all, row, count, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';
import { productRoutes } from '../worker/routes/products';

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

/** A JSON body read back from an endpoint, indexed the way a test reads it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>;

/** The two GETs ProductForm calls, and nothing else. */
async function formView(a: App, id: string) {
  const p = await json(await get(a, `/api/admin/products-v2/${id}`));
  const r = await json(await get(a, `/api/admin/products/${id}/relations`));
  return { doc: p.product as Wire, rel: r as Wire };
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
  variants: count(raw, 'SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ?', id),
  catalogs: count(raw, 'SELECT COUNT(*) AS n FROM product_catalogs WHERE product_id = ?', id),
});

// The file every "create" test starts from: two option groups, a linked
// colour, three images (one bound to an option, one to the colour), a spec
// sheet, a spec group, a label, warranty plans, a content block and a usage
// guide — the whole ProductDoc in one file.
const FULL = `template_version=2
slug=parity-a1
name_ar=طابعة بامبو A1
name_en=Bambu Lab A1
name_ckb=چاپکەری بامبو A1
status=draft
description_ar=وصف عربي أصيل
description_en=English description
description_ckb=وەسفی کوردی
how_to_use=Unbox, level, print.
price_iqd=500000
pro_price_iqd=450000
prime_price_iqd=480000
original_price_iqd=650000
product_cost_iqd=300000
brand=bambu
catalogs=printers,fdm-printers
category=printers
sub_category=fdm-printers
sku=BL-A1-PARITY
hashtags=bambu,a1
is_featured=true
display_order=5
selling_type=direct_sale
stock=7
low_stock_threshold=2
direct_surcharge_iqd=15000
payment_options=cod,card
images.1.id=img_front
images.1.url=https://example.com/a1-front.jpg
images.1.alt_ar=الواجهة
images.1.alt_en=Front
images.1.alt_ckb=پێشەوە
images.1.primary=true
images.1.key=products/a1-front.jpg
images.1.source_url=https://vendor.example/a1-front.jpg
images.1.width=1200
images.1.height=900
images.2.id=img_combo
images.2.url=https://example.com/a1-combo.jpg
images.2.alt_en=Combo
images.2.option_value_id=opt_combo
images.3.id=img_black
images.3.url=https://example.com/a1-black.jpg
images.3.alt_en=Black
images.3.color_id=col_black
options.1.id=opt_base
options.1.group=Model
options.1.name_ar=إيه ١
options.1.name_en=A1
options.1.name_ckb=ئەی ١
options.1.active=true
options.1.stock=4
options.1.sku_part=A1
options.2.id=opt_combo
options.2.group=Model
options.2.name_ar=إيه ١ كومبو
options.2.name_en=A1 Combo
options.2.active=true
options.2.regular_price_iqd=+150000
options.2.stock=3
options.3.id=opt_n04
options.3.group=Nozzle
options.3.name_ar=٠٫٤ مم
options.3.name_en=0.4mm
options.3.active=true
colors.1.id=col_black
colors.1.name_ar=أسود
colors.1.name_ckb=ڕەش
colors.1.name_en=Black
colors.1.hex=#000000
colors.1.option_ids=opt_base,opt_combo
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
warranty_plans.1.title_ar=ضمان +12
warranty_plans.1.title_en=Extended +12
warranty_plans.1.duration_months=12
warranty_plans.1.duration_kind=extension
warranty_plans.1.fee_percent=7.5
warranty_plans.1.fee_iqd=0
warranty_plans.1.active=true
content_blocks.1.id=cb_text
content_blocks.1.kind=text
content_blocks.1.body_ar=كتلة محتوى
content_blocks.1.body_en=Content block
usage_official_url=https://wiki.example/a1
usage_steps.1.id=ustep_unbox
usage_steps.1.kind=setup
usage_steps.1.title=فك التغليف
usage_steps.1.body=أخرج الجهاز
`;

// =========================================================================
// Root cause 1 — create wrote the products row alone
// =========================================================================

test('root cause 1: a TXT create lands options, colours, links, images and catalogs as ROWS, not JSON', async () => {
  const { raw, app } = setup();
  const { status, body } = await apply(app, FULL);
  assert.equal(status, 200, JSON.stringify(body));
  const id = body.product_id as string;

  // The tables the storefront, the cart and the form all read from.
  assert.deepEqual(tableCounts(raw, id), {
    groups: 2, values: 3, colors: 1, links: 2, images: 3, variants: 0, catalogs: 2,
  });

  // The response counters come from that read-back, not from the file.
  assert.deepEqual(body.relations, {
    groups: 2, values: 3, colors: 1, links: 2, variants: 0, images: 3,
    primary_image: 'img_front', inventory_mode: 'OPTION',
  });
  assert.deepEqual(body.mismatches, []);
  assert.deepEqual(body.option_groups, { requested: 2, stored: 2 });
  assert.deepEqual(body.option_values, { requested: 3, stored: 3 });
  assert.deepEqual(body.colors, { requested: 1, stored: 1 });
  assert.deepEqual(body.images, { requested: 3, stored: 3 });

  // And the form's own two endpoints agree with them.
  const { doc, rel } = await formView(app, id);
  assert.equal((rel.groups as unknown[]).length, 2);
  assert.equal((rel.values as unknown[]).length, 3);
  assert.equal((rel.colors as unknown[]).length, 1);
  assert.equal((rel.links as unknown[]).length, 2);
  assert.equal((rel.images as unknown[]).length, 3);
  assert.equal((doc.media as unknown[]).length, 3);
  assert.equal((doc.options as unknown[]).length, 3);

  // The document half of the file, through GET /products-v2.
  assert.equal(doc.name_ar, 'طابعة بامبو A1');
  assert.equal(doc.description_ar, 'وصف عربي أصيل');
  assert.equal(doc.description_ckb, 'وەسفی کوردی');
  assert.deepEqual(doc.spec_fields, { technology: 'FDM', model: 'A1', build_volume: '256 x 256 x 256' });
  assert.equal((doc.spec_groups as unknown[]).length, 1);
  assert.equal((doc.labels as unknown[]).length, 1);
  assert.equal((doc.warranty_plans as unknown[]).length, 1);
  assert.equal(doc.warranty_base_months, 12);
  assert.equal(doc.serialized, true);
  assert.equal((doc.content_blocks as unknown[]).length, 1);
  assert.equal(((doc.usage_guide as { steps: unknown[] }).steps).length, 1);
  assert.deepEqual(doc.payment_options, ['cod', 'card']);
  assert.deepEqual(doc.hashtags, ['bambu', 'a1']);
  assert.deepEqual(doc.catalog_ids, ['cat_printers', 'cat_printers_fdm']);
  assert.equal(doc.sku, 'BL-A1-PARITY');

  // The image bindings really point at the rows they name.
  const images = all<{ id: string; option_value_id: string | null; color_id: string | null; is_primary: number }>(
    raw, 'SELECT id, option_value_id, color_id, is_primary FROM product_images WHERE product_id = ? ORDER BY sort_order', id
  );
  assert.deepEqual(images.map((i) => [i.id, i.option_value_id, i.color_id, i.is_primary]), [
    ['img_front', null, null, 1],
    ['img_combo', 'opt_combo', null, 0],
    ['img_black', null, 'col_black', 0],
  ]);
});

// =========================================================================
// Root cause 2 — the hasRelationalStructure() gate
// =========================================================================

test('root cause 2: a TXT update creates the FIRST option, colour and image on a product that has none', async () => {
  const { raw, app } = setup();
  const created = await json(
    await post(app, '/api/admin/products-v2', { name_en: 'Bare', name_ar: 'عارٍ', price_iqd: 100000, status: 'draft' })
  );
  const id = created.product.id as string;
  assert.deepEqual(tableCounts(raw, id), { groups: 0, values: 0, colors: 0, links: 0, images: 0, variants: 0, catalogs: 0 });

  const upd = `template_version=2
product_id=${id}
options.1.id=ov_a
options.1.group=Model
options.1.name_ar=أ
options.1.name_en=A
options.1.stock=5
options.2.id=ov_b
options.2.group=Model
options.2.name_ar=ب
options.2.name_en=B
colors.1.id=pc_x
colors.1.name_ar=أسود
colors.1.name_en=Black
colors.1.hex=#101010
colors.1.option_ids=ov_a
images.1.id=pi_1
images.1.url=/files/one.jpg
images.1.primary=true
images.2.id=pi_2
images.2.url=/files/two.jpg
`;
  const { status, body } = await apply(app, upd, 'update');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.created, false);
  assert.deepEqual(body.mismatches, []);
  assert.deepEqual(tableCounts(raw, id), { groups: 1, values: 2, colors: 1, links: 1, images: 2, variants: 0, catalogs: 0 });

  const { rel } = await formView(app, id);
  assert.deepEqual((rel.values as Array<{ id: string }>).map((v) => v.id), ['ov_a', 'ov_b']);
  assert.deepEqual((rel.colors as Array<{ id: string }>).map((x) => x.id), ['pc_x']);
  assert.deepEqual((rel.images as Array<{ id: string }>).map((x) => x.id), ['pi_1', 'pi_2']);
});

// =========================================================================
// Root cause 3 — inventory_mode had no owner on the TXT path
// =========================================================================

test('root cause 3: inventory_mode is derived from where the stock is stated, and an explicit key wins', async () => {
  // Option-level stock → OPTION, exactly as form/model.ts deriveInventoryMode.
  {
    const { app } = setup();
    const { body } = await apply(app, FULL);
    assert.equal(body.relations.inventory_mode, 'OPTION');
    assert.equal((await formView(app, body.product_id)).rel.product.inventory_mode, 'OPTION');
  }

  // Colour-level stock outranks option-level, as the form derives it.
  {
    const { app } = setup();
    const { status, body } = await apply(app, FULL.replace('colors.1.active=true', 'colors.1.active=true\ncolors.1.stock=2'));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.relations.inventory_mode, 'COLOR');
  }

  // The optional template key is authoritative when the file states it.
  {
    const { app } = setup();
    const { status, body } = await apply(app, FULL.replace('stock=7', 'stock=7\ninventory_mode=BASE'));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.relations.inventory_mode, 'BASE');
    assert.deepEqual(body.mismatches, []);
    assert.equal((await formView(app, body.product_id)).rel.product.inventory_mode, 'BASE');
  }

  // A file that states no stock anywhere leaves the product at BASE.
  {
    const { app } = setup();
    const bare = FULL.split('\n').filter((l) => !/^(options|colors)\.\d+\.stock=/.test(l)).join('\n');
    const { status, body } = await apply(app, bare);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.relations.inventory_mode, 'BASE');
  }
});

// =========================================================================
// Root cause 5 — the relational tables could not hold name_ar / name_ckb
// =========================================================================

test('root cause 5: option and colour Arabic/Kurdish names reach the ROWS, the relations GET and the export', async () => {
  const { raw, app } = setup();
  const { body } = await apply(app, FULL);
  const id = body.product_id as string;

  const values = all<{ id: string; name_ar: string; name_en: string; name_ckb: string }>(
    raw, 'SELECT id, name_ar, name_en, name_ckb FROM product_option_values WHERE product_id = ? ORDER BY sort', id
  );
  const base = values.find((v) => v.id === 'opt_base')!;
  assert.equal(base.name_ar, 'إيه ١');
  assert.equal(base.name_ckb, 'ئەی ١');
  const colour = row<{ name_ar: string; name_ckb: string }>(raw, 'SELECT name_ar, name_ckb FROM product_colors WHERE id = ?', 'col_black')!;
  assert.equal(colour.name_ar, 'أسود');
  assert.equal(colour.name_ckb, 'ڕەش');

  // The relations GET carries them instead of copying name_en over the slot.
  const { rel } = await formView(app, id);
  const relBase = (rel.values as Array<{ id: string; name_ar: string; name_ckb: string }>).find((v) => v.id === 'opt_base')!;
  assert.equal(relBase.name_ar, 'إيه ١');
  assert.equal(relBase.name_ckb, 'ئەی ١');

  // A value with NO authored Arabic falls back to the English name for
  // display and never claims a stored translation it does not have.
  const n04 = values.find((v) => v.id === 'opt_n04')!;
  assert.equal(n04.name_ckb, '');

  // The export writes the authored names, so the round trip keeps them.
  const text = await (await get(app, `/api/admin/template/export/${id}?include_media=false`)).text();
  assert.match(text, /^options\.1\.name_ar=إيه ١$/m);
  assert.match(text, /^options\.1\.name_ckb=ئەی ١$/m);
  assert.match(text, /^colors\.1\.name_ar=أسود$/m);
  assert.match(text, /^colors\.1\.name_ckb=ڕەش$/m);
});

// =========================================================================
// Root cause 6 — keys parsed and then dropped without a word
// =========================================================================

test('root cause 6: compare_at_iqd is no longer a silently discarded key — it is reported as unknown', async () => {
  const { app } = setup();
  const text = FULL.replace('options.1.sku_part=A1', 'options.1.sku_part=A1\noptions.1.compare_at_iqd=900000\ncolors.1.compare_at_iqd=900000');
  const { status, body } = await apply(app, text);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.unknown_keys, ['options.1.compare_at_iqd', 'colors.1.compare_at_iqd']);
  assert.ok((body.warnings as string[]).some((w) => w.includes('options.1.compare_at_iqd')));

  // And it is not offered by the blank template any more.
  const blank = await (await get(app, '/api/admin/template/blank')).text();
  assert.ok(!blank.includes('compare_at_iqd'), 'the blank template still advertises a key nothing stores');
});

test('an unknown key is never dropped in silence: it survives into the apply response', async () => {
  const { app } = setup();
  const { status, body } = await apply(app, FULL.replace('sku=BL-A1-PARITY', 'sku=BL-A1-PARITY\nfoo_bar=1\noptions.1.colour=red'));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.unknown_keys, ['foo_bar', 'options.1.colour']);
});

// =========================================================================
// Root cause 7 — __CLEAR__ was ineffective for image provenance
// =========================================================================

test('root cause 7: __CLEAR__ empties image alt_ar/alt_ckb/key/source_url on a product that already has rows', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, FULL)).body.product_id as string;
  const before = row<{ alt_ar: string; alt_ckb: string; r2_key: string; source_url: string }>(
    raw, 'SELECT alt_ar, alt_ckb, r2_key, source_url FROM product_images WHERE id = ?', 'img_front'
  )!;
  assert.deepEqual(before, {
    alt_ar: 'الواجهة', alt_ckb: 'پێشەوە', r2_key: 'products/a1-front.jpg', source_url: 'https://vendor.example/a1-front.jpg',
  });

  const upd = `template_version=2
product_id=${id}
images.1.id=img_front
images.1.url=https://example.com/a1-front.jpg
images.1.alt_ar=__CLEAR__
images.1.alt_ckb=__CLEAR__
images.1.key=__CLEAR__
images.1.source_url=__CLEAR__
images.1.primary=true
`;
  const { status, body } = await apply(app, upd, 'update');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.mismatches, []);
  assert.deepEqual(
    row(raw, 'SELECT alt_ar, alt_ckb, r2_key, source_url FROM product_images WHERE id = ?', 'img_front'),
    { alt_ar: '', alt_ckb: '', r2_key: '', source_url: '' }
  );
});

test("an image alt_ar identical to alt_en is stored, not discarded as a fake translation", async () => {
  const { raw, app } = setup();
  const text = FULL.replace('images.1.alt_ar=الواجهة', 'images.1.alt_ar=Front');
  const applied = await apply(app, text);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(row<{ alt_ar: string }>(raw, 'SELECT alt_ar FROM product_images WHERE id = ?', 'img_front')!.alt_ar, 'Front');
});

// =========================================================================
// Root cause 8 — §11 financial scope enforced in one place out of three
// =========================================================================

test('root cause 8: an account without financial scope writes no cost on CREATE — row, relation rows or JSON mirror', async () => {
  const { raw, assistant } = setup();
  const text = FULL
    .replace('options.1.sku_part=A1', 'options.1.sku_part=A1\noptions.1.cost_iqd=111222')
    .replace('colors.1.active=true', 'colors.1.active=true\ncolors.1.cost_iqd=333444');
  const { status, body } = await apply(assistant, text);
  assert.equal(status, 200, JSON.stringify(body));
  const id = body.product_id as string;

  const p = row<{ product_cost_iqd: number | null; options: string; colors: string }>(
    raw, 'SELECT product_cost_iqd, options, colors FROM products WHERE id = ?', id
  )!;
  assert.equal(p.product_cost_iqd, null, 'an assistant created a product carrying a cost');
  const jsonOptions = JSON.parse(p.options) as Array<{ cost_iqd: number | null }>;
  const jsonColors = JSON.parse(p.colors) as Array<{ cost_iqd: number | null }>;
  assert.deepEqual(jsonOptions.map((o) => o.cost_iqd), [null, null, null], 'cost leaked into the JSON mirror');
  assert.deepEqual(jsonColors.map((x) => x.cost_iqd), [null], 'cost leaked into the JSON mirror');
  assert.deepEqual(
    all<{ cost_iqd: number | null }>(raw, 'SELECT cost_iqd FROM product_option_values WHERE product_id = ?', id).map((r) => r.cost_iqd),
    [null, null, null]
  );

  // The refusal is named, and the field is reported as preserved — never as
  // applied, which would claim a write that did not happen.
  assert.ok((body.warnings as string[]).some((w) => w.includes('cost is not editable by this account')));
  assert.ok(!(body.applied_fields as string[]).includes('product_cost_iqd'));
  assert.ok((body.preserved_fields as string[]).includes('product_cost_iqd'));
  assert.ok((body.cost_refused as string[]).includes('product_cost_iqd'));
  // §11 also keeps the numbers out of the answer this account reads.
  assert.ok(!JSON.stringify(body).includes('111222'));
  assert.ok(!JSON.stringify(body).includes('333444'));
});

test('root cause 8: an UPDATE without financial scope keeps every stored cost, rows and mirror alike', async () => {
  const { raw, app, assistant } = setup();
  const text = FULL.replace('options.1.sku_part=A1', 'options.1.sku_part=A1\noptions.1.cost_iqd=280000');
  const id = (await apply(app, text)).body.product_id as string;

  const upd = `template_version=2
product_id=${id}
product_cost_iqd=1
options.1.id=opt_base
options.1.group=Model
options.1.name_ar=إيه ١
options.1.name_en=A1
options.1.cost_iqd=1
`;
  const { status, body } = await apply(assistant, upd, 'update');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(row<{ product_cost_iqd: number }>(raw, 'SELECT product_cost_iqd FROM products WHERE id = ?', id)!.product_cost_iqd, 300000);
  assert.equal(row<{ cost_iqd: number }>(raw, 'SELECT cost_iqd FROM product_option_values WHERE id = ?', 'opt_base')!.cost_iqd, 280000);
  const mirror = JSON.parse(row<{ options: string }>(raw, 'SELECT options FROM products WHERE id = ?', id)!.options) as Array<{
    id: string; cost_iqd: number | null;
  }>;
  assert.equal(mirror.find((o) => o.id === 'opt_base')!.cost_iqd, 280000, 'the JSON mirror was overwritten with the refused cost');
});

// =========================================================================
// Root cause 9 — spec.<id> accepted blind, invisible in the form
// =========================================================================

test('root cause 9: a spec id outside the product section is stored, WARNED about and named in the response', async () => {
  const { app } = setup();
  const { status, body } = await apply(app, FULL.replace('spec.model=A1', 'spec.model=A1\nspec.made_up_field=zzz'));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.spec_fields.outside_section, ['made_up_field']);
  assert.equal(body.spec_fields.stored, 4);
  assert.equal(body.spec_fields.visible_in_form, 3);
  assert.ok((body.warnings as string[]).some((w) => w.includes('spec.made_up_field')));

  // Nothing is invented and nothing is thrown away: the value is still stored.
  const { doc } = await formView(app, body.product_id as string);
  assert.equal((doc.spec_fields as Record<string, string>).made_up_field, 'zzz');
});

test('root cause 9: every spec id of the resolved section is reported as visible, none as outside', async () => {
  const { app } = setup();
  const { body } = await apply(app, FULL);
  assert.deepEqual(body.spec_fields.outside_section, []);
  assert.equal(body.spec_fields.visible_in_form, 3);
  assert.equal(body.spec_fields.family, 'devices');
});

// =========================================================================
// Root cause 10 — the next form save regenerated the imported Arabic
// =========================================================================

test('root cause 10: a form save does NOT overwrite the Arabic and Kurdish the file authored', async () => {
  const { app } = setup();
  const id = (await apply(app, FULL)).body.product_id as string;
  const { doc } = await formView(app, id);
  assert.equal(doc.description_ar, 'وصف عربي أصيل');

  // The owner opens the product and saves it untouched, exactly as the form
  // does: the English fields are the form's, the Arabic is the file's.
  const saved = await json(await post(app, '/api/admin/products-v2', { ...doc, id }));
  assert.equal(saved.success, true, JSON.stringify(saved));
  const after = (await formView(app, id)).doc;
  assert.equal(after.description_ar, 'وصف عربي أصيل', 'the imported Arabic description was regenerated by a form save');
  assert.equal(after.name_ar, 'طابعة بامبو A1', 'the imported Arabic name was regenerated by a form save');
  assert.equal(after.description_ckb, 'وەسفی کوردی');

  // Changing the English source is what releases the machine translation.
  const changed = await json(await post(app, '/api/admin/products-v2', { ...after, id, description_en: 'A brand new English body' }));
  assert.equal(changed.success, true, JSON.stringify(changed));
});

// =========================================================================
// Root cause 12 — side effects the form performs, absent on the TXT path
// =========================================================================

test('root cause 12: a TXT price change writes price_history, registers hashtags, writes translations and audits the relations save', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, FULL)).body.product_id as string;
  assert.ok(count(raw, 'SELECT COUNT(*) AS n FROM hashtags') >= 2, 'hashtag vocabulary not registered');
  assert.ok(count(raw, 'SELECT COUNT(*) AS n FROM product_translations WHERE product_id = ?', id) > 0, 'no product_translations rows');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.relations.save' AND target = ?", id), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.apply' AND target = ?", id), 1);

  const upd = `template_version=2
product_id=${id}
price_iqd=520000
pro_price_iqd=460000
hashtags=bambu,a1,parity
`;
  const { status, body } = await apply(app, upd, 'update');
  assert.equal(status, 200, JSON.stringify(body));
  const history = all<{ field: string; old_iqd: number; new_iqd: number; changed_by: string }>(
    raw, 'SELECT field, old_iqd, new_iqd, changed_by FROM price_history WHERE product_id = ? ORDER BY field', id
  );
  assert.deepEqual(history, [
    { field: 'pro', old_iqd: 450000, new_iqd: 460000, changed_by: OWNER.id },
    { field: 'regular', old_iqd: 500000, new_iqd: 520000, changed_by: OWNER.id },
  ]);
  assert.equal(body.price_history_rows, 2);
  assert.ok(count(raw, "SELECT COUNT(*) AS n FROM hashtags WHERE tag = 'parity'") === 1);
});

// =========================================================================
// Root cause 13 — the round trip renumbered and reordered the structure
// =========================================================================

test('root cause 13: export → parse → apply is order-stable for groups, values and every price on a form-built product', async () => {
  const { raw, app } = setup();
  const created = await json(
    await post(app, '/api/admin/products-v2', { name_en: 'Ordered', name_ar: 'مرتب', price_iqd: 200000, status: 'draft' })
  );
  const id = created.product.id as string;
  const relBody = {
    inventory_mode: 'OPTION',
    groups: [
      {
        id: 'og_model', name_en: 'Model', sort: 0, active: true,
        values: [
          { id: 'ov_a1', name_en: 'A1', name_ar: 'إيه ١', sort: 0, active: true, stock: 4, cost_iqd: 280000 },
          { id: 'ov_combo', name_en: 'A1 Combo', name_ar: 'كومبو', sort: 1, active: true, stock: 2, regular_adjust_iqd: 150000 },
        ],
      },
      {
        id: 'og_nozzle', name_en: 'Nozzle', sort: 1, active: true,
        values: [
          { id: 'ov_n04', name_en: '0.4mm', name_ar: '٠٫٤', sort: 0, active: true },
          { id: 'ov_n06', name_en: '0.6mm', name_ar: '٠٫٦', sort: 1, active: false, regular_adjust_iqd: 25000 },
        ],
      },
    ],
    colors: [{ id: 'pc_black', name_en: 'Black', name_ar: 'أسود', hex: '#000000', sort: 0, active: true, option_value_ids: ['ov_a1', 'ov_combo'] }],
    variants: [],
    images: [{ id: 'pi_front', url: '/files/a.jpg', alt_en: 'front', sort_order: 0, is_primary: true }],
  };
  assert.equal((await put(app, `/api/admin/products/${id}/relations`, relBody)).status, 200);

  const snapshot = () => ({
    groups: all(raw, 'SELECT id, name_en, sort FROM product_option_groups WHERE product_id = ? ORDER BY sort, id', id),
    values: all(raw, 'SELECT id, group_id, name_en, name_ar, sort, stock, regular_adjust_iqd, cost_iqd FROM product_option_values WHERE product_id = ? ORDER BY sort, id', id),
    colors: all(raw, 'SELECT id, name_en, name_ar, hex, sort FROM product_colors WHERE product_id = ? ORDER BY sort, id', id),
    links: all(raw, 'SELECT option_value_id FROM product_color_option_links WHERE color_id = ? ORDER BY option_value_id', 'pc_black'),
    images: all(raw, 'SELECT id, url, is_primary, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order', id),
  });
  const before = snapshot();

  const text = await (await get(app, `/api/admin/template/export/${id}?include_media=false`)).text();
  const { status, body } = await apply(app, text, 'update');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.mismatches, []);
  assert.deepEqual(snapshot(), before, 'the round trip moved the structure it was supposed to preserve');

  // A second round trip is a no-op too — the export is a fixed point.
  const text2 = await (await get(app, `/api/admin/template/export/${id}?include_media=false`)).text();
  assert.equal((await apply(app, text2, 'update')).status, 200);
  assert.deepEqual(snapshot(), before);
});

// =========================================================================
// Root cause 14 — catalogs (and everything else) outside the write batch
// =========================================================================

test('root cause 14: when the batch fails NOTHING lands — no product row, no relations, no catalogs', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو','Bambu Lab')").run();
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, OWNER, mount);

  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO products/i.test(s.sql));
  const res = await post(app, '/api/admin/template/apply', { text: FULL, mode: 'draft', confirm: true });
  assert.equal(res.status, 500);

  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE slug = 'parity-a1'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_groups'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_values'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_colors'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_catalogs'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM price_history'), 0);

  // The catalog rows are part of the same batch, not a follow-up write.
  const batch = failing.batches.at(-1) ?? [];
  assert.ok(batch.some((s) => /INSERT INTO products/i.test(s)));
  assert.ok(batch.some((s) => /product_option_values/i.test(s)));
  assert.ok(batch.some((s) => /product_images/i.test(s)));
  assert.ok(batch.some((s) => /product_catalogs/i.test(s)));

  // And the fingerprint was released, so the corrected retry is not refused
  // as a double submission.
  failing.failWhen = null;
  const retry = await post(app, '/api/admin/template/apply', { text: FULL, mode: 'draft', confirm: true });
  const out = await json(retry);
  assert.equal(retry.status, 200, JSON.stringify(out));
  assert.equal(out.already_applied, false);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_catalogs WHERE product_id = ?', out.product_id), 2);
});

// =========================================================================
// Root cause 11 / 15 — the answer is the read-back, not the parse
// =========================================================================

test('root cause 11: the apply response reports the read-back counters, the unknown keys and the mismatch list', async () => {
  const { app } = setup();
  const { body } = await apply(app, FULL);
  for (const key of [
    'applied_fields', 'preserved_fields', 'cleared_fields', 'unknown_keys', 'warnings',
    'relations', 'images', 'spec_fields', 'option_groups', 'option_values', 'colors', 'mismatches',
  ]) {
    assert.ok(key in body, `the apply response is missing "${key}"`);
  }
  // Counters are the stored truth: they equal what the tables answer.
  const { rel } = await formView(app, body.product_id as string);
  assert.equal(body.relations.values, (rel.values as unknown[]).length);
  assert.equal(body.relations.images, (rel.images as unknown[]).length);
  assert.equal(body.relations.inventory_mode, rel.product.inventory_mode);
});

test('a verification mismatch answers 5xx naming the section and the field, and a failed CREATE leaves no product behind', async () => {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو','Bambu Lab')").run();
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, OWNER, mount);

  // A batch that quietly drops the image statements: the write "succeeds",
  // the read-back does not match, and the route must say so rather than
  // answering success:true (docs/TXT_IMPORT_PARITY.md, root cause 11).
  failing.beforeBatch = (stmts) => {
    for (let i = stmts.length - 1; i >= 0; i -= 1) if (/INSERT INTO product_images/i.test(stmts[i].sql)) stmts.splice(i, 1);
  };
  const res = await post(app, '/api/admin/template/apply', { text: FULL, mode: 'draft', confirm: true });
  const body = await json(res);
  assert.equal(res.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.code, 'APPLY_VERIFY_FAILED');
  assert.equal(body.section, 'images');
  assert.ok(String(body.error).includes('images'));
  assert.ok(Array.isArray(body.mismatches) && body.mismatches.length > 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE slug = 'parity-a1'"), 0, 'a half-applied product was left behind');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_catalogs'), 0);
});

// =========================================================================
// Semantics and guards (§5.5 test D) — preserve / clear / null / inventory
// =========================================================================

test('an omitted key preserves, __CLEAR__ clears, __NULL__ nulls only what is nullable', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, FULL)).body.product_id as string;

  // Omitted → preserved, groups included.
  const rename = `template_version=2\nproduct_id=${id}\nname_en=Renamed A1\n`;
  const kept = await apply(app, rename, 'update');
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  const afterRename = (await formView(app, id)).doc;
  assert.equal(afterRename.name_en, 'Renamed A1');
  assert.equal(afterRename.description_ar, 'وصف عربي أصيل');
  assert.deepEqual(afterRename.spec_fields, { technology: 'FDM', model: 'A1', build_volume: '256 x 256 x 256' });
  assert.deepEqual(tableCounts(raw, id).values, 3);
  assert.ok((kept.body.preserved_fields as string[]).includes('spec_groups'));

  // __CLEAR__ empties what the type allows, and the rows really go.
  const clear = `template_version=2
product_id=${id}
description_en=__CLEAR__
sku=__CLEAR__
hashtags=__CLEAR__
spec.model=__CLEAR__
labels=__CLEAR__
images=__CLEAR__
`;
  const cleared = await apply(app, clear, 'update');
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const afterClear = (await formView(app, id)).doc;
  assert.equal(afterClear.description_en, '');
  assert.equal(afterClear.sku, null);
  assert.deepEqual(afterClear.hashtags, []);
  assert.deepEqual(afterClear.labels, []);
  assert.deepEqual(afterClear.spec_fields, { technology: 'FDM', build_volume: '256 x 256 x 256' });
  assert.equal(tableCounts(raw, id).images, 0, '__CLEAR__ on images left the rows behind');
  assert.equal(cleared.body.relations.images, 0);

  // __NULL__ on a non-nullable field is refused before anything is written.
  const bad = `template_version=2\nproduct_id=${id}\nname_en=__NULL__\nprice_iqd=__NULL__\n`;
  const refused = await apply(app, bad, 'update');
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'TEMPLATE_ERRORS');
  assert.equal((await formView(app, id)).doc.name_en, 'Renamed A1');

  // …and nulls the nullable ones.
  const nulls = `template_version=2\nproduct_id=${id}\nstock=__NULL__\nprime_price_iqd=__NULL__\ndirect_surcharge_iqd=__NULL__\n`;
  const nulled = await apply(app, nulls, 'update');
  assert.equal(nulled.status, 200, JSON.stringify(nulled.body));
  const afterNull = (await formView(app, id)).doc;
  assert.equal(afterNull.stock, null);
  assert.equal(afterNull.prime_price_iqd, null);
  assert.equal(afterNull.direct_surcharge_iqd, null);
});

test('reserved stock is never written away, and the refusal leaves every row intact', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, FULL)).body.product_id as string;
  raw.prepare('UPDATE product_option_values SET reserved = 2 WHERE id = ?').run('opt_combo');

  // Dropping the reserved value from the file must fail the WHOLE write.
  const drop = `template_version=2
product_id=${id}
options=__CLEAR__
`;
  const { status, body } = await apply(app, drop, 'update');
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(body.code, 'RELATIONS_VALIDATION');
  assert.equal(body.section, 'relations');
  assert.equal(tableCounts(raw, id).values, 3, 'a reserved option value was removed anyway');

  // And a base stock below the reservation is refused the same way.
  raw.prepare('UPDATE products SET stock_reserved = 5 WHERE id = ?').run(id);
  const low = await apply(app, `template_version=2\nproduct_id=${id}\nstock=1\n`, 'update');
  assert.equal(low.status, 400, JSON.stringify(low.body));
  assert.equal(row<{ stock: number }>(raw, 'SELECT stock FROM products WHERE id = ?', id)!.stock, 7);
});

test('a variant an open order still names is deactivated by the TXT path, never deleted', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, FULL)).body.product_id as string;

  // The combination the shop actually sold, modelled as the form models it:
  // the wire body nests values inside their group, exactly as ProductForm PUTs.
  const relBefore = await json(await get(app, `/api/admin/products/${id}/relations`));
  const values = relBefore.values as Array<{ id: string; group_id: string }>;
  const withVariant = {
    inventory_mode: 'VARIANT_COMBINATION',
    groups: (relBefore.groups as Array<{ id: string }>).map((g) => ({
      ...g,
      values: values.filter((v) => v.group_id === g.id),
    })),
    colors: (relBefore.colors as Array<Record<string, unknown>>).map((col) => ({
      ...col,
      option_value_ids: (relBefore.links as Array<{ color_id: string; option_value_id: string }>)
        .filter((l) => l.color_id === col.id)
        .map((l) => l.option_value_id),
    })),
    images: relBefore.images,
    variants: [{ id: 'pv_live', option_value_ids: ['opt_base'], color_id: 'col_black', sku: 'SKU-LIVE', active: 1, stock: 5 }],
  };
  const putRes = await put(app, `/api/admin/products/${id}/relations`, withVariant);
  assert.equal(putRes.status, 200, JSON.stringify(await putRes.json()));

  raw.prepare("INSERT INTO users (id, email, name, role) VALUES ('usr_buyer','buyer@x.co','Buyer','customer')").run();
  raw
    .prepare(
      `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
                           payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd)
       VALUES ('ord_live','usr_buyer','confirmed','{}','dm','{}','cod',1,1500,1,0)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd,
                                option_id, color_id, option_value_ids)
       VALUES ('oi_live','ord_live',?, 'Bambu Lab A1', 1, 1, 1, '', 'col_black', '["opt_base"]')`
    )
    .run(id);

  // The file drops the colour the live line names. The combination may not be
  // deleted out from under the order — it is deactivated, and the answer says so.
  const drop = `template_version=2\nproduct_id=${id}\ncolors=__CLEAR__\n`;
  const { status, body } = await apply(app, drop, 'update');
  assert.equal(status, 200, JSON.stringify(body));
  const variant = row<{ id: string; active: number }>(raw, 'SELECT id, active FROM product_variants WHERE id = ?', 'pv_live');
  assert.ok(variant, 'a variant an open order still names was deleted');
  assert.equal(variant!.active, 0, 'the variant stayed on sale after its colour was removed');
  assert.ok((body.warnings as string[]).some((w) => w.includes('deactivated instead of deleted')));
  assert.deepEqual(body.mismatches, []);
});

test('the storefront and the admin form read the same structure after a TXT create', async () => {
  const { app } = setup();
  const id = (await apply(app, FULL)).body.product_id as string;
  await app.request(`/api/admin/products-v2/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ status: 'active' }),
  });

  const { rel } = await formView(app, id);
  const pub = await json(await get(app, '/api/products/parity-a1'));
  assert.equal(pub.success, true);
  assert.equal(pub.relations.option_groups.length, (rel.groups as unknown[]).length);
  assert.equal(pub.relations.images.length, (rel.images as unknown[]).length);
  assert.equal(pub.relations.colors.length, (rel.colors as unknown[]).length);
  assert.equal(pub.relations.inventory_mode, rel.product.inventory_mode);
  // The option stock the file stated is the tracked level the shop sells from.
  const values = pub.relations.option_groups.flatMap((g: { values: Array<{ id: string; available: number | null }> }) => g.values);
  assert.equal(values.find((v: { id: string }) => v.id === 'opt_base')!.available, 4);
});

// =========================================================================
// The other half of the parity: the FORM routes run the same contract
// =========================================================================

test('the form save is the same one batch: a failure leaves no product, no relations and no catalogs', async () => {
  const raw = freshDb();
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, OWNER, mount);

  failing.failWhen = (stmts) => stmts.some((s) => /product_option_values/i.test(s.sql));
  const res = await post(app, '/api/admin/products-v2', {
    name_en: 'Atomic', name_ar: 'ذرّي', price_iqd: 100000, status: 'draft',
    catalog_ids: ['cat_printers'],
    relations: {
      inventory_mode: 'OPTION',
      groups: [{ id: 'og_x', name_en: 'Model', sort: 0, active: true, values: [{ id: 'ov_x', name_en: 'A', sort: 0, active: true, stock: 2 }] }],
      colors: [], variants: [], images: [{ id: 'pi_x', url: '/files/x.jpg', sort_order: 0, is_primary: true }],
    },
  });
  assert.equal(res.status, 500);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE name = 'Atomic'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_option_groups'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_images'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_catalogs'), 0);

  const batch = failing.batches.at(-1) ?? [];
  assert.ok(batch.some((s) => /INSERT INTO products/i.test(s)));
  assert.ok(batch.some((s) => /product_option_groups/i.test(s)));
  assert.ok(batch.some((s) => /product_catalogs/i.test(s)));
});

test('the form relations PUT derives inventory_mode and audits the save through the same contract', async () => {
  const { raw, app } = setup();
  const created = await json(
    await post(app, '/api/admin/products-v2', { name_en: 'Wrapper', name_ar: 'غلاف', price_iqd: 100000, status: 'draft' })
  );
  const id = created.product.id as string;
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    groups: [{ id: 'og_w', name_en: 'Model', sort: 0, active: true, values: [{ id: 'ov_w', name_en: 'A', sort: 0, active: true, stock: 3 }] }],
    colors: [], variants: [], images: [],
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.inventory_mode, 'OPTION');
  assert.equal(row<{ inventory_mode: string }>(raw, 'SELECT inventory_mode FROM products WHERE id = ?', id)!.inventory_mode, 'OPTION');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.relations.save' AND target = ?", id), 1);
});

test('the /parse response keeps every field the admin UI already reads, and gains the read-back-shaped ones', async () => {
  const { app } = setup();
  const res = await post(app, '/api/admin/template/parse', { text: FULL });
  const body = await json(res);
  assert.equal(res.status, 200);
  for (const key of ['success', 'errors', 'warnings', 'unknown_keys', 'needs_review', 'applied_fields', 'preview']) {
    assert.ok(key in body, `the parse response no longer carries "${key}"`);
  }
  assert.deepEqual(body.errors, []);
  assert.deepEqual(body.unknown_keys, []);
  assert.equal(body.spec_fields.family, 'devices');
});
