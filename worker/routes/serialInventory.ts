/**
 * Admin — SERIAL INVENTORY (migration 0139, worker/lib/serialInventory.ts).
 *
 * Mounted by worker/routes/devices.ts at /api/devices/admin/serial-inventory,
 * behind that file's `/admin/*` guard (main host, admin role) and carrying
 * the same guard itself, so it stays closed if it is ever mounted elsewhere.
 * Inventory rows hold no money; an assistant-scoped admin sees them like any
 * other device screen.
 *
 *   GET   /                     keyset page (?q=&status=&product_id=&cursor=&limit=) + counts
 *   GET   /export               CSV of the same filter (formula-safe cells)
 *   POST  /preview              { text | rows, defaults, product_id?, variant_id? } → per-row outcome
 *   POST  /commit               same body + source → inserted count (atomic, idempotent)
 *   POST  /scan                 ONE label (scanned, or typed by hand), registered at once → added | exists | invalid
 *   POST  /link-ean             { ean, product_id, variant_id? } → every unfiled serial with that EAN
 *   GET   /resolve?ean=&model_code=&serial=   the product a scanned label belongs to
 *   GET   /variants?product_id=  a product's catalogue variants, for the picker
 *   GET   /:serial              one row + its history
 *   PATCH /:serial              model / product / box SN / EAN / note
 *   POST  /:serial/void         { reason }   (a void row cannot be linked)
 *   POST  /:serial/restore      { reason }
 *
 * Every mutation writes `audit_log` (`serial_inventory.*`, target = the
 * normalised serial; a commit writes one row naming its serials).
 *
 * REFUSAL CODES (the admin screen maps each to Arabic/English):
 * SERIAL_LIST_EMPTY, SERIAL_LIST_TOO_LONG, SERIAL_NOTHING_TO_ADD,
 * SERIAL_PRODUCT_UNKNOWN, SERIAL_VARIANT_MISMATCH, SERIAL_VARIANT_WITHOUT_PRODUCT,
 * SERIAL_NOT_IN_INVENTORY, SERIAL_ALREADY_VOID, SERIAL_NOT_VOID, BOX_SN_INVALID,
 * EAN_INVALID, NOTHING_TO_CHANGE, CURSOR_INVALID, REASON_REQUIRED,
 * SERIAL_PRODUCT_REQUIRED.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAdmin, requireMainHost, badRequest, str, int } from '../lib/http';
import { audit } from '../lib/audit';
import { normalizeEan, normalizeSerial, buildBulkRow, BULK_MAX_LINES } from '@levonis/catalog/deviceSerials';
import {
  INVENTORY_STATUSES,
  applyPatch,
  candidateRows,
  commitRows,
  csvCell,
  decodeCursor,
  exportInventory,
  identifyLabel,
  inventoryCounts,
  inventoryRowPublic,
  linkEanToProduct,
  listInventory,
  loadInventoryRow,
  parsePatch,
  previewCounts,
  previewRows,
  setVoid,
  verifyProductChoice,
  type InventorySource,
  type InventoryStatus,
  type ListFilter,
} from '../lib/serialInventory';

export const serialInventoryRoutes = new Hono<AppContext>();
serialInventoryRoutes.use('*', requireMainHost, requireAdmin);

function filterFrom(q: Record<string, string>): ListFilter {
  const status = (q.status ?? '') as InventoryStatus | '';
  if (status && !INVENTORY_STATUSES.includes(status as InventoryStatus)) throw badRequest('Unknown status', 'STATUS_INVALID');
  return {
    q: str(q.q, 'q', { max: 120, required: false }),
    status,
    product_id: str(q.product_id, 'product_id', { max: 80, required: false }),
  };
}

serialInventoryRoutes.get('/', async (c) => {
  const q = c.req.query();
  const f = filterFrom(q);
  const limit = int(q.limit, 'limit', { min: 1, max: 100, def: 50 });
  const [page, counts] = await Promise.all([
    listInventory(c.env.DB, f, decodeCursor(q.cursor), limit),
    q.cursor ? Promise.resolve(null) : inventoryCounts(c.env.DB, f),
  ]);
  return c.json({ success: true, ...page, counts });
});

serialInventoryRoutes.get('/export', async (c) => {
  const f = filterFrom(c.req.query());
  const rows = await exportInventory(c.env.DB, f);
  const head = ['serial', 'model_code', 'model_name', 'product_id', 'product', 'box_sn', 'ean', 'status', 'order_id', 'holder_email', 'source', 'added_at', 'added_by', 'void_reason'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.serial, r.model_code, r.model_name, r.product?.id ?? '', r.product?.name ?? '', r.box_sn, r.ean, r.status,
        r.unit?.order_id ?? '', r.holder?.email ?? '', r.source, r.created_at, r.created_by.email ?? r.created_by.id, r.void_reason,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  await audit(c.env.DB, c.get('user')!.id, 'serial_inventory.export', 'serial_inventory', { rows: rows.length, filter: f });
  const stamp = new Date().toISOString().slice(0, 10);
  // A BOM so Excel opens the Arabic model names as UTF-8.
  return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="serial-inventory-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
});

serialInventoryRoutes.post('/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { rows, too_many } = candidateRows(body);
  if (too_many) throw badRequest(`At most ${BULK_MAX_LINES} serials at a time`, 'SERIAL_LIST_TOO_LONG', { max: BULK_MAX_LINES });
  const choice = await verifyProductChoice(c.env.DB, body.product_id, body.variant_id);
  const preview = await previewRows(c.env.DB, rows);
  return c.json({
    success: true,
    rows: preview,
    counts: previewCounts(preview),
    product: choice.product_id ? { id: choice.product_id, name: choice.name, serialized: choice.serialized } : null,
    max_lines: BULK_MAX_LINES,
  });
});

serialInventoryRoutes.post('/commit', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const source: InventorySource = body.source === 'scan' ? 'scan' : body.source === 'manual' ? 'manual' : 'bulk';
  const { rows, too_many } = candidateRows(body);
  if (too_many) throw badRequest(`At most ${BULK_MAX_LINES} serials at a time`, 'SERIAL_LIST_TOO_LONG', { max: BULK_MAX_LINES });
  if (rows.length === 0) throw badRequest('The list is empty', 'SERIAL_LIST_EMPTY');
  const choice = await verifyProductChoice(c.env.DB, body.product_id, body.variant_id);
  // The preview is recomputed here, never trusted from the client.
  const preview = await previewRows(c.env.DB, rows);
  const counts = previewCounts(preview);
  const result = await commitRows(c.env.DB, admin, preview, choice, source);
  if (result.attempted === 0 && counts.exists === 0) {
    throw badRequest('Nothing in this list can be added', 'SERIAL_NOTHING_TO_ADD', { counts });
  }
  if (result.inserted > 0) {
    await audit(c.env.DB, admin.id, 'serial_inventory.add', 'serial_inventory', {
      source,
      inserted: result.inserted,
      product_id: choice.product_id,
      variant_id: choice.variant_id,
      serials: result.serials.slice(0, BULK_MAX_LINES),
    });
  }
  return c.json({
    success: true,
    inserted: result.inserted,
    // Added by someone else between this commit's own preview and its insert.
    skipped_concurrent: result.attempted - result.inserted,
    counts,
    rows: preview.map((r) => ({ line: r.line, serial_norm: r.serial_norm, outcome: r.outcome, problem: r.problem, duplicate_of: r.duplicate_of })),
  });
});

/**
 * ONE LABEL, REGISTERED AT ONCE — the camera sheet's door.
 *
 * The owner: «صوت نجاح عند تسجيل الطابعة بنجاح، وإذا رجع مرة ثانية يسجل طابعة
 * مسجلة مسبقًا يظهر صوت خطأ واهتزاز». So a scan is not a row in a list waiting
 * for «حفظ الكل»: it is written the moment it is read, and the answer the
 * scanner sounds is the DATABASE's — `added` only when this request inserted
 * the row, `exists` (with the stored row, so the sheet can say when and by
 * whom) for a serial the inventory already holds, `invalid` for a value that
 * is not a serial. A race with another admin's insert reads as `exists`,
 * because by then it is.
 *
 * The product is the admin's choice when one is sent; otherwise the label's
 * own (`identifyLabel`: a learned or known EAN, a learned model code, a SKU,
 * or a model name that is exactly one catalogue product). A label the store
 * cannot place is still registered — without a product, with the box's own
 * model hint — and the answer says so (`needs_product`), so the sheet can
 * offer «حدد المنتج» for the whole EAN at once.
 */
