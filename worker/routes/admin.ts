import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import { asDocument } from '../lib/securityPolicy';
import { approvableWithdrawalSql, decideDeposit } from '../lib/walletOps';
import { closeDepositNotification, enqueueUserDepositStatusNotification } from '../lib/walletNotify';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAdmin, badRequest, notFound, forbidden, conflict, str, int, oneOf, jsonArray, email, HttpError } from '../lib/http';
import { newId, sha256Hex } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { canViewFinancials, isOwner, normalizeAdminScope, userPatchRefusal } from '../lib/adminScope';
import { degradeIfSchemaMissing } from '../lib/membershipBenefits';
import { normalizeText } from '../lib/search/normalize';
import { normalizeHomeBanners, normalizeSectionItems } from '../lib/homeContent';
import {
  findSiteMediaSlot,
  mintSiteMediaObject,
  normalizeSiteMedia,
  resolveSiteMedia,
  siteMediaKey,
  SITE_MEDIA_MAX_BYTES,
  SITE_MEDIA_MIME,
} from '../lib/siteMedia';
import { putMediaObject } from '../lib/mediaStorage';
import { rasterDimensions, validRasterDimensions } from '../lib/imageMetadata';
import { sniff } from './uploads';
import { deductOrderStock, planOrderReturn, stockReturnNote } from '../lib/orderInventory';
import { cancelledOrderRefundStatements } from '../lib/orderCancelOps';
import { deleteCancelledOrder, OrderDeletionRefusal } from '../lib/orderDeletion';
import { reclaimOrderRedemptionsStatement } from '../lib/offers';
import { resolveOrderExpiry } from '../lib/orderExpiry';
import { getSetting, getSettings, setSetting, SETTING_KEYS, type SettingKey } from '../lib/settings';
import { onOrderDelivered, grantPrinterGiftIfEligible } from '../lib/membershipOps';
import { createUnitsOnDelivery, type CreateUnitsResult } from '../lib/deviceOps';
import { awardOrderPoints } from '../lib/pointsOps';
import { getBalances, walletTxPublic } from '../lib/wallet';
// The member detail reports a BNPL debt, and the sign convention for that sum
// (charge positive, repayment negative, adjustment signed) lives in one place.
// Re-deriving it here would give the owner a second, quietly different number.
import { bnplOutstanding } from '../lib/bnpl';
import { productDocumentPublic } from './products';
import { parseProductRow } from '../lib/productModel';
import { applyRelations, loadRelationsViews, type ProductRelationsView } from '../lib/productOverlay';
import { applyPrinterWarrantyRules } from '../lib/warrantyPlans';
import { langOf, mysteryViewFor, orderPublic, shippingConfigFrom, ORDER_ITEMS_SELECT } from './orders';
import { baghdadDay, isDay } from '../lib/baghdadTime';
import { dayLabel } from '../lib/deliveryDay';
import { classifyOrderSearch } from '../lib/orderSearch';
import { arabicFoldSql, phoneDigitsSql } from '../lib/sqlFold';
import { getOrderPointsSnapshots } from '../lib/pointsOps';
import { telegramConfigured, telegramGetMe } from '../lib/telegram';
import {
  STAGE_SOURCE,
  canMoveStage,
  resolveDurations,
  stageForLegacyStatus,
  stageLabel,
  stagesFor,
  type OrderStage,
} from '../lib/orderStages';
import { moveOrderStage, stagePath, stageRowFrom, sweepDueStages } from '../lib/orderStageOps';
import { ALWASEET, alwaseetDriver, resolveWire } from '../lib/delivery/alwaseet';
import {
  escposReceipt,
  renderDeliveryLabel,
  renderLabelSheet,
  renderPurchaseReceipt,
  renderWarrantyReceipt,
} from '../lib/receipts';
import { SHIPPING_TYPE_LABELS } from '../lib/shippingType';
import { listStatusMap, setStatusMapping, upsertRemoteStatuses } from '../lib/delivery/statusMap';
import { syncOrderDelivery, sweepDeliveryStatuses } from '../lib/delivery/sync';
import type { DeliveryDriver } from '../lib/delivery/types';
import { typeForTransport } from '../lib/shippingType';
import type { ShippingType } from '../lib/shippingType';
import { notifyAdminTopic } from '../lib/telegramAdmin';
import { emailConfigured, sendEmailNow } from '../lib/emailSend';
import { sendWhatsAppText, wasenderConfigured, wasenderStatus } from '../lib/wasender';
import { clearSessionOutage, recordSessionOutage } from '../lib/channelReadiness';
import { normalizePhone, maskPhone } from '../lib/phone';
import { escapeHtml } from '../lib/emailTemplates';
import { notifyOrderDelivered, notifyOrderStatus } from '../lib/orderNotify';
import {
  deleteProductPermanently,
  invalidateMediaCache,
} from '../lib/productDeletion';
import { runGuardedMediaCleanupJobs } from '../lib/mediaRefs';

export const adminRoutes = new Hono<AppContext>();
adminRoutes.use('*', requireAdmin);

// ---------------------------------------------------------------- overview

/**
 * Provider health — what is configured, and what is silently not.
 *
 * WHY AN ADMIN NEEDS MORE THAN /api/auth/capabilities. That endpoint answers
 * "which buttons may the auth page show". This one answers "why is a feature
 * that looks on behaving as if it is off", and it reports the two states that
 * cause exactly that:
 *
 *   EMAIL_ALLOWED_RECIPIENTS — a STAGING guard. When it is non-empty every
 *   message to an address outside the list is dropped with a console warning
 *   and an unchanged HTTP response. On production that means password resets
 *   report themselves as sent and never arrive, with nothing in the UI to
 *   explain it. It is reported here as a WARNING, with the count of allowed
 *   addresses and none of the addresses.
 *
 *   A TELEGRAM TOKEN THAT IS SET BUT DOES NOT ANSWER — a revoked or mistyped
 *   token looks identical to a working one from the outside. `telegramGetMe`
 *   asks the bot, so "configured" here means it replied.
 *
 * NO SECRET, NO PREFIX, NO LENGTH. Every field is a boolean, a count, or a
 * public identifier.
 */
adminRoutes.get('/providers', async (c) => {
  const allowList = (c.env.EMAIL_ALLOWED_RECIPIENTS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const me = await telegramGetMe(c.env).catch(() => ({ ok: false, username: '' }));

  return c.json({
    success: true,
    google: {
      configured: !!(c.env.GOOGLE_CLIENT_ID || '').trim(),
      // Public by construction — Google puts it in the page and in every
      // token audience. It is here so an operator can confirm WHICH project
      // the deployment is pointed at without opening the dashboard.
      clientId: (c.env.GOOGLE_CLIENT_ID || '').trim(),
      note: 'Identity Services ID tokens, verified against Google JWKS. No client secret and no callback URL exist in this architecture.',
    },
    email: {
      configured: emailConfigured(c.env),
      hasKey: !!(c.env.EMAIL_API_KEY || '').trim(),
      hasFromAddress: !!(c.env.EMAIL_FROM || '').trim(),
      restrictedToAllowlist: allowList.length > 0,
      allowlistSize: allowList.length,
      warning:
        allowList.length > 0
          ? 'EMAIL_ALLOWED_RECIPIENTS is set: mail to any address outside that list is DROPPED. Password reset and verification will look sent and never arrive.'
          : null,
    },
    telegram: {
      configured: telegramConfigured(c.env),
      botAnswered: !!me.ok,
      botUsername: me.ok ? me.username : '',
      webhookSecretSet: !!c.env.TELEGRAM_WEBHOOK_SECRET,
    },
    whatsapp: {
      // WasenderAPI drives a REAL WhatsApp account, so a present key is not a
      // working channel: the shop's phone can log out while the token stays
      // valid. `configured` is the secret; `sessionStatus` is the truth, and
      // it costs a live request — which is why it is here, behind admin auth,
      // and not on the cached public /api/auth/capabilities.
      configured: wasenderConfigured(c.env),
      ...(await (async () => {
        if (!wasenderConfigured(c.env)) {
          return { sessionStatus: null, canSend: false, error: 'NOT_CONFIGURED' as const };
        }
        const st = await wasenderStatus(c.env).catch(() => null);
        /**
         * WHAT THIS PROBE LEARNS, THE SHOPPER'S PAGE ALSO GETS TO KNOW.
         *
         * `channelsLive()` reads the session state from a cache that, until
         * now, only a FAILED SEND ever wrote (worker/lib/channelReadiness.ts).
         * So a shop whose WhatsApp phone had logged out went on advertising
         * WhatsApp — on the sign-in screen, in the notification preferences,
         * in every "we will message you" sentence — until some customer
         * happened to be the one who found out. On 2026-09-21 that state had
         * been live and unrecorded: `whatsappOtp: true` with the session
         * reading `logged_out`.
         *
         * This is the one place in the system that asks the provider outright.
         * Recording the answer costs nothing (the debounce in
         * `writeSessionState` collapses repeats) and turns opening this panel —
         * or the read-only verification workflow — into the thing that stops
         * the shop promising a channel it cannot use.
         *
         * Contained: a bookkeeping write must never fail a diagnostics read.
         */
        const remember = async (connected: boolean, reason: string) => {
          try {
            if (connected) await clearSessionOutage(c.env);
            else await recordSessionOutage(c.env, reason);
          } catch {
            /* the panel still answers */
          }
        };
        if (!st) {
          await remember(false, 'PROVIDER_DOWN');
          return { sessionStatus: null, canSend: false, error: 'PROVIDER_DOWN' as const };
        }
        if (!st.ok) {
          await remember(false, st.error);
          return { sessionStatus: null, canSend: false, error: st.error, detail: st.detail ?? null };
        }
        await remember(st.can_send, st.can_send ? '' : st.status || 'SESSION_NOT_CONNECTED');
        return { sessionStatus: st.status, canSend: st.can_send, error: null };
      })()),
      note: 'Sign-in codes send directly; notifications go through the outbox because the provider allows as few as one message every five seconds.',
    },
    phone: {
      // A phone number signs you IN. Signing UP on one needs proof of
      // ownership, which is Telegram's job here — there is no SMS provider.
      signIn: true,
      smsProvider: false,
      // A code over WhatsApp, to the number migration 0013 already proved the
      // account owns. Not SMS: nothing here talks to a carrier.
      whatsappOtp: wasenderConfigured(c.env),
    },
    origin: {
      appOrigin: (c.env.APP_ORIGIN || '').trim(),
      storeRootDomain: (c.env.STORE_ROOT_DOMAIN || '').trim(),
    },
  });
});

adminRoutes.get('/overview', async (c) => {
  const db = c.env.DB;
  const [orders, users, wallet, pendingWallet, pendingCommunity, recentOrders] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status <> 'cancelled' THEN total_iqd ELSE 0 END) AS revenue_iqd
         FROM orders`
    ).first<Record<string, number>>(),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN membership_tier = 'pro' THEN 1 ELSE 0 END) AS pro,
              SUM(CASE WHEN membership_tier = 'prime' THEN 1 ELSE 0 END) AS prime,
              SUM(CASE WHEN membership_tier = 'plus' THEN 1 ELSE 0 END) AS plus,
              SUM(CASE WHEN is_investor = 1 THEN 1 ELSE 0 END) AS investors
         FROM users`
    ).first<Record<string, number>>(),
    db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN currency='USD' AND type='deposit' AND status='approved' THEN amount ELSE 0 END),0) AS incoming_usd_cents,
         COALESCE(SUM(CASE WHEN currency='USD' AND type='withdrawal' AND status='approved' THEN amount ELSE 0 END),0) AS outgoing_usd_cents
       FROM wallet_transactions`
    ).first<Record<string, number>>(),
    db.prepare(
      `SELECT wt.*, u.email, u.username,
              w.id AS withdrawal_id, w.state AS withdrawal_state,
              w.needs_reconciliation AS withdrawal_needs_reconciliation,
              w.payout_reference AS withdrawal_payout_reference
         FROM wallet_transactions wt
         LEFT JOIN users u ON u.id = wt.user_id
         LEFT JOIN wallet_withdrawals w ON w.tx_id = wt.id
        WHERE wt.status = 'pending' ORDER BY wt.created_at DESC LIMIT 10`
    ).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS n FROM community_requests WHERE status = 'open'").first<{ n: number }>(),
    db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 10').all<Record<string, unknown>>(),
  ]);

  // §11: revenue and wallet flow are financial data. An assistant admin sees
  // the operational counts and nothing about money.
  const money = canViewFinancials(c.env, c.get('user'));
  return c.json({
    success: true,
    can_view_financials: money,
    stats: {
      orders_total: orders?.total ?? 0,
      orders_pending: orders?.pending ?? 0,
      orders_delivered: orders?.delivered ?? 0,
      ...(money ? { revenue_iqd: orders?.revenue_iqd ?? 0 } : {}),
      users_total: users?.total ?? 0,
      pro_subscribers: users?.pro ?? 0,
      plus_subscribers: users?.plus ?? 0,
      investors: users?.investors ?? 0,
      ...(money
        ? {
            incoming_usd_cents: wallet?.incoming_usd_cents ?? 0,
            outgoing_usd_cents: wallet?.outgoing_usd_cents ?? 0,
          }
        : {}),
      pending_wallet_requests: pendingWallet.results.length,
      open_community_requests: pendingCommunity?.n ?? 0,
    },
    pending_wallet_requests: money
      ? pendingWallet.results.map((t) => ({ ...walletTxPublic(t), ...withdrawalRef(t), email: t.email, username: t.username }))
      : [],
    recent_orders: recentOrders.results.map((o) => ({
      id: o.id,
      status: o.status,
      ...(money ? { total_iqd: o.total_iqd } : {}),
      created_at: o.created_at,
      user_id: o.user_id,
    })),
  });
});

// ---------------------------------------------------------------- telegram

/**
 * Verifies the Telegram integration end-to-end and reports honestly.
 *
 * 0080 — THE GATE IS THE ROUTER, NOT THE LEGACY PAIR. Before the admin bot
 * existed, "configured" meant `TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_CHAT_ID`,
 * and the send was the customer bot posting into that one chat. Now the
 * destination comes from the ladder — the bound topic, then GENERAL, then that
 * legacy chat — so gating on the legacy pair would report the integration DEAD
 * the day the owner stops using the legacy chat, while it is in fact working
 * perfectly through @alilevobot.
 *
 * The response says WHICH rung carried it, because "it sent" and "it sent from
 * the fallback you thought you had retired" are different answers.
 */
adminRoutes.post('/telegram/test', async (c) => {
  const me = await telegramGetMe(c.env);
  const routed = await notifyAdminTopic(
    c.env,
    'general',
    '✅ Levonis: Telegram notifications are working (test message from the admin console).'
  );
  return c.json({
    success: true,
    // The CUSTOMER bot's own health — unchanged fields, unchanged meaning.
    tokenValid: me.ok,
    botUsername: me.username ?? null,
    chatConfigured: !!c.env.TELEGRAM_ADMIN_CHAT_ID,
    sent: routed.ok,
    // Which rung of the §9 ladder actually carried it, and which bot.
    delivered_via: routed.ok ? routed.destination.via : null,
    delivered_by: routed.ok ? routed.destination.bot : null,
    topic: routed.ok ? routed.destination.topicKey : null,
    reason: routed.ok ? null : routed.reason,
  });
});


// -------------------------------------------------- customer-channel tests

/**
 * SEND A REAL MESSAGE, AND SAY WHAT THE PROVIDER SAID.
 *
 * `/providers` reports whether the secrets are PRESENT. That is the question
 * nobody actually has: the owner wants to know whether an order confirmation
 * will arrive, and a key can be present and wrong, a Resend domain can be
 * unverified, a WhatsApp session can be logged out, and a staging allowlist
 * can be silently dropping every send. None of those show up as a missing
 * secret. Only a real send does.
 *
 * So this endpoint sends one, to a destination the ADMIN NAMES, and returns
 * the provider's own verdict instead of a green tick.
 *
 * WHY IT IS SAFE TO EXPOSE:
 *   * admin-only, and refused outright for a restricted (`assistant`) scope —
 *     a send costs money on email and costs WhatsApp quota, and on WhatsApp
 *     a burst is what gets a shop's number banned;
 *   * rate limited, per admin, hard;
 *   * the body is a fixed test message — nothing an admin types is
 *     transmitted, so this can never be turned into a relay for sending
 *     arbitrary text to arbitrary people;
 *   * every call is audited with a MASKED destination.
 *
 * The WhatsApp send goes DIRECT rather than through the outbox: a test whose
 * answer arrives fifteen minutes later in a cron is not a test.
 */
adminRoutes.post('/providers/test', async (c) => {
  const adminUser = c.get('user')!;
  if (normalizeAdminScope(adminUser.admin_scope) === 'assistant') {
    throw new HttpError(403, 'A restricted admin account cannot send provider tests', 'SCOPE_FORBIDDEN');
  }
  // Deliberately tight. Each call is a real message to a real person and, on
  // WhatsApp, a slot out of a quota that can be as small as one per five
  // seconds.
  await rateLimit(c, 'provider-test', 6, 900);

  const body = await c.req.json().catch(() => ({}));
  const channel = oneOf(body.channel, 'channel', ['email', 'whatsapp', 'telegram'] as const);
  const stamp = new Date().toISOString();
  const text =
    `LEVONIS\n` +
    `رسالة اختبار من لوحة التحكم — القناة تعمل.\n` +
    `Test message from the admin console — this channel is working.\n` +
    `${stamp}`;

  if (channel === 'telegram') {
    // Telegram's destination is not a free-text field: it is the admin group
    // the bot is already bound to. /telegram/test is the older, richer
    // version of this and stays; this branch exists so one endpoint answers
    // "does each channel work" in the same shape.
    const routed = await notifyAdminTopic(c.env, 'general', text);
    await audit(c.env.DB, adminUser.id, 'provider.test', 'channel:telegram', {
      ok: routed.ok,
      via: routed.ok ? routed.destination.via : null,
    });
    return c.json({
      success: true,
      channel,
      sent: routed.ok,
      detail: routed.ok ? `delivered via ${routed.destination.via}` : routed.reason,
    });
  }

  if (channel === 'email') {
    if (!emailConfigured(c.env)) {
      return c.json({ success: true, channel, sent: false, detail: 'EMAIL_NOT_CONFIGURED' });
    }
    const to = email(body.to);
    // A fresh key every time: the point of a test is that it actually leaves,
    // and Resend would deduplicate a repeat of the same Idempotency-Key.
    const sent = await sendEmailNow(
      c.env,
      to,
      'LEVONIS — email channel test',
      `<p style="font-family:Arial,sans-serif">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
      text
    );
    await audit(c.env.DB, adminUser.id, 'provider.test', 'channel:email', { ok: sent, to: maskEmailForAudit(to) });
    return c.json({
      success: true,
      channel,
      sent,
      // The one failure an operator will hit and not understand on their own.
      detail: sent
        ? 'accepted by Resend — acceptance is not delivery; check the inbox'
        : 'Resend refused it, or EMAIL_ALLOWED_RECIPIENTS excluded this address (see the Worker log)',
    });
  }

  if (!wasenderConfigured(c.env)) {
    return c.json({ success: true, channel, sent: false, detail: 'WHATSAPP_NOT_CONFIGURED' });
  }
  const raw = str(body.to, 'to', { min: 4, max: 32 });
  const phone = normalizePhone(raw);
  if (!phone) throw badRequest('This phone number is not valid', 'PHONE_INVALID');
  const res = await sendWhatsAppText(c.env, phone, text);
  await audit(c.env.DB, adminUser.id, 'provider.test', 'channel:whatsapp', {
    ok: res.ok,
    to: maskPhone(phone),
    error: res.ok ? null : res.error,
  });
  return c.json({
    success: true,
    channel,
    sent: res.ok,
    // `in_progress` is the provider's own word for accepted-not-delivered.
    detail: res.ok
      ? `accepted by WasenderAPI (status: ${res.status ?? 'unknown'}) — acceptance is not delivery`
      : `${res.error}${res.detail ? `: ${res.detail}` : ''}`,
    ...(res.ok ? {} : { retry_after_seconds: res.retry_after_seconds ?? null }),
  });
});

