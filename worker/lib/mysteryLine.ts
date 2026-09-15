/**
 * THE MYSTERY LINE — the bridge between the draw engine (`mysteryDraw.ts`) and
 * the read, cart and checkout paths (docs/BUNDLES_MYSTERY.md §5.3, §7).
 *
 * A mystery offer is a `products` row with `composition = 'mystery'` and NO
 * `bundle_components`: its contents are drawn, not composed. Everything else
 * about it is a composition row — one product, one price, one offer window,
 * one cart line — so it goes through `resolveCompositionLines` exactly as a
 * bundle does and this module replaces the ONE verdict that differs: the
 * availability, which comes from the eligible pool rather than from a
 * component list.
 *
 * WHY THE AVAILABILITY IS PATCHED ON RATHER THAN COMPUTED INSIDE
 * `resolveOne`: that function is synchronous and pure over already-loaded
 * rows, and the candidate query is a database read per pool. Keeping it
 * outside preserves the property §14 depends on — one resolution pass, three
 * reads, whatever the page size — and keeps the pool query "one per pool per
 * request, never per spool, never per card".
 *
 * WHAT NEVER CROSSES THE BOUNDARY FROM HERE: a pool id, a candidate, a weight,
 * a seed, an entry, a count. The customer-facing shape is `publicMysteryBlock`
 * at the bottom of this file, and it is deliberately the only export that
 * builds a payload.
 */

import type { CompositionAvailability } from './bundleComposition';
import type { BundleConfig, ResolvedBundle } from './bundleRead';
import {
  candidatesDigest,
  drawSpools,
  loadCandidates,
  loadMysteryOffers,
  loadPool,
  mysteryAvailability,
  poolSupply,
  resolveMysteryMode,
  seedForLine,
  isDrawable,
  type DrawnSpool,
  type MysteryCandidate,
  type MysteryOffer,
  type MysteryPool,
  type MysterySaleMode,
  type DuplicatePolicy,
} from './mysteryDraw';
import { mysteryRefusal } from './mystery/issues';
import { normalizeRevealStage, stageForMilestone, type RevealStage } from './mysteryReveal';
import { stageLabel } from './orderStages';
import { badRequest } from './http';

// ------------------------------------------------------------------ config

export interface MysteryLineConfig {
  duplicate_policy: DuplicatePolicy;
  reveal_stage: RevealStage;
  show_odds: boolean;
}

const DUP: DuplicatePolicy[] = ['allow', 'discourage', 'forbid'];

/**
 * The mystery half of `bundle_config`, taken from the ALREADY-PARSED
 * `BundleConfig` rather than from the raw row.
 *
 * The row's columns are aliased `cfg_duplicate_policy` / `cfg_reveal_stage` /
 * `cfg_show_odds` by `COMPOSITION_COLUMNS`, so reading `row.reveal_stage`
 * silently found `undefined` and every allocation was frozen at the DEFAULT
 * milestone regardless of what the admin configured — the offer would have
 * been sold under one promise and revealed under another. One parser, one
 * source.
 */
export function mysteryConfigFrom(config: BundleConfig): MysteryLineConfig {
  const dp = String(config.duplicate_policy ?? '');
  return {
    duplicate_policy: (DUP as string[]).includes(dp) ? (dp as DuplicatePolicy) : 'allow',
    reveal_stage: normalizeRevealStage(config.reveal_stage),
    show_odds: config.show_odds === true,
  };
}

// ----------------------------------------------------------------- context

export interface MysteryContext {
  offer_product_id: string;
  offer: MysteryOffer | null;
  config: MysteryLineConfig;
  /** Resolved from the buyer's request, or the offer's only enabled mode. */
  mode: MysterySaleMode | null;
  pool: MysteryPool | null;
  /** The eligible candidate list this line would draw from. Server-only. */
  candidates: MysteryCandidate[];
  availability: CompositionAvailability;
  spool_qty: number;
  /** Every mode the offer actually has a pool for. */
  modes: MysterySaleMode[];
  /** The catalog/facet ids a buyer may narrow to — never a product name. */
  families: string[];
  /** The buyer's chosen family, validated against the pool. */
  family_id: string;
  /** Set when the configuration itself refuses this line; the card renders the
   *  honest state, the door throws. */
  error: 'MYSTERY_MODE_NOT_AVAILABLE' | 'OFFER_INACTIVE' | null;
}

export interface MysteryLineRequest {
  key: string;
  bundle: ResolvedBundle;
  familyId?: string;
  /** '' for a direct line; a transport method for a pre-order one. */
  transportMethod?: string;
  requestedMode?: string | null;
}

