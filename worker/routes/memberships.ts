import { Hono } from 'hono';
import {
  getAvailableBalances,
  readWalletDust,
  usdSpendStatement,
  walletIqdAvailable,
  walletLedgerDinarsReady,
  walletSpendCents,
} from '../lib/walletOps';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { requireAuth, requireAdmin, requireMainHost, badRequest, forbidden, notFound, oneOf, str, int, HttpError } from '../lib/http';
import { canViewFinancials } from '../lib/adminScope';
import { sha256Hex } from '../lib/crypto';
import { getSetting, setSetting, SETTING_DEFAULTS } from '../lib/settings';
import {
  ENTITLEMENT_MINIMUM_TIER,
  dailyRewardMultiplierX100,
  entitlementSnapshot,
  benefits,
  defaultAddressOf,
  getLaunchConfig,
  getTierStatus,
  type LaunchConfig,
  type TierStatus,
  isApprovedDefaultAddress,
} from '../lib/entitlements';
import { bnplEligibility, bnplOutstanding, bnplRepaymentStatement } from '../lib/bnpl';
import { addMonths, attributeReferral, onProSubscriptionPurchased } from '../lib/membershipOps';
import { TIER_RANK } from '../lib/pricing';
import { publicBenefitSummary } from '../lib/membershipBenefits';
import { convertLaunchReservations, countLaunchReservations } from '../lib/launchActivation';
import { audit } from '../lib/audit';
import { emitEvent, eventsEnabled } from '../lib/eventBus';
import { SubscriptionChangedV1 } from '@levonis/contracts/events/v1/SubscriptionChanged';
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

type PaidTier = PlanRow['tier'];

/** Customer-facing name; `prime` remains the compatibility database id. */
export function tierLabel(tier: string): string {
  return tier === 'pro' ? 'PRO' : tier === 'prime' ? 'PREMIUM' : tier === 'plus' ? 'PLUS' : String(tier).toUpperCase();
}

const tierRank = (tier: string): number => TIER_RANK[tier as keyof typeof TIER_RANK] ?? 0;

function planPublic(p: PlanRow) {
  return {
    id: p.id,
    tier: p.tier,
    duration_months: p.duration_months,
    price_iqd: p.price_iqd, // null = unpriced (honest: not purchasable yet)
    purchasable: p.price_iqd !== null,
    // The per-month figure the cards show, computed HERE so nothing shown as
    // a number is worked out in the browser (null while unpriced).
    per_month_iqd: p.price_iqd === null ? null : Math.round(p.price_iqd / Math.max(1, p.duration_months)),
    sort: p.sort,
  };
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
  /** Migration 0052. NULL on rows written before it → price_paid_iqd. */
  credit_basis_iqd: number | null;
  credit_applied_iqd: number;
}

/** The value a row carries into a later upgrade (see migration 0052). */
function creditBasis(m: MembershipDbRow): number {
  const basis = m.credit_basis_iqd === null || m.credit_basis_iqd === undefined ? m.price_paid_iqd : m.credit_basis_iqd;
  return Math.max(0, Number(basis) || 0);
}

const LIVE_STATES = "('active','prepaid_pending_launch')";

/**
 * The INSERT every writer of a live membership row uses. The state column is
 * decided INSIDE the statement: when the account already holds a live row at
 * the moment of writing, the value becomes 'conflict', which the state CHECK
 * refuses — so the whole batch (wallet spend included) rolls back, in the
 * same way usdSpendStatement turns an uncovered amount into -1. Two purchases
 * fired together cannot both pass a SELECT made a moment earlier and both
 * commit; the partial UNIQUE index idx_memberships_one_active is the second
 * lock on the same door for the active state.
 */
