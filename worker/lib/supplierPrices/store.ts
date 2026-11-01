/**
 * THE OWNER'S SUPPLIER PRICES, AS AN ESTIMATE READS THEM
 * (docs/SMART_PRICING.md §3.6, §3.7; migration 0218; DECISIONS rows 278–281).
 *
 * The supplier price catalogue is the owner's own: dated captures of Bambu
 * Lab's official prices (Tmall in CNY, the EU store in EUR, the US store in
 * USD as a reference), the matches that tie a catalogue SKU to a Levonis SKU,
 * and the owner's typed (or one store page) prices. Nothing here reaches a
 * customer (invariant I6): every caller sits behind requireCostRead.
 *
 * WHICH PRICE A SKU USES (§3.7), the first available:
 *
 *   #  CHINA_CNY types                    EU_STORE_EUR types
 *   1  the owner's manual entry (typed or one store page, any currency)
 *   2  the confirmed tmall_cn match       the confirmed bambu_eu match
 *   3  —                                  the confirmed bambu_us match, only where the
 *                                         type allows the US reference (EST_US_REFERENCE)
 *   4  no price (EST_NO_PRICE; EST_MATCH_REVIEW when only a suggestion exists)
 *
 * A confirmed match prices from the SKU row of its source's CURRENT complete
 * snapshot (ux_sps_current). A key missing from it gives no price from that
 * rung (EST_SOURCE_ITEM_MISSING) and the next rung is asked; nothing is ever
 * inferred from a sibling SKU. A pack is divided only when the owner set
 * `units_per_offer` (EST_UNITS_DIVIDED): ceil(price / units) to four decimals,
 * exactly, with BigInt rationals — the cost is never understated.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): every read here tolerates a database
 * without 0218 — no table, no supplier price.
 */
import { auditStatements } from '../audit';
import { HttpError, notFound } from '../http';
import { fence, isFenceMiss } from '../operations';
import { loadProducts, type LoadedProduct } from '../pricingEngine/load';
import { sellableSkus, unitNamesOf } from '../pricingEngine/legacy';
import { inputInvalid } from '../pricingEngine/whatIf';
import { isMissingEstimateSchema } from '../priceEstimateLabel';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { estimateServerMessage, type EstimateFlag } from '@levonis/contracts/priceEstimates';
import {
  SOURCE_CURRENCY,
  SUPPLIER_CURRENCIES,
  SUPPLIER_SOURCES,
  SupplierPriceFormatError,
  isSupplierPriceText,
  supplierPriceText,
  type SupplierCurrency,
  type SupplierSource,
} from '@levonis/catalog/supplierPrices/format';

export { SOURCE_CURRENCY, SUPPLIER_CURRENCIES, SUPPLIER_SOURCES, type SupplierCurrency, type SupplierSource };

// ---------------------------------------------------------------- refusals and bodies

/** 503 PRICE_ESTIMATES_NOT_INSTALLED: an owner route on a database without migration 0218 (§2.4). */
export function estimatesNotInstalled(): HttpError {
  return new HttpError(503, estimateServerMessage('PRICE_ESTIMATES_NOT_INSTALLED'), 'PRICE_ESTIMATES_NOT_INSTALLED');
}

/** 400 UNKNOWN_FIELD {field}: a body key the route does not read (the NAME only, never a value). */
export function unknownField(field: string): HttpError {
  return new HttpError(400, serverMessage('UNKNOWN_FIELD'), 'UNKNOWN_FIELD', { field });
}

/** 409 PRICING_CHANGED: someone wrote between the owner's read and this write. */
export function pricingChanged(): HttpError {
  return new HttpError(409, serverMessage('PRICING_CHANGED'), 'PRICING_CHANGED');
}

/** Refuses any key of `body` outside `allowed` (UNKNOWN_FIELD). */
export function strictBody(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw unknownField(k);
}

const PRODUCT_ID = /^[A-Za-z0-9_:.-]{1,80}$/;
/** A product id as the owner's routes accept it in a path or a body. */
export const isProductId = (v: unknown): v is string => typeof v === 'string' && PRODUCT_ID.test(v);

