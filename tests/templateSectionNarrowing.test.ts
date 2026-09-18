/**
 * «لا تتغير القالب ولا يتغير الأقسام» — THE TEMPLATE DID CHANGE. NOTHING SAID SO.
 *
 * The owner picked «الطابعات › طابعات Resin» in the import panel, downloaded
 * the TXT template, and reported that choosing a section changes nothing —
 * that a resin printer's template is the same as a filament one, and the same
 * for every other section.
 *
 * Every signal available to them said that. None of them was the file:
 *
 *   THE NUMBER ON SCREEN was «٤٧ حقل مواصفات», taken from the product TYPE
 *   (`templateTypeChoices` → `flatFields(groupsForType(id))`). It never moved
 *   when a section was chosen, because it never consulted one.
 *
 *   THE FILE NAME was `levonis-product-template-printer.txt` for EVERY
 *   section. Two different templates arrived in the Downloads folder under one
 *   name — the CSV lane had named its file after the section for as long as it
 *   had existed; this lane never did.
 *
 *   THE COMMENT IN THE ROUTE said "Both produce identical columns for the same
 *   type", which stopped being true when `shapeFor` began passing the branch.
 *
 * The contents were right the whole time. These tests pin the two halves: that
 * the narrowing is real and specific, and that it is now VISIBLE — in the
 * count the panel reads, in the groups it lists, and in the name of the file.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, get } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { adminTaxonomyRoutes } from '../worker/routes/adminTaxonomy';

const OWNER = { id: 'u_owner', email: 'boss@x.co', role: 'admin' } as never;

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/import', adminImportRoutes);
  a.route('/api/admin/taxonomy', adminTaxonomyRoutes);
};

function app() {
  const raw = freshDb();
  const db = asD1(raw);
  return stubApp(db as never, OWNER, mount);
}

/** The `spec.<id>=` rows a downloaded TXT template actually carries. */
async function txtSpecs(a: ReturnType<typeof app>, query: string): Promise<string[]> {
  const res = await get(a, `/api/admin/template/blank${query}`);
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('spec.'))
    .map((line) => line.slice('spec.'.length).replace(/=$/, ''));
}

