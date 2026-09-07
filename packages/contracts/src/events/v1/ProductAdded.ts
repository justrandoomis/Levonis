import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, str, bool, nonNegInt, arr, nonEmptyStr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  product_id: id,
  slug: id,
  status: nonEmptyStr,
  catalog_ids: arr(id, { max: 50 }),
  brand_id: idOrNull,
  is_printer: bool, // catalogs.is_printer_catalog resolved at write time
  doc_version: nonNegInt,
  structure_hash: nonEmptyStr,
  names: obj({ ar: str, en: str, ckb: str }), // display names only
  images: arr(str, { max: 100 }), // R2 keys
  op_id: id, // the write's idempotency key
};
const check = obj(shape);
export type ProductAddedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.3 (= ProductUpserted) — never cost, margin or supplier price. */
export const ProductAddedV1 = defineEvent<ProductAddedV1>({
  type: 'ProductAdded', aggregate_type: 'product', pii_class: 'none', pii: [], fields: keysOf(shape), check,
  doc: 'A product document was saved (admin form, template, import).',
});
