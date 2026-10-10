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
 * every other table before and after). The other is outside this router:
 * the security log's door on /api/admin/* (push 1s, worker/lib/securityEvents.ts)
 * records a refusal, and the owner's request from a session, network or
 * browser not seen in 30 days, in `security_events` — ids and codes only.
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
 * They write rates, never a product price themselves. FX-5: once an act has
 * committed a rate that moves the engine's inputs (an approval, a manual rate,
 * the adjustment, a shipping rate), the engine products it left stale are
 * repriced by the engine's own writer inside the same request's statement
 * budget, deficit first (worker/lib/fx/reprice.ts); the rest follow on the
 * quarter-hour sweep. Before such an act the owner reads what it would do —
 * nothing written (§7.8, §8):
 *   POST /rates/fx/:pair/review/preview   approving the held rate
 *   POST /rates/fx/:pair/manual/preview   {rate} or {market_adjustment_iqd}
 *   POST /rates/shipping/:profile/preview {rate_iqd}
 * and, once any product is engine-priced, the act carries that preview's
 * `preview_hash` (409 PRICING_PREVIEW_REQUIRED / PRICING_PREVIEW_STALE return
 * the fresh preview).
 *
 * FX-6 (FX programme plan §8, §9 §16-§19) adds the owner's batch read model:
 *   GET  /batches?product_id= | ?lot_id= | ?purchase_id=
 * each batch's fixed IQD cost (`batch_cost`) and, apart, its purchase-time
 * snapshot — recorded at receipt (migration 0182), derived from its own
 * purchase and labelled so, or known only in IQD (worker/lib/batchSnapshot.ts).
 * A read: nothing written.
 */
import { completenessAfterWrite } from '../lib/completenessHooks';
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, jsonObject, notFound, requireAdmin } from '../lib/http';
import { assertCostWrite, requireCostRead, requireFreshSession } from '../lib/costAccess';
import { limitByMethod, rateLimit } from '../lib/ratelimit';
import { SESSION_CACHE_CONTROL, afterCatalogueWrite, originOf, purgeCatalogueFromJob } from '../lib/edgePolicy';
import { auditStatements } from '../lib/audit';
import { fence } from '../lib/operations';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { ratioExceedsPct, sameRate, sumOfMoves } from '@levonis/pricing/fxChain';
import { fxKeyConfigured, runFxScheduler } from '../lib/fx/scheduler';
import { iso, isMissingTable, loadPairs, type FxPairId, type FxPairRow } from '../lib/fx/pairs';
import { isFenceMiss, planPairBatch, refusalCodeOf } from '../lib/fx/commit';
import { toStatements } from '../lib/fx/write';
import { historyItemDto, ratesDto } from '../lib/fx/dto';
import { engineProductCount, loadHistory, loadRatesReadModel } from '../lib/fx/read';
import { notifyOwnerFx } from '../lib/fx/notify';
import { sweepStaleEnginePrices } from '../lib/fx/reprice';
import { FX_INVOCATION_STATEMENT_BUDGET, statementBudget } from '../lib/fx/budget';
import { autoRepriceStatus } from '../lib/pricingEngine/autoReprice';
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
  storedIqdOf,
  type ProductPricingData,
  type RuleWrite,
} from '../lib/pricingEngine/store';
import { MinimumProfitError, parseMinimumProfit, purchaseIneligibility, type DirectSaleExtraDraft, type MinimumProfitDraft, type PurchaseForPricing } from '../lib/pricingEngine/fromPurchase';
import { lineSummary, previewProduct, type PreviewOptions, type ProductPreview } from '../lib/pricingEngine/procurementPreview';
import { lineDto, productPreviewDto, ratesHeadDto, storedRulesDto } from '../lib/pricingEngine/procurementDto';
import { legacyAcceptWrites, parseDirectSaleExtraAmount, parseRuleWrites } from '../lib/pricingEngine/ownerRules';
import { evaluateLegacy, sellableSkus } from '../lib/pricingEngine/legacy';
import { legacyHashOf } from '../lib/pricingEngine/legacyHash';
import { parseProcurementDraft } from '../lib/procurementDraft';
import { committedPurchaseForPricing, draftForPricing } from '../lib/pricingEngine/purchaseRead';
import {
  effectiveWrites,
  formPreviewHash,
  formScopeIds,
  loadEngineReads,
  parseProductInputs,
  productEngineEvaluation,
  productInputsAnswer,
} from '../lib/pricingEngine/productInputs';
import {
  engineEvaluationDto,
  engineWriteStatements,
  evaluateEngineWrite,
  loadEngineControl,
  loadStoredSkuCosts,
  priceImageOf,
  skuTableOf,
  skuReadFailed,
  refuseUnreadSkus,
  staleReasons,
  withRuleIds,
  type EngineEvaluation,
} from '../lib/pricingEngine/engineWrite';
import { mergedInputs } from '../lib/pricingEngine/fromPurchase';
import { engineDbRefusal } from '../lib/pricingDbRefusals';
import { canonical } from '../lib/pricingEngine/procurementPreview';
import { sha256Hex } from '../lib/crypto';
import { FX_GUARD_CHANGED, recordSecurityEvent } from '../lib/securityEvents';
import { previewRateAct, type RateMove, type RatePreview } from '../lib/pricingEngine/ratePreview';
import { FRESH_SESSION_SECONDS, sessionAgeSeconds } from '../lib/session';
import { loadBatches, type BatchFilter } from '../lib/batchSnapshot';

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
// Owner brief 2026-10-10: saved supplier costs, rules or an adopted engine price
// re-evaluate the product against the required-field list (completenessHooks.ts).
adminPricingRoutes.use('*', completenessAfterWrite);

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

/**
 * «الدفعات وأسعار الشراء» (FX-6, §16-§19): exactly one of `product_id`,
 * `lot_id` or `purchase_id`. The two costs are never mixed: this is what each
 * batch ACTUALLY cost (and the rates it was bought at); the engine's current
 * replacement cost is on /products/:id.
 */
