/**
 * «ملف بيانات المنتج» — THE ROUND TRIP (owner brief 2026-10-10: «عند تحديث
 * البيانات يتم تنزيل ملف معلومات بيانات المنتج وعند ارفاق الملف يقارن
 * التغييرات فقط ويطبقها اذا حقل تغير … ليس استيراد من جديد»).
 *
 *   - the downloaded file, attached back unedited, is ZERO changes — for a
 *     product with options, cells, routes, colours, combinations, pictures,
 *     specs, labels, content and a membership discount;
 *   - one changed field writes exactly that field: every other `products`
 *     column and every relation row is byte-identical before and after;
 *   - options, colours and combinations change in place (no reorder), a new
 *     one is appended with a server id, `remove=true` is the only removal;
 *   - the apply is fenced, idempotent and audited without values.
 *
 * Real migrations, real SQLite, the real template router.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, get, post, row } from './fixtures/app';
import { splitDataFile } from '../worker/lib/productDataFile';
import { addImages, apply, create, download, edit, preview, setup, VARIANT_PRODUCT, type PreviewProduct } from './fixtures/dataFile';

const snapshot = (raw: DatabaseSync, productId: string) => ({
  products: all(raw, 'SELECT * FROM products WHERE id = ?', productId),
  groups: all(raw, 'SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY id', productId),
  values: all(raw, 'SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id', productId),
  cells: all(raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', productId),
  routes: all(raw, 'SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id', productId),
  colors: all(raw, 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY id', productId),
  links: all(raw, 'SELECT l.* FROM product_color_option_links l JOIN product_colors c ON c.id = l.color_id WHERE c.product_id = ? ORDER BY l.color_id, l.option_value_id', productId),
  variants: all(raw, 'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', productId),
  images: all(raw, 'SELECT * FROM product_images WHERE product_id = ? ORDER BY id', productId),
  catalogs: all(raw, 'SELECT * FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id', productId),
  membership: all(raw, "SELECT * FROM membership_benefit_rules WHERE product_id = ? ORDER BY id", productId),
});

/** Every column of `products` but the ones a save always moves. */
const stripClock = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => {
    const { updated_at: _u, ...rest } = r;
    void _u;
    return rest;
  });

// ------------------------------------------------------------------ format

test('the downloaded file, attached back unedited, is zero changes', async () => {
  const { raw, app } = setup();
  const id = await create(app);
  addImages(raw, id);
  const text = await download(app, id);
  assert.match(text, /^data_file=levonis-product-data$/m);
  assert.match(text, new RegExp(`^=== product ${id} ===$`, 'm'));
  assert.match(text, /^fp\.identity=[0-9a-f]{16}$/m);
  assert.match(text, /^options\.1\.fp=[0-9a-f]{16}$/m);
  assert.match(text, /^options\.1\.remove=false$/m);
  assert.match(text, /^product_cost_iqd=700000$/m, 'the owner\'s file carries the cost');
  assert.match(text, /^membership\.pro\.percent=5$/m);
  const parsed = splitDataFile(text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.blocks.length, 1);
  const [p] = await preview(app, text, id);
  assert.equal(p.error, null);
  assert.deepEqual(
    p.fields.filter((f) => f.status !== 'STALE_IN_FILE'),
    [],
    'nothing differs'
  );
  assert.equal(p.token, null, 'nothing to apply');
  const res = await apply(app, text, { ...p, token: '0'.repeat(32) });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'DATA_FILE_NOTHING_TO_APPLY');
});

