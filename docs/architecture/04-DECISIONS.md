# LEVONIS — Architecture Decision Records (canonical)

Date: 2026-09-07. Base tree: `69ee814`. One record per structural decision behind `01-TARGET.md`, `02-MIGRATION-PLAN.md` and `03-EVENTS.md`. Each record: context, decision, consequences, the alternative rejected and why. Status of every record: **accepted as design**; nothing is applied until the plan's slices run. Names marked **(new)** do not exist yet. Revision 2: ADR-001–014 amended where three independent critiques (zero-downtime, Cloudflare limits, security) found a fault; ADR-015–017 added. Amendments are marked **Amended (rev. 2)** inside the record.

---

## ADR-001 — The gateway is the strangler; dark first; one live route change

**Context.** One Worker (`levonis-staging`) serves `levonis-iq.com` and `*.levonis-iq.com` with 47 route files (`worker/index.ts`). The owner requires no broken function at any step, no live infrastructure change without approval, and a small team. Routing lives in the Cloudflare dashboard, not the repo (`docs/WORKERS.md`; `tests/workflowNaming.test.ts` rejects `routes`/`custom_domains`).

**Decision.** A single public gateway Worker (`levonis-gateway`, new) routes prefix + host class to the owning Worker over Service Bindings and forwards everything else under `/api/*` and `/files/*` to the core (`CORE` binding). It is built and proven on a fully dark stack (`levonis-core-dark` + `levonis-gateway-dark` + dark leaves, own D1/R2) **on a dark zone** (an owner-provisioned throwaway domain with a wildcard, D21 — workers.dev has no wildcard, so merchant hosts, the `Domain=.<root>` cookie and the Cache API cannot be exercised there) with a recorded parity corpus (`scripts/gateway-parity.mjs`, new) before the owner changes the live zone once (Phase 3.2). Every later extraction is a prefix flip with a kill switch.

**Amended (rev. 2) — the cut-over is a route add, not a route move.** `levonis-iq.com` and `www` are Worker **Custom Domains** of `levonis-staging` (`docs/WORKERS.md`, SUBDOMAIN_ARCHITECTURE.md §7.2); a Custom Domain cannot be re-pointed — it is detached (DNS record deleted) and re-attached (new record, certificate issuance), a visible apex outage with no minutes-level rollback. The owner therefore **adds** six zone routes — `<host>/api/*` and `<host>/files/*` for the apex, `www` and `*.levonis-iq.com` — targeting the gateway, and leaves the Custom Domains and the wildcard `/*` route on the core. The SPA and every asset keep being served by the core's asset layer with **no Worker invocation** (as `run_worker_first` gives today), the gateway needs no `assets` block until Phase 9, and rollback is deleting six routes. Route-over-Custom-Domain precedence is proven on the dark zone in slice 1.0; if disproven, the fallback (plan 3.0-alt) first converts the apex/www to DNS + routes still targeting the core.

**Consequences.** One extra hop on API requests only (bindings are near in-process; budget p95 < 150 ms); assets unaffected; no `loadSessionUser` per asset; workflow 7's byte-identity proof keeps its meaning. The core keeps every check (defence in depth) while the gateway takes authority for headers, limits, cache and capabilities, and the core verifies the gateway hop envelope (`GATEWAY_ONLY`) once its workers.dev host is closed at G3. The Workers Builds Git integration is disconnected at **G0, before any `0055+` code merges** (not at G3): it deploys every push with no migrations, so it would otherwise put schema-dependent code on the live database ahead of its migration (SUBDOMAIN_ARCHITECTURE.md §7.5.3; DECISIONS row 36).

**Rejected.** *Routing per service from the dashboard* (a zone route per prefix): N dashboard changes, each an owner action, no kill switch, no single place for auth/limits. *Big-bang cut to a new stack*: violates constraints 1, 2 and 4. *Gateway on `/*` from Phase 3* (the rev. 1 text): every HTML, chunk and image request would run gateway → `CORE.fetch` → Hono → `notFound` → `ASSETS.fetch`, with `loadSessionUser` per asset for signed-in visitors and a path never exercised in production. *Smoke-testing the production gateway on workers.dev*: publishes a second unprotected path to live data; the dark zone hosts the smoke instead.

---

## ADR-002 — Gateway auth model: Identity-signed principal, per-hop envelopes, opaque cookie unchanged

**Context.** Every route trusts `c.get('user')` from `sessions JOIN users` (`worker/lib/session.ts:63-69`); `SessionUser` mixes identity with tier/admin fields (`lib/types.ts`). The cookie is `levonis_session`, hashed-only storage, `Domain=.<root>` (`docs/SUBDOMAIN_ARCHITECTURE.md` §6). Zero trust between services is required.

**Decision.** The gateway computes `sha256(token)` and calls `IDENTITY.resolveSession(hash)`; Identity returns a **principal signed with its own Ed25519 key** (`IDENTITY_SIGNING_KEY`): `{sub, sid_hash, role, scope, investor, tier, locale, host_kind, iat, exp: iat+120}` — no email, phone, hashes. The gateway forwards `x-levonis-principal` and strips inbound `x-levonis-*`. Services verify with Identity's public keys and re-apply their own authorization. Every service→service RPC carries a **hop envelope** signed by the caller's key verified against a per-method caller allowlist with nonce replay protection. The cookie is forwarded only to `CORE` (strangler) and Identity. Until Identity is its own Worker, `IDENTITY` = the core's `IdentityEntrypoint` (same SQL), and `PRINCIPAL_MODE=off|shadow|on` lets the gateway compare before enforcing.

