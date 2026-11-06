/**
 * EVERY PRINTER AND WHAT IT EARNS (owner, 2026-11-05: «coupons with every printer»;
 * DECISIONS row 298). Two readers over one definition (./earning.ts, the fragments
 * `issueWeeklyRewards` issues by), so a printer reads «earning» exactly when the
 * sweep would serve it:
 *
 *   `customerPrinters`   the customer's «طابعاتك» on /rewards/coupons;
 *   `adminPrintersPage`  Admin → المكافآت → الطابعات, every unit, paged and searchable.
 *
 * A printer that left the programme is listed with why (`stopped`); a line that was
 * never a printer of the programme (a gift, a store's order, a bundle parent, another
 * product) is not listed at all. No cost is read here.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): `this_week`'s read names 0220's and 0225's tables on
 * every call, even with no printer to ask about, so a database without them throws the
 * schema error the routes answer with `installed: false` and an empty list.
 */
import { badRequest } from '../http';
import { sqlLikeClause, likePattern } from '../sqlLike';
import { safeParse } from '../types';
import { REWARD_COUPON_KINDS, getRewardConfig, type RewardCouponKind, type RewardProgramConfig } from './config';
import { DAY_MS, GRANT_STATE_SQL, printerSourceRef, type RewardGrantState } from './coupons';
import {
  SLOT_IS_PRINTER_SQL,
  SLOT_SOLD_HERE_SQL,
  slotChainUnitIds,
  slotJoins,
  slotEndsAtSql,
  slotFirstWeekAtSql,
  slotStoppedSql,
  slotWarrantyEndSql,
  slotWeekSql,
  type PrinterStopped,
} from './earning';
import { SPENT_SQL } from './pool';
import type { Trilingual } from './strings';
import { WEEKLY_MIGRATION, programStartedAt } from './sweep';

const WEEK_MS = 7 * DAY_MS;

/** The most printers the customer's page lists. */
export const CUSTOMER_PRINTERS_LIMIT = 40;
/** A page of the admin's list. */
export const ADMIN_PRINTERS_PAGE = 50;

export interface WeeklyProgramme {
  config: RewardProgramConfig;
  /** When the weekly programme reached this database, or null when it cannot say. */
  startedAt: string | null;
  /** Nothing is issued at all: a switch is off, or the database cannot say when it began. */
  off: boolean;
}

/** The terms and the start the sweep itself reads. Nothing issues while any of them says no. */
export async function weeklyProgramme(db: D1Database): Promise<WeeklyProgramme> {
  const [config, startedAt] = await Promise.all([getRewardConfig(db), programStartedAt(db, WEEKLY_MIGRATION)]);
  const off = !startedAt || !config.enabled || !config.weekly.enabled || (!config.free_shipping.enabled && !config.filament.enabled);
  return { config, startedAt, off };
}

/** The statement's placeholders: the instant, the programme's start (now when it has none) and the owner's months. */
const BINDS = { now: '?1', started: '?2', months: '?3' };

interface SlotRow {
  unit_id: string;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  delivered_at: string | null;
  warranty_start_at: string | null;
  warranty_end: string | null;
  week: number | null;
  user_id: string;
  product_id: string | null;
  name_snapshot: string | null;
  image_snapshot: string | null;
  product_slug: string | null;
  product_name: string | null;
  product_name_ar: string | null;
  product_name_ku: string | null;
  product_images: string | null;
  first_week_at: string | null;
  ends_at: string | null;
  stopped: PrinterStopped | null;
}

const slotColumns = () => `d.id AS unit_id, d.order_id, d.order_item_id, d.unit_index, d.delivered_at, d.warranty_start_at, ${slotWarrantyEndSql()} AS warranty_end, d.week,
         o.user_id, oi.product_id, oi.name_snapshot, oi.image_snapshot,
         p.slug AS product_slug, p.name AS product_name, p.name_ar AS product_name_ar, p.name_ku AS product_name_ku, p.images AS product_images,
         ${slotFirstWeekAtSql(BINDS)} AS first_week_at,
         ${slotEndsAtSql(BINDS)} AS ends_at,
         ${slotStoppedSql(BINDS)} AS stopped`;

const slotsFrom = (unitFilter = '') => `(SELECT u.*, ${slotWeekSql(BINDS)} AS week
                 FROM order_item_units u
                WHERE u.replacement_of_unit_id IS NULL${unitFilter ? ` AND ${unitFilter}` : ''}) AS d
         ${slotJoins()}
         LEFT JOIN products p ON p.id = oi.product_id`;

