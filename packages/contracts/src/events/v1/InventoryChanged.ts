import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, oneOf } from '../common';
import { int } from '../../schema';
import type { Infer } from '../../schema';

const shape = {
  product_id: id,
  scope: obj({ table: oneOf('products', 'product_option_values', 'product_colors', 'product_variants'), id }), // the row whose stock moved
  delta: int, // signed
  stock_after: int,
  reserved_after: int,
  reason: oneOf('reserve', 'commit', 'release', 'deduct', 'restore', 'adjust'),
  op_id: id, // = inventory_ledger.idempotency_key
  order_id: idOrNull,
};
const check = obj(shape);
export type InventoryChangedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.4 — Inventory package, every ledger write. */
export const InventoryChangedV1 = defineEvent<InventoryChangedV1>({
  type: 'InventoryChanged', aggregate_type: 'product', pii_class: 'none', pii: [], fields: keysOf(shape), check,
  doc: 'A stock level moved through the inventory ledger.',
});
