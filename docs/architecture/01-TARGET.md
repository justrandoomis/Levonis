# LEVONIS — Target Architecture (canonical)

Date: 2026-09-07. Base tree: `89e663e`. Inputs: `docs/architecture/00-ASSESSMENT.md`, `docs/DECISIONS.md`, `docs/SECURITY.md`, `docs/WORKERS.md`, `docs/CLOUDFLARE_SETUP.md`, `docs/SUBDOMAIN_ARCHITECTURE.md`, `wrangler.jsonc`, `studio/wrangler.jsonc`, `.github/workflows/*`, `worker/index.ts`, `worker/lib/*`, `migrations/0001–0054`, `node_modules/wrangler/config-schema.json`, `node_modules/@cloudflare/workers-types`. Two candidate designs were judged (Appendix A); this document is the synthesis and the only authority from now on. Companion documents: `02-MIGRATION-PLAN.md` (how we get there), `03-EVENTS.md` (the event catalogue), `04-DECISIONS.md` (ADRs).

Status: a design. Nothing in it is applied to the running system. Any name marked **(new)** does not exist yet; every other file, table, route and workflow name exists in the tree at `89e663e`.

---

## الملخّص التنفيذي (بالعربية)

نحوّل المنصّة تدريجيًا من Worker واحد إلى مجموعة Workers مستقلة على Cloudflare، لكلٍّ منها كودها وإعداد wrangler الخاص وأسرارها وصلاحياتها وجداولها وعقدها المعلن، خلف **بوابة API عامّة واحدة** تتولّى التحقّق من الجلسة، والتوجيه، وحدّ الطلبات، وفحص المدخلات، والتخزين المؤقّت الآمن، وTurnstile عند الحاجة. التواصل الداخلي يمرّ عبر Service Bindings فقط؛ لا خدمة تقرأ أو تكتب جدول خدمة أخرى، ويُنفَّذ ذلك باختبار في `npm run check` وقائمة تسامح للنواة القديمة لا تكبر أبدًا.

القاعدة الحاكمة: **نستخرج العقد قبل الكود، والكود قبل البيانات.** ما يُكتب اليوم في دفعة D1 واحدة (الشراء، المحفظة+النقاط، السعر+المخزون على نفس الصفوف) يبقى في وحدة نشر واحدة لكن كحِزم منفصلة بعقود منفصلة ونقاط دخول مسمّاة، فيصبح فصلها لاحقًا تغيير إعداد لا إعادة كتابة. الطلبات تتحوّل إلى Saga تُبنى وتُختبر داخل النواة أولًا خلف علم تشغيل، ثم تنتقل إلى Worker التجارة.

المال: `wallet_transactions` يبقى دفتر اليومية بدلالته الحالية؛ كل أمر مالي يحمل مفتاح تكرار إلزاميًا؛ التثبيت-مع-الخصم عملية ذرّية واحدة تُغلق الثغرة العليا في التقييم؛ الأرصدة تُحسب بالمجموع على D1 اليوم، وتصبح صفًّا مقفولًا بـ`FOR UPDATE` على PostgreSQL عبر Hyperdrive عند توفّره. سجلّ تدقيق غير قابل للتعديل (سلسلة تجزئة) يستهلك أحداث كل عملية حسّاسة.

الأحداث موحّدة الغلاف (event_id, event_type, version, created_at, source_service, correlation_id, actor_id) عبر صندوق صادر في مخزن كل منتِج، وموزّع عبر Bindings اليوم وQueues لاحقًا بتبديل إعداد. Ads وAnalytics وAudit وNotifications وSearch وRisk خدمات حقيقية بقواعد D1 خاصّة منذ البداية، بمحوّلات (adapters) لكل مزوّد خارجي.

لا يُحذف مسار ولا جدول ولا مهمّة؛ كل تغيير على البنية الحيّة (المسارات، الأسرار، الربط) بوابة يوافق عليها المالك، والتراجع عن كل شريحة معرَّف مسبقًا.

---

## 0. The rules that fixed this design

1. **Contract before code, code before data.** A domain's RPC + event contract is fixed first while the code still runs where its writes are atomic; the code moves to its own Worker only when every caller uses the contract and every cross-domain batch has a saga; data moves only after the code has its own Worker — and only with a separate owner approval (constraint 4).
2. **Merge a deployable only where a single D1 batch is the only correctness mechanism today** (assessment §2.2 B1–B16). Even then the deployable hosts **separate packages with separate contracts and separate named entrypoints**, so the split is a wrangler change plus a table move, never a code split.
3. **The gateway is the strangler.** It routes a prefix (and host class) to the owning Worker; the legacy core (`worker/`, live as `levonis-staging`) serves everything not yet moved. Rollback of any extraction slice is a routing flip.
4. **Dark first.** Every new Worker exists as a `-dark` deployment on a full preview stack before anything live changes; the live zone changes only at owner gates (`02-MIGRATION-PLAN.md`).
5. **Adapters, not rewrites.** Queues, Durable Objects, Workflows, KV, Hyperdrive, the `ratelimits` binding, Analytics Engine and every external provider sit behind an interface whose D1/cron/in-memory implementation runs today; provisioning them later is a config switch.
6. **Nothing is deleted.** Every mounted path, table, column, cron step and row keeps working; retirements are 410 shims and only with an owner decision.

---

## 1. Service catalogue

### 1.1 Naming, environments, visibility

| Item | Decision |
|---|---|
| Worker names | `levonis-<service>` serves production; `levonis-<service>-dark` is the dark/test deployment (wrangler `env.dark`). The two live Workers keep their historical names `levonis-staging` and `levonis-studio-staging` (`docs/WORKERS.md`) — never renamed by this programme. No new Worker ever carries `-staging`, because on this account that suffix means live. |
| Core | `worker/` is the legacy core. Live: `levonis-staging`. Dark: `levonis-core-dark` (new `env.dark` block in `wrangler.jsonc` with D1 `levonis-db-dark`, R2 `levonis-files-dark`). |
| Visibility | Only the gateway has zone routes (dashboard-managed; `tests/workflowNaming.test.ts` already forbids `routes`/`custom_domains` in wrangler files and is extended to `services/*/wrangler.jsonc`). Every other production Worker: `workers_dev: false`, reachable only through `services` bindings. Dark Workers may enable workers.dev (they hold no live data). |
| Data today | one shared D1 (`levonis-db-staging`) for every service that owns tables in it; ownership by manifest + lint (§2.3). New leaf services with no legacy tables get their own D1 from day one. |
| Data later | PostgreSQL via Hyperdrive for Ledger, Orders, Identity/KYC (owner decision); own D1 for small leaves; R2 prefixes per service in the one bucket, a private bucket only for KYC when it moves. |
| Origin | single origin `levonis-iq.com/api/*` through the gateway; no `api.` host; no CORS (SECURITY.md §2). |

### 1.2 Deployables and the services they host

Legend: **Deployable** = one Worker with one wrangler file. Services sharing a deployable are separate packages under `services/<deployable>/src/<service>/` each exporting a named `WorkerEntrypoint` (`cloudflare:workers`); callers bind `{ binding, service, entrypoint }` and, inside the deployable, packages call each other through the same self-binding, never by import (ADR-004). *Split trigger* names the condition under which the package becomes its own Worker.

