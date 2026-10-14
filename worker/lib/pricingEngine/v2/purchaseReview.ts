/**
 * D1 — A CONFIRMED STOCK PURCHASE BECOMES THE CURRENT COST AFTER THE OWNER
 * REVIEWS THE PRICE CHANGE (the clean start, addendum A.10; DECISIONS rows
 * 221 D1 and 222).
 *
 *   - WHEN: the procurement document's transition to `ordered`, in that same
 *     batch. For every ordinary product on the purchase, `deriveProductEntries`
 *     (reused) computes the cost-input writes the purchase implies, and ONE
 *     `pricing_v2_purchase_reviews` row is inserted (`pending`; an older
 *     pending row of the product becomes `superseded`). No price or input moves.
 *     The receive is untouched and independent: stock can never be received
 *     while a price write silently failed, because there is no price write in
 *     that flow — the pending review is visible until decided.
 *   - PREVIEW: the review's writes laid over the product's stored V2 set and
 *     evaluated by `evaluateV2Write` (cost-first: D and every route move by the
 *     new R; price-first: prices hold, the owner sees the new `below_*`).
 *   - APPLY: the normal V2 apply (hash, the 15% tick, a fresh sign-in): one
 *     batch writes the inputs (`source_ref purchase:<id>`), prices, results,
 *     history and audit with idempotency `v2purchase:<review>:<hash>`, and
 *     marks the review `applied`.
 *   - DISMISS «أبقِ التكلفة الحالية»: the review becomes `dismissed`, audited.
 *
 * Owner-only end to end: the review's figures are cost (FINANCIAL_FIELDS
 * `purchase_review`, `v2_purchase_inputs`); everyone else gets the cost
 * refusal by name, the same body for a real and an invented id.
 */
import type { Context } from 'hono';
import type { AppContext } from '../../types';
import { HttpError } from '../../http';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { newId } from '../../crypto';
import { fence } from '../../operations';
import { auditStatements } from '../../audit';
import { cleanStartInstalled } from '../../engineInstalled';
import { deriveProductEntries, purchaseIneligibility, type PurchaseForPricing } from '../fromPurchase';
import { loadPricingRates } from '../rates';
import { loadProductsPricing, ownerRow, type InputWrite } from '../store';
import { inputInvalid } from '../whatIf';
import { desiredFor, evaluateDesired, gateV2, loadV2Read, storedMethodOf, v2Answer, v2BatchOutcome, v2ViewerOf } from './api';
import { v2DataStatements, v2WriteStatements } from './write';

/** One cost-input write as the review stores it: the scope and the fields — never the stored row. */
export interface ReviewInput {
  scope: InputWrite['scope'];
  scope_id: string;
  set: InputWrite['set'];
  source_ref: string;
}

export interface PurchaseReviewRow {
  id: string;
  product_id: string;
  purchase_id: string;
  inputs_json: string;
  state: 'pending' | 'applied' | 'dismissed' | 'superseded';
  created_at: string;
}

/**
 * The statements the `ordered` transition adds to its own batch: one pending
 * review per ordinary product on the purchase whose lines imply a cost write.
 * Nothing on a database before 0190, on a purchase whose cost cannot feed a
 * price (draft, estimated, no line), or for a composition.
 */
