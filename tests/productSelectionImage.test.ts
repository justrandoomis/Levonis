import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  productMediaForSelection,
  productSelectionComboKey,
  productVariantIdForSelection,
} from '@levonis/pricing/productSelectionMedia';
import { productGalleryForSelection } from '../src/lib/productImage';
import { productImageForSelection } from '../worker/lib/productSelectionImage';
import type { ProductDoc } from '../worker/lib/productModel';
import type { ProductRelationsView } from '../worker/lib/productOverlay';

const media = (id: string, url: string, over: Record<string, unknown> = {}) => ({
  id,
  url,
  key: '',
  role: 'gallery' as const,
  alt_ar: '',
  alt_en: '',
  alt_ckb: '',
  order: 0,
  primary: false,
  width: null,
  height: null,
  source_url: '',
  option_value_id: '',
  color_id: '',
  variant_id: '',
  ...over,
});

const doc = {
  media: [
    media('main', '/main.webp', { primary: true, order: 0 }),
    media('option', '/option.webp', { option_value_id: 'large', order: 1 }),
    media('variant', '/variant.webp', { variant_id: 'v-large-red', order: 2 }),
    media('color', '/red.webp', { color_id: 'red', order: 3 }),
  ],
  colors: [{ id: 'red', image: '/legacy-red.webp' }],
  options: [{ id: 'large', image: '/legacy-large.webp' }],
} as unknown as ProductDoc;

const relations = {
  variants: [{ id: 'v-large-red', combo_key: 'o:large|c:red', active: 1 }],
} as unknown as ProductRelationsView;

test('selection image precedence is variant, color, option, then primary', () => {
  assert.equal(productImageForSelection(doc, { optionValueIds: ['large'], colorId: 'red' }, relations), '/variant.webp');

  const noVariantBinding = {
    ...doc,
    media: doc.media.filter((item) => item.variant_id !== 'v-large-red'),
  } as ProductDoc;
  assert.equal(productImageForSelection(noVariantBinding, { optionValueIds: ['large'], colorId: 'red' }, relations), '/red.webp');
  assert.equal(productImageForSelection(doc, { optionValueIds: ['large'], colorId: null }), '/option.webp');
  assert.equal(productImageForSelection(doc, { optionValueIds: [], colorId: null }), '/main.webp');
});

test('legacy option and color columns are not an authoritative image source', () => {
  const legacy = { ...doc, media: [media('main', '/main.webp', { primary: true })] } as ProductDoc;
  assert.equal(productImageForSelection(legacy, { optionValueIds: ['large'], colorId: 'red' }, relations), '/main.webp');
  assert.equal(productImageForSelection(legacy, { optionValueIds: ['large'], colorId: null }), '/main.webp');
});

test('variant lookup is canonical for multi-option selections', () => {
  const multi = {
    ...relations,
    variants: [{ id: 'v-multi', combo_key: 'o:large|o:wifi|c:red', active: 1 }],
  } as unknown as ProductRelationsView;
  const multiDoc = {
    ...doc,
    media: [...doc.media, media('multi', '/multi.webp', { variant_id: 'v-multi' })],
  } as ProductDoc;
  assert.equal(
    productImageForSelection(multiDoc, { optionValueIds: ['wifi', 'large'], colorId: 'red' }, multi),
    '/multi.webp'
  );
});

function storefrontImageForSelection(
  product: ProductDoc,
  selection: { optionValueIds: string[]; colorId: string | null },
  view?: ProductRelationsView | null
): string {
  // Mirrors Product.galleryOf: public media arrives primary-first, but cached
  // payloads are still normalised before the shared selection resolver runs.
  const base = product.media
    .filter((item) => !!item.url)
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      Number(!!b.item.primary) - Number(!!a.item.primary) ||
      a.item.order - b.item.order ||
      a.index - b.index
    )
    .map(({ item }) => item);
  const variantId = productVariantIdForSelection(view?.variants ?? [], selection);
  return productGalleryForSelection(base, product.media, { ...selection, variantId })[0]?.url ?? '';
}