/** Masked for the audit row: staff read these, and an audit table should not
 *  double as an address book. */
function maskEmailForAudit(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  return `${address.slice(0, 1)}${'*'.repeat(Math.max(2, at - 1))}${address.slice(at)}`;
}

// ---------------------------------------------------------------- users

adminRoutes.get('/users', async (c) => {
  const q = c.req.query();
  const search = str(q.search, 'search', { max: 100, required: false });
  const limit = int(q.limit, 'limit', { min: 1, max: 100, def: 50 });
  const offset = int(q.offset, 'offset', { min: 0, max: 100_000, def: 0 });
  let sql = `SELECT id, email, username, name, role, is_investor, membership_tier,
                    admin_scope, subscription_plan, subscription_expiry, created_at
               FROM users`;
  const params: unknown[] = [];
  if (search) {
    sql += ` WHERE ${sqlLikeClause(['email', 'username', 'name'])}`;
    const like = likePattern(search);
    params.push(like, like, like);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return c.json({ success: true, users: results, total: total?.n ?? 0 });
});

/**
 * ONE ACCOUNT, NAMED BEFORE IT IS CHANGED — the lookup behind the «مساعد» grant.
 *
 * `GET /users?search=` already exists, and it is the wrong tool for this job
 * twice over.
 *
 *   IT RETURNS A LIST. «أريد وضع مساعد للأدمن عن طريق الايميل» is an act
 *   against exactly ONE account. An admin who types an address, is handed four
 *   near-matches and grants the console to the wrong row has put an outsider
 *   inside the admin panel, and nothing downstream catches that — the grant is
 *   valid, it is simply on the wrong person.
 *
 *   ITS PATTERN IS TRUNCATED. `likePattern` caps at 50 BYTES because that is
 *   D1's hard limit on a LIKE/GLOB pattern. A long address is silently cut and
 *   then matches a PREFIX, which is precisely the near-miss above.
 *
 * So this is an EQUALITY match on the stored address, which is also the only
 * comparison that can use the UNIQUE index on the column. `users.email` is
 * stored lowercased (migrations/0001_init.sql:15) and `email()` lowercases
 * what was typed, so the two meet without wrapping the column in a function.
 *
 * IT ANSWERS WITH IDENTITY ONLY: who this is, what they already are, and
 * whether they are the owner. No money and no counts — this is the
 * confirmation step of a grant, not a member profile, and the smaller the
 * answer the less an assistant can learn by guessing addresses.
 */
adminRoutes.get('/users/lookup', async (c) => {
  const target = await c.env.DB
    .prepare(
      `SELECT id, email, username, name, role, admin_scope, membership_tier, created_at
         FROM users WHERE email = ?`
    )
    .bind(email(c.req.query('email')))
    .first<{
      id: string;
      email: string;
      username: string | null;
      name: string;
      role: string;
      admin_scope: string | null;
      membership_tier: string | null;
      created_at: string;
    }>();
  if (!target) throw notFound('No account with that email address');
  return c.json({
    success: true,
    user: {
      id: target.id,
      email: target.email,
      username: target.username,
      name: target.name,
      role: target.role,
      // NORMALISED, NOT RAW. `normalizeAdminScope` is what every authorization
      // decision reads (an unrecognised value resolves to the LEAST privilege),
      // so the screen that is about to change this value must be looking at the
      // same interpretation — otherwise the panel could show "full" for a row
      // the server already treats as restricted.
      admin_scope: normalizeAdminScope(target.admin_scope),
      membership_tier: target.membership_tier ?? 'free',
      created_at: target.created_at,
      // The owner can never be demoted or restricted (adminScope.ts). Saying so
      // HERE means the screen can explain why the control is unavailable rather
      // than letting the admin press it and collect a 403.
      is_owner: isOwner(c.env, target),
      is_self: target.id === c.get('user')!.id,
    },
  });
});

/**
 * THE MEMBER DETAIL — «عند الضغط على مستخدم أريدها نافذة منبثقة ... وأريد
 * ترتيب أكثر وإضافة تفاصيل أكثر».
 *
 * The users table carries six columns; an owner deciding anything about a
 * person needs more than that, and until now the only way to get it was to
 * leave the page. This gathers what the panel already stores about one account
 * into a single answer, organised by the question it answers rather than by the
 * table it came from.
 *
 * ---------------------------------------------------------------------------
 * THE FINANCIAL GATE IS THE POINT OF THIS HANDLER, not a detail of it.
 *
 * Mandate §11: «cost وجميع تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد
 * الأدمن العادي لا يراها في API ولا في HTML ولا في export».
 *
 * LIFETIME VALUE IS MONEY. So is a wallet balance, so is a BNPL credit limit
 * and so is an outstanding debt. An assistant must not receive any of them —
 * and "must not receive" means they are ABSENT FROM THE RESPONSE, not hidden by
 * the client. The strongest possible form of that is what is implemented here:
 * the financial statements are NEVER EXECUTED for a restricted admin. There is
 * no object to forget to strip, because the numbers were never read out of D1.
 *
 * They are also grouped under ONE key, `financial`. A flat payload invites the
 * next person to add `lifetime_value_iqd` beside `orders_total` and ship a leak;
 * a payload where every money figure lives in one object that is either present
 * or absent makes the mistake visible at the point it is made.
 *
 * WHAT STAYS OPERATIONAL. An order COUNT, a KYC state, a restriction, a
 * notification channel and a BNPL account STATE are operations — the work an
 * assistant exists to do. Counting orders is not reading profit. The credit
 * LIMIT attached to that BNPL state is money and is therefore on the other side
 * of the fence, which is why the two are split rather than returned together.
 *
 * ---------------------------------------------------------------------------
 * NO DAY BOUNDARY IS COMPUTED HERE, deliberately. Every timestamp below is
 * returned as the stored ISO instant and formatted by the client. The moment
 * this handler buckets anything by DAY it must go through
 * worker/lib/baghdadTime.ts, because `date('now')` is UTC and Baghdad is UTC+3
 * — for three hours every night SQLite's idea of "today" is yesterday's.
 *
 * Every optional feature's read is wrapped in `degradeIfSchemaMissing`: a
 * deployment whose D1 has not taken 0092 yet must still be able to open a
 * member, not 500 on a table that this screen merely decorates.
 */
adminRoutes.get('/users/:id/detail', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const financial = canViewFinancials(c.env, admin);

  const row = await c.env.DB
    .prepare(
      `SELECT id, email, username, name, role, is_investor, membership_tier, admin_scope,
              subscription_plan, subscription_expiry, subscription_days, locale, country,
              phone_e164, email_verified_at, onboarding_state, checkin_streak,
              created_at, updated_at
         FROM users WHERE id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('User not found');

  /**
   * `Promise.all` OF INDEPENDENT READS, NOT `DB.batch`.
   *
   * `batch` exists to make several WRITES atomic — it opens a transaction, and
   * these are five aggregates over five unrelated tables with nothing to make
   * atomic. Using it here would buy a transaction nobody needs and would cost
   * the ability to test this handler at all: the repository's SQLite adapter
   * (tests/fixtures/d1.ts) implements `batch` through `run()`, which returns no
   * rows for a SELECT, so a read batch is invisible to every route test in this
   * project. A read that cannot be tested is a read that will silently rot.
   *
   * Five bound parameters in total, nowhere near D1's refusal at 100 — the
   * limit that forces the 90-row chunks in worker/lib/stockAlerts.ts is about
   * batching many ROWS, and this is a fixed set of aggregates.
   */
  const [orders, session, kyc, restrictions, address] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS orders_total,
              COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS orders_delivered,
              COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS orders_cancelled,
              COALESCE(SUM(CASE WHEN status IN ('pending','confirmed','processing','shipped') THEN 1 ELSE 0 END), 0) AS orders_open,
              MAX(created_at) AS last_order_at
         FROM orders WHERE user_id = ?`
    ).bind(id).first<Record<string, unknown>>(),
    // LAST SIGN-IN IS A FLOOR, NOT A FACT, and the field name says so. Sessions
    // are deleted when they expire or when the person signs out, so the newest
    // surviving row is the newest sign-in WE STILL HOLD. Reporting it as
    // "last seen" would quietly turn a swept table into "never signed in".
    c.env.DB.prepare(
      `SELECT MAX(created_at) AS newest_session_at,
              COALESCE(SUM(CASE WHEN expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END), 0) AS live_sessions
         FROM sessions WHERE user_id = ?`
    ).bind(id).first<Record<string, unknown>>(),
    // STATES ONLY. The encrypted identity evidence opens exclusively from the
    // dedicated KYC review surface; a member card is not a place to decrypt an
    // identity document into.
    c.env.DB.prepare(
      `SELECT state, reason, submitted_at, decided_at, created_at
         FROM kyc_cases WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT id, kind, case_type, state, reason, benefit_flags, opened_at, resolved_at
         FROM restriction_cases WHERE user_id = ?
        ORDER BY (state = 'active') DESC, opened_at DESC LIMIT 20`
    ).bind(id).all<Record<string, unknown>>(),
    // `requested_at`/`approved_at`, not `created_at` — approved_addresses is
    // VERSIONED and immutable (a change request creates a new row), so the two
    // dates are the two halves of the staff act: when the member asked and when
    // staff signed it off. They are aliased so the client reads one shape.
    c.env.DB.prepare(
      `SELECT version, state, requested_at, approved_at FROM approved_addresses
        WHERE user_id = ? ORDER BY version DESC LIMIT 1`
    ).bind(id).first<Record<string, unknown>>(),
  ]);

  const channels = await degradeIfSchemaMissing(
    'user notification channels (0092)',
    async () =>
      (
        await c.env.DB
          .prepare(
            `SELECT channel, enabled, is_primary, updated_at
               FROM user_notification_channels WHERE user_id = ? ORDER BY channel`
          )
          .bind(id)
          .all<{ channel: string; enabled: number; is_primary: number; updated_at: string }>()
      ).results ?? [],
    [] as Array<{ channel: string; enabled: number; is_primary: number; updated_at: string }>
  );

  const bnpl = await degradeIfSchemaMissing(
    'bnpl account (0002)',
    () =>
      c.env.DB
        .prepare('SELECT state, credit_limit_iqd, created_at FROM bnpl_accounts WHERE user_id = ?')
        .bind(id)
        .first<{ state: string; credit_limit_iqd: number; created_at: string }>(),
    null
  );

  const restrictionRows = (restrictions.results ?? []) as Array<Record<string, unknown>>;
  const kycRow = kyc;
  const orderRow = orders ?? {};
  const sessionRow = session ?? {};
  const addressRow = address;

  const member = {
    identity: {
      id: row.id,
      email: row.email,
      username: row.username,
      name: row.name,
      role: row.role,
      admin_scope: normalizeAdminScope(row.admin_scope),
      is_owner: isOwner(c.env, row as { email: string }),
      is_self: row.id === admin.id,
      // The stored number, unmasked: this is the admin panel's own member
      // record and support has to be able to CALL the person. The customer's
      // own /api/auth/me masks it; that is a different audience.
      phone_e164: row.phone_e164 ?? null,
      country: row.country ?? null,
      locale: row.locale,
      email_verified_at: row.email_verified_at ?? null,
      onboarding_state: row.onboarding_state ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    membership: {
      tier: row.membership_tier ?? 'free',
      legacy_plan: row.subscription_plan,
      expiry: Number(row.subscription_expiry) || 0,
      term_days: Number(row.subscription_days) || 0,
      is_investor: Boolean(row.is_investor),
      checkin_streak: Number(row.checkin_streak) || 0,
    },
    activity: {
      orders_total: Number(orderRow.orders_total) || 0,
      orders_delivered: Number(orderRow.orders_delivered) || 0,
      orders_cancelled: Number(orderRow.orders_cancelled) || 0,
      orders_open: Number(orderRow.orders_open) || 0,
      last_order_at: (orderRow.last_order_at as string | null) ?? null,
      newest_session_at: (sessionRow.newest_session_at as string | null) ?? null,
      live_sessions: Number(sessionRow.live_sessions) || 0,
    },
    kyc: kycRow
      ? {
          state: kycRow.state,
          reason: kycRow.reason,
          submitted_at: kycRow.submitted_at ?? null,
          decided_at: kycRow.decided_at ?? null,
        }
      : null,
    restrictions: restrictionRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      case_type: r.case_type ?? '',
      state: r.state,
      reason: r.reason,
      benefit_flags: safeParse<string[]>(r.benefit_flags, []),
      opened_at: r.opened_at,
      resolved_at: r.resolved_at ?? null,
    })),
    active_restrictions: restrictionRows.filter((r) => r.state === 'active').length,
    channels: channels.map((ch) => ({
      channel: ch.channel,
      enabled: Boolean(ch.enabled),
      is_primary: Boolean(ch.is_primary),
      updated_at: ch.updated_at,
    })),
    approved_address: addressRow
      ? {
          version: Number(addressRow.version) || 0,
          state: addressRow.state,
          requested_at: (addressRow.requested_at as string | null) ?? null,
          approved_at: (addressRow.approved_at as string | null) ?? null,
        }
      : null,
    // The STATE is operational — support has to know whether BNPL is live for
    // this member. The credit LIMIT that goes with it is money and is on the
    // other side of the gate below.
    bnpl_state: bnpl?.state ?? 'none',
  };

  if (!financial) {
    // §11 in its strongest form: nothing financial was ever read, so there is
    // nothing here to strip, to forget to strip, or to find in the raw JSON.
    return c.json({ success: true, can_view_financials: false, member });
  }

  const [value, wallet, outstanding] = await Promise.all([
    c.env.DB
      .prepare(
        // A CANCELLED ORDER IS NOT LIFETIME VALUE. Including it would inflate
        // every member's worth by everything they ever changed their mind
        // about, and the owner would be reading a number that no money ever
        // matched. `delivered_iqd` is the conservative floor beside it: money
        // that actually completed its journey.
        `SELECT COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_iqd ELSE 0 END), 0) AS lifetime_iqd,
                COALESCE(SUM(CASE WHEN status = 'delivered' THEN total_iqd ELSE 0 END), 0) AS delivered_iqd
           FROM orders WHERE user_id = ?`
      )
      .bind(id)
      .first<{ lifetime_iqd: number; delivered_iqd: number }>(),
    getBalances(c.env.DB, id),
    degradeIfSchemaMissing('bnpl ledger (0002)', () => bnplOutstanding(c.env.DB, id), 0),
  ]);

  return c.json({
    success: true,
    can_view_financials: true,
    member,
    financial: {
      lifetime_value_iqd: Number(value?.lifetime_iqd) || 0,
      delivered_value_iqd: Number(value?.delivered_iqd) || 0,
      wallet_usd_cents: wallet.usd_cents,
      wallet_points: wallet.points,
      bnpl_credit_limit_iqd: Number(bnpl?.credit_limit_iqd) || 0,
      bnpl_outstanding_iqd: outstanding,
    },
  });
});

adminRoutes.patch('/users/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const target = await c.env.DB
    .prepare('SELECT id, role, email, is_investor FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; role: string; email: string; is_investor: number }>();
  if (!target) throw notFound('User not found');

  // Validate first, decide second, write third. Every value below is checked
  // before the single authorization decision so the refusal reflects what was
  // actually asked for, not what the parser made of it.
  const role = body.role === undefined ? undefined : oneOf(body.role, 'role', ['customer', 'merchant', 'admin'] as const);
  const isInvestor = body.is_investor === undefined ? undefined : Boolean(body.is_investor);
  const scope = body.admin_scope === undefined ? undefined : normalizeAdminScope(body.admin_scope);

  // Who may change whom — worker/lib/adminScope.ts. Promoting to, or demoting
  // from, administrator is granting or revoking financial access (a fresh
  // admin has admin_scope NULL = full), so it follows the same rule as
  // admin_scope itself; the owner can never be demoted; nobody demotes
  // themselves; and a value equal to the stored one is not an attempt, because
  // the panel echoes the whole row on every save.
  const refusal = userPatchRefusal(c.env, admin, target, { role, is_investor: isInvestor, admin_scope: scope });
  if (refusal) throw forbidden(refusal);

  const updates: string[] = [];
  const params: unknown[] = [];
  if (role !== undefined) {
    updates.push('role = ?');
    params.push(role);
  }
  // Admins set the tier through membership_tier; subscription_plan is kept in
  // sync for its legal domain only (a PRIME member is 'free' there — see
  // migration 0018). getTierStatus overwrites both from the memberships
  // ledger on the member's next request, so this is an override, not a
  // substitute for issuing a membership.
  if (body.membership_tier !== undefined || body.subscription_plan !== undefined) {
    const tier = oneOf(
      body.membership_tier ?? body.subscription_plan,
      'membership_tier',
      ['free', 'plus', 'pro', 'prime'] as const
    );
    updates.push('membership_tier = ?');
    params.push(tier);
    updates.push('subscription_plan = ?');
    params.push(tier === 'prime' ? 'free' : tier);
  }
  if (scope !== undefined) {
    updates.push('admin_scope = ?');
    params.push(scope);
  }
  if (isInvestor !== undefined) {
    updates.push('is_investor = ?');
    params.push(isInvestor ? 1 : 0);
  }
  if (updates.length === 0) throw badRequest('Nothing to update');
  params.push(id);
  await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .bind(...params)
    .run();
  /**
   * THE AUDIT RECORDS WHAT CHANGED, NOT WHAT WAS SENT.
   *
   * This logged the raw request body, which is whatever the caller chose to
   * put in it: fields this route ignores, fields a future client adds, and —
   * the reason it matters — anything an attacker appends to a request they are
   * otherwise allowed to make. An audit trail that stores unvalidated input is
   * a place to hide things in, and it is read by the people investigating
   * exactly that.
   *
   * The columns this handler actually wrote are already assembled above, so
   * the record is built from THOSE.
   */
  await audit(c.env.DB, admin.id, 'admin.user_update', id, {
    // The COLUMN NAMES this statement actually set, paired with the values the
    // handler validated. `tier` is block-scoped to its own branch, so the
    // membership change is read back out of the bound parameters rather than
    // reaching for a variable that may not exist.
    fields: updates.map((u) => u.split(' ')[0]),
    role: role ?? undefined,
    // `?? undefined` HERE WAS A HOLE IN THE ONE AUDIT THAT MATTERS MOST.
    // Revoking a restriction means writing admin_scope = NULL, which IS the
    // act of handing an account full financial access — and `scope ?? undefined`
    // turned that null into undefined, which JSON.stringify drops. The record
    // then said the column changed and refused to say to what, so the grant and
    // the revoke were indistinguishable in the trail an investigator reads.
    // Only ABSENT (the field was never sent) may become undefined; a deliberate
    // null is a value and is recorded as one.
    admin_scope: scope === undefined ? undefined : scope,
    is_investor: isInvestor ?? undefined,
  });
  return c.json({ success: true });
});

