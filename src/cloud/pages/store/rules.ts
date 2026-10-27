/**
 * THE STORE'S RULES, WITHOUT REACT — what the screens under /store and /orders
 * decide, written once and tested on their own (tests/printCloudUiStore.test.ts).
 *
 * NOTHING HERE PRICES ANYTHING. A price is the server's: a pack's own stated
 * price (`pack_price_iqd`), a package's `price_iqd`, POST /pricing/quote for a
 * quantity, and the stored quote for an order (worker/lib/printCloud/pricing.ts
 * is the only place a Print Cloud price is computed). What lives here is the
 * shape of a purchase: which quantities the server accepts, what the cart
 * holds and for whom, when a quote or a stock hold runs out, and what a
 * refusal of a payment means.
 *
 *   quantities  `min` ≤ q ≤ `max` and q a multiple of `step` — exactly the
 *               server's own test (pricing.ts `priceQuote`), so the picker
 *               never offers a quantity the quote would refuse;
 *   the cart    in memory only, and owned: a cart made under one account is
 *               never shown to another (cartFor), so nothing of one
 *               customer's shopping survives a change of identity — the
 *               lesson of tests/leakAudit_client-bundles_purchase_draft_*;
 *   deadlines   a quote and an order's stock hold are absolute server times;
 *               a passed or unreadable one is never shown as open;
 *   refusals    INSUFFICIENT_BALANCE, ORDER_NOT_PAYABLE and
 *               PAYMENT_ADAPTER_DISABLED read from their codes and details,
 *               never from their wording.
 */
import { ApiError } from '../../../lib/api';
import { toAsciiDigits } from '../../../lib/localeNumber';
import type { Tone } from '../../../components/ui/Badge';
import type { CreditPackage, OrderStatus, PaymentProvider, PricedLine, PrinterModel, PriceTier, QuoteLineInput, StoreProduct, Tri } from '../../types';

// ------------------------------------------------------------------ quantities

/** What the server accepts for one line: whole units, `min` ≤ q ≤ `max`, q a multiple of `step`. */
export interface QuantityRule {
  min: number;
  step: number;
  max: number;
}

const whole = (n: unknown, fallback: number): number => (typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback);
const stepOf = (rule: QuantityRule) => Math.max(1, Math.trunc(rule.step) || 1);

/** A variant's own rule, in its base unit (`min_purchase_qty`, `purchase_step_qty`, `max_purchase_qty`). */
export function variantRule(v: Pick<StoreProduct, 'min_purchase_qty' | 'purchase_step_qty' | 'max_purchase_qty'>): QuantityRule {
  return { min: Math.max(1, whole(v.min_purchase_qty, 1)), step: Math.max(1, whole(v.purchase_step_qty, 1)), max: whole(v.max_purchase_qty, 0) };
}

/** A package's rule: how many of it one order may carry (`min_quantity` … `max_quantity`). */
export function packageRule(p: Pick<CreditPackage, 'min_quantity' | 'max_quantity'>): QuantityRule {
  return { min: Math.max(1, whole(p.min_quantity, 1)), step: 1, max: whole(p.max_quantity, 0) };
}

/** The smallest quantity the server accepts — the first multiple of the step at or above `min` — or null when none is. */
export function firstQuantity(rule: QuantityRule): number | null {
  const step = stepOf(rule);
  const first = Math.ceil(Math.max(1, rule.min) / step) * step;
  return first <= rule.max ? first : null;
}

/** The largest quantity the server accepts, or null when none is. */
export function lastQuantity(rule: QuantityRule): number | null {
  if (firstQuantity(rule) === null) return null;
  const step = stepOf(rule);
  return Math.floor(rule.max / step) * step;
}

/** The server's own test (pricing.ts): a whole number within the range and a multiple of the step. */
export function isValidQuantity(q: number, rule: QuantityRule): boolean {
  return Number.isSafeInteger(q) && q >= rule.min && q <= rule.max && q % stepOf(rule) === 0;
}