/** C0 and C1 controls and the bidi overrides, which could disguise text in the owner's panel. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
export const hasControlCharacter = (s: string): boolean => CONTROL.test(s);

export const isSupplierSource = (v: unknown): v is SupplierSource => typeof v === 'string' && (SUPPLIER_SOURCES as readonly string[]).includes(v);
export const isSupplierCurrency = (v: unknown): v is SupplierCurrency => typeof v === 'string' && (SUPPLIER_CURRENCIES as readonly string[]).includes(v);

/** `rows` of a read, or [] when the database has no 0218 table to read; any other error is thrown. */
export async function absentAsEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (e) {
    if (isMissingEstimateSchema(e)) return [];
    throw e;
  }
}

// ---------------------------------------------------------------- the current snapshots

export interface CurrentSnapshot {
  id: string;
  source: SupplierSource;
  currency: SupplierCurrency;
  captured_on: string;
  price_basis: string;
}

export const CURRENT_SNAPSHOTS_SQL = "SELECT id, source, currency, captured_on, price_basis FROM supplier_price_snapshots WHERE state = 'complete'";

/** Each source's current complete snapshot (at most one per source: ux_sps_current). */
export function currentSnapshotsOf(rows: readonly Record<string, unknown>[]): Map<SupplierSource, CurrentSnapshot> {
  const out = new Map<SupplierSource, CurrentSnapshot>();
  for (const r of rows) {
    if (!isSupplierSource(r.source) || !isSupplierCurrency(r.currency)) continue;
    out.set(r.source, { id: String(r.id), source: r.source, currency: r.currency, captured_on: String(r.captured_on ?? ''), price_basis: String(r.price_basis ?? 'list') });
  }
  return out;
}

export async function currentSnapshots(db: D1Database): Promise<Map<SupplierSource, CurrentSnapshot>> {
  return currentSnapshotsOf(await absentAsEmpty(async () => (await db.prepare(CURRENT_SNAPSHOTS_SQL).all<Record<string, unknown>>()).results ?? []));
}

// ---------------------------------------------------------------- exact unit price

/**
 * The price of one unit of an offer of `units` (the owner's division of a pack):
 * ceil(price / units) at four decimals, computed exactly (BigInt rationals), so a
 * cost is never understated. `units` 1 answers the price as it is.
 */
export function unitPriceOf(price: string, units: number): string {
  if (!isSupplierPriceText(price)) throw new Error('SUPPLIER_PRICE_INVARIANT: not a decimal price');
  if (!Number.isSafeInteger(units) || units < 1 || units > 1000) throw new Error('SUPPLIER_PRICE_INVARIANT: units out of range');
  if (units === 1) return price;
  const [whole = '', frac = ''] = price.split('.');
  const scaled = BigInt(`${whole}${frac}`) * 10_000n;
  const den = 10n ** BigInt(frac.length) * BigInt(units);
  const q = (scaled + den - 1n) / den;
  const digits = q.toString().padStart(5, '0');
  const int = digits.slice(0, -4).replace(/^0+(?=\d)/, '');
  const dec = digits.slice(-4).replace(/0+$/, '');
  return dec ? `${int}.${dec}` : int;
}

// ---------------------------------------------------------------- the Levonis SKUs

export interface ProductSku {
  /** The canonical skuComboKey; '' is the product itself. */
  combo_key: string;
  option_value_ids: string[];
  color_id: string | null;
  /** The SKU's option and colour names, joined by « · » ('' for the product itself). */
  labels: { ar: string; en: string; ckb: string };
}

export interface ProductSkus {
  product_id: string;
  /** products.name (English) and the three names of the document. */
  name: string;
  names: { ar: string; en: string; ckb: string };
  /** Every structurally sellable SKU (`sellableSkus`), or null when the grid overflows ENGINE_MAX_SKUS. */
  skus: ProductSku[] | null;
  loaded: LoadedProduct;
}

