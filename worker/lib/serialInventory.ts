/**
 * SERIAL INVENTORY (migration 0139) — the serials the shop holds before a
 * sale, and the one path by which a customer's typed or scanned serial
 * becomes THEIR device.
 *
 * WHAT IT IS NOT. It is not a second device system. A device, its warranty
 * clock, its claims and its account link are `order_item_units` +
 * `device_serials` + `device_registrations`, exactly as before. An inventory
 * row is a memory: "this box, with this serial, is model X / product P". It
 * becomes a device only by being ATTACHED to a unit of that product — by an
 * admin assigning the serial on the order screen (the existing route), or by
 * the buyer typing/scanning it on /warranty (`linkFromInventory` below).
 *
 * THE LINK RULE, and why it is this strict. A serial is printed on the
 * outside of a box and serials run in factory sequence, so a typed number is
 * not proof of possession. The inventory therefore never hands a device to
 * whoever types first: it attaches the serial to the CALLER'S OWN delivered,
 * serial-less, unreplaced unit of the SAME product — the purchase is the
 * proof, the serial only says which of their units it is. Warranty dates are
 * that unit's (from delivery), never the moment of linking. Everything else
 * — an unknown serial, a voided one, one filed under no product, one whose
 * product the caller never received — gets the warranty centre's ONE answer
 * (worker/routes/devices.ts SERIAL_NOT_FOUND_OR_IN_USE), and the customer is
 * offered the manual-review path (a support ticket naming the serial).
 *
 * STATUS IS DERIVED (`STATUS_SQL`), never stored — see the migration.
 */
import { likePattern } from './sqlLike';
import type { SessionUser } from './types';
import { badRequest, conflict, HttpError } from './http';
import { chunk } from './inventory';
import {
  BULK_MAX_LINES,
  buildBulkRow,
  labelModelHint,
  markDuplicates,
  modelMatchesProductName,
  normalizeEan,
  normalizeModelCode,
  normalizeModelName,
  normalizeSerial,
  parseSerialList,
  type BulkFields,
  type BulkRow,
  type ModelHint,
} from '@levonis/catalog/deviceSerials';
import { serialAssignmentsInstalled, serializationContext, lineDevicePolicy } from './serialPolicy';

/**
 * 0178 adds three derived states: `reserved` (a live, not yet delivered
 * preparation assignment — RESERVED_FOR_ORDER), `returned` (its last unit was
 * closed by a return: available again, history kept) and `unavailable`
 * (returned unsellable, or replaced). Still DERIVED, never stored.
 */
export type InventoryStatus = 'in_stock' | 'reserved' | 'sold' | 'registered' | 'returned' | 'unavailable' | 'void';
export const INVENTORY_STATUSES: readonly InventoryStatus[] = ['in_stock', 'reserved', 'sold', 'registered', 'returned', 'unavailable', 'void'];
export type InventorySource = 'manual' | 'bulk' | 'scan';

/**
 * Rows per INSERT…SELECT FROM json_each(?). One bound parameter per
 * statement whatever the size — the D1 100-parameter ceiling never applies —
 * and 200 rows keep each JSON document far below D1's statement limits. The
 * chunks of one commit go in ONE `db.batch`, so a commit is all or nothing.
 */
export const INSERT_CHUNK = 200;

// ------------------------------------------------------------------- reads

/**
 * THE DERIVED STATUS (0139: stored status is forbidden), from the row and the
 * device tables it joins: `si` = serial_inventory, `ds` = device_serials,
 * `r` = device_registrations. Extended by migration 0178 with the serial
 * assignments and the closed-unit states; until that migration has applied it
 * is exactly the original rule (deploy-ahead).
 */
export function serialStatusSql(installed: boolean): string {
  if (!installed) {
    return `CASE
    WHEN si.voided_at IS NOT NULL THEN 'void'
    WHEN ds.unit_id IS NULL THEN 'in_stock'
    WHEN r.user_id IS NOT NULL AND r.revoked_at IS NULL THEN 'registered'
    ELSE 'sold' END`;
  }
  return `CASE
    WHEN si.voided_at IS NOT NULL THEN 'void'
    WHEN EXISTS (SELECT 1 FROM serial_assignments sa WHERE sa.serial_norm = si.serial_norm
                    AND sa.released_at IS NULL AND sa.activated_at IS NULL) THEN 'reserved'
    WHEN ds.unit_id IS NULL THEN 'in_stock'
    WHEN EXISTS (SELECT 1 FROM order_item_units su WHERE su.id = ds.unit_id
                    AND (su.replaced_by_unit_id IS NOT NULL OR su.warranty_closed_reason IN ('returned_unsellable','replaced'))) THEN 'unavailable'
    WHEN EXISTS (SELECT 1 FROM order_item_units su WHERE su.id = ds.unit_id
                    AND su.warranty_closed_reason IN ('returned','traded_in')) THEN 'returned'
    WHEN EXISTS (SELECT 1 FROM order_item_units su WHERE su.id = ds.unit_id AND su.warranty_closed_at IS NOT NULL) THEN 'in_stock'
    WHEN r.user_id IS NOT NULL AND r.revoked_at IS NULL THEN 'registered'
    ELSE 'sold' END`;
}

