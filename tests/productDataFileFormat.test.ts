/**
 * «ملف بيانات المنتج» — THE FILE ITSELF (worker/lib/productDataFile.ts):
 * keys named by identity rather than position, values compared the way the
 * registry reads them, fingerprints that do not move when nothing they cover
 * moved; the bulk file of the products list; the spreadsheet form; the old
 * export accepted as a legacy file; the file-level refusals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post } from './fixtures/app';
import { apply, create, download, edit, editIn, preview, setup, PRODUCT, VARIANT_PRODUCT } from './fixtures/dataFile';
import { canonicalValue, fingerprints, normalizeEntries, splitDataFile, type FlatEntry } from '../worker/lib/productDataFile';

// ------------------------------------------------------------------ pure

test('keys are named by identity: an item\'s lines in any order, a route by its method, a row by its id, a new item as new', () => {
  const entries: FlatEntry[] = [
    { key: 'options.2.name_en', value: 'B' },
    { key: 'options.1.id', value: 'opt_a' },
    { key: 'options.2.id', value: 'opt_b' },
    { key: 'options.1.preorder.transports.1.method', value: 'air' },
    { key: 'options.1.preorder.transports.1.surcharge_iqd', value: '80000' },
    { key: 'spec_groups.1.id', value: 'sg_1' },
    { key: 'spec_groups.1.rows.3.id', value: 'sr_9' },
    { key: 'spec_groups.1.rows.3.label_ar', value: 'حجم' },
    { key: 'options.7.name_en', value: 'New' },
    { key: 'pricing.options.1.id', value: 'opt_a' },
    { key: 'pricing.options.1.supplier_cost_amount', value: '10' },
  ];
  const { list } = normalizeEntries(entries);
  const n = Object.fromEntries(list.map((x) => [x.key, x.nkey]));
  assert.equal(n['options.2.name_en'], 'options[opt_b].name_en');
  assert.equal(n['options.1.preorder.transports.1.surcharge_iqd'], 'options[opt_a].preorder.transports[air].surcharge_iqd');
  assert.equal(n['spec_groups.1.rows.3.label_ar'], 'spec_groups[sg_1].rows[sr_9].label_ar');
  assert.equal(n['options.7.name_en'], 'options[#new7].name_en');
  assert.equal(n['pricing.options.1.supplier_cost_amount'], 'pricing.options[opt_a].supplier_cost_amount');
  assert.ok(list.find((x) => x.key === 'options.7.name_en')!.item!.isNew);
});

test('values compare as the registry reads them', () => {
  const at = (key: string) => normalizeEntries([{ key, value: '' }]).list[0];
  assert.equal(canonicalValue(at('is_featured'), 'TRUE'), 'true');
  assert.equal(canonicalValue(at('price_iqd'), '025000'), '25000');
  assert.equal(canonicalValue(at('hashtags'), ' a , b,,c '), 'a,b,c');
  assert.equal(canonicalValue(at('sku'), '__CLEAR__'), '');
  assert.equal(canonicalValue(at('pricing.base.manual_cbm'), '0.100'), '0.1');
  assert.equal(canonicalValue(at('pricing.base.shipping_weight_g'), ''), null);
});

test('fingerprints do not depend on where an item sits in the file', async () => {
  const a = normalizeEntries([
    { key: 'options.1.id', value: 'x' },
    { key: 'options.1.name_en', value: 'X' },
    { key: 'options.2.id', value: 'y' },
    { key: 'options.2.name_en', value: 'Y' },
  ]).list;
  const b = normalizeEntries([
    { key: 'options.1.id', value: 'y' },
    { key: 'options.1.name_en', value: 'Y' },
    { key: 'options.2.id', value: 'x' },
    { key: 'options.2.name_en', value: 'X' },
  ]).list;
  assert.deepEqual([...(await fingerprints('p', a)).entries()].sort(), [...(await fingerprints('p', b)).entries()].sort());
});

test('a heredoc that contains a block marker is text, not a block', () => {
  const text = ['data_file_version=1', '=== product p1 ===', 'product_id=p1', 'description_ar=<<<END', '=== end p1 ===', 'END', 'name_en=A', '=== end p1 ==='].join('\n');
  const f = splitDataFile(text);
  assert.deepEqual(f.errors, []);
  assert.equal(f.blocks.length, 1);
  assert.equal(f.blocks[0].entries.find((e) => e.key === 'description_ar')!.value, '=== end p1 ===');
  assert.equal(f.blocks[0].entries.find((e) => e.key === 'name_en')!.value, 'A');
});

// ------------------------------------------------------------------ routes

test('the products list\'s bulk file: several products, one preview card each, applied one product per call', async () => {
  const { app } = setup();
  const a = await create(app, PRODUCT);
  const b = await create(app, VARIANT_PRODUCT);
  const res = await get(app, `/api/admin/template/data-export?ids=${a},${b}`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^products=2$/m);
  const cards = await preview(app, text);
  assert.deepEqual(cards.map((c) => c.product_id), [a, b]);
  assert.ok(cards.every((c) => c.fields.filter((f) => f.status !== 'STALE_IN_FILE').length === 0));
  const edited = editIn(editIn(text, a, 'name_en', 'X1 Bulk'), b, 'name_ar', 'فلمنت مجمّع');
  const [ca, cb] = await preview(app, edited);
  assert.deepEqual(ca.fields.map((f) => f.key), ['name_en']);
  assert.deepEqual(cb.fields.map((f) => f.key), ['name_ar']);
  assert.equal((await apply(app, edited, ca)).status, 200);
  assert.equal((await apply(app, edited, cb)).status, 200);
  const tooMany = await get(app, `/api/admin/template/data-export?ids=${Array.from({ length: 26 }, (_, i) => `p${i}`).join(',')}`);
  assert.equal(tooMany.status, 400);
  assert.equal(((await tooMany.json()) as { code: string }).code, 'DATA_FILE_TOO_MANY');
});

test('the spreadsheet form round-trips: an unedited CSV is zero changes, an edited cell applies', async () => {
  const { app } = setup();
  const id = await create(app, PRODUCT);
  const res = await get(app, `/api/admin/template/data-export/${id}?format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  const csv = await res.text();
  const p0 = await post(app, '/api/admin/template/data-preview', { text: csv, format: 'csv', product_id: id });
  const b0 = (await p0.json()) as { products: Array<{ fields: Array<{ status: string }>; token: string | null }> };
  assert.equal(p0.status, 200, JSON.stringify(b0));
  assert.deepEqual(b0.products[0].fields.filter((f) => f.status !== 'STALE_IN_FILE'), []);
  const edited = csv.replace(/^sku,X1-BASE/m, 'sku,X1-CSV');
  const p1 = (await (await post(app, '/api/admin/template/data-preview', { text: edited, format: 'csv', product_id: id })).json()) as {
    products: Array<{ product_id: string; token: string; fields: Array<{ key: string }> }>;
  };
  assert.deepEqual(p1.products[0].fields.map((f) => f.key), ['sku']);
  const r = await post(app, '/api/admin/template/data-apply', { text: edited, format: 'csv', product_id: id, token: p1.products[0].token });
  assert.equal(r.status, 200, await r.clone().text());
});

test('the old export is accepted as a legacy file: unedited it is zero changes; an edit applies while the product is as exported', async () => {
  const { app } = setup();
  const id = await create(app, PRODUCT);
  const old = await (await get(app, `/api/admin/template/export/${id}`)).text();
  const [p0] = await preview(app, old, id);
  assert.deepEqual(p0.fields.filter((f) => f.status === 'change'), [], JSON.stringify(p0.fields.filter((f) => f.status === 'change')));
  const edited = edit(old, 'sku', 'X1-OLD');
  const [p] = await preview(app, edited, id);
  assert.deepEqual(p.fields.filter((f) => f.status === 'change').map((f) => f.key), ['sku']);
  assert.equal((await apply(app, edited, p)).status, 200);
  // The product moved since that export: every differing key is a conflict, never a silent revert.
  const stale = edit(old, 'name_en', 'Old name');
  const [q] = await preview(app, stale, id);
  assert.ok(q.fields.length > 0);
  assert.ok(q.fields.every((f) => f.status === 'CONFLICT_SINCE_DOWNLOAD'), JSON.stringify(q.fields));
});

test('file-level refusals: another product\'s file, a newer version, no product at all', async () => {
  const { app } = setup();
  const a = await create(app, PRODUCT);
  const b = await create(app, VARIANT_PRODUCT);
  const fileA = await download(app, a);
  const wrong = await post(app, '/api/admin/template/data-preview', { text: fileA, product_id: b });
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { code: string }).code, 'DATA_FILE_WRONG_PRODUCT');
  const newer = await post(app, '/api/admin/template/data-preview', { text: fileA.replace('data_file_version=1', 'data_file_version=9') });
  assert.equal(((await newer.json()) as { code: string }).code, 'DATA_FILE_VERSION');
  const none = await post(app, '/api/admin/template/data-preview', { text: 'name_en=hello\n' });
  assert.equal(((await none.json()) as { code: string }).code, 'DATA_FILE_NO_PRODUCT');
  const missing = await post(app, '/api/admin/template/data-preview', { text: fileA.replaceAll(a, 'prd_does_not_exist') });
  const body = (await missing.json()) as { products: Array<{ error: { code: string } | null }> };
  assert.equal(body.products[0].error?.code, 'DATA_FILE_PRODUCT_MISSING');
});
