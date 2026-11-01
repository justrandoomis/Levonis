/**
 * «اقرأ صفحة المتجر» — ONE OWNER-INITIATED READ OF ONE STORE PAGE
 * (docs/SMART_PRICING.md §3.6 `POST /read-store-page`, §3.9; migration 0218).
 *
 * The owner hands over a Bambu Lab store address (the EU or the US store, a
 * product or a variant page). It is NOT fetched as typed: its host must be one
 * of the two stores, the handle (`[a-z0-9-]` only) and the optional `?id=`
 * (digits only) are taken from it, and the address fetched is rebuilt by the
 * §3.9 builder (packages/catalog/src/supplierPrices/links.ts) — so an EU read
 * always carries `skr=yes`, the store's skip-region-redirect parameter (without
 * it a visitor from Iraq is sent to another region's store).
 *
 * The read goes through `guardedFetchBytes` (worker/lib/fetchGuard.ts): https
 * only, `allowHost` limited to the two stores on EVERY hop, the byte cap a
 * product page is read with (productPageImages.ts), one deadline. The page's
 * schema.org JSON-LD is walked the way productPageImages.ts walks it
 * (`ProductGroup.hasVariant[].offers {price, priceCurrency, availability, url}`).
 *
 * THE CURRENCY IS THE PAGE'S OWN and the source is the FINAL host's: an EU
 * address the store still sends to the US store comes back as USD and is
 * stored as USD, never as EUR. A refused or challenged fetch (the store answers
 * automated access with a Cloudflare challenge), or a page without JSON-LD
 * offers, gives no price: nothing is saved and the owner hears 502
 * PRICE_ESTIMATE_STORE_PAGE_UNREADABLE — he then types the price himself.
 *
 * With `save {product_id, combo_keys}` the chosen variant's price is written
 * as the owner's price of those SKUs (`supplier_price_manual`, origin
 * `store_page`, with the evidence address and host — never turned into a link).
 * No schedule, no crawl, and Tmall is never fetched.
 *
 * A SALE: when an offer's `priceSpecification` holds a StrikethroughPrice or
 * ListPrice above `offers.price`, the offer's `price` is that regular price —
 * the one a save writes — and `sale_price` the page's sale price, answered
 * beside it and never saved (the capture tools' rule).
 *
 * A VARIANT REPEATED across JSON-LD nodes (one id, one currency; a theme's
 * block and an app's, say): copies of one value (259 and 259.00) are one
 * offer, the copy that states a regular price, else the first; a plain copy
 * whose price is another copy's sale price is that copy's sale (the block
 * shows only the sale price), and the copy that states the regular price is
 * kept. Any other disagreement keeps every copy, and a save of that variant is
 * refused (502 with ?id=, 400 'url' without). Within one node the offers are
 * only deduplicated, as before. The capture script keeps the same rule.
 */
import { ESTIMATE_REFUSALS, estimateServerMessage } from '@levonis/contracts/priceEstimates';
import { guardedFetchBytes } from '../fetchGuard';
import { HttpError } from '../http';
import { inputInvalid } from '../pricingEngine/whatIf';
import { supplierPriceText } from '@levonis/catalog/supplierPrices/format';
import { isStoreHandle, isStoreVariantId, supplierItemUrl, supplierSkuUrl } from '@levonis/catalog/supplierPrices/links';
import { isSupplierCurrency, type SupplierCurrency } from './store';

/** The only hosts a store read may touch, on every hop. */
export const STORE_PAGE_HOSTS: readonly string[] = ['eu.store.bambulab.com', 'us.store.bambulab.com'];
/** The byte cap a product page is read with (worker/lib/productPageImages.ts). */
export const STORE_PAGE_BYTE_CAP = 4 * 1024 * 1024;
export const STORE_PAGE_TIMEOUT_MS = 10_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; LevonisBot/1.0; +https://levonis-iq.com)';

/**
 * The owner-only refusal of a page that gave no price, in three languages: the
 * estimate contract's own entry (§3.6, §5.5; owner question 282(k): a native
 * Sorani review is recommended).
 */
const UNREADABLE = ESTIMATE_REFUSALS.PRICE_ESTIMATE_STORE_PAGE_UNREADABLE;
export const STORE_PAGE_UNREADABLE_TEXT = Object.freeze({ ar: UNREADABLE.ar, en: UNREADABLE.en, ckb: UNREADABLE.ckb });