test('one changed field writes exactly that field — every other column and relation row is identical', async () => {
  const { raw, app } = setup();
  const id = await create(app);
  addImages(raw, id);
  const text = await download(app, id);
  const before = snapshot(raw, id);
  const edited = edit(text, 'name_en', 'X1 Printer Pro');
  const [p] = await preview(app, edited, id);
  assert.deepEqual(
    p.fields.map((f) => [f.key, f.status, f.before, f.after]),
    [['name_en', 'change', 'X1 Printer', 'X1 Printer Pro']]
  );
  assert.ok(p.token);
  const res = await apply(app, edited, p);
  const body = (await res.json()) as { applied?: string[]; not_persisted?: string[] };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.applied, ['name_en']);
  assert.deepEqual(body.not_persisted, []);
  const after = snapshot(raw, id);
  assert.equal(row<{ name: string }>(raw, 'SELECT name FROM products WHERE id = ?', id)!.name, 'X1 Printer Pro');
  // `options` / `colors` / `images` on the row are the planner's JSON MIRROR of the relation rows
  // (worker/lib/productPersistence.ts): re-derived from the rows on every save, never a field of
  // the file. The rows themselves are compared below, byte for byte.
  const pick = (r: Record<string, unknown>) => {
    const { name: _m, updated_at: _u, translation_meta: _t, options: _o, colors: _c, images: _i, ...rest } = r;
    void _m; void _u; void _t; void _o; void _c; void _i;
    return rest;
  };
  assert.deepEqual(after.products.map(pick), before.products.map(pick), 'no other product column moved');
  for (const k of ['groups', 'values', 'cells', 'routes', 'colors', 'links', 'variants', 'images', 'catalogs', 'membership'] as const) {
    assert.deepEqual(after[k], before[k], `${k} rows are byte-identical`);
  }
  // Audited, without a value.
  const audit = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'product.data_file.applied' AND target = ?", id)!;
  const detail = JSON.parse(audit.detail) as Record<string, unknown>;
  assert.deepEqual(detail.keys, ['name_en']);
  assert.ok(!audit.detail.includes('X1 Printer Pro'), 'the audit row carries the key, never the value');
  // A replay answers `already` and writes nothing.
  const again = await apply(app, edited, p);
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { already: boolean }).already, true);
  void stripClock;
});

// ------------------------------------------------------------------ options, colours, combinations

