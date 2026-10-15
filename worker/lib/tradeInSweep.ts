/**
 * THE SERVICES SWEEP (Services S-P2 spec §6.10, §7; DECISIONS row 238) — the quarter-hour tick's
 * last step, inside what the tick left (`quarterHourServicesBudget`, at most 120 statements).
 *
 * Seven sub-steps, in order, each at most 25 requests, each idempotent by its WHERE and its event
 * key (a second tick does nothing the first one did):
 *   1. cut-over: a request open when S-P2 landed gets its 7 days to hand the device in
 *      (`offer_expires_at`); a legacy credit not spent is told, once, that the device comes first,
 *      and its end is at least the owner's credit window from then (`coupons.ends_at`) — the
 *      only writes on old rows, both on trade-in rows and coupons, never on orders or money;
 *   2. an offer ending within 24 hours: a reminder;
 *   3. an offer past its end, device not received: cancelled (`expired_offer`), claims released;
 *   4. a credit ending within 24 hours and not spent: a reminder;
 *   5. a credit past its end and not spent: cancelled (`expired_credit`), the coupon off, the
 *      device (if received) waits to be collected;
 *   6. completion catch-up: a delivered order holding an awaiting request's credit completes it
 *      (the delivered hook missed it), and a completed request whose device was received later
 *      books its stock;
 *   7. a credit given back (the 0192 cancel trigger, the return batch) is told to its customer.
 *
 * EVERY STATEMENT IS CHARGED BEFORE IT IS SENT: a read before its read, a batch before its batch
 * (`ServicesBudget.spend`), a completion at its measured upper bound. A step that does not fit
 * stops the sweep cleanly; the next tick resumes. A request's batch that loses a race (an intake,
 * a checkout, a customer's cancel) aborts on its fence and is skipped — never retried in the tick.
 *
 * The in-app notice and its email/WhatsApp copy ride in the same batch as the state they announce
 * (`planNotifyCustomer`'s `ON CONFLICT DO NOTHING` rows): the event and the request's reference
 * only, never a figure (row 107).
 */
import type { Env } from './types';
import { newId, randomToken } from './crypto';
import { notifyStatement } from './notifications';
import { getSetting } from './settings';
import { tradeInV2Installed } from './tradeInSchema';
import { channelsLive, type LiveChannels } from './channelReadiness';
import { planNotifyCustomer, reachForMany, type CustomerReach } from './customerNotify';
import type { EmailLang } from './emailTemplates';
import {
  appOrigin,
  dayText,
  deviceReadyNotice,
  eventStatement,
  fence,
  isAbort,
  loadRequest,
  noLiveCreditOrderFence,
  releaseStatements,
  requestPath,
} from './tradeIn';
import { bookTradeInStock, completeTradeInsForOrder } from './tradeInStock';
import { reissueNotice } from './tradeInReissue';

/** Requests per sub-step per tick. */
export const SWEEP_STEP_LIMIT = 25;
/** Completion catch-ups per tick (each is a whole completion batch). */
export const SWEEP_COMPLETIONS = 2;
/**
 * The most statements one completion on delivery sends, reads included (measured by
 * tests/sv2_p2_expiry_sweep.test.ts on the counting view, with room to spare).
 */
export const COMPLETION_STATEMENT_BOUND = 45;
/** The most statements one late stock booking sends, reads included (measured the same way). */
export const STOCK_BOOKING_STATEMENT_BOUND = 25;
/** A completion or stock booking that failed waits this long before the sweep tries it again. */
export const RETRY_AFTER_HOURS = 6;
/** Reissue rows this recent still owe their notice. */
const REISSUE_NOTICE_DAYS = 14;
const DAY = 86_400_000;

const OPEN_BEFORE_INTAKE = `('submitted','under_review','value_changed')`;
const LIVE_CREDIT_ORDER = (coupon: string) =>
  `EXISTS (SELECT 1 FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id
            WHERE r.coupon_id = ${coupon} AND r.state = 'active' AND o.status <> 'cancelled')`;

export interface ServicesSweepReport {
  stamped: number;
  offer_reminders: number;
  offers_expired: number;
  credit_reminders: number;
  credits_expired: number;
  completed: number;
  stock_booked: number;
  reissue_notices: number;
  /** True when the budget ran out before every step had looked. */
  stopped: boolean;
}

