/**
 * ONE PROMOTION MODEL — docs/BUNDLES_MYSTERY.md §9 and §4.6.
 *
 * A scheduled, tier-gated, limited, DISCOUNTED offer is one pair of rows —
 * `offer_windows` + `offer_limits` — attached to a subject, and the subject key
 * is `('product', productId)` for a bundle, a mystery offer AND an ordinary
 * product alike. That is what makes this literally one model rather than three,
 * and it is the strongest dividend of putting bundles in `products`.
 *
 * THREE DECISIONS LIVE HERE, AND NOWHERE ELSE.
 *
 * 1. WHEN. `scheduleState` — 'upcoming' | 'live' | 'ended', from two ISO
 *    instants and a clock. No cron flips an `active` flag: a fifteen-minute
 *    job would make a countdown lie by up to fifteen minutes.
 *
 * 2. WHO. `offerEligible` gates on an explicit SET of tiers, not on a ladder
 *    minimum, and that is a deliberate departure from `validateCoupon`.
 *    `TIER_RANK` is { free: 0, plus: 1, prime: 2, pro: 3 }, so a minimum of
 *    'plus' would silently admit PRIME to every PLUS-exclusive offer and hand
 *    it the PLUS member price — while the repo's own entitlements module states
 *    the opposite intent for buyer tiers in as many words ("PRIME does NOT
 *    [inherit PLUS]: it is a delivery/priority tier for buyers"). And the
 *    owner's own enumeration includes "PLUS + PRO but not PRIME", which is
 *    simply unrepresentable as a linear minimum. `TIER_RANK` stays the only
 *    RANKING in the tree; this is a membership relation, not a second ranking.
 *
 * 3. HOW MUCH. `resolveOfferPrice` — a window carries its own price, or
 *    "limited offer" would be a countdown over an unchanged number. Exactly one
 *    source may set a price for a subject: the window, or the subject's own
 *    ladder. Never both, never summed, never a percentage of a percentage —
 *    that is precisely the invalid stacking the mandate names. A coupon still
 *    applies afterwards, to merchandise, exactly as it does today.
 *
 * The limits are the DATABASE's decision, not this module's: the read-time
 * count here is advice for a friendly message, and
 * `trg_offer_redemption_limits` (migration 0060) is what actually refuses —
 * the same two-layer contract the coupons already follow.
 */

import { clampMemberLadder, TIER_RANK, type ResolvedPrice, type Tier } from './pricing';
import { benefits, type TierStatus } from './entitlements';
import { safeParse } from './types';
import { newId } from './crypto';

export type ScheduleState = 'upcoming' | 'live' | 'ended';

export type OfferReason =
  | 'OFFER_INACTIVE'
  | 'OFFER_WINDOW_NOT_STARTED'
  | 'OFFER_WINDOW_EXPIRED'
  | 'MEMBERSHIP_REQUIRED'
  | 'PER_USER_LIMIT_REACHED'
  | 'GLOBAL_LIMIT_REACHED';

export interface OfferWindow {
  id: string;
  starts_at: string | null;
  ends_at: string | null;
  /** The ALLOWED SET. [] = public, including a signed-out visitor. */
  required_tiers: Tier[];
  offer_price_mode: '' | 'fixed' | 'discount_percent' | 'discount_iqd';
  offer_price_iqd: number | null;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  locked_preview: boolean;
  active: boolean;
}

export interface OfferLimits {
  max_per_user: number | null;
  max_global: number | null;
}

export interface OfferView {
  window: OfferWindow | null;
  limits: OfferLimits | null;
}

export interface OfferCheck {
  ok: boolean;
  reason: OfferReason | null;
  required_tiers: Tier[];
  locked_preview: boolean;
}

export type Subject = [subjectType: string, subjectId: string];

const subjectKey = (s: Subject) => `${s[0]}:${s[1]}`;

/**
 * WHICH REQUIREMENTS A TIER SATISFIES. PRO inherits PLUS — the owner's rule,
 * and the same rule the merchant benefits already follow. PRIME stands alone:
 * it is a delivery/priority tier for buyers, and granting it PLUS access here
 * would hand it a PLUS-exclusive product and a PLUS price nobody sold it.
 */
