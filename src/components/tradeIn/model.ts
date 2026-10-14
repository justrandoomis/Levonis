/**
 * «الاستبدال» on the client — the shapes the Worker sends (worker/lib/tradeIn.ts
 * `requestView`, `listEligible`, `listTargets`) and the few pure helpers the
 * screens share. The valuation is NOT run here (DECISIONS row 220): the
 * owner's valuation rules are the calculation behind a price Levonis sets, so
 * the customer's wizard is told only which questions to ask
 * (`TradeInQuestions`) and posts the answers to
 * POST /api/trade-in/requests/:id/preview, which answers the final figures.
 * The admin screens read the full rules and breakdown (`AdminRequestView`).
 */
import {
  type ComponentInputs,
  type ComponentRole,
  type ComponentValuation,
  type TradeInFamily,
  type TradeInRuleSet,
  type TradeInScope,
  type TradeInSettlement,
  type TradeInStatus,
  daysBetween,
  warrantyMonthsLeft,
  wholeMonthsBetween,
} from '../../../packages/pricing/src/tradeIn';

export type { ComponentInputs, ComponentRole, ComponentValuation, TradeInFamily, TradeInRuleSet, TradeInScope, TradeInSettlement, TradeInStatus };

export interface ScopeOption {
  scope: TradeInScope;
  available: boolean;
  reason: string | null;
  /** A part's base is absent where it would name the shop's own AMS reference (DECISIONS row 220). */
  components: Array<{ role: ComponentRole; family: TradeInFamily; base_iqd?: number }>;
  /** What the scope is valued from — null where it would name the shop's own AMS reference. */
  base_iqd: number | null;
}

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
  /** How a Combo's AMS share was found; its base is absent on a `reference` split (the shop's own figure, DECISIONS row 220). */
  ams_split: { method: 'option_gap' | 'reference' | 'none'; share_bp: number | null; ams_base_iqd?: number };
  paid_iqd: number;
  ordered_at: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  usage_days: number;
  usage_months: number;
  warranty_remaining_months: number;
  scopes: ScopeOption[];
  available: boolean;
  reason: string | null;
  open_request_id: string | null;
}

export interface PhotoView {
  id: string;
  component: ComponentRole;
  angle: string;
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
  /** The base the part is valued from — the admin's answer only (on a Combo it can be the shop's AMS reference). */
  base_iqd?: number;
  inputs: Partial<ComponentInputs>;
  value_iqd: number | null;
  /** The part's estimated value — the figure alone; the breakdown is the admin's (`AdminComponentView`). */
  estimate: { value_iqd: number } | null;
  required_angles: string[];
  photos: PhotoView[];
}

export interface AdminComponentView extends Omit<ComponentView, 'estimate' | 'base_iqd'> {
  base_iqd: number;
  estimate: ComponentValuation | null;
}

/** The estimate as the customer reads it: each part's final value, the total and the settlement. */
export interface EstimateView {
  components: Array<{ role: ComponentRole; family: TradeInFamily; label_ar: string; label_en: string; value_iqd: number }>;
  total_iqd: number;
  settlement: TradeInSettlement | null;
  usage_months: number;
  warranty_remaining_months: number;
  computed_at: string;
}

export interface AdminEstimateView extends Omit<EstimateView, 'components'> {
  components: Array<{ role: ComponentRole; family: TradeInFamily; label_ar: string; label_en: string; valuation: ComponentValuation }>;
  rule_versions?: Partial<Record<TradeInFamily, number>>;
}

/** What the wizard asks for one family (worker/lib/tradeIn.ts `publicQuestions`) — never what an answer is worth. */
export interface TradeInQuestions {
  family: TradeInFamily;
  version: number;
  /** The factors the owner turned on: which questions to show. */
  asked: string[];
  /** `label_ckb` while the item reads as the seed wrote it (worker `publicQuestions`). */
  faults: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string }>;
  replaced_parts: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string }>;
}

export interface TargetView {
  product_id: string;
  slug: string;
  name: string;
  name_ar: string;
  /** The catalogue's Sorani name where the owner wrote one. */
  name_ckb?: string;
  image: string;
  family: TradeInFamily;
  options: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string }>;
  color: { id: string; label_ar: string; label_en: string; label_ckb?: string; hex: string } | null;
  option_value_ids: string[];
  color_id: string | null;
  price_iqd: number | null;
}

export interface TradeInEvent {
  action: string;
  actor_role: 'customer' | 'admin' | 'system';
  from_status: string | null;
  to_status: string | null;
  created_at: string;
  detail: Record<string, unknown>;
}

