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

/**
 * PHASE 6 (owner, 2026-11-19; DECISIONS row 362) — «today's price IS the Smart Choice price».
 * The offer says so with `anchor` (the Smart package's fee the printer's price already holds), and
 * the delivery block may carry a free warehouse `pickup`. Both are read defensively: an older
 * server sends neither, and the card then draws exactly what it drew before («+» prices).
 */
export interface OfferAnchor { package: 'smart'; fee_iqd: number }
export type Text3 = { ar: string; en: string; ckb: string };
/** Economy, Personal, or collected from the warehouse (free). */
export type DeliveryPick = DeliveryChoice | 'pickup';

/** The anchor of an offer: only a positive whole fee over a Smart package the offer still sells. */
export function anchorOf(offer: ServicesOffer | null | undefined): OfferAnchor | null {
  const a = (offer as { anchor?: unknown } | null | undefined)?.anchor as { package?: unknown; fee_iqd?: unknown } | null | undefined;
  if (!a || a.package !== 'smart' || typeof a.fee_iqd !== 'number' || !Number.isSafeInteger(a.fee_iqd) || a.fee_iqd <= 0) return null;
  return offer?.packages.smart ? { package: 'smart', fee_iqd: a.fee_iqd } : null;
}

/** The warehouse pickup of an offer (`delivery.pickup`), or null when it is not offered. */
export function pickupOf(offer: ServicesOffer | null | undefined): { note: Text3 | null } | null {
  const d = offer?.delivery as { pickup?: { note?: Text3 | null } | null } | null | undefined;
  if (!d || !d.pickup) return null;
  const n = d.pickup.note;
  return { note: n && typeof n.ar === 'string' && typeof n.en === 'string' && typeof n.ckb === 'string' && (n.ar || n.en || n.ckb) ? n : null };
}

/** The delivery choices this offer shows, in the card's order. */
export function deliveryChoices(offer: ServicesOffer | null | undefined): DeliveryPick[] {
  if (!offer?.delivery) return [];
  return pickupOf(offer) ? ['economy', 'personal', 'pickup'] : ['economy', 'personal'];
}

/** The four services a package fixes. */
export type ServiceKey = 'warranty' | 'care' | 'packaging' | 'inspection';
export type Included = { warranty: 'none' | 'w12' | 'w24'; care: 'none' | 'c12'; packaging: 'standard' | 'extra'; inspection: 'none' | 'full' };
const NOTHING: Included = { warranty: 'none', care: 'none', packaging: 'standard', inspection: 'none' };

/** What the printer's price already includes: the Smart package's choices under an anchor, else nothing. */
export function includedIn(offer: ServicesOffer | null | undefined): Included {
  const inc = anchorOf(offer) ? offer?.packages.smart?.includes : null;
  return inc ? { warranty: inc.warranty, care: inc.care, packaging: inc.packaging, inspection: inc.inspection } : NOTHING;
}

/** The offer's own price of one option (a server figure); 0 for «none» / standard, null when it is not sold. */
export function optionPrice(offer: ServicesOffer, service: ServiceKey, choice: string): number | null {
  if (choice === 'none' || choice === 'standard') return 0;
  const v =
    service === 'warranty' ? offer.warranty?.[choice as 'w12' | 'w24']
    : service === 'care' ? offer.care?.c12
    : service === 'packaging' ? offer.packaging?.extra
    : offer.inspection?.full;
  return typeof v === 'number' ? v : null;
}

/**
 * A FIGURE AGAINST WHAT THE PRICE INCLUDES. `included` = this is what the price holds (drawn as
 * «مشمول في السعر», never «+0»); otherwise the difference of two server figures, negative when the
 * choice takes something out of the price. Without an anchor nothing is included, so every delta is
 * the option's own price and the card reads as it always did.
 */
export interface Delta { iqd: number; included: boolean }