/** The original derived status (kept for readers that predate 0178). */
export const STATUS_SQL = serialStatusSql(false);

const LIST_FROM = `FROM serial_inventory si
  LEFT JOIN device_serials ds ON ds.serial_norm = si.serial_norm
  LEFT JOIN device_registrations r ON r.unit_id = ds.unit_id
  LEFT JOIN order_item_units u ON u.id = ds.unit_id
  LEFT JOIN products p ON p.id = si.product_id
  LEFT JOIN users hu ON hu.id = r.user_id AND r.revoked_at IS NULL
  LEFT JOIN users cu ON cu.id = si.created_by`;

const listCols = (installed: boolean) => `si.serial_norm, si.serial_raw, si.model_code, si.model_name, si.product_id, si.variant_id,
  si.box_sn, si.ean, si.source, si.note, si.voided_at, si.void_reason, si.created_by, si.created_at, si.updated_at,
  ${serialStatusSql(installed)} AS status,
  ds.unit_id, u.order_id, u.delivered_at,
  r.user_id AS holder_id, r.registered_at, hu.email AS holder_email, hu.username AS holder_username,
  p.name AS p_name, p.name_ar AS p_name_ar,
  cu.email AS creator_email, cu.username AS creator_username`;

interface ListRow extends Record<string, unknown> {
  serial_norm: string;
  serial_raw: string;
  model_code: string;
  model_name: string;
  product_id: string | null;
  variant_id: string | null;
  box_sn: string;
  ean: string;
  source: InventorySource;
  note: string;
  voided_at: string | null;
  void_reason: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  status: InventoryStatus;
  unit_id: string | null;
  order_id: string | null;
  delivered_at: string | null;
  holder_id: string | null;
  registered_at: string | null;
  holder_email: string | null;
  holder_username: string | null;
  p_name: string | null;
  p_name_ar: string | null;
  creator_email: string | null;
  creator_username: string | null;
}

/** The admin payload for one row. ADMIN ONLY: it names the account holding the device. */
export function inventoryRowPublic(r: ListRow) {
  return {
    serial: r.serial_raw,
    serial_norm: r.serial_norm,
    model_code: r.model_code,
    model_name: r.model_name,
    /**
     * What the label itself says when nobody typed a model: the box's known
     * EAN, else the serial's family prefix («Bambu Lab A1»). A HINT for the
     * «الموديل» column and the product search — never a filing.
     */
    model_hint: r.model_name ? null : labelModelHint({ serial: r.serial_norm, ean: r.ean })?.label ?? null,
    product: r.product_id ? { id: r.product_id, name: r.p_name ?? '', name_ar: r.p_name_ar ?? '' } : null,
    variant_id: r.variant_id,
    box_sn: r.box_sn,
    ean: r.ean,
    source: r.source,
    note: r.note,
    status: r.status,
    unit: r.unit_id ? { id: r.unit_id, order_id: r.order_id, delivered_at: r.delivered_at } : null,
    holder:
      r.status === 'registered' && r.holder_id
        ? { id: r.holder_id, email: r.holder_email, username: r.holder_username, registered_at: r.registered_at }
        : null,
    voided_at: r.voided_at,
    void_reason: r.void_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: { id: r.created_by, email: r.creator_email, username: r.creator_username },
  };
}

export interface ListFilter {
  q?: string;
  status?: InventoryStatus | '';
  product_id?: string;
}

/** `LIKE` with the user's text taken literally, bounded in bytes for D1 (worker/lib/sqlLike.ts). */
const likeArg = (s: string): string => likePattern(s, 'contains');

