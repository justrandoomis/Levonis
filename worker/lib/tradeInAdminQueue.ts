/**
 * THE DESK'S TRADE-IN QUEUE, v2 (Services S-P2 spec §6.13; DECISIONS row 238) — and the owner's
 * trade-in doors that read private figures.
 *
 *   adminQueue        GET /api/admin/trade-in/requests — one search over the customer (name,
 *                     e-mail, the phone's last digits), the request and order ids, the serial the
 *                     desk scanned and the serial on record, the device and the target names; work
 *                     chips with their counts; keyset pages of 30. Any admin: the row carries the
 *                     offer, the ceiling and the final value (staff figures), never a cost.
 *   servicesBadge     GET /api/admin/services/badge — what waits on the desk.
 *   tradeInPnl        GET /api/admin/trade-in/pnl — the owner's trade-in P&L (cost_read).
 *   componentRefs*    the owner's component references (cost_read / owner).
 *
 * Every read names its columns; the search is ONE statement with at most 6 binds.
 */
import { normalizeSerial } from '@levonis/catalog/deviceSerials';
import { stageOf, type TradeInStage, type TradeInStatus } from '@levonis/pricing/tradeIn';
import { safeParse } from './types';

export const QUEUE_CHIPS = ['awaiting_device', 'inspecting', 'decision', 'credit_ready', 'awaiting_new_device', 'completed', 'closed', 'device_to_collect', 'overdue'] as const;
export type QueueChip = (typeof QUEUE_CHIPS)[number];
export const QUEUE_PAGE = 30;
const HOUR = 3_600_000;

const LIVE_ORDER = `EXISTS (SELECT 1 FROM coupon_redemptions lr JOIN orders lo ON lo.id = lr.order_id
                     WHERE lr.coupon_id = r.coupon_id AND lr.state = 'active' AND lo.status <> 'cancelled')`;
/** The work chip a request sits under — the customer's stage, seen from the desk. */
const CHIP_SQL = `CASE
    WHEN r.status IN ('cancelled','customer_rejected') AND r.intake_at IS NOT NULL AND r.device_returned_at IS NULL THEN 'device_to_collect'
    WHEN r.status IN ('cancelled','customer_rejected') THEN 'closed'
    WHEN r.status = 'completed' THEN 'completed'
    WHEN r.status = 'value_changed' THEN 'decision'
    WHEN r.status IN ('approved_as_estimated','customer_accepted','awaiting_payment') AND ${LIVE_ORDER} THEN 'awaiting_new_device'
    WHEN r.intake_at IS NULL THEN 'awaiting_device'
    WHEN r.status IN ('submitted','under_review') THEN 'inspecting'
    ELSE 'credit_ready' END`;
/** ?1 = now + 24 h, ?2 = now − 48 h: a device due within a day, or a received one waiting over two. */
const OVERDUE_SQL = (soon: string, stale: string) =>
  `((${CHIP_SQL}) = 'awaiting_device' AND r.offer_expires_at IS NOT NULL AND r.offer_expires_at < ${soon})
   OR ((${CHIP_SQL}) = 'inspecting' AND r.intake_at < ${stale})`;
const SORT_AT = `COALESCE(r.submitted_at, r.created_at)`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export interface QueueQuery {
  q: string | null;
  chip: QueueChip | null;
  family: string | null;
  /** The old desk's filter (kept until pass B replaces it). */
  status: string | null;
  cursor: string | null;
  now?: Date;
}

export interface QueueRow {
  id: string;
  status: TradeInStatus;
  stage: TradeInStage;
  chip: QueueChip;
  family: string;
  scope: string;
  order_id: string;
  name: string;
  image: string;
  target_name: string;
  offer_iqd: number | null;
  ceiling_iqd: number | null;
  final_value_iqd: number | null;
  /** The old desk's keys (staff figures; pass B drops them). */
  estimated_iqd: number | null;
  admin_value_iqd: number | null;
  difference_iqd: number | null;
  target_price_iqd: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  flags: { serial: 'match' | 'mismatch' | 'unrecorded' | null; hours: boolean; above_ceiling: boolean; overdue: boolean; cutover: boolean };
  created_at: string;
  submitted_at: string | null;
  offer_expires_at: string | null;
  updated_at: string;
}

