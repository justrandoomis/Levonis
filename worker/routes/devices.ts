/**
 * Serialized devices, per-unit warranty and warranty claims (mandate §4).
 *
 * Customer surface (/api/devices/...):
 *   GET  /mine                       registered devices with honest coverage
 *   POST /register { serial }        non-enumerating registration by serial,
 *                                    receipt number or the receipt's QR link —
 *                                    a never-linked device only by its BUYER;
 *                                    anyone else only after a release (transfer);
 *                                    a serial (or box SN) known only to the
 *                                    serial inventory (0139) is attached to the
 *                                    caller's own delivered unit of its product
 *   GET  /eligible                   the caller's delivered units not yet linked
 *   POST /units/:unitId/register     link one of those without typing a serial
 *   DELETE /units/:unitId/registration  unlink (the step before a transfer)
 *   GET  /claims                     the user's warranty claims (legacy incl.),
 *                                    each with its thread's size and whether the
 *                                    warranty team wrote since the customer looked
 *   GET  /claims/:id                 one claim + message thread (the claimant
 *                                    opening it marks the thread seen)
 *   POST /units/:unitId/claims       open a claim from an owned device
 *   POST /claims/:id/messages        thread message (customer or staff); a staff
 *                                    message notifies the claimant
 *   POST /claims/upload              private claim attachment (image/video)
 *   GET  /claim-files/*              authorized delivery of claim attachments
 *
 * Admin surface (/api/devices/admin/..., admin role, all mutations audited):
 *   GET   /admin/orders/:orderId/units      order units + serialized items
 *   GET   /admin/units?email=|user_id=|serial=|receipt=   units by customer or identifier
 *                                           (a customer's units: bought OR held)
 *   GET   /admin/units/:unitId/history     who changed this unit, when, and why
 *   POST  /admin/units/:unitId/unregister    unlink from whichever account holds it
 *   POST  /admin/orders/:orderId/units/backfill   (re)create units, idempotent
 *   POST  /admin/units/backfill-delivered  every delivered printer order with no units
 *   POST  /admin/units/:unitId/serial       assign serial (reassign = explicit)
 *   PATCH /admin/units/:unitId/delivery     correct ONE unit's delivered_at
 *   PATCH /admin/units/:unitId/warranty     change ONE unit's warranty MONTHS
 *                                           (audited; shortening needs a flag)
 *   POST  /admin/units/:unitId/replace      replacement (history preserved)
 *   GET   /admin/claims?stage=&after=      the queue, filtered in SQL, keyset-paged
 *   PATCH /admin/claims/:id                 claim workflow decisions (notifies the claimant)
 *   POST  /admin/products/:id/ops-policy    explicit serialization config
 *   *     /admin/serial-inventory/...       the pre-sale serial store (routes/serialInventory.ts)
 *
 * A serial is an identifier, not an authentication secret. ONE ACCOUNT PER
 * DEVICE: device_registrations.unit_id is the primary key, so a unit can be
 * linked to one account at a time. A device travels between accounts only
 * by being unlinked first — by the account that holds it, or by an admin
 * when that account is lost. Registration never changes who bought the unit
 * (owner_user_id) or any warranty clock.
 *
 * THE ONE ANSWER for a serial that is unknown, not yet delivered, replaced,
 * or already linked to another account: «غير موجود أو مستخدم مسبقًا / Not
 * found or already in use.» Whether the serial exists, and whose it is, are
 * exactly the facts a stranger typing serials must not learn.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import {
  requireAuth,
  requireAdmin,
  requireMainHost,
  HttpError,
  badRequest,
  notFound,
  forbidden,
  conflict,
  str,
  int,
} from '../lib/http';
import { newId, sha256Hex } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit, rateLimitKey } from '../lib/ratelimit';
import { getTierStatus, benefits } from '../lib/entitlements';
import { RECEIPT_NO_RE } from '../lib/warranty';
import {
  effectiveDevicePolicy,
  mergeOpsPolicy,
  printerWarrantyRules,
  readOpsWarranty,
  WARRANTY_PLAN_INVALID,
} from '../lib/warrantyPlans';
import { upgradeWarranty } from '../lib/productModel';
import { isPrinterProduct, printerProductIds } from '../lib/printerIdentity';
import { chunk } from '../lib/inventory';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { notifyClaimReply, notifyClaimStage } from '../lib/engagementNotify';
import { sniff } from './uploads';
import { getMediaObject, storeMedia } from '../lib/mediaStorage';
import {
  coverageState,
  normalizeSerial,
  maskSerial,
  createUnitsOnDelivery,
  sweepDeliveredOrdersWithoutUnits,
  recomputeUnitWindow,
  unitTotalMonths,
  effectiveClaimStage,
  effectiveClaimStageSql,
  stageToLegacyStatus,
  CLAIM_STAGES,
  CLAIM_TRANSITIONS,
  type ClaimStage,
  type UnitRow,
  type WarrantySnapshotLite,
} from '../lib/deviceOps';
import { linkFromInventory } from '../lib/serialInventory';
import { serialInventoryRoutes } from './serialInventory';

export const deviceRoutes = new Hono<AppContext>();
deviceRoutes.use('*', requireAuth);
// Admin device routes live under /api/devices, outside the /api/admin/* host
// guard in worker/index.ts — so they carry their own: main host only, then
// admin. A merchant subdomain never serves them, even with the shared cookie.
deviceRoutes.use('/admin/*', requireMainHost, requireAdmin);
// The serial inventory (0139): serials the shop holds before a sale.
deviceRoutes.route('/admin/serial-inventory', serialInventoryRoutes);

// The one non-enumerating answer — unknown, undelivered, replaced, or linked
// to another account all read the same. Never reveals whether the serial
// exists or whose it is. The client shows its own localized copy off the code.
export const SERIAL_NOT_FOUND_OR_IN_USE = 'غير موجود أو مستخدم مسبقًا. / Not found or already in use.';
const SERIAL_NO_MATCH = () => new HttpError(404, SERIAL_NOT_FOUND_OR_IN_USE, 'SERIAL_NOT_FOUND_OR_IN_USE');

/**
 * What the customer typed or scanned: a serial, a receipt number
 * (WR-YYYY-MMDD-NNN), or the receipt's QR link (https://…/warranty/WR-…).
 * Returns the receipt number when the input is one, else null.
 */
export function receiptNoFrom(input: string): string | null {
  let s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
      return null;
    }
  }
  s = s.toUpperCase();
  return RECEIPT_NO_RE.test(s) ? s : null;
}

/** A claim at one of these stages is closed and no longer binds the device to its holder. */
export const CLOSED_CLAIM_SQL = `stage IN ('rejected','replaced','resolved') OR (stage IS NULL AND status IN ('rejected','approved'))`;

const UNIT_COLS = `id, order_id, order_item_id, product_id, owner_user_id, unit_index,
  delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at,
  policy_version, replaced_by_unit_id, replacement_of_unit_id, created_at`;

function isoOrBad(v: unknown, name: string): string {
  const s = str(v, name, { min: 4, max: 40 });
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw badRequest(`${name} must be an ISO-8601 timestamp`);
  if (ms < Date.parse('2015-01-01T00:00:00Z') || ms > Date.now() + 48 * 3600_000) {
    throw badRequest(`${name} is outside the plausible range`);
  }
  return new Date(ms).toISOString();
}

interface DeviceRow extends UnitRow {
  registered_at?: string | null;
  revoked_at?: string | null;
  reg_user_id?: string | null;
  receipt_no?: string | null;
  receipt_status?: string | null;
  open_claims?: number | null;
  serial_raw?: string | null;
  name_snapshot?: string | null;
  image_snapshot?: string | null;
  slug?: string | null;
  p_name?: string | null;
  p_name_ar?: string | null;
  p_name_ku?: string | null;
}

function devicePublic(row: DeviceRow, opts: { admin?: boolean; viewerId?: string } = {}) {
  const cov = coverageState(row.delivered_at, row.warranty_end_at);
  // The order belongs to the BUYER. A later holder (a transferred device) gets
  // the device and its coverage, never the buyer's order identifiers — the
  // orders routes would 404 them anyway, and an id is still a fact about
  // someone else's purchase.
  const buyerView = !!opts.admin || !opts.viewerId || opts.viewerId === row.owner_user_id;
  return {
    unit_id: row.id,
    order_id: buyerView ? row.order_id : null,
    order_item_id: buyerView ? row.order_item_id : null,
    unit_index: row.unit_index,
    product: {
      id: row.product_id,
      slug: row.slug ?? null,
      name: String(row.p_name ?? row.name_snapshot ?? ''),
      name_ar: String(row.p_name_ar ?? ''),
      name_ckb: String(row.p_name_ku ?? ''),
      // The snapshot column exists on every order since migration 0001. Empty
      // means the sold unit had no image; a later catalogue edit must not fill
      // that historical blank on the warranty/device screens.
      image: String(row.image_snapshot ?? ''),
    },
    serial: row.serial_raw ? (opts.admin ? row.serial_raw : maskSerial(row.serial_raw)) : null,
    delivered_at: row.delivered_at,
    registered_at: row.registered_at ?? null,
    warranty: {
      start_at: row.warranty_start_at,
      end_at: row.warranty_end_at,
      base_months: row.warranty_base_months,
      ext_months: row.warranty_ext_months,
      state: cov.state,
      remaining_days: cov.remaining_days,
    },
    replaced_by_unit_id: row.replaced_by_unit_id ?? null,
    replacement_of_unit_id: row.replacement_of_unit_id ?? null,
    // WHO HOLDS IT — admin only. `DEVICE_SELECT` has carried `reg_user_id`
    // all along, but only the serial lookup ever resolved it to a person, so
    // an admin holding an order number or a customer's email saw «مُفعَّل»
    // and a date and could not learn WHOSE account the device sits in
    // without already knowing its serial. The id travels here; the account
    // behind it is resolved by `adminUnitsWithAccounts` below.
    //
    // Gated on `admin` and nothing else: this same function answers GET
    // /mine, where a transferred device deliberately hides the buyer from
    // its later holder. A holder's identity is a fact about someone else.
    ...(opts.admin
      ? {
          registration: row.registered_at
            ? {
                user_id: row.reg_user_id ?? null,
                registered_at: row.registered_at,
                revoked_at: row.revoked_at ?? null,
              }
            : null,
        }
      : null),
    // The live warranty receipt for this unit, when one was issued: the
    // customer may open its public verification page and print it.
    receipt: row.receipt_no ? { receipt_no: row.receipt_no, status: row.receipt_status ?? 'active' } : null,
    open_claims: Number(row.open_claims ?? 0),
  };
}