function filterSql(f: ListFilter, installed: boolean): { where: string[]; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const q = (f.q ?? '').trim();
  if (q) {
    const norm = normalizeSerial(q);
    where.push(
      `(si.serial_norm LIKE ? ESCAPE '\\' OR si.box_sn LIKE ? ESCAPE '\\' OR si.ean LIKE ? ESCAPE '\\'
        OR si.model_code LIKE ? ESCAPE '\\' OR si.model_name LIKE ? ESCAPE '\\'
        OR p.name LIKE ? ESCAPE '\\' OR p.name_ar LIKE ? ESCAPE '\\' OR hu.email LIKE ? ESCAPE '\\' OR u.order_id LIKE ? ESCAPE '\\')`
    );
    const n = likeArg(norm || q);
    const t = likeArg(q);
    args.push(n, n, n, t, t, t, t, t, t);
  }
  if (f.status) {
    where.push(`${serialStatusSql(installed)} = ?`);
    args.push(f.status);
  }
  if (f.product_id) {
    where.push('si.product_id = ?');
    args.push(f.product_id);
  }
  return { where, args };
}

export interface Cursor {
  created_at: string;
  serial_norm: string;
}

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify([c.created_at, c.serial_norm])).replace(/=+$/, '');
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(atob(raw)) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') return { created_at: v[0], serial_norm: v[1] };
  } catch {
    /* fall through */
  }
  throw badRequest('Invalid cursor', 'CURSOR_INVALID');
}

/** One keyset page, newest first. */
export async function listInventory(db: D1Database, f: ListFilter, cursor: Cursor | null, limit: number) {
  const installed = await serialAssignmentsInstalled(db);
  const { where, args } = filterSql(f, installed);
  if (cursor) {
    where.push('(si.created_at < ? OR (si.created_at = ? AND si.serial_norm < ?))');
    args.push(cursor.created_at, cursor.created_at, cursor.serial_norm);
  }
  const { results } = await db
    .prepare(
      `SELECT ${listCols(installed)} ${LIST_FROM}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY si.created_at DESC, si.serial_norm DESC
        LIMIT ?`
    )
    .bind(...args, limit + 1)
    .all<ListRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map(inventoryRowPublic),
    next_cursor: results.length > limit && last ? encodeCursor({ created_at: last.created_at, serial_norm: last.serial_norm }) : null,
  };
}

/** Counts per derived status for the filter (search/product), ignoring the status filter itself. */
export async function inventoryCounts(db: D1Database, f: ListFilter): Promise<Record<InventoryStatus | 'all', number>> {
  const installed = await serialAssignmentsInstalled(db);
  const { where, args } = filterSql({ ...f, status: '' }, installed);
  const { results } = await db
    .prepare(
      `SELECT ${serialStatusSql(installed)} AS status, COUNT(*) AS n ${LIST_FROM}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY 1`
    )
    .bind(...args)
    .all<{ status: InventoryStatus; n: number }>();
  const out: Record<InventoryStatus | 'all', number> = { all: 0, in_stock: 0, reserved: 0, sold: 0, registered: 0, returned: 0, unavailable: 0, void: 0 };
  for (const r of results) {
    out[r.status] = Number(r.n);
    out.all += Number(r.n);
  }
  return out;
}

/** Every matching row for the CSV export, read in keyset pages (never one unbounded read). */
export async function exportInventory(db: D1Database, f: ListFilter, max = 20_000) {
  const out: ReturnType<typeof inventoryRowPublic>[] = [];
  let cursor: Cursor | null = null;
  while (out.length < max) {
    const page = await listInventory(db, f, cursor, Math.min(1000, max - out.length));
    out.push(...page.rows);
    if (!page.next_cursor) break;
    cursor = decodeCursor(page.next_cursor);
  }
  return out;
}

/** A spreadsheet cell that cannot be read as a formula (CSV injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function loadInventoryRow(db: D1Database, serialNorm: string) {
  const installed = await serialAssignmentsInstalled(db);
  return db.prepare(`SELECT ${listCols(installed)} ${LIST_FROM} WHERE si.serial_norm = ?`).bind(serialNorm).first<ListRow>();
}

// -------------------------------------------------------- catalogue checks

export interface ProductChoice {
  product_id: string | null;
  variant_id: string | null;
  /** The product's name, for filling a blank model name. */
  name: string;
  /** Delivery creates units for it — without that, nobody can ever link the serial. */
  serialized: boolean;
}

/**
 * The catalogue product (and variant) a batch is filed under, verified. A
 * variant must belong to the product. `serialized` is the delivery hook's own
 * rule (worker/lib/deviceOps.ts): a product that is not serialized never gets
 * a unit, so a serial filed under it can never be linked by its buyer — the
 * screen says so before the owner commits a thousand of them.
 */
