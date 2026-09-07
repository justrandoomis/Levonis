# LEVONIS — Event Catalogue (canonical)

Date: 2026-09-07. Base tree: `89e663e`. Companion to `01-TARGET.md` §5 and `02-MIGRATION-PLAN.md`. Schemas live in `packages/contracts/src/events/v1/<EventType>.ts` (new) with fixtures under `packages/contracts/src/events/fixtures/` (new); `tests/eventSchemas.test.ts` (new) round-trips every fixture and refuses a consumer in `packages/contracts/src/subscriptions.ts` (new) for an event without a schema.

Nothing here is applied. Names marked **(new)** do not exist yet; every table, file and route name otherwise cited exists in the tree.

---

## 1. Envelope

```ts
interface EventEnvelope<T = unknown> {
  event_id: string;            // UUIDv7 — time-ordered, globally unique
  event_type: string;          // 'OrderCreated'
  version: number;             // payload schema version, starts at 1
  created_at: string;          // ISO 8601, producer clock
  source_service: string;      // 'commerce' | 'ledger' | 'identity' | … | 'core' (the legacy monolith while it produces)
  correlation_id: string;      // x-correlation-id of the originating request, or the parent event's correlation_id
  causation_id: string | null; // event_id (or request id) that caused this event
  actor_id: string | null;     // principal.sub when a person acted; null for system/cron
  aggregate_type: string;      // 'order' | 'user' | 'product' | 'wallet' | 'membership' | …
  aggregate_id: string;
  aggregate_seq: number;       // monotonically increasing per (aggregate_type, aggregate_id) — ordering within one aggregate
  pii_class: 'none' | 'pseudonymous' | 'personal';   // decides who may consume: Ads/Analytics accept only 'none' | 'pseudonymous'
  payload: T;                  // validated against the schema for (event_type, version); an allowlist, never a whole row
}
```

Schema files export the TypeScript type, a hand-written `validate(payload): asserts payload is T` (no new runtime dependency), and a `pii: string[]` list naming payload fields that Analytics drops and Ads may only hash under consent. Field rules for every payload: amounts are integers as today (IQD dinars, USD cents, points); ids are opaque strings; never a password hash, token, secret, full phone, cost, margin, commission, admin note or free-text customer message.

## 2. Producer, dispatcher, consumer rules

### 2.1 Outbox in the producer's own store (transactional)

```sql
-- one set per producer; shown for 'commerce' (new tables; in the shared D1 while the service lives there, moved with the service)
CREATE TABLE IF NOT EXISTS commerce_outbox_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,
  event_type     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  aggregate_seq  INTEGER NOT NULL,
  envelope       TEXT NOT NULL,                 -- full JSON envelope
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatched_at  TEXT,                          -- every subscriber acked (rpc mode) or the queue accepted (queue mode)
  UNIQUE (aggregate_type, aggregate_id, aggregate_seq)
);
CREATE INDEX IF NOT EXISTS idx_commerce_outbox_pending ON commerce_outbox_events(dispatched_at) WHERE dispatched_at IS NULL;

CREATE TABLE IF NOT EXISTS commerce_outbox_deliveries (   -- rpc mode only
  event_id        TEXT NOT NULL,
  consumer        TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','acked','dead')),
  last_error      TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL,
  acked_at        TEXT,
  PRIMARY KEY (event_id, consumer)
);
```

Rules: the outbox INSERT is **inside the same `db.batch()` as the business write** (the pattern `notifyStatement` already uses, `worker/lib/notifications.ts:66-72`); `bus.publishStatement(env, envelope)` returns a `D1PreparedStatement` to append; the platform kit's `Uow` refuses to commit a command declared `publishes` without it. `ctx.waitUntil(bus.pump())` after the batch; the producer's cron is the safety net (the core: step 0 of `lib/jobs.ts`; new Workers: their own `* * * * *`). A `pump_lock` row (`UPDATE … WHERE locked_until < now`) keeps two isolates from double-dispatching the same batch. Envelope bodies are retained; pruning older than 180 days is an owner decision; delivery rows are kept.

### 2.2 Dispatcher

- `RpcFanoutBus` (today): `pump` selects `dispatched_at IS NULL` in `seq` order (≤200), computes subscribers from `subscriptions.ts`, calls `env.<CONSUMER>.deliver(batch, hop)` per consumer (≤50 events per call), records per-consumer state; backoff `min(15 min, 5 s·2^attempts)` with jitter; after 8 attempts `state='dead'` (the DLQ is the deliveries table filtered by state); admin RPC `redeliver(event_id, consumer)` replays; `pump` caps at 200 events / 20 consumers per run.
- `QueueBus` (when Queues exist): `pump` does `env.EVENTS_QUEUE.sendBatch(envelopes)` and marks `dispatched_at`; one queue `levonis-events` per environment; each consumer Worker declares `queues.consumers: [{ queue: 'levonis-events', max_batch_size: 50, max_batch_timeout: 5, max_retries: 8, dead_letter_queue: 'levonis-events-dlq' }]` and its `queue(batch)` handler calls the same `deliver()`. Type filtering happens in the consumer. A per-domain queue split (`levonis-events-money`) is a later config change.
- Switch: `EVENT_BUS_MODE = 'rpc' | 'queue'` (var) + presence of the `EVENTS_QUEUE` binding. Producers and consumers do not change.

