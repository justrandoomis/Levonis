/**
 * THE GIFT LIFECYCLE — ONE STATE MACHINE ON ONE TABLE (docs/GIFTS_QUICK_BUY.md
 * D1, D4, §1.2).
 *
 *   level grant ──customer «اختر هديتك»──► ready_to_redeem          (granted → ready_to_redeem)
 *   product grant (admin pinned one product) starts at ready_to_redeem
 *   ready_to_redeem ──customer «استرداد الهدية»──► redeemed
 *   redeemed + a cart line names the gift ──► ADDED_TO_ORDER        (DERIVED, never stored)
 *   redeemed ──the checkout batch──► ordered                         (order_id, order_item_id, order_seq + 1)
 *   ordered ──order delivered (trigger)──► fulfilled
 *   ordered ──order cancelled, ANY door (trigger)──► redeemed        (order link cleared, order_seq kept)
 *   granted | ready_to_redeem | redeemed ──admin cancel──► cancelled
 *   legacy rows: available | selected | fulfilled | cancelled (grant_mode 'legacy')
 *
 * Every transition is ONE conditional UPDATE whose WHERE carries the
 * precondition (state, user, version or order_seq), followed in the same batch
 * by a fence (`changedExactlyOne`) so a lost race rolls the whole batch back —
 * its audit row and notification with it.
 *
 * WHAT THE CUSTOMER NEVER SEES: `admin_note`, who granted the gift, the
 * admin's cancel reason, the idempotency key. `GiftView` is built field by
 * field from an explicit list for that reason (tests/giftRoutes.test.ts).
 */
import { safeParse } from '../types';
import {
  checkGiftSelection,
  giftSelectionOf,
  loadGiftProducts,
  parseGiftSnapshot,
  selectionFromColumns,
  selectionInput,
  type GiftProductContext,
  type GiftSelection,
  type GiftSelectionResult,
  type GiftSnapshot,
} from './selection';
import { legacyEntitlementView, legacyPoolItems, levelAvailability, type LegacyLevelAvailability } from './legacy';

export type GiftState = 'available' | 'selected' | 'granted' | 'ready_to_redeem' | 'redeemed' | 'ordered' | 'fulfilled' | 'cancelled';
export type GiftMode = 'legacy' | 'level' | 'product';
export type GiftReason = 'legacy' | 'review' | 'reward' | 'compensation' | 'admin_gift';
/** The reasons an admin may give a grant ('legacy' is the migration's own word). */
export const GRANT_REASONS = ['review', 'reward', 'compensation', 'admin_gift'] as const;
export type GrantReason = (typeof GRANT_REASONS)[number];
export type GiftStatus =
  | 'GRANTED'
  | 'READY_TO_REDEEM'
  | 'REDEEMED'
  | 'ADDED_TO_ORDER'
  | 'ORDERED'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'LEGACY';
export const GIFT_STATUSES: readonly GiftStatus[] = [
  'GRANTED',
  'READY_TO_REDEEM',
  'REDEEMED',
  'ADDED_TO_ORDER',
  'ORDERED',
  'FULFILLED',
  'CANCELLED',
  'LEGACY',
];

export const LEVELS = [1, 2, 3, 4, 5] as const;
export const levelPoolId = (n: number) => `gift_level_${n}`;

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const orNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : text(v));

/**
 * THE STATUS A SCREEN SHOWS, derived on the server only. ADDED_TO_ORDER is a
 * fact about the cart, not a stored state (D4): a removed cart line, an emptied
 * cart or a replaced one returns the gift to REDEEMED by itself.
 */
export function giftStatusOf(row: { state?: unknown; grant_mode?: unknown; cart_item_id?: unknown }): GiftStatus {
  if (text(row.grant_mode || 'legacy') === 'legacy') return 'LEGACY';
  switch (text(row.state)) {
    case 'granted':
      return 'GRANTED';
    case 'ready_to_redeem':
      return 'READY_TO_REDEEM';
    case 'redeemed':
      return text(row.cart_item_id) ? 'ADDED_TO_ORDER' : 'REDEEMED';
    case 'ordered':
      return 'ORDERED';
    case 'fulfilled':
      return 'FULFILLED';
    default:
      return 'CANCELLED';
  }
}

export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

export interface LevelView {
  n: number;
  name: Tri;
  description: Tri;
  active: boolean;
}

export interface GiftItemView {
  /** The level item, or null for a product the admin pinned directly. */
  item_id: string | null;
  product_id: string;
  slug: string;
  name: Tri;
  image: string;
  variant: Tri;
  color: (Tri & { hex: string }) | null;
  qty: number;
  sale_type: 'direct_sale' | 'pre_order';
  transport_method: string;
  /** What the gift is worth at the regular price (never charged). */
  value_iqd: number;
  lead_time_text: string;
  /** Orderable now (stock, an active product, a selection that still exists); null = not asked. */
  available: boolean | null;
  /** The refusal code when it is not. */
  reason: string | null;
}

