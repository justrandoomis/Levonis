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
 *   PUT  /rates/fx/:pair/settings        mode, interval, market_adjustment_iqd, thresholds, bounds
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
import { FX_REFRESH_GLOBAL_KEY } from '../lib/fx/limits';
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
  strictBody,
  type PlannedAct,
} from '../lib/fx/ownerActs';
import { listPricedProducts, loadPreviewContext, loadProducts, loadRateReference, type LoadedProduct } from '../lib/pricingEngine/load';
import { evaluateProduct, evaluateProducts } from '../lib/pricingEngine/compute';
import { overviewDto, productDetailDto, whatIfDto } from '../lib/pricingEngine/dto';
import { inputInvalid, parseWhatIf, runWhatIf } from '../lib/pricingEngine/whatIf';
import { engineCoreInstalled } from '../lib/engineInstalled';
import { loadPricingRates, type PricingRates } from '../lib/pricingEngine/rates';
import {
  batchHead,
  batchTail,
  inputImage,
  inputStatements,
  inputWriteIsNoop,
  loadProductPricing,
  loadProductsPricing,
  nextInputRow,
  pricingAuditStatement,
  ruleImage,
  ruleStatements,
  ruleWriteIsNoop,
  type ProductPricingData,
  type RuleWrite,
} from '../lib/pricingEngine/store';
import { MinimumProfitError, parseMinimumProfit, purchaseIneligibility, type MinimumProfitDraft, type PurchaseForPricing } from '../lib/pricingEngine/fromPurchase';
import { lineSummary, previewProduct, type PreviewOptions, type ProductPreview } from '../lib/pricingEngine/procurementPreview';
import { lineDto, productPreviewDto, ratesHeadDto, storedRulesDto } from '../lib/pricingEngine/procurementDto';
import { legacyAcceptWrites, parseRuleWrites } from '../lib/pricingEngine/ownerRules';
import { evaluateLegacy } from '../lib/pricingEngine/legacy';
import { legacyHashOf } from '../lib/pricingEngine/legacyHash';
import { parseProcurementDraft } from '../lib/procurementDraft';
import { committedPurchaseForPricing, draftForPricing } from '../lib/pricingEngine/purchaseRead';
import { parseProductInputs, productInputsAnswer } from '../lib/pricingEngine/productInputs';

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
  const evaluation = evaluateProduct(loaded, ctx, reference);
  // `legacy_hash` fences «قبول القيم المرحّلة» on the values shown here (POST …/targets/adopt).
  return c.json({ ...productDetailDto(evaluation, reference), legacy_hash: await legacyHashOf(evaluation.rules) });
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

/**
 * Both refresh buckets (critique F4): 10 an hour per user, 40 a day for the shop.
 *
 * The bucket, the limit and the window are LITERALS here on purpose. The
 * gateway's rate-limit parity test (services/gateway/test/rateLimitParity.test.ts)
 * reads every rate-limit call in worker/routes from the source and compares
 * its numbers with the gateway class over the same prefix; an imported
 * constant is a number it cannot read. worker/lib/fx/limits.ts still exports
 * the same values — the owner panel's day budget and its count read them —
 * and tests/fxRefreshLimitsLiteral.test.ts fails the moment the two differ.
 */
