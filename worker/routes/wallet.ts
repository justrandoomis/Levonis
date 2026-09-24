import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, requireAdmin, badRequest, conflict, forbidden, notFound, int, str, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { walletTxPublic } from '../lib/wallet';
import { rateLimit } from '../lib/ratelimit';
import {
  closeDepositNotification,
  enqueueUserDepositStatusNotification,
  notifyAdminsOfDeposit,
} from '../lib/walletNotify';
import { audit } from '../lib/audit';
import { headMediaObject } from '../lib/mediaStorage';
import {
  DEFAULT_WITHDRAWAL_FEE_BPS,
  MAX_AMOUNT_CENTS,
  MAX_WITHDRAWAL_FEE_BPS,
  WITHDRAWAL_LIVE_PAYOUT,
  WITHDRAWAL_STATES,
  WITHDRAWAL_TRANSITIONS,
  advanceWithdrawal,
  clearWithdrawalReconciliation,
  closeWithdrawal,
  createDepositRequest,
  decideDeposit,
  depositAmountReview,
  flagWithdrawalForReconciliation,
  getWalletBreakdown,
  getWalletDinarBreakdown,
  getAvailableBalances,
  readWalletDust,
  resolvePayoutChannel,
  walletIqdAvailable,
  withdrawalReserveCents,
  getWithdrawal,
  markWithdrawalPaid,
  operationNumber,
  requestWithdrawal,
  normalizeWithdrawalFeeBps,
  walletReconciliationReport,
  withdrawalFeeQuote,
  type WithdrawalOpResult,
  type WithdrawalRow,
} from '../lib/walletOps';
import { getSetting } from '../lib/settings';
import { notifyAdminTopic } from '../lib/telegramAdmin';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { availableUsdSql, isConstraintAbort } from '../lib/walletOps';
import { assertFinancialScope } from '../lib/walletAdjust';

/**
 * Wallet API (integrated mandate §11.1–§11.4).
 *
 * What changed versus the first wallet: money is now reported as THREE
 * separate numbers — available, held and pending — and a withdrawal reserves
 * its amount the moment it is filed, so the same balance cannot be both
 * withdrawn and spent. Deposit requests carry their transfer context
 * (provider/channel/reference) so the same transfer can never be credited
 * twice, and a payout is only ever recorded — never executed — by a human
 * with a written reference.
 *
 * The shape of GET /api/wallet is additive: `balance_usd_cents`,
 * `point_balance`, `transactions` and `point_transactions` still mean what
 * they meant, with `balance_usd_cents` now reporting the SPENDABLE balance
 * (identical to the old number whenever nothing is held).
 */

export const walletRoutes = new Hono<AppContext>();
walletRoutes.use('*', requireAuth);

const TX_STATUSES = ['pending', 'approved', 'rejected'] as const;
const TX_TYPES = ['deposit', 'withdrawal'] as const;

