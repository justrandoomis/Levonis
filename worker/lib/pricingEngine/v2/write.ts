/**
 * PRICING V2 — THE WRITE: ONE ATOMIC BATCH PER PRODUCT (spec §3.3; it mirrors
 * engineWrite.ts `engineWriteStatements` and reuses its extracted pieces).
 *
 * In order:
 *   0. the import stock gate (Bambu import spec §B.10; worker/lib/importStock.ts):
 *      a product the catalogue import created and whose stock mode the owner has
 *      not chosen yet is never published — its own fence, so a miss answers
 *      409 IMPORT_STOCK_NOT_CONFIGURED, never PRICING_CHANGED. Laid only while
 *      migration 0194 is present: on an older database the batch is today's;
 *   1. `batchHead`: the product's pricing state (inputs_seq, write_seq, mode) and
 *      config_version as read, the owner-input token, the state row when absent;
 *   2. fences: the control row not paused, the PRICE IMAGE equal to the one the
 *      preview hashed, the central rates by VALUE (`RATES_FENCE_SQL`), the
 *      state's method as read (NULL on a product's first V2 write) and — the
 *      product-save variant — `products.updated_at` (the stale-edit check);
 *   3. tokens: `engine-price:<id>`, and `pricing-mode:<id>` on the first V2
 *      write or a method change (0189's method triggers, 0181's mode trigger);
 *   4. (product save only) the structure statements of `planProductSave`,
 *      unchanged: the token is held, so 0181/0188's value-compared locks pass —
 *      adding a model or a route to a V2 product never dead-ends in 409
 *      ENGINE_MANAGED (P9);
 *   5. the cost inputs and `target_profit` rules (cost-first), then the price
 *      points and discounts (version-fenced; their triggers bump inputs_seq);
 *   6. the price rows (`priceRowStatements`, V2's plan: fees 0, `o:*`, blocked
 *      routes off) — none when an automatic repricing moves no customer price;
 *   7. `price_history` per changed `sku:<combo>@<channel>`, with U and its source;
 *   8. `pricing_sku_costs` emptied (a V2 product holds no V1 result), then
 *      `pricing_v2_sku_results` replaced in chunks of 60, each pair written whole;
 *   9. `product_pricing_state`: mode engine, the method, write_seq + 1, priced_*,
 *      v2_since, the blocked repricing code cleared;
 *  10. `pricing_audit` (values, owner-only) and `audit_log` (ids and counts),
 *      the tokens deleted, `batchTail`.
 *
 * Caps (callers enforce): pricing only ENGINE_STATEMENT_CAP (200); a product
 * save with V2 V2_SAVE_STATEMENT_CAP (600) — over it is 409
 * PRICING_SET_TOO_LARGE («احفظ الخيارات على دفعتين»).
 *
 * PRIVATE: every value here is the owner's. This module never names an
 * accounting table and never writes a purchase row.
 */
import { skuPriceHistoryKey } from '@levonis/pricing/skuChannel';
import { newId } from '../../crypto';
import { fence } from '../../operations';
import { auditStatements } from '../../audit';
import { catalogKnowledgeInstalled } from '../../catalogKnowledge';
import { importStockFence } from '../../importStock';
import { directPurchaseStatement } from '../directPurchase';
import { PRICE_IMAGE_SQL, RATES_FENCE_SQL, SKU_COST_CHUNK, priceRowStatements, rateFenceBinds, type AutoWrite } from '../engineWrite';
import { batchHead, batchTail, inputStatements, pricingAuditStatement, pricingAuditStatements, ruleStatements, type PricingAuditRow } from '../store';
import type { V2Evaluation } from './evaluate';
import { discountStatements, discountWrites, pointStatements, pointWrites, V2_RESULT_COLUMNS, type StoredV2Result } from './store';

/** A product save with V2 prices (structure + prices in one batch): D1's per-invocation budget is the hard limit (risk R-4). */
export const V2_SAVE_STATEMENT_CAP = 600;
/** A prices-only V2 write (PUT …/pricing): the engine's own cap (spec §3.3). */
export const V2_PRICING_STATEMENT_CAP = 200;

const imageBinds = (pid: string) => [pid, pid, pid, pid, pid, pid];

