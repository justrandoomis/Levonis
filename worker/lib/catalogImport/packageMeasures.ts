/**
 * «تعبئة أبعاد الشحن من بيانات الاستيراد» — THE OWNER'S FILL OF THE PACKAGE
 * MEASURES FROM THE IMPORTED LOGISTICS ROWS (owner request 2026-10-18).
 *
 * The import never writes `products.package_*` nor the option and colour
 * package columns of 0099 (import spec §1 row 10, §B.7): it keeps the source's
 * measures as typed spec rows (group 'logistics'). So an imported product
 * shows «الوزن مع التغليف · يمنع البيع» and «أبعاد الصندوق · يمنع البيع» until
 * someone types them. This is the owner's own act, outside any import batch,
 * that copies them across:
 *
 *   package.weight                         → package_weight_g
 *   package.length / width / height [L,W,H] → package_depth_mm / package_width_mm / package_height_mm
 *     (the site's one box mapping: `withPackageMeasure`, src/components/adminProducts/form/v2/v2Model.ts)
 *
 * for each scope of an imported product (a COMPLETE `catalog_import_items`
 * row): the product; an option value; a colour (a spec row scoped to a
 * variant whose whole combination is one colour, `c:<id>` — or one option
 * value, `o:<id>`, which is that option's own measure).
 *
 * WHAT IS NEVER DONE.
 *   - An owner-entered value is never overwritten: the weight is written only
 *     where it is empty, the box only where ALL THREE sides are empty — and the
 *     emptiness is tested again in the UPDATE itself, so a value typed between
 *     the read and the write stays.
 *   - A box is written only when its scope has all three edges (one region);
 *     a partial box is left out.
 *   - `product.*` (the product's own, unpacked size and net weight) is never
 *     read; `shipment.*` and `carton.*` (multi-box and master-carton rows) are
 *     ignored.
 *   - A row in conflict (`conflict` not empty) or not `verified` is left out.
 *   - A PRICED product is never written (`skipped_priced`, listed for the
 *     product form): an engine pricing state or a published V2 result. Its
 *     package measures are freight inputs, and a change to them must go
 *     through the owner's reviewed save (the form's gateV2); written here, they
 *     would move no `inputs_seq`, so the next FX tick or sweep could publish
 *     new prices unreviewed. An unpriced product has no price to move: its
 *     first reviewed publish reads the new measures.
 *   - A scope whose freight measure the owner holds in `pricing_inputs`
 *     (before DECISIONS row 247 an own-cost model's weight and box lived only
 *     there; a purchase still writes them) is the owner's: kept, never
 *     overridden by a package written here.
 *   - Both refusals are tested again in the UPDATE itself (NOT EXISTS), so a
 *     product priced, or a measure entered, between the read and the write
 *     stays as it is.
 *
 * THE IMPORT'S GUARD. While `ops_guards('catalog-import-batch')` exists, the
 * 0195 triggers refuse any package write; the route refuses first with a
 * sentence (`importGuardPresent`), and a guard that appears between the check
 * and the write rolls the batch back (`IMPORT_FINANCIAL_WRITE_REFUSED`).
 *
 * D1 LIMITS. Every write is a conditional UPDATE whose values travel as ONE
 * bound JSON parameter (`json_each`), at most `FILL_CHUNK` rows each, and the
 * statements go in batches of `FILL_BATCH`: far below 100 bound parameters, a
 * statement text of a few hundred bytes, two arguments per SQL function.
 */
import { plausibleEdge, plausibleWeight } from '@levonis/catalog/bambuImport/logistics';
import { IMPORT_GUARD_ID, IMPORT_GUARD_REFUSAL } from './protectedTables';

/** The keys read, and nothing else: never `product.*`, `shipment.*` or `carton.*`. */
export const PACKAGE_MEASURE_KEYS = ['package.weight', 'package.length', 'package.width', 'package.height'] as const;
type MeasureKey = (typeof PACKAGE_MEASURE_KEYS)[number];
const EDGES: readonly MeasureKey[] = ['package.length', 'package.width', 'package.height'];

