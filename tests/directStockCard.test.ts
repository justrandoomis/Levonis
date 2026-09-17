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
  assert.deepEqual(initial?.option_value_ids, ['stocked']);
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
  assert.deepEqual(initial?.option_value_ids, ['spool']);
  assert.equal(initial?.color_id, 'white');
  assert.equal(initial?.availability.stock.available, 3);
});

test('opening selection fails closed when more than one active option group is required', () => {
  const product = doc({
    options: [
      { id: 'model-a', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-small', active: true, availability_type: '', fulfillments: [] },
    ],
  });
  const inventory = snapshot({
    group_ids: ['model', 'size'],
    option_values: [
      { id: 'model-a', group_id: 'model', name_en: 'Model A', stock: 5, reserved: 0, low_stock_threshold: null },
      { id: 'size-small', group_id: 'size', name_en: 'Small', stock: 5, reserved: 0, low_stock_threshold: null },
    ],
  });

  // The current detail/cart identity can preserve only one option id, so it
  // must not silently auto-select a second hidden group value.
  assert.equal(firstUsableDirectSelection(product as never, { inventory }), null);
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

test('all selected explicit fulfilment cells must allow direct sale', () => {
  const availability = saleAvailability(
    doc({
      options: [
        { id: 'direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
        { id: 'preonly', active: true, availability_type: '', fulfillments: [cell('pre_order')] },
      ],
    }) as never,
    {
      optionValueIds: ['direct', 'preonly'],
      inventory: snapshot({
        group_ids: ['model', 'size'],
        option_values: [
          { id: 'direct', group_id: 'model', name_en: 'Direct', stock: 8, reserved: 0, low_stock_threshold: null },
          { id: 'preonly', group_id: 'size', name_en: 'Pre-order', stock: 8, reserved: 0, low_stock_threshold: null },
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

test('card OPTION total sums within tracked groups and takes the cross-group minimum', () => {
  const product = doc({
    options: [
      { id: 'm1', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'm2', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 's1', active: true, availability_type: '', fulfillments: [] },
      { id: 's2', active: true, availability_type: '', fulfillments: [] },
    ],
  });
  const relations = view({
    inventory_mode: 'OPTION',
    groups: [
      { id: 'model', active: 1 },
      { id: 'size', active: 1 },
    ] as never,
    values: [
      { id: 'm1', group_id: 'model', active: 1, stock: 10, reserved: 2 },
      { id: 'm2', group_id: 'model', active: 1, stock: 5, reserved: 0 },
      { id: 's1', group_id: 'size', active: 1, stock: 6, reserved: 1 },
      { id: 's2', group_id: 'size', active: 1, stock: 4, reserved: 0 },
    ] as never,
  });

  // model = 13, size = 9; every sale consumes one from both, so 9 not 22.
  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 9);
});

test('card OPTION total is zero when a tracked required group has no direct-sale value', () => {
  const product = doc({
    options: [
      { id: 'model-direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-preonly', active: true, availability_type: 'pre_order', fulfillments: [] },
    ],
  });
  const relations = view({
    inventory_mode: 'OPTION',
    groups: [
      { id: 'model', active: 1 },
      { id: 'size', active: 1 },
    ] as never,
    values: [
      { id: 'model-direct', group_id: 'model', active: 1, stock: 5, reserved: 0 },
      { id: 'size-preonly', group_id: 'size', active: 1, stock: 20, reserved: 0 },
    ] as never,
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 0);
});

test('card VARIANT total counts only complete active selectable direct combinations', () => {
  const product = doc({
    options: [
      { id: 'model-direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'model-pre', active: true, availability_type: '', fulfillments: [cell('pre_order')] },
      { id: 'size-small', active: true, availability_type: '', fulfillments: [] },
      { id: 'size-large', active: true, availability_type: '', fulfillments: [] },
      { id: 'size-prelegacy', active: true, availability_type: 'pre_order', fulfillments: [] },
    ],
    colors: [
      { id: 'c1', active: true, option_id: null },
      { id: 'c2', active: false, option_id: null },
    ],
  });
  const relations = view({
    inventory_mode: 'VARIANT_COMBINATION',
    groups: [
      { id: 'model', active: 1 },
      { id: 'size', active: 1 },
    ] as never,
    values: [
      { id: 'model-direct', group_id: 'model', name_en: 'Direct', active: 1, stock: null, reserved: 0 },
      { id: 'model-pre', group_id: 'model', name_en: 'Pre', active: 1, stock: null, reserved: 0 },
      { id: 'size-small', group_id: 'size', name_en: 'Small', active: 1, stock: null, reserved: 0 },
      { id: 'size-large', group_id: 'size', name_en: 'Large', active: 1, stock: null, reserved: 0 },
      { id: 'size-prelegacy', group_id: 'size', name_en: 'Legacy pre-order', active: 1, stock: null, reserved: 0 },
    ] as never,
    colors: [
      { id: 'c1', name_en: 'Active', active: 1, stock: null, reserved: 0 },
      { id: 'c2', name_en: 'Inactive', active: 0, stock: null, reserved: 0 },
    ] as never,
    variants: [
      { id: 'v1', active: 1, combo_key: 'o:model-direct|o:size-small|c:c1', stock: 5, reserved: 1 },
      { id: 'v2', active: 1, combo_key: 'o:model-direct|o:size-large|c:c1', stock: 4, reserved: 1 },
      // Missing the size group.
      { id: 'v3', active: 1, combo_key: 'o:model-direct|c:c1', stock: 99, reserved: 0 },
      // Colour is inactive.
      { id: 'v4', active: 1, combo_key: 'o:model-direct|o:size-small|c:c2', stock: 99, reserved: 0 },
      // An explicitly pre-order-only selected cell blocks direct sale.
      { id: 'v5', active: 1, combo_key: 'o:model-pre|o:size-small|c:c1', stock: 99, reserved: 0 },
      // A legacy pre-order-only value also blocks direct sale when another
      // selected group uses modern fulfilment cells.
      { id: 'v7', active: 1, combo_key: 'o:model-direct|o:size-prelegacy|c:c1', stock: 99, reserved: 0 },
      { id: 'v6', active: 0, combo_key: 'o:model-direct|o:size-small|c:c1', stock: 99, reserved: 0 },
    ] as never,
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 7);
  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }, true), null);
});
