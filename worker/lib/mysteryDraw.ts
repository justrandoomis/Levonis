/**
 * THE MYSTERY ENGINE — docs/BUNDLES_MYSTERY.md §7.
 *
 * A mystery offer is a bundle whose components are DRAWN instead of listed, so
 * every word of §3 (one batch), §4 (server-computed money), §5 (one cart line)
 * and §6 (the immutable snapshot) applies to it unchanged. What lives here is
 * only the part a bundle does not have: which real catalogue rows are eligible
 * right now, and which one of them this line gets.
 *
 * SIX RULES, ALL LOAD-BEARING.
 *
 * 1. THE SEED IS SERVER-HELD, AND NO CLIENT VALUE TOUCHES IT. It is
 *    `seedFrom(secret, cart_items.draw_salt)` — a secret in
 *    `mystery_offer_secrets` that no read route joins, and a salt this server
 *    wrote when the cart line was created. `worker/lib/farm/rng.ts`'s own
 *    header names the phase-1 bug this avoids: a seed derived from ids the
 *    client knows ("their idempotency key") can be ground offline for a
 *    favourable roll. THE CHECKOUT IDEMPOTENCY KEY IS NOT AN INPUT HERE, and
 *    neither is the user id, the order id or the order item id.
 *
 * 2. THE PER-SPOOL SALT IS `mystery:<cartItemId>:<spoolIndex>` — the CART item,
 *    never the ORDER item. `priceLines` assigns a crypto-random `newId('oi')`
 *    on every call and runs up to three times per checkout (requested, prepaid
 *    and COD bases), plus once more for the quote; salting on it would make
 *    each pass draw a different filament and let the wallet-covers-the-total
 *    branch decide which draw was persisted. `cart_items.id` is stable across
 *    all three passes, across the quote and across a retry under the same
 *    idempotency key. (§7.3 states this explicitly and §7.5's prose says
 *    "orderItemId"; §7.3's rule wins, because it is the one with the reason.)
 *
 * 3. CANDIDATES ARE REAL INVENTORY, JUDGED BY `resolveStock`. There is no pool
 *    stock column and never will be: an entry names a product, an option-value
 *    set and a colour, and its availability is the same number the product page
 *    shows. Zero stock, weight 0, an inactive entry, an inactive product,
 *    option or colour, an untracked row in a DIRECT pool, a pool-kind
 *    disagreement and a failed catalog/facet requirement each drop the entry —
 *    and the reason is kept, for the admin preview only.
 *
 * 4. ELIGIBILITY IS NEVER INFERRED FROM A PRODUCT NAME. `family_id`,
 *    `require_catalog_ids` and `require_facet_ids` are structured taxonomy ids.
 *
 * 5. NO ELIGIBLE CANDIDATE IS AN HONEST SOLD-OUT, NOT A CONVERSION. The direct
 *    and pre-order pools are separate rows with their own `kind`, so a direct
 *    purchase can never silently become a pre-order; a mode whose pool is
 *    missing refuses with `MYSTERY_MODE_NOT_AVAILABLE`.
 *
 * 6. THE ALLOCATION IS PERMANENT. It is written in the order's own batch, fenced
 *    by `PRIMARY KEY (order_item_id, spool_index)`, and nothing ever updates
 *    `product_id` or `color_id`. Combined with the deterministic seed and the
 *    per-user checkout key (`orders.client_idempotency_key`, unique with
 *    `user_id` since migration 0064 — it was the globally-unique
 *    `orders.idempotency_key` when this was written), a refresh, a retry, a
 *    double tap and a webhook replay cannot produce a different filament.
 *
 * This module is the ONLY file in the repository that names
 * `mystery_offer_secrets`; `tests/compositionSchema.test.ts` fails if that ever
 * stops being true, because the seed is a pure function of the secret and one
 * leaked admin payload would let anyone precompute every future draw.
 */

import { seedFrom, sequence, weightedIndex, randomSeedHex } from './farm/rng';
import { sha256Hex } from './crypto';
import { resolveStock, type StockResolution, type StockTarget } from './inventory';
import { effectiveAvailability } from '@levonis/pricing/availability';
import { typeForTransport, type ShippingType } from '@levonis/pricing/shippingType';
import {
  EMPTY_RELATIONS,
  loadRelationsViews,
  snapshotFrom,
  type ProductRelationsView,
} from './productOverlay';
import { bundleAvailability, type CompositionAvailability, type ResolvedComponent } from './bundleComposition';
import type { OfferCheck } from './offers';
import { mysteryRefusal } from './mystery/issues';