/** The regions a verified row can carry, the international (220 V) box first. */
const REGION_ORDER = ['intl_220v', ''] as const;

/** Rows per UPDATE (one bound JSON parameter). */
export const FILL_CHUNK = 200;
/** Statements per D1 batch. */
export const FILL_BATCH = 40;
/** Ids per read (one bound JSON parameter). */
const READ_CHUNK = 500;
/** The «still missing» list's length in one answer (the total is counted apart). */
export const MISSING_LIST_MAX = 1000;

export type FillKind = 'product' | 'option' | 'color';
const TABLE: Record<FillKind, string> = { product: 'products', option: 'product_option_values', color: 'product_colors' };

/** The imported products: every product a COMPLETE import item names. */
const IMPORTED = `SELECT DISTINCT i.levonis_product_id FROM catalog_import_items i WHERE i.processing_state = 'COMPLETE' AND i.levonis_product_id <> ''`;

export interface MissingProduct {
  id: string;
  slug: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  /** No packaged weight on the product, nor on every one of its models. */
  weight: boolean;
  /** No full box on the product, nor on every one of its models. */
  box: boolean;
}

/** A priced product the fill left for the product form. */
export interface ProductRef {
  id: string;
  slug: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
}

export interface FillReport {
  imported_products: number;
  /** Products with at least one value written (on itself, an option or a colour). */
  products_filled: number;
  filled: Record<FillKind, { weight: number; box: number }>;
  skipped: {
    /** Rows with a conflict recorded. */
    conflict: number;
    /** Rows not `verified`. */
    unverified: number;
    /** Rows with a unit, region or size the columns cannot take. */
    invalid: number;
    /** Scopes with one or two box edges only. */
    partial_box: number;
    /** Values already on the row, or held in its pricing inputs (the owner's): kept. */
    kept_existing: number;
    /** Rows scoped to a value, colour or variant the product no longer has, or a multi-choice variant. */
    unmapped_scope: number;
  };
  /** Priced products with a measure to offer, left untouched for the product form's reviewed save. */
  skipped_priced: number;
  priced_products: ProductRef[];
  still_missing: MissingProduct[];
  still_missing_total: number;
}

/** The import's batch guard row exists (a database without `ops_guards` has none). */
export async function importGuardPresent(db: D1Database): Promise<boolean> {
  try {
    return !!(await db.prepare('SELECT 1 AS hit FROM ops_guards WHERE id = ?').bind(IMPORT_GUARD_ID).first());
  } catch (e) {
    if (missingTable(e)) return false;
    throw e;
  }
}

/** The guard trigger refused a write (the guard appeared after the check). */
export const isImportGuardRefusal = (e: unknown): boolean => (e instanceof Error ? e.message : String(e)).includes(IMPORT_GUARD_REFUSAL);

const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

const emptyReport = (): FillReport => ({
  imported_products: 0,
  products_filled: 0,
  filled: { product: { weight: 0, box: 0 }, option: { weight: 0, box: 0 }, color: { weight: 0, box: 0 } },
  skipped: { conflict: 0, unverified: 0, invalid: 0, partial_box: 0, kept_existing: 0, unmapped_scope: 0 },
  skipped_priced: 0,
  priced_products: [],
  still_missing: [],
  still_missing_total: 0,
});

/** A stored measure as the integer column takes it: rounded UP (never an under-sized box), float noise ignored. */
const whole = (v: number) => Math.max(1, Math.ceil(v - 1e-9));

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const empty = (v: unknown) => v === null || v === undefined || !(Number(v) > 0);

interface SpecRow {
  product_id: string;
  k: string;
  scope_kind: string;
  scope_id: string;
  region: string;
  value_num: number | null;
  unit: string;
  status: string;
  conflict: string;
}

