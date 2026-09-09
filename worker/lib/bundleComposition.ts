/**
 * THE COMPOSITION READ MODEL — docs/BUNDLES_MYSTERY.md §2 and §4.
 *
 * Pure functions only. No SQL, no state, no stock arithmetic of its own: this
 * module COMPOSES `resolveStock` (worker/lib/inventory.ts) and
 * `resolveUnitPrice` (packages/pricing) rather than reimplementing either, and
 * that is the whole point — a bundle has no stock and no price of its own, it
 * has an answer computed from real products every time anyone asks.
 *
 * Four rules are load-bearing enough to state before the code:
 *
 * 1. AVAILABILITY IS AGGREGATED PER STOCK ROW, NEVER PER COMPONENT. The
 *    surrogate `bundle_components.id` exists precisely so one product may
 *    appear twice in a bundle, and two components can also resolve to one row
 *    through different routes. Dividing independently advertises stock that
 *    cannot be bought — with 3 units available and two components needing 2
 *    each, each reports floor(3/2) = 1 while ONE bundle needs 4 units. That is
 *    not an oversell (the guards and the fence hold) but the customer gets a
 *    permanent, deterministic CONFLICT_RETRY on a cart nobody is racing, and no
 *    screen can tell them why.
 *
 * 2. THE LADDER IS ANCHORED ON THE DERIVED REGULAR PRICE. In a discount mode
 *    the regular price is derived from the live component total FIRST, and the
 *    member rungs are clamped against THAT. Anchoring on the stored
 *    `products.price_iqd` breaks in a way nothing else could catch: a policy
 *    PRO price is computed from the stored regular and clamped against the same
 *    number, so once the derived regular falls below it a PRO member is charged
 *    more than a regular buyer.
 *
 * 3. A DERIVED PRICE BELOW THE FLOOR DOES NOT CLAMP AND DOES NOT SELL. A
 *    component that went free, or one zero too many in the admin panel, stops
 *    the sale (`OFFER_INACTIVE` plus a loud admin warning) instead of dragging
 *    the bundle to nothing. "Not negative" satisfied at the letter and lost at
 *    the intent is exactly the failure the mandate forbids.
 *
 * 4. NOTHING HERE IS DECIDED BY THE BROWSER. Every value is computed from
 *    stored rows and a server clock; the client classifies nothing.
 */

import { isLowStock, resolveStock, type StockResolution, type StockTarget } from './inventory';
import { clampMemberLadder, resolveUnitPrice, type ProPricingPolicy, type ResolvedPrice, type Tier } from './pricing';
import { effectiveAvailability } from '@levonis/pricing/availability';
import { typeForTransport, type ShippingType } from '@levonis/pricing/shippingType';
import type { OfferCheck } from './offers';
import { newId } from './crypto';
import { HttpError } from './http';
import { parseProductRow, type ProductDoc } from './productModel';
import {
  applyRelations,
  loadRelationsViews,
  snapshotFrom,
  EMPTY_RELATIONS,
  type ProductRelationsView,
} from './productOverlay';

/** A composition row has no `low_stock_threshold` of its own, and inventing one
 *  in the admin panel is the silent repair the mandate forbids. So `low` has an
 *  explicit rule instead: a blocking component that is itself low, or this many
 *  bundles left or fewer. */
export const COMPOSITION_LOW_BUNDLES = 3;

/** How close to `ends_at` a live offer starts saying "ending soon". Decoration
 *  only — the API still refuses an expired offer to the millisecond. */
export const ENDING_SOON_MS = 24 * 60 * 60 * 1000;

/** The physical-line ceiling one order may reach (§3.1). `max_qty_per_order`
 *  reaches 99 and `spool_qty` reaches 20, so one line could otherwise ask for
 *  thousands of `order_items` and inventory statements in a single D1 batch.
 *
 *  WHAT THIS BOUNDS IS ROWS, NOT STATEMENTS, AND THE TWO DIFFER BY ~5×. Each
 *  physical line costs its `order_items` INSERT plus its guarded ledger INSERT
 *  and guarded counter UPDATE; a mystery spool adds a `mystery_allocations`
 *  INSERT on top. So the worst legal order — 250 mystery spools — reaches
 *  roughly 1,200 statements in the one `db.batch` of §3.1, measured at 1,209.
 *  Anyone adding a per-line statement is adding ~250 to that number: check it
 *  against D1's request limits before raising this constant, and update the
 *  figure here. */
export const MAX_PHYSICAL_LINES = 250;

/** Statements one physical line costs inside the checkout batch, used only for
 *  the comment above and for `tests/bundleBatchLimits.test.ts` to assert the
 *  derived bound has not drifted. */
export const STATEMENTS_PER_PHYSICAL_LINE = 5;

export type SaleModeName = 'direct_sale' | 'pre_order';

export interface ResolvedComponent {
  component_id: string;
  member_product_id: string;
  qty_per_bundle: number;
  optional: boolean;
  included: boolean;
  selection: { option_value_ids: string[]; color_id: string | null };
  /** worker/lib/inventory.ts — the member product's REAL stock answer. */
  resolution: StockResolution;
  /** packages/pricing — the member product's standalone price at this tier. */
  unit: ResolvedPrice;
  /** The member product's own sale types, so the bundle's fulfilment modes are
   *  read off its components rather than off the 'bundle' token (§2.4). */
  sale_types: string[];
  shipping_type: ShippingType;
}

export type CompositionState =
  | 'in_stock'
  | 'low'
  | 'sold_out'
  | 'upcoming'
  | 'ending_soon'
  | 'ended'
  | 'preorder'
  | 'locked'
  | 'member_exclusive'
  | 'unconfigured';

export interface CompositionBlocker {
  component_id: string;
  product_id: string;
  available: number;
  needed: number;
  reason: string;
}

export interface CompositionAvailability {
  /** ONE server verdict, used by the card, the detail page, the cart and the
   *  door, so they can never disagree. */
  state: CompositionState;
  /** null = every required component is untracked (nothing bounds the sale). */
  max_bundles: number | null;
  blocking: CompositionBlocker[];
  shipping_type: ShippingType | 'mixed';
  /** The fulfilment modes the REQUIRED components actually offer (§2.4). A
   *  bundle whose required components are all pre-order reports ['pre_order']
   *  and gets no direct-sale button. */
  modes: SaleModeName[];
  /** True whenever the offer is tier-gated AND this viewer is entitled — so a
   *  card can badge "yours" on top of a `low` or `preorder` state instead of
   *  losing the more urgent fact to the badge. */
  member_exclusive: boolean;
  errors: string[];
}

const availableOf = (t: StockTarget): number | null =>
  t.stock === null ? null : Math.max(0, t.stock - Math.max(0, t.reserved));

const modeOf = (c: ResolvedComponent): SaleModeName => {
  const eff = effectiveAvailability({ availability_type: '' }, c.sale_types);
  if (eff === 'pre_order') return 'pre_order';
  if (eff === 'direct_sale') return 'direct_sale';
  // The member sells both ways and no option narrowed it: the transport method
  // frozen onto the component is what the line is actually on.
  return c.shipping_type === 'direct' ? 'direct_sale' : 'pre_order';
};

/**
 * THE SCARCEST COMPONENT, and nothing more.
 *
 * The owner's worked example: printer available 5, qty 1 → 5; filament
 * available 6, qty 2 → 3; nozzle available 20, qty 1 → 20; min(5, 3, 20) = 3.
 *
 * Optional components the buyer DECLINED never lower `max_bundles` and never
 * appear in the snapshot. An optional component the buyer OPTED INTO and that
 * cannot be satisfied is refused by the door (`BUNDLE_OPTIONAL_UNAVAILABLE`),
 * never dropped — dropping it would change what the customer bought after they
 * pressed Place order, at the full price.
 *
 * Pre-order components are exempt from the stock test exactly as an ordinary
 * pre-order line is: an untracked pre-order component contributes nothing. A
 * TRACKED pre-order component still reserves normally, so it still counts.
 */