export async function purchaseReviewStatements(db: D1Database, purchase: PurchaseForPricing, actor: string, now: string): Promise<D1PreparedStatement[]> {
  if (!purchase.purchase_id || !(await cleanStartInstalled(db))) return [];
  const ids = [...new Set(purchase.lines.map((l) => l.product_id).filter((x): x is string => typeof x === 'string' && x !== ''))];
  if (!ids.length) return [];
  const ordinary = new Set(
    ((await db.prepare("SELECT id FROM products WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(composition, '') = ''").bind(JSON.stringify(ids)).all<{ id: string }>()).results ?? []).map(
      (r) => r.id
    )
  );
  const pids = ids.filter((id) => ordinary.has(id));
  if (!pids.length) return [];
  const stored = await loadProductsPricing(db, pids);
  const rates = await loadPricingRates(db);
  const out: D1PreparedStatement[] = [];
  for (const pid of pids) {
    const data = stored.get(pid);
    if (!data) continue;
    const lines = purchase.lines.filter((l) => l.product_id === pid);
    if (purchaseIneligibility({ status: purchase.status, cost_state: purchase.cost_state, lines })) continue;
    const derived = deriveProductEntries(purchase, pid, data, { optIn: new Set(), prefer: false, usePurchase: true, rates });
    const inputs: ReviewInput[] = derived.entries
      .filter((e) => Object.keys(e.write.set).length > 0)
      .map((e) => ({ scope: e.write.scope, scope_id: e.write.scope_id, set: e.write.set, source_ref: e.write.source_ref }));
    if (!inputs.length) continue;
    out.push(
      db
        .prepare("UPDATE pricing_v2_purchase_reviews SET state = 'superseded', decided_at = ?, decided_by = ? WHERE product_id = ? AND state = 'pending'")
        .bind(now, actor, pid),
      db
        .prepare(
          `INSERT INTO pricing_v2_purchase_reviews (id, product_id, purchase_id, inputs_json, state, created_at, created_by)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`
        )
        .bind(newId('pvr'), pid, purchase.purchase_id, JSON.stringify(inputs), now, actor)
    );
  }
  return out;
}