/** The accepted quantity nearest to `q` (the first one for anything that is not a figure); null when none is accepted. */
export function snapQuantity(q: number, rule: QuantityRule): number | null {
  const first = firstQuantity(rule);
  const last = lastQuantity(rule);
  if (first === null || last === null) return null;
  if (!Number.isFinite(q)) return first;
  const step = stepOf(rule);
  return Math.min(last, Math.max(first, Math.round(q / step) * step));
}

/** One step up or down from `q` (snapped first), never past either end. */
export function stepQuantity(q: number, rule: QuantityRule, direction: 1 | -1): number | null {
  const base = snapQuantity(q, rule);
  return base === null ? null : snapQuantity(base + direction * stepOf(rule), rule);
}

/** Why a figure was moved to an accepted one: it was under the least, over the most, or between two steps. */
export type MoveReason = 'least' | 'most' | 'step';

export function moveReason(from: number, rule: QuantityRule): MoveReason {
  const first = firstQuantity(rule);
  const last = lastQuantity(rule);
  if (first !== null && from < first) return 'least';
  if (last !== null && from > last) return 'most';
  return 'step';
}

/** The rule with its ceiling lowered to what the workshop can sell right now (`sellable_qty`). */
export function withStock(rule: QuantityRule, sellable: number | null | undefined): QuantityRule {
  if (sellable == null || !Number.isFinite(sellable)) return rule;
  return { ...rule, max: Math.min(rule.max, Math.max(0, Math.trunc(sellable))) };
}

/** The variant's pack sizes (its `pack` price tiers) this rule accepts, smallest first — the quick choices. */
export function packSizes(tiers: readonly PriceTier[], rule: QuantityRule): number[] {
  const sizes = tiers.filter((t) => t.mode === 'pack' && t.pack_price_iqd != null).map((t) => t.min_qty);
  return [...new Set(sizes)].filter((q) => isValidQuantity(q, rule)).sort((a, b) => a - b);
}

/**
 * The cheapest pack a product is sold in, with the price the server states for
 * exactly that pack — a product card's figure. Chosen, never computed: a
 * product with no pack (priced only by quantity) has none, and its card says
 * so. `from` when its variants come in more than one pack or price.
 */
export function cheapestPack(variants: readonly StoreProduct[]): { qty: number; price: number; unit: string; from: boolean } | null {
  const packs = variants.flatMap((v) => {
    const rule = variantRule(v);
    return v.price_tiers
      .filter((t) => t.mode === 'pack' && t.pack_price_iqd != null && isValidQuantity(t.min_qty, rule))
      .map((t) => ({ qty: t.min_qty, price: t.pack_price_iqd as number, unit: v.unit_code }));
  });
  if (packs.length === 0) return null;
  packs.sort((a, b) => a.price - b.price || a.qty - b.qty);
  const distinct = new Set(packs.map((p) => `${p.qty}:${p.price}`));
  return { ...packs[0], from: distinct.size > 1 };
}

/**
 * A package's price per hour, derived ONLY from its own price and seconds and
 * rounded up, so the figure is never under what the package really charges an
 * hour. Null for a package without hours.
 */
export function perHourIqd(p: { price_iqd: number; seconds: number }): number | null {
  if (!(p.seconds > 0) || !Number.isFinite(p.price_iqd)) return null;
  return Math.ceil((p.price_iqd * 3600) / p.seconds);
}

// ------------------------------------------------------------------ the catalogue

export type StoreTab = 'hours' | 'materials' | 'accessories';

/** The tab an address names (`?tab=`), hours by default. */
export function storeTab(param: string | null | undefined): StoreTab {
  return param === 'materials' || param === 'accessories' ? param : 'hours';
}