/** What a slot row says, for either reader. */
function slotFacts(r: SlotRow, programme: WeeklyProgramme) {
  const stopped: PrinterStopped | null = r.stopped ?? (programme.off ? 'programme_off' : null);
  const earning = stopped === null;
  const start = Date.parse(String(r.first_week_at));
  const end = Date.parse(String(r.ends_at));
  const known = Number.isFinite(start) && Number.isFinite(end);
  const weeksTotal = known ? Math.max(0, Math.ceil((end - start) / WEEK_MS)) : 0;
  const rawWeek = Math.max(0, Number(r.week) || 0);
  const next = known ? start + WEEK_MS * (rawWeek + 1) : NaN;
  const images = safeParse<unknown>(r.product_images ?? '[]', []);
  const name = String(r.product_name ?? r.name_snapshot ?? '');
  const tri: Trilingual = { ar: r.product_name_ar || name, en: name, ckb: r.product_name_ku || name };
  return {
    order_id: r.order_id,
    order_item_id: r.order_item_id,
    unit_index: Number(r.unit_index),
    product_slug: String(r.product_slug ?? ''),
    name: tri,
    image: (Array.isArray(images) && typeof images[0] === 'string' ? images[0] : '') || String(r.image_snapshot ?? ''),
    delivered_at: r.delivered_at,
    warranty_start_at: r.warranty_start_at,
    earning,
    stopped,
    /** The week it is in, 0 first; held inside the weeks it has. The page counts from 1. */
    week: weeksTotal > 0 ? Math.min(rawWeek, weeksTotal - 1) : 0,
    weeks_total: weeksTotal,
    next_at: earning && Number.isFinite(next) && next < end ? new Date(next).toISOString() : null,
    ends_at: known ? r.ends_at : null,
    /** The raw week, for the key of this week's coupons. */
    rawWeek,
  };
}

// ------------------------------------------------------------ the customer's

export interface CustomerPrinter {
  order_item_id: string;
  unit_index: number;
  product_slug: string;
  name: Trilingual;
  image: string;
  delivered_at: string | null;
  warranty_start_at: string | null;
  earning: boolean;
  stopped: PrinterStopped | null;
  week: number;
  weeks_total: number;
  next_at: string | null;
  ends_at: string | null;
  this_week: Array<{ kind: RewardCouponKind; state: RewardGrantState; expires_at: string }>;
}

/** This customer's printers: those earning first, then the newest; at most 40. */
export async function customerPrinters(db: D1Database, userId: string, nowIso = new Date().toISOString()): Promise<CustomerPrinter[]> {
  const programme = await weeklyProgramme(db);
  const { results } = await db
    .prepare(
      `SELECT * FROM (SELECT ${slotColumns()}
         FROM ${slotsFrom('u.order_id IN (SELECT id FROM orders WHERE user_id = ?4)')}
        WHERE o.user_id = ?4 AND ${SLOT_SOLD_HERE_SQL} AND ${SLOT_IS_PRINTER_SQL})
       ORDER BY stopped IS NOT NULL, delivered_at DESC, unit_index ASC
       LIMIT ?5`
    )
    .bind(nowIso, programme.startedAt ?? nowIso, programme.config.weekly.months, userId, CUSTOMER_PRINTERS_LIMIT)
    .all<SlotRow>();
  const slots = (results ?? []).map((r) => slotFacts(r, programme));

  // This week's coupons of each, by the key they were issued under.
  const refs = slots.flatMap((s) => REWARD_COUPON_KINDS.map((kind) => printerSourceRef(s, kind, s.rawWeek)));
  const { results: held } = await db
    .prepare(
      `SELECT g.source_ref, g.kind, COALESCE(c.ends_at, g.expires_at) AS expires_at, ${GRANT_STATE_SQL('?2')} AS state
         FROM reward_grants g LEFT JOIN coupons c ON c.id = g.coupon_id
        WHERE g.source_ref IN (SELECT value FROM json_each(?1))`
    )
    .bind(JSON.stringify(refs), nowIso)
    .all<{ source_ref: string; kind: RewardCouponKind; expires_at: string; state: RewardGrantState }>();
  const byRef = new Map((held ?? []).map((h) => [h.source_ref, h]));

  return slots.map(({ rawWeek, order_id: _order, ...s }) => ({
    ...s,
    this_week: REWARD_COUPON_KINDS.flatMap((kind) => {
      const h = byRef.get(printerSourceRef(s, kind, rawWeek));
      return h ? [{ kind: h.kind, state: h.state, expires_at: h.expires_at }] : [];
    }),
  }));
}

// ------------------------------------------------------------ the admin's

export type AdminPrinterState = 'earning' | 'stopped' | 'all';

export interface AdminPrinterRow {
  unit_id: string;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  product_slug: string;
  name: Trilingual;
  image: string;
  serial: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  earning: boolean;
  stopped: PrinterStopped | null;
  week: number;
  weeks_total: number;
  next_at: string | null;
  ends_at: string | null;
  coupons_issued: number;
  coupons_spent: number;
  customer: { id: string; name: string; username: string; email: string };
}

