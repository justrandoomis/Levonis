#!/usr/bin/env node
/**
 * THE EU STORE SNAPSHOT AS A SUPPLIER PRICE FILE (docs/SMART_PRICING.md §3.1, §3.3; WP4).
 *
 *   node scripts/supplier-prices/normalize-eu-snapshot.mjs data/bambu-eu-prices/eu-store-2026-10-31.json
 *        [--captured-by "<who>"]
 *
 * The EU store (eu.store.bambulab.com) is read in a browser with `?skr=yes`, the store
 * selector's skip-region-redirect parameter: without it a visitor from Iraq is sent to another
 * region's store. data/bambu-eu-prices/tools/assemble-snapshot.mjs gathers the page captures
 * into eu-store-<date>.json; this tool turns that snapshot into a `levonis.supplier-prices.v1`
 * file, <name>.v1.json beside it, for the owner's upload door (§3.4). It reads no network.
 *
 *   snapshot                                  v1
 *   captured_on                               captured_on; source bambu_eu, currency EUR,
 *                                             price_basis "list", capture "browser_sweep"
 *   products[].handle                         item_key (percent-decoded, NFC, lower case)
 *   products[].url, with skr=yes              url (the EU store only)
 *   (the store that served it)                page_host "eu.store.bambulab.com"
 *   products[].name                           title and name_en (the store writes English)
 *   products[].type                           category (the import manifest's type)
 *   products[].sourcing / freight_route       sourcing / freight_route, as the snapshot's rule set them
 *   variants[].sku                            sku_key: the store's variant id (else the url's ?id=)
 *   variants[].option_values                  options and options_en (the same object), keyed by
 *     (absent: the variant name after         position, "option1", "option2" …: the page names no
 *      "<product name> - ", else after the    option group
 *      first " - ", split on " / ")
 *   variants[].colour_code(s)                 codes
 *   variants[].price_eur                      price, the exact decimal text: 1599 → "1599", 27.99 → "27.99"
 *   variants[].sale_price_eur (on_sale)       the report's on_sale list only, never the price
 *   variants[].availability                   quantity: OutOfStock / SoldOut → 0, anything else null (unknown)
 *   —                                         price_label "", sku_code "" (the page shows no SKU code)
 *
 * REFUSED, never written, and listed in the report: a variant whose currency is not EUR (another
 * region's store answered), whose url is not the EU store's, whose price is missing or is not an
 * amount with at most two decimals (never rounded: 12.345 and 0.30000000000000004 are refused),
 * or whose id is missing or malformed; a product whose url is another store's, or with no priced
 * variant left. The whole file then goes through the parser the upload door runs
 * (packages/catalog/src/supplierPrices/format.ts): a file it refuses is never written.
 *
 * The price is the store's list price for an EU visitor that day, kept as listed: price_basis
 * "list", never converted (owner question 282(a): VAT). During a sale the snapshot's price_eur is
 * already the regular price (assemble-snapshot.mjs takes the page's StrikethroughPrice); the sale
 * price beside it is listed in the report (`on_sale`), never written.
 *
 * This file is also the shared core of the three capture tools (normalize-tmall.mjs and
 * capture-store-offers.ts import it): the parser's loader, text cleaning, the store's option,
 * colour, availability, skip-redirect and sale-price rules, and the checked v1 writer.
 *
 * Owner-only data (invariant I6): supplier prices never reach a customer, and the captures stay
 * out of git (.gitignore, owner question 282(g)). Exit codes: 0 written; 2 nothing to write (no
 * priced product); 1 an unreadable input or a file the parser refuses (nothing written).
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- WP2's parser and link rules

/**
 * A TypeScript module of the catalogue package. Under tsx (the tests, `node --import tsx`) a
 * plain import; under bare node, whose type stripping cannot read the parser's parameter
 * properties, through tsx's own loader.
 */
async function loadTs(specifier) {
  try {
    return await import(specifier);
  } catch {
    const { tsImport } = await import('tsx/esm/api');
    return tsImport(specifier, import.meta.url);
  }
}

const format = await loadTs('../../packages/catalog/src/supplierPrices/format.ts');
const links = await loadTs('../../packages/catalog/src/supplierPrices/links.ts');

