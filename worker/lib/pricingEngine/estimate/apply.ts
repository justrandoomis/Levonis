/**
 * «طبّق» — THE ESTIMATE APPLY: ONE ATOMIC BATCH PER PRODUCT
 * (docs/SMART_PRICING.md §4.7, §4.8; DECISIONS rows 278–280).
 *
 * POST /estimates/apply {items:[{product_id, preview_hash, confirm_large_change?}] | cursor} takes up to five
 * products. Each is re-prepared exactly as compute prepared it (./compute.ts), refused alone when anything
 * moved — one product's refusal never stops the others — and written in ONE batch:
 *
 *   (i)   a fence: never-on-published — the label is on, or no V2 result exists: a firm V2 price is never
 *         turned into an estimate;
 *   (ii)  for a product the apply restructures (5b), or whose «بلا تتبّع» it records: a fence that it still
 *         holds no stock number, no lot and no order-type cell;
 *   (iii) the «بلا تتبّع» decision (worker/lib/importStock.ts `untrackedDecisionStatements`), only while
 *         `not_configured`, laid BEFORE the V2 writer's `importStockFence`, as procurementImportStock.ts
 *         does for «تتبّع الكمية»;
 *   (iv)  the V2 writer itself (`v2WriteStatements`) with the structure (5b: the planner's statements that
 *         make the product pre-order-only on its one route), the clean start's first-write retirement, and
 *         its one additive option `estimate`: the decision's PREORDER_OFFERED fence (true only after the
 *         structure), `products.price_estimate = 1` (trigger T1: only inside this price write), the firm
 *         SKUs cleared (a re-apply makes every SKU an estimate again), and the bookkeeping, fenced on the
 *         version read.
 *
 * There is no unlabelled moment: the label and the first price commit together; FX-5, form saves and purchase
 * reviews never touch the label; a SKU added later and priced by any door is labelled, the label being the
 * product's.
 *
 * THE BUDGET: `countedEstimateDb` counts every read and batch of the call, which stops before 900 statements
 * (D1's 1,000 per invocation minus a reserve of 100): a product whose reads plus batch would cross it is
 * returned in `cursor`, to send again.
 */
import type { Context } from 'hono';
import type { AppContext } from '../../types';
import { HttpError } from '../../http';
import { fence, isFenceMiss } from '../../operations';
import { afterProductsChanged } from '../../completenessHooks';
import { afterCatalogueWrite } from '../../edgePolicy';
import { NO_STOCK_SETUP_SQL, noStockSetupBinds, preorderOfferedFence, untrackedDecisionStatements } from '../../importStock';
import { engineDbRefusal } from '../../pricingDbRefusals';
import { inputInvalid } from '../whatIf';
import { gateV2, v2BatchOutcome, v2PriceKey, v2Replayed } from '../v2/api';
import { firstWriteStatements, foldedReviewOf } from '../v2/firstWrite';
import { V2_PRICING_STATEMENT_CAP, V2_SAVE_STATEMENT_CAP, v2WriteStatements } from '../v2/write';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { isEstimateRefusalCode } from '@levonis/contracts/priceEstimates';
import { estimatePolicyInForce, estimateRefusal } from './control';
import { countedEstimateDb, lineStatements, loadEstimatePage, prepareEstimate, productFlagsJson, type EstimateContext, type PreparedEstimate } from './compute';
import { ESTIMATE_APPLY_PAGE, ESTIMATE_APPLY_SOURCE, ESTIMATE_INVOCATION_LIMIT, ESTIMATE_PRODUCT_READS, type EstimatePreview } from './types';

export interface ApplyItem {
  product_id: string;
  preview_hash: string;
  confirm_large_change?: boolean;
}

export type ApplyOutcome =
  | { product_id: string; outcome: 'applied'; preview: EstimatePreview }
  | { product_id: string; outcome: 'already' }
  | { product_id: string; outcome: 'refused'; code: string; details?: Record<string, unknown> };

export interface ApplyAnswer {
  results: ApplyOutcome[];
  /** The items not attempted (the invocation budget): send them again as `cursor`. Null when every item was attempted. */
  cursor: ApplyItem[] | null;
  /**
   * The D1 statements the products took (reads and batches), never above the limit. The door's reads before
   * and the completeness hook and the purge after are what the reserve of 100 is for.
   */
  spent: number;
}

