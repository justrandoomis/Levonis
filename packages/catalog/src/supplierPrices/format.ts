/**
 * The supplier price file, `levonis.supplier-prices.v1` (docs/SMART_PRICING.md
 * §3.2): one dated capture of one supplier's official prices — the Tmall store
 * in CNY, the Bambu Lab EU store in EUR, or the US store in USD (a reference).
 * Every capture tool emits it and the owner's upload door reads it with this
 * one strict parser, chunk by chunk.
 *
 *   { "format": "levonis.supplier-prices.v1",
 *     "source": "tmall_cn", "currency": "CNY", "price_basis": "list",
 *     "capture": "browser_sweep", "captured_on": "2026-10-31", "captured_by": "browser sweep",
 *     "items": [ { "item_key": "1053109777521", "url": "https://detail.tmall.com/item.htm?id=1053109777521",
 *       "page_host": "detail.tmall.com", "title": "…", "name_en": "…", "category": "tool",
 *       "sourcing": "CHINA_CNY", "freight_route": "CHINA_SEA_OR_AIR", "codes": ["ZH121"], "props": [ … ],
 *       "skus": [ { "sku_key": "6264995743059", "options": {"商品规格": "…"}, "options_en": { … },
 *                   "price": "40", "price_label": "优惠前", "quantity": 59, "sku_code": "" } ] } ] }
 *
 * Rules (each refusal names the path and a reason code):
 *   - keys are strict: an unknown key is refused by name, at every level;
 *   - the source pairs with its currency (tmall_cn/CNY, bambu_eu/EUR, bambu_us/USD), as the
 *     0218 CHECK does: a geo-redirected "EU" page that carries USD can never be read as EUR;
 *     an item's `url` and `page_host` must be the source's own host for the same reason;
 *   - a price is decimal text in the 0181 grammar (digits, at most one point, > 0, ≤ 24
 *     characters), kept exactly as captured; a JSON number is accepted only when its
 *     shortest decimal form has at most two decimals (the engine refuses binary floats);
 *   - `price_label` is the words printed beside the price (Tmall: 优惠前, "before
 *     discounts"), never a figure: a bare amount there is refused;
 *   - ids: a Tmall item or SKU id is digits only; a store item key is the store handle
 *     (lower case, no space, slash, `?`, `#` or `%`); a store SKU key is the variant id
 *     (the JSON-LD `sku`, e.g. 596571526982115329) or, when a page has none, the Bambu
 *     SKU code;
 *   - at most 20,000 items, 200 SKUs per item and 200,000 SKUs in all; at least one item
 *     and one SKU per item; no duplicate item key, no duplicate SKU key within an item;
 *   - every string within its 0218 column's limit (counted in UTF-16 units, never fewer
 *     than SQLite's characters), and no control or bidi-override character.
 *
 * Store captures, whose JSON-LD names no option group, key the variant's values by
 * position: `{"option1": "H2D AMS Combo", "option2": "Standard"}`.
 *
 * Owner-only data (invariant I6): nothing here reaches a customer.
 */

export const SUPPLIER_PRICE_FORMAT = 'levonis.supplier-prices.v1' as const;

export const SUPPLIER_SOURCES = ['tmall_cn', 'bambu_eu', 'bambu_us'] as const;
export type SupplierSource = (typeof SUPPLIER_SOURCES)[number];

export const SUPPLIER_CURRENCIES = ['CNY', 'EUR', 'USD'] as const;
export type SupplierCurrency = (typeof SUPPLIER_CURRENCIES)[number];

/** The one currency each source sells in (the 0218 snapshot CHECK). */
export const SOURCE_CURRENCY: Readonly<Record<SupplierSource, SupplierCurrency>> = Object.freeze({
  tmall_cn: 'CNY',
  bambu_eu: 'EUR',
  bambu_us: 'USD',
});

