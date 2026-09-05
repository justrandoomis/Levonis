import { Hono } from 'hono';
import { usdSpendStatement } from '../lib/walletOps';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { requireAuth, requireAdmin, badRequest, notFound, oneOf, str, int, HttpError } from '../lib/http';
import { sha256Hex } from '../lib/crypto';
import { getSetting, setSetting } from '../lib/settings';
import { getLaunchConfig, getTierStatus } from '../lib/entitlements';
import { addMonths, attributeReferral, onProSubscriptionPurchased } from '../lib/membershipOps';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';

export const membershipsRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------- helpers

interface PlanRow {
  id: string;
  tier: 'plus' | 'pro' | 'prime';
  duration_months: number;
  price_iqd: number | null; // NULL = unpriced (NOT purchasable) — never truthiness
  active: number;
  sort: number;
}

interface MembershipDbRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  plan_id: string;
  tier: 'plus' | 'pro' | 'prime';
  state: string;
  duration_months: number;
  price_paid_iqd: number;
  purchased_at: string;
  starts_at: string | null;
  expires_at: string | null;
  source: string;
  wallet_tx_id: string | null;
}

function membershipPublic(m: Record<string, unknown>) {
  return {
    id: m.id,
    plan_id: m.plan_id,
    tier: m.tier,
    state: m.state,
    duration_months: m.duration_months,
    price_paid_iqd: m.price_paid_iqd,
    purchased_at: m.purchased_at,
    starts_at: m.starts_at,
    expires_at: m.expires_at,
    source: m.source,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Referral code: created lazily on first read. 8 hex chars derived from a
 * hash of the user id (attempt counter mixed in on the rare collision),
 * uniqueness-checked against referral_codes.code.
 */
async function ensureReferralCode(db: D1Database, userId: string): Promise<string> {
  const existing = await db.prepare('SELECT code FROM referral_codes WHERE user_id = ?')
    .bind(userId)
    .first<{ code: string }>();
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = (await sha256Hex(`refcode:${userId}:${attempt}`)).slice(0, 8).toUpperCase();
    const taken = await db.prepare('SELECT user_id FROM referral_codes WHERE code = ?').bind(code).first();
    if (taken) continue;
    try {
      await db.prepare('INSERT INTO referral_codes (user_id, code) VALUES (?, ?)').bind(userId, code).run();
      return code;
    } catch {
      // Either a concurrent create for this same user (return theirs) or a
      // code collision race (try the next salted attempt).
      const again = await db.prepare('SELECT code FROM referral_codes WHERE user_id = ?')
        .bind(userId)
        .first<{ code: string }>();
      if (again) return again.code;
    }
  }
  throw new HttpError(500, 'Could not allocate a referral code — please try again');
}

// ------------------------------------------------------------ purchase core

export interface SubscribeResult {
  membership: MembershipDbRow;
  replay: boolean;
  charged_iqd: number;
  charged_usd_cents: number;
  credit_iqd: number;
}

/**
 * Membership purchase — the single implementation used by BOTH
 * POST /api/memberships/subscribe and the legacy /api/subscription/subscribe
 * compatibility route.
 *
 * - Plan must be active AND priced (price_iqd !== null; 0 is a valid explicit
 *   price) — otherwise 400 PLAN_UNPRICED, an honest "not purchasable yet".
 * - Idempotent: the membership id is derived deterministically from
 *   user.id + idempotencyKey; an existing row with that id is returned as a
 *   replay without charging again.
 * - Charge: price converted IQD → USD cents at the current exchangeRate
 *   (Math.ceil so the wallet never undercharges), spent via a conditional
 *   INSERT in the same batch as the membership INSERT — insufficient balance
 *   makes the amount -1, violating CHECK(amount > 0) and aborting atomically.
 * - Launch gating: before the owner activates the launch, purchases are
 *   recorded as prepaid_pending_launch (full duration reserved, clock not
 *   started); after activation they start immediately with expires_at =
 *   addMonths(now, duration_months) (calendar months, month-end clamped).
 * - Upgrade rules preserved from the legacy route: active same-tier → 400;
 *   active PRO buying PLUS → 400; active PLUS buying PRO → proration credit
 *   from the active membership's price_paid_iqd over its remaining days
 *   (only when the new PRO starts immediately, i.e. post-launch — a
 *   pre-launch PRO purchase leaves the running PLUS untouched and reserves
 *   PRO at full price).
 */
export async function subscribeUser(
  env: Env,
  user: SessionUser,
  planId: string,
  idempotencyKey: string
): Promise<SubscribeResult> {
  const db = env.DB;

  const plan = await db.prepare('SELECT * FROM membership_plans WHERE id = ?').bind(planId).first<PlanRow>();
  if (!plan) {
    throw badRequest('خطة العضوية غير موجودة / Membership plan not found', 'PLAN_NOT_FOUND');
  }
  if (!plan.active || plan.price_iqd === null) {
    throw badRequest(
      'هذه الخطة غير متاحة للشراء حاليا — لم يحدد المالك سعرها بعد / This plan is not purchasable yet — the owner has not set its price',
      'PLAN_UNPRICED'
    );
  }

  // Deterministic idempotency: same user + key always maps to the same row.
  const membershipId = 'mem_' + (await sha256Hex(`${user.id}:${idempotencyKey}`)).slice(0, 24);
  const existing = await db.prepare('SELECT * FROM memberships WHERE id = ?')
    .bind(membershipId)
    .first<MembershipDbRow>();
  if (existing) {
    return {
      membership: existing,
      replay: true,
      charged_iqd: Number(existing.price_paid_iqd) || 0,
      charged_usd_cents: 0,
      credit_iqd: 0,
    };
  }

  // Lazily expire overdue rows, then load the current ledger state.
  await getTierStatus(db, user.id);
  const { results: current } = await db
    .prepare("SELECT * FROM memberships WHERE user_id = ? AND state IN ('active','prepaid_pending_launch')")
    .bind(user.id)
    .all<MembershipDbRow>();
  const activeRow = current.find((m) => m.state === 'active');
  const pendingRows = current.filter((m) => m.state === 'prepaid_pending_launch');

  if (activeRow && activeRow.tier === plan.tier) {
    throw badRequest(
      `لديك اشتراك ${plan.tier === 'pro' ? 'PRO' : 'PLUS'} فعال بالفعل — يمكنك التجديد بعد انتهائه / You already have an active ${plan.tier.toUpperCase()} membership — you can re-subscribe when it expires`,
      'ALREADY_SUBSCRIBED'
    );
  }
  if (activeRow && activeRow.tier === 'pro' && plan.tier === 'plus') {
    throw badRequest(
      'أنت مشترك في PRO بالفعل — يمكنك التحويل إلى PLUS بعد انتهائه / You are already on PRO — you can switch to PLUS when it expires',
      'DOWNGRADE_BLOCKED'
    );
  }
  if (pendingRows.some((m) => m.tier === plan.tier)) {
    throw badRequest(
      'لديك بالفعل اشتراك مدفوع مسبقا بانتظار الإطلاق لهذه الفئة / You already have a prepaid membership of this tier awaiting the launch',
      'ALREADY_PREPAID'
    );
  }
  if (pendingRows.some((m) => m.tier === 'pro') && plan.tier === 'plus') {
    throw badRequest(
      'لديك اشتراك PRO مدفوع مسبقا بانتظار الإطلاق / You already have a prepaid PRO membership awaiting the launch',
      'DOWNGRADE_BLOCKED'
    );
  }

  const launch = await getLaunchConfig(db);
  const nowIso = new Date().toISOString();
  const activateNow = launch.activated;

  // PLUS → PRO upgrade proration (post-launch only: the new PRO must start
  // immediately for "remaining days" to mean anything).
  let cost: number = plan.price_iqd;
  let credit = 0;
  const upgradeFromPlus = !!activeRow && activeRow.tier === 'plus' && plan.tier === 'pro' && activateNow;
  if (upgradeFromPlus && activeRow) {
    const nowMs = Date.now();
    const expMs = activeRow.expires_at ? Date.parse(activeRow.expires_at) : NaN;
    const startMs = activeRow.starts_at ? Date.parse(activeRow.starts_at) : NaN;
    if (Number.isFinite(expMs) && Number.isFinite(startMs) && expMs > startMs) {
      const remainingDays = Math.max(0, Math.ceil((expMs - nowMs) / 86_400_000));
      const totalDays = Math.ceil((expMs - startMs) / 86_400_000);
      const paid = Number(activeRow.price_paid_iqd) || 0;
      const perDay = totalDays > 0 ? paid / totalDays : 0;
      credit = Math.min(cost, Math.floor(remainingDays * perDay));
      cost = Math.max(0, cost - credit);
    }
  }

  const exchangeRate = Number(await getSetting(db, 'exchangeRate')) || 1400;
  const chargedUsdCents = cost > 0 ? Math.ceil((cost * 100) / exchangeRate) : 0;

  const state = activateNow ? 'active' : 'prepaid_pending_launch';
  const startsAt = activateNow ? nowIso : null;
  const expiresAt = activateNow ? addMonths(nowIso, plan.duration_months) : null;
  const wtxId = `wtx_${membershipId}`;

  const stmts: D1PreparedStatement[] = [];
  if (chargedUsdCents > 0) {
    // Conditional spend on the SPENDABLE balance — settled minus active holds.
    // This used to test the settled sum alone, so a withdrawal waiting for
    // payout could be spent again on a membership (see usdSpendStatement).
    // An uncovered amount becomes -1, violating CHECK (amount > 0) and
    // aborting the whole batch.
    stmts.push(
      usdSpendStatement(db, {
        txId: wtxId,
        userId: user.id,
        amountCents: chargedUsdCents,
        note:
          `Membership ${plan.tier.toUpperCase()} ${plan.duration_months}mo (${plan.id})` +
          (credit > 0 ? ` — credited ${credit} IQD for remaining PLUS days` : ''),
        ref: membershipId,
        nowIso: nowIso,
      })
    );
  }
  stmts.push(
    db.prepare(
      `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months,
         price_paid_iqd, purchased_at, starts_at, expires_at, source, source_ref, wallet_tx_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'purchase', ?, ?)`
    ).bind(
      membershipId,
      user.id,
      plan.id,
      plan.tier,
      state,
      plan.duration_months,
      cost,
      nowIso,
      startsAt,
      expiresAt,
      chargedUsdCents > 0 ? wtxId : '',
      chargedUsdCents > 0 ? wtxId : null
    )
  );
  if (upgradeFromPlus && activeRow) {
    // The remaining PLUS value was credited toward PRO — end the PLUS row.
    stmts.push(
      db.prepare("UPDATE memberships SET state = 'cancelled' WHERE id = ? AND state = 'active'").bind(activeRow.id)
    );
  }

  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      // Concurrent identical request won the race — return its row as a replay.
      const replayRow = await db.prepare('SELECT * FROM memberships WHERE id = ?')
        .bind(membershipId)
        .first<MembershipDbRow>();
      if (replayRow) {
        return {
          membership: replayRow,
          replay: true,
          charged_iqd: Number(replayRow.price_paid_iqd) || 0,
          charged_usd_cents: 0,
          credit_iqd: 0,
        };
      }
    }
    if (msg.includes('CHECK')) {
      throw badRequest(
        'رصيد المحفظة غير كاف لهذا الاشتراك / Insufficient wallet balance for this membership',
        'INSUFFICIENT_BALANCE'
      );
    }
    console.error('Membership purchase batch failed', msg);
    throw badRequest('تعذر إتمام الاشتراك — حاول مرة أخرى / The purchase could not be completed — please try again');
  }

  // Referral 9.2: reward for a NEW paid PRO subscription (purchase event).
  if (plan.tier === 'pro') {
    try {
      await onProSubscriptionPurchased(env, membershipId, user.id);
    } catch (e) {
      console.error('onProSubscriptionPurchased failed', e); // never blocks the purchase
    }
  }

  // Sync the legacy users.* tier cache.
  await getTierStatus(db, user.id);
  await audit(db, user.id, 'membership.subscribe', membershipId, {
    plan_id: plan.id,
    tier: plan.tier,
    state,
    charged_iqd: cost,
    credit_iqd: credit,
    charged_usd_cents: chargedUsdCents,
  });

  const membership = (await db.prepare('SELECT * FROM memberships WHERE id = ?')
    .bind(membershipId)
    .first<MembershipDbRow>())!;
  return { membership, replay: false, charged_iqd: cost, charged_usd_cents: chargedUsdCents, credit_iqd: credit };
}

