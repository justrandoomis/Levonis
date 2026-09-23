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
  cellKey,
  existingCellsFrom,
  fulfillmentStatements,
  legacyShapeErrors,
  parseFulfillmentPayload,
  refuseStrandedCapacity,
  transportKey,
  type ExistingCells,
  type FulfillmentCell,
} from './optionFulfillment';
import {
  normalizeSaleTypes,
  parseProductRow,
  serializeDoc,
  projectAdmin,
  PRODUCT_COLUMNS,
  DIMENSION_FIELDS,
  type ProductDoc,
  type TranslationMeta,
} from './productModel';
import { productsHaveColumn, productsHaveConditionDoc } from './conditionProjection';
import { withClassificationPlacements } from './catalogMembership';
import { planSearchIndex, searchIndexInstalled } from './search/store';
import { toSearchDoc } from './search/document';
import {
  isValidHex,
  normalizeHex,
  loadProductRelations,
  validatePriceLadder,
  optionLaddersFor,
  type ProductRelations,
} from './productRelations';
import { comboKey, isInventoryMode, type InventoryMode } from './inventory';
import {
  applyRelations,
  isActiveProductImageRow,
  isValidProductImageQuarantine,
  loadRelationsView,
  type ImageRow,
  type ProductRelationsView,
} from './productOverlay';
import { localizeProductDoc, type LocalizeResult } from './translate/localizeProduct';
import { planProductTranslations, type TranslationInput } from './translate/store';
import { dedupeHashtags, hashtagKey } from './hashtags';
import { detachedMediaKey, enqueueMediaDetach } from './mediaRefs';
import { docToEntries } from './template';
import { localizableSlots } from './translationSlots';
import type { PhysicalDimensionOverrides } from './physicalDimensions';

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

/**
 * Relation dimensions have PATCH semantics inside an otherwise replacement
 * payload: omitted preserves the stored override; explicit NULL clears it and
 * therefore inherits; a stated value must be a positive whole number.
 */
function readPhysicalDimensionOverrides(
  value: Record<string, unknown>,
  where: string
): PhysicalDimensionOverrides {
  const out: PhysicalDimensionOverrides = {};
  for (const field of DIMENSION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const candidate = value[field];
    if (candidate === null) {
      out[field] = null;
      continue;
    }
    if (
      typeof candidate !== 'number' ||
      !Number.isFinite(candidate) ||
      !Number.isInteger(candidate) ||
      candidate <= 0 ||
      candidate > 100_000_000
    ) {
      throw badRequest(`${where}.${field}: must be a positive whole number, or null to inherit`);
    }
    out[field] = candidate;
  }
  return out;
}