export interface V2WriteOptions {
  actor: string;
  /** The audit_log actor when it differs from `actor` (null: the system, for the cron). */
  auditActor?: string | null;
  now: string;
  /** product_form | product_pricing | fx_auto | … — the audit's source. */
  source: string;
  idempotencyKey: string;
  /** FX-5: an automatic repricing (labels only; never drafts, never a create). */
  auto?: AutoWrite;
  /** The product-save variant (V2-3b): `planProductSave`'s statements, laid between the tokens and the prices. */
  structure?: readonly D1PreparedStatement[];
  /** The product-save variant: `products.updated_at` as read (the stale-edit fence). */
  updatedAt?: string | null;
  extraAudits?: D1PreparedStatement[];
  auditDetail?: Record<string, unknown>;
  /**
   * V2-3b: a product this very save creates (add-product, V2 from birth). Its
   * structure statements (the `products` INSERT first) run BEFORE the batch
   * head, because the state row and every V2 row name the product by foreign
   * key; the price image and the stale-edit fences are skipped — nothing
   * existed to read, and the INSERT's primary key is the race guard.
   */
  newProduct?: boolean;
  /**
   * The clean start (spec addendum A.7): a product's FIRST complete V2 write
   * retires its Direct Sale Extra rules and its purchase overlay
   * (`firstWriteStatements`), laid after the owner's data and before the price
   * rows.
   */
  firstWrite?: readonly D1PreparedStatement[];
  /**
   * The import stock gate (step 0): migration 0194's presence, when the caller asked already — a pass with a
   * statement budget (the automatic repricing, the owner's rate preview) charges the probe itself and hands the
   * answer in, so this function sends nothing it did not pay for. Undefined: asked here (one statement per
   * binding while unknown; worker/lib/catalogKnowledge.ts).
   */
  stockGate?: boolean;
}

/** The private result row of one planned SKU × channel (each 0189 pair written whole). */
function resultRow(ev: V2Evaluation, p: V2Evaluation['plan']['prices'][number], now: string): Omit<StoredV2Result, 'inputs_seq' | 'write_seq'> {
  const rates = ev.rates!;
  const c = p.price.v2;
  const rep = c.replacement;
  const currency = rep?.supplier_currency ?? null;
  const cross = currency === 'EUR' ? rates.eur_usd : currency === 'CNY' ? rates.cny_usd : null;
  const crossVersion = currency === 'EUR' ? rates.pair_versions.EUR_USD : currency === 'CNY' ? rates.pair_versions.CNY_USD : null;
  return {
    product_id: ev.product_id,
    combo_key: p.combo_key,
    channel: p.channel,
    method: ev.method,
    anchor: c.anchor,
    final_price_iqd: c.price_iqd,
    exact_iqd: c.exact_iqd,
    direct_price_iqd: c.direct_iqd,
    direct_exact_iqd: c.direct_exact_iqd,
    usd_ceil6: c.usd_ceil6,
    deltas_usd: c.deltas_usd,
    discount_usd: p.channel === 'direct_sale' ? null : (c.discount_usd ?? '0'),
    discount_scope: p.channel === 'direct_sale' ? null : (c.discount_from?.scope ?? null),
    discount_scope_id: p.channel === 'direct_sale' || !c.discount_from ? null : c.discount_from.scope_id,
    floor: c.floor,
    below_cost: c.below_cost ? 1 : 0,
    below_min_profit: c.below_min_profit ? 1 : 0,
    shipping_profile: rep?.shipping_profile ?? null,
    supplier_currency: currency,
    fx_rate: rep ? rep.fx_rate : null,
    fx_version: rep ? rep.fx_version : null,
    cross_rate: cross,
    cross_fx_version: cross === null ? null : crossVersion,
    shipping_rate: rep ? rep.shipping_rate : null,
    shipping_version: rep ? rep.shipping_version : null,
    replacement_exact: rep ? rep.replacement_exact : null,
    replacement_cost_iqd: rep ? rep.replacement_cost_iqd : null,
    target_profit_usd: c.target_profit_usd,
    target_rule_id: c.target_rule_id,
    target_rule_version: c.target_rule_id === null ? null : c.target_rule_version,
    usd_iqd_rate: rates.usd_iqd!,
    usd_fx_version: rates.pair_versions.USD_IQD,
    config_version: ev.stored.config_version,
    computed_at: now,
  };
}