/** Public shape of a withdrawal request (owner + admin safe). */
function withdrawalPublic(w: WithdrawalRow) {
  return {
    id: w.id,
    number: operationNumber(w.id, 'WD'),
    amount_usd_cents: w.amount_cents,
    fee_cents: w.fee_cents,
    net_cents: w.net_cents,
    fee_policy: w.fee_policy,
    // THE ROW'S OWN POLICY, never today's setting. A request filed before the
    // owner set a commission carries fee_cents = 0 and 'not_configured', and
    // no screen may tell that customer a fee was charged on it just because
    // one exists now.
    fee_configured: w.fee_policy !== 'not_configured' && w.fee_cents > 0,
    state: w.state,
    // Explicitly NOT "paid": approving only authorises processing.
    money_sent: w.state === 'paid',
    needs_reconciliation: w.needs_reconciliation === 1,
    destination: {
      kind: w.destination_kind,
      /**
       * The channel's NAME at filing (migration 0112) — «زين كاش», «استلام
       * كاش» — or null for a request filed before it existed, which the
       * screens resolve by id. The customer's row, the admin card and the
       * Telegram line used to print `kind`, a raw id like «pm_1726…».
       */
      label: w.destination_label ?? null,
      account: w.destination_account,
      holder: w.destination_holder,
      note: w.destination_note,
      frozen_at: w.destination_frozen_at,
    },
    /**
     * THE DINARS THE CUSTOMER TYPED (migration 0106), or null for a request
     * filed before that column existed — or one whose claim the server could
     * not corroborate against its own rate and the cents that arrived. Every
     * screen prints this when it is present and converts from the cents only
     * when it is absent, the same one-directional fallback a deposit has
     * carried since 0105. It is testimony beside the money, never instead of
     * it: `amount_usd_cents` above is what was reserved and what will be
     * debited.
     */
    declared_amount_iqd: w.declared_amount_iqd ?? null,
    exchange_rate_snapshot: w.exchange_rate_snapshot ?? null,
    /** Migration 0112 — the commission and the payout AS QUOTED, in the typed
     *  dinars; null when the request recorded no corroborated dinar figure. */
    fee_iqd: w.fee_iqd ?? null,
    net_iqd: w.net_iqd ?? null,
    payout_reference: w.payout_reference || null,
    payout_at: w.payout_at,
    outcome_reason: w.outcome_reason || null,
    tx_id: w.tx_id,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const dinar = (iqd: number) => `${iqd.toLocaleString('en-US')} د.ع`;

/**
 * THE LINE THE ADMIN GROUP READS WHEN A WITHDRAWAL IS FILED.
 *
 * DINARS FIRST, THE LEDGER IN BRACKETS — the register the deposit review card
 * already uses («المبلغ: X د.ع (الدفتر: $Y)»). The amount gained its typed
 * dinars with 0106; the commission and the net stayed dollars, so the group
 * read «50,000 د.ع» and then «Commission: $1.07 … net $34.64» — a reviewer
 * about to make a DINAR transfer handed a dollar figure to do it with. Since
 * migration 0112 the request records the dinar commission and payout it
 * quoted the customer, and those are what this line prints.
 *
 * AND THE CHANNEL BY NAME. «Destination: pm_1726…» was the raw id of an admin
 * deposit method; the line now names the channel as the owner wrote it. The
 * customer's account number stays OUT of a group chat that gets screenshotted
 * — it is on the admin card, which is where a payout is made from.
 *
 * A request with no dinar testimony (typed in dollars, or a claim the server's
 * rate did not corroborate) keeps the dollar line it always had: there is no
 * dinar figure anybody typed to print.
 */
export function withdrawalAnnouncement(p: {
  number: string;
  user: string;
  amountCents: number;
  row: WithdrawalRow | null;
  channelLabel: string;
}): string {
  const row = p.row;
  const declared = row?.declared_amount_iqd ?? null;
  const amountLine = declared ? `${dinar(declared)} (ledger ${usd(p.amountCents)})` : usd(p.amountCents);
  let commissionLine = '';
  if (row && row.fee_cents > 0) {
    const feeIqd = row.fee_iqd ?? null;
    const netIqd = row.net_iqd ?? null;
    commissionLine =
      declared && feeIqd !== null && netIqd !== null
        ? `\nCommission: ${dinar(feeIqd)} (ledger ${usd(row.fee_cents)}) — deducted\nTo transfer: ${dinar(netIqd)} (ledger ${usd(row.net_cents)})`
        : `\nCommission: ${usd(row.fee_cents)} (deducted) — net ${usd(row.net_cents)}`;
  }
  const destination = (row?.destination_label ?? '').trim() || p.channelLabel;
  return `🏧 New withdrawal request (pending review — no transfer made)\nOperation: ${p.number}\nUser: ${p.user}\nAmount: ${amountLine}${commissionLine}\nDestination: ${destination}`;
}

/** Maps an engine result to an honest HTTP error (no invented success). */
function throwForWithdrawalFailure(res: Extract<WithdrawalOpResult, { ok: false }>): never {
  switch (res.reason) {
    case 'INVALID_AMOUNT':
      throw badRequest('Amount must be a whole number of cents above zero', 'INVALID_AMOUNT');
    case 'INSUFFICIENT_AVAILABLE':
      throw badRequest(
        'Withdrawal exceeds your available balance (pending deposits and existing holds are not available)',
        'INSUFFICIENT_BALANCE'
      );
    case 'DUPLICATE_EVENT':
      throw conflict('This request was already filed');
    case 'EVENT_KEY_REUSED':
      throw conflict('That idempotency key was already used with different details');
    case 'MISSING_EVENT_KEY':
      throw badRequest('Missing idempotency key');
    case 'MISSING_PAYOUT_REFERENCE':
      throw badRequest('A payout reference is required before a withdrawal can be marked paid', 'PAYOUT_REFERENCE_REQUIRED');
    case 'NEEDS_RECONCILIATION':
      throw conflict('This withdrawal is awaiting reconciliation — resolve the unknown payout outcome first');
    case 'ILLEGAL_TRANSITION':
      throw conflict('That state change is not allowed from the current state');
    case 'STATE_CONFLICT':
      throw conflict('This request was already handled by someone else');
    case 'NOT_FOUND':
      throw notFound('Withdrawal request not found');
    default:
      throw conflict('Request could not be completed');
  }
}

// ---------------------------------------------------------------- overview

walletRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const q = c.req.query();
  const type = q.type && q.type !== 'all' ? oneOf(q.type, 'type', TX_TYPES) : null;
  const status = q.status && q.status !== 'all' ? oneOf(q.status, 'status', TX_STATUSES) : null;
  const search = str(q.q, 'q', { max: 60, required: false });
  const limit = int(q.limit, 'limit', { min: 1, max: 200, def: 200 });
  const offset = int(q.offset, 'offset', { min: 0, max: 100_000, def: 0 });

  let sql = "SELECT * FROM wallet_transactions WHERE user_id = ? AND currency = 'USD'";
  const params: unknown[] = [user.id];
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (search) {
    // Operation numbers are the tail of the id; note/reference search stays
    // scoped to this user's own rows (never a global lookup).
    sql += ` AND (${sqlLikeClause(['id', 'note', 'ref'])})`;
    const byId = likePattern(search.replace(/^[A-Za-z]+-/, '').toLowerCase());
    const byText = likePattern(search);
    params.push(byId, byText, byText);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [breakdown, dust, exchangeRateSetting, usdRows, pointRows, withdrawals, reviews] = await Promise.all([
    getWalletBreakdown(c.env.DB, user.id),
    // Migration 0108 — the dinars the cents could not hold. Read here rather
    // than converted in the browser: src/WalletContext.tsx reads the rate once
    // on mount and never repolls, so a long-open tab would compute a balance
    // at a rate the shop has since moved.
    readWalletDust(c.env.DB, user.id),
    getSetting(c.env.DB, 'exchangeRate'),
    c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      "SELECT * FROM wallet_transactions WHERE user_id = ? AND currency = 'POINT' ORDER BY created_at DESC LIMIT 200"
    )
      .bind(user.id)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT * FROM wallet_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
      .bind(user.id)
      .all<WithdrawalRow>(),
    c.env.DB.prepare(
      'SELECT tx_id, state FROM wallet_review_requests WHERE user_id = ? AND state = ? LIMIT 200'
    )
      .bind(user.id, 'open')
      .all<{ tx_id: string; state: string }>(),
  ]);

  const openReviews = new Set((reviews.results ?? []).map((r) => r.tx_id));
  const depositMeta = await c.env.DB.prepare(
    `SELECT tx_id, provider, channel, reference, review_state, declared_amount_iqd, exchange_rate_snapshot
       FROM wallet_deposit_meta WHERE user_id = ? LIMIT 300`
  )
    .bind(user.id)
    .all<{
      tx_id: string;
      provider: string;
      channel: string;
      reference: string;
      review_state: string;
      declared_amount_iqd: number | null;
      exchange_rate_snapshot: number | null;
    }>();
  const metaById = new Map((depositMeta.results ?? []).map((m) => [m.tx_id, m]));

  const decorate = (t: Record<string, unknown>) => {
    const meta = metaById.get(String(t.id));
    return {
      ...walletTxPublic(t),
      number: operationNumber(String(t.id)),
      reviewRequested: openReviews.has(String(t.id)),
      depositContext: meta
        ? {
            provider: meta.provider,
            channel: meta.channel,
            reference: meta.reference,
            review_state: meta.review_state,
            // Migration 0105 — the dinars the customer typed, or null for a
            // request filed before the column existed. The browser falls back
            // to converting the cents for those; it never back-fills them.
            declared_amount_iqd: meta.declared_amount_iqd,
            exchange_rate_snapshot: meta.exchange_rate_snapshot,
          }
        : null,
    };
  };

  /**
   * THE BALANCE IN DINARS, AND THE ONLY PLACE IT IS COMPUTED.
   *
   * «يضاف كما هو ولكن يحول الى الدولار وليس العكس» (migration 0108). Every
   * screen that used to run `usdCentsToIqd(balance_usd_cents, rate)` reads
   * this instead, so the rule for which unit wins lives on the server, in one
   * function, and no client re-derives it. `balance_usd_cents` is untouched
   * and still the spendable cents — the money, and the thing every spend
   * guard compares.
   */
  const exchangeRate = Number(exchangeRateSetting) || 0;
  const balanceIqd = walletIqdAvailable(breakdown.usd_cents_available, dust.dust_iqd, exchangeRate);
  /**
   * AND THE OTHER FOUR FIGURES ON THE PAGE, THE SAME WAY. «إيداعات قيد
   * المراجعة» read IQD 49,994 the moment a customer typed 50,000, and
   * «الرصيد المسوّى» read 49,994 under a header saying 50,000 — the page
   * converted each aggregate's cents. `getWalletDinarBreakdown` sums what the
   * rows recorded instead (worker/lib/walletOps.ts has the rule per figure).
   */
  const dinars = await getWalletDinarBreakdown(c.env.DB, user.id, exchangeRate);

  return c.json({
    success: true,
    // Back-compatible key — now the SPENDABLE balance (settled minus holds).
    balance_usd_cents: breakdown.usd_cents_available,
    balance_iqd: balanceIqd,
    point_balance: breakdown.points_settled,
    transactions: (usdRows.results ?? []).map(decorate),
    point_transactions: (pointRows.results ?? []).map((t) => ({ ...walletTxPublic(t), number: operationNumber(String(t.id), 'P') })),
    balances: {
      usd_cents_settled: breakdown.usd_cents_settled,
      usd_cents_held: breakdown.usd_cents_held,
      usd_cents_available: breakdown.usd_cents_available,
      iqd_available: balanceIqd,
      iqd_settled: dinars.iqd_settled,
      iqd_held: dinars.iqd_held,
      iqd_pending_deposits: dinars.iqd_pending_deposits,
      iqd_pending_withdrawals: dinars.iqd_pending_withdrawals,
      usd_cents_pending_deposits: breakdown.usd_cents_pending_deposits,
      usd_cents_pending_withdrawals: breakdown.usd_cents_pending_withdrawals,
      points_settled: breakdown.points_settled,
      points_pending: breakdown.points_pending,
    },
    withdrawals: (withdrawals.results ?? []).map(withdrawalPublic),
    paging: { limit, offset, returned: usdRows.results?.length ?? 0 },
  });
});