// ---------------------------------------------------------------- products

const SELLING_TYPES = ['direct_sale', 'pre_order', 'bundle'] as const;
const PRODUCT_STATUS = ['draft', 'active', 'hidden'] as const;
const LEGACY_ADMIN_PRODUCT_BATCH = 80;

/**
 * The legacy admin route still returns the old wire shape, but its catalogue
 * document must be assembled from the same relational authority as every
 * current product reader. Chunking stays below D1's historical 100-bind
 * ceiling and avoids a relation query per product.
 */
async function legacyAdminProductProjection(
  db: D1Database,
  rows: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const views = new Map<string, ProductRelationsView>();
  for (let offset = 0; offset < rows.length; offset += LEGACY_ADMIN_PRODUCT_BATCH) {
    const chunk = rows.slice(offset, offset + LEGACY_ADMIN_PRODUCT_BATCH);
    const loaded = await loadRelationsViews(
      db,
      chunk.map((row) => ({ id: String(row.id), inventory_mode: row.inventory_mode }))
    );
    for (const [id, view] of loaded) views.set(id, view);
  }

  return rows.map((row) => {
    const stored = parseProductRow(row);
    const view = views.get(stored.id);
    // `products.images` is only a rollout mirror. Start empty so zero rows, a
    // quarantined-only gallery, or a soft relation-read failure cannot revive
    // it; active relation rows below are the only way media enters the wire.
    const authorityBase = { ...stored, media: [] };
    const doc = view
      ? applyRelations(authorityBase, view, { includeInactive: true, authoredNames: true })
      : authorityBase;
    return productDocumentPublic(doc, { includeInternal: true });
  });
}

/**
 * THIS ENDPOINT PREDATES THE RELATIONAL PRODUCT WRITER.
 *
 * It is deliberately still available for old, scalar-only integrations, but
 * it must never accept a product shape that can contain a media reference.
 * Such a shape would bypass the R2 existence/byte/WebP verifier, the
 * content-addressed metadata normaliser, and the per-object cleanup guard.
 * Unknown relation envelopes are included because silently ignoring them is
 * no safer: a caller can receive 200 while believing its images were saved.
 */
const LEGACY_PRODUCT_STRUCTURE_FIELDS = [
  'images',
  'media',
  'product_images',
  'options',
  'option_groups',
  'option_values',
  'groups',
  'colors',
  'variants',
  'relations',
  'description_images',
  'description_videos',
  'content_blocks',
  'usage_guide',
  'how_to_use',
  'specifications',
  'stores',
] as const;

function validateProductBody(body: Record<string, unknown>) {
  const name = str(body.name, 'name', { min: 1, max: 200 });
  const slugRaw = str(body.slug, 'slug', { max: 200, required: false });
  const slug = (slugRaw || name).toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  if (!slug) throw badRequest('slug could not be derived — give the product a latin name or explicit slug');
  const priceFields = (v: unknown, nameOf: string) =>
    v === undefined || v === null || v === '' ? null : int(v, nameOf, { min: 0, max: 2_000_000_000 });
  return {
    name,
    slug,
    status: body.status === undefined ? 'active' : oneOf(body.status, 'status', PRODUCT_STATUS),
    name_ar: str(body.name_ar, 'name_ar', { max: 200, required: false }),
    name_ku: str(body.name_ku, 'name_ku', { max: 200, required: false }),
    description: str(body.description, 'description', { max: 20_000, required: false }),
    description_ar: str(body.description_ar, 'description_ar', { max: 20_000, required: false }),
    description_ku: str(body.description_ku, 'description_ku', { max: 20_000, required: false }),
    selling_type: body.selling_type === undefined ? 'direct_sale' : oneOf(body.selling_type, 'selling_type', SELLING_TYPES),
    shipping_methods: jsonArray(body.shipping_methods, 'shipping_methods', 20),
    price_iqd: int(body.price_iqd, 'price_iqd', { min: 0, max: 2_000_000_000 }),
    original_price_iqd: priceFields(body.original_price_iqd, 'original_price_iqd'),
    product_cost_iqd: priceFields(body.product_cost_iqd, 'product_cost_iqd'),
    membership_prices: JSON.stringify(
      typeof body.membership_prices === 'object' && body.membership_prices !== null ? body.membership_prices : {}
    ),
    payment_options: jsonArray(body.payment_options, 'payment_options', 20),
    subcategory_id: str(body.subcategory_id, 'subcategory_id', { max: 60, required: false }),
    categories: str(body.categories, 'categories', { max: 500, required: false }),
    display_order: int(body.display_order, 'display_order', { min: -100_000, max: 100_000, def: 0 }),
    is_featured: body.is_featured ? 1 : 0,
    brand: str(body.brand, 'brand', { max: 100, required: false }),
    labels: jsonArray(body.labels, 'labels', 30),
    hashtags: jsonArray(body.hashtags, 'hashtags', 30),
    algorithm_tags: jsonArray(body.algorithm_tags, 'algorithm_tags', 30),
    features: jsonArray(body.features, 'features', 50),
    warranty_plans: jsonArray(body.warranty_plans, 'warranty_plans', 10),
    stock: body.stock === undefined || body.stock === null || body.stock === '' ? null : int(body.stock, 'stock', { min: 0, max: 1_000_000 }),
  };
}

adminRoutes.get('/products', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all<Record<string, unknown>>();
  return c.json({ success: true, products: await legacyAdminProductProjection(c.env.DB, results) });
});

adminRoutes.post('/products', async (c) => {
  const adminUser = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const structuralFields = LEGACY_PRODUCT_STRUCTURE_FIELDS.filter((field) => body[field] !== undefined);
  if (structuralFields.length) {
    throw new HttpError(
      409,
      'This legacy endpoint cannot save product structure or media. Use /api/admin/products-v2 so every image is verified and stored atomically.',
      'LEGACY_PRODUCT_STRUCTURE_UNSUPPORTED',
      { fields: structuralFields, route: '/api/admin/products-v2' }
    );
  }

  // validateProductBody intentionally has no structural fields. A scalar-only
  // UPDATE therefore retains every stored mirror exactly as it is.
  const p = validateProductBody(body);
  const id = typeof body.id === 'string' && body.id ? str(body.id, 'id', { max: 60 }) : newId('prd');

  // EXTENDED WARRANTY IS FOR PRINTERS (owner mandate) — on THIS legacy route
  // too, with the same guard and the same 400 codes as adminProducts.ts
  // (WARRANTY_NOT_PRINTER / WARRANTY_PLAN_INVALID). Printer-ness is the
  // stored catalog placement (this route names no catalogs), so a product
  // that is not filed under a printer catalog cannot be given plans here,
  // and a printer's plans must be the +12 / +24 extensions. The document is
  // built over the stored row so the stored ops_policy (serialized, base)
  // is what the rules judge.
  const stored = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  await applyPrinterWarrantyRules(
    c.env.DB,
    parseProductRow({ ...(stored ?? {}), ...p, id, slug: p.slug }),
    undefined
  );

  const cols = Object.keys(p);
  const sql = `INSERT INTO products (id, ${cols.join(', ')})
               VALUES (?, ${cols.map(() => '?').join(', ')})
               ON CONFLICT(id) DO UPDATE SET ${cols.map((k) => `${k} = excluded.${k}`).join(', ')},
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  try {
    await c.env.DB.prepare(sql).bind(id, ...Object.values(p)).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('slug')) throw badRequest('A product with this slug already exists');
    throw e;
  }
  await audit(c.env.DB, adminUser.id, 'product.save', id, { name: p.name, price_iqd: p.price_iqd, status: p.status });
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  const [product] = await legacyAdminProductProjection(c.env.DB, [row!]);
  return c.json({ success: true, product });
});

adminRoutes.delete('/products/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const result = await deleteProductPermanently(c.env.DB, id, { newId: () => newId('mcj') });
  if (result.already_deleted) throw notFound('Product not found');
  if (result.blocked) {
    throw new HttpError(409, result.blocked.remedy, result.blocked.code, {
      table: result.blocked.table,
      count: result.blocked.count,
    });
  }

  // D1 has committed at this point. R2 failure is recorded on the durable job
  // and reported as pending; it must never turn a completed product deletion
  // into an error that tempts the admin to repeat it.
  let cleanup: Awaited<ReturnType<typeof runGuardedMediaCleanupJobs>>;
  try {
    cleanup = await runGuardedMediaCleanupJobs(c.env, result.media_jobs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('legacy product media cleanup failed after committed delete:', message);
    cleanup = {
      deleted: [],
      shared: [],
      failed: result.media_jobs.map((job) => ({ key: job.key, error: message.slice(0, 400) })),
      report: {
        ran: false,
        refusals: [message],
        attempted: result.media_jobs.length,
        deleted: [],
        still_referenced: [],
        dead_lettered: [],
        retrying: [],
        verified_at: [],
        bookkeeping_failures: [],
      },
    };
  }
  const invalidated = await invalidateMediaCache(new URL(c.req.url).origin, cleanup.deleted);
  const shared = [...new Set([...result.r2_objects_shared_skipped, ...cleanup.shared])];
  await audit(c.env.DB, adminUser.id, 'product.delete', id, {
    rows_deleted_by_table: result.rows_deleted_by_table,
    rows_unlinked_by_table: result.rows_unlinked_by_table,
    r2_objects_deleted: cleanup.deleted.length,
    r2_objects_shared_skipped: shared.length,
    r2_cleanup_pending: cleanup.failed.length,
  });
  return c.json({
    success: true,
    product_deleted: result.product_deleted,
    rows_deleted_by_table: result.rows_deleted_by_table,
    rows_unlinked_by_table: result.rows_unlinked_by_table,
    r2_objects_deleted: cleanup.deleted,
    r2_objects_shared_skipped: shared,
    r2_cleanup_pending: cleanup.failed.length,
    ...(cleanup.failed.length ? { r2_cleanup_errors: cleanup.failed } : {}),
    cache_keys_invalidated: invalidated,
  });
});

// ---------------------------------------------------------------- wallet review

/** The workflow row behind a ledger withdrawal, for the panel — or null for a
 *  deposit / a pre-0015 withdrawal, which the legacy decision still handles. */
function withdrawalRef(t: Record<string, unknown>) {
  if (!t.withdrawal_id) return { withdrawal: null };
  return {
    withdrawal: {
      id: String(t.withdrawal_id),
      state: String(t.withdrawal_state),
      needs_reconciliation: Number(t.withdrawal_needs_reconciliation) === 1,
      payout_reference: t.withdrawal_payout_reference ? String(t.withdrawal_payout_reference) : null,
    },
  };
}

adminRoutes.get('/wallet-requests', async (c) => {
  const status = str(c.req.query('status'), 'status', { max: 20, required: false });
  // A withdrawal filed since the holds engine (migration 0015) has a
  // wallet_withdrawals row: its state machine, not the ledger row's status,
  // is what an admin acts on. The join lets the panel show that state and
  // drive the workflow routes; the legacy decide below refuses such rows.
  let sql = `SELECT wt.*, u.email, u.username,
                    w.id AS withdrawal_id, w.state AS withdrawal_state,
                    w.needs_reconciliation AS withdrawal_needs_reconciliation,
                    w.payout_reference AS withdrawal_payout_reference
               FROM wallet_transactions wt
               LEFT JOIN users u ON u.id = wt.user_id
               LEFT JOIN wallet_withdrawals w ON w.tx_id = wt.id
              WHERE wt.currency = 'USD'`;
  const params: unknown[] = [];
  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    sql += ' AND wt.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY wt.created_at DESC LIMIT 300';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  return c.json({
    success: true,
    requests: results.map((t) => ({ ...walletTxPublic(t), ...withdrawalRef(t), email: t.email, username: t.username, userId: t.user_id })),
  });
});

adminRoutes.post('/wallet-requests/:id/decide', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const decision = oneOf(body.status, 'status', ['approved', 'rejected'] as const);
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });

  const tx = await c.env.DB.prepare("SELECT * FROM wallet_transactions WHERE id = ? AND status = 'pending'")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!tx) throw notFound('Pending request not found (it may already be decided)');

  // A hold-backed withdrawal is decided by its own state machine
  // (/api/wallet/admin/withdrawals/:id/…), which commits or releases the hold
  // in the same transaction as the ledger row. Deciding it HERE would flip the
  // ledger and leave the hold active for ever — the customer's money reserved
  // for a payout that already happened, or never will. Refused, not silently
  // redirected: the panel must call the right thing.
  if (tx.type === 'withdrawal') {
    const wd = await c.env.DB.prepare('SELECT id, state FROM wallet_withdrawals WHERE tx_id = ?')
      .bind(id)
      .first<{ id: string; state: string }>();
    if (wd) {
      throw new HttpError(
        409,
        `This withdrawal is handled by the withdrawal workflow (currently ${wd.state}) — approve it for processing, mark it paid with the payout reference, or reject it there.`,
        'USE_WITHDRAWAL_WORKFLOW',
        { withdrawal_id: wd.id, state: wd.state }
      );
    }
  }

  // A DEPOSIT is decided by the one deposit service (§12.2) — the same
  // function the guarded /api/wallet/admin/deposits/:id routes and the
  // Telegram buttons call — so this legacy button carries the same refusals
  // (an amount finance observed as different from what was declared is never
  // approved) and the same side effects (a rejection frees the transfer
  // reference; the group message is closed). Before this it flipped the row
  // with a bare UPDATE and bypassed all three. Only the response shape is the
  // legacy one, for the panel.
  if (tx.type === 'deposit' && tx.currency === 'USD') {
    const res = await decideDeposit(c.env, {
      requestId: id,
      action: decision === 'approved' ? 'approve' : 'reject',
      actorUserId: adminUser.id,
      reason: adminNote,
      source: 'site',
    });
    if (!res.ok) {
      if (res.reason === 'AMOUNT_MISMATCH') {
        throw conflict(
          'The observed amount does not match the requested amount — reject this request and file a linked adjustment for the amount that actually arrived',
          'AMOUNT_MISMATCH'
        );
      }
      if (res.reason === 'REASON_REQUIRED') {
        throw badRequest('A rejection reason is required (at least 3 characters)', 'REASON_REQUIRED');
      }
      throw badRequest('This request was already decided');
    }
    backgroundWork(
      c,
      Promise.allSettled([closeDepositNotification(c.env, id), enqueueUserDepositStatusNotification(c.env, id)])
    );
    await audit(c.env.DB, adminUser.id, `wallet.${decision}`, id, {
      user_id: tx.user_id, type: tx.type, amount: tx.amount, currency: tx.currency, via: 'deposit_service',
    });
    return c.json({ success: true });
  }

  if (decision === 'approved' && tx.type === 'withdrawal') {
    // Approving a withdrawal must not overdraw: conditional update guarded by
    // the SPENDABLE balance — settled minus the user's other active holds —
    // with this request's own hold counted as covering it (walletOps).
    const res = await c.env.DB.prepare(
      `UPDATE wallet_transactions
          SET status = 'approved', admin_note = ?1, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = ?2
        WHERE id = ?3 AND status = 'pending'
          AND ${approvableWithdrawalSql('?4', '?3')} >= amount`
    )
      .bind(adminNote, adminUser.id, id, tx.user_id)
      .run();
    if (res.meta.changes === 0) {
      throw badRequest("The user's balance no longer covers this withdrawal", 'INSUFFICIENT_BALANCE');
    }
  } else {
    const res = await c.env.DB.prepare(
      `UPDATE wallet_transactions
          SET status = ?, admin_note = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = ?
        WHERE id = ? AND status = 'pending'`
    )
      .bind(decision, adminNote, adminUser.id, id)
      .run();
    if (res.meta.changes === 0) throw badRequest('This request was already decided');
  }
  await audit(c.env.DB, adminUser.id, `wallet.${decision}`, id, {
    user_id: tx.user_id, type: tx.type, amount: tx.amount, currency: tx.currency,
  });
  return c.json({ success: true });
});

/**
 * Run a background promise without letting its absence break the request:
 * `c.executionCtx` throws when there is no ExecutionContext (unit tests, some
 * local runners), and an after-the-fact notice must never turn a completed
 * decision into a reported failure.
 */
function backgroundWork(c: Context<AppContext>, work: Promise<unknown>): void {
  const swallow = () => work.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(swallow());
  } catch {
    void swallow();
  }
}

/**
 * A manual wallet credit MINTS money. Three guards that the first version of
 * this route did not have:
 *  - financial scope (§11): an `assistant` admin may run the catalogue but may
 *    never move money — the same 403 the farm's money sections answer;
 *  - a per-admin rate limit, so a stolen session or a stuck button cannot
 *    fire hundreds of credits in a minute;
 *  - a required idempotency key, with the ledger id DERIVED from
 *    (admin, key): a double submit — the browser retrying, the admin clicking
 *    twice — finds its own row and credits nothing. The same key with a
 *    different payload is refused, never silently reused.
 */
adminRoutes.post('/wallet/credit', async (c) => {
  const adminUser = c.get('user')!;
  if (!canViewFinancials(c.env, adminUser)) {
    throw new HttpError(
      403,
      'هذا الإجراء للمالك أو الدور المالي فقط / This action needs the owner or a financial admin',
      'FINANCIAL_SCOPE_REQUIRED'
    );
  }
  await rateLimit(c, 'admin-credit', 20, 3600);
  const body = await c.req.json().catch(() => ({}));
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  const userId = str(body.userId, 'userId', { min: 1, max: 60 });
  const currency = oneOf(body.currency, 'currency', ['USD', 'POINT'] as const);
  const amount = int(body.amount, 'amount', { min: 1, max: 100_000_000 });
  const note = str(body.note, 'note', { min: 3, max: 300 });
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw notFound('User not found');

  const id = `wtx_credit_${(await sha256Hex(`${adminUser.id}:${idempotencyKey}`)).slice(0, 32)}`;
  const res = await c.env.DB.prepare(
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
     SELECT ?1, ?2, 'deposit', ?3, ?4, 'approved', ?5, ?6, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1)`
  )
    .bind(id, userId, currency, amount, note, `admin:${adminUser.id}`)
    .run();
  if (res.meta.changes === 0) {
    const existing = await c.env.DB.prepare('SELECT user_id, currency, amount FROM wallet_transactions WHERE id = ?')
      .bind(id)
      .first<{ user_id: string; currency: string; amount: number }>();
    if (!existing || existing.user_id !== userId || existing.currency !== currency || existing.amount !== amount) {
      throw conflict('This idempotency key was already used for a different credit', 'IDEMPOTENCY_KEY_REUSED');
    }
    return c.json({ success: true, id, replayed: true });
  }
  await audit(c.env.DB, adminUser.id, 'wallet.manual_credit', id, {
    userId, currency, amount, note, idempotency_key: idempotencyKey,
  });
  return c.json({ success: true, id, replayed: false });
});