export const {
  SUPPLIER_PRICE_FORMAT,
  SUPPLIER_PRICE_LIMITS,
  SOURCING_HINTS,
  ROUTE_HINTS,
  SupplierPriceFormatError,
  isSupplierItemKey,
  isSupplierSkuKey,
  parseSupplierPriceFile,
  parseSupplierPriceItems,
  supplierHostAllowed,
  supplierPriceText,
} = format;

/** The EU store's skip-region-redirect parameter (`skr=yes`, links.ts): without it Iraq is sent elsewhere. */
const [SKR_NAME, SKR_VALUE] = String(links.EU_SKIP_REGION_REDIRECT).split('=');

export const EU_STORE_HOST = 'eu.store.bambulab.com';
const EU_STORE_ORIGIN = `https://${EU_STORE_HOST}`;

// ---------------------------------------------------------------- shared rules

/** The parser's grammars for a category and a code (format.ts), checked here so a bad one is dropped, not fatal. */
export const CATEGORY_GRAMMAR = /^[a-z][a-z0-9_]{0,39}$/;
export const CODE_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

/** C0 and C1 controls and the bidi overrides, which the parser refuses (they could disguise text in the owner's panel). */
function isControl(code) {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/**
 * Text as the v1 file holds it: control characters become spaces, runs of white space one space,
 * trimmed, and cut to `max` UTF-16 units (never inside a surrogate pair). A non-string is ''.
 */
export function cleanText(value, max = Infinity) {
  if (typeof value !== 'string') return '';
  let s = '';
  for (const ch of value) s += isControl(ch.charCodeAt(0)) ? ' ' : ch;
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    let end = max;
    const last = s.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    s = s.slice(0, end).trimEnd();
  }
  return s;
}

/** Store text as the EU snapshot tool writes it: every kind of dash a plain '-' (a handle and names hold U+2011). */
export function storeText(value, max = Infinity) {
  return cleanText(typeof value === 'string' ? value.replace(/[\u2010-\u2015\u2212]/g, '-') : value, max);
}

/**
 * A variant's option values from its name, the store's own pattern ("Bambu Lab H2D - H2D AMS
 * Combo / Standard"): what follows "<product name> - " (else the first " - "), split on " / ".
 * The rule of data/bambu-eu-prices/tools/assemble-snapshot.mjs, so a snapshot and a store page
 * of the same variant give the same options.
 */
