/**
 * THE BAMBU LAB US OR EU STORE'S OFFERS AS A SUPPLIER PRICE FILE (docs/SMART_PRICING.md §3.1,
 * §3.3; WP4).
 *
 *   node --import tsx scripts/supplier-prices/capture-store-offers.ts --store us|eu
 *        [--manifest data/bambu-import/manifest.json] [--handles h2d,a1] [--list <file.json>]
 *        [--types printer,ams] [--limit N] [--minutes 330] [--date YYYY-MM-DD] [--out <file.v1.json>]
 *
 * Reads the product pages the import manifest lists (`canonical_url`, rewritten to the requested
 * store) and writes their JSON-LD offers as a `levonis.supplier-prices.v1` file (capture
 * "store_script"), by default data/bambu-<store>-prices/<store>-store-offers-<date>.v1.json
 * (git-ignored: the shop's cost basis). The US store gives the USD reference; for the EU store
 * the browser snapshot and normalize-eu-snapshot.mjs are the main path and this is the fallback.
 *
 * POLITE, AS THE IMPORT IS: every request goes through the import's own StoreFetcher
 * (scripts/bambu-import/fetch.ts, used, never edited) with its `origin` option, so the import's
 * robots.txt handling (read once, a Disallow skips the page), its 11 s spacing
 * (STORE_SPACING_MS), its User-Agent, its byte cap and its redirect rules hold. A challenge (a
 * 403, a `cf-mitigated` header or a challenge body: ACCESS_CHALLENGE) stops the run with what it
 * has captured; nothing ever works around one. So do a store that keeps asking to wait and the
 * deadline (--minutes).
 *
 * THE EU STORE sends visitors from Iraq to another region's store unless the address carries
 * `skr=yes`, its skip-region-redirect parameter. Under --store eu every request this script
 * makes, robots.txt included, carries it: the script's own wrapper around the `fetch` that
 * StoreFetcher takes adds it. StoreFetcher never follows a redirect off its origin, so an EU page
 * that still redirects to another region's store is listed as "redirected" and never captured.
 *
 * WHAT IS KEPT. The JSON-LD `ProductGroup.hasVariant[].offers` (or a lone Product's offers): per
 * variant, sku_key = the variant id (JSON-LD `sku`, also the `?id=` of `offers.url`; a SKU code
 * only when the page has no id), the price as exact decimal text, availability (OutOfStock or
 * SoldOut → quantity 0, else unknown), options from the variant name ("<product> - A / B" →
 * option1 A, option2 B: the snapshot's rule, shared with normalize-eu-snapshot.mjs) and colour
 * codes ("(10100)"). Per page, the host that served it (page_host) and the manifest type
 * (category). A page whose `priceCurrency` is not the requested store's currency (USD on the
 * EU store), or whose offers name another host, is refused and listed: a USD price is never
 * labelled EUR. The file goes through the upload door's parser before it is written.
 *
 * A SALE: when an offer's priceSpecification holds a StrikethroughPrice or ListPrice above
 * `offers.price` (the shared rule, normalize-eu-snapshot.mjs `offerPriceOf`), that regular price
 * is written and the sale price is listed in the report (`on_sale`): a price that ends with the
 * sale is never written as the list price.
 *
 * SEVERAL BLOCKS: the variants of every JSON-LD block of the page's product (the same
 * productGroupID, else the same handle) are read, never another product's. A variant repeated
 * (one key) follows the owner's one-page read's rule (worker/lib/supplierPrices/storePage.ts):
 * copies of one value (259 and 259.00) are one, the copy that states a regular price, else the
 * first; a plain copy whose price is another copy's sale price is that copy's sale, and the copy
 * that states the regular price is kept. Any other disagreement refuses the variant
 * (`copies_disagree`, listed): nothing of it is written.
 *
 * Owner-only data (invariant I6). Exit codes: 0 every selected page was read (refusals and
 * redirects are listed in the report); 3 the run stopped early (challenge, rate limit, deadline)
 * and the file holds what was captured; 2 nothing to write; 1 bad arguments or a refused file.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonLdBlocks } from '@levonis/catalog/bambuImport/rsc';
import {
  SOURCE_CURRENCY,
  SUPPLIER_PRICE_FORMAT,
  SUPPLIER_PRICE_LIMITS,
  SupplierPriceFormatError,
  isSupplierItemKey,
  isSupplierSkuKey,
  type SupplierCurrency,
  type SupplierPriceFile,
  type SupplierPriceItem,
  type SupplierPriceSku,
  type SupplierSource,
} from '@levonis/catalog/supplierPrices/format';
import { Deadline, realClock, type Clock } from '../bambu-import/deadline';
import { rawHandleOf, type ManifestRow } from '../bambu-import/discover';
import { ImportStop, StoreFetcher, productHandleOf, type FetchLike } from '../bambu-import/fetch';
import { parseRobots, robotsAllows, NO_ROBOTS, type Robots } from '../bambu-import/robots';
// @ts-expect-error - plain ESM capture tool (the shared core of the three), no types; typed below
import * as shared from './normalize-eu-snapshot.mjs';

// The rules shared with normalize-eu-snapshot.mjs, typed here (the .mjs carries no declarations).
const storeText: (value: unknown, max?: number) => string = shared.storeText;
const storeHandle: (value: unknown) => string = shared.storeHandle;
const optionValuesFromName: (variantName: unknown, productName: unknown) => string[] = shared.optionValuesFromName;
const positionalOptions: (values: readonly string[]) => Record<string, string> = shared.positionalOptions;
const colourCodesIn: (text: unknown) => string[] = shared.colourCodesIn;
const quantityFromAvailability: (value: unknown) => number | null = shared.quantityFromAvailability;
const withSkipRegionRedirect: (url: string) => string = shared.withSkipRegionRedirect;
const offerPriceOf: (offer: unknown) => { price?: string; sale_price?: string; refused?: string; detail?: string } = shared.offerPriceOf;
const decimalAbove: (a: string, b: string) => boolean = shared.decimalAbove;
const itemRefusal: (item: unknown, source: SupplierSource) => string | null = shared.itemRefusal;
const captureDate: (value: unknown) => string | null = shared.captureDate;
const writeSupplierPriceFile: (path: string, file: SupplierPriceFile) => string = shared.writeSupplierPriceFile;
const isMain: (moduleUrl: string) => boolean = shared.isMain;
const CATEGORY_GRAMMAR: RegExp = shared.CATEGORY_GRAMMAR;

export type StoreKey = 'us' | 'eu';

export interface StoreConfig {
  origin: string;
  host: string;
  source: SupplierSource;
  currency: SupplierCurrency;
}

export const STORES: Readonly<Record<StoreKey, StoreConfig>> = Object.freeze({
  us: { origin: 'https://us.store.bambulab.com', host: 'us.store.bambulab.com', source: 'bambu_us', currency: SOURCE_CURRENCY.bambu_us },
  eu: { origin: 'https://eu.store.bambulab.com', host: 'eu.store.bambulab.com', source: 'bambu_eu', currency: SOURCE_CURRENCY.bambu_eu },
});

/** The run's default limit, the import job's (workflow 60 gives a job 330 minutes). */
export const DEFAULT_MINUTES = 330;