export const INHERITS: Record<Tier, Tier[]> = {
  free: ['free'],
  plus: ['free', 'plus'],
  prime: ['free', 'prime'],
  pro: ['free', 'plus', 'pro'],
};

const TIERS: Tier[] = ['free', 'plus', 'prime', 'pro'];

/** Parses the stored JSON set, dropping anything that is not a real tier and
 *  sorting so two equal sets are equal strings in a snapshot. */
export function parseRequiredTiers(raw: unknown): Tier[] {
  const list = Array.isArray(raw) ? raw : safeParse<unknown[]>(String(raw ?? '[]'), []);
  const out = TIERS.filter((t) => (Array.isArray(list) ? list : []).includes(t));
  return out;
}

export function scheduleState(startsAt: string | null, endsAt: string | null, nowMs: number): ScheduleState {
  const start = startsAt ? Date.parse(startsAt) : NaN;
  const end = endsAt ? Date.parse(endsAt) : NaN;
  if (Number.isFinite(start) && nowMs < start) return 'upcoming';
  if (Number.isFinite(end) && nowMs > end) return 'ended';
  return 'live';
}

/**
 * The tier verdict for one viewer and one window. `status === null` is a
 * signed-out visitor, and they are ELIGIBLE unless a tier is required.
 *
 * `benefits.exclusiveSections` is ANDed ONLY when `required_tiers` is
 * non-empty. ANDing it unconditionally would make every offer
 * paid-members-only — the benefit itself requires an active paid tier — so
 * attaching a window to an ordinary product purely for a schedule or a
 * countdown would instantly make that product subscriber-only, and destroy the
 * one-model dividend the whole design is built on.
 */
export function offerEligible(status: TierStatus | null, view: OfferView | null, nowMs: number): OfferCheck {
  const window = view?.window ?? null;
  const required = window ? window.required_tiers : [];
  const lockedPreview = window ? window.locked_preview : true;
  const base = { required_tiers: required, locked_preview: lockedPreview };

  if (!window) return { ok: true, reason: null, ...base };
  if (!window.active) return { ok: false, reason: 'OFFER_INACTIVE', ...base };

  const state = scheduleState(window.starts_at, window.ends_at, nowMs);
  if (state === 'upcoming') return { ok: false, reason: 'OFFER_WINDOW_NOT_STARTED', ...base };
  if (state === 'ended') return { ok: false, reason: 'OFFER_WINDOW_EXPIRED', ...base };

  if (required.length === 0) return { ok: true, reason: null, ...base };
  if (!status) return { ok: false, reason: 'MEMBERSHIP_REQUIRED', ...base };
  // An admin restriction case pauses gated offer access without cancelling a
  // paid membership — that is what `gated_benefits` is for.
  if (!benefits.exclusiveSections(status)) return { ok: false, reason: 'MEMBERSHIP_REQUIRED', ...base };
  const allowed = required.some((r) => INHERITS[status.tier].includes(r));
  return allowed ? { ok: true, reason: null, ...base } : { ok: false, reason: 'MEMBERSHIP_REQUIRED', ...base };
}

/** True when this viewer's tier may be charged the offer's PLUS rung. */
const plusRungApplies = (tier: Tier, tierActive: boolean) => tier === 'plus' && tierActive;

/**
 * THE PRICE A LIVE WINDOW PRODUCES, and the ladder clamped against it.
 *
 * The regular price is derived FIRST and the member rungs are clamped against
 * THAT, never against the row's stored `price_iqd`. Anchoring on the stored
 * number breaks in a way nothing else could catch: `resolveUnitPrice` computes
 * a policy PRO price from the stored regular and clamps against the same
 * number, so once the offer price falls below it a PRO member is charged more
 * than a regular buyer, with no clamp able to see it.
 */