function hasPhysicalDimensionInput(value: Record<string, unknown>): boolean {
  return DIMENSION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

/**
 * Rolling deploy probe. A missing table or an unreadable PRAGMA returns true
 * so the ordinary statement reports the underlying schema failure. Only an
 * existing relation table that lacks 0099's witness returns false.
 */
async function relationDimensionsInstalled(db: D1Database, table: string): Promise<boolean> {
  try {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!results || results.length === 0) return true;
    const names = new Set(results.map((column) => String(column.name)));
    return DIMENSION_FIELDS.every((field) => names.has(field));
  } catch {
    return true;
  }
}

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
  existingVariants: Array<
    { id: string; combo_key: string; reserved: number; stock: number | null; active: number } &
      PhysicalDimensionOverrides
  >;
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
      .prepare('SELECT * FROM product_variants WHERE product_id = ?')
      .bind(productId)
      .all<
        { id: string; combo_key: string; reserved: number; stock: number | null; active: number } &
          PhysicalDimensionOverrides
      >(),
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
    /** 0079. Absent = PRESERVE (the form never sends them); a string writes it,
     *  '' included — the same contract `name_ar` has carried since 0055. */
    lead_time_text_ar?: string;
    lead_time_text_ckb?: string;
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
  } & PhysicalDimensionOverrides>;
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
  } & PhysicalDimensionOverrides>;
  variants: Array<{
    id: string;
    combo_key: string;
    sku: string | null;
    active: number;
    stock: number | null;
    low_stock_threshold: number | null;
    prices: PriceInput;
  } & PhysicalDimensionOverrides>;
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
      /**
       * R2 KEYS THIS SAVE STOPS REFERENCING — the objects behind the
       * `product_images` rows the payload dropped or replaced.
       *
       * PLANNED, NOT ACTED ON, and that is the point: these statements have
       * not run yet, and a batch that rolls back leaves every one of these
       * images still on the product's page. Queueing a deletion here would
       * destroy a picture the product is still showing. The caller enqueues
       * them AFTER its batch commits (`saveProductAtomic`).
       */
      detachedMedia: string[];
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
  opts: { money: boolean; mediaMetadata?: 'authoritative' | 'deferred' }
): Promise<RelationsPlan> {
  const money = opts.money;
  const mediaMetadataDeferred = opts.mediaMetadata === 'deferred';
  const productId = snap.productId;
  const baseLadder = snap.baseLadder;
  const existing = snap.existing;
  const errors: string[] = [];
  const warnings: string[] = [];

  const [valueDimensionsInstalled, colorDimensionsInstalled, variantDimensionsInstalled] =
    await Promise.all([
      relationDimensionsInstalled(db, 'product_option_values'),
      relationDimensionsInstalled(db, 'product_colors'),
      relationDimensionsInstalled(db, 'product_variants'),
    ]);
  const requireDimensionSchema = (installed: boolean, row: Record<string, unknown>, where: string) => {
    if (installed || !hasPhysicalDimensionInput(row)) return;
    throw new HttpError(
      503,
      'تعذّر حفظ الأبعاد قبل تطبيق ترحيل قاعدة البيانات 0099 / physical dimensions require database migration 0099',
      'PHYSICAL_DIMENSIONS_MIGRATION_REQUIRED',
      { errors: [`${where}: physical-dimension columns are not installed`] }
    );
  };

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
      requireDimensionSchema(valueDimensionsInstalled, v, where);
      const prices = readPrices(v, where);
      const dimensions = readPhysicalDimensionOverrides(v, where);
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
      const id = typeof v.id === 'string' && v.id ? v.id : newId('ov');
      const legacyImage = str(v.image, `${where}.image`, { max: 500, required: false }) ?? '';
      if (legacyImage.trim()) {
        errors.push(
          `${where}.image: selector scalar images are retired; add the verified local WebP to relations.images with option_value_id="${id}"`
        );
      }
      valueInputs.push({
        id,
        group_id: g.id,
        name_en: name,
        // 0055 — absent means PRESERVE (the form never sends them), a string
        // means write it, '' included.
        name_ar: optionalText(v.name_ar, `${where}.name_ar`, 200),
        name_ckb: optionalText(v.name_ckb, `${where}.name_ckb`, 200),
        sku_part: str(v.sku_part, `${where}.sku_part`, { max: 40, required: false }) ?? '',
        // 0099 retired the scalar selector source. `product_images` is the
        // only authoritative media store, including option-bound media.
        image: '',
        sort: int(v.sort, `${where}.sort`, { min: 0, max: 10000, def: i }),
        active: v.active === false ? 0 : 1,
        stock: nullableInt(v.stock, `${where}.stock`, 10_000_000),
        low_stock_threshold: nullableInt(v.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
        prices,
        availability_type: availability,
        lead_time_text: leadText,
        lead_time_text_ar: optionalText(v.lead_time_text_ar, `${where}.lead_time_text_ar`, 200),
        lead_time_text_ckb: optionalText(v.lead_time_text_ckb, `${where}.lead_time_text_ckb`, 200),
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
        ...dimensions,
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
    const id = typeof col.id === 'string' && col.id ? col.id : newId('pc');
    requireDimensionSchema(colorDimensionsInstalled, col, where);
    const hexRaw = str(col.hex, `${where}.hex`, { max: 9 });
    if (!isValidHex(hexRaw)) {
      errors.push(`${where}.hex: must be #RGB or #RRGGBB`);
    }
    const prices = readPrices(col, where);
    const dimensions = readPhysicalDimensionOverrides(col, where);
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
    const legacyImage = str(col.image, `${where}.image`, { max: 500, required: false }) ?? '';
    if (legacyImage.trim()) {
      errors.push(
        `${where}.image: selector scalar images are retired; add the verified local WebP to relations.images with color_id="${id}"`
      );
    }
    return {
      id,
      name_en: str(col.name_en, `${where}.name_en`, { max: 80 }),
      name_ar: optionalText(col.name_ar, `${where}.name_ar`, 200),
      name_ckb: optionalText(col.name_ckb, `${where}.name_ckb`, 200),
      hex: isValidHex(hexRaw) ? normalizeHex(hexRaw) : '#000000',
      // 0099 retired the scalar selector source. Bound product_images rows
      // carry colour media and are verified before this planner runs.
      image: '',
      sku_part: str(col.sku_part, `${where}.sku_part`, { max: 40, required: false }) ?? '',
      sort: int(col.sort, `${where}.sort`, { min: 0, max: 10000, def: i }),
      active: col.active === false ? 0 : 1,
      stock: nullableInt(col.stock, `${where}.stock`, 10_000_000),
      low_stock_threshold: nullableInt(col.low_stock_threshold, `${where}.low_stock_threshold`, 10_000_000),
      prices,
      linked: [...new Set(linked)],
      ...dimensions,
    };
  });
  const colorIds = new Set(colorInputs.map((x) => x.id));
  if (colorIds.size !== colorInputs.length) errors.push('colors: duplicate colour id');

  // ---- variants ----------------------------------------------------------
  const groupOfValue = new Map(valueInputs.map((v) => [v.id, v.group_id]));
  const variantInputs: RequestedRelations['variants'] = asArray(body.variants, 'variants').map((v, i) => {
    const where = `variants[${i}]`;
    requireDimensionSchema(variantDimensionsInstalled, v, where);
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
    const dimensions = readPhysicalDimensionOverrides(v, where);
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
      ...dimensions,
    };
  });
  const variantKeys = new Set(variantInputs.map((v) => v.combo_key));
  if (variantKeys.size !== variantInputs.length) errors.push('variants: two rows describe the same combination');

  // The inventory mode is decided once every deletion is known — see below.

  // ---- images ------------------------------------------------------------
  const imageInputs: RequestedRelations['images'] = asArray(body.images, 'images').map((img, i) => {
    const where = `images[${i}]`;
    const url = str(img.url, `${where}.url`, { max: 1000 });
    const canonicalKey = url.startsWith('/files/') && url.endsWith('.webp')
      ? url.slice('/files/'.length)
      : '';
    // During the read-only structural preflight these fields are deliberately
    // ignored: the byte verifier is their authority and overwrites every one
    // before the committable plan is built. Rejecting a spoofed value here
    // would prevent the verifier from replacing it. URL/id/bindings remain
    // fully parsed because those are structural claims, not byte metadata.
    const statedContentType = mediaMetadataDeferred
      ? ''
      : (str(img.content_type, `${where}.content_type`, { max: 100, required: false }) ?? '');
    if (!mediaMetadataDeferred && statedContentType && statedContentType.toLowerCase() !== 'image/webp') {
      errors.push(`${where}.content_type: product media must be image/webp`);
    }
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
      url,
      alt_en: str(img.alt_en, `${where}.alt_en`, { max: 300, required: false }) ?? '',
      sort_order: int(img.sort_order, `${where}.sort_order`, { min: 0, max: 10000, def: i }),
      is_primary: img.is_primary === true ? 1 : 0,
      option_value_id: optionValueId,
      color_id: colorId,
      variant_id: variantId,
      // The async route verifier proves the body and R2 metadata agree. The
      // relation wire historically omitted this duplicate label, so canonical
      // local WebP media gets the proven type rather than an empty value that
      // would quarantine a valid row on read.
      content_type: statedContentType || (canonicalKey ? 'image/webp' : ''),
      // ---- 0048 -----------------------------------------------------------
      // Absent = PRESERVE what is stored (the form's relations PUT and the CSV
      // importer never send these four); present = write it, and '' clears —
      // so the template's __CLEAR__ finally reaches the row
      // (docs/TXT_IMPORT_PARITY.md, root cause 7).
      alt_ar: optionalText(img.alt_ar, `${where}.alt_ar`, 300),
      alt_ckb: optionalText(img.alt_ckb, `${where}.alt_ckb`, 300),
      // Likewise, a URL already names its key. Omitted means derive; explicit
      // '' remains an intentional provenance clear for TXT round trips.
      r2_key: mediaMetadataDeferred
        ? (canonicalKey || undefined)
        : (optionalText(img.r2_key, `${where}.r2_key`, 400) ?? (canonicalKey || undefined)),
      source_url: optionalText(img.source_url, `${where}.source_url`, 1000),
      width: mediaMetadataDeferred ? null : nullableInt(img.width, `${where}.width`, 100000),
      height: mediaMetadataDeferred ? null : nullableInt(img.height, `${where}.height`, 100000),
      bytes: mediaMetadataDeferred ? null : nullableInt(img.bytes, `${where}.bytes`, 1_000_000_000),
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

  // Quarantine is a separate, inert repair channel. The form carries these
  // rows back so an unchanged full save proves it did not forget them, but
  // they are never fed to the byte verifier, never counted for primary image
  // selection, and never become INSERT values from client claims. The stored
  // row remains authoritative until a repaired, verified active image reuses
  // its id (the active upsert then clears the quarantine bit).
  const echoedQuarantineImageIds = new Set<string>();
  if (Object.prototype.hasOwnProperty.call(body, 'quarantined_images')) {
    const quarantineRows = asArray(body.quarantined_images, 'quarantined_images');
    if (quarantineRows.length > MAX_ROWS_PER_COLLECTION) {
      errors.push(`quarantined_images: more than ${MAX_ROWS_PER_COLLECTION} rows`);
    }
    const seen = new Set<string>();
    const activeIds = new Set(imageInputs.map((image) => image.id));
    const storedById = new Map(snap.existingImages.map((image) => [image.id, image]));
    quarantineRows.forEach((image, index) => {
      const where = `quarantined_images[${index}]`;
      const id = typeof image.id === 'string' ? image.id.trim() : '';
      const url = typeof image.url === 'string' ? image.url.trim() : '';
      const key = typeof image.r2_key === 'string' ? image.r2_key.trim() : '';
      const source = typeof image.source_url === 'string' ? image.source_url.trim() : '';
      const marked = image.quarantined === true || image.quarantined === 1;
      if (!id || seen.has(id)) errors.push(`${where}: missing or duplicate quarantine id`);
      if (id) seen.add(id);
      if (id && activeIds.has(id)) errors.push(`${where}: the same id cannot be active and quarantined`);
      if (!marked || url || key || !source) {
        errors.push(`${where}: quarantine requires quarantined=true, empty url/key, and a non-empty source_url`);
        return;
      }
      const stored = storedById.get(id);
      if (!stored || isActiveProductImageRow(stored)) {
        errors.push(`${where}: quarantine row is not stored for this product`);
        return;
      }
      const storedSource = String(stored.source_url ?? '').trim() || String(stored.url ?? '').trim();
      if (source !== storedSource) {
        errors.push(`${where}.source_url: stored quarantine provenance cannot be changed`);
        return;
      }
      // This id came from the server's inert projection and passed the whole
      // cross-field/stored-source check. It is therefore part of this full
      // replacement just as an active image id is. This matters for rolling
      // legacy rows that still carry only `/files/<key>` in `url`: they are
      // unsafe to display, but an unchanged form save must not interpret the
      // active-images omission as an explicit delete.
      echoedQuarantineImageIds.add(id);
    });
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

  // ---- a model that is HOLDING PRE-ORDERED UNITS is not deletable --------
  //
  // 0075's hold does not live on the option value. `product_option_values
  // .reserved` counts units on a SHELF, and the guard above reads exactly
  // that; a pre-ordered unit is held on the (model x pre-order) cell's
  // `capacity_reserved` or on one route's, so a model can be holding ten
  // pre-orders with `reserved = 0` and look perfectly deletable.
  //
  // Delete it and SQLite's ON DELETE CASCADE (migration 0073:
  // `option_id ... REFERENCES product_option_values(id) ON DELETE CASCADE`)
  // takes the cell and its routes with it. `inventory_ledger.scope_id` then
  // names a row that no longer exists: the release for that order matches
  // nothing, the units are never given back, and no screen can show where
  // they went.
  //
  // WHY HERE AND NOT BESIDE THE CELL WRITER. `refuseStrandedCapacity` runs
  // only for a payload that MENTIONS cells, and a file that DELETES a model
  // carries no `fulfillments` key at all — the guard was reachable only by
  // the payloads that did not need it. Every writer (the form, the TXT
  // template, the CSV sheet, `options=__CLEAR__`) reaches the deletion
  // through this function, so the refusal belongs with the other deletion
  // guards, where all of them inherit it.
  //
  // A value RETAINED for a live order is DEACTIVATED rather than deleted, so
  // its cells and their holds survive and it is exempt.
  //
  // The addition below is a COUNT OF OUTSTANDING HOLDS for the sentence, not
  // a stock figure: every held unit sits on exactly one counter, and nothing
  // here resolves, sums or spends a counter.
  const retainedForOrders = new Set(retainedValues.map((v) => v.id));
  const cellOwner = new Map<string, string>();
  const heldByOption = new Map<string, number>();
  const addHeld = (optionId: string, held: number) => {
    if (held > 0) heldByOption.set(optionId, (heldByOption.get(optionId) ?? 0) + held);
  };
  for (const f of existing.fulfillments ?? []) {
    cellOwner.set(f.id, f.option_id);
    addHeld(f.option_id, Number(f.capacity_reserved ?? 0));
  }
  for (const t of existing.transports ?? []) {
    const owner = cellOwner.get(t.fulfillment_id);
    if (owner) addHeld(owner, Number(t.capacity_reserved ?? 0));
  }
  // A CONFIGURED quota that is holding nothing is not worth refusing a delete
  // over — but it must not vanish without a word either. A spreadsheet has no
  // option-id column, so RENAMING a model is modelled as delete-plus-create;
  // the cascade takes the quota with the old row and a sheet carrying no
  // fulfilment rows re-creates nothing, so the limit is simply gone and the
  // pre-order becomes unlimited. That is a silent loss, which is the one thing
  // this format promises never to do.
  const trackedByOption = new Map<string, number>();
  const noteTracked = (optionId: string, capacity: unknown) => {
    if (capacity !== null && capacity !== undefined) {
      trackedByOption.set(optionId, (trackedByOption.get(optionId) ?? 0) + 1);
    }
  };
  for (const f of existing.fulfillments ?? []) {
    if (String(f.fulfillment_type) === 'pre_order') noteTracked(f.option_id, f.capacity ?? null);
  }
  for (const t of existing.transports ?? []) {
    const owner = cellOwner.get(t.fulfillment_id);
    if (owner) noteTracked(owner, t.capacity ?? null);
  }

  for (const v of existing.values) {
    if (keptValues.has(v.id) || retainedForOrders.has(v.id)) continue;
    const held = heldByOption.get(v.id) ?? 0;
    if (held > 0) {
      errors.push(
        `Option "${v.name_en}" is holding ${held} pre-ordered unit(s) and cannot be removed — cancel or fulfil those pre-orders first / الخيار يحجز وحدات مطلوبة مسبقًا ولا يمكن حذفه`
      );
      continue;
    }
    const tracked = trackedByOption.get(v.id) ?? 0;
    if (tracked > 0) {
      warnings.push(
        `Option "${v.name_en}" was removed, and the ${tracked} pre-order capacity limit(s) it carried went with it — a model removed here is not renamed, and nothing re-creates its quota / حُذف الخيار ومعه حدود السعة المسبقة التي كان يحملها`
      );
    }
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
  const keptImageIds = new Set([
    ...imageInputs.map((i) => i.id),
    ...echoedQuarantineImageIds,
  ]);
  // Quarantined rows are provenance, not members of the active replacement
  // set. A form GET exposes them through its repair channel, but an ordinary
  // save whose active `images` array omits them must not erase their source.
  // Re-using the same id with verified active media still works: it is kept
  // here and the upsert below clears the quarantine state atomically.
  // A pre-0048 row can also be ours while carrying only `/files/<key>` and no
  // `r2_key`. It is not display-safe, but dropping it still has to remove the
  // relation and enqueue its owned object. External legacy URLs remain inert
  // provenance because `detachedMediaKey` deliberately returns null for them.
  const replaceableImageRows = snap.existingImages.filter((row) => {
    const quarantined = row.quarantined === 1 || row.quarantined === true;
    return !quarantined && (isActiveProductImageRow(row) || detachedMediaKey(row) !== null);
  });
  del('product_images', keptImageIds, replaceableImageRows);

  /**
   * THE OLD OBJECT BEHIND EVERY IMAGE ROW THIS SAVE DROPS OR REPLACES.
   *
   * Deleting the row was the whole of the old behaviour, and the bytes stayed
   * in R2 for ever — nothing in this file had ever heard of the bucket. The
   * keys are collected HERE, where the replacement/deletion is actually
   * planned, rather than re-derived later from a diff that could disagree with
   * it.
   *
   * `detachedMediaKey` returns null for an image that is not ours: the live
   * catalogue holds three rows whose `url` is an `https://` hotlink to another
   * server with an empty `r2_key`. That file belongs to someone else and must
   * never reach the deletion queue.
   *
   * A key another KEPT row of this same product still uses can appear in this
   * list — two rows may carry the same picture. That is not a defect to fix
   * here: the cleanup worker re-reads every reference immediately before it
   * touches the bucket, so a key that is still named anywhere is closed as
   * `skipped_shared` instead of deleted. Deciding it now would only be
   * deciding it too early.
  */
  const requestedImageById = new Map(imageInputs.map((image) => [image.id, image]));
  const detachedMedia: string[] = [];
  for (const row of replaceableImageRows) {
    const key = detachedMediaKey(row);
    if (!key) continue;

    const replacement = requestedImageById.get(row.id);
    if (replacement) {
      // Keeping a relation id does not necessarily keep the object behind it:
      // ImagesSection deliberately preserves the id when replacing a broken
      // image. Compare canonical keys using the exact PATCH semantics of the
      // upsert below — an omitted r2_key preserves the stored value, while an
      // explicit value (including '') replaces it and lets the URL be the
      // canonical fallback.
      const replacementKey = detachedMediaKey({
        r2_key: replacement.r2_key === undefined ? row.r2_key : replacement.r2_key,
        url: replacement.url,
      });
      if (replacementKey === key) continue;
    } else if (keptImageIds.has(row.id)) {
      continue;
    }

    if (!detachedMedia.includes(key)) detachedMedia.push(key);
  }
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

  const dimensionColumnSql = (enabled: boolean) =>
    enabled ? `, ${DIMENSION_FIELDS.join(', ')}` : '';
  const dimensionValueSql = (enabled: boolean) =>
    enabled ? `, ${DIMENSION_FIELDS.map(() => '?').join(', ')}` : '';
  const dimensionUpdateSql = (enabled: boolean, table: string) =>
    enabled
      ? DIMENSION_FIELDS.map(
          (field) =>
            `, ${field} = CASE WHEN ? THEN excluded.${field} ELSE ${table}.${field} END`
        ).join('')
      : '';
  const dimensionValues = (row: PhysicalDimensionOverrides, enabled: boolean): Array<number | null> =>
    enabled ? DIMENSION_FIELDS.map((field) => row[field] ?? null) : [];
  const dimensionFlags = (row: PhysicalDimensionOverrides, enabled: boolean): number[] =>
    enabled
      ? DIMENSION_FIELDS.map((field) =>
          Object.prototype.hasOwnProperty.call(row, field) ? 1 : 0
        )
      : [];

  for (const v of valueInputs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO product_option_values
             (id, product_id, group_id, name_en, sku_part, image, sort, active, stock, low_stock_threshold,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
              regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd,
              availability_type, lead_time_text, lead_time_min_days, lead_time_max_days,
              variant_key, variant_label, name_ar, name_ckb,
              lead_time_text_ar, lead_time_text_ckb${dimensionColumnSql(valueDimensionsInstalled)})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${dimensionValueSql(valueDimensionsInstalled)})
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
             name_ckb = CASE WHEN ? THEN excluded.name_ckb ELSE product_option_values.name_ckb END,
             -- 0079: same contract — a client that never heard of them keeps them.
             lead_time_text_ar = CASE WHEN ? THEN excluded.lead_time_text_ar ELSE product_option_values.lead_time_text_ar END,
             lead_time_text_ckb = CASE WHEN ? THEN excluded.lead_time_text_ckb ELSE product_option_values.lead_time_text_ckb END${dimensionUpdateSql(valueDimensionsInstalled, 'product_option_values')}${money ? ', cost_iqd = excluded.cost_iqd, cost_adjust_iqd = excluded.cost_adjust_iqd' : ''}`
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
          v.lead_time_text_ar ?? '', v.lead_time_text_ckb ?? '',
          ...dimensionValues(v, valueDimensionsInstalled),
          v.name_ar === undefined ? 0 : 1, v.name_ckb === undefined ? 0 : 1,
          v.lead_time_text_ar === undefined ? 0 : 1, v.lead_time_text_ckb === undefined ? 0 : 1,
          ...dimensionFlags(v, valueDimensionsInstalled)
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
      stmts.push(db.prepare("UPDATE product_option_values SET active = 0, image = '' WHERE id = ?").bind(v.id));
    } else {
      /**
       * 0075. THE DELETE ASKS THE ROW, because the CASCADE does not.
       *
       * `product_option_fulfillment.option_id` is ON DELETE CASCADE (0073), so
       * deleting a model silently takes its (model x pre-order) cell, that
       * cell's routes, and every unit they are HOLDING. The guard above is a
       * plan-time count — read before the batch — and a checkout that commits
       * in that window is invisible to it; `inventory_ledger.scope_id` would
       * then name a row that no longer exists and the release could never
       * match. `fulfillmentStatements` was taught the same lesson for its own
       * delete; this is the cascade one level up.
       *
       * Losing the admin's deletion is recoverable — they try again, and the
       * count guard names the hold. Losing a customer's units is not.
       */
      stmts.push(
        db
          .prepare(
            `DELETE FROM product_option_values
              WHERE id = ?
                AND NOT EXISTS (
                  SELECT 1 FROM product_option_fulfillment f
                   WHERE f.option_id = product_option_values.id AND f.capacity_reserved > 0)
                AND NOT EXISTS (
                  SELECT 1 FROM product_option_transports t
                    JOIN product_option_fulfillment f2 ON f2.id = t.fulfillment_id
                   WHERE f2.option_id = product_option_values.id AND t.capacity_reserved > 0)`
          )
          .bind(v.id)
      );
    }
  }
  const retainedColorIds = new Set(retainedColors.map((c) => c.id));
  for (const col of existing.colors) {
    if (keptColors.has(col.id)) continue;
    if (retainedColorIds.has(col.id)) {
      stmts.push(db.prepare("UPDATE product_colors SET active = 0, image = '' WHERE id = ?").bind(col.id));
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
              regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd, name_ar, name_ckb${dimensionColumnSql(colorDimensionsInstalled)})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${dimensionValueSql(colorDimensionsInstalled)})
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
             name_ckb = CASE WHEN ? THEN excluded.name_ckb ELSE product_colors.name_ckb END${dimensionUpdateSql(colorDimensionsInstalled, 'product_colors')}${money ? ', cost_iqd = excluded.cost_iqd, cost_adjust_iqd = excluded.cost_adjust_iqd' : ''}`
        )
        .bind(
          col.id, productId, col.name_en, col.hex, col.image, col.sku_part, col.sort, col.active,
          col.stock, col.low_stock_threshold,
          col.prices.regular_price_iqd, col.prices.prime_price_iqd, col.prices.pro_price_iqd,
          money ? col.prices.cost_iqd : null,
          col.prices.regular_adjust_iqd, col.prices.prime_adjust_iqd, col.prices.pro_adjust_iqd,
          money ? col.prices.cost_adjust_iqd : null,
          col.name_ar ?? '', col.name_ckb ?? '',
          ...dimensionValues(col, colorDimensionsInstalled),
          col.name_ar === undefined ? 0 : 1, col.name_ckb === undefined ? 0 : 1,
          ...dimensionFlags(col, colorDimensionsInstalled)
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
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd${dimensionColumnSql(variantDimensionsInstalled)})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${dimensionValueSql(variantDimensionsInstalled)})
           ON CONFLICT (id) DO UPDATE SET
             combo_key = excluded.combo_key, sku = excluded.sku, active = excluded.active,
             stock = excluded.stock, low_stock_threshold = excluded.low_stock_threshold,
             regular_price_iqd = excluded.regular_price_iqd, prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd${dimensionUpdateSql(variantDimensionsInstalled, 'product_variants')}${money ? ', cost_iqd = excluded.cost_iqd' : ''}`
        )
        .bind(
          v.id, productId, v.combo_key, v.sku, v.active, v.stock, v.low_stock_threshold,
          v.prices.regular_price_iqd, v.prices.prime_price_iqd, v.prices.pro_price_iqd,
          money ? v.prices.cost_iqd : null,
          ...dimensionValues(v, variantDimensionsInstalled),
          ...dimensionFlags(v, variantDimensionsInstalled)
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
              width, height, bytes, content_type, alt_ar, alt_ckb, r2_key, source_url,
              quarantined, quarantine_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')
           ON CONFLICT (id) DO UPDATE SET
             url = excluded.url, alt_en = excluded.alt_en, sort_order = excluded.sort_order,
             is_primary = excluded.is_primary, option_value_id = excluded.option_value_id,
             color_id = excluded.color_id, variant_id = excluded.variant_id,
             width = excluded.width, height = excluded.height, bytes = excluded.bytes,
             content_type = excluded.content_type,
             quarantined = 0, quarantine_reason = '',
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
    detachedMedia,
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
  const dimensions = (
    given: PhysicalDimensionOverrides,
    stored: PhysicalDimensionOverrides | undefined
  ): Record<(typeof DIMENSION_FIELDS)[number], number | null> =>
    Object.fromEntries(
      DIMENSION_FIELDS.map((field) => [
        field,
        Object.prototype.hasOwnProperty.call(given, field) ? given[field] ?? null : stored?.[field] ?? null,
      ])
    ) as Record<(typeof DIMENSION_FIELDS)[number], number | null>;

  return {
    has_relations: req.groups.length > 0 || req.values.length > 0 || req.colors.length > 0 || req.images.length > 0,
    // A relation payload explicitly owns the image collection even when it
    // clears it. This prevents stale products.images JSON from becoming a
    // fallback during mirror construction.
    has_image_rows: true,
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
        lead_time_text_ar: keep(v.lead_time_text_ar, stored?.lead_time_text_ar),
        lead_time_text_ckb: keep(v.lead_time_text_ckb, stored?.lead_time_text_ckb),
        lead_time_min_days: v.lead_time_min_days,
        lead_time_max_days: v.lead_time_max_days,
        variant_key: v.variant_key,
        variant_label: v.variant_label,
        ...dimensions(v, stored),
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
        ...dimensions(c, stored),
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
/**
 * A TRANSLATION THE ADMIN TYPED, KEYED BY SLOT.
 *
 * `{ 'description': { ar: '…', ckb: '…' } }`. The engine runs English → ar/ckb
 * and by §3 must never invent prose, so a description written as sentences —
 * or an English box that was filled in Arabic — can ONLY become correct if a
 * human writes the other two copies. The `approved` machinery below already
 * protected such text once it existed; until now nothing could create it from
 * the form, so the review flag pointed at a door with no handle.
 *
 * A narrow, explicitly-named channel rather than trusting every `*_ar` key in
 * the body: those are written by the localiser on every save and carried
 * verbatim by the TXT importer, and widening their meaning would change what a
 * save means for every other client.
 */
export type TranslationOverrides = Record<string, { ar?: string; ckb?: string }>;

/** Slot keys are built by `localizableSlots` from ids this code generates, so
 *  the shape is known and anything else is refused rather than trusted. */
const SLOT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/;
const OVERRIDE_MAX_FIELDS = 400;
const OVERRIDE_MAX_CHARS = 50_000;

/**
 * Parses and BOUNDS the `translation_overrides` body field. Unknown keys, a
 * prototype-polluting key, a non-string value and anything past the bounds are
 * dropped silently rather than throwing: a malformed override must never cost
 * the admin the rest of a save they spent ten minutes on.
 */
export function readTranslationOverrides(raw: unknown): TranslationOverrides | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: TranslationOverrides = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= OVERRIDE_MAX_FIELDS) break;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!SLOT_KEY_RE.test(key)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry: { ar?: string; ckb?: string } = {};
    for (const lang of ['ar', 'ckb'] as const) {
      const text = (value as Record<string, unknown>)[lang];
      if (typeof text !== 'string') continue;
      entry[lang] = text.slice(0, OVERRIDE_MAX_CHARS);
    }
    if (entry.ar === undefined && entry.ckb === undefined) continue;
    out[key] = entry;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

export function localizeRespectingAuthored(
  doc: ProductDoc,
  prev: ProductDoc | null,
  overrides?: TranslationOverrides
): LocalizeResult & { kept: string[]; authored: string[] } {
  const prevSlots = new Map(prev ? localizableSlots(prev as unknown as Record<string, unknown>).map((s) => [s.key, s]) : []);
  const meta: TranslationMeta = {};
  for (const [k, v] of Object.entries(prev?.translation_meta ?? {})) meta[k] = { ...v };

  const result = localizeProductDoc(doc);
  const kept: string[] = [];
  const authored: string[] = [];
  const srcRev = Math.max(0, Number(doc.content_rev) || 0);
  for (const slot of localizableSlots(doc as unknown as Record<string, unknown>)) {
    // 1. What this save AUTHORS wins over both the machine and the stored copy:
    //    it is the newest human statement about this slot.
    const typed = overrides?.[slot.key];
    if (typed) {
      const entry = (meta[slot.key] ??= {});
      let touched = false;
      for (const lang of ['ar', 'ckb'] as const) {
        const text = typed[lang];
        if (typeof text !== 'string') continue;
        slot.set(lang, text);
        entry[lang] = { status: 'approved', src_rev: srcRev };
        authored.push(`${slot.key}.${lang}`);
        touched = true;
      }
      // A slot whose BOTH languages were just written needs nothing from the
      // stored copy; one that had only Arabic typed still consults it for ckb.
      if (touched && typeof typed.ar === 'string' && typeof typed.ckb === 'string') continue;
    }

    // 2. Otherwise a copy a human (or a TXT file) wrote earlier survives, as
    //    long as the English it was written against has not moved.
    const before = prevSlots.get(slot.key);
    const entry = meta[slot.key];
    if (!before || !entry) continue;
    const sourceChanged = slot.en !== before.en;
    for (const lang of ['ar', 'ckb'] as const) {
      if (typeof typed?.[lang] === 'string') continue; // just authored above
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

  // A slot the admin just wrote by hand is no longer waiting for a human.
  const settled = new Set(
    Object.entries(overrides ?? {})
      .filter(([, v]) => typeof v.ar === 'string' && typeof v.ckb === 'string')
      .map(([k]) => k)
  );
  return {
    ...result,
    review_needed: result.review_needed.filter((f) => !settled.has(f)),
    review_details: result.review_details.filter((d) => !settled.has(d.field)),
    kept,
    authored,
  };
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
  /**
   * 0075. THE (MODEL x ORDER TYPE) CELLS THIS SAVE IS WRITING, PARSED, plus
   * what the rows were holding when the plan was built — so `verifyApplied`
   * can read the capacity back and prove it landed. `null` when the payload
   * said nothing about cells, which means "preserve", and there is nothing to
   * compare.
   */
  cells: { requested: FulfillmentCell[]; held: ExistingCells } | null;
  catalogIds: string[] | null;
  priceHistory: PriceDelta[];
  hashtagsRegistered: number;
  /** The vocabulary tags this save is the first to register — the rows a
   *  caller must remove if it rolls the product back. */
  hashtagsAdded: string[];
  /**
   * R2 KEYS THIS SAVE STOPS REFERENCING. Carried out of the plan so that
   * `saveProductAtomic` can queue them for removal ONCE THE BATCH HAS
   * COMMITTED — see the field of the same name on `RelationsPlan` for why the
   * ordering is not negotiable. Empty for a save that touched no images, and
   * empty for a create.
   */
  detachedMedia: string[];
  /** Search-index rows this save writes (migration 0089). Zero on a database
   *  that does not have the index yet, which is a deploy window and not an
   *  error — see the guard beside the block that fills this in. */
  searchTokens: number;
  translations: { written: number; review_needed: string[] } | null;
  /** Cost fields an actor without financial scope asked to change: refused,
   *  carried forward, and named here so a caller can report them as
   *  PRESERVED rather than applied (docs/TXT_IMPORT_PARITY.md, root cause 8). */
  costRefused: string[];
  warnings: string[];
  money: boolean;
  actorId: string;
}

/**
 * Run the complete product/relations planner as a read-only preflight.
 *
 * Product media verification deliberately acquires a durable D1 guard before
 * it returns.  A writer must therefore reject malformed relation structure
 * before it asks the verifier to protect an object, otherwise a request that
 * never commits a product can still leave catalogue-adjacent state behind.
 *
 * `planProductSave` only reads D1 and prepares (but does not execute)
 * statements.  It does mutate its request-local document while deriving the
 * relational mirror and applying write gates, so preflight it on a JSON clone
 * and discard the resulting statements.  The caller plans again after media
 * metadata has been replaced with the byte-authoritative values; that second
 * plan is the only one that may be passed to `saveProductAtomic`.
 */
export async function preflightProductSave(db: D1Database, intent: ProductWriteIntent): Promise<void> {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  await planProductSave(
    db,
    {
      ...intent,
      doc: intent.doc ? clone(intent.doc) : null,
      prev: intent.prev ? clone(intent.prev) : null,
      relations: intent.relations ? clone(intent.relations) : null,
      catalogIds: intent.catalogIds ? [...intent.catalogIds] : undefined,
      translations: intent.translations ? clone(intent.translations) : undefined,
      actor: { ...intent.actor },
    },
    { relationMediaMetadata: 'deferred' }
  );
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
/**
 * 0079 — THE LOCALISER WRITES THE DOCUMENT; THE RELATION TABLES ARE WRITTEN
 * FROM THE WIRE BODY.
 *
 * «مدة التجهيز» lives on `product_option_values` (and, since 0073, on the
 * order-type cell and each of its routes), not in the products JSON — so the
 * Arabic and Kurdish `localizeProductDoc` just generated onto `doc.options[]`
 * would reach the database on the TEMPLATE path (whose relations body is BUILT
 * from the doc) and nowhere else. The form PUTs its own relations body, typed
 * in English by an admin who by §3 never sees an ar/ckb box, so without this
 * the generated text would be computed and dropped on every form save — the
 * exact failure `how_to_use` shipped with.
 *
 * Matched by id, and only onto rows that did NOT state the field themselves: a
 * file that says `lead_time_text_ar=` is a human statement and outranks the
 * machine's. Absent on both sides stays absent, which the writer reads as
 * "preserve what is stored".
 */
export function bridgeLeadTimeTranslations(
  doc: ProductDoc | null,
  relations: Record<string, unknown> | null
): void {
  if (!doc || !relations) return;
  const groups = relations.groups;
  if (!Array.isArray(groups)) return;
  const fromDoc = new Map(doc.options.map((o) => [o.id, o]));
  for (const g of groups) {
    const values = (g as Record<string, unknown>)?.values;
    if (!Array.isArray(values)) continue;
    for (const raw of values) {
      const v = raw as Record<string, unknown>;
      const src = fromDoc.get(String(v?.id ?? ''));
      if (!src) continue;
      if (v.lead_time_text_ar === undefined && src.lead_time_text_ar !== undefined) {
        v.lead_time_text_ar = src.lead_time_text_ar;
      }
      if (v.lead_time_text_ckb === undefined && src.lead_time_text_ckb !== undefined) {
        v.lead_time_text_ckb = src.lead_time_text_ckb;
      }
      // The order-type cells beneath the model, when this save carries them.
      const cells = v.fulfillments;
      if (!Array.isArray(cells)) continue;
      for (const rawCell of cells) {
        const cell = rawCell as Record<string, unknown>;
        const srcCell = (src.fulfillments ?? []).find((f) => f.fulfillment_type === cell?.fulfillment_type);
        if (!srcCell) continue;
        if (cell.lead_time_text_ar === undefined && srcCell.lead_time_text_ar !== undefined) {
          cell.lead_time_text_ar = srcCell.lead_time_text_ar;
        }
        if (cell.lead_time_text_ckb === undefined && srcCell.lead_time_text_ckb !== undefined) {
          cell.lead_time_text_ckb = srcCell.lead_time_text_ckb;
        }
        const routes = cell.transports;
        if (!Array.isArray(routes)) continue;
        for (const rawRoute of routes) {
          const route = rawRoute as Record<string, unknown>;
          const srcRoute = (srcCell.transports ?? []).find((t) => t.method === route?.method);
          if (!srcRoute) continue;
          if (route.lead_time_text_ar === undefined && srcRoute.lead_time_text_ar !== undefined) {
            route.lead_time_text_ar = srcRoute.lead_time_text_ar;
          }
          if (route.lead_time_text_ckb === undefined && srcRoute.lead_time_text_ckb !== undefined) {
            route.lead_time_text_ckb = srcRoute.lead_time_text_ckb;
          }
        }
      }
    }
  }
}

export async function planProductSave(
  db: D1Database,
  intent: ProductWriteIntent,
  options: { relationMediaMetadata?: 'authoritative' | 'deferred' } = {}
): Promise<ProductSavePlan> {
  const { doc, prev, actor } = intent;
  const productId = doc?.id ?? prev?.id;
  if (!productId) throw badRequest('a product id is required');
  if (intent.mode === 'create' && !doc) throw badRequest('a create needs a document');
  const warnings: string[] = [];
  const statements: D1PreparedStatement[] = [];

  // The one seam where the localised document and the relations wire body are
  // both in hand. See the function's own note.
  bridgeLeadTimeTranslations(doc, intent.relations);

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
  /** Filled by the relations planner; queued for R2 removal only after commit. */
  const detachedMedia: string[] = [];
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
    const plan = await planRelationsWriteFrom(db, snap, intent.relations, {
      money: actor.money,
      mediaMetadata: options.relationMediaMetadata,
    });
    if (!plan.stmts) {
      throw new HttpError(400, `تعذّر حفظ الخيارات/الألوان/الصور: ${plan.errors.join(' — ')}`, 'RELATIONS_VALIDATION', {
        errors: plan.errors,
      });
    }
    relationStatements.push(...plan.stmts);
    warnings.push(...plan.warnings);
    detachedMedia.push(...plan.detachedMedia);
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
    /**
     * `condition_doc` (migration 0085) is dropped from the column list when the
     * live table does not have it yet, so a database one migration behind the
     * deployment can still have its prices and stock corrected. The row then
     * takes the DEFAULT the migration declares — `'{}'`, ungraded — which is
     * the only thing a product on a pre-0085 database can be.
     * See worker/lib/conditionProjection.ts for why this one asks first rather
     * than repairing on failure like the reads do.
     */
    const [hasCondition, dimensionPresence, hasGiniUrl] = await Promise.all([
      productsHaveConditionDoc(db),
      Promise.all(DIMENSION_FIELDS.map((field) => productsHaveColumn(db, field))),
      // 0104, and the same minute-long window: `gini_url` joined
      // PRODUCT_COLUMNS with the instalments feature, and a column in that
      // list is BOUND on every save. Without this probe the first deploy
      // carrying Gini answered "table products has no column named gini_url"
      // to every product save until the migration landed — an ordinary edit
      // to an ordinary product, 500ing for a field nobody had touched.
      productsHaveColumn(db, 'gini_url'),
    ]);
    /**
     * A price-only save may cross the minute before 0098 reaches the database,
     * but a STATED measurement may not be acknowledged and dropped. Probe all
     * eight (not one witness): if a non-null value targets a missing column,
     * report the migration explicitly. Null targets can be omitted safely —
     * there is no override to lose yet.
     */
    const dropped = new Set<string>();
    if (!hasCondition) dropped.add('condition_doc');
    const missingDimensions = DIMENSION_FIELDS.filter((_field, i) => !dimensionPresence[i]);
    const dimensionsThatWouldBeLost = missingDimensions.filter(
      (field) => doc.dimensions[field] !== null
    );
    if (dimensionsThatWouldBeLost.length > 0) {
      throw new HttpError(
        503,
        'تعذّر حفظ الأبعاد قبل تطبيق ترحيل قاعدة البيانات 0098 / product dimensions require database migration 0098',
        'PHYSICAL_DIMENSIONS_MIGRATION_REQUIRED',
        { errors: dimensionsThatWouldBeLost.map((field) => `${field}: column is not installed`) }
      );
    }
    for (const field of missingDimensions) dropped.add(field);
    /**
     * THE GINI LINK, UNDER THE SAME RULE AS A DIMENSION.
     *
     * Empty is the off position and the default — a product with no link
     * draws no «تريدها أقساط؟» note — so dropping the column costs nothing
     * and a price-only save crosses the deploy window untouched. A link the
     * owner actually typed is a different matter: acknowledging it at HTTP
     * 200 and storing nothing is the exact failure PRODUCT_COLUMNS' own
     * comment records twice, so that one names the migration instead.
     */
    if (!hasGiniUrl) {
      if (String(doc.gini_url ?? '') !== '') {
        throw new HttpError(
          503,
          'تعذّر حفظ رابط تطبيق جني قبل تطبيق ترحيل قاعدة البيانات 0104 / the Gini app link requires database migration 0104',
          'GINI_URL_MIGRATION_REQUIRED',
          { errors: ['gini_url: column is not installed'] }
        );
      }
      dropped.add('gini_url');
    }
    const writable = dropped.size === 0 ? PRODUCT_COLUMNS : PRODUCT_COLUMNS.filter((k) => !dropped.has(k));
    if (intent.mode === 'create') {
      statements.push(
        db
          .prepare(
            `INSERT INTO products (${writable.join(', ')})
             VALUES (${writable.map(() => '?').join(', ')})`
          )
          .bind(...writable.map((k) => record[k] ?? null))
      );
    } else {
      // Explicit-column UPDATE: legacy v1 columns (shipping_methods, features,
      // membership_prices, brand text, categories, …) are not in the column
      // map, so they are preserved verbatim.
      const cols = writable.filter((k) => k !== 'id');
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
   * THE ORDER-TYPE CELLS, IN THE SAME BATCH as the models they hang off.
   *
   * The full form and the TXT document both carry them now. Validation is the
   * SAME function the dedicated Quick Price endpoint uses, so neither door can
   * express a cell the other would refuse.
   */
  const cellStatements: D1PreparedStatement[] = [];
  let plannedCells: ProductSavePlan['cells'] = null;
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
      /**
       * DIRECT SALE ALWAYS NAMES A REAL SHELF. With no linked colours that is
       * the option row. Once colours are linked it is one exact option×colour
       * variant per link; the option's displayed number is their sum and is
       * never a second counter. Pre-order cells deliberately take no part.
       */
      const directIds = new Set(
        parsed
          .filter((cell) => cell.fulfillment_type === 'direct_sale' && cell.enabled)
          .map((cell) => cell.option_id)
      );
      const activeColors = relations.requested.colors.filter((color) => color.active !== 0);
      const activeVariants = relations.requested.variants.filter((variant) => variant.active !== 0);
      const stockErrors: string[] = [];
      /**
       * A GLOBAL COLOUR (linked to no option) IS OFFERED WITH EVERY OPTION.
       *
       * The product page lists it under each option, and the order door
       * (inventory.resolveStock, VARIANT_COMBINATION) resolves Small+Black to
       * `o:small|c:black` and answers VARIANT_NOT_MODELLED when that row is
       * absent — it never falls back to the colour-less row. So under exact
       * combinations a global colour needs its own shelf per option, exactly
       * like a linked one; demanding the colour-less shelf instead let a save
       * succeed whose Small+Black selection could never be sold direct. In the
       * other modes the colour is not a stock dimension and nothing changes.
       */
      const globalColors = activeColors.filter((color) => color.linked.length === 0);
      for (const value of relations.requested.values.filter((row) => row.active !== 0 && directIds.has(row.id))) {
        const linked = activeColors.filter(
          (color) =>
            color.linked.includes(value.id) ||
            (relations.mode === 'VARIANT_COMBINATION' && globalColors.includes(color))
        );
        if (linked.length === 0) {
          if (relations.mode === 'VARIANT_COMBINATION') {
            const shelf = activeVariants.find(
              (variant) =>
                variant.combo_key.split('|').includes(`o:${value.id}`) &&
                !variant.combo_key.split('|').some((part) => part.startsWith('c:'))
            );
            if (!shelf || shelf.stock === null) {
              stockErrors.push(`Option "${value.name_en}" needs direct-sale stock on its colour-less combination`);
            }
          } else if (value.stock === null) {
            stockErrors.push(`Option "${value.name_en}" needs direct-sale stock`);
          }
          continue;
        }
        if (relations.mode !== 'VARIANT_COMBINATION') {
          stockErrors.push(`Option "${value.name_en}" has linked colours, so direct stock must use exact combinations`);
          continue;
        }
        for (const color of linked) {
          const shelf = activeVariants.find((variant) => {
            const parts = variant.combo_key.split('|');
            return parts.includes(`o:${value.id}`) && parts.includes(`c:${color.id}`);
          });
          if (!shelf || shelf.stock === null) {
            stockErrors.push(`Colour "${color.name_en}" needs direct-sale stock for option "${value.name_en}"`);
          }
        }
      }
      if (stockErrors.length > 0) {
        throw new HttpError(
          400,
          `تعذّر حفظ مخزون البيع المباشر: ${stockErrors.join(' — ')}`,
          'RELATIONS_VALIDATION',
          { errors: stockErrors }
        );
      }
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
      // Carried to `verifyApplied`: the capacity is a NUMBER THIS SAVE WROTE,
      // and until now the read-back net compared every other written number
      // and not this one.
      plannedCells = { requested: parsed, held: existing };
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
  /**
   * A SAVE MUST NOT BE ABLE TO UNSHELVE THE PRODUCT IT IS SAVING.
   *
   * `planCatalogs` is a REPLACE: whatever is not in the list it is given is
   * deleted. The admin form initialises `catalog_ids` to `[]` and never fills
   * it from the two selects the owner actually uses — «القسم الرئيسي» and
   * «القسم الفرعي» write `category_id` and `sub_category_id` — so every save
   * posted an empty list and deleted the product's placements. The storefront
   * counts through that table, so the home page ended up with NO categories
   * at all while the admin still listed «الطابعات · 3».
   *
   * The server folds the classification back in rather than trusting the
   * client to remember it. See worker/lib/catalogMembership.ts for why a
   * classification implies a placement and this is completion rather than a
   * second source of truth. The importer is unaffected: it sends the same ids
   * already, so the union changes nothing for it.
   */
  let catalogIds: string[] | null = null;
  if (intent.catalogIds !== undefined) {
    const classified = withClassificationPlacements(
      intent.catalogIds,
      doc ?? (prev as { category_id?: unknown; sub_category_id?: unknown } | null) ?? {}
    );
    const cat = await planCatalogs(db, productId, classified);
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

  // ---- search index -------------------------------------------------------
  /**
   * THE INDEX IS WRITTEN IN THE SAME BATCH AS THE PRODUCT.
   *
   * A search index maintained in a second transaction is an index that
   * disagrees with the catalogue every time the second one fails — a product
   * that exists and cannot be found, or worse, one that was renamed and is
   * still found under its old name. So the rows ride along with the save and
   * either both land or neither does.
   *
   * The names, not the ids: a shopper types «الطابعات» and "Bambu Lab", never
   * `cat_printers` or `brd_1c09…`. Resolving them here — once, on a write —
   * costs nothing at query time and is correct for as long as the names are.
   * See worker/lib/search/document.ts for what is indexed and how heavily.
   */
  let searchTokens = 0;
  // AND ONLY WHEN THE INDEX IS THERE. A Worker reaches production without its
  // migrations on one of this shop's two deploy paths, so the table can be one
  // deploy behind the code that feeds it. A save that names it then dies, and
  // an owner who cannot correct a price because of a search index they never
  // asked about is the exact failure `deployAheadOfMigrations` exists to
  // prevent. The backfill cron indexes the product as soon as the table lands.
  if (doc && (await searchIndexInstalled(db))) {
    const nameRows = await db
      .prepare(
        `SELECT (SELECT COALESCE(NULLIF(b.name_en, ''), b.name_ar) FROM brands b WHERE b.id = ?) AS brand,
                (SELECT COALESCE(NULLIF(c.name_en, ''), c.name_ar) FROM catalogs c WHERE c.id = ?) AS main,
                (SELECT COALESCE(NULLIF(c2.name_en, ''), c2.name_ar) FROM catalogs c2 WHERE c2.id = ?) AS sub`
      )
      .bind(doc.brand_id ?? '', doc.category_id ?? '', doc.sub_category_id ?? '')
      .first<{ brand: string | null; main: string | null; sub: string | null }>();
    // Model and colour names in all three languages: "X2D Combo" is an OPTION
    // name on this shop's products, not part of the product name, so a search
    // for «كومبو» reaches nothing without them.
    const variantNames = [
      ...(doc.options ?? []).flatMap((o) => [o.name_en, o.name_ar, o.name_ckb]),
      ...(doc.colors ?? []).flatMap((c) => [c.name_en, c.name_ar, c.name_ckb]),
    ].filter((n): n is string => typeof n === 'string' && n.trim() !== '');
    const indexStmts = planSearchIndex(
      db,
      toSearchDoc({
        id: productId,
        name: doc.name_en,
        name_ar: doc.name_ar,
        name_ckb: doc.name_ckb,
        description: doc.description_en,
        hashtags: doc.hashtags,
        sku: doc.sku,
        brandName: nameRows?.brand ?? null,
        categoryNames: [nameRows?.main ?? '', nameRows?.sub ?? ''].filter(Boolean),
        variantNames,
      })
    );
    statements.push(...indexStmts);
    searchTokens = Math.max(0, indexStmts.length - 1);
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
    cells: plannedCells,
    catalogIds,
    priceHistory,
    hashtagsRegistered,
    hashtagsAdded,
    detachedMedia,
    searchTokens,
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

type ProductPostCommitAudit = (
  action: string,
  detail: Record<string, unknown>
) => Promise<void>;

/**
 * QUEUE MEDIA DETACHED BY AN ALREADY-COMMITTED PRODUCT WRITE.
 *
 * This is deliberately shared by the ordinary/TXT save and the CSV import
 * door. `planRelationsWrite` tells both callers which owned objects their
 * replacement stopped referencing; neither caller may delete those objects
 * inline. The durable queue is de-duplicated by `enqueueMediaDetach`, and the
 * cleanup worker re-checks every live reference immediately before touching
 * R2, so a key shared by another product is preserved.
 *
 * Call this only after the batch containing the relation replacement has
 * returned successfully. Its bookkeeping is best-effort because the product
 * change is already a committed fact: a queue/audit outage must not turn that
 * successful save into a response which invites the admin to retry it.
 */
export async function queueDetachedProductMediaAfterCommit(
  db: D1Database,
  productId: string,
  actorId: string,
  detachedMedia: readonly string[],
  auditAfterCommit?: ProductPostCommitAudit
): Promise<void> {
  if (!detachedMedia.length) return;

  const record = async (action: string, detail: Record<string, unknown>): Promise<void> => {
    try {
      if (auditAfterCommit) await auditAfterCommit(action, detail);
      else await audit(db, actorId, action, productId, detail);
    } catch (error) {
      console.error('product_post_commit_audit_failed', JSON.stringify({
        product_id: productId,
        action,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  try {
    const queued = await enqueueMediaDetach(db, detachedMedia, productId);
    if (queued.length) {
      await record('product.media.detach_queued', {
        keys: queued.slice(0, 50),
        count: queued.length,
      });
    }
  } catch (error) {
    /**
     * The relation replacement has already committed. Leaving an
     * unreferenced object behind is recoverable through the orphan scan;
     * throwing here would falsely report that the catalogue edit rolled back.
     */
    await record('product.media.detach_queue_failed', {
      keys: detachedMedia.slice(0, 50),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Runs the plan as ONE batch (D1 batches are atomic — the row and its option
 * tree either both land or neither does), then writes the audit rows named
 * by the caller plus `product.relations.save` whenever relations were part of
 * the batch, so a template apply and a form save leave the same trail.
 *
 * AND THEN, ONLY THEN, QUEUES THE PICTURES THE SAVE DROPPED.
 *
 * Removing an image from a product deleted its `product_images` row and left
 * the object in R2 for ever — the owner pays for those bytes every month, and
 * nothing in this file had ever mentioned the bucket. It is queued rather than
 * deleted for the reason the owner gave: with a queue an object may outlive
 * the save by a few minutes, but an image that is still on a page can never be
 * destroyed, because the worker re-reads every reference before it touches the
 * bucket. With an immediate delete, one error is a broken image on a live
 * page. The same `media_cleanup_jobs` table the full-product delete writes to.
 *
 * AFTER THE BATCH, NEVER INSIDE IT. A rolled-back save leaves the image row in
 * place and the product still showing the picture; a deletion queued in the
 * same batch would roll back with it, but one queued BEFORE it would survive
 * and destroy a live image. So this runs only once `db.batch` has returned.
 */
export async function saveProductAtomic(
  db: D1Database,
  plan: ProductSavePlan,
  auditRows: Array<{ action: string; detail: Record<string, unknown> }> = []
): Promise<void> {
  if (plan.statements.length) await db.batch(plan.statements);
  /**
   * Everything below this point is post-commit bookkeeping. An audit outage
   * must never make a caller believe the atomic batch rolled back: import
   * callers may otherwise delete newly uploaded media which the committed
   * product now references. Keep the save successful and leave an observable
   * runtime error for operations instead.
   */
  const auditAfterCommit = async (
    action: string,
    detail: Record<string, unknown>
  ): Promise<void> => {
    try {
      await audit(db, plan.actorId, action, plan.productId, detail);
    } catch (error) {
      console.error('product_post_commit_audit_failed', JSON.stringify({
        product_id: plan.productId,
        action,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  for (const row of auditRows) await auditAfterCommit(row.action, row.detail);
  if (plan.relations) {
    await auditAfterCommit('product.relations.save', { ...plan.relations.summary });
  }

  await queueDetachedProductMediaAfterCommit(
    db,
    plan.productId,
    plan.actorId,
    plan.detachedMedia,
    auditAfterCommit
  );
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
  quarantined_images: Record<string, unknown>[];
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
    images: images.results.filter(isActiveProductImageRow),
    quarantined_images: images.results
      .filter((image) => !isActiveProductImageRow(image))
      .map((image) => ({
        ...image,
        url: '',
        r2_key: '',
        is_primary: 0,
        quarantined: 1,
        source_url: String(image.source_url ?? '').trim() || String(image.url ?? '').trim(),
        quarantine_reason: String(image.quarantine_reason ?? '').trim() || 'legacy_noncanonical_media',
      }))
      .filter(isValidProductImageQuarantine),
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
      if (v.lead_time_text_ar !== undefined) check('options', v.id, 'lead_time_text_ar', v.lead_time_text_ar, s.lead_time_text_ar ?? '');
      if (v.lead_time_text_ckb !== undefined) check('options', v.id, 'lead_time_text_ckb', v.lead_time_text_ckb, s.lead_time_text_ckb ?? '');
      check('options', v.id, 'lead_time_min_days', v.lead_time_min_days, n(s.lead_time_min_days));
      check('options', v.id, 'lead_time_max_days', v.lead_time_max_days, n(s.lead_time_max_days));
      check('options', v.id, 'variant_key', v.variant_key, s.variant_key ?? '');
      check('options', v.id, 'variant_label', v.variant_label, s.variant_label ?? '');
      for (const field of DIMENSION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(v, field)) {
          check('options', v.id, field, v[field] ?? null, n(s[field]));
        }
      }
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
      for (const field of DIMENSION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(c, field)) {
          check('colors', c.id, field, c[field] ?? null, n(s[field]));
        }
      }
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
      for (const field of DIMENSION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(v, field)) {
          check('variants', v.id, field, v[field] ?? null, n(s[field]));
        }
      }
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

  /**
   * ---- THE PRE-ORDER COUNTER, READ BACK (0075) -----------------------------
   *
   * The net above compared every number this save wrote EXCEPT the two that
   * 0075 added. `options.N.*` keys are skipped in the document half as
   * "structural — verified through the relation tables below", and the
   * relation tables it then verified were groups, values, colours, variants
   * and images; `product_option_fulfillment` and `product_option_transports`
   * were verified nowhere. A capacity write that silently failed to land —
   * the batch reordered, a column absent on an edge that ran ahead of its
   * migration, a cell matched to the wrong row — was reported as a clean
   * apply, and the first sign of it would have been an oversold pre-order.
   *
   * SECTION `inventory`, not a new one. A capacity IS an inventory figure, and
   * the section union is mirrored by the admin client
   * (src/components/adminProducts/types.ts `ApplyMismatchSection`) which this
   * change may not edit; a section the client cannot name would be worse than
   * the honest label that already exists.
   *
   * FOUR CHECKS, AND WHAT EACH IS ABLE TO DISAGREE WITH. That question is the
   * whole point: a net whose two sides are written by the same statement
   * reports "clean" for every input and is worse than no net, because it is
   * read as evidence.
   *
   *  1. `capacity` — COMPARED EXACTLY against what the plan asked for. A
   *     setting this save wrote, exactly like `stock` on a value. `?? null`
   *     and NEVER `?? 0` on either side: an absent column is UNTRACKED, and
   *     reading it as zero would report a clean apply as a mismatch and a
   *     sold-out pre-order as correct.
   *
   *  2. THE ROW ID — compared against the id the plan was going to write
   *     under. `inventory_ledger.scope_id` names this exact row for every unit
   *     it holds, so a row that came back under a DIFFERENT id has orphaned
   *     every one of them: the release for a live pre-order matches nothing
   *     and the units are stranded invisibly. Nothing in this shop legitimately
   *     re-ids a cell — a checkout moves counters, it never rewrites identity —
   *     so this check has no race window at all, and it fires for exactly the
   *     failure the hold-preserving replace exists to prevent. Only rows the
   *     plan already knew are checked: a cell being created has no previous id
   *     to keep.
   *
   *  3. THE HOLD — a mismatch only when units were LOST (stored BELOW what the
   *     row held when the plan was built). This check was dead until now, and
   *     saying why matters more than the check: `fulfillmentStatements` used to
   *     re-insert each row BINDING that same plan-time number, so the stored
   *     value was forced to equal the number it was being compared against and
   *     the comparison could not fail for the failure it was added for. It is
   *     live now because the writer no longer names `capacity_reserved` at all
   *     — a surviving row keeps whatever it is holding — so a zero here means
   *     the row really was deleted and re-created, which is the stranding
   *     failure. The window it cannot tell apart is a concurrent `release` or
   *     `deduct` on the same row; that reports a mismatch an operator re-reads
   *     and dismisses, which is the safe side of a safety net. A hold that
   *     GREW is never reported: somebody else's checkout is not this admin's
   *     failed apply.
   *
   *  4. THE QUOTA AGAINST THE HOLD THE ROW IS ACTUALLY CARRYING — both sides
   *     read back AFTER the commit, so neither comes from the plan. This is
   *     the one check that can see what `refuseStrandedCapacity` structurally
   *     cannot: that guard judges a read taken before the batch, so a checkout
   *     that reserves in the window between them leaves a quota legally written
   *     BELOW the units now held (oversold), or written to NULL while units are
   *     held — and once the column is NULL the deduct guard
   *     `<on_hand> IS NOT NULL AND …` can never match again, so those units can
   *     be neither deducted nor released. The two keys are named after the two
   *     refusals the admin door raises for the same states
   *     (CAPACITY_BELOW_RESERVED, CAPACITY_UNTRACKED_WHILE_HELD), because the
   *     descriptive pass and the door must say the same words about the same
   *     counter. Raised only when the capacity LANDED as asked: when it did
   *     not, check 1 already names that row, and a second line about it would
   *     be noise rather than a second fact.
   */
  if (plan.cells) {
    const storedCells = stored.view.fulfillments ?? [];
    const storedRoutes = stored.view.transports ?? [];
    const cellOf = new Map(storedCells.map((f) => [`${f.option_id}|${f.fulfillment_type}`, f] as const));
    const routeOf = new Map(storedRoutes.map((t) => [`${t.fulfillment_id}|${t.method}`, t] as const));
    const capMiss = (key: string, requested: unknown, storedValue: unknown) =>
      out.push({ section: 'inventory', key, requested, stored: storedValue });

    /** One counter row — a cell or one of its routes; they carry the same two
     *  columns and the same four questions. */
    const checkCounter = (
      where: string,
      requestedCapacity: number | null,
      planned: { id: string; capacity_reserved: number } | undefined,
      storedRow: { id: string; capacity?: number | null; capacity_reserved?: number | null }
    ) => {
      const storedCapacity = storedRow.capacity ?? null;
      const landed = storedCapacity === requestedCapacity;
      if (!landed) capMiss(`${where}.capacity`, requestedCapacity, storedCapacity);
      const held = Number(storedRow.capacity_reserved ?? 0);
      if (planned) {
        if (storedRow.id !== planned.id) capMiss(`${where}.id`, planned.id, storedRow.id);
        if (held < planned.capacity_reserved) capMiss(`${where}.capacity_reserved`, planned.capacity_reserved, held);
      }
      if (landed && held > 0) {
        if (storedCapacity === null) capMiss(`${where}.capacity_untracked_while_held`, null, held);
        else if (storedCapacity < held) capMiss(`${where}.capacity_below_reserved`, storedCapacity, held);
      }
    };

    for (const cell of plan.cells.requested) {
      const where = `fulfillment.${cell.option_id}.${cell.fulfillment_type}`;
      const s = cellOf.get(`${cell.option_id}|${cell.fulfillment_type}`);
      if (!s) {
        capMiss(`${where}.cell`, cell.capacity, null);
        continue;
      }
      checkCounter(where, cell.capacity, plan.cells.held.cells.get(cellKey(cell.option_id, cell.fulfillment_type)), s);
      for (const t of cell.transports) {
        const rWhere = `${where}.${t.method}`;
        const sr = routeOf.get(`${s.id}|${t.method}`);
        if (!sr) {
          capMiss(`${rWhere}.route`, t.capacity, null);
          continue;
        }
        checkCounter(
          rWhere,
          t.capacity,
          plan.cells.held.transports.get(transportKey(cell.option_id, cell.fulfillment_type, t.method)),
          sr
        );
      }
    }
    // A replace leaves EXACTLY the payload's set. A row the file did not
    // describe but that survived the delete is a counter nobody is looking at
    // — and since the delete now refuses to drop a row that is holding units,
    // this is also how a removal lost to that refusal is reported.
    if (storedCells.length !== plan.cells.requested.length) {
      capMiss('fulfillment.cells', plan.cells.requested.length, storedCells.length);
    }
    const wantedRoutes = plan.cells.requested.reduce((sum, c) => sum + c.transports.length, 0);
    if (storedRoutes.length !== wantedRoutes) {
      capMiss('fulfillment.routes', wantedRoutes, storedRoutes.length);
    }
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
