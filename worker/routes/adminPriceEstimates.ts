/**
 * «التسعير التقديري» — THE OWNER'S ESTIMATOR (docs/SMART_PRICING.md §4, §7;
 * migration 0218; DECISIONS rows 278–282).
 *
 * Mounted INSIDE adminPricingRoutes at `/estimates` (worker/routes/
 * adminPricing.ts; the mount line lands with WP15), so it inherits that
 * router's door — requireAdmin → limitByMethod(['pricing-read', 1200],
 * ['pricing-write', 600]) → requireCostRead, and its completeness hook — and
 * `/api/admin/pricing` is already `admin:owner` at the gateway. It also
 * declares its own `use('*', requireCostRead)`, so it is never served without
 * the owner-only guard (tests/costPredicateUsage.test.ts LATER_ROUTERS pins
 * it): every other caller hears 403 COST_ACCESS_DENIED, the same bytes as
 * every cost route. Every write calls assertCostWrite.
 *
 *   GET  /control                    the two switches, and whether the purchase policy carries the clause
 *   PUT  /control                    {version, apply_enabled?, ordering_enabled?}
 *   GET  /types                      every type with its figures (T × U below one step is warned)
 *   POST /types                      a new type key (every figure empty)
 *   PUT  /types/:key                 {version, …figures} — version-fenced, audited
 *   GET  /types/:key/suggest         the median of the real package measures of its products (never saved)
 *   POST /compute                    {cursor | product_ids[≤10]} — previews stored, no V2 table written
 *   POST /apply                      {items[≤5] | cursor} — one atomic batch per product, within the budget
 *   GET  /products?state=&cursor=    the stored previews, 25 a page
 *   GET  /products/:id               one product's stored preview (an estimated one with its `confirm_gate`, §4.9)
 *   PUT  /products/:id               {version, state?, type_key?, sourcing_override?, route_override?}
 *   POST /products/:id/confirm       {version, accept_flags, combo_keys?, real_measures?} — the label removed, or firm SKUs
 *
 * OWNER-ONLY DATA (invariant I6): supplier prices, R, types, measures, flags.
 * Every answer is `private, no-store`.
 *
 * DEPLOY-AHEAD (§2.4): on a database without 0218 every route answers 503
 * PRICE_ESTIMATES_NOT_INSTALLED (probed once per binding, after the door).
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { jsonObject, notFound } from '../lib/http';
import { assertCostWrite, requireCostRead } from '../lib/costAccess';
import { SESSION_CACHE_CONTROL, afterCatalogueWrite } from '../lib/edgePolicy';
import { priceEstimatesInstalled } from '../lib/priceEstimateLabel';
import {
  createType,
  estimatePolicyInForce,
  estimateRefusal,
  inputInvalid,
  loadControl,
  loadTypes,
  setControl,
  strictObject,
  suggestTypeMeasures,
  typeAnswers,
  updateType,
} from '../lib/pricingEngine/estimate/control';
import { LIST_FILTERS, computeEstimates, listEstimates, storedEstimateOf, type ListFilter } from '../lib/pricingEngine/estimate/compute';
import { applyEstimates, parseApplyItems } from '../lib/pricingEngine/estimate/apply';
import { confirmEstimate, confirmGateOf, setEstimateProduct } from '../lib/pricingEngine/estimate/confirm';

export const adminPriceEstimatesRoutes = new Hono<AppContext>();

// Private and never stored — the refusals included.
adminPriceEstimatesRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', SESSION_CACHE_CONTROL);
});
// THE DOOR (owner decision 2): owner only, before any route reads an id.
adminPriceEstimatesRoutes.use('*', requireCostRead);

const actorOf = (c: Context<AppContext>): string => c.get('user')!.id;
const PRODUCT_ID = /^[A-Za-z0-9_:.-]{1,80}$/;

/** 503 PRICE_ESTIMATES_NOT_INSTALLED on a database without 0218 (asked after the door, so only the owner hears it). */
async function installed(c: Context<AppContext>): Promise<void> {
  if (!(await priceEstimatesInstalled(c.env.DB))) throw estimateRefusal('PRICE_ESTIMATES_NOT_INSTALLED');
}

/* -------------------------------------------------------------- the switches -- */

adminPriceEstimatesRoutes.get('/control', async (c) => {
  await installed(c);
  const control = await loadControl(c.env.DB);
  if (!control) throw estimateRefusal('PRICE_ESTIMATES_NOT_INSTALLED');
  return c.json({ success: true, control, policy_ready: estimatePolicyInForce() });
});