const DEVICE_SELECT = `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
            u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
            u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id, u.created_at,
            r.registered_at, r.revoked_at, r.user_id AS reg_user_id, s.serial_raw,
            wr.receipt_no, wr.status AS receipt_status,
            (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.unit_id = u.id AND NOT (${CLOSED_CLAIM_SQL})) AS open_claims,
            oi.name_snapshot, oi.image_snapshot,
            p.slug, p.name AS p_name, p.name_ar AS p_name_ar, p.name_ku AS p_name_ku
       FROM order_item_units u
       LEFT JOIN device_registrations r ON r.unit_id = u.id
       LEFT JOIN device_serials s ON s.unit_id = u.id
       LEFT JOIN warranty_receipts wr ON wr.unit_id = u.id AND wr.status = 'active'
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
       LEFT JOIN products p ON p.id = u.product_id`;

/** Loads one unit with everything devicePublic needs, by unit id. */
async function loadDevice(db: D1Database, unitId: string): Promise<DeviceRow | null> {
  return db.prepare(`${DEVICE_SELECT} WHERE u.id = ?`).bind(unitId).first<DeviceRow>();
}

interface AdminAccount {
  id: string;
  email: string;
  username: string | null;
  name: string | null;
}

/** The house `IN (…)` chunk: D1 stops at 100 bound parameters, and 90 leaves
 *  the caller room for a bound value of its own. */
const ACCOUNT_IN_CHUNK = 90;

/**
 * The admin device payload, with the two accounts named: who BOUGHT the unit
 * and who HOLDS it now. One query for the whole page, not one per row.
 *
 * ADMIN ONLY, for the same reason `devicePublic` gates `registration`: these
 * are two people's identities, and the customer-facing branches of this file
 * must never carry them.
 *
 * `holder` is null for a revoked link — the row survives a release so the
 * unlink keeps a date, but a released device is held by nobody.
 */
async function adminUnitsWithAccounts(db: D1Database, rows: DeviceRow[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.owner_user_id, r.reg_user_id]).filter((x) => !!x))] as string[];
  /**
   * CHUNKED AT 90, because this list is TWO ids per unit and a page of units
   * is 200 (`/admin/units?email=` binds `LIMIT 200`, and the by-order branch
   * binds no LIMIT at all). D1 refuses more than 100 bound parameters in one
   * statement — worker/lib/customerNotify.ts states the rule and five call
   * sites already obey it — so a reseller whose 200 printers sit in 100+
   * different holders' accounts would otherwise 500 the admin search that
   * exists precisely to show who holds them.
   *
   * The suite cannot catch this: node:sqlite allows 999 variables. The
   * ceiling is D1's alone.
   */
  const people: AdminAccount[] = [];
  for (const part of chunk(ids, ACCOUNT_IN_CHUNK)) {
    const { results } = await db
      .prepare(`SELECT id, email, username, name FROM users WHERE id IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<AdminAccount>();
    people.push(...results);
  }
  const byId = new Map(people.map((x) => [x.id, x]));
  const person = (id: string | null | undefined): AdminAccount | null => (id ? byId.get(id) ?? null : null);
  return rows.map((r) => ({
    ...devicePublic(r, { admin: true }),
    buyer: person(r.owner_user_id),
    holder: r.reg_user_id && !r.revoked_at ? person(r.reg_user_id) : null,
  }));
}

/**
 * Binds a unit to the caller. The PRIMARY KEY on unit_id is the one-account
 * rule; the conditional UPDATE re-activates only the caller's own revoked
 * link, so a unit held by someone else is left exactly as it was — and the
 * re-read decides what the caller is told.
 */
async function bindUnit(db: D1Database, unitId: string, userId: string) {
  await db
    .prepare(
      `INSERT INTO device_registrations (unit_id, user_id) VALUES (?, ?)
       ON CONFLICT(unit_id) DO UPDATE SET user_id = excluded.user_id, registered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_at = NULL
         WHERE device_registrations.revoked_at IS NOT NULL OR device_registrations.user_id = excluded.user_id`
    )
    .bind(unitId, userId)
    .run();
  return db
    .prepare('SELECT user_id, registered_at, revoked_at FROM device_registrations WHERE unit_id = ?')
    .bind(unitId)
    .first<{ user_id: string; registered_at: string; revoked_at: string | null }>();
}

interface ClaimRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  order_item_id: string | null;
  unit_id: string | null;
  product_name: string;
  subject: string | null;
  description: string;
  status: string;
  stage: string | null;
  decision: string | null;
  decision_reason: string | null;
  admin_note: string;
  evidence: string | null;
  created_at: string;
  priority?: number | null;
  serial_raw?: string | null;
  email?: string | null;
  username?: string | null;
  /** 0111 — when the claimant last opened the thread. Absent before 0111. */
  customer_seen_at?: string | null;
  /** The thread's shape, on the list queries only (`CLAIM_THREAD_COLS`). */
  message_count?: number | null;
  last_message_at?: string | null;
  last_staff_message_at?: string | null;
  last_customer_message_at?: string | null;
}

/**
 * The thread's size and its last word from each side, per claim, for the
 * lists. Correlated subqueries on `claim_messages (claim_id, is_staff,
 * created_at)` (0111) — a list is at most a hundred claims, each a short
 * index range.
 */
const CLAIM_THREAD_COLS = `
            (SELECT COUNT(*) FROM claim_messages m WHERE m.claim_id = wc.id) AS message_count,
            (SELECT MAX(m.created_at) FROM claim_messages m WHERE m.claim_id = wc.id) AS last_message_at,
            (SELECT MAX(m.created_at) FROM claim_messages m WHERE m.claim_id = wc.id AND m.is_staff = 1) AS last_staff_message_at,
            (SELECT MAX(m.created_at) FROM claim_messages m WHERE m.claim_id = wc.id AND m.is_staff = 0) AS last_customer_message_at`;

/**
 * «رد جديد من الفريق» — the warranty team wrote after the customer last
 * looked. "Looked" is the later of two facts: the claimant opening the thread
 * (`customer_seen_at`, 0111) and the claimant writing in it, because answering
 * a message is proof of having read it. The second is what keeps a claim the
 * customer already replied to from lighting up just because the column is new
 * and every row reads NULL. ISO-8601 in one format on both sides, so the
 * strings compare in time order.
 */
export function claimHasUnreadStaffReply(row: Pick<ClaimRow, 'last_staff_message_at' | 'customer_seen_at' | 'last_customer_message_at'>): boolean {
  const staff = row.last_staff_message_at ?? '';
  if (!staff) return false;
  const seen = [row.customer_seen_at ?? '', row.last_customer_message_at ?? ''].reduce((a, b) => (a > b ? a : b), '');
  return staff > seen;
}

function claimPublic(row: ClaimRow, opts: { admin?: boolean } = {}) {
  const evidenceKeys = safeParse<unknown[]>(row.evidence, []).filter((k): k is string => typeof k === 'string');
  const thread =
    row.message_count === undefined
      ? null
      : {
          message_count: Number(row.message_count ?? 0),
          last_message_at: row.last_message_at ?? null,
          last_staff_message_at: row.last_staff_message_at ?? null,
          // The claimant's own unread marker. On the admin queue the same
          // fact reads the other way round — the customer spoke last — which
          // is what `awaiting_staff` says.
          ...(opts.admin
            ? { awaiting_staff: !!row.last_customer_message_at && (row.last_customer_message_at ?? '') > (row.last_staff_message_at ?? '') }
            : { unread: claimHasUnreadStaffReply(row) }),
        };
  return {
    id: row.id,
    unit_id: row.unit_id,
    order_item_id: row.order_item_id,
    subject: row.subject || row.product_name,
    product_name: row.product_name,
    description: row.description,
    stage: effectiveClaimStage(row.stage, row.status),
    legacy_status: row.status,
    decision: row.decision ?? null,
    decision_reason: row.decision_reason ?? '',
    admin_note: row.admin_note ?? '',
    evidence: evidenceKeys.map((key) => ({ key, url: `/api/devices/claim-files/${key}` })),
    created_at: row.created_at,
    priority: Number(row.priority ?? 0) === 1,
    serial: row.serial_raw ? (opts.admin ? row.serial_raw : maskSerial(row.serial_raw)) : null,
    ...(thread ?? {}),
    ...(opts.admin ? { user_id: row.user_id, email: row.email ?? null, username: row.username ?? null } : {}),
  };
}

/**
 * Work that must outlive the response — a customer notification — through
 * the guarded accessor. `c.executionCtx` throws in Hono when there is no
 * context (a test harness, a composed request); the promise is started first,
 * so it runs either way, and every function handed here is total.
 */
function afterResponse(c: Context<AppContext>, work: Promise<void>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No ExecutionContext on this path. The work is already in flight and
    // cannot reject; there is simply nothing to keep the isolate alive for.
  }
}

// ================================================================ customer

deviceRoutes.get('/mine', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `${DEVICE_SELECT}
      WHERE r.user_id = ? AND r.revoked_at IS NULL
      ORDER BY r.registered_at DESC
      LIMIT 100`
  )
    .bind(user.id)
    .all<DeviceRow>();
  const tier = await getTierStatus(c.env.DB, user.id);
  return c.json({
    success: true,
    devices: results.map((r) => ({ ...devicePublic(r, { viewerId: user.id }), transferred: r.owner_user_id !== user.id })),
    // The PRO membership's warranty perk: priority service on claims. Read
    // here so the page can say it without a second request.
    priority_service: benefits.priorityService(tier),
    tier: { tier: tier.tier, active: tier.active },
  });
});

/**
 * The caller's own delivered units that are not linked to any account — the
 * "add from my previous orders" list. A unit another account holds is shown
 * as such (the buyer knows they gave it away; nothing about the holder is
 * revealed) so the list does not silently omit a device they paid for.
 */
deviceRoutes.get('/eligible', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `${DEVICE_SELECT}
      WHERE u.owner_user_id = ? AND u.delivered_at IS NOT NULL AND u.replaced_by_unit_id IS NULL
        -- "not actively linked by me" — spelled out, because NOT (NULL = ?)
        -- is NULL in SQL and would drop every never-linked unit.
        AND (r.unit_id IS NULL OR r.revoked_at IS NOT NULL OR r.user_id <> ?)
      ORDER BY u.delivered_at DESC, u.unit_index ASC
      LIMIT 100`
  )
    .bind(user.id, user.id)
    .all<DeviceRow>();
  return c.json({
    success: true,
    units: results.map((r) => ({
      ...devicePublic(r),
      linked_elsewhere: !!(r.reg_user_id && r.reg_user_id !== user.id && !r.revoked_at),
    })),
  });
});

deviceRoutes.post('/register', async (c) => {
  // Two limits: per account (the signed-in customer) and per address, so a
  // stranger cannot rotate accounts to walk serials. Both answers are the
  // same 429; both are generous for a person typing their own devices.
  await rateLimit(c, 'serial-register', 10, 600);
  await rateLimit(c, 'serial-register-ip', 40, 600, rateLimitKey('serial-register-ip', null, c.req.header('CF-Connecting-IP') || 'unknown'));
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const input = str(body.serial, 'serial', { min: 4, max: 300 });

  // A receipt number (typed, or scanned off the receipt's QR link) names the
  // unit through its LIVE receipt; anything else is read as a serial.
  const receiptNo = receiptNoFrom(input);
  let unitId: string | null = null;
  let inventoryLinked = false;
  if (receiptNo) {
    const rec = await c.env.DB.prepare("SELECT unit_id FROM warranty_receipts WHERE receipt_no = ? AND status = 'active'")
      .bind(receiptNo)
      .first<{ unit_id: string | null }>();
    unitId = rec?.unit_id ?? null;
  } else {
    const norm = normalizeSerial(input);
    if (norm.length < 4) throw SERIAL_NO_MATCH();
    const ser = await c.env.DB.prepare('SELECT unit_id FROM device_serials WHERE serial_norm = ?').bind(norm).first<{ unit_id: string }>();
    unitId = ser?.unit_id ?? null;
    if (!unitId) {
      // Not on any unit yet: the serial inventory (0139) may know it — the
      // box the shop recorded before the sale. It attaches the serial to the
      // CALLER'S OWN delivered unit of that product, or refuses; a box SN
      // resolves to its product serial. Every refusal reads as the one answer
      // below; the reason is kept for the manual review the page offers.
      const inv = await linkFromInventory(c.env.DB, user.id, norm);
      if (inv.kind === 'attached') {
        inventoryLinked = true;
        unitId = inv.unit_id;
        await audit(c.env.DB, user.id, 'device.serial_assign', inv.unit_id, { by: 'inventory', serial_norm: inv.serial_norm });
      } else if (inv.kind === 'resolved') {
        unitId = inv.unit_id;
      } else if (inv.serial_norm) {
        await audit(c.env.DB, user.id, 'serial_inventory.link_refused', inv.serial_norm, { reason: inv.reason });
      }
    }
  }
  // The same database work whether or not a unit matched, so a foreign serial
  // that exists and one that does not take the same time to refuse.
  const row = await loadDevice(c.env.DB, unitId ?? '');

  // Unknown, undelivered, replaced, held by another account, OR never released
  // by its buyer → the SAME answer. The holder, the buyer and the order are
  // never revealed.
  if (!unitId || !row || !row.delivered_at || row.replaced_by_unit_id) throw SERIAL_NO_MATCH();
  // A device that was never linked belongs to the account that bought it. A
  // stranger may take a device only after its holder — or an admin — RELEASED
  // it (a revoked registration), which is the transfer the owner described.
  // Receipt numbers are sequential and serials follow factory patterns, so a
  // typed number alone must never be enough to take a device its buyer never
  // let go of, nor to read the buyer's receipt through it.
  const released = !!row.reg_user_id && !!row.revoked_at;
  if (row.owner_user_id !== user.id && !released) throw SERIAL_NO_MATCH();
  if (row.reg_user_id && row.reg_user_id !== user.id && !row.revoked_at) throw SERIAL_NO_MATCH();

  // Idempotent. Registration NEVER touches warranty dates: an expired device
  // registers with an honest expired state, a duplicate registration returns
  // the existing one, and a device whose previous holder unlinked it is
  // linked to its new holder — the transfer the owner asked for.
  const alreadyMine = row.reg_user_id === user.id && !row.revoked_at;
  const reg = await bindUnit(c.env.DB, row.id, user.id);
  if (!reg || reg.user_id !== user.id || reg.revoked_at) throw SERIAL_NO_MATCH();
  if (!alreadyMine) {
    await audit(c.env.DB, user.id, 'device.register', row.id, {
      by: receiptNo ? 'receipt' : inventoryLinked ? 'inventory' : 'serial',
      transferred: row.owner_user_id !== user.id,
    });
  }

  const fresh = (await loadDevice(c.env.DB, row.id)) ?? row;
  return c.json({
    success: true,
    device: { ...devicePublic(fresh, { viewerId: user.id }), transferred: fresh.owner_user_id !== user.id },
    already_registered: alreadyMine,
  });
});

/** Link one of the caller's OWN delivered units without typing its serial. */
deviceRoutes.post('/units/:unitId/register', async (c) => {
  await rateLimit(c, 'unit-register', 30, 600);
  const user = c.get('user')!;
  const row = await loadDevice(c.env.DB, c.req.param('unitId'));
  // Only the buyer may use this path: the unit id came from their own list.
  if (!row || row.owner_user_id !== user.id) throw notFound('Device not found on your account');
  if (!row.delivered_at) throw badRequest('This device is not delivered yet — it can be linked after delivery', 'NOT_DELIVERED');
  if (row.replaced_by_unit_id) throw badRequest('This device was replaced — the replacement carries the coverage', 'UNIT_REPLACED');
  if (row.reg_user_id && row.reg_user_id !== user.id && !row.revoked_at) {
    // The buyer already knows this device exists; saying WHY it cannot be
    // linked is honest, and still names nobody.
    throw conflict('This device is linked to another account. That account must unlink it first, or support can.', 'LINKED_ELSEWHERE');
  }
  const alreadyMine = row.reg_user_id === user.id && !row.revoked_at;
  const reg = await bindUnit(c.env.DB, row.id, user.id);
  if (!reg || reg.user_id !== user.id || reg.revoked_at) throw conflict('This device is linked to another account.', 'LINKED_ELSEWHERE');
  if (!alreadyMine) await audit(c.env.DB, user.id, 'device.register', row.id, { by: 'order' });
  const fresh = (await loadDevice(c.env.DB, row.id)) ?? row;
  return c.json({ success: true, device: { ...devicePublic(fresh), transferred: false }, already_registered: alreadyMine });
});

/**
 * Unlink — the step before a transfer. Only the account that holds the
 * device may do it, and not while a claim on it is still open: a claim is a
 * conversation about THIS holder's device, and handing the device on
 * mid-claim would leave it about nobody's.
 */
deviceRoutes.delete('/units/:unitId/registration', async (c) => {
  const user = c.get('user')!;
  const row = await loadDevice(c.env.DB, c.req.param('unitId'));
  if (!row || row.reg_user_id !== user.id || row.revoked_at) throw notFound('Device not found on your account');
  if (Number(row.open_claims ?? 0) > 0) {
    throw conflict('This device has an open warranty claim — it can be unlinked once the claim is closed', 'CLAIM_OPEN');
  }
  const res = await c.env.DB.prepare(
    `UPDATE device_registrations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE unit_id = ? AND user_id = ? AND revoked_at IS NULL`
  )
    .bind(row.id, user.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Device not found on your account');
  await audit(c.env.DB, user.id, 'device.unregister', row.id, { by: 'holder' });
  return c.json({ success: true });
});

// ----------------------------------------------------------------- claims

/**
 * «مطالباتي». Each claim carries its thread's size and whether the warranty
 * team wrote since the customer last looked, so the card can SAY that tapping
 * it opens a conversation and that a new answer is waiting in it — the owner
 * found neither: «لا يوجد هنالك توضيح أو زر معين يظهر أن عند الضغط على
 * مطالباتي … تفتح المحادثة».
 */
deviceRoutes.get('/claims', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT wc.*, s.serial_raw,${CLAIM_THREAD_COLS}
       FROM warranty_claims wc
       LEFT JOIN device_serials s ON s.unit_id = wc.unit_id
      WHERE wc.user_id = ?
      ORDER BY wc.created_at DESC
      LIMIT 100`
  )
    .bind(user.id)
    .all<ClaimRow>();
  return c.json({ success: true, claims: results.map((r) => claimPublic(r)) });
});

