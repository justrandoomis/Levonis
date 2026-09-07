# LEVONIS — Architecture Decision Records (canonical)

Date: 2026-09-07. Base tree: `89e663e`. One record per structural decision behind `01-TARGET.md`, `02-MIGRATION-PLAN.md` and `03-EVENTS.md`. Each record: context, decision, consequences, the alternative rejected and why. Status of every record: **accepted as design**; nothing is applied until the plan's slices run. Names marked **(new)** do not exist yet.

---

## ADR-001 — The gateway is the strangler; dark first; one live route change

**Context.** One Worker (`levonis-staging`) serves `levonis-iq.com` and `*.levonis-iq.com` with 47 route files (`worker/index.ts`). The owner requires no broken function at any step, no live infrastructure change without approval, and a small team. Routing lives in the Cloudflare dashboard, not the repo (`docs/WORKERS.md`; `tests/workflowNaming.test.ts` rejects `routes`/`custom_domains`).

**Decision.** A single public gateway Worker (`levonis-gateway`, new) routes prefix + host class to the owning Worker over Service Bindings and forwards everything else to the core (`CORE` binding). It is built and proven on a fully dark stack (`levonis-core-dark` + `levonis-gateway-dark` + dark leaves, own D1/R2) with a recorded parity corpus (`scripts/gateway-parity.mjs`, new) before the owner moves the zone routes once (Phase 3.2). Every later extraction is a prefix flip with a kill switch; rollback of the cut-over is the route change reversed.

**Consequences.** One extra hop (bindings are near in-process; budget p95 < 150 ms). The core keeps serving assets via its `ASSETS` binding until Phase 9. The core keeps every check (defence in depth) while the gateway takes authority for headers, limits, cache and capabilities. The Workers Builds Git integration must be disconnected once the gateway is in front (SUBDOMAIN_ARCHITECTURE.md §7.5.3).

**Rejected.** *Routing per service from the dashboard* (a zone route per prefix): N dashboard changes, each an owner action, no kill switch, no single place for auth/limits. *Big-bang cut to a new stack*: violates constraints 1, 2 and 4.

---

## ADR-002 — Gateway auth model: Identity-signed principal, per-hop envelopes, opaque cookie unchanged

**Context.** Every route trusts `c.get('user')` from `sessions JOIN users` (`worker/lib/session.ts:63-69`); `SessionUser` mixes identity with tier/admin fields (`lib/types.ts`). The cookie is `levonis_session`, hashed-only storage, `Domain=.<root>` (`docs/SUBDOMAIN_ARCHITECTURE.md` §6). Zero trust between services is required.

**Decision.** The gateway computes `sha256(token)` and calls `IDENTITY.resolveSession(hash)`; Identity returns a **principal signed with its own Ed25519 key** (`IDENTITY_SIGNING_KEY`): `{sub, sid_hash, role, scope, investor, tier, locale, host_kind, iat, exp: iat+120}` — no email, phone, hashes. The gateway caches ≤30 s per `sid_hash`, forwards `x-levonis-principal` and strips inbound `x-levonis-*`. Services verify with Identity's public keys and re-apply their own authorization. Every service→service RPC carries a **hop envelope** signed by the caller's key (`iss, kid, iat, exp+30s, nonce, method`) verified against a per-method caller allowlist with nonce replay protection. The cookie is forwarded only to `CORE` (strangler) and Identity. Until Identity is its own Worker, `IDENTITY` = the core's `IdentityEntrypoint` (same SQL), and `PRINCIPAL_MODE=off|shadow|on` lets the gateway compare before enforcing.