adminPricingRoutes.get('/batches', async (c) => {
  const pick = (['product_id', 'lot_id', 'purchase_id'] as const).flatMap((k) => {
    const v = c.req.query(k);
    return v === undefined ? [] : [[k, v.trim()] as const];
  });
  const [only] = pick;
  if (pick.length !== 1 || !only || !/^[A-Za-z0-9_:.-]{1,60}$/.test(only[1]))
    throw new HttpError(400, 'اختر منتجًا أو دفعة أو أمر شراء واحدًا / Name exactly one product, batch or purchase', 'BATCH_FILTER_REQUIRED');
  const filter = { [only[0]]: only[1] } as BatchFilter;
  return c.json({ success: true, ...(await loadBatches(c.env.DB, filter)) });
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
// migration 0179 answers 503 PRICING_NOT_INSTALLED. No route here writes a
// product price itself: after a committed rate move, the engine's writer
// reprices the stale engine products (FX-5, `repriceAfterAct`).

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

/**
 * FX-5 (§7.1, §7.4): after an owner act committed a rate the engine prices at,
 * the engine products it left stale are repriced at once by the engine's own
 * writer, deficit first, within this request's statement budget (the act's
 * own batch already charged); the rest follow on the quarter-hour sweep. Only
 * confirmed rates price: an act that holds, rejects or keeps a rate moved
 * nothing, so nothing is stale. Never throws.
 */
async function repriceAfterAct(c: Context<AppContext>, spent: number): Promise<void> {
  const budget = statementBudget(FX_INVOCATION_STATEMENT_BUDGET);
  budget.spend(Math.min(spent, FX_INVOCATION_STATEMENT_BUDGET));
  await sweepStaleEnginePrices(c.env, { trigger: 'owner_rate', budget, actorId: c.get('user')!.id, origin: originOf(c) });
}

// ------------------------------------------------------------- FX-5: the preview before an owner rate act (§7.8, §8)

/** The act's move as the preview prices it: the pair's effective rate before and after, and whether its held value clears. */
function fxMoveOf(act: 'review' | 'manual' | 'adjustment', row: FxPairRow, planned: PlannedAct): RateMove {
  const change = planned.changes.find((ch) => ch.pair === row.pair);
  const clears = !!change && Object.prototype.hasOwnProperty.call(change.set, 'pending_effective_rate') && (change.set.pending_effective_rate ?? null) === null;
  return {
    kind: 'fx',
    act,
    pair: row.pair,
    owner_version: row.owner_version,
    before: row.effective_rate,
    after: planned.move ? planned.move.after : row.effective_rate,
    clears_pending: clears,
  };
}

/** The act moves a rate the engine prices at (a value, not only a version). */
const rateMoves = (m: RateMove): boolean => m.after !== null && (m.before === null || !sameRate(m.before, m.after));

/** Statements an FX act's own batch costs (the repricing has the rest of the request's 600). */
function actCost(planned: PlannedAct, rows: readonly FxPairRow[], actor: string, now: Date): number {
  return planPairBatch(planned.changes, rows, { fence: 'owner', actor, nowIso: iso(now), newLogId: () => 'fxl_preview' }).cost;
}
/** A shipping act: its fence (2), the rate's UPDATE and its audit rows. */
const SHIPPING_ACT_COST = 5;

/** The preview as the owner reads it (allowlisted; every amount key is in FINANCIAL_FIELDS). */
function ratePreviewDto(c: Context<AppContext>, p: RatePreview) {
  return {
    act: { ...p.act },
    engine_products: p.engine_products,
    affected: { ...p.affected },
    changed_products: p.changed_products,
    rows: p.rows.map((r) => ({ ...r })),
    blocked: p.blocked.map((b) => ({ ...b })),
    follows: p.follows,
    large_change: p.large_change,
    drop_flag: p.drop_flag,
    // The act will ask for a sign-in within the last ten minutes (§7.8, once a product is engine-priced): said before it.
    fresh_sign_in: p.engine_products > 0 && sessionAgeSeconds(c) > FRESH_SESSION_SECONDS,
    preview_hash: p.preview_hash,
  };
}

/** What the act would reprice, read now (no write); 503 on a database without the rates. */
async function ratePreview(c: Context<AppContext>, move: RateMove, spent: number) {
  const rates = await loadPricingRates(c.env.DB);
  if (!rates) throw fxNotInstalled();
  const out = await previewRateAct(c.env.DB, move, rates, FX_INVOCATION_STATEMENT_BUDGET - spent);
  // The rates' own read (one batch of two) is the preview's too.
  return { preview: out.preview, statements: out.statements + 2 };
}

/**
 * FX-5 (§7.8, §8): once any product is engine-priced, an act that moves a rate
 * the engine prices at carries the hash of the preview the owner read. None →
 * 409 PRICING_PREVIEW_REQUIRED; moved since (a rate, a product, the pair's
 * owner version) → 409 PRICING_PREVIEW_STALE; each returns the fresh preview.
 * A customer price moving more than 15% needs the explicit confirmation and a
 * sign-in within the last ten minutes. Answers the statements the preview read
 * (the repricing's budget is charged for them).
 */
async function previewGate(c: Context<AppContext>, move: RateMove, gate: { hash: unknown; confirm: boolean }, spent: number): Promise<number> {
  if (!rateMoves(move)) return 0;
  if ((await engineProductCount(c.env.DB)) === 0) return 1;
  const { preview, statements } = await ratePreview(c, move, spent);
  if (gate.hash !== preview.preview_hash) {
    const code = typeof gate.hash === 'string' && gate.hash !== '' ? 'PRICING_PREVIEW_STALE' : 'PRICING_PREVIEW_REQUIRED';
    throw fxRefusal(409, code, { preview: ratePreviewDto(c, preview) });
  }
  if (preview.large_change) {
    if (!gate.confirm) throw fxRefusal(409, 'PRICING_LARGE_CHANGE_CONFIRM', { preview: ratePreviewDto(c, preview) });
    requireFreshSession(c);
  }
  return statements + 1;
}

/** One owner act, committed in one batch; the display rate's caches purged and the bell rung after. */
async function commitAct(c: Context<AppContext>, planned: PlannedAct, rows: readonly FxPairRow[], now: Date, previewSpent = 0): Promise<void> {
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
  // Every FX guard-setting change is in the owner's security log too (push 1s, S7; critique F3):
  // the act's code and the field NAMES, never a value.
  if (planned.guard) {
    const audit = planned.changes[0]?.audit;
    const named = audit?.detail.fields;
    const fields = Array.isArray(named) ? named.filter((f): f is string => typeof f === 'string') : undefined;
    await recordSecurityEvent(c, {
      kind: 'scope_changed',
      code: FX_GUARD_CHANGED,
      status: 200,
      detail: { pair: planned.changes[0]?.pair, act: audit?.action, fields },
    });
  }
  // An effective rate moved (the derived IQD rates were rewritten): reprice what it left stale.
  if (plan.derived.length) await repriceAfterAct(c, plan.cost + previewSpent);
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
  // FX-5: an adjustment that moves the effective rate carries the preview the owner read (§7.8).
  const row = pairRow(rows, pair);
  const previewSpent = planned.move
    ? await previewGate(c, fxMoveOf('adjustment', row, planned), { hash: body.preview_hash, confirm: planned.confirm }, actCost(planned, rows, c.get('user')!.id, now))
    : 0;
  // Back to automatic fetches at once: it charges the refresh buckets like «تحديث الآن» (critique F4).
  if (planned.backToAuto) await chargeRefresh(c);
  await commitAct(c, planned, rows, now, previewSpent);
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
  const previewSpent = await previewGate(
    c,
    fxMoveOf('manual', pairRow(rows, pair), planned),
    { hash: body.preview_hash, confirm: planned.confirm },
    actCost(planned, rows, c.get('user')!.id, now)
  );
  await commitAct(c, planned, rows, now, previewSpent);
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
  let previewSpent = 0;
  if (planned.decision === 'approve') {
    await priceMovingGate(c, true);
    await largeChangeGate(c, pair, planned.move, planned.confirm, now);
    previewSpent = await previewGate(
      c,
      fxMoveOf('review', pairRow(rows, pair), planned),
      { hash: body.preview_hash, confirm: planned.confirm },
      actCost(planned, rows, c.get('user')!.id, now)
    );
  }
  await commitAct(c, planned, rows, now, previewSpent);
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
  // FX-5: the products on this route are repriced at the new rate — the owner read that preview first (§7.8).
  const previewSpent = await previewGate(
    c,
    { kind: 'shipping', profile: input.profile, version: row.version, before: row.rate_iqd, after: input.rate },
    { hash: input.preview_hash, confirm: input.confirm },
    SHIPPING_ACT_COST
  );
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
  // FX-5: the engine products priced on this route are repriced at the new central rate (the owner's cost change).
  if (row.rate_iqd !== input.rate) {
    const budget = statementBudget(FX_INVOCATION_STATEMENT_BUDGET);
    budget.spend(Math.min(statements.length + 1 + previewSpent, FX_INVOCATION_STATEMENT_BUDGET));
    await sweepStaleEnginePrices(c.env, { trigger: 'shipping', budget, actorId: actor, origin: originOf(c) });
  }
  return ratesAnswer(c);
});

// ------------------------------------------------------------- the three previews (FX-5, §7.8, §8)
//
// What an act would reprice — every affected engine product, today's customer
// price → the new one per model × channel, the deficit, the blocked products
// and how many follow within 15 minutes — and its `preview_hash`. Reads only:
// a POST only for its body. Behind the same door (owner only, no-store).

adminPricingRoutes.post('/rates/fx/:pair/review/preview', async (c) => {
  const pair = pairParam(c.req.param('pair'));
  strictBody(await jsonObject(c), []);
  const now = new Date();
  const actor = c.get('user')!.id;
  const rows = await fxRows(c.env.DB);
  const row = pairRow(rows, pair);
  // Approving: the held MARKET figure at the CURRENT adjustment (M4.3) — the act's own planner.
  const planned = planReview(row, { owner_version: row.owner_version, decision: 'approve' }, { actor, now });
  const { preview } = await ratePreview(c, fxMoveOf('review', row, planned), actCost(planned, rows, actor, now));
  return c.json({ success: true, preview: ratePreviewDto(c, preview) });
});

adminPricingRoutes.post('/rates/fx/:pair/manual/preview', async (c) => {
  const pair = pairParam(c.req.param('pair'));
  const body = strictBody(await jsonObject(c), ['rate', 'market_adjustment_iqd']);
  if ((body.rate === undefined) === (body.market_adjustment_iqd === undefined)) throw inputInvalid(body.rate === undefined ? 'rate' : 'market_adjustment_iqd');
  const now = new Date();
  const actor = c.get('user')!.id;
  const rows = await fxRows(c.env.DB);
  const row = pairRow(rows, pair);
  let move: RateMove;
  let cost = 0;
  if (body.rate !== undefined) {
    const planned = planManualSet(row, { owner_version: row.owner_version, rate: body.rate }, { actor, now });
    move = fxMoveOf('manual', row, planned);
    cost = actCost(planned, rows, actor, now);
  } else {
    const planned = planSettings(row, { owner_version: row.owner_version, market_adjustment_iqd: body.market_adjustment_iqd }, { actor, now });
    move = planned ? fxMoveOf('adjustment', row, planned) : { kind: 'fx', act: 'adjustment', pair, owner_version: row.owner_version, before: row.effective_rate, after: row.effective_rate, clears_pending: false };
    cost = planned ? actCost(planned, rows, actor, now) : 0;
  }
  const { preview } = await ratePreview(c, move, cost);
  return c.json({ success: true, preview: ratePreviewDto(c, preview) });
});

adminPricingRoutes.post('/rates/shipping/:profile/preview', async (c) => {
  const db = c.env.DB;
  const raw = strictBody(await jsonObject(c), ['rate_iqd']);
  // The act's own parser (profile, decimal text > 0); the version is the row's, read next.
  const input = parseShipping(c.req.param('profile'), { version: 1, rate_iqd: raw.rate_iqd });
  let row: { rate_iqd: string | null; version: number } | null;
  try {
    row = await db.prepare('SELECT rate_iqd, version FROM pricing_shipping_rates WHERE profile = ?').bind(input.profile).first();
  } catch (e) {
    if (isMissingTable(e)) throw fxNotInstalled();
    throw e;
  }
  if (!row) throw fxNotInstalled();
  const { preview } = await ratePreview(c, { kind: 'shipping', profile: input.profile, version: row.version, before: row.rate_iqd, after: input.rate }, SHIPPING_ACT_COST);
  return c.json({ success: true, preview: ratePreviewDto(c, preview) });
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

/**
 * The owner's typed Direct Sale Extras on the review of a stock purchase (owner
 * request 2026-10-10), validated against each product's models: product or an
 * active model (colour and SKU levels are not offered on this card), one entry
 * per target, the amount through the one validator `«التسعير والشحن»` uses
 * (`parseDirectSaleExtraAmount`: whole dinars, the 1,000 step, null = inherit).
 */
function directSaleExtras(raw: unknown, loaded: ReadonlyMap<string, LoadedProduct>, onlyProduct?: string): Map<string, DirectSaleExtraDraft[]> {
  const out = new Map<string, DirectSaleExtraDraft[]>();
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw) || raw.length > 60) throw inputInvalid('direct_sale_extras');
  const seen = new Set<string>();
  for (const item of raw) {
    const r = strictBody(item, onlyProduct ? ['scope', 'scope_id', 'amount_iqd'] : ['product_id', 'scope', 'scope_id', 'amount_iqd']);
    const pid = onlyProduct ?? (typeof r.product_id === 'string' ? r.product_id : '');
    const product = loaded.get(pid);
    if (!product) throw inputInvalid('direct_sale_extras');
    const scope = r.scope;
    if (scope !== 'product' && scope !== 'option') throw inputInvalid('direct_sale_extras');
    const scopeId = scope === 'product' ? '' : typeof r.scope_id === 'string' ? r.scope_id : '';
    if (scope === 'option' && !optionIdsOf(product).has(scopeId)) throw inputInvalid('direct_sale_extras');
    if (scope === 'product' && r.scope_id !== undefined && r.scope_id !== null && r.scope_id !== '') throw inputInvalid('direct_sale_extras');
    const key = `${pid}:${scope}:${scopeId}`;
    if (seen.has(key)) throw inputInvalid('direct_sale_extras');
    seen.add(key);
    out.set(pid, [...(out.get(pid) ?? []), { scope, scope_id: scopeId, amount_iqd: parseDirectSaleExtraAmount(r.amount_iqd) }]);
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
  const pricing = strictBody(pricingRaw ?? {}, ['minimum_profits', 'direct_sale_extras', 'manual_line_opt_in', 'use_purchase', 'prefer_purchase_values']);
  const ids = [...new Set(purchase.lines.map((l) => l.product_id))].filter((id) => !onlyProduct || id === onlyProduct);
  const [loaded, stored, ctx] = await Promise.all([loadProducts(db, ids), loadProductsPricing(db, ids), loadPreviewContext(db)]);
  const opts: PreviewOptions = {
    minimum_profits: minimumProfits(pricing.minimum_profits, loaded),
    direct_sale_extras: directSaleExtras(pricing.direct_sale_extras, loaded),
    opt_in: new Set(stringList(pricing.manual_line_opt_in, 'manual_line_opt_in')),
    use_purchase: booleanMap(pricing.use_purchase, 'use_purchase'),
    prefer: booleanMap(pricing.prefer_purchase_values, 'prefer_purchase_values'),
  };
  const applied = await appliedProducts(db, purchase.purchase_id);
  const products = [];
  const previews = new Map<string, ProductPreview>();
  const engine = new Map<string, { ev: EngineEvaluation; writes: { inputWrites: InputWriteList; ruleWrites: RuleWriteList } }>();
  const [control, storedCosts] = await Promise.all([loadEngineControl(db), loadStoredSkuCosts(db, ids)]);
  for (const id of ids) {
    const product = loaded.get(id);
    if (!product || (product.doc.composition ?? '') !== '') continue;
    const data = stored.get(id)!;
    const preview = await previewProduct(purchase, { loaded: product, stored: data }, ctx, rates, opts);
    // Owner decision 8 at the purchase's apply: what applying it would do to the product's prices.
    const writes = {
      inputWrites: preview.derived.entries.map((e) => ({ ...e.write, source_ref: `purchase:${purchase.purchase_id}` })).filter((w) => !inputWriteIsNoop(w)),
      ruleWrites: withRuleIds(preview.rule_writes.filter((w) => !ruleWriteIsNoop(w))),
    };
    const ev = await evaluateEngineWrite({
      loaded: product,
      stored: data,
      ctx,
      rates,
      control,
      inputs: mergedInputs(data.inputs, writes.inputWrites),
      inputWrites: writes.inputWrites,
      ruleWrites: writes.ruleWrites,
      image: await priceImageOf(db, id),
      storedCosts: storedCosts.filter((r) => r.product_id === id),
      allowAdopt: !data.state?.opted_out_at,
    });
    engine.set(id, { ev, writes });
    // An apply that writes prices carries the engine write's hash too (the prices the owner read).
    if (ev.kind && ev.complete && ev.hash) preview.preview_hash = await sha256Hex(canonical({ purchase: preview.preview_hash, engine: ev.hash }));
    previews.set(id, preview);
    const cancelled = purchase.status === 'cancelled' && data.inputs.some((r) => r.source_ref === `purchase:${purchase.purchase_id}`);
    products.push({ ...productPreviewDto(preview, { applied: applied.has(id), cancelled_source: cancelled, rules: data.rules }), adoption: engineEvaluationDto(ev) });
  }
  const lines = purchase.lines
    .filter((l) => previews.has(l.product_id))
    .map((l) => lineDto(l, lineSummary(purchase, l, { loaded: loaded.get(l.product_id)!, stored: stored.get(l.product_id)! }, previews.get(l.product_id)!, rates)));
  return { rates, products, lines, previews, stored, loaded, engine };
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
  const body = strictBody(await jsonObject(c), ['purchase_id', 'use_purchase', 'prefer_purchase_values', 'manual_line_opt_in', 'minimum_profits', 'direct_sale_extras', 'preview_hash', 'confirm_large_change']);
  const db = c.env.DB;
  const rates = await engineRates(db);
  if (rates.derived_stale) throw fxRefusal(409, 'FX_DERIVED_STALE');
  const loaded = await loadOne(db, c.req.param('id'));
  const pid = loaded.id;
  if (typeof body.purchase_id !== 'string' || !/^[A-Za-z0-9_-]{8,60}$/.test(body.purchase_id)) throw inputInvalid('purchase_id');
  if (typeof body.preview_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.preview_hash)) throw inputInvalid('preview_hash');
  if (body.use_purchase !== undefined && typeof body.use_purchase !== 'boolean') throw inputInvalid('use_purchase');
  if (body.prefer_purchase_values !== undefined && typeof body.prefer_purchase_values !== 'boolean') throw inputInvalid('prefer_purchase_values');
  if (body.confirm_large_change !== undefined && typeof body.confirm_large_change !== 'boolean') throw inputInvalid('confirm_large_change');
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
  // The minimum profits and Direct Sale Extras are this product's: each entry names its scope only.
  const typed = minimumProfits(pricing.minimum_profits, new Map([[pid, loaded]]), pid);
  const extras = directSaleExtras(body.direct_sale_extras, new Map([[pid, loaded]]), pid);
  const { previews, stored, products, engine } = await procurementPreview(
    c,
    purchase,
    {
      ...pricing,
      minimum_profits: (typed.get(pid) ?? []).map((d) => ({ product_id: pid, ...d })),
      direct_sale_extras: (extras.get(pid) ?? []).map((d) => ({ product_id: pid, ...d })),
    },
    pid
  );
  const preview = previews.get(pid);
  const data = stored.get(pid);
  const priced = engine.get(pid);
  if (!preview || !data || !priced) throw new HttpError(409, serverMessage('PRICING_PURCHASE_NOT_ELIGIBLE'), 'PRICING_PURCHASE_NOT_ELIGIBLE', { reason: 'no_lines' });
  // A replay first (the same purchase, choices and values: never the purchase version, which a receive bumps).
  const idempotencyKey = `apply:${purchase.purchase_id}:${pid}:${preview.derived_hash}`;
  const replay = await db.prepare('SELECT 1 AS hit FROM pricing_audit WHERE idempotency_key = ?').bind(idempotencyKey).first<{ hit: number }>();
  if (replay) return c.json({ success: true, already: true, product_id: pid, rows_changed: 0, priced: false });
  const productPreview = products.find((p) => p.product_id === pid) ?? null;
  if (preview.preview_hash !== body.preview_hash) {
    throw new HttpError(409, serverMessage('PRICING_PREVIEW_STALE'), 'PRICING_PREVIEW_STALE', { preview: productPreview });
  }

  const actor = c.get('user')!.id;
  const now = new Date().toISOString();
  const { ev, writes } = priced;
  const inputWrites = writes.inputWrites;
  const ruleWrites = writes.ruleWrites;
  const pricesWritten = !!ev.kind && (ev.needs_write || !ev.complete);
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
        line_ids: [...new Set(preview.derived.entries.flatMap((e) => e.line_ids))],
        inputs_changed: inputWrites.length,
        rules_changed: ruleWrites.length,
        priced: pricesWritten,
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
  const appliedAudit = async (entered: boolean) =>
    (await auditStatements(db, actor, 'pricing.applied_from_purchase', pid, { product_id: pid, purchase_id: purchase.purchase_id, rows_changed: rowsChanged, entered })).statements;

  // Owner decision 8 at the purchase: the apply that leaves the product complete writes its prices in the same batch.
  if (pricesWritten) {
    let status: 'saved' | 'already';
    try {
      status = await commitEngine(
        c,
        ev,
        writes,
        // The combined hash was checked above; the engine gate reads the engine write's own.
        { hash: ev.hash, confirm: body.confirm_large_change },
        { source: 'purchase', preview: async () => productPreview, extraAudits: [...audits, ...(await appliedAudit(ev.kind === 'adopt'))], auditDetail: { purchase_id: purchase.purchase_id } }
      );
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed: pricing_audit\.idempotency_key/i.test(e.message)) return c.json({ success: true, already: true, product_id: pid, rows_changed: 0, priced: false });
      throw e;
    }
    return c.json({ success: true, already: status === 'already', product_id: pid, rows_changed: rowsChanged, priced: status === 'saved', entered: ev.kind === 'adopt' });
  }

  const statements = [
    ...batchHead(db, data, now),
    ...inputStatements(db, pid, inputWrites, actor, now),
    ...ruleStatements(db, pid, ruleWrites, actor, now),
    ...audits,
    ...(await appliedAudit(false)),
    ...batchTail(db, pid),
  ];
  if (statements.length > APPLY_STATEMENT_CAP) throw new HttpError(409, serverMessage('PRICING_SET_TOO_LARGE'), 'PRICING_SET_TOO_LARGE');
  try {
    await db.batch(statements);
  } catch (e) {
    if (isFenceMiss(e)) throw fxRefusal(409, 'PRICING_CHANGED');
    if (/UNIQUE constraint failed: pricing_audit\.idempotency_key/i.test(e instanceof Error ? e.message : String(e)))
      return c.json({ success: true, already: true, product_id: pid, rows_changed: 0, priced: false });
    if (/UNIQUE constraint failed: ops_guards/i.test(e instanceof Error ? e.message : String(e))) throw fxRefusal(409, 'PRICING_CHANGED');
    throw e;
  }
  return c.json({ success: true, already: false, product_id: pid, rows_changed: rowsChanged, priced: false });
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
  const writes = parseRuleWrites(body, pid, formScopeIds(loaded), data).filter((w) => !ruleWriteIsNoop(w));
  if (writes.length) await commitRuleWrites(c, data, writes, 'rule_set', 'pricing.rule.updated');
  const after = await loadProductPricing(db, pid);
  return c.json(storedRulesDto(pid, after.rules, after.state?.inputs_seq ?? 0));
});