interface Copy {
  title_ar: string;
  title_en: string;
  title_ckb: string;
  body_ar: string;
  body_en: string;
  body_ckb: string;
}

const pick = (c: Copy, lang: EmailLang) => (lang === 'en' ? [c.title_en, c.body_en] : lang === 'ckb' ? [c.title_ckb, c.body_ckb] : [c.title_ar, c.body_ar]);

/**
 * The statement budget the sweep charges: the shape of worker/lib/fx/budget.ts `StatementBudget`,
 * which the quarter-hour cron hands in. Named here rather than imported — the FX module is imported
 * only by the cron and the pricing doors (tests/pricingCurrencyRoles.test.ts).
 */
export interface ServicesBudget {
  /** Charges `n` statements; false (and nothing charged) when they do not fit. */
  spend(n: number): boolean;
}

class Stop extends Error {}

/**
 * THE SWEEP. Never throws (a step's failure is logged and the next tick tries again); returns what
 * it did. A database without 0192 does nothing.
 */
export async function runServicesSweep(env: Env, budget: ServicesBudget, now: Date = new Date()): Promise<ServicesSweepReport> {
  const report: ServicesSweepReport = {
    stamped: 0,
    offer_reminders: 0,
    offers_expired: 0,
    credit_reminders: 0,
    credits_expired: 0,
    completed: 0,
    stock_booked: 0,
    reissue_notices: 0,
    stopped: false,
  };
  const db = env.DB;
  const nowIso = now.toISOString();
  const charge = (n: number) => {
    if (!budget.spend(n)) throw new Stop();
  };
  let live: LiveChannels | null = null;
  const origin = appOrigin(env);

  /** The email / WhatsApp rows for a set of notices, for the batch they ride in (reference only). */
  const external = async (items: Array<{ userId: string; requestId: string; key: string; copy: Copy }>) => {
    if (!items.length) return new Map<string, D1PreparedStatement[]>();
    if (!live) {
      charge(1);
      live = await channelsLive(env);
    }
    charge(1);
    const reach = await reachForMany(env, items.map((i) => i.userId));
    const out = new Map<string, D1PreparedStatement[]>();
    for (const i of items) {
      const r: CustomerReach | undefined = reach.get(i.userId);
      if (!r) continue;
      const [subject, body] = pick(i.copy, r.lang);
      const plan = await planNotifyCustomer(
        env,
        i.userId,
        i.key,
        { subject, body, ...(origin ? { cta: { label: r.lang === 'en' ? 'Open' : r.lang === 'ckb' ? 'بیکەرەوە' : 'افتح', url: `${origin}${requestPath(i.requestId)}` } } : {}) },
        { channels: ['email', 'whatsapp'], reach: r, live: live! }
      );
      out.set(i.key, plan.statements);
    }
    return out;
  };
  const inApp = (userId: string, requestId: string, key: string, c: Copy) =>
    notifyStatement(db, {
      userId,
      kind: 'trade_in',
      title_ar: c.title_ar,
      title_en: c.title_en,
      body_ar: c.body_ar,
      body_en: c.body_en,
      meta: { title_ckb: c.title_ckb, body_ckb: c.body_ckb },
      link: requestPath(requestId),
      entity_type: 'trade_in',
      entity_id: requestId,
      eventKey: key,
    }).stmt;
  /** One request's batch, charged first; a lost race (the fence) is skipped. */
  const send = async (stmts: D1PreparedStatement[]): Promise<boolean> => {
    charge(stmts.length);
    try {
      await db.batch(stmts);
      return true;
    } catch (e) {
      if (isAbort(e)) return false;
      throw e;
    }
  };

  try {
    charge(2); // the schema probe (two reads on a fresh binding)
    if (!(await tradeInV2Installed(db))) return report;

    // ---------------------------------------------------------------- 1. cut-over
    charge(1);
    const { results: open } = await db
      .prepare(
        `SELECT id, user_id FROM trade_in_requests
          WHERE status IN ${OPEN_BEFORE_INTAKE} AND intake_at IS NULL AND offer_expires_at IS NULL
          ORDER BY submitted_at, id LIMIT ?`
      )
      .bind(SWEEP_STEP_LIMIT)
      .all<{ id: string; user_id: string }>();
    charge(1);
    const { results: legacy } = await db
      .prepare(
        // Every credit minted on photos before S-P2 and not spent (review F-17) — whether or not it
        // already had an end (S-P0's seven days): it cannot be spent until the device is received
        // (0192), so its customer is told so once and gets the owner's window to hand it in.
        `SELECT t.id, t.user_id, t.coupon_id FROM trade_in_requests t JOIN coupons c ON c.id = t.coupon_id AND c.trade_in_id = t.id
          WHERE t.status = 'awaiting_payment' AND t.intake_at IS NULL AND c.active = 1
            AND NOT EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = t.id AND e.action = 'cutover')
            AND NOT ${LIVE_CREDIT_ORDER('c.id')}
          ORDER BY t.id LIMIT ?`
      )
      .bind(SWEEP_STEP_LIMIT)
      .all<{ id: string; user_id: string; coupon_id: string }>();
    // The owner's windows, read only when there is a request to stamp.
    let offerDays = 7;
    let creditDays = 7;
    if ((open ?? []).length || (legacy ?? []).length) {
      charge(1);
      const policy = await getSetting(db, 'tradeInPolicy');
      [offerDays, creditDays] = [policy.offer_valid_days, policy.credit_valid_days];
    }
    const until = new Date(now.getTime() + offerDays * DAY).toISOString();
    const creditUntil = new Date(now.getTime() + creditDays * DAY).toISOString();
    const cutoverItems = [
      ...(open ?? []).map((r) => ({ userId: r.user_id, requestId: r.id, key: `trade_in:${r.id}:cutover`, copy: cutoverCopy(until), legacy: null as string | null })),
      ...(legacy ?? []).map((r) => ({ userId: r.user_id, requestId: r.id, key: `trade_in:${r.id}:cutover`, copy: cutoverCreditCopy(creditUntil), legacy: r.coupon_id })),
    ].slice(0, SWEEP_STEP_LIMIT);
    const cutoverExt = await external(cutoverItems);
    for (const i of cutoverItems) {
      const stamp = i.legacy
        ? db
            .prepare(`UPDATE coupons SET ends_at = CASE WHEN ends_at IS NULL OR ends_at < ?3 THEN ?3 ELSE ends_at END WHERE id = ?1 AND trade_in_id = ?2`)
            .bind(i.legacy, i.requestId, creditUntil)
        : db
            .prepare(
              `UPDATE trade_in_requests SET offer_expires_at = ?2, updated_at = ?3
                WHERE id = ?1 AND status IN ${OPEN_BEFORE_INTAKE} AND intake_at IS NULL AND offer_expires_at IS NULL`
            )
            .bind(i.requestId, until, nowIso);
      const ok = await send([
        stamp,
        db
          .prepare(
            `INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, from_status, to_status, detail_json, created_at)
             SELECT ?1, t.id, NULL, 'system', 'cutover', t.status, t.status, ?3, ?4 FROM trade_in_requests t
              WHERE t.id = ?2 AND NOT EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = ?2 AND e.action = 'cutover')`
          )
          .bind(newId('tie'), i.requestId, JSON.stringify(i.legacy ? { credit_ends_at: creditUntil } : { offer_expires_at: until }), nowIso),
        inApp(i.userId, i.requestId, i.key, i.copy),
        ...(cutoverExt.get(i.key) ?? []),
      ]);
      if (ok) report.stamped += 1;
    }

    // ---------------------------------------------------------------- 2. offer ending soon
    charge(1);
    const { results: ending } = await db
      .prepare(
        `SELECT t.id, t.user_id FROM trade_in_requests t
          WHERE t.status IN ${OPEN_BEFORE_INTAKE} AND t.intake_at IS NULL AND t.offer_expires_at > ?1 AND t.offer_expires_at <= ?2
            AND NOT EXISTS (SELECT 1 FROM user_notifications n WHERE n.event_key = 'trade_in:' || t.id || ':offer_expiring')
          ORDER BY t.offer_expires_at LIMIT ?3`
      )
      .bind(nowIso, new Date(now.getTime() + DAY).toISOString(), SWEEP_STEP_LIMIT)
      .all<{ id: string; user_id: string }>();
    const endingItems = (ending ?? []).map((r) => ({ userId: r.user_id, requestId: r.id, key: `trade_in:${r.id}:offer_expiring`, copy: OFFER_EXPIRING }));
    const endingExt = await external(endingItems);
    for (const i of endingItems) {
      charge(1 + (endingExt.get(i.key)?.length ?? 0));
      await db.batch([inApp(i.userId, i.requestId, i.key, i.copy), ...(endingExt.get(i.key) ?? [])]);
      report.offer_reminders += 1;
    }

    // ---------------------------------------------------------------- 3. offer expired
    charge(1);
    const { results: expired } = await db
      .prepare(
        `SELECT id, status, user_id FROM trade_in_requests
          WHERE status IN ${OPEN_BEFORE_INTAKE} AND intake_at IS NULL AND offer_expires_at IS NOT NULL AND offer_expires_at < ?1
          ORDER BY offer_expires_at LIMIT ?2`
      )
      .bind(nowIso, SWEEP_STEP_LIMIT)
      .all<{ id: string; status: 'submitted' | 'under_review' | 'value_changed'; user_id: string }>();
    for (const r of expired ?? []) {
      const token = randomToken(12);
      const ok = await send([
        db
          .prepare(
            `UPDATE trade_in_requests
                SET status = 'cancelled', cancelled_at = ?2, updated_at = ?2, cancel_reason = 'expired_offer', cancelled_by = NULL, decision_token = ?3
              WHERE id = ?1 AND status = ?4 AND intake_at IS NULL AND offer_expires_at < ?2`
          )
          .bind(r.id, nowIso, token, r.status),
        fence(db, r.id, token),
        noLiveCreditOrderFence(db, r.id),
        ...(await releaseStatements(db, { id: r.id })),
        eventStatement(db, r.id, { id: null, role: 'system' }, 'cancel', r.status, 'cancelled', { reason: 'expired_offer' }, nowIso),
        inApp(r.user_id, r.id, `trade_in:${r.id}:expired_offer`, OFFER_EXPIRED),
      ]);
      if (ok) report.offers_expired += 1;
    }

    // ---------------------------------------------------------------- 4. credit ending soon
    charge(1);
    const { results: creditEnding } = await db
      .prepare(
        `SELECT t.id, t.user_id, c.ends_at, t.intake_at FROM trade_in_requests t JOIN coupons c ON c.id = t.coupon_id AND c.trade_in_id = t.id
          WHERE ((t.status = 'awaiting_payment' AND (t.intake_at IS NOT NULL
                   OR EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = t.id AND e.action = 'cutover')))
                 OR (t.status = 'completed' AND EXISTS (SELECT 1 FROM trade_in_credit_reissues x WHERE x.request_id = t.id AND x.ends_at > ?1)))
            AND c.active = 1 AND c.ends_at > ?1 AND c.ends_at <= ?2
            AND NOT ${LIVE_CREDIT_ORDER('c.id')}
            AND NOT EXISTS (SELECT 1 FROM user_notifications n WHERE n.event_key = 'trade_in:' || t.id || ':credit_expiring:' || substr(c.ends_at, 1, 10))
          ORDER BY c.ends_at LIMIT ?3`
      )
      .bind(nowIso, new Date(now.getTime() + DAY).toISOString(), SWEEP_STEP_LIMIT)
      .all<{ id: string; user_id: string; ends_at: string; intake_at: string | null }>();
    const creditItems = (creditEnding ?? []).map((r) => ({
      userId: r.user_id,
      requestId: r.id,
      key: `trade_in:${r.id}:credit_expiring:${dayText(r.ends_at)}`,
      // A credit minted on photos before S-P2 is spent only once the device is in: say so (review F-17).
      copy: r.intake_at ? CREDIT_EXPIRING : CREDIT_EXPIRING_NO_DEVICE,
    }));
    const creditExt = await external(creditItems);
    for (const i of creditItems) {
      charge(1 + (creditExt.get(i.key)?.length ?? 0));
      await db.batch([inApp(i.userId, i.requestId, i.key, i.copy), ...(creditExt.get(i.key) ?? [])]);
      report.credit_reminders += 1;
    }

    // ---------------------------------------------------------------- 5. credit expired
    charge(1);
    const { results: creditGone } = await db
      .prepare(
        `SELECT t.id, t.user_id, t.intake_at FROM trade_in_requests t JOIN coupons c ON c.id = t.coupon_id AND c.trade_in_id = t.id
          WHERE t.status = 'awaiting_payment' AND c.ends_at IS NOT NULL AND c.ends_at < ?1 AND NOT ${LIVE_CREDIT_ORDER('c.id')}
          ORDER BY c.ends_at LIMIT ?2`
      )
      .bind(nowIso, SWEEP_STEP_LIMIT)
      .all<{ id: string; user_id: string; intake_at: string | null }>();
    for (const r of creditGone ?? []) {
      const token = randomToken(12);
      const ok = await send([
        db
          .prepare(
            `UPDATE trade_in_requests
                SET status = 'cancelled', cancelled_at = ?2, updated_at = ?2, cancel_reason = 'expired_credit', cancelled_by = NULL, decision_token = ?3
              WHERE id = ?1 AND status = 'awaiting_payment'
                AND EXISTS (SELECT 1 FROM coupons c WHERE c.id = trade_in_requests.coupon_id AND c.ends_at < ?2)`
          )
          .bind(r.id, nowIso, token),
        fence(db, r.id, token),
        noLiveCreditOrderFence(db, r.id),
        ...(await releaseStatements(db, { id: r.id })),
        eventStatement(db, r.id, { id: null, role: 'system' }, 'cancel', 'awaiting_payment', 'cancelled', { reason: 'expired_credit' }, nowIso),
        inApp(r.user_id, r.id, `trade_in:${r.id}:expired_credit`, r.intake_at ? CREDIT_EXPIRED : CREDIT_EXPIRED_NO_DEVICE),
        ...(r.intake_at ? [deviceReadyNotice(db, { id: r.id, user_id: r.user_id })] : []),
      ]);
      if (ok) report.credits_expired += 1;
    }

    // ---------------------------------------------------------------- 6. completion catch-up
    // Rotating (review F-7/F-16): a request whose completion failed within the last
    // RETRY_AFTER_HOURS waits, and the oldest last attempt goes first — one that keeps failing
    // never holds the two places every tick (the desk sees it as overdue meanwhile).
    const retryAfter = new Date(now.getTime() - RETRY_AFTER_HOURS * 3_600_000).toISOString();
    charge(1);
    const { results: deliveredOrders } = await db
      .prepare(
        `SELECT r.order_id,
                MAX((SELECT MAX(e.created_at) FROM trade_in_events e WHERE e.request_id = t.id AND e.action = 'completion_failed')) AS last_failed
           FROM trade_in_requests t
           JOIN coupon_redemptions r ON r.coupon_id = t.coupon_id AND r.state = 'active'
           JOIN orders o ON o.id = r.order_id AND o.status = 'delivered'
          WHERE t.status = 'awaiting_payment'
            AND NOT EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = t.id AND e.action = 'completion_failed' AND e.created_at > ?1)
          GROUP BY r.order_id
          ORDER BY last_failed IS NOT NULL, last_failed, r.order_id LIMIT ?2`
      )
      .bind(retryAfter, SWEEP_COMPLETIONS)
      .all<{ order_id: string }>();
    for (const o of deliveredOrders ?? []) {
      charge(COMPLETION_STATEMENT_BOUND);
      report.completed += (await completeTradeInsForOrder(env, o.order_id)).length;
    }
    charge(1);
    const { results: unbooked } = await db
      .prepare(
        `SELECT t.id FROM trade_in_requests t
          WHERE t.status = 'completed' AND t.intake_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM trade_in_stock s WHERE s.request_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = t.id AND e.action = 'stock_skipped')
            AND NOT EXISTS (SELECT 1 FROM trade_in_events e WHERE e.request_id = t.id AND e.action = 'stock_failed' AND e.created_at > ?1)
          ORDER BY (SELECT MAX(e.created_at) FROM trade_in_events e WHERE e.request_id = t.id AND e.action = 'stock_failed') IS NOT NULL,
                   (SELECT MAX(e.created_at) FROM trade_in_events e WHERE e.request_id = t.id AND e.action = 'stock_failed'), t.intake_at LIMIT ?2`
      )
      .bind(retryAfter, SWEEP_COMPLETIONS)
      .all<{ id: string }>();
    for (const u of unbooked ?? []) {
      charge(STOCK_BOOKING_STATEMENT_BOUND);
      const req = await loadRequest(db, u.id);
      try {
        if (req && (await bookTradeInStock(env, req))) report.stock_booked += 1;
      } catch (e) {
        console.error('services sweep: stock booking failed', u.id, e instanceof Error ? e.message : String(e));
      }
    }

    // ---------------------------------------------------------------- 7. credits given back
    charge(1);
    const { results: reissued } = await db
      .prepare(
        `SELECT x.request_id, x.order_id, x.ends_at, t.user_id FROM trade_in_credit_reissues x JOIN trade_in_requests t ON t.id = x.request_id
          WHERE x.created_at > ?1
            AND NOT EXISTS (SELECT 1 FROM user_notifications n WHERE n.event_key = 'trade_in:' || x.request_id || ':reissued:' || x.order_id)
          ORDER BY x.created_at LIMIT ?2`
      )
      .bind(new Date(now.getTime() - REISSUE_NOTICE_DAYS * DAY).toISOString(), SWEEP_STEP_LIMIT)
      .all<{ request_id: string; order_id: string; ends_at: string; user_id: string }>();
    const reissueItems = (reissued ?? []).map((r) => ({
      userId: r.user_id,
      requestId: r.request_id,
      orderId: r.order_id,
      endsAt: r.ends_at,
      key: `trade_in:${r.request_id}:reissued:${r.order_id}`,
      copy: reissuedCopy(r.ends_at),
    }));
    const reissueExt = await external(reissueItems);
    for (const i of reissueItems) {
      charge(1 + (reissueExt.get(i.key)?.length ?? 0));
      await db.batch([reissueNotice(db, { requestId: i.requestId, userId: i.userId, orderId: i.orderId, endsAt: i.endsAt }), ...(reissueExt.get(i.key) ?? [])]);
      report.reissue_notices += 1;
    }
  } catch (e) {
    if (e instanceof Stop) report.stopped = true;
    else console.error('services sweep failed', e instanceof Error ? e.message : String(e));
  }
  return report;
}