**Consequences.** Logout propagation is bounded by the 30-s cache (shorter than Studio's 60-s cache today); `IDENTITY.revoke` evicts eagerly. Services must not re-parse `Host`; they read `host_kind` from the principal/`x-levonis-host`. Key rotation is `kid`-based, ordinary deploys. The `SessionUser` shape is reconstructed by `principalToSessionUser()` so moved route code keeps working.

**Rejected.** *Gateway-signed principal*: a compromised gateway could mint any principal; with Identity signing it can only replay within `exp`. *JWT replacing the cookie*: eventually-consistent logout and a larger browser attack surface; the opaque hashed session (SECURITY.md §2) stays. *Trusting binding identity alone*: a binding proves "some Worker on the account", not which one or which method.

---

## ADR-003 — Interim shared D1: one writer per table, ownership manifests, a tolerance list that only shrinks

**Context.** 137 tables live in one D1 (`levonis-db-staging`); `wallet_transactions` has 12 writers across 6 domains, `orders` 8, `users` 3 non-identity writers (assessment §2.1). No data migration is allowed without a separate approval (constraint 4). D1 has no schemas or grants, and a service that binds the database can name any table.

**Decision.** Ownership is enforced by code and tests, not by the database, until a service moves its tables: (1) `services/<name>/OWNERSHIP.json` lists `owns`/`reads`; (2) `ownedDb()` in the platform kit refuses statements naming other tables (`throw` in dark, `log` for one production release, then `throw`); (3) `tests/serviceBoundaries.test.ts` scans SQL literals and imports; (4) `worker/OWNERSHIP.tolerance.json` enumerates the core's remaining foreign writes with their removal phase and can never grow (snapshot test); (5) column groups on `orders`, `users`, `products` have one semantic owner but only the table owner executes SQL — others issue commands (`ORDERS.applyStage`, `IDENTITY.setRole`, `PRODUCTS.setOpsPolicy`) or events (`SubscriptionChanged` → Identity updates `membership_tier`); (6) `migrations/` stays the single stream applied before code (workflow 7), files `0055+` name their owner, touch only that owner's tables, and pass the additive classifier extended to accept `ALTER TABLE … ADD COLUMN`.

**Consequences.** A bug can still reach a foreign table at runtime in the first release of each service (logged, counted). On PostgreSQL each service gets a schema and a role, and the manifest becomes redundant with the grant. New leaf services without legacy tables get their own D1 from day one.

**Rejected.** *Move data first (per-service D1 before code)*: violates constraint 4 and multiplies migration risk. *SQLite table-name prefixes*: renaming is a data-touching migration. *Trust the review process*: the assessment shows 16 cross-domain batches that got through review.

---

## ADR-004 — Merged deployables host separate packages with separate contracts and self-bound named entrypoints

**Context.** Several owner-named services write the same rows in one D1 batch today: checkout writes seven domains (B1), POINT rows live in `wallet_transactions` (B7/B8/B10), price and stock are columns of the same catalogue rows, store checkout spans orders + four merchant tables (B4). The owner forbids fake microservices *and* forbids breaking anything.

**Decision.** Four deployables host more than one owner-named service until their split trigger: Catalog (Catalog/Products/Pricing/Inventory), Commerce (Cart/Checkout/Orders/Coupons/Refunds), Ledger (Wallet/Ledger/Payments/Loyalty), Marketplace (Marketplace/Merchants). Inside each, every service is a package `services/<deployable>/src/<service>/` exporting its own `WorkerEntrypoint` (`cloudflare:workers`) with its own contract in `packages/contracts/src/rpc/`, its own `OWNERSHIP.json` section and its own HTTP routers. Packages call each other **only through the self-binding** `{ binding: 'LEDGER', service: 'levonis-ledger', entrypoint: 'LedgerEntrypoint' }`, never by import (lint). Splitting = change the caller's binding to the new Worker name, move the tables; no code changes. Split triggers are named per row in `01-TARGET.md` §1.2.

**Consequences.** Atomicity is preserved where a batch is the only correctness mechanism; independence of code, contract and permissions exists from day one; availability is shared within a deployable until the split. Loyalty never splits from Ledger while POINT rows are journal rows (a separate points journal is a data decision).

**Rejected.** *One Worker per owner-named service from the start* (the domain-first design): B1 becomes a 6–8 hop saga before the saga is proven, Inventory leaves the checkout batch while checkout is still in the monolith, and ~43 Workers exceed what a small team can operate. *A modular monolith with folders only*: no separate contract, permissions or deployment path — the fake microservice the owner forbade.

---

## ADR-005 — Transactional outbox per producer; RPC fan-out dispatcher today, Queues by config

**Context.** Side effects run inline or best-effort (`audit()` swallows failures `lib/audit.ts:14-16`; `waitUntil` pumps; the invoice email is awaited in checkout `routes/orders.ts:1556`). Queues may not be provisionable yet (Paid plan + token scope unknown). The `outbox` table + `notifyStatement` (`lib/notifications.ts:66-72`) already show the right pattern.

**Decision.** Every producer has `<svc>_outbox_events` (+ `_deliveries`, `pump_lock`) in its own store; the outbox INSERT rides in the business batch; the platform kit's `Uow` refuses to commit a publishing command without it. `RpcFanoutBus.pump()` (after the batch via `waitUntil`, and from the producer's cron) delivers to subscribers from the static map `packages/contracts/src/subscriptions.ts` over their bindings with exponential backoff (8 attempts → `dead`, replayable). `QueueBus` is selected by `EVENT_BUS_MODE=queue` + the `EVENTS_QUEUE` binding; consumers implement one `deliver()` called from both RPC and `queue()`. Consumers dedup with `<svc>_processed_events` in the same batch as their side effect; money consumers additionally key on domain keys.