async function loadClaimAuthorized(c: Context<AppContext>, claimId: string) {
  const user = c.get('user')!;
  const claim = await c.env.DB.prepare(
    `SELECT wc.*, s.serial_raw, u.email, u.username
       FROM warranty_claims wc
       LEFT JOIN device_serials s ON s.unit_id = wc.unit_id
       LEFT JOIN users u ON u.id = wc.user_id
      WHERE wc.id = ?`
  )
    .bind(claimId)
    .first<ClaimRow>();
  if (!claim) throw notFound('Claim not found');
  if (claim.user_id !== user.id && user.role !== 'admin') throw notFound('Claim not found');
  return { claim, isAdmin: user.role === 'admin' };
}

deviceRoutes.get('/claims/:id', async (c) => {
  const { claim, isAdmin } = await loadClaimAuthorized(c, c.req.param('id'));
  // Stamped BEFORE the thread is read, so a staff message that lands while
  // this request is in flight is later than the stamp and stays «جديد».
  const seenAt = new Date().toISOString();
  const [{ results: messages }, unit] = await Promise.all([
    c.env.DB.prepare('SELECT id, sender_id, is_staff, body, file_key, created_at FROM claim_messages WHERE claim_id = ? ORDER BY created_at ASC LIMIT 500')
      .bind(claim.id)
      .all<Record<string, unknown>>(),
    claim.unit_id
      ? c.env.DB.prepare(`SELECT ${UNIT_COLS} FROM order_item_units WHERE id = ?`).bind(claim.unit_id).first<UnitRow>()
      : Promise.resolve(null),
  ]);
  const cov = unit ? coverageState(unit.delivered_at, unit.warranty_end_at) : null;
  /**
   * THE CLAIMANT HAS NOW SEEN THE THREAD — the read marker behind «رد جديد من
   * الفريق» on the claim card (0111). Only the claimant: an admin opening a
   * customer's thread is not the customer reading it.
   *
   * Contained: a database a deploy reached before 0111 has no such column,
   * and the one thing that must not happen is a customer being unable to
   * open their own claim because a badge could not be cleared.
   */
  if (claim.user_id === c.get('user')!.id) {
    try {
      await c.env.DB.prepare('UPDATE warranty_claims SET customer_seen_at = ? WHERE id = ?').bind(seenAt, claim.id).run();
    } catch (e) {
      console.error('claim seen marker not written for', claim.id, e instanceof Error ? e.message : String(e));
    }
  }
  return c.json({
    success: true,
    claim: claimPublic(claim, { admin: isAdmin }),
    // Authorized warranty facts attached automatically — read from the unit,
    // never from client input.
    warranty_facts: unit
      ? {
          // The buyer's order id is the buyer's (and the admin's) to see; a
          // later holder gets the coverage facts alone.
          order_id: isAdmin || unit.owner_user_id === c.get('user')!.id ? unit.order_id : null,
          delivered_at: unit.delivered_at,
          warranty_end_at: unit.warranty_end_at,
          state: cov!.state,
          remaining_days: cov!.remaining_days,
        }
      : null,
    messages: messages.map((m) => ({
      id: m.id,
      is_staff: !!m.is_staff,
      mine: m.sender_id === c.get('user')!.id,
      body: m.body,
      file_url: typeof m.file_key === 'string' && m.file_key ? `/api/devices/claim-files/${m.file_key}` : null,
      created_at: m.created_at,
      ...(isAdmin ? { sender_id: m.sender_id } : {}),
    })),
  });
});