export async function verifyProductChoice(db: D1Database, productId: unknown, variantId: unknown): Promise<ProductChoice> {
  const pid = typeof productId === 'string' ? productId.trim() : '';
  const vid = typeof variantId === 'string' ? variantId.trim() : '';
  if (!pid) {
    if (vid) throw badRequest('A variant needs its product', 'SERIAL_VARIANT_WITHOUT_PRODUCT');
    return { product_id: null, variant_id: null, name: '', serialized: false };
  }
  const p = await db
    .prepare('SELECT id, name, ops_policy FROM products WHERE id = ?')
    .bind(pid)
    .first<{ id: string; name: string; ops_policy: string | null }>();
  if (!p) throw badRequest('Unknown product', 'SERIAL_PRODUCT_UNKNOWN');
  if (vid) {
    const v = await db.prepare('SELECT id FROM product_variants WHERE id = ? AND product_id = ?').bind(vid, pid).first<{ id: string }>();
    if (!v) throw badRequest('That variant is not one of this product', 'SERIAL_VARIANT_MISMATCH');
  }
  const serialized = lineDevicePolicy(p.ops_policy, pid, await serializationContext(db, [pid])).serialized;
  return { product_id: pid, variant_id: vid || null, name: p.name, serialized };
}

// ----------------------------------------------------------- preview/commit

export type PreviewOutcome =
  | 'new'
  | 'invalid'
  | 'duplicate_in_batch'
  | 'exists'
  /** Already on an order unit through the order screen (device_serials): it
   *  can be added, and will read `sold`/`registered` at once. */
  | 'new_assigned';

export interface PreviewRow extends BulkRow {
  outcome: PreviewOutcome;
  /** For `exists`: the stored row's derived status. */
  existing_status?: InventoryStatus;
}

export interface CandidateInput {
  text?: unknown;
  rows?: unknown;
  defaults?: { model_name?: unknown; model_code?: unknown };
}

/** The request body → validated candidate rows (paste text OR structured rows, never both). */
export function candidateRows(body: CandidateInput): { rows: BulkRow[]; too_many: boolean } {
  const defaults = {
    model_name: normalizeModelName(typeof body.defaults?.model_name === 'string' ? body.defaults.model_name : ''),
    model_code: normalizeModelCode(typeof body.defaults?.model_code === 'string' ? body.defaults.model_code : ''),
  };
  if (typeof body.text === 'string') {
    if (body.text.length > 200_000) throw badRequest('The list is too long', 'SERIAL_LIST_TOO_LONG');
    return parseSerialList(body.text, defaults);
  }
  if (!Array.isArray(body.rows)) throw badRequest('Send `text` or `rows`', 'SERIAL_LIST_EMPTY');
  if (body.rows.length > BULK_MAX_LINES) return { rows: [], too_many: true };
  const rows = body.rows.map((raw, i) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
    const fields: BulkFields = { serial: s('serial'), model_name: s('model_name'), model_code: s('model_code'), box_sn: s('box_sn'), ean: s('ean') };
    return buildBulkRow(i + 1, fields, defaults);
  });
  return { rows: markDuplicates(rows), too_many: false };
}

/**
 * What committing these rows would do — read-only. Two reads whatever the
 * batch size: each passes the whole list as ONE JSON parameter to
 * `json_each`, so a thousand serials bind one value, not a thousand.
 */
export async function previewRows(db: D1Database, rows: BulkRow[]): Promise<PreviewRow[]> {
  const norms = [...new Set(rows.filter((r) => !r.problem && r.serial_norm).map((r) => r.serial_norm))];
  const existing = new Map<string, InventoryStatus>();
  const assigned = new Set<string>();
  if (norms.length) {
    const list = JSON.stringify(norms);
    const installed = await serialAssignmentsInstalled(db);
    const [inv, dev] = await Promise.all([
      db
        .prepare(
          `SELECT si.serial_norm, ${serialStatusSql(installed)} AS status
             FROM serial_inventory si
             LEFT JOIN device_serials ds ON ds.serial_norm = si.serial_norm
             LEFT JOIN device_registrations r ON r.unit_id = ds.unit_id
            WHERE si.serial_norm IN (SELECT value FROM json_each(?))`
        )
        .bind(list)
        .all<{ serial_norm: string; status: InventoryStatus }>(),
      db
        .prepare('SELECT serial_norm FROM device_serials WHERE serial_norm IN (SELECT value FROM json_each(?))')
        .bind(list)
        .all<{ serial_norm: string }>(),
    ]);
    for (const r of inv.results) existing.set(r.serial_norm, r.status);
    for (const r of dev.results) assigned.add(r.serial_norm);
  }
  return rows.map((r) => {
    if (r.problem) return { ...r, outcome: 'invalid' as const };
    if (r.duplicate_of !== null) return { ...r, outcome: 'duplicate_in_batch' as const };
    const st = existing.get(r.serial_norm);
    if (st) return { ...r, outcome: 'exists' as const, existing_status: st };
    return { ...r, outcome: assigned.has(r.serial_norm) ? ('new_assigned' as const) : ('new' as const) };
  });
}

