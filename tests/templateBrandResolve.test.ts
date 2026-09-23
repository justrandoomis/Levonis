/**
 * «البراند موجود مثل بامبو لاب وليفو لكنه يرفض» — THE OWNER'S FILE, RUN.
 *
 * Their التصنيفات screen lists «بامبو لاب / Bambu Lab» at slug `bambu-lab`
 * with ten products on it, and the import check answered
 *
 *     unknown brand "Bambu Lab" — create the brand first or fix the slug/id
 *
 * because `resolveRefs` asked `WHERE slug = ? OR id = ?` and the file carries
 * the DISPLAY NAME. Everything below drives the real routes against the real
 * migrations: what the check step SAYS, what the apply step WRITES, and what a
 * second run of the same file does.
 *
 * Run: node --import tsx --test tests/templateBrandResolve.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, all, row, count, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { productMediaFixtureEnv } from './fixtures/productMedia';
import { createPendingBrand, matchRef, planBrandCreate } from '../worker/lib/templateRefs';
import { readFile } from 'node:fs/promises';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
};

/** The owner's five active brands, as their taxonomy screen shows them. */
function setup() {
  const raw = freshDb();
  const brands: Array<[string, string, string, string]> = [
    ['brd_bambu', 'bambu-lab', 'بامبو لاب', 'Bambu Lab'],
    ['brd_levo', 'levo', 'ليفو', 'Levo'],
    ['brd_qidi', 'qidi', 'كيدي', 'Qidi'],
    ['brd_creality', 'creality', 'كريالتي', 'Creality'],
    ['brd_snapmaker', 'snapmaker', 'سناب ميكر', 'Snapmaker'],
  ];
  for (const [id, slug, ar, en] of brands) {
    raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)').run(id, slug, ar, en);
  }
  const db = asD1(raw);
  return { raw, db, app: stubApp(db, OWNER, mount, { env: productMediaFixtureEnv().env }) };
}

/** A minimal but valid create template that names a brand. `name` varies the
 *  product identity so a second apply is a second product, not a duplicate. */
const file = (brand: string, extra = '', name = 'Test Printer') =>
  [
    'template_version=2',
    `name_ar=طابعة ${name}`,
    `name_en=${name}`,
    'price_iqd=500000',
    'selling_type=direct_sale',
    `brand=${brand}`,
    extra,
  ]
    .filter(Boolean)
    .join('\n') + '\n';

/** `row` answers `undefined` for a missing row; every use below wants one. */
function rowOf(raw: DatabaseSync, sql: string, ...params: unknown[]): Record<string, unknown> {
  const found = row(raw, sql, ...params);
  assert.ok(found, sql);
  return found as Record<string, unknown>;
}

