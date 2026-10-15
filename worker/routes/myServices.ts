/**
 * «خدماتي» — GET /api/me/services (Services S-P2 spec §6.2; DECISIONS row 238).
 *
 * Signed in; the caller's own devices and trade-ins only (every read is by `user_id = ?`). The
 * answer is the summary the profile card reads: how many devices and open cases, and the one next
 * thing a trade-in asks of the customer, with its date. Price protection and perks arrive with
 * their phases (null now). A database without 0192 answers 503 TRADE_IN_V2_NOT_INSTALLED.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { requireTradeInV2 } from '../lib/tradeInSchema';
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
