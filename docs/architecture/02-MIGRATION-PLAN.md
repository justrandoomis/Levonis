# LEVONIS — Migration Plan (canonical)

Date: 2026-09-07. Base tree: `89e663e`. Target: `docs/architecture/01-TARGET.md`. Events: `03-EVENTS.md`. Decisions: `04-DECISIONS.md`. Nothing here is applied; every phase ends in gates, and every change to what serves `levonis-iq.com` is an owner approval named **G**. Provenance of the plan's ideas: `01-TARGET.md` Appendix A.

Names marked **(new)** do not exist yet. Every other file, table, route, test, script and workflow name exists in the tree.

---

## الملخّص التنفيذي (بالعربية)

الخطّة تسع مراحل تُنفَّذ كشرائح من يوم إلى يومين، لكل شريحة بوّابة اختبار وتراجع معرَّف. **المرحلة ٠** تُصلح داخل النواة ما لا يجوز نسخه إلى خدمات جديدة (تثبيت الحجز مع الخصم، مسار قرار الودائع الواحد، حماية أسطح الإدارة السبعة، مفاتيح التكرار على الدفتر) دون أي تغيير في البنية. **المرحلة ١ مظلمة بالكامل**: نسخة معاينة من النواة بقاعدة فارغة، بوّابة معاينة أمامها، وأربع خدمات ورقية (Audit وAnalytics وAds وNotifications) بقواعد خاصّة، ومجموعة اختبار تقارن استجابة البوّابة باستجابة النواة طلبًا بطلب؛ لا يلمس شيء الموقع الحيّ.

**المرحلة ٢** تضيف روابط Service Bindings إلى النواة الحيّة فقط (بموافقة)، فتبدأ الأحداث بالتدفّق إلى الخدمات الورقية بلا أي مسار جديد. **المرحلة ٣** هي تغيير المسار الوحيد: يحوّل المالك مسارات النطاق إلى البوّابة، والتراجع = إعادة المسار في دقائق. **المرحلة ٤** تنقل الخدمات الورقية إلى مساراتها واحدة واحدة (المزرعة، الإشعارات، الملفات، الفواتير، KYC، السياسات، المحادثة، الدعم، الاستثمار، الإعدادات، البحث، المخاطر، Studio عبر Binding)، والتراجع عن كل واحدة قلب بادئة في البوّابة.

**المرحلة ٥** الكتالوج (القراءة أولًا ثم الكتابة)، **٦** السوق والاشتراكات والإحالات والمراجعات عبر عقد الدفتر المعروض من النواة، **٧** Saga الشراء تُبنى داخل النواة خلف علم تشغيل مع اختبارات حقن الأعطال ثم Worker التجارة والتسليم والأجهزة، **٨** نواة المال في Worker خاص ثم PostgreSQL بموافقة منفصلة لنقل البيانات، **٩** الهويّة ووضع الظلّ لمبدأ التوقيع ثم إحالة النواة إلى التقاعد بموافقة. Queues وDurable Objects وWorkflows وKV وHyperdrive مفاتيح إعداد تُفعَّل عند توفّرها، وقائمة التزويد الدقيقة في §13.

---

## 0. Conventions

- **Slice** = 1–2 days for one developer, one PR, own gate, own rollback. Common gate for every slice: `npm run check` (typecheck + lint + boundaries/least-privilege/ownership/schema/naming tests), `npm run test:unit`, `npm run build` (+ bundle budget), `node scripts/migrate-check.mjs --twice` (+ additive classifier for `0055+`), the integration corpus against the dark stack (`scripts/api-tests*.mjs`, relevant `scripts/e2e-*.mjs`), and — after any production deploy — the read-only live probes (`0 - Diagnose Live Site` (`diagnose-live.yml`), `verify-live-guest.yml`, `verify-subdomains.yml`, `verify-live-security-headers.yml`, `verify-live-auth.yml`). **No next phase before regressions are fixed.**
- **Strangler seam** = the exact point where traffic is diverted (a gateway prefix, an RPC method, an event).
- **Rollback levels**: (a) revert PR / `wrangler rollback`; (b) gateway prefix → `CORE` (kill switch, seconds); (c) dashboard route back to `levonis-staging` (minutes); (d) additive migrations never need a down-migration.
- **Owner gates**: **G1** dark report accepted · **G2** bindings + migrations on the live core · **G3** zone routes → gateway; Git integration disconnected · **G4** secrets move (email/Telegram → Notifications; `KYC_ENC_KEY` → KYC; `ALWASEET_*` → Fulfilment) · **G5** production D1 databases for own-store services · **G6** PostgreSQL + Hyperdrive, and a separate approval per data migration · **G7** core retirement · **D-numbers** = decisions listed in §13.
- Slice PR template (verbatim in every PR): *Scope · Strangler seam · Behaviour preserved (legacy paths still answering; parity test) · Gates run · Rollback · Needs provisioned · Owner gate*.

---

## Phase 0 — Hardening inside the core (no new Workers; ordinary workflow-7 deploys)

Purpose: fix the findings that would otherwise be copied into new services, and make the code movable. Runs in parallel with Phase 1.