export function resolveOfferPrice(input: {
  base: ResolvedPrice;
  window: OfferWindow | null;
  scheduleState: ScheduleState;
  tier: Tier;
  tierActive: boolean;
  /** The floor a window price may never fall below — `bundle_config.min_price_iqd`
   *  for a composition subject, 1 for an ordinary product (§4.3). A resolved
   *  price under it does NOT clamp and does NOT sell. */
  floorIqd?: number;
}): {
  applied_iqd: number;
  regular_iqd: number;
  prime_iqd: number | null;
  pro_iqd: number | null;
  plus_iqd: number | null;
  offer_id: string | null;
  source: 'ladder' | 'offer';
  /** Machine codes. Non-empty means the window produced no sellable price. */
  errors: string[];
} {
  const { base, window } = input;
  const live = window !== null && window.active && input.scheduleState === 'live';
  const mode = live ? window.offer_price_mode : '';

  if (!live || mode === '') {
    // The subject's own ladder, untouched. An upcoming or ended window
    // contributes only its state and its countdown — never a price.
    return {
      applied_iqd: base.applied_iqd,
      regular_iqd: base.regular_iqd,
      prime_iqd: base.prime_iqd,
      pro_iqd: base.pro_iqd,
      plus_iqd: null,
      offer_id: window ? window.id : null,
      source: 'ladder',
      errors: [],
    };
  }

  const w = window as OfferWindow;
  let regular = base.regular_iqd;
  if (mode === 'fixed') regular = Math.max(0, Math.trunc(w.offer_price_iqd ?? base.regular_iqd));
  else if (mode === 'discount_percent') {
    const p = Math.min(90, Math.max(1, Math.trunc(w.discount_percent ?? 0)));
    regular = Math.max(0, Math.floor((base.regular_iqd * (100 - p)) / 100));
  } else if (mode === 'discount_iqd') {
    regular = base.regular_iqd - Math.max(0, Math.trunc(w.discount_iqd ?? 0));
  }

  /**
   * A WINDOW PRICE HAS A FLOOR, exactly as a derived bundle price does (§4.3).
   *
   * Both floors were written for `bundle_config.price_mode` alone, and §4.6
   * then made a live window the SOLE price source — so a `fixed` price of 0, or
   * a `discount_iqd` with one zero too many, sold any product or bundle for 0
   * IQD merchandise, passed every gate, accrued no points and was never warned
   * about. `Math.max(0, …)` is what made it silent: it turned an impossible
   * price into a free one. The rule is the same one §4.3 states for a derived
   * price — it does not clamp and it does not sell.
   */
  const floorIqd = Math.max(1, Math.trunc(input.floorIqd ?? 1));
  if (regular < floorIqd) {
    return {
      applied_iqd: base.applied_iqd,
      regular_iqd: base.regular_iqd,
      prime_iqd: base.prime_iqd,
      pro_iqd: base.pro_iqd,
      plus_iqd: null,
      offer_id: w.id,
      source: 'ladder',
      errors: ['DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE'],
    };
  }

  // Derive first, THEN clamp — the ladder's anchor is the offer price.
  const { prime, pro } = clampMemberLadder(regular, base.prime_iqd, base.pro_iqd);
  let plus: number | null =
    w.plus_price_iqd === null || w.plus_price_iqd === undefined ? null : Math.max(0, Math.trunc(w.plus_price_iqd));
  if (plus !== null) {
    plus = Math.min(plus, regular);
    if (pro !== null) plus = Math.max(plus, pro);
    if (prime !== null) plus = Math.max(plus, prime);
  }

  let applied = regular;
  if (input.tier === 'pro' && input.tierActive && pro !== null) applied = pro;
  else if (input.tier === 'prime' && input.tierActive && prime !== null) applied = prime;
  else if (plusRungApplies(input.tier, input.tierActive) && plus !== null) applied = plus;

  return { applied_iqd: applied, regular_iqd: regular, prime_iqd: prime, pro_iqd: pro, plus_iqd: plus, offer_id: w.id, source: 'offer', errors: [] };
}

/**
 * THE OFFER-FLOOR REFUSAL, in one place.
 *
 * `applyOfferToResolved` pushes `OFFER_INACTIVE` into `ResolvedPrice.errors`
 * when a window price fell below its floor, and every purchase door already
 * refuses on a non-empty `errors`. This turns that generic `VALIDATION` into
 * the named, translated code §15.3 gives the customer, so the sentence they
 * read is "this offer is not available right now" rather than a list of
 * machine codes.
 */
