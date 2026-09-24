# Audit 01: Merchant workspace and storefront

Repo: `/home/user/Levonis` at `234f5e3`. The audit was read-only and the repo was not modified (`git status` is clean).
Date: 2026-09-24.

**How the findings were checked.** Every bug in §6 marked **[PROBE Pn]** was reproduced against the real routes and a real SQLite database built from every migration. The probes use the repo's own harness (`tests/fixtures/app.ts`). The probe file lives outside the repo, at
`/tmp/claude-0/-home-user-Levonis/b8dbc69e-c19d-551a-b0ad-1fc786eec60b/scratchpad/merchant-audit/probes.test.ts`.
Run it from the repo root with `node --import tsx --test <that file>`. Result: **15/15 pass**, and a pass means the defect is real.

The existing suites for this area are all green: storefrontIsolation, store-isolation, merchantOps, hosts, webManifest, merchantOrderStatus, merchantCartSeparation, storefrontBatchA_E and reservedSubdomains, **133/133**.

---

## 0. Executive summary

- **The server security foundation is strong and should be kept.**
  - Every `/api/merchant/*` route resolves the caller's store from the session and puts the owner scope in the WHERE clause.
  - Platform admin is apex-only.
  - Host classification is pure and tested.
  - Media references are ownership-checked.
  - No merchant string reaches CSS or HTML.
  - Pricing is server-side, and the cart takes one seller per checkout.
- **No IDOR was found in `/api/merchant/*`, `/api/storefront/*` or the store-order and cart merchant routes.**
- **The money and state logic of store orders has real defects:**
  - A merchant can cancel a prepaid order, and the buyer is **not refunded** (P1).
  - A lapsed-PLUS merchant keeps taking orders (P3).
  - Stock and coupon caps are not real guards (P6, P7).
  - A merchant self-certifies delivery to release their payout (P12).
- **Moderation and lifecycle state can be overwritten.** An admin hide is not sticky (P9). An admin merchant-status change lifts store suspensions (P8). A suspended store cannot save any settings (P4).
- **Legacy `/api/community/my-store/products` bypasses every store rule** (P10, P11).
- **Against the target, the "Store Builder" does not exist.**
  - The storefront is one fixed profile skeleton, with 7 accent presets, 3 link pills and 3 info cards.
  - There are no themes, blocks, draft, preview, publish or versions.
  - Delivery is one flat fee plus a free-over threshold, with no per-governorate pricing.
  - The per-host PWA manifest exists, but there are **no merchant icon renditions**. Installed merchant apps show the Levonis icon in the common case.
  - The workspace is a 15-pill horizontal tab strip in a 3xl column: no sidebar, no URL routing, no command center.

---

## 1. Data model

### 1.1 Identity and store tables

| Table | Migration | Key columns / constraints | Notes |
|---|---|---|---|
| `community_merchants` | `0001_init.sql:247-255`, extended `0030:43-59` | `id` PK; `user_id` **UNIQUE** → users (CASCADE); `name`, `bio`, `avatar_key`, `verified` (admin-only). 0030 adds `status` (active\|restricted\|suspended, **no CHECK**), `status_reason`, `status_changed_at`, `phone`, `governorate`, `badge`, `badge_override`, `reputation_score`, `rating_avg_x100`, `rating_count`, `completed_orders`; `idx_community_merchants_status` | The trading entity. One per user. Two id styles exist: `cm_<hex>` from `community.ts:306` and `mch_<hex>` from `merchant.ts:206`. `restricted` has no effect anywhere (see B8). |
| `merchant_stores` | `0030:66-104`, `0037:14-15` | `id` PK; `merchant_id` **UNIQUE** → community_merchants (CASCADE); `user_id` (denormalised owner) → users; `slug` **UNIQUE**; `name`, `tagline`, `description`, `logo_key`, `banner_key`, `accent` (preset **name**), `categories` JSON, `governorate`, `service_areas` JSON, `contact_phone`, `contact_phone_public`, `business_hours` JSON, `policies` JSON map, `delivery_settings` JSON, `social_links` JSON, `accepts_custom_requests`, `sells_direct_products`, `status` CHECK(active\|paused\|suspended), `status_reason`, timestamps; 0037 adds `profile_links`, `profile_facts` JSON; `idx_merchant_stores_user`, `idx_merchant_stores_status` | Exactly one store per merchant, enforced by the UNIQUE. All appearance and settings data is opaque JSON on the store row. There is no theme, page or layout table. |
| `merchant_store_slugs` | `0030:109-116` | `slug` PK; `store_id` → stores (CASCADE); `active`; `reserved_until`; `idx_merchant_store_slugs_store` | Slug history and 180-day parking (`merchantOps.ts:90`). **Nothing reads it for redirects** (B14). |
| `reserved_slugs` | `0030:122-139` | `slug` PK, `reason`; seeded with 53 names | DB-level business reservations. The code-level list is `SYSTEM_SUBDOMAINS` (138 names, `hosts.ts:56-98`), checked first. |
| `merchant_notification_preferences` | `0030:142-154` | `merchant_id` PK; 9 boolean switches | Only `request_opportunities` is read (`printMatching.ts:296`, `printRequests.ts:983-986`). `notifications.ts:5` itself says the rest are switches "that nothing reads". |
| `merchant_store_analytics_daily` | `0030:262-278` | PK (`store_id`, `day`); views, orders, money, offers, followers | **Dead table.** No code reads or writes it (grep over `worker/` and `src/`). |
| `merchant_request_prefs` | `0045:122-146` | `merchant_id` PK; filters (processes, materials, colors, capabilities, governorates, delivery, job size range, workload, paused) | Print-request matching preferences (PrintersTab). |
| `merchant_printers` | `0045:79-114`, extended `0078:124-137` | `id`; `merchant_id` (CASCADE); `store_id`; build volume, technology, nozzle, materials/colors JSON, enclosure, hardened nozzle, quality_max, machine_hour_iqd, availability, active, sort; 0078 adds model_id → printer_models, purchase/residual/useful hours, maintenance/electricity/labor rates, hours_printed, multi_material, toolhead_count | This is the 3D-printing differentiator. It feeds matching and the quote engine. |
| `merchant_spools` | `0078:173-191` | merchant_id, material_id → print_materials, purchase_iqd, grams, remaining | Cost basis for the costing tab. |
| `printer_models`, `print_materials`, `print_quotes`, `print_quote_cost_components`, `print_actuals`, `print_failures`, `printer_calibration_stats` | `0078:28-431` | Quote engine | Adjacent. Consumed by CostingTab. |

### 1.2 Catalogue, merchandising, content

| Table | Migration | Key columns / constraints | Notes |
|---|---|---|---|
| `community_products` | `0001:257-271`, `0030:163-186`, `0036:32-35`, `0056:74` | `id`; `merchant_id` (CASCADE); `slug` **globally UNIQUE**, namespaced as `<storeSlug>-<name>-<6hex>` (`merchant.ts:673`); `status` CHECK(active\|hidden) (0001); `lifecycle` (draft\|active\|hidden\|sold_out\|archived, **no CHECK**, kept in step with `status` by code); `store_id` → stores (CASCADE); `sku`, `stock`, `track_stock`, `category` (free text), `condition`, `options` JSON, `colors` JSON, `delivery_methods` JSON, `prep_days`, `sold_count`, `view_count`, `updated_at`; 0036 `section_id` (**no FK**, SET NULL in code), `featured`; indexes on (merchant_id), (store_id,status), (merchant_id,lifecycle), (section_id), (status) | `options`/`colors` are **schemaless merchant JSON** (`merchant.ts:641-642`). They are neither priced nor validated at cart, and the storefront never renders them. There is no variant, media or attribute table, and no 3D-print attributes. Product scoping is by `merchant_id`; every other child table is scoped by `store_id`. |
| `merchant_store_sections` | `0036:18-28` | `id`; `store_id` (CASCADE); `name`, `name_ar`, `sort_order`, `active`; idx (store_id, sort_order) | **These "sections" are product shelves, i.e. collections, not page sections.** Capped at 30 per store (`merchant.ts:1655`). |
| `merchant_services` | `0036:42-61` | store_id, merchant_id, title, description, kind CHECK(print_service\|design\|finishing\|scanning\|repair\|other), `price_from_iqd` (nullable = "ask"), price_unit, materials JSON, image_key, active, sort | "Starting from" adverts. Quotes happen through the (currently closed) request board. |
| `merchant_showcase` | `0036:67-79` | store_id, kind CHECK(printer\|material\|work), title, details, image_key, sort, active | Workshop wall. |
| `merchant_coupons` | `0036:88-106` | store_id, merchant_id, `code` (UNIQUE per store), kind CHECK(fixed_iqd\|percent), value>0, min_total_iqd, max_uses, used_count, active, starts_at, ends_at | Code, kind and value are immutable after creation (`merchant.ts:2019-2020`). No product or collection targeting. |
| `community_product_favorites` | `0038:6-13` | PK (user_id, product_id), CASCADE both | Storefront heart. |
| `follows` | `0001:282-287`, `0031:311-314`, `0037:19` | PK (user_id, merchant_id); notify_* flags | Keyed to the merchant, not the store. |

