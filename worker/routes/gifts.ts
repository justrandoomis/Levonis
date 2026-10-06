import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAdmin, requireAuth, badRequest, notFound, conflict, unavailable, str, int, oneOf, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit, auditStatements } from '../lib/audit';
import { pumpAfter } from '../lib/eventBus';
import { mediaUrl, parseEvidence, publicMedia } from '../lib/reviews/media';
import { getReviewPointsValue, reviewAward } from '../lib/reviews/points';
import { giftDiagnostics, printerGiftFamily, type GiftDiagnostics } from '../lib/reviews/eligibility';
import { catalogIndexFor } from '../lib/catalogPresentation';
import { loadAuthoritativeProductImages } from '../lib/productSelectionImage';
import { canonicalOptionValueIds, optionValueIdsJson } from '../lib/cartSelectionIdentity';
import {
  GIFT_CODE_MAX_ATTEMPTS,
  generateGiftCode,
  giftCodeVerifier,
  normalizeGiftCodeInput,
  verifyGiftCode,
} from '../lib/gifts/codes';
import {
  GIFT_ELIGIBILITY_FENCE_SQL,
  GIFT_ROW_SELECT,
  adminGiftFields,
  giftStillEligible,
  giftViewFromRow,
  loadCustomerGifts,
  loadGiftView,
  parseGiftSnapshot,
  printerImagesFor,
  type GiftGrantMode,
  type GiftSnapshot,
  type GiftSnapshotItem,
} from '../lib/gifts/entitlements';
import {
  GIFT_MAX_ALLOWED,
  GIFT_MAX_OPTION_VALUES,
  GIFT_TRANSPORTS,
  checkGiftSelection,
  checkLevelItem,
  giftOptionsProjection,
  levelItemInputFromRow,
  loadGiftProduct,
  manualSnapshotItem,
  snapshotItemFor,
  type GiftProductContext,
  type GiftSelectionInput,
  type GiftTransport,
  type LevelItemInput,
} from '../lib/gifts/levels';

/**
 * THE GIFT ROUTES (docs/REVIEWS_GIFTS.md §2, §6.2). Owner: lane S2. Mounted at
 * /api/reviews in worker/index.ts beside `reviewRoutes`; no path overlaps.
 *
 *   customer  GET  /gifts                         the cards, ui_state derived HERE
 *             POST /gifts/:entitlementId/redeem   the 6-digit code → ready to order (no order, no cart)
 *             POST /gifts/:entitlementId/choose   a level gift's item, from the frozen snapshot only
 *   admin     GET  /admin/queue                    the printer-gift queue (facts, no predicted level)
 *             POST /admin/:id/reward               reject / request changes / points / ISSUE (level 1–5 + code)
 *             GET  /admin/gifts                    granted gifts (never a code)
 *             POST /admin/gifts/:id/issue          convert a legacy `available` gift by issuing a code
 *             POST /admin/gifts/:id/revoke-code    the code dies; the gift waits for a re-issue
 *             POST /admin/gifts/:id/reissue-code   a new code (old one dead), shown once
 *             POST /admin/gifts/:id/cancel         the gift, its live code and its cart line, together
 *             POST /admin/gifts/:id/fulfill        legacy `selected` only
 *             GET|POST /admin/pools, PUT /admin/pools/reorder, POST /admin/pools/preview,
 *             PUT|DELETE /admin/pools/:itemId, GET /admin/gift-options/:productId — the five levels
 *
 * Separation of concerns (unchanged): PUBLIC review moderation (reviews.status,
 * reviews.ts) is a different decision from REWARD approval (review_rewards.state,
 * here). A rejected reward never unpublishes a review.
 *
 * THE CODE. Six digits from a CSPRNG; only a PBKDF2 verifier is stored; the raw
 * code is in exactly two responses (issue and re-issue), sent `no-store`, and in
 * no table, log, audit row or notification.
 */

export const giftRoutes = new Hono<AppContext>();
giftRoutes.use('/admin/*', requireAdmin);

// ------------------------------------------------------------------ helpers

const nowIso = () => new Date().toISOString();
const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const jsonBody = async (c: Context<AppContext>) => {
  const body = await c.req.json().catch(() => ({}));
  return (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
};

/** A constraint, CHECK, UNIQUE or NOT NULL abort — the shape every lost race below takes. */
function isConstraintError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /constraint|UNIQUE|CHECK|NOT NULL|PRIMARY KEY/i.test(msg);
}

/**
 * ROLLS THE WHOLE BATCH BACK unless entitlement ?1 is now in the state this
 * request wrote. D1 does not fail a batch for an UPDATE that matched no row, so
 * without this the audit row after a lost race would record a transition that
 * never happened. The abort is the table's own CHECK (code_attempts >= 0): the
 * fence writes -1 only into a row that is NOT in the expected state (NULL
 * counts as not expected).
 */
function entitlementFence(db: D1Database, entitlementId: string, expectSql: string, binds: unknown[]): D1PreparedStatement {
  return db
    .prepare(`UPDATE gift_entitlements SET code_attempts = -1 WHERE id = ?1 AND NOT COALESCE((${expectSql}), 0)`)
    .bind(entitlementId, ...binds);
}

/** The admin's selection refusal, with the store's own codes for the form. */
const selectionRefusal = (code: string, errors: string[]) =>
  new HttpError(400, `The gift selection was refused (${code}).`, code, { errors });

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;
function requestIdOf(v: unknown): string {
  const id = typeof v === 'string' ? v.trim() : '';
  if (!REQUEST_ID.test(id)) throw badRequest('requestId must be 8–80 letters, digits or . _ : -', 'VALIDATION');
  return id;
}

/** An untrusted id list: strings only, bounded, canonical. */
function idList(v: unknown, name: string, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 80)) {
    throw badRequest(`${name} must be a list of at most ${max} ids`, 'GIFT_SELECTION_INVALID', { errors: ['INVALID_IDS'] });
  }
  return canonicalOptionValueIds(v);
}

function transportOf(v: unknown): GiftTransport {
  const t = v === undefined || v === null ? '' : v;
  if (typeof t !== 'string' || !GIFT_TRANSPORTS.includes(t as GiftTransport)) {
    throw badRequest('transportMethod must be air, sea or land', 'GIFT_SELECTION_INVALID', { errors: ['TRANSPORT_INVALID'] });
  }
  return t as GiftTransport;
}

function saleTypeOf(v: unknown): 'direct_sale' | 'pre_order' {
  if (v !== 'direct_sale' && v !== 'pre_order') {
    throw badRequest('saleType must be direct_sale or pre_order', 'GIFT_SALE_TYPE_UNAVAILABLE', { errors: ['SALE_TYPE_INVALID'] });
  }
  return v;
}

/** A complete selection from an untrusted body (the manual gift, the preview). Ids are checked by the store rule later. */
function selectionInputOf(raw: unknown): GiftSelectionInput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    productId: str(o.productId, 'productId', { min: 1, max: 80 }),
    saleType: saleTypeOf(o.saleType),
    optionValueIds: idList(o.optionValueIds, 'optionValueIds', GIFT_MAX_OPTION_VALUES),
    colorId: str(o.colorId, 'colorId', { max: 80, required: false }),
    transportMethod: transportOf(o.transportMethod),
  };
}

/** The level: chosen by the admin, every time — no default, no fallback, no predicted tier. */
function levelOf(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[1-5]$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 5) throw badRequest('Choose the gift level, 1 to 5', 'GIFT_LEVEL_REQUIRED');
  return n;
}

interface IssueInput {
  level: number;
  mode: 'level' | 'manual';
  manual: GiftSelectionInput | null;
  note: string;
  requestId: string;
}

function issueInputOf(body: Record<string, unknown>): IssueInput {
  const level = levelOf(body.level);
  if (body.mode !== 'level' && body.mode !== 'manual') {
    throw badRequest('Choose «use the level’s gifts» or «choose a gift manually»', 'GIFT_MODE_REQUIRED');
  }
  const mode = body.mode;
  const requestId = requestIdOf(body.requestId);
  const manual = mode === 'manual' ? selectionInputOf(body.manual) : null;
  const note = str(body.note ?? body.reason, 'note', { max: 1000, required: false });
  return { level, mode, manual, note, requestId };
}

interface Grant {
  snapshot: GiftSnapshot;
  /** The one item fixed at issue (manual, or a single level item with nothing to pick). */
  fixed: GiftSnapshotItem | null;
  /** Level items left out because the store refuses them today (archived, selection gone). */
  skipped: Array<{ id: string; code: string; errors: string[] }>;
}

/**
 * WHAT IS GRANTED, frozen. A level gift snapshots every ACTIVE product item of
 * that level that the store still accepts (configuration, not stock); a manual
 * gift is one product, fully pinned. Later edits to the product or the level
 * never reach a granted gift: the card reads this snapshot.
 */