/**
 * 502 PRICE_ESTIMATE_STORE_PAGE_UNREADABLE: no price was read and nothing was saved. With
 * `copies_disagree`, `details.reason` says why: the page gives the named variant several prices.
 */
export function storePageUnreadable(reason?: 'copies_disagree'): HttpError {
  return new HttpError(UNREADABLE.status, estimateServerMessage('PRICE_ESTIMATE_STORE_PAGE_UNREADABLE'), 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE', reason ? { reason } : undefined);
}

export type StoreSource = 'bambu_eu' | 'bambu_us';

const HOST_SOURCE: Record<string, StoreSource> = { 'eu.store.bambulab.com': 'bambu_eu', 'us.store.bambulab.com': 'bambu_us' };

export interface StorePageTarget {
  source: StoreSource;
  handle: string;
  variant_id: string | null;
  /** The address fetched: rebuilt by the §3.9 builder, never the owner's text. */
  url: string;
}

/** The store page the owner's address names, rebuilt; 400 PRICING_INPUT_INVALID {field: 'url'} for anything else. */
export function storePageTarget(raw: unknown): StorePageTarget {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 600) throw inputInvalid('url');
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw inputInvalid('url');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port) throw inputInvalid('url');
  const source = HOST_SOURCE[url.hostname.toLowerCase()];
  if (!source) throw inputInvalid('url');
  const m = /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/products\/([^/]+)\/?$/i.exec(url.pathname);
  let handle = '';
  try {
    handle = m ? decodeURIComponent(m[1]!).toLowerCase() : '';
  } catch {
    handle = '';
  }
  if (!isStoreHandle(handle)) throw inputInvalid('url');
  const id = url.searchParams.get('id');
  if (id !== null && !isStoreVariantId(id)) throw inputInvalid('url');
  const built = id ? supplierSkuUrl(source, handle, id) : supplierItemUrl(source, handle);
  if (!built) throw inputInvalid('url');
  return { source, handle, variant_id: id, url: built };
}

export interface StoreOffer {
  /** The store's variant id (the `?id=` of the offer's url, else a digits-only JSON-LD `sku`), '' when the page names none. */
  sku_key: string;
  name: string;
  /** Decimal text as the page states it (at most two decimals; never a binary float). On sale, the regular price: what a save writes. */
  price: string;
  /** Only on sale: `offers.price`, below the regular price. Answered, never saved. */
  sale_price?: string;
  /** The page's own `priceCurrency`. */
  currency: string;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** True when decimal text `a` is above decimal text `b` (both in the supplier price grammar). */
function decimalAbove(a: string, b: string): boolean {
  const [ai = '', af = ''] = a.split('.');
  const [bi = '', bf = ''] = b.split('.');
  const ia = ai.replace(/^0+(?=\d)/, '');
  const ib = bi.replace(/^0+(?=\d)/, '');
  if (ia.length !== ib.length) return ia.length > ib.length;
  if (ia !== ib) return ia > ib;
  const n = Math.max(af.length, bf.length);
  return af.padEnd(n, '0') > bf.padEnd(n, '0');
}

/** schema.org's price types for the regular price a sale is shown against: the URL or the bare name. */
const REGULAR_PRICE_TYPE = /^(?:https?:\/\/schema\.org\/)?(?:StrikethroughPrice|ListPrice)$/i;

/** No regular price stated: absent, empty or zero. */
const noPriceStated = (v: unknown): boolean => v === null || v === undefined || v === 0 || (typeof v === 'string' && /^\s*(?:0+(?:\.0+)?)?\s*$/.test(v));

/**
 * An offer's price, by the capture tools' rule (scripts/supplier-prices/
 * normalize-eu-snapshot.mjs `offerPriceOf`; tests/supplierPriceSaleRule.test.ts
 * holds both to one table): `offers.price`, unless a StrikethroughPrice or
 * ListPrice of its `priceSpecification` (one object or a list), in the offer's
 * currency (an entry without one is in it), is above it. Then the highest such
 * regular price is the price and `offers.price` the sale price. An entry with a
 * `referenceQuantity` is a unit price (per kg) and never the item's regular
 * price. null when a price cannot be read, a stated regular price included:
 * nothing is guessed.
 */
function offerPrices(offer: Record<string, unknown>, currency: string): { price: string; sale_price?: string } | null {
  let price: string;
  try {
    price = supplierPriceText(offer.price);
  } catch {
    return null;
  }
  let regular = '';
  const specs = offer.priceSpecification;
  for (const spec of Array.isArray(specs) ? specs : [specs]) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const s = spec as Record<string, unknown>;
    if (typeof s.priceType !== 'string' || !REGULAR_PRICE_TYPE.test(s.priceType.trim())) continue;
    if (s.referenceQuantity !== undefined && s.referenceQuantity !== null) continue;
    const c = typeof s.priceCurrency === 'string' ? s.priceCurrency.trim().toUpperCase() : '';
    if (c && c !== currency) continue;
    if (noPriceStated(s.price)) continue;
    let r: string;
    try {
      r = supplierPriceText(s.price);
    } catch {
      return null;
    }
    if (decimalAbove(r, price) && (!regular || decimalAbove(r, regular))) regular = r;
  }
  return regular ? { price: regular, sale_price: price } : { price };
}