serialInventoryRoutes.post('/scan', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).slice(0, 200) : '');
  // «إدخال يدوي» registers its one serial through this same door (same
  // recognition, same verdict and sound) and is recorded as typed, not scanned.
  const source: InventorySource = body.source === 'manual' ? 'manual' : 'scan';
  const row = buildBulkRow(1, { serial: s('serial'), box_sn: s('box_sn'), ean: s('ean'), model_code: s('model_code'), model_name: s('model_name') });
  if (row.problem) {
    return c.json({ success: true, outcome: 'invalid', problem: row.problem, serial_norm: row.serial_norm, row: null });
  }
  const before = await loadInventoryRow(c.env.DB, row.serial_norm);
  if (before) return c.json({ success: true, outcome: 'exists', row: inventoryRowPublic(before) });

  let choice = await verifyProductChoice(c.env.DB, body.product_id, body.variant_id);
  let via: string | null = choice.product_id ? 'chosen' : null;
  const { match, hint } = await identifyLabel(c.env.DB, { ean: row.ean, model_code: row.model_code, serial: row.serial_norm, model_name: row.model_name });
  if (!choice.product_id && match) {
    choice = await verifyProductChoice(c.env.DB, match.product.id, match.variant_id);
    via = match.via;
  }
  // Only a KNOWN box's own words become the stored model. A family read off
  // the serial's prefix stays a hint (`model_hint` on every read): stored, it
  // would pass for a typed model and let the next box of an unknown EAN be
  // filed under «A1» when it may be an A1 Combo.
  const candidate = {
    ...row,
    model_name: row.model_name || match?.model_name || (hint?.source === 'ean' ? hint.model : ''),
    model_code: row.model_code || match?.model_code || hint?.model_code || '',
  };
  const [preview] = await previewRows(c.env.DB, [candidate]);
  const result = await commitRows(c.env.DB, admin, [preview], choice, source);
  if (result.inserted === 0) {
    const now = await loadInventoryRow(c.env.DB, row.serial_norm);
    return c.json({ success: true, outcome: 'exists', row: now ? inventoryRowPublic(now) : null });
  }
  await audit(c.env.DB, admin.id, 'serial_inventory.add', 'serial_inventory', {
    source,
    inserted: 1,
    product_id: choice.product_id,
    variant_id: choice.variant_id,
    via,
    serials: [row.serial_norm],
  });
  const saved = await loadInventoryRow(c.env.DB, row.serial_norm);
  return c.json({
    success: true,
    outcome: preview.outcome === 'new_assigned' ? 'added_assigned' : 'added',
    row: saved ? inventoryRowPublic(saved) : null,
    via,
    hint,
    needs_product: !choice.product_id,
    serialized: choice.product_id ? choice.serialized : null,
  });
});