async function buildGrant(env: { DB: D1Database }, level: number, mode: 'level' | 'manual', manual: GiftSelectionInput | null): Promise<Grant> {
  if (mode === 'manual') {
    const r = manualSnapshotItem(await loadGiftProduct(env, manual!.productId), manual!);
    if (!r.ok) throw selectionRefusal(r.code, r.errors);
    return { snapshot: { v: 1, mode: 'manual', level, items: [r.item] }, fixed: r.item, skipped: [] };
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM gift_pool_items
      WHERE level = ? AND active = 1 AND product_id IS NOT NULL
      ORDER BY sort ASC, created_at ASC, id ASC`
  )
    .bind(level)
    .all<Record<string, unknown>>();
  const products = new Map<string, GiftProductContext>();
  const items: GiftSnapshotItem[] = [];
  const skipped: Grant['skipped'] = [];
  for (const row of results) {
    const input = levelItemInputFromRow(row);
    let p = products.get(input.productId);
    if (!p) {
      p = await loadGiftProduct(env, input.productId);
      products.set(input.productId, p);
    }
    const r = snapshotItemFor(p, text(row.id), text(row.id), input);
    if (r.ok) items.push(r.item);
    else skipped.push({ id: text(row.id), code: r.code, errors: r.errors });
  }
  if (items.length === 0) {
    throw badRequest(`Level ${level} has no active gifts — add a product or choose a gift manually`, 'GIFT_LEVEL_EMPTY', { skipped });
  }
  const only = items.length === 1 ? items[0] : null;
  const fixed = only && only.allowed_option_value_ids.length === 0 && only.allowed_color_ids.length === 0 ? only : null;
  return { snapshot: { v: 1, mode: 'level', level, items }, fixed, skipped };
}

/** The issue / re-issue answer: the ONLY place the raw code ever leaves the server. */
function issuedResponse(
  c: Context<AppContext>,
  body: {
    review_id: string;
    entitlement: { id: string; level: number; grant_mode: GiftGrantMode };
    code: string;
    issuedAt: string;
    issuedBy: string;
    skipped?: Grant['skipped'];
  }
) {
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    review_id: body.review_id,
    reward_state: 'approved',
    entitlement: { id: body.entitlement.id, state: 'code_issued', level: body.entitlement.level, grant_mode: body.entitlement.grant_mode },
    code: body.code,
    code_issued_at: body.issuedAt,
    code_issued_by: body.issuedBy,
    ...(body.skipped && body.skipped.length ? { skipped: body.skipped } : {}),
  });
}

/** A retried request (same requestId): the same entitlement, and NO code — it was shown once. */
function replayResponse(c: Context<AppContext>, reviewId: string, ent: Record<string, unknown>) {
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    replay: true,
    review_id: reviewId,
    reward_state: 'approved',
    entitlement: {
      id: text(ent.id),
      state: text(ent.state),
      level: Number(ent.chosen_level ?? ent.max_level) || Number(ent.max_level) || 0,
      grant_mode: text(ent.grant_mode) as GiftGrantMode,
    },
    code: null,
  });
}

const ENT_BRIEF = 'SELECT id, state, grant_mode, max_level, chosen_level, code_request_id FROM gift_entitlements';

// ================================================================== customer

/** GET /api/reviews/gifts — my gifts, each with its server-derived ui_state, and the quiet pending cards. */
giftRoutes.get('/gifts', requireAuth, async (c) => {
  const user = c.get('user')!;
  const { gifts, pending } = await loadCustomerGifts(c.env, user.id);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, gifts, pending });
});

/**
 * POST /api/reviews/gifts/:entitlementId/redeem {code}
 *
 * The code is THIS user's and THIS entitlement's, unused, not revoked, not
 * locked, and the review → reward → unit chain still holds (re-checked here and
 * again inside the writing statement). Consumed in one batch: two concurrent
 * correct submissions → exactly one success. Every failure — wrong, used,
 * revoked, locked, someone else's, unknown, broken chain — is the SAME 400
 * GIFT_CODE_INVALID, so the answer never says whose a code is. No order and no
 * cart line are created: the gift becomes ready to order.
 */
giftRoutes.post('/gifts/:entitlementId/redeem', requireAuth, async (c) => {
  await rateLimit(c, 'gift_code', 5, 900);
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  await rateLimit(c, 'gift_code_ip', 20, 3600, `ip:${ip}`);
  const user = c.get('user')!;
  const db = c.env.DB;
  const entId = (c.req.param('entitlementId') ?? '').slice(0, 80);
  const body = await jsonBody(c);
  const invalid = () => badRequest('The code is incorrect or no longer valid.', 'GIFT_CODE_INVALID');
  const code = normalizeGiftCodeInput(body.code);
  // Not six digits: nothing to compare, so no attempt is spent on a typo.
  if (!code) throw invalid();

  // 1. Claim an attempt BEFORE comparing (the auth-OTP rule): the fifth try is
  //    the last, whatever happens to the comparison.
  const claim = await db
    .prepare(
      `UPDATE gift_entitlements SET code_attempts = code_attempts + 1, updated_at = ?3
        WHERE id = ?1 AND user_id = ?2 AND state = 'code_issued' AND code_state = 'issued' AND code_attempts < ?4
       RETURNING code_attempts, code_version, code_verifier, reward_id, max_level, chosen_level, grant_mode`
    )
    .bind(entId, user.id, nowIso(), GIFT_CODE_MAX_ATTEMPTS)
    .first<{
      code_attempts: number;
      code_version: number;
      code_verifier: string | null;
      reward_id: string;
      max_level: number;
      chosen_level: number | null;
      grant_mode: string;
    }>();
  if (!claim) {
    await audit(db, user.id, 'gift.redeem.refused', entId || '-', { reason: 'not_redeemable' });
    throw invalid();
  }

  // 2. Compare, in constant time, against the verifier of THIS entitlement.
  if (!(await verifyGiftCode(entId, code, claim.code_verifier))) {
    const locked = Number(claim.code_attempts) >= GIFT_CODE_MAX_ATTEMPTS;
    await audit(db, user.id, locked ? 'gift.code.locked' : 'gift.redeem.failed', entId, {
      attempts: Number(claim.code_attempts),
      code_version: Number(claim.code_version),
    });
    throw invalid();
  }

  // 3. The chain still holds: the unit is still the reviewer's and registered
  //    to them, the review is still 5★ and published (legacy: still theirs).
  if (!(await giftStillEligible(db, claim.reward_id))) {
    await audit(db, user.id, 'gift.redeem.blocked', entId, { reason: 'eligibility_changed', code_version: Number(claim.code_version) });
    throw invalid();
  }

  // 4. Consume — ONE batch. The UPDATE carries every precondition (owner,
  //    state, code version, the eligibility fence); the redemption row's user
  //    comes from the row THIS update just wrote, so a lost race inserts NULL,
  //    aborts the batch, and writes no audit row. Its primary key makes the
  //    redemption happen once, for ever.
  const at = nowIso();
  const level = Number(claim.chosen_level ?? claim.max_level) || Number(claim.max_level);
  const redeemAudit = await auditStatements(db, user.id, 'gift.redeem', entId, {
    reward_id: claim.reward_id,
    code_version: Number(claim.code_version),
  });
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE gift_entitlements
              SET state = 'redeemed_ready_to_order', code_state = 'redeemed', code_redeemed_at = ?4, updated_at = ?4
            WHERE id = ?2 AND user_id = ?3 AND reward_id = ?1
              AND state = 'code_issued' AND code_state = 'issued' AND code_version = ?5
              AND ${GIFT_ELIGIBILITY_FENCE_SQL}`
        )
        .bind(claim.reward_id, entId, user.id, at, Number(claim.code_version)),
      db
        .prepare(
          `INSERT INTO gift_redemptions (entitlement_id, user_id, level, options, contents, created_at)
           VALUES (?1,
                   (SELECT g.user_id FROM gift_entitlements g
                     WHERE g.id = ?1 AND g.user_id = ?2 AND g.state = 'redeemed_ready_to_order'
                       AND g.code_state = 'redeemed' AND g.code_redeemed_at = ?3 AND g.code_version = ?4),
                   ?5, ?6, '[]', ?3)`
        )
        .bind(entId, user.id, at, Number(claim.code_version), level, JSON.stringify({ code_version: Number(claim.code_version), grant_mode: claim.grant_mode })),
      ...redeemAudit.statements,
    ]);
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    throw invalid();
  }
  pumpAfter(db, [redeemAudit.eventId]);
  const gift = await loadGiftView(c.env, entId);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, gift });
});

/**
 * POST /api/reviews/gifts/:entitlementId/choose {ref, optionValueIds?, colorId?}
 *
 * A LEVEL gift's item, from the snapshot frozen at issue: one of its items, the
 * pins as the admin set them (never overridable), and only the values and
 * colours the admin allowed. The store's own rule judges the result. A manual
 * gift is fixed and cannot be swapped. Changing a choice is allowed until the
 * gift is in the cart.
 */
