#!/usr/bin/env node
/**
 * THE TMALL SNAPSHOT AS A SUPPLIER PRICE FILE (docs/SMART_PRICING.md §3.1, §3.3; WP4).
 *
 *   node scripts/supplier-prices/normalize-tmall.mjs data/bambu-cn-prices/tmall-store-2026-10-31.json
 *        [--captured-by "<who>"]
 *
 * The official Bambu Lab store on Tmall (拓竹官方旗舰店) is read in a browser;
 * data/bambu-cn-prices/tools/assemble-snapshot.mjs gathers the page captures into
 * tmall-store-<date>.json. This tool turns that snapshot into a `levonis.supplier-prices.v1`
 * file, <name>.v1.json beside it, for the owner's upload door (§3.4). It reads no network.
 *
 *   snapshot                                  v1
 *   captured_on                               captured_on; source tmall_cn, currency CNY,
 *                                             price_basis "list", capture "browser_sweep"
 *   items[].item_id                           item_key
 *   items[].url (else built from the id)      url, and its host as page_host
 *   items[].title / name_en / category        title / name_en / category (the capture's 16 categories)
 *   items[].sourcing / freight_route / codes  sourcing / freight_route / codes, as the capture's rules set them
 *   items[].props                             props (the item's option groups, kept as captured)
 *   skus[].sku_id                             sku_key
 *   skus[].options / options_en / codes       options / options_en / codes
 *   skus[].price_cny                          price, the exact decimal text ("99", "19.7")
 *   skus[].price_title                        price_label: the words printed beside the price
 *                                             (优惠前, "before discounts"). It is a LABEL, never a
 *                                             price: a figure found there is dropped, not used.
 *   skus[].quantity                           quantity
 *
 * A LISTING WITHOUT OPTIONS (no SKU rows and no option groups: one product at one price) is
 * one SKU keyed by its own item id, with no options. Its price is the page's price
 * (from_price_cny, the capture's price_source 'from_price', one amount) and its label
 * from_price_title. It is kept only when the listing is an offer: no not-for-sale, placeholder,
 * pre-launch or discontinued flag, and no parked price (all 9s, 9999 and up). Its option link
 * is the item page (links.ts). The report notes it as single_price_item.
 *
 * DROPPED, never written, and listed in the report: an item whose price the page hid
 * (hidden_price), whose capture failed, or with no priced SKU left; a SKU the capture marks
 * not for sale (a reminder option or a parked placeholder price), with no or a malformed id, or
 * whose price is missing or not an amount with at most two decimals (never rounded). The whole
 * file then goes through the parser the upload door runs: a file it refuses is never written.
 *
 * Owner-only data (invariant I6); the captures stay out of git (owner question 282(g)).
 * Exit codes: 0 written; 2 nothing to write; 1 an unreadable input or a refused file.
 */
import {
  CATEGORY_GRAMMAR,
  CODE_GRAMMAR,
  ROUTE_HINTS,
  SOURCING_HINTS,
  SUPPLIER_PRICE_FORMAT,
  SUPPLIER_PRICE_LIMITS,
  SnapshotInputError,
  captureDate,
  cleanText,
  isMain,
  isSupplierItemKey,
  isSupplierSkuKey,
  itemRefusal,
  priceTextOf,
  runNormalizerCli,
  supplierHostAllowed,
} from './normalize-eu-snapshot.mjs';

const SOURCE = 'tmall_cn';

/** A price smuggled into the label (a currency sign or a bare amount): the parser refuses one, so it is dropped here. */
const FIGURE_LABEL = /[¥￥$€]|^\s*[0-9]+(?:[.,][0-9]+)?\s*(?:元|CNY|EUR|USD)?\s*$/i;

/** The item's own address when it is a Tmall or Taobao https page, else the item page built from its id. */
function itemUrl(value, itemKey) {
  if (typeof value === 'string' && value.trim()) {
    try {
      const u = new URL(value.trim());
      if (u.protocol === 'https:' && !u.username && !u.password && !u.port && supplierHostAllowed(SOURCE, u.hostname) && u.href.length <= SUPPLIER_PRICE_LIMITS.url) return u;
    } catch {
      /* not an address: the item page is built from the id */
    }
  }
  return new URL(`https://detail.tmall.com/item.htm?id=${itemKey}`);
}

/** Codes the parser's grammar accepts, once each. */
function codeList(value, maxJson) {
  const out = [];
  for (const c of Array.isArray(value) ? value : []) if (typeof c === 'string' && CODE_GRAMMAR.test(c) && !out.includes(c)) out.push(c);
  while (out.length && JSON.stringify(out).length > maxJson) out.pop();
  return out;
}

