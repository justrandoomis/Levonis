/**
 * Warranty receipts — the issued document, one per physical device.
 *
 * TWO SURFACES, DELIBERATELY DIFFERENT:
 *   /api/warranty/...        PUBLIC. Anyone holding a receipt number (or the
 *                            serial printed on the device) may ask whether it
 *                            is covered. The answer carries the status, the
 *                            product and the window — never the buyer.
 *   /api/admin/warranties/…  ADMIN. Issue, reissue, void, print, and the
 *                            dashboard behind them.
 *
 * WHAT THIS ROUTE DOES NOT OWN. Units, serial assignment, delivery dates and
 * the replacement chain belong to worker/routes/devices.ts and
 * worker/lib/deviceOps.ts; this file reads them. Issuing a receipt never
 * moves a warranty clock, and a receipt is never the reason a unit exists.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { trustedOrigin } from '../lib/appOrigin';
import { safeParse } from '../lib/types';
import { requireAdmin, badRequest, notFound, conflict, str, int, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { getSetting, setSetting } from '../lib/settings';
import { normalizeSerial, unitTotalMonths, type UnitRow } from '../lib/deviceOps';
import {
  DEFAULT_WARRANTY_CONFIG,
  RECEIPT_NO_RE,
  WARRANTY_STATUSES,
  effectiveStatus,
  formatReceiptNo,
  parseWarrantyConfig,
  publicView,
  receiptNoPrefix,
  receiptNoSequence,
  warrantyWindow,
  type WarrantyConfig,
  type WarrantyReceiptRow,
} from '../lib/warranty';
import { renderWarrantyDoc, type WarrantyDocData } from '../lib/warrantyDoc';

// --------------------------------------------------------------- shared

const RECEIPT_COLS = `id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id,
  serial_norm, serial_raw, status, customer_name, customer_phone, customer_address, customer_email,
  product_description, product_model, purchase_price_iqd, purchase_date, order_receipt_no,
  warranty_type, warranty_type_en, warranty_months, coverage_text, coverage_text_en, terms_json, retailer_json,
  warranty_start_at, warranty_end_at, issued_by, issued_at, print_count, last_printed_at,
  replaces_receipt_id, replaced_by_receipt_id, replacement_reason, replaced_at,
  void_reason, voided_at, voided_by, created_at, updated_at`;

const nowIso = () => new Date().toISOString();

/**
 * A date an admin typed, or nothing. The window is printed on paper and
 * compared against the clock on the public page, so a value that is not a
 * real timestamp has to be refused at the door rather than stored and later
 * rendered as "Invalid Date".
 */
function optionalIso(v: unknown, name: string): string {
  const raw = str(v, name, { required: false, max: 40 }).trim();
  if (!raw) return '';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw badRequest(`${name} must be an ISO-8601 date or timestamp`, 'BAD_DATE');
  if (ms < Date.parse('2015-01-01T00:00:00Z') || ms > Date.parse('2100-01-01T00:00:00Z')) {
    throw badRequest(`${name} is outside the plausible range`, 'BAD_DATE');
  }
  return new Date(ms).toISOString();
}

async function loadConfig(db: D1Database): Promise<WarrantyConfig> {
  return parseWarrantyConfig(await getSetting(db, 'warrantyConfig'));
}

/**
 * The verification address printed on the paper. Built from `trustedOrigin`,
 * never from the request URL: a receipt opened while the admin sits on a
 * merchant subdomain must still point customers at the main site.
 */
function verifyUrl(c: Context<AppContext>, receiptNo: string): string {
  return `${trustedOrigin(c)}/warranty/${receiptNo}`;
}

function docData(row: WarrantyReceiptRow, c: Context<AppContext>, now: string, lang: 'ar' | 'en' = 'ar'): WarrantyDocData {
  const retailer = safeParse<WarrantyConfig['retailer']>(row.retailer_json, DEFAULT_WARRANTY_CONFIG.retailer);
  return {
    receipt_no: row.receipt_no,
    issued_date: row.issued_at ?? row.created_at,
    status: effectiveStatus(row.status, row.warranty_end_at, now),
    customer: {
      name: row.customer_name,
      address: row.customer_address,
      phone: row.customer_phone,
      email: row.customer_email,
    },
    product: {
      description: row.product_description,
      model: row.product_model,
      serial: row.serial_raw,
      price_iqd: row.purchase_price_iqd ?? null,
      purchase_date: row.purchase_date ?? null,
      order_receipt_no: row.order_receipt_no,
    },
    warranty: {
      months: row.warranty_months,
      // The wording this receipt was ISSUED with, in the language asked for.
      // Falls back to the other language only when the receipt predates the
      // bilingual snapshot, never to today's configuration.
      type: (lang === 'en' ? row.warranty_type_en : row.warranty_type) || row.warranty_type || row.warranty_type_en,
      coverage: (lang === 'en' ? row.coverage_text_en : row.coverage_text) || row.coverage_text || row.coverage_text_en,
      start_at: row.warranty_start_at ?? null,
      end_at: row.warranty_end_at ?? null,
    },
    terms: safeParse<Array<{ ar: string; en: string }>>(row.terms_json, []),
    retailer,
    verify_url: verifyUrl(c, row.receipt_no),
    chain: { replaces: null, replaced_by: null },
  };
}