giftRoutes.post('/gifts/:entitlementId/choose', requireAuth, async (c) => {
  await rateLimit(c, 'gift_choose', 30, 300);
  const user = c.get('user')!;
  const db = c.env.DB;
  const entId = (c.req.param('entitlementId') ?? '').slice(0, 80);
  const ge = await db
    .prepare(
      `SELECT ge.*, (SELECT ci.id FROM cart_items ci WHERE ci.gift_entitlement_id = ge.id) AS cart_item_id
         FROM gift_entitlements ge WHERE ge.id = ? AND ge.user_id = ?`
    )
    .bind(entId, user.id)
    .first<Record<string, unknown>>();
  const refuseState = (row: Record<string, unknown> | null): never => {
    if (!row || text(row.grant_mode) === 'legacy' || text(row.state) === 'cancelled') {
      throw new HttpError(404, 'We could not find this gift on your account.', 'GIFT_NOT_FOUND');
    }
    if (text(row.state) === 'code_issued') throw conflict('Enter the gift code first to redeem it.', 'GIFT_NOT_REDEEMED');
    if (text(row.state) === 'ordered' || text(row.state) === 'fulfilled') {
      throw conflict('This gift has already been ordered.', 'GIFT_ALREADY_ORDERED');
    }
    if (text(row.cart_item_id)) throw conflict('The gift is in your cart. Remove it to change your choice.', 'GIFT_IN_CART');
    throw badRequest('This choice is not available for this gift.', 'GIFT_CHOICE_INVALID');
  };
  if (!ge || text(ge.state) !== 'redeemed_ready_to_order' || text(ge.cart_item_id)) refuseState(ge);
  const invalid = (errors: string[]) =>
    new HttpError(400, 'This choice is not available for this gift.', 'GIFT_CHOICE_INVALID', { errors });
  if (text(ge!.grant_mode) !== 'level') throw invalid(['GIFT_FIXED']);

  const body = await jsonBody(c);
  const ref = str(body.ref, 'ref', { min: 1, max: 80 });
  const item = parseGiftSnapshot(ge!.gift_snapshot)?.items.find((i) => i.ref === ref) ?? null;
  if (!item) throw invalid(['ITEM_NOT_IN_GIFT']);
  let picks: string[];
  try {
    picks = idList(body.optionValueIds, 'optionValueIds', GIFT_MAX_OPTION_VALUES);
  } catch {
    throw invalid(['INVALID_IDS']);
  }
  if (picks.some((id) => !item.allowed_option_value_ids.includes(id))) throw invalid(['OPTION_NOT_ALLOWED']);
  const askedColor = typeof body.colorId === 'string' ? body.colorId.trim() : '';
  let colorId: string;
  if (item.color_id) {
    if (askedColor && askedColor !== item.color_id) throw invalid(['COLOR_PINNED']);
    colorId = item.color_id;
  } else if (item.allowed_color_ids.length) {
    if (!item.allowed_color_ids.includes(askedColor)) throw invalid(['COLOR_NOT_ALLOWED']);
    colorId = askedColor;
  } else {
    if (askedColor) throw invalid(['COLOR_NOT_ALLOWED']);
    colorId = '';
  }
  const selection = canonicalOptionValueIds([...item.option_value_ids, ...picks]);
  const r = checkGiftSelection(
    await loadGiftProduct(c.env, item.product_id),
    { productId: item.product_id, saleType: item.sale_type, optionValueIds: selection, colorId, transportMethod: item.transport_method },
    { requireSellable: false }
  );
  if (!r.ok) throw invalid(r.errors.length ? r.errors : [r.code]);

  const res = await db
    .prepare(
      `UPDATE gift_entitlements
          SET gift_item_ref = ?3, gift_product_id = ?4, gift_option_value_ids = ?5, gift_color_id = ?6,
              gift_sale_type = ?7, gift_transport_method = ?8, updated_at = ?9
        WHERE id = ?1 AND user_id = ?2 AND state = 'redeemed_ready_to_order' AND grant_mode = 'level'
          AND NOT EXISTS (SELECT 1 FROM cart_items ci WHERE ci.gift_entitlement_id = ?1)`
    )
    .bind(entId, user.id, item.ref, item.product_id, optionValueIdsJson(r.canonical.optionValueIds), r.canonical.colorId, item.sale_type, item.transport_method, nowIso())
    .run();
  if (res.meta.changes === 0) {
    refuseState(
      await db
        .prepare(
          `SELECT ge.*, (SELECT ci.id FROM cart_items ci WHERE ci.gift_entitlement_id = ge.id) AS cart_item_id
             FROM gift_entitlements ge WHERE ge.id = ? AND ge.user_id = ?`
        )
        .bind(entId, user.id)
        .first<Record<string, unknown>>()
    );
  }
  const gift = await loadGiftView(c.env, entId);
  return c.json({ success: true, gift });
});

// ============================================================== admin: queue

interface QueueRow {
  [k: string]: unknown;
}

/** Advice only: the quality score, its reasons and its signals — never a tier or a level. */
function qualityAdvice(raw: unknown) {
  const q = safeParse<Record<string, unknown> | null>(raw, null);
  if (!q || typeof q !== 'object') return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    score: typeof q.score === 'number' ? q.score : null,
    reasons: list(q.reasons),
    signals: list(q.suspiciousSignals ?? q.signals),
  };
}

const QUEUE_STATES = ['submitted', 'revision_needed', 'approved', 'rejected', 'all'] as const;
const QUEUE_PAGE = 30;

/**
 * GET /api/reviews/admin/queue?state=&cursor= — the gift queue (brief §3):
 * the full review with every image and video, the customer, the printer and
 * its own section, the order and line, the unit, its serial and receipt, who
 * holds its registration, the eligibility snapshot and the ten conditions as
 * they stand NOW, any prior reward on the unit, the decision and the granted
 * gift's code bookkeeping. NO predicted level anywhere.
 */