/** The product form's «التسعير بالدولار» (worker/lib/pricingEngine/productInputs.ts). */
async function productInputsContext(c: Context<AppContext>) {
  const db = c.env.DB;
  const rates = await engineRates(db);
  const loaded = await loadOne(db, c.req.param('id') ?? '');
  const [stored, ctx, reads] = await Promise.all([loadProductPricing(db, loaded.id), loadPreviewContext(db), loadEngineReads(db, loaded.id)]);
  return { db, rates, loaded, stored, ctx, reads };
}

adminPricingRoutes.get('/products/:id/inputs', async (c) => {
  const { rates, loaded, stored, ctx, reads } = await productInputsContext(c);
  return c.json(await productInputsAnswer(loaded, stored, ctx, rates, undefined, reads));
});

adminPricingRoutes.post('/products/:id/preview', async (c) => {
  const body = strictBody(await jsonObject(c), ['draft', 'adopt']);
  if (body.adopt !== undefined && typeof body.adopt !== 'boolean') throw inputInvalid('adopt');
  const { rates, loaded, stored, ctx, reads } = await productInputsContext(c);
  const draft = parseProductInputs(strictBody(body.draft ?? {}, ['inputs', 'rules']), loaded, stored, { rates, now: new Date().toISOString() });
  return c.json(await productInputsAnswer(loaded, stored, ctx, rates, draft, reads, { adopt: body.adopt === true }));
});