/** An option object as the parser accepts it: string group names and values, cleaned; empty ones left out. */
function optionObject(value) {
  const L = SUPPLIER_PRICE_LIMITS;
  const entries = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      const key = cleanText(k, L.optionName);
      const text = cleanText(v, L.optionValue);
      if (key && typeof v === 'string' && !entries.some(([seen]) => seen === key)) entries.push([key, text]);
    }
  }
  return Object.fromEntries(entries);
}

/** A stock count: a safe whole number ≥ 0 (or its digits as text), else unknown. */
function quantityOf(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * The words printed beside a price as the label the parser accepts. A figure found there is
 * dropped (it is a label, never a price), as is a label over the parser's length; the report
 * notes either.
 */
function labelOf(value, note) {
  const L = SUPPLIER_PRICE_LIMITS;
  const label = typeof value === 'string' ? cleanText(value) : '';
  if ((value !== null && value !== undefined && typeof value !== 'string') || FIGURE_LABEL.test(label)) {
    note('price_title_figure_dropped');
    return '';
  }
  if (label.length > L.priceLabel) {
    note('price_title_too_long_dropped');
    return '';
  }
  return label;
}

/** Capture flags that say a listing is not an offer: its page price is never kept. */
const NOT_AN_OFFER_FLAGS = ['not_for_sale', 'placeholder', 'pre_launch', 'discontinued'];

/** A price parked by the store (9999, 99999, 999999 …): never an offer for a listing without options. */
const PARKED_PRICE = /^9{4,}(?:\.0{1,2})?$/;

/**
 * The one SKU of a listing without options, keyed by its item id, or `{refused}` with why its
 * page price is not kept. Only for an item the capture read with no SKU rows and no option groups.
 */
function singlePriceSku(it, itemKey, note) {
  if (it.price_source !== 'from_price') return { refused: 'no_page_price' };
  if (Array.isArray(it.props) && it.props.length) return { refused: 'option_groups_without_skus' };
  const flag = (Array.isArray(it.flags) ? it.flags : []).find((f) => NOT_AN_OFFER_FLAGS.includes(f));
  if (flag) return { refused: `listing_${flag}` };
  if (it.price_min_cny !== it.price_max_cny) return { refused: 'page_price_range' };
  const price = priceTextOf(it.from_price_cny);
  if (price.refused) return { refused: `page_price_${price.refused}` };
  if (PARKED_PRICE.test(price.price)) return { refused: 'page_price_parked' };
  if (!isSupplierSkuKey(SOURCE, itemKey)) return { refused: 'bad_item_id' };
  note('single_price_item');
  return {
    sku: {
      sku_key: itemKey,
      options: {},
      options_en: {},
      price: price.price,
      price_label: labelOf(it.from_price_title, note),
      quantity: null,
      sku_code: '',
    },
  };
}

/**
 * The Tmall snapshot as a v1 file: `{file, report}`, `file` null when no item kept a priced SKU.
 * Throws SnapshotInputError when the snapshot has no capture date or no item list.
 */
export function normalizeTmallSnapshot(snapshot, { capturedBy = 'browser sweep' } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new SnapshotInputError('not a Tmall snapshot (an object was expected)');
  const capturedOn = captureDate(snapshot.captured_on);
  if (!capturedOn) throw new SnapshotInputError(`captured_on is not a date (YYYY-MM-DD): ${JSON.stringify(snapshot.captured_on)}`);
  if (!Array.isArray(snapshot.items)) throw new SnapshotInputError('the snapshot has no items list');

  const L = SUPPLIER_PRICE_LIMITS;
  const report = {
    source: SOURCE,
    currency: 'CNY',
    captured_on: capturedOn,
    items_read: snapshot.items.length,
    items: 0,
    skus: 0,
    refused_skus: [],
    dropped_items: [],
    notes: [],
  };
  const items = [];
  const seenItems = new Set();

  snapshot.items.forEach((it, index) => {
    const itemKey = it && typeof it === 'object' && it.item_id !== null && it.item_id !== undefined ? String(it.item_id).trim() : '';
    const drop = (reason, detail) => report.dropped_items.push({ item_key: itemKey || `#${index}`, reason, ...(detail ? { detail } : {}) });
    if (!it || typeof it !== 'object' || Array.isArray(it)) return drop('not_an_item');
    if (!isSupplierItemKey(SOURCE, itemKey)) return drop('bad_item_id');
    if (seenItems.has(itemKey)) return drop('duplicate_item');
    if (it.ok === false) return drop('capture_failed');
    if (it.hidden_price === true) return drop('hidden_price');

    const url = itemUrl(it.url, itemKey);
    const title = cleanText(it.title, L.title);
    const nameEn = cleanText(it.name_en, L.nameEn);
    if (title.length < cleanText(it.title).length || nameEn.length < cleanText(it.name_en).length) report.notes.push({ item_key: itemKey, note: 'title_cut' });
    const category = typeof it.category === 'string' && CATEGORY_GRAMMAR.test(it.category) ? it.category : '';
    let props = Array.isArray(it.props) ? it.props : [];
    if (JSON.stringify(props).length > L.propsJson) {
      props = [];
      report.notes.push({ item_key: itemKey, note: 'props_dropped_too_long' });
    }

    const skus = [];
    const seenSkus = new Set();
    (Array.isArray(it.skus) ? it.skus : []).forEach((s, j) => {
      const skuKey = s && typeof s === 'object' && s.sku_id !== null && s.sku_id !== undefined ? String(s.sku_id).trim() : '';
      const refuse = (reason, detail) => report.refused_skus.push({ item_key: itemKey, sku_key: skuKey || `#${j}`, reason, ...(detail ? { detail } : {}) });
      if (!s || typeof s !== 'object' || Array.isArray(s)) return refuse('not_a_sku');
      if (!isSupplierSkuKey(SOURCE, skuKey)) return refuse('bad_sku_id');
      if (seenSkus.has(skuKey)) return refuse('duplicate_sku');
      if (s.not_for_sale === true) return refuse('not_for_sale', typeof s.not_for_sale_reason === 'string' ? s.not_for_sale_reason : undefined);
      // The price is price_cny and nothing else: price_title is the label beside it.
      const price = priceTextOf(s.price_cny);
      if (price.refused) return refuse(price.refused, s.price_cny === undefined ? undefined : JSON.stringify(s.price_cny));

      const label = labelOf(s.price_title, (note) => report.notes.push({ item_key: itemKey, sku_key: skuKey, note }));
      const codes = codeList(s.codes, L.skuCodesJson);
      seenSkus.add(skuKey);
      skus.push({
        sku_key: skuKey,
        options: optionObject(s.options),
        options_en: optionObject(s.options_en),
        price: price.price,
        price_label: label,
        quantity: quantityOf(s.quantity),
        sku_code: '',
        ...(codes.length ? { codes } : {}),
      });
    });
    if (!skus.length && Array.isArray(it.skus) && it.skus.length === 0) {
      // No SKU rows at all (not: every SKU refused): one product at the page's one price.
      const single = singlePriceSku(it, itemKey, (note) => report.notes.push({ item_key: itemKey, sku_key: itemKey, note }));
      if (!single.sku) return drop('no_priced_sku', single.refused);
      skus.push(single.sku);
    }
    if (!skus.length) return drop('no_priced_sku');

    const item = {
      item_key: itemKey,
      url: url.href,
      page_host: url.hostname,
      title,
      name_en: nameEn,
      category,
      sourcing: SOURCING_HINTS.includes(it.sourcing) ? it.sourcing : '',
      freight_route: ROUTE_HINTS.includes(it.freight_route) ? it.freight_route : '',
      codes: codeList(it.codes, L.itemCodesJson),
      props,
      skus,
    };
    const refusal = itemRefusal(item, SOURCE);
    if (refusal) return drop('invalid_item', refusal);
    seenItems.add(itemKey);
    items.push(item);
  });

  report.items = items.length;
  report.skus = items.reduce((n, it) => n + it.skus.length, 0);
  if (!items.length) return { file: null, report };
  const file = {
    format: SUPPLIER_PRICE_FORMAT,
    source: SOURCE,
    currency: 'CNY',
    price_basis: 'list',
    capture: 'browser_sweep',
    captured_on: capturedOn,
    captured_by: cleanText(capturedBy, L.capturedBy),
    items,
  };
  return { file, report };
}

const USAGE = 'usage: node scripts/supplier-prices/normalize-tmall.mjs <tmall-store-YYYY-MM-DD.json> [--captured-by "<who>"]';

if (isMain(import.meta.url)) {
  process.exitCode = runNormalizerCli(process.argv.slice(2), { normalize: normalizeTmallSnapshot, usage: USAGE });
}
