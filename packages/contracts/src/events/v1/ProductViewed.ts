import { defineEvent, keysOf } from '../define';
import { obj, id, idOrNull, locale, oneOf, nullable, str, hex64 } from '../common';
import type { Infer } from '../../schema';

const shape = {
  product_id: id,
  slug: id,
  catalog_id: idOrNull,
  brand_id: idOrNull,
  lang: locale,
  host_kind: oneOf('main', 'merchant'),
  tier: nullable(str), // membership tier of the viewer
  viewer_hash: nullable(hex64), // daily-salted hash of the user id; null when anonymous
};
const check = obj(shape);
export type ProductViewedV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.2 — Catalog, sampled, best_effort: never written to an outbox. */
export const ProductViewedV1 = defineEvent<ProductViewedV1>({
  type: 'ProductViewed', aggregate_type: 'product', pii_class: 'pseudonymous', delivery: 'best_effort', pii: ['viewer_hash'], fields: keysOf(shape), check,
  doc: 'A public product read (sampled 1:1 signed-in, 1:5 anonymous).',
});