/**
 * ONE PASS over every mystery line of a page, a cart or a checkout.
 *
 * The candidate query runs once per (pool, family) — never per line and never
 * per spool — which is what keeps a page of mystery cards at a constant number
 * of round trips (§14).
 */
export async function resolveMysteryLines(
  db: D1Database,
  requests: MysteryLineRequest[],
  nowMs: number
): Promise<Map<string, MysteryContext>> {
  const out = new Map<string, MysteryContext>();
  if (requests.length === 0) return out;

  const offers = await loadMysteryOffers(db, requests.map((r) => String(r.bundle.doc.id)));

  const poolCache = new Map<string, MysteryPool | null>();
  const candidateCache = new Map<string, MysteryCandidate[]>();
  const loadPoolOnce = async (id: string) => {
    if (!poolCache.has(id)) poolCache.set(id, await loadPool(db, id));
    return poolCache.get(id) ?? null;
  };
  /**
   * 0075: THE ROUTE IS PART OF THE QUESTION, SO IT IS PART OF THE CACHE KEY.
   *
   * A pre-order candidate's counter is the chosen route's own quota when it
   * has one and the cell's shared pool otherwise, so two lines of the same
   * pool on different routes are two different answers. Dropping the route
   * here — which is what this did — made `loadCandidates` resolve every
   * pre-order pool against the shared pool, and a route with its own quota was
   * then judged on a counter it does not spend. The key keeps one query per
   * (pool, family, route) rather than per line (§14).
   */
  const loadCandidatesOnce = async (pool: MysteryPool, familyId: string, transportMethod: string) => {
    const route = pool.kind === 'preorder' ? transportMethod : '';
    const key = `${pool.id}|${familyId}|${route}`;
    if (!candidateCache.has(key)) {
      const set = await loadCandidates(db, pool, { familyId, transportMethod: route });
      candidateCache.set(key, set.candidates);
    }
    return candidateCache.get(key) ?? [];
  };

  for (const req of requests) {
    const b = req.bundle;
    const productId = String(b.doc.id);
    const config = mysteryConfigFrom(b.config);
    const offer = offers.get(productId) ?? null;
    const modes: MysterySaleMode[] = [];
    if (offer?.allow_direct && offer.direct_pool_id) modes.push('direct');
    if (offer?.allow_preorder && offer.preorder_pool_id) modes.push('preorder');

    const base: MysteryContext = {
      offer_product_id: productId,
      offer,
      config,
      mode: null,
      pool: null,
      candidates: [],
      availability: unconfigured(b),
      spool_qty: offer?.spool_qty ?? 1,
      modes,
      families: [],
      family_id: '',
      error: offer ? null : 'OFFER_INACTIVE',
    };
    if (!offer) {
      out.set(req.key, base);
      continue;
    }

    // The buyer's mode, or the offer's only enabled one. Two SEPARATE pools,
    // so a direct-sale purchase can never silently become a pre-order (§7.6).
    let mode: MysterySaleMode;
    let poolId: string;
    try {
      const requested = req.requestedMode ?? (req.transportMethod ? 'preorder' : null);
      const resolution = resolveMysteryMode(offer, requested);
      mode = resolution.mode;
      poolId = resolution.pool_id;
    } catch {
      out.set(req.key, { ...base, error: 'MYSTERY_MODE_NOT_AVAILABLE' });
      continue;
    }

    const pool = await loadPoolOnce(poolId);
    if (!pool || !pool.active) {
      out.set(req.key, { ...base, mode, error: 'OFFER_INACTIVE' });
      continue;
    }

    // A family the buyer may narrow to — only when the admin allowed it, and
    // only from the ids the pool itself carries. An unrecognised family is
    // IGNORED rather than refused: it is a filter, not a purchase term, and
    // refusing it would tell a caller which families exist.
    // The SAME route `mysteryAvailability` is told about below and the same one
    // the line will be sold on, so the wheel, the availability and the
    // reservation read one counter.
    const route = req.transportMethod || 'air';
    const all = await loadCandidatesOnce(pool, '', route);
    const families = [...new Set(all.map((c) => c.family_id).filter(Boolean))].sort();
    const wanted = offer.customer_picks_family ? String(req.familyId ?? '').trim() : '';
    const familyId = wanted && families.includes(wanted) ? wanted : '';
    const candidates = familyId ? await loadCandidatesOnce(pool, familyId, route) : all;

    const availability = mysteryAvailability({
      offerProductId: productId,
      spoolQty: offer.spool_qty,
      mode,
      candidates,
      transportMethod: route,
      window: {
        starts_at: b.window?.starts_at ?? null,
        ends_at: b.window?.ends_at ?? null,
        nowMs,
      },
      active: b.doc.status === 'active' && !b.pricing.errors.includes('OFFER_INACTIVE'),
      offer: b.offer,
    });

    out.set(req.key, {
      ...base,
      mode,
      pool,
      candidates,
      availability,
      families,
      family_id: familyId,
      error: null,
    });
  }
  return out;
}