/** Which category kinds (pc_product_categories.kind) each goods tab shows. */
export const TAB_KINDS: Readonly<Record<Exclude<StoreTab, 'hours'>, readonly string[]>> = {
  materials: ['filament'],
  accessories: ['accessory', 'tool'],
};

/** The goods tab a category kind belongs to. */
export function tabOfKind(kind: string | null | undefined): Exclude<StoreTab, 'hours'> {
  return TAB_KINDS.materials.includes(kind ?? '') ? 'materials' : 'accessories';
}

/** The hour packages of one printer class, with the class's name and the models it prints on (from GET /printers). */
export interface TierGroup {
  tierId: string;
  /** Null when no active printer model names the class: the screen then says «printer class». */
  name: Tri | null;
  models: string[];
  packages: CreditPackage[];
}

/** Packages grouped by their class, in the server's order (GET /packages sorts by class, then the owner's order). */
export function tierGroups(packages: readonly CreditPackage[], models: readonly PrinterModel[]): TierGroup[] {
  const groups = new Map<string, TierGroup>();
  for (const p of packages) {
    let g = groups.get(p.tier_id);
    if (!g) {
      const own = models.filter((m) => m.tier_id === p.tier_id);
      g = { tierId: p.tier_id, name: own[0]?.tier_name ?? null, models: own.map((m) => `${m.brand} ${m.model_name}`.trim()), packages: [] };
      groups.set(p.tier_id, g);
    }
    g.packages.push(p);
  }
  return [...groups.values()];
}

/** One product as the store shows it: its variants (colours, sizes) under one name. */
export interface ProductGroup {
  id: string;
  name: Tri;
  brand: string;
  material: string | null;
  grade: string | null;
  category: string;
  variants: StoreProduct[];
}

/** The catalogue's variants grouped by product, in the server's own order. */
export function groupProducts(rows: readonly StoreProduct[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const v of rows) {
    const g = groups.get(v.product_id);
    if (g) g.variants.push(v);
    else groups.set(v.product_id, { id: v.product_id, name: v.product_name, brand: v.brand, material: v.material, grade: v.grade, category: v.category_code, variants: [v] });
  }
  return [...groups.values()];
}

/** Whether any variant of a product can be bought now: a quantity its rule accepts within the stock on the shelf. */
export function groupPurchasable(g: Pick<ProductGroup, 'variants'>): boolean {
  return g.variants.some((v) => firstQuantity(withStock(variantRule(v), v.sellable_qty)) !== null);
}

