/**
 * THE IMPORT STOCK GATE — «إعداد المخزون للمنتج المستورد» (Bambu import spec
 * §B.10; docs/DECISIONS.md rows 239 and 241; owner decision L-16, default on).
 *
 * WHY IT EXISTS. `stock = NULL` means UNTRACKED AND UNLIMITED in Levonis
 * (worker/lib/inventory.ts), not "not configured". A product the catalogue
 * import created is unsellable today only because it is unpriced; the moment
 * the owner priced it, every variant would become orderable with no limit, for
 * goods Levonis may not hold. So the import records the missing decision
 * explicitly — `product_source_refs.stock_decision = 'not_configured'`
 * (migration 0194) — and the Pricing V2 write refuses to publish such a
 * product (409 IMPORT_STOCK_NOT_CONFIGURED) until the owner chooses:
 *   - «تتبّع الكمية» / tracked: every row the product's `inventory_mode` makes
 *     authoritative carries a stock number (one may be 0), else 400
 *     IMPORT_STOCK_TRACKED_EMPTY;
 *   - «بلا تتبّع (حسب الطلب)» / untracked: an explicit "to order, no limit".
 * A merged product keeps 'not_required' (its stock is the owner's existing
 * setup) and is never gated; a product with no source row is never gated.
 *
 * WHERE IT IS ENFORCED: WHERE A PRODUCT BECOMES SELLABLE. Only a complete V2
 * write inserts `pricing_v2_sku_results` — the SELLABLE predicate's V2 clause
 * (worker/lib/listing.ts, unchanged) — so `v2WriteStatements` is the one door,
 * and it prepends `importStockFence`: every caller (the product form, the
 * prices-only PUT, a purchase review's apply, the automatic repricing) is
 * covered by the batch itself. `gateV2` refuses earlier with the same code, so
 * the form never reaches its review sheet for a publish that cannot land.
 *
 * WHY ITS OWN FENCE AND NOT `fence()`. Every `fence()` miss is the same driver
 * error («CHECK constraint failed: ok=1»), which the V2 callers answer as
 * PRICING_CHANGED — "look again". This one inserts `ok = NULL` when the
 * product's decision is missing, so its miss is «NOT NULL constraint failed:
 * ops_guards.ok» — no other statement in the codebase writes a NULL there —
 * and the batch's own failure names the reason: 409 IMPORT_STOCK_NOT_CONFIGURED.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2). Everything here asks for migration 0194
 * first (worker/lib/catalogKnowledge.ts). Without it there is no fence, no
 * refusal and no decision to read: the V2 write is today's, statement for
 * statement.
 *
 * STAFF ONLY. The decision is shown on the admin product read and the product
 * form; no customer projection reads `product_source_refs`.
 */
import { serverMessage } from '@levonis/contracts/costRefusals';
import { auditStatements } from './audit';
import { catalogKnowledgeInstalled } from './catalogKnowledge';
import { newId } from './crypto';
import { HttpError } from './http';
import { fence, isFenceMiss } from './operations';

export type ImportStockDecision = 'not_required' | 'not_configured' | 'tracked' | 'untracked';

/** What the owner may choose. 'not_configured' is the import's to write, 'not_required' a merge's. */
export const IMPORT_STOCK_CHOICES = ['tracked', 'untracked'] as const;
export type ImportStockChoice = (typeof IMPORT_STOCK_CHOICES)[number];

export const isImportStockChoice = (v: unknown): v is ImportStockChoice =>
  typeof v === 'string' && (IMPORT_STOCK_CHOICES as readonly string[]).includes(v);

/** The spec's fence condition (§B.10), one bound parameter: the product id. */
export const IMPORT_STOCK_FENCE_SQL =
  "NOT EXISTS (SELECT 1 FROM product_source_refs WHERE product_id = ? AND stock_decision = 'not_configured')";

/**
 * The two statements a V2 publish batch starts with while 0194 is present: a
 * guard row that cannot be written (`ok` NULL) for a product whose stock
 * decision is missing, and its removal. See the file header for why `ok` is
 * NULL rather than 0.
 */
export function importStockFence(db: D1Database, productId: string): D1PreparedStatement[] {
  const id = newId('guard');
  return [
    db.prepare(`INSERT INTO ops_guards (id, ok) SELECT ?, CASE WHEN ${IMPORT_STOCK_FENCE_SQL} THEN 1 END`).bind(id, productId),
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(id),
  ];
}

