/**
 * THE CLEAN START'S LEGACY MONEY DOOR (addendum A.6, DECISIONS row 222).
 *
 * Every price a customer pays is the V2 writer's. The dinar fields the old form
 * typed — the document's price ladder, compare-at, direct surcharge and route
 * commissions; the option, colour, variant, order-type and
 * route price / adjustment / cost / surcharge cells; the product cost — are
 * no longer anybody's to type. One rule for every structure door (the product
 * save, `PUT /:id/relations`, `PUT /:id/fulfillment`):
 *
 *   - a field the request does not carry keeps the stored value (filled into
 *     the body before the planner reads it, so the planner writes it back
 *     unchanged and the 0181 value-compared locks see no change);
 *   - a field the request carries with the stored value (0, '' and null are
 *     the same "nothing") passes — an older client echoing what it loaded;
 *   - a field that differs, or a new row that carries any money, is refused:
 *     409 PRICING_V2_MANAGED {section: 3 (the document) | 5 (the selectors),
 *     field}. The answer names the field, never a value.
 *
 * Cost cells are judged only for an actor who may write cost (the owner, not
 * cost-blind): for everyone else the cost gate already refuses or carries the
 * stored cost forward (`attemptedFinancialWrites`, `carryStoredCostForward`),
 * and judging a cost against the stored one would tell a non-owner when a
 * guess was right.
 */
import { HttpError } from '../../http';
import { serverMessage } from '@levonis/contracts/costRefusals';
import type { ProductDoc } from '../../productModel';
import { loadProductRelations, type ProductRelations } from '../../productRelations';

type Row = Record<string, unknown>;
type Section = 3 | 5;

/** The document's price fields (section ٣). */
export const LEGACY_DOC_PRICE_KEYS = ['price_iqd', 'prime_price_iqd', 'pro_price_iqd', 'original_price_iqd', 'direct_surcharge_iqd'] as const;
/** A selector row's price fields (section ٥). */
export const LEGACY_ROW_PRICE_KEYS = ['regular_price_iqd', 'prime_price_iqd', 'pro_price_iqd', 'regular_adjust_iqd', 'prime_adjust_iqd', 'pro_adjust_iqd'] as const;
/** A selector row's cost fields (owner). */
export const LEGACY_ROW_COST_KEYS = ['cost_iqd', 'cost_adjust_iqd'] as const;