### 1.3 Commerce and money (store path)

| Table / columns | Migration | Notes |
|---|---|---|
| `cart_items` rebuilt | `0030:198-235`, partial unique indexes `0032:98-105` | CHECK: a line is exactly one of levonis or merchant, and a merchant line carries merchant_id+store_id. The merchant line key is (user, community_product_id, option_id, color_id). |
| `orders` merchant columns | `0030:240-254`, `0036:110-111`, `0064:54` | `seller_type`, `merchant_id`, `store_id`, `origin` (platform\|store_product\|community_request), `community_order_id`, commission snapshot (`commission_percent_x100`, `platform_fee_iqd`, `merchant_receivable_iqd`), `coupon_code`, `coupon_discount_iqd`, and per-user idempotency unique index. Indexes are `idx_orders_merchant` and `idx_orders_store_status`. The store path writes `stage='received'` once and never advances it (B11). |
| `order_items` | `0030:256-257` | `community_product_id` (**no FK**) and `seller_type`. `option_snapshot` holds raw client ids (B13). |
| `merchant_payout_ledger` | `0031:187-204` | kind CHECK(sale_credit\|community_order_credit\|refund_debit\|commission\|manual_adjustment\|payout\|reversal); `state` CHECK(pending\|available\|reserved\|paid\|reversed); `idempotency_key` UNIQUE (global). The balance is `SUM` grouped by state (`escrowOps.ts:646-663`). **Rows are state-mutated** (`merchant.ts:1357-1361`, `1401-1404`), which contradicts the "append-only" claim in docs. |
| `merchant_reviews` | `0031:210-233` | One per order or community order (partial unique indexes). One merchant reply (`merchant.ts:1495-1499`). |
| `merchant_reputation_events` | `0031:238-253` | Append-only events. |
| `community_complaints` (+messages), `community_orders`, `community_offers`, `community_escrows` | `0031` | Request/escrow path. Adjacent. |
| `chats` context | `0031:302-308` | `merchant_id`, `store_id` and context columns. Order chat via `/api/chats/open {orderId}` is properly authorised (`chats.ts:98-144`). |

### 1.4 Relationships (today)

```
users 1─1 community_merchants 1─1 merchant_stores 1─* merchant_store_slugs (history)
                        │                 ├─* merchant_store_sections ──(section_id, no FK)── community_products
                        │                 ├─* merchant_services / merchant_showcase / merchant_coupons
                        │                 └─ (JSON on row) accent, profile_links/facts, policies, hours, delivery_settings
                        ├─* community_products (merchant_id; store_id nullable for legacy rows)
                        ├─* merchant_printers ─ printer_models ; merchant_spools ─ print_materials
                        ├─* merchant_payout_ledger ; merchant_reviews ; merchant_reputation_events
                        └─* follows (user↔merchant)
orders (seller_type='merchant', merchant_id, store_id) 1─* order_items (community_product_id, no FK)
```

- **Tenant key inconsistency.** Products, orders, payouts, reviews, printers and follows are scoped by `merchant_id`. Sections, services, showcase and coupons are scoped by `store_id`. This only works because `merchant_stores.merchant_id` is UNIQUE.
- **Legacy products.** Rows created via `/api/community/my-store/products` have `store_id NULL`. They are never sellable (`cart.ts:2136-2143` joins through the store) and never appear on the subdomain.
- **Auto-provisioned stores.** 0039 (`0039_backfill_legacy_stores.sql:21-46`) gave every pre-store merchant an `m-<hex>` slug and a **paused** store. It switched stock tracking off on their legacy products.

---

## 2. API surface

Legend:
- **Own** means `requireStoreOwner`: the store is resolved from `session.user.id`, with no id in the path or body (`merchantAuth.ts:164-174`).
- **Sell** means `requireSellingPrivileges`: Own, plus merchant not suspended, store not suspended or paused, and `merchantStore` entitlement active (`merchantAuth.ts:185-206`).
- Every `/api/merchant/*` route also passes `requireAuth` (`merchant.ts:46`, `merchantPrinters.ts:35`).
- Ownership of child rows is always a `WHERE … AND merchant_id = ?` or `AND store_id = ?` bound from the session context.

### 2.1 `/api/merchant/*` (worker/routes/merchant.ts)

| Line | Method & path | Guard | Inputs | Ownership / risk notes |
|---|---|---|---|---|
| 132 | GET `/slug-check` | auth; 60/min | `slug` | Advice only. Re-checked on write. |
| 141 | GET `/me` | auth | none | Returns entitlement flags (`can.*`), own store, `selling` reason, suggested slug. |
| 178 | POST `/onboard` | auth; community gate; `merchantStore` entitlement; 5/h | name, slug, tagline, description, governorate | Creates merchant, store, slug row and prefs in one batch. A slug race produces a raw 500 on UNIQUE (B24). |
| 257 | PATCH `/store` | **Own** (30/5min) | name, tagline, description, governorate, phone(+public), toggles, `logo_key`/`banner_key` (**ownedMediaKey**, 400 if foreign), `accent` (oneOf 7 presets), categories/service_areas (lists), `business_hours` (sanitised rows), `policies` (map), `social_links` (http(s) only), `profile_links`/`profile_facts` (≤3, closed icon set, http(s) url), `delivery_settings` (fee_iqd, free_over_iqd, note), `open` | UPDATE `WHERE id=? AND user_id=?`. **`open:true` needs only Own, so a lapsed merchant re-opens** (B3). **Any `open` on a suspended store makes the whole save 403** (B4). |
| 470 | POST `/store/slug` | **Sell**; 3/day | slug | Parks the old slug for 180 days. The old host then 404s with no redirect (B14). |
| 510 | GET `/products` | Own | bare cursor mode, or `?page=` mode with q, section, lifecycle, stock, category, price range, days, featured, deals, sort (whitelist via `pickFrom`) | `merchant_id = ?`. Fully parameterised. |
| 663 | POST `/products` | **Sell**; 60/h | name, name_ar, desc(_ar), price, original price, sku, stock, track_stock, category, condition, prep_days, images (**ownedMediaUrls**, silently filtered, ≤8), `options`/`colors` (**any JSON**, sliced to 20/30), delivery_methods, lifecycle, featured, section_id (assertOwnSection) | Client-trust: options/colors are arbitrary JSON published raw (`storefront.ts:100-101`). |
| 706 | PATCH `/products/:id` | **Sell** | same, partial | `WHERE id=? AND merchant_id=?`. Can **re-activate an admin-hidden product** (B9). A lapsed merchant cannot even *unpublish* here (needs Sell), only DELETE/archive. |
| 737 | POST `/products/:id/duplicate` | Sell | none | Copies as draft. Scoped. |
| 771 | GET `/products/stats` | Own | none | Weekly creation buckets and 14-day sales (excludes cancelled). |
| 839 | GET `/products/:id/insights` | Own | none | Scoped. Excludes cancelled. |
| 875 | GET `/products/export.csv` | Own | none | ≤2000 rows with a truncation header. No formula-injection neutralisation (self-export only, low risk). |
| 922 | POST `/products/import` | **Sell**; 10/h | csv text ≤400 KB, ≤200 rows, confirm flag | Preview then commit. Rows are created as **drafts**. **All rows share one `created_at`** (B5). |
| 1043 | DELETE `/products/:id` | Own | none | Archives if ever ordered, else deletes. The `order_items` count is unscoped but harmless (the write is scoped). |
| 1070 / 1098 | GET/PATCH `/notifications` | Own | 9 booleans | 3 are forced on. Mostly unread server-side. |
| 1134 | GET `/subscription` | Own | none | Membership history and per-benefit flags. |
| 1177 | GET `/followers` | Own | cursor | Display name and username only. |
| 1211 | GET `/orders` | Own | status, cursor | `o.merchant_id = ?`. |
| 1246 | GET `/orders/:id` | Own | none | Named-column item list (no cost leak, `merchant.ts:1260-1281`). Address and phone come from the order snapshot. |
| 1331 | POST `/orders/:id/status` | **Own** (not Sell); 120/h | status ∈ flow `pending→confirmed→processing→shipped→delivered`, cancel from first 3 | Conditional flip. On `delivered`: ledger pending→available, reputation and completion counted once. On `cancelled`: ledger reversed, **buyer not refunded** (B1). Self-declared delivery releases payout (B11). |
| 1440 | GET `/payouts` | Own | none | Balance from SUM plus the last 100 entries. |
| 1456 / 1489 | GET `/reviews`, POST `/reviews/:id/reply` | Own | reply ≤1500 | One reply, `WHERE merchant_id=? AND merchant_reply=''`. |
| 1513 | GET `/customers` | Own | none | Built from own orders. Lifetime value **includes cancelled** (B12). |
| 1538 | GET `/analytics` | Own + `merchantAnalytics` entitlement | none | Gross, fees and receivable **include cancelled** (B12). A lapsed merchant gets 403 on the default tab (B17). |
| 1637-1689 | GET/POST/PATCH/DELETE `/sections[/:id]` | Own | name, name_ar, sort, active | `store_id = ?`. Delete ungroups products in the same batch. |
| 1756-1809 | GET/POST/PATCH/DELETE `/services[/:id]` | GET/PATCH/DELETE Own; POST and re-activation Sell | title, desc, kind, price_from, unit, materials, image_key (owned) | Scoped by store. |
| 1835-1902 | GET/POST/PATCH/DELETE `/showcase[/:id]` | Own | kind, title, details, image_key (owned), sort, active | Scoped by store. Capped at 60. |
| 1955-2031 | GET/POST/PATCH/DELETE `/coupons[/:id]` | POST and activate Sell, else Own | code (3-30 `[A-Z0-9-]`), kind, value (percent ≤90), min_total, max_uses, dates | Scoped by store. A used coupon is deactivated rather than deleted. |
| 2055 | GET `/custom-orders/summary` | Own | none | Counts of community orders. |