/**
 * The `fetch` StoreFetcher is given: under --store eu every address carries `skr=yes` (the EU
 * store's skip-region-redirect parameter), robots.txt and redirect targets included. `onUrl`
 * sees each address as it is sent.
 */
export function storeFetch(store: StoreKey, inner: FetchLike, onUrl?: (url: string) => void): FetchLike {
  return (url, init) => {
    const target = store === 'eu' ? withSkipRegionRedirect(url) : url;
    onUrl?.(target);
    return inner(target, init);
  };
}

// ---------------------------------------------------------------- the JSON-LD offers

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const textOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
/** An id as text; a JSON number beyond the safe integers has already lost digits, so it is no id. */
const idOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : '');
const typesOf = (n: Json): string[] => (Array.isArray(n['@type']) ? n['@type'] : [n['@type']]).filter((t): t is string => typeof t === 'string');

/** Every object node of a JSON-LD block: the block, an array block's members, `@graph` members. */
function nodesOf(block: unknown, out: Json[] = [], depth = 0): Json[] {
  if (depth > 4) return out;
  if (Array.isArray(block)) for (const b of block) nodesOf(b, out, depth + 1);
  else if (isObj(block)) {
    out.push(block);
    if (Array.isArray(block['@graph'])) nodesOf(block['@graph'], out, depth + 1);
  }
  return out;
}