// ------------------------------------------------------------------ the copy (ar / en / ckb)

function cutoverCopy(until: string): Copy {
  const d = dayText(until);
  return {
    title_ar: `سلّم جهازك للمتجر قبل ${d} لإكمال الاستبدال`,
    title_en: `Hand your device in to the store by ${d} to complete your trade-in`,
    title_ckb: `ئامێرەکەت پێش ${d} ڕادەستی فرۆشگا بکە بۆ تەواوکردنی گۆڕینەوەکە`,
    body_ar: 'تغيّرت طريقة الاستبدال: نفحص الجهاز في المتجر ثم نثبّت القيمة النهائية.',
    body_en: 'Trade-ins have changed: we inspect the device in the store, then fix the final value.',
    body_ckb: 'شێوازی گۆڕینەوە گۆڕاوە: ئامێرەکە لە فرۆشگا دەپشکنین، پاشان بەهای کۆتایی دیاری دەکەین.',
  };
}

function cutoverCreditCopy(until: string): Copy {
  const d = dayText(until);
  return {
    title_ar: `سلّم جهازك قبل ${d} ليصبح رصيد الاستبدال قابلاً للصرف`,
    title_en: `Hand your device in by ${d} to use your trade-in credit`,
    title_ckb: `ئامێرەکەت پێش ${d} ڕادەست بکە بۆ ئەوەی باڵانسی گۆڕینەوەکەت بەکاربهێنیت`,
    body_ar: 'يُصرف رصيد الاستبدال بعد استلام الجهاز القديم وفحصه في المتجر.',
    body_en: 'The trade-in credit is spendable once the store has received and checked your old device.',
    body_ckb: 'باڵانسی گۆڕینەوە دوای وەرگرتن و پشکنینی ئامێرە کۆنەکەت لە فرۆشگا بەکاردێت.',
  };
}

