/**
 * Direct-sale opening selection + card total.
 * Run: node --import tsx --test tests/directStockCard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  directStockAvailable,
  firstUsableDirectSelection,
  saleAvailability,
} from '../worker/routes/products';
import type { InventorySnapshot } from '../worker/lib/inventory';
import type { ProductRelationsView } from '../worker/lib/productOverlay';

const cell = (type: 'direct_sale' | 'pre_order', enabled = true) => ({
  fulfillment_type: type,
  enabled,
  transports: [],
});

const doc = (over: Record<string, unknown> = {}) => ({
  selling_type: 'direct_sale',
  sale_types: ['direct_sale', 'pre_order'],
  stock: null,
  composition: '',
  options: [],
  colors: [],
  preorder_transports: [],
  ...over,
});

const snapshot = (over: Partial<InventorySnapshot>): InventorySnapshot => ({
  inventory_mode: 'OPTION',
  base: { stock: null, reserved: 0, low_stock_threshold: null },
  option_values: [],
  colors: [],
  variants: [],
  group_ids: ['model'],
  ...over,
});

const view = (over: Partial<ProductRelationsView>): ProductRelationsView => ({
  has_relations: true,
  inventory_mode: 'OPTION',
  groups: [],
  values: [],
  colors: [],
  links: [],
  variants: [],
  images: [],
  fulfillments: [],
  transports: [],
  ...over,
});

test('opening selection skips an empty direct model and chooses the first stocked one', () => {
  const product = doc({
    options: [
      { id: 'empty', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'stocked', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
    ],
  });
  const inventory = snapshot({
    option_values: [
      { id: 'empty', group_id: 'model', name_en: 'Empty', stock: 0, reserved: 0, low_stock_threshold: null },
      { id: 'stocked', group_id: 'model', name_en: 'Stocked', stock: 5, reserved: 2, low_stock_threshold: null },
    ],
  });

  const initial = firstUsableDirectSelection(product as never, { inventory });
  assert.equal(initial?.option_id, 'stocked');
  assert.equal(initial?.color_id, null);
  assert.equal(initial?.availability.mode, 'direct_sale');
  assert.equal(initial?.availability.stock.available, 3);
});

test('opening selection resolves the first stocked option-colour combination', () => {
  const product = doc({
    options: [{ id: 'spool', active: true, availability_type: '', fulfillments: [cell('direct_sale')] }],
    colors: [
      { id: 'black', active: true, option_id: null },
      { id: 'white', active: true, option_id: null },
    ],
  });
  const links = [
    { color_id: 'black', option_value_id: 'spool', group_id: 'model' },
    { color_id: 'white', option_value_id: 'spool', group_id: 'model' },
  ];
  const inventory = snapshot({
    inventory_mode: 'VARIANT_COMBINATION',
    option_values: [
      { id: 'spool', group_id: 'model', name_en: 'Spool', stock: null, reserved: 0, low_stock_threshold: null },
    ],
    colors: [
      { id: 'black', name_en: 'Black', stock: null, reserved: 0, low_stock_threshold: null },
      { id: 'white', name_en: 'White', stock: null, reserved: 0, low_stock_threshold: null },
    ],
    variants: [
      { id: 'v1', combo_key: 'o:spool|c:black', stock: 0, reserved: 0, low_stock_threshold: null, active: true },
      { id: 'v2', combo_key: 'o:spool|c:white', stock: 4, reserved: 1, low_stock_threshold: null, active: true },
    ],
  });

  const initial = firstUsableDirectSelection(product as never, { inventory, links });
  assert.equal(initial?.option_id, 'spool');
  assert.equal(initial?.color_id, 'white');
  assert.equal(initial?.availability.stock.available, 3);
});

test('a selected model with an explicit disabled direct cell does not inherit the product union', () => {
  const availability = saleAvailability(
    doc({
      options: [{
        id: 'preonly',
        active: true,
        availability_type: '',
        fulfillments: [cell('direct_sale', false), cell('pre_order')],
      }],
    }) as never,
    {
      optionId: 'preonly',
      inventory: snapshot({
        option_values: [
          { id: 'preonly', group_id: 'model', name_en: 'Pre-order', stock: 8, reserved: 0, low_stock_threshold: null },
        ],
      }),
    }
  );

  assert.equal(availability.modes.some((m) => m.type === 'direct_sale'), false);
});

test('card OPTION total subtracts reservations and excludes pre-order-only models', () => {
  const product = doc({
    options: [
      { id: 'direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'pre', active: true, availability_type: '', fulfillments: [cell('pre_order')] },
    ],
  });
  const relations = view({
    inventory_mode: 'OPTION',
    values: [
      { id: 'direct', active: 1, stock: 10, reserved: 2 },
      { id: 'pre', active: 1, stock: 50, reserved: 0 },
      { id: 'inactive', active: 0, stock: 50, reserved: 0 },
    ] as never,
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 8);
});

test('card VARIANT total counts every eligible combination once with exact option tokens', () => {
  const product = doc({
    options: [
      { id: 'o1', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'o2', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
    ],
  });
  const relations = view({
    inventory_mode: 'VARIANT_COMBINATION',
    variants: [
      { id: 'v1', active: 1, combo_key: 'o:o1|c:c1', stock: 5, reserved: 1 },
      // Contains two direct ids but is one shelf row: count it once.
      { id: 'v2', active: 1, combo_key: 'o:o1|o:o2|c:c2', stock: 4, reserved: 1 },
      // `o:o10` must not match `o:o1` by substring.
      { id: 'v3', active: 1, combo_key: 'o:o10|c:c3', stock: 99, reserved: 0 },
      { id: 'v4', active: 0, combo_key: 'o:o1|c:c4', stock: 99, reserved: 0 },
    ] as never,
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 7);
  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }, true), null);
});