async function chargeRefresh(c: Context<AppContext>): Promise<void> {
  await rateLimit(c, 'fx-refresh', 10, 3600);
  await rateLimit(c, 'fx-refresh-global', 40, 86_400, FX_REFRESH_GLOBAL_KEY);
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
  // The public settings carry the USD rate AND whether it is the provider's figure or one the owner
  // typed (`displayUsdRateAttributed`, FX-1 review #10): a change of either purges them.
  const usdSourceChanged = planned.changes.some(
    (ch) => ch.pair === 'USD_IQD' && ch.set.effective_source !== undefined && ch.set.effective_source !== ch.row.effective_source
  );
  if (plan.displayRateChanged || usdSourceChanged) await purgeCatalogueFromJob(c.env, [], { settings: true, origin: originOf(c) });
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
  // The cursor is (created_at, row): one batch stamps all its rows with the
  // same time, so `before` alone dropped the rest of a batch at a page edge
  // (FX-1 correctness review C4). `before_id` is the last row's id.
  const beforeIdRaw = c.req.query('before_id');
  let beforeId: string | null = null;
  if (beforeIdRaw !== undefined && beforeIdRaw !== '') {
    if (before === null || !/^[A-Za-z0-9_-]{1,80}$/.test(beforeIdRaw)) throw inputInvalid('before_id');
    beforeId = beforeIdRaw;
  }
  const limitRaw = c.req.query('limit');
  const limit = limitRaw === undefined || limitRaw === '' ? 50 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw inputInvalid('limit');
  const items = await loadHistory(c.env.DB, { pair, before, beforeId, limit });
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
  // THE ADJUSTMENT TOO, always (owner decision 5; WP-FX1A role table): it moves the effective USD
  // rate, and with it the public displayUsdRate, by a fixed number of dinars with no market guard
  // in between — on a stale session, up to 15% a day. Asked here, not through GUARD_FIELDS: it is
  // not a guard setting, so it rings no guard-change notice.
  if (planned.guard || planned.fields.includes('market_adjustment_iqd')) requireFreshSession(c);
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
  // «أبقِ سعري الحالي يدويًا» changes the mode: a fresh sign-in, always (§7.8; FX-1 security review #2).
  if (planned.guard) requireFreshSession(c);
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

// ============================================================= Inputs: the current costs and the owner's rules
//
// USD design §2.6, §3, §4, §5, §6.3 (owner brief 2026-10-09). Behind the SAME
// door as every route above (requireAdmin → limit → requireCostRead; every
// write adds assertCostWrite). A database without migration 0181 answers 503
// PRICING_NOT_INSTALLED. These routes write the product's INPUTS and RULES
// only — never a price: the engine's writer adopts and prices a product at the
// owner's completing save (decision 8).
//
//   POST /procurement/preview             the card's 4-cell summary per line, «تفاصيل», and the review preview
//   POST /products/:id/apply-purchase     a confirmed purchase → the product's current costs + typed minimum profits
//   GET  /products/:id/rules              the product's stored rules and its counter
//   PUT  /products/:id/rules              the minimum profit (USD) and the Direct Sale Extra, per product / option
//   POST /products/:id/targets/adopt      «قبول القيم المرحّلة»: the values the old prices carry, as migrated rows
//   GET  /products/:id/inputs             the product form's «التسعير بالدولار»: inputs and rules per scope, each model's bar
//   POST /products/:id/preview            the same answer for a draft {inputs, rules} — read only
//   PUT  /products/:id/inputs             the product form's save: inputs and rules, one atomic batch

const engineNotInstalled = () => new HttpError(503, serverMessage('PRICING_NOT_INSTALLED'), 'PRICING_NOT_INSTALLED');

async function engineRates(db: D1Database): Promise<PricingRates> {
  if (!(await engineCoreInstalled(db))) throw engineNotInstalled();
  const rates = await loadPricingRates(db);
  if (!rates) throw engineNotInstalled();
  return rates;
}

const optionIdsOf = (loaded: LoadedProduct): Set<string> =>
  new Set(loaded.doc.options.filter((o) => o.active !== false && !o.merged_into).map((o) => o.id));

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function booleanMap(raw: unknown, field: string): Map<string, boolean> {
  if (raw === undefined || raw === null) return new Map();
  if (!isRecord(raw) || Object.keys(raw).length > 60) throw inputInvalid(field);
  const out = new Map<string, boolean>();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'boolean' || k.length > 80) throw inputInvalid(field);
    out.set(k, v);
  }
  return out;
}

function stringList(raw: unknown, field: string, max = 60): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > max || raw.some((k) => typeof k !== 'string' || k.length > 200)) throw inputInvalid(field);
  return [...new Set(raw as string[])];
}