giftRoutes.get('/admin/queue', async (c) => {
  const db = c.env.DB;
  const stateQ = c.req.query('state') || 'submitted';
  const state = (QUEUE_STATES as readonly string[]).includes(stateQ) ? stateQ : 'submitted';
  const [afterAt, afterId] = (c.req.query('cursor') ?? '').split('|');
  const { results } = await db
    .prepare(
      `SELECT rr.id AS reward_id, rr.kind, rr.state AS reward_state, rr.quality_score, rr.quality_snapshot, rr.eligibility,
              rr.instagram_evidence, rr.reason, rr.points_awarded, rr.decided_by, rr.decided_at, rr.created_at AS reward_created_at,
              rr.unit_id, rr.user_id,
              r.id AS review_id, r.stars, r.body, r.media, r.status AS review_status, r.source, r.moderation_note,
              r.created_at AS review_created_at,
              COALESCE(rr.product_id, r.product_id) AS product_id,
              COALESCE(rr.order_id, r.order_id) AS order_id,
              COALESCE(rr.order_item_id, r.order_item_id) AS order_item_id,
              u.email, u.username, u.name AS user_name,
              p.name AS product_name, p.name_ar AS product_name_ar, p.name_ku AS product_name_ckb,
              p.category_id, p.sub_category_id, p.template_family,
              o.status AS order_status, o.delivered_at AS order_delivered_at,
              oi.name_snapshot, oi.option_snapshot,
              un.unit_index, un.delivered_at AS unit_delivered_at, un.warranty_end_at, un.replaced_by_unit_id,
              (SELECT ds.serial_raw FROM device_serials ds WHERE ds.unit_id = rr.unit_id) AS serial_raw,
              (SELECT wr.receipt_no FROM warranty_receipts wr
                WHERE wr.unit_id = rr.unit_id AND wr.status = 'active'
                ORDER BY wr.issued_at DESC LIMIT 1) AS receipt_no,
              dr.user_id AS reg_user_id, dr.registered_at AS reg_at, dr.revoked_at AS reg_revoked_at,
              ge.id AS ent_id, ge.state AS ent_state, ge.grant_mode AS ent_grant_mode, ge.max_level AS ent_max_level,
              ge.chosen_level AS ent_chosen_level, ge.code_state AS ent_code_state, ge.code_attempts AS ent_code_attempts,
              ge.code_issued_at AS ent_code_issued_at, ge.code_issued_by AS ent_code_issued_by,
              ge.code_redeemed_at AS ent_code_redeemed_at
         FROM review_rewards rr
         JOIN reviews r ON r.id = rr.review_id
         JOIN users u ON u.id = rr.user_id
         LEFT JOIN products p ON p.id = COALESCE(rr.product_id, r.product_id)
         LEFT JOIN orders o ON o.id = COALESCE(rr.order_id, r.order_id)
         LEFT JOIN order_items oi ON oi.id = COALESCE(rr.order_item_id, r.order_item_id)
         LEFT JOIN order_item_units un ON un.id = rr.unit_id
         LEFT JOIN device_registrations dr ON dr.unit_id = rr.unit_id
         LEFT JOIN gift_entitlements ge ON ge.reward_id = rr.id
        WHERE (?1 = 'all' OR rr.state = ?1)
          AND (?2 = '' OR rr.created_at > ?2 OR (rr.created_at = ?2 AND rr.id > ?3))
        ORDER BY rr.created_at ASC, rr.id ASC
        LIMIT ?4`
    )
    .bind(state, afterAt ?? '', afterId ?? '', QUEUE_PAGE)
    .all<QueueRow>();

  const productIds = [...new Set(results.map((r) => text(r.product_id)).filter(Boolean))];
  const [idx, images, pointsValue, diagnostics] = await Promise.all([
    catalogIndexFor(db),
    loadAuthoritativeProductImages(db, productIds),
    getReviewPointsValue(db),
    Promise.all(
      results.map(async (r) => {
        try {
          return await giftDiagnostics(db, text(r.review_id));
        } catch (e) {
          console.error('gift diagnostics unavailable', e instanceof Error ? e.message : String(e));
          return null;
        }
      })
    ),
  ]);

  const queue = results.map((r, i) => {
    const live: GiftDiagnostics | null = diagnostics[i] ?? null;
    const legacy = !text(r.unit_id);
    const leaf = text(r.sub_category_id) || text(r.category_id);
    const section = leaf ? idx.byId.get(leaf) ?? null : null;
    const evidence = parseEvidence(r.instagram_evidence);
    const approved = text(r.reward_state) === 'approved';
    // The reward's own unit when it has one; a legacy reward shows the unit the
    // live diagnostics resolved for the review.
    const unit = !legacy
      ? {
          id: text(r.unit_id),
          unit_index: Number(r.unit_index ?? 0),
          delivered_at: r.unit_delivered_at == null ? null : text(r.unit_delivered_at),
          warranty_end_at: r.warranty_end_at == null ? null : text(r.warranty_end_at),
          replaced_by_unit_id: r.replaced_by_unit_id == null ? null : text(r.replaced_by_unit_id),
        }
      : live?.unit
        ? {
            id: live.unit.id,
            unit_index: live.unit.unit_index,
            delivered_at: live.unit.delivered_at ?? null,
            warranty_end_at: live.unit.warranty_end_at ?? null,
            replaced_by_unit_id: live.unit.replaced_by_unit_id ?? null,
          }
        : null;
    const registration: { state: 'reviewer' | 'other' | 'released' | 'none'; registered_at: string | null } = !legacy
      ? !text(r.reg_user_id)
        ? { state: 'none', registered_at: null }
        : r.reg_revoked_at
          ? { state: 'released', registered_at: text(r.reg_at) || null }
          : { state: text(r.reg_user_id) === text(r.user_id) ? 'reviewer' : 'other', registered_at: text(r.reg_at) || null }
      : { state: live?.unit?.registration ?? 'none', registered_at: live?.unit?.registered_at ?? null };
    return {
      review: {
        id: text(r.review_id),
        stars: Number(r.stars),
        body: text(r.body),
        media: publicMedia(r.media),
        created_at: text(r.review_created_at),
        status: text(r.review_status),
        source: text(r.source) || 'user',
        moderation_note: text(r.moderation_note),
      },
      user: { id: text(r.user_id), email: text(r.email), username: text(r.username), name: text(r.user_name) },
      product: {
        id: text(r.product_id),
        name: text(r.product_name),
        name_ar: text(r.product_name_ar) || text(r.product_name),
        name_ckb: text(r.product_name_ckb) || text(r.product_name_ar) || text(r.product_name),
        image: images.get(text(r.product_id)) ?? '',
        family: live?.family ?? printerGiftFamily(r, idx),
        section: section ? { id: section.id, name_ar: section.name_ar, name_en: section.name_en, name_ckb: section.name_ckb } : null,
      },
      order: text(r.order_id)
        ? { id: text(r.order_id), status: text(r.order_status), delivered_at: r.order_delivered_at == null ? null : text(r.order_delivered_at) }
        : null,
      order_item: text(r.order_item_id)
        ? { id: text(r.order_item_id), name_snapshot: text(r.name_snapshot), option_snapshot: text(r.option_snapshot) }
        : null,
      unit,
      serial: !legacy ? (r.serial_raw == null ? null : text(r.serial_raw)) : live?.unit?.serial ?? null,
      receipt_no: !legacy ? (r.receipt_no == null ? null : text(r.receipt_no)) : live?.unit?.receipt_no ?? null,
      registration,
      eligibility: { snapshot: safeParse<Record<string, unknown>>(r.eligibility, {}), live },
      prior_reward: live?.prior_reward ?? null,
      reward: {
        id: text(r.reward_id),
        kind: text(r.kind),
        state: text(r.reward_state),
        // Only a DECIDED level. A pre-0165 pending row carries the predicted
        // tier in quality_score; it is never shown as a level.
        level: approved && r.quality_score != null ? Number(r.quality_score) : null,
        decided_by: r.decided_by == null ? null : text(r.decided_by),
        decided_at: r.decided_at == null ? null : text(r.decided_at),
        reason: text(r.reason),
        points_awarded: Number(r.points_awarded) || 0,
      },
      entitlement: text(r.ent_id)
        ? {
            id: text(r.ent_id),
            state: text(r.ent_state),
            grant_mode: text(r.ent_grant_mode),
            level: Number(r.ent_chosen_level ?? r.ent_max_level) || Number(r.ent_max_level) || 0,
            code_state: text(r.ent_code_state),
            code_attempts: Number(r.ent_code_attempts) || 0,
            code_issued_at: r.ent_code_issued_at == null ? null : text(r.ent_code_issued_at),
            code_issued_by: r.ent_code_issued_by == null ? null : text(r.ent_code_issued_by),
            code_redeemed_at: r.ent_code_redeemed_at == null ? null : text(r.ent_code_redeemed_at),
          }
        : null,
      legacy,
      // Private evidence of a legacy reward — this endpoint is admin-only.
      instagram: legacy && evidence ? { link: evidence.link, file_url: evidence.key ? mediaUrl(evidence.key) : null } : null,
      quality: qualityAdvice(r.quality_snapshot),
    };
  });
  const last = results[results.length - 1];
  return c.json({
    success: true,
    state,
    queue,
    next_cursor: results.length === QUEUE_PAGE && last ? `${text(last.reward_created_at)}|${text(last.reward_id)}` : null,
    review_points_configured: pointsValue,
  });
});

// =========================================================== admin: decision

/**
 * POST /api/reviews/admin/:id/reward — the reward decision (:id = review id).
 *   reject / request_changes {action, reason≥3}: unchanged.
 *   approve, kind 'points': unchanged (the configured base × the REVIEWER's multiplier).
 *   approve, kind 'printer_gift' = ISSUE {level 1–5, mode, manual?, note?, requestId}:
 *     re-check → snapshot → code → ONE batch (reward approved + entitlement
 *     code_issued with its snapshot and verifier + audit) → the raw code ONCE.
 */
giftRoutes.post('/admin/:id/reward', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await jsonBody(c);
  const action = oneOf(body.action, 'action', ['approve', 'reject', 'request_changes'] as const);

  const row = await c.env.DB.prepare(
    `SELECT r.id AS review_id, r.user_id, r.source,
            rr.id AS reward_id, rr.kind, rr.state, rr.unit_id
       FROM reviews r
       JOIN review_rewards rr ON rr.review_id = r.id
      WHERE r.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Review not found');
  if ((row.source ?? 'user') === 'system') throw badRequest('System-generated reviews cannot receive rewards', 'SYSTEM_REVIEW_NO_REWARD');
  if (action === 'approve' && row.kind === 'printer_gift') return issueForReward(c, row, issueInputOf(body));
  if (row.state === 'approved') {
    throw conflict('This reward was already approved — granted rewards are preserved, not re-decided');
  }
  const now = nowIso();

  if (action !== 'approve') {
    const reason = str(body.reason, 'reason', { min: 3, max: 1000 });
    const nextState = action === 'reject' ? 'rejected' : 'revision_needed';
    const res = await c.env.DB.prepare(
      `UPDATE review_rewards SET state = ?, reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state != 'approved'`
    )
      .bind(nextState, reason, admin.id, now, row.reward_id)
      .run();
    if (res.meta.changes === 0) throw conflict('Reward was already decided');
    await audit(c.env.DB, admin.id, 'review.reward', id, { action, reason });
    return c.json({ success: true, review_id: id, reward_state: nextState });
  }

  // kind === 'points'
  const reason = str(body.reason, 'reason', { min: 3, max: 1000 });
  const configured = await getReviewPointsValue(c.env.DB);
  if (configured === null) {
    throw unavailable(
      'Review point value is not configured yet (admin setting reviewPointsConfig) — no invented amounts',
      'REVIEW_POINTS_UNCONFIGURED'
    );
  }
  // The multiplier belongs to the REVIEWER, not to the admin approving it.
  const { points } = await reviewAward(c.env.DB, String(row.user_id), configured);
  const sourceRef = `review:${row.review_id}`;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE review_rewards SET state = 'approved', points_awarded = ?, reason = ?, decided_by = ?, decided_at = ?
          WHERE id = ? AND state != 'approved'`
      ).bind(points, reason, admin.id, now, row.reward_id),
      // Guard table PK: each review awards points exactly once — a separate
      // ledger key space from purchase points ('order:…') and referrals.
      c.env.DB.prepare('INSERT INTO points_awards (source_ref, user_id, points, created_at) VALUES (?, ?, ?, ?)')
        .bind(sourceRef, row.user_id, points, now),
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', ?)`
      ).bind(`wtx_review_${row.review_id}`, row.user_id, points, `Review reward points`, sourceRef, now),
    ]);
  } catch (e) {
    if (isConstraintError(e)) throw conflict('Points for this review were already awarded');
    console.error('review points award failed', e instanceof Error ? e.message : e);
    throw badRequest('Approval failed. Please try again.');
  }
  await audit(c.env.DB, admin.id, 'review.reward', id, { action: 'approve', kind: 'points', points, reason });
  return c.json({ success: true, review_id: id, reward_state: 'approved', points_awarded: points });
});

/**
 * «تأكيد وإصدار الكود». Idempotent per requestId: a double press or a retried
 * request returns the same entitlement and NEVER a second code or entitlement.
 */