const RESULT_INSERT_COLUMNS = V2_RESULT_COLUMNS.filter((k) => k !== 'inputs_seq' && k !== 'write_seq');

export async function v2WriteStatements(db: D1Database, ev: V2Evaluation, o: V2WriteOptions): Promise<D1PreparedStatement[]> {
  if (!ev.complete || !ev.hash || !ev.rates?.usd_iqd) throw new Error('v2WriteStatements: not a complete V2 write');
  const pid = ev.product_id;
  const u = ev.rates.usd_iqd;
  const auto = o.auto ?? null;
  const create = ev.kind === 'v2_create';
  const storedMethod = ev.stored.state?.mode === 'engine' ? (ev.stored.state.pricing_method ?? null) : null;
  const methodMoves = storedMethod !== ev.method;
  const points = pointWrites(ev.v2?.points ?? [], ev.points);
  const discounts = discountWrites(ev.v2?.discounts ?? [], ev.discounts);
  // An automatic repricing never creates and never carries drafts: only an owner's (or editor's) save does.
  if (auto && (create || methodMoves || ev.inputWrites.length || ev.ruleWrites.length || points.length || discounts.length || o.structure?.length))
    throw new Error('v2WriteStatements: an automatic repricing writes prices only');
  const writePrices = !auto?.pricesUnchanged;
  const plan = ev.plan;
  const auditId = newId('paud');
  const batchId = `${auto ? 'fx' : 'v2'}_${newId()}`;
  const today = (combo: string, channel: string) => ev.rows.find((r) => r.combo_key === combo && r.channel === channel)?.old_iqd ?? null;
  const history = writePrices
    ? plan.prices
        .filter((p) => create || today(p.combo_key, p.channel) !== p.price.computed_price_iqd)
        .map((p) => ({ k: skuPriceHistoryKey(p.combo_key, p.channel), o: today(p.combo_key, p.channel), n: p.price.computed_price_iqd }))
    : [];
  const results = plan.prices.map((p) => resultRow(ev, p, o.now));
  const chunks: Array<typeof results> = [];
  for (let i = 0; i < results.length; i += SKU_COST_CHUNK) chunks.push(results.slice(i, i + SKU_COST_CHUNK));
  const auditActor = o.auditActor === undefined ? o.actor : o.auditActor;
  // A stock purchase's direct-only overlay (0186/0188) has no place on a V2 product: its lock exemption is closed.
  const overlay = ev.stored.direct_purchase?.direct_only ? { ...ev.stored.direct_purchase, direct_only: false, version: ev.stored.direct_purchase.version + 1 } : null;

  const audits: PricingAuditRow[] = [
    ...points.map((w) => ({
      entity: 'input' as const,
      entity_key: `v2point:${w.scope}:${w.scope_id}`,
      product_id: pid,
      action: (w.existing ? (w.next ? 'update' : 'delete') : 'create') as PricingAuditRow['action'],
      before: w.existing ? { kind: w.existing.kind, amount_usd: w.existing.amount_usd } : null,
      after: w.next ? { kind: w.next.kind, amount_usd: w.next.usd } : null,
      actor: o.actor,
      now: o.now,
    })),
    ...discounts.map((w) => ({
      entity: 'rule' as const,
      entity_key: `v2discount:${w.scope}:${w.scope_id}`,
      product_id: pid,
      action: 'rule_set' as const,
      before: w.existing ? { amount_usd: w.existing.amount_usd } : null,
      after: w.next ? { amount_usd: w.next.usd } : null,
      actor: o.actor,
      now: o.now,
    })),
    ...(methodMoves && !create
      ? [{ entity: 'engine_mode' as const, entity_key: pid, product_id: pid, action: 'update' as const, before: { method: storedMethod }, after: { method: ev.method }, actor: o.actor, now: o.now }]
      : []),
  ];

  const fresh = o.newProduct === true;
  // 0. Never publish an imported product whose stock mode is not chosen (§B.10). First, so its miss is the one reported.
  const stockGate = o.stockGate ?? (await catalogKnowledgeInstalled(db));
  return [
    ...(stockGate ? importStockFence(db, pid) : []),
    // (A product this save creates: its row and relations first — everything below names it.)
    ...(fresh ? (o.structure ?? []) : []),
    // 1-2. What was read, as read.
    ...batchHead(db, ev.stored, o.now),
    ...fence(db, 'EXISTS(SELECT 1 FROM pricing_engine_control WHERE id = 1 AND paused = 0)'),
    ...(fresh ? [] : fence(db, `(${PRICE_IMAGE_SQL}) = ?`, [...imageBinds(pid), ev.image])),
    ...fence(db, RATES_FENCE_SQL, rateFenceBinds(ev.rates)),
    ...fence(db, 'EXISTS(SELECT 1 FROM product_pricing_state WHERE product_id = ? AND pricing_method IS ?)', [pid, storedMethod]),
    ...(!fresh && o.updatedAt !== undefined ? fence(db, 'EXISTS(SELECT 1 FROM products WHERE id = ? AND updated_at IS ?)', [pid, o.updatedAt]) : []),
    // 3. The tokens.
    db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`engine-price:${pid}`),
    ...(create || methodMoves ? [db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`pricing-mode:${pid}`)] : []),
    // 4. The product save's structure, unchanged.
    ...(fresh ? [] : (o.structure ?? [])),
    // 5. The owner's data.
    ...inputStatements(db, pid, ev.inputWrites, o.actor, o.now, { pack: true }),
    ...ruleStatements(db, pid, ev.ruleWrites, o.actor, o.now, { pack: true }),
    ...pointStatements(db, pid, points, o.actor, o.now),
    ...discountStatements(db, pid, discounts, o.actor, o.now),
    ...(overlay ? [directPurchaseStatement(db, ev.stored, overlay, o.actor, o.now)] : []),
    ...(o.firstWrite ?? []),
    // 6. The price rows. No compare-at price survives on a V2 product (spec addendum A.7: offers carry discounts).
    ...(writePrices ? priceRowStatements(db, pid, plan, o.now) : []),
    ...(writePrices ? [db.prepare('UPDATE products SET original_price_iqd = NULL WHERE id = ? AND original_price_iqd IS NOT NULL').bind(pid)] : []),
    // 7. The history: the V2 price and the U it was computed at.
    ...(history.length
      ? [
          db
            .prepare(
              `INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by, batch_id, usd_iqd_rate, price_source)
               SELECT ?, json_extract(value, '$.k'), 'regular', json_extract(value, '$.o'), json_extract(value, '$.n'), ?, ?, ?, ? FROM json_each(?)`
            )
            .bind(pid, o.actor, batchId, u, auto?.priceSource ?? 'engine_owner', JSON.stringify(history)),
        ]
      : []),
    // 8. The private results: no V1 result stays beside them.
    db.prepare('DELETE FROM pricing_sku_costs WHERE product_id = ?').bind(pid),
    db.prepare('DELETE FROM pricing_v2_sku_results WHERE product_id = ?').bind(pid),
    ...chunks.map((chunk) =>
      db
        .prepare(
          `INSERT INTO pricing_v2_sku_results (${RESULT_INSERT_COLUMNS.join(', ')}, inputs_seq, write_seq)
           SELECT ${RESULT_INSERT_COLUMNS.map((k) => `json_extract(value, '$.${k}')`).join(', ')},
                  (SELECT inputs_seq FROM product_pricing_state WHERE product_id = ?),
                  (SELECT write_seq FROM product_pricing_state WHERE product_id = ?) + 1
             FROM json_each(?)`
        )
        .bind(pid, pid, JSON.stringify(chunk))
    ),
    // 9. The state.
    db
      .prepare(
        `UPDATE product_pricing_state
            SET mode = 'engine', pricing_method = ?, write_seq = write_seq + 1, priced_config_version = ?, priced_inputs_seq = inputs_seq, priced_at = ?,
                v2_since = COALESCE(v2_since, ?),
                opted_in_at = CASE WHEN mode = 'manual' THEN ? ELSE opted_in_at END,
                opted_in_by = CASE WHEN mode = 'manual' THEN ? ELSE opted_in_by END,
                activation_audit_id = CASE WHEN mode = 'manual' THEN ? ELSE activation_audit_id END,
                reprice_blocked_code = NULL, reprice_blocked_at = NULL, updated_at = ?
          WHERE product_id = ?`
      )
      .bind(ev.method, ev.stored.config_version, o.now, o.now, o.now, o.actor, auditId, o.now, pid),
    // 10. The audit.
    ...pricingAuditStatements(db, audits),
    ...(o.extraAudits ?? []),
    pricingAuditStatement(db, {
      id: auditId,
      entity: 'sku_price',
      entity_key: pid,
      product_id: pid,
      action: auto ? 'reprice_auto' : create ? 'engine_entry' : 'reprice_owner',
      before: ev.rows.map((r) => ({ combo_key: r.combo_key, channel: r.channel, price_iqd: r.old_iqd })),
      after: plan.prices.map((p) => ({ combo_key: p.combo_key, channel: p.channel, price_iqd: p.price.computed_price_iqd, usd_ceil6: p.price.v2.usd_ceil6, usd_iqd_rate: u })),
      summary: {
        v2: true,
        kind: ev.kind,
        method: ev.method,
        source: o.source,
        rows: plan.prices.length,
        sku_rows: plan.skus.length,
        history_batch: batchId,
        points_changed: points.length,
        discounts_changed: discounts.length,
        blocked: plan.blocked?.length ?? 0,
        ...(auto ? { trigger: auto.trigger, reasons: [...auto.reasons], prices_unchanged: auto.pricesUnchanged } : {}),
      },
      idempotency_key: o.idempotencyKey,
      actor: o.actor,
      now: o.now,
    }),
    ...(
      await auditStatements(db, auditActor, auto ? 'pricing.engine.repriced_auto' : create ? 'pricing.v2.created' : 'pricing.v2.repriced', pid, {
        product_id: pid,
        v2: true,
        rows_changed: history.length,
        source: o.source,
        ...(auto ? { trigger: auto.trigger, reasons: [...auto.reasons] } : {}),
        ...(o.auditDetail ?? {}),
      })
    ).statements,
    ...(create || methodMoves ? [db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`pricing-mode:${pid}`)] : []),
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`engine-price:${pid}`),
    ...batchTail(db, pid),
  ];
}