/** The owner's typed minimum profits, validated against each product's options (§4.1). */
function minimumProfits(raw: unknown, loaded: ReadonlyMap<string, LoadedProduct>, onlyProduct?: string): Map<string, MinimumProfitDraft[]> {
  const out = new Map<string, MinimumProfitDraft[]>();
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw) || raw.length > 60) throw inputInvalid('minimum_profits');
  const seen = new Set<string>();
  for (const item of raw) {
    const r = strictBody(item, onlyProduct ? ['scope', 'scope_id', 'amount_usd'] : ['product_id', 'scope', 'scope_id', 'amount_usd']);
    const pid = onlyProduct ?? (typeof r.product_id === 'string' ? r.product_id : '');
    const product = loaded.get(pid);
    if (!product) throw inputInvalid('minimum_profits');
    let draft: MinimumProfitDraft;
    try {
      draft = parseMinimumProfit(r, optionIdsOf(product));
    } catch (e) {
      if (e instanceof MinimumProfitError) throw inputInvalid(e.kind === 'amount' ? 'minimum_target_profit_usd' : 'minimum_profits');
      throw e;
    }
    const key = `${pid}:${draft.scope}:${draft.scope_id}`;
    if (seen.has(key)) throw inputInvalid('minimum_profits');
    seen.add(key);
    out.set(pid, [...(out.get(pid) ?? []), draft]);
  }
  return out;
}

/** Products whose prices this purchase was applied to (an apply audit row exists). */
async function appliedProducts(db: D1Database, purchaseId: string | null): Promise<Set<string>> {
  if (!purchaseId) return new Set();
  const { results } = await db
    .prepare("SELECT DISTINCT product_id FROM pricing_audit WHERE idempotency_key >= ? AND idempotency_key < ? AND product_id IS NOT NULL")
    .bind(`apply:${purchaseId}:`, `apply:${purchaseId};`)
    .all<{ product_id: string }>();
  return new Set((results ?? []).map((r) => r.product_id));
}

/** The whole card: every line's summary and every product's preview, for a draft or a saved purchase. */
async function procurementPreview(c: Context<AppContext>, purchase: PurchaseForPricing, pricingRaw: unknown, onlyProduct?: string) {
  const db = c.env.DB;
  const rates = await engineRates(db);
  const pricing = strictBody(pricingRaw ?? {}, ['minimum_profits', 'manual_line_opt_in', 'use_purchase', 'prefer_purchase_values']);
  const ids = [...new Set(purchase.lines.map((l) => l.product_id))].filter((id) => !onlyProduct || id === onlyProduct);
  const [loaded, stored, ctx] = await Promise.all([loadProducts(db, ids), loadProductsPricing(db, ids), loadPreviewContext(db)]);
  const opts: PreviewOptions = {
    minimum_profits: minimumProfits(pricing.minimum_profits, loaded),
    opt_in: new Set(stringList(pricing.manual_line_opt_in, 'manual_line_opt_in')),
    use_purchase: booleanMap(pricing.use_purchase, 'use_purchase'),
    prefer: booleanMap(pricing.prefer_purchase_values, 'prefer_purchase_values'),
  };
  const applied = await appliedProducts(db, purchase.purchase_id);
  const products = [];
  const previews = new Map<string, ProductPreview>();
  for (const id of ids) {
    const product = loaded.get(id);
    if (!product || (product.doc.composition ?? '') !== '') continue;
    const preview = await previewProduct(purchase, { loaded: product, stored: stored.get(id)! }, ctx, rates, opts);
    previews.set(id, preview);
    const cancelled = purchase.status === 'cancelled' && stored.get(id)!.inputs.some((r) => r.source_ref === `purchase:${purchase.purchase_id}`);
    products.push(productPreviewDto(preview, { applied: applied.has(id), cancelled_source: cancelled, rules: stored.get(id)!.rules }));
  }
  const lines = purchase.lines
    .filter((l) => previews.has(l.product_id))
    .map((l) => lineDto(l, lineSummary(purchase, l, { loaded: loaded.get(l.product_id)!, stored: stored.get(l.product_id)! }, previews.get(l.product_id)!, rates)));
  return { rates, products, lines, previews, stored, loaded };
}