export const PRICE_BASES = ['list', 'net_of_vat'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

export const CAPTURE_KINDS = ['browser_sweep', 'store_script', 'open_api'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const SOURCING_HINTS = ['', 'EU_STORE_EUR', 'CHINA_CNY'] as const;
export type SourcingHint = (typeof SOURCING_HINTS)[number];

export const ROUTE_HINTS = ['', 'GERMANY_LAND', 'CHINA_SEA', 'CHINA_SEA_OR_AIR'] as const;
export type RouteHint = (typeof ROUTE_HINTS)[number];

/** The caps, each the 0218 column's (or table's) own. */
export const SUPPLIER_PRICE_LIMITS = Object.freeze({
  items: 20000,
  skusPerItem: 200,
  skus: 200000,
  itemKey: 120,
  skuKey: 120,
  url: 600,
  pageHost: 120,
  title: 400,
  nameEn: 400,
  category: 40,
  capturedBy: 120,
  itemCodesJson: 4000,
  skuCodesJson: 2000,
  propsJson: 16000,
  optionsJson: 2000,
  skuCode: 120,
  price: 24,
  priceLabel: 60,
  code: 40,
  optionName: 120,
  optionValue: 400,
});

export interface SupplierPriceSku {
  /** Tmall sku_id | store variant id (or the SKU code when a page has no variant id). */
  sku_key: string;
  /** The option values as the page names them, by group (store captures: `option1`, `option2`, …). */
  options: Record<string, string>;
  options_en: Record<string, string>;
  /** Decimal text, exactly as captured, in the snapshot's currency. */
  price: string;
  /** The words printed beside the price (Tmall: 优惠前), '' when none. Never a figure. */
  price_label: string;
  quantity: number | null;
  /** The Bambu SKU code from the store's JSON-LD, '' when none. */
  sku_code: string;
  /** Codes the capture tool found on this SKU (colour codes, part codes). */
  codes: string[];
}

export interface SupplierPriceItem {
  /** Tmall item id | store handle: stable across captures. */
  item_key: string;
  url: string;
  /** The host that actually served the page. */
  page_host: string;
  title: string;
  name_en: string;
  category: string;
  sourcing: SourcingHint;
  freight_route: RouteHint;
  codes: string[];
  props: unknown[];
  skus: SupplierPriceSku[];
}

export interface SupplierPriceHeader {
  source: SupplierSource;
  currency: SupplierCurrency;
  price_basis: PriceBasis;
  capture: CaptureKind;
  captured_on: string;
  captured_by: string;
}

export interface SupplierPriceFile extends SupplierPriceHeader {
  format: typeof SUPPLIER_PRICE_FORMAT;
  items: SupplierPriceItem[];
}

export type SupplierPriceFormatReason =
  | 'not_json'
  | 'wrong_type'
  | 'unknown_key'
  | 'missing_key'
  | 'not_allowed_value'
  | 'currency_mismatch'
  | 'too_long'
  | 'too_many'
  | 'empty'
  | 'duplicate'
  | 'bad_id'
  | 'bad_url'
  | 'bad_host'
  | 'bad_date'
  | 'bad_price'
  | 'float_price'
  | 'figure_in_label'
  | 'control_character';

/** What the owner reads when an upload is refused (the path and reason follow it). */
export const SUPPLIER_PRICE_FORMAT_MESSAGE = Object.freeze({
  ar: 'ملف أسعار المورّد غير صالح، فلم يُرفع منه شيء.',
  en: 'The supplier price file is not valid, so nothing from it was uploaded.',
  ckb: 'فایلی نرخەکانی دابینکەر دروست نییە، بۆیە هیچ شتێکی لێ بار نەکرا.',
});

export class SupplierPriceFormatError extends Error {
  readonly code = 'SUPPLIER_PRICE_FORMAT_INVALID';
  readonly status = 400;
  constructor(
    readonly path: string,
    readonly reason: SupplierPriceFormatReason
  ) {
    super(`${SUPPLIER_PRICE_FORMAT_MESSAGE.en} (${reason} at ${path})`);
    this.name = 'SupplierPriceFormatError';
  }
}

const fail = (path: string, reason: SupplierPriceFormatReason): never => {
  throw new SupplierPriceFormatError(path, reason);
};

// ---------------------------------------------------------------- grammars

/** The 0181 decimal grammar: digits, at most one point, never a trailing point. */
const DECIMAL_TEXT = /^[0-9]+(?:\.[0-9]+)?$/;
/** A JSON number's shortest form with at most two decimals. */
const TWO_DECIMALS = /^[0-9]+(?:\.[0-9]{1,2})?$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TMALL_ID = /^[0-9]{1,40}$/;
/** A store SKU key: the variant id (digits) or a Bambu SKU code (A00-W1-1.75-1000-SPLFREE, B-SA001+B-QA013). */
const STORE_SKU_KEY = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$/;
/** Characters a store handle never holds (Shopify handles may hold non-ASCII letters: `waffenträger`). */
const HANDLE_REFUSED = /[\s/?#%\\"'<>`]/u;
const CATEGORY = /^[a-z][a-z0-9_]{0,39}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,118}[a-z0-9])?$/;
/** A price smuggled into the label: a currency sign, or a bare amount. */
const FIGURE_LABEL = /[¥￥$€]|^\s*[0-9]+(?:[.,][0-9]+)?\s*(?:元|CNY|EUR|USD)?\s*$/i;

/** C0 and C1 controls and the bidi overrides, which could disguise text in the owner's panel. */
function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

/** True for decimal text the 0181 price grammar accepts (≤ 24 characters, > 0). */
export function isSupplierPriceText(s: unknown): s is string {
  return typeof s === 'string' && s.length <= SUPPLIER_PRICE_LIMITS.price && DECIMAL_TEXT.test(s) && /[1-9]/.test(s);
}

/**
 * A captured price as decimal text: text in the 0181 grammar is kept exactly as captured;
 * a JSON number only when its shortest decimal form has at most two decimals (27.99 → "27.99",
 * never 0.30000000000000004).
 */
export function supplierPriceText(value: unknown, path = '$'): string {
  if (typeof value === 'string') return isSupplierPriceText(value) ? value : fail(path, 'bad_price');
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return fail(path, 'bad_price');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return fail(path, 'float_price');
    const text = String(value);
    if (!TWO_DECIMALS.test(text)) return fail(path, 'float_price');
    return isSupplierPriceText(text) ? text : fail(path, 'bad_price');
  }
  return fail(path, 'wrong_type');
}