export function previewCounts(rows: PreviewRow[]) {
  const counts = { total: rows.length, new: 0, new_assigned: 0, exists: 0, duplicate_in_batch: 0, invalid: 0 };
  for (const r of rows) counts[r.outcome] += 1;
  return counts;
}

/**
 * Inserts every `new`/`new_assigned` row in one atomic batch of json_each
 * chunks. `ON CONFLICT DO NOTHING`: a serial another admin added a moment
 * after the preview is skipped, not overwritten, and a replayed commit
 * inserts nothing — both reported through `inserted`, which is the count the
 * database actually wrote.
 */
export async function commitRows(
  db: D1Database,
  admin: Pick<SessionUser, 'id'>,
  rows: PreviewRow[],
  choice: ProductChoice,
  source: InventorySource
): Promise<{ inserted: number; attempted: number; serials: string[] }> {
  const toInsert = rows.filter((r) => r.outcome === 'new' || r.outcome === 'new_assigned');
  if (toInsert.length === 0) return { inserted: 0, attempted: 0, serials: [] };
  const docs = toInsert.map((r) => ({
    n: r.serial_norm,
    r: r.serial_raw,
    mc: r.model_code,
    mn: r.model_name || choice.name.slice(0, 120),
    b: r.box_sn,
    e: r.ean,
  }));
  const statements = chunk(docs, INSERT_CHUNK).map((part) =>
    db
      .prepare(
        `INSERT INTO serial_inventory (serial_norm, serial_raw, model_code, model_name, product_id, variant_id, box_sn, ean, source, created_by)
         SELECT json_extract(j.value, '$.n'), json_extract(j.value, '$.r'), json_extract(j.value, '$.mc'), json_extract(j.value, '$.mn'),
                ?, ?, json_extract(j.value, '$.b'), json_extract(j.value, '$.e'), ?, ?
           FROM json_each(?) j
          WHERE true
         ON CONFLICT(serial_norm) DO NOTHING`
      )
      .bind(choice.product_id, choice.variant_id, source, admin.id, JSON.stringify(part))
  );
  const results = await db.batch(statements);
  const inserted = results.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0);
  return { inserted, attempted: docs.length, serials: docs.map((d) => d.n) };
}

// ------------------------------------------------------------------ edits

export interface InventoryPatch {
  model_code?: string;
  model_name?: string;
  box_sn?: string;
  ean?: string;
  note?: string;
  product?: ProductChoice;
}

/** Validates the editable fields of a PATCH body (unknown keys are ignored). */
export function parsePatch(body: Record<string, unknown>): Omit<InventoryPatch, 'product'> {
  const out: Omit<InventoryPatch, 'product'> = {};
  if (typeof body.model_code === 'string') out.model_code = normalizeModelCode(body.model_code);
  if (typeof body.model_name === 'string') out.model_name = normalizeModelName(body.model_name);
  if (typeof body.box_sn === 'string') {
    const b = normalizeSerial(body.box_sn);
    if (b && (b.length < 4 || b.length > 60 || !/^[A-Z0-9]+$/.test(b))) throw badRequest('Invalid box SN', 'BOX_SN_INVALID');
    out.box_sn = b;
  }
  if (typeof body.ean === 'string') {
    const e = normalizeEan(body.ean);
    if (e === null) throw badRequest('Invalid EAN', 'EAN_INVALID');
    out.ean = e;
  }
  if (typeof body.note === 'string') out.note = body.note.trim().slice(0, 500);
  return out;
}

export async function applyPatch(db: D1Database, serialNorm: string, patch: InventoryPatch): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const k of ['model_code', 'model_name', 'box_sn', 'ean', 'note'] as const) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
    }
  }
  if (patch.product) {
    sets.push('product_id = ?', 'variant_id = ?');
    args.push(patch.product.product_id, patch.product.variant_id);
  }
  if (!sets.length) throw badRequest('Nothing to change', 'NOTHING_TO_CHANGE');
  const res = await db
    .prepare(`UPDATE serial_inventory SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE serial_norm = ?`)
    .bind(...args, serialNorm)
    .run();
  if (!res.meta.changes) throw new HttpError(404, 'Serial not in inventory', 'SERIAL_NOT_IN_INVENTORY');
}

