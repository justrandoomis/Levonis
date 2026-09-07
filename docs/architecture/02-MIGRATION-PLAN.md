# LEVONIS — Migration Plan (canonical)

Date: 2026-09-07. Base tree: `69ee814` — the Phase 0 hardening commit, which already contains slices 0.1–0.3 below (committed, **not yet deployed**: the live Worker runs an older commit until workflow 7 runs). Revision 2 folds in the three critiques (`04-DECISIONS.md` ADR-015–017). Target: `docs/architecture/01-TARGET.md`. Events: `03-EVENTS.md`. Decisions: `04-DECISIONS.md`. Nothing here is applied; every phase ends in gates, and every change to what serves `levonis-iq.com` is an owner approval named **G**. Provenance of the plan's ideas: `01-TARGET.md` Appendix A.

Names marked **(new)** do not exist yet. Every other file, table, route, test, script and workflow name exists in the tree. Tests key on symbol names, never on line numbers.

---

## الملخّص التنفيذي (بالعربية)

الخطّة تسع مراحل تُنفَّذ كشرائح من يوم إلى يومين، لكل شريحة بوّابة اختبار وتراجع معرَّف. **المرحلة ٠** تُصلح داخل النواة ما لا يجوز نسخه إلى خدمات جديدة (تثبيت الحجز مع الخصم، مسار قرار الودائع الواحد، حماية أسطح الإدارة السبعة، مفاتيح التكرار على الدفتر) دون أي تغيير في البنية. **المرحلة ١ مظلمة بالكامل**: نسخة معاينة من النواة بقاعدة فارغة، بوّابة معاينة أمامها، وأربع خدمات ورقية (Audit وAnalytics وAds وNotifications) بقواعد خاصّة، ومجموعة اختبار تقارن استجابة البوّابة باستجابة النواة طلبًا بطلب؛ لا يلمس شيء الموقع الحيّ.

**قبل كل شيء (G0)**: يفصل المالك تكامل Git الذي ينشر النواة الحيّة مع كل push بلا هجرات، وتُنشر تصحيحات المرحلة ٠ المُلتزَمة عبر workflow 7. **المرحلة ٢** تضيف روابط Service Bindings إلى النواة الحيّة فقط (بموافقة)، فتبدأ الأحداث بالتدفّق إلى الخدمات الورقية بلا أي مسار جديد. **المرحلة ٣** هي تغيير المسار الوحيد: يُضيف المالك مسارات `/api/*` و`/files/*` للنطاقات الثلاثة إلى البوّابة (النطاقات المخصّصة للجذر وwww تبقى على النواة، فتُخدَم الواجهة وأصولها كما اليوم بلا أي Worker)، والتراجع = حذف تلك المسارات في ثوانٍ. **المرحلة ٤** تنقل الخدمات الورقية إلى مساراتها واحدة واحدة (المزرعة، الإشعارات، الملفات، الفواتير، KYC، السياسات، المحادثة، الدعم، الاستثمار، الإعدادات، البحث، المخاطر، Studio عبر Binding)، والتراجع عن كل واحدة قلب بادئة في البوّابة.

**المرحلة ٥** الكتالوج (القراءة أولًا ثم الكتابة)، **٦** السوق والاشتراكات والإحالات والمراجعات عبر عقد الدفتر المعروض من النواة، **٧** Saga الشراء تُبنى داخل النواة خلف علم تشغيل مع اختبارات حقن الأعطال ثم Worker التجارة والتسليم والأجهزة، **٨** نواة المال في Worker خاص ثم PostgreSQL بموافقة منفصلة لنقل البيانات، **٩** الهويّة ووضع الظلّ لمبدأ التوقيع ثم إحالة النواة إلى التقاعد بموافقة. Queues وDurable Objects وWorkflows وKV وHyperdrive مفاتيح إعداد تُفعَّل عند توفّرها، وقائمة التزويد الدقيقة في §13.

---

## 0. Conventions

- **Slice** = 1–2 days for one developer, one PR, own gate, own rollback. Common gate for every slice: `npm run check` (typecheck + lint + boundaries/least-privilege/ownership/schema/naming tests), `npm run test:unit`, `npm run build` (+ bundle budget), `node scripts/migrate-check.mjs --twice` (+ additive classifier for `0055+`), the integration corpus against the dark stack (`scripts/api-tests*.mjs`, relevant `scripts/e2e-*.mjs`), and — after any production deploy — the read-only live probes (`0 - Diagnose Live Site` (`diagnose-live.yml`), `verify-live-guest.yml`, `verify-subdomains.yml`, `verify-live-security-headers.yml`, `verify-live-auth.yml`). **No next phase before regressions are fixed.**
- **Strangler seam** = the exact point where traffic is diverted (a gateway prefix, an RPC method, an event).
- **Rollback levels**: (a) revert PR / `wrangler rollback`; (b) gateway prefix → `CORE` (kill switch, seconds); (c) delete the six gateway `/api/*`,`/files/*` zone routes (seconds; the Custom Domains never move); (d) additive migrations never need a down-migration; (e) a var flip between two declared bindings (`LEDGER_TARGET`, Phase 8.1).
- **Owner gates**: **G0** the Workers Builds Git integration on `levonis-staging` is disconnected and the two-PR rule is in force (before any `0055+` code merges) · **G1** dark report accepted · **G2** bindings, vars/secrets, per-minute cron and migrations on the live core (the exact list is in 2.2) · **G3** the six zone routes added to `levonis-gateway`; `workers_dev:false` + `preview_urls:false` on the core · **G4** secrets move (email/Telegram → Notifications; `KYC_ENC_KEY` → KYC; `ALWASEET_*` → Fulfilment) · **G5** production D1 databases for own-store services · **G6** PostgreSQL + Hyperdrive, and a separate approval per data migration · **G7** core retirement · **D-numbers** = decisions listed in §13.
- **Two-PR rule (from G0 on)**: a migration ships in its own PR and is applied to the live database by workflow 7 **before** the PR that writes the new column or table merges; code that can run before its migration guards on table presence (`EVENT_BUS_ENABLED`, boot probe) and is tested for "table absent → no statement appended".
- **Migration numbers** are allocated in merge order; the plan pins the file *names*: `0055_ledger_keys` (0.4), `0056_core_outbox` (1.6), `0057_state_tables` (0.5: `username_changes`, `mission_streaks`, `product_imports.fingerprint`, `warranty_receipts` column), `0058_service_keys` (1.6, Identity-owned), `0059_checkout_sagas` (7.1), `0060_ledger_balances` (8.1). Every `0055+` header names its owner.
- Slice PR template (verbatim in every PR): *Scope · Strangler seam · Behaviour preserved (legacy paths still answering; parity test) · Gates run · Rollback · Needs provisioned · Owner gate · Vars/secrets flipped (who, where, propagation) · Verify workflow re-pointed*.

---

## Phase 0 — Hardening inside the core (no new Workers; ordinary workflow-7 deploys)

Purpose: fix the findings that would otherwise be copied into new services, and make the code movable. Runs in parallel with Phase 1. **Slices 0.1–0.3 landed in commit `69ee814`** (`commitHoldStatements`/`commitHold` in `walletOps.ts`, `escrowOps.ts`, `storeOrders.ts`; `requireAdmin` carrying the host rule in `lib/http.ts`; `POST /api/admin/wallet/credit` with scope + idempotency + rate limit; `lib/orderCancelOps.ts`; the legacy decide route delegating to `decideDeposit`; tests `walletHoldSettlement`, `adminHostGuard`, `adminWalletCredit`, `orderCancelAtomic`, `depositDecideGuard`, 30 new). They are **not yet on the live Worker**; slice 0.0 deploys them. The rows below describe what remains: verify on the live site and extend the tests.