/** The product's pending review (or the named one), or null. A database before 0190 has none. */
export async function loadPurchaseReview(db: D1Database, productId: string, reviewId?: string): Promise<PurchaseReviewRow | null> {
  try {
    return reviewId
      ? await db.prepare('SELECT id, product_id, purchase_id, inputs_json, state, created_at FROM pricing_v2_purchase_reviews WHERE id = ? AND product_id = ?').bind(reviewId, productId).first<PurchaseReviewRow>()
      : await db
          .prepare("SELECT id, product_id, purchase_id, inputs_json, state, created_at FROM pricing_v2_purchase_reviews WHERE product_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1")
          .bind(productId)
          .first<PurchaseReviewRow>();
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

export const reviewInputsOf = (row: PurchaseReviewRow): ReviewInput[] => {
  try {
    const v = JSON.parse(row.inputs_json) as unknown;
    return Array.isArray(v) ? (v as ReviewInput[]) : [];
  } catch {
    return [];
  }
};

/** The review as the owner reads it (FINANCIAL_FIELDS `purchase_review`). */
export const reviewView = (row: PurchaseReviewRow) => ({
  id: row.id,
  purchase_id: row.purchase_id,
  state: row.state,
  created_at: row.created_at,
  inputs: reviewInputsOf(row).map((i) => ({ scope: i.scope, scope_id: i.scope_id, fields: i.set })),
});

const refusal = (status: number, code: Parameters<typeof serverMessage>[0], details: Record<string, unknown> = {}) =>
  new HttpError(status, serverMessage(code), code, { section: 3, ...details });

/** The product's V2 read with the review's writes laid over its stored set. */
async function reviewEvaluation(c: Context<AppContext>, productId: string, row: PurchaseReviewRow) {
  const db = c.env.DB;
  const user = c.get('user')!;
  const read = await loadV2Read(db, productId);
  if (!read) throw new HttpError(404, 'Product not found', 'NOT_FOUND');
  // A product still in the «يحتاج تسعيرًا» queue is priced from its form (the review feeds that sheet).
  if (!storedMethodOf(read)) throw refusal(409, 'PRICING_V2_NEEDS_PRICING');
  const viewer = v2ViewerOf(c.env, user);
  const now = new Date().toISOString();
  const desired = desiredFor(read, { sent: [] }, { viewer, env: c.env, user, now });
  desired.inputWrites = reviewInputsOf(row).map((i) => ({ scope: i.scope, scope_id: i.scope_id, existing: ownerRow(read.stored.inputs, i.scope, i.scope_id), set: i.set, source_ref: i.source_ref }));
  const ev = await evaluateDesired(read, desired);
  return { read, ev, viewer, now };
}

export async function previewPurchaseReview(c: Context<AppContext>, productId: string, reviewId: string): Promise<Record<string, unknown>> {
  const row = await loadPurchaseReview(c.env.DB, productId, reviewId);
  if (!row) throw new HttpError(404, 'Review not found', 'NOT_FOUND');
  if (row.state !== 'pending') throw refusal(409, 'PRICING_REVIEW_DECIDED');
  const { read, ev, viewer } = await reviewEvaluation(c, productId, row);
  return { success: true, review: reviewView(row), preview: v2Answer({ viewer, read, ev }) };
}

export async function applyPurchaseReview(c: Context<AppContext>, productId: string, reviewId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const db = c.env.DB;
  const row = await loadPurchaseReview(db, productId, reviewId);
  if (!row) throw new HttpError(404, 'Review not found', 'NOT_FOUND');
  if (row.state !== 'pending') {
    if (row.state === 'applied') return { success: true, already: true };
    throw refusal(409, 'PRICING_REVIEW_DECIDED');
  }
  if (body.confirm_large_change !== undefined && typeof body.confirm_large_change !== 'boolean') throw inputInvalid('confirm_large_change');
  const { read, ev, viewer, now } = await reviewEvaluation(c, productId, row);
  const verdict = await gateV2({
    c,
    ev,
    hash: body.preview_hash,
    confirm: body.confirm_large_change,
    // The owner always sees the review's sheet before its costs are written.
    priceChange: true,
    publishing: false,
    preview: async () => v2Answer({ viewer, read, ev }),
  });
  if (verdict === 'already') return { success: true, already: true };
  const actor = c.get('user')!.id;
  const decided = [
    ...fence(db, "EXISTS(SELECT 1 FROM pricing_v2_purchase_reviews WHERE id = ? AND state = 'pending')", [row.id]),
    db.prepare("UPDATE pricing_v2_purchase_reviews SET state = 'applied', decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'").bind(now, actor, row.id),
  ];
  const opts = {
    actor,
    now,
    source: 'purchase_review',
    idempotencyKey: `v2purchase:${row.id}:${ev.hash}`,
    auditDetail: { purchase_review_id: row.id, purchase_id: row.purchase_id },
    extraAudits: decided,
  };
  const statements = verdict === 'data' ? await v2DataStatements(db, ev, opts) : await v2WriteStatements(db, ev, opts);
  try {
    await db.batch(statements);
  } catch (e) {
    const outcome = v2BatchOutcome(e);
    if (outcome === 'already') return { success: true, already: true };
    if (outcome) throw outcome;
    throw e;
  }
  return { success: true, applied: true, priced: verdict !== 'data' };
}

export async function dismissPurchaseReview(c: Context<AppContext>, productId: string, reviewId: string): Promise<Record<string, unknown>> {
  const db = c.env.DB;
  const row = await loadPurchaseReview(db, productId, reviewId);
  if (!row) throw new HttpError(404, 'Review not found', 'NOT_FOUND');
  if (row.state === 'dismissed') return { success: true, already: true };
  if (row.state !== 'pending') throw refusal(409, 'PRICING_REVIEW_DECIDED');
  const actor = c.get('user')!.id;
  const now = new Date().toISOString();
  const audit = await auditStatements(db, actor, 'pricing.v2.purchase_review_dismissed', productId, { product_id: productId, purchase_review_id: row.id, purchase_id: row.purchase_id });
  await db.batch([
    db.prepare("UPDATE pricing_v2_purchase_reviews SET state = 'dismissed', decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'").bind(now, actor, row.id),
    ...audit.statements,
  ]);
  return { success: true, dismissed: true };
}