### 2.3 Consumer

- `<svc>_processed_events (event_id TEXT PRIMARY KEY, consumer TEXT NOT NULL, processed_at TEXT NOT NULL, result TEXT)` (new, per consumer). `deliver()` inserts the row **in the same batch** as the side effect; a PK violation rejects the batch and the event is acked as `replayed`.
- When the effect is a remote command (Referrals → `LEDGER.credit`), the command's `eventKey` is derived deterministically from the event (`ref_<event_id>`) or from the domain key (`wtx_review_<id>`), so a redelivery hits the callee's idempotency and returns `replayed`.
- Money consumers (Ledger, Commerce, Inventory in Catalog, Payments) additionally keep **domain** idempotency (`ledger_idempotency`, `inventory_ledger.idempotency_key` (`0020_inventory_adjust_direction.sql:31`), `orders.idempotency_key` (`0001_init.sql:156`)) so correctness never depends on the event layer.
- Retry only on transient failure (`deliver` throws or returns `{retry:true}`). A schema-invalid event is recorded `result='invalid'`, emits `EventRejected` to Audit and is never retried — a poison message cannot block the stream.
- Ordering: guaranteed per aggregate by `aggregate_seq` from one producer; consumers that keep projections apply "last `aggregate_seq` wins" and ignore stale sequences; no cross-aggregate ordering.
- Replay: `bus.replay(env, {from_seq, to_seq, consumer})` re-delivers from the producer's outbox; safe by construction; Audit and Analytics can be rebuilt from every producer's outbox.
- Observability: `PumpReport {selected, delivered, retried, dead}` logged with `cid`; deep health reports oldest pending event age per producer (alert at 5 minutes).

### 2.4 Versioning

Additive payload changes keep `version`. Breaking changes create `v2/<EventType>.ts`; the producer emits both versions for one phase; consumers declare which versions they accept in `subscriptions.ts`; `tests/eventSchemas.test.ts` fails if a consumer is registered for a version without a schema or a fixture.

### 2.5 Idempotency key rules (summary)

| Rule | Applies to |
|---|---|
| `event_id` is the consumer's dedup key (`processed_events`) | every consumer |
| The domain key is the money/stock key, independent of `event_id` | Ledger (`event_key`), Inventory (`idempotency_key`), Orders (`idempotency_key`), Notifications (`outbox.event_key`, `user_notifications` `(user_id, event_key)`) |
| `aggregate_seq` decides staleness for projections | Analytics, Search, Identity tier copy, Merchants rating copy, Catalog index |
| Provider-side dedup uses our `event_id` (`event_id` field of Meta CAPI etc.) | Ads |

---

## 3. The unified catalogue (owner's list) — v1

Producer names are the end-state services; until a service is extracted, the legacy core emits the event from the same code path (Phase 1.6 of the plan) with `source_service:'core'`. Consumers listed are the subscriptions at the end state; each phase adds consumers as they are extracted.

### 3.1 `UserCreated` v1
- **Producer**: Identity (`routes/auth.ts` signup paths incl. `:1505-1527` Telegram signup; email-first completion).
- **Consumers**: Referrals (attribution — replaces the direct write at `auth.ts:206-221`), Notifications (verification mail), Analytics, Ads (`CompleteRegistration`, only under consent), Risk, Farm (display cache), Audit.
- **Aggregate**: `user` / `user_id` / seq 1. **pii_class**: `pseudonymous`.

| Field | Type | pii | Notes |
|---|---|---|---|
| `user_id` | `string` | | |
| `method` | `'password'\|'google'\|'telegram'\|'email_first'` | | |
| `locale` | `'ar'\|'en'\|'ckb'` | | |
| `referrer_code` | `string \| null` | | the code entered at signup; Referrals resolves it |
| `email_verified` | `boolean` | | |
| `email_hash` | `string \| null` | pii | SHA-256 of the normalised email, for Ads matching under consent only |
| `created_at` | `string` | | |

- **Idempotency**: consumers key on `event_id`; Referrals' attribution insert is UNIQUE on `(referee_id)` in `referral_attributions`.

### 3.2 `ProductViewed` v1
- **Producer**: Catalog (`routes/products.ts` public product read), sampled 1:1 for signed-in users, 1:5 anonymous.
- **Consumers**: Analytics, Ads (`ViewContent`, aggregated per product per hour for anonymous viewers), Loyalty (browse mission — replaces the app-wide ping only when the mission rule allows), Search (popularity).
- **Aggregate**: `product` / `product_id`. **pii_class**: `pseudonymous`.

| Field | Type | pii | Notes |
|---|---|---|---|
| `product_id` | `string` | | |
| `slug` | `string` | | |
| `catalog_id` | `string \| null` | | |
| `brand_id` | `string \| null` | | |
| `lang` | `'ar'\|'en'\|'ckb'` | | |
| `host_kind` | `'main'\|'merchant'` | | |
| `tier` | `string \| null` | | membership tier of the viewer |
| `viewer_hash` | `string \| null` | pii | daily-salted hash of the user id; null when anonymous |