const FORM_STATEMENT_CAP = 200;

// ============================================================= The writer (owner decision 8; USD design §6.1-§6.5)
//
// A save that leaves a manual product complete ADOPTS the engine and writes its
// prices in the same batch; an engine product's save reprices in the same
// batch; an incomplete manual product stores its data and keeps its manual
// price. A price write needs the hash of the preview the owner read (409
// PRICING_PREVIEW_REQUIRED returns the preview when it is missing, 409
// PRICING_PREVIEW_STALE when the data moved since), a change above 15% the
// explicit tick and a fresh sign-in. One product, one atomic batch, fenced,
// idempotent on the preview hash, audited (values in pricing_audit, ids and
// counts in audit_log), bounded (FORM_STATEMENT_CAP). Only the LAST CONFIRMED
// central rates price (the versioned reader; a held candidate never does).

const ENGINE_STATEMENT_CAP = 200;

const priceKey = (pid: string, hash: string) => `price:${pid}:${hash}`;
const isHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

async function priceReplayed(db: D1Database, pid: string, hash: unknown): Promise<boolean> {
  if (!isHash(hash)) return false;
  return !!(await db.prepare('SELECT 1 AS hit FROM pricing_audit WHERE idempotency_key = ?').bind(priceKey(pid, hash)).first<{ hit: number }>());
}

