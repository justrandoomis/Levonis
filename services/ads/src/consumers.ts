/**
 * The bus consumer (`03-EVENTS.md` §2.3). `defineConsumer` does the parts that
 * must happen before any state is touched — envelope shape, producer
 * allowlist, Ed25519 signature, `piiMax`, payload schema, `processed_events`
 * — and this file supplies only the side effect, as statements that ride in
 * the SAME batch as the processed-events row.
 *
 * `piiMax: 'pseudonymous'` is the hard boundary of `01-TARGET.md` §9.1: the bus
 * refuses to hand Ads a `personal` envelope, so `KycDecided`, `RoleChanged`,
 * `DepositDecided` and every money movement are unreachable from here even if
 * someone adds `ads` to their subscriber list by mistake.
 */
import { defineConsumer, type Consumer, type EventHandler } from '@levonis/platform-kit/consumer';
import type { KeyRing } from '@levonis/platform-kit/keys';
import type { Logger } from '@levonis/platform-kit/log';
import { deliverEnvelope, type DeliverDeps } from './deliver';

/** Exactly the six types `subscriptions.ts` lists for `ads` — no more, no wildcard. */
export const ADS_EVENT_TYPES = [
  'UserUpdated.v1',
  'ProductViewed.v1',
  'AddToCart.v1',
  'CheckoutStarted.v1',
  'PurchaseCompleted.v1',
  'SubscriptionChanged.v1',
] as const;

export interface AdsConsumerOptions {
  keys: KeyRing;
  /** everything the delivery engine needs except the database, which `deliver()` supplies */
  deps: Omit<DeliverDeps, 'db'>;
  acceptFixtureSig?: boolean;
  log?: Logger;
  now?: () => string;
}

export function createAdsConsumer(opts: AdsConsumerOptions): Consumer {
  const handler: EventHandler = async (envelope, ctx) => {
    const result = await deliverEnvelope(envelope, { ...opts.deps, db: ctx.db, now: () => ctx.now });
    opts.log?.info('ads.delivered', {
      event_id: envelope.event_id,
      type: envelope.event_type,
      outcomes: result.outcomes.map((o) => `${o.provider}:${o.status}`),
    });
    return result.statements;
  };
  const handlers: Record<string, EventHandler> = {};
  for (const key of ADS_EVENT_TYPES) handlers[key] = handler;
  return defineConsumer({
    name: 'ads',
    piiMax: 'pseudonymous',
    keys: opts.keys,
    handlers,
    acceptFixtureSig: opts.acceptFixtureSig,
    now: opts.now,
    log: opts.log,
  });
}