/**
 * V2-3b (spec §4.3 step 6): an INCOMPLETE V2 save stores its data and never a
 * price. An existing V2 product keeps its sellable prices at the last good
 * write (the strict rung refuses every SKU × channel left unpriced, C-13); a
 * product this save creates is born V2 and stays hidden until it is priced
 * (row 205). One batch: the head and its fences, the tokens, the structure
 * (a new product's first), the owner's data, the method, the audit, the tail.
 * No price row, no result, no `write_seq` move, no price history.
 */
/**
 * THE CLEAN START'S STRUCTURE-ONLY SAVE (addendum A.6): a product with no V2 method, saved without a
 * `pricing_v2` block — its description, pictures, models or routes, never a price (the legacy money
 * door, `legacyMoney.ts`, has pinned every dinar field to the stored value). The structure runs under
 * the `engine-price:` token so a V1-engine product's value-compared 0181/0188 locks let a new model
 * row in; the fence proves no V2 method arrived in between (a V2 product's structure moves only with
 * its prices, in `v2WriteStatements`), and the stale-edit fence that the product was not saved since.
 */
export function v2StructureStatements(
  db: D1Database,
  productId: string,
  o: { structure: D1PreparedStatement[]; newProduct: boolean; updatedAt: string | null }
): D1PreparedStatement[] {
  if (o.newProduct) return [...o.structure];
  return [
    ...fence(db, 'NOT EXISTS(SELECT 1 FROM product_pricing_state WHERE product_id = ? AND pricing_method IS NOT NULL)', [productId]),
    ...fence(db, 'EXISTS(SELECT 1 FROM products WHERE id = ? AND updated_at IS ?)', [productId, o.updatedAt]),
    db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`engine-price:${productId}`),
    ...o.structure,
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`engine-price:${productId}`),
  ];
}