/**
 * WHERE THE COMMISSION RATE COMES FROM, AND WHY IT IS NOT A `SettingKey`.
 *
 * `withdrawalFeeBps` is stored in the same `admin_settings` table as every
 * other owner-editable number, but it is deliberately read and written here
 * rather than through `getSetting`/`setSetting`: those are typed against
 * SETTING_DEFAULTS, and the wallet slice does not own that file. The read
 * below is the same one-row lookup they perform, and a row that is missing,
 * unparseable or nonsensical falls to `DEFAULT_WITHDRAWAL_FEE_BPS` — the 3%
 * the owner named — rather than to silence.
 *
 * ONE PLACE. Nothing else in the wallet reads this row; every caller goes
 * through here, and every multiplication goes through `withdrawalFeeQuote`.
 */
async function readWithdrawalFeeBps(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM admin_settings WHERE key = 'withdrawalFeeBps'")
    .first<{ value: string }>();
  if (!row) return DEFAULT_WITHDRAWAL_FEE_BPS;
  try {
    const parsed = JSON.parse(row.value);
    // A stored 0 is the owner switching the commission OFF and is honoured.
    // A stored nothing is a row that says nothing, and falls to the default.
    if (parsed === null || parsed === undefined) return DEFAULT_WITHDRAWAL_FEE_BPS;
    return normalizeWithdrawalFeeBps(parsed);
  } catch {
    return DEFAULT_WITHDRAWAL_FEE_BPS;
  }
}

/**
 * The policy surface the withdrawal form reads BEFORE any request exists.
 *
 * It exists so the form never computes a percentage of its own: it prints the
 * quote this route produced from the same function the ledger writes with.
 * The fee is DEDUCTED from the requested amount — request 100,000, the
 * commission is 3,000, 97,000 reaches you and 100,000 leaves your balance —
 * and `sample` says exactly that in numbers so the semantics cannot be read
 * two ways. There is still no live payout channel: `paid` is recorded by a
 * human who made a transfer that already happened.
 */
walletRoutes.get('/policy', async (c) => {
  const feeBps = await readWithdrawalFeeBps(c.env.DB);
  const sampleCents = 100_000;
  return c.json({
    success: true,
    withdrawal: {
      fee_bps: feeBps,
      fee_configured: feeBps > 0,
      fee_policy: feeBps > 0 ? 'percent_bps' : 'not_configured',
      /** Deducted from the requested amount, never added on top. */
      fee_basis: 'deducted_from_amount',
      sample: withdrawalFeeQuote(sampleCents, feeBps),
      live_payout: WITHDRAWAL_LIVE_PAYOUT,
      min_amount_usd_cents: 100,
      max_amount_usd_cents: MAX_AMOUNT_CENTS,
      states: WITHDRAWAL_STATES,
      transitions: WITHDRAWAL_TRANSITIONS,
    },
  });
});

// ---------------------------------------------------------------- deposits

/**
 * Deposit request: amount in USD cents plus the R2 key of an uploaded
 * receipt (uploaded first via /api/uploads with purpose=receipt). Stays
 * `pending` until an admin reviews it — a receipt never means "paid".
 *
 * The transfer context (provider/channel/reference) is what makes one
 * transfer one credit: the reference is deduplicated inside its own context
 * by a UNIQUE index (migration 0015), so re-sending with a fresh idempotency
 * key or a renamed screenshot cannot buy a second credit (§11.2/§11.4). The
 * attachment fingerprint is recorded as a REVIEW SIGNAL only.
 */
/**
 * The cents a typed dinar amount converts to at `rate` — floor, the wallet's
 * one dollar rule (the customer keeps the remainder, and 0108's dust term
 * returns it on every dinar reading). Null when there is no typed figure or
 * no rate, or when the result falls outside what a request may carry; the
 * caller then keeps the cents the client sent, exactly as before.
 */