const has = (o: Row, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** 0, '' and null are one "nothing"; a number is itself; anything else compares by its JSON. */
function nothing(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === 0;
}
function same(a: unknown, b: unknown): boolean {
  if (nothing(a) && nothing(b)) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 409 PRICING_V2_MANAGED {section, field}: a legacy money field the request tried to move. */
export const legacyMoneyRefusal = (section: Section, field: string): HttpError =>
  new HttpError(409, serverMessage('PRICING_V2_MANAGED'), 'PRICING_V2_MANAGED', { section, v2: true, field });

/**
 * One row: absent keys take the stored value; present keys must equal it. A row
 * with no stored twin (`stored === null`, a new row) may carry no money at all.
 * With a `sink` (the planner's PIN mode) a differing value is not refused: it is
 * put back to the stored one (or dropped, on a new row) and its field named.
 */
function holdRow(row: Row, stored: Row | null, keys: readonly string[], section: Section, where: string, sink?: string[]): void {
  for (const k of keys) {
    if (!has(row, k)) {
      if (stored && has(stored, k)) row[k] = stored[k] ?? null;
      continue;
    }
    if (same(row[k], stored ? stored[k] : null)) continue;
    if (!sink) throw legacyMoneyRefusal(section, `${where}.${k}`);
    if (stored && has(stored, k)) row[k] = stored[k] ?? null;
    else delete row[k];
    sink.push(`${where}.${k}`);
  }
}

/**
 * THE DOCUMENT (section ٣) — before `validateProductDoc`, which still needs a
 * `price_iqd`: a new product is born at 0 (hidden until its first V2 write), an
 * existing one keeps the stored ladder.
 */
export function holdLegacyDocMoney(body: Row, prev: ProductDoc | null, opts: { costs: boolean }): void {
  docMoney(body, prev, opts.costs);
}

/**
 * THE PLANNER'S PIN (every writer of an ordinary product goes through
 * `planProductSave`: the TXT and template applies, the CSV import, the product
 * and relations saves): the validated document keeps the stored legacy money —
 * a new product is born at 0 with no ladder, compare-at or fees. Answers the
 * fields it put back (the caller's per-row PRICING_V2_MANAGED issue); never a value.
 */
export function pinLegacyDocMoney(doc: ProductDoc, prev: ProductDoc | null, costs: boolean): string[] {
  const sink: string[] = [];
  docMoney(doc as unknown as Row, prev, costs, sink);
  return sink;
}

function docMoney(body: Row, prev: ProductDoc | null, costs: boolean, sink?: string[]): void {
  const stored = (prev ?? null) as unknown as Row | null;
  holdRow(body, stored, LEGACY_DOC_PRICE_KEYS, 3, 'doc', sink);
  if (costs) holdRow(body, stored, ['product_cost_iqd'], 3, 'doc', sink);
  if (!has(body, 'price_iqd') || body.price_iqd === null || body.price_iqd === '') body.price_iqd = prev ? prev.price_iqd : 0;

  // Route commissions are retired (0189's fee trigger; `pinV2PriceFields` writes 0): an echo passes, and a
  // route the writer leaves without one keeps its stored commission. A route with no stored twin (a new route,
  // or any route of a new product) is born with none — 0, never null (null inherits the admin default fee).
  if (Array.isArray(body.preorder_transports)) {
    const before = new Map<string, number | null>((prev?.preorder_transports ?? []).map((t) => [String(t.method), t.commission_iqd ?? null] as const));
    for (const t of body.preorder_transports) {
      if (!isRow(t)) continue;
      const method = String(t.method);
      const was = before.has(method) ? (before.get(method) ?? null) : 0;
      if (!has(t, 'commission_iqd') || same(t.commission_iqd, was)) {
        if (was !== null || !has(t, 'commission_iqd')) t.commission_iqd = was;
        continue;
      }
      const field = `doc.preorder_transports.${method}.commission_iqd`;
      if (!sink) throw legacyMoneyRefusal(3, field);
      t.commission_iqd = was;
      sink.push(field);
    }
  }

  // The document's own JSON selectors (`options` / `colors`): a derived mirror of the relational rows
  // (the planner rebuilds it from them), so a figure there is never refused — it is put back to the
  // stored mirror (a V2 product's mirror can lag its SKU rows; an echo of either must save).
  for (const list of ['options', 'colors'] as const) {
    const rows = body[list];
    if (!Array.isArray(rows)) continue;
    const storedRows = new Map(((prev?.[list] ?? []) as unknown as Row[]).map((r) => [String(r.id), r] as const));
    const kept: string[] = [];
    for (const r of rows) {
      if (!isRow(r)) continue;
      const twin = storedRows.get(String(r.id)) ?? null;
      const at = `doc.${list}.${String(r.id)}`;
      // The pre-0018 shape names the regular price `price_iqd`.
      if (has(r, 'price_iqd') && !same(r.price_iqd, twin?.regular_price_iqd ?? null)) {
        delete r.price_iqd;
        kept.push(`${at}.price_iqd`);
      }
      holdRow(r, twin, [...LEGACY_ROW_PRICE_KEYS, 'compare_at_iqd'], 5, at, kept);
      if (costs) holdRow(r, twin, LEGACY_ROW_COST_KEYS, 5, at, kept);
    }
    if (sink) sink.push(...kept);
  }
}

export interface StoredSelectors {
  values: Map<string, Row>;
  colors: Map<string, Row>;
  variants: Map<string, Row>;
  /** `${option_id}|${fulfillment_type}` → cell. */
  cells: Map<string, Row>;
  /** `${option_id}|${fulfillment_type}|${method}` → route. */
  routes: Map<string, Row>;
}

/** The stored selector rows by the key a payload names them (no read: the caller's snapshot). */
export function selectorsOf(rel: ProductRelations, variants: readonly Row[]): StoredSelectors {
  const cellById = new Map(rel.fulfillments.map((f) => [f.id, f] as const));
  const routes = new Map<string, Row>();
  for (const t of rel.transports) {
    const cell = cellById.get(t.fulfillment_id);
    if (cell) routes.set(`${cell.option_id}|${cell.fulfillment_type}|${t.method}`, t as unknown as Row);
  }
  return {
    values: new Map(rel.values.map((v) => [v.id, v as unknown as Row] as const)),
    colors: new Map(rel.colors.map((c) => [c.id, c as unknown as Row] as const)),
    variants: new Map(variants.map((v) => [String(v.id), v] as const)),
    cells: new Map(rel.fulfillments.map((f) => [`${f.option_id}|${f.fulfillment_type}`, f as unknown as Row] as const)),
    routes,
  };
}

async function storedSelectors(db: D1Database, productId: string | null): Promise<StoredSelectors> {
  if (!productId) return selectorsOf({ groups: [], values: [], colors: [], links: [], fulfillments: [], transports: [] }, []);
  const rel = await loadProductRelations(db, productId);
  const variants = await db
    .prepare('SELECT id, regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd FROM product_variants WHERE product_id = ?')
    .bind(productId)
    .all<Row>()
    .then((r) => r.results ?? [])
    .catch(() => [] as Row[]);
  return selectorsOf(rel, variants);
}

function holdCells(cells: unknown, optionOf: (cell: Row) => string, s: StoredSelectors, costs: boolean, where: string, sink?: string[]): void {
  if (!Array.isArray(cells)) return;
  for (const cell of cells) {
    if (!isRow(cell)) continue;
    const option = optionOf(cell);
    const type = String(cell.fulfillment_type ?? '');
    const at = `${where}.${option}.${type}`;
    const twin = s.cells.get(`${option}|${type}`) ?? null;
    holdRow(cell, twin, LEGACY_ROW_PRICE_KEYS, 5, at, sink);
    if (costs) holdRow(cell, twin, LEGACY_ROW_COST_KEYS, 5, at, sink);
    if (!Array.isArray(cell.transports)) continue;
    for (const route of cell.transports) {
      if (!isRow(route)) continue;
      const method = String(route.method ?? '');
      const routeTwin = s.routes.get(`${option}|${type}|${method}`) ?? null;
      holdRow(route, routeTwin, [...LEGACY_ROW_PRICE_KEYS, 'surcharge_iqd'], 5, `${at}.${method}`, sink);
      if (costs) holdRow(route, routeTwin, LEGACY_ROW_COST_KEYS, 5, `${at}.${method}`, sink);
    }
  }
}

/**
 * THE SELECTORS (section ٥): the product save's `relations` and the relations
 * door's body (`groups[].values[]` with their `fulfillments[].transports[]`,
 * `colors[]`, `variants[]`). Mutates the body in place.
 */
export async function holdLegacyRelationMoney(db: D1Database, productId: string | null, relations: Row | null, opts: { costs: boolean }): Promise<void> {
  if (!relations) return;
  relationMoney(relations, await storedSelectors(db, productId), opts.costs);
}

/** The planner's PIN of a relations body against its snapshot (see `pinLegacyDocMoney`). */
export function pinLegacyRelationMoney(relations: Row | null, stored: StoredSelectors, costs: boolean): string[] {
  const sink: string[] = [];
  if (relations) relationMoney(relations, stored, costs, sink);
  return sink;
}

function relationMoney(relations: Row, s: StoredSelectors, costs: boolean, sink?: string[]): void {
  const groups = Array.isArray(relations.groups) ? relations.groups : [];
  for (const g of groups) {
    if (!isRow(g) || !Array.isArray(g.values)) continue;
    for (const v of g.values) {
      if (!isRow(v)) continue;
      const id = String(v.id ?? '');
      const twin = s.values.get(id) ?? null;
      holdRow(v, twin, LEGACY_ROW_PRICE_KEYS, 5, `values.${id}`, sink);
      if (costs) holdRow(v, twin, LEGACY_ROW_COST_KEYS, 5, `values.${id}`, sink);
      holdCells(v.fulfillments, () => id, s, costs, 'cells', sink);
    }
  }
  for (const [list, stored] of [['colors', s.colors], ['variants', s.variants]] as const) {
    const rows = relations[list];
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!isRow(r)) continue;
      const id = String(r.id ?? '');
      const twin = stored.get(id) ?? null;
      holdRow(r, twin, LEGACY_ROW_PRICE_KEYS, 5, `${list}.${id}`, sink);
      if (costs) holdRow(r, twin, LEGACY_ROW_COST_KEYS, 5, `${list}.${id}`, sink);
    }
  }
}

/** The order-type door's body (`fulfillments[]` with `option_id`). Mutates the body in place. */
export async function holdLegacyCellMoney(db: D1Database, productId: string, body: Row, opts: { costs: boolean }): Promise<void> {
  if (!Array.isArray(body.fulfillments)) return;
  const s = await storedSelectors(db, productId);
  holdCells(body.fulfillments, (cell) => String(cell.option_id ?? ''), s, opts.costs, 'cells');
}
