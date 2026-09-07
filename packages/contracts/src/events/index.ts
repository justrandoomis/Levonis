/**
 * The registry of every event schema, keyed `'<Type>.v<version>'`. The bus,
 * `defineConsumer` and `tests/eventSchemas.test.ts` all read it; adding an event
 * is adding a file under `v1/`, a fixture under `fixtures/` and a line here.
 */
import type { EventSchema } from './define';
import { UserCreatedV1 } from './v1/UserCreated';
import { UserUpdatedV1 } from './v1/UserUpdated';
import { SessionRevokedV1 } from './v1/SessionRevoked';
import { RoleChangedV1 } from './v1/RoleChanged';
import { ProductViewedV1 } from './v1/ProductViewed';
import { ProductAddedV1 } from './v1/ProductAdded';
import { InventoryChangedV1 } from './v1/InventoryChanged';
import { AddToCartV1 } from './v1/AddToCart';
import { CheckoutStartedV1 } from './v1/CheckoutStarted';
import { OrderCreatedV1 } from './v1/OrderCreated';
import { OrderPaidV1 } from './v1/OrderPaid';
import { PaymentAuthorizedV1 } from './v1/PaymentAuthorized';
import { PaymentCompletedV1 } from './v1/PaymentCompleted';
import { PaymentFailedV1 } from './v1/PaymentFailed';
import { RefundCompletedV1 } from './v1/RefundCompleted';
import { OrderStatusChangedV1 } from './v1/OrderStatusChanged';
import { OrderDeliveredV1 } from './v1/OrderDelivered';
import { PurchaseCompletedV1 } from './v1/PurchaseCompleted';
import { ReferralUsedV1 } from './v1/ReferralUsed';
import { SubscriptionChangedV1 } from './v1/SubscriptionChanged';
import { RequestPublishedV1 } from './v1/RequestPublished';
import { DepositRequestedV1 } from './v1/DepositRequested';
import { DepositDecidedV1 } from './v1/DepositDecided';
import { WithdrawalStateChangedV1 } from './v1/WithdrawalStateChanged';
import { AuditRecordedV1 } from './v1/AuditRecorded';
import { RateLimitHitV1 } from './v1/RateLimitHit';
import { TurnstileFailedV1 } from './v1/TurnstileFailed';
import { EventRejectedV1 } from './v1/EventRejected';

export type { EventSchema, EnvelopeInput } from './define';
export { defineEvent } from './define';

const ALL = [
  UserCreatedV1, UserUpdatedV1, SessionRevokedV1, RoleChangedV1,
  ProductViewedV1, ProductAddedV1, InventoryChangedV1,
  AddToCartV1, CheckoutStartedV1, OrderCreatedV1, OrderPaidV1, OrderStatusChangedV1, OrderDeliveredV1, PurchaseCompletedV1,
  PaymentAuthorizedV1, PaymentCompletedV1, PaymentFailedV1, RefundCompletedV1, DepositRequestedV1, DepositDecidedV1, WithdrawalStateChangedV1,
  ReferralUsedV1, SubscriptionChangedV1, RequestPublishedV1,
  AuditRecordedV1, RateLimitHitV1, TurnstileFailedV1, EventRejectedV1,
] as const satisfies readonly EventSchema[];

export type EventTypeKey = (typeof ALL)[number]['key'];

export const EVENT_SCHEMAS: Readonly<Record<string, EventSchema>> = Object.freeze(
  Object.fromEntries(ALL.map((s) => [s.key, s as EventSchema]))
);

export function schemaFor(type: string, version = 1): EventSchema | null {
  return EVENT_SCHEMAS[`${type}.v${version}`] ?? null;
}

export {
  UserCreatedV1, UserUpdatedV1, SessionRevokedV1, RoleChangedV1,
  ProductViewedV1, ProductAddedV1, InventoryChangedV1,
  AddToCartV1, CheckoutStartedV1, OrderCreatedV1, OrderPaidV1, OrderStatusChangedV1, OrderDeliveredV1, PurchaseCompletedV1,
  PaymentAuthorizedV1, PaymentCompletedV1, PaymentFailedV1, RefundCompletedV1, DepositRequestedV1, DepositDecidedV1, WithdrawalStateChangedV1,
  ReferralUsedV1, SubscriptionChangedV1, RequestPublishedV1,
  AuditRecordedV1, RateLimitHitV1, TurnstileFailedV1, EventRejectedV1,
};
