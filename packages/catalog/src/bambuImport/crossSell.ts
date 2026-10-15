/**
 * THE ONE READER OF THE CROSS-SELL PAYLOAD (spec §C.1 "SKU codes", §C.10).
 *
 * Product pages publish no SKU code of their own (`skuCode` is null for every
 * variant). Real codes (`RSP001`, `B-SA001`, `FAP027+FAP028+SCA003`) appear
 * only in the add-on groups other pages offer:
 *
 *   relationProducts.randomBuyRangeGroupList[].{spuList,skuList}[].productSku.{id, seoCode, skuCode}
 *
 * That payload also carries prices, `availableStock` and `trackingQuantity`.
 * This module reads EXACTLY the three fields above, through the same
 * recording Reader as extract.ts with its own closed list, and nothing else;
 * tests/bambuCrossSell.test.ts proves on a page wrapped in a recording Proxy
 * that no other key of the payload is ever read.
 *
 * Harvesting runs in P0 across all pages; a code is kept only when its
 * `seoCode` is the product's own handle and its `productSku.id` is one of
 * that product's variant ids, then frozen in the reviewed manifest.
 */
import { Reader, walkRows } from './extract';
import { decodeHandle } from './normalize';
import { deref, type RowValue } from './rsc';

export const CROSS_SELL_READ_LIST: readonly string[] = [
  'X.randomBuyRangeGroupList', 'X.randomBuyRangeGroupList[]',
  'X.randomBuyRangeGroupList[].spuList', 'X.randomBuyRangeGroupList[].spuList[]',
  'X.randomBuyRangeGroupList[].spuList[].productSku', 'X.randomBuyRangeGroupList[].spuList[].productSku.id',
  'X.randomBuyRangeGroupList[].spuList[].productSku.seoCode', 'X.randomBuyRangeGroupList[].spuList[].productSku.skuCode',
  'X.randomBuyRangeGroupList[].skuList', 'X.randomBuyRangeGroupList[].skuList[]',
  'X.randomBuyRangeGroupList[].skuList[].productSku', 'X.randomBuyRangeGroupList[].skuList[].productSku.id',
  'X.randomBuyRangeGroupList[].skuList[].productSku.seoCode', 'X.randomBuyRangeGroupList[].skuList[].productSku.skuCode',
];

export interface CrossSellCode {
  /** productSku.id: a variant id of the OTHER product. */
  variantId: string;
  /** decoded productSku.seoCode: that product's handle. */
  handle: string;
  skuCode: string;
}

/**
 * Every (variant id, handle, sku code) a page offers as an add-on. Found by
 * locating the objects that hold `relationProducts` (the buy-box props) —
 * key names only — and reading the payload through the closed list.
 */
export function harvestCrossSell(rows: Map<string, RowValue>, record: Set<string> = new Set()): CrossSellCode[] {
  const holders: unknown[] = [];
  const seen = new Set<unknown>();
  walkRows(rows, {
    element: (_type, props) => {
      if ('relationProducts' in props) {
        const v = props.relationProducts; // the value is not read here; the Reader derefs it under its list
        if (!seen.has(v)) {
          seen.add(v);
          holders.push(v);
        }
      }
    },
    object: (o) => {
      if ('relationProducts' in o && !Array.isArray(o)) {
        const v = o.relationProducts;
        if (!seen.has(v)) {
          seen.add(v);
          holders.push(v);
        }
      }
      return false;
    },
  });
  const out = new Map<string, CrossSellCode>();
  for (const h of holders) {
    const x = deref(rows, h);
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const r = new Reader({ rows, list: new Set(CROSS_SELL_READ_LIST), record }, x, 'X');
    for (const group of r.arr('randomBuyRangeGroupList')) {
      for (const listKey of ['spuList', 'skuList'] as const) {
        for (const item of group.arr(listKey)) {
          const ps = item.obj('productSku');
          if (!ps) continue;
          const variantId = ps.str('id');
          const skuCode = ps.str('skuCode').trim();
          const handle = decodeHandle(ps.str('seoCode'));
          if (!variantId || !skuCode || !handle) continue;
          out.set(`${variantId}|${skuCode}`, { variantId, handle, skuCode });
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.handle + a.variantId).localeCompare(b.handle + b.variantId));
}

/**
 * The codes that belong to one product: `seoCode` equals its handle AND the
 * id is one of its variants. A variant offered with two different codes is a
 * conflict and keeps neither (no code is guessed).
 */
export function codesForProduct(
  harvest: readonly CrossSellCode[],
  product: { handle: string; variantIds: readonly string[] }
): { codes: Record<string, string>; conflicts: string[] } {
  const ids = new Set(product.variantIds);
  const byVariant = new Map<string, Set<string>>();
  for (const c of harvest) {
    if (c.handle !== product.handle || !ids.has(c.variantId)) continue;
    const set = byVariant.get(c.variantId) ?? new Set<string>();
    set.add(c.skuCode);
    byVariant.set(c.variantId, set);
  }
  const codes: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const [variantId, set] of [...byVariant].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size === 1) codes[variantId] = [...set][0];
    else conflicts.push(variantId);
  }
  return { codes, conflicts };
}