/** The Offer of `offers`: the object itself, the first of a list, or the first inside an AggregateOffer. */
function offerOf(v: unknown, depth = 0): Json | null {
  if (depth > 3) return null;
  for (const o of Array.isArray(v) ? v : [v]) {
    if (!isObj(o)) continue;
    if (typesOf(o).includes('AggregateOffer') && o.offers !== undefined) {
      const inner = offerOf(o.offers, depth + 1);
      if (inner) return inner;
      continue;
    }
    return o;
  }
  return null;
}

export interface StoreVariantOffer {
  /** JSON-LD `sku`: on the Bambu stores, the variant id. */
  sku: string;
  mpn: string;
  name: string;
  /** `offers.price` as the page wrote it (a number or text). */
  price: unknown;
  /** `offers.priceCurrency`, upper case. */
  currency: string;
  availability: string;
  /** `offers.url`. */
  url: string;
  /** `offers.priceSpecification` as the page wrote it, only when it has one (a sale's regular price is there). */
  priceSpecification?: unknown;
}

export interface StorePageOffers {
  name: string;
  url: string;
  productGroupId: string;
  variants: StoreVariantOffer[];
}

function variantOf(v: Json): StoreVariantOffer {
  const offer = offerOf(v.offers) ?? {};
  return {
    sku: idOf(v.sku),
    mpn: textOf(v.mpn),
    name: textOf(v.name),
    price: offer.price,
    currency: textOf(offer.priceCurrency).toUpperCase(),
    availability: textOf(offer.availability),
    url: textOf(offer.url),
    ...(offer.priceSpecification === undefined ? {} : { priceSpecification: offer.priceSpecification }),
  };
}

/** The handle of a node's `url` (`/products/<handle>`), or ''. */
function handleOfNode(n: Json): string {
  const url = textOf(n.url);
  if (!url) return '';
  try {
    return productHandleOf(new URL(url, 'https://store.invalid').pathname);
  } catch {
    return '';
  }
}

/** Two nodes describe one product: the same productGroupID, else (when either has none) the same handle. */
function sameProduct(a: Json, b: Json): boolean {
  const ia = idOf(a.productGroupID);
  const ib = idOf(b.productGroupID);
  if (ia && ib) return ia === ib;
  const ha = handleOfNode(a);
  return ha !== '' && ha === handleOfNode(b);
}

const variantsOf = (group: Json): StoreVariantOffer[] =>
  (Array.isArray(group.hasVariant) ? group.hasVariant : group.hasVariant === undefined ? [] : [group.hasVariant]).filter(isObj).map(variantOf);

/**
 * The offers of a store page's JSON-LD (the ProductGroup's variants, else a lone Product's), or
 * null. A page can describe its product in several blocks (a theme's and an app's): the variants
 * of every ProductGroup of that product (else of every lone Product of it) are gathered, never
 * another product's. pageItem resolves a variant they repeat.
 */
