/**
 * «التسعير والشحن» — THE OWNER'S PRICING WORKSPACE, P1: READ ONLY
 * (MVP plan §6 P1; master plan v2 E4 chain; owner decision 2).
 *
 * Mounted at /api/admin/pricing:
 *   GET  /overview?page=N             every ordinary product, 20 a page, with its
 *                                      preliminary §2.3 status and the counts
 *   GET  /products/:id                today's price per model × channel (prepaid
 *                                      and cash on delivery), the old landed cost,
 *                                      the minimum profit and Direct Sale Extra derived by
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
 * NOTHING ABOVE WRITES. No P1 route inserts, updates or deletes a row — no
 * price, no cost, no history, no audit row. The one write such a request
 * causes is the rate limiter's own counter (`rate_limits`,
 * worker/lib/ratelimit.ts), which every cost router pays
 * (tests/pricingPreviewNoWrite.test.ts records every statement and hashes
 * every other table before and after).
 *
 * FX-1 (FX programme plan §8) adds the central rates below — the owner's
 * reads and writes of the exchange rates and the central shipping rates:
 *   GET  /rates                          the three pairs, the derived IQD rates, shipping, budgets
 *   GET  /rates/history?pair&before&limit the private history (≤ 100 a page)
 *   PUT  /rates/fx/:pair/settings        mode, interval, adjustment, thresholds, bounds
 *   PUT  /rates/fx/:pair/manual          a manual rate
 *   POST /rates/fx/:pair/confirm         «تأكيد السعر الحالي» (the drift anchor)
 *   POST /rates/fx/refresh               «تحديث الآن»
 *   POST /rates/fx/:pair/review          approve / reject / keep as manual
 *   PUT  /rates/shipping/:profile        a central shipping rate in IQD
 * They write rates, never a product price (repricing is FX-5).
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, jsonObject, notFound, requireAdmin } from '../lib/http';
import { assertCostWrite, requireCostRead, requireFreshSession } from '../lib/costAccess';
import { limitByMethod, rateLimit } from '../lib/ratelimit';
import { SESSION_CACHE_CONTROL, originOf, purgeCatalogueFromJob } from '../lib/edgePolicy';
import { auditStatements } from '../lib/audit';
import { fence } from '../lib/operations';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { ratioExceedsPct, sumOfMoves } from '@levonis/pricing/fxChain';
import { fxKeyConfigured, runFxScheduler } from '../lib/fx/scheduler';
import { iso, isMissingTable, loadPairs, type FxPairId, type FxPairRow } from '../lib/fx/pairs';
import { isFenceMiss, planPairBatch, refusalCodeOf } from '../lib/fx/commit';
import { toStatements } from '../lib/fx/write';
import { historyItemDto, ratesDto } from '../lib/fx/dto';
import { engineProductCount, loadHistory, loadRatesReadModel } from '../lib/fx/read';
import { notifyOwnerFx } from '../lib/fx/notify';
import {
  FX_REFRESH_BUCKET,
  FX_REFRESH_GLOBAL_BUCKET,
  FX_REFRESH_GLOBAL_KEY,
  FX_REFRESH_GLOBAL_LIMIT,
  FX_REFRESH_GLOBAL_WINDOW_S,
  FX_REFRESH_LIMIT,
  FX_REFRESH_WINDOW_S,
} from '../lib/fx/limits';
import {
  LARGE_CHANGE_PCT,
  fxRefusal,
  largeChange,
  pairParam,
  parseRefresh,
  parseShipping,
  planConfirm,
  planManualSet,
  planReview,
  planSettings,
  type PlannedAct,
} from '../lib/fx/ownerActs';
import { listPricedProducts, loadPreviewContext, loadProducts, loadRateReference, type LoadedProduct } from '../lib/pricingEngine/load';
import { evaluateProduct, evaluateProducts } from '../lib/pricingEngine/compute';
import { overviewDto, productDetailDto, whatIfDto } from '../lib/pricingEngine/dto';
import { inputInvalid, parseWhatIf, runWhatIf } from '../lib/pricingEngine/whatIf';

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

// ============================================================= FX-1: the central rates
//
// FX programme plan §8 (owner brief 2026-10-08 §3–§10, §21, §27–§31). Behind
// the SAME door as every route above: requireAdmin → the pricing-read/write
// limit → requireCostRead; every write adds assertCostWrite. Owner acts are
// fenced on the pair's `owner_version` (a routine check never moves it), and
// a write that moves an effective rate is fenced on all three pairs'
// `effective_version` too. Bodies are allow-lists. A database without
// migration 0179 answers 503 PRICING_NOT_INSTALLED. NO PRODUCT PRICE IS
// WRITTEN HERE: repricing arrives in FX-5.

const fxNotInstalled = () => new HttpError(503, serverMessage('PRICING_NOT_INSTALLED'), 'PRICING_NOT_INSTALLED');
const newFxLogId = () => `fxl_${crypto.randomUUID()}`;

async function fxRows(db: D1Database): Promise<FxPairRow[]> {
  const rows = await loadPairs(db);
  if (rows === null) throw fxNotInstalled();
  return rows;
}

async function ratesAnswer(c: Context<AppContext>, extra: Record<string, unknown> = {}) {
  const now = new Date();
  const model = await loadRatesReadModel(c.env.DB, now);
  if (!model) throw fxNotInstalled();
  return c.json({ ...ratesDto(fxKeyConfigured(c.env), model, now), ...extra });
}

/** §7.8: a move above 15% — or the owner's acts of the last 24 h above 15% — needs the explicit confirmation and a fresh sign-in. */
async function largeChangeGate(c: Context<AppContext>, pair: FxPairId, move: PlannedAct['move'], confirm: boolean, now: Date): Promise<void> {
  if (!move) return;
  const lc = await largeChange(c.env.DB, pair, move.before, move.after, now);
  if (!lc.act && !lc.cumulative) return;
  if (!confirm) throw fxRefusal(409, 'PRICING_LARGE_CHANGE_CONFIRM');
  requireFreshSession(c);
}