/** Every `IN (…)` list this feature adds is chunked to a documented safe size
 *  (§3.1): D1 caps bound parameters per query, and a filament pool is product ×
 *  option values × colour, so a realistic one is hundreds of rows. */
const CHUNK = 50;

export type MysterySaleMode = 'direct' | 'preorder';
export type DuplicatePolicy = 'allow' | 'discourage' | 'forbid';

export interface MysteryPool {
  id: string;
  name: string;
  kind: MysterySaleMode;
  active: boolean;
  require_catalog_ids: string[];
  require_facet_ids: string[];
  min_available: number;
  updated_at: string;
}

export interface MysteryOffer {
  product_id: string;
  direct_pool_id: string | null;
  preorder_pool_id: string | null;
  spool_qty: number;
  allow_direct: boolean;
  allow_preorder: boolean;
  customer_picks_family: boolean;
}

/** The mystery half of `bundle_config` (§1.3), which the bundles panel's own
 *  upsert deliberately leaves alone. */
export interface MysteryConfig {
  duplicate_policy: DuplicatePolicy;
  reveal_stage: string;
  show_odds: boolean;
  max_qty_per_order: number;
}

export interface MysteryCandidate {
  entry_id: string;
  product_id: string;
  option_value_ids: string[];
  color_id: string;
  family_id: string;
  weight: number;
  /** Sellable units right now; `null` = untracked (a pre-order pool only). */
  available: number | null;
  /** The REAL stock rows a reservation for this pick would consume. */
  targets: StockTarget[];
  /** Frozen at draw time so a later rename cannot rewrite history (§1.9). */
  name_snapshot: string;
  image_snapshot: string;
  variant_snapshot: string;
}

export type ExclusionReason =
  | 'ENTRY_INACTIVE'
  | 'ZERO_WEIGHT'
  | 'PRODUCT_INACTIVE'
  | 'COMPOSITION_NESTED'
  | 'SELECTION_INACTIVE'
  | 'SELECTION_INCOMPLETE'
  | 'VARIANT_NOT_MODELLED'
  | 'UNTRACKED_DIRECT'
  | 'BELOW_MIN_AVAILABLE'
  | 'MODE_MISMATCH'
  | 'CATALOG_REQUIRED'
  | 'FACET_REQUIRED'
  | 'DUPLICATE_ENTRY';

export interface MysteryExclusion {
  entry_id: string;
  product_id: string;
  name: string;
  weight: number;
  available: number | null;
  reason: ExclusionReason;
}

export interface CandidateSet {
  pool_id: string;
  kind: MysterySaleMode;
  candidates: MysteryCandidate[];
  /** Populated only for the admin preview; the customer never sees a reason,
   *  a count or a name (§7.5). */
  excluded: MysteryExclusion[];
}

// ------------------------------------------------------------------ loading

const parseIds = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const truthy = (v: unknown) => v === 1 || v === true || v === '1';

interface PoolRow {
  id: string;
  name: string;
  kind: string;
  active: number;
  require_catalog_ids: string;
  require_facet_ids: string;
  min_available: number;
  updated_at: string;
}

export function poolFromRow(r: PoolRow): MysteryPool {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind === 'preorder' ? 'preorder' : 'direct',
    active: truthy(r.active),
    require_catalog_ids: parseIds(r.require_catalog_ids),
    require_facet_ids: parseIds(r.require_facet_ids),
    min_available: Math.max(0, Number(r.min_available ?? 1)),
    updated_at: String(r.updated_at ?? ''),
  };
}

export async function loadPool(db: D1Database, poolId: string): Promise<MysteryPool | null> {
  const r = await db.prepare('SELECT * FROM mystery_pools WHERE id = ?').bind(poolId).first<PoolRow>();
  return r ? poolFromRow(r) : null;
}

interface OfferRow {
  product_id: string;
  direct_pool_id: string | null;
  preorder_pool_id: string | null;
  spool_qty: number;
  allow_direct: number;
  allow_preorder: number;
  customer_picks_family: number;
}

