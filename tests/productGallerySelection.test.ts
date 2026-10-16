/**
 * THE GALLERY FOR A SELECTION (the Bambu import spec §G.3; src/lib/productGallery.ts).
 *
 *   1. the spec's cases on the import's REAL bindings (tests/fixtures/
 *      bambuRelations.ts runs the import's option model and media plan over
 *      the committed fixtures): PEI plate H2C → FAP035, H2D → FAP025;
 *      H2D AMS Combo → H2DC with no H2DL or plain-H2D image; A1 Standard → no
 *      A1_C image; a representative is dropped once its source variant clashes;
 *   2. both failed with the page's old order (de-duplicate, then rank);
 *   3. AN UNBOUND GALLERY — every product before the import — is exactly what
 *      the old function gave, for every selection; and with no selection the
 *      stored order stands for every product;
 *   4. the page's rule agrees with the import's own `contradicts` on every row
 *      of every fixture for every real variant;
 *   5. AN EXISTING PRODUCT whose variant rows are partial (a pre-order-only
 *      model has none) keeps its chosen value's own picture in the lead — the
 *      picture the cart line and the order snapshot store
 *      (worker/lib/productSelectionImage.ts) — and an imported product never
 *      drops the selected value's own picture either.
 *
 * Run: node --import tsx --test tests/productGallerySelection.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contradictsSelection,
  dedupeByUrl,
  galleryForSelection,
  mediaInStoredOrder,
  type GalleryMedia,
  type GalleryModel,
} from '../src/lib/productGallery';
import { productVariantIdForSelection } from '../src/lib/productImage';
import { productMediaForSelection } from '../packages/pricing/src/productSelectionMedia';
import { contradicts } from '../packages/catalog/src/bambuImport/media';
import { productImageForSelection } from '../worker/lib/productSelectionImage';
import type { ProductDoc } from '../worker/lib/productModel';
import type { ProductRelationsView } from '../worker/lib/productOverlay';
import { fixtureRelations, type FixtureRelations } from './fixtures/bambuRelations';
import { SAMPLE_HANDLES } from './fixtures/bambu/load';

/** An imported product's model: its variants are every real combination (the page passes `importedChooser`). */
const modelOf = (f: FixtureRelations): GalleryModel => ({ groups: f.option_groups, variants: f.variants, completeVariants: true });

/** The files the page shows, in order, for a selection of value names. */
function shown(f: FixtureRelations, names: string[]): string[] {
  const ids = names.map(f.valueId);
  const variantId = productVariantIdForSelection(f.variants, { optionValueIds: ids });
  const media = mediaInStoredOrder(f.images);
  return galleryForSelection(media, f.images, modelOf(f), { optionValueIds: ids, variantId }).map((m) => m.file);
}

/**
 * What the page drew before this change, kept here as the reference: de-duplicate by URL first, then rank
 * (src/pages/Product.tsx galleryOf over the old src/lib/productImage.ts productGalleryForSelection, which
 * had no caller left and is gone).
 */
function oldGallery<T extends GalleryMedia>(media: readonly T[], bindings: readonly GalleryMedia[], sel: { optionValueIds?: string[]; optionId?: string; colorId?: string; variantId?: string | null }): T[] {
  const base = dedupeByUrl(mediaInStoredOrder(media));
  const optionValueIds = sel.optionValueIds?.length ? [...new Set(sel.optionValueIds.filter(Boolean))] : sel.optionId ? [sel.optionId] : [];
  if (!sel.variantId && !sel.colorId && optionValueIds.length === 0) return [...base];
  const byId = new Map(bindings.filter((b) => b.id).map((b) => [b.id!, b]));
  const byUrl = new Map(bindings.map((b) => [b.url, b]));
  const candidates = base.map((image) => {
    const b = (image.id ? byId.get(image.id) : undefined) ?? byUrl.get(image.url) ?? image;
    return { image, url: image.url, primary: image.primary, variant_id: b.variant_id, color_id: b.color_id, option_value_id: b.option_value_id };
  });
  return productMediaForSelection(candidates, { optionValueIds, colorId: sel.colorId, variantId: sel.variantId }).map(({ image }) => image);
}

