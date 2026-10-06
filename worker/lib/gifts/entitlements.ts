/**
 * THE GIFT LIFECYCLE — ONE STATE MACHINE (docs/REVIEWS_GIFTS.md §Lifecycle).
 * Owner: lane S2 (routes in worker/routes/gifts.ts). Lane S3 reads the states
 * (cart and checkout) and lane C3 renders `GiftUiState`.
 *
 *   (reward submitted) ──admin «تأكيد وإصدار الكود»──► code_issued
 *   code_issued ──customer redeems the code──► redeemed_ready_to_order
 *   redeemed_ready_to_order ──[cart line exists]──► in_cart   (DERIVED, never stored)
 *   redeemed_ready_to_order ──checkout batch──► ordered        (order_id, order_item_id, ordered_at, order_seq+1)
 *   ordered ──order delivered (trigger)──► fulfilled
 *   ordered ──order cancelled, ANY door (trigger)──► redeemed_ready_to_order
 *   code_issued | redeemed_ready_to_order ──admin cancel──► cancelled
 *   code: issued ──revoke──► revoked ──re-issue──► issued (new verifier, code_version+1)
 *   legacy rows: available | selected | fulfilled | cancelled (grant_mode 'legacy'),
 *     read-only for the customer; admin may fulfil `selected`, cancel
 *     `available`, or CONVERT an `available` row by issuing a code.
 *
 * Every transition is ONE conditional UPDATE whose WHERE carries the
 * precondition (state, user, code_version / order_seq); 0 rows changed means
 * the race was lost and is answered as such, never retried blindly.
 */
import { safeParse } from '../types';
import { loadAuthoritativeProductImages } from '../productSelectionImage';
import { RECHECK_SQL, recheckPrinterGift } from '../reviews/eligibility';
import { loadGiftProduct, checkGiftSelection, type GiftProductContext } from './levels';
import { GIFT_CODE_MAX_ATTEMPTS } from './codes';

export type GiftState =
  | 'available' // legacy: box not chosen
  | 'selected' // legacy: box chosen, awaiting the manual hand-over
  | 'code_issued'
  | 'redeemed_ready_to_order'
  | 'ordered'
  | 'fulfilled'
  | 'cancelled';

export type GiftCodeState = 'none' | 'issued' | 'redeemed' | 'revoked';
export type GiftGrantMode = 'legacy' | 'level' | 'manual';

/**
 * What the customer's card shows — derived on the SERVER only; the SPA never
 * combines flags. `pending` is a reward still awaiting the admin (no
 * entitlement yet); `locked` is a code that absorbed 5 wrong tries.
 */
export type GiftUiState =
  | 'pending'
  | 'awaiting_code'
  | 'locked'
  | 'choose_item'
  | 'ready'
  | 'in_cart'
  | 'ordered'
  | 'delivered'
  | 'cancelled'
  | 'legacy';

export interface GiftUiFacts {
  state: GiftState;
  grant_mode: GiftGrantMode;
  code_state: GiftCodeState;
  code_attempts: number;
  /** A gift product is fixed (manual gift, a single-item level, or the customer's choice). */
  item_chosen: boolean;
  /** A cart line with this entitlement exists for the owner. */
  in_cart: boolean;
}

export function deriveGiftUiState(f: GiftUiFacts, maxAttempts = GIFT_CODE_MAX_ATTEMPTS): GiftUiState {
  if (f.grant_mode === 'legacy') return f.state === 'cancelled' ? 'cancelled' : 'legacy';
  switch (f.state) {
    case 'code_issued':
      return f.code_state === 'issued' && f.code_attempts >= maxAttempts ? 'locked' : 'awaiting_code';
    case 'redeemed_ready_to_order':
      if (!f.item_chosen) return 'choose_item';
      return f.in_cart ? 'in_cart' : 'ready';
    case 'ordered':
      return 'ordered';
    case 'fulfilled':
      return 'delivered';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'legacy';
  }
}

/** One option value the gift names: a pin (fixed by the admin) or a value the customer may pick. */
export interface GiftChoiceOption {
  id: string;
  group_id: string;
  /** The option group's (English) name, '' for a product without relational groups. */
  group_name: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  pinned: boolean;
}

/** One colour the gift names, with its option links (OR inside a group, AND across groups). */
export interface GiftChoiceColor {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  hex: string;
  pinned: boolean;
  links: Array<{ group_id: string; option_value_id: string }>;
}

