import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOrderCostSelection } from '../worker/lib/inventorySelection';

const product = { id: 'petg', inventory_mode: 'VARIANT_COMBINATION', product_cost_iqd: null };
const groups = [{ id: 'type', product_id: 'petg', active: 1, sort: 0 }];
const options = [
  { id: 'refill', product_id: 'petg', group_id: 'type', active: 1, cost_iqd: 10000, sort: 0 },
  { id: 'spool', product_id: 'petg', group_id: 'type', active: 1, cost_iqd: 12500, sort: 1 },
];
const colors = [{ id: 'black', product_id: 'petg', active: 1, cost_iqd: null, sort: 0 }];
const variants = [
  { id: 'refill-black', product_id: 'petg', active: 1, combo_key: 'o:refill|c:black', stock: 0, cost_iqd: null },
  { id: 'spool-black', product_id: 'petg', active: 1, combo_key: 'o:spool|c:black', stock: 2, cost_iqd: null },
];
const rows = { groups, options, colors, variants, fulfillments: [], links: [] };

test('main-store selector identity resolves the exact option and colour with no variant_id and no stock requirement', () => {
  const refill = matchOrderCostSelection(product, { option_value_ids: '["refill"]', option_id: 'refill', color_id: 'black' }, rows);
  assert.deepEqual(refill, { product_id: 'petg', scope: 'variant', scope_id: 'refill-black', unit_cost_iqd: 10000 });
  const spool = matchOrderCostSelection(product, { option_value_ids: ['spool'], color_id: 'black' }, rows);
  assert.equal(spool?.unit_cost_iqd, 12500);
  assert.equal(matchOrderCostSelection(product, { option_value_ids: ['refill'], color_id: 'black', variant_id: 'spool-black' }, rows)?.unit_cost_iqd, 10000);
  assert.equal(matchOrderCostSelection(product, { option_id: 'refill', color_id: 'black' }, rows)?.scope_id, 'refill-black');
});

test('unknown, missing, inactive, duplicate and ambiguous selectors never fall back to a different combination', () => {
  for (const line of [
    { option_value_ids: '[broken', color_id: 'black' },
    { option_value_ids: ['refill'], color_id: 'foreign' },
    { option_value_ids: ['foreign'], color_id: 'black' },
    { option_value_ids: ['refill'] },
    { option_value_ids: ['refill', 'spool'], color_id: 'black' },
    { option_value_ids: [], color_id: 'black' },
  ]) assert.equal(matchOrderCostSelection(product, line, rows), null, JSON.stringify(line));
  const line = { option_value_ids: ['refill'], color_id: 'black' };
  assert.equal(matchOrderCostSelection(product, line, { ...rows, variants: [variants[1]] }), null);
  assert.equal(matchOrderCostSelection(product, line, { ...rows, variants: [...variants, { ...variants[0], id: 'ambiguous' }] }), null);
  assert.equal(matchOrderCostSelection(product, line, { ...rows, options: options.map(option => ({ ...option, active: 0 })) }), null);
  assert.equal(matchOrderCostSelection(product, line, { ...rows, options: options.map(option => ({ ...option, product_id: 'different' })) }), null);
});

test('option-only and color-only stock selections use the same inherited cost ladder and keep a real zero', () => {
  assert.equal(matchOrderCostSelection({ ...product, inventory_mode: 'OPTION' }, { option_value_ids: ['refill'] }, { ...rows, colors: [] })?.unit_cost_iqd, 10000);
  assert.equal(matchOrderCostSelection({ ...product, inventory_mode: 'COLOR', product_cost_iqd: 8000 }, { color_id: 'black' }, { ...rows, groups: [], options: [], colors: [{ ...colors[0], cost_adjust_iqd: 2000 }] })?.unit_cost_iqd, 10000);
  const zero = matchOrderCostSelection(product, { option_value_ids: ['refill'], color_id: 'black' }, { ...rows, variants: [{ ...variants[0], cost_iqd: 0 }] });
  assert.equal(zero?.unit_cost_iqd, 0);
  const unknown = matchOrderCostSelection(product, { option_value_ids: ['refill'], color_id: 'black' }, { ...rows, options: options.map(option => ({ ...option, cost_iqd: null })) });
  assert.equal(unknown?.unit_cost_iqd, null);
});

test('colour and fulfillment cost overrides apply with option-mode stock without changing the stock identity', () => {
  const selected = matchOrderCostSelection({ ...product, inventory_mode: 'OPTION' }, { option_value_ids: ['refill'], color_id: 'black', order_shipping_type: 'direct' }, {
    ...rows,
    fulfillments: [{ option_id: 'refill', fulfillment_type: 'direct_sale', enabled: 1, cost_iqd: 11000 }],
    colors: [{ ...colors[0], cost_adjust_iqd: 500 }],
  });
  assert.deepEqual(selected, { product_id: 'petg', scope: 'option', scope_id: 'refill', unit_cost_iqd: 11500 });
});

test('saved prepaid/preorder and COD pricing choose their exact fulfillment cost, while ambiguous history stays unknown', () => {
  const cells = [
    { id: 'direct', option_id: 'refill', fulfillment_type: 'direct_sale', enabled: 1, cost_iqd: 11000 },
    { id: 'preorder', option_id: 'refill', fulfillment_type: 'pre_order', enabled: 1, cost_iqd: 8000 },
  ];
  const line = { option_value_ids: ['refill'], color_id: 'black', order_shipping_type: 'preorder_air' };
  const relation = { ...rows, fulfillments: cells, transports: [{ fulfillment_id: 'preorder', enabled: 1, method: 'air', cost_adjust_iqd: 500 }] };
  assert.equal(matchOrderCostSelection(product, { ...line, pricing_snapshot: JSON.stringify({ pricing_basis: 'preorder', fulfillment: { type: 'pre_order' } }), transport_snapshot: '{"method":"air"}' }, relation)?.unit_cost_iqd, 8500);
  assert.equal(matchOrderCostSelection(product, { ...line, pricing_snapshot: JSON.stringify({ pricing_basis: 'direct', fulfillment: { type: 'pre_order' } }) }, relation)?.unit_cost_iqd, 11000);
  assert.equal(matchOrderCostSelection(product, line, relation), null);
});