- **Idempotency**: `event_id`; Loyalty's browse credit keys on `(user_id, day)` as today (`browse_sessions`).

### 3.3 `ProductAdded` v1 (= `ProductUpserted`)
- **Producer**: Products package (`routes/adminProducts.ts`, `routes/template.ts`, `routes/adminImport.ts` write paths), one event per saved product.
- **Consumers**: Catalog (read index / cache version), Search, Analytics, Cart (availability flag), Ads catalogue feeds (later).
- **Aggregate**: `product` / `product_id`. **pii_class**: `none`.

| Field | Type | pii | Notes |
|---|---|---|---|
| `product_id` | `string` | | |
| `slug` | `string` | | |
| `status` | `string` | | |
| `catalog_ids` | `string[]` | | |
| `brand_id` | `string \| null` | | |
| `is_printer` | `boolean` | | `catalogs.is_printer_catalog` resolved at write time |
| `doc_version` | `number` | | |
| `structure_hash` | `string` | | |
| `names` | `{ ar: string; en: string; ckb: string }` | | display names only |
| `images` | `string[]` | | R2 keys |
| `op_id` | `string` | | the write's idempotency key |

Never: `product_cost_iqd`, `cost_iqd`, `cost_adjust_iqd`, margins (DECISIONS rows 41/91).
- **Idempotency**: `(product_id, doc_version)`; projections apply last `aggregate_seq` wins.

### 3.4 `InventoryChanged` v1
- **Producer**: Inventory package (`lib/inventory.ts` every ledger write; after Phase 0.6 there is no other stock write path).
- **Consumers**: Catalog (availability, cache version), Search, Analytics, Cart (availability flag).
- **Aggregate**: `product` / `product_id`. **pii_class**: `none`.

| Field | Type | Notes |
|---|---|---|
| `product_id` | `string` | |
| `scope` | `{ table: 'products'\|'product_option_values'\|'product_colors'\|'product_variants'; id: string }` | the row whose stock moved |
| `delta` | `number` | signed |
| `stock_after` | `number` | |
| `reserved_after` | `number` | |
| `reason` | `'reserve'\|'commit'\|'release'\|'deduct'\|'restore'\|'adjust'` | |
| `op_id` | `string` | = `inventory_ledger.idempotency_key` |
| `order_id` | `string \| null` | |

- **Idempotency**: `op_id` (UNIQUE in `inventory_ledger`).

### 3.5 `AddToCart` v1
- **Producer**: Cart (`routes/cart.ts` add / quantity increase).
- **Consumers**: Analytics, Ads (`AddToCart`, under consent).
- **Aggregate**: `cart` / `user_id`. **pii_class**: `pseudonymous`.

| Field | Type | pii | Notes |
|---|---|---|---|
| `user_hash` | `string` | pii | daily-salted user id hash |
| `product_id` | `string` | | |
| `line_key` | `string` | | cart line identity (`0032_cart_line_identity.sql`) |
| `qty` | `number` | | |
| `seller_type` | `'platform'\|'merchant'` | | |
| `price_iqd_snapshot` | `number` | | the resolved unit price at the time |

- **Idempotency**: `event_id`.

### 3.6 `CheckoutStarted` v1
- **Producer**: Checkout (the quote step of `POST /api/orders`, `routes/orders.ts` `computeCheckout`; `routes/storeOrders.ts` quote).
- **Consumers**: Analytics, Ads (`InitiateCheckout`), Risk.
- **Aggregate**: `checkout` / `session_id` (the `checkout_sagas` id once it exists; the `idempotency_key` before). **pii_class**: `pseudonymous`.

| Field | Type | pii | Notes |
|---|---|---|---|
| `session_id` | `string` | | |
| `user_hash` | `string` | pii | |
| `lines` | `{ product_id: string; qty: number }[]` | | |
| `totals` | `{ items_iqd: number; delivery_iqd: number; discount_iqd: number; grand_iqd: number }` | | |
| `payment_method` | `'wallet'\|'cash'` | | ids never renamed (`lib/paymentPolicy.ts`) |
| `seller_type` | `'platform'\|'merchant'` | | |

- **Idempotency**: `event_id`; at most one per `session_id` (the producer checks).

### 3.7 `OrderCreated` v1
- **Producer**: Orders — inside the order batch (today `routes/orders.ts:1318-1493`; step 6 of the saga later); store orders via `ORDERS.createMerchantOrder`.
- **Consumers**: Fulfilment (init stage — replaces inline `initOrderStage`), Invoices (replaces the synchronous `createInvoiceForOrder` call at `orders.ts:1556`), Notifications (customer + admin Telegram), Payments (settlement row), Loyalty (accrual planning), Referrals, Merchants (projection for `seller_type='merchant'`), Coupons (commit), Analytics, Ads (as `PurchaseCompleted` when prepaid — see 3.14), Risk, Chat (order-room eligibility), Audit.
- **Aggregate**: `order` / `order_id` / seq 1. **pii_class**: `pseudonymous` (address by reference).

