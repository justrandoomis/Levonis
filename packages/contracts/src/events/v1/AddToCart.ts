import { defineEvent, keysOf } from '../define';
import { obj, id, userHash, posInt, nonNegInt, sellerType, nonEmptyStr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  user_hash: userHash, // daily-salted user id hash
  product_id: id,
  line_key: nonEmptyStr, // cart line identity (0032_cart_line_identity.sql)
  qty: posInt,
  seller_type: sellerType,
  price_iqd_snapshot: nonNegInt, // the resolved unit price at the time
};
const check = obj(shape);
export type AddToCartV1 = Infer<typeof check>;
/** 03-EVENTS.md §3.5 — Cart, best_effort. */
export const AddToCartV1 = defineEvent<AddToCartV1>({
  type: 'AddToCart', aggregate_type: 'cart', pii_class: 'pseudonymous', delivery: 'best_effort', pii: ['user_hash'], fields: keysOf(shape), check,
  doc: 'A line was added to a cart or its quantity increased.',
});