const PRODUCT_ID = /^[A-Za-z0-9_:.-]{1,80}$/;
const HASH = /^[0-9a-f]{64}$/;

/** The items of an apply body (`items`, or the `cursor` a previous answer returned): ≤ 5, each strict. */
export function parseApplyItems(raw: unknown): ApplyItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ESTIMATE_APPLY_PAGE) throw inputInvalid('items');
  const seen = new Set<string>();
  return raw.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw inputInvalid(`items[${i}]`);
    const o = x as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['product_id', 'preview_hash', 'confirm_large_change'].includes(k)) throw new HttpError(400, serverMessage('UNKNOWN_FIELD'), 'UNKNOWN_FIELD', { field: k });
    if (typeof o.product_id !== 'string' || !PRODUCT_ID.test(o.product_id) || seen.has(o.product_id)) throw inputInvalid(`items[${i}].product_id`);
    seen.add(o.product_id);
    if (typeof o.preview_hash !== 'string' || !HASH.test(o.preview_hash)) throw inputInvalid(`items[${i}].preview_hash`);
    if (o.confirm_large_change !== undefined && typeof o.confirm_large_change !== 'boolean') throw inputInvalid(`items[${i}].confirm_large_change`);
    return { product_id: o.product_id, preview_hash: o.preview_hash, ...(o.confirm_large_change !== undefined ? { confirm_large_change: o.confirm_large_change } : {}) };
  });
}

