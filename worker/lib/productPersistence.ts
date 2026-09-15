/**
 * ONE PERSISTENCE CONTRACT FOR A PRODUCT — the form, the TXT template and
 * the CSV importer all write a product through this module, and nothing else
 * writes the product tables (docs/TXT_IMPORT_PARITY.md §5.1).
 *
 * Why one module: the admin form saved a product in two requests (the
 * document, then the relations PUT) and the TXT template saved it in one
 * request that wrote only the `products` row — its options, colours and
 * images landed in JSON columns nothing reads once relational rows exist, so
 * a product imported from a file opened EMPTY in the form and sold its options
 * through a fallback the owner could not see. Two persistence paths, one of
 * them dead. This is the single path:
 *
 *   planProductSave(db, intent)      → statements + what they will store
 *   saveProductAtomic(db, plan)      → ONE db.batch, then the audit rows
 *   reloadForVerification(db, id)    → exactly what the form's two GETs return
 *   verifyApplied(plan, stored)      → requested vs stored, field by field
 *
 * The plan covers the product row, option groups and values, colours and
 * their links, variants, images, catalog placement, `inventory_mode`, the
 * price-history rows, the hashtag vocabulary and the translation rows — all
 * in one batch, so a product can never half-land.
 *
 * WHAT "OMITTED" MEANS HERE, EXACTLY — the rule differs by level, and a
 * caller that assumes the wrong one deletes a catalogue:
 *   - no `doc`            → the `products` row is not touched at all.
 *   - no `relations` body → the relation TABLES are not touched at all.
 *   - a `relations` body  → it is a FULL REPLACEMENT of the four collections
 *     it can carry. `groups`, `colors`, `variants` and `images` each read an
 *     omitted key exactly like `[]`: every stored row of that collection is
 *     deleted (subject to the reserved-stock and live-order guards below).
 *     Only `facet_ids` distinguishes absent (preserve) from `[]` (clear), and
 *     `inventory_mode` is preserved-then-derived — both are documented at
 *     their own code sites. Every caller in this repository (the form's
 *     `relationsToWire`, the TXT bridge, the CSV importer) sends all four
 *     keys on every write, which is what makes the replacement safe.
 *   - inside a row, an omitted TEXT field with an explicit `clear` flag
 *     (0048 image provenance, 0055 option/colour names) IS preserved.
 * The JSON mirror on `products` (`options`/`colors`/`images`) is never taken
 * from the caller: when a relations body is planned it is DERIVED from the
 * planned rows, so it can never outlive the rows it mirrors.
 *
 * §11 applies throughout: an actor without financial scope can neither read
 * nor write a cost — the stored costs are carried forward, on create as on
 * update, into the row, the rows and the JSON mirror alike.
 */

import { badRequest, notFound, str, int, HttpError } from './http';
import { newId } from './crypto';
import { audit } from './audit';
import { busFor, nextAggregateSeq, outboxStatement } from './eventBus';
import { ProductAddedV1 } from '@levonis/contracts/events/v1/ProductAdded';
import { sha256Hex } from '@levonis/contracts/canonical';
import { availabilityFromName, deriveSaleTypes, normalizeAvailability, variantKeyFrom, variantLabelFallback } from './availability';
import {
  existingCellsFrom,
  fulfillmentStatements,
  legacyShapeErrors,
  parseFulfillmentPayload,
  refuseStrandedCapacity,
} from './optionFulfillment';
import {
  normalizeSaleTypes,
  parseProductRow,
  serializeDoc,
  projectAdmin,
  PRODUCT_COLUMNS,
  type ProductDoc,
  type TranslationMeta,
} from './productModel';
import {
  isValidHex,
  normalizeHex,
  loadProductRelations,
  validatePriceLadder,
  optionLaddersFor,
  type ProductRelations,
} from './productRelations';
import { comboKey, isInventoryMode, type InventoryMode } from './inventory';
import { applyRelations, loadRelationsView, type ImageRow, type ProductRelationsView } from './productOverlay';
import { localizeProductDoc, type LocalizeResult } from './translate/localizeProduct';
import { planProductTranslations, type TranslationInput } from './translate/store';
import { dedupeHashtags, hashtagKey } from './hashtags';
import { docToEntries } from './template';
import { localizableSlots } from './translationSlots';

// =========================================================================
// 1. The relations planner (groups, values, colours, links, variants, images)
// =========================================================================

interface PriceInput {
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  /** 0044 adjustments — signed, and null on every row that has never used one. */
  regular_adjust_iqd: number | null;
  prime_adjust_iqd: number | null;
  pro_adjust_iqd: number | null;
  cost_adjust_iqd: number | null;
}

const nullableInt = (v: unknown, field: string, max = 1_000_000_000): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    throw badRequest(`${field}: must be a whole number between 0 and ${max}, or empty`);
  }
  return v;
};

/** A 0044 adjustment may be negative — a discount below the inherited value is
 *  the ordinary case — so it cannot share `nullableInt`, which floors at zero. */
const nullableSigned = (v: unknown, field: string, max = 1_000_000_000): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > max) {
    throw badRequest(`${field}: must be a whole number between -${max} and ${max}, or empty`);
  }
  return v;
};

/**
 * A FIXED PRICE AND AN ADJUSTMENT CANNOT BOTH BE STORED ON ONE FIELD.
 *
 * `priceMode` (packages/pricing) answers 'fixed' the moment `*_price_iqd` is
 * non-null, so an adjustment stored beside it is not a second opinion — it is
 * dead data the resolver ignores. It stays dangerous precisely because it is
 * ignored: the day someone clears the fixed price to make the row inherit
 * again, the forgotten delta wakes up and the row silently charges the base
 * plus an amount nobody typed.
 *
 * So the pair is collapsed on the way IN, where both writers pass: the product
 * form's relations save and the TXT/CSV import both reach the database through
 * `readPrices`. Dropping the twin changes NO price today (the fixed value
 * already won) and removes the one that could change a price tomorrow.
 */
function collapse(price: number | null, adjust: number | null): number | null {
  return price === null ? adjust : null;
}

function readPrices(o: Record<string, unknown>, where: string): PriceInput {
  const regular_price_iqd = nullableInt(o.regular_price_iqd, `${where}.regular_price_iqd`);
  const prime_price_iqd = nullableInt(o.prime_price_iqd, `${where}.prime_price_iqd`);
  const pro_price_iqd = nullableInt(o.pro_price_iqd, `${where}.pro_price_iqd`);
  const cost_iqd = nullableInt(o.cost_iqd, `${where}.cost_iqd`);
  return {
    regular_price_iqd,
    prime_price_iqd,
    pro_price_iqd,
    cost_iqd,
    regular_adjust_iqd: collapse(regular_price_iqd, nullableSigned(o.regular_adjust_iqd, `${where}.regular_adjust_iqd`)),
    prime_adjust_iqd: collapse(prime_price_iqd, nullableSigned(o.prime_adjust_iqd, `${where}.prime_adjust_iqd`)),
    pro_adjust_iqd: collapse(pro_price_iqd, nullableSigned(o.pro_adjust_iqd, `${where}.pro_adjust_iqd`)),
    cost_adjust_iqd: collapse(cost_iqd, nullableSigned(o.cost_adjust_iqd, `${where}.cost_adjust_iqd`)),
  };
}

const asArray = (v: unknown, field: string): Record<string, unknown>[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw badRequest(`${field}: expected a list`);
  if (v.length > MAX_ROWS_PER_COLLECTION) {
    throw badRequest(`${field}: ${v.length} rows is more than the ${MAX_ROWS_PER_COLLECTION} one product may carry`);
  }
  return v.map((x, i) => {
    if (!x || typeof x !== 'object') throw badRequest(`${field}[${i}]: expected an object`);
    return x as Record<string, unknown>;
  });
};

/**
 * D1 refuses a query with more than 100 bound parameters, so every `IN (...)`
 * list this module builds is cut into chunks that leave room for the trailing
 * product id — the same 90 the printer-identity reader uses
 * (worker/lib/printerIdentity.ts). A product with a hundred option values is
 * ordinary; a raw driver error instead of a named refusal is not.
 */
const IN_CHUNK = 90;
function chunked<T>(ids: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(ids.slice(i, i + IN_CHUNK));
  return out;
}

/**
 * A hard ceiling per collection. MAX_TEMPLATE_CHARS admits a 1.5 MB file and
 * the parser allows 500 indices per group, so an unbounded payload can plan a
 * batch of many hundreds of statements against one product. The cap is stated
 * rather than discovered as a timeout.
 */
const MAX_ROWS_PER_COLLECTION = 400;


/** A text field that is PRESERVED when the client did not send it and WRITTEN
 *  (even as '') when it did — the rule that makes `__CLEAR__` real for the
 *  0048 image provenance and the 0055 option/colour names. */
const optionalText = (v: unknown, field: string, max: number): string | undefined => {
  if (v === undefined || v === null) return undefined;
  return str(v, field, { max, required: false }) ?? '';
};

export interface Ladder {
  regular: number;
  prime: number | null;
  pro: number | null;
}

export const ladderOf = (doc: Pick<ProductDoc, 'price_iqd' | 'prime_price_iqd' | 'pro_price_iqd'>): Ladder => ({
  regular: Number(doc.price_iqd),
  prime: doc.prime_price_iqd === null ? null : Number(doc.prime_price_iqd),
  pro: doc.pro_price_iqd === null ? null : Number(doc.pro_price_iqd),
});

/** An order line still open against this product — the combinations a
 *  variant must not be deleted from under. */
interface LiveLine {
  option_value_ids: string[];
  color_id: string;
}

/**
 * Everything the planner needs to know about the product AS IT IS, so it can
 * run BEFORE the product row exists (a create) and validate against the
 * ladder the same batch is about to write (an update).
 */
export interface RelationsSnapshot {
  productId: string;
  baseLadder: Ladder;
  inventoryMode: InventoryMode;
  saleTypes: string[];
  baseReserved: number;
  existing: ProductRelations;
  existingVariants: Array<{ id: string; combo_key: string; reserved: number; stock: number | null; active: number }>;
  /** Full rows: the planner needs their id to decide deletions, and the JSON
   *  mirror needs the provenance fields a payload may omit (0048 preserve). */
  existingImages: ImageRow[];
  liveLines: LiveLine[];
  /** True when the live-order query FAILED for a reason that is not "this
   *  database predates 0023". An empty `liveLines` then means "unknown",
   *  not "none", and the planner refuses deletions rather than silently
   *  dropping a row an open order names. */
  liveLinesUnavailable: boolean;
}

/** The product's current state from the database. `over` substitutes the
 *  ladder and sale types the caller is writing in the same batch. */
export async function loadRelationsSnapshot(
  db: D1Database,
  productId: string,
  over: { ladder?: Ladder; saleTypes?: string[] } = {}
): Promise<RelationsSnapshot> {
  const product = await db
    .prepare(
      'SELECT id, inventory_mode, price_iqd, prime_price_iqd, pro_price_iqd, sale_types, selling_type, stock_reserved FROM products WHERE id = ?'
    )
    .bind(productId)
    .first<{
      id: string;
      inventory_mode: string;
      price_iqd: number;
      prime_price_iqd: number | null;
      pro_price_iqd: number | null;
      sale_types: string;
      selling_type: string;
      stock_reserved: number | null;
    }>();
  if (!product) throw notFound('Product not found');

  const [existing, variants, images, lines] = await Promise.all([
    loadProductRelations(db, productId),
    db
      .prepare('SELECT id, combo_key, reserved, stock, active FROM product_variants WHERE product_id = ?')
      .bind(productId)
      .all<{ id: string; combo_key: string; reserved: number; stock: number | null; active: number }>(),
    db.prepare('SELECT * FROM product_images WHERE product_id = ?').bind(productId).all<ImageRow>(),
    loadLiveLines(db, productId),
  ]);

  return {
    productId,
    baseLadder: over.ladder ?? ladderOf(product),
    inventoryMode: isInventoryMode(product.inventory_mode) ? product.inventory_mode : 'BASE',
    saleTypes:
      over.saleTypes ?? (normalizeSaleTypes(product.sale_types, String(product.selling_type ?? 'direct_sale')) as string[]),
    baseReserved: Number(product.stock_reserved ?? 0),
    existing,
    existingVariants: variants.results,
    existingImages: images.results,
    liveLines: lines.lines,
    liveLinesUnavailable: lines.unavailable,
  };
}

/**
 * Order lines of any non-cancelled order that name this product.
 *
 * A missing table or column (a database migrated before 0023) reads as "no
 * live lines" — the protection genuinely cannot apply, and refusing every
 * save on such a database would be worse. ANY OTHER failure — a transient D1
 * error, a lock, a query bug — is reported as `unavailable`, because an empty
 * list would silently downgrade «never delete a variant tied to a live order»
 * to a delete (docs/TXT_IMPORT_PARITY.md).
 */
async function loadLiveLines(
  db: D1Database,
  productId: string
): Promise<{ lines: LiveLine[]; unavailable: boolean }> {
  try {
    const { results } = await db
      .prepare(
        `SELECT oi.option_value_ids, oi.option_id, oi.color_id
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE oi.product_id = ? AND o.status <> 'cancelled'`
      )
      .bind(productId)
      .all<{ option_value_ids: string | null; option_id: string | null; color_id: string | null }>();
    const mapped = results.map((r) => {
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(r.option_value_ids || '[]');
        ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && !!x) : [];
      } catch {
        ids = [];
      }
      if (ids.length === 0 && r.option_id) ids = [r.option_id];
      return { option_value_ids: ids.sort(), color_id: r.color_id ?? '' };
    });
    return { lines: mapped, unavailable: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('live order lines unavailable', msg);
    // "the column/table does not exist" is the documented pre-0023 case.
    const preMigration = /no such table|no such column/i.test(msg);
    return { lines: [], unavailable: !preMigration };
  }
}