export function bundleAvailability(
  components: ResolvedComponent[],
  window: { starts_at: string | null; ends_at: string | null; nowMs: number },
  active: boolean,
  offer: OfferCheck
): CompositionAvailability {
  const errors: string[] = [];
  const blocking: CompositionBlocker[] = [];
  // Every INCLUDED component counts — required ones always, and an optional one
  // the buyer opted into, because it is refused rather than dropped when it
  // cannot be satisfied. A declined optional component lowers nothing and
  // appears nowhere.
  const counted = components.filter((c) => c.included);

  // ---- fulfilment modes and shipping type, from the REQUIRED components ----
  const modeSet = new Set<SaleModeName>();
  const shippingSet = new Set<ShippingType>();
  for (const c of counted) {
    modeSet.add(modeOf(c));
    shippingSet.add(c.shipping_type);
  }
  const modes: SaleModeName[] = (['direct_sale', 'pre_order'] as SaleModeName[]).filter((m) => modeSet.has(m));
  const shipping: ShippingType | 'mixed' =
    shippingSet.size === 0 ? 'direct' : shippingSet.size === 1 ? [...shippingSet][0] : 'mixed';
  if (shippingSet.size > 1) errors.push('BUNDLE_SHIPPING_MIXED');

  // ---- demand, SUMMED per (scope, scope_id) -------------------------------
  const demand = new Map<string, { needed: number; available: number | null; component_id: string; product_id: string }>();
  let hardZero = false;
  for (const c of counted) {
    if (c.resolution.error) {
      hardZero = true;
      blocking.push({
        component_id: c.component_id,
        product_id: c.member_product_id,
        available: 0,
        needed: c.qty_per_bundle,
        reason: c.resolution.error,
      });
      errors.push(c.resolution.error);
      continue;
    }
    // An UNTRACKED pre-order component bounds nothing — that is how a pre-order
    // bundle sells with no physical stock, with no new concept and no invented
    // inventory.
    if (modeOf(c) === 'pre_order' && c.resolution.available === null) continue;
    for (const t of c.resolution.targets) {
      // BASE stock lives on the product row itself, so its scope_id is '' and
      // the product id is what identifies the row — exactly as `planInventory`
      // resolves it. Keying on the scope alone would merge every BASE component
      // in the bundle into one imaginary shared row.
      const key = `${t.scope}:${t.scope_id || c.member_product_id}`;
      const found = demand.get(key);
      if (found) found.needed += c.qty_per_bundle;
      else
        demand.set(key, {
          needed: c.qty_per_bundle,
          available: availableOf(t),
          component_id: c.component_id,
          product_id: c.member_product_id,
        });
    }
  }

  let maxBundles: number | null = null;
  for (const [, d] of demand) {
    if (d.available === null) continue; // untracked: claims no limit
    const candidate = Math.floor(d.available / Math.max(1, d.needed));
    if (candidate <= 0) {
      blocking.push({
        component_id: d.component_id,
        product_id: d.product_id,
        available: d.available,
        needed: d.needed,
        reason: 'OUT_OF_STOCK',
      });
    }
    maxBundles = maxBundles === null ? candidate : Math.min(maxBundles, candidate);
  }
  if (hardZero) maxBundles = 0;

  // ---- the ONE state, top down --------------------------------------------
  const schedule = scheduleWindowState(window.starts_at, window.ends_at, window.nowMs);
  const gated = offer.required_tiers.length > 0;
  const entitled = gated && offer.ok;

  let state: CompositionState;
  if (counted.length === 0) {
    state = 'unconfigured';
  } else if (!active) {
    // Not a schedule fact, but the honest customer-facing answer is the same:
    // this offer is not running. The listing filters it out entirely.
    state = 'ended';
    errors.push('OFFER_INACTIVE');
  } else if (schedule === 'ended') {
    state = 'ended';
  } else if (schedule === 'upcoming') {
    state = 'upcoming';
  } else if (!offer.ok && offer.reason === 'MEMBERSHIP_REQUIRED') {
    state = 'locked';
  } else if (!offer.ok) {
    state = 'ended';
    if (offer.reason) errors.push(offer.reason);
  } else if (maxBundles !== null && maxBundles <= 0) {
    state = 'sold_out';
  } else if (modes.length === 1 && modes[0] === 'pre_order') {
    state = 'preorder';
  } else if (endingSoon(window.ends_at, window.nowMs)) {
    state = 'ending_soon';
  } else if (isLow(counted, maxBundles)) {
    state = 'low';
  } else {
    state = 'in_stock';
  }
  if (state === 'in_stock' && entitled) state = 'member_exclusive';

  return {
    state,
    max_bundles: maxBundles,
    blocking,
    shipping_type: shipping,
    modes,
    member_exclusive: entitled,
    errors: [...new Set(errors)],
  };
}

/** Local copy of the schedule verdict so this module stays free of database
 *  reads; `worker/lib/offers.ts` owns the same rule for the offer itself. */
function scheduleWindowState(startsAt: string | null, endsAt: string | null, nowMs: number): 'upcoming' | 'live' | 'ended' {
  const start = startsAt ? Date.parse(startsAt) : NaN;
  const end = endsAt ? Date.parse(endsAt) : NaN;
  if (Number.isFinite(start) && nowMs < start) return 'upcoming';
  if (Number.isFinite(end) && nowMs > end) return 'ended';
  return 'live';
}

function endingSoon(endsAt: string | null, nowMs: number): boolean {
  if (!endsAt) return false;
  const end = Date.parse(endsAt);
  return Number.isFinite(end) && end - nowMs <= ENDING_SOON_MS && end >= nowMs;
}

function isLow(components: ResolvedComponent[], maxBundles: number | null): boolean {
  if (maxBundles !== null && maxBundles <= COMPOSITION_LOW_BUNDLES) return true;
  return components.some((c) => !c.resolution.error && isLowStock(c.resolution));
}

// ------------------------------------------------------------------- pricing

export interface BundlePriceConfig {
  price_mode: string;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  min_price_iqd: number;
}

export interface BundlePriceResult {
  /** The MERCHANDISE figure — what `merchandise`, the points basis, the coupon
   *  minimum and the accrual all see. Never includes a fee. */
  bundle_price_iqd: number;
  /** What the line costs: merchandise plus the fees the resolver computed for
   *  the bundle row, plus the components' own effective fees (§2.2). */
  unit_subtotal_iqd: number;
  regular_iqd: number;
  prime_iqd: number | null;
  pro_iqd: number | null;
  plus_iqd: number | null;
  applied_tier: 'regular' | 'plus' | 'prime' | 'pro';
  component_total_iqd: number;
  discount_iqd: number;
  saving_percent: number;
  errors: string[];
}