const OFFER_EXPIRING: Copy = {
  title_ar: 'ينتهي عرض الاستبدال خلال 24 ساعة',
  title_en: 'Your trade-in offer ends within 24 hours',
  title_ckb: 'پێشنیاری گۆڕینەوەکەت لە ماوەی ٢٤ کاتژمێردا کۆتایی دێت',
  body_ar: 'سلّم جهازك للمتجر قبل انتهاء العرض.',
  body_en: 'Hand your device in to the store before the offer ends.',
  body_ckb: 'پێش کۆتاییهاتنی پێشنیارەکە ئامێرەکەت ڕادەستی فرۆشگا بکە.',
};

const OFFER_EXPIRED: Copy = {
  title_ar: 'انتهت صلاحية عرض الاستبدال',
  title_en: 'Your trade-in offer has ended',
  title_ckb: 'ماوەی پێشنیاری گۆڕینەوەکەت تەواو بوو',
  body_ar: 'لم يصل الجهاز خلال المدة. يمكنك بدء طلب جديد بسعر اليوم.',
  body_en: 'The device did not reach us in time. You can start a new request at today’s price.',
  body_ckb: 'ئامێرەکە لە کاتی خۆیدا نەگەیشت. دەتوانیت داواکارییەکی نوێ بە نرخی ئەمڕۆ دەست پێ بکەیت.',
};