| Slice | Scope (files) | Gate | Rollback | Needs |
|---|---|---|---|---|
| 0.1 | Money HIGH #1: add `commitHoldAndDebit` to `worker/lib/walletOps.ts` (withdrawal row + hold→committed in one batch); `worker/routes/storeOrders.ts:344`, `worker/lib/escrowOps.ts:240,336` call it; `walletReconciliationReport` covers purchase holds; `POST /api/orders/:id/cancel` (`routes/orders.ts:1751-1760`) refuses `seller_type='merchant'` | `tests/walletOps.test.ts`, `tests/escrow.test.ts` gain buyer settled-balance assertions; `scripts/e2e-wallet.mjs` on dark | revert PR (no schema) | D6 |
| 0.2 | Money HIGH #3/#4: `routes/admin.ts:449-511` legacy decide delegates to `decideDeposit` (`walletOps.ts:1015`); `admin.ts:514-526` manual credit gets `canViewFinancials` + `Idempotency-Key` + rate limit + audit; SPA `src/components/AdminWalletRequests.tsx:76`, `AdminOverview.tsx:133` repointed to `/api/wallet/admin/*` (old URL keeps answering) | `tests/adminWalletDecide.test.ts` extended | revert | — |
| 0.3 | Admin surface HIGH: the capability table (`01-TARGET.md` §3.5) applied inside the core — `requireMainHost` + scope on `routes/kyc.ts:165`, `routes/telegram.ts:562`, `routes/support.ts:1068`, `routes/policies.ts:134`, `routes/wallet.ts:457`, `routes/referrals.ts:41`, `routes/reviews.ts:44`; assistant scope denied decrypted KYC, wallet lists with destinations, investments, internal pricing keys of `GET /api/admin/settings` | `scripts/e2e-admin-reach.mjs`, `scripts/e2e-permissions.mjs`, `scripts/e2e-subdomains.mjs` | revert | D12 |
| 0.4 | Migration `migrations/0055_ledger_keys.sql` (new): `event_key`, `correlation_id`, `source_service` on `wallet_transactions`; partial UNIQUE index on `event_key`; index `(user_id, currency, status, type)`; pure `CREATE INDEX` items from assessment §4.3; every existing ledger writer starts populating `event_key` with its deterministic id | `tests/migrations.test.ts`; `scripts/check-migrations-additive.mjs` extended to accept `ALTER TABLE … ADD COLUMN` and applied to `0055+` (pinned in `tests/migrationsAdditive.test.ts`) | additive; columns stay unused | workflow 7 run (the normal path) |
| 0.5 | State out of infra tables: `username_changes` table (new) replaces the `audit_log` lookup in `routes/profile.ts:48-53`; `product_imports.fingerprint` column (new) replaces `rate_limits`/`audit_log` as the template idempotency store (`routes/template.ts:844-892`); `mission_streaks` table (new) replaces `users.checkin_streak` writes (`routes/rewards.ts:104`); dual-read for one release | unit tests | revert code; tables stay | — |
| 0.6 | Inventory ledger bypasses closed via `lib/inventory.ts` adjust with op ids: `routes/returns.ts:383-385`, `routes/adminPriceGrid.ts:935/364`, `routes/adminProductRelations.ts:726/764/804`, `routes/adminProducts.ts:909-923`; TXT/CSV imports write `price_history` | `tests/inventory.test.ts`, `tests/orderInventory.test.ts`, `tests/priceGrid.test.ts`, `scripts/e2e-price-change.mjs` | revert | — |
| 0.7 | Forgot-password through the outbox (`routes/auth.ts:1047,1060` timing oracle); `POST /api/orders` no longer awaits `processOutbox` (`routes/orders.ts:1556` → `waitUntil`) | `scripts/e2e-live-auth.mjs` on dark; timing test | revert | D16 |
| 0.8 | Legacy 410s where the owner approves: `/api/admin/products` v1 (`admin.ts:357-407`), `POST /api/translate` (`routes/misc.ts:18-56`) and its key, `POST /api/profile/warranty-claims` (`profile.ts:270-296`), `/api/admin/warranty-claims` (`admin.ts:1837-1856`); `/api/community/my-store*` and the legacy wallet decide only after the SPA is repointed | grep of `src/` callers; `tests/routeTable.test.ts` (new) records the 410 | revert | D8 |
| 0.9 | Code moves without path changes: wallet admin routes out of `admin.ts`; `lib/telegram.ts` split into `lib/telegramIdentity.ts` + `lib/telegramTransport.ts` (new); wallet approval code out of `routes/telegram.ts:657-839` into `lib/walletApproval.ts` (new); referral routes out of `routes/memberships.ts`; favorites/warranty out of `routes/profile.ts`; `getApprovedAddress` → `lib/approvedAddress.ts` (new); `sniff()` → `lib/sniff.ts` (new); `planRelationsWrite` → `lib/relationsWrite.ts` (new); route-to-route imports (assessment §2.4) replaced by lib imports | typecheck; unit suite; `tests/routeTable.test.ts` proves the mounted method+path set is unchanged | revert | — |

Provisioning: none. Gate to Phase 1: none (Phase 1 is dark and independent).

---

## Phase 1 — Foundation, fully DARK (nothing live changes) — fully specified

Deliverables: monorepo layout, platform kit, contracts, dark core, dark gateway with a parity corpus, the core's outbox and entrypoints, four leaf services dark, frontend code splitting, deploy tooling. **Zero production infrastructure change**: the only new resources are `*-dark` Workers and D1/R2 named `*-dark`, created by the new workflow (the token is proven to create D1/R2 and deploy Workers — `deploy-staging.yml` and `deploy-staging-code.yml`; creating a *new Worker name* is proven or disproven by the first run of slice 1.4 — if it fails with a permission error, D1 is escalated and the owner creates the Worker in the dashboard once).

### 1.1 Monorepo layout (directories and file moves)

```
Levonis/
├── package.json                      # + "workspaces": ["packages/*", "services/*"]; root stays SPA (src/) + core (worker/)
├── wrangler.jsonc                    # + env.dark: name levonis-core-dark, D1 levonis-db-dark, R2 levonis-files-dark, same assets/vars/cron
├── worker/                           # legacy core, IN PLACE
│   ├── index.ts                      # unchanged in 1.1; 1.6 adds named entrypoint exports
│   ├── entrypoints/                  # (new, 1.6) IdentityEntrypoint.ts, LedgerEntrypoint.ts, CatalogEntrypoint.ts, OrdersEntrypoint.ts
│   ├── OWNERSHIP.tolerance.json      # (new, 1.2) foreign-table writes the core still performs, with removal phase
│   ├── lib/pricing.ts, priceGrid.ts, pinnedPrices.ts, cheapestBase.ts, shippingType.ts, paymentPolicy.ts
│   │                                 # become one-line re-exports of packages/pricing (pure code; tests/pricing*.test.ts pin behaviour)
│   ├── lib/shipping.ts, iraqGovernorates.ts   # re-export packages/shipping
│   └── routes/, lib/                 # everything else as today
├── migrations/                       # single stream; 0055_ledger_keys.sql (Phase 0), 0056_core_outbox.sql (1.6) — header names the owning service
├── packages/
│   ├── platform-kit/                 # (new) package.json "@levonis/platform-kit"
│   │   └── src/ log.ts correlation.ts principal.ts hop.ts rpc.ts httpx.ts db.ts outbox.ts bus.ts consumer.ts
│   │            idempotency.ts config.ts ratelimit.ts health.ts saga.ts scope.ts realtime.ts process.ts
│   │            edge/hosts.ts edge/securityPolicy.ts edge/middleware.ts edge/capabilities.ts
│   │            # edge/* are COPIES of worker/lib/hosts.ts, securityPolicy.ts, http.ts:57-104 (originCheck, securityHeaders, requireMainHost);
│   │            # tests/edgeParity.test.ts asserts byte-equality until Phase 3.3 turns the core files into re-exports
│   ├── contracts/                    # (new) "@levonis/contracts"
│   │   └── src/ envelope.ts subscriptions.ts events/v1/<EventType>.ts events/fixtures/*.json
│   │            rpc/ledger.ts rpc/identity.ts rpc/catalog.ts rpc/orders.ts rpc/consumer.ts rpc/notifications.ts rpc/audit.ts
│   │            http/<service>.ts   # response types shared with src/ (type-only)
│   ├── pricing/                      # (new) pure: pricing.ts priceGrid.ts pinnedPrices.ts cheapestBase.ts shippingType.ts paymentPolicy.ts (+ price parts of productOverlay.ts stay in the core until 5.1)
│   └── shipping/                     # (new) pure quote engine: shipping.ts iraqGovernorates.ts
├── services/
│   ├── gateway/        wrangler.jsonc package.json OWNERSHIP.json SECRETS.md src/{index.ts,routes.ts,capabilities.ts,pipeline.ts,cache.ts,limiter.ts,principal.ts} tests/
│   ├── audit/          wrangler.jsonc migrations/0001_audit.sql src/{index.ts,rpc.ts,consumers.ts,http/admin.ts,store/}
│   ├── analytics/      wrangler.jsonc migrations/ src/{index.ts,consumers.ts,rollups.ts,rpc.ts,http/admin.ts,store/}
│   ├── ads/            wrangler.jsonc migrations/ src/{index.ts,consumers.ts,registry.ts,providers/{meta.ts,google.ts,tiktok.ts,snapchat.ts,noop.ts},http/admin.ts,store/}
│   └── notifications/  wrangler.jsonc migrations/ src/{index.ts,rpc.ts,consumers.ts,transports/{email.ts,telegram.ts},http/{public.ts,admin.ts,webhook.ts},store/}
├── src/                              # SPA; 1.8 lazy panels + manualChunks
├── scripts/
│   ├── gateway-parity.mjs            # (new) replay a recorded corpus against two base URLs; diff status/headers/body
│   ├── lib/preserve-vars.mjs         # (new) extracted from prepare-deploy-config.mjs:194-258
│   ├── resolve-ids.mjs upload-secrets.mjs probe-health.mjs worker-name.mjs   # (new) used by _deploy-worker.yml
│   └── (all existing scripts unchanged)
├── tests/                            # + serviceBoundaries, leastPrivilege, ownership, eventSchemas, routeTable, gatewayRoutes,
│                                     #   gatewayCapabilities, edgeParity, bundleBudget, checkoutSaga (7.1) .test.ts
└── .github/workflows/
    ├── _deploy-worker.yml            # (new) reusable
    ├── svc-gateway.yml svc-audit.yml svc-analytics.yml svc-ads.yml svc-notifications.yml svc-core-dark.yml   # (new)
    ├── verify-dark.yml               # (new) deploys the dark stack from a branch, seeds, runs the corpus through the gateway
    └── (all 29 existing workflows unchanged in purpose)
```

