/**
 * GIFTS — the customer's gifts and the admin's gift levels and grants
 * (owner brief 2026-10-06 §1; docs/GIFTS_QUICK_BUY.md §1.2). Mounted at
 * `/api/gifts` (worker/index.ts). The gift routes that used to live in
 * worker/routes/reviews.ts moved here; `legacyGiftRoutes`, mounted at
 * `/api/reviews`, keeps their old URLs answering for clients cached before.
 *
 * Every write is ONE `db.batch` holding the conditional UPDATE (its WHERE
 * carries the precondition: state, owner, version), the lost-race fence
 * (`changedExactlyOne`) and the audit row — so a write that lost a race rolls
 * back with its audit row and its notice, and is answered from what the row
 * says now. Stock is never touched here (D6): it moves only through the order.
 *
 * Customer (signed in):
 *   GET  /                 → { gifts: GiftView[] }
 *   POST /:id/choose       { itemId }  → { gift }        404 GIFT_NOT_FOUND · 409 GIFT_STATE, GIFT_ITEM_UNAVAILABLE
 *   POST /:id/redeem       {}          → { gift, replay? } 409 GIFT_STATE, GIFT_CHOICE_REQUIRED, GIFT_ITEM_UNAVAILABLE
 * Admin (requireAdmin): see the routes under /admin below.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import {
  HttpError,
  badRequest,
  conflict,
  int,
  jsonObject,
  notFound,
  requireAdmin,
  requireAuth,
  str,
} from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { auditStatements } from '../lib/audit';
import { newId } from '../lib/crypto';
import { notifyStatement } from '../lib/notifications';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import {
  changedExactlyOne,
  giftViewFrom,
  GRANT_REASONS,
  isLostRace,
  levelPoolId,
  loadCustomerGift,
  loadCustomerGifts,
  loadGiftRow,
  loadLevels,
  requestHash,
  snapshotJson,
  viewContextFor,
  type GrantReason,
} from '../lib/gifts/model';
import {
  checkGiftSelection,
  giftOptionsProjection,
  giftSelectionOf,
  loadGiftProduct,
  loadGiftProducts,
  selectionFromColumns,
  selectionInput,
  type GiftSelectionResult,
} from '../lib/gifts/selection';
import {
  adminItemView,
  itemInputFromRow,
  legacyItemView,
  parseItemInput,
  parseLevelPatch,
  validateItem,
  type ItemInput,
} from '../lib/gifts/levels';
import { GIFT_COPY, notifyGiftGranted, planGrant } from '../lib/gifts/grant';
import { giftAuditTimeline, listGrants, loadAdminGift, parseGrantFilters } from '../lib/gifts/admin';
import {
  LEGACY_POOL_FILTER,
  legacyEntitlementView,
  parsePoolItemBody,
  poolItemView,
  redeemLegacyBox,
  type PoolItemRow,
} from '../lib/gifts/legacy';

export const giftRoutes = new Hono<AppContext>();
giftRoutes.use('*', requireAuth);
giftRoutes.use('/admin/*', requireAdmin);

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

const giftNotFound = () => new HttpError(404, 'We could not find this gift on your account.', 'GIFT_NOT_FOUND');

/** The refusal a customer reads when the product of a gift cannot be promised today. */
function itemUnavailable(r: Extract<GiftSelectionResult, { ok: false }>): HttpError {
  return new HttpError(409, 'This gift cannot be ordered right now.', 'GIFT_ITEM_UNAVAILABLE', { reason: r.code, errors: r.errors });
}

function stateRefusal(state: string): HttpError {
  if (state === 'granted') return conflict('Choose your gift first.', 'GIFT_CHOICE_REQUIRED');
  return conflict('This gift can no longer be changed.', 'GIFT_STATE');
}

const waitUntil = (c: Context<AppContext>, p: Promise<unknown>) => {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // A test harness without an execution context: run it inline, never fail the response for it.
    void p;
  }
};

// =========================================================================
//  THE CUSTOMER
// =========================================================================

giftRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  return c.json({ success: true, gifts: await loadCustomerGifts(c.env, user.id) });
});

/**
 * «اختر هديتك» — a LEVEL gift fixes one of its level's items. The choice can
 * change until the gift is redeemed; the item must be live and orderable now.
 * The selection is frozen onto the gift (`gift_*` columns + snapshot) so a
 * later edit of the level item never changes what this customer chose.
 */