/** The hosts a source's pages may be served from (a redirect to another store is refused). */
export function supplierHostAllowed(source: SupplierSource, host: string): boolean {
  switch (source) {
    case 'tmall_cn':
      return /^(?:[a-z0-9-]+\.)*(?:tmall|taobao)\.com$/.test(host);
    case 'bambu_eu':
      return host === 'eu.store.bambulab.com';
    case 'bambu_us':
      return host === 'us.store.bambulab.com';
    default:
      return false;
  }
}

/** Whether a key fits the source's item-key grammar (Tmall id | store handle). */
export function isSupplierItemKey(source: SupplierSource, key: unknown): key is string {
  if (typeof key !== 'string' || key.length < 1 || key.length > SUPPLIER_PRICE_LIMITS.itemKey) return false;
  if (source === 'tmall_cn') return TMALL_ID.test(key);
  return key === key.toLowerCase() && !HANDLE_REFUSED.test(key) && !hasControlCharacter(key) && key.trim() === key;
}

/** Whether a key fits the source's SKU-key grammar (Tmall sku id | store variant id or SKU code). */
export function isSupplierSkuKey(source: SupplierSource, key: unknown): key is string {
  if (typeof key !== 'string') return false;
  return source === 'tmall_cn' ? TMALL_ID.test(key) : STORE_SKU_KEY.test(key);
}

// ---------------------------------------------------------------- readers

type Obj = Record<string, unknown>;

const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function obj(v: unknown, path: string): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : fail(path, 'wrong_type');
}