test('options and colours change in place: no reorder, a new option is appended with a server id, remove=true removes one', async () => {
  const { raw, app } = setup();
  const id = await create(app);
  const text = await download(app, id);
  const sortBefore = all<{ id: string; sort: number }>(raw, 'SELECT id, sort FROM product_option_values WHERE product_id = ? ORDER BY id', id);
  const colorsBefore = all(raw, 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY id', id);
  // The second option's name, the first colour's hex, and a route's surcharge.
  const optionIndex = (optId: string) => new RegExp(`^options\\.(\\d+)\\.id=${optId}$`, 'm').exec(text)![1];
  const colorIndex = (colId: string) => new RegExp(`^colors\\.(\\d+)\\.id=${colId}$`, 'm').exec(text)![1];
  const o2 = optionIndex('opt_combo');
  const o1 = optionIndex('opt_std');
  const o3 = optionIndex('opt_kit');
  const c1 = colorIndex('col_black');
  let edited = edit(text, `options.${o2}.name_en`, 'Combo Plus');
  edited = edit(edited, `colors.${c1}.hex`, '#111111');
  edited = edit(edited, `options.${o1}.preorder.transports.2.surcharge_iqd`, '35000');
  // A new model, written by hand at the end of the block (no id: the server gives it one).
  edited = edited.replace(
    `=== end ${id} ===`,
    ['options.9.group=Model', 'options.9.name_ar=جديد', 'options.9.name_en=Fresh', 'options.9.stock=0', 'options.9.direct.enabled=true', `=== end ${id} ===`].join('\n')
  );
  // And the kit is removed.
  edited = edit(edited, `options.${o3}.remove`, 'true');
  const [p] = await preview(app, edited, id);
  const statuses = Object.fromEntries(p.fields.map((f) => [f.key, f.status]));
  assert.equal(statuses[`options.${o2}.name_en`], 'change');
  assert.equal(statuses[`colors.${c1}.hex`], 'change');
  assert.equal(statuses[`options.${o1}.preorder.transports.2.surcharge_iqd`], 'change');
  assert.equal(statuses['options.9.name_en'], 'change');
  assert.equal(statuses[`options.${o3}.remove`], 'change');
  assert.ok(p.token, JSON.stringify(p.fields.filter((f) => f.status !== 'change')));
  const res = await apply(app, edited, p);
  assert.equal(res.status, 200, await res.clone().text());

  const values = all<{ id: string; name_en: string; sort: number }>(raw, 'SELECT id, name_en, sort FROM product_option_values WHERE product_id = ? ORDER BY sort', id);
  assert.deepEqual(values.slice(0, 2).map((v) => v.id), ['opt_std', 'opt_combo'], 'the stored order is kept');
  assert.equal(values.find((v) => v.id === 'opt_combo')!.name_en, 'Combo Plus');
  assert.ok(!values.some((v) => v.id === 'opt_kit'), 'the removed option is gone');
  const fresh = values.find((v) => v.name_en === 'Fresh')!;
  assert.match(fresh.id, /^opt_[0-9a-f]{20}$/, 'the new option has a server id');
  assert.equal(values[values.length - 1].id, fresh.id, 'and it is appended after the others');
  const kept = sortBefore.filter((v) => v.id !== 'opt_kit');
  for (const v of kept) assert.equal(values.find((x) => x.id === v.id)!.sort, v.sort, `${v.id} keeps its place`);
  const colors = all<Record<string, unknown>>(raw, 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY id', id);
  assert.equal(colors.find((c) => c.id === 'col_black')!.hex, '#111111');
  assert.deepEqual(colors.find((c) => c.id === 'col_white'), colorsBefore.find((c) => c.id === 'col_white'), 'the other colour is untouched');
  const sea = row<{ surcharge_iqd: number }>(raw, "SELECT surcharge_iqd FROM product_option_transports WHERE product_id = ? AND method = 'sea'", id)!;
  assert.equal(sea.surcharge_iqd, 35000);
  const air = row<{ surcharge_iqd: number }>(raw, "SELECT surcharge_iqd FROM product_option_transports WHERE product_id = ? AND method = 'air'", id)!;
  assert.equal(air.surcharge_iqd, 80000, 'the other route keeps its price');
});

test('an omitted line or item changes nothing — omission is never a deletion', async () => {
  const { raw, app } = setup();
  const id = await create(app);
  const text = await download(app, id);
  // Keep only the block's header and one edited line: every option, colour and spec line deleted.
  const lines = text.split('\n');
  const keep = lines.filter((l) => /^(===|template_version|product_id|slug|expected_updated_at|pricing_mode|fp\.identity|data_file|viewer|products|exported_at)/.test(l) || l.startsWith('name_ar='));
  const edited = edit(keep.join('\n'), 'name_ar', 'طابعة اكس برو');
  const [p] = await preview(app, edited, id);
  assert.deepEqual(p.fields.map((f) => [f.key, f.status]), [['name_ar', 'change']]);
  const res = await apply(app, edited, p);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(all(raw, 'SELECT id FROM product_option_values WHERE product_id = ?', id).length, 3);
  assert.equal(all(raw, 'SELECT id FROM product_colors WHERE product_id = ?', id).length, 2);
});

// ------------------------------------------------------------------ conflicts and refusals

test('a field changed since the download is never overwritten; a group the file did not edit just reads older', async () => {
  const { app } = setup();
  const id = await create(app);
  const text = await download(app, id);
  // Somebody saves the product after the download: the English name and the English description.
  const other = edit(edit(await download(app, id), 'name_en', 'X1 Printer (form)'), 'description_en', 'Set in the form');
  const [p0] = await preview(app, other, id);
  assert.equal((await apply(app, other, p0)).status, 200);

  // The owner's file, edited on the English name (identity — moved) and on the hashtags (classification — not moved).
  let mine = edit(text, 'name_en', 'X1 Printer (file)');
  mine = edit(mine, 'hashtags', 'printer,fast,new');
  const [p] = await preview(app, mine, id);
  const st = Object.fromEntries(p.fields.map((f) => [f.key, f.status]));
  assert.equal(st.name_en, 'CONFLICT_SINCE_DOWNLOAD', 'the identity group moved and the file edited it');
  assert.equal(st.hashtags, 'change', 'an untouched group applies');
  assert.equal(st.description_en, 'STALE_IN_FILE', 'the file was not edited there: it is just older');
  const res = await apply(app, mine, p);
  assert.equal(res.status, 200, await res.clone().text());
  const after = await download(app, id);
  assert.match(after, /^name_en=X1 Printer \(form\)$/m, 'the newer name stays');
  assert.match(after, /^description_en=Set in the form$/m);
  assert.match(after, /^hashtags=printer,fast,new$/m);
});

test('the product changing between the preview and the apply refuses the apply (DATA_FILE_CHANGED)', async () => {
  const { app } = setup();
  const id = await create(app);
  const text = await download(app, id);
  const mine = edit(text, 'sku', 'X1-NEW');
  const [p] = await preview(app, mine, id);
  // A save lands in between.
  const other = edit(await download(app, id), 'name_en', 'Moved');
  const [p0] = await preview(app, other, id);
  assert.equal((await apply(app, other, p0)).status, 200);
  const res = await apply(app, mine, p);
  assert.equal(res.status, 409);
  const body = (await res.json()) as { code: string; details?: { preview?: PreviewProduct } };
  assert.equal(body.code, 'DATA_FILE_CHANGED');
  assert.ok(body.details?.preview?.token, 'the answer carries the fresh comparison');
});

test('invalid values are refused per field; the valid ones still apply; a file of only refusals writes nothing', async () => {
  const { raw, app } = setup();
  const id = await create(app);
  const text = await download(app, id);
  const c1 = /^colors\.(\d+)\.id=col_black$/m.exec(text)![1];
  let mine = edit(text, 'price_iqd', 'abc');
  mine = edit(mine, `colors.${c1}.hex`, 'not-a-colour');
  mine = edit(mine, 'display_order', '7');
  mine = mine.replace(`=== end ${id} ===`, `no_such_field=1\n=== end ${id} ===`);
  const [p] = await preview(app, mine, id);
  const st = Object.fromEntries(p.fields.map((f) => [f.key, f.status]));
  assert.equal(st.price_iqd, 'INVALID_VALUE');
  assert.equal(st[`colors.${c1}.hex`], 'INVALID_VALUE');
  assert.equal(st.no_such_field, 'UNKNOWN_FIELD');
  assert.equal(st.display_order, 'change');
  assert.equal((await apply(app, mine, p)).status, 200);
  assert.equal(row<{ display_order: number; price_iqd: number }>(raw, 'SELECT display_order, price_iqd FROM products WHERE id = ?', id)!.price_iqd, 1_000_000);

  const before = all(raw, 'SELECT * FROM products WHERE id = ?', id);
  const onlyBad = edit(await download(app, id), 'price_iqd', '-5');
  const [q] = await preview(app, onlyBad, id);
  assert.equal(q.token, null);
  assert.deepEqual(q.fields.map((f) => f.status), ['INVALID_VALUE']);
  const res = await apply(app, onlyBad, { ...q, token: 'f'.repeat(32) });
  assert.equal(res.status, 400);
  assert.deepEqual(all(raw, 'SELECT * FROM products WHERE id = ?', id), before, 'nothing written');
});

test('an engine-priced product: a changed final price is refused per field, an unchanged one passes, other fields apply', async () => {
  const { raw, app } = setup();
  const id = await create(app);
  const text = await download(app, id);
  // The engine's mode is set only under its own token (0181), as the adopting save sets it.
  raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:${id}', 1);
    INSERT INTO product_pricing_state (product_id, mode, updated_at) VALUES ('${id}', 'engine', '2026-10-10T00:00:00.000Z');
    DELETE FROM ops_guards WHERE id = 'pricing-mode:${id}';`);
  const o2 = /^options\.(\d+)\.id=opt_combo$/m.exec(text)![1];
  let mine = edit(text, 'price_iqd', '1100000');
  mine = edit(mine, `options.${o2}.regular_adjust_iqd`, '170000');
  mine = edit(mine, 'name_en', 'X1 Engine');
  const [p] = await preview(app, mine, id);
  const st = Object.fromEntries(p.fields.map((f) => [f.key, f.status]));
  assert.equal(st.price_iqd, 'ENGINE_MANAGED');
  assert.equal(st[`options.${o2}.regular_adjust_iqd`], 'ENGINE_MANAGED');
  assert.equal(st.name_en, 'change');
  const res = await apply(app, mine, p);
  assert.equal(res.status, 200, await res.clone().text());
  const stored = row<{ price_iqd: number; name: string }>(raw, 'SELECT price_iqd, name FROM products WHERE id = ?', id)!;
  assert.equal(stored.price_iqd, 1_000_000);
  assert.equal(stored.name, 'X1 Engine');
  // A new model is a price structure the engine owns too.
  const added = (await download(app, id)).replace(`=== end ${id} ===`, `options.9.name_en=Extra\noptions.9.group=Model\n=== end ${id} ===`);
  const [q] = await preview(app, added, id);
  assert.ok(q.fields.filter((f) => f.key.startsWith('options.9.')).every((f) => f.status === 'ENGINE_MANAGED'));
});

test('combinations: an unedited file is zero changes; one combination\'s stock writes that row alone; remove=true removes it', async () => {
  const { raw, app } = setup();
  const id = await create(app, VARIANT_PRODUCT);
  const text = await download(app, id);
  const [p0] = await preview(app, text, id);
  assert.deepEqual(p0.fields.filter((f) => f.status !== 'STALE_IN_FILE'), []);
  const v2 = /^variants\.(\d+)\.id=pv_white$/m.exec(text)![1];
  const black = row(raw, "SELECT * FROM product_variants WHERE id = 'pv_black'");
  const edited = edit(text, `variants.${v2}.stock`, '9');
  const [p] = await preview(app, edited, id);
  assert.deepEqual(p.fields.map((f) => [f.key, f.status, f.after]), [[`variants.${v2}.stock`, 'change', '9']]);
  assert.equal((await apply(app, edited, p)).status, 200);
  assert.equal(row<{ stock: number }>(raw, "SELECT stock FROM product_variants WHERE id = 'pv_white'")!.stock, 9);
  assert.deepEqual(row(raw, "SELECT * FROM product_variants WHERE id = 'pv_black'"), black, 'the other combination is untouched');

  // Removing one combination while its colour stays would leave that colour without direct stock:
  // the planner's own refusal, said in the preview against the line that asked for it.
  const again = await download(app, id);
  const v1 = /^variants\.(\d+)\.id=pv_black$/m.exec(again)![1];
  const [q] = await preview(app, edit(again, `variants.${v1}.remove`, 'true'), id);
  assert.deepEqual(q.fields.map((f) => [f.key, f.status]), [[`variants.${v1}.remove`, 'INVALID_VALUE']]);
  assert.match(q.fields[0].message ?? '', /Black/);
  assert.equal(q.token, null);
  // The colour and its combination removed together: applied.
  const c1 = /^colors\.(\d+)\.id=col_black$/m.exec(again)![1];
  const both = edit(edit(again, `variants.${v1}.remove`, 'true'), `colors.${c1}.remove`, 'true');
  const [r] = await preview(app, both, id);
  assert.deepEqual(r.fields.map((f) => f.status), ['change', 'change'], JSON.stringify(r.fields));
  const rr = await apply(app, both, r);
  assert.equal(rr.status, 200, await rr.clone().text());
  assert.equal(row(raw, "SELECT id FROM product_variants WHERE id = 'pv_black'"), undefined);
  assert.equal(row(raw, "SELECT id FROM product_colors WHERE id = 'col_black'"), undefined);
  assert.ok(row(raw, "SELECT id FROM product_variants WHERE id = 'pv_white'"));
});

// ------------------------------------------------------------------ row 212: the rounds' leftover, and the preview's product filter

test('lines left when the refusal rounds run out are said (never silently dropped): the count of changes is the rows shown', async () => {
  const { raw, app } = setup();
  const id = await create(app);
  for (let i = 1; i <= 9; i++) {
    raw.exec(`INSERT INTO product_images (id, product_id, url, r2_key, content_type, bytes, width, height, sort_order, is_primary, alt_en, alt_ar)
              VALUES ('img_r${i}', '${id}', '/files/products/r${i}.webp', 'products/r${i}.webp', 'image/webp', 1234, 800, 600, ${i}, ${i === 1 ? 1 : 0}, 'P${i}', 'ص${i}')`);
  }
  let text = await download(app, id);
  const pictures = [...text.matchAll(/^images\.(\d+)\.id=img_r\d$/gm)].map((m) => m[1]);
  assert.equal(pictures.length, 9);
  // Nine pictures bound to a colour the product does not have: the planner names ONE a round (eight rounds).
  for (const n of pictures) text = edit(text, `images.${n}.color_id`, 'col_nope');
  text = edit(text, 'display_order', '9');
  const [p] = await preview(app, text, id);
  const st = (k: string) => p.fields.find((f) => f.key === k)!;
  const exhausted = p.fields.filter((f) => /too many of this product's lines were refused/.test(f.message ?? ''));
  assert.deepEqual(exhausted.map((f) => f.key).sort(), ['display_order', `images.${pictures[8]}.color_id`].sort());
  assert.match(st('display_order').message!, /رُفضت أسطر كثيرة/);
  assert.match(st('display_order').message!, /ڕەتکرانەوە/);
  assert.equal(p.counts.changes, p.fields.filter((f) => f.status === 'change').length);
  assert.equal(p.counts.changes, 0);
  assert.equal(p.token, null);
});

test('the preview takes `product_ids`: a few blocks of a bulk file at a time, each one a block of the file', async () => {
  const { app } = setup();
  const a = await create(app);
  const b = await create(app, VARIANT_PRODUCT);
  const res = await get(app, `/api/admin/template/data-export?ids=${a},${b}`);
  const text = await res.text();
  const one = await post(app, '/api/admin/template/data-preview', { text, product_ids: [b] });
  assert.equal(one.status, 200);
  const body = (await one.json()) as { products: PreviewProduct[] };
  assert.deepEqual(body.products.map((x) => x.product_id), [b]);
  const both = (await (await post(app, '/api/admin/template/data-preview', { text, product_ids: [b, a] })).json()) as { products: PreviewProduct[] };
  assert.deepEqual(both.products.map((x) => x.product_id), [a, b], 'in the file\'s order');
  const unknown = await post(app, '/api/admin/template/data-preview', { text, product_ids: ['prd_not_in_file'] });
  assert.equal(unknown.status, 400);
  assert.equal(((await unknown.json()) as { code: string }).code, 'DATA_FILE_WRONG_PRODUCT');
  const many = await post(app, '/api/admin/template/data-preview', { text, product_ids: Array.from({ length: 26 }, (_, i) => `p${i}`) });
  assert.equal(many.status, 400);
  assert.equal(((await many.json()) as { code: string }).code, 'DATA_FILE_NO_PRODUCT');
  const malformed = await post(app, '/api/admin/template/data-preview', { text, product_ids: ['bad id!'] });
  assert.equal(malformed.status, 400);
});