/** The snapshot of a product that does not exist yet. */
export function snapshotForCreate(doc: ProductDoc): RelationsSnapshot {
  return {
    productId: doc.id,
    baseLadder: ladderOf(doc),
    inventoryMode: 'BASE',
    saleTypes: [...doc.sale_types],
    baseReserved: 0,
    existing: { groups: [], values: [], colors: [], links: [], fulfillments: [], transports: [] },
    existingVariants: [],
    existingImages: [],
    liveLines: [],
    liveLinesUnavailable: false,
  };
}

export interface RelationsSummary {
  inventory_mode: InventoryMode;
  groups: number;
  values: number;
  colors: number;
  links: number;
  variants: number;
  images: number;
  primary_image: string | null;
  facets: number | 'preserved';
  cost_written: boolean;
}

/** The rows the planner will write, normalised — what `verifyApplied`
 *  compares the read-back against. */
export interface RequestedRelations {
  inventory_mode: InventoryMode;
  groups: Array<{ id: string; name_en: string; sort: number; active: number }>;
  values: Array<{
    id: string;
    group_id: string;
    name_en: string;
    name_ar?: string;
    name_ckb?: string;
    sku_part: string;
    image: string;
    sort: number;
    active: number;
    stock: number | null;
    low_stock_threshold: number | null;
    prices: PriceInput;
    availability_type: string;
    lead_time_text: string;
    lead_time_min_days: number | null;
    lead_time_max_days: number | null;
    variant_key: string;
    variant_label: string;
    /**
     * 0073. This model's (order type) cells, as the CALLER supplied them.
     * `undefined` = the caller said nothing, so the stored cells are kept.
     * The form never sets it; the TXT document does.
     */
    fulfillments?: unknown[];
  }>;
  colors: Array<{
    id: string;
    name_en: string;
    name_ar?: string;
    name_ckb?: string;
    hex: string;
    image: string;
    sku_part: string;
    sort: number;
    active: number;
    stock: number | null;
    low_stock_threshold: number | null;
    prices: PriceInput;
    linked: string[];
  }>;
  variants: Array<{
    id: string;
    combo_key: string;
    sku: string | null;
    active: number;
    stock: number | null;
    low_stock_threshold: number | null;
    prices: PriceInput;
  }>;
  images: Array<{
    id: string;
    url: string;
    alt_en: string;
    sort_order: number;
    is_primary: number;
    option_value_id: string | null;
    color_id: string | null;
    variant_id: string | null;
    content_type: string;
    alt_ar?: string;
    alt_ckb?: string;
    r2_key?: string;
    source_url?: string;
    width: number | null;
    height: number | null;
    bytes: number | null;
  }>;
  facet_ids: string[] | null;
}

export type RelationsPlan =
  | { errors: string[]; stmts?: undefined }
  | {
      errors: never[];
      stmts: D1PreparedStatement[];
      mode: InventoryMode;
      summary: RelationsSummary;
      requested: RequestedRelations;
      /** Things the planner decided for the caller — a variant kept alive
       *  for an open order instead of deleted, for instance. */
      warnings: string[];
    };

/**
 * The whole-structure write, planned against a snapshot.
 *
 * It PLANS and does not execute: on success it returns the statements for the
 * caller to run inside ITS batch, together with the product row. Rows are
 * matched by id, so `stock` and `reserved` survive an edit that only renames a
 * value or reorders it. A row that disappears from the payload is deleted —
 * unless it holds reserved units for a live order (refused with the count) or,
 * for a variant, an open order names its combination (deactivated instead,
 * and the caller is told).
 */