giftRoutes.post('/:id/choose', async (c) => {
  await rateLimit(c, 'gift_choose', 30, 300);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await jsonObject(c);
  const itemId = str(body.itemId, 'itemId', { min: 1, max: 80 });

  const g = await loadGiftRow(c.env.DB, id, user.id);
  if (!g) throw giftNotFound();
  const state = text(g.state);
  if (text(g.grant_mode) !== 'level' || (state !== 'granted' && state !== 'ready_to_redeem')) {
    throw conflict('This gift can no longer be changed.', 'GIFT_STATE');
  }
  // Replay: the same item again is the same answer, nothing written.
  if (state === 'ready_to_redeem' && text(g.gift_item_id) === itemId) {
    return c.json({ success: true, gift: await loadCustomerGift(c.env, user.id, id), replay: true });
  }

  const item = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(itemId).first<Record<string, unknown>>();
  const sel = item ? selectionFromColumns(item) : null;
  if (!item || !sel || Number(item.active) !== 1 || Number(item.level) !== Number(g.level)) {
    throw new HttpError(409, 'This gift is not one of the choices of your level.', 'GIFT_ITEM_UNAVAILABLE', { reason: 'ITEM_NOT_IN_LEVEL' });
  }
  const checked = checkGiftSelection(await loadGiftProduct(c.env, sel.productId), selectionInput(sel), { requireSellable: true });
  if (!checked.ok) throw itemUnavailable(checked);

  const now = new Date().toISOString();
  const s = checked.selection;
  const audit = await auditStatements(c.env.DB, user.id, 'gift.choose', id, {
    user_id: user.id,
    actor: user.id,
    level: Number(g.level),
    item_id: itemId,
    previous_item_id: g.gift_item_id ?? null,
    product_id: s.productId,
    option_value_ids: s.optionValueIds,
    color_id: s.colorId,
    qty: s.qty,
    sale_type: s.saleType,
    transport_method: s.transportMethod,
  });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE gift_entitlements
            SET state = 'ready_to_redeem', gift_item_id = ?, gift_product_id = ?, gift_option_value_ids = ?, gift_color_id = ?,
                gift_qty = ?, gift_sale_type = ?, gift_transport_method = ?, gift_snapshot = ?, chosen_at = ?, updated_at = ?,
                version = version + 1
          WHERE id = ? AND user_id = ? AND grant_mode = 'level' AND state IN ('granted', 'ready_to_redeem') AND version = ?`
      ).bind(
        itemId, s.productId, JSON.stringify(s.optionValueIds), s.colorId, s.qty, s.saleType, s.transportMethod,
        snapshotJson(checked.snapshot), now, now, id, user.id, Number(g.version)
      ),
      ...changedExactlyOne(c.env.DB),
      ...audit.statements,
    ]);
  } catch (e) {
    if (!isLostRace(e)) throw e;
    const now2 = await loadGiftRow(c.env.DB, id, user.id);
    if (now2 && now2.state === 'ready_to_redeem' && text(now2.gift_item_id) === itemId) {
      return c.json({ success: true, gift: await loadCustomerGift(c.env, user.id, id), replay: true });
    }
    throw stateRefusal(text(now2?.state));
  }
  return c.json({ success: true, gift: await loadCustomerGift(c.env, user.id, id) });
});

/**
 * «استرداد الهدية» — the customer confirms the gift. ready_to_redeem →
 * redeemed, ONCE: the conditional UPDATE, its fence and the `gift_redemptions`
 * primary key make a second redemption impossible, concurrent or replayed; a
 * replay answers with the gift as it now stands (`replay: true`).
 *
 * A legacy review box (grant_mode 'legacy') is redeemed the way it always was
 * — `{ level, options }` picks the box (worker/lib/gifts/legacy.ts).
 */
async function redeem(c: Context<AppContext>, id: string, body: Record<string, unknown>) {
  const user = c.get('user')!;
  const g = await loadGiftRow(c.env.DB, id, user.id);
  if (!g) throw giftNotFound();
  if (text(g.grant_mode || 'legacy') === 'legacy') {
    const legacy = await redeemLegacyBox(c.env.DB, user.id, id, body);
    return { legacy, gift: null as Awaited<ReturnType<typeof loadCustomerGift>>, replay: legacy.replay };
  }
  const state = text(g.state);
  if (state === 'redeemed' || state === 'ordered' || state === 'fulfilled') {
    return { legacy: null, gift: await loadCustomerGift(c.env, user.id, id), replay: true };
  }
  if (state !== 'ready_to_redeem') throw stateRefusal(state);
  const sel = giftSelectionOf(g);
  if (!sel) throw conflict('Choose your gift first.', 'GIFT_CHOICE_REQUIRED');
  if (text(g.grant_mode) === 'level') {
    // A level gift's item must still be offered by its level.
    const item = await c.env.DB.prepare('SELECT active, level FROM gift_pool_items WHERE id = ?')
      .bind(text(g.gift_item_id))
      .first<{ active: number; level: number }>();
    if (!item || Number(item.active) !== 1 || Number(item.level) !== Number(g.level)) {
      throw new HttpError(409, 'This choice is no longer offered — choose another gift.', 'GIFT_ITEM_UNAVAILABLE', { reason: 'ITEM_WITHDRAWN' });
    }
  }
  const checked = checkGiftSelection(await loadGiftProduct(c.env, sel.productId), selectionInput(sel), { requireSellable: true });
  if (!checked.ok) throw itemUnavailable(checked);

  const now = new Date().toISOString();
  const audit = await auditStatements(c.env.DB, user.id, 'gift.redeem', id, {
    user_id: user.id,
    actor: user.id,
    level: Number(g.level),
    mode: text(g.grant_mode),
    item_id: g.gift_item_id ?? null,
    product_id: sel.productId,
    option_value_ids: sel.optionValueIds,
    color_id: sel.colorId,
    qty: sel.qty,
    sale_type: sel.saleType,
    transport_method: sel.transportMethod,
  });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE gift_entitlements SET state = 'redeemed', redeemed_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND state = 'ready_to_redeem' AND version = ?`
      ).bind(now, now, id, user.id, Number(g.version)),
      ...changedExactlyOne(c.env.DB),
      // ONE redemption per gift, for ever (gift_redemptions' primary key).
      c.env.DB.prepare(
        `INSERT INTO gift_redemptions (entitlement_id, user_id, level, options, contents, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, user.id, Number(g.level), JSON.stringify({ item_id: g.gift_item_id ?? null }), text(g.gift_snapshot) || '{}', now),
      ...audit.statements,
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isLostRace(e) && !(msg.includes('UNIQUE') || msg.includes('PRIMARY KEY'))) throw e;
    const now2 = await loadGiftRow(c.env.DB, id, user.id);
    const s2 = text(now2?.state);
    if (s2 === 'redeemed' || s2 === 'ordered' || s2 === 'fulfilled') {
      return { legacy: null, gift: await loadCustomerGift(c.env, user.id, id), replay: true };
    }
    throw stateRefusal(s2);
  }
  return { legacy: null, gift: await loadCustomerGift(c.env, user.id, id), replay: false };
}

giftRoutes.post('/:id/redeem', async (c) => {
  await rateLimit(c, 'gift_redeem', 30, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const out = await redeem(c, id, await jsonObject(c));
  const gift = out.gift ?? (await loadCustomerGift(c.env, user.id, id));
  return c.json({ success: true, gift, ...(out.replay ? { replay: true } : {}) });
});

// =========================================================================
//  THE ADMIN — levels and their items
// =========================================================================

function levelParam(c: Context<AppContext>): number {
  return int(c.req.param('n'), 'level', { min: 1, max: 5 });
}

async function levelsPayload(env: AppContext['Bindings']) {
  const db = env.DB;
  const [levels, { results: itemRows }] = await Promise.all([
    loadLevels(db),
    db.prepare('SELECT * FROM gift_pool_items ORDER BY level, sort, created_at, id').all<Record<string, unknown>>(),
  ]);
  const rows = itemRows ?? [];
  const productRows = rows.filter((r) => text(r.product_id) && text(r.sale_type));
  const products = await loadGiftProducts(env, productRows.map((r) => text(r.product_id)));
  return [1, 2, 3, 4, 5].map((n) => {
    const l = levels.get(n)!;
    return {
      ...l.view,
      updated_at: l.row?.updated_at ?? null,
      items: productRows
        .filter((r) => Number(r.level) === n)
        .map((r) => adminItemView(r, products.get(text(r.product_id))))
        .filter((x) => !!x),
      legacy_items: rows.filter((r) => Number(r.level) === n && !text(r.product_id) && !text(r.sale_type)).map(legacyItemView),
    };
  });
}

giftRoutes.get('/admin/levels', async (c) => c.json({ success: true, levels: await levelsPayload(c.env) }));

/** «تعديل المستوى» — names, descriptions (ar/en/ckb) and whether the level is offered. */
giftRoutes.put('/admin/levels/:n', async (c) => {
  const admin = c.get('user')!;
  const n = levelParam(c);
  const patch = parseLevelPatch(await jsonObject(c));
  const before = await c.env.DB.prepare('SELECT * FROM gift_pools WHERE id = ?').bind(levelPoolId(n)).first<Record<string, unknown>>();
  if (!before) throw notFound('Gift level not found');
  const now = new Date().toISOString();
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.level.update', levelPoolId(n), {
    level: n,
    actor: admin.id,
    before: Object.fromEntries(keys.map((k) => [k, before[k] ?? null])),
    after: patch,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE gift_pools SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`)
      .bind(...keys.map((k) => patch[k]), now, admin.id, levelPoolId(n)),
    ...audit.statements,
  ]);
  const level = (await levelsPayload(c.env))[n - 1];
  return c.json({ success: true, level });
});