/** The admin projection: everything, plus the status the clock decides. */
function adminView(row: WarrantyReceiptRow, now: string): Record<string, unknown> {
  return {
    ...row,
    status_stored: row.status,
    status: effectiveStatus(row.status, row.warranty_end_at, now),
    terms: safeParse<unknown[]>(row.terms_json, []),
    retailer: safeParse<Record<string, unknown>>(row.retailer_json, {}),
  };
}

// ========================================================= PUBLIC ROUTES

export const warrantyPublicRoutes = new Hono<AppContext>();

/**
 * Verify by receipt number, or by the serial printed on the device.
 *
 * Rate-limited by IP: the answer is deliberately thin, but an unthrottled
 * endpoint that says yes/no about an identifier is still an enumeration tool.
 */
warrantyPublicRoutes.get('/verify/:key', async (c) => {
  const key = str(c.req.param('key'), 'key', { min: 3, max: 80 });
  // Thin as the answer is, an unthrottled yes/no about an identifier is an
  // enumeration tool. `rateLimit` throws 429 by itself.
  await rateLimit(c, 'warranty-verify', 30, 60);

  const isReceiptNo = RECEIPT_NO_RE.test(key.trim().toUpperCase());
  const row = isReceiptNo
    ? await c.env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE receipt_no = ?`)
        .bind(key.trim().toUpperCase())
        .first<WarrantyReceiptRow>()
    : // By serial, the LIVE receipt wins; a superseded one is only shown when
      // it is all that exists, so a replaced device still answers honestly.
      await c.env.DB.prepare(
        `SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE serial_norm = ?
          ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'replaced' THEN 2 ELSE 3 END,
                   created_at DESC LIMIT 1`
      )
        .bind(normalizeSerial(key))
        .first<WarrantyReceiptRow>();

  // ONE miss answer, byte for byte, for a number that does not exist and for
  // a draft that has not been handed to anyone. Two different "not found"
  // messages would let a stranger tell a prepared receipt from a fictional
  // one, which is exactly the fact a draft is not supposed to publish.
  const miss = () =>
    c.json(
      {
        success: true,
        found: false,
        message:
          'لا يوجد وصل ضمان بهذا الرقم. تأكد من الرقم كما هو مطبوع على الوصل، أو تواصل مع الدعم. / No warranty receipt matches this number.',
      },
      200
    );
  if (!row) return miss();
  // A draft has not been handed to anyone; it must not verify as a document.
  const view = publicView(row, nowIso());
  if (view.status === 'draft') return miss();
  return c.json({ success: true, found: true, warranty: view });
});

// ========================================================== ADMIN ROUTES

export const warrantyAdminRoutes = new Hono<AppContext>();
warrantyAdminRoutes.use('*', requireAdmin);

// ---- configuration (the terms the receipt prints) -----------------------

warrantyAdminRoutes.get('/config', async (c) => {
  return c.json({ success: true, config: await loadConfig(c.env.DB), defaults: DEFAULT_WARRANTY_CONFIG });
});

warrantyAdminRoutes.put('/config', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // Parsed through the same reader the receipts use, so an admin cannot save
  // a shape the document would fail to render.
  const next = parseWarrantyConfig(body);
  await setSetting(c.env.DB, 'warrantyConfig', next);
  await audit(c.env.DB, admin.id, 'warranty.config_update', 'warrantyConfig', {
    version: next.version,
    terms: next.terms.length,
    default_months: next.default_months,
  });
  return c.json({ success: true, config: next });
});

// ---- the dashboard ------------------------------------------------------

warrantyAdminRoutes.get('/', async (c) => {
  const q = c.req.query();
  const search = str(q.search, 'search', { max: 80, required: false }).trim();
  const status = q.status ? oneOf(q.status, 'status', WARRANTY_STATUSES) : null;
  const limit = int(q.limit, 'limit', { min: 1, max: 100, def: 25 });
  const page = int(q.page, 'page', { min: 1, max: 10_000, def: 1 });

  const where: string[] = [];
  const binds: unknown[] = [];
  if (search) {
    // One box, five things an admin actually has in hand.
    const like = `%${search}%`;
    where.push(
      `(receipt_no LIKE ? COLLATE NOCASE OR serial_norm LIKE ? OR customer_phone LIKE ? OR customer_name LIKE ? COLLATE NOCASE
        OR order_id LIKE ? COLLATE NOCASE OR product_description LIKE ? COLLATE NOCASE OR product_model LIKE ? COLLATE NOCASE)`
    );
    binds.push(like, `%${normalizeSerial(search)}%`, like, like, like, like, like);
  }
  const now = nowIso();
  if (status === 'expired') {
    where.push(`status = 'active' AND warranty_end_at IS NOT NULL AND warranty_end_at < ?`);
    binds.push(now);
  } else if (status === 'active') {
    where.push(`status = 'active' AND (warranty_end_at IS NULL OR warranty_end_at >= ?)`);
    binds.push(now);
  } else if (status) {
    where.push('status = ?');
    binds.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM warranty_receipts ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT ${RECEIPT_COLS} FROM warranty_receipts ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, (page - 1) * limit)
    .all<WarrantyReceiptRow>();

  // The counts the filter chips show, computed once rather than per chip.
  const { results: counts } = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n,
            SUM(CASE WHEN status = 'active' AND warranty_end_at IS NOT NULL AND warranty_end_at < ? THEN 1 ELSE 0 END) AS expired
       FROM warranty_receipts GROUP BY status`
  )
    .bind(now)
    .all<{ status: string; n: number; expired: number }>();
  const byStatus: Record<string, number> = { draft: 0, active: 0, expired: 0, void: 0, replaced: 0 };
  for (const r of counts) {
    if (r.status === 'active') {
      byStatus.expired += r.expired ?? 0;
      byStatus.active += (r.n ?? 0) - (r.expired ?? 0);
    } else if (r.status in byStatus) {
      byStatus[r.status] += r.n ?? 0;
    }
  }

  return c.json({
    success: true,
    receipts: results.map((r) => adminView(r, now)),
    total: total?.n ?? 0,
    page,
    limit,
    counts: byStatus,
  });
});