const offerFromRow = (r: OfferRow): MysteryOffer => ({
  product_id: r.product_id,
  direct_pool_id: r.direct_pool_id || null,
  preorder_pool_id: r.preorder_pool_id || null,
  spool_qty: Math.min(20, Math.max(1, Number(r.spool_qty ?? 1))),
  allow_direct: truthy(r.allow_direct),
  allow_preorder: truthy(r.allow_preorder),
  customer_picks_family: truthy(r.customer_picks_family),
});

export async function loadMysteryOffer(db: D1Database, productId: string): Promise<MysteryOffer | null> {
  const r = await db.prepare('SELECT * FROM mystery_offers WHERE product_id = ?').bind(productId).first<OfferRow>();
  return r ? offerFromRow(r) : null;
}

/** One read for a whole listing page — never one round trip per card (§14). */
export async function loadMysteryOffers(db: D1Database, productIds: string[]): Promise<Map<string, MysteryOffer>> {
  const out = new Map<string, MysteryOffer>();
  const ids = [...new Set(productIds)].filter(Boolean);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(`SELECT * FROM mystery_offers WHERE product_id IN (${part.map(() => '?').join(', ')})`)
      .bind(...part)
      .all<OfferRow>();
    for (const r of results) out.set(r.product_id, offerFromRow(r));
  }
  return out;
}

/**
 * The products an ACTIVE mystery pool draws from (§8.2 row 18).
 *
 * Membership of an active pool is a PUBLICATION RULE: for these products the
 * public catalogue must report a coarse state instead of an exact count, because
 * two anonymous GETs around a purchase otherwise defeat every reveal milestone
 * after 'paid' — exactly one colour row drops by exactly `spool_qty × qty`.
 * One indexed read per request (`idx_mystery_entries_product`).
 */
