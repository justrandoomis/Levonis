/**
 * «تحديث البيانات» — worker/lib/sectionUpdate.ts and the three routes behind
 * the product editor's button: the file to edit, the comparison, the save.
 *
 * The owner: «تنزيل قالب المنتج، ورفع القالب الجديد … يبدأ بمقارنة الحقول
 * المتغيرة … زر للحفظ (التغييرات في قسم المواصفات والمحتوى الإضافي فقط) لا
 * يلمس البيانات للأقسام الأخرى».
 *
 * Real migrations, real SQLite, the real template router.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, row } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import {
  csvToTemplateText,
  isSectionKey,
  scanTemplate,
  sectionTemplate,
  templateTextToCsv,
} from '../worker/lib/sectionUpdate';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

function setup() {
  const raw = freshDb();
  const db = asD1(raw);
  const app = stubApp(db, OWNER, (a) => a.route('/api/admin/template', templateRoutes));
  return { raw, db, app };
}

const PRODUCT = `template_version=2
slug=pla-pure-white
name_ar=فلمنت PLA بيور
name_en=PLA Pure
price_iqd=25000
selling_type=direct_sale
spec.print_speed=300
spec.nozzle_temp=190-230
content_blocks.1.id=cb_intro
content_blocks.1.kind=text
content_blocks.1.body_ar=نص تعريفي
`;

type App = ReturnType<typeof setup>['app'];

async function create(app: App): Promise<string> {
  const res = await post(app, '/api/admin/template/apply', { text: PRODUCT, mode: 'draft', confirm: true });
  const body = (await res.json()) as { product_id?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.product_id!;
}

interface Preview {
  success: boolean;
  updated_at: string | null;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
  ignored_keys: string[];
  ignored_changes: Array<{ field: string; before: string | null; after: string | null }>;
  errors: unknown[];
  validation_error: unknown;
}

const preview = async (app: App, productId: string, text: string, format?: 'csv') =>
  (await (await post(app, '/api/admin/template/section-preview', { product_id: productId, text, format })).json()) as Preview;

const save = (app: App, productId: string, text: string, expected: string | null, format?: 'csv') =>
  post(app, '/api/admin/template/apply', {
    text,
    mode: 'update',
    confirm: true,
    scope: 'specs_content',
    product_id: productId,
    expected_updated_at: expected,
    format,
  });

// ------------------------------------------------------------------ pure

test('a key belongs to «المواصفات والمحتوى الإضافي» only when section 7 shows it', () => {
  for (const k of [
    'spec.print_speed',
    'spec_groups.1.rows.2.value_ar',
    'labels.1.text_ar',
    'content_blocks.3.body_en',
    'content_blocks',
    'usage_steps.1.title_ar',
    'usage_official_url',
    'how_to_use_ar',
  ]) {
    assert.equal(isSectionKey(k), true, k);
  }
  for (const k of ['price_iqd', 'name_ar', 'options.1.id', 'colors.1.hex', 'images.1.url', 'spec.', 'category', 'slug', 'status']) {
    assert.equal(isSectionKey(k), false, k);
  }
});

test('the file is cut to the section, heredocs whole, with the header written by the server', () => {
  const text = [
    'template_version=2',
    'product_id=someone_else',
    'expected_updated_at=2020-01-01',
    'price_iqd=1',
    '# a comment',
    'spec.print_speed=500',
    'content_blocks.1.body_ar=<<<END',
    'سطر أول',
    'price_iqd=99',
    'END',
    'options.1.name_en=Hacked',
  ].join('\n');
  const cut = sectionTemplate(text, 'prd_1', '2026-09-27T00:00:00.000Z');
  assert.deepEqual(
    cut.kept.map((e) => [e.key, e.value]),
    [
      ['spec.print_speed', '500'],
      ['content_blocks.1.body_ar', 'سطر أول\nprice_iqd=99'],
    ],
    'a price line INSIDE a heredoc is text, not a key'
  );
  assert.deepEqual(cut.ignored.map((e) => e.key), ['price_iqd', 'options.1.name_en']);
  const lines = scanTemplate(cut.text).entries.map((e) => e.key);
  assert.deepEqual(lines, ['template_version', 'product_id', 'expected_updated_at', 'spec.print_speed', 'content_blocks.1.body_ar']);
  assert.match(cut.text, /product_id=prd_1\n/);
  assert.match(cut.text, /expected_updated_at=2026-09-27T00:00:00.000Z\n/);
});

test('a spreadsheet round-trips: multi-line cells, commas, quotes and formula-looking values', () => {
  const text = [
    'spec.print_speed=500',
    'spec.note=-20 °C, "cold" start',
    'content_blocks.1.body_ar=<<<END',
    'سطر أول',
    'سطر ثانٍ',
    'END',
  ].join('\n');
  const csv = templateTextToCsv(text);
  assert.match(csv, /^\uFEFFkey,value\r\n/);
  const back = csvToTemplateText(csv);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(
    scanTemplate(back.text).entries.map((e) => [e.key, e.value]),
    [
      ['spec.print_speed', '500'],
      ['spec.note', '-20 °C, "cold" start'],
      ['content_blocks.1.body_ar', 'سطر أول\nسطر ثانٍ'],
    ]
  );
  assert.deepEqual(csvToTemplateText('key,value\nnot a key!,x\n').errors.length, 1);
});

// ------------------------------------------------------------------ routes

test('the file to edit carries the section and nothing else', async () => {
  const { app } = setup();
  const id = await create(app);
  const txt = await (await get(app, `/api/admin/template/section-export/${id}`)).text();
  const keys = scanTemplate(txt).entries.map((e) => e.key);
  assert.ok(keys.includes('spec.print_speed'));
  assert.ok(keys.includes('content_blocks.1.body_ar'));
  assert.ok(!keys.some((k) => k === 'price_iqd' || k === 'name_ar' || k.startsWith('options.')), keys.join(','));
  const csvRes = await get(app, `/api/admin/template/section-export/${id}?format=csv`);
  assert.match(csvRes.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(await csvRes.text(), /spec\.print_speed,300/);
});

test('the comparison names every changed field of the section — and what the file says elsewhere, which it will not touch', async () => {
  const { app } = setup();
  const id = await create(app);
  // The owner edits the FULL export: a spec, a content block — and the price.
  const full = await (await get(app, `/api/admin/template/export/${id}`)).text();
  const edited = full
    .replace('spec.print_speed=300', 'spec.print_speed=600')
    .replace('content_blocks.1.body_ar=نص تعريفي', 'content_blocks.1.body_ar=نص جديد')
    .replace(/price_iqd=25000/, 'price_iqd=19000');
  const p = await preview(app, id, edited);
  assert.equal(p.success, true);
  assert.deepEqual(p.errors, []);
  assert.equal(p.validation_error, null);
  assert.deepEqual(
    p.changes.map((c) => [c.field, c.before, c.after]).sort(),
    [
      ['content_blocks.1.body_ar', 'نص تعريفي', 'نص جديد'],
      ['spec.print_speed', '300', '600'],
    ]
  );
  assert.ok(p.ignored_keys.includes('price_iqd'));
  assert.deepEqual(
    p.ignored_changes.filter((c) => c.field === 'price_iqd').map((c) => [c.before, c.after]),
    [['25000', '19000']],
    'the price change is named, as not applied'
  );
});

test('the save writes the section only: the specs and the content change, the price and the name do not', async () => {
  const { app, raw } = setup();
  const id = await create(app);
  const full = await (await get(app, `/api/admin/template/export/${id}`)).text();
  const edited = full
    .replace('spec.print_speed=300', 'spec.print_speed=600')
    .replace('content_blocks.1.body_ar=نص تعريفي', 'content_blocks.1.body_ar=نص جديد')
    .replace(/price_iqd=25000/, 'price_iqd=19000')
    .replace(/name_en=PLA Pure/, 'name_en=Renamed');
  const p = await preview(app, id, edited);
  const res = await save(app, id, edited, p.updated_at);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const stored = row(raw, 'SELECT price_iqd, name, spec_fields, content_blocks FROM products WHERE id = ?', id)!;
  assert.equal(stored.price_iqd, 25000, 'the price is untouched');
  assert.equal(stored.name, 'PLA Pure', 'the name is untouched');
  assert.equal(JSON.parse(stored.spec_fields as string).print_speed, '600');
  assert.equal(JSON.parse(stored.spec_fields as string).nozzle_temp, '190-230', 'an unmentioned spec keeps its value');
  assert.equal(JSON.parse(stored.content_blocks as string)[0].body_ar, 'نص جديد');
});

test('a spreadsheet takes the same door', async () => {
  const { app, raw } = setup();
  const id = await create(app);
  const csv = await (await get(app, `/api/admin/template/section-export/${id}?format=csv`)).text();
  const edited = csv.replace('spec.print_speed,300', 'spec.print_speed,450');
  const p = await preview(app, id, edited, 'csv');
  assert.deepEqual(p.changes.map((c) => [c.field, c.after]), [['spec.print_speed', '450']]);
  const res = await save(app, id, edited, p.updated_at, 'csv');
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(JSON.parse(row(raw, 'SELECT spec_fields FROM products WHERE id = ?', id)!.spec_fields as string).print_speed, '450');
});

test('a product changed after the comparison is not overwritten, and a file with nothing for the section writes nothing', async () => {
  const { app, raw } = setup();
  const id = await create(app);
  const edited = 'spec.print_speed=700\n';
  const p = await preview(app, id, edited);
  raw.prepare(`UPDATE products SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  const stale = await save(app, id, edited, p.updated_at);
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code?: string }).code, 'STALE');
  assert.equal(JSON.parse(row(raw, 'SELECT spec_fields FROM products WHERE id = ?', id)!.spec_fields as string).print_speed, '300');

  const nothing = await save(app, id, 'price_iqd=1\nname_en=X\n', null);
  assert.equal(nothing.status, 400);
  assert.equal(((await nothing.json()) as { code?: string }).code, 'NOTHING_TO_UPDATE');
  assert.equal(row(raw, 'SELECT price_iqd FROM products WHERE id = ?', id)!.price_iqd, 25000);
});

test('on every product of the live catalogue, the save changes no column outside section 7 and no option, colour, picture or combination', async () => {
  const { seedLiveCatalog } = await import('./fixtures/liveCatalog');
  const { raw, app } = setup();
  seedLiveCatalog(raw);
  // Bookkeeping that describes the section's own texts, and the document
  // format version every save writes — never a value the owner set elsewhere.
  const SECTION_OR_BOOKKEEPING = new Set([
    'spec_fields', 'spec_groups', 'labels', 'content_blocks', 'usage_guide',
    'how_to_use', 'how_to_use_ar', 'how_to_use_ckb',
    'updated_at', 'content_rev', 'translation_meta', 'doc_version',
  ]);
  const relations = (id: string) =>
    JSON.stringify(
      ['product_option_groups', 'product_option_values', 'product_colors', 'product_images', 'product_variants'].map((t) =>
        raw.prepare(`SELECT * FROM ${t} WHERE product_id = ? ORDER BY id`).all(id)
      )
    );
  const ids = (raw.prepare(`SELECT id FROM products ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
  assert.ok(ids.length >= 10);
  for (const id of ids) {
    const before = raw.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, unknown>;
    const relBefore = relations(id);
    // The FULL export, one spec added: everything else in it is ignored.
    const edited = `${await (await get(app, `/api/admin/template/export/${id}`)).text()}\nspec.section_probe=${id}\n`;
    const p = await preview(app, id, edited);
    assert.equal(p.validation_error, null, `${id}: ${JSON.stringify(p.validation_error)}`);
    const res = await save(app, id, edited, p.updated_at);
    assert.equal(res.status, 200, `${id}: ${JSON.stringify(await res.clone().json())}`);
    const after = raw.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, unknown>;
    const drift = Object.keys(before).filter(
      (k) => !SECTION_OR_BOOKKEEPING.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])
    );
    assert.deepEqual(drift, [], `${id}: ${drift.map((k) => `${k} ${String(before[k])} → ${String(after[k])}`).join('; ')}`);
    assert.equal(relations(id), relBefore, `${id}: relations changed`);
    assert.equal(JSON.parse(after.spec_fields as string).section_probe, id);
  }
});