export function resolveBundlePrice(input: {
  /** From `resolveUnitPrice` on the bundle product row — the fee logic, the PRO
   *  waivers and `pricing_basis` are inherited, never reimplemented. */
  resolved: ResolvedPrice;
  config: BundlePriceConfig;
  componentTotalIqd: number;
  tier: Tier;
  /** `pricingTierContext(...).pricingTierActive` — never `tierStatus.active`
   *  and never `tier === 'pro'`. A PRO away from their approved default address
   *  pays the regular bundle price, exactly as they do for a product. */
  tierActive: boolean;
  /** The components' effective pre-order commissions and direct surcharges,
   *  charged on the parent so the store never eats the air-versus-sea
   *  difference (§2.2). Merchandise deliberately excludes them. */
  componentFeesIqd?: number;
}): BundlePriceResult {
  const { resolved, config } = input;
  const errors: string[] = [];
  const componentTotal = Math.max(0, Math.trunc(input.componentTotalIqd));
  const floorIqd = Math.max(1, Math.trunc(config.min_price_iqd || 1));

  // ---- the regular price: the row's own, or DERIVED from the live total ----
  let regular = Math.max(0, Math.trunc(resolved.regular_iqd));
  let derived = false;
  if (config.price_mode === 'discount_percent') {
    derived = true;
    const p = Math.trunc(config.discount_percent ?? 0);
    if (!(p >= 1 && p <= 90)) errors.push('BUNDLE_VALIDATION');
    const pct = Math.min(90, Math.max(1, p));
    regular = Math.max(0, Math.floor((componentTotal * (100 - pct)) / 100));
  } else if (config.price_mode === 'discount_iqd') {
    derived = true;
    const d = Math.max(0, Math.trunc(config.discount_iqd ?? 0));
    regular = componentTotal - d;
  }

  // A DERIVED price below the floor does not clamp and does not sell.
  if (derived && regular < floorIqd) {
    errors.push('DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE');
    regular = Math.max(0, regular);
  }

  // ---- the member ladder, clamped against THAT regular ---------------------
  const { prime, pro } = clampMemberLadder(regular, resolved.prime_iqd, resolved.pro_iqd);
  let plus: number | null =
    config.plus_price_iqd === null || config.plus_price_iqd === undefined
      ? null
      : Math.max(0, Math.trunc(config.plus_price_iqd));
  if (plus !== null) {
    plus = Math.min(plus, regular);
    if (prime !== null) plus = Math.max(plus, prime);
    if (pro !== null) plus = Math.max(plus, pro);
  }

  let applied = regular;
  let appliedTier: BundlePriceResult['applied_tier'] = 'regular';
  if (input.tier === 'pro' && input.tierActive && pro !== null) {
    applied = pro;
    appliedTier = 'pro';
  } else if (input.tier === 'prime' && input.tierActive && prime !== null) {
    applied = prime;
    appliedTier = 'prime';
  } else if (input.tier === 'plus' && input.tierActive && plus !== null) {
    applied = plus;
    appliedTier = 'plus';
  }

  // The fees the resolver already computed for this line, kept exactly as it
  // computed them: `unit_subtotal − applied` is the commission, the direct
  // premium and the warranty fee, with every PRO waiver already applied.
  const feesFromResolver = Math.max(0, resolved.unit_subtotal_iqd - resolved.applied_iqd);
  const componentFees = Math.max(0, Math.trunc(input.componentFeesIqd ?? 0));

  const discount = Math.max(0, componentTotal - applied);
  return {
    bundle_price_iqd: applied,
    unit_subtotal_iqd: applied + feesFromResolver + componentFees,
    regular_iqd: regular,
    prime_iqd: prime,
    pro_iqd: pro,
    plus_iqd: plus,
    applied_tier: appliedTier,
    component_total_iqd: componentTotal,
    discount_iqd: discount,
    saving_percent: componentTotal > 0 ? Math.round((discount * 100) / componentTotal) : 0,
    errors: [...new Set(errors)],
  };
}

// ------------------------------------------------------------ line identity

/**
 * The cart-line identity of one set of component choices — computed
 * SERVER-SIDE only, exactly as `comboKey` is. A client-supplied key is ignored.
 *
 * It rides in `cart_items.option_id`, which is structurally free on a
 * composition row (a composition product has no option groups and no JSON
 * options), so the partial unique index `idx_cart_levonis_line` and the
 * `ON CONFLICT(...)` upsert are untouched — the exact operation
 * migrations/0032_cart_line_identity.sql exists because of. `option_id` on a
 * composition row is line identity and NOTHING ELSE: `selectionFromCartRow`
 * returns an empty selection for such a row so the key never reaches the price
 * resolver or `saleAvailability`.
 */
export function compositionKey(
  choices: Array<{ component_id: string; option_value_ids: string[]; color_id: string | null; included: boolean }>
): string {
  const canonical = choices
    .map((ch) => {
      const opts = [...ch.option_value_ids].filter(Boolean).sort().join(',');
      return `${ch.component_id}:${opts}:${ch.color_id ?? ''}:${ch.included ? 1 : 0}`;
    })
    .sort()
    .join('|');
  return `bx_${fnv1a64(canonical)}`;
}

/** 64-bit FNV-1a. Deterministic, dependency-free and synchronous — the add-to-cart
 *  path builds the key before it upserts, and WebCrypto's digest is async. */