/** The admin editor's options for one product: sale types, models, colours and routes. */
giftRoutes.get('/admin/products/:id/options', async (c) => {
  const p = await loadGiftProduct(c.env, c.req.param('id') ?? '');
  if (!p.row) throw notFound('Product not found');
  return c.json({ success: true, options: giftOptionsProjection(p) });
});

function itemRefusal(r: Extract<GiftSelectionResult, { ok: false }>): HttpError {
  return new HttpError(400, `This product selection cannot be a gift (${r.code}).`, r.code, { errors: r.errors });
}

async function duplicateItem(db: D1Database, level: number, input: ItemInput, exceptId = ''): Promise<boolean> {
  const hit = await db
    .prepare(
      `SELECT 1 AS x FROM gift_pool_items
        WHERE level = ? AND active = 1 AND product_id = ? AND option_value_ids = ? AND color_id = ? AND qty = ?
          AND sale_type = ? AND transport_method = ? AND id <> ? LIMIT 1`
    )
    .bind(level, input.productId, JSON.stringify(input.optionValueIds), input.colorId, input.qty, input.saleType, input.transportMethod, exceptId)
    .first();
  return !!hit;
}

/** «إضافة منتج إلى المستوى» — a real store product, fully pinned (D3). */
giftRoutes.post('/admin/levels/:n/items', async (c) => {
  const admin = c.get('user')!;
  const n = levelParam(c);
  const input = parseItemInput(await jsonObject(c));
  const product = await loadGiftProduct(c.env, input.productId);
  const verdict = validateItem(product, input);
  if (!verdict.ok) throw itemRefusal(verdict);
  if (input.active && (await duplicateItem(c.env.DB, n, input))) {
    throw conflict('This exact product selection is already offered in this level.', 'GIFT_ITEM_DUPLICATE');
  }
  const id = newId('gpi');
  const now = new Date().toISOString();
  const snap = verdict.snapshot;
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.item.create', id, {
    level: n,
    actor: admin.id,
    product_id: input.productId,
    option_value_ids: input.optionValueIds,
    color_id: input.colorId,
    qty: input.qty,
    sale_type: input.saleType,
    transport_method: input.transportMethod,
    active: input.active,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO gift_pool_items
         (id, level, kind, label_ar, label_en, label_ckb, stock, active, product_id, option_value_ids, color_id, qty,
          sale_type, transport_method, sort, updated_at)
       VALUES (?, ?, 'other', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, n, snap.name_ar, snap.name_en, snap.name_ckb, input.active ? 1 : 0, input.productId,
      JSON.stringify(input.optionValueIds), input.colorId, input.qty, input.saleType, input.transportMethod, input.sort, now
    ),
    ...audit.statements,
  ]);
  const row = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, item: adminItemView(row!, product) });
});

