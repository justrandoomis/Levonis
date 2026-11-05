/**
 * THE REWARD COUPONS — minted per printer on delivery, or bought with points
 * (owner, 2026-11-03; migration 0220; docs/DECISIONS.md row 286).
 *
 * A REWARD COUPON IS AN ORDINARY PERSONAL COUPON. It is a `coupons` row like a
 * trade-in credit (worker/lib/tradeIn.ts `couponStatement`): personal
 * (`assigned_user_id`, enforced by `validateCoupon` and by the redemption
 * trigger), single use (`max_global = max_per_user = 1`), dated
 * (`starts_at` / `ends_at`). So the checkout needs nothing new: the customer's
 * code goes through `validateCoupon` and the one resolver
 * (packages/pricing/src/coupons.ts) like any other, a cancel gives the use back
 * (0191 `trg_orders_coupon_released`), and the order's coupon snapshot says
 * what it was. ONE CODE PER ORDER stays the rule (DECISIONS row 223 #5;
 * `coupon_redemptions.order_id` is UNIQUE), so the two coupons of a printer
 * are spent on two orders.
 *
 *   free_shipping      scope 'global', applies_to 'delivery', 100% — the
 *                      order's delivery fee, nothing off the goods. It still
 *                      names the order's paid lines, so a gift-only order (a
 *                      0 IQD line) cannot carry it, and a delivery that came
 *                      out free does not consume it (row 227 (5)).
 *   filament_discount  the owner's percentage and ceiling off the goods of
 *                      the selected filaments only: scope 'products' over the
 *                      ticked list, or 'category' over the FDM filament
 *                      section while nothing is ticked. NOT on a line already
 *                      discounted (`stacks = 0`): one discount per line
 *                      (row 223 #5).
 *
 * WHAT IS PER PRINTER. The canonical identity (worker/lib/printerIdentity.ts:
 * a product placed in a catalog flagged `is_printer_catalog`), qty-aware, on
 * the order's BOUGHT lines: a gift line earns nothing (S8), a bundle parent is
 * not a device — its printer component line is — and a mystery spool has no
 * product. `source_ref = printer:<order_item_id>:<unit>:<kind>` is UNIQUE, so
 * a walk-back and re-delivery, a retried hook and the catch-up sweep can all
 * run and the customer still holds exactly one pair per printer.
 *
 * WHAT IS NEVER DONE HERE: no coupon is ever taken back from an order that
 * spent it. A cancelled order withdraws its printer's coupons by trigger
 * (0220), a returned printer withdraws coupons not yet used
 * (`revokeRewardsForReturn`), and the coupon's own `ends_at` does the rest.
 */
import type { Env } from '../types';
import { safeParse } from '../types';
import { newId } from '../crypto';
import { isSchemaMissing } from '../membershipBenefits';
import { notifyStatement } from '../notifications';
import {
  FILAMENT_SECTION_ID,
  getRewardConfig,
  type RewardCouponKind,
  type RewardProgramConfig,
} from './config';
import { rewardNotice, type Trilingual } from './strings';

export const DAY_MS = 86_400_000;

export type RewardSource = 'printer' | 'points_shop' | 'admin';
export type RewardGrantState = 'active' | 'used' | 'expired' | 'revoked';

