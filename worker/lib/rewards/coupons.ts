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
 * what it was.
 *
 * SEVERAL ON ONE ORDER (owner, 2026-11-05; 0225; DECISIONS row 295, which
 * replaces row 223 #5 for reward coupons only): one code in the box spends every
 * reward coupon of this customer the order can use, «2 coupon mean shipping
 * discount 10000 and 2 pic of filament». worker/lib/rewards/pool.ts reads the
 * pool and `allocateCouponPool` does the sums. A promo code stays one per order.
 *
 *   free_shipping      scope 'global', applies_to 'delivery', a fixed amount off
 *                      the delivery fee (5,000 IQD), on an order whose goods,
 *                      after every discount, reach the minimum (100,000 IQD).
 *                      Nothing off the goods. It still names the order's paid
 *                      lines, so a gift-only order (a 0 IQD line) cannot carry
 *                      it, and a delivery that came out free does not consume
 *                      it (row 227 (5)).
 *   filament_discount  the owner's percentage and ceiling off ONE PIECE of the
 *                      selected filaments (`max_quantity`): scope 'products'
 *                      over the ticked list, or 'category' over the FDM filament
 *                      section while nothing is ticked. On a line already on sale
 *                      too, off the sale price, while `filament.on_sale` is on
 *                      (`stacks`; owner, 2026-11-06).
 *
 * A coupon keeps the terms it was minted with. Its row says what it does, so a
 * coupon of last week spends on last week's terms whatever the settings say now.
 *
 * WHAT IS PER PRINTER. The canonical identity (worker/lib/printerIdentity.ts:
 * a product placed in a catalog flagged `is_printer_catalog`), qty-aware, on
 * the order's BOUGHT lines: a gift line earns nothing (S8), a bundle parent is
 * not a device — its printer component line is — and a mystery spool has no
 * product. `source_ref = printer:<order_item_id>:<unit>:<kind>` is UNIQUE, so
 * a walk-back and re-delivery, a retried hook and the catch-up sweep can all
 * run and the customer still holds exactly one pair per printer, per week: every
 * week after the first adds `:w<week>` to the key (`issueWeeklyRewards`).
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
  getRewardConfigStrict,
  type RewardCouponKind,
  type RewardProgramConfig,
} from './config';
import { MAX_REPLACEMENT_HOPS, tradedInSql } from '../deviceCustody';
import { inShopSql } from '../services/myDevices';
import { SPENT_ON_SQL, SPENT_SQL } from './pool';
import { rewardNotice, rewardText, type Trilingual } from './strings';

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
  /** How `value` reads: a percentage of the goods, or dinars off the delivery. */
  coupon_kind: 'percent' | 'fixed_iqd';
  value: number;
  /** The goods, after every discount, the order needs. 0 is none. */
  min_total_iqd: number;
  max_discount_iqd: number | null;
  /** How many pieces it discounts. Null is every piece it names. */
  max_quantity: number | null;
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
      coupon_kind: 'fixed_iqd',
      value: config.free_shipping.amount_iqd,
      min_total_iqd: config.free_shipping.min_order_iqd,
      max_discount_iqd: null,
      max_quantity: null,
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
    coupon_kind: 'percent',
    value: config.filament.percent,
    min_total_iqd: 0,
    max_discount_iqd: config.filament.max_discount_iqd,
    max_quantity: config.filament.max_pieces,
    scope: picked.length ? 'products' : 'category',
    product_ids: [...picked],
    category_id: picked.length ? null : FILAMENT_SECTION_ID,
    applies_to: 'merchandise',
    stacks: config.filament.on_sale,
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
  m.terms.value,
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
  m.terms.coupon_kind,
  m.terms.min_total_iqd,
  m.terms.max_quantity,
];

const couponValues = `(?1, ?2, NULL, ?14, ?3, ?15, ?4, ?5, 1, 1, 1, ?4, ?6, ?7, ?8, ?9, '[]', '[]', '[]', ?10, 'per_order', ?11, ?16, ?12, ?13)`;

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

/**
 * The key one week's coupon of one printer is issued under. Week 0 keeps the
 * shape it had before the coupons were weekly, so a pair issued on delivery
 * before 0225 IS that printer's first week and is never issued twice.
 */
export const printerSourceRef = (u: Pick<PrinterUnit, 'order_item_id' | 'unit_index'>, kind: RewardCouponKind, week = 0) =>
  `printer:${u.order_item_id}:${u.unit_index}:${kind}${week > 0 ? `:w${week}` : ''}`;