/** One receipt, with the audit trail of everything ever done to it. */
warrantyAdminRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE id = ? OR receipt_no = ?`)
    .bind(id, id)
    .first<WarrantyReceiptRow>();
  if (!row) throw notFound('Warranty receipt not found');
  const { results: history } = await c.env.DB.prepare(
    `SELECT a.action, a.detail, a.created_at, a.actor_id, u.username, u.email
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.target = ? AND a.action LIKE 'warranty.%' ORDER BY a.created_at DESC LIMIT 100`
  )
    .bind(row.id)
    .all<Record<string, unknown>>();
  return c.json({
    success: true,
    receipt: adminView(row, nowIso()),
    history: history.map((h) => ({ ...h, detail: safeParse<Record<string, unknown>>(h.detail, {}) })),
  });
});

// ---- what an order offers ----------------------------------------------

interface OrderUnitRow extends UnitRow {
  serial_raw: string | null;
  name_snapshot: string | null;
  unit_price_iqd: number | null;
  option_snapshot: string | null;
  receipt_id: string | null;
  receipt_no: string | null;
  receipt_status: string | null;
  receipt_end: string | null;
}

/**
 * The order's warranty-eligible units, each with its serial and whichever
 * receipt it already has. This is what the order screen's "Warranty & Serial
 * Numbers" section renders — one row per PHYSICAL device, never per SKU.
 */
warrantyAdminRoutes.get('/orders/:orderId', async (c) => {
  const orderId = c.req.param('orderId');
  const order = await c.env.DB.prepare(
    `SELECT o.id, o.user_id, o.status, o.delivered_at, o.created_at, o.address_snapshot,
            u.email, u.name AS user_name,
            (SELECT invoice_no FROM invoices WHERE order_id = o.id ORDER BY revision DESC LIMIT 1) AS invoice_no
       FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`
  )
    .bind(orderId)
    .first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');

  const { results: units } = await c.env.DB.prepare(
    `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
            u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
            u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id,
            s.serial_raw, oi.name_snapshot, oi.unit_price_iqd, oi.option_snapshot,
            w.id AS receipt_id, w.receipt_no, w.status AS receipt_status, w.warranty_end_at AS receipt_end
       FROM order_item_units u
       LEFT JOIN device_serials s ON s.unit_id = u.id
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
       LEFT JOIN warranty_receipts w ON w.unit_id = u.id AND w.status IN ('draft','active')
      WHERE u.order_id = ?
      ORDER BY u.order_item_id, u.unit_index`
  )
    .bind(orderId)
    .all<OrderUnitRow>();

  const address = safeParse<Record<string, unknown>>(order.address_snapshot, {});
  const cfg = await loadConfig(c.env.DB);
  const now = nowIso();
  return c.json({
    success: true,
    order: {
      id: order.id,
      status: order.status,
      delivered_at: order.delivered_at ?? null,
      created_at: order.created_at,
      invoice_no: order.invoice_no ?? null,
      customer: {
        name: String(address.name ?? order.user_name ?? ''),
        phone: String(address.phone ?? ''),
        address: [address.governorate, address.area, address.address, address.landmark]
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .join('، '),
        email: String(order.email ?? ''),
      },
    },
    config: cfg,
    units: units.map((u) => ({
      id: u.id,
      order_item_id: u.order_item_id,
      unit_index: u.unit_index,
      product_name: u.name_snapshot ?? '',
      option: u.option_snapshot ?? '',
      unit_price_iqd: u.unit_price_iqd ?? null,
      serial: u.serial_raw ?? null,
      delivered_at: u.delivered_at ?? null,
      warranty_start_at: u.warranty_start_at ?? null,
      warranty_end_at: u.warranty_end_at ?? null,
      months: unitTotalMonths(u),
      replaced: !!u.replaced_by_unit_id,
      replacement_of: u.replacement_of_unit_id ?? null,
      receipt: u.receipt_id
        ? {
            id: u.receipt_id,
            receipt_no: u.receipt_no,
            status: effectiveStatus(String(u.receipt_status), u.receipt_end, now),
          }
        : null,
    })),
  });
});

// ---- issuing ------------------------------------------------------------

/** `WR-2026-0902-001`, retried against the unique index rather than locked. */
async function allocateReceiptNo(db: D1Database, dayIso: string): Promise<{ no: string; seq: number }> {
  const prefix = receiptNoPrefix(dayIso);
  // LENGTH first, then the string: the sequence is zero-padded to three, so a
  // plain string sort puts '999' above '1000' and the thousandth receipt of a
  // day would be handed a number that already exists, for ever.
  const row = await db
    .prepare(
      'SELECT receipt_no FROM warranty_receipts WHERE receipt_no LIKE ? ORDER BY LENGTH(receipt_no) DESC, receipt_no DESC LIMIT 1'
    )
    .bind(`${prefix}%`)
    .first<{ receipt_no: string }>();
  const next = (row ? receiptNoSequence(row.receipt_no) : 0) + 1;
  return { no: formatReceiptNo(dayIso, next), seq: next };
}

warrantyAdminRoutes.post('/', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const unitId = str(body.unit_id, 'unit_id', { min: 3, max: 60 });

  const unit = await c.env.DB.prepare(
    `SELECT u.*, s.serial_raw, s.serial_norm, oi.name_snapshot, oi.unit_price_iqd, oi.option_snapshot,
            o.status AS order_status, o.delivered_at AS order_delivered_at, o.created_at AS order_created_at,
            o.address_snapshot, usr.email AS user_email, usr.name AS user_name,
            (SELECT invoice_no FROM invoices WHERE order_id = o.id ORDER BY revision DESC LIMIT 1) AS invoice_no
       FROM order_item_units u
       LEFT JOIN device_serials s ON s.unit_id = u.id
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
       LEFT JOIN orders o ON o.id = u.order_id
       LEFT JOIN users usr ON usr.id = u.owner_user_id
      WHERE u.id = ?`
  )
    .bind(unitId)
    .first<Record<string, unknown>>();
  if (!unit) throw notFound('Unit not found');

  // 1. A receipt without a serial is a receipt for nothing in particular.
  const serialRaw = String(unit.serial_raw ?? '').trim();
  if (!serialRaw) {
    throw badRequest(
      'أدخل الرقم التسلسلي لهذه الوحدة أولًا — لا يُصدر وصل ضمان بلا رقم تسلسلي. / Enter this unit’s serial number first: a warranty receipt is never issued without one.',
      'SERIAL_REQUIRED'
    );
  }
  // 2. A cancelled order never delivered a device.
  if (unit.order_status === 'cancelled' && !unit.order_delivered_at) {
    throw conflict('الطلب ملغى ولم يُسلَّم — لا يُفعَّل ضمان له. / The order was cancelled before delivery; no warranty is issued for it.', 'ORDER_CANCELLED');
  }
  // 3. One live receipt per device (the database enforces it too).
  const live = await c.env.DB.prepare(
    `SELECT id, receipt_no FROM warranty_receipts WHERE (unit_id = ? OR serial_norm = ?) AND status IN ('draft','active')`
  )
    .bind(unitId, String(unit.serial_norm ?? normalizeSerial(serialRaw)))
    .first<{ id: string; receipt_no: string }>();
  if (live) {
    throw conflict(
      `هذه الوحدة/الرقم التسلسلي له وصل ضمان قائم (${live.receipt_no}). ألغِه أو أعد إصداره بدل إنشاء وصل ثانٍ. / This unit or serial already has a live warranty receipt (${live.receipt_no}).`,
      'WARRANTY_EXISTS'
    );
  }

  const cfg = await loadConfig(c.env.DB);
  const address = safeParse<Record<string, unknown>>(unit.address_snapshot, {});
  const unitRow = unit as unknown as UnitRow;

  // Dates. The window follows the DEVICE record by default (its start is the
  // authenticated delivery), and the admin may state a different start when
  // the sale was a counter handover the device record cannot know about.
  const months = int(body.months, 'months', { min: 1, max: 240, def: unitTotalMonths(unitRow) ?? cfg.default_months });
  const startAt =
    optionalIso(body.warranty_start_at, 'warranty_start_at') ||
    String(unit.warranty_start_at ?? unit.delivered_at ?? unit.order_delivered_at ?? unit.order_created_at ?? nowIso());
  const win = warrantyWindow(startAt, months);
  // The DEVICE record owns the coverage; the receipt prints it. When the admin
  // states neither end, the unit's own stored end wins over a recomputed one —
  // a replacement unit carries the original device's end date on purpose, and
  // a receipt that recalculated it would print a longer warranty than the
  // device actually has.
  const unitEnd = String(unit.warranty_end_at ?? '');
  const endAt =
    optionalIso(body.warranty_end_at, 'warranty_end_at') ||
    (!body.warranty_start_at && !body.months && unitEnd ? unitEnd : win.end_at);
  if (Date.parse(endAt) <= Date.parse(win.start_at)) {
    throw badRequest('نهاية الضمان يجب أن تكون بعد بدايته. / The warranty end must come after its start.', 'BAD_DATE');
  }
  const purchaseDate =
    optionalIso(body.purchase_date, 'purchase_date') || String(unit.order_delivered_at ?? unit.order_created_at ?? startAt);

  const doc = {
    customer_name: str(body.customer_name, 'customer_name', { required: false, max: 160 }) || String(address.name ?? unit.user_name ?? ''),
    customer_phone: str(body.customer_phone, 'customer_phone', { required: false, max: 40 }) || String(address.phone ?? ''),
    customer_address:
      str(body.customer_address, 'customer_address', { required: false, max: 400 }) ||
      [address.governorate, address.area, address.address, address.landmark]
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .join('، '),
    customer_email: str(body.customer_email, 'customer_email', { required: false, max: 200 }) || String(unit.user_email ?? ''),
    product_description:
      str(body.product_description, 'product_description', { required: false, max: 300 }) || String(unit.name_snapshot ?? ''),
    product_model: str(body.product_model, 'product_model', { required: false, max: 160 }) || String(unit.option_snapshot ?? ''),
    purchase_price_iqd:
      body.purchase_price_iqd === undefined || body.purchase_price_iqd === null || body.purchase_price_iqd === ''
        ? (typeof unit.unit_price_iqd === 'number' ? unit.unit_price_iqd : null)
        : int(body.purchase_price_iqd, 'purchase_price_iqd', { min: 0, max: 1_000_000_000 }),
    order_receipt_no: str(body.order_receipt_no, 'order_receipt_no', { required: false, max: 60 }) || String(unit.invoice_no ?? unit.order_id ?? ''),
  };
  if (!doc.customer_name) {
    throw badRequest('اسم الزبون ناقص في الطلب — أكمله قبل الإصدار. / The order carries no customer name; complete it before issuing.', 'CUSTOMER_INCOMPLETE');
  }

  const activate = body.activate !== false; // draft only when explicitly asked
  const id = newId('wr');
  const now = nowIso();

  // The number is allocated against the unique index: two admins pressing
  // Generate in the same second retry rather than share a number.
  let receiptNo = '';
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const alloc = await allocateReceiptNo(c.env.DB, now);
    receiptNo = alloc.no;
    try {
      await c.env.DB.prepare(
        `INSERT INTO warranty_receipts (
            id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id,
            serial_norm, serial_raw, status,
            customer_name, customer_phone, customer_address, customer_email,
            product_description, product_model, purchase_price_iqd, purchase_date, order_receipt_no,
            warranty_type, warranty_type_en, warranty_months, coverage_text, coverage_text_en,
            terms_json, retailer_json,
            warranty_start_at, warranty_end_at, issued_by, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          receiptNo,
          unitId,
          String(unit.order_id),
          String(unit.order_item_id),
          unit.product_id ?? null,
          unit.owner_user_id ?? null,
          String(unit.serial_norm ?? normalizeSerial(serialRaw)),
          serialRaw,
          activate ? 'active' : 'draft',
          doc.customer_name,
          doc.customer_phone,
          doc.customer_address,
          doc.customer_email,
          doc.product_description,
          doc.product_model,
          doc.purchase_price_iqd,
          purchaseDate,
          doc.order_receipt_no,
          cfg.type_ar,
          cfg.type_en,
          months,
          cfg.coverage_ar,
          cfg.coverage_en,
          JSON.stringify(cfg.terms),
          JSON.stringify(cfg.retailer),
          win.start_at,
          endAt,
          admin.id,
          activate ? now : null
        )
        .run();
      lastErr = null;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = e;
      if (msg.includes('idx_warranty_receipts_no') || (msg.includes('UNIQUE') && msg.includes('receipt_no'))) continue;
      if (msg.includes('UNIQUE')) {
        throw conflict('وصل ضمان قائم لهذه الوحدة أو لهذا الرقم التسلسلي. / A live receipt already exists for this unit or serial.', 'WARRANTY_EXISTS');
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;

  await audit(c.env.DB, admin.id, 'warranty.created', id, {
    receipt_no: receiptNo,
    unit_id: unitId,
    order_id: unit.order_id,
    serial: serialRaw,
    months,
    price_iqd: doc.purchase_price_iqd,
    status: activate ? 'active' : 'draft',
    terms_version: cfg.version,
  });

  // A replacement device's paper names the paper it supersedes, in both
  // directions. The old receipt already left the live states when the
  // replacement was recorded (the device route does that in its own batch);
  // this is what closes the chain so either document leads to the other.
  const replacedUnitId = unit.replacement_of_unit_id ? String(unit.replacement_of_unit_id) : '';
  if (replacedUnitId) {
    const prev = await c.env.DB.prepare(
      `SELECT id, receipt_no, serial_raw FROM warranty_receipts WHERE unit_id = ? ORDER BY created_at DESC LIMIT 1`
    )
      .bind(replacedUnitId)
      .first<{ id: string; receipt_no: string; serial_raw: string }>();
    if (prev) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE warranty_receipts
              SET replaced_by_receipt_id = ?1, replaced_at = COALESCE(NULLIF(replaced_at, ''), ?2),
                  status = CASE WHEN status IN ('draft','active') THEN 'replaced' ELSE status END,
                  updated_at = ?2
            WHERE id = ?3`
        ).bind(id, now, prev.id),
        c.env.DB.prepare('UPDATE warranty_receipts SET replaces_receipt_id = ?1, updated_at = ?2 WHERE id = ?3').bind(
          prev.id,
          now,
          id
        ),
      ]);
      await audit(c.env.DB, admin.id, 'warranty.replaced', prev.id, {
        replaced_receipt_no: prev.receipt_no,
        replaced_serial: prev.serial_raw,
        new_receipt_no: receiptNo,
        new_serial: serialRaw,
        new_unit_id: unitId,
        old_unit_id: replacedUnitId,
      });
    }
  }

  const fresh = await c.env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE id = ?`)
    .bind(id)
    .first<WarrantyReceiptRow>();
  return c.json({ success: true, receipt: fresh ? adminView(fresh, now) : null });
});

