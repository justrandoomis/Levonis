/**
 * «سمعتي» — THE MERCHANT'S OWN REPUTATION, WITH ITS EVIDENCE
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6 «Reputation V2», migration 0163).
 *
 *   GET /api/merchant/reputation   the badges the nightly run earned, each
 *                                  with the figures that earned it; the
 *                                  last 30 / 90 days as numbers (replies,
 *                                  completions, cancellations, lost
 *                                  disputes, the rates the rules compare);
 *                                  the store's «يرد عادةً خلال …» line; the
 *                                  rules themselves, so a badge not yet
 *                                  earned can say what is missing.
 *
 * OWNER-ISOLATED BY CONSTRUCTION: the store comes from the SESSION
 * (`requireStoreOwner`) and nothing in the request names a merchant, a store
 * or a user. The evidence never leaves this route — every public read carries
 * `{key, since}` only (worker/lib/reputation.ts `publicBadges`) — so the
 * answer is `private, no-store`.
 *
 * Mounted at /api/merchant/reputation in worker/index.ts, beside the other
 * workspace reads. Not behind Levo Community's switch: a merchant's standing
 * is theirs to read whether or not the community is open.
 *
 * REFUSALS (stable codes): 401 UNAUTHORIZED · 404 NOT_FOUND (no store) ·
 * 429 RATE_LIMITED.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { requireStoreOwner } from '../lib/merchantAuth';
import { merchantReputation } from '../lib/reputation';

export const merchantReputationRoutes = new Hono<AppContext>();
merchantReputationRoutes.use('*', requireAuth);

merchantReputationRoutes.get('/', async (c) => {
  await rateLimit(c, 'merchant-reputation', 60, 60);
  const ctx = await requireStoreOwner(c);
  const reputation = await merchantReputation(c.env.DB, ctx.merchant.id);
  c.header('Cache-Control', 'private, no-store');
  // Null behind 0163: the page says «قيد الحساب» rather than a row of zeros.
  return c.json({ success: true, reputation });
});