const parse = async (app: App, text: string) => {
  const res = await post(app, '/api/admin/template/parse', { text });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const apply = async (app: App, text: string) => {
  const res = await post(app, '/api/admin/template/apply', { text, mode: 'draft', confirm: true });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

// ------------------------------------------------- the reported symptom

test('the owner\'s file — brand="Bambu Lab" against an existing bambu-lab — resolves', async () => {
  const { app } = setup();
  const { body } = await parse(app, file('Bambu Lab'));
  assert.deepEqual(body.needs_review, [], JSON.stringify(body.needs_review));
  assert.deepEqual(body.brands_to_create, [], 'an existing brand is never "to create"');
  assert.equal(body.preview.brand_id, 'brd_bambu');
});

test('«بامبو لاب» — the Arabic display name — resolves to the same brand', async () => {
  const { app } = setup();
  const { body } = await parse(app, file('بامبو لاب'));
  assert.deepEqual(body.needs_review, []);
  assert.equal(body.preview.brand_id, 'brd_bambu');
});

test('«ليفو» and the slug and the id all reach the same row', async () => {
  const { app } = setup();
  for (const spelling of ['ليفو', 'Levo', 'levo', 'LEVO', ' levo ', 'brd_levo']) {
    const { body } = await parse(app, file(spelling));
    assert.deepEqual(body.needs_review, [], `${spelling}: ${JSON.stringify(body.needs_review)}`);
    assert.equal(body.preview.brand_id, 'brd_levo', spelling);
  }
});

test('an Arabic name typed with a different hamza/ta-marbuta still resolves', async () => {
  const { raw, db } = setup();
  raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('brd_tab', 'tabiaa', 'طابعة الشرق', 'Sharq');
  const app = stubApp(db, OWNER, mount, { env: productMediaFixtureEnv().env });
  const { body } = await parse(app, file('طابعه الشرق'));
  assert.deepEqual(body.needs_review, []);
  assert.equal(body.preview.brand_id, 'brd_tab');
});

// ------------------------------------------------- create, disclosed first

test('a genuinely new brand is DISCLOSED by the check route before anything is written', async () => {
  const { raw, app } = setup();
  const { body } = await parse(app, file('Elegoo'));
  assert.deepEqual(body.needs_review, [], 'a new brand is not an error any more');
  assert.deepEqual(body.brands_to_create, [{ name: 'Elegoo', slug: 'elegoo' }]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM brands'), 5, 'the check step writes nothing');
});

test('the apply creates it, with the slug the check promised', async () => {
  const { raw, app } = setup();
  const text = file('Elegoo');
  const pre = await parse(app, text);
  const { status, body } = await apply(app, text);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.brands_created.map((b: Record<string, unknown>) => ({ name: b.name, slug: b.slug, created: b.created })),
    [{ name: 'Elegoo', slug: pre.body.brands_to_create[0].slug, created: true }]
  );
  const made = rowOf(raw, 'SELECT * FROM brands WHERE slug = ?', 'elegoo');
  assert.ok(made, 'the brand exists in التصنيفات now');
  assert.equal(made.name_en, 'Elegoo');
  assert.equal(made.name_ar, 'Elegoo', 'name_ar is NOT NULL; the taxonomy panel falls back the same way');
  assert.equal(made.name_ckb, '', 'no invented Sorani — the owner names it');
  assert.equal(made.active, 1);
  assert.equal(rowOf(raw, 'SELECT brand_id FROM products WHERE id = ?', body.product_id).brand_id, made.id);
});

test('an Arabic-only new brand keeps its Arabic name and leaves name_en for the owner', async () => {
  const { raw, app } = setup();
  const text = file('انيكيوبك');
  const { status, body } = await apply(app, text);
  assert.equal(status, 200, JSON.stringify(body));
  const made = rowOf(raw, 'SELECT * FROM brands WHERE id = ?', body.brands_created[0].id);
  assert.equal(made.name_ar, 'انيكيوبك');
  assert.equal(made.name_en, '');
  assert.equal(made.name_ckb, '');
});

test('re-running the same import does not make a second brand', async () => {
  const { raw, app } = setup();
  const first = await apply(app, file('Elegoo'));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.brands_created[0].created, true);

  // A second file naming the same new brand — a different product, so the
  // confirm-once fingerprint does not swallow it.
  const second = await apply(app, file('Elegoo', '', 'Second Printer'));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body.brands_created, [], 'it simply RESOLVES the second time');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM brands WHERE name_en = 'Elegoo'"), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM brands'), 6);
  assert.equal(
    rowOf(raw, 'SELECT brand_id FROM products WHERE id = ?', second.body.product_id).brand_id,
    rowOf(raw, "SELECT id FROM brands WHERE name_en = 'Elegoo'").id
  );
  // And the check step no longer offers to create it.
  const after = await parse(app, file('Elegoo'));
  assert.deepEqual(after.body.brands_to_create, []);
});

test('a brand added by hand BETWEEN the check and the apply is used, not doubled', async () => {
  const { raw, app } = setup();
  const text = file('Elegoo');
  const pre = await parse(app, text);
  assert.deepEqual(pre.body.brands_to_create, [{ name: 'Elegoo', slug: 'elegoo' }]);

  // The owner opens التصنيفات and adds it themselves before pressing apply.
  raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('brd_manual', 'elegoo', 'إليجو', 'Elegoo');

  const { status, body } = await apply(app, text);
  assert.equal(status, 200, JSON.stringify(body));
  // The apply re-parses server-side and never trusts the check's answer, so
  // by the time it looks the brand simply RESOLVES.
  assert.deepEqual(body.brands_created, []);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM brands'), 6);
  assert.equal(
    rowOf(raw, 'SELECT brand_id FROM products WHERE id = ?', body.product_id).brand_id,
    'brd_manual',
    'the product points at the row that exists, not at the id the check reserved'
  );
});