/**
 * The gates of every price write (see above), then the batch. `preview` builds
 * the preview a refusal returns. Answers 'already' when the same preview was
 * saved before (a replay), 'saved' otherwise.
 */
async function commitEngine(
  c: Context<AppContext>,
  ev: EngineEvaluation,
  writes: { inputWrites: InputWriteList; ruleWrites: RuleWriteList },
  gate: { hash: unknown; confirm: unknown; dataHash?: string | null },
  opts: { source: string; preview: () => Promise<unknown>; extraAudits?: D1PreparedStatement[]; auditDetail?: Record<string, unknown>; extraStatements?: D1PreparedStatement[] }
): Promise<'saved' | 'already'> {
  const db = c.env.DB;
  const pid = ev.product_id;
  if (!ev.complete) {
    // An engine product never loses its price: a save that would leave it incomplete is refused.
    throw new HttpError(409, serverMessage('PRICING_ENGINE_INCOMPLETE'), 'PRICING_ENGINE_INCOMPLETE', { missing_codes: ev.codes, preview: await opts.preview() });
  }
  if (await priceReplayed(db, pid, gate.hash)) return 'already';
  if (!isHash(gate.hash) || gate.hash !== ev.hash) {
    // No hash (or only the dinar conversion's): the owner has not seen the new prices yet.
    const required = !isHash(gate.hash) || gate.hash === gate.dataHash;
    const code = required ? 'PRICING_PREVIEW_REQUIRED' : 'PRICING_PREVIEW_STALE';
    throw new HttpError(409, serverMessage(code), code, { preview: await opts.preview() });
  }
  if (ev.large_change) {
    if (gate.confirm !== true) throw new HttpError(409, serverMessage('PRICING_LARGE_CHANGE_CONFIRM'), 'PRICING_LARGE_CHANGE_CONFIRM', { preview: await opts.preview() });
    requireFreshSession(c);
  }
  const statements = [
    ...(opts.extraStatements ?? []),
    ...(await engineWriteStatements(db, ev, writes.inputWrites, writes.ruleWrites, {
      actor: c.get('user')!.id,
      now: new Date().toISOString(),
      source: opts.source,
      idempotencyKey: priceKey(pid, ev.hash!),
      extraAudits: opts.extraAudits,
      auditDetail: opts.auditDetail,
    })),
  ];
  if (statements.length > ENGINE_STATEMENT_CAP) throw new HttpError(409, serverMessage('PRICING_SET_TOO_LARGE'), 'PRICING_SET_TOO_LARGE');
  try {
    await db.batch(statements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed: pricing_audit\.idempotency_key/i.test(msg)) return 'already';
    if (isFenceMiss(e) || /UNIQUE constraint failed: ops_guards/i.test(msg)) throw fxRefusal(409, 'PRICING_CHANGED');
    const refusal = engineDbRefusal(e);
    if (refusal) throw refusal;
    throw e;
  }
  const slug = (await db.prepare('SELECT slug FROM products WHERE id = ?').bind(pid).first<{ slug: string }>())?.slug;
  await afterCatalogueWrite(c, slug ? [slug] : []);
  return 'saved';
}