/** Price-moving owner acts need a fresh sign-in once any product is engine-priced (§7.8; none is in FX-1). */
async function priceMovingGate(c: Context<AppContext>, moves: boolean): Promise<void> {
  if (moves && (await engineProductCount(c.env.DB)) > 0) requireFreshSession(c);
}

/** Both refresh buckets (critique F4): 10 an hour per user, 40 a day for the shop. */
async function chargeRefresh(c: Context<AppContext>): Promise<void> {
  await rateLimit(c, FX_REFRESH_BUCKET, FX_REFRESH_LIMIT, FX_REFRESH_WINDOW_S);
  await rateLimit(c, FX_REFRESH_GLOBAL_BUCKET, FX_REFRESH_GLOBAL_LIMIT, FX_REFRESH_GLOBAL_WINDOW_S, FX_REFRESH_GLOBAL_KEY);
}

/** One owner act, committed in one batch; the display rate's caches purged and the bell rung after. */
async function commitAct(c: Context<AppContext>, planned: PlannedAct, rows: readonly FxPairRow[], now: Date): Promise<void> {
  const actor = c.get('user')!.id;
  const plan = planPairBatch(planned.changes, rows, { fence: 'owner', actor, nowIso: iso(now), newLogId: newFxLogId });
  try {
    await c.env.DB.batch(await toStatements(c.env.DB, plan, actor));
  } catch (e) {
    if (isFenceMiss(e)) throw fxRefusal(409, 'PRICING_CHANGED');
    const code = refusalCodeOf(e);
    if (code === 'FX_DERIVED_STALE' || code === 'FX_VERSION_DISCIPLINE') throw fxRefusal(409, 'FX_DERIVED_STALE');
    if (/CHECK constraint failed/i.test(e instanceof Error ? e.message : String(e))) throw fxRefusal(400, 'FX_RATE_OUT_OF_BOUNDS');
    throw e;
  }
  if (plan.displayRateChanged) await purgeCatalogueFromJob(c.env, [], { settings: true, origin: originOf(c) });
  if (planned.attention.length) await notifyOwnerFx(c.env, planned.attention);
}

const pairRow = (rows: readonly FxPairRow[], pair: FxPairId): FxPairRow => rows.find((r) => r.pair === pair)!;

adminPricingRoutes.get('/rates', (c) => ratesAnswer(c));

adminPricingRoutes.get('/rates/history', async (c) => {
  const pairRaw = c.req.query('pair');
  const pair = pairRaw === undefined || pairRaw === '' ? null : pairParam(pairRaw);
  const beforeRaw = c.req.query('before');
  let before: string | null = null;
  if (beforeRaw !== undefined && beforeRaw !== '') {
    const ms = beforeRaw.length <= 30 ? Date.parse(beforeRaw) : NaN;
    if (!Number.isFinite(ms)) throw inputInvalid('before');
    before = iso(ms);
  }
  const limitRaw = c.req.query('limit');
  const limit = limitRaw === undefined || limitRaw === '' ? 50 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw inputInvalid('limit');
  const items = await loadHistory(c.env.DB, { pair, before, limit });
  if (items === null) throw fxNotInstalled();
  return c.json({ success: true, items: items.map(historyItemDto) });
});

adminPricingRoutes.put('/rates/fx/:pair/settings', async (c) => {
  assertCostWrite(c);
  const pair = pairParam(c.req.param('pair'));
  const body = await jsonObject(c);
  const now = new Date();
  const rows = await fxRows(c.env.DB);
  const planned = planSettings(pairRow(rows, pair), body, { actor: c.get('user')!.id, now });
  if (!planned) return ratesAnswer(c);
  // §7.8: a guard setting, the mode or the interval weaken or move the guard without moving a price — always a fresh sign-in.
  if (planned.guard) requireFreshSession(c);
  await priceMovingGate(c, planned.move !== null);
  await largeChangeGate(c, pair, planned.move, planned.confirm, now);
  // Back to automatic fetches at once: it charges the refresh buckets like «تحديث الآن» (critique F4).
  if (planned.backToAuto) await chargeRefresh(c);
  await commitAct(c, planned, rows, now);
  if (planned.backToAuto) {
    await runFxScheduler(c.env, { now: new Date() }, { trigger: 'back_to_auto', pairs: [pair], actorId: c.get('user')!.id });
  }
  return ratesAnswer(c);
});