adminPricingRoutes.post('/procurement/preview', async (c) => {
  const body = strictBody(await jsonObject(c), ['draft', 'purchase_id', 'pricing']);
  const db = c.env.DB;
  await engineRates(db);
  const purchaseId = typeof body.purchase_id === 'string' && /^[A-Za-z0-9_-]{8,60}$/.test(body.purchase_id) ? body.purchase_id : null;
  if (body.purchase_id !== undefined && body.purchase_id !== null && purchaseId === null) throw inputInvalid('purchase_id');
  let purchase: PurchaseForPricing | null;
  if (body.draft !== undefined && body.draft !== null) {
    if (!isRecord(body.draft)) throw inputInvalid('draft');
    // The purchase POST's own parser (fit #20): the same validation and refusals as the save.
    purchase = draftForPricing(await parseProcurementDraft(db, body.draft), body.draft, purchaseId);
  } else {
    if (!purchaseId) throw inputInvalid('purchase_id');
    purchase = await committedPurchaseForPricing(db, purchaseId);
    if (!purchase) throw notFound('Purchase not found');
  }
  const { rates, products, lines } = await procurementPreview(c, purchase, body.pricing);
  return c.json({ success: true, rates: ratesHeadDto(rates), lines, products });
});

const APPLY_STATEMENT_CAP = 200;

