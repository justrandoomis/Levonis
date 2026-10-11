/**
 * Supplier purchase provenance is an admin operations record. It must never
 * travel through a customer snapshot, even if an old/imported document put
 * it there. This is deliberately separate from financial redaction: assistant
 * admins may read these fields, while customer delivery tracking stays public.
 */
const PRIVATE_KEYS = new Set([
  'inventory_origins', 'inventory_origin', 'inventory_unit_origins', 'inventory_unit_origin',
  'inventory_origin_ids', 'inventory_unit_id', 'origin_id', 'origin_snapshot',
  'unit_origins', 'unit_origin', 'unit_origin_ids',
  'preorder_origins', 'preorder_origin', 'preorder_unit_origins', 'preorder_unit_origin',
  'supplier_order_no', 'supplier_order_number', 'supplier_tracking_no', 'supplier_tracking_number',
  'current_supplier_order_no', 'current_tracking_no',
  'purchase_unit_index', 'purchase_line_id', 'purchase_id', 'purchase_name',
  'purchase_ref', 'batch_ref',
  'received_lot_id', 'current_lot_id', 'inventory_lot_id', 'lot_id',
  'physical_verified_at', 'verified_serial_norm', 'verified_by',
]);

export function stripInventoryProvenance<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripInventoryProvenance) as T;
  if (value && typeof value === 'object') {
    const safe: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      if (!PRIVATE_KEYS.has(snake)) safe[key] = stripInventoryProvenance(entry);
    }
    return safe as T;
  }
  return value;
}
