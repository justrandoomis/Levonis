/**
 * THE MERCHANT'S MONEY — /api/merchant/finance/* and /api/merchant/payouts/*
 * (merchant platform W2-B; docs/MERCHANT_PLATFORM.md §4.3).
 *
 * Two routers, two mounts in worker/index.ts so the routing design names them
 * (services/gateway/src/routes.ts). Both resolve the store from the session
 * (`requireStoreOwner`) and scope every read in SQL — no merchant id is ever
 * read from the request.
 *
 *   GET  /finance/summary   every figure of the finance page, from the ledger
 *   GET  /finance/ledger    the lines, newest first (?cursor=&kind=&from=&to=&limit=)
 *   GET  /payouts           the balance, the channels, the requests (?cursor=)
 *   POST /payouts           ask to be paid: reserves «available» → «reserved»
 *   POST /payouts/:id/cancel  take a request back while nobody approved it
 *
 * A merchant whose selling privileges lapsed still reads all of it and may
 * still ask for their earned money (§48: money owed stays reachable).
 *
 * REFUSALS, each with a stable code the client maps to words:
 *   400 INVALID_AMOUNT · INVALID_IDEMPOTENCY_KEY · UNKNOWN_PAYOUT_METHOD ·
 *       PAYOUT_ACCOUNT_REQUIRED · INVALID_FILTER
 *   400 INSUFFICIENT_BALANCE {available_iqd}
 *   409 IDEMPOTENCY_KEY_REUSED · PAYOUT_NOT_CANCELLABLE {state}
 *   404 NOT_FOUND (a payout that is not this merchant's reads as absent)
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, notFound, HttpError } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { requireStoreOwner } from '../lib/merchantAuth';
import { getSetting } from '../lib/settings';
import { resolvePayoutChannel } from '../lib/walletOps';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { groupDigits, sanitizeUserText } from '../lib/walletNotify';
import {
  LEDGER_KINDS,
  cancelPayout,
  financeSummary,
  ledgerPage,
  merchantBalance,
  merchantBuckets,
  merchantSuspension,
  payoutPublic,
  payoutsPage,
  requestPayout,
  type LedgerKind,
} from '../lib/merchantLedger';

export const merchantFinanceRoutes = new Hono<AppContext>();
merchantFinanceRoutes.use('*', requireAuth);

export const merchantPayoutRoutes = new Hono<AppContext>();
merchantPayoutRoutes.use('*', requireAuth);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;

function limitOf(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : def;
}

merchantFinanceRoutes.get('/summary', async (c) => {
  const ctx = await requireStoreOwner(c);
  const [summary, buckets] = await Promise.all([
    financeSummary(c.env.DB, ctx.merchant.id),
    merchantBuckets(c.env.DB, ctx.merchant.id),
  ]);
  return c.json({ success: true, summary, buckets });
});

merchantFinanceRoutes.get('/ledger', async (c) => {
  const ctx = await requireStoreOwner(c);
  const kind = c.req.query('kind') ?? '';
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (kind && !(LEDGER_KINDS as readonly string[]).includes(kind)) {
    throw badRequest('Unknown ledger kind', 'INVALID_FILTER', { field: 'kind' });
  }
  for (const [field, v] of [['from', from], ['to', to]] as const) {
    if (v && (!ISO_DAY.test(v) || !Number.isFinite(Date.parse(v)))) {
      throw badRequest('Dates are YYYY-MM-DD', 'INVALID_FILTER', { field });
    }
  }
  const page = await ledgerPage(c.env.DB, ctx.merchant.id, {
    cursor: c.req.query('cursor'),
    kind: kind as LedgerKind | '',
    from,
    to,
    limit: limitOf(c.req.query('limit'), 50),
  });
  return c.json({ success: true, ...page });
});

// ------------------------------------------------------------------ payouts

merchantPayoutRoutes.get('/', async (c) => {
  const ctx = await requireStoreOwner(c);
  const [balance, buckets, methods, page] = await Promise.all([
    merchantBalance(c.env.DB, ctx.merchant.id),
    merchantBuckets(c.env.DB, ctx.merchant.id),
    getSetting(c.env.DB, 'payoutMethods'),
    payoutsPage(c.env.DB, ctx.merchant.id, { cursor: c.req.query('cursor'), limit: limitOf(c.req.query('limit'), 30) }),
  ]);
  return c.json({
    success: true,
    balance,
    buckets,
    // The owner's own channels, by id and name — the only ones a request may name.
    methods: methods.map((m) => ({ id: m.id, name: m.name, requires_account: m.requires_account !== false })),
    ...page,
  });
});

/**
 * «اطلب تحويل أرباحك» — the request and its reservation, one batch
 * (worker/lib/merchantLedger.ts `requestPayout`). The channel is resolved on
 * the server from the owner's `payoutMethods` and frozen on the request with
 * the account; the amount is never more than «available» at the moment the
 * batch runs, however many requests race.
 */
