/**
 * The desk's shapes (worker/lib/tradeInAdminQueue.ts `adminQueue`, worker/lib/tradeIn.ts
 * `requestView(…, 'staff' | 'owner')`). Staff read the offer, the ceiling and the final value —
 * never a cost, a margin or a parameter; the owner's valuation record is its own door.
 */
import type { PhotoView, RequestView, TradeInFamily, TradeInStage, TradeInStatus } from '../tradeIn/model';

export type QueueChip = 'awaiting_device' | 'inspecting' | 'decision' | 'credit_ready' | 'awaiting_new_device' | 'completed' | 'closed' | 'device_to_collect' | 'overdue';
export const QUEUE_CHIPS: readonly QueueChip[] = [
  'awaiting_device',
  'inspecting',
  'decision',
  'credit_ready',
  'awaiting_new_device',
  'device_to_collect',
  'overdue',
  'completed',
  'closed',
];

export type SerialMatch = 'match' | 'mismatch' | 'unrecorded' | 'not_applicable';

export interface QueueRow {
  id: string;
  status: TradeInStatus;
  stage: TradeInStage;
  chip: QueueChip;
  family: TradeInFamily;
  scope: string;
  order_id: string;
  name: string;
  image: string;
  target_name: string;
  offer_iqd: number | null;
  ceiling_iqd: number | null;
  final_value_iqd: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  flags: { serial: SerialMatch | null; hours: boolean; above_ceiling: boolean; overdue: boolean; cutover: boolean };
  created_at: string;
  submitted_at: string | null;
  offer_expires_at: string | null;
  updated_at: string;
}

export interface QueueAnswer {
  requests: QueueRow[];
  counts: Partial<Record<QueueChip, number>> & Record<string, number>;
  next_cursor: string | null;
}

export interface StaffIntake {
  received_at: string;
  serial_matched: boolean;
  by: string | null;
  by_name: string | null;
  serial_norm: string | null;
  serial_match: SerialMatch | null;
  hours_seen: number | null;
  hours_declared: number | null;
  hours_flag: boolean;
  findings: string;
  serial_override: boolean;
}

export interface AdminRequestView extends Omit<RequestView, 'intake' | 'components'> {
  previews?: number;
  offer_expires_at?: string | null;
  ceiling_iqd?: number | null;
  ceiling_at?: string | null;
  above_ceiling?: boolean;
  intake: StaffIntake | null;
  intake_photos?: Array<PhotoView & { proves: string }>;
  declared_vs_intake?: Array<{ role: string; field: string; declared: unknown; seen: unknown }>;
  device_returned_at?: string | null;
  cutover?: boolean;
  components: Array<RequestView['components'][number] & { intake_inputs?: Record<string, unknown> }>;
}

export interface DetailResponse {
  request: AdminRequestView;
  customer: { id: string; name: string; email: string; phone_e164: string | null; username: string | null } | null;
  financial_scope: boolean;
  owner_scope?: boolean;
}