export async function planRelationsWriteFrom(
  db: D1Database,
  snap: RelationsSnapshot,
  body: Record<string, unknown>,
  opts: { money: boolean }
): Promise<RelationsPlan> {
  const money = opts.money;
  const productId = snap.productId;
  const baseLadder = snap.baseLadder;
  const existing = snap.existing;
  const errors: string[] = [];
  const warnings: string[] = [];

  // The inventory mode is decided once the rows are parsed — see below.

  // ---- groups ------------------------------------------------------------
  const groupInputs = asArray(body.groups, 'groups').map((g, i) => ({
    id: typeof g.id === 'string' && g.id ? g.id : newId('og'),
    name_en: str(g.name_en, `groups[${i}].name_en`, { max: 80 }),
    sort: int(g.sort, `groups[${i}].sort`, { min: 0, max: 10000, def: i }),
    active: g.active === false ? 0 : 1,
    values: asArray(g.values, `groups[${i}].values`),
  }));
  const groupIds = new Set(groupInputs.map((g) => g.id));
  if (groupIds.size !== groupInputs.length) errors.push('groups: duplicate group id');

  // ---- values ------------------------------------------------------------
  const valueInputs: RequestedRelations['values'] = [];
  for (const g of groupInputs) {
    g.values.forEach((v, i) => {
      const where = `${g.name_en}[${i}]`;
      const prices = readPrices(v, where);
      errors.push(...validatePriceLadder(prices, where, baseLadder));
      const name = str(v.name_en, `${where}.name_en`, { max: 80 });
      // 0043. Unknown words become '' (inherit) rather than an error: this
      // endpoint is also how an old client saves an old product, and refusing
      // a field it has never heard of would break editing the catalogue.
      const availability = normalizeAvailability(v.availability_type);
      const leadText = str(v.lead_time_text, `${where}.lead_time_text`, { max: 120, required: false }) ?? '';
      const leadMin = nullableInt(v.lead_time_min_days, `${where}.lead_time_min_days`, 3650);
      const leadMax = nullableInt(v.lead_time_max_days, `${where}.lead_time_max_days`, 3650);
      if (leadMin !== null && leadMax !== null && leadMin > leadMax) {
        errors.push(`${where}: lead_time_min_days is after lead_time_max_days`);
      }
      // A direct-sale option has no journey to wait for, so a lead time on one
      // is a contradiction the admin should see rather than a value to store.
      if (availability === 'direct_sale' && (leadText.trim() || leadMin !== null || leadMax !== null)) {
        errors.push(`${where}: a direct-sale option has no lead time`);
      }
      const label = str(v.variant_label, `${where}.variant_label`, { max: 80, required: false }) ?? '';
      const key = str(v.variant_key, `${where}.variant_key`, { max: 60, required: false }) ?? '';
      // The label falls back to the option's own name with the availability
      // suffix removed, and the key to that label's slug — so a product saved
      // by a client that does not know these fields still groups correctly.
      const effectiveLabel = label.trim() || variantLabelFallback(name);
      valueInputs.push({
        id: typeof v.id === 'string' && v.id ? v.id : newId('ov'),
        group_id: g.id,
        name_en: name,
        // 0055 — absent means PRESERVE (the form never sends them), a string
        // means write it, '' included.
        name_ar: optionalText(v.name_ar, `${where}.name_ar`, 200),
        name_ckb: optionalText(v.name_ckb, `${where}.name_ckb`, 200),
        sku_part: str(v.sku_part, `${where}.sku_part`, { max: 40, required: false }) ?? '',
        image: str(v.image, `${where}.image`, { max: 500, required: false }) ?? '',
        sort: int(v.sort, `${where}.sort`, { min: 0, max: 10000, def: i }),
        active: v.active === false ? 0 : 1,
        stock: nullableInt(v.stock, `${where}.stock`, 10_000_000),
        low_stock_threshold: nullableInt(v.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
        prices,
        availability_type: availability,
        lead_time_text: leadText,
        lead_time_min_days: availability === 'direct_sale' ? null : leadMin,
        lead_time_max_days: availability === 'direct_sale' ? null : leadMax,
        variant_key: key.trim() || variantKeyFrom(effectiveLabel),
        variant_label: effectiveLabel,
        /**
         * 0073. THE MODEL'S ORDER TYPES — only when the payload actually
         * carries them.
         *
         * The FORM never sends this key: its structure editor writes models,
         * and the order types have their own endpoint and their own panel.
         * The TXT document does, because one file describes a whole product.
         * Absent therefore means PRESERVE, which is what keeps the two doors
         * separate without needing a second code path.
         */
        fulfillments: Array.isArray(v.fulfillments) ? v.fulfillments : undefined,
      });
    });
  }

  /**
   * 0073. THE OLD SHAPE CANNOT COME BACK THROUGH THIS DOOR.
   *
   * "لا تنشئ Pre-order / Direct / Air / Sea / Land كـProduct Options." The
   * migration merged the duplicates away; this is what stops the next save
   * from recreating them. It refuses only NEW or RENAMED rows, so an untouched
   * legacy product stays editable — blocking a shape, not breaking a catalogue.
   */
  errors.push(
    ...legacyShapeErrors(
      valueInputs.map((v) => ({
        id: v.id,
        name_en: v.name_en,
        variant_key: v.variant_key,
        active: v.active,
      })),
      new Map(
        snap.existing.values.map((v) => [
          v.id,
          { name_en: v.name_en, variant_key: (v.variant_key ?? '').trim() },
        ])
      ),
      availabilityFromName
    )
  );
  const valueIds = new Set(valueInputs.map((v) => v.id));
  if (valueIds.size !== valueInputs.length) errors.push('values: duplicate value id');
  if (valueInputs.length > MAX_ROWS_PER_COLLECTION) {
    errors.push(`values: ${valueInputs.length} option values is more than the ${MAX_ROWS_PER_COLLECTION} one product may carry`);
  }

  // ---- colours and their links -------------------------------------------
  const colorInputs: RequestedRelations['colors'] = asArray(body.colors, 'colors').map((col, i) => {
    const where = `colors[${i}]`;
    const hexRaw = str(col.hex, `${where}.hex`, { max: 9 });
    if (!isValidHex(hexRaw)) {
      errors.push(`${where}.hex: must be #RGB or #RRGGBB`);
    }
    const prices = readPrices(col, where);
    const linkedRaw = Array.isArray(col.option_value_ids) ? col.option_value_ids : [];
    const linked = linkedRaw.filter((x): x is string => typeof x === 'string');
    // A colour is sold under an option, so its member ladder is judged under
    // each option it can be sold with (its links, else every active option) —
    // the same rule the product form, the import and the Quick Edit apply.
    errors.push(
      ...validatePriceLadder(
        prices,
        where,
        baseLadder,
        optionLaddersFor(
          baseLadder,
          valueInputs.map((v) => ({ id: v.id, where: `"${v.name_en}"`, active: v.active, prices: v.prices })),
          linked
        )
      )
    );
    for (const l of linked) {
      if (!valueIds.has(l)) errors.push(`${where}: linked option value ${l} does not exist in this product`);
    }
    return {
      id: typeof col.id === 'string' && col.id ? col.id : newId('pc'),
      name_en: str(col.name_en, `${where}.name_en`, { max: 80 }),
      name_ar: optionalText(col.name_ar, `${where}.name_ar`, 200),
      name_ckb: optionalText(col.name_ckb, `${where}.name_ckb`, 200),
      hex: isValidHex(hexRaw) ? normalizeHex(hexRaw) : '#000000',
      image: str(col.image, `${where}.image`, { max: 500, required: false }) ?? '',
      sku_part: str(col.sku_part, `${where}.sku_part`, { max: 40, required: false }) ?? '',
      sort: int(col.sort, `${where}.sort`, { min: 0, max: 10000, def: i }),
      active: col.active === false ? 0 : 1,
      stock: nullableInt(col.stock, `${where}.stock`, 10_000_000),
      low_stock_threshold: nullableInt(col.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
      prices,
      linked: [...new Set(linked)],
    };
  });
  const colorIds = new Set(colorInputs.map((x) => x.id));
  if (colorIds.size !== colorInputs.length) errors.push('colors: duplicate colour id');

  // ---- variants ----------------------------------------------------------
  const groupOfValue = new Map(valueInputs.map((v) => [v.id, v.group_id]));
  const variantInputs: RequestedRelations['variants'] = asArray(body.variants, 'variants').map((v, i) => {
    const where = `variants[${i}]`;
    const optionIds = (Array.isArray(v.option_value_ids) ? v.option_value_ids : []).filter(
      (x): x is string => typeof x === 'string'
    );
    const colorId = typeof v.color_id === 'string' && v.color_id ? v.color_id : null;
    for (const id of optionIds) {
      if (!valueIds.has(id)) errors.push(`${where}: option value ${id} does not exist in this product`);
    }
    if (colorId && !colorIds.has(colorId)) errors.push(`${where}: colour ${colorId} does not exist in this product`);
    const seenGroups = new Set<string>();
    for (const id of optionIds) {
      const g = groupOfValue.get(id);
      if (g && seenGroups.has(g)) errors.push(`${where}: two values from the same option group`);
      if (g) seenGroups.add(g);
    }
    const prices = readPrices(v, where);
    errors.push(...validatePriceLadder(prices, where));
    // The key is computed here, never taken from the client (§11: "لا تثق في
    // سعر أو عضوية أو شحن مرسل من الواجهة").
    const key = comboKey({ option_value_ids: optionIds, color_id: colorId });
    if (!key) errors.push(`${where}: a variant needs at least one option value or a colour`);
    return {
      id: typeof v.id === 'string' && v.id ? v.id : newId('pv'),
      combo_key: key,
      sku: str(v.sku, `${where}.sku`, { max: 60, required: false }) || null,
      active: v.active === false ? 0 : 1,
      stock: nullableInt(v.stock, `${where}.stock`, 10_000_000),
      low_stock_threshold: nullableInt(v.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
      prices,
    };
  });
  const variantKeys = new Set(variantInputs.map((v) => v.combo_key));
  if (variantKeys.size !== variantInputs.length) errors.push('variants: two rows describe the same combination');

  // The inventory mode is decided once every deletion is known — see below.

  // ---- images ------------------------------------------------------------
  const imageInputs: RequestedRelations['images'] = asArray(body.images, 'images').map((img, i) => {
    const where = `images[${i}]`;
    const optionValueId = typeof img.option_value_id === 'string' && img.option_value_id ? img.option_value_id : null;
    const colorId = typeof img.color_id === 'string' && img.color_id ? img.color_id : null;
    const variantId = typeof img.variant_id === 'string' && img.variant_id ? img.variant_id : null;
    const bindings = [optionValueId, colorId, variantId].filter(Boolean).length;
    if (bindings > 1) errors.push(`${where}: an image may be bound to at most one of option, colour or variant`);
    if (optionValueId && !valueIds.has(optionValueId)) errors.push(`${where}: unknown option value`);
    if (colorId && !colorIds.has(colorId)) errors.push(`${where}: unknown colour`);
    if (
      variantId &&
      !variantInputs.some((v) => v.id === variantId) &&
      !snap.existingVariants.some((v) => v.id === variantId)
    ) {
      errors.push(`${where}: unknown variant`);
    }
    return {
      id: typeof img.id === 'string' && img.id ? img.id : newId('pi'),
      url: str(img.url, `${where}.url`, { max: 1000 }),
      alt_en: str(img.alt_en, `${where}.alt_en`, { max: 300, required: false }) ?? '',
      sort_order: int(img.sort_order, `${where}.sort_order`, { min: 0, max: 10000, def: i }),
      is_primary: img.is_primary === true ? 1 : 0,
      option_value_id: optionValueId,
      color_id: colorId,
      variant_id: variantId,
      content_type: str(img.content_type, `${where}.content_type`, { max: 100, required: false }) ?? '',
      // ---- 0048 -----------------------------------------------------------
      // Absent = PRESERVE what is stored (the form's relations PUT and the CSV
      // importer never send these four); present = write it, and '' clears —
      // so the template's __CLEAR__ finally reaches the row
      // (docs/TXT_IMPORT_PARITY.md, root cause 7).
      alt_ar: optionalText(img.alt_ar, `${where}.alt_ar`, 300),
      alt_ckb: optionalText(img.alt_ckb, `${where}.alt_ckb`, 300),
      r2_key: optionalText(img.r2_key, `${where}.r2_key`, 400),
      source_url: optionalText(img.source_url, `${where}.source_url`, 1000),
      width: nullableInt(img.width, `${where}.width`, 100000),
      height: nullableInt(img.height, `${where}.height`, 100000),
      bytes: nullableInt(img.bytes, `${where}.bytes`, 1_000_000_000),
    };
  });
  const primaries = imageInputs.filter((i) => i.is_primary === 1);
  if (primaries.length > 1) {
    errors.push('images: only one image can be the primary image');
  }
  if (imageInputs.length > 0 && primaries.length === 0) {
    // Rather than refusing the save, the first image becomes primary — the
    // storefront needs one and silently having none is worse than choosing.
    imageInputs[0].is_primary = 1;
  }

  // ---- facets ------------------------------------------------------------
  //
  // ABSENT MEANS PRESERVE, not "clear". The product form no longer carries a
  // filters picker, so every save from the browser omits `facet_ids` — and a
  // writer that read an omitted key as an empty list would delete a product's
  // stored filters the first time anyone edited its price. An explicit array
  // still replaces the set, which is what the importer and the API contract
  // need.
  const facetIds = Array.isArray(body.facet_ids)
    ? body.facet_ids.filter((x): x is string => typeof x === 'string')
    : null;

  // ---- deletions that would strand reserved stock ------------------------
  const keptValues = valueIds;
  const keptColors = colorIds;
  const keptVariants = new Set(variantInputs.map((v) => v.id));
  const reservedOfValue = new Map(existing.values.map((v) => [v.id, v.reserved ?? 0]));
  const reservedOfColor = new Map(existing.colors.map((c) => [c.id, c.reserved ?? 0]));
  const reservedOfVariant = new Map(snap.existingVariants.map((v) => [v.id, v.reserved ?? 0]));
  for (const v of existing.values) {
    if (!keptValues.has(v.id) && (v.reserved ?? 0) > 0) {
      errors.push(`Option "${v.name_en}" has ${v.reserved} unit(s) reserved for live orders and cannot be removed`);
    }
  }
  for (const col of existing.colors) {
    if (!keptColors.has(col.id) && (col.reserved ?? 0) > 0) {
      errors.push(`Colour "${col.name_en}" has ${col.reserved} unit(s) reserved for live orders and cannot be removed`);
    }
  }
  for (const v of snap.existingVariants) {
    if (!keptVariants.has(v.id) && (v.reserved ?? 0) > 0) {
      errors.push(`Combination "${v.combo_key}" has ${v.reserved} reserved unit(s) and cannot be removed`);
    }
  }
  // ---- a stock figure below what is already held for orders --------------
  // Reserved units are promised to customers; a count that cannot cover them
  // is not a correction but an oversell waiting to happen.
  for (const v of valueInputs) {
    const reserved = reservedOfValue.get(v.id) ?? 0;
    if (v.stock !== null && v.stock < reserved) {
      errors.push(`Option "${v.name_en}": stock ${v.stock} is below the ${reserved} unit(s) reserved for live orders`);
    }
  }
  for (const col of colorInputs) {
    const reserved = reservedOfColor.get(col.id) ?? 0;
    if (col.stock !== null && col.stock < reserved) {
      errors.push(`Colour "${col.name_en}": stock ${col.stock} is below the ${reserved} unit(s) reserved for live orders`);
    }
  }
  for (const v of variantInputs) {
    const reserved = reservedOfVariant.get(v.id) ?? 0;
    if (v.stock !== null && v.stock < reserved) {
      errors.push(`Combination "${v.combo_key}": stock ${v.stock} is below the ${reserved} unit(s) reserved for live orders`);
    }
  }

  // ---- a row an open order names is never deleted ------------------------
  // The order's line still points at that combination, that option value and
  // that colour for its stages, its returns and its warranty; deleting the row
  // would orphan it. The row is DEACTIVATED instead — it stops being sold, it
  // keeps its identity, and the caller is told. The rule used to cover
  // variants only, so `options=__CLEAR__` on a product with a delivered order
  // erased the very option value the order line names.
  const liveKeys = new Set(
    snap.liveLines.map((l) => comboKey({ option_value_ids: l.option_value_ids, color_id: l.color_id || null }))
  );
  const liveValueIds = new Set(snap.liveLines.flatMap((l) => l.option_value_ids));
  const liveColorIds = new Set(snap.liveLines.map((l) => l.color_id).filter(Boolean));
  const retainedVariants = snap.existingVariants.filter(
    (v) => !keptVariants.has(v.id) && (v.reserved ?? 0) === 0 && liveKeys.has(v.combo_key)
  );
  for (const v of retainedVariants) {
    warnings.push(
      `Combination "${v.combo_key}" is named by a live order and was deactivated instead of deleted / التركيبة مرتبطة بطلب حيّ فعُطِّلت بدل حذفها`
    );
  }
  const retainedValues = existing.values.filter(
    (v) => !keptValues.has(v.id) && (v.reserved ?? 0) === 0 && liveValueIds.has(v.id)
  );
  for (const v of retainedValues) {
    warnings.push(
      `Option "${v.name_en}" is named by a live order and was deactivated instead of deleted / الخيار مرتبط بطلب حيّ فعُطِّل بدل حذفه`
    );
  }
  const retainedColors = existing.colors.filter(
    (col) => !keptColors.has(col.id) && (col.reserved ?? 0) === 0 && liveColorIds.has(col.id)
  );
  for (const col of retainedColors) {
    warnings.push(
      `Colour "${col.name_en}" is named by a live order and was deactivated instead of deleted / اللون مرتبط بطلب حيّ فعُطِّل بدل حذفه`
    );
  }
  // A live-order query that failed for any reason other than "this database
  // predates 0023" leaves the protection UNEVALUATED. Deleting on that basis
  // would be exactly the silent downgrade the guard exists to prevent.
  if (snap.liveLinesUnavailable) {
    const dropping =
      snap.existingVariants.some((v) => !keptVariants.has(v.id)) ||
      existing.values.some((v) => !keptValues.has(v.id)) ||
      existing.colors.some((col) => !keptColors.has(col.id));
    if (dropping) {
      errors.push(
        'live orders could not be checked, so no option, colour or combination was deleted — retry / تعذّر التحقق من الطلبات الحيّة فلم يُحذف أي خيار أو لون أو تركيبة'
      );
    }
  }

  // ---- inventory mode ----------------------------------------------------
  //
  // ONE RULE FOR EVERY CALLER, in three steps.
  //   1. A body that STATES a mode owns it (the form, the TXT bridge and the
  //      CSV importer all do — they compute it from the rows they are about
  //      to write).
  //   2. A body that does not PRESERVES the stored mode, as long as the level
  //      it names still has rows after this save. "Omitted = preserve" is the
  //      contract, and this is the one relations field whose silent change
  //      moves which level counts the stock (worker/lib/inventory.ts).
  //   3. Only when there is nothing coherent to preserve is the mode DERIVED
  //      from where the stock numbers are — the same rule the product form
  //      computes in `deriveInventoryMode`, which is what stopped every
  //      TXT-born product tracking at BASE (docs/TXT_IMPORT_PARITY.md, root
  //      cause 3).
  const remainingVariants = variantInputs.length + retainedVariants.length;
  const derivedMode: InventoryMode = colorInputs.some((c) => c.stock !== null)
    ? 'COLOR'
    : valueInputs.some((v) => v.stock !== null)
      ? 'OPTION'
      : 'BASE';
  const preservedMode: InventoryMode | null =
    snap.inventoryMode === 'VARIANT_COMBINATION'
      ? remainingVariants > 0
        ? 'VARIANT_COMBINATION'
        : null
      : snap.inventoryMode === 'COLOR'
        ? colorInputs.length > 0
          ? 'COLOR'
          : null
        : snap.inventoryMode === 'OPTION'
          ? valueInputs.length > 0
            ? 'OPTION'
            : null
          : null;
  const mode: InventoryMode = isInventoryMode(body.inventory_mode)
    ? body.inventory_mode
    : (preservedMode ?? derivedMode);
  if (!isInventoryMode(body.inventory_mode) && preservedMode === null && snap.inventoryMode !== derivedMode) {
    warnings.push(
      `inventory_mode moved from ${snap.inventoryMode} to ${derivedMode} — the stock level it named has no rows left / تغيّر مستوى المخزون`
    );
  }

  // THE GUARD IS ABOUT WHAT WILL REMAIN, not about what is stored today. A
  // save that deletes the last combination of a VARIANT_COMBINATION product
  // leaves it unsellable (worker/lib/inventory.ts answers VARIANT_NOT_MODELLED
  // for every selection), so it is refused rather than reported as a success.
  if (mode === 'VARIANT_COMBINATION' && remainingVariants === 0) {
    errors.push('inventory_mode=VARIANT_COMBINATION needs at least one modelled combination, or nothing can be sold');
  }

  // ---- an id must not belong to a DIFFERENT product ----------------------
  //
  // The upserts below key on id, so a payload naming another product's group,
  // colour or image would silently re-parent it — and, when two products
  // reuse an id, collide on product_color_option_links' primary key and
  // surface as a 500 instead of a message. Both are refused here by name.
  const claimed: Array<{ table: string; ids: string[]; label: string }> = [
    { table: 'product_option_groups', ids: [...groupIds], label: 'option group' },
    { table: 'product_option_values', ids: [...valueIds], label: 'option value' },
    { table: 'product_colors', ids: [...colorIds], label: 'colour' },
    { table: 'product_variants', ids: variantInputs.map((v) => v.id), label: 'variant' },
    { table: 'product_images', ids: imageInputs.map((i) => i.id), label: 'image' },
  ];
  for (const { table, ids, label } of claimed) {
    for (const chunk of chunked(ids)) {
      const ph = chunk.map(() => '?').join(', ');
      const { results: foreign } = await db
        .prepare(`SELECT id FROM ${table} WHERE id IN (${ph}) AND product_id <> ?`)
        .bind(...chunk, productId)
        .all<{ id: string }>();
      for (const row of foreign) {
        errors.push(`${label} id "${row.id}" already belongs to another product`);
      }
    }
  }

  // ---- a variant SKU is unique across the STORE --------------------------
  const skus = [...new Set(variantInputs.map((v) => v.sku).filter((x): x is string => !!x))];
  for (const chunk of chunked(skus)) {
    const ph = chunk.map(() => '?').join(', ');
    const { results: taken } = await db
      .prepare(
        `SELECT v.sku, COALESCE(NULLIF(p.name_ar,''), p.name, v.product_id) AS owner
           FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE v.sku IN (${ph}) AND v.product_id <> ?`
      )
      .bind(...chunk, productId)
      .all<{ sku: string; owner: string }>();
    for (const row of taken) {
      errors.push(`Combination SKU "${row.sku}" is already used by "${row.owner}" — a SKU is unique across the store`);
    }
  }

  if (errors.length) return { errors: [...new Set(errors)] };

  // ---- the statements, run as ONE batch by the caller ---------------------
  const stmts: D1PreparedStatement[] = [];

  stmts.push(db.prepare('UPDATE products SET inventory_mode = ? WHERE id = ?').bind(mode, productId));

  /**
   * 0043 — THE PRODUCT FOLLOWS ITS OPTIONS. `sale_types` decides real things
   * downstream (order stages, shipping type, transport choice), so it is
   * DERIVED from the options here rather than validated against them. A
   * product whose options all stay silent keeps exactly what it declared.
   */
  const declaredSaleTypes = deriveSaleTypes(
    valueInputs.map((v) => ({
      availability_type: normalizeAvailability(v.availability_type),
      active: v.active === 1,
    })),
    snap.saleTypes
  );
  if (declaredSaleTypes.join(',') !== snap.saleTypes.join(',')) {
    stmts.push(
      db
        .prepare('UPDATE products SET sale_types = ?, selling_type = ? WHERE id = ?')
        .bind(
          JSON.stringify(declaredSaleTypes),
          // The CHECK on selling_type only admits the three original words.
          declaredSaleTypes.find((t) => t === 'direct_sale' || t === 'pre_order' || t === 'bundle') ?? 'direct_sale',
          productId
        )
    );
  }

  // Links are rebuilt wholesale; they are pure join rows with no state.
  stmts.push(
    db
      .prepare(
        'DELETE FROM product_color_option_links WHERE color_id IN (SELECT id FROM product_colors WHERE product_id = ?)'
      )
      .bind(productId)
  );

  // Remove rows the payload dropped. Images and links first so no foreign key
  // points at a row that is about to disappear.
  const del = (table: string, keep: Set<string>, rows: Array<{ id: string }>) => {
    for (const r of rows) {
      if (!keep.has(r.id)) stmts.push(db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(r.id));
    }
  };
  del('product_images', new Set(imageInputs.map((i) => i.id)), snap.existingImages);
  const retainedVariantIds = new Set(retainedVariants.map((v) => v.id));
  for (const v of snap.existingVariants) {
    if (keptVariants.has(v.id)) continue;
    if (retainedVariantIds.has(v.id)) stmts.push(db.prepare('UPDATE product_variants SET active = 0 WHERE id = ?').bind(v.id));
    else stmts.push(db.prepare('DELETE FROM product_variants WHERE id = ?').bind(v.id));
  }

  /**
   * THE GROUPS AND VALUES ARE WRITTEN BEFORE THE OLD ONES ARE DROPPED.
   *
   * `product_option_values.group_id REFERENCES product_option_groups(id) ON
   * DELETE CASCADE` (migration 0018). Deleting an emptied group BEFORE the
   * kept values had been re-pointed cascaded over a value that is still
   * stored, and the upsert that followed re-created it — with `reserved` back
   * at its DEFAULT 0, because the writer never names that column. Units
   * promised to live orders vanished from the counter on an ordinary
   * "move this option into another group" edit, with a 200 and no warning.
   *
   * Writing the groups first (so a new group exists for the FK) and then the
   * values (so every kept value already points at its new group) means the
   * group DELETE below can only cascade over rows that are being deleted
   * anyway — and a kept value is never deleted at all, so `reserved` and
   * `stock` are untouched by the writer. Nothing else depends on the order:
   * links were removed above and are rebuilt after the colours.
   */
  for (const g of groupInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_option_groups (id, product_id, name_en, sort, active)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name_en = excluded.name_en, sort = excluded.sort, active = excluded.active`
        )
        .bind(g.id, productId, g.name_en, g.sort, g.active)
    );
  }

  for (const v of valueInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_option_values
             (id, product_id, group_id, name_en, sku_part, image, sort, active, stock, low_stock_threshold,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
              regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd,
              availability_type, lead_time_text, lead_time_min_days, lead_time_max_days,
              variant_key, variant_label, name_ar, name_ckb)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             group_id = excluded.group_id, name_en = excluded.name_en, sku_part = excluded.sku_part,
             image = excluded.image, sort = excluded.sort, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd,
             regular_adjust_iqd = excluded.regular_adjust_iqd,
             prime_adjust_iqd = excluded.prime_adjust_iqd,
             pro_adjust_iqd = excluded.pro_adjust_iqd,
             availability_type = excluded.availability_type,
             lead_time_text = excluded.lead_time_text,
             lead_time_min_days = excluded.lead_time_min_days,
             lead_time_max_days = excluded.lead_time_max_days,
             variant_key = excluded.variant_key,
             variant_label = excluded.variant_label,
             -- 0055: preserved when the client did not send them.
             name_ar = CASE WHEN ? THEN excluded.name_ar ELSE product_option_values.name_ar END,
             name_ckb = CASE WHEN ? THEN excluded.name_ckb ELSE product_option_values.name_ckb END${money ? ', cost_iqd = excluded.cost_iqd, cost_adjust_iqd = excluded.cost_adjust_iqd' : ''}`
        )
        .bind(
          v.id, productId, v.group_id, v.name_en, v.sku_part, v.image, v.sort, v.active,
          v.stock, v.low_stock_threshold,
          v.prices.regular_price_iqd, v.prices.prime_price_iqd, v.prices.pro_price_iqd,
          money ? v.prices.cost_iqd : null,
          v.prices.regular_adjust_iqd, v.prices.prime_adjust_iqd, v.prices.pro_adjust_iqd,
          money ? v.prices.cost_adjust_iqd : null,
          v.availability_type, v.lead_time_text, v.lead_time_min_days, v.lead_time_max_days,
          v.variant_key, v.variant_label,
          v.name_ar ?? '', v.name_ckb ?? '',
          v.name_ar === undefined ? 0 : 1, v.name_ckb === undefined ? 0 : 1
        )
    );
  }

  // Now the rows the payload dropped. A value or colour an open order names is
  // deactivated rather than deleted, exactly as a variant is.
  const retainedValueIds = new Set(retainedValues.map((v) => v.id));
  const retainedGroupIds = new Set(retainedValues.map((v) => v.group_id).filter((gid) => !groupIds.has(gid)));
  for (const v of existing.values) {
    if (keptValues.has(v.id)) continue;
    if (retainedValueIds.has(v.id)) {
      stmts.push(db.prepare('UPDATE product_option_values SET active = 0 WHERE id = ?').bind(v.id));
    } else {
      stmts.push(db.prepare('DELETE FROM product_option_values WHERE id = ?').bind(v.id));
    }
  }
  const retainedColorIds = new Set(retainedColors.map((c) => c.id));
  for (const col of existing.colors) {
    if (keptColors.has(col.id)) continue;
    if (retainedColorIds.has(col.id)) {
      stmts.push(db.prepare('UPDATE product_colors SET active = 0 WHERE id = ?').bind(col.id));
    } else {
      stmts.push(db.prepare('DELETE FROM product_colors WHERE id = ?').bind(col.id));
    }
  }
  // Only groups that no surviving value points at any more: every kept value
  // was re-pointed by the upsert above, so the CASCADE can reach nothing live.
  // A group a RETAINED value still belongs to is deactivated rather than
  // deleted — dropping it would cascade over the very row the live order
  // needs, which is the same defect one level up.
  for (const g of existing.groups) {
    if (groupIds.has(g.id)) continue;
    if (retainedGroupIds.has(g.id)) stmts.push(db.prepare('UPDATE product_option_groups SET active = 0 WHERE id = ?').bind(g.id));
    else stmts.push(db.prepare('DELETE FROM product_option_groups WHERE id = ?').bind(g.id));
  }

  for (const col of colorInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_colors
             (id, product_id, name_en, hex, image, sku_part, sort, active, stock, low_stock_threshold,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
              regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd, name_ar, name_ckb)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name_en = excluded.name_en, hex = excluded.hex, image = excluded.image,
             sku_part = excluded.sku_part, sort = excluded.sort, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd,
             regular_adjust_iqd = excluded.regular_adjust_iqd,
             prime_adjust_iqd = excluded.prime_adjust_iqd,
             pro_adjust_iqd = excluded.pro_adjust_iqd,
             name_ar = CASE WHEN ? THEN excluded.name_ar ELSE product_colors.name_ar END,
             name_ckb = CASE WHEN ? THEN excluded.name_ckb ELSE product_colors.name_ckb END${money ? ', cost_iqd = excluded.cost_iqd, cost_adjust_iqd = excluded.cost_adjust_iqd' : ''}`
        )
        .bind(
          col.id, productId, col.name_en, col.hex, col.image, col.sku_part, col.sort, col.active,
          col.stock, col.low_stock_threshold,
          col.prices.regular_price_iqd, col.prices.prime_price_iqd, col.prices.pro_price_iqd,
          money ? col.prices.cost_iqd : null,
          col.prices.regular_adjust_iqd, col.prices.prime_adjust_iqd, col.prices.pro_adjust_iqd,
          money ? col.prices.cost_adjust_iqd : null,
          col.name_ar ?? '', col.name_ckb ?? '',
          col.name_ar === undefined ? 0 : 1, col.name_ckb === undefined ? 0 : 1
        )
    );
    for (const valueId of col.linked) {
      const groupId = groupOfValue.get(valueId)!;
      stmts.push(
        db
          .prepare(
            // OR IGNORE: the same value listed twice in one payload is a
            // harmless client slip, not a reason to fail the whole save.
            'INSERT OR IGNORE INTO product_color_option_links (color_id, option_value_id, group_id) VALUES (?, ?, ?)'
          )
          .bind(col.id, valueId, groupId)
      );
    }
  }

  for (const v of variantInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_variants
             (id, product_id, combo_key, sku, active, stock, low_stock_threshold,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             combo_key = excluded.combo_key, sku = excluded.sku, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd${money ? ', cost_iqd = excluded.cost_iqd' : ''}`
        )
        .bind(
          v.id, productId, v.combo_key, v.sku, v.active, v.stock, v.low_stock_threshold,
          v.prices.regular_price_iqd, v.prices.prime_price_iqd, v.prices.pro_price_iqd,
          money ? v.prices.cost_iqd : null
        )
    );
  }

  // Clear the old primary BEFORE writing the new one: the partial unique index
  // idx_product_images_primary would otherwise reject the batch.
  stmts.push(db.prepare('UPDATE product_images SET is_primary = 0 WHERE product_id = ?').bind(productId));
  for (const img of imageInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_images
             (id, product_id, url, alt_en, sort_order, is_primary, option_value_id, color_id, variant_id,
              width, height, bytes, content_type, alt_ar, alt_ckb, r2_key, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             url = excluded.url, alt_en = excluded.alt_en, sort_order = excluded.sort_order,
             is_primary = excluded.is_primary, option_value_id = excluded.option_value_id,
             color_id = excluded.color_id, variant_id = excluded.variant_id,
             width = excluded.width, height = excluded.height, bytes = excluded.bytes,
             content_type = excluded.content_type,
             -- 0048: written only when the client SENT the field (an explicit
             -- flag per field, so '' can clear); preserved otherwise.
             alt_ar = CASE WHEN ? THEN excluded.alt_ar ELSE product_images.alt_ar END,
             alt_ckb = CASE WHEN ? THEN excluded.alt_ckb ELSE product_images.alt_ckb END,
             r2_key = CASE WHEN ? THEN excluded.r2_key ELSE product_images.r2_key END,
             source_url = CASE WHEN ? THEN excluded.source_url ELSE product_images.source_url END`
        )
        .bind(
          img.id, productId, img.url, img.alt_en, img.sort_order, img.is_primary,
          img.option_value_id, img.color_id, img.variant_id,
          img.width, img.height, img.bytes, img.content_type,
          img.alt_ar ?? '', img.alt_ckb ?? '', img.r2_key ?? '', img.source_url ?? '',
          img.alt_ar === undefined ? 0 : 1,
          img.alt_ckb === undefined ? 0 : 1,
          img.r2_key === undefined ? 0 : 1,
          img.source_url === undefined ? 0 : 1
        )
    );
  }

  if (facetIds !== null) {
    stmts.push(db.prepare('DELETE FROM product_facets WHERE product_id = ?').bind(productId));
    for (const f of facetIds) {
      stmts.push(
        db
          .prepare('INSERT OR IGNORE INTO product_facets (product_id, facet_id) VALUES (?, ?)')
          .bind(productId, f)
      );
    }
  }

  const requested: RequestedRelations = {
    inventory_mode: mode,
    groups: [
      ...groupInputs.map(({ values: _v, ...g }) => {
        void _v;
        return g;
      }),
      // Kept alive because a value a live order names still belongs to it.
      ...existing.groups
        .filter((g) => retainedGroupIds.has(g.id))
        .map((g) => ({ id: g.id, name_en: g.name_en, sort: g.sort, active: 0, retained: true })),
    ],
    values: [
      ...valueInputs,
      // Kept alive for an open order: still a stored row, now inactive.
      ...retainedValues.map((v) => ({
        id: v.id,
        group_id: v.group_id,
        name_en: v.name_en,
        sku_part: '',
        image: '',
        sort: v.sort,
        active: 0,
        stock: v.stock,
        low_stock_threshold: null,
        prices: readPrices({}, 'retained'),
        availability_type: '',
        lead_time_text: '',
        lead_time_min_days: null,
        lead_time_max_days: null,
        variant_key: '',
        variant_label: '',
        retained: true,
      })),
    ],
    colors: [
      ...colorInputs,
      ...retainedColors.map((col) => ({
        id: col.id,
        name_en: col.name_en,
        hex: col.hex,
        image: '',
        sku_part: '',
        sort: col.sort,
        active: 0,
        stock: col.stock,
        low_stock_threshold: null,
        prices: readPrices({}, 'retained'),
        linked: [] as string[],
        retained: true,
      })),
    ],
    variants: [
      ...variantInputs,
      // Kept alive for an open order: still a stored row, now inactive.
      ...retainedVariants.map((v) => ({
        id: v.id,
        combo_key: v.combo_key,
        sku: null,
        active: 0,
        stock: v.stock,
        low_stock_threshold: null,
        prices: readPrices({}, 'retained'),
        retained: true,
      })),
    ],
    images: imageInputs,
    facet_ids: facetIds,
  };

  return {
    errors: [] as never[],
    stmts,
    mode,
    warnings,
    requested,
    summary: {
      inventory_mode: mode,
      groups: groupInputs.length + retainedGroupIds.size,
      values: valueInputs.length + retainedValues.length,
      colors: colorInputs.length + retainedColors.length,
      links: colorInputs.reduce((n, x) => n + x.linked.length, 0),
      variants: variantInputs.length + retainedVariants.length,
      images: imageInputs.length,
      primary_image: imageInputs.find((i) => i.is_primary === 1)?.id ?? null,
      facets: facetIds === null ? 'preserved' : facetIds.length,
      cost_written: money,
    },
  };
}

/**
 * THE JSON MIRROR IS A DERIVED ARTEFACT, NEVER A CALLER-SUPPLIED FIELD.
 *
 * `products.options / colors / images` are the pre-0018 copy of the structure.
 * Nothing reads them once a product has relation rows — but the moment the
 * LAST row is gone, `applyRelations` falls back to them, and a stale copy
 * resurrects the very options, colours and pictures the admin just deleted
 * (docs/TXT_IMPORT_PARITY.md). The form used to POST the whole document
 * (whose `options` it had just read back FROM the rows) one request before the
 * PUT that emptied those rows, so the mirror always survived them.
 *
 * So the mirror is built here from the rows the SAME batch is about to write,
 * through the same overlay the admin GET and the storefront read with. Two
 * consequences fall out for free: a TXT create and a form create leave an
 * identical `products` row for identical structure, and an emptied structure
 * empties the mirror instead of outliving it.
 *
 * The fields a payload may legally omit (0048 image provenance, 0055 option
 * and colour names, and every cost when the actor has no financial scope) are
 * resolved against the STORED row, because that is what the writer preserves.
 */
function plannedRelationsView(
  req: RequestedRelations,
  snap: RelationsSnapshot,
  productId: string,
  money: boolean
): ProductRelationsView {
  const storedValue = new Map(snap.existing.values.map((v) => [v.id, v]));
  const storedColor = new Map(snap.existing.colors.map((c) => [c.id, c]));
  const storedImage = new Map(snap.existingImages.map((i) => [i.id, i]));
  const keep = (given: string | undefined, stored: string | null | undefined): string =>
    given !== undefined ? given : stored ?? '';
  const cost = (given: number | null, stored: number | null | undefined): number | null =>
    money ? given : stored ?? null;

  return {
    has_relations: req.groups.length > 0 || req.values.length > 0 || req.colors.length > 0 || req.images.length > 0,
    inventory_mode: req.inventory_mode,
    groups: req.groups.map((g) => ({ ...g, product_id: productId })),
    values: req.values.map((v) => {
      const stored = storedValue.get(v.id);
      return {
        id: v.id,
        product_id: productId,
        group_id: v.group_id,
        name_en: v.name_en,
        name_ar: keep(v.name_ar, stored?.name_ar),
        name_ckb: keep(v.name_ckb, stored?.name_ckb),
        sku_part: v.sku_part,
        image: v.image,
        sort: v.sort,
        active: v.active,
        stock: v.stock,
        reserved: stored?.reserved ?? 0,
        low_stock_threshold: v.low_stock_threshold,
        regular_price_iqd: v.prices.regular_price_iqd,
        prime_price_iqd: v.prices.prime_price_iqd,
        pro_price_iqd: v.prices.pro_price_iqd,
        cost_iqd: cost(v.prices.cost_iqd, stored?.cost_iqd),
        regular_adjust_iqd: v.prices.regular_adjust_iqd,
        prime_adjust_iqd: v.prices.prime_adjust_iqd,
        pro_adjust_iqd: v.prices.pro_adjust_iqd,
        cost_adjust_iqd: cost(v.prices.cost_adjust_iqd, stored?.cost_adjust_iqd),
        availability_type: v.availability_type,
        lead_time_text: v.lead_time_text,
        lead_time_min_days: v.lead_time_min_days,
        lead_time_max_days: v.lead_time_max_days,
        variant_key: v.variant_key,
        variant_label: v.variant_label,
      };
    }),
    colors: req.colors.map((c) => {
      const stored = storedColor.get(c.id);
      return {
        id: c.id,
        product_id: productId,
        name_en: c.name_en,
        name_ar: keep(c.name_ar, stored?.name_ar),
        name_ckb: keep(c.name_ckb, stored?.name_ckb),
        hex: c.hex,
        image: c.image,
        sku_part: c.sku_part,
        sort: c.sort,
        active: c.active,
        stock: c.stock,
        reserved: stored?.reserved ?? 0,
        low_stock_threshold: c.low_stock_threshold,
        regular_price_iqd: c.prices.regular_price_iqd,
        prime_price_iqd: c.prices.prime_price_iqd,
        pro_price_iqd: c.prices.pro_price_iqd,
        cost_iqd: cost(c.prices.cost_iqd, stored?.cost_iqd),
        regular_adjust_iqd: c.prices.regular_adjust_iqd,
        prime_adjust_iqd: c.prices.prime_adjust_iqd,
        pro_adjust_iqd: c.prices.pro_adjust_iqd,
        cost_adjust_iqd: cost(c.prices.cost_adjust_iqd, stored?.cost_adjust_iqd),
      };
    }),
    links: req.colors.flatMap((c) =>
      c.linked.map((valueId) => ({
        color_id: c.id,
        option_value_id: valueId,
        group_id: req.values.find((v) => v.id === valueId)?.group_id ?? '',
      }))
    ),
    variants: [],
    // The (model x order type) cells are not part of the STRUCTURE payload —
    // they are written by their own endpoint — so the planned mirror carries
    // whatever the product already has rather than inventing or dropping them.
    fulfillments: snap.existing.fulfillments,
    transports: snap.existing.transports,
    images: req.images.map((i) => {
      const stored = storedImage.get(i.id);
      return {
        id: i.id,
        product_id: productId,
        url: i.url,
        alt_en: i.alt_en,
        sort_order: i.sort_order,
        is_primary: i.is_primary,
        option_value_id: i.option_value_id,
        color_id: i.color_id,
        variant_id: i.variant_id,
        width: i.width,
        height: i.height,
        bytes: i.bytes,
        content_type: i.content_type,
        alt_ar: keep(i.alt_ar, stored?.alt_ar),
        alt_ckb: keep(i.alt_ckb, stored?.alt_ckb),
        r2_key: keep(i.r2_key, stored?.r2_key),
        source_url: keep(i.source_url, stored?.source_url),
      };
    }),
  };
}

/** Overwrites `doc.options / colors / media` with the planned rows. Called
 *  from `planProductSave` BEFORE `serializeDoc`, so the row that lands in the
 *  same batch as the relations already mirrors them. */
function applyPlannedMirror(doc: ProductDoc, req: RequestedRelations, snap: RelationsSnapshot, money: boolean): void {
  const view = plannedRelationsView(req, snap, doc.id, money);
  const overlaid = view.has_relations ? applyRelations(doc, view, { includeInactive: true, authoredNames: true }) : null;
  doc.options = overlaid ? overlaid.options : [];
  doc.colors = overlaid ? overlaid.colors : [];
  // `applyRelations` keeps the document's own media when the view carries no
  // image row (a product whose pictures live only in JSON). Here the view IS
  // the plan, so no image row means the plan deleted them all.
  doc.media = overlaid && req.images.length > 0 ? overlaid.media : [];
}

// =========================================================================
// 2. Dependent rows: catalogs, price history, hashtags
// =========================================================================

/** product_catalogs → exactly `catalogIds`. Existing memberships keep their
 *  position; new ones append at MAX(position)+1 within their catalog. Throws
 *  400 on an unknown catalog id. */
async function planCatalogs(db: D1Database, productId: string, catalogIds: string[]): Promise<{ stmts: D1PreparedStatement[]; ids: string[] }> {
  const wanted = [...new Set(catalogIds.map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  if (wanted.length) {
    const ph = wanted.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT id FROM catalogs WHERE id IN (${ph})`)
      .bind(...wanted)
      .all<{ id: string }>();
    const known = new Set(results.map((r) => r.id));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length) throw badRequest(`catalog_ids: unknown catalog "${missing[0]}"`);
  }
  const { results: current } = await db
    .prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ?')
    .bind(productId)
    .all<{ catalog_id: string }>();
  const have = new Set(current.map((r) => r.catalog_id));
  const wantSet = new Set(wanted);
  const stmts: D1PreparedStatement[] = [];
  for (const cid of have) {
    if (!wantSet.has(cid)) {
      stmts.push(db.prepare('DELETE FROM product_catalogs WHERE product_id = ? AND catalog_id = ?').bind(productId, cid));
    }
  }
  for (const cid of wanted) {
    if (!have.has(cid)) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO product_catalogs (product_id, catalog_id, position)
             VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM product_catalogs WHERE catalog_id = ?))`
          )
          .bind(productId, cid, cid)
      );
    }
  }
  return { stmts, ids: wanted };
}

// 'compare_at' is retired from the product form (mandate §4) but stays a
// legal value in the table so historic rows remain readable; new rows only
// ever use these four.
export type HistoryField = 'regular' | 'prime' | 'pro' | 'cost';

export interface PriceDelta {
  variant_key: string; // '' | option:<id> | color:<id>
  field: HistoryField;
  old_iqd: number | null;
  new_iqd: number | null;
}

interface PriceFields2 {
  id: string;
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
}

/**
 * Monetary-field diff between the stored document and the saved one — one
 * row per changed price (price_history, 0003). Feeds seven-day price
 * protection (§6.8): a drop stays inspectable even after the price moves
 * again.
 */
export function priceHistoryDeltas(prev: ProductDoc, next: ProductDoc): PriceDelta[] {
  const out: PriceDelta[] = [];
  const push = (variantKey: string, field: HistoryField, oldV: number | null, newV: number | null) => {
    if (oldV !== newV) out.push({ variant_key: variantKey, field, old_iqd: oldV, new_iqd: newV });
  };

  push('', 'regular', prev.price_iqd, next.price_iqd);
  push('', 'prime', prev.prime_price_iqd, next.prime_price_iqd);
  push('', 'pro', prev.pro_price_iqd, next.pro_price_iqd);
  push('', 'cost', prev.product_cost_iqd, next.product_cost_iqd);

  const diffGroup = (kind: 'option' | 'color', prevItems: PriceFields2[], nextItems: PriceFields2[]) => {
    const prevById = new Map(prevItems.map((x) => [x.id, x]));
    const nextById = new Map(nextItems.map((x) => [x.id, x]));
    for (const id of new Set([...prevById.keys(), ...nextById.keys()])) {
      const p = prevById.get(id) ?? null;
      const n = nextById.get(id) ?? null;
      push(`${kind}:${id}`, 'regular', p?.regular_price_iqd ?? null, n?.regular_price_iqd ?? null);
      push(`${kind}:${id}`, 'prime', p?.prime_price_iqd ?? null, n?.prime_price_iqd ?? null);
      push(`${kind}:${id}`, 'pro', p?.pro_price_iqd ?? null, n?.pro_price_iqd ?? null);
      push(`${kind}:${id}`, 'cost', p?.cost_iqd ?? null, n?.cost_iqd ?? null);
    }
  };
  diffGroup('option', prev.options, next.options);
  diffGroup('color', prev.colors, next.colors);
  return out;
}

/** Writes the rows in their own batch — for a caller with no transaction of
 *  its own (the reprice endpoint). */
export async function recordPriceHistory(db: D1Database, productId: string, actorId: string, deltas: PriceDelta[]): Promise<void> {
  const stmts = priceHistoryStatements(db, productId, actorId, deltas);
  if (stmts.length) await db.batch(stmts);
}

function priceHistoryStatements(db: D1Database, productId: string, actorId: string, deltas: PriceDelta[]): D1PreparedStatement[] {
  return deltas.map((d) =>
    db
      .prepare(
        'INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(productId, d.variant_key, d.field, d.old_iqd, d.new_iqd, actorId)
  );
}

/** The vocabulary rows a save adds — one per tag the table has never seen.
 *  Never throws: a database that has not run 0041 simply registers nothing. */
async function planHashtags(
  db: D1Database,
  tags: string[]
): Promise<{ stmts: D1PreparedStatement[]; added: string[] }> {
  const clean = dedupeHashtags(tags);
  if (clean.length === 0) return { stmts: [], added: [] };
  try {
    const { results } = await db.prepare('SELECT tag FROM hashtags').all<{ tag: string }>();
    const known = new Set(results.map((r) => hashtagKey(r.tag)));
    const added = clean.filter((tag) => !known.has(hashtagKey(tag)));
    return {
      stmts: added.map((tag) => db.prepare('INSERT OR IGNORE INTO hashtags (id, tag) VALUES (?, ?)').bind(newId('tag'), tag)),
      added,
    };
  } catch (e) {
    console.error('hashtag registration skipped', e instanceof Error ? e.message : String(e));
    return { stmts: [], added: [] };
  }
}

// =========================================================================
// 3. Localisation that respects text a human wrote
// =========================================================================

/**
 * A slot whose stored TEXT the localiser must not overwrite: a human — or a
 * TXT file, which is a human with a text editor — wrote it.
 */
const AUTHORED = new Set(['approved']);

/**
 * A slot whose stored EMPTINESS the localiser must not fill.
 *
 * `missing` on a NESTED slot (`spec_group:…:title`, `label:…`, `block:…:body`)
 * is the template path recording that the author left that Kurdish or Arabic
 * field blank on purpose. Filling it on the next form save invented text —
 * `title_ckb` '' became 'Group', `body_ckb` '' became the English body — so a
 * TXT create and a form save no longer left the same document
 * (docs/TXT_IMPORT_PARITY.md).
 *
 * TOP-LEVEL `name` and `description` are deliberately excluded: `missing`
 * there is written by `applyTranslationTracking` to mean "the English source
 * itself is empty", and §3 requires the product name to read identically in
 * all three languages, so their copy-from-English must keep working.
 */
const authoredEmpty = (key: string, status: string): boolean => status === 'missing' && key.includes(':');

/**
 * §3 localisation for the FORM path — with one rule the old save lacked: a
 * copy a human wrote survives. `localizeProductDoc` regenerates every ar/ckb
 * slot from English on every save, which wiped the Arabic a TXT file had
 * authored the first time anyone touched the product in the form
 * (docs/TXT_IMPORT_PARITY.md, root cause 10). A slot whose stored
 * `translation_meta` says `approved` — the mark the template path leaves on
 * text it imported, and the mark a future review page will leave — keeps the
 * stored text as long as its English source is unchanged. When the source
 * changed, the mark is demoted to `stale` so the regenerated text is honest
 * about being a machine's.
 *
 * Mutates `doc` (text and `translation_meta`) and returns the localiser's
 * report plus the slots it kept.
 */
export function localizeRespectingAuthored(doc: ProductDoc, prev: ProductDoc | null): LocalizeResult & { kept: string[] } {
  const prevSlots = new Map(prev ? localizableSlots(prev as unknown as Record<string, unknown>).map((s) => [s.key, s]) : []);
  const meta: TranslationMeta = {};
  for (const [k, v] of Object.entries(prev?.translation_meta ?? {})) meta[k] = { ...v };

  const result = localizeProductDoc(doc);
  const kept: string[] = [];
  for (const slot of localizableSlots(doc as unknown as Record<string, unknown>)) {
    const before = prevSlots.get(slot.key);
    const entry = meta[slot.key];
    if (!before || !entry) continue;
    const sourceChanged = slot.en !== before.en;
    for (const lang of ['ar', 'ckb'] as const) {
      const status = entry[lang]?.status;
      if (!status || !(AUTHORED.has(status) || authoredEmpty(slot.key, status))) continue;
      if (sourceChanged) {
        entry[lang] = { status: 'stale', src_rev: entry[lang]!.src_rev };
        continue;
      }
      slot.set(lang, before[lang]);
      kept.push(`${slot.key}.${lang}`);
    }
  }
  doc.translation_meta = meta;
  return { ...result, kept };
}

/** The translation inputs of a document WITHOUT localising it — the TXT path,
 *  whose file carries its own Arabic and Kurdish, still keeps the
 *  product_translations table complete. */
export function translationInputsOf(doc: ProductDoc): TranslationInput[] {
  const out: TranslationInput[] = [];
  for (const slot of localizableSlots(doc as unknown as Record<string, unknown>)) {
    if (slot.key === 'name' || slot.key.startsWith('option:') || slot.key.startsWith('color:')) continue;
    if (slot.en.trim()) out.push({ field: slot.key, source_en: slot.en });
  }
  if (doc.how_to_use && doc.how_to_use.trim()) out.push({ field: 'how_to_use', source_en: doc.how_to_use });
  return out;
}

// =========================================================================
// 4. The contract
// =========================================================================

export interface ProductWriteIntent {
  mode: 'create' | 'update';
  /** The validated document to write, or null to leave the row alone (a
   *  relations-only save). `doc.id` and `doc.slug` are already decided. */
  doc: ProductDoc | null;
  /** The stored document (row only, no overlay) on update; null on create. */
  prev: ProductDoc | null;
  /** The SAME wire body the form PUTs to /relations; null = tables untouched. */
  relations: Record<string, unknown> | null;
  /** undefined = preserve the placement. */
  catalogIds?: string[];
  actor: { adminId: string; money: boolean };
  /** Rows for product_translations; undefined = leave them. */
  translations?: TranslationInput[];
  /** Register the document's hashtags in the vocabulary (default true). */
  hashtags?: boolean;
  /** Record price_history deltas against `prev` (default true on update). */
  priceHistory?: boolean;
  /**
   * MAY THIS WRITER CREATE OR EDIT A COMPOSITION ROW (0058, §1.2)?
   *
   * A bundle and a mystery offer are `products` rows whose `stock` is NULL for
   * ever and whose availability is computed from the members' real inventory.
   * A product form, a TXT template or a CSV import that wrote one would produce
   * a sellable row with no stock, no components and no price rule — so every
   * writer is refused here (`COMPOSITION_NOT_ALLOWED`) unless it is the bundles
   * panel, which sets this flag and supplies the composition in the same plan.
   * Because every writer goes through `planProductSave`, the guard is inherited
   * rather than repeated (docs/TXT_IMPORT_PARITY.md §5.1).
   */
  allowComposition?: boolean;
}

export interface ProductSavePlan {
  productId: string;
  mode: 'create' | 'update';
  statements: D1PreparedStatement[];
  /** The document as it will be stored (after the cost gate). */
  doc: ProductDoc | null;
  relations: { mode: InventoryMode; summary: RelationsSummary; requested: RequestedRelations } | null;
  catalogIds: string[] | null;
  priceHistory: PriceDelta[];
  hashtagsRegistered: number;
  /** The vocabulary tags this save is the first to register — the rows a
   *  caller must remove if it rolls the product back. */
  hashtagsAdded: string[];
  translations: { written: number; review_needed: string[] } | null;
  /** Cost fields an actor without financial scope asked to change: refused,
   *  carried forward, and named here so a caller can report them as
   *  PRESERVED rather than applied (docs/TXT_IMPORT_PARITY.md, root cause 8). */
  costRefused: string[];
  warnings: string[];
  money: boolean;
  actorId: string;
}

/** Costs an actor without financial scope tried to change — reported, never
 *  written. Adjustments count too: a signed cost move is a cost. */
function costAttempts(doc: ProductDoc, prev: ProductDoc | null): string[] {
  const out: string[] = [];
  if ((doc.product_cost_iqd ?? null) !== (prev?.product_cost_iqd ?? null)) out.push('product_cost_iqd');
  for (const [kind, next, before] of [
    ['option', doc.options, prev?.options ?? []],
    ['color', doc.colors, prev?.colors ?? []],
  ] as const) {
    const prevById = new Map(before.map((x) => [x.id, x]));
    for (const x of next) {
      const p = prevById.get(x.id);
      if ((x.cost_iqd ?? null) !== (p?.cost_iqd ?? null)) out.push(`${kind}:${x.id}.cost_iqd`);
      if ((x.cost_adjust_iqd ?? null) !== (p?.cost_adjust_iqd ?? null)) out.push(`${kind}:${x.id}.cost_adjust_iqd`);
    }
  }
  return out;
}

/** Puts the stored costs back on a document (null where nothing is stored) so
 *  a save by an actor without financial scope can neither set nor blank one. */
function carryCostsForward(doc: ProductDoc, prev: ProductDoc | null): void {
  doc.product_cost_iqd = prev?.product_cost_iqd ?? null;
  const prevOption = new Map((prev?.options ?? []).map((o) => [o.id, o]));
  for (const o of doc.options) {
    const p = prevOption.get(o.id);
    o.cost_iqd = p?.cost_iqd ?? null;
    o.cost_adjust_iqd = p?.cost_adjust_iqd ?? null;
  }
  const prevColor = new Map((prev?.colors ?? []).map((x) => [x.id, x]));
  for (const col of doc.colors) {
    const p = prevColor.get(col.id);
    col.cost_iqd = p?.cost_iqd ?? null;
    col.cost_adjust_iqd = p?.cost_adjust_iqd ?? null;
  }
}

/**
 * Everything one save will write, as statements. Throws an HttpError for a
 * refusal that names a field (validation, an unknown catalog, a relation the
 * writer rejects — `RELATIONS_VALIDATION` with every reason listed).
 */
export async function planProductSave(db: D1Database, intent: ProductWriteIntent): Promise<ProductSavePlan> {
  const { doc, prev, actor } = intent;
  const productId = doc?.id ?? prev?.id;
  if (!productId) throw badRequest('a product id is required');
  if (intent.mode === 'create' && !doc) throw badRequest('a create needs a document');
  const warnings: string[] = [];
  const statements: D1PreparedStatement[] = [];

  // ---- 0058: composition is a door, not a field --------------------------
  //
  // §1.2's pins are applied HERE, in the one function every writer goes
  // through, rather than in the bundles panel — a pin that lives in a caller is
  // a pin the next caller forgets. `stock = NULL` is the single most important
  // invariant in the design: `saleAvailability` reads NULL as "untracked, sell
  // 99" for an ordinary product, and a bundle row that reached it with a stock
  // number, an option or a colour of its own would be sold from inventory that
  // does not exist.
  const nextComposition = doc?.composition ?? '';
  const prevComposition = prev?.composition ?? '';
  if ((nextComposition !== '' || prevComposition !== '') && !intent.allowComposition) {
    throw new HttpError(
      400,
      prevComposition !== ''
        ? 'هذا المنتج حزمة/عرض عشوائي ويُحرَّر من لوحة الحزم فقط / this product is a bundle or mystery offer and is edited from the bundles panel only'
        : 'لا يمكن إنشاء حزمة أو عرض عشوائي من هنا / a bundle or mystery offer cannot be created by this writer',
      'COMPOSITION_NOT_ALLOWED',
      { errors: [`composition: "${nextComposition || prevComposition}" is not writable here`], section: 'product', field: 'composition' }
    );
  }
  if (doc && prev && nextComposition !== prevComposition) {
    // Never silently repaired, in either direction: promoting an ordinary
    // product would strip stock it is holding, and demoting a bundle would
    // leave a stockless row that reads as "untracked → sell 99" with its
    // components still pointing at it.
    throw new HttpError(
      400,
      'لا يمكن تحويل منتج عادي إلى حزمة أو العكس / a product cannot be converted into a composition, or back',
      'COMPOSITION_NOT_ALLOWED',
      { errors: [`composition: "${prevComposition}" cannot become "${nextComposition}"`], section: 'product', field: 'composition' }
    );
  }
  if (doc && nextComposition !== '') {
    if (intent.relations && ['groups', 'colors', 'variants'].some((k) => Array.isArray((intent.relations as Record<string, unknown>)[k]) && ((intent.relations as Record<string, unknown>)[k] as unknown[]).length > 0)) {
      throw new HttpError(
        400,
        'الحزمة لا تملك خيارات أو ألوانًا خاصة بها — تنوّعها يعيش في مكوّناتها / a composition row has no options or colours of its own; its variability lives in its components',
        'COMPOSITION_NOT_ALLOWED',
        { errors: ['relations: a composition product has no option groups, colours or variants'], section: 'relations' }
      );
    }
    doc.stock = null;              // NEVER stocked — availability is computed
    doc.low_stock_threshold = null; // a warn level on a row with no stock is a lie
    doc.options = [];
    doc.colors = [];
    // 'bundle' is always sale_types[0], which IS what pins selling_type:
    // serializeDoc writes `selling_type: sale_types[0]`, so the two cannot
    // drift. A pre-order bundle keeps 'pre_order' beside it.
    doc.sale_types = doc.sale_types.includes('pre_order') ? ['bundle', 'pre_order'] : ['bundle'];
    doc.selling_type = 'bundle';
  }

  // ---- §11: cost is written by financial scope only ----------------------
  const costRefused: string[] = [];
  if (doc && !actor.money) {
    costRefused.push(...costAttempts(doc, prev));
    if (costRefused.length) {
      warnings.push(
        'الكلفة لا تُعدَّل من هذا الحساب — أُبقيت كما هي / cost is not editable by this account; the stored value was kept'
      );
    }
    carryCostsForward(doc, prev);
  }

  // ---- the product SKU is unique across the STORE ------------------------
  //
  // `idx_products_sku` is a partial UNIQUE index (migration 0018), so a
  // duplicate blew the whole batch up with a raw driver error and the admin
  // read «Something went wrong». A hand-edited or duplicated export hits this
  // constantly, and the rule for this contract is a refusal that NAMES the
  // field — exactly as the variant SKUs are already checked. The UNIQUE index
  // stays as the race backstop.
  if (doc && typeof doc.sku === 'string' && doc.sku.trim()) {
    const clash = await db
      .prepare(
        `SELECT id, COALESCE(NULLIF(name_ar,''), name, id) AS owner FROM products WHERE sku = ? AND id <> ? LIMIT 1`
      )
      .bind(doc.sku, productId)
      .first<{ id: string; owner: string }>();
    if (clash) {
      throw new HttpError(
        400,
        `sku: "${doc.sku}" is already used by "${clash.owner}" — a SKU is unique across the store / رمز المنتج مستخدم في منتج آخر`,
        'SKU_TAKEN',
        { errors: [`sku: already used by product ${clash.id}`], section: 'product', field: 'sku' }
      );
    }
  }

  // ---- relations, ALWAYS when a body is given — create included ----------
  //
  // PLANNED BEFORE THE ROW, written after it: the JSON mirror on `products` is
  // derived from these rows (`applyPlannedMirror`), so the row statement has to
  // be built once the plan is known. The batch order is unchanged — the row
  // first, then everything that references it.
  let relations: ProductSavePlan['relations'] = null;
  const relationStatements: D1PreparedStatement[] = [];
  if (intent.relations) {
    const snap =
      intent.mode === 'create'
        ? snapshotForCreate(doc!)
        : await loadRelationsSnapshot(db, productId, doc ? { ladder: ladderOf(doc), saleTypes: doc.sale_types } : {});
    // The base stock a document states must still cover what is reserved.
    if (doc && doc.stock !== null && doc.stock < snap.baseReserved) {
      throw badRequest(
        `stock: ${doc.stock} is below the ${snap.baseReserved} unit(s) reserved for live orders`,
        'RELATIONS_VALIDATION'
      );
    }
    const plan = await planRelationsWriteFrom(db, snap, intent.relations, { money: actor.money });
    if (!plan.stmts) {
      throw new HttpError(400, `تعذّر حفظ الخيارات/الألوان/الصور: ${plan.errors.join(' — ')}`, 'RELATIONS_VALIDATION', {
        errors: plan.errors,
      });
    }
    relationStatements.push(...plan.stmts);
    warnings.push(...plan.warnings);
    relations = { mode: plan.mode, summary: plan.summary, requested: plan.requested };
    if (doc) {
      applyPlannedMirror(doc, plan.requested, snap, actor.money);
    } else if (prev) {
      // A RELATIONS-ONLY WRITE STILL OWNS THE MIRROR. The form's `PUT
      // /:id/relations` sends no document, and leaving the three JSON columns
      // alone is what let a deleted option come back the moment the last row
      // was gone. The mirror is rewritten from the same planned rows, in the
      // same batch, whether or not this caller sent a document.
      const mirrored: ProductDoc = { ...prev };
      applyPlannedMirror(mirrored, plan.requested, snap, actor.money);
      const record = serializeDoc(mirrored);
      relationStatements.push(
        db
          .prepare('UPDATE products SET options = ?, colors = ?, images = ? WHERE id = ?')
          .bind(record.options, record.colors, record.images, productId)
      );
    }
  } else if (doc && prev) {
    // No relations body: the tables are untouched, so the mirror must be too.
    // A product that HAS rows keeps the copy it already has rather than
    // accepting whatever `options`/`colors`/`media` this caller happened to
    // send — the rows are the truth and only a relations write may restate it.
    const row = await db
      .prepare(
        `SELECT p.stock_reserved AS stock_reserved,
                (SELECT COUNT(*) FROM product_option_values WHERE product_id = p.id)
              + (SELECT COUNT(*) FROM product_colors WHERE product_id = p.id)
              + (SELECT COUNT(*) FROM product_images WHERE product_id = p.id) AS rows_n
           FROM products p WHERE p.id = ?`
      )
      .bind(productId)
      .first<{ stock_reserved: number | null; rows_n: number | null }>();
    const reserved = Number(row?.stock_reserved ?? 0);
    if (doc.stock !== null && doc.stock < reserved) {
      throw badRequest(`stock: ${doc.stock} is below the ${reserved} unit(s) reserved for live orders`, 'RELATIONS_VALIDATION');
    }
    if (Number(row?.rows_n ?? 0) > 0) {
      doc.options = prev.options;
      doc.colors = prev.colors;
      doc.media = prev.media;
    }
  }

  // ---- the product row ----------------------------------------------------
  if (doc) {
    const record = serializeDoc(doc);
    if (intent.mode === 'create') {
      statements.push(
        db
          .prepare(
            `INSERT INTO products (${PRODUCT_COLUMNS.join(', ')})
             VALUES (${PRODUCT_COLUMNS.map(() => '?').join(', ')})`
          )
          .bind(...PRODUCT_COLUMNS.map((k) => record[k] ?? null))
      );
    } else {
      // Explicit-column UPDATE: legacy v1 columns (shipping_methods, features,
      // membership_prices, brand text, categories, …) are not in the column
      // map, so they are preserved verbatim.
      const cols = PRODUCT_COLUMNS.filter((k) => k !== 'id');
      statements.push(
        db
          .prepare(
            `UPDATE products SET ${cols.map((k) => `${k} = ?`).join(', ')},
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE id = ?`
          )
          .bind(...cols.map((k) => record[k] ?? null), productId)
      );
    }
  }
  /**
   * 0073. THE ORDER-TYPE CELLS, IN THE SAME BATCH as the models they hang off.
   *
   * Only when the payload carried them — the form never does, so a form save
   * leaves a product's order types exactly as they were. Validation is the
   * SAME function the dedicated endpoint uses, so a file cannot express a cell
   * the API would refuse (a direct sale with a transport, a duplicate route, a
   * cell naming a model that is not on this product).
   */
  const cellStatements: D1PreparedStatement[] = [];
  if (relations?.requested) {
    const cells: unknown[] = [];
    for (const v of relations.requested.values) {
      if (!Array.isArray(v.fulfillments)) continue;
      for (const raw of v.fulfillments) {
        cells.push({ ...(raw as Record<string, unknown>), option_id: v.id });
      }
    }
    // A payload that mentions cells for ANY model replaces the whole product's
    // set, exactly as the endpoint does: the file is the statement of record
    // for what it describes.
    if (relations.requested.values.some((v) => Array.isArray(v.fulfillments))) {
      const parsed = parseFulfillmentPayload(
        { fulfillments: cells },
        new Set(relations.requested.values.map((v) => v.id))
      );
      // 0075. THE SAME HOLD-PRESERVING REPLACE THE ADMIN DOOR USES. Without
      // this, a whole-product save (a TXT import, most of all) would delete a
      // cell and re-insert it under a NEW id with `capacity_reserved` back at
      // 0 — and `inventory_ledger.scope_id` names the row that just vanished,
      // so the release for a live pre-order would match nothing and those
      // units would never come back. Read here rather than threaded in,
      // because the read is cheap, this is the only place that needs it on
      // this path, and a caller that forgets to thread it is exactly the
      // defect. Rows written before 0075 have no capacity, so this is a
      // no-op replace for them — identical to the pre-0075 behaviour.
      const [liveCells, liveRoutes] = await Promise.all([
        db
          .prepare('SELECT id, option_id, fulfillment_type, capacity_reserved FROM product_option_fulfillment WHERE product_id = ?')
          .bind(productId)
          .all<{ id: string; option_id: string; fulfillment_type: string; capacity_reserved: number | null }>(),
        db
          .prepare('SELECT id, fulfillment_id, method, capacity_reserved FROM product_option_transports WHERE product_id = ?')
          .bind(productId)
          .all<{ id: string; fulfillment_id: string; method: string; capacity_reserved: number | null }>(),
      ]);
      /**
       * AFTER the structure, never before it.
       *
       * `product_option_fulfillment.option_id` REFERENCES
       * `product_option_values(id)` (migration 0073). On a CREATE the option
       * rows are in `relationStatements`, which are appended below — so a cell
       * queued here would be inserted against a model that does not exist yet
       * and D1 would fail the whole batch with a bare FOREIGN KEY error. The
       * cells are the last thing written for the same reason the transports go
       * before the cells inside `fulfillmentStatements`: a row is written after
       * the row it names.
       */
      const existing = existingCellsFrom(liveCells.results ?? [], liveRoutes.results ?? []);
      // 0075. THE SAME REFUSALS THE ADMIN PANEL RAISES, ON THE FILE DOOR TOO.
      // A spreadsheet is the likeliest way to cut a quota below the units
      // already held, or to drop a cell that is holding some, precisely
      // because nobody reads it row by row — and either one strands a live
      // pre-order whose release would then match no row at all.
      refuseStrandedCapacity(existing, parsed);
      cellStatements.push(...fulfillmentStatements(db, productId, parsed, undefined, existing));
    }
  }

  statements.push(...relationStatements);
  statements.push(...cellStatements);

  // `inventory_mode` is not in PRODUCT_COLUMNS (the relations planner owns it),
  // so a composition row pins it here: 'BASE' is what makes `snapshotFrom`
  // return an untracked base and `resolveStock` answer `available: null` for
  // the bundle row itself. `stock_reserved` is deliberately NOT written —
  // nothing ever reserves against a bundle row.
  if (doc && nextComposition !== '') {
    statements.push(
      db.prepare("UPDATE products SET inventory_mode = 'BASE', stock = NULL WHERE id = ?").bind(productId)
    );
  }

  // ---- catalog placement --------------------------------------------------
  let catalogIds: string[] | null = null;
  if (intent.catalogIds !== undefined) {
    const cat = await planCatalogs(db, productId, intent.catalogIds);
    statements.push(...cat.stmts);
    catalogIds = cat.ids;
  }

  // ---- price history (§6.8) — every monetary change on an existing product
  let priceHistory: PriceDelta[] = [];
  if (doc && prev && intent.priceHistory !== false) {
    priceHistory = priceHistoryDeltas(prev, doc);
    statements.push(...priceHistoryStatements(db, productId, actor.adminId, priceHistory));
  }

  // ---- hashtag vocabulary -------------------------------------------------
  let hashtagsRegistered = 0;
  let hashtagsAdded: string[] = [];
  if (doc && intent.hashtags !== false) {
    const tags = await planHashtags(db, doc.hashtags);
    statements.push(...tags.stmts);
    hashtagsRegistered = tags.stmts.length;
    hashtagsAdded = tags.added;
  }

  // ---- translations -------------------------------------------------------
  let translations: ProductSavePlan['translations'] = null;
  if (intent.translations) {
    const t = await planProductTranslations(db, productId, intent.translations);
    statements.push(...t.statements);
    translations = { written: t.summary.written, review_needed: t.summary.review_needed };
  }

  // `ProductAdded` (= ProductUpserted, 03-EVENTS.md §3.3) — ONE event per saved
  // product, in the SAME batch as the product row, from the one function every
  // writer goes through (the admin form, the template apply and the import all
  // call `planProductSave`). Display facts only: never cost, never margin,
  // never a supplier price (DECISIONS rows 41/91).
  if (doc && busFor(db)) {
    const seq = nextAggregateSeq();
    const effectiveCatalogs = catalogIds ?? (await currentCatalogIds(db, productId));
    const pending = await outboxStatement(
      db,
      ProductAddedV1,
      {
        product_id: productId,
        slug: doc.slug || productId,
        status: doc.status || 'draft',
        catalog_ids: effectiveCatalogs.slice(0, 50),
        brand_id: doc.brand_id ? String(doc.brand_id) : null,
        is_printer: await anyPrinterCatalog(db, effectiveCatalogs),
        doc_version: Math.max(0, Number(doc.doc_version) || 0),
        structure_hash: await structureHash(doc),
        names: { ar: doc.name_ar, en: doc.name_en, ckb: doc.name_ckb },
        images: doc.media.map((m) => m.key || m.url).filter((k) => !!k).slice(0, 100),
        op_id: `${intent.mode}:${productId}:${seq}`,
      },
      { aggregateId: productId, actorId: actor.adminId, aggregateSeq: seq }
    );
    if (pending) statements.push(pending.statement);
  }

  return {
    productId,
    mode: intent.mode,
    statements,
    doc,
    relations,
    catalogIds,
    priceHistory,
    hashtagsRegistered,
    hashtagsAdded,
    translations,
    costRefused,
    warnings,
    money: actor.money,
    actorId: actor.adminId,
  };
}

