/**
 * Serialized devices, per-unit warranty and warranty claims (mandate §4).
 *
 * Customer surface (/api/devices/...):
 *   GET  /mine                       registered devices with honest coverage
 *   POST /register { serial }        non-enumerating serial registration
 *   GET  /claims                     the user's warranty claims (legacy incl.)
 *   GET  /claims/:id                 one claim + message thread
 *   POST /units/:unitId/claims       open a claim from an owned device
 *   POST /claims/:id/messages        thread message (customer or staff)
 *   POST /claims/upload              private claim attachment (image/video)
 *   GET  /claim-files/*              authorized delivery of claim attachments
 *
 * Admin surface (/api/devices/admin/..., admin role, all mutations audited):
 *   GET   /admin/orders/:orderId/units      order units + serialized items
 *   GET   /admin/units?email=|user_id=      units by customer
 *   POST  /admin/orders/:orderId/units/backfill   (re)create units, idempotent
 *   POST  /admin/units/:unitId/serial       assign serial (reassign = explicit)
 *   PATCH /admin/units/:unitId/delivery     correct ONE unit's delivered_at
 *   POST  /admin/units/:unitId/replace      replacement (history preserved)
 *   GET   /admin/claims  · PATCH /admin/claims/:id   claim workflow decisions
 *   POST  /admin/products/:id/ops-policy    explicit serialization config
 *
 * A serial is an identifier, not an authentication secret: registration only
 * matches units on the SIGNED-IN user's delivered orders and never changes
 * ownership or any warranty clock.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import {
  requireAuth,
  requireAdmin,
  HttpError,
  badRequest,
  notFound,
  forbidden,
  conflict,
  str,
  int,
} from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { sniff } from './uploads';
import {
  parseOpsPolicy,
  coverageState,
  normalizeSerial,
  maskSerial,
  createUnitsOnDelivery,
  recomputeUnitWindow,
  unitTotalMonths,
  effectiveClaimStage,
  stageToLegacyStatus,
  CLAIM_STAGES,
  CLAIM_TRANSITIONS,
  type ClaimStage,
  type UnitRow,
  type WarrantySnapshotLite,
} from '../lib/deviceOps';

export const deviceRoutes = new Hono<AppContext>();
deviceRoutes.use('*', requireAuth);
deviceRoutes.use('/admin/*', requireAdmin);

// The one non-enumerating answer for unknown / foreign / undelivered /
// unassigned serials — never reveals whether the serial exists or whose it is.
const SERIAL_NO_MATCH = () =>
  notFound(
    'This serial could not be matched to a delivered device on your account. Check the number on the device label, or contact LEVONIS support.'
  );

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

function firstImage(imagesJson: unknown, imageSnapshot: unknown): string {
  const snap = typeof imageSnapshot === 'string' ? imageSnapshot : '';
  if (snap) return snap;
  const arr = safeParse<unknown[]>(imagesJson, []);
  const first = arr.find((x) => typeof x === 'string' && x !== '');
  return typeof first === 'string' ? first : '';
}

interface DeviceRow extends UnitRow {
  registered_at?: string | null;
  revoked_at?: string | null;
  serial_raw?: string | null;
  name_snapshot?: string | null;
  image_snapshot?: string | null;
  slug?: string | null;
  p_name?: string | null;
  p_name_ar?: string | null;
  p_name_ku?: string | null;
  images?: string | null;
}

function devicePublic(row: DeviceRow, opts: { admin?: boolean } = {}) {
  const cov = coverageState(row.delivered_at, row.warranty_end_at);
  return {
    unit_id: row.id,
    order_id: row.order_id,
    order_item_id: row.order_item_id,
    unit_index: row.unit_index,
    product: {
      id: row.product_id,
      slug: row.slug ?? null,
      name: String(row.p_name ?? row.name_snapshot ?? ''),
      name_ar: String(row.p_name_ar ?? ''),
      name_ckb: String(row.p_name_ku ?? ''),
      image: firstImage(row.images, row.image_snapshot),
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
  };
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
  serial_raw?: string | null;
  email?: string | null;
  username?: string | null;
}

function claimPublic(row: ClaimRow, opts: { admin?: boolean } = {}) {
  const evidenceKeys = safeParse<unknown[]>(row.evidence, []).filter((k): k is string => typeof k === 'string');
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
    serial: row.serial_raw ? (opts.admin ? row.serial_raw : maskSerial(row.serial_raw)) : null,
    ...(opts.admin ? { user_id: row.user_id, email: row.email ?? null, username: row.username ?? null } : {}),
  };
}

// ================================================================ customer

deviceRoutes.get('/mine', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
            u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
            u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id, u.created_at,
            r.registered_at, s.serial_raw,
            oi.name_snapshot, oi.image_snapshot,
            p.slug, p.name AS p_name, p.name_ar AS p_name_ar, p.name_ku AS p_name_ku, p.images
       FROM device_registrations r
       JOIN order_item_units u ON u.id = r.unit_id
       LEFT JOIN device_serials s ON s.unit_id = u.id
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
       LEFT JOIN products p ON p.id = u.product_id
      WHERE r.user_id = ? AND r.revoked_at IS NULL
      ORDER BY r.registered_at DESC
      LIMIT 100`
  )
    .bind(user.id)
    .all<DeviceRow>();
  return c.json({ success: true, devices: results.map((r) => devicePublic(r)) });
});

deviceRoutes.post('/register', async (c) => {
  // Rate-limited serial search (non-enumerating either way).
  await rateLimit(c, 'serial-register', 10, 600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const serialInput = str(body.serial, 'serial', { min: 4, max: 80 });
  const norm = normalizeSerial(serialInput);
  if (norm.length < 4) throw SERIAL_NO_MATCH();

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
            u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
            u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id, u.created_at,
            s.serial_raw,
            oi.name_snapshot, oi.image_snapshot,
            p.slug, p.name AS p_name, p.name_ar AS p_name_ar, p.name_ku AS p_name_ku, p.images
       FROM device_serials s
       JOIN order_item_units u ON u.id = s.unit_id
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
       LEFT JOIN products p ON p.id = u.product_id
      WHERE s.serial_norm = ?`
  )
    .bind(norm)
    .first<DeviceRow>();

  // Unknown, foreign, or undelivered → the SAME generic answer. The other
  // owner or order is never revealed.
  if (!row || row.owner_user_id !== user.id || !row.delivered_at) throw SERIAL_NO_MATCH();
  if (row.replaced_by_unit_id) {
    // Ownership is verified at this point, so being specific reveals nothing
    // about anyone else.
    throw badRequest('This device was replaced — the replacement unit carries the coverage. Contact support if this looks wrong.', 'UNIT_REPLACED');
  }

  // Idempotent activation. Registration NEVER touches warranty dates: an
  // expired device registers with an honest expired state, and a duplicate
  // registration returns the existing one.
  const priorReg = await c.env.DB.prepare('SELECT user_id, registered_at, revoked_at FROM device_registrations WHERE unit_id = ?')
    .bind(row.id)
    .first<{ user_id: string; registered_at: string; revoked_at: string | null }>();
  await c.env.DB.prepare(
    `INSERT INTO device_registrations (unit_id, user_id) VALUES (?, ?)
     ON CONFLICT(unit_id) DO UPDATE SET revoked_at = NULL
       WHERE device_registrations.user_id = excluded.user_id`
  )
    .bind(row.id, user.id)
    .run();
  const reg = await c.env.DB.prepare('SELECT user_id, registered_at, revoked_at FROM device_registrations WHERE unit_id = ?')
    .bind(row.id)
    .first<{ user_id: string; registered_at: string; revoked_at: string | null }>();
  if (!reg || reg.user_id !== user.id) throw SERIAL_NO_MATCH();

  const device = devicePublic({ ...row, registered_at: reg.registered_at });
  return c.json({
    success: true,
    device,
    already_registered: !!(priorReg && priorReg.user_id === user.id && !priorReg.revoked_at),
  });
});

// ----------------------------------------------------------------- claims

deviceRoutes.get('/claims', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT wc.*, s.serial_raw
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
  const [{ results: messages }, unit] = await Promise.all([
    c.env.DB.prepare('SELECT id, sender_id, is_staff, body, file_key, created_at FROM claim_messages WHERE claim_id = ? ORDER BY created_at ASC LIMIT 500')
      .bind(claim.id)
      .all<Record<string, unknown>>(),
    claim.unit_id
      ? c.env.DB.prepare(`SELECT ${UNIT_COLS} FROM order_item_units WHERE id = ?`).bind(claim.unit_id).first<UnitRow>()
      : Promise.resolve(null),
  ]);
  const cov = unit ? coverageState(unit.delivered_at, unit.warranty_end_at) : null;
  return c.json({
    success: true,
    claim: claimPublic(claim, { admin: isAdmin }),
    // Authorized warranty facts attached automatically — read from the unit,
    // never from client input.
    warranty_facts: unit
      ? {
          order_id: unit.order_id,
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
  // Owner-only; foreign units are indistinguishable from missing ones.
  if (!unit || unit.owner_user_id !== user.id) throw notFound('Device not found on your account');
  if (unit.reg_user !== user.id || unit.reg_revoked) {
    throw badRequest('Register this device first (Warranty → Add device), then open the claim from it.', 'NOT_REGISTERED');
  }

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

  const id = newId('wc');
  const productName = String(unit.name_snapshot || unit.p_name_ar || unit.p_name || 'Device');
  await c.env.DB.prepare(
    `INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description, unit_id, subject, evidence, stage, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 'submitted')`
  )
    .bind(id, user.id, unit.order_item_id, productName, description, unit.id, subject, JSON.stringify(attachments))
    .run();

  const cov = coverageState(unit.delivered_at, unit.warranty_end_at);
  return c.json({
    success: true,
    id,
    stage: 'received',
    warranty_facts: {
      order_id: unit.order_id,
      delivered_at: unit.delivered_at,
      warranty_end_at: unit.warranty_end_at,
      state: cov.state,
      remaining_days: cov.remaining_days,
    },
  });
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
  await c.env.DB.prepare(
    'INSERT INTO claim_messages (id, claim_id, sender_id, is_staff, body, file_key) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, claim.id, user.id, isAdmin ? 1 : 0, text, fileKey)
    .run();
  return c.json({ success: true, id });
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

  const key = `claims/${user.id}/${newId()}.${kind.ext}`;
  await c.env.BUCKET.put(key, buf, {
    httpMetadata: { contentType: kind.mime, cacheControl: 'private, max-age=300' },
  });
  return c.json({ success: true, key, url: `/api/devices/claim-files/${key}` });
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

  const obj = await c.env.BUCKET.get(key);
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
      `SELECT oi.id, oi.name_snapshot, oi.qty, oi.warranty_snapshot, p.ops_policy
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?`
    )
      .bind(orderId)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
              u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
              u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id, u.created_at,
              s.serial_raw, r.registered_at, r.revoked_at,
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
      const policy = parseOpsPolicy(it.ops_policy);
      const snap = safeParse<WarrantySnapshotLite | null>(it.warranty_snapshot, null);
      return {
        id: it.id,
        name: it.name_snapshot,
        qty: it.qty,
        serialized: policy.serialized,
        base_months: policy.base_months,
        warranty_plan: snap ? { plan_id: snap.plan_id ?? null, duration_months: snap.duration_months ?? null, duration_kind: snap.duration_kind ?? null } : null,
      };
    }),
    units: units.map((u) => ({
      ...devicePublic(u, { admin: true }),
      registration: u.registered_at ? { registered_at: u.registered_at, revoked_at: u.revoked_at ?? null } : null,
    })),
  });
});

deviceRoutes.get('/admin/units', async (c) => {
  const q = c.req.query();
  const email = str(q.email, 'email', { max: 320, required: false });
  const userId = str(q.user_id, 'user_id', { max: 60, required: false });
  if (!email && !userId) throw badRequest('Provide email or user_id');
  let ownerId = userId;
  if (!ownerId) {
    const u = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first<{ id: string }>();
    if (!u) return c.json({ success: true, units: [] });
    ownerId = u.id;
  }
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.order_id, u.order_item_id, u.product_id, u.owner_user_id, u.unit_index,
            u.delivered_at, u.warranty_base_months, u.warranty_ext_months, u.warranty_start_at,
            u.warranty_end_at, u.policy_version, u.replaced_by_unit_id, u.replacement_of_unit_id, u.created_at,
            s.serial_raw, r.registered_at, r.revoked_at, oi.name_snapshot, oi.image_snapshot
       FROM order_item_units u
       LEFT JOIN device_serials s ON s.unit_id = u.id
       LEFT JOIN device_registrations r ON r.unit_id = u.id
       LEFT JOIN order_items oi ON oi.id = u.order_item_id
      WHERE u.owner_user_id = ?
      ORDER BY u.created_at DESC LIMIT 200`
  )
    .bind(ownerId)
    .all<DeviceRow>();
  return c.json({
    success: true,
    units: results.map((u) => ({
      ...devicePublic(u, { admin: true }),
      registration: u.registered_at ? { registered_at: u.registered_at, revoked_at: u.revoked_at ?? null } : null,
    })),
  });
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

deviceRoutes.get('/admin/claims', async (c) => {
  const stageFilter = str(c.req.query('stage'), 'stage', { max: 20, required: false });
  const { results } = await c.env.DB.prepare(
    `SELECT wc.*, s.serial_raw, u.email, u.username
       FROM warranty_claims wc
       LEFT JOIN device_serials s ON s.unit_id = wc.unit_id
       LEFT JOIN users u ON u.id = wc.user_id
      ORDER BY wc.created_at DESC LIMIT 300`
  ).all<ClaimRow>();
  let claims = results.map((r) => claimPublic(r, { admin: true }));
  if (stageFilter) claims = claims.filter((cl) => cl.stage === stageFilter);
  return c.json({ success: true, claims });
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
  const product = await c.env.DB.prepare('SELECT id, ops_policy FROM products WHERE id = ?')
    .bind(id)
    .first<{ id: string; ops_policy: string | null }>();
  if (!product) throw notFound('Product not found');

  const policy = safeParse<Record<string, unknown>>(product.ops_policy, {});
  const changes: Record<string, unknown> = {};
  if (body.serialized !== undefined) {
    if (typeof body.serialized !== 'boolean') throw badRequest('serialized must be true or false');
    policy.serialized = body.serialized;
    changes.serialized = body.serialized;
  }
  if (body.warranty_base_months !== undefined) {
    if (body.warranty_base_months === null) {
      // Explicitly NOT configured → units render honest needs_config.
      delete policy.warranty_base_months;
      delete policy.warranty_months;
      changes.warranty_base_months = null;
    } else {
      const months = int(body.warranty_base_months, 'warranty_base_months', { min: 1, max: 240 });
      policy.warranty_base_months = months;
      delete policy.warranty_months; // single canonical key going forward
      changes.warranty_base_months = months;
    }
  }
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to update — send serialized and/or warranty_base_months');

  await c.env.DB.prepare("UPDATE products SET ops_policy = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(JSON.stringify(policy), id)
    .run();
  await audit(c.env.DB, admin.id, 'device.ops_policy', id, changes);
  // Applies to FUTURE deliveries only — existing units keep their snapshots.
  return c.json({ success: true, ops_policy: { serialized: policy.serialized === true, warranty_base_months: policy.warranty_base_months ?? null } });
});
