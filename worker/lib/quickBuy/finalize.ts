/**
 * «الشراء السريع» — the end of the 30 minutes (owner brief §13–§14,
 * docs/GIFTS_QUICK_BUY.md §3.4, D10–D13).
 *
 * When `expires_at` passes, the session becomes ONE ordinary order through the
 * cart's own order door (`placeOrder`, worker/routes/orders.ts) — the same
 * rows, stock reservation, wallet debit, settlement, finance snapshot, events,
 * invoice, stage, customer notices and admin announcement as a checkout. The
 * only differences ride in `QuickBuyOrderHooks`:
 *
 *   • the order id was reserved when the session opened, so two finalisers can
 *     never both create it (orders.id) and the idempotency key `qb_<session>`
 *     replays the order if a retry ever reaches the door again;
 *   • FIRST in the batch the session's hold is released and its reservations
 *     are released, so the order's own spend and reservation further down see
 *     that money and those units (the plan is credited the units it frees);
 *   • the order pays at most what was held: the session's unit prices and its
 *     delivery fee are ceilings, and the rate is the session's rate (D12);
 *   • LAST, the session flips `open → submitted` only while its time has run
 *     out by the database's clock — fenced — and the money trail records the
 *     capture and the release of any remainder.
 *
 * It runs from the per-minute cron (the browser may be closed, §13) and lazily
 * from any Quick Buy request that finds an expired session. A lease keeps two
 * finalisers apart; the order key keeps even a lost lease harmless.
 */
import { Hono, type Context } from 'hono';
import type { AppContext, Env, SessionUser } from '../types';
import { HttpError } from '../http';
import { fence } from '../operations';
import { planInventory } from '../inventory';
import { notify } from '../notifications';
import { assertHoldStateStatement, releaseHoldStatement } from '../walletOps';
import { auditStatements } from '../audit';
import { placeOrder, type QuickBuyOrderHooks } from '../../routes/orders';
import {
  parseJson,
  QUICK_BUY_FINALIZE_MAX_ATTEMPTS,
  QUICK_BUY_LEASE_MS,
  SQL_NOW,
  type HeldTarget,
  type QuickBuyItemRow,
  type QuickBuySessionRow,
} from './model';
import { eventStatement, heldCredit, heldMove, liveItems, loadSession, planFence } from './session';

export type FinalizeOutcome =
  | { status: 'submitted'; orderId: string }
  | { status: 'skipped' }
  | { status: 'cancelled' }
  | { status: 'retry'; code: string }
  | { status: 'failed'; code: string };

export interface FinalizeRunner {
  /** A live request context (lazy finalisation, admin retry). */
  c?: Context<AppContext>;
  /** The cron's execution context, when there is no request. */
  ctx?: ExecutionContext;
}