| # | Owner's service | Deployable | Public surface (through the gateway) | Built from | Owned tables (summary; full map §2.1) | Bindings (→ = later switch) | Secrets held only here | Split trigger |
|---|---|---|---|---|---|---|---|---|
| 1 | **API Gateway** | `levonis-gateway` (new) | the only Worker on the zone | `worker/index.ts:57-104` middleware, `worker/lib/hosts.ts`, `worker/lib/securityPolicy.ts`, `worker/lib/http.ts:57-104` moved into the platform kit | none (kill-switch overrides in a var → KV) | `services: CORE, IDENTITY, …one per extracted service`; `assets` (SPA, Phase 9); `ratelimits` →; `kv_namespaces: FLAGS, GW_CACHE` → | `GATEWAY_SIGNING_KEY` (hop key), `TURNSTILE_SECRET` | — |
| 2 | **Identity/Auth** + **Users** (+ Studio SSO) | `levonis-identity` (Phase 9; until then the core's `IdentityEntrypoint`) | `/api/auth/*`, `/api/profile/*`, `/api/addresses/*`, `/api/telegram/*` identity half, `/api/studio/handoff/*`, `/api/community-favorites/*` | `routes/auth.ts`, `routes/profile.ts`, `routes/addresses.ts`, `routes/studio.ts`, `routes/telegram.ts` identity part, `routes/communityFavorites.ts`, `lib/session.ts`, `lib/crypto.ts`, `lib/google.ts`, `lib/usernames.ts`, `lib/phone.ts`, `lib/telegram.ts:1-586`, `lib/appOrigin.ts`, `lib/profileCompletion.ts` | `users`, `sessions`, `password_reset_tokens`, `email_verification_tokens`, `pending_signups`, `telegram_links`, `link_challenges`, `otp_challenges`, `studio_handoff_codes`, `addresses`, `favorites`, `community_product_favorites`, `follows`, `service_keys` (new) | `DB` → `hyperdrive: IDENTITY_PG`; `services: NOTIFICATIONS, AUDIT, REFERRALS`; DO `TG_CHALLENGE` → | `IDENTITY_SIGNING_KEY`; `GOOGLE_CLIENT_ID` (var); `STUDIO_HANDOFF_SECRET` (retired after the Studio binding) | Users package splits when `users` is split into identity + profile tables (data migration, separate approval) |
| 3 | **KYC** (unlisted; own key) | `levonis-kyc` | `/api/kyc/*` | `routes/kyc.ts`, `lib/sealbox.ts` | `kyc_cases`, `approved_addresses`; R2 `kyc/` | `DB` → first PostgreSQL tenant (schema `kyc`), `BUCKET` → own private bucket; `services: IDENTITY, AUDIT, NOTIFICATIONS`; `workflows: KYC_REVIEW` → | `KYC_ENC_KEY` | — |
| 4 | **Catalog**, **Products**, **Pricing**, **Inventory** (+ taxonomy, bundles, import/template, localization, storefront read) | `levonis-catalog` — packages `catalog`, `products`, `pricing`, `inventory` with `CatalogEntrypoint`, `ProductsEntrypoint`, `PricingEntrypoint`, `InventoryEntrypoint` | `GET /api/products*`, `/api/home`, `/api/bundles`, `/api/admin/products-v2/*`, `/api/admin/products/*`, `/api/admin/taxonomy/*`, `/api/admin/template/*`, `/api/admin/import/*`, `/api/admin/bundles/*`, `/api/admin/media/ingest` | `routes/products.ts`, `adminProducts.ts`, `adminProductRelations.ts`, `adminPriceGrid.ts`, `adminTaxonomy.ts`, `template.ts`, `adminImport.ts`, `bundles.ts`, `media.ts`; `lib/productModel.ts`, `productOverlay.ts`, `productRelations.ts`, `priceGrid.ts`, `pinnedPrices.ts`, `cheapestBase.ts`, `availability.ts`, `homeContent.ts`, `inventory.ts`, `orderInventory.ts`, `hashtags.ts`, `lookups.ts`, `templateFamilies.ts`, `printerIdentity.ts`, `importCsv.ts`, `importApply.ts`, `templateRelations.ts`, `pageImages.ts`, `translate/*` | `products`, `product_option_groups`, `product_option_values`, `product_colors`, `product_color_option_links`, `product_variants`, `product_images`, `product_facets`, `product_catalogs`, `product_translations`, `glossary`, `catalogs`, `brands`, `facets`, `hashtags`, `bundles`, `bundle_items`, `price_history`, `inventory_ledger`, `product_imports` | `DB` (shared → own); `BUCKET` prefix `products/` → via Files; `services: SUBSCRIPTIONS, CONFIG, AUDIT, SEARCH, FILES`; `kv_namespaces: CATALOG_CACHE` →; `queues` producer `media-ingest` →; `workflows: IMPORT_APPLY` →; DO `STOCK` (Inventory) → | none (the external translation helper behind `POST /api/translate` is retired with its key — owner decision) | price and stock are columns on the same rows (`0018_prime_taxonomy_inventory.sql`); Pricing and Inventory become own Workers when their columns move to own tables on PostgreSQL; `packages/pricing` (pure) is shared from Phase 1 regardless |
| 5 | **Cart**, **Checkout**, **Orders**, **Coupons** (platform), **Refunds** (return/price-protection cases) | `levonis-commerce` — packages `cart`, `checkout`, `orders`, `coupons`, `refunds` with named entrypoints | `/api/cart/*`, `/api/orders/*`, `/api/admin/orders*` (list/detail/legacy status), `/api/admin/coupons/*`, `/api/returns/*`, `/api/price-protection/*` | `routes/cart.ts`, `routes/orders.ts`, `routes/returns.ts`, `routes/admin.ts:529-750,1406-1560,1570-1687`, `lib/cartSeller.ts`, `lib/supportCode.ts` (checkout half), `lib/membershipOps.ts:281-365` | `cart_items`, `orders`, `order_items`, `order_payment_settlements`, `coupons`, `coupon_redemptions`, `return_cases`, `price_protection_claims`, `checkout_sagas` (new), `checkout_saga_steps` (new) | `services: CATALOG, INVENTORY, PRICING, LEDGER, SUBSCRIPTIONS, REFERRALS, POLICIES, KYC, IDENTITY, FULFILMENT, MARKETPLACE, AUDIT`; DO `CHECKOUT_SESSION`, `CART` →; `workflows: CHECKOUT_SAGA` → | none | Cart → own Worker when `CART` DO exists; Coupons → own Worker once `reserve/release` RPC replaces trigger `0049_security_hardening.sql:29-40`; Refunds → own Worker once every refund is a Ledger command (Phase 7.2); Checkout and Orders stay together (orchestrator + rows) |
| 6 | **Wallet**, **Ledger**, **Payments**, **Loyalty** (points, missions — the POINT half of the wallet) | `levonis-ledger` — packages `ledger`, `wallet`, `payments`, `loyalty` with `LedgerEntrypoint`, `WalletEntrypoint`, `PaymentsEntrypoint`, `LoyaltyEntrypoint` (Phase 8; until then the core's `LedgerEntrypoint`) | `/api/wallet/*`, `/api/rewards/*`, `/api/admin/wallet*`, `POST /api/orders/:id/settlement` | `lib/walletOps.ts`, `lib/wallet.ts`, `routes/wallet.ts`, `routes/rewards.ts`, `lib/pointsOps.ts`, `routes/admin.ts:125-175,415-526`, `lib/walletNotify.ts` decision half | `wallet_transactions` (the journal, USD + POINT), `wallet_holds`, `wallet_adjustments`, `wallet_withdrawals`, `wallet_deposit_meta`, `wallet_review_requests`, `points_accruals`, `points_reservations`, `points_awards`, `reward_claims`, `browse_sessions`, `tg_admin_notifications`, `tg_admin_actions`, `admin_tg_identities`, `bnpl_accounts`, `bnpl_ledger` (frozen), `ticket_ledger`, `game_sessions` (frozen), `ledger_balances` (new), `ledger_idempotency` (new), `mission_streaks` (new) | `DB` → `hyperdrive: LEDGER_PG`; `services: NOTIFICATIONS, AUDIT, IDENTITY, ANALYTICS`; DO `WALLET_LOCK` →; `workflows: POINTS_RELEASE, WITHDRAWAL_LIFECYCLE` → | none (Telegram token leaves to Notifications) | Payments → own Worker when a PSP adapter is introduced; Loyalty never splits from Ledger while POINT rows live in `wallet_transactions` (a separate points journal is a data decision for the owner) |
| 7 | **Subscriptions** (memberships/entitlements) | `levonis-subscriptions` | `/api/memberships/*`, `/api/subscription/*` | `routes/memberships.ts`, `routes/subscription.ts`, `lib/entitlements.ts`, `lib/membershipOps.ts:27-146` | `membership_plans`, `memberships`, `entitlement_snapshots` (new) | `services: LEDGER, IDENTITY, KYC, RISK, AUDIT`; `kv_namespaces: TIER_CACHE` →; `workflows: SUBSCRIPTION_LIFECYCLE` → | none | — |
| 8 | **Referrals** (+ support gifts) | `levonis-referrals` | `/api/referrals/*`, `/api/memberships/referral/*`, `/api/memberships/admin/referrals*` | `routes/referrals.ts`, `lib/membershipOps.ts:148-875`, `lib/supportCode.ts` referral half | `referral_codes`, `referral_attributions`, `referral_rewards`, `support_gift_entitlements` | `services: LEDGER, SUBSCRIPTIONS, ORDERS (read), AUDIT` | none | — |
| 9 | **Marketplace** + **Merchants** (requests, print, escrow-settlement; store, builder, storefront, store checkout, merchant orders, merchant reputation) | `levonis-marketplace` — packages `marketplace`, `merchants` with named entrypoints | `/api/marketplace/*`, `/api/merchant/*`, `/api/storefront/*`, `/api/community/*` (legacy shims), `/api/community-reviews/*`, `/api/store-orders/*`, `/api/admin/community/*` | `routes/marketplace.ts`, `printRequests.ts`, `merchantPrinters.ts`, `merchant.ts`, `storefront.ts`, `community.ts`, `storeOrders.ts`, `merchantReviews.ts`, `adminCommunity.ts`; `lib/communityStates.ts`, `attachments.ts`, `printMatching.ts`, `printPricing.ts`, `modelGeometry.ts`, `externalModels.ts`, `escrowOps.ts`, `merchantOps.ts`, `merchantAuth.ts`, `mediaRefs.ts` | `community_merchants`, `merchant_stores`, `merchant_store_slugs`, `reserved_slugs`, `merchant_notification_preferences`, `community_products`, `merchant_store_sections`, `merchant_services`, `merchant_showcase`, `merchant_coupons`, `merchant_reviews`, `merchant_reputation_events`, `community_requests`, `community_request_files`, `community_offers`, `community_orders`, `community_order_items`, `community_complaints`, `community_complaint_messages`, `merchant_printers`, `merchant_request_prefs`, `community_print_requests`, `community_request_matches`, `model_view_tokens`, `community_escrows`, `community_escrow_events`, `merchant_payout_ledger` | `DB`; `BUCKET` prefixes `requests/`, `request-previews/`, `community/` → via Files; `services: LEDGER, ORDERS, IDENTITY, NOTIFICATIONS, CONFIG, AUDIT, SEARCH`; `workflows: ESCROW_AUTOCOMPLETE` → | none | Merchants → own Worker once store orders go through `ORDERS.createMerchantOrder` and reputation is event-fed (`ReviewPosted`) |
| 10 | **Shipping** + **Fulfillment** | `levonis-fulfilment` — packages `fulfilment`, `shipping` (+ pure `packages/shipping` quote engine used by Cart/Checkout) | `/api/admin/orders/:id/stage*`, `/api/admin/orders/:id/delivery*`, `/api/admin/delivery/*`, `/api/admin/labels*`, receipts/labels, `GET /api/orders/:id/tracking` | `lib/orderStages.ts`, `orderStageOps.ts`, `delivery/*`, `receipts.ts`, `shipping.ts`, `routes/admin.ts:760-1405` | `order_status_history`, `delivery_status_map`, `order_fulfilment` (new) | `services: ORDERS, INVENTORY, DEVICES, NOTIFICATIONS, AUDIT`; own cron; `queues` consumer `delivery-sync` →; `workflows: ORDER_STAGES, DELIVERY_SYNC` → | `ALWASEET_BASE_URL`, `ALWASEET_USERNAME`, `ALWASEET_PASSWORD` | Shipping → own Worker when a second courier adapter exists |
| 11 | **Devices & Warranty** (unlisted) | `levonis-devices` | `/api/devices/*`, `/api/warranty/*`, `/api/admin/warranties/*`, `GET /api/orders/:id/units` | `routes/devices.ts`, `routes/warranty.ts`, `lib/deviceOps.ts`, `warrantyPlans.ts`, `warranty.ts`, `warrantyConfig.ts`, `warrantyDoc.ts`, `qr.ts` | `order_item_units`, `device_serials`, `device_registrations`, `warranty_claims`, `claim_messages`, `warranty_receipts` | `BUCKET` prefix `claims/` → via Files; `services: ORDERS, CATALOG, CONFIG, NOTIFICATIONS, AUDIT` | none | none planned (one aggregate; B11 stays a batch) |
| 12 | **Chat** | `levonis-chat` | `/api/chats/*` (+ `/files/chat/*` authz for Files) | `routes/chats.ts`, `routes/uploads.ts:118-129` authz | `chats`, `chat_participants`, `chat_messages` | `DB` (shared → own D1); `services: ORDERS, MARKETPLACE, IDENTITY, NOTIFICATIONS`; DO `CHAT_ROOM`, `PRESENCE` → | none | — |
| 13 | **Notifications** (outbox delivery, in-app inbox, email/Telegram transport, Telegram webhook ingress) | `levonis-notifications` | `/api/notifications/*`, `POST /api/telegram/webhook`, `/api/telegram/admin/*` | `lib/outbox.ts`, `lib/emailTemplates.ts`, `lib/notifications.ts`, `routes/notifications.ts`, `lib/telegram.ts:588-785` transport, `lib/walletNotify.ts` transport half, `routes/telegram.ts:383-560` webhook + `:562-839` admin | `outbox`, `user_notifications`, `telegram_updates`, `notification_preferences` (new), `notify_deliveries` (new) | `DB` (shared → own D1); `BUCKET` read `receipts/` → via Files signed read; `services: IDENTITY, LEDGER, AUDIT`; `queues` consumer `notify-deliver` →; DO `INBOX` → | `EMAIL_API_KEY`, `EMAIL_FROM` (var), `EMAIL_ALLOWED_RECIPIENTS` (var), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ADMIN_CHAT_ID` | — |
| 14 | **Reviews/Reputation** (product reviews + review gifts; merchant reputation stays with Merchants) | `levonis-reviews` | `/api/reviews/*` | `routes/reviews.ts` | `reviews`, `review_rewards`, `gift_entitlements`, `gift_pool_items`, `gift_redemptions`, `gift_pools`, `review_media` (new) | `BUCKET` prefixes `reviews/`, `reviews-evidence/` → via Files; `services: LEDGER, ORDERS, CATALOG, AUDIT` | none | — |
| 15 | **Media / Files** | `levonis-files` | `POST /api/uploads`, `GET /files/*`, `POST /api/admin/media/ingest` orchestration | `routes/uploads.ts`, `lib/fetchGuard.ts` (→ platform kit), `lib/mediaRefs.ts` reference checks | `file_objects` (new: key, owner_service, owner_id, purpose, visibility, sniffed_type, bytes) | **the only Worker bound to `BUCKET` in the end state**; `services: CHAT, LEDGER, KYC, IDENTITY` (interim authz); `queues` producer `image-optimise` →; `images` binding → | `MEDIA_URL_SIGNING_KEY` | — |
| 16 | **Search** (empty today) | `levonis-search` (own D1 with FTS5 from day one) | `GET /api/v1/search` (new, additive); later `GET /api/products?q=` delegates | new | `search_products`, `search_stores`, `search_index_state` (new, own D1) | `DB` (own); event consumer | none | — |
| 17 | **Analytics** (empty today) | `levonis-analytics` (own D1 from Phase 1) | `/api/v1/analytics/*` admin/merchant read models; later replaces `admin.ts:125-159`, `merchant.ts:1443-1487` live aggregates | new | `analytics_events`, `analytics_daily_platform`, `analytics_daily_merchant` (new; takes over the dead `merchant_store_analytics_daily`) | `DB` (own); `analytics_engine_datasets: EVENTS_AE` → | none | — |
| 18 | **Ads / Marketing** (empty today) | `levonis-ads` (own D1 from Phase 1) | `/api/v1/ads/admin/*` (providers, kill switches, deliveries) | new; `AdminAds.tsx` today edits `adVideoUrl` (stays in Config) | `ads_providers`, `ads_event_map`, `ads_deliveries`, `ads_consent_snapshots`, `ads_dead_letters` (new) | `DB` (own); `services: CONFIG`; `kv_namespaces: ADS_FLAGS` → | `META_CAPI_TOKEN`, `META_PIXEL_ID`, `GOOGLE_ADS_*`, `TIKTOK_EVENTS_TOKEN`, `SNAP_CAPI_TOKEN` — absent = sandbox | — |
| 19 | **Fraud/Risk** (rules exist; no domain) | `levonis-risk` (own D1) | `/api/v1/risk/admin/*`, `/api/support/admin/restrictions*` | `routes/support.ts` restrictions part; `lib/walletOps.ts:1128-1300` reconciliation classifiers | `restriction_cases` (owner moves here; table stays in shared D1), `risk_signals`, `risk_scores`, `risk_rules` (new, own D1) | `DB` (own + shared for `restriction_cases`); `kv_namespaces: RISK_FLAGS` → | none | — |
| 20 | **Audit** | `levonis-audit` (own D1 from Phase 1) | `/api/v1/audit/admin/*` (full-scope admins) | `lib/audit.ts` becomes a facade that writes an outbox row | `audit_events`, `audit_chain_heads` (new, hash-chained); legacy `audit_log` frozen read-only after Phase 3 | `DB` (own); R2 `audit-archive/` → | `AUDIT_CHAIN_KEY` | — |
| 21 | **Admin** | dissolves: the gateway routes each `/api/admin/<domain>` prefix to its owner and enforces host + role + scope; `routes/admin.ts` shrinks to zero; `/api/admin/overview`, `/api/admin/users*`, `/api/admin/providers` become an Admin BFF package inside the gateway deployable (`levonis-gateway`, `src/admin-bff/`) composing RPC read models — never SQL | — | `routes/admin.ts`, `lib/adminScope.ts` (→ platform kit `scope.ts`) | none | — | — | — |
| 22 | **Config** (unlisted; needed) | `levonis-config` | `GET /api/settings/public`, `GET/PUT /api/admin/settings*` | `lib/settings.ts`, `routes/misc.ts:12-15`, `routes/admin.ts:1690-1807` | `admin_settings`, `feature_flags`, `config_versions` (new) | `DB`; `kv_namespaces: CONFIG_KV` →; `services: AUDIT` | none | — |
| 23 | **Policies** | `levonis-policies` | `/api/policies/*` | `routes/policies.ts`, `lib/policyOps.ts` | `policy_documents`, `policy_acceptances` | `DB` (shared → own); `services: AUDIT`; `kv_namespaces: POLICY_CACHE` → | none | — |
| 24 | **Support** (tickets, member 360) | `levonis-support` | `/api/support/*` (minus restrictions) | `routes/support.ts` | `support_tickets`, `support_ticket_messages` | `services: ORDERS, DEVICES, LEDGER, SUBSCRIPTIONS, POLICIES, IDENTITY, KYC, RISK, AUDIT` (read models) | none | — |
| 25 | **Invoices** | `levonis-invoices` | `/api/invoices/*` | `routes/invoices.ts`, `lib/invoices.ts` | `invoices` | `DB` (shared → own); `services: NOTIFICATIONS, AUDIT` | none | — |
| 26 | **Invest** | `levonis-invest` | `/api/invest/*`, `/api/admin/invest/*` | `routes/invest.ts`, `routes/admin.ts:1855-1978` | `investments`, `investment_items`, `investor_messages` | `services: IDENTITY, AUDIT` | none | — |
| 27 | **Printer Farm** | `levonis-farm` | `/api/farm/*`, `/api/admin/farm/*` | `routes/farm.ts`, `routes/farmAdmin.ts`, `lib/farm/*` | `farm_profiles`, `farm_ledger`, `farm_printers`, `farm_spools`, `farm_jobs`, `farm_assignments`, `farm_events`, `farm_daily`, `farm_achievements`, `farm_requests`, `farm_config` (new; leaves `admin_settings.printerFarmConfig`) | `DB` (shared → own D1; triggers of `0053`/`0054` re-created there); `services: IDENTITY, CONFIG, AUDIT`; DO `PLAYER` → | none | — |
| 28 | **Studio** (exists, isolation 3) | `levonis-studio-staging` (unchanged) | `studio.levonis-iq.com` (own route, not through the gateway) | `studio/` | own D1/R2 | adds `services: IDENTITY`; drops the public HTTPS + `STUDIO_HANDOFF_SECRET` exchange | — | — |
| 29 | **Legacy core** | `levonis-staging` today; dark twin `levonis-core-dark` | everything not yet moved, via `CORE` binding | `worker/` | shrinking tolerance list (§2.3) | today's set + additive `services` bindings + named entrypoints `IdentityEntrypoint`, `LedgerEntrypoint`, `CatalogEntrypoint`, `OrdersEntrypoint` (new, `worker/entrypoints/`) | today's full set, shrinking as each secret moves | retired (kept deployed, no traffic) with owner approval in Phase 9 |

The event bus is not a Worker: it is the platform-kit `EventBus` adapter in every producer (§5). Twenty-seven production Workers plus Studio and the shrinking core at the end state.

### 1.3 Deployables after each phase

| After phase | Serving traffic through the gateway | Still inside the core |
|---|---|---|
| 1 (dark) | none — dark stack only | everything |
| 2 (first light) | core + Audit, Analytics, Ads, Notifications as event consumers (no routes) | everything with routes |
| 3 (cut-over) | gateway in front of the core | everything with routes |
| 4 (leaves) | + Farm, Notifications inbox + webhook, Files, Invoices, KYC, Policies, Chat, Support, Invest, Config, Search, Risk, Studio over binding | Catalog, Commerce, Money, Identity, Marketplace, Fulfilment, Devices, Subscriptions, Referrals, Reviews |
| 5 | + Catalog deployable | Commerce, Money, Identity, Marketplace, Fulfilment, Devices, Subscriptions, Referrals, Reviews |
| 6 | + Marketplace, Subscriptions, Referrals, Reviews (money via the core's `LedgerEntrypoint`) | Commerce, Money, Identity, Fulfilment, Devices |
| 7 | + Commerce (after the in-core saga), Fulfilment, Devices | Money, Identity |
| 8 | + Ledger deployable | Identity |
| 9 | + Identity; core retained without traffic, then retired with approval | nothing |

---

## 2. Data ownership

### 2.1 Table → owning service (every table created in `migrations/`)

Intermediate rename artefacts inside rebuild migrations belong to the owner of the final table and are never referenced by code.

| Owner | Tables |
|---|---|
| Identity/Users | `users`, `sessions`, `password_reset_tokens`, `email_verification_tokens`, `pending_signups`, `telegram_links`, `link_challenges`, `otp_challenges`, `studio_handoff_codes`, `addresses`, `favorites`, `community_product_favorites`, `follows`, `service_keys` (new) |
| Gateway | `rate_limits` (until the `ratelimits` binding) |
| KYC | `kyc_cases`, `approved_addresses` |
| Catalog deployable (Products / Pricing / Inventory / Catalog packages) | `products`, `product_option_groups`, `product_option_values`, `product_colors`, `product_color_option_links`, `product_variants`, `product_images`, `product_facets`, `product_catalogs`, `product_translations`, `glossary`, `product_imports` (Products); `price_history` (Pricing); `inventory_ledger` (Inventory); `catalogs`, `brands`, `facets`, `hashtags`, `bundles`, `bundle_items` (Catalog) |
| Commerce deployable | `cart_items` (Cart); `orders`, `order_items`, `order_payment_settlements`, `checkout_sagas` (new), `checkout_saga_steps` (new) (Checkout/Orders); `coupons`, `coupon_redemptions` (Coupons); `return_cases`, `price_protection_claims` (Refunds) |
| Fulfilment/Shipping | `order_status_history`, `delivery_status_map`, `order_fulfilment` (new) |
| Ledger deployable | `wallet_transactions`, `wallet_holds`, `wallet_adjustments`, `ledger_balances` (new), `ledger_idempotency` (new) (Ledger); `wallet_withdrawals`, `wallet_deposit_meta`, `wallet_review_requests`, `tg_admin_notifications`, `tg_admin_actions`, `admin_tg_identities`, `bnpl_accounts`, `bnpl_ledger` (Payments); `points_accruals`, `points_reservations`, `points_awards`, `reward_claims`, `browse_sessions`, `mission_streaks` (new), `ticket_ledger`, `game_sessions` (Loyalty) |
| Subscriptions | `membership_plans`, `memberships`, `entitlement_snapshots` (new) |
| Referrals | `referral_codes`, `referral_attributions`, `referral_rewards`, `support_gift_entitlements` |
| Marketplace deployable | `community_requests`, `community_request_files`, `community_offers`, `community_orders`, `community_order_items`, `community_complaints`, `community_complaint_messages`, `merchant_printers`, `merchant_request_prefs`, `community_print_requests`, `community_request_matches`, `model_view_tokens`, `community_escrows`, `community_escrow_events`, `merchant_payout_ledger` (Marketplace); `community_merchants`, `merchant_stores`, `merchant_store_slugs`, `reserved_slugs`, `merchant_notification_preferences`, `community_products`, `merchant_store_sections`, `merchant_services`, `merchant_showcase`, `merchant_coupons`, `merchant_reviews`, `merchant_reputation_events` (Merchants) |
| Reviews | `reviews`, `review_rewards`, `gift_entitlements`, `gift_pool_items`, `gift_redemptions`, `gift_pools`, `review_media` (new) |
| Devices & Warranty | `order_item_units`, `device_serials`, `device_registrations`, `warranty_claims`, `claim_messages`, `warranty_receipts` |
| Chat | `chats`, `chat_participants`, `chat_messages` |
| Notifications | `outbox`, `user_notifications`, `telegram_updates`, `notification_preferences` (new), `notify_deliveries` (new) |
| Invoices | `invoices` |
| Policies | `policy_documents`, `policy_acceptances` |
| Support | `support_tickets`, `support_ticket_messages` |
| Risk | `restriction_cases`, `risk_signals`, `risk_scores`, `risk_rules` (new) |
| Invest | `investments`, `investment_items`, `investor_messages` |
| Farm | `farm_profiles`, `farm_ledger`, `farm_printers`, `farm_spools`, `farm_jobs`, `farm_assignments`, `farm_events`, `farm_daily`, `farm_achievements`, `farm_requests`, `farm_config` (new) |
| Config | `admin_settings`, `feature_flags`, `config_versions` (new) |
| Audit | `audit_log` (legacy, read-only after Phase 3), `audit_events`, `audit_chain_heads` (new) |
| Analytics | `merchant_store_analytics_daily` (dead today; re-owned), `analytics_events`, `analytics_daily_platform`, `analytics_daily_merchant` (new) |
| Ads | `ads_providers`, `ads_event_map`, `ads_deliveries`, `ads_consent_snapshots`, `ads_dead_letters` (new) |
| Search | `search_products`, `search_stores`, `search_index_state` (new) |
| Files | `file_objects` (new) |
| Platform (one set per service, in the service's own store) | `<svc>_outbox_events`, `<svc>_outbox_deliveries`, `<svc>_processed_events`, `<svc>_idempotency`, `<svc>_sagas` where the service orchestrates (new) |

`tests/ownership.test.ts` (new) generates `TABLE_OWNER` from this table and fails if a migration creates a table absent from it or if two services claim one table.

### 2.2 Column-level ownership on the rows several services write

One writer service per table; other domains issue commands. Column groups keep their semantic owner, but only the table owner executes SQL.

| Table | Column group | Semantic owner | Write path after the split |
|---|---|---|---|
| `orders` | id, user, totals, status, `wallet_applied_*`, `points_*`, `idempotency_key`, `address_snapshot` | Orders | local |
| `orders` | `stage`, `next_stage*`, `delivery_*` (`0028_order_stages.sql`) | Fulfilment | `ORDERS.applyStage(orderId, stage, status, actor, opId)` until `order_fulfilment` exists; then Fulfilment-local and the legacy columns are read-only mirrors |
| `orders` | `seller_type`, `merchant_id`, `store_id`, `commission_percent_x100`, `platform_fee_iqd`, `merchant_receivable_iqd`, `coupon_code`, `coupon_discount_iqd` | Merchants | supplied once in `ORDERS.createMerchantOrder(cmd)`; changed only via `ORDERS.cancel` |
| `orders` | `membership_gift`, `referral_delivery_waived`, `support_snapshot` | Subscriptions / Referrals | computed at checkout via RPC (`SUBSCRIPTIONS.getTier`, `REFERRALS.deliveryWaiver`) and stored by Orders as an immutable snapshot |
| `users` | identity, credentials, `role`, `admin_scope`, `is_investor` | Identity | local; `IDENTITY.setRole` (audited) replaces `admin.ts:298` |
| `users` | `membership_tier`, `subscription_plan`, `subscription_expiry` | Subscriptions (read model) | `SubscriptionChanged` → Identity updates its own row; the write-on-read in `entitlements.ts:125-131` is removed |
| `users` | `checkin_streak`, `last_checkin_day` | Loyalty | new table `mission_streaks`; the columns become dead and stay (constraint 1) |
| `users` | profile columns | Users package | local (Identity deployable) |
| `products` (+ `product_option_values`, `product_colors`, `product_variants`) | price/cost/sale columns | Pricing package | local inside the Catalog deployable via `PricingEntrypoint`; own tables on PostgreSQL |
| same | `stock`, `stock_reserved` | Inventory package | `InventoryEntrypoint` only (closes the five ledger bypasses, assessment §5.1) |
| same | `ops_policy` | Products | `PRODUCTS.setOpsPolicy` (Devices asks) |
| same | `hashtags` | Products | consumer of `HashtagRenamed` |
| `community_merchants` | `rating_*`, `badge`, `verified`, `completed_orders` | Merchants | local; fed by `ReviewPosted` / `OrderDelivered` consumers |

### 2.3 The interim rule while services share one D1 (ADR-003)

1. **Ownership manifest per service.** `services/<name>/OWNERSHIP.json` (new) lists the tables the service may name in SQL (`owns`, `reads`). `packages/platform-kit/src/db.ts` `ownedDb(env.DB, manifest, mode)` wraps `prepare()` and refuses any statement naming a table outside the manifest (regex over `FROM|JOIN|INTO|UPDATE|DELETE FROM <name>`); `mode:'throw'` in dark, `mode:'log'` for the first production release of each service, then `throw`.
2. **Static lint.** `tests/serviceBoundaries.test.ts` (new, part of `npm run check`) scans every `.ts` under `services/<name>/src` for SQL literals and asserts the tables are in the manifest; asserts no `services/<a>/src` file imports from `services/<b>/src` or `worker/` (only from `packages/*`); asserts no bare `fetch(` outside the platform kit. ESLint `no-restricted-imports` mirrors the import rule per directory.
3. **The core's tolerance list.** `worker/OWNERSHIP.tolerance.json` (new) enumerates every foreign-table write the legacy core still performs, with the reason and the phase that removes it (e.g. `wallet_transactions by routes/orders.ts — B1, removed 7.1`). A snapshot in `tests/fixtures/` is only ever shrunk by a reviewed commit; the test fails on any new entry.
4. **Cross-domain batches** (assessment §2.2) are classified: (a) *intra-deployable after the merge* — B1's cart/coupon/settlement statements, B2/B3's points+wallet, B8, B9 (until Subscriptions splits), B10, B11, B13 stay batches; (b) *saga* — B1's ledger/points/inventory legs, B4, B5, B6, B14, B16; (c) *event* — B7 (credit by key then local rows), B12, B15. Every saga is written as: idempotent remote commands first (safe to retry), local batch second (carries the outbox row), remote commit third; the orchestrator's `<svc>_sagas` row records step state; a sweep (cron today, Workflow later) completes or compensates any saga older than 2 minutes still in progress.
5. **No SQLite schema prefixes** (renaming tables touches data). Ownership is by manifest. On PostgreSQL each service gets its own schema (`ledger.*`, `orders.*`, `identity.*`) and its own role with grants limited to that schema.
6. **Migrations.** `migrations/` stays the single D1 stream, applied by workflow 7 before code (`deploy-staging-code.yml:133` then `:337`; DECISIONS row 36) until a service has its own database. Every file `0055+` names its owning service in its header, touches only that service's tables, and must pass `scripts/check-migrations-additive.mjs` extended to accept `ALTER TABLE … ADD COLUMN` (SQLite-safe) — today the classifier treats every `ALTER` as destructive and is applied only to `studio/drizzle`, while 38 of the main-stream files contain `ALTER TABLE`; the extension and its scope (`0055+`) are pinned in `tests/migrationsAdditive.test.ts`. Own-store services keep `services/<name>/migrations/` applied by their own workflow before their code.

### 2.4 Cross-domain reads → replacement

| Today | Replacement | Kind |
|---|---|---|
| `loadSessionUser` `sessions JOIN users` on every request (`session.ts:63-69`) | gateway → `IDENTITY.resolveSession(hash)` → signed principal header (§3.4) | RPC + token |
| ~25 admin lists `JOIN users` for email/phone (`admin.ts:602`, `adminCommunity.ts:151`, …) | `IDENTITY.lookupUsers(ids[])` (display fields only, ≤200 ids); contacts only via `IDENTITY.lookupContacts` for `admin_scope='full'`, audited | RPC read model |
| `entitlements.getTierStatus` from 16 route files | `SUBSCRIPTIONS.getTier(uid)`; the principal carries `tier` for the request; `TIER_CACHE` KV later | RPC + claim |
| `pricingTierContext` reads `addresses`, `approved_addresses`, `restriction_cases` | Subscriptions composes `IDENTITY.getAddress`, `KYC.isApprovedDefaultAddress`, `RISK.flagsOf` | RPC composition |
| checkout reads `addresses` (`orders.ts:486`) | `IDENTITY.getAddress(uid, id)` → snapshot on the order | RPC |
| checkout reads `cart_items`, `coupons` | same deployable (Commerce) | local |
| checkout reads products/prices | `CATALOG.getProductsForCart(lines)` using `packages/pricing` | RPC + pure package |
| chat authz reads `orders`, `community_merchants` (`chats.ts:68-74,120-124`) | `ORDERS.canAccessOrder`, `MARKETPLACE.merchantOf` | RPC |
| files authz reads chat/receipt tables (`uploads.ts:112-135`) | signed read URLs minted by the owning service (`FILES.issueSignedUrl`), interim authz RPC to the owner | signed URL |
| support member-360 reads 12 tables | per-domain RPC read models composed in Support, each filtered by caller scope | RPC |
| returns read `price_history` (`returns.ts:565-590`) | `PRICING.priceAt(productId, scope, ts)` | RPC |
| devices read `orders`/`order_items` on delivery | `OrderDelivered` payload carries items, warranty snapshot, `ops_policy`, `is_printer` | event-carried state |
| merchant analytics live queries over `orders` | Analytics rollups from `OrderCreated/Delivered/Cancelled` | consumer-owned replica |
| farm leaderboard `JOIN users` | denormalised `farm_profiles` display columns refreshed from `UserUpdated` | event-carried state |
| `printerIdentity.isPrinterCatalog` from 8 files | `CATALOG.isPrinterCatalog(id)` with a 60-s isolate memo; snapshot `order_items.is_printer` | RPC + snapshot |
| `settings.getSetting` from 22 files | `CONFIG.get(keys)` with a 30-s memo; `SettingChanged` invalidates; KV read path later | RPC + cache |
| `audit_log` read as state (`profile.ts:48-53`, `template.ts:878`, `warranty.ts:298`) | own columns/tables: `username_changes` (new), `product_imports.fingerprint` (new column), `warranty_receipts` issued-events column (new) | own table |

---

## 3. Edge: the gateway Worker

### 3.1 What it is

The only Worker with zone routes (`levonis-iq.com/*`, `www.levonis-iq.com/*`, `*.levonis-iq.com/*` — the same three that point at `levonis-staging` today; `studio.levonis-iq.com/*` keeps pointing at `levonis-studio-staging`). It holds no business logic and no domain tables. Its code is `worker/index.ts:57-104`, `lib/hosts.ts`, `lib/securityPolicy.ts`, `lib/http.ts:57-104` moved into `packages/platform-kit/src/edge/*`, plus routing, principal resolution, limiting, caching, Turnstile, correlation and the Admin BFF package.

### 3.2 Request pipeline (in order)

1. `x-correlation-id`: mint UUIDv7, or accept from a trusted internal caller only; browsers' values are ignored; echoed on every response.
2. Strip inbound `x-levonis-*` headers (Studio's strip-then-set pattern, `studio/worker/auth/session.ts:229-245`).
3. `classifyHost` (unchanged code) → `HostInfo`; `foreign && underRoot` → 404 as today.
4. `originCheck` for non-GET (unchanged) plus `Sec-Fetch-Site` sanity where present.
5. Request validation: method allowlist per route; mutations must be `application/json` or `multipart/form-data`; body ≤ 1 MB except upload routes (≤ 40 MB, as `uploads.ts` allows); reject `..` path segments and `Transfer-Encoding` tricks.
6. Route lookup (§3.3). Unknown `/api/*` or `/files/*` → `CORE` (strangler default) until Phase 9, then 404 JSON.
7. Capability guard for admin surfaces (§3.5).
8. Rate limit (§3.6): 429 body `{success:false,error:'Too many requests, try again later',code:'RATE_LIMITED'}` (matches `http.ts` `tooMany`).
9. Turnstile on flagged routes (§3.8).
10. Session → principal (§3.4); never blocks anonymous routes.
11. Cache lookup for cacheable anonymous GETs (§3.7).
12. Forward over the binding with the principal header, a hop envelope, the correlation id, `Host` untouched; the `Cookie` header goes only to `CORE` (strangler) and `IDENTITY`; every other service never sees it.
13. Response: `securityHeaders()` (idempotent; the core still sets them until Phase 9), `x-correlation-id`, `Server-Timing: gw;dur=…,svc;dur=…`, `Cache-Control: private, no-store` on anything with a principal, `x-levonis-legacy-path: 1` on legacy aliases so the 410 decision has usage data.

### 3.3 Routing table

Longest prefix, then host class. `→ CORE` rows are the strangler default and flip to the owner in the named phase (`02-MIGRATION-PLAN.md`). Host rules mirror `docs/SUBDOMAIN_ARCHITECTURE.md` §5: merchant hosts serve the storefront and everything a customer needs while shopping; admin is apex-only. The table is code (`services/gateway/src/routes.ts`, new) pinned by `tests/gatewayRoutes.test.ts` (new): every mount in `worker/index.ts` resolves to exactly one target. A kill switch (`ROUTE_OVERRIDES` var, KV `FLAGS` when provisioned) flips any prefix back to `CORE` without a deploy.

| Prefix | Hosts | Target (flip phase) | Notes |
|---|---|---|---|
| `/api/health` | all | gateway answers; `?deep=1` (admin, apex) fans out `health()` to bound services with a 2-s budget | legacy shape `{success:true,…}` kept |
| `/api/auth/*`, `/api/profile/*`, `/api/addresses/*`, `/api/studio/handoff/*`, `/api/community-favorites/*` | main + merchant (shared login) | CORE → IDENTITY (9) | credential-changing routes already `requireMainHost` in `auth.ts`; the gateway adds the same capability |
| `/api/telegram/webhook` | main | CORE → NOTIFICATIONS (4) | secret-header check moves with it (Notifications holds `TELEGRAM_WEBHOOK_SECRET`) |
| `/api/telegram/*` (link/OTP status) | main + merchant | CORE → IDENTITY (9) | |
| `/api/admin/*`, `/api/telegram/admin/*`, `/api/kyc/admin/*`, `/api/support/admin/*`, `/api/policies/admin/*`, `/api/wallet/admin/*`, `/api/referrals/admin/*`, `/api/reviews/admin/*`, `/api/devices/admin/*`, `/api/memberships/admin/*`, `/api/farm` admin, `/api/v1/*/admin/*` | **main only** (404 elsewhere, same body as today) | owner of the parent prefix | closes the assessment's HIGH "seven admin surfaces" at the edge, by capability not prefix |
| `/api/products*`, `/api/home`, `/api/bundles` | all under root | CORE → CATALOG (5) | anonymous GET cacheable |
| `/api/settings/public` | all under root | CORE → CONFIG (4) | cacheable |
| `/api/admin/products*`, `/api/admin/taxonomy/*`, `/api/admin/template/*`, `/api/admin/import/*`, `/api/admin/bundles/*`, `/api/admin/media/*` | main | CORE → CATALOG (5); `/api/admin/media/ingest` → FILES (4) | |
| `/api/cart/*`, `/api/orders/*`, `/api/returns/*`, `/api/price-protection/*`, `/api/admin/orders*`, `/api/admin/coupons/*` | main + merchant (`GET /api/orders/:id` is read on merchant hosts for store orders) | CORE → COMMERCE (7) | `GET /api/orders/:id/tracking` → FULFILMENT; `GET /api/orders/:id/units` → DEVICES; `/api/admin/orders/:id/stage*|delivery*`, `/api/admin/delivery/*`, `/api/admin/labels*` → FULFILMENT (7) |
| `/api/wallet/*`, `/api/rewards/*`, `/api/admin/wallet*` | main + merchant (wallet read on storefront checkout) | CORE → LEDGER (8) | |
| `/api/memberships/*`, `/api/subscription/*` | main + merchant | CORE → SUBSCRIPTIONS (6) | `/api/memberships/referral/*`, `/api/memberships/admin/referrals*` → REFERRALS (6) |
| `/api/referrals/*` | main | CORE → REFERRALS (6) | |
| `/api/reviews/*` | main | CORE → REVIEWS (6) | |
| `/api/merchant/*`, `/api/storefront/*`, `/api/community/*`, `/api/community-reviews/*`, `/api/store-orders/*`, `/api/marketplace/*`, `/api/admin/community/*` | all under root (`/api/storefront/resolve` must answer on every hostname) | CORE → MARKETPLACE (6) | `Host` forwarded untouched |
| `/api/chats/*` | main + merchant | CORE → CHAT (4) | |
| `/api/notifications/*` | main + merchant | CORE → NOTIFICATIONS (4) | |
| `/api/uploads`, `/files/*` | all under root | CORE → FILES (4) | `/files/<key>` path contract is permanent |
| `/api/invoices/*` | main | CORE → INVOICES (4) | |
| `/api/devices/*`, `/api/warranty/*`, `/api/admin/warranties/*` | main (+ merchant for `/api/warranty/verify`) | CORE → DEVICES (7) | |
| `/api/kyc/*` | main | CORE → KYC (4) | |
| `/api/policies/*` | all under root | CORE → POLICIES (4) | |
| `/api/support/*` | main | CORE → SUPPORT (4); `/api/support/admin/restrictions*` → RISK (4) | |
| `/api/invest/*`, `/api/admin/invest/*` | main | CORE → INVEST (4) | `requires: investor` |
| `/api/farm/*`, `/api/admin/farm/*` | main | CORE → FARM (4) | |
| `/api/admin/settings*` | main | CORE → CONFIG (4) | |
| `/api/admin/overview`, `/api/admin/users*`, `/api/admin/providers` | main | CORE → gateway Admin BFF (9) | |
| `/api/translate` | main | CORE (410 after the owner's D8) | |
| `/api/d1/query`, `/api/d1/init`, `/api/make-all-investors`, `/api/upload` | all | gateway answers 410 with the bodies of `index.ts:190-196` | |
| `/api/v1/<service>/*` | per row above | the named service | the versioned surface (§10) |
| everything else | all | CORE (whose `ASSETS` serves the SPA via `index.ts` `notFound`) → gateway `assets` block (9) | `not_found_handling: single-page-application` preserved; `dist/_headers` still generated by `scripts/write-asset-headers.mjs` |

### 3.4 Session validation without owning `users` (ADR-002)

- Cookie `levonis_session`: HttpOnly, Secure, Lax, `Domain=.<root>` computed by `sessionCookieDomain()` — unchanged. Identity remains the only Worker that sets or clears it; `Set-Cookie` passes through the gateway unmodified.
- Gateway computes `sha256(token)` (as `session.ts:60`) and calls `IDENTITY.resolveSession(hash, {host_kind, cid})`. Identity runs today's query (`session.ts:63-69`), enforces expiry, and returns a **signed principal**: `{v:1, sub, sid_hash, role, scope, investor, tier, locale, host_kind, iat, exp: iat+120, cid}` signed Ed25519 (`IDENTITY_SIGNING_KEY`, `kid` in header). No `password_hash`, `google_sub`, email or phone.
- Gateway caches the principal in-isolate ≤30 s keyed by `sid_hash` (LRU 10k); `IDENTITY.revoke(sid_hash)` from logout/password change evicts; the 30-s TTL bounds the window (shorter than Studio's 60-s cache today). KV negative cache later.
- Header `x-levonis-principal: <base64url(payload)>.<sig>`. Services verify with Identity's public keys (`IDENTITY.getPublicKeys()` cached 5 min; registry `service_keys`) and reject expired or wrong-`host_kind` principals. The platform kit's `principalToSessionUser()` reconstructs the `c.get('user')` shape route code expects; fields not in the principal (`profile_json`, `bio`, `checkin_streak`, …) are fetched by the owner when needed.
- Why Identity signs, not the gateway: a compromised gateway can then replay but not mint a principal.
- Strangler mode (Phases 3–8): the core still runs `loadSessionUser` from the cookie; the gateway forwards the cookie to `CORE`. `IDENTITY` = the core's `IdentityEntrypoint` (same code, same D1) until Phase 9, so principal mode (`PRINCIPAL_MODE=off|shadow|on`) can be enabled per route class before Identity has its own Worker.

### 3.5 Capability guard for admin surfaces

`packages/platform-kit/src/edge/capabilities.ts` (new): `{ prefix, hosts: 'main'|'root'|'all', requires: 'none'|'auth'|'investor'|'admin'|'admin:full', rateClass, cacheable? }`. Every `*/admin/*` prefix and `/api/admin/*` requires `hosts:'main'` + `admin`; money- or PII-writing admin paths (`/api/wallet/admin/*`, `/api/admin/wallet*`, `/api/kyc/admin/*`, `/api/telegram/admin/*`, `/api/reviews/admin/*` (mints points), `/api/memberships/admin/*` tier overrides, `/api/admin/users/:id` PATCH of tier/role, `/api/admin/farm/*` grants) require `admin:full` (`admin_scope !== 'assistant'`) at the gateway **and** in the service (the service check is the authority). Bodies are today's: `401 {…'Authentication required',code:'UNAUTHORIZED'}`, `403 … 'Administrator access required'`, host 404. `tests/gatewayCapabilities.test.ts` (new) parses every `app.route(...)` mount in `worker/index.ts` and every `services/*/src/http/admin.ts` mount and fails if an admin prefix lacks a `hosts:'main'` rule.

### 3.6 Rate limiting

Adapter `RateLimiter` with the same key derivation as today (`rateLimitKey` from `lib/ratelimit.ts`, pinned by `tests/rateLimitKey.test.ts`):
- `BindingRateLimiter` — wrangler `ratelimits: [{ name, namespace_id, simple: { limit, period } }]`, one binding per class; `env.RL_<CLASS>.limit({ key })`. Target.
- `DoRateLimiter` — a `RateLimitCounter` Durable Object (SQLite) sharded by key hash, when DO is provisioned before the binding.
- `MemoryRateLimiter` — per-isolate token bucket, first layer only; the core's D1 limiter stays active until the binding exists (no regression).

Classes: `ip` 600/min (+ a looser `/24` bucket for NAT-heavy carriers); `user` 300/min; `auth` (ip + `identifierKey()`) login 10/10 min, register 5/h, forgot 5/h, Telegram status poll 60/min; `money` (user) deposit 10/h, withdrawal 5/h, checkout 20/h; `write` 120/min per user; `upload` 30/10 min; `admin-write` 600/min (previously unlimited); `public-read` 1200/min per ip on catalogue/home/storefront/farm leaderboard (previously unlimited); `webhook` 300/min. The gateway emits `RateLimitHit` (sampled) to Analytics/Risk.

### 3.7 Safe caching

Only: method GET; no `Cookie` containing `levonis_session`; no `Authorization`; path in the allowlist (`/api/products`, `/api/products/:slug` (not `/quote`), `/api/home`, `/api/bundles`, `/api/settings/public`, `/api/storefront/resolve`, `/api/storefront/:slug`, `/api/storefront/:slug/products*`, `/api/policies/current`, `/api/farm/leaderboard`, `/api/memberships/plans`, `/files/products/*`, `/files/community/*`, `/files/avatars/*`). Key = `host + path + sorted query + lang` (`?lang` or first `Accept-Language` primary tag ∈ {ar,en,ckb}, else `en`). Store in `caches.default` with `s-maxage=30..60` set by the gateway (files 300); anything else is never cached; `success:false` and 5xx never cached; no `Set-Cookie` may be present. Invalidation: TTL today; Phase 5 adds a KV `catalog_version` bumped by `ProductUpdated`/`SettingChanged` and included in the key. Storefront caching is enabled in Phase 6 only after checking no user-dependent field is in the cached body.

### 3.8 Turnstile

Off until `TURNSTILE_SECRET` + `TURNSTILE_SITEKEY` exist. Hooks: `POST /api/auth/register|signup/*|forgot-password|telegram/start`, `POST /api/auth/login` after 3 failures per identifier key, `POST /api/wallet` deposit request, `POST /api/marketplace/requests`, `POST /api/marketplace/print/*` publish, `POST /api/chats/open`, `POST /api/reviews`, `POST /api/support/tickets`. The gateway verifies the token (`x-turnstile-token`) against `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a 3-s timeout; failure → `403 TURNSTILE_REQUIRED`; `/api/auth/capabilities` gains `turnstile_sitekey`; CSP adds `script-src`/`frame-src https://challenges.cloudflare.com` when on.

### 3.9 Security headers, CORS, correlation

`securityHeaders()` and `spaCsp()` move to the platform kit and are applied by the gateway; `dist/_headers` keeps being generated from the same source (`scripts/write-asset-headers.mjs`). No CORS emitted. Correlation per §11.

### 3.10 Response envelope

`{success, error, code, details}` (`http.ts`, `src/lib/api.ts:41-50`) is platform-wide, including `/api/v1/*` and gateway-generated errors.

---

## 4. Zero trust between services

1. **Reachability.** Internal Workers have no route and `workers_dev:false`; the only way in is a service binding, and only Workers on this account can declare one. Coarse layer only.
2. **Principal.** Every user-originated call carries the Identity-signed principal (§3.4). A service verifies signature, `exp`, `host_kind` against the route's host rule, and re-applies its own authorization (`requireAuth/requireAdmin/requireFinancial` from the platform kit over the principal). Server-side authorization per endpoint stays in the service.
3. **Hop envelope (service → service).** Each Worker has its own Ed25519 keypair (`<SVC>_SIGNING_KEY` secret; public key registered in `service_keys` owned by Identity, plus a bootstrap allowlist var `ALLOWED_CALLER_KIDS` before Identity exists). Every RPC carries `ctx = { cid, principal?, idempotencyKey?, hop: { iss, kid, iat, exp: iat+30s, nonce, method } }` signed by the caller. The callee verifies `iss` ∈ allowed callers **for that method** (e.g. `LEDGER.credit` accepts `commerce, marketplace, reviews, subscriptions, referrals, ledger-admin`; `LEDGER.decideDeposit` accepts only `notifications, ledger-admin`), verifies the signature and rejects replays by `(iss, nonce)` in a 60-s in-isolate set (DO/KV later). No shared long-lived secret between services; rotation = add a `kid`, deploy callees, rotate the caller, retire the old `kid` after 10 minutes. The single shared secret today (`STUDIO_HANDOFF_SECRET`) is retired when Studio calls `IDENTITY` over a binding.
4. **System principal.** Cron/queue work uses `principal = { sub:'system:<svc>', role:'system' }` signed with the service key; callees authorise system principals per method (`INVENTORY.restore` accepts `system:commerce`, not `system:analytics`).
5. **Least privilege per Worker.** Each `wrangler.jsonc` declares only the bindings in §1.2; secrets exist only on the Worker that uses them (`EMAIL_*`/`TELEGRAM_*` → Notifications; `KYC_ENC_KEY` → KYC; `ALWASEET_*` → Fulfilment; nothing money-related on the gateway). `tests/leastPrivilege.test.ts` (new) diffs each service's declared bindings against `services/<name>/OWNERSHIP.json` (`calls`, `secrets`) and fails on anything undeclared; the deploy workflow uploads only that service's secret names.
6. **Admin vs user APIs.** Separate router files per service (`src/http/admin.ts`, `src/http/public.ts`) mounted under `/api/admin/<domain>` or `/api/<domain>/admin`, gated at the gateway (host + role + scope) and in the service. Admin RPC methods carry `Admin` in the name and require `role:'admin'` plus non-assistant scope where money/PII is involved.
7. **Money methods.** Any RPC tagged money (`credit, debit, hold, commitHoldAndDebit, releaseHold, refund, decideDeposit, payout, grantCoins`) refuses to run without an `eventKey`, and its batch carries an `AuditRecorded` outbox row — a sensitive mutation cannot succeed unaudited (replaces the swallowing `audit()` at `lib/audit.ts:14-16`).
8. **Output filtering.** Cost, commission, internal notes and payout destinations are stripped in the owning service's projections (`projectPublic`, `withdrawalPublic`, `adminScope.ts` strip) — carried over verbatim; the assessment's leaks (`storeOrders.ts:227` `SELECT *`, `admin.ts:357` v1 products, `admin.ts:1690` settings blob) are closed with explicit column lists in Phase 0/4/6.
9. **Input validation.** HTTP handlers keep `str/int/pickFrom/oneOf` (`http.ts`) or a schema; RPC methods validate command objects with the `packages/contracts` validators (hand-written, no new dependency) so a compromised caller cannot pass malformed commands.
10. **Idempotency contract.** Every mutating RPC and every `POST/PUT/PATCH/DELETE` under `/api/v1/*` accepts an idempotency key (`Idempotency-Key` header / `ctx.idempotencyKey`); the platform kit stores `(service, key) → response hash + status` in `<svc>_idempotency` for 48 h; a replay returns the stored response; same key + different payload → `409 IDEMPOTENCY_MISMATCH`.

---

## 5. Event bus (details in `03-EVENTS.md`)

- **Envelope**: `event_id` (UUIDv7), `event_type`, `version`, `created_at`, `source_service`, `correlation_id`, `causation_id`, `actor_id`, `aggregate_type`, `aggregate_id`, `aggregate_seq`, `pii_class`, `payload`. Schemas in `packages/contracts/src/events/v1/<EventType>.ts` (new) with per-field `pii` annotations so Analytics/Ads projections strip mechanically.
- **Producer**: transactional outbox in the producer's own store (`<svc>_outbox_events`, `<svc>_outbox_deliveries`, `pump_lock`); the outbox INSERT rides in the same `db.batch()` as the business write (the pattern `notifyStatement` already uses, `lib/notifications.ts:66-72`); the platform kit's `Uow` refuses to commit a command declared as publishing without its outbox statement. `ctx.waitUntil(bus.pump())` after the batch; the service's cron is the safety net.
- **Dispatcher**: `RpcFanoutBus` today (pump selects pending rows in `seq` order, fans out to subscribers from the static map `packages/contracts/src/subscriptions.ts`, calls `env.<CONSUMER>.deliver(batch)` with backoff `min(15 min, 5 s·2^attempts)` + jitter, 8 attempts, then `state='dead'` — the DLQ is the deliveries table, replayable by an admin RPC); `QueueBus` when Queues exist (`env.EVENTS_QUEUE.sendBatch`, one queue per environment, consumers declared with `max_batch_size: 50, max_retries: 8, dead_letter_queue: 'levonis-events-dlq'`, the same `deliver()` called from `queue()`). Switch = `EVENT_BUS_MODE` var + binding presence.
- **Consumer**: `<svc>_processed_events (event_id PK)` inserted in the same batch as the side effect; remote-command effects derive their `eventKey` deterministically from the event or the domain key (`wtx_review_<id>`); money consumers keep domain idempotency (`ledger_idempotency`, `inventory_ledger.idempotency_key`, `orders.idempotency_key`) so correctness never depends on the event layer.
- **Poison**: schema-invalid events are recorded `result='invalid'` and never retried; ordering is per aggregate (`aggregate_seq`), consumers tolerate reordering ("last `aggregate_seq` wins"); replay from any producer's outbox is safe by construction.
- **Interim on the live core**: the core is a producer too (`core_outbox_events`, migration `0056`); before consumers are bound (Phase 2) rows accumulate and are pumped once bindings exist — no event between the migration and the binding is lost.

---

## 6. Money (ADR-006)

### 6.1 Boundary and contract

The Ledger package is the only writer of `wallet_transactions`, `wallet_holds`, `wallet_adjustments`, `points_*`, `ledger_balances`, `ledger_idempotency`. `merchant_payout_ledger` (IQD merchant accounts) is written only by Marketplace through its own `payout` commands with the same rules (keys, conditional flips). The contract, exposed from the core's `LedgerEntrypoint` from Phase 2 and from `levonis-ledger` from Phase 8:

```ts
type MoneyCmd = { eventKey: string; userId: string; currency: 'USD'|'POINT'; amount: number;
                  ref: { type: string; id: string }; reason: string; actor: Actor; correlationId: string };
interface LedgerApi {
  credit(cmd: MoneyCmd): Promise<Applied>;                 // approved deposit row
  debit(cmd: MoneyCmd): Promise<Applied|Refused>;          // conditional withdrawal row (usdSpendStatement semantics)
  hold(cmd: MoneyCmd & { kind: 'purchase'|'withdrawal'|'escrow' }): Promise<HoldResult>;   // wallet_holds conditional insert (walletOps.ts:228-258)
  commitHoldAndDebit(cmd: { holdId; eventKey; txId; note }): Promise<Applied|Refused>;      // NEW atomic: withdrawal row + hold→committed in one batch
  releaseHold(cmd: { holdId; eventKey }): Promise<Applied>;
  refund(cmd: MoneyCmd): Promise<Applied>;                 // credit with ref.type ∈ {order, return, price_protection, escrow, membership}; ids wtx_refund_<id>_usd|_pts kept
  reservePoints(cmd), settlePoints(cmd), releasePoints(cmd), reversePoints(cmd);           // existing pointsOps statements behind the API
  decideDeposit(cmd: DepositDecisionRequest): Promise<DepositDecisionResult>;             // the ONLY approval path
  getBalances(userId), getBreakdown(userId), reconcile();
}
type Applied = { ok: true; applied: true; txIds: string[] } | { ok: true; applied: false; replayed: true; txIds: string[] };
type Refused = { ok: false; reason: 'INSUFFICIENT'|'EVENT_KEY_REUSED'|'INVALID_AMOUNT'|'STATE_CONFLICT'|'FORBIDDEN' };
```

Every command **requires** `eventKey`. The deterministic ids already in use (`wtx_ord_<id>_usd`, `wtx_refund_<id>_usd`, `wtx_ret_<caseId>`, `wtx_pp_<claimId>`, `wtx_review_<id>`, `wtx_acc_<accrual>`, `wtx_refund_<membershipId>`) become the keys, so behaviour is unchanged and replay-safe across Workers.

### 6.2 Journal, append-only, balances

- `wallet_transactions` remains the journal (constraint 5). Additive migration `0055_ledger_keys.sql` (new): `ALTER TABLE wallet_transactions ADD COLUMN event_key TEXT; ADD COLUMN correlation_id TEXT; ADD COLUMN source_service TEXT;` + `CREATE UNIQUE INDEX … ON wallet_transactions(event_key) WHERE event_key IS NOT NULL` + the composite index `(user_id, currency, status, type)` the assessment asks for. Historical rows keep `NULL`; the application copies the deterministic id into `event_key` on first touch — no data migration.
- Append-only rule: new money movements are always INSERTs. The two legitimate UPDATEs (deposit `pending→approved|rejected`, the withdrawal state machine) are request state transitions, conditional on the old state, as today. `ledger_idempotency (event_key PK, command_type, result_json, created_at)` records every command outcome so a replay returns the same answer even when the command was refused.
- Balances: `SUM` over approved rows (`walletOps.ts:44-61`) stays **the truth on D1**. `ledger_balances (user_id, currency, settled, held, revision, updated_at)` is a materialised cache written in the same batch as each journal insert with a revision fence (`UPDATE … SET revision = revision+1 WHERE user_id=? AND currency=? AND revision=?`; a mismatch aborts the batch and the command retries with a fresh read, ≤3 times). `reconcile()` (cron step 9 extended, `walletOps.ts:1167`) compares SUM vs cache and covers **purchase holds** (unchecked today), reports to Audit and never repairs silently.
- No path adjusts a balance alone: `lib/wallet.ts` `credit()` (no key) is replaced by `LEDGER.credit`; `admin.ts:514-526` manual credit gets `admin:full` + `eventKey` + rate limit + audit (Phase 0).

### 6.3 Operations as entries

| Operation | Entries | Key | Invariant |
|---|---|---|---|
| deposit request | request row `pending` | `dep:<request_id>` | none until decided |
| deposit decide | `pending→approved|rejected` conditional on state + amount match | decision op id | `amount_mismatch` refusal (`walletOps.ts:823-826`) is the only path; legacy `admin.ts:449-511` delegates |
| hold | `wallet_holds` insert guarded by `available >= amount` in-statement | `event_key` UNIQUE (`0015_wallet_holds.sql:58`) | available ≥ 0 |
| commit hold | hold `→committed` + debit row `approved` in one batch, both conditional | debit `event_key` | hold and debit amounts equal (closes assessment HIGH #1: `storeOrders.ts:344`, `escrowOps.ts:240,336`) |
| release hold | hold `→released` conditional | release op | — |
| debit | conditional withdrawal row (`usdSpendStatement`, `walletOps.ts:97-113`) | `event_key` | available ≥ 0 |
| credit / refund | approved deposit row | `event_key` | refund ≤ originally debited (Refunds computes from `PAYMENTS.settlementOf(orderId)`, not the order row) |
| adjustment | `wallet_adjustments` + counter row | `UNIQUE(original_tx_id, event_key)` | — |
| merchant sale credit / available / reversed / paid | `merchant_payout_ledger` rows and conditional flips | `sale:<order_id>`, `avail:<order_id>`, `rev:<order_id>`, `payout:<id>` | payout conditional on `available − paid ≥ amount` in-statement (fixes `adminCommunity.ts:759-770`) |

### 6.4 Locking

| Store | Mechanism |
|---|---|
| D1 today | single-statement conditional inserts; `db.batch()` atomicity for multi-row commands; the `ledger_balances.revision` fence serialises concurrent commands per user; single writer (only the Ledger package executes these statements) |
| + Durable Objects | `WALLET_LOCK` DO per `user_id` wraps each command; adapter `Serializer` = `NoopSerializer` today / `DoSerializer` later |
| PostgreSQL via Hyperdrive | one transaction per command: `SELECT … FROM ledger.balances WHERE user_id=$1 AND currency=$2 FOR UPDATE` → insert journal rows → update balance → insert idempotency row → commit; `SERIALIZABLE` for `reconcile`; the materialised row becomes the truth and the SUM the audit. `LedgerStore` repository with `D1LedgerStore` / `PgLedgerStore` chosen by the presence of the `LEDGER_PG` binding. SQLite triggers `0049` (coupons) and `0053/0054` (farm) belong to Commerce and Farm and are re-implemented as conditional inserts in their owners' schemas if they move. |

### 6.5 Payments today (no PSP)

Deposits are manual transfers with a receipt and Telegram admin approval; withdrawals are manual payouts with `WITHDRAWAL_TRANSITIONS`; COD settles on delivery via `order_payment_settlements`. The `PaymentProvider` adapter (`authorize/capture/refund/webhook`) exists from day one with `ManualTransferProvider` (today's behaviour) and `SandboxProvider`; a PSP is a new adapter plus secrets on the Ledger deployable only. `PaymentAuthorized` is emitted when a hold is placed, `PaymentCompleted` when a debit commits or a COD settlement is recorded, `PaymentFailed` when a hold fails.

### 6.6 The checkout saga (B1) — built inside the core first (ADR-007)

```
placeOrder(cmd, principal):                 # cmd carries orders.idempotency_key (existing per-user key, 0001_init.sql:156)
  0  existing order for (user, key) → return it (as today)
  1  quote = computeCheckout(...)           # unchanged; packages/pricing; POLICIES.requiredForCheckout
  2  saga = sagas.begin('checkout', orderId, {quote})                         # checkout_sagas state='started'
  3  INVENTORY.reserve({opId:'inv_'+orderId, moves})                          # idempotent on inventory_ledger.idempotency_key (0020:31)
  4  LEDGER.hold({kind:'purchase', eventKey:'wtx_ord_'+orderId+'_usd', …})    # skipped when 0
  5  LEDGER.reservePoints({eventKey:'wtx_ord_'+orderId+'_pts', …})            # skipped when 0
     any refusal in 3–5 → compensate the earlier steps (release/restore, same keys) → saga.fail → 409
  6  db.batch([ INSERT orders(status='pending'), INSERT order_items×n, INSERT coupon_redemptions (trigger 0049 still guards),
                INSERT order_payment_settlements, DELETE cart_items…, UPDATE checkout_sagas SET state='local_committed',
                publishStatement(OrderCreated), publishStatement(AuditRecorded) ])   # policy acceptance recorded via RPC before, idempotent
     failure → compensate 3–5 → saga.fail → 500 (nothing persisted)
  7  LEDGER.commitHoldAndDebit(usd), LEDGER.settlePoints(pts), INVENTORY.confirm(opId)   # idempotent; failures retried by the sweep
  8  UPDATE checkout_sagas SET state='done'; waitUntil(bus.pump)
  9  return orderPublic(order)              # same shape as today
sweep (cron, every minute): 'started' older than 2 min → compensate → 'compensated';
                            'local_committed' → retry step 7 → 'done'; after 10 failures → 'stuck' → alert (never auto-compensates a persisted order)
```

Invariants pinned by `tests/checkoutSaga.test.ts` (new) with crash injection after each step: (a) an order row exists ⇔ an approved debit exists or the saga is `local_committed` and retryable; (b) no hold stays `active` for an order that does not exist; (c) stock reserved ⇔ order exists or reservation released; (d) replaying with the same idempotency key returns the same order and creates nothing. Rows, ids and `wallet_transactions` semantics are identical to today's batch, which is what makes the `CHECKOUT_SAGA` flag safe to flip per request (10% → 100%). Post-commit effects (`initOrderStage`, invoice, printer gift, Telegram — `orders.ts:1525-1575`) become `OrderCreated` consumers. Store checkout (B4), escrow (B6/B14), membership purchase (B9) and cancel/refund (B2/B3) follow the same shape with their existing keys (`02-MIGRATION-PLAN.md`, Appendix E of the plan).

---

## 7. Realtime (Durable Objects behind an adapter)

| Flow | Today | Durable Object (when provisioned) | Degradation until then |
|---|---|---|---|
| Chat rooms | `GET /api/chats/:id/messages` polling | `CHAT_ROOM` per chat: WebSocket hibernation, fan-out, typing/presence, unread counters; messages persisted by the DO | polling stays; SPA uses WS when `/api/auth/capabilities.realtime === true` |
| Presence | none | inside `CHAT_ROOM` + `PRESENCE` per user | none |
| Order status push | tracker polling | `ORDER_WATCH` per user subscribed to `OrderStatusChanged`/`StageChanged` | polling stays |
| Notification bell | `/unread-count` poll (`NotificationBell.tsx`) | `INBOX` per user fed by the Notifications consumer | poll stays |
| Telegram login challenge | poll up to 240/min/IP (`auth.ts:1271`) | `TG_CHALLENGE` per challenge; webhook resolves → wake | poll stays under the gateway `auth` class |
| Locks / coordination | CHECK-abort tricks, revision fences | `WALLET_LOCK`, `STOCK` (per product), `CHECKOUT_SESSION` (per user), `PUMP_LOCK` | fences + conditional writes (§6.4); `checkout_sagas UNIQUE(user_id) WHERE state IN ('started','local_committed')` |
| Concurrent state | cart reloads whole cart; farm 20-s poll | `CART` per user (delta responses), `PLAYER` per farm player | as today |
| Rate limiting | D1 fixed window | `RateLimitCounter` | memory + D1 |

Adapter `RealtimeHub { publish(channel, msg) }` with `NoopHub` / `DoHub`; producers always call `hub.publish`. DO classes use SQLite storage (`durable_objects.bindings` + `migrations[].new_sqlite_classes`) declared in the owning Worker's wrangler and not deployed until the namespace is approved.

---

## 8. Long-running processes (Workflows behind an adapter)

| Process | Today | Workflow (when provisioned) | Interim |
|---|---|---|---|
| Pre-order/order stages (`next_stage_at`) | cron step 11 `sweepDueStages` | `ORDER_STAGES` per order: `do('init')`, `sleepUntil(next_stage_at)`, `do('advance')`, `waitForEvent('manual_stage')`, retries `{limit:5, delay:'30s', backoff:'exponential'}` | Fulfilment's own `*/15` cron runs `sweepDueStages` verbatim, settings preloaded once per run |
| Courier sync (Al-Waseet) | cron step 12, ≤100 sequential 15-s calls | `DELIVERY_SYNC` per shipment, or Queue fan-out | Fulfilment cron with concurrency 5 and a 60-s budget per run |
| Points accrual release | cron step 7 | `POINTS_RELEASE` per order: `sleepUntil(available_at)` → `LEDGER.releasePoints` | Ledger cron (moved verbatim), batched by order ids |
| Support-gift reconciliation | cron step 10 | `GIFT_RECONCILE` per entitlement | Referrals cron |
| KYC review / retention | manual; retention never set | `KYC_REVIEW`: `waitForEvent('decision',{timeout:'30d'})` → `sleepUntil(retention_until)` → purge | KYC cron once retention is decided (DECISIONS row 24) |
| Subscription lifecycle | write-on-read expiry | `SUBSCRIPTION_LIFECYCLE` per membership | Subscriptions cron computes expiries and emits `SubscriptionChanged` |
| Import / template apply | synchronous, two batches per product | `IMPORT_APPLY`: parse → plan → apply per product (idempotent on `import_id,row`) → images via Queue | job id + poll endpoint (additive); `waitUntil` chunks |
| Checkout saga completion | none | `CHECKOUT_SAGA` for stuck sagas | Commerce cron sweep every minute |
| Escrow auto-complete / request expiry | missing consumer | `ESCROW_AUTOCOMPLETE` with `sleepUntil(auto_complete_at)` | Marketplace cron (new job) |
| Outbox message delivery | cron step 1 + `waitUntil` pumps | Queue consumer | Notifications cron + pumps |
| Withdrawal lifecycle | endpoints + reconciliation flags | `WITHDRAWAL_LIFECYCLE` | today's endpoints; cron for stale flags |

Adapter `ProcessRunner { start(name, input) }` with `CronSweepRunner` (records the intent in the owning table; the sweep does the work) and `WorkflowRunner` (`env.<WF>.create({id, params})`); the same step functions serve both. Every service gets its **own** cron trigger (free per Worker), which dissolves `lib/jobs.ts`'s 13-step single cron step by step; the core keeps a step until its owner has taken it, guarded by `LEGACY_DISABLED_STEPS` so nothing runs twice and the old behaviour is one var away.

---

## 9. Ads and Analytics

### 9.1 Ads (`levonis-ads`)

```ts
interface AdsProvider {
  readonly name: 'meta_capi'|'google_ads'|'tiktok'|'snapchat'|'noop';
  configured(env): boolean;                                   // secrets present
  map(event: EventEnvelope, consent: ConsentState): ProviderEvent|null;
  send(events: ProviderEvent[], opts: { timeoutMs; correlationId }): Promise<{ accepted; rejected; error? }>;
}
```

- Providers `MetaConversionsApi` (server events; hashed `em`/`ph`; `event_id` = our `event_id` for Pixel dedup), `GoogleAdsOfflineConversions`, `TikTokEventsApi`, `SnapchatConversionsApi` — all stubs that validate mapping and write `ads_deliveries(status='sandbox')` when their secrets are absent; `NoopProvider` default. Mapping (`ads_event_map`, seeded): `PurchaseCompleted → Purchase`, `UserCreated → CompleteRegistration`, `AddToCart → AddToCart`, `CheckoutStarted → InitiateCheckout`, `ProductViewed → ViewContent`, `SubscriptionChanged{active} → Subscribe`.
- PII: Ads never receives `pii_class='personal'` envelopes (the bus refuses to deliver them to consumers with `piiMax:'pseudonymous'`); hashing (SHA-256 of normalised email / E.164 phone) is done by the producer (Orders via `IDENTITY.lookupContacts`, in memory, never stored) so raw contact data never reaches Ads. Consent: `marketing_consent` (`none|analytics|ads`) profile column (new, default `none`) → `UserUpdated{consent}` → `ads_consent_snapshots`; without `ads` consent the delivery is recorded `no_consent` and not sent.
- Kill switches: `CONFIG.flag('ads.enabled')`, `ads.providers.<name>.enabled`, `ads.events.<type>.enabled`; emergency = unset the secret → sandbox. Timeouts 5 s, 2 retries with jitter on 5xx/timeouts, circuit breaker per provider (open after 5 consecutive failures, half-open after 60 s). Nothing in Orders/Checkout imports or knows any provider.

### 9.2 Analytics (`levonis-analytics`)

Consumes every `none|pseudonymous` event; stores allowlisted payload projections in `analytics_events` (own D1 → `analytics_engine_datasets: EVENTS_AE` via the `AnalyticsSink` adapter); maintains `analytics_daily_platform(day, metric, value)` and `analytics_daily_merchant(day, merchant_id, metric, value)` idempotently by `processed_events`. Replaces over time: `admin.ts:125-159` overview aggregates, `merchant.ts:1443-1487` merchant analytics, the dead `merchant_store_analytics_daily`. Actor ids are hashed with a daily salt; every field annotated `pii` is dropped at ingest. Never on the hot path.

---

## 10. Frontend

| Leaves the bundle / changes | Where it goes |
|---|---|
| `ORDER_TRANSITIONS` mirror in `src/pages/Admin.tsx:44-51` | server returns `allowed_transitions[]` on order detail |
| Price arithmetic in `CardPrice`, cart/checkout summaries | the server's `quote` responses carry every displayed number; a lint rule (new) bans money math in `src/` outside `format*` helpers |
| Role branching (`isAdmin`, `can_view_financials`) | stays as UX hints only; `/api/auth/me` gains a `capabilities: string[]` array so the UI hides/shows by capability, never by role logic |
| Third-party avatar leakage (`Header.tsx:83` dicebear) | avatar placeholder served by Files or bundled SVG |
| Code splitting (Phase 1, pure frontend) | `React.lazy` for the 20 admin panels statically imported in `src/pages/Admin.tsx:5-26` and for `Admin`, `MerchantDashboardPage`, `Wallet`, `Checkout`, `StoreCheckout`, `Requests`, `Chat(s)`, `Warranty*`, `Invest*`, `Tools`, `Rewards`, `Referrals`; Vite `manualChunks`: `vendor-react`, `vendor-motion` (`gsap`, `motion`, `ogl`), `vendor-charts` (`recharts`, admin only), `vendor-phone` (`libphonenumber-js`), `vendor-qr` (`jsqr`), `vendor-i18n` (`translations.ts` split per language); `tests/bundleBudget.test.ts` (new) fails above 350 KB gzip for the entry chunk or 250 KB for any route chunk (today: 2.96 MB / 817 KB gzip) |
| Payload slimming (additive endpoints) | `GET /api/auth/me?fields=core` without `profile_json`; `GET /api/wallet/summary` (balances + last 20) replaces the 500-row default; cursor pagination on lists; `GET /api/home` cached at the gateway; later `GET /api/v1/boot` (host resolve + capabilities + boot settings in one call) |
| API versioning | today's paths keep working; new endpoints under `/api/v1/<service>/…`; `src/lib/api.ts` gains `apiV1(path)`; `x-api-deprecated: <date>` marks legacy paths once a v1 replacement exists; contract types in `packages/contracts/src/http/<service>.ts` (type-only imports; `tests/store-isolation.test.ts` extended to forbid runtime imports from `services/`) |
| i18n / subdomains | ar/en/ckb handled by the SPA as today; `Accept-Language`/`?lang` only affect gateway cache keys; `/api/storefront/resolve` keeps answering on every hostname |

---

## 11. Observability and operations

### 11.1 Structured logs

```json
{"ts":"2026-09-07T10:00:00.123Z","level":"info","svc":"commerce","ver":"<git sha>","env":"production",
 "cid":"018f…","rid":"req_…","hop":"gateway>commerce","principal":{"sub":"usr_…","role":"customer"},
 "route":"POST /api/orders","status":200,"dur_ms":41,"db_ms":12,"db_stmts":3,
 "rpc_out":[{"to":"ledger","m":"commitHoldAndDebit","ms":9}],"msg":"checkout.saga.step","step":"ledger.hold","outcome":"applied"}
```
Never logged: tokens, cookies, secrets, full emails/phones, request bodies of auth/KYC/wallet routes. `console.log(JSON)` → Workers Logs (`observability.enabled` already on); `tail_consumers` to a log-sink Worker is a later option.

### 11.2 Correlation
Gateway mints `cid`; every RPC passes `ctx.cid`; every envelope carries `correlation_id`; consumers set `causation_id` on events they emit; responses carry `x-correlation-id`; the SPA shows it on error toasts ("reference: …").

### 11.3 Health
Every service: RPC `health(): {ok, svc, ver, checks:{db, outbox_lag_s, deps[]}}` and HTTP `/health` on its dark URL. Gateway `/api/health` shallow as today; `?deep=1` (admin, apex) fans out with a 2-s budget. Deploy workflows probe `/health` after deploying.

### 11.4 Metrics
Log-line metrics today (`metric:` fields), `analytics_engine_datasets` later. Golden signals per service: request count/latency/error by route class, RPC latency by method, outbox lag, DLQ depth, saga in-progress count, ledger reconciliation anomalies, gateway cache hit ratio. SLOs: gateway p95 added latency < 150 ms; checkout saga p95 < 600 ms; bus delivery p95 < 5 s; DLQ = 0 (alert > 0); oldest pending event < 5 min.

### 11.5 Timeouts, retries, circuit breakers
Every external `fetch` goes through `fetchWithBudget(url, init, {timeoutMs, retries, retryOn, ssrfGuard})` (`lib/fetchGuard.ts` moves into it): Resend 8 s/2, Telegram 5 s/2, Al-Waseet 15 s/0, Google JWKS 3 s/1, Turnstile 3 s/1, ads 5 s/2; a lint rule makes bare `fetch(` outside the platform kit an error. RPC: 3-s default budget (10 s for import/media), retries only for idempotent commands (all money commands are), never for forwarding a mutating HTTP request. Circuit breaker per (service, method) and per provider: open after 5 consecutive failures, half-open after 30 s; open → `503 DEPENDENCY_UNAVAILABLE`; money commands are never skipped on an open breaker — they fail the request.

### 11.6 Deploy pipeline, environments, secrets, rollback
- Monorepo (`npm workspaces`): `services/<name>/{wrangler.jsonc, package.json, src/, migrations/, OWNERSHIP.json, SECRETS.md, tests/}`, `packages/{platform-kit, contracts, pricing, shipping}`, `worker/` (core, in place), `src/` (SPA), `studio/` (unchanged). `npm run check` iterates workspaces (reusing the `scripts/check-studio.mjs` pattern) and runs the boundaries, least-privilege, ownership, schema, naming and bundle-budget tests.
- One reusable workflow `.github/workflows/_deploy-worker.yml` (new) + one `svc-<name>.yml` per Worker, display names `2x - Deploy DARK levonis-<svc>-dark (serves no domain)` / `3x - Deploy LIVE levonis-<svc>` with a confirmation phrase, all satisfying `tests/workflowNaming.test.ts` (extended). Steps: `npm ci` → `npm run check && npm run test:unit` → resolve resource ids by name (`wrangler d1 list --json`, as workflow 7) → carry the running Worker's vars forward (`scripts/prepare-deploy-config.mjs` logic extracted to `scripts/lib/preserve-vars.mjs`, new) → apply **that service's** migrations before code → `wrangler deploy -c services/<name>/wrangler.jsonc --env <env>` → upload only the secret names in `SECRETS.md` from repository secrets `<SVC>__<NAME>` → probe `/health` → dark only: run the integration corpus → record the deployment id.
- Workflows 7 and 8 stay the live paths for the core and Studio; workflow 7 gains only the core's new additive `services` bindings once approved. `2 - Rebuild levonis-staging + run API tests` is re-pointed at the dark stack so test users never land in the live DB again (owner decision).
- Secrets: per Worker, uploaded by that Worker's workflow only; rotation = add `<NAME>_NEXT`, deploy code accepting both, switch, remove; `secrets_store_secrets` bindings when the account has a Secrets Store.
- Rollback: (a) code — `wrangler rollback` per Worker or redeploy the previous commit; (b) routing — kill switch or re-point a gateway binding/prefix to `CORE` (seconds); (c) cut-over — dashboard route back to `levonis-staging` (minutes); (d) data — additive migrations only, never a down-migration; a service whose tables moved keeps dual-read for one phase.
- The Workers Builds Git integration on `levonis-staging` is disconnected (owner action) once the gateway is in front (SUBDOMAIN_ARCHITECTURE.md §7.5.3).

---

## 12. What "nothing deleted or broken" means operationally

- Every path mounted in `worker/index.ts` keeps its method, path, envelope and status codes; `tests/routeTable.test.ts` (new) snapshots the mounted table of the core plus every service and fails on removal. 410s only by owner decision and they answer forever, as `index.ts:190-196` does.
- Every table and column stays; migrations `0055+` are additive.
- Every cron step keeps running somewhere (moved verbatim, flag-guarded so it never runs twice).
- Every row keeps its meaning: the saga writes the same ids and statuses as the batch; ledger rows keep their shapes; no phase requires a backfill.
- ar/en/ckb and merchant subdomains: `Host` forwarded untouched, the classifier is the same code, the cookie attributes the same function; `verify-subdomains.yml` runs at every flip.

---

## Appendix A — Provenance of this synthesis

Two designs were judged: **transactions-first** (`scratchpad/msa/design-transactions-first.md`) and **domain-first** (`scratchpad/msa/design-domain-first.md`). Scores (safety / independence / money correctness / Cloudflare fit / zero-trust / executability): transactions-first 9/6/9/8/8/8 = 48; domain-first 6/9/7/7/9/5 = 43. Transactions-first is the base; the following came from domain-first:

| Grafted idea | Where it lands |
|---|---|
| Merged deployables host **separate packages with separate contracts and self-bound named entrypoints**, so a split is config + table move | §1.2 legend, ADR-004 |
| **Search and Risk as real Workers with their own D1 from the start** (not modules inside Catalog/Ledger) | §1.2 rows 16, 19; Phase 4 |
| Route **kill switch without a deploy** (`ROUTE_OVERRIDES` → KV) | §3.3, §11.6 |
| Per-field **`pii` annotations** on event schemas in addition to the envelope's `pii_class` | §5, `03-EVENTS.md` |
| `Uow` refuses to commit a publishing command without its outbox statement | §5, ADR-005 |
| Files/Media as **the only Worker bound to the bucket** in the end state, with signed read URLs | §1.2 row 15, §2.4 |
| Money methods force an idempotency key **and** an audit record before success | §4 item 7 |
| SPA `capabilities` array, money-math lint, `x-levonis-legacy-path` usage header, `/api/v1/boot` composite | §3.2, §10 |
| Consent model and Ads PII hashing done by the producer | §9.1 |
| Per-route Turnstile hook list incl. deposit request | §3.8 |

From transactions-first (kept as the spine): contract → code → data; the tolerance list that only shrinks; core named entrypoints so bindings target the core before the code moves; the checkout saga built in-core behind `CHECKOUT_SAGA`; `PRINCIPAL_MODE=shadow`; Identity-signed principals; POINT staying with the journal; `ledger_idempotency` + `ledger_balances` fence; the RPC fan-out bus inside each producer (no central bus Worker); the parity corpus; the phase order and gates.