function fnv1a64(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

// --------------------------------------------------------------- allocation

/**
 * LARGEST-REMAINDER allocation of the parent line total across components in
 * proportion to their standalone values, so `Σ alloc === total` EXACTLY with no
 * runtime rounding left over. It is stored, never re-derived, and it is what a
 * return refunds. When every value is 0 the split is uniform — there is no
 * proportion to honour, and refusing would leave a free bundle unreturnable.
 */
export function allocateComponentValue(total: number, values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const target = Math.max(0, Math.trunc(total));
  const clean = values.map((v) => Math.max(0, Math.trunc(v)));
  const sum = clean.reduce((a, b) => a + b, 0);

  const shares = new Array<number>(n).fill(0);
  const remainders: Array<{ i: number; rem: number }> = [];
  let assigned = 0;
  for (let i = 0; i < n; i += 1) {
    const exact = sum > 0 ? (target * clean[i]) / sum : target / n;
    const floor = Math.floor(exact);
    shares[i] = floor;
    assigned += floor;
    remainders.push({ i, rem: exact - floor });
  }
  // Ties go to the earlier component, so the split is stable across calls.
  remainders.sort((a, b) => (b.rem === a.rem ? a.i - b.i : b.rem - a.rem));
  let left = target - assigned;
  for (let k = 0; k < remainders.length && left > 0; k += 1) {
    shares[remainders[k].i] += 1;
    left -= 1;
  }
  // A pathological input (n larger than the remainder ring) can only ever leave
  // whole units, and they go to the largest share rather than being dropped.
  let guard = 0;
  while (left > 0 && guard < n * 2) {
    shares[guard % n] += 1;
    left -= 1;
    guard += 1;
  }
  return shares;
}

// ------------------------------------------------------------- batched load

export interface BundleComponentRow {
  id: string;
  bundle_product_id: string;
  member_product_id: string;
  qty: number;
  optional: boolean;
  option_value_ids: string[];
  color_id: string;
  customer_picks_option: boolean;
  customer_picks_color: boolean;
  sort: number;
}

export interface BundleComponentChoiceRow {
  component_id: string;
  dim: 'option_value' | 'color';
  ref_id: string;
  sort: number;
}

export interface LoadedComposition {
  byBundle: Map<string, BundleComponentRow[]>;
  choicesByComponent: Map<string, BundleComponentChoiceRow[]>;
}

const LOAD_CHUNK = 50;

/**
 * Components and their allow-lists for many bundles in ONE chunked query —
 * the second of the four batched reads that serve a whole bundles page (§14).
 * Never one round trip per card, and never one per component.
 *
 * The allow-list rides back on the same row through `group_concat`, because a
 * second `SELECT … WHERE component_id IN (…)` would be a fifth round trip on a
 * page §14 budgets at four, and a customer-selectable component cannot be
 * priced or judged for stock without knowing WHICH values it may be chosen
 * from. The separators are ASCII 31 (unit) and 30 (record) — control
 * characters no id, dim or sort value can contain — so the concatenation is
 * unambiguous rather than "probably no id has a comma in it".
 */
export async function loadBundleComponents(db: D1Database, bundleProductIds: string[]): Promise<LoadedComposition> {
  const byBundle = new Map<string, BundleComponentRow[]>();
  const choicesByComponent = new Map<string, BundleComponentChoiceRow[]>();
  const ids = [...new Set(bundleProductIds.filter(Boolean))];
  if (ids.length === 0) return { byBundle, choicesByComponent };

  const rows: BundleComponentRow[] = [];
  for (let i = 0; i < ids.length; i += LOAD_CHUNK) {
    const part = ids.slice(i, i + LOAD_CHUNK);
    const { results } = await db
      .prepare(
        `SELECT bc.id, bc.bundle_product_id, bc.member_product_id, bc.qty, bc.optional,
                bc.option_value_ids, bc.color_id, bc.customer_picks_option, bc.customer_picks_color, bc.sort,
                group_concat(ch.dim || char(31) || ch.ref_id || char(31) || ch.sort, char(30)) AS choices
           FROM bundle_components bc
           LEFT JOIN bundle_component_choices ch ON ch.component_id = bc.id
          WHERE bc.bundle_product_id IN (${part.map(() => '?').join(', ')})
          GROUP BY bc.id
          ORDER BY bc.sort, bc.id`
      )
      .bind(...part)
      .all<Record<string, unknown>>();
    for (const r of results) {
      const id = String(r.id);
      rows.push({
        id,
        bundle_product_id: String(r.bundle_product_id),
        member_product_id: String(r.member_product_id),
        qty: Number(r.qty) || 1,
        optional: !!r.optional,
        option_value_ids: parseIdList(r.option_value_ids),
        color_id: String(r.color_id ?? ''),
        customer_picks_option: !!r.customer_picks_option,
        customer_picks_color: !!r.customer_picks_color,
        sort: Number(r.sort) || 0,
      });
      const choices = parseChoiceBlob(id, r.choices);
      if (choices.length) choicesByComponent.set(id, choices);
    }
  }
  for (const r of rows) {
    const arr = byBundle.get(r.bundle_product_id);
    if (arr) arr.push(r);
    else byBundle.set(r.bundle_product_id, [r]);
  }
  return { byBundle, choicesByComponent };
}

/** The `group_concat` blob above, back into rows. A malformed record is
 *  DROPPED rather than guessed at — an allow-list is a permission list, and
 *  inventing an entry would widen it. */
function parseChoiceBlob(componentId: string, raw: unknown): BundleComponentChoiceRow[] {
  if (typeof raw !== 'string' || raw === '') return [];
  const out: BundleComponentChoiceRow[] = [];
  for (const record of raw.split('\u001e')) {
    const [dim, refId, sort] = record.split('\u001f');
    if (!refId) continue;
    if (dim !== 'color' && dim !== 'option_value') continue;
    out.push({ component_id: componentId, dim, ref_id: refId, sort: Number(sort) || 0 });
  }
  return out.sort((a, b) => (a.sort === b.sort ? (a.ref_id < b.ref_id ? -1 : 1) : a.sort - b.sort));
}

/** Stored JSON id lists are always sorted server-side; a malformed value is an
 *  empty list, never a thrown error on a read path. */
function parseIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  try {
    const parsed = JSON.parse(String(raw ?? '[]')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').sort() : [];
  } catch {
    return [];
  }
}

// =========================================================================
// THE ADMIN PLAN — §4.7 (refusals), §11.2 (one plan, one batch), §11.3
// (warnings, verbatim and trilingual, never repaired)
// =========================================================================
//
// Everything below is the WRITE side of the module the storefront reads, and
// it exists here rather than in the panel for one reason: the preview an admin
// is shown and the verdict a customer gets must come from the same functions.
// Nothing is computed in the browser, and no configuration is silently
// repaired — an invalid bundle is REFUSED, with the reason named, in three
// languages.

/**
 * One admin-facing line, in the ONE shape both existing decoders already
 * understand (`refusalIssues` and `strList`,
 * `src/components/adminProducts/applyResult.ts`).
 *
 * `message` is not decoration. `refusalIssues` renders
 * `${line}${key}${message}`, so an entry without one prints the literal string
 * "undefined" to the admin; `ProductForm` joins warnings with ' · ', so an
 * object with no string form renders "[object Object]". The three warnings the
 * owner quoted word for word would never reach a human without this field.
 * `ar`/`en`/`ckb` carry all three languages for the panel's `Banner`.
 */
export interface BundleIssue {
  code: string;
  message: string;
  key?: string;
  line?: number;
  ar: string;
  en: string;
  ckb: string;
  component_id?: string;
}

/**
 * The sentences, verbatim. §11.3 quotes the English of several of these word
 * for word; the Arabic and Kurdish are the same sentence, not a paraphrase.
 * `{…}` placeholders are filled from the caller's values — never from anything
 * a browser sent.
 */
const ISSUE_TEXT: Record<string, { ar: string; en: string; ckb: string }> = {
  // ---- warnings -----------------------------------------------------------
  COMPONENT_SHORT: {
    ar: 'الحزمة تحتاج {needed} وحدة من «{name}» لكن المتوفر {available} فقط',
    en: 'the bundle needs {needed} units of {name} but only {available} is available',
    ckb: 'پاکێجەکە پێویستی بە {needed} یەکە لە «{name}» هەیە بەڵام تەنها {available} بەردەستە',
  },
  PRICE_ABOVE_COMPONENTS: {
    ar: 'هذه الحزمة أغلى من شراء مكوّناتها منفردة',
    en: 'this bundle costs more than buying the parts',
    ckb: 'ئەم پاکێجە گرانترە لە کڕینی پارچەکانی بە جیا',
  },
  MIGRATED_NEEDS_PRICE: {
    ar: 'هذه الحزمة كانت قائمة عرض بلا سعر — حدّد سعرًا قبل النشر',
    en: 'this bundle was a display list with no price — set one before publishing',
    ckb: 'ئەم پاکێجە لیستی پیشاندان بوو بەبێ نرخ — پێش بڵاوکردنەوە نرخێکی بۆ دابنێ',
  },
  DERIVED_PRICE_DRIFT: {
    ar: 'السعر المخزّن في المنتج لم يعد مطابقًا للسعر المشتق من المكوّنات ({stored} ↔ {derived}) — يُستخدم للفرز والبحث فقط',
    en: 'the stored product price no longer matches the derived bundle price ({stored} ↔ {derived}) — it is the sort and search key only',
    ckb: 'نرخی هەڵگیراوی بەرهەم چیتر لەگەڵ نرخی دەرهێنراوی پاکێجدا یەک ناگرێتەوە ({stored} ↔ {derived}) — تەنها بۆ ڕیزکردن و گەڕان بەکاردێت',
  },
  DERIVED_PRICE_BELOW_FLOOR: {
    ar: 'السعر المشتق نزل تحت الحد الأدنى — هذه الحزمة لا تُباع الآن',
    en: 'the derived price has fallen below the minimum price — this bundle is not being sold',
    ckb: 'نرخی دەرهێنراو لە کەمترین نرخ داکەوتووە — ئەم پاکێجە ئێستا نافرۆشرێت',
  },
  COMPONENT_PRODUCT_INACTIVE: {
    ar: 'المكوّن «{name}» مسودة أو مخفي، فلن تُباع الحزمة به',
    en: 'the component {name} is draft or hidden, so the bundle cannot be sold with it',
    ckb: 'پێکهاتەی «{name}» ڕەشنووس یان شاراوەیە، بۆیە پاکێجەکە پێی نافرۆشرێت',
  },
  // ---- refusals -----------------------------------------------------------
  BUNDLE_VALIDATION: {
    ar: '{why}',
    en: '{why}',
    ckb: '{why}',
  },
  BUNDLE_NO_COMPONENTS: {
    ar: 'الحزمة تحتاج مكوّنًا واحدًا على الأقل',
    en: 'a bundle needs at least one component',
    ckb: 'پاکێج پێویستی بە لانیکەم یەک پێکهاتە هەیە',
  },
  BUNDLE_SHIPPING_MIXED: {
    ar: 'المكوّنان «{a}» و«{b}» لهما نوعا شحن مختلفان؛ السلة تحمل نوعًا واحدًا فقط',
    en: 'the components {a} and {b} have different shipping types, and a cart holds exactly one',
    ckb: 'پێکهاتەکانی «{a}» و «{b}» جۆری گەیاندنی جیاوازیان هەیە، سەبەتەش تەنها یەک جۆر هەڵدەگرێت',
  },
  BUNDLE_NESTING_NOT_ALLOWED: {
    ar: 'لا يمكن أن يكون المكوّن «{name}» حزمة أخرى',
    en: 'the component {name} is itself a composition product, and a bundle cannot contain a bundle',
    ckb: 'پێکهاتەی «{name}» خۆی پاکێجێکە، و پاکێج ناتوانێت پاکێجی تێدابێت',
  },
  COMPONENT_SELECTION_INVALID: {
    ar: 'اختيار المكوّن «{name}» غير صالح: {why}',
    en: 'the selection for component {name} is invalid: {why}',
    ckb: 'هەڵبژاردنی پێکهاتەی «{name}» نادروستە: {why}',
  },
  VARIANT_NOT_MODELLED: {
    ar: 'المكوّن «{name}» لا يملك تركيبة مخزون لهذا الاختيار',
    en: 'the component {name} has no stock combination modelled for this selection',
    ckb: 'پێکهاتەی «{name}» هیچ تێکەڵەیەکی کۆگای بۆ ئەم هەڵبژاردنە دانەنراوە',
  },
  MEMBER_LADDER_INVERTED: {
    ar: 'سلّم الأسعار مقلوب: يجب أن يكون PRO ≤ PRIME ≤ PLUS ≤ السعر العادي',
    en: 'the member ladder is inverted: PRO must be ≤ PRIME ≤ PLUS ≤ the regular price',
    ckb: 'پێپلیکانەی نرخ پێچەوانەیە: دەبێت PRO ≤ PRIME ≤ PLUS ≤ نرخی ئاسایی بێت',
  },
  SCHEDULE_INVERTED: {
    ar: 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء',
    en: 'the end date must be after the start date',
    ckb: 'بەرواری کۆتایی دەبێت دوای بەرواری دەستپێک بێت',
  },
  BUNDLE_DISCOUNT_EXCEEDS_TOTAL: {
    ar: 'الخصم {discount} يساوي أو يتجاوز قيمة المكوّنات {total} — لن تُنشر حزمة مجانية',
    en: 'the discount {discount} is at or above the component total {total} — a free bundle is never published',
    ckb: 'داشکاندنی {discount} یەکسان یان زیاترە لە کۆی پێکهاتەکان {total} — پاکێجی خۆڕایی بڵاو ناکرێتەوە',
  },
  OFFER_PRICE_CONFLICT: {
    ar: 'العرض يحمل سعرًا بينما الحزمة تشتق سعرها من مكوّناتها — سعر واحد فقط لكل عرض',
    en: 'the window sets a price while the bundle derives one from its components — an offer has exactly one price',
    ckb: 'پەنجەرەکە نرخێک دادەنێت لە کاتێکدا پاکێجەکە نرخی لە پێکهاتەکانی دەردەهێنێت — هەر ئۆفەرێک تەنها یەک نرخی هەیە',
  },
  COMPOSITION_TOO_LARGE: {
    ar: 'الحزمة ستنتج {lines} سطرًا في طلب واحد، والحد {max}',
    en: 'this bundle would produce {lines} physical lines in one order, and the ceiling is {max}',
    ckb: 'ئەم پاکێجە {lines} هێڵ لە یەک داواکاریدا دروست دەکات، سنووریش {max}ە',
  },
};

/** Builds one issue in the shape both decoders understand. Unknown codes are
 *  impossible by construction: the table above is the checklist. */
export function bundleIssue(
  code: keyof typeof ISSUE_TEXT | string,
  vars: Record<string, string | number> = {},
  extra: { key?: string; line?: number; component_id?: string } = {}
): BundleIssue {
  const t = ISSUE_TEXT[code] ?? { ar: code, en: code, ckb: code };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));
  const en = fill(t.en);
  return {
    code,
    // The admin shell runs in English today, so `message` is the English
    // sentence; it is what `refusalIssues` prints and what `strList` keeps.
    message: en,
    ar: fill(t.ar),
    en,
    ckb: fill(t.ckb),
    ...extra,
  };
}