export function offerPriceRefusal(errors: readonly string[]): 'OFFER_INACTIVE' | null {
  return errors.includes('OFFER_INACTIVE') ? 'OFFER_INACTIVE' : null;
}

// ------------------------------------------------------------------- loading

interface WindowRow {
  subject_type: string;
  subject_id: string;
  id: string;
  starts_at: string | null;
  ends_at: string | null;
  required_tiers: string;
  offer_price_mode: string;
  offer_price_iqd: number | null;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  locked_preview: number;
  active: number;
}

interface LimitRow {
  subject_type: string;
  subject_id: string;
  max_per_user: number | null;
  max_global: number | null;
}

const CHUNK = 50;

export function windowFromRow(r: WindowRow): OfferWindow {
  return {
    id: r.id,
    starts_at: r.starts_at ?? null,
    ends_at: r.ends_at ?? null,
    required_tiers: parseRequiredTiers(r.required_tiers),
    offer_price_mode:
      r.offer_price_mode === 'fixed' || r.offer_price_mode === 'discount_percent' || r.offer_price_mode === 'discount_iqd'
        ? r.offer_price_mode
        : '',
    offer_price_iqd: r.offer_price_iqd ?? null,
    discount_percent: r.discount_percent ?? null,
    discount_iqd: r.discount_iqd ?? null,
    plus_price_iqd: r.plus_price_iqd ?? null,
    locked_preview: !!r.locked_preview,
    active: !!r.active,
  };
}

/**
 * Windows and limits for many subjects in TWO queries, chunked. A listing
 * resolves the whole page at once rather than one round trip per card.
 * Subjects with no row are absent from the map, and absent means "no offer",
 * never "an offer that refuses".
 */
export async function loadOffers(db: D1Database, subjects: Subject[]): Promise<Map<string, OfferView>> {
  const out = new Map<string, OfferView>();
  const unique = new Map<string, Subject>();
  for (const s of subjects) unique.set(subjectKey(s), s);
  const list = [...unique.values()];
  if (list.length === 0) return out;

  const ensure = (key: string): OfferView => {
    const found = out.get(key);
    if (found) return found;
    const fresh: OfferView = { window: null, limits: null };
    out.set(key, fresh);
    return fresh;
  };

  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const where = part.map(() => '(subject_type = ? AND subject_id = ?)').join(' OR ');
    const args = part.flatMap((s) => [s[0], s[1]]);
    const [windows, limits] = await Promise.all([
      db.prepare(`SELECT * FROM offer_windows WHERE ${where}`).bind(...args).all<WindowRow>(),
      db.prepare(`SELECT * FROM offer_limits WHERE ${where}`).bind(...args).all<LimitRow>(),
    ]);
    for (const r of windows.results) ensure(`${r.subject_type}:${r.subject_id}`).window = windowFromRow(r);
    for (const r of limits.results) {
      ensure(`${r.subject_type}:${r.subject_id}`).limits = {
        max_per_user: r.max_per_user ?? null,
        max_global: r.max_global ?? null,
      };
    }
  }
  return out;
}

export const offerKey = subjectKey;

/** The subject key of a product — a bundle, a mystery offer and an ordinary
 *  product all share it, which is what makes this one promotion model. */
export const subjectOf = (productId: string): Subject => ['product', productId];

/**
 * The FRIENDLY half of the two-layer limit. It reads the counts and says which
 * limit a purchase of `qty` would cross, so the storefront can refuse with a
 * sentence instead of a database error. It is ADVICE: two callers can both read
 * "one left" and both be told yes. `trg_offer_redemption_limits` is what decides,
 * inside the checkout's own transaction, and its ABORT rolls the whole order back.
 */