/** Lower-cased, the Arabic letter variants folded, spaces collapsed: what a search compares. */
export function foldText(s: string | null | undefined): string {
  return (s ?? '')
    .toLocaleLowerCase('en')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every word of the query appears in one of the fields. An empty query matches everything. */
export function matchesQuery(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const words = foldText(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.map(foldText).join(' ');
  return words.every((w) => hay.includes(w));
}

/** What a product is found by: its names in every language, brand, material, grade, and each variant's names, colour and code. */
export function productFields(g: ProductGroup): string[] {
  const tri = (t: Tri) => [t.ar, t.en, t.ckb];
  return [...tri(g.name), g.brand, g.material ?? '', g.grade ?? '', ...g.variants.flatMap((v) => [...tri(v.name), v.color_name, v.sku])];
}

/** Where a store purchase of a variant can go: kept at the workshop, or delivered (only while delivery is on). `project` belongs to the print flow. */
export function storeModes(v: Pick<StoreProduct, 'fulfillment_modes'>, deliveryEnabled: boolean): Array<'inventory' | 'delivery'> {
  const out: Array<'inventory' | 'delivery'> = [];
  if (v.fulfillment_modes.includes('inventory')) out.push('inventory');
  if (deliveryEnabled && v.fulfillment_modes.includes('delivery')) out.push('delivery');
  return out;
}

// ------------------------------------------------------------------ the cart

/** POST /quotes refuses more than this many lines (pricing.ts `parseQuoteLines`). */
export const CART_MAX_LINES = 25;

export type CartFulfillment = 'credits' | 'inventory' | 'delivery';

/** What a cart line SHOWS — the catalogue's words when it was added. Never a price: prices are asked again. */
export interface CartLabel {
  /** The product's or the package's own name. */
  name: Tri;
  /** A second name: the colour or option of a material, the printer class of hours. */
  detail: Tri | null;
  /** The base unit a material is counted in (`g`, `pc`…); null for hours. */
  unit: string | null;
  /** The colour of a material (the owner's catalogue swatch); null without one. */
  color: string | null;
  /** The hours one package carries; null for a material. */
  seconds: number | null;
}

export interface CartLine {
  /** One line per thing and destination: `package:<id>:credits`, `material:<variant>:inventory`. */
  key: string;
  kind: 'package' | 'material';
  /** The package id or the variant id. */
  ref: string;
  quantity: number;
  fulfillment: CartFulfillment;
  rule: QuantityRule;
  label: CartLabel;
}

export type NewCartLine = Omit<CartLine, 'key'>;

/** The cart and the identity it belongs to (a user id, or null for nobody). */
export interface CartState {
  owner: string | null;
  lines: readonly CartLine[];
}

export const lineKey = (kind: CartLine['kind'], ref: string, fulfillment: CartFulfillment): string => `${kind}:${ref}:${fulfillment}`;

/**
 * THE CART AS `owner` MAY SEE IT. Lines made under another identity — a
 * previous account on this browser, or a session that ended — are never
 * carried over: a new owner starts with an empty cart.
 */
export function cartFor(state: CartState, owner: string | null): CartState {
  return state.owner === owner ? state : { owner, lines: [] };
}

export type AddOutcome = 'added' | 'merged' | 'full' | 'invalid' | 'signed_out';

/**
 * Add a line for `owner`. The same thing for the same destination merges into
 * one line (its quantity capped at the rule's last accepted figure); a
 * quantity the rule refuses is not added; a cart at CART_MAX_LINES takes no
 * new line; nobody signed in has no cart.
 */
export function addToCart(state: CartState, owner: string | null, line: NewCartLine): { state: CartState; outcome: AddOutcome } {
  const mine = cartFor(state, owner);
  if (!owner) return { state: mine, outcome: 'signed_out' };
  const qty = snapQuantity(line.quantity, line.rule);
  const last = lastQuantity(line.rule);
  if (qty === null || last === null || !isValidQuantity(line.quantity, line.rule)) return { state: mine, outcome: 'invalid' };
  const key = lineKey(line.kind, line.ref, line.fulfillment);
  const at = mine.lines.findIndex((l) => l.key === key);
  if (at >= 0) {
    const lines = [...mine.lines];
    lines[at] = { ...line, key, quantity: Math.min(mine.lines[at].quantity + qty, last) };
    return { state: { owner, lines }, outcome: 'merged' };
  }
  if (mine.lines.length >= CART_MAX_LINES) return { state: mine, outcome: 'full' };
  return { state: { owner, lines: [...mine.lines, { ...line, key, quantity: qty }] }, outcome: 'added' };
}

/** Change a line's quantity, snapped to what its rule accepts. */
export function setCartQuantity(state: CartState, owner: string | null, key: string, quantity: number): CartState {
  const mine = cartFor(state, owner);
  return { owner, lines: mine.lines.map((l) => (l.key === key ? { ...l, quantity: snapQuantity(quantity, l.rule) ?? l.quantity } : l)) };
}

/** Take lines out (one removed by hand, or the lines an order was just placed for). */
export function removeFromCart(state: CartState, owner: string | null, keys: readonly string[]): CartState {
  const mine = cartFor(state, owner);
  return { owner, lines: mine.lines.filter((l) => !keys.includes(l.key)) };
}

/**
 * Put a removed line back where it was (the «undo» of a removal), unless the
 * cart has it again or is full. Only into the cart it came out of: an undo
 * never crosses into another identity's cart.
 */
export function restoreCartLine(state: CartState, owner: string | null, line: CartLine, index: number): CartState {
  const mine = cartFor(state, owner);
  if (!owner || state.owner !== owner || mine.lines.some((l) => l.key === line.key) || mine.lines.length >= CART_MAX_LINES) return mine;
  const lines = [...mine.lines];
  lines.splice(Math.max(0, Math.min(index, lines.length)), 0, line);
  return { owner, lines };
}

/** The lines POST /pricing/quote and POST /quotes take for this cart, in its order (line N is the cart's Nth line). */
export function quoteLinesOf(lines: readonly CartLine[]): QuoteLineInput[] {
  return lines.map(
    (l): QuoteLineInput =>
      l.kind === 'package'
        ? { kind: 'credit_package', package_id: l.ref, quantity: l.quantity }
        : { kind: 'material', variant_id: l.ref, quantity: l.quantity, fulfillment: l.fulfillment === 'delivery' ? 'delivery' : 'inventory' }
  );
}

/** The same purchase asked again from a stored quote's own lines — «get a new quote» for one that expired. */
export function quoteInputsOf(lines: readonly PricedLine[]): QuoteLineInput[] {
  return lines.flatMap((l): QuoteLineInput[] => {
    if (l.kind === 'credit_package' && l.package_id) return [{ kind: 'credit_package', package_id: l.package_id, quantity: l.quantity }];
    if (l.kind === 'credit_hours' && l.tier_id) return [{ kind: 'credit_hours', tier_id: l.tier_id, seconds: l.seconds }];
    if (l.kind === 'material' && l.variant_id) {
      if (l.fulfillment === 'project' && l.project_id) return [{ kind: 'material', variant_id: l.variant_id, quantity: l.quantity, fulfillment: 'project', project_id: l.project_id }];
      return [{ kind: 'material', variant_id: l.variant_id, quantity: l.quantity, fulfillment: l.fulfillment === 'delivery' ? 'delivery' : 'inventory' }];
    }
    return [];
  });
}

// ------------------------------------------------------------------ deadlines

export type Deadline = { passed: false; msLeft: number } | { passed: true; msLeft: 0 };

/** Time left before an absolute server time. A missing or unreadable time has PASSED — never shown as open. */
export function deadline(iso: string | null | undefined, now: number): Deadline {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at) || at <= now) return { passed: true, msLeft: 0 };
  return { passed: false, msLeft: at - now };
}