// ------------------------------------------------------------------ inputs

export interface BundleComponentInput {
  /** Kept across an edit so a cart line's stored choices still resolve. */
  id?: string;
  member_product_id: string;
  qty: number;
  optional: boolean;
  option_value_ids: string[];
  color_id: string;
  customer_picks_option: boolean;
  customer_picks_color: boolean;
  sort: number;
  /** The allow-list a customer-selectable dimension may be chosen from. Empty
   *  = "any active value of that dimension". */
  choice_option_value_ids: string[];
  choice_color_ids: string[];
}

export interface BundleConfigInput {
  price_mode: 'fixed' | 'discount_percent' | 'discount_iqd';
  discount_percent: number | null;
  discount_iqd: number | null;
  min_price_iqd: number;
  plus_price_iqd: number | null;
  max_qty_per_order: number;
}

/** The subset of the offer window the admin save validates and writes. */
export interface BundleOfferInput {
  starts_at: string | null;
  ends_at: string | null;
  required_tiers: string[];
  offer_price_mode: '' | 'fixed' | 'discount_percent' | 'discount_iqd';
  offer_price_iqd: number | null;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  locked_preview: boolean;
  active: boolean;
  max_per_user: number | null;
  max_global: number | null;
}

/** What the resolver needs, structurally — never the whole route context. */
export interface CompositionPricingCtx {
  tier: Tier;
  tierActive: boolean;
  proPolicy: ProPricingPolicy;
  transportDefaults: Array<{ method: string; commission_iqd: number }>;
}

export interface ComponentPreview {
  component_id: string;
  member_product_id: string;
  name: string;
  name_ar: string;
  status: string;
  qty_per_bundle: number;
  optional: boolean;
  customer_picks_option: boolean;
  customer_picks_color: boolean;
  option_value_ids: string[];
  color_id: string;
  unit_iqd: number;
  line_value_iqd: number;
  available: number | null;
  shipping_type: ShippingType;
  /** Admin-only: `projectForAdmin` strips it for an assistant admin (§11.4). */
  cost_iqd: number | null;
}

export interface CompositionPreview {
  component_total_iqd: number;
  bundle_price_iqd: number;
  regular_iqd: number;
  prime_iqd: number | null;
  pro_iqd: number | null;
  plus_iqd: number | null;
  applied_tier: BundlePriceResult['applied_tier'];
  discount_iqd: number;
  saving_percent: number;
  availability: CompositionAvailability;
  components: ComponentPreview[];
}

export type BundleCompositionPlan =
  | { errors: BundleIssue[]; statements?: undefined }
  | { errors: never[]; statements: D1PreparedStatement[]; warnings: BundleIssue[]; preview: CompositionPreview };

// ---------------------------------------------------------------- resolving

export interface MemberRow {
  row: Record<string, unknown>;
  doc: ProductDoc;
  view: ProductRelationsView;
}

/**
 * Every member product of a composition, with its relational overlay, in two
 * batched reads. Never one round trip per component — and the admin listing
 * loads the members of EVERY bundle on the page in one call, then resolves
 * each bundle against the same map with no further reads.
 */
export async function loadCompositionMembers(db: D1Database, ids: string[]): Promise<Map<string, MemberRow>> {
  const out = new Map<string, MemberRow>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < unique.length; i += LOAD_CHUNK) {
    const part = unique.slice(i, i + LOAD_CHUNK);
    const { results } = await db
      .prepare(`SELECT * FROM products WHERE id IN (${part.map(() => '?').join(', ')})`)
      .bind(...part)
      .all<Record<string, unknown>>();
    rows.push(...results);
  }
  const views = await loadRelationsViews(
    db,
    rows.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
  );
  for (const r of rows) {
    const id = String(r.id);
    const view = views.get(id) ?? EMPTY_RELATIONS;
    out.set(id, { row: r, doc: applyRelations(parseProductRow(r), view, { includeInactive: false }), view });
  }
  return out;
}

/** The fulfilment mode a member product offers, before any transport is
 *  chosen. '' means it genuinely offers both and the transport decides. */
function memberMode(doc: ProductDoc): '' | 'direct_sale' | 'pre_order' {
  return effectiveAvailability({ availability_type: '' }, doc.sale_types);
}

/** The transport methods a pre-order member actually offers. */
function memberTransports(doc: ProductDoc): string[] {
  return doc.preorder_transports.filter((t) => t.active).map((t) => t.method);
}

