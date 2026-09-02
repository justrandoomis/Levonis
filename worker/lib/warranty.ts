/**
 * The warranty RECEIPT: the document Levonis hands over with a physical
 * device, one per serial number.
 *
 * WHERE THIS SITS. worker/lib/deviceOps.ts owns the COVERAGE — which units
 * exist, when each was delivered, when its window opens and closes, what a
 * replacement inherits. This module owns the PAPER: the receipt number, the
 * snapshot of everything printed on it, the lifecycle of an issued document,
 * and the public verification view. It reads the unit; it never recomputes
 * the unit's dates from the product, because a receipt that recalculated its
 * own coverage could disagree with the device record it was issued for.
 *
 * SNAPSHOTS, NOT JOINS. A price list changes, a customer moves house, the
 * terms get reworded. None of that may alter a receipt already printed, so
 * every printed value is copied into the row at issue time (migration 0042).
 *
 * 'expired' IS NOT A STORED STATE. It is what the clock says about an active
 * receipt, computed on read. Storing it would need a nightly job to stay
 * true, and a receipt whose stored status lied would be worse than no status.
 */

import { addMonths } from './membershipOps';
import { maskSerial } from './deviceOps';
import { safeParse } from './types';
// The printed wording and the shop's details live in their own leaf module so
// worker/lib/settings.ts can store them without importing this file's
// device-coverage reads (that cycle left the defaults uninitialised).
import { DEFAULT_WARRANTY_CONFIG, type WarrantyRetailer } from './warrantyConfig';

export {
  DEFAULT_WARRANTY_CONFIG,
  parseWarrantyConfig,
  type WarrantyConfig,
  type WarrantyRetailer,
  type WarrantyTermLine,
} from './warrantyConfig';

// ----------------------------------------------------------------- numbers