export function dinarsToCents(declaredIqd: number, rate: number): number | null {
  if (!Number.isInteger(declaredIqd) || declaredIqd <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const cents = Math.floor((declaredIqd * 100) / rate);
  if (cents < 100 || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

walletRoutes.post('/deposits', async (c) => {
  await rateLimit(c, 'wallet-deposit', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const clientCents = int(body.amount_usd_cents, 'amount_usd_cents', { min: 100, max: MAX_AMOUNT_CENTS });
  const note = str(body.note, 'note', { max: 500, required: false });
  const paymentMethod = str(body.paymentMethod, 'paymentMethod', { max: 60, required: false });
  const receiptKey = str(body.receiptKey, 'receiptKey', { min: 5, max: 300 });
  const provider = str(body.provider, 'provider', { max: 60, required: false }) || paymentMethod;
  const channel = str(body.channel, 'channel', { max: 60, required: false });
  const reference = str(body.reference, 'reference', { max: 120, required: false });
  /**
   * WHAT THE CUSTOMER TYPED, WHEN THEY TYPED DINARS (migration 0105).
   *
   * `amount_usd_cents` above stays the authoritative figure and the only one
   * a credit is ever computed from. This is the customer's own claim about the
   * transfer, recorded verbatim because the cents cannot be converted back to
   * it: at 1,400 IQD/USD a cent is 14 د.ع, so 50,000 became 3,572 cents and
   * read back as 50,008 on every screen in the company. Optional, so an older
   * client that does not send it keeps working exactly as before.
   */
  const declaredAmountIqd = int(body.declared_amount_iqd, 'declared_amount_iqd', {
    min: 0,
    max: 10_000_000_000,
    def: 0,
  });

  if (!receiptKey.startsWith(`receipts/${user.id}/`)) {
    throw badRequest('Receipt upload is required for deposits');
  }
  const obj = await headMediaObject(c.env, 'private', receiptKey);
  if (!obj) throw badRequest('Receipt upload not found — please upload it again');

  // Weak content fingerprint from the stored object (md5/etag). It flags a
  // re-used receipt image for the reviewer; it is NOT anti-forgery proof.
  const fingerprint = (obj.checksums?.md5 ? bytesToHex(obj.checksums.md5) : obj.etag || '').slice(0, 80);

  // The rate is read once, here, and stored beside the dinars — never
  // re-read at display time, which is what made the figure drift.
  const exchangeRate = declaredAmountIqd ? Number(await getSetting(c.env.DB, 'exchangeRate')) || 0 : 0;
  /**
   * «يضاف كما هو ولكن يحول الى الدولار وليس العكس». When the customer typed
   * dinars, the DINARS are the request and the cents are converted from them
   * HERE, at the server's own rate — never taken from the tab. The tab's cents
   * used to be authoritative and the typed figure was kept only if it floored
   * back onto them; a tab holding yesterday's rate therefore filed a deposit
   * with no dinars on it at all, and the approved 50,000 read back as 49,994.
   * Now the pair always agrees by construction, so the typed figure is always
   * recorded and always what the customer sees.
   */
  const amount = dinarsToCents(declaredAmountIqd, exchangeRate) ?? clientCents;

  const created = await createDepositRequest(c.env.DB, {
    userId: user.id,
    amountCents: amount,
    receiptKey,
    note,
    paymentMethod,
    provider,
    channel,
    reference,
    fingerprint,
    declaredAmountIqd: declaredAmountIqd || undefined,
    exchangeRateSnapshot: exchangeRate || undefined,
  });
  if (!created.ok) {
    if (created.reason === 'INVALID_AMOUNT') throw badRequest('Amount must be a whole number of cents above zero', 'INVALID_AMOUNT');
    throw conflict(
      'A deposit with this transfer reference was already submitted for this payment method — ask support to review it instead of sending it again'
    );
  }
  const id = created.txId;
  const reviewState = created.reviewState;

  await audit(c.env.DB, user.id, 'wallet.deposit.requested', id, {
    amount_usd_cents: amount,
    provider,
    channel,
    has_reference: !!reference,
    review_state: reviewState,
  });
  // §12.1 — the admin group gets the operation WITH its proof attached, its
  // buttons and its retry row (tg_admin_notifications). The plain text line is
  // the fallback for the one case the rich path cannot cover: the request row
  // could not be read back, so nothing describes it. A delivery failure is
  // never silent — the row stays pending and the durable job retries it.
  c.executionCtx.waitUntil(
    notifyAdminsOfDeposit(c.env, id)
      .then(async (res) => {
        if (res.enqueued || res.reason === 'already_enqueued') return;
        await notifyAdminTopic(
          c.env,
          'wallet',
          `💰 New deposit request (pending review)\nOperation: ${operationNumber(id)}\nUser: ${user.username || `#${user.id}`}\nAmount: $${(amount / 100).toFixed(2)}${provider ? `\nMethod: ${provider}` : ''}${reference ? `\nReference: ${reference}` : ''}${reviewState !== 'awaiting_review' ? `\nSignal: ${reviewState}` : ''}`
        );
      })
      .catch((e) => console.error('deposit admin notification failed', e instanceof Error ? e.message : e))
  );
  return c.json({ success: true, id, number: operationNumber(id), status: 'pending', review_state: reviewState });
});

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// -------------------------------------------------------------- withdrawals

/**
 * Withdrawal request: reserves the amount from the AVAILABLE balance in the
 * same transaction that opens the request, freezes the destination, and
 * leaves the ledger row pending. Nothing is transferred here and approval
 * later means "approved for processing", not "sent" (§11.3).
 */
walletRoutes.post('/withdrawals', async (c) => {
  await rateLimit(c, 'wallet-withdraw', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const clientCents = int(body.amount_usd_cents, 'amount_usd_cents', { min: 100, max: MAX_AMOUNT_CENTS });
  const note = str(body.note, 'note', { max: 500, required: false });
  const kind = str(body.destinationKind, 'destinationKind', { max: 40, required: false }) || 'manual_transfer';
  /**
   * THE CHANNEL, RESOLVED HERE AND NOT TAKEN FROM THE BODY — «كي كارد،
   * الرافدين، زين كاش، استلام كاش». The body names an id; its NAME and whether
   * it needs the customer's account number come from the owner's own
   * `payoutMethods` (worker/lib/settings.ts), so a client can neither invent a
   * channel nor waive the account of one that needs it. The name is frozen
   * onto the request (`destination_label`, migration 0112): the customer's
   * row, the admin card and the Telegram line all printed a raw id before.
   */
  // Only the owner's current list: a channel removed in the admin editor is
  // refused here, whatever a stale tab still offers.
  const channel = resolvePayoutChannel(kind, await getSetting(c.env.DB, 'payoutMethods'));
  if (!channel) {
    throw badRequest('Choose one of the listed payout channels', 'UNKNOWN_PAYOUT_METHOD');
  }
  // `accountNumber` is the pre-existing field name; it is accepted as the
  // destination account of a manual transfer so older clients keep working.
  // «استلام كاش» needs none — the customer collects the cash — so for a
  // channel the owner marked `requires_account: false` the account is
  // optional; every other channel still refuses one under 3 characters.
  const account = str(body.destinationAccount ?? body.accountNumber, 'destinationAccount', {
    min: channel.requires_account ? 3 : 0,
    max: 120,
    required: channel.requires_account,
  });
  const holder = str(body.destinationHolder, 'destinationHolder', { max: 120, required: false });
  const destinationNote = str(body.destinationNote, 'destinationNote', { max: 300, required: false });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { max: 80, required: false });
  /**
   * WHAT THE CUSTOMER TYPED, WHEN THEY TYPED DINARS (migration 0106).
   *
   * The mirror of the deposit route above, and for the same reason: the hold
   * and the later debit are computed from `amount_usd_cents` and nothing else,
   * but the cents cannot be converted back to the figure the customer asked
   * for. A typed 50,000 د.ع became 3,572 cents and read back as 50,008 on
   * every withdrawal screen — eight dinars the customer never asked to
   * withdraw. Optional, so an older client keeps working.
   */
  const declaredAmountIqd = int(body.declared_amount_iqd, 'declared_amount_iqd', {
    min: 0,
    max: 10_000_000_000,
    def: 0,
  });

  // The rate is read ONCE here and quoted ONCE inside the engine. The stored
  // fee_cents/net_cents/fee_policy are the snapshot everyone else reads.
  const feeBps = await readWithdrawalFeeBps(c.env.DB);
  /**
   * Read once, here, and stored beside the dinars — never re-read at display
   * time, which is what made the figure drift in the first place.
   *
   * IT IS ALSO WHAT THE CLAIM IS CHECKED AGAINST. This is the SERVER's rate,
   * not necessarily the one the customer's tab floored with, so the engine
   * re-runs the conversion against it and stores the pair only if it lands on
   * `amount` (`corroboratedDeclaredIqd`, worker/lib/walletOps.ts). A tab left
   * open across a rate change, and a crafted body declaring 50,000,000 د.ع
   * beside 100 cents, both come out the same way: NULL, and every screen
   * converts the cents instead. The withdrawal itself is never refused for it.
   */
  const exchangeRate = declaredAmountIqd ? Number(await getSetting(c.env.DB, 'exchangeRate')) || 0 : 0;
  // The typed dinars are the request; the cents follow from them at the
  // server's rate (see the deposit route above).
  const amount = dinarsToCents(declaredAmountIqd, exchangeRate) ?? clientCents;
  const eventKey = idempotencyKey ? `wd:${idempotencyKey}` : `wd:${newId('evt')}`;

  /**
   * THE WHOLE DISPLAYED BALANCE MAY BE WITHDRAWN. Two typed deposits of 25,000
   * are 3,570 cents that read as 50,000 د.ع (0108); typing 50,000 back out
   * floors to 3,571 cents, one more than the wallet holds, and the hold
   * refused the customer's own balance. `withdrawalReserveCents` reserves the
   * cents on hand instead — only when the typed dinars corroborate the cents
   * sent AND are within the dinar balance — exactly as `walletSpendCents` caps
   * a checkout. The typed claim is still what is recorded (`claimCents` tells
   * the engine which cents it was converted to).
   *
   * A RETRY OF A CAPPED REQUEST must replay it, not collide with it: the same
   * idempotency key is looked up first and, when it already reserved at or
   * under what is asked now, that reservation is asked for again — so the
   * engine answers "already filed" instead of "same key, different amount".
   */
  let reserveCents = amount;
  if (declaredAmountIqd && exchangeRate > 0) {
    const prior = await c.env.DB.prepare(
      "SELECT amount_cents FROM wallet_holds WHERE user_id = ? AND kind = 'withdrawal' AND event_key = ?"
    )
      .bind(user.id, eventKey)
      .first<{ amount_cents: number }>();
    if (prior) {
      if (prior.amount_cents > 0 && prior.amount_cents <= amount) reserveCents = prior.amount_cents;
    } else {
      const [available, dust] = await Promise.all([
        getAvailableBalances(c.env, user.id),
        readWalletDust(c.env.DB, user.id),
      ]);
      reserveCents = withdrawalReserveCents({
        requestedCents: amount,
        declaredIqd: declaredAmountIqd,
        availableCents: available.usd_cents_available,
        dustIqd: dust.dust_iqd,
        exchangeRate,
      });
    }
  }

  const res = await requestWithdrawal(c.env.DB, {
    userId: user.id,
    amountCents: reserveCents,
    claimCents: amount,
    destination: { kind: channel.id, account, holder, note: destinationNote, label: channel.label },
    eventKey,
    note,
    feeBps,
    declaredAmountIqd: declaredAmountIqd || undefined,
    exchangeRateSnapshot: exchangeRate || undefined,
  });
  if (!res.ok) throwForWithdrawalFailure(res);

  const row = await getWithdrawal(c.env.DB, res.id);
  await audit(c.env.DB, user.id, 'wallet.withdrawal.requested', res.id, {
    amount_usd_cents: reserveCents,
    ...(reserveCents !== amount ? { requested_usd_cents: amount } : {}),
    destination_kind: channel.id,
    replayed: res.replayed,
  });
  if (!res.replayed) {
    /**
     * CONTAINED, AND WITHOUT THE CUSTOMER'S EMAIL IN A GROUP CHAT.
     *
     * Two defects lived on this line. It handed a BARE promise to `waitUntil`:
     * `notifyAdminTopic` reads D1 twice before it reaches Telegram and a D1
     * error there is a rejected promise, not the returned miss this call site
     * assumed — an unhandled rejection riding on the request of a customer who
     * just asked for their money. `announceAfterResponse` cannot reject.
     *
     * And it put `user.email` into a message broadcast to a staff group that
     * gets screenshotted. worker/lib/walletNotify.ts masks the phone even in
     * the wallet caption, where the reviewer genuinely needs to call — so an
     * email in a line whose whole job is to say "something arrived" is not
     * defensible. The operation number opens the row in the admin panel, which
     * is where the identity belongs; the username stays because it is a public
     * handle the customer chose, not a contact address.
     */
    announceAfterResponse(
      c,
      'wallet',
      withdrawalAnnouncement({
        number: operationNumber(res.id, 'WD'),
        user: user.username || `#${user.id}`,
        amountCents: row?.amount_cents ?? reserveCents,
        row,
        channelLabel: channel.label,
      })
    );
  }
  return c.json({
    success: true,
    id: res.id,
    number: operationNumber(res.id, 'WD'),
    status: row?.state ?? 'requested',
    replayed: res.replayed,
    quote: withdrawalFeeQuote(reserveCents, feeBps),
    withdrawal: row ? withdrawalPublic(row) : null,
  });
});

walletRoutes.get('/withdrawals', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM wallet_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  )
    .bind(user.id)
    .all<WithdrawalRow>();
  return c.json({ success: true, withdrawals: (results ?? []).map(withdrawalPublic) });
});

/** The user may cancel only BEFORE processing starts; the hold is released once. */
walletRoutes.post('/withdrawals/:id/cancel', async (c) => {
  await rateLimit(c, 'wallet-withdraw-cancel', 20, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const row = await getWithdrawal(c.env.DB, id);
  if (!row) throw notFound('Withdrawal request not found');
  if (row.user_id !== user.id) throw forbidden('This request belongs to another account');

  const res = await closeWithdrawal(c.env.DB, {
    id,
    to: 'cancelled',
    actorId: user.id,
    reason: 'cancelled by the account owner',
    allowedFrom: ['requested', 'approved'],
  });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, user.id, 'wallet.withdrawal.cancelled', id, { replayed: res.replayed });
  const after = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: after ? withdrawalPublic(after) : null });
});