/** One code a person can read aloud: no 0/O, no 1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `RWS…` free shipping, `RWF…` filament — ten characters after the prefix. */
export function rewardCouponCode(kind: RewardCouponKind): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const tail = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${kind === 'free_shipping' ? 'RWS' : 'RWF'}${tail}`;
}

/** The coupon terms a grant freezes, from the programme's current settings. */
export interface RewardCouponTerms {
  kind: RewardCouponKind;
  percent: number;
  max_discount_iqd: number | null;
  scope: 'global' | 'products' | 'category';
  product_ids: string[];
  category_id: string | null;
  applies_to: 'delivery' | 'merchandise';
  stacks: boolean;
  valid_days: number;
}

export function termsFor(kind: RewardCouponKind, config: RewardProgramConfig): RewardCouponTerms {
  if (kind === 'free_shipping') {
    return {
      kind,
      percent: 100,
      max_discount_iqd: null,
      scope: 'global',
      product_ids: [],
      category_id: null,
      applies_to: 'delivery',
      stacks: true,
      valid_days: config.valid_days,
    };
  }
  const picked = config.filament.product_ids;
  return {
    kind,
    percent: config.filament.percent,
    max_discount_iqd: config.filament.max_discount_iqd,
    scope: picked.length ? 'products' : 'category',
    product_ids: [...picked],
    category_id: picked.length ? null : FILAMENT_SECTION_ID,
    applies_to: 'merchandise',
    stacks: false,
    valid_days: config.valid_days,
  };
}

export interface MintInput {
  grantId: string;
  couponId: string;
  code: string;
  userId: string;
  source: RewardSource;
  sourceRef: string;
  orderId: string | null;
  orderItemId: string | null;
  unitIndex: number | null;
  terms: RewardCouponTerms;
  issuedAt: string;
  expiresAt: string;
  pointsSpent?: number;
  pointsTxId?: string | null;
  createdBy?: string;
}

const couponInsertColumns = `(id, code, tier_required, kind, value, min_total_iqd, starts_at, ends_at, max_global, max_per_user, active, created_at,
   assigned_user_id, scope, category_id, product_ids, fulfillment_types, transport_methods, delivery_methods,
   applies_to, cap_scope, max_discount_iqd, max_quantity, stacks, reward_grant_id)`;

const couponBinds = (m: MintInput) => [
  m.couponId,
  m.code,
  m.terms.percent,
  m.issuedAt,
  m.expiresAt,
  m.userId,
  m.terms.scope,
  m.terms.category_id,
  JSON.stringify(m.terms.product_ids),
  m.terms.applies_to,
  m.terms.max_discount_iqd,
  m.terms.stacks ? 1 : 0,
  m.grantId,
];

const couponValues = `(?1, ?2, NULL, 'percent', ?3, 0, ?4, ?5, 1, 1, 1, ?4, ?6, ?7, ?8, ?9, '[]', '[]', '[]', ?10, 'per_order', ?11, NULL, ?12, ?13)`;

/** The coupon and its grant, as two statements for the caller's batch. */
export function mintStatements(db: D1Database, m: MintInput): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO coupons ${couponInsertColumns} VALUES ${couponValues}`).bind(...couponBinds(m)),
    grantInsert(db, m, ''),
  ];
}

function grantInsert(db: D1Database, m: MintInput, guard: string): D1PreparedStatement {
  const sql = `INSERT INTO reward_grants
       (id, user_id, kind, source, source_ref, order_id, order_item_id, unit_index, coupon_id,
        points_spent, points_tx_id, terms, issued_at, expires_at, created_by)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15${guard}`;
  return db
    .prepare(sql)
    .bind(
      m.grantId,
      m.userId,
      m.terms.kind,
      m.source,
      m.sourceRef,
      m.orderId,
      m.orderItemId,
      m.unitIndex,
      m.couponId,
      Math.max(0, Math.trunc(m.pointsSpent ?? 0)),
      m.pointsTxId ?? null,
      JSON.stringify(m.terms),
      m.issuedAt,
      m.expiresAt,
      m.createdBy ?? 'system'
    );
}

const isUnique = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE|PRIMARY KEY/i.test(msg);
};

// ------------------------------------------------------------ printer units

export interface PrinterUnit {
  order_item_id: string;
  product_id: string;
  unit_index: number;
}

/**
 * Every printer UNIT a delivered order bought, one per physical printer.
 * The predicate is the one docs and the device projection use: a product line,
 * not a gift, not a bundle parent (its printer component line counts), placed
 * in a printer catalog.
 */
export async function printerUnitsOfOrder(db: D1Database, orderId: string): Promise<PrinterUnit[]> {
  const { results } = await db
    .prepare(
      `SELECT oi.id AS order_item_id, oi.product_id, oi.qty
         FROM order_items oi
        WHERE oi.order_id = ?1
          AND oi.product_id IS NOT NULL
          AND oi.gift_entitlement_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM order_items k WHERE k.bundle_parent_item_id = oi.id)
          AND EXISTS (SELECT 1 FROM product_catalogs pc JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                       WHERE pc.product_id = oi.product_id)
        ORDER BY oi.rowid`
    )
    .bind(orderId)
    .all<{ order_item_id: string; product_id: string; qty: number }>();
  const units: PrinterUnit[] = [];
  for (const r of results ?? []) {
    const qty = Math.max(0, Math.min(100, Math.trunc(Number(r.qty) || 0)));
    for (let i = 1; i <= qty; i++) units.push({ order_item_id: String(r.order_item_id), product_id: String(r.product_id), unit_index: i });
  }
  return units;
}

