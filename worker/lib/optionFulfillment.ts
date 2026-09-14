/**
 * WRITING THE (MODEL x ORDER TYPE) AND (MODEL x ROUTE) CELLS.
 *
 * The owner's rule, and the reason this file is separate from the rest of the
 * relations writer:
 *
 *   "لا تنشئ Pre-order / Direct / Air / Sea / Land كـProduct Options."
 *
 * The structure endpoint (`PUT /:id/relations`) writes MODELS — option groups,
 * option values, colours, images. This one writes what each model does:
 * whether it sells directly, whether it can be pre-ordered, what each route
 * costs, how long each takes. Keeping the two doors apart is what makes the
 * first rule enforceable: a payload for models cannot invent an order type,
 * and a payload for order types cannot invent a model.
 *
 * A save is a REPLACEMENT, like every other relations write here: whatever the
 * admin sends is what the product has afterwards. That is the only shape that
 * lets a cell be removed at all, and it matches what `planProductSave` already
 * does for groups and values.
 */
import { badRequest } from './http';
import { newId } from './crypto';
import type { OptionValueRow } from './productRelations';

export const FULFILLMENT_TYPES = ['direct_sale', 'pre_order'] as const;
export const TRANSPORT_METHODS = ['air', 'sea', 'land'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];
export type TransportMethod = (typeof TRANSPORT_METHODS)[number];

/** The eight money columns every rung of the ladder carries. */
export interface CellPrices {
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  regular_adjust_iqd: number | null;
  prime_adjust_iqd: number | null;
  pro_adjust_iqd: number | null;
  cost_adjust_iqd: number | null;
}

export interface LeadTime {
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
}

export interface TransportCell extends CellPrices, LeadTime {
  method: TransportMethod;
  enabled: boolean;
  surcharge_iqd: number | null;
  sort: number;
}

export interface FulfillmentCell extends CellPrices, LeadTime {
  option_id: string;
  fulfillment_type: FulfillmentType;
  enabled: boolean;
  sort: number;
  transports: TransportCell[];
}

// ---------------------------------------------------------------------------

