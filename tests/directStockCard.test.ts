/**
 * Direct-sale opening selection + card total.
 * Run: node --import tsx --test tests/directStockCard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_STOCK_SELECTION_EVALUATION_CAP,
  directStockAvailable,
  firstUsableDirectSelection,
  saleAvailability,
} from '../worker/routes/products';
import type { InventorySnapshot } from '../worker/lib/inventory';
import { applyRelations, snapshotFrom, type ProductRelationsView } from '../worker/lib/productOverlay';
import { validateSelection } from '../worker/lib/productRelations';

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
  media: [],
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

test('opening selection preserves one value from every active option group', () => {
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

  const initial = firstUsableDirectSelection(product as never, { inventory });
  assert.equal(initial?.option_id, 'model-a');
  assert.deepEqual(initial?.option_value_ids, ['model-a', 'size-small']);
  assert.equal(initial?.availability.mode, 'direct_sale');
  assert.equal(initial?.availability.stock.available, 5);
});

test('inactive option groups never block or enter the opening selection', () => {
  const product = doc({
    options: [
      { id: 'model-a', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      // applyRelations may still carry this active value while its parent
      // group is inactive; the detail route supplies the active group set.
      { id: 'archived-size', active: true, availability_type: '', fulfillments: [] },
    ],
  });
  const inventory = snapshot({
    group_ids: ['model', 'archived'],
    option_values: [
      { id: 'model-a', group_id: 'model', name_en: 'Model A', stock: 3, reserved: 0, low_stock_threshold: null },
      { id: 'archived-size', group_id: 'archived', name_en: 'Old size', stock: 0, reserved: 0, low_stock_threshold: null },
    ],
  });

  const initial = firstUsableDirectSelection(product as never, {
    inventory,
    activeGroupIds: new Set(['model']),
  });
  assert.deepEqual(initial?.option_value_ids, ['model-a']);
  assert.equal(initial?.availability.stock.available, 3);
});

test('variant opening selection restores group order instead of lexical id order', () => {
  const product = doc({
    options: [
      { id: 'z-model', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'a-size', active: true, availability_type: '', fulfillments: [] },
    ],
  });
  const inventory = snapshot({
    inventory_mode: 'VARIANT_COMBINATION',
    group_ids: ['model', 'size'],
    option_values: [
      { id: 'z-model', group_id: 'model', name_en: 'Model', stock: null, reserved: 0, low_stock_threshold: null },
      { id: 'a-size', group_id: 'size', name_en: 'Size', stock: null, reserved: 0, low_stock_threshold: null },
    ],
    variants: [
      { id: 'combo', combo_key: 'o:a-size|o:z-model', stock: 4, reserved: 1, low_stock_threshold: null, active: true },
    ],
  });

  const initial = firstUsableDirectSelection(product as never, { inventory });
  assert.equal(initial?.option_id, 'z-model');
  assert.deepEqual(initial?.option_value_ids, ['z-model', 'a-size']);
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

test('availability is incomplete when one active option group is missing', () => {
  const inventory = snapshot({
    group_ids: ['model', 'size'],
    option_values: [
      { id: 'model-a', group_id: 'model', name_en: 'Model', stock: 5, reserved: 0, low_stock_threshold: null },
      { id: 'size-s', group_id: 'size', name_en: 'Size', stock: 5, reserved: 0, low_stock_threshold: null },
    ],
  });
  const availability = saleAvailability(doc({
    options: [
      { id: 'model-a', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-s', active: true, availability_type: '', fulfillments: [] },
    ],
  }) as never, { optionValueIds: ['size-s'], inventory, preferredType: 'direct_sale' });

  assert.equal(availability.selection.complete, false);
  assert.ok(availability.selection.errors.includes('OPTION_GROUP_REQUIRED'));
});

test('availability rejects two values selected from the same group', () => {
  const inventory = snapshot({
    group_ids: ['model'],
    option_values: [
      { id: 'model-a', group_id: 'model', name_en: 'A', stock: 5, reserved: 0, low_stock_threshold: null },
      { id: 'model-b', group_id: 'model', name_en: 'B', stock: 5, reserved: 0, low_stock_threshold: null },
    ],
  });
  const availability = saleAvailability(doc({
    options: [
      { id: 'model-a', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'model-b', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
    ],
  }) as never, { optionValueIds: ['model-a', 'model-b'], inventory, preferredType: 'direct_sale' });

  assert.equal(availability.selection.complete, false);
  assert.ok(availability.selection.errors.includes('OPTION_GROUP_DUPLICATE_SELECTION'));
});

test('a neutral secondary value inherits direct, but an explicit legacy pre-order value blocks it', () => {
  const inventory = snapshot({
    group_ids: ['model', 'size'],
    option_values: [
      { id: 'model-direct', group_id: 'model', name_en: 'Direct', stock: 8, reserved: 0, low_stock_threshold: null },
      { id: 'size-neutral', group_id: 'size', name_en: 'Neutral', stock: null, reserved: 0, low_stock_threshold: null },
      { id: 'size-pre', group_id: 'size', name_en: 'Pre-order', stock: null, reserved: 0, low_stock_threshold: null },
    ],
  });
  const product = doc({
    // Deliberately stale product union: the selected model cell is the more
    // specific source of truth.
    selling_type: 'pre_order',
    sale_types: ['pre_order'],
    options: [
      { id: 'model-direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-neutral', active: true, availability_type: '', fulfillments: [] },
      { id: 'size-pre', active: true, availability_type: 'pre_order', fulfillments: [] },
    ],
  });

  const neutral = saleAvailability(product as never, {
    optionValueIds: ['model-direct', 'size-neutral'],
    inventory,
    preferredType: 'direct_sale',
  });
  const preOnly = saleAvailability(product as never, {
    optionValueIds: ['model-direct', 'size-pre'],
    inventory,
    preferredType: 'direct_sale',
  });

  assert.equal(neutral.mode, 'direct_sale');
  assert.equal(preOnly.modes.some((mode) => mode.type === 'direct_sale'), false);
});

test('legacy flat inventory with no group ids keeps its declared active option selectable', () => {
  const availability = saleAvailability(
    doc({
      options: [
        { id: 'legacy-model', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      ],
    }) as never,
    {
      optionId: 'legacy-model',
      inventory: snapshot({
        group_ids: [],
        option_values: [
          { id: 'legacy-model', group_id: 'legacy', name_en: 'Legacy', stock: 3, reserved: 0, low_stock_threshold: null },
        ],
      }),
      preferredType: 'direct_sale',
    }
  );

  assert.equal(availability.selection.complete, true);
  assert.equal(availability.mode, 'direct_sale');
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

test('card OPTION total lets a neutral secondary group inherit a selected direct model cell', () => {
  const product = doc({
    selling_type: 'pre_order',
    sale_types: ['pre_order'],
    options: [
      { id: 'model-direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-neutral', active: true, availability_type: '', fulfillments: [] },
    ],
  });
  const relations = view({
    inventory_mode: 'OPTION',
    groups: [
      { id: 'model', active: 1 },
      { id: 'size', active: 1 },
    ] as never,
    values: [
      { id: 'model-direct', group_id: 'model', active: 1, stock: 7, reserved: 1 },
      { id: 'size-neutral', group_id: 'size', active: 1, stock: 5, reserved: 1 },
    ] as never,
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 4);
});

test('card direct-selection proof is bounded on a 10×10×10×10 catalogue', () => {
  assert.ok(DIRECT_STOCK_SELECTION_EVALUATION_CAP > 0);
  assert.ok(DIRECT_STOCK_SELECTION_EVALUATION_CAP <= 1024);

  const groups = Array.from({ length: 4 }, (_, groupIndex) => ({
    id: `g${groupIndex}`,
    active: 1,
  }));
  const values = groups.flatMap((group, groupIndex) =>
    Array.from({ length: 10 }, (_, valueIndex) => ({
      id: `g${groupIndex}-v${valueIndex}`,
      group_id: group.id,
      name_en: `G${groupIndex} V${valueIndex}`,
      active: 1,
      stock: 1,
      reserved: 0,
    }))
  );
  const product = doc({
    options: values.map((value) => ({
      id: value.id,
      active: true,
      availability_type: '',
      fulfillments: [],
    })),
  });
  const relations = view({
    inventory_mode: 'OPTION',
    groups: groups as never,
    values: values as never,
  });

  // 10,000 possible combinations exist, but every forced row finds a witness
  // inside the shared capped proof budget. The card total remains exact.
  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 10);
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

test('card OPTION total is zero when an untracked required group is pre-order-only', () => {
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
      { id: 'size-preonly', group_id: 'size', active: 1, stock: null, reserved: 0 },
    ] as never,
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 0);
});

test('card COLOR total excludes a colour with no fully direct linked selection', () => {
  const product = doc({
    options: [
      { id: 'model-direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-preonly', active: true, availability_type: 'pre_order', fulfillments: [] },
    ],
    colors: [{ id: 'red', active: true, option_id: null }],
  });
  const relations = view({
    inventory_mode: 'COLOR',
    groups: [
      { id: 'model', active: 1 },
      { id: 'size', active: 1 },
    ] as never,
    values: [
      { id: 'model-direct', group_id: 'model', active: 1, stock: null, reserved: 0 },
      { id: 'size-preonly', group_id: 'size', active: 1, stock: null, reserved: 0 },
    ] as never,
    colors: [{ id: 'red', name_en: 'Red', active: 1, stock: 12, reserved: 2 }] as never,
    links: [
      { color_id: 'red', option_value_id: 'model-direct', group_id: 'model' },
      { color_id: 'red', option_value_id: 'size-preonly', group_id: 'size' },
    ],
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 0);
});

test('card COLOR total accepts a linked neutral value beside a direct model cell', () => {
  const product = doc({
    selling_type: 'pre_order',
    sale_types: ['pre_order'],
    options: [
      { id: 'model-direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-neutral', active: true, availability_type: '', fulfillments: [] },
    ],
    colors: [{ id: 'blue', active: true, option_id: null }],
  });
  const relations = view({
    inventory_mode: 'COLOR',
    groups: [
      { id: 'model', active: 1 },
      { id: 'size', active: 1 },
    ] as never,
    values: [
      { id: 'model-direct', group_id: 'model', active: 1, stock: null, reserved: 0 },
      { id: 'size-neutral', group_id: 'size', active: 1, stock: null, reserved: 0 },
    ] as never,
    colors: [{ id: 'blue', name_en: 'Blue', active: 1, stock: 10, reserved: 2 }] as never,
    links: [
      { color_id: 'blue', option_value_id: 'model-direct', group_id: 'model' },
      { color_id: 'blue', option_value_id: 'size-neutral', group_id: 'size' },
    ],
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 8);
});

test('a tuple with no visible linked colour remains a valid colourless direct selection', () => {
  const product = doc({
    options: [
      { id: 'model-a', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'model-b', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-s', active: true, availability_type: '', fulfillments: [] },
      { id: 'size-l', active: true, availability_type: '', fulfillments: [] },
    ],
    colors: [
      { id: 'red', active: true, option_id: null },
      { id: 'blue', active: true, option_id: null },
    ],
  });
  const relations = view({
    inventory_mode: 'OPTION',
    groups: [
      { id: 'model', active: 1 },
      { id: 'size', active: 1 },
    ] as never,
    values: [
      { id: 'model-a', group_id: 'model', name_en: 'A', active: 1, stock: 1, reserved: 0 },
      { id: 'model-b', group_id: 'model', name_en: 'B', active: 1, stock: 0, reserved: 0 },
      { id: 'size-s', group_id: 'size', name_en: 'S', active: 1, stock: 1, reserved: 0 },
      { id: 'size-l', group_id: 'size', name_en: 'L', active: 1, stock: 0, reserved: 0 },
    ] as never,
    colors: [
      { id: 'red', name_en: 'Red', active: 1, stock: null, reserved: 0 },
      { id: 'blue', name_en: 'Blue', active: 1, stock: null, reserved: 0 },
    ] as never,
    links: [
      { color_id: 'red', option_value_id: 'model-a', group_id: 'model' },
      { color_id: 'red', option_value_id: 'size-l', group_id: 'size' },
      { color_id: 'blue', option_value_id: 'model-b', group_id: 'model' },
      { color_id: 'blue', option_value_id: 'size-s', group_id: 'size' },
    ],
  });
  const inventory = snapshotFrom(relations, {
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  });

  const withoutColor = saleAvailability(product as never, {
    optionValueIds: ['model-a', 'size-s'],
    inventory,
    links: relations.links,
    preferredType: 'direct_sale',
  });
  const withWrongColor = saleAvailability(product as never, {
    optionValueIds: ['model-a', 'size-s'],
    colorId: 'red',
    inventory,
    links: relations.links,
    preferredType: 'direct_sale',
  });

  const relationErrors = validateSelection({
    groups: relations.groups,
    values: relations.values,
    colors: relations.colors,
    links: relations.links,
    selectedValueIds: ['model-a', 'size-s'],
    selectedColorId: null,
  });
  const initial = firstUsableDirectSelection(product as never, { inventory, links: relations.links });

  assert.equal(withoutColor.selection.complete, true);
  assert.equal(withoutColor.selection.errors.includes('COLOR_REQUIRED'), false);
  assert.equal(relationErrors.includes('COLOR_REQUIRED'), false);
  assert.ok(withWrongColor.selection.errors.includes('COLOR_OPTION_MISMATCH'));
  assert.deepEqual(initial?.option_value_ids, ['model-a', 'size-s']);
  assert.equal(initial?.color_id, null);
  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 1);
});

test('mixed products require colour for a linked model and allow null for a colourless model', () => {
  const product = doc({
    options: [
      { id: 'model-a', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'model-b', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
    ],
    colors: [{ id: 'red', active: true, option_id: 'model-a' }],
  });
  const relations = view({
    inventory_mode: 'OPTION',
    groups: [{ id: 'model', active: 1 }] as never,
    values: [
      { id: 'model-a', group_id: 'model', name_en: 'A', active: 1, stock: 1, reserved: 0 },
      { id: 'model-b', group_id: 'model', name_en: 'B', active: 1, stock: 1, reserved: 0 },
    ] as never,
    colors: [{ id: 'red', name_en: 'Red', active: 1, stock: null, reserved: 0 }] as never,
    links: [{ color_id: 'red', option_value_id: 'model-a', group_id: 'model' }],
  });
  const inventory = snapshotFrom(relations, {
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  });

  const modelAWithoutColor = saleAvailability(product as never, {
    optionId: 'model-a',
    inventory,
    links: relations.links,
    preferredType: 'direct_sale',
  });
  const modelAWithColor = saleAvailability(product as never, {
    optionId: 'model-a',
    colorId: 'red',
    inventory,
    links: relations.links,
    preferredType: 'direct_sale',
  });
  const modelBWithoutColor = saleAvailability(product as never, {
    optionId: 'model-b',
    inventory,
    links: relations.links,
    preferredType: 'direct_sale',
  });
  const modelARelationErrors = validateSelection({
    groups: relations.groups,
    values: relations.values,
    colors: relations.colors,
    links: relations.links,
    selectedValueIds: ['model-a'],
    selectedColorId: null,
  });
  const modelBRelationErrors = validateSelection({
    groups: relations.groups,
    values: relations.values,
    colors: relations.colors,
    links: relations.links,
    selectedValueIds: ['model-b'],
    selectedColorId: null,
  });

  assert.ok(modelAWithoutColor.selection.errors.includes('COLOR_REQUIRED'));
  assert.ok(modelARelationErrors.includes('COLOR_REQUIRED'));
  assert.equal(modelAWithColor.selection.complete, true);
  assert.equal(modelBWithoutColor.selection.complete, true);
  assert.equal(modelBRelationErrors.includes('COLOR_REQUIRED'), false);
  assert.equal(modelBWithoutColor.selection.color_id, null);
  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 2);
});

test('card BASE stock is hidden when no complete direct option selection exists', () => {
  const product = doc({
    options: [
      { id: 'model-direct', active: true, availability_type: '', fulfillments: [cell('direct_sale')] },
      { id: 'size-preonly', active: true, availability_type: 'pre_order', fulfillments: [] },
    ],
  });
  const relations = view({
    inventory_mode: 'BASE',
    groups: [
      { id: 'model', active: 1 },
      { id: 'size', active: 1 },
    ] as never,
    values: [
      { id: 'model-direct', group_id: 'model', active: 1, stock: null, reserved: 0 },
      { id: 'size-preonly', group_id: 'size', active: 1, stock: null, reserved: 0 },
    ] as never,
  });

  assert.equal(directStockAvailable(product as never, relations, { stock: 9, reserved: 1 }), 0);
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
      // Boolean false is inactive too, and must not reserve this normalized
      // key ahead of the active row below.
      { id: 'v0', active: false, combo_key: 'o:model-direct|o:size-small|c:c1', stock: 99, reserved: 0 },
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

test('an inactive relational group never reopens its active value as a legacy option', () => {
  const product = doc({
    options: [{
      id: 'archived-model',
      active: true,
      availability_type: '',
      fulfillments: [cell('direct_sale')],
    }],
  });
  const relations = view({
    inventory_mode: 'OPTION',
    groups: [{ id: 'archived', name_en: 'Archived', active: 0, sort: 0 }] as never,
    values: [{
      id: 'archived-model',
      group_id: 'archived',
      name_en: 'Archived model',
      availability_type: 'direct_sale',
      active: 1,
      sort: 0,
      stock: 5,
      reserved: 0,
      low_stock_threshold: null,
    }] as never,
  });
  const inventory = snapshotFrom(relations, {
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  });

  assert.equal(inventory.has_group_rows, true);
  assert.deepEqual(inventory.group_ids, []);
  assert.deepEqual(applyRelations(product as never, relations).options, []);
  assert.equal(firstUsableDirectSelection(product as never, { inventory }), null);
  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 0);

  const quoted = saleAvailability(product as never, {
    optionValueIds: ['archived-model'],
    inventory,
    preferredType: 'direct_sale',
  });
  assert.equal(quoted.selection.complete, false);
  assert.ok(quoted.selection.errors.includes('OPTION_INACTIVE'));

  const validationErrors = validateSelection({
    groups: relations.groups,
    values: relations.values,
    colors: [],
    links: [],
    selectedValueIds: ['archived-model'],
    selectedColorId: null,
  });
  assert.ok(validationErrors.includes('OPTION_VALUE_INACTIVE'));
});

test('inactive-group fulfilment cells do not leak into the product mode union or routes', () => {
  const hiddenDirect = doc({
    selling_type: 'pre_order',
    sale_types: ['pre_order'],
    options: [{
      id: 'hidden-direct',
      active: true,
      availability_type: '',
      fulfillments: [cell('direct_sale')],
    }],
  });
  const inventory = snapshot({
    has_group_rows: true,
    group_ids: [],
    option_values: [{
      id: 'hidden-direct',
      group_id: 'archived',
      name_en: 'Hidden direct',
      stock: 4,
      reserved: 0,
      low_stock_threshold: null,
    }],
  });

  const availability = saleAvailability(hiddenDirect as never, { inventory });
  assert.equal(availability.modes.some((mode) => mode.type === 'direct_sale'), false);
  assert.deepEqual(availability.preorder.transports, []);
});

test('untracked OPTION and COLOR answers retain their authoritative stock scope', () => {
  const optionAvailability = saleAvailability(
    doc({
      options: [{ id: 'model', active: true, availability_type: '', fulfillments: [cell('direct_sale')] }],
    }) as never,
    {
      optionId: 'model',
      inventory: snapshot({
        inventory_mode: 'OPTION',
        option_values: [{
          id: 'model',
          group_id: 'model',
          name_en: 'Model',
          stock: null,
          reserved: 0,
          low_stock_threshold: null,
        }],
      }),
    }
  );
  const colorAvailability = saleAvailability(
    doc({ colors: [{ id: 'red', active: true, option_id: null }] }) as never,
    {
      colorId: 'red',
      inventory: snapshot({
        inventory_mode: 'COLOR',
        group_ids: [],
        colors: [{
          id: 'red',
          name_en: 'Red',
          stock: null,
          reserved: 0,
          low_stock_threshold: null,
        }],
      }),
    }
  );

  assert.equal(optionAvailability.stock.scope, 'option');
  assert.equal(colorAvailability.stock.scope, 'color');
});

test('opening direct selection prunes pre-order-only Cartesian prefixes and matches the card witness', () => {
  const groups = Array.from({ length: 4 }, (_, groupIndex) => ({
    id: `group-${groupIndex}`,
    name_en: `Group ${groupIndex}`,
    active: 1,
    sort: groupIndex,
  }));
  const values = groups.flatMap((group, groupIndex) =>
    Array.from({ length: 10 }, (_, valueIndex) => ({
      id: `g${groupIndex}-v${valueIndex}`,
      group_id: group.id,
      name_en: `G${groupIndex} V${valueIndex}`,
      active: 1,
      sort: valueIndex,
      stock: 1,
      reserved: 0,
      low_stock_threshold: null,
    }))
  );
  const product = doc({
    options: values.map((value) => ({
      id: value.id,
      active: true,
      availability_type: '',
      fulfillments: [cell(value.id.endsWith('-v9') ? 'direct_sale' : 'pre_order')],
    })),
  });
  const relations = view({
    inventory_mode: 'OPTION',
    groups: groups as never,
    values: values as never,
  });
  const inventory = snapshotFrom(relations, {
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  });

  const cardStock = directStockAvailable(product as never, relations, { stock: null, reserved: 0 });
  const initial = firstUsableDirectSelection(product as never, { inventory });

  assert.equal(cardStock, 1);
  assert.deepEqual(initial?.option_value_ids, ['g0-v9', 'g1-v9', 'g2-v9', 'g3-v9']);
  assert.equal(initial?.availability.stock.available, 1);
});

test('large unsellable variant catalogues are bounded and do not perform repeated full-table lookups', () => {
  const groups = [
    { id: 'model', name_en: 'Model', active: 1, sort: 0 },
    { id: 'size', name_en: 'Size', active: 1, sort: 1 },
  ];
  const models = Array.from({ length: 100 }, (_, index) => ({
    id: `model-${index}`,
    group_id: 'model',
    name_en: `Model ${index}`,
    active: 1,
    sort: index,
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  }));
  const sizes = Array.from({ length: 100 }, (_, index) => ({
    id: `size-${index}`,
    group_id: 'size',
    name_en: `Size ${index}`,
    active: 1,
    sort: index,
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  }));
  const values = [...models, ...sizes];
  const variants = models.flatMap((model, modelIndex) =>
    sizes.map((size, sizeIndex) => ({
      id: `variant-${modelIndex}-${sizeIndex}`,
      combo_key: `o:${model.id}|o:${size.id}`,
      active: 1,
      stock: 0,
      reserved: 0,
      low_stock_threshold: null,
    }))
  );
  const product = doc({
    options: values.map((value) => ({
      id: value.id,
      active: true,
      availability_type: '',
      fulfillments: [cell('direct_sale')],
    })),
  });
  const relations = view({
    inventory_mode: 'VARIANT_COMBINATION',
    groups: groups as never,
    values: values as never,
    variants: variants as never,
  });
  const inventory = snapshotFrom(relations, {
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  });

  assert.equal(variants.length, 10_000);
  assert.equal(directStockAvailable(product as never, relations, { stock: null, reserved: 0 }), 0);
  assert.equal(firstUsableDirectSelection(product as never, { inventory }), null);
});

test('sold-out variants do not consume the opening-search budget before a stocked witness', () => {
  const values = Array.from({ length: 4_097 }, (_, index) => ({
    id: `model-${index}`,
    group_id: 'model',
    name_en: `Model ${index}`,
    active: 1,
    sort: index,
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  }));
  const product = doc({
    options: values.map((value) => ({
      id: value.id,
      active: true,
      availability_type: '',
      fulfillments: [cell('direct_sale')],
    })),
  });
  const variants = values.map((value, index) => ({
    id: `variant-${index}`,
    combo_key: `o:${value.id}`,
    active: 1,
    stock: index === values.length - 1 ? 1 : 0,
    reserved: 0,
    low_stock_threshold: null,
  }));
  const relations = view({
    inventory_mode: 'VARIANT_COMBINATION',
    groups: [{ id: 'model', name_en: 'Model', active: 1, sort: 0 }] as never,
    values: values as never,
    variants: variants as never,
  });
  const inventory = snapshotFrom(relations, {
    stock: null,
    reserved: 0,
    low_stock_threshold: null,
  });

  const cardStock = directStockAvailable(product as never, relations, { stock: null, reserved: 0 });
  const initial = firstUsableDirectSelection(product as never, { inventory });

  assert.equal(cardStock, 1);
  assert.deepEqual(initial?.option_value_ids, ['model-4096']);
  assert.equal(initial?.availability.stock.available, 1);
});