export async function v2DataStatements(db: D1Database, ev: V2Evaluation, o: V2WriteOptions): Promise<D1PreparedStatement[]> {
  if (o.auto) throw new Error('v2DataStatements: never an automatic write');
  const pid = ev.product_id;
  const storedMethod = ev.stored.state?.mode === 'engine' ? (ev.stored.state.pricing_method ?? null) : null;
  const methodMoves = storedMethod !== ev.method;
  const points = pointWrites(ev.v2?.points ?? [], ev.points);
  const discounts = discountWrites(ev.v2?.discounts ?? [], ev.discounts);
  const fresh = o.newProduct === true;
  const overlay = ev.stored.direct_purchase?.direct_only ? { ...ev.stored.direct_purchase, direct_only: false, version: ev.stored.direct_purchase.version + 1 } : null;
  const audits: PricingAuditRow[] = [
    ...points.map((w) => ({
      entity: 'input' as const,
      entity_key: `v2point:${w.scope}:${w.scope_id}`,
      product_id: pid,
      action: (w.existing ? (w.next ? 'update' : 'delete') : 'create') as PricingAuditRow['action'],
      before: w.existing ? { kind: w.existing.kind, amount_usd: w.existing.amount_usd } : null,
      after: w.next ? { kind: w.next.kind, amount_usd: w.next.usd } : null,
      actor: o.actor,
      now: o.now,
    })),
    ...discounts.map((w) => ({
      entity: 'rule' as const,
      entity_key: `v2discount:${w.scope}:${w.scope_id}`,
      product_id: pid,
      action: 'rule_set' as const,
      before: w.existing ? { amount_usd: w.existing.amount_usd } : null,
      after: w.next ? { amount_usd: w.next.usd } : null,
      actor: o.actor,
      now: o.now,
    })),
    ...(methodMoves ? [{ entity: 'engine_mode' as const, entity_key: pid, product_id: pid, action: 'update' as const, before: { method: storedMethod }, after: { method: ev.method }, summary: { data_only: true }, actor: o.actor, now: o.now }] : []),
  ];
  return [
    ...(fresh ? (o.structure ?? []) : []),
    ...batchHead(db, ev.stored, o.now),
    ...fence(db, 'EXISTS(SELECT 1 FROM product_pricing_state WHERE product_id = ? AND pricing_method IS ?)', [pid, storedMethod]),
    ...(!fresh && o.updatedAt !== undefined ? fence(db, 'EXISTS(SELECT 1 FROM products WHERE id = ? AND updated_at IS ?)', [pid, o.updatedAt]) : []),
    db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`engine-price:${pid}`),
    ...(methodMoves ? [db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`pricing-mode:${pid}`)] : []),
    ...(fresh ? [] : (o.structure ?? [])),
    ...inputStatements(db, pid, ev.inputWrites, o.actor, o.now, { pack: true }),
    ...ruleStatements(db, pid, ev.ruleWrites, o.actor, o.now, { pack: true }),
    ...pointStatements(db, pid, points, o.actor, o.now),
    ...discountStatements(db, pid, discounts, o.actor, o.now),
    ...(overlay ? [directPurchaseStatement(db, ev.stored, overlay, o.actor, o.now)] : []),
    ...(methodMoves
      ? [
          db
            .prepare(
              `UPDATE product_pricing_state
                  SET mode = 'engine', pricing_method = ?, v2_since = COALESCE(v2_since, ?),
                      opted_in_at = CASE WHEN mode = 'manual' THEN ? ELSE opted_in_at END,
                      opted_in_by = CASE WHEN mode = 'manual' THEN ? ELSE opted_in_by END,
                      updated_at = ?
                WHERE product_id = ?`
            )
            .bind(ev.method, o.now, o.now, o.actor, o.now, pid),
        ]
      : []),
    ...pricingAuditStatements(db, audits),
    ...(o.extraAudits ?? []),
    ...(
      await auditStatements(db, o.auditActor === undefined ? o.actor : o.auditActor, 'pricing.v2.data_saved', pid, {
        product_id: pid,
        v2: true,
        source: o.source,
        complete: false,
        points_changed: points.length,
        discounts_changed: discounts.length,
        inputs_changed: ev.inputWrites.length,
        rules_changed: ev.ruleWrites.length,
        ...(o.auditDetail ?? {}),
      })
    ).statements,
    ...(methodMoves ? [db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`pricing-mode:${pid}`)] : []),
    db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`engine-price:${pid}`),
    ...batchTail(db, pid),
  ];
}