/**
 * ONE transport method every pre-order component offers, or null when they
 * share none (§17 decision 12). The platform holds one shipping type per cart
 * and freezes one onto `orders.shipping_type`, so a bundle whose pre-order
 * components share no method has no honest delivery date — it is refused, and
 * never forced onto the slowest transport.
 */
function commonTransport(members: ProductDoc[]): { method: string | null; preorder: boolean } {
  const preorderDocs = members.filter((d) => memberMode(d) === 'pre_order');
  if (preorderDocs.length === 0) return { method: null, preorder: false };
  let shared: string[] | null = null;
  for (const d of preorderDocs) {
    const mine = memberTransports(d);
    shared = shared === null ? mine : shared.filter((m) => mine.includes(m));
  }
  // The order the admin's own transport list is in, so the choice is stable.
  return { method: shared && shared.length ? shared[0] : null, preorder: true };
}

export interface ResolveCompositionInput {
  bundleProductId: string;
  /** The bundle's own document — its ladder, its status, its transports. */
  doc: ProductDoc;
  config: BundleConfigInput;
  components: BundleComponentInput[];
  offer: { starts_at: string | null; ends_at: string | null; active: boolean } | null;
  offerCheck: OfferCheck;
  ctx: CompositionPricingCtx;
  nowMs: number;
  /** Members already loaded by the caller (an admin listing loads them once
   *  for the whole page). Absent = this call reads them itself. */
  members?: Map<string, MemberRow>;
}

export interface ResolveCompositionResult {
  preview: CompositionPreview;
  resolved: ResolvedComponent[];
  members: Map<string, MemberRow>;
  /** Refusals discovered while resolving (a missing member, a nested bundle,
   *  an impossible selection). */
  errors: BundleIssue[];
  warnings: BundleIssue[];
}

/**
 * THE ONE PASS the admin preview, the save and the storefront all take.
 *
 * It resolves every component against the REAL catalogue — `resolveStock` for
 * the stock answer, `resolveUnitPrice` for the standalone value — and then
 * hands the result to `bundleAvailability` and `resolveBundlePrice`, the same
 * two functions the card, the cart and the door use. Admin and shop therefore
 * cannot disagree, which is the whole point of computing nothing in the panel.
 */
export async function resolveComposition(
  db: D1Database,
  input: ResolveCompositionInput
): Promise<ResolveCompositionResult> {
  const errors: BundleIssue[] = [];
  const warnings: BundleIssue[] = [];
  const members =
    input.members ?? (await loadCompositionMembers(db, input.components.map((c) => c.member_product_id)));

  const nameOf = (m: MemberRow | undefined, id: string) =>
    m ? m.doc.name_en || m.doc.name_ar || id : id;

  // The transport every pre-order component offers, decided ONCE for the whole
  // bundle so the components are priced on the journey the parent line will be
  // on — the commission is real money and is charged on the parent (§2.2).
  const presentDocs = input.components
    .map((c) => members.get(c.member_product_id)?.doc)
    .filter((d): d is ProductDoc => !!d);
  const transport = commonTransport(presentDocs);

  const resolved: ResolvedComponent[] = [];
  const previews: ComponentPreview[] = [];
  let componentTotal = 0;

  input.components.forEach((c, i) => {
    const line = i + 1;
    const m = members.get(c.member_product_id);
    const name = nameOf(m, c.member_product_id);
    if (!m) {
      errors.push(
        bundleIssue('COMPONENT_SELECTION_INVALID', { name: c.member_product_id, why: 'no such product' }, { line, component_id: c.id })
      );
      return;
    }
    if (m.doc.composition !== '' || m.doc.id === input.bundleProductId) {
      errors.push(bundleIssue('BUNDLE_NESTING_NOT_ALLOWED', { name }, { line, component_id: c.id }));
      return;
    }
    if (m.doc.status !== 'active') {
      warnings.push(bundleIssue('COMPONENT_PRODUCT_INACTIVE', { name }, { line, component_id: c.id }));
    }

    // ---- the selection the admin pinned, validated against the real rows ---
    const view = m.view;
    const values = view.values;
    const colors = view.colors;
    const why: string[] = [];
    for (const vid of c.option_value_ids) {
      const v = values.find((x) => x.id === vid);
      if (!v) why.push(`option value ${vid} does not exist on this product`);
      else if (!v.active) why.push(`option value "${v.name_en}" is inactive`);
    }
    if (c.color_id) {
      const col = colors.find((x) => x.id === c.color_id);
      if (!col) why.push(`colour ${c.color_id} does not exist on this product`);
      else if (!col.active) why.push(`colour "${col.name_en}" is inactive`);
    }
    if (c.customer_picks_option && c.option_value_ids.length) {
      why.push('an option is either pinned by the admin or chosen by the customer, never both');
    }
    if (c.customer_picks_color && c.color_id) {
      why.push('a colour is either pinned by the admin or chosen by the customer, never both');
    }
    for (const vid of c.choice_option_value_ids) {
      if (!c.customer_picks_option) why.push('an option allow-list needs the customer-picks switch on');
      else if (!values.some((x) => x.id === vid && x.active)) why.push(`option value ${vid} is not an active value of this product`);
    }
    for (const cid of c.choice_color_ids) {
      if (!c.customer_picks_color) why.push('a colour allow-list needs the customer-picks switch on');
      else if (!colors.some((x) => x.id === cid && x.active)) why.push(`colour ${cid} is not an active colour of this product`);
    }
    // A COLOR-mode member with neither a pinned colour nor a customer choice
    // resolves to SELECTION_INCOMPLETE for ever — neither sellable nor
    // wordable, so it is refused here rather than sold and then refused.
    if (view.inventory_mode === 'COLOR' && !c.color_id && !c.customer_picks_color) {
      why.push('this product tracks stock per colour, so the bundle must pin a colour or let the customer pick one');
    }
    if (view.inventory_mode === 'OPTION' && c.option_value_ids.length === 0 && !c.customer_picks_option) {
      why.push('this product tracks stock per option, so the bundle must pin an option or let the customer pick one');
    }
    if (why.length) {
      errors.push(bundleIssue('COMPONENT_SELECTION_INVALID', { name, why: why.join('; ') }, { line, component_id: c.id }));
      return;
    }

    const sel = { option_value_ids: [...c.option_value_ids].sort(), color_id: c.color_id || null };
    const snapshot = view.has_relations
      ? snapshotFrom(view, {
          stock: m.doc.stock,
          reserved: Number(m.row.stock_reserved ?? 0),
          low_stock_threshold: m.doc.low_stock_threshold,
        })
      : {
          inventory_mode: 'BASE' as const,
          base: {
            stock: m.doc.stock,
            reserved: Number(m.row.stock_reserved ?? 0),
            low_stock_threshold: m.doc.low_stock_threshold,
          },
          option_values: [],
          colors: [],
          variants: [],
          group_ids: [],
        };
    const resolution = resolveStock(snapshot, sel);
    // A fully pinned VARIANT_COMBINATION member whose combination has no row
    // can never be sold; the customer-selectable case is decided at the door,
    // when the choice actually exists.
    if (
      resolution.error === 'VARIANT_NOT_MODELLED' &&
      !c.customer_picks_option &&
      !c.customer_picks_color
    ) {
      errors.push(bundleIssue('VARIANT_NOT_MODELLED', { name }, { line, component_id: c.id }));
      return;
    }

    const mode = memberMode(m.doc);
    const method = mode === 'pre_order' ? (transport.method ?? '') : '';
    const unit = resolveUnitPrice({
      product: m.doc,
      optionId: sel.option_value_ids[0] || null,
      colorId: sel.color_id,
      transportMethod: method || null,
      tier: input.ctx.tier,
      tierActive: input.ctx.tierActive,
      proPolicy: input.ctx.proPolicy,
      transportDefaults: input.ctx.transportDefaults,
      preorderPricing: 'prepaid',
    });
    const shipping: ShippingType = mode === 'pre_order' ? typeForTransport(method) : 'direct';

    resolved.push({
      component_id: c.id ?? `bc_new_${i}`,
      member_product_id: c.member_product_id,
      qty_per_bundle: c.qty,
      optional: c.optional,
      // The preview is what the bundle costs as configured: an optional
      // component is priced and counted as included, and the buyer's own
      // opt-out is a cart fact, not an admin one.
      included: true,
      selection: sel,
      resolution,
      unit,
      sale_types: m.doc.sale_types,
      shipping_type: shipping,
    });

    const lineValue = unit.applied_iqd * c.qty;
    componentTotal += lineValue;
    previews.push({
      component_id: c.id ?? '',
      member_product_id: c.member_product_id,
      name: m.doc.name_en || m.doc.name_ar || c.member_product_id,
      name_ar: m.doc.name_ar,
      status: m.doc.status,
      qty_per_bundle: c.qty,
      optional: c.optional,
      customer_picks_option: c.customer_picks_option,
      customer_picks_color: c.customer_picks_color,
      option_value_ids: sel.option_value_ids,
      color_id: c.color_id,
      unit_iqd: unit.applied_iqd,
      line_value_iqd: lineValue,
      available: resolution.available,
      shipping_type: shipping,
      cost_iqd: unit.cost_iqd,
    });

    if (resolution.available !== null && resolution.available < c.qty) {
      warnings.push(
        bundleIssue('COMPONENT_SHORT', { name, needed: c.qty, available: resolution.available }, { line, component_id: c.id })
      );
    }
  });

  // A pre-order bundle whose components share no transport method has no
  // honest delivery date. Refused, never split and never forced onto the
  // slowest journey (§2.5, §17 decision 12).
  const noSharedTransport = transport.preorder && transport.method === null;
  if (noSharedTransport) {
    const names = presentDocs
      .filter((d) => memberMode(d) === 'pre_order')
      .map((d) => d.name_en || d.name_ar || d.id);
    errors.push(bundleIssue('BUNDLE_SHIPPING_MIXED', { a: names[0] ?? '', b: names[1] ?? names[0] ?? '' }));
  }

  const availability = bundleAvailability(
    resolved,
    { starts_at: input.offer?.starts_at ?? null, ends_at: input.offer?.ends_at ?? null, nowMs: input.nowMs },
    input.offer ? input.offer.active : true,
    input.offerCheck
  );
  // Two journeys in one bundle — a direct component beside a pre-order one, or
  // two different pre-order transports. The cart holds exactly one shipping
  // type and `orders.shipping_type` freezes one, so this is refused rather
  // than split into two orders or forced onto the slower leg.
  if (!noSharedTransport && availability.shipping_type === 'mixed') {
    const first = previews[0];
    const other = previews.find((p) => p.shipping_type !== first?.shipping_type);
    errors.push(bundleIssue('BUNDLE_SHIPPING_MIXED', { a: first?.name ?? '', b: other?.name ?? '' }));
  }

  const bundleResolved = resolveUnitPrice({
    product: input.doc,
    tier: input.ctx.tier,
    tierActive: input.ctx.tierActive,
    proPolicy: input.ctx.proPolicy,
    transportDefaults: input.ctx.transportDefaults,
    preorderPricing: 'prepaid',
  });
  const price = resolveBundlePrice({
    resolved: bundleResolved,
    config: input.config,
    componentTotalIqd: componentTotal,
    tier: input.ctx.tier,
    tierActive: input.ctx.tierActive,
  });

  return {
    preview: {
      component_total_iqd: componentTotal,
      bundle_price_iqd: price.bundle_price_iqd,
      regular_iqd: price.regular_iqd,
      prime_iqd: price.prime_iqd,
      pro_iqd: price.pro_iqd,
      plus_iqd: price.plus_iqd,
      applied_tier: price.applied_tier,
      discount_iqd: price.discount_iqd,
      saving_percent: price.saving_percent,
      availability,
      components: previews,
    },
    resolved,
    members,
    errors,
    warnings,
  };
}