const CREDIT_EXPIRING: Copy = {
  title_ar: 'ينتهي رصيد الاستبدال خلال 24 ساعة',
  title_en: 'Your trade-in credit ends within 24 hours',
  title_ckb: 'باڵانسی گۆڕینەوەکەت لە ماوەی ٢٤ کاتژمێردا کۆتایی دێت',
  body_ar: 'اصرفه على جهاز متوفر للبيع المباشر قبل انتهائه.',
  body_en: 'Spend it on a device in stock for direct sale before it ends.',
  body_ckb: 'پێش کۆتاییهاتنی، بۆ ئامێرێکی بەردەست بۆ فرۆشتنی ڕاستەوخۆ بەکاری بهێنە.',
};

/** A credit minted on photos before S-P2, its device not received yet (review F-17). */
const CREDIT_EXPIRING_NO_DEVICE: Copy = {
  title_ar: 'ينتهي رصيد الاستبدال خلال 24 ساعة',
  title_en: 'Your trade-in credit ends within 24 hours',
  title_ckb: 'باڵانسی گۆڕینەوەکەت لە ماوەی ٢٤ کاتژمێردا کۆتایی دێت',
  body_ar: 'سلّم جهازك القديم للمتجر قبل انتهائه ليصبح الرصيد قابلاً للصرف.',
  body_en: 'Hand your old device in to the store before it ends, so the credit can be used.',
  body_ckb: 'پێش کۆتاییهاتنی، ئامێرە کۆنەکەت ڕادەستی فرۆشگا بکە بۆ ئەوەی باڵانسەکە بەکاربهێنرێت.',
};