/** The request's context reading `db` as its binding (so the V2 gate's and the completeness hook's reads are counted). */
function withDb(c: Context<AppContext>, db: D1Database): Context<AppContext> {
  const env = { ...c.env, DB: db } as AppContext['Bindings'];
  return new Proxy(c, {
    get(target, key) {
      if (key === 'env') return env;
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** (i) Never-on-published, at write time: the label is on, or the product has no V2 result. */
const NEVER_ON_PUBLISHED_SQL =
  'EXISTS (SELECT 1 FROM products WHERE id = ? AND price_estimate = 1) OR NOT EXISTS (SELECT 1 FROM pricing_v2_sku_results WHERE product_id = ?)';

/** The preview as the apply leaves it: estimated, labelled, every line's estimate now the published price. */
const appliedPreview = (p: PreparedEstimate): EstimatePreview => ({
  ...p.preview,
  state: 'estimated',
  label: true,
  version: (p.estimate?.version ?? 0) + 1,
  lines: p.preview.lines.map((l) => ({ ...l, published_price_iqd: l.est_price_iqd, change_pct: null, large: false })),
});

/** The `estimate` option of the V2 write (§4.8 step 4 (iv)): laid after 9b, inside the `engine-price:` token. */
function estimateStatements(db: D1Database, p: PreparedEstimate, actor: string, at: string): D1PreparedStatement[] {
  const pid = p.product_id;
  const v = p.preview;
  return [
    // The «بلا تتبّع» decision's own condition — true only once the structure above made the product pre-order.
    ...preorderOfferedFence(db, pid),
    // Trigger T1 lets this in only inside a price write (the token this batch holds).
    db.prepare('UPDATE products SET price_estimate = 1 WHERE id = ? AND price_estimate = 0').bind(pid),
    // A re-apply makes every SKU an estimate again.
    db.prepare('DELETE FROM price_estimate_firm_skus WHERE product_id = ?').bind(pid),
    // The bookkeeping, fenced on the version read.
    ...fence(db, 'COALESCE((SELECT version FROM product_price_estimates WHERE product_id = ?), 0) = ?', [pid, p.estimate?.version ?? 0]),
    db
      .prepare(
        `INSERT INTO product_price_estimates
           (product_id, type_key, type_source, state, measure_basis, flags_json, preview_hash, computed_at,
            applied_at, applied_by, applied_write_seq, applied_wire_json, version, updated_by, updated_at)
         VALUES (?1, ?2, ?3, 'estimated', ?4, ?5, ?6, ?7, ?7, ?8, (SELECT write_seq FROM product_pricing_state WHERE product_id = ?1), ?9, 1, ?8, ?7)
         ON CONFLICT(product_id) DO UPDATE SET
           type_key = excluded.type_key, type_source = excluded.type_source, state = 'estimated',
           measure_basis = excluded.measure_basis, flags_json = excluded.flags_json, preview_hash = excluded.preview_hash,
           computed_at = excluded.computed_at, applied_at = excluded.applied_at, applied_by = excluded.applied_by,
           applied_write_seq = excluded.applied_write_seq, applied_wire_json = excluded.applied_wire_json,
           confirmed_at = NULL, confirmed_by = NULL,
           version = product_price_estimates.version + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .bind(pid, v.type, v.type_source, p.plan!.measure_basis, productFlagsJson(v.flags), v.preview_hash, at, actor, p.plan!.applied_json),
    ...lineStatements(db, pid, appliedPreview(p).lines, at),
  ];
}

/** The one batch of one product (§4.8 step 4). */
async function applyStatements(db: D1Database, p: PreparedEstimate, actor: string, at: string): Promise<D1PreparedStatement[]> {
  const pid = p.product_id;
  const ev = p.ev!;
  const read = p.read!;
  const recordUntracked = p.stock_decision === 'not_configured';
  const prepare = p.structure === 'prepare';
  return [
    ...fence(db, NEVER_ON_PUBLISHED_SQL, [pid, pid]),
    ...(prepare || recordUntracked ? fence(db, NO_STOCK_SETUP_SQL, noStockSetupBinds(pid)) : []),
    ...(recordUntracked ? await untrackedDecisionStatements(db, pid, actor, at) : []),
    ...(await v2WriteStatements(db, ev, {
      actor,
      now: at,
      source: ESTIMATE_APPLY_SOURCE,
      idempotencyKey: v2PriceKey(pid, ev.hash!),
      ...(prepare ? { structure: p.structurePlan!.statements, updatedAt: p.updatedAt } : {}),
      // The clean start: a product's first complete V2 write retires its Direct Sale Extra and purchase overlay.
      ...(ev.kind === 'v2_create' ? { firstWrite: firstWriteStatements(db, read.stored, foldedReviewOf(read, 'owner', actor, at)) } : {}),
      estimate: estimateStatements(db, p, actor, at),
      auditDetail: { estimate: true, structure: p.structure, type: p.type?.key ?? null, untracked: recordUntracked },
    })),
  ];
}

const refused = (product_id: string, e: HttpError): ApplyOutcome => ({
  product_id,
  outcome: 'refused',
  code: e.code ?? 'REFUSED',
  ...(e.details ? { details: e.details } : {}),
});

/** A database refusal of one product's batch, as its outcome (a fence miss is a fresh look; a replay is `already`). */
function batchRefusal(pid: string, e: unknown): ApplyOutcome | null {
  const outcome = v2BatchOutcome(e);
  if (outcome === 'already') return { product_id: pid, outcome: 'already' };
  if (outcome) return refused(pid, outcome);
  if (isFenceMiss(e)) return refused(pid, new HttpError(409, serverMessage('PRICING_CHANGED'), 'PRICING_CHANGED'));
  // A trigger of 0218 (or the import guard) refused the batch: its code, never the driver's text.
  const msg = e instanceof Error ? e.message : String(e);
  const abort = /(PRICE_ESTIMATE_[A-Z_]+|IMPORT_FINANCIAL_WRITE_REFUSED)/.exec(msg)?.[1];
  if (abort) return refused(pid, isEstimateRefusalCode(abort) ? estimateRefusal(abort) : new HttpError(409, abort, abort));
  const engine = engineDbRefusal(e);
  if (engine) return refused(pid, engine);
  return null;
}

/**
 * Apply up to five reviewed estimates (§4.8). The owner's «apply» switch must be on and the purchase policy's
 * clause in force; each product must still be eligible, its preview hash current, and its large change ticked
 * with a fresh sign-in (`gateV2`).
 */
export async function applyEstimates(c: Context<AppContext>, items: readonly ApplyItem[], opts: { limit?: number } = {}): Promise<ApplyAnswer> {
  const { db, counter } = countedEstimateDb(c.env.DB);
  const limit = opts.limit ?? ESTIMATE_INVOCATION_LIMIT;
  const cc = withDb(c, db);
  const user = c.get('user')!;
  const now = new Date();
  const at = now.toISOString();
  const cx: EstimateContext = { env: c.env, user, actor: user.id, now };
  const page = await loadEstimatePage(db, items.map((i) => i.product_id));
  if (!page.control) throw estimateRefusal('PRICE_ESTIMATES_NOT_INSTALLED');
  if (!page.control.apply_enabled) throw estimateRefusal('PRICE_ESTIMATES_DISABLED');
  if (!estimatePolicyInForce(at.slice(0, 10))) throw estimateRefusal('PRICE_ESTIMATE_POLICY_MISSING');

  const results: ApplyOutcome[] = [];
  const deferred: ApplyItem[] = [];
  const applied: PreparedEstimate[] = [];
  for (const item of items) {
    const pid = item.product_id;
    if (deferred.length || counter.count + ESTIMATE_PRODUCT_READS > limit) {
      deferred.push(item);
      continue;
    }
    const p = await prepareEstimate(db, pid, page, cx);
    if (!p) {
      results.push({ product_id: pid, outcome: 'refused', code: 'NOT_FOUND' });
      continue;
    }
    // A replay of a committed apply (the same reviewed hash) answers as the first did, whatever moved since.
    if (await v2Replayed(db, pid, item.preview_hash)) {
      results.push({ product_id: pid, outcome: 'already' });
      continue;
    }
    const state = p.estimate?.state ?? 'candidate';
    if (p.skipped || (state !== 'candidate' && state !== 'estimated')) {
      results.push(refused(pid, estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { state, flags: p.preview.blocked_by })));
      continue;
    }
    if (p.preview.blocking || !p.ev?.hash || !p.plan || !p.read) {
      results.push(refused(pid, estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { flags: p.preview.blocked_by })));
      continue;
    }
    if (p.ev.hash !== item.preview_hash) {
      results.push(refused(pid, new HttpError(409, serverMessage('PRICING_PREVIEW_STALE'), 'PRICING_PREVIEW_STALE', { preview: p.preview })));
      continue;
    }
    let verdict;
    try {
      verdict = await gateV2({
        c: cc,
        ev: p.ev,
        hash: item.preview_hash,
        confirm: item.confirm_large_change,
        priceChange: true,
        publishing: (p.read.v2?.results.length ?? 0) === 0,
        // The «بلا تتبّع» decision is laid in this very batch, before the writer's own import fence.
        preparedImportStock: true,
        preview: async () => p.preview,
      });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      results.push(refused(pid, e));
      continue;
    }
    if (verdict === 'already') {
      results.push({ product_id: pid, outcome: 'already' });
      continue;
    }
    if (verdict !== 'write') {
      results.push(refused(pid, estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { flags: p.preview.blocked_by })));
      continue;
    }
    const statements = await applyStatements(db, p, user.id, at);
    const cap = p.structure === 'prepare' ? V2_SAVE_STATEMENT_CAP : V2_PRICING_STATEMENT_CAP;
    if (statements.length > cap) {
      results.push(refused(pid, new HttpError(409, serverMessage('PRICING_SET_TOO_LARGE'), 'PRICING_SET_TOO_LARGE', { section: 5 })));
      continue;
    }
    if (counter.count + statements.length > limit) {
      deferred.push(item);
      continue;
    }
    try {
      await db.batch(statements);
    } catch (e) {
      const outcome = batchRefusal(pid, e);
      if (!outcome) throw e;
      results.push(outcome);
      continue;
    }
    applied.push(p);
    results.push({ product_id: pid, outcome: 'applied', preview: appliedPreview(p) });
  }
  const spent = counter.count;
  if (applied.length) {
    // The completeness hook and the pages (within the reserve): the product is now sellable, with its label.
    await afterProductsChanged(cc, applied.map((p) => p.product_id));
    await afterCatalogueWrite(c, applied.map((p) => p.slug).filter((s): s is string => !!s));
  }
  return { results, cursor: deferred.length ? deferred : null, spent };
}