/**
 * Void / restore. A void row can no longer be linked by a customer; a serial
 * already on a unit keeps its device — voiding the MEMORY does not unmake a
 * sale (that is the order screen's reassign/replace, with its own reason).
 */
export async function setVoid(db: D1Database, serialNorm: string, voided: boolean, reason: string): Promise<void> {
  // 0178 (integrity review #10): never void a device a preparation binding
  // holds — checked IN the write, so a scan landing after the route's read
  // cannot leave a live binding on a voided asset.
  const installed = voided && (await serialAssignmentsInstalled(db));
  const notBound = installed
    ? ' AND NOT EXISTS (SELECT 1 FROM serial_assignments sa WHERE sa.serial_norm = serial_inventory.serial_norm AND sa.released_at IS NULL AND sa.activated_at IS NULL)'
    : '';
  const res = voided
    ? await db
        .prepare(
          `UPDATE serial_inventory SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), void_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE serial_norm = ? AND voided_at IS NULL${notBound}`
        )
        .bind(reason, serialNorm)
        .run()
    : await db
        .prepare(
          `UPDATE serial_inventory SET voided_at = NULL, void_reason = '', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE serial_norm = ? AND voided_at IS NOT NULL`
        )
        .bind(serialNorm)
        .run();
  if (!res.meta.changes) {
    const exists = await db.prepare('SELECT voided_at FROM serial_inventory WHERE serial_norm = ?').bind(serialNorm).first<{ voided_at: string | null }>();
    if (!exists) throw new HttpError(404, 'Serial not in inventory', 'SERIAL_NOT_IN_INVENTORY');
    if (installed && !exists.voided_at) {
      throw new HttpError(409, 'هذا الرقم التسلسلي مرتبط حالياً بطلب آخر.', 'SERIAL_IN_USE');
    }
    throw conflict(voided ? 'Already void' : 'Not void', voided ? 'SERIAL_ALREADY_VOID' : 'SERIAL_NOT_VOID');
  }
}

// ------------------------------------------------------- label → product

/**
 * The product a scanned label belongs to, without asking the owner again:
 *   1. the last inventory row with this EAN that was filed under a product
 *      (the catalogue has no EAN column; the inventory LEARNS the mapping the
 *      first time the owner picks a product for that EAN);
 *   2. the last inventory row with this model code;
 *   3. a product or catalogue variant whose SKU is this EAN or model code.
 */
export async function resolveLabelProduct(db: D1Database, ean: string, modelCode: string, modelName = '') {
  const e = normalizeEan(ean) || '';
  const m = normalizeModelCode(modelCode);
  const typedName = normalizeModelName(modelName);
  type Hit = { product_id: string; variant_id: string | null; model_code: string; model_name: string };
  let hit: (Hit & { via: string }) | null = null;
  if (e) {
    const r = await db
      .prepare(
        `SELECT product_id, variant_id, model_code, model_name FROM serial_inventory
          WHERE ean = ? AND product_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`
      )
      .bind(e)
      .first<Hit>();
    if (r) hit = { ...r, via: 'ean' };
  }
  if (!hit && m) {
    const r = await db
      .prepare(
        `SELECT product_id, variant_id, model_code, model_name FROM serial_inventory
          WHERE model_code = ? AND product_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`
      )
      .bind(m)
      .first<Hit>();
    if (r) hit = { ...r, via: 'model_code' };
  }
  if (!hit) {
    const keys = [e, m].filter(Boolean);
    for (const k of keys) {
      const p = await db.prepare(`SELECT id FROM products WHERE sku = ? LIMIT 1`).bind(k).first<{ id: string }>();
      if (p) {
        hit = { product_id: p.id, variant_id: null, model_code: m, model_name: '', via: 'sku' };
        break;
      }
      const v = await db.prepare(`SELECT id, product_id FROM product_variants WHERE sku = ? LIMIT 1`).bind(k).first<{ id: string; product_id: string }>();
      if (v) {
        hit = { product_id: v.product_id, variant_id: v.id, model_code: m, model_name: '', via: 'sku' };
        break;
      }
    }
  }
  if (!hit) {
    // 4. The model the box names — a known EAN's own label, the model name
    //    typed with this very serial, or one typed on an earlier box with this
    //    EAN — matched to exactly ONE catalogue product by name
    //    (`modelMatchesProductName`: «A1 Combo» is never «A1» and never
    //    «A1 mini»). Two candidates, or none, and the product stays the
    //    owner's choice.
    let model = (e ? labelModelHint({ ean: e })?.model : '') || typedName;
    if (!model && e) {
      const typed = await db
        .prepare(`SELECT model_name FROM serial_inventory WHERE ean = ? AND model_name <> '' ORDER BY created_at DESC LIMIT 1`)
        .bind(e)
        .first<{ model_name: string }>();
      model = typed?.model_name ?? '';
    }
    const byName = model ? await productForModel(db, model) : null;
    if (byName) hit = { product_id: byName, variant_id: null, model_code: m, model_name: model, via: 'model_name' };
  }
  if (!hit) return null;
  const p = await db
    .prepare('SELECT id, name, name_ar, sku, price_iqd, status FROM products WHERE id = ?')
    .bind(hit.product_id)
    .first<{ id: string; name: string; name_ar: string | null; sku: string | null; price_iqd: number; status: string }>();
  if (!p) return null;
  return {
    via: hit.via,
    product: { id: p.id, name_en: p.name, name_ar: p.name_ar ?? '', sku: p.sku, price_iqd: p.price_iqd, status: p.status, composition: 'single' },
    variant_id: hit.variant_id,
    model_code: hit.model_code || m,
    model_name: hit.model_name,
  };
}

