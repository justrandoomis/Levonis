import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySupplierOrderNumber, copyPurchaseUnits, pendingPurchaseUnits, purchaseReceiptDraft, purchaseReceiptValid,
  purchaseUnitRows, purchaseUnitsValid, purchaseUnitsWire, type PurchaseUnitOrigin,
} from '../src/components/adminOperations/procurementUnitOrigins';
import { changeLineCostProfile, selectionCostDraft } from '../src/components/adminOperations/procurementCostDraft';
import type { Selection } from '../src/components/adminOperations/shared';

const origins: PurchaseUnitOrigin[] = [
  { unit_index: 1, id: 'unit-1', supplier_order_no: '000123', tracking_no: '00000789', received_lot_id: 'lot-old', received_at: '2026-10-11' },
  { unit_index: 2, id: 'unit-2', supplier_order_no: '000124', tracking_no: '' },
  { unit_index: 3, id: 'unit-3', supplier_order_no: 'EU-00125', tracking_no: 'TRACK-03' },
];

test('supplier references preserve leading zeros and wire allowlists omit receipt identities', () => {
  assert.deepEqual(purchaseUnitsWire(origins, 2), [
    { unit_index: 1, supplier_order_no: '000123', tracking_no: '00000789' },
    { unit_index: 2, supplier_order_no: '000124', tracking_no: '' },
  ]);
  assert.equal(purchaseUnitsValid(origins, 2), true, 'pending tracking remains valid');
});

test('one supplier order fills multiple units while preserving individual tracking and mixed order refs by default', () => {
  const mixed = [origins[0], { ...origins[1], supplier_order_no: '  ', tracking_no: '00000999' }, origins[2]];
  const filled = applySupplierOrderNumber(mixed, 5, '  000777  ');
  assert.deepEqual(filled.map((row) => row.supplier_order_no), ['000123', '000777', 'EU-00125', '000777', '000777']);
  assert.deepEqual(filled.slice(0, 3).map((row) => row.tracking_no), ['00000789', '00000999', 'TRACK-03']);
  assert.equal(filled[0].received_lot_id, 'lot-old');
  assert.equal(filled[1].id, 'unit-2');
  assert.equal(purchaseUnitsValid(filled, 5), true);
  assert.equal(mixed[1].supplier_order_no, '  ', 'draft action does not mutate its input');
  const replaced = applySupplierOrderNumber(filled, 5, '000888', true);
  assert.deepEqual(replaced.map((row) => row.supplier_order_no), Array(5).fill('000888'));
  assert.deepEqual(replaced.map((row) => row.tracking_no), filled.map((row) => row.tracking_no));
  assert.equal(replaced[0].received_lot_id, 'lot-old');
  assert.deepEqual(applySupplierOrderNumber(mixed, 2, '000888', true)[2], mixed[2], 'temporarily hidden quantity rows are not overwritten');
  assert.deepEqual(applySupplierOrderNumber(mixed, 5, '  ', true), mixed, 'empty bulk reference cannot erase valid order refs');
});

test('draft device serial follows its exact unit into confirmation without leaking stored bindings or copying them to a new purchase', () => {
  const pieces = [
    { ...origins[0], serial_no: '  000ABC123456  ', serial_norm: 'OLD123456' },
    { ...origins[1], serial_no: '' },
  ];
  const wire = purchaseUnitsWire(pieces, 2)!;
  assert.deepEqual(wire[0], { unit_index: 1, supplier_order_no: '000123', tracking_no: '00000789', serial_no: '000ABC123456' });
  assert.deepEqual(wire[1], { unit_index: 2, supplier_order_no: '000124', tracking_no: '' });
  assert.equal('serial_norm' in wire[0], false, 'stored identity never becomes a new draft enrollment');
  assert.equal('id' in wire[0], false);
  assert.deepEqual(copyPurchaseUnits(pieces, 2), [
    { unit_index: 1, supplier_order_no: '', tracking_no: '' },
    { unit_index: 2, supplier_order_no: '', tracking_no: '' },
  ], 'cloned purchases must not register the original devices again');
  const shared = applySupplierOrderNumber(pieces, 2, 'SHARED-001', true);
  assert.equal(shared[0].serial_no, pieces[0].serial_no, 'shared supplier order does not overwrite the per-device serial');
  assert.equal(shared[0].serial_norm, pieces[0].serial_norm);
  assert.deepEqual(purchaseUnitsWire(pieces, 1), [wire[0]], 'removed quantity cannot enroll a hidden unit serial');
});