Each service package: `package.json` (`@levonis/svc-<name>`), `tsconfig.json` extending `worker/tsconfig.json` settings, `wrangler.jsonc` (top-level = production with `workers_dev: false`; `env.dark`), `src/index.ts` exporting `default class extends WorkerEntrypoint` (`fetch` = Hono app, RPC methods, `scheduled`, `queue`), `src/http/{public,admin}.ts`, `src/rpc.ts`, `src/consumers.ts`, `src/store/*.ts` (repository layer: D1 today, PostgreSQL later), `OWNERSHIP.json` (`owns`, `reads`, `calls`, `publishes`, `consumes`, `secrets`, `legacyRoutes`), `SECRETS.md` (names only), `tests/`.

### 1.2–1.9 Slices

| Slice | Scope | Gate | Rollback | Needs |
|---|---|---|---|---|
| 1.1 | Monorepo layout above; `packages/pricing` and `packages/shipping` extracted with the core files as re-exports; root `npm run check` iterates workspaces (pattern of `scripts/check-studio.mjs`); `tsconfig` paths | `npm run check`, `npm run test:unit` green; `npm run build` output byte-identical for the SPA; `tests/pricing.test.ts`, `pricingLadder.test.ts`, `priceGridAgreement.test.ts`, `shipping.test.ts`, `shippingType.test.ts` pass from the new location | revert | — |
| 1.2 | Platform kit modules (list above): `log`, `correlation` (UUIDv7), `principal` (Ed25519 sign/verify via `crypto.subtle`), `hop`, `rpc` (client proxy: budget, retry-on-idempotent, breaker, ctx), `httpx` (`fetchWithBudget`, absorbs `lib/fetchGuard.ts`), `db` (`ownedDb`), `outbox` + `bus` (`RpcFanoutBus`, `QueueBus`), `consumer` (`defineConsumer`), `idempotency`, `config`, `ratelimit` (`rateLimitKey` moved, `tests/rateLimitKey.test.ts` still pins it), `health`, `saga`, `scope` (from `lib/adminScope.ts`), `realtime` (`NoopHub`), `process` (`CronSweepRunner`), `edge/*` copies; `worker/OWNERSHIP.tolerance.json` seeded from assessment §2.1 | unit tests per module; `tests/serviceBoundaries.test.ts`, `tests/leastPrivilege.test.ts`, `tests/ownership.test.ts`, `tests/edgeParity.test.ts` scaffolds green | n/a (no runtime yet) | — |
| 1.3 | Contracts: envelope, v1 schemas + fixtures for every event in `03-EVENTS.md` §2–3, `subscriptions.ts`, RPC interfaces (`LedgerApi`, `IdentityApi`, `CatalogApi`, `OrdersApi`, `EventConsumer`, `NotificationsApi`, `AuditApi`) | `tests/eventSchemas.test.ts` round-trips every fixture; a consumer cannot be listed in `subscriptions.ts` for an event without a schema | n/a | — |
| 1.4 | **Dark core**: `env.dark` in `wrangler.jsonc`; `svc-core-dark.yml` creates `levonis-db-dark` + `levonis-files-dark` if missing (as `deploy-staging.yml:47-60` does), applies `migrations/`, deploys `levonis-core-dark`, seeds via `scripts/api-tests.mjs` (creates its own users/orders) | `scripts/api-tests*.mjs` green against the dark URL | delete the dark Worker/D1/R2 | new D1 + R2 (dark); proves new-Worker-name capability (D1) |
| 1.5 | **Dark gateway**: `services/gateway` — routing table (`01-TARGET.md` §3.3, every row → `CORE`), `classifyHost`, `originCheck`, security headers, correlation, request validation, 410 stubs, memory limiter layer, capability table (allow-all in dark until 0.3 lands, then enforced), Cache API allowlist, `ROUTE_OVERRIDES` kill switch; deployed as `levonis-gateway-dark` with `services: [{binding:'CORE', service:'levonis-core-dark'}]`, `workers_dev: true` | `scripts/gateway-parity.mjs`: a recorded corpus of ≥300 requests (from `scripts/api-tests*.mjs` + `e2e-subdomains.mjs` + `e2e-security-headers.mjs`) replayed against the gateway URL and the core URL must match on status, headers (minus `Server-Timing`/`x-correlation-id`) and body; `tests/gatewayRoutes.test.ts` (every `worker/index.ts` mount resolves once); `tests/hosts.test.ts`, `tests/securityPolicy.test.ts` | delete the dark Worker | — |
| 1.6 | **Event bus in the core + named entrypoints**: `migrations/0056_core_outbox.sql` (new: `core_outbox_events`, `core_outbox_deliveries`, `pump_lock`); `lib/audit.ts` becomes a facade that writes an `AuditRecorded` outbox row **in addition to** `audit_log` (dual-write); emitters added inside existing batches for `UserCreated` (`auth.ts`), `OrderCreated`, `CheckoutStarted`, `OrderCancelled` (`orders.ts`), `OrderStatusChanged`, `OrderDelivered` (`orderStageOps.ts`), `PaymentAuthorized/Completed/Failed` (`walletOps.ts`, `pointsOps.ts`), `RefundCompleted` (`returns.ts`, cancel paths), `InventoryChanged` (`inventory.ts`), `AddToCart` (`cart.ts`), `ProductViewed` sampled (`products.ts`), `ProductUpserted`, `PriceChanged` (`adminProducts.ts`, `adminPriceGrid.ts`), `ReferralUsed`, `SubscriptionChanged` (`membershipOps.ts`, `memberships.ts`); pump via `waitUntil` + cron step 0 in `lib/jobs.ts`; `worker/entrypoints/*.ts` export `IdentityEntrypoint` (`resolveSession`, `lookupUsers`, `revoke`, `getPublicKeys`, `redeemHandoff`, `introspect`), `LedgerEntrypoint` (the `LedgerApi` over `walletOps`/`pointsOps`), `CatalogEntrypoint`, `OrdersEntrypoint` (read-only methods first); `Env` gains optional bindings (`AUDIT?`, `ANALYTICS?`, `ADS?`, `NOTIFICATIONS?`) so the code runs with or without them; consumers bound only in `env.dark` | statement-composition unit tests; `tests/routeTable.test.ts` unchanged; dark: place an order → events appear in consumers; a boot test asserts the core starts with today's binding set (bindings absent → outbox rows accumulate, nothing else changes) | revert code; tables stay | migration `0056` goes live only in Phase 2 via workflow 7 |
| 1.7 | **Leaf services (dark)**: `levonis-audit-dark` (own D1 `levonis-audit-db-dark`; `audit_events` hash chain; `deliver`, `query`); `levonis-analytics-dark` (own D1; `analytics_events`, daily rollups, `overview`, `merchantDaily`); `levonis-ads-dark` (own D1; four adapters in sandbox + `noop`, `ads_event_map` seed, consent snapshots, kill switches); `levonis-notifications-dark` (own D1 with a `notify_outbox` copy of the `outbox` shape, `user_notifications` copy, `notify_deliveries`; transports moved from `lib/outbox.ts`/`lib/telegramTransport.ts` with the same Resend `Idempotency-Key` = `event_key` semantics; consumers for `UserCreated{verify}`, `OrderCreated`, `DepositDecided`, `RequestPublished`; webhook ingress with `telegram_updates` dedup and routing stubs; cron `* * * * *`; dark secrets only, email allowlist on) | each service's unit tests (`tests/emailTemplates.test.ts`, `tests/walletNotify.test.ts` moved with the transport); dark end-to-end: order on the dark core → `OrderCreated` reaches Audit/Analytics/Ads/Notifications with `processed_events` rows; replay proves idempotency; chain verification | delete the dark Workers | 4 dark D1s |
| 1.8 | **Frontend code splitting** (no API change): lazy admin panels (`src/pages/Admin.tsx:5-26`), route-level lazy pages, Vite `manualChunks`, per-language translations, `tests/bundleBudget.test.ts` | `npm run build`; `scripts/e2e-ui.mjs`; budget test; `tests/store-isolation.test.ts` | revert | — |
| 1.9 | **Deploy tooling**: `_deploy-worker.yml` + `svc-*.yml` for the six dark Workers; `verify-dark.yml`; `tests/workflowNaming.test.ts` extended (each new file names its Worker, says `DARK … serves no domain` or `LIVE`, no `-staging` in a new Worker name, unique number prefix); `docs/WORKERS.md` gains the dark table | workflow runs green | delete workflows | none live |