**Consequences.** At-least-once, per-aggregate ordering only; a consumer outage backs up in the producer's outbox (alert at 5 min). The legacy core is a producer too (`core_outbox_events`, migration `0056`) — rows accumulate before consumers are bound, and nothing is lost. Audit becomes reliable because the outbox row fails the batch if it cannot be written.

**Rejected.** *A central bus Worker with its own store* (domain-first): an extra hop and a single point of failure on every event, plus one more D1; the static map gives the same topology control. *Direct synchronous RPC for side effects*: couples the request path to Ads/Analytics/Notifications, the exact thing the owner forbids. *Queues from day one*: not provisionable today.

---

## ADR-006 — The ledger journal stays `wallet_transactions`; every command carries an event key; hold commit debits atomically; PostgreSQL row locks later

**Context.** Balances are `SUM` over approved rows (`lib/walletOps.ts:44-61`); in-statement guards (`usdSpendStatement`, `walletOps.ts:97-113`; hold inserts `:228-258`) make single batches safe. Committed purchase holds never post a debit (`storeOrders.ts:344`, `escrowOps.ts:240,336` — HIGH); `lib/wallet.ts` `credit()` has no key; two deposit-approval paths exist (`admin.ts:449-511`). Constraint 5 keeps the existing wallet/points semantics.

**Decision.** `wallet_transactions` remains the journal; migration `0055_ledger_keys.sql` (new) adds `event_key` (partial UNIQUE), `correlation_id`, `source_service` and the composite index; historical rows stay `NULL`, deterministic ids (`wtx_ord_<id>_usd`, `wtx_refund_<id>_pts`, …) become the keys on first touch. The `LedgerApi` (`credit, debit, hold, commitHoldAndDebit, releaseHold, refund, reservePoints/settlePoints/releasePoints/reversePoints, decideDeposit`) is the only write path; `eventKey` is mandatory; `ledger_idempotency` stores every outcome; `commitHoldAndDebit` writes the withdrawal row and flips the hold in one batch; `decideDeposit` is the only approval path; `ledger_balances` is a materialised cache with a revision fence, the `SUM` stays the truth on D1, `reconcile()` covers purchase holds and never repairs silently. On PostgreSQL via Hyperdrive (`LedgerStore` adapter: `D1LedgerStore`/`PgLedgerStore`), one transaction per command with `SELECT … FOR UPDATE` on the balance row; the materialised row becomes the truth and the `SUM` the audit. Every money method's batch carries an `AuditRecorded` outbox row.

**Consequences.** Behaviour of existing rows is unchanged; replays are safe across Workers; the assessment's HIGH #1, #3, #4 are closed in Phase 0 before any extraction. Merchant IQD accounts (`merchant_payout_ledger`) follow the same rules inside Marketplace (`payout:<id>` keys, conditional flips).

**Rejected.** *Stored balance as truth on D1 now*: no row locks; the revision fence is a retry loop, not a lock; the SUM + in-statement guard is what protects money today and is kept. *New journal table*: a data migration of every historical row (constraint 4/5). *Points as a separate ledger service*: B7/B8/B10 become two-step flows before PostgreSQL exists.

---

## ADR-007 — The checkout saga is built inside the core behind a flag before Commerce becomes a Worker

**Context.** B1 (`routes/orders.ts:1318-1493`) writes seven domains atomically with CHECK-abort tricks. Splitting any leg into another Worker before a saga exists produces half-applied orders or debits on a crash.

