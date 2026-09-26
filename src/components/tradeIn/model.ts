/**
 * «الاستبدال» on the client — the shapes the Worker sends (worker/lib/tradeIn.ts
 * `requestView`, `listEligible`, `listTargets`) and the few pure helpers the
 * screens share. The valuation itself is NOT re-implemented here: the wizard
 * imports the same engine the Worker runs (packages/pricing/src/tradeIn.ts),
 * so the live figure on the phone and the figure the server writes are one
 * function applied to one set of rules.
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
  tradeInSettlement,
  valuateComponent,
  warrantyMonthsLeft,
  wholeMonthsBetween,
} from '../../../packages/pricing/src/tradeIn';

export type { ComponentInputs, ComponentRole, ComponentValuation, TradeInFamily, TradeInRuleSet, TradeInScope, TradeInSettlement, TradeInStatus };

export interface ScopeOption {
  scope: TradeInScope;
  available: boolean;
  reason: string | null;
  components: Array<{ role: ComponentRole; family: TradeInFamily; base_iqd: number }>;
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
  ams_split: { method: 'option_gap' | 'reference' | 'none'; share_bp: number | null; ams_base_iqd: number };
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
  base_iqd: number;
  inputs: Partial<ComponentInputs>;
  value_iqd: number | null;
  estimate: ComponentValuation | null;
  required_angles: string[];
  photos: PhotoView[];
}

export interface EstimateView {
  components: Array<{ role: ComponentRole; family: TradeInFamily; label_ar: string; label_en: string; valuation: ComponentValuation }>;
  total_iqd: number;
  settlement: TradeInSettlement | null;
  usage_months: number;
  warranty_remaining_months: number;
  computed_at: string;
}

export interface TargetView {
  product_id: string;
  slug: string;
  name: string;
  name_ar: string;
  image: string;
  family: TradeInFamily;
  options: Array<{ id: string; label_ar: string; label_en: string }>;
  color: { id: string; label_ar: string; label_en: string; hex: string } | null;
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
  status_label: { ar: string; en: string };
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
  customer_note: string;
  cancel_reason: string;
  blockers: { inputs: Record<string, string[]>; photos: Record<string, string[]>; target: boolean } | null;
  events: TradeInEvent[];
  rules: Partial<Record<TradeInFamily, TradeInRuleSet>>;
  can: { edit: boolean; submit: boolean; cancel: boolean; decide: boolean; pay: boolean };
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface RequestSummary {
  id: string;
  status: TradeInStatus;
  status_label: { ar: string; en: string };
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
  image: string;
  family: TradeInFamily;
  from_price_iqd: number;
  groups: Array<{ id: string; name: string; values: Array<{ id: string; label_ar: string; label_en: string }> }>;
  colors: Array<{ id: string; label_ar: string; label_en: string; hex: string }>;
}

/** The facts a component's valuation stands on, from the request's frozen source. */
export function contextOf(source: RequestView['source'], nowIso = new Date().toISOString()) {
  return {
    usage_months: wholeMonthsBetween(source.delivered_at ?? null, nowIso),
    usage_days: daysBetween(source.delivered_at ?? null, nowIso),
    warranty_remaining_months: warrantyMonthsLeft(source.warranty_end_at ?? null, nowIso),
  };
}

/**
 * THE LIVE FIGURE — the wizard's answers through the server's own rules.
 * Null while a family's rules have not arrived (never a guess).
 */
export function liveEstimate(
  req: Pick<RequestView, 'source' | 'components' | 'rules' | 'target'>,
  inputs: Partial<Record<ComponentRole, ComponentInputs>>,
  productId: string
): { total: number; parts: Array<{ role: ComponentRole; valuation: ComponentValuation }>; settlement: TradeInSettlement | null } | null {
  const ctx = contextOf(req.source);
  const parts: Array<{ role: ComponentRole; valuation: ComponentValuation }> = [];
  for (const c of req.components) {
    const rules = req.rules[c.family];
    const answers = inputs[c.role];
    if (!rules || !answers) return null;
    parts.push({
      role: c.role,
      valuation: valuateComponent(rules, { base_iqd: c.base_iqd, usage_months: ctx.usage_months, warranty_remaining_months: ctx.warranty_remaining_months, product_id: productId }, answers),
    });
  }
  const total = parts.reduce((s, p) => s + p.valuation.value_iqd, 0);
  const price = req.target?.price_iqd ?? null;
  return { total, parts, settlement: price ? tradeInSettlement(price, total) : null };
}

/** «14 شهر و 3 أيام» — a duration the customer can picture. */
export function durationText(days: number, loc: (ar: string, en: string) => string): string {
  const months = Math.floor(days / 30);
  const rest = days - months * 30;
  if (months === 0) return loc(`${rest} يوم`, `${rest} day${rest === 1 ? '' : 's'}`);
  if (rest === 0) return loc(`${months} شهر`, `${months} month${months === 1 ? '' : 's'}`);
  return loc(`${months} شهر و ${rest} يوم`, `${months} mo ${rest} d`);
}

export function dateText(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' });
}