// ------------------------------------------------------------ public routes

/** Active plans + purchasability + launch status (public storefront data). */
membershipsRoutes.get('/plans', async (c) => {
  const [{ results }, launch] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, tier, duration_months, price_iqd, sort FROM membership_plans WHERE active = 1 ORDER BY sort, duration_months'
    ).all<PlanRow>(),
    getLaunchConfig(c.env.DB),
  ]);
  return c.json({
    success: true,
    plans: results.map((p) => ({
      id: p.id,
      tier: p.tier,
      duration_months: p.duration_months,
      price_iqd: p.price_iqd, // null = unpriced (honest: not purchasable yet)
      purchasable: p.price_iqd !== null,
      sort: p.sort,
    })),
    launch: { launch_at: launch.launch_at, activated: launch.activated },
  });
});

membershipsRoutes.get('/mine', requireAuth, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;

  const status = await getTierStatus(db, user.id);
  const [{ results: rows }, code, launch] = await Promise.all([
    db.prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .bind(user.id)
      .all<MembershipDbRow>(),
    ensureReferralCode(db, user.id),
    getLaunchConfig(db),
  ]);

  // Lazily promote printer rewards whose 7-day eligibility window has passed.
  await db
    .prepare(
      "UPDATE referral_rewards SET state = 'qualified' WHERE referrer_id = ? AND state = 'pending' AND eligible_at IS NOT NULL AND eligible_at <= ?"
    )
    .bind(user.id, new Date().toISOString())
    .run();
  const { results: rewards } = await db
    .prepare(
      'SELECT id, campaign, state, eligible_at, created_at FROM referral_rewards WHERE referrer_id = ? ORDER BY created_at DESC LIMIT 100'
    )
    .bind(user.id)
    .all<Record<string, unknown>>();

  return c.json({
    success: true,
    status,
    memberships: rows.map(membershipPublic),
    referral: {
      code,
      rewards: rewards.map((r) => ({
        id: r.id,
        campaign: r.campaign,
        state: r.state,
        eligible_at: r.eligible_at,
        created_at: r.created_at,
      })),
    },
    launch: { launch_at: launch.launch_at, activated: launch.activated },
  });
});