export const printerSourceRef = (u: Pick<PrinterUnit, 'order_item_id' | 'unit_index'>, kind: RewardCouponKind) =>
  `printer:${u.order_item_id}:${u.unit_index}:${kind}`;

// ------------------------------------------------------------- issuing

export interface IssueResult {
  issued: number;
  /** Why nothing (more) was issued, when nothing was. */
  reason?:
    | 'disabled'
    | 'not_delivered'
    | 'merchant_order'
    | 'no_printer'
    | 'already_issued'
    | 'order_not_found'
    | 'schema_missing';
  expires_at?: string;
}

/**
 * Issues the missing reward coupons of one delivered order. Idempotent and
 * safe to call from every door and from the sweep: what exists is skipped,
 * and a racing caller that inserts the same `source_ref` first makes this
 * batch abort whole (UNIQUE) — nothing is half issued.
 *
 * The customer is told once per order (one in-app notification, its event key
 * the order's), in their three languages.
 */
export async function issuePrinterRewards(env: Env, orderId: string, nowIso = new Date().toISOString()): Promise<IssueResult> {
  try {
    return await issue(env, orderId, nowIso);
  } catch (e) {
    if (isSchemaMissing(e)) return { issued: 0, reason: 'schema_missing' };
    throw e;
  }
}