/** A money field: an integer ≥ 0, or null for "inherit the rung beneath". */
function money(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${field} must be a whole number of dinars, or empty to inherit`);
  return n;
}

/** An adjustment: a SIGNED integer, or null. Zero is a real value, not empty. */
function adjust(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n)) throw badRequest(`${field} must be a whole number of dinars, or empty`);
  return n;
}

function days(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0 || n > 3650) throw badRequest(`${field} must be a whole number of days`);
  return n;
}

function prices(row: Record<string, unknown>, where: string): CellPrices {
  return {
    regular_price_iqd: money(row.regular_price_iqd, `${where}.regular_price_iqd`),
    prime_price_iqd: money(row.prime_price_iqd, `${where}.prime_price_iqd`),
    pro_price_iqd: money(row.pro_price_iqd, `${where}.pro_price_iqd`),
    cost_iqd: money(row.cost_iqd, `${where}.cost_iqd`),
    regular_adjust_iqd: adjust(row.regular_adjust_iqd, `${where}.regular_adjust_iqd`),
    prime_adjust_iqd: adjust(row.prime_adjust_iqd, `${where}.prime_adjust_iqd`),
    pro_adjust_iqd: adjust(row.pro_adjust_iqd, `${where}.pro_adjust_iqd`),
    cost_adjust_iqd: adjust(row.cost_adjust_iqd, `${where}.cost_adjust_iqd`),
  };
}

function leadTime(row: Record<string, unknown>, where: string): LeadTime {
  const min = days(row.lead_time_min_days, `${where}.lead_time_min_days`);
  const max = days(row.lead_time_max_days, `${where}.lead_time_max_days`);
  if (min !== null && max !== null && min > max) {
    throw badRequest(`${where}: the shortest lead time cannot be longer than the longest`);
  }
  return {
    lead_time_text: String(row.lead_time_text ?? '').trim().slice(0, 200),
    lead_time_min_days: min,
    lead_time_max_days: max,
  };
}

/**
 * VALIDATE A WHOLE PAYLOAD AGAINST THE MODELS THAT ACTUALLY EXIST.
 *
 * `validOptionIds` is the set of live option rows for this product, read from
 * the database rather than trusted from the request — a cell naming a model
 * that is not there, or a model belonging to a different product, is a payload
 * that would create an unreachable price.
 */
export function parseFulfillmentPayload(
  body: unknown,
  validOptionIds: Set<string>
): FulfillmentCell[] {
  const raw = (body as { fulfillments?: unknown })?.fulfillments;
  if (!Array.isArray(raw)) throw badRequest('fulfillments must be an array');
  if (raw.length > 200) throw badRequest('Too many order-type cells in one save');

  const cells: FulfillmentCell[] = [];
  const seenCell = new Set<string>();

  raw.forEach((entry, i) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const where = `fulfillments[${i}]`;
    const optionId = String(row.option_id ?? '').trim();
    if (!optionId) throw badRequest(`${where}.option_id is required`);
    if (!validOptionIds.has(optionId)) {
      throw badRequest(`${where}.option_id names a model that is not on this product`, 'UNKNOWN_OPTION');
    }
    const type = String(row.fulfillment_type ?? '').trim() as FulfillmentType;
    if (!FULFILLMENT_TYPES.includes(type)) {
      throw badRequest(`${where}.fulfillment_type must be direct_sale or pre_order`);
    }
    // ONE CELL PER (MODEL, ORDER TYPE) — the same rule the unique index holds,
    // refused here with a sentence instead of a constraint error.
    const cellKey = `${optionId}|${type}`;
    if (seenCell.has(cellKey)) throw badRequest(`${where}: this model already has a ${type} cell`);
    seenCell.add(cellKey);

    const transportsRaw = Array.isArray(row.transports) ? row.transports : [];
    if (type === 'direct_sale' && transportsRaw.length) {
      // A DIRECT SALE HAS NO JOURNEY. Air/sea/land is how a unit reaches Iraq,
      // which is a pre-order's question; local delivery is a separate, later
      // choice that lives in ops_policy and never here.
      throw badRequest(`${where}: a direct sale has no transport — air/sea/land belongs to a pre-order`, 'TRANSPORT_ON_DIRECT');
    }
    const seenMethod = new Set<string>();
    const transports: TransportCell[] = transportsRaw.map((t, j) => {
      const tr = (t ?? {}) as Record<string, unknown>;
      const tWhere = `${where}.transports[${j}]`;
      const method = String(tr.method ?? '').trim() as TransportMethod;
      if (!TRANSPORT_METHODS.includes(method)) throw badRequest(`${tWhere}.method must be air, sea or land`);
      if (seenMethod.has(method)) throw badRequest(`${tWhere}: ${method} is listed twice`);
      seenMethod.add(method);
      return {
        method,
        enabled: tr.enabled !== false,
        surcharge_iqd: money(tr.surcharge_iqd, `${tWhere}.surcharge_iqd`),
        sort: Number.isInteger(tr.sort) ? (tr.sort as number) : j,
        ...prices(tr, tWhere),
        ...leadTime(tr, tWhere),
      };
    });

    cells.push({
      option_id: optionId,
      fulfillment_type: type,
      enabled: row.enabled !== false,
      sort: Number.isInteger(row.sort) ? (row.sort as number) : i,
      transports,
      ...prices(row, where),
      ...leadTime(row, where),
    });
  });

  return cells;
}

/**
 * THE STATEMENTS THAT MAKE THE PRODUCT'S CELLS EXACTLY THIS SET.
 *
 * Delete-then-insert rather than a diff, for the same reason the structure
 * writer replaces: a cell has no identity a customer ever sees — it IS
 * (model, order type) — so rewriting it loses nothing, while diffing would
 * need an id the admin form has no reason to carry. The transports go first
 * because they name a fulfilment row.
 */
export function fulfillmentStatements(
  db: { prepare(sql: string): D1PreparedStatement },
  productId: string,
  cells: FulfillmentCell[],
  makeId: () => string = () => newId('ofl')
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [
    db.prepare('DELETE FROM product_option_transports WHERE product_id = ?').bind(productId),
    db.prepare('DELETE FROM product_option_fulfillment WHERE product_id = ?').bind(productId),
  ];

  for (const cell of cells) {
    const id = makeId();
    out.push(
      db
        .prepare(
          `INSERT INTO product_option_fulfillment
             (id, product_id, option_id, fulfillment_type, enabled,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
              regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd,
              lead_time_text, lead_time_min_days, lead_time_max_days, sort)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          id,
          productId,
          cell.option_id,
          cell.fulfillment_type,
          cell.enabled ? 1 : 0,
          cell.regular_price_iqd,
          cell.prime_price_iqd,
          cell.pro_price_iqd,
          cell.cost_iqd,
          cell.regular_adjust_iqd,
          cell.prime_adjust_iqd,
          cell.pro_adjust_iqd,
          cell.cost_adjust_iqd,
          cell.lead_time_text,
          cell.lead_time_min_days,
          cell.lead_time_max_days,
          cell.sort
        )
    );
    for (const t of cell.transports) {
      out.push(
        db
          .prepare(
            `INSERT INTO product_option_transports
               (id, product_id, fulfillment_id, method, enabled, surcharge_iqd,
                regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
                regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd,
                lead_time_text, lead_time_min_days, lead_time_max_days, sort)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            makeId(),
            productId,
            id,
            t.method,
            t.enabled ? 1 : 0,
            t.surcharge_iqd,
            t.regular_price_iqd,
            t.prime_price_iqd,
            t.pro_price_iqd,
            t.cost_iqd,
            t.regular_adjust_iqd,
            t.prime_adjust_iqd,
            t.pro_adjust_iqd,
            t.cost_adjust_iqd,
            t.lead_time_text,
            t.lead_time_min_days,
            t.lead_time_max_days,
            t.sort
          )
      );
    }
  }
  return out;
}

/**
 * THE PRODUCT'S SALE TYPES FOLLOW ITS MODELS — the same direction 0043
 * established, extended to the cells. A product whose models all sell one way
 * IS that one way; a product with both is both. Derived, never asked for, so
 * the product row and its models cannot disagree.
 */
export function saleTypesFromCells(
  values: OptionValueRow[],
  cells: FulfillmentCell[],
  fallback: readonly string[]
): string[] {
  const live = new Set(values.filter((v) => !String(v.merged_into ?? '').trim()).map((v) => v.id));
  const types = new Set<string>();
  for (const cell of cells) {
    if (!cell.enabled || !live.has(cell.option_id)) continue;
    types.add(cell.fulfillment_type);
  }
  if (!types.size) return [...fallback];
  // Keep the stored order stable so a save is not a no-op diff every time.
  return ['direct_sale', 'pre_order'].filter((t) => types.has(t));
}

// ---------------------------------------------------------------------------
//  THE OLD SHAPE CANNOT COME BACK
// ---------------------------------------------------------------------------

/**
 * "لا تنشئ Pre-order / Direct / Air / Sea / Land كـProduct Options."
 *
 * Migration 0073 merged the old shape away. This is what stops the next save
 * from recreating it — in the FORM and in the TXT importer alike, because both
 * reach the same validator.
 *
 * TWO SIGNALS, and both are specific enough to have no false positive worth
 * worrying about:
 *
 *   1. TWO LIVE MODELS SHARING A `variant_key`. That is not a judgement call:
 *      `variant_key` exists for exactly one purpose — to say "these two option
 *      rows are the same model" — so two rows sharing one IS the old shape,
 *      by the field's own definition.
 *
 *   2. A NAME THE LEGACY PARSER WOULD READ AS AN ORDER TYPE. The test is not a
 *      new regex invented here; it is `availabilityFromName`, the function that
 *      would actually treat the name as a route. If the store's own parser
 *      would read "A1 mini — Pre-order" as a pre-order, then naming an option
 *      that is creating the old shape, and the admin is told to use the order
 *      types on the model instead.
 *
 * A row that ALREADY EXISTS with either signal is left alone: this refuses new
 * ones, it does not make an untouched legacy product unsavable. That is the
 * difference between blocking a shape and breaking a catalogue.
 */
export interface ModelShapeInput {
  id: string;
  name_en: string;
  variant_key: string;
  active: number | boolean;
}

export function legacyShapeErrors(
  incoming: ModelShapeInput[],
  existing: ReadonlyMap<string, { name_en: string; variant_key: string }>,
  availabilityFromName: (name: string) => string
): string[] {
  const errors: string[] = [];
  const isNew = (v: ModelShapeInput) => !existing.has(v.id);
  const nameChanged = (v: ModelShapeInput) => existing.get(v.id)?.name_en !== v.name_en;
  const keyChanged = (v: ModelShapeInput) => existing.get(v.id)?.variant_key !== v.variant_key;

  const live = incoming.filter((v) => v.active !== 0 && v.active !== false);

  const byKey = new Map<string, ModelShapeInput[]>();
  for (const v of live) {
    const key = v.variant_key.trim();
    if (!key) continue;
    const arr = byKey.get(key);
    if (arr) arr.push(v);
    else byKey.set(key, [v]);
  }
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    // Untouched legacy rows stay saveable; a NEW or RENAMED duplicate does not.
    if (!group.some((v) => isNew(v) || keyChanged(v))) continue;
    errors.push(
      `"${group.map((v) => v.name_en).join('" و "')}" هما نفس الموديل (${key}) — ` +
        'الموديل يُذكر مرة واحدة، ونوع الطلب (بيع مباشر / طلب مسبق) يُضبط عليه. ' +
        `/ these are one model (${key}): a model is listed once, and its order types are set on it.`
    );
  }

  for (const v of live) {
    if (!isNew(v) && !nameChanged(v)) continue;
    if (!availabilityFromName(v.name_en)) continue;
    errors.push(
      `"${v.name_en}": نوع الطلب ليس خيار منتج — اضبط البيع المباشر / الطلب المسبق على الموديل نفسه. ` +
        '/ an order type is not a product option — set direct sale / pre-order on the model itself.'
    );
  }

  return errors;
}