/** The products named, as the cart reads them, with their sellable SKUs and their names; an unknown id is absent. */
export async function loadProductSkus(db: D1Database, ids: readonly string[]): Promise<Map<string, ProductSkus>> {
  const loaded = await loadProducts(db, ids);
  const out = new Map<string, ProductSkus>();
  for (const [id, product] of loaded) {
    // `loadProducts` already laid the relations over the row (applyRelations), as the cart does.
    const doc = product.doc;
    const grid = sellableSkus(doc, product.view);
    const skus = grid.overflow
      ? null
      : grid.skus.map((s): ProductSku => {
          const names = unitNamesOf(doc, s.option_value_ids, s.color);
          return {
            combo_key: s.combo_key,
            option_value_ids: [...s.option_value_ids],
            color_id: s.color?.id ?? null,
            labels: { ar: names.name_ar, en: names.name_en, ckb: names.name_ckb },
          };
        });
    out.set(id, {
      product_id: id,
      name: String(product.row.name ?? ''),
      names: { ar: doc.name_ar ?? '', en: doc.name_en ?? '', ckb: doc.name_ckb ?? '' },
      skus,
      loaded: product,
    });
  }
  return out;
}

// ---------------------------------------------------------------- version tokens

/**
 * A product's version token over its rows of one table: count, sum of row
 * versions and the latest stamp. The owner's review reads it and a decision
 * carries it back; the write is fenced on the very same expression, so any
 * change in between — another tab, a match run — refuses with PRICING_CHANGED.
 */
export const MATCHES_TOKEN_SQL =
  "(SELECT COUNT(*) || '.' || COALESCE(SUM(version), 0) || '.' || COALESCE(MAX(updated_at), '') FROM supplier_price_matches WHERE product_id = ?)";
export const MANUAL_TOKEN_SQL =
  "(SELECT COUNT(*) || '.' || COALESCE(SUM(version), 0) || '.' || COALESCE(MAX(entered_at), '') FROM supplier_price_manual WHERE product_id = ?)";
/** The token of a product with no row. */
export const EMPTY_TOKEN = '0.0.';

/** The two tokens of each product named (one batch of two statements). */
export async function versionTokens(db: D1Database, ids: readonly string[]): Promise<Map<string, { matches: string; manual: string }>> {
  const out = new Map<string, { matches: string; manual: string }>();
  for (const id of ids) out.set(id, { matches: EMPTY_TOKEN, manual: EMPTY_TOKEN });
  if (!ids.length) return out;
  const list = JSON.stringify([...new Set(ids)]);
  let results: Array<{ results?: Record<string, unknown>[] }> = [];
  try {
    results = (await db.batch([
      db
        .prepare(
          `SELECT product_id, COUNT(*) || '.' || COALESCE(SUM(version), 0) || '.' || COALESCE(MAX(updated_at), '') AS token
             FROM supplier_price_matches WHERE product_id IN (SELECT value FROM json_each(?)) GROUP BY product_id`
        )
        .bind(list),
      db
        .prepare(
          `SELECT product_id, COUNT(*) || '.' || COALESCE(SUM(version), 0) || '.' || COALESCE(MAX(entered_at), '') AS token
             FROM supplier_price_manual WHERE product_id IN (SELECT value FROM json_each(?)) GROUP BY product_id`
        )
        .bind(list),
    ])) as Array<{ results?: Record<string, unknown>[] }>;
  } catch (e) {
    if (isMissingEstimateSchema(e)) return out;
    throw e;
  }
  for (const r of results[0]?.results ?? []) {
    const t = out.get(String(r.product_id));
    if (t) t.matches = String(r.token);
  }
  for (const r of results[1]?.results ?? []) {
    const t = out.get(String(r.product_id));
    if (t) t.manual = String(r.token);
  }
  return out;
}

// ---------------------------------------------------------------- the owner's manual prices

export interface ManualWrite {
  combo_key: string;
  /** Decimal text in the 0181 grammar; null removes the owner's price for this SKU. */
  amount: string | null;
  currency: SupplierCurrency | null;
  note: string;
}

export interface ManualEvidence {
  origin: 'typed' | 'store_page';
  /** The store page read (origin store_page only): its final address and host. Never turned into a link. */
  url: string;
  host: string;
}