/**
 * «ربط بمنتج» — one EAN, every serial of it still without a product. The
 * inventory learns the EAN in the same write: the next box carrying it files
 * itself (`resolveLabelProduct` step 1).
 */
serialInventoryRoutes.post('/link-ean', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ean = normalizeEan(typeof body.ean === 'string' ? body.ean : '');
  if (!ean) throw badRequest('Invalid EAN', 'EAN_INVALID');
  const choice = await verifyProductChoice(c.env.DB, body.product_id, body.variant_id);
  if (!choice.product_id) throw badRequest('Choose a product', 'SERIAL_PRODUCT_REQUIRED');
  const res = await linkEanToProduct(c.env.DB, ean, choice);
  if (res.linked > 0) {
    await audit(c.env.DB, admin.id, 'serial_inventory.link_ean', 'serial_inventory', {
      ean,
      product_id: choice.product_id,
      variant_id: choice.variant_id,
      linked: res.linked,
      serials: res.serials,
    });
  }
  return c.json({
    success: true,
    linked: res.linked,
    product: { id: choice.product_id, name: choice.name, serialized: choice.serialized },
  });
});

serialInventoryRoutes.get('/resolve', async (c) => {
  const q = c.req.query();
  const ean = str(q.ean, 'ean', { max: 20, required: false });
  const modelCode = str(q.model_code, 'model_code', { max: 60, required: false });
  const serial = str(q.serial, 'serial', { max: 60, required: false });
  const { match, hint } = await identifyLabel(c.env.DB, { ean, model_code: modelCode, serial });
  return c.json({ success: true, match, hint });
});