function variantIdOf(product: Record<string, unknown>, offer: Record<string, unknown>): string {
  const url = textOf(offer.url);
  if (url) {
    try {
      const id = new URL(url, 'https://eu.store.bambulab.com/').searchParams.get('id');
      if (id && isStoreVariantId(id)) return id;
    } catch {
      /* the sku below */
    }
  }
  // A JSON number above 2^53 has lost its digits already: only a string sku is trusted.
  const sku = typeof product.sku === 'string' ? product.sku : typeof offer.sku === 'string' ? offer.sku : '';
  return isStoreVariantId(sku) ? sku : '';
}

function availabilityOf(v: unknown): StoreOffer['availability'] {
  const s = textOf(v);
  if (/InStock|PreOrder|BackOrder|LimitedAvailability/i.test(s)) return 'in_stock';
  if (/OutOfStock|SoldOut|Discontinued/i.test(s)) return 'out_of_stock';
  return 'unknown';
}

/** The offers a product page publishes about itself (JSON-LD Product / ProductGroup.hasVariant). Never throws. */
export function extractStoreOffers(html: string): StoreOffer[] {
  const out: StoreOffer[] = [];
  // The JSON-LD node (a Product) each offer was read from: only another node's offer is a copy.
  const nodeOf = new Map<StoreOffer, number>();
  let nodes = 0;
  const offerOf = (product: Record<string, unknown>, raw: unknown) => {
    const node = nodes++;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const o of list) {
      if (!o || typeof o !== 'object') continue;
      const offer = o as Record<string, unknown>;
      const currency = textOf(offer.priceCurrency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) continue;
      // On sale: the regular price is the price a save writes; the sale price is only told.
      const prices = offerPrices(offer, currency);
      if (!prices) continue;
      const read: StoreOffer = {
        sku_key: variantIdOf(product, offer),
        name: textOf(product.name).slice(0, 200),
        price: prices.price,
        ...(prices.sale_price ? { sale_price: prices.sale_price } : {}),
        currency,
        availability: availabilityOf(offer.availability),
      };
      out.push(read);
      nodeOf.set(read, node);
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) visit(obj['@graph']);
    const type = Array.isArray(obj['@type']) ? obj['@type'].map(String) : [String(obj['@type'] ?? '')];
    if (type.includes('ProductGroup') && Array.isArray(obj.hasVariant)) visit(obj.hasVariant);
    else if (type.includes('Product') && obj.offers) offerOf(obj, obj.offers);
  };
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1]!));
    } catch {
      // One malformed block does not hide the others.
    }
  }
  return onePerVariant(out, nodeOf);
}

/** Two decimal texts of one value ("259" and "259.00"). */
const sameDecimal = (a: string, b: string): boolean => !decimalAbove(a, b) && !decimalAbove(b, a);

/**
 * The copy kept of a variant that several JSON-LD nodes repeat, each copy
 * priced by the sale rule; null when the copies disagree. A plain copy (no
 * sale price) whose price is another copy's sale price is that copy's sale
 * (the block shows only the sale price). Every other copy must be of one value
 * (259 and 259.00): the first that states a regular price is kept, else the
 * first. scripts/supplier-prices/capture-store-offers.ts keeps the same rule
 * (tests/supplierPriceBlocks.test.ts holds the two to one table).
 */
