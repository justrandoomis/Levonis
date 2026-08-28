import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireInvestor, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';

/**
 * Investor portal (customer side). Investments themselves are created and
 * managed only by admins (see admin routes) — the browser can no longer
 * insert its own investments or profits.
 */
export const investRoutes = new Hono<AppContext>();
investRoutes.use('*', requireInvestor);

investRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const [investments, messages] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all(),
    c.env.DB.prepare('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 500')
      .bind(user.id)
      .all(),
  ]);
  const items: Record<string, unknown[]> = {};
  for (const inv of investments.results) {
    const { results } = await c.env.DB.prepare('SELECT * FROM investment_items WHERE investment_id = ?')
      .bind(inv.id)
      .all();
    items[String(inv.id)] = results;
  }
  return c.json({ success: true, investments: investments.results, items, messages: messages.results });
});

investRoutes.post('/messages', async (c) => {
  await rateLimit(c, 'invest-msg', 60, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const message = str(body.message, 'message', { min: 1, max: 2000 });
  const id = newId('imsg');
  await c.env.DB.prepare(
    "INSERT INTO investor_messages (id, user_id, sender, message) VALUES (?, ?, 'user', ?)"
  )
    .bind(id, user.id, message)
    .run();
  return c.json({ success: true, id });
});