/** One frozen gift item inside `gift_entitlements.gift_snapshot.items[]` (and in the /gifts view). */
export interface GiftSnapshotItem {
  /** Stable within the snapshot: the level item id, or 'manual'. Sent back by «choose item». */
  ref: string;
  pool_item_id: string | null;
  product_id: string;
  sale_type: 'direct_sale' | 'pre_order';
  /** Admin pins (canonical, sorted). */
  option_value_ids: string[];
  color_id: string;
  transport_method: '' | 'air' | 'sea' | 'land';
  /** What the customer may still pick (empty = nothing to pick). */
  allowed_option_value_ids: string[];
  allowed_color_ids: string[];
  display: {
    name_ar: string;
    name_en: string;
    name_ckb: string;
    /** `/files/<key>` — a media REFERENCE the orphan sweep protects (mediaRefs: gift_snapshot json). */
    image: string;
    variant_ar: string;
    variant_en: string;
    variant_ckb: string;
    color_name: string;
    color_hex: string;
    regular_iqd: number;
    /** S2 addition (optional): the colour's Arabic / Sorani names. */
    color_name_ar?: string;
    color_name_ckb?: string;
  };
  /**
   * S2 addition (optional): the words of every pin and every value the
   * customer may pick, frozen at issue — so the card can label a pick, and a
   * later rename in the catalogue never changes a granted gift.
   */
  choices?: { options: GiftChoiceOption[]; colors: GiftChoiceColor[] };
}

export interface GiftSnapshot {
  v: 1;
  mode: 'level' | 'manual';
  level: number;
  items: GiftSnapshotItem[];
}

/**
 * GET /api/reviews/gifts — one card. Never carries a code, a verifier or an
 * attempt count beyond `locked`. Contract shared with lane C3.
 */
export interface GiftView {
  id: string;
  ui_state: GiftUiState;
  level: number;
  grant_mode: GiftGrantMode;
  /** S2 addition (optional): `name_ckb`. */
  printer: { product_id: string; name: string; name_ar: string; image: string; name_ckb?: string };
  review_id: string;
  items: GiftSnapshotItem[];
  chosen: {
    ref: string;
    product_id: string;
    sale_type: 'direct_sale' | 'pre_order';
    option_value_ids: string[];
    color_id: string;
    transport_method: string;
    /** S2 addition (optional): the chosen item's frozen words, pins and picks together. */
    display?: GiftChosenDisplay;
  } | null;
  in_cart: { cart_item_id: string } | null;
  order: { id: string; status: string; stage: string | null } | null;
  /** Live orderability of the chosen item (stock/active/selection), null before a choice. */
  orderable: { ok: boolean; code: string | null } | null;
  created_at: string;
  redeemed_at: string | null;
  ordered_at: string | null;
  fulfilled_at: string | null;
  /** Legacy rows only: the old box contents, read-only. */
  legacy: { max_level: number; chosen_level: number | null; contents: unknown[] } | null;
}

export interface GiftChosenDisplay {
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  variant_ar: string;
  variant_en: string;
  variant_ckb: string;
  color_name: string;
  color_name_ar: string;
  color_name_ckb: string;
  color_hex: string;
  regular_iqd: number;
}

/** A reward awaiting the admin, shown as the quiet «pending» card. */
export interface PendingGiftView {
  reward_id: string;
  ui_state: 'pending';
  review_id: string;
  printer: { product_id: string; name: string; name_ar: string; image: string; name_ckb?: string };
  submitted_at: string;
  /** S2 addition (optional): 'submitted' or 'revision_needed'. */
  reward_state?: string;
}

// ------------------------------------------------------------------- parsing

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const ids = (v: unknown): string[] => {
  const list = safeParse<unknown[]>(text(v) || '[]', []);
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
};

/** The frozen snapshot of a row, or null for a legacy row / unparsable JSON. */
export function parseGiftSnapshot(raw: unknown): GiftSnapshot | null {
  const s = safeParse<Partial<GiftSnapshot> | null>(text(raw) || '{}', null);
  if (!s || s.v !== 1 || !Array.isArray(s.items)) return null;
  return s as GiftSnapshot;
}

