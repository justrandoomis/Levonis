/**
 * The conversion facts every adapter needs, read out of the six envelopes Ads
 * subscribes to and nothing else.
 *
 * This is the projection step of `03-EVENTS.md` §5: a payload field that is not
 * named here never reaches a provider, a delivery row or a log line. The
 * envelopes are already allowlists (`packages/contracts` refuses an unknown
 * key), so this is the second, narrower allowlist — the one that decides what
 * an advertising platform is told.
 */
import type { EventEnvelope } from '@levonis/contracts/envelope';

export interface ConversionFacts {
  /** the stable hash Ads joins `ads_consent_snapshots` on; null when the envelope names nobody */
  user_hash: string | null;
  /** integer IQD, as everywhere else in the platform */
  value_iqd: number;
  currency: 'IQD';
  /** product ids, in envelope order */
  content_ids: string[];
  num_items: number;
  /** the provider-side dedup id when the conversion has a natural key (an order) */
  order_id: string | null;
}

const EMPTY: ConversionFacts = { user_hash: null, value_iqd: 0, currency: 'IQD', content_ids: [], num_items: 0, order_id: null };

type Payload = Record<string, unknown>;

const strOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const intOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/**
 * `null` for an event type Ads does not project. The caller has already
 * checked the type against `ads_event_map`, so this is a belt-and-braces
 * refusal rather than the primary gate.
 */
export function factsOf(env: EventEnvelope): ConversionFacts | null {
  const p = (env.payload ?? {}) as Payload;
  switch (env.event_type) {
    case 'PurchaseCompleted':
      return {
        user_hash: strOf(p.user_hash),
        value_iqd: intOf(p.value_iqd),
        currency: 'IQD',
        content_ids: Array.isArray(p.content_ids) ? p.content_ids.filter((x): x is string => typeof x === 'string') : [],
        num_items: intOf(p.num_items),
        order_id: strOf(p.order_id),
      };
    case 'AddToCart':
      return {
        ...EMPTY,
        user_hash: strOf(p.user_hash),
        value_iqd: intOf(p.price_iqd_snapshot) * Math.max(1, intOf(p.qty)),
        content_ids: strOf(p.product_id) ? [p.product_id as string] : [],
        num_items: Math.max(1, intOf(p.qty)),
      };
    case 'CheckoutStarted': {
      const lines = Array.isArray(p.lines) ? (p.lines as Payload[]) : [];
      const totals = (p.totals ?? {}) as Payload;
      return {
        ...EMPTY,
        user_hash: strOf(p.user_hash),
        value_iqd: intOf(totals.grand_iqd),
        content_ids: lines.map((l) => strOf(l.product_id)).filter((x): x is string => x !== null),
        num_items: lines.reduce((n, l) => n + Math.max(1, intOf(l.qty)), 0),
      };
    }
    case 'ProductViewed':
      return {
        ...EMPTY,
        // `viewer_hash` is null for an anonymous read; the delivery is then
        // recorded `no_consent` and nothing leaves the platform.
        user_hash: strOf(p.viewer_hash),
        content_ids: strOf(p.product_id) ? [p.product_id as string] : [],
        num_items: 1,
      };
    case 'UserUpdated':
      return { ...EMPTY, user_hash: strOf(p.user_hash) };
    case 'SubscriptionChanged':
      // No hash on this envelope: the join key is derived by the consumer with
      // `stableUserHash(user_id)` and `user_id` itself is never persisted.
      return { ...EMPTY, user_hash: null };
    default:
      return null;
  }
}