async function issueForReward(c: Context<AppContext>, row: Record<string, unknown>, input: IssueInput) {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const reviewId = text(row.review_id);
  const rewardId = text(row.reward_id);

  const existing = await db.prepare(`${ENT_BRIEF} WHERE reward_id = ?`).bind(rewardId).first<Record<string, unknown>>();
  if (existing) {
    if (text(existing.code_request_id) === input.requestId) return replayResponse(c, reviewId, existing);
    throw new HttpError(409, 'A code was already issued for this review and is never shown again — use «revoke and issue a new code».', 'GIFT_ALREADY_ISSUED', {
      entitlement_id: text(existing.id),
      legacy: text(existing.grant_mode) === 'legacy',
    });
  }
  if (row.state === 'approved') throw conflict('This reward was already decided.', 'GIFT_ALREADY_ISSUED');
  if (row.state === 'rejected') throw conflict('This reward was rejected — request changes to reopen it first.', 'GIFT_REWARD_REJECTED');
  if (!(await giftStillEligible(db, rewardId))) {
    throw conflict('The review is no longer eligible (printer link, stars or order changed).', 'GIFT_ELIGIBILITY_CHANGED');
  }

  const grant = await buildGrant(c.env, input.level, input.mode, input.manual);
  const entId = newId('gent');
  const code = generateGiftCode();
  const verifier = await giftCodeVerifier(entId, code);
  const at = nowIso();
  const fixed = grant.fixed;
  const issueAudit = await auditStatements(db, admin.id, 'gift.issue', entId, {
    review_id: reviewId,
    reward_id: rewardId,
    level: input.level,
    mode: input.mode,
    entitlement_id: entId,
    code_version: 1,
    request_id: input.requestId,
    items: grant.snapshot.items.length,
    fixed_product_id: fixed?.product_id ?? null,
  });
  try {
    await db.batch([
      // 1. The decision, fenced by the state AND the eligibility re-check in ONE statement.
      db
        .prepare(
          `UPDATE review_rewards
              SET state = 'approved', quality_score = ?2, reason = ?3, decided_by = ?4, decided_at = ?5
            WHERE id = ?1 AND kind = 'printer_gift' AND state IN ('submitted', 'revision_needed')
              AND ${GIFT_ELIGIBILITY_FENCE_SQL}`
        )
        .bind(rewardId, input.level, input.note, admin.id, at),
      // 2. The gift. Its owner is read from the reward THIS batch just
      //    approved: if step 1 matched nothing the owner is NULL, the NOT NULL
      //    aborts the batch, and nothing — not even the audit row — is written.
      //    UNIQUE(reward_id) is the last fence against a second entitlement.
      db
        .prepare(
          `INSERT INTO gift_entitlements
             (id, reward_id, user_id, max_level, chosen_level, state, created_at, grant_mode, gift_snapshot, gift_item_ref,
              gift_product_id, gift_option_value_ids, gift_color_id, gift_sale_type, gift_transport_method,
              code_verifier, code_state, code_attempts, code_version, code_request_id, code_issued_at, code_issued_by, updated_at)
           VALUES (?1, ?2,
                   (SELECT rr.user_id FROM review_rewards rr
                     WHERE rr.id = ?2 AND rr.state = 'approved' AND rr.decided_at = ?3 AND rr.decided_by = ?4),
                   ?5, ?5, 'code_issued', ?3, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   ?14, 'issued', 0, 1, ?15, ?3, ?4, ?3)`
        )
        .bind(
          entId,
          rewardId,
          at,
          admin.id,
          input.level,
          input.mode,
          JSON.stringify(grant.snapshot),
          fixed ? fixed.ref : '',
          fixed ? fixed.product_id : null,
          optionValueIdsJson(fixed ? fixed.option_value_ids : []),
          fixed ? fixed.color_id : '',
          fixed ? fixed.sale_type : '',
          fixed ? fixed.transport_method : '',
          verifier,
          input.requestId
        ),
      // 3. The trail — never the code.
      ...issueAudit.statements,
    ]);
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const now = await db.prepare(`${ENT_BRIEF} WHERE reward_id = ?`).bind(rewardId).first<Record<string, unknown>>();
    if (now && text(now.code_request_id) === input.requestId) return replayResponse(c, reviewId, now);
    if (now) throw conflict('A code was already issued for this review.', 'GIFT_ALREADY_ISSUED');
    const rr = await db.prepare('SELECT state FROM review_rewards WHERE id = ?').bind(rewardId).first<{ state: string }>();
    if (rr?.state === 'rejected') throw conflict('This reward was rejected meanwhile.', 'GIFT_REWARD_REJECTED');
    if (rr?.state === 'approved') throw conflict('This reward was decided meanwhile.', 'GIFT_ALREADY_ISSUED');
    if (!(await giftStillEligible(db, rewardId))) {
      throw conflict('The review is no longer eligible (printer link, stars or order changed).', 'GIFT_ELIGIBILITY_CHANGED');
    }
    throw e;
  }
  pumpAfter(db, [issueAudit.eventId]);
  return issuedResponse(c, {
    review_id: reviewId,
    entitlement: { id: entId, level: input.level, grant_mode: input.mode },
    code,
    issuedAt: at,
    issuedBy: admin.id,
    skipped: grant.skipped,
  });
}

// ====================================================== admin: granted gifts

const GIFT_LIST_STATES = ['all', 'available', 'selected', 'code_issued', 'redeemed_ready_to_order', 'ordered', 'fulfilled', 'cancelled'] as const;
const GIFT_LIST_PAGE = 50;

/** GET /api/reviews/admin/gifts?state=&cursor= — granted gifts and their code bookkeeping. Never the code. */
giftRoutes.get('/admin/gifts', async (c) => {
  const db = c.env.DB;
  const stateQ = c.req.query('state') || 'all';
  const state = (GIFT_LIST_STATES as readonly string[]).includes(stateQ) ? stateQ : 'all';
  const [beforeAt, beforeId] = (c.req.query('cursor') ?? '').split('|');
  const { results } = await db
    .prepare(
      `${GIFT_ROW_SELECT}
        WHERE (?1 = 'all' OR ge.state = ?1)
          AND (?2 = '' OR ge.created_at < ?2 OR (ge.created_at = ?2 AND ge.id < ?3))
        ORDER BY ge.created_at DESC, ge.id DESC
        LIMIT ?4`
    )
    .bind(state, beforeAt ?? '', beforeId ?? '', GIFT_LIST_PAGE)
    .all<Record<string, unknown>>();
  const userIds = [...new Set(results.map((r) => text(r.user_id)))];
  const [images, users] = await Promise.all([
    printerImagesFor(db, results),
    userIds.length
      ? db
          .prepare('SELECT id, email, username, name FROM users WHERE id IN (SELECT value FROM json_each(?))')
          .bind(JSON.stringify(userIds))
          .all<{ id: string; email: string; username: string; name: string }>()
      : Promise.resolve({ results: [] as Array<{ id: string; email: string; username: string; name: string }> }),
  ]);
  const byUser = new Map(users.results.map((u) => [u.id, u] as const));
  const gifts = await Promise.all(
    results.map(async (row) => {
      const view = await giftViewFromRow(c.env, row, images, new Map(), { orderable: false });
      const u = byUser.get(text(row.user_id));
      return {
        ...adminGiftFields(row),
        id: view.id,
        ui_state: view.ui_state,
        reward_id: text(row.reward_id),
        review_id: view.review_id,
        customer: { id: text(row.user_id), email: u?.email ?? '', username: u?.username ?? '', name: u?.name ?? '' },
        printer: view.printer,
        items: view.items,
        chosen: view.chosen,
        in_cart: !!view.in_cart,
        order: view.order,
        created_at: view.created_at,
        redeemed_at: view.redeemed_at,
        ordered_at: view.ordered_at,
        fulfilled_at: view.fulfilled_at,
        legacy: view.legacy,
      };
    })
  );
  const last = results[results.length - 1];
  return c.json({
    success: true,
    state,
    gifts,
    next_cursor: results.length === GIFT_LIST_PAGE && last ? `${text(last.created_at)}|${text(last.id)}` : null,
  });
});