### 2.2 `/api/merchant/*` (worker/routes/merchantPrinters.ts)

| Line | Endpoint | Guard | Notes |
|---|---|---|---|
| 87 | GET `/printers` | Own | Plus the material vocabulary from `admin_settings.printMaterials`. |
| 147 | POST `/printers` | Own | No per-merchant cap (minor). |
| 172 / 197 | PUT / DELETE `/printers/:id` | Own | `WHERE id=? AND merchant_id=?`. |
| 225 / 267 | GET / PUT `/request-prefs` | Own | Matching filters. |
| 326 | GET `/request-matches` | Own | Matched requests. |

### 2.3 Public storefront, `/api/storefront/*` (worker/routes/storefront.ts)

These are anonymous reads. Nothing is filtered by store open/suspended status; that is by design in `MERCHANT_STORES.md` §4, but see B20.

| Line | Endpoint | Notes |
|---|---|---|
| 157 | GET `/resolve` | Uses `c.get('host')` (classified once in `worker/index.ts:112-115`). Non-merchant host returns `{store:null}`. Unknown slug returns 404 `kind:'merchant'`. Slug history is not consulted (B14). |
| 179 | GET `/:slug` | `publicStore` plus `storeStats` (followers, product_count, positive %, deal_count). The phone is shown only if published. Hidden widgets are stripped. The delivery fee is not exposed, only the note. |
| 196 | GET `/:slug/sections` | Active sections that hold published products. |
| 216 / 240 | GET `/:slug/services`, `/:slug/showcase` | Active rows. |
| 260 | GET `/:slug/products` | `lifecycle='active' AND status='active'`, plus category, section and deals filters. **Keyset on `created_at` only** (B5). Stock is reported as `in_stock` boolean only. |
| 291 | GET `/:slug/products/:productSlug` | Store-scoped. Unthrottled `view_count+1` on every hit (B22). |
| 315 | GET `/:slug/reviews` | Distribution computed from rows. Same keyset issue. |
| 380 | GET `/by-id/:storeId` | Accepts a store id or merchant id (legacy links). |

### 2.4 Store checkout and cart (worker/routes/storeOrders.ts, cart.ts)

| Where | Endpoint | Guard | Notes |
|---|---|---|---|
| `cart.ts:2158` | POST `/api/cart/merchant-items` | auth | Reads product and store from D1. The one-seller conflict (`CART_SELLER_CONFLICT`) names both shops. **No entitlement check** (B3). `optionId`/`colorId` are free strings ≤60 chars (B13). |
| `cart.ts:2289, 2308, 2318, 2342` | GET `/scope`, GET `/merchant`, PATCH/DELETE `/merchant-items/:id` | auth | Scoped `ci.user_id = ?`. |
| `storeOrders.ts:252` | POST `/api/store-orders/quote` | auth | Server-side pricing. Delivery is the **flat store fee plus free-over** (`storeOrders.ts:224-230`). The wallet-coverage answer is in dinars. |
| `storeOrders.ts:323` | POST `/api/store-orders` | auth; 15/5min; idempotency key | Prepaid wallet only (hold, then commit inside the order batch). Commission snapshot. Conditional coupon and stock UPDATEs **do not abort the batch** (B6, B7). Pending `sale_credit`. Announces to the admin Telegram topic. **No merchant notification.** |

### 2.5 Other routes that touch the merchant area

- **Legacy profile API** (`worker/routes/community.ts`): GET/POST `/api/community/my-store` (277), POST `/my-store/products` (345), DELETE `/my-store/products/:id` (369). These stay reachable while the community is closed (`communityGate.ts:191-195`). They have **no store, entitlement, suspension or media rules** (B10). The UI for them is `src/components/MerchantDashboard.tsx`, mounted in `src/pages/EditProfile.tsx:216`.
- **Admin** (`worker/routes/adminCommunity.ts`, apex-only): merchant status (372), store status (429), product hide (462), and others. B8 and B9 live here.
- **Per-host documents**: GET `/manifest.webmanifest` (`worker/index.ts:396`, `routes/manifest.ts`), `/robots.txt`, `/sitemap.xml` (`routes/seo.ts`, merchant-scoped).

### 2.6 Isolation verdict

- **No IDOR.** Every mutating statement in the merchant routes binds the session-derived `merchant.id` or `store.id` in its WHERE clause. Reads of child rows are scoped the same way. `assertOwnSection` (`merchant.ts:655-661`) covers the one cross-row reference in a body.
- **Client-trust issues** are B3 (entitlement not enforced on the buy path), B13 (unvalidated variant ids) and the arbitrary `options`/`colors` JSON.
- **Cross-host.** `/api/admin/*` returns 404 on merchant hosts (`index.ts:220`, `hosts.ts:245-249`). The session cookie is shared across `.levonis-iq.com`. That is safe only while no merchant-controlled script can run.
- **CSP helps.** The SPA policy has `script-src 'self'` plus Google and Cloudflare (`securityPolicy.ts:113`).
- **CSP gaps.** `style-src 'unsafe-inline'` and `img-src https:` (`:114`, `:116`) mean CSP will **not** stop CSS-value injection or tracking pixels. Those are prevented only by the data rules (preset-only accent, owned media).
- **CSP and the builder.** The policy also sets `frame-ancestors 'none'` (`:122`). That matters for any iframe-based builder preview.

---

## 3. UI: what exists today

### 3.1 Workspace shell (`src/pages/MerchantDashboardPage.tsx`, 619 lines)