/** GET /api/gifts — one card. NEVER the admin note, the granting admin or the internal cancel reason. */
export interface GiftView {
  id: string;
  status: GiftStatus;
  mode: GiftMode;
  reason: GiftReason;
  level: LevelView | null;
  /** The level's alternatives, while the customer may still choose (level mode, before redeem). */
  choices: GiftItemView[] | null;
  chosen: GiftItemView | null;
  can_change_choice: boolean;
  cart_item_id: string | null;
  order: { id: string; status: string; stage: string | null } | null;
  granted_at: string;
  chosen_at: string | null;
  redeemed_at: string | null;
  ordered_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  /** Legacy review boxes only — the old card, read as it always was. */
  legacy: (ReturnType<typeof legacyEntitlementView> & { levels: LegacyLevelAvailability[] }) | null;
}

/** Every column a view needs, for one or many gifts. The cart line is the owner's own. */
export const GIFT_ROW_SELECT = `
SELECT g.*,
       (SELECT ci.id FROM cart_items ci WHERE ci.gift_entitlement_id = g.id AND ci.user_id = g.user_id LIMIT 1) AS cart_item_id,
       o.status AS order_status, o.stage AS order_stage
  FROM gift_entitlements g
  LEFT JOIN orders o ON o.id = g.order_id`;

/** The reviewed printer a legacy row was granted for (legacy cards only). */
const LEGACY_PRODUCT_SELECT = `
SELECT ge.id, rr.review_id, r.product_id, p.name AS product_name, p.name_ar AS product_name_ar
  FROM gift_entitlements ge
  LEFT JOIN review_rewards rr ON rr.id = ge.reward_id
  LEFT JOIN reviews r ON r.id = rr.review_id
  LEFT JOIN products p ON p.id = r.product_id
 WHERE ge.id IN (SELECT value FROM json_each(?))`;

// ------------------------------------------------------------------ levels

export function levelViewFrom(row: Record<string, unknown> | undefined, n: number): LevelView {
  const fallback = { ar: `المستوى ${n}`, en: `Level ${n}`, ckb: `ئاستی ${n}` };
  if (!row) return { n, name: fallback, description: { ar: '', en: '', ckb: '' }, active: false };
  const ar = text(row.name_ar) || fallback.ar;
  return {
    n,
    name: { ar, en: text(row.name_en) || fallback.en, ckb: text(row.name_ckb) || fallback.ckb },
    description: { ar: text(row.description_ar), en: text(row.description_en), ckb: text(row.description_ckb) },
    active: Number(row.active) === 1,
  };
}

/** The five canonical levels (`gift_pools.id = gift_level_<n>`), always five. */
export async function loadLevels(db: D1Database): Promise<Map<number, { view: LevelView; row: Record<string, unknown> | undefined }>> {
  const { results } = await db
    .prepare(`SELECT * FROM gift_pools WHERE id IN ('gift_level_1','gift_level_2','gift_level_3','gift_level_4','gift_level_5')`)
    .all<Record<string, unknown>>();
  const byId = new Map((results ?? []).map((r) => [text(r.id), r]));
  return new Map(LEVELS.map((n) => {
    const row = byId.get(levelPoolId(n));
    return [n, { view: levelViewFrom(row, n), row }] as const;
  }));
}