async function productItemRow(db: D1Database, id: string): Promise<Record<string, unknown>> {
  const row = await db.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('Gift item not found');
  if (!text(row.product_id) || !text(row.sale_type)) {
    throw conflict('A legacy label-only item is read-only.', 'GIFT_ITEM_LEGACY');
  }
  return row;
}

/** Edit a level item. Gifts that already chose it keep their own frozen selection. */
giftRoutes.put('/admin/items/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const row = await productItemRow(c.env.DB, id);
  const before = itemInputFromRow(row);
  const input = parseItemInput(await jsonObject(c), before);
  const product = await loadGiftProduct(c.env, input.productId);
  const verdict = validateItem(product, input);
  if (!verdict.ok) throw itemRefusal(verdict);
  if (input.active && (await duplicateItem(c.env.DB, Number(row.level), input, id))) {
    throw conflict('This exact product selection is already offered in this level.', 'GIFT_ITEM_DUPLICATE');
  }
  const now = new Date().toISOString();
  const snap = verdict.snapshot;
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.item.update', id, {
    level: Number(row.level),
    actor: admin.id,
    before,
    after: input,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE gift_pool_items
          SET label_ar = ?, label_en = ?, label_ckb = ?, active = ?, product_id = ?, option_value_ids = ?, color_id = ?, qty = ?,
              sale_type = ?, transport_method = ?, sort = ?, updated_at = ?
        WHERE id = ? AND product_id IS NOT NULL`
    ).bind(
      snap.name_ar, snap.name_en, snap.name_ckb, input.active ? 1 : 0, input.productId, JSON.stringify(input.optionValueIds),
      input.colorId, input.qty, input.saleType, input.transportMethod, input.sort, now, id
    ),
    ...changedExactlyOne(c.env.DB),
    ...audit.statements,
  ]);
  const fresh = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, item: adminItemView(fresh!, product) });
});

/** Remove an item from its level — SOFT: it stops being offered; history keeps pointing at it. */
giftRoutes.delete('/admin/items/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const row = await productItemRow(c.env.DB, id);
  const now = new Date().toISOString();
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.item.delete', id, {
    level: Number(row.level),
    actor: admin.id,
    product_id: text(row.product_id),
    was_active: Number(row.active) === 1,
  });
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE gift_pool_items SET active = 0, updated_at = ? WHERE id = ?').bind(now, id),
    ...audit.statements,
  ]);
  return c.json({ success: true });
});

// =========================================================================
//  THE ADMIN — grants
// =========================================================================

/** «ابحث عن زبون» for the grant sheet: name, e-mail, username or phone. */
giftRoutes.get('/admin/users', async (c) => {
  const q = str(c.req.query('q'), 'q', { max: 100, required: false });
  if (!q) return c.json({ success: true, users: [] });
  const like = likePattern(q);
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, email, username, phone_e164 AS phone, role FROM users
      WHERE ${sqlLikeClause(['email', 'username', 'name', 'phone_e164'])} OR id = ?
      ORDER BY created_at DESC LIMIT 20`
  )
    .bind(like, like, like, like, q)
    .all<Record<string, unknown>>();
  return c.json({ success: true, users: results ?? [] });
});