| Field | Type | pii | Notes |
|---|---|---|---|
| `order_id` | `string` | | |
| `user_id` | `string` | | |
| `seller_type` | `'platform'\|'merchant'` | | |
| `merchant_id`, `store_id` | `string \| null` | | |
| `items` | `{ order_item_id: string; product_id: string; qty: number; unit_price_iqd: number; is_printer: boolean; warranty_snapshot: object \| null; ops_policy: object \| null }[]` | | what Devices needs on delivery |
| `totals` | `{ merchandise_iqd: number; delivery_iqd: number; discount_iqd: number; total_iqd: number }` | | |
| `payment` | `{ method: 'wallet'\|'cash'; wallet_usd_cents: number; points: number; cod_iqd: number; exchange_rate: number }` | | |
| `shipping_type` | `string` | | |
| `address_snapshot_ref` | `string` | | the address id — never the address itself |
| `coupon_code` | `string \| null` | | |
| `membership_gift` | `boolean` | | |
| `referral_delivery_waived` | `boolean` | | |
| `idempotency_key` | `string` | | `orders.idempotency_key` |
| `created_at` | `string` | | |

Never: `commission_percent_x100`, `platform_fee_iqd`, `merchant_receivable_iqd`, `admin_note` (assessment HIGH: internal commission must not leak).
- **Idempotency**: `order_id`; Invoices' `createInvoiceForOrder` is replay-safe; Fulfilment's `initOrderStage` is conditional on no existing stage row.

### 3.8 `PaymentAuthorized` v1
- **Producer**: Ledger (a purchase/escrow hold placed — `createPurchaseHold`, `walletOps.ts:301`) or Payments (a PSP authorisation later).
- **Consumers**: Analytics, Risk.
- **Aggregate**: `wallet` / `user_id`. **pii_class**: `none`.

| Field | Type | Notes |
|---|---|---|
| `order_id` | `string \| null` | |
| `user_id` | `string` | |
| `kind` | `'wallet_hold'\|'escrow_hold'\|'psp_auth'` | |
| `currency` | `'USD'\|'POINT'\|'IQD'` | |
| `amount` | `number` | |
| `hold_id` | `string \| null` | |
| `event_key` | `string` | the hold's `wallet_holds.event_key` |

- **Idempotency**: `event_key`.

### 3.9 `PaymentCompleted` v1
- **Producer**: Ledger (`commitHoldAndDebit`, direct debit, deposit approved via `decideDeposit`) or Payments (COD settlement recorded, escrow released, PSP capture later).
- **Consumers**: Orders (settlement flag), Ads (`Purchase` when `order_id` is set and the order is prepaid — see 3.14), Analytics, Notifications, Risk, Merchants (payout credit on store orders), Subscriptions (launch activation on deposit), Audit.
- **Aggregate**: `wallet` / `user_id`. **pii_class**: `none`.

| Field | Type | Notes |
|---|---|---|
| `order_id` | `string \| null` | |
| `user_id` | `string` | |
| `kind` | `'wallet_debit'\|'cod_settled'\|'deposit_approved'\|'escrow_released'\|'psp_capture'` | |
| `currency` | `'USD'\|'POINT'\|'IQD'` | |
| `amount` | `number` | |
| `ledger_tx_ids` | `string[]` | `wallet_transactions.id` values written |
| `event_key` | `string` | the command's key (`wtx_ord_<id>_usd`, …) |

- **Idempotency**: `event_key`.

### 3.10 `PaymentFailed` v1
- **Producer**: Ledger (hold or debit refused) or Checkout (saga step failed).
- **Consumers**: Analytics, Risk, Notifications (customer-facing message only for `PROVIDER`/`TIMEOUT`).
- **Aggregate**: `wallet` / `user_id`. **pii_class**: `none`.

| Field | Type | Notes |
|---|---|---|
| `order_id` | `string \| null` | |
| `user_id` | `string` | |
| `kind` | `'wallet_hold'\|'wallet_debit'\|'psp_auth'` | |
| `currency`, `amount` | `'USD'\|'POINT'\|'IQD'`, `number` | |
| `reason` | `'INSUFFICIENT_FUNDS'\|'HOLD_CONFLICT'\|'STATE_CONFLICT'\|'PROVIDER'\|'TIMEOUT'` | |
| `event_key` | `string` | |

- **Idempotency**: `event_key` + `reason`.

### 3.11 `RefundCompleted` v1
- **Producer**: Ledger (`refund` command — today `orders.ts:1773-1791`, `admin.ts:1485-1503`, `returns.ts:342,733`, `memberships.ts:1220`, `escrowOps.ts:339`).
- **Consumers**: Orders/Refunds (mark case paid), Support (auto-note), Notifications, Analytics, Risk, Merchants (payout reversal on store orders), Audit.
- **Aggregate**: `wallet` / `user_id`. **pii_class**: `none`.

