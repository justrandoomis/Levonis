/**
 * ACCOUNT — THE RULES THE ACCOUNT SCREENS DRAW WITH, AND NOTHING ELSE.
 *
 * Pure functions over the server's own answers (tests/printCloudUiAccount.test.ts
 * holds them). None of them invents a figure: a balance is the server's, a
 * sum is of two numbers the server sent side by side, and a state is a word
 * for a status the server stored. Where the server does not say something —
 * a conversion ratio, a delivery fee before the request — no rule here
 * guesses it; the screen says it is not known yet.
 */
import type { Tone } from '../../../components/ui/Badge';
import type {
  BuybackSummary,
  CreditTierBalance,
  InventoryBalance,
  PrinterModel,
  ShipmentStatus,
  ShipmentSummary,
  ShipmentView,
  StoreCategory,
  StoreProduct,
  TransactionRow,
  Tri,
} from '../../types';

const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const enc = encodeURIComponent;

// ------------------------------------------------------------------ balances

/**
 * What a balance row says, as four figures: what is still the customer's
 * (`owned` = free + held), what is held, what is free, what was used. `owned`
 * is the one sum, of two numbers the server sent side by side; `available` is
 * ALWAYS the server's own figure — never worked out as owned − held — so the
 * screen can never show a free amount the server did not state.
 */
export interface HeldFigures {
  owned: number | null;
  reserved: number | null;
  available: number | null;
  used: number | null;
}

export function inventoryFigures(row: Pick<InventoryBalance, 'available_qty' | 'reserved_qty' | 'consumed_qty'>): HeldFigures {
  const available = finite(row.available_qty);
  const reserved = finite(row.reserved_qty);
  return { owned: available !== null && reserved !== null ? available + reserved : null, reserved, available, used: finite(row.consumed_qty) };
}

/** The same four figures for one printer class's hours, in seconds. */
export function creditFigures(tier: Pick<CreditTierBalance, 'available_seconds' | 'reserved_seconds' | 'consumed_seconds'>): HeldFigures {
  const available = finite(tier.available_seconds);
  const reserved = finite(tier.reserved_seconds);
  return { owned: available !== null && reserved !== null ? available + reserved : null, reserved, available, used: finite(tier.consumed_seconds) };
}

/**
 * Below the customer's OWN reminder amount. The workshop's default amount is
 * a setting no customer door states, so a row without its own amount is never
 * called low here — the reminder itself still comes from the server.
 */
export function isLow(row: Pick<InventoryBalance, 'available_qty' | 'low_stock_alert_qty'>): boolean {
  return row.low_stock_alert_qty != null && row.available_qty <= row.low_stock_alert_qty;
}

/** Filament counted in grams: the only rows whose quantities may be added together. */
export function filamentGrams(rows: InventoryBalance[]): InventoryBalance[] {
  return rows.filter((r) => r.category_kind === 'filament' && r.unit_code === 'g');
}

// ------------------------------------------------------------------ lots and their expiry

/** An expiry closer than this is drawn as a warning — a presentation choice, never shown as a figure. */
export const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

export type LotExpiry =
  | { kind: 'never' }
  | { kind: 'unknown' }
  | { kind: 'expired'; at: string }
  | { kind: 'soon'; at: string }
  | { kind: 'later'; at: string };

/**
 * A purchase lot's expiry, as the server applies it (credits.ts `goodAt`): a
 * lot with no expiry never expires; one is past its expiry from the instant
 * named, not a day later. A date that cannot be read is said so — never
 * «does not expire».
 */
export function lotExpiry(expiresAt: string | null | undefined, now: number): LotExpiry {
  if (expiresAt == null || expiresAt === '') return { kind: 'never' };
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return { kind: 'unknown' };
  if (at <= now) return { kind: 'expired', at: expiresAt };
  return { kind: at - now <= EXPIRY_WARNING_DAYS * DAY_MS ? 'soon' : 'later', at: expiresAt };
}

/** The tone a lot's expiry line is drawn in: the word carries the meaning, the tone only repeats it. */
export function expiryTone(e: LotExpiry): Tone {
  return e.kind === 'expired' ? 'danger' : e.kind === 'soon' ? 'warning' : 'neutral';
}