interface Measures {
  weight: number | null;
  /** [L, W, H] in mm. */
  box: [number, number, number] | null;
}

interface Target extends Measures {
  kind: FillKind;
  id: string;
  productId: string;
}

interface DimRow {
  id: string;
  product_id: string;
  package_weight_g: number | null;
  package_width_mm: number | null;
  package_depth_mm: number | null;
  package_height_mm: number | null;
}

async function readByIds<T>(db: D1Database, sql: string, ids: readonly string[]): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks([...new Set(ids)], READ_CHUNK)) {
    const { results } = await db.prepare(sql).bind(JSON.stringify(part)).all<T>();
    out.push(...((results ?? []) as T[]));
  }
  return out;
}

const DIM_COLUMNS = 'id, product_id, package_weight_g, package_width_mm, package_depth_mm, package_height_mm';

/** The pricing tables this database has (0181, 0189): a clause on a table it lacks is left out. */
interface PricingTables {
  state: boolean;
  results: boolean;
  inputs: boolean;
}

async function pricingTables(db: D1Database): Promise<PricingTables> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('product_pricing_state', 'pricing_v2_sku_results', 'pricing_inputs')")
    .all<{ name: string }>();
  const names = new Set((results ?? []).map((r) => String(r.name)));
  return { state: names.has('product_pricing_state'), results: names.has('pricing_v2_sku_results'), inputs: names.has('pricing_inputs') };
}

/**
 * The product `pid` (an SQL expression) is PRICED: an engine pricing state (a V2 method chosen, or the
 * engine's own) or any published V2 result. `needsPricingIds` is the narrower «يحتاج تسعيرًا» read; this one
 * also keeps out an engine product not published yet, whose next reviewed publish must see its inputs as saved.
 */
const pricedSql = (pid: string, t: PricingTables): string => {
  const parts: string[] = [];
  if (t.state) parts.push(`EXISTS (SELECT 1 FROM product_pricing_state ps WHERE ps.product_id = ${pid} AND ps.mode = 'engine')`);
  if (t.results) parts.push(`EXISTS (SELECT 1 FROM pricing_v2_sku_results pr WHERE pr.product_id = ${pid})`);
  return parts.length ? `(${parts.join(' OR ')})` : '0';
};

/** A freight measure the owner holds in a pricing row (any origin: the owner's, a purchase's). */
const HELD_MEASURE =
  'pi.pricing_weight_g IS NOT NULL OR pi.shipping_weight_g IS NOT NULL OR pi.shipping_length_mm IS NOT NULL OR pi.shipping_width_mm IS NOT NULL OR pi.shipping_height_mm IS NOT NULL OR pi.manual_cbm IS NOT NULL';
const PRICING_SCOPE: Record<FillKind, string> = { product: 'base', option: 'option', color: 'color' };

/** The row of `table` (a fill kind) has its freight measure held in `pricing_inputs`. */
const heldSql = (kind: FillKind, t: PricingTables): string => {
  if (!t.inputs) return '0';
  const table = TABLE[kind];
  const pid = kind === 'product' ? `${table}.id` : `${table}.product_id`;
  const scopeId = kind === 'product' ? "''" : `${table}.id`;
  return `EXISTS (SELECT 1 FROM pricing_inputs pi WHERE pi.product_id = ${pid} AND pi.scope = '${PRICING_SCOPE[kind]}' AND pi.scope_id = ${scopeId} AND (${HELD_MEASURE}))`;
};

/**
 * Plan and write the fill, then list the imported products still missing a
 * packaged weight or box. Returns the report and the products written to
 * (`touched`, for the completeness re-evaluation).
 */
