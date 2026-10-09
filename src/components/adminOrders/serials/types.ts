/**
 * The wire shapes of the serial scan, mirrored from the server
 * (worker/lib/serialAssignments.ts: OrderSerialsView, SlotView, LinkResult,
 * serialStory). No cost field ever travels here: a batch is an id, a
 * received date and a shelf.
 */
import type { LinkFormatWire } from './formatNotes';

export type WarrantyState = 'PENDING_DELIVERY' | 'ACTIVE' | 'EXPIRED' | 'NEEDS_CONFIG' | 'RETURNED' | 'CLOSED' | 'NOT_ACTIVATED';

export type SerialStatus = 'in_stock' | 'reserved' | 'sold' | 'registered' | 'returned' | 'unavailable' | 'void';

export interface SlotAssignment {
  id: string;
  /**
   * The whole serial for every admin since owner decision 1 (2026-10-09;
   * DECISIONS row 192); a masked form is still rendered if the server ever
   * sends one (its masking path stays as defence in depth).
   */
  serial_display: string;
  /** Present only when the viewer may see the whole serial — every admin today. */
  serial_full?: string;
  linked_at: string;
  linked_by: string;
  source: string;
  lot: { id: string; received_at: string | null; location: string | null } | null;
  lot_source: string | null;
  warranty: { state: WarrantyState; mode: string; carries_until: string | null };
  override_kind: string | null;
}

export interface SerialSlotView {
  order_item_id: string;
  unit_index: number;
  part: string;
  part_index?: number;
  product_id?: string;
  product_name: string;
  variant_label: string | null;
  assignment: SlotAssignment | null;
  previous: null | { assignment_id?: string; serial_display: string; serial_full?: string; released_at: string; reason: string; free: boolean };
  flags: string[];
  /**
   * The serial format rule of the slot's product (owner decision 2;
   * worker/lib/serialRules.ts publicRule). `box_sn_shape: 'bambu'` reads a
   * Bambu-box-shaped value as a box number; under any other rule it is the
   * serial itself. Absent from an older server: read as 'bambu' (today).
   */
  rule?: SlotRule;
}

export interface SlotRule {
  id: string;
  version: number;
  scope: string;
  label: string;
  mode: 'off' | 'warn' | 'enforce';
  box_sn_shape: 'none' | 'bambu';
  family_check: boolean;
  expected: string;
}

export interface GateMissing {
  order_item_id: string;
  unit_index: number;
  part: string;
  product_name: string;
}

export interface OrderSerials {
  installed: boolean;
  window?: boolean;
  shipment_locked?: boolean;
  gate?: { enabled: boolean; applies: boolean; since: string | null };
  required?: number;
  linked?: number;
  slots?: SerialSlotView[];
  missing?: GateMissing[];
}

export interface LinkResult {
  success: true;
  outcome: 'created' | 'existing' | 'already';
  code: 'SERIAL_LINKED' | 'SERIAL_EXISTING_LINKED';
  message: string;
  assignment_id: string;
  slot: { order_item_id: string; unit_index: number; part: string; assignment: SlotAssignment | null };
  warnings: string[];
  /** The format rule that judged the serial and its warnings (owner decision 2); null before 0180 and on a replay. */
  format?: LinkFormatWire | null;
}

export interface UnlinkResult {
  success: true;
  already?: true;
  code: 'SERIAL_UNLINKED';
  message: string;
  slot: { order_item_id: string; unit_index: number; part: string; assignment: null };
}

export type LinkSource = 'camera' | 'scanner' | 'manual' | 'relink';

export type OverrideKind = 'take_from_order' | 'delivered_device' | 'unavailable' | 'outside_window' | 'batch' | 'model_family';

/** The slot a scan is for — and, for a change, the link it replaces. */
export interface ScanTarget {
  order_item_id: string;
  unit_index: number;
  part: string;
  product_name: string;
  variant_label: string | null;
  replaceAssignmentId?: string;
}

export interface StoryActor {
  id: string;
  email: string | null;
  username: string | null;
  via?: string;
}

export interface StoryEvent {
  id: string | number;
  action: string;
  created_at: string;
  actor: StoryActor | null;
  detail: Record<string, unknown>;
}

/** GET /api/devices/admin/serial-inventory/:serial → `story` (§16). */
export interface SerialStory {
  serial_display: string;
  serial?: string;
  serial_norm: string | null;
  legacy: boolean;
  product: { id: string; name: string; name_ar: string } | null;
  variant: { id: string; label: string | null } | null;
  sku: string | null;
  status: SerialStatus;
  current_order: { order_id: string | null; unit_index: number; linked_at: string; activated: boolean } | null;
  previous_orders: Array<{ order_id: string | null; released_at: string | null; reason: string | null; linked_at: string }>;
  warranty: {
    state: WarrantyState;
    start_at: string | null;
    end_at: string | null;
    remaining_days: number | null;
    mode: string | null;
    closed_reason: string | null;
  };
  lot: { id: string; source: string | null } | null;
  history: StoryEvent[];
}