const CURSOR = /^(.*)\|([^|]+)$/;

/** Every printer unit, the newest delivery first, 50 to a page: by state, and searched by customer, order or serial. */
export async function adminPrintersPage(
  db: D1Database,
  input: { state: AdminPrinterState; q?: string | null; cursor?: string | null },
  nowIso = new Date().toISOString()
): Promise<{ printers: AdminPrinterRow[]; next_cursor: string | null }> {
  const programme = await weeklyProgramme(db);
  const binds: unknown[] = [nowIso, programme.startedAt ?? nowIso, programme.config.weekly.months, ADMIN_PRINTERS_PAGE + 1];

  const inner: string[] = [SLOT_SOLD_HERE_SQL, SLOT_IS_PRINTER_SQL];
  const pattern = likePattern(input.q);
  if (pattern) {
    binds.push(pattern);
    const p = `?${binds.length}`;
    inner.push(
      `(${sqlLikeClause(['cu.name', 'cu.username', 'cu.email', 'd.order_id'], p)}
        OR EXISTS (SELECT 1 FROM device_serials ds WHERE ds.unit_id IN (${slotChainUnitIds()}) AND (${sqlLikeClause(['ds.serial_raw', 'ds.serial_norm'], p)}))
        OR EXISTS (SELECT 1 FROM serial_assignments sa WHERE sa.order_item_id = d.order_item_id AND sa.unit_index = d.unit_index AND (${sqlLikeClause(['sa.serial_raw', 'sa.serial_norm'], p)})))`
    );
  }

  const outer: string[] = [];
  // Nothing earns while the programme is off: the stopped list is everyone, and the earning one nobody.
  if (input.state === 'earning') outer.push(programme.off ? '0' : 'stopped IS NULL');
  else if (input.state === 'stopped' && !programme.off) outer.push('stopped IS NOT NULL');
  if (input.cursor) {
    const m = CURSOR.exec(input.cursor);
    if (!m) throw badRequest('That page of printers does not exist', 'BAD_CURSOR');
    binds.push(m[1], m[2]);
    outer.push(`(COALESCE(delivered_at, '') < ?${binds.length - 1} OR (COALESCE(delivered_at, '') = ?${binds.length - 1} AND unit_id < ?${binds.length}))`);
  }

  const { results } = await db
    .prepare(
      `SELECT * FROM (SELECT ${slotColumns()},
              cu.name AS customer_name, cu.username AS customer_username, cu.email AS customer_email,
              (SELECT ds.serial_raw FROM device_serials ds WHERE ds.unit_id IN (${slotChainUnitIds()}) ORDER BY ds.assigned_at DESC LIMIT 1) AS serial
         FROM ${slotsFrom()}
         JOIN users cu ON cu.id = o.user_id
        WHERE ${inner.join(' AND ')})
       ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
       ORDER BY COALESCE(delivered_at, '') DESC, unit_id DESC
       LIMIT ?4`
    )
    .bind(...binds)
    .all<SlotRow & { customer_name: string | null; customer_username: string | null; customer_email: string | null; serial: string | null }>();
  const rows = results ?? [];
  const page = rows.slice(0, ADMIN_PRINTERS_PAGE);

  const { results: counts } = await db
    .prepare(
      `SELECT g.order_item_id, g.unit_index, COUNT(*) AS issued, SUM(CASE WHEN ${SPENT_SQL('g.coupon_id')} THEN 1 ELSE 0 END) AS spent
         FROM reward_grants g
        WHERE g.source = 'printer' AND g.order_id IN (SELECT value FROM json_each(?1))
        GROUP BY g.order_item_id, g.unit_index`
    )
    .bind(JSON.stringify([...new Set(page.map((r) => r.order_id))]))
    .all<{ order_item_id: string; unit_index: number; issued: number; spent: number }>();
  const countOf = new Map((counts ?? []).map((n) => [`${n.order_item_id}:${n.unit_index}`, n]));

  const last = page[page.length - 1];
  return {
    printers: page.map((r) => {
      const { rawWeek: _raw, delivered_at, warranty_start_at: _start, ...s } = slotFacts(r, programme);
      const n = countOf.get(`${r.order_item_id}:${r.unit_index}`);
      return {
        ...s,
        unit_id: r.unit_id,
        delivered_at,
        serial: String(r.serial ?? ''),
        warranty_end_at: r.warranty_end,
        coupons_issued: Number(n?.issued) || 0,
        coupons_spent: Number(n?.spent) || 0,
        customer: { id: r.user_id, name: String(r.customer_name ?? ''), username: String(r.customer_username ?? ''), email: String(r.customer_email ?? '') },
      };
    }),
    next_cursor: rows.length > ADMIN_PRINTERS_PAGE && last ? `${last.delivered_at ?? ''}|${last.unit_id}` : null,
  };
}