function copyKept<T extends { price: string; sale_price?: string }>(copies: readonly T[]): T | null {
  const sales = copies.flatMap((c) => (c.sale_price === undefined ? [] : [c.sale_price]));
  const rest = copies.filter((c) => c.sale_price !== undefined || !sales.some((s) => sameDecimal(s, c.price)));
  if (rest.some((c) => !sameDecimal(c.price, rest[0]!.price))) return null;
  return rest.find((c) => c.sale_price !== undefined) ?? rest[0]!;
}

/**
 * One offer per variant (one id, one currency). Within one node the offers
 * are only deduplicated, as before (one per price text). Across nodes the
 * copies go through copyKept. When they disagree, or one node gives the
 * variant two prices, every copy is kept (one per price text) and chosenOffer
 * refuses the variant. Offers without an id are only deduplicated. Document
 * order is kept.
 */
function onePerVariant(offers: StoreOffer[], nodeOf: ReadonlyMap<StoreOffer, number>): StoreOffer[] {
  const seen = new Set<string>();
  const groups = new Map<string, StoreOffer[]>();
  const keep = new Set<StoreOffer>();
  for (const o of offers) {
    const k = `${o.sku_key ? nodeOf.get(o) : ''}\u0000${o.sku_key}\u0000${o.price}\u0000${o.currency}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!o.sku_key) {
      keep.add(o);
      continue;
    }
    const v = `${o.sku_key}\u0000${o.currency}`;
    const g = groups.get(v);
    if (g) g.push(o);
    else groups.set(v, [o]);
  }
  for (const g of groups.values()) {
    const oneEach = new Set(g.map((o) => nodeOf.get(o))).size === g.length;
    const kept = oneEach ? copyKept(g) : null;
    if (kept) {
      keep.add(kept);
      continue;
    }
    const prices = new Set<string>();
    for (const o of g) {
      if (prices.has(o.price)) continue;
      prices.add(o.price);
      keep.add(o);
    }
  }
  return offers.filter((o) => keep.has(o));
}

export interface StorePageRead {
  target: StorePageTarget;
  /** The FINAL page's host and the source it names (a redirect to the US store reads as bambu_us). */
  host: string;
  source: StoreSource;
  /** The final address after the redirects (stored as evidence only; never answered or turned into a link). */
  final_url: string;
  offers: StoreOffer[];
}

/** One guarded read of the target page. Throws storePageUnreadable() when no offer could be read. */
export async function readStorePage(target: StorePageTarget, opts: { fetcher?: typeof fetch } = {}): Promise<StorePageRead> {
  let fetched;
  try {
    fetched = await guardedFetchBytes(target.url, {
      maxBytes: STORE_PAGE_BYTE_CAP,
      maxRedirects: 3,
      timeoutMs: STORE_PAGE_TIMEOUT_MS,
      fetcher: opts.fetcher,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      allowHost: (h) => STORE_PAGE_HOSTS.includes(h.toLowerCase()),
      allowUrl: (u) => u.protocol === 'https:' && !u.port,
    });
  } catch {
    // Refused, challenged, too large, timed out or off the two stores: no price, and no detail of why.
    throw storePageUnreadable();
  }
  let host = '';
  try {
    host = new URL(fetched.url).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const source = HOST_SOURCE[host];
  if (!source) throw storePageUnreadable();
  const offers = extractStoreOffers(new TextDecoder().decode(fetched.bytes));
  if (!offers.length) throw storePageUnreadable();
  return { target, host, source, final_url: fetched.url, offers };
}

/**
 * The offer a save writes: the variant the address named (`?id=`), else the
 * page's only price. null when the page offers several different prices and
 * the address named none (the owner picks a variant link instead), or when
 * the page gives the named variant several prices in one currency (its
 * copies disagree, and extractStoreOffers kept each one).
 */
export function chosenOffer(read: StorePageRead): StoreOffer | null {
  if (read.target.variant_id) {
    const mine = read.offers.filter((o) => o.sku_key === read.target.variant_id);
    const same = mine.filter((o) => o.currency === mine[0]?.currency);
    return same.length === 1 ? same[0]! : null;
  }
  const distinct = new Set(read.offers.map((o) => `${o.price}\u0000${o.currency}`));
  return distinct.size === 1 ? read.offers[0]! : null;
}

/** The currency a save stores: the page's own, one of the three the catalogue keeps; null otherwise. */
export const storableCurrency = (o: StoreOffer): SupplierCurrency | null => (isSupplierCurrency(o.currency) ? o.currency : null);
