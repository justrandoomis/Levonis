/**
 * THE CATALOG-ONLY PROJECTIONS KEEP THE STRUCTURE A CHOOSER NEEDS
 * (DECISIONS row 240; the Bambu import spec §K.1 D-2, §G.3).
 *
 * A catalog-only product is shown with no price and no stock, but its page
 * still draws the option groups, the colour chips, «غير متاح مع هذا الاختيار»
 * (computed from `relations.variants[].combo_key`) and the gallery for a
 * selection (each picture's binding). So the two catalog-only projections —
 * `publicRelations(view, coarse, { catalogOnly: true })` and the allow-listed
 * `catalogOnlyCard` — must keep every id and binding, and pass through the
 * import's 0194 additions when a row carries them (a group's `kind`,
 * `name_ar`, `name_ckb`, `default_value_id`; a value's `swatch`), while never
 * carrying a stock fact or a price.
 *
 * One key per test, so a failure names the key that went missing.
 *
 * 0194's own rows are read by the REAL loaders too (the import spec §G.1, §C.4
 * step 3): a value's swatch (joined in the values statement — no new D1 wave)
 * and a representative image's source variant (`via_variant_id`), in the
 * priced block and the catalog-only one alike, never the swatch's provenance;
 * and a database without 0194 reads today's statements.
 *
 * The world: the catalog-only H2D (tests/fixtures/catalogOnly.ts) with a
 * picture bound to a value, one to a colour and one to a variant, a colour
 * linked to a value, and its group carrying the 0194 columns (0194 is in the
 * migrations the fixture applies; on a schema cut before it they are added here
 * with the migration's own definitions, so the loader's `SELECT *` returns them
 * either way).
 *
 * Run: node --import tsx --test tests/catalogOnlyProjectionKeys.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAT, CAT_SEL, catalogLeaks, catalogOnlyWorld, seedCatalogOnlyPrinter, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import { asD1, dbThrough } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { loadRelationsView, loadRelationsViews, publicRelations, applyRelations } from '../worker/lib/productOverlay';
import { parseProductRow } from '../worker/lib/productModel';
import { catalogOnlyCard, pricingCtxForUser, publicWithDisplayPrice } from '../worker/routes/products';

const VALUE_IMAGE = { id: 'img_cat_value', url: '/files/products/cat-value.webp' };
const COLOR_IMAGE = { id: 'img_cat_color', url: '/files/products/cat-color.webp' };
const VARIANT_IMAGE = { id: 'img_cat_variant', url: '/files/products/cat-variant.webp' };
const SWATCH = { url: '/files/products/swatch-grey.webp', width: 128, height: 128, published_hex: '#777777' };
/** The swatch row 0194 stores for the standard model, and its owner-only provenance (never a customer's). */
const LOADED_SWATCH = { url: `/files/products/import/swatch/${'e1'.repeat(32)}.webp`, width: 128, height: 128, published_hex: '#777777' };
const SWATCH_SOURCE = 'https://store.example/swatch-source-secret.png';
const SWATCH_HEX_REF = 'hex-ref-secret';