/** The chosen item's words: the item's display, re-labelled with the customer's picks. */
export function chosenDisplay(item: GiftSnapshotItem, optionValueIds: string[], colorId: string): GiftChosenDisplay {
  const options = item.choices?.options ?? [];
  const colors = item.choices?.colors ?? [];
  const picked = options.filter((o) => optionValueIds.includes(o.id));
  const color = colors.find((c) => c.id === colorId) ?? null;
  const fromChoices = picked.length > 0 || !!color;
  const d = item.display;
  return {
    name_ar: d.name_ar,
    name_en: d.name_en,
    name_ckb: d.name_ckb,
    image: d.image,
    variant_ar: fromChoices ? picked.map((o) => o.name_ar).join(' / ') : d.variant_ar,
    variant_en: fromChoices ? picked.map((o) => o.name_en).join(' / ') : d.variant_en,
    variant_ckb: fromChoices ? picked.map((o) => o.name_ckb).join(' / ') : d.variant_ckb,
    color_name: color ? color.name_en : d.color_name,
    color_name_ar: color ? color.name_ar : d.color_name_ar ?? d.color_name,
    color_name_ckb: color ? color.name_ckb : d.color_name_ckb ?? d.color_name,
    color_hex: color ? color.hex : d.color_hex,
    regular_iqd: d.regular_iqd,
  };
}

// --------------------------------------------------------------- eligibility

/**
 * A LEGACY reward (no unit: admitted by the pre-0165 rules) is not judged
 * against the unit rules it never had — the admin decided it under the old
 * program. It must still be the reviewer's own published, user-written review.
 */
export const LEGACY_REWARD_FENCE_SQL = `
SELECT 1 FROM review_rewards lr JOIN reviews lv ON lv.id = lr.review_id
 WHERE lr.id = ?1 AND lr.kind = 'printer_gift' AND lr.unit_id IS NULL
   AND lv.user_id = lr.user_id AND lv.source = 'user' AND lv.status = 'published'`;

/**
 * THE ELIGIBILITY FENCE, as a boolean SQL expression over `?1` = reward id:
 * S1's re-check (follows a warranty replacement forward to the live unit:
 * still delivered, still the reviewer's, still registered to them, 5★,
 * published, not refunded or traded in), or the legacy fence for a reward
 * without a unit. Written into the issuing UPDATE and the redeeming UPDATE, so
 * the check and the write are ONE statement.
 */
export const GIFT_ELIGIBILITY_FENCE_SQL = `(EXISTS (${RECHECK_SQL}) OR EXISTS (${LEGACY_REWARD_FENCE_SQL}))`;

/** The same fence, asked on its own (the route answers 409/400 before writing). */
export async function giftStillEligible(db: D1Database, rewardId: string): Promise<boolean> {
  const unit = await db.prepare('SELECT unit_id FROM review_rewards WHERE id = ?').bind(rewardId).first<{ unit_id: string | null }>();
  if (!unit) return false;
  if (unit.unit_id) return (await recheckPrinterGift(db, rewardId)).ok;
  return !!(await db.prepare(LEGACY_REWARD_FENCE_SQL).bind(rewardId).first());
}

// --------------------------------------------------------------------- views

/**
 * Every column a view needs, for one or many entitlements. The cart line is
 * the owner's own (the 0165 trigger only admits the owner's line); the order
 * is the live one the entitlement names.
 */
export const GIFT_ROW_SELECT = `
SELECT ge.*, rr.review_id, rr.state AS reward_state, rr.unit_id AS reward_unit_id,
       COALESCE(rr.product_id, r.product_id) AS printer_id,
       COALESCE(rr.order_item_id, r.order_item_id) AS printer_line_id,
       p.name AS printer_name, p.name_ar AS printer_name_ar, p.name_ku AS printer_name_ckb,
       oi.image_snapshot AS printer_image_snapshot,
       (SELECT ci.id FROM cart_items ci WHERE ci.gift_entitlement_id = ge.id AND ci.user_id = ge.user_id) AS cart_item_id,
       o.status AS order_status, o.stage AS order_stage
  FROM gift_entitlements ge
  JOIN review_rewards rr ON rr.id = ge.reward_id
  JOIN reviews r ON r.id = rr.review_id
  LEFT JOIN products p ON p.id = COALESCE(rr.product_id, r.product_id)
  LEFT JOIN order_items oi ON oi.id = COALESCE(rr.order_item_id, r.order_item_id)
  LEFT JOIN orders o ON o.id = ge.order_id`;

export function giftUiFactsOf(row: Record<string, unknown>): GiftUiFacts {
  return {
    state: text(row.state) as GiftState,
    grant_mode: (text(row.grant_mode) || 'legacy') as GiftGrantMode,
    code_state: (text(row.code_state) || 'none') as GiftCodeState,
    code_attempts: Number(row.code_attempts) || 0,
    item_chosen: !!text(row.gift_product_id),
    in_cart: !!text(row.cart_item_id),
  };
}