// ------------------------------------------------------------------ ledger movements

export type MovementKind = 'in' | 'out' | 'held' | 'returned' | 'used';

/** One ledger row as the customer reads it: which way it moved, and by how much (≥ 0, in the ledger's unit). */
export interface Movement {
  kind: MovementKind;
  amount: number;
}

/**
 * A credit or material ledger row (the two ledgers share their columns) read
 * by its entry type: a hold moves free → held, a release held → free, a use or
 * a hand-over takes what was held (its `delta_consumed`); everything else
 * moves the free balance up or down.
 */
export function ledgerMovement(e: { entry_type: string; delta_available: number; delta_reserved: number; delta_consumed: number }): Movement {
  const abs = (n: number) => Math.abs(finite(n) ?? 0);
  switch (e.entry_type) {
    case 'reserve':
      return { kind: 'held', amount: abs(e.delta_reserved) };
    case 'release':
      return { kind: 'returned', amount: abs(e.delta_available) };
    case 'consume':
    case 'deliver':
    case 'buyback':
      return { kind: 'used', amount: abs(e.delta_consumed) };
    default: {
      const d = finite(e.delta_available) ?? 0;
      return d >= 0 ? { kind: 'in', amount: d } : { kind: 'out', amount: -d };
    }
  }
}

/** The sign written before a movement's figure: the free balance went up, went down, or (a use of what was held) neither. */
export function movementSign(kind: MovementKind): '+' | '−' | '' {
  return kind === 'in' || kind === 'returned' ? '+' : kind === 'out' || kind === 'held' ? '−' : '';
}

// ------------------------------------------------------------------ converting hours

/**
 * Whole hours and minutes the customer typed, as the seconds the server
 * counts. Input only — never a figure shown as the server's. Null for
 * anything that is not two whole numbers with minutes under the hour.
 */
export function typedSeconds(hours: number | null, minutes: number | null): number | null {
  const h = hours ?? 0;
  const m = minutes ?? 0;
  if (!Number.isSafeInteger(h) || !Number.isSafeInteger(m) || h < 0 || m < 0 || m >= 60) return null;
  return h * 3600 + m * 60;
}

/** The server's own floor for a conversion (POST /me/credits/convert: `seconds` ≥ 60). */
export const MIN_CONVERT_SECONDS = 60;

export interface TierOption {
  id: string;
  code: string;
  name: Tri;
}

/**
 * Every printer class the customer could convert into: the ones they hold
 * hours in and the ones the workshop's printers belong to, once each. Which
 * pairs the workshop actually allows is not stated by any customer door —
 * the server answers CONVERSION_DISABLED for a pair it does not allow.
 */
export function tierOptions(tiers: CreditTierBalance[], printers: Pick<PrinterModel, 'tier_id' | 'tier_code' | 'tier_name'>[]): TierOption[] {
  const out = new Map<string, TierOption>();
  for (const t of tiers) out.set(t.tier_id, { id: t.tier_id, code: t.code, name: t.name });
  for (const p of printers) if (!out.has(p.tier_id)) out.set(p.tier_id, { id: p.tier_id, code: p.tier_code, name: p.tier_name });
  return [...out.values()];
}

// ------------------------------------------------------------------ shipments

/** Every status a shipment can hold (migrations/0215_print_cloud.sql, pc_shipments). */
export const SHIPMENT_STATUSES: readonly ShipmentStatus[] = ['awaiting_payment', 'preparing', 'ready_for_pickup', 'shipped', 'delivered', 'picked_up', 'cancelled'];

const SHIPMENT_TONE: Record<ShipmentStatus, Tone> = {
  awaiting_payment: 'warning',
  preparing: 'info',
  ready_for_pickup: 'success',
  shipped: 'info',
  delivered: 'success',
  picked_up: 'success',
  cancelled: 'neutral',
};

export function shipmentTone(status: string): Tone {
  return SHIPMENT_TONE[status as ShipmentStatus] ?? 'neutral';
}

