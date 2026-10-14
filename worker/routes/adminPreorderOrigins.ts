import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, requireAdmin } from '../lib/http';
import { requireCapability } from '../lib/operations';
import { preorderOriginsView, savePreorderOrigins } from '../lib/preorderOrigins';
import { canWriteCost } from '../lib/adminScope';
import { costRefusal } from '../lib/costAccess';
import { linkPreorderBatch } from '../lib/pricingEngine/v2/linkBatch';

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

/**
 * «اربط بالدفعة الواصلة» (the clean start's V2-6, addendum A.9 step 4): the owner links the received
 * lot(s) to a pre-order line — one batch with the lot decrement; the actual cost replaces the line's
 * frozen estimate. Owner-only (cost write); the same refusal for a real and an invented id.
 */
adminPreorderOriginRoutes.use('/:id/items/:itemId/link-batch', requireAdmin);
adminPreorderOriginRoutes.post('/:id/items/:itemId/link-batch', async (c) => {
  const user = c.get('user')!;
  if (!canWriteCost(c.env, user)) throw costRefusal(c.env, user);
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await linkPreorderBatch(c.env.DB, {
    orderId: c.req.param('id'),
    itemId: c.req.param('itemId'),
    lotIds: raw.lot_ids,
    operationId: raw.operation_id,
    actor: user.id,
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, ...result });
});