/** The availability a mystery row with no offer row reports: there is no
 *  offer here to sell, which is `unconfigured`, not `sold_out`. */
function unconfigured(b: ResolvedBundle): CompositionAvailability {
  // A tier gate outranks a missing configuration: a locked card must still
  // read as locked, or a signed-out visitor is told the offer is broken
  // rather than that it is for members.
  const locked = b.availability.state === 'locked';
  return {
    state: locked ? 'locked' : 'unconfigured',
    max_bundles: 0,
    blocking: [],
    shipping_type: 'direct',
    modes: [],
    member_exclusive: false,
    errors: [locked ? 'MEMBERSHIP_REQUIRED' : 'OFFER_INACTIVE'],
  };
}

/**
 * The resolved bundle with the POOL'S verdict in place of the (empty)
 * component list's. Returns a new object: `ResolvedBundle` is read by three
 * pricing passes and mutating it in place would let one pass see another's
 * state.
 */
export function withMysteryAvailability(b: ResolvedBundle, ctx: MysteryContext): ResolvedBundle {
  return { ...b, availability: ctx.availability };
}

// ------------------------------------------------------------- the refusal

/**
 * THE DOOR, for a mystery line. Called at add-to-cart and again at checkout —
 * never once — and it says nothing about the pool: not a count, not a name,
 * not a weight. `MYSTERY_NOT_ENOUGH_VARIETY` in particular carries NO count
 * (§7.5, §15.1 rule 9): a deterministic seed plus any oracle is a grinder, so
 * the absence of the oracle is part of the guarantee.
 */
export function refuseMystery(ctx: MysteryContext, label: string): void {
  if (ctx.error === 'MYSTERY_MODE_NOT_AVAILABLE') throw mysteryRefusal('MYSTERY_MODE_NOT_AVAILABLE');
  if (ctx.error === 'OFFER_INACTIVE') {
    throw badRequest(`"${label}" is not available right now (OFFER_INACTIVE)`, 'OFFER_INACTIVE');
  }
  // An empty eligible pool is an honest sold-out — 503, never invented
  // inventory and never a silent conversion to a pre-order (§7.6, case 14).
  if (ctx.candidates.length === 0 && ctx.availability.state === 'sold_out') {
    throw mysteryRefusal('MYSTERY_NO_ELIGIBLE_STOCK');
  }
}

/** Physical `order_items` rows one mystery line writes: the parent plus one
 *  row per spool (§3.1). The offer save already refuses a configuration whose
 *  `spool_qty × max_qty_per_order` exceeds the ceiling. */
export const mysteryPhysicalLines = (ctx: MysteryContext, qty: number): number =>
  ctx.spool_qty * Math.max(1, qty) + 1;

// ------------------------------------------------------------- the drawing

export interface MysteryDraw {
  spools: DrawnSpool[];
  seed: string;
  canonical: string;
  candidates_sha256: string;
  pool_id: string;
  mode: MysterySaleMode;
  reveal_stage: RevealStage;
}

/**
 * THE DRAW, computed once in the checkout pre-pass and read by all three
 * `priceLines` passes AND by the quote, so every one of them sees the same
 * filament (§5.3, §7.4 fence 3).
 *
 * It is a pure function of `(offer secret, cart_items.draw_salt, candidate
 * list, weights, duplicate policy)` — no value the client chooses is an input,
 * the checkout idempotency key least of all — so recomputing it is free and
 * PERSISTING it is what `allocate` controls. The quote therefore draws the
 * same spools it will sell and writes none of them.
 */
