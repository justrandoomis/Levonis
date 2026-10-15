/**
 * «أجهزتي» and «خدماتي» — the shapes the device service answers (Services S-P2 spec §6.2;
 * worker/lib/services/myDevices.ts). The customer reads `PublicDevice` and `ServicesSummary` only:
 * never a paid split, never a serial beyond its last four, never a cost.
 */
export type DeviceFamily = 'fdm' | 'resin' | 'laser' | 'ams' | 'accessory';

/** Where a trade-in on the device stands, as its customer reads it (packages/pricing/src/tradeIn.ts `stageOf`). */
export type DeviceTradeInStage =
  | 'draft'
  | 'awaiting_device'
  | 'inspecting'
  | 'decision'
  | 'credit_ready'
  | 'awaiting_new_device'
  | 'completed'
  | 'credit_reissued'
  | 'offer_expired'
  | 'credit_expired'
  | 'device_to_collect'
  | 'cancelled'
  | 'rejected';

export interface PublicDevice {
  key: string;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  family: DeviceFamily | null;
  name: string;
  variant: string;
  image: string;
  delivered_at: string | null;
  warranty_months_left: number;
  /** The last four characters of the serial on record, or null. */
  serial_last4: string | null;
  gift: boolean;
  open: { return: boolean; service: boolean; protection: boolean; trade_in: { request_id: string; stage: DeviceTradeInStage } | null };
  /** A trade-in received the device: it is with the shop (no return, claim or perk counts it). */
  in_shop: boolean;
}

/** The server's own facts: the public device plus its internal unit and product. */
export interface DeviceFacts extends PublicDevice {
  unit_id: string;
  product_id: string | null;
}

export type ServicesNextAction = 'hand_in' | 'decide' | 'pay' | 'collect_device' | 'reissued';

export interface ServicesSummary {
  devices: { count: number; open_cases: number };
  trade_in: { open: number; next_action: ServicesNextAction | null; next_at: string | null };
  /** Arrives with S-P8. */
  protection: null;
  /** Arrives with S-P4. */
  perks: null;
}