adminPriceEstimatesRoutes.put('/control', async (c) => {
  assertCostWrite(c);
  await installed(c);
  // No fresh sign-in: no pricing act asks for one (owner decision 2026-11-02, DECISIONS row 285).
  const control = await setControl(c.env.DB, await jsonObject(c), actorOf(c), new Date());
  return c.json({ success: true, control, policy_ready: estimatePolicyInForce() });
});

/* ----------------------------------------------------------------- the types -- */

adminPriceEstimatesRoutes.get('/types', async (c) => {
  await installed(c);
  return c.json({ success: true, types: await typeAnswers(c.env.DB, await loadTypes(c.env.DB)) });
});

adminPriceEstimatesRoutes.post('/types', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const type = await createType(c.env.DB, await jsonObject(c), actorOf(c), new Date());
  return c.json({ success: true, type: (await typeAnswers(c.env.DB, [type]))[0] }, 201);
});

adminPriceEstimatesRoutes.put('/types/:key', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const type = await updateType(c.env.DB, c.req.param('key'), await jsonObject(c), actorOf(c), new Date());
  return c.json({ success: true, type: (await typeAnswers(c.env.DB, [type]))[0] });
});

adminPriceEstimatesRoutes.get('/types/:key/suggest', async (c) => {
  await installed(c);
  return c.json({ success: true, suggestion: await suggestTypeMeasures(c.env.DB, c.req.param('key')) });
});

/* --------------------------------------------------------- compute and apply -- */

adminPriceEstimatesRoutes.post('/compute', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const body = strictObject(await jsonObject(c), ['cursor', 'product_ids']);
  if (body.cursor !== undefined && body.product_ids !== undefined) throw inputInvalid('cursor');
  const user = c.get('user')!;
  const answer = await computeEstimates(c.env.DB, body, { env: c.env, user, actor: user.id, now: new Date() });
  return c.json({ success: true, ...answer });
});

adminPriceEstimatesRoutes.post('/apply', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const body = strictObject(await jsonObject(c), ['items', 'cursor']);
  if ((body.items === undefined) === (body.cursor === undefined)) throw inputInvalid('items');
  const items = parseApplyItems(body.items ?? body.cursor);
  return c.json({ success: true, ...(await applyEstimates(c, items)) });
});

/* -------------------------------------------------------------- the products -- */

adminPriceEstimatesRoutes.get('/products', async (c) => {
  await installed(c);
  const raw = c.req.query('state') ?? 'all';
  if (!(LIST_FILTERS as readonly string[]).includes(raw)) throw inputInvalid('state');
  const cursor = c.req.query('cursor') ?? '';
  if (cursor !== '' && !PRODUCT_ID.test(cursor)) throw inputInvalid('cursor');
  return c.json({ success: true, state: raw, ...(await listEstimates(c.env.DB, raw as ListFilter, cursor)) });
});

adminPriceEstimatesRoutes.get('/products/:id', async (c) => {
  await installed(c);
  const pid = c.req.param('id');
  if (!PRODUCT_ID.test(pid)) throw notFound();
  const product = await storedEstimateOf(c.env.DB, pid);
  if (!product) throw notFound();
  if (product.state !== 'estimated') return c.json({ success: true, product });
  // What the confirmation asks of the measures now (§4.9): the sheet's live hold, null on any failed read.
  return c.json({ success: true, product: { ...product, confirm_gate: await confirmGateOf(c.env.DB, pid) } });
});

adminPriceEstimatesRoutes.put('/products/:id', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const pid = c.req.param('id');
  const settings = await setEstimateProduct(c.env.DB, pid, await jsonObject(c), actorOf(c), new Date());
  return c.json({ success: true, settings });
});

adminPriceEstimatesRoutes.post('/products/:id/confirm', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const pid = c.req.param('id');
  const confirmed = await confirmEstimate(c.env.DB, pid, await jsonObject(c), actorOf(c), new Date());
  // The customer pages drop the label now (the whole product), or the firm SKUs' (some).
  const slug = await c.env.DB.prepare('SELECT slug FROM products WHERE id = ?').bind(pid).first<{ slug: string }>();
  await afterCatalogueWrite(c, slug?.slug ? [slug.slug] : []);
  c.set('completenessIds', [pid]);
  return c.json({ success: true, ...confirmed });
});
