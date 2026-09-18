/**
 * «خبرني لما يرجع» — THE DOOR. /api/stock-alerts/*
 *
 * Everything a customer does with a standing restock request: arm one, save a
 * whole sheet's worth in one go, read their own list, remove one. The sweep
 * (worker/lib/stockAlerts.ts) answers them; this file only ever decides whether
 * a promise may be made and records it.
 *
 * ---------------------------------------------------------------------------
 * THE DOOR REFUSES WHAT THE SWEEP WOULD LATER KILL, AND THAT IS THE WHOLE
 * POINT OF ITS EXISTING.
 *
 * `armRefusal` (worker/lib/stockAlertResolve.ts) is stricter than the sweep on
 * purpose, and it is called HERE, where the shopper is standing and can be told
 * something. The alternative is a row that is accepted with a confirmation
 * sentence, sits armed until the next cron, and is then reconciled `dead` with
 * a reason nobody is reading — a pre-order-only model, an untracked shelf, a
 * bundle whose own stock column is NULL for ever, a combination the shop does
 * not model. Every one of those is a promise that can NEVER be kept, and the
 * only moment it can be refused honestly is this request.
 *
 * ---------------------------------------------------------------------------
 * THE CHANNEL NAME COMES FROM THE SERVER.
 *
 * `POST /` and `PUT /product/:id` both answer with `readiness` and with the
 * single `channel` the server picked. A client that composes «راح نخبرك على
 * تيليغرام» from its own idea of what is linked will eventually name a channel
 * the server did not pick — a revoked bot binding, an unverified mailbox, a
 * deployment with no WhatsApp key — and the customer is then told, in writing,
 * to watch somewhere nothing will arrive. `channelReadiness().recommended` is
 * never null (the in-app inbox is the floor), so there is always a true
 * sentence to render.
 *
 * ---------------------------------------------------------------------------
 * TWO CHEAP LIMITS THAT CANNOT BE ADDED LATER.
 *
 * The rate limiter and `MAX_ARMED_PER_USER` are both here from the first
 * commit, because retro-fitting either one breaks somebody's saved list. Any
 * signed-in account can otherwise arm every sold-out product in the catalogue
 * and turn a demand-bounded sweep into a catalogue-bounded one: the sweep's
 * cost is `limitAlerts` rows and `limitProducts` catalogue loads per tick, and
 * the only thing keeping the QUEUE behind that bound small is that a real
 * person wants a handful of things. A few dozen is already far beyond what
 * anyone needs, and a person who hits it is told so rather than having their
 * oldest alert silently dropped.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, conflict, notFound, oneOf, requireAuth, str, unavailable } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import { channelReadiness } from '../lib/channelReadiness';
import {
  armRefusal,
  contextDegraded,
  loadAlertContexts,
  resolveWish,
  type AlertDeadReason,
  type AlertProductContext,
  type AlertWish,
} from '../lib/stockAlertResolve';

export const stockAlertRoutes = new Hono<AppContext>();
stockAlertRoutes.use('*', requireAuth);

/** A standing request lapses after ninety days — the lifetime migration 0092's
 *  own header names. Re-arming renews it; `armed_at` deliberately does not
 *  move, so the list can still say how long this person has been waiting. */
const ALERT_TTL_DAYS = 90;

/** Far beyond what anyone needs, and low enough that one account cannot make
 *  the sweep scan the catalogue. See the module note. */
const MAX_ARMED_PER_USER = 40;

/** One product's sheet cannot hold more wishes than it has targets worth
 *  watching; the bound is on the REQUEST so a malformed client cannot make one
 *  save cost forty upserts. */
const MAX_WISHES_PER_PRODUCT = 20;

const ALERT_KINDS = ['product', 'option_value', 'color', 'combination'] as const;

const nowIso = () => new Date().toISOString();

/**
 * WHY EACH REFUSAL IS A SENTENCE AND NOT A CODE ALONE. The shopper tapped a
 * button that said «خبرني لما يرجع» and got nothing; «غير متاح» would tell them
 * the site is broken. Each of these names the actual situation, so the answer
 * to "why can't I be told about this?" is on the screen rather than in a log.
 * Arabic first, English second — the house rule, and here the Arabic is the one
 * most customers will read.
 */