- **Routes.** On the apex it is served at `/merchant` and `/merchant/*` (`App.tsx:755-756`). On a store host it is served at `/admin` (`App.tsx:404`), inside the storefront shell.
- **The `/*` route does not route.** The active tab is React state (`MerchantDashboardPage.tsx:65`). There are no deep links, refresh resets the tab to Overview, and Back leaves the page.
- **Layout.** Single column, `max-w-3xl`, centered (`:140`). A header shows logo, name, Open/Paused chip, store URL and a "View store" button (`:141-182`). A "selling paused" notice shows when `!canSell` (`:185-195`).
- **Navigation is a horizontal scrolling pill strip of 15 tabs** in 5 groups (`:112-134`, `:197-214`): Overview · Products · Sections · Services · Showcase │ Orders · Custom orders · Coupons │ Reviews · Customers · Earnings │ Store setup · Printers · Print costing · Notifications.
- **Mobile and desktop.** On a phone about 3-4 pills are visible; the strip scrolls. Desktop gets the same narrow column. There is no sidebar, no breadcrumbs, and no global search or command palette.
- **Tab semantics and targets.** Tabs have no `role="tablist"`/`aria-selected`. Controls are 36-40 px (`ui.tsx`: `h-9`/`h-10`), below the 44 px touch guideline.
- **Tab bodies:**
  - **Overview (`:240-355`)**: 4+3 stat tiles from `/analytics` and custom-order counters. Quick actions link to the apex for `/requests` and `/chats`. Lapsed merchants see an error here (B17).
  - **Products**: `components/merchant/dashboard/ProductsManager.tsx` (1337 lines), the most mature screen.
    - Stat cards with real weekly sparklines.
    - Server-side filters and sort, and pagination with page size.
    - List, grid and compact views, remembered in localStorage (`:109`, `:155`).
    - ⌘K search, per-row menu (publish/hide, feature, duplicate, open, copy link, insights), CSV export and CSV import with preview.
    - The editor (`:1157-1337`) is a modal form: name, price, original price, stock, prep days, SKU, section, category, condition, featured, ≤8 images (`ImageGallery`), description, publish state.
    - **The editor is missing** name_ar/description_ar (supported by the API), options/colors/variants, delivery methods and any 3D-print attributes.
  - **Sections, Services, Showcase** (`CatalogTabs.tsx`, 563 lines): list and CRUD, reorder by sort, active toggles, image picker.
  - **Orders** (`SalesTabs.tsx:69-172`):
    - Status filter chips and cards with next-state buttons, including **Cancel**, which the server turns into B1.
    - The fulfilment detail (`:174-282`) shows buyer name, phone, address (copyable), lines with the raw `option_snapshot` (`:253`), totals, commission and net.
    - It has an "open chat about this order" button.
  - **Custom orders**: escrow-lifecycle start/deliver buttons. **Coupons**: create, activate/pause, delete (`SalesTabs.tsx:316-585`).
  - **Reviews, Customers, Earnings, Notifications** are inline in the page file (`:357-603`). Reply errors are unhandled (B18). Earnings shows 3 tiles and the last 100 ledger rows.
  - **Store setup** (`StoreSettingsTab.tsx`, 695 lines): see §3.3.
  - **Printers** (`PrintersTab.tsx`, 1487 lines): machines, request preferences and matches. **Print costing** (`CostingTab.tsx`, 593 lines): prices one model on each owned printer via `/api/print-quote/analyses/:id/compare`.
- **A second, legacy merchant dashboard still ships.** `src/components/MerchantDashboard.tsx` (606 lines) lives inside `/edit-profile`. It writes store-less products through the legacy API (B10).

### 3.2 Onboarding (`src/pages/MerchantStart.tsx`, 341 lines)

- **Gates.** The server's `/api/merchant/me` decides eligibility. If not eligible, the page shows a PLUS upsell. If the community is closed to the user, it shows `CommunityClosedCard`, because `/onboard` refuses new merchants during maintenance (`merchant.ts:185`, DECISIONS row 110). If a store already exists, it redirects to `/merchant`.
- **"One step".** Name, slug (400 ms debounced live check that shows the normalised slug), tagline, governorate and description.
- **Domain preview is hardcoded.** It shows `<slug>.levonis-iq.com` (`MerchantStart.tsx:231`).
- **After submit** it navigates to `/merchant` with `state.created`, which lands on the **Printers** tab (`MerchantDashboardPage.tsx:53-65`).
- **Missing:** a wizard, a checklist, progress, or prompts for logo, banner, first product, delivery, policies or open/publish.

### 3.3 How a store's look is customised today

This is `StoreSettingsTab.tsx`, and one "Save" PATCHes everything (`:88-144`).

- **Identity:** logo (square) and banner (wide) through `ImagePicker`. Uploads use purpose `community` and land at `merchants/<userId>/public/<id>.<ext>`, converted to WebP when the Images binding exists. There is no resizing and no renditions.
- **Colour:** one of 7 accent presets (`default, olive, gold, slate, plum, teal, blue`). The server allowlists them (`merchant.ts:347`) and the storefront maps them to classes (`Storefront.tsx:56-64`). No hex colour, font or layout can be set.
- **Profile header widgets:** up to 3 link pills and 3 info cards. Each has an icon from a closed set of 20 names (`merchant.ts:374-378`, `profileIcons.tsx`), a title, a url or subtitle, visible/hidden, and reorder by arrows.
- **Text fields:** name, tagline, about, governorate (select), contact phone (+public), categories and service areas (free chips), business hours (day/open/close rows), policies (title and text pairs, with 4 presets), social links (http(s) only), and flags for "sells products" and "custom requests".
- **Delivery:** one fee, one free-over threshold and one note.
- **Status and address:** Open/Paused toggle, hidden when suspended. A separate "Store address" card changes the slug with a live check.
- **Nothing else exists:** no themes, page sections or blocks, homepage layout, banners or carousels, custom pages, collection pages, menu or navigation editor, fonts, draft/preview/publish, or version history.

### 3.4 What the storefront renders (`src/pages/Storefront.tsx`, 1678 lines)

- **One fixed skeleton** (header comment `:1-21`, render `:252-545`), in this order:
  1. Cover image and back arrow. On a merchant host the arrow goes to the hardcoded `MAIN_SITE` (`:71`).
  2. The ⋯ menu (share, copy link).
  3. Avatar, name, verified seal, PRO badge, `@slug`, rating or badge.
  4. Three stats: positive %, products, followers.
  5. Bio.
  6. Three link pills.
  7. Three info cards, falling back to governorate, coverage and delivery note (`factsWithFallback`).
  8. A "not taking orders" banner when closed, with no reason given (`:403-414`).
  9. Contact and follow/share buttons.
  10. Tabs that render only when they have content: Products (featured first *within the loaded page*, 6 then "show all", load-more), Sections, Deals, Services, Showcase, About (policies, hours, coverage, socials) plus Reviews.
  11. "Install the app" card, only on the store's own host (`:530-543`).
- **Product page** (`StorefrontProduct.tsx`, 270 lines): images, price and deal, description, quantity, add to cart (`POST /api/cart/merchant-items` with **no option or colour selection**) and the seller-conflict dialog.
- **Checkout** is `/store-checkout` (`StoreCheckout.tsx`): server quote, address book, wallet-only.
- **Suspended stores keep full visibility.** A suspended or closed store still shows banner, logo, bio and every product. Only the order controls turn off (B20).
- **Legacy entry** (`CommunityStorePage.tsx`): `/community/store/:id` on the apex resolves a slug, store id or merchant id. It then either `location.replace`s to the subdomain, renders the same `Storefront` in-app, or builds a synthetic "profile-only" store for merchants that have no store row. `MerchantStore.tsx` survives only as its not-found state.

### 3.5 Subdomain routing to the storefront

The request flow is:

1. **DNS and route.** Wildcard DNS plus the Worker route `*.levonis-iq.com/*` send the request to the same Worker and bundle (`SUBDOMAIN_ARCHITECTURE.md` §7).
2. **Classify the host.** `worker/index.ts:112-115` runs `classifyHost(Host, rootDomainFrom(env))` once per request and returns `main`, `system`, `merchant` or `foreign`.
   - Control characters are refused.
   - Only one label deep is accepted.
   - The 138 `SYSTEM_SUBDOMAINS` are matched before the database.
   - The slug syntax is 3-32 chars, `[a-z0-9-]`, with no `--` (`hosts.ts:137-212`).
3. **Resolve on boot.** The SPA's `StoreProvider` calls `GET /api/storefront/resolve` once. A store answer, or a 404 meaning "unknown store", renders `StorefrontApp` in place of the main site (`StoreContext.tsx:53-73`, `App.tsx:518-528`).
4. **Merchant-host route table** (`App.tsx:373-410`): `/`, `/products`, `/about`, `/reviews` and `*` render Storefront. `/p/:productSlug` renders the product. `/policy`, `/cart`, `/checkout`, `/store-checkout`, `/orders(/:id)` and `/auth` are the platform's own pages. `/admin` is the merchant workspace.
5. **Session.** The session cookie is scoped to `.levonis-iq.com` (`hosts.ts:263-277`), so the visitor is already signed in.
6. **The `/admin` page does not check that the host is the viewer's own store.** It always shows the viewer's own store (B16).

### 3.6 Per-host manifest and icons