Phase 1 exit criteria: the dark stack (gateway → core → four consumers) passes the full corpus with parity to the core alone; the owner has seen the Audit chain, Analytics overview and Ads sandbox deliveries on dark. **G1**.

---

## Phase 2 — First light: the live core starts publishing (bindings only; no routes)

| Slice | Scope | Gate | Rollback | Needs |
|---|---|---|---|---|
| 2.1 | Production `levonis-audit`, `levonis-analytics`, `levonis-ads`, `levonis-notifications` (no routes, `workers_dev:false`, own production D1s); Notifications holds **copies** of `EMAIL_*`/`TELEGRAM_*` secrets but delivery stays off (`NOTIF_DELIVERY=off`) so the core's outbox remains the only sender | `/health` probes via the deploy workflow | delete Workers | **G5** (4 production D1s); secrets entered by the owner (names only in the repo) |
| 2.2 | Workflow 7 deploys the core with additive `services` bindings (`AUDIT`, `ANALYTICS`, `ADS`, `NOTIFICATIONS`) in `env.staging` and migrations `0055`/`0056` — the first change to the live Worker's bindings | live read-only probes; Audit chain grows while `audit_log` is still written; `analytics_events` fills | redeploy the core without the bindings (workflow 7, previous commit); tables stay | **G2** |
| 2.3 | Notifications takes over in-app inbox writes from `routes/printRequests.ts:495-525` via `RequestPublished` (the `notifyStatement` stays until rows are verified equal for a day) | row comparison | flag | — |
| 2.4 | Studio SSO over binding: `studio/wrangler.jsonc` gains `services: [{binding:'IDENTITY', service:'levonis-staging', entrypoint:'IdentityEntrypoint'}]`; `redeem/introspect` via RPC with a hop envelope; the public HTTPS path + `STUDIO_HANDOFF_SECRET` kept one release as fallback | `verify-studio-live.yml`, `verify-live-auth.yml` | Studio config revert | workflow 8 run |

---

## Phase 3 — Gateway cut-over (the one route change)

| Slice | Scope | Gate | Rollback | Needs |
|---|---|---|---|---|
| 3.1 | Production `levonis-gateway` bound to `CORE=levonis-staging` and `IDENTITY=levonis-staging#IdentityEntrypoint`; smoke on its workers.dev URL (read-only paths) against the live core, then `workers_dev:false` | GET-only parity corpus vs live | delete | owner approval for the Worker |
| 3.2 | **Cut-over**: the owner moves the zone routes `levonis-iq.com/*`, `www.levonis-iq.com/*`, `*.levonis-iq.com/*` (and any custom domain) from `levonis-staging` to `levonis-gateway` in the dashboard, off-peak; the core keeps every binding and serves everything; Studio's exact-host route untouched | workflow 7's probe list + `verify-subdomains.yml` + `verify-live-auth.yml` + `verify-live-security-headers.yml`; 24-h error-rate watch; cookie/login/logout on apex and a merchant host; Telegram webhook (posts to the apex, now via the gateway); gateway added latency p95 < 150 ms | **route back to `levonis-staging`** (minutes); nothing else to undo | **G3 (owner action)** |
| 3.3 | Gateway takes authority: security headers, rate classes (memory layer; `admin-write`, `public-read` previously unlimited), cache allowlist (30 s), 410s, capability enforcement (host + role + scope); the core keeps its checks (defence in depth) and its edge libs become re-exports of the platform kit | probes; `scripts/e2e-admin-reach.mjs`, `e2e-permissions.mjs` | disable per feature flag on the gateway | — |
| 3.4 | Disconnect the Workers Builds Git integration on `levonis-staging` (SUBDOMAIN_ARCHITECTURE.md §7.5.3) — safe now that workflow 7 is the only deployer behind the gateway | — | reconnect | **G3 (owner action)** |

---

## Phase 4 — Leaf services take their routes

Each slice: deploy dark → production → flip one gateway prefix → observe → next. Files move verbatim first, platform-kit adapters second. Data stays in the shared D1 (own tables) unless the row says own D1.