// ---------------------------------------------------------------- orders

/**
 * ===========================================================================
 *  THE ORDER BOARD — «ترتيب إدارة الطلبات في اللوحة الإدارة بشكل أفضل»
 * ===========================================================================
 * Four orthogonal parameters and one search box, over one page of rows and one
 * COUNT that also carries the group headers.
 *
 * `scope` IS THE BOARD, `due`/`type`/`status` NARROW IT. They are orthogonal on
 * purpose: `due=today` means the same thing inside every scope, so a screen can
 * put them on separate rows of controls and never have to explain which
 * combinations exist.
 *
 *   scope=open       the work: everything not delivered and not cancelled,
 *                    DIRECT orders only — pre-orders are their own scope.
 *   scope=preorder   «فصلها في الطلبات المسبقة» — owner decision (أ) point 2. A
 *                    container in transit is a different kind of waiting from a
 *                    box that has to go out this morning, and interleaving them
 *                    by day puts a shipment forty days out in among today's.
 *   scope=delivered  «الطلبات التي تم توصيلها يتم عزلها»
 *   scope=cancelled  «الطلبات الملغية … يتم عزلها»
 */
const BOARD_SCOPES = ['open', 'preorder', 'delivered', 'cancelled'] as const;
const BOARD_DUE = ['today', 'tomorrow', 'week', 'later', 'unscheduled'] as const;
const BOARD_TYPES = ['direct', 'preorder_air', 'preorder_sea', 'preorder_land'] as const;

/**
 * THE CUSTOMER'S NAME AND DELIVERY PHONE ARE NOT COLUMNS. They live at `$.name`
 * and `$.phone` inside `orders.address_snapshot`, a frozen JSON copy of the
 * whole `addresses` row.
 *
 * THE GUARD IS THE POINT. `json_extract` over a row whose text is not JSON
 * THROWS and kills the statement — and this statement's twin, the COUNT, runs
 * beside it in one `Promise.all`, so one malformed snapshot is a blank admin
 * screen rather than one odd row. `CASE WHEN json_valid(...)` yields NULL for
 * such a row instead, which simply fails to match.
 *
 * AND NOT A `LIKE` OVER THE RAW TEXT, which is the shortcut this replaces: the
 * blob also holds `user_id`, `created_at` and free-text address lines, so
 * searching it whole matches digits inside an id and street names against a
 * person's name.
 */
const SNAPSHOT_NAME_SQL = `CASE WHEN json_valid(o.address_snapshot) THEN json_extract(o.address_snapshot,'$.name') END`;
const SNAPSHOT_PHONE_SQL = `CASE WHEN json_valid(o.address_snapshot) THEN json_extract(o.address_snapshot,'$.phone') END`;

/** Which group header a row belongs under. Computed on the SERVER — see below. */
export type OrderDueBucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'unscheduled';

/**
 * A row's bucket, from its day and the server's three Baghdad anchors.
 *
 * ############################################################################
 * #  WHY THIS IS NOT COMPUTED IN THE BROWSER                                 #
 * ############################################################################
 * The browser's clock is the admin's laptop. Between 00:00 and 03:00 Baghdad a
 * UTC-derived "today" is still YESTERDAY, so an order due today would be
 * bucketed `overdue` — or, on a laptop set east of Baghdad, tomorrow's work
 * would show as today's. That window is exactly the early-morning shift when
 * the day's delivery runs are planned, which is to say the one time of day
 * this screen is load-bearing. The server has one clock and one rule
 * (`baghdadDay`), so it answers once and the screen renders what it was given.
 */
function dueBucketOf(day: unknown, today: string, tomorrow: string, weekEnd: string): OrderDueBucket {
  const d = typeof day === 'string' ? day : '';
  if (!isDay(d)) return 'unscheduled';
  // Fixed-width civil days compare lexicographically in date order, so none of
  // this constructs a Date or picks a timezone.
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  if (d === tomorrow) return 'tomorrow';
  return d <= weekEnd ? 'week' : 'later';
}

adminRoutes.get('/orders', async (c) => {
  const scopeRaw = c.req.query('scope');
  const dueRaw = str(c.req.query('due'), 'due', { max: 12, required: false });
  const typeRaw = str(c.req.query('type'), 'type', { max: 20, required: false });
  const status = str(c.req.query('status'), 'status', { max: 20, required: false });
  const q = str(c.req.query('q'), 'q', { max: 80, required: false });
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 30 });
  const offset = int(c.req.query('offset'), 'offset', { min: 0, max: 100_000, def: 0 });

  let scope = oneOf(scopeRaw || 'open', 'scope', BOARD_SCOPES);
  const due = dueRaw ? oneOf(dueRaw, 'due', BOARD_DUE) : '';
  const type = typeRaw ? oneOf(typeRaw, 'type', BOARD_TYPES) : '';

  // COMPATIBILITY, AND IT IS NOT COSMETIC. `status` predates `scope` and the
  // existing screen's dropdown still sends `status=delivered`. Under the new
  // default that would read "open orders which are delivered" — an empty
  // screen, with a 200 and no error, for a filter that worked yesterday. An
  // explicit status of `delivered` or `cancelled` with NO scope therefore
  // CHOOSES that scope. Passing `scope` explicitly always wins.
  if (!scopeRaw && (status === 'delivered' || status === 'cancelled')) scope = status;

  // The server's own Baghdad day, and never `date('now')` — SQLite's is UTC and
  // is therefore a day behind for the first three hours of every Iraqi day.
  // All three are BOUND AS PARAMETERS below, so the comparison in SQL is a
  // plain string compare against fixed-width civil days.
  const nowMs = Date.now();
  const today = baghdadDay(nowMs);
  const tomorrow = baghdadDay(nowMs, 1);
  const weekEnd = baghdadDay(nowMs, 7);

  const search = classifyOrderSearch(q, nowMs);

  /**
   * AN EXPLICIT LOOKUP PIERCES THE BOARD; A BROWSE DOES NOT.
   *
   * Typing an order number or a phone number is not filtering, it is looking
   * ONE order up — and most of why an admin searches at all is to answer a
   * question about an order that is already finished: "was this delivered?",
   * "did we cancel this?". Honouring the default hiding of delivered and
   * cancelled orders there produces the worst possible answer: an empty result
   * for an order that plainly exists.
   *
   * A NAME or DATE search is browsing — "the Ahmeds in today's work" — so it
   * respects the scope and every narrowing parameter beside it. The screen is
   * told which happened (`search_kind`, `search.pierced`) so it can say so.
   */
  const pierces = search.kind === 'order_id' || search.kind === 'phone';

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!pierces) {
    if (scope === 'open' || scope === 'preorder') {
      // ######################################################################
      // #  THIS STRING IS VERBATIM FROM idx_orders_board_open. DO NOT REWRITE #
      // ######################################################################
      // A partial index is usable only when the query's WHERE is SYNTACTICALLY
      // implied by the index's — SQLite matches the text, it does not reason
      // about sets. Rewriting this as the equivalent positive
      // `status IN ('pending','confirmed',…)` costs the board this index, and
      // the failure is SILENT: the planner falls back to
      // idx_orders_cancelled_retention, EXPLAIN still reads "USING INDEX", and
      // the ORDER BY quietly becomes a temp B-tree over every open order, re-
      // sorted on every page. Nothing breaks until the table is large, and
      // then the screen takes nine seconds. See migrations/0094.
      clauses.push("o.status NOT IN ('delivered','cancelled')");
      // Pre-orders are a SCOPE, not a bucket — decision (أ) point 2.
      //
      // ######################################################################
      // #  THE LEADING `+` IS LOAD-BEARING. IT IS NOT A TYPO.                 #
      // ######################################################################
      // `+expr` is SQLite's documented way to say "do not use an index for
      // this term". It changes no value and no row — `+shipping_type` is the
      // same string — and without it the planner prefers
      // `idx_orders_shipping_type` for the equality and ABANDONS the board's
      // partial index, which is the exact silent regression migration 0094
      // warns about: EXPLAIN still reads "USING INDEX" and looks healthy,
      // while the scan widens from "open orders" to "every direct order ever
      // placed" — a set that grows for ever as orders are delivered.
      // Measured on this schema, and asserted in tests/adminOrderBoard.test.ts:
      //
      //   +shipping_type = 'direct'   SCAN o USING INDEX idx_orders_board_open
      //    shipping_type = 'direct'   SEARCH o USING INDEX idx_orders_shipping_type
      //
      // The `<>` form does not need it — an inequality is not indexable here
      // anyway — but both carry it so the two branches cannot drift.
      clauses.push(scope === 'open' ? "+o.shipping_type = 'direct'" : "+o.shipping_type <> 'direct'");
    } else {
      clauses.push('o.status = ?');
      params.push(scope);
    }

    if (status) {
      clauses.push('o.status = ?');
      params.push(status);
    }
    if (type) {
      clauses.push('o.shipping_type = ?');
      params.push(type);
    }
    if (due) {
      // `due=today` INCLUDES OVERDUE, and that is a decision rather than an
      // oversight. A box that should have gone out on Tuesday is not a
      // separate kind of work on Wednesday — it is today's work, and it is the
      // most urgent of it. The counts still report `overdue` on its own so the
      // header can say how much of today is late.
      if (due === 'today') {
        clauses.push('o.delivery_due_day IS NOT NULL AND o.delivery_due_day <= ?');
        params.push(today);
      } else if (due === 'tomorrow') {
        clauses.push('o.delivery_due_day = ?');
        params.push(tomorrow);
      } else if (due === 'week') {
        clauses.push('o.delivery_due_day > ? AND o.delivery_due_day <= ?');
        params.push(tomorrow, weekEnd);
      } else if (due === 'later') {
        clauses.push('o.delivery_due_day > ?');
        params.push(weekEnd);
      } else {
        clauses.push('o.delivery_due_day IS NULL');
      }
    }
  }

  if (search.kind === 'order_id') {
    // A PREFIX match on the primary key, with no COLLATE NOCASE: ids are
    // `ORD-` + uppercase hex, the classifier has already upper-cased what was
    // typed, and a NOCASE comparison would throw away the primary-key index
    // and scan the table for a lookup that should be one seek.
    const pattern = likePattern(search.id_prefix, 'prefix');
    if (pattern) {
      clauses.push(sqlLikeClause(['o.id']));
      params.push(pattern);
    }
  } else if (search.kind === 'phone') {
    // SEARCH, NOT IDENTITY. `phone.ts`'s rule — comparison is always full
    // E.164, no suffix matching anywhere — still governs everything that
    // decides WHO someone is. This clause decides which ORDER is on the
    // screen. The suffix exists because `address_snapshot` is frozen history:
    // orders placed before the address validator normalised phones carry
    // `+964-0770 123 4567`, and the national number is what both that and
    // `+9647701234567` end with.
    const ors: string[] = [];
    if (search.phone.e164) {
      ors.push('u.phone_e164 = ?');
      params.push(search.phone.e164);
    }
    const suffix = likePattern(search.phone.national, 'suffix');
    if (suffix) {
      ors.push(sqlLikeClause([`COALESCE(u.phone_e164,'')`, phoneDigitsSql(`COALESCE(${SNAPSHOT_PHONE_SQL},'')`)]));
      params.push(suffix, suffix);
    }
    // '0' rather than nothing: a phone search that produced no usable key must
    // return NO rows, not the whole table.
    clauses.push(ors.length > 0 ? `(${ors.join(' OR ')})` : '0');
  } else if (search.kind === 'date') {
    // A HALF-OPEN UTC RANGE, never `substr(created_at,1,10)`. An order placed
    // at 01:00 Baghdad carries a `created_at` dated the PREVIOUS day in UTC, so
    // slicing the string files three hours of every day under yesterday.
    clauses.push('o.created_at >= ? AND o.created_at < ?');
    params.push(search.date.from, search.date.to);
  } else if (search.kind === 'name') {
    // BOTH NAMES: the account's `u.name` and the delivery name frozen in the
    // snapshot, which is often a different person — a gift, or an office.
    //
    // `json_valid` IS NOT OPTIONAL. An unguarded `json_extract` over a row
    // whose text is not JSON THROWS, and this statement and the COUNT run in
    // one Promise.all, so one malformed snapshot takes the whole screen down.
    // Every other reader of this column parses it in TypeScript with
    // `safeParse`; putting it in a WHERE is new exposure, and this is its
    // guard.
    const pattern = likePattern(search.folded);
    if (pattern) {
      clauses.push(
        `(${sqlLikeClause([
          arabicFoldSql(`COALESCE(u.name,'')`),
          arabicFoldSql(`COALESCE(${SNAPSHOT_NAME_SQL},'')`),
        ])})`
      );
      params.push(pattern, pattern);
    }
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.map((x) => `(${x})`).join(' AND ')}` : '';

  /**
   * ONE `FROM`, SHARED BY BOTH STATEMENTS, AND THAT IS THE POINT.
   *
   * The COUNT used to be `FROM orders o` with no join while the rows query
   * joined `users`. The moment any predicate names `u.name` — which a name
   * search does — the COUNT fails with `no such column: u.name`, and because
   * the two run in one `Promise.all` the rejection takes the whole screen
   * down. It fails only when somebody actually types a name, which is why it
   * would have shipped. Binding both statements to this one constant is what
   * makes the two WHERE clauses structurally incapable of disagreeing.
   */
  const FROM = 'FROM orders o LEFT JOIN users u ON u.id = o.user_id';

  const [{ results }, countRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT o.*, u.email, u.username, u.name AS user_name, u.phone_e164 AS user_phone
         ${FROM}${where}
        ORDER BY o.delivery_due_day IS NULL,
                 o.delivery_due_day ASC,
                 o.priority DESC,
                 (o.priority_due_at IS NULL), o.priority_due_at ASC,
                 o.created_at ASC,
                 o.id ASC
        LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all<Record<string, unknown>>(),
    // THE GROUP HEADERS RIDE IN THE COUNT THAT ALREADY RUNS. Six SUM(CASE)
    // columns over the same WHERE cost one scan the board was paying for
    // anyway; six separate COUNT queries would be six more round trips to D1
    // for numbers nobody can act on individually.
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN o.delivery_due_day IS NOT NULL AND o.delivery_due_day < ? THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN o.delivery_due_day = ? THEN 1 ELSE 0 END) AS due_today,
              SUM(CASE WHEN o.delivery_due_day = ? THEN 1 ELSE 0 END) AS due_tomorrow,
              SUM(CASE WHEN o.delivery_due_day > ? AND o.delivery_due_day <= ? THEN 1 ELSE 0 END) AS due_week,
              SUM(CASE WHEN o.delivery_due_day > ? THEN 1 ELSE 0 END) AS due_later,
              SUM(CASE WHEN o.delivery_due_day IS NULL THEN 1 ELSE 0 END) AS unscheduled
         ${FROM}${where}`
    )
      .bind(today, today, tomorrow, tomorrow, weekEnd, weekEnd, ...params)
      .first<Record<string, number>>(),
  ]);

  // TWO QUERIES, NOT 201. This used to fetch 200 orders and then run a
  // separate `SELECT * FROM order_items WHERE order_id = ?` for EACH one —
  // 201 round trips to D1 for one screen, which is why the orders tab took
  // seconds to appear. The items now come back in a single IN query over the
  // page's ids, and the page is 30 rows rather than 200.
  const ids = results.map((o) => String(o.id));
  const byOrder = new Map<string, Record<string, unknown>[]>(ids.map((id) => [id, []]));
  if (ids.length > 0) {
    // The same item projection the customer routes use, so the admin sees
    // the same is_printer flag (and product slug) the customer payload carries.
    const { results: items } = await c.env.DB.prepare(
      `${ORDER_ITEMS_SELECT} WHERE oi.order_id IN (${ids.map(() => '?').join(',')}) ORDER BY oi.rowid`
    )
      .bind(...ids)
      .all<Record<string, unknown>>();
    for (const it of items) byOrder.get(String(it.order_id))?.push(it);
  }

  // ADMINS SEE THE PICK THROUGHOUT (§8.2). It is operational access — the
  // list is the screen staff scan before opening one — and the projection
  // marks each one `pending_customer_reveal` until the customer's milestone.
  const adminMystery = await mysteryViewFor(c.env.DB, ids, 'admin');
  const lang = langOf(c);
  const out = results.map((o) => {
    const day = typeof o.delivery_due_day === 'string' ? o.delivery_due_day : '';
    return {
      ...orderPublic(o, byOrder.get(String(o.id)) ?? [], undefined, adminMystery),
      email: o.email,
      username: o.username,
      user_id: o.user_id,
      /**
       * WHAT PACKING A BOX NEEDS. The delivery name and the governorate are
       * already on `address` — `orderPublic` returns the parsed snapshot — so
       * the row carries the person the parcel is FOR. `customer_name` is the
       * account holder beside it, because the two differ often enough (a gift,
       * an office address) that showing only one sends parcels to the wrong
       * name. The email stays only because the existing screen reads it; it is
       * the least useful thing to put in front of someone packing a box, and
       * nothing new should be built on it.
       */
      customer_name: o.user_name ?? '',
      customer_phone: o.user_phone ?? null,
      /** Merchant orders share this table and are BADGED, never counted as ours. */
      seller_type: o.seller_type ?? 'levonis',
      priority: Number(o.priority) || 0,
      delivery_waived: Number(o.delivery_waived) || 0,
      membership_tier_snapshot: o.membership_tier_snapshot ?? 'free',
      delivered_at: o.delivered_at ?? null,
      /** «يستطيع اختيار وتغيير يوم التوصيل» — the day itself, and when it moved. */
      delivery_due_day: day || null,
      delivery_day_changed_at: o.delivery_day_changed_at ?? null,
      due_bucket: dueBucketOf(day, today, tomorrow, weekEnd),
      due_label: day ? dayLabel(day, today, lang).label : '',
    };
  });

  const total = Number(countRow?.n ?? out.length);
  return c.json({
    success: true,
    orders: out,
    total,
    limit,
    offset,
    scope,
    due: due || null,
    type: type || null,
    status: status || null,
    /** The three anchors the buckets were computed against, so the screen can
     *  label a header without deriving a day from the browser's clock. */
    today,
    tomorrow,
    week_end: weekEnd,
    /**
     * WHICH READING WON, so the board can say «بحث برقم الهاتف» with a one-tap
     * «ابحث كاسم» beside it. A classifier that guesses wrong is cheap to
     * correct and expensive to hide.
     */
    search_kind: search.kind,
    search:
      search.kind === 'none'
        ? null
        : {
            raw: search.raw,
            /** True when this lookup ignored the scope and every filter. */
            pierced: pierces,
            ...(search.kind === 'date' ? { date: search.date } : {}),
          },
    counts: {
      total,
      overdue: Number(countRow?.overdue ?? 0),
      today: Number(countRow?.due_today ?? 0),
      tomorrow: Number(countRow?.due_tomorrow ?? 0),
      week: Number(countRow?.due_week ?? 0),
      later: Number(countRow?.due_later ?? 0),
      unscheduled: Number(countRow?.unscheduled ?? 0),
    },
  });
});