**Amended (rev. 2).** (a) `scope` is `'owner'|'full'|'assistant'|null` — Identity folds the `INITIAL_ADMIN_EMAIL` owner rule (`adminScope.ts:40-46`) into the signed claim, so no service needs the email for `canViewFinancials` or the owner-cannot-be-demoted guard. (b) The gateway cache is keyed by `(sid_hash, host_kind)`, holds ≤30 s, and applies to **read classes only**; `money` and `admin-write` classes resolve per request, so logout and role changes are immediate where they matter; `SessionRevoked`/`RoleChanged` reach the gateway from Phase 3. (c) Services compare `principal.host_kind` with the gateway-set `x-levonis-host` (covered by the hop envelope) and reject mismatches. (d) The hop envelope is `{iss, kid, iat, exp, nonce, method, args_hash, principal_hash}` from day one — a method-only envelope would be a 30-s bearer for any arguments. (e) **Shadow runs in Phase 3.3**, sampled by `PRINCIPAL_SHADOW_RATE` (5 % → 100 % for the final week), and `PRINCIPAL_MODE=on` per route class is the entry criterion of the Phase-4 slice that moves it: a leaf that never sees the cookie must trust nothing but the signed principal from its first request. (f) The core and every service verify the gateway hop on inbound HTTP (`GATEWAY_ONLY=off|log|on`); `resolveSession` is skipped when the target is `CORE` and the class is `off` (no double session read). (g) `principalToSessionUser()` documents the fields it cannot fill (`email`, `phone`, `profile_json`, …); each extraction slice greps for them.

**Consequences.** Logout propagation is bounded by the 30-s cache on read routes only; `IDENTITY.revoke` evicts eagerly. Services must not re-parse `Host`; they read `host_kind` from the principal and check it against `x-levonis-host`. Key rotation is `kid`-based, ordinary deploys. The `SessionUser` shape is reconstructed by `principalToSessionUser()` so moved route code keeps working, except for contact fields, which move to `IDENTITY.contactFor` (Notifications only).

**Rejected.** *Gateway-signed principal*: a compromised gateway could mint any principal; with Identity signing it can only replay within `exp`. *JWT replacing the cookie*: eventually-consistent logout and a larger browser attack surface; the opaque hashed session (SECURITY.md §2) stays. *Trusting binding identity alone*: a binding proves "some Worker on the account", not which one or which method.

---

## ADR-003 — Interim shared D1: one writer per table, ownership manifests, a tolerance list that only shrinks

**Context.** 137 tables live in one D1 (`levonis-db-staging`); `wallet_transactions` has 12 writers across 6 domains, `orders` 8, `users` 3 non-identity writers (assessment §2.1). No data migration is allowed without a separate approval (constraint 4). D1 has no schemas or grants, and a service that binds the database can name any table.

**Decision.** Ownership is enforced by code and tests, not by the database, until a service moves its tables: (1) `services/<name>/OWNERSHIP.json` lists `owns`/`reads`; (2) `ownedDb()` in the platform kit refuses statements naming other tables (`throw` in dark, `log` for one production release, then `throw`); (3) `tests/serviceBoundaries.test.ts` scans SQL literals and imports; (4) `worker/OWNERSHIP.tolerance.json` enumerates the core's remaining foreign writes with their removal phase and can never grow (snapshot test); (5) column groups on `orders`, `users`, `products` have one semantic owner but only the table owner executes SQL — others issue commands (`ORDERS.applyStage`, `IDENTITY.setRole`, `PRODUCTS.setOpsPolicy`) or events (`SubscriptionChanged` → Identity updates `membership_tier`); (6) `migrations/` stays the single stream applied before code (workflow 7), files `0055+` name their owner, touch only that owner's tables, and pass the additive classifier extended to accept `ALTER TABLE … ADD COLUMN`.