// ------------------------------------------------------------------ 1. the spec's cases

test('PEI plate: H2C leads with FAP035, H2D with FAP025, P2S with FAP033 (value_set rows of one picture)', () => {
  const f = fixtureRelations('bambu-textured-pei-plate');
  assert.equal(shown(f, ['H2C'])[0], 'FAP035');
  assert.equal(shown(f, ['H2D'])[0], 'FAP025');
  assert.equal(shown(f, ['P2S'])[0], 'FAP033');
  // Another printer's plate is never in the gallery of this one.
  assert.ok(!shown(f, ['H2C']).includes('FAP025') && !shown(f, ['H2C']).includes('FAP033'), shown(f, ['H2C']).join(','));
  // One picture, one thumbnail: the shared URL is shown once.
  const h2c = galleryForSelection(mediaInStoredOrder(f.images), f.images, modelOf(f), { optionValueIds: [f.valueId('H2C')] });
  assert.equal(new Set(h2c.map((m) => m.url)).size, h2c.length);
});

test('H2D: «H2D AMS Combo» leads with H2DC and shows no H2DL or plain-H2D picture; «Laser Full Combo» with H2DL', () => {
  const f = fixtureRelations('h2d');
  const combo = shown(f, ['H2D AMS Combo']);
  assert.equal(combo[0], 'H2DC');
  assert.ok(!combo.includes('H2DL-10w'), combo.join(','));
  assert.ok(!combo.includes('H2D'), `the plain H2D picture is another version: ${combo.join(',')}`);
  assert.equal(shown(f, ['H2D Laser Full Combo'])[0], 'H2DL-10w');
  const plain = shown(f, ['H2D']);
  assert.ok(!plain.includes('H2DC') && !plain.includes('H2DL-10w'), plain.join(','));
});

test('H2D: the full selection with a bundle leads with its own variant picture and drops the representative', () => {
  const f = fixtureRelations('h2d');
  const full = shown(f, ['H2D AMS Combo', 'Dual AMS 2 Pro Bundle']);
  assert.equal(full[0], 'H2DUSMS2PRo');
  assert.ok(!full.includes('H2DC'), 'H2DC shows the Standard bundle (via_variant_id), not this one');
  assert.ok(f.images.some((i) => i.via_variant_id), 'the fixture carries representative rows');
});

test('A1: «Standard» (A1) shows no A1_C picture; the Combo leads with A1_C', () => {
  const f = fixtureRelations('a1');
  const std = shown(f, ['A1']);
  assert.equal(std[0], 'A1');
  assert.ok(!std.includes('A1_C'), std.join(','));
  assert.equal(shown(f, ['A1 Combo'])[0], 'A1_C');
});

// ------------------------------------------------------------------ 2. the old order failed

test('the page’s old order (de-duplicate, then rank) led the PEI plate with FAP033 for H2C and H2D', () => {
  const f = fixtureRelations('bambu-textured-pei-plate');
  const media = f.images;
  const before = (name: string) => oldGallery(media, media, { optionValueIds: [f.valueId(name)] }).map((m) => m.file)[0];
  assert.notEqual(before('H2C'), 'FAP035');
  assert.notEqual(before('H2D'), 'FAP025');
});

// ------------------------------------------------------------------ 3. an unbound gallery is unchanged

type Plain = GalleryMedia & { url: string; tag: string };