membershipsRoutes.post('/subscribe', requireAuth, async (c) => {
  await rateLimit(c, 'subscribe', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const planId = str(body.planId, 'planId', { min: 1, max: 60 });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });

  const r = await subscribeUser(c.env, user, planId, idempotencyKey);
  return c.json({
    success: true,
    replay: r.replay,
    membership: membershipPublic(r.membership),
    charged_iqd: r.charged_iqd,
    charged_usd_cents: r.charged_usd_cents,
    credit_iqd: r.credit_iqd,
  });
});

/**
 * A new user enters a friend's referral code (within 30 days of signup).
 * Attribution is permanent — first code wins, never reassigned.
 */
membershipsRoutes.post('/referral/enter', requireAuth, async (c) => {
  await rateLimit(c, 'referral-enter', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const code = str(body.code, 'code', { min: 4, max: 20 }).toUpperCase();

  const createdMs = Date.parse(user.created_at);
  if (!Number.isFinite(createdMs) || Date.now() - createdMs >= 30 * 86_400_000) {
    throw badRequest(
      'يمكن إدخال رمز الإحالة فقط خلال 30 يوما من إنشاء الحساب / A referral code can only be entered within 30 days of creating your account',
      'REFERRAL_WINDOW_EXPIRED'
    );
  }

  const owner = await c.env.DB.prepare('SELECT user_id FROM referral_codes WHERE code = ?')
    .bind(code)
    .first<{ user_id: string }>();
  if (!owner) {
    throw badRequest('رمز الإحالة غير موجود / Referral code not found', 'CODE_NOT_FOUND');
  }
  if (owner.user_id === user.id) {
    throw badRequest('لا يمكنك استخدام رمز الإحالة الخاص بك / You cannot use your own referral code', 'SELF_REFERRAL');
  }
  const already = await c.env.DB.prepare('SELECT 1 AS x FROM referral_attributions WHERE referred_id = ? LIMIT 1')
    .bind(user.id)
    .first();
  if (already) {
    throw badRequest(
      'تم تسجيل إحالة لهذا الحساب مسبقا / A referral is already recorded for this account',
      'ALREADY_ATTRIBUTED'
    );
  }

  const ok = await attributeReferral(c.env, user.id, code);
  if (!ok) {
    throw badRequest(
      'تم تسجيل إحالة لهذا الحساب مسبقا / A referral is already recorded for this account',
      'ALREADY_ATTRIBUTED'
    );
  }
  await audit(c.env.DB, user.id, 'referral.enter', user.id, { code });
  return c.json({ success: true });
});

// ------------------------------------------------------------- admin routes

membershipsRoutes.use('/admin/*', requireAdmin);

membershipsRoutes.get('/admin/list', async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 30, required: false });
  let sql = `SELECT m.*, u.email AS user_email, u.username AS user_username, u.name AS user_name
               FROM memberships m JOIN users u ON u.id = m.user_id`;
  const params: unknown[] = [];
  if (state) {
    sql += ' WHERE m.state = ?';
    params.push(state);
  }
  sql += ' ORDER BY m.created_at DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  return c.json({
    success: true,
    memberships: results.map((m) => ({
      ...membershipPublic(m),
      user_id: m.user_id,
      user_email: m.user_email,
      user_username: m.user_username,
      user_name: m.user_name,
      source_ref: m.source_ref,
      wallet_tx_id: m.wallet_tx_id,
    })),
  });
});