function insertLiveMembership(
  db: D1Database,
  p: {
    id: string;
    userId: string;
    planId: string;
    tier: PaidTier;
    state: 'active' | 'prepaid_pending_launch';
    durationMonths: number;
    pricePaidIqd: number;
    creditBasisIqd: number;
    creditAppliedIqd: number;
    purchasedAt: string;
    startsAt: string | null;
    expiresAt: string | null;
    source: 'purchase' | 'admin' | 'gift_printer';
    sourceRef: string;
    walletTxId: string | null;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months,
         price_paid_iqd, credit_basis_iqd, credit_applied_iqd, purchased_at, starts_at, expires_at,
         source, source_ref, wallet_tx_id)
       SELECT ?1, ?2, ?3, ?4,
         CASE WHEN EXISTS (SELECT 1 FROM memberships l WHERE l.user_id = ?2 AND l.state IN ${LIVE_STATES})
              THEN 'conflict' ELSE ?5 END,
         ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15`
    )
    .bind(
      p.id,
      p.userId,
      p.planId,
      p.tier,
      p.state,
      p.durationMonths,
      p.pricePaidIqd,
      p.creditBasisIqd,
      p.creditAppliedIqd,
      p.purchasedAt,
      p.startsAt,
      p.expiresAt,
      p.source,
      p.sourceRef,
      p.walletTxId
    );
}

/** How a failed membership batch is read back — by constraint, not by guess. */
function liveRowConflict(msg: string): boolean {
  // The one-active index names the column; the state guard names the CHECK.
  return (msg.includes('UNIQUE') && msg.includes('memberships.user_id')) || (msg.includes('CHECK') && msg.includes('state IN'));
}
function walletShortfall(msg: string): boolean {
  return msg.includes('CHECK') && (msg.includes('amount') || msg.includes('wallet_transactions'));
}
function idReplay(msg: string): boolean {
  return (msg.includes('UNIQUE') && msg.includes('memberships.id')) || msg.includes('PRIMARY KEY');
}

function concurrentPurchaseWon(): HttpError {
  return new HttpError(
    409,
    'اكتمل شراء آخر على هذا الحساب قبل هذا الطلب — أعد تحميل الصفحة لرؤية عضويتك الحالية / Another purchase on this account was completed first — reload to see your current membership',
    'ALREADY_SUBSCRIBED'
  );
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
  /** The lower tier this purchase upgraded from and ended, when it did. */
  upgraded_from: PaidTier | null;
}

/** A live row this purchase ends, and the credit it contributes. */
export interface EndedRow {
  row: MembershipDbRow;
  credit_iqd: number;
}

/**
 * Everything a purchase would do, computed WITHOUT writing anything — the
 * confirmation window shows exactly this, and subscribeUser then executes
 * exactly this, so the number the customer confirmed is the number charged.
 */
export interface PurchaseQuote {
  plan: PlanRow;
  launch: LaunchConfig;
  /** True after the owner activated the launch: the membership starts now. */
  activate_now: boolean;
  price_iqd: number;
  /** Value of the lower-tier membership(s) this purchase replaces. */
  credit_iqd: number;
  charge_iqd: number;
  exchange_rate: number;
  charge_usd_cents: number;
  /** Preview of the expiry when it starts now; null while it would be reserved. */
  expires_at: string | null;
  /** The live lower-tier rows this purchase ends, each with its credit. */
  ended: EndedRow[];
  /** The highest-tier row among `ended` — what the customer sees as "upgraded from". */
  upgrade_from: MembershipDbRow | null;
}

/** The figures a client confirmed, sent back so a drifted quote is refused. */
export interface ConfirmedFigures {
  charge_iqd: number;
  charge_usd_cents: number;
}

function planUnpurchasable(): HttpError {
  return badRequest(
    'هذه الخطة غير متاحة للشراء حاليا — لم يحدد المالك سعرها بعد / This plan is not purchasable yet — the owner has not set its price',
    'PLAN_UNPRICED'
  );
}

/**
 * ONE MEMBERSHIP AT A TIME. The rules, as data the quote and the purchase
 * share:
 *
 *   same tier active           → ALREADY_SUBSCRIBED (renew when it expires)
 *   higher tier active         → DOWNGRADE_BLOCKED  (PRO→PRIME, PRO→PLUS,
 *                                                     PRIME→PLUS)
 *   lower tier active          → UPGRADE: the unused fraction of the value the
 *                                running plan represents (credit_basis_iqd —
 *                                its price, not the post-credit charge) is
 *                                credited toward the new one and the old row
 *                                is ended — PLUS→PRIME, PLUS→PRO, PRIME→PRO
 *                                alike. The credit needs "remaining days" to
 *                                mean something, so it prorates only when the
 *                                new membership starts now (post-launch).
 *   same tier prepaid          → ALREADY_PREPAID
 *   higher tier prepaid        → DOWNGRADE_BLOCKED
 *   lower tier prepaid         → REPLACED: nothing has started, so the whole
 *                                value of the reservation is credited (100%)
 *                                and the lower row is ended in the same batch
 *                                — one reservation per account, never two.
 *
 * Before the launch an ACTIVE lower row (legacy 'migrated' rows) is left
 * running: the new membership is reserved and starts at the launch, which
 * then supersedes the running row (see the launch activation).
 */
export async function quotePurchase(
  db: D1Database,
  user: SessionUser,
  plan: PlanRow,
  nowIso: string
): Promise<PurchaseQuote> {
  if (!plan.active || plan.price_iqd === null) throw planUnpurchasable();

  // Lazily expire overdue rows, then load the current ledger state.
  await getTierStatus(db, user.id);
  const { results: current } = await db
    .prepare(`SELECT * FROM memberships WHERE user_id = ? AND state IN ${LIVE_STATES}`)
    .bind(user.id)
    .all<MembershipDbRow>();
  const activeRow = current.find((m) => m.state === 'active');
  const pendingRows = current.filter((m) => m.state === 'prepaid_pending_launch');
  const target = tierLabel(plan.tier);

  if (activeRow && activeRow.tier === plan.tier) {
    throw badRequest(
      `لديك اشتراك ${target} فعال بالفعل — يمكنك التجديد بعد انتهائه / You already have an active ${target} membership — you can re-subscribe when it expires`,
      'ALREADY_SUBSCRIBED'
    );
  }
  if (activeRow && tierRank(activeRow.tier) > tierRank(plan.tier)) {
    const held = tierLabel(activeRow.tier);
    throw badRequest(
      `أنت مشترك في ${held} بالفعل — يمكنك التحويل إلى ${target} بعد انتهائه / You are already on ${held} — you can switch to ${target} when it expires`,
      'DOWNGRADE_BLOCKED'
    );
  }
  if (pendingRows.some((m) => m.tier === plan.tier)) {
    throw badRequest(
      `لديك بالفعل اشتراك ${target} مدفوع مسبقا قيد التفعيل / You already have a prepaid ${target} membership being activated`,
      'ALREADY_PREPAID'
    );
  }
  const higherPending = pendingRows.find((m) => tierRank(m.tier) > tierRank(plan.tier));
  if (higherPending) {
    const held = tierLabel(higherPending.tier);
    throw badRequest(
      `لديك اشتراك ${held} مدفوع مسبقا قيد التفعيل — لا يمكن شراء ${target} وهو أدنى منه / You already have a prepaid ${held} membership being activated — ${target} is below it and cannot be bought`,
      'DOWNGRADE_BLOCKED'
    );
  }

  const launch = await getLaunchConfig(db);
  const activateNow = launch.activated;

  const price: number = plan.price_iqd;
  let credit = 0;
  const ended: EndedRow[] = [];

  // Lower → higher upgrade proration (post-launch only: the new membership
  // must start immediately for "remaining days" to mean anything).
  if (activeRow && tierRank(activeRow.tier) < tierRank(plan.tier) && activateNow) {
    const nowMs = Date.parse(nowIso);
    const expMs = activeRow.expires_at ? Date.parse(activeRow.expires_at) : NaN;
    const startMs = activeRow.starts_at ? Date.parse(activeRow.starts_at) : NaN;
    let rowCredit = 0;
    if (Number.isFinite(expMs) && Number.isFinite(startMs) && expMs > startMs) {
      const remainingDays = Math.max(0, Math.ceil((expMs - nowMs) / 86_400_000));
      const totalDays = Math.ceil((expMs - startMs) / 86_400_000);
      const perDay = totalDays > 0 ? creditBasis(activeRow) / totalDays : 0;
      rowCredit = Math.floor(remainingDays * perDay);
    }
    ended.push({ row: activeRow, credit_iqd: rowCredit });
  }
  // Lower prepaid reservations are replaced outright: nothing has started, so
  // their whole value comes back (every one of them, should legacy data hold
  // more than one).
  for (const m of pendingRows) {
    if (tierRank(m.tier) < tierRank(plan.tier)) ended.push({ row: m, credit_iqd: creditBasis(m) });
  }
  // The credit never exceeds the price: a purchase cannot pay the customer.
  let room = price;
  for (const e of ended) {
    e.credit_iqd = Math.min(room, Math.max(0, e.credit_iqd));
    room -= e.credit_iqd;
    credit += e.credit_iqd;
  }
  const cost = Math.max(0, price - credit);
  const upgradeFrom = ended.length
    ? ended.reduce((best, e) => (tierRank(e.row.tier) > tierRank(best.row.tier) ? e : best)).row
    : null;

  const exchangeRate = Number(await getSetting(db, 'exchangeRate')) || 1400;
  /**
   * THE PRICE IS IN DINARS AND THE WALLET PAYS IT IN DINARS — «يضاف كما هو
   * ولكن يحول الى الدولار وليس العكس» (migration 0108).
   *
   * This line ceiled. A membership priced at exactly the customer's displayed
   * dinar balance then asked for one cent MORE than that balance holds — a
   * wallet showing 50,000 د.ع holds 3,571 cents, ceil(5,000,000 / 1,400) is
   * 3,572 — and the purchase was refused with INSUFFICIENT_BALANCE while the
   * wallet page printed a figure that covered it. `walletSpendCents`
   * (worker/lib/walletOps.ts) is the one conversion on the spend side and it
   * floors; the affordability question is asked in dinars, below, against
   * `walletIqdAvailable`.
   *
   * `null` as the cents on hand because THIS function has no balance to cap
   * against and must not pretend to: it states what the charge costs, and the
   * caller that holds the balance caps it.
   */
  const chargedUsdCents = walletSpendCents(cost, null, exchangeRate);

  return {
    plan,
    launch,
    activate_now: activateNow,
    price_iqd: price,
    credit_iqd: credit,
    charge_iqd: cost,
    exchange_rate: exchangeRate,
    charge_usd_cents: chargedUsdCents,
    expires_at: activateNow ? addMonths(nowIso, plan.duration_months) : null,
    ended,
    upgrade_from: upgradeFrom,
  };
}

/**
 * The wallet charge a membership refund is reversing, in BOTH units.
 *
 * `amount_iqd` / `exchange_rate_snapshot` are migration 0108's columns and a
 * Worker can be live ahead of its database, so the shape of the SELECT is
 * decided by `walletLedgerDinarsReady` rather than by a try/catch around a
 * money read: asking for a column that is not there is an error, and an error
 * here would turn a cancel into a failure instead of a refund without dinars.
 */
async function readChargeForRefund(
  db: D1Database,
  txId: string
): Promise<{
  amount: number;
  currency: string;
  amount_iqd: number | null;
  exchange_rate_snapshot: number | null;
} | null> {
  const withDinars = await walletLedgerDinarsReady(db);
  const row = await db
    .prepare(
      withDinars
        ? "SELECT amount, currency, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ? AND type = 'withdrawal'"
        : "SELECT amount, currency FROM wallet_transactions WHERE id = ? AND type = 'withdrawal'"
    )
    .bind(txId)
    .first<{
      amount: number;
      currency: string;
      amount_iqd?: number | null;
      exchange_rate_snapshot?: number | null;
    }>();
  if (!row) return null;
  return {
    amount: Number(row.amount) || 0,
    currency: String(row.currency),
    amount_iqd: (row.amount_iqd as number) ?? null,
    exchange_rate_snapshot: (row.exchange_rate_snapshot as number) ?? null,
  };
}

/**
 * The quote as the API states it — GET /quote and the QUOTE_CHANGED refusal
 * share it.
 *
 * `shortfall_usd_cents` IS COMPUTED IN DINARS AND PRINTED IN DOLLARS, and
 * that is not a cosmetic ordering. The subscription screens disable their
 * button on `shortfall_usd_cents > 0` (src/components/subscription/
 * PurchaseConfirm.tsx, PlanSummary.tsx), so a shortfall computed by comparing
 * a CEILED charge against the cents was the membership half of the owner's
 * report: a wallet the wallet page printed as 50,000 د.ع showed a one-cent
 * shortfall against a 50,000 د.ع membership and the confirm button stayed
 * dead. The price and the balance are both dinar figures — «يضاف كما هو ولكن
 * يحول الى الدولار وليس العكس» — so they are subtracted as dinars, by the one
 * rule in migration 0108, and only the presentation is converted.
 *
 * `balanceIqd` is what `walletIqdAvailable` returned for this customer. A
 * caller that genuinely has no balance (there is none today) may pass 0, and
 * the screen then reports the whole price as the shortfall, which is what a
 * balance of nothing means.
 */
export function quotePayload(q: PurchaseQuote, balanceUsdCents: number, balanceIqd: number) {
  const shortfallIqd = Math.max(0, q.charge_iqd - (Number(balanceIqd) || 0));
  return {
    ok: true as const,
    plan: planPublic(q.plan),
    price_iqd: q.price_iqd,
    credit_iqd: q.credit_iqd,
    charge_iqd: q.charge_iqd,
    exchange_rate: q.exchange_rate,
    charge_usd_cents: q.charge_usd_cents,
    balance_usd_cents: balanceUsdCents,
    balance_iqd: Number(balanceIqd) || 0,
    shortfall_iqd: shortfallIqd,
    // A shortfall of a few dinars must not FLOOR to "nothing missing" — that
    // is the client's enable condition, and it would put the button back where
    // this whole change found it.
    shortfall_usd_cents: shortfallIqd > 0 ? Math.max(1, walletSpendCents(shortfallIqd, null, q.exchange_rate)) : 0,
    activate_now: q.activate_now,
    launch_at: q.launch.launch_at,
    expires_at: q.expires_at,
    upgrade_from_tier: q.upgrade_from ? q.upgrade_from.tier : null,
    // Always empty since one reservation per account became the rule — kept
    // so a page loaded before this change still renders its (empty) note.
    pending_tiers: [] as PaidTier[],
  };
}

/**
 * A replayed purchase tells the same story as the first: the charge from the
 * row, the credit it consumed (credit_applied_iqd, migration 0052) and the
 * wallet debit from the transaction the row points at.
 */
async function replayResult(db: D1Database, row: MembershipDbRow): Promise<SubscribeResult> {
  let chargedUsdCents = 0;
  if (row.wallet_tx_id) {
    const tx = await db
      .prepare("SELECT amount FROM wallet_transactions WHERE id = ? AND type = 'withdrawal' AND currency = 'USD'")
      .bind(row.wallet_tx_id)
      .first<{ amount: number }>();
    chargedUsdCents = Number(tx?.amount) || 0;
  }
  return {
    membership: row,
    replay: true,
    charged_iqd: Number(row.price_paid_iqd) || 0,
    charged_usd_cents: chargedUsdCents,
    credit_iqd: Number(row.credit_applied_iqd) || 0,
    upgraded_from: null,
  };
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
 * - Confirmed figures: when the client sends the charge it displayed
 *   (`confirmed`), the recomputed charge must match it exactly; otherwise
 *   409 QUOTE_CHANGED carries the fresh quote and nothing is written. A
 *   client that sends no figures (older pages) is charged the recomputed
 *   quote as before.
 * - One live row: the batch cancels the rows the quote ends BEFORE it inserts
 *   the new one, and the INSERT itself refuses when the account holds any
 *   other live row at that instant (insertLiveMembership) — so of two
 *   purchases racing, exactly one commits and the other is 409
 *   ALREADY_SUBSCRIBED with its wallet spend rolled back.
 * - Launch gating: before the owner activates the launch, purchases are
 *   recorded as prepaid_pending_launch (full duration reserved, clock not
 *   started); after activation they start immediately with expires_at =
 *   addMonths(now, duration_months) (calendar months, month-end clamped).
 * - Tier rules: see quotePurchase — one membership at a time, lower→higher
 *   is a prorated upgrade that ends the old row, higher→lower is refused.
 */
export async function subscribeUser(
  env: Env,
  user: SessionUser,
  planId: string,
  idempotencyKey: string,
  confirmed: ConfirmedFigures | null = null
): Promise<SubscribeResult> {
  const db = env.DB;

  const plan = await db.prepare('SELECT * FROM membership_plans WHERE id = ?').bind(planId).first<PlanRow>();
  if (!plan) {
    throw badRequest('خطة العضوية غير موجودة / Membership plan not found', 'PLAN_NOT_FOUND');
  }
  if (!plan.active || plan.price_iqd === null) throw planUnpurchasable();

  // Deterministic idempotency: same user + key always maps to the same row.
  const membershipId = 'mem_' + (await sha256Hex(`${user.id}:${idempotencyKey}`)).slice(0, 24);
  const existing = await db.prepare('SELECT * FROM memberships WHERE id = ?')
    .bind(membershipId)
    .first<MembershipDbRow>();
  if (existing) return replayResult(db, existing);

  const nowIso = new Date().toISOString();
  const q = await quotePurchase(db, user, plan, nowIso);
  if (confirmed && (confirmed.charge_iqd !== q.charge_iqd || confirmed.charge_usd_cents !== q.charge_usd_cents)) {
    // A day boundary moved the remaining days, or the exchange rate changed,
    // between the quote the customer read and this confirmation. Never charge
    // a figure nobody saw: hand back the fresh quote instead.
    const balances = await getAvailableBalances(env, user.id);
    throw new HttpError(
      409,
      'تغير السعر أو سعر الصرف منذ عرض الملخص — راجع الأرقام الجديدة ثم أكد مرة أخرى / The price or exchange rate changed since the summary was shown — review the new figures and confirm again',
      'QUOTE_CHANGED',
      {
        quote: quotePayload(
          q,
          balances.usd_cents_available,
          walletIqdAvailable(
            balances.usd_cents_available,
            (await readWalletDust(db, user.id)).dust_iqd,
            q.exchange_rate
          )
        ),
      }
    );
  }
  const cost = q.charge_iqd;
  const credit = q.credit_iqd;
  const upgradeFrom = q.upgrade_from;
  /**
   * CAN THIS WALLET PAY THIS PRICE? ASKED IN DINARS, WHICH IS THE UNIT THE
   * PRICE IS QUOTED IN — «يضاف كما هو ولكن يحول الى الدولار وليس العكس».
   *
   * The question used to be asked only by `usdSpendStatement`'s own CHECK, in
   * CENTS, against a charge that had been CEILED: a membership priced at
   * exactly the customer's displayed balance asked for one cent more than the
   * wallet held and was refused, while the wallet page printed a figure that
   * covered it. Both halves are fixed here — the charge floors
   * (`quotePurchase`) and the comparison is `walletIqdAvailable`, the same
   * function GET /api/wallet, the checkout and the store quote all read.
   *
   * THE CENTS GUARD IS NOT REPLACED, ONLY PRECEDED. This read-then-cap is the
   * affordability ANSWER; `usdSpendStatement`'s `CASE … ELSE -1` is still the
   * only thing that decides whether the money may move, and a balance that
   * fell between this read and that write still aborts the batch and is still
   * reported as INSUFFICIENT_BALANCE by the catch below.
   */
  const [walletBalances, walletDust] = await Promise.all([
    getAvailableBalances(env, user.id),
    readWalletDust(db, user.id),
  ]);
  const walletBalanceIqd = walletIqdAvailable(
    walletBalances.usd_cents_available,
    walletDust.dust_iqd,
    q.exchange_rate
  );
  if (cost > walletBalanceIqd) {
    throw badRequest(
      'رصيد المحفظة غير كاف لهذا الاشتراك / Insufficient wallet balance for this membership',
      'INSUFFICIENT_BALANCE'
    );
  }
  /**
   * A PRICE BELOW ONE CENT'S WORTH STILL HAS TO MOVE MONEY.
   *
   * `walletSpendCents` floors, so a charge under 14 د.ع (at 1,400) converts to
   * zero cents — and `CHECK (amount > 0)` on `wallet_transactions` means a
   * zero-cent debit cannot be written at all. On the platform checkout that is
   * answered by the wallet paying nothing and the customer owing the few
   * dinars at the door. HERE THERE IS NO DOOR: the wallet is the only payment
   * method on this path, so "no ledger row" would mean "granted free". The
   * charge is therefore floored to a minimum of one cent, which the balance
   * check above guarantees is there (a positive dinar balance needs at least
   * one cent behind it). The customer pays at most one cent — 13 د.ع — more
   * than the quoted dinars, once, on a price smaller than that.
   */
  const chargedUsdCents =
    cost > 0 ? Math.max(1, walletSpendCents(cost, walletBalances.usd_cents_available, q.exchange_rate)) : 0;

  const state = q.activate_now ? 'active' : 'prepaid_pending_launch';
  const startsAt = q.activate_now ? nowIso : null;
  const expiresAt = q.expires_at;
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
          `Membership ${tierLabel(plan.tier)} ${plan.duration_months}mo (${plan.id})` +
          (credit > 0 && upgradeFrom ? ` — credited ${credit} IQD for remaining ${tierLabel(upgradeFrom.tier)} days` : ''),
        ref: membershipId,
        nowIso: nowIso,
        /**
         * THE DINARS THIS CHARGE WAS QUOTED IN (migration 0108). The customer
         * was shown `cost` DINARS and the cents above are what that figure
         * floors to, so recording the pair is what makes the balance fall by
         * the price on the screen instead of by its conversion — and what
         * lets the cancel refund below give back exactly what was taken.
         *
         * Only when the database can hold it: `readWalletDust` above already
         * probed those columns, so a Worker live ahead of its migration
         * writes the row exactly as it always did instead of aborting a money
         * batch.
         */
        amountIqd: walletDust.ledger_dinars ? cost : null,
        exchangeRateSnapshot: walletDust.ledger_dinars ? q.exchange_rate : null,
      })
    );
  }
  // The rows whose value was credited toward the new tier are ended FIRST,
  // conditional on the state the quote read, so the account holds exactly one
  // membership when the new row lands — and the INSERT below refuses if it
  // does not (the cancel matched nothing because a concurrent purchase, an
  // admin or an expiry got there first, or another live row appeared).
  for (const e of q.ended) {
    stmts.push(
      db.prepare("UPDATE memberships SET state = 'cancelled' WHERE id = ? AND state = ?").bind(e.row.id, e.row.state)
    );
  }
  stmts.push(
    insertLiveMembership(db, {
      id: membershipId,
      userId: user.id,
      planId: plan.id,
      tier: plan.tier,
      state,
      durationMonths: plan.duration_months,
      pricePaidIqd: cost,
      creditBasisIqd: cost + credit,
      creditAppliedIqd: credit,
      purchasedAt: nowIso,
      startsAt,
      expiresAt,
      source: 'purchase',
      sourceRef: chargedUsdCents > 0 ? wtxId : '',
      walletTxId: chargedUsdCents > 0 ? wtxId : null,
    })
  );

  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (idReplay(msg)) {
      // Concurrent identical request won the race — return its row as a replay.
      const replayRow = await db.prepare('SELECT * FROM memberships WHERE id = ?')
        .bind(membershipId)
        .first<MembershipDbRow>();
      if (replayRow) return replayResult(db, replayRow);
    }
    if (liveRowConflict(msg)) throw concurrentPurchaseWon();
    if (walletShortfall(msg)) {
      throw badRequest(
        'رصيد المحفظة غير كاف لهذا الاشتراك / Insufficient wallet balance for this membership',
        'INSUFFICIENT_BALANCE'
      );
    }
    if (msg.includes('CHECK')) {
      // A CHECK whose text this code does not recognise: decide by the facts
      // rather than by the wording of the error.
      const balances = await getAvailableBalances(env, user.id);
      if (balances.usd_cents_available < chargedUsdCents) {
        throw badRequest(
          'رصيد المحفظة غير كاف لهذا الاشتراك / Insufficient wallet balance for this membership',
          'INSUFFICIENT_BALANCE'
        );
      }
      throw concurrentPurchaseWon();
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
    credit_basis_iqd: cost + credit,
    charged_usd_cents: chargedUsdCents,
    upgraded_from: upgradeFrom ? { id: upgradeFrom.id, tier: upgradeFrom.tier } : null,
    ended: q.ended.map((e) => ({ id: e.row.id, tier: e.row.tier, state: e.row.state, credit_iqd: e.credit_iqd })),
  });

  const membership = (await db.prepare('SELECT * FROM memberships WHERE id = ?')
    .bind(membershipId)
    .first<MembershipDbRow>())!;

  // `SubscriptionChanged` (03-EVENTS.md §3.16) — read off the row that was
  // actually written, so a purchase that landed in `conflict` (the INSERT's
  // one-live-membership guard) publishes nothing. Identity's consumer, which
  // owns the `users.membership_tier` copy, is added in Phase 6b.
  if (eventsEnabled(env) && membership.state !== 'conflict') {
    await emitEvent(
      db,
      SubscriptionChangedV1,
      {
        user_id: user.id,
        from_tier: upgradeFrom ? upgradeFrom.tier : null,
        to_tier: plan.tier,
        plan_id: plan.id,
        membership_id: membershipId,
        active: membership.state === 'active',
        expires_at: expiresAt ?? null,
        reason: 'purchased',
      },
      { aggregateId: user.id, actorId: user.id }
    );
  }

  return {
    membership,
    replay: false,
    charged_iqd: cost,
    charged_usd_cents: chargedUsdCents,
    credit_iqd: credit,
    upgraded_from: upgradeFrom ? upgradeFrom.tier : null,
  };
}

// ------------------------------------------------------------ public routes

/** A stored threshold, or the shipped default when the setting is partial. */
function thresholdOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
}

function statusForTier(tier: PaidTier): TierStatus {
  return { tier, active: true, expires_at: null, pending_launch: null, gated_benefits: [] };
}

function entitlementsForTier(tier: PaidTier) {
  return entitlementSnapshot(statusForTier(tier));
}

/**
 * Active plans + purchasability + launch status (public storefront data).
 *
 * `features` says which CONDITIONAL perks are switched on right now, read
 * from the very settings the checkout consults (printerGiftConfig,
 * preorderGiftConfig) — the page shows a gift only when this says so, never
 * from copy. `delivery` carries the free-delivery thresholds from the same
 * shippingPolicy the quote engine applies, so the benefit text can never
 * drift from the rule.
 */
membershipsRoutes.get('/plans', async (c) => {
  const db = c.env.DB;
  const [{ results }, launch, preorderGift, shippingPolicy, benefits] = await Promise.all([
    db.prepare(
      'SELECT id, tier, duration_months, price_iqd, active, sort FROM membership_plans WHERE active = 1 ORDER BY sort, duration_months'
    ).all<PlanRow>(),
    getLaunchConfig(db),
    getSetting(db, 'preorderGiftConfig'),
    getSetting(db, 'shippingPolicy'),
    publicBenefitSummary(db, new Date().toISOString()),
  ]);

  const policy = (shippingPolicy && typeof shippingPolicy === 'object' ? shippingPolicy : {}) as Record<string, unknown>;

  return c.json({
    success: true,
    plans: results.map(planPublic),
    launch: { launch_at: launch.launch_at, activated: launch.activated },
    features: {
      /**
       * ALWAYS FALSE, AND KEPT ONLY SO A PAGE LOADED BEFORE THIS DEPLOY READS
       * A BOOLEAN. The PLUS-with-a-printer gift is granted BY HAND now:
       * `grantPrinterGiftIfEligible` has had no caller since the order
       * pipeline stopped granting it, so `printerGiftConfig.enabled` had
       * become a switch that advertised a gift nothing gave. A promise the
       * store makes manually, case by case, is not a benefit of the card.
       */
      printer_gift: false,
      preorder_gift: !!(preorderGift.enabled && typeof preorderGift.product_id === 'string' && preorderGift.product_id),
    },
    delivery: {
      pro_threshold_iqd: thresholdOr(policy.pro_threshold_iqd, SETTING_DEFAULTS.shippingPolicy.pro_threshold_iqd),
      prime_threshold_iqd: thresholdOr(policy.prime_threshold_iqd, SETTING_DEFAULTS.shippingPolicy.prime_threshold_iqd),
    },
    /**
     * §22 — THE SHOPPING BENEFITS AS CONFIGURED RIGHT NOW.
     *
     * The subscription page states these instead of shipping its own copy.
     * A percentage written into a React string is a promise nobody can keep:
     * the owner lowers it in the admin, the page keeps advertising the old
     * number, and the customer discovers the difference at the checkout.
     */
    benefits,
    entitlement_contract: {
      minimum_tier: ENTITLEMENT_MINIMUM_TIER,
      tiers: {
        plus: entitlementsForTier('plus'),
        prime: entitlementsForTier('prime'),
        pro: entitlementsForTier('pro'),
      },
    },
    /**
     * The daily check-in multiplier each tier earns, in hundredths — from
     * `dailyRewardMultiplierX100`, the function the check-in itself calls, so
     * the comparison's «×1.5» / «×2» is the server's figure and not a copy.
     */
    points_multiplier_x100: {
      plus: dailyRewardMultiplierX100(statusForTier('plus')),
      prime: dailyRewardMultiplierX100(statusForTier('prime')),
      pro: dailyRewardMultiplierX100(statusForTier('pro')),
    },
  });
});

/**
 * What buying a plan would do for THIS account, before it is done: the exact
 * IQD price, any upgrade credit, the USD debit at today's rate, the spendable
 * balance and the shortfall, and whether it starts now or is reserved until
 * the launch. Refusals (already subscribed, downgrade, prepaid) come back as
 * `ok: false` with the same code and message the purchase would give, so the
 * confirmation window can say so before anyone taps Confirm. Nothing is
 * written.
 */
membershipsRoutes.get('/quote', requireAuth, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const planId = str(c.req.query('planId'), 'planId', { min: 1, max: 60 });
  const plan = await db.prepare('SELECT * FROM membership_plans WHERE id = ?').bind(planId).first<PlanRow>();
  // An inactive plan is not on sale and GET /plans does not list it — the
  // quote must not hand out its price inside a refusal either.
  if (!plan || !plan.active) throw notFound('Plan not found');

  const nowIso = new Date().toISOString();
  let q: PurchaseQuote;
  try {
    q = await quotePurchase(db, user, plan, nowIso);
  } catch (e) {
    if (e instanceof HttpError && e.status === 400) {
      return c.json({
        success: true,
        quote: { ok: false, code: e.code ?? 'REFUSED', message: e.message, plan: planPublic(plan) },
      });
    }
    throw e;
  }
  const [balances, dust] = await Promise.all([
    getAvailableBalances(c.env, user.id),
    readWalletDust(c.env.DB, user.id),
  ]);
  return c.json({
    success: true,
    quote: quotePayload(
      q,
      balances.usd_cents_available,
      walletIqdAvailable(balances.usd_cents_available, dust.dust_iqd, q.exchange_rate)
    ),
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
    entitlements: entitlementSnapshot(status),
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

/**
 * A small authenticated capability endpoint for clients that do not need the
 * membership ledger.  The request has no tier parameter by design: the
 * server resolves the live membership and expiry every time.
 */
membershipsRoutes.get('/entitlements', requireAuth, async (c) => {
  const user = c.get('user')!;
  const status = await getTierStatus(c.env.DB, user.id);
  return c.json({ success: true, status, entitlements: entitlementSnapshot(status) });
});

membershipsRoutes.get('/bnpl', requireAuth, async (c) => {
  const user = c.get('user')!;
  const [eligibility, { results: ledger }] = await Promise.all([
    bnplEligibility(c.env.DB, user.id),
    c.env.DB
      .prepare(
        `SELECT id, order_id, kind, amount_iqd, due_at, note, created_at
           FROM bnpl_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
      )
      .bind(user.id)
      .all<Record<string, unknown>>(),
  ]);
  return c.json({ success: true, eligibility, ledger });
});