export function readStoreOffers(html: string): StorePageOffers | null {
  const nodes = jsonLdBlocks(html).flatMap((b) => nodesOf(b));
  const groups = nodes.filter((n) => typesOf(n).includes('ProductGroup'));
  const group = groups[0];
  if (group) {
    const variants = groups.filter((g) => g === group || sameProduct(g, group)).flatMap(variantsOf);
    return { name: textOf(group.name), url: textOf(group.url), productGroupId: idOf(group.productGroupID), variants };
  }
  const products = nodes.filter((n) => typesOf(n).includes('Product') && n.offers !== undefined);
  const product = products[0];
  if (product) {
    const variants = products.filter((p) => p === product || sameProduct(p, product)).map(variantOf);
    return { name: textOf(product.name), url: textOf(product.url), productGroupId: idOf(product.productGroupID), variants };
  }
  return null;
}

const DIGITS = /^\d{1,40}$/;

/** The host of an address (a relative one is the page's own); '?' when it is no address. */
function hostOf(url: string, base?: string): string {
  if (!url) return '';
  try {
    return new URL(url, base).hostname;
  } catch {
    return '?';
  }
}

/** The variant id an offer's address carries (`?id=`, digits only), or ''. */
function idParamOf(url: string, base: string): string {
  try {
    const id = new URL(url, base).searchParams.get('id') ?? '';
    return DIGITS.test(id) ? id : '';
  } catch {
    return '';
  }
}

/** Two decimal texts of one value ("259" and "259.00"). */
const sameDecimal = (a: string, b: string): boolean => !decimalAbove(a, b) && !decimalAbove(b, a);

/**
 * The copy kept of a variant the page repeats (several blocks, or twice in one group), each copy
 * priced by the sale rule; null when the copies disagree. The owner's one-page read keeps the same
 * rule (worker/lib/supplierPrices/storePage.ts copyKept; tests/supplierPriceBlocks.test.ts holds
 * the two to one table): a plain copy (no sale price) whose price is another copy's sale price is
 * that copy's sale, and every other copy must be of one value (259 and 259.00): the first that
 * states a regular price is kept, else the first.
 */
function copyKept<T extends { price: string; sale_price?: string }>(copies: readonly T[]): T | null {
  const sales = copies.flatMap((c) => (c.sale_price === undefined ? [] : [c.sale_price]));
  const rest = copies.filter((c) => c.sale_price !== undefined || !sales.some((s) => sameDecimal(s, c.price)));
  if (rest.some((c) => !sameDecimal(c.price, rest[0]!.price))) return null;
  return rest.find((c) => c.sale_price !== undefined) ?? rest[0]!;
}

// ---------------------------------------------------------------- one page → one item

export interface CaptureReport {
  store: StoreKey;
  source: SupplierSource;
  currency: SupplierCurrency;
  captured_on: string;
  /** Manifest rows selected for this run. */
  rows: number;
  items: number;
  skus: number;
  /** Store requests sent (robots.txt included). */
  requests: number;
  captured: string[];
  /** Pages the store sent elsewhere (another region's store, another product, a non-product): never captured. */
  redirected: Array<{ handle: string; status: number | null; to_other_product?: true }>;
  /** Pages the store no longer has (404 / 410). */
  withdrawn: Array<{ handle: string; status: number | null }>;
  /** Pages read but refused: another currency, another host, no offers, nothing priced. */
  refused: Array<{ handle: string; reason: string; detail?: string }>;
  refused_variants: Array<{ handle: string; sku: string; reason: string; detail?: string }>;
  /** Variants the page shows on sale: `price`, the regular price, was written; `sale_price` never. */
  on_sale: Array<{ handle: string; sku: string; price: string; sale_price: string }>;
  robots_disallowed: string[];
  /** Requests that failed without stopping the run (unreachable, an error status, a page too large). */
  failed: Array<{ handle: string; code: string; during: 'robots' | 'page'; status: number | null }>;
  /**
   * Why the run stopped before its last page (a challenge, a store that keeps asking to wait, the
   * deadline): on robots.txt, read before the first page, or on the page of `handle`.
   */
  stopped: { code: string; handle: string; during: 'robots' | 'page'; status: number | null } | null;
  /** Rows not attempted after a stop. */
  not_reached: number;
}

