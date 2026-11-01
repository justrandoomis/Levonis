/**
 * Supplier links for the owner (docs/SMART_PRICING.md §3.9 (supplier links for the owner); owner request of
 * 2026-10-31: "for tmall saved id of every product and link for admin so here
 * can easily found the product by tap on link to order it or update the
 * price").
 *
 * A link is BUILT, never copied: only from an id that passes its grammar —
 * Tmall item and SKU ids are digits only, store handles are `[a-z0-9-]` only,
 * store variant ids are digits only — onto a fixed https origin. A stored URL,
 * a title or any other free text never becomes a link, so a capture cannot
 * plant `javascript:`, `http:` or another host in the owner's panel. An id
 * that fails its grammar gives null (the panel shows the id without a link).
 *
 * The EU store sends visitors from Iraq to another region's store unless the
 * address carries `skr=yes` (skip region redirect), so every EU link carries
 * it, the item link and the variant link alike.
 *
 * Owner-only data: these links name the shop's supplier, so they are served
 * only behind requireCostRead, like every supplier datum (invariant I6).
 */
import type { SupplierSource } from './format';

/** A Tmall item or SKU id: digits only. */
const TMALL_ID = /^[0-9]{1,40}$/;
/** A store handle as these links accept it: lower-case ASCII letters, digits and hyphens, starting with a letter or digit. */
const STORE_HANDLE = /^[a-z0-9][a-z0-9-]{0,119}$/;
/** A store variant id (the JSON-LD `sku`, the `?id=` of a variant page): digits only. */
const STORE_VARIANT_ID = /^[0-9]{1,40}$/;

const TMALL_ITEM = 'https://detail.tmall.com/item.htm';
const EU_STORE = 'https://eu.store.bambulab.com/products/';
const US_STORE = 'https://us.store.bambulab.com/products/';
/** The EU store's skip-region-redirect parameter: without it a visitor from Iraq lands on another region's store. */
export const EU_SKIP_REGION_REDIRECT = 'skr=yes';

export const isTmallId = (v: unknown): v is string => typeof v === 'string' && TMALL_ID.test(v);
export const isStoreHandle = (v: unknown): v is string => typeof v === 'string' && STORE_HANDLE.test(v);
export const isStoreVariantId = (v: unknown): v is string => typeof v === 'string' && STORE_VARIANT_ID.test(v);

/**
 * The supplier page of an item, or null when its key fails the source's grammar:
 *   tmall_cn  https://detail.tmall.com/item.htm?id=<item_key>
 *   bambu_eu  https://eu.store.bambulab.com/products/<handle>?skr=yes
 *   bambu_us  https://us.store.bambulab.com/products/<handle>
 */
export function supplierItemUrl(source: SupplierSource, itemKey: string): string | null {
  switch (source) {
    case 'tmall_cn':
      return isTmallId(itemKey) ? `${TMALL_ITEM}?id=${itemKey}` : null;
    case 'bambu_eu':
      return isStoreHandle(itemKey) ? `${EU_STORE}${itemKey}?${EU_SKIP_REGION_REDIRECT}` : null;
    case 'bambu_us':
      return isStoreHandle(itemKey) ? `${US_STORE}${itemKey}` : null;
    default:
      return null;
  }
}

/**
 * The page that opens one option, colour or variant, or null when either key fails its grammar:
 *   tmall_cn  https://detail.tmall.com/item.htm?id=<item_key>&skuId=<sku_key>
 *   bambu_eu  https://eu.store.bambulab.com/products/<handle>?id=<sku_key>&skr=yes
 *   bambu_us  https://us.store.bambulab.com/products/<handle>?id=<sku_key>
 * A store SKU keyed by its SKU code (a capture without the variant id) has no variant link.
 * A Tmall listing without options has one SKU keyed by its own item id
 * (scripts/supplier-prices/normalize-tmall.mjs): its link is the item page.
 */
export function supplierSkuUrl(source: SupplierSource, itemKey: string, skuKey: string): string | null {
  switch (source) {
    case 'tmall_cn':
      if (!isTmallId(itemKey) || !isTmallId(skuKey)) return null;
      return skuKey === itemKey ? `${TMALL_ITEM}?id=${itemKey}` : `${TMALL_ITEM}?id=${itemKey}&skuId=${skuKey}`;
    case 'bambu_eu':
      return isStoreHandle(itemKey) && isStoreVariantId(skuKey) ? `${EU_STORE}${itemKey}?id=${skuKey}&${EU_SKIP_REGION_REDIRECT}` : null;
    case 'bambu_us':
      return isStoreHandle(itemKey) && isStoreVariantId(skuKey) ? `${US_STORE}${itemKey}?id=${skuKey}` : null;
    default:
      return null;
  }
}