export type QuoteState = { kind: 'open'; msLeft: number } | { kind: 'expired' } | { kind: 'ordered' };

/**
 * Where a stored quote stands. An order is made only from a live quote
 * (orders.ts `planOrderFromQuote`): `ordered` once one was made, `expired`
 * past `expires_at` even while the row still says `open` (no sweep has to
 * run first), or for any status the server does not call open.
 */
export function quoteState(q: { status?: string | null; expires_at: string }, now: number): QuoteState {
  if (q.status === 'ordered') return { kind: 'ordered' };
  if (q.status != null && q.status !== 'open') return { kind: 'expired' };
  const d = deadline(q.expires_at, now);
  return d.passed ? { kind: 'expired' } : { kind: 'open', msLeft: d.msLeft };
}

/** «4:59», «1:02:03»: the time left, floored (never a second more than there is), Latin digits for an LTR isolate. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** A clock reads well up to a day; past that the screen states the moment itself. */
export const CLOCK_LIMIT_MS = 24 * 3600 * 1000;

// ------------------------------------------------------------------ orders and payment

export const ORDER_STATUSES: readonly OrderStatus[] = ['awaiting_payment', 'fulfilled', 'cancelled', 'expired', 'refunded', 'partially_refunded'];
export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = ['levonis_wallet', 'manual', 'gateway', 'dev'];