let shared: Promise<CatalogOnlyWorld> | null = null;
function world(): Promise<CatalogOnlyWorld> {
  shared ??= (async () => {
    const w = await catalogOnlyWorld();
    const ins = w.raw.prepare(
      `INSERT INTO product_images (id, product_id, url, r2_key, content_type, bytes, width, height, sort_order, is_primary, option_value_id, color_id, variant_id)
       VALUES (?, ?, ?, ?, 'image/webp', 1000, 800, 800, ?, 0, ?, ?, ?)`
    );
    ins.run(VALUE_IMAGE.id, CAT.id, VALUE_IMAGE.url, VALUE_IMAGE.url.slice('/files/'.length), 1, CAT_SEL.combo, null, null);
    ins.run(COLOR_IMAGE.id, CAT.id, COLOR_IMAGE.url, COLOR_IMAGE.url.slice('/files/'.length), 2, null, CAT_SEL.white, null);
    ins.run(VARIANT_IMAGE.id, CAT.id, VARIANT_IMAGE.url, VARIANT_IMAGE.url.slice('/files/'.length), 3, null, null, 'pv_cat_1');
    w.raw.prepare('INSERT INTO product_color_option_links (color_id, option_value_id, group_id) VALUES (?, ?, ?)').run(CAT_SEL.grey, CAT_SEL.std, 'g_cat_model');
    // 0194 (import spec §B.2 (1)), the four group columns exactly as the migration adds them —
    // only when the applied migrations predate it (with 0194 in migrations/ they already exist).
    const has0194 = (w.raw.prepare('PRAGMA table_info(product_option_groups)').all() as Array<{ name: string }>).some((c) => c.name === 'name_ar');
    if (!has0194) {
      w.raw.exec(`
        ALTER TABLE product_option_groups ADD COLUMN name_ar TEXT NOT NULL DEFAULT '';
        ALTER TABLE product_option_groups ADD COLUMN name_ckb TEXT NOT NULL DEFAULT '';
        ALTER TABLE product_option_groups ADD COLUMN kind TEXT NOT NULL DEFAULT ''
          CHECK (kind IN ('','color','spool','printer','version','size','nozzle','plate','units','pack','item','other'));
        ALTER TABLE product_option_groups ADD COLUMN default_value_id TEXT NOT NULL DEFAULT '';
      `);
    }
    // 0194's own rows, as the import writes them (spec §B.2 (3) and (8)): the standard model's official
    // swatch (with its owner-only provenance), and the value picture as a REPRESENTATIVE binding whose
    // source variant is the combo's SKU (§C.4 step 3) — read by the real loader, never hand-built.
    w.raw
      .prepare(
        `INSERT INTO product_option_value_swatches (option_value_id, product_id, url, r2_key, width, height, published_hex, hex_source_ref, source_url)
         VALUES (?, ?, ?, ?, 128, 128, ?, ?, ?)`
      )
      .run(CAT_SEL.std, CAT.id, LOADED_SWATCH.url, LOADED_SWATCH.url.slice('/files/'.length), LOADED_SWATCH.published_hex, SWATCH_HEX_REF, SWATCH_SOURCE);
    w.raw
      .prepare(
        `INSERT INTO product_option_source_refs (product_id, kind, source, source_id, levonis_id, source_label, binding_rule, via_variant_id, import_run_id)
         VALUES (?, 'image', 'bambu_us', 'res_cat_value', ?, '', 'representative', 'pv_cat_2', 'cir_test')`
      )
      .run(CAT.id, VALUE_IMAGE.id);
    w.raw.exec(`
      UPDATE product_option_groups SET name_ar = 'الطراز', name_ckb = 'مۆدێل', kind = 'version', default_value_id = '${CAT_SEL.combo}'
       WHERE id = 'g_cat_model';
    `);
    return w;
  })();
  return shared;
}

type Rel = {
  option_groups: Array<Record<string, unknown> & { values: Array<Record<string, unknown>> }>;
  colors: Array<Record<string, unknown> & { links: Array<Record<string, unknown>> }>;
  variants: Array<Record<string, unknown>>;
  images: Array<Record<string, unknown>>;
};