/**
 * One page's offers as a v1 item of the requested store, or null when the page is refused (the
 * reason is added to the report). `servedBy` is the host that answered the request.
 */
export function pageItem(store: StoreKey, row: Pick<ManifestRow, 'type'>, rawHandle: string, handle: string, servedBy: string, html: string, report: CaptureReport): SupplierPriceItem | null {
  const cfg = STORES[store];
  const refusePage = (reason: string, detail?: string) => {
    report.refused.push({ handle, reason, ...(detail ? { detail } : {}) });
    return null;
  };
  if (servedBy !== cfg.host) return refusePage('page_host_mismatch', servedBy);
  const offers = readStoreOffers(html);
  if (!offers || !offers.variants.length) return refusePage('no_offers');
  // Another region's store answered (a USD page under --store eu): nothing of it is kept.
  const foreign = [...new Set(offers.variants.map((v) => v.currency).filter((c) => c && c !== cfg.currency))];
  if (foreign.length) return refusePage('currency_mismatch', foreign.join(','));
  const otherHosts = [...new Set([offers.url, ...offers.variants.map((v) => v.url)].map((u) => hostOf(u, cfg.origin)).filter((h) => h && h !== cfg.host))];
  if (otherHosts.length) return refusePage('offer_host_mismatch', otherHosts.join(','));

  const L = SUPPLIER_PRICE_LIMITS;
  const skus: SupplierPriceSku[] = [];
  const sales: CaptureReport['on_sale'] = [];
  const priced: Array<{ v: StoreVariantOffer; skuKey: string; code: string; price: string; sale_price?: string }> = [];
  offers.variants.forEach((v, i) => {
    const refuse = (reason: string, detail?: string) => {
      report.refused_variants.push({ handle, sku: v.sku || `#${i}`, reason, ...(detail ? { detail } : {}) });
    };
    const variantId = DIGITS.test(v.sku) ? v.sku : idParamOf(v.url, cfg.origin);
    const code = [v.sku, v.mpn].find((c) => c && !DIGITS.test(c) && c.length <= L.skuCode && isSupplierSkuKey(cfg.source, c)) ?? '';
    const skuKey = variantId || code;
    if (!skuKey || !isSupplierSkuKey(cfg.source, skuKey)) return refuse('bad_sku');
    if (!v.currency) return refuse('currency_missing');
    // On sale the regular price is the price, and the sale price is only listed (shared rule).
    const price = offerPriceOf({ price: v.price, priceCurrency: v.currency, priceSpecification: v.priceSpecification });
    if (!price.price) return refuse(price.refused ?? 'price_invalid', price.detail);
    priced.push({ v, skuKey, code, price: price.price, ...(price.sale_price ? { sale_price: price.sale_price } : {}) });
  });
  // A variant the page repeats is one copy (copyKept), or refused when its copies disagree.
  const copiesOf = new Map<string, typeof priced>();
  for (const p of priced) copiesOf.set(p.skuKey, [...(copiesOf.get(p.skuKey) ?? []), p]);
  for (const p of priced) {
    const copies = copiesOf.get(p.skuKey)!;
    const kept = copyKept(copies);
    if (!kept && p === copies[0]) report.refused_variants.push({ handle, sku: p.skuKey, reason: 'copies_disagree', detail: copies.map((c) => c.price).join(',') });
    if (p !== kept) continue;
    const { v, skuKey, code } = p;
    const values = optionValuesFromName(v.name, offers.name)
      .map((x) => storeText(x, L.optionValue))
      .filter(Boolean);
    const options = positionalOptions(values);
    const codes = colourCodesIn(values.length ? values.join(' / ') : v.name);
    if (p.sale_price) sales.push({ handle, sku: skuKey, price: p.price, sale_price: p.sale_price });
    skus.push({
      sku_key: skuKey,
      options,
      options_en: { ...options },
      price: p.price,
      price_label: '',
      quantity: quantityFromAvailability(v.availability),
      sku_code: code,
      codes,
    });
  }
  if (!skus.length) return refusePage('no_priced_variant');

  const page = `${cfg.origin}/products/${rawHandle}`;
  const title = storeText(offers.name, L.title) || handle;
  const type = typeof row.type === 'string' ? row.type.trim() : '';
  const item: SupplierPriceItem = {
    item_key: handle,
    url: store === 'eu' ? withSkipRegionRedirect(page) : new URL(page).href,
    page_host: servedBy,
    title,
    name_en: title,
    category: type !== 'unknown' && CATEGORY_GRAMMAR.test(type) ? type : '',
    sourcing: '',
    freight_route: '',
    codes: [],
    props: [],
    skus,
  };
  const refusal = itemRefusal(item, cfg.source);
  if (refusal) return refusePage('invalid_item', refusal);
  report.on_sale.push(...sales);
  return item;
}