/** One option of a service against the included option of the same service; null when either is not sold. */
export function optionDelta(offer: ServicesOffer, service: ServiceKey, choice: string): Delta | null {
  const base = includedIn(offer)[service];
  const mine = optionPrice(offer, service, choice);
  const theirs = optionPrice(offer, service, base);
  if (mine === null || theirs === null) return null;
  // «مشمول في السعر» is said of a SERVICE the price holds — never of «بدون» or the standard packaging.
  return { iqd: mine - theirs, included: !!anchorOf(offer) && choice === base && choice !== 'none' && choice !== 'standard' };
}

/** A package tile against the price: Just = −anchor, Smart = included, Complete = its price − the anchor. */
export function packageDelta(offer: ServicesOffer, id: 'just' | 'smart' | 'complete'): Delta | null {
  const anchor = anchorOf(offer)?.fee_iqd ?? 0;
  if (id === 'just') return { iqd: anchor ? -anchor : 0, included: false };
  const price = offer.packages[id]?.price_iqd;
  if (typeof price !== 'number') return null;
  return { iqd: price - anchor, included: anchor > 0 && id === 'smart' };
}

/**
 * What «الطابعة فقط» takes out of the price, service by service («−29,000 الضمان · −19,000 Levo Care»).
 * Listed only when the lines add up to the anchor exactly — a discounted Smart package has no honest
 * per-service split, and the tile then shows the total alone.
 */
export function removedByJust(offer: ServicesOffer): Array<{ service: ServiceKey; iqd: number }> {
  const anchor = anchorOf(offer);
  if (!anchor) return [];
  const inc = includedIn(offer);
  const out: Array<{ service: ServiceKey; iqd: number }> = [];
  for (const service of ['warranty', 'care', 'packaging', 'inspection'] as const) {
    const price = optionPrice(offer, service, inc[service]);
    if (price === null) return [];
    if (price > 0) out.push({ service, iqd: -price });
  }
  return out.reduce((n, l) => n - l.iqd, 0) === anchor.fee_iqd ? out : [];
}

/** The services figure of a priced choice against the price: the server's `net_fee_iqd`, else fee − anchor. */
export function netFee(q: QuotedSelection): number {
  if (typeof q.net_fee_iqd === 'number') return q.net_fee_iqd;
  return q.fee_iqd - (typeof q.anchor_fee_iqd === 'number' ? q.anchor_fee_iqd : 0);
}

/**
 * A FIGURE WITH ITS SIGN, AS ONE PIECE: «−48,000 د.ع», «+133,000 د.ع». The sign and the digits are
 * wrapped in a left-to-right isolate (U+2066 … U+2069), so in an Arabic or Sorani line the minus stays
 * in front of the number instead of drifting to its far side; the currency word stays where the
 * line's direction puts it. `money` is the page's own formatter («48,000 د.ع», «48,000 IQD», «$36.50»).
 */
export function signedMoney(iqd: number, money: (v: number) => string): string {
  const text = money(Math.abs(iqd));
  const sign = iqd < 0 ? '−' : '+';
  const m = /^(.*\d)(\s+\D+)$/.exec(text);
  return m ? `\u2066${sign}${m[1]}\u2069${m[2]}` : `\u2066${sign}${text}\u2069`;
}

/** The gold edge of a chosen row — one inline rule beside the house's pressed fill (no stylesheet of its own). */
export const CHOSEN_EDGE = { borderColor: 'color-mix(in oklab, var(--color-gold) 55%, transparent)' } as const;

/** One priced service of a selection, as the server sent it (with the PRO list fee and saving when the discount applied). */
export interface QuotedLine { service: string; choice: string; fee_iqd: number; fee_before_discount_iqd?: number; pro_discount_iqd?: number }

/** What the PRO services discount took off one unit (owner, 2026-11-19), as the server sent it. */
export interface QuotedProDiscount { pct: number; services_iqd: number; personal_before_iqd: number | null; personal_iqd: number }

/** A selection priced by the server (the quote's, or the cart line's `priced`). */
export interface QuotedSelection {
  fee_iqd: number;
  warranty_months: number;
  delivery_fee_iqd: number | null;
  blockers: string[];
  lines?: QuotedLine[];
  /** Phase 6: the part of `fee_iqd` the printer's price already holds (0 or absent = no anchor). */
  anchor_fee_iqd?: number;
  /** Phase 6: `fee_iqd − anchor_fee_iqd` — what the choice adds to (or takes from) the price. */
  net_fee_iqd?: number;
  /** Present only for an active PRO whose services were discounted. */
  pro_discount?: QuotedProDiscount;
}