type InputWriteList = ReturnType<typeof effectiveWrites>['inputWrites'];
type RuleWriteList = ReturnType<typeof effectiveWrites>['ruleWrites'];

adminPricingRoutes.put('/products/:id/inputs', async (c) => {
  assertCostWrite(c);
  const body = strictBody(await jsonObject(c), ['inputs_seq', 'inputs', 'rules', 'preview_hash', 'confirm_large_change', 'adopt']);
  if (body.adopt !== undefined && typeof body.adopt !== 'boolean') throw inputInvalid('adopt');
  if (body.confirm_large_change !== undefined && typeof body.confirm_large_change !== 'boolean') throw inputInvalid('confirm_large_change');
  const { db, rates, loaded, stored, ctx, reads } = await productInputsContext(c);
  if (rates.derived_stale) throw fxRefusal(409, 'FX_DERIVED_STALE');
  const pid = loaded.id;
  if (typeof body.inputs_seq !== 'number' || !Number.isSafeInteger(body.inputs_seq) || body.inputs_seq < 0) throw inputInvalid('inputs_seq');
  // A replay of a saved preview (the same hash) answers as the first save did.
  if (await priceReplayed(db, pid, body.preview_hash)) return c.json({ ...(await productInputsAnswer(loaded, stored, ctx, rates, undefined, reads)), already: true });
  // Fenced on what the owner looked at: a purchase applied or a second tab saved since is a fresh look.
  if (body.inputs_seq !== (stored.state?.inputs_seq ?? 0)) throw fxRefusal(409, 'PRICING_CHANGED');
  const now = new Date().toISOString();
  const draft = parseProductInputs(body, loaded, stored, { rates, now });
  const writes = effectiveWrites(draft);
  const ev = await productEngineEvaluation(loaded, stored, ctx, rates, draft, reads, { adopt: body.adopt === true, writes });
  const actor = c.get('user')!.id;
  const inputAudits = (source: string) => [
    ...writes.inputWrites.map((w) =>
      pricingAuditStatement(db, {
        entity: 'input',
        entity_key: `${w.scope}:${w.scope_id}`,
        product_id: pid,
        action: 'update',
        before: inputImage(w.existing ? { ...w.existing, iqd: storedIqdOf(w.existing) } : null),
        after: inputImage(nextInputRow(w)),
        summary: { source },
        actor,
        now,
      })
    ),
    ...writes.ruleWrites.map((w) =>
      pricingAuditStatement(db, { entity: 'rule', entity_key: `${w.kind}:${w.scope}:${w.scope_id}`, product_id: pid, action: 'rule_set', before: ruleImage(w.existing), after: ruleImage(w.next), summary: { source }, actor, now })
    ),
  ];

  // Owner decision 8: the save writes prices (adopt / reprice) — or stores the data only.
  if (ev.kind && (ev.needs_write || !ev.complete)) {
    const dataHash = await formPreviewHash(pid, draft.iqd, rates);
    await commitEngine(
      c,
      ev,
      writes,
      { hash: body.preview_hash, confirm: body.confirm_large_change, dataHash },
      {
        source: 'product_form',
        preview: () => productInputsAnswer(loaded, stored, ctx, rates, draft, reads, { evaluation: ev }),
        extraAudits: inputAudits('product_form'),
        auditDetail: { inputs_changed: writes.inputWrites.length, rules_changed: writes.ruleWrites.length },
      }
    );
    const after = await loadProductPricing(db, pid);
    const reloaded = await loadOne(db, pid);
    return c.json(await productInputsAnswer(reloaded, after, ctx, rates, undefined, await loadEngineReads(db, pid)));
  }

  // Data only: an incomplete manual product keeps its manual price.
  // Typed dinars convert at the rate the owner was shown (FX plan §12): the preview's hash, recomputed now.
  if (draft.iqd.length) {
    if (typeof body.preview_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.preview_hash)) throw inputInvalid('preview_hash');
    if (body.preview_hash !== (await formPreviewHash(pid, draft.iqd, rates))) throw fxRefusal(409, 'PRICING_PREVIEW_STALE');
  }
  if (writes.inputWrites.length || writes.ruleWrites.length) {
    const statements = [
      ...batchHead(db, stored, now),
      ...inputStatements(db, pid, writes.inputWrites, actor, now),
      ...ruleStatements(db, pid, writes.ruleWrites, actor, now),
      ...inputAudits('product_form'),
      ...(await auditStatements(db, actor, 'pricing.inputs.updated', pid, { product_id: pid, inputs_changed: writes.inputWrites.length, rules_changed: writes.ruleWrites.length, inputs_seq: stored.state?.inputs_seq ?? 0 })).statements,
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
  return c.json(await productInputsAnswer(loaded, after, ctx, rates, undefined, await loadEngineReads(db, pid)));
});

// ------------------------------------------------------------ the save list: stale engine prices and complete-but-manual products
//
//   GET  /save-list                every engine product whose stored price was computed at a confirmed rate
//                                  that moved since (stale; with the code of one the automatic repricing could
//                                  not reach), every manual product whose data is complete (ready), and the
//                                  automatic repricing's status «يُعاد التسعير تلقائياً» (counts, the pause, the
//                                  last run) — what the «التسعير والشحن» page and the rates panel show
//   POST /save-list/preview        {product_ids} (≤ 20): each product's preview and hash, for one bulk save
//   POST /products/save-bulk       {items:[{product_id, preview_hash}], confirm_large_change?} (≤ 20): each
//                                  product its own atomic batch — the owner's manual tool beside FX-5's
//                                  automatic repricing, which works through the same stale list

const BULK_MAX = 20;

const productNames = (loaded: LoadedProduct) => ({
  name_ar: String(loaded.doc.name_ar ?? ''),
  name_en: String(loaded.doc.name_en ?? ''),
  name_ckb: String(loaded.doc.name_ckb ?? ''),
  slug: String(loaded.doc.slug ?? ''),
});

adminPricingRoutes.get('/save-list', async (c) => {
  const db = c.env.DB;
  // Deploy-ahead of 0181 (CLAUDE.md rule 2): without the engine's tables no product is engine-priced
  // and none holds stored pricing data, so both lists are truthfully empty — the rates panel (FX-1)
  // and «التسعير والشحن» keep answering exactly as on a migrated database with no engine product.
  if (!(await engineCoreInstalled(db))) return c.json({ success: true, stale: { count: 0, items: [] }, ready: { count: 0, items: [] }, auto: null });
  const rates = await engineRates(db);
  const { results } = await db
    .prepare(
      "SELECT s.product_id, s.mode, s.opted_out_at, s.reprice_blocked_code FROM product_pricing_state s JOIN products p ON p.id = s.product_id WHERE COALESCE(p.composition, '') = '' ORDER BY s.product_id"
    )
    .all<{ product_id: string; mode: string; opted_out_at: string | null; reprice_blocked_code: string | null }>();
  const states = results ?? [];
  const ids = states.map((s) => s.product_id);
  const [loaded, stores, costs, ctx, control] = await Promise.all([loadProducts(db, ids), loadProductsPricing(db, ids), loadStoredSkuCosts(db, ids), loadPreviewContext(db), loadEngineControl(db)]);
  const stale: Array<Record<string, unknown>> = [];
  const ready: Array<Record<string, unknown>> = [];
  for (const st of states) {
    const product = loaded.get(st.product_id);
    if (!product) continue;
    if (st.mode === 'engine') {
      const own = costs.filter((r) => r.product_id === st.product_id);
      const reasons = staleReasons(own, rates);
      // FX-7: priced per SKU, a SKU added since (a new colour) sells at its model's highest price until
      // the product is saved again — listed as `SKUS` (codes only).
      if (own.some((r) => r.combo_key.includes('c:') || r.combo_key.includes('|'))) {
        const stored = new Set(own.map((r) => r.combo_key));
        if (sellableSkus(product.doc, product.view).skus.some((k) => !stored.has(k.combo_key))) reasons.push('SKUS');
      }
      // `blocked_code`: the automatic repricing could not reach it (a code, never a figure).
      if (reasons.length) stale.push({ product_id: st.product_id, ...productNames(product), reasons, blocked_code: st.reprice_blocked_code ?? null });
      continue;
    }
    if (st.opted_out_at) continue;
    // FX-7 gaps: its SKU prices could not be read this time — not listed as ready until a read succeeds.
    if (skuReadFailed(product)) continue;
    const stored = stores.get(st.product_id)!;
    const ev = await evaluateEngineWrite({ loaded: product, stored, ctx, rates, control, inputs: stored.inputs, inputWrites: [], ruleWrites: [], image: '', storedCosts: [] });
    if (ev.kind === 'adopt') ready.push({ product_id: st.product_id, ...productNames(product), reasons: [] });
  }
  const status = await autoRepriceStatus(db, rates);
  const auto = status
    ? {
        // «يُعاد التسعير تلقائياً»: stale engine products are being repriced on the next ticks.
        active: status.stale > 0 && !status.paused && !status.derived_stale,
        paused: status.paused,
        stale: status.stale,
        blocked: status.blocked,
        last_run: status.last_run,
      }
    : null;
  return c.json({ success: true, stale: { count: stale.length, items: stale }, ready: { count: ready.length, items: ready }, auto });
});

/** One product's bulk evaluation (no drafts): its preview and hash. */
async function bulkEvaluation(db: D1Database, pid: string, rates: PricingRates, ctx: Awaited<ReturnType<typeof loadPreviewContext>>) {
  const loaded = await loadOne(db, pid);
  const [stored, reads] = await Promise.all([loadProductPricing(db, pid), loadEngineReads(db, pid)]);
  const ev = await productEngineEvaluation(loaded, stored, ctx, rates, { inputs: [], rules: [], iqd: [] }, reads);
  return { loaded, stored, reads, ev };
}

function productIdList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > BULK_MAX || raw.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(x))) throw inputInvalid(field);
  return [...new Set(raw as string[])];
}