// ---------------------------------------------------------------- the run

/** The raw handle a page is requested by: the path of the manifest's canonical_url, else the import's own rule. */
export function rawHandleOfRow(row: ManifestRow): string {
  try {
    const m = /^\/products\/([A-Za-z0-9%._~-]+)\/?$/.exec(new URL(String(row.canonical_url ?? '')).pathname);
    if (m) return m[1];
  } catch {
    /* no canonical address: the import's rule below */
  }
  return rawHandleOf(row);
}

export interface CaptureOptions {
  store: StoreKey;
  rows: readonly ManifestRow[];
  fetch: FetchLike;
  clock?: Clock;
  deadline?: Deadline;
  /** YYYY-MM-DD; default the clock's day (UTC). */
  capturedOn?: string;
  /** Tests only: the spacing stays the import's 11 s unless a test says otherwise. */
  spacingMs?: number;
}

export interface CaptureResult {
  /** The v1 file, null when no page gave a priced item. */
  file: SupplierPriceFile | null;
  report: CaptureReport;
}

const STOPPING = new Set(['ACCESS_CHALLENGE', 'STORE_RATE_LIMITED', 'DEADLINE_EXIT']);

/** Reads the rows' pages one at a time, politely, and returns the v1 file with the run's report. */
export async function captureStoreOffers(opts: CaptureOptions): Promise<CaptureResult> {
  const cfg = STORES[opts.store];
  if (!cfg) throw new Error(`unknown store: ${String(opts.store)}`);
  const clock = opts.clock ?? realClock;
  const deadline = opts.deadline ?? new Deadline(clock.now() + DEFAULT_MINUTES * 60_000, clock);
  const capturedOn = captureDate(opts.capturedOn ?? new Date(clock.now()).toISOString().slice(0, 10));
  if (!capturedOn) throw new Error(`not a capture date (YYYY-MM-DD): ${String(opts.capturedOn)}`);
  let lastUrl = '';
  const fetcher = new StoreFetcher({
    fetch: storeFetch(opts.store, opts.fetch, (url) => {
      lastUrl = url;
    }),
    clock,
    deadline,
    origin: cfg.origin,
    ...(opts.spacingMs === undefined ? {} : { spacingMs: opts.spacingMs }),
  });
  const report: CaptureReport = {
    store: opts.store,
    source: cfg.source,
    currency: cfg.currency,
    captured_on: capturedOn,
    rows: opts.rows.length,
    items: 0,
    skus: 0,
    requests: 0,
    captured: [],
    redirected: [],
    withdrawn: [],
    refused: [],
    refused_variants: [],
    on_sale: [],
    robots_disallowed: [],
    failed: [],
    stopped: null,
    not_reached: 0,
  };
  const items: SupplierPriceItem[] = [];
  const seen = new Set<string>();
  let robots: Robots | null = null;

  for (let i = 0; i < opts.rows.length; i++) {
    const row = opts.rows[i];
    const raw = rawHandleOfRow(row);
    const handle = [storeHandle(row.handle), productHandleOf(`/products/${raw}`)].find((h) => isSupplierItemKey(cfg.source, h)) ?? '';
    if (!handle) {
      report.refused.push({ handle: String(row.handle ?? `#${i}`), reason: 'bad_handle' });
      continue;
    }
    if (seen.has(handle)) {
      report.refused.push({ handle, reason: 'duplicate_handle' });
      continue;
    }
    seen.add(handle);
    let during: 'robots' | 'page' = 'robots';
    try {
      if (!robots) {
        const text = await fetcher.robotsTxt();
        robots = text === null ? NO_ROBOTS : parseRobots(text);
      }
      during = 'page';
      // The address as it is sent (under --store eu with skr=yes) is the one robots.txt must allow.
      const requested = new URL(`${cfg.origin}/products/${raw}`);
      const sent = opts.store === 'eu' ? new URL(withSkipRegionRedirect(requested.href)) : requested;
      if (!robotsAllows(robots, sent.pathname + sent.search) || !robotsAllows(robots, requested.pathname)) {
        report.robots_disallowed.push(handle);
        continue;
      }
      const page = await fetcher.productPage(raw);
      const item = pageItem(opts.store, row, raw, handle, hostOf(lastUrl), page.html, report);
      if (item) {
        items.push(item);
        report.captured.push(handle);
      }
    } catch (err) {
      if (!(err instanceof ImportStop)) throw err;
      const status = err.detail.status ?? null;
      if (STOPPING.has(err.code)) {
        report.stopped = { code: err.code, handle, during, status };
        report.not_reached = opts.rows.length - i - 1;
        break;
      }
      if (err.code === 'IDENTITY_AMBIGUOUS') report.redirected.push({ handle, status, to_other_product: true });
      else if (err.code === 'SOURCE_WITHDRAWN' && status !== null && status >= 300 && status < 400) report.redirected.push({ handle, status });
      else if (err.code === 'SOURCE_WITHDRAWN') report.withdrawn.push({ handle, status });
      else report.failed.push({ handle, code: err.code, during, status });
    }
  }

  report.requests = fetcher.requests;
  report.items = items.length;
  report.skus = items.reduce((n, it) => n + it.skus.length, 0);
  if (!items.length) return { file: null, report };
  return {
    file: {
      format: SUPPLIER_PRICE_FORMAT,
      source: cfg.source,
      currency: cfg.currency,
      price_basis: 'list',
      capture: 'store_script',
      captured_on: capturedOn,
      captured_by: `capture-store-offers.ts --store ${opts.store}`,
      items,
    },
    report,
  };
}