const CREDIT_EXPIRED_NO_DEVICE: Copy = {
  title_ar: 'انتهت صلاحية رصيد الاستبدال',
  title_en: 'Your trade-in credit has ended',
  title_ckb: 'ماوەی باڵانسی گۆڕینەوەکەت تەواو بوو',
  body_ar: 'لم يصل جهازك القديم إلى المتجر خلال المدة، ولا يُصرف الرصيد نقداً.',
  body_en: 'Your old device did not reach the store in time, and the credit is never paid out as cash.',
  body_ckb: 'ئامێرە کۆنەکەت لە کاتی خۆیدا نەگەیشتە فرۆشگا، و باڵانسەکە هەرگیز وەک پارەی نەقد نادرێتەوە.',
};

const CREDIT_EXPIRED: Copy = {
  title_ar: 'انتهت صلاحية رصيد الاستبدال',
  title_en: 'Your trade-in credit has ended',
  title_ckb: 'ماوەی باڵانسی گۆڕینەوەکەت تەواو بوو',
  body_ar: 'لم يُصرف الرصيد خلال المدة، ولا يُصرف نقداً.',
  body_en: 'The credit was not spent in time, and it is never paid out as cash.',
  body_ckb: 'باڵانسەکە لە کاتی خۆیدا بەکارنەهات، و هەرگیز وەک پارەی نەقد نادرێتەوە.',
};

/** The credit given back, with the day it ends (30 days the first time, what was left after that). */
function reissuedCopy(endsAt: string): Copy {
  const d = dayText(endsAt);
  return {
    title_ar: `عاد رصيد الاستبدال — صالح حتى ${d} لأي جهاز متوفر للبيع المباشر`,
    title_en: `Your trade-in credit is back — valid until ${d} on any device in stock for direct sale`,
    title_ckb: `باڵانسی گۆڕینەوەکەت گەڕایەوە — تا ${d} بۆ هەر ئامێرێکی بەردەست بۆ فرۆشتنی ڕاستەوخۆ بەکاردێت`,
    body_ar: 'يُصرف على أي جهاز متوفر للبيع المباشر، ولا يُصرف نقداً.',
    body_en: 'Usable on any device in stock for direct sale, never as cash.',
    body_ckb: 'بۆ هەر ئامێرێکی بەردەست بۆ فرۆشتنی ڕاستەوخۆ بەکاردێت، نەک وەک پارەی نەقد.',
  };
}