serialInventoryRoutes.get('/variants', async (c) => {
  const productId = str(c.req.query('product_id'), 'product_id', { min: 1, max: 80 });
  const { results } = await c.env.DB.prepare(
    `SELECT id, combo_key, sku FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY combo_key LIMIT 200`
  )
    .bind(productId)
    .all<{ id: string; combo_key: string; sku: string | null }>();
  return c.json({ success: true, variants: results });
});

function serialParam(raw: string): string {
  const norm = normalizeSerial(decodeURIComponent(raw));
  if (!norm || norm.length > 60) throw badRequest('Invalid serial', 'SERIAL_CHARS');
  return norm;
}

serialInventoryRoutes.get('/:serial', async (c) => {
  const norm = serialParam(c.req.param('serial'));
  const row = await loadInventoryRow(c.env.DB, norm);
  if (!row) return c.json({ success: false, error: 'Serial not in inventory', code: 'SERIAL_NOT_IN_INVENTORY' }, 404);
  // The row's own story (serial_inventory.*) and, once it is on a unit, the
  // device's (device.* on that unit) — one list, newest first.
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.detail, a.created_at, a.actor_id, u.email, u.username
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE (a.target = ?1 AND a.action LIKE 'serial_inventory.%')
         OR (?2 IS NOT NULL AND a.target = ?2 AND a.action LIKE 'device.%')
      ORDER BY a.created_at DESC, a.id DESC LIMIT 100`
  )
    .bind(norm, row.unit_id)
    .all<Record<string, unknown>>();
  return c.json({
    success: true,
    row: inventoryRowPublic(row),
    history: results.map((h) => ({
      id: h.id,
      action: h.action,
      created_at: h.created_at,
      actor: h.actor_id ? { id: h.actor_id, email: h.email ?? null, username: h.username ?? null } : null,
      detail: safeParse<Record<string, unknown>>(h.detail, {}),
    })),
  });
});

serialInventoryRoutes.patch('/:serial', async (c) => {
  const admin = c.get('user')!;
  const norm = serialParam(c.req.param('serial'));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch = parsePatch(body);
  const before = await loadInventoryRow(c.env.DB, norm);
  if (!before) return c.json({ success: false, error: 'Serial not in inventory', code: 'SERIAL_NOT_IN_INVENTORY' }, 404);
  const product = 'product_id' in body ? await verifyProductChoice(c.env.DB, body.product_id, body.variant_id) : undefined;
  await applyPatch(c.env.DB, norm, { ...patch, product });
  await audit(c.env.DB, admin.id, 'serial_inventory.update', norm, {
    from: {
      model_code: before.model_code, model_name: before.model_name, product_id: before.product_id, variant_id: before.variant_id,
      box_sn: before.box_sn, ean: before.ean, note: before.note,
    },
    to: { ...patch, ...(product ? { product_id: product.product_id, variant_id: product.variant_id } : {}) },
  });
  const row = await loadInventoryRow(c.env.DB, norm);
  return c.json({ success: true, row: row ? inventoryRowPublic(row) : null });
});

for (const [path, voided] of [['/:serial/void', true], ['/:serial/restore', false]] as const) {
  serialInventoryRoutes.post(path, async (c) => {
    const admin = c.get('user')!;
    const norm = serialParam(c.req.param('serial'));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
    if (reason.length < 3) throw badRequest('A reason is required', 'REASON_REQUIRED');
    await setVoid(c.env.DB, norm, voided, reason);
    await audit(c.env.DB, admin.id, voided ? 'serial_inventory.void' : 'serial_inventory.restore', norm, { reason });
    const row = await loadInventoryRow(c.env.DB, norm);
    return c.json({ success: true, row: row ? inventoryRowPublic(row) : null });
  });
}
