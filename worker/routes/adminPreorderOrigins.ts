import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, requireAdmin } from '../lib/http';
import { requireCapability } from '../lib/operations';
import { preorderOriginsView, savePreorderOrigins } from '../lib/preorderOrigins';

/** Supplier evidence stays on its own admin route, never a public order DTO. */
export const adminPreorderOriginRoutes = new Hono<AppContext>();
adminPreorderOriginRoutes.use('/:id/preorder-origins', requireAdmin);
adminPreorderOriginRoutes.get('/:id/preorder-origins', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, ...await preorderOriginsView(c.env.DB, c.req.param('id')) });
});
adminPreorderOriginRoutes.patch('/:id/preorder-origins', async (c) => {
  await requireCapability(c.env, c.get('user')!, 'receive');
  const raw = await c.req.json().catch(() => { throw badRequest('بيانات JSON غير صحيحة', 'PREORDER_ORIGIN_INVALID'); });
  const result = await savePreorderOrigins(c.env.DB, c.req.param('id'), c.get('user')!.id, raw);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, ...result });
});
