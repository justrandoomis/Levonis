import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('selection image precedence is color, variant, option, then primary', () => {
  assert.equal(productImageForSelection(doc, { optionValueIds: ['large'], colorId: 'red' }, relations), '/red.webp');

  const noColorBinding = {
    ...doc,
    media: doc.media.filter((item) => item.color_id !== 'red'),
    colors: [{ id: 'red', image: '' }],
  } as ProductDoc;
  assert.equal(productImageForSelection(noColorBinding, { optionValueIds: ['large'], colorId: 'red' }, relations), '/variant.webp');
  assert.equal(productImageForSelection(doc, { optionValueIds: ['large'], colorId: null }), '/option.webp');
  assert.equal(productImageForSelection(doc, { optionValueIds: [], colorId: null }), '/main.webp');
});

test('legacy color and option images remain valid fallbacks', () => {
  const legacy = { ...doc, media: [media('main', '/main.webp', { primary: true })] } as ProductDoc;
  assert.equal(productImageForSelection(legacy, { optionValueIds: ['large'], colorId: 'red' }), '/legacy-red.webp');
  assert.equal(productImageForSelection(legacy, { optionValueIds: ['large'], colorId: null }), '/legacy-large.webp');
});

test('cart and checkout snapshot the same authoritative selection image', () => {
  const cart = readFileSync(new URL('../worker/routes/cart.ts', import.meta.url), 'utf8');
  const orders = readFileSync(new URL('../worker/routes/orders.ts', import.meta.url), 'utf8');
  assert.match(cart, /image:\s*productImageForSelection\(doc,[\s\S]{0,180}optionValueIds:[\s\S]{0,180}colorId:/);
  assert.match(orders, /image:\s*productImageForSelection\(doc,[\s\S]{0,180}optionValueIds:[\s\S]{0,180}colorId:/);
  assert.match(orders, /INSERT INTO order_items[^`]*image_snapshot/);
  assert.match(orders, /image:\s*(?:k|it)\.image_snapshot/);
});
