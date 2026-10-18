/**
 * D1 — A CONFIRMED STOCK PURCHASE BECOMES THE CURRENT COST AFTER THE OWNER
 * REVIEWS THE PRICE CHANGE (the clean start, addendum A.10; DECISIONS rows
 * 221 D1 and 222).
 *
 *   - WHEN: EVERY save that leaves the procurement document `ordered` with a
 *     FINAL cost (DECISIONS row 247) — the confirm, an estimated → final edit,
 *     a cost or quantity edit before receipt — in that same batch. For every
 *     ordinary product on the purchase, `deriveProductEntries` (reused) computes
 *     the cost-input writes the purchase implies, per model, colour and variant
 *     exactly as bought. A review is keyed by (product, purchase), as 0190's
 *     partial unique index allows:
 *       · the same inputs as this purchase's pending review → nothing (its id stays);
 *       · otherwise that pending review is `superseded` and a new one inserted;
 *       · another purchase's pending review of the product is superseded only
 *         when every (scope, scope_id) it names is named by the new one — so
 *         purchases of different models or colours never erase each other;
 *       · a save that leaves the document draft or estimated, and a close with
 *         nothing received (cancelled), supersede this purchase's pending reviews.
 *     No price or input moves. The receive writes stock only; when it lands
 *     units of a product whose review of this purchase waits, it rings the
 *     owner's bell once (bell.ts `purchaseReviewArrivedBell`, no figure).
 *   - PREVIEW: the review's writes laid over the product's stored V2 set and
 *     evaluated by `evaluateV2Write` (cost-first: D and every route move by the
 *     new R; price-first: prices hold, the owner sees the new `below_*`).
 *   - APPLY: the normal V2 apply (hash, the 15% tick, a fresh sign-in): one
 *     batch writes the inputs (`source_ref purchase:<id>`), prices, results,
 *     history and audit with idempotency `v2purchase:<review>:<hash>`, and
 *     marks the review `applied`. A purchase no longer ordered, partly or fully
 *     received (cancelled) is refused: PRICING_REVIEW_PURCHASE_CANCELLED.
 *     A local dinar purchase's supplier cost is offered converted once to USD
 *     at the purchase's U, with that conversion's snapshot (IQD_CONVERTED).
 *   - DISMISS «أبقِ التكلفة الحالية»: the review becomes `dismissed`, audited.
 *   - A product still in «يحتاج تسعيرًا» (no method): these doors answer
 *     PRICING_V2_NEEDS_PRICING; the review is folded into the OWNER's prefill
 *     instead (v2/firstWrite.ts `reviewFoldInputs`) and the owner's first
 *     complete write marks it applied in its own batch. An editor's first
 *     write leaves it pending for the owner.
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
import { deriveProductEntries, purchaseIneligibility, shadowedOf, type PurchaseForPricing, type PurchaseSkuLevels } from '../fromPurchase';
import { loadPricingRates } from '../rates';
import { loadProducts, type LoadedProduct } from '../load';
import { purchaseSkuLevels } from '../procurementPreview';
import { inputWriteIsNoop, loadProductsPricing, ownerRow, type InputWrite, type IqdSnapshot, type StoredInputRow } from '../store';
import { inputInvalid } from '../whatIf';
import { parseSkuComboKey } from '@levonis/pricing/skuChannel';
import { desiredFor, evaluateDesired, gateV2, loadV2Read, storedMethodOf, v2Answer, v2BatchOutcome, v2ViewerOf } from './api';
import { v2DataStatements, v2WriteStatements } from './write';

/** One cost-input write as the review stores it: the scope and the fields — never the stored row. */
export interface ReviewInput {
  scope: InputWrite['scope'];
  scope_id: string;
  set: InputWrite['set'];
  source_ref: string;
  /** A dinar purchase's conversion (row 247): the supplier cost in `set` is its USD. */
  iqd?: IqdSnapshot;
}

export interface PurchaseReviewRow {
  id: string;
  product_id: string;
  purchase_id: string;
  inputs_json: string;
  state: 'pending' | 'applied' | 'dismissed' | 'superseded';
  created_at: string;
  /** The purchase's name («اسم الشراء») and status, joined at read time; null without the purchase row. */
  purchase_name?: string | null;
  purchase_status?: string | null;
}

/** The statuses a purchase's cost may still be applied from (row 247): units ordered or arrived at that cost. */
const APPLIABLE: ReadonlySet<string> = new Set(['ordered', 'partial', 'received']);

const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

/** This purchase's pending reviews become `superseded` (a save leaving it draft or estimated, a cancel). */
export const supersedePurchaseReviews = (db: D1Database, purchaseId: string, actor: string, now: string): D1PreparedStatement =>
  db.prepare("UPDATE pricing_v2_purchase_reviews SET state = 'superseded', decided_at = ?, decided_by = ? WHERE purchase_id = ? AND state = 'pending'").bind(now, actor, purchaseId);