export async function offerLimitAdvice(
  db: D1Database,
  subject: Subject,
  userId: string,
  qty: number
): Promise<OfferCheck> {
  const base: OfferCheck = { ok: true, reason: null, required_tiers: [], locked_preview: true };
  const limits = await db
    .prepare('SELECT max_per_user, max_global FROM offer_limits WHERE subject_type = ? AND subject_id = ?')
    .bind(subject[0], subject[1])
    .first<LimitRow>();
  if (!limits) return base;

  if (limits.max_global !== null && limits.max_global !== undefined) {
    const row = await db
      .prepare(
        // ACTIVE only, exactly as `trg_offer_redemption_limits` counts (0065):
        // advice that counted released rows would refuse a purchase the
        // trigger would have allowed.
        "SELECT COALESCE(SUM(qty), 0) AS n FROM offer_redemptions WHERE subject_type = ? AND subject_id = ? AND state = 'active'"
      )
      .bind(subject[0], subject[1])
      .first<{ n: number }>();
    if (Number(row?.n ?? 0) + qty > limits.max_global) return { ...base, ok: false, reason: 'GLOBAL_LIMIT_REACHED' };
  }
  if (limits.max_per_user !== null && limits.max_per_user !== undefined && userId) {
    const row = await db
      .prepare(
        "SELECT COALESCE(SUM(qty), 0) AS n FROM offer_redemptions WHERE subject_type = ? AND subject_id = ? AND user_id = ? AND state = 'active'"
      )
      .bind(subject[0], subject[1], userId)
      .first<{ n: number }>();
    if (Number(row?.n ?? 0) + qty > limits.max_per_user) return { ...base, ok: false, reason: 'PER_USER_LIMIT_REACHED' };
  }
  return base;
}

/**
 * THE SLOT COMES BACK ON A GENUINE CANCELLATION — AND NEVER FOR A MYSTERY
 * (owner decision 4, migration 0065).
 *
 * Appended to `cancelledOrderRefundStatements`, so it rides in the SAME batch
 * as the status flip and the refunds, behind the same `?2` fence: if the flip
 * did not land, the fence writes NULL into a NOT NULL column and the whole
 * batch — this statement included — rolls back.
 *
 * WHY `NOT EXISTS mystery_allocations` AND NOT "revealed". The owner's rule is
 * that a revealed mystery never frees its slot, and the only way to make that
 * STRUCTURAL rather than derived is to exclude every mystery order, revealed
 * or not. `revealed_at` is stamped by three call sites and the other half of
 * "revealed" is a pure TypeScript milestone check (`milestoneReached`) that
 * SQL cannot see — so a SQL predicate on `revealed_at` would free the slot of
 * an order the customer has, in fact, already seen. Excluding all of them
 * costs an unrevealed mystery cancel its slot and buys a re-roll path that
 * cannot exist. That trade is the owner's stated priority.
 */
export function releaseOrderRedemptionsStatement(
  db: D1Database,
  orderId: string,
  nowIso: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE offer_redemptions
          SET state = 'released', released_at = ?1
        WHERE order_id = ?2
          AND state = 'active'
          AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ?2 AND o.status = 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM mystery_allocations a WHERE a.order_id = ?2)`
    )
    .bind(nowIso, orderId);
}

/**
 * AND IT GOES BACK WHEN THE ORDER IS RE-OPENED. `cancelled` is not terminal:
 * the admin transition table allows cancelled -> pending/confirmed/processing
 * and the stage machine allows the same move, so an order whose slot was
 * released can come back to life. Without this the customer would hold the
 * goods and the entitlement at once.
 *
 * The re-claim is limit-checked by `trg_offer_redemption_reclaim` (0065): if
 * the freed slot was spent elsewhere in the meantime, the trigger aborts and
 * takes the re-open batch with it, which is the honest outcome. It is fenced
 * the other way round from the release — the order must NOT be cancelled any
 * more — so a re-claim can only ride a batch that actually re-opened it.
 */
export function reclaimOrderRedemptionsStatement(db: D1Database, orderId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE offer_redemptions
          SET state = 'active', released_at = NULL
        WHERE order_id = ?1
          AND state = 'released'
          AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ?1 AND o.status <> 'cancelled')`
    )
    .bind(orderId);
}