/** A deterministic pseudo-random sequence, so the sweep is the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('an UNBOUND gallery (every product before the import): exactly the old answer, for any selection', () => {
  const next = rng(7);
  const model: GalleryModel = {
    groups: [
      { id: 'g1', values: [{ id: 'a' }, { id: 'b' }] },
      { id: 'g2', values: [{ id: 'x' }, { id: 'y' }] },
    ],
    variants: [
      { id: 'v1', combo_key: 'o:a|o:x' },
      { id: 'v2', combo_key: 'o:b|o:y' },
    ],
  };
  const selections = [{}, { optionValueIds: ['a'] }, { optionValueIds: ['b', 'y'], variantId: 'v2' }, { colorId: 'c1' }, { optionValueIds: ['a', 'y'] }];
  for (let round = 0; round < 200; round++) {
    const n = 1 + Math.floor(next() * 7);
    const media: Plain[] = Array.from({ length: n }, (_, i) => ({
      id: `img${round}_${i}`,
      url: `/files/p/${Math.floor(next() * 4)}.webp`, // repeats on purpose
      order: Math.floor(next() * 5),
      primary: false,
      tag: `${i}`,
    }));
    if (next() < 0.7) media[Math.floor(next() * n)].primary = true;
    const bindings = media.map((m) => ({ id: m.id, url: m.url, option_value_id: null, color_id: null, variant_id: null }));
    for (const sel of selections) {
      const now = galleryForSelection(mediaInStoredOrder(media), bindings, model, sel).map((m) => m.tag);
      const old = oldGallery(media, bindings, sel).map((m) => m.tag);
      assert.deepEqual(now, old, `round ${round}, ${JSON.stringify(sel)}`);
    }
  }
});

test('with no selection the stored order stands for EVERY product, bound or not (primary first, then order, URL once)', () => {
  for (const h of SAMPLE_HANDLES) {
    const f = fixtureRelations(h);
    const now = galleryForSelection(mediaInStoredOrder(f.images), f.images, modelOf(f), {}).map((m) => m.id);
    const old = oldGallery(f.images, f.images, {}).map((m) => m.id);
    assert.deepEqual(now, old, h);
  }
});

test('a JSON-only gallery (no relational rows, no ids) reads as before', () => {
  const media = [
    { url: '/files/p/2.webp', order: 1 },
    { url: '/files/p/1.webp', order: 0, primary: true },
    { url: '/files/p/2.webp', order: 2 },
  ];
  for (const sel of [{}, { optionValueIds: ['a'] }, { colorId: 'c' }]) {
    assert.deepEqual(galleryForSelection(mediaInStoredOrder(media), media, { groups: [], variants: [] }, sel), oldGallery(media, media, sel));
  }
});

// ------------------------------------------------------------------ 4. one rule with the import

test('the page drops exactly the rows the import’s own rule calls contradicting — every fixture, every real variant', () => {
  let checked = 0;
  for (const h of SAMPLE_HANDLES) {
    const f = fixtureRelations(h);
    for (const v of f.model.variants) {
      for (const sel of [v.valueIds, v.valueIds.slice(0, 1)]) {
        for (const r of f.media.rows) {
          const img = f.images.find((i) => i.id === r.id)!;
          const page = contradictsSelection(img, modelOf(f), { optionValueIds: sel });
          assert.equal(page, contradicts(r, f.model, sel), `${h}: ${img.file} for ${sel.join('+')}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 500, `${checked} checks`);
});

test('a colour other than the selected one is left out; an unbound image always stays; nothing left → the full list', () => {
  const model: GalleryModel = { groups: [{ id: 'g', values: [{ id: 'a' }, { id: 'b' }] }], variants: [] };
  const media = mediaInStoredOrder([
    { id: '1', url: '/files/1.webp', primary: true, order: 0, color_id: 'red' },
    { id: '2', url: '/files/2.webp', order: 1, color_id: 'blue' },
    { id: '3', url: '/files/3.webp', order: 2 },
    { id: '4', url: '/files/4.webp', order: 3, option_value_id: 'b' },
  ]);
  assert.deepEqual(galleryForSelection(media, media, model, { colorId: 'blue' }).map((m) => m.id), ['2', '3', '4']);
  assert.deepEqual(galleryForSelection(media, media, model, { optionValueIds: ['a'], colorId: 'blue' }).map((m) => m.id), ['2', '3']);
  const onlyBound = mediaInStoredOrder([{ id: '1', url: '/files/1.webp', primary: true, option_value_id: 'b' }]);
  assert.deepEqual(galleryForSelection(onlyBound, onlyBound, model, { optionValueIds: ['a'] }).map((m) => m.id), ['1'], 'never an empty gallery');
});

// ------------------------------------------------------------------ 5. an existing product's partial variants

test('an existing product with partial variant rows: the chosen model’s own picture leads, as on the cart line', () => {
  // Model A sold direct with red and blue linked (rows A×red, A×blue); model B by pre-order only: no row
  // holds o:B (src/components/adminProducts/form/model.ts creates rows for direct sale only).
  const media = mediaInStoredOrder([
    { id: 'iP', url: '/files/p.webp', primary: true, order: 0 },
    { id: 'iA', url: '/files/a.webp', order: 1, option_value_id: 'A' },
    { id: 'iB', url: '/files/b.webp', order: 2, option_value_id: 'B' },
    { id: 'iR', url: '/files/r.webp', order: 3, color_id: 'red' },
  ]);
  const groups = [{ id: 'gModel', values: [{ id: 'A' }, { id: 'B' }] }];
  const variants = [
    { id: 'v1', combo_key: 'o:A|c:red', active: 1 },
    { id: 'v2', combo_key: 'o:A|c:blue', active: 1 },
  ];
  const page = galleryForSelection(media, media, { groups, variants }, { optionId: 'B', optionValueIds: ['B'] });
  assert.deepEqual(page.map((m) => m.url), ['/files/b.webp', '/files/p.webp', '/files/r.webp'], 'B leads; A, another value of the chosen group, is left out');
  const doc = { media: media.map((m) => ({ ...m, key: '', role: 'gallery', alt_ar: '', alt_en: '', alt_ckb: '', primary: !!m.primary, order: m.order ?? 0 })) } as unknown as ProductDoc;
  const cart = productImageForSelection(doc, { optionValueIds: ['B'], colorId: null }, { variants } as unknown as ProductRelationsView);
  assert.equal(page[0].url, cart, 'the page’s hero is the cart line’s picture');
  // A second group: the nozzle n1 is modelled only with A (A×n1). Pre-order B with n1 may still be sold, so on
  // an existing product n1's picture stays where the old gallery had it — the rule is the import's only.
  const twoGroups = [...groups, { id: 'gNozzle', values: [{ id: 'n1' }, { id: 'n2' }] }];
  const nozzleMedia = mediaInStoredOrder([...media, { id: 'iN1', url: '/files/n1.webp', order: 4, option_value_id: 'n1' }]);
  const partial = [{ id: 'v3', combo_key: 'o:A|o:n1', active: 1 }];
  const existing = galleryForSelection(nozzleMedia, nozzleMedia, { groups: twoGroups, variants: partial }, { optionValueIds: ['B'] }).map((m) => m.url);
  assert.ok(existing.includes('/files/n1.webp'), existing.join(', '));
  assert.ok(
    !galleryForSelection(nozzleMedia, nozzleMedia, { groups: twoGroups, variants: partial, completeVariants: true }, { optionValueIds: ['B'] }).some((m) => m.url === '/files/n1.webp'),
    'on an imported product (complete variants) n1 with B is an impossible combination'
  );
  // The same rows read as an imported product's (complete variants): B forms no variant, so its picture is
  // an impossible choice for anyone who has not chosen it — but never for the one who has.
  assert.equal(galleryForSelection(media, media, { groups, variants, completeVariants: true }, { optionValueIds: ['B'] })[0].url, '/files/b.webp');
  assert.ok(
    !galleryForSelection(media, media, { groups: [...groups, { id: 'gColour', values: [{ id: 'cr' }] }], variants, completeVariants: true }, { optionValueIds: ['cr'] }).some((m) => m.url === '/files/b.webp'),
    'an imported product still leaves out a value no variant pairs with the selection'
  );
});