/**
 * The one catalogue product whose name IS this model, or null when none or
 * more than one is. Drafts, bundles and mystery offers are never a box's
 * product. One indexed-free read bounded to 60 rows by the model's longest
 * word; the exact test is `modelMatchesProductName`.
 */
export async function productForModel(db: D1Database, model: string): Promise<string | null> {
  const anchor = model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !['bambu', 'lab', 'bambulab', '3d', 'printer'].includes(w))
    .sort((a, b) => b.length - a.length)[0];
  if (!anchor) return null;
  const { results } = await db
    .prepare(
      `SELECT id, name, name_ar FROM products
        WHERE status <> 'draft' AND (composition = '' OR composition = 'single')
          AND (lower(name) LIKE ? ESCAPE '\\' OR lower(COALESCE(name_ar, '')) LIKE ? ESCAPE '\\')
        LIMIT 60`
    )
    .bind(likeArg(anchor), likeArg(anchor))
    .all<{ id: string; name: string; name_ar: string | null }>();
  const hits = results.filter((p) => modelMatchesProductName(model, p.name) || (!!p.name_ar && modelMatchesProductName(model, p.name_ar)));
  return hits.length === 1 ? hits[0].id : null;
}

/** A scanned label → its product (when the store can know it) and what the box says. */
export async function identifyLabel(
  db: D1Database,
  label: { ean?: string; model_code?: string; serial?: string; model_name?: string }
): Promise<{ match: Awaited<ReturnType<typeof resolveLabelProduct>>; hint: ModelHint | null }> {
  const match = await resolveLabelProduct(db, label.ean ?? '', label.model_code ?? '', label.model_name ?? '');
  const hint = labelModelHint({ serial: label.serial ?? '', ean: label.ean ?? '' });
  return { match, hint };
}

/**
 * «ربط بمنتج» for a whole EAN at once: every serial carrying this EAN that no
 * product holds yet is filed under `choice` — which is also how the store
 * LEARNS the EAN (`resolveLabelProduct` step 1): the next box with it files
 * itself. A void row stays as it is (void is inert), and a row already filed
 * under a product is never re-filed by this door; the per-serial edit does
 * that, one serial at a time, with its own audit line.
 */
export async function linkEanToProduct(db: D1Database, ean: string, choice: ProductChoice): Promise<{ linked: number; serials: string[] }> {
  const { results } = await db
    .prepare(`SELECT serial_norm FROM serial_inventory WHERE ean = ? AND product_id IS NULL AND voided_at IS NULL LIMIT 1000`)
    .bind(ean)
    .all<{ serial_norm: string }>();
  if (!results.length) return { linked: 0, serials: [] };
  const res = await db
    .prepare(
      `UPDATE serial_inventory
          SET product_id = ?, variant_id = ?,
              model_name = CASE WHEN model_name = '' THEN ? ELSE model_name END,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE ean = ? AND product_id IS NULL AND voided_at IS NULL`
    )
    .bind(choice.product_id, choice.variant_id, choice.name.slice(0, 120), ean)
    .run();
  return { linked: Number(res.meta.changes ?? 0), serials: results.map((r) => r.serial_norm) };
}

// --------------------------------------------------- the customer's link