async function issue(env: Env, orderId: string, nowIso: string): Promise<IssueResult> {
  const db = env.DB;
  const config = await getRewardConfig(db);
  const kinds: RewardCouponKind[] = [];
  if (config.free_shipping.enabled) kinds.push('free_shipping');
  if (config.filament.enabled) kinds.push('filament_discount');
  if (!config.enabled || kinds.length === 0) return { issued: 0, reason: 'disabled' };

  const order = await db
    .prepare('SELECT id, user_id, status, seller_type FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; user_id: string; status: string; seller_type: string | null }>();
  if (!order) return { issued: 0, reason: 'order_not_found' };
  if (String(order.seller_type ?? '') === 'merchant') return { issued: 0, reason: 'merchant_order' };
  if (order.status !== 'delivered') return { issued: 0, reason: 'not_delivered' };

  const units = await printerUnitsOfOrder(db, orderId);
  if (units.length === 0) return { issued: 0, reason: 'no_printer' };

  const { results: existing } = await db
    .prepare("SELECT source_ref FROM reward_grants WHERE order_id = ? AND source = 'printer'")
    .bind(orderId)
    .all<{ source_ref: string }>();
  const have = new Set((existing ?? []).map((r) => r.source_ref));

  const expiresAt = new Date(Date.parse(nowIso) + config.valid_days * DAY_MS).toISOString();
  const statements: D1PreparedStatement[] = [];
  let issued = 0;
  for (const unit of units) {
    for (const kind of kinds) {
      const sourceRef = printerSourceRef(unit, kind);
      if (have.has(sourceRef)) continue;
      statements.push(
        ...mintStatements(db, {
          grantId: newId('rwg'),
          couponId: newId('cpn'),
          code: rewardCouponCode(kind),
          userId: order.user_id,
          source: 'printer',
          sourceRef,
          orderId,
          orderItemId: unit.order_item_id,
          unitIndex: unit.unit_index,
          terms: termsFor(kind, config),
          issuedAt: nowIso,
          expiresAt,
        })
      );
      issued += 1;
    }
  }
  if (issued === 0) return { issued: 0, reason: 'already_issued' };

  const text = rewardNotice('printer_coupons', { count: units.length, until: expiresAt.slice(0, 10), percent: config.filament.percent, kinds });
  statements.push(
    notifyStatement(db, {
      userId: order.user_id,
      kind: 'reward',
      title_ar: text.title.ar,
      title_en: text.title.en,
      body_ar: text.body.ar,
      body_en: text.body.en,
      link: '/rewards/coupons',
      entity_type: 'order',
      entity_id: orderId,
      meta: { title_ckb: text.title.ckb, body_ckb: text.body.ckb, order_id: orderId, expires_at: expiresAt },
      eventKey: `reward:printer:${orderId}`,
    }).stmt
  );

  try {
    await db.batch(statements);
  } catch (e) {
    // A racing caller issued first: its batch holds every coupon this one would
    // have minted. Nothing of this batch was written.
    if (isUnique(e)) return { issued: 0, reason: 'already_issued' };
    throw e;
  }
  return { issued, expires_at: expiresAt };
}

// ------------------------------------------------------------- returns

/**
 * A RETURNED PRINTER TAKES BACK COUPONS NOT YET USED. Called after a return
 * case is resolved with a refund (worker/routes/returns.ts): for each kind, up
 * to `qty` of that line's printer coupons that are neither spent nor already
 * withdrawn go off, highest unit first. A coupon the customer already spent is
 * never clawed back. Idempotent per case: its reason names the case, and a
 * case that already withdrew something withdraws nothing again.
 */
export async function revokeRewardsForReturn(
  env: Env,
  input: { caseId: string; orderItemId: string; qty: number },
  nowIso = new Date().toISOString()
): Promise<{ revoked: number }> {
  const db = env.DB;
  const reason = `return:${String(input.caseId).slice(0, 80)}`;
  try {
    const done = await db.prepare('SELECT 1 AS x FROM reward_grants WHERE revoke_reason = ? LIMIT 1').bind(reason).first();
    if (done) return { revoked: 0 };
    const qty = Math.max(0, Math.min(100, Math.trunc(Number(input.qty) || 0)));
    if (qty === 0) return { revoked: 0 };
    const { results } = await db
      .prepare(
        `SELECT g.id, g.coupon_id, g.kind FROM reward_grants g
          WHERE g.order_item_id = ?1 AND g.source = 'printer' AND g.revoked_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = g.coupon_id AND r.state = 'active')
          ORDER BY g.unit_index DESC, g.kind`
      )
      .bind(input.orderItemId)
      .all<{ id: string; coupon_id: string; kind: RewardCouponKind }>();
    const taken: Record<string, number> = {};
    const picks = (results ?? []).filter((g) => {
      taken[g.kind] = (taken[g.kind] ?? 0) + 1;
      return taken[g.kind] <= qty;
    });
    if (picks.length === 0) return { revoked: 0 };
    const statements: D1PreparedStatement[] = [];
    for (const g of picks) {
      statements.push(
        db.prepare('UPDATE coupons SET active = 0 WHERE id = ? AND reward_grant_id = ?').bind(g.coupon_id, g.id),
        db
          .prepare('UPDATE reward_grants SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL')
          .bind(nowIso, reason, g.id)
      );
    }
    await db.batch(statements);
    return { revoked: picks.length };
  } catch (e) {
    if (isSchemaMissing(e)) return { revoked: 0 };
    throw e;
  }
}

// ------------------------------------------------------------- reading

/** The state as the checkout would see it, from the coupon row itself. */
export const GRANT_STATE_SQL = (now: string) => `CASE
    WHEN EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = g.coupon_id AND r.state = 'active') THEN 'used'
    WHEN g.revoked_at IS NOT NULL OR COALESCE(c.active, 0) = 0 THEN 'revoked'
    WHEN c.ends_at IS NOT NULL AND c.ends_at <= ${now} THEN 'expired'
    ELSE 'active'
  END`;

export interface RewardCouponView {
  id: string;
  kind: RewardCouponKind;
  source: RewardSource;
  state: RewardGrantState;
  code: string;
  percent: number;
  max_discount_iqd: number | null;
  scope: string;
  category_id: string | null;
  product_ids: string[];
  issued_at: string;
  expires_at: string;
  order_id: string | null;
  points_spent: number;
  /** The order that spent it, when it is spent. */
  used_on_order_id: string | null;
  revoke_reason: string;
}

interface GrantRow {
  id: string;
  kind: RewardCouponKind;
  source: RewardSource;
  state: RewardGrantState;
  code: string | null;
  value: number | null;
  max_discount_iqd: number | null;
  scope: string | null;
  category_id: string | null;
  product_ids: string | null;
  issued_at: string;
  ends_at: string | null;
  expires_at: string;
  order_id: string | null;
  points_spent: number;
  used_on_order_id: string | null;
  revoke_reason: string;
}

/** A grant with its coupon and its derived state; `extra` adds columns and joins (the admin list's customer). */
export const grantSelect = (now: string, extra: { columns?: string; joins?: string } = {}) => `SELECT g.id, g.user_id, g.kind, g.source, g.issued_at, g.expires_at, g.order_id, g.points_spent, g.revoke_reason,
         c.code, c.value, c.max_discount_iqd, c.scope, c.category_id, c.product_ids, c.ends_at,
         (SELECT r.order_id FROM coupon_redemptions r WHERE r.coupon_id = g.coupon_id AND r.state = 'active' LIMIT 1) AS used_on_order_id,
         ${GRANT_STATE_SQL(now)} AS state${extra.columns ? `, ${extra.columns}` : ''}
    FROM reward_grants g LEFT JOIN coupons c ON c.id = g.coupon_id${extra.joins ? ` ${extra.joins}` : ''}`;

export const GRANT_SELECT = (now: string) => grantSelect(now);

const stringList = (raw: string | null): string[] => {
  const parsed = safeParse<unknown>(raw ?? '[]', []);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
};

export function grantView(r: GrantRow): RewardCouponView {
  return {
    id: r.id,
    kind: r.kind,
    source: r.source,
    state: r.state,
    code: String(r.code ?? ''),
    percent: Math.max(0, Math.trunc(Number(r.value) || 0)),
    max_discount_iqd: r.max_discount_iqd === null || r.max_discount_iqd === undefined ? null : Number(r.max_discount_iqd),
    scope: String(r.scope ?? ''),
    category_id: r.category_id ?? null,
    product_ids: stringList(r.product_ids),
    issued_at: r.issued_at,
    expires_at: r.ends_at ?? r.expires_at,
    order_id: r.order_id ?? null,
    points_spent: Math.max(0, Number(r.points_spent) || 0),
    used_on_order_id: r.used_on_order_id ?? null,
    revoke_reason: String(r.revoke_reason ?? ''),
  };
}

/** A customer's reward coupons, live first, then the most recent. */
export async function listUserRewardCoupons(db: D1Database, userId: string, nowIso = new Date().toISOString(), limit = 40): Promise<RewardCouponView[]> {
  const n = Math.max(1, Math.min(100, Math.trunc(limit)));
  const { results } = await db
    .prepare(
      `SELECT * FROM (${GRANT_SELECT('?2')} WHERE g.user_id = ?1)
        ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, CASE state WHEN 'active' THEN expires_at END ASC, issued_at DESC
        LIMIT ?3`
    )
    .bind(userId, nowIso, n)
    .all<GrantRow>();
  return (results ?? []).map(grantView);
}

/**
 * How many reward coupons this customer has, live and past, by the same state
 * the list derives (GRANT_STATE_SQL) — so the page can say «the latest 40 of
 * 52» when the list stops short.
 */
export async function couponCounts(db: D1Database, userId: string, nowIso = new Date().toISOString()): Promise<{ active: number; past: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0) AS active,
              COALESCE(SUM(CASE WHEN state = 'active' THEN 0 ELSE 1 END), 0) AS past
         FROM (SELECT ${GRANT_STATE_SQL('?2')} AS state
                 FROM reward_grants g LEFT JOIN coupons c ON c.id = g.coupon_id
                WHERE g.user_id = ?1)`
    )
    .bind(userId, nowIso)
    .first<{ active: number; past: number }>();
  return { active: Math.max(0, Number(row?.active) || 0), past: Math.max(0, Number(row?.past) || 0) };
}

// ------------------------------------------------------------- what a coupon is for

export interface CatalogSection {
  id: string;
  slug: string;
  /** The storefront's own address for the section. */
  path: string;
  name: Trilingual;
}

/** One storefront section, with its address: /categories/<parent>/<child>, or /categories/<top>. Null when it is gone. */
export async function catalogSection(db: D1Database, id: string): Promise<CatalogSection | null> {
  const s = await db
    .prepare(
      `SELECT c.id, c.slug, c.name_ar, c.name_en, c.name_ckb, p.slug AS parent_slug
         FROM catalogs c LEFT JOIN catalogs p ON p.id = c.parent_id WHERE c.id = ?`
    )
    .bind(id)
    .first<{ id: string; slug: string; name_ar: string; name_en: string; name_ckb: string; parent_slug: string | null }>();
  return s
    ? {
        id: s.id,
        slug: s.slug,
        path: s.parent_slug ? `/categories/${encodeURIComponent(s.parent_slug)}/${encodeURIComponent(s.slug)}` : `/categories/${encodeURIComponent(s.slug)}`,
        name: { ar: s.name_ar, en: s.name_en || s.name_ar, ckb: s.name_ckb || s.name_en || s.name_ar },
      }
    : null;
}

export interface CouponTargetProduct {
  id: string;
  slug: string;
  name: Trilingual;
  /** The first of the product's images, or ''. */
  image: string;
}

export interface CouponTargets {
  /** The first MAX_TARGET_NAMES of the coupon's own products still on sale, in its own order. */
  products: CouponTargetProduct[];
  /** All of the coupon's own products still on sale. */
  products_total: number;
  /** A section-wide coupon's section. */
  section: CatalogSection | null;
}

export const MAX_TARGET_NAMES = 20;

/**
 * WHAT EACH LIVE FILAMENT COUPON CAN BE SPENT ON, from the coupon's OWN frozen
 * terms (DECISIONS row 290) — never from today's settings: a coupon issued
 * while the owner had ticked A still covers A after A is unticked and B is
 * ticked, because that is what its row says and what the checkout honours.
 *
 *   scope 'products'  its own product list, the products still on sale only,
 *                     the first MAX_TARGET_NAMES named and all of them counted;
 *   scope 'category'  its section, with the storefront's address for it.
 *
 * Only an ACTIVE filament coupon has targets; the caller answers null for the
 * rest. ONE products read over the union of every such coupon's own ids, and
 * one section read per distinct section.
 */
export async function couponTargets(db: D1Database, coupons: readonly RewardCouponView[]): Promise<Map<string, CouponTargets>> {
  const out = new Map<string, CouponTargets>();
  const live = coupons.filter((c) => c.kind === 'filament_discount' && c.state === 'active');
  if (!live.length) return out;

  const ids = [...new Set(live.flatMap((c) => (c.scope === 'products' ? c.product_ids : [])))];
  const sectionIds = [...new Set(live.flatMap((c) => (c.scope === 'category' && c.category_id ? [c.category_id] : [])))];
  const [rows, sectionList] = await Promise.all([
    ids.length
      ? db
          .prepare('SELECT id, slug, name, name_ar, name_ku, images, status FROM products WHERE id IN (SELECT value FROM json_each(?1))')
          .bind(JSON.stringify(ids))
          .all<{ id: string; slug: string | null; name: string | null; name_ar: string | null; name_ku: string | null; images: string | null; status: string | null }>()
          .then((r) => r.results ?? [])
      : Promise.resolve([]),
    Promise.all(sectionIds.map(async (id) => [id, await catalogSection(db, id)] as const)),
  ]);
  const sections = new Map(sectionList);
  const products = new Map<string, CouponTargetProduct & { status: string }>();
  for (const p of rows) {
    const images = safeParse<unknown>(p.images ?? '[]', []);
    const name = String(p.name ?? '');
    products.set(String(p.id), {
      id: String(p.id),
      slug: String(p.slug ?? ''),
      name: { ar: p.name_ar || name, en: name, ckb: p.name_ku || name },
      image: Array.isArray(images) && typeof images[0] === 'string' ? images[0] : '',
      status: String(p.status ?? ''),
    });
  }

  for (const c of live) {
    if (c.scope === 'category' && c.category_id) {
      out.set(c.id, { products: [], products_total: 0, section: sections.get(c.category_id) ?? null });
      continue;
    }
    const own = c.scope === 'products' ? [...new Set(c.product_ids)] : [];
    const onSale = own.flatMap((id) => {
      const p = products.get(id);
      return p && p.status === 'active' ? [{ id: p.id, slug: p.slug, name: p.name, image: p.image }] : [];
    });
    out.set(c.id, { products: onSale.slice(0, MAX_TARGET_NAMES), products_total: onSale.length, section: null });
  }
  return out;
}

// ------------------------------------------------------------- points shop

export class RewardShopError extends Error {
  constructor(public readonly code: 'REWARD_SHOP_UNAVAILABLE' | 'REWARD_SHOP_HOLDING' | 'INSUFFICIENT_POINTS', message: string) {
    super(message);
    this.name = 'RewardShopError';
  }
}

/**
 * HOLDING (policy 14.9): a coupon bought from the points shop that is still
 * live and unused — not withdrawn, switched on, inside its dates, not spent on
 * an order. ONE predicate for the shop's own guard (a second purchase of the
 * kind is refused while one is held) and for the shop's display of it
 * (`shopHoldings`), so the page can never say «you may» where the swap says
 * «you may not». `h` is the reward_grants row, `hc` its coupon; `?N` is now,
 * which each caller renumbers.
 */
export const HOLDING_WHERE = `h.source = 'points_shop' AND h.revoked_at IS NULL
     AND hc.active = 1 AND hc.ends_at > ?N
     AND NOT EXISTS (SELECT 1 FROM coupon_redemptions hr WHERE hr.coupon_id = h.coupon_id AND hr.state = 'active')`;

/** The live shop coupon of this kind the customer still holds, if any. */
const HOLDING_SQL = `SELECT 1 FROM reward_grants h JOIN coupons hc ON hc.id = h.coupon_id
   WHERE h.user_id = ?U AND h.kind = ?K AND ${HOLDING_WHERE}`;

/** The kinds of shop coupon this customer holds right now (see HOLDING_WHERE). */
export async function shopHoldings(db: D1Database, userId: string, nowIso = new Date().toISOString()): Promise<Set<RewardCouponKind>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT h.kind FROM reward_grants h JOIN coupons hc ON hc.id = h.coupon_id
        WHERE h.user_id = ?1 AND ${HOLDING_WHERE.replace('?N', '?2')}`
    )
    .bind(userId, nowIso)
    .all<{ kind: RewardCouponKind }>();
  return new Set((results ?? []).map((r) => r.kind));
}