- **Route.** `GET /manifest.webmanifest` is served by the Worker (`index.ts:396`, listed in `run_worker_first`). It skips the session load (`index.ts:174-177`). On a merchant host it reads one store row. **Every failure falls back to the platform manifest with a 200** (`routes/manifest.ts:47-112`). Cache is `public, max-age=300`. The service worker never caches it (`public/sw.js:383`).
- **Content** (`lib/webManifest.ts:373-453`):
  - `name`/`short_name` come from the store name, cleaned of bidi, zero-width and control characters and cut at word boundaries.
  - `description` is the tagline, or the generated "متجر X على منصة Levonis".
  - `id`, `start_url` and `scope` are all `/`.
  - `display` is standalone. `background_color` and `theme_color` are **always `#000000`**. `lang` is `ar`, `dir` is `rtl`, `categories` is shopping.
  - The 3 shortcuts (`/products`, `/cart`, `/orders`) are generic.
- **Icons: no merchant renditions exist.** `icons` is the merchant's **raw uploaded logo** as a single extra entry with **no `sizes`** and `purpose:'any'` (`webManifest.ts:320-334`), followed by the **platform's** 192/512/maskable-192/maskable-512 PNGs (`:257-262`). Nothing generates a 192, 512, maskable, 180 apple-touch or favicon rendition of a merchant logo.
  - **Chromium/Android** picks icons by declared size, so it installs the **Levonis mark**. The code comment itself admits this (`webManifest.ts:311-315`).
  - **iOS**: `HostAppleIdentity.tsx:59-91` swaps `<title>` to the store name. It repoints `apple-touch-icon` to the logo **only if the logo is .png/.jpg/.jpeg**. Uploads are usually converted to WebP, so iOS normally keeps the platform PNG.
  - **Net effect:** a merchant's installed app carries the store's *name* and, in the common case, the *Levonis icon*.
- **Share cards.** Only product paths get per-product OG tags (`socialPreview.ts:87-92`, `index.ts:456-477`).
  - A store's home link unfurls with the **platform** card.
  - On merchant hosts the product card's `og:url`/image origin is `trustedOrigin()`, which is the apex or `APP_ORIGIN`. That produces `https://<apex>/p/<slug>`, which is not an apex route (B15).

---

## 4. Strengths to keep (do not rewrite)

1. **The tenant-isolation model** (`merchantAuth.ts`):
   - The store comes from the session, never from a path or body.
   - The owner id is inside the WHERE clause of every write.
   - Read and sell are split between `requireStoreOwner` and `requireSellingPrivileges`, so a lapsed merchant keeps their history.
   - Carry this into any v2 API unchanged. If staff or multi-store is added, validate an `X-Store-Id` against a membership table rather than trusting it.
2. **Host classification and the apex-only admin guard** (`hosts.ts`, `index.ts:220`), including:
   - `adminAllowedOn` and its outage lessons;
   - the code-level `SYSTEM_SUBDOMAINS` list, grouped by reason and audited against DNS (`scripts/audit-reserved-subdomains.mjs`);
   - the narrow slug syntax with no punycode;
   - 180-day slug parking;
   - `storeUrl()` falling back to the in-app route.
   - The pinning tests are `tests/hosts.test.ts`, `tests/storefrontIsolation.test.ts` and `tests/reservedSubdomains.test.ts`.
3. **The per-host manifest route design:** never-500, platform fallback, text cleaning for bidi and zero-width characters, `id:'/'`, no SW caching, and the session skip. Extend it with renditions; do not replace it.
4. **Merchant content safety invariants**, which must survive into the Store Builder:
   - a preset *name* rather than a colour;
   - the closed icon vocabulary;
   - no `dangerouslySetInnerHTML`;
   - http(s)-only links, validated on the way in;
   - `ownedMediaKey`/`ownedMediaUrls` (`mediaRefs.ts:51-91`): a 400 for a foreign logo or banner, a silent drop for a gallery entry.
5. **One cart, one seller.** `cartSeller.ts`, the DB CHECK (`0030:215-221`), the partial unique indexes (`0032:98-105`), and `replaceCart` as a single request.
6. **Checkout money mechanics:**
   - server pricing only;
   - prepaid-only store orders;
   - a wallet hold committed *inside* the order batch (`storeOrders.ts:~521-537`, commit at `:529`);
   - per-user idempotency (0064);
   - commission snapshot per order and integer IQD;
   - the `splitFee` identity (`merchantOps.ts:163-175`).
7. **Privacy by construction:** named columns on merchant order items (`merchant.ts:1260-1281`), customers built only from own orders, stock shown as a boolean publicly, and the phone shown only if published.
8. **The ProductsManager screen** (server-side filters and sort, stats from real rows, CSV import-as-draft and export, insights) and **archive-not-delete** (`merchant.ts:1043-1066`).
9. **The 3D-printing differentiators:** `merchant_printers` with matching (build volume, materials, enclosure), `merchant_request_prefs`, spools and the costing engine. They are unique to this platform and already wired into the workspace.
10. **Per-host SEO:** robots and sitemap scoped to the store (`routes/seo.ts:147`, `:239-262`).
11. **The test harness** `tests/fixtures/app.ts` (real routes on real migrations, `failingD1` for races). Every fix in §6 can be pinned with it, as the probes show.

---

## 5. Gaps against the target