deviceRoutes.post('/units/:unitId/claims', async (c) => {
  await rateLimit(c, 'claim-create', 10, 3600);
  const user = c.get('user')!;
  const unitId = c.req.param('unitId');
  const body = await c.req.json().catch(() => ({}));
  const subject = str(body.subject, 'subject', { min: 3, max: 200 });
  const description = str(body.description, 'description', { min: 10, max: 5000 });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80, required: false });

  const unit = await c.env.DB.prepare(
    `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
            u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
            u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id, u.created_at,
            r.revoked_at AS reg_revoked, r.user_id AS reg_user,
            oi.name_snapshot, p.name AS p_name, p.name_ar AS p_name_ar
       FROM order_item_units u
       LEFT JOIN device_registrations r ON r.unit_id = u.id
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
       LEFT JOIN products p ON p.id = u.product_id
      WHERE u.id = ?`
  )
    .bind(unitId)
    .first<UnitRow & { reg_revoked: string | null; reg_user: string | null; name_snapshot: string | null; p_name: string | null; p_name_ar: string | null }>();
  // The account that HOLDS the device (its active registration) may claim on
  // it; the buyer who has not linked it yet is told to link it first; anyone
  // else sees nothing.
  const holds = !!unit && unit.reg_user === user.id && !unit.reg_revoked;
  if (!unit || (!holds && unit.owner_user_id !== user.id)) throw notFound('Device not found on your account');
  if (!holds) {
    throw badRequest('Register this device first (Warranty → Add device), then open the claim from it.', 'NOT_REGISTERED');
  }
  // PRO priority service, snapshotted at creation exactly as support tickets
  // do — the one warranty perk the membership carries.
  const priority = benefits.priorityService(await getTierStatus(c.env.DB, user.id)) ? 1 : 0;

  // Private attachment keys uploaded through POST /claims/upload only.
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > 6) throw badRequest('At most 6 attachments per claim');
  const attachments: string[] = [];
  for (const k of rawAttachments) {
    if (typeof k !== 'string' || !k.startsWith(`claims/${user.id}/`) || k.includes('..') || k.length > 200) {
      throw badRequest('Invalid attachment reference');
    }
    attachments.push(k);
  }

  /**
   * ONE PRESS, ONE CLAIM — «مطالبة الضمان … وتتكرر عند إعادة الإرسال».
   *
   * THE SAME DEFECT AS THE GENERAL CLAIM, AND THE SAME FIX. The reasoning is
   * written out in full at POST /warranty-claims in worker/routes/profile.ts
   * and is not repeated here; what matters is that this route — the FORMAL
   * claim, the one with stages and evidence — was left with none of it.
   * `rateLimit` above permits ten claims an hour, which is a flood limit and
   * not an identity, and the overlay's own `if (busy) return` only blocks a
   * second press while the first request is still in flight. A customer whose
   * POST appeared to fail pressed send again, which is the reasonable thing to
   * do, and got two claims and two conversations about one broken printer.
   *
   * SCOPED BY USER, INSIDE THE ID ITSELF. The id is DERIVED — `wc_` plus the
   * first 20 hex digits of SHA-256 over the caller's id and the key — so the
   * caller's own id is part of the preimage and this table's PRIMARY KEY
   * already IS the per-user unique index migration 0064's guarantee requires.
   * Two accounts carrying an identical key land on two different rows. NEVER
   * hash the key on its own: that is the global uniqueness 0064 exists to
   * remove, rebuilt by hand.
   *
   * THE RACE IS CLOSED BY THE DATABASE. `ON CONFLICT(id) DO NOTHING` plus
   * `meta.changes === 0` is the entire test, so two taps that arrive in the
   * same instant cannot both win, and unlike a match on the text «UNIQUE» it
   * cannot be confused by some other constraint on the same statement.
   *
   * THE KEY IS OPTIONAL, which is a deployment fact rather than a choice: a
   * caller that sends none keeps the old random id and the old behaviour, and
   * requiring it would 400 every browser still running the page it shipped
   * with. The other half lives in the overlay — mint ONE key per OPEN of the
   * form, never per mount — because a key that outlives the overlay would
   * replay the first claim instead of recording a genuine SECOND claim on the
   * same printer, which is worse than the duplicate it removes.
   *
   * WHAT A REPLAY COSTS, SAID PLAINLY. The stored claim wins: the `subject`,
   * `description` and `attachments` on the retry are NOT written over it. That
   * is the right trade — the alternative is a request that can rewrite a claim
   * staff may already have read, replied to and moved a stage on, from a form
   * the customer thinks failed — but it is a real cost and it has a shape. The
   * customer whose POST committed while their own 20-second deadline fired
   * sees «خطأ في الشبكة», adds the photo of the cracked nozzle they forgot,
   * presses «إرسال» again, and the claim staff open carries neither the photo
   * nor the corrected text while src/components/warranty/ClaimForms.tsx reads
   * the 200 as a submit and closes the form. `replay: true` is on the response
   * so the overlay can say so, and it is the overlay's job to say it; the
   * orphaned `claims/<uid>/…` objects are swept with every other unreferenced
   * upload. EDITING A FILED CLAIM IS A DIFFERENT DOOR and does not exist yet —
   * the reply thread is where a customer adds what they forgot.
   */
  const id = idempotencyKey
    ? `wc_${(await sha256Hex(`${user.id}\n${idempotencyKey}`)).slice(0, 20)}`
    : newId('wc');
  const productName = String(unit.name_snapshot || unit.p_name_ar || unit.p_name || 'Device');
  const written = await c.env.DB.prepare(
    `INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, subject, evidence, stage, status, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 'submitted', ?) ON CONFLICT(id) DO NOTHING`
  )
    .bind(id, user.id, unit.order_item_id, productName, description, unit.id, subject, JSON.stringify(attachments), priority)
    .run();

  // The coverage the customer is shown is read from the unit, so it is the
  // same answer on a first submit and on a replay of it.
  const cov = coverageState(unit.delivered_at, unit.warranty_end_at);
  const warrantyFacts = {
    // The buyer's order id is the buyer's to see; a later holder gets the
    // coverage facts alone.
    order_id: unit.owner_user_id === user.id ? unit.order_id : null,
    delivered_at: unit.delivered_at,
    warranty_end_at: unit.warranty_end_at,
    state: cov.state,
    remaining_days: cov.remaining_days,
  };

  /**
   * A REPLAY IS SILENT, AND IT RETURNS BEFORE THE ANNOUNCE BELOW. The customer
   * is shown the claim they already have, carrying the stage and the priority
   * actually stored on it rather than a hard-coded 'received' — by the time
   * they retry, staff may already have moved it on.
   */
  if (written.meta.changes === 0) {
    const existing = await c.env.DB.prepare(
      'SELECT id, stage, priority FROM warranty_claims WHERE id = ? AND user_id = ? AND unit_id = ?'
    )
      .bind(id, user.id, unit.id)
      .first<{ id: string; stage: string; priority: number }>();
    /**
     * The replay lookup is scoped by user as well as by id, and this arm is
     * what that scoping is FOR. A derived id taken by a row that is not this
     * caller's is an 80-bit second preimage — not reachable by chance and not
     * reachable by search. It says so with its own code instead of quietly
     * retrying under a random id, because a guard that silently stops guarding
     * is how the duplicate comes back, and instead of returning the row,
     * because returning it would hand one customer another customer's claim.
     *
     * AND BY UNIT, WHICH IS NOT THE SAME QUESTION. The id's preimage is the
     * caller and the key, deliberately: one open of the form is one claim,
     * whatever the customer edits in it before pressing send. The URL's
     * `:unitId` is therefore NOT in the id, so one key posted at two different
     * units lands on the row the first post recorded — and `warrantyFacts`
     * just above is read from the unit in THIS URL. Without this clause the
     * response would carry unit A's claim id and stage beside unit B's
     * `order_id`, `delivered_at`, `warranty_end_at` and `remaining_days`, and
     * the overlay would draw that mixture as one printer's coverage. Today's
     * overlay reseeds its key whenever `unitId` changes so it cannot happen;
     * a guard that depends on a client staying written that way is not a
     * guard. A key reused across units is a caller bug, not a replay, so it
     * gets the collision refusal below rather than a mixed answer.
     */
    if (!existing) throw conflict('That claim could not be recorded; please try again', 'CLAIM_KEY_COLLISION');
    return c.json({
      success: true,
      id: existing.id,
      stage: existing.stage,
      priority: existing.priority === 1,
      replay: true,
      warranty_facts: warrantyFacts,
    });
  }

  /**
   * «تذاكر الضمان» — THE THING THE OWNER ASKED FOR BY NAME, AND THE ONE
   * EVENT THAT WAS STILL TELLING NOBODY.
   *
   * A support ticket that happens to carry a `unit_id` already reaches
   * «🔥 Warranty support». This is the FORMAL claim — a `warranty_claims` row
   * with stages, a decision and up to six pieces of private evidence — and it
   * reached the group by no path at all: it sat in `stage='received'` until
   * somebody happened to open the admin queue. A claim is the customer saying
   * a machine they paid for has stopped working, which is the one message that
   * must not wait for a page refresh.
   *
   * WHAT IS IN IT. The claim id, the device and product it is about, whether
   * PRO priority reorders the queue, and the subject clipped to one lock-screen
   * line. NOT the description and NOT the evidence keys: the description is up
   * to 5000 characters the customer wrote to support, and the attachments are
   * owner-scoped private R2 objects (`claims/<uid>/…`) whose whole point is
   * that they are served only through the authorized route. A key pasted into a
   * group chat is a key in everyone's screenshot.
   *
   * ONLY ON A GENUINE INSERT, WHICH IS WHY IT SITS BELOW THE REPLAY RETURN AND
   * NOT ABOVE THE INSERT. A replayed double-tap returned above without
   * reaching this line; announcing before that return would put two identical
   * messages in the owner's group for the one claim the replay guard exists to
   * collapse — the duplicate moved from the admin queue into Telegram rather
   * than removed.
   *
   * Contained and after the response: the claim row has committed, and an
   * unreachable Telegram must never turn it into an error for a customer whose
   * printer is already broken.
   */
  announceAfterResponse(
    c,
    'warranty',
    `🔥 Warranty claim ${id}` +
      `\nSubject: ${subject.slice(0, 120)}` +
      (priority ? '\nPriority: PRO' : '') +
      `\nProduct: ${productName.slice(0, 80)}` +
      `\nDevice: ${unit.id}` +
      `\nAttachments: ${attachments.length}`
  );

  return c.json({ success: true, id, stage: 'received', priority: priority === 1, warranty_facts: warrantyFacts });
});