**Amended (rev. 2).** `rate_limits` belongs to **Identity**, not the gateway: the gateway has no D1 binding, and the only cross-isolate limiter that exists today is the D1 fixed window in `lib/ratelimit.ts` — assigning the table to a Worker that cannot reach it would have left extracted routes with a per-isolate bucket. Every Worker reaches the counter through `IDENTITY.rateLimitHit` (the core's `IdentityEntrypoint` until Phase 9). Likewise the Telegram transport tables `tg_admin_notifications`/`tg_admin_actions` belong to Notifications (message and claim-token state), while `admin_tg_identities` stays with the Ledger (who may approve). "Files move verbatim" therefore has three named exceptions in every move slice: `worker/lib/{ratelimit,audit,session}` imports become platform-kit facades before the first dark deploy.

**Consequences.** A bug can still reach a foreign table at runtime in the first release of each service (logged, counted). On PostgreSQL each service gets a schema and a role, and the manifest becomes redundant with the grant. New leaf services without legacy tables get their own D1 from day one.

**Rejected.** *Move data first (per-service D1 before code)*: violates constraint 4 and multiplies migration risk. *SQLite table-name prefixes*: renaming is a data-touching migration. *Trust the review process*: the assessment shows 16 cross-domain batches that got through review.

---

## ADR-004 — Merged deployables host separate packages with separate contracts and self-bound named entrypoints

**Context.** Several owner-named services write the same rows in one D1 batch today: checkout writes seven domains (B1), POINT rows live in `wallet_transactions` (B7/B8/B10), price and stock are columns of the same catalogue rows, store checkout spans orders + four merchant tables (B4). The owner forbids fake microservices *and* forbids breaking anything.

**Decision.** Four deployables host more than one owner-named service until their split trigger: Catalog (Catalog/Products/Pricing/Inventory), Commerce (Cart/Checkout/Orders/Coupons/Refunds), Ledger (Wallet/Ledger/Payments/Loyalty), Marketplace (Marketplace/Merchants). Inside each, every service is a package `services/<deployable>/src/<service>/` exporting its own `WorkerEntrypoint` (`cloudflare:workers`) with its own contract in `packages/contracts/src/rpc/`, its own `OWNERSHIP.json` section and its own HTTP routers. Packages call each other for **commands** through the self-binding `{ binding: 'LEDGER', service: 'levonis-ledger', entrypoint: 'LedgerEntrypoint' }`, never by importing another package's logic (lint). Splitting = change the caller's binding to the new Worker name, move the tables; no code changes. Split triggers are named per row in `01-TARGET.md` §1.2.

**Amended (rev. 2).** The rev. 1 rule ("only through the self-binding") contradicted the reason the deployables are merged: a `D1PreparedStatement` cannot be serialised over RPC, so the intra-deployable batches (B2/B3 points+wallet, B8, B10, B1's cart/coupon/settlement statements) could not have been composed. Each package therefore also exports **statement descriptors** — `services/<deployable>/src/<service>/statements.ts` returning serialisable `{sql, params}` objects whose shapes are pinned in `packages/contracts` — and this is the **one** import path the boundaries lint allows between sibling packages of the same deployable. RPC via named entrypoints is for cross-deployable calls and is what the post-split path uses; a self-binding hop on the hot path is also an extra billed invocation, so descriptors are the default inside a deployable. **Bootstrap**: the Workers upload API rejects a `services` binding whose target does not exist, so the deploy workflow strips absent targets, deploys, and redeploys with the full set (self-bindings and the Ledger↔Notifications / Identity↔Notifications / Commerce↔Fulfilment cycles).

**Consequences.** Atomicity is preserved where a batch is the only correctness mechanism; independence of code, contract and permissions exists from day one; a compile-time coupling on statement shapes exists inside a deployable (accepted; the split replaces the descriptor call by an RPC to the same package, and the descriptor shape in `contracts` makes that mechanical); availability is shared within a deployable until the split. Loyalty never splits from Ledger while POINT rows are journal rows (a separate points journal is a data decision).

**Rejected.** *One Worker per owner-named service from the start* (the domain-first design): B1 becomes a 6–8 hop saga before the saga is proven, Inventory leaves the checkout batch while checkout is still in the monolith, and ~43 Workers exceed what a small team can operate. *A modular monolith with folders only*: no separate contract, permissions or deployment path — the fake microservice the owner forbade.

---

## ADR-005 — Transactional outbox per producer; RPC fan-out dispatcher today, Queues by config

**Context.** Side effects run inline or best-effort (`audit()` swallows failures `lib/audit.ts:14-16`; `waitUntil` pumps; the invoice email is awaited in checkout `routes/orders.ts:1556`). Queues may not be provisionable yet (Paid plan + token scope unknown). The `outbox` table + `notifyStatement` (`lib/notifications.ts:66-72`) already show the right pattern.

**Decision.** Every producer has `<svc>_outbox_events` (+ `_deliveries`, `pump_lock`) in its own store; the outbox INSERT rides in the business batch; the platform kit's `Uow` refuses to commit a publishing command without it. `RpcFanoutBus` delivers to subscribers from the static map `packages/contracts/src/subscriptions.ts` over their bindings with exponential backoff (8 attempts → `dead`, replayable). `QueueBus` is selected by `EVENT_BUS_MODE=queue` + queue bindings; consumers implement one `deliver()` called from both RPC and `queue()`. Consumers dedup with `<svc>_processed_events` in the same batch as their side effect; money consumers additionally key on domain keys.

**Amended (rev. 2).** (a) **Two delivery classes**: `transactional` events use the outbox; `best_effort` telemetry (`ProductViewed`, `AddToCart`, `CartCleared`, `FarmEvent`, `RateLimitHit`, `SearchQueried`, `TurnstileFailed`) is fire-and-forget RPC in `waitUntil` and never touches the producer's D1 — page-view-rate rows in the customer database bought nothing. (b) **Pump discipline**: the post-request pump delivers only the ids the request just committed (no global lock or `SELECT pending` per request on the single-writer database); the per-minute cron is the sole lock holder and sweeper; delivery state is one `UPDATE … IN (≤50)` per `deliver()` call, never per event; a run is budgeted at ≤600 D1 statements / ≤60 RPC calls (D1 caps 1,000 queries per invocation; `waitUntil` ends ~30 s after the response); `deliver()` batches are capped at 50 events **and** 500 KB. (c) **Queue topology fixed now**: a Cloudflare Queue has exactly one consumer Worker, so it is one queue + DLQ per consumer, every producer declares a producer binding per subscriber, `sendBatch` in ≤100-message/256 KB chunks, envelopes >100 KB sent as pointers (128 KB message cap) — otherwise the "config switch" would have been a topology rewrite. (d) **Authenticated envelopes**: `sig` by the producer's key and a per-type `producers` allowlist checked by every consumer in both modes — privilege-granting events (`SubscriptionChanged`, `RoleChanged`, `KycDecided`, `ReviewPosted`) must not be forgeable by any Worker holding a producer binding. (e) On the live core `publishStatement()` is a no-op while `EVENT_BUS_ENABLED=off` or the outbox table is absent, so bus code can merge before migration `0056` is applied without failing a checkout batch.

**Consequences.** At-least-once, per-aggregate ordering only; a consumer outage backs up in the producer's outbox (alert at 5 min; 15 min for core-produced events until G2 adds the core's per-minute trigger). The legacy core is a producer too (`core_outbox_events`, migration `0056`) — rows accumulate before consumers are bound, and nothing is lost. Audit becomes reliable because the outbox row fails the batch if it cannot be written. Queue mode costs (write + read + delete) × subscribers per event.

**Rejected.** *A central bus Worker with its own store* (domain-first): an extra hop and a single point of failure on every event, plus one more D1; the static map gives the same topology control. *Direct synchronous RPC for side effects*: couples the request path to Ads/Analytics/Notifications, the exact thing the owner forbids. *Queues from day one*: not provisionable today. *One shared queue with type filtering in consumers* (rev. 1): undeployable — one consumer per queue.

---

## ADR-006 — The ledger journal stays `wallet_transactions`; every command carries an event key; hold commit debits atomically; PostgreSQL row locks later

**Context.** Balances are `SUM` over approved rows (`lib/walletOps.ts:44-61`); in-statement guards (`usdSpendStatement`, `walletOps.ts:97-113`; hold inserts `:228-258`) make single batches safe. Committed purchase holds never post a debit (`storeOrders.ts:344`, `escrowOps.ts:240,336` — HIGH); `lib/wallet.ts` `credit()` has no key; two deposit-approval paths exist (`admin.ts:449-511`). Constraint 5 keeps the existing wallet/points semantics.

**Decision.** `wallet_transactions` remains the journal; migration `0055_ledger_keys.sql` (new) adds `event_key` (partial UNIQUE), `correlation_id`, `source_service` and the composite index; historical rows stay `NULL`, deterministic ids (`wtx_ord_<id>_usd`, `wtx_refund_<id>_pts`, …) become the keys on first touch. The `LedgerApi` (`credit, debit, hold, commitHoldAndDebit, releaseHold, refund, reservePoints/settlePoints/releasePoints/reversePoints, decideDeposit`) is the only write path; `eventKey` is mandatory; `ledger_idempotency` stores every outcome; `commitHoldAndDebit` writes the withdrawal row and flips the hold in one batch; `decideDeposit` is the only approval path; `ledger_balances` is a materialised cache with a revision fence, the `SUM` stays the truth on D1, `reconcile()` covers purchase holds and never repairs silently. On PostgreSQL via Hyperdrive (`LedgerStore` adapter: `D1LedgerStore`/`PgLedgerStore`), one transaction per command with `SELECT … FOR UPDATE` on the balance row; the materialised row becomes the truth and the `SUM` the audit. Every money method's batch carries an `AuditRecorded` outbox row.

**Amended (rev. 2).** (a) `ledger_idempotency` is `(event_key PK, user_id, command_type, payload_hash, result_json, created_at)`: a replay is a replay only when user and payload match; otherwise `EVENT_KEY_REUSED` plus an audit/risk event — `wallet_transactions.event_key` is globally unique while `wallet_holds.event_key` is per user, so a client-influenced key could let one user shadow another's command. (b) Event keys are **server-minted** (`<service>:<aggregate>:<server id>:<leg>` or the legacy deterministic ids); a client idempotency key maps to a server key only through the caller's own table (`orders.idempotency_key` → `orderId`); the lint refuses an `eventKey` built from request input. (c) Money methods apply an **argument policy per caller** (`{currencies, refTypes, maxAmount, dailyCap}` in `contracts/rpc/ledgerPolicy.ts`) on top of the per-method allowlist — Reviews may mint only the configured POINT award, never USD. (d) Deposit approval is verified by the Ledger itself: an `approval_nonce` minted per request and stored hashed in `wallet_deposit_meta`, checked together with `admin_tg_identities`; Notifications forwards `{update_id, telegram_user_id, nonce, chat_id, message_id}` and is never the actor of record.

**Consequences.** Behaviour of existing rows is unchanged; replays are safe across Workers; the assessment's HIGH #1, #3, #4 are closed in Phase 0 (`69ee814`) before any extraction. Merchant IQD accounts (`merchant_payout_ledger`) follow the same rules inside Marketplace (`payout:<id>` keys, conditional flips). Blast radius per Worker is real for money: a compromised leaf can at most replay its own allowed commands within its policy.

**Rejected.** *Stored balance as truth on D1 now*: no row locks; the revision fence is a retry loop, not a lock; the SUM + in-statement guard is what protects money today and is kept. *New journal table*: a data migration of every historical row (constraint 4/5). *Points as a separate ledger service*: B7/B8/B10 become two-step flows before PostgreSQL exists. *Per-method allowlists alone* (rev. 1): zero trust in name only for the one domain where it matters.

---

## ADR-007 — The checkout saga is built inside the core behind a flag before Commerce becomes a Worker

**Context.** B1 (`routes/orders.ts:1318-1493`) writes seven domains atomically with CHECK-abort tricks. Splitting any leg into another Worker before a saga exists produces half-applied orders or debits on a crash.

**Decision.** Phase 7.1 rewrites `placeOrder` as reserve (Inventory) → hold (Ledger USD) → reserve (Ledger points) → **local batch** (`orders`, `order_items`, `coupon_redemptions`, `order_payment_settlements`, `cart_items` delete, `checkout_sagas` state, outbox `OrderCreated`) → commit (`commitHoldAndDebit`, `settlePoints`, `INVENTORY.confirm`), with compensations using the same keys and a one-minute sweep that finishes or compensates stuck sagas. The remote legs call the core's own `LedgerEntrypoint`/`InventoryEntrypoint` first (same deployable), so distributed failure modes are exercised without distributed risk. `CHECKOUT_SAGA=on|off` selects saga vs legacy batch per request; both write identical rows and ids; rollout 10% → 100% after crash-injection tests (`tests/checkoutSaga.test.ts`, new) and a week on dark. Only then does `services/commerce` deploy (7.3), and the legacy path stays one release for rollback. Cancel/refund (B2/B3), store checkout (B4), escrow (B6/B14) and membership purchase (B9) follow the same shape.

**Amended (rev. 2).** (a) **Fenced on both sides**: the local batch begins with `UPDATE checkout_sagas SET state='local_committed' WHERE id=? AND state='started'` (0 rows → CHECK-abort, nothing persisted); the sweep first runs `… SET state='compensating' WHERE id=? AND state='started'` and compensates only when it changed a row; every release carries the saga id and Ledger refuses a release whose saga is not `compensating`. Without this the sweep could release the hold at T+120 s while the request committed the order at T+120.1 s — a persisted, unpaid order whose `OrderCreated` had already started fulfilment, mailed an invoice and told Ads about a sale. (b) `OrderCreated` carries `payment_state: 'authorized'|'cod'`; every payment-presuming effect (Fulfilment beyond `init`, Invoices' mail, Merchants' payout, Ads' `PurchaseCompleted`) hangs on `PaymentCompleted` → `OrderPaid`, or `OrderDelivered` for COD. (c) `initOrderStage` and invoice creation stay **synchronous** in step 8 as idempotent RPCs — the SPA reads `invoice_no` and the stage immediately after placing (`Checkout.tsx:545-566`, `OrderDetail.tsx:493`); only the gift, Telegram and other side effects become consumers. (d) Cancel is refused or serialised while the saga is not `done`; a `stuck` saga returns a customer-visible code and is unblocked by an admin RPC; the partial UNIQUE on `checkout_sagas(user_id)` excludes `stuck`. (e) The 600 ms budget is provisional until measured on dark with and without smart placement (every leg round-trips to D1's single region).

**Consequences.** Checkout latency grows from one batch to ~5 RPC hops (budget p95 < 600 ms, to be measured); the response still carries the invoice number and stage; asynchronous side effects stop delaying it.

**Rejected.** *Saga across Workers from the first day of Commerce* (domain-first): the first production run of new saga logic would also be the first distributed run. *Keep B1 forever and never split Commerce from Ledger*: leaves the owner's Wallet/Ledger/Orders separation unachieved. *Unfenced sweep + `OrderCreated` as the purchase fact* (rev. 1): the race described above.

---

## ADR-008 — Durable Objects, Workflows, KV, Hyperdrive and the rate-limit binding sit behind adapters with D1 + cron + memory interims

**Context.** Plan and token permissions for these resources are unknown; the design must run today on D1 + Service Bindings + cron (constraint 3). Today's coordination is CHECK-abort tricks, revision fences (`farm.ts:151-160`), a 13-step `*/15` cron (`lib/jobs.ts`) and a D1 rate limiter (`lib/ratelimit.ts`).

**Decision.** Platform-kit adapters with two implementations each, chosen by binding presence: `RealtimeHub` (`NoopHub`/`DoHub`), `Serializer` (`NoopSerializer`/`DoSerializer` for `WALLET_LOCK`, `STOCK`, `CHECKOUT_SESSION`), `ProcessRunner` (`CronSweepRunner`/`WorkflowRunner` for order stages, delivery sync, points release, KYC review, subscription lifecycle, import apply, escrow auto-complete), `RateLimiter` (`D1RpcRateLimiter` over `IDENTITY.rateLimitHit` — authoritative from day one — with `BindingRateLimiter` as the per-colo first layer and `DoRateLimiter` later; `MemoryRateLimiter` dark/local only; `rateLimitKey` pinned by `tests/rateLimitKey.test.ts`; see the amendment below and ADR-016), `Cache`/`Config` (memory → KV), `LedgerStore` (D1 → Hyperdrive/PostgreSQL), `AnalyticsSink` (D1 → Analytics Engine). DO classes use SQLite storage and are declared in the owning Worker's wrangler (`durable_objects.bindings`, `migrations[].new_sqlite_classes`); Workflows via `workflows: [{ binding, name, class_name }]`; Hyperdrive via `hyperdrive: [{ binding, id }]`; rate limits via `ratelimits: [{ name, namespace_id, simple }]` — keys exactly as in `node_modules/wrangler/config-schema.json`. Each service gets its own cron, dissolving `lib/jobs.ts` step by step behind `LEGACY_DISABLED_STEPS`.

**Amended (rev. 2).** (a) Not every adapter target needs provisioning: the `ratelimits` binding (`namespace_id` is a developer-chosen integer), SQLite DO classes (`wrangler deploy` with the existing Workers Scripts permission), Analytics Engine datasets (created on first write) and probably Workflows are **deploy-only**; the provisioning list is split into (a) needs a scope/dashboard action and (b) needs only a deploy, and D22 asks the owner whether (b) on the live core counts under constraint 2. (b) The rate-limit adapter order is `D1RpcRateLimiter` (over `IDENTITY.rateLimitHit`, authoritative and cross-isolate from day one — never weaker than today's D1 window) → `BindingRateLimiter` as the per-colo first layer for `ip`/`public-read` (dark 1.5, live 3.3) → `DoRateLimiter` when DO is approved; `MemoryRateLimiter` is dark/local only. No gateway class may be tighter than the bucket the core enforces today for the same route (test-pinned). (c) `CronSweepRunner` stays the design for per-row schedules with thousands of concurrent waits; Workflows (one-year step ceiling, concurrent-instance cap) are reserved for bounded multi-step processes.

**Consequences.** Correctness never depends on a resource that may not exist: SQL guards and fences are sufficient today; DO/Workflows remove contention and polling. The provisioning list (`02-MIGRATION-PLAN.md` §13.2) names exactly what the owner must create, what is deploy-only, and what each costs.

**Rejected.** *Design around DO/Workflows now and block until provisioned*: stalls the programme on an unknown. *Never use them*: leaves chat/presence/locks on polling and cron forever. *Per-isolate memory bucket as the interim limiter* (rev. 1): a regression on every extracted money/upload route, bypassed by spreading requests over colos.

---

## ADR-009 — Every integration behind an adapter; Ads and Analytics as event consumers only

**Context.** External calls are scattered: Resend (`lib/outbox.ts`, `auth.ts:1812-1841`), Telegram (`lib/telegram.ts`, `lib/walletNotify.ts`), Al-Waseet (`lib/delivery/alwaseet.ts`, `DeliveryDriver` in `lib/delivery/types.ts`), Google JWKS (`lib/google.ts`), an external translation API (`routes/misc.ts:29-46`), model-host APIs (`lib/externalModels.ts`). The owner wants Meta/Google/TikTok/Snapchat ads via adapters and never wired into Order/Checkout.

**Decision.** Interfaces in the platform kit / owning service: `EmailProvider` (Resend), `ChatProvider` (Telegram), `DeliveryDriver` (exists; Al-Waseet), `PaymentProvider` (`ManualTransferProvider`, `SandboxProvider`; PSP later), `AdsProvider` (`MetaConversionsApi`, `GoogleAdsOfflineConversions`, `TikTokEventsApi`, `SnapchatConversionsApi`, `NoopProvider` — sandbox when secrets are absent), `AnalyticsSink`, `SearchIndex`. Every provider call goes through `fetchWithBudget` (timeout, retries only when idempotent, SSRF guard from `lib/fetchGuard.ts`, per-provider circuit breaker); a lint bans bare `fetch(` outside the platform kit. Ads and Analytics consume events (`PurchaseCompleted → bus → Ads → providers`); nothing in Commerce imports a provider; kill switches per provider/event; consent gates any user identifier.

**Amended (rev. 2).** Contact hashing is done by **Identity** on a consent change (`UserUpdated{marketing_consent, email_hash, phone_hash}` → `ads_consent_snapshots` keyed by `user_hash`), never by Orders: giving Commerce `IDENTITY.lookupContacts` would have handed the largest user-input surface a standing contacts dump. `PurchaseCompleted` carries `order_id`, `user_hash`, value and items; Ads joins locally and drops `pii` fields at ingest when consent is not `ads`. `PurchaseCompleted` is produced on `OrderPaid` (prepaid) or `OrderDelivered` (COD), never on `OrderCreated`. Analytics consumes an explicit allowlist, not `'*'`.

**Consequences.** Adding a provider is a new adapter + secrets on one Worker; a provider outage never slows a customer request; sandbox rows prove the pipeline before any secret exists; no Worker but Identity ever reads raw contacts.

**Rejected.** *Client-side pixels first*: needs a CSP change and leaks to the browser; server-side conversions are the default (owner decision D19). *Calling providers from the order path*: explicitly forbidden.

---

## ADR-010 — Versioning: legacy paths forever, `/api/v1/<service>`, additive events, additive migrations

**Context.** The SPA and scripts call ~90 legacy prefixes; the owner forbids breaking any; schema migrations must precede code (DECISIONS row 36).

**Decision.** Legacy paths keep method, path, envelope (`{success, error, code, details}`) and status codes; `tests/routeTable.test.ts` (new) snapshots the mounted table and fails on removal; 410s only by owner decision and they answer forever (as `index.ts:190-196`). New endpoints live under `/api/v1/<service>/…`; the gateway routes both; `x-levonis-legacy-path: 1` and `x-api-deprecated: <date>` measure and signal. Events: additive changes keep `version`; breaking changes add `v2/` with dual emission for one phase. Migrations `0055+` are additive (`CREATE`, `ALTER TABLE … ADD COLUMN`); columns are never dropped; a service moving to its own store keeps dual-read for one phase. Contract types are shared type-only with the SPA (`packages/contracts/src/http/*`; `tests/store-isolation.test.ts` extended).

**Consequences.** Two surfaces coexist for a long time at zero runtime cost; the 410 decision stays open with usage data.

**Rejected.** *Rename paths per service at extraction*: breaks the SPA and every `scripts/e2e-*.mjs`. *Version by header*: invisible in logs and caches.

---

## ADR-011 — Naming and environments: `levonis-<service>` / `levonis-<service>-dark`; live names untouched

**Context.** `levonis-staging` and `levonis-studio-staging` are the live Workers; `levonis` does not exist; `levonis-studio` serves nothing (`docs/WORKERS.md`). The mandate calls for a DARK phase.

**Decision.** New production Workers are `levonis-<service>` (no route, `workers_dev:false`, **`preview_urls:false`** in every environment block — the schema defaults the latter to `false` in wrangler 4.127 but the dashboard can flip it, and a version Preview URL would expose an internal Worker's Hono app past every gateway control; `tests/leastPrivilege.test.ts` pins both keys); their dark twins `levonis-<service>-dark` live in wrangler `env.dark` with dark D1/R2 (`levonis-db-dark`, `levonis-files-dark`, `levonis-<service>-db-dark`); the core's dark twin is `levonis-core-dark` via a new `env.dark` block in `wrangler.jsonc`; the dark gateway and dark core are routed from the **dark zone** (D21). The live core gets `workers_dev:false` + `preview_urls:false` at G3 (its workers.dev host is a second door where `adminAllowedOn()` returns true). The two live names are never renamed. No new Worker carries `-staging`. `tests/workflowNaming.test.ts` is extended: every `svc-*.yml` names its Worker, says `DARK … serves no domain` or `LIVE`, uses a unique number prefix and a confirmation phrase for LIVE, and re-points the verify workflows per phase (`02-MIGRATION-PLAN.md` §12.1).

**Consequences.** The historical inversion stays documented, not fixed (renaming means a coordinated dashboard routing change). `2 - Rebuild levonis-staging + run API tests` is re-pointed at the dark stack so test data never lands in the live DB again.

**Rejected.** *Rename the live Workers now*: a routing change with no functional gain. *Reuse `env.staging` for dark*: on this account "staging" is live.

---

## ADR-012 — Audit as a hash-chained event consumer; the `audit()` facade writes an outbox row in the caller's batch

**Context.** `audit()` swallows failures (`lib/audit.ts:14-16`); `audit_log` is read as authorization state (`routes/profile.ts:48-53`) and as an idempotency store (`routes/template.ts:878`); financial-scope decisions are audited inconsistently.

**Decision.** `levonis-audit` (own D1 from Phase 1) stores `audit_events(id, seq, prev_hash, hash, event_id, actor_id, action, target, detail, created_at)` with `hash = HMAC(AUDIT_CHAIN_KEY, prev_hash || canonical(row))` and a cron `verifyChain`. `audit()` becomes a facade that appends an `AuditRecorded` outbox statement to the caller's batch (dual-written to `audit_log` until Phase 3); a sensitive mutation therefore cannot succeed unaudited. The state misuses move to owned tables (`username_changes`, `product_imports.fingerprint`, a `warranty_receipts` column) in Phase 0.5 (migration `0057_state_tables`). Reads are `admin:full` only.

**Amended (rev. 2).** (a) A plain SHA-256 chain stored next to its own head proves nothing against the Worker that writes it, so the chain is an HMAC and `audit_chain_heads` is **anchored hourly to a sink the Audit Worker cannot rewrite** — an R2 object under a write-once prefix on the Files Worker (or a Telegram admin message); `verifyChain` compares against the anchor. (b) The `detail` body does not travel in the outbox envelope (it would sit readable in the shared D1 for 180 days): the facade stores it in `<svc>_audit_details`, pruned within 24 h of ack, and the pump hands it to Audit in the same `deliver()` call.

**Consequences.** `audit_log` is frozen read-only after Phase 3 and stays. Money and permission changes are provable after the fact against an external anchor; replay from producers' outboxes can rebuild the chain up to the detail-retention window.

**Rejected.** *Synchronous `AUDIT.record` RPC before returning success*: an Audit outage would block money paths; the outbox row gives the same guarantee without the coupling. *Keep best-effort inserts*: the current gap.

---

## ADR-013 — Search, Risk, Analytics, Ads and Audit are real Workers with their own D1 from the start

**Context.** These domains are empty or scattered today (assessment §6.1); the owner wants them from day one, not extracted later; folding them into Catalog/Ledger/Support would create fake boundaries.

**Decision.** Analytics, Ads and Audit start in Phase 1 (dark) and go live in Phase 2 as pure event consumers; Search (own D1 with FTS5 fed by `ProductAdded`/`ProductArchived`/`PriceChanged`/`MerchantStatusChanged`, backfill via `CATALOG.listForIndex`) and Risk (own D1; owner of `restriction_cases`; consumer of money/order/gateway events; `RISK.flagsOf` replaces `entitlements.ts:95`) start in Phase 4. Each has its own tables, secrets (Ads), consumers and RPC read models; the core delegates behind flags (`GET /api/products?q=` → `SEARCH.products()`).

**Consequences.** Five small Workers and five small D1s early; the event contracts are exercised from Phase 1; live aggregates (`admin.ts:125-159`, `merchant.ts:1443-1487`) are replaced gradually by rollups.

**Rejected.** *Modules inside existing deployables until "later"* (transactions-first): the later extraction the owner forbade, and no early proof of the event pipeline.

---

## ADR-014 — Owner gates are the only live changes; everything else is dark or a code deploy on the normal path

**Context.** Constraint 2 forbids production infrastructure changes without approval; the deploy token must not be widened (constraint 8); the live deploy path is workflow 7 (`deploy-staging-code.yml`) which preserves vars and applies migrations first.

**Decision.** Live changes happen only at named gates — **G0** (Git integration disconnected; two-PR rule in force — before any `0055+` code merges), G2 (bindings, per-minute cron, vars/secrets and migrations on the core via workflow 7, as an enumerated change set), G3 (six `/api/*`,`/files/*` zone routes added to the gateway; `workers_dev:false` + `preview_urls:false` on the core), G4 (secret moves), G5 (production D1s), G6 (PostgreSQL + a separate approval per data migration), G7 (core retirement) — each with a documented rollback. Everything else is either dark or an ordinary code deploy through workflow 7/8 or the new per-service workflow, which reuses workflow 7's var-preservation and migrations-before-code discipline. Missing token scopes are answered by the owner creating the resource in the dashboard; the workflow binds by name/id.

**Amended (rev. 2).** (a) Workflow 7 gains generic, validated `set_var` / `upload_secret` inputs (slice 0.0), so every core flag and secret the programme needs is a workflow run with a known propagation time — a "flag off" rollback is a seconds-level switch, not a hand-written special case or a dashboard edit; every slice states who flips which var where. (b) Deploy-only resources (`ratelimits`, DO classes, Analytics Engine, Workflows) are listed separately in §13.2 and D22 asks the owner whether their first appearance on the live core is gated. (c) The Workers Paid plan is a hard precondition printed by the first dark workflow (D1); there is no Free-plan fallback. (d) A slice 1.0 of platform probes records every design-critical Cloudflare fact (ADR-017) before Phase 1 depends on it.

**Consequences.** The programme has explicit waiting points; dark slices always exist to fill them. Nothing in the repository ever declares a route or widens a token.

**Rejected.** *Auto-provision with a broader token*: constraint 8. *Ask for a blanket approval up front*: not a gate, and not what the owner asked for. *Disconnecting the Git integration only at G3* (rev. 1): leaves a deployer that ships code ahead of its schema during the phases that add schema.

---

## ADR-015 — The Admin BFF is its own internal Worker, never a package inside the gateway

**Context.** ADR-002 designs against a compromised gateway (Identity signs, so the gateway can only replay). Rev. 1 then placed `/api/admin/overview`, `/api/admin/users*` (PATCH of role/tier → `IDENTITY.setRole`) and `/api/admin/providers` in the gateway deployable as an Admin BFF, which would have put the gateway's `kid` on the allowlists of `IDENTITY.setRole`, `IDENTITY.lookupContacts` and every admin read model — the Worker that parses every byte from the internet could then promote any user to `admin:full` with a replayed admin principal.

**Decision.** `levonis-admin` (new): an internal Worker (`workers_dev:false`, `preview_urls:false`, no route, own hop key) composing RPC read models and admin commands, never SQL; the gateway routes the three prefixes to it like any other. The gateway's `calls` are pinned by `tests/leastPrivilege.test.ts` to `IDENTITY.resolveSession|revoke|getPublicKeys|rateLimitHit`, `*.deliver`, `*.health` and the HTTP forward — no method containing `Admin`, `set`, `credit`, `debit`, `decide` or `lookupContacts`.

**Consequences.** One more small Worker (28 in the end state). The gateway holds no business logic in fact, not only in text. Studio's `IDENTITY` stub is allowlisted the same way (`redeemHandoff`, `introspect` only).

**Rejected.** *Admin BFF inside the gateway* (rev. 1): defeats ADR-002's threat model. *Admin endpoints scattered across owners with no BFF*: the overview needs cross-domain composition somewhere, and that somewhere must not be the edge.

---

## ADR-016 — Rate limiting: the cross-isolate D1 counter stays authoritative behind Identity; new classes are never tighter than today and ship in shadow

**Context.** The only cross-isolate limiter today is the D1 fixed window (`lib/ratelimit.ts:48-56`), called from 131 route sites, including money and upload routes and a Telegram status poll deliberately set to 240/min per IP because Iraqi carrier NAT puts many customers behind one address (`auth.ts:1269-1271`). Rev. 1 gave `rate_limits` to a Worker without D1, proposed per-isolate memory as the interim, and specified classes (Telegram poll 60/min, a global `ip` 600/min) tighter than the buckets the core enforces.

**Decision.** `rate_limits` is Identity's; every Worker reaches it through `IDENTITY.rateLimitHit` (`D1RpcRateLimiter`, the default and authoritative adapter for `auth`/`money`/`upload`/`write`/`admin-write`/`webhook`). The `ratelimits` binding is the cheap **per-colo** first layer for `ip`/`public-read` (no counter exists for them today). **No gateway class may be tighter than the bucket the core enforces for the same route** (`tests/rateLimitParity.test.ts` extracts every `rateLimit()` call site); classes with no counter today ship in shadow/log-only mode with `/24` telemetry for two weeks before enforcement; bearer server-to-server routes (Studio handoff, Telegram webhook) are exempt from the `ip` class. Every Phase-4+ slice proves its moved routes kept a cross-isolate limit.

**Consequences.** One D1 write per limited request (as today) until the DO counter exists; a moved route never loses a control it has; the placeholder numbers in `01-TARGET.md` §3.6 are replaced by measured ones.

**Rejected.** *Per-isolate bucket as the interim*: bypassable by spreading across colos; a regression on money/upload routes. *`ratelimits` binding as the only limiter*: per colo, so not the same guarantee.

---

## ADR-017 — Platform facts are proved by throwaway Workers before the plan depends on them

**Context.** developers.cloudflare.com is unreachable from this environment; `node_modules/wrangler/config-schema.json` and `@cloudflare/workers-types` are the only local truth, and they say nothing about account limits, route-vs-Custom-Domain precedence, cron-trigger counts, self-binding RPC, `_headers` through `ASSETS.fetch`, or Workflow concurrency accounting.

**Decision.** Slice 1.0 deploys one throwaway Worker per question on the dark stack / dark zone and records the verdicts here before G1. The table is filled by the slice; until then every row is **unverified** and the plan carries the named fallback.

| # | Question | Verdict | Fallback if false |
|---|---|---|---|
| a | The CI token can create a new Worker name | unverified | owner creates the Worker in the dashboard once; workflow deploys by name |
| b | Workers Paid; cron-trigger count with ~28 per-minute Workers | unverified | **no fallback** — precondition (D1) |
| c | A Worker can bind to its own named entrypoint (self-binding RPC) | unverified | statement descriptors only inside a deployable (ADR-004); split = RPC |
| d | `ASSETS.fetch` via a binding honours `_headers`, ETag/304, SPA fallback | unverified | SPA stays on the core's Custom Domain (D23 (a)) |
| e | Subrequest / D1-statement budget of a full pump run | unverified | lower the pump budgets in ADR-005 |
| f | A `<host>/api/*` route wins over a Custom Domain's Worker; `*.<root>/api/*` over `*.<root>/*` | unverified | plan 3.0-alt: convert apex/www to DNS + routes still targeting the core |
| g | `caches.default` on a zone route behaves as designed | unverified | cache allowlist off (`GW_CACHE` KV later) |
| h | Workflows: `sleepUntil` ceiling; sleeping instances vs concurrency | unverified | `CronSweepRunner` stays for per-row schedules |
| i | DO SQLite class created by `wrangler deploy` with the current token | unverified | DO stays "when approved"; fences remain |
| j | Analytics Engine dataset created on first `writeDataPoint` | unverified | D1 sink |
| k | PBKDF2/bcrypt CPU time when the core runs under a binding | unverified | `limits.cpu_ms` on the core (schema key) |

**How the owner fills the table** (added by slice 1.9 — the probes exist as files; nothing has been deployed). One throwaway Worker per row lives in `services/probes/<dir>/`, each answering `GET /` with `{row, question, answer, verdict}`; `29 - Platform probes (DARK throwaway Workers — serve no domain)` deploys them, curls them and writes the eleven one-line verdicts into the run's job summary, which is what gets pasted above.

```
Actions -> "29 - Platform probes (DARK throwaway Workers - serve no domain)" -> Run workflow
    confirm:              DEPLOY-PROBES
    paid_plan_confirmed:  checked, if the Workers Paid badge is confirmed in the dashboard   (row b)
    dark_root:            <darkroot>        the throwaway dark zone of D21                   (rows f, g)
    dark_db:              levonis-db-dark   optional; a *-dark database ONLY                 (row e)
    include_optional:     checked to also deploy the Workflows probe                         (row h)

# then, once the verdicts are in the table above:
Actions -> the same workflow -> Run workflow
    confirm:              DELETE-PROBES
```

| Probe directory | Worker | Row | What its answer decides |
|---|---|---|---|
| `a-worker-name/` | `levonis-probe-name` | a | whether every later slice may deploy its own Worker, or the owner creates each name in the dashboard once |
| `b-plan-and-cron/` | `levonis-probe-cron` | b | the plan precondition (from `scripts/assert-paid-plan.mjs`, run in the same job) and what a `* * * * *` trigger really costs |
| `c-self-binding/` | `levonis-probe-selfbind` | c | whether ADR-004's merged deployables can call their own named entrypoints — it also exercises the two-step first deploy, since it binds to itself |
| `d-assets-binding/` | `levonis-probe-assets` | d | D23: whether the SPA may ever move to a gateway `assets` block |
| `e-budgets/` | `levonis-probe-budgets` | e | ADR-005's pump budgets. Bound to a `*-dark` database only, and it only ever runs `SELECT 1` |
| `f-route-precedence/` | `levonis-probe-route` + `levonis-probe-domain` | f | whether the Phase 3 cut-over is a route ADD (rollback: delete six routes) or needs plan 3.0-alt first. Needs two dashboard attachments on the dark zone, which the workflow prints |
| `g-cache-api/` | `levonis-probe-cache` | g | the gateway's safe-cache layer. Meaningless on workers.dev, and the probe says so in its own answer rather than reporting a clean miss |
| `h-workflow-sleep/` | `levonis-probe-workflow` | h | whether the process adapter's Workflow implementation is worth switching on, or `CronSweepRunner` stays. **Opt-in** |
| `i-do-sqlite/` | `levonis-probe-do` | i | D22's "deploy-only" claim for every Durable Object class in §7 |
| `j-analytics-engine/` | `levonis-probe-ae` | j | whether the metrics sink of §11.4 is a config switch |
| `k-pbkdf2-cpu/` | `levonis-probe-cpu` + `levonis-probe-cpu-caller` | k | whether `limits.cpu_ms` goes on the core before the cut-over. Measured on both sides of the hop, because the hop is the question |

**Consequences.** Slice 1.0 costs a day; every later slice cites a row instead of an assumption. The probe Workers are deleted after the table is filled.

**Rejected.** *Assume and discover in production*: the incidents documented in `docs/DECISIONS.md` rows 36 and 52 are what that looks like.