**Decision.** Phase 7.1 rewrites `placeOrder` as reserve (Inventory) → hold (Ledger USD) → reserve (Ledger points) → **local batch** (`orders`, `order_items`, `coupon_redemptions`, `order_payment_settlements`, `cart_items` delete, `checkout_sagas` state, outbox `OrderCreated`) → commit (`commitHoldAndDebit`, `settlePoints`, `INVENTORY.confirm`), with compensations using the same keys and a one-minute sweep that finishes or compensates stuck sagas. The remote legs call the core's own `LedgerEntrypoint`/`InventoryEntrypoint` first (same deployable), so distributed failure modes are exercised without distributed risk. `CHECKOUT_SAGA=on|off` selects saga vs legacy batch per request; both write identical rows and ids; rollout 10% → 100% after crash-injection tests (`tests/checkoutSaga.test.ts`, new) and a week on dark. Only then does `services/commerce` deploy (7.3), and the legacy path stays one release for rollback. Cancel/refund (B2/B3), store checkout (B4), escrow (B6/B14) and membership purchase (B9) follow the same shape.

**Consequences.** Checkout latency grows from one batch to ~5 RPC hops (budget p95 < 600 ms); post-commit effects (`initOrderStage`, invoice, gift, Telegram — `orders.ts:1525-1575`) become `OrderCreated` consumers and stop delaying the response.

**Rejected.** *Saga across Workers from the first day of Commerce* (domain-first): the first production run of new saga logic would also be the first distributed run. *Keep B1 forever and never split Commerce from Ledger*: leaves the owner's Wallet/Ledger/Orders separation unachieved.

---

## ADR-008 — Durable Objects, Workflows, KV, Hyperdrive and the rate-limit binding sit behind adapters with D1 + cron + memory interims

**Context.** Plan and token permissions for these resources are unknown; the design must run today on D1 + Service Bindings + cron (constraint 3). Today's coordination is CHECK-abort tricks, revision fences (`farm.ts:151-160`), a 13-step `*/15` cron (`lib/jobs.ts`) and a D1 rate limiter (`lib/ratelimit.ts`).

**Decision.** Platform-kit adapters with two implementations each, chosen by binding presence: `RealtimeHub` (`NoopHub`/`DoHub`), `Serializer` (`NoopSerializer`/`DoSerializer` for `WALLET_LOCK`, `STOCK`, `CHECKOUT_SESSION`), `ProcessRunner` (`CronSweepRunner`/`WorkflowRunner` for order stages, delivery sync, points release, KYC review, subscription lifecycle, import apply, escrow auto-complete), `RateLimiter` (`MemoryRateLimiter`→`DoRateLimiter`→`BindingRateLimiter`; the D1 limiter stays active in the core until then; `rateLimitKey` pinned by `tests/rateLimitKey.test.ts`), `Cache`/`Config` (memory → KV), `LedgerStore` (D1 → Hyperdrive/PostgreSQL), `AnalyticsSink` (D1 → Analytics Engine). DO classes use SQLite storage and are declared in the owning Worker's wrangler (`durable_objects.bindings`, `migrations[].new_sqlite_classes`); Workflows via `workflows: [{ binding, name, class_name }]`; Hyperdrive via `hyperdrive: [{ binding, id }]`; rate limits via `ratelimits: [{ name, namespace_id, simple }]` — keys exactly as in `node_modules/wrangler/config-schema.json`. Each service gets its own cron, dissolving `lib/jobs.ts` step by step behind `LEGACY_DISABLED_STEPS`.

**Consequences.** Correctness never depends on a resource that may not exist: SQL guards and fences are sufficient today; DO/Workflows remove contention and polling. The provisioning list (`02-MIGRATION-PLAN.md` §13.2) names exactly what the owner must create.

**Rejected.** *Design around DO/Workflows now and block until provisioned*: stalls the programme on an unknown. *Never use them*: leaves chat/presence/locks on polling and cron forever.

---

## ADR-009 — Every integration behind an adapter; Ads and Analytics as event consumers only

**Context.** External calls are scattered: Resend (`lib/outbox.ts`, `auth.ts:1812-1841`), Telegram (`lib/telegram.ts`, `lib/walletNotify.ts`), Al-Waseet (`lib/delivery/alwaseet.ts`, `DeliveryDriver` in `lib/delivery/types.ts`), Google JWKS (`lib/google.ts`), an external translation API (`routes/misc.ts:29-46`), model-host APIs (`lib/externalModels.ts`). The owner wants Meta/Google/TikTok/Snapchat ads via adapters and never wired into Order/Checkout.