| Field | Type | Notes |
|---|---|---|
| `ref_type` | `'order'\|'return'\|'price_protection'\|'escrow'\|'membership'` | |
| `ref_id` | `string` | order / case / claim / escrow / membership id |
| `user_id` | `string` | |
| `usd_cents` | `number` | 0 when none |
| `points` | `number` | 0 when none |
| `ledger_tx_ids` | `string[]` | |
| `event_key` | `string` | `wtx_refund_<id>_usd`, `wtx_ret_<caseId>`, `wtx_pp_<claimId>`, `wtx_refund_<membershipId>` |

- **Idempotency**: `event_key` (UNIQUE on `wallet_transactions.event_key` after `0055`).

### 3.12 `OrderStatusChanged` v1
- **Producer**: Orders (every `orders.status` transition — customer cancel, admin cancel/status, merchant status via `ORDERS.applyStatus`, stage machine via `ORDERS.applyStage`, courier via Fulfilment).
- **Consumers**: Notifications, Analytics, Merchants, Chat, Realtime hub (`ORDER_WATCH`), Audit.
- **Aggregate**: `order` / `order_id`. **pii_class**: `none`.

| Field | Type | Notes |
|---|---|---|
| `order_id` | `string` | |
| `from`, `to` | `string` | legacy status values, unchanged |
| `stage` | `string \| null` | fulfilment stage when the cause is the stage machine |
| `cause` | `'stage'\|'admin'\|'merchant'\|'customer'\|'courier'\|'system'` | |
| `actor_id` | `string \| null` | |
| `at` | `string` | |

- **Idempotency**: `(order_id, aggregate_seq)`; consumers ignore stale sequences.

