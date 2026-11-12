/**
 * A COURIER'S OWN STATEMENT — the seam for Al-Zaeem's API (the owner's brief, 2026-11-12, part 3: «support for future
 * integration with Al-Zaeem Delivery Company's API»; DECISIONS row 332; worker/lib/courierCollections.ts).
 *
 * Today the owner records each transfer by hand on «أموال لدى شركة التوصيل», from Al-Zaeem's statement: the parcels it
 * paid, the fee it kept on each, the amount and the statement number. When Al-Zaeem offers an API, a driver implementing
 * this interface reads the same four facts, so the page can fill the form for the owner to confirm. A source only reads:
 * `recordRemittance` stays the one writer, with its checks, its journal entries and its audit rows. A parcel is matched
 * by the tracking number the booking stored (orders.delivery_tracking_no), else by the order id the courier echoes.
 *
 * CREDENTIALS NEVER CROSS THE BOUNDARY (types.ts): a source is built from Worker secrets inside the Worker, nothing it
 * returns carries a token, and no route serialises one.
 */

/** One transfer as the courier lists it. */
export interface CourierTransfer {
  /** The courier's statement or invoice number: the transfer's reference on the page. */
  reference: string;
  /** The day the money was sent, YYYY-MM-DD. */
  day: string;
  amount_iqd: number;
  parcels: number;
}

/** One parcel a transfer paid, as the courier lists it. */
export interface CourierTransferParcel {
  tracking_no: string;
  /** The order id the courier echoes back, when it keeps one. */
  order_id: string | null;
  /** Cash collected at the door, the fee included. */
  collected_iqd: number;
  /** What the courier kept for delivering it. */
  fee_iqd: number;
}

export interface CourierStatementSource {
  readonly courier: 'alzaeem';
  /** Transfers sent on or after `sinceDay` (YYYY-MM-DD), newest first. */
  listTransfers(sinceDay: string): Promise<CourierTransfer[]>;
  /** The parcels one transfer paid. */
  transferParcels(reference: string): Promise<CourierTransferParcel[]>;
}

/** No courier offers an API yet: every transfer is typed from the statement. */
export function courierStatementSource(): CourierStatementSource | null {
  return null;
}
