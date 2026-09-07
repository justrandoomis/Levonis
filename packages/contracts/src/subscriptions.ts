/**
 * The static subscriptions table (`03-EVENTS.md` §6) — consumers AND producers
 * per event type. The dispatcher (`RpcFanoutBus` / `QueueBus`) fans out from
 * `SUBSCRIPTIONS`; every consumer refuses an envelope whose `source_service`
 * (and, in rpc mode, hop `iss`) is not in `PRODUCERS[event_type]`.
 *
 * Phases 1–3 seed. Later phases append consumers (Phase 4: `invoices` on
 * `OrderPaid`; Phase 6b: `identity` on `SubscriptionChanged`; …) and remove
 * `'core'` from a type's producers once its emitter has left the core.
 * `tests/eventSchemas.test.ts` pins the invariants listed at the bottom.
 */
import { PII_RANK, type PiiClass } from './envelope';

/** Every service name that may appear as a producer, a consumer or a hop issuer. */
export const SERVICE_NAMES = [
  'core', 'gateway', 'identity', 'kyc', 'catalog', 'commerce', 'ledger', 'subscriptions', 'referrals',
  'marketplace', 'fulfilment', 'devices', 'chat', 'notifications', 'reviews', 'files', 'search',
  'analytics', 'ads', 'risk', 'audit', 'admin', 'config', 'policies', 'support', 'invoices', 'invest',
  'farm', 'studio',
] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

// consumers per event type — no wildcard: Analytics is listed explicitly where it may read
export const SUBSCRIPTIONS: Record<string, ServiceName[]> = {
  'UserCreated.v1':            ['notifications', 'risk', 'audit', 'analytics'],          // no ads: no consent can exist at signup
  'UserUpdated.v1':            ['ads', 'analytics'],                                     // consent snapshot; Farm/Marketplace/Chat later
  'ProductViewed.v1':          ['ads', 'search', 'analytics'],                           // best_effort
  'ProductAdded.v1':           ['search', 'analytics'],
  'InventoryChanged.v1':       ['search', 'analytics'],
  'AddToCart.v1':              ['ads', 'analytics'],                                     // best_effort
  'CheckoutStarted.v1':        ['ads', 'risk', 'analytics'],
  'OrderCreated.v1':           ['notifications', 'risk', 'audit', 'analytics'],          // never ads
  'OrderPaid.v1':              ['notifications', 'analytics'],
  'PaymentAuthorized.v1':      ['risk', 'analytics'],
  'PaymentCompleted.v1':       ['notifications', 'risk', 'audit', 'analytics'],
  'PaymentFailed.v1':          ['risk', 'notifications', 'analytics'],
  'RefundCompleted.v1':        ['notifications', 'risk', 'audit', 'analytics'],
  'OrderStatusChanged.v1':     ['notifications', 'analytics'],
  'OrderDelivered.v1':         ['notifications', 'analytics'],
  'PurchaseCompleted.v1':      ['ads', 'analytics'],                                     // produced on OrderPaid / OrderDelivered
  'ReferralUsed.v1':           ['notifications', 'risk', 'analytics'],
  'SubscriptionChanged.v1':    ['ads', 'notifications', 'analytics'],                    // + 'identity' from Phase 6b
  'RequestPublished.v1':       ['notifications', 'analytics'],
  'SessionRevoked.v1':         ['gateway'],
  'RoleChanged.v1':            ['audit', 'gateway'],                                     // personal — never analytics
  'DepositRequested.v1':       ['notifications', 'risk'],                                // personal
  'DepositDecided.v1':         ['notifications', 'risk', 'audit'],                       // personal
  'WithdrawalStateChanged.v1': ['notifications', 'risk', 'audit'],                       // personal
  'AuditRecorded.v1':          ['audit'],
  'RateLimitHit.v1':           ['risk', 'analytics'],                                    // best_effort
  'TurnstileFailed.v1':        ['risk', 'analytics'],                                    // best_effort
  'EventRejected.v1':          ['audit'],
};