/** The tone of an order's state: it is said in words too (StatusChip), never by colour alone. */
export const ORDER_TONE: Readonly<Record<OrderStatus, Tone>> = {
  awaiting_payment: 'warning',
  fulfilled: 'success',
  cancelled: 'neutral',
  expired: 'neutral',
  refunded: 'info',
  partially_refunded: 'info',
};

export const orderTone = (status: string): Tone => ORDER_TONE[status as OrderStatus] ?? 'neutral';

/** May this order still be paid here: awaiting payment, before its stock hold runs out (wallet.ts `walletPayability`). */
export function orderPayable(o: { status: string; stock_hold_expires_at: string }, now: number): boolean {
  return o.status === 'awaiting_payment' && !deadline(o.stock_hold_expires_at, now).passed;
}

/** May the customer cancel it: only an order still awaiting payment (orders.ts `closeUnpaidOrder`). */
export const orderCancellable = (o: { status: string }): boolean => o.status === 'awaiting_payment';

export type PayRefusal =
  | { kind: 'insufficient'; available: number | null; required: number | null }
  | { kind: 'not_payable'; reason: 'already_paid' | 'cancelled' | 'expired' | 'shipment' | 'other' }
  | { kind: 'wallet_off' }
  | { kind: 'other' };

/** What a refused wallet payment means, from its code and details (worker/lib/printCloud/wallet.ts). */
export function payRefusal(e: unknown): PayRefusal {
  if (!(e instanceof ApiError)) return { kind: 'other' };
  const d = (e.details ?? {}) as Record<string, unknown>;
  const figure = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (e.code === 'INSUFFICIENT_BALANCE') return { kind: 'insufficient', available: figure(d.available_iqd), required: figure(d.required_iqd) };
  if (e.code === 'ORDER_NOT_PAYABLE') {
    const r = d.reason;
    const reason = r === 'already_paid' || r === 'cancelled' || r === 'expired' ? r : r === 'shipment_not_awaiting_payment' ? 'shipment' : 'other';
    return { kind: 'not_payable', reason };
  }
  if (e.code === 'PAYMENT_ADAPTER_DISABLED') return { kind: 'wallet_off' };
  return { kind: 'other' };
}

/** The cart or quote line a pricing refusal names (`details.line_no`, 1-based), or null. */
export function refusedLine(e: unknown): number | null {
  if (!(e instanceof ApiError)) return null;
  const n = (e.details as { line_no?: unknown } | undefined)?.line_no;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A coupon the server did not accept (`VALIDATION` on the field `coupon`). */
export function couponRefused(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'VALIDATION' && (e.details as { field?: unknown } | undefined)?.field === 'coupon';
}

// ------------------------------------------------------------------ the delivery address

export interface AddressDraft {
  recipient_name: string;
  phone: string;
  governorate: string;
  city: string;
  address_line: string;
  notes: string;
}

export const EMPTY_ADDRESS: AddressDraft = { recipient_name: '', phone: '', governorate: '', city: '', address_line: '', notes: '' };

/** The phone as the server reads it (shipments.ts `parseAddress`): ASCII digits, an optional leading «+», spaces. */
export const phoneForServer = (raw: string): string => toAsciiDigits(raw).replace(/[^\d+ ]/g, '').trim();

/** The fields the server would refuse (shipments.ts `parseAddress`), checked before asking it. */
export function addressProblems(a: AddressDraft): Array<keyof AddressDraft> {
  const out: Array<keyof AddressDraft> = [];
  if (!a.recipient_name.trim()) out.push('recipient_name');
  if (!/^\+?[0-9 ]{7,20}$/.test(phoneForServer(a.phone))) out.push('phone');
  if (!a.governorate) out.push('governorate');
  if (!a.city.trim()) out.push('city');
  if (!a.address_line.trim()) out.push('address_line');
  return out;
}