/** The consent rows recorded when Quick Buy was switched on, copied onto the order. */
function consentStatements(db: D1Database, userId: string, orderId: string, ids: Record<string, string>): D1PreparedStatement[] {
  const list = Object.values(ids).filter((v) => typeof v === 'string' && v !== '');
  if (list.length === 0) return [];
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO policy_acceptances
           (id, user_id, policy_key, version, hash, context, accepted_at, document_id, order_id, locale, requested_locale, event)
         SELECT 'pac_' || lower(hex(randomblob(12))), user_id, policy_key, version, hash, ?, accepted_at, document_id, ?,
                locale, requested_locale, 'quick_buy.policy.accepted'
           FROM policy_acceptances
          WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`
      )
      .bind(`order:${orderId}`, orderId, userId, JSON.stringify(list)),
  ];
}

async function runOrderDoor(
  env: Env,
  runner: FinalizeRunner,
  user: SessionUser,
  body: Record<string, unknown>,
  hooks: QuickBuyOrderHooks
): Promise<{ ok: true } | { ok: false; code: string; message: string; status: number }> {
  try {
    let res: Response;
    if (runner.c) {
      res = await placeOrder(runner.c, user, body, hooks);
    } else {
      // No request exists (the cron): the same door, behind a one-route app so
      // `placeOrder` gets a real context — env, waitUntil, a JSON response.
      const app = new Hono<AppContext>();
      app.post('/', (c) => {
        c.set('user', user);
        return placeOrder(c, user, body, hooks);
      });
      app.onError((err, c) =>
        err instanceof HttpError
          ? c.json({ success: false, error: err.message, code: err.code ?? 'ERROR' }, err.status as 400)
          : c.json({ success: false, error: err instanceof Error ? err.message : String(err), code: 'ERROR' }, 500)
      );
      res = await app.request('https://quick-buy.internal/', { method: 'POST' }, env, runner.ctx);
    }
    const json = (await res.json()) as { success?: boolean; code?: string; error?: string };
    if (res.ok && json.success) return { ok: true };
    return { ok: false, code: json.code ?? 'ERROR', message: json.error ?? '', status: res.status };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, code: e.code ?? 'ERROR', message: e.message, status: e.status };
    return { ok: false, code: 'ERROR', message: e instanceof Error ? e.message : String(e), status: 500 };
  }
}

/** Free everything a session holds and close it. Used when nothing is left to
 *  order and when an administrator cancels a session that could not be submitted. */
export async function releaseSession(
  db: D1Database,
  session: QuickBuySessionRow,
  items: readonly QuickBuyItemRow[],
  opts: { state: 'cancelled'; reason: string; actorId: string; fromStates: Array<QuickBuySessionRow['state']> }
): Promise<boolean> {
  const moves = items
    .filter((it) => it.reserved_qty > 0)
    .map((it) => heldMove(it.product_id, it.id, parseJson<HeldTarget[]>(it.stock_targets, []), it.reserved_qty))
    .filter((m) => m.targets.length > 0);
  const plan = moves.length
    ? await planInventory(db, moves, { kind: 'release', operationId: `qbx_${session.id}`, actorUserId: opts.actorId, reason: `quick_buy:${session.id}` })
    : null;
  const audit = await auditStatements(db, opts.actorId, 'quick_buy.cancel', session.id, { reason: opts.reason, user_id: session.user_id });
  const placeholders = opts.fromStates.map(() => '?').join(', ');
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE quick_buy_sessions
            SET state = ?, cancelled_at = ${SQL_NOW}, cancel_reason = ?, lease_until = NULL, rev = rev + 1, updated_at = ${SQL_NOW}
          WHERE id = ? AND rev = ? AND state IN (${placeholders})`
      )
      .bind(opts.state, opts.reason, session.id, session.rev, ...opts.fromStates),
    ...fence(db, '(SELECT state FROM quick_buy_sessions WHERE id = ?) = ?', [session.id, opts.state]),
    db.prepare(`UPDATE quick_buy_items SET reserved_qty = 0, updated_at = ${SQL_NOW} WHERE session_id = ?`).bind(session.id),
    ...(plan ? [...plan.statements, ...planFence(db, plan)] : []),
    ...audit.statements,
  ];
  if (session.hold_id) {
    stmts.push(
      releaseHoldStatement(db, { holdId: session.hold_id, reason: `quick_buy:${opts.reason}` }),
      assertHoldStateStatement(db, session.hold_id, 'released'),
      eventStatement(db, {
        session_id: session.id,
        user_id: session.user_id,
        kind: 'release',
        amount_iqd: session.held_iqd,
        amount_cents: session.held_cents,
        hold_id: session.hold_id,
        detail: { reason: opts.reason },
      })
    );
  }
  stmts.push(eventStatement(db, { session_id: session.id, user_id: session.user_id, kind: 'cancel', detail: { reason: opts.reason, by: opts.actorId } }));
  try {
    await db.batch(stmts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Submit one expired session. Safe to call from anywhere at any time: a
 * session that is not due, not open or already being finalised is skipped.
 */
export async function finalizeQuickBuySession(env: Env, runner: FinalizeRunner, sessionId: string): Promise<FinalizeOutcome> {
  const db = env.DB;
  const leaseUntil = new Date(Date.now() + QUICK_BUY_LEASE_MS).toISOString();
  const claim = await db
    .prepare(
      `UPDATE quick_buy_sessions
          SET lease_until = ?, finalize_attempts = finalize_attempts + 1, updated_at = ${SQL_NOW}
        WHERE id = ? AND state = 'open' AND expires_at <= ${SQL_NOW}
          AND (lease_until IS NULL OR lease_until < ${SQL_NOW})`
    )
    .bind(leaseUntil, sessionId)
    .run();
  if (!claim.meta.changes) return { status: 'skipped' };
  const session = await loadSession(db, sessionId);
  if (!session || session.state !== 'open') return { status: 'skipped' };
  const [user, items] = await Promise.all([
    db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first<SessionUser>(),
    liveItems(db, session.id),
  ]);
  if (!user || items.length === 0) {
    await releaseSession(db, session, items, { state: 'cancelled', reason: 'empty', actorId: session.user_id, fromStates: ['open'] });
    return { status: 'cancelled' };
  }

  const releaseMoves = items
    .filter((it) => it.reserved_qty > 0)
    .map((it) => heldMove(it.product_id, it.id, parseJson<HeldTarget[]>(it.stock_targets, []), it.reserved_qty))
    .filter((m) => m.targets.length > 0);
  const releasePlan = releaseMoves.length
    ? await planInventory(db, releaseMoves, {
        kind: 'release',
        operationId: `qbf_${session.id}`,
        actorUserId: session.user_id,
        reason: `quick_buy:${session.id}`,
      })
    : null;
  const credit = heldCredit(items);
  const consent = parseJson<{ acceptance_ids?: Record<string, string> }>(session.consent_json, {});
  const printerAck = parseJson<Record<string, unknown> | null>(session.printer_ack_json, null);

  const hooks: QuickBuyOrderHooks = {
    sessionId: session.id,
    orderId: session.order_id,
    source: {
      lines: {
        build: (projection) =>
          `SELECT ci.id AS cart_item_id, ci.qty, ${projection}, p.*
             FROM quick_buy_items ci JOIN products p ON p.id = ci.product_id
            WHERE ci.session_id = ? AND ci.qty > 0`,
        params: [session.id],
      },
      address: parseJson<Record<string, unknown>>(session.address_snapshot, {}),
      reservedCredit: credit,
      walletCreditCents: session.hold_id ? session.held_cents : 0,
      unitCeilings: new Map(items.map((it) => [it.id, it.unit_price_iqd])),
      shippingCeilingIqd: session.shipping_iqd,
      exchangeRate: session.exchange_rate,
    },
    reservedCredit: credit,
    before: [
      ...(session.hold_id
        ? [
            releaseHoldStatement(db, { holdId: session.hold_id, reason: 'quick_buy:submit' }),
            assertHoldStateStatement(db, session.hold_id, 'released'),
          ]
        : []),
      ...(releasePlan ? [...releasePlan.statements, ...planFence(db, releasePlan)] : []),
    ],
    after: (comp) => [
      db
        .prepare(
          `UPDATE quick_buy_sessions
              SET state = 'submitted', submitted_at = ${SQL_NOW}, lease_until = NULL, finalize_error = NULL,
                  total_iqd = ?, held_iqd = 0, held_cents = 0, updated_at = ${SQL_NOW}
            WHERE id = ? AND state = 'open' AND expires_at <= ${SQL_NOW}`
        )
        .bind(Math.max(0, Math.trunc(comp.totalIqd)), session.id),
      ...fence(db, `(SELECT state FROM quick_buy_sessions WHERE id = ?) = 'submitted'`, [session.id]),
      db.prepare(`UPDATE quick_buy_items SET reserved_qty = 0, updated_at = ${SQL_NOW} WHERE session_id = ?`).bind(session.id),
      eventStatement(db, {
        session_id: session.id,
        user_id: session.user_id,
        kind: 'capture',
        amount_iqd: comp.walletApplied,
        amount_cents: comp.walletUsdCents,
        hold_id: session.hold_id,
        order_id: session.order_id,
        detail: { total_iqd: comp.totalIqd, shipping_iqd: comp.shipping.total_iqd },
      }),
      ...(session.held_cents - comp.walletUsdCents > 0 || session.held_iqd - comp.walletApplied > 0
        ? [
            eventStatement(db, {
              session_id: session.id,
              user_id: session.user_id,
              kind: 'release',
              amount_iqd: Math.max(0, session.held_iqd - comp.walletApplied),
              amount_cents: Math.max(0, session.held_cents - comp.walletUsdCents),
              hold_id: session.hold_id,
              order_id: session.order_id,
              detail: { reason: 'final_total_lower' },
            }),
          ]
        : []),
      ...releaseMoves.map((m) =>
        eventStatement(db, {
          session_id: session.id,
          user_id: session.user_id,
          kind: 'unreserve',
          item_id: m.line_id,
          order_id: session.order_id,
          detail: { qty: m.qty, moved_to_order: true },
        })
      ),
      eventStatement(db, { session_id: session.id, user_id: session.user_id, kind: 'submit', order_id: session.order_id }),
    ],
    policyStatements: async (orderId) => consentStatements(db, session.user_id, orderId, consent.acceptance_ids ?? {}),
    guard: (comp) => {
      // The locks above keep every unit price and the delivery fee at or under
      // what was quoted; this is the last line for anything they cannot see
      // (a membership discount that lapsed in the window). Never charge more
      // than the hold — the session waits for an administrator instead.
      if (comp.totalIqd > session.held_iqd || comp.walletUsdCents > session.held_cents) {
        throw new HttpError(
          409,
          `The final total ${comp.totalIqd} is above the held ${session.held_iqd}`,
          'QUICK_BUY_TOTAL_ABOVE_HOLD'
        );
      }
    },
  };

  const body: Record<string, unknown> = {
    addressId: session.address_id || 'quick_buy',
    deliveryMethodId: 'standard',
    paymentMethodId: 'wallet',
    itemIds: [],
    usePoints: false,
    useWallet: false,
    idempotencyKey: `qb_${session.id}`,
    ...(printerAck ? { printerStandardDeliveryAcceptance: printerAck } : {}),
  };
  const result = await runOrderDoor(env, runner, user, body, hooks);
  const after = await loadSession(db, session.id);
  if (after?.state === 'submitted') {
    await notify(db, {
      userId: session.user_id,
      kind: 'quick_buy_submitted',
      title_ar: 'تم إرسال طلب الشراء السريع',
      title_en: 'Your Quick Buy order was submitted',
      body_ar: `طلبك رقم ${session.order_id} في طريقه إلى التجهيز.`,
      body_en: `Order ${session.order_id} is on its way to preparation.`,
      link: `/orders/${session.order_id}`,
      entity_type: 'order',
      entity_id: session.order_id,
      eventKey: `quick_buy_submitted:${session.id}`,
    });
    return { status: 'submitted', orderId: session.order_id };
  }
  const code = result.ok ? 'QUICK_BUY_NOT_SUBMITTED' : result.code;
  // `session` was read AFTER the claim, so its count already includes this attempt.
  const terminal = session.finalize_attempts >= QUICK_BUY_FINALIZE_MAX_ATTEMPTS;
  await db
    .prepare(
      `UPDATE quick_buy_sessions
          SET lease_until = NULL, finalize_error = ?, state = CASE WHEN ? = 1 THEN 'failed' ELSE state END, updated_at = ${SQL_NOW}
        WHERE id = ? AND state = 'open'`
    )
    .bind(`${code}${result.ok ? '' : `: ${result.message}`}`.slice(0, 500), terminal ? 1 : 0, session.id)
    .run();
  if (terminal) {
    await db.batch([eventStatement(db, { session_id: session.id, user_id: session.user_id, kind: 'fail', detail: { code } })]).catch(() => undefined);
    await notify(db, {
      userId: session.user_id,
      kind: 'quick_buy_failed',
      title_ar: 'تعذّر إرسال طلب الشراء السريع تلقائياً',
      title_en: 'Your Quick Buy order could not be submitted automatically',
      body_ar: 'المبلغ ما زال محجوزاً لطلبك ولم يُخصم، وسيراجعه فريق Levonis ويتواصل معك.',
      body_en: 'The amount is still held for your order and was not charged; the Levonis team will review it and contact you.',
      link: '/orders',
      entity_type: 'order',
      entity_id: session.order_id,
      eventKey: `quick_buy_failed:${session.id}`,
    });
    return { status: 'failed', code };
  }
  return { status: 'retry', code };
}

/** The cron's half of D13: every session whose time has run out, oldest first, bounded. */
export async function finalizeDueQuickBuySessions(env: Env, ctx: ExecutionContext, limit = 10): Promise<FinalizeOutcome[]> {
  let due: Array<{ id: string }> = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id FROM quick_buy_sessions
        WHERE state = 'open' AND expires_at <= ${SQL_NOW} AND (lease_until IS NULL OR lease_until < ${SQL_NOW})
        ORDER BY expires_at LIMIT ?`
    )
      .bind(limit)
      .all<{ id: string }>();
    due = results ?? [];
  } catch (e) {
    // A database that has not reached migration 0176 has no sessions to submit.
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return [];
    throw e;
  }
  const out: FinalizeOutcome[] = [];
  for (const s of due) {
    out.push(await finalizeQuickBuySession(env, { ctx }, s.id).catch((e) => ({ status: 'retry' as const, code: String(e).slice(0, 120) })));
  }
  return out;
}
