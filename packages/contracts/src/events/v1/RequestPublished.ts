import { defineEvent, keysOf } from '../define';
import { obj, id, hex64, arr } from '../common';
import type { Infer } from '../../schema';

const shape = {
  request_id: id,
  owner_hash: hex64,
  matched_merchant_ids: arr(id, { max: 200 }),
};
const check = obj(shape);
export type RequestPublishedV1 = Infer<typeof check>;
/** 03-EVENTS.md §4 — Marketplace; Notifications dedups inbox rows on (user_id, event_key). */
export const RequestPublishedV1 = defineEvent<RequestPublishedV1>({
  type: 'RequestPublished', aggregate_type: 'request', pii_class: 'pseudonymous', pii: ['owner_hash'], fields: keysOf(shape), check,
  doc: 'A print/community request went public.',
});