giftRoutes.get('/admin/grants', async (c) => {
  const out = await listGrants(c.env.DB, parseGrantFilters(c.req.query()));
  return c.json({ success: true, ...out });
});

giftRoutes.get('/admin/grants/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  const grant = await loadAdminGift(c.env.DB, id);
  if (!grant) throw notFound('Gift not found');
  return c.json({ success: true, grant, audit: await giftAuditTimeline(c.env.DB, id) });
});

giftRoutes.get('/admin/grants/:id/audit', async (c) => {
  const id = c.req.param('id') ?? '';
  const exists = await c.env.DB.prepare('SELECT 1 AS x FROM gift_entitlements WHERE id = ?').bind(id).first();
  if (!exists) throw notFound('Gift not found');
  return c.json({ success: true, audit: await giftAuditTimeline(c.env.DB, id) });
});

function grantReason(v: unknown): GrantReason {
  if (typeof v !== 'string' || !(GRANT_REASONS as readonly string[]).includes(v)) {
    throw badRequest(`reason must be one of: ${GRANT_REASONS.join(', ')}`, 'GIFT_REASON_INVALID');
  }
  return v as GrantReason;
}

/**
 * «منح هدية» — grant a customer a gift of level 1–5: a level gift (the
 * customer chooses one of the level's items) or one product pinned now (a
 * level item by `itemId`, or any store product by `product`). The reason links
 * the grant to why; the note is internal and NEVER reaches the customer.
 * `idempotencyKey` makes a retried press the same grant.
 */
giftRoutes.post('/admin/grants', async (c) => {
  await rateLimit(c, 'gift_admin_grant', 60, 300);
  const admin = c.get('user')!;
  const body = await jsonObject(c);
  const userId = str(body.userId, 'userId', { min: 1, max: 80 });
  const mode = body.mode === 'product' ? 'product' : body.mode === 'level' ? 'level' : null;
  if (!mode) throw badRequest('mode must be level or product', 'GIFT_MODE_INVALID');
  const level = int(body.level, 'level', { min: 1, max: 5 });
  const reason = grantReason(body.reason);
  const note = str(body.note, 'note', { max: 1000, required: false });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  const itemId = mode === 'level' ? str(body.itemId, 'itemId', { max: 80, required: false }) : '';
  const productInput =
    mode === 'product' ? parseItemInput(body.product && typeof body.product === 'object' ? (body.product as Record<string, unknown>) : {}) : null;

  const hash = await requestHash({ userId, mode, level, reason, note, itemId, product: productInput });
  const replay = async () => {
    const prior = await c.env.DB.prepare('SELECT id, grant_request_hash FROM gift_entitlements WHERE grant_request_id = ?')
      .bind(idempotencyKey)
      .first<{ id: string; grant_request_hash: string | null }>();
    if (!prior) return null;
    if (prior.grant_request_hash !== hash) {
      throw conflict('This request key was already used for a different grant.', 'IDEMPOTENCY_KEY_REUSED');
    }
    return c.json({ success: true, grant: await loadAdminGift(c.env.DB, prior.id), replay: true });
  };
  const replayed = await replay();
  if (replayed) return replayed;

  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
  const levels = await loadLevels(c.env.DB);
  if (!levels.get(level)!.view.active) throw conflict('This gift level is switched off.', 'GIFT_LEVEL_INACTIVE');

  let pinned: Parameters<typeof planGrant>[1]['pinned'] = null;
  if (mode === 'level' && itemId) {
    const item = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(itemId).first<Record<string, unknown>>();
    const sel = item ? selectionFromColumns(item) : null;
    if (!item || !sel || Number(item.active) !== 1 || Number(item.level) !== level) {
      throw new HttpError(400, 'This item is not offered in that level.', 'GIFT_ITEM_UNAVAILABLE', { reason: 'ITEM_NOT_IN_LEVEL' });
    }
    const checked = checkGiftSelection(await loadGiftProduct(c.env, sel.productId), selectionInput(sel), { requireSellable: false });
    if (!checked.ok) throw itemRefusal(checked);
    pinned = { selection: checked.selection, snapshot: checked.snapshot, itemId };
  } else if (mode === 'product' && productInput) {
    const checked = validateItem(await loadGiftProduct(c.env, productInput.productId), productInput);
    if (!checked.ok) throw itemRefusal(checked);
    pinned = { selection: checked.selection, snapshot: checked.snapshot, itemId: null };
  } else {
    const live = await c.env.DB.prepare(
      `SELECT 1 AS x FROM gift_pool_items WHERE level = ? AND active = 1 AND product_id IS NOT NULL AND sale_type <> '' LIMIT 1`
    )
      .bind(level)
      .first();
    if (!live) throw conflict('This level offers no products yet — add one, or grant a specific product.', 'GIFT_LEVEL_EMPTY');
  }

  const now = new Date().toISOString();
  const plan = await planGrant(c.env.DB, {
    userId,
    level,
    reason,
    note,
    actorId: admin.id,
    pinned,
    requestId: idempotencyKey,
    requestHash: hash,
    now,
  });
  try {
    await c.env.DB.batch(plan.statements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('grant_request_id')) {
      const again = await replay();
      if (again) return again;
    }
    throw e;
  }
  waitUntil(c, notifyGiftGranted(c.env, plan.id));
  return c.json({ success: true, grant: await loadAdminGift(c.env.DB, plan.id) });
});