/**
 * ONE row per (subject, order), with `qty` SUMMED across every line of that
 * subject in the order — never one row per line. An order may legitimately hold
 * two lines of the same bundle (two different colour choices), and a second
 * INSERT would hit `UNIQUE (subject_type, subject_id, order_id)` and abort the
 * batch with a message the checkout's catch block does not map: a permanent
 * generic failure on a cart that could never succeed. Summing is also exactly
 * what the trigger's SUM(qty) semantics want.
 */
export function offerRedemptionStatement(
  db: D1Database,
  subject: Subject,
  userId: string,
  orderId: string,
  qty: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO offer_redemptions (id, subject_type, subject_id, user_id, order_id, qty)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(newId('ofr'), subject[0], subject[1], userId, orderId, Math.max(1, Math.trunc(qty)));
}

/**
 * THE ADMIN WRITE — a window and its limits for any subject, as statements.
 *
 * Statements rather than a batch of its own, because an offer is saved
 * alongside the product it belongs to: the caller pushes these into the
 * product save's ONE batch so a bundle and the window that gates it can never
 * half-commit. `subject_type` is 'product' for a bundle, a mystery offer and
 * an ordinary product alike — that is what makes this one promotion model
 * rather than three.
 *
 * Times are normalised to an explicit UTC `Z` here, at the write boundary,
 * because `AdminCoupons` posts timezone-less `datetime-local` strings that the
 * Worker then parses as UTC — the hazard §4.6 names, fixed on the way in.
 * `required_tiers` is stored SORTED so two equal sets compare equal.
 */