test('legacy untracked documents and clones remain untracked; tracked clones erase old identities', () => {
  assert.equal(purchaseUnitsValid(undefined, 3), true);
  assert.equal(copyPurchaseUnits(undefined, 3), undefined);
  assert.equal(copyPurchaseUnits([], 3), undefined, 'API empty array must not opt a legacy clone into tracking');
  assert.equal(purchaseUnitsValid([], 3), false, 'explicitly enabling tracking in a new draft requires every order ref');
  assert.deepEqual(copyPurchaseUnits(origins, 2), [
    { unit_index: 1, supplier_order_no: '', tracking_no: '' },
    { unit_index: 2, supplier_order_no: '', tracking_no: '' },
  ]);
});

test('quantity edits expose only active rows while preserving references during intermediate typing', () => {
  assert.deepEqual(purchaseUnitRows(origins, 1), [origins[0]]);
  assert.deepEqual(purchaseUnitRows(origins, 3), origins);
  assert.deepEqual(purchaseUnitRows(origins, NaN), []);
  assert.equal(purchaseUnitsValid(origins, 4), false, 'new units need their own supplier order reference');
  assert.equal(purchaseUnitsValid(origins, 1001), false);
  assert.equal(purchaseUnitsValid([{ ...origins[0], supplier_order_no: ' ' }], 1), false);
  assert.equal(purchaseUnitsValid([{ ...origins[0], tracking_no: 'x'.repeat(121) }], 1), false);
});

test('changing the freight profile preserves unit provenance without repurposing it as a cost', () => {
  const selection: Selection = { product_id: 'a1', scope: 'option', scope_id: 'combo', label: 'A1 Combo', sku: '', stock: 0, reserved: 0, selling_price_iqd: 965000, cost_source: 'unknown', weight_g: 0, volume_mm3: 0 };
  const before = { ...selectionCostDraft(selection, null, 3), unit_origins: origins };
  const after = changeLineCostProfile(before, null);
  assert.deepEqual(after.unit_origins, origins);
  assert.equal(after.qty_ordered, 3);
  assert.equal(after.source_unit_amount, '');
});

test('receiving supports an exact later supplier unit and refuses stale, duplicate and mismatched selections', () => {
  const line = { qty_ordered: 3, qty_received: 1, unit_origins: origins };
  assert.deepEqual(pendingPurchaseUnits(origins).map((row) => row.id), ['unit-2', 'unit-3']);
  assert.deepEqual(purchaseReceiptDraft(line), { qty: 2, rejected_qty: 0, unit_origin_ids: ['unit-2', 'unit-3'] });
  assert.equal(purchaseReceiptValid(line, { qty: 1, rejected_qty: 0, unit_origin_ids: ['unit-3'] }), true);
  for (const draft of [
    { qty: 1, rejected_qty: 0, unit_origin_ids: ['unit-1'] },
    { qty: 2, rejected_qty: 0, unit_origin_ids: ['unit-2', 'unit-2'] },
    { qty: 1, rejected_qty: 0, unit_origin_ids: ['unit-2', 'unit-3'] },
    { qty: 0, rejected_qty: 1, unit_origin_ids: [] },
  ]) assert.equal(purchaseReceiptValid(line, draft), false);
  assert.deepEqual(purchaseReceiptDraft({ qty_ordered: 3, qty_received: 1, unit_origins: [] }), { qty: 2, rejected_qty: 0 });
});