/**
 * The statements that write the owner's prices of one product: an upsert (each
 * row's `version` moves) and a delete for the SKUs whose price he removed.
 * Bound through json_each: one list per statement, whatever its length.
 */
export function manualWriteStatements(
  db: D1Database,
  productId: string,
  entries: readonly ManualWrite[],
  evidence: ManualEvidence,
  actor: string,
  now: string
): D1PreparedStatement[] {
  const set = entries.filter((e) => e.amount !== null).map((e) => ({ c: e.combo_key, a: e.amount, u: e.currency, n: e.note }));
  const drop = entries.filter((e) => e.amount === null).map((e) => e.combo_key);
  const out: D1PreparedStatement[] = [];
  if (set.length) {
    out.push(
      db
        .prepare(
          `INSERT INTO supplier_price_manual
             (product_id, combo_key, amount, currency, origin, evidence_url, evidence_host, note, entered_by, entered_at, version)
           SELECT ?1, json_extract(j.value, '$.c'), json_extract(j.value, '$.a'), json_extract(j.value, '$.u'), ?2, ?3, ?4,
                  json_extract(j.value, '$.n'), ?5, ?6, 1
             FROM json_each(?7) j WHERE 1
           ON CONFLICT(product_id, combo_key) DO UPDATE SET
             amount = excluded.amount, currency = excluded.currency, origin = excluded.origin,
             evidence_url = excluded.evidence_url, evidence_host = excluded.evidence_host, note = excluded.note,
             entered_by = excluded.entered_by, entered_at = excluded.entered_at,
             version = supplier_price_manual.version + 1`
        )
        .bind(productId, evidence.origin, evidence.origin === 'store_page' ? evidence.url : '', evidence.origin === 'store_page' ? evidence.host : '', actor, now, JSON.stringify(set))
    );
  }
  if (drop.length) {
    out.push(
      db
        .prepare('DELETE FROM supplier_price_manual WHERE product_id = ?1 AND combo_key IN (SELECT value FROM json_each(?2))')
        .bind(productId, JSON.stringify(drop))
    );
  }
  return out;
}

/** The most SKUs one manual entry or store-page save names (ENGINE_MAX_SKUS). */
export const MANUAL_MAX_SKUS = 240;

/** The products' sellable SKUs a body names: each a combo key of the product, none twice; 400 PRICING_INPUT_INVALID otherwise. */
export function sellableComboKeys(product: ProductSkus, keys: unknown, field = 'combo_keys'): string[] {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MANUAL_MAX_SKUS) throw inputInvalid(field);
  const sellable = new Set((product.skus ?? []).map((s) => s.combo_key));
  const seen = new Set<string>();
  for (const k of keys) {
    if (typeof k !== 'string' || !sellable.has(k) || seen.has(k)) throw inputInvalid(field);
    seen.add(k);
  }
  return [...seen];
}

/** The owner's typed prices of one SKU list (PUT /manual/:product_id `skus`). */
export function parseManualEntries(raw: unknown, product: ProductSkus): ManualWrite[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MANUAL_MAX_SKUS) throw inputInvalid('skus');
  const sellable = new Set((product.skus ?? []).map((s) => s.combo_key));
  const seen = new Set<string>();
  return raw.map((x): ManualWrite => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw inputInvalid('skus');
    const o = x as Record<string, unknown>;
    strictBody(o, ['combo_key', 'amount', 'currency', 'note']);
    if (typeof o.combo_key !== 'string' || !sellable.has(o.combo_key) || seen.has(o.combo_key)) throw inputInvalid('combo_key');
    seen.add(o.combo_key);
    if (o.amount === null) return { combo_key: o.combo_key, amount: null, currency: null, note: '' };
    let amount: string;
    try {
      amount = supplierPriceText(o.amount, 'amount');
    } catch (e) {
      if (e instanceof SupplierPriceFormatError) throw inputInvalid('amount');
      throw e;
    }
    if (!isSupplierCurrency(o.currency)) throw inputInvalid('currency');
    const note = o.note === undefined || o.note === null ? '' : o.note;
    if (typeof note !== 'string' || note.trim().length > 300 || hasControlCharacter(note)) throw inputInvalid('note');
    return { combo_key: o.combo_key, amount, currency: o.currency, note: note.trim() };
  });
}

