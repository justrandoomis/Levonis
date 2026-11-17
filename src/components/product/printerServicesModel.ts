/**
 * The page's side of «خصص طابعتك»: the server's offer (per-unit prices for this
 * printer), the draft choice, and what the cart will accept. The browser never
 * prices anything: every figure on the card, the sheet and the cart is one the
 * server sent (the offer's option and package prices, or a quote's
 * `fee_iqd` / `delivery_fee_iqd` / `lines`) — packages/pricing/src/printerServices.ts.
 */
import {
  EMPTY_SELECTION,
  type AcademyChoice,
  type DeliveryChoice,
  type ServiceSelection as PricedSelection,
  type ServicesOffer,
} from '../../../packages/pricing/src/printerServices';
import { api } from '../../lib/api';

export type { ServicesOffer, DeliveryChoice, AcademyChoice };
export { EMPTY_SELECTION };

/**
 * Phase 2 (0235): the membership plan and the owner's filament kit chosen WITH the
 * printer. Not services: the add sends them as `membershipPlanId` / `kitId` beside
 * `services` (the product page spreads `extras` into its body; the server's
 * selection parser ignores the key inside `services`). A field left undefined is
 * "untouched"; null removes it.
 */
export interface SelectionExtras { membershipPlanId?: string | null; kitId?: string | null }
export type ServiceSelection = PricedSelection & { extras?: SelectionExtras };

/** The choice as the server's services field takes it: without the extras. */
export function servicesOnly(s: ServiceSelection): PricedSelection {
  const { extras: _extras, ...rest } = s;
  void _extras;
  return rest;
}

/** One priced service of a selection, as the server sent it. */
export interface QuotedLine { service: string; choice: string; fee_iqd: number }

/** A selection priced by the server (the quote's, or the cart line's `priced`). */
export interface QuotedSelection {
  fee_iqd: number;
  warranty_months: number;
  delivery_fee_iqd: number | null;
  blockers: string[];
  lines?: QuotedLine[];
}

/** The quote's `printer_services` block. */
export interface QuotedServices {
  offer: ServicesOffer;
  selection: QuotedSelection | null;
}

/** Whether the server's answer is for the choice on screen. */
export type QuoteState = 'fresh' | 'pending' | 'failed';

/** What the page sends to POST /api/products/:slug/quote besides `services`. */
export interface QuoteBase {
  slug: string;
  body: Record<string, unknown>;
}

/** The selection a package tile means (not yet confirmed until tapped). Delivery is kept only when it is offered. */
export function presetFrom(offer: ServicesOffer, id: 'just' | 'smart' | 'complete', delivery: DeliveryChoice | null): ServiceSelection | null {
  const d = offer.delivery ? delivery : null;
  if (id === 'just') return { ...EMPTY_SELECTION, package: 'just', delivery: d };
  const p = offer.packages[id];
  if (!p) return null;
  // `membership_tier` is only the sheet's preselect hint, never a field of the choice.
  const { warranty, care, packaging, inspection } = p.includes;
  return { v: 1, package: id, warranty, care, packaging, inspection, academy: 'recorded', delivery: d, confirmed: false, ack_no_warranty: false };
}

/** The offer's price for a delivery method (a server figure, looked up, never summed). */
export function deliveryFee(offer: ServicesOffer, d: DeliveryChoice | null): number | null {
  if (!d || !offer.delivery) return null;
  return d === 'economy' ? offer.delivery.economy : offer.delivery.personal;
}

/** The choice is complete on the customer's side: tapped, delivery chosen when it is offered, no-warranty acknowledged. */
export function readyToBuy(s: ServiceSelection | null, offer: ServicesOffer | null): boolean {
  return !!s && s.confirmed && (!offer?.delivery || s.delivery !== null) && (s.warranty !== 'none' || s.ack_no_warranty);
}

/** Codes the page handles itself (the tap, the acknowledgment): never shown as a blocker. */
const LOCAL = new Set(['SERVICES_NOT_CONFIRMED', 'SERVICES_NO_WARRANTY_ACK']);

/** The server's first refusal of this priced selection, or null. */
export function firstBlocker(q: QuotedSelection | null): string | null {
  return q?.blockers.find((b) => !LOCAL.has(b)) ?? null;
}

/**
 * The card's verdict: `ready` only when the choice is complete AND the server
 * priced exactly this choice without a blocker.
 */
export type Verdict = 'ready' | 'incomplete' | 'pending' | 'failed' | 'blocked';
export function verdictOf(s: ServiceSelection | null, offer: ServicesOffer | null, q: QuotedSelection | null, state: QuoteState): Verdict {
  if (state === 'failed') return 'failed';
  if (state === 'pending' || !offer) return 'pending';
  if (!readyToBuy(s, offer)) return 'incomplete';
  if (!q) return 'pending';
  return firstBlocker(q) ? 'blocked' : 'ready';
}

/** A custom choice that equals a preset is still "custom" — the server checks presets strictly. */
export function asCustom(s: ServiceSelection): ServiceSelection {
  return { ...s, package: 'custom' };
}