adminPricingRoutes.post('/products/:id/apply-purchase', async (c) => {
  assertCostWrite(c);
  const body = strictBody(await jsonObject(c), ['purchase_id', 'use_purchase', 'prefer_purchase_values', 'manual_line_opt_in', 'minimum_profits', 'preview_hash']);
  const db = c.env.DB;
  const rates = await engineRates(db);
  if (rates.derived_stale) throw fxRefusal(409, 'FX_DERIVED_STALE');
  const loaded = await loadOne(db, c.req.param('id'));
  const pid = loaded.id;
  if (typeof body.purchase_id !== 'string' || !/^[A-Za-z0-9_-]{8,60}$/.test(body.purchase_id)) throw inputInvalid('purchase_id');
  if (typeof body.preview_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.preview_hash)) throw inputInvalid('preview_hash');
  if (body.use_purchase !== undefined && typeof body.use_purchase !== 'boolean') throw inputInvalid('use_purchase');
  if (body.prefer_purchase_values !== undefined && typeof body.prefer_purchase_values !== 'boolean') throw inputInvalid('prefer_purchase_values');
  const purchase = await committedPurchaseForPricing(db, body.purchase_id);
  if (!purchase) throw notFound('Purchase not found');
  const usePurchase = body.use_purchase !== false;
  const productLines = purchase.lines.filter((l) => l.product_id === pid);
  const reason = productLines.length ? purchaseIneligibility({ status: purchase.status, cost_state: purchase.cost_state, lines: productLines }) : 'no_lines';
  if (reason && (usePurchase || reason === 'no_lines'))
    throw new HttpError(409, serverMessage('PRICING_PURCHASE_NOT_ELIGIBLE'), 'PRICING_PURCHASE_NOT_ELIGIBLE', { reason });
  const pricing = {
    minimum_profits: (Array.isArray(body.minimum_profits) ? body.minimum_profits : body.minimum_profits ?? []) as unknown[],
    manual_line_opt_in: body.manual_line_opt_in,
    use_purchase: { [pid]: usePurchase },
    prefer_purchase_values: { [pid]: body.prefer_purchase_values === true },
  };
  // The minimum profits are this product's: each entry names its scope only.
  const typed = minimumProfits(pricing.minimum_profits, new Map([[pid, loaded]]), pid);
  const { previews, stored, products } = await procurementPreview(
    c,
    purchase,
    { ...pricing, minimum_profits: (typed.get(pid) ?? []).map((d) => ({ product_id: pid, ...d })) },
    pid
  );
  const preview = previews.get(pid);
  const data = stored.get(pid);
  if (!preview || !data) throw new HttpError(409, serverMessage('PRICING_PURCHASE_NOT_ELIGIBLE'), 'PRICING_PURCHASE_NOT_ELIGIBLE', { reason: 'no_lines' });
  // A replay first (the same purchase, choices and values: never the purchase version, which a receive bumps).
  const idempotencyKey = `apply:${purchase.purchase_id}:${pid}:${preview.derived_hash}`;
  const replay = await db.prepare('SELECT 1 AS hit FROM pricing_audit WHERE idempotency_key = ?').bind(idempotencyKey).first<{ hit: number }>();
  if (replay) return c.json({ success: true, already: true, product_id: pid, rows_changed: 0 });
  if (preview.preview_hash !== body.preview_hash) {
    throw new HttpError(409, serverMessage('PRICING_PREVIEW_STALE'), 'PRICING_PREVIEW_STALE', { preview: products.find((p) => p.product_id === pid) ?? null });
  }

  const actor = c.get('user')!.id;
  const now = new Date().toISOString();
  const inputWrites = preview.derived.entries.map((e) => ({ ...e.write, source_ref: `purchase:${purchase.purchase_id}` })).filter((w) => !inputWriteIsNoop(w));
  const ruleWrites = preview.rule_writes.filter((w) => !ruleWriteIsNoop(w));
  const audits: D1PreparedStatement[] = [
    pricingAuditStatement(db, {
      entity: 'product_write',
      entity_key: `purchase:${purchase.purchase_id}`,
      product_id: pid,
      action: 'input_from_purchase',
      summary: {
        purchase_id: purchase.purchase_id,
        derived_hash: preview.derived_hash,
        use_purchase: usePurchase,
        prefer_purchase_values: body.prefer_purchase_values === true,
        line_ids: preview.derived.entries.flatMap((e) => e.line_ids),
        inputs_changed: inputWrites.length,
        rules_changed: ruleWrites.length,
      },
      idempotency_key: idempotencyKey,
      actor,
      now,
    }),
    ...inputWrites.map((w) => {
      const next = nextInputRow(w);
      return pricingAuditStatement(db, {
        entity: 'input',
        entity_key: `${w.scope}:${w.scope_id}`,
        product_id: pid,
        action: 'input_from_purchase',
        before: inputImage(w.existing),
        after: inputImage(next),
        summary: { purchase_id: purchase.purchase_id, line_ids: preview.derived.entries.find((e) => e.write.scope === w.scope && e.write.scope_id === w.scope_id)?.line_ids ?? [] },
        actor,
        now,
      });
    }),
    ...ruleWrites.map((w) =>
      pricingAuditStatement(db, {
        entity: 'rule',
        entity_key: `${w.kind}:${w.scope}:${w.scope_id}`,
        product_id: pid,
        action: 'rule_set',
        before: ruleImage(w.existing),
        after: ruleImage(w.next),
        summary: { purchase_id: purchase.purchase_id },
        actor,
        now,
      })
    ),
  ];
  const rowsChanged = inputWrites.length + ruleWrites.length;
  const statements = [
    ...batchHead(db, data, now),
    ...inputStatements(db, pid, inputWrites, actor, now),
    ...ruleStatements(db, pid, ruleWrites, actor, now),
    ...audits,
    ...(await auditStatements(db, actor, 'pricing.applied_from_purchase', pid, { product_id: pid, purchase_id: purchase.purchase_id, rows_changed: rowsChanged, entered: false })).statements,
    ...batchTail(db, pid),
  ];
  if (statements.length > APPLY_STATEMENT_CAP) throw new HttpError(409, serverMessage('PRICING_SET_TOO_LARGE'), 'PRICING_SET_TOO_LARGE');
  try {
    await db.batch(statements);
  } catch (e) {
    if (isFenceMiss(e)) throw fxRefusal(409, 'PRICING_CHANGED');
    if (/UNIQUE constraint failed: pricing_audit\.idempotency_key/i.test(e instanceof Error ? e.message : String(e)))
      return c.json({ success: true, already: true, product_id: pid, rows_changed: 0 });
    if (/UNIQUE constraint failed: ops_guards/i.test(e instanceof Error ? e.message : String(e))) throw fxRefusal(409, 'PRICING_CHANGED');
    throw e;
  }
  return c.json({ success: true, already: false, product_id: pid, rows_changed: rowsChanged });
});