**Decision.** Interfaces in the platform kit / owning service: `EmailProvider` (Resend), `ChatProvider` (Telegram), `DeliveryDriver` (exists; Al-Waseet), `PaymentProvider` (`ManualTransferProvider`, `SandboxProvider`; PSP later), `AdsProvider` (`MetaConversionsApi`, `GoogleAdsOfflineConversions`, `TikTokEventsApi`, `SnapchatConversionsApi`, `NoopProvider` — sandbox when secrets are absent), `AnalyticsSink`, `SearchIndex`. Every provider call goes through `fetchWithBudget` (timeout, retries only when idempotent, SSRF guard from `lib/fetchGuard.ts`, per-provider circuit breaker); a lint bans bare `fetch(` outside the platform kit. Ads and Analytics consume events (`PurchaseCompleted → bus → Ads → providers`); nothing in Commerce imports a provider; kill switches per provider/event; consent gates any user identifier; the producer hashes contacts in memory.

**Consequences.** Adding a provider is a new adapter + secrets on one Worker; a provider outage never slows a customer request; sandbox rows prove the pipeline before any secret exists.

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

**Decision.** New production Workers are `levonis-<service>` (no route, `workers_dev:false`); their dark twins `levonis-<service>-dark` live in wrangler `env.dark` with dark D1/R2 (`levonis-db-dark`, `levonis-files-dark`, `levonis-<service>-db-dark`); the core's dark twin is `levonis-core-dark` via a new `env.dark` block in `wrangler.jsonc`. The two live names are never renamed. No new Worker carries `-staging`. `tests/workflowNaming.test.ts` is extended: every `svc-*.yml` names its Worker, says `DARK … serves no domain` or `LIVE`, uses a unique number prefix and a confirmation phrase for LIVE.

**Consequences.** The historical inversion stays documented, not fixed (renaming means a coordinated dashboard routing change). `2 - Rebuild levonis-staging + run API tests` is re-pointed at the dark stack so test data never lands in the live DB again.

**Rejected.** *Rename the live Workers now*: a routing change with no functional gain. *Reuse `env.staging` for dark*: on this account "staging" is live.

---

## ADR-012 — Audit as a hash-chained event consumer; the `audit()` facade writes an outbox row in the caller's batch

**Context.** `audit()` swallows failures (`lib/audit.ts:14-16`); `audit_log` is read as authorization state (`routes/profile.ts:48-53`) and as an idempotency store (`routes/template.ts:878`); financial-scope decisions are audited inconsistently.

**Decision.** `levonis-audit` (own D1 from Phase 1) stores `audit_events(id, seq, prev_hash, hash, event_id, actor_id, action, target, detail, created_at)` with `hash = sha256(prev_hash || canonical(row))` and a cron `verifyChain`. `audit()` becomes a facade that appends an `AuditRecorded` outbox statement to the caller's batch (dual-written to `audit_log` until Phase 3); a sensitive mutation therefore cannot succeed unaudited. The state misuses move to owned tables (`username_changes`, `product_imports.fingerprint`, a `warranty_receipts` column) in Phase 0.5. Reads are `admin:full` only.

**Consequences.** `audit_log` is frozen read-only after Phase 3 and stays. Money and permission changes are provable after the fact; replay from producers' outboxes can rebuild the chain.

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

**Decision.** Live changes happen only at named gates — G2 (bindings + migrations on the core via workflow 7), G3 (zone routes to the gateway; Git integration disconnected), G4 (secret moves), G5 (production D1s), G6 (PostgreSQL + a separate approval per data migration), G7 (core retirement) — each with a documented rollback. Everything else is either dark or an ordinary code deploy through workflow 7/8 or the new per-service workflow, which reuses workflow 7's var-preservation and migrations-before-code discipline. Missing token scopes are answered by the owner creating the resource in the dashboard; the workflow binds by name/id.

**Consequences.** The programme has explicit waiting points; dark slices always exist to fill them. Nothing in the repository ever declares a route or widens a token.

**Rejected.** *Auto-provision with a broader token*: constraint 8. *Ask for a blanket approval up front*: not a gate, and not what the owner asked for.