export function optionValuesFromName(variantName, productName) {
  const v = storeText(variantName);
  const p = storeText(productName);
  let rest = '';
  if (p && v.toLowerCase().startsWith(`${p.toLowerCase()} - `)) rest = v.slice(p.length + 3);
  else if (p && v.toLowerCase() === p.toLowerCase()) rest = '';
  else {
    const at = v.indexOf(' - ');
    rest = at >= 0 ? v.slice(at + 3) : '';
  }
  return rest
    .split(' / ')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Option values as a v1 object keyed by position: `{option1: "H2D AMS Combo", option2: "Standard"}`. */
export function positionalOptions(values) {
  const out = {};
  values.forEach((value, i) => {
    out[`option${i + 1}`] = value;
  });
  return out;
}

/** Bambu colour codes, five digits in brackets: "Jade White (10100)" → ["10100"]. */
export function colourCodesIn(text) {
  return [...new Set([...String(text ?? '').matchAll(/\((\d{5})\)/g)].map((m) => m[1]))];
}

/** A JSON-LD availability as a quantity: OutOfStock or SoldOut is 0; anything else is unknown (null). */
export function quantityFromAvailability(value) {
  const a = typeof value === 'string' ? value.trim().replace(/^https?:\/\/schema\.org\//i, '') : '';
  return /^(?:OutOfStock|SoldOut)$/i.test(a) ? 0 : null;
}

/** The address with the EU store's skip-region-redirect parameter (`skr=yes`) set, whatever it held. */
export function withSkipRegionRedirect(url) {
  const u = new URL(url);
  u.searchParams.set(SKR_NAME, SKR_VALUE);
  return u.href;
}

/** An https address on `host`, or null. */
function urlOn(value, host) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  return u.protocol === 'https:' && u.hostname === host && !u.username && !u.password && !u.port ? u : null;
}

/** A store handle as the import reads one (fetch.ts productHandleOf): percent-decoded, NFC, lower case. */
export function storeHandle(value) {
  let h = typeof value === 'string' ? value.trim() : '';
  if (/%[0-9A-Fa-f]{2}/.test(h)) {
    try {
      h = decodeURIComponent(h);
    } catch {
      /* not an encoding: kept as written, and the parser judges it */
    }
  }
  return h.normalize('NFC').toLowerCase();
}

/** A captured price as decimal text through the parser's own rule, or the reason it is refused. */
export function priceTextOf(value) {
  if (value === null || value === undefined || value === '') return { refused: 'price_missing' };
  try {
    return { price: supplierPriceText(value) };
  } catch (err) {
    if (err instanceof SupplierPriceFormatError) return { refused: err.reason === 'float_price' ? 'price_not_two_decimals' : 'price_invalid' };
    throw err;
  }
}

/** True when decimal text `a` is above decimal text `b` (both in the parser's price grammar). */
export function decimalAbove(a, b) {
  const [ai, af = ''] = String(a).split('.');
  const [bi, bf = ''] = String(b).split('.');
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
const noPriceStated = (value) => value === null || value === undefined || value === 0 || (typeof value === 'string' && /^\s*(?:0+(?:\.0+)?)?\s*$/.test(value));

/**
 * A JSON-LD offer's price, by the one rule every store reader keeps (worker/lib/supplierPrices/
 * storePage.ts holds the same): `offers.price` through the parser's rule, unless the offer's
 * `priceSpecification` (one object or a list) holds a StrikethroughPrice or ListPrice (the
 * schema.org URL or the bare name) in the offer's currency above it. Then the page is on sale:
 * that regular price is the price (the highest, if several), and `offers.price` is the sale
 * price, returned to be reported and never written as the list price. An entry without a
 * currency is in the offer's; another currency is never compared. An entry with a
 * `referenceQuantity` is a unit price (per kg, per metre) and never the item's regular price.
 * A regular price that is stated but unreadable refuses the offer (nothing is guessed).
 * Returns `{price, sale_price?}` or `{refused, detail?}`.
 */
export function offerPriceOf(offer) {
  const o = offer && typeof offer === 'object' && !Array.isArray(offer) ? offer : {};
  const own = priceTextOf(o.price);
  if (!own.price) return { refused: own.refused, ...(o.price === undefined ? {} : { detail: JSON.stringify(o.price) }) };
  const currency = typeof o.priceCurrency === 'string' ? o.priceCurrency.trim().toUpperCase() : '';
  let regular = '';
  for (const spec of Array.isArray(o.priceSpecification) ? o.priceSpecification : [o.priceSpecification]) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    if (typeof spec.priceType !== 'string' || !REGULAR_PRICE_TYPE.test(spec.priceType.trim())) continue;
    if (spec.referenceQuantity !== undefined && spec.referenceQuantity !== null) continue;
    const c = typeof spec.priceCurrency === 'string' ? spec.priceCurrency.trim().toUpperCase() : '';
    if (c && c !== currency) continue;
    if (noPriceStated(spec.price)) continue;
    const r = priceTextOf(spec.price);
    if (!r.price) return { refused: 'regular_price_invalid', detail: JSON.stringify(spec.price) };
    if (decimalAbove(r.price, own.price) && (!regular || decimalAbove(r.price, regular))) regular = r.price;
  }
  return regular ? { price: regular, sale_price: own.price } : { price: own.price };
}

/** One item checked alone by the parser: null when it passes, else `<path>: <reason>`. */
export function itemRefusal(item, source) {
  try {
    parseSupplierPriceItems([item], source);
    return null;
  } catch (err) {
    if (err instanceof SupplierPriceFormatError) return `${err.path}: ${err.reason}`;
    throw err;
  }
}

/** A date the parser accepts (YYYY-MM-DD, a real day), or null. */
export function captureDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 ? value : null;
}

/** The input could not be normalised at all (no date, no product list): nothing is written. */
export class SnapshotInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotInputError';
  }
}

// ---------------------------------------------------------------- the v1 file

/** `<dir>/<name>.json` → `<dir>/<name>.v1.json`, beside the input. */
export function v1PathFor(inputPath) {
  const stem = basename(inputPath).replace(/\.json$/i, '');
  return join(dirname(inputPath), `${stem}.v1.json`);
}

/**
 * Writes a v1 file only after the upload door's parser accepted all of it (a refusal throws
 * SupplierPriceFormatError and nothing is written), through a temporary file so a reader never
 * sees half a file.
 */
export function writeSupplierPriceFile(path, file) {
  parseSupplierPriceFile(file);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 1)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return path;
}

