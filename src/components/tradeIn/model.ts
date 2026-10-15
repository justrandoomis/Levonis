/**
 * «الاستبدال» on the client — the shapes the Worker sends (worker/lib/tradeIn.ts `requestView`,
 * `publicUnit`, `listMine`; worker/lib/tradeInTargets.ts `searchTargets`; the preview's `offer`)
 * and the few pure helpers the screens share.
 *
 * NOTHING HERE PRICES ANYTHING (DECISIONS rows 220, 238): the offer, the target's price, the
 * credit and the difference are the server's figures. The customer reads ONE figure for the old
 * device («حتى X»); no part value, no rule, no ceiling ever reaches these types.
 */
import type { ComponentInputs, ComponentRole, TradeInFamily, TradeInScope, TradeInStage, TradeInStatus } from '../../../packages/pricing/src/tradeIn';
import type { Language } from '../../translations';

export type { ComponentInputs, ComponentRole, TradeInFamily, TradeInScope, TradeInStage, TradeInStatus };

export interface Trilabel {
  ar: string;
  en: string;
  ckb?: string;
}

export interface ScopeOption {
  scope: TradeInScope;
  available: boolean;
  reason: string | null;
  components: Array<{ role: ComponentRole; family: TradeInFamily }>;
}

/** One delivered device line of the customer's own orders (GET /api/trade-in/eligible). */
export interface EligibleUnit {
  key: string;
  order_item_id: string;
  unit_index: number;
  order_id: string;
  product_id: string;
  product_slug: string;
  name: string;
  variant: string;
  image: string;
  family: TradeInFamily;
  is_combo: boolean;
  ordered_at: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  warranty_remaining_months: number;
  scopes: ScopeOption[];
  available: boolean;
  reason: string | null;
  open_request_id: string | null;
  /** A trade-in received it: the device is with the shop. Older servers omit it. */
  in_shop?: boolean;
  /** Where its open trade-in stands. Older servers omit it. */
  stage?: TradeInStage | null;
}

/** What the screens ask for one family (worker `publicQuestions`) — never what an answer is worth. */
export interface TradeInQuestions {
  family: TradeInFamily;
  version: number;
  asked: string[];
  faults: Array<{
    id: string;
    label_ar: string;
    label_en: string;
    label_ckb?: string;
  }>;
  replaced_parts: Array<{
    id: string;
    label_ar: string;
    label_en: string;
    label_ckb?: string;
  }>;
}