/**
 * A fingerprint of the STRUCTURE a save produced — the option, colour and
 * variant identities, not their prices. A consumer that keeps an index uses it
 * to tell "the same shape, re-saved" from "the shape changed".
 */
async function structureHash(doc: ProductDoc): Promise<string> {
  const shape = [
    doc.options.map((o) => o.id).join(','),
    doc.colors.map((c) => c.id).join(','),
    doc.media.map((m) => m.id).join(','),
  ].join(';');
  return sha256Hex(shape);
}

/** The product's catalogue memberships when this save did not restate them. */
async function currentCatalogIds(db: D1Database, productId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ? LIMIT 50')
    .bind(productId)
    .all<{ catalog_id: string }>();
  return (results ?? []).map((r) => String(r.catalog_id));
}

/** `catalogs.is_printer_catalog` resolved at write time (03-EVENTS.md §3.3). */
async function anyPrinterCatalog(db: D1Database, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const row = await db
    .prepare(`SELECT 1 AS x FROM catalogs WHERE is_printer_catalog = 1 AND id IN (${ids.slice(0, 50).map(() => '?').join(', ')}) LIMIT 1`)
    .bind(...ids.slice(0, 50))
    .first<{ x: number }>();
  return !!row;
}

/**
 * Runs the plan as ONE batch (D1 batches are atomic — the row and its option
 * tree either both land or neither does), then writes the audit rows named
 * by the caller plus `product.relations.save` whenever relations were part of
 * the batch, so a template apply and a form save leave the same trail.
 */