export async function fillPackageMeasures(db: D1Database): Promise<FillReport & { touched: string[] }> {
  const report = emptyReport();
  let products: Array<DimRow & { slug: string; name: string; name_ar: string; name_ku: string }>;
  let specRows: SpecRow[];
  try {
    products = ((
      await db
        .prepare(
          `SELECT id, id AS product_id, slug, name, name_ar, name_ku, package_weight_g, package_width_mm, package_depth_mm, package_height_mm
             FROM products WHERE id IN (${IMPORTED})`
        )
        .all<DimRow & { slug: string; name: string; name_ar: string; name_ku: string }>()
    ).results ?? []) as typeof products;
    specRows = ((
      await db
        .prepare(
          `SELECT s.product_id, s.canonical_key AS k, s.scope_kind, s.scope_id, s.region, s.value_num, s.unit, s.status, s.conflict
             FROM product_spec_values s
            WHERE s.group_key = 'logistics' AND s.canonical_key IN (${PACKAGE_MEASURE_KEYS.map((k) => `'${k}'`).join(', ')})
              AND s.product_id IN (${IMPORTED})
            ORDER BY s.product_id, s.scope_kind, s.scope_id, s.region, s.canonical_key`
        )
        .all<SpecRow>()
    ).results ?? []) as SpecRow[];
  } catch (e) {
    // A database without the import's tables (0194 / 0195) has nothing imported.
    if (missingTable(e)) return { ...report, touched: [] };
    throw e;
  }
  report.imported_products = products.length;

  // The priced products and the scopes whose freight measure a pricing row holds: never written.
  const tables = await pricingTables(db);
  const priced = new Set(
    ((await db.prepare(`SELECT p.id FROM products p WHERE p.id IN (${IMPORTED}) AND ${pricedSql('p.id', tables)}`).all<{ id: string }>()).results ?? []).map((r) => String(r.id))
  );
  const held = new Set<string>();
  if (tables.inputs) {
    const { results } = await db
      .prepare(`SELECT pi.scope, pi.scope_id, pi.product_id FROM pricing_inputs pi WHERE pi.product_id IN (${IMPORTED}) AND pi.scope IN ('base', 'option', 'color') AND (${HELD_MEASURE})`)
      .all<{ scope: string; scope_id: string; product_id: string }>();
    for (const r of results ?? []) held.add(r.scope === 'base' ? `product:${r.product_id}` : `${r.scope}:${r.scope_id}`);
  }

  // 1. The usable measures of each scope, by region.
  type ScopeEntry = { productId: string; kind: string; id: string; byRegion: Map<string, Partial<Record<MeasureKey, number>>> };
  const scopes = new Map<string, ScopeEntry>();
  for (const r of specRows) {
    if (String(r.conflict ?? '') !== '') {
      report.skipped.conflict++;
      continue;
    }
    if (r.status !== 'verified') {
      report.skipped.unverified++;
      continue;
    }
    const key = r.k as MeasureKey;
    const isWeight = key === 'package.weight';
    const v = Number(r.value_num);
    const region = String(r.region ?? '');
    if (
      r.value_num === null ||
      !Number.isFinite(v) ||
      r.unit !== (isWeight ? 'g' : 'mm') ||
      !(isWeight ? plausibleWeight(v) : plausibleEdge(v)) ||
      !(REGION_ORDER as readonly string[]).includes(region)
    ) {
      report.skipped.invalid++;
      continue;
    }
    const sk = `${r.product_id}|${r.scope_kind}|${r.scope_id}`;
    const entry = scopes.get(sk) ?? { productId: String(r.product_id), kind: String(r.scope_kind), id: String(r.scope_id ?? ''), byRegion: new Map() };
    scopes.set(sk, entry);
    const at = entry.byRegion.get(region) ?? {};
    at[key] = whole(v);
    entry.byRegion.set(region, at);
  }

  const measuresOf = (e: ScopeEntry): Measures => {
    let weight: number | null = null;
    let box: [number, number, number] | null = null;
    let partial = false;
    for (const region of REGION_ORDER) {
      const m = e.byRegion.get(region);
      if (!m) continue;
      if (weight === null && m['package.weight'] !== undefined) weight = m['package.weight'];
      const edges = EDGES.map((k) => m[k]);
      if (box === null && edges.every((x) => x !== undefined)) box = edges as [number, number, number];
      else if (edges.some((x) => x !== undefined)) partial = true;
    }
    if (box === null && partial) report.skipped.partial_box++;
    return { weight, box };
  };

  // 2. Each scope to its row: the product, an option value, a colour.
  const importedIds = new Set(products.map((p) => String(p.id)));
  const variantIds = [...scopes.values()].filter((e) => e.kind === 'variant').map((e) => e.id);
  const variants = new Map(
    (await readByIds<{ id: string; product_id: string; combo_key: string }>(db, 'SELECT id, product_id, combo_key FROM product_variants WHERE id IN (SELECT value FROM json_each(?1))', variantIds)).map(
      (v) => [String(v.id), v] as const
    )
  );
  const variantTarget = (e: ScopeEntry): { kind: FillKind; id: string } | null => {
    const v = variants.get(e.id);
    if (!v || String(v.product_id) !== e.productId) return null;
    const combo = String(v.combo_key ?? '');
    const colour = /^c:([^|]+)$/.exec(combo);
    if (colour) return { kind: 'color', id: colour[1]! };
    const option = /^o:([^|]+)$/.exec(combo);
    return option ? { kind: 'option', id: option[1]! } : null;
  };
  const optionIds: string[] = [];
  const colourIds: string[] = [];
  for (const e of scopes.values()) {
    if (e.kind === 'option_value') optionIds.push(e.id);
    else if (e.kind === 'variant') {
      const t = variantTarget(e);
      if (t?.kind === 'option') optionIds.push(t.id);
      if (t?.kind === 'color') colourIds.push(t.id);
    }
  }
  const options = new Map((await readByIds<DimRow>(db, `SELECT ${DIM_COLUMNS} FROM product_option_values WHERE id IN (SELECT value FROM json_each(?1))`, optionIds)).map((r) => [String(r.id), r] as const));
  const colours = new Map((await readByIds<DimRow>(db, `SELECT ${DIM_COLUMNS} FROM product_colors WHERE id IN (SELECT value FROM json_each(?1))`, colourIds)).map((r) => [String(r.id), r] as const));
  const productRows = new Map(products.map((p) => [String(p.id), p] as const));
  const rowOf = (kind: FillKind, id: string): DimRow | undefined => (kind === 'product' ? productRows.get(id) : kind === 'option' ? options.get(id) : colours.get(id));

  // A scope of the row itself wins over a variant that stands for it (product, then option values, then variants).
  const rank = (kind: string) => (kind === 'product' ? 0 : kind === 'option_value' ? 1 : 2);
  const targets = new Map<string, Target>();
  for (const e of [...scopes.values()].sort((a, b) => rank(a.kind) - rank(b.kind))) {
    const t =
      e.kind === 'product' ? { kind: 'product' as const, id: e.productId } : e.kind === 'option_value' ? { kind: 'option' as const, id: e.id } : e.kind === 'variant' ? variantTarget(e) : null;
    const row = t ? rowOf(t.kind, t.id) : undefined;
    if (!t || !row || String(row.product_id) !== e.productId || !importedIds.has(e.productId)) {
      report.skipped.unmapped_scope++;
      continue;
    }
    const m = measuresOf(e);
    const k = `${t.kind}:${t.id}`;
    const cur = targets.get(k) ?? { kind: t.kind, id: t.id, productId: e.productId, weight: null, box: null };
    if (cur.weight === null) cur.weight = m.weight;
    if (cur.box === null) cur.box = m.box;
    targets.set(k, cur);
  }

  // 3. Only where the row is empty: the weight alone, the box whole.
  const weights: Record<FillKind, Array<[string, number]>> = { product: [], option: [], color: [] };
  const boxes: Record<FillKind, Array<[string, number, number, number]>> = { product: [], option: [], color: [] };
  const pricedOffered = new Set<string>();
  for (const t of targets.values()) {
    const row = rowOf(t.kind, t.id)!;
    const offers = (t.weight !== null ? 1 : 0) + (t.box !== null ? 1 : 0);
    if (priced.has(t.productId)) {
      if (offers) pricedOffered.add(t.productId);
      continue;
    }
    if (held.has(`${t.kind}:${t.id}`)) {
      report.skipped.kept_existing += offers;
      continue;
    }
    if (t.weight !== null) {
      if (empty(row.package_weight_g)) weights[t.kind].push([t.id, t.weight]);
      else report.skipped.kept_existing++;
    }
    if (t.box !== null) {
      if (empty(row.package_depth_mm) && empty(row.package_width_mm) && empty(row.package_height_mm)) boxes[t.kind].push([t.id, t.box[0], t.box[1], t.box[2]]);
      else report.skipped.kept_existing++;
    }
  }

  report.skipped_priced = pricedOffered.size;
  report.priced_products = products
    .filter((p) => pricedOffered.has(String(p.id)))
    .map((p) => ({ id: String(p.id), slug: String(p.slug ?? ''), name_en: String(p.name ?? ''), name_ar: String(p.name_ar ?? ''), name_ckb: String(p.name_ku ?? '') }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  // 4. The writes: conditional — a value typed meanwhile, a product priced meanwhile, a pricing row's measure
  // entered meanwhile all stay — and the product's version moves with them.
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const pick = (table: string, i: number) => `(SELECT json_extract(j.value, '$[${i}]') FROM json_each(?1) j WHERE json_extract(j.value, '$[0]') = ${table}.id)`;
  const ids = 'id IN (SELECT json_extract(value, \'$[0]\') FROM json_each(?1))';
  const statements: Array<{ stmt: D1PreparedStatement; count: { kind: FillKind; field: 'weight' | 'box' } | null }> = [];
  for (const kind of ['product', 'option', 'color'] as const) {
    const table = TABLE[kind];
    const stamp = kind === 'product' ? `, updated_at = ${now}` : '';
    const pid = kind === 'product' ? `${table}.id` : `${table}.product_id`;
    const free = `NOT ${pricedSql(pid, tables)} AND NOT ${heldSql(kind, tables)}`;
    for (const part of chunks(weights[kind], FILL_CHUNK)) {
      statements.push({
        stmt: db.prepare(`UPDATE ${table} SET package_weight_g = ${pick(table, 1)}${stamp} WHERE ${ids} AND COALESCE(package_weight_g, 0) <= 0 AND ${free}`).bind(JSON.stringify(part)),
        count: { kind, field: 'weight' },
      });
    }
    for (const part of chunks(boxes[kind], FILL_CHUNK)) {
      statements.push({
        stmt: db
          .prepare(
            `UPDATE ${table} SET package_depth_mm = ${pick(table, 1)}, package_width_mm = ${pick(table, 2)}, package_height_mm = ${pick(table, 3)}${stamp}
              WHERE ${ids} AND COALESCE(package_depth_mm, 0) <= 0 AND COALESCE(package_width_mm, 0) <= 0 AND COALESCE(package_height_mm, 0) <= 0 AND ${free}`
          )
          .bind(JSON.stringify(part)),
        count: { kind, field: 'box' },
      });
    }
  }
  // An option's or colour's measure is the product's too: its version moves, so an open form saves no stale copy.
  const planned = new Set<string>();
  for (const kind of ['option', 'color'] as const) {
    for (const [id] of [...weights[kind], ...boxes[kind]]) planned.add(rowOf(kind, id)!.product_id);
  }
  for (const part of chunks([...planned], FILL_CHUNK)) {
    statements.push({
      stmt: db.prepare(`UPDATE products SET updated_at = ${now} WHERE id IN (SELECT value FROM json_each(?1)) AND NOT ${pricedSql('products.id', tables)}`).bind(JSON.stringify(part)),
      count: null,
    });
  }

  const touched = new Set<string>();
  for (const k of ['product', 'option', 'color'] as const) {
    for (const [id] of [...weights[k], ...boxes[k]]) touched.add(k === 'product' ? id : rowOf(k, id)!.product_id);
  }
  for (const batch of chunks(statements, FILL_BATCH)) {
    const results = await db.batch(batch.map((s) => s.stmt));
    batch.forEach((s, i) => {
      if (s.count) report.filled[s.count.kind][s.count.field] += Number(results[i]?.meta?.changes ?? 0);
    });
  }
  const anyFilled = Object.values(report.filled).some((f) => f.weight + f.box > 0);
  report.products_filled = anyFilled ? touched.size : 0;

  // 5. What is still missing, by the completeness rule (worker/lib/productCompleteness.ts PACKAGE_WEIGHT /
  // PACKAGE_BOX): on the product, or on every model (the active values of the first active group).
  const missing = await stillMissing(db);
  report.still_missing = missing.slice(0, MISSING_LIST_MAX);
  report.still_missing_total = missing.length;
  return { ...report, touched: anyFilled ? [...touched] : [] };
}

const HAS_BOX = (a: string) => `(COALESCE(${a}.package_width_mm, 0) > 0 AND COALESCE(${a}.package_depth_mm, 0) > 0 AND COALESCE(${a}.package_height_mm, 0) > 0)`;

/**
 * The imported products a customer still cannot buy for want of a packaged
 * weight or box: the product's own, or every model's — the models being the
 * active values of the product's first active group with an active value
 * (`modelsOf`, worker/lib/pricingEngine/legacy.ts), or every active value
 * when no group qualifies.
 */
export async function stillMissing(db: D1Database): Promise<MissingProduct[]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = ((
      await db
        .prepare(
          `SELECT p.id, p.slug, p.name, p.name_ar, p.name_ku,
                  CASE WHEN COALESCE(p.package_weight_g, 0) > 0 OR (m.n > 0 AND m.nw = m.n) THEN 0 ELSE 1 END AS weight_missing,
                  CASE WHEN ${HAS_BOX('p')} OR (m.n > 0 AND m.nb = m.n) THEN 0 ELSE 1 END AS box_missing
             FROM products p
             JOIN (SELECT f.pid AS pid, COUNT(v.id) AS n,
                          TOTAL(COALESCE(v.package_weight_g, 0) > 0) AS nw,
                          TOTAL(${HAS_BOX('v')}) AS nb
                     FROM (SELECT p2.id AS pid,
                                  (SELECT g.id FROM product_option_groups g
                                    WHERE g.product_id = p2.id AND g.active <> 0
                                      AND EXISTS (SELECT 1 FROM product_option_values x
                                                   WHERE x.group_id = g.id AND x.product_id = p2.id AND x.active <> 0 AND x.merged_into IS NULL)
                                    ORDER BY g.sort, g.name_en LIMIT 1) AS gid
                             FROM products p2 WHERE p2.id IN (${IMPORTED})) f
                     LEFT JOIN product_option_values v
                       ON v.product_id = f.pid AND v.active <> 0 AND v.merged_into IS NULL AND (f.gid IS NULL OR v.group_id = f.gid)
                    GROUP BY f.pid) m ON m.pid = p.id
            WHERE weight_missing = 1 OR box_missing = 1
            ORDER BY p.slug`
        )
        .all<Record<string, unknown>>()
    ).results ?? []) as Array<Record<string, unknown>>;
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug ?? ''),
    name_en: String(r.name ?? ''),
    name_ar: String(r.name_ar ?? ''),
    name_ckb: String(r.name_ku ?? ''),
    weight: Number(r.weight_missing) === 1,
    box: Number(r.box_missing) === 1,
  }));
}