function readJsonFile(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * The command line both normalisers share: one input file, an optional `--captured-by`; the
 * report (JSON) on stdout. Returns the exit code.
 */
export function runNormalizerCli(argv, { normalize, usage, log = console }) {
  let input = null;
  let capturedBy;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--captured-by' && i + 1 < argv.length) capturedBy = argv[++i];
    else if (!a.startsWith('--') && input === null) input = a;
    else {
      log.error(`unknown argument: ${a}\n${usage}`);
      return 1;
    }
  }
  if (input === null) {
    log.error(usage);
    return 1;
  }
  const path = resolve(input);
  let snapshot;
  try {
    snapshot = readJsonFile(path);
  } catch (err) {
    log.error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (snapshot && typeof snapshot === 'object' && snapshot.format === SUPPLIER_PRICE_FORMAT) {
    log.error(`${path} is already a ${SUPPLIER_PRICE_FORMAT} file`);
    return 1;
  }
  let result;
  try {
    result = normalize(snapshot, capturedBy === undefined ? {} : { capturedBy });
  } catch (err) {
    if (err instanceof SnapshotInputError) {
      log.error(`${path}: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const output = v1PathFor(path);
  if (!result.file) {
    log.log(JSON.stringify({ input: path, output: null, written: false, ...result.report }, null, 1));
    return 2;
  }
  try {
    writeSupplierPriceFile(output, result.file);
  } catch (err) {
    if (err instanceof SupplierPriceFormatError) {
      log.error(`the file was not written: the parser refuses ${err.path} (${err.reason})`);
      return 1;
    }
    throw err;
  }
  log.log(JSON.stringify({ input: path, output, written: true, ...result.report }, null, 1));
  return 0;
}

/** True when this module is the program node was asked to run (not a test's import). */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(moduleUrl);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ---------------------------------------------------------------- the EU snapshot

const SOURCE = 'bambu_eu';

/**
 * The snapshot's sku, else the `?id=` of the variant's url (the store's variant id either way).
 * An id held as a JSON number past 2^53 has already lost digits, so it is no id.
 */
function variantKey(v) {
  const sku = typeof v.sku === 'string' ? v.sku.trim() : typeof v.sku === 'number' && Number.isSafeInteger(v.sku) ? String(v.sku) : '';
  if (sku) return sku;
  const u = urlOn(v.url, EU_STORE_HOST);
  const id = u?.searchParams.get('id') ?? '';
  return /^\d{1,40}$/.test(id) ? id : '';
}

/**
 * The EU snapshot as a v1 file: `{file, report}`, `file` null when no product kept a priced
 * variant. Throws SnapshotInputError when the snapshot has no capture date or no product list.
 */
export function normalizeEuSnapshot(snapshot, { capturedBy = 'browser sweep (?skr=yes)' } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new SnapshotInputError('not an EU store snapshot (an object was expected)');
  const capturedOn = captureDate(snapshot.captured_on);
  if (!capturedOn) throw new SnapshotInputError(`captured_on is not a date (YYYY-MM-DD): ${JSON.stringify(snapshot.captured_on)}`);
  if (!Array.isArray(snapshot.products)) throw new SnapshotInputError('the snapshot has no products list');

  const L = SUPPLIER_PRICE_LIMITS;
  const report = {
    source: SOURCE,
    currency: 'EUR',
    captured_on: capturedOn,
    products_read: snapshot.products.length,
    items: 0,
    skus: 0,
    refused_variants: [],
    dropped_products: [],
    // Variants on sale that day: `price` (the regular price) is written, the sale price never.
    on_sale: [],
    notes: [],
  };
  const items = [];
  const seenHandles = new Set();

  snapshot.products.forEach((p, index) => {
    const rawHandle = p && typeof p === 'object' && typeof p.handle === 'string' ? p.handle : '';
    const handle = storeHandle(rawHandle);
    const drop = (reason, detail) => report.dropped_products.push({ handle: handle || rawHandle || `#${index}`, reason, ...(detail ? { detail } : {}) });
    if (!p || typeof p !== 'object' || Array.isArray(p)) return drop('not_a_product');
    if (!isSupplierItemKey(SOURCE, handle)) return drop('bad_handle', rawHandle);
    if (seenHandles.has(handle)) return drop('duplicate_handle');

    let url;
    if (p.url === null || p.url === undefined || p.url === '') url = withSkipRegionRedirect(`${EU_STORE_ORIGIN}/products/${encodeURIComponent(handle)}`);
    else {
      const u = urlOn(p.url, EU_STORE_HOST);
      if (!u) return drop('not_eu_store_url', String(p.url));
      url = withSkipRegionRedirect(u.href);
    }

    const name = storeText(p.name) || handle;
    const title = storeText(name, L.title);
    if (title.length < name.length) report.notes.push({ handle, note: 'name_cut' });
    const type = typeof p.type === 'string' ? p.type.trim() : '';
    const category = type !== 'unknown' && CATEGORY_GRAMMAR.test(type) ? type : '';
    const sourcing = SOURCING_HINTS.includes(p.sourcing) ? p.sourcing : '';
    const route = ROUTE_HINTS.includes(p.freight_route) ? p.freight_route : '';

    const skus = [];
    const sales = [];
    const seenSkus = new Set();
    const variants = Array.isArray(p.variants) ? p.variants : [];
    variants.forEach((v, j) => {
      const refuse = (reason, detail) => report.refused_variants.push({ handle, sku: (v && typeof v === 'object' && v.sku != null ? String(v.sku) : '') || `#${j}`, reason, ...(detail ? { detail } : {}) });
      if (!v || typeof v !== 'object' || Array.isArray(v)) return refuse('not_a_variant');
      const skuKey = variantKey(v);
      if (!isSupplierSkuKey(SOURCE, skuKey)) return refuse('bad_sku');
      if (seenSkus.has(skuKey)) return refuse('duplicate_sku');
      const currency = typeof v.currency === 'string' ? v.currency.trim().toUpperCase() : '';
      if (currency !== 'EUR') return refuse('currency_not_eur', currency || 'none');
      if (v.url !== null && v.url !== undefined && v.url !== '' && !urlOn(v.url, EU_STORE_HOST)) return refuse('not_eu_store_url', String(v.url));
      const price = priceTextOf(v.price_eur);
      if (price.refused) return refuse(price.refused, v.price_eur === undefined ? undefined : JSON.stringify(v.price_eur));

      const values = (Array.isArray(v.option_values) ? v.option_values.filter((x) => typeof x === 'string') : optionValuesFromName(v.name, p.name))
        .map((x) => storeText(x, L.optionValue))
        .filter(Boolean);
      const options = positionalOptions(values);
      const codes = [...new Set([v.colour_code, ...(Array.isArray(v.colour_codes) ? v.colour_codes : [])].filter((c) => typeof c === 'string' && CODE_GRAMMAR.test(c)))];
      seenSkus.add(skuKey);
      // On sale, price_eur is already the regular price (assemble-snapshot.mjs); the sale price is only listed.
      const sale = v.on_sale === true ? priceTextOf(v.sale_price_eur).price : undefined;
      if (sale && decimalAbove(price.price, sale)) sales.push({ handle, sku: skuKey, price: price.price, sale_price: sale });
      skus.push({
        sku_key: skuKey,
        options,
        options_en: { ...options },
        price: price.price,
        price_label: '',
        quantity: quantityFromAvailability(v.availability),
        sku_code: '',
        ...(codes.length ? { codes } : {}),
      });
    });
    if (!skus.length) return drop('no_priced_variant');

    const item = {
      item_key: handle,
      url,
      page_host: EU_STORE_HOST,
      title,
      name_en: title,
      category,
      sourcing,
      freight_route: route,
      skus,
    };
    const refusal = itemRefusal(item, SOURCE);
    if (refusal) return drop('invalid_item', refusal);
    seenHandles.add(handle);
    items.push(item);
    report.on_sale.push(...sales);
  });

  report.items = items.length;
  report.skus = items.reduce((n, it) => n + it.skus.length, 0);
  if (!items.length) return { file: null, report };
  const file = {
    format: SUPPLIER_PRICE_FORMAT,
    source: SOURCE,
    currency: 'EUR',
    price_basis: 'list',
    capture: 'browser_sweep',
    captured_on: capturedOn,
    captured_by: cleanText(capturedBy, L.capturedBy),
    items,
  };
  return { file, report };
}

const USAGE = 'usage: node scripts/supplier-prices/normalize-eu-snapshot.mjs <eu-store-YYYY-MM-DD.json> [--captured-by "<who>"]';

if (isMain(import.meta.url)) {
  process.exitCode = runNormalizerCli(process.argv.slice(2), { normalize: normalizeEuSnapshot, usage: USAGE });
}