export async function saveProductAtomic(
  db: D1Database,
  plan: ProductSavePlan,
  auditRows: Array<{ action: string; detail: Record<string, unknown> }> = []
): Promise<void> {
  if (plan.statements.length) await db.batch(plan.statements);
  for (const row of auditRows) await audit(db, plan.actorId, row.action, plan.productId, row.detail);
  if (plan.relations) await audit(db, plan.actorId, 'product.relations.save', plan.productId, { ...plan.relations.summary });
}

// =========================================================================
// 5. Reading back through the form's own endpoints
// =========================================================================

export interface RelationsResponse {
  product: {
    id: unknown;
    inventory_mode: unknown;
    stock: unknown;
    stock_reserved: unknown;
    low_stock_threshold: unknown;
  };
  groups: ProductRelations['groups'];
  values: ProductRelations['values'];
  colors: ProductRelations['colors'];
  links: ProductRelations['links'];
  variants: Record<string, unknown>[];
  images: Record<string, unknown>[];
  facet_ids: string[];
}

/** Exactly what `GET /api/admin/products/:id/relations` answers (before the
 *  §11 projection). */
export async function loadRelationsResponse(db: D1Database, productId: string): Promise<RelationsResponse | null> {
  const product = await db
    .prepare('SELECT id, inventory_mode, stock, stock_reserved, low_stock_threshold FROM products WHERE id = ?')
    .bind(productId)
    .first<Record<string, unknown>>();
  if (!product) return null;
  const rel = await loadProductRelations(db, productId);
  const [variants, images, facets] = await Promise.all([
    db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY combo_key').bind(productId).all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id').bind(productId).all<Record<string, unknown>>(),
    db.prepare('SELECT facet_id FROM product_facets WHERE product_id = ?').bind(productId).all<{ facet_id: string }>(),
  ]);
  return {
    product: {
      id: product.id,
      inventory_mode: product.inventory_mode,
      stock: product.stock,
      stock_reserved: product.stock_reserved,
      low_stock_threshold: product.low_stock_threshold,
    },
    groups: rel.groups,
    values: rel.values,
    colors: rel.colors,
    links: rel.links,
    variants: variants.results,
    images: images.results,
    facet_ids: facets.results.map((f) => f.facet_id),
  };
}