/** A PRO member asks staff to approve a credit line; approval remains manual. */
membershipsRoutes.post('/bnpl/request', requireAuth, async (c) => {
  await rateLimit(c, 'bnpl-request', 3, 86_400);
  const user = c.get('user')!;
  const [status, identity, address] = await Promise.all([
    getTierStatus(c.env.DB, user.id),
    c.env.DB
      .prepare("SELECT id FROM kyc_cases WHERE user_id = ? AND state = 'verified' LIMIT 1")
      .bind(user.id)
      .first(),
    defaultAddressOf(c.env.DB, user.id),
  ]);
  if (!benefits.bnpl(status)) throw badRequest('An active PRO membership is required for BNPL', 'PRO_REQUIRED');
  if (!identity) throw badRequest('Verified identity is required before requesting BNPL', 'IDENTITY_VERIFICATION_REQUIRED');
  if (!address || !(await isApprovedDefaultAddress(c.env.DB, user.id, address))) {
    throw badRequest('Your approved default address is required before requesting BNPL', 'APPROVED_ADDRESS_REQUIRED');
  }
  await c.env.DB
    .prepare(
      `INSERT INTO bnpl_accounts (user_id, state, credit_limit_iqd)
       VALUES (?, 'requested', 0)
       ON CONFLICT(user_id) DO UPDATE SET state = CASE
         WHEN bnpl_accounts.state = 'approved' THEN 'approved' ELSE 'requested' END`
    )
    .bind(user.id)
    .run();
  const eligibility = await bnplEligibility(c.env.DB, user.id, address);
  return c.json({ success: true, eligibility });
});