/** The queue: one search statement, one count statement. */
export async function adminQueue(db: D1Database, query: QueueQuery): Promise<{ requests: QueueRow[]; counts: Record<QueueChip, number> & Record<string, number>; status_counts: Record<string, number>; next_cursor: string | null; limit: number }> {
  const now = query.now ?? new Date();
  const soon = new Date(now.getTime() + 24 * HOUR).toISOString();
  const stale = new Date(now.getTime() - 48 * HOUR).toISOString();
  const args: unknown[] = [soon, stale];
  const where: string[] = [`r.status <> 'draft'`];
  const q = (query.q ?? '').trim().slice(0, 80);
  if (q.length >= 2) {
    args.push(`%${escapeLike(q.toLowerCase())}%`);
    const like = `?${args.length}`;
    const parts = [
      `lower(COALESCE(u.name, '')) LIKE ${like} ESCAPE '\\'`,
      `lower(COALESCE(u.email, '')) LIKE ${like} ESCAPE '\\'`,
      `lower(r.id) LIKE ${like} ESCAPE '\\'`,
      `lower(r.order_id) LIKE ${like} ESCAPE '\\'`,
      `lower(COALESCE(json_extract(r.source_snapshot_json, '$.name'), '')) LIKE ${like} ESCAPE '\\'`,
      `lower(COALESCE(json_extract(r.target_snapshot_json, '$.name'), '')) LIKE ${like} ESCAPE '\\'`,
    ];
    const digits = q.replace(/\D/g, '').replace(/^0+/, '');
    if (digits.length >= 4) {
      args.push(`%${digits}`);
      parts.push(`COALESCE(u.phone_e164, '') LIKE ?${args.length}`);
    }
    const serial = normalizeSerial(q).slice(0, 64);
    if (serial.length >= 4) {
      args.push(`%${escapeLike(serial)}%`);
      const s = `?${args.length}`;
      parts.push(`COALESCE(r.intake_serial_norm, '') LIKE ${s} ESCAPE '\\'`);
      parts.push(`EXISTS (SELECT 1 FROM order_item_units su JOIN device_serials ds ON ds.unit_id = su.id
                           WHERE su.order_item_id = r.order_item_id AND ds.serial_norm LIKE ${s} ESCAPE '\\')`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (query.family) {
    args.push(query.family);
    where.push(`r.family = ?${args.length}`);
  }
  if (query.status) {
    args.push(query.status);
    where.push(`r.status = ?${args.length}`);
  }
  // The counts read the search and the family, not the chip or the page.
  const countWhere = [...where];
  const countArgs = [...args];
  if (query.chip === 'overdue') where.push(`(${OVERDUE_SQL('?1', '?2')})`);
  else if (query.chip) {
    args.push(query.chip);
    where.push(`(${CHIP_SQL}) = ?${args.length}`);
  }
  const cursor = parseCursor(query.cursor);
  if (cursor) {
    args.push(cursor.at, cursor.id);
    where.push(`(${SORT_AT} < ?${args.length - 1} OR (${SORT_AT} = ?${args.length - 1} AND r.id < ?${args.length}))`);
  }
  args.push(QUEUE_PAGE + 1);
  const [list, counts] = await Promise.all([
    db
      .prepare(
        `SELECT r.id, r.status, r.family, r.scope, r.order_id, r.source_snapshot_json, r.target_snapshot_json, r.estimated_iqd, r.offer_iqd,
                r.ceiling_iqd, r.above_ceiling, r.admin_value_iqd, r.final_value_iqd, r.difference_iqd, r.target_price_iqd, r.intake_at,
                r.intake_serial_match, r.intake_json, r.valuation_version, r.cancel_reason, r.device_returned_at, r.offer_expires_at,
                r.created_at, r.submitted_at, r.updated_at, ${SORT_AT} AS sort_at, (${CHIP_SQL}) AS chip,
                CASE WHEN ${OVERDUE_SQL('?1', '?2')} THEN 1 ELSE 0 END AS overdue,
                ${LIVE_ORDER} AS live_order,
                EXISTS (SELECT 1 FROM trade_in_credit_reissues x WHERE x.request_id = r.id AND x.ends_at > ?1) AS live_reissue,
                u.name AS customer_name, u.phone_e164 AS customer_phone
           FROM trade_in_requests r LEFT JOIN users u ON u.id = r.user_id
          WHERE ${where.join(' AND ')}
          ORDER BY ${SORT_AT} DESC, r.id DESC
          LIMIT ?${args.length}`
      )
      .bind(...args)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT chip, status, COUNT(*) AS n, SUM(overdue) AS overdue FROM (
           SELECT (${CHIP_SQL}) AS chip, r.status AS status, CASE WHEN ${OVERDUE_SQL('?1', '?2')} THEN 1 ELSE 0 END AS overdue
             FROM trade_in_requests r LEFT JOIN users u ON u.id = r.user_id
            WHERE ${countWhere.join(' AND ')}) GROUP BY chip, status`
      )
      .bind(...countArgs)
      .all<{ chip: QueueChip; status: string; n: number; overdue: number | null }>(),
  ]);
  const rows = list.results ?? [];
  const page = rows.slice(0, QUEUE_PAGE);
  const out: Record<QueueChip, number> = Object.fromEntries(QUEUE_CHIPS.map((c) => [c, 0])) as Record<QueueChip, number>;
  const byStatus: Record<string, number> = {};
  for (const c of counts.results ?? []) {
    if ((QUEUE_CHIPS as readonly string[]).includes(c.chip)) out[c.chip] += Number(c.n) || 0;
    out.overdue += Number(c.overdue) || 0;
    byStatus[c.status] = (byStatus[c.status] ?? 0) + (Number(c.n) || 0);
  }
  const last = page[page.length - 1];
  return {
    requests: page.map(queueRow),
    // The chips (S-P2) and, for the desk page that predates them, the stored statuses — one object:
    // no chip is named like a status but `completed`, which counts the same requests either way.
    counts: { ...byStatus, ...out },
    status_counts: byStatus,
    next_cursor: rows.length > QUEUE_PAGE && last ? `${String(last.sort_at)}|${String(last.id)}` : null,
    limit: QUEUE_PAGE,
  };
}

function parseCursor(raw: string | null): { at: string; id: string } | null {
  if (!raw) return null;
  const i = raw.lastIndexOf('|');
  if (i <= 0) return null;
  const at = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!Number.isFinite(Date.parse(at)) || !/^tin_[0-9a-z_]{1,40}$/.test(id)) return null;
  return { at, id };
}

function queueRow(r: Record<string, unknown>): QueueRow {
  const src = safeParse<Record<string, unknown>>(String(r.source_snapshot_json ?? '{}'), {});
  const tgt = safeParse<Record<string, unknown>>(String(r.target_snapshot_json ?? '{}'), {});
  const facts = safeParse<Record<string, unknown>>(String(r.intake_json ?? '{}'), {});
  const serial = r.intake_serial_match;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const status = r.status as TradeInStatus;
  return {
    id: String(r.id),
    status,
    stage: stageOf(
      { status, intake_at: (r.intake_at as string | null) ?? null, cancel_reason: (r.cancel_reason as string) ?? '', device_returned_at: (r.device_returned_at as string | null) ?? null },
      Number(r.live_order) === 1,
      Number(r.live_reissue) === 1 && Number(r.live_order) !== 1
    ),
    chip: r.chip as QueueChip,
    family: String(r.family),
    scope: String(r.scope),
    order_id: String(r.order_id),
    name: String(src.name ?? ''),
    image: String(src.image ?? ''),
    target_name: String(tgt.name ?? ''),
    offer_iqd: num(r.offer_iqd),
    ceiling_iqd: num(r.ceiling_iqd),
    final_value_iqd: num(r.final_value_iqd),
    estimated_iqd: num(r.estimated_iqd),
    admin_value_iqd: num(r.admin_value_iqd),
    difference_iqd: num(r.difference_iqd),
    target_price_iqd: num(r.target_price_iqd),
    customer_name: (r.customer_name as string | null) ?? null,
    customer_phone: (r.customer_phone as string | null) ?? null,
    flags: {
      serial: serial === 'match' || serial === 'mismatch' || serial === 'unrecorded' ? serial : null,
      hours: facts.hours_flag === true,
      above_ceiling: Number(r.above_ceiling) === 1,
      overdue: Number(r.overdue) === 1,
      // A request opened before S-P2 (v1) that is still in flight: the desk sees it was valued on photos.
      cutover: Number(r.valuation_version ?? 1) < 2 && !['completed', 'cancelled', 'customer_rejected'].includes(status),
    },
    created_at: String(r.created_at),
    submitted_at: (r.submitted_at as string | null) ?? null,
    offer_expires_at: (r.offer_expires_at as string | null) ?? null,
    updated_at: String(r.updated_at),
  };
}

/**
 * WHAT WAITS ON THE DESK (`GET /api/admin/services/badge`, any admin): trade-ins whose device is
 * due within a day, devices received and not yet decided, devices to hand back; price-protection
 * claims waiting. Two counts, one statement each; a database without 0192 counts the old way.
 */
export async function servicesBadge(db: D1Database, v2: boolean, now = new Date()): Promise<{ trade_in: number; price_protection: number }> {
  const soon = new Date(now.getTime() + 24 * HOUR).toISOString();
  const [t, p] = await Promise.all([
    v2
      ? db
          .prepare(
            `SELECT COUNT(*) AS n FROM trade_in_requests r
              WHERE (r.status IN ('submitted','under_review','value_changed') AND r.intake_at IS NULL AND r.offer_expires_at IS NOT NULL AND r.offer_expires_at < ?1)
                 OR (r.status IN ('submitted','under_review') AND r.intake_at IS NOT NULL)
                 OR (r.status IN ('cancelled','customer_rejected') AND r.intake_at IS NOT NULL AND r.device_returned_at IS NULL)`
          )
          .bind(soon)
          .first<{ n: number }>()
      : db.prepare(`SELECT COUNT(*) AS n FROM trade_in_requests WHERE status IN ('submitted','under_review')`).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM price_protection_claims WHERE state = 'requested'`).first<{ n: number }>(),
  ]);
  return { trade_in: Number(t?.n) || 0, price_protection: Number(p?.n) || 0 };
}

/**
 * THE OWNER'S TRADE-IN P&L (`GET /api/admin/trade-in/pnl`, cost_read) over [from, to): credits
 * fixed, devices in stock at their cost, devices resold (revenue, cost, margin), write-offs, owner
 * values above the ceiling, credits given back. Each figure one statement; tolerant of a database
 * without 0192 (zeros).
 */
export async function tradeInPnl(db: D1Database, from: string, to: string) {
  const zero = { count: 0, total_iqd: 0 };
  const safe = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return fallback;
      throw e;
    }
  };
  const [credits, inStock, resold, writeOffs, overrides, reissued] = await Promise.all([
    safe(
      async () =>
        (await db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(credit_iqd), 0) AS total_iqd FROM trade_in_requests
              WHERE credit_iqd IS NOT NULL AND decided_at >= ?1 AND decided_at < ?2 AND status IN ('awaiting_payment','completed')`
          )
          .bind(from, to)
          .first<{ count: number; total_iqd: number }>()) ?? zero,
      zero
    ),
    safe(
      async () =>
        (await db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(l.qty_remaining * l.unit_cost_iqd), 0) AS total_iqd
               FROM trade_in_stock s JOIN inventory_lots l ON l.id = s.lot_id WHERE l.qty_remaining > 0`
          )
          .first<{ count: number; total_iqd: number }>()) ?? zero,
      zero
    ),
    safe(
      async () =>
        (await db
          .prepare(
            `SELECT COUNT(*) AS count,
                    COALESCE(SUM(CAST(oi.line_total_iqd AS REAL) * a.qty / MAX(oi.qty, 1)), 0) AS revenue_iqd,
                    COALESCE(SUM(a.cogs_iqd), 0) AS cogs_iqd
               FROM order_item_inventory_allocations a
               JOIN trade_in_stock s ON s.lot_id = a.lot_id
               JOIN order_items oi ON oi.id = a.order_item_id
               JOIN orders o ON o.id = a.order_id
              WHERE a.released_at IS NULL AND o.status <> 'cancelled' AND a.created_at >= ?1 AND a.created_at < ?2`
          )
          .bind(from, to)
          .first<{ count: number; revenue_iqd: number; cogs_iqd: number }>()) ?? { count: 0, revenue_iqd: 0, cogs_iqd: 0 },
      { count: 0, revenue_iqd: 0, cogs_iqd: 0 }
    ),
    safe(
      async () =>
        (await db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(g.qty * l.unit_cost_iqd), 0) AS total_iqd
               FROM inventory_ledger g JOIN trade_in_stock s ON s.product_id = g.product_id JOIN inventory_lots l ON l.id = s.lot_id
              WHERE g.kind = 'adjust_out' AND g.created_at >= ?1 AND g.created_at < ?2`
          )
          .bind(from, to)
          .first<{ count: number; total_iqd: number }>()) ?? zero,
      zero
    ),
    safe(
      async () =>
        (await db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(MAX(0, COALESCE(final_value_iqd, admin_value_iqd, 0) - COALESCE(ceiling_iqd, 0))), 0) AS total_iqd
               FROM trade_in_requests WHERE above_ceiling = 1 AND updated_at >= ?1 AND updated_at < ?2`
          )
          .bind(from, to)
          .first<{ count: number; total_iqd: number }>()) ?? zero,
      zero
    ),
    safe(
      async () =>
        (await db
          .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount_iqd), 0) AS total_iqd FROM trade_in_credit_reissues WHERE created_at >= ?1 AND created_at < ?2`)
          .bind(from, to)
          .first<{ count: number; total_iqd: number }>()) ?? zero,
      zero
    ),
  ]);
  const revenue = Math.round(Number(resold.revenue_iqd) || 0);
  const cogs = Number(resold.cogs_iqd) || 0;
  return {
    from,
    to,
    credits_fixed: { count: Number(credits.count) || 0, total_iqd: Number(credits.total_iqd) || 0 },
    in_stock: { count: Number(inStock.count) || 0, cost_iqd: Number(inStock.total_iqd) || 0 },
    resold: { count: Number(resold.count) || 0, revenue_iqd: revenue, cogs_iqd: cogs, margin_iqd: revenue - cogs },
    write_offs: { count: Number(writeOffs.count) || 0, cost_iqd: Number(writeOffs.total_iqd) || 0 },
    above_ceiling: { count: Number(overrides.count) || 0, over_iqd: Number(overrides.total_iqd) || 0 },
    reissued: { count: Number(reissued.count) || 0, total_iqd: Number(reissued.total_iqd) || 0 },
  };
}

// ------------------------------------------------------------------ the owner's component references

export interface ComponentRefInput {
  product_id: string;
  option_value_id: string;
  role: 'device' | 'ams';
  ref_product_id: string | null;
  ref_price_usd: string | null;
}

/** Every reference, newest first (owner door; named columns). */
export async function listComponentRefs(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT r.product_id, r.option_value_id, r.role, r.ref_product_id, r.ref_price_usd, r.updated_by, r.updated_at,
              p.name AS product_name, rp.name AS ref_product_name
         FROM trade_in_component_refs r LEFT JOIN products p ON p.id = r.product_id LEFT JOIN products rp ON rp.id = r.ref_product_id
        ORDER BY r.updated_at DESC LIMIT 500`
    )
    .all<Record<string, unknown>>();
  return results ?? [];
}

/** A USD figure as the 0192 CHECK takes it: digits, at most two decimals, above zero. */
export const isUsdText = (s: string) => /^\d{1,9}(\.\d{1,2})?$/.test(s) && Number(s) > 0;