| Slice | Service | Files moved | Seam / RPC | Data | Gate | Rollback |
|---|---|---|---|---|---|---|
| 4a | Farm | `routes/farm.ts`, `routes/farmAdmin.ts`, `lib/farm/*` | flip `/api/farm/*`, `/api/admin/farm/*`; `printerFarmConfig` via `CONFIG` (core's settings RPC until 4h); display names via `IDENTITY.lookupUsers` | shared (own tables) → own D1 later, triggers of `0053`/`0054` re-created | `scripts/e2e-farm.mjs`, `tests/farm*.test.ts` | flip back |
| 4b | Notifications inbox + Telegram webhook | `routes/notifications.ts`, `routes/telegram.ts` webhook + admin branches, transports; webhook fan-out: `callback_query` → `answerCallbackQuery` first, then `LEDGER.decideDeposit` (core entrypoint); identity commands → `IDENTITY.telegramUpdate` | flip `/api/notifications/*`, `/api/telegram/webhook`, `/api/telegram/admin/*`; `NOTIF_DELIVERY=on`; the core's `enqueue()` keeps its signature and forwards to `NOTIFICATIONS.send`; core cron steps 1/8 disabled by `LEGACY_DISABLED_STEPS` | `outbox`, `user_notifications`, `telegram_updates` | `tests/walletNotify.test.ts`, `tests/telegram.test.ts`, `telegram-webhook.yml` diagnose | flip back; `NOTIF_DELIVERY=off`; clear the var |
| 4c | Files | `routes/uploads.ts`; chat authz via `CHAT.canReadChatFile` (core entrypoint until 4f); receipts via `LEDGER.receiptOwner`; `/api/admin/media/ingest` orchestration with `waitUntil` chunks | flip `/api/uploads`, `/files/*`; `file_objects` (new) | none owned today | `scripts/e2e-images.mjs` | flip back |
| 4d | Invoices, KYC | `routes/invoices.ts`, `lib/invoices.ts` (consumer of `OrderCreated`; `createInvoiceForOrder` is replay-safe); `routes/kyc.ts`, `lib/sealbox.ts` with `KYC_ENC_KEY` uploaded to KYC and removed from the core after one release | flips `/api/invoices/*`, `/api/kyc/*`; checkout's `createInvoiceForOrder` call (`orders.ts:1556`) replaced by the consumer | `invoices`; `kyc_cases`, `approved_addresses` | `scripts/e2e-receipts.mjs`, `tests/sealbox.test.ts` | flip back; key still on the core for one release | **G4** |
| 4e | Policies | `routes/policies.ts`, `lib/policyOps.ts`; checkout calls `POLICIES.requiredForCheckout/recordAcceptance` | flip `/api/policies/*` | `policy_*` | `tests/policyDrafts.test.ts` | flip back |
| 4f | Chat | `routes/chats.ts`; authz via `ORDERS.canAccessOrder`, `MARKETPLACE.merchantOf` (core entrypoints); denormalised `last_message_at`, `unread_count` (additive) | flip `/api/chats/*` | `chat_*` | chat e2e in `scripts/api-tests-v3.mjs` | flip back |
| 4g | Support, Invest | `routes/support.ts` tickets (read models over core entrypoints), `routes/invest.ts` + `admin.ts:1855-1978` (N+1 fixed with `IN`) | flips | own tables | `tests/support.test.ts` | flip back |
| 4h | Config | `lib/settings.ts` → `services/config`; the core's `getSetting/setSetting` become RPC clients with a 30-s memo; raw writers/readers (`adminCommunity.ts:131`, `lib/telegram.ts:118`, `entitlements.ts:55`, `pointsOps.ts:282`, `escrowOps.ts:83`, `merchantOps.ts:128,189`, `marketplace.ts:436`, `reviews.ts:108`) routed through the client; `settings.ts:2-6` import inversion; `SettingChanged`; `PUBLIC_SETTING_KEYS` verbatim | flip `GET /api/settings/public`, `/api/admin/settings*` | `admin_settings` | settings tests | flip back |
| 4i | Search | new `services/search` (own D1, FTS5 `search_products`, `search_stores`); fed by `ProductUpserted`/`ProductArchived`/`PriceChanged`/`MerchantStatusChanged` + backfill via `CATALOG.listForIndex(cursor)` (core entrypoint); `GET /api/products?q=` in the core calls `SEARCH.products()` behind a flag | new `GET /api/v1/search` | own D1 | index parity test vs `LIKE` results on the corpus | flag off |
| 4j | Risk | new `services/risk` (own D1 `risk_*`); `restriction_cases` code moves (table stays in the shared D1, owner = Risk); `entitlements.ts:95` reads via `RISK.flagsOf`; consumers of `DepositRequested`, `WithdrawalStateChanged`, `OrderCreated`, `RateLimitHit`, `TurnstileFailed` | flip `/api/support/admin/restrictions*`; `RiskFlagRaised` | own D1 + `restriction_cases` | unit tests | flip back |

Gates: **G4**, **G5** per own-D1 service; per-slice kill switch. The core route files stay in place behind the `CORE` fallback.

---

## Phase 5 — Catalog deployable

| Slice | Scope | Gate | Rollback |
|---|---|---|---|
| 5.1 | `services/catalog` read routes only (`GET /api/products*`, `/api/home`, `/api/bundles`) over the shared D1 (own tables) + `SUBSCRIPTIONS.getTier` (core entrypoint) + `CONFIG`; `packages/pricing` pinned; the price parts of `lib/productOverlay.ts` move into the pricing package | read-route parity corpus; flip GET prefixes only (the gateway routes by method) | flip back |
| 5.2 | Admin writes: `adminProducts`, `adminProductRelations`, `adminPriceGrid`, `adminTaxonomy`, bundles admin, `template`, `adminImport` (job id + poll, additive); product save = one batch + outbox `ProductUpserted` | `scripts/e2e-product-form.mjs`, `e2e-product-template.mjs`, `e2e-quick-price.mjs`, `e2e-taxonomy.mjs`, `e2e-import.mjs`, `tests/publicProjection.test.ts` | flip back |
| 5.3 | `InventoryEntrypoint` (`reserve/deduct/release/restore/adjust`) exposed; Fulfilment/Returns/admin adjust call it; **B1 keeps its stock statements** (tolerance entry until 7.1) | `tests/inventory.test.ts`, `orderInventory.test.ts` | — |
| 5.4 | Duplicate taxonomy CRUD in `adminProducts.ts:315-507` delegates to `adminTaxonomy`; `HashtagRenamed` event; KV `catalog_version` cache key | tests | revert |

---

## Phase 6 — Near-core services (money via `LEDGER` = the core's `LedgerEntrypoint`)

| Slice | Service | Saga / command replacement | Gate | Rollback |
|---|---|---|---|---|
| 6a | Marketplace + Merchants | store checkout (B4): `LEDGER.hold(key store:<idem>)` → `ORDERS.createMerchantOrder` (core entrypoint, idempotent on `orders.idempotency_key`) → local batch (`merchant_coupons`, `community_products` stock, payout pending) → `LEDGER.commitHoldAndDebit`; compensation `releaseHold`; escrow accept/release/refund (B6/B14) via Ledger commands with existing keys; merchant status (B5) → `ORDERS.applyStatus` + local ledger/reputation batch; `refreshMerchantRating` inside; the missing auto-complete/expiry job added; storefront caching enabled after checking user-dependent fields | `tests/escrow.test.ts` (buyer balance), `tests/merchantOps.test.ts`, `scripts/e2e-print-request.mjs`, `e2e-subdomains.mjs`; flip all marketplace/merchant prefixes | flip back (same tables, same keys) |
| 6b | Subscriptions | B9 → `hold → INSERT memberships → commitHoldAndDebit` (key `wtx_membership_<id>`; partial UNIQUE `0052_memberships_one_active.sql:60` keeps one-active); expiry via cron + `SubscriptionChanged`; write-on-read into `users` removed (Identity consumes the event); `getTier` RPC replaces `entitlements.getTierStatus` imports (core keeps a client shim) | `tests/membershipsSubscribe.test.ts`, `membershipsConcurrency.test.ts`, `scripts/e2e-subscription.mjs` | flip back; shim stays |
| 6c | Referrals | consumer of `UserCreated` (replaces `auth.ts:206-221`), `Order*`, `SubscriptionChanged`, `ReturnApproved`; rewards via `LEDGER.credit`; `admin.ts:1509` → `REFERRALS.cancelRewardsForOrder` | `tests/referralFreeDelivery.test.ts`, `tests/supportCode.test.ts` | flip back |
| 6d | Reviews | B7 → `LEDGER.credit(key wtx_review_<id>)` (Ledger writes journal + `points_awards` atomically) then local `review_rewards`/gift rows; `review_media` (new) replaces the `LIKE` scan | `tests/reviews.test.ts` | flip back |

---

## Phase 7 — The checkout saga and the Commerce deployable

| Slice | Scope | Gate | Rollback |
|---|---|---|---|
| 7.1 | **Saga inside the core first** (`01-TARGET.md` §6.6): migration `0057_checkout_sagas.sql` (new); `placeOrder` rewritten as reserve → hold → local batch (with outbox) → commit; sweep every minute; `CHECKOUT_SAGA=on|off` selects saga vs legacy B1 per request (identical rows and ids) | `tests/checkoutPayment.test.ts`, `ordersCustomer.test.ts`, `walletSpendGuard.test.ts`, new `tests/checkoutSaga.test.ts` (crash injection at each step); `scripts/e2e-integrated.mjs`, `e2e-order-stages.mjs`, `e2e-coupons.mjs`; a week on dark, then live at 10% → 100% | flag off |
| 7.2 | Cancel/refund (B2/B3) → `ORDERS.cancel` → conditional flip + `LEDGER.refund` (keys unchanged) + `INVENTORY.restore` + `REFERRALS.cancelRewardsForOrder`; the sweep retries a refund whose flip succeeded (closes the stranded-credit gap); admin cancel gains the accrual/reservation handling of the customer path | tests | revert |
| 7.3 | `services/commerce` deployed (Cart, Checkout, Orders, Coupons, Refunds packages) over the shared D1 (own tables); tolerance entries for `wallet_*`, `points_*`, stock columns removed; the legacy B1 path stays in the core one release for rollback | full commerce e2e; flip `/api/cart/*`, `/api/orders/*`, `/api/returns/*`, `/api/price-protection/*`, `/api/admin/orders*`, `/api/admin/coupons/*` | flip back |
| 7b | Fulfilment (+ Shipping package) | `order_fulfilment` (new; backfilled lazily on first touch from the `orders` columns — no bulk migration), stage machine, delivery sync (concurrency 5), labels, receipts, own cron; `ORDERS.applyStage` for the legacy columns; `ALWASEET_*` move (**G4**) | `tests/orderStages.test.ts`, `deliverySync.test.ts`, `scripts/e2e-order-stages.mjs`, `e2e-order-fulfilment.mjs` | flip back |
| 7c | Devices & Warranty | consumer of `OrderDelivered` (replaces inline `deliveredEffects`, `admin.ts:788-831`); B11 stays a local batch; `products.ops_policy` via `PRODUCTS.setOpsPolicy` | `tests/deviceRegistration.test.ts`, `tests/warranty.test.ts`, `scripts/e2e-warranty.mjs` | flip back |

---

## Phase 8 — Money core on its own Worker

| Slice | Scope | Gate | Rollback |
|---|---|---|---|
| 8.1 | `services/ledger` (Ledger, Wallet, Payments, Loyalty packages; wallet admin; Telegram approval decision half) over the shared D1 (own tables); every `LEDGER` binding re-pointed from `levonis-staging#LedgerEntrypoint` to `levonis-ledger` — a config change per caller; `ledger_balances` + `ledger_idempotency` (migration `0058`, new); core cron steps 7–9 disabled by var | `tests/walletOps.test.ts`, `points.test.ts`, `scripts/e2e-wallet.mjs`; reconciliation clean for 7 days on dark; flip `/api/wallet/*`, `/api/rewards/*`, `/api/admin/wallet*` | re-point bindings to the core entrypoint (identical code) |
| 8.2 | `WALLET_LOCK` DO when provisioned; `Serializer` adapter switched | contention test | flag |
| 8.3 | PostgreSQL via Hyperdrive for the `ledger` schema: `PgLedgerStore`; dual-write journal (D1 truth) → verify → switch truth → D1 read-only | reconciliation equality for 14 days | switch truth back to D1 (dual-write kept) | **G6 + separate data-migration approval** |

---

## Phase 9 — Identity and the end of the core

| Slice | Scope | Gate | Rollback |
|---|---|---|---|
| 9.1 | `services/identity` over the shared D1 (own tables); `IDENTITY` bindings re-pointed; gateway `PRINCIPAL_MODE=shadow` (computes and compares with the core's `loadSessionUser` result, logging mismatches) → `on` per route class | `tests/telegramAuth.test.ts`, `registerEmailFirst.test.ts`, `authProviders.test.ts`, `verify-live-auth.yml`; shadow mismatch rate 0 for a week | `PRINCIPAL_MODE=off`; re-point binding |
| 9.2 | Cookie forwarded only to Identity; services drop `loadSessionUser`; `users` writers outside Identity replaced (`admin.ts:298` → `IDENTITY.setRole`); Studio's fallback HTTPS path and `STUDIO_HANDOFF_SECRET` removed on both sides | least-privilege test: no service but Identity references `users`/`sessions` | — |
| 9.3 | Admin BFF package in the gateway (`/api/admin/overview`, `/api/admin/users*`, `/api/admin/providers`) over RPC read models; gateway takes the `assets` block (`dist/_headers` unchanged) | probes | flip to CORE |
| 9.4 | KYC → PostgreSQL `kyc` schema + private R2 bucket (if the owner prefers KYC before Ledger, this slice moves ahead of 8.3) | `tests/sealbox.test.ts`; dual-read | switch back | **G6** |
| 9.5 | Core retirement: `routes/admin.ts` empty, tolerance list empty, gateway default route → 404; `levonis-staging` kept deployed without traffic for one release, then deleted; `docs/WORKERS.md` rewritten | live probes | re-point default route to CORE | **G7** |

### Later (config switches, not phases)
Queues (`EVENT_BUS_MODE=queue`), DO-backed Cart/Inventory/Chat/Realtime, Workflows (`01-TARGET.md` §8), KV for config/tier/cache version/flags, `ratelimits` bindings, Analytics Engine sink, merchant custom domains (Cloudflare for SaaS, D18).

---

## 10. Resolution of every cross-domain batch (assessment §2.2)

| # | Today | Resolution | Phase |
|---|---|---|---|
| B1 | checkout 7-domain batch | saga (§6.6 of the target); coupons/cart/settlements stay local in Commerce | 7.1 |
| B2 | customer cancel: flip, then wallet+points batch | `ORDERS.cancel` → conditional flip + `LEDGER.refund` + `INVENTORY.restore` + `REFERRALS.cancelRewardsForOrder`; sweep retries | 7.2 |
| B3 | admin cancel | same command with `actor=admin`; gains accrual/reservation handling | 7.2 |
| B4 | store checkout: hold / batch / commit non-atomic | saga in Marketplace: hold → `ORDERS.createMerchantOrder` → local batch → `commitHoldAndDebit` | 6a |
| B5 | merchant status batch | `ORDERS.applyStatus` first, then local batch; `OrderStatusChanged` feeds the rest | 6a |
| B6 | marketplace confirm after 3-phase escrow release | `LEDGER.commitHoldAndDebit` (buyer) + local payout/reputation batch; saga with sweep | 6a |
| B7 | review + points + ledger | `LEDGER.credit(key wtx_review_<id>)` then local rows; replay-safe both sides | 6d |
| B8 | mission claim + ledger + `users.checkin_streak` | inside the Ledger deployable (Loyalty package) — stays one batch; streak → `mission_streaks` | 0.5 / 8 |
| B9 | membership purchase | hold → INSERT membership → `commitHoldAndDebit` | 6b |
| B10 | points release | inside the Ledger deployable — stays a batch | 8 |
| B11 | device replace | inside Devices — stays a batch | 7c |
| B12 | publish request + notification | outbox `RequestPublished` in the marketplace batch → Notifications consumer (dedup `0045_print_requests.sql:68`) | 2.3 / 4b |
| B13 | Telegram signup | inside Identity — stays a batch | 9 |
| B14 | escrow hold then escrow rows | `LEDGER.hold` (idempotent) then local batch; orphan hold released by the saga sweep after 2 min | 6a |
| B15 | admin community fee settings | `CONFIG.set` per key with validators; `SettingChanged` | 4h |
| B16 | stage machine → orders + history + inventory | Fulfilment local + `ORDERS.applyStage` + `INVENTORY.deduct/return(opId)`; `StageChanged` | 7b |

---

## 11. Boundaries test (sketch)

```ts
// tests/serviceBoundaries.test.ts (new)
for (const svc of services()) {
  const manifest = readJson(`services/${svc}/OWNERSHIP.json`);           // { owns, reads, calls, secrets, ... }
  for (const file of tsFiles(`services/${svc}/src`)) {
    const src = read(file);
    for (const table of tablesInSqlLiterals(src))
      assert.ok(manifest.owns.includes(table) || manifest.reads.includes(table), `${svc}: ${file} touches ${table}`);
    assert.ok(!/from ['"](\.\.\/)+(services|worker)\//.test(src), `${svc}: ${file} imports another service or the core`);
    assert.ok(!/\bfetch\(/.test(src), `${svc}: ${file} uses bare fetch — use fetchWithBudget`);
  }
}
const tolerance = readJson('worker/OWNERSHIP.tolerance.json');
const snapshot  = readJson('tests/fixtures/tolerance.snapshot.json');
for (const e of tolerance) assert.ok(snapshot.some((s) => s.table === e.table && s.writer === e.writer), `new tolerance entry ${e.table} by ${e.writer}`);
```

Initial tolerance list (from Phase 5, when Catalog is the first non-core owner of core-touched tables): stock columns of `products`/`product_option_values`/`product_colors`/`product_variants` by `routes/orders.ts` (B1, removed 7.1); `wallet_transactions`, `wallet_holds`, `points_*` by `routes/orders.ts`, `routes/admin.ts`, `routes/returns.ts` (removed 7.1/7.2); `orders` by `routes/storeOrders.ts`, `routes/merchant.ts` (removed 6a), by `lib/orderStageOps.ts`, `lib/delivery/sync.ts` (removed 7b); `users` by `lib/entitlements.ts` (removed 6b), `routes/rewards.ts` (removed 0.5), `routes/admin.ts` (removed 9.2).

---

## 12. Reusable deploy workflow (skeleton)

```yaml
# .github/workflows/_deploy-worker.yml (new)
on:
  workflow_call:
    inputs: { service: {type: string, required: true}, env: {type: string, required: true} }   # env: dark | production
jobs:
  deploy:
    runs-on: ubuntu-latest
    env: { CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}, CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }} }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci --no-audit --no-fund && (cd studio && npm ci --no-audit --no-fund)
      - run: npm run check && npm run test:unit                                   # boundaries, least-privilege, schemas, naming included
      - run: node scripts/resolve-ids.mjs --service ${{ inputs.service }} --env ${{ inputs.env }}       # D1 ids by NAME (wrangler d1 list --json); dark auto-creates
      - run: node scripts/lib/preserve-vars.mjs --worker $(node scripts/worker-name.mjs ${{ inputs.service }} ${{ inputs.env }}) > /tmp/vars.tsv   # refuse to deploy blind, as workflow 7
      - run: npx wrangler d1 migrations apply <db-name> --remote -c services/${{ inputs.service }}/wrangler.jsonc --env ${{ inputs.env }}   # migrations BEFORE code; skipped when the service has no DB
      - run: npx wrangler deploy -c services/${{ inputs.service }}/wrangler.jsonc --env ${{ inputs.env }} $(node scripts/vars-args.mjs /tmp/vars.tsv)
      - run: node scripts/upload-secrets.mjs --service ${{ inputs.service }} --env ${{ inputs.env }}   # only names in SECRETS.md, from repo secrets <SVC>__<NAME>; unset = untouched
      - run: node scripts/probe-health.mjs --service ${{ inputs.service }} --env ${{ inputs.env }}
      - run: node scripts/integration.mjs --service ${{ inputs.service }} --env dark                   # dark only: corpus subset + parity
```

`svc-<name>.yml` files carry the worker-truth banner, call the reusable workflow with `env: dark` (display `2x - Deploy DARK levonis-<name>-dark (serves no domain)`) or `env: production` (display `3x - Deploy LIVE levonis-<name>`, confirmation `DEPLOY-<NAME>-LIVE`); `tests/workflowNaming.test.ts` gains the rows and the rule that a new Worker name never contains `staging`.

---

## 13. Owner decisions, provisioning, accepted risks

### 13.1 Decisions (D) referenced above

| # | Decision | Needed by |
|---|---|---|
| D1 | Confirm the Workers Paid plan; confirm the CI token can create new Worker names (first run of 1.4 proves it), and — when asked — KV namespaces, Queues, DO namespaces, Workflows, Hyperdrive configs. We never widen the token (constraint 8); missing scopes mean the owner creates the resource in the dashboard and the workflow binds by name/id. | 1.4, 2.1 |
| D2 | Approve the dark stack: `levonis-core-dark`, `levonis-gateway-dark`, four leaf dark Workers, `levonis-db-dark`, `levonis-files-dark`, four dark D1s. Zero effect on the live zone. | Phase 1 |
| D3 | Naming: `levonis-<service>` / `levonis-<service>-dark`; `levonis-staging` and `levonis-studio-staging` keep their names. | Phase 1 |
| D4 | Re-point `2 - Rebuild levonis-staging + run API tests` (`deploy-staging.yml`) at the dark stack so test users never land in the live DB again. | 1.4 |
| D5 | Cron cadence: new Workers use their own crons (`* * * * *` pumps where needed); the live core keeps `*/15` plus `waitUntil` pumps. | 1.6 |
| D6 | Money P0: a committed purchase hold must debit the ledger; store-order cancellation refunds only via the merchant path; customer cancel refuses merchant orders; merchant self-attested delivery keeps making `sale_credit` available or requires customer confirmation (assessment Q6). | 0.1 |
| D7 | Store orders stay rows in `orders` (Orders exposes `createMerchantOrder`) — recommended, no data migration. | 6a |
| D8 | Retire with 410: `/api/admin/products` v1, `POST /api/translate` (+ its key), `POST /api/profile/warranty-claims`, `/api/admin/warranty-claims`; `/api/community/my-store*` and the legacy wallet decide after the SPA is repointed. | 0.8 |
| D9 | PostgreSQL provider/region for Hyperdrive; first tenant (Ledger or KYC); a **separate approval per data migration** (constraint 4). | 8.3 / 9.4 |
| D10 | KYC retention period and minimum age (DECISIONS row 24). | 4d+ |
| D11 | Telegram: one bot, one webhook → Notifications owns the URL and fans out (recommended), or a second bot for wallet approvals. The URL does not change at cut-over (same apex host). | 4b |
| D12 | Assistant admin scope: deny decrypted KYC, BNPL/support-360 money, wallet lists with destinations, investments, internal pricing settings (recommended yes; encoded in the capability table). | 0.3 |
| D13 | `users.membership_tier` becomes an Identity-owned read column fed by `SubscriptionChanged`; `checkin_streak` leaves `users`; splitting `users` into identity + profile tables is deferred (data migration). | 6b |
| D14 | Single origin confirmed: every service behind `levonis-iq.com/api/*`; no `api.` host; no CORS. | Phase 1 |
| D15 | Search/Analytics/Ads/Risk in scope: Analytics and Ads start in Phase 1; Search and Risk as real Workers in Phase 4 (own D1). Which Ads providers to enable first and who owns the provider accounts. | 1.7 / 4i–4j |
| D16 | Password reset through the outbox (adds the pump latency, seconds with `waitUntil`). | 0.7 |
| D17 | Al-Waseet: wire config + secrets to Fulfilment when the integration goes live; courier-delivered orders trigger `deliveredEffects` via `OrderDelivered` (recommended). | 7b |
| D18 | Merchant custom domains (Cloudflare for SaaS cost): the gateway classifier is ready for a `custom_hosts` lookup, not built until approved. | later |
| D19 | Marketing consent model (`marketing_consent` column, default `none`) and whether browser pixels are in scope (CSP change) — server-side conversions only by default. | 1.7 |
| D20 | `PurchaseCompleted` fires on `OrderCreated` for prepaid orders and on `OrderDelivered` for COD — confirm, since it decides what the ad platforms count as a sale. | Phase 2 |

### 13.2 Provisioning list (exact)

| Resource | Name | Phase | Who creates |
|---|---|---|---|
| D1 | `levonis-db-dark` | 1.4 | workflow (`wrangler d1 create`, proven scope) |
| R2 | `levonis-files-dark` | 1.4 | workflow (proven scope) |
| Workers | `levonis-core-dark`, `levonis-gateway-dark`, `levonis-{audit,analytics,ads,notifications}-dark` | 1.4–1.7 | workflow (`wrangler deploy` with new names; proves D1) |
| D1 | `levonis-{audit,analytics,ads,notifications}-db-dark` | 1.7 | workflow |
| Workers + D1 | `levonis-{audit,analytics,ads,notifications}` and `levonis-{audit,analytics,ads,notifications}-db` | 2.1 | workflow after G5 |
| Secrets | `EMAIL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ADMIN_CHAT_ID` on `levonis-notifications`; `IDENTITY_SIGNING_KEY` on the core (then Identity); `<SVC>_SIGNING_KEY` per Worker (generated in the workflow; private half uploaded, public half registered); `AUDIT_CHAIN_KEY`; `GATEWAY_SIGNING_KEY` | 2.1+ | workflow from repository secrets (names only in the repo) |
| Worker | `levonis-gateway` | 3.1 | workflow after owner approval |
| Zone routes / custom domains | move to `levonis-gateway` | 3.2 | **owner, dashboard** |
| Workers (+ dark twins) | `levonis-{farm,files,invoices,kyc,policies,chat,support,invest,config,search,risk}`; own D1 for `search`, `risk` (+ later `farm`, `chat`, `notifications`, `policies`, `invoices`) | 4 | workflow (G5 per production D1) |
| Workers (+ dark twins) | `levonis-{catalog,marketplace,subscriptions,referrals,reviews,commerce,fulfilment,devices,ledger,identity}` | 5–9 | workflow |
| Optional / later (each a config switch) | `ratelimits` namespaces; KV `FLAGS`, `GW_CACHE`, `CONFIG_KV`, `TIER_CACHE`, `CATALOG_CACHE`, `ADS_FLAGS`, `RISK_FLAGS`, `POLICY_CACHE`; Queues `levonis-events`, `levonis-events-dlq` (Paid plan); DO namespaces declared in the owning configs; Workflows; Hyperdrive configs + PostgreSQL; Analytics Engine dataset; Turnstile site; `images` binding for Files; Secrets Store | when D1 confirms scopes | workflow or owner |

### 13.3 Risks consciously accepted

1. **Shared D1 during Phases 4–8.** Isolation is by manifest + lint + runtime guard, not by the database. Accepted because moving data first violates constraint 4; mitigated by the shrinking tolerance list.
2. **B1 stays a cross-domain batch until 7.1.** By design — the safest place for it until the saga has passed crash-injection tests and a flagged rollout.
3. **Binding identity is account-level trust.** A compromised Worker on the account could call any RPC; hop envelopes + per-method allowlists + principal verification limit blast radius but are not network isolation.
4. **In-isolate caches** (principal 30 s, config 30 s, breaker state) are per isolate; revocations propagate within the TTL; KV/DO tighten this later.
5. **At-least-once, per-aggregate ordering only.** Consumers are idempotent; cross-aggregate ordering is not promised.
6. **RPC fan-out until Queues.** Latency depends on `waitUntil` pumps and cron; an outage accumulates a backlog in the producer's outbox (alert at 5 min lag).
7. **Dark ≠ production data.** Parity runs on seeded data; mitigated by shadow modes (`PRINCIPAL_MODE=shadow`, saga at 10%) and per-prefix rollback.
8. **Owner-gated waits** (G2, G3, G4, G5, G6). Dark slices always exist to fill the wait.
9. **Anonymous catalogue caching** may serve a 30–60 s stale price to a guest; checkout re-prices server-side, so no money impact.
10. **Two deployers on the live Worker until 3.4**; the assessment's race persists until the owner disconnects the Git integration.
11. **Merged deployables** (Catalog, Commerce, Ledger, Marketplace) until their split triggers; a bug in one package can affect the availability of its siblings; contracts and entrypoints are separate so the split is mechanical.
12. **`-staging` = live** naming stays for the two existing Workers; every new artefact avoids the suffix and the docs/tests pin the mapping.