async function adminRow(db: D1Database, id: string): Promise<Record<string, unknown>> {
  const g = await loadGiftRow(db, id);
  if (!g) throw notFound('Gift not found');
  return g;
}

/** «تعديل الملاحظة / السبب» — internal note and the grant's reason. Audited with before and after. */
giftRoutes.patch('/admin/grants/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await jsonObject(c);
  const g = await adminRow(c.env.DB, id);
  const legacy = text(g.grant_mode || 'legacy') === 'legacy';
  const note = body.note !== undefined ? str(body.note, 'note', { max: 1000, required: false }) : text(g.admin_note);
  let reason = text(g.reason);
  if (body.reason !== undefined) {
    if (legacy) throw conflict('A legacy gift keeps its legacy reason.', 'GIFT_STATE');
    reason = grantReason(body.reason);
  }
  if (note === text(g.admin_note) && reason === text(g.reason)) {
    return c.json({ success: true, grant: await loadAdminGift(c.env.DB, id), unchanged: true });
  }
  const now = new Date().toISOString();
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.note', id, {
    user_id: text(g.user_id),
    level: g.level ?? null,
    actor: admin.id,
    before: { note: text(g.admin_note), reason: text(g.reason) },
    after: { note, reason },
  });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE gift_entitlements SET admin_note = ?, reason = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?'
      ).bind(note, reason, now, id, Number(g.version)),
      ...changedExactlyOne(c.env.DB),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isLostRace(e)) throw conflict('This gift changed while you were editing it — reload and try again.', 'GIFT_CHANGED');
    throw e;
  }
  return c.json({ success: true, grant: await loadAdminGift(c.env.DB, id) });
});

/**
 * «إلغاء الهدية» — a gift not ordered yet. Its cart line goes in the same
 * batch. An ORDERED gift is never cancelled here: cancel the order, and the
 * order trigger returns the gift; a delivered gift is history.
 */