const REFUSAL_TEXT: Record<AlertDeadReason, string> = {
  NOT_A_STOCK_TARGET:
    'هذا الخيار ما ينباع من المخزون، فما نكدر ننبهك عليه. / This option is not sold from stock, so we cannot alert you about it.',
  VARIANT_NOT_MODELLED:
    'هذا التجميع (الموديل مع اللون) غير معروض في المتجر. اختر تجميع ثاني. / This exact model-and-colour combination is not offered. Please choose another.',
  TARGET_REMOVED:
    'الخيار الذي اخترته ما عاد موجود. / The option you chose no longer exists.',
  TARGET_INACTIVE:
    'الخيار الذي اخترته ما عاد معروض حالياً. / The option you chose is no longer on display.',
  PRODUCT_UNAVAILABLE:
    'هذا المنتج غير معروض حالياً. / This product is not on display right now.',
  UNTRACKED:
    'هذا المنتج ما عنده عدّاد مخزون، فما نكدر نعرف متى يرجع. / This product has no stock counter, so we cannot tell when it returns.',
  PREORDER_ONLY:
    'هذا الخيار بالطلب المسبق فقط — تكدر تطلبه هسه بدون ما تنتظر. / This option is pre-order only — you can order it now without waiting.',
  COMPOSITION:
    'هذا منتج مركّب (بكج أو صندوق)، وما إله مخزون خاص فيه ننتبه عليه. / This is a composed product (a bundle or mystery box); it has no shelf of its own to watch.',
};

interface AlertRowOut {
  id: string;
  product_id: string;
  kind: string;
  option_value_id: string;
  color_id: string;
  state: string;
  arm_seq: number;
  armed_channel: string;
  armed_at: string;
  notified_at: string;
  expires_at: string;
  dead_reason: string;
}

const ALERT_COLUMNS =
  'id, product_id, kind, option_value_id, color_id, state, arm_seq, armed_channel, ' +
  'armed_at, notified_at, expires_at, dead_reason';

/**
 * THE WISH, VALIDATED STRICTLY RATHER THAN COERCED.
 *
 * `kind` is stored and not inferred (0092: an alert on a whole product and an
 * alert on a product with exactly one model both leave `option_value_id`
 * empty), so a body whose ids do not match its kind is not a request with an
 * extra field — it is a row nothing downstream can honestly resolve. Silently
 * dropping the stray id would arm a DIFFERENT alert from the one the tap meant,
 * which the customer would only discover by never being told about it.
 *
 * The '' sentinel is the schema's, never NULL: it is what makes
 * `idx_stock_alerts_target` a real uniqueness guarantee instead of one that
 * lets a product-level alert collide with nothing.
 */
function readWish(raw: unknown): AlertWish {
  const body = (raw ?? {}) as Record<string, unknown>;
  const kind = oneOf(body.kind, 'kind', ALERT_KINDS);
  const optionValueId = str(body.optionValueId, 'optionValueId', { max: 60, required: false }) ?? '';
  const colorId = str(body.colorId, 'colorId', { max: 60, required: false }) ?? '';

  const needsValue = kind === 'option_value' || kind === 'combination';
  const needsColor = kind === 'color' || kind === 'combination';
  if (needsValue && !optionValueId) throw badRequest('optionValueId is required for this alert kind', 'WISH_INCOMPLETE');
  if (!needsValue && optionValueId) throw badRequest('optionValueId is not allowed for this alert kind', 'WISH_MALFORMED');
  if (needsColor && !colorId) throw badRequest('colorId is required for this alert kind', 'WISH_INCOMPLETE');
  if (!needsColor && colorId) throw badRequest('colorId is not allowed for this alert kind', 'WISH_MALFORMED');

  return { kind, option_value_id: optionValueId, color_id: colorId };
}

/**
 * The identity `idx_stock_alerts_target` uses, as a Map key. `JSON.stringify`
 * rather than a joined string: a separator character that could appear inside
 * an id would silently merge two different wishes into one, and the row that
 * then went missing from a save would look like a lost write.
 */
const wishKey = (w: AlertWish): string =>
  JSON.stringify([w.kind, w.option_value_id, w.color_id]);

/** One product's context, or a 404. A wish on a product that does not exist is
 *  not a refusal to explain — there is nothing to explain it about. */