/**
 * An explicit database cleanup action, available only after cancellation.
 * Normal cancellation continues to keep the order for 30 days; this button is
 * the owner's deliberate override. Fulfilled/serialized orders are refused so
 * a cleanup click cannot erase a device identity or its warranty history.
 */
adminRoutes.delete('/orders/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  try {
    const result = await deleteCancelledOrder(c.env.DB, id);
    if (result.deleted) {
      await audit(c.env.DB, admin.id, 'order.delete_permanent', id, {
        rows_deleted_by_table: result.rows_deleted_by_table,
        rows_unlinked_by_table: result.rows_unlinked_by_table,
      });
    }
    return c.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof OrderDeletionRefusal) {
      const ar =
        error.code === 'ORDER_NOT_CANCELLED'
          ? 'يجب إلغاء الطلب أولاً قبل حذفه نهائياً.'
          : 'لا يمكن حذف هذا الطلب لأنه يحتوي على سجل تسليم أو جهاز أو ضمان.';
      throw new HttpError(409, ar, error.code);
    }
    throw error;
  }
});

/**
 * Everything needed to PREPARE one order, in a single call.
 *
 * The list endpoint above returns 200 orders with their items and was never
 * meant to carry the fulfilment detail: the address parts a courier asks for,
 * who the customer is, and the money breakdown behind the total. This is the
 * order screen's own payload.
 *
 * §11 still applies — nothing here is cost or margin. The admin sees what the
 * CUSTOMER was charged and how it was paid, which is what packing a box and
 * writing a receipt needs.
 */
adminRoutes.get('/orders/:id', async (c) => {
  const id = c.req.param('id');
  const o = await c.env.DB.prepare(
    `SELECT o.*, u.email, u.username, u.name AS user_name, u.phone_e164, u.membership_tier,
            u.created_at AS user_since
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!o) throw notFound('Order not found');

  // ENRICHMENTS DEGRADE, THEY DO NOT FAIL THE SCREEN. The units, the invoice
  // and the order's chat thread all live in tables added by later migrations
  // (0003, 0026). Code always reaches a deployment a moment before its
  // migration does, and on 2026-08-30 that window turned the whole fulfilment
  // modal into "خطأ في الخادم" because one lookup for `chats.order_id` threw.
  // The order, its address and its money are the screen; everything else is
  // extra, and extra that is missing is worth an empty list, not a 500.
  const soft = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      console.error(`order detail enrichment unavailable (${label}): ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  const [{ results: items }, snaps, units, invoice, chat, stageHistory] = await Promise.all([
    c.env.DB.prepare(`${ORDER_ITEMS_SELECT} WHERE oi.order_id = ? ORDER BY oi.rowid`).bind(id).all<Record<string, unknown>>(),
    soft('points', () => getOrderPointsSnapshots(c.env, [id]), new Map()),
    // Serialized units matter on the fulfilment screen: a printer that needs a
    // serial written on the warranty slip is a different packing job from a
    // spool of filament.
    soft(
      'units',
      async () =>
        (
          await c.env.DB.prepare(
            `SELECT iu.*, ds.serial_raw
               FROM order_item_units iu
               LEFT JOIN device_serials ds ON ds.unit_id = iu.id
              WHERE iu.order_id = ? ORDER BY iu.order_item_id, iu.unit_index`
          ).bind(id).all<Record<string, unknown>>()
        ).results,
      [] as Record<string, unknown>[]
    ),
    soft(
      'invoice',
      () =>
        c.env.DB.prepare(
          'SELECT id, invoice_no, revision, payment_status FROM invoices WHERE order_id = ? ORDER BY revision DESC LIMIT 1'
        ).bind(id).first<Record<string, unknown>>(),
      null as Record<string, unknown> | null
    ),
    soft(
      'chat',
      () => c.env.DB.prepare('SELECT id FROM chats WHERE order_id = ?').bind(id).first<{ id: string }>(),
      null as { id: string } | null
    ),
    soft(
      'stage_history',
      async () =>
        (
          await c.env.DB.prepare(
            'SELECT stage, status, source, changed_at, changed_by, note FROM order_status_history WHERE order_id = ? ORDER BY changed_at'
          ).bind(id).all<{ stage: string; changed_at: string }>()
        ).results ?? [],
      [] as { stage: string; changed_at: string }[]
    ),
  ]);

  // The address as STORED ON THE ORDER, not the customer's current address —
  // an order is packed for where it was sent, and a later edit must not
  // silently repoint a parcel that is already being prepared.
  const address = safeParse<Record<string, unknown>>(o.address_snapshot, {});

  return c.json({
    success: true,
    order: {
      ...orderPublic(o, items, snaps.get(id), await mysteryViewFor(c.env.DB, [id], 'admin')),
      admin_note: o.admin_note ?? '',
      customer: {
        id: o.user_id,
        name: o.user_name ?? null,
        username: o.username ?? null,
        email: o.email ?? null,
        // The account's own verified phone, which may differ from the one on
        // the address — both are shown, neither is guessed from the other.
        account_phone: o.phone_e164 ?? null,
        membership_tier: o.membership_tier ?? 'free',
        member_since: o.user_since ?? null,
      },
      address,
      units: units.map((u) => ({
        id: u.id,
        order_item_id: u.order_item_id,
        unit_index: u.unit_index,
        serial: u.serial_raw ?? null,
        warranty_base_months: u.warranty_base_months ?? null,
        warranty_ext_months: u.warranty_ext_months ?? 0,
        warranty_start_at: u.warranty_start_at ?? null,
        warranty_end_at: u.warranty_end_at ?? null,
      })),
      invoice: invoice ?? null,
      chat_id: chat?.id ?? null,
      // The tracking path, so the fulfilment modal shows where the parcel is
      // and offers only the moves that are actually legal from here. The
      // panel holds no copy of the path — one authority, on the server.
      tracking: (() => {
        const shippingType = asShippingType(o.shipping_type);
        const stage = String(o.stage || 'received') as OrderStage;
        const path = stagesFor(shippingType);
        return {
          shipping_type: shippingType,
          stage,
          stage_source: o.stage_source ?? 'automatic',
          stage_changed_at: o.stage_changed_at || o.updated_at || o.created_at,
          next_stage: o.next_stage || null,
          next_stage_at: o.next_stage_at ?? null,
          delivery: {
            provider: o.delivery_provider || '',
            remote_id: o.delivery_remote_id || '',
            tracking_no: o.delivery_tracking_no || '',
            status_text: o.delivery_status_text || '',
            synced_at: o.delivery_synced_at ?? null,
            error: o.delivery_error || '',
          },
          steps: stagePath(shippingType, stage, stageHistory).map((v) => ({
            ...v,
            label_ar: stageLabel(v.stage, shippingType, 'ar'),
            label_en: stageLabel(v.stage, shippingType, 'en'),
          })),
          available: [...path, 'cancelled' as OrderStage]
            .filter((to) => canMoveStage(stage, to, shippingType))
            .map((to) => ({
              stage: to,
              source: STAGE_SOURCE[to],
              label_ar: stageLabel(to, shippingType, 'ar'),
              label_en: stageLabel(to, shippingType, 'en'),
            })),
          history: stageHistory,
        };
      })(),
    },
  });
});

/**
 * Where an order may go from where it is.
 *
 * THIS USED TO BE A ONE-WAY RATCHET: pending offered two options, shipped
 * offered one, and delivered and cancelled offered none. A human running a
 * real shop mis-taps — an order marked shipped that has not shipped, or
 * cancelled by mistake — and had no way back at all. Two choices on a screen
 * whose whole job is moving orders is not a state machine, it is a trap.
 *
 * So corrections are allowed among the pre-delivery states in BOTH directions,
 * and forward steps may skip (an order confirmed and shipped the same hour
 * does not need a click on `processing` to be honest). What is NOT allowed:
 *
 *   * delivered -> anything but `shipped`. Delivery grants points, starts
 *     warranty clocks and creates device units. Backing out to `shipped` is
 *     offered as the one correction path for a mis-tap, and the route says
 *     plainly what that does NOT undo.
 *   * a no-op transition to the state the order is already in.
 *
 * Every side effect behind these is idempotent through the inventory and
 * points ledgers, so a correction that goes forward again moves nothing twice.
 */
/**
 * Everything that has to happen the first time an order reaches `delivered`.
 *
 * Extracted because there are now TWO ways an order gets there — an admin
 * moving the legacy status, and an admin (or the courier's API) moving the
 * tracking stage — and the day those two granted different things would be
 * the day a customer's warranty depended on which button was pressed.
 *
 * Every step is individually idempotent (UNIQUE(order_item_id, unit_index),
 * UNIQUE(order_id) on points and on the gift), so reaching delivered twice
 * grants nothing twice.
 */
/** Narrows a stored shipping_type, falling back the way the cart does. */
function asShippingType(v: unknown): ShippingType {
  return v === 'preorder_air' || v === 'preorder_sea' || v === 'preorder_land' || v === 'direct'
    ? v
    : typeForTransport(v);
}

async function deliveredEffects(
  c: Context<AppContext>,
  id: string
): Promise<{ deviceUnits: CreateUnitsResult | null; deviceUnitsWarning: string | null }> {
  let deviceUnits: CreateUnitsResult | null = null;
  let deviceUnitsWarning: string | null = null;

  // Mandate §4: create one device record per PHYSICAL unit of every
  // serialized product, clocked to the delivered_at just stamped. Awaited
  // (warranty clocks are account state, not a fire-and-forget message) and
  // idempotent via UNIQUE(order_item_id, unit_index) — a replayed
  // transition can never duplicate units or restart coverage.
  const deliveredRow = await c.env.DB.prepare('SELECT delivered_at FROM orders WHERE id = ?')
    .bind(id)
    .first<{ delivered_at: string | null }>();
  try {
    deviceUnits = await createUnitsOnDelivery(c.env, id, deliveredRow?.delivered_at ?? new Date().toISOString());
  } catch (e) {
    console.error('device unit creation failed for order', id, e);
    // Honest partial outcome: the order IS delivered, units are missing.
    deviceUnitsWarning =
      'Device units were not created — retry from Admin → Serials & Devices (backfill), otherwise warranty clocks for this order are missing.';
  }

  // Purchase points (decision row 20 defaults): floor(qualifying merchandise
  // / 1000) at the delivered event. Awaited — points are account state —
  // and idempotent via points_awards UNIQUE(order_id), so a replayed
  // delivered transition can never double-award.
  try {
    await awardOrderPoints(c.env, id);
  } catch (e) {
    console.error('points award failed for order', id, e);
  }

  // Referral 9.1 milestone: records delivered_at-based eligibility (idempotent).
  c.executionCtx.waitUntil(onOrderDelivered(c.env, id));
  // PLUS gift on printer purchase, when the owner set the milestone to
  // delivery (grant itself is idempotent per order).
  const printerGift = await getSetting(c.env.DB, 'printerGiftConfig');
  if (printerGift?.enabled === true && printerGift.milestone === 'delivered') {
    c.executionCtx.waitUntil(grantPrinterGiftIfEligible(c.env, id));
  }
  /*
   * THE MESSAGE LEAVES FROM THE SAME PLACE THE GRANTS DO. `deliveredEffects`
   * is where both delivered doors converge, and its own docstring says that is
   * why it exists — «the day those two granted different things would be the
   * day a customer's warranty depended on which button was pressed». The same
   * argument applies to telling them at all.
   *
   * `waitUntil`, because an admin pressing a button must not wait on three
   * providers. The event key is the status, so the stage door's own call for
   * this order costs one no-op enqueue, never a second message.
   */
  c.executionCtx.waitUntil(notifyOrderDelivered(c.env, id));

  return { deviceUnits, deviceUnitsWarning };
}

const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
  confirmed: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
  processing: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
  shipped: ['pending', 'confirmed', 'processing', 'delivered', 'cancelled'],
  // Reversible only one step, and only to correct a mis-tap.
  delivered: ['shipped'],
  // A cancelled order can be re-opened; re-confirming re-deducts the stock.
  cancelled: ['pending', 'confirmed', 'processing'],
};

/** The states in which the stock has been taken out of inventory. */
const STOCK_DEDUCTED_STATES = new Set(['confirmed', 'processing', 'shipped', 'delivered']);

/**
 * The tracking stages an order can be in, and the moves available from where
 * it stands. Feeds the admin panel so the panel does not have to hold its own
 * copy of the path — the one place the rules live is the server.
 */
adminRoutes.get('/orders/:id/stages', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('Order not found');
  const order = stageRowFrom(row);
  const { results: history } = await c.env.DB.prepare(
    'SELECT stage, status, source, changed_at, changed_by, note FROM order_status_history WHERE order_id = ? ORDER BY changed_at'
  )
    .bind(id)
    .all<{ stage: string; changed_at: string }>();

  const path = stagesFor(order.shipping_type);
  return c.json({
    success: true,
    shipping_type: order.shipping_type,
    stage: order.stage,
    stage_source: order.stage_source,
    stage_changed_at: order.stage_changed_at,
    next_stage: order.next_stage || null,
    next_stage_at: order.next_stage_at,
    path: stagePath(order.shipping_type, order.stage, history ?? []).map((v) => ({
      ...v,
      label_ar: stageLabel(v.stage, order.shipping_type, 'ar'),
      label_en: stageLabel(v.stage, order.shipping_type, 'en'),
    })),
    // What the admin may actually pick. Computed here so a panel can render
    // the real options instead of the whole path greyed out — the six-option
    // bug the owner already reported once was a panel guessing this.
    available: [...path, 'cancelled' as OrderStage]
      .filter((to) => canMoveStage(order.stage, to, order.shipping_type))
      .map((to) => ({
        stage: to,
        source: STAGE_SOURCE[to],
        label_ar: stageLabel(to, order.shipping_type, 'ar'),
        label_en: stageLabel(to, order.shipping_type, 'en'),
      })),
    history: history ?? [],
  });
});

/**
 * An admin moving an order along its path. The stage is the authority for
 * what the customer is told; the legacy status is kept in step underneath by
 * moveOrderStage, so the stock lifecycle and every existing filter still work.
 */
/**
 * Runs the stage sweep now, instead of waiting for the next cron tick.
 *
 * The cron fires every fifteen minutes, which is right for a shop and wrong
 * for an owner who has just shortened a wait in the settings and wants to see
 * it take effect. It is the same function the cron calls — not a second
 * implementation — so what this promotes is exactly what the cron would have.
 */
// ---------------------------------------------------------------- printing

/**
 * Everything the paper needs, read from the ORDER as it was placed.
 *
 * Nothing is recomputed. A receipt that recalculates a total is a receipt
 * that can disagree with the order it is a receipt for — and the customer is
 * holding the disagreement.
 */
async function receiptDataFor(c: Context<AppContext>, id: string) {
  const o = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!o) throw notFound('Order not found');
  const [{ results: items }, invoice] = await Promise.all([
    c.env.DB.prepare(`${ORDER_ITEMS_SELECT} WHERE oi.order_id = ? ORDER BY oi.rowid`).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT invoice_no FROM invoices WHERE order_id = ? ORDER BY revision DESC LIMIT 1')
      .bind(id).first<{ invoice_no: string }>().catch(() => null),
  ]);
  const address = safeParse<Record<string, unknown>>(o.address_snapshot, {});
  const coupon = safeParse<{ code?: string; discount_iqd?: number } | null>(o.coupon_snapshot, null);
  const shippingType = asShippingType(o.shipping_type);

  return {
    order: o,
    address,
    data: {
      order_id: String(o.id),
      invoice_no: invoice?.invoice_no ?? null,
      created_at: String(o.created_at ?? ''),
      customer_name: String(address.name ?? ''),
      phone: String(address.phone ?? ''),
      governorate: String(address.governorate ?? ''),
      area: String(address.area ?? ''),
      address: String(address.address ?? ''),
      landmark: String(address.landmark ?? ''),
      notes: String(address.notes ?? ''),
      // PRICED LINES ONLY, with a bundle's parts listed under it. The
      // components carry `unit_price_iqd = 0` by design (the money is on the
      // parent), so printing them as receipt lines would put four 0 IQD rows
      // naming the member products on the customer's paper copy (§6.3).
      lines: (items ?? [])
        .filter((it) => !it.bundle_parent_item_id)
        .map((it) => {
          const kids = (items ?? []).filter(
            (k) => String(k.bundle_parent_item_id ?? '') === String(it.id)
          );
          return {
            name: String(it.name_snapshot ?? ''),
            variant: String(it.option_snapshot ?? ''),
            qty: Number(it.qty) || 0,
            unit_iqd: Number(it.unit_price_iqd) || 0,
            line_iqd: Number(it.line_total_iqd) || 0,
            ...(kids.length
              ? {
                  included: kids.map((k) => ({
                    name: String(k.name_snapshot ?? ''),
                    variant: String(k.option_snapshot ?? ''),
                    qty: Number(k.qty) || 0,
                  })),
                }
              : {}),
          };
        }),
      // Only the adjustments this order actually carried. A zero row is
      // filtered by the renderer, so an order with no coupon prints no
      // coupon line rather than "coupon: 0".
      adjustments: [
        { label_ar: `خصم الكود ${coupon?.code ?? ''}`.trim(), label_en: `Coupon ${coupon?.code ?? ''}`.trim(),
          amount_iqd: Number(coupon?.discount_iqd) || 0, negative: true },
        { label_ar: 'خصم النقاط', label_en: 'Points', amount_iqd: Number(o.points_discount_iqd) || 0, negative: true },
        { label_ar: 'من المحفظة', label_en: 'Wallet', amount_iqd: Number(o.wallet_applied_iqd) || 0, negative: true },
      ],
      subtotal_iqd: Number(o.subtotal_iqd) || 0,
      shipping_iqd: Number(o.shipping_iqd) || 0,
      total_iqd: Number(o.total_iqd) || 0,
      due_on_delivery_iqd: Number(o.due_on_delivery_iqd) || 0,
      payment_method: String(o.payment_method_id ?? ''),
      shipping_type_label: SHIPPING_TYPE_LABELS[shippingType].ar,
      support_code: String(safeParse<{ ref?: string } | null>(o.support_snapshot, null)?.ref ?? ''),
    },
  };
}