deviceRoutes.post('/claims/:id/messages', async (c) => {
  await rateLimit(c, 'claim-msg', 60, 3600);
  const user = c.get('user')!;
  const { claim, isAdmin } = await loadClaimAuthorized(c, c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const text = str(body.body, 'body', { max: 3000, required: false });
  let fileKey: string | null = null;
  if (body.file_key !== undefined && body.file_key !== null && body.file_key !== '') {
    const k = str(body.file_key, 'file_key', { max: 200 });
    if (!k.startsWith(`claims/${user.id}/`) || k.includes('..')) throw badRequest('Invalid attachment reference');
    fileKey = k;
  }
  if (!text && !fileKey) throw badRequest('Write a message or attach a file');

  const id = newId('cm');
  // Stamped here rather than by the column default so the row this answers
  // with is the row that was stored, to the millisecond, and the thread can
  // append it instead of reloading itself.
  const createdAt = new Date().toISOString();
  await c.env.DB.prepare(
    'INSERT INTO claim_messages (id, claim_id, sender_id, is_staff, body, file_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, claim.id, user.id, isAdmin ? 1 : 0, text, fileKey, createdAt)
    .run();
  /**
   * THE CUSTOMER'S SIDE OF THE CLAIM THREAD ONLY.
   *
   * `isAdmin` is already resolved above by `loadClaimAuthorized`, and it is the
   * whole guard: telling the staff group what a member of the staff group just
   * typed is noise, and a topic that fills with noise is a topic the owner
   * mutes — which is the failure the topics were opened to end. This fires when
   * the customer adds evidence or answers a question, which is the half of the
   * thread staff are waiting on.
   *
   * The BODY and the attachment key stay out, for the same reason they stay out
   * of the opening message: the customer wrote to support, not to a group, and
   * the file key is a private R2 path.
   */
  if (!isAdmin) {
    announceAfterResponse(
      c,
      'warranty',
      `🔥 Customer replied on warranty claim ${claim.id}` +
        (fileKey ? '\nA file is attached' : '')
    );
  }
  /**
   * AND THE STAFF SIDE REACHES THE CUSTOMER — «ولا يرسل الإشعار إلى المستخدم
   * بأن هناك رسالة جديدة تخص الضمان».
   *
   * The block above was the only notification this thread ever had, and it
   * points one way: the owner's group heard every customer message, and a
   * staff answer went into `claim_messages` and reached the customer by no
   * path at all. `notifyClaimReply` writes the bell row (linked to
   * `/warranty?claim=…`, which opens this thread) and fans out to whatever
   * channel reaches them, keyed on THIS message so a second answer is a
   * second message.
   *
   * `claim.user_id !== user.id`: an admin writing on a claim they filed
   * themselves is not news to anyone.
   */
  if (isAdmin && claim.user_id !== user.id) {
    afterResponse(c, notifyClaimReply(c.env, claim.id, id));
  }
  return c.json({
    success: true,
    id,
    message: {
      id,
      is_staff: isAdmin,
      mine: true,
      body: text,
      file_url: fileKey ? `/api/devices/claim-files/${fileKey}` : null,
      created_at: createdAt,
    },
  });
});

// Private claim attachments (photo/video). Same owner-scoped R2 pattern as
// receipts (worker/routes/uploads.ts) under the claims/<uid>/ prefix; served
// only through the authorized route below — never via a public R2 path.
const CLAIM_IMAGE_MAX = 8 * 1024 * 1024;
const CLAIM_VIDEO_MAX = 40 * 1024 * 1024;

deviceRoutes.post('/claims/upload', async (c) => {
  await rateLimit(c, 'claim-upload', 30, 3600);
  const user = c.get('user')!;
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  if (file.size > CLAIM_VIDEO_MAX) throw badRequest('File is too large (max 40 MB)');

  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind) throw badRequest('Unsupported file type — upload a JPEG, PNG, WebP, GIF image or MP4 video');
  if (!kind.mime.startsWith('video/') && file.size > CLAIM_IMAGE_MAX) {
    throw badRequest('Image is too large (max 8 MB)');
  }

  /**
   * THROUGH THE ONE DOOR. `claims/<userId>/<id>.jpg`, hand-built, unconverted
   * — a warranty claim is photographed by a customer holding a broken printer,
   * so these are full-resolution camera files, and an admin opening a claim
   * downloaded every megabyte of them.
   *
   * A video passes through untouched, because a transform keeps one frame and
   * the whole point of a claim video is the thing that happens over time.
   */
  const isVideo = kind.mime.startsWith('video/');
  const stored = await storeMedia(c.env, {
    placement: {
      visibility: 'private',
      domain: 'claims',
      entityId: user.id,
      kind: isVideo ? 'video' : 'photos',
      objectId: newId(),
    },
    bytes: buf,
    mime: kind.mime,
    ownerId: user.id,
    originalName: file.name,
    cacheControl: 'private, max-age=300',
  });
  return c.json({ success: true, key: stored.key, url: `/api/devices/claim-files/${stored.key}` });
});

deviceRoutes.get('/claim-files/*', async (c) => {
  const user = c.get('user')!;
  const key = c.req.path.replace(/^\/api\/devices\/claim-files\//, '');
  if (!key.startsWith('claims/') || key.includes('..')) throw notFound();

  const isOwnPrefix = key.startsWith(`claims/${user.id}/`);
  if (!isOwnPrefix && user.role !== 'admin') {
    // A customer may also view staff-uploaded attachments on THEIR claim.
    const viaMessage = await c.env.DB.prepare(
      `SELECT 1 AS x FROM claim_messages m JOIN warranty_claims wc ON wc.id = m.claim_id
        WHERE m.file_key = ? AND wc.user_id = ? LIMIT 1`
    )
      .bind(key, user.id)
      .first();
    if (!viaMessage) throw forbidden('Not your file');
  }

  const obj = await getMediaObject(c.env, 'private', key);
  if (!obj) throw notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(obj.body, { headers });
});

// ================================================================ admin

deviceRoutes.get('/admin/orders/:orderId/units', async (c) => {
  const orderId = c.req.param('orderId');
  const order = await c.env.DB.prepare(
    'SELECT o.id, o.user_id, o.status, o.delivered_at, u.email, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?'
  )
    .bind(orderId)
    .first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');

  const [{ results: items }, { results: units }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT oi.id, oi.product_id, oi.name_snapshot, oi.qty, oi.warranty_snapshot, p.ops_policy
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?`
    )
      .bind(orderId)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
              u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
              u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id, u.created_at,
              s.serial_raw, r.registered_at, r.revoked_at, r.user_id AS reg_user_id,
              oi.name_snapshot, oi.image_snapshot
         FROM order_item_units u
         LEFT JOIN device_serials s ON s.unit_id = u.id
         LEFT JOIN device_registrations r ON r.unit_id = u.id
         LEFT JOIN order_items oi ON oi.id = u.order_item_id
        WHERE u.order_id = ?
        ORDER BY u.order_item_id, u.unit_index`
    )
      .bind(orderId)
      .all<DeviceRow>(),
  ]);
  const printerIds = await printerProductIds(
    c.env.DB,
    items.map((it) => String(it.product_id ?? ''))
  );

  return c.json({
    success: true,
    order: {
      id: order.id,
      user_id: order.user_id,
      email: order.email ?? null,
      username: order.username ?? null,
      status: order.status,
      delivered_at: order.delivered_at ?? null,
    },
    items: items.map((it) => {
      // The policy AS THE DELIVERY HOOK READS IT (worker/lib/deviceOps.ts): a
      // printer is serialized with a 12-month base unless the owner said
      // otherwise, so this screen never shows "not serialized" for an item
      // whose delivery will create units.
      const policy = effectiveDevicePolicy(it.ops_policy, printerIds.has(String(it.product_id ?? '')));
      const snap = safeParse<WarrantySnapshotLite | null>(it.warranty_snapshot, null);
      return {
        id: it.id,
        name: it.name_snapshot,
        qty: it.qty,
        serialized: policy.serialized,
        base_months: policy.warranty_base_months,
        warranty_plan: snap ? { plan_id: snap.plan_id ?? null, duration_months: snap.duration_months ?? null, duration_kind: snap.duration_kind ?? null } : null,
      };
    }),
    units: await adminUnitsWithAccounts(c.env.DB, units),
  });
});

deviceRoutes.get('/admin/units', async (c) => {
  const q = c.req.query();
  const email = str(q.email, 'email', { max: 320, required: false });
  const userId = str(q.user_id, 'user_id', { max: 60, required: false });
  const serial = str(q.serial, 'serial', { max: 300, required: false });
  if (!email && !userId && !serial) throw badRequest('Provide email, user_id or serial');
  if (serial) {
    // One identifier — a serial, a receipt number or the receipt's QR link —
    // resolves to the unit it names, with who bought it and who holds it.
    const receiptNo = receiptNoFrom(serial);
    const unitRow = receiptNo
      ? await c.env.DB.prepare('SELECT unit_id FROM warranty_receipts WHERE receipt_no = ?').bind(receiptNo).first<{ unit_id: string | null }>()
      : await c.env.DB.prepare('SELECT unit_id FROM device_serials WHERE serial_norm = ?').bind(normalizeSerial(serial)).first<{ unit_id: string }>();
    const row = unitRow?.unit_id ? await loadDevice(c.env.DB, unitRow.unit_id) : null;
    if (!row) return c.json({ success: true, units: [] });
    return c.json({ success: true, units: await adminUnitsWithAccounts(c.env.DB, [row]) });
  }
  let ownerId = userId;
  if (!ownerId) {
    const u = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first<{ id: string }>();
    if (!u) return c.json({ success: true, units: [] });
    ownerId = u.id;
  }
  /**
   * A CUSTOMER'S DEVICES ARE THE ONES THEY BOUGHT AND THE ONES THEY HOLD.
   *
   * This read `WHERE u.owner_user_id = ?` alone, so the admin who typed the
   * email of the person on the phone — a second-hand holder the buyer handed
   * the printer to — got an empty table, while the same device answered to
   * the BUYER's email. The holder is exactly the customer who calls about a
   * device; a revoked link is not holding it.
   */
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
            u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
            u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id, u.created_at,
            s.serial_raw, r.registered_at, r.revoked_at, r.user_id AS reg_user_id,
            oi.name_snapshot, oi.image_snapshot
       FROM order_item_units u
       LEFT JOIN device_serials s ON s.unit_id = u.id
       LEFT JOIN device_registrations r ON r.unit_id = u.id
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
      WHERE u.owner_user_id = ?1 OR (r.user_id = ?1 AND r.revoked_at IS NULL)
      ORDER BY u.created_at DESC LIMIT 200`
  )
    .bind(ownerId)
    .all<DeviceRow>();
  return c.json({ success: true, units: await adminUnitsWithAccounts(c.env.DB, results) });
});

/**
 * «مَن غيّر ومتى» — EVERY RECORDED CHANGE TO ONE DEVICE, WITH WHO MADE IT.
 *
 * Every mutation on a unit has written an `audit_log` row since these routes
 * existed — the duration lever (`device.unit_warranty_months`) with the old
 * and new months, the old and new end and the reason; the delivery
 * correction; serial assignment and reassignment; replacement; link and
 * unlink — and no route ever read one back. The admin who changed a warranty
 * could not show anyone that they had, and the next admin could not see that
 * anybody had. Same shape as a receipt's history (worker/routes/warranty.ts),
 * joined to the actor so the screen names a person, not an id. A customer's
 * own link or unlink appears too, under their account: that is who did it.
 */
deviceRoutes.get('/admin/units/:unitId/history', async (c) => {
  const unitId = c.req.param('unitId');
  const unit = await c.env.DB.prepare('SELECT id FROM order_item_units WHERE id = ?').bind(unitId).first<{ id: string }>();
  if (!unit) throw notFound('Unit not found');
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.detail, a.created_at, a.actor_id, u.username, u.email, u.name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.target = ? AND a.action LIKE 'device.%'
      ORDER BY a.created_at DESC, a.id DESC LIMIT 100`
  )
    .bind(unitId)
    .all<Record<string, unknown>>();
  return c.json({
    success: true,
    history: results.map((h) => ({
      id: h.id,
      action: h.action,
      created_at: h.created_at,
      actor: h.actor_id
        ? { id: h.actor_id, email: h.email ?? null, username: h.username ?? null, name: h.name ?? null }
        : null,
      detail: safeParse<Record<string, unknown>>(h.detail, {}),
    })),
  });
});