// ------------------------------------------------------------ review request

/** §11.1: the user can ask for a review of an operation that belongs to them. */
walletRoutes.post('/transactions/:id/review-request', async (c) => {
  await rateLimit(c, 'wallet-review-request', 10, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });

  const tx = await c.env.DB.prepare('SELECT id, user_id FROM wallet_transactions WHERE id = ?')
    .bind(id)
    .first<{ id: string; user_id: string }>();
  if (!tx) throw notFound('Operation not found');
  if (tx.user_id !== user.id) throw forbidden('This operation belongs to another account');

  const reviewId = newId('wrev');
  let created = 0;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO wallet_review_requests (id, tx_id, user_id, reason, state, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'open', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE NOT EXISTS (SELECT 1 FROM wallet_review_requests r WHERE r.tx_id = ?2 AND r.user_id = ?3 AND r.state = 'open')`
    )
      .bind(reviewId, id, user.id, reason)
      .run();
    created = res.meta.changes ?? 0;
  } catch {
    created = 0;
  }
  if (created === 0) throw conflict('A review request for this operation is already open');

  await audit(c.env.DB, user.id, 'wallet.review.requested', id, { review_id: reviewId });
  return c.json({ success: true, id: reviewId, state: 'open' });
});

walletRoutes.get('/review-requests', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT id, tx_id, reason, state, admin_note, created_at, updated_at FROM wallet_review_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  )
    .bind(user.id)
    .all();
  return c.json({ success: true, requests: results ?? [] });
});

// ---------------------------------------------------------------- admin

/**
 * Read-only reconciliation: does the ledger match the holds and the requests?
 * It reports, it never repairs — an automatic "fix" here would be inventing
 * money (§11.4).
 */
walletRoutes.get('/admin/reconciliation', requireAdmin, async (c) => {
  const report = await walletReconciliationReport(c.env.DB);
  return c.json({ success: true, report });
});

/**
 * THE OWNER'S COMMISSION DIAL — «عمولة للسحب بقدر 3% قابله للتغيير من الادارة».
 *
 * GET reads it, PUT writes it, and both go through the same normalizer the
 * quote uses, so the admin screen and the engine cannot disagree about what a
 * typed number means. 0 is a real value and switches the commission off — the
 * same thing `codTaxPerBlockIqd = 0` means — so it is accepted rather than
 * rejected as "missing".
 *
 * CHANGING IT IS NOT RETROACTIVE, and that is the sentence worth keeping: a
 * withdrawal stores fee_cents/net_cents/fee_policy at the moment it is filed,
 * so raising the rate today cannot re-price a request already on the books,
 * exactly as `orders.cod_tax_iqd` cannot re-price last month's invoices.
 */
walletRoutes.get('/admin/withdrawal-fee', requireAdmin, async (c) => {
  const feeBps = await readWithdrawalFeeBps(c.env.DB);
  return c.json({
    success: true,
    fee_bps: feeBps,
    max_fee_bps: MAX_WITHDRAWAL_FEE_BPS,
    fee_basis: 'deducted_from_amount',
    sample: withdrawalFeeQuote(100_000, feeBps),
  });
});

walletRoutes.put('/admin/withdrawal-fee', requireAdmin, async (c) => {
  // The commission is money taken from every payout: owner / financial scope
  // only, as /api/admin/wallet/credit — an assistant admin could change it.
  assertFinancialScope(c);
  await rateLimit(c, 'admin-withdrawal-fee', 20, 3600);
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const feeBps = int(body.fee_bps, 'fee_bps', { min: 0, max: MAX_WITHDRAWAL_FEE_BPS });
  await c.env.DB.prepare(
    `INSERT INTO admin_settings (key, value) VALUES ('withdrawalFeeBps', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(JSON.stringify(feeBps))
    .run();
  await audit(c.env.DB, admin.id, 'wallet.withdrawal_fee.changed', 'withdrawalFeeBps', { fee_bps: feeBps });
  return c.json({
    success: true,
    fee_bps: feeBps,
    fee_basis: 'deducted_from_amount',
    sample: withdrawalFeeQuote(100_000, feeBps),
    note: 'Applies to NEW requests only — a filed withdrawal keeps the fee it was quoted',
  });
});

walletRoutes.get('/admin/withdrawals', requireAdmin, async (c) => {
  const state = c.req.query('state');
  let sql = `SELECT w.*, u.email, u.username FROM wallet_withdrawals w
               LEFT JOIN users u ON u.id = w.user_id`;
  const params: unknown[] = [];
  if (state && (WITHDRAWAL_STATES as readonly string[]).includes(state)) {
    sql += ' WHERE w.state = ?';
    params.push(state);
  }
  sql += ' ORDER BY w.created_at DESC LIMIT 300';
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<WithdrawalRow & { email: string; username: string }>();
  return c.json({
    success: true,
    withdrawals: (results ?? []).map((w) => ({ ...withdrawalPublic(w), email: w.email, username: w.username, userId: w.user_id })),
  });
});

/** requested → approved. Authorises PROCESSING only; no money moves. */
walletRoutes.post('/admin/withdrawals/:id/approve', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const res = await advanceWithdrawal(c.env.DB, { id, to: 'approved', actorId: admin.id });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.approved_for_processing', id, { replayed: res.replayed });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({
    success: true,
    replayed: res.replayed,
    note: 'Approved for processing — this is not a payout confirmation',
    withdrawal: row ? withdrawalPublic(row) : null,
  });
});