const printLang = (c: Context<AppContext>): 'ar' | 'en' => (c.req.query('lang') === 'en' ? 'en' : 'ar');
const wantsPrint = (c: Context<AppContext>) => c.req.query('print') === '1';

/** وصل الشراء — the receipt the shop hands over or puts in the box. */
adminRoutes.get('/orders/:id/receipt', async (c) => {
  const id = c.req.param('id');
  const { data } = await receiptDataFor(c, id);
  if (c.req.query('format') === 'escpos') {
    // Raw bytes for a shop with a networked printer and a print server. A
    // browser cannot open a printer itself; this is a body that server can
    // forward, rendered from the same data as the HTML.
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return c.body(escposReceipt(data, int(c.req.query('cols') ?? 48, 'cols', { min: 24, max: 96 })));
  }
  c.header('Cache-Control', 'no-store');
  asDocument(c);
  return c.html(renderPurchaseReceipt(data, printLang(c), wantsPrint(c),
    int(c.req.query('width') ?? 80, 'width', { min: 50, max: 110 })));
});

/**
 * وصل الضمان — printed ALONGSIDE the purchase receipt for devices.
 *
 * Refuses rather than printing an empty form. A blank warranty slip in a
 * customer's hand is a promise nobody made, and the units only exist once
 * the order is delivered (that is when the warranty clock starts), so before
 * then there is genuinely nothing to print and the message says so.
 */
adminRoutes.get('/orders/:id/warranty-receipt', async (c) => {
  const id = c.req.param('id');
  const { data } = await receiptDataFor(c, id);
  const { results: units } = await c.env.DB.prepare(
    `SELECT iu.unit_index, iu.warranty_base_months, iu.warranty_ext_months,
            iu.warranty_start_at, iu.warranty_end_at, oi.name_snapshot, ds.serial_raw
       FROM order_item_units iu
       JOIN order_items oi ON oi.id = iu.order_item_id
       LEFT JOIN device_serials ds ON ds.unit_id = iu.id
      WHERE iu.order_id = ?
      ORDER BY iu.order_item_id, iu.unit_index`
  ).bind(id).all<Record<string, unknown>>();

  const warranted = (units ?? []).filter((u) => (Number(u.warranty_base_months) || 0) + (Number(u.warranty_ext_months) || 0) > 0);
  if (warranted.length === 0) {
    throw badRequest(
      'This order has no warranted device units yet — warranty starts at delivery, so there is nothing to print.',
      'NO_WARRANTY_UNITS'
    );
  }

  // The owner's PUBLISHED warranty policy, in the language being printed,
  // falling back to Arabic — never a paraphrase written here. No published
  // policy prints no terms block at all rather than invented ones.
  const lang = printLang(c);
  const policy =
    (await c.env.DB.prepare(
      "SELECT body FROM policy_documents WHERE key = 'warranty' AND status = 'published' AND lang = ? ORDER BY version DESC LIMIT 1"
    ).bind(lang).first<{ body: string }>().catch(() => null)) ??
    (await c.env.DB.prepare(
      "SELECT body FROM policy_documents WHERE key = 'warranty' AND status = 'published' AND lang = 'ar' ORDER BY version DESC LIMIT 1"
    ).first<{ body: string }>().catch(() => null));

  c.header('Cache-Control', 'no-store');
  asDocument(c);
  return c.html(renderWarrantyReceipt(
    {
      order_id: data.order_id,
      invoice_no: data.invoice_no,
      created_at: data.created_at,
      customer_name: data.customer_name,
      phone: data.phone,
      units: warranted.map((u) => ({
        product_name: String(u.name_snapshot ?? ''),
        serial: (u.serial_raw as string | null) ?? null,
        unit_index: Number(u.unit_index) || 0,
        months: (Number(u.warranty_base_months) || 0) + (Number(u.warranty_ext_months) || 0),
        starts_at: (u.warranty_start_at as string | null) ?? null,
        ends_at: (u.warranty_end_at as string | null) ?? null,
      })),
      // The owner's published warranty policy, not a paraphrase of it.
      terms: String(policy?.body ?? '').slice(0, 1200),
    },
    lang,
    wantsPrint(c),
    int(c.req.query('width') ?? 80, 'width', { min: 50, max: 110 })
  ));
});

function labelFrom(data: Awaited<ReturnType<typeof receiptDataFor>>['data'], order: Record<string, unknown>, itemCount: number) {
  return {
    order_id: data.order_id,
    customer_name: data.customer_name,
    phone: data.phone,
    governorate: data.governorate,
    area: data.area,
    address: data.address,
    landmark: data.landmark,
    notes: data.notes,
    // Cash on delivery collects what is still owed; anything prepaid
    // collects nothing. Read from the order, never assumed from the total.
    cod_iqd: String(order.payment_method_id) === 'cash'
      ? Number(order.total_iqd) || 0
      : Number(order.due_on_delivery_iqd) || 0,
    item_count: itemCount,
    tracking_no: String(order.delivery_tracking_no ?? ''),
    created_at: data.created_at,
  };
}

/** One delivery sticker. */
adminRoutes.get('/orders/:id/label', async (c) => {
  const id = c.req.param('id');
  const { data, order } = await receiptDataFor(c, id);
  const count = data.lines.reduce((n, l) => n + l.qty, 0);
  c.header('Cache-Control', 'no-store');
  asDocument(c);
  return c.html(renderDeliveryLabel(labelFrom(data, order, count), printLang(c), wantsPrint(c)));
});

/**
 * A sheet of stickers for NEW orders — "طباعة ستيكرات الطلبات الجديدة".
 *
 * "New" is defined HERE, once, and it means an order that has not been
 * dispatched: stage `received` or `confirmed`. Printing a sticker for a
 * parcel already on a motorbike is how the same order goes out twice.
 *
 * The `ids` parameter narrows it to an explicit selection, so an admin can
 * print the six they just packed rather than every open order — and even
 * then the new-only rule still applies, because a selection is a convenience
 * and not permission to re-print a dispatched order.
 */
adminRoutes.get('/labels', async (c) => {
  const idsRaw = str(c.req.query('ids'), 'ids', { max: 2000, required: false });
  const ids = idsRaw ? idsRaw.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 100) : [];
  const limit = int(c.req.query('limit') ?? 50, 'limit', { min: 1, max: 100 });
  // The queue is longer than one sheet on any busy day (177 undispatched
  // orders against a 50-sticker page, in the database this was found on). It
  // used to print the oldest fifty and say nothing, which is how a warehouse
  // ships the wrong set: `offset` makes the rest REACHABLE, and the sheet's
  // banner makes the truncation VISIBLE. Neither alone is a fix.
  const offset = int(c.req.query('offset') ?? 0, 'offset', { min: 0, max: 100000 });

  const NEW_STAGES = ['received', 'confirmed'];
  const placeholders = NEW_STAGES.map(() => '?').join(',');
  const sql = ids.length
    ? `SELECT * FROM orders WHERE stage IN (${placeholders}) AND id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`
    : `SELECT * FROM orders WHERE stage IN (${placeholders}) ORDER BY created_at LIMIT ? OFFSET ?`;
  const binds = ids.length ? [...NEW_STAGES, ...ids] : [...NEW_STAGES, limit, offset];
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();

  // The whole undispatched queue, counted separately: the page cannot report
  // what it does not print, and a count derived from the page is always the
  // page's own length, which is the bug this exists to close.
  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE stage IN (${placeholders})`
  ).bind(...NEW_STAGES).first<{ n: number }>();
  const total = Number(totalRow?.n ?? 0);

  const orderIds = (results ?? []).map((o) => String(o.id));
  const counts = new Map<string, number>();
  if (orderIds.length) {
    const { results: rows } = await c.env.DB.prepare(
      // A bundle counts ONCE — its component rows are the physical truth behind
      // it, not four more things on the label (docs/BUNDLES_MYSTERY.md §6.3).
      `SELECT order_id, SUM(qty) AS n FROM order_items
        WHERE order_id IN (${orderIds.map(() => '?').join(',')}) AND bundle_parent_item_id IS NULL
        GROUP BY order_id`
    ).bind(...orderIds).all<{ order_id: string; n: number }>();
    for (const r of rows ?? []) counts.set(String(r.order_id), Number(r.n) || 0);
  }

  const labels = (results ?? []).map((o) => {
    const address = safeParse<Record<string, unknown>>(o.address_snapshot, {});
    return {
      order_id: String(o.id),
      customer_name: String(address.name ?? ''),
      phone: String(address.phone ?? ''),
      governorate: String(address.governorate ?? ''),
      area: String(address.area ?? ''),
      address: String(address.address ?? ''),
      landmark: String(address.landmark ?? ''),
      notes: String(address.notes ?? ''),
      cod_iqd: String(o.payment_method_id) === 'cash'
        ? Number(o.total_iqd) || 0
        : Number(o.due_on_delivery_iqd) || 0,
      item_count: counts.get(String(o.id)) ?? 0,
      tracking_no: String(o.delivery_tracking_no ?? ''),
      created_at: String(o.created_at ?? ''),
    };
  });

  // An explicit selection is its own complete sheet — there is no "rest" to
  // link to, so it reports only what it holds.
  const nextOffset = offset + labels.length;
  const url = new URL(c.req.url);
  url.searchParams.set('offset', String(nextOffset));
  url.searchParams.set('limit', String(limit));
  const batch = ids.length
    ? { total: labels.length, offset: 0 }
    : {
        total,
        offset,
        nextUrl: nextOffset < total ? `${url.pathname}${url.search}` : undefined,
      };

  c.header('Cache-Control', 'no-store');
  asDocument(c);
  return c.html(renderLabelSheet(labels, printLang(c), wantsPrint(c), batch));
});

// ------------------------------------------------------------ local delivery

/**
 * Builds the courier driver, or throws the honest 503 that says why not.
 *
 * A missing credential is not a server error and must not read like one. The
 * message names the SETTING, never a value — the owner's rule is that no
 * token or login ever leaves the Worker, and that includes leaving it inside
 * an error message.
 */
async function deliveryDriverOrFail(c: Context<AppContext>): Promise<DeliveryDriver> {
  const wire = await getSetting(c.env.DB, 'deliveryConfig');
  const driver = alwaseetDriver(c.env, wire);
  if ('configured' in driver) {
    throw new HttpError(
      503,
      `${driver.reason} Missing: ${driver.missing.join(', ')}.`,
      'DELIVERY_NOT_CONFIGURED',
      { missing: driver.missing }
    );
  }
  return driver;
}

/** What is and is not set up, for the admin screen. Names only, no values. */
adminRoutes.get('/delivery/config', async (c) => {
  const wire = (await getSetting(c.env.DB, 'deliveryConfig')) as Record<string, unknown>;
  const driver = alwaseetDriver(c.env, wire);
  const mappings = await listStatusMap(c.env.DB, ALWASEET).catch(() => []);
  return c.json({
    success: true,
    provider: ALWASEET,
    credentials_configured: !('configured' in driver),
    missing_credentials: 'configured' in driver ? driver.missing : [],
    // The wire config is not secret — it is endpoint paths and field names —
    // so it is safe to show and to edit from the panel.
    wire: wire ?? {},
    statuses_known: mappings.length,
    statuses_mapped: mappings.filter((m) => m.internal_stage !== '').length,
  });
});

/**
 * Refreshes the courier's OFFICIAL status list — "اجلب قائمة الحالات الرسمية
 * من GET /v1/merchant/statuses ولا تعتمد على نصوص hardcoded".
 *
 * Never touches mappings the owner already made: a refresh that silently
 * unmapped a status would break every order using it.
 */
adminRoutes.post('/delivery/statuses/refresh', async (c) => {
  const adminUser = c.get('user')!;
  const driver = await deliveryDriverOrFail(c);
  const res = await driver.listStatuses();
  if (!res.ok) throw badRequest(res.error, 'DELIVERY_API_ERROR', { retryable: res.retryable });
  const now = new Date().toISOString();
  const out = await upsertRemoteStatuses(c.env.DB, driver.provider, res.value, now);
  await audit(c.env.DB, adminUser.id, 'delivery.statuses_refresh', driver.provider, out);
  return c.json({ success: true, ...out, statuses: await listStatusMap(c.env.DB, driver.provider) });
});

adminRoutes.get('/delivery/statuses', async (c) => {
  return c.json({ success: true, statuses: await listStatusMap(c.env.DB, ALWASEET) });
});

/** The owner's alwaseet_status_id -> internal stage mapping, one row at a time. */
adminRoutes.put('/delivery/statuses/:remoteId', async (c) => {
  const adminUser = c.get('user')!;
  const remoteId = c.req.param('remoteId');
  const body = await c.req.json().catch(() => ({}));
  const stage = str(body.stage, 'stage', { max: 40, required: false });
  // '' clears a mapping, which is how an owner says "I do not know what this
  // means yet" — and an unmapped status leaves orders alone.
  if (stage && !(stage in STAGE_SOURCE)) throw badRequest(`Unknown stage "${stage}"`);
  await setStatusMapping(c.env.DB, ALWASEET, remoteId, stage, new Date().toISOString());
  await audit(c.env.DB, adminUser.id, 'delivery.status_map', remoteId, { stage });
  return c.json({ success: true, statuses: await listStatusMap(c.env.DB, ALWASEET) });
});

/**
 * Creates the courier shipment for one order — the admin's action at
 * "جارٍ تجهيز التوصيل المحلي".
 *
 * Refuses to create a SECOND shipment for an order that already has one:
 * a double-tap would put two drivers on the same parcel and leave us syncing
 * the wrong id.
 */
adminRoutes.post('/orders/:id/delivery', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const driver = await deliveryDriverOrFail(c);

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');
  if (order.delivery_remote_id) {
    throw badRequest('This order already has a delivery shipment.', 'SHIPMENT_EXISTS', {
      remote_id: order.delivery_remote_id,
      tracking_no: order.delivery_tracking_no ?? '',
    });
  }
  const address = safeParse<Record<string, unknown>>(order.address_snapshot, {});
  // THE COURIER GETS THE PARENT NAME AND THE PHYSICAL COUNT (§6.3). A courier
  // is a third party: they carry one box holding one bundle, and listing its
  // member products would tell them what is inside it — and would double the
  // count on the waybill.
  const { results: items } = await c.env.DB.prepare(
    'SELECT name_snapshot, qty FROM order_items WHERE order_id = ? AND bundle_parent_item_id IS NULL'
  ).bind(id).all<{ name_snapshot: string; qty: number }>();

  const res = await driver.createShipment({
    orderId: String(order.id),
    customerName: String(address.name ?? ''),
    phone: String(address.phone ?? ''),
    governorate: String(address.governorate ?? ''),
    area: String(address.area ?? ''),
    address: String(address.address ?? ''),
    landmark: String(address.landmark ?? ''),
    notes: String(address.notes ?? ''),
    // Cash on delivery collects the total; anything already paid collects
    // nothing. Getting this wrong takes money off a customer twice, so it is
    // read from the order rather than assumed.
    amountIqd: String(order.payment_method_id) === 'cash' ? Number(order.total_iqd) || 0 : 0,
    itemCount: (items ?? []).reduce((n, i) => n + Number(i.qty || 0), 0),
    itemsSummary: (items ?? []).map((i) => `${i.name_snapshot} x${i.qty}`).join(', ').slice(0, 500),
  });

  if (!res.ok) {
    // The order is NOT moved and NOT marked as shipped. The error is stored
    // so the admin sees it on the order rather than only in a toast.
    await c.env.DB.prepare('UPDATE orders SET delivery_error = ? WHERE id = ?')
      .bind(res.error.slice(0, 500), id).run();
    throw badRequest(res.error, 'DELIVERY_API_ERROR', { retryable: res.retryable });
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE orders SET delivery_provider = ?, delivery_remote_id = ?, delivery_tracking_no = ?,
            delivery_status_id = ?, delivery_status_text = ?, delivery_synced_at = ?, delivery_error = ''
      WHERE id = ?`
  )
    .bind(driver.provider, res.value.remoteId, res.value.trackingNo, res.value.statusId, res.value.statusText, now, id)
    .run();
  await audit(c.env.DB, adminUser.id, 'delivery.shipment_create', id, {
    provider: driver.provider, remote_id: res.value.remoteId, tracking_no: res.value.trackingNo,
  });

  // The stage is NOT advanced here. "لا تستخدم Timer للانتقال إلى في الطريق
  // إليك" — creating a shipment is not the courier picking it up, and only
  // the courier's own status may say that.
  return c.json({
    success: true,
    provider: driver.provider,
    remote_id: res.value.remoteId,
    tracking_no: res.value.trackingNo,
  });
});

/** The owner's "مزامنة حالة الوسيط" button, for one order. */
adminRoutes.post('/orders/:id/delivery/sync', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const driver = await deliveryDriverOrFail(c);
  const res = await syncOrderDelivery(c.env, driver, id);
  await audit(c.env.DB, adminUser.id, 'delivery.sync', id, { outcome: res.outcome });
  // An error is reported as an error, but with 200: the sync ran, it just
  // could not reach the courier, and the admin needs to see WHICH it was.
  return c.json({ success: true, ...res });
});

/** The same sync the cron runs, on demand. */
adminRoutes.post('/delivery/sync', async (c) => {
  const adminUser = c.get('user')!;
  const driver = await deliveryDriverOrFail(c);
  const report = await sweepDeliveryStatuses(c.env, driver, 100);
  await audit(c.env.DB, adminUser.id, 'delivery.sync_all', driver.provider, {
    scanned: report.scanned, moved: report.moved, errors: report.errors,
  });
  return c.json({ success: true, ...report });
});