/** `'*'` = every service, through the audit() facade; still signed by the emitting service. */
export const ANY_PRODUCER = '*';

// producers per event type — verified by signature on every delivery, in rpc and queue mode alike
export const PRODUCERS: Record<string, string[]> = {
  'UserCreated.v1': ['identity', 'core'], 'UserUpdated.v1': ['identity', 'core'], 'SessionRevoked.v1': ['identity', 'core'],
  'RoleChanged.v1': ['identity', 'core'],
  'ProductViewed.v1': ['catalog', 'core'], 'ProductAdded.v1': ['catalog', 'core'], 'InventoryChanged.v1': ['catalog', 'core'],
  'AddToCart.v1': ['commerce', 'core'], 'CheckoutStarted.v1': ['commerce', 'marketplace', 'core'],
  'OrderCreated.v1': ['commerce', 'core'], 'OrderPaid.v1': ['commerce', 'core'], 'OrderStatusChanged.v1': ['commerce', 'core'],
  'OrderDelivered.v1': ['commerce', 'core'], 'PurchaseCompleted.v1': ['commerce', 'core'],
  'PaymentAuthorized.v1': ['ledger', 'core'], 'PaymentCompleted.v1': ['ledger', 'core'], 'PaymentFailed.v1': ['ledger', 'commerce', 'core'],
  'RefundCompleted.v1': ['ledger', 'core'], 'DepositRequested.v1': ['ledger', 'core'], 'DepositDecided.v1': ['ledger', 'core'],
  'WithdrawalStateChanged.v1': ['ledger', 'core'],
  'ReferralUsed.v1': ['referrals', 'core'], 'SubscriptionChanged.v1': ['subscriptions', 'core'],
  'RequestPublished.v1': ['marketplace', 'core'],
  'RateLimitHit.v1': ['gateway'], 'TurnstileFailed.v1': ['gateway'],
  'AuditRecorded.v1': [ANY_PRODUCER],
  'EventRejected.v1': [ANY_PRODUCER],
};

/**
 * The most sensitive class each consumer may receive (`03-EVENTS.md` §5 rule 1).
 * Ads, Analytics, Search and Farm never see `personal`; the bus refuses to
 * deliver it to them and the eventSchemas test refuses to list them on one.
 */
export const CONSUMER_PII_MAX: Record<ServiceName, PiiClass> = {
  ads: 'pseudonymous', analytics: 'pseudonymous', search: 'pseudonymous', farm: 'pseudonymous',
  core: 'personal', gateway: 'personal', identity: 'personal', kyc: 'personal', catalog: 'personal', commerce: 'personal',
  ledger: 'personal', subscriptions: 'personal', referrals: 'personal', marketplace: 'personal', fulfilment: 'personal',
  devices: 'personal', chat: 'personal', notifications: 'personal', reviews: 'personal', files: 'personal', risk: 'personal',
  audit: 'personal', admin: 'personal', config: 'personal', policies: 'personal', support: 'personal', invoices: 'personal',
  invest: 'personal', studio: 'personal',
};

export function subscribersOf(key: string): ServiceName[] {
  return SUBSCRIPTIONS[key] ?? [];
}

export function producersOf(key: string): string[] {
  return PRODUCERS[key] ?? [];
}

/** True when `source` may produce `key` (respecting the `'*'` wildcard). */
export function isAllowedProducer(key: string, source: string): boolean {
  const list = PRODUCERS[key];
  if (!list) return false;
  return list.includes(ANY_PRODUCER) || list.includes(source);
}

/** True when `consumer` may receive an envelope of `piiClass`. */
export function mayConsume(consumer: string, piiClass: PiiClass): boolean {
  const max = (CONSUMER_PII_MAX as Record<string, PiiClass | undefined>)[consumer] ?? 'none';
  return PII_RANK[piiClass] <= PII_RANK[max];
}

/** Subscribers that may actually receive this envelope's class. */
export function deliverableSubscribers(key: string, piiClass: PiiClass): ServiceName[] {
  return subscribersOf(key).filter((c) => mayConsume(c, piiClass));
}