/** How the owner prices PLUS later: set price_iqd (int, or null = unpriced). */
membershipsRoutes.patch('/admin/plans/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const plan = await c.env.DB.prepare('SELECT * FROM membership_plans WHERE id = ?').bind(id).first<PlanRow>();
  if (!plan) throw notFound('Plan not found');

  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, unknown> = {};

  if ('price_iqd' in body) {
    const price = body.price_iqd === null ? null : int(body.price_iqd, 'price_iqd', { min: 0, max: 1_000_000_000 });
    sets.push('price_iqd = ?');
    params.push(price);
    changes.price_iqd = price;
  }
  if ('active' in body) {
    if (typeof body.active !== 'boolean') throw badRequest('active must be a boolean');
    sets.push('active = ?');
    params.push(body.active ? 1 : 0);
    changes.active = body.active;
  }
  if (sets.length === 0) throw badRequest('Nothing to update — send price_iqd and/or active');

  params.push(id);
  await c.env.DB.prepare(`UPDATE membership_plans SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  await audit(c.env.DB, admin.id, 'membership.plan.update', id, {
    before: { price_iqd: plan.price_iqd, active: !!plan.active },
    after: changes,
  });
  const updated = await c.env.DB.prepare('SELECT * FROM membership_plans WHERE id = ?').bind(id).first<PlanRow>();
  return c.json({
    success: true,
    plan: updated && {
      id: updated.id,
      tier: updated.tier,
      duration_months: updated.duration_months,
      price_iqd: updated.price_iqd,
      purchasable: updated.price_iqd !== null,
      active: !!updated.active,
      sort: updated.sort,
    },
  });
});

/**
 * The owner's explicit, audited launch activation (mandate §8.1). Idempotent:
 * already activated → 200 no-op (it still sweeps any prepaid stragglers left
 * by a crash mid-activation, converting them exactly once).
 */
membershipsRoutes.post('/admin/activate-launch', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== 'ACTIVATE') {
    throw badRequest(
      "Send {\"confirm\":\"ACTIVATE\"} to activate the launch — this starts ALL prepaid memberships",
      'CONFIRM_REQUIRED'
    );
  }

  const db = c.env.DB;
  const launch = await getLaunchConfig(db);
  const already = launch.activated;
  const nowIso = new Date().toISOString();
  const activatedAt = already ? (launch.activated_at ?? nowIso) : nowIso;

  if (!already) {
    await setSetting(db, 'launchConfig', {
      launch_at: launch.launch_at ?? nowIso,
      activated: true,
      activated_at: nowIso,
    });
  }

  // Convert ALL prepaid memberships → active in chunked batches. Conditional
  // on state so a retry (or the straggler sweep) never double-converts.
  const { results: prepaid } = await db
    .prepare("SELECT id, duration_months FROM memberships WHERE state = 'prepaid_pending_launch'")
    .all<{ id: string; duration_months: number }>();
  let converted = 0;
  const affectedUsers = new Set<string>();
  for (const group of chunk(prepaid, 40)) {
    const res = await db.batch(
      group.map((m) =>
        db
          .prepare(
            "UPDATE memberships SET state = 'active', starts_at = ?, expires_at = ? WHERE id = ? AND state = 'prepaid_pending_launch'"
          )
          .bind(activatedAt, addMonths(activatedAt, m.duration_months), m.id)
      )
    );
    for (const r of res) converted += r.meta.changes || 0;
  }
  if (converted > 0) {
    // Refresh the legacy users.* tier cache for the converted memberships.
    const { results: users } = await db
      .prepare("SELECT DISTINCT user_id FROM memberships WHERE state = 'active' AND starts_at = ?")
      .bind(activatedAt)
      .all<{ user_id: string }>();
    for (const u of users) affectedUsers.add(u.user_id);
    for (const uid of affectedUsers) await getTierStatus(db, uid);
  }

  if (!already || converted > 0) {
    await audit(db, admin.id, 'membership.activate_launch', 'launchConfig', {
      already_activated: already,
      converted,
      activated_at: activatedAt,
    });
  }
  return c.json({ success: true, already_activated: already, converted, activated_at: activatedAt });
});

/**
 * Grant a membership without a payment.
 *
 * `memberships.source` has allowed `'admin'` since 0001 and nothing has ever
 * written one. That gap is not cosmetic: until now the ONLY way an account
 * could hold PLUS was to buy it, so an admin could not comp a member whose
 * payment failed, restore a subscription cancelled by mistake, hand a
 * partner an account, or stand up a merchant to test the storefront chain —
 * without moving real money through a real wallet to do it.
 *
 * THIS IS AN ENTITLEMENT, NOT A TRANSACTION. `price_paid_iqd` is 0, no
 * wallet transaction is written, no ledger row moves. What it changes is what
 * the account may DO. That distinction is why this can be used to verify the
 * merchant chain on a live deployment without a financial movement.
 *
 * It respects the launch gate exactly as a purchase does: before launch the
 * grant lands as `prepaid_pending_launch` rather than pretending to be
 * active, because an entitlement that outruns the launch is a different bug
 * from a grant that was never made.
 */
membershipsRoutes.post('/admin/grant', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const userId = str(body.userId, 'userId', { min: 1, max: 60 });
  const planId = str(body.planId, 'planId', { min: 1, max: 60 });
  const reason = str(body.reason, 'reason', { min: 3, max: 300 });
  // Deterministic on the caller's key, so a double-tapped button grants once.
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });

  const db = c.env.DB;
  const target = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId)
    .first<{ id: string; email: string }>();
  if (!target) throw notFound('User not found');

  const plan = await db.prepare('SELECT id, tier, duration_months FROM membership_plans WHERE id = ?')
    .bind(planId)
    .first<{ id: string; tier: 'plus' | 'pro' | 'prime'; duration_months: number }>();
  if (!plan) throw notFound('Plan not found');

  const launch = await getLaunchConfig(db);
  const nowIso = new Date().toISOString();
  const id = `mem_grant_${idempotencyKey}`.slice(0, 60);

  try {
    await db.prepare(
      `INSERT INTO memberships
         (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd,
          purchased_at, starts_at, expires_at, source, source_ref)
       VALUES (?,?,?,?,?,?,0,?,?,?,'admin',?)`
    ).bind(
      id, userId, plan.id, plan.tier,
      launch.activated ? 'active' : 'prepaid_pending_launch',
      plan.duration_months,
      nowIso,
      launch.activated ? nowIso : null,
      launch.activated ? addMonths(nowIso, plan.duration_months) : null,
      `admin:${admin.id}:${reason}`.slice(0, 200)
    ).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The id is derived from the caller's key, so a retry lands here rather
    // than granting a second membership.
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      return c.json({ success: true, replayed: true, membership_id: id });
    }
    throw e;
  }

  // Refresh the cached tier on the user row immediately, so the next request
  // from that account already sees what it may do.
  const tier = await getTierStatus(db, userId);
  await audit(c.env.DB, admin.id, 'admin.membership_granted', id, {
    user: userId, plan: plan.id, tier: plan.tier, reason,
  });

  return c.json({
    success: true,
    replayed: false,
    membership_id: id,
    tier: tier.tier,
    active: tier.active,
    expires_at: tier.expires_at,
    note: launch.activated
      ? 'Granted and active now.'
      : 'Granted, and will activate with the launch — it is not active yet.',
  });
});

membershipsRoutes.post('/admin/:id/cancel', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const refund = body.refund === true;

  const db = c.env.DB;
  const m = await db.prepare('SELECT * FROM memberships WHERE id = ?').bind(id).first<MembershipDbRow>();
  if (!m) throw notFound('Membership not found');
  if (m.state === 'cancelled') return c.json({ success: true, already_cancelled: true, refunded_usd_cents: 0 });
  if (!['active', 'prepaid_pending_launch', 'pending_payment'].includes(m.state)) {
    throw badRequest('Only active, prepaid or pending memberships can be cancelled', 'NOT_CANCELLABLE');
  }

  const flip = await db
    .prepare("UPDATE memberships SET state = 'cancelled' WHERE id = ? AND state = ?")
    .bind(id, m.state)
    .run();
  if (flip.meta.changes === 0) throw badRequest('Membership state changed concurrently — reload and retry', 'CONFLICT_RETRY');

  const nowIso = new Date().toISOString();
  let refundedUsdCents = 0;
  let alreadyRefunded = false;
  if (refund) {
    // Refund exactly what was charged when the original tx is visible;
    // otherwise convert price_paid_iqd at the current rate.
    let cents = 0;
    if (m.wallet_tx_id) {
      const tx = await db
        .prepare("SELECT amount, currency FROM wallet_transactions WHERE id = ? AND type = 'withdrawal'")
        .bind(m.wallet_tx_id)
        .first<{ amount: number; currency: string }>();
      if (tx && tx.currency === 'USD') cents = Number(tx.amount) || 0;
    }
    if (cents === 0 && Number(m.price_paid_iqd) > 0) {
      const rate = Number(await getSetting(db, 'exchangeRate')) || 1400;
      cents = Math.ceil((Number(m.price_paid_iqd) * 100) / rate);
    }
    if (cents > 0) {
      try {
        // Deterministic id — a retried cancel can never double-refund.
        await db
          .prepare(
            `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
             VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, 'system', ?)`
          )
          .bind(`wtx_refund_${id}`, m.user_id, cents, `Refund for cancelled membership ${id}`, id, nowIso)
          .run();
        refundedUsdCents = cents;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) alreadyRefunded = true;
        else throw e;
      }
    }
  }

  // A cancelled PRO purchase also cancels the referral reward it produced.
  const rewardRes = await db
    .prepare(
      "UPDATE referral_rewards SET state = 'cancelled', decided_at = ?, decided_by = ? WHERE campaign = 'pro_sub' AND source_ref = ? AND state <> 'cancelled'"
    )
    .bind(nowIso, admin.id, id)
    .run();

  await getTierStatus(db, m.user_id);
  await audit(db, admin.id, 'membership.cancel', id, {
    user_id: m.user_id,
    prev_state: m.state,
    refund_requested: refund,
    refunded_usd_cents: refundedUsdCents,
    already_refunded: alreadyRefunded,
    referral_rewards_cancelled: rewardRes.meta.changes || 0,
  });
  return c.json({ success: true, refunded_usd_cents: refundedUsdCents, already_refunded: alreadyRefunded });
});

const REWARD_CHAIN = ['pending', 'qualified', 'available', 'reserved', 'fulfilled'] as const;
const REWARD_STATES = [...REWARD_CHAIN, 'cancelled'] as const;

function rewardTransitionAllowed(from: string, to: string): boolean {
  if (to === 'cancelled') return from !== 'cancelled'; // any → cancelled
  const i = REWARD_CHAIN.indexOf(from as (typeof REWARD_CHAIN)[number]);
  const j = REWARD_CHAIN.indexOf(to as (typeof REWARD_CHAIN)[number]);
  return i >= 0 && j === i + 1; // strictly forward, one step at a time
}

membershipsRoutes.get('/admin/referrals', async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 20, required: false });
  let sql = `SELECT r.*, ru.username AS referrer_username, ru.email AS referrer_email,
                    du.username AS referred_username, du.email AS referred_email
               FROM referral_rewards r
               JOIN users ru ON ru.id = r.referrer_id
               JOIN users du ON du.id = r.referred_id`;
  const params: unknown[] = [];
  if (state) {
    sql += ' WHERE r.state = ?';
    params.push(state);
  }
  sql += ' ORDER BY r.created_at DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  return c.json({ success: true, rewards: results });
});

membershipsRoutes.patch('/admin/referrals/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const db = c.env.DB;
  const reward = await db.prepare('SELECT * FROM referral_rewards WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!reward) throw notFound('Referral reward not found');

  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, unknown> = {};

  let newState: string | undefined;
  if (body.state !== undefined && body.state !== reward.state) {
    newState = oneOf(body.state, 'state', REWARD_STATES);
    if (!rewardTransitionAllowed(String(reward.state), newState)) {
      throw badRequest(
        `Invalid transition ${reward.state} → ${newState} (allowed: pending→qualified→available→reserved→fulfilled, any→cancelled)`,
        'INVALID_TRANSITION'
      );
    }
  }

  let spoolProductId: string | undefined;
  if (body.spool_product_id !== undefined) {
    spoolProductId = str(body.spool_product_id, 'spool_product_id', { min: 1, max: 60 });
  }
  if (newState === 'fulfilled') {
    const spool = spoolProductId ?? (reward.spool_product_id ? String(reward.spool_product_id) : '');
    if (!spool) throw badRequest('fulfilled requires spool_product_id (the spool actually granted)', 'SPOOL_REQUIRED');
    spoolProductId = spool;
  }
  if (spoolProductId !== undefined) {
    const product = await db.prepare("SELECT id FROM products WHERE id = ? AND status = 'active'")
      .bind(spoolProductId)
      .first();
    if (!product) throw badRequest('spool_product_id must reference an existing active product', 'SPOOL_INVALID');
    sets.push('spool_product_id = ?');
    params.push(spoolProductId);
    changes.spool_product_id = spoolProductId;
  }
  if (newState !== undefined) {
    sets.push('state = ?', 'decided_at = ?', 'decided_by = ?');
    params.push(newState, new Date().toISOString(), admin.id);
    changes.state = newState;
  }
  if (body.admin_note !== undefined) {
    const note = str(body.admin_note, 'admin_note', { max: 1000, required: false });
    sets.push('admin_note = ?');
    params.push(note);
    changes.admin_note = note;
  }
  if (sets.length === 0) throw badRequest('Nothing to update — send state, admin_note and/or spool_product_id');

  // Conditional on the state we read, so concurrent edits cannot skip steps.
  params.push(id, String(reward.state));
  const res = await db
    .prepare(`UPDATE referral_rewards SET ${sets.join(', ')} WHERE id = ? AND state = ?`)
    .bind(...params)
    .run();
  if (res.meta.changes === 0) throw badRequest('Reward changed concurrently — reload and retry', 'CONFLICT_RETRY');

  await audit(db, admin.id, 'referral.reward.update', id, { before_state: reward.state, ...changes });
  const updated = await db.prepare('SELECT * FROM referral_rewards WHERE id = ?').bind(id).first();
  return c.json({ success: true, reward: updated });
});