async function contextFor(c: Context<AppContext>, productId: string): Promise<AlertProductContext> {
  const contexts = await loadAlertContexts(c.env.DB, [productId]);
  const ctx = contexts.get(productId);
  if (!ctx) throw notFound('Product not found');
  return ctx;
}

/** Refuse at the door, in the shopper's own language, naming the real cause. */
function assertArmable(ctx: AlertProductContext, wish: AlertWish): void {
  /*
   * A DEGRADED CONTEXT PRODUCES NO REFUSAL, AND SILENCE IS NOT CONSENT.
   *
   * `armRefusal` answers by looking for a permanent reason this wish cannot be
   * kept; when a relational read failed, every check that could produce one was
   * short-circuited (see resolveWish), so it returns null. Accepting on that
   * basis would arm a standing promise against a catalogue we could not read —
   * exactly the combination that makes a customer wait for a message about a
   * model that may not exist.
   *
   * 503, not 400: nothing is wrong with what they asked for, and «حاول مرة
   * أخرى» is the truthful instruction. The next request usually succeeds.
   */
  if (contextDegraded(ctx)) {
    throw unavailable(
      'تعذّر التحقق من هذا المنتج الآن. حاول بعد لحظات.',
      'ALERT_TEMPORARILY_UNAVAILABLE'
    );
  }
  const refusal = armRefusal(ctx, wish);
  if (refusal) throw badRequest(REFUSAL_TEXT[refusal], `ALERT_${refusal}`);
}

/**
 * THE UPSERT, AND THE ONE LINE IN IT THAT DECIDES WHETHER THE FEATURE WORKS
 * TWICE.
 *
 * `arm_seq` is incremented IN THE STATEMENT, on every transition INTO 'armed',
 * and nowhere else — never on a UI path, never as a separate UPDATE that could
 * be skipped. Without it the commonest flow in the whole feature is silent:
 * the alert fires, the shopper misses the units, they tap «خبرني» again, the
 * row resurrects with its counters unchanged, and every downstream guard turns
 * the replacement message into a no-op — `user_notifications` is INSERT OR
 * IGNORE, `outbox.event_key` is UNIQUE — after which the sweep flips the row to
 * `notified` having delivered nothing. For ever, and invisibly.
 *
 * THE CONFLICT TARGET NAMES FIVE PLAIN COLUMNS because the schema made them
 * plain. `idx_stock_alerts_target` carries no COALESCE, so there is nothing to
 * repeat verbatim here and nothing to get wrong — which is precisely the
 * failure 0082/0083 already paid for once on `idx_cart_levonis_line`.
 *
 * `last_buyable` IS SEEDED FROM THE CURRENT VERDICT, not left at zero. The
 * sweep fires on a TRANSITION, so a row armed against a target that happens to
 * be buyable right now would otherwise fire on the very next tick and tell the
 * customer that something they can already see in the cart has "come back".
 *
 * `last_checked_at` is reset to '' so this row sorts to the FRONT of the
 * sweep's least-recently-examined ordering: a request made thirty seconds ago
 * is the one most worth looking at first. `armed_at` deliberately does NOT
 * move on a re-arm (0092), so «تنبيهاتي» can still say how long this person has
 * been waiting.
 */
function armStatement(
  c: Context<AppContext>,
  userId: string,
  productId: string,
  wish: AlertWish,
  seed: { available: number | null; buyable: boolean },
  channel: string,
  when: string
): D1PreparedStatement {
  const expiresAt = new Date(Date.parse(when) + ALERT_TTL_DAYS * 86_400_000).toISOString();
  return c.env.DB.prepare(
    `INSERT INTO product_stock_alerts
       (id, user_id, product_id, kind, option_value_id, color_id, state, arm_seq,
        last_available, last_buyable, armed_channel, armed_at, last_checked_at,
        notified_at, expires_at, dead_reason)
     VALUES (?, ?, ?, ?, ?, ?, 'armed', 1, ?, ?, ?, ?, '', '', ?, '')
     ON CONFLICT(user_id, product_id, kind, option_value_id, color_id) DO UPDATE SET
       state = 'armed',
       arm_seq = product_stock_alerts.arm_seq +
         (CASE WHEN product_stock_alerts.state <> 'armed' THEN 1 ELSE 0 END),
       last_available = excluded.last_available,
       last_buyable = excluded.last_buyable,
       armed_channel = excluded.armed_channel,
       last_checked_at = '',
       notified_at = '',
       expires_at = excluded.expires_at,
       dead_reason = ''`
  ).bind(
    newId('psa'),
    userId,
    productId,
    wish.kind,
    wish.option_value_id,
    wish.color_id,
    seed.available,
    seed.buyable ? 1 : 0,
    channel,
    when,
    expiresAt
  );
}