### 3.13 `OrderDelivered` v1
- **Producer**: Orders (canonical, emitted when Fulfilment's `StageChanged{to:'delivered'}` or an admin/merchant `delivered` transition is applied — today `deliveredEffects` at `admin.ts:788-831` and `merchant.ts:1302-1338`).
- **Consumers**: Devices (create units — `lib/deviceOps.ts` `createUnitsOnDelivery`), Loyalty (settle accrual), Subscriptions (printer gift), Referrals (reward), Reviews (eligibility), Payments (COD settlement), Inventory (commit), Merchants (`sale_credit → available`, `completed_orders`), Analytics, Ads (as `PurchaseCompleted` for COD — see 3.14), Notifications.
- **Aggregate**: `order` / `order_id`. **pii_class**: `pseudonymous`.

| Field | Type | Notes |
|---|---|---|
| `order_id` | `string` | |
| `user_id` | `string` | |
| `seller_type` | `'platform'\|'merchant'` | |
| `merchant_id` | `string \| null` | |
| `delivered_at` | `string` | |
| `items` | as `OrderCreated.items` | carried so Devices never reads `orders`/`order_items` |
| `payment_method` | `'wallet'\|'cash'` | |
| `cod_amount_iqd` | `number \| null` | |
| `by` | `'admin'\|'merchant'\|'courier'\|'customer_confirm'` | |

- **Idempotency**: `order_id` (one delivery per order); Devices' units are UNIQUE on `(order_item_id, unit_index)`.

### 3.14 `PurchaseCompleted` v1 (conversion fact for Ads/Analytics; PII-free)
- **Producer**: Orders — on `OrderCreated` for prepaid orders (wallet-settled), on `OrderDelivered` for COD (owner decision D20). Never emitted from Checkout code; Ads is purely a bus consumer.
- **Consumers**: Ads (`Purchase`), Analytics.
- **Aggregate**: `order` / `order_id`. **pii_class**: `pseudonymous`.

| Field | Type | pii | Notes |
|---|---|---|---|
| `order_id` | `string` | | doubles as the provider `event_id` for dedup |
| `value_iqd` | `number` | | |
| `currency` | `'IQD'` | | |
| `content_ids` | `string[]` | | product ids |
| `num_items` | `number` | | |
| `email_hash` | `string \| null` | pii | SHA-256 of normalised email, produced by Orders via `IDENTITY.lookupContacts` in memory, only when consent is `ads` |
| `phone_hash` | `string \| null` | pii | SHA-256 of E.164 phone, same rule |
| `consent` | `'none'\|'analytics'\|'ads'` | | |

- **Idempotency**: `order_id`; Ads records `ads_deliveries(order_id, provider)` UNIQUE.

### 3.15 `ReferralUsed` v1
- **Producer**: Referrals (attribution created — today `auth.ts:206-221`; reward granted — `lib/membershipOps.ts`).
- **Consumers**: Subscriptions/Loyalty (rewards where configured), Notifications, Analytics, Risk.
- **Aggregate**: `referral` / `attribution_id`. **pii_class**: `pseudonymous`.

| Field | Type | Notes |
|---|---|---|
| `referrer_id`, `referee_id` | `string` | |
| `code` | `string` | |
| `attribution_id` | `string` | |
| `context` | `'signup'\|'order'\|'membership'` | |
| `order_id` | `string \| null` | |

- **Idempotency**: `attribution_id`.

### 3.16 `SubscriptionChanged` v1 (alias `MembershipChanged`)
- **Producer**: Subscriptions (purchase, expiry via cron — replaces the write-on-read in `lib/entitlements.ts:70-75,125-131`, cancellation, gift, admin override, launch activation).
- **Consumers**: Identity (updates its `users.membership_tier`/`subscription_plan`/`subscription_expiry` columns — the only writer of `users`), Catalog (tier cache), Referrals, Ads (`Subscribe` when `to_tier` is active), Analytics, Notifications, Audit.
- **Aggregate**: `membership` / `user_id`. **pii_class**: `none`.

| Field | Type | Notes |
|---|---|---|
| `user_id` | `string` | |
| `from_tier`, `to_tier` | `string \| null` | |
| `plan_id` | `string \| null` | |
| `membership_id` | `string \| null` | |
| `active` | `boolean` | |
| `expires_at` | `string \| null` | |
| `reason` | `'purchased'\|'expired'\|'cancelled'\|'gift'\|'admin'\|'launch'` | |

- **Idempotency**: `(user_id, aggregate_seq)`; Identity applies last seq wins.

---

## 4. Service-specific events (v1)

| Event | Producer | Payload (v1, allowlist) | Consumers | pii_class | Idempotency key |
|---|---|---|---|---|---|
| `UserUpdated` | Identity | `{ user_id, username, name, avatar_key, locale, marketing_consent }` | Farm, Marketplace, Chat, Ads (consent snapshot), Analytics | pseudonymous | `(user_id, aggregate_seq)` |
| `SessionRevoked` | Identity | `{ user_id, sid_hash, reason }` | Gateway (cache eviction), Studio (later; replaces the 60-s liveness poll) | none | `sid_hash` |
| `RoleChanged` | Identity | `{ user_id, role, admin_scope, is_investor, actor_id }` | Audit, Gateway cache | none | `(user_id, aggregate_seq)` |
| `AddressChanged` | Identity | `{ user_id, address_id, is_default }` | KYC (approved-address check), Subscriptions | none | `(address_id, seq)` |
| `KycDecided` | KYC | `{ user_id, case_id, decision, decided_by }` | Notifications, Subscriptions, Risk, Audit | none | `case_id` |
| `ApprovedAddressChanged` | KYC | `{ user_id, address_id }` | Subscriptions | none | `(user_id, seq)` |
| `ProductArchived` | Products | `{ product_id, slug }` | Catalog, Search, Cart, Files (orphan sweep) | none | `product_id` |
| `PriceChanged` | Pricing | `{ product_id, scope, field, old, new, mode, effective_at }` | Catalog cache, Cart (re-quote flag), Refunds (price-protection eligibility), Search, Analytics | none | `(product_id, scope, effective_at)` — never cost fields |
| `HashtagRenamed` | Catalog | `{ from, to }` | Products (rewrites its own `products.hashtags` column) | none | `(from, to)` |
| `ImportApplied` | Products | `{ import_id, rows, created, updated, failed }` | Analytics, Audit | none | `import_id` |
| `SettingChanged` | Config | `{ key, version, public: boolean }` | every service memo, Gateway cache version, Ads flags, Audit | none | `(key, version)` |
| `FlagChanged` | Config | `{ name, version }` | Gateway, Ads | none | `(name, version)` |
| `CartCleared` | Cart | `{ user_hash, reason: 'checkout'\|'manual' }` | Analytics | pseudonymous | `event_id` |
| `OrderCancelled` | Orders | `{ order_id, by: 'customer'\|'admin'\|'merchant'\|'system', reason, refund: { usd_cents, points } }` | Ledger (reconciliation only — the refund is a synchronous command), Inventory, Coupons, Referrals, Merchants, Fulfilment, Notifications, Analytics, Risk | none | `order_id` |
| `StageChanged` | Fulfilment | `{ order_id, from_stage, to_stage, next_stage_at, actor_kind }` | Orders (status mirror + `OrderDelivered` relay), Notifications, Realtime | none | `(order_id, seq)` |
| `ShipmentCreated` / `CourierStatusChanged` | Fulfilment (Shipping) | `{ order_id, courier, courier_order_id, status_raw, status_mapped }` | Fulfilment stage machine, Analytics | none | `(courier_order_id, status_raw)` |
| `LabelPrinted` | Fulfilment | `{ order_id, actor_id }` | Audit | none | `event_id` |
| `ReturnApproved` | Refunds | `{ case_id, order_id, order_item_id, qty, reason_class }` | Inventory (restore), Referrals, Loyalty (reverse), Notifications | none | `case_id` |
| `CouponRedeemed` / `CouponReleased` | Coupons | `{ coupon_id, code, order_id, user_id }` | Analytics, Audit | none | `(coupon_id, order_id)` |
| `DepositRequested` | Payments | `{ request_id, user_id, usd_cents, method, receipt_key_present }` | Notifications (admin group), Risk, Files (receipt visibility) | none | `request_id` |
| `DepositDecided` | Payments | `{ request_id, user_id, decision, decided_by, usd_cents }` | Notifications (customer + Telegram edit), Risk, Audit | none | `request_id` |
| `WithdrawalStateChanged` | Payments | `{ withdrawal_id, user_id, from, to, usd_cents }` | Notifications, Risk, Audit | none | `(withdrawal_id, to)` |
| `WalletHoldPlaced` / `WalletHoldReleased` | Ledger | `{ hold_id, user_id, kind, currency, amount, event_key }` | Analytics, Risk | none | `event_key` |
| `LedgerEntryPosted` | Ledger | `{ tx_id, user_id, currency, type, amount, event_key, source_service }` | Audit (hash chain), Analytics | none | `tx_id` |
| `BalanceAnomaly` | Ledger (`reconcile`) | `{ user_id, currency, sum, cached, held_active, kind }` | Risk, Audit, Notifications (admin) | none | `(user_id, currency, run_id)` |
| `PointsAccrued` / `PointsReleased` / `PointsReversed` | Loyalty | `{ user_id, order_id, points, accrual_id, event_key }` | Notifications, Analytics | none | `event_key` (`wtx_acc_<accrual>`) |
| `MissionClaimed` | Loyalty | `{ user_id, mission, day, points }` | Analytics | none | `(user_id, mission, day)` |
| `MembershipPurchased` / `MembershipCancelled` | Subscriptions | `{ user_id, membership_id, plan_id, price_paid_iqd, wallet_tx_id }` | Referrals, Refunds (cancel → refund command), Analytics, Audit | none | `membership_id` |
| `ReferralRewardGranted` | Referrals | `{ referrer_id, referee_id, reward_id, kind, order_id }` | Notifications, Analytics | none | `reward_id` |
| `SupportGiftChanged` | Referrals | `{ user_id, entitlement_id, state }` | Subscriptions, Notifications | none | `(entitlement_id, state)` |
| `RequestPublished` / `RequestMatched` | Marketplace | `{ request_id, owner_hash, matched_merchant_ids[] }` | Notifications (inbox rows, dedup `(user_id, event_key)` `0045_print_requests.sql:68`), Search, Analytics | pseudonymous | `request_id` (+ merchant id for matches) |
| `OfferMade` / `OfferAccepted` | Marketplace | `{ request_id, offer_id, merchant_id, community_order_id? }` | Notifications, Analytics, Risk | none | `offer_id` |
| `EscrowHeld` / `EscrowReleased` / `EscrowRefunded` | Marketplace | `{ escrow_id, community_order_id, buyer_id, merchant_id, usd_cents, event_key }` | Notifications, Analytics, Risk, Audit | none | `event_key` (`accept:<orderId>`, `release:<orderId>`, `refund:<orderId>`) |
| `CommunityOrderConfirmed` / `CommunityOrderCancelled` | Marketplace | `{ community_order_id, request_id, merchant_id, buyer_id }` | Reviews (reputation), Merchants (completed_orders), Notifications, Analytics | none | `community_order_id` |
| `MerchantPayoutRequested` / `MerchantPayoutPaid` | Marketplace | `{ merchant_id, payout_id, iqd, event_key }` | Notifications, Audit, Analytics | none | `payout:<id>` |
| `StoreOrderPlaced` | Merchants | `{ order_id, merchant_id, store_id, items[], totals }` | Notifications (merchant), Analytics | none | `order_id` |
| `MerchantStatusChanged` | Merchants | `{ merchant_id, from, to, actor_id }` | Search, Notifications, Audit | none | `(merchant_id, seq)` |
| `StoreProductChanged` | Merchants | `{ community_product_id, merchant_id, status, price_iqd }` | Search, Analytics | none | `(community_product_id, seq)` |
| `ReviewPosted` / `ReviewApproved` | Reviews (product + merchant reviews) | `{ review_id, kind: 'product'\|'merchant', target_id, author_hash, rating }` | Loyalty (credit `wtx_review_<id>`), Merchants (rating copy), Notifications, Risk, Analytics | pseudonymous | `review_id` |
| `GiftRedeemed` | Reviews | `{ user_id, gift_entitlement_id, pool_item_id }` | Notifications, Analytics | none | `gift_entitlement_id` |
| `UnitCreated` / `UnitReplaced` | Devices | `{ order_item_id, unit_index, serial_id, receipt_id }` | Notifications, Analytics, Audit | none | `(order_item_id, unit_index)` |
| `ClaimStatusChanged` | Devices | `{ claim_id, from, to, actor_id }` | Notifications, Support, Audit | none | `(claim_id, seq)` |
| `ReceiptIssued` | Devices | `{ receipt_id, order_id, user_id }` | Notifications | none | `receipt_id` |
| `InvoiceIssued` | Invoices | `{ invoice_id, order_id, user_id, total_iqd }` | Notifications (email), Analytics | none | `invoice_id` |
| `PolicyPublished` / `PolicyAccepted` | Policies | `{ document_id, version, hash }` / `{ user_id, document_id, version }` | Gateway cache, Checkout, Audit | none | `(document_id, version)` / `(user_id, document_id, version)` |
| `TicketOpened` / `TicketStateChanged` | Support | `{ ticket_id, user_id, from, to }` | Notifications, Analytics | none | `(ticket_id, seq)` |
| `RestrictionChanged` / `RiskFlagRaised` | Risk | `{ user_id, case_id, flags[], level, reasons[] }` | Subscriptions (pricing context), Ledger (deposit review), Support, Gateway (`RISK_FLAGS`), Audit | none | `(user_id, seq)` |
| `ChatMessageSent` | Chat | `{ chat_id, message_id, sender_hash, recipient_ids[] }` — no content | Notifications, Realtime | pseudonymous | `message_id` |
| `NotificationSent` / `NotificationFailed` | Notifications | `{ event_key, channel, provider_status }` | Analytics, Audit | none | `event_key` |
| `TelegramCallbackReceived` | Notifications (webhook ingress) | `{ update_id, kind: 'identity'\|'wallet_approval', token_hash }` | Identity (link/OTP), Ledger (`decideDeposit`) — as commands, the event is for audit | none | `update_id` (`telegram_updates`) |
| `FileUploaded` / `FileDeleted` | Files | `{ key, owner_service, owner_id, purpose, bytes }` | Audit, Analytics | none | `key` |
| `ImportJobQueued` / `IngestCompleted` | Catalog / Files | `{ job_id, urls: number, stored: number }` | Audit | none | `job_id` |
| `FarmEvent` | Farm | `{ user_hash, kind, coins_delta }` | Analytics | pseudonymous | `event_id` (the farm's own ledger ids remain the game's replay memory) |
| `SearchQueried` | Search | `{ query_hash, scope, lang, results }` | Analytics | none | `event_id` |
| `RateLimitHit` / `TurnstileFailed` | Gateway (sampled) | `{ class, key_hash, route_class, host_kind }` | Risk, Analytics | none | `event_id` |
| `AdConversionSent` / `AdConversionFailed` | Ads | `{ provider, event_type, source_event_id, status }` | Audit, Analytics | none | `(provider, source_event_id)` |
| `AuditRecorded` | every service via the `audit()` facade | `{ actor_id, action, target, detail (≤4000 chars, no secrets/tokens), source_service }` | Audit only | personal | `event_id` |
| `EventRejected` | any consumer | `{ event_id, consumer, reason }` | Audit | none | `(event_id, consumer)` |

---

## 5. PII rules

1. `pii_class` on the envelope gates delivery: the bus never delivers `personal` to a consumer whose `defineConsumer({piiMax})` is `pseudonymous` (Ads, Analytics, Search, Farm).
2. Per-field `pii` annotations in the schema are dropped mechanically by Analytics at ingest and used by Ads only under consent (`ads_consent_snapshots`).
3. Hashing is done by the producer in memory (SHA-256 of normalised lowercase email / E.164 phone; daily-salted user hash for uniqueness counts); raw contacts never enter an event.
4. Never in any payload: password hashes, tokens, secrets, full phone numbers, full addresses (address by reference), cost/margin/commission, admin notes, free-text customer messages (chat content, ticket bodies, complaint text).
5. `AuditRecorded` is the one `personal` event; only Audit consumes it; Audit reads are scope-gated (`admin:full`).
6. Retention: envelope bodies in outboxes are kept ≥180 days (pruning is an owner decision); Analytics raw events roll 30 days, rollups indefinitely; Audit is append-only.

---

## 6. Subscriptions seed (`packages/contracts/src/subscriptions.ts`, Phases 1–3)

```ts
export const SUBSCRIPTIONS: Record<string, string[]> = {
  '*':                        ['analytics'],                       // wildcard; pii gate applies
  'UserCreated.v1':           ['notifications', 'ads', 'risk', 'audit'],
  'ProductViewed.v1':         ['ads', 'search'],
  'ProductAdded.v1':          ['search'],
  'InventoryChanged.v1':      ['search'],
  'AddToCart.v1':             ['ads'],
  'CheckoutStarted.v1':       ['ads', 'risk'],
  'OrderCreated.v1':          ['notifications', 'ads', 'risk', 'audit'],
  'PaymentAuthorized.v1':     ['risk'],
  'PaymentCompleted.v1':      ['ads', 'notifications', 'risk', 'audit'],
  'PaymentFailed.v1':         ['risk', 'notifications'],
  'RefundCompleted.v1':       ['notifications', 'risk', 'audit'],
  'OrderStatusChanged.v1':    ['notifications'],
  'OrderDelivered.v1':        ['notifications'],
  'PurchaseCompleted.v1':     ['ads'],
  'ReferralUsed.v1':          ['notifications', 'risk'],
  'SubscriptionChanged.v1':   ['ads', 'notifications'],
  'RequestPublished.v1':      ['notifications'],
  'AuditRecorded.v1':         ['audit'],
  'RateLimitHit.v1':          ['risk'],
  'TurnstileFailed.v1':       ['risk'],
};
```

Each later phase appends consumers (Phase 4: `invoices` on `OrderCreated`; Phase 6: `referrals`, `subscriptions`, `reviews`; Phase 7: `fulfilment`, `devices`, `commerce` consumers; Phase 9: `identity` on `SubscriptionChanged`). `tests/eventSchemas.test.ts` asserts every consumer named here is a `services` binding of the producer (rpc mode) or a declared queue consumer (queue mode).