/** Prices one draft choice on the server (the sheet's footer); null when the server sent no services block. */
export async function quoteDraft(
  base: QuoteBase,
  services: ServiceSelection,
  signal: AbortSignal
): Promise<{ unit_iqd: number | null; selection: QuotedSelection | null } | null> {
  const res = await api.post<{ quote?: { unit_subtotal_iqd?: number } | null; printer_services?: QuotedServices }>(
    `/api/products/${base.slug}/quote`,
    { ...base.body, services: servicesOnly(services) },
    { signal, timeoutMs: 12000 }
  );
  if (!res.printer_services) return null;
  const unit = res.quote?.unit_subtotal_iqd;
  return { unit_iqd: typeof unit === 'number' ? unit : null, selection: res.printer_services.selection };
}

/**
 * Arrow keys inside a `role="radiogroup"` of buttons: they MOVE FOCUS only
 * (Home / End too). Choosing stays a deliberate press — Enter or Space on the
 * focused option, or a tap — because a package is never chosen for the
 * customer (a visual default is not consent; DECISIONS row 339). Up/Down move
 * in reading order; Left/Right follow the writing direction.
 */
export function moveRadioFocus(e: { key: string; currentTarget: HTMLElement; preventDefault: () => void }, dir: 'rtl' | 'ltr'): void {
  const step =
    e.key === 'ArrowDown' ? 1
    : e.key === 'ArrowUp' ? -1
    : e.key === 'ArrowRight' ? (dir === 'rtl' ? -1 : 1)
    : e.key === 'ArrowLeft' ? (dir === 'rtl' ? 1 : -1)
    : e.key === 'Home' || e.key === 'End' ? 0
    : null;
  if (step === null) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)'));
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + step + items.length) % items.length;
  items[next]?.focus();
}

/** The one option of a radiogroup that takes the Tab stop: the chosen one, else the first enabled. */
export function tabStop<T>(ids: readonly T[], chosen: T | null | undefined, enabled: (id: T) => boolean): T | undefined {
  if (chosen !== null && chosen !== undefined && ids.includes(chosen) && enabled(chosen)) return chosen;
  return ids.find(enabled);
}

// ------------------------------------------------------------ phase 2 (0235)

/** One option of GET /api/memberships/order-options (the server's figures; never summed here). */
export type MembershipOption =
  | {
      ok: true;
      plan: { id: string; tier: string; duration_months: number; price_iqd: number | null; paused?: boolean };
      /** Owner ruling (review 2026-11-17): no renewal through a printer order; a member is offered higher tiers only. */
      kind: 'new' | 'upgrade';
      price_iqd: number;
      credit_iqd: number;
      charge_iqd: number;
      starts: 'at_activation' | 'at_current_expiry';
      current_tier: string | null;
      current_expires_at: string | null;
      expires_at_if_activated_now?: string | null;
    }
  | { ok: false; code: string; message?: string; plan: { id: string; tier: string; duration_months: number; price_iqd: number | null } };

export interface MembershipOptions {
  offered: boolean;
  options: MembershipOption[];
  current: { tier: string; expires_at: string | null } | null;
  pending_order_id: string | null;
}

/** The membership plans this viewer may buy with a printer (open; per account when signed in). */
export async function loadMembershipOptions(signal?: AbortSignal): Promise<MembershipOptions> {
  const r = await api.get<Partial<MembershipOptions>>('/api/memberships/order-options', { signal, timeoutMs: 12000 });
  return {
    offered: r.offered === true,
    options: Array.isArray(r.options) ? r.options : [],
    current: r.current ?? null,
    pending_order_id: r.pending_order_id ?? null,
  };
}

/** One kit of GET /api/products/:slug/kits, priced by the server for this printer selection. */
export interface PricedKit {
  id: string;
  title: { ar: string; en: string; ckb: string };
  available: boolean;
  price_per_printer_iqd: number | null;
  total_iqd: number | null;
  items: Array<{ product_id: string; slug: string; name: string; name_ar: string; variant?: string | null; qty_per_printer: number; qty: number; unit_price_iqd: number | null; available: boolean; reason: string | null }>;
}

/** What the kits are priced for: the printer's product, version, order type, route and quantity. */
export interface KitsFor {
  slug: string;
  optionValueIds: readonly string[];
  fulfillmentType?: string;
  transportMethod?: string;
  qty: number;
}

export async function loadKits(f: KitsFor, signal?: AbortSignal): Promise<PricedKit[]> {
  const q = new URLSearchParams();
  if (f.optionValueIds.length) q.set('optionValueIds', f.optionValueIds.join(','));
  if (f.fulfillmentType) q.set('fulfillmentType', f.fulfillmentType);
  if (f.transportMethod) q.set('transportMethod', f.transportMethod);
  q.set('qty', String(Math.max(1, f.qty)));
  const r = await api.get<{ kits?: PricedKit[] }>(`/api/products/${encodeURIComponent(f.slug)}/kits?${q}`, { signal, timeoutMs: 12000 });
  return Array.isArray(r.kits) ? r.kits : [];
}