test('createPendingBrand itself writes once however often it is called', async () => {
  const { raw, db } = setup();
  const pending = await planBrandCreate(db, 'Elegoo');
  assert.deepEqual({ slug: pending.slug, name_en: pending.name_en }, { slug: 'elegoo', name_en: 'Elegoo' });

  const first = await createPendingBrand(db, pending);
  const second = await createPendingBrand(db, pending);
  assert.deepEqual(first, { id: pending.id, created: true });
  assert.deepEqual(second, { id: pending.id, created: false }, 're-resolved by name, not inserted again');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM brands'), 6);

  // And a name that became ambiguous in the gap is refused, not written.
  const other = await planBrandCreate(db, 'Anycubic');
  raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('brd_a1', 'anycubic-a', 'انيكيوبك', 'Anycubic');
  raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('brd_a2', 'anycubic-b', 'انيكيوبك ٢', 'Anycubic');
  assert.deepEqual(await createPendingBrand(db, other), { ambiguous: ['anycubic-a', 'anycubic-b'] });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM brands'), 8, 'nothing new was inserted');
});

test('a new brand never collides with an existing slug', async () => {
  const { raw, db } = setup();
  // A row whose SLUG is `elegoo` but whose names are something else entirely,
  // so "Elegoo!" matches nothing and still slugifies straight onto it.
  raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('brd_other', 'elegoo', 'شركة أخرى', 'Other Co');
  const app = stubApp(db, OWNER, mount, { env: productMediaFixtureEnv().env });
  const { status, body } = await apply(app, file('Elegoo!'));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.brands_created[0].slug, 'elegoo-2');
  assert.equal(rowOf(raw, "SELECT id FROM brands WHERE slug = 'elegoo'").id, 'brd_other');
});

test('a brand deactivated in التصنيفات is matched, not duplicated', async () => {
  const { raw, app } = setup();
  raw.prepare("UPDATE brands SET active = 0 WHERE id = 'brd_levo'").run();
  const { body } = await parse(app, file('Levo'));
  assert.deepEqual(body.brands_to_create, [], 'reviving one row beats minting levo-2');
  assert.equal(body.preview.brand_id, 'brd_levo');
});

test('matchRef keeps model numbers apart — folding never merges two brands', () => {
  const rows = [
    { id: 'b1', slug: 'x1c', name_ar: 'اكس ١ سي', name_en: 'X1C', name_ckb: '' },
    { id: 'b2', slug: 'x2d', name_ar: '', name_en: 'X2D', name_ckb: '' },
    { id: 'b3', slug: 'kurd', name_ar: '', name_en: '', name_ckb: 'ڕەنگ' },
  ];
  assert.deepEqual(matchRef(rows, 'X1C'), { kind: 'hit', id: 'b1' });
  assert.deepEqual(matchRef(rows, ' x2d '), { kind: 'hit', id: 'b2' });
  assert.deepEqual(matchRef(rows, 'ڕەنگ'), { kind: 'hit', id: 'b3' }, 'name_ckb is matched too');
  assert.deepEqual(matchRef(rows, 'X3'), { kind: 'miss' });
  assert.deepEqual(matchRef(rows, ''), { kind: 'miss' });
});

/**
 * THE CLIENT HALF. Twice this session a fix was reported done while the
 * owner-visible symptom survived because only the server moved. The check
 * response's disclosure is worth nothing if the panel drops it on the floor.
 */