export interface RequestView {
  id: string;
  status: TradeInStatus;
  status_label: { ar: string; en: string; ckb?: string };
  scope: TradeInScope;
  family: TradeInFamily;
  is_combo: boolean;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  source_product_id: string | null;
  source: {
    name?: string;
    variant?: string;
    image?: string;
    product_slug?: string;
    order_id?: string;
    ordered_at?: string;
    delivered_at?: string | null;
    warranty_end_at?: string | null;
    paid_iqd?: number;
    ams_split?: EligibleUnit['ams_split'];
  };
  target: TargetView | null;
  components: ComponentView[];
  estimate: EstimateView | null;
  estimated_iqd: number | null;
  offer: { offer_no: number; value_iqd: number; reason: string; settlement: TradeInSettlement; valued_at: string | null } | null;
  final_value_iqd: number | null;
  credit_iqd: number | null;
  difference_iqd: number | null;
  excess_iqd: number | null;
  credit_order: { id: string; status: string; amount_iqd: number } | null;
  /** The credit's last moment (owner decision 2); null once an order holds it, or for a credit with no end. Older servers omit it. */
  credit_expires_at?: string | null;
  /** The credit ended unused: «إتمام الدفع» is closed. */
  credit_expired?: boolean;
  customer_note: string;
  cancel_reason: string;
  blockers: { inputs: Record<string, string[]>; photos: Record<string, string[]>; target: boolean } | null;
  /**
   * A draft's figures left to ask for (trade-in G11: 20 a request, 60 a day).
   * A draft's own view carries no estimate: the figure is the counted
   * preview's (POST /requests/:id/preview). Older servers omit it.
   */
  previews_left?: number;
  events: TradeInEvent[];
  questions: Partial<Record<TradeInFamily, TradeInQuestions>>;
  can: { edit: boolean; submit: boolean; cancel: boolean; decide: boolean; pay: boolean };
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

/** The same request as an admin reads it: the rules that price it and the per-factor breakdown. */
export interface AdminRequestView extends Omit<RequestView, 'components' | 'estimate' | 'questions'> {
  /** How many counted estimates the customer asked for on this request. */
  previews?: number;
  components: AdminComponentView[];
  estimate: AdminEstimateView | null;
  rules: Partial<Record<TradeInFamily, TradeInRuleSet>>;
}

export interface RequestSummary {
  id: string;
  status: TradeInStatus;
  status_label: { ar: string; en: string; ckb?: string };
  scope: TradeInScope;
  family: TradeInFamily;
  name: string;
  image: string;
  target_name: string | null;
  target_name_ar: string | null;
  estimated_iqd: number | null;
  admin_value_iqd: number | null;
  final_value_iqd: number | null;
  difference_iqd: number | null;
  offer_no: number;
  created_at: string;
  updated_at: string;
}

export interface TargetOption {
  product_id: string;
  slug: string;
  name: string;
  name_ar: string;
  name_ckb?: string;
  image: string;
  family: TradeInFamily;
  from_price_iqd: number;
  groups: Array<{ id: string; name: string; values: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string }> }>;
  colors: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string; hex: string }>;
}

/** The facts a component's valuation stands on, from the request's frozen source. */
export function contextOf(source: RequestView['source'], nowIso = new Date().toISOString()) {
  return {
    usage_months: wholeMonthsBetween(source.delivered_at ?? null, nowIso),
    usage_days: daysBetween(source.delivered_at ?? null, nowIso),
    warranty_remaining_months: warrantyMonthsLeft(source.warranty_end_at ?? null, nowIso),
  };
}

/** The wizard's live figure, as POST /api/trade-in/requests/:id/preview answers it. */
export interface LiveEstimate {
  total: number;
  parts: Array<{ role: ComponentRole; value_iqd: number }>;
  settlement: TradeInSettlement | null;
}

export function liveFromEstimate(e: EstimateView | null | undefined): LiveEstimate | null {
  if (!e) return null;
  return { total: e.total_iqd, parts: e.components.map((c) => ({ role: c.role, value_iqd: c.value_iqd })), settlement: e.settlement };
}

/** «14 شهر و 3 أيام» — a duration the customer can picture. */
export function durationText(days: number, loc: (ar: string, en: string, ckb: string) => string): string {
  const months = Math.floor(days / 30);
  const rest = days - months * 30;
  if (months === 0) return loc(`${rest} يوم`, `${rest} day${rest === 1 ? '' : 's'}`, `${rest} ڕۆژ`);
  if (rest === 0) return loc(`${months} شهر`, `${months} month${months === 1 ? '' : 's'}`, `${months} مانگ`);
  return loc(`${months} شهر و ${rest} يوم`, `${months} mo ${rest} d`, `${months} مانگ و ${rest} ڕۆژ`);
}

export function dateText(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  // Sorani first where the browser has it, the Arabic calendar names where it does not.
  const locales = lang === 'en' ? 'en-GB' : lang === 'ckb' ? ['ckb-IQ-u-nu-latn', 'ar-IQ-u-nu-latn'] : 'ar-IQ-u-nu-latn';
  return d.toLocaleDateString(locales, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A part's name in the reader's language. The Worker stores a part's label in
 * Arabic and English (the device's own name, or «the AMS that came with» it);
 * the Sorani is built here from the same name, never copied from the Arabic.
 */
export function partLabel(
  c: { role: ComponentRole; label_ar: string; label_en: string },
  loc: (ar: string, en: string, ckb: string) => string
): string {
  if (c.role !== 'ams') return loc(c.label_ar, c.label_en, c.label_en);
  const device = c.label_en.replace(/^AMS included with\s+/, '');
  return loc(c.label_ar, c.label_en, `ئەو AMS ـەی لەگەڵ ${device} هاتووە`);
}