adminPricingRoutes.post('/save-list/preview', async (c) => {
  const body = strictBody(await jsonObject(c), ['product_ids']);
  const db = c.env.DB;
  const rates = await engineRates(db);
  const ctx = await loadPreviewContext(db);
  const items = [];
  for (const pid of productIdList(body.product_ids, 'product_ids')) {
    const { loaded, ev } = await bulkEvaluation(db, pid, rates, ctx);
    items.push({ product_id: pid, ...productNames(loaded), preview: engineEvaluationDto(ev) });
  }
  return c.json({ success: true, items });
});

adminPricingRoutes.post('/products/save-bulk', async (c) => {
  assertCostWrite(c);
  const body = strictBody(await jsonObject(c), ['items', 'confirm_large_change']);
  if (body.confirm_large_change !== undefined && typeof body.confirm_large_change !== 'boolean') throw inputInvalid('confirm_large_change');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > BULK_MAX) throw inputInvalid('items');
  const items = body.items.map((raw, i) => {
    const r = strictBody(raw, ['product_id', 'preview_hash']);
    if (typeof r.product_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(r.product_id)) throw inputInvalid(`items[${i}].product_id`);
    if (!isHash(r.preview_hash)) throw inputInvalid(`items[${i}].preview_hash`);
    return { product_id: r.product_id, preview_hash: r.preview_hash };
  });
  if (new Set(items.map((i) => i.product_id)).size !== items.length) throw inputInvalid('items');
  const db = c.env.DB;
  const rates = await engineRates(db);
  if (rates.derived_stale) throw fxRefusal(409, 'FX_DERIVED_STALE');
  // One fresh sign-in covers the whole confirmed bulk save of large changes.
  if (body.confirm_large_change === true) requireFreshSession(c);
  const ctx = await loadPreviewContext(db);
  const results: Array<{ product_id: string; status: string; code?: string }> = [];
  for (const item of items) {
    try {
      const { ev } = await bulkEvaluation(db, item.product_id, rates, ctx);
      if (!ev.kind || (!ev.needs_write && ev.complete)) {
        results.push({ product_id: item.product_id, status: 'unchanged' });
        continue;
      }
      const status = await commitEngine(c, ev, { inputWrites: [], ruleWrites: [] }, { hash: item.preview_hash, confirm: body.confirm_large_change }, { source: 'bulk', preview: async () => engineEvaluationDto(ev) });
      results.push({ product_id: item.product_id, status });
    } catch (e) {
      // FX-7 gaps: a failed read of one product's SKU prices refuses that product (retryable), not the bulk.
      if (e instanceof HttpError && e.status !== 401 && (e.status < 500 || e.code === 'PRICING_READ_FAILED')) {
        results.push({ product_id: item.product_id, status: 'refused', code: e.code ?? 'REFUSED' });
        continue;
      }
      throw e;
    }
  }
  c.set('completenessIds', results.filter((r) => r.status !== 'unchanged' && r.status !== 'refused').map((r) => r.product_id));
  return c.json({ success: true, results });
});