/** The product's live wishes, after the write, so the client renders what the
 *  database actually holds rather than what it hoped it wrote. */
async function armedForProduct(c: Context<AppContext>, userId: string, productId: string): Promise<AlertRowOut[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT ${ALERT_COLUMNS} FROM product_stock_alerts
      WHERE user_id = ? AND product_id = ? AND state IN ('armed','firing')
      ORDER BY kind, option_value_id, color_id`
  )
    .bind(userId, productId)
    .all<AlertRowOut>();
  return results ?? [];
}

/** How many live alerts this person already holds, excluding a set of product
 *  ids the caller is about to rewrite. */
async function armedCount(c: Context<AppContext>, userId: string, exceptProductId?: string): Promise<number> {
  const sql = exceptProductId
    ? `SELECT COUNT(*) AS n FROM product_stock_alerts
        WHERE user_id = ? AND state IN ('armed','firing') AND product_id <> ?`
    : `SELECT COUNT(*) AS n FROM product_stock_alerts
        WHERE user_id = ? AND state IN ('armed','firing')`;
  const stmt = exceptProductId
    ? c.env.DB.prepare(sql).bind(userId, exceptProductId)
    : c.env.DB.prepare(sql).bind(userId);
  const row = await stmt.first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function assertUnderCap(total: number): void {
  if (total > MAX_ARMED_PER_USER) {
    throw conflict(
      `وصلت للحد الأعلى من التنبيهات (${MAX_ARMED_PER_USER}). احذف واحد قبل ما تضيف غيره. / ` +
        `You have reached the maximum number of alerts (${MAX_ARMED_PER_USER}). Remove one before adding another.`,
      'ALERT_LIMIT_REACHED'
    );
  }
}

// ------------------------------------------------------------- arm one

/**
 * POST / — one wish, armed.
 *
 * Answers with the stored row, the full readiness payload (so the sheet can
 * offer an activation without a second round trip) and the ONE channel the
 * server picked for the confirmation sentence.
 */
stockAlertRoutes.post('/', async (c) => {
  await rateLimit(c, 'stock-alert-arm', 30, 600);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = str(body.productId, 'productId', { min: 1, max: 60 });
  const wish = readWish(body);

  const ctx = await contextFor(c, productId);
  assertArmable(ctx, wish);

  // The cap counts what exists BESIDES this exact target, so re-arming a wish
  // the person already holds is never refused for being one too many.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM product_stock_alerts
      WHERE user_id = ? AND product_id = ? AND kind = ? AND option_value_id = ? AND color_id = ?
        AND state IN ('armed','firing')`
  )
    .bind(user.id, productId, wish.kind, wish.option_value_id, wish.color_id)
    .first<{ id: string }>();
  if (!existing) assertUnderCap((await armedCount(c, user.id)) + 1);

  const verdict = resolveWish(ctx, wish);
  const readiness = await channelReadiness(c.env, user.id);
  const when = nowIso();

  await armStatement(
    c,
    user.id,
    productId,
    wish,
    { available: verdict.available, buyable: verdict.buyable },
    readiness.recommended,
    when
  ).run();

  const rows = await armedForProduct(c, user.id, productId);
  const stored = rows.find((r) => r.kind === wish.kind && r.option_value_id === wish.option_value_id && r.color_id === wish.color_id);

  return c.json({
    success: true,
    alert: stored ?? null,
    readiness,
    channel: readiness.recommended,
  });
});

// ------------------------------------------------------- replace the set

/**
 * PUT /product/:id — the sheet's Save.
 *
 * ONE REQUEST, ONE BATCH, and that is the requirement rather than an
 * optimisation. A client that deleted the old wishes and then posted the new
 * ones would, on any failure between the two, leave the shopper with their
 * alerts silently gone and the screen showing the set they just saved. The
 * cancellations and the upserts commit together or not at all.
 *
 * AN UNARMABLE WISH REFUSES THE WHOLE SAVE. A partial save is the one outcome
 * the shopper cannot read off the screen: they would see the sheet close and
 * have no way to know which of their five choices was dropped.
 */
