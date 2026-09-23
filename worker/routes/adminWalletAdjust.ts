/**
 * /api/admin/wallet-adjust/* — the admin's hand on a member's wallet.
 *
 *   POST /users/:id              credit or debit the dinar balance, or add or
 *                                deduct points, with a required reason
 *   GET  /rounding-drift         «فحص فروقات التقريب» — the dry run
 *   POST /rounding-drift/apply   «تطبيق التسوية» — the typed confirmation
 *
 * The owner: «المستخدمين لا يمكن التعديل على رصيده مثل خصم رصيد وإضافة رصيد
 * يدوي أو خصم النقاط وإضافة نقاط». Before this, POST /api/admin/wallet/credit
 * could only ADD, only in USD cents (so 50,000 د.ع read 49,994) and nothing in
 * the panel called it.
 *
 * EVERY ROUTE HERE MOVES MONEY, so every one carries the guards a money route
 * needs: the apex-only host guard and `requireAdmin` (mounted under
 * /api/admin/*), the FINANCIAL scope (an assistant admin is refused 403
 * FINANCIAL_SCOPE_REQUIRED, as /wallet/credit refuses it), a per-admin rate
 * limit, an idempotency key whose ledger ids are derived from (admin, key), and
 * an audit row — actor, before, after and reason — written in the SAME batch
 * as the money, so neither can land without the other. The arithmetic is in
 * worker/lib/walletAdjust.ts.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, conflict, int, notFound, oneOf, requireAdmin, str, unavailable } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { getSetting } from '../lib/settings';
import {
  applyRoundingDrift,
  assertFinancialScope,
  manualWalletAdjust,
  ROUNDING_DRIFT_CONFIRM,
  scanRoundingDrift,
} from '../lib/walletAdjust';
import { audit } from '../lib/audit';

export const adminWalletAdjustRoutes = new Hono<AppContext>();

adminWalletAdjustRoutes.use('*', requireAdmin);

/** Largest single manual change: a billion dinars (71M cents at 1,400 — inside
 *  MAX_AMOUNT_CENTS) / ten million points. */
const MAX_ADJUST_IQD = 1_000_000_000;
const MAX_ADJUST_POINTS = 10_000_000;

async function todayRate(db: D1Database): Promise<number> {
  const rate = Number(await getSetting(db, 'exchangeRate'));
  return Number.isInteger(rate) && rate > 0 ? rate : 0;
}

adminWalletAdjustRoutes.post('/users/:id', async (c) => {
  assertFinancialScope(c);
  await rateLimit(c, 'admin-wallet-adjust', 30, 3600);
  const admin = c.get('user')!;
  const userId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const kind = oneOf(body.kind, 'kind', ['balance', 'points'] as const);
  const direction = oneOf(body.direction, 'direction', ['credit', 'debit'] as const);
  const amount =
    kind === 'balance'
      ? int(body.amount_iqd, 'amount_iqd', { min: 1, max: MAX_ADJUST_IQD })
      : int(body.points, 'points', { min: 1, max: MAX_ADJUST_POINTS });
  const reason = str(body.reason, 'reason', { min: 5, max: 300 });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });

  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!target) throw notFound('User not found');
  const rate = await todayRate(c.env.DB);

  const res = await manualWalletAdjust(c.env, {
    actorId: admin.id,
    userId,
    kind,
    direction,
    amount,
    reason,
    idempotencyKey,
    rate,
  });
  if (!res.ok) {
    switch (res.reason) {
      case 'INSUFFICIENT_BALANCE':
        throw conflict(
          `الخصم أكبر من رصيد العضو (${(res.balance_iqd ?? 0).toLocaleString('en-US')} د.ع) / The debit exceeds the member's balance`,
          'INSUFFICIENT_BALANCE'
        );
      case 'INSUFFICIENT_POINTS':
        throw conflict(
          `الخصم أكبر من نقاط العضو (${(res.points ?? 0).toLocaleString('en-US')}) / The deduction exceeds the member's points`,
          'INSUFFICIENT_POINTS'
        );
      case 'UNREPRESENTABLE':
        // The wallet page reads 0 once no cent is left, whatever dinars remain.
        throw conflict(
          `لا يمكن أن يبقى في المحفظة أقل من ${(res.min_iqd ?? 0).toLocaleString('en-US')} د.ع — اخصم الرصيد كاملًا (${(res.balance_iqd ?? 0).toLocaleString('en-US')} د.ع) أو اترك ${(res.min_iqd ?? 0).toLocaleString('en-US')} د.ع على الأقل / The result would be under one cent's worth, which the wallet cannot hold`,
          'AMOUNT_UNREPRESENTABLE'
        );
      case 'AMOUNT_TOO_SMALL':
        throw badRequest('المبلغ أصغر من أن يُسجَّل / The amount is too small to record', 'AMOUNT_TOO_SMALL');
      case 'IDEMPOTENCY_KEY_REUSED':
        throw conflict('This idempotency key was already used for a different adjustment', 'IDEMPOTENCY_KEY_REUSED');
      case 'NO_RATE':
        throw unavailable('Set the exchange rate first', 'NO_EXCHANGE_RATE');
      case 'SCHEMA_BEHIND':
        throw unavailable('The wallet database is behind this deployment (migration 0108)', 'SCHEMA_BEHIND');
    }
  }
  return c.json({ success: true, ...res });
});

adminWalletAdjustRoutes.get('/rounding-drift', async (c) => {
  assertFinancialScope(c);
  const rate = await todayRate(c.env.DB);
  if (!rate) throw unavailable('Set the exchange rate first', 'NO_EXCHANGE_RATE');
  const scan = await scanRoundingDrift(c.env, rate);
  return c.json({ success: true, confirm_phrase: ROUNDING_DRIFT_CONFIRM[0], ...scan });
});

adminWalletAdjustRoutes.post('/rounding-drift/apply', async (c) => {
  assertFinancialScope(c);
  await rateLimit(c, 'admin-rounding-drift', 10, 3600);
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const phrase = str(body.confirm, 'confirm', { max: 40 }).trim();
  if (!(ROUNDING_DRIFT_CONFIRM as readonly string[]).includes(phrase)) {
    throw badRequest(`اكتب «${ROUNDING_DRIFT_CONFIRM[0]}» للتأكيد / Type the confirmation phrase`, 'CONFIRMATION_REQUIRED');
  }
  const fingerprint = str(body.fingerprint, 'fingerprint', { min: 8, max: 64 });
  const rate = await todayRate(c.env.DB);
  if (!rate) throw unavailable('Set the exchange rate first', 'NO_EXCHANGE_RATE');
  // Apply exactly what the admin looked at. A scan that changed in between —
  // a new deposit approved, another admin already applying, the rate moved —
  // is refused, and the screen scans again.
  const scan = await scanRoundingDrift(c.env, rate);
  if (scan.fingerprint !== fingerprint) {
    throw conflict('The list changed since it was checked — check again', 'PLAN_CHANGED');
  }
  // At most ROUNDING_DRIFT_PAGE members per request; `remaining` tells the
  // screen to scan and apply again.
  const { results, remaining } = await applyRoundingDrift(c.env, admin.id, scan);
  await audit(c.env.DB, admin.id, 'wallet.rounding_drift.run', 'wallet', {
    exchange_rate: rate,
    fingerprint,
    members: results.length,
    applied: results.filter((r) => r.status === 'applied').length,
    not_applied: results.filter((r) => r.status !== 'applied').map((r) => [r.user_id, r.status]),
    remaining,
    net_iqd: results.reduce((n, r) => n + r.applied_iqd, 0),
  });
  return c.json({ success: true, results, remaining });
});