/**
 * The four price-shaped warnings a composition can carry, computed from the
 * stored document, its config and the server's own preview. Shared by the
 * save, the single-bundle preview and the listing, so one screen can never
 * warn about a bundle the next screen calls fine.
 */
export function compositionPriceWarnings(
  doc: Pick<ProductDoc, 'price_iqd'>,
  config: BundleConfigInput,
  preview: Pick<CompositionPreview, 'component_total_iqd' | 'regular_iqd'>
): BundleIssue[] {
  const out: BundleIssue[] = [];
  if (config.price_mode === 'fixed' && doc.price_iqd <= 0) {
    out.push(bundleIssue('MIGRATED_NEEDS_PRICE', {}, { key: 'price_iqd' }));
  }
  if (preview.component_total_iqd > 0 && preview.regular_iqd > preview.component_total_iqd) {
    out.push(bundleIssue('PRICE_ABOVE_COMPONENTS', {}, { key: 'price_iqd' }));
  }
  if (config.price_mode !== 'fixed') {
    // About the SORT AND SEARCH KEY only: the card and the door already quote
    // the derived figure (§4.3), so this is never a customer-visible
    // discrepancy — and it is never silently reconciled either.
    if (preview.regular_iqd !== doc.price_iqd) {
      out.push(
        bundleIssue('DERIVED_PRICE_DRIFT', { stored: doc.price_iqd, derived: preview.regular_iqd }, { key: 'price_iqd' })
      );
    }
    if (preview.regular_iqd < Math.max(1, config.min_price_iqd)) {
      out.push(bundleIssue('DERIVED_PRICE_BELOW_FLOOR', {}, { key: 'min_price_iqd' }));
    }
  }
  return out;
}

/**
 * THE ADMIN SAVE, PLANNED — never executed here.
 *
 * It returns `{ errors }` or `{ statements, warnings, preview }`, the exact
 * contract `planRelationsWriteFrom` uses, so the caller can push the
 * statements into `ProductSavePlan.statements` and let `saveProductAtomic` run
 * the ONE batch. That is the single most important integration decision in the
 * design: the composition rides the product's own transaction and
 * `worker/lib/productPersistence.ts` stays the only writer of the product
 * tables (docs/TXT_IMPORT_PARITY.md §5.1).
 *
 * Nothing here repairs anything. Every refusal names its component and arrives
 * in three languages.
 */