export interface StoredProduct {
  /** The row alone, as `parseProductRow` reads it. */
  row: ProductDoc;
  /** The relational view the storefront and the export overlay from. */
  view: ProductRelationsView;
  /** Exactly what `GET /api/admin/products-v2/:id` answers (before §11). */
  document: ProductDoc & { catalog_ids: string[] };
  /** Exactly what `GET /api/admin/products/:id/relations` answers. */
  relations: RelationsResponse;
  updated_at: string;
}

/** The product as the form's two GETs will show it. */
export async function reloadForVerification(db: D1Database, productId: string): Promise<StoredProduct | null> {
  const raw = await db.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first<Record<string, unknown>>();
  if (!raw) return null;
  const row = parseProductRow(raw);
  const view = await loadRelationsView(db, productId, raw.inventory_mode);
  const relations = await loadRelationsResponse(db, productId);
  const { results } = await db
    .prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id')
    .bind(productId)
    .all<{ catalog_id: string }>();
  return {
    row,
    view,
    document: {
      ...projectAdmin(applyRelations(row, view, { includeInactive: true, authoredNames: true })),
      catalog_ids: results.map((r) => r.catalog_id),
    },
    relations: relations!,
    updated_at: String(raw.updated_at ?? ''),
  };
}

// =========================================================================
// 6. Requested vs stored
// =========================================================================