// ---------------------------------------------------------------- the command line

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface CliArgs {
  store: StoreKey;
  manifest: string;
  handles: string[] | null;
  list: string | null;
  types: string[] | null;
  limit: number | null;
  minutes: number;
  date: string | null;
  out: string | null;
}

const USAGE =
  'usage: node --import tsx scripts/supplier-prices/capture-store-offers.ts --store us|eu [--manifest <manifest.json>] [--handles a,b] [--list <file.json>] [--types printer,ams] [--limit N] [--minutes 330] [--date YYYY-MM-DD] [--out <file.v1.json>]';

const listOf = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The arguments; an unknown, repeated or malformed one throws. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { store: 'us', manifest: join(ROOT, 'data', 'bambu-import', 'manifest.json'), handles: null, list: null, types: null, limit: null, minutes: DEFAULT_MINUTES, date: null, out: null };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--') || seen.has(flag) || value === undefined || value.startsWith('--')) throw new Error(`bad or repeated argument: ${flag}\n${USAGE}`);
    seen.add(flag);
    i++;
    if (flag === '--store') {
      if (value !== 'us' && value !== 'eu') throw new Error(`--store is us or eu, not ${value}`);
      args.store = value;
    } else if (flag === '--manifest') args.manifest = resolve(value);
    else if (flag === '--handles') args.handles = listOf(value);
    else if (flag === '--list') args.list = resolve(value);
    else if (flag === '--types') args.types = listOf(value);
    else if (flag === '--limit' || flag === '--minutes') {
      if (!/^[1-9]\d{0,5}$/.test(value)) throw new Error(`${flag} wants a positive whole number, not ${value}`);
      if (flag === '--limit') args.limit = Number(value);
      else args.minutes = Number(value);
    } else if (flag === '--date') {
      if (!captureDate(value)) throw new Error(`--date wants YYYY-MM-DD, not ${value}`);
      args.date = value;
    } else if (flag === '--out') args.out = resolve(value);
    else throw new Error(`unknown argument: ${flag}\n${USAGE}`);
  }
  if (!seen.has('--store')) throw new Error(`--store is required\n${USAGE}`);
  return args;
}