test('the import panel actually renders brands_to_create', async () => {
  const panel = await readFile(new URL('../src/components/adminProducts/ImportPanel.tsx', import.meta.url), 'utf8');
  const rendered = panel.match(/\.\.\.\(\w+\.brands_to_create \?\? \[\]\)\.map\(/g) ?? [];
  assert.equal(rendered.length, 2, 'both lanes: the single .txt check and the per-file ZIP check');
  assert.match(panel, /t\.create/);
  assert.match(panel, /t\.lkBrand/);
});

// ------------------------------------------------- ambiguity

test('a name claimed by two brands is refused, naming both slugs', async () => {
  const { raw, db } = setup();
  raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('brd_other', 'bambu-lab-cn', 'بامبو لاب', 'Bambu Lab CN');
  const app = stubApp(db, OWNER, mount, { env: productMediaFixtureEnv().env });

  const { body } = await parse(app, file('بامبو لاب'));
  assert.equal(body.needs_review.length, 1, JSON.stringify(body.needs_review));
  const message = String(body.needs_review[0].message);
  assert.match(message, /bambu-lab/);
  assert.match(message, /bambu-lab-cn/);
  assert.deepEqual(body.brands_to_create, [], 'ambiguity is not a reason to invent a third brand');

  const applied = await apply(app, file('بامبو لاب'));
  assert.equal(applied.status, 400);
  assert.equal(applied.body.code, 'NEEDS_REVIEW');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products'), 0);
});

test('an exact slug still wins over a name another row claims', async () => {
  const { raw, db } = setup();
  // A second brand whose display NAME is the first one's SLUG.
  raw.prepare('INSERT INTO brands (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('brd_imposter', 'imposter', 'منتحل', 'bambu-lab');
  const app = stubApp(db, OWNER, mount, { env: productMediaFixtureEnv().env });
  const { body } = await parse(app, file('bambu-lab'));
  assert.deepEqual(body.needs_review, []);
  assert.equal(body.preview.brand_id, 'brd_bambu', 'the slug is authoritative');
});

// ------------------------------------------------- sections: the other arm

test('a section resolves by its Arabic or English name too', async () => {
  // `printers` / «الطابعات» is the tree the migrations themselves seed.
  const { app } = setup();
  for (const spelling of ['printers', 'Printers', 'cat_printers']) {
    const { body } = await parse(app, file('Levo', `category=${spelling}`));
    assert.deepEqual(body.needs_review, [], `${spelling}: ${JSON.stringify(body.needs_review)}`);
    assert.equal(body.preview.category_id, 'cat_printers', spelling);
  }
});

test('an unknown section is still REFUSED — a section carries a parent and a family a name cannot supply', async () => {
  const { raw, app } = setup();
  const { body } = await parse(app, file('Levo', 'category=قسم لا وجود له'));
  assert.equal(body.needs_review.length, 1);
  assert.match(String(body.needs_review[0].message), /never silently created/);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM catalogs WHERE name_ar = 'قسم لا وجود له'"), 0);
});

test('two sections sharing a name are refused with their slugs, not filed under the first', async () => {
  const { raw, db } = setup();
  raw.prepare('INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('cat_a', 'printers-fdm', 'الطابعات', 'FDM');
  raw.prepare('INSERT INTO catalogs (id, slug, name_ar, name_en) VALUES (?, ?, ?, ?)')
    .run('cat_b', 'printers-resin', 'الطابعات', 'Resin');
  const app = stubApp(db, OWNER, mount, { env: productMediaFixtureEnv().env });
  const { body } = await parse(app, file('Levo', 'category=الطابعات'));
  assert.equal(body.needs_review.length, 1);
  assert.match(String(body.needs_review[0].message), /printers-fdm/);
  assert.match(String(body.needs_review[0].message), /printers-resin/);
  assert.equal(body.preview.category_id, null);
});

// ------------------------------------------------- the round trip

test('EXPORT -> IMPORT of an unchanged product survives, brand and section included', async () => {
  const { raw, app } = setup();
  const created = await apply(app, file('Bambu Lab', 'category=Printers'));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const productId = created.body.product_id as string;
  assert.equal(rowOf(raw, 'SELECT brand_id FROM products WHERE id = ?', productId).brand_id, 'brd_bambu');

  const exported = await get(app, `/api/admin/template/export/${productId}`);
  assert.equal(exported.status, 200);
  const text = await exported.text();

  // The same bytes, straight back in.
  const back = await parse(app, text);
  assert.deepEqual(back.body.errors, [], JSON.stringify(back.body.errors));
  assert.deepEqual(back.body.needs_review, [], JSON.stringify(back.body.needs_review));
  assert.deepEqual(back.body.brands_to_create, [], 'a round trip must never invent a brand');
  assert.equal(back.body.preview.brand_id, 'brd_bambu');

  const reapplied = await post(app, '/api/admin/template/apply', { text, mode: 'update', confirm: true });
  const reapplyBody = (await reapplied.json()) as Record<string, any>;
  assert.equal(reapplied.status, 200, JSON.stringify(reapplyBody));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM brands'), 5, 'and never adds one');
  assert.equal(rowOf(raw, 'SELECT brand_id FROM products WHERE id = ?', productId).brand_id, 'brd_bambu');
});

test('a hand-written file carrying the DISPLAY name round-trips into the same brand as the export', async () => {
  const { raw, app } = setup();
  const byName = await apply(app, file('Bambu Lab'));
  const bySlug = await apply(app, file('bambu-lab', '', 'Second Printer'));
  assert.equal(byName.status, 200, JSON.stringify(byName.body));
  assert.equal(bySlug.status, 200, JSON.stringify(bySlug.body));
  const ids = all(raw, 'SELECT brand_id FROM products ORDER BY id').map((r) => r.brand_id);
  assert.deepEqual([...new Set(ids)], ['brd_bambu']);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM brands'), 5);
});
