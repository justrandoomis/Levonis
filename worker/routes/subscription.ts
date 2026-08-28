import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, oneOf, str } from '../lib/http';
import { getSetting } from '../lib/settings';
import { spend } from '../lib/wallet';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';

export const subscriptionRoutes = new Hono<AppContext>();

/** Server-authoritative plan catalog (IQD). */
export const SUBSCRIPTION_PLANS = {
  plus: [
    { id: '1mo', cost_iqd: 4500, days: 30 },
    { id: '3mo', cost_iqd: 11700, days: 90 },
    { id: '6mo', cost_iqd: 19800, days: 180 },
    { id: '1yr', cost_iqd: 33600, days: 365 },
  ],
  pro: [
    { id: '6mo', cost_iqd: 270000, days: 180 },
    { id: '1yr', cost_iqd: 450000, days: 365 },
  ],
} as const;

subscriptionRoutes.get('/plans', (c) => {
  return c.json({ success: true, plans: SUBSCRIPTION_PLANS });
});

subscriptionRoutes.post('/subscribe', requireAuth, async (c) => {
  await rateLimit(c, 'subscribe', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const plan = oneOf(body.plan, 'plan', ['plus', 'pro'] as const);
  const durationId = str(body.durationId, 'durationId', { min: 1, max: 10 });

  const option = SUBSCRIPTION_PLANS[plan].find((p) => p.id === durationId);
  if (!option) throw badRequest('Unknown subscription duration');

  const now = Date.now();
  const active = user.subscription_plan !== 'free' && user.subscription_expiry > now;

  if (active && user.subscription_plan === plan) {
    throw badRequest(`You already have ${plan.toUpperCase()}. You can re-subscribe when it expires.`);
  }
  if (active && user.subscription_plan === 'pro' && plan === 'plus') {
    throw badRequest('You are already on the PRO plan. You can switch to PLUS when it expires.');
  }

  // Upgrading Plus -> Pro: credit the unused value of the remaining days.
  let cost: number = option.cost_iqd;
  let creditNote = '';
  if (active && user.subscription_plan === 'plus' && plan === 'pro') {
    const remainingDays = Math.max(0, Math.ceil((user.subscription_expiry - now) / 86_400_000));
    const perDay = user.subscription_days > 0 ? user.subscription_cost_iqd / user.subscription_days : 0;
    const unused = Math.floor(remainingDays * perDay);
    cost = Math.max(0, cost - unused);
    if (unused > 0) creditNote = ` (credited ${unused} IQD for remaining Plus days)`;
  }

  const exchangeRate = Number(await getSetting(c.env.DB, 'exchangeRate')) || 1400;
  const costUsdCents = Math.ceil((cost * 100) / exchangeRate);

  if (costUsdCents > 0) {
    const txId = await spend(
      c.env.DB, user.id, 'USD', costUsdCents,
      `Subscribe to ${plan.toUpperCase()} ${durationId}${creditNote}`,
      `subscription:${plan}:${durationId}`
    );
    if (!txId) throw badRequest('Insufficient wallet balance for this subscription', 'INSUFFICIENT_BALANCE');
  }

  const expiry = now + option.days * 86_400_000;
  await c.env.DB.prepare(
    `UPDATE users SET subscription_plan = ?, subscription_expiry = ?, subscription_cost_iqd = ?, subscription_days = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  )
    .bind(plan, expiry, option.cost_iqd, option.days, user.id)
    .run();
  await audit(c.env.DB, user.id, 'subscription.subscribe', user.id, { plan, durationId, cost_iqd: cost });
  return c.json({ success: true, plan, expiry, charged_iqd: cost, charged_usd_cents: costUsdCents });
});