/** The PRO saving on this draft per unit: the service lines, plus Personal delivery when it is the chosen one. */
export function proSavingOf(q: QuotedSelection | null | undefined, delivery: DeliveryChoice | null): number {
  const d = q?.pro_discount;
  if (!d) return 0;
  return d.services_iqd + (delivery === 'personal' && q?.delivery_fee_iqd != null ? d.personal_iqd : 0);
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
export function presetFrom(offer: ServicesOffer, id: 'just' | 'smart' | 'complete', delivery: DeliveryPick | null): ServiceSelection | null {
  // A pickup the offer no longer has is not carried either.
  const d = (offer.delivery && (delivery !== 'pickup' || pickupOf(offer)) ? delivery : null) as DeliveryChoice | null;
  if (id === 'just') return { ...EMPTY_SELECTION, package: 'just', delivery: d };
  const p = offer.packages[id];
  if (!p) return null;
  // `membership_tier` is only the sheet's preselect hint, never a field of the choice.
  const { warranty, care, packaging, inspection } = p.includes;
  return { v: 1, package: id, warranty, care, packaging, inspection, academy: 'recorded', delivery: d, confirmed: false, ack_no_warranty: false };
}

/** The offer's price for a delivery method (a server figure, looked up, never summed). */
export function deliveryFee(offer: ServicesOffer, d: DeliveryPick | null): number | null {
  if (!d || !offer.delivery) return null;
  // The warehouse pickup is free, and only while the offer carries it.
  if (d === 'pickup') return pickupOf(offer) ? 0 : null;
  return d === 'economy' ? offer.delivery.economy : offer.delivery.personal;
}

/**
 * THE CHOICE AN ANCHORED PRINTER OPENS WITH: the Smart package, already confirmed — it is what the
 * price on the page pays for, so it is what an untouched page would buy (the server prices a line
 * with no choice the same way). Null without an anchor: then nothing is chosen until the tap.
 * Delivery is never preselected.
 */
export function anchoredStart(offer: ServicesOffer | null | undefined): ServiceSelection | null {
  if (!offer || !anchorOf(offer)) return null;
  const smart = presetFrom(offer, 'smart', null);
  return smart ? { ...smart, confirmed: true } : null;
}

/**
 * A SMALL MEMORY FOR THE SHEET'S LISTS (owner, 2026-11-19: «the filament kit and subscription is
 * delayed to show»). The kits / add-ons / bundles answer and the membership options used to be
 * asked only when their row was opened. The card now asks for them when it mounts, and the sheet
 * reads the same answer: one request per key, shared while it is in flight, kept for a minute. A
 * failed request is forgotten at once, so «إعادة المحاولة» asks again.
 */
const WARM_MS = 60_000;
type Warm = { at: number; promise: Promise<unknown>; value?: unknown };
const warm = new Map<string, Warm>();

export function warmed<T>(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  const hit = warm.get(key);
  if (!fresh && hit && Date.now() - hit.at < WARM_MS) return hit.promise as Promise<T>;
  const entry: Warm = { at: Date.now(), promise: Promise.resolve() };
  entry.promise = load().then(
    (v) => { entry.value = v; return v; },
    (e) => { if (warm.get(key) === entry) warm.delete(key); throw e; }
  );
  warm.set(key, entry);
  // Bounded: a long session over many versions keeps the latest answers only.
  if (warm.size > 24) warm.delete(warm.keys().next().value as string);
  return entry.promise as Promise<T>;
}

/** The answer already in memory for this key (so the first paint has it), or undefined. */
export function warmedNow<T>(key: string): T | undefined {
  const hit = warm.get(key);
  return hit && Date.now() - hit.at < WARM_MS ? (hit.value as T | undefined) : undefined;
}

/** Tests only. */
export function forgetWarmed(): void { warm.clear(); }

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