export async function planBundleComposition(
  db: D1Database,
  bundleProductId: string,
  input: { components: BundleComponentInput[]; config: BundleConfigInput },
  opts: {
    doc: ProductDoc;
    offer: BundleOfferInput | null;
    offerCheck: OfferCheck;
    ctx: CompositionPricingCtx;
    nowMs: number;
    /** The status this save is asking for — a publish is stricter than a draft. */
    publishing: boolean;
  }
): Promise<BundleCompositionPlan> {
  const errors: BundleIssue[] = [];
  const warnings: BundleIssue[] = [];
  const config = input.config;

  if (input.components.length === 0) {
    return { errors: [bundleIssue('BUNDLE_NO_COMPONENTS')] };
  }
  // The physical-line ceiling, checked at SAVE rather than discovered at
  // checkout as an opaque D1 error (§3.1).
  const lines = input.components.length * Math.max(1, config.max_qty_per_order);
  if (lines > MAX_PHYSICAL_LINES) {
    errors.push(bundleIssue('COMPOSITION_TOO_LARGE', { lines, max: MAX_PHYSICAL_LINES }));
  }

  // ---- the two price sources are never combined (§4.6) --------------------
  const windowPrices = !!opts.offer && opts.offer.offer_price_mode !== '';
  if (windowPrices && config.price_mode !== 'fixed') {
    errors.push(bundleIssue('OFFER_PRICE_CONFLICT'));
  }
  if (config.price_mode === 'discount_percent') {
    const p = config.discount_percent;
    if (p === null || !(p >= 1 && p <= 90)) {
      errors.push(bundleIssue('BUNDLE_VALIDATION', { why: 'discount_percent must be between 1 and 90' }, { key: 'discount_percent' }));
    }
    if (config.discount_iqd !== null) {
      errors.push(bundleIssue('BUNDLE_VALIDATION', { why: 'a bundle sets a percent discount or a dinar discount, never both' }, { key: 'discount_iqd' }));
    }
  }
  if (config.price_mode === 'discount_iqd') {
    if (config.discount_iqd === null || config.discount_iqd <= 0) {
      errors.push(bundleIssue('BUNDLE_VALIDATION', { why: 'discount_iqd must be greater than zero' }, { key: 'discount_iqd' }));
    }
    if (config.discount_percent !== null) {
      errors.push(bundleIssue('BUNDLE_VALIDATION', { why: 'a bundle sets a percent discount or a dinar discount, never both' }, { key: 'discount_percent' }));
    }
  }
  if (opts.offer) {
    const { starts_at: s, ends_at: e } = opts.offer;
    if (s && e && Date.parse(e) <= Date.parse(s)) errors.push(bundleIssue('SCHEDULE_INVERTED', {}, { key: 'ends_at' }));
    if (opts.offer.offer_price_mode === 'discount_percent') {
      const p = opts.offer.discount_percent;
      if (p === null || !(p >= 1 && p <= 90)) {
        errors.push(bundleIssue('BUNDLE_VALIDATION', { why: 'the offer discount_percent must be between 1 and 90' }, { key: 'offer.discount_percent' }));
      }
    }
  }

  // ---- the member ladder never inverts (§4.7) -----------------------------
  const regular = opts.doc.price_iqd;
  const rungs: Array<[string, number | null]> = [
    ['pro', opts.doc.pro_price_iqd],
    ['prime', opts.doc.prime_price_iqd],
    ['plus', config.plus_price_iqd],
  ];
  const pro = opts.doc.pro_price_iqd;
  const prime = opts.doc.prime_price_iqd;
  const plus = config.plus_price_iqd;
  const inverted =
    rungs.some(([, v]) => v !== null && v > regular) ||
    (pro !== null && prime !== null && pro > prime) ||
    (plus !== null && prime !== null && plus < prime) ||
    (plus !== null && pro !== null && plus < pro);
  if (inverted) errors.push(bundleIssue('MEMBER_LADDER_INVERTED', {}, { key: 'prices' }));

  // ---- the components, resolved against the real catalogue ---------------
  const res = await resolveComposition(db, {
    bundleProductId,
    doc: opts.doc,
    config,
    components: input.components,
    offer: opts.offer ? { starts_at: opts.offer.starts_at, ends_at: opts.offer.ends_at, active: opts.offer.active } : null,
    offerCheck: opts.offerCheck,
    ctx: opts.ctx,
    nowMs: opts.nowMs,
  });
  errors.push(...res.errors);
  warnings.push(...res.warnings);

  const total = res.preview.component_total_iqd;
  // ONE typed zero must not publish a free bundle. Refused at save, not
  // clamped at read: `max(min_price, …)` alone satisfies "never negative" at
  // the letter and loses it at the intent (§4.3).
  if (config.price_mode === 'discount_iqd' && config.discount_iqd !== null && config.discount_iqd >= total) {
    errors.push(bundleIssue('BUNDLE_DISCOUNT_EXCEEDS_TOTAL', { discount: config.discount_iqd, total }, { key: 'discount_iqd' }));
  }
  // The same four price warnings the listing and the preview show, from the
  // same function — so a bundle cannot be warned about on one screen and
  // silent on another. A fixed-price bundle with no price is honest as a
  // DRAFT (the migrated legacy rows are exactly that) and REFUSED on publish.
  for (const w of compositionPriceWarnings(opts.doc, config, res.preview)) {
    if (w.code === 'MIGRATED_NEEDS_PRICE' && opts.publishing) errors.push(w);
    else warnings.push(w);
  }

  if (errors.length) return { errors };

  // ---- the statements, for the product's OWN batch ------------------------
  const statements: D1PreparedStatement[] = [
    // The choices go first: `bundle_component_choices` cascades from the
    // components, and deleting the parents first would leave the delete of the
    // children matching nothing on a database with foreign keys off.
    db
      .prepare(
        'DELETE FROM bundle_component_choices WHERE component_id IN (SELECT id FROM bundle_components WHERE bundle_product_id = ?)'
      )
      .bind(bundleProductId),
    db.prepare('DELETE FROM bundle_components WHERE bundle_product_id = ?').bind(bundleProductId),
  ];
  input.components.forEach((c, i) => {
    const id = c.id && /^bc_/.test(c.id) ? c.id : newId('bc');
    statements.push(
      db
        .prepare(
          `INSERT INTO bundle_components
             (id, bundle_product_id, member_product_id, qty, optional, option_value_ids, color_id,
              customer_picks_option, customer_picks_color, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          bundleProductId,
          c.member_product_id,
          c.qty,
          c.optional ? 1 : 0,
          JSON.stringify([...c.option_value_ids].sort()),
          c.color_id,
          c.customer_picks_option ? 1 : 0,
          c.customer_picks_color ? 1 : 0,
          Number.isFinite(c.sort) ? c.sort : i
        )
    );
    [...new Set(c.choice_option_value_ids)].forEach((ref, k) => {
      statements.push(
        db
          .prepare('INSERT INTO bundle_component_choices (component_id, dim, ref_id, sort) VALUES (?, ?, ?, ?)')
          .bind(id, 'option_value', ref, k)
      );
    });
    [...new Set(c.choice_color_ids)].forEach((ref, k) => {
      statements.push(
        db
          .prepare('INSERT INTO bundle_component_choices (component_id, dim, ref_id, sort) VALUES (?, ?, ?, ?)')
          .bind(id, 'color', ref, k)
      );
    });
  });
  statements.push(
    db
      .prepare(
        `INSERT INTO bundle_config
           (product_id, price_mode, discount_percent, discount_iqd, min_price_iqd, plus_price_iqd, max_qty_per_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           price_mode = excluded.price_mode,
           discount_percent = excluded.discount_percent,
           discount_iqd = excluded.discount_iqd,
           min_price_iqd = excluded.min_price_iqd,
           plus_price_iqd = excluded.plus_price_iqd,
           max_qty_per_order = excluded.max_qty_per_order,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .bind(
        bundleProductId,
        config.price_mode,
        config.price_mode === 'discount_percent' ? config.discount_percent : null,
        config.price_mode === 'discount_iqd' ? config.discount_iqd : null,
        Math.max(1, config.min_price_iqd),
        config.plus_price_iqd,
        config.max_qty_per_order
      )
  );

  return { errors: [] as never[], statements, warnings, preview: res.preview };
}

// ------------------------------------------------- the product panel's doors

/**
 * The bundles a member product belongs to. `bundle_components.member_product_id`
 * is ON DELETE RESTRICT on purpose — deleting a member must be REFUSED with the
 * bundle named, never silently cascade a bundle into incoherence — and
 * `idx_bundle_components_member` makes this one indexed read.
 */
export async function bundlesUsing(
  db: D1Database,
  memberProductId: string
): Promise<Array<{ id: string; name: string }>> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS id, COALESCE(NULLIF(p.name_ar,''), p.name, p.id) AS name
         FROM bundle_components bc
         JOIN products p ON p.id = bc.bundle_product_id
        WHERE bc.member_product_id = ?
        GROUP BY p.id
        LIMIT 20`
    )
    .bind(memberProductId)
    .all<{ id: string; name: string }>();
  return results;
}

/**
 * The 409 the product panel answers with when an editor opens a composition
 * row. A bundle's stock is NULL by design, it has no options or colours of its
 * own and its price rule lives in `bundle_config`, so the product form would
 * show something untrue and then be refused on save. The body names the panel
 * that owns it.
 */
export const compositionConflict = (id: string, slug: string) =>
  new HttpError(
    409,
    'هذا المنتج حزمة ويُحرَّر من لوحة الحزم / this product is a bundle and is edited from the bundles panel',
    'COMPOSITION_PRODUCT',
    { id, slug, panel: 'bundles' }
  );