/** The live, product-backed items of some levels — the alternatives a customer may choose from. */
export async function activeLevelItems(db: D1Database, levels: readonly number[]): Promise<Record<string, unknown>[]> {
  const wanted = [...new Set(levels.filter((n) => Number.isInteger(n) && n >= 1 && n <= 5))];
  if (wanted.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT * FROM gift_pool_items
        WHERE level IN (SELECT value FROM json_each(?)) AND active = 1 AND product_id IS NOT NULL AND sale_type <> ''
        ORDER BY level, sort, created_at, id`
    )
    .bind(JSON.stringify(wanted))
    .all<Record<string, unknown>>();
  return results ?? [];
}

// ------------------------------------------------------------------ items

/** A level item row's frozen selection. */
export function itemSelection(item: Record<string, unknown>): GiftSelection | null {
  return selectionFromColumns(item);
}

const tri = (ar: string, en: string, ckb: string): Tri => ({ ar, en: en || ar, ckb: ckb || ar });

function itemViewFromSnapshot(
  itemId: string | null,
  sel: GiftSelection,
  snap: GiftSnapshot | null,
  fallbackName: Tri,
  available: boolean | null,
  reason: string | null
): GiftItemView {
  return {
    item_id: itemId,
    product_id: sel.productId,
    slug: snap?.slug ?? '',
    name: snap ? tri(snap.name_ar, snap.name_en, snap.name_ckb) : fallbackName,
    image: snap?.image ?? '',
    variant: snap ? tri(snap.variant_ar, snap.variant_en, snap.variant_ckb) : { ar: '', en: '', ckb: '' },
    color:
      snap && (snap.color_name_ar || snap.color_name_en || snap.color_hex)
        ? { ...tri(snap.color_name_ar, snap.color_name_en, snap.color_name_ckb), hex: snap.color_hex }
        : null,
    qty: sel.qty,
    sale_type: sel.saleType,
    transport_method: sel.transportMethod,
    value_iqd: snap?.value_iqd ?? 0,
    lead_time_text: snap?.lead_time_text ?? '',
    available,
    reason,
  };
}

/**
 * One level item as a choice. Its words and picture are TODAY's (the product
 * as the store shows it now); `available` is today's answer to «can this be
 * ordered for `qty` units».
 */
export function levelItemChoice(item: Record<string, unknown>, product: GiftProductContext | undefined): GiftItemView | null {
  const sel = itemSelection(item);
  if (!sel) return null;
  const fallback = tri(text(item.label_ar), text(item.label_en), text(item.label_ckb));
  if (!product) return itemViewFromSnapshot(text(item.id), sel, null, fallback, false, 'GIFT_PRODUCT_NOT_FOUND');
  const live = checkGiftSelection(product, selectionInput(sel), { requireSellable: true });
  if (live.ok) return itemViewFromSnapshot(text(item.id), sel, live.snapshot, fallback, true, null);
  // Not orderable today: describe it as configured (no stock requirement) when
  // the store can, so the card still names and pictures it.
  const described = checkGiftSelection(product, selectionInput(sel), { requireSellable: false });
  return itemViewFromSnapshot(text(item.id), sel, described.ok ? described.snapshot : null, fallback, false, live.code);
}

/** The gift's own frozen product (chosen or pinned), described from its snapshot. */
export function chosenItemView(g: Record<string, unknown>, live: GiftSelectionResult | null): GiftItemView | null {
  const sel = giftSelectionOf(g);
  if (!sel) return null;
  const snap = parseGiftSnapshot(g.gift_snapshot);
  return itemViewFromSnapshot(
    orNull(g.gift_item_id),
    sel,
    snap,
    { ar: '', en: '', ckb: '' },
    live ? live.ok : null,
    live && !live.ok ? live.code : null
  );
}

/** The states in which the customer still acts on the product, so today's availability matters. */
const LIVE_STATES = new Set(['ready_to_redeem', 'redeemed']);

// ------------------------------------------------------------------- views

export interface ViewContext {
  levels: Map<number, { view: LevelView; row: Record<string, unknown> | undefined }>;
  items: Record<string, unknown>[];
  products: Map<string, GiftProductContext>;
  legacyPool: Awaited<ReturnType<typeof legacyPoolItems>>;
  legacyProducts: Map<string, Record<string, unknown>>;
  legacyRedemptions: Map<string, Record<string, unknown>>;
}

/** Everything a set of gift rows needs to be shown, in a bounded number of reads. */
export async function viewContextFor(env: { DB: D1Database }, rows: Record<string, unknown>[]): Promise<ViewContext> {
  const db = env.DB;
  const choosing = rows.filter((g) => text(g.grant_mode) === 'level' && (g.state === 'granted' || g.state === 'ready_to_redeem'));
  const legacy = rows.filter((g) => text(g.grant_mode || 'legacy') === 'legacy');
  const [levels, items] = await Promise.all([
    loadLevels(db),
    activeLevelItems(db, choosing.map((g) => Number(g.level))),
  ]);
  const productIds = [
    ...items.map((i) => text(i.product_id)),
    ...rows.filter((g) => LIVE_STATES.has(text(g.state))).map((g) => text(g.gift_product_id)),
  ].filter(Boolean);
  const legacyIds = legacy.map((g) => text(g.id));
  const [products, legacyPool, legacyProductRows, legacyRedemptionRows] = await Promise.all([
    loadGiftProducts(env, productIds),
    legacy.some((g) => g.state === 'available') ? legacyPoolItems(db) : Promise.resolve([]),
    legacyIds.length
      ? db.prepare(LEGACY_PRODUCT_SELECT).bind(JSON.stringify(legacyIds)).all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] }),
    legacyIds.length
      ? db
          .prepare('SELECT * FROM gift_redemptions WHERE entitlement_id IN (SELECT value FROM json_each(?))')
          .bind(JSON.stringify(legacyIds))
          .all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] }),
  ]);
  return {
    levels,
    items,
    products,
    legacyPool,
    legacyProducts: new Map((legacyProductRows.results ?? []).map((r) => [text(r.id), r])),
    legacyRedemptions: new Map((legacyRedemptionRows.results ?? []).map((r) => [text(r.entitlement_id), r])),
  };
}

/** One customer card from a `GIFT_ROW_SELECT` row. Built from an explicit field list — never `...row`. */
export function giftViewFrom(g: Record<string, unknown>, ctx: ViewContext): GiftView {
  const status = giftStatusOf(g);
  const mode = (text(g.grant_mode) || 'legacy') as GiftMode;
  const n = Number(g.level);
  const level = Number.isInteger(n) && n >= 1 && n <= 5 ? ctx.levels.get(n)?.view ?? levelViewFrom(undefined, n) : null;
  const canChange = mode === 'level' && (g.state === 'granted' || g.state === 'ready_to_redeem');
  const choices = canChange
    ? ctx.items
        .filter((i) => Number(i.level) === n)
        .map((i) => levelItemChoice(i, ctx.products.get(text(i.product_id))))
        .filter((x): x is GiftItemView => !!x)
    : null;
  const sel = giftSelectionOf(g);
  const live =
    sel && LIVE_STATES.has(text(g.state)) && ctx.products.has(sel.productId)
      ? checkGiftSelection(ctx.products.get(sel.productId)!, selectionInput(sel), { requireSellable: true })
      : null;
  let legacyBlock: GiftView['legacy'] = null;
  if (mode === 'legacy') {
    const product = ctx.legacyProducts.get(text(g.id)) ?? {};
    const base = legacyEntitlementView({ ...g, ...product, id: g.id }, ctx.legacyRedemptions.get(text(g.id)) ?? null);
    const maxLevel = Number(g.max_level) || 0;
    legacyBlock = {
      ...base,
      levels:
        g.state === 'available'
          ? Array.from({ length: maxLevel }, (_, i) => levelAvailability(ctx.legacyPool, i + 1, text(product.product_id)))
          : [],
    };
  }
  return {
    id: text(g.id),
    status,
    mode,
    reason: (text(g.reason) || 'legacy') as GiftReason,
    level,
    choices,
    chosen: chosenItemView(g, live),
    can_change_choice: canChange,
    cart_item_id: status === 'ADDED_TO_ORDER' ? text(g.cart_item_id) : null,
    order: text(g.order_id)
      ? { id: text(g.order_id), status: text(g.order_status), stage: orNull(g.order_stage) }
      : null,
    granted_at: text(g.granted_at) || text(g.created_at),
    chosen_at: orNull(g.chosen_at),
    redeemed_at: orNull(g.redeemed_at),
    ordered_at: orNull(g.ordered_at),
    fulfilled_at: orNull(g.fulfilled_at),
    cancelled_at: orNull(g.cancelled_at),
    legacy: legacyBlock,
  };
}

/** GET /api/gifts — the customer's gifts, newest first. */
export async function loadCustomerGifts(env: { DB: D1Database }, userId: string): Promise<GiftView[]> {
  const { results } = await env.DB.prepare(`${GIFT_ROW_SELECT} WHERE g.user_id = ? ORDER BY g.created_at DESC, g.id DESC LIMIT 100`)
    .bind(userId)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const ctx = await viewContextFor(env, rows);
  return rows.map((g) => giftViewFrom(g, ctx));
}

/** One of the customer's gifts, or null (a foreign id and an unknown one answer alike). */
export async function loadCustomerGift(env: { DB: D1Database }, userId: string, id: string): Promise<GiftView | null> {
  const row = await loadGiftRow(env.DB, id, userId);
  if (!row) return null;
  return giftViewFrom(row, await viewContextFor(env, [row]));
}

export async function loadGiftRow(db: D1Database, id: string, userId?: string): Promise<Record<string, unknown> | null> {
  const row = userId
    ? await db.prepare(`${GIFT_ROW_SELECT} WHERE g.id = ? AND g.user_id = ?`).bind(id, userId).first<Record<string, unknown>>()
    : await db.prepare(`${GIFT_ROW_SELECT} WHERE g.id = ?`).bind(id).first<Record<string, unknown>>();
  return row ?? null;
}

// ------------------------------------------------------------- statements

export { changedExactlyOne, isLostRace } from './fence';

/** JSON canonical form of a snapshot, for the `gift_snapshot` column. */
export const snapshotJson = (s: GiftSnapshot | null): string => (s ? JSON.stringify(s) : '{}');

/** A short, stable request digest for the admin grant's idempotency check. */
export async function requestHash(body: unknown): Promise<string> {
  const canonical = JSON.stringify(body, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const parseJsonList = (raw: unknown): string[] => {
  const list = safeParse<unknown[]>(text(raw) || '[]', []);
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
};