/**
 * PUT /manual/:product_id {version, skus:[{combo_key, amount, currency, note}]}:
 * the owner's typed price per SKU (USD, EUR or CNY), `amount: null` removing
 * it. Fenced on the manual token he read. The UI's "same as colour X" is an
 * explicit owner act stored as `typed` with a note, never an inferred price.
 */
export async function setManualPrices(db: D1Database, productId: string, body: Record<string, unknown>, actor: string, now: Date): Promise<void> {
  strictBody(body, ['version', 'skus']);
  if (!isProductId(productId)) throw notFound();
  if (typeof body.version !== 'string' || body.version.length > 120) throw inputInvalid('version');
  const product = (await loadProductSkus(db, [productId])).get(productId);
  if (!product) throw notFound();
  if (product.skus === null) throw inputInvalid('combo_key');
  const entries = parseManualEntries(body.skus, product);
  if ((await versionTokens(db, [productId])).get(productId)!.manual !== body.version) throw pricingChanged();
  const at = now.toISOString();
  const audit = await auditStatements(db, actor, 'supplier_prices.manual_set', productId, {
    set: entries.filter((e) => e.amount !== null).length,
    removed: entries.filter((e) => e.amount === null).length,
  });
  try {
    await db.batch([
      ...fence(db, `${MANUAL_TOKEN_SQL} = ?`, [productId, body.version]),
      ...manualWriteStatements(db, productId, entries, { origin: 'typed', url: '', host: '' }, actor, at),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isFenceMiss(e)) throw pricingChanged();
    throw e;
  }
}

// ---------------------------------------------------------------- §3.7: the price of each SKU

export type PriceSource = 'tmall_cn' | 'bambu_eu' | 'bambu_us' | 'typed' | 'store_page' | 'none';

export interface SupplierPriceRequest {
  product_id: string;
  /** The SKUs to price (the product's sellable combo keys). */
  combo_keys: readonly string[];
  /** The product's sourcing (its type's, or the owner's override). */
  sourcing: 'EU_STORE_EUR' | 'CHINA_CNY';
  /** Whether the type allows the US store's USD price as a flagged reference (EU types only). */
  us_reference_allowed: boolean;
  /** The type's staleness: a snapshot captured more days ago than this is EST_SNAPSHOT_STALE. */
  stale_after_days?: number | null;
}

export interface SuggestedPrice {
  source: SupplierSource;
  item_key: string;
  sku_key: string;
  amount: string;
  currency: SupplierCurrency;
}

export interface SkuSupplierPrice {
  combo_key: string;
  price_source: PriceSource;
  /** The unit amount in `currency` (after the owner's pack division), decimal text; null when no price. */
  amount: string | null;
  currency: SupplierCurrency | null;
  /** The amount as captured or typed, before any division. */
  offer_amount: string | null;
  units_per_offer: number;
  /** The snapshot the price came from (a catalogue price only). */
  snapshot_id: string | null;
  captured_on: string | null;
  item_key: string | null;
  sku_key: string | null;
  /** Flag CODES only (§4.6): owner-only. */
  flags: EstimateFlag[];
  /** When the SKU has no price but a suggested match of its rung would give one (EST_MATCH_REVIEW). */
  suggestion: SuggestedPrice | null;
}

interface MatchPriceRow {
  product_id: string;
  combo_key: string;
  source: string;
  item_key: string;
  sku_key: string;
  state: string;
  confidence: string;
  units_per_offer: number;
  snapshot_id: string | null;
  captured_on: string | null;
  price: string | null;
  quantity: number | null;
}

interface ManualPriceRow {
  product_id: string;
  combo_key: string;
  amount: string;
  currency: string;
  origin: string;
}

const CONFIDENCE_ORDER: Record<string, number> = { exact: 0, high: 1, medium: 2, low: 3 };

/** Whole days from `captured_on` (YYYY-MM-DD) to `today` (YYYY-MM-DD); NaN when either is not a date. */
export function daysBetween(capturedOn: string, today: string): number {
  const a = Date.parse(`${capturedOn}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / 86_400_000) : NaN;
}

const addFlag = (flags: EstimateFlag[], f: EstimateFlag) => {
  if (!flags.includes(f)) flags.push(f);
};

/**
 * The price each requested SKU uses (§3.7), per product and combo key. Two
 * statements in one batch, whatever the number of products: the owner's
 * manual rows, and the confirmed and suggested matches joined to the SKU row
 * of their source's current complete snapshot.
 */
export async function supplierPricesFor(
  db: D1Database,
  requests: readonly SupplierPriceRequest[],
  opts: { today?: string } = {}
): Promise<Map<string, Map<string, SkuSupplierPrice>>> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const out = new Map<string, Map<string, SkuSupplierPrice>>();
  const ids = [...new Set(requests.map((r) => r.product_id))];
  let manual: ManualPriceRow[] = [];
  let matches: MatchPriceRow[] = [];
  if (ids.length) {
    const list = JSON.stringify(ids);
    try {
      const [m, x] = (await db.batch([
        db
          .prepare('SELECT product_id, combo_key, amount, currency, origin FROM supplier_price_manual WHERE product_id IN (SELECT value FROM json_each(?))')
          .bind(list),
        db
          .prepare(
            `SELECT m.product_id, m.combo_key, m.source, m.item_key, m.sku_key, m.state, m.confidence, m.units_per_offer,
                    s.id AS snapshot_id, s.captured_on, k.price, k.quantity
               FROM supplier_price_matches m
               LEFT JOIN supplier_price_snapshots s ON s.source = m.source AND s.state = 'complete'
               LEFT JOIN supplier_price_skus k ON k.snapshot_id = s.id AND k.item_key = m.item_key AND k.sku_key = m.sku_key
              WHERE m.product_id IN (SELECT value FROM json_each(?)) AND m.state IN ('confirmed', 'suggested')
              ORDER BY m.product_id, m.combo_key, m.source, m.item_key, m.sku_key`
          )
          .bind(list),
      ])) as Array<{ results?: unknown[] }>;
      manual = (m?.results ?? []) as ManualPriceRow[];
      matches = (x?.results ?? []) as MatchPriceRow[];
    } catch (e) {
      if (!isMissingEstimateSchema(e)) throw e;
    }
  }
  const manualBy = new Map<string, ManualPriceRow>(manual.map((r) => [`${r.product_id}\u0000${r.combo_key}`, r]));
  const matchesBy = new Map<string, MatchPriceRow[]>();
  for (const r of matches) {
    const k = `${r.product_id}\u0000${r.combo_key}`;
    if (!matchesBy.has(k)) matchesBy.set(k, []);
    matchesBy.get(k)!.push(r);
  }

  for (const req of requests) {
    const rungs: SupplierSource[] = req.sourcing === 'EU_STORE_EUR' ? ['bambu_eu', ...(req.us_reference_allowed ? (['bambu_us'] as const) : [])] : ['tmall_cn'];
    const perSku = new Map<string, SkuSupplierPrice>();
    for (const combo of req.combo_keys) {
      const flags: EstimateFlag[] = [];
      const key = `${req.product_id}\u0000${combo}`;
      const none = (): SkuSupplierPrice => ({
        combo_key: combo,
        price_source: 'none',
        amount: null,
        currency: null,
        offer_amount: null,
        units_per_offer: 1,
        snapshot_id: null,
        captured_on: null,
        item_key: null,
        sku_key: null,
        flags,
        suggestion: null,
      });
      let answer: SkuSupplierPrice | null = null;

      // 1. The owner's own price, any currency.
      const typed = manualBy.get(key);
      if (typed && isSupplierPriceText(typed.amount) && isSupplierCurrency(typed.currency)) {
        const origin: PriceSource = typed.origin === 'store_page' ? 'store_page' : 'typed';
        addFlag(flags, origin === 'store_page' ? 'EST_STORE_PAGE_PRICE' : 'EST_MANUAL_PRICE');
        answer = { ...none(), price_source: origin, amount: typed.amount, currency: typed.currency, offer_amount: typed.amount };
      }

      // 2–3. The confirmed match of the type's source, then the US reference where allowed.
      const rows = matchesBy.get(key) ?? [];
      if (!answer) {
        for (const source of rungs) {
          const confirmed = rows.find((r) => r.source === source && r.state === 'confirmed');
          if (!confirmed) continue;
          if (confirmed.price === null || !isSupplierPriceText(confirmed.price) || !confirmed.snapshot_id) {
            addFlag(flags, 'EST_SOURCE_ITEM_MISSING');
            continue;
          }
          const units = Number(confirmed.units_per_offer) || 1;
          if (units > 1) addFlag(flags, 'EST_UNITS_DIVIDED');
          if (source === 'bambu_us') addFlag(flags, 'EST_US_REFERENCE');
          if (confirmed.quantity === 0) addFlag(flags, 'EST_SUPPLIER_OUT_OF_STOCK');
          const stale = req.stale_after_days;
          if (typeof stale === 'number' && Number.isFinite(stale) && confirmed.captured_on && daysBetween(confirmed.captured_on, today) > stale) addFlag(flags, 'EST_SNAPSHOT_STALE');
          answer = {
            ...none(),
            price_source: source,
            amount: unitPriceOf(confirmed.price, units),
            currency: SOURCE_CURRENCY[source],
            offer_amount: confirmed.price,
            units_per_offer: units,
            snapshot_id: confirmed.snapshot_id,
            captured_on: confirmed.captured_on,
            item_key: confirmed.item_key,
            sku_key: confirmed.sku_key,
          };
          break;
        }
      }

      // 4. No price: a suggestion of the type's rungs is the owner's to review.
      if (!answer) {
        const suggested = rows
          .filter((r) => r.state === 'suggested' && (rungs as readonly string[]).includes(r.source) && r.price !== null && isSupplierPriceText(r.price))
          .sort((a, b) => rungs.indexOf(a.source as SupplierSource) - rungs.indexOf(b.source as SupplierSource) || (CONFIDENCE_ORDER[a.confidence] ?? 9) - (CONFIDENCE_ORDER[b.confidence] ?? 9))[0];
        answer = none();
        if (suggested && isSupplierSource(suggested.source)) {
          addFlag(flags, 'EST_MATCH_REVIEW');
          answer.suggestion = {
            source: suggested.source,
            item_key: suggested.item_key,
            sku_key: suggested.sku_key,
            amount: suggested.price!,
            currency: SOURCE_CURRENCY[suggested.source],
          };
        } else addFlag(flags, 'EST_NO_PRICE');
      }
      perSku.set(combo, answer);
    }
    out.set(req.product_id, perSku);
  }
  return out;
}

/**
 * The category of each product's confirmed tmall_cn match in the current
 * complete snapshot (§3.8, `supplier_category`): the most frequent one over
 * its matched items, ties broken by the category's name; absent when none.
 */
export async function supplierCategories(db: D1Database, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await absentAsEmpty(
    async () =>
      (
        await db
          .prepare(
            `SELECT m.product_id, i.category, COUNT(*) AS n
               FROM supplier_price_matches m
               JOIN supplier_price_snapshots s ON s.source = m.source AND s.state = 'complete'
               JOIN supplier_price_items i ON i.snapshot_id = s.id AND i.item_key = m.item_key
              WHERE m.product_id IN (SELECT value FROM json_each(?)) AND m.source = 'tmall_cn' AND m.state = 'confirmed' AND i.category <> ''
              GROUP BY m.product_id, i.category
              ORDER BY m.product_id, n DESC, i.category`
          )
          .bind(JSON.stringify([...new Set(ids)]))
          .all<{ product_id: string; category: string }>()
      ).results ?? []
  );
  for (const r of rows) if (!out.has(String(r.product_id))) out.set(String(r.product_id), String(r.category));
  return out;
}