adminRoutes.post('/orders/sweep-stages', async (c) => {
  const adminUser = c.get('user')!;
  const report = await sweepDueStages(c.env, 200);
  await audit(c.env.DB, adminUser.id, 'order.stage_sweep', '', {
    scanned: report.scanned, promoted: report.promoted, skipped: report.skipped,
  });
  return c.json({ success: true, ...report });
});

adminRoutes.patch('/orders/:id/stage', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const to = str(body.stage, 'stage', { max: 40 }) as OrderStage;
  if (!(to in STAGE_SOURCE)) throw badRequest(`Unknown stage "${to}"`);
  const note = str(body.note, 'note', { max: 500, required: false });

  const res = await moveOrderStage(c.env, {
    orderId: id,
    to,
    source: 'manual',
    changedBy: adminUser.id,
    note,
  });
  if (!res.moved) {
    if (res.reason === 'NOT_FOUND') throw notFound('Order not found');
    if (res.reason === 'RACED') throw badRequest('The order changed while you were editing — reload and retry');
    // The re-claim trigger refused (§17 decision 4). The transition itself is
    // legal, so ILLEGAL_STAGE_MOVE would send staff hunting a nonexistent
    // transition bug — and the sibling status route already answers this exact
    // situation correctly, so the two admin doors must not disagree.
    if (res.reason === 'OFFER_LIMIT_REACHED') {
      throw badRequest(
        'This order cannot be re-opened: its offer allowance was used again after the cancellation.',
        'OFFER_LIMIT_REACHED'
      );
    }
    throw badRequest(`Cannot move this order from "${res.from}" to "${to}"`, 'ILLEGAL_STAGE_MOVE', {
      from: res.from,
      to,
    });
  }

  // Reaching `delivered` grants device warranties and purchase points. That
  // lives in the legacy PATCH handler below and is NOT duplicated here: an
  // admin marking an order delivered by stage is routed through the same
  // grant path so the two can never award different things.
  const notes = [...res.notes];
  if (to === 'delivered') {
    const effects = await deliveredEffects(c, id);
    if (effects.deviceUnitsWarning) notes.push(effects.deviceUnitsWarning);
  }

  await audit(c.env.DB, adminUser.id, 'order.stage', id, {
    from: res.from, to, source: 'manual',
    legacy: `${res.legacy_from} -> ${res.legacy_to}`,
    next_stage: res.next_stage, next_stage_at: res.next_stage_at,
  });
  return c.json({
    success: true,
    stage: to,
    legacy_status: res.legacy_to,
    next_stage: res.next_stage,
    next_stage_at: res.next_stage_at,
    ...(notes.length ? { notes } : {}),
  });
});

adminRoutes.patch('/orders/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const next = oneOf(body.status, 'status', [
    'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled',
  ] as const);
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });

  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!order) throw notFound('Order not found');
  const from = String(order.status);
  if (!ORDER_TRANSITIONS[from]?.includes(next)) {
    throw badRequest(`Cannot move an order from "${from}" to "${next}"`);
  }

  // delivered_at is stamped in the SAME conditional update as the status flip
  // so a concurrent transition can never produce a delivered order without it.
  //
  // AND IT IS STAMPED ONCE, NOT ON EVERY FLIP. This line used to re-stamp
  // unconditionally while the stage door (worker/lib/orderStageOps.ts:177)
  // COALESCEd and kept the first value — so the two doors to the same event
  // disagreed, and which one an admin happened to press decided when the
  // customer's clocks started.
  //
  // That is not a tidiness point. `delivered_at` IS the start of the warranty
  // (worker/routes/warranty.ts:494) and of the seven-day return window
  // (worker/routes/returns.ts:7-8) — «الضمان والاسترجاع يبدأ من تاريخ
  // تم التوصيل». An admin toggling a delivered order back to shipped and
  // forward again re-stamped it to today, which silently re-opened a return
  // window that had already closed and moved the warranty's end a month out.
  // The customer received the goods once; there is one date.
  const flipStmt = c.env.DB.prepare(
    next === 'delivered'
      ? `UPDATE orders SET status = ?, admin_note = ?,
           delivered_at = COALESCE(NULLIF(delivered_at,''), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = ?`
      : `UPDATE orders SET status = ?, admin_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = ?`
  ).bind(next, adminNote, id, from);

  let stockNote: string | null = null;
  let flipped: number;
  if (next === 'cancelled') {
    // A cancellation is ONE transaction: the status flip, the stock return
    // (§7 — a release when the order was never confirmed, a restore when it
    // was), the refund of wallet money and points, the points-reservation
    // flip and the pending-accrual cancellation (orderCancelOps — the same
    // statements the customer's cancel runs). This route used to flip first,
    // post only the two refund rows from a later batch, and never touch the
    // reservation or the accrual. A lost flip aborts the whole batch.
    const stock = await planOrderReturn(c.env.DB, id, adminUser.id);
    try {
      const res = await c.env.DB.batch([
        flipStmt,
        ...(stock.plan?.statements ?? []),
        ...cancelledOrderRefundStatements(c.env, order, 'admin', new Date().toISOString()),
      ]);
      flipped = res[0]?.meta.changes ?? 0;
    } catch (e) {
      const again = await c.env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(id).first<{ status: string }>();
      if (again && again.status !== from) throw badRequest('The order changed while you were editing — reload and retry');
      throw e;
    }
    stockNote = stockReturnNote(stock.kind, stock.plan?.applied ?? 0);
  } else if (from === 'cancelled') {
    // RE-OPENING. The slot this order released when it was cancelled has to
    // come back with it (§17 decision 4) — otherwise the customer keeps the
    // goods AND the entitlement. Flip and re-claim in ONE batch, because a
    // re-claim the limit trigger refuses must take the re-open with it.
    try {
      const res = await c.env.DB.batch([flipStmt, reclaimOrderRedemptionsStatement(c.env.DB, id)]);
      flipped = res[0]?.meta.changes ?? 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('OFFER_PER_USER_LIMIT') || msg.includes('OFFER_GLOBAL_LIMIT')) {
        throw badRequest(
          'This order cannot be re-opened: its offer allowance was used again after the cancellation.',
          'OFFER_LIMIT_REACHED'
        );
      }
      throw e;
    }
  } else {
    flipped = (await flipStmt.run()).meta.changes;
  }
  if (flipped === 0) throw badRequest('The order changed while you were editing — reload and retry');

  // §7 stock lifecycle. Confirmation turns the hold taken at checkout into a
  // real decrement (cancellation's return ran inside the batch above). Both
  // are idempotent through the inventory ledger, so a double-clicked
  // transition (or a replay after the status flip already landed) moves
  // nothing twice.
  //
  // The trigger is CROSSING THE BOUNDARY, not landing on one particular
  // status. Now that an order may go pending -> shipped directly, or come back
  // from cancelled to processing, keying the deduction off `next ===
  // 'confirmed'` would have silently skipped it.
  const wasDeducted = STOCK_DEDUCTED_STATES.has(from);
  const nowDeducted = STOCK_DEDUCTED_STATES.has(next);
  if (!wasDeducted && nowDeducted) {
    // THE FENCE ABORT IS AN OPERATOR NOTE, NOT A 500 (§3.3).
    //
    // `deductOrderStock` runs in its own batch after the status flip has
    // already committed, and `planOrderDeduction` appends a fence row to it. A
    // guard that held at plan time but broke at commit — a concurrent
    // `adjust_out`, a racing cancellation — makes the fence's CHECK abort that
    // batch, which is correct: nothing partial commits. But the throw used to
    // escape the route, so the admin saw a generic 500 for a transition that
    // had in fact succeeded, and a retry took the `wasDeducted` branch and
    // never attempted the deduction again. The same note the `rejected` branch
    // produces is the honest answer in both cases: the order IS confirmed, and
    // the stock needs a human. The un-deducted lines stay findable in one
    // indexed read — `reserve` ledger rows on this order with no matching
    // `deduct`.
    try {
      const res = await deductOrderStock(c.env.DB, id, adminUser.id);
      if (res.rejected > 0) {
        stockNote = `Stock could not be deducted for ${res.rejected} line(s) — check the product's stock before shipping.`;
      }
    } catch {
      stockNote = "Stock could not be deducted for this order — check the product's stock before shipping.";
    }
  }

  // Reversing a delivery does not un-grant what delivery granted. Say so
  // rather than letting the admin assume it did.
  let reversalNote: string | null = null;
  if (from === 'delivered' && next !== 'delivered') {
    reversalNote =
      'Moved back from delivered. Points already awarded, device records and warranty start dates are NOT reversed — they stay as they were granted.';
  }

  let deviceUnits: CreateUnitsResult | null = null;
  let deviceUnitsWarning: string | null = null;
  if (next === 'delivered') {
    const effects = await deliveredEffects(c, id);
    deviceUnits = effects.deviceUnits;
    deviceUnitsWarning = effects.deviceUnitsWarning;
  }

  if (next === 'cancelled') {
    // Money, points and stock were returned inside the cancellation batch
    // above (orderCancelOps). What remains is not money:
    // A cancelled order can no longer qualify referral rewards keyed on it —
    // cancel any still-undecided ones (never touches available/reserved/
    // fulfilled rewards, which an admin decided explicitly).
    const rewards = await c.env.DB.prepare(
      `UPDATE referral_rewards
          SET state = 'cancelled',
              decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              decided_by = ?,
              admin_note = CASE WHEN admin_note = '' THEN ? ELSE admin_note END
        WHERE source_ref = ? AND state IN ('pending','qualified')`
    )
      .bind(adminUser.id, `Source order ${id} was cancelled`, id)
      .run();
    if (rewards.meta.changes > 0) {
      await audit(c.env.DB, adminUser.id, 'referral.reward_cancel', id, {
        reason: 'order_cancelled', count: rewards.meta.changes,
      });
    }
  }
  // Keep the tracking stage in step with the legacy status. The old dropdown
  // is still in the panel and still the fastest way to correct an order; if
  // it left the stage behind, the customer's tracker and the admin's list
  // would start telling two different stories about the same parcel.
  //
  // The stage chosen is the EARLIEST one carrying the new status — moving an
  // order to "shipped" must not tell the customer it already reached Iraq —
  // and the schedule is re-armed from now, which is what cancels whatever
  // automatic transition was pending.
  try {
    const shippingType = asShippingType(order.shipping_type);
    const targetStage = stageForLegacyStatus(next, shippingType);
    const currentStage = String(order.stage || 'received') as OrderStage;
    if (targetStage !== currentStage) {
      await moveOrderStage(c.env, {
        orderId: id,
        to: targetStage,
        source: 'manual',
        changedBy: adminUser.id,
        note: adminNote || `Status changed to ${next}`,
        // The legality of this move was already decided by ORDER_TRANSITIONS
        // above, on the legacy statuses. Re-judging it on the stage path
        // would reject corrections the admin is entitled to make.
        force: true,
      });
    }
  } catch (e) {
    console.error('stage sync failed for order', id, e);
  }

  await audit(c.env.DB, adminUser.id, 'order.status', id, {
    from,
    to: next,
    stock: stockNote,
    reversal: reversalNote,
  });

  // AFTER the audit and after the flip has committed, never before: a
  // notification for a transition that did not happen is worse than none.
  // Queued, so the admin's request does not wait on three providers, and
  // silent for `processing` — see NOTIFIED_ORDER_STATUSES.
  c.executionCtx.waitUntil(notifyOrderStatus(c.env, id, next));

  return c.json({
    success: true,
    ...(stockNote ? { stock_note: stockNote } : {}),
    ...(reversalNote ? { reversal_note: reversalNote } : {}),
    ...(deviceUnits ? { device_units: deviceUnits } : {}),
    ...(deviceUnitsWarning ? { device_units_warning: deviceUnitsWarning } : {}),
  });
});

// ---------------------------------------------------------------- coupons

/**
 * Promo codes. The validation engine has existed since migration 0002 —
 * tiers, date windows, global and per-user limits, fixed and percentage
 * discounts, all enforced server-side at checkout — but there was no way to
 * CREATE one, so the storefront's promo box had nothing to accept and was
 * disabled with "قريباً" on it. This is the missing half.
 *
 * Redemptions are counted, not stored twice: the count comes from the
 * coupon_redemptions rows the checkout writes, so a coupon's usage can never
 * disagree with the orders that used it.
 */
adminRoutes.get('/coupons', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.*,
            (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS redeemed
       FROM coupons c ORDER BY c.created_at DESC LIMIT 200`
  ).all<Record<string, unknown>>();
  return c.json({ success: true, coupons: results ?? [] });
});

/** Shared validation for create and update, so the two cannot drift apart. */
function couponFieldsFrom(body: Record<string, unknown>) {
  const kind = oneOf(body.kind, 'kind', ['fixed_iqd', 'percent'] as const);
  const value = int(body.value, 'value', { min: 1, max: kind === 'percent' ? 100 : 100_000_000 });
  const tierRaw = str(body.tier_required, 'tier_required', { max: 10, required: false });
  if (tierRaw && !['plus', 'pro', 'prime'].includes(tierRaw)) {
    throw badRequest('tier_required must be plus, pro or prime');
  }
  const startsAt = str(body.starts_at, 'starts_at', { max: 40, required: false });
  const endsAt = str(body.ends_at, 'ends_at', { max: 40, required: false });
  // A window that closes before it opens would silently never apply. Better
  // refused at the form than debugged from a customer's complaint.
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw badRequest('The end date must be after the start date');
  }
  const maxGlobalRaw = body.max_global;
  const maxGlobal =
    maxGlobalRaw === null || maxGlobalRaw === undefined || maxGlobalRaw === ''
      ? null
      : int(maxGlobalRaw, 'max_global', { min: 1, max: 1_000_000 });
  return {
    kind,
    value,
    tier_required: tierRaw || null,
    min_total_iqd: int(body.min_total_iqd ?? 0, 'min_total_iqd', { min: 0, max: 1_000_000_000 }),
    starts_at: startsAt || null,
    ends_at: endsAt || null,
    max_global: maxGlobal,
    max_per_user: int(body.max_per_user ?? 1, 'max_per_user', { min: 1, max: 1000 }),
    active: body.active === false ? 0 : 1,
  };
}

adminRoutes.post('/coupons', async (c) => {
  const adminUser = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  // Stored uppercased, as the column has always assumed, and with spaces
  // stripped: a customer typing "save 10" must reach the same row.
  const code = str(body.code, 'code', { min: 3, max: 60 }).trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9_-]+$/.test(code)) throw badRequest('A code may use letters, digits, - and _ only');
  const f = couponFieldsFrom(body);
  const id = newId('cpn');
  try {
    await c.env.DB.prepare(
      `INSERT INTO coupons (id, code, tier_required, kind, value, min_total_iqd, starts_at, ends_at,
         max_global, max_per_user, active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
      .bind(id, code, f.tier_required, f.kind, f.value, f.min_total_iqd, f.starts_at, f.ends_at,
            f.max_global, f.max_per_user, f.active)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) throw badRequest('That code already exists', 'CODE_TAKEN');
    throw e;
  }
  await audit(c.env.DB, adminUser.id, 'coupon.create', id, { code, kind: f.kind, value: f.value });
  return c.json({ success: true, id, code });
});

adminRoutes.patch('/coupons/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const existing = await c.env.DB.prepare('SELECT id FROM coupons WHERE id = ?').bind(id).first<{ id: string }>();
  if (!existing) throw notFound('Coupon not found');

  // The CODE is not editable. Customers have it written down and orders
  // already reference it in their snapshots; renaming it would break the
  // first and orphan the second. Deactivate and create a new one instead.
  const f = couponFieldsFrom(body);
  await c.env.DB.prepare(
    `UPDATE coupons SET tier_required = ?, kind = ?, value = ?, min_total_iqd = ?,
            starts_at = ?, ends_at = ?, max_global = ?, max_per_user = ?, active = ?
      WHERE id = ?`
  )
    .bind(f.tier_required, f.kind, f.value, f.min_total_iqd, f.starts_at, f.ends_at,
          f.max_global, f.max_per_user, f.active, id)
    .run();
  await audit(c.env.DB, adminUser.id, 'coupon.update', id, f);
  return c.json({ success: true });
});

/**
 * Deactivates a coupon. There is no delete: coupon_redemptions references the
 * row, and an order that says "SAVE10 was applied" must still be able to say
 * what SAVE10 was.
 */
adminRoutes.delete('/coupons/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('UPDATE coupons SET active = 0 WHERE id = ?').bind(id).run();
  if (res.meta.changes === 0) throw notFound('Coupon not found');
  await audit(c.env.DB, adminUser.id, 'coupon.deactivate', id);
  return c.json({ success: true });
});

// ---------------------------------------------------------------- settings

adminRoutes.get('/settings', async (c) => {
  const settings = await getSettings(c.env.DB);
  return c.json({ success: true, settings });
});

// ------------------------------------------------------- main page media
//
// Brand marks and service icons on the home page. The owner's rule is that
// these are WebP, so this route ENFORCES it rather than converting: the sniff
// below reads magic bytes, and anything that is not a RIFF/WEBP container is
// refused by name. `/api/uploads` cannot serve this purpose — its key builder
// produces owner-scoped four-segment keys and its purpose list is closed, and
// widening either for six site-wide images would weaken a path that carries
// customer uploads.

adminRoutes.get('/site-media', async (c) => {
  const stored = await getSetting(c.env.DB, 'mainPageMedia');
  return c.json({ success: true, media: resolveSiteMedia(stored) });
});