/** The catalog-only page body, as an anonymous visitor receives it from the real Worker. */
async function page(): Promise<Record<string, unknown> & { product: Record<string, unknown>; relations: Rel }> {
  const w = await world();
  const res = await w.guest(`/api/products/${CAT.slug}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown> & { product: Record<string, unknown>; relations: Rel };
  assert.equal(body.price_status, 'unpriced', 'the catalog-only page');
  assert.deepEqual(catalogLeaks(body), [], 'and it leaks nothing');
  return body;
}

/** The view as the loader reads it, with a value carrying the swatch the import's 0194 join adds. */
async function viewWithSwatch() {
  const w = await world();
  const view = await loadRelationsView(w.db, CAT.id, 'BASE');
  return { ...view, values: view.values.map((v) => (v.id === CAT_SEL.std ? { ...v, swatch: { ...SWATCH, source_url: 'https://supplier.example/s.png', hex_source_ref: 'pdf' } } : v)) };
}
const catalogOnlyRelations = async () => publicRelations(await viewWithSwatch(), false, { catalogOnly: true }) as unknown as Rel;

/** The catalog-only card of the H2D, from its overlaid document. */
async function card(extra: (doc: ReturnType<typeof applyRelations>) => void = () => {}) {
  const w = await world();
  const row = w.raw.prepare('SELECT * FROM products WHERE id = ?').get(CAT.id) as Record<string, unknown>;
  const view = await loadRelationsView(w.db, CAT.id, 'BASE');
  const doc = applyRelations(parseProductRow(row), view);
  extra(doc);
  const out = catalogOnlyCard(doc) as Record<string, unknown> & { options: Array<Record<string, unknown>>; colors: Array<Record<string, unknown>>; media: Array<Record<string, unknown>> };
  assert.equal(out.price_status, 'unpriced');
  return out;
}

const group = (rel: Rel) => rel.option_groups.find((g) => g.id === 'g_cat_model')!;
const image = (rel: Rel, id: string) => rel.images.find((i) => i.id === id)!;

// ------------------------------------------------- publicRelations({ catalogOnly: true }) — the page body

test('relations: variants[].combo_key is kept (the «غير متاح مع هذا الاختيار» rule reads it)', async () => {
  const rel = (await page()).relations;
  assert.deepEqual(rel.variants.map((v) => v.combo_key).sort(), [CAT_SEL.key(CAT_SEL.combo, CAT_SEL.white), CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey)].sort());
});

test('relations: variants[].id is kept (a picture binds to it)', async () => {
  const rel = (await page()).relations;
  assert.deepEqual(rel.variants.map((v) => v.id).sort(), ['pv_cat_1', 'pv_cat_2']);
});

test('relations: option_groups[].id is kept', async () => {
  assert.ok(group((await page()).relations), 'the group is there by its id');
});

test('relations: option_groups[].values[].id is kept', async () => {
  assert.deepEqual(group((await page()).relations).values.map((v) => v.id), [CAT_SEL.std, CAT_SEL.combo]);
});

test('relations: colors[].id is kept', async () => {
  assert.deepEqual((await page()).relations.colors.map((c) => c.id), [CAT_SEL.grey, CAT_SEL.white]);
});

test('relations: colors[].links keep the group and value ids', async () => {
  const grey = (await page()).relations.colors.find((c) => c.id === CAT_SEL.grey)!;
  assert.deepEqual(grey.links, [{ group_id: 'g_cat_model', option_value_id: CAT_SEL.std }]);
});

test('relations: images[].option_value_id is kept', async () => {
  assert.equal(image((await page()).relations, VALUE_IMAGE.id).option_value_id, CAT_SEL.combo);
});

test('relations: images[].color_id is kept', async () => {
  assert.equal(image((await page()).relations, COLOR_IMAGE.id).color_id, CAT_SEL.white);
});

test('relations: images[].variant_id is kept', async () => {
  assert.equal(image((await page()).relations, VARIANT_IMAGE.id).variant_id, 'pv_cat_1');
});

test('relations (0194): option_groups[].kind is passed through', async () => {
  assert.equal(group((await page()).relations).kind, 'version');
});

test('relations (0194): option_groups[].name_ar is passed through', async () => {
  assert.equal(group((await page()).relations).name_ar, 'الطراز');
});

test('relations (0194): option_groups[].name_ckb is passed through', async () => {
  assert.equal(group((await page()).relations).name_ckb, 'مۆدێل');
});

test('relations (0194): option_groups[].default_value_id is passed through', async () => {
  assert.equal(group((await page()).relations).default_value_id, CAT_SEL.combo);
});

test('relations (0194): option_groups[].values[].swatch is passed through — the picture, its size and the published hex, never its provenance', async () => {
  const value = group(await catalogOnlyRelations()).values.find((v) => v.id === CAT_SEL.std)!;
  assert.deepEqual(value.swatch, SWATCH);
});

test('relations: before 0194 no 0194 key is invented', async () => {
  const w = await world();
  const view = await loadRelationsView(w.db, CAT.id, 'BASE');
  // The view a loader reading a database without 0194 builds: no group column, no swatch, no source variant.
  const bare = {
    ...view,
    groups: view.groups.map(({ name_ar: _a, name_ckb: _c, kind: _k, default_value_id: _d, ...g }) => g),
    values: view.values.map(({ swatch: _s, ...v }) => v),
    images: view.images.map(({ via_variant_id: _v, ...i }) => i),
  };
  const rel = publicRelations(bare, false, { catalogOnly: true }) as unknown as Rel;
  for (const k of ['kind', 'name_ar', 'name_ckb', 'default_value_id']) assert.equal(k in group(rel), false, k);
  assert.ok(group(rel).values.every((v) => !('swatch' in v)), 'no swatch without the join');
  assert.ok(rel.images.every((i) => !('via_variant_id' in i)), 'no source variant without 0194');
});

// ------------------------------------------------- 0194 read by the REAL loaders (the import spec §G.1, §C.4; no new D1 wave)

/** Both projections of the page body: the catalog-only one a visitor receives, and the priced one. */
async function bothBlocks(): Promise<Array<[string, Rel]>> {
  const w = await world();
  const view = await loadRelationsView(w.db, CAT.id, 'BASE');
  return [
    ['catalog-only (the real page)', (await page()).relations],
    ['priced', publicRelations(view, false) as unknown as Rel],
  ];
}

test('relations (0194): the loader joins each value’s swatch — priced and catalog-only alike, never its provenance', async () => {
  for (const [what, rel] of await bothBlocks()) {
    const std = group(rel).values.find((v) => v.id === CAT_SEL.std)!;
    assert.deepEqual(std.swatch, LOADED_SWATCH, what);
    assert.equal('swatch' in group(rel).values.find((v) => v.id === CAT_SEL.combo)!, false, `${what}: a value with no swatch row has none`);
    const text = JSON.stringify(rel);
    for (const secret of [SWATCH_SOURCE, SWATCH_HEX_REF, 'source_url', 'hex_source_ref', 'r2_key']) assert.ok(!text.includes(secret), `${what}: ${secret}`);
  }
});

test('relations (0194): images[].via_variant_id — a representative’s source variant, priced and catalog-only alike', async () => {
  for (const [what, rel] of await bothBlocks()) {
    assert.equal(image(rel, VALUE_IMAGE.id).via_variant_id, 'pv_cat_2', what);
    for (const id of [COLOR_IMAGE.id, VARIANT_IMAGE.id, 'img_cat']) {
      assert.equal('via_variant_id' in image(rel, id), false, `${what}: ${id} is no representative, so it carries no key`);
    }
  }
});

test('relations (0194): the batch loader (listings, compare) reads the same swatch and source variant', async () => {
  const w = await world();
  const view = (await loadRelationsViews(w.db, [{ id: CAT.id, inventory_mode: 'BASE' }])).get(CAT.id)!;
  const std = view.values.find((v) => v.id === CAT_SEL.std)!;
  assert.deepEqual(std.swatch, LOADED_SWATCH);
  assert.equal(view.images.find((i) => i.id === VALUE_IMAGE.id)?.via_variant_id, 'pv_cat_2');
  // The flat joined columns never ride on a value row.
  assert.ok(view.values.every((v) => !Object.keys(v).some((k) => k.startsWith('swatch_'))));
});

test('relations (0194): a default that names no live value of its own group answers "" (an unknown id is ignored)', async () => {
  const w = await world();
  const view = await loadRelationsView(w.db, CAT.id, 'BASE');
  for (const bad of ['v_cat_unknown', CAT_SEL.grey]) {
    const rel = publicRelations({ ...view, groups: view.groups.map((g) => ({ ...g, default_value_id: bad })) }, false, { catalogOnly: true }) as unknown as Rel;
    assert.equal(group(rel).default_value_id, '', bad);
  }
  const off = publicRelations(
    { ...view, values: view.values.map((v) => (v.id === CAT_SEL.combo ? { ...v, active: 0 } : v)) },
    false,
    { catalogOnly: true }
  ) as unknown as Rel;
  assert.equal(group(off).default_value_id, '', 'an inactive value is no default');
});

test('relations: a database WITHOUT 0194 — the loaders read today’s statements and no 0194 key appears', async () => {
  const raw = dbThrough('0193');
  seedLiveCatalog(raw);
  seedCatalogOnlyPrinter(raw);
  raw.prepare(
    `INSERT INTO product_images (id, product_id, url, r2_key, content_type, bytes, width, height, sort_order, is_primary, option_value_id)
     VALUES (?, ?, ?, ?, 'image/webp', 1000, 800, 800, 1, 0, ?)`
  ).run(VALUE_IMAGE.id, CAT.id, VALUE_IMAGE.url, VALUE_IMAGE.url.slice('/files/'.length), CAT_SEL.combo);
  const db = asD1(raw);
  const one = await loadRelationsView(db, CAT.id, 'BASE');
  const many = (await loadRelationsViews(db, [{ id: CAT.id, inventory_mode: 'BASE' }])).get(CAT.id)!;
  for (const [what, view] of [['one product', one], ['a page of products', many]] as const) {
    assert.equal(view.has_relations, true, `${what}: the relations are read, not degraded to none`);
    assert.deepEqual(view.values.map((v) => v.id).sort(), [CAT_SEL.combo, CAT_SEL.std].sort(), what);
    assert.ok(view.values.every((v) => !('swatch' in v)), what);
    assert.ok(view.images.some((i) => i.id === VALUE_IMAGE.id), what);
    const rel = publicRelations(view, false, { catalogOnly: true }) as unknown as Rel;
    for (const k of ['kind', 'name_ar', 'name_ckb', 'default_value_id']) assert.equal(k in group(rel), false, `${what}: ${k}`);
    assert.ok(rel.images.every((i) => !('via_variant_id' in i)), what);
  }
});

test('relations: no stock fact at any level of the catalog-only block, coarse or not', async () => {
  for (const coarse of [false, true]) {
    const rel = publicRelations(await viewWithSwatch(), coarse, { catalogOnly: true }) as unknown as Rel;
    const levels = [...rel.option_groups.flatMap((g) => g.values), ...rel.colors, ...rel.variants];
    assert.ok(levels.length > 0);
    for (const x of levels) assert.equal('available' in x || 'stock_state' in x, false, JSON.stringify(Object.keys(x)));
  }
});

// ------------------------------------------------- catalogOnlyCard — the allow-listed card

test('card: options[].id (the value id) is kept', async () => {
  assert.deepEqual((await card()).options.map((o) => o.id), [CAT_SEL.std, CAT_SEL.combo]);
});

test('card: colors[].id is kept', async () => {
  assert.deepEqual((await card()).colors.map((c) => c.id), [CAT_SEL.grey, CAT_SEL.white]);
});

test('card: colors[].option_ids (the colour\'s value links) are kept', async () => {
  const grey = (await card()).colors.find((c) => c.id === CAT_SEL.grey)!;
  assert.deepEqual(grey.option_ids, [CAT_SEL.std]);
});

test('card: media[].option_value_id is kept', async () => {
  assert.equal((await card()).media.find((m) => m.id === VALUE_IMAGE.id)?.option_value_id, CAT_SEL.combo);
});

test('card: media[].color_id is kept', async () => {
  assert.equal((await card()).media.find((m) => m.id === COLOR_IMAGE.id)?.color_id, CAT_SEL.white);
});

test('card: media[].variant_id is kept', async () => {
  assert.equal((await card()).media.find((m) => m.id === VARIANT_IMAGE.id)?.variant_id, 'pv_cat_1');
});

/**
 * The sale and stock facts the catalog-only card drops ON PURPOSE (DECISIONS row 240: no stock word for
 * stock nobody configured, no way to buy). Any other key the priced card's options or colours carry — a
 * structural key the import adds later, such as a swatch — must be kept: this test fails until it is.
 */
const DROPPED_ON_PURPOSE = /^(stock|low_stock_threshold|availability_type|lead_time_.*|fulfillments)$|price|cost|surcharge|adjust/;

test('card: every option and colour key the PRICED card shows is kept, except the sale and stock facts dropped on purpose', async () => {
  const w = await world();
  const row = w.raw.prepare('SELECT * FROM products WHERE id = ?').get(CAT.id) as Record<string, unknown>;
  const view = await loadRelationsView(w.db, CAT.id, 'BASE');
  // The same document projected as if it were sellable (a test-only call: no customer ever gets this).
  const priced = publicWithDisplayPrice(row, await pricingCtxForUser(w.db, null), { sellable: true }, view) as {
    options: Array<Record<string, unknown>>;
    colors: Array<Record<string, unknown>>;
  };
  const c = await card();
  const keysOf = (list: Array<Record<string, unknown>>) => new Set(list.flatMap((x) => Object.keys(x)));
  for (const [what, shown, kept] of [
    ['options', keysOf(priced.options), keysOf(c.options)],
    ['colors', keysOf(priced.colors), keysOf(c.colors)],
  ] as const) {
    assert.ok(shown.size > 0, `${what}: the priced card shows some`);
    const dropped = [...shown].filter((k) => !kept.has(k) && !DROPPED_ON_PURPOSE.test(k));
    assert.deepEqual(dropped, [], `${what}: the catalog-only card drops a structural key the priced card shows`);
  }
});

test('card: still no price and no stock key on an option or a colour (the allow-list holds)', async () => {
  const c = await card();
  for (const x of [...c.options, ...c.colors]) {
    for (const k of Object.keys(x)) assert.doesNotMatch(k, /price|stock|cost|available|surcharge|adjust/, k);
  }
  assert.equal(c.price_iqd, null);
  assert.equal(c.display_price_iqd, null);
});