/** A per-request memo of loaded products, so N gifts of one product read it once. */
export type GiftProductMemo = Map<string, Promise<GiftProductContext>>;

/**
 * One customer card from a `GIFT_ROW_SELECT` row. `orderable` is TODAY's
 * answer for the chosen item (stock, an active product, a selection that still
 * exists) — the same rule the cart door applies — so the card can say «غير
 * متاحة حاليًا» before the customer presses anything.
 */
export async function giftViewFromRow(
  env: { DB: D1Database },
  row: Record<string, unknown>,
  printerImages: Map<string, string>,
  memo: GiftProductMemo = new Map(),
  opts: { orderable?: boolean } = {}
): Promise<GiftView> {
  const facts = giftUiFactsOf(row);
  const ui = deriveGiftUiState(facts);
  const snapshot = parseGiftSnapshot(row.gift_snapshot);
  const items = snapshot?.items ?? [];
  const level = Number(row.chosen_level ?? row.max_level) || Number(row.max_level) || 0;
  const productId = text(row.gift_product_id);
  const chosenIds = ids(row.gift_option_value_ids);
  const ref = text(row.gift_item_ref);
  const item = items.find((i) => i.ref === ref) ?? null;
  const chosen = productId
    ? {
        ref,
        product_id: productId,
        sale_type: (text(row.gift_sale_type) === 'pre_order' ? 'pre_order' : 'direct_sale') as 'direct_sale' | 'pre_order',
        option_value_ids: chosenIds,
        color_id: text(row.gift_color_id),
        transport_method: text(row.gift_transport_method),
        ...(item ? { display: chosenDisplay(item, chosenIds, text(row.gift_color_id)) } : {}),
      }
    : null;

  let orderable: GiftView['orderable'] = null;
  if (chosen && opts.orderable !== false && (ui === 'ready' || ui === 'in_cart')) {
    try {
      let loading = memo.get(productId);
      if (!loading) {
        loading = loadGiftProduct(env, productId);
        memo.set(productId, loading);
      }
      const r = checkGiftSelection(
        await loading,
        {
          productId,
          saleType: chosen.sale_type,
          optionValueIds: chosen.option_value_ids,
          colorId: chosen.color_id,
          transportMethod: (['', 'air', 'sea', 'land'].includes(chosen.transport_method) ? chosen.transport_method : '') as '' | 'air' | 'sea' | 'land',
        },
        { requireSellable: true }
      );
      orderable = r.ok ? { ok: true, code: null } : { ok: false, code: r.code };
    } catch (e) {
      // Orderability is advice on a card; the cart door decides for real.
      console.error('gift orderability unavailable', e instanceof Error ? e.message : String(e));
      orderable = null;
    }
  }

  const printerId = text(row.printer_id);
  const legacy = facts.grant_mode === 'legacy';
  return {
    id: text(row.id),
    ui_state: ui,
    level,
    grant_mode: facts.grant_mode,
    printer: {
      product_id: printerId,
      name: text(row.printer_name),
      name_ar: text(row.printer_name_ar) || text(row.printer_name),
      image: text(row.printer_image_snapshot) || printerImages.get(printerId) || '',
      name_ckb: text(row.printer_name_ckb) || text(row.printer_name_ar) || text(row.printer_name),
    },
    review_id: text(row.review_id),
    items,
    chosen,
    in_cart: facts.in_cart ? { cart_item_id: text(row.cart_item_id) } : null,
    order: text(row.order_id)
      ? { id: text(row.order_id), status: text(row.order_status), stage: row.order_stage == null ? null : text(row.order_stage) }
      : null,
    orderable,
    created_at: text(row.created_at),
    redeemed_at: row.code_redeemed_at == null ? null : text(row.code_redeemed_at),
    ordered_at: row.ordered_at == null ? null : text(row.ordered_at),
    fulfilled_at: row.fulfilled_at == null ? null : text(row.fulfilled_at),
    legacy: legacy
      ? {
          max_level: Number(row.max_level) || 0,
          chosen_level: row.chosen_level == null ? null : Number(row.chosen_level),
          contents: safeParse<unknown[]>(text(row.contents) || '[]', []),
        }
      : null,
  };
}

/** The authoritative product image of every printer a set of rows names (one bounded read). */
export async function printerImagesFor(db: D1Database, rows: ReadonlyArray<Record<string, unknown>>): Promise<Map<string, string>> {
  const missing = rows.filter((r) => !text(r.printer_image_snapshot)).map((r) => text(r.printer_id)).filter(Boolean);
  return missing.length ? loadAuthoritativeProductImages(db, missing) : new Map();
}

