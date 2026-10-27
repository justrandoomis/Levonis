/**
 * Shipment primitives: the rows a pickup or a home delivery is made of. The
 * flows that create and advance them live in fulfillment.ts and orders.ts;
 * these builders only build statements, so both can use them and
 * fulfillment.ts can close a fee order (orders.ts) without a cycle.
 */
import { many, type Stmt } from './db';
import { invalid } from './errors';
import { releaseInventory, type InventoryReservationRow } from './inventory';
import { iso, pcId } from './util';
import { normalizeGovernorate } from '../iraqGovernorates';

export interface DeliveryAddress {
  recipient_name: string;
  phone: string;
  governorate: string;
  city: string;
  address_line: string;
  notes: string;
}

/** A delivery address as the API accepts it: all parts present, governorate one of the eighteen. */
export function parseAddress(raw: unknown): DeliveryAddress {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('delivery_address', 'object_required');
  const a = raw as Record<string, unknown>;
  const s = (k: string, max: number, required = true) => {
    const v = typeof a[k] === 'string' ? (a[k] as string).trim() : '';
    if (required && !v) throw invalid(`delivery_address.${k}`, 'required');
    if (v.length > max) throw invalid(`delivery_address.${k}`, 'too_long');
    return v;
  };
  const governorate = normalizeGovernorate(a.governorate);
  if (!governorate) throw invalid('delivery_address.governorate', 'not_allowed');
  const phone = s('phone', 20);
  if (!/^\+?[0-9 ]{7,20}$/.test(phone)) throw invalid('delivery_address.phone', 'format');
  return {
    recipient_name: s('recipient_name', 120),
    phone,
    governorate,
    city: s('city', 80),
    address_line: s('address_line', 300),
    notes: s('notes', 300, false),
  };
}

type FeeConfig = { delivery: { flat_fee_iqd: number; fee_by_governorate: Record<string, number> } };

/**
 * The delivery fee of a governorate and the rule that set it: the owner's own
 * fee for that governorate when one is set, else the flat fee. One function
 * for the fee a request is charged and the fee a quote states.
 */
export function deliveryFeeRule(config: FeeConfig, governorate: string): { fee: number; rule: 'governorate' | 'flat' } {
  const specific = config.delivery.fee_by_governorate[governorate];
  return typeof specific === 'number' ? { fee: specific, rule: 'governorate' } : { fee: config.delivery.flat_fee_iqd, rule: 'flat' };
}

export function deliveryFee(config: FeeConfig, governorate: string): number {
  return deliveryFeeRule(config, governorate).fee;
}

export type ShipmentStatus = 'awaiting_payment' | 'preparing' | 'ready_for_pickup' | 'shipped' | 'delivered' | 'picked_up' | 'cancelled';

export function createShipment(
  db: D1Database,
  p: {
    userId: string;
    kind: 'pickup' | 'delivery';
    status: ShipmentStatus;
    address: DeliveryAddress | null;
    feeIqd: number;
    feeOrderId: string | null;
    packaging?: string;
    now: Date;
  }
): { id: string; statement: Stmt } {
  const id = pcId('pcsp');
  return {
    id,
    statement: db
      .prepare(
        `INSERT INTO pc_shipments (id, user_id, kind, status, address_json, packaging, fee_iqd, fee_order_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, p.userId, p.kind, p.status, p.address ? JSON.stringify(p.address) : null, p.packaging ?? 'standard', p.feeIqd, p.feeOrderId, iso(p.now), iso(p.now)),
  };
}

/**
 * The shipment a finished print is on, live: the one its live item names (the
 * partial unique index `uq_pc_shipment_items_job` keeps it to one), or the one
 * the job row names. Both are written together when a request is made and
 * cleared together when it is cancelled; a print handed over stays on its
 * shipment for good. A SQL expression over the job row aliased `j`.
 */
export const LIVE_SHIPMENT_OF_JOB_SQL = `COALESCE((SELECT i.shipment_id FROM pc_shipment_items i WHERE i.job_id = j.id AND i.live = 1), j.shipment_id)`;

export function shipmentJobItem(db: D1Database, shipmentId: string, jobId: string): Stmt {
  return db
    .prepare("INSERT INTO pc_shipment_items (id, shipment_id, item_type, job_id, qty, live) VALUES (?, ?, 'print_job', ?, 1, 1)")
    .bind(pcId('pcsi'), shipmentId, jobId);
}

export function shipmentInventoryItem(db: D1Database, shipmentId: string, reservationId: string, variantId: string, qty: number): Stmt {
  return db
    .prepare(
      "INSERT INTO pc_shipment_items (id, shipment_id, item_type, inventory_reservation_id, variant_id, qty, live) VALUES (?, ?, 'inventory', ?, ?, ?, 1)"
    )
    .bind(pcId('pcsi'), shipmentId, reservationId, variantId, qty);
}

/** Release everything a shipment held and take its items off it. Statements only. */
export async function shipmentCancelStatements(db: D1Database, shipmentId: string, actorId: string, now: Date): Promise<Stmt[]> {
  const s: Stmt[] = [
    db.prepare('UPDATE pc_shipment_items SET live = 0 WHERE shipment_id = ?').bind(shipmentId),
    db.prepare('UPDATE pc_print_jobs SET shipment_id = NULL WHERE shipment_id = ?').bind(shipmentId),
  ];
  const holds = await many<InventoryReservationRow>(
    db,
    "SELECT id, account_id, user_id, variant_id, purpose, ref_id, qty_reserved, qty_consumed, qty_released, state FROM pc_inventory_reservations WHERE purpose = 'delivery' AND ref_id = ? AND state = 'active'",
    shipmentId
  );
  for (const r of holds) s.push(...releaseInventory(db, r, actorId, now, 'shipment cancelled'));
  return s;
}