/** The product's stored rules (for the sheet and the card) and its counter. */
adminPricingRoutes.get('/products/:id/rules', async (c) => {
  const db = c.env.DB;
  await engineRates(db);
  const loaded = await loadOne(db, c.req.param('id'));
  const data = await loadProductPricing(db, loaded.id);
  return c.json(storedRulesDto(loaded.id, data.rules, data.state?.inputs_seq ?? 0));
});

adminPricingRoutes.put('/products/:id/rules', async (c) => {
  assertCostWrite(c);
  const body = strictBody(await jsonObject(c), ['rules', 'inputs_seq']);
  const db = c.env.DB;
  await engineRates(db);
  const loaded = await loadOne(db, c.req.param('id'));
  const pid = loaded.id;
  const data = await loadProductPricing(db, pid);
  if (body.inputs_seq !== undefined && body.inputs_seq !== null) {
    if (typeof body.inputs_seq !== 'number' || !Number.isSafeInteger(body.inputs_seq) || body.inputs_seq < 0) throw inputInvalid('inputs_seq');
    if (body.inputs_seq !== (data.state?.inputs_seq ?? 0)) throw fxRefusal(409, 'PRICING_CHANGED');
  }
  const writes = parseRuleWrites(body, pid, optionIdsOf(loaded), data).filter((w) => !ruleWriteIsNoop(w));
  if (writes.length) await commitRuleWrites(c, data, writes, 'rule_set', 'pricing.rule.updated');
  const after = await loadProductPricing(db, pid);
  return c.json(storedRulesDto(pid, after.rules, after.state?.inputs_seq ?? 0));
});

/** The product form's «التسعير بالدولار» (worker/lib/pricingEngine/productInputs.ts). */
async function productInputsContext(c: Context<AppContext>) {
  const db = c.env.DB;
  const rates = await engineRates(db);
  const loaded = await loadOne(db, c.req.param('id') ?? '');
  const [stored, ctx] = await Promise.all([loadProductPricing(db, loaded.id), loadPreviewContext(db)]);
  return { db, rates, loaded, stored, ctx };
}

adminPricingRoutes.get('/products/:id/inputs', async (c) => {
  const { rates, loaded, stored, ctx } = await productInputsContext(c);
  return c.json(productInputsAnswer(loaded, stored, ctx, rates));
});

adminPricingRoutes.post('/products/:id/preview', async (c) => {
  const body = strictBody(await jsonObject(c), ['draft']);
  const { rates, loaded, stored, ctx } = await productInputsContext(c);
  const draft = parseProductInputs(strictBody(body.draft ?? {}, ['inputs', 'rules']), loaded, stored);
  return c.json(productInputsAnswer(loaded, stored, ctx, rates, draft));
});

const FORM_STATEMENT_CAP = 200;

adminPricingRoutes.put('/products/:id/inputs', async (c) => {
  assertCostWrite(c);
  const body = strictBody(await jsonObject(c), ['inputs_seq', 'inputs', 'rules']);
  const { db, rates, loaded, stored, ctx } = await productInputsContext(c);
  if (rates.derived_stale) throw fxRefusal(409, 'FX_DERIVED_STALE');
  const pid = loaded.id;
  if (typeof body.inputs_seq !== 'number' || !Number.isSafeInteger(body.inputs_seq) || body.inputs_seq < 0) throw inputInvalid('inputs_seq');
  // Fenced on what the owner looked at: a purchase applied or a second tab saved since is a fresh look.
  if (body.inputs_seq !== (stored.state?.inputs_seq ?? 0)) throw fxRefusal(409, 'PRICING_CHANGED');
  const draft = parseProductInputs(body, loaded, stored);
  const inputWrites = draft.inputs.filter((w) => !inputWriteIsNoop(w));
  const ruleWrites = draft.rules.filter((w) => !ruleWriteIsNoop(w));
  if (inputWrites.length || ruleWrites.length) {
    const actor = c.get('user')!.id;
    const now = new Date().toISOString();
    const statements = [
      ...batchHead(db, stored, now),
      ...inputStatements(db, pid, inputWrites, actor, now),
      ...ruleStatements(db, pid, ruleWrites, actor, now),
      ...inputWrites.map((w) =>
        pricingAuditStatement(db, { entity: 'input', entity_key: `${w.scope}:${w.scope_id}`, product_id: pid, action: 'update', before: inputImage(w.existing), after: inputImage(nextInputRow(w)), summary: { source: 'product_form' }, actor, now })
      ),
      ...ruleWrites.map((w) =>
        pricingAuditStatement(db, { entity: 'rule', entity_key: `${w.kind}:${w.scope}:${w.scope_id}`, product_id: pid, action: 'rule_set', before: ruleImage(w.existing), after: ruleImage(w.next), summary: { source: 'product_form' }, actor, now })
      ),
      ...(await auditStatements(db, actor, 'pricing.inputs.updated', pid, { product_id: pid, inputs_changed: inputWrites.length, rules_changed: ruleWrites.length, inputs_seq: stored.state?.inputs_seq ?? 0 })).statements,
      ...batchTail(db, pid),
    ];
    if (statements.length > FORM_STATEMENT_CAP) throw new HttpError(409, serverMessage('PRICING_SET_TOO_LARGE'), 'PRICING_SET_TOO_LARGE');
    try {
      await db.batch(statements);
    } catch (e) {
      if (isFenceMiss(e) || /UNIQUE constraint failed: ops_guards/i.test(e instanceof Error ? e.message : String(e))) throw fxRefusal(409, 'PRICING_CHANGED');
      throw e;
    }
  }
  const after = await loadProductPricing(db, pid);
  return c.json(productInputsAnswer(loaded, after, ctx, rates));
});

