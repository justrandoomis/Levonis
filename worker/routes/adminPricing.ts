/**
 * «التسعير والشحن» — THE OWNER'S PRICING WORKSPACE, P1: READ ONLY
 * (MVP plan §6 P1; master plan v2 E4 chain; owner decision 2).
 *
 * Mounted at /api/admin/pricing:
 *   GET  /overview?page=N             every ordinary product, 20 a page, with its
 *                                      preliminary §2.3 status and the counts
 *   GET  /products/:id                today's price per model × channel (prepaid
 *                                      and cash on delivery), the old landed cost,
 *                                      the minimum profit and premium derived by
 *                                      answer B, conflicts, measures known or
 *                                      missing, typed member prices (yes/no), and
 *                                      the rate reference
 *   POST /products/:id/what-if        «كم سيصبح السعر؟»: a supplier cost and
 *                                      currency → the engine's new price next to
 *                                      today's, per model × channel
 *
 * THE DOOR: requireAdmin → limitByMethod → requireCostRead, on `use('*')` above
 * every route — every caller but the verified owner is refused before an id is
 * read: 403 COST_ACCESS_DENIED, the same bytes for a real id and an invented
 * one; the owner's own unverified session hears OWNER_EMAIL_UNVERIFIED. Every
 * answer is `private, no-store`.
 *
 * NOTHING WRITES. No route here inserts, updates or deletes a row — no price,
 * no cost, no history, no audit row. The one write a request causes is the
 * rate limiter's own counter (`rate_limits`, worker/lib/ratelimit.ts), which
 * every cost router pays (tests/pricingPreviewNoWrite.test.ts records every
 * statement and hashes every other table before and after).
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, jsonObject, notFound, requireAdmin } from '../lib/http';
import { requireCostRead } from '../lib/costAccess';
import { limitByMethod } from '../lib/ratelimit';
import { SESSION_CACHE_CONTROL } from '../lib/edgePolicy';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { listPricedProducts, loadPreviewContext, loadProducts, loadRateReference, type LoadedProduct } from '../lib/pricingEngine/load';
import { evaluateProduct, evaluateProducts } from '../lib/pricingEngine/compute';
import { overviewDto, productDetailDto, whatIfDto } from '../lib/pricingEngine/dto';
import { parseWhatIf, runWhatIf } from '../lib/pricingEngine/whatIf';

export const adminPricingRoutes = new Hono<AppContext>();

// Private and never stored — the refusals of the door below included (§34).
adminPricingRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', SESSION_CACHE_CONTROL);
});
adminPricingRoutes.use('*', requireAdmin);
// THE DOOR (owner decision 2): the limit first, so a refused caller still
// spends budget, then the owner-only cost guard.
adminPricingRoutes.use('*', limitByMethod(['pricing-read', 1200], ['pricing-write', 600]), requireCostRead);

/** The product page's subject: an ordinary product (a bundle or mystery offer is never engine-priced). */
async function loadOne(db: D1Database, id: string): Promise<LoadedProduct> {
  const loaded = (await loadProducts(db, [id])).get(id);
  if (!loaded) throw notFound('Product not found');
  if ((loaded.doc.composition ?? '') !== '') {
    throw new HttpError(409, serverMessage('COMPOSITION_NOT_PRICEABLE'), 'COMPOSITION_NOT_PRICEABLE');
  }
  return loaded;
}

const pageOf = (raw: string | undefined): number => {
  const n = Number(raw ?? '1');
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
};

adminPricingRoutes.get('/overview', async (c) => {
  const db = c.env.DB;
  const [refs, ctx, reference] = await Promise.all([listPricedProducts(db), loadPreviewContext(db), loadRateReference(db)]);
  // Every product is evaluated for the counts; the catalogue is bounded (41
  // live products, the engine's cap is 60 per apply) and each evaluation is a
  // handful of resolver calls on a document already loaded in chunks.
  const all = await evaluateProducts(db, refs.map((r) => r.id), ctx, reference);
  const typed = all.filter((p) => p.typed_member_prices).length;
  return c.json(overviewDto(all, pageOf(c.req.query('page')), typed));
});

adminPricingRoutes.get('/products/:id', async (c) => {
  const db = c.env.DB;
  const loaded = await loadOne(db, c.req.param('id'));
  const [ctx, reference] = await Promise.all([loadPreviewContext(db), loadRateReference(db)]);
  return c.json(productDetailDto(evaluateProduct(loaded, ctx, reference), reference));
});

adminPricingRoutes.post('/products/:id/what-if', async (c) => {
  const request = parseWhatIf(await jsonObject(c));
  const db = c.env.DB;
  const loaded = await loadOne(db, c.req.param('id'));
  const [ctx, reference] = await Promise.all([loadPreviewContext(db), loadRateReference(db)]);
  return c.json(whatIfDto(runWhatIf(evaluateProduct(loaded, ctx, reference), request, reference)));
});