/** One entitlement as the customer sees it (no ownership check — callers pass their own WHERE). */
export async function loadGiftView(env: { DB: D1Database }, entitlementId: string): Promise<GiftView | null> {
  const row = await env.DB.prepare(`${GIFT_ROW_SELECT} WHERE ge.id = ?`).bind(entitlementId).first<Record<string, unknown>>();
  if (!row) return null;
  return giftViewFromRow(env, row, await printerImagesFor(env.DB, [row]));
}

/** GET /api/reviews/gifts — the customer's cards and quiet pending cards. */
export async function loadCustomerGifts(env: { DB: D1Database }, userId: string): Promise<{ gifts: GiftView[]; pending: PendingGiftView[] }> {
  const [{ results: rows }, { results: pendingRows }] = await Promise.all([
    env.DB.prepare(`${GIFT_ROW_SELECT} WHERE ge.user_id = ? ORDER BY ge.created_at DESC, ge.id DESC LIMIT 50`)
      .bind(userId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT rr.id AS reward_id, rr.review_id, rr.state AS reward_state, rr.created_at,
              COALESCE(rr.product_id, r.product_id) AS printer_id,
              p.name AS printer_name, p.name_ar AS printer_name_ar, p.name_ku AS printer_name_ckb,
              oi.image_snapshot AS printer_image_snapshot
         FROM review_rewards rr
         JOIN reviews r ON r.id = rr.review_id
         LEFT JOIN products p ON p.id = COALESCE(rr.product_id, r.product_id)
         LEFT JOIN order_items oi ON oi.id = COALESCE(rr.order_item_id, r.order_item_id)
        WHERE rr.user_id = ? AND rr.kind = 'printer_gift' AND rr.state IN ('submitted', 'revision_needed')
          AND NOT EXISTS (SELECT 1 FROM gift_entitlements g WHERE g.reward_id = rr.id)
        ORDER BY rr.created_at DESC LIMIT 20`
    )
      .bind(userId)
      .all<Record<string, unknown>>(),
  ]);
  const images = await printerImagesFor(env.DB, [...rows, ...pendingRows]);
  const memo: GiftProductMemo = new Map();
  const gifts = await Promise.all(rows.map((row) => giftViewFromRow(env, row, images, memo)));
  const pending: PendingGiftView[] = pendingRows.map((r) => {
    const printerId = text(r.printer_id);
    return {
      reward_id: text(r.reward_id),
      ui_state: 'pending',
      review_id: text(r.review_id),
      printer: {
        product_id: printerId,
        name: text(r.printer_name),
        name_ar: text(r.printer_name_ar) || text(r.printer_name),
        image: text(r.printer_image_snapshot) || images.get(printerId) || '',
        name_ckb: text(r.printer_name_ckb) || text(r.printer_name_ar) || text(r.printer_name),
      },
      submitted_at: text(r.created_at),
      reward_state: text(r.reward_state),
    };
  });
  return { gifts, pending };
}

/**
 * The admin's view of one granted gift: the customer card plus the code's
 * bookkeeping. NEVER the code or its verifier.
 */
export function adminGiftFields(row: Record<string, unknown>) {
  return {
    entitlement_id: text(row.id),
    state: text(row.state),
    grant_mode: (text(row.grant_mode) || 'legacy') as GiftGrantMode,
    level: Number(row.chosen_level ?? row.max_level) || Number(row.max_level) || 0,
    code_state: (text(row.code_state) || 'none') as GiftCodeState,
    code_attempts: Number(row.code_attempts) || 0,
    code_locked: text(row.code_state) === 'issued' && (Number(row.code_attempts) || 0) >= GIFT_CODE_MAX_ATTEMPTS,
    code_version: Number(row.code_version) || 0,
    code_issued_at: row.code_issued_at == null ? null : text(row.code_issued_at),
    code_issued_by: row.code_issued_by == null ? null : text(row.code_issued_by),
    code_redeemed_at: row.code_redeemed_at == null ? null : text(row.code_redeemed_at),
    code_revoked_at: row.code_revoked_at == null ? null : text(row.code_revoked_at),
    cancelled_at: row.cancelled_at == null ? null : text(row.cancelled_at),
    cancelled_by: row.cancelled_by == null ? null : text(row.cancelled_by),
    cancel_reason: text(row.cancel_reason),
  };
}