async function cancelGift(c: Context<AppContext>, id: string, reasonText: string) {
  const admin = c.get('user')!;
  const g = await adminRow(c.env.DB, id);
  const legacy = text(g.grant_mode || 'legacy') === 'legacy';
  const state = text(g.state);
  if (state === 'ordered') {
    throw conflict('This gift is in an order — cancel the order instead; the gift then comes back to the customer.', 'GIFT_ALREADY_ORDERED');
  }
  const cancellable = legacy ? state === 'available' : ['granted', 'ready_to_redeem', 'redeemed'].includes(state);
  if (!cancellable) throw conflict('This gift can no longer be cancelled.', 'GIFT_STATE');
  const now = new Date().toISOString();
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.cancel', id, {
    user_id: text(g.user_id),
    level: g.level ?? g.max_level ?? null,
    actor: admin.id,
    from: state,
    reason: reasonText,
    product_id: g.gift_product_id ?? null,
  });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE gift_entitlements
            SET state = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND state = ? AND version = ?`
      ).bind(now, admin.id, reasonText, now, id, state, Number(g.version)),
      ...changedExactlyOne(c.env.DB),
      c.env.DB.prepare('DELETE FROM cart_items WHERE gift_entitlement_id = ?').bind(id),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isLostRace(e)) throw conflict('This gift changed meanwhile — reload and try again.', 'GIFT_CHANGED');
    throw e;
  }
}

giftRoutes.post('/admin/grants/:id/cancel', async (c) => {
  const id = c.req.param('id') ?? '';
  const body = await jsonObject(c);
  await cancelGift(c, id, str(body.reason, 'reason', { min: 3, max: 1000 }));
  return c.json({ success: true, grant: await loadAdminGift(c.env.DB, id) });
});

/**
 * «تحويل إلى النظام الجديد» — a legacy review box still `available` becomes a
 * LEVEL grant of its own level: the customer chooses one of the level's real
 * products and orders it through the cart.
 */
giftRoutes.post('/admin/grants/:id/convert', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await jsonObject(c);
  const g = await adminRow(c.env.DB, id);
  if (text(g.grant_mode || 'legacy') !== 'legacy' || g.state !== 'available') {
    throw conflict('Only a legacy gift that was never redeemed can be converted.', 'GIFT_NOT_CONVERTIBLE');
  }
  const level = body.level !== undefined ? int(body.level, 'level', { min: 1, max: 5 }) : Math.min(5, Math.max(1, Number(g.max_level) || 1));
  const reason = body.reason !== undefined ? grantReason(body.reason) : 'review';
  const note = str(body.note, 'note', { max: 1000, required: false });
  const now = new Date().toISOString();
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.convert', id, {
    user_id: text(g.user_id),
    actor: admin.id,
    level,
    reason,
    from: 'legacy:available',
    to: 'level:granted',
    reward_id: g.reward_id ?? null,
  });
  const words = { ar: `المستوى ${level}`, en: `level ${level}`, ckb: `ئاستی ${level}` };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE gift_entitlements
            SET grant_mode = 'level', state = 'granted', reason = ?, level = ?, granted_by = ?, granted_at = ?, updated_at = ?,
                admin_note = CASE WHEN ? <> '' THEN ? ELSE admin_note END, version = version + 1
          WHERE id = ? AND grant_mode = 'legacy' AND state = 'available' AND version = ?`
      ).bind(reason, level, admin.id, now, now, note, note, id, Number(g.version)),
      ...changedExactlyOne(c.env.DB),
      ...audit.statements,
      notifyStatement(c.env.DB, {
        userId: text(g.user_id),
        kind: 'gift_granted',
        title_ar: GIFT_COPY.ar.title,
        title_en: GIFT_COPY.en.title,
        body_ar: GIFT_COPY.ar.body(words.ar),
        body_en: GIFT_COPY.en.body(words.en),
        link: '/gifts',
        entity_type: 'gift',
        entity_id: id,
        meta: { level, title_ckb: GIFT_COPY.ckb.title, body_ckb: GIFT_COPY.ckb.body(words.ckb) },
        eventKey: `gift.granted:${id}`,
      }).stmt,
    ]);
  } catch (e) {
    if (isLostRace(e)) throw conflict('This gift changed meanwhile — reload and try again.', 'GIFT_CHANGED');
    throw e;
  }
  waitUntil(c, notifyGiftGranted(c.env, id));
  return c.json({ success: true, grant: await loadAdminGift(c.env.DB, id) });
});

/** «تم التسليم» for a legacy box handed over outside the order system (legacy `selected` only). */
async function fulfillLegacy(c: Context<AppContext>, id: string) {
  const admin = c.get('user')!;
  const g = await adminRow(c.env.DB, id);
  if (text(g.grant_mode || 'legacy') !== 'legacy' || g.state !== 'selected') {
    throw badRequest('Only a selected (redeemed) legacy gift can be marked fulfilled', 'GIFT_STATE');
  }
  const now = new Date().toISOString();
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.fulfill', id, {
    user_id: text(g.user_id),
    actor: admin.id,
    level: g.chosen_level ?? g.max_level ?? null,
  });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE gift_entitlements SET state = 'fulfilled', fulfilled_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND grant_mode = 'legacy' AND state = 'selected' AND version = ?`
      ).bind(now, now, id, Number(g.version)),
      ...changedExactlyOne(c.env.DB),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isLostRace(e)) throw conflict('This gift changed meanwhile — reload and try again.', 'GIFT_CHANGED');
    throw e;
  }
}

giftRoutes.post('/admin/grants/:id/fulfill', async (c) => {
  const id = c.req.param('id') ?? '';
  await fulfillLegacy(c, id);
  return c.json({ success: true, grant: await loadAdminGift(c.env.DB, id) });
});

// =========================================================================
//  THE OLD URLS — /api/reviews/gifts*, for clients cached before the move
// =========================================================================

/**
 * Mounted at `/api/reviews` beside `reviewRoutes`; no path overlaps a review
 * route. The customer's old screen reads the legacy shape and can only render
 * the four legacy states, so it is given exactly what it understood — the
 * legacy rows — and the redeem door works for both kinds.
 */
export const legacyGiftRoutes = new Hono<AppContext>();
legacyGiftRoutes.use('/admin/*', requireAdmin);

legacyGiftRoutes.get('/gifts', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT g.* FROM gift_entitlements g WHERE g.user_id = ? AND g.grant_mode = 'legacy' ORDER BY g.created_at DESC LIMIT 50`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const ctx = await viewContextFor(c.env, rows);
  return c.json({
    success: true,
    gifts: rows.map((g) => {
      const view = giftViewFrom(g, ctx);
      return view.legacy!;
    }),
  });
});

legacyGiftRoutes.post('/gifts/:entitlementId/redeem', requireAuth, async (c) => {
  await rateLimit(c, 'gift_redeem', 30, 3600);
  const user = c.get('user')!;
  const id = c.req.param('entitlementId') ?? '';
  const out = await redeem(c, id, await jsonObject(c));
  if (out.legacy) return c.json({ success: true, gift: out.legacy.gift, ...(out.legacy.replay ? { replay: true } : {}) });
  return c.json({ success: true, gift: out.gift ?? (await loadCustomerGift(c.env, user.id, id)), ...(out.replay ? { replay: true } : {}) });
});