// ------------------------------------------------------------ back to manual (the owner's way out; MVP «رجوع إلى اليدوي»)
//
// The product's mode becomes manual under its mode token; every price stays
// exactly as the engine wrote it (nothing is restored); inputs and rules stay.
// Its prices are then edited the old way again, and a later save adopts the
// engine only when the owner asks for it.

adminPricingRoutes.post('/products/:id/manual', async (c) => {
  assertCostWrite(c);
  const body = strictBody(await jsonObject(c), ['write_seq']);
  const db = c.env.DB;
  await engineRates(db);
  const loaded = await loadOne(db, c.req.param('id'));
  const pid = loaded.id;
  const stored = await loadProductPricing(db, pid);
  if (stored.state?.mode !== 'engine') throw new HttpError(409, serverMessage('PRICING_NOT_MANAGED'), 'PRICING_NOT_MANAGED');
  if (typeof body.write_seq !== 'number' || body.write_seq !== stored.state.write_seq) throw fxRefusal(409, 'PRICING_CHANGED');
  // FX-7 gaps: a failed read of the SKU prices is not "none": flipping to manual without deleting them
  // would leave SKU rows that override every manual price. Refused, retryable; nothing is written.
  refuseUnreadSkus(loaded);
  const actor = c.get('user')!.id;
  const now = new Date().toISOString();
  // How many per-SKU prices the product carries (0 on a database without 0183, or priced per model).
  const skuRows = skuTableOf(loaded) ? (loaded.view?.sku_prices?.length ?? 0) : 0;
  try {
    await db.batch([
      ...fence(db, "EXISTS(SELECT 1 FROM product_pricing_state WHERE product_id = ? AND mode = 'engine' AND write_seq = ?)", [pid, stored.state.write_seq]),
      db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`pricing-mode:${pid}`),
      db
        .prepare("UPDATE product_pricing_state SET mode = 'manual', write_seq = write_seq + 1, opted_out_at = ?, opted_out_by = ?, updated_at = ? WHERE product_id = ?")
        .bind(now, actor, now, pid),
      db.prepare('DELETE FROM pricing_sku_costs WHERE product_id = ?').bind(pid),
      // FX-7 (0183): a SKU's own price cannot live in the manual fields; it returns to its model's —
      // the highest of the model's SKUs, never lower (the confirmation said so). After the mode flip,
      // so the rows' engine guard lets them go.
      ...(skuRows ? [db.prepare('DELETE FROM product_sku_prices WHERE product_id = ?').bind(pid)] : []),
      pricingAuditStatement(db, {
        entity: 'engine_mode',
        entity_key: pid,
        product_id: pid,
        action: 'engine_exit',
        before: { mode: 'engine' },
        after: { mode: 'manual' },
        ...(skuRows ? { summary: { sku_rows_removed: skuRows } } : {}),
        actor,
        now,
      }),
      ...(await auditStatements(db, actor, 'pricing.engine.exited', pid, { product_id: pid })).statements,
      db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`pricing-mode:${pid}`),
    ]);
  } catch (e) {
    if (isFenceMiss(e) || /UNIQUE constraint failed: ops_guards/i.test(e instanceof Error ? e.message : String(e))) throw fxRefusal(409, 'PRICING_CHANGED');
    throw e;
  }
  return c.json({ success: true, product_id: pid, mode: 'manual' });
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