test('storefront gallery lead and Worker snapshot have exhaustive selection parity', () => {
  const parityDoc = {
    ...doc,
    media: [
      media('unrelated', '/unrelated.webp', { option_value_id: 'other', order: 0 }),
      media('primary', '/primary.webp', { primary: true, order: 8 }),
      media('large', '/large.webp', { option_value_id: 'large', order: 4 }),
      media('wifi', '/wifi.webp', { option_value_id: 'wifi', order: 5 }),
      media('red', '/red.webp', { color_id: 'red', order: 6 }),
      media('exact', '/exact.webp', { variant_id: 'v-exact', order: 7 }),
    ],
  } as ProductDoc;
  const parityView = {
    ...relations,
    variants: [
      { id: 'v-disabled', combo_key: 'o:large|c:blue', active: 0 },
      { id: 'v-exact', combo_key: 'o:large|o:wifi|c:red', active: 1 },
    ],
  } as ProductRelationsView;

  const cases: Array<{
    name: string;
    selection: { optionValueIds: string[]; colorId: string | null };
    expected: string;
    view?: ProductRelationsView | null;
  }> = [
    {
      name: 'exact variant beats every broader binding',
      selection: { optionValueIds: ['wifi', 'large', 'wifi'], colorId: 'red' },
      expected: '/exact.webp',
      view: parityView,
    },
    {
      name: 'inactive exact variant is ignored and colour wins',
      selection: { optionValueIds: ['large'], colorId: 'blue' },
      expected: '/large.webp',
      view: parityView,
    },
    {
      name: 'colour beats selected options when no exact variant exists',
      selection: { optionValueIds: ['wifi', 'large'], colorId: 'red' },
      expected: '/red.webp',
      view: null,
    },
    {
      name: 'authoritative media order wins among selected options',
      selection: { optionValueIds: ['wifi', 'large'], colorId: null },
      expected: '/large.webp',
      view: parityView,
    },
    {
      name: 'primary is the fallback despite an earlier unrelated binding',
      selection: { optionValueIds: ['missing'], colorId: null },
      expected: '/primary.webp',
      view: parityView,
    },
    {
      name: 'no selection retains the authoritative primary-first base order',
      selection: { optionValueIds: [], colorId: null },
      expected: '/primary.webp',
      view: parityView,
    },
  ];

  for (const item of cases) {
    const worker = productImageForSelection(parityDoc, item.selection, item.view);
    const storefront = storefrontImageForSelection(parityDoc, item.selection, item.view);
    assert.equal(worker, item.expected, `${item.name}: Worker`);
    assert.equal(storefront, item.expected, `${item.name}: Storefront`);
    assert.equal(storefront, worker, `${item.name}: parity`);
  }
});

test('shared resolver is canonical, stable, and does not mutate caller media', () => {
  const input = [
    media('primary', '/primary.webp', { primary: true }),
    media('second-option', '/second.webp', { option_value_id: 'second' }),
    media('first-option', '/first.webp', { option_value_id: 'first' }),
  ];
  const before = input.map((item) => item.id);

  assert.equal(
    productSelectionComboKey({ optionValueIds: ['second', 'first', 'second'], colorId: 'red' }),
    'o:first|o:second|c:red'
  );
  assert.deepEqual(
    productMediaForSelection(input, { optionValueIds: ['first', 'second'], colorId: null }).map((item) => item.url),
    ['/second.webp', '/first.webp', '/primary.webp']
  );
  assert.deepEqual(
    productMediaForSelection(input, { optionValueIds: ['second', 'first'], colorId: null }).map((item) => item.url),
    ['/second.webp', '/first.webp', '/primary.webp'],
    'selection array order cannot override the authoritative gallery order'
  );
  assert.equal(
    productGalleryForSelection(input, [], {
      optionValueIds: ['second'],
      colorId: null,
      variantId: null,
    })[0]?.url,
    '/second.webp',
    'bindings carried by product_images work without any legacy image source'
  );
  assert.deepEqual(input.map((item) => item.id), before, 'input order is immutable');
});

test('both adapters delegate precedence to the shared resolver', () => {
  const frontend = readFileSync(new URL('../src/lib/productImage.ts', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../worker/lib/productSelectionImage.ts', import.meta.url), 'utf8');
  const pricing = readFileSync(new URL('../packages/pricing/src/productSelectionMedia.ts', import.meta.url), 'utf8');
  assert.match(frontend, /\.\.\/\.\.\/packages\/pricing\/src\/productSelectionMedia/);
  assert.match(frontend, /productMediaForSelection\(candidates,/);
  assert.match(worker, /@levonis\/pricing\/productSelectionMedia/);
  assert.match(worker, /resolveProductImageForSelection\(media,/);
  assert.match(pricing, /export function productMediaForSelection/);
});

test('cart and checkout snapshot the same authoritative selection image', () => {
  const cart = readFileSync(new URL('../worker/routes/cart.ts', import.meta.url), 'utf8');
  const orders = readFileSync(new URL('../worker/routes/orders.ts', import.meta.url), 'utf8');
  assert.match(cart, /image:\s*productImageForSelection\(doc,[\s\S]{0,180}optionValueIds:[\s\S]{0,180}colorId:/);
  assert.match(orders, /image:\s*productImageForSelection\(doc,[\s\S]{0,180}optionValueIds:[\s\S]{0,180}colorId:/);
  assert.match(orders, /INSERT INTO order_items[^`]*image_snapshot/);
  assert.match(orders, /image:\s*(?:k|it)\.image_snapshot/);
});