stockAlertRoutes.put('/product/:id', async (c) => {
  await rateLimit(c, 'stock-alert-save', 20, 600);
  const user = c.get('user')!;
  const productId = str(c.req.param('id'), 'productId', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const raw = body.alerts ?? body.wishes;
  if (raw !== undefined && !Array.isArray(raw)) throw badRequest('alerts must be an array', 'BAD_ALERTS');
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_WISHES_PER_PRODUCT) {
    throw badRequest(`alerts has too many items (max ${MAX_WISHES_PER_PRODUCT})`, 'TOO_MANY_ALERTS');
  }

  const ctx = await contextFor(c, productId);

  // Deduplicate on the same identity the unique index uses, so a client that
  // sends the same wish twice saves one row rather than colliding with itself
  // inside its own batch.
  const wishes: AlertWish[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const wish = readWish(entry);
    const key = wishKey(wish);
    if (seen.has(key)) continue;
    seen.add(key);
    assertArmable(ctx, wish);
    wishes.push(wish);
  }

  assertUnderCap((await armedCount(c, user.id, productId)) + wishes.length);

  const current = await armedForProduct(c, user.id, productId);
  const keep = new Set(wishes.map(wishKey));
  const when = nowIso();
  const readiness = await channelReadiness(c.env, user.id);

  const stmts: D1PreparedStatement[] = [];
  /**
   * CANCELLED BY ID, NEVER DELETED, AND NEVER "cancel everything then re-add".
   *
   * Deleting the row would throw away `arm_seq` and `armed_at` — the record of
   * how many times this person has re-armed and how long they have been
   * waiting — and 0092 keeps them precisely so a re-arm is one row with a
   * history rather than a pile of rows. Cancelling only the rows that are
   * LEAVING (rather than clearing the product and re-inserting) is what stops a
   * kept wish from being counted as a re-arm: it would otherwise be 'cancelled'
   * at the moment its own upsert ran, and the CASE in `armStatement` would
   * bump `arm_seq` for a row nobody touched.
   */
  for (const row of current) {
    // The CHECK constraint on `kind` is what makes this cast a statement of the
    // schema rather than a guess: SQLite cannot hold a fifth value there.
    const held: AlertWish = {
      kind: row.kind as AlertWish['kind'],
      option_value_id: row.option_value_id,
      color_id: row.color_id,
    };
    if (keep.has(wishKey(held))) continue;
    stmts.push(
      c.env.DB.prepare(
        `UPDATE product_stock_alerts SET state = 'cancelled', last_checked_at = ?
          WHERE id = ? AND user_id = ? AND state IN ('armed','firing')`
      ).bind(when, row.id, user.id)
    );
  }
  for (const wish of wishes) {
    const verdict = resolveWish(ctx, wish);
    stmts.push(
      armStatement(
        c,
        user.id,
        productId,
        wish,
        { available: verdict.available, buyable: verdict.buyable },
        readiness.recommended,
        when
      )
    );
  }

  if (stmts.length > 0) await c.env.DB.batch(stmts);

  return c.json({
    success: true,
    alerts: await armedForProduct(c, user.id, productId),
    readiness,
    channel: readiness.recommended,
  });
});

// ------------------------------------------------------ read one product

/** GET /product/:id — what the sheet opens with. Live rows only: a cancelled
 *  or dead wish is history, and pre-ticking a box from it would re-arm
 *  something the customer removed. */
stockAlertRoutes.get('/product/:id', async (c) => {
  await rateLimit(c, 'stock-alert-read', 120, 60);
  const user = c.get('user')!;
  const productId = str(c.req.param('id'), 'productId', { min: 1, max: 60 });
  return c.json({ success: true, alerts: await armedForProduct(c, user.id, productId) });
});

// ------------------------------------------------------------- the list

interface ListRow extends AlertRowOut {
  last_available: number | null;
  slug: string;
  name: string;
  name_ar: string;
  name_ku: string;
  images: string;
  value_en: string | null;
  value_ar: string | null;
  value_ckb: string | null;
  color_en: string | null;
  color_ar: string | null;
  color_ckb: string | null;
}