const scopeKey = (i: Pick<ReviewInput, 'scope' | 'scope_id'>) => `${i.scope}:${i.scope === 'base' ? '' : i.scope_id}`;

/** Every field of `inputs` is, with the same value, in the decided review's inputs (the owner answered these figures). */
const coveredBy = (inputs: readonly ReviewInput[], decidedJson: string): boolean => {
  const decided = reviewInputsOf({ inputs_json: decidedJson } as PurchaseReviewRow);
  return inputs.every((i) => {
    const d = decided.find((x) => scopeKey(x) === scopeKey(i));
    return !!d && Object.entries(i.set).every(([k, v]) => (d.set as Record<string, unknown>)[k] === v);
  });
};

/**
 * The statements a save of the procurement document adds to its own batch (see the file header): run
 * on every save that leaves it `ordered`, and on a save of a document that was `ordered` before. Nothing
 * on a database before 0190 or for a composition; a purchase whose cost cannot feed a price (draft,
 * estimated, no line) only supersedes its own pending reviews.
 */
export async function purchaseReviewStatements(db: D1Database, purchase: PurchaseForPricing, actor: string, now: string): Promise<D1PreparedStatement[]> {
  if (!purchase.purchase_id || !(await cleanStartInstalled(db))) return [];
  const purchaseId = purchase.purchase_id;
  const ids = [...new Set(purchase.lines.map((l) => l.product_id).filter((x): x is string => typeof x === 'string' && x !== ''))];
  // This purchase's reviews (every state: a figure the owner already decided is not asked again) and the
  // products' pending ones from other purchases, which this save may supersede.
  const rows =
    (
      await db
        .prepare(
          "SELECT id, product_id, purchase_id, inputs_json, state FROM pricing_v2_purchase_reviews WHERE purchase_id = ? OR (state = 'pending' AND product_id IN (SELECT value FROM json_each(?))) ORDER BY created_at, id"
        )
        .bind(purchaseId, JSON.stringify(ids))
        .all<{ id: string; product_id: string; purchase_id: string; inputs_json: string; state: PurchaseReviewRow['state'] }>()
    ).results ?? [];
  const pending = rows.filter((r) => r.state === 'pending');
  const ownPending = pending.filter((r) => r.purchase_id === purchaseId);
  // The owner's latest decision on this purchase per product (applied or kept): the same figures again ask nothing.
  const decided = new Map<string, string>();
  for (const r of rows) if (r.purchase_id === purchaseId && (r.state === 'applied' || r.state === 'dismissed')) decided.set(r.product_id, r.inputs_json);
  if (purchaseIneligibility({ status: purchase.status, cost_state: purchase.cost_state, lines: purchase.lines })) return ownPending.length ? [supersedePurchaseReviews(db, purchaseId, actor, now)] : [];
  const ordinary = ids.length
    ? new Set(
        ((await db.prepare("SELECT id FROM products WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(composition, '') = ''").bind(JSON.stringify(ids)).all<{ id: string }>()).results ?? []).map(
          (r) => r.id
        )
      )
    : new Set<string>();
  const pids = ids.filter((id) => ordinary.has(id));
  const stored = pids.length ? await loadProductsPricing(db, pids) : new Map();
  const loaded = pids.length ? await loadProducts(db, pids) : new Map<string, LoadedProduct>();
  const rates = pids.length ? await loadPricingRates(db) : null;
  const out: D1PreparedStatement[] = [];
  const supersede = (id: string) =>
    db.prepare("UPDATE pricing_v2_purchase_reviews SET state = 'superseded', decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'").bind(now, actor, id);
  const kept = new Set<string>();
  for (const pid of pids) {
    const data = stored.get(pid);
    if (!data) continue;
    const lines = purchase.lines.filter((l) => l.product_id === pid);
    // Every line counts (the procurement screen's per-line tick went with its price step): the review IS
    // the owner's decision, and nothing moves before it. A colour or a variant line feeds its own level
    // (FX-7, row 247), as the procurement preview reads it.
    const product = loaded.get(pid);
    const derived = deriveProductEntries(purchase, pid, data, {
      optIn: new Set(lines.map((l) => l.key)),
      prefer: false,
      usePurchase: true,
      rates,
      levels: product ? purchaseSkuLevels(product) : undefined,
    });
    // A write that changes nothing stored (the owner applied these figures already) is not asked again.
    const inputs: ReviewInput[] = derived.entries
      .filter((e) => Object.keys(e.write.set).length > 0 && !inputWriteIsNoop(e.write))
      .map((e) => ({ scope: e.write.scope, scope_id: e.write.scope_id, set: e.write.set, source_ref: e.write.source_ref, ...(e.write.iqd ? { iqd: e.write.iqd } : {}) }));
    if (!inputs.length) continue;
    const json = JSON.stringify(inputs);
    const mine = ownPending.find((r) => r.product_id === pid);
    if (mine && mine.inputs_json === json) {
      // The same figures again: the review the owner may already be reading stays, id and all.
      kept.add(mine.id);
      continue;
    }
    if (!mine && decided.has(pid) && coveredBy(inputs, decided.get(pid)!)) continue;
    if (mine) {
      out.push(supersede(mine.id));
      kept.add(mine.id);
    }
    // Another purchase's pending review of the product goes only when this one names every level it names.
    const names = new Set(inputs.map(scopeKey));
    for (const other of pending) {
      if (other.product_id !== pid || other.purchase_id === purchaseId) continue;
      const theirs = reviewInputsOf(other as PurchaseReviewRow);
      if (theirs.length && theirs.every((i) => names.has(scopeKey(i)))) out.push(supersede(other.id));
    }
    out.push(
      db
        .prepare(
          `INSERT INTO pricing_v2_purchase_reviews (id, product_id, purchase_id, inputs_json, state, created_at, created_by)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`
        )
        .bind(newId('pvr'), pid, purchaseId, json, now, actor)
    );
  }
  // A product this purchase no longer prices (a line removed, nothing left to write): its review goes.
  for (const r of ownPending) if (!kept.has(r.id)) out.push(supersede(r.id));
  return out;
}