/**
 * Swaps points for a reward coupon, in ONE batch:
 *   1. the coupon, only while the customer holds no unused coupon of this kind
 *      bought from the shop (so a double press buys one, and points are not
 *      turned into a stack of coupons nobody can spend in a week);
 *   2. its grant, only if that coupon was written;
 *   3. the POINT withdrawal, only if that grant was written, and with an
 *      amount that turns negative — violating `amount > 0` and aborting the
 *      whole batch — when the spendable balance no longer covers the price.
 *      The checkout's own spending pattern; a refusal moves nothing.
 */
export async function buyShopCoupon(env: Env, userId: string, kind: RewardCouponKind, nowIso = new Date().toISOString()): Promise<RewardCouponView> {
  const db = env.DB;
  const config = await getRewardConfig(db);
  const item = config.shop[kind];
  if (!item.enabled || item.points === null) {
    throw new RewardShopError('REWARD_SHOP_UNAVAILABLE', 'This reward is not on sale right now');
  }
  const price = item.points;
  const grantId = newId('rwg');
  const couponId = newId('cpn');
  const txId = `wtx_rwshop_${grantId}`;
  const expiresAt = new Date(Date.parse(nowIso) + config.valid_days * DAY_MS).toISOString();
  const m: MintInput = {
    grantId,
    couponId,
    code: rewardCouponCode(kind),
    userId,
    source: 'points_shop',
    sourceRef: `shop:${grantId}`,
    orderId: null,
    orderItemId: null,
    unitIndex: null,
    terms: termsFor(kind, config),
    issuedAt: nowIso,
    expiresAt,
    pointsSpent: price,
    pointsTxId: txId,
    createdBy: 'user',
  };
  const holding = HOLDING_SQL.replace('?U', '?14').replace('?K', '?15').replace('?N', '?4');
  const statements = [
    db
      .prepare(`INSERT INTO coupons ${couponInsertColumns} SELECT ${couponValues.slice(1, -1)} WHERE NOT EXISTS (${holding})`)
      .bind(...couponBinds(m), userId, kind),
    grantInsert(db, m, ' WHERE EXISTS (SELECT 1 FROM coupons WHERE id = ?9)'),
    db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'POINT',
                CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0)
                             FROM wallet_transactions WHERE user_id = ?2 AND currency = 'POINT' AND status = 'approved') >= ?3
                     THEN ?3 ELSE -1 END,
                'approved', ?4, ?5, 'system', ?6
          WHERE EXISTS (SELECT 1 FROM reward_grants WHERE id = ?7)`
      )
      .bind(txId, userId, price, `Points shop: ${kind === 'free_shipping' ? 'free delivery coupon' : 'filament coupon'}`, `reward_shop:${grantId}`, nowIso, grantId),
  ];
  try {
    await db.batch(statements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/CHECK/i.test(msg)) throw new RewardShopError('INSUFFICIENT_POINTS', 'You do not have enough points for this reward');
    throw e;
  }
  const row = await db
    .prepare(`${GRANT_SELECT('?2')} WHERE g.id = ?1`)
    .bind(grantId, nowIso)
    .first<GrantRow>();
  if (!row) throw new RewardShopError('REWARD_SHOP_HOLDING', 'You already hold this coupon — use it before buying another');
  return grantView(row);
}
