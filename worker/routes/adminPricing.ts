/**
 * «التسعير والشحن» — THE OWNER'S PRICING WORKSPACE, P1: READ ONLY
 * (MVP plan §6 P1; master plan v2 E4 chain; owner decision 2).
 *
 * Mounted at /api/admin/pricing:
 *   GET  /overview                    the clean start's counts: products published in
 *                                      dollars (V2) and products that still need pricing
 *                                      (hidden from customers; the «يحتاج تسعيرًا» queue
 *                                      under /api/admin/products-v2/needs-pricing lists them)
 * The V1 engine's product doors (the product sheet, «كم سيصبح السعر؟», the purchase
 * apply, the rules and inputs panel, the stale list, the exit to manual, the legacy
 * adoption) answer 409 PRICING_V2_MANAGED for every product since the clean start
 * (the owner's answer Q6, DECISIONS row 222; spec addendum A.6) — see «the legacy
 * doors» at the end of this file.
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
import { SESSION_CACHE_CONTROL, originOf, purgeCatalogueFromJob } from '../lib/edgePolicy';
import { auditStatements } from '../lib/audit';
import { fence } from '../lib/operations';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { ratioExceedsPct, sameRate, sumOfMoves } from '@levonis/pricing/fxChain';
import { fxKeyConfigured, runFxScheduler } from '../lib/fx/scheduler';
import {
  iso,
  isMissingTable,
  loadPairs,
  type FxPairId,
  type FxPairRow,
} from '../lib/fx/pairs';
import { isFenceMiss, planPairBatch, refusalCodeOf } from '../lib/fx/commit';
import { toStatements } from '../lib/fx/write';
import { historyItemDto, ratesDto } from '../lib/fx/dto';
import { engineProductCount, loadHistory, loadRatesReadModel } from '../lib/fx/read';
import { notifyOwnerFx } from '../lib/fx/notify';
import { sweepStaleEnginePrices } from '../lib/fx/reprice';
import { FX_INVOCATION_STATEMENT_BUDGET, statementBudget } from '../lib/fx/budget';
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
import { loadPreviewContext, loadProducts, type LoadedProduct } from '../lib/pricingEngine/load';
import { inputInvalid } from '../lib/pricingEngine/whatIf';
import { engineCoreInstalled } from '../lib/engineInstalled';
import { loadPricingRates, type PricingRates } from '../lib/pricingEngine/rates';
import { loadProductsPricing } from '../lib/pricingEngine/store';
import { directPurchaseStore } from '../lib/pricingEngine/directPurchase';
import {
  MinimumProfitError,
  parseMinimumProfit,
  type DirectSaleExtraDraft,
  type MinimumProfitDraft,
  type PurchaseForPricing,
} from '../lib/pricingEngine/fromPurchase';
import { lineSummary, previewProduct, type PreviewOptions, type ProductPreview } from '../lib/pricingEngine/procurementPreview';
import { lineDto, productPreviewDto, ratesHeadDto } from '../lib/pricingEngine/procurementDto';
import { parseDirectSaleExtraAmount } from '../lib/pricingEngine/ownerRules';
import { parseProcurementDraft } from '../lib/procurementDraft';
import { committedPurchaseForPricing, draftForPricing } from '../lib/pricingEngine/purchaseRead';
import { FX_GUARD_CHANGED, recordSecurityEvent } from '../lib/securityEvents';
import { previewRateAct, type RateMove, type RatePreview } from '../lib/pricingEngine/ratePreview';
import { FRESH_SESSION_SECONDS, sessionAgeSeconds } from '../lib/session';
import { loadBatches, type BatchFilter } from '../lib/batchSnapshot';
import { v2PublicationCounts } from '../lib/pricingEngine/v2/queue';

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

/** 409 PRICING_V2_MANAGED {section}: an old pricing door is closed (codes and the section only; see «the legacy doors» below). */
const refuseLegacyPricing = (section: 3 | 5) => () => {
  throw new HttpError(409, serverMessage('PRICING_V2_MANAGED'), 'PRICING_V2_MANAGED', { section, v2: true });
};

/**
 * The pricing tab's counts (the clean start, spec addendum A.6): how many ordinary products are
 * V2-published (listed by their dollar price) and how many still need pricing (hidden from every
 * customer until published — the «يحتاج تسعيرًا» queue lists them). Counts only, never a figure.
 */
adminPricingRoutes.get('/overview', async (c) => {
  const counts = await v2PublicationCounts(c.env.DB);
  return c.json({ success: true, v2: counts });
});

adminPricingRoutes.get('/products/:id', refuseLegacyPricing(3));

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

adminPricingRoutes.post('/products/:id/what-if', refuseLegacyPricing(3));

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
  for (const id of ids) {
    const product = loaded.get(id);
    if (!product || (product.doc.composition ?? '') !== '') continue;
    const data = stored.get(id)!;
    const preview = await previewProduct(purchase, { loaded: product, stored: data }, ctx, rates, opts);
    previews.set(id, preview);
    const cancelled = purchase.status === 'cancelled' && directPurchaseStore(data).inputs.some((r) => r.source_ref === `purchase:${purchase.purchase_id}`);
    // The clean start (spec addendum A.10, D1): no V1 adoption preview — a confirmed purchase becomes the
    // product's V2 price review (the owner reviews the price change in section ٣, never here).
    products.push(productPreviewDto(preview, { applied: applied.has(id), cancelled_source: cancelled, rules: directPurchaseStore(data).rules }));
  }
  const lines = purchase.lines
    .filter((l) => previews.has(l.product_id))
    .map((l) => lineDto(l, lineSummary(purchase, l, { loaded: loaded.get(l.product_id)!, stored: stored.get(l.product_id)! }, previews.get(l.product_id)!, rates)));
  return { rates, products, lines };
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

// ============================================================= the legacy doors
//
// THE CLEAN START (the owner's answer Q6, DECISIONS row 222; spec addendum A.6). The V1
// engine's product doors — the product sheet, «كم سيصبح السعر؟», the purchase apply, the
// rules and inputs panel and its preview, the stale list and its bulk save, the exit to
// manual pricing and «قبول القيم المرحّلة» — wrote or showed old dinar pricing. Every
// product is priced in dollars now (section ٣ «الأسعار» of the product form, V2), so each
// of these answers 409 PRICING_V2_MANAGED naming the section, for EVERY product, real or
// invented (one release, so a stale admin bundle reads a sentence; deleted in V2-7). A
// confirmed stock purchase becomes a price review (D1, spec addendum A.10), never a write.
// The routes stay registered so their classes and the owner-only door still hold.

adminPricingRoutes.post('/products/:id/apply-purchase', refuseLegacyPricing(3));
adminPricingRoutes.get('/products/:id/rules', refuseLegacyPricing(3));
adminPricingRoutes.put('/products/:id/rules', refuseLegacyPricing(3));
adminPricingRoutes.get('/products/:id/inputs', refuseLegacyPricing(3));
adminPricingRoutes.post('/products/:id/preview', refuseLegacyPricing(3));
adminPricingRoutes.put('/products/:id/inputs', refuseLegacyPricing(3));
adminPricingRoutes.get('/save-list', refuseLegacyPricing(3));
adminPricingRoutes.post('/save-list/preview', refuseLegacyPricing(3));
adminPricingRoutes.post('/products/save-bulk', refuseLegacyPricing(3));
adminPricingRoutes.post('/products/:id/manual', refuseLegacyPricing(3));
adminPricingRoutes.post('/products/:id/targets/adopt', refuseLegacyPricing(3));