legacyGiftRoutes.get('/admin/gifts', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ge.*, rr.review_id, rr.quality_score, r.product_id, u.email, u.username,
            p.name AS product_name, p.name_ar AS product_name_ar,
            gr.options AS redemption_options, gr.created_at AS redeemed_at_legacy
       FROM gift_entitlements ge
       LEFT JOIN review_rewards rr ON rr.id = ge.reward_id
       LEFT JOIN reviews r ON r.id = rr.review_id
       JOIN users u ON u.id = ge.user_id
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN gift_redemptions gr ON gr.entitlement_id = ge.id
      WHERE ge.grant_mode = 'legacy'
      ORDER BY ge.created_at DESC LIMIT 200`
  ).all<Record<string, unknown>>();
  return c.json({
    success: true,
    gifts: (results ?? []).map((ge) => ({
      ...legacyEntitlementView(ge, ge.redeemed_at_legacy ? { entitlement_id: ge.id } : null),
      customer: { email: ge.email, username: ge.username },
      review_id: ge.review_id ?? null,
      quality_score: ge.quality_score ?? null,
      redeemed_at: ge.redeemed_at_legacy ?? null,
    })),
  });
});

legacyGiftRoutes.post('/admin/gifts/:id/fulfill', async (c) => {
  await fulfillLegacy(c, c.req.param('id') ?? '');
  return c.json({ success: true });
});

legacyGiftRoutes.post('/admin/gifts/:id/cancel', async (c) => {
  const body = await jsonObject(c);
  await cancelGift(c, c.req.param('id') ?? '', str(body.reason, 'reason', { min: 5, max: 1000 }));
  return c.json({ success: true });
});

/** The legacy label-only pool editor, as it was — and never touching a product-backed item. */
legacyGiftRoutes.get('/admin/pools', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM gift_pool_items WHERE ${LEGACY_POOL_FILTER} ORDER BY level ASC, kind ASC, created_at ASC`
  ).all<PoolItemRow>();
  return c.json({ success: true, items: (results ?? []).map(poolItemView) });
});

legacyGiftRoutes.post('/admin/pools', async (c) => {
  const admin = c.get('user')!;
  const f = parsePoolItemBody(await jsonObject(c), false);
  const id = newId('gpi');
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.pool.create', id, f);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO gift_pool_items (id, level, kind, label_ar, label_en, label_ckb, brand, material, color, option_value, compat_products, stock, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, f.level, f.kind, f.label_ar, f.label_en ?? '', f.label_ckb ?? '', f.brand ?? '', f.material ?? '',
      f.color ?? '', f.option_value ?? '', f.compat_products ?? '[]', f.stock, f.active ?? 1
    ),
    ...audit.statements,
  ]);
  const row = await c.env.DB.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(id).first<PoolItemRow>();
  return c.json({ success: true, item: poolItemView(row!) });
});

async function legacyPoolRow(db: D1Database, itemId: string): Promise<PoolItemRow> {
  const row = await db.prepare(`SELECT * FROM gift_pool_items WHERE id = ? AND ${LEGACY_POOL_FILTER}`).bind(itemId).first<PoolItemRow>();
  if (!row) throw notFound('Pool item not found');
  return row;
}

legacyGiftRoutes.put('/admin/pools/:itemId', async (c) => {
  const admin = c.get('user')!;
  const itemId = c.req.param('itemId') ?? '';
  const existing = await legacyPoolRow(c.env.DB, itemId);
  const f = parsePoolItemBody(await jsonObject(c), true);
  const keys = Object.keys(f);
  if (keys.length === 0) throw badRequest('Nothing to update');
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.pool.update', itemId, {
    before: { stock: existing.stock, active: existing.active },
    changes: f,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE gift_pool_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND ${LEGACY_POOL_FILTER}`)
      .bind(...keys.map((k) => f[k]), itemId),
    ...audit.statements,
  ]);
  return c.json({ success: true, item: poolItemView(await legacyPoolRow(c.env.DB, itemId)) });
});

legacyGiftRoutes.delete('/admin/pools/:itemId', async (c) => {
  const admin = c.get('user')!;
  const itemId = c.req.param('itemId') ?? '';
  const existing = await legacyPoolRow(c.env.DB, itemId);
  // Granted gifts keep their own contents snapshot — deleting a legacy pool
  // item never touches an existing entitlement or redemption.
  const audit = await auditStatements(c.env.DB, admin.id, 'gift.pool.delete', itemId, {
    label_ar: existing.label_ar,
    level: existing.level,
    stock: existing.stock,
  });
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM gift_pool_items WHERE id = ? AND ${LEGACY_POOL_FILTER}`).bind(itemId),
    ...audit.statements,
  ]);
  return c.json({ success: true });
});
