/**
 * «خدماتي» — GET /api/me/services (Services S-P2 spec §6.2; DECISIONS row 238).
 *
 * Signed in; the caller's own devices and trade-ins only (every read is by `user_id = ?`). The
 * answer is the summary the profile card reads: how many devices and open cases, and the one next
 * thing a trade-in asks of the customer, with its date. Price protection and perks arrive with
 * their phases (null now). A database without 0192 answers 503 TRADE_IN_V2_NOT_INSTALLED.
 *
 * And the desk's «الخدمات» badge — GET /api/admin/services/badge (any admin): what waits on the
 * desk (trade-in devices due within a day, received and undecided, to hand back; price-protection
 * claims requested). Counts only, never a figure.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, requireAuth } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { requireTradeInV2, tradeInV2Installed } from '../lib/tradeInSchema';
import { servicesBadge } from '../lib/tradeInAdminQueue';
import { servicesSummary } from '../lib/services/myDevices';

export const myServicesRoutes = new Hono<AppContext>();
myServicesRoutes.use('*', requireAuth);

myServicesRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  await rateLimit(c, 'me_services', 120, 60);
  await requireTradeInV2(c.env.DB);
  const summary = await servicesSummary(c.env, user.id);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, ...summary });
});

export const adminServicesRoutes = new Hono<AppContext>();
adminServicesRoutes.use('*', requireAdmin);

adminServicesRoutes.get('/badge', async (c) => {
  const badge = await servicesBadge(c.env.DB, await tradeInV2Installed(c.env.DB));
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, ...badge });
});