async function adminGiftView(env: { DB: D1Database }, id: string) {
  const row = await env.DB.prepare(`${GIFT_ROW_SELECT} WHERE ge.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  const view = await giftViewFromRow(env, row, await printerImagesFor(env.DB, [row]), new Map(), { orderable: false });
  return { ...adminGiftFields(row), ...view, in_cart: !!view.in_cart };
}

/**
 * POST /api/reviews/admin/gifts/:id/issue — CONVERT a legacy `available` gift
 * into the new flow by issuing a code (same body as the issue). The legacy
 * reward was decided under the old program, so it is not re-judged against
 * unit rules it never had — only the review must still be the reviewer's own
 * published one.
 */
giftRoutes.post('/admin/gifts/:id/issue', async (c) => {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  const input = issueInputOf(await jsonBody(c));
  const ge = await db
    .prepare(`SELECT ge.*, rr.review_id FROM gift_entitlements ge JOIN review_rewards rr ON rr.id = ge.reward_id WHERE ge.id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!ge) throw notFound('Gift not found');
  const reviewId = text(ge.review_id);
  if (text(ge.code_request_id) === input.requestId) return replayResponse(c, reviewId, ge);
  if (text(ge.grant_mode) !== 'legacy') {
    throw conflict('A code was already issued for this gift — use «revoke and issue a new code».', 'GIFT_ALREADY_ISSUED');
  }
  if (text(ge.state) !== 'available') throw conflict('Only an unredeemed legacy gift can be converted.', 'GIFT_NOT_CONVERTIBLE');
  const rewardId = text(ge.reward_id);
  if (!(await giftStillEligible(db, rewardId))) {
    throw conflict('The review is no longer eligible (printer link, stars or order changed).', 'GIFT_ELIGIBILITY_CHANGED');
  }
  const grant = await buildGrant(c.env, input.level, input.mode, input.manual);
  const fixed = grant.fixed;
  const code = generateGiftCode();
  const verifier = await giftCodeVerifier(id, code);
  const at = nowIso();
  const issueAudit = await auditStatements(db, admin.id, 'gift.issue', id, {
    review_id: reviewId,
    reward_id: rewardId,
    level: input.level,
    mode: input.mode,
    entitlement_id: id,
    code_version: 1,
    request_id: input.requestId,
    conversion: true,
    previous_max_level: Number(ge.max_level),
  });
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE gift_entitlements
              SET state = 'code_issued', grant_mode = ?3, max_level = ?4, chosen_level = ?4, gift_snapshot = ?5,
                  gift_item_ref = ?6, gift_product_id = ?7, gift_option_value_ids = ?8, gift_color_id = ?9,
                  gift_sale_type = ?10, gift_transport_method = ?11, code_verifier = ?12, code_state = 'issued',
                  code_attempts = 0, code_version = 1, code_request_id = ?13, code_issued_at = ?14, code_issued_by = ?15,
                  updated_at = ?14
            WHERE id = ?2 AND reward_id = ?1 AND grant_mode = 'legacy' AND state = 'available'
              AND ${GIFT_ELIGIBILITY_FENCE_SQL}`
        )
        .bind(
          rewardId,
          id,
          input.mode,
          input.level,
          JSON.stringify(grant.snapshot),
          fixed ? fixed.ref : '',
          fixed ? fixed.product_id : null,
          optionValueIdsJson(fixed ? fixed.option_value_ids : []),
          fixed ? fixed.color_id : '',
          fixed ? fixed.sale_type : '',
          fixed ? fixed.transport_method : '',
          verifier,
          input.requestId,
          at,
          admin.id
        ),
      entitlementFence(db, id, `state = 'code_issued' AND code_request_id IS ?2 AND code_issued_at IS ?3`, [input.requestId, at]),
      db.prepare(`UPDATE review_rewards SET quality_score = ?2 WHERE id = ?1 AND state = 'approved'`).bind(rewardId, input.level),
      ...issueAudit.statements,
    ]);
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const now = await db.prepare(`${ENT_BRIEF} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    if (now && text(now.code_request_id) === input.requestId) return replayResponse(c, reviewId, now);
    if (now && text(now.grant_mode) !== 'legacy') throw conflict('A code was already issued for this gift.', 'GIFT_ALREADY_ISSUED');
    if (!(await giftStillEligible(db, rewardId))) {
      throw conflict('The review is no longer eligible (printer link, stars or order changed).', 'GIFT_ELIGIBILITY_CHANGED');
    }
    throw conflict('Only an unredeemed legacy gift can be converted.', 'GIFT_NOT_CONVERTIBLE');
  }
  pumpAfter(db, [issueAudit.eventId]);
  return issuedResponse(c, {
    review_id: reviewId,
    entitlement: { id, level: input.level, grant_mode: input.mode },
    code,
    issuedAt: at,
    issuedBy: admin.id,
    skipped: grant.skipped,
  });
});

/** POST /api/reviews/admin/gifts/:id/revoke-code {reason≥5} — the live code dies; the gift waits for a re-issue. */
giftRoutes.post('/admin/gifts/:id/revoke-code', async (c) => {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  const reason = str((await jsonBody(c)).reason, 'reason', { min: 5, max: 1000 });
  const ge = await db.prepare('SELECT id, state, code_state, code_version FROM gift_entitlements WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!ge) throw notFound('Gift not found');
  const notActive = () => conflict('Only a live, unredeemed code can be revoked.', 'GIFT_CODE_NOT_ACTIVE');
  if (text(ge.state) !== 'code_issued' || text(ge.code_state) !== 'issued') throw notActive();
  const at = nowIso();
  const revokeAudit = await auditStatements(db, admin.id, 'gift.code.revoke', id, { reason, code_version: Number(ge.code_version) });
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE gift_entitlements SET code_state = 'revoked', code_revoked_at = ?2, updated_at = ?2
            WHERE id = ?1 AND state = 'code_issued' AND code_state = 'issued' AND code_version = ?3`
        )
        .bind(id, at, Number(ge.code_version)),
      entitlementFence(db, id, `code_state = 'revoked' AND code_revoked_at IS ?2`, [at]),
      ...revokeAudit.statements,
    ]);
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    throw notActive();
  }
  pumpAfter(db, [revokeAudit.eventId]);
  return c.json({ success: true, gift: await adminGiftView(c.env, id) });
});

/**
 * POST /api/reviews/admin/gifts/:id/reissue-code {reason≥5, requestId} — a new
 * code for a gift still waiting for one (revoked, lost or locked): new
 * verifier, code_version+1, attempts 0; the old code is dead from this
 * moment. The raw code is answered ONCE, `no-store`.
 */
giftRoutes.post('/admin/gifts/:id/reissue-code', async (c) => {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  const body = await jsonBody(c);
  const reason = str(body.reason, 'reason', { min: 5, max: 1000 });
  const requestId = requestIdOf(body.requestId);
  const ge = await db
    .prepare(`SELECT ge.*, rr.review_id FROM gift_entitlements ge JOIN review_rewards rr ON rr.id = ge.reward_id WHERE ge.id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!ge) throw notFound('Gift not found');
  const reviewId = text(ge.review_id);
  if (text(ge.code_request_id) === requestId) return replayResponse(c, reviewId, ge);
  const notAwaiting = () => conflict('Only a gift still waiting for its code can get a new one.', 'GIFT_NOT_AWAITING_CODE');
  if (text(ge.state) !== 'code_issued') throw notAwaiting();
  const version = Number(ge.code_version) + 1;
  const code = generateGiftCode();
  const verifier = await giftCodeVerifier(id, code);
  const at = nowIso();
  const reissueAudit = await auditStatements(db, admin.id, 'gift.code.reissue', id, {
    reason,
    code_version: version,
    previous_code_state: text(ge.code_state),
    previous_attempts: Number(ge.code_attempts) || 0,
    request_id: requestId,
  });
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE gift_entitlements
              SET code_verifier = ?2, code_state = 'issued', code_attempts = 0, code_version = ?3, code_request_id = ?4,
                  code_issued_at = ?5, code_issued_by = ?6, updated_at = ?5
            WHERE id = ?1 AND state = 'code_issued' AND code_version = ?7`
        )
        .bind(id, verifier, version, requestId, at, admin.id, Number(ge.code_version)),
      entitlementFence(db, id, `code_state = 'issued' AND code_version IS ?2 AND code_request_id IS ?3`, [version, requestId]),
      ...reissueAudit.statements,
    ]);
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const now = await db.prepare(`${ENT_BRIEF} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    if (now && text(now.code_request_id) === requestId) return replayResponse(c, reviewId, now);
    throw notAwaiting();
  }
  pumpAfter(db, [reissueAudit.eventId]);
  return issuedResponse(c, {
    review_id: reviewId,
    entitlement: { id, level: Number(ge.chosen_level ?? ge.max_level) || Number(ge.max_level), grant_mode: text(ge.grant_mode) as GiftGrantMode },
    code,
    issuedAt: at,
    issuedBy: admin.id,
  });
});

/**
 * POST /api/reviews/admin/gifts/:id/cancel {reason≥5} — from code_issued,
 * redeemed_ready_to_order or a legacy `available` gift. One batch: the state,
 * the live code revoked, the gift's cart line deleted, the audit row. An
 * ordered gift is cancelled by cancelling its order (which returns it as ready).
 */