export async function drawMysteryLine(
  db: D1Database,
  ctx: MysteryContext,
  input: { cartItemId: string; drawSalt: string; qty: number; label: string }
): Promise<MysteryDraw> {
  refuseMystery(ctx, input.label);
  if (!ctx.pool || !ctx.mode) throw mysteryRefusal('MYSTERY_MODE_NOT_AVAILABLE');

  const seed = await seedForLine(db, ctx.offer_product_id, input.drawSalt);
  // No salt or no secret is a configuration fault, refused honestly rather
  // than papered over with a fresh random value — which would make the draw
  // unreproducible and the audit trail a lie.
  if (!seed) throw badRequest(`"${input.label}" is not available right now (OFFER_INACTIVE)`, 'OFFER_INACTIVE');

  const spools = ctx.spool_qty * Math.max(1, input.qty);
  const result = drawSpools({
    seed,
    cartItemId: input.cartItemId,
    spools,
    candidates: ctx.candidates,
    duplicatePolicy: ctx.config.duplicate_policy,
  });
  if (!result.ok) throw mysteryRefusal(result.code);

  const { canonical, sha256 } = await candidatesDigest(ctx.candidates);
  return {
    spools: result.spools,
    seed,
    canonical,
    candidates_sha256: sha256,
    pool_id: ctx.pool.id,
    mode: ctx.mode,
    reveal_stage: ctx.config.reveal_stage,
  };
}

// -------------------------------------------------------- customer payload

/**
 * §10's mystery detail block and §5.2's cart block — the ONLY mystery payload
 * a customer route may build. `spool_qty`, the enabled `modes`, the `families`
 * the admin opened up, the reveal milestone, and `odds` ONLY when the admin
 * switched them on.
 *
 * Never: a pool id, an entry, a product, a weight, a candidate count, a
 * supply figure. The odds are aggregated BY FAMILY, so even a switched-on
 * disclosure names no product.
 */
export function publicMysteryBlock(ctx: MysteryContext, lang = 'ar') {
  /**
   * WHEN, IN WORDS, FROM THE SERVER'S OWN STAGE TABLE.
   *
   * The cart could say how many spools and not when, though its own comment
   * promised both — so the one screen where the customer is committing to a
   * purchase whose contents are hidden told them the least about it. The label
   * comes from `stageLabel`, the same function the order timeline uses, and
   * never from a second stage table in the browser (§9's rule, restated in
   * `tests/orderStages.test.ts`). `'paid'` has no stage of its own, so it keeps
   * its own sentence.
   */
  const shippingType = ctx.mode === 'preorder' ? 'preorder_air' : 'direct';
  const milestone = ctx.config.reveal_stage as RevealStage;
  const stage = stageForMilestone(milestone, shippingType);
  return {
    spool_qty: ctx.spool_qty,
    modes: ctx.modes,
    families: ctx.families,
    family_id: ctx.family_id,
    customer_picks_family: !!ctx.offer?.customer_picks_family,
    reveal_stage: ctx.config.reveal_stage,
    reveal_stage_label: stage ? stageLabel(stage, shippingType, lang) : PAID_LABEL[lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar'],
    ...(ctx.config.show_odds ? { odds: familyOdds(ctx.candidates) } : {}),
  };
}

/** `'paid'` is not an order STAGE, so `stageLabel` has nothing to answer with
 *  and the milestone gets its own trilingual sentence. */
const PAID_LABEL = {
  ar: 'عند تأكيد الدفع',
  en: 'when payment is recorded',
  ckb: 'کاتێک پارەدان تۆمار دەکرێت',
} as const;

/**
 * Weighted probability per family, rounded to one decimal. Aggregated so the
 * disclosure the owner may switch on says «40% PLA, 60% PETG» and never names
 * a product, a colour or an entry — the useful half of transparency without
 * the half that is an oracle.
 */
export function familyOdds(candidates: MysteryCandidate[]): Array<{ family_id: string; percent: number }> {
  // OVER THE DRAWABLE SET, NOT EVERY ROW IN THE POOL (owner decision 8). The
  // wheel seeds itself with `isDrawable` and this is the same predicate, so a
  // family the server can no longer land on stops being advertised instead of
  // being published at a share it will never pay out.
  const drawable = candidates.filter(isDrawable);
  const total = drawable.reduce((n, c) => n + Math.max(0, c.weight), 0);
  if (total <= 0) return [];
  const byFamily = new Map<string, number>();
  for (const c of drawable) {
    byFamily.set(c.family_id, (byFamily.get(c.family_id) ?? 0) + Math.max(0, c.weight));
  }
  return [...byFamily.entries()]
    .map(([family_id, w]) => ({ family_id, percent: Math.round((w * 1000) / total) / 10 }))
    .sort((a, b) => b.percent - a.percent);
}

/** How many one-spool offers the eligible pool can back — ADMIN ONLY. It is
 *  re-exported here so no route has to reach into the draw engine for it. */
export const eligibleSupply = poolSupply;