| Slice | Scope (files) | Gate | Rollback | Needs |
|---|---|---|---|---|
| 0.0 | **G0 + first live deploy.** (i) The owner disconnects the Workers Builds Git integration on `levonis-staging` (SUBDOMAIN_ARCHITECTURE.md §7.5.3) — it deploys every push ~60 s later with **no migrations**, so from `0055` onward it would put schema-dependent code on the live database ahead of its migration (DECISIONS row 36); until the owner has done it, `scripts/prepare-deploy-config.mjs` is extended to fold `services`/`durable_objects`/`queues`/`kv_namespaces`/`ratelimits`/`workflows` as it folds `d1`/`r2`/`vars`, so a stray integration deploy cannot strip bindings either. (ii) Workflow 7 gains the generic `set_var NAME=VALUE` / `upload_secret NAME` inputs (`01-TARGET.md` §11.6; names validated against `wrangler.jsonc` and `worker/SECRETS.md`, new) and a per-phase CORE-owned probe path with a commit assertion (`x-levonis-ver`). (iii) Workflow 7 deploys `69ee814`+ to the live Worker. | `tests/workflowNaming.test.ts` extended for the new inputs; live read-only probes; `verify-live-guest.yml` | `wrangler rollback`; reconnect the integration | **G0 (owner action)** |
| 0.1 | Money HIGH #1 — landed in `69ee814`: `commitHold` posts the withdrawal row with the state flip (`commitHoldStatements`), merchant credits are conditional on the debit, `walletReconciliationReport` counts legacy committed-without-debit holds as anomalies, cancels are one batch (`lib/orderCancelOps.ts`). Remaining: `POST /api/orders/:id/cancel` refuses `seller_type='merchant'` if not already; `scripts/e2e-wallet.mjs` gains the buyer settled-balance assertion; tests re-keyed on symbols | `tests/walletHoldSettlement.test.ts`, `tests/orderCancelAtomic.test.ts`, `tests/escrow.test.ts`; `scripts/e2e-wallet.mjs` on dark | revert PR (no schema) | D6 |
| 0.2 | Money HIGH #3/#4 — landed in `69ee814`: legacy decide delegates to `decideDeposit`; `POST /api/admin/wallet/credit` requires financial scope + `Idempotency-Key` + per-admin rate limit + audit (the reference implementation of `01-TARGET.md` §4 item 10); `AdminWalletRequests.tsx`, `AdminOverview.tsx` repointed (old URL keeps answering). Remaining: idempotency store scoped by admin id (not key alone) if not already; `tests/adminWalletDecide.test.ts` extended | `tests/adminWalletCredit.test.ts`, `tests/depositDecideGuard.test.ts` | revert | — |
| 0.3 | Admin surface HIGH — landed in `69ee814`: `requireAdmin` refuses any host where platform administration is not served (225 admin routes discovered from source and driven on a merchant host and the apex, `tests/adminHostGuard.test.ts`). Remaining: assistant-scope denials per the capability table (`01-TARGET.md` §3.5) — decrypted KYC, wallet lists with destinations, investments, internal pricing keys of `GET /api/admin/settings`; `scripts/e2e-admin-reach.mjs` run against the live site after 0.0 | `tests/adminHostGuard.test.ts`, `scripts/e2e-admin-reach.mjs`, `scripts/e2e-permissions.mjs`, `scripts/e2e-subdomains.mjs` | revert | D12 |
| 0.4 | Migration `migrations/0055_ledger_keys.sql` (new): `event_key`, `correlation_id`, `source_service` on `wallet_transactions`; partial UNIQUE index on `event_key`; index `(user_id, currency, status, type)`; pure `CREATE INDEX` items from assessment §4.3 — **PR 1**, deployed by workflow 7 (migrations before code). **PR 2**, merged only after PR 1 is live: every existing ledger writer populates `event_key` with its deterministic id, guarded by a boot probe of the column (`PRAGMA table_info`) so a deploy that somehow precedes the migration writes today's rows | `tests/migrations.test.ts`; `scripts/check-migrations-additive.mjs` extended to accept `ALTER TABLE … ADD COLUMN` and applied to `0055+` (pinned in `tests/migrationsAdditive.test.ts`); unit test "column absent → legacy statement" | additive; columns stay unused | two workflow 7 runs (the normal path); G0 |
| 0.5 | State out of infra tables — migration `0057_state_tables.sql` (new, PR 1): `username_changes` table replaces the `audit_log` lookup in `routes/profile.ts:48-53`; `product_imports.fingerprint` column replaces `rate_limits`/`audit_log` as the template idempotency store (`routes/template.ts:844-892`); `mission_streaks` table replaces `users.checkin_streak` writes (`routes/rewards.ts:104`); `warranty_receipts` issued-events column. PR 2: the code, dual-read for one release | unit tests | revert code; tables stay | two workflow 7 runs |
| 0.6 | Inventory ledger bypasses closed via `lib/inventory.ts` adjust with op ids: `routes/returns.ts:383-385`, `routes/adminPriceGrid.ts:935/364`, `routes/adminProductRelations.ts:726/764/804`, `routes/adminProducts.ts:909-923`; TXT/CSV imports write `price_history` | `tests/inventory.test.ts`, `tests/orderInventory.test.ts`, `tests/priceGrid.test.ts`, `scripts/e2e-price-change.mjs` | revert | — |
| 0.7 | Forgot-password through the outbox (`routes/auth.ts:1047,1060` timing oracle); `POST /api/orders` no longer awaits `processOutbox` (`routes/orders.ts:1556` → `waitUntil`) | `scripts/e2e-live-auth.mjs` on dark; timing test | revert | D16 |
| 0.8 | Legacy 410s where the owner approves: `/api/admin/products` v1 (`admin.ts:357-407`), `POST /api/translate` (`routes/misc.ts:18-56`) and its key, `POST /api/profile/warranty-claims` (`profile.ts:270-296`), `/api/admin/warranty-claims` (`admin.ts:1837-1856`); `/api/community/my-store*` and the legacy wallet decide only after the SPA is repointed | grep of `src/` callers; `tests/routeTable.test.ts` (new) records the 410 | revert | D8 |
| 0.9 | Code moves without path changes: wallet admin routes out of `admin.ts`; `lib/telegram.ts` split into `lib/telegramIdentity.ts` + `lib/telegramTransport.ts` (new); wallet approval code out of `routes/telegram.ts:657-839` into `lib/walletApproval.ts` (new); referral routes out of `routes/memberships.ts`; favorites/warranty out of `routes/profile.ts`; `getApprovedAddress` → `lib/approvedAddress.ts` (new); `sniff()` → `lib/sniff.ts` (new); `planRelationsWrite` → `lib/relationsWrite.ts` (new); route-to-route imports (assessment §2.4) replaced by lib imports | typecheck; unit suite; `tests/routeTable.test.ts` proves the mounted method+path set is unchanged | revert | — |

Provisioning: none. Gate to Phase 1: none (Phase 1 is dark and independent) — except that **G0 precedes the merge of any `0055+` code** (0.4, 0.5, 1.6).

---

## Phase 1 — Foundation, fully DARK (nothing live changes) — fully specified