giftRoutes.post('/admin/gifts/:id/cancel', async (c) => {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  const reason = str((await jsonBody(c)).reason, 'reason', { min: 5, max: 1000 });
  const ge = await db.prepare('SELECT id, state, grant_mode FROM gift_entitlements WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!ge) throw notFound('Gift not found');
  const state = text(ge.state);
  const ordered = () => conflict('This gift is already ordered — cancel the order instead.', 'GIFT_ALREADY_ORDERED');
  if (state === 'ordered' || state === 'fulfilled') throw ordered();
  const cancellable =
    state === 'code_issued' || state === 'redeemed_ready_to_order' || (state === 'available' && text(ge.grant_mode) === 'legacy');
  if (!cancellable) throw conflict('Only a gift that is not ordered yet can be cancelled.', 'GIFT_NOT_CANCELLABLE');
  const at = nowIso();
  const cancelAudit = await auditStatements(db, admin.id, 'gift.cancel', id, { reason, from_state: state });
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE gift_entitlements
              SET state = 'cancelled', cancelled_at = ?2, cancelled_by = ?3, cancel_reason = ?4,
                  code_state = CASE WHEN code_state = 'issued' THEN 'revoked' ELSE code_state END,
                  code_revoked_at = CASE WHEN code_state = 'issued' THEN ?2 ELSE code_revoked_at END,
                  updated_at = ?2
            WHERE id = ?1 AND state = ?5`
        )
        .bind(id, at, admin.id, reason, state),
      entitlementFence(db, id, `state = 'cancelled' AND cancelled_at IS ?2 AND cancelled_by IS ?3`, [at, admin.id]),
      db.prepare('DELETE FROM cart_items WHERE gift_entitlement_id = ?').bind(id),
      ...cancelAudit.statements,
    ]);
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    const now = await db.prepare('SELECT state FROM gift_entitlements WHERE id = ?').bind(id).first<{ state: string }>();
    if (now?.state === 'ordered' || now?.state === 'fulfilled') throw ordered();
    throw conflict('The gift changed while cancelling — reload and try again.', 'GIFT_NOT_CANCELLABLE');
  }
  pumpAfter(db, [cancelAudit.eventId]);
  return c.json({ success: true });
});

/** Mark a LEGACY selected gift as handed over (the pre-0165 manual hand-over). */
giftRoutes.post('/admin/gifts/:id/fulfill', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const res = await c.env.DB.prepare(
    `UPDATE gift_entitlements SET state = 'fulfilled', fulfilled_at = ?, updated_at = ?
      WHERE id = ? AND state = 'selected' AND grant_mode = 'legacy'`
  )
    .bind(nowIso(), nowIso(), id)
    .run();
  if (res.meta.changes === 0) throw badRequest('Only a selected (redeemed) legacy gift can be marked fulfilled');
  await audit(c.env.DB, admin.id, 'gift.fulfill', id, {});
  return c.json({ success: true });
});

// ============================================================ admin: levels

const isOn = (v: unknown) => v !== 0 && v !== false && v !== '0';

/** One level item as the editor shows it, with the server's warnings. */
async function levelItemView(env: { DB: D1Database }, row: Record<string, unknown>, products: Map<string, Promise<GiftProductContext>>) {
  const base = {
    id: text(row.id),
    level: Number(row.level),
    active: isOn(row.active),
    sort: Number(row.sort) || 0,
    created_at: text(row.created_at),
    updated_at: row.updated_at == null ? null : text(row.updated_at),
  };
  if (!text(row.product_id)) {
    // A pre-0165 label-only row: read-only, never granted again.
    return {
      ...base,
      legacy: true,
      label_ar: text(row.label_ar),
      label_en: text(row.label_en),
      label_ckb: text(row.label_ckb),
      kind: text(row.kind),
      warnings: ['LEGACY_ITEM'],
    };
  }
  const input = levelItemInputFromRow(row);
  let loading = products.get(input.productId);
  if (!loading) {
    loading = loadGiftProduct(env, input.productId);
    products.set(input.productId, loading);
  }
  const p = await loading;
  const warnings: string[] = [];
  let display: GiftSnapshotItem['display'] | null = null;
  let choices: GiftSnapshotItem['choices'] | null = null;
  let errors: string[] = [];
  if (!p.row) warnings.push('PRODUCT_MISSING');
  else if (text(p.row.status) !== 'active') warnings.push('PRODUCT_ARCHIVED');
  const snap = snapshotItemFor(p, base.id, base.id, input);
  if (snap.ok) {
    display = snap.item.display;
    choices = snap.item.choices ?? null;
    // Out of stock today in every selection the item allows?
    const verdict = checkLevelItem(p, input);
    const sellable =
      verdict.ok &&
      verdict.selections.some(
        (s) =>
          checkGiftSelection(
            p,
            { productId: input.productId, saleType: input.saleType, optionValueIds: s.optionValueIds, colorId: s.colorId, transportMethod: input.transportMethod },
            { requireSellable: true }
          ).ok
      );
    if (!sellable) warnings.push('OUT_OF_STOCK');
  } else {
    if (p.row && text(p.row.status) === 'active') warnings.push('SELECTION_GONE');
    errors = [snap.code, ...snap.errors];
  }
  return {
    ...base,
    legacy: false,
    product_id: input.productId,
    sale_type: input.saleType,
    option_value_ids: input.optionValueIds,
    color_id: input.colorId,
    transport_method: input.transportMethod,
    allowed_option_value_ids: input.allowedOptionValueIds,
    allowed_color_ids: input.allowedColorIds,
    product: p.row
      ? {
          id: input.productId,
          name: text(p.row.name),
          name_ar: text(p.row.name_ar) || text(p.row.name),
          name_ckb: text(p.row.name_ku) || text(p.row.name_ar) || text(p.row.name),
          status: text(p.row.status),
          image: display?.image ?? '',
        }
      : null,
    display,
    choices,
    warnings,
    errors,
  };
}

async function levelItems(env: { DB: D1Database }, level?: number) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM gift_pool_items ${level ? 'WHERE level = ?' : ''} ORDER BY level ASC, sort ASC, created_at ASC, id ASC`
  )
    .bind(...(level ? [level] : []))
    .all<Record<string, unknown>>();
  const products = new Map<string, Promise<GiftProductContext>>();
  return Promise.all(results.map((row) => levelItemView(env, row, products)));
}

/** The editor's body → a LevelItemInput (`base` fills what a partial PUT leaves out). */
function levelItemInputOf(body: Record<string, unknown>, base: LevelItemInput | null): LevelItemInput {
  const has = (k: string) => body[k] !== undefined;
  const level = has('level') ? levelOf(body.level) : base?.level;
  if (level === undefined) throw badRequest('Choose the gift level, 1 to 5', 'GIFT_LEVEL_REQUIRED');
  const productId = has('productId') ? str(body.productId, 'productId', { min: 1, max: 80 }) : base?.productId ?? '';
  if (!productId) throw badRequest('productId is required', 'GIFT_PRODUCT_NOT_FOUND', { errors: ['PRODUCT_NOT_FOUND'] });
  const saleType = has('saleType') ? saleTypeOf(body.saleType) : base?.saleType;
  if (!saleType) throw badRequest('saleType must be direct_sale or pre_order', 'GIFT_SALE_TYPE_UNAVAILABLE', { errors: ['SALE_TYPE_INVALID'] });
  return {
    level,
    productId,
    saleType,
    optionValueIds: has('optionValueIds') ? idList(body.optionValueIds, 'optionValueIds', GIFT_MAX_OPTION_VALUES) : base?.optionValueIds ?? [],
    colorId: has('colorId') ? str(body.colorId, 'colorId', { max: 80, required: false }) : base?.colorId ?? '',
    transportMethod: has('transportMethod') ? transportOf(body.transportMethod) : base?.transportMethod ?? '',
    allowedOptionValueIds: has('allowedOptionValueIds')
      ? idList(body.allowedOptionValueIds, 'allowedOptionValueIds', GIFT_MAX_ALLOWED)
      : base?.allowedOptionValueIds ?? [],
    allowedColorIds: has('allowedColorIds') ? idList(body.allowedColorIds, 'allowedColorIds', GIFT_MAX_ALLOWED) : base?.allowedColorIds ?? [],
    active: has('active') ? body.active !== false : base?.active ?? true,
    sort: has('sort') ? int(body.sort, 'sort', { min: 0, max: 100_000 }) : base?.sort,
  };
}

/** The store's verdict on a level item, as the editor's refusal. */
async function assertLevelItem(env: { DB: D1Database }, input: LevelItemInput): Promise<GiftProductContext> {
  const p = await loadGiftProduct(env, input.productId);
  const verdict = checkLevelItem(p, input);
  if (!verdict.ok) throw selectionRefusal(verdict.code, verdict.errors);
  return p;
}

/** GET /api/reviews/admin/pools — every level item, product rows with their warnings. */
giftRoutes.get('/admin/pools', async (c) => {
  return c.json({ success: true, items: await levelItems(c.env) });
});

/**
 * POST /api/reviews/admin/pools — one LevelItemInput, or `{items: [...]}` (up
 * to 20) to add several products to a level at once. Every item is validated
 * by the store's rule before anything is written; all are written together.
 */
giftRoutes.post('/admin/pools', async (c) => {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const body = await jsonBody(c);
  const many = Array.isArray(body.items);
  const raw = many ? (body.items as unknown[]) : [body];
  if (raw.length === 0 || raw.length > 20) throw badRequest('Add between 1 and 20 items at a time', 'VALIDATION');
  const inputs = raw.map((x) => levelItemInputOf((x && typeof x === 'object' ? x : {}) as Record<string, unknown>, null));
  const contexts: GiftProductContext[] = [];
  for (const input of inputs) contexts.push(await assertLevelItem(c.env, input));
  const at = nowIso();
  const ids = inputs.map(() => newId('gpi'));
  const statements: D1PreparedStatement[] = [];
  inputs.forEach((input, i) => {
    const row = contexts[i].row!;
    statements.push(
      db
        .prepare(
          `INSERT INTO gift_pool_items
             (id, level, kind, label_ar, label_en, label_ckb, brand, material, color, option_value, compat_products, stock, active,
              created_at, product_id, sale_type, option_value_ids, color_id, transport_method, allowed_option_value_ids,
              allowed_color_ids, sort, updated_at)
           VALUES (?1, ?2, 'other', ?3, ?4, ?5, '', '', '', '', '[]', 0, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                   COALESCE(?15, (SELECT COALESCE(MAX(sort), -1) + 1 FROM gift_pool_items WHERE level = ?2)), ?7)`
        )
        .bind(
          ids[i],
          input.level,
          text(row.name_ar) || text(row.name),
          text(row.name),
          text(row.name_ku),
          input.active ? 1 : 0,
          at,
          input.productId,
          input.saleType,
          optionValueIdsJson(input.optionValueIds),
          input.colorId,
          input.transportMethod,
          optionValueIdsJson(input.allowedOptionValueIds),
          optionValueIdsJson(input.allowedColorIds),
          input.sort ?? null
        )
    );
  });
  const created = await auditStatements(db, admin.id, 'gift.pool.create', ids.join(',').slice(0, 200), {
    items: inputs.map((input, i) => ({ id: ids[i], ...input })),
  });
  await db.batch([...statements, ...created.statements]);
  pumpAfter(db, [created.eventId]);
  const products = new Map<string, Promise<GiftProductContext>>();
  const views = await Promise.all(
    ids.map(async (id) => {
      const row = await db.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(id).first<Record<string, unknown>>();
      return levelItemView(c.env, row!, products);
    })
  );
  return c.json(many ? { success: true, items: views } : { success: true, item: views[0] });
});

/**
 * PUT /api/reviews/admin/pools/reorder {level, ids} — the order of one level's
 * items (registered BEFORE /:itemId). Every id must belong to that level;
 * items left out keep their order after the listed ones.
 */
giftRoutes.put('/admin/pools/reorder', async (c) => {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const body = await jsonBody(c);
  const level = levelOf(body.level);
  const ids = Array.isArray(body.ids) ? body.ids : null;
  if (!ids || ids.length === 0 || ids.length > 200 || ids.some((x) => typeof x !== 'string') || new Set(ids).size !== ids.length) {
    throw badRequest('ids must list each item of the level once', 'GIFT_REORDER_INVALID');
  }
  const { results } = await db
    .prepare('SELECT id FROM gift_pool_items WHERE level = ? ORDER BY sort ASC, created_at ASC, id ASC')
    .bind(level)
    .all<{ id: string }>();
  const inLevel = results.map((r) => r.id);
  if ((ids as string[]).some((id) => !inLevel.includes(id))) throw badRequest('Every id must be an item of this level', 'GIFT_REORDER_INVALID');
  const order = [...(ids as string[]), ...inLevel.filter((id) => !(ids as string[]).includes(id))];
  const at = nowIso();
  const reordered = await auditStatements(db, admin.id, 'gift.pool.reorder', `level:${level}`, { ids: order });
  await db.batch([
    ...order.map((id, i) =>
      db.prepare('UPDATE gift_pool_items SET sort = ?, updated_at = ? WHERE id = ? AND level = ?').bind(i, at, id, level)
    ),
    ...reordered.statements,
  ]);
  pumpAfter(db, [reordered.eventId]);
  return c.json({ success: true, items: await levelItems(c.env, level) });
});

/**
 * POST /api/reviews/admin/pools/preview — a GiftSelectionInput judged by the
 * store's rule (also the manual mode's preview): {ok, display, errors}, plus
 * whether it can be sold today. With allowed lists it previews a level item.
 */
giftRoutes.post('/admin/pools/preview', async (c) => {
  const body = await jsonBody(c);
  const input = selectionInputOf(body);
  const p = await loadGiftProduct(c.env, input.productId);
  const allowed = idList(body.allowedOptionValueIds, 'allowedOptionValueIds', GIFT_MAX_ALLOWED);
  const allowedColors = idList(body.allowedColorIds, 'allowedColorIds', GIFT_MAX_ALLOWED);
  if (allowed.length || allowedColors.length) {
    const verdict = checkLevelItem(p, {
      level: 1,
      productId: input.productId,
      saleType: input.saleType,
      optionValueIds: input.optionValueIds,
      colorId: input.colorId,
      transportMethod: input.transportMethod,
      allowedOptionValueIds: allowed,
      allowedColorIds: allowedColors,
      active: true,
    });
    return c.json({
      success: true,
      ok: verdict.ok,
      code: verdict.ok ? null : verdict.code,
      errors: verdict.ok ? [] : verdict.errors,
      display: verdict.ok ? verdict.selections[0].result.display : null,
      selections: verdict.ok ? verdict.selections.length : 0,
    });
  }
  const r = checkGiftSelection(p, input, { requireSellable: false });
  const today = r.ok ? checkGiftSelection(p, input, { requireSellable: true }) : null;
  return c.json({
    success: true,
    ok: r.ok,
    code: r.ok ? null : r.code,
    errors: r.ok ? [] : r.errors,
    display: r.ok ? r.display : null,
    canonical: r.ok ? r.canonical : null,
    sellable: today ? { ok: today.ok, code: today.ok ? null : today.code, errors: today.ok ? [] : today.errors } : null,
  });
});

/** GET /api/reviews/admin/gift-options/:productId — what may be picked for this product. */
giftRoutes.get('/admin/gift-options/:productId', async (c) => {
  const p = await loadGiftProduct(c.env, c.req.param('productId') ?? '');
  if (!p.row) throw notFound('Product not found');
  return c.json({ success: true, ...giftOptionsProjection(p) });
});

/**
 * PUT /api/reviews/admin/pools/:itemId — a partial LevelItemInput; `active:false`
 * disables without deleting. A legacy label row can only be switched on/off or
 * moved, or turned into a product row by naming a product.
 */
giftRoutes.put('/admin/pools/:itemId', async (c) => {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const itemId = c.req.param('itemId') ?? '';
  const existing = await db.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(itemId).first<Record<string, unknown>>();
  if (!existing) throw notFound('Gift level item not found');
  const body = await jsonBody(c);
  const at = nowIso();
  const legacyRow = !text(existing.product_id);
  let statement: D1PreparedStatement;
  let changes: Record<string, unknown>;
  if (legacyRow && body.productId === undefined) {
    const level = body.level !== undefined ? levelOf(body.level) : Number(existing.level);
    const active = body.active !== undefined ? body.active !== false : isOn(existing.active);
    const sort = body.sort !== undefined ? int(body.sort, 'sort', { min: 0, max: 100_000 }) : Number(existing.sort) || 0;
    changes = { level, active, sort };
    statement = db
      .prepare('UPDATE gift_pool_items SET level = ?, active = ?, sort = ?, updated_at = ? WHERE id = ?')
      .bind(level, active ? 1 : 0, sort, at, itemId);
  } else {
    const input = levelItemInputOf(body, legacyRow ? null : levelItemInputFromRow(existing));
    // Switching an item OFF never needs today's catalogue to agree; anything
    // that changes what would be granted does.
    const onlyDisabling = !legacyRow && Object.keys(body).every((k) => k === 'active' || k === 'sort') && !input.active;
    const p = onlyDisabling ? await loadGiftProduct(c.env, input.productId) : await assertLevelItem(c.env, input);
    const row = p.row;
    changes = { ...input };
    statement = db
      .prepare(
        `UPDATE gift_pool_items
            SET level = ?2, product_id = ?3, sale_type = ?4, option_value_ids = ?5, color_id = ?6, transport_method = ?7,
                allowed_option_value_ids = ?8, allowed_color_ids = ?9, active = ?10, sort = ?11, updated_at = ?12,
                label_ar = ?13, label_en = ?14, label_ckb = ?15
          WHERE id = ?1`
      )
      .bind(
        itemId,
        input.level,
        input.productId,
        input.saleType,
        optionValueIdsJson(input.optionValueIds),
        input.colorId,
        input.transportMethod,
        optionValueIdsJson(input.allowedOptionValueIds),
        optionValueIdsJson(input.allowedColorIds),
        input.active ? 1 : 0,
        input.sort ?? (Number(existing.sort) || 0),
        at,
        row ? text(row.name_ar) || text(row.name) : text(existing.label_ar),
        row ? text(row.name) : text(existing.label_en),
        row ? text(row.name_ku) : text(existing.label_ckb)
      );
  }
  const updated = await auditStatements(db, admin.id, 'gift.pool.update', itemId, {
    before: { level: Number(existing.level), active: isOn(existing.active), product_id: existing.product_id ?? null },
    changes,
  });
  await db.batch([statement, ...updated.statements]);
  pumpAfter(db, [updated.eventId]);
  const row = await db.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(itemId).first<Record<string, unknown>>();
  return c.json({ success: true, item: await levelItemView(c.env, row!, new Map()) });
});

/** DELETE /api/reviews/admin/pools/:itemId — granted gifts keep their own snapshot. */
giftRoutes.delete('/admin/pools/:itemId', async (c) => {
  const admin = c.get('user')!;
  const db = c.env.DB;
  const itemId = c.req.param('itemId') ?? '';
  const existing = await db.prepare('SELECT * FROM gift_pool_items WHERE id = ?').bind(itemId).first<Record<string, unknown>>();
  if (!existing) throw notFound('Gift level item not found');
  const removed = await auditStatements(db, admin.id, 'gift.pool.delete', itemId, {
    level: Number(existing.level),
    product_id: existing.product_id ?? null,
    label_ar: text(existing.label_ar),
  });
  await db.batch([db.prepare('DELETE FROM gift_pool_items WHERE id = ?').bind(itemId), ...removed.statements]);
  pumpAfter(db, [removed.eventId]);
  return c.json({ success: true });
});