/**
 * GET / — «تنبيهاتي», the Settings screen.
 *
 * Carries `dead_reason` deliberately. A reconciled alert with no reason on the
 * screen is indistinguishable from one that is still waiting, and the whole
 * argument for reconciling instead of silently dropping (0092, and the sweep's
 * §8) is that the customer gets to READ why the thing they were waiting for is
 * never coming.
 *
 * `cancelled` rows are excluded: the customer removed them, and a list that
 * keeps showing what you deleted is a list you stop trusting.
 *
 * The two LEFT JOINs resolve the wish's own labels. They cannot fan out —
 * `option_value_id` and `color_id` are primary keys on their tables and the ''
 * sentinel matches no row — and they are done in SQL rather than through
 * `loadAlertContexts` because a list of forty alerts spanning forty products
 * would otherwise cost forty catalogue loads to render a name.
 */
stockAlertRoutes.get('/', async (c) => {
  await rateLimit(c, 'stock-alert-read', 120, 60);
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.product_id, a.kind, a.option_value_id, a.color_id, a.state, a.arm_seq,
            a.armed_channel, a.armed_at, a.notified_at, a.expires_at, a.dead_reason,
            a.last_available,
            p.slug, p.name, p.name_ar, p.name_ku, p.images,
            v.name_en AS value_en, v.name_ar AS value_ar, v.name_ckb AS value_ckb,
            k.name_en AS color_en, k.name_ar AS color_ar, k.name_ckb AS color_ckb
       FROM product_stock_alerts a
       JOIN products p ON p.id = a.product_id
       LEFT JOIN product_option_values v ON v.id = a.option_value_id
       LEFT JOIN product_colors k ON k.id = a.color_id
      WHERE a.user_id = ? AND a.state IN ('armed','firing','notified','dead')
      ORDER BY a.armed_at DESC
      LIMIT 100`
  )
    .bind(user.id)
    .all<ListRow>();

  return c.json({
    success: true,
    limit: MAX_ARMED_PER_USER,
    alerts: (results ?? []).map((r) => {
      let image: string | null = null;
      try {
        const imgs = JSON.parse(String(r.images ?? '[]'));
        image = Array.isArray(imgs) && imgs.length ? String(imgs[0]) : null;
      } catch {
        image = null;
      }
      return {
        id: r.id,
        product_id: r.product_id,
        slug: r.slug,
        // Arabic first, and the English column is the fallback for both of the
        // others — a shop that has not translated a name must still render one.
        name: { ar: r.name_ar || r.name, en: r.name || r.name_ar, ckb: r.name_ku || r.name_ar || r.name },
        image,
        kind: r.kind,
        option_value_id: r.option_value_id,
        color_id: r.color_id,
        option_value: r.value_en
          ? { ar: r.value_ar || r.value_en, en: r.value_en, ckb: r.value_ckb || r.value_en }
          : null,
        color: r.color_en ? { ar: r.color_ar || r.color_en, en: r.color_en, ckb: r.color_ckb || r.color_en } : null,
        state: r.state,
        arm_seq: r.arm_seq,
        armed_channel: r.armed_channel,
        armed_at: r.armed_at,
        notified_at: r.notified_at || null,
        expires_at: r.expires_at || null,
        dead_reason: r.dead_reason || null,
      };
    }),
  });
});

// ------------------------------------------------------------ remove one

/**
 * DELETE /:id — the customer withdrew the request.
 *
 * A state change, not a row delete. The row carries `arm_seq` and `armed_at`,
 * and 0092 keeps them so that a customer who arms, is notified, and arms again
 * is ONE row with a history. Deleting would also let the identity be reused by
 * a fresh row starting from `arm_seq = 1`, which is exactly the re-armed-row
 * shape the counter exists to distinguish.
 *
 * Scoped to the owner in SQL, so a guessed id belonging to somebody else
 * changes nothing and is answered the same way as an id that does not exist.
 */
stockAlertRoutes.delete('/:id', async (c) => {
  await rateLimit(c, 'stock-alert-remove', 60, 600);
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const res = await c.env.DB.prepare(
    `UPDATE product_stock_alerts SET state = 'cancelled', last_checked_at = ?
      WHERE id = ? AND user_id = ? AND state IN ('armed','firing')`
  )
    .bind(nowIso(), id, user.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw notFound('Alert not found');
  return c.json({ success: true, removed: id });
});