const REVIEW_COLUMNS = 'r.id, r.product_id, r.purchase_id, r.inputs_json, r.state, r.created_at, p.invoice_no AS purchase_name, p.status AS purchase_status';

/** Every pending review of the product, oldest first, with its purchase's name and status. A database before 0190 has none. */
export async function loadPurchaseReviews(db: D1Database, productId: string): Promise<PurchaseReviewRow[]> {
  try {
    return (
      (
        await db
          .prepare(`SELECT ${REVIEW_COLUMNS} FROM pricing_v2_purchase_reviews r LEFT JOIN purchase_orders p ON p.id = r.purchase_id WHERE r.product_id = ? AND r.state = 'pending' ORDER BY r.created_at, r.id`)
          .bind(productId)
          .all<PurchaseReviewRow>()
      ).results ?? []
    );
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}

/** The product's newest pending review (or the named one), or null. A database before 0190 has none. */
export async function loadPurchaseReview(db: D1Database, productId: string, reviewId?: string): Promise<PurchaseReviewRow | null> {
  try {
    return reviewId
      ? await db
          .prepare(`SELECT ${REVIEW_COLUMNS} FROM pricing_v2_purchase_reviews r LEFT JOIN purchase_orders p ON p.id = r.purchase_id WHERE r.id = ? AND r.product_id = ?`)
          .bind(reviewId, productId)
          .first<PurchaseReviewRow>()
      : await db
          .prepare(`SELECT ${REVIEW_COLUMNS} FROM pricing_v2_purchase_reviews r LEFT JOIN purchase_orders p ON p.id = r.purchase_id WHERE r.product_id = ? AND r.state = 'pending' ORDER BY r.created_at DESC, r.id DESC LIMIT 1`)
          .bind(productId)
          .first<PurchaseReviewRow>();
  } catch (e) {
    if (missingTable(e)) return null;
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

/** A level's name in the three languages (ckb is never filled from the Arabic: an empty slot reads the English). */
export interface LevelName {
  ar: string;
  en: string;
  ckb: string;
}

/** What the owner's review card reads beside the review: the level names and, for the shadow check, the stored inputs. */
export interface ReviewContext {
  stored: readonly StoredInputRow[];
  levels?: PurchaseSkuLevels;
  names: (scope: ReviewInput['scope'], scopeId: string) => LevelName | null;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const nameOf = (r: { name_en?: unknown; name_ar?: unknown; name_ckb?: unknown }): LevelName | null => {
  const [ar, en, ckb] = [text(r.name_ar), text(r.name_en), text(r.name_ckb)];
  return ar || en || ckb ? { ar, en, ckb } : null;
};

/**
 * The names of a product's levels as the review card shows them: a model (option value), a colour, and a
 * SKU (its models' and colour's names joined). Read from the loaded relations; never a figure.
 */
export function levelNamesOf(loaded: LoadedProduct | null | undefined): ReviewContext['names'] {
  const options = new Map<string, LevelName>();
  for (const v of loaded?.view?.values ?? []) {
    const n = nameOf(v);
    if (n) options.set(v.id, n);
  }
  const colors = new Map<string, LevelName>();
  for (const c of loaded?.view?.colors ?? []) {
    const n = nameOf(c);
    if (n) colors.set(c.id, n);
  }
  return (scope, scopeId) => {
    if (scope === 'option') return options.get(scopeId) ?? null;
    if (scope === 'color') return colors.get(scopeId) ?? null;
    if (scope !== 'sku') return null;
    const sel = parseSkuComboKey(scopeId);
    if (!sel) return null;
    const parts = [...sel.option_value_ids.map((id) => options.get(id)), ...(sel.color_id ? [colors.get(sel.color_id)] : [])].filter((n): n is LevelName => !!n);
    if (!parts.length) return null;
    // A language slot left empty reads the English (never the Arabic in the Sorani slot, row 183).
    return {
      ar: parts.map((p) => p.ar || p.en).join(' · '),
      en: parts.map((p) => p.en || p.ar).join(' · '),
      ckb: parts.map((p) => p.ckb || p.en).join(' · '),
    };
  };
}

/** The review card's context for one product: its stored inputs, its SKU levels and its level names. */
export async function purchaseReviewContext(db: D1Database, productId: string): Promise<ReviewContext> {
  const stored = (await loadProductsPricing(db, [productId])).get(productId);
  const loaded = (await loadProducts(db, [productId])).get(productId);
  return { stored: stored?.inputs ?? [], levels: loaded ? purchaseSkuLevels(loaded) : undefined, names: levelNamesOf(loaded) };
}

/**
 * The review as the owner reads it (FINANCIAL_FIELDS `purchase_review`): the purchase by name, each
 * input with its level's name, and (row 247) `shadowed` — the levels whose own cost the purchase will
 * not reach, read from the stored inputs as they are now.
 */
export const reviewView = (row: PurchaseReviewRow, cx?: ReviewContext) => {
  const inputs = reviewInputsOf(row);
  const shadowed = cx
    ? shadowedOf(
        cx.stored,
        inputs.map((i) => ({ scope: i.scope, scope_id: i.scope_id, set: i.set, existing: ownerRow(cx.stored, i.scope, i.scope_id) })),
        cx.levels
      ).map((s) => ({ scope: s.scope, scope_id: s.scope_id, field: s.field, by: (s.by ?? []).map((b) => ({ ...b, name: cx.names(b.scope, b.scope_id) })) }))
    : [];
  return {
    id: row.id,
    purchase_id: row.purchase_id,
    purchase_name: row.purchase_name ?? null,
    state: row.state,
    created_at: row.created_at,
    inputs: inputs.map((i) => ({ scope: i.scope, scope_id: i.scope_id, name: cx ? cx.names(i.scope, i.scope_id) : null, fields: i.set, ...(i.iqd ? { iqd: i.iqd } : {}) })),
    shadowed,
  };
};

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
  desired.inputWrites = reviewInputsOf(row).map((i) => ({
    scope: i.scope,
    scope_id: i.scope_id,
    existing: ownerRow(read.stored.inputs, i.scope, i.scope_id),
    set: i.set,
    source_ref: i.source_ref,
    ...(i.iqd ? { iqd: i.iqd } : {}),
  }));
  const ev = await evaluateDesired(read, desired);
  return { read, ev, viewer, now };
}

export async function previewPurchaseReview(c: Context<AppContext>, productId: string, reviewId: string): Promise<Record<string, unknown>> {
  const row = await loadPurchaseReview(c.env.DB, productId, reviewId);
  if (!row) throw new HttpError(404, 'Review not found', 'NOT_FOUND');
  if (row.state !== 'pending') throw refusal(409, 'PRICING_REVIEW_DECIDED');
  const { read, ev, viewer } = await reviewEvaluation(c, productId, row);
  const cx: ReviewContext = { stored: read.stored.inputs, levels: purchaseSkuLevels(read.loaded), names: levelNamesOf(read.loaded) };
  return { success: true, review: reviewView(row, cx), preview: v2Answer({ viewer, read, ev }) };
}

export async function applyPurchaseReview(c: Context<AppContext>, productId: string, reviewId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const db = c.env.DB;
  const row = await loadPurchaseReview(db, productId, reviewId);
  if (!row) throw new HttpError(404, 'Review not found', 'NOT_FOUND');
  if (row.state !== 'pending') {
    if (row.state === 'applied') return { success: true, already: true };
    throw refusal(409, 'PRICING_REVIEW_DECIDED');
  }
  // Row 247: a cost the owner never actually bought at never reaches the product.
  if (!APPLIABLE.has(row.purchase_status ?? '')) throw refusal(409, 'PRICING_REVIEW_PURCHASE_CANCELLED');
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