/** approved → processing (a human is now working the transfer). */
walletRoutes.post('/admin/withdrawals/:id/processing', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const res = await advanceWithdrawal(c.env.DB, { id, to: 'processing', actorId: admin.id });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.processing', id, { replayed: res.replayed });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: row ? withdrawalPublic(row) : null });
});

/**
 * processing → paid. Requires the reference of a transfer that ALREADY
 * happened; the hold is committed and the ledger debit posts in the same
 * transaction, so the balance drops exactly once.
 */
walletRoutes.post('/admin/withdrawals/:id/paid', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const payoutReference = str(body.payoutReference, 'payoutReference', { min: 3, max: 120 });
  const note = str(body.note, 'note', { max: 300, required: false });

  const res = await markWithdrawalPaid(c.env.DB, { id, payoutReference, actorId: admin.id, note });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.paid', id, {
    payout_reference: payoutReference,
    replayed: res.replayed,
  });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: row ? withdrawalPublic(row) : null });
});

/** Reject: releases the hold exactly once, with a recorded reason. */
walletRoutes.post('/admin/withdrawals/:id/reject', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 3, max: 300 });
  const res = await closeWithdrawal(c.env.DB, { id, to: 'rejected', actorId: admin.id, reason });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.rejected', id, { reason, replayed: res.replayed });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: row ? withdrawalPublic(row) : null });
});