adminRoutes.post('/site-media/:slot', async (c) => {
  const adminUser = c.get('user')!;
  const slot = findSiteMediaSlot(c.req.param('slot'));
  if (!slot) throw notFound('Unknown main page media slot');

  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No file uploaded');
  if (file.size > SITE_MEDIA_MAX_BYTES) {
    throw badRequest(
      `الصورة أكبر من الحد (${Math.round(SITE_MEDIA_MAX_BYTES / 1024 / 1024)} ميغابايت) / Image is larger than ${Math.round(SITE_MEDIA_MAX_BYTES / 1024 / 1024)} MB`,
      'SITE_MEDIA_TOO_LARGE'
    );
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind || kind.mime !== SITE_MEDIA_MIME) {
    throw badRequest(
      'صور الصفحة الرئيسية يجب أن تكون WebP فقط / Main page media must be a WebP image',
      'SITE_MEDIA_NOT_WEBP'
    );
  }
  const dimensions = rasterDimensions(buf, kind.mime);
  if (!validRasterDimensions(dimensions)) {
    throw badRequest('The image has invalid or unsupported dimensions', 'BAD_IMAGE_DIMENSIONS');
  }

  // A NEW object name every time, never an overwrite — /files/* stamps public
  // keys `immutable` for a year, so replacing bytes under a live key would
  // leave caches serving the old logo with nothing here able to purge them.
  const object = mintSiteMediaObject(slot.slot, newId());
  const key = siteMediaKey(object);
  await putMediaObject(
    c.env,
    {
      key,
      visibility: 'public',
      domain: 'ui',
      mime: kind.mime,
      bytes: buf.byteLength,
      ownerId: adminUser.id,
      entityId: slot.slot,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      originalName: String(form.get('originalName') || file.name),
    },
    buf,
    { httpMetadata: { contentType: kind.mime, cacheControl: 'public, max-age=31536000, immutable' } }
  );

  const stored = normalizeSiteMedia(await getSetting(c.env.DB, 'mainPageMedia'));
  const previous = stored[slot.slot] ?? '';
  await setSetting(c.env.DB, 'mainPageMedia', { ...stored, [slot.slot]: object });
  await audit(c.env.DB, adminUser.id, 'admin.site_media_set', slot.slot, { object, previous, bytes: buf.byteLength });

  return c.json({ success: true, media: resolveSiteMedia({ ...stored, [slot.slot]: object }) });
});

/** Reverts a slot to its seeded default. The uploaded object is left in R2. */
adminRoutes.delete('/site-media/:slot', async (c) => {
  const adminUser = c.get('user')!;
  const slot = findSiteMediaSlot(c.req.param('slot'));
  if (!slot) throw notFound('Unknown main page media slot');
  const stored = normalizeSiteMedia(await getSetting(c.env.DB, 'mainPageMedia'));
  const previous = stored[slot.slot] ?? '';
  delete stored[slot.slot];
  await setSetting(c.env.DB, 'mainPageMedia', stored);
  await audit(c.env.DB, adminUser.id, 'admin.site_media_cleared', slot.slot, { previous });
  return c.json({ success: true, media: resolveSiteMedia(stored) });
});

adminRoutes.put('/settings/:key', async (c) => {
  const adminUser = c.get('user')!;
  const key = c.req.param('key') as SettingKey;
  if (!SETTING_KEYS.includes(key)) throw badRequest('Unknown setting');
  // The farm's balancing document has exactly one write path — the route that
  // normalises it, refuses an unusable one, bumps its version and audits the
  // change per section. Storing it raw here would bypass all four.
  if (key === 'printerFarmConfig') {
    throw badRequest(
      'إعدادات مزرعة الطابعات تُحرَّر من مسارها الخاص / Use PUT /api/admin/farm/config/:section for the printer farm configuration',
      'FARM_CONFIG_ROUTE'
    );
  }
  // Same reasoning as the farm config: mainPageMedia is a pointer INTO R2, and
  // the only writer that can guarantee the object it names actually exists —
  // and is a WebP — is the upload route below. A raw JSON write here would
  // happily store a filename for bytes nobody ever uploaded, and the storefront
  // would render a broken image on its first screen.
  if (key === 'mainPageMedia') {
    throw badRequest(
      'صور الصفحة الرئيسية تُرفع من مسارها الخاص / Use POST /api/admin/site-media/:slot to upload main page media',
      'SITE_MEDIA_ROUTE'
    );
  }
  const body = await c.req.json().catch(() => ({}));
  let value = body.value as unknown;

  if (key === 'exchangeRate') {
    value = int(value, 'exchangeRate', { min: 1, max: 1_000_000 });
  } else if (key === 'currency') {
    value = oneOf(value, 'currency', ['IQD', 'USD'] as const);
  } else if (key === 'adVideoUrl') {
    const s = str(value, 'adVideoUrl', { max: 500, required: false });
    if (s && !/^https?:\/\//.test(s)) throw badRequest('adVideoUrl must be an http(s) URL');
    value = s;
  } else if (
    key === 'paymentMethods' || key === 'checkoutDeliveryMethods' ||
    key === 'checkoutPaymentMethods' || key === 'cartShippingMethods' ||
    key === 'homeSections' || key === 'homeAds'
  ) {
    if (!Array.isArray(value) || value.length > 50) throw badRequest(`${key} must be an array (max 50 items)`);
    for (const item of value) {
      if (typeof item !== 'object' || item === null || typeof (item as { id?: unknown }).id !== 'string') {
        throw badRequest(`Every ${key} entry needs a string id`);
      }
    }
  } else if (key === 'homeBanners' || key === 'homeSectionItems') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest(`${key} must be an object`);
    if (JSON.stringify(value).length > 100_000) throw badRequest(`${key} is too large`);
    // Normalize on the WAY IN, not only on the way out. This is the content
    // the storefront puts in an <img src> and an <a href>, so a link that is
    // not a path or an http(s) URL is dropped here rather than stored and
    // filtered on every read. It also accepts the pre-hero `{id,image,link}`
    // shape unchanged, so existing banners survive the upgrade.
    value = key === 'homeBanners' ? normalizeHomeBanners(value) : normalizeSectionItems(value);
  } else if (key === 'deliveryConfig') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw badRequest('deliveryConfig must be an object');
    }
    if (JSON.stringify(value).length > 20_000) throw badRequest('deliveryConfig is too large');
    // Normalized by the same function the driver reads with, so what survives
    // here is exactly what will go on the wire. A credential accidentally
    // pasted into this object is DROPPED rather than stored: the shape only
    // admits endpoint paths and field-name maps, and secrets belong in Worker
    // secrets where no admin screen can read them back.
    value = resolveWire(value);
  } else if (key === 'preorderGiftConfig') {
    // «PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية». Enabling it without naming
    // the filament is refused rather than stored: a switch that promises a
    // gift and grants nothing is worse than a switch that is off, and the
    // checkout would silently skip every order.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw badRequest('preorderGiftConfig must be an object');
    }
    const g = value as Record<string, unknown>;
    const enabled = g.enabled === true;
    const productId = str(g.product_id, 'product_id', { max: 60, required: false });
    if (enabled && !productId) {
      throw badRequest('اختر منتج الفلمنت قبل تفعيل الهدية', 'GIFT_PRODUCT_REQUIRED');
    }
    if (productId) {
      const exists = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first();
      if (!exists) throw badRequest('منتج الفلمنت غير موجود', 'GIFT_PRODUCT_NOT_FOUND');
    }
    const qty = g.qty === undefined || g.qty === null ? 1 : int(g.qty, 'qty', { min: 1, max: 10 });
    value = {
      enabled,
      product_id: productId,
      label_ar: str(g.label_ar, 'label_ar', { max: 200, required: false }),
      qty,
    };
  } else if (key === 'orderExpiryConfig') {
    // WHEN AN ABANDONED CHECKOUT LETS GO (owner decision 5). Validated by the
    // SAME function the sweep reads with, on the way IN — so a value that
    // survives here is exactly the value the clock will use. A TTL below the
    // cron's own 15-minute cadence is raised to 15 rather than stored as a
    // number the job could never honour.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw badRequest('orderExpiryConfig must be an object');
    }
    value = resolveOrderExpiry(value);
  } else if (key === 'shippingPolicy') {
    // THE GLOBAL SHIPPING RULES, normalized by the SAME function the checkout
    // reads them with. Anything the engine cannot use is dropped here rather
    // than stored and quietly ignored later, and a fee that is not a
    // non-negative whole number becomes null — "not configured", which the
    // quote reports honestly — instead of a number nobody chose.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw badRequest('shippingPolicy must be an object');
    }
    value = shippingConfigFrom(value);
  } else if (key === 'minMarginPercent') {
    // The profit guard's floor. null clears it, which is not the same as zero:
    // "no floor configured" leaves only the below-cost warning, while a floor
    // of 0 would warn on any product sold at exactly cost.
    if (value === null || value === '' || value === undefined) {
      value = null;
    } else {
      const n = int(value, 'minMarginPercent', { min: 0, max: 99 });
      value = n;
    }
  } else if (key === 'orderStageDurations') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw badRequest('orderStageDurations must be an object of minute values');
    }
    // Validated by the same function the engine reads with, so a value that
    // survives here is exactly the value the clock will use. An unknown key
    // or an out-of-range number is dropped rather than stored to confuse a
    // later reader.
    value = resolveDurations(value);
  }

  await setSetting(c.env.DB, key, value);
  await audit(c.env.DB, adminUser.id, 'settings.update', key);
  return c.json({ success: true });
});

// ------------------------------------------------ community moderation
//
// MOVED, NOT DELETED. Community moderation lives in worker/routes/adminCommunity.ts
// and is mounted at /api/admin/community.
//
// Four routes used to sit here — GET /community/requests, POST
// /community/requests/:id/close, PATCH /community/merchants/:id and DELETE
// /community/products/:id — and because `/api/admin` is mounted BEFORE
// `/api/admin/community`, the first of them SHADOWED the new board: the
// admin console was calling the dedicated module and being answered by this
// one, silently, with a different shape.
//
// They are gone rather than reordered, because each was also wrong by the
// rules the community module now enforces:
//
//   close    set `status` only, leaving the 0031 `state` machine stale
//   verify   changed `verified` without recomputing the badge that depends on it
//   delete   DELETED a community_products row outright, which blanks out what
//            a customer actually bought — the module archives instead (§5)
//
// tests/storefrontIsolation.test.ts asserts no /community/* route is ever
// declared in this file again, because a shadowing route is invisible until
// something reads the response carefully.

// ---------------------------------------------------------------- warranty

adminRoutes.get('/warranty-claims', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT wc.*, u.email, u.username FROM warranty_claims wc
       LEFT JOIN users u ON u.id = wc.user_id ORDER BY wc.created_at DESC LIMIT 200`
  ).all();
  return c.json({ success: true, claims: results });
});

adminRoutes.patch('/warranty-claims/:id', async (c) => {
  const adminUser = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const status = oneOf(body.status, 'status', ['submitted', 'in_review', 'approved', 'rejected'] as const);
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });
  const res = await c.env.DB.prepare('UPDATE warranty_claims SET status = ?, admin_note = ? WHERE id = ?')
    .bind(status, adminNote, c.req.param('id'))
    .run();
  if (res.meta.changes === 0) throw notFound('Claim not found');
  await audit(c.env.DB, adminUser.id, 'warranty.decide', c.req.param('id'), { status });
  return c.json({ success: true });
});

// ---------------------------------------------------------------- invest administration

adminRoutes.get('/invest/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, username, name, is_investor, created_at FROM users ORDER BY created_at DESC LIMIT 500`
  ).all();
  return c.json({ success: true, users: results });
});

adminRoutes.get('/invest/users/:userId', async (c) => {
  const userId = c.req.param('userId');
  const [investments, messages] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 500').bind(userId).all(),
  ]);
  const items: Record<string, unknown[]> = {};
  for (const inv of investments.results) {
    const { results } = await c.env.DB.prepare('SELECT * FROM investment_items WHERE investment_id = ?').bind(inv.id).all();
    items[String(inv.id)] = results;
  }
  return c.json({ success: true, investments: investments.results, items, messages: messages.results });
});

adminRoutes.post('/invest/users/:userId/investments', async (c) => {
  const adminUser = c.get('user')!;
  const userId = c.req.param('userId');
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw notFound('User not found');
  const body = await c.req.json().catch(() => ({}));
  const amount = int(body.amount_usd_cents, 'amount_usd_cents', { min: 1, max: 10_000_000_000 });
  const profit = int(body.expected_profit_usd_cents, 'expected_profit_usd_cents', { min: 0, max: 10_000_000_000, def: 0 });
  const days = int(body.duration_days, 'duration_days', { min: 1, max: 3650, def: 40 });
  const id = newId('inv');
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  await c.env.DB.prepare(
    `INSERT INTO investments (id, user_id, amount_usd_cents, expected_profit_usd_cents, start_date, end_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, userId, amount, profit, start.toISOString(), end.toISOString())
    .run();
  await audit(c.env.DB, adminUser.id, 'invest.create', id, { userId, amount, profit, days });
  return c.json({ success: true, id });
});

adminRoutes.patch('/invest/investments/:id', async (c) => {
  const adminUser = c.get('user')!;
  const id = c.req.param('id');
  const inv = await c.env.DB.prepare('SELECT * FROM investments WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!inv) throw notFound('Investment not found');
  const body = await c.req.json().catch(() => ({}));
  const amount = body.amount_usd_cents !== undefined
    ? int(body.amount_usd_cents, 'amount_usd_cents', { min: 1, max: 10_000_000_000 })
    : Number(inv.amount_usd_cents);
  const profit = body.expected_profit_usd_cents !== undefined
    ? int(body.expected_profit_usd_cents, 'expected_profit_usd_cents', { min: 0, max: 10_000_000_000 })
    : Number(inv.expected_profit_usd_cents);
  const status = body.status !== undefined
    ? oneOf(body.status, 'status', ['active', 'completed', 'cancelled'] as const)
    : String(inv.status);
  let endDate = String(inv.end_date);
  if (body.duration_days !== undefined) {
    const days = int(body.duration_days, 'duration_days', { min: 1, max: 3650 });
    endDate = new Date(new Date(String(inv.start_date)).getTime() + days * 86_400_000).toISOString();
  }
  await c.env.DB.prepare(
    'UPDATE investments SET amount_usd_cents = ?, expected_profit_usd_cents = ?, status = ?, end_date = ? WHERE id = ?'
  )
    .bind(amount, profit, status, endDate, id)
    .run();
  await audit(c.env.DB, adminUser.id, 'invest.update', id, { amount, profit, status });
  return c.json({ success: true });
});

adminRoutes.delete('/invest/investments/:id', async (c) => {
  const adminUser = c.get('user')!;
  const res = await c.env.DB.prepare('DELETE FROM investments WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) throw notFound('Investment not found');
  await audit(c.env.DB, adminUser.id, 'invest.delete', c.req.param('id'));
  return c.json({ success: true });
});

adminRoutes.post('/invest/investments/:id/items', async (c) => {
  const adminUser = c.get('user')!;
  const invId = c.req.param('id');
  const inv = await c.env.DB.prepare('SELECT id FROM investments WHERE id = ?').bind(invId).first();
  if (!inv) throw notFound('Investment not found');
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 'name', { min: 1, max: 200 });
  const price = int(body.price_usd_cents, 'price_usd_cents', { min: 0, max: 10_000_000_000, def: 0 });
  const image = str(body.image, 'image', { max: 500, required: false });
  const id = newId('invi');
  await c.env.DB.prepare(
    'INSERT INTO investment_items (id, investment_id, name, price_usd_cents, image) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, invId, name, price, image)
    .run();
  await audit(c.env.DB, adminUser.id, 'invest.item_add', id, { invId, name });
  return c.json({ success: true, id });
});

adminRoutes.delete('/invest/items/:id', async (c) => {
  const adminUser = c.get('user')!;
  const res = await c.env.DB.prepare('DELETE FROM investment_items WHERE id = ?').bind(c.req.param('id')).run();
  if (res.meta.changes === 0) throw notFound('Item not found');
  await audit(c.env.DB, adminUser.id, 'invest.item_delete', c.req.param('id'));
  return c.json({ success: true });
});

adminRoutes.post('/invest/users/:userId/messages', async (c) => {
  const adminUser = c.get('user')!;
  const userId = c.req.param('userId');
  const body = await c.req.json().catch(() => ({}));
  const message = str(body.message, 'message', { min: 1, max: 2000 });
  const id = newId('imsg');
  await c.env.DB.prepare("INSERT INTO investor_messages (id, user_id, sender, message) VALUES (?, ?, 'admin', ?)")
    .bind(id, userId, message)
    .run();
  await audit(c.env.DB, adminUser.id, 'invest.message', userId);
  return c.json({ success: true, id });
});

// ------------------------------------------------------- blocked name terms

/**
 * THE WORDS A CUSTOMER MAY NOT CALL THEMSELVES — the owner's own list.
 *
 * `worker/lib/nameGuard.ts` ships a seed and explains the matching; this is
 * the door that lets the owner extend it without a deploy, because the words
 * people actually type at a shop in Baghdad are known in Baghdad. A word added
 * here works on the next sign-up.
 *
 * `scope` IS THE SAFETY STORY, not a detail. 'word' matches only between
 * non-letters, which is what keeps «كس» from rejecting «مكسور» and `ass` from
 * rejecting `Cassandra`. 'any' matches anywhere and belongs only to terms long
 * and specific enough that no ordinary word contains them. It defaults to
 * 'word' for exactly that reason: the safer answer is the one a person gets
 * when they do not say.
 */
adminRoutes.get('/blocked-terms', async (c) => {
  // A Worker can be live before migration 0090 applies. A missing TABLE holds
  // no rows, so an empty list is the literal truth — and far better than a
  // screen that 500s at an owner who only wanted to look.
  const results = await degradeIfSchemaMissing(
    'blocked terms (migration 0090)',
    async () =>
      (
        await c.env.DB
          .prepare('SELECT term, scope, owner_added, created_at FROM blocked_terms ORDER BY owner_added DESC, term LIMIT 2000')
          .all<{ term: string; scope: string; owner_added: number }>()
      ).results ?? [],
    [] as Array<{ term: string; scope: string; owner_added: number }>
  );
  return c.json({
    success: true,
    terms: results.map((r) => ({ ...r, owner_added: !!r.owner_added })),
  });
});

adminRoutes.post('/blocked-terms', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // NORMALIZED on the way in — folded hamza and ta marbuta, no diacritics —
  // so one row covers «قندرة» and «قندره» and the owner never has to think
  // about spelling variants.
  const term = normalizeText(str(body.term, 'term', { min: 2, max: 60 }));
  if (!term) throw badRequest('term must contain letters or digits');
  const scope = body.scope === 'any' ? 'any' : 'word';
  // REPLACE, not insert-or-ignore: this door exists so the owner can CORRECT
  // an entry, including one the seed got wrong. `owner_added = 1` is what stops
  // the migration's re-seed resetting their correction.
  await c.env.DB
    .prepare('INSERT OR REPLACE INTO blocked_terms (term, scope, owner_added) VALUES (?, ?, 1)')
    .bind(term, scope)
    .run();
  await audit(c.env.DB, admin.id, 'moderation.blocked_term.set', term, { term, scope });
  return c.json({ success: true, term, scope });
});

adminRoutes.delete('/blocked-terms/:term', async (c) => {
  const admin = c.get('user')!;
  const term = normalizeText(c.req.param('term'));
  if (!term) throw badRequest('term is required');
  const res = await c.env.DB.prepare('DELETE FROM blocked_terms WHERE term = ?').bind(term).run();
  await audit(c.env.DB, admin.id, 'moderation.blocked_term.delete', term, { term });
  return c.json({ success: true, deleted: (res.meta.changes ?? 0) > 0 });
});
