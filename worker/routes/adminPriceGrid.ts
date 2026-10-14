import { Hono, type Context } from 'hono';
import { serverMessage } from '@levonis/contracts/costRefusals';
import type { AppContext } from '../lib/types';
import { HttpError, requireAdmin } from '../lib/http';
import { canViewCost } from '../lib/adminScope';
import { costRefusal } from '../lib/costAccess';

/**
 * QUICK EDIT — CLOSED BY THE CLEAN START (the owner's answer Q6, DECISIONS row
 * 222; implementation spec addendum A.6).
 *
 * The price grid read and wrote a product's old dinar ladder cell by cell —
 * the product, option, colour, variant, order-type and route prices, their
 * PRIME/PRO rungs, the cost cells, the bulk and copy tools, the undo over
 * `price_history`, the price history read and the supplier-cost change. Every
 * product is priced in dollars now, in section ٣ «الأسعار» of the product form
 * (V2): no manual dinar price, no typed member price, no legacy cost cell
 * remains. Each route answers 409 PRICING_V2_MANAGED naming the section, for
 * every product, real or invented (one release, so a stale admin bundle reads
 * a sentence; deleted in V2-7). The traits route (sale types, routes and lead
 * times) names section ٥ «الخيارات والألوان», where the V2 product save owns them.
 *
 * `price_history` itself stays: price protection reads it.
 */

export const adminPriceGridRoutes = new Hono<AppContext>();
adminPriceGridRoutes.use('*', requireAdmin);

/** 409 PRICING_V2_MANAGED {section}: codes and the section only, never a value. */
const refuse = (section: 3 | 5) => () => {
  throw new HttpError(409, serverMessage('PRICING_V2_MANAGED'), 'PRICING_V2_MANAGED', { section, v2: true });
};
/**
 * The owner-only (COST) doors keep their guard in front of the closed sign: every
 * other admin hears the one COST_ACCESS_DENIED answer (or the owner's
 * OWNER_EMAIL_UNVERIFIED way out) exactly as before the clean start.
 */
const refuseCost = (section: 3 | 5) => (c: Context<AppContext>) => {
  const admin = c.get('user')!;
  if (!canViewCost(c.env, admin)) throw costRefusal(c.env, admin);
  return refuse(section)();
};

adminPriceGridRoutes.get('/:id/price-grid', refuse(3));
adminPriceGridRoutes.patch('/:id/price-grid', refuse(3));
adminPriceGridRoutes.patch('/:id/price-grid/traits', refuse(5));
adminPriceGridRoutes.post('/:id/price-grid/bulk', refuse(3));
adminPriceGridRoutes.post('/:id/price-grid/copy', refuseCost(3));
adminPriceGridRoutes.post('/:id/price-grid/undo', refuse(3));
adminPriceGridRoutes.get('/:id/price-history', refuseCost(3));
adminPriceGridRoutes.post('/:id/price-grid/cost-change', refuseCost(3));