export async function activePoolProductIds(db: D1Database, productIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(productIds)].filter(Boolean);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT DISTINCT e.product_id AS product_id
           FROM mystery_pool_entries e
           JOIN mystery_pools p ON p.id = e.pool_id
          WHERE e.active = 1 AND p.active = 1
            AND e.product_id IN (${part.map(() => '?').join(', ')})`
      )
      .bind(...part)
      .all<{ product_id: string }>();
    for (const r of results) out.add(r.product_id);
  }
  return out;
}

interface EntryJoinRow {
  entry_id: string;
  product_id: string;
  option_value_ids: string;
  color_id: string;
  family_id: string;
  weight: number;
  entry_active: number;
  inventory_mode: string;
  stock: number | null;
  stock_reserved: number | null;
  low_stock_threshold: number | null;
  status: string;
  sale_types: string;
  composition: string;
  name: string;
  images: string;
  category_id: string | null;
  sub_category_id: string | null;
}

/** §7.2's query, verbatim in shape. The `preview` variant keeps the excluded
 *  rows so the admin can be TOLD why an entry can never be drawn — a customer
 *  path never asks for it. */
const CANDIDATE_SQL = (preview: boolean) => `
  SELECT e.id AS entry_id, e.product_id, e.option_value_ids, e.color_id, e.family_id, e.weight,
         e.active AS entry_active,
         p.inventory_mode, p.stock, p.stock_reserved, p.low_stock_threshold,
         p.status, p.sale_types, p.composition, p.name, p.images,
         p.category_id, p.sub_category_id
    FROM mystery_pool_entries e
    JOIN products p ON p.id = e.product_id
   WHERE e.pool_id = ?1
     ${preview ? '' : 'AND e.active = 1 AND e.weight > 0'}
     ${preview ? '' : "AND p.status = 'active'"}
     ${preview ? '' : "AND p.composition = ''"}
     AND (?2 = '' OR e.family_id = ?2)
   ORDER BY e.id`;

const firstImage = (raw: unknown): string => {
  const parsed = typeof raw === 'string' && raw.trim() ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(parsed)) return '';
  for (const item of parsed) {
    if (typeof item === 'string' && item) return item;
    if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') {
      return (item as { url: string }).url;
    }
  }
  return '';
};

/** The structured taxonomy a pool may require. NEVER a product name. */
async function loadTaxonomy(
  db: D1Database,
  productIds: string[]
): Promise<{ catalogs: Map<string, Set<string>>; facets: Map<string, Set<string>> }> {
  const catalogs = new Map<string, Set<string>>();
  const facets = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, pid: string, id: string) => {
    if (!id) return;
    const found = m.get(pid);
    if (found) found.add(id);
    else m.set(pid, new Set([id]));
  };
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const part = productIds.slice(i, i + CHUNK);
    const ph = part.map(() => '?').join(', ');
    const [pc, pf] = await Promise.all([
      db
        .prepare(`SELECT product_id, catalog_id FROM product_catalogs WHERE product_id IN (${ph})`)
        .bind(...part)
        .all<{ product_id: string; catalog_id: string }>(),
      db
        .prepare(`SELECT product_id, facet_id FROM product_facets WHERE product_id IN (${ph})`)
        .bind(...part)
        .all<{ product_id: string; facet_id: string }>(),
    ]);
    for (const r of pc.results) add(catalogs, r.product_id, r.catalog_id);
    for (const r of pf.results) add(facets, r.product_id, r.facet_id);
  }
  return { catalogs, facets };
}

/** The entry's effective fulfilment, read off the option it names when the
 *  option has an opinion and off the product otherwise (0043's rule). */
function entryMode(view: ProductRelationsView, valueIds: string[], saleTypes: string[]): '' | 'direct_sale' | 'pre_order' {
  const own = valueIds
    .map((id) => view.values.find((v) => v.id === id)?.availability_type ?? '')
    .filter((a): a is 'direct_sale' | 'pre_order' => a === 'direct_sale' || a === 'pre_order');
  if (own.length > 0) return own.every((a) => a === own[0]) ? own[0] : '';
  return effectiveAvailability(null, saleTypes);
}

/**
 * THE CANDIDATE QUERY (§7.2), built server-side, per pool, per checkout —
 * never per spool, never cached, never shipped to the browser.
 */
export async function loadCandidates(
  db: D1Database,
  pool: MysteryPool,
  opts: { familyId?: string; preview?: boolean } = {}
): Promise<CandidateSet> {
  const preview = opts.preview === true;
  const family = (opts.familyId ?? '').trim();
  const { results } = await db
    .prepare(CANDIDATE_SQL(preview))
    .bind(pool.id, family)
    .all<EntryJoinRow>();

  const modeById = new Map(results.map((r) => [r.product_id, r.inventory_mode]));
  const productIds = [...modeById.keys()];
  const views = new Map<string, ProductRelationsView>();
  // Chunked, because a realistic filament pool is product × option values ×
  // colour and D1 binds one placeholder per id (§3.1).
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const part = productIds.slice(i, i + CHUNK).map((id) => ({ id, inventory_mode: modeById.get(id) }));
    const loaded = await loadRelationsViews(db, part);
    for (const [k, v] of loaded) views.set(k, v);
  }
  const taxonomy = await loadTaxonomy(db, productIds);

  const candidates: MysteryCandidate[] = [];
  const excluded: MysteryExclusion[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    const valueIds = parseIds(r.option_value_ids).sort();
    const view = views.get(r.product_id) ?? EMPTY_RELATIONS;
    const saleTypes = parseIds(r.sale_types);
    const drop = (reason: ExclusionReason, available: number | null = null) => {
      excluded.push({
        entry_id: r.entry_id,
        product_id: r.product_id,
        name: r.name,
        weight: Number(r.weight ?? 0),
        available,
        reason,
      });
    };

    if (!truthy(r.entry_active)) {
      drop('ENTRY_INACTIVE');
      continue;
    }
    if (Number(r.weight ?? 0) <= 0) {
      drop('ZERO_WEIGHT');
      continue;
    }
    if (r.status !== 'active') {
      drop('PRODUCT_INACTIVE');
      continue;
    }
    // Never a bundle or another mystery offer inside a mystery pool.
    if ((r.composition ?? '') !== '') {
      drop('COMPOSITION_NESTED');
      continue;
    }
    // The relations view is the authority on whether the named option value or
    // colour still exists and is still active.
    const namedValues = valueIds.map((id) => view.values.find((v) => v.id === id));
    const namedColor = r.color_id ? view.colors.find((x) => x.id === r.color_id) : undefined;
    if (namedValues.some((v) => !v || !truthy(v.active)) || (r.color_id && (!namedColor || !truthy(namedColor.active)))) {
      drop('SELECTION_INACTIVE');
      continue;
    }
    const mode = entryMode(view, valueIds, saleTypes);
    const wantsDirect = pool.kind === 'direct';
    if ((wantsDirect && mode === 'pre_order') || (!wantsDirect && mode === 'direct_sale')) {
      drop('MODE_MISMATCH');
      continue;
    }
    if (pool.require_catalog_ids.length > 0) {
      const owned = new Set(taxonomy.catalogs.get(r.product_id) ?? []);
      if (r.category_id) owned.add(r.category_id);
      if (r.sub_category_id) owned.add(r.sub_category_id);
      if (!pool.require_catalog_ids.some((id) => owned.has(id))) {
        drop('CATALOG_REQUIRED');
        continue;
      }
    }
    if (pool.require_facet_ids.length > 0) {
      const owned = taxonomy.facets.get(r.product_id) ?? new Set<string>();
      if (!pool.require_facet_ids.some((id) => owned.has(id))) {
        drop('FACET_REQUIRED');
        continue;
      }
    }

    const snap = snapshotFrom(view, {
      stock: r.stock,
      reserved: Number(r.stock_reserved ?? 0),
      low_stock_threshold: r.low_stock_threshold,
    });
    const resolution: StockResolution = resolveStock(snap, {
      option_value_ids: valueIds,
      color_id: r.color_id || null,
    });
    if (resolution.error) {
      drop(resolution.error === 'VARIANT_NOT_MODELLED' ? 'VARIANT_NOT_MODELLED' : 'SELECTION_INCOMPLETE');
      continue;
    }
    if (wantsDirect) {
      // Untracked stock cannot back a DIRECT sale: it claims no limit, so a
      // draw against it would be inventory nobody counted.
      if (resolution.available === null) {
        drop('UNTRACKED_DIRECT');
        continue;
      }
      if (resolution.available < Math.max(1, pool.min_available)) {
        drop('BELOW_MIN_AVAILABLE', resolution.available);
        continue;
      }
    }

    // Two identical entries would be two wheel slots for ONE stock row — double
    // weight for the same filament, and a supply figure that counts its units
    // twice. The primary key cannot forbid it (the ids differ), so the loader
    // does, and the admin preview says which entry was dropped and why.
    const key = `${r.product_id}|${valueIds.join(',')}|${r.color_id}`;
    if (seen.has(key)) {
      drop('DUPLICATE_ENTRY', resolution.available);
      continue;
    }
    seen.add(key);

    const valueLabels = namedValues.map((v) => v?.name_en ?? '').filter(Boolean);
    const colorLabel = namedColor?.name_en ?? '';
    candidates.push({
      entry_id: r.entry_id,
      product_id: r.product_id,
      option_value_ids: valueIds,
      color_id: r.color_id ?? '',
      family_id: r.family_id ?? '',
      weight: Number(r.weight ?? 1),
      available: resolution.available,
      targets: resolution.targets,
      name_snapshot: r.name,
      image_snapshot: namedColor?.image || namedValues.find((v) => v?.image)?.image || firstImage(r.images),
      variant_snapshot: [...valueLabels, colorLabel].filter(Boolean).join(' · '),
    });
  }

  return { pool_id: pool.id, kind: pool.kind, candidates, excluded };
}

// ------------------------------------------------------- the audit trail

export interface CanonicalCandidate {
  entry_id: string;
  product_id: string;
  weight: number;
  available: number | null;
}

/** The canonical form whose sha256 rides on every allocation this line
 *  produced — sorted by entry_id, so (seed, candidates, weightedIndex)
 *  reproduces the winner years later. */
export function canonicalCandidates(candidates: MysteryCandidate[]): string {
  const rows: CanonicalCandidate[] = candidates
    .map((c) => ({ entry_id: c.entry_id, product_id: c.product_id, weight: c.weight, available: c.available }))
    .sort((a, b) => (a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0));
  return JSON.stringify(rows);
}

export async function candidatesDigest(candidates: MysteryCandidate[]): Promise<{ canonical: string; sha256: string }> {
  const canonical = canonicalCandidates(candidates);
  return { canonical, sha256: await sha256Hex(canonical) };
}

// --------------------------------------------------------------- the draw

export interface DrawnSpool {
  spool_index: number;
  candidate: MysteryCandidate;
}

export type DrawResult =
  | { ok: true; spools: DrawnSpool[] }
  | { ok: false; code: 'MYSTERY_NOT_ENOUGH_VARIETY' | 'MYSTERY_NO_ELIGIBLE_STOCK' };

/**
 * WEIGHTED SELECTION (§7.3, §7.5).
 *
 * Cumulative-weight (roulette-wheel) selection through `weightedIndex`, from a
 * generator whose every value is determined by (seed, salt). Pure and
 * synchronous: the seed and the candidates are loaded in the checkout pre-pass,
 * so `priceLines` stays synchronous and all three of its passes see the same
 * filament.
 *
 * After each draw the chosen candidate's remaining `available` is decremented
 * IN MEMORY and a candidate at zero leaves the wheel, so two spools cannot both
 * claim the last unit of one colour. That is a courtesy, not the guarantee: the
 * real enforcement is `planInventory`'s guard plus the reservation fence, with
 * every spool's reservation in one batch.
 *
 * The duplicate policy is never silently downgraded. `forbid` that runs out of
 * distinct choices REFUSES — with no count, ever, in the customer's refusal.
 */
export function drawSpools(input: {
  seed: string;
  cartItemId: string;
  spools: number;
  candidates: MysteryCandidate[];
  duplicatePolicy: DuplicatePolicy;
}): DrawResult {
  const { seed, cartItemId, spools, duplicatePolicy } = input;
  if (input.candidates.length === 0) return { ok: false, code: 'MYSTERY_NO_ELIGIBLE_STOCK' };

  interface Slot {
    candidate: MysteryCandidate;
    weight: number;
    /** Infinity for an untracked pre-order candidate: it bounds nothing. */
    remaining: number;
  }
  // Weight 0 is EXCLUDED, kept for history (§1.9). The candidate query already
  // drops it; the wheel drops it again, so no caller can hand a zero-weight
  // entry a silent weight of one.
  let wheel: Slot[] = input.candidates
    .filter((c) => c.weight > 0)
    .map((c) => ({
      candidate: c,
      weight: c.weight,
      remaining: c.available === null ? Infinity : c.available,
    }));
  if (wheel.length === 0) return { ok: false, code: 'MYSTERY_NO_ELIGIBLE_STOCK' };
  /** True once `forbid` removed a candidate that still had stock — the wheel
   *  then emptied for lack of VARIETY, not for lack of stock. */
  let removedWithStock = false;

  const out: DrawnSpool[] = [];
  for (let i = 0; i < spools; i++) {
    wheel = wheel.filter((s) => s.remaining > 0);
    if (wheel.length === 0) {
      return {
        ok: false,
        code: removedWithStock ? 'MYSTERY_NOT_ENOUGH_VARIETY' : 'MYSTERY_NO_ELIGIBLE_STOCK',
      };
    }
    const r = sequence(seed, `mystery:${cartItemId}:${i}`)();
    const idx = weightedIndex(
      wheel.map((s) => s.weight),
      r
    );
    const slot = wheel[Math.min(idx, wheel.length - 1)];
    out.push({ spool_index: i, candidate: slot.candidate });
    slot.remaining -= 1;

    if (duplicatePolicy === 'forbid') {
      if (slot.remaining > 0) removedWithStock = true;
      wheel = wheel.filter((s) => s !== slot);
    } else if (duplicatePolicy === 'discourage') {
      // Halved, integer division, minimum 1 — a concrete, testable rule.
      slot.weight = Math.max(1, Math.floor(slot.weight / 2));
    }
  }
  return { ok: true, spools: out };
}

// ------------------------------------------------------------- the secret

/**
 * The line's seed. THE ONLY READER OF `mystery_offer_secrets` in the whole
 * repository, and the reason that table exists apart from `mystery_offers`:
 * keeping the secret on the offer row would make its safety depend on every
 * future reader remembering to enumerate columns instead of `SELECT *`.
 *
 * Returns null when the offer has no secret yet — a configuration fault the
 * caller refuses honestly rather than papering over with a fresh random value,
 * which would make the draw non-reproducible.
 */
export async function seedForLine(db: D1Database, offerProductId: string, drawSalt: string): Promise<string | null> {
  if (!drawSalt) return null;
  const row = await db
    .prepare('SELECT secret FROM mystery_offer_secrets WHERE product_id = ?')
    .bind(offerProductId)
    .first<{ secret: string }>();
  if (!row?.secret) return null;
  return seedFrom(row.secret, drawSalt);
}

/** Creates the offer's secret if it has none. Never rotates an existing one:
 *  a rotation changes every future draw of that offer and is its own action. */
export function ensureOfferSecretStatement(db: D1Database, productId: string): D1PreparedStatement {
  return db
    .prepare('INSERT OR IGNORE INTO mystery_offer_secrets (product_id, secret) VALUES (?, ?)')
    .bind(productId, randomSeedHex());
}

/** A NEW secret — used when an offer is duplicated (the copy must not inherit
 *  the original's future draws) and when the owner rotates one deliberately. */
export function rotateOfferSecretStatement(db: D1Database, productId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mystery_offer_secrets (product_id, secret) VALUES (?, ?)
       ON CONFLICT(product_id) DO UPDATE SET
         secret = excluded.secret,
         rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .bind(productId, randomSeedHex());
}

// -------------------------------------------------------------- the modes

export interface ModeResolution {
  mode: MysterySaleMode;
  pool_id: string;
}

/**
 * The buyer's chosen mode — or the offer's only enabled one. The two pools are
 * separate rows, so a direct-sale purchase can NEVER silently become a
 * pre-order; a mode that is disabled or has no pool refuses.
 */
export function resolveMysteryMode(offer: MysteryOffer, requested: string | null | undefined): ModeResolution {
  const want = requested === 'preorder' || requested === 'pre_order' ? 'preorder' : requested === 'direct' ? 'direct' : '';
  const enabled: MysterySaleMode[] = [];
  if (offer.allow_direct && offer.direct_pool_id) enabled.push('direct');
  if (offer.allow_preorder && offer.preorder_pool_id) enabled.push('preorder');
  if (want) {
    if (!enabled.includes(want)) throw mysteryRefusal('MYSTERY_MODE_NOT_AVAILABLE');
    return { mode: want, pool_id: (want === 'direct' ? offer.direct_pool_id : offer.preorder_pool_id) as string };
  }
  if (enabled.length !== 1) throw mysteryRefusal('MYSTERY_MODE_NOT_AVAILABLE');
  const only = enabled[0];
  return { mode: only, pool_id: (only === 'direct' ? offer.direct_pool_id : offer.preorder_pool_id) as string };
}

// -------------------------------------------------------- the availability

/** How many one-spool offers the eligible pool can back, before the spool
 *  quantity is applied. `null` = every candidate is untracked (a pre-order
 *  pool), which bounds nothing. */
export function poolSupply(candidates: MysteryCandidate[]): number | null {
  let total: number | null = null;
  for (const c of candidates) {
    if (c.available === null) continue;
    total = (total ?? 0) + c.available;
  }
  return total;
}

/**
 * A mystery offer's availability, THROUGH THE SAME FUNCTION a bundle uses
 * (§2.2), so the admin preview, the card, the detail page, the cart and the
 * door can never disagree. `max_bundles` is
 * `floor(Σ eligible available / spool_qty)`.
 *
 * The synthetic component below is an AVAILABILITY input only: it is never a
 * stock move and never reaches `planInventory` — the real reservation is built
 * from each drawn candidate's own `targets`. `bundleAvailability` reads only
 * `included`, `resolution`, `qty_per_bundle`, `sale_types` and `shipping_type`
 * from a component, which is why the cast below is safe and why `unit` (a
 * price this function never looks at) is absent.
 */
export function mysteryAvailability(input: {
  offerProductId: string;
  spoolQty: number;
  mode: MysterySaleMode;
  candidates: MysteryCandidate[];
  transportMethod?: string;
  window: { starts_at: string | null; ends_at: string | null; nowMs: number };
  active: boolean;
  offer: OfferCheck;
}): CompositionAvailability {
  const supply = input.mode === 'direct' ? poolSupply(input.candidates) : null;
  const shipping: ShippingType = input.mode === 'direct' ? 'direct' : typeForTransport(input.transportMethod ?? 'air');
  const resolution: StockResolution =
    supply === null
      ? { targets: [], tracked: false, available: null, error: null }
      : {
          targets: [
            {
              scope: 'base',
              scope_id: '',
              stock: supply,
              reserved: 0,
              low_stock_threshold: null,
              label: 'mystery pool',
            },
          ],
          tracked: true,
          available: supply,
          error: null,
        };
  const component = {
    component_id: `mystery:${input.offerProductId}`,
    member_product_id: input.offerProductId,
    qty_per_bundle: Math.max(1, input.spoolQty),
    optional: false,
    included: true,
    selection: { option_value_ids: [], color_id: null },
    resolution,
    sale_types: input.mode === 'direct' ? ['direct_sale'] : ['pre_order'],
    shipping_type: shipping,
  } as unknown as ResolvedComponent;

  const availability = bundleAvailability([component], input.window, input.active, input.offer);
  // An empty pool is an honest sold-out, not "unconfigured": there IS an offer,
  // it simply has nothing to sell right now.
  if (input.candidates.length === 0 && availability.state !== 'ended' && availability.state !== 'upcoming' && availability.state !== 'locked') {
    return { ...availability, state: 'sold_out', max_bundles: 0, errors: [...new Set([...availability.errors, 'MYSTERY_NO_ELIGIBLE_STOCK'])] };
  }
  return availability;
}

// ------------------------------------------------------ the batch's rows

export interface AllocationInput {
  order_item_id: string;
  spool_index: number;
  order_id: string;
  offer_product_id: string;
  pool_id: string;
  candidate: MysteryCandidate;
  sale_mode: MysterySaleMode;
  seed: string;
  reveal_stage_snapshot: string;
  candidates_sha256: string;
}

/**
 * One statement per spool, for the ORDER'S OWN BATCH — never a second batch and
 * never a post-response write. `PRIMARY KEY (order_item_id, spool_index)` is
 * the replay fence: a replay that somehow re-entered the write path collides
 * and aborts the whole batch, exactly as `gift_redemptions`' primary key does.
 */
export function allocationStatement(db: D1Database, a: AllocationInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mystery_allocations
         (order_item_id, spool_index, order_id, offer_product_id, pool_id, pool_entry_id, product_id,
          option_value_ids, color_id, name_snapshot, image_snapshot, variant_snapshot,
          sale_mode, seed, reveal_stage_snapshot, candidates_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      a.order_item_id,
      a.spool_index,
      a.order_id,
      a.offer_product_id,
      a.pool_id,
      a.candidate.entry_id,
      a.candidate.product_id,
      JSON.stringify(a.candidate.option_value_ids),
      a.candidate.color_id,
      a.candidate.name_snapshot,
      a.candidate.image_snapshot,
      a.candidate.variant_snapshot,
      a.sale_mode,
      a.seed,
      a.reveal_stage_snapshot,
      a.candidates_sha256
    );
}

/** One row per LINE (not per spool): the candidate list and the weights the
 *  draw actually ran against, so any past draw can be re-verified. */
export function drawAuditStatement(
  db: D1Database,
  input: {
    order_id: string;
    offer_product_id: string;
    cart_item_id: string;
    pool_id: string;
    canonical: string;
    sha256: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO mystery_draw_audits
         (order_id, offer_product_id, cart_item_id, pool_id, candidates, candidates_sha256)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(input.order_id, input.offer_product_id, input.cart_item_id, input.pool_id, input.canonical, input.sha256);
}

/**
 * REPRODUCING A PAST DRAW, years later, from stored facts alone: the seed on
 * the allocation, the candidate list in `mystery_draw_audits`, and the same
 * `weightedIndex` the draw used. Nothing about a randomised money mechanism can
 * be audited without this.
 */
export function replayDraw(input: {
  seed: string;
  cartItemId: string;
  spools: number;
  canonical: string;
  duplicatePolicy: DuplicatePolicy;
}): DrawResult {
  const rows = JSON.parse(input.canonical) as CanonicalCandidate[];
  const candidates: MysteryCandidate[] = rows.map((r) => ({
    entry_id: r.entry_id,
    product_id: r.product_id,
    option_value_ids: [],
    color_id: '',
    family_id: '',
    weight: r.weight,
    available: r.available,
    targets: [],
    name_snapshot: '',
    image_snapshot: '',
    variant_snapshot: '',
  }));
  return drawSpools({
    seed: input.seed,
    cartItemId: input.cartItemId,
    spools: input.spools,
    candidates,
    duplicatePolicy: input.duplicatePolicy,
  });
}