/** Wallet repayment. It remains available after expiry/cancellation by design. */
membershipsRoutes.post('/bnpl/repay', requireAuth, async (c) => {
  await rateLimit(c, 'bnpl-repay', 20, 86_400);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const amountIqd = int(body.amount_iqd, 'amount_iqd', { min: 1, max: 1_000_000_000 });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  const ledgerKey = `repayment:${user.id}:${idempotencyKey}`;
  const existing = await c.env.DB
    .prepare('SELECT id FROM bnpl_ledger WHERE idempotency_key = ? AND user_id = ?')
    .bind(ledgerKey, user.id)
    .first();
  if (existing) return c.json({ success: true, replay: true, outstanding_iqd: await bnplOutstanding(c.env.DB, user.id) });

  const outstanding = await bnplOutstanding(c.env.DB, user.id);
  if (amountIqd > outstanding) throw badRequest('Repayment cannot exceed the outstanding balance', 'BNPL_REPAYMENT_EXCEEDS_DEBT');
  const rate = Number(await getSetting(c.env.DB, 'exchangeRate')) || 1400;
  /**
   * A REPAYMENT IS A DINAR DEBT PAID FROM A DINAR BALANCE — «يضاف كما هو ولكن
   * يحول الى الدولار وليس العكس» (migration 0108).
   *
   * `iqdToUsdCents` stood here and CEILS, so repaying exactly the balance the
   * wallet page printed asked for one cent more than the wallet held and the
   * batch aborted as BNPL_REPAYMENT_CONFLICT — a refusal about rounding
   * wearing the words of a race. `walletSpendCents` floors and caps, the
   * affordability question is asked in dinars, and the dinars are recorded on
   * the debit so the balance falls by the figure the customer typed.
   */
  const [walletBalances, walletDust] = await Promise.all([
    getAvailableBalances(c.env, user.id),
    readWalletDust(c.env.DB, user.id),
  ]);
  const walletBalanceIqd = walletIqdAvailable(
    walletBalances.usd_cents_available,
    walletDust.dust_iqd,
    rate
  );
  if (amountIqd > walletBalanceIqd) {
    throw badRequest('رصيد المحفظة غير كاف لهذه الدفعة / Insufficient wallet balance for this repayment', 'INSUFFICIENT_BALANCE');
  }
  // The same minimum one cent the membership purchase takes, and for the same
  // reason: a repayment that writes no ledger row would clear debt for free.
  const walletCents = Math.max(1, walletSpendCents(amountIqd, walletBalances.usd_cents_available, rate));
  const now = new Date().toISOString();
  try {
    await c.env.DB.batch([
      usdSpendStatement(c.env.DB, {
        txId: `wtx_bnpl_${await sha256Hex(`${user.id}:${idempotencyKey}`)}`,
        userId: user.id,
        amountCents: walletCents,
        note: 'BNPL repayment',
        ref: ledgerKey,
        nowIso: now,
        // The dinars the customer typed (migration 0108), so the balance falls
        // by the repayment and not by its conversion.
        amountIqd: walletDust.ledger_dinars ? amountIqd : null,
        exchangeRateSnapshot: walletDust.ledger_dinars ? rate : null,
      }),
      bnplRepaymentStatement(c.env.DB, { userId: user.id, amountIqd, idempotencyKey, createdAt: now }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const replay = await c.env.DB
      .prepare('SELECT id FROM bnpl_ledger WHERE idempotency_key = ? AND user_id = ?')
      .bind(ledgerKey, user.id)
      .first();
    if (replay) {
      // A concurrent identical request won. Its wallet debit and ledger row
      // are the one result; do not write a second audit record or describe
      // this retry as a new repayment.
      return c.json({ success: true, replay: true, outstanding_iqd: await bnplOutstanding(c.env.DB, user.id) });
    }
    if (/CHECK|BNPL_REPAYMENT/i.test(message)) {
      throw badRequest('Balance or debt changed; refresh and try again', 'BNPL_REPAYMENT_CONFLICT');
    }
    throw error;
  }
  await audit(c.env.DB, user.id, 'bnpl.repayment', user.id, { amount_iqd: amountIqd, wallet_usd_cents: walletCents });
  return c.json({ success: true, replay: false, outstanding_iqd: await bnplOutstanding(c.env.DB, user.id) });
});

membershipsRoutes.post('/subscribe', requireAuth, async (c) => {
  await rateLimit(c, 'subscribe', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const planId = str(body.planId, 'planId', { min: 1, max: 60 });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  // The figures the page displayed, when it sends them: the charge must still
  // be exactly these or the purchase is refused with the fresh quote
  // (409 QUOTE_CHANGED). Older clients send none and are charged the quote.
  let confirmed: ConfirmedFigures | null = null;
  if (body.charge_iqd !== undefined || body.charge_usd_cents !== undefined) {
    confirmed = {
      charge_iqd: int(body.charge_iqd, 'charge_iqd', { min: 0, max: 1_000_000_000 }),
      charge_usd_cents: int(body.charge_usd_cents, 'charge_usd_cents', { min: 0, max: 1_000_000_000 }),
    };
  }

  const r = await subscribeUser(c.env, user, planId, idempotencyKey, confirmed);
  return c.json({
    success: true,
    replay: r.replay,
    membership: membershipPublic(r.membership),
    charged_iqd: r.charged_iqd,
    charged_usd_cents: r.charged_usd_cents,
    credit_iqd: r.credit_iqd,
    upgraded_from: r.upgraded_from,
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

// The memberships admin surface lives under /api/memberships, OUTSIDE the
// /api/admin/* host guard in worker/index.ts — so it carries its own: main
// host only, then admin. A merchant subdomain page never reaches it, even
// with a visiting admin's shared cookie (the same pattern as devices.ts).
membershipsRoutes.use('/admin/*', requireMainHost, requireAdmin);

/** Approve/suspend a PRO BNPL line. No client membership label is accepted. */
membershipsRoutes.put('/admin/bnpl/:userId', async (c) => {
  const admin = c.get('user')!;
  /**
   * SETTING A CREDIT LIMIT IS A FINANCIAL DECISION, AND THIS ROUTE CARRIED NO
   * FINANCIAL GUARD.
   *
   * `requireAdmin` above is a role check; it is satisfied by the restricted
   * assistant admin whom §11 will not even show a cost. That admin could
   * therefore hand a member a line of credit, or suspend one, on a screen that
   * is not allowed to tell them how big it is — and the write is an UPSERT, so
   * a suspend issued without the figure in hand writes the member's approved
   * line down to 0 as a side effect.
   *
   * A user interface that stops OFFERING the control is not this boundary: the
   * request can still be sent. The boundary has to be here, in the handler.
   */
  if (!canViewFinancials(c.env, admin)) {
    throw forbidden('Setting a credit limit is a financial decision / تحديد سقف الائتمان قرار مالي');
  }
  const userId = str(c.req.param('userId'), 'userId', { min: 1, max: 80 });
  const body = await c.req.json().catch(() => ({}));
  const state = oneOf(body.state, 'state', ['requested', 'approved', 'suspended'] as const);
  const creditLimit = int(body.credit_limit_iqd, 'credit_limit_iqd', {
    min: state === 'approved' ? 1 : 0,
    max: 1_000_000_000,
    def: 0,
  });
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw notFound('User not found');

  if (state === 'approved') {
    const [status, identity, address] = await Promise.all([
      getTierStatus(c.env.DB, userId),
      c.env.DB.prepare("SELECT id FROM kyc_cases WHERE user_id = ? AND state = 'verified' LIMIT 1").bind(userId).first(),
      defaultAddressOf(c.env.DB, userId),
    ]);
    if (!benefits.bnpl(status)) throw badRequest('Only an active PRO member can receive a BNPL limit', 'PRO_REQUIRED');
    if (!identity) throw badRequest('Identity verification is required', 'IDENTITY_VERIFICATION_REQUIRED');
    if (!address || !(await isApprovedDefaultAddress(c.env.DB, userId, address))) {
      throw badRequest('An approved default address is required', 'APPROVED_ADDRESS_REQUIRED');
    }
  }

  await c.env.DB
    .prepare(
      `INSERT INTO bnpl_accounts (user_id, state, credit_limit_iqd, approved_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         state = excluded.state,
         credit_limit_iqd = excluded.credit_limit_iqd,
         approved_by = excluded.approved_by`
    )
    .bind(userId, state, creditLimit, admin.id)
    .run();
  await audit(c.env.DB, admin.id, 'bnpl.account_update', userId, { state, credit_limit_iqd: creditLimit });
  return c.json({ success: true, eligibility: await bnplEligibility(c.env.DB, userId) });
});

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

/** Every plan, active or not, for the admin Memberships panel. */
membershipsRoutes.get('/admin/plans', async (c) => {
  const [{ results }, launch, reservations] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM membership_plans ORDER BY sort, duration_months').all<PlanRow>(),
    getLaunchConfig(c.env.DB),
    countLaunchReservations(c.env.DB),
  ]);
  return c.json({
    success: true,
    plans: results.map((p) => ({ ...planPublic(p), active: !!p.active })),
    launch,
    // Reservations still waiting. After the launch they are converted as each
    // account is read; this is what the panel's leftover sweep would start.
    prepaid_count: reservations.waiting,
    // Reservations the sweep will never start (the account runs a higher
    // tier) — a refund or a cancel by hand, not a button press.
    deferred_count: reservations.deferred,
  });
});

/** How the owner prices a plan: set price_iqd (int, or null = unpriced) and/or active. */
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
 * The owner's explicit, audited launch activation (mandate §8.1), and the
 * sweep for anything left waiting after it. Idempotent: already activated →
 * 200, and it still converts every reservation that exists — a straggler
 * written by a legacy or racing writer, or an account nobody has opened since
 * the deploy. The panel keeps the button enabled while `prepaid_count` > 0.
 *
 * The conversion itself — one active row per account, highest tier wins, a
 * lower running row superseded, a higher running row left alone and audited —
 * is `convertLaunchReservations` (worker/lib/launchActivation.ts), the same
 * function `getTierStatus` runs for one account on read, so the button and
 * the automatic path can never disagree. Every row starts NOW: a straggler
 * swept a week after the launch used to be backdated to it and lose the week.
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
  // A row that says `activated` is the only proof the owner's launch was
  // recorded; the code default being "live" does not write one.
  const stored = await db.prepare("SELECT 1 AS x FROM admin_settings WHERE key = 'launchConfig'").first();
  const already = launch.activated && !!stored;
  const nowIso = new Date().toISOString();
  const activatedAt = already ? (launch.activated_at ?? nowIso) : nowIso;

  if (!already) {
    await setSetting(db, 'launchConfig', {
      launch_at: launch.launch_at ?? nowIso,
      activated: true,
      activated_at: nowIso,
    });
  }

  const { converted, deferred, affectedUsers } = await convertLaunchReservations(db, {
    actorId: admin.id,
    nowIso,
    auditDeferred: true,
  });
  // Refresh the legacy users.* tier cache for the accounts that changed.
  for (const uid of affectedUsers) await getTierStatus(db, uid);

  if (!already || converted > 0 || deferred.length > 0) {
    await audit(db, admin.id, 'membership.activate_launch', 'launchConfig', {
      already_activated: already,
      converted,
      deferred: deferred.length,
      activated_at: activatedAt,
      started_at: nowIso,
    });
  }
  const left = await countLaunchReservations(db);
  return c.json({
    success: true,
    already_activated: already,
    converted,
    deferred: deferred.length,
    activated_at: activatedAt,
    prepaid_count: left.waiting,
    deferred_count: left.deferred,
  });
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
 * merchant chain on a live deployment without a financial movement. Its
 * `credit_basis_iqd` is 0 too: a grant carries no purchase value into a later
 * upgrade.
 *
 * It respects the launch gate exactly as a purchase does: before launch the
 * grant lands as `prepaid_pending_launch` rather than pretending to be
 * active, because an entitlement that outruns the launch is a different bug
 * from a grant that was never made.
 *
 * ONE MEMBERSHIP AT A TIME applies to grants as it does to purchases: an
 * account that already holds a live row (active or reserved) is refused with
 * 409 — cancel that row first (with its refund, if it was paid) and grant
 * again. The refusal is decided inside the INSERT, so two admins cannot race
 * past it either.
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

  const liveRowRefusal = (live: { id: string; tier: string; state: string } | null) =>
    new HttpError(
      409,
      `هذا الحساب يحمل عضوية ${live ? tierLabel(live.tier) : ''} قائمة (${live?.state ?? 'live'}) بالفعل — ألغها أولا ثم امنح من جديد / This account already holds a live ${live ? tierLabel(live.tier) : ''} membership (${live?.state ?? 'live'}) — cancel it first, then grant again`,
      live?.state === 'prepaid_pending_launch' ? 'ALREADY_PREPAID' : 'ALREADY_SUBSCRIBED',
      live ? { membership_id: live.id, tier: live.tier, state: live.state } : undefined
    );

  // The same key on the same row is a replay, whatever the account holds now.
  const previous = await db.prepare('SELECT id FROM memberships WHERE id = ?').bind(id).first();
  if (previous) return c.json({ success: true, replayed: true, membership_id: id });
  const live = await db
    .prepare(`SELECT id, tier, state FROM memberships WHERE user_id = ? AND state IN ${LIVE_STATES} LIMIT 1`)
    .bind(userId)
    .first<{ id: string; tier: string; state: string }>();
  if (live) throw liveRowRefusal(live);

  try {
    await insertLiveMembership(db, {
      id,
      userId,
      planId: plan.id,
      tier: plan.tier,
      state: launch.activated ? 'active' : 'prepaid_pending_launch',
      durationMonths: plan.duration_months,
      pricePaidIqd: 0,
      creditBasisIqd: 0,
      creditAppliedIqd: 0,
      purchasedAt: nowIso,
      startsAt: launch.activated ? nowIso : null,
      expiresAt: launch.activated ? addMonths(nowIso, plan.duration_months) : null,
      source: 'admin',
      sourceRef: `admin:${admin.id}:${reason}`.slice(0, 200),
      walletTxId: null,
    }).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The id is derived from the caller's key, so a retry lands here rather
    // than granting a second membership.
    if (idReplay(msg)) return c.json({ success: true, replayed: true, membership_id: id });
    if (liveRowConflict(msg)) {
      const now = await db
        .prepare(`SELECT id, tier, state FROM memberships WHERE user_id = ? AND state IN ${LIVE_STATES} LIMIT 1`)
        .bind(userId)
        .first<{ id: string; tier: string; state: string }>();
      throw liveRowRefusal(now);
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
  if (eventsEnabled(c.env)) {
    await emitEvent(
      c.env.DB,
      SubscriptionChangedV1,
      {
        user_id: m.user_id,
        from_tier: m.tier ?? null,
        to_tier: null,
        plan_id: m.plan_id ?? null,
        membership_id: id,
        active: false,
        expires_at: null,
        reason: 'cancelled',
      },
      { aggregateId: m.user_id, actorId: admin.id }
    );
  }
  let refundedUsdCents = 0;
  let alreadyRefunded = false;
  if (refund) {
    // Refund exactly what was charged when the original tx is visible;
    // otherwise convert price_paid_iqd at the current rate.
    let cents = 0;
    /**
     * A REFUND GIVES BACK WHAT THE DEBIT TOOK — IN BOTH UNITS.
     *
     * The cents were always copied from the original charge. The DINARS were
     * not, and that is a balance that falls with no money moving: the charge
     * records `amount_iqd` (migration 0108), which cancels the remainder of
     * the deposits it spent; a refund that carries only cents restores every
     * cent and leaves the remainder cancelled, so the customer reads a few
     * dinars LESS than before they subscribed and can be refused a purchase
     * they could afford an hour earlier.
     *
     * The pair is COPIED, never recomputed: a refund must not invent a rate,
     * and a charge that recorded no dinars is reversed by a refund that
     * records none either — exactly symmetric, so the remainder sum is
     * untouched by both.
     */
    let refundIqd: number | null = null;
    let refundRate: number | null = null;
    if (m.wallet_tx_id) {
      const tx = await readChargeForRefund(db, String(m.wallet_tx_id));
      if (tx && tx.currency === 'USD') {
        cents = Number(tx.amount) || 0;
        refundIqd = Number.isInteger(tx.amount_iqd) && (tx.amount_iqd as number) > 0 ? (tx.amount_iqd as number) : null;
        refundRate =
          refundIqd !== null &&
          Number.isInteger(tx.exchange_rate_snapshot) &&
          (tx.exchange_rate_snapshot as number) > 0
            ? (tx.exchange_rate_snapshot as number)
            : null;
        if (refundRate === null) refundIqd = null;
      }
    }
    if (cents === 0 && Number(m.price_paid_iqd) > 0) {
      // No visible charge row to copy. The price is converted at today's rate,
      // and it stays a CEIL: this is the one place that gives back more than
      // it can prove was taken, and it must never give back less.
      const rate = Number(await getSetting(db, 'exchangeRate')) || 1400;
      cents = Math.ceil((Number(m.price_paid_iqd) * 100) / rate);
    }
    if (cents > 0) {
      try {
        // Deterministic id — a retried cancel can never double-refund.
        await db
          .prepare(
            refundIqd !== null
              ? `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, amount_iqd, exchange_rate_snapshot)
             VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, 'system', ?, ?, ?)`
              : `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
             VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, 'system', ?)`
          )
          .bind(
            ...[`wtx_refund_${id}`, m.user_id, cents, `Refund for cancelled membership ${id}`, id, nowIso],
            ...(refundIqd !== null ? [refundIqd, refundRate] : [])
          )
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