/** A draft becomes the handed-over document. */
warrantyAdminRoutes.post('/:id/activate', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE id = ?`)
    .bind(id)
    .first<WarrantyReceiptRow>();
  if (!row) throw notFound('Warranty receipt not found');
  if (row.status !== 'draft') throw conflict('Only a draft can be activated');
  const now = nowIso();
  await c.env.DB.prepare(
    `UPDATE warranty_receipts SET status = 'active', issued_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`
  )
    .bind(now, now, id)
    .run();
  await audit(c.env.DB, admin.id, 'warranty.activated', id, { receipt_no: row.receipt_no });
  return c.json({ success: true });
});

/**
 * Reissue: the same device, a NEW document — a corrected address, a wrong
 * price, a lost paper. The old number is retired with a reason rather than
 * edited, so the copy in the customer's hands can still be recognised.
 */
warrantyAdminRoutes.post('/:id/reissue', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });
  const old = await c.env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE id = ?`)
    .bind(id)
    .first<WarrantyReceiptRow>();
  if (!old) throw notFound('Warranty receipt not found');
  if (old.status === 'replaced') throw conflict('This receipt was superseded by a replacement device; reissue the current one');
  // Reissuing is for a document that is still the live one and has to be
  // printed again under a new number. A VOIDED receipt was cancelled on
  // purpose, and quietly bringing it back as an active warranty is the one
  // thing void must not do. Issuing a fresh receipt for the device is the
  // deliberate action, and nothing blocks it — a void row is not live.
  if (old.status === 'void') {
    throw conflict(
      'هذا الوصل ملغى — إعادة إصداره ستُعيده ضمانًا ساريًا. أصدر وصلًا جديدًا للجهاز بدل ذلك. / This receipt was voided; reissuing it would make it a live warranty again. Issue a new receipt for the device instead.',
      'RECEIPT_VOID'
    );
  }

  const now = nowIso();
  const newIdValue = newId('wr');
  const cfg = await loadConfig(c.env.DB);
  const refreshTerms = body.refresh_terms === true;

  let receiptNo = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const alloc = await allocateReceiptNo(c.env.DB, now);
    receiptNo = alloc.no;
    try {
      await c.env.DB.batch([
        // The old one leaves the live state FIRST, so the partial unique
        // index on (unit_id) cannot see two live rows at any point.
        c.env.DB.prepare(
          `UPDATE warranty_receipts SET status = 'void', void_reason = ?, voided_at = ?, voided_by = ?,
              replaced_by_receipt_id = ?, updated_at = ? WHERE id = ? AND status IN ('draft','active')`
        ).bind(`reissued: ${reason}`, now, admin.id, newIdValue, now, id),
        c.env.DB.prepare(
          `INSERT INTO warranty_receipts (
              id, receipt_no, unit_id, order_id, order_item_id, product_id, user_id,
              serial_norm, serial_raw, status,
              customer_name, customer_phone, customer_address, customer_email,
              product_description, product_model, purchase_price_iqd, purchase_date, order_receipt_no,
              warranty_type, warranty_type_en, warranty_months, coverage_text, coverage_text_en,
              terms_json, retailer_json,
              warranty_start_at, warranty_end_at, issued_by, issued_at, replaces_receipt_id)
           SELECT ?1, ?2, unit_id, order_id, order_item_id, product_id, user_id,
              serial_norm, serial_raw, 'active',
              ?3, ?4, ?5, ?6,
              product_description, product_model, ?7, purchase_date, order_receipt_no,
              warranty_type, warranty_type_en, warranty_months, ?8, ?14, ?9, ?10,
              warranty_start_at, warranty_end_at, ?11, ?12, id
             FROM warranty_receipts WHERE id = ?13`
        ).bind(
          newIdValue,
          receiptNo,
          str(body.customer_name, 'customer_name', { required: false, max: 160 }) || old.customer_name,
          str(body.customer_phone, 'customer_phone', { required: false, max: 40 }) || old.customer_phone,
          str(body.customer_address, 'customer_address', { required: false, max: 400 }) || old.customer_address,
          str(body.customer_email, 'customer_email', { required: false, max: 200 }) || old.customer_email,
          body.purchase_price_iqd === undefined || body.purchase_price_iqd === null || body.purchase_price_iqd === ''
            ? old.purchase_price_iqd
            : int(body.purchase_price_iqd, 'purchase_price_iqd', { min: 0, max: 1_000_000_000 }),
          refreshTerms ? cfg.coverage_ar : old.coverage_text,
          refreshTerms ? JSON.stringify(cfg.terms) : old.terms_json,
          refreshTerms ? JSON.stringify(cfg.retailer) : old.retailer_json,
          admin.id,
          now,
          id,
          refreshTerms ? cfg.coverage_en : old.coverage_text_en,
        ),
      ]);
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only a receipt-NUMBER collision is worth retrying: another admin took
      // the same sequence in the same second. A unit or serial collision means
      // a live receipt appeared underneath us, and retrying it five more times
      // only turns a clear 409 into an opaque 500.
      const numberTaken = msg.includes('idx_warranty_receipts_no') || (msg.includes('UNIQUE') && msg.includes('receipt_no'));
      if (numberTaken && attempt < 5) continue;
      if (msg.includes('UNIQUE')) {
        throw conflict(
          'ظهر وصل ضمان قائم لهذه الوحدة أو لهذا الرقم التسلسلي أثناء إعادة الإصدار — حدّث الصفحة وأعد المحاولة. / A live receipt for this unit or serial appeared while reissuing; reload and try again.',
          'WARRANTY_EXISTS'
        );
      }
      throw e;
    }
  }

  await audit(c.env.DB, admin.id, 'warranty.reissued', newIdValue, {
    reason,
    from_receipt_id: id,
    from_receipt_no: old.receipt_no,
    receipt_no: receiptNo,
    refreshed_terms: refreshTerms,
  });
  await audit(c.env.DB, admin.id, 'warranty.superseded', id, { reason, to_receipt_no: receiptNo });
  const fresh = await c.env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE id = ?`)
    .bind(newIdValue)
    .first<WarrantyReceiptRow>();
  return c.json({ success: true, receipt: fresh ? adminView(fresh, now) : null });
});

warrantyAdminRoutes.post('/:id/void', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });
  const row = await c.env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE id = ?`)
    .bind(id)
    .first<WarrantyReceiptRow>();
  if (!row) throw notFound('Warranty receipt not found');
  if (row.status === 'void') return c.json({ success: true, unchanged: true });
  const now = nowIso();
  await c.env.DB.prepare(
    `UPDATE warranty_receipts SET status = 'void', void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ? WHERE id = ?`
  )
    .bind(reason, now, admin.id, now, id)
    .run();
  await audit(c.env.DB, admin.id, 'warranty.voided', id, { reason, receipt_no: row.receipt_no, was: row.status });
  return c.json({ success: true });
});

