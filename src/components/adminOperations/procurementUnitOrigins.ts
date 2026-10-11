/** Supplier references are private text identifiers, never amounts or customer tracking. */
export type PurchaseUnitOrigin = {
  unit_index: number;
  supplier_order_no: string;
  tracking_no: string;
  /** Optional raw draft value; it becomes a canonical immutable binding. */
  serial_no?: string;
  serial_norm?: string | null;
  id?: string;
  received_lot_id?: string | null;
  current_lot_id?: string | null;
  received_at?: string | null;
  unavailable_reason?: string | null;
};

export const MAX_TRACKED_PURCHASE_UNITS = 1000;
export const SUPPLIER_REFERENCE_MAX = 120;

export function unitQuantityValid(qty: number) {
  return Number.isSafeInteger(qty) && qty > 0 && qty <= MAX_TRACKED_PURCHASE_UNITS;
}

/** Retain rows temporarily outside the quantity while typing, so changing 12
 * through 1 to 15 does not silently erase eleven supplier references. */
export function purchaseUnitRows(origins: readonly PurchaseUnitOrigin[], qty: number): PurchaseUnitOrigin[] {
  if (!unitQuantityValid(qty)) return [];
  const byIndex = new Map(origins.map((row) => [row.unit_index, row]));
  return Array.from({ length: qty }, (_, i) => byIndex.get(i + 1) ?? { unit_index: i + 1, supplier_order_no: '', tracking_no: '' });
}

/** One supplier order can contain many physical units. Fill only missing order
 * references by default; replacing mixed orders requires an explicit action.
 * Unit tracking and receipt identity remain independent of that shared order. */
export function applySupplierOrderNumber(origins: readonly PurchaseUnitOrigin[], qty: number, supplierOrderNo: string, overwrite = false): PurchaseUnitOrigin[] {
  const reference = supplierOrderNo.trim();
  if (!unitQuantityValid(qty) || !reference || reference.length > SUPPLIER_REFERENCE_MAX) return [...origins];
  return [
    ...purchaseUnitRows(origins, qty).map((row) => overwrite || !row.supplier_order_no.trim() ? { ...row, supplier_order_no: reference } : row),
    ...origins.filter((row) => row.unit_index > qty),
  ];
}

export function purchaseUnitsValid(origins: readonly PurchaseUnitOrigin[] | undefined, qty: number) {
  if (!origins) return true;
  return unitQuantityValid(qty) && purchaseUnitRows(origins, qty).every((row) => (
    typeof row.supplier_order_no === 'string' && row.supplier_order_no.trim().length > 0 && row.supplier_order_no.trim().length <= SUPPLIER_REFERENCE_MAX &&
    typeof row.tracking_no === 'string' && row.tracking_no.trim().length <= SUPPLIER_REFERENCE_MAX
  ));
}

/** Explicit allowlist: saved receipt IDs and other stock metadata must never be
 * sent back as new origin identities, nor reach a pricing request. */
export function purchaseUnitsWire(origins: readonly PurchaseUnitOrigin[] | undefined, qty: number) {
  return origins ? purchaseUnitRows(origins, qty).map(({ unit_index, supplier_order_no, tracking_no, serial_no }) => ({
    unit_index,
    supplier_order_no: supplier_order_no.trim(),
    tracking_no: tracking_no.trim(),
    ...(serial_no?.trim() ? { serial_no: serial_no.trim() } : {}),
  })) : undefined;
}

export function copyPurchaseUnits(origins: readonly PurchaseUnitOrigin[] | undefined, qty: number) {
  return origins?.length ? purchaseUnitRows([], qty) : undefined;
}

export function pendingPurchaseUnits(origins: readonly PurchaseUnitOrigin[] | undefined) {
  return (origins ?? []).filter((row) => row.id && !row.received_lot_id && !row.received_at && !row.unavailable_reason);
}

export type PurchaseReceiptDraft = { qty: number; rejected_qty: number; unit_origin_ids?: string[] };

export function purchaseReceiptDraft(line: { qty_ordered: number; qty_received: number; unit_origins?: PurchaseUnitOrigin[] }): PurchaseReceiptDraft {
  if (line.unit_origins?.length) {
    const unit_origin_ids = pendingPurchaseUnits(line.unit_origins).map((row) => row.id!);
    return { qty: unit_origin_ids.length, rejected_qty: 0, unit_origin_ids };
  }
  return { qty: Math.max(0, line.qty_ordered - line.qty_received), rejected_qty: 0 };
}

export function purchaseReceiptValid(line: { qty_ordered: number; qty_received: number; unit_origins?: PurchaseUnitOrigin[] }, draft: PurchaseReceiptDraft) {
  if (!Number.isInteger(draft.qty) || !Number.isInteger(draft.rejected_qty) || draft.qty < 0 || draft.rejected_qty < 0 || draft.qty + draft.rejected_qty > line.qty_ordered - line.qty_received) return false;
  if (!line.unit_origins?.length) return true;
  const ids = draft.unit_origin_ids ?? [], allowed = new Set(pendingPurchaseUnits(line.unit_origins).map((row) => row.id));
  return draft.rejected_qty === 0 && ids.length === draft.qty && new Set(ids).size === ids.length && ids.every((id) => allowed.has(id));
}
