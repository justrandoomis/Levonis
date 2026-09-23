/**
 * «عند استيراد منتج يرفض بسبب أن البراند غير موجود اجعل ينشئ البراند بدل أن
 * يرفض ... بالرغم من هذا فإن البراند موجود مثل بامبو لاب وليفو لكنه يرفض»
 * — IN THE CSV / ZIP LANE.
 *
 * The TXT lane was fixed on both halves (tests/templateBrandResolve.test.ts).
 * The panel's other two formats post to /api/admin/import/preview + /confirm,
 * which still read `brands WHERE active = 1` through `normKey` and refused
 * every miss with «أضفها أولًا». These drive that real router on a real
 * migrated database.
 *
 * Run: node --import tsx --test tests/importBrandCreate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, ctx, all, count, row, type App } from './fixtures/app';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { toCsv } from '../worker/lib/importCsv';

const SECTION = 'tpl_printers';

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role)
      VALUES ('boss','Admin','boss@x.co','h','admin');
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,template_family,is_printer_catalog,active)
      VALUES ('${SECTION}',NULL,'tpl-printers','طابعات القالب','Template Printers','devices',1,1);
    INSERT INTO brands (id, slug, name_ar, name_en, name_ckb, active) VALUES
      ('brd_bambu', 'bambu-lab', 'بامبو لاب', 'Bambu Lab', '', 1),
      ('brd_levo', 'levo', 'ليفو', 'Levo', 'لیڤۆ', 1),
      ('brd_anker', 'anker', 'أنكر', 'Anker', '', 1),
      ('brd_qidi', 'qidi', 'كيدي', 'Qidi', '', 0);
  `);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) =>
    a.route('/api/admin/import', adminImportRoutes)
  );
  return { raw, app };
}

const HEAD = ['row_type', 'key', 'name', 'status', 'category', 'brand', 'price_iqd', 'stock'];

const product = (key: string, brand: string, over: Record<string, string> = {}) => {
  const cells: Record<string, string> = {
    row_type: 'product',
    key,
    name: `Printer ${key}`,
    status: 'active',
    category: 'tpl-printers',
    brand,
    price_iqd: '1000000',
    stock: '5',
    ...over,
  };
  return HEAD.map((c) => cells[c] ?? '');
};

const sheet = (...rows: string[][]) => toCsv([HEAD, ...rows]);

interface PreviewBody {
  success?: boolean;
  import_id: string;
  rows: Array<{ key: string; action: string; errors: string[]; warnings: string[] }>;
  brands_to_create?: Array<{ name: string; slug: string }>;
}
interface ConfirmBody {
  success?: boolean;
  summary: { created: number; failed: number };
  rows: Array<{ key: string; action: string; product_id: string; reason: string }>;
  brands_created?: Array<{ id: string; name: string; slug: string; created: boolean }>;
}

async function preview(app: App, csv: string): Promise<PreviewBody> {
  const form = new FormData();
  form.set('file', new File([csv], 'data.csv', { type: 'text/csv' }));
  form.set('category', SECTION);
  const res = await app.request(
    '/api/admin/import/preview',
    { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  return (await res.json()) as PreviewBody;
}

async function confirm(app: App, importId: string): Promise<ConfirmBody> {
  const res = await app.request(
    '/api/admin/import/confirm',
    {
      method: 'POST',
      body: JSON.stringify({ import_id: importId }),
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    },
    undefined,
    ctx
  );
  return (await res.json()) as ConfirmBody;
}

const brandOf = (raw: ReturnType<typeof setup>['raw'], productId: string) =>
  row(raw, 'SELECT brand_id FROM products WHERE id = ?', productId)?.brand_id;

// ------------------------------------------------ an unknown brand is created

test('an unknown brand is a WARNING on the row and a top-level disclosure — never an error, nothing written', async () => {
  const { raw, app } = setup();
  const brandsBefore = count(raw, 'SELECT COUNT(*) AS n FROM brands');
  const prev = await preview(app, sheet(product('P-1', 'Elegoo')));
  assert.equal(prev.success, true, JSON.stringify(prev));
  const [r] = prev.rows;
  assert.deepEqual(r.errors, [], 'the row must not be refused');
  assert.equal(r.action, 'create');
  assert.ok(r.warnings.some((w) => /brand: سيُنشأ براند جديد "Elegoo"/.test(w)), JSON.stringify(r.warnings));
  assert.deepEqual(prev.brands_to_create, [{ name: 'Elegoo', slug: 'elegoo' }]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM brands'), brandsBefore, 'a preview writes no brand');
});

test('confirm creates exactly ONE brand for two rows naming it, and files both products under it', async () => {
  const { raw, app } = setup();
  const prev = await preview(app, sheet(product('P-1', 'Elegoo'), product('P-2', 'ELEGOO')));
  assert.deepEqual(prev.rows.flatMap((r) => r.errors), []);
  assert.equal(prev.brands_to_create?.length, 1, 'one pending brand for one name, however spelled');

  const res = await confirm(app, prev.import_id);
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.summary.created, 2, JSON.stringify(res.rows));
  const made = all(raw, "SELECT id, slug, name_en, name_ar, active FROM brands WHERE slug LIKE 'elegoo%'");
  assert.equal(made.length, 1);
  assert.deepEqual(
    { slug: made[0].slug, name_en: made[0].name_en, name_ar: made[0].name_ar, active: made[0].active },
    { slug: 'elegoo', name_en: 'Elegoo', name_ar: 'Elegoo', active: 1 }
  );
  for (const r of res.rows) assert.equal(brandOf(raw, r.product_id), made[0].id, r.key);
  assert.deepEqual(res.brands_created?.map((b) => [b.slug, b.created]), [['elegoo', true]]);

  // Audited like the manual «إضافة علامة», naming the door it came through.
  const audits = all(raw, "SELECT target, detail FROM audit_log WHERE action = 'brand.create'");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].target, made[0].id);
  assert.match(String(audits[0].detail), /product\.import\.confirm/);

  // The same file again finds the row by name — no second brand.
  const again = await preview(app, sheet(product('P-3', 'Elegoo')));
  assert.deepEqual(again.brands_to_create, []);
  await confirm(app, again.import_id);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM brands WHERE slug LIKE 'elegoo%'"), 1);
});

test('a brand added by hand between preview and confirm is used, not duplicated', async () => {
  const { raw, app } = setup();
  const prev = await preview(app, sheet(product('P-1', 'Elegoo')));
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_hand', 'elegoo-hand', 'إليجو', 'Elegoo')").run();
  const res = await confirm(app, prev.import_id);
  assert.equal(res.summary.created, 1, JSON.stringify(res.rows));
  assert.equal(brandOf(raw, res.rows[0].product_id), 'brd_hand');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM brands WHERE name_en = 'Elegoo'"), 1);
});

test('a row refused for another reason leaves no brand to create', async () => {
  const { app } = setup();
  const prev = await preview(app, sheet(product('P-1', 'Elegoo', { price_iqd: 'abc' })));
  assert.ok(prev.rows[0].errors.length > 0, 'the row itself is refused');
  assert.deepEqual(prev.brands_to_create, []);
});

// --------------------------------------- existing brands resolve, any spelling

test('existing brands resolve by English name, Arabic name, hamza variant, Sorani name, slug and id', async () => {
  const { raw, app } = setup();
  const cases: Array<[string, string]> = [
    ['Bambu Lab', 'brd_bambu'],
    ['بامبو لاب', 'brd_bambu'],
    ['ليفو', 'brd_levo'],
    ['LEVO', 'brd_levo'],
    ['لیڤۆ', 'brd_levo'], // name_ckb
    ['انكر', 'brd_anker'], // stored «أنكر»: the hamza carrier folds
    ['bambu-lab', 'brd_bambu'],
    ['brd_levo', 'brd_levo'],
  ];
  const prev = await preview(app, sheet(...cases.map(([brand], i) => product(`P-${i}`, brand))));
  assert.deepEqual(prev.rows.flatMap((r) => r.errors), []);
  assert.deepEqual(prev.brands_to_create, [], 'an existing brand is never "to create"');
  const res = await confirm(app, prev.import_id);
  assert.equal(res.summary.created, cases.length, JSON.stringify(res.rows));
  res.rows.forEach((r, i) => assert.equal(brandOf(raw, r.product_id), cases[i][1], cases[i][0]));
});

test('a deactivated brand is matched (not duplicated) and the row says it will not show in the shop', async () => {
  const { raw, app } = setup();
  const prev = await preview(app, sheet(product('P-1', 'Qidi')));
  assert.deepEqual(prev.rows[0].errors, []);
  assert.deepEqual(prev.brands_to_create, []);
  assert.ok(prev.rows[0].warnings.some((w) => /\(qidi\)/.test(w) && /معطّلة/.test(w)), JSON.stringify(prev.rows[0].warnings));
  const res = await confirm(app, prev.import_id);
  assert.equal(brandOf(raw, res.rows[0].product_id), 'brd_qidi');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM brands WHERE name_en = 'Qidi'"), 1);
});

test('a name two brands answer to is still refused, naming both slugs', async () => {
  const { raw, app } = setup();
  raw.exec(`INSERT INTO brands (id, slug, name_ar, name_en) VALUES
    ('brd_a1', 'anycubic-a', 'انيكيوبك', 'Anycubic'),
    ('brd_a2', 'anycubic-b', 'انيكيوبك ٢', 'Anycubic');`);
  const prev = await preview(app, sheet(product('P-1', 'Anycubic')));
  assert.equal(prev.rows[0].action, 'failed');
  assert.ok(prev.rows[0].errors.some((e) => /anycubic-a/.test(e) && /anycubic-b/.test(e)), JSON.stringify(prev.rows[0].errors));
  assert.deepEqual(prev.brands_to_create, []);
});
