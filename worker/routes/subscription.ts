import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, oneOf, str } from '../lib/http';
import { getLaunchConfig } from '../lib/entitlements';
import { rateLimit } from '../lib/ratelimit';
import { subscribeUser } from './memberships';

/**
 * Legacy /api/subscription compatibility layer. The membership catalog now
 * lives in the membership_plans table (seeded by migration 0002 — the DB is
 * authoritative; the old hardcoded price table is gone because its PRO
 * 6mo/1yr prices conflicted with the mandated single PRO 12mo plan).
 * Purchases delegate to subscribeUser in routes/memberships.ts so both the
 * old and new endpoints share one idempotent, launch-aware implementation.
 */
export const subscriptionRoutes = new Hono<AppContext>();

interface PlanRow {
  id: string;
  tier: 'plus' | 'pro' | 'prime';
  duration_months: number;
  price_iqd: number | null; // NULL = unpriced: NOT purchasable (never truthiness)
  sort: number;
}

/** '1mo'/'3mo'/'6mo'/'12mo' from duration_months; legacy '1yr' maps to 12. */
function legacyDurationId(months: number): string {
  return `${months}mo`;
}
function legacyDays(months: number): number {
  return months === 12 ? 365 : months * 30;
}
function normalizeDurationId(durationId: string): string {
  return durationId === '1yr' ? '12mo' : durationId;
}

subscriptionRoutes.get('/plans', async (c) => {
  const [{ results }, launch] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, tier, duration_months, price_iqd, sort FROM membership_plans WHERE active = 1 ORDER BY sort, duration_months'
    ).all<PlanRow>(),
    getLaunchConfig(c.env.DB),
  ]);

  // Legacy shape: { plus: [{id, cost_iqd, days}], pro: [...] }. Unpriced
  // plans are honestly omitted — old clients would render them as buyable.
  const legacy: Record<'plus' | 'pro', Array<{ id: string; cost_iqd: number; days: number }>> = {
    plus: [],
    pro: [],
  };
  for (const p of results) {
    if (p.price_iqd === null) continue;
    // LEVO PRIME has no slot in this legacy two-tier shape, and inventing one
    // would crash old clients. PRIME is sold through /api/memberships/plans.
    if (p.tier !== 'plus' && p.tier !== 'pro') continue;
    legacy[p.tier].push({
      id: legacyDurationId(p.duration_months),
      cost_iqd: p.price_iqd,
      days: legacyDays(p.duration_months),
    });
  }

  return c.json({
    success: true,
    plans: legacy,
    membership_plans: results.map((p) => ({
      id: p.id,
      tier: p.tier,
      duration_months: p.duration_months,
      price_iqd: p.price_iqd,
      purchasable: p.price_iqd !== null,
      sort: p.sort,
    })),
    launch: { launch_at: launch.launch_at, activated: launch.activated },
  });
});

subscriptionRoutes.post('/subscribe', requireAuth, async (c) => {
  await rateLimit(c, 'subscribe', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const plan = oneOf(body.plan, 'plan', ['plus', 'pro'] as const);
  const durationId = normalizeDurationId(str(body.durationId, 'durationId', { min: 1, max: 10 }));
  const planId = `${plan}_${durationId}`;

  // Old clients send no idempotency key; derive a stable per-user, per-plan,
  // per-day key so an accidental double-tap replays instead of double-charging.
  let idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { max: 80, required: false });
  if (!idempotencyKey) {
    idempotencyKey = `legacy:${user.id}:${planId}:${new Date().toISOString().slice(0, 10)}`;
  }
  if (idempotencyKey.length < 8) throw badRequest('idempotencyKey is too short');

  const r = await subscribeUser(c.env, user, planId, idempotencyKey);
  return c.json({
    success: true,
    plan,
    // Legacy field: epoch ms; 0 while the membership is prepaid pre-launch.
    expiry: r.membership.expires_at ? Date.parse(String(r.membership.expires_at)) : 0,
    charged_iqd: r.charged_iqd,
    charged_usd_cents: r.charged_usd_cents,
    state: r.membership.state,
    membership_id: r.membership.id,
    replay: r.replay,
  });
});
