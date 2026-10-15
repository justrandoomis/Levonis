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
 * The world: the catalog-only H2D (tests/fixtures/catalogOnly.ts) with a
 * picture bound to a value, one to a colour and one to a variant, a colour
 * linked to a value, and its group carrying the 0194 columns (added here with
 * the migration's own definitions, so the loader's `SELECT *` returns them).
 *
 * Run: node --import tsx --test tests/catalogOnlyProjectionKeys.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAT, CAT_SEL, catalogLeaks, catalogOnlyWorld, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import { loadRelationsView, publicRelations, applyRelations } from '../worker/lib/productOverlay';
import { parseProductRow } from '../worker/lib/productModel';
import { catalogOnlyCard, pricingCtxForUser, publicWithDisplayPrice } from '../worker/routes/products';

const VALUE_IMAGE = { id: 'img_cat_value', url: '/files/products/cat-value.webp' };
const COLOR_IMAGE = { id: 'img_cat_color', url: '/files/products/cat-color.webp' };
const VARIANT_IMAGE = { id: 'img_cat_variant', url: '/files/products/cat-variant.webp' };
const SWATCH = { url: '/files/products/swatch-grey.webp', width: 128, height: 128, published_hex: '#777777' };

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
    // 0194 (import spec §B.2 (1)), the four group columns exactly as the migration adds them.
    w.raw.exec(`
      ALTER TABLE product_option_groups ADD COLUMN name_ar TEXT NOT NULL DEFAULT '';
      ALTER TABLE product_option_groups ADD COLUMN name_ckb TEXT NOT NULL DEFAULT '';
      ALTER TABLE product_option_groups ADD COLUMN kind TEXT NOT NULL DEFAULT ''
        CHECK (kind IN ('','color','spool','printer','version','size','nozzle','plate','units','pack','item','other'));
      ALTER TABLE product_option_groups ADD COLUMN default_value_id TEXT NOT NULL DEFAULT '';
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
  const bare = {
    ...view,
    groups: view.groups.map(({ name_ar: _a, name_ckb: _c, kind: _k, default_value_id: _d, ...g }) => g),
  };
  const rel = publicRelations(bare, false, { catalogOnly: true }) as unknown as Rel;
  for (const k of ['kind', 'name_ar', 'name_ckb', 'default_value_id']) assert.equal(k in group(rel), false, k);
  assert.ok(group(rel).values.every((v) => !('swatch' in v)), 'no swatch without the join');
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