function strictKeys(o: Obj, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`, 'unknown_key');
}

function text(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') return fail(path, 'wrong_type');
  if (v.length > max) return fail(path, 'too_long');
  if (hasControlCharacter(v)) return fail(path, 'control_character');
  return v;
}

/** An optional text field: absent → ''. */
function optText(o: Obj, k: string, path: string, max: number): string {
  return has(o, k) ? text(o[k], `${path}.${k}`, max) : '';
}

function required(o: Obj, k: string, path: string): unknown {
  return has(o, k) ? o[k] : fail(`${path}.${k}`, 'missing_key');
}

function oneOf<T extends string>(v: unknown, list: readonly T[], path: string): T {
  if (typeof v !== 'string') return fail(path, 'wrong_type');
  return (list as readonly string[]).includes(v) ? (v as T) : fail(path, 'not_allowed_value');
}

/** The stored JSON's length; a value JSON cannot hold (a BigInt, a cycle) is refused, never thrown as a TypeError. */
function jsonLength(v: unknown, path: string): number {
  try {
    return (JSON.stringify(v) ?? '').length;
  } catch {
    return fail(path, 'wrong_type');
  }
}

function codes(v: unknown, path: string, maxJson: number): string[] {
  if (!Array.isArray(v)) return fail(path, 'wrong_type');
  const out: string[] = [];
  v.forEach((c, i) => {
    const p = `${path}[${i}]`;
    if (typeof c !== 'string') fail(p, 'wrong_type');
    if (!CODE.test(c as string)) fail(p, 'not_allowed_value');
    if (!out.includes(c as string)) out.push(c as string);
  });
  if (jsonLength(out, path) > maxJson) fail(path, 'too_long');
  return out;
}

function options(v: unknown, path: string): Record<string, string> {
  const o = obj(v, path);
  const entries: Array<[string, string]> = [];
  for (const k of Object.keys(o)) {
    const p = `${path}[${JSON.stringify(k)}]`;
    if (!k.trim()) fail(p, 'empty');
    if (k.length > SUPPLIER_PRICE_LIMITS.optionName) fail(p, 'too_long');
    if (hasControlCharacter(k)) fail(p, 'control_character');
    entries.push([k, text(o[k], p, SUPPLIER_PRICE_LIMITS.optionValue)]);
  }
  // fromEntries defines own properties: a "__proto__" group name stays a plain key.
  const out = Object.fromEntries(entries) as Record<string, string>;
  if (jsonLength(out, path) > SUPPLIER_PRICE_LIMITS.optionsJson) fail(path, 'too_long');
  return out;
}

function url(v: unknown, path: string, source: SupplierSource): string {
  const s = text(v, path, SUPPLIER_PRICE_LIMITS.url);
  if (!s) return '';
  if (/[\s\\]/.test(s)) return fail(path, 'bad_url');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return fail(path, 'bad_url');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return fail(path, 'bad_url');
  if (!supplierHostAllowed(source, u.hostname)) return fail(path, 'bad_host');
  const href = u.href;
  return href.length <= SUPPLIER_PRICE_LIMITS.url ? href : fail(path, 'too_long');
}

function pageHost(v: unknown, path: string, source: SupplierSource): string {
  const s = text(v, path, SUPPLIER_PRICE_LIMITS.pageHost);
  if (!s) return '';
  if (!HOST.test(s)) return fail(path, 'bad_host');
  return supplierHostAllowed(source, s) ? s : fail(path, 'bad_host');
}

function capturedOn(v: unknown, path: string): string {
  if (typeof v !== 'string') return fail(path, 'wrong_type');
  const m = DATE.exec(v);
  if (!m) return fail(path, 'bad_date');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || y < 2000) return fail(path, 'bad_date');
  return v;
}

// ---------------------------------------------------------------- the parser

const FILE_KEYS = ['format', 'source', 'currency', 'price_basis', 'capture', 'captured_on', 'captured_by', 'items'] as const;
const HEADER_KEYS = ['source', 'currency', 'price_basis', 'capture', 'captured_on', 'captured_by'] as const;
const ITEM_KEYS = ['item_key', 'url', 'page_host', 'title', 'name_en', 'category', 'sourcing', 'freight_route', 'codes', 'props', 'skus'] as const;
const SKU_KEYS = ['sku_key', 'options', 'options_en', 'price', 'price_label', 'quantity', 'sku_code', 'codes'] as const;

/** The snapshot fields every capture states (the file's header, or the body that opens an upload). */
export const SNAPSHOT_HEADER_KEYS: readonly string[] = HEADER_KEYS;

/**
 * The six header fields of `o` (its other keys are the caller's to check): the source and its
 * currency, the price basis (default 'list'), the capture kind, the date (YYYY-MM-DD, a real
 * day) and who captured it (default '').
 */
export function parseSnapshotHeader(value: unknown, path = '$'): SupplierPriceHeader {
  const o = obj(value, path);
  const source = oneOf(required(o, 'source', path), SUPPLIER_SOURCES, `${path}.source`);
  const currency = oneOf(required(o, 'currency', path), SUPPLIER_CURRENCIES, `${path}.currency`);
  if (currency !== SOURCE_CURRENCY[source]) fail(`${path}.currency`, 'currency_mismatch');
  return {
    source,
    currency,
    price_basis: has(o, 'price_basis') ? oneOf(o.price_basis, PRICE_BASES, `${path}.price_basis`) : 'list',
    capture: oneOf(required(o, 'capture', path), CAPTURE_KINDS, `${path}.capture`),
    captured_on: capturedOn(required(o, 'captured_on', path), `${path}.captured_on`),
    captured_by: optText(o, 'captured_by', path, SUPPLIER_PRICE_LIMITS.capturedBy),
  };
}

function parseSku(v: unknown, path: string, source: SupplierSource): SupplierPriceSku {
  const o = obj(v, path);
  strictKeys(o, SKU_KEYS, path);
  const skuKey = required(o, 'sku_key', path);
  if (typeof skuKey !== 'string') fail(`${path}.sku_key`, 'wrong_type');
  if (!isSupplierSkuKey(source, skuKey)) fail(`${path}.sku_key`, 'bad_id');
  let label = '';
  if (has(o, 'price_label') && o.price_label !== null) {
    label = text(o.price_label, `${path}.price_label`, SUPPLIER_PRICE_LIMITS.priceLabel);
    if (FIGURE_LABEL.test(label)) fail(`${path}.price_label`, 'figure_in_label');
  }
  let quantity: number | null = null;
  if (has(o, 'quantity') && o.quantity !== null) {
    const q = o.quantity;
    if (typeof q !== 'number' || !Number.isSafeInteger(q) || q < 0) fail(`${path}.quantity`, 'wrong_type');
    quantity = q as number;
  }
  const skuCode = optText(o, 'sku_code', path, SUPPLIER_PRICE_LIMITS.skuCode);
  if (skuCode && !STORE_SKU_KEY.test(skuCode)) fail(`${path}.sku_code`, 'not_allowed_value');
  return {
    sku_key: skuKey as string,
    options: has(o, 'options') ? options(o.options, `${path}.options`) : {},
    options_en: has(o, 'options_en') ? options(o.options_en, `${path}.options_en`) : {},
    price: supplierPriceText(required(o, 'price', path), `${path}.price`),
    price_label: label,
    quantity,
    sku_code: skuCode,
    codes: has(o, 'codes') ? codes(o.codes, `${path}.codes`, SUPPLIER_PRICE_LIMITS.skuCodesJson) : [],
  };
}

function parseItem(v: unknown, path: string, source: SupplierSource): SupplierPriceItem {
  const o = obj(v, path);
  strictKeys(o, ITEM_KEYS, path);
  const itemKey = required(o, 'item_key', path);
  if (typeof itemKey !== 'string') fail(`${path}.item_key`, 'wrong_type');
  if (!isSupplierItemKey(source, itemKey)) fail(`${path}.item_key`, 'bad_id');
  const category = optText(o, 'category', path, SUPPLIER_PRICE_LIMITS.category);
  if (category && !CATEGORY.test(category)) fail(`${path}.category`, 'not_allowed_value');
  let props: unknown[] = [];
  if (has(o, 'props')) {
    if (!Array.isArray(o.props)) fail(`${path}.props`, 'wrong_type');
    props = o.props as unknown[];
    if (jsonLength(props, `${path}.props`) > SUPPLIER_PRICE_LIMITS.propsJson) fail(`${path}.props`, 'too_long');
  }
  const rawSkus = required(o, 'skus', path);
  if (!Array.isArray(rawSkus)) fail(`${path}.skus`, 'wrong_type');
  const list = rawSkus as unknown[];
  if (!list.length) fail(`${path}.skus`, 'empty');
  if (list.length > SUPPLIER_PRICE_LIMITS.skusPerItem) fail(`${path}.skus`, 'too_many');
  const seen = new Set<string>();
  const skus = list.map((s, i) => {
    const sku = parseSku(s, `${path}.skus[${i}]`, source);
    if (seen.has(sku.sku_key)) fail(`${path}.skus[${i}].sku_key`, 'duplicate');
    seen.add(sku.sku_key);
    return sku;
  });
  return {
    item_key: itemKey as string,
    url: has(o, 'url') ? url(o.url, `${path}.url`, source) : '',
    page_host: has(o, 'page_host') ? pageHost(o.page_host, `${path}.page_host`, source) : '',
    title: optText(o, 'title', path, SUPPLIER_PRICE_LIMITS.title),
    name_en: optText(o, 'name_en', path, SUPPLIER_PRICE_LIMITS.nameEn),
    category,
    sourcing: has(o, 'sourcing') ? oneOf(o.sourcing, SOURCING_HINTS, `${path}.sourcing`) : '',
    freight_route: has(o, 'freight_route') ? oneOf(o.freight_route, ROUTE_HINTS, `${path}.freight_route`) : '',
    codes: has(o, 'codes') ? codes(o.codes, `${path}.codes`, SUPPLIER_PRICE_LIMITS.itemCodesJson) : [],
    props,
    skus,
  };
}

export interface ParseItemsOptions {
  /** The path of the array (default `$.items`). */
  path?: string;
  /** The index of the first element in the whole file, so a chunk's refusal names the file's position. */
  offset?: number;
  /** The most items accepted (default the file's 20,000; the upload door passes its chunk size). */
  max?: number;
}

/**
 * An array of items of one source — a whole file's, or one upload chunk's: each item, its SKUs
 * and its strings checked; no duplicate item key in the array.
 */
export function parseSupplierPriceItems(value: unknown, source: SupplierSource, opts: ParseItemsOptions = {}): SupplierPriceItem[] {
  const path = opts.path ?? '$.items';
  const offset = opts.offset ?? 0;
  const max = Math.min(opts.max ?? SUPPLIER_PRICE_LIMITS.items, SUPPLIER_PRICE_LIMITS.items);
  if (!(SUPPLIER_SOURCES as readonly string[]).includes(source)) fail('$.source', 'not_allowed_value');
  if (!Array.isArray(value)) return fail(path, 'wrong_type');
  if (!value.length) return fail(path, 'empty');
  if (value.length > max) return fail(path, 'too_many');
  const seen = new Set<string>();
  let skus = 0;
  return value.map((v, i) => {
    const p = `${path}[${offset + i}]`;
    const item = parseItem(v, p, source);
    if (seen.has(item.item_key)) fail(`${p}.item_key`, 'duplicate');
    seen.add(item.item_key);
    skus += item.skus.length;
    if (skus > SUPPLIER_PRICE_LIMITS.skus) fail(`${p}.skus`, 'too_many');
    return item;
  });
}

/**
 * The whole file, from its JSON text or its parsed value. Throws SupplierPriceFormatError
 * {path, reason} at the first refusal; returns a fresh value with every default filled in.
 */
export function parseSupplierPriceFile(json: unknown): SupplierPriceFile {
  let value = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json);
    } catch {
      return fail('$', 'not_json');
    }
  }
  const o = obj(value, '$');
  strictKeys(o, FILE_KEYS, '$');
  if (required(o, 'format', '$') !== SUPPLIER_PRICE_FORMAT) fail('$.format', 'not_allowed_value');
  const header = parseSnapshotHeader(o, '$');
  const items = parseSupplierPriceItems(required(o, 'items', '$'), header.source);
  return { format: SUPPLIER_PRICE_FORMAT, ...header, items };
}

/** The number of SKUs in a parsed file (what the snapshot's `sku_count` must equal). */
export const skuCountOf = (items: readonly SupplierPriceItem[]): number => items.reduce((n, it) => n + it.skus.length, 0);