/** A week's key in SQL, the same as `printerSourceRef` writes it, over a row's order_item_id, unit_index and week. */
const printerSourceRefSql = (kind: RewardCouponKind, row: string) =>
  `'printer:' || ${row}.order_item_id || ':' || ${row}.unit_index || ':${kind}' || CASE WHEN ${row}.week > 0 THEN ':w' || ${row}.week ELSE '' END`;

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
  const config = await getRewardConfigStrict(db);
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

  const text = rewardNotice('printer_coupons', {
    count: units.length,
    until: expiresAt.slice(0, 10),
    percent: config.filament.percent,
    amount: config.free_shipping.amount_iqd,
    min: config.free_shipping.min_order_iqd,
    pieces: config.filament.max_pieces,
    kinds,
  });
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

// ------------------------------------------------------------- every week

export interface WeeklyIssueReport {
  scanned: number;
  issued: number;
  errors: number;
}

/** Printers served per quarter-hour tick: four statements each, and a notice per customer. */
export const WEEKLY_UNIT_LIMIT = 20;

/**
 * THE END OF A SLOT'S WARRANTY-REPLACEMENT CHAIN, joined to `d`, the unit the
 * customer bought. A replacement sits on the same line under a new unit_index, so
 * the slot keeps earning for the device in the customer's hands, and stops when
 * that device's warranty closes (worker/lib/deviceCustody.ts `liveUnitOfSlot`).
 */
const chainHops = () => Array.from({ length: MAX_REPLACEMENT_HOPS }, (_, i) => i + 1);
const chainJoins = (root = 'd', hop = 'r') =>
  chainHops().map((h) => `LEFT JOIN order_item_units ${hop}${h} ON ${hop}${h}.id = ${h === 1 ? root : `${hop}${h - 1}`}.replaced_by_unit_id`).join('\n         ');
/** Still open. A unit closed by a cancel whose order was then delivered again stays open (serialAssignments.ts REDELIVERED); the query only reads delivered orders. */
const OPEN = (a: string) => `(${a}.warranty_closed_at IS NULL OR ${a}.warranty_closed_reason = 'order_cancelled')`;
const chainEndOpen = (root = 'd', hop = 'r') =>
  `CASE ${chainHops().reverse().map((h) => `WHEN ${hop}${h}.id IS NOT NULL THEN ${OPEN(`${hop}${h}`)}`).join(' ')} ELSE ${OPEN(root)} END`;

/**
 * THE WEEKLY COUPONS (owner, 2026-11-05; 0225; DECISIONS rows 223 #4 and 295).
 *
 *   «كل اسبوع كوبون خصم على الفلمنت واحد وكوبون توصيل مجاني للطلبات فوق 100 الف.
 *    طابعه وحده = كوبون واحد، ٣ طابعات = ٣ كوبونات وهكذا كل اسبوع»
 *   «فترة محددة all the warranty period 12month»
 *
 * Who earns: every printer the customer bought and still has, while its base
 * warranty runs, at most `weekly.months` from the warranty's own start. An
 * extended warranty adds nothing (row 223 #4). A printer already out when this
 * reached the database earns for what is left of its months: «كل طابعة ضمانها
 * شغال», with its weeks counted from this migration, so nothing is paid back.
 *
 * Who stops earning: a printer returned (a refund case, whether or not the case
 * names the unit), in the shop for a trade-in from the moment it is received (and
 * earning again if it is handed back), traded in, or whose warranty closed.
 *
 * A week is seven days from the later of the delivery and the migration. Only
 * THE CURRENT WEEK is ever issued: a sweep that was down for a fortnight gives
 * the coupon of this week, not three. Nothing piles up: each coupon lives
 * `valid_days`, and last week's unused coupon just ends.
 *
 * Idempotent per printer, kind and week (`printerSourceRef`). Bounded by
 * `WEEKLY_UNIT_LIMIT`, and a unit done stops matching, so a backlog drains one
 * tick after another.
 */