/**
 * Admin unlink — for a customer who lost access to the account that holds
 * the device, or a dispute. Reason required and audited; the device is then
 * free to be linked by whoever holds it.
 */
deviceRoutes.post('/admin/units/:unitId/unregister', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });
  const row = await loadDevice(c.env.DB, c.req.param('unitId'));
  if (!row) throw notFound('Unit not found');
  if (!row.reg_user_id || row.revoked_at) throw conflict('This device is not linked to any account', 'NOT_LINKED');
  await c.env.DB.prepare(
    `UPDATE device_registrations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE unit_id = ? AND revoked_at IS NULL`
  )
    .bind(row.id)
    .run();
  await audit(c.env.DB, admin.id, 'device.unregister', row.id, { by: 'admin', from_user_id: row.reg_user_id, reason });
  return c.json({ success: true, unlinked_from_user_id: row.reg_user_id });
});

deviceRoutes.post('/admin/orders/:orderId/units/backfill', async (c) => {
  const admin = c.get('user')!;
  const orderId = c.req.param('orderId');
  const order = await c.env.DB.prepare('SELECT id, status, delivered_at FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; status: string; delivered_at: string | null }>();
  if (!order) throw notFound('Order not found');
  if (order.status !== 'delivered' || !order.delivered_at) {
    throw badRequest('Units are created from the recorded delivery — this order is not delivered yet');
  }
  const result = await createUnitsOnDelivery(c.env, orderId, order.delivered_at);
  await audit(c.env.DB, admin.id, 'device.units_backfill', orderId, result as unknown as Record<string, unknown>);
  return c.json({ success: true, ...result });
});

// The whole history at once: printer orders the courier delivered before its
// door created units (deviceOps.sweepDeliveredOrdersWithoutUnits). The cron runs
// the same pass every tick; this is the button for «now», and it reports
// `has_more` so a large backlog is finished by pressing again.
deviceRoutes.post('/admin/units/backfill-delivered', async (c) => {
  const admin = c.get('user')!;
  const limit = 200;
  const result = await sweepDeliveredOrdersWithoutUnits(c.env, limit);
  await audit(c.env.DB, admin.id, 'device.units_backfill_delivered', 'orders', result as unknown as Record<string, unknown>);
  return c.json({ success: true, ...result, has_more: result.scanned >= limit });
});

// -------------------------------------------------------- serial assignment

deviceRoutes.post('/admin/units/:unitId/serial', async (c) => {
  const admin = c.get('user')!;
  const unitId = c.req.param('unitId');
  const body = await c.req.json().catch(() => ({}));
  const serialRaw = str(body.serial, 'serial', { min: 4, max: 80 });
  const norm = normalizeSerial(serialRaw);
  if (norm.length < 4) throw badRequest('Serial is too short after normalization');
  const reassign = body.reassign === true;
  const reason = str(body.reason, 'reason', { max: 500, required: false });

  const unit = await c.env.DB.prepare(`SELECT ${UNIT_COLS} FROM order_item_units WHERE id = ?`)
    .bind(unitId)
    .first<UnitRow>();
  if (!unit) throw notFound('Unit not found');

  const [bySerial, byUnit] = await Promise.all([
    c.env.DB.prepare('SELECT serial_norm, serial_raw, unit_id FROM device_serials WHERE serial_norm = ?')
      .bind(norm)
      .first<{ serial_norm: string; serial_raw: string; unit_id: string }>(),
    c.env.DB.prepare('SELECT serial_norm, serial_raw, unit_id FROM device_serials WHERE unit_id = ?')
      .bind(unitId)
      .first<{ serial_norm: string; serial_raw: string; unit_id: string }>(),
  ]);

  if (bySerial && bySerial.unit_id === unitId) {
    return c.json({ success: true, serial: bySerial.serial_raw, unchanged: true });
  }

  const conflicting = !!bySerial || !!byUnit;
  if (conflicting && !reassign) {
    throw new HttpError(
      409,
      bySerial
        ? 'This serial is already assigned to another unit. Repeat with the explicit reassign flag and a reason to move it.'
        : 'This unit already has a serial. Repeat with the explicit reassign flag and a reason to change it.',
      'REASSIGN_REQUIRED'
    );
  }
  if (conflicting && reason.length < 5) throw badRequest('A reason (min 5 characters) is required for reassignment');

  const stmts: D1PreparedStatement[] = [];
  if (byUnit && byUnit.serial_norm !== norm) {
    // Detach the unit's previous serial (unit_id is UNIQUE). The removed
    // mapping is preserved in the audit entry below.
    stmts.push(c.env.DB.prepare('DELETE FROM device_serials WHERE unit_id = ? AND serial_norm = ?').bind(unitId, byUnit.serial_norm));
  }
  if (bySerial) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE device_serials SET unit_id = ?, serial_raw = ?, assigned_by = ?,
            assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), note = ? WHERE serial_norm = ?`
      ).bind(unitId, serialRaw, admin.id, reason, norm)
    );
  } else {
    stmts.push(
      c.env.DB.prepare('INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by, note) VALUES (?, ?, ?, ?, ?)').bind(
        norm,
        serialRaw,
        unitId,
        admin.id,
        reason
      )
    );
  }
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      throw conflict('The serial assignment changed concurrently — reload and retry');
    }
    throw e;
  }
  await audit(c.env.DB, admin.id, conflicting ? 'device.serial_reassign' : 'device.serial_assign', unitId, {
    serial_norm: norm,
    from_unit: bySerial?.unit_id ?? null,
    detached_serial: byUnit && byUnit.serial_norm !== norm ? byUnit.serial_norm : null,
    detached_serial_raw: byUnit && byUnit.serial_norm !== norm ? byUnit.serial_raw : null,
    reason,
  });
  return c.json({ success: true, serial: serialRaw });
});

// ------------------------------------------------------ delivery correction

deviceRoutes.patch('/admin/units/:unitId/delivery', async (c) => {
  const admin = c.get('user')!;
  const unitId = c.req.param('unitId');
  const body = await c.req.json().catch(() => ({}));
  const deliveredAt = isoOrBad(body.delivered_at, 'delivered_at');
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });

  const unit = await c.env.DB.prepare(`SELECT ${UNIT_COLS} FROM order_item_units WHERE id = ?`)
    .bind(unitId)
    .first<UnitRow>();
  if (!unit) throw notFound('Unit not found');

  // Recomputes ONLY this unit's window (partial-shipment correction). No
  // duplicate grants: dates are recomputed in place, nothing is re-issued.
  const win = recomputeUnitWindow(unit, deliveredAt);
  await c.env.DB.prepare(
    'UPDATE order_item_units SET delivered_at = ?, warranty_start_at = ?, warranty_end_at = ? WHERE id = ?'
  )
    .bind(deliveredAt, win.start_at, win.end_at, unitId)
    .run();
  await audit(c.env.DB, admin.id, 'device.unit_delivery_correct', unitId, {
    reason,
    old_delivered_at: unit.delivered_at,
    new_delivered_at: deliveredAt,
    old_end_at: unit.warranty_end_at,
    new_end_at: win.end_at,
  });
  const cov = coverageState(deliveredAt, win.end_at);
  return c.json({ success: true, delivered_at: deliveredAt, warranty_end_at: win.end_at, state: cov.state });
});

// ------------------------------------------------------ warranty duration

/**
 * THE ONE LEVER ON A UNIT'S WARRANTY CLOCK.
 *
 * A warranty clock is otherwise IMMUTABLE. It is written once, at delivery,
 * by `createUnitsOnDelivery` — start = delivered_at, months = whatever the
 * checkout's `warranty_snapshot` sold — and after that only the delivered_at
 * correction above moves it, and only by moving the delivery date. Nothing
 * else in this codebase rewrites `warranty_base_months` or
 * `warranty_ext_months` on a unit that already exists, and the product-level
 * ops policy applies to FUTURE deliveries only.
 *
 * This route exists for exactly two situations the owner actually has:
 * a deliberate goodwill decision («امنحه ستة أشهر إضافية»), and a base
 * period that was mis-imported or mis-configured at the time of sale. It is
 * not a bulk tool and it is not part of any automatic flow.
 *
 * WHAT IT DOES NOT TOUCH, on purpose:
 *   · `order_items.warranty_snapshot` — a PLACEMENT-TIME snapshot of what was
 *     sold. It is never recomputed, here or anywhere; rewriting it would
 *     falsify the record of the sale itself.
 *   · `warranty_receipts` — the paper is a snapshot by design (see the
 *     contract at the head of worker/routes/warranty.ts). Moving a clock
 *     never reissues a receipt; the order screen already computes a `drift`
 *     flag for the divergence this creates (warranty.ts), and reissuing is a
 *     separate, deliberate admin act.
 *   · the replacement chain, the serial, and the registration.
 *
 * SHORTENING IS THE DANGEROUS DIRECTION. `warranty_end_at` is what the
 * customer's device card renders, what a claim attaches as `warranty_facts`,
 * and what the public receipt verification answers with — so pulling it in
 * can silently end coverage someone was already told they had. A shorter
 * window therefore needs an EXPLICIT `confirm_shorter`, the same shape the
 * serial reassignment uses for the same reason. Either direction is audited
 * with who, when, why, and both windows.
 */
deviceRoutes.patch('/admin/units/:unitId/warranty', async (c) => {
  const admin = c.get('user')!;
  const unitId = c.req.param('unitId');
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });

  const unit = await c.env.DB.prepare(`SELECT ${UNIT_COLS} FROM order_item_units WHERE id = ?`)
    .bind(unitId)
    .first<UnitRow>();
  if (!unit) throw notFound('Unit not found');

  const oldTotal = unitTotalMonths(unit);
  /**
   * THE DEFAULT IS NOT EXEMPT FROM THE FLOOR. `int(v, name, { def })` returns
   * `def` BEFORE it compares against `min` (worker/lib/http.ts) — the early
   * return sits above the range check — so passing the stored value straight
   * in would let a unit whose `warranty_base_months` is 0 sail past a guard
   * that reads as if it forbids 0. `warranty_base_months` is a plain nullable
   * INTEGER with no CHECK (migrations/0003_final_phase.sql), so 0 is a value a
   * row can really hold, and an admin who submitted only `ext_months` would
   * then have written `total = ext_months` and moved the customer's end date
   * on the strength of a base the form never showed them.
   *
   * A stored base below the floor is therefore NOT offered as a default: the
   * admin is asked to state the base they mean. That is the whole point of a
   * screen whose every write is audited with a reason.
   */
  const storedBase = Number(unit.warranty_base_months);
  const baseDefault = Number.isInteger(storedBase) && storedBase >= 1 ? storedBase : undefined;
  const baseMonths = int(body.base_months, 'base_months', { min: 1, max: 240, def: baseDefault });
  const extMonths = int(body.ext_months, 'ext_months', { min: 0, max: 240, def: Number(unit.warranty_ext_months) || 0 });
  if (baseMonths + extMonths > 240) throw badRequest('base_months + ext_months must not exceed 240');

  /**
   * A replacement unit that CARRIES the original device's end date keeps that
   * date through `recomputeUnitWindow` by design — the customer's coverage
   * follows the machine they bought, not the box they were handed second.
   * Writing months here would therefore change the stored numbers and move
   * nothing, which is the one outcome worth refusing outright: the admin
   * would read "saved" and the coverage would not budge. Say where the lever
   * actually is instead.
   */
  const pv = safeParse<Record<string, unknown>>(unit.policy_version, {});
  if (pv.carried === 'original_end') {
    throw conflict(
      'This replacement unit carries the ORIGINAL device\'s warranty end date — its months are not the lever. Change the original unit\'s warranty instead.',
      'CARRIED_END'
    );
  }

  // The months live in TWO places: the columns, and `policy_version.total`,
  // which `unitTotalMonths` reads FIRST. Writing only the columns would leave
  // the stored total in charge and the window unchanged — the same silent
  // no-op the check above refuses. Both move together or neither does.
  const nextPolicy = JSON.stringify({
    ...pv,
    base: baseMonths,
    ext: extMonths,
    total: baseMonths + extMonths,
  });
  const nextUnit: UnitRow = {
    ...unit,
    warranty_base_months: baseMonths,
    warranty_ext_months: extMonths,
    policy_version: nextPolicy,
  };

  // No delivery, no clock: units are created with a window only once a
  // delivery date exists. The months are still recorded — the delivery
  // correction above recomputes the window from them when the date lands.
  const win = unit.delivered_at
    ? recomputeUnitWindow(nextUnit, unit.warranty_start_at ?? unit.delivered_at)
    : { start_at: unit.warranty_start_at, end_at: unit.warranty_end_at };

  const oldEndMs = unit.warranty_end_at ? Date.parse(unit.warranty_end_at) : NaN;
  const newEndMs = win.end_at ? Date.parse(win.end_at) : NaN;
  const shortens = Number.isFinite(oldEndMs) && Number.isFinite(newEndMs) && newEndMs < oldEndMs;
  if (shortens && body.confirm_shorter !== true) {
    throw new HttpError(
      409,
      'This shortens a warranty the customer may already have been told about. Repeat with the explicit confirm_shorter flag to record the decision.',
      'CONFIRM_SHORTER_REQUIRED'
    );
  }

  await c.env.DB.prepare(
    `UPDATE order_item_units
        SET warranty_base_months = ?, warranty_ext_months = ?, warranty_start_at = ?, warranty_end_at = ?, policy_version = ?
      WHERE id = ?`
  )
    .bind(baseMonths, extMonths, win.start_at, win.end_at, nextPolicy, unitId)
    .run();

  await audit(c.env.DB, admin.id, 'device.unit_warranty_months', unitId, {
    reason,
    shortened: shortens,
    old_base_months: unit.warranty_base_months,
    new_base_months: baseMonths,
    old_ext_months: Number(unit.warranty_ext_months) || 0,
    new_ext_months: extMonths,
    old_total_months: oldTotal,
    new_total_months: baseMonths + extMonths,
    old_end_at: unit.warranty_end_at,
    new_end_at: win.end_at,
  });

  const cov = coverageState(unit.delivered_at, win.end_at);
  return c.json({
    success: true,
    base_months: baseMonths,
    ext_months: extMonths,
    months: baseMonths + extMonths,
    warranty_start_at: win.start_at,
    warranty_end_at: win.end_at,
    shortened: shortens,
    state: cov.state,
  });
});

// ------------------------------------------------------------- replacement

deviceRoutes.post('/admin/units/:unitId/replace', async (c) => {
  const admin = c.get('user')!;
  const unitId = c.req.param('unitId');
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });
  const newSerialRaw = str(body.new_serial, 'new_serial', { max: 80, required: false });
  const newSerialNorm = newSerialRaw ? normalizeSerial(newSerialRaw) : '';
  if (newSerialRaw && newSerialNorm.length < 4) throw badRequest('new_serial is too short after normalization');
  const deliveredAt = body.delivered_at ? isoOrBad(body.delivered_at, 'delivered_at') : new Date().toISOString();

  const unit = await c.env.DB.prepare(`SELECT ${UNIT_COLS} FROM order_item_units WHERE id = ?`)
    .bind(unitId)
    .first<UnitRow>();
  if (!unit) throw notFound('Unit not found');
  if (unit.replaced_by_unit_id) throw conflict('This unit was already replaced');

  if (newSerialNorm) {
    const taken = await c.env.DB.prepare('SELECT unit_id FROM device_serials WHERE serial_norm = ?').bind(newSerialNorm).first();
    if (taken) throw conflict('The replacement serial is already assigned — resolve that first');
  }

  const activeReg = await c.env.DB.prepare(
    'SELECT user_id FROM device_registrations WHERE unit_id = ? AND revoked_at IS NULL'
  )
    .bind(unitId)
    .first<{ user_id: string }>();

  const newUnitId = newId('unit');
  const nowIso = new Date().toISOString();
  // Remaining-vs-new warranty on replacement is decision-register material.
  // HONEST DEFAULT until the owner decides: the replacement carries the
  // ORIGINAL warranty window (same start and end) — no invented reset period.
  const policyVersion = JSON.stringify({
    v: 1,
    carried: 'original_end',
    replacement_of: unit.id,
    base: unit.warranty_base_months,
    ext: unit.warranty_ext_months,
    total: unitTotalMonths(unit),
  });

  const guard = 'EXISTS (SELECT 1 FROM order_item_units WHERE id = ?1)'; // new unit was created in this batch
  const stmts: D1PreparedStatement[] = [
    // Conditional create: no-op if a concurrent replacement won the race.
    c.env.DB.prepare(
      `INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index,
          delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at,
          policy_version, replacement_of_unit_id)
       SELECT ?1, ou.order_id, ou.order_item_id, ou.product_id, ou.owner_user_id,
              (SELECT COALESCE(MAX(x.unit_index), 0) + 1 FROM order_item_units x WHERE x.order_item_id = ou.order_item_id),
              ?2, ou.warranty_base_months, ou.warranty_ext_months, ou.warranty_start_at, ou.warranty_end_at,
              ?3, ou.id
         FROM order_item_units ou
        WHERE ou.id = ?4 AND ou.replaced_by_unit_id IS NULL`
    ).bind(newUnitId, deliveredAt, policyVersion, unitId),
    c.env.DB.prepare(
      `UPDATE order_item_units SET replaced_by_unit_id = ?1 WHERE id = ?2 AND replaced_by_unit_id IS NULL AND ${guard}`
    ).bind(newUnitId, unitId),
    c.env.DB.prepare(
      `UPDATE device_registrations SET revoked_at = ?2 WHERE unit_id = ?3 AND revoked_at IS NULL AND ${guard}`
    ).bind(newUnitId, nowIso, unitId),
    // The warranty PAPER for the replaced device stops being the live one in
    // the same batch that replaces the device. Doing it here rather than when
    // the next receipt is printed matters: otherwise the old serial keeps
    // verifying as covered on the public page for a device that is gone, and
    // it would keep holding the one-live-receipt-per-unit index. The row is
    // not deleted — 'replaced' is a history state, and the successor receipt
    // fills in replaced_by_receipt_id when it is issued.
    c.env.DB.prepare(
      `UPDATE warranty_receipts
          SET status = 'replaced', replacement_reason = ?2, replaced_at = ?3, updated_at = ?3
        WHERE unit_id = ?4 AND status IN ('draft','active') AND ${guard}`
    ).bind(newUnitId, reason, nowIso, unitId),
  ];
  if (activeReg) {
    // The customer already activated the old device; the replacement stays
    // activated for them (registration never affects any clock).
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO device_registrations (unit_id, user_id) SELECT ?1, ?2 WHERE ${guard} ON CONFLICT(unit_id) DO NOTHING`
      ).bind(newUnitId, activeReg.user_id)
    );
  }
  if (newSerialNorm) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by, note) SELECT ?2, ?3, ?1, ?4, ?5 WHERE ${guard}`
      ).bind(newUnitId, newSerialNorm, newSerialRaw, admin.id, `replacement of ${unitId}: ${reason}`)
    );
    stmts.push(
      c.env.DB.prepare(`UPDATE device_serials SET replaced_by_serial = ?2 WHERE unit_id = ?3 AND ${guard}`).bind(
        newUnitId,
        newSerialNorm,
        unitId
      )
    );
  }

  let results: D1Result[];
  try {
    results = await c.env.DB.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      throw conflict('A conflicting serial/unit change happened concurrently — reload and retry');
    }
    throw e;
  }
  if ((results[0]?.meta?.changes ?? 0) === 0) throw conflict('This unit was already replaced');

  await audit(c.env.DB, admin.id, 'device.unit_replace', unitId, {
    reason,
    new_unit_id: newUnitId,
    new_serial: newSerialNorm || null,
    revoked_registration: !!activeReg,
    warranty_rule: 'carried_original_end',
  });
  return c.json({
    success: true,
    new_unit_id: newUnitId,
    warranty_rule: 'carried_original_end',
    note: 'The replacement carries the ORIGINAL warranty end date. The remaining-vs-new coverage rule after replacement is pending an owner decision (decision register) — no reset period is invented.',
  });
});

// ----------------------------------------------------------- claim workflow

/**
 * The admin claims queue: filtered IN SQL, then limited, then paged.
 *
 * It used to be `ORDER BY … LIMIT 300` followed by a JavaScript filter on the
 * stage, so past three hundred claims the «received» tab silently dropped
 * every received claim below the cut — the oldest ones, which are exactly the
 * ones still waiting. The stage is now `effectiveClaimStageSql`, the same
 * legacy rules `effectiveClaimStage` applies to each row, so a pre-0006 claim
 * is filtered under the stage it is listed under.
 *
 * `counts` is the whole queue per stage (not the page), so each filter can say
 * how many claims it holds before the admin taps it.
 *
 * «عرض المزيد» pages by KEYSET, not offset: `after` is the last row's
 * (priority, created_at, id) as the previous response's `next_cursor`. With an
 * OFFSET, a claim that left the filtered stage while page 1 was open (another
 * admin moved it) shifted every later row up by one and the claim at the page
 * boundary was never shown. A keyset continues from the last row the admin
 * actually saw, whatever moved in between. `page` still works for callers
 * that want a numbered page.
 */
const ADMIN_CLAIMS_PAGE = 50;

/** `after` = a previous page's `next_cursor`: JSON [priority, created_at, id]. */
function parseClaimsCursor(raw: string | undefined): { priority: number; created_at: string; id: string } | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw badRequest('after must be a cursor returned by this endpoint');
  }
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    typeof v[0] !== 'number' ||
    !Number.isInteger(v[0]) ||
    typeof v[1] !== 'string' ||
    typeof v[2] !== 'string' ||
    v[1].length > 40 ||
    v[2].length > 80
  ) {
    throw badRequest('after must be a cursor returned by this endpoint');
  }
  return { priority: v[0], created_at: v[1], id: v[2] };
}

deviceRoutes.get('/admin/claims', async (c) => {
  const raw = str(c.req.query('stage'), 'stage', { max: 20, required: false });
  const stageFilter = raw === 'all' ? '' : raw;
  if (stageFilter && !(CLAIM_STAGES as readonly string[]).includes(stageFilter)) {
    throw badRequest(`stage must be one of: all, ${CLAIM_STAGES.join(', ')}`);
  }
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: ADMIN_CLAIMS_PAGE });
  const page = int(c.req.query('page'), 'page', { min: 1, max: 100_000, def: 1 });
  const after = parseClaimsCursor(c.req.query('after'));
  const stageSql = effectiveClaimStageSql('wc');
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (stageFilter) {
    conds.push(`${stageSql} = ?`);
    binds.push(stageFilter);
  }
  if (after) {
    conds.push('(wc.priority, wc.created_at, wc.id) < (?, ?, ?)');
    binds.push(after.priority, after.created_at, after.id);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const [{ results }, byStage] = await Promise.all([
    c.env.DB.prepare(
      `SELECT wc.*, s.serial_raw, u.email, u.username,${CLAIM_THREAD_COLS}
         FROM warranty_claims wc
         LEFT JOIN device_serials s ON s.unit_id = wc.unit_id
         LEFT JOIN users u ON u.id = wc.user_id
        ${where}
        ORDER BY wc.priority DESC, wc.created_at DESC, wc.id DESC
        LIMIT ? OFFSET ?`
    )
      // One row past the page tells a keyset page whether another follows.
      .bind(...binds, limit + 1, after ? 0 : (page - 1) * limit)
      .all<ClaimRow>(),
    c.env.DB.prepare(`SELECT ${stageSql} AS stage, COUNT(*) AS n FROM warranty_claims wc GROUP BY 1`).all<{ stage: string; n: number }>(),
  ]);
  const counts: Record<string, number> = Object.fromEntries(CLAIM_STAGES.map((st) => [st, 0]));
  for (const r of byStage.results) counts[r.stage] = Number(r.n) || 0;
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const total = stageFilter ? counts[stageFilter] ?? 0 : all;
  const rows = results.slice(0, limit);
  const lastRow = rows[rows.length - 1];
  return c.json({
    success: true,
    claims: rows.map((r) => claimPublic(r, { admin: true })),
    page,
    limit,
    total,
    has_more: results.length > limit,
    next_cursor: lastRow ? JSON.stringify([Number(lastRow.priority) || 0, lastRow.created_at, lastRow.id]) : null,
    counts: { all, ...counts },
  });
});

deviceRoutes.patch('/admin/claims/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const claim = await c.env.DB.prepare('SELECT * FROM warranty_claims WHERE id = ?').bind(id).first<ClaimRow>();
  if (!claim) throw notFound('Claim not found');

  const nextStage = str(body.stage, 'stage', { max: 20 }) as ClaimStage;
  if (!(CLAIM_STAGES as readonly string[]).includes(nextStage)) {
    throw badRequest(`stage must be one of: ${CLAIM_STAGES.join(', ')}`);
  }
  const current = effectiveClaimStage(claim.stage, claim.status);
  if (current !== nextStage && !CLAIM_TRANSITIONS[current].includes(nextStage)) {
    throw badRequest(`Cannot move a claim from "${current}" to "${nextStage}"`);
  }

  // Decisions are explicit admin acts with a recorded reason — misuse is
  // never auto-covered and nothing pays out automatically.
  const decisionStages: ClaimStage[] = ['approved', 'rejected', 'replaced', 'resolved'];
  const reason = str(body.reason, 'reason', { max: 1000, required: false });
  if (decisionStages.includes(nextStage) && reason.length < 5) {
    throw badRequest('A reason (min 5 characters) is required for this decision');
  }
  let decision: string | null = claim.decision ?? null;
  if (body.decision !== undefined && body.decision !== null && body.decision !== '') {
    const d = str(body.decision, 'decision', { max: 20 });
    if (!['repair', 'replace', 'reject', 'misuse'].includes(d)) {
      throw badRequest('decision must be one of: repair, replace, reject, misuse');
    }
    decision = d;
  }

  const res = await c.env.DB.prepare(
    `UPDATE warranty_claims
        SET stage = ?, status = ?, decision = ?, decision_reason = ?, assigned_staff = ?, admin_note = ?
      WHERE id = ? AND COALESCE(stage, '') = COALESCE(?, '')`
  )
    .bind(
      nextStage,
      stageToLegacyStatus(nextStage),
      decision,
      reason || claim.decision_reason || '',
      admin.id,
      reason || claim.admin_note || '',
      id,
      claim.stage
    )
    .run();
  if (res.meta.changes === 0) throw conflict('The claim changed while you were editing — reload and retry');

  await audit(c.env.DB, admin.id, 'warranty.claim_stage', id, {
    from: current,
    to: nextStage,
    decision,
    reason,
    user_id: claim.user_id,
    unit_id: claim.unit_id,
  });
  /**
   * THE CLAIMANT HEARS WHERE THEIR CLAIM NOW STANDS. A decision with its reason
   * was recorded here and in the audit log and told to nobody; the customer
   * found out by opening «مطالباتي» on the off chance. Only a real MOVE is
   * news — re-saving the stage a claim already has (to amend the reason) is
   * not a second announcement. The conditional UPDATE above already proved
   * this request won, so a retry that raced it never reaches this line.
   */
  if (current !== nextStage && claim.user_id !== admin.id) {
    afterResponse(
      c,
      notifyClaimStage(c.env, id, nextStage, { at: new Date().toISOString(), reason })
    );
  }
  return c.json({ success: true, stage: nextStage });
});

// ------------------------------------------------- explicit serialization config

/**
 * Explicit per-product serialization/warranty configuration (never inferred
 * from the product name). Only merges the device-relevant keys; other
 * ops_policy keys (size_class etc.) are preserved untouched.
 */
deviceRoutes.post('/admin/products/:id/ops-policy', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const product = await c.env.DB.prepare('SELECT id, ops_policy, warranty_plans FROM products WHERE id = ?')
    .bind(id)
    .first<{ id: string; ops_policy: string | null; warranty_plans: string | null }>();
  if (!product) throw notFound('Product not found');

  const stored = safeParse<Record<string, unknown>>(product.ops_policy, {});
  const changes: { serialized?: boolean; warranty_base_months?: number | null } = {};
  if (body.serialized !== undefined) {
    if (typeof body.serialized !== 'boolean') throw badRequest('serialized must be true or false');
    changes.serialized = body.serialized;
  }
  if (body.warranty_base_months !== undefined) {
    // null = explicitly NOT configured → units render honest needs_config.
    changes.warranty_base_months =
      body.warranty_base_months === null ? null : int(body.warranty_base_months, 'warranty_base_months', { min: 1, max: 240 });
  }
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to update — send serialized and/or warranty_base_months');
  // The ONE writer of these keys — shared with the product document's own
  // serializer (worker/lib/productModel.ts), so the admin form, the TXT/CSV
  // imports and this route can never spell them differently.
  const policy = mergeOpsPolicy(stored, changes);

  // The same rule every product writer applies (worker/lib/warrantyPlans.ts):
  // a printer offering an active extended-warranty plan must stay serialized,
  // or the units its delivery creates cannot record the coverage it sold.
  // Judged against the plans actually STORED, with the policy as it would be
  // written — so this route cannot switch off what the product form refuses.
  // A non-printer's stored plans are legacy data the product editor owns;
  // its device keys are not held hostage to them here.
  if (await isPrinterProduct(c.env.DB, id)) {
    const next = readOpsWarranty(policy);
    const issues = printerWarrantyRules(
      {
        warranty_plans: upgradeWarranty(product.warranty_plans),
        serialized: next.serialized,
        warranty_base_months: next.warranty_base_months,
      },
      true
    );
    if (issues.length) throw badRequest(issues.join(' | '), WARRANTY_PLAN_INVALID);
  }

  await c.env.DB.prepare("UPDATE products SET ops_policy = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(JSON.stringify(policy), id)
    .run();
  await audit(c.env.DB, admin.id, 'device.ops_policy', id, changes);
  // Applies to FUTURE deliveries only — existing units keep their snapshots.
  return c.json({ success: true, ops_policy: { serialized: policy.serialized === true, warranty_base_months: policy.warranty_base_months ?? null } });
});