function readJson(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** Handles from a list file: `{rows: [{handle}]}` (the EU electronics list) or `{handles: [...]}`. */
export function handlesOfList(data: unknown): string[] {
  if (!isObj(data)) return [];
  const rows = Array.isArray(data.rows) ? data.rows.filter(isObj).map((r) => r.handle) : [];
  const handles = Array.isArray(data.handles) ? data.handles : [];
  return [...rows, ...handles].filter((h): h is string => typeof h === 'string' && h.trim() !== '');
}

/** The manifest rows a run reads: by handle (as listed), by type, then the first `limit`. */
export function selectRows(rows: readonly ManifestRow[], sel: { handles?: readonly string[] | null; types?: readonly string[] | null; limit?: number | null }): ManifestRow[] {
  const wanted = sel.handles ? new Set(sel.handles.map((h) => storeHandle(h))) : null;
  const types = sel.types ? new Set(sel.types) : null;
  const out = rows.filter((r) => (!wanted || wanted.has(storeHandle(r.handle))) && (!types || types.has(String(r.type ?? ''))));
  return sel.limit ? out.slice(0, sel.limit) : out;
}

export interface MainDeps {
  fetch: FetchLike;
  clock: Clock;
  log: Pick<Console, 'log' | 'error'>;
}

export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  let args: CliArgs;
  let rows: ManifestRow[];
  try {
    args = parseArgs(argv);
    const manifest = readJson(args.manifest);
    const all = isObj(manifest) && Array.isArray(manifest.rows) ? (manifest.rows.filter(isObj) as unknown as ManifestRow[]) : [];
    if (!all.length) throw new Error(`no manifest rows in ${args.manifest}`);
    const handles = [...(args.handles ?? []), ...(args.list ? handlesOfList(readJson(args.list)) : [])];
    rows = selectRows(all, { handles: args.handles !== null || args.list !== null ? handles : null, types: args.types, limit: args.limit });
    if (!rows.length) throw new Error('no manifest row matches the selection');
  } catch (err) {
    deps.log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const { file, report } = await captureStoreOffers({
    store: args.store,
    rows,
    fetch: deps.fetch,
    clock: deps.clock,
    deadline: new Deadline(deps.clock.now() + args.minutes * 60_000, deps.clock),
    ...(args.date ? { capturedOn: args.date } : {}),
  });
  let output: string | null = null;
  if (file) {
    output = args.out ?? join(ROOT, 'data', `bambu-${args.store}-prices`, `${args.store}-store-offers-${report.captured_on}.v1.json`);
    if (!existsSync(dirname(output))) mkdirSync(dirname(output), { recursive: true });
    try {
      writeSupplierPriceFile(output, file);
    } catch (err) {
      if (err instanceof SupplierPriceFormatError) {
        deps.log.error(`the file was not written: the parser refuses ${err.path} (${err.reason})`);
        return 1;
      }
      throw err;
    }
  }
  deps.log.log(JSON.stringify({ output, written: output !== null, ...report }, null, 1));
  if (report.stopped) return 3;
  return file ? 0 : 2;
}

if (isMain(import.meta.url)) {
  const network: FetchLike = (url, init) => fetch(url, init);
  main(process.argv.slice(2), { fetch: network, clock: realClock, log: console }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    }
  );
}