/** The server's own rule (fulfillment.ts `cancelShipmentByCustomer`): only before it leaves the workshop. */
export function shipmentCancellable(status: string): boolean {
  return status === 'awaiting_payment' || status === 'preparing';
}

export type StepState = 'done' | 'current' | 'upcoming';

/**
 * The road a shipment walks, with where it stands on it — for the stepper.
 * A pickup is free and starts at «preparing»; a delivery starts by waiting for
 * its fee only when it has one. A cancelled shipment has no road: null.
 */
export function shipmentSteps(kind: string, status: string, feeIqd: number): Array<{ status: ShipmentStatus; state: StepState }> | null {
  if (status === 'cancelled') return null;
  const road: ShipmentStatus[] =
    kind === 'pickup' ? ['preparing', 'ready_for_pickup', 'picked_up'] : [...(feeIqd > 0 ? (['awaiting_payment'] as const) : []), 'preparing', 'shipped', 'delivered'];
  const at = road.indexOf(status as ShipmentStatus);
  if (at < 0) return null;
  const last = at === road.length - 1;
  return road.map((s, i) => ({ status: s, state: i < at || (last && i === at) ? 'done' : i === at ? 'current' : 'upcoming' }));
}

/**
 * The finished prints already on a shipment that still carries them — every
 * shipment but a cancelled one, whose items the server takes off (`live` 0).
 * Job id → shipment id. A print that has left, or is about to, is not offered
 * again.
 */
export function jobsOnShipments(details: Array<Pick<ShipmentView, 'id' | 'status' | 'items'>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const sh of details) {
    if (sh.status === 'cancelled') continue;
    for (const item of sh.items) {
      const live = Number(item.live ?? 1) === 1;
      if (item.item_type === 'print_job' && live && typeof item.job_id === 'string') out.set(item.job_id, sh.id);
    }
  }
  return out;
}

/** The shipments whose items must be read to know which prints are taken: every one not cancelled. */
export function shipmentsToCheck(list: ShipmentSummary[]): ShipmentSummary[] {
  return list.filter((s) => s.status !== 'cancelled');
}

/** The variants the catalogue lets leave the workshop (`fulfillment_modes` names `delivery`; the server refuses the others). */
export function deliverableVariants(products: Pick<StoreProduct, 'id' | 'fulfillment_modes'>[]): Set<string> {
  return new Set(products.filter((p) => p.fulfillment_modes.includes('delivery')).map((p) => p.id));
}

/** The server's phone rule for a delivery address (shipments.ts `parseAddress`), for an early word — the server still judges. */
export const PHONE_RE = /^\+?[0-9 ]{7,20}$/;

/** The longest each part of an address may be (shipments.ts `parseAddress`). */
export const ADDRESS_MAX = { recipient_name: 120, phone: 20, city: 80, address_line: 300, notes: 300 } as const;

export interface AddressDraft {
  recipient_name: string;
  phone: string;
  governorate: string;
  city: string;
  address_line: string;
  notes: string;
}

export type AddressProblem = 'required' | 'format' | 'too_long';

/**
 * What the server would refuse in this address, part by part — every part
 * but the notes is required, the phone has the server's own shape, the
 * governorate is one of the eighteen ids. The server still judges; this only
 * says it next to the field before the request is sent.
 */
export function addressProblems(a: AddressDraft, governorateIds: ReadonlySet<string>): Partial<Record<keyof AddressDraft, AddressProblem>> {
  const out: Partial<Record<keyof AddressDraft, AddressProblem>> = {};
  for (const key of ['recipient_name', 'phone', 'city', 'address_line'] as const) {
    const v = a[key].trim();
    if (!v) out[key] = 'required';
    else if (v.length > ADDRESS_MAX[key]) out[key] = 'too_long';
  }
  if (!out.phone && !PHONE_RE.test(a.phone.trim())) out.phone = 'format';
  if (!governorateIds.has(a.governorate)) out.governorate = 'required';
  if (a.notes.trim().length > ADDRESS_MAX.notes) out.notes = 'too_long';
  return out;
}

// ------------------------------------------------------------------ buybacks