export type InventoryLinkResult =
  | { kind: 'attached'; unit_id: string; serial_norm: string }
  /** The input was a BOX SN whose product serial is already on a unit. */
  | { kind: 'resolved'; serial_norm: string; unit_id: string }
  | { kind: 'refused'; reason: 'unknown' | 'void' | 'no_product' | 'no_matching_purchase' | 'race' | 'reserved'; serial_norm: string | null };

/**
 * A serial with no `device_serials` row → the caller's device, or a reason
 * it cannot be (never shown to the caller — the route answers every refusal
 * with the one sentence). See the file header for the rule.
 */
export async function linkFromInventory(db: D1Database, userId: string, norm: string): Promise<InventoryLinkResult> {
  const inv = await db
    .prepare(
      `SELECT serial_norm, serial_raw, product_id, voided_at FROM serial_inventory
        WHERE serial_norm = ?1 OR (box_sn = ?1 AND box_sn <> '')
        ORDER BY (serial_norm = ?1) DESC LIMIT 1`
    )
    .bind(norm)
    .first<{ serial_norm: string; serial_raw: string; product_id: string | null; voided_at: string | null }>();
  if (!inv) return { kind: 'refused', reason: 'unknown', serial_norm: null };
  if (inv.serial_norm !== norm) {
    // A box SN. Its product serial may already be on a unit — then that unit
    // answers, under the ordinary rules of the serial path.
    const ds = await db.prepare('SELECT unit_id FROM device_serials WHERE serial_norm = ?').bind(inv.serial_norm).first<{ unit_id: string }>();
    if (ds) return { kind: 'resolved', serial_norm: inv.serial_norm, unit_id: ds.unit_id };
  }
  if (inv.voided_at) return { kind: 'refused', reason: 'void', serial_norm: inv.serial_norm };
  if (!inv.product_id) return { kind: 'refused', reason: 'no_product', serial_norm: inv.serial_norm };
  // 0178: a serial bound to an order unit at preparation is that order's
  // device, even before delivery — never a typed-in claim on someone else's
  // older unit (Audit A conflict 4). The same one answer as every refusal.
  const installed = await serialAssignmentsInstalled(db);
  if (installed) {
    const live = await db
      .prepare('SELECT 1 AS x FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL LIMIT 1')
      .bind(inv.serial_norm)
      .first();
    if (live) return { kind: 'refused', reason: 'reserved', serial_norm: inv.serial_norm };
  }

  // The caller's own delivered, unreplaced unit of this product that carries
  // no serial yet and that no OTHER account holds — the oldest first, so two
  // printers of one order are filled in delivery order.
  const unit = await db
    .prepare(
      `SELECT u.id FROM order_item_units u
         LEFT JOIN device_serials s ON s.unit_id = u.id
         LEFT JOIN device_registrations r ON r.unit_id = u.id
        WHERE u.owner_user_id = ?1 AND u.product_id = ?2
          AND u.delivered_at IS NOT NULL AND u.replaced_by_unit_id IS NULL
          AND s.unit_id IS NULL
          AND (r.unit_id IS NULL OR r.revoked_at IS NOT NULL OR r.user_id = ?1)
        ORDER BY u.delivered_at ASC, u.unit_index ASC
        LIMIT 1`
    )
    .bind(userId, inv.product_id)
    .first<{ id: string }>();
  if (!unit) return { kind: 'refused', reason: 'no_matching_purchase', serial_norm: inv.serial_norm };

  // ON CONFLICT DO NOTHING covers both races: the serial taken by another
  // unit (PRIMARY KEY) and this unit given another serial (UNIQUE unit_id);
  // and (0178, integrity review #3) a preparation scan that bound this serial
  // after the read above is checked IN the insert. The re-read decides.
  const unbound = installed
    ? ' WHERE NOT EXISTS (SELECT 1 FROM serial_assignments sa WHERE sa.serial_norm = ?1 AND sa.released_at IS NULL)'
    : ' WHERE 1';
  await db
    .prepare(
      `INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by, note) SELECT ?1, ?2, ?3, ?4, 'inventory'${unbound}
       ON CONFLICT DO NOTHING`
    )
    .bind(inv.serial_norm, inv.serial_raw, unit.id, userId)
    .run();
  const now = await db.prepare('SELECT unit_id FROM device_serials WHERE serial_norm = ?').bind(inv.serial_norm).first<{ unit_id: string }>();
  if (!now || now.unit_id !== unit.id) return { kind: 'refused', reason: 'race', serial_norm: inv.serial_norm };
  return { kind: 'attached', unit_id: unit.id, serial_norm: inv.serial_norm };
}