/**
 * Records that the paper was printed again. Reprinting NEVER creates another
 * receipt: the same number comes out of the printer, and the count plus the
 * audit line are how a second copy is accounted for.
 */
warrantyAdminRoutes.post('/:id/printed', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT id, receipt_no, print_count FROM warranty_receipts WHERE id = ?')
    .bind(id)
    .first<{ id: string; receipt_no: string; print_count: number }>();
  if (!row) throw notFound('Warranty receipt not found');
  const now = nowIso();
  await c.env.DB.prepare(
    'UPDATE warranty_receipts SET print_count = print_count + 1, last_printed_at = ?, updated_at = ? WHERE id = ?'
  )
    .bind(now, now, id)
    .run();
  await audit(c.env.DB, admin.id, 'warranty.reprinted', id, {
    receipt_no: row.receipt_no,
    copy_number: (row.print_count ?? 0) + 1,
  });
  return c.json({ success: true, print_count: (row.print_count ?? 0) + 1 });
});

/** The A4 document itself. Opened in a tab; `print=1` opens the dialog. */
warrantyAdminRoutes.get('/:id/document', async (c) => {
  const id = c.req.param('id');
  const lang = c.req.query('lang') === 'en' ? 'en' : 'ar';
  const autoPrint = c.req.query('print') === '1';
  const row = await c.env.DB.prepare(`SELECT ${RECEIPT_COLS} FROM warranty_receipts WHERE id = ? OR receipt_no = ?`)
    .bind(id, id)
    .first<WarrantyReceiptRow>();
  if (!row) throw notFound('Warranty receipt not found');
  const now = nowIso();
  const data = docData(row, c, now, lang);
  if (row.replaces_receipt_id) {
    const prev = await c.env.DB.prepare('SELECT receipt_no FROM warranty_receipts WHERE id = ?')
      .bind(row.replaces_receipt_id)
      .first<{ receipt_no: string }>();
    data.chain.replaces = prev?.receipt_no ?? null;
  }
  if (row.replaced_by_receipt_id) {
    const next = await c.env.DB.prepare('SELECT receipt_no FROM warranty_receipts WHERE id = ?')
      .bind(row.replaced_by_receipt_id)
      .first<{ receipt_no: string }>();
    data.chain.replaced_by = next?.receipt_no ?? null;
  }
  return c.html(renderWarrantyDoc(data, lang, autoPrint));
});
