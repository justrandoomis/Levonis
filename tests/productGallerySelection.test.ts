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
 *      of every fixture for every real variant.
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
import { productGalleryForSelection, productVariantIdForSelection } from '../src/lib/productImage';
import { contradicts } from '../packages/catalog/src/bambuImport/media';
import { fixtureRelations, type FixtureRelations } from './fixtures/bambuRelations';
import { SAMPLE_HANDLES } from './fixtures/bambu/load';

const modelOf = (f: FixtureRelations): GalleryModel => ({ groups: f.option_groups, variants: f.variants });

/** The files the page shows, in order, for a selection of value names. */
function shown(f: FixtureRelations, names: string[]): string[] {
  const ids = names.map(f.valueId);
  const variantId = productVariantIdForSelection(f.variants, { optionValueIds: ids });
  const media = mediaInStoredOrder(f.images);
  return galleryForSelection(media, f.images, modelOf(f), { optionValueIds: ids, variantId }).map((m) => m.file);
}

/** What the page drew before this change: de-duplicate by URL first, then rank (src/pages/Product.tsx galleryOf). */
function oldGallery<T extends GalleryMedia>(media: readonly T[], bindings: readonly GalleryMedia[], sel: { optionValueIds?: string[]; colorId?: string; variantId?: string | null }): T[] {
  const base = dedupeByUrl(mediaInStoredOrder(media));
  return productGalleryForSelection(base, bindings, sel) as T[];
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
