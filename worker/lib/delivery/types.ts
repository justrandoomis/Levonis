/**
 * The contract every local-delivery company has to satisfy, so the order
 * engine never learns any one company's wire format.
 *
 * WHY AN INTERFACE FOR ONE PROVIDER. Al-Waseet is the courier LEVONIS uses
 * today. It will not be the only one — Iraq's delivery market changes, and a
 * second city usually means a second company. More immediately, an interface
 * is the only way to test the sync logic at all: the driver used in tests is
 * a hand-written fake, not a live account, and nothing in orderStageOps or
 * the cron needs to change when the real one is swapped in.
 *
 * CREDENTIALS NEVER CROSS THE BOUNDARY. The owner was explicit: "استخدم
 * Al-Waseet Merchant API من الـBackend فقط، ولا تكشف بيانات الدخول أو الـtoken
 * في Frontend". A driver is constructed from Worker secrets inside the
 * Worker; nothing it returns carries a token, and no route serialises one.
 */

/** What a driver reports back about a shipment it created. */
export interface CreatedShipment {
  /** The courier's own order/invoice id — stored so a retry finds the same one. */
  remoteId: string;
  /** The tracking number, when the courier issues one at creation. */
  trackingNo: string;
  /** Whatever the courier called the shipment's starting state. */
  statusId: string;
  statusText: string;
}

/** One row of the courier's official status list. */
export interface RemoteStatus {
  id: string;
  text: string;
}

/** The courier's current word on one shipment. */
export interface RemoteShipmentStatus {
  remoteId: string;
  statusId: string;
  statusText: string;
  trackingNo?: string;
}

/** Everything a courier needs to collect and deliver one order. */
export interface ShipmentRequest {
  orderId: string;
  customerName: string;
  phone: string;
  /** Governorate/city id in the COURIER's vocabulary, resolved by the driver. */
  governorate: string;
  area: string;
  address: string;
  landmark: string;
  notes: string;
  /** What the driver collects at the door, in IQD. Zero for a prepaid order. */
  amountIqd: number;
  itemCount: number;
  itemsSummary: string;
}

/**
 * Every driver call returns one of these instead of throwing.
 *
 * "إذا تعذر اتصال Al-Waseet API: لا تغيّر حالة الطلب خطأً. سجل الخطأ. أعد
 * المحاولة لاحقًا." A thrown exception three layers down turns into a generic
 * 500 and a caller that cannot tell "the courier says no" from "the network
 * blinked" — and the difference decides whether to retry or to stop. So the
 * outcome is data.
 */
export type DriverResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; retryable: boolean; status?: number };

export interface DeliveryDriver {
  /** Stable key stored on the order and in the status map. */
  readonly provider: string;
  /** The courier's official status list — never hardcoded here. */
  listStatuses(): Promise<DriverResult<RemoteStatus[]>>;
  createShipment(req: ShipmentRequest): Promise<DriverResult<CreatedShipment>>;
  getShipment(remoteId: string): Promise<DriverResult<RemoteShipmentStatus>>;
}

/**
 * Why a driver could not be built. Returned rather than thrown so a screen can
 * say "the courier is not configured yet" instead of "خطأ في الخادم" — the
 * difference between a missing setting and a broken server.
 */
export interface DriverUnavailable {
  configured: false;
  reason: string;
  /** Names only. Never a value, not even a truncated one. */
  missing: string[];
}