Deliverables: platform probes, monorepo layout, platform kit, contracts, dark core, dark gateway on a **dark zone** with a parity corpus, the core's outbox and entrypoints, four leaf services dark, frontend code splitting, deploy tooling. **Zero production infrastructure change**: the only new resources are `*-dark` Workers and D1/R2 named `*-dark`, created by the new workflow (the token is proven to create D1/R2 and deploy Workers — `deploy-staging.yml` and `deploy-staging-code.yml`; creating a *new Worker name* is proven or disproven by slice 1.0 — if it fails with a permission error, D1 is escalated and the owner creates the Worker in the dashboard once), plus the owner-provisioned dark zone (D21) — a throwaway domain, not the live zone. **Hard precondition printed by the first dark workflow run**: the account is on Workers Paid (dashboard plan badge, or `wrangler d1 list` count > 10 as circumstantial proof); nothing is created until it is confirmed (D1).

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
├── migrations/                       # single stream; 0055_ledger_keys.sql (0.4), 0056_core_outbox.sql (1.6), 0057_state_tables.sql (0.5),
│                                     # 0058_service_keys.sql (1.6) — header names the owning service; each in its own PR (two-PR rule)
├── packages/
│   ├── platform-kit/                 # (new) package.json "@levonis/platform-kit"
│   │   └── src/ log.ts correlation.ts principal.ts hop.ts rpc.ts httpx.ts db.ts outbox.ts bus.ts consumer.ts
│   │            idempotency.ts config.ts ratelimit.ts audit.ts inList.ts health.ts saga.ts scope.ts realtime.ts process.ts
│   │            edge/hosts.ts edge/securityPolicy.ts edge/middleware.ts edge/capabilities.ts edge/gatewayOnly.ts
│   │            # edge/* are COPIES of worker/lib/hosts.ts, securityPolicy.ts, http.ts:57-104 (originCheck, securityHeaders, requireMainHost);
│   │            # tests/edgeParity.test.ts asserts byte-equality until Phase 3.3 turns the core files into re-exports
│   ├── contracts/                    # (new) "@levonis/contracts"
│   │   └── src/ envelope.ts subscriptions.ts (consumers + producers per event type) events/v1/<EventType>.ts events/fixtures/*.json
│   │            rpc/ledger.ts rpc/ledgerPolicy.ts rpc/identity.ts rpc/catalog.ts rpc/orders.ts rpc/consumer.ts rpc/notifications.ts rpc/audit.ts
│   │            http/<service>.ts   # response types shared with src/ (type-only)
│   ├── pricing/                      # (new) pure: pricing.ts priceGrid.ts pinnedPrices.ts cheapestBase.ts shippingType.ts paymentPolicy.ts (+ price parts of productOverlay.ts stay in the core until 5.1)
│   └── shipping/                     # (new) pure quote engine: shipping.ts iraqGovernorates.ts
├── services/
│   ├── gateway/        wrangler.jsonc package.json OWNERSHIP.json SECRETS.md src/{index.ts,routes.ts,capabilities.ts,pipeline.ts,cache.ts,limiter.ts,principal.ts,uploadClasses.ts} tests/
│   ├── probes/         (1.0) throwaway Workers, one per platform question; deleted after the results are recorded in 04-DECISIONS.md ADR-017
│   ├── audit/          wrangler.jsonc migrations/0001_audit.sql src/{index.ts,rpc.ts,consumers.ts,http/admin.ts,store/}
│   ├── analytics/      wrangler.jsonc migrations/ src/{index.ts,consumers.ts,rollups.ts,rpc.ts,http/admin.ts,store/}
│   ├── ads/            wrangler.jsonc migrations/ src/{index.ts,consumers.ts,registry.ts,providers/{meta.ts,google.ts,tiktok.ts,snapchat.ts,noop.ts},http/admin.ts,store/}
│   └── notifications/  wrangler.jsonc migrations/ src/{index.ts,rpc.ts,consumers.ts,transports/{email.ts,telegram.ts},http/{public.ts,admin.ts,webhook.ts},store/}
├── src/                              # SPA; 1.8 lazy panels + manualChunks
├── scripts/
│   ├── gateway-parity.mjs            # (new) replay a recorded corpus against two base URLs; diff status/headers/body; `zone-only` marks for Age/cf-cache-status
│   ├── prepare-deploy-config.mjs     # (0.0) also folds services/durable_objects/queues/kv_namespaces/ratelimits/workflows until G0 is done
│   ├── lib/preserve-vars.mjs         # (new) extracted from prepare-deploy-config.mjs:194-258
│   ├── resolve-ids.mjs upload-secrets.mjs probe-health.mjs worker-name.mjs   # (new) used by _deploy-worker.yml
│   └── (all existing scripts unchanged)
├── tests/                            # + serviceBoundaries, leastPrivilege, ownership, eventSchemas, routeTable, gatewayRoutes,
│                                     #   gatewayCapabilities, gatewayUploadClasses, rateLimitParity, ledgerPolicy, edgeParity,
│                                     #   bundleBudget, checkoutSaga (7.1) .test.ts
└── .github/workflows/
    ├── _deploy-worker.yml            # (new) reusable
    ├── svc-gateway.yml svc-audit.yml svc-analytics.yml svc-ads.yml svc-notifications.yml svc-core-dark.yml   # (new)
    ├── verify-dark.yml               # (new) deploys the dark stack from a branch, seeds, runs the corpus through the gateway
    └── (all 29 existing workflows unchanged in purpose)
```

Each service package: `package.json` (`@levonis/svc-<name>`), `tsconfig.json` extending `worker/tsconfig.json` settings, `wrangler.jsonc` (top-level = production with `workers_dev: false` **and `preview_urls: false`**; `env.dark` repeats both keys — they are per environment — except that the dark gateway serves the dark zone and other dark leaves may set `workers_dev: true`), `src/index.ts` exporting `default class extends WorkerEntrypoint` (`fetch` = Hono app behind the platform kit's `gatewayOnly()` middleware, RPC methods, `scheduled`, `queue`), `src/http/{public,admin}.ts`, `src/rpc.ts`, `src/consumers.ts`, `src/statements.ts` (statement descriptors for sibling packages, ADR-004), `src/store/*.ts` (repository layer: D1 today, PostgreSQL later), `OWNERSHIP.json` (`owns`, `reads`, `calls`, `publishes`, `consumes`, `secrets`, `legacyRoutes`), `SECRETS.md` (names only), `tests/`. Every moved route file has its `worker/lib/{ratelimit,audit,session}` imports replaced by the platform kit's same-signature facades **before** its first dark deploy (checklist item; `tests/serviceBoundaries.test.ts`).

### 1.0–1.9 Slices

| Slice | Scope | Gate | Rollback | Needs |
|---|---|---|---|---|
| 1.0 | **Platform probes** — one throwaway Worker per question, deployed by the new workflow, results recorded in `04-DECISIONS.md` ADR-017 and §13.1 before G1; nothing else in Phase 1 depends on an unverified fact: (a) the token can create a new Worker name; (b) Workers Paid confirmed (plan badge or D1 count) and the account's cron-trigger count with ~28 Workers on `* * * * *`; (c) a Worker can bind to its **own** named entrypoint (self-binding RPC); (d) `ASSETS.fetch` through a binding honours `_headers`, ETag/304 and SPA fallback; (e) subrequest and D1-statement budgets of a full pump run; (f) on the **dark zone**: a `<host>/api/*` zone route wins over a Custom Domain's Worker on the same hostname, and `*.<root>/api/*` wins over `*.<root>/*`; (g) `caches.default` behaviour on a zone route; (h) Workflows: `sleepUntil` ceilings and whether sleeping instances count toward concurrency (deploy-only, if the owner allows a probe class); (i) DO SQLite class creation by `wrangler deploy` with the current token; (j) Analytics Engine dataset auto-creation on `writeDataPoint`; (k) PBKDF2 CPU time when the core runs under a binding. | each probe prints a one-line verdict; the results table is a PR | delete the probe Workers | dark zone (D21); Paid plan (D1) |
| 1.1 | Monorepo layout above; `packages/pricing` and `packages/shipping` extracted with the core files as re-exports; root `npm run check` iterates workspaces (pattern of `scripts/check-studio.mjs`); `tsconfig` paths | `npm run check`, `npm run test:unit` green; `npm run build` output byte-identical for the SPA; `tests/pricing.test.ts`, `pricingLadder.test.ts`, `priceGridAgreement.test.ts`, `shipping.test.ts`, `shippingType.test.ts` pass from the new location | revert | — |
| 1.2 | Platform kit modules (list above): `log` (sampled info / unsampled error+money), `correlation` (UUIDv7), `principal` (Ed25519 sign/verify via `crypto.subtle`; `scope: owner \| full \| assistant \| null`), `hop` (`args_hash`, `principal_hash`), `rpc` (client proxy: budget, retry-on-idempotent, breaker, ctx), `httpx` (`fetchWithBudget`, absorbs `lib/fetchGuard.ts`), `db` (`ownedDb`), `inList` (chunks at 90), `outbox` + `bus` (`RpcFanoutBus` with `pumpIds`, budgets and one-statement delivery state; `QueueBus` with per-consumer queues), `consumer` (`defineConsumer`: `sig` + producer allowlist), `idempotency` (scoped by principal/`iss`, ≥16-char keys), `config` (`money: true` keys TTL 0), `ratelimit` (`rateLimitKey` moved, `tests/rateLimitKey.test.ts` still pins it; adapters `D1RpcRateLimiter` over `IDENTITY.rateLimitHit`, `BindingRateLimiter`, `DoRateLimiter`, `MemoryRateLimiter`; a `rateLimit(c, bucket, limit, window)` facade with today's signature), `audit` (the `audit()` facade: outbox row + dual-write), `health`, `saga` (fenced states incl. `compensating`), `scope` (from `lib/adminScope.ts`), `realtime` (`NoopHub`), `process` (`CronSweepRunner`), `edge/*` copies + `edge/gatewayOnly.ts`; `worker/OWNERSHIP.tolerance.json` seeded from assessment §2.1 and keyed on `{table, writer symbol}` | unit tests per module; `tests/serviceBoundaries.test.ts` (incl. "no `services/*/src` file imports `worker/lib`"), `tests/leastPrivilege.test.ts` (incl. `workers_dev`/`preview_urls` and the gateway `calls` pin), `tests/ownership.test.ts`, `tests/edgeParity.test.ts` scaffolds green; `inList` tested against local D1 with 200 ids | n/a (no runtime yet) | — |
| 1.3 | Contracts: envelope (`delivery`, `sig`), v1 schemas + fixtures for every event in `03-EVENTS.md` §2–3, `subscriptions.ts` (consumers **and producers** per event type; `tests/eventSchemas.test.ts` fails when an event has no producer entry), RPC interfaces (`LedgerApi` + `ledgerPolicy.ts` argument policies, `IdentityApi` incl. `rateLimitHit`, `contactFor`, `CatalogApi`, `OrdersApi`, `EventConsumer`, `NotificationsApi`, `AuditApi`) | `tests/eventSchemas.test.ts` round-trips every fixture; a consumer cannot be listed in `subscriptions.ts` for an event without a schema; `tests/ledgerPolicy.test.ts` | n/a | — |
| 1.4 | **Dark core**: `env.dark` in `wrangler.jsonc` (`STORE_ROOT_DOMAIN`/`APP_ORIGIN` = the dark zone); `svc-core-dark.yml` refuses to run until the Paid-plan precondition is confirmed, creates `levonis-db-dark` + `levonis-files-dark` if missing (as `deploy-staging.yml:47-60` does), applies `migrations/`, deploys `levonis-core-dark`, seeds via `scripts/api-tests.mjs` (creates its own users/orders) | `scripts/api-tests*.mjs` green against the dark URL | delete the dark Worker/D1/R2 | new D1 + R2 (dark); D1; D21 |
| 1.5 | **Dark gateway on the dark zone**: `services/gateway` — routing table (`01-TARGET.md` §3.3, every row → `CORE`; `/api/health` forwarded; no `/*` route), `classifyHost`, `originCheck`, security headers, correlation, request validation (body-present rule, generated upload classes), 410 stubs, limiter layers (`BindingRateLimiter` first, `D1RpcRateLimiter` over the dark core's `IDENTITY.rateLimitHit` authoritative), capability table (allow-all in dark until 0.3 lands, then enforced), Cache API allowlist, `ROUTE_OVERRIDES` kill switch, `GATEWAY_LOCKED`; deployed as `levonis-gateway-dark` with `services: [{binding:'CORE', service:'levonis-core-dark'}, {binding:'IDENTITY', service:'levonis-core-dark', entrypoint:'IdentityEntrypoint'}]`, **routed from the dark zone** (`<darkroot>/api/*`, `<darkroot>/files/*`, `*.<darkroot>/api/*`, `*.<darkroot>/files/*` → the dark gateway; `<darkroot>/*`, `*.<darkroot>/*` → the dark core, mirroring production) | `scripts/gateway-parity.mjs`: a recorded corpus of ≥300 requests (from `scripts/api-tests*.mjs` + `e2e-subdomains.mjs` + `e2e-security-headers.mjs`, plus one `DELETE`, one bodiless `POST` and one upload per upload route, plus `/`, `/products`, `/assets/<hash>.js` 200 and 304, `/files/products/*`) replayed against the dark zone (through the gateway) and the dark core URL must match on status, headers (minus `Server-Timing`/`x-correlation-id`; `Age`/`cf-cache-status` `zone-only`) and body; **`scripts/e2e-subdomains.mjs` against the dark zone is the exit gate** (apex vs store host, `Domain=.<darkroot>` cookie, admin 404 on merchant hosts, `/api/storefront/resolve` per host); `tests/gatewayRoutes.test.ts` (every `worker/index.ts` mount resolves once); `tests/gatewayUploadClasses.test.ts`, `tests/rateLimitParity.test.ts`, `tests/hosts.test.ts`, `tests/securityPolicy.test.ts` | delete the dark Worker and its dark-zone routes | dark zone (D21) |
| 1.6 | **Event bus in the core + named entrypoints** (after 1.7, so the dark consumers exist before the core binds them — the upload API rejects a binding to a missing Worker): migration `0056_core_outbox.sql` (new: `core_outbox_events`, `core_outbox_deliveries`, `pump_lock`) and `0058_service_keys.sql` (new, Identity-owned) in their own PRs; `lib/audit.ts` becomes a facade that writes an `AuditRecorded` outbox row **in addition to** `audit_log` (dual-write); emitters added inside existing batches for `UserCreated` (`auth.ts`), `OrderCreated`, `CheckoutStarted`, `OrderCancelled` (`orders.ts`), `OrderStatusChanged`, `OrderDelivered` (`orderStageOps.ts`), `PaymentAuthorized/Completed/Failed` (`walletOps.ts`, `pointsOps.ts`), `RefundCompleted` (`returns.ts`, cancel paths), `InventoryChanged` (`inventory.ts`), `ProductUpserted`, `PriceChanged` (`adminProducts.ts`, `adminPriceGrid.ts`), `ReferralUsed`, `SubscriptionChanged` (`membershipOps.ts`, `memberships.ts`); best-effort `AddToCart` (`cart.ts`), `ProductViewed` sampled (`products.ts`) over fire-and-forget RPC, never through the outbox; **every `publishStatement()` is a no-op while `EVENT_BUS_ENABLED` is `off` (default) or while the boot probe finds no `core_outbox_events` table**; pump = `pumpIds` in `waitUntil` + cron step 0 in `lib/jobs.ts` (the only lock holder); `worker/entrypoints/*.ts` export `IdentityEntrypoint` (`resolveSession`, `lookupUsers`, `contactFor`, `rateLimitHit`, `revoke`, `getPublicKeys`, `redeemHandoff`, `introspect`, `deliver` for `SubscriptionChanged` — 6b), `LedgerEntrypoint` (the `LedgerApi` over `walletOps`/`pointsOps`, argument policies, `decideDeposit` with nonce + `admin_tg_identities` verification), `CatalogEntrypoint`, `OrdersEntrypoint` (read-only methods first), and the inbound `gatewayOnly()` middleware at `GATEWAY_ONLY=off`; `Env` gains optional bindings (`AUDIT?`, `ANALYTICS?`, `ADS?`, `NOTIFICATIONS?`) so the code runs with or without them; consumers bound only in `env.dark` | statement-composition unit tests; `tests/routeTable.test.ts` unchanged; dark: place an order → events appear in consumers; boot tests assert (i) the core starts with today's binding set (bindings absent → outbox rows accumulate, nothing else changes) and (ii) **table absent or var off → no statement appended, checkout/signup batches identical to today's** | revert code; tables stay | migrations `0056`/`0058` go live only at G2 via workflow 7 (two-PR rule); G0 |
| 1.7 | **Leaf services (dark)** (before 1.6's binding step): `levonis-audit-dark` (own D1 `levonis-audit-db-dark`; `audit_events` hash chain; `deliver`, `query`); `levonis-analytics-dark` (own D1; `analytics_events`, daily rollups, `overview`, `merchantDaily`); `levonis-ads-dark` (own D1; four adapters in sandbox + `noop`, `ads_event_map` seed, consent snapshots, kill switches); `levonis-notifications-dark` (own D1 with a `notify_outbox` copy of the `outbox` shape, `user_notifications` copy, `notify_deliveries`; transports moved from `lib/outbox.ts`/`lib/telegramTransport.ts` with the same Resend `Idempotency-Key` = `event_key` semantics; consumers for `UserCreated{verify}`, `OrderCreated`, `DepositDecided`, `RequestPublished`; webhook ingress with `telegram_updates` dedup and routing stubs; cron `* * * * *`; dark secrets only, email allowlist on) | each service's unit tests (`tests/emailTemplates.test.ts`, `tests/walletNotify.test.ts` moved with the transport); dark end-to-end: order on the dark core → `OrderCreated` reaches Audit/Analytics/Ads/Notifications with `processed_events` rows; replay proves idempotency; chain verification | delete the dark Workers | 4 dark D1s |
| 1.8 | **Frontend code splitting** (no API change): lazy admin panels (`src/pages/Admin.tsx:5-26`), route-level lazy pages, Vite `manualChunks`, per-language translations, `tests/bundleBudget.test.ts` | `npm run build`; `scripts/e2e-ui.mjs`; budget test; `tests/store-isolation.test.ts` | revert | — |
| 1.9 | **Deploy tooling**: `_deploy-worker.yml` (two-step first deploy for `services` bindings whose target does not exist yet; health via the probe token) + `svc-*.yml` for the six dark Workers; `verify-dark.yml`; `tests/workflowNaming.test.ts` extended (each new file names its Worker, says `DARK … serves no domain` or `LIVE`, no `-staging` in a new Worker name, unique number prefix, verify-workflow tail target per phase); `docs/WORKERS.md` gains the dark table and the dark zone | workflow runs green | delete workflows | none live |

Phase 1 exit criteria: the dark stack (gateway → core → four consumers) passes the full corpus with parity to the core alone **on the dark zone, including `e2e-subdomains.mjs`**; the platform-probe results (1.0) are recorded; the owner has seen the Audit chain, Analytics overview and Ads sandbox deliveries on dark. **G1**.

---

## Phase 2 — First light: the live core starts publishing (bindings only; no routes)

| Slice | Scope | Gate | Rollback | Needs |
|---|---|---|---|---|
| 2.1 | Production `levonis-audit`, `levonis-analytics`, `levonis-ads`, `levonis-notifications` (no routes, `workers_dev:false`, `preview_urls:false`, own production D1s); Notifications holds **copies** of `EMAIL_*`/`TELEGRAM_*` secrets but delivery stays off (`NOTIF_DELIVERY=off`) so the core's outbox remains the only sender | a production Worker with no route and no URL cannot be curled: the gate is the dark twin's `/health` on its URL **plus** `wrangler tail` of one scheduled run of the production Worker (the deploy workflow does both); from G2 on, `probe-health.mjs --env production` reaches them through the core's `/api/health?deep=1` with `HEALTH_PROBE_TOKEN` | delete Workers | **G5** (4 production D1s); secrets entered by the owner (names only in the repo) |
| 2.2 | **G2 change set on the live core, applied by workflow 7 in this order, each a listed item with an owner**: (1) migrations `0055`, `0056`, `0057`, `0058` (already merged PR 1s); (2) additive `services` bindings `AUDIT`, `ANALYTICS`, `ADS`, `NOTIFICATIONS` in `env.staging`; (3) `triggers.crons: ["* * * * *"]` for `env.staging` — the pump needs a per-minute sweep to meet the 5-min SLO (until then the SLO for core events is 15 min), and `lib/jobs.ts` keeps the other 13 steps at their `*/15` cadence by an in-code modulo (`LEGACY_STEP_CADENCE`), so only step 0 runs every minute; (4) secrets via `upload_secret`: `IDENTITY_SIGNING_KEY`, `CORE_SIGNING_KEY` (hop key), `HEALTH_PROBE_TOKEN`; (5) vars via `set_var`: `ALLOWED_CALLER_KIDS`, `EVENT_BUS_MODE=rpc`, `GATEWAY_ONLY=off`, `PRINCIPAL_MODE=off`, `LEGACY_DISABLED_STEPS=`, `EVENT_BUS_ENABLED=on` **last**, after (1)–(4) are verified — the first change to the live Worker's bindings | live read-only probes; Audit chain grows while `audit_log` is still written; `analytics_events` fills; a `PumpReport` per minute in the tail | `set_var EVENT_BUS_ENABLED=off` (seconds) stops publishing; redeploy the core without the bindings (workflow 7, previous commit); tables stay | **G2** |
| 2.3 | Notifications takes over in-app inbox writes from `routes/printRequests.ts:495-525` via `RequestPublished` (the `notifyStatement` stays until rows are verified equal for a day) | row comparison | flag | — |
| 2.4 | Studio SSO over binding: `studio/wrangler.jsonc` gains `services: [{binding:'IDENTITY', service:'levonis-staging', entrypoint:'IdentityEntrypoint'}]`; `redeem/introspect` via RPC with a hop envelope; Studio's `kid` is allowlisted for **`redeemHandoff` and `introspect` only** (never `resolveSession`); the public HTTPS path + `STUDIO_HANDOFF_SECRET` kept one release as fallback (its routes exempt from the gateway `ip` class) | `verify-studio-live.yml`, `verify-live-auth.yml` | Studio config revert | workflow 8 run |

---

## Phase 3 — Gateway cut-over (the one route change)

| Slice | Scope | Gate | Rollback | Needs |
|---|---|---|---|---|
| 3.0 | **Attachment audit (read-only)**: workflow 12's "Worker custom domains on this account" and zone-route steps record, per hostname (`levonis-iq.com`, `www`, `*.levonis-iq.com`, `studio`), whether it is a Custom Domain or a route and which Worker it names; the 1.0 probe (f) result is attached. If the apex/www are Custom Domains **and** probe (f) proved route-over-Custom-Domain precedence, 3.2 proceeds as written. If (f) was disproven: **3.0-alt** (separately approved, off-peak, no behaviour change): replace the apex/www Custom Domains by a proxied DNS record + zone routes `levonis-iq.com/*`, `www.levonis-iq.com/*` still targeting `levonis-staging`, verified by the full live probe set, so that 3.2 is again a route add | the table is committed to `docs/WORKERS.md` | — (read-only) / 3.0-alt: re-attach the Custom Domain | 3.0-alt: **owner action** |
| 3.1 | Production `levonis-gateway` (`workers_dev:false`, `preview_urls:false` from its first deploy; `GATEWAY_LOCKED=on`) bound to `CORE=levonis-staging`, `IDENTITY=levonis-staging#IdentityEntrypoint`; smoke through a **dark-zone hostname routed to the production gateway** (`live-smoke.<darkroot>/api/*` → `levonis-gateway`; requests carry `x-health-probe`; read-only paths) — never a workers.dev URL, which would publish a second unprotected path to live data; then `e2e-subdomains.mjs` read-only checks on that host | GET-only parity corpus vs live; `e2e-subdomains.mjs` (read-only subset) | delete the Worker and the dark-zone route | owner approval for the Worker; dark zone |
| 3.2 | **Cut-over = route add**: the owner adds the six zone routes `levonis-iq.com/api/*`, `levonis-iq.com/files/*`, `www.levonis-iq.com/api/*`, `www.levonis-iq.com/files/*`, `*.levonis-iq.com/api/*`, `*.levonis-iq.com/files/*` → `levonis-gateway` in the dashboard, off-peak, and sets `GATEWAY_LOCKED=off`; the Custom Domains and the wildcard `/*` route stay on `levonis-staging`, so the SPA and every asset keep being served by the asset layer with no Worker invocation; the core keeps every binding and serves every API path behind the gateway; Studio's exact-host route untouched and re-verified | workflow 7's probe list + `verify-subdomains.yml` + `verify-live-auth.yml` + `verify-live-security-headers.yml`; 24-h error-rate watch; cookie/login/logout on apex and a merchant host; Telegram webhook (posts to the apex, now via the gateway); `/`, `/assets/<hash>.js` 200/304 unchanged (byte-identity proof still green); gateway added latency p95 < 150 ms | **delete the six routes** (seconds; no DNS, no certificate) | **G3 (owner action)** |
| 3.3 | Gateway takes authority: security headers, rate classes (`BindingRateLimiter` first layer + `D1RpcRateLimiter` authoritative; `admin-write` enforced; `ip`/`public-read` in **shadow/log-only for two weeks** with `/24` telemetry before enforcement; `tests/rateLimitParity.test.ts` proves no class is tighter than today's core bucket), cache allowlist (30 s), 410s, capability enforcement (host + role + scope), `Set-Cookie` stripping, request validation; **`PRINCIPAL_MODE=shadow`** on the core (compares `loadSessionUser()` with `principalToSessionUser()` at `PRINCIPAL_SHADOW_RATE` 5 % → 100 %, logging mismatches — a week at 100 % with mismatch rate 0 is the Phase-4 entry criterion); `GATEWAY_ONLY=log` on the core; the core keeps its checks (defence in depth) and its edge libs become re-exports of the platform kit; workflow 7 sets **`workers_dev:false` + `preview_urls:false` on `env.staging`** (owner-gated as part of G3 — it changes live reachability) and `verify-live-security-headers.yml` asserts `levonis-staging.<sub>.workers.dev` no longer answers; then `GATEWAY_ONLY=on` | probes; `scripts/e2e-admin-reach.mjs`, `e2e-permissions.mjs`; shadow mismatch report; `GATEWAY_ONLY=log` counter at 0 for a week before `on` | disable per feature flag on the gateway; `set_var GATEWAY_ONLY=off` / `PRINCIPAL_MODE=off` (seconds) | **G3** (the `workers_dev` change) |
| 3.4 | Verify G0 held: no Git-integration deploy since 0.0 (`wrangler deployments list` shows only workflow-7 sources); remove the transitional binding folding from `prepare-deploy-config.mjs` | deployments list | — | — |

---

## Phase 4 — Leaf services take their routes

Each slice: deploy dark → production → flip one gateway prefix → observe → next. Files move verbatim first, platform-kit adapters second — **with three exceptions that are part of every move slice's checklist before the first dark deploy**, because the moved file would otherwise write tables the service does not own: `worker/lib/ratelimit` → platform-kit `rateLimit()` (over `IDENTITY.rateLimitHit`), `worker/lib/audit` → the `audit()` facade, `worker/lib/session` → `principalToSessionUser()` (the leaf never sees the cookie). Entry criterion for every Phase-4 slice: `PRINCIPAL_MODE=on` for its route class after the 3.3 shadow week; the leaf rejects requests without a valid principal or gateway-signed marker. Each slice also states which verify workflow it re-points and which vars it flips. Data stays in the shared D1 (own tables) unless the row says own D1.

| Slice | Service | Files moved | Seam / RPC | Data | Gate | Rollback |
|---|---|---|---|---|---|---|
| 4a | Farm | `routes/farm.ts`, `routes/farmAdmin.ts`, `lib/farm/*` | flip `/api/farm/*`, `/api/admin/farm/*`; `printerFarmConfig` via `CONFIG` (core's settings RPC until 4h); display names via `IDENTITY.lookupUsers` | shared (own tables) → own D1 later, triggers of `0053`/`0054` re-created | `scripts/e2e-farm.mjs`, `tests/farm*.test.ts` | flip back |
| 4b-i | Notifications inbox + delivery | `routes/notifications.ts`, transports (`lib/outbox.ts`, `lib/telegramTransport.ts`), `lib/walletNotify.ts` transport half (`processWalletNotifications`, message edits, `tg_admin_notifications`/`tg_admin_actions` rows — Notifications' tables) | flip `/api/notifications/*`; `NOTIF_DELIVERY=on`; the core's `enqueue()` keeps its signature and forwards to `NOTIFICATIONS.send`; core cron step 1 disabled by `LEGACY_DISABLED_STEPS`; receipt photos read through the interim `receipts/` binding | `outbox`, `user_notifications`, `tg_admin_notifications`, `tg_admin_actions` | `tests/walletNotify.test.ts` (transport half moved), `tests/emailTemplates.test.ts` | flip back; `NOTIF_DELIVERY=off`; re-enable step 1 |
| 4b-ii | Telegram webhook ingress | `routes/telegram.ts` webhook + admin branches; **the approval contract of `01-TARGET.md` §6.5 first** (the core's `LedgerEntrypoint.decideDeposit` accepts `{update_id, telegram_user_id, nonce, chat_id, message_id}`, verifies the nonce in `wallet_deposit_meta.approval_nonce_hash` and the approver in `admin_tg_identities`; `DepositRequested` carries the nonce) — one release on the core before the flip; webhook fan-out: `callback_query` → `LEDGER.decideDeposit` → authoritative re-read → `answerCallbackQuery` (today's `won`/`lost_race`/`decision_failed` semantics kept; only the message rewrite in `waitUntil`); identity commands → `IDENTITY.telegramUpdate`; `telegram_updates` dedup | flip `/api/telegram/webhook`, `/api/telegram/admin/*`; core cron step 8 disabled | `telegram_updates` | `tests/telegram.test.ts`, `tests/depositDecideGuard.test.ts` extended for the nonce path, `telegram-webhook.yml` diagnose | flip back; re-enable step 8 |
| 4c | Files | `routes/uploads.ts`; chat authz via `CHAT.canReadChatFile` (core entrypoint until 4f); receipts via `LEDGER.receiptOwner`; `/api/admin/media/ingest` orchestration with `waitUntil` chunks | flip `/api/uploads`, `/files/*`; `file_objects` (new) | none owned today | `scripts/e2e-images.mjs` | flip back |
| 4d | Invoices, KYC | `routes/invoices.ts`, `lib/invoices.ts` exposing `INVOICES.createForOrder(orderId)` (idempotent; called **synchronously** by checkout — today `orders.ts:1556`, later saga step 8 — because `POST /api/orders` returns `invoice_no` and the SPA reads it immediately, `Checkout.tsx:545-566`); the invoice **mail** becomes `InvoiceIssued` → Notifications, which resolves the address via `IDENTITY.contactFor` (Invoices holds no contacts permission); `routes/kyc.ts`, `lib/sealbox.ts` with `KYC_ENC_KEY` uploaded to KYC and removed from the core after one release | flips `/api/invoices/*`, `/api/kyc/*`; checkout's in-process `createInvoiceForOrder` call replaced by the RPC (same timing) | `invoices`; `kyc_cases`, `approved_addresses` | `scripts/e2e-receipts.mjs` (asserts `invoice_no` present in the `POST /api/orders` response), `tests/sealbox.test.ts` | flip back; key still on the core for one release (**G4**) |
| 4e | Policies | `routes/policies.ts`, `lib/policyOps.ts`; checkout calls `POLICIES.requiredForCheckout/recordAcceptance` | flip `/api/policies/*` | `policy_*` | `tests/policyDrafts.test.ts` | flip back |
| 4f | Chat | `routes/chats.ts`; authz via `ORDERS.canAccessOrder`, `MARKETPLACE.merchantOf` (core entrypoints); denormalised `last_message_at`, `unread_count` (additive) | flip `/api/chats/*` | `chat_*` | chat e2e in `scripts/api-tests-v3.mjs` | flip back |
| 4g | Support, Invest | `routes/support.ts` tickets (read models over core entrypoints), `routes/invest.ts` + `admin.ts:1855-1978` (N+1 fixed with `IN`) | flips | own tables | `tests/support.test.ts` | flip back |
| 4h | Config | `lib/settings.ts` → `services/config`; the core's `getSetting/setSetting` become RPC clients with a 30-s memo **except keys flagged `money: true`** (`exchangeRate`, `paymentMethods`, `minMarginPercent`, `communityFee*` — read per request, TTL 0, as today); raw writers/readers (`adminCommunity.ts:131`, `lib/telegram.ts:118`, `entitlements.ts:55`, `pointsOps.ts:282`, `escrowOps.ts:83`, `merchantOps.ts:128,189`, `marketplace.ts:436`, `reviews.ts:108`) routed through the client; `settings.ts:2-6` import inversion; `SettingChanged`; `PUBLIC_SETTING_KEYS` verbatim | flip `GET /api/settings/public`, `/api/admin/settings*` | `admin_settings` | settings tests | flip back |
| 4i | Search | new `services/search` (own D1, FTS5 `search_products`, `search_stores`); fed by `ProductUpserted`/`ProductArchived`/`PriceChanged`/`MerchantStatusChanged` + backfill via `CATALOG.listForIndex(cursor)` (core entrypoint); `GET /api/products?q=` in the core calls `SEARCH.products()` behind a flag | new `GET /api/v1/search` | own D1 | index parity test vs `LIKE` results on the corpus | flag off |
| 4j | Risk | new `services/risk` (own D1 `risk_*`); `restriction_cases` code moves (table stays in the shared D1, owner = Risk); `entitlements.ts:95` reads via `RISK.flagsOf`; consumers of `DepositRequested`, `WithdrawalStateChanged`, `OrderCreated`, `RateLimitHit`, `TurnstileFailed` | flip `/api/support/admin/restrictions*`; `RiskFlagRaised` | own D1 + `restriction_cases` | unit tests | flip back |

Gates: **G4**, **G5** per own-D1 service; per-slice kill switch; per slice, an e2e that exceeds a limit from two concurrent `wrangler dev` isolates (or two colos) proves the moved routes kept their cross-isolate limits. The core route files stay in place behind the `CORE` fallback.

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

Every Phase-6+ caller of the Ledger declares **two** bindings from its first production deploy — `LEDGER_CORE` (`levonis-staging#LedgerEntrypoint`) and, once `levonis-ledger` exists (8.0), `LEDGER_SVC` (`levonis-ledger#LedgerEntrypoint`) — and the platform-kit client selects by the var `LEDGER_TARGET=core|svc`, so 8.1 is one var flip per caller and its rollback the same flip, not six coordinated redeploys while money commands fail.

| Slice | Service | Saga / command replacement | Gate | Rollback |
|---|---|---|---|---|
| 6a | Marketplace + Merchants | store checkout (B4), fenced like §6.6: `ORDERS.createMerchantOrder` reserves the order id first (idempotent on `orders.idempotency_key`) → `LEDGER.hold(key store:<orderId>)` (**server-minted** key — never the client's idempotency string) → local batch with the saga fence (`merchant_coupons`, `community_products` stock, payout pending) → `LEDGER.commitHoldAndDebit`; compensation `releaseHold` only from `compensating`; escrow accept/release/refund (B6/B14) via Ledger commands with existing keys; merchant status (B5) → `ORDERS.applyStatus` + local ledger/reputation batch; `refreshMerchantRating` inside; the missing auto-complete/expiry job added; storefront caching enabled after checking user-dependent fields | `tests/escrow.test.ts` (buyer balance), `tests/merchantOps.test.ts`, `scripts/e2e-print-request.mjs`, `e2e-subdomains.mjs`; flip all marketplace/merchant prefixes | flip back (same tables, same keys) |
| 6b | Subscriptions | B9 → `hold → INSERT memberships → commitHoldAndDebit` (key `wtx_membership_<id>`; partial UNIQUE `0052_memberships_one_active.sql:60` keeps one-active); expiry via cron + `SubscriptionChanged`; **the `SubscriptionChanged` consumer is added to the core's `IdentityEntrypoint.deliver` in this slice** (same D1, same `UPDATE users SET membership_tier, subscription_plan, subscription_expiry`) and `identity` is registered for the event in `subscriptions.ts` from Phase 6 — the write-on-read in `entitlements.ts:125-131` stays as a tolerance entry for **one week of parity** (`users.membership_tier` vs `SUBSCRIPTIONS.getTier`, sampled on `/api/auth/me`) and is removed only when the mismatch count is 0 (otherwise `publicUser`, the rewards PRO checks and the admin lists would read a column nobody maintains until Phase 9); `getTier` RPC replaces `entitlements.getTierStatus` imports (core keeps a client shim) | `tests/membershipsSubscribe.test.ts`, `membershipsConcurrency.test.ts`, `scripts/e2e-subscription.mjs`; tier-parity report | flip back; shim stays; write-on-read still present |
| 6c | Referrals | consumer of `UserCreated` (replaces `auth.ts:206-221`), `Order*`, `SubscriptionChanged`, `ReturnApproved`; rewards via `LEDGER.credit`; `admin.ts:1509` → `REFERRALS.cancelRewardsForOrder` | `tests/referralFreeDelivery.test.ts`, `tests/supportCode.test.ts` | flip back |
| 6d | Reviews | B7 → `LEDGER.credit(key wtx_review_<id>)` (Ledger writes journal + `points_awards` atomically) then local `review_rewards`/gift rows; `review_media` (new) replaces the `LIKE` scan | `tests/reviews.test.ts` | flip back |

---

## Phase 7 — The checkout saga and the Commerce deployable

| Slice | Scope | Gate | Rollback |
|---|---|---|---|
| 7.1 | **Saga inside the core first** (`01-TARGET.md` §6.6): migration `0059_checkout_sagas.sql` (new, own PR; `orders.payment_state` column added additively); `placeOrder` rewritten as reserve → hold → fenced local batch (with outbox `OrderCreated{payment_state}`) → commit → synchronous `initStage`/`createForOrder` → done; sweep every minute with the `compensating` fence; `CHECKOUT_SAGA=on|off` selects saga vs legacy B1 per request (identical rows and ids); cancel refused/serialised while the saga is not `done`; `PaymentCompleted`/`OrderPaid` gate every payment-presuming consumer | `tests/checkoutPayment.test.ts`, `ordersCustomer.test.ts`, `walletSpendGuard.test.ts`, new `tests/checkoutSaga.test.ts` (crash injection at each step **plus** the sweep-vs-step-6 race, cancel-during-saga, stuck-saga code and admin unblock); `scripts/e2e-integrated.mjs`, `e2e-order-stages.mjs`, `e2e-coupons.mjs`; saga p95 measured with and without smart placement; a week on dark, then live at 10% → 100% | `set_var CHECKOUT_SAGA=off` (seconds) |
| 7.2 | Cancel/refund (B2/B3) → `ORDERS.cancel` → conditional flip + `LEDGER.refund` (keys unchanged) + `INVENTORY.restore` + `REFERRALS.cancelRewardsForOrder`; the sweep retries a refund whose flip succeeded (closes the stranded-credit gap); admin cancel gains the accrual/reservation handling of the customer path | tests | revert |
| 7.3 | `services/commerce` deployed (Cart, Checkout, Orders, Coupons, Refunds packages) over the shared D1 (own tables); tolerance entries for `wallet_*`, `points_*`, stock columns removed; the legacy B1 path stays in the core one release for rollback | full commerce e2e; flip `/api/cart/*`, `/api/orders/*`, `/api/returns/*`, `/api/price-protection/*`, `/api/admin/orders*`, `/api/admin/coupons/*` | flip back |
| 7b | Fulfilment (+ Shipping package) | `order_fulfilment` (new; backfilled lazily on first touch from the `orders` columns — no bulk migration), stage machine, delivery sync (concurrency 5), labels, receipts, own cron; `ORDERS.applyStage` for the legacy columns; `ALWASEET_*` move (**G4**) | `tests/orderStages.test.ts`, `deliverySync.test.ts`, `scripts/e2e-order-stages.mjs`, `e2e-order-fulfilment.mjs` | flip back |
| 7c | Devices & Warranty | consumer of `OrderDelivered` (replaces inline `deliveredEffects`, `admin.ts:788-831`); B11 stays a local batch; `products.ops_policy` via `PRODUCTS.setOpsPolicy` | `tests/deviceRegistration.test.ts`, `tests/warranty.test.ts`, `scripts/e2e-warranty.mjs` | flip back |

---

## Phase 8 — Money core on its own Worker

| Slice | Scope | Gate | Rollback |
|---|---|---|---|
| 8.0 | `services/ledger` deployed to production **without traffic** (Ledger, Wallet, Payments, Loyalty packages; wallet admin; Telegram approval decision half) over the shared D1 (own tables); migration `0060_ledger_balances.sql` (new: `ledger_balances`, `ledger_idempotency` with `user_id` + `payload_hash`); every Phase-6/7 caller redeploys with the additional `LEDGER_SVC` binding (a normal code deploy each, no behaviour change: `LEDGER_TARGET=core`); a dark drill flips `LEDGER_TARGET` on the dark stack and back | reconciliation clean for 7 days on dark; drill rehearsed | delete; callers keep `LEDGER_TARGET=core` |
| 8.1 | `LEDGER_TARGET=svc` set per caller (Commerce, Marketplace, Subscriptions, Referrals, Reviews, Notifications) via each caller's workflow, one caller at a time; core cron steps 7–9 disabled by var; then flip `/api/wallet/*`, `/api/rewards/*`, `/api/admin/wallet*` | `tests/walletOps.test.ts`, `points.test.ts`, `scripts/e2e-wallet.mjs`; reconciliation clean on live for 7 days | `LEDGER_TARGET=core` per caller (a var flip, seconds; identical code behind both bindings); prefixes back to `CORE` |
| 8.2 | `WALLET_LOCK` DO when provisioned; `Serializer` adapter switched | contention test | flag |
| 8.3 | PostgreSQL via Hyperdrive for the `ledger` schema: `PgLedgerStore`; dual-write journal (D1 truth) → verify → switch truth → D1 read-only | reconciliation equality for 14 days | switch truth back to D1 (dual-write kept) | **G6 + separate data-migration approval** |

---

## Phase 9 — Identity and the end of the core

| Slice | Scope | Gate | Rollback |
|---|---|---|---|
| 9.1 | `services/identity` over the shared D1 (own tables, incl. `rate_limits` and `service_keys`; the `SubscriptionChanged` consumer moves with it); `IDENTITY` bindings re-pointed (`IDENTITY_CORE`/`IDENTITY_SVC` + `IDENTITY_TARGET`, the Phase-6 pattern); the shadow comparison is **re-run** for the re-point only (the principal itself has been `on` per route class since Phase 4); `verify-live-auth.yml` re-pointed to tail `levonis-identity` in the same PR | `tests/telegramAuth.test.ts`, `registerEmailFirst.test.ts`, `authProviders.test.ts`, `verify-live-auth.yml`; shadow mismatch rate 0 for a week | `IDENTITY_TARGET=core`; `PRINCIPAL_MODE` unchanged |
| 9.2 | Cookie forwarded only to Identity; services drop `loadSessionUser`; `users` writers outside Identity replaced (`admin.ts:298` → `IDENTITY.setRole`); Studio's fallback HTTPS path and `STUDIO_HANDOFF_SECRET` removed on both sides | least-privilege test: no service but Identity references `users`/`sessions` | — |
| 9.3 | **`levonis-admin`** (internal Worker, own hop key; `/api/admin/overview`, `/api/admin/users*`, `/api/admin/providers`) over RPC read models and commands; the gateway routes the prefix to `ADMIN` like any other; `tests/leastPrivilege.test.ts` proves the gateway's key is on no `Admin*`/`setRole`/`lookupContacts` allowlist. **SPA serving path — owner decision (D23)**: (a) keep the SPA on the core's Custom Domains/asset layer (nothing changes; the core stays deployed as an asset shell after 9.5), or (b) move it to a gateway `assets` block (same `dist`, `run_worker_first`, `not_found_handling`, `_headers`) + `/*` routes or a Custom Domain move — only with probe 1.0 (d) proven, the asset paths in the parity corpus green, and workflow 7's byte-identity proof re-pointed to `svc-gateway.yml` in the same PR | probes; parity corpus incl. `/`, `/assets/*` | flip to CORE; (b) delete the `/*` routes |
| 9.4 | KYC → PostgreSQL `kyc` schema + private R2 bucket (if the owner prefers KYC before Ledger, this slice moves ahead of 8.3) | `tests/sealbox.test.ts`; dual-read | switch back | **G6** |
| 9.5 | Core retirement: `routes/admin.ts` empty, tolerance list empty, gateway default route → 404; `levonis-staging` kept deployed without traffic for one release, then deleted; `docs/WORKERS.md` rewritten | live probes | re-point default route to CORE | **G7** |

### Later (config switches, not phases)
Queues (`EVENT_BUS_MODE=queue`; topology already fixed: one queue + DLQ per consumer), DO-backed Cart/Inventory/Chat/Realtime and the `RateLimitCounter`, Workflows (`01-TARGET.md` §8, with the ceilings stated there), KV for config/tier/cache version/flags, Analytics Engine sink, merchant custom domains (Cloudflare for SaaS, D18). The `ratelimits` binding is **not** in this list: it needs no resource and is used from 1.5/3.3.

---

## 10. Resolution of every cross-domain batch (assessment §2.2)

| # | Today | Resolution | Phase |
|---|---|---|---|
| B1 | checkout 7-domain batch | saga (§6.6 of the target); coupons/cart/settlements stay local in Commerce | 7.1 |
| B2 | customer cancel: flip, then wallet+points batch | `ORDERS.cancel` → conditional flip + `LEDGER.refund` + `INVENTORY.restore` + `REFERRALS.cancelRewardsForOrder`; sweep retries | 7.2 |
| B3 | admin cancel | same command with `actor=admin`; gains accrual/reservation handling | 7.2 |
| B4 | store checkout: hold / batch / commit non-atomic | fenced saga in Marketplace: `ORDERS.createMerchantOrder` (id) → hold (`store:<orderId>`) → local batch → `commitHoldAndDebit` | 6a |
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
    // the one allowed cross-package import inside a deployable: a sibling's statement descriptors (ADR-004)
    const imports = [...src.matchAll(/from ['"]((?:\.\.\/)+(?:services|worker)\/[^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports)
      assert.ok(/^(\.\.\/)+services\/[^/]+\/src\/[^/]+\/statements$/.test(imp) && sameDeployable(svc, imp),
        `${svc}: ${file} imports another service or the core (${imp})`);
    assert.ok(!/worker\/lib\/(ratelimit|audit|session)/.test(src), `${svc}: ${file} uses a core lib — use the platform kit facade`);
    assert.ok(!/\bfetch\(/.test(src), `${svc}: ${file} uses bare fetch — use fetchWithBudget`);
    assert.ok(!/eventKey\s*[:=]\s*[^,;]*(c\.req\.header|body\.|req\.)/.test(src), `${svc}: ${file} builds an eventKey from request input`);
  }
}
const tolerance = readJson('worker/OWNERSHIP.tolerance.json');           // entries keyed on { table, writer: '<file>#<symbol>' }
const snapshot  = readJson('tests/fixtures/tolerance.snapshot.json');
for (const e of tolerance) assert.ok(snapshot.some((s) => s.table === e.table && s.writer === e.writer), `new tolerance entry ${e.table} by ${e.writer}`);
```

Initial tolerance list (from Phase 5, when Catalog is the first non-core owner of core-touched tables), keyed on symbols: stock columns of `products`/`product_option_values`/`product_colors`/`product_variants` by `routes/orders.ts#placeOrder` (B1, removed 7.1); `wallet_transactions`, `wallet_holds`, `points_*` by `routes/orders.ts#placeOrder`, `routes/admin.ts`, `lib/orderCancelOps.ts`, `routes/returns.ts` (removed 7.1/7.2); `orders` by `routes/storeOrders.ts`, `routes/merchant.ts` (removed 6a), by `lib/orderStageOps.ts`, `lib/delivery/sync.ts` (removed 7b); `users` by `lib/entitlements.ts#getTierStatus` (removed at the end of 6b after the parity week), `routes/rewards.ts` (removed 0.5), `routes/admin.ts` (removed 9.2).

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
      - run: node scripts/assert-paid-plan.mjs                                                           # hard precondition (D1): refuses to create anything on Free
      - run: node scripts/resolve-ids.mjs --service ${{ inputs.service }} --env ${{ inputs.env }}       # D1 ids by NAME (wrangler d1 list --json); dark auto-creates;
                                                                                                          # strips `services` entries whose target Worker does not exist yet (first deploy)
      - run: node scripts/lib/preserve-vars.mjs --worker $(node scripts/worker-name.mjs ${{ inputs.service }} ${{ inputs.env }}) > /tmp/vars.tsv   # refuse to deploy blind, as workflow 7
      - run: npx wrangler d1 migrations apply <db-name> --remote -c services/${{ inputs.service }}/wrangler.jsonc --env ${{ inputs.env }}   # migrations BEFORE code; skipped when the service has no DB
      - run: npx wrangler deploy -c services/${{ inputs.service }}/wrangler.jsonc --env ${{ inputs.env }} $(node scripts/vars-args.mjs /tmp/vars.tsv)
      - run: node scripts/resolve-ids.mjs --service ${{ inputs.service }} --env ${{ inputs.env }} --full && npx wrangler deploy …   # second step only when a binding was stripped (self-bindings, cycles)
      - run: node scripts/upload-secrets.mjs --service ${{ inputs.service }} --env ${{ inputs.env }}   # only names in SECRETS.md, from repo secrets <SVC>__<NAME>; unset = untouched
      - run: node scripts/probe-health.mjs --service ${{ inputs.service }} --env ${{ inputs.env }}     # dark: the Worker's URL; production: gateway/core /api/health?deep=1 with HEALTH_PROBE_TOKEN,
                                                                                                          # or (unbound Worker) `wrangler tail` of one scheduled run
      - run: node scripts/integration.mjs --service ${{ inputs.service }} --env dark                   # dark only: corpus subset + parity on the dark zone
```

`svc-<name>.yml` files carry the worker-truth banner, call the reusable workflow with `env: dark` (display `2x - Deploy DARK levonis-<name>-dark (serves no domain)`) or `env: production` (display `3x - Deploy LIVE levonis-<name>`, confirmation `DEPLOY-<NAME>-LIVE`); `tests/workflowNaming.test.ts` gains the rows and the rule that a new Worker name never contains `staging`.

### 12.1 Live verification follows ownership

A verify workflow that keeps probing the old owner proves nothing once a capability moves; each slice below re-points the workflow in the same PR, and `tests/workflowNaming.test.ts` pins the tail target per phase from this table.

| Capability probed | Workflow | Target until | Then |
|---|---|---|---|
| SSO round trip, logout liveness, Resend delivery (tails the Worker log) | `verify-live-auth.yml` | `levonis-staging` until 9.1 | `levonis-identity` (provider log lines move with `lib/outbox.ts` to Notifications in 4b-i: the Resend assertion tails `levonis-notifications` from 4b-i) |
| Post-deploy read-only probes (`/api/health`, `/api/home`, `/api/products?limit=3`, `/api/memberships/plans`) | workflow 7 | as today until 3.2 | from 3.2: `/api/health` (forwarded to the core) + a CORE-owned path per phase (`/api/auth/capabilities` until 9.1), asserting `x-levonis-ver` = the deployed commit; `/api/home` and `/api/products` move to `svc-catalog.yml` at 5.1, `/api/memberships/plans` to `svc-subscriptions.yml` at 6b |
| Byte-identity of `levonis-iq.com/assets/<hash>.js` | workflow 7 | as long as the core serves the SPA (whole programme under D23 (a)) | `svc-gateway.yml` only under D23 (b) |
| Merchant subdomains, cookie domain, admin 404 on store hosts | `verify-subdomains.yml` | every route change and every prefix flip | unchanged target (the live zone) |
| Security headers, workers.dev unreachability | `verify-live-security-headers.yml` | as today | + assert `levonis-staging.<sub>.workers.dev` no longer answers (3.3) |
| Studio SSO | `verify-studio-live.yml` | as today | unchanged; asserts the binding path from 2.4 |

---

## 13. Owner decisions, provisioning, accepted risks

### 13.1 Decisions (D) referenced above

| # | Decision | Needed by |
|---|---|---|
| D1 | **Confirm the Workers Paid plan — a hard precondition, not a courtesy check.** The design needs it at several points (subrequest and D1-statement caps per invocation for the pump and the Admin BFF; CPU time for PBKDF2/bcrypt under a binding; the D1 database count — ≥9 new D1s by Phase 2, ~23 at the end, on top of the 3–4 existing; ~40k cron invocations a day from per-minute triggers). `scripts/assert-paid-plan.mjs` (new) prints the verdict and refuses to create anything otherwise; **no Free-plan fallback exists for this architecture**. Also confirm the CI token can create new Worker names (slice 1.0 proves it), and — when asked — KV namespaces, Queues, Hyperdrive configs. We never widen the token (constraint 8); missing scopes mean the owner creates the resource in the dashboard and the workflow binds by name/id. | 1.0, 1.4, 2.1 |
| D2 | Approve the dark stack: `levonis-core-dark`, `levonis-gateway-dark`, four leaf dark Workers, `levonis-db-dark`, `levonis-files-dark`, four dark D1s. Zero effect on the live zone. | Phase 1 |
| D3 | Naming: `levonis-<service>` / `levonis-<service>-dark`; `levonis-staging` and `levonis-studio-staging` keep their names. | Phase 1 |
| D4 | Re-point `2 - Rebuild levonis-staging + run API tests` (`deploy-staging.yml`) at the dark stack so test users never land in the live DB again. | 1.4 |
| D5 | Cron cadence: new Workers use their own crons (`* * * * *` pumps where needed); the live core keeps `*/15` plus `waitUntil` pumps **until G2**, when `* * * * *` is added to `env.staging` (part of the 2.2 change set) with an in-code modulo keeping the other 13 steps at 15 minutes; until then the SLO for core-produced events is 15 minutes, not 5. | 1.6, 2.2 |
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
| D20 | `PurchaseCompleted` fires on **`PaymentCompleted`/`OrderPaid`** for prepaid orders (never on `OrderCreated`, which precedes the debit — `01-TARGET.md` §6.6) and on `OrderDelivered` for COD — confirm, since it decides what the ad platforms count as a sale. | Phase 2 |
| D21 | **Dark zone**: the owner provisions a throwaway domain (or a dedicated zone on the account) with a proxied `CNAME *` and zone routes `<darkroot>/api/*`, `<darkroot>/files/*`, `*.<darkroot>/api/*`, `*.<darkroot>/files/*` → `levonis-gateway-dark`, `<darkroot>/*`, `*.<darkroot>/*` → `levonis-core-dark`, plus `live-smoke.<darkroot>/api/*` → `levonis-gateway` for 3.1. Without it the gateway's host-class table, the `Domain=.<root>` cookie, the Cache API and the Custom-Domain precedence probe cannot be exercised before the live wildcard. Not the live zone; constraint 2 untouched. | 1.0, 1.5, 3.1 |
| D22 | **Deploy-only resources**: the `ratelimits` binding (`namespace_id` is a developer-chosen integer), SQLite Durable Object classes (`migrations[].new_sqlite_classes`, created by `wrangler deploy` with the Workers Scripts permission the token already has), Analytics Engine datasets (created on first `writeDataPoint`) and probably Workflows need no dashboard action and no new token scope. Does the owner count their **first appearance on a live Worker** as a "new bound resource" under constraint 2? Recommended: yes for the core (fold into G2/G3 text), no for new Workers that are themselves approved. Until answered, they are used on dark only. | 1.5, 3.3 |
| D23 | SPA serving path at the end state: keep the core's Custom Domains/asset layer (recommended: zero Worker invocations per asset, no change) or move the SPA to a gateway `assets` block (`/*` routes or a Custom Domain move). | 9.3 |
| D24 | Whether `KycDecided`, `RiskFlagRaised`, `RestrictionChanged`, `RoleChanged`, `DepositRequested`, `WithdrawalStateChanged` may reach Analytics at all (the design says no: reclassified `personal`, Audit/Risk/Notifications only) and how long `AuditRecorded` bodies may sit in producers' outboxes (the design: acked `personal` rows pruned within 24 h). | 1.3 |

### 13.2 Provisioning list (exact)

Split by what is needed: **(a)** a dashboard action or a token scope the CI token may lack; **(b)** only a `wrangler deploy` with the token we have (D22 decides whether (b) on the live core still needs a gate). The **cost / limit** column is the reason the Paid plan is a precondition; numbers are estimates to be replaced by the slice-1.0 measurements.

| Resource | Name | Phase | Who creates | Kind | Cost / limit impact |
|---|---|---|---|---|---|
| Dark zone | throwaway domain, `CNAME *` proxied, routes to the dark gateway/core (D21) | 1.0 | **owner, dashboard** | (a) | one domain registration; zero effect on the live zone |
| D1 | `levonis-db-dark` | 1.4 | workflow (`wrangler d1 create`, proven scope) | (a) proven | +1 D1 |
| R2 | `levonis-files-dark` | 1.4 | workflow (proven scope) | (a) proven | +1 bucket |
| Workers | probe Workers (1.0, deleted after), `levonis-core-dark`, `levonis-gateway-dark`, `levonis-{audit,analytics,ads,notifications}-dark` | 1.0–1.7 | workflow (`wrangler deploy` with new names; 1.0 proves the scope) | (a) proven by 1.0 | 6 Workers; 5 per-minute crons ≈ 7k invocations/day |
| D1 | `levonis-{audit,analytics,ads,notifications}-db-dark` | 1.7 | workflow | (a) proven | +4 D1 (dark total 5) |
| Workers + D1 | `levonis-{audit,analytics,ads,notifications}` and `levonis-{audit,analytics,ads,notifications}-db` | 2.1 | workflow after G5 | (a) | +4 Workers, +4 D1; per business event in rpc mode: 1 outbox row + N delivery-state updates (batched, 1 statement per `deliver()`) + N `processed_events` rows |
| Live core (G2) | `services` bindings, `* * * * *` trigger, secrets `IDENTITY_SIGNING_KEY`, `CORE_SIGNING_KEY`, `HEALTH_PROBE_TOKEN`, vars listed in 2.2, migrations `0055`–`0058` | 2.2 | workflow 7 | (a) gated | +1,440 cron invocations/day on the core |
| Secrets | `EMAIL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ADMIN_CHAT_ID` on `levonis-notifications`; `<SVC>_SIGNING_KEY` per Worker (generated in the workflow; private half uploaded, public half registered in `service_keys`); `AUDIT_CHAIN_KEY`; `GATEWAY_SIGNING_KEY`; `HEALTH_PROBE_TOKEN` | 2.1+ | workflow from repository secrets (names only in the repo) | (a) | — |
| Worker | `levonis-gateway` (`workers_dev:false`, `preview_urls:false`, `GATEWAY_LOCKED=on`) + `live-smoke.<darkroot>/api/*` route | 3.1 | workflow after owner approval; route by the owner | (a) | every API request becomes 2 invocations (gateway + core) instead of 1; assets unaffected (never routed) |
| Zone routes | **add** `levonis-iq.com/api/*`, `levonis-iq.com/files/*`, `www.levonis-iq.com/api/*`, `www.levonis-iq.com/files/*`, `*.levonis-iq.com/api/*`, `*.levonis-iq.com/files/*` → `levonis-gateway`; Custom Domains untouched (3.0-alt only if probe (f) fails) | 3.2 | **owner, dashboard** | (a) | rollback = delete the routes |
| Live core (G3) | `workers_dev:false`, `preview_urls:false` in `env.staging` | 3.3 | workflow 7 | (a) gated (reachability) | — |
| `ratelimits` bindings | `RL_<CLASS>` on the gateway (dark 1.5, live 3.3) | 1.5 / 3.3 | workflow (deploy-only) | (b) — D22 | per-colo counters; no D1 write for `ip`/`public-read` |
| Workers (+ dark twins) | `levonis-{farm,files,invoices,kyc,policies,chat,support,invest,config,search,risk}`; own D1 for `search`, `risk` (+ later `farm`, `chat`, `notifications`, `policies`, `invoices`) | 4 | workflow (G5 per production D1) | (a) per D1 | +11 Workers (+11 dark), +2 D1 now (+5 later); each with a cron ≈ 1.4k invocations/day |
| Workers (+ dark twins) | `levonis-{catalog,marketplace,subscriptions,referrals,reviews,commerce,fulfilment,devices,ledger,identity,admin}` | 5–9 | workflow | (a) Workers | +11 Workers (+11 dark); checkout = ~5 RPC hops instead of 1 batch; end state ≈ 28 production Workers, ~23 D1s, ≈ 40k cron invocations/day |
| Deploy-only, later (D22) | DO SQLite classes (`WALLET_LOCK`, `STOCK`, `CHECKOUT_SESSION`, `CHAT_ROOM`, `PRESENCE`, `RateLimitCounter`, …) declared in the owning configs; Analytics Engine dataset `EVENTS_AE`; Workflows (`IMPORT_APPLY`, `KYC_REVIEW`, `CHECKOUT_SAGA` recovery) | when approved | workflow | (b) | DO: per-request + storage billing; AE: `writeDataPoint` is not a log event |
| Dashboard / scope, later | KV `FLAGS`, `GW_CACHE`, `CONFIG_KV`, `TIER_CACHE`, `CATALOG_CACHE`, `ADS_FLAGS`, `RISK_FLAGS`, `POLICY_CACHE`; Queues **one per consumer**: `levonis-events-<consumer>` + `levonis-events-<consumer>-dlq` (≈ 2 × the number of consumer Workers, not 2); Hyperdrive configs + PostgreSQL; Turnstile site; `images` binding for Files; Secrets Store | when D1 confirms scopes | workflow or owner | (a) | queue mode: (write + read + delete) × subscribers per event — `OrderCreated` × 13 subscribers ≈ 40 ops/order |

### 13.3 Risks consciously accepted

1. **Shared D1 during Phases 4–8.** Isolation is by manifest + lint + runtime guard, not by the database. Accepted because moving data first violates constraint 4; mitigated by the shrinking tolerance list.
2. **B1 stays a cross-domain batch until 7.1.** By design — the safest place for it until the saga has passed crash-injection tests and a flagged rollout.
3. **Binding identity is account-level trust.** A compromised Worker on the account could call any RPC; hop envelopes + per-method allowlists + principal verification limit blast radius but are not network isolation.
4. **In-isolate caches** (principal 30 s for read classes only — `money`/`admin-write` resolve per request; config 30 s except `money: true` keys; breaker state) are per isolate; revocations propagate within the TTL on read routes, immediately on money/admin routes; KV/DO tighten this later.
5. **At-least-once, per-aggregate ordering only.** Consumers are idempotent; cross-aggregate ordering is not promised.
6. **RPC fan-out until Queues.** Latency depends on `waitUntil` pumps and cron; an outage accumulates a backlog in the producer's outbox (alert at 5 min lag).
7. **Dark ≠ production data.** Parity runs on seeded data; mitigated by shadow modes (`PRINCIPAL_MODE=shadow`, saga at 10%) and per-prefix rollback.
8. **Owner-gated waits** (G2, G3, G4, G5, G6). Dark slices always exist to fill the wait.
9. **Anonymous catalogue caching** may serve a 30–60 s stale price to a guest; checkout re-prices server-side, so no money impact.
10. **Two deployers on the live Worker until G0**; until the owner disconnects the Git integration, no `0055+` code merges (the two-PR rule and the table-presence guards are the second line of defence), and `prepare-deploy-config.mjs` folds bindings so an integration deploy cannot strip them.
11. **Merged deployables** (Catalog, Commerce, Ledger, Marketplace) until their split triggers; a bug in one package can affect the availability of its siblings; contracts and entrypoints are separate so the split is mechanical. Sibling packages share statement descriptors (ADR-004), which is a compile-time coupling inside one deployable, accepted so that the intra-deployable batches stay atomic.
12. **`-staging` = live** naming stays for the two existing Workers; every new artefact avoids the suffix and the docs/tests pin the mapping.
13. **Per-colo first-layer limiter.** The `ratelimits` binding counts per colo; it is never the only limiter on an `auth`/`money`/`upload` route — the D1 counter behind `IDENTITY.rateLimitHit` is, at the cost of one D1 write per limited request (as today).
14. **Route-over-Custom-Domain precedence** is a platform behaviour we can only prove empirically (docs unreachable here); the plan proves it on the dark zone before G3 and carries the 3.0-alt fallback.
15. **Cost multiplies before it divides**: a gateway hop on every API request, ~5 RPC hops per checkout, per-minute crons on ~28 Workers, and D1 rows per transactional event. Telemetry events bypass the outbox and Workers Logs are sampled, but the owner should expect the Workers bill to rise during Phases 3–9 and fall only when the core retires.