/** The `spec.*` columns a downloaded CSV template carries. */
async function csvSpecs(a: ReturnType<typeof app>, query: string): Promise<string[]> {
  const res = await get(a, `/api/admin/import/template${query}&format=csv&example=0`);
  // CSV is CRLF-delimited, so the last header cell carries a trailing CR.
  const header = (await res.text()).split('\n')[0].replace(/^\uFEFF/, '').replace(/\r$/, '');
  return header
    .split(',')
    .filter((c) => c.startsWith('spec.'))
    .map((c) => c.slice('spec.'.length).replace(/"/g, ''));
}

const filename = (res: Response): string =>
  /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? '';

// =========================================================================
// THE NARROWING IS REAL — and this is the exact comparison the owner made
// =========================================================================

test('a Resin printer template is NOT an FDM printer template', async () => {
  const a = app();
  const fdm = await txtSpecs(a, '?type=printer&category=cat_printers_fdm');
  const resin = await txtSpecs(a, '?type=printer&category=cat_printers_resin');

  assert.notDeepEqual(fdm, resin, 'these are two different machines and two different spec sheets');

  // Named, so a future change that quietly widens one of them fails here with
  // the field it let back in rather than with a number.
  const onlyFdm = fdm.filter((f) => !resin.includes(f));
  const onlyResin = resin.filter((f) => !fdm.includes(f));
  for (const f of ['nozzle_temp_max', 'bed_temp_max', 'extruders', 'filament_diameter', 'ams_compatibility']) {
    assert.ok(onlyFdm.includes(f), `${f} belongs to an FDM printer and must not be asked of a Resin one`);
  }
  for (const f of ['lcd_size', 'lcd_resolution', 'exposure_time', 'uv_power', 'release_film']) {
    assert.ok(onlyResin.includes(f), `${f} belongs to a Resin printer and must not be asked of an FDM one`);
  }
});

test('and a section narrows the type rather than repeating it', async () => {
  const a = app();
  const bare = await txtSpecs(a, '?type=printer');
  const fdm = await txtSpecs(a, '?type=printer&category=cat_printers_fdm');
  const resin = await txtSpecs(a, '?type=printer&category=cat_printers_resin');

  assert.ok(bare.length > fdm.length, 'choosing FDM must drop the Resin-only fields');
  assert.ok(bare.length > resin.length, 'and choosing Resin must drop the FDM-only ones');
  // A section may only REMOVE. A field that appears for a section but not for
  // its own type would mean the two definitions had drifted apart.
  for (const f of [...fdm, ...resin]) {
    assert.ok(bare.includes(f), `${f} is offered for a section but not for its type — the definitions have drifted`);
  }
});

test('the CSV lane narrows identically — one definition, two file formats', async () => {
  const a = app();
  for (const category of ['cat_printers_fdm', 'cat_printers_resin', 'cat_materials_fdm', 'cat_materials_resin']) {
    const type = category.startsWith('cat_printers') ? 'printer' : 'filament';
    const txt = await txtSpecs(a, `?type=${type}&category=${category}`);
    const csv = await csvSpecs(a, `?type=${type}&category=${category}`);
    assert.deepEqual(csv, txt, `${category}: a TXT and a CSV template must ask for the same fields`);
  }
});

// =========================================================================
// AND IT IS VISIBLE — which is the half that was actually missing
// =========================================================================

test('THE BUG: the TXT file was served under the same name for every section', async () => {
  const a = app();
  const fdm = filename(await get(a, '/api/admin/template/blank?type=printer&category=cat_printers_fdm'));
  const resin = filename(await get(a, '/api/admin/template/blank?type=printer&category=cat_printers_resin'));
  const bare = filename(await get(a, '/api/admin/template/blank?type=printer'));

  assert.notEqual(fdm, resin, 'two different templates may not arrive under one name');
  assert.match(fdm, /fdm-printers/, 'the name says which section it is for');
  assert.match(resin, /resin-printers/);
  // Without a section there is no section to name, and the type is the honest
  // answer — this is the one case the old behaviour got right.
  assert.equal(bare, 'levonis-product-template-printer.txt');
});

test('the panel can SEE the narrowing: each section reports its own field count and groups', async () => {
  const a = app();
  const body = (await (await get(a, '/api/admin/taxonomy/catalogs')).json()) as {
    catalogs: Array<{ id: string; product_type: string | null; spec_columns?: number; spec_groups?: Array<{ fields: number }> }>;
  };
  const by = (id: string) => body.catalogs.find((c) => c.id === id)!;

  const fdm = by('cat_printers_fdm');
  const resin = by('cat_printers_resin');
  const parent = by('cat_printers');

  assert.equal(fdm.product_type, 'printer');
  assert.ok((fdm.spec_columns ?? 0) > 0, 'a section must report what its own template carries');
  assert.notEqual(
    fdm.spec_columns,
    resin.spec_columns,
    'the number the panel prints is the whole point — it must differ where the templates differ'
  );
  assert.ok(
    (parent.spec_columns ?? 0) > (fdm.spec_columns ?? 0),
    '«الطابعات» has not said which technology, so it keeps both sets — narrowing only happens at the leaf'
  );

  // The count must be the sum of the groups beside it, or the panel would be
  // printing two numbers that disagree.
  for (const c of [fdm, resin, parent]) {
    const summed = (c.spec_groups ?? []).reduce((n, g) => n + g.fields, 0);
    assert.equal(summed, c.spec_columns, 'the listed groups must add up to the printed count');
  }
});

test('the count the panel prints is the count the download delivers', async () => {
  // The two came from different code paths before — one from the product type,
  // one from the narrowed branch — and that is precisely how the panel came to
  // promise 47 fields while the file carried 30.
  const a = app();
  const body = (await (await get(a, '/api/admin/taxonomy/catalogs')).json()) as {
    catalogs: Array<{ id: string; product_type: string | null; spec_columns?: number }>;
  };
  for (const id of ['cat_printers_fdm', 'cat_printers_resin', 'cat_materials_fdm', 'cat_materials_resin']) {
    const row = body.catalogs.find((c) => c.id === id)!;
    const rows = await txtSpecs(a, `?type=${row.product_type}&category=${id}`);
    assert.equal(rows.length, row.spec_columns, `${id}: the panel promised ${row.spec_columns} and the file carried ${rows.length}`);
  }
});

test('a section with no template family reports no shape rather than a wrong one', async () => {
  const a = app();
  const body = (await (await get(a, '/api/admin/taxonomy/catalogs')).json()) as {
    catalogs: Array<{ id: string; effective_template_family: string | null; product_type: string | null; spec_columns?: number }>;
  };
  for (const c of body.catalogs) {
    if (c.product_type === null) {
      assert.equal(c.spec_columns, 0, `${c.id} has no type, so it can promise no fields`);
    }
  }
});