export interface Mismatch {
  section: 'scalars' | 'options' | 'colors' | 'images' | 'variants' | 'spec' | 'catalogs' | 'inventory' | 'slug';
  key: string;
  requested: unknown;
  stored: unknown;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bit = (v: unknown): number => (v === 1 || v === true ? 1 : 0);

/**
 * Compares what the plan asked for against what the read-back returns, row by
 * row and key by key. `documentKeys` limits the scalar comparison to the
 * template keys the caller actually wrote (an omitted key was preserved, and
 * comparing it would only echo the preservation); `null` compares them all.
 */
export function verifyApplied(
  plan: ProductSavePlan,
  stored: StoredProduct,
  opts: { documentKeys: Set<string> | null; inventoryMode?: InventoryMode }
): Mismatch[] {
  const out: Mismatch[] = [];
  const money = plan.money;

  // ---- the document half --------------------------------------------------
  if (plan.doc) {
    if (plan.doc.slug !== stored.row.slug) out.push({ section: 'slug', key: 'slug', requested: plan.doc.slug, stored: stored.row.slug });
    const wanted = new Map(docToEntries(plan.doc, { includeCost: money }).map((e) => [e.key, e.value]));
    const got = new Map(docToEntries(stored.row, { includeCost: money }).map((e) => [e.key, e.value]));
    const structural = (k: string) => /^(options|colors|images)\.\d+\./.test(k);
    const inScope = (k: string) => {
      if (structural(k)) return false; // verified through the relation tables below
      if (!opts.documentKeys) return true;
      if (opts.documentKeys.has(k)) return true;
      const group = k.split('.')[0];
      return opts.documentKeys.has(group) || (k.startsWith('spec.') && opts.documentKeys.has(k));
    };
    for (const [k, v] of wanted) {
      if (!inScope(k)) continue;
      const s = got.has(k) ? got.get(k) ?? null : undefined;
      if (!same(v, s)) out.push({ section: k.startsWith('spec.') ? 'spec' : 'scalars', key: k, requested: v, stored: s ?? null });
    }
    for (const [k, v] of got) {
      if (!inScope(k) || wanted.has(k)) continue;
      out.push({ section: k.startsWith('spec.') ? 'spec' : 'scalars', key: k, requested: null, stored: v });
    }
  }

  // ---- catalogs -----------------------------------------------------------
  if (plan.catalogIds) {
    const want = [...plan.catalogIds].sort();
    const have = [...stored.document.catalog_ids].sort();
    if (!same(want, have)) out.push({ section: 'catalogs', key: 'catalogs', requested: want, stored: have });
  }

  // ---- relations, row by row ----------------------------------------------
  if (plan.relations) {
    const req = plan.relations.requested;
    const rel = stored.relations;
    if (rel.product.inventory_mode !== req.inventory_mode) {
      out.push({ section: 'inventory', key: 'inventory_mode', requested: req.inventory_mode, stored: rel.product.inventory_mode });
    }
    const miss = (section: Mismatch['section'], key: string, requested: unknown, stored: unknown) =>
      out.push({ section, key, requested, stored });
    const count = (section: Mismatch['section'], key: string, want: number, have: number) => {
      if (want !== have) miss(section, key, want, have);
    };
    count('options', 'groups', req.groups.length, rel.groups.length);
    count('options', 'values', req.values.length, rel.values.length);
    count('colors', 'colors', req.colors.length, rel.colors.length);
    count('colors', 'links', req.colors.reduce((s, c) => s + c.linked.length, 0), rel.links.length);
    count('variants', 'variants', req.variants.length, rel.variants.length);
    count('images', 'images', req.images.length, rel.images.length);

    const check = (section: Mismatch['section'], id: string, field: string, want: unknown, have: unknown) => {
      if (!same(want, have)) miss(section, `${id}.${field}`, want, have);
    };
    const byId = <T extends object>(rows: T[]) => new Map(rows.map((r) => [String((r as { id?: unknown }).id), r]));

    const groups = byId(rel.groups);
    for (const g of req.groups) {
      const s = groups.get(g.id);
      if (!s) { miss('options', g.id, 'group', null); continue; }
      check('options', g.id, 'name_en', g.name_en, s.name_en);
      check('options', g.id, 'active', g.active, bit(s.active));
      if ((g as { retained?: boolean }).retained) continue; // deactivated, nothing else written
      check('options', g.id, 'sort', g.sort, s.sort);
    }
    const values = byId(rel.values);
    for (const v of req.values) {
      const s = values.get(v.id);
      if (!s) { miss('options', v.id, 'value', null); continue; }
      check('options', v.id, 'group_id', v.group_id, s.group_id);
      check('options', v.id, 'name_en', v.name_en, s.name_en);
      // Deactivated for an open order: only `active` was written.
      if ((v as { retained?: boolean }).retained) {
        check('options', v.id, 'active', v.active, bit(s.active));
        continue;
      }
      if (v.name_ar !== undefined) check('options', v.id, 'name_ar', v.name_ar, s.name_ar ?? '');
      if (v.name_ckb !== undefined) check('options', v.id, 'name_ckb', v.name_ckb, s.name_ckb ?? '');
      check('options', v.id, 'sku_part', v.sku_part, s.sku_part);
      check('options', v.id, 'image', v.image, s.image);
      check('options', v.id, 'sort', v.sort, s.sort);
      check('options', v.id, 'active', v.active, bit(s.active));
      check('options', v.id, 'stock', v.stock, n(s.stock));
      check('options', v.id, 'low_stock_threshold', v.low_stock_threshold, n(s.low_stock_threshold));
      check('options', v.id, 'regular_price_iqd', v.prices.regular_price_iqd, n(s.regular_price_iqd));
      check('options', v.id, 'prime_price_iqd', v.prices.prime_price_iqd, n(s.prime_price_iqd));
      check('options', v.id, 'pro_price_iqd', v.prices.pro_price_iqd, n(s.pro_price_iqd));
      check('options', v.id, 'regular_adjust_iqd', v.prices.regular_adjust_iqd, n(s.regular_adjust_iqd));
      check('options', v.id, 'prime_adjust_iqd', v.prices.prime_adjust_iqd, n(s.prime_adjust_iqd));
      check('options', v.id, 'pro_adjust_iqd', v.prices.pro_adjust_iqd, n(s.pro_adjust_iqd));
      if (money) {
        check('options', v.id, 'cost_iqd', v.prices.cost_iqd, n(s.cost_iqd));
        check('options', v.id, 'cost_adjust_iqd', v.prices.cost_adjust_iqd, n(s.cost_adjust_iqd));
      }
      check('options', v.id, 'availability_type', v.availability_type, s.availability_type ?? '');
      check('options', v.id, 'lead_time_text', v.lead_time_text, s.lead_time_text ?? '');
      check('options', v.id, 'lead_time_min_days', v.lead_time_min_days, n(s.lead_time_min_days));
      check('options', v.id, 'lead_time_max_days', v.lead_time_max_days, n(s.lead_time_max_days));
      check('options', v.id, 'variant_key', v.variant_key, s.variant_key ?? '');
      check('options', v.id, 'variant_label', v.variant_label, s.variant_label ?? '');
    }
    const colors = byId(rel.colors);
    const linksOf = new Map<string, string[]>();
    for (const l of rel.links) linksOf.set(l.color_id, [...(linksOf.get(l.color_id) ?? []), l.option_value_id]);
    for (const c of req.colors) {
      const s = colors.get(c.id);
      if (!s) { miss('colors', c.id, 'colour', null); continue; }
      check('colors', c.id, 'name_en', c.name_en, s.name_en);
      if ((c as { retained?: boolean }).retained) {
        check('colors', c.id, 'active', c.active, bit(s.active));
        continue;
      }
      if (c.name_ar !== undefined) check('colors', c.id, 'name_ar', c.name_ar, s.name_ar ?? '');
      if (c.name_ckb !== undefined) check('colors', c.id, 'name_ckb', c.name_ckb, s.name_ckb ?? '');
      check('colors', c.id, 'hex', c.hex, s.hex);
      check('colors', c.id, 'image', c.image, s.image);
      check('colors', c.id, 'sku_part', c.sku_part, s.sku_part);
      check('colors', c.id, 'sort', c.sort, s.sort);
      check('colors', c.id, 'active', c.active, bit(s.active));
      check('colors', c.id, 'stock', c.stock, n(s.stock));
      check('colors', c.id, 'low_stock_threshold', c.low_stock_threshold, n(s.low_stock_threshold));
      check('colors', c.id, 'regular_price_iqd', c.prices.regular_price_iqd, n(s.regular_price_iqd));
      check('colors', c.id, 'prime_price_iqd', c.prices.prime_price_iqd, n(s.prime_price_iqd));
      check('colors', c.id, 'pro_price_iqd', c.prices.pro_price_iqd, n(s.pro_price_iqd));
      check('colors', c.id, 'regular_adjust_iqd', c.prices.regular_adjust_iqd, n(s.regular_adjust_iqd));
      check('colors', c.id, 'prime_adjust_iqd', c.prices.prime_adjust_iqd, n(s.prime_adjust_iqd));
      check('colors', c.id, 'pro_adjust_iqd', c.prices.pro_adjust_iqd, n(s.pro_adjust_iqd));
      if (money) {
        check('colors', c.id, 'cost_iqd', c.prices.cost_iqd, n(s.cost_iqd));
        check('colors', c.id, 'cost_adjust_iqd', c.prices.cost_adjust_iqd, n(s.cost_adjust_iqd));
      }
      check('colors', c.id, 'option_ids', [...c.linked].sort(), [...(linksOf.get(c.id) ?? [])].sort());
    }
    const variants = byId(rel.variants);
    for (const v of req.variants) {
      const s = variants.get(v.id);
      if (!s) { miss('variants', v.id, 'variant', null); continue; }
      check('variants', v.id, 'combo_key', v.combo_key, s.combo_key);
      check('variants', v.id, 'active', v.active, bit(s.active));
      if ((v as { retained?: boolean }).retained) continue; // deactivated, everything else untouched
      check('variants', v.id, 'sku', v.sku, s.sku ?? null);
      check('variants', v.id, 'stock', v.stock, n(s.stock));
      check('variants', v.id, 'low_stock_threshold', v.low_stock_threshold, n(s.low_stock_threshold));
      check('variants', v.id, 'regular_price_iqd', v.prices.regular_price_iqd, n(s.regular_price_iqd));
      check('variants', v.id, 'prime_price_iqd', v.prices.prime_price_iqd, n(s.prime_price_iqd));
      check('variants', v.id, 'pro_price_iqd', v.prices.pro_price_iqd, n(s.pro_price_iqd));
      if (money) check('variants', v.id, 'cost_iqd', v.prices.cost_iqd, n(s.cost_iqd));
    }
    const images = byId(rel.images);
    for (const i of req.images) {
      const s = images.get(i.id);
      if (!s) { miss('images', i.id, 'image', null); continue; }
      check('images', i.id, 'url', i.url, s.url);
      check('images', i.id, 'alt_en', i.alt_en, s.alt_en ?? '');
      if (i.alt_ar !== undefined) check('images', i.id, 'alt_ar', i.alt_ar, s.alt_ar ?? '');
      if (i.alt_ckb !== undefined) check('images', i.id, 'alt_ckb', i.alt_ckb, s.alt_ckb ?? '');
      if (i.r2_key !== undefined) check('images', i.id, 'key', i.r2_key, s.r2_key ?? '');
      if (i.source_url !== undefined) check('images', i.id, 'source_url', i.source_url, s.source_url ?? '');
      check('images', i.id, 'sort_order', i.sort_order, s.sort_order);
      check('images', i.id, 'primary', i.is_primary, bit(s.is_primary));
      check('images', i.id, 'option_value_id', i.option_value_id, s.option_value_id ?? null);
      check('images', i.id, 'color_id', i.color_id, s.color_id ?? null);
      check('images', i.id, 'variant_id', i.variant_id, s.variant_id ?? null);
      check('images', i.id, 'width', i.width, n(s.width));
      check('images', i.id, 'height', i.height, n(s.height));
    }
    if (req.facet_ids) {
      check('options', 'facets', 'facet_ids', [...req.facet_ids].sort(), [...rel.facet_ids].sort());
    }
  } else if (opts.inventoryMode && stored.relations.product.inventory_mode !== opts.inventoryMode) {
    out.push({ section: 'inventory', key: 'inventory_mode', requested: opts.inventoryMode, stored: stored.relations.product.inventory_mode });
  }

  return out;
}

/** The read-back counters an apply response carries — from the tables, never
 *  from the file. */
export function relationCounts(stored: StoredProduct) {
  const rel = stored.relations;
  const primary = rel.images.find((i) => bit(i.is_primary) === 1);
  return {
    groups: rel.groups.length,
    values: rel.values.length,
    colors: rel.colors.length,
    links: rel.links.length,
    variants: rel.variants.length,
    images: rel.images.length,
    primary_image: primary ? String(primary.id) : null,
    inventory_mode: String(rel.product.inventory_mode ?? 'BASE'),
  };
}