merchantPayoutRoutes.post('/', async (c) => {
  await rateLimit(c, 'merchant-payout', 10, 3600);
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;
  // NO MONEY LEAVES WHILE THE MERCHANT OR ITS STORE IS SUSPENDED (owner
  // decision, DECISIONS row 137). The balance stays theirs and is shown; the
  // request waits until the suspension lifts.
  const suspension = await merchantSuspension(c.env.DB, ctx.merchant.id);
  if (suspension === 'MERCHANT_SUSPENDED') {
    throw new HttpError(409, 'This merchant account is suspended — payouts wait until Levonis lifts it', 'MERCHANT_SUSPENDED');
  }
  if (suspension === 'STORE_SUSPENDED') {
    throw new HttpError(409, 'This store is suspended — payouts wait until Levonis lifts it', 'STORE_SUSPENDED');
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  const amount = Number(body.amount_iqd);
  if (!(Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000_000)) {
    throw badRequest('Enter a whole number of dinars above zero', 'INVALID_AMOUNT');
  }
  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!/^[\w:.-]{8,80}$/.test(key)) throw badRequest('Missing request key', 'INVALID_IDEMPOTENCY_KEY');
  const channel = resolvePayoutChannel(String(body.channel ?? ''), await getSetting(c.env.DB, 'payoutMethods'));
  if (!channel) throw badRequest('Choose one of the listed payout channels', 'UNKNOWN_PAYOUT_METHOD');
  const account = typeof body.account === 'string' ? body.account.trim().slice(0, 120) : '';
  if (channel.requires_account && account.length < 3) {
    throw badRequest('This channel needs the account or card number', 'PAYOUT_ACCOUNT_REQUIRED');
  }
  const holder = typeof body.holder === 'string' ? body.holder.trim().slice(0, 120) : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';

  const res = await requestPayout(c.env.DB, {
    merchantId: ctx.merchant.id,
    storeId: ctx.store.id,
    amountIqd: amount,
    method: { channel: channel.id, label: channel.label, account, holder },
    note,
    requestedBy: user.id,
    key,
  });
  if (!res.ok) {
    if (res.reason === 'INSUFFICIENT_BALANCE') {
      throw badRequest('That is more than you have available', 'INSUFFICIENT_BALANCE', { available_iqd: res.availableIqd ?? 0 });
    }
    if (res.reason === 'IDEMPOTENCY_KEY_REUSED') {
      throw new HttpError(409, 'This request key was already used for a different payout. Start again.', 'IDEMPOTENCY_KEY_REUSED');
    }
    throw badRequest('Enter a whole number of dinars above zero', 'INVALID_AMOUNT');
  }
  if (!res.replayed) {
    // The staff group hears it like a wallet withdrawal: the store, the
    // amount, the channel by name — never the account number (it is on the
    // admin queue, where the transfer is made from).
    announceAfterResponse(
      c,
      'wallet',
      `🏦 طلب تحويل أرباح تاجر (بانتظار المراجعة — لم يُحوَّل شيء)\nالمتجر: ${sanitizeUserText(ctx.store.name, { max: 60 })}\nالمبلغ: ${groupDigits(amount)} د.ع\nالقناة: ${sanitizeUserText(channel.label, { max: 60 })}\nالطلب: ${res.payout.id}`
    );
  }
  return c.json(
    { success: true, replayed: res.replayed, payout: payoutPublic(res.payout), balance: await merchantBalance(c.env.DB, ctx.merchant.id) },
    res.replayed ? 200 : 201
  );
});

merchantPayoutRoutes.post('/:id/cancel', async (c) => {
  await rateLimit(c, 'merchant-payout-cancel', 30, 3600);
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;
  const id = String(c.req.param('id') ?? '').slice(0, 60);
  const res = await cancelPayout(c.env.DB, { payoutId: id, merchantId: ctx.merchant.id, actorId: user.id });
  if (!res.ok) {
    if (res.reason === 'NOT_FOUND') throw notFound('Payout request not found');
    throw new HttpError(409, 'This request is already being handled and cannot be cancelled', 'PAYOUT_NOT_CANCELLABLE', {
      state: res.state ?? null,
    });
  }
  return c.json({ success: true, replayed: res.replayed, payout: payoutPublic(res.payout), balance: await merchantBalance(c.env.DB, ctx.merchant.id) });
});