/** Every message an error carries, its cause's included (D1 wraps the SQLite text). */
function messagesOf(err: unknown, depth = 0): string {
  if (depth > 3 || err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return '';
  const own = typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
  return `${own}\n${messagesOf((err as { cause?: unknown }).cause, depth + 1)}`;
}

/** The batch failed on `importStockFence`: the product's stock decision is missing. */
export const isImportStockMiss = (err: unknown): boolean => /NOT NULL constraint failed:\s*ops_guards\.ok\b/i.test(messagesOf(err));

/** 409 IMPORT_STOCK_NOT_CONFIGURED, naming the form section that carries the stock card (٣). Codes only. */
export const importStockRefusal = (): HttpError =>
  new HttpError(409, serverMessage('IMPORT_STOCK_NOT_CONFIGURED'), 'IMPORT_STOCK_NOT_CONFIGURED', { section: 3, import_stock: 'not_configured' });

/** Is this product's import stock decision missing? False on a database without 0194. */
export async function importStockNotConfigured(db: D1Database, productId: string): Promise<boolean> {
  if (!(await catalogKnowledgeInstalled(db))) return false;
  const row = await db
    .prepare("SELECT 1 AS x FROM product_source_refs WHERE product_id = ? AND stock_decision = 'not_configured' LIMIT 1")
    .bind(productId)
    .first<{ x: number }>();
  return !!row;
}

/** The early refusal of a V2 publish (the batch's fence stays the authority). */
export async function refuseImportStockNotConfigured(db: D1Database, productId: string): Promise<void> {
  if (await importStockNotConfigured(db, productId)) throw importStockRefusal();
}

/** The decision as the admin product read shows it (staff only). Null: not an imported product, or no 0194. */
export interface ImportStockView {
  decision: ImportStockDecision;
  decided_at: string | null;
}

const DECISIONS: readonly ImportStockDecision[] = ['not_required', 'not_configured', 'tracked', 'untracked'];

/** The product's import stock decision: a created product's row first (the one a decision is made on). */
export async function loadImportStock(db: D1Database, productId: string): Promise<ImportStockView | null> {
  if (!(await catalogKnowledgeInstalled(db))) return null;
  const row = await db
    .prepare(
      `SELECT stock_decision, stock_decided_at FROM product_source_refs WHERE product_id = ?
        ORDER BY CASE WHEN match_kind = 'created' THEN 0 ELSE 1 END, source, source_product_id LIMIT 1`
    )
    .bind(productId)
    .first<{ stock_decision: string; stock_decided_at: string }>();
  if (!row) return null;
  const decision = (DECISIONS as readonly string[]).includes(row.stock_decision) ? (row.stock_decision as ImportStockDecision) : 'not_configured';
  return { decision, decided_at: row.stock_decided_at ? String(row.stock_decided_at) : null };
}

/**
 * «تتبّع الكمية» IS TRUE ONLY WHEN EVERY ROW A SALE CAN REACH CARRIES A NUMBER.
 *
 * The level is the one `inventory_mode` makes authoritative
 * (worker/lib/inventory.ts `resolveStock`): the product row (BASE); every
 * active variant (VARIANT_COMBINATION — an unmodelled combination is not
 * sellable at all); every active colour (COLOR); in OPTION mode one group
 * whose every active value is tracked — the resolver ignores an untracked
 * value and takes the minimum over the tracked ones, so a selection always
 * meets a tracked row exactly when one group is tracked whole. A NULL on any
 * of those rows would sell that selection without limit — the thing «تتبّع
 * الكمية» promises not to do. Zero is a number: tracked and out of stock.
 *
 * Anonymous `?` only (seven, each the product id): `fence()` puts its own
 * guard id first, so a numbered `?1` here would name that id.
 */
export const TRACKED_STOCK_SQL = `CASE (SELECT inventory_mode FROM products WHERE id = ?)
  WHEN 'BASE' THEN EXISTS (SELECT 1 FROM products WHERE id = ? AND stock IS NOT NULL)
  WHEN 'VARIANT_COMBINATION' THEN EXISTS (SELECT 1 FROM product_variants WHERE product_id = ? AND active = 1)
    AND NOT EXISTS (SELECT 1 FROM product_variants WHERE product_id = ? AND active = 1 AND stock IS NULL)
  WHEN 'COLOR' THEN EXISTS (SELECT 1 FROM product_colors WHERE product_id = ? AND active = 1)
    AND NOT EXISTS (SELECT 1 FROM product_colors WHERE product_id = ? AND active = 1 AND stock IS NULL)
  WHEN 'OPTION' THEN EXISTS (SELECT 1 FROM product_option_groups g WHERE g.product_id = ? AND g.active = 1
    AND EXISTS (SELECT 1 FROM product_option_values v WHERE v.group_id = g.id AND v.active = 1)
    AND NOT EXISTS (SELECT 1 FROM product_option_values v WHERE v.group_id = g.id AND v.active = 1 AND v.stock IS NULL))
  ELSE 0 END`;

/** `TRACKED_STOCK_SQL`'s bound values. */
export const trackedStockBinds = (productId: string): string[] => Array.from({ length: 7 }, () => productId);

/** Does the product's authoritative stock level carry a number on every row a sale can reach? */
export async function trackedStockReady(db: D1Database, productId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT (${TRACKED_STOCK_SQL}) AS ok`)
    .bind(...trackedStockBinds(productId))
    .first<{ ok: number | null }>();
  return Number(row?.ok) === 1;
}

/** 400 IMPORT_STOCK_TRACKED_EMPTY: enter the stock first. Codes only — never a count. */
export const trackedEmptyRefusal = (): HttpError =>
  new HttpError(400, serverMessage('IMPORT_STOCK_TRACKED_EMPTY'), 'IMPORT_STOCK_TRACKED_EMPTY', { section: 3, import_stock: 'tracked' });

/** What a decision did: the view after it, and whether anything was written. */
export interface ImportStockDecided {
  import_stock: ImportStockView;
  unchanged: boolean;
}

/**
 * THE OWNER'S CHOICE, WRITTEN (`PUT /api/admin/products/:id/import-stock-decision`).
 *
 * One batch: for «تتبّع الكمية» the stock check again as a fence (a stock row
 * cleared between the read and the write refuses the whole batch), the
 * decision with who and when (0194's CHECK requires both for a decision), and
 * the audit row — ids and the two decisions, never a quantity.
 *
 * OUTSIDE ANY IMPORT BATCH. 0195's guard triggers on `product_source_refs`
 * fire only while the guard row `ops_guards('catalog-import-batch')` exists,
 * which an import batch writes first and deletes last; this batch never
 * writes it, so the owner's decision is the one write to `stock_decision` the
 * guards let through (tests/importStockDecision.test.ts holds both halves).
 *
 * Refusals, codes only: 404 for a product that has no created import row (or a
 * database without 0194 — there is nothing to decide); 400
 * IMPORT_STOCK_TRACKED_EMPTY when «تتبّع الكمية» meets a row with no number.
 * The same choice again writes nothing (`unchanged`).
 */
export async function decideImportStock(
  db: D1Database,
  productId: string,
  choice: ImportStockChoice,
  actorId: string,
  now = new Date().toISOString()
): Promise<ImportStockDecided> {
  const none = () => new HttpError(404, 'This product has no import stock setup', 'NOT_FOUND');
  if (!(await catalogKnowledgeInstalled(db))) throw none();
  const row = await db
    .prepare(
      `SELECT r.stock_decision, r.stock_decided_at FROM product_source_refs r JOIN products p ON p.id = r.product_id
        WHERE r.product_id = ? AND r.match_kind = 'created'
        ORDER BY r.source, r.source_product_id LIMIT 1`
    )
    .bind(productId)
    .first<{ stock_decision: string; stock_decided_at: string }>();
  if (!row) throw none();
  const before = row.stock_decision;
  if (before === choice) {
    return { import_stock: { decision: choice, decided_at: row.stock_decided_at || null }, unchanged: true };
  }
  if (choice === 'tracked' && !(await trackedStockReady(db, productId))) throw trackedEmptyRefusal();
  const audit = await auditStatements(db, actorId, 'product.import_stock_decision', productId, {
    product_id: productId,
    before,
    after: choice,
  });
  const statements = [
    ...(choice === 'tracked' ? fence(db, TRACKED_STOCK_SQL, trackedStockBinds(productId)) : []),
    db
      .prepare(
        `UPDATE product_source_refs SET stock_decision = ?, stock_decided_by = ?, stock_decided_at = ?, updated_at = ?
          WHERE product_id = ? AND match_kind = 'created' AND stock_decision = ?`
      )
      .bind(choice, actorId, now, now, productId, before),
    ...audit.statements,
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (e) {
    // The only fence here is the stock check: a stock row emptied since it was read.
    if (isFenceMiss(e)) throw trackedEmptyRefusal();
    throw e;
  }
  const update = results[choice === 'tracked' ? 2 : 0];
  if (Number(update?.meta?.changes ?? 0) === 0) {
    // Decided meanwhile by someone else (or the product went): answer what is stored now.
    const current = await loadImportStock(db, productId);
    if (!current) throw none();
    return { import_stock: current, unchanged: current.decision === choice };
  }
  return { import_stock: { decision: choice, decided_at: now }, unchanged: false };
}