adminPricingRoutes.post('/products/:id/targets/adopt', async (c) => {
  assertCostWrite(c);
  const body = strictBody(await jsonObject(c), ['legacy_hash']);
  const db = c.env.DB;
  await engineRates(db);
  const loaded = await loadOne(db, c.req.param('id'));
  const pid = loaded.id;
  if (typeof body.legacy_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.legacy_hash)) throw inputInvalid('legacy_hash');
  const ctx = await loadPreviewContext(db);
  const legacy = evaluateLegacy(pid, loaded.doc, loaded.view, ctx).legacy;
  const hash = await legacyHashOf(legacy.rules);
  // Fenced on the image the owner saw: a price edited since then is a fresh look.
  if (hash !== body.legacy_hash) throw new HttpError(409, serverMessage('PRICING_PREVIEW_STALE'), 'PRICING_PREVIEW_STALE');
  const data = await loadProductPricing(db, pid);
  const writes = legacyAcceptWrites(pid, legacy.rules, data, `legacy:${hash.slice(0, 32)}`).filter((w) => !ruleWriteIsNoop(w));
  if (writes.length) await commitRuleWrites(c, data, writes, 'legacy_accept', 'pricing.legacy.accepted');
  const after = await loadProductPricing(db, pid);
  return c.json(storedRulesDto(pid, after.rules, after.state?.inputs_seq ?? 0));
});

/** One rule batch: fences, token, state row, the rules, their pricing_audit rows and one audit_log row (ids and counts). */
async function commitRuleWrites(c: Context<AppContext>, data: ProductPricingData, writes: RuleWrite[], action: 'rule_set' | 'legacy_accept', auditAction: string): Promise<void> {
  const db = c.env.DB;
  const actor = c.get('user')!.id;
  const now = new Date().toISOString();
  const pid = data.product_id;
  const statements = [
    ...batchHead(db, data, now),
    ...ruleStatements(db, pid, writes, actor, now),
    ...writes.map((w) =>
      pricingAuditStatement(db, { entity: 'rule', entity_key: `${w.kind}:${w.scope}:${w.scope_id}`, product_id: pid, action, before: ruleImage(w.existing), after: ruleImage(w.next), actor, now })
    ),
    ...(await auditStatements(db, actor, auditAction, pid, { product_id: pid, rules_changed: writes.length, inputs_seq: data.state?.inputs_seq ?? 0 })).statements,
    ...batchTail(db, pid),
  ];
  try {
    await db.batch(statements);
  } catch (e) {
    if (isFenceMiss(e) || /UNIQUE constraint failed: ops_guards/i.test(e instanceof Error ? e.message : String(e))) throw fxRefusal(409, 'PRICING_CHANGED');
    throw e;
  }
}