adminPricingRoutes.put('/rates/fx/:pair/manual', async (c) => {
  assertCostWrite(c);
  const pair = pairParam(c.req.param('pair'));
  const body = await jsonObject(c);
  const now = new Date();
  const rows = await fxRows(c.env.DB);
  const planned = planManualSet(pairRow(rows, pair), body, { actor: c.get('user')!.id, now });
  await priceMovingGate(c, true);
  await largeChangeGate(c, pair, planned.move, planned.confirm, now);
  await commitAct(c, planned, rows, now);
  return ratesAnswer(c);
});

adminPricingRoutes.post('/rates/fx/:pair/confirm', async (c) => {
  assertCostWrite(c);
  const pair = pairParam(c.req.param('pair'));
  const body = await jsonObject(c);
  const now = new Date();
  const rows = await fxRows(c.env.DB);
  const planned = planConfirm(pairRow(rows, pair), body, { actor: c.get('user')!.id, now });
  // «تأكيد السعر الحالي» widens what may move automatically: always a fresh sign-in (§7.8).
  requireFreshSession(c);
  await commitAct(c, planned, rows, now);
  return ratesAnswer(c);
});

adminPricingRoutes.post('/rates/fx/refresh', async (c) => {
  assertCostWrite(c);
  const pairs = parseRefresh(await jsonObject(c));
  await fxRows(c.env.DB);
  await chargeRefresh(c);
  const report = await runFxScheduler(c.env, { now: new Date() }, { trigger: 'refresh', pairs, actorId: c.get('user')!.id });
  if (report.skipped === 'NOT_INSTALLED') throw fxNotInstalled();
  if (report.leaseHeld.length > 0 && report.checked.length === 0) throw fxRefusal(409, 'FX_REFRESH_IN_PROGRESS');
  return ratesAnswer(c, { report: { checked: report.checked, lease_held: report.leaseHeld, budget_deferred: report.budgetDeferred } });
});

adminPricingRoutes.post('/rates/fx/:pair/review', async (c) => {
  assertCostWrite(c);
  const pair = pairParam(c.req.param('pair'));
  const body = await jsonObject(c);
  const now = new Date();
  const rows = await fxRows(c.env.DB);
  const planned = planReview(pairRow(rows, pair), body, { actor: c.get('user')!.id, now });
  if (planned.decision === 'approve') {
    await priceMovingGate(c, true);
    await largeChangeGate(c, pair, planned.move, planned.confirm, now);
  }
  await commitAct(c, planned, rows, now);
  return ratesAnswer(c);
});

adminPricingRoutes.put('/rates/shipping/:profile', async (c) => {
  assertCostWrite(c);
  const input = parseShipping(c.req.param('profile'), await jsonObject(c));
  const db = c.env.DB;
  const now = new Date();
  let row: { rate_iqd: string | null; version: number } | null;
  try {
    row = await db.prepare('SELECT rate_iqd, version FROM pricing_shipping_rates WHERE profile = ?').bind(input.profile).first();
  } catch (e) {
    if (isMissingTable(e)) throw fxNotInstalled();
    throw e;
  }
  if (!row) throw fxNotInstalled();
  if (row.version !== input.version) throw fxRefusal(409, 'PRICING_CHANGED');
  await priceMovingGate(c, true);
  // §21: dinars per kg or per CBM; §7.8 per act (its history carries no value before FX-2's pricing_audit).
  if (row.rate_iqd !== null && ratioExceedsPct(sumOfMoves([{ before: row.rate_iqd, after: input.rate }]), LARGE_CHANGE_PCT)) {
    if (!input.confirm) throw fxRefusal(409, 'PRICING_LARGE_CHANGE_CONFIRM');
    requireFreshSession(c);
  }
  const actor = c.get('user')!.id;
  const statements = [
    ...fence(db, 'EXISTS(SELECT 1 FROM pricing_shipping_rates WHERE profile=? AND version=?)', [input.profile, input.version]),
    db
      .prepare('UPDATE pricing_shipping_rates SET rate_iqd = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE profile = ? AND version = ?')
      .bind(input.rate, actor, iso(now), input.profile, input.version),
    ...(await auditStatements(db, actor, 'shipping.rate.update', input.profile, { profile: input.profile })).statements,
  ];
  try {
    await db.batch(statements);
  } catch (e) {
    if (isFenceMiss(e)) throw fxRefusal(409, 'PRICING_CHANGED');
    throw e;
  }
  return ratesAnswer(c);
});
