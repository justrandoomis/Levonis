import { defineEvent, keysOf } from '../define';
import { obj, nonEmptyStr, hex64, oneOf } from '../common';
import type { Infer } from '../../schema';

const shape = {
  class: nonEmptyStr,
  key_hash: hex64,
  route_class: nonEmptyStr,
  host_kind: oneOf('main', 'system', 'merchant', 'foreign'),
};
const check = obj(shape);
export type RateLimitHitV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — Gateway, sampled, best_effort. */
export const RateLimitHitV1 = defineEvent<RateLimitHitV1>({
  type: 'RateLimitHit', aggregate_type: 'gateway', pii_class: 'none', delivery: 'best_effort', pii: [], fields: keysOf(shape), check,
  doc: 'A rate-limit class refused a request.',
});