/** `WR-2026-0902-001` — year, month+day, then the day's sequence. */
export function formatReceiptNo(dateIso: string, sequence: number): string {
  const d = new Date(dateIso);
  const y = d.getUTCFullYear();
  const md = `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `WR-${y}-${md}-${String(sequence).padStart(3, '0')}`;
}

/** The `WR-2026-0902-` prefix every number issued on that day shares. */
export function receiptNoPrefix(dateIso: string): string {
  return formatReceiptNo(dateIso, 0).slice(0, -3);
}

/** The sequence part, or 0 for anything that is not one of our numbers. */
export function receiptNoSequence(receiptNo: string): number {
  const m = /^WR-\d{4}-\d{4}-(\d{3,})$/.exec(receiptNo.trim());
  return m ? Number(m[1]) : 0;
}

export const RECEIPT_NO_RE = /^WR-\d{4}-\d{4}-\d{3,}$/;

// ------------------------------------------------------------------ status

export const WARRANTY_STORED_STATUSES = ['draft', 'active', 'void', 'replaced'] as const;
export type WarrantyStoredStatus = (typeof WARRANTY_STORED_STATUSES)[number];

export const WARRANTY_STATUSES = ['draft', 'active', 'expired', 'void', 'replaced'] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];

/**
 * What the receipt IS right now: the stored lifecycle state, except that an
 * active receipt whose window has closed reads as expired.
 */
export function effectiveStatus(
  stored: string,
  warrantyEndAt: string | null | undefined,
  nowIso: string
): WarrantyStatus {
  const s = (WARRANTY_STORED_STATUSES as readonly string[]).includes(stored)
    ? (stored as WarrantyStoredStatus)
    : 'draft';
  if (s !== 'active') return s;
  if (!warrantyEndAt) return 'active'; // no end date recorded: never claim expiry
  return new Date(warrantyEndAt).getTime() < new Date(nowIso).getTime() ? 'expired' : 'active';
}

/** Only a live receipt verifies as covered. */
export function isCovered(status: WarrantyStatus): boolean {
  return status === 'active';
}

// ------------------------------------------------------------------- dates

/**
 * The coverage window a NEW receipt prints. `months` comes from the unit when
 * it has one; the default is the admin-configured period (one year).
 */
export function warrantyWindow(startIso: string, months: number): { start_at: string; end_at: string } {
  const start = new Date(startIso).toISOString();
  return { start_at: start, end_at: addMonths(start, months) };
}

/** Whole days from now until the window closes; negative once it has. */
export function daysRemaining(endIso: string | null | undefined, nowIso: string): number | null {
  if (!endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(nowIso).getTime();
  return Math.ceil(ms / 86_400_000);
}

// ------------------------------------------------------------ public view

export interface WarrantyReceiptRow extends Record<string, unknown> {
  id: string;
  receipt_no: string;
  unit_id: string;
  order_id: string;
  status: string;
  serial_raw: string;
  serial_norm: string;
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  customer_email: string;
  product_description: string;
  product_model: string;
  purchase_price_iqd: number | null;
  purchase_date: string | null;
  order_receipt_no: string;
  warranty_type: string;
  /** The same two strings in English. A receipt prints in whichever language
   *  the reader asked for, and it must print the wording it was ISSUED with —
   *  never today's configuration, and never the other language because this
   *  one was not stored. */
  warranty_type_en: string;
  warranty_months: number;
  coverage_text: string;
  coverage_text_en: string;
  terms_json: string;
  retailer_json: string;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  print_count: number;
  replaces_receipt_id: string | null;
  replaced_by_receipt_id: string | null;
  void_reason: string;
  issued_at: string | null;
  created_at: string;
}

/**
 * What a stranger holding the receipt number may see.
 *
 * The rule is not "hide the obviously secret fields" but "show only what
 * proves coverage": status, what the device is, the window, and enough of the
 * serial to recognise the device in your hand. A verification page that
 * echoed the buyer's address and phone would turn every printed receipt into
 * a lookup tool for whoever finds it in a bin.
 */
export interface PublicWarrantyView {
  receipt_no: string;
  status: WarrantyStatus;
  product: string;
  model: string;
  serial_masked: string;
  warranty_start_at: string | null;
  warranty_end_at: string | null;
  warranty_months: number;
  warranty_type: string;
  warranty_type_en: string;
  purchase_date: string | null;
  days_remaining: number | null;
  retailer: { name: string; website: string; instagram: string; phone: string };
  /** Present only when the document is not the live one, so a holder of a
   *  superseded receipt is told why rather than left guessing. */
  note: 'replaced' | 'void' | null;
}

export function publicView(row: WarrantyReceiptRow, nowIso: string): PublicWarrantyView {
  const status = effectiveStatus(row.status, row.warranty_end_at, nowIso);
  const retailer = safeParse<Partial<WarrantyRetailer>>(row.retailer_json, {});
  return {
    receipt_no: row.receipt_no,
    status,
    product: row.product_description,
    model: row.product_model,
    serial_masked: row.serial_raw ? maskSerial(row.serial_raw) : '',
    warranty_start_at: row.warranty_start_at ?? null,
    warranty_end_at: row.warranty_end_at ?? null,
    warranty_months: row.warranty_months,
    warranty_type: row.warranty_type,
    warranty_type_en: row.warranty_type_en || row.warranty_type,
    purchase_date: row.purchase_date ?? null,
    days_remaining: status === 'active' ? daysRemaining(row.warranty_end_at, nowIso) : null,
    retailer: {
      name: retailer.name ?? DEFAULT_WARRANTY_CONFIG.retailer.name,
      website: retailer.website ?? DEFAULT_WARRANTY_CONFIG.retailer.website,
      instagram: retailer.instagram ?? DEFAULT_WARRANTY_CONFIG.retailer.instagram,
      phone: retailer.phone ?? DEFAULT_WARRANTY_CONFIG.retailer.phone,
    },
    note: status === 'replaced' ? 'replaced' : status === 'void' ? 'void' : null,
  };
}

/** The fields the public view must never carry, asserted by the test suite. */
export const PRIVATE_RECEIPT_FIELDS = [
  'customer_name',
  'customer_phone',
  'customer_address',
  'customer_email',
  'serial_raw',
  'serial_norm',
  'purchase_price_iqd',
  'order_id',
  'unit_id',
  'user_id',
] as const;