export async function issueWeeklyRewards(env: Env, startedAt: string, nowIso: string): Promise<WeeklyIssueReport> {
  const report: WeeklyIssueReport = { scanned: 0, issued: 0, errors: 0 };
  const db = env.DB;
  const config = await getRewardConfigStrict(db);
  const kinds: RewardCouponKind[] = [];
  if (config.free_shipping.enabled) kinds.push('free_shipping');
  if (config.filament.enabled) kinds.push('filament_discount');
  if (!config.enabled || !config.weekly.enabled || kinds.length === 0) return report;

  const week = `CAST((julianday(?1) - MAX(
                  julianday(COALESCE(u.warranty_start_at, u.delivered_at)),
                  julianday(COALESCE(u.delivered_at, u.warranty_start_at)),
                  julianday(?2))) / 7 AS INTEGER)`;
  const missing = kinds.map((k) => `NOT EXISTS (SELECT 1 FROM reward_grants g WHERE g.source_ref = ${printerSourceRefSql(k, 'd')})`).join(' OR ');
  // This runs every quarter hour over every printer in its warranty, and almost all of
  // them already hold this week's coupons. So the cheap tests come first: the dates,
  // then the two key look-ups (written first among the sub-queries, which SQLite keeps
  // in order); only a printer really due reaches the returns, the trade-ins and the
  // catalogs.
  const { results } = await db
    .prepare(
      `SELECT d.order_id, d.order_item_id, d.unit_index, o.user_id, d.week
         FROM (SELECT u.*, ${week} AS week
                 FROM order_item_units u
                WHERE u.replacement_of_unit_id IS NULL
                  AND julianday(COALESCE(u.warranty_start_at, u.delivered_at), '+' || MIN(COALESCE(u.warranty_base_months, 12), ?3) || ' months') > julianday(?1)) AS d
         JOIN orders o ON o.id = d.order_id
         JOIN order_items oi ON oi.id = d.order_item_id
         ${chainJoins()}
        WHERE d.week >= 0
          AND o.status = 'delivered'
          AND COALESCE(o.seller_type, 'levonis') <> 'merchant'
          AND oi.product_id IS NOT NULL
          AND oi.gift_entitlement_id IS NULL
          AND (${missing})
          AND ${chainEndOpen()}
          AND ${tradedInSql('d')} IS NULL
          AND ${inShopSql('d')} IS NULL
          -- A refund the case could not pin on a unit still takes a printer off
          -- the line: the highest slots still open stop, as revokeRewardsForReturn
          -- does. A lower slot counts by the end of its own chain: one whose
          -- replacement went back is already the printer that refund took.
          AND (SELECT COUNT(*) FROM order_item_units low
                 ${chainJoins('low', 'lr')}
                WHERE low.order_item_id = d.order_item_id AND low.replacement_of_unit_id IS NULL AND low.unit_index < d.unit_index
                  AND ${chainEndOpen('low', 'lr')})
              < oi.qty - COALESCE((SELECT SUM(rc.qty) FROM return_cases rc
                                    WHERE rc.order_item_id = oi.id AND rc.state = 'resolved' AND rc.resolution = 'refund'), 0)
          AND NOT EXISTS (SELECT 1 FROM order_items k WHERE k.bundle_parent_item_id = oi.id)
          AND EXISTS (SELECT 1 FROM product_catalogs pc JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                       WHERE pc.product_id = oi.product_id)
        LIMIT ?4`
    )
    .bind(nowIso, startedAt, config.weekly.months, WEEKLY_UNIT_LIMIT)
    .all<{ order_id: string; order_item_id: string; unit_index: number; user_id: string; week: number }>();
  const due = results ?? [];
  report.scanned = due.length;
  if (due.length === 0) return report;

  const expiresAt = new Date(Date.parse(nowIso) + config.valid_days * DAY_MS).toISOString();
  const byUser = new Map<string, typeof due>();
  for (const r of due) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);

  for (const [userId, units] of byUser) {
    const refs = units.flatMap((u) => kinds.map((kind) => ({ u, kind, ref: printerSourceRef(u, kind, u.week) })));
    try {
      const { results: have } = await db
        .prepare('SELECT source_ref FROM reward_grants WHERE source_ref IN (SELECT value FROM json_each(?1))')
        .bind(JSON.stringify(refs.map((r) => r.ref)))
        .all<{ source_ref: string }>();
      const held = new Set((have ?? []).map((r) => r.source_ref));
      const statements: D1PreparedStatement[] = [];
      let firstGrant = '';
      let issued = 0;
      for (const { u, kind, ref } of refs) {
        if (held.has(ref)) continue;
        const grantId = newId('rwg');
        firstGrant ||= grantId;
        statements.push(
          ...mintStatements(db, {
            grantId,
            couponId: newId('cpn'),
            code: rewardCouponCode(kind),
            userId,
            source: 'printer',
            sourceRef: ref,
            orderId: u.order_id,
            orderItemId: u.order_item_id,
            unitIndex: u.unit_index,
            terms: termsFor(kind, config),
            issuedAt: nowIso,
            expiresAt,
          })
        );
        issued += 1;
      }
      if (issued === 0) continue;
      const text = rewardText({
        kind: 'weekly_coupons',
        until: expiresAt.slice(0, 10),
        percent: config.filament.percent,
        amount: config.free_shipping.amount_iqd,
        min: config.free_shipping.min_order_iqd,
        pieces: config.filament.max_pieces,
        kinds,
      });
      statements.push(
        notifyStatement(db, {
          userId,
          kind: 'reward',
          title_ar: text.title.ar,
          title_en: text.title.en,
          body_ar: text.body.ar,
          body_en: text.body.en,
          link: '/rewards/coupons',
          entity_type: 'reward_grant',
          entity_id: firstGrant,
          meta: { title_ckb: text.title.ckb, body_ckb: text.body.ckb, expires_at: expiresAt },
          // One notice a day however many printers, and however the units fell across ticks.
          eventKey: `reward:weekly:${nowIso.slice(0, 10)}`,
        }).stmt
      );
      await db.batch(statements);
      report.issued += issued;
    } catch (e) {
      // A racing caller's key is that coupon already issued: nothing of this batch
      // was written, and the next tick finds whatever is still missing.
      if (isUnique(e)) continue;
      if (isSchemaMissing(e)) throw e;
      report.errors += 1;
      console.error('weekly reward coupons failed for customer', userId, e instanceof Error ? e.message : String(e));
    }
  }
  return report;
}

