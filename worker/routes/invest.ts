import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireInvestor } from '../lib/http';

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
  return c.json({ success: true, currency:'USD',unit:'cent',withdrawable:false, investments: investments.results, items, messages: messages.results });
});

investRoutes.post('/messages',c=>c.json({success:false,error:{code:'LEGACY_INVESTMENT_READ_ONLY',message:'سجل الاستثمار القديم محفوظ للقراءة؛ راجع حساب أرباحي'}},410));