export interface PhotoView {
  id: string;
  component: ComponentRole;
  angle: string;
  /** v2: what the photograph proves — `hours`, or a ticked fault id. */
  proves?: string;
  url: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface ComponentView {
  role: ComponentRole;
  family: TradeInFamily;
  label_ar: string;
  label_en: string;
  inputs: Partial<ComponentInputs>;
  required_angles: string[];
  allowed_angles?: string[];
  photos: PhotoView[];
}

export interface TargetView {
  product_id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ckb?: string;
  image: string;
  family: TradeInFamily;
  options?: Array<{
    id: string;
    label_ar: string;
    label_en: string;
    label_ckb?: string;
  }>;
  color?: {
    id: string;
    label_ar: string;
    label_en: string;
    label_ckb?: string;
    hex: string;
  } | null;
  option_value_ids: string[];
  color_id: string | null;
  price_iqd: number | null;
}

/** A device a credit can buy (GET /api/trade-in/targets): this customer's lowest direct-sale price. */
export interface TargetOption {
  product_id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ckb?: string;
  image: string;
  family: TradeInFamily;
  from_price_iqd: number;
  groups: Array<{
    id: string;
    name: string;
    values: Array<{
      id: string;
      label_ar: string;
      label_en: string;
      label_ckb?: string;
    }>;
  }>;
  colors: Array<{
    id: string;
    label_ar: string;
    label_en: string;
    label_ckb?: string;
    hex: string;
  }>;
}

export interface TradeInEvent {
  action: string;
  actor_role: 'customer' | 'admin' | 'system';
  from_status: string | null;
  to_status: string | null;
  created_at: string;
  detail: Record<string, unknown>;
}

/** The customer's request (`requestView(…, 'customer')`, an allow-list). */
export interface RequestView {
  id: string;
  status: TradeInStatus;
  status_label: Trilabel;
  stage: TradeInStage;
  stage_label: Trilabel;
  scope: TradeInScope;
  family: TradeInFamily;
  is_combo: boolean;
  valuation_version?: number;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  source: {
    name?: string;
    variant?: string;
    image?: string;
    product_slug?: string;
    delivered_at?: string | null;
    warranty_end_at?: string | null;
  };
  target: TargetView | null;
  /** The store-safe offer fixed at submit (v2). */
  offer: {
    offer_iqd: number | null;
    offer_at: string | null;
    valid_until: string | null;
  } | null;
  /** A value the shop proposed after inspection, for the customer to accept or decline. */
  value_proposal: {
    offer_no: number;
    value_iqd: number;
    reason: string;
    valued_at: string | null;
  } | null;
  now_price_iqd: number | null;
  handover: 'store' | 'pickup' | null;
  pickup_fee_iqd: number;
  estimated_iqd: number | null;
  final_value_iqd: number | null;
  credit_iqd: number | null;
  difference_iqd: number | null;
  excess_iqd: number | null;
  credit_order: { id: string; status: string; amount_iqd: number } | null;
  credit_expires_at?: string | null;
  credit_expired?: boolean;
  reissue: { ends_at: string; any_device: true } | null;
  intake: { received_at: string; serial_matched: boolean } | null;
  customer_note: string;
  cancel_reason: string;
  blockers: {
    inputs: Record<string, string[]>;
    photos: Record<string, string[]>;
    target: boolean;
  } | null;
  previews_left?: number;
  components: ComponentView[];
  events: TradeInEvent[];
  questions?: Partial<Record<TradeInFamily, TradeInQuestions>>;
  can: {
    edit: boolean;
    submit: boolean;
    cancel: boolean;
    decide: boolean;
    pay: boolean;
    choose_handover?: boolean;
  };
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

/** One row of «طلباتي للاستبدال» (GET /api/trade-in/requests). */
export interface RequestSummary {
  id: string;
  status: TradeInStatus;
  status_label: Trilabel;
  /** v2 servers: where it stands, as the customer reads it. */
  stage?: TradeInStage;
  stage_label?: Trilabel;
  scope: TradeInScope;
  family: TradeInFamily;
  name: string;
  image: string;
  target_name: string | null;
  target_name_ar: string | null;
  target_name_ckb?: string;
  offer_iqd?: number | null;
  final_value_iqd: number | null;
  created_at: string;
  updated_at: string;
}

/** POST /api/trade-in/requests/:id/preview — the one figure (v2). */
export interface PreviewOffer {
  offer_iqd: number | null;
  no_offer_reason?: string;
  now_price_iqd: number | null;
  target_price_iqd: number | null;
  difference_iqd: number | null;
  excess_iqd: number;
  pickup_fee_if_collected_iqd: number;
  valid_until_if_sent: string;
}

/** POST /api/trade-in/requests/:id/checkout. */
export interface CheckoutAnswer {
  coupon_code: string | null;
  order_id: string | null;
  target: {
    product_id: string;
    slug: string | null;
    option_value_ids: string[];
    color_id: string | null;
  } | null;
  any_device: boolean;
  credit_iqd: number | null;
  difference_iqd: number | null;
  ends_at: string | null;
}

/** The stages that still need the customer or the shop (an open request). */
export const OPEN_STAGES: readonly TradeInStage[] = [
  'draft',
  'awaiting_device',
  'inspecting',
  'decision',
  'credit_ready',
  'awaiting_new_device',
  'credit_reissued',
  'device_to_collect',
];

/** A stage's tone, for its chip: what waits on the customer is the accent. */
export function stageTone(stage: TradeInStage | null | undefined): 'accent' | 'success' | 'warning' | 'neutral' | 'info' {
  switch (stage) {
    case 'decision':
    case 'credit_ready':
    case 'credit_reissued':
    case 'device_to_collect':
      return 'accent';
    case 'awaiting_device':
    case 'draft':
      return 'warning';
    case 'completed':
      return 'success';
    case 'inspecting':
    case 'awaiting_new_device':
      return 'info';
    default:
      return 'neutral';
  }
}

/**
 * What the credit and the payment come to with a collection fee (decision 2: the fee comes off
 * the credit; the credit never exceeds the new device; the rest is never paid out). Display only —
 * the server fixes the figures when it fixes the value.
 */
export function withFee(targetIqd: number, offerIqd: number, feeIqd: number): { credit: number; pay: number; excess: number } {
  const credit = Math.min(Math.max(0, offerIqd - feeIqd), targetIqd);
  return {
    credit,
    pay: targetIqd - credit,
    excess: Math.max(0, offerIqd - feeIqd - credit),
  };
}

export function dateText(iso: string | null | undefined, lang: Language | string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  // Sorani month names written here: many browsers carry no `ckb` calendar data and would fall back
  // to the Arabic names (a ckb slot never shows the Arabic — DECISIONS row 183).
  if (lang === 'ckb') return `${d.getDate()} ${CKB_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The Gregorian months in Sorani, as Iraqi Kurdistan writes them. */
const CKB_MONTHS = [
  'کانوونی دووەم',
  'شوبات',
  'ئازار',
  'نیسان',
  'ئایار',
  'حوزەیران',
  'تەممووز',
  'ئاب',
  'ئەیلوول',
  'تشرینی یەکەم',
  'تشرینی دووەم',
  'کانوونی یەکەم',
] as const;

type Loc = (ar: string, en: string, ckb?: string) => string;

/** A label the server writes in Arabic and English, with its own Sorani where written. */
export function triText(l: Trilabel | null | undefined, loc: Loc): string {
  return l ? loc(l.ar, l.en, l.ckb || l.en) : '';
}

/** A target's name in the reader's language (the catalogue's Sorani where written). */
export function nameOf(t: { name: string; name_ar: string; name_ckb?: string }, loc: Loc): string {
  return loc(t.name_ar || t.name, t.name || t.name_ar, t.name_ckb || t.name || t.name_ar);
}

export function labelOf(v: { label_ar: string; label_en: string; label_ckb?: string }, loc: Loc): string {
  return loc(v.label_ar || v.label_en, v.label_en, v.label_ckb || v.label_en);
}