| Target capability | What exists | Gap (concrete) |
|---|---|---|
| **Workspace with sidebar and command center** | 15-pill tab strip, 3xl column, tab state not in URL, Overview = 7 tiles | Needs: a sidebar (desktop) and bottom-sheet or drawer nav (mobile); URL routing (`/merchant/:section/*`, `/admin/*` on host); a "command center" home with to-dos (orders to confirm or ship, low stock, unanswered reviews, onboarding checklist, payout status, subscription expiry); a global ⌘K across products, orders, customers and settings; staff/roles (only the single owner exists: `merchant_stores.user_id`). |
| **Product management** | CRUD, draft/active/hidden/sold_out/archived, sections, featured, CSV, insights | Needs: **variants** (options and values with price delta, SKU and stock per variant; today's `options`/`colors` JSON is unvalidated, not editable in the UI, not selectable on the storefront and not priced); bilingual fields in the editor; a media library with dimensions and renditions; **3D-print attributes** (material from `print_materials`, colour from the catalogue, dimensions, lead time vs `prep_days`, made-to-order or customisation fields, customer file upload); bulk edit; inventory history; SEO fields per product. |
| **Order management** | Linear status flow, detail sheet with address, chat | Needs: refunds and partial refunds (**cancel currently doesn't refund**, B1); buyer confirmation or an auto-complete window before payout (B11); the `stage`/tracker updated for the customer; tracking number and carrier; packing slip; order notes and timeline (an append-only events table); merchant notifications for new or cancelled orders. |
| **Customer management** | List of buyers (≤100): name, count, lifetime | Needs: search, pagination, per-customer order history, notes and tags, exclusion of cancelled orders (B12). Stay privacy-first; there is no user directory, and that is correct. |
| **Coupon management** | Fixed or percent, minimum, max uses, window | Needs: product or collection targeting, a per-customer limit, a real cap guard (B6), automatic discounts, and a usage report. |
| **Section management** | `merchant_store_sections` = product shelves | Terminology collision: these are **collections**. Page "sections" or blocks do not exist. |
| **Safe block-based Store Builder with themes and draft/preview/publish/version history** | None; one fixed skeleton | Needs a theme preset catalogue (code-owned tokens); a page document of typed blocks validated server-side; draft vs published pointers; version history and revert; preview; a renderer. The current header, links and facts become a default "profile header" block, so existing stores look identical after migration. |
| **Per-merchant subdomain** | Live, including the wildcard route | Old slugs 404 with no redirect (B14). Reserve API words (`resolve`, `by-id`, `p`, B23). Custom domains are an owner cost decision (DECISIONS row 12, Cloudflare for SaaS). |
| **Per-merchant PWA with proper icon renditions** | Per-host manifest; raw logo without sizes; iOS title swap | Needs: generate 192, 512, maskable 192/512 (safe-zone padded), apple-touch 180 PNG and favicons from the logo on upload (`env.IMAGES` already exists: `imageConvert.ts`, `mediaStorage.ts:464+`); revisioned URLs so installed apps update; `theme_color` and splash from the theme preset; store-aware shortcuts; a per-store OG card for the home page. |
| **Delivery pricing per governorate set by the merchant** | One flat `fee_iqd` plus `free_over_iqd` (`storeOrders.ts:224-230`); `governorate` and `service_areas` are free text not used by checkout | Needs a `store_delivery_rates` table keyed by canonical governorate id (`packages/shipping/src/iraqGovernorates.ts` has the 18 ids and `normalizeGovernorate`). Each rate needs fee, free-over, ETA and enabled. Checkout prices from `address.governorate`, refuses unserviced zones with a reason, and snapshots the rate. The storefront shows the delivery table. |
| **Onboarding wizard** | One-step form, then the Printers tab | Needs a multi-step wizard (identity → address → logo/banner → delivery zones → first product → printers → policies → preview → open) and a persistent checklist on the home screen. Remove the hardcoded domain (B19). |
| **Notifications** | 9 stored preferences, 1 read; in-app kinds exist for print matches and offers only | Needs merchant kinds for new order, cancellation, review, follower, low stock, payout and subscription expiring. Read the preferences at send time. Add email/Telegram via the existing outbox. |
| **Analytics** | Totals computed on read; `merchant_store_analytics_daily` is dead; product `view_count` inflatable | Needs event ingestion (store view, product view, add-to-cart, checkout start, order), a daily rollup into the existing table, time-series charts, a conversion funnel, top products, traffic by governorate, and bot-safe counting. |
| **Finance** | `merchant_payout_ledger` (mutable state), admin-initiated payouts, last 100 rows | Needs an immutable entry ledger (state changes become new rows); payout requests from the merchant; payout methods (the wallet channels from 0112 could be reused); statements and exports; per-order fee breakdown; refund and chargeback entries; reconciliation. |

---

## 6. Bugs and security issues (verified)

Severity reflects impact on real money or trust.

### B1 · HIGH · Merchant cancels a prepaid store order and the buyer is not refunded **[PROBE P1]**

- **What happens.** `POST /api/merchant/orders/:id/status {status:'cancelled'}` only flips `orders.status` and reverses the merchant's pending ledger row (`merchant.ts:1397-1406`).
- **What is missing:**
  - no wallet refund (no `cancelledOrderRefundStatements`, which the customer and admin doors use: `orders.ts:5090`, `admin.ts:3250`);
  - no stock or `sold_count` restore;
  - no coupon `used_count` release.
- **Reachability.** The UI offers Cancel at pending, confirmed and processing (`SalesTabs.tsx:29-35`, `:141-160`).
- **Probe result.** The buyer's spendable balance stays at DEP-1000. No `wtx_refund_*` row exists. Stock stays decremented.

### B2 · MEDIUM · Buyer self-cancel leaves the merchant's credit pending forever **[PROBE P2]**

- **What happens.** `POST /api/orders/:id/cancel` refunds the wallet (`orders.ts:5048-5099`).
- **What is missing:**
  - the `sale_credit` row is not reversed (it stays `pending` forever, inflating "Pending" in Earnings);
  - community-product stock and `sold_count` are not restored (`planOrderReturn` handles platform inventory only);
  - the coupon is not released.

### B3 · HIGH (business rule) · A lapsed-PLUS merchant keeps selling and can re-open their store **[PROBE P3]**

- **The contract.** `MERCHANT_STORES.md` §3 and the comment at `cart.ts:2147-2150` promise that new orders stop when PLUS lapses.
- **What happens.** Neither the cart add (`cart.ts:2136-2156`) nor checkout (`storeOrders.ts:191-193`) checks the merchant's entitlement. Nothing pauses stores on expiry: the only `UPDATE merchant_stores SET status` statements are in admin and merchant routes.
- **Re-opening.** `PATCH /store {open:true}` needs only Own (`merchant.ts:325-330`).
- **Probe result.** A merchant with `can.store:false` re-opened a paused store and took a new paid order (201).

### B4 · MEDIUM · A suspended store cannot save any setting **[PROBE P4]**

- **Cause.** `StoreSettingsTab.save()` always sends `open: f.open` (`StoreSettingsTab.tsx:135`). The server throws 403 whenever `body.open !== undefined` on a suspended store, even for `open:false` (`merchant.ts:325-328`).
- **Effect.** A merchant suspended for a bad banner cannot fix the banner.

### B5 · MEDIUM · Keyset pagination skips rows; CSV import stamps one `created_at` for all rows **[PROBE P5]**

- **Cause.** The storefront uses `created_at < cursor ORDER BY created_at DESC` (`storefront.ts:274-282`). Import writes a single `ts` for every row (`merchant.ts:1002-1016`).
- **Probe result.** With 30 products sharing a timestamp, fewer than 30 are reachable (only the first page).
- **Same pattern elsewhere:** the bare mode of `GET /api/merchant/products` (`merchant.ts:514-520`), followers (`:1184-1189`) and storefront reviews (`storefront.ts:322-329`).

### B6 · LOW-MED · The coupon cap is not enforced under concurrency **[PROBE P6]**

- **Cause.** `UPDATE merchant_coupons SET used_count = used_count + 1 WHERE … used_count < max_uses` (`storeOrders.ts:471-478`) may change 0 rows, but the order and its discount are still written.
- **Effect.** The comment beside it claims the opposite.

### B7 · MEDIUM · Oversell under concurrency **[PROBE P7]**

- **Cause.** The stock decrement `WHERE (track_stock = 0 OR stock >= ?)` (`storeOrders.ts:495-503`) no-ops silently, and the order commits anyway.
- **The fix idiom already exists.** `cancelledOrderRefundStatements` uses the fence `CASE WHEN … THEN ?4 ELSE -1 END`, which aborts the batch via a CHECK.

### B8 · MEDIUM · An admin merchant-status write overwrites store status **[PROBE P8]**

- **Cause.** `POST /api/admin/community/merchants/:id/status` runs `UPDATE merchant_stores SET status = (suspended ? 'suspended' : 'active') WHERE merchant_id = ?` (`adminCommunity.ts:388-392`).
- **Effects:**
  - Setting `restricted`, or restoring `active`, **lifts a store-level suspension**.
  - It also **re-opens a merchant-paused or 0039 auto-paused store**. That contradicts the "paused is the merchant's own switch" rule (`adminCommunity.ts:421-427`).
  - `restricted` has no other effect anywhere in `worker/`.

### B9 · MEDIUM · Admin moderation of products is not sticky **[PROBE P9]**

- **Cause.** Admin hide sets `lifecycle/status='hidden'` (`adminCommunity.ts:462-470`). The merchant's `PATCH /products/:id {lifecycle:'active'}` restores it (`merchant.ts:644-645`, `:718-721`).
- **Effect.** The product is immediately back on the storefront.

### B10 · MEDIUM · Legacy `/api/community/my-store/products` bypasses the store rules **[PROBE P10, P11]**

The route is open even while the community is closed (`communityGate.ts:191-195`). `requireOwnMerchant` only checks that a merchant row exists: no entitlement, no suspension, no store (`community.ts:336-343`).

- **P10:** `DELETE /my-store/products/:id` **hard-deletes any product of the merchant, including ordered store products** (`community.ts:369-376`). This bypasses archive-not-delete and leaves `order_items` dangling.
- **P11:** `POST /my-store/products` stores **off-platform image URLs** (`jsonArray` only checks array-ness, `http.ts:239-244`). The product has `store_id NULL` and `status 'active'`.
  - It is shown on the synthetic profile page and in community lists.
  - CSP `img-src https:` does not block it, so it works as a visitor-tracking pixel.
- **Test gap.** `tests/storefrontIsolation.test.ts:247-256` only scans `adminCommunity.ts` for `DELETE FROM community_products`.
- **UI.** The legacy UI is `src/components/MerchantDashboard.tsx` in `/edit-profile`.

### B11 · MEDIUM (trust / money) · Store-order completion is self-certified by the merchant **[PROBE P12]**

- **What happens.** Four calls (confirmed → processing → shipped → delivered) make the payout `available` with no buyer confirmation, no delivery evidence and no dispute window (`merchant.ts:1313-1361`). Contrast escrow orders, where "marking delivered does NOT release money" (`COMMUNITY_V2.md` §6).
- **Tracker.** The customer tracker's `orders.stage` stays `received` forever on this path (`storeOrders.ts` inserts `stage='received'`; the merchant route never updates `stage`).

### B12 · LOW-MED · Overview and customers count cancelled orders **[PROBE P13]**

- **Where.** `/analytics` gross, receivable ("Your earnings") and average order sum all orders (`merchant.ts:1546-1554`). `/customers` lifetime does the same (`:1515-1524`). `/products/stats` and insights correctly exclude cancelled, so the numbers are inconsistent.

### B13 · LOW-MED (client trust) · Unvalidated variant ids reach the merchant's order **[PROBE P14]**

- **Cause.** `optionId`/`colorId` in `POST /api/cart/merchant-items` are free text of 60 chars or fewer (`cart.ts:2162-2163`). They are never checked against the product and are written verbatim into `order_items.option_snapshot` (`storeOrders.ts:490`).
- **Effect.** The merchant sees them as the chosen variant (`SalesTabs.tsx:253`), for example "GOLD PLATED (paid +20000)" at base price.
- **Related.** Product `options`/`colors` are arbitrary merchant JSON published raw (`merchant.ts:641-642`, `storefront.ts:100-101`).

### B14 · LOW · Renaming a slug breaks old links, QR codes and installed PWAs **[PROBE P15]**

- **Cause.** `/resolve` and `storeBySlug` look only at `merchant_stores.slug` (`storefront.ts:165-171`, `merchantAuth.ts:80-93`). `merchant_store_slugs` history is never used to redirect.
- **Effect.** The old host shows "No such store".

### B15 · LOW · Share cards on merchant hosts

- **Wrong origin.** On a merchant host, `og:url`/image are built from `trustedOrigin()` (`index.ts:458-471`, `appOrigin.ts:39-55`). That yields `https://<apex or APP_ORIGIN>/p/<slug>`. `/p/:slug` is not an apex route and falls to "Under Construction" (`App.tsx:776`, `:811`). `seo.ts:147` already solved this correctly by using the request origin for merchant hosts.
- **No store scoping.** The preview lookup is not store-scoped (`socialPreview.ts:290-303`), so any product slug unfurls on any host.
- **No home card.** There is no per-store card for the store home.

### B16 · LOW · The `/admin` page on someone else's store host shows the viewer's own store

- **Cause.** There is no check that `useStore().store.id === me.store.id` (`MerchantDashboardPage.tsx:67-75`). The docs and `merchantAuth.ts:9-13` say this case should be a 403.
- **Impact.** No data leaks. This is a UX and doc mismatch.

### B17 · LOW · The default Overview tab errors for lapsed merchants

- **Cause.** `/analytics` requires the `merchantAnalytics` entitlement (`merchant.ts:1541-1544`), and the page renders the error as the landing view (`MerchantDashboardPage.tsx:250-258`). The page's own header says "READING NEVER STOPS".

### B18 · LOW · Error handling in the workspace

- **Reply.** The review reply has no try/catch (`MerchantDashboardPage.tsx:417-423`). A 409 becomes an unhandled rejection with no message.
- **Notifications.** The toggles don't revert optimistic state on failure (`:575-583`).
- **Native dialogs.** Order and coupon actions use native `alert`/`confirm`.

### B19 · LOW · Hardcoded root domain in the UI

`MerchantStart.tsx:231` (`.levonis-iq.com`) and `Storefront.tsx:71` (`MAIN_SITE`). The server already knows the root: return it from `/api/merchant/me` and `/resolve`.

### B20 · LOW · Documentation drift

These need an owner decision before re-development:

- **PRIME entitlement.** `MERCHANT_STORES.md` §2 says PRIME gets no merchant benefits. Code and tests grant them (`entitlements.ts:78-85`, `:118-123`; `tests/subscriptionPage.test.ts:625`).
- **Ledger.** §7 says the ledger is "append-only". The code mutates `state` in place.
- **API list.** §9 omits about 25 endpoints: sections, services, showcase, coupons, product stats, import, export, insights, custom orders and printers.
- **Order volume.** `storefront.ts:15-17` says "order volume … never returned", but `merchant.completed_orders` is public (`storefront.ts:81`).
- **Store suspension.** `COMMUNITY_V2.md` §11 says store suspension "takes the storefront down". In code a suspended store still serves banner, logo, bio and products (`storefront.ts:179-289`; UI `Storefront.tsx:403-414`). Decide which is intended.

### B21 · LOW · Dead or unused schema

- `merchant_store_analytics_daily` is never written or read.
- 8 of 9 `merchant_notification_preferences` switches are unread (`notifications.ts:5`).

### B22 · LOW · `view_count` can be inflated

- **Cause.** `view_count+1` runs on every anonymous product GET, bots and owner included, with no dedupe (`storefront.ts:305-310`).
- **Effect.** It is anyone-amplifiable and feeds "Views", "sort by views" and insights.

### B23 · LOW · API words are not reserved as slugs

- `resolve`, `by-id` and `p` are neither in `SYSTEM_SUBDOMAINS` nor in `reserved_slugs`.
- A store slugged `resolve` is unreachable through `GET /api/storefront/:slug`, because `/resolve` shadows it (`storefront.ts:157`, `:179`). `CommunityStorePage` depends on that endpoint.

### B24 · LOW · Onboarding and slug-change races return a raw 500

The check-then-insert on slug can hit UNIQUE (`merchant.ts:212-230`, `:480-490`). The caller gets a raw 500 instead of `SLUG_UNAVAILABLE`.

### B25 · LOW · Missing caps and race-prone caps

- No cap on printers per merchant (`merchantPrinters.ts:147-170`).
- The section, service and showcase caps are check-then-insert (racy but harmless).

### Security summary

- **No IDOR, no SQL injection, and no stored XSS path in the new merchant and storefront routes.** Dynamic SQL uses fixed column names and whitelisted sort keys, and every value is bound.
- **Real risks:**
  - money-state bugs (B1, B2, B6, B7, B11);
  - entitlement not enforced on the buy path (B3);
  - moderation overwrite (B8, B9);
  - the legacy API as a bypass (B10);
  - the variant-id client-trust issue (B13).
- **The main latent risk for the re-development is the Store Builder.**
  - Merchant pages run on subdomains that receive the shared session cookie. The workspace itself is served on the merchant host (`/admin`).
  - The CSP allows inline *styles* and any https image.
  - So the "typed blocks with token props, no raw HTML, CSS or JS, owned media only" invariant must be enforced **server-side on save**, not only in the renderer.

---

## 7. Recommended foundation changes, in dependency order

### Phase 0: correctness fixes first (small, testable, independent of the redesign)

Pin each fix with the matching probe, copied into `tests/`.

1. **One store-order cancellation operation** (`worker/lib/storeOrderOps.ts`), used by the merchant door, the customer door and admin. It runs one batch:
   - fenced status flip;
   - wallet refund (reuse `cancelledOrderRefundStatements`);
   - reversal of the merchant `sale_credit`;
   - restore of community-product stock and `sold_count`;
   - coupon `used_count - 1`;
   - event row and buyer notification. (B1, B2)
2. **Entitlement on the buy path.** Add `storeAcceptsOrders(ctx, tier)`, used by cart add, quote and checkout. It returns true only when the store is active, the merchant is not suspended, and `merchantStore` is entitled. Make `PATCH /store {open:true}` require Sell. (B3)
3. **Turn conditional stock and coupon updates into batch-aborting fences.** Use the existing `CASE … ELSE -1` CHECK-violation idiom, or `INSERT … SELECT … WHERE` into a guard row. The order must not commit when either no-ops. (B6, B7)
4. **Settings save.** The client sends `open` only when it changed. The server rejects only `open:true` on a suspended store. (B4)
5. **Separate admin state from merchant state.**
   - Add `merchant_stores.admin_status`/`suspended_by` (or `moderation_status`) so merchant-status writes never touch a merchant pause, and a store suspension survives a merchant status change.
   - Define what `restricted` means, or drop it.
   - Add `community_products.moderation_state`, which merchant PATCH cannot clear. (B8, B9)
6. **Retire or re-route `/api/community/my-store/products*`** onto the product service (owned media, archive rule, Sell guard), and remove `components/MerchantDashboard.tsx`. Extend the isolation test to `community.ts`. (B10)
7. **Keyset on `(created_at, id)`** for storefront, reviews, followers and merchant lists. (B5)
8. **Analytics.** Exclude cancelled orders from gross, receivable, average and lifetime. (B12)
9. **Store-order completion rule.** Get an owner decision: customer confirmation, or an auto-complete after N days (reuse `communityAutoCompleteDays`). Until then, "delivered" moves money to a `delivered_unconfirmed` state instead of `available`. (B11)
10. **Old-slug redirect.** `/resolve` consults `merchant_store_slugs` and returns `{redirect: newUrl}`; the SPA calls `location.replace`. Reserve `resolve`, `by-id` and `p`. Return `root_domain` from `/me` and `/resolve`. (B14, B19, B23)

### Phase 1: schema foundation

These are additive migrations. They respect the existing rules: no destructive rebuild of live tables, and IF NOT EXISTS so they re-run cleanly.

1. **Tenant key.** Decide that the tenant is the store, keyed by `store_id`. Backfill `store_id` onto legacy products, and add `store_id` scoping alongside `merchant_id` on products and orders queries. Optionally add `store_members (store_id, user_id, role)` for staff; the owner row mirrors `merchant_stores.user_id`.
2. **Catalogue.**
   - `product_variants (id, product_id, store_id, option_values JSON validated, sku, price_iqd, compare_at_iqd, stock, track_stock, active)`
   - `product_option_defs (product_id, name, values[])`
   - `product_media (product_id, media_key, width, height, sort, alt)`, reusing `file_objects` dimensions
   - 3D attributes: `material_id → print_materials`, `color_ids`, `dims_mm`, `lead_time_days`, `made_to_order`, `customization_schema`
   - Cart and order lines reference `variant_id`; validate and price at add and checkout (B13). Keep `options`/`colors` JSON read-only for legacy rows.
3. **Collections.** Keep `merchant_store_sections` as the table but expose it as **collections** in API and UI. Add `slug`, `description` and `image_key`. This frees the word "section" for page layout.
4. **Delivery.** `store_delivery_rates (store_id, governorate_id, enabled, fee_iqd, free_over_iqd, eta_min_days, eta_max_days)` with a PK on (store_id, governorate_id). Ids come from `packages/shipping/src/iraqGovernorates.ts`. Checkout prices from `normalizeGovernorate(address.governorate)` and refuses unserviced zones (`STORE_ZONE_UNSERVICED`). The order snapshots the rate. Migrate the existing flat `delivery_settings` as an "all governorates" default.
5. **Store orders.**
   - `store_order_events` (append-only: actor, from, to, reason, at);
   - order columns `fulfillment_status`, `cancelled_by`, `cancel_reason`, `tracking_carrier`, `tracking_code`;
   - keep `stage` in step so the customer tracker works.
6. **Finance.** Add an append-only `merchant_ledger_entries`, where a state change is a new signed entry. Keep `merchant_payout_ledger` readable, with a projection view. Add `merchant_payout_requests` and `merchant_payout_methods`.
7. **Builder** (see §7 Phase 2 for contracts):
   - `store_theme (store_id, preset_id, accent_preset, font_preset, density, updated_at)`: preset ids are validated against a **code-owned** registry.
   - `store_pages (id, store_id, kind: home|about|policy|custom, slug, published_version_id, draft_version_id)`
   - `store_page_versions (id, page_id, store_id, document JSON, schema_version, created_by, created_at, note)`: immutable rows. Publish is a pointer swap; revert copies an old version to a new draft.
8. **PWA icons.**
   - `store_icons (store_id, source_media_key, rev, icon192_key, icon512_key, maskable192_key, maskable512_key, apple180_key, favicon32_key, generated_at)`.
   - Generate them in the logo upload or `PATCH /store` path via `env.IMAGES`: PNG output, and a maskable variant padded to the 80% safe zone on a theme background.
   - Revisioned URLs make installed apps update, as the platform does with `PLATFORM_ICON_REVISION`.
9. **Onboarding and notifications.**
   - `store_onboarding (store_id, step flags, completed_at)`.
   - Extend `user_notifications` kinds with merchant events. Read `merchant_notification_preferences` at send time.
10. **Analytics.** Store an event beacon (dedupe per visitor per day, bots excluded) as daily rollups in the **existing** `merchant_store_analytics_daily`, plus a per-product daily table.

### Phase 2: API contracts

- **Keep "no store id in the URL; the store comes from the session".** For staff or multi-store, add an optional `X-Store-Id` header validated against `store_members`.
- **Shared schemas.** Put zod or TS validators for block documents, theme tokens, variants and delivery rates in `packages/contracts`. The **server validates every block document on save**:
  - an allowlisted block `type`;
  - typed props only;
  - text length caps;
  - URLs http(s) only;
  - media via `ownedMediaKey`;
  - colours only as preset names;
  - no HTML. Rich text is a tiny markdown subset rendered to React nodes.
- **Builder endpoints:**
  - `GET/PUT /api/merchant/pages/:pageId/draft` (optimistic concurrency via `If-Match: <draft_version_id>`)
  - `POST /pages/:id/publish`
  - `GET /pages/:id/versions`
  - `POST /pages/:id/revert/:versionId`
  - `GET /api/merchant/theme` and `PUT /api/merchant/theme`
  - `GET /api/storefront/:slug/page/:kind`, which returns the published document and theme tokens with an ETag of the version.
  - Draft preview: `GET /api/merchant/pages/:id/preview`, owner only.
- **Delivery endpoints.** `GET/PUT /api/merchant/delivery-rates` (bulk upsert of 18 rows). The quote returns the zone and ETA.
- **Order endpoints.** `POST /api/merchant/orders/:id/cancel {reason}` (uses the Phase 0 op), `/ship {carrier, code}`, and `/deliver`, which subject to the owner decision moves to `delivered_unconfirmed`. The customer gets `POST /api/orders/:id/confirm-received`.

### Phase 3: component architecture

1. **`MerchantShell`.**
   - Desktop: a sidebar with sections Home, Orders, Products, Collections, Customers, Discounts, Store (Builder, Theme, Pages, Domain & App), Delivery, Analytics, Finance, Printers & Costing, Settings.
   - Mobile: a top bar with a drawer or bottom sheet.
   - Real routes: `/merchant/:section/*` on the apex and `/admin/:section/*` on the host. Guard with a host/owner check (B16).
   - A ⌘K command palette.
   - A small shared query cache per resource.
   - Reuse `ProductsManager`, `PrintersTab`, `CostingTab`, `CatalogTabs` and `SalesTabs` as section pages.
2. **Home, the command center.** A to-do feed from one `/api/merchant/home` aggregate: orders awaiting action, low stock, unanswered reviews, onboarding checklist, payout status, subscription days left, and a 7-day sparkline.
3. **Storefront renderer.**
   - `BlockRenderer` plus a block registry (`src/storefront/blocks/*`). Each block is a React component with a typed props schema.
   - Theme tokens come from a code-owned preset map, generalising today's `ACCENTS`. Still no merchant value in any `style=`, and the existing test should be extended to the whole blocks folder.
   - The **default home template** reproduces today's skeleton: a ProfileHeader block with links and facts, then Tabs, ProductGrid, Services, Showcase and About. Migrated stores therefore look unchanged, and `Storefront.tsx` becomes a thin host of the renderer.
4. **Builder UI.** Block list (add, reorder, hide), a settings form generated from each block's schema, device-size preview, draft autosave state, Publish, and Version history.
   - **Preview must render in-process** (the same React renderer fed with the draft document). CSP `frame-ancestors 'none'` (`securityPolicy.ts:122`) forbids iframing the storefront, and cross-origin iframing of `slug.levonis-iq.com` from the apex would also need cookie and CSP changes.
   - "Open preview in new tab" can use `/?preview=<draft>` on the store host, readable only by the owner session.
5. **Onboarding wizard.** A step machine backed by `store_onboarding`, reused as the Home checklist.
6. **PWA.** The manifest reads `store_icons` (sized PNG entries and maskable) and `theme_color` from the theme preset. `HostAppleIdentity` points `apple-touch-icon` at `apple180_key`. `socialPreview` adds a store-home card and uses the request origin on merchant hosts (B15).

### Dependency order (critical path)

1. Phase 0, items 1-10. Unblocks trust in the money path. Items 1-4 are urgent.
2. The tenant-key and state-separation migrations (Phase 1.1, and 1.5 for orders). Everything else keys on them.
3. Catalogue: variants, media, 3D attributes (1.2), then collections (1.3).
4. Delivery rates (1.4), which checkout needs. It runs in parallel with 3.
5. Finance ledger (1.6), after the Phase 0 order ops.
6. API contracts for the above (Phase 2), then `MerchantShell` and routing (3.1, 3.2).
7. Theme and page schema (1.7) plus the renderer with the default template (3.3). The renderer must ship before the builder UI so publishing is lossless.
8. Builder UI (3.4).
9. PWA icon pipeline (1.8, 3.6). This can start right after the product media work (step 3), because it only needs media dimensions and `env.IMAGES`.
10. Onboarding wizard (1.9, 3.5), last, because it links to every other surface. Notifications and analytics ingestion (1.9, 1.10) can start early and in parallel.

**Owner decisions needed before building:**
- the store-order completion rule (B11);
- whether suspension hides the storefront (B20);
- whether PRIME may open stores (B20);
- the commission rate (still at the 5% seed);
- custom domains (DECISIONS row 12).