export const BUYBACK_STATUSES: readonly BuybackSummary['status'][] = ['requested', 'approved', 'rejected', 'cancelled'];
export const PAYOUT_STATUSES: readonly BuybackSummary['payout_status'][] = ['none', 'pending', 'paid'];

const BUYBACK_TONE: Record<BuybackSummary['status'], Tone> = { requested: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };

export function buybackTone(status: string): Tone {
  return BUYBACK_TONE[status as BuybackSummary['status']] ?? 'neutral';
}

/** The server's own rule (buyback.ts `cancelBuyback`): only while the workshop has not decided. */
export function buybackCancellable(status: string): boolean {
  return status === 'requested';
}

/**
 * The categories the workshop buys back and at what rate (basis points of
 * what was paid), from GET /store/categories — the server's switch and rate,
 * per category: accessories never inherit the filament rule.
 */
export function buybackRates(categories: Pick<StoreCategory, 'code' | 'buyback_enabled' | 'buyback_rate_bps'>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of categories) if (Number(c.buyback_enabled) === 1 && Number(c.buyback_rate_bps) > 0) out.set(c.code, Number(c.buyback_rate_bps));
  return out;
}

/** The rows the customer could sell back now: something free, in a category the workshop buys. */
export function sellableRows(rows: InventoryBalance[], rates: Map<string, number>): InventoryBalance[] {
  return rows.filter((r) => r.available_qty > 0 && rates.has(r.category_code));
}

/** Basis points as the percentage they are (5,000 → 50, 3,750 → 37.5). Display only. */
export function bpsPercent(bps: number): number {
  return bps / 100;
}

// ------------------------------------------------------------------ transactions

export const TX_LEDGERS: readonly TransactionRow['ledger'][] = ['credits', 'inventory', 'orders', 'refunds', 'buybacks', 'shipments'];

/** The status a transaction row names (`order_<status>`, `buyback_<status>`, `shipment_<status>`), or null for a ledger entry. */
export function txStatus(row: Pick<TransactionRow, 'ledger' | 'entry_type'>): string | null {
  const prefix = row.ledger === 'orders' ? 'order_' : row.ledger === 'buybacks' ? 'buyback_' : row.ledger === 'shipments' ? 'shipment_' : null;
  return prefix && row.entry_type.startsWith(prefix) ? row.entry_type.slice(prefix.length) : null;
}

/**
 * Where a transaction row leads — only where the server names what its id is:
 * a credit row's `ref_id` is the job's (reports.ts selects `job_id AS ref_id`),
 * an order's `subject_id` the order, a refund's `ref_id` its order, a
 * shipment's `ref_id` the shipment; a material row leads to that material.
 * (A material row's `ref_id` comes without its type, so it leads nowhere.)
 */
export function txHref(row: Pick<TransactionRow, 'ledger' | 'subject_id' | 'ref_id'>): string | null {
  switch (row.ledger) {
    case 'credits':
      return row.ref_id ? `/jobs/${enc(row.ref_id)}` : null;
    case 'inventory':
      return row.subject_id ? `/account/materials/${enc(row.subject_id)}` : null;
    case 'orders':
      return row.subject_id ? `/orders/${enc(row.subject_id)}` : null;
    case 'refunds':
      return row.ref_id ? `/orders/${enc(row.ref_id)}` : null;
    case 'buybacks':
      return '/account/buyback';
    case 'shipments':
      return row.ref_id ? `/account/shipments/${enc(row.ref_id)}` : null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ hand-offs

/**
 * «Top up to N» goes on in the store's cart, carrying the server's stored
 * quote: the cart (src/cloud/pages/store) reads it with GET /quotes/{id} and
 * places the order from it, so the price the customer saw here is the one
 * they pay. Nothing is priced on this side.
 */
export function storeCartLink(quoteId: string): string {
  return `/store/cart?quote=${enc(quoteId)}`;
}

/** The customer's picture on Levonis, or null: the platform's own file path for `avatar_key`. */
export function avatarPath(avatarKey: string | null | undefined): string | null {
  return avatarKey ? `/files/${avatarKey}` : null;
}