/**
 * Final failure of a transfer whose outcome IS known (the channel refused
 * it). The hold is released exactly once. A transfer with an UNKNOWN outcome
 * must go through /reconcile instead — never straight to failed.
 */
walletRoutes.post('/admin/withdrawals/:id/fail', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 3, max: 300 });
  const res = await closeWithdrawal(c.env.DB, { id, to: 'failed', actorId: admin.id, reason });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.failed', id, { reason, replayed: res.replayed });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: row ? withdrawalPublic(row) : null });
});

/**
 * The payout attempt returned an unknown outcome (network failure at the
 * transfer channel). The request stays in processing with the money still
 * held: no second transfer, no instant release (§11.3).
 */
walletRoutes.post('/admin/withdrawals/:id/reconcile', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const note = str(body.note, 'note', { min: 3, max: 500 });
  const res = await flagWithdrawalForReconciliation(c.env.DB, { id, actorId: admin.id, note });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.reconciliation_flagged', id, { note });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({
    success: true,
    note: 'Held for reconciliation — no second payout and no release until the outcome is established',
    withdrawal: row ? withdrawalPublic(row) : null,
  });
});

/** Records what the channel actually did; the outcome is decided separately. */
walletRoutes.post('/admin/withdrawals/:id/reconcile/clear', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const finding = str(body.finding, 'finding', { min: 3, max: 500 });
  const res = await clearWithdrawalReconciliation(c.env.DB, { id, actorId: admin.id, finding });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.reconciliation_cleared', id, { finding });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, withdrawal: row ? withdrawalPublic(row) : null });
});

/**
 * THE DINARS THE CUSTOMER TYPED, FOR THE REVIEWER'S SCREEN (migration 0105).
 *
 * The admin wallet list is served by the legacy `/api/admin/wallet-requests`
 * route, which reports the ledger row and knows nothing about the deposit
 * context. Rather than have that screen convert the cents back — the exact
 * arithmetic that turned a 50,000 د.ع transfer into «50,008 د.ع» on every
 * screen in the company — it asks here for the figures that were RECORDED.
 *
 * Read-only, admin-only, and deliberately thin: it returns the declared
 * dinars and the rate they were filed at, nothing else. A row filed before
 * 0105 is simply absent from the map, and the caller keeps converting for it,
 * which is the honest answer for a request whose dinar figure nobody wrote
 * down.
 */