// ------------------------------------------------------------- returns

/**
 * A RETURNED PRINTER TAKES BACK COUPONS NOT YET USED. Called after a return
 * case is resolved with a refund (worker/routes/returns.ts): every LIVE printer
 * coupon of `qty` printers of that line goes off, highest unit first, whichever
 * week it came from (an owner's longer `valid_days` leaves several weeks live).
 * A coupon the customer already spent is never clawed back, and the printer earns no more weeks
 * (`issueWeeklyRewards`). Idempotent per case: its reason names the case, and a
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
        `SELECT g.id, g.coupon_id, g.unit_index FROM reward_grants g
           JOIN coupons c ON c.id = g.coupon_id
          WHERE g.order_item_id = ?1 AND g.source = 'printer' AND g.revoked_at IS NULL
            AND c.active = 1 AND (c.ends_at IS NULL OR c.ends_at > ?2)
            AND NOT ${SPENT_SQL('g.coupon_id')}
          ORDER BY g.unit_index DESC, g.issued_at DESC, g.kind`
      )
      .bind(input.orderItemId, nowIso)
      .all<{ id: string; coupon_id: string; unit_index: number | null }>();
    const printers = new Set<number | null>();
    const picks = (results ?? []).filter((g) => {
      if (!printers.has(g.unit_index) && printers.size >= qty) return false;
      printers.add(g.unit_index);
      return true;
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
    WHEN ${SPENT_SQL('g.coupon_id')} THEN 'used'
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
  /** A percentage coupon's percentage; 0 for a coupon worth a fixed amount. */
  percent: number;
  /** A fixed coupon's dinars off; null for a percentage. */
  amount_iqd: number | null;
  /** The goods, after every discount, an order needs. 0 is none. */
  min_total_iqd: number;
  max_discount_iqd: number | null;
  /** How many pieces it discounts. Null is every piece it names (a coupon from before 0225). */
  max_quantity: number | null;
  /** It also works on a piece already on sale. */
  stacks: boolean;
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
  coupon_kind: string | null;
  value: number | null;
  min_total_iqd: number | null;
  max_discount_iqd: number | null;
  max_quantity: number | null;
  stacks: number | null;
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
         c.code, c.kind AS coupon_kind, c.value, c.min_total_iqd, c.max_discount_iqd, c.max_quantity, c.stacks, c.scope, c.category_id, c.product_ids, c.ends_at,
         ${SPENT_ON_SQL('g.coupon_id')} AS used_on_order_id,
         ${GRANT_STATE_SQL(now)} AS state${extra.columns ? `, ${extra.columns}` : ''}
    FROM reward_grants g LEFT JOIN coupons c ON c.id = g.coupon_id${extra.joins ? ` ${extra.joins}` : ''}`;

export const GRANT_SELECT = (now: string) => grantSelect(now);

const stringList = (raw: string | null): string[] => {
  const parsed = safeParse<unknown>(raw ?? '[]', []);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
};

export function grantView(r: GrantRow): RewardCouponView {
  const value = Math.max(0, Math.trunc(Number(r.value) || 0));
  return {
    id: r.id,
    kind: r.kind,
    source: r.source,
    state: r.state,
    code: String(r.code ?? ''),
    percent: r.coupon_kind === 'fixed_iqd' ? 0 : value,
    amount_iqd: r.coupon_kind === 'fixed_iqd' ? value : null,
    min_total_iqd: Math.max(0, Math.trunc(Number(r.min_total_iqd) || 0)),
    max_discount_iqd: r.max_discount_iqd === null || r.max_discount_iqd === undefined ? null : Number(r.max_discount_iqd),
    max_quantity: r.max_quantity === null || r.max_quantity === undefined ? null : Number(r.max_quantity),
    stacks: r.stacks === null || r.stacks === undefined ? true : Number(r.stacks) !== 0,
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
     AND NOT ${SPENT_SQL('h.coupon_id')}`;

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
  const holding = HOLDING_SQL.replace('?U', '?17').replace('?K', '?18').replace('?N', '?4');
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