export function offerWindowStatements(
  db: D1Database,
  subject: Subject,
  offer: {
    starts_at: string | null;
    ends_at: string | null;
    required_tiers: string[];
    offer_price_mode: string;
    offer_price_iqd: number | null;
    discount_percent: number | null;
    discount_iqd: number | null;
    plus_price_iqd: number | null;
    locked_preview: boolean;
    active: boolean;
    max_per_user: number | null;
    max_global: number | null;
  } | null
): D1PreparedStatement[] {
  const [type, id] = subject;
  if (!offer) {
    // No offer block at all: the subject keeps whatever it has. Deleting a
    // window the caller never mentioned would silently un-gate a members-only
    // bundle, which is exactly the kind of quiet repair the contract forbids.
    return [];
  }
  const tiers = [...new Set(offer.required_tiers.filter((t): t is Tier => t in INHERITS))].sort();
  const mode =
    offer.offer_price_mode === 'fixed' ||
    offer.offer_price_mode === 'discount_percent' ||
    offer.offer_price_mode === 'discount_iqd'
      ? offer.offer_price_mode
      : '';
  return [
    db
      .prepare(
        `INSERT INTO offer_windows
           (subject_type, subject_id, id, starts_at, ends_at, required_tiers, offer_price_mode,
            offer_price_iqd, discount_percent, discount_iqd, plus_price_iqd, locked_preview, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_type, subject_id) DO UPDATE SET
           starts_at = excluded.starts_at,
           ends_at = excluded.ends_at,
           required_tiers = excluded.required_tiers,
           offer_price_mode = excluded.offer_price_mode,
           offer_price_iqd = excluded.offer_price_iqd,
           discount_percent = excluded.discount_percent,
           discount_iqd = excluded.discount_iqd,
           plus_price_iqd = excluded.plus_price_iqd,
           locked_preview = excluded.locked_preview,
           active = excluded.active,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .bind(
        type,
        id,
        // The offer identity frozen into an order snapshot. Deterministic per
        // subject so re-saving a window does not orphan the id a past order
        // recorded.
        `ofw_${id.replace(/[^A-Za-z0-9]/g, '').slice(-24) || 'x'}`,
        normalizeUtc(offer.starts_at),
        normalizeUtc(offer.ends_at),
        JSON.stringify(tiers),
        mode,
        mode === 'fixed' ? offer.offer_price_iqd : null,
        mode === 'discount_percent' ? offer.discount_percent : null,
        mode === 'discount_iqd' ? offer.discount_iqd : null,
        offer.plus_price_iqd,
        offer.locked_preview ? 1 : 0,
        offer.active ? 1 : 0
      ),
    db
      .prepare(
        `INSERT INTO offer_limits (subject_type, subject_id, max_per_user, max_global)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(subject_type, subject_id) DO UPDATE SET
           max_per_user = excluded.max_per_user,
           max_global = excluded.max_global`
      )
      .bind(type, id, offer.max_per_user, offer.max_global),
  ];
}

/** An ISO instant with an explicit Z, or null. A `datetime-local` string with
 *  no zone is read as Baghdad time (UTC+3) — the zone the store runs in and
 *  the one `worker/routes/rewards.ts` already hardcodes — so a countdown means
 *  what the admin typed. */
export function normalizeUtc(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : `${v.length === 16 ? `${v}:00` : v}+03:00`;
  const ms = Date.parse(zoned);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Re-exported so a reader can see that the only RANKING in the tree is still
 *  `TIER_RANK`, and that this module does not introduce a second one. */
export { TIER_RANK };

// -------------------------------------------- the offer price on ANY line

/**
 * THE SCHEDULED SPECIAL OFFER, APPLIED TO A RESOLVED LINE (§4.6, §10, §12).
 *
 * `resolveUnitPrice` prices an ordinary product from its own ladder and knows
 * nothing about windows — deliberately: it is `packages/pricing`, it is shared
 * with the merchant storefront, and §16 lists it as NOT CHANGED. So the offer
 * is applied HERE, after it, by the one function every door calls: the card,
 * the detail page, the cart line and the checkout.
 *
 * The FEES ARE PRESERVED EXACTLY. `unit_subtotal_iqd - applied_iqd` is the
 * transport commission, the direct-sale premium and the warranty fee with
 * every PRO waiver already applied; re-deriving them here would be a second
 * implementation of the rule the resolver owns. Only the merchandise number
 * moves.
 *
 * An `upcoming` or `ended` window changes NO price (`resolveOfferPrice`
 * returns the ladder), so a countdown can be attached to a product without
 * touching what it costs today.
 */
export function applyOfferToResolved(
  resolved: ResolvedPrice,
  view: OfferView | null,
  tier: Tier,
  tierActive: boolean,
  nowMs: number
): { resolved: ResolvedPrice; offer_id: string | null; source: 'ladder' | 'offer'; plus_iqd: number | null } {
  const window = view?.window ?? null;
  if (!window) return { resolved, offer_id: null, source: 'ladder', plus_iqd: null };
  const priced = resolveOfferPrice({
    base: resolved,
    window,
    scheduleState: scheduleState(window.starts_at, window.ends_at, nowMs),
    tier,
    tierActive,
  });
  if (priced.source === 'ladder') {
    // A window whose price fell below the floor contributes NO price, and says
    // so through the resolver's own error channel: `POST /api/cart/items`,
    // `PATCH /api/cart/items/:id` and `priceLines` all refuse when
    // `ResolvedPrice.errors` is non-empty, so nothing is ever sold at 0 IQD
    // because an admin typed one zero too many (§4.3).
    const resolvedOut = priced.errors.length
      ? { ...resolved, errors: [...resolved.errors, ...priced.errors] }
      : resolved;
    return { resolved: resolvedOut, offer_id: priced.offer_id, source: 'ladder', plus_iqd: null };
  }
  const fees = Math.max(0, resolved.unit_subtotal_iqd - resolved.applied_iqd);
  return {
    resolved: {
      ...resolved,
      regular_iqd: priced.regular_iqd,
      prime_iqd: priced.prime_iqd,
      pro_iqd: priced.pro_iqd,
      applied_iqd: priced.applied_iqd,
      // `applied_tier` stays inside the shared three-value union: the PLUS
      // rung is offer-scoped and is named beside the offer, never on a field
      // every ordinary line in the cart also carries (§4.4).
      applied_tier:
        priced.applied_iqd === priced.pro_iqd && priced.pro_iqd !== null
          ? 'pro'
          : priced.applied_iqd === priced.prime_iqd && priced.prime_iqd !== null
            ? 'prime'
            : 'regular',
      unit_subtotal_iqd: priced.applied_iqd + fees,
    },
    offer_id: priced.offer_id,
    source: 'offer',
    plus_iqd: priced.plus_iqd,
  };
}