walletRoutes.get('/admin/deposits/declared', requireAdmin, async (c) => {
  const ids = (c.req.query('ids') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 200);
  if (ids.length === 0) return c.json({ success: true, declared: {} });
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT tx_id, declared_amount_iqd, exchange_rate_snapshot
       FROM wallet_deposit_meta
      WHERE tx_id IN (${placeholders}) AND declared_amount_iqd IS NOT NULL`
  )
    .bind(...ids)
    .all<{ tx_id: string; declared_amount_iqd: number; exchange_rate_snapshot: number | null }>();
  const declared: Record<string, { amount_iqd: number; exchange_rate: number | null }> = {};
  for (const r of results ?? []) {
    declared[r.tx_id] = { amount_iqd: r.declared_amount_iqd, exchange_rate: r.exchange_rate_snapshot };
  }
  return c.json({ success: true, declared });
});

/**
 * Finance records what actually arrived. A mismatch parks the request in
 * `amount_mismatch`, which the approval path below refuses — a difference is
 * never approved silently (§11.2).
 */
walletRoutes.post('/admin/deposits/:id/observe', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const observed = int(body.observedAmountCents, 'observedAmountCents', { min: 1, max: MAX_AMOUNT_CENTS });
  const note = str(body.note, 'note', { max: 300, required: false });

  const meta = await c.env.DB.prepare('SELECT declared_amount_cents FROM wallet_deposit_meta WHERE tx_id = ?')
    .bind(id)
    .first<{ declared_amount_cents: number }>();
  if (!meta) throw notFound('Deposit context not found for this operation');
  const reviewState = depositAmountReview(meta.declared_amount_cents, observed);

  const res = await c.env.DB.prepare(
    `UPDATE wallet_deposit_meta
        SET observed_amount_cents = ?2, review_state = ?3, review_note = substr(?4, 1, 300),
            reviewed_by = ?5, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE tx_id = ?1
        AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1 AND t.status = 'pending')`
  )
    .bind(id, observed, reviewState, note, admin.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict('This deposit is no longer pending — a decided deposit is corrected with a linked adjustment');
  }
  await audit(c.env.DB, admin.id, 'wallet.deposit.observed', id, {
    declared: meta.declared_amount_cents,
    observed,
    review_state: reviewState,
  });
  return c.json({ success: true, review_state: reviewState, matches: reviewState === 'cleared_for_decision' });
});

/**
 * Deposit approval that credits ONCE, atomically, and refuses to approve a
 * request whose observed amount does not match what the user declared. (The
 * legacy generic admin decide endpoint still exists; the integration note in
 * this slice's report asks for it to be pointed here.)
 */
walletRoutes.post('/admin/deposits/:id/approve', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });

  // §12.2 — the SAME service the Telegram inline button calls. One conditional
  // UPDATE decides; the loser of a race is told it was already processed.
  const res = await decideDeposit(c.env, {
    requestId: id,
    action: 'approve',
    actorUserId: admin.id,
    reason: adminNote,
    source: 'site',
  });
  if (!res.ok) {
    if (res.reason === 'AMOUNT_MISMATCH') {
      throw conflict(
        'The observed amount does not match the requested amount — reject this request and file a linked adjustment for the amount that actually arrived'
      );
    }
    throw conflict('This deposit is not pending (it may already be decided)');
  }
  // Message updates and customer notifications only — never the ledger.
  c.executionCtx.waitUntil(
    Promise.allSettled([closeDepositNotification(c.env, id), enqueueUserDepositStatusNotification(c.env, id)]).then(
      () => undefined
    )
  );
  return c.json({ success: true });
});

/** Rejection records a reason and frees the reference for an honest resubmission. */
walletRoutes.post('/admin/deposits/:id/reject', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 3, max: 300 });

  const res = await decideDeposit(c.env, {
    requestId: id,
    action: 'reject',
    actorUserId: admin.id,
    reason,
    source: 'site',
  });
  if (!res.ok) {
    if (res.reason === 'REASON_REQUIRED') throw badRequest('A rejection reason is required', 'REASON_REQUIRED');
    throw conflict('This deposit is not pending (it may already be decided)');
  }
  c.executionCtx.waitUntil(
    Promise.allSettled([closeDepositNotification(c.env, id), enqueueUserDepositStatusNotification(c.env, id)]).then(
      () => undefined
    )
  );
  return c.json({ success: true });
});

/**
 * Correction of a FINAL operation: a new linked ledger row, never an edit of
 * the original (§11.2/§11.1). Idempotent per (original, eventKey), so a
 * double click cannot credit twice.
 */
walletRoutes.post('/admin/transactions/:id/adjustment', requireAdmin, async (c) => {
  // It MINTS or REMOVES money: financial scope and a per-admin rate limit, the
  // guards /api/admin/wallet/credit carries. It had only `requireAdmin`, so an
  // assistant admin could credit any member who had one USD row.
  assertFinancialScope(c);
  await rateLimit(c, 'admin-wallet-adjustment', 30, 3600);
  const admin = c.get('user')!;
  const originalId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const direction = oneOf(body.direction, 'direction', ['credit', 'debit'] as const);
  const amount = int(body.amountCents, 'amountCents', { min: 1, max: MAX_AMOUNT_CENTS });
  const reason = str(body.reason, 'reason', { min: 5, max: 300 });
  const eventKey = str(body.eventKey, 'eventKey', { min: 4, max: 80 });

  const original = await c.env.DB.prepare(
    "SELECT id, user_id, status, currency FROM wallet_transactions WHERE id = ? AND currency = 'USD'"
  )
    .bind(originalId)
    .first<{ id: string; user_id: string; status: string; currency: string }>();
  if (!original) throw notFound('Original operation not found');
  if (original.status === 'pending') {
    throw badRequest('Decide the original request first — a pending row is not corrected with an adjustment');
  }

  const existing = await c.env.DB.prepare(
    'SELECT id, adjustment_tx_id FROM wallet_adjustments WHERE original_tx_id = ? AND event_key = ?'
  )
    .bind(originalId, eventKey)
    .first<{ id: string; adjustment_tx_id: string }>();
  if (existing) {
    return c.json({ success: true, id: existing.id, tx_id: existing.adjustment_tx_id, replayed: true });
  }

  const adjId = newId('wadj');
  const txId = newId('wtx');
  const statements = [
    c.env.DB.prepare(
      // A DEBIT carries the spendable-balance guard (`usdSpendStatement`'s
      // CASE): one the balance does not cover writes -1, CHECK (amount > 0)
      // aborts the batch, and the wallet can no longer be pushed negative.
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, decided_by)
       SELECT ?1, ?2, ?3, 'USD',
         ${direction === 'debit' ? `CASE WHEN ${availableUsdSql('?2')} >= ?4 THEN ?4 ELSE -1 END` : '?4'},
         'approved', ?5, ?6, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?7`
    ).bind(
      txId,
      original.user_id,
      direction === 'credit' ? 'deposit' : 'withdrawal',
      amount,
      `adjustment for ${operationNumber(originalId)}: ${reason}`,
      originalId,
      admin.id
    ),
    c.env.DB.prepare(
      `INSERT INTO wallet_adjustments (id, original_tx_id, adjustment_tx_id, user_id, direction, amount_cents, reason, actor_id, event_key)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?3)`
    ).bind(adjId, originalId, txId, original.user_id, direction, amount, reason, admin.id, eventKey),
  ];
  try {
    await c.env.DB.batch(statements);
  } catch (e) {
    if (!isConstraintAbort(e)) throw e;
    // Either a concurrent submit won the (original, key) slot — a replay — or
    // the debit guard fired.
    const raced = await c.env.DB.prepare(
      'SELECT id, adjustment_tx_id FROM wallet_adjustments WHERE original_tx_id = ? AND event_key = ?'
    )
      .bind(originalId, eventKey)
      .first<{ id: string; adjustment_tx_id: string }>();
    if (raced) return c.json({ success: true, id: raced.id, tx_id: raced.adjustment_tx_id, replayed: true });
    if (direction === 'debit') {
      throw conflict("The debit exceeds the member's available balance", 'INSUFFICIENT_BALANCE');
    }
    throw conflict('This adjustment key was already used for this operation');
  }
  await audit(c.env.DB, admin.id, 'wallet.adjustment', originalId, { direction, amount, reason, tx_id: txId });
  return c.json({ success: true, id: adjId, tx_id: txId, replayed: false });
});

walletRoutes.get('/admin/review-requests', requireAdmin, async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 20, required: false }) || 'open';
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, u.email, u.username FROM wallet_review_requests r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.state = ? ORDER BY r.created_at DESC LIMIT 200`
  )
    .bind(state)
    .all();
  return c.json({ success: true, requests: results ?? [] });
});

walletRoutes.post('/admin/review-requests/:id/close', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const adminNote = str(body.adminNote, 'adminNote', { min: 3, max: 500 });
  const state = oneOf(body.state ?? 'answered', 'state', ['answered', 'closed'] as const);
  const res = await c.env.DB.prepare(
    `UPDATE wallet_review_requests
        SET state = ?2, admin_note = ?3, handled_by = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1 AND state = 'open'`
  )
    .bind(id, state, adminNote, admin.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw conflict('This review request is no longer open');
  await audit(c.env.DB, admin.id, 'wallet.review.closed', id, { state });
  return c.json({ success: true });
});
