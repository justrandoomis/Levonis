# Levo Project — Programme C: survey appendix and the five judged track syntheses

> Evidence appendix to `docs/LEVO_PROJECT_PROGRAMME.md` (the plan of record). Reproduced verbatim from the Programme C workflow (2026-09-30): the six read-only surveys (map, REUSE, GAPS, RISKS, NUMBERS — read against HEAD `98dc0305` plus the uncommitted community Phase 5 and merchant P4/P5 tree) and, per track, the judge's synthesis with its GRAFTS and REJECTED lists and the judge's scores. Where a synthesis below disagrees with the programme document, the programme document wins (its §0 settles each disagreement with file:line). Line numbers are those the surveyors and judges read; the tree was moving under them, so re-read before citing.

> **Errata — facts that changed or were imprecise, found by the critics' pass (2026-09-30).** The text below stays verbatim; where it disagrees with these lines, these lines and the programme document win.
> 1. **The storefront closure** is 47,739 B (46.62 KB) of the gate's 48,128 B on the 13:07 build — 389 B left — and 47,862 B on the 15:22 rebuild — 266 B left (node zlib level 9, `tests/bundleBudget.test.ts:382`); the «≈ 42.7 KB» some passages carry is the pre-Phase-5 figure. P6's payback ledger counts on `profileIcons` and `attributes`, which are already lazy and outside the closure. The closure's small modules (15:22): `storeBeacon` 520 B, `InstallAppButton` 601 B, `swatches` 618 B, `governorates` 620 B, `PremiumMemberBadge` 651 B. The Request chunk is 41,978 B on the 15:22 rebuild (41,298 B at 13:07).
> 2. **`worker/routes/marketplace.ts` moved +7 lines** (an edit inside `GET /orders/:id`): the orders GET spread `:2534-2550`, start `:2603` (UPDATE `:2623`), delivered `:2658` (writer `:2674`), confirm `:2705`, dispute `:2789`, cancel `:2897`; `offerForAcceptance :2082`, accept `:2201` and the order INSERT `:2398` are unchanged.
> 3. **Hold claims.** Every legacy «does an escrow claim this hold?» check reads only `community_escrows.hold_id`: the stranded-hold sweep (`worker/lib/communityRequests.ts:800-817`, `STRANDED_AFTER_MINUTES` = 15 at `:479`), the accept route's «did it land?» (`marketplace.ts:2454-2462`), `releaseEscrowReservation` (`worker/lib/escrowOps.ts:354-381`) and the wallet's held dinars (`worker/lib/walletOps.ts:747`); and the per-escrow keys assume one hold (`worker/lib/merchantLedger.ts:402` with UNIQUE `event_key` at `migrations/0121_merchant_ledger.sql:122`; `wtx_escrow_refund_<escrowId>` at `escrowOps.ts:796`; the first `held` event's rate at `escrowOps.ts:142-151`). The money track's escrow parts must extend them (programme §B.6 M1, M4, M17).
> 4. **The customer's «اطلب تعديلًا» already exists**: `community_order_updates` kind `modification_request` (`worker/routes/communityOrderTimeline.ts:56-58`, `0160:54-63`, DECISIONS row 179 (٤)); the Levo track's changes-requested decision must write that row, not a second one (programme §0 row 15).
> 5. **`merchant_spools`** (`migrations/0078_print_quote_engine.sql:173-191`) is engine B's merchant filament price (`worker/lib/printQuote/repository.ts:287-302`) and has no writer; **`merchant_services`** (`migrations/0036_store_builder.sql:42-58`) is live on the storefront and in the merchant CRUD (`worker/routes/merchant.ts:1761-1823`); **`community_order_items`** (`0031:129-138`) exists with no reader or writer; **`follows.notify_*`** (`0031:311-313`) are written by `PATCH /follow/:merchantId` and returned by `GET /following` (`worker/routes/merchantReviews.ts:393-457`) but read by no sender.
> 6. **Citations.** `worker/lib/printMatchingStore.ts`: `storefrontWorkshopFacts` `:865` is the one-statement storefront reader, `publicWorkshopFacts` `:919` runs three statements plus `workshopFactsFromPrinters`. The IMAGES binding also cuts variants (`renderImageVariant`, `worker/lib/imageConvert.ts:480-505`) and renders store icons (`worker/lib/storeIcons.ts:499-528`). The merchant packing slip prints the cash-on-delivery amount (`src/components/merchant/orders/OrderDetailScreen.tsx:462-466`). `packages/catalog/src/variants.ts` `MAX_GROUPS` is at `:29` (the constants `:29-34`). `RequestWizard.tsx:64` is `MODEL_ACCEPT`; the four source cards are at `:607-610`. `DEFAULT_MATCH_WEIGHTS` is `printMatchingScore.ts:31-53`, `rankScore` `:109`. `priceJob` is `worker/lib/printQuote/cost.ts:282` (`PricingInputs` at `:225`). The merchant cart add door also takes `optionId`, `colorId`, `replaceCart` (`worker/routes/cart.ts:2293-2298`) and `origin_chat_id` (`:2311`). `parse3mf` reads only the root model part (`worker/lib/modelGeometry.ts:679-721`). The request page's `infill_percent`/`supports` labels are in `src/components/community/requests/strings.ts:291-292,604,918`. Community 6's `moderation_actions.target_type` list is at `docs/COMMUNITY_ECOSYSTEM.md:968-969` in today's tree.

## Contents

- Survey — commerce
- Survey — print
- Survey — media3d
- Survey — community
- Survey — merchant
- Survey — rules
- Track — customer-personalization (judged synthesis)
- Track — merchant-templates-components (judged synthesis)
- Track — levo-project (judged synthesis)
- Track — manufacturing (judged synthesis)
- Track — money (judged synthesis)

---

## Survey — commerce

# COMMERCE substrate — as it is (read 2026-09-30, tree at 98dc0305 + 44 uncommitted files; 154 migrations applied in-memory → 250 tables, 58 triggers)

## 1. Community products (the merchant catalogue)

**`community_products`** — 47 columns, 9 triggers. Created `migrations/0001_init.sql:257-270` (id, merchant_id, slug, status active|hidden, name/name_ar, description/_ar, images JSON, price_iqd, original_price_iqd). Grown by: `0030_community_v2_core.sql:163-182` (store_id, sku, stock, track_stock, category, condition, **options JSON, colors JSON** (legacy), delivery_methods, prep_days, sold_count, view_count, lifecycle), `0036:32-33` (section_id, featured), `0118:33-34` (admin_hidden_at/_reason), `0126_catalog_variants.sql:34-77` (publish_state draft|published|hidden|archived; **variant_mode simple|variants|legacy**; legacy_variant_note; low_stock_threshold/_alerted_at; **typed print attributes** material, print_technology fdm|resin|sls|laser|other, color (22-key palette CHECK), finish raw|sanded|primed|painted|polished|coated, dim_x/y/z_mm ≤5000, weight_g), `0152_private_products.sql:52-55` (audience_user_id, origin_chat_id, origin_offer_id, custom_expires_at).
Triggers: lifecycle mirrors `trg_product_state_insert/_mirror/_legacy/_not_null` (0126 §7, recreated 0152 with `audience_user_id IS NULL` in the status rule), `trg_variant_product_stock_heal` (0126 §8), `trg_product_section_member_*` (0126 §5), `trg_private_product_stays_hidden`, `trg_private_product_locked` (0152: price/name/images/options/colors/variant_mode/track_stock/audience/store/expiry immutable → `CUSTOM_PRODUCT_LOCKED`).
No cost column, no BOM, no "customizable"/"component" flag of any kind.

**Variant model (0126 §3)** — `community_product_options` (8 cols: name/name_ar, kind choice|color, position 0..2 → **max 3 groups**) `0126:87-100`; `community_product_option_values` (9 cols: name/name_ar, **swatch = palette NAME never CSS**, position, legacy_ref) `0126:102-118`; `community_product_variants` (17 cols: value1_id NOT NULL, value2_id, value3_id, **price_iqd NULL = product price**, compare_at_iqd, stock, sku, active, image_key, low_stock_threshold, position; UNIQUE (product, v1, v2, v3)) `0126:124-146`; own-values triggers `0126:148-170`; stock = SUM(active variants) triggers `0126 §8`; `trg_store_order_cancel_restocks_variants` on `orders` status→cancelled `0126 §9`. `community_product_media` (9 cols, kind image|video, media_key GLOB merchants/*|community/*, position 0..11) `0126:178-190`. Collections = `merchant_store_sections` + `merchant_collection_products` `0126 §5`.
Pure model: `packages/catalog/src/variants.ts` — MAX_GROUPS 3, MAX_VALUES_PER_GROUP 30, MAX_VARIANTS 100, MAX_NAME 60, MAX_SKU 64 (lines 30-35); `normalizeVariantModel` (the one write gate), `allCombinations`, `PublicVariant {id, value_ids, price_iqd, compare_at_iqd, in_stock, image}` / `PublicGroup` (~232-250), `findVariant`, `valueState`, `initialSelection`, `priceRange`. Palette: `packages/catalog/src/palette.ts:17-21` 22 SWATCHES (black…multi), `swatchKey`. Attributes: `packages/catalog/src/attributes.ts:44-53` `Attributes {material, technology, color, finish, dim_x/y/z_mm, weight_g}`, `normalizeAttributes`; material id checked against admin setting `printMaterials` in `verifyProductRefs` (`worker/lib/catalog/product.ts:434`).

**Merchant write pipeline** — `worker/routes/merchantCatalog.ts`: `POST /products` 805-828, `PATCH /products/:id` 833-956 (one `db.batch`: `variantModelStatements` → row UPDATE → `mediaStatements` → `membershipStatements`; `requireSellingPrivileges`; private product → 409 `CUSTOM_PRODUCT_LOCKED` at 846; publish needs price `priceMissing` and `publishableModel`), duplicate 958, insights 1033, delete 1121, bulk 592, import/export CSV 413/489, collections 1284-1383. `readProductInput` (`worker/lib/catalog/product.ts:283-432`) accepts: name, name_ar, description(_ar), category, sku, price_iqd, compare_at_iqd|original_price_iqd, stock, track_stock, featured, condition, prep_days, low_stock_threshold, delivery_methods, state|lifecycle, attributes, media|images, collection_ids|section_id, variant_model; legacy `options`/`colors` refused (`PRODUCT_OPTIONS_LEGACY` 292-296); **unknown keys are silently ignored** (a new `customization` key needs explicit reading). `variantModelStatements` 593-706 (keeps ids of surviving combos, `ON CONFLICT(id) DO UPDATE`, sets variant_mode). Client mirror: `src/components/merchant/catalog/catalogApi.ts:169-174` write shape {state, attributes, media, collection_ids, variant_model}; editor `ProductEditorSheet.tsx` (534 lines) sections as `Disclosure`: variants 353, pricing 379, details 395, print attributes 418, collections 479; `VariantEditor.tsx` 358 lines; files editor `ProductFilesEditor.tsx` 309 lines.

**Storefront read** — `worker/routes/storefront.ts:695-718` `GET /api/storefront/:slug/products/:productSlug` wrapped `anonymousCached(c, {}, …)` (no declared params; never cached for a session), `publishedStoreProduct` 688, `publicProduct` 160, plus `publicProductExtras` (`worker/lib/catalog/public.ts:25-98`: option_groups (only values an active variant uses), variants (in_stock boolean, **never a count**, inactive omitted), media, attributes) and `file_count`. Public API twin: `worker/lib/publicApi/resources/stores.ts:795-798` `getStoreProduct /stores/{slug}/products/{product}` (options/variants/media/attributes 294-296, 314-350); `listStoreProducts` 775; community products list `resources/community.ts:392`; route list = OpenAPI (`tests/publicApi.test.ts`).

**SPA product page** — `src/pages/StorefrontProduct.tsx` (474 lines, chunk 6.3 KB gz): `VariantPicker` (`src/components/catalog/VariantPicker.tsx`, native radios per group, `lv-swatch` + `data-swatch`, `swatches.css` 0.5 KB); add posts **`{productId, variantId?, qty, replaceCart}` — never a price** (206-212); price/compare/gallery focus follow the chosen variant (309-316, 285-291); `ProductFacts` lazy (86-88), `ProductFiles` lazy (97), `ProductActions` lazy; fixed buy bar with `QuantityInput` (max `LINE_QTY_MAX` 9999 `packages/pricing/src/quantity.ts:38`, `QTY_INPUT_MAX` 999,999 line 48); refusal strings lazy on first refusal. Sorani gaps marked `OWNER` at 288, 322, 407. Platform page `src/pages/Product.tsx` (4242 lines, 40.8 KB gz) is a different door (`POST /api/cart/items` with option_value_ids/colorId/transportMethod/warrantyPlanId/fulfillmentType).

## 2. The cart

**`cart_items`** — 19 columns (rebuilt `0141_cart_qty_ceiling.sql:12-46`): id, user_id, seller_type levonis|merchant, merchant_id, store_id, product_id | community_product_id (exactly one, CHECK), option_id, option_value_ids JSON (0023), color_id, shipping_method_id, transport_method, warranty_plan_id, qty CHECK 1..9999, created_at, draw_salt (0058), fulfillment_type (0073), variant_id → community_product_variants ON DELETE SET NULL (0126:274), origin_chat_id (0152:56). **Identity**: `idx_cart_merchant_line UNIQUE (user_id, community_product_id, option_id, color_id) WHERE community_product_id IS NOT NULL` (0141:50-51); levonis `idx_cart_levonis_line (user_id, product_id, option_id, option_value_ids, color_id, shipping_method_id)` (0141:52-53); one-seller triggers `trg_cart_items_one_seller_insert/_update` → `CART_SELLER_CONFLICT` (0141:54-61). **No configuration/JSON column exists for a community line**; the only per-line "configuration" precedents are platform-side: `option_value_ids` canonical sorted JSON (`worker/lib/cartSelectionIdentity.ts:10-30`), and the bundle side table `cart_bundle_choices (cart_item_id, component_id, option_value_ids, color_id, included)` (`0058_composition_core.sql:110-117`). Column registry for rolling deploys: `CART_LINE_COLUMNS` (`worker/lib/cartLineProjection.ts:36-45`) — any new column named in a pricing SELECT must be registered with its SQL default.

**Merchant add door** — `worker/routes/cart.ts:2290-2434` `POST /api/cart/merchant-items` body `{productId, qty, optionId?, colorId?, variantId?, replaceCart, origin_chat_id?}`; `loadBuyableMerchantProduct` 2254 (live or private-buyable, `OWN_STORE_PURCHASE`, `storeTakesOrders` → `STORE_CLOSED`); variants: must be an active variant of THIS product, `optionId = variantId`, `colorId=''` (2320-2335, `VARIANT_REQUIRED|VARIANT_INVALID|VARIANT_UNAVAILABLE`); legacy: `merchantVariantLabel` (`OPTION_INVALID|COLOR_INVALID`); seller clash → `sellerConflictRefusal` naming both shops; stock judged over every line of the product and of the variant (2360-2385, `OUT_OF_STOCK {available}`); `INSERT … ON CONFLICT (user_id, community_product_id, option_id, color_id) DO UPDATE SET qty = MIN(9999, qty+excluded.qty)` (2404-2418) — **two differently-personalised copies of one variant would merge into one line today**. `PATCH /merchant-items/:id` 2604 changes qty only; `DELETE` 2650; `GET /merchant` 2594 → `loadMerchantCart` 2445-2566 (items: cart_item_id, product_id, name, name_ar, images, qty, option_id, color_id, variant_id, `variant` label (merchant's words), unit_price_iqd, original_price_iqd, line_total_iqd, prep_days, store_name, available, unavailable_reason unavailable|out_of_stock|option_gone|store_closed|own_store|other_store, stock); `GET /scope` 2575. Client: `src/lib/merchant.ts:637` `merchantApi.cart()`, `src/pages/Cart.tsx` (2663 lines) renders the merchant line's choice as a `variantLabel` button (1451-1466); badge count from `item_count` (`src/lib/cartCount.ts:96-105`, `noteCartResponse` on any `/api/cart*` response).

**The one pricer** — `worker/lib/catalog/lines.ts:50-83` `resolveCatalogLine(row)` (with `LINE_VARIANT_COLUMNS`/`LINE_VARIANT_JOIN` 25-30): variants → variant override or product price, label `variantLabelSql` (`worker/lib/catalog/sql.ts:15-19`, Arabic-first value names in group order), sku, image, stock = variant's, threshold; legacy → `merchantVariantLabel` (`worker/lib/storeOrderOps.ts:181-235`). Used by the add door (`cart.ts:2508`), the cart, and the checkout (`storeOrders.ts:332`).

## 3. Store orders (a community-store sale lives in `orders`)

`worker/routes/storeOrders.ts` — only two routes: `POST /api/store-orders/quote` 593 and `POST /api/store-orders` 718. `priceMerchantCart` 266-480: re-reads lines with `LINE_VARIANT_COLUMNS`, private-buyable set, single store/merchant (`CART_SELLER_CONFLICT`), `storeTakesOrders`, availability re-checked (`PRODUCT_UNAVAILABLE`), `resolveCatalogLine` per line (332, `OPTION_UNAVAILABLE`), **unit > 0 or `PRODUCT_PRICE_REQUIRED`** (343-347), per-variant then per-product stock aggregation (349-380), `resolveCoupon` 217/397 (merchant_coupons, min on subtotal before coupon), `checkoutDelivery` 413 (address→governorate→merchant rules; 409 with `preview`), `feeFor(db,'store', merchandise)` commission on goods only, delivery credited whole (426-432), **`quote_fingerprint` v2 = sha256 over `{v:2, store, lines:[cart_item_id, product_id, qty, unit_price_iqd, option_id, color_id], subtotal, coupon, discount, delivery.fingerprint, total}`** (436-450). Place-order 718+: idempotencyKey 8..80 per user (0064), `quoteFingerprint` must equal (B12), wallet-only prepaid (`walletSpendCents`, hold keyed `store-order:<user>:<key>`), then ONE batch: `INSERT INTO orders` (876-905: status pending, seller_type merchant, origin store_product, payment 'wallet', due 0, coupon, delivery_governorate/rule/prep_days, quote_fingerprint), origin_chat_id, `deliveryFenceStatement`, fences that NULL a NOT NULL column to abort — cart lines still present (address_snapshot → `CART_CHANGED`), product live+stock and private-buyable (`PRIVATE_BUYABLE_SQL`) (status → `OUT_OF_STOCK`), variant active+stock (966-975), coupon cap (coupon_code → `COUPON_EXHAUSTED`) 981-992; **`INSERT INTO order_items (id, order_id, product_id NULL, community_product_id, seller_type 'merchant', name_snapshot, image_snapshot, option_snapshot, qty, unit_price_iqd, line_total_iqd, variant_id, sku_snapshot)`** 1001-1010 (pricing_snapshot left NULL on store lines); **`productFileGrantStatement`** in the same batch 1017-1023 (`worker/lib/fileOwnership.ts:186`); `UPDATE community_products SET stock = stock - qty, sold_count = sold_count + qty` 1027-1034 and per-variant decrement 1037-1041 (**no hold/reservation — the decrement is the placement**); merchant ledger lines `storeSaleLedgerStatements` (pending); delete only the priced lines at their priced qty 1069-1076; `commitHoldStatements` + settlement event. Error mapping 1120-1148 (`stockRefusal`, `COUPON_EXHAUSTED`, `CART_CHANGED`, delivery moved). After response: `announceAfterResponse` 1187, `notifyMerchantOfStoreOrder(event:'new')` 1219 (`storeOrderOps.ts:273-283`), `notifyOrderPlaced` 1235 (`worker/lib/orderNotify.ts:229-252`, key `order.placed:<id>`), `alertLowStock` 1244 (`worker/lib/catalog/lowStock.ts:19-29` `StockMove`), `postSystemCard` 1257 (`storeOrderCard(order, lines, 'placed')`). Customer shape `storeOrderPublic` (`storeOrderOps.ts:245-270`, named fields only).
Transitions after placement: `worker/lib/storeOrderOps.ts` — `cancelStoreOrder` 344-470 (one batch: status/stage flip fenced on `from`, gate row `osh_cancel_<id>` in `order_status_history`, wallet refund, restock per product 405-420 (+ variant trigger), coupon use back, **`revokeOrderProductFileGrantStatements`** 432-436, ledger reversal, audit; called by customer `orders.ts:5233`, merchant, admin doors), `confirmStoreOrderReceipt` 476-540 (`receipt_confirmed_at` 0115:35), `releaseDueStoreCredits` (STORE_RELEASE_DAYS = 3, line 60), `releaseOrphanStoreHolds` (TTL 30 min, line 68). Merchant moves: `applyMerchantOrderMove` (DECISIONS 176). Merchant order detail lines: `worker/routes/merchantOrders.ts:288-290` SELECT id, community_product_id, variant_id, name_snapshot, image_snapshot, option_snapshot, sku_snapshot → served as option/sku 387-391. Customer read: `ORDER_ITEMS_SELECT = SELECT oi.*, …` (`worker/routes/orders.ts:923`) via `GET /api/orders/:id` 4873; `pricing_snapshot` is served back as `pricing` (838).

**`order_items`** — 37 columns: base `0001:164-175` (name_snapshot, image_snapshot, **option_snapshot human text**, qty, unit_price_iqd, line_total_iqd); `0002:99-101` **pricing_snapshot / warranty_snapshot / transport_snapshot JSON**; `0008` option_id, color_id; `0023` option_value_ids; `0030:256-257` community_product_id, seller_type; `0058:122-125` bundle_parent_item_id, bundle_component_id, component_value_iqd, component_alloc_iqd; `0074` membership_discount_iqd/rule_id; `0077:132` coupon_discount_iqd; `0095` cost_iqd, cost_basis; `0099` net/package dimensions; `0126:276-277` variant_id (no FK), sku_snapshot. **`orders`** — 85 columns, 5 triggers (cancel marks, `trg_store_order_cancel_restocks_variants`, `trg_orders_price_hold_freeze`); store-relevant: seller_type/merchant_id/store_id/origin/community_order_id/commission_percent_x100/platform_fee_iqd/merchant_receivable_iqd (0030:240-251), coupon_code/_discount (0036:110-111), receipt_confirmed_at (0115), delivery_governorate/rule/prep_days/quote_fingerprint (0120:134-138), origin_chat_id (0152:57), price_hold_id/price_adjustment_iqd (0140).

## 4. Platform orders (Levonis's own checkout) — the reservation model

`worker/routes/orders.ts` (5422 lines): `GET /` 3585, `POST /quote` 3752, `POST /` 3967, `GET /:id` 4873, `/:id/units` 5093, `/:id/cancel` 5206, `/:id/confirm-receipt` 5322. Lines priced by `resolveCartLine` (`cart.ts:357-441`; called `orders.ts:2420`), stock snapshot `stock_reserved` 2450; **`planInventory(db, stockMoves, {kind:'reserve', operationId: orderId, …})`** 4553-4571 → `CONFLICT_RETRY`, `reservationFenceStatement(db, orderId, 'reserve', plannedRows)` 4581 (`order_reservation_fence` CHECK actual = expected, `0058:148-157`); `INSERT INTO order_items (… pricing_snapshot, warranty_snapshot, transport_snapshot, bundle_*, membership_*, cost_*, dimensions …)` 4275-4310. Lifecycle reserve → deduct (confirm) → release/restore (`worker/lib/orderInventory.ts:1-34`, replayed from `inventory_ledger` rows, idempotency_key UNIQUE, 11 cols `0075:128-141`); scopes base|option|color|variant|preorder|preorder_transport → `products.stock/stock_reserved`, `product_option_values.stock/reserved`, `product_colors`, `product_variants`, `product_option_fulfillment.capacity` (`worker/lib/inventory.ts:89-98`). Lots/FIFO: `inventory_lots`, `order_item_inventory_allocations` (0098). **Community products are outside this ledger entirely.**

## 5. Platform `products` and the compatibility/composition precedents (where "component eligibility" can live)

`products` — 72 columns: `0001:71-112` (options/colors JSON legacy, selling_type direct_sale|pre_order|bundle, specifications JSON, stock NULL = untracked, product_cost_iqd…); `0018` inventory_mode BASE|…, stock_reserved, low_stock_threshold, category_id/sub_category_id → `catalogs` (with `template_family` devices|materials `0018:118`), **`template_family`**, sku, **`spec_fields` JSON** (`0018:179`), sale_types; `0058:22` composition ''|bundle|mystery; `0098:306-313` net/package dimensions; `0138` light_image. Relational options: `product_option_groups` (6), `product_option_values` (39 cols incl. stock/reserved/prices/cost, per-value physical dims 0099, adjust 0044) `0018:186-218`, `product_colors` (30, hex) 220-244, `product_color_option_links` (OR in group / AND across groups) 246-256, `product_variants` (21, combo_key) 258-276, `product_images` 278-297. **Facets** `facets` (kind admin-extensible) + `product_facets (product_id, facet_id)` `0018:121-139`. **Spec vocabulary** `worker/lib/templateFamilies.ts`: families devices/materials; material-family groups include `electronics` (1277), `hardware` (1287), `acc_general` (1300), `kits` (1250); PRODUCT_TYPES printer/parts/filament/accessory/laser/laser_material (1602-1785); admin form and CSV columns are generated from it. **Composition precedent** `bundle_config` (12 cols, price_mode fixed|discount_percent|discount_iqd, min_price_iqd) `0058:41-75`; **`bundle_components` (bundle_product_id, member_product_id ON DELETE RESTRICT, qty 1..99, optional, pinned option_value_ids/color_id, customer_picks_option/color, sort)** `0058:77-97`; `bundle_component_choices (component_id, dim option_value|color, ref_id)` allow-list 99-107; `cart_bundle_choices` 110-117; order lines carry bundle provenance and allocation. **Compatibility precedent** `product_printer_fits (product_id, printer_id, position)` `0148_maintenance_parts.sql:90-101` (+ `worker/lib/printerFits.ts`). Serial precedent `serial_inventory` (15 cols, `0139:28-52`). No flag anywhere says "usable inside a printed product".

## 6. Print materials, printers, accessories, requests, offers

- `merchant_material_stock` (8 cols: merchant_id, **material_id (catalogue `printMaterials` ids), color_hex '' = untracked colour, color_name, grams**, UNIQUE) `0132:109-119`; routes `GET/PUT /api/merchant/material-stock` (`worker/routes/merchantPrinters.ts:385,413`, `untrack:true` explicit); consumed by `worker/lib/eligibility.ts` stock dimension (five dimensions trade/capability/stock/reach/preference, lines 1-60; `Capability` multicolor|large_format|high_detail|functional|flexible|cf line 69). `merchant_printers` (34 cols: technology fdm|resin, build_x/y/z_mm, nozzle_mm, materials JSON ids, **colors JSON hex**, multicolor, enclosed, hardened_nozzle, quality_max, machine_hour_iqd, availability available|busy|offline) `0045:79-115` (+0144 multicolor facts live in `products.spec_fields` for sold printers). `printer_models` (38 cols, physics + merchant_selectable) `0078:28`, `0132:121-160`. `print_materials` (16 cols: material_type, density_g_cm3, default_iqd_per_kg, needs_enclosure, abrasive, **product_id → products (the filament SOLD)**) `0078:148-170`; `merchant_spools` (13 cols: material_id → print_materials, color_hex, purchase_iqd, remaining_grams) `0078:172-190`. Two material vocabularies coexist (catalogue ids vs `print_materials` ids — `0132` header says so).
- **Print accessories** = an admin SETTING, not products: `printAccessories` (`worker/lib/settings.ts:559`) seeded from `DEFAULT_ACCESSORIES` (`worker/lib/printAccessories.ts:88-124`: 26 rows, categories magnet|motion|electronics|fastener|finishing, unit piece|pair|set|cm|gram, cost_iqd; no product link); `priceAccessories(catalogue, selections, perPart)` 150-195 (MAX_ACCESSORY_QTY 500, unknown ids dropped); served `GET /api/print-quote/accessories` (`printQuote.ts:370`); request body `accessories:[{id,qty}]` ≤20 kinds (`printRequests.ts:367-378`), priced into the estimate (`printRequests.ts:1117`), **persisted only inside `community_request_revisions.estimate` JSON as `accessory_lines`** (`0130:74-86`; re-read at `printRequests.ts:786-799`). Estimate contract factor key `'accessories'` exists (`worker/lib/printEstimate/contract.ts:41-51`); forbidden public fragments `cost_|floor_|margin_|lines` (line 112).
- `community_requests` 29 cols (material, color, dimensions, quantity, budget_iqd, deadline, governorate, delivery_pref, visibility incl. 'direct', revision, target_merchant_id, origin_chat_id, created_by); `community_request_files` 12 cols; `community_offers` 23 cols (+ `material_ids`, `delivery_fee_iqd`, `quantity`, `color`, `terms`, `is_draft`, revision/request_revision) with `community_offer_revisions (price_iqd, terms JSON, reason)` `0130:89-99`; `community_orders` 27 cols (offer_snapshot, request_snapshot, contact_snapshot JSON; price identity CHECK) `0031:93-127`; `community_order_items` 7 cols (title, description, qty, unit, line) `0031:129-137`; `community_escrows` 16 cols.

## 7. Private products, files, coupons, delivery, invoices/receipts

- **Private product** (0152): `POST /api/chats/:id/custom-products` (`worker/routes/chatCommerce.ts:556`) body {name, name_ar, description, price_iqd, prep_days, valid_days ≤60, image, quote_id}; INSERT sets stock 1, publish_state published, variant_mode simple, audience/origin_chat/origin_offer/custom_expires_at (~612-616); buyable only by its audience (`worker/lib/privateProducts.ts`, `PRIVATE_BUYABLE_SQL` fence `storeOrders.ts:955-966`); no variants/media (triggers). Cancel 673; chat order list 722. Chat card add: `src/components/chat/cards/useAddToCart.tsx:26-29` posts `{productId, qty:1, replaceCart, origin_chat_id}`.
- **Files**: `product_files` (13 cols: role preview|download_after_purchase|reference|instruction|source_model, kind model|document|image|archive, **analysis JSON = ModelAnalysis, preview_key = LVM mesh**) `0157:25-43`; `product_file_grants (product_file_id, user_id, order_id|community_order_id, expires_at, downloads, UNIQUE(file,user))` 45-56; `viewer_grants` 12 cols; roles/grants `worker/lib/fileOwnership.ts:36-49`, `productFileGrantStatement` 186, `revokeOrderProductFileGrantStatements` 277, `ownedFileObject` 97 (private key of the owner with matching `purpose`).
- **Coupons**: `merchant_coupons` (14 cols: kind fixed_iqd|percent, value, min_total_iqd, max_uses/used_count, starts/ends) `0036:88-104`; platform `coupons` 31 cols (0002 + 0077 targeting/caps) + `coupon_redemptions`.
- **Delivery**: `merchant_delivery_profiles` (13) + `merchant_delivery_rules (store_id, governorate_id ∈ 18, mode fee|free|disabled, fee_iqd ≤1,000,000, free_over_iqd, prep_days ≤60)` `0120:36-77`; `checkoutDelivery` (`worker/lib/merchantDelivery.ts:328`), `deliveryFenceStatement` 417 (profile version), cap `merchantDeliveryFeeMaxIqd` 61; category rules `category_delivery_rules`.
- **Invoices/receipts**: `invoices (invoice_no, order_id, revision, snapshot JSON, amount_paid/due, payment_status)` `0003:95-107`; `createInvoiceForOrder` (`worker/lib/invoices.ts:338`), `createInvoiceRevision` 450; `renderPurchaseReceipt` (`worker/lib/receipts.ts:260`), `renderDeliveryLabel` 456, `escposReceipt` 560; `worker/routes/invoices.ts`.

## 8. Guards that bind any extension
- Additive migrations: `migrations/` convention is nullable/defaulted `ADD COLUMN` + `IF NOT EXISTS` (0126 header); `scripts/check-migrations-additive.mjs` (which flags every `ALTER TABLE`) guards `studio/drizzle` only (`tests/migrationsAdditive.test.ts:90`). `worker/lib/schemaVersion.ts:46,66` pins `EXPECTED_MIGRATION = '0161_storefront_vitals.sql'`, `EXPECTED_MIGRATION_COUNT = 154` — kept honest by `tests/schemaVersion.test.ts`; **0159–0161 are uncommitted in the working tree** (`git status`), so the next free number is 0162 at merge.
- Budgets `tests/bundleBudget.test.ts`: gzip level 9; ENTRY 72 KB (52), CHUNK 250 KB, INITIAL 200 KB (73), **CSS_BUDGET 60 KB = every stylesheet in dist/assets summed, lazy CSS chunks included** (75), STOREFRONT 47 KB = static closure of `Storefront`+`StorefrontProduct` beyond the initial payload excluding `vendor-*` (381-416), workspace shell 25 / closure 32 (446-447).
- Tests that pin commerce behaviour (620 test files total): `storeCheckoutIntegrity.test.ts` (B1–B25), `catalogCheckout.test.ts` (variants: server prices, race, cancel restock, low stock), `storeOrderCancel.test.ts`, `storeOrderRelease/MoneyReview/ReviewFixes`, `chatPrivateProducts.test.ts` (12 attacks), `productFiles.test.ts` (grant once, revoke on refund), `cartUpsert.test.ts` (merge identity), `cartIdentityContract.test.ts`, `merchantCartSeparation.test.ts`, `catalogModel/catalogRoutes.test.ts` (model gate, one-batch create/read-back, export→import round trip), `orderInventory.test.ts` (hold/deduct/release), `couponResolver/Limits/Dates`, `merchantDeliveryResolver`, `storeDeliveryCheckout`, `printEstimateContract.test.ts`, `publicApi.test.ts`, `schemaVersion.test.ts`, `bundleBudget.test.ts`.

REUSE:
[
 {
  "ask": "A «customization configuration» on a cart line (Part 2: the cart item preserves the exact customization; edit from cart)",
  "existing": "cart_items (19 cols; merchant-line identity idx_cart_merchant_line (user_id, community_product_id, option_id, color_id) 0141:50; variant_id 0126:274; CART_LINE_COLUMNS registry worker/lib/cartLineProjection.ts:36; the add door's ON CONFLICT merge cart.ts:2404; loadMerchantCart cart.ts:2445; the platform precedents option_value_ids canonical JSON (cartSelectionIdentity.ts) and cart_bundle_choices 0058:110)",
  "how": "Additive columns on cart_items: `configuration TEXT` (server-normalised, canonically sorted JSON of ids only — region ids, palette keys, text, size id, finish id, asset keys, component variant ids; never a price) and `config_hash TEXT NOT NULL DEFAULT ''` (sha256 prefix of that JSON). Make the hash part of the merchant-line identity: new unique index (user_id, community_product_id, option_id, color_id, config_hash) WHERE community_product_id IS NOT NULL replacing idx_cart_merchant_line (DROP INDEX + CREATE INDEX touches no row), and the add door's ON CONFLICT target names it. Register both columns in CART_LINE_COLUMNS with their defaults; extend the merchant-items body with `configuration` (ids in, server re-normalises against the product's template), add `PATCH /merchant-items/:id` acceptance of `configuration` (re-priced like an add), and return `configuration`, `configuration_summary` (merchant's words) and a preview key in loadMerchantCart items. Levonis lines (products) untouched."
 },
 {
  "ask": "The configuration on an order line, visible to the merchant and preserved for the Digital Twin / reorder",
  "existing": "order_items (37 cols) with JSON snapshot columns pricing_snapshot/warranty_snapshot/transport_snapshot 0002:99-101 (pricing_snapshot is NULL on store lines and is served to the buyer as `pricing` orders.ts:838); the store INSERT storeOrders.ts:1001-1010; merchantOrders.ts:288 line SELECT; ORDER_ITEMS_SELECT oi.* orders.ts:923",
  "how": "Additive `ALTER TABLE order_items ADD COLUMN configuration_snapshot TEXT` (immutable JSON: the normalised configuration + the merchant's words per region + the priced modifier lines by key, mirroring how option_snapshot holds words and pricing_snapshot holds the breakdown) written in the store checkout INSERT from PricedLine; merchantOrders.ts:288 adds it to the SELECT and serves it under `configuration`; the customer already receives it through oi.*. No second orders table; reorder = re-post the same configuration through the add door."
 },
 {
  "ask": "Real-time pricing by size/finish/colours/text/logo/photo/QR/NFC/components, server authoritative (Parts 2–3)",
  "existing": "resolveCatalogLine worker/lib/catalog/lines.ts:50 (one pricer for add/cart/checkout); priceMerchantCart storeOrders.ts:266 with quote_fingerprint v2 (436-450) and the NOT-NULL fences (939-992); deliveryFenceStatement merchantDelivery.ts:417 as the version-fence pattern; the Estimate contract's ordinal factors printEstimate/contract.ts:41 for the customer-facing «why this price»",
  "how": "Extend LineVerdict with `modifiers: [{key, iqd}]` and `unit = base + Σmodifiers`, computed only from the product's stored template rules (a new `community_product_customization` row read by LINE_VARIANT_JOIN's sibling join) — never from the body; add `config_hash` and the modifier total to the fingerprint tuple; add a template-version fence (like the delivery fence) so a merchant editing template pricing after the quote aborts with 409 CART_CHANGED; expose a single uncached quote door `POST /api/storefront/:slug/products/:productSlug/price {configuration}` (or route it through the existing cart quote) — the anonymousCached product read must not carry per-configuration prices."
 },
 {
  "ask": "How customizable regions relate to variants/options (Body/Base/Name/Text/Logo… colours, sizes, finishes)",
  "existing": "community_product_options (≤3 groups, kind choice|color, palette swatch) / option_values / variants (enumerated combinations ≤100 with own stock) 0126:87-146; the closed palette packages/catalog/src/palette.ts; attributes.ts material/technology/finish vocabularies; MaterialStock colour hexes 0132:109",
  "how": "Keep variants for the physical SKU axis (Small/Medium/Large, material) so stock and base price stay on the existing rows; add regions as a sibling structure (community_product_regions: product_id, key ∈ closed list body|base|name|text|border|accent|logo|icon|insert|accessory, kind color|text|logo|photo|qr|nfc, allowed palette keys, default, limits, price modifiers) rather than more option groups — a region×colour×text space is not enumerable into variants and the 3-group cap would break. The customer's chosen variant id continues to be `option_id`; the region choices live in the configuration JSON."
 },
 {
  "ask": "«Component eligibility» of a store product («Can be used inside printed products») and structured component metadata (Part 3)",
  "existing": "products (72 cols): spec_fields JSON 0018:179 rendered by templateFamilies groups electronics/hardware/acc_general/kits (templateFamilies.ts:1277-1300), template_family, facets/product_facets 0018:121-139, sale_types, composition; option values with per-value dimensions 0099; product_printer_fits 0148:90 (compatibility precedent); print_materials.product_id 0078:165 (a catalogue row pointing at the product sold)",
  "how": "One additive flag on products (`component_use TEXT NOT NULL DEFAULT ''` or `printed_component INTEGER NOT NULL DEFAULT 0`) plus a `component` spec group in templateFamilies (category magnet|motor|led|nfc|bearing|switch|insert|keyring|hook|cable|battery, diameter/length/width/voltage, installation) written into the existing spec_fields — the admin form and CSV columns generate themselves from the family definition; eligibility read = `component_use <> '' AND status='active'` in a new catalogue door `GET /api/components?category=` (anonymousCached with declared params). Component slots on a template mirror bundle_components/bundle_component_choices (member product, allowed option values/colours, qty, required) rather than a new inventory."
 },
 {
  "ask": "Stock reservation for components drawn from the store inside a merchant order; «reserve/deduct per the existing order lifecycle»",
  "existing": "planInventory(kind:'reserve') + reservationFenceStatement orders.ts:4553-4581; orderInventory.ts reserve→deduct→release/restore replayed from inventory_ledger; community products' direct decrement fenced at placement storeOrders.ts:939-1041 and restocked by cancelStoreOrder + trigger 0126 §9",
  "how": "Component lines that name a Levonis `products` row go through planInventory('reserve', operationId: orderId) inside the store-order batch (the same statements the platform checkout pushes), with the reservation fence appended; confirm/deduct and cancel/release reuse orderInventory's replay. Community-product units keep the placement decrement. This requires the money decision named in risks (who sells the component)."
 },
 {
  "ask": "Smart filament matching / inventory-aware colours / «fulfillable colours first»",
  "existing": "merchant_material_stock (material_id, color_hex, grams) 0132:109 + GET/PUT /api/merchant/material-stock merchantPrinters.ts:385/413; merchant_printers.colors hex JSON 0045:96; eligibility.ts stock dimension; the 22-key palette",
  "how": "A pure mapper palette-key → nearest stocked hex (Lab distance) reading the store owner's material_stock rows and printer colours; served inside the product's customization read as `stocked_palette` (per store, cacheable per store slug) — no new table; «unavailable» = no row within threshold, «alternative» = next nearest key."
 },
 {
  "ask": "Components/accessories on printing requests and merchant offers («use parts from the store», substitution 10→15 mm with the price difference)",
  "existing": "printAccessories setting (26 rows) + priceAccessories printAccessories.ts:150; request body accessories printRequests.ts:367 persisted in community_request_revisions.estimate 0130:74; community_offer_revisions.terms JSON 0130:89; community_orders.offer_snapshot 0031:110; the Estimate factor 'accessories'",
  "how": "Give each PrintAccessory row an optional `product_id`/`variant_id` (setting shape change, admin-editable) so the store catalogue becomes the price/stock source while the estimate keeps its per-part maths; persist the request's component list in community_request_revisions.spec (first-class, not only in estimate.accessory_lines); an offer revision's `terms` gains `components:[{slot, product_id, variant_id, qty, iqd}]`; acceptance already snapshots into community_orders.offer_snapshot."
 },
 {
  "ask": "The template's 3D model, previews and downloadable files for a customizable product",
  "existing": "product_files roles preview|source_model (analysis JSON, preview_key LVM) 0157:25; ownedFileObject/viewer_grants fileOwnership.ts:97; grants written in the checkout batch and revoked on cancel",
  "how": "The template mesh is a product_files row (role `preview` for the viewer; a new role value only if the region map must be a separate artefact); the region→mesh-group map lives in the customization row, not in the file; purchase grants unchanged."
 },
 {
  "ask": "Merchant-proposed configured items and «what the customer was shown is what they pay»",
  "existing": "Private products 0152 (immutable one-customer community_products rows, buyable through the same cart/checkout; chatCommerce.ts:556)",
  "how": "A merchant's counter-proposal of a configuration becomes a private product carrying `configuration_snapshot` (new nullable column on community_products or the customization row keyed to it) — the locked-row trigger already guarantees the price cannot move."
 },
 {
  "ask": "Public API / merchant editor surfaces",
  "existing": "getStoreProduct DTO stores.ts:294-350 (registry → OpenAPI, publicApi.test walks it); ProductEditorSheet Disclosure sections; catalogApi.ts write shape 169-174; readProductInput 283",
  "how": "Add `customizable` + region summary to the store product DTO schema and handler in the same edit; a new lazy `sectionCustomize` Disclosure whose editor is its own chunk; `readProductInput` gains a `customization` key parsed by a pure `normalizeCustomization` in packages/catalog beside normalizeVariantModel."
 }
]

GAPS:
["No configuration/JSON column on cart_items for a community line — only option_id (= variant id), color_id, variant_id; the merchant-line unique index would merge two differently-personalised copies of one variant into one line (cart.ts:2404).","order_items has no configuration snapshot; store lines write pricing_snapshot = NULL and only option_snapshot text + sku_snapshot (storeOrders.ts:1001-1010); merchantOrders.ts:288 shows option/sku only.","PATCH /api/cart/merchant-items/:id changes quantity only (cart.ts:2604) — no path to re-configure a line from the cart.","quote_fingerprint v2 (storeOrders.ts:436-450) has no slot for a configuration or its price modifiers; no template-version fence exists (only the delivery profile fence).","No template/region structure: option groups are capped at 3 and variants are enumerated (≤100) with their own stock (0126:87-146) — regions × palette × text cannot be modelled as variants.","No «component eligibility» flag or component metadata on products; no slot/compatibility table for community products (bundle_components/bundle_component_choices exist for platform bundles only, 0058:77-107; product_printer_fits is printer-specific, 0148:90).","Print accessories are a settings JSON catalogue (26 rows, printAccessories.ts:88) with no product_id/variant link — the 'duplicate inventory' Part 3 forbids; request accessories persist only inside community_request_revisions.estimate.accessory_lines (0130:74; printRequests.ts:786-799), not as a first-class spec field.","Community products have no reservation ledger: stock is decremented at placement in the batch and restocked on cancel (storeOrders.ts:1027; storeOrderOps.ts:405); nothing holds cart units; the platform ledger (inventory_ledger, order_reservation_fence) is products-only.","community_products carry no cost, BOM, filament or production fields (47 cols, 0001/0030/0126/0152); community_offers has material_ids/color/quantity/terms but no components; community_order_items are title/description/qty/price only (0031:129).","Two material vocabularies: merchant_material_stock uses catalogue printMaterials ids (0132 header) while merchant_spools/print_materials use print_materials ids (0078); merchant_printers.colors are raw hex JSON (0045:96) with no palette mapping.","The storefront product read is anonymousCached with no declared params (storefront.ts:695) — no door exists for a per-configuration price or a per-store stocked palette.","No customization UI in StorefrontProduct.tsx beyond VariantPicker + QuantityInput; Sorani missing at StorefrontProduct.tsx:288, 322, 407 (OWNER markers) and palette/attribute names are ar/en only (palette.ts, attributes.ts).","readProductInput ignores unknown body keys (catalog/product.ts:283) — a customization payload sent today is dropped silently rather than refused.","The public API store product DTO has no customizable/region fields (stores.ts:294-350); the community products list (community.ts:392) likewise.","No per-line Digital Twin/reorder link: reorder of a store order is not a route (platform 'reorder' exists in cart.ts for Levonis lines only); private products carry origin_offer_id but no configuration."]

RISKS:
["CSS: every stylesheet summed at gzip-9 is 59.5 KB against a 60 KB budget (index 46.9 + Auth 7.9 + theme 1.5/1.2 + ListingView 0.6 + swatches 0.5 + StoreDesignPanel 0.5 + orderPrint 0.4) — 0.5 KB headroom, and lazy CSS chunks count too (tests/bundleBudget.test.ts:75). A customization sheet must introduce effectively zero new utility classes (reuse existing tokens/classes; no new route stylesheet of any size beyond ~500 B).","Storefront closure: 42.6 KB of 47 KB beyond the initial payload (my measurement, vendor-* excluded) — 4.4 KB for anything statically imported by StorefrontProduct; the customizer, the viewer (ModelViewer chunk 7.3 KB + ogl) and the price door must all be lazy chunks mounted on tap.","Cart identity change: replacing idx_cart_merchant_line (0141:50) and the add door's ON CONFLICT target is pinned by tests/cartUpsert.test.ts and cartIdentityContract.test.ts; a hash in the identity must be canonical (sorted JSON) or equal configurations become separate lines.","Money authority: adding configuration modifiers anywhere but resolveCatalogLine (worker/lib/catalog/lines.ts:50) lets add/cart/checkout disagree; the fingerprint (storeOrders.ts:436) and a new template-version fence must both change in the same PR or a stale quote can place at a new price (B12 pattern, tests/storeCheckoutIntegrity.test.ts:317).","Cross-seller components: a Levonis `products` component inside a merchant store order breaks the one-seller cart triggers (0141:54-61), the commission split (commission on merchant goods only, storeOrders.ts:426-432) and the merchant ledger lines (storeSaleLedgerStatements) — needs an owner decision: components as merchant-purchased BOM cost (merchant buys from Levonis separately) vs Levonis-sold lines settled to Levonis inside the same order.","Reservation semantics differ per seller: community products decrement at placement, platform products reserve → deduct on confirmation (orderInventory.ts); a mixed order needs one story for cancel/restock (cancelStoreOrder restocks community units; planInventory release for platform units) or units strand.","Migration numbering: 0159–0161 are uncommitted in the working tree (git status) and MERCHANT_PLATFORM_V2 lines 167-171 still plan P7–P10 at 0157–0161; every Programme C migration must take the next free number at merge and move EXPECTED_MIGRATION/EXPECTED_MIGRATION_COUNT (schemaVersion.ts:46,66) in the same commit.","Private-product lock (0152 trg_private_product_locked) forbids editing options/variant_mode/price — a configured private product must be created complete; and 0152's status rule must stay in any recreated trigger.","anonymousCached product reads: a per-configuration price or per-viewer stocked palette leaked into the cached product body would be served to other visitors; keep them on separate doors with declared params or session-only.","The print accessories catalogue is a settings JSON (admin-edited); linking rows to products/variants is a data migration of a setting, not a table, and both estimate engines (printPricing.ts, printQuote/model.ts) read it — tests/printEstimateContract.test.ts pins the public shape (no cost_/floor_/margin_/lines).","Overlap with running programmes: merchant P6 (estimate doors, EstimateCard) and community §9.6–9.8 touch RequestWizard/requests api (src/components/community/requests/api.ts is uncommitted-modified now), merchantPrinters.ts and eligibility.ts are modified in the working tree — schedule the request-side component work after Phase 5/P5 land and rebase on merchantPrinters.ts.","publicApi.test walks the route registry against OpenAPI — DTO changes to getStoreProduct must update the schema in the same edit or CI fails.","Palette-only colours (22 keys) vs merchant hex stock: 'exact filament colour' cannot be promised (DECISIONS 174-style honesty); matching must be presented as approximate.","Every new merchant/storefront string needs real Sorani (D6, DECISIONS 169); StorefrontProduct already carries three OWNER markers — a customizer adds dozens."]

NUMBERS:
Schema (all 154 migrations applied in-memory with node:sqlite): 250 tables, 58 triggers. Columns / triggers: community_products 47 / 9; community_product_options 8; community_product_option_values 9; community_product_variants 17 / 6; community_product_media 9 / 1; cart_items 19 / 2; cart_bundle_choices 5; order_items 37; orders 85 / 5; community_orders 27; community_order_items 7; community_escrows 16; products 72; product_option_groups 6; product_option_values 39; product_colors 30; product_variants 21; product_files 13; product_file_grants 8; viewer_grants 12; merchant_material_stock 8; merchant_printers 34; printer_models 38; print_materials 16; merchant_spools 13; community_requests 29 / 3; community_offers 23 / 1; community_request_files 12; merchant_coupons 14; coupons 31; merchant_delivery_rules 9; merchant_delivery_profiles 13; invoices 10; inventory_ledger 11; order_reservation_fence 5; bundle_config 12; bundle_components 11; bundle_component_choices 4; product_printer_fits 4; product_facets 2; facets 10; merchant_stores 28; serial_inventory 15; order_status_history 8; file_objects 14; upload_sessions 16. 63 tables match product|cart|order|stock|inventory|material|printer|spool|coupon|invoice|deliver.
Model caps: 3 option groups × 30 values, 100 variants, 12 media (2 videos), 12 files/product, 22 palette swatches, 5 technologies, 6 finishes, LINE_QTY_MAX 9999, QTY_INPUT_MAX 999,999, 26 default print accessories (MAX_ACCESSORY_QTY 500, ≤20 kinds per request), 18 governorates, merchant delivery fee ≤ 1,000,000 IQD, STORE_RELEASE_DAYS 3, STORE_HOLD_TTL 30 min, private product valid_days ≤ 60.
Code size (lines): worker/routes/cart.ts 2656; storeOrders.ts 1266; worker/lib/storeOrderOps.ts 1088; orders.ts 5422; merchantCatalog.ts 1394; products.ts 4576; storefront.ts 828; worker/lib/catalog/lines.ts 83; catalog/product.ts ~740; packages/catalog/src/variants.ts 324; src/pages/Product.tsx 4242; StorefrontProduct.tsx 474; Cart.tsx 2663; StoreCheckout.tsx ~760; ProductEditorSheet.tsx 534; VariantEditor.tsx 358; tests/ 620 files.
dist (built 2026-09-30 01:46, gzip level 9 as tests/bundleBudget.test.ts measures): CSS all stylesheets 59.5 KB / 60 KB budget (index-B6C-KbqL.css 46.9, Auth 7.9, theme 1.5 + 1.2, ListingView 0.6, swatches 0.5, StoreDesignPanel 0.5, orderPrint 0.4); entry index-CzUpUV6H.js 66.2 KB / 72; initial static closure 182.8 KB over 4 files (entry 66.2 + vendor-react 73.3 + vendor-motion-core 31.7 + vendor-i18n 11.6) / 200; storefront pages beyond initial 70.5 KB including vendor-icons 12.2 + vendor-motion 15.7 → 42.6 KB own / 47 (StorefrontProduct 6.3, Storefront 6.2, StoreRenderer 11.0, theme 6.8 + 3.0, QuantityInput 2.7, Tabs 1.4, swatches.js 0.6, storefrontApi 0.6, …). Chunks: Product 40.8 KB, Cart 18.9, Checkout 21.2, StoreCheckout 8.2, ModelViewer 7.3, ProductEditorSheet 9.4, ProductForm 43.2, CustomProductSheet 3.1, OrderDetail 26.0, OrdersBoard 24.9, ProductFacts 0.8, ProductFiles 1.6, Community 9.5, AdminCommunity 40.7. (gzip default level gives index.css 48.8 KB and entry 67.6 KB — the budget test's level-9 figures above are the binding ones.)
Working tree: 44 uncommitted paths (community Phase 5 + merchant P4/P5), including migrations 0159_offers_v2, 0160_request_discussion_timeline, 0161_storefront_vitals; EXPECTED_MIGRATION_COUNT 154; next free migration number at merge = 0162.

---

## Survey — print

## PRINT substrate — as it is on 2026-09-30 (branch claude/new-session-2hq4ci @ 98dc0305 + uncommitted Phase 5 / P4 / P5 edits)

### 0. State of the tree (read-only survey)
- Uncommitted, in flight: `migrations/0159_offers_v2.sql`, `0160_request_discussion_timeline.sql`, `0161_storefront_vitals.sql`; new `worker/routes/communityOrderTimeline.ts` (553), `worker/routes/requestDiscussion.ts` (572); modified `worker/routes/marketplace.ts` (+819/-…), `worker/lib/printMatchingStore.ts` (+134), `worker/routes/merchantPrinters.ts` (+101), `worker/lib/uploadEntity.ts` (+122), `worker/lib/notifications.ts` (+41), `worker/lib/eligibility.ts` (+9), `worker/lib/printMatchingScore.ts` (+24), `src/components/community/requests/api.ts` (+362), `worker/lib/schemaVersion.ts` (EXPECTED_MIGRATION 0158→0161, count 151→154). `ls migrations | wc -l` = 154 files; **next free number at merge = 0162** (shifts if Phase 5 renumbers).
- `dist/` exists (built 2026-09-30 01:46, i.e. before the in-flight client edits) — all sizes below are from it, gzip level 9 exactly as `tests/bundleBudget.test.ts:77` measures.

### 1. Tables (columns as the migrations create them)

| Table | Created / extended | Columns that matter |
|---|---|---|
| `community_requests` | 0001:273-279; 0031:21-39; 0116:89; 0130:102-103; 0151:37-40 | id, customer_id, title, description, status(open\|closed CHECK), created_at; **state** TEXT (draft\|open\|receiving_offers\|offer_selected\|in_progress\|delivered\|completed\|cancelled\|disputed\|expired — enforced in code, not CHECK), category, quantity, material, color, dimensions, budget_iqd, deadline, governorate, delivery_pref, notes, visibility ('public'\|'direct'), offer_count, **accepted_offer_id**, **community_order_id**, expires_at, updated_at, **revision** (0116), customer_notes, published_at (0130), **target_merchant_id**, **origin_chat_id**, created_by(customer\|merchant CHECK) (0151). Triggers 0151:47-79 lock direct visibility/target and refuse other stores' offers. |
| `community_print_requests` | 0045:152-189; 0130:105-108 | request_id PK→requests, process(fdm\|resin CHECK), material_id, color_hex, color_name, quality(draft\|standard\|fine\|ultra CHECK), infill_percent, supports, colors_count, post_processing_minutes, primary_file_id→request_files, source_kind(upload\|link), source_provider, source_url, source_meta, **analysis JSON, estimate JSON** (accessory_lines live inside estimate — printRequests.ts:2127-2129), estimate_low/high_iqd, estimate_confidence, completeness, source_type, process_unsure, material_unsure, stated_dims. No accessories column, no components. |
| `community_request_files` | 0031:48-57; 0045:195-197, 249 | id, request_id, file_key (never sent to browser), file_name, content_type, size_bytes, kind(reference\|model\|document), model_format, analysis, analysed_at, **preview_key** (LVM1 mesh in R2). |
| `community_request_revisions` | 0130:74-87 | id, request_id, revision≥1, **spec JSON, files JSON, estimate JSON, hash**, reason CHECK(publish\|edit\|files\|backfill), created_by; UNIQUE(request_id, revision). |
| `community_offers` | 0031:61-78; 0116:90-91; 0130:110; 0159:36-40 | id, request_id, merchant_id, store_id, price_iqd>0, completion_days, delivery_method, message, materials, included, warranty_terms, state CHECK(pending\|accepted\|rejected\|withdrawn\|expired\|superseded), expires_at, **revision, request_revision**, material_ids JSON (≤5), **delivery_fee_iqd, quantity, color, terms, is_draft** (0159). |
| `community_offer_revisions` | 0130:89-100 | id, offer_id, revision, request_revision, price_iqd, terms JSON, reason CHECK(create\|edit\|reconfirm\|backfill); UNIQUE(offer_id, revision). |
| `community_offer_files` / `community_offer_drafts` | 0159:46-58 / 64-75 | files: offer_id, file_key, kind(image\|pdf\|model), name, bytes; drafts: UNIQUE(request_id, merchant_id), payload_json, files_json. |
| `community_request_matches` | 0045:205-221; 0132:160-169 | request_id, merchant_id (UNIQUE pair), eligible, reject_reason, score, score_detail JSON, notified, notification_id, **revision, reasons JSON, printer_id, notify_ok, engine (=2), computed_at**. |
| `community_match_queue` | 0132:171-180 | kind(request\|merchant), subject_id, reason, queued_at, attempts, last_error; PK(kind, subject_id). |
| `community_request_comments` | 0160:32-45 | request_id, author_id, parent_id, kind CHECK(public_comment\|merchant_question\|customer_answer\|system_update), body, state(visible\|removed\|hidden), admin_hidden_reason. |
| `community_orders` | 0031:93-121; 0130:112-114; 0160:67-68 | id, **request_id, offer_id**, customer_id, merchant_id, store_id, state CHECK(accepted\|funded\|in_progress\|merchant_marked_delivered\|customer_confirmed\|completed\|disputed\|cancelled\|refunded), price_iqd, commission_percent_x100, platform_fee_iqd, merchant_receivable_iqd, completion_days, delivery_method, **offer_snapshot JSON, chat_id→chats**, delivered_at, confirmed_at, auto_complete_at, completed_at, cancelled_at, **request_revision, request_snapshot JSON, contact_snapshot JSON** (0130), **ready_at, started_at** (0160). CHECK platform_fee+receivable=price (0031:120). Partial unique `idx_community_orders_offer_live` on offer_id WHERE state<>'cancelled' (0116:94-96). |
| `community_order_items` | 0031:129-137 | community_order_id, title, description, qty, unit_price_iqd, line_total_iqd — **no writer and no reader anywhere in worker/** (grep). |
| `community_order_updates` | 0160:54-63 | community_order_id, actor_id, kind CHECK(started\|progress\|photo\|ready\|note\|modification_request\|delivered), body, file_key (private `community-orders/<id>/updates/`). |
| `community_escrows` | 0031:144-164 | id, **community_order_id UNIQUE**, customer_id, merchant_id, gross_iqd, platform_fee_iqd, merchant_receivable_iqd, **released_iqd, refunded_iqd**, state CHECK(pending\|held\|released\|partially_refunded\|refunded\|disputed\|cancelled), hold_id (wallet hold), held_at, released_at, refunded_at, disputed_at; CHECK released+refunded ≤ gross (163). |
| `community_escrow_events` | 0031:170-181 | escrow_id, kind CHECK(created\|held\|release\|refund\|dispute_open\|dispute_resolve\|cancel), amount_iqd, actor_id, actor_role, reason, idempotency_key UNIQUE. |
| `wallet_holds` | 0015 | id, user_id, kind, amount_cents, state, event_key, ref_type, ref_id, tx_id, note, release_reason, committed_at, released_at; index on (ref_type, ref_id) is **non-unique** (0015:98) — several holds per order are possible at wallet level. |
| `community_complaints` / `community_complaint_messages` | 0031:256-278 / 283-292 | reporter, reported_user, merchant, store, order_id, community_order_id, offer_id, product_id, category, description, status CHECK(submitted\|under_review\|waiting_customer\|waiting_merchant\|resolved\|rejected\|closed), priority, assigned_admin_id, resolution; messages: sender_role, body, file_key, **internal** flag. |
| `merchant_reviews` / `merchant_reputation_events` / `merchant_payout_ledger` | 0031:210-251, 187-203 | reviews tied to exactly one of order_id / community_order_id (CHECK 226); reputation kinds incl. dispute_lost/won, on_time/late; payout ledger kinds incl. community_order_credit, refund_debit. |
| `merchant_printers` | 0045:79-114; 0078:124-137 | merchant_id, store_id, name, technology CHECK(fdm\|resin), brand, model, build_x/y/z_mm, nozzle_mm, materials JSON, colors JSON (hex), multicolor, enclosed, hardened_nozzle, quality_max CHECK, machine_hour_iqd, availability CHECK(available\|busy\|offline), active, sort_order, **model_id→printer_models**, purchase_iqd/date, residual_iqd, useful_print_hours, maintenance_iqd_per_hour, electricity_iqd_per_kwh, labor_iqd_per_hour, hours_printed, multi_material, toolhead_count. |
| `printer_models` | 0078:28-113 (+0132:122) | manufacturer, model, technology, build xyz, nozzle_sizes, toolhead_count, independent_toolheads, **max_simultaneous_materials, multi_material CHECK(none\|single_nozzle_changer\|independent_toolheads\|idex\|toolchanger)**, enclosed, heated_chamber, hardened_nozzle_available, materials JSON, watts, economics, flow/overhead/warmup, merchant_selectable. Seeded: 14 Bambu (0078:451-478) + 13 Creality/Prusa/Elegoo/Anycubic/Formlabs incl. 6 resin (0132:133-158). |
| `merchant_request_prefs` | 0045:122-144; 0159:79-82 | merchant_id PK, processes, materials, colors, **capabilities** (multicolor\|large_format\|high_detail\|functional\|flexible\|cf), governorates, delivery, min/max_job_iqd, min/max_size_mm, **workload CHECK(light\|normal\|busy\|full)**, paused, paused_until, **turnaround_days, technologies (derived), max_build_mm (derived), workshop_intro** (0159). |
| `merchant_material_stock` | 0132:109-120 | merchant_id, material_id, color_hex (#rrggbb CHECK), color_name, grams; UNIQUE(merchant, material, color). Read by eligibility `stock` dimension and `publicWorkshopFacts`. |
| `merchant_spools` | 0078:173-191 | merchant_id, material_id→print_materials, brand, color_name, color_hex, purchase_iqd, original_grams, remaining_grams; read only by engine B `loadMaterialPrices` (repository.ts:276). |
| `print_materials` | 0078:148-171 | id, material_type, name/name_ar, density, diameter, default_iqd_per_kg, needs_enclosure, abrasive, temps, supports_soluble_interface, **product_id→products** (166); 9 seeded (531-541). |
| `print_analyses` / `print_analysis_materials` | 0078:203-286 | owner_id or guest_token_hash, file_key, sha256, source(file\|image\|gcode), fingerprint, printer_model_id, quality_id, strength_id, nozzle, supports, provenance CHECK, bbox, volume, part_count, layers, minutes, plate_count, tool_changes, unmeasured, refusal, state CHECK(uploading…failed), expires_at; per-slot grams (model/support/interface/purge/prime/brim/waste). |
| `print_quotes` / `print_quote_cost_components` | 0078:296-355 | analysis_id, merchant_id, merchant_printer_id, printer_model_id, engine_version, confidence CHECK(exact\|estimated\|insufficient), quantity, base_cost, failure_reserve, **true_cost, price, profit, margin, markup, break_even, range**, waste, machine_hours, snapshot, state CHECK(draft\|offered\|accepted\|expired\|withdrawn), **request_id→community_requests** (334); components with source provenance. |
| `print_actuals` / `print_failures` / `printer_calibration_stats` | 0078:364-428 | actuals vs estimate per printer/material; failure causes CHECK(9); calibration factors per (merchant, printer, model, material). |
| `model_view_tokens` | 0045:231-242; 0132:182-185; 0157:103-105 | token_hash PK, file_id, request_id, created_by, expires_at, revoked_at, uses, **revision, grant_level(full\|preview), bound_user**, **source_type(request\|product\|post), source_id**. |
| `viewer_grants` | 0157:83-101 | token_hash, source_type CHECK(product\|post), source_id, file_key, grant_level, bound_user/session, expires_at — a second viewer-token system beside model_view_tokens. |
| `request_file_reads` | 0132:187-201 | per (file, user, what, hour) audit: access(owner\|admin\|engaged\|eligible), what(original\|inline\|preview_link\|preview_meta\|preview_mesh\|costing). |
| `upload_sessions` / `file_objects` | 0156:24; 0068:4 (+0156:47-48 sha256, purpose) | object_key PK, visibility, domain, owner_id, entity_id, mime_type, byte_size, original_name, deleted_at. |
| `product_files` / `product_file_grants` / `community_post_files` | 0157:25-81 | product files with role CHECK(preview\|download_after_purchase\|reference\|instruction\|source_model), analysis, preview_key; grants per user with order_id **or community_order_id**. |
| `community_products` (store side) | 0001:257; ALTERs incl. 0126, 0152 | + material, print_technology, color, finish, dim_x/y/z_mm, weight_g (0126); options/option_values/variants (0126:87-178); **audience_user_id, origin_chat_id, origin_offer_id, custom_expires_at** (0152:52-55) = private product minted from a chat quote. |
| `community_posts` | 0153:48-80 | kind CHECK(**project**\|post\|tutorial\|timelapse\|before_after) (51-52); print facts printer_product_id, printer_name, material_product_id, material, color, print_settings, print_time_minutes, dimensions; links store_id, product_id, **request_id, community_order_id** (69-72); consent_status. |
| `user_notifications` | 0045:36-69 | kind, title/body ar+en (no ckb column), link (in-app path), entity_type(request\|offer\|order), entity_id, meta, event_key UNIQUE per user. |
| `chats` | 0001:294 + ALTERs | order_id, **context_type ('store'\|'request'\|'store_order'), context_id, merchant_id, store_id, community_order_id**, last_message_at; `chat_participants.role`; `chat_messages.card_type` CHECK(product\|custom_product\|print_request\|quote\|order\|custom_order\|store) (0150:44). |
| `serial_inventory` (0139:28) / `device_serials` (0003) | store-product serials: serial_norm/raw, model_code, product_id, variant_id, box_sn, voided_at… — no community link. |
| `farm_*` (0053) | the Printer-Farm **game** (farm_printers, farm_jobs, farm_assignments…) — not merchant hardware; ignore for production. |

Frozen enumerations (SQLite CHECK, cannot be widened without a rebuild, which is forbidden): community_orders.state, community_offers.state, offer/request revision `reason`, order_updates.kind, request_comments.kind, escrows.state, escrow_events.kind, merchant_printers.technology (fdm\|resin), community_print_requests.process/quality, print_quotes.state, viewer_grants.source_type, complaints.status.

### 2. Routes (guards as registered)

Mounts (`worker/index.ts`): `/api/marketplace/print`→printRequestRoutes (524); `/api/marketplace`→marketplaceRoutes (526), requestDiscussionRoutes (531), communityOrderTimelineRoutes (532); `/api/print-quote` (376); `/api/admin/print-quote` (424); `/api/merchant`→merchantPrinterRoutes (481); `/api/merchant/workshop` (477); `/api/chats`→chatCommerceRoutes (359); `/api/uploads/sessions` (368); `/api/notifications` (535); `/api/community-reviews` (546); `/api/admin/community` (422).

**marketplace.ts (3108 lines)** — `publicRequest()` whitelist :143 (19 fields: id title description category quantity material color dimensions budget_iqd deadline governorate delivery_pref state offer_count created_at expires_at customer_name file_count revision customer_notes). GET /requests :266 (requireCommunityOpen; limit≤50, cursor, q, category, governorate); GET /requests/:id :294; files POST :504 / GET :613 / DELETE :673 (requireAuth); POST /requests :720; GET /my-requests :781; POST /requests/:id/cancel :805 (draft\|open\|receiving_offers only, :825); `insertOfferStatements` :1225 fences on state IN open/receiving_offers AND visibility='public' AND `eligibleVerdictSql` (:1239-1242); GET /requests/:id/offers :1268 (customer sees non-drafts; merchant sees own + draft; history from offer_revisions); POST /requests/:id/offers :1356 (accepts price_iqd, delivery_fee_iqd, quantity, color, terms, completion_days, delivery_method, expires_at/valid_days, material_ids, materials, included, warranty_terms, message, files[{key}], quote_id :1399, draft); POST /offers/:id/withdraw :1498; PATCH /offers/:id :1555; POST /offers/:id/send :1673; GET /offers/:id/files/:fileId :1757 (customer, merchant, admin only); POST /offers/:id/reconfirm :1806; /decline :1867; GET /my-offers :1898; **POST /offers/:id/accept :2097** (body expected_total_iqd + offer_revision; contactSnapshot; composeSnapshot; `reserveEscrowFunds` :2238 → one batch `escrowRecordStatements` :2332 with request→in_progress, offer freeze, order insert with offer_snapshot/request_revision/request_snapshot/contact_snapshot/chat_id; `openStoreThread` for a board request; `releaseEscrowReservation` on failure :2358); GET /orders/:id :2427; POST /orders/:id/start :2489; /delivered :2544 (auto_complete_at = now + `communityAutoCompleteDays`, default 7 — merchantOps.ts:187-195); /confirm :2591 (`releaseEscrow` :2628); /dispute :2675 (`disputeEscrow` :2697, order+request→disputed, INSERT community_complaints, notifies); /cancel :2783 (`refundEscrow` full, orderStates accepted/funded :2833); GET /orders :2885; complaints :2985/:3003/:3042.

**printRequests.ts (2246)** — GET /catalog :215 (`anonymousCached`; materials, accessories, processes, qualities, capabilities, formats, min_job_iqd); POST /requests/:id/files/:fileId/analyze :259; POST /link :331 (providers from setting `printLinkProviders`: makerworld, printables, thingiverse, thangs, cults3d — externalModels.ts:52-56); POST /quote :481 (engine A; strips cost_lines/cost_iqd/floor_iqd/margin_percent/accessory_lines :543-544); `readAccessories` :367 (≤20 lines, qty≤500); `readSpec` :408 (process, material_id\|'unsure', quality, infill 0-100 def 20, supports, colors_count 1-16, post_processing 0-600, quantity 1-10000, color_hex, color_name, accessories); `readWizardInput` :856 (primary_file_id, source_type, source_url, source_meta, stated_dimensions_mm, governorate, delivery_pref, deadline, budget_iqd, customer_notes); `printRowStatement` :990; POST /requests/:id/publish :1311; PUT/GET /requests/:id/draft :1332/:1452; GET /requests/:id/revisions :1474 (diff over `REVISION_FIELDS` :1462 = 19 keys); GET /requests/:id :1575 (print side; owner/engaged only; deletes cost keys :37-40 of block); `VIEWER_TOKEN_TTL_MINUTES = 60` :1683; POST …/viewer-token :1708 (grant full\|preview by `previewGrantFor`); GET /viewer/:token :1765, /viewer/:token/mesh :1809; **POST /requests/:id/repeat :1996** (new draft; copies R2 file + preview + analysis rows :2040-2100); GET /my-requests :2162.

**printQuote.ts (1993)** — GET /printers :324, /accessories :370 (setting `printAccessories`), /materials :394 (all `anonymousCached`); POST /uploads :410 (file, guest_token; color_hex, material_id, nozzle_mm, printer_model_id, quality_id, strength_id, quantity, supports); /analyses/:id/measure :573; /analyses/:id :695; /lookup :827; GET /analyses/:id :858, /file :870; POST /analyses/:id/quote :891 (accessories); /grams-quote :1220; /link :1374; /analyses/:id/compare :1443 (requireAuth); admin printer-models :1909/:1935.

**merchantPrinters.ts (668)** — GET/POST/PUT/DELETE /printers :157/:317/:334/:354 (`readPrinter` :196 fields listed in §1 + economics; every write calls `refreshWorkshopFacts` in flight); GET/PUT /material-stock :385/:413 (lines[{material_id,color_hex,color_name,grams}], untrack); GET/PUT /request-prefs :482/:536 (turnaround 1-60 d, workshop_intro ≤300 chars, technologies/max_build_mm derived, not accepted from client); GET /request-matches :638 (request_id, title, state, eligible, reject_reason, reasons, score, notified, notify_ok, computed_at).

**merchantWorkshop.ts (463)** — GET /board :84 (eligible requests + estimate range, file_count, has_preview, thumb_url, my_offer, next_cursor); GET /requests/:id/eligibility :200; **POST /requests/:id/cost :233** (file_id, material_id, merchant_printer_id, quality_id, strength_id, supports → reads bytes once, writes print_analyses + print_quotes draft with request_id); GET /requests/:id/costs :426.

**chatCommerce.ts (771)** — POST /:id/print-requests :152 (direct request: visibility 'direct', target_merchant_id, origin_chat_id, created_by), /send :196; POST /:id/quotes :299 (community_offers + `quote` card), PATCH :421; POST /:id/custom-products :556 (private community_products bound to a quote → cart → store `orders`), cancel :673; GET /:id/orders :722.

**communityOrderTimeline.ts** — POST /orders/:id/updates :272 (merchant: progress\|photo\|ready\|note; customer: modification_request only before delivered; `ready` only from in_progress and sets ready_at; photo via `ownedFileObject(purpose 'order_update')`, images only); GET /orders/:id/timeline :435 (created, escrow events funded/release/refund/dispute, updates, delivered…; files as URLs); GET update file :477; report :513.

**requestDiscussion.ts** — COMMENT_KINDS :64, COMMENT_MAX 1000 :70, SYSTEM_UPDATE_CODES (revised\|accepted\|cancelled\|completed\|expired\|disputed\|republished) :73; GET :218, POST :380 (merchant_question needs `liveVerdictForUser`), DELETE :498, report :526.

**Admin** — adminCommunity.ts POST /escrows/:id/resolve :1283 (decision release\|refund\|partial_refund + amount_iqd → `releaseEscrow` :1322 / `refundEscrow` :1329; only when disputed). Settings written via admin.ts PUT /settings/:key :3847 and adminCommunity PATCH /settings :212/:258. Keys: printMaterials, printPricingConfig, printMatchWeights, printLinkProviders, printAccessories, printMatchNotifyLimit (25), communityRequestExpiryDays (30), communityAutoCompleteDays (7), printServicePricing (settings.ts:527, non-public), communityGate.

**Public store** — community.ts GET /store/:id :531 emits `workshop` = `publicWorkshopFacts` (:566, in flight): technologies, materials, max_build_mm, turnaround_days, governorates, delivery, custom_enabled, intro.

### 3. Libraries

- **State machines** `worker/lib/communityStates.ts`: REQUEST_STATES :18-29, REQUEST_TRANSITIONS :36-60 (acceptance jumps open/receiving_offers → in_progress; disputed → completed\|cancelled; expired → open); OFFER_STATES :78; COMMUNITY_ORDER_STATES :107-117, transitions :120-135 (merchant_marked_delivered → customer_confirmed\|disputed\|in_progress); `cancellationPolicy` :159-186 (accepted/funded: customer\|merchant\|admin, full refund; in_progress/merchant_marked_delivered/disputed: admin only, decided_by_admin).
- **Escrow** `worker/lib/escrowOps.ts` (889): EscrowState :53; EscrowFailure :80 (INSUFFICIENT_FUNDS, STATE_CONFLICT, ORDER_CHANGED, AMOUNT_EXCEEDS_HELD, MERCHANT_SUSPENDED…); `reserveEscrowFunds` :233 (wallet hold first) → `escrowRecordStatements` :309 (one batch) / `releaseEscrowReservation` :354; `holdEscrow` :386; SettleInput :406 (orderStates fence + alsoWrite); **`releaseEscrow` :540 always sets `released_iqd = gross_iqd`** (:568) and credits `merchant_receivable_iqd` whole — no amount parameter; `partialRefundCommission` :643; **`refundEscrow` :678 takes optional `amountIqd`**: full → hold released; partial → hold committed, customer credited, state `partially_refunded`; `disputeEscrow` :853 (only admin settles a disputed escrow, `settleableFrom` :440). Callers: marketplace accept/confirm/dispute/cancel, communityRequests.ts:548 (auto-complete sweep release), adminCommunity.ts:1322/1329.
- **Eligibility** `worker/lib/eligibility.ts`: DIMENSIONS trade\|capability\|stock\|reach\|preference :73; REASONS :81-90 = 6+9+3+2+9 = **29 codes** (REQUEST_CLOSED, OWN_REQUEST, MERCHANT_INACTIVE, STORE_UNAVAILABLE, PLAN_LAPSED, NOT_TAKING_REQUESTS; NO_PRINTER, PROCESS, BUILD_VOLUME, MATERIAL, ENCLOSURE, HARDENED_NOZZLE, QUALITY, NOZZLE, MULTICOLOR; STOCK_MATERIAL/COLOR/GRAMS; REACH_DELIVERY/PICKUP; PREF_*); NotifyBlock :95 (NOTIFICATIONS_OFF\|PAUSED); EligibilityRequest :108 (process, material_id, color_hex, quality, colors_count, dims_mm, grams, governorate, delivery_pref, estimate_iqd, quantity); CapabilityPrinter :135 (max_colors, quality_max, availability…); MerchantPrefs :164; EligibilityCandidate :198 (printers, stock\|'untracked', reach\|'not_evaluated', prefs, plan_ok, accepts_custom_requests, request_opportunities); `fitsInBuild` :244 (6 orientations); `jobCapabilities` :259 (multicolor if colors>1; large_format if >250 mm; high_detail if fine/ultra/resin; flexible tpu; cf abrasive; functional needs_enclosure); `printerCannot` :276 (offline/inactive, process, build, material list, enclosure, hardened nozzle, quality rank, nozzle ≤0.4 for fine/ultra FDM, colors > max_colors); `evaluateEligibility` :416-508 → {eligible, reason, reasons, dims, printer_id, notify, notify_block}.
- **Ranking** `worker/lib/printMatchingScore.ts`: weights :31-53 capability_fit 25, location 18, availability 14, rating 12, completed_jobs 8, response_time 8, reliability 8, price_suitability 4, preference_match 3, pro_bonus 3, turnaround 6 (**sum 109**); RankSignals :56-67; `rankScore` :109-146 (availability × workload table light 1/normal .85/busy .5/full .15; turnaround horizon 31 d :72). `printMatchingStore.ts:374-376` hard-codes `response_minutes: null, trouble_rate: 0, pro: false`.
- **Matching store** `worker/lib/printMatchingStore.ts` (911): MATCH_ENGINE 2 :63; `loadRequestFacts` :104; `resolvePrinter` :183 (merges printer_models); `loadCandidates` :260; `verdictFor` :390; `matchRequest` :497 (notify limit setting :510); `matchMerchant` :560; `liveVerdict` :631 / `liveVerdictForUser` :649; `enqueueMatchStatement` :659; `drainMatchQueue` :713 (run by `runDurableJobs`, jobs.ts:193); `assertMayOffer` :758; `eligibleVerdictSql` :776; `workshopFactsFromPrinters` :799, `refreshWorkshopFacts` :835, `publicWorkshopFacts` :872 (in flight). Legacy engine-1 `printMatching.ts:294 matchMerchants` has no route callers (only tests/printMatching.test.ts:20-31).
- **Requests** `worker/lib/communityRequests.ts` (840): BOARD_STATES :37; CUSTOMER_CANCELLABLE_STATES :40; `isEngagedMerchant` :80; `mayQuoteOnBoard` :106; FileAccess owner\|admin\|engaged\|board\|direct :162, `requestFileAccess` :178; `completionStatements` :272; `staleOfferNotifications` :345; sweeps auto-complete :509, expiry :599, reconcile acceptances :709, `runCommunitySweeps` :827; STRANDED_AFTER_MINUTES 15 :479.
- **Revisions** `worker/lib/requestRevisions.ts` (444): DRAFT_TTL_DAYS 14 :31; SOURCE_TYPES model\|link\|images\|description :34; OFFER_DELIVERY_METHODS pickup\|merchant_delivery\|courier :38; OFFER_MAX_MATERIALS 5 :42; OFFER_VALIDITY_MAX_DAYS 60 :44; PricedFacts :60; `factsHash` :142; `composeSnapshot` :223; `recordRevisionStatement` :247 (callers printRequests.ts:1205, marketplace.ts:419, chatCommerce.ts:237); `reviseIfOfferedStatement` :295; `supersedeStatement` :313; `recordOfferRevisionStatement` :328 (callers marketplace 1261/1631/1830, chatCommerce 369/501); `contactSnapshot` :381.
- **File policy** `worker/lib/requestFilePolicy.ts`: FileReader owner\|admin\|engaged\|eligible :34; ReadKind :36; `mayReadBytes` :48; `previewGrantFor` :55; COARSE_PREVIEW_MAX_TRIANGLES 20 000 :115; `coarsePreviewMesh` :126.
- **Geometry** `worker/lib/modelGeometry.ts` (1065): FORMAT_CAPABILITIES :57-66 (stl/3mf/obj/amf previewable+measurable+sliceable; glb/gltf previewable+measurable, not sliceable; step/unknown reference-only); ModelWarning codes :135-153 (NOT_WATERTIGHT, ZERO_VOLUME, INVERTED_NORMALS, VERY_LARGE, VERY_SMALL, THIN_FEATURES <0.8 mm :399, HEAVY_OVERHANG, MANY_PARTS, TOPOLOGY_NOT_ANALYSED, HUGE_MESH, UNIT_ASSUMED, DEGENERATE_TRIANGLES) with severity info\|warning\|blocking; ModelAnalysis :155 (dimensions, bbox, triangle_count, shell_count, watertight, overhang_ratio, complexity, warnings, suggested_material/colors); TRIANGLE_HARD_CAP 5 000 000 :209; `analyseModel` :255; **`viewerMesh` LVM1, maxTriangles 250 000 :1009** (stride decimation :1029).
- **Engine A** `worker/lib/printPricing.ts` (698): PRINT_PRICING_VERSION 2 :44; PrintMaterial :51 (price_iqd_per_kg, waste/support factors, min_economic_iqd, difficulty, needs_enclosure, abrasive); DEFAULT_MATERIALS :102 (pla, petg, abs, asa, tpu, pa, pc, pla-cf + one resin); PrintPricingConfig :151; DEFAULT_PRICING :233 (labor 6 000/h, energy 120/kWh, machine_hour fdm 1 200 / resin 2 000, target margin 35 %, min 15 %, min_job 0, spread 12 %, qty discount 6 % cap 30 %, round 250); QuoteInput :270 (**accessories + accessory_catalogue**, machine_hour_iqd override); Quote :311 (cost_lines, floor_iqd, margin — private; accessory_lines; confidence high\|medium\|low); `quotePrint` :364; `priceForMargin` :671.
- **Accessories** `worker/lib/printAccessories.ts`: PrintAccessory :50 (id, names ar/en/ckb, unit piece\|pair\|set\|cm\|gram, cost_iqd, category magnet\|motion\|electronics\|fastener\|finishing, active) — **no product_id / variant link**; DEFAULT_ACCESSORIES :82-108 = 25 items (magnets 6/8/10/20×3, N20, SG90, 28BYJ-48, 608/MR105 bearings, spring, LED 5 mm, WS2812/cm, COB, switch, AA holder, USB-C, wire/cm, M3 screw/nut/insert, 3 mm rod, keyring, lanyard, felt, glue/g); MAX_ACCESSORY_QTY 500 :139; `priceAccessories` :156.
- **Estimate contract** `worker/lib/printEstimate/contract.ts`: factor keys :41-51 material\|machine\|labor\|support\|finishing\|failure_risk\|complexity\|**accessories**\|packaging; exclude keys delivery\|machine :64; weights most(≥40 %)\|some(≥15 %) :69-74; reason codes :82-100 (14); ESTIMATE_FORBIDDEN_FRAGMENTS cost_\|floor_\|margin_\|lines :113; `fromEngineA` index.ts:52, `fromEngineB` :99; client mirror `src/lib/printEstimate.ts`.
- **Engine B** `worker/lib/printQuote/*`: model.ts PRICING_ENGINE_VERSION 1 :19, Provenance :31, CostComponent :174-192 (17: MODEL_MATERIAL … LABOR, POST_PROCESSING, PACKAGING, OVERHEAD, PLATFORM_FEES, **HARDWARE**, FAILURE_RESERVE), PrintAnalysis :121; cost.ts PricingInputs :225 (printer, materialPrices, electricity, labor, overrides, laborTasks, packaging, overhead, platformFee, risk, hardware, targetMargin, minimumJob, rushMultiplier, factors, quantity), `priceJob` :282, DEFAULT_FAILURE_FRACTION 0.45 :221; printers.ts `machineIqdPerHour` :197, `printerEligibility` :279, MULTI_MATERIAL_DEFAULTS :71; repository.ts `loadMerchantPrinters` :168, `loadMaterialPrices` :276 (merchant_spools → print_materials → products), `loadCalibration` :490, `analysisStatements` :564, `quoteStatements` :723.
- **Uploads/files** `worker/lib/uploadEntity.ts`: UPLOAD_PURPOSES :31-36 (receipt, avatar, chat, product, community, support, complaint, post, request, product_file, order_update, offer); SESSION_PURPOSES :44-48; MAX_FILES_PER_REQUEST 6 :87; `assertUploadEntity` :97 (request :173, order_update :193 merchant-of-order, offer :215 author or draft); `placementFor` :311. `fileOwnership.ts`: `ownedFileObject` :97, PRODUCT_FILE_ROLES :37, grants :186-277. `viewerGrants.ts`: source product\|post :37, TTL 60 min :40, `mintViewerGrant` :91, `resolveViewerGrant` :157, `deriveModelPreview` :315.
- **Notifications** `worker/lib/notifications.ts` kinds (:38-165): portfolio_consent, print_request_match (link `/requests?request=` :173), offer_received, offer_accepted, offer_stale, order_update, offer_rejected, dispute_opened, dispute_resolved, new_order, order_needs_action, matching_request, new_message, files_added, request_files, request_comment, request_question, request_answer, new_review, low_stock, payout_*, stock_back, trade_in, post_liked, post_commented, comment_replied, new_follower, store_status_changed, coupon_ending, review_reward_pending.
- **Edge cache** `worker/lib/edgePolicy.ts` `anonymousCached` :182 (ANONYMOUS_LIFETIME 60/120/600 :88) — used only by /catalog, /print-quote/printers, /accessories, /materials.

### 4. Client surfaces
- `src/pages/Requests.tsx` (1441): views board\|mine\|orders\|new :92; deep link `?request=<id>` :162-187; `?view=new` :112-124; publish/cancel :727-758; `RunningCommunityOrders` :1385; **no `?project=` reader** (grep empty). Route `/requests` App.tsx:944 — **no `/requests/:id`**; the planned `src/pages/community/Request.tsx` (COMMUNITY_ECOSYSTEM.md:760) is not present.
- `src/components/community/requests/RequestWizard.tsx` (1060): 4 steps (:4, Step :61); MODEL_ACCEPT `.stl,.3mf,.obj,.amf,.glb,.gltf,.step,.stp` :64; FILE_STEP trilingual :69-74; WizardState :141 (title, description, customer_notes, source_type model\|link\|images\|description, source_url, process\|'unsure', material_id\|'unsure', quality, quantity, color_hex/name, dims, governorate, delivery_pref, deadline, budget_iqd); step 2 :773-903 (process, material, quality, quantity, colour, dims, notes); step 3 :903 (governorate, delivery\|pickup, deadline, budget); step 4 review :948; `requestsApi` api.ts:164.
- `src/components/community/requests/api.ts` (in flight): DraftShape :57, Quote :96, WizardPayload :134, discussionApi :282, OrderTimeline :247, OfferV2 :345 (price, delivery_fee, total, quantity, color, terms, files, history, revised, stale, quote_id, merchant{rating, completed_orders,…}), OfferInputV2 :401, AcceptOfferBody :428 (expected_total_iqd, offer_revision, address_id), RequestPrefsV2 :435, WorkshopFactsV2 :467, BoardForMeRow :479, offersV2Api :513; `requestStates.ts` tones for 12 states.
- Offers: `src/components/community/offers/` OfferCompare 409 (price, completion_days, delivery_method, materials, material_ids, included, warranty_terms, revision), OfferComposer 213, MerchantOfferPanel 251, MyOffersList 137, OrderContactCard 96.
- Chat hosts: `src/components/chat/commerce/PrintRequestSheet.tsx` 234, `QuoteSheet.tsx` 257.
- 3D: `src/pages/ModelViewer.tsx` (959) imports Camera, Geometry, Mesh, Orbit, Program, Renderer, Transform from `ogl` (:27); route `/model-viewer/:token` App.tsx:819; package.json:42 `"ogl": "^1.0.11"` is the only 3D dep; tests farmClient.test.ts:114 / farmAdminPanel.test.ts:419 forbid `three`/`ogl`/`@react-three` in the farm chunks.
- Tools: `src/pages/Tools.tsx` (1293) via `src/lib/printQuote.ts` (→ /api/print-quote/uploads, analyses, materials, printers), GramsQuotePanel, linkQuoteApi; route `/tools` App.tsx:995.
- Merchant: `src/components/merchant/workshop/` RequestBoard 290, CostingSheet 281, MaterialStockSection, PrinterModelPicker, RequestsToCost, WorkshopRequestCard, api.ts 179 (/api/merchant/workshop/board, /requests/:id/…, /material-stock), reasons.ts (Arabic+English only, Sorani owed); `dashboard/PrintersTab.tsx` (economics fields purchase_iqd, useful_print_hours, labor/electricity/maintenance, machine_hour_iqd, model_id, quality_max, availability, colors, materials), `dashboard/CostingTab.tsx`; `shell/sections/RequestsSection.tsx`; shell sections today: Analytics, CommandCenter, Customers, Notifications, Orders, Requests, Reviews.
- Community "projects" = `community_posts.kind='project'`: routes `/community/projects[/new|/:id|/:id/edit]` App.tsx:921-924, pages `src/pages/community/{Projects,Project,ProjectComposer,Creator,Saved}.tsx`; Project.tsx:297 links `/requests?view=new&project=<postId>` («اطلب طباعة مثلها»).

### 5. Tests that pin behaviour (node:test, 620 files)
printRequestsV2 18, offersV2 11, orderTimeline 11, requestDiscussion 8, eligibility 15 (holds REASON_CODES equal to client), eligibilityRoutes 18, printMatching 24, escrow 21 (partial refund :216, :434), communityEscrowDecisions 13, communityRequestLifecycle 16, communityStates 12, communityAcceptIntegrity 13, printQuoteEngine 18, printPricing 26, printEstimateContract 6, printAccessories 19, requestViewerTokens 9, requestFiles 18, printRequestConfidentialityReview 6, bundleBudget 12 (CSS_BUDGET 60 KB :75, ENTRY 72 :52, INITIAL 200 :73, STOREFRONT 47 :381, SHELL 25/32 :442-443, ORDER_SCREEN 12 :508). Playwright: e2e-print-request.mjs (566, API-level), e2e-print-request-ui.mjs (468; 390/1280, `ar` only), e2e-workshop.mjs (98; 360/1280, ar/en), e2e-tools.mjs (297; 390), e2e-projects.mjs (200; 360/1280, ar/en/ckb, reducedMotion) — **only e2e-projects meets the 360/1280 × ar/en/ckb × reduced-motion bar**.

REUSE:
[
 {
  "ask": "Levo Project — the core container (Part 4 #1) and Project Room (#2)",
  "existing": "`community_requests.id` already is the hub: community_print_requests (PK request_id), community_request_files, community_request_revisions, community_offers(+files, drafts, revisions), community_request_matches, community_request_comments, accepted_offer_id/community_order_id → community_orders(request_id, offer_id, chat_id, offer/request/contact snapshots) → community_escrows(+events), community_order_updates, community_complaints(community_order_id, offer_id), merchant_reviews(community_order_id), print_quotes(request_id), model_view_tokens(request_id), request_file_reads, user_notifications(entity_type request|offer|order), community_posts(request_id, community_order_id), chats(context_type 'request', community_order_id). The lifecycle Idea→…→Delivery is REQUEST_STATES + COMMUNITY_ORDER_STATES (communityStates.ts:18, :107).",
  "how": "Project id = request id. No new container table. Add one additive side table keyed by request_id (pattern of community_print_requests, 0045:146-153) for project-only facts (origin kind idea|file|design|product|remix, approved_revision, stage label), and build the Project Room as the Phase-5-planned `src/pages/community/Request.tsx` at `/requests/:id` (COMMUNITY_ECOSYSTEM.md:760) as a lazy chunk — never a new route family named «project» (collides with /community/projects = community_posts.kind 'project', App.tsx:921-924, 0153:51)."
 },
 {
  "ask": "Versions + approvals (Part 4 #4), Approval lock (Part 5 #7), Change Orders (#8), Revision budget (#15)",
  "existing": "community_request_revisions (spec/files/estimate/hash, UNIQUE request+revision, 0130:74) written by recordRevisionStatement (requestRevisions.ts:247) on publish/edit/files; community_offer_revisions (0130:89) on create/edit/reconfirm; GET /print/requests/:id/revisions diffs 19 REVISION_FIELDS (printRequests.ts:1462-1474); the accept batch freezes request_revision + request_snapshot + offer_snapshot on the order (marketplace.ts:2097, 0130:112) — today's de-facto approval lock; offer_stale / reconfirm flow (communityRequests.ts:345, marketplace.ts:1806) is the existing «spec changed, re-price» loop; community_offer_files kind 'model' (0159:46) can carry a designer's V1/V2 file; community_order_updates kinds are CHECK-frozen (0160:58) so a 'version' update cannot be added there.",
  "how": "Additive table for design versions on a project (request_id, version_no, author role merchant|customer, file keys via a new TS upload purpose — UPLOAD_PURPOSES is code, uploadEntity.ts:31 — analysis, preview_key, note) plus an additive approvals table (request_id, target 'request_revision'|'design_version', target_no, approved_by, kind design|production, created_at). Approval lock = `community_orders` gains nullable `approved_version_id`; production endpoints (start/updates) read it. A Change Order = an additive row (community_order_id, from/to version or revision, price_delta_iqd, days_delta, needs_approval) whose acceptance writes a new community_offer_revision with reason 'edit' (CHECK forbids new reason words, 0130:97) and re-prices via the existing accept/reconfirm arithmetic. Revision budget = two integer columns on the offer terms JSON (`included_revisions`) + a count over the versions table; clarifications stay comments."
 },
 {
  "ask": "Merchant services (#8), Service packages (#9), Capability passport (Part 5 #5)",
  "existing": "merchant_request_prefs (0045:122; 0159:79: capabilities[], processes, materials, colors, governorates, delivery, min/max job & size, workload, paused, turnaround_days, technologies & max_build_mm derived, workshop_intro), merchant_printers (+printer_models multi_material/max_simultaneous_materials/enclosed/hardened), merchant_material_stock, merchant_spools, merchant_stores.accepts_custom_requests/service_areas/delivery_settings, merchant delivery profile+rules (ReachConfig eligibility.ts:193), and the in-flight `publicWorkshopFacts` (printMatchingStore.ts:872) served on GET /api/community/store/:id (community.ts:531/566) — already a customer-safe passport shape (technologies, materials, max_build_mm, turnaround, governorates, delivery, custom_enabled, intro).",
  "how": "Passport = extend `publicWorkshopFacts`/`workshopFactsFromPrinters` (in flight — schedule after Phase 5 merges) with max_colors (from printer_models.max_simultaneous_materials via resolvePrinter), nozzle sizes, enclosed/hardened flags and a new `services` list. Services and packages: additive columns `merchant_request_prefs.services TEXT '[]'` (declared services from a TS vocabulary like CAPABILITIES eligibility.ts:70; note prefs.capabilities means «jobs I want», not «what I offer» — keep separate) and an additive `merchant_service_packages` table (merchant_id, key print_only|print_assembly|premium_finish|prototype|full_build, services JSON, pricing rule JSON, days). Matching reads services as a new `capability`-dimension reason (add to REASONS + client reasons.ts, pinned by tests/eligibility.test.ts)."
 },
 {
  "ask": "Production slots / real availability (#7), Machine assignment (#33), Production board (#32)",
  "existing": "merchant_printers.availability available|busy|offline (0045:106) and prefs.workload (self-declared, rank-only, printMatchingScore.ts:127-130); turnaround_days (0159:79) feeds the turnaround weight; community_request_matches.printer_id (0132:162) is the best-fit printer per request; print_quotes.merchant_printer_id (0078:302) records which printer a merchant costed on; community_orders has started_at/ready_at/delivered_at (0160:67, 0031) and states in_progress→merchant_marked_delivered; community_order_updates kinds started|progress|photo|ready.",
  "how": "Earliest-slot = derived server-side from (open community_orders per merchant in in_progress, their completion_days/started_at, turnaround_days, printer availability) — no slots table for v1; expose as one `capacity` field in workshop facts and as a rank signal replacing the hard-coded placeholders (printMatchingStore.ts:374-376, coordinated with Phase 6's merchant_metrics_daily). Machine assignment = additive nullable `community_orders.assigned_printer_id → merchant_printers` (default = matches.printer_id, override always). Production board = a merchant view over community_orders state × ready_at/started_at plus an additive `production_stage` text column (queue|printing|assembly|finishing|qc) that never replaces the CHECK-frozen order state."
 },
 {
  "ask": "Smart merchant matching (#6), Instant feasibility (#5), Smart constraints (Part 5 #10), Low-stock impact (#35)",
  "existing": "evaluateEligibility over 5 dimensions/29 codes (eligibility.ts:81, :416) incl. stock dimension from merchant_material_stock (STOCK_MATERIAL/COLOR/GRAMS) and reach from delivery rules; rankScore 11 weights (printMatchingScore.ts:31); liveVerdict/assertMayOffer fences offers (printMatchingStore.ts:631, :758, marketplace.ts:1236-1242); ModelWarning 12 codes with severity (modelGeometry.ts:135) + FORMAT_CAPABILITIES (:57) + estimate reason codes (contract.ts:82); printerCannot already encodes build/material/enclosure/nozzle/colour constraints (eligibility.ts:276).",
  "how": "Feasibility card = pure mapping: blocking → «Needs adjustment», warning/unknown dims → «Needs review», none → «Ready to print», sourced from ModelAnalysis.warnings + the request's capability dimension over ALL candidates (count of eligible merchants from community_request_matches). Smart constraints for configured products reuse jobCapabilities/printerCannot as the server validator on the configuration (dims from the configured template, colors_count from chosen colours, material from finish). Low-stock = the existing STOCK_* reasons; suggest alternatives by re-running evaluateEligibility with the other in-stock colour lines of the chosen merchant."
 },
 {
  "ask": "Milestone payments (#22) — Deposit / Design approved / Production started / Delivery",
  "existing": "One escrow per order (UNIQUE community_order_id 0031:146) with released_iqd/refunded_iqd and CHECK released+refunded ≤ gross (0031:163); holdEscrow/reserveEscrowFunds + escrowRecordStatements (escrowOps.ts:233-354); releaseEscrow releases the whole gross (escrowOps.ts:540, :568); refundEscrow supports partial amounts (:678); partialRefundCommission (:643); escrow events kinds release|refund (0031:174) already carry amount_iqd; wallet holds can be several per ref (0015:98); merchant ledger credit in releaseEscrow via merchantLedger.",
  "how": "Keep one escrow row per order. Add additive `community_escrow_milestones` (escrow_id, key deposit|design_approved|production_started|delivered, amount_iqd, due_state, released_at, event_id) and a new `releaseEscrowPartial(db, {escrowId, amountIqd, milestoneKey, …SettleInput})` in escrowOps that mirrors refundEscrow's partial branch (commit the hold once on the first partial, credit the merchant `amount − partialRefundCommission(amount)` through the merchant ledger, bump released_iqd, keep state 'held' until released_iqd + refunded_iqd = gross). Existing tests (escrow.test.ts) must keep passing; the full-release path stays for non-milestone orders. Milestone triggers are the existing server events: accept (deposit), approval row (design approved), POST /orders/:id/start (production), confirm/auto-complete (delivery)."
 },
 {
  "ask": "Materials & Components (Part 3), Component kits (#28), Component compatibility (#27), BOM/Build Recipe (#16-17), Cost & profit (#18, Part 5 #20)",
  "existing": "Accessory catalogue PrintAccessory (printAccessories.ts:50, 25 defaults, categories magnet|motion|electronics|fastener|finishing, settings-stored, no product link); engine A prices accessories (printPricing.ts:270) and the estimate contract has an 'accessories' factor (contract.ts:41); the wizard body accepts ≤20 accessory lines (printRequests.ts:367) persisted only in estimate JSON (:2127); engine B has HARDWARE/PACKAGING/OVERHEAD/PLATFORM_FEES components and true_cost/profit/margin per print_quotes row (0078:296); print_materials.product_id → products (0078:166); merchant_spools/merchant_material_stock for filament; store products have options/variants (0126) and order_items already carry bundle_component_id / component_value_iqd / component_alloc_iqd; community_order_items is an unread table.",
  "how": "Give PrintAccessory an optional `product_id`/`variant_id` (settings shape, no migration) so the store catalogue prices it, and add the store-side eligibility flag as a product spec (`spec_fields.usable_in_prints`, products.spec_fields exists) or an additive `product_print_component` table (product_id, variant_id, category, dims JSON, voltage…). Component slots/compatibility live on the template (see Part 2) as JSON validated server-side. Persist chosen components as an additive `community_request_components` table (request_id, revision, product_id, variant_id, qty, required, price_iqd snapshot) instead of the estimate JSON, and mirror them into offers via an additive `community_offer_components` (merchant substitutions with price delta). BOM/recipe = the print_quotes cost components + components rows + filament grams from print_analysis_materials; profit simulator = engine B priceJob (cost.ts:282) over PricingInputs with hardware — never shipped to customers (contract's forbidden fragments)."
 },
 {
  "ask": "Proof of production (#23), Quality checklist (#24), Dispute evidence package (Part 5 #6)",
  "existing": "community_order_updates kind photo (private image under community-orders/<id>/updates/, purpose order_update, uploadEntity.ts:193) and GET /orders/:id/timeline merging escrow events + updates (communityOrderTimeline.ts:435); community_complaints + messages with internal notes; order snapshots (offer/request/contact), revisions, comments, matches, request_file_reads and audit() rows; Phase 6 §9.6 plans staff read of the disputed order's chat.",
  "how": "Proof = existing photo updates (add optional `stage` in body JSON, no schema). QC checklist = additive `merchant_qc_templates` + `community_order_qc` (order_id, template snapshot JSON, checked_by, created_at) surfaced as one «✓ Quality checked» update. Evidence package = a read-only composed endpoint over existing rows (request revisions, accepted offer revision, approvals, change orders, updates, escrow events, complaint thread) with immutable ids — no new table; frozen manifest optional (JSON column on community_complaints is not needed; the ids are stable)."
 },
 {
  "ask": "Request again (#37), Duplicate recipe (#17), Upgrade my product (#12), Digital Twin (Part 1)",
  "existing": "POST /print/requests/:id/repeat clones a request with files/preview/analysis into a new draft (printRequests.ts:1996); Project.tsx:297 «اطلب طباعة مثلها» → /requests?view=new&project=; completed community_orders keep request_snapshot + offer_snapshot; community_posts can reference request_id/community_order_id with consent_status.",
  "how": "Digital Twin = the completed community_order + its approved version + files, exposed at the Project Room; «Reorder» = repeat; «Upgrade» = repeat with a `parent_order_id` on the new project side table so the tree is queryable. The `?project=` receiver is P9's (MERCHANT_PLATFORM_V2 P9) — reuse it, do not write a second one."
 },
 {
  "ask": "Design requests (#10), Designer + printer collaboration (#11), Design handoff (Part 5 #16)",
  "existing": "SOURCE_TYPES images|description already allow file-less requests (requestRevisions.ts:34); offers carry model files (community_offer_files kind model 0159:50) and quote_id; direct requests + chat commerce bind one store; only one live accepted offer per request (accepted_offer_id).",
  "how": "A design request = source_type description|images with a `service` = design (new prefs.services vocabulary) so eligibility picks designers; the designer's output = a design version row (see versions) attached to the same request; the printing stage = a second offer round on the same request after approval — requires allowing a new offer round after in_progress, which today's REQUEST_TRANSITIONS forbid (communityStates.ts:36) → model it as a child project (new request row with `parent_request_id` on the side table) so state machines stay intact and each stage keeps its own escrow."
 },
 {
  "ask": "Serial numbers / batches (Part 5 #18)",
  "existing": "serial_inventory (0139:28) and device_serials (0003) for store products; community_orders.id, request revision, printer_id.",
  "how": "Additive `community_order_serials` (serial, community_order_id, unit_no, version_id, printer_id, merchant_id) following serial_inventory's serial_norm/serial_raw pattern; QR/NFC payload = the serial, resolved by a public read-only door that reveals no private data (0157's viewer_grants preview pattern)."
 },
 {
  "ask": "Merchant teams & permissions (#31), Private project invite (#19), Follow (#36)",
  "existing": "P10 `merchant_store_members` + `requireStoreAccess` is planned in the merchant programme (MERCHANT_PLATFORM_V2.md:150); request visibility is public|direct only (marketplace.ts, 0151); viewer tokens/grants exist for files; follows table (0001:283) and new_follower notification kind exist.",
  "how": "Do not build teams in Programme C — consume P10's members/capabilities. Invites = additive `community_request_members` (request_id, user_id or invite token hash, role viewer|commenter|approver, expires_at) consulted by requestFileAccess/isEngagedMerchant-style predicates; visibility stays public|direct (trigger-locked). Follow = existing follows + opt-in kinds on merchant_notification_preferences."
 },
 {
  "ask": "Merchant customizable products / templates (Part 2), Merchant-created customizable templates (Part 1)",
  "existing": "community_products with print facts (material, print_technology, color, finish, dims, weight_g — 0126), options/option_values/variants (0126:87-178), product_files role source_model with analysis/preview_key (0157:25), viewer_grants for product 3D preview (0157:83), product-file grants by community_order_id, cart_items.option_value_ids/variant_id and order_items.option_snapshot; private products minted from a quote (0152) already bridge a chat offer to store checkout.",
  "how": "A template = a community_product + one product_files source_model + an additive `community_product_templates` row (product_id, regions JSON: key body|base|name|text|logo|…, kind color|text|logo|photo|qr|nfc|accessory, allowed values/colours, limits, pricing modifiers, component slots) validated on the server; a configured purchase = additive `cart_items.personalization TEXT` and `order_items.personalization_snapshot TEXT` (server re-prices from the template, client sends ids/text only); the same JSON attaches to a Levo Project via the request side table when the customer chooses «request printing» instead of cart. The 3D preview must be an LVM1 mesh built by the Worker (modelGeometry.viewerMesh :1009) and rendered by ModelViewer's ogl code path; text/logo regions are colour/decal overlays on named sub-meshes, not client-side CSG."
 },
 {
  "ask": "Smart Quote Assistant (#19), Offer variants (#20), Visual offer comparison (#21)",
  "existing": "POST /api/merchant/workshop/requests/:id/cost → print_quotes draft with true_cost/price/margin (merchantWorkshop.ts:233; 0078:296); OfferV2.quote_id links an offer to that quote (api.ts:345, marketplace.ts:1399); OfferCompare.tsx already compares price/days/delivery/materials/warranty/revision; community_offer_drafts hold a merchant's saved draft.",
  "how": "Quote assistant = the existing cost route pre-filling an offer draft (community_offer_drafts.payload_json) — never auto-send (draft → send is the existing POST /offers/:id/send). Variants = additive `community_offer_variants` (offer_id, key economy|recommended|premium, price_iqd, delivery_fee_iqd, days, material_ids, terms) with the accept body naming `variant_id`; the chosen variant is copied into offer_snapshot so the order stays self-describing. Comparison = extend OfferCompare with total_iqd, valid_until, files, services — no «best» flag."
 }
]

GAPS:
["No request detail page: `/requests/:id` and `src/pages/community/Request.tsx` (Phase 5 plan, COMMUNITY_ECOSYSTEM.md:760) do not exist; the detail lives inside Requests.tsx (`?request=`), so the Project Room has no host yet.","No template/customisation/personalisation schema of any kind (grep over migrations for template|customiz|personaliz finds only unrelated tables); no regions, text/logo/photo/QR/NFC fields, themes, finishes vocabulary, or size tiers.","No component slots, compatibility rules, kits, BOM or recipe tables; accessories are a settings-stored catalogue with no product/variant link and no stock; chosen accessories persist only inside `community_print_requests.estimate` JSON and are stripped from `/quote` answers.","No partial/milestone escrow release: `releaseEscrow` always releases the full gross (escrowOps.ts:568); no milestone table; one escrow per order (UNIQUE).","No approvals, approval lock, change orders or revision budget: revisions exist (request/offer) but nothing records «approved by X at revision N»; `community_orders` has no approved-revision column; `community_offer_revisions.reason` and `community_order_updates.kind` CHECKs cannot take new words.","No services or service-package model: `merchant_request_prefs.capabilities` is a job filter (what I want), not an offering; no assembly/painting/design/repair vocabulary; `merchant_printers.technology` CHECK is fdm|resin only (no SLS, laser, CNC).","No real capacity/slots/queue: availability is a per-printer enum and workload a self-declared enum; three rank signals are hard-coded placeholders (printMatchingStore.ts:374-376).","No production board, machine assignment, batch optimiser, split/subcontract/overflow, automation rules, or serials for community orders (serial tables exist only for store products).","No QC checklists; proof of production is limited to `photo` updates.","No project roles/invites: visibility is public|direct only; no viewer|commenter|approver concept; teams/permissions are owned by merchant P10 and not landed.","No design licensing, royalties, remix tree, design vault, «My Designs», brand kit, private company catalogs, or merchant asset library beyond product_files/post_files/file_objects.","No QR/NFC/AR/gift-mode substrate anywhere.","No colour calibration or filament photo tables: colours are bare hex on printers/stock/requests; `printer colours` are free hex arrays.","No feasibility summary for customers: ModelWarning codes exist but customer wording maps only through the merchant reasons file (Arabic/English only; Sorani owed per its header) and the wizard.","The wizard collects no accessories although the server accepts ≤20 lines; no UI for components.","Offers have no variants, no components/substitutions, no services; `OfferCompare` lacks total/valid_until/files.","Engine A (printPricing, materials pla/petg/abs/asa/tpu/pa/pc/pla-cf) and engine B (print_materials pla/pla-cf/petg/tpu/abs/asa/pc/pa-cf/pva) disagree on material ids; convergence is deferred to merchant P11.","`community_merchants.badges_json` is referenced by docs but absent from every migration.","No Playwright suite for the print surfaces meets the bar (360/1280 × ar/en/ckb × reduced motion on/off); only e2e-projects.mjs does.","`user_notifications` has title/body columns for ar and en only (0045:43-46); ckb notification copy is a P11 item.","`?project=` prefill: sender exists (Project.tsx:297), receiver missing (P9 owns it)."]

RISKS:
["Naming collision: «Project» already means `community_posts.kind='project'` with routes /community/projects/* and pages Projects/Project/ProjectComposer (App.tsx:921-924, 0153:51). A «Levo Project» must not reuse that slug, table, or component names; the request id is the project id and /requests/:id its room.","CSS headroom is 564 bytes: all stylesheets gzip -9 = 60,876 B against CSS_BUDGET 61,440 B (tests/bundleBudget.test.ts:75), and the rule is «never larger than the previous phase». Every Programme C surface must reuse existing utility classes; a 3D personaliser with new controls will fail the build unless CSS is paid back first.","The tree is mid-edit: marketplace.ts (+819), printMatchingStore.ts (+134), merchantPrinters.ts (+101), uploadEntity.ts (+122), notifications.ts, eligibility.ts, printMatchingScore.ts, requests/api.ts (+362) and migrations 0159-0161 are uncommitted. Any Programme C phase touching offers, prefs, workshop facts, upload purposes or the wizard must be sequenced after Phase 5 merges; «next free» migration is 0162 today but may move.","SQLite CHECK enumerations are frozen and rebuilds are forbidden: order state, offer state, revision reasons, update kinds, comment kinds, escrow states/events, printer technology, print process/quality. New lifecycle words need side tables or nullable columns, never widened CHECKs.","One escrow per order + full-only release: milestone payments require new code in escrowOps that keeps escrow.test.ts (21) and communityEscrowDecisions (13) green and preserves the fee identity (`partialRefundCommission` arithmetic) and the merchant-ledger credit; getting this wrong moves real dinars.","Privacy whitelist drift: `publicRequest()` (marketplace.ts:143) and the `/quote` stripping (printRequests.ts:543) are the only things keeping customer data and cost lines away from merchants/customers; every new request/offer/order field must be added deliberately on the right side. `ESTIMATE_FORBIDDEN_FRAGMENTS` forbids cost_/floor_/margin_/lines in public shapes.","Two viewer-token systems (model_view_tokens for request files vs viewer_grants for product/post files); a Project Room preview must choose one path; 0157 generalised model_view_tokens.source_type to request|product|post while viewer_grants.source_type is product|post only.","The Requests chunk is already 39.5 KB gzip and contains RequestWizard; adding the visual creation path inside it will inflate first paint of /requests — the creator must be its own lazy route/chunk, and ogl (vendor-webgl 15.3 KB) must stay lazy.","Match/rank signals response_minutes/trouble_rate/pro are placeholders owned by Phase 6 (merchant_metrics_daily); Programme C's «smart matching» must add signals through printMatchingScore weights (setting `printMatchWeights`) and not fork a second matcher. Engine-1 `printMatching.ts` is legacy with tests only.","`community_order_items` is dead (no reader/writer): tempting for BOM lines, but its shape (title/qty/price) has no product or variant link; prefer a new additive components table over resurrecting it silently.","Timers: request expiry 30 days (`communityRequestExpiryDays`), drafts 14 days (DRAFT_TTL_DAYS), auto-complete 7 days, viewer tokens 60 min. A multi-week design→print project will hit sweepCommunityExpiry/draft expiry unless the project side table opts long-running requests out.","Merchant P6/P9/P10/P11 overlap directly: RequestComposer wrapping RequestWizard and the live estimate from step 2 (P6), indicative workshop quotes + `?project=` reader + calculator→request (P9), staff/members (P10), engine A/B convergence (P11). Programme C phases must be scheduled after or alongside these, reusing their contracts (Estimate contract row 174) rather than adding a third pricing path.","Sorani debt: `src/components/merchant/workshop/reasons.ts` is Arabic/English only by its own header; `user_notifications` stores ar/en only. New reason codes and notification kinds for Programme C need real ckb per D6 and the pinned equality test (tests/eligibility.test.ts).","Direct-request triggers (0151:47-79) lock visibility/target; a project born in a chat inherits `direct` and cannot later go to the board — design «make it public» as a child request, not a flip.","Acceptance jumps to in_progress and funds immediately (communityStates.ts:36-60): a design-then-print project cannot reopen offers on the same request; two-stage work must be two linked requests/orders (each with its own escrow), or the request state machine — pinned by communityStates.test (12) and communityRequestLifecycle (16) — would have to change."]

NUMBERS:
Bundle (dist built 2026-09-30 01:46, gzip level 9 as tests/bundleBudget.test.ts:77): all CSS 60,876 B = 59.44 KB over 8 files (budget 61,440 B → 564 B headroom); largest stylesheet index-B6C-KbqL.css 48,067 B; entry index-CzUpUV6H.js 67,741 B = 66.15 KB (budget 73,728 B); Requests chunk (contains RequestWizard) 40,453 B = 39.50 KB; ModelViewer 7,429 B; vendor-webgl (ogl) 15,629 B; Tools 18,337 B; PrintersTab 16,858 B; PrinterFinder 11,998 B; PrintRequestSheet 3,551 B; QuoteSheet 3,483 B; RequestsSection 2,541 B; theme css 1,516 + 1,243 B. Budgets pinned: entry 72 KB, any chunk 250 KB, initial payload 200 KB, CSS 60 KB, document 4 KB, storefront pages +47 KB, workspace shell 25 KB / closure 32 KB, order screen 12 KB, analytics 16 KB, today 18 KB.
Code size: marketplace.ts 3,108 lines; printRequests.ts 2,246; printQuote.ts 1,993; chatCommerce.ts 771; communityOrderTimeline.ts 553; requestDiscussion.ts 572; merchantPrinters.ts 668; merchantWorkshop.ts 463; libs: communityRequests 840, eligibility 526, printMatching 308, printMatchingScore 146, printMatchingStore 911, printPricing 698, requestFilePolicy 151, requestRevisions 444, escrowOps 889, walletOps 2,546, merchantLedger 1,228, modelGeometry 1,065, uploadEntity 452, fileOwnership 327, notifications 462, printQuote/* 2,650, printEstimate/* 521, printAccessories (25 default items). Client: RequestWizard 1,060; Requests.tsx 1,441; Tools.tsx 1,293; ModelViewer 959; offers components 1,106 total; workshop client 1,444 total; PrintPricingAdmin 1,707.
Schema: 154 migration files (0001–0161 with gaps; next free 0162); community_requests 6 base + 16 (0031) + 1 (0116) + 2 (0130) + 3 (0151) = 28 columns; publicRequest whitelist 19 fields; REVISION_FIELDS 19; eligibility 29 reason codes over 5 dimensions; rank weights sum 109; 27 seeded printer_models (14 Bambu + 13 others, 6 resin); 9 print_materials (engine B) vs 8 FDM + resin defaults (engine A); ModelWarning 12 codes; estimate factors 9, reason codes 14; engine B cost components 17; notification kinds ≈ 35; upload purposes 12; MAX_FILES_PER_REQUEST 6; accessories ≤ 20 lines × qty ≤ 500; OFFER_MAX_MATERIALS 5; offer validity ≤ 60 days; turnaround 1–60 days; workshop_intro ≤ 300 chars; COMMENT_MAX 1,000; viewer token TTL 60 min; coarse preview 20,000 triangles; LVM1 viewer mesh ≤ 250,000 triangles; analysis hard cap 5,000,000 triangles; THIN_FEATURES < 0.8 mm; large_format > 250 mm; fine/ultra FDM nozzle ≤ 0.4 mm; defaults: communityRequestExpiryDays 30, DRAFT_TTL_DAYS 14, communityAutoCompleteDays 7, printMatchNotifyLimit 25, STRANDED_AFTER_MINUTES 15; DEFAULT_PRICING labor 6,000 IQD/h, energy 120/kWh, machine hour fdm 1,200 / resin 2,000, target margin 35 %, min 15 %, round 250.
Tests: 620 test files; print/escrow/community pins counted: printRequestsV2 18, offersV2 11, orderTimeline 11, requestDiscussion 8, eligibility 15, eligibilityRoutes 18, printMatching 24, escrow 21, communityEscrowDecisions 13, communityRequestLifecycle 16, communityStates 12, communityAcceptIntegrity 13, printQuoteEngine 18, printPricing 26, printEstimateContract 6, printAccessories 19, requestViewerTokens 9, requestFiles 18, printRequestConfidentialityReview 6, bundleBudget 12. Playwright: e2e-print-request.mjs 566 lines (API), e2e-print-request-ui.mjs 468 (390/1280, ar), e2e-workshop.mjs 98 (360/1280, ar/en), e2e-tools.mjs 297 (390), e2e-projects.mjs 200 (360/1280, ar/en/ckb, reducedMotion).
In-flight diff: 10 files, +1,496/−128 lines (marketplace.ts +819 alone).

---

## Survey — media3d

# MEDIA3D survey — the 3D and media substrate as it IS (read-only, 2026-09-30)

Working tree: 52 paths modified/untracked by the other workflow (`git status --short | wc -l`); `dist/` was built 01:46 UTC, 9 files under `src/` are newer, so dist numbers can lag the tree by a few hundred bytes. Every number below says whether it was measured (this sandbox, Node 22) or estimated.

## 1. The client 3D surface — `src/pages/ModelViewer.tsx` (959 lines)

| What | Where | As it is |
|---|---|---|
| Route | `src/App.tsx:54` (`React.lazy`), `:819-830` (`<Route path="/model-viewer/:token">` in its own `Suspense`), `:694` (full-screen route list) | A standalone page, `fixed inset-0 z-50` (`ModelViewer.tsx:785`), no site chrome. **Never embedded inline**: product files, post files and the request summary open it with `window.open(viewerPage(token), '_blank')` (`src/components/community/projects/FileRows.tsx:107`, `src/components/storefront/ProductFiles.tsx:94`, `src/components/print/PrintSummary.tsx:117`). |
| Library | `ModelViewer.tsx:27` imports `Camera, Geometry, Mesh, Orbit, Program, Renderer, Transform` from `ogl` | Only ogl (`package.json` deps: `ogl ^1.0.11`, `fflate ^0.8.3`; no three.js — banned by `tests/store-isolation.test.ts:35`). |
| Scene | `mountViewer` `:356-643` | **One `Mesh`** (`:406`) over one `Geometry` with three attributes: `position` (Float32 view over the response buffer), `normal` (flat, computed client-side per triangle `:234-252`), `corner` (Uint8 0/1/2 for the barycentric wireframe `:66,271`). Plus one `LINES` grid mesh (`:423-439`). No indices, no UVs, no textures, no groups, no per-region anything. |
| Shading | `MODEL_FRAG` `:276-306` | Uniforms `uBase` (vec3), `uAccent` (vec3, hard-coded gold `#BAA369` `:399`), `uWire` (float). Two-sided (`if (!gl_FrontFacing) n = -n`), fixed key/fill/rim lights, `cullFace: false` (`:395`). Clear colour is a hex literal `:371`. |
| Camera/controls | `:375,469-480` | `Orbit` with `enablePan: false`, inertia 0.72, `minDistance 0.55`, `maxDistance 4×`; model normalised to unit bounding-sphere radius (`:384-407`), Z-up → Y-up rotation `:410`. `frustumCulled: false` skips ogl's bounds pass (`:403-406`). |
| AR | `:72-131` (WebXR types), `:330-337`, `:526-606` | WebXR `immersive-ar` only; true scale `AR_SCALE = 0.001` (mm→m); **no hit-test / plane detection** — placed at a guessed floor (−0.45 m) 0.7 m ahead (`:333-337`); button rendered only when `navigator.xr` + `XRWebGLLayer` exist AND `isSessionSupported('immersive-ar')` (`:751-764`). No USDZ / Quick Look / Scene Viewer anywhere (grep `usdz|quick-look|scene-viewer` in src+worker = 0). |
| Strings | `STR` `:133-186`, `t = lang === 'en' ? STR.en : STR.ar` `:648` | **ar/en only — no ckb** (`grep -c ckb` = 0); Sorani readers get Arabic. 22 raw-palette class uses (`zinc-*`, `amber-*`, `bg-black`), i.e. predates the token rule. |
| Fallbacks | `:665-716, 775-776, 906-910` | Two distinct 404s (dead link vs no preview); `noWebgl` when `mountViewer` throws → measurements only (`:729-732`). **No 2D render fallback exists.** |
| Test hooks | `data-page="model-viewer"`, `data-viewer="canvas|ready|grid|wireframe|reset|ar|info|simplified"`, `data-viewer-field=…` (`:787-942`) | `data-viewer="ready"` is set after the first frame (`:499-502, 790`). |

## 2. The mesh contract — LVM1

- **Writer** `worker/lib/modelGeometry.ts:1009-1065` `viewerMesh(bytes, name, maxTriangles = 250_000)`: header `'LVM1' | u32 triangles | 6×f32 bbox` (32 B) then 9×f32 per triangle; **positions only, millimetres, centred on the bbox centre** (`:1044-1051`); decimation = fixed stride, whole triangles (`:1029-1030`); object/placement order preserved (probe D: Body triangles first, Base after).
- **Coarse writer** `worker/lib/requestFilePolicy.ts:115-151` `coarsePreviewMesh`: ≤ 20 000 triangles, stride, every coordinate snapped to `max(0.25 mm, longest/400)`; **assumes the fixed 36-B stride and re-emits exactly `32 + kept×36` bytes** (a trailer after the triangles would be tolerated on input — `byteLength < 32 + count*36` is the only check — but dropped on output).
- **Reader** `src/pages/ModelViewer.tsx:209-255` `parseLvm`: rejects only `byteLength < 32 + floats*4` → trailing bytes after the triangle block are ignored today (a backward-compatible place for a region table).
- **Sizes** (arithmetic): 32 + 36·T → 20k = 720 KB, 50k = 1.8 MB, 100k = 3.6 MB, 250k = **9.0 MB**. Served as `application/octet-stream`, `Cache-Control: private, max-age=0, no-store`, no `Content-Encoding` (`worker/routes/printRequests.ts` `meshResponse` ≈`:1845-1859`; no compress middleware in `worker/index.ts`, grep = 0; Cloudflare's automatic compression content-type list does not include octet-stream — external knowledge). Every viewer open re-downloads the whole mesh; a `preview` grant recomputes the coarse mesh per request (measured 6–8 ms).
- **Storage**: private keys `request-previews/<req>/<file>.lvm` (`printRequests.ts:292`), `product-previews/<product>/<file>.lvm` (`productFiles.ts:184`), `post-previews/<post>/<id>.lvm` (`communityPosts.ts:756`), written by `deriveModelPreview` (`viewerGrants.ts:315-350`, best-effort, **inline in the attach request**, ≤ `MODEL_MAX_BYTES` 40 MiB) and by the request analyse route (`printRequests.ts:259-321`). All three columns are registered for the orphan sweep in `worker/lib/mediaRefs.ts:371-377` — any new derived key (turntable stills, region maps, GLBs) must be registered there or it is swept.
- **Pinned by** `tests/modelGeometry.test.ts:404-431` (magic, count, centring, exact byte length "positions only", decimation), `tests/productFiles.test.ts:422`, `tests/requestViewerTokens.test.ts:72`, `docs/PRINT_REQUESTS.md:190`.

## 3. Parsers — what each format gives up (`worker/lib/modelGeometry.ts`)

| Format | Read | Ignored / lost | Line |
|---|---|---|---|
| STL binary/ASCII | triangles, ASCII `solid <name>` as title | stored normals, attribute bytes | `:584-621` |
| OBJ | `v`, `f` (fan-triangulated, negative indices) | **`o`/`g`/`usemtl`/`mtllib` groups and materials** | `:625-651` |
| 3MF | `<object id>` meshes, `<build><item objectid transform>` (4×3), unit, Title/Description/first object `name` as title, **flat set** of `displaycolor|color`, first `<base name>` as material | **`<components>` (assembly objects) → `NO_GEOMETRY` (probe B, measured)**; `pid/pindex` per object/triangle; per-object identity discarded by `fromIndexed` (`:731-744`, probe A: 2 named cubes → 24 anonymous triangles, `title = 'Body'`) | `:679-763` |
| AMF | coordinates/triangles, unit, `name` metadata | volumes, materials, colours | `:777-807` |
| glTF/GLB | `meshes[].primitives` mode 4, `POSITION` float32 VEC3, indices u8/u16/u32, embedded data-URI buffers | **nodes/scenes/transforms (meshes iterated directly `:844-863`), node/mesh/material names, materials, Draco, external buffers, units heuristic noted but not applied** | `:811-873` |
| STEP | product name | everything (no kernel) | `:938-942` |

`analyseModel` (`:255-284`) → `ModelAnalysis` (`:155-201`): dims, bbox min/max (mm), volume, area, triangles, shells/watertight (≤ `TOPOLOGY_TRIANGLE_CAP` 400 000 `:207`), overhang, bed contact, complexity, warnings (12 codes `:137-149`), `suggested_colors`. Hard cap 5 M triangles (`:209`). Stored as JSON in `community_request_files.analysis`, `product_files.analysis`, `community_post_files.analysis` (0157). `bbox_min_mm/bbox_max_mm` are stored — they let a client re-place a per-file-centred LVM at its original position.

Measured (Node 22, this sandbox, synthetic binary STL): analyse 20k tri **73 ms**, 100k **180 ms**, 250k **433 ms** (topology pass dominates), 500k **79 ms** (topology skipped); `viewerMesh` 9 / 11 / 36 / 48 ms; `coarsePreviewMesh` 6–8 ms. No `limits.cpu_ms` in `wrangler.jsonc` (grep = 0); docs cite only the free plan's 10 ms (`docs/CLOUDFLARE_SETUP.md:28`, `docs/SECURITY.md:89`). The brief's "50 ms" is the legacy Bundled plan; the Standard plan defaults to 30 s CPU (external knowledge, plan not verifiable from the repo).

## 4. Files, sessions, grants (Phase 4 substrate)

- **Tables**: `upload_sessions` + `file_objects.sha256/purpose` (`migrations/0156_asset_platform.sql:24-49`); `product_files` (roles `preview|download_after_purchase|reference|instruction|source_model`, `kind`, `analysis`, `preview_key`, `position`), `product_file_grants` (UNIQUE file×user), `community_post_files`, `viewer_grants` (`token_hash` PK, `source_type product|post`, `grant_level preview|full`, `bound_user`/`bound_session`, `revoked_at`), `model_view_tokens.source_type/source_id` (`migrations/0157_product_and_post_files.sql:25-105`).
- **Sessions** `worker/routes/uploadSessions.ts`: `POST /api/uploads/sessions` (`:464-533`) → parts `PUT /:id/parts/:n` (`:535-569`, exact part size) → `GET /:id` resume → `POST /:id/complete` (`:583-676`: parts, quota re-ask, head/tail sniff `inspectStoredObject :347-457`, ZIP central-directory bound, glTF JSON ≤ 4 MB `:75,416-426`, streamed SHA-256, `analyseModel` ≤ 40 MiB `:77,449-455`, ledger row, returns `key` for `KEY_PURPOSES` `:664`) → `DELETE`. Sweep `:704-731`.
- **Entity/purpose rules** `worker/lib/uploadEntity.ts`: purposes `:31-36`, session purposes `:44-49`, kinds per purpose `:64-74` (`product_file: image|model|document`, `post: image|video|model|document`, `request: image|model|document`, `offer`, `order_update: image`), `assertUploadEntity :97-247`, `placementFor :311-338` (post pictures public `users/<uid>/posts/`, models private `post-files`; `product_file` private `merchants/<uid>/product-files/`; request private `requests/<uid>/files/`), quotas `:384-393`, defaults `worker/lib/settings.ts:600-613` (image 25 MB, video 100, model 300, document 25, archive 500, chunk 8 MiB; quotas post 2 GB, product_file 5 GB, request 1 GB), `SESSION_PART_MAX_BYTES` 40 MiB `:377`.
- **Ownership** `worker/lib/fileOwnership.ts`: `ownedFileObject(db, key, userId, purposes)` `:97-123` (private + owner + purpose), `PRODUCT_FILES_MAX = 12`, `POST_FILES_MAX = 3` `:49-51`, `GRANTED_ROLES` (never `preview`) `:46`, `hasProductGrant :246-262`, `attachmentResponse :316-327` (nosniff, sandbox CSP, no-store).
- **Grants** `worker/lib/viewerGrants.ts`: 60-min TTL `:40`, guest binding SHA-256(IP+UA+UTC day, today or yesterday) `:61-71,172-179`, re-checks the source's visibility at read `:181-226`, revoke statements `:256-295`, `deriveModelPreview :315-350`.
- **Routes**: merchant `GET/POST/PUT order/PATCH/DELETE /api/merchant/products/:id/files` (`worker/routes/productFiles.ts:153-276`, `deriveModelPreview` inline at `:182-187`, purge of the guest cache `:143-151`); public `GET /api/product-files/:slug/:productId` under `anonymousCached(c, { perViewer: true })` (`:343-368`), `POST …/:fid/viewer-token` (`:375-395`, rate limit `viewer-token` 60/h, `preview` role only, `full` for owner/buyer), `GET …/download` (`:408-428`); viewer `GET /api/marketplace/print/viewer/:token` and `…/mesh` (`printRequests.ts:1765-1836`) resolve request tokens or grants (`viewerGrantFor :1867-1875`); request token mint `:1708-1757`; matrix `requestFilePolicy.ts:5-10` (owner/engaged → full, eligible → coarse).
- **Client**: `src/components/community/files/api.ts` (typed doors `:94-132`), `src/lib/uploadSession.ts` (`SESSION_THRESHOLD_BYTES` 8 MiB `:35`, models always session `:37`, resume records), `src/components/upload/UploadTile.tsx` (`{file, purpose, entityId, onDone, onCancel}` `:35-41`, SHA-256 in a worker `sha256.worker.ts`), the wizard uses it with `purpose="request"` (`RequestWizard.tsx:717-719`).
- **Edge cache**: `worker/lib/edgePolicy.ts` `anonymousCached(c, { params, lifetime, perViewer }, build)` `:184-222`, canonical key = path + declared params sorted `:124-133`, `purgeAnonymousCache :229+`.

## 5. IMAGES binding and pictures

- Read in one file: `worker/lib/imageConvert.ts` (`env.IMAGES` optional, `worker/lib/types.ts:22`; undefined in tests/`wrangler dev` → `unavailable` `:30-35,211-213`). `convertToWebp :233-269` (PNG/JPEG → WebP q85, input ≤ 20 MB `:43`, source cap 8 MB `:63`), `productImageToWebp :279-368` (refuses animated GIF, verifies WebP via `info()`), variants `IMAGE_VARIANT_WIDTHS = [320, 640, 1080]` `:408`, AVIF→WebP→stored negotiation `:446-451`, `renderImageVariant :480-505` (`fit: 'scale-down'`, streamed). `GET /files/<key>?w=` **public keys only** (`worker/routes/uploads.ts:1041-1048`, `IMAGE_VARIANT_PRIVATE`), pinned by `tests/imageVariants.test.ts:37-287`.
- Binding surface per `@cloudflare/workers-types` (unused by the repo today): `ImageTransformer.transform/draw(image, {opacity, repeat, composite over|in|…, top/left/bottom/right})/output` (`index.d.ts:14834-14856`), `ImagesBinding.text(content, { font: { url ttf/otf/woff/woff2 }, size, color })` (`:14828, 14562-14572`), `ImageOutputOptions.format` includes **`'rgb' | 'rgba'` raw pixels** (`:14656-14665`), `info()` (`:14809`). So the Worker CAN get a downscaled photo's pixels (lithophane/relief heightmaps) without a decoder — unverifiable locally (binding absent), and `.text()` shaping of Arabic is unknown.
- Client preprocess: `src/lib/imagePreprocess.ts` (3000 px edge ladder, 8 MB), `src/components/ui/SafeImage.tsx` (`srcset` of the three widths `:27-33,131-150`).
- `src/components/community/projects/MediaStrip.tsx`: snap strip of `PostMedia` (image `<img loading=lazy>` / `<video preload=metadata muted playsInline>` tap-to-play `:69-83,129-165`), `useRail`, one moving dot with `layoutId` — **imports `motion` from `motion/react` directly (`:12,95`)**, the pattern `tests/bundleBudget.test.ts:282-283` warns about (fine only because `Project` is lazy); a customizer must render `m.*` under `<MotionFeatures>`.
- Store layout media rules `packages/storeLayout/src/blocks.ts:108-122`: `MEDIA_CAPS` cover 1.5 MB, **poster 400 KB**, video 12 MB, gallery item 1 MB; a video without a poster is refused `LAYOUT_POSTER_REQUIRED` (`verify.ts:148-157`); `LAYOUT_MEDIA_TOO_HEAVY` on the ledger's `byte_size` (`normalize.ts:60`, `verify.ts:142,198`). The "every template needs a still" rule for cards/OG has this precedent.
- Product pictures/video table `community_product_media` (`migrations/0126_catalog_variants.sql:178-190`, keys `merchants/*|community/*`, ≤ 12 per product).

## 6. ogl 1.0.11 — what exists, what it costs (`node_modules/ogl/src/index.js`)

- Exports: core `Geometry, Program, Renderer, Camera, Transform, Mesh, Texture, RenderTarget`; math; extras `Plane, Box, Sphere, Cylinder, Triangle, Torus, Orbit, Raycast, Curve, Path, Tube, Post, Skin, Animation, Text, NormalProgram, Flowmap, GPGPU, Polyline, Shadow, KTXTexture, TextureLoader, GLTFLoader, GLTFSkin, GLTFAnimation, DracoManager, BasisManager, WireMesh, AxesHelper, GridHelper, VertexNormalsHelper, FaceNormalsHelper, InstancedMesh, Texture3D`.
- Built chunk `vendor-webgl` (**15,629 B gz9**, `vite.config.ts:214`) holds only what ModelViewer imports; `texImage2D`, `intersectTriangle`, `castMouse` occur 0 times in it → **Texture, Raycast, Plane, Text, GLTFLoader are not shipped today**. Per-module gzip if added (upper bounds, module-level): Texture 2,039 B, Plane 776, Raycast 3,537, InstancedMesh 948, Text 2,099, TextureLoader 2,004, GLTFLoader 8,905, Post 1,296, RenderTarget 1,302.
- `Raycast`: `castMouse(camera, [x,y])` `Raycast.js:33`, `intersectBounds` (computes `geometry.bounds` on demand `:71`), `intersectMeshes` walks **`geometry.drawRange.start/count`** `:169-171`, non-indexed OK, exposes `mesh.hit.{point, localPoint, distance, faceNormal, uv, normal}` — **not the triangle index** (`closestA` stays local `:161-197`).
- `Geometry`: `drawRange`/`setDrawRange` (`Geometry.js:39,116`), `instancedCount`, attributes may reference an existing `buffer` with `offset/count/min/max` (`:9-15`) → several region "views" over one GPU buffer.
- `Program`: uniform arrays/structs supported via name components (`Program.js:95-101, 178-235`, `setUniform` flattens arrays `:240+`); render state `transparent, depthTest, depthWrite, depthFunc, cullFace, blendFunc` (`:18-46`); no polygon offset. `Texture` accepts any `image` with `width` (canvas/img) → `texImage2D` (`Texture.js:144-172`); NPOT needs WebGL2 or clamp `:178`. `Renderer` tries `webgl2` then `webgl` (`Renderer.js:30,43-45`).
- `Text` (`extras/Text.js:1-240`) is a **BMFont/MSDF layout**: `font.chars`, `font.common.scaleW/scaleH` atlas, `glyphs[char]` per code point (`:24-26,98`) — no Arabic/Sorani shaping or bidi; unusable for ar/ckb names without a shaper.
- `GLTFLoader.load(gl, src)` fetches a URL (`:68`) / `parse(gl, desc, dir)` (`:77`); keeps `name/extras` on nodes and materials (`:396-465, 766-810`); Draco/basisu need managers.
- **Precedent in-repo**: `src/components/CircularGallery.tsx:1,112-131` builds text via Canvas 2D `measureText`/`fillText` → `new Texture(gl)`, `texture.image = canvas`, on a `Plane` — exactly the decal mechanism — but it is dead code (no importer, not in dist) and points at Google Fonts (`:26`).

## 7. Budgets and measured chunk weights (`tests/bundleBudget.test.ts`, gzip level 9 as the test does)

| Budget | Constant | Today (measured) |
|---|---|---|
| Entry | `ENTRY_BUDGET = 72 KB` (`:52`) | `index-*.js` 67,741 B (6.0 KB free) |
| Initial payload | 200 KB (`:73`); `vendor-webgl`, `vendor-qr`, `vendor-charts` etc. must never be static (`:271-281`) | ok |
| CSS total | 60 KB = 61,440 B (`:75,542-552`) | **60,964 B (59.5 KB) → 476 B headroom** |
| Any chunk | 250 KB | largest `vendor-charts` 119.8 KB |
| Storefront closure | 47 KB (`:381,397-423`) | at the number per its own comment (`:365-366`); `Storefront` 6,361 B, `StorefrontProduct` 6,447 B, `ProductFiles` 1,664 B (lazy block), `ProductFilesEditor` 2,844 B |
| Workspace shell / closure | 25 / 32 KB (`:442-443`) | shell 15,488 B |
| Other chunks | — | `ModelViewer` 7,429 B; `Requests` (wizard etc.) 40,453 B; `vendor-qr` (jsqr) 46,588 B (gz6); `zxingReader` 31,313 B; `BarcodeScanner` 8,781 B; `Project` 6,384 B; `ProjectComposer` 8,964 B |

## 8. QR

`worker/lib/qr.ts`: byte mode, **EC level M only**, versions 1–10, ≤ 213 UTF-8 bytes (`:25-26,404-418`), 8-mask penalty selection, `qrToSvgPath` (`:458-468`). Used by `worker/lib/warrantyDoc.ts:205-212` (print SVG), `src/components/profile/QrCodeModal.tsx:111`, `src/components/merchant/share/shareStoreModel.ts:30` (re-exported to the client via `src/components/profile/qr.ts:11`). Tests `tests/qr.test.ts:22-127`. Decoding exists client-side (`jsqr` lazy, `@zxing/library` lazy, `src/components/scanner/decodeEngine.ts:110-208`) — a "validate QR readability" check can run in the browser on the rendered/rasterised code. For an embossed QR: modules 21²…57² → ≤ 3,249 raised cubes ≈ 39k triangles worst case (v4 URL ≈ 33² ≈ 13k).

## 9. Fonts on the server

`public/fonts/cairo/cairo-v31-arabic.woff2` 30,896 B, `latin` 33,820 B, `latin-ext` 16,648 B, `cairo-kurdish-patch.woff2` 4,832 B, IBM Plex Mono 400/500 ≈ 14.8 KB each. **woff2 only** (needs a Brotli decoder to read outlines), no TTF/OTF, no font parser or triangulator in deps, and the "no new dependencies" rule (`worker/lib/qr.ts:9-11`).

## 10. Tests and browser harness that pin behaviour

- Unit: `tests/modelGeometry.test.ts` (26 tests: sniffing, measurements, 3MF unit/metadata, decimation, LVM contract), `tests/requestViewerTokens.test.ts` (F/G rules), `tests/productFiles.test.ts:167-481` (roles, previews, grants, guest coarse mesh, refund revokes), `tests/productFilesUi.test.ts:59-280` (ar/en/ckb with real Sorani, lazy chunk, sf-* classes/no hex/no dark:), `tests/postFilesUi.test.ts:87-230` (mintOnce, tokens only), `tests/uploadSessions.test.ts:124-469`, `tests/attachments.test.ts:60-219`, `tests/imageVariants.test.ts`, `tests/qr.test.ts`, `tests/printQuoteGeometry.test.ts` (pricing reads `analyseModel` output — must not change).
- Browser fixtures: `tests/browser/print-requests-v2-fixture.tsx:9-10,87-90,105` (viewer with mocked metadata; **mesh fetch unmocked → the fixture shows the "no preview" path**, canvas never renders), `projects-fixture.tsx:214`, `catalog-fixture.tsx:128`.
- E2E: `scripts/e2e-print-request-ui.mjs:323-343` opens a real viewer at **390 px, `locale: 'ar'` only**, asserts `[data-viewer="canvas"]` exists and the dims text — not `data-viewer="ready"`; Chromium launched with `--no-sandbox` only (no swiftshader/GL flags, `scripts/*.mjs` grep = 0). The acceptance matrix the brief names exists in `scripts/e2e-projects.mjs:156-170`: `lang ∈ {ar,en,ckb} × width ∈ {360,1280} × theme dark/light`, `reducedMotion: 'reduce'` on light.

---

# EVALUATION — live 3D personalisation on this substrate

Shared constraints: entry has 6 KB, CSS 476 B, storefront closure 0 B of headroom → every surface is a new lazy chunk with **no new utility classes** (reuse sheet/segmented primitives); `vendor-webgl` is shared by ModelViewer and any customizer; the customer never sees the words in §3.

## (A) Named-region templates → per-region colour, canvas decals, shown/hidden parts  — RECOMMENDED PRIMARY

**Server (once per template).** Extend the existing derive path, not a new one: `parse3mf` gains (i) `<components>` expansion with composed transforms (today → `NO_GEOMETRY`, probe B — every Bambu/Prusa/Orca multi-object export fails), (ii) per-placement `{object name, triangle start, count}` and `pid/pindex` colour per object; `parseGltf` gains node walking with transforms + node names; `parseObj` gains `o/g/usemtl` ranges. `viewerMesh` keeps LVM1 byte-for-byte and appends a **trailer** (`'LVR1' | u16 regions | per region: u32 start, u32 count, u8 role, name`) — the current `parseLvm` ignores trailing bytes, so nothing shipped breaks; `coarsePreviewMesh` must copy and re-index the trailer (stride keeps order → `start/stride`). Region map + anchors (text/logo/QR: origin, normal, up, width, height in mm; declared by the merchant in the builder, defaulted to each region's bbox top face) live as JSON beside `analysis` (additive column or the same JSON) and are served by a guest-cacheable GET under `anonymousCached` with declared params. Cost: the same parse that runs today (measured `viewerMesh` 36 ms at 250k; templates should be ≤ 30–50k triangles → 1–2 MB on the wire, < 10 ms).

**STL-only merchants** (no named parts): a template = N `product_files` (≤ 12) — each already gets its own LVM and `analysis.bbox_min/max_mm`, so the client re-offsets each per-file-centred mesh to its true position; N viewer tokens per open (rate limit 60/h/user, `productFiles.ts:376`) argue for a single template route instead of N mints.

**Client** (new lazy `Customizer` chunk, sharing `vendor-webgl`): one Program; per-vertex `region` attribute (Uint8, from the trailer, 1 B/vertex like `corner`) + `uniform vec3 uRegionColor[16]` **indexed in the vertex shader** (GLSL ES 1.00 only guarantees dynamic uniform-array indexing there; fragment shaders need constant indices) → recolour = one uniform update, one draw call. Tap-to-select: `Raycast.castMouse` + `intersectMeshes` over N region `Geometry` views sharing the same `buffer` with `drawRange` (Raycast walks `drawRange`) → hit mesh = region; no triangle index needed. Text: Canvas 2D `measureText` loop = Smart Fit (shrink/wrap to the anchor width), `fillText` with the page's Cairo (`document.fonts.load`) — Arabic/Sorani shaping, bidi and ligatures come free from the browser (ogl `Text` cannot do this); styles Fun/Gaming/Elegant/… = font weight, stroke, shadow presets on the canvas; the canvas becomes a `Texture` sampled as a **projective decal inside the region shader** (anchor frame as uniforms; `mix` over the region's triangles) — follows curved bodies, no z-fighting, no extra geometry; logos = same path from an `<img>`/blob URL of the customer's file (no server round trip for preview; the key is attached at request time). Components/accessories = `visible` per region or per accessory mesh. Reduced motion = no Orbit inertia (`inertia` option) and no auto-spin.

**Bytes**: `vendor-webgl` +Texture +Raycast (+Plane if a plane decal is chosen) ≈ +5.6–6.3 KB gz upper bound; customizer chunk ≈ 12–18 KB gz (estimate from `ModelViewer` 7.4 KB with two shaders and ar/en strings) — 0 B in entry/initial/storefront closures if lazy from the product page and the request wizard. CSS: 0 new classes required (canvas + existing sheet primitives).

**What the customer sees**: rotate/zoom, tap a part → sheet, colours change instantly, name/text update live in their own script, logo appears where the merchant allowed, sizes as whole-model scale (volume ∝ s³ for the price on the server). Text/logo are *painted* previews — flat, not raised; honest wording: "preview", the merchant chooses raised/engraved.

**What breaks / risks**: `coarsePreviewMesh` snapping (0.25 mm or longest/400) is invisible at template scale but must carry the trailer; templates authored with overlapping/inside-out shells look right (two-sided shader) but mislead thickness; decals on regions with back-facing triangles need the projection to test `dot(n, anchorNormal) > 0`; big templates (250k → 9 MB) are unusable on Iraqi mobile — enforce a template triangle cap (≤ 50k) at attach; iOS Safari WebGL context limits (viewer already calls `WEBGL_lose_context`).

**Tests that pin it**: unit — trailer round-trip and `parseLvm` ignoring it; `parse3mf` components/names/colours per object (extend probe A–C into `tests/modelGeometry.test.ts`); coarse keeps regions; the region JSON never carries a key or file name. Browser — a fixture that serves a real 3-region LVM `ArrayBuffer` (today's fixture serves none), Playwright ar/en/ckb × 360/1280 × reduce on/off asserting `data-viewer="ready"`, a tap at a deterministic screen point after `reset()` opens the region sheet (`data-region=`), text state via a `data-customizer-text` attribute rather than pixels, no `motion.*` static import (bundleBudget pattern), strings ar≠en≠ckb.

## (B) Server-side text geometry (extruded glyphs into the LVM)

**Blocking fact**: the Worker has no font outlines (woff2 only; Brotli needed), no parser (`opentype`-class ≈ 170 KB raw, forbidden as a new dependency), and — decisive for ar/ckb — no shaper: without GSUB init/medi/fina/liga and mark positioning, Arabic and Sorani names extrude as disconnected isolated letters. Latin-only would be achievable with a hand-written `glyf` reader (~300 lines) and a TTF subset added to assets (~100–150 KB raw for Cairo Arabic+Latin).

**Geometry cost is not the problem** (measured, naive O(n²) ear clipping): 200-pt contour 3 ms, 1,000 pts 12 ms, 3,000 pts 105 ms; a 10-glyph name ≈ 1,200 outline points ≈ 15 ms, ≈ 5–8k triangles ≈ 0.2–0.3 MB LVM. Live typing would mean a Worker round trip per debounced edit (≈ 200–500 ms perceived from Iraq) and a private, uncacheable response (names must never enter the shared edge cache).

**Variant B′ worth keeping for production, not preview**: the client renders the (shaped) text/logo to a mask canvas → uploads a small PNG → the Worker gets pixels (`IMAGES` `format:'rgba'`, or fflate inflate + PNG unfilter, ~80 lines) → marching squares → ear-clip → extrude → **a generated 3MF** (XML + `zipSync`, no writer exists yet) with the text as a separate object and per-object `transform`s. This is what "the merchant gets the depth" needs; the LVM preview stays approach A. CPU 20–120 ms per relief (measured contour costs + heightmap 128–256² grids at 9–26 ms).

**Client bytes**: 0. **Breaks**: no boolean union (overlapping shells — slicers merge; state it), quality of traced contours at small text (the printability engine must refuse < 0.8 mm strokes at the mask resolution).

## (C) 2D / 2.5D composited preview (no-WebGL fallback)  — RECOMMENDED FALLBACK, client-side flavour

**Client software raster from the same LVM** (measured Node: 512² z-buffer flat shading, 20k triangles **20 ms/frame**, 100k 72 ms/frame; phones ≈ 3–5× slower → the 20k coarse mesh at ~10 fps drag-to-turn or 8 precomputed frames): reuses `parseLvm`, the region trailer (recolour via palette per region), and the same canvas text at the projected anchor centre (2D overlay, correct only for flat anchors). ≈ 3–4 KB gz, no server work, no new key. This replaces today's "measurements only" `noWebgl` state and gives the Playwright harness (no GL flags) something deterministic to screenshot.

**Server stills** (Worker rasteriser, same algorithm): 8 frames of a 20k template ≈ 156 ms one-time, cached under a new private prefix registered in `mediaRefs.ts`; needed anyway as the template's **poster** for cards/OG/`community_product_media` (the poster rule precedent, `verify.ts:148-157`). Per-region recolour of a still requires an ID-map PNG (writer ≈ 40 lines, fflate deflate + CRC) or one still per theme (10 themes × 8 frames × N sizes explodes). `IMAGES.draw()`/`.text()` can composite text on a merchant's photo, but Arabic shaping in `.text()` is unverifiable here and the binding is absent locally — do not build the fallback on it.

**Breaks**: no free orbit in the stills flavour; lighting differs from WebGL; text on curved surfaces is approximate.

## (D) Parametric templates — what can honestly be promised

Honest: (1) whole-model Small/Medium ⭐/Large = uniform scale (price from `volume_mm3 × s³`, dims × s, server-side); (2) repeated parts (2/4/6 slots) = a declared region instanced N times at a declared pitch (`InstancedMesh` 0.9 KB gz or N `Mesh`); (3) "9-slice in 3D": a template declares stretch regions along one axis (cap–middle–cap) and the client scales the middle/translates the caps — right for stands, plaques, boxes, holders; wrong for organic shapes (seams) — the builder must mark which regions stretch; (4) constraints (Part 5 #10) as declared rules on choices, evaluated server-side, never on geometry. Production is cheap and exact: emit the original objects with 3MF build `transform`s (scale/translate/instances) — 3MF already carries them (`apply3mfTransform` reads the same matrix). **Not promisable**: hole diameters, wall thickness, true booleans, "magnet 20 mm needs a larger base" as geometry — that is a CAD kernel the repo explicitly does not have (`modelGeometry.ts:69-73`); model it as a different template variant. Client bytes ≈ 1–2 KB over (A).

## AR export

- Today: WebXR-only, true scale, no plane detection (`ModelViewer.tsx:333-337,526-606`); Android Chrome in practice; the button is absent on iOS.
- GLB: a writer is ≈ 80 lines (JSON + BIN, unindexed positions; normals optional; `COLOR_0` u8×4 per region); 30k-triangle template ≈ 1.1 MB (positions) / 2.2 MB (+normals) / +0.36 MB colours; CPU = one copy pass (≈ tens of ms). USDZ: uncompressed ZIP with 64-byte alignment (fflate `zipSync` level 0 has no alignment padding → hand-rolled stored-zip ≈ 60 lines) around a generated `.usda` — feasible, untested, no way to verify Quick Look here. Both Quick Look and Scene Viewer fetch **without the page's cookies and with another UA**, so a guest `viewer_grants` binding (IP+UA+day) would refuse them → needs an IP+day-bound or unbound 10-minute token; a template's preview mesh is not private in the way a customer's file is, so an unbound short token is defensible for templates only.
- "Approximate size in your space" without WebXR: `getUserMedia` camera + the (C) raster silhouette at a size computed from a user-entered distance or a reference card ≈ 3–4 KB gz; honest only with the word "approximate" and the customer entering the distance. Part 1 calls AR optional — recommend keeping WebXR where present, adding the GLB for the merchant (real value), deferring USDZ/overlay until the owner accepts the caveats.

## Recommendation

**Primary (A)**: one template file with named regions (3MF preferred; glTF nodes; OBJ groups; N-STL assembly via stored bboxes as the merchant fallback) → `LVM1 + region trailer` from the existing derive path → a lazy `Customizer` on ogl with vertex-shader colour arrays, region `Geometry` views for tap, canvas-shaped text/logos as projective decals, Smart Fit on canvas. **Fallback (C-client)**: software-rasterised turntable from the same LVM for no-WebGL, plus server stills as posters. Production geometry (text/logo relief, parametric transforms) is **B′ as a later phase**: generated 3MF for the merchant, never the customer's preview. Schedule against community §9.6–9.8 and merchant P6–P11: the reels viewer and `community_product_media` (P6) are the poster/still consumers; nothing pending in either programme touches `modelGeometry.ts`, LVM or `ModelViewer.tsx` (grep of both docs).

REUSE:
[
 {
  "ask": "Live 3D preview of a merchant template with recolourable regions",
  "existing": "LVM1 pipeline: viewerMesh (worker/lib/modelGeometry.ts:1009) → private preview_key on product_files (0157) → viewer_grants + GET /api/marketplace/print/viewer/:token/mesh → parseLvm + ogl scene in src/pages/ModelViewer.tsx",
  "how": "Append a region trailer after the LVM1 triangle block (parseLvm already ignores trailing bytes); teach parse3mf/parseGltf/parseObj to emit per-object/node/group triangle ranges; extend coarsePreviewMesh to carry the trailer; add a per-vertex `region` attribute + `uniform vec3 uRegionColor[16]` indexed in the vertex shader; mount the scene in a lazy Customizer chunk that shares vendor-webgl"
 },
 {
  "ask": "Tap a part of the model to edit it",
  "existing": "ogl Raycast (castMouse/intersectMeshes, walks geometry.drawRange) and Geometry's shared-buffer attributes (node_modules/ogl/src/extras/Raycast.js:33,169; core/Geometry.js:9)",
  "how": "One Geometry view per region over the same position buffer with setDrawRange(start,count); the hit mesh is the region; +3.5 KB gz for Raycast"
 },
 {
  "ask": "Name/text with Smart Fit and friendly styles, in Arabic, English and Sorani",
  "existing": "Canvas 2D text → ogl Texture pattern already written in src/components/CircularGallery.tsx:112-131; Cairo fonts self-hosted (public/fonts/cairo, @font-face in src/index.css:54)",
  "how": "measureText loop for fit/wrap, fillText with document.fonts.load('700 48px Cairo'), sample the canvas texture as a projective decal in the region shader (anchor frame from template JSON); drop CircularGallery's Google Fonts URL"
 },
 {
  "ask": "Logo / photo upload for personalisation",
  "existing": "Phase 4 session platform: UploadTile (src/components/upload/UploadTile.tsx:35), purposes and kinds (worker/lib/uploadEntity.ts:64), ownedFileObject (worker/lib/fileOwnership.ts:97), IMAGES WebP conversion (worker/lib/imageConvert.ts:233)",
  "how": "Preview from a local blob URL (no round trip); attach the key at request/cart time under an existing private purpose (request/post/product_file) checked by ownedFileObject; server rasters via IMAGES output rgba when a relief is generated"
 },
 {
  "ask": "Merchant template builder (upload model, define regions)",
  "existing": "Merchant product files editor and routes (worker/routes/productFiles.ts:153-276, src/components/storefront/ProductFiles.tsx, ProductFilesEditor chunk), role `preview`, deriveModelPreview, analysis JSON with bbox_min/max_mm",
  "how": "A template is a `preview`-role product file whose derived analysis gains the region map and anchors (additive JSON); STL-only merchants attach one file per part (≤ 12) and the client re-offsets each centred LVM by its stored bbox centre"
 },
 {
  "ask": "Guest-cacheable template/region/anchor reads",
  "existing": "anonymousCached with declared params and purge seams (worker/lib/edgePolicy.ts:184, purgeProductFiles in productFiles.ts:143)",
  "how": "Serve the region/anchor JSON on the public product-files door with params declared; purge on the merchant's edits through the existing purge path"
 },
 {
  "ask": "Default preview poster for cards / OG / reels",
  "existing": "Poster rule and caps in packages/storeLayout (blocks.ts:113, verify.ts:148), community_product_media (0126:178), IMAGES variants 320/640/1080 for public keys",
  "how": "Server-rasterised still (pure-JS z-buffer, ~20 ms per 512² frame at 20k triangles) written as a public merchants/<uid>/public WebP via IMAGES from rgba, registered in community_product_media so variants and edge cache apply"
 },
 {
  "ask": "No-WebGL fallback and deterministic Playwright screenshots",
  "existing": "ModelViewer's noWebgl branch (src/pages/ModelViewer.tsx:729) and parseLvm",
  "how": "A ~3–4 KB software rasteriser over the same LVM (regions recoloured by palette, text overlaid at the projected anchor) replaces the measurements-only state; the e2e harness (no GL flags) can pin it"
 },
 {
  "ask": "QR personalisation and readability check",
  "existing": "worker/lib/qr.ts (encode + SVG path, re-exported to the client via src/components/profile/qr.ts) and the client decoders jsqr/@zxing (src/components/scanner/decodeEngine.ts)",
  "how": "Rasterise the QR onto the decal canvas (or emboss ≤ 39k triangles server-side in B′) and decode the rendered canvas with jsqr as the readability gate; consider adding EC level H to qr.ts for printed codes"
 },
 {
  "ask": "Production geometry for the merchant (raised text, logo relief, stretched parts)",
  "existing": "fflate zipSync (already a dependency), 3MF parser knowledge of build transforms (modelGeometry.ts:765), IMAGES rgba output",
  "how": "Generate a 3MF (XML + zipSync) with the original objects, per-object build transforms for size/instances, and the text/logo relief as an extra object traced from the client's mask (marching squares → ear clip → extrude); delivered through the existing product_file/offer file doors"
 },
 {
  "ask": "AR 'see it in your space'",
  "existing": "WebXR path in ModelViewer.tsx:526-606 at true scale",
  "how": "Keep it; add a GLB export (≈80-line writer over the LVM + COLOR_0 per region) for merchants; a Quick Look/Scene Viewer link needs a token not bound to UA (their fetch has no cookies and another UA) — template previews only"
 }
]

GAPS:
["No per-region/material/group information survives any parser: parse3mf concatenates objects (modelGeometry.ts:731-744), parseGltf ignores nodes and names (:844-863), parseObj ignores o/g/usemtl (:629) — a region map is new work in the derive path.","parse3mf does not expand <components>: a slicer-style assembly 3MF measures as NO_GEOMETRY (probe B) — most merchant multi-part exports would fail template ingestion today.","glTF node transforms are not applied, so a multi-node glTF template would be mispositioned/duplicated; only embedded (data-URI) or GLB buffers are read.","LVM1 carries positions only and coarsePreviewMesh re-emits a bare LVM1 — the coarse path must be extended to carry any region trailer or guests lose regions.","The viewer is a full-screen page opened with window.open; there is no inline/embeddable viewer component, no React wrapper of mountViewer, and no test hook for programmatic picking.","ModelViewer.tsx has no Sorani strings (ar/en only) and 22 raw-palette classes; a customizer cannot copy it verbatim under the token/ckb rules.","No text rendering in 3D: ogl Text needs an MSDF atlas and cannot shape Arabic/Sorani; the Worker has no font outlines (woff2 only), no font parser and no triangulator, and new dependencies are forbidden.","No 2D fallback: without WebGL the viewer shows numbers only; the Playwright harness runs Chromium without GL flags and the browser fixture never serves a mesh, so nothing today pins a rendered frame.","The mesh route sends uncompressed float32 soup with no-store caching: 9 MB at the 250k cap, re-fetched on every open — no template triangle cap, no quantised/indexed variant, no ETag.","No GLB/USDZ writer, no 3MF writer, no generated production geometry of any kind; AR is WebXR-only (absent on iOS) with no hit-test.","IMAGES draw()/text()/rgba output are unused and unverifiable locally (binding absent in tests and wrangler dev); Arabic shaping of IMAGES.text() is unknown.","The QR encoder offers EC level M only (printed/embossed codes usually want H) and is capped at 213 bytes.","Rate limit 'viewer-token' 60/h per caller and one grant per file make N-file (multi-STL) templates expensive to open; per-file LVM centring loses relative placement unless the stored bbox is used.","CSS budget headroom is 476 B and the storefront closure is at its cap: any customizer UI must reuse existing primitives and mount lazily from the product page.","No derived-artefact prefixes exist for turntable stills, region maps or GLBs; mediaRefs.ts must list them or the sweep deletes them.","The Worker CPU plan is not stated in the repo (no limits.cpu_ms; docs cite only the free 10 ms); measured analysis of a 250k-triangle model is 433 ms in Node, which only fits a Standard-plan limit."]

RISKS:
["Template ingestion silently loses geometry today (<components>, glTF nodes); shipping a builder before those parser gaps are closed means merchants upload files that measure empty or wrong.","Mesh weight on Iraqi mobile: a 250k-triangle template is 9 MB uncompressed per open; without a template cap (≤ 30–50k) and ETag/immutable caching for template previews the customizer is unusable on 3G/4G.","Changing LVM1 in place (rather than a trailer) breaks the shipped viewer, coarsePreviewMesh and three test files; the trailer route keeps the client contract but coarse must be updated in the same phase.","Per-region colours via dynamic uniform-array indexing in the FRAGMENT shader are not guaranteed on GLSL ES 1.00 (WebGL1 devices) — colours must be resolved in the vertex shader or per draw range.","Decals as separate planes z-fight on curved regions; a projective decal in the region shader avoids it but needs anchors declared by the merchant (builder complexity) or defaulted from region bboxes (wrong on complex parts).","Text preview is painted, not raised: without B′ production geometry the merchant receives a name as an image + mm anchor, not printable geometry — customer expectation vs delivered object must be worded honestly.","Arabic/Sorani names are the primary market: any server-side text path without a shaper renders broken letterforms; only the browser canvas is safe today.","Playwright acceptance at 360/1280 × ar/en/ckb × reduced motion cannot pin a WebGL frame without a mesh-serving fixture and GL flags; a software-raster fallback is what makes the screenshots deterministic.","The IMAGES binding is absent locally, so rgba decoding, draw() compositing and text() cannot be unit-tested; every such path needs the same 'unavailable' degradation imageConvert.ts already practises.","Guest viewer grants bound to IP+UA+day will refuse AR Quick Look / Scene Viewer fetches (different UA, no cookies); a looser token is defensible only for template previews, never for customer files.","Inline preview derivation in the attach request (433 ms at 250k in Node) plus a region pass may exceed a 50 ms plan; if the account is on the legacy Bundled plan the derive must move to waitUntil/queue — the plan is not knowable from the repo.","Entry (6 KB), CSS (476 B) and storefront-closure (0 B) headroom: one accidental static import of the customizer or vendor-webgl from StorefrontProduct or the entry fails bundleBudget the same day.","Multi-STL templates reconstructed from per-file bboxes depend on merchants exporting all parts in one coordinate frame; a re-centred export breaks placement with no way to detect it.","MediaStrip's direct `motion` import is an existing anti-pattern; copying it into the customizer would drag vendor-motion into a storefront closure (bundleBudget.test.ts:282)."]

NUMBERS:
MEASURED (gzip level 9, dist built 2026-09-30 01:46, 9 src files newer): entry index-*.js 67,741 B of 73,728 (72 KB); CSS total 60,964 B of 61,440 (60 KB) → 476 B headroom; vendor-webgl 15,629 B; ModelViewer 7,429 B; Storefront 6,361 B; StorefrontProduct 6,447 B; ProductFiles 1,664 B; ProductFilesEditor 2,844 B; Requests 40,453 B; MerchantDashboardPage 15,488 B of 25,600; Project 6,384 B; ProjectComposer 8,964 B; vendor-qr (jsqr) 46,588 B (gz6); zxingReader 31,313 B; BarcodeScanner 8,781 B; vendor-charts 119,781 B (largest chunk).
ogl module gzip (upper bounds if added): Texture 2,039 B; Plane 776; Raycast 3,537; InstancedMesh 948; Text 2,099; TextureLoader 2,004; GLTFLoader 8,905; Post 1,296; RenderTarget 1,302; WireMesh 1,081. Estimated: vendor-webgl +5.6–6.3 KB gz for Texture+Raycast(+Plane); Customizer lazy chunk 12–18 KB gz; software-raster fallback 3–4 KB gz; camera overlay AR 3–4 KB gz.
LVM1 bytes = 32 + 36·T: 20k → 720 KB; 50k → 1.8 MB; 100k → 3.6 MB; 250k (cap) → 9.0 MB; coarse (≤ 20k) ≤ 720 KB. Region trailer estimate: per-vertex uint8 = 3 B/triangle (750 KB at 250k) or range table ≈ 20 B/region.
Worker CPU (Node 22 sandbox, synthetic binary STL): analyseModel 20k 73 ms / 100k 180 ms / 250k 433 ms / 500k 79 ms (topology skipped > 400k); viewerMesh 9 / 11 / 36 / 48 ms; coarsePreviewMesh 6–8 ms. Software raster 512²: 20k triangles 20 ms/frame, 100k 72 ms/frame (8 frames 156 / 573 ms). Heightmap relief: 128² 32,258 tri 11 ms (1.16 MB LVM); 200² 79,202 tri 9 ms (2.85 MB); 256² 130,050 tri 26 ms (4.68 MB). Naive ear clipping: 200 pts 3 ms; 1,000 pts 12 ms; 3,000 pts 105 ms. No limits.cpu_ms configured; docs cite free plan 10 ms; brief's 50 ms = legacy Bundled; Standard default 30 s (external).
Caps/limits in code: viewerMesh 250,000 tri; COARSE_PREVIEW_MAX_TRIANGLES 20,000; TOPOLOGY cap 400,000; hard cap 5,000,000; MODEL_MAX_BYTES 40 MiB; IMAGE 8 MiB; ANALYSIS_MAX_BYTES 40 MiB; GLTF_JSON_CAP 4 MiB; ZIP ≤ 2,000 entries, ratio 8×; upload limits image 25 / video 100 / model 300 / document 25 / archive 500 MB, chunk 8 MiB, SESSION_PART_MAX 40 MiB; quotas post 2 GB / product_file 5 GB / request 1 GB; PRODUCT_FILES_MAX 12; POST_FILES_MAX 3; MAX_FILES_PER_REQUEST 6; viewer TTL 60 min; rate limits viewer-token 60/h, model-analyze 60/h, upload-session 30/h, product-file-write 120/h; IMAGES input 20 MB, variants 320/640/1080, WebP q85, AVIF q75; storeLayout caps cover 1.5 MB, poster 400 KB, video 12 MB, gallery 1 MB; QR ≤ 213 bytes, versions 1–10, EC M; embossed QR ≤ 3,249 modules ≈ 39k triangles (v4 ≈ 13k).
Fonts: cairo arabic 30,896 B, latin 33,820 B, latin-ext 16,648 B, kurdish patch 4,832 B, IBM Plex Mono 14,708 / 14,888 B (all woff2).
Test/e2e matrix: e2e-projects langs ar/en/ckb × widths 360/1280 × dark/light (reduce on light); e2e-print-request-ui viewer 390 px, ar only, asserts canvas presence; git working tree 52 changed paths.
GLB estimate: 30k-triangle template ≈ 1.1 MB positions / 2.2 MB with normals / +0.36 MB COLOR_0; writer ≈ 80 lines; USDZ stored-zip writer ≈ 60 lines (untested).

---

## Survey — community

# COMMUNITY substrate — as it IS (read at HEAD 98dc0305 + the uncommitted Phase 5 / P4–P5 edits, 2026-09-30)

## 1. Tables (D1) that a design / remix / twin / vault design must build on

| Table | Migration | Shape that matters |
|---|---|---|
| `community_posts` | 0153:48–86 | `id (newId 'prj')`, `author_id→users CASCADE`, `kind CHECK ('project','post','tutorial','timelapse','before_after')` (:51–52, CLOSED), `title`, `body`, `state CHECK draft|published|archived` (:55), `visibility CHECK public|unlisted|private` (:56), `printer_product_id/printer_name`, `material_product_id/material`, `color`, `print_settings JSON` (:64), `print_time_minutes`, `dimensions JSON`, `tags JSON`, doors `store_id→merchant_stores`, `product_id→community_products`, `request_id→community_requests`, `community_order_id→community_orders` (:69–72), `consent_status CHECK not_needed|pending|granted|declined` (:73–74), counters `like/comment/save/view_count` (:76–79), `admin_hidden_at/_reason` (:81–82), `published_at`. Partial feed index on published+public+not hidden (:90–92); author/store/product/request indexes (:93–96); trigger `trg_post_published_has_date` (:100–106). |
| `community_post_media` | 0153:117–128 | `post_id CASCADE`, `kind image|video`, `media_key` (public `users/<uid>/posts/…`), w/h/duration, `sort_order` (first row = cover). |
| `users.creator_public` | 0153:140 | 0/1; set to 1 by the first publish (communityPosts.ts:967), toggled by PATCH /api/profile (profile.ts:122–133). |
| `user_follows` | 0154:19–26 | `(follower_id, user_id)` PK, CHECK not self; `users.follower_count` + triggers (0154:156–164). No per-follow notification switches. |
| `community_likes` / `community_saves` / `community_comments` | 0154:31–65 | saves carry `collection TEXT NOT NULL DEFAULT ''` (≤40, free text, moved by `ON CONFLICT … DO UPDATE`, communitySocial.ts:151–155); comments one level (`parent_id`), `state visible|removed|hidden`, `client_id` replay key (0155:15–17). Counter triggers 0154:117–151 (MAX(0,…) floors). |
| `user_blocks` / `user_mutes` / `community_reports` | 0154:74–109 | reports `target_type CHECK (post,comment,user,store,product,request)` (:97, CLOSED) — 0160 works around it with `community_report_targets(report_id PK, kind CHECK request_comment|order_update, target_id)` (0160:77–83). |
| `upload_sessions`; `file_objects + sha256, purpose` | 0156:24–49 | resumable multipart; purpose column drives quotas and `ownedFileObject`. |
| `community_post_files` | 0157:59–75 | `post_id CASCADE`, private `file_key` (`users/<uid>/post-files/…`), `kind model|document`, `analysis JSON`, `preview_key` (LVM under `post-previews/<postId>/<fid>.lvm`), `downloadable 0/1`, `downloads`, `position`. ≤3 per post (`POST_FILES_MAX`, fileOwnership.ts:51). |
| `viewer_grants` | 0157:83–98 | `token_hash PK` (SHA-256 of a 32-byte token), `source_type CHECK ('product','post')` (:85, CLOSED), `source_id`, `file_key`, `grant_level preview|full`, `bound_user` XOR `bound_session` (SHA-256 IP+UA+UTC day), `expires_at`, `revoked_at`, `uses`, `last_used_at`. |
| `model_view_tokens` | 0045:231–242, 0132:182–185, 0157:103–105 | request-world only: `file_id NOT NULL→community_request_files`, `request_id NOT NULL`, `revision`, `grant_level`, `bound_user`; `source_type CHECK ('request','product','post')` DEFAULT 'request' — cannot be made nullable additively (0157:14–17). |
| `link_cards` | 0158:30–41 | one row per URL, `kind model_page|video|article|unknown`, re-hosted `image_key` `link-cards/<id>.webp`. |
| `community_orders` | 0031:93–122 | `request_id`, `offer_id` (UNIQUE), `customer_id`, `merchant_id→community_merchants`, `store_id`, `state CHECK (accepted,funded,in_progress,merchant_marked_delivered,customer_confirmed,completed,disputed,cancelled,refunded)`, price identity CHECK, `offer_snapshot`, `chat_id→chats`, `delivered_at/confirmed_at/auto_complete_at/completed_at/cancelled_at`; + `request_revision`, `request_snapshot JSON`, `contact_snapshot` (0130:112–114); + `ready_at`, `started_at` (0160:67–68). **No serial, no design reference.** `community_order_items(title, description, qty, unit_price_iqd, line_total_iqd)` (0031:131–139). |
| `community_order_updates` | 0160:54–63 | `kind CHECK (started,progress,photo,ready,note,modification_request,delivered)`, `body`, private `file_key` `community-orders/<orderId>/updates/…` — the "proof of production" photos already have a home. |
| `community_requests` | 0001:273–279 + 0031:21–39 + 0116:89 (`revision`) + 0130:102–103 (`customer_notes`, `published_at`) + 0151:37–39 (`target_merchant_id`, `origin_chat_id`, `created_by customer|merchant`; `visibility` 'direct' has no CHECK) | the ONE road onto the board is `publishRequest` (community.ts:483–496 comment). |
| `community_request_files` | 0031:48–58, 0045:195–197,249 | `kind reference|model|document`, `model_format`, `analysis`, `preview_key`. |
| `community_offers` + `community_offer_files` | 0159:36–58 (uncommitted) | `delivery_fee_iqd, quantity, color, terms, is_draft`; offer files private `merchants/<uid>/offers/`. |
| `follows` (store follows) | 0001:282–287; 0031:311–313 | `(user_id, merchant_id)`; `notify_products`, `notify_offers`, `notify_updates` DEFAULT 1 — WRITTEN by PATCH /api/community-reviews/follow/:merchantId (merchantReviews.ts:393–410), READ BY NOTHING in worker/. |
| `merchant_showcase` | 0036:67–79 | `kind printer|material|work`, `image_key` — the «من أعمال الورش» rail (community.ts:460–484), Q2 open. |
| `community_product_favorites` | 0038:6–13 | product saves (`/api/community-favorites`, outside the wall). |
| `user_notifications` | 0045:36–60 | per-language `title_ar/en`, `body_ar/en`, `link` (path), `entity_type`, `entity_id`, `meta JSON`, `event_key`; UNIQUE `(user_id, event_key) WHERE event_key <> ''` (:59–60) — the grouping upsert's conflict target. |
| Serials elsewhere | 0003:112/132 `order_item_units`, `device_serials`; 0098:316–328 PART 7 («building a second serial system beside them is exactly what §41 forbids»); 0139 `serial_inventory(serial_norm PK …)` | store-device world only; nothing on community orders. |

## 2. Worker routes (all `/api/community/*` mounted in worker/index.ts:346–355 in this order: community.ts → communityPosts.ts → communitySocial.ts → communitySearch.ts; every router does `use('*', communityGate())`)

**Gate** — worker/lib/communityGate.ts: reads `admin_settings.communityGate` `{open, allowed_user_ids}` (:85–91); closed by default; admins always in (:100–102); 503 `COMMUNITY_CLOSED {closed:true}` (:126–133); open paths only `/access`, `/my-store`, `/profile-status` (:191–195); `requireCommunityOpen` for routes outside the prefix (:233–237; list of which marketplace routes carry it :170–189). Client half: src/pages/community/access.tsx (`CommunityAccess {closed, admin, may_enter}` :40–47; `CommunityGate` :216; every community route in src/App.tsx:915–951 is wrapped).

**Posts** — worker/routes/communityPosts.ts (1203 lines)
- Shapes: `POST_KINDS` :62, `VISIBILITIES` :64, `POST_MEDIA_MAX 12` :67, `POST_TAGS_MAX 10` :68, `postHref` :74, `authorPublic` (username only when a page exists) :82–90, **`postCard`** :93–152, `POST_COLUMNS` (5 LEFT JOINs + 5 correlated media subqueries) :155–169, `POST_FROM` :170–175, **`POST_PUBLIC_SQL`** = published ∧ public ∧ not hidden ∧ consent ∈ {not_needed, granted} :178–179, `POST_SEARCH` :181, `postExclusionSql(viewer)` (blocks both ways + mutes) :189–192, `viewerFlagsFor`/`withViewerFlags` :218–237, `nextPostCursor` (limit+1, exact) :245–250, `mayRead` (author/staff always; consent party may read whatever the state; else published ∧ public|unlisted) :355–364, `consentPartyOf` :367–379.
- Reads: `GET /posts` (q, kind, not_kind, author, store, product, tag; cursor `published_at|id`; limit ≤48 def 18; `total` on page 1) :259–303; `GET /posts/trending` (30 d, score `like*3+comment*4+save*5+views`, ≤24) :306–320; `GET /posts/:id` (media/file keys to author+admin only; `request_id`/`community_order_id` to author only; `viewer.{mine,liked,saved,following_author,consent,can}`) :438–492; `GET /my-posts` (`created_at|id`, + `consent_status`, `hidden`) :1131–1156; `GET /creators/:username` (SOCIAL_KEYS allow-list :1167–1173; `creatorVisible` :1188–1192) :1178–1246.
- Writes (all `requireAuth`): `readPost` bounds :546–662 (title 3–140, body ≤4000, settings ranges, dims ≤5000 mm, tags ≤10×30, media ≤12, files ≤3); **`checkLinks`** (store via `storeForUser`; product of that store and not `audience_user_id`; printer/material exist; request/order: customer → `not_needed`, maker (order's merchant or accepted offer's merchant) → `pending` + `customerToAsk`) :669–722; `checkMedia` (prefix `users/<uid>/posts/` or `merchants/<uid>/public/` AND `file_objects` owner row; kind by mime) :729–741; `checkFiles` (`ownedFileObject(db, key, uid, ['post'])`, model|document) :752–767; `fileStatements` (keeps rows by key, revokes grants of dropped files, `deriveModelPreview` → `post-previews/<postId>/<fid>.lvm`) :776–815; `askConsent` (`notify` kind `portfolio_consent`, eventKey `portfolio_consent:<postId>`) :831–845; `POST /posts` (`post-create` 20/h, `newId('prj')`, one `db.batch`) :847–878; `PATCH /posts/:id` (`post-edit` 120/h; `POST_ARCHIVED`; published keeps ≥1 media and refuses a new pending consent `CONSENT_REQUIRED`; `visibility='private'` revokes viewer grants) :887–946; `POST /publish` (`post-publish` 30/h; `POST_HIDDEN_BY_ADMIN`, `CONSENT_REQUIRED/DECLINED`, `POST_NEEDS_MEDIA`; sets `users.creator_public = 1`) :953–974; `/archive` (revokes grants) :976–988; `/restore` (→ draft) :990–998; `DELETE` (published refused `POST_PUBLISHED`; revoke before cascade) :1001–1011; `POST /posts/:id/files/:fid/viewer-token` (guest OK on a readable post, session-bound; `full` for the author else `preview`; `viewer-token` 60/h) :1052–1067; `GET …/download` (`requireAuth`; `downloadable` or author; counted; audited) :1074–1088; `POST /posts/:id/consent` (the linked job's customer only) :1091–1128.

**Social** — worker/routes/communitySocial.ts (800 lines): `interactablePost` (mayRead + block → 404) :86–92; like PUT/DELETE (`social-like` 240/h; `notifyGrouped` `post_liked:<postId>`, not to a muter) :106–139; save PUT/DELETE (`social-save` 240/h; `collection` ≤40; nobody told) :143–172; `GET /saved` (`saved_at|post_id`; drops posts gone private/hidden unless own) :179–204; comments GET :279–309 / POST (`social-comment` 60/h; 2–2000; 10 s cooldown; `client_id`; `comment_replied:<parentId>`, `post_commented:<postId>`) :338–431 / DELETE :439–453; follow PUT (`follow-user` 60/h; target must have a page; `new_follower:<userId>`; link to follower's page or `/community?tab=creators`) :471–500, DELETE :502–511; block (deletes follows both ways) :519–540; mute :542–558; `GET /me/social` (4 lists ≤500) :561–571; reports (`report` 20/h; existence checked with each target's own visibility rule; `ON CONFLICT DO NOTHING` → `replayed`; Telegram topic after response) :575–655; **`GET /feed?scope=foryou|following`** (following = `user_follows` ∪ owners of followed stores; ≤30 def 12) :666–692; `creatorListSql` :707–735, `creatorCard` :738–760, `GET /creators` (offset cursor; `featured=1`) :775–812.

**Search/discovery readers** — worker/routes/communitySearch.ts (803 lines): bounds `SEARCH_QUERY_MAX 60`, `SECTION_MAX 12`, `COUNT_BOUND 200`, recommend window 180 d, trending window 30 d (:100–116); `rateLimit('community-search', 120, 60)` :120; edge cache via `caches.default` under a canonical key (:34–47, 158–188): `GET /search` guest `public, max-age=60` params `[q,types,limit]` :422–438; `/search/suggest` params `[q]` :580–592; **`/trending`** everybody `public, max-age=300`, no params :660–675 — `trendingProjects` (8, same score) :602–611, `trendingTags` (12) :613–621, `trendingStores` (6; `orders_30d` = COMPLETED community orders + `follows_30d`) :623–637, `trendingCreators` (6; `likes_30d`) :639–654; **`/recommend?for=post|store|product:<id>`** (guest cached 60 s params `[for,limit]`, member `private, no-store`) :785–803; `recommendForPost` (3/tag + 2 material + 1 printer, 180 d, anchor must be PUBLIC not unlisted unless own/staff, block → 404) :698–732. No post read outside this file is edge-cached (grep: only community.ts:136 `/access` uses `anonymousCached(perViewer)`).

**Marketplace-side doors that a design flow touches** — community.ts: `/works` :460–484; `POST /requests` (draft then `publishRequest`) :497; store follow POST/DELETE (`follow` 60/h; `CANNOT_FOLLOW_OWN_STORE`) :580–605; `/followed` (`FOLLOWED_LIMIT 500`) :606–608; uncommitted: `GET /requests?for=me` (:355+) and `workshop` facts on `/store/:id` (:562–576). printRequests.ts: `GET /api/marketplace/print/viewer/:token` (viewer_grants first → `source_type`, `name`; else `model_view_tokens`) :1765–1807, `…/mesh` (coarse mesh for `preview`) :1809–1836; `/print/requests/:id/repeat` exists (named in communityGate.ts:177).

## 3. Libraries
- worker/lib/viewerGrants.ts: TTL 60 min :40; `viewerSessionInput` (CF-Connecting-IP + UA ≤512) :54–59; `anonymousSessionHash` (today/yesterday accepted) :69–71, 176–178; `mintViewerGrant` (`randomToken(32)` → `/model-viewer/<token>`) :91–105; `resolveViewerGrant` (bound account or day-session; product visibility re-asked; post `mayRead` + consent + `blockedEither` re-asked) :157–227; revoke statements per product/file/post :256–295; **`deriveModelPreview`** (`headMediaObject` ≤ `MODEL_MAX_BYTES`, `analyseModel`, `viewerMesh`, private `putMediaObject`) :315–350.
- worker/lib/notifications.ts: `NotificationKind` union :34–164 (community kinds `portfolio_consent` :39, `post_liked|post_commented|comment_replied|new_follower` :136–139, `files_added|request_files` :149–150, uncommitted `request_comment|request_question|request_answer` :162–164); `entity_type` union (`community_post`, `community_comment`, `user`) :186–196; `notifyStatement` (`INSERT OR IGNORE`, batchable) :228–252; **`notifyGrouped`** (upsert `ON CONFLICT(user_id, event_key) WHERE event_key <> ''`; `meta.count` = PEOPLE via `meta.actors` window `ACTORS_KEPT 50`; `repeatActor 'ignore'|'bump'`; title recomputed from RETURNING count) :298–381; `stampGroupedCkb` (Sorani in meta) :391–404; `peopleAr` :410–414. Client: src/lib/notifications.ts:28–43 (open-set kinds), src/components/notifications/NotificationBell.tsx:147–155 icon map (`post_liked`→Heart, comments→MessageCircle, `new_follower`→UserPlus, `portfolio_consent`→Images, default Bell).
- worker/lib/uploadEntity.ts: `UPLOAD_PURPOSES` :31–36, `SIMPLE_UPLOAD_PURPOSES` :40, `SESSION_PURPOSES` :44–48, `KEY_PURPOSES` :56–62, **`placementFor`** :311–337 (post image/video → public `users/<uid>/posts/`; post model/doc → private `users/<uid>/post-files/`; community → public `merchants/<uid>/public/`; request → `requests/<uid>/files/`; product_file → `merchants/<uid>/product-files/`; order_update → `community-orders/<orderId>/updates/`; offer → `merchants/<uid>/offers/`).
- worker/lib/fileOwnership.ts: `FileKind` :26; `OwnedFileObject` :28–34; `POST_FILES_MAX 3` :51; **`ownedFileObject(db, key, userId, purposes)`** — private, owner, not deleted, purpose '' or listed :97–123; `attachmentResponse` :316.
- worker/lib/mediaStorage.ts: `MediaDomain` union :5–33 (no 'designs'); `isSafeMediaKey` :107–112; `isAnonymousPublicMediaKey` (public: `products/`, `avatars/`, `community/`, `link-cards/`, `users/<uid>/(avatar|public-avatars|posts)/`, `merchants/<uid>/(public|logos|covers)/`) :670–682.
- worker/lib/edgePolicy.ts: `anonymousCached(c, {params, lifetime, perViewer}, build)` :182–222 — only session-free GETs are stored; canonical key of declared params :122–133; `perViewer` → `Vary: Cookie` :143–146; `COMMUNITY_ACCESS_PATH` :266.
- worker/lib/socialPreview.ts: OG resolvers for products (`/p/<slug>`, `/community/store/<ref>/p/<slug>`) and stores only (:93–94, 311, 470) — nothing for `/community/projects/:id` or `/u/:username`. worker/lib/storeShareKit.ts: store-owner-only share kit (url, unfurl card, app icon) :33–117.
- 3D: src/pages/ModelViewer.tsx (959 lines) reads `GET /api/marketplace/print/viewer/:token` then `…/mesh` (:675, :695); `ogl ^1.0.11` is the only 3D dependency (package.json:42); worker/lib/modelGeometry.ts 1065 lines.

## 4. Client surfaces
- Routes (src/App.tsx:309–317 lazy; :915–951): `/community` (Community.tsx), `/community/projects`, `/community/projects/new` (ProtectedRoute), `/community/projects/:id`, `/community/projects/:id/edit`, `/u/:username`, `/community/saved` (ProtectedRoute), `/community/store/:id`, `/community/store/:slug/p/:productSlug`, `/requests` (CommunityGate with `closedExtra`), `/followed-stores`; `/model-viewer/:token` full-screen (:694, :819–828). `SocialProvider` wraps the customer shell (:384; SocialContext.tsx fetches `/me/social` once per account).
- **Home hub** src/pages/Community.tsx: six tabs `TAB_IDS = foryou|following|projects|requests|stores|creators` (hub/tabs.ts:13; old `products`/`merchants` rewritten :27–28); panel switch :227–234; `QuickActions` hidden while a term is set :320; sticky TabStrip :326–340; `ToolsSection` (Studio link, calculator, «مكتبة ملفات الطباعة» comingSoon) :369–408. hub/QuickActions.tsx: `grid grid-cols-4` (:20) with exactly four doors — «طلب طباعة» → `/requests?view=new` (primary, sage disc), «شارك مشروعًا» → `/community/projects/new`, «طلباتي» → `/requests?view=mine`, «أتابعهم» → `/followed-stores` (:21–24). hub/ForYouPanel.tsx: order cover → TrendingTags → trending rail (ProjectCard rail, 8) → requests (3) → CreatorsRail → StoresRail → products grid (6) → lazy FeedList (mounted within 400 px, :153) → tools → colophon (:71–132); `visibleSections` decides numbering once (:138–147). hub/useHomeData.ts: 8 parallel reads (`/posts/trending?limit=8`, `/requests` 3, `/trending` composite, `/works`, `/products` 6, `/posts?limit=1` for `total`, tags) :68–90; memo 2 min (`FRESH_MS`, hub/feedCache.ts:16); page cache key `community:home` :42. hub/rails.tsx `CreatorsRail`/`StoresRail`; hub/parts.tsx `SectionHead` :77, `Reveal` :128, `Rail` :157, skeletons :169–246. hub/FollowingPanel.tsx: guest → sign-in alert; empty → «ابدأ بهؤلاء» rails (:53–75).
- **Feed** feed/FeedList.tsx (`/feed`, 2 auto-loads then a button :26; client-side block/mute filter :81; `ComposerDock` :93); feed/ComposerDock.tsx (inline offsets, no `.lv-community-dock` rule :5–11). **feed/PostCard.tsx fields used**: `author.{avatarUrl,name,username}`, `kind` (label from `s.kinds`), `published_at`, `cover.{url,kind,width,height}` (portrait → `aspect-[4/5]`), `title`, `excerpt` (+ `LinkRow`), chips ≤6 from `printer.product`, `material.product`, `product` (+price), `store`, `tags` (:53–61), `ActionRow` (like/comment/save/share/⋯), and for `kind==='project'` two verbs: «اطلب طباعتها» → `/requests?view=new&project=<id>` (:63) and «اشترِ المواد» (:136–147).
- **Project page** src/pages/community/Project.tsx: banners (draft/archived/hidden) :171–189; consent card :191–210; `MediaStrip`, `Byline` + `FollowUserButton`, `ActionRow` with author actions :232–241; `SpecList` + doors (store, product+price, material) :114–140; `LinkRow` :254; `FileRows` («عرض ثلاثي الأبعاد», download) :259; tags → `/community/projects?tag=`; lazy `RecommendRail anchor=post:<id>` when published :279–283; sticky action bar «اطلب طباعة مثلها» → `/requests?view=new&project=<id>` with `state.project {id,title,material,color}` and «اشترِ هذه القطعة» (:289–313).
- **Composer** src/pages/community/ProjectComposer.tsx (page, D10): `Draft` :36–61 (title, body, kind, visibility, printer/material catalogue picks, color, hours/minutes, x/y/z, layer/infill/nozzle, supports, tags, store_id/product_id, media ≤12, files ≤3); `toInput` :131–167; publish = save then `/publish` :231–256; refusal codes mapped to fields (`fieldOf`) :222–230; visibility `Segmented` public|unlisted|private with `visibilityHint` :459–470; `creatorPageOn` notice :472–474; `CataloguePick` combobox over `/api/products?category=cat_printers|cat_materials` :506–607.
- **Creator page** Creator.tsx: tabs `projects|posts|about` (:42) — posts = `not_kind=project` (:278). **Saved** Saved.tsx: one grid via `socialApi.saved()`, no collections UI (:31–46); social/SaveButton.tsx `showCount` false by default (:16–17). **Profile «مشاريعي»** src/components/profile/MyProjectsTab.tsx (lazy, Profile.tsx:17, tab id `projects` :730, :841–844): rows with state pill, `consentPending`, `hidden`, «مشروع جديد» → composer.
- **Request wizard door**: src/pages/Requests.tsx:104–110 reads only `location.state.printLink` or `?link=`; `view` from `?view=new|mine|orders` :115–122; RequestWizard.tsx:228–230 seeds `source_type:'link'` from `initialLink`. `SourceType = 'model'|'link'|'images'|'description'` (requests/api.ts:11); `WizardPayload` :137–155 (`source_type, process, material_id, quality, quantity, color_hex, color_name, primary_file_id, source_url, source_meta, stated_dimensions_mm, governorate, delivery_pref, deadline, budget_iqd`). **Nothing reads `?project=` or `state.project`** (grep over src/pages/Requests.tsx and src/components/community/requests/**).
- Strings (all ar/en/ckb, D6 real Sorani): hub/strings.ts (94 keys/lang: 78 leaves + `search` 5 + `tabs` 6 + `kinds` 5; helpers `sectionNumber`, `projectsLabel`, `workshopsLabel`, `resultsCount`, `colophon` :262–336), projects/strings.ts (126 leaves/lang; `visibilityHint` :21, `printOneLikeIt` :41, `creatorPageOn` :71), social/strings.ts (78/lang), search/strings.ts, links/strings.ts; src/lib/refusalStrings.ts carries 49 community/file/link codes (POST_*, CONSENT_*, VIEWER_*, UPLOAD_*, LINK_*, COMMENT_*, REPORT_*, …), loaded lazily on the first refusal.

## 5. Registries every new community table / kind / key must join
- packages/contracts/src/ownership.ts `owned('marketplace', [...])` :153–180 (community_posts, media, files, viewer_grants, social tables, 0160 tables) — tests/ownership.test.ts fails on any table a migration creates that is not owned (:1–5).
- worker/lib/schemaVersion.ts:46 `EXPECTED_MIGRATION = '0161_storefront_vitals.sql'` (uncommitted) — tests/schemaVersion.test.ts:30,40 pin newest file + count.
- worker/lib/mediaRefs.ts `MEDIA_REFERENCE_SOURCES` (:368–380 for post media/files/viewer_grants/link_cards) and `NON_MEDIA_COLUMNS` (:407–411 for `community_posts.print_settings|dimensions|tags`) — an unregistered TEXT column fails the sweeper test (:996).
- `NotificationKind` + `entity_type` unions (notifications.ts:34,186), client union + bell icon map; `MediaDomain` union + `isAnonymousPublicMediaKey` for any new prefix; `UPLOAD_PURPOSES`/`SESSION_PURPOSES`/`KEY_PURPOSES`/`placementFor` for any new upload purpose; refusalStrings.ts for every new code (ar/en/ckb).

## 6. Tests and browser scripts that pin behaviour
tests/communityPosts.test.ts (11: draft privacy, server-side filters + cursor, media forgery, link forgery, author-only writes/body cannot set counters, unlisted/private/hidden matrix, consent flow, store owner is public, inside the wall, creator switch + socials allow-list, published keeps promises); tests/communitySocial.test.ts (22: idempotent like/save, grouped people-count, comment ownership + stub, draft untouchable, follow rules + spam, block matrix, quiet mute, following feed, report once/oracle, creators list, body forgery, client_id replay, viewer `total`, null body, notification links); tests/communitySocialUi.test.ts (8); tests/communityHubUi.test.ts (10 — «six sections in the owner's order» :132, no button inside a link :152, «every word in ar/en/real ckb» :189); tests/communitySearch.test.ts (15); tests/communitySearchUi.test.ts (11); tests/postFiles.test.ts (6: keys to author only, ≤3 own private files, edit keeps rows, anonymous session-bound link on a PUBLIC post, revoked on archive/private/delete, download rules); tests/postFilesUi.test.ts (9); tests/uploadSessions.test.ts (10); tests/linkCards.test.ts (14); tests/linkCardsUi.test.ts (11); tests/communityGate.test.ts (35); tests/bundleBudget.test.ts (entry 72 KB :52, initial 200 KB :73, CSS total 60 KB :75/551, storefront closure 47 KB, workspace shell 25/32 KB). Browser: scripts/e2e-projects.mjs (200 lines; ar/en/ckb × dark/cream × 360/1280 with ckb one representative pass :159 and reduced motion = the cream pass :168–170) over tests/browser/projects.html; scripts/e2e-community-home.mjs (289 lines; reduced motion = the ckb pass :75–76) over tests/browser/community-home.html.

## 7. In flight right now (uncommitted, another workflow) touching this area
`worker/routes/community.ts` (+67: `?for=me`, workshop facts), `worker/lib/notifications.ts` (+41: three discussion kinds, `repeatActor`), `worker/lib/uploadEntity.ts` (+122: `order_update`/`offer` purposes), `worker/routes/adminCommunity.ts` (+54), `worker/routes/marketplace.ts` (+819), `src/components/community/requests/api.ts` (+362), `worker/index.ts` (+8), new `worker/routes/communityOrderTimeline.ts`, `worker/routes/requestDiscussion.ts`, migrations 0159–0161, tests offersV2/orderTimeline/requestDiscussion. communityPosts.ts, communitySocial.ts, communitySearch.ts and the whole src/components/community/{hub,feed,projects,social,search,links} tree are NOT being edited.

REUSE:
[
 {
  "ask": "«My Designs»: save a complete configuration (template, name, text, colours, size, finish, logo, photo, QR, NFC, accessories) and come back to edit it",
  "existing": "community_posts is the one content table (D1) with state/visibility/consent/counters/moderation columns (0153:48–86), its JSON facts registered as NON_MEDIA_COLUMNS (mediaRefs.ts:407–411), its writes gated by communityGate and bounded by readPost (communityPosts.ts:546–662), and its ownership row under 'marketplace' (ownership.ts:153–180)",
  "how": "one additive table community_designs(id, owner_id→users, template ref (the merchant surveyor's template/product id), config JSON, name, visibility CHECK ('private','unlisted','public') DEFAULT 'private' — the same words as community_posts.visibility so mayRead's shape and the existing visibilityHint strings serve it, parent_design_id, root_design_id, post_id→community_posts NULL, community_order_id→community_orders NULL, snapshot_key (public users/<uid>/posts/… picture), preview_key (private LVM), created_at, updated_at) + ALTER TABLE community_posts ADD COLUMN design_id TEXT REFERENCES community_designs(id) ON DELETE SET NULL; register in TABLE_OWNER, NON_MEDIA_COLUMNS (config), MEDIA_REFERENCE_SOURCES (snapshot_key, preview_key), EXPECTED_MIGRATION; routes under /api/community/designs inside the same wall; a lazy «تصاميمي» tab beside MyProjectsTab in Profile (Profile.tsx:730) rather than a new hub tab"
 },
 {
  "ask": "a design becomes a post when published (private by default, never auto-published; names/photos/logos never auto-public)",
  "existing": "POST /posts → /publish with POST_NEEDS_MEDIA, CONSENT_*, POST_HIDDEN_BY_ADMIN and creator_public=1 (communityPosts.ts:847–974); post pictures are public keys under users/<uid>/posts/ written by putMediaObject; post files carry a private preview_key served by the viewer token (fileStatements :776–815, viewer-token :1052–1067)",
  "how": "POST /api/community/designs/:id/publish creates (server-side, ids in) a community_posts row kind 'project' with design_id, the design's rendered snapshot as its first community_post_media row (server puts the picture under users/<uid>/posts/ — no upload session needed), the design's generated mesh as a community_post_files row with preview_key (so «عرض ثلاثي الأبعاد», viewer_grants source_type 'post' and every revoke path work unchanged), then runs the existing publish rules; the feed, search, trending, saves, likes, comments, reports and hide all apply because the design IS a post; personal fields (name text, logo key, photo key) are stripped from the public config projection by a server whitelist, never by the client"
 },
 {
  "ask": "«Make it mine» / remix and «Make another»: a new independent design preserving product, layout, theme and colour arrangement, replacing name/logo/image; a discoverable remix tree",
  "existing": "the ids-in/decision-on-server pattern of checkLinks (:669–722) and ownPost (:880–885); newId ids; recommendForPost's bounded, cached neighbour rail (communitySearch.ts:698–732) and the RecommendRail lazy chunk on the project page (Project.tsx:279–283); the PostCard verbs row (PostCard.tsx:136–147)",
  "how": "POST /api/community/designs/:id/remix inserts a new community_designs row with parent_design_id = :id and root_design_id = COALESCE(parent.root_design_id, parent.id) computed in SQL, copying config minus the personal-field whitelist, refused unless the source is public (or shared to this viewer) and its remix flag allows it (a `remix_allowed` column on the source design, default 1 for public); «+ Make another» is the same route with parent = own design; an index (root_design_id, created_at DESC) feeds a «نُسخ من هذا التصميم» rail served like /recommend (bounded, guest-cached 60 s with declared params) and a third verb «اصنعه لي» in the PostCard/Project action rows for posts carrying design_id"
 },
 {
  "ask": "a shareable secure link: another user can view, rotate, remix, change the name and request printing without modifying the original",
  "existing": "visibility 'unlisted' = the link only, enforced by mayRead (communityPosts.ts:363), absent from POST_PUBLIC_SQL, search, trending and recommend (:702–704); post ids are unguessable newId('prj'); the guest viewer token is minted per opening browser and session-bound (viewerGrants.ts:69–105); revokePostViewerGrantsStatement on archive/private/delete; hashed-token table shape in viewer_grants (0157:83–98) and model_view_tokens (0045:231–242)",
  "how": "the share link is the design's own address at visibility 'unlisted' (design ids minted with newId, e.g. 'dsn'), not a viewer_grants token (those are bound to IP+UA+day and would not open on the recipient's phone); the recipient's browser mints its own viewer token on the design's post file; remix and request-print doors act on a NEW row; if revocable/expiring links are required, a small design_share_links(token_hash PK, design_id, expires_at, revoked_at, uses) with mintViewerGrant's randomToken(32)+sha256Hex shape — viewer_grants.source_type is a closed CHECK and must not be rebuilt; add an OG resolver for /community/projects/:id (socialPreview.ts has product/store only) so the link unfurls with the design's snapshot"
 },
 {
  "ask": "Digital Twin: after a personalised product is completed, keep View / Rotate / Edit / Duplicate / Reorder / Share in the account; QR/NFC on the object reopens it without exposing private data",
  "existing": "community_orders carries request_snapshot (0130:113), offer_snapshot, completed_at (0031:93–122); community_order_updates holds the workshop's photos (0160:54–63); posts already link community_order_id with D3 consent (0153:72; checkLinks :697–720); GET /posts/:id hands request_id/community_order_id to the owner only (:480–481); the repeat door /print/requests/:id/repeat exists (communityGate.ts:177); serial normalisation lives in packages/catalog/src/deviceSerials.ts (0139:23–24)",
  "how": "the twin is a JOIN, not a table: community_designs.community_order_id (set server-side when the request born from the design reaches completed) + design_id and a config hash inside request_snapshot at accept + the order's updates photos; the twin page is the owner's design page with the order card; Reorder = the existing repeat route seeded from the design; a serial (LEV-2026-091-0042) is a nullable column with a unique partial index on community_order_items (or community_orders) — never a second device-serial system (0098:316–328) — and the QR/NFC lookup route answers the full twin to customer_id only and a private-data-free card to anyone else, the same split GET /posts/:id already makes"
 },
 {
  "ask": "Follow a merchant/designer → opt-in useful notifications (new products, designs, drops, print availability, new colours), quiet by default",
  "existing": "notifyGrouped with groupKey per (recipient, key), repeatActor 'bump' for news from one sender, stampGroupedCkb for Sorani (notifications.ts:298–404); the fan-out sources user_follows (0154:19) and follows (0001:282) with the unread notify_products/notify_offers/notify_updates switches (0031:311–313, written at merchantReviews.ts:394–410); notifyStatement is batchable (:219–224); the bell icon map (NotificationBell.tsx:147–155); community_match_queue's deferred-work pattern (0132)",
  "how": "widen NotificationKind/entity_type with e.g. creator_published, store_drop, print_availability, new_materials (groupKey `<kind>:<authorId>`, repeatActor 'bump'), fan out from user_follows ∪ follows honouring the existing notify_* switches (default them OFF for the new kinds via a new column or an opt-in prefs blob on user_follows — 'quiet by default'), and defer the write behind a queue row rather than N inline inserts per publish (FOLLOWED_LIMIT 500 is a list bound, not a fan-out bound); add the glyphs to the bell and the kinds to src/lib/notifications.ts"
 },
 {
  "ask": "Community inspiration prioritises things actually made (finished object, design, colours, material, creator/merchant, story, final photos)",
  "existing": "community_posts.community_order_id + consent_status and POST_PUBLIC_SQL's consent clause (0153:72–74; communityPosts.ts:178–179) — the customer's own completed job needs no consent, the workshop's needs the customer's (D3); trendingStores already counts completed orders (communitySearch.ts:626–628); GET /posts takes declared server-side filters and an exact cursor (:259–303); the For You rails use ProjectCard rail + SectionHead + Rail (ForYouPanel.tsx:74–83)",
  "how": "a `made=1` query parameter on GET /posts and a rank term `EXISTS (community_orders o WHERE o.id = p.community_order_id AND o.state='completed')` (optionally + count of community_order_updates kind='photo') in /posts/trending and trendingProjects — no new visibility predicate (§9.3 rule), consent already covers the photos; one more Reveal section «صُنع فعلًا / Made by the community» folded into useHomeData's composite (one extra orNull read, :70–79) with ProjectCard rail tiles; the posts' «Make it mine» verb appears only when design_id is set"
 },
 {
  "ask": "What the home hub absorbs without a new tab (the composer door «I want to create/customize something», My Designs, inspiration)",
  "existing": "QuickActions' four doors (QuickActions.tsx:21–24) — the primary «طلب طباعة» opens /requests?view=new; visibleSections numbering (ForYouPanel.tsx:138–147); the Tools section's «مكتبة ملفات الطباعة» comingSoon tile (Community.tsx:399–405); MyProjectsTab as the pattern for a personal tab (Profile.tsx:730); tests pin six tabs and real Sorani for every hub word (communityHubUi.test.ts:132,189)",
  "how": "keep six tabs; the visual creation path is the wizard's second starting method behind the same primary door (the brief says both methods create a normal request), so QuickActions stays four; add one numbered For You section (inspiration/made) and, for a signed-in person, «تصاميمي» as a lazy profile tab; swap the dead library tile for the designs entry if the owner agrees (Q: the tile is comingSoon today); every new string in hub/strings.ts and a designs/strings.ts with real Sorani; no new utility class (CSS headroom 0.5 KB gzip)"
 },
 {
  "ask": "reports / moderation of designs, blocks and mutes on every new door",
  "existing": "community_reports' closed target_type CHECK plus the 0160 side-table pattern (community_report_targets); postExclusionSql per list and blockedEither per door (communityPosts.ts:189–192; communitySocial.ts:86–92); the block matrix test (communitySocial.test.ts:303)",
  "how": "report a published design through its post (target_type 'post') and a private-but-shared design through a community_report_targets kind 'design' row; AND postExclusionSql/blockedEither into every design list and door from day one; admin hide of a design's post arrives with Phase 6's post hide route (§9.6), read-side already enforced"
 },
 {
  "ask": "3D preview of a design (rotate, tap regions) in the customer's browser",
  "existing": "src/pages/ModelViewer.tsx on ogl reads /viewer/:token + /mesh (:675, :695); viewerMesh/analyseModel in worker/lib/modelGeometry.ts; deriveModelPreview writes the private LVM (viewerGrants.ts:315–350); tests/bundleBudget.test.ts keeps vendor-webgl out of the initial payload",
  "how": "the Worker builds the design's LVM from the template + config server-side and stores it under a private prefix (a new MediaDomain segment or post-previews once published); before publication the owner's design page mints a token through a design-scoped mint route that resolves to the same mesh; after publication the post-file path serves it unchanged; the viewer stays the one lazy chunk (7.3 KB + vendor-webgl 15.3 KB shared)"
 },
 {
  "ask": "refusal words and strings for the new surfaces in ar/en/ckb",
  "existing": "src/lib/refusalStrings.ts (49 community/file/link codes, loaded on the first refusal; D6 real Sorani), the per-feature strings tables with the D6 test walking src/components/community/**/strings.ts",
  "how": "DESIGN_* codes (DESIGN_NOT_FOUND, DESIGN_NOT_REMIXABLE, DESIGN_TEMPLATE_UNAVAILABLE, DESIGN_CONFIG_INVALID…) in refusalStrings.ts and a src/components/community/designs/strings.ts in three languages; the composer's fieldOf(code) mapping pattern (ProjectComposer.tsx:222–230) for field-level refusals"
 }
]

GAPS:
["The «اطلب طباعة مثلها» / «اطلب طباعتها» doors (Project.tsx:297–298, PostCard.tsx:63) pass ?project=<id> and state.project, but Requests.tsx:104–110 reads only printLink/?link= and the wizard seeds only source_type 'link' (RequestWizard.tsx:228–230): the post → request door lands on an empty wizard today (survey §1.1 row 6 already lists it Missing).","No Open Graph / share card for /community/projects/:id or /u/:username (socialPreview.ts handles /p/<slug> and /community/store/<ref>/p/<slug> only): a shared design/project link unfurls as the generic app; the share kit (storeShareKit.ts) is store-owner-only.","community_posts.kind CHECK is closed (0153:51–52): a design cannot be a new kind without a rebuild; the design must be a project post + a nullable design_id column, and kind-keyed labels (hub strings kinds, creator tabs not_kind=project) will call it «مشروع مطبوع» unless a design flag drives the label.","viewer_grants.source_type CHECK ('product','post') and model_view_tokens.source_type CHECK ('request','product','post') are closed (0157:85, 103–104): a design that is not yet a post has no token table; a revocable share link needs its own small table.","Collections do not exist as rows: community_saves.collection is free text ≤40 with no UI (0154:44; SaveButton sends none; Saved.tsx one grid); §9.7 plans user_collections + collection_id — a «vault» of designs/logos/photos must not pre-empt that shape.","community_posts.view_count has no writer (the beacon is §9.7), so 'inspiration' cannot use views honestly yet.","No admin post hide/unhide route or UI (Phase 6 §9.6 pending); adminCommunity.ts hides products only; users have no status ladder (restricted/suspended/banned).","Store-follow notification switches (follows.notify_products/offers/updates, 0031:311–313) are written (merchantReviews.ts:394–410) but read by no sender; user_follows has no switches; there is no kind for «a maker/store you follow published something» and no fan-out path to followers.","community_orders has no serial and no design reference; the platform's serial system (order_item_units + device_serials, 0098 PART 7 forbids a second) is for store devices; a community-order serial is unbuilt.","No MediaDomain / upload purpose / placement for a design's generated snapshot or mesh (mediaStorage.ts:5–33; uploadEntity.ts:311–337); server-generated objects would use putMediaObject directly as deriveModelPreview does, but the prefix must be added to the union and (if public) to isAnonymousPublicMediaKey.","Sorani in notification rows is meta-only (stampGroupedCkb); user_notifications has no title_ckb column (Q5 open); the client kind union (src/lib/notifications.ts:28–43) lacks portfolio_consent/files_added/request_* and the bell defaults unknown kinds to a Bell glyph.","Post reads (/posts, /posts/:id, /feed, /my-posts) are never edge-cached — every guest read hits D1 through POST_COLUMNS' 5 joins + 5 correlated subqueries; a public designs gallery for guests has no cached reader to inherit unless it is built on anonymousCached with declared params from the start.","The request wizard has no chunk of its own: it lives in Requests-*.js (39.5 KB gzip, 98.8 KB closure); a visual creation path added inside it would grow the heaviest community chunk.","The browser acceptance today is narrower than the brief's bar: ckb runs one representative pass (360 dark) and reduced motion rides one theme/language pass (e2e-projects.mjs:159,168–170; e2e-community-home.mjs:66,75–76); no script covers /model-viewer.","Open owner questions still unanswered in docs/COMMUNITY_ECOSYSTEM.md §8: Q1 (closing the creator page hides projects?), Q2 (merchant_showcase works vs posts), Q3 (one follow or two for a store-owning creator — the feed already unions them), Q4 (draft pictures on a public prefix), Q5 (Sorani in notifications).","The composer (ProjectComposer.tsx) has no 'start from a design/template' input and PostInput has no design_id; the profile has a projects tab but no designs tab."]

RISKS:
["The tree is mid-edit by another workflow: community.ts (+67), notifications.ts (+41, new kinds + repeatActor), uploadEntity.ts (+122), marketplace.ts (+819), requests/api.ts (+362), adminCommunity.ts (+54), worker/index.ts (+8), migrations 0159–0161 and EXPECTED_MIGRATION=0161 are all uncommitted; any Programme C migration number is «next free at merge» (≥0162 and rising) and any edit to notifications.ts/uploadEntity.ts/requests/api.ts must be rebased on Phase 5's landing, not on HEAD.","CSS headroom is 0.5 KB gzip (59.5 of 60 over 8 files; the D7 rule is 'paid, not raised'): a design composer, bottom sheets and swatch pickers must reuse existing utilities (lv-button*, lv-choice, lv-input, lv-section, lv-hit, material, press-scale) and inline styles for anything novel (ComposerDock's pattern), or pay back bytes first.","dist/ is newer than HEAD (built 03:09 vs commit 01:49) and includes some uncommitted work; the budget test rebuilds when stale (bundleBudget.test.ts:153–174), so every number below moves slightly at merge.","Consent (D3) must not be bypassed by a design flow: a workshop publishing a design it printed for a customer's order must land in consent_status 'pending' through checkLinks' rule; a second visibility predicate for designs would violate §9.3's «no new visibility predicate» and the moderation-bypass test plan (§7).","Remix must never copy another owner's private key (logo/photo under users/<uid>/post-files/ or a future designs prefix): ownedFileObject's owner check and POST_FILE_NOT_OWNED are the model — the server strips personal fields from the copied config; a client-driven copy would leak keys.","Follower fan-out has no cap or queue: a publish by a 500-follower store would write hundreds of user_notifications rows inline (FOLLOWED_LIMIT 500 bounds the list, not the fan-out); use a queue row + cron drain (community_match_queue's pattern) and the grouped upsert per recipient.","Block/mute story: every new list must AND postExclusionSql and every new door must ask blockedEither and answer 404 (tests/communitySocial.test.ts:303 pins the matrix for posts); a designs gallery that forgets it leaks a blocked author's work.","Edge cache + wall: a guest-cached designs reader must declare its params (canonicalKey) and must never admit an unlisted/shared anchor into the shared cache (recommendForPost's refusal is the precedent); every design route mounted under /api/community inherits communityGate, anything mounted elsewhere needs requireCommunityOpen explicitly.","Viewer links are bound to IP+UA+day for guests: a 'shareable design link' implemented as a viewer_grants token would not open on the recipient's phone; the link must be the design's unlisted address and the recipient mints its own token.","The home closures already carry the animation FEATURES half: ForYouPanel imports useInView and Project.tsx imports motion from 'motion/react', so Community's closure beyond the initial payload is 70.4 KB (+ vendor-motion 15.7 KB shared) and FeedList's 90.5 KB; new home/design surfaces should render m.* under MotionFeatures and springs via useMotion() so the first paint of /community does not grow.","tests/communityHubUi.test.ts pins six tabs in the owner's order (:132) and real Sorani for every hub word (:189): a seventh tab or an Arabic placeholder in ckb fails CI; D6 (real Sorani) binds every new community string and refusal code.","POST_COLUMNS costs 5 LEFT JOINs + 5 correlated media subqueries per card; adding design joins to the same SELECT for every feed row would slow every list — read design facts through design_id lazily on the page, or one grouped read per page, not per row.","A design published as a project post inherits POST_NEEDS_MEDIA (≥1 picture) — the snapshot must be rendered server-side before publish or the publish is refused; deriveModelPreview is best effort (a failed mesh leaves has_preview:false), so «rotate» on a shared design can silently be absent."]

NUMBERS:
Built dist (2026-09-30 03:09, newer than HEAD 98dc0305 01:49 — includes some uncommitted code), gzip level 9 as tests/bundleBudget.test.ts measures:
- Entry index-DQ12qcUx.js 66.2 KB (budget 72); initial payload 182.8 KB over 4 files (budget 200); CSS total 59.5 KB over 8 files (budget 60 → 0.5 KB headroom): index 46.9, Auth 7.9, theme 1.5 + 1.2, ListingView 0.6, StoreDesignPanel 0.5, swatches 0.5, orderPrint 0.4.
- Community chunk 9.5 KB (31,316 B raw); own static closure beyond the initial payload 70.4 KB over 26 files (refusalStrings 22.5, hub strings 6.4, hub parts 6.1, social strings 3.6, merchant lib 2.5, CreatorCard 1.9, StoreCard 1.8, Tabs 1.4, ProjectCard 1.3, merchantRoutes 1.2, FollowUserButton 1.1, …) + shared vendor-icons 12.2 and vendor-motion (features) 15.7.
- Projects 3.2 KB (closure 12.8); Project 6.2 KB (closure 68.8 incl. refusalStrings 22.5, ActionRow 3.4, LinkCard 2.6, Menu 2.4, Sheet 2.2); ProjectComposer 8.8 KB (closure 53.0 incl. UploadTile 6.0, refusalStrings 22.5); Creator 5.0 KB (closure 68.2); Saved 1.2 KB (13.9); MyProjectsTab 1.4 KB (11.7); FeedList 3.2 KB (closure 90.5 — it statically reaches the Community chunk and vendor-motion 15.7); SearchOverlay 0.6 KB stub + 15,384 B raw lazy overlay chunk; ModelViewer 7.3 KB + vendor-webgl 15.3 (shared); Profile 12.0 KB (24.8); Requests 39.5 KB (closure 98.8; the wizard has no chunk of its own); AdminCommunity 41.6 KB; CommunityStorePage 4.5 KB.
- Strings per language: hub/strings.ts 94 keys (78 leaves + search 5 + tabs 6 + kinds 5; 336 lines), projects/strings.ts 126 (430 lines), social/strings.ts 78 (307 lines), search/strings.ts 144 lines, links/strings.ts 124 lines; refusalStrings.ts holds 49 community/file/link/search codes.
- Feed card (postCard) = 21 fields + viewer{liked,saved}: id, kind, title, excerpt(≤180), cover{url,kind,width,height}|null, media_count, author{id,username|null,name,avatarUrl}, store{id,slug,name,logoUrl,url}|null, product{id,slug,name,name_ar,price_iqd,url}|null, printer{name,product|null}, material{name,product|null}, color, print_time_minutes, dimensions{x_mm,y_mm,z_mm}, tags[], counts{likes,comments,saves,views}, state, visibility, published_at, created_at, url; POST_COLUMNS = 5 LEFT JOINs + 5 correlated media subqueries per row.
- Bounds: title 3–140, body ≤4000, media ≤12, tags ≤10×30, files ≤3, comment 2–2000 with 10 s cooldown, collection ≤40, SEARCH_QUERY_MAX 60, SECTION_MAX 12, COUNT_BOUND 200, FOLLOWED_LIMIT 500, /me/social ≤500 each, ACTORS_KEPT 50, viewer TTL 60 min, trending 30 d, recommend 180 d, home memo 2 min, pages: posts ≤48/def 18, feed ≤30/def 12, saved ≤48/def 18, creators ≤48/def 18, trending ≤24/def 12.
- Rate limits: post-create 20/h, post-edit 120/h, post-publish 30/h, social-like 240/h, social-save 240/h, social-comment 60/h, follow-user 60/h, social-block 60/h, report 20/h, viewer-token 60/h, post-file-download 120/h, community-search 120/min, store follow 60/h, community-request 10/h, upload-session 30/h.
- Edge cache: /trending public max-age=300 (no params); /search, /suggest, /recommend guest public max-age=60 with declared params; /access anonymousCached perViewer; no other community read cached.
- Migrations: 154 files; newest 0161_storefront_vitals.sql (0159–0161 uncommitted); EXPECTED_MIGRATION = 0161 (uncommitted) → next free ≥ 0162 at merge.
- Worker sizes: communityPosts.ts 1203 lines, communitySocial.ts 800, communitySearch.ts 803, community.ts 763, adminCommunity.ts 1691, viewerGrants.ts 350, notifications.ts 462, uploadEntity.ts 452, fileOwnership.ts 327, edgePolicy.ts 420, modelGeometry.ts 1065, search lib 2042. Client: community hub/feed/projects/social/pages 8,453 lines; ModelViewer.tsx 959.
- Tests: communityPosts 11, communitySocial 22, communitySocialUi 8, communityHubUi 10, communitySearch 15, communitySearchUi 11, postFiles 6, postFilesUi 9, uploadSessions 10, linkCards 14, linkCardsUi 11, communityGate 35; e2e-projects.mjs 200 lines, e2e-community-home.mjs 289 lines (both ar/en/ckb × dark/cream × 360/1280 with ckb one pass; reduced motion on one pass).
- Notification kinds in the union: 41 total, of which community-facing grouped kinds 6 landed (+4 uncommitted); bell glyphs mapped for 5 community kinds.
- Home first paint: 8 parallel reads (useHomeData) + the lazy feed; QuickActions 4 doors; For You up to 8 numbered sections; six tabs.

---

## Survey — merchant

# MERCHANT SURVEY — workspace, admin and money substrate (read 2026-09-30, tree with community Phase 5 + merchant P4/P5 uncommitted)

## 1. The workspace shell (what exists, where a new surface would live)

**Contract.** `packages/contracts/src/merchantRoutes.ts` — `MerchantSection` union of **20 sections** (`home orders products customers inbox coupons collections services showcase printers costing requests custom_orders money analytics reviews notifications store_design store_settings store_delivery`, L26-46), `SECTION_PATHS` (L49-72; `custom_orders = 'requests/orders'` — "a custom order is the job a request became"), `SECTIONS_WITH_ID` (L75-85: orders, products, customers, inbox, coupons, requests, custom_orders), `ID_RE` token rule (L93), builders `merchantHref.*` (L108-146) incl. `ordersInStatus`, `productsInStock`, `newProduct/newCoupon/newCollection`; allow-listed query words (L153-158: status ∈ six order statuses, stock ∈ low|out, state ∈ published|draft|hidden|archived, `new=1`). Stored notification links always `/merchant/…`; `hostPath` re-bases to `/admin` on a store host (L240-247).

**Nav.** `src/components/merchant/shell/nav.ts` — ONE table `NAV` (L102-128, 20 entries, every `capability: 'always'`), 10 groups (`overview sales catalogue workshop store money analytics reviews inbox notifications`, L89-100), phone tabs Overview·Orders·Products·Store + «More» (L131-136), `visibleNav(granted)` already takes a capability set (L145) — the P10 gating hook exists with one value. Badges only from attention sources (L173-195). Router: `routeTable.ts` (inbox/<id> and requests/<id> still go AWAY to `/chat/:id` and `/requests?request=`, L49-50; legacy `custom-orders` alias L41-43). Lazy registry `sections.tsx` (L41-111): every section its own `React.lazy`; `custom_orders`, `coupons` still mount `../dashboard/SalesTabs`; `collections/services/showcase` mount `CatalogTabs`; `printers` → `PrintersTab`, `costing` → `CostingTab` (opens the request on the main site with `&cost=1`, L85); `money` → `finance/MerchantFinance`; `store_design` → `storeDesign/StoreDesignPanel`.

**Frame.** `MerchantShell.tsx` (793 lines): sidebar ≥1024 / icon rail 640–1023 / phone bottom bar; palette and More sheet lazy (L83-84); «Operate | Design» Segmented in the desktop top bar (header). `MerchantDashboardPage.tsx` is the gate (store exists, right host). Context `context.ts` gives sections `me, store, canSell, base, href, mainHref, go, query, attention, reloadMe` (L11-34).

**Attention (the one read that feeds Today and every badge).** Client `shell/attention.ts` — `Attention` type L58-90: `orders{by_stage,first[]}`, `custom_orders{to_start,in_progress}`, `inbox{first[]}`, `notifications`, `requests{matching}`, `stock{low,out,first[]}`, `reviews`, `returns{open,first[]}` (read-only), `money{available,pending}`, `payouts{in_flight}`, `coupons`, `store.problems[]`, `setup{…}`, `speed?` (P4, present only after 3 poor days × ≥30 samples). Polls 90 s visible, 15 s min gap. Server `worker/routes/merchantWorkspace.ts`: `source()` wrapper (L119) — a failed source is ABSENT never 0; sources and their tables: orders (`orders` L178), custom orders (`community_orders` state funded/in_progress, L212-222), inbox (`chats`/`chat_messages` L225-245), notifications (`merchantUnreadCounts`), matching requests (`community_request_matches` ∧ no own offer, L269-281), stock (`community_products` with `LOW_STOCK_SQL/OUT_OF_STOCK_SQL` from merchantCatalog L153-157), reviews (`merchant_reviews`), returns (`return_cases` ⋈ `orders`, L329-341), money (`merchantBuckets`), payouts (`merchant_payouts` requested/approved, L362-370), coupons (`merchant_coupons`), store problems, setup (L387-392), speed (`readVitalsDays` + `speedAttention`, L417-422). Rate limits 120/min attention, 60/min search.

**The Counter (P3, landed).** `shell/sections/CommandCenter.tsx` (610 lines): `StatusStrip` (store mark, hours sentence from `worker/lib/storeHours.ts`, pause switch → `PATCH /api/merchant/store`), `PulseRow` (open · published · speed slot; `const speed: PulseLine | null = null` at L212 — the P4 line is not yet wired even though the server source exists), ONE queue of tickets built from the attention fields (L106-134: orders×3 stages, custom start/progress, inbox, requests, stock out/low, returns, reviews new/unanswered, money available, payouts in flight, coupons ending), first rows under a ticket with the action ON the row (confirm order → `POST /orders/:id/status`; restock → `PATCH /products/:id` via lazy `RestockSheet`, L70), week KPIs from `kpis.ts` (sliced from `/api/merchant/analytics/report`, never recounted), `QuickDock` = 4 doors (new product, reel if community `may_enter`, cover, design; `counter/QuickDock.tsx` L40-45), `SetupChecklist`. Strings: `counter/strings.ts` carries real ckb (0 «OWNER: Sorani» markers) — the D6 model; shell 16, catalog 159, finance 79, share 27 markers still outstanding.

## 2. Catalogue (Products · Collections · Services · Showcase)

Routes `worker/routes/merchantCatalog.ts`: `GET/POST /products`, `/products/stats`, `/products/export.csv`, `/products/import`, `/products/bulk`, `GET/PATCH/DELETE /products/:id`, `/duplicate`, `/insights`; collections CRUD + membership (L1284-1383). Product write gate `worker/lib/catalog/product.ts` `readProductInput` reads exactly: `attributes collection_ids colors condition delivery_methods featured images lifecycle low_stock_threshold media name options prep_days price_iqd section_id state stock track_stock variant_model` (L283-434). **Printed-product facts already exist** as first-class columns: `community_products.material / print_technology / color / finish / dim_x/y/z_mm / weight_g` (0126:65-77) normalised by `packages/catalog/src/attributes.ts` `Attributes` (L43-52; closed `TECHNOLOGIES`, `FINISHES`, swatch keys). Variants: `community_product_variants` (0126) — up to 3 option groups, price override, stock, sku, image, `low_stock_threshold`; product stock = Σ variants by trigger. Private products (0152): `audience_user_id, origin_chat_id, origin_offer_id, custom_expires_at` — a per-customer product born from an offer already exists (the seam for «personalised version → cart»). Files: `product_files` (0157) roles `preview | download_after_purchase | reference | instruction | source_model`, kind `model|document|image|archive`, `analysis` JSON, `preview_key`; grants `product_file_grants(product_file_id,user_id,order_id,community_order_id,expires_at,downloads)`; editor `catalog/ProductFilesEditor.tsx` (lazy chunk 2.7 KB) through the Phase 4 UploadTile (purpose `product_file`). Editor `ProductEditorSheet.tsx` (534 lines): basics visible; sections on demand — options & variants, pricing & inventory, description & category, **«3D-printing details»**, collections, files. `MediaEditor` 12 media / 2 videos. `CollectionsManager`: manual + automatic (featured / new / best-selling). Services `merchant_services` (0036) kind CHECK `print_service|design|finishing|scanning|repair|other`, `price_from_iqd`, `price_unit`, `materials`; Showcase `merchant_showcase` kind `printer|material|work`. Stock predicates: `LOW_STOCK_SQL` (threshold default 5, variant-aware) / `OUT_OF_STOCK_SQL` (merchantCatalog.ts L153-157). Low-stock notice `worker/lib/catalog/lowStock.ts` fires only on the crossing write.

## 3. Workshop (Printers · Costing · Requests) — the capability and cost substrate

**Printers** `merchant_printers` (0045:79 + 0078:124-137): `technology fdm|resin, build_x/y/z_mm, nozzle_mm, materials[], colors[], multicolor, enclosed, hardened_nozzle, quality_max, machine_hour_iqd, availability available|busy|offline, model_id → printer_models, purchase_iqd, purchase_date, residual_iqd, useful_print_hours, maintenance_iqd_per_hour, electricity_iqd_per_kwh, labor_iqd_per_hour, hours_printed, multi_material, toolhead_count`. Route `merchantPrinters.ts` `GET/POST /printers`, `PUT/DELETE /printers/:id` (economics accepted under `body.economics`, L69-96), `GET/PUT /material-stock`, `GET/PUT /request-prefs`, `GET /request-matches`. **Stock** `merchant_material_stock` (0132:109): merchant × `material_id` × `color_hex` → `grams` (no price column); `PUT` REPLACES the shelf (DELETE + INSERT with fresh ids, L440-451) and re-matches; empty shelf needs `untrack:true`. **Prefs** `merchant_request_prefs` (0045:122 + 0159): `processes, materials, colors, capabilities (multicolor|large_format|high_detail|functional|flexible|cf), governorates, delivery, min/max_job_iqd, min/max_size_mm, workload light|normal|busy|full, paused, paused_until, turnaround_days, technologies, max_build_mm, workshop_intro`. **Matcher**: `worker/lib/eligibility.ts` pure `evaluateEligibility` over dimensions `trade|capability|stock|reach|preference` with closed `REASONS` (L73-92); `printMatchingStore.ts` persists verdicts in `community_request_matches` (0045:205 + 0132: `revision, reasons, printer_id, notify_ok, engine, computed_at`) and queues re-matches (`community_match_queue`); `printMatchingScore.ts` ranks (admin-tunable `printMatchWeights`). **Costing** `merchantWorkshop.ts` `POST /requests/:id/cost` (L233-…): reads the request's model from `community_request_files`, the merchant's printer (`loadMerchantPrinters`), material from `print_materials` (density; `default_iqd_per_kg`; `product_id → products` = the filament SKU), quantity from `community_requests.quantity`, then `analysisStatements` → `print_analyses` and `quoteStatements` → `print_quotes` (0078: `base_cost_iqd, failure_reserve_iqd, true_cost_iqd, price_iqd, profit_iqd, margin_percent, markup_percent, break_even_iqd, waste_grams, machine_hours, snapshot, state draft|offered|accepted|expired|withdrawn, request_id, merchant_printer_id`). `GET /requests/:id/costs` lists them; `CostingTab.tsx` compares every printer WITH reasons ("§22: the screen the customer must never see"); `workshop/CostingSheet.tsx` «استخدم هذا كعرضي». **Engine B** `worker/lib/printQuote/cost.ts` `priceJob(PricingInputs)` (L225-282: analysis, printer, materialPrices, electricity, laborIqdPerHour, machine/maintenance overrides, laborTasks, packagingIqd, overheadIqd, platformFeeIqd, risk, `hardware{iqd}`, targetMarginPercent, minimumJobIqd, rushMultiplier, quantity) → `QuoteResult` with `CostLine[]` over `CostComponent` (`model.ts` L174-…: MODEL_MATERIAL, SUPPORT_*, PURGE, PRIME_TOWER, BRIM_RAFT, OTHER_WASTE, ELECTRICITY, DEPRECIATION, MAINTENANCE, LABOR, POST_PROCESSING, PACKAGING, OVERHEAD, PLATFORM_FEES, **HARDWARE**, FAILURE_RESERVE) and `machineIqdPerHour()` from purchase/residual/useful hours (`printers.ts:197`). **Public shape** is only the closed `Estimate` contract (`worker/lib/printEstimate/contract.ts`; DECISIONS 174) — no `lines/cost_/floor_/margin_` ever leave. **Accessories** = admin setting `printAccessories` (`worker/lib/printAccessories.ts` `PrintAccessory{id,name_ar/en/ckb,unit,cost_iqd,category magnet|motion|electronics|fastener|finishing,active}` L48-58; served by `GET /api/print-quote/accessories` under `anonymousCached`) — priced per piece as the HARDWARE line; **not linked to store products or variants** (no `product_id`).

## 4. Store builder & speed (P4 status as landed in the tree)

`storeDesign/StoreDesignPanel.tsx` `type Tab = 'sections' | 'theme' | 'page' | 'history'` (L80), TabStrip L428-441 — **no speed tab yet**. Untracked `storeDesign/speed/api.ts` (155 lines) is the only client piece (Bucket/Verdict/VitalName types, 7|28 days). Server landed (uncommitted): `storeLayout.ts` `GET /speed` (L794), `GET /speed/report` (L829); `storefrontEvents.ts` `POST /vitals` (L251); `worker/lib/storeSpeed.ts` (MIN_SAMPLES 50, ATTENTION_POOR_DAYS 3, ATTENTION_MIN_SAMPLES 30); migration `0161_storefront_vitals.sql` (`storefront_vitals_daily` PK (store_id, day, device) with good/ok/poor buckets per vital; `storefront_vitals_marks` once per visitor/day). Attention `speed` source wired server-side (merchantWorkspace.ts L417-422) and typed client-side, but CommandCenter L212 still passes null. Chunk today 38.8 KB own / 71.7 KB closure — the heaviest workspace screen.

## 5. Analytics

One route `GET /api/merchant/analytics/report?from&to` (`merchantAnalytics.ts` L77; ≤366 Baghdad days): traffic (beacon dailies), orders (live, cancelled excluded), funnel, products top/least/most-viewed, customers, coupons, governorates, **requests** (matching decisions, notifications, offers sent/accepted, custom orders completed), `previous` only where both periods have a source. Screen `shell/sections/AnalyticsSection.tsx` (662 lines) + in-house SVG `analytics/charts.tsx` (no chart library; pinned ≤16 KB). PLUS-gated ("the analytics are PLUS"). Chunk 10.8 KB own / 15.1 KB closure.

## 6. Money — how it moves today

**Merchant ledger** `merchant_ledger_entries` (0121; append-only by triggers): buckets `pending|available|reserved|paid`, kinds `sale_gross commission delivery_fee refund commission_refund delivery_refund escrow_release adjustment release payout payout_reversal` with a sign/bucket/link CHECK matrix (0121 DDL) — e.g. `commission` must be < 0 with `order_id` OR `escrow_id`; `escrow_release` > 0 in `available` with `escrow_id`; `adjustment` any sign, note ≥ 3. Writers are all in `worker/lib/merchantLedger.ts` (header L15-26): `storeSaleLedgerStatements` (store checkout → pending), `releaseOrderCreditStatements` (receipt or 3-day release), `reverseOrderCreditStatement` (cancel), `escrowCreditStatements` (custom order → **two lines straight into available**: `+gross escrow_release`, `−commission`, event keys `escrow:<id>:<release|partial>:<gross|commission>`, guarded by "the customer's debit posted", L356-405), `adjustMerchantBalance` (admin), payouts (`requestPayout` reserves available→reserved; approve/paid/fail/`recordAdminPayout`). Balance = `merchantBuckets` SUM (L120). Fences abort a batch by inserting a 0-amount line the CHECK refuses (L417-419). Finance routes `merchantFinance.ts`: `GET /finance/summary`, `GET /finance/ledger?cursor&kind&from&to`, `GET/POST /payouts`, `POST /payouts/:id/cancel`; payouts refused while suspended (`MERCHANT_SUSPENDED|STORE_SUSPENDED`, L128-134). `merchant_payouts` states `requested|approved|paid|failed|cancelled`, `method_snapshot` frozen from admin `payoutMethods`.

**Commission** `worker/lib/merchantOps.ts` `feeFor(db, 'store'|'request', gross)` → `splitFee` (L114-186): admin settings `communityFeeRequestPercentX100` / `communityFeeStorePercentX100` (default 500 = 5 %) and `communityFeeMinIqd`; snapshot on the row, never recomputed. Store: commission on goods only, delivery credited whole (`storeOrders.ts` L427-432). Custom: at acceptance `total = price + fee` (offer's `delivery_fee_iqd`, 0159), split on the total, `community_orders.price_iqd = total` (`marketplace.ts` L2190-2209).

**Escrow** `worker/lib/escrowOps.ts` (889 lines) over `community_escrows` (0031: `community_order_id UNIQUE`, `gross_iqd`, `platform_fee_iqd`, `merchant_receivable_iqd`, `released_iqd`, `refunded_iqd`, state `pending|held|released|partially_refunded|refunded|disputed|cancelled`, `hold_id`; CHECK fee+receivable=gross, released+refunded ≤ gross) and `community_escrow_events` (kind CHECK `created|held|release|refund|dispute_open|dispute_resolve|cancel`, `idempotency_key UNIQUE`). The hold IS a `wallet_holds` row (kind `purchase`, atomic availability inside the INSERT, USD cents at a snapshotted rate; floored dinar question). Operations: `reserveEscrowFunds` (L233) → `escrowRecordStatements` in the acceptance batch (marketplace.ts L2238, L2332) or `releaseEscrowReservation` on failure (L2358); `releaseEscrow` (L540: only from `held` for non-admins, `held|disputed` for admin; optional `orderStates` guard inside the UPDATE; commits the hold in full, credits the merchant via `escrowCreditStatements`, suspension fence unless admin; `released_iqd = gross_iqd` — **no partial release to the merchant exists**); `refundEscrow` (L678: full = release the hold, no ledger lines; PARTIAL = commit hold in full, `wallet_transactions` deposit back to the customer `wtx_escrow_refund_<id>`, merchant credited the kept gross with `partialRefundCommission` L643); `disputeEscrow` (L853: `held → disputed`, moves no money). One payee per escrow (`merchant_id`), one hold per order (UNIQUE) — no split, royalty or milestone seam. Callers: customer confirm (marketplace.ts L2628), dispute (L2697), cancel (L2833), auto-confirm sweep `communityRequests.ts` L520-560 (`confirm:<orderId>` key, actor `system`, skips suspended), admin `POST /api/admin/community/escrows/:id/resolve` (`adminCommunity.ts` L1283, `requireFinancialScope`, decision `release|refund|partial_refund` with `amount_iqd`, only from dispute, key `admin:<decision>:<escrowId>`).

**Community order state machine** `community_orders.state` CHECK `accepted|funded|in_progress|merchant_marked_delivered|customer_confirmed|completed|disputed|cancelled|refunded` (0031) + `request_revision, request_snapshot, contact_snapshot` (0130) + `ready_at, started_at` (0160). Transitions: `accepted→funded` (communityRequests.ts L733), `→in_progress` (`POST /orders/:id/start`, marketplace.ts L2489/L2509), `→merchant_marked_delivered` with `auto_complete_at` (L2544/L2560; `communityAutoCompleteDays` default 7), `→customer_confirmed` (L2591/L2619) then release, `→disputed` (L2675/L2711), `→cancelled` (L2783/L2815), `→completed` (communityRequests.ts L286). Merchant client `src/lib/merchant.ts` `communityOrdersApi` (L409-425: list/get/start/delivered/confirm/dispute/cancel); merchant screen = `SalesTabs.CustomOrdersTab` (L605-776) with buttons per state. **Timeline (0160, landing)** `community_order_updates` kind `started|progress|photo|ready|note|modification_request|delivered` + `file_key`; routes `POST /api/marketplace/orders/:id/updates`, `GET …/timeline`, `GET …/updates/:uid/file`, `POST …/report` (`communityOrderTimeline.ts` L272-513); «ready» stamps `ready_at` only, moves no state/money; each update posts a `custom_order` card into the deal's chat (`chatCards.ts` `customOrderCard` L274; cards live on `chat_messages.card_type/card_ref/card_snapshot/card_event_key` 0150).

**Store orders** `orders` (0001: six `status` values; `merchant_id`, `store_id` 0030; `stage` machine `worker/lib/orderStages.ts`; `delivery_tracking_no` 0028) / `order_items` (0001 + `community_product_id`, `seller_type`, `variant_id`, `sku_snapshot`, `pricing_snapshot`, `cost_iqd` + `cost_basis 'unrecorded'` 0095, dimensions/weights 0099, bundle parent/component 0058). Merchant moves through `applyMerchantOrderMove` (`POST /orders/:id/status`, `POST /orders/bulk-status` ≤50, DECISIONS 176); money: `storeSaleLedgerStatements` → pending, released by receipt or `STORE_RELEASE_DAYS = 3` (`storeOrderOps.ts` L60) unless `openDisputeSql`; cancel `cancelStoreOrder` reverses credit, refunds wallet, revokes file grants (row 177), restores `community_products.stock` (L425). Checkout deducts `community_products.stock/sold_count` and `community_product_variants.stock` after fences (storeOrders.ts L1024-1043). Order screen timeline `merchantOrders.ts` events `placed status cancelled refunded receipt_confirmed credit_recorded credit_released release_due dispute_opened dispute_closed ledger_adjustment chat_started` (actors as roles). History `order_status_history(stage,status,source,changed_at,changed_by,note)` (0028).

**Returns / complaints / invoices.** `returns.ts` states `requested→assessment→approved|rejected→collection→received→inspected→resolved` (L90-103), admin-only transitions (`/admin/:id/transition`), wallet refund idempotent; merchant sees them read-only via attention `returns` + Today ticket. Complaints: `community_complaints` via admin `/complaints*`; `dispute_opened/resolved` notices forced on. Invoices `worker/lib/invoices.ts`: Levonis customer invoice at checkout, `GET /api/invoices/mine|:id|:id/html`, admin `revise/resend` — **no merchant-issued invoice** (P7 plans it).

**Notifications to merchants** `worker/lib/merchantNotify.ts` `MERCHANT_KINDS` (18: `new_order order_needs_action new_message matching_request print_request_match offer_accepted offer_stale offer_rejected low_stock new_review dispute_opened payout_available payout_paid payout_failed balance_reversed dispute_resolved coupon_ending store_status_changed`, L57-76), `KIND_PREF` switch map (L112-140: new_orders, new_messages, request_opportunities, low_stock, new_reviews, complaints (forced), payouts, marketing, system_alerts), `notifyMerchant` + `fanOutMerchantNotice`; every link is a `merchantHref` address. Custom-order lifecycle notices `customOrderNotify.ts` (started/delivered/cancelled/disputed/`notifyEscrowResolved`).

## 7. Admin

`worker/routes/adminCommunity.ts` (1691 lines; mount `/api/admin/community`): overview, settings (fees behind `requireFinancialScope`), gate, merchants verify/status/badge, stores status, products/reviews hide, requests remove/list/detail, offers reject, reputation, complaints list/detail/status/messages, **escrows/:id/resolve**, merchants/:id/finance, reconciliation store-orders refund/reverse-credit, merchants/:id/payout, payouts approve/paid/fail, merchants/:id/adjustment, ledger/parity, reports (L91-1654). Client `src/components/adminCommunity/AdminCommunity.tsx` (2584 lines) tabs `overview merchants board disputes finance reputation settings print` + PayoutQueue/PayoutSheet/PrintPricingAdmin/PrinterModelsEditor; chunk 40.7 KB own / 81 KB closure. `Admin.tsx` mounts 29 lazy panels (AdminFinance, AdminInventory, AdminWalletRequests, AdminStoreSettings, …). Wallet admin ops in `wallet.ts` (`/admin/withdrawals/*`, `/admin/deposits/*`, `/admin/transactions/:id/adjustment`); `adminWalletAdjust.ts`; `orderPriceAdjust.ts` (admin price adjustments the customer accepts/declines — a **Change-Order-like seam for store orders**: `GET/POST /:id/price-adjustment`, `withdraw`, customer `accept|decline`).

## 8. Staff, quick replies, invoices — planned, not built

P10 (`docs/MERCHANT_PLATFORM_V2.md` §4.10, C.1 P10): `merchant_store_members(store_id,user_id,role manager|staff,invited_by,accepted_at,revoked_at)`, `storeForMember` + `requireStoreAccess` opt-in per route, `storeForUser`/`requireStoreOwner` unchanged as the only gate for money/payouts/settings/slug/delivery/design publish/staff/coupon create/exports; `/me.role + granted[]`; `Capability` gating in `nav.ts`; section `store_staff`; audit «by {member}» from `order_status_history.changed_by`. Today `worker/lib/merchantAuth.ts` exports `storeForUser` (L122), `requireStoreOwner` (L164), `requireSellingPrivileges` (L188), `requireOfferPrivileges` (L233) — one owner per store (`merchant_stores.merchant_id UNIQUE`, `community_merchants.user_id UNIQUE`). P7: `merchant_quick_replies` + `worker/routes/merchantQuickReplies.ts` (§4.3), thread inside the workspace (`routeTable.ts:49`), merchant invoice, Hours & Vacation card, returns card. P8: coupon scope, SEO, clips; P9: indicative workshop quotes, `machine_hour_iqd` into `priceForPrinter`; P11: engine convergence E10.

## 9. Tests and browser scripts that pin this substrate

`tests/merchantWorkspaceShell.test.ts` (16 tests: route table IS the contract; every nav entry lazy; badges never 0; no native dialogs; no invented Sorani; never a tier string), `workspaceUi.test.ts` (Counter table ar/en/ckb; tokens only; zero rows; sources), `merchantWorkspaceApi.test.ts` (attention isolation, absent-never-0, links real), `merchantRoutes.test.ts`, `merchantWorkspaceFocusRows.test.ts`; money: `escrow.test.ts`, `communityEscrowDecisions/Review.test.ts`, `merchantLedgerFlows/Schema/Backfill`, `merchantPayouts/PayoutRequests`, `payoutMerchantDebt`, `suspendedMerchantMoneyHold`, `storeOrderCancel/Release/MoneyReview`, `returnsLedgerRestore`; catalogue `catalog*.test.ts`; workshop `printer*.test.ts`, `printQuote*.test.ts`; `bundleBudget.test.ts` (shell 25 KB / closure 32 KB / Today 18 KB / analytics 16 KB / order 12 KB / CSS 60 KB / entry 72 KB / initial 200 KB; `WORKSPACE_SCREENS` 21 names each a chunk, none static in the shell or a storefront page). Playwright: `scripts/e2e-merchant-workspace.mjs` (360/768/1280 × **ar/en only**, no ckb, no reduced-motion), `e2e-merchant-w3b.mjs`, `e2e-workshop.mjs`, `e2e-store-builder.mjs`, `e2e-store-settings.mjs`, `e2e-admin-panels.mjs`, `e2e-wallet.mjs`, `e2e-order-fulfilment.mjs`.

## 10. WHERE PROGRAMME C's MERCHANT ASKS ATTACH (answers)

| Ask | Lives INSIDE | Keys on | Notes |
|---|---|---|---|
| Production Board (Part 5 #32) | **Orders** group, the existing `custom_orders` section (`/merchant/requests/orders`) rebuilt as its own lazy chunk (as OrdersList replaced SalesTabs.OrdersTab in P3b); a `?view=board` query word added to the contract's closed list | `community_orders.id` (custom) and `order_items.id` (store lines of customizable products) | Columns = the existing states (`funded`=Review/Approved, `in_progress`, `ready_at`=Ready, `merchant_marked_delivered`…) plus an additive `production_jobs` row per key holding printer_id/queue/QC; the "Printing/Assembly/Finishing/QC" sub-stages are update kinds already in `community_order_updates` (progress/photo/ready/note) — extend that table's kind list only via a new table or JSON, see risks |
| Production job | additive table referencing `community_orders(id)` OR `order_items(id)` (one of the two NOT NULL), `merchant_id`, `printer_id → merchant_printers`, `analysis_id → print_analyses`, `quote_id → print_quotes` | as above | `print_quotes.request_id` links costing to the request today; nothing links it to the order — the job row is that link |
| Build Recipe / BOM (Part 4 #16-18, Part 3) | **Products** — the ProductEditorSheet's existing «3D-printing details» section (attributes L43-52) + Files (`source_model`) grows a «What's used» sub-section; recipe rows keyed on `community_products.id` (+ optional `variant_id`) | filament lines `(print_materials.id, color_hex, grams)`; component lines `(products.id \| community_products.id, variant_id, qty, required, customer_selectable, price_behaviour)`; hidden production lines | Internal cost = `priceJob()` over the recipe (grams → MODEL_MATERIAL via `loadMaterialPrices` rungs incl. the merchant's own filament SKU `print_materials.product_id`; machine hours × `machineIqdPerHour` from `merchant_printers` economics; LABOR from `labor_iqd_per_hour`; components as `hardware{iqd}` → HARDWARE; PLATFORM_FEES from `feeFor`) — never through the public `Estimate` |
| Material reservation (Part 4 #34) | Printers/Stock tab (`MaterialStockSection`) + job row | `merchant_material_stock(merchant_id, material_id, color_hex)` grams; reservations as an additive ledger keyed on the natural key, not the row id | `PUT /material-stock` deletes+reinserts rows with new ids (merchantPrinters.ts L440-451) — a reservation FK to `id` would orphan; reserve = Σ(open jobs) shown against grams; reconcile on `ready`/`delivered` update |
| Machine assignment (#33) | Board card / job row | `production_jobs.printer_id`; suggestion = `community_request_matches.printer_id` (the verdict's printer, 0132) or the costing's `merchant_printer_id` | `merchant_printers.availability` exists; queue depth = COUNT(open jobs by printer) |
| Batch (Part 5 #1) | Board («combine») | additive `production_batches` + `batch_jobs(job_id)`; compatibility from `print_analyses` (bbox, plate_count, pieces_per_plate) + printer build volume + material/colour | never merges orders — mirrors DECISIONS 176 (a batch is the single transition repeated) |
| Subcontract / overflow / split (#2-4) | Board card action → **Requests** flow | a `community_requests` row `created_by='merchant'`, `target_merchant_id` (0151 direct requests) whose customer is merchant A's user; B's offer → a second `community_orders` + escrow funded from A's wallet | customer's order untouched; A stays responsible; allocation table for split quantities is additive |
| Capability passport (#5) | Printers tab (facts) + Store settings (services) | `merchant_printers` + `merchant_request_prefs` (capabilities/technologies/max_build_mm/turnaround) + `merchant_services.kind` + `merchant_showcase` | already the matcher's input; new services (assembly, LED/NFC install, painting…) hit the `kind` CHECK — store as a JSON list column instead |
| Automation rules (#17) | Store settings (one card) with effects shown as Today tickets / board suggestions | additive `merchant_automation_rules(store_id, trigger, condition_json, action_json)`; consumers: a new attention `source()` (absent when none) | recommendation/draft only — the Counter already renders only server-decided rows |
| Asset library (#40) | Products → Files (owner's `product_files` + upload sessions over the owner's prefix) + saved offer templates | `product_files`, `community_offer_drafts` (per request×merchant today) → a store-level template table | list over `fileOwnership.ownedFileObject`; viewer grants for previews |
| Team permissions (#31) | P10 as specified (`store_staff`, `visibleNav(granted)`) | `merchant_store_members` | Production/Design/Finance roles are extra `Capability` values on the same seam |
| Milestone payments (#22) / split compensation (#11-12) | Money section (merchant) + admin finance | see risks — one hold per escrow, one escrow per order (UNIQUE), release is all-or-nothing to ONE `merchant_id` | modelled as one `community_orders` per milestone (each with its own escrow, all under one request/project) rather than a partial release; royalty as ledger lines needs a new kind (CHECK rebuild) or an `adjustment` pair keyed `escrow:<id>:release:royalty` |

REUSE:
[
 {
  "ask": "Production Board with job cards (Review/Approved/Waiting/Queue/Printing/Assembly/Finishing/QC/Ready/Delivered)",
  "existing": "community_orders state machine (funded→in_progress→merchant_marked_delivered→customer_confirmed/completed) + community_order_updates kinds (started/progress/photo/ready/note) + ready_at/started_at (0160) + the custom_orders section at /merchant/requests/orders (SalesTabs.CustomOrdersTab) + attention custom_orders source",
  "how": "Replace SalesTabs.CustomOrdersTab with a lazy `production/ProductionBoard.tsx` chunk in the SAME section (as P3b did for OrdersList), add `view=board|list` to the contract's closed query list, read community_orders + updates + an additive `production_jobs(id, community_order_id NULL, order_item_id NULL, merchant_id, printer_id, batch_id, stage, qc_json, created_at)`; sub-stages Printing/Assembly/Finishing/QC are job.stage, never new community_orders states"
 },
 {
  "ask": "Production job keyed on the order",
  "existing": "community_orders.id (custom, one job per order; request_snapshot/offer_snapshot immutable), order_items.id (store lines: community_product_id, variant_id, sku_snapshot, cost_iqd), print_quotes.request_id/merchant_printer_id (costing already linked to the request)",
  "how": "production_jobs row references exactly one of community_order_id / order_item_id (CHECK one NOT NULL) and optionally analysis_id/quote_id; created on funded (custom) or confirmed (store) by the existing transition functions (marketplace.ts start route, applyMerchantOrderMove) — additive statements in the same batch"
 },
 {
  "ask": "Build Recipe / BOM / «What's used in this product»",
  "existing": "community_products printed facts (material, print_technology, color, finish, dims, weight_g; Attributes), product_files role source_model with analysis JSON, ProductEditorSheet's «3D-printing details» section, print_materials (density, default_iqd_per_kg, product_id → filament SKU), community_product_variants",
  "how": "Additive `product_recipes(product_id, variant_id NULL, version, source_file_id → product_files, printer_requirements_json, steps_json)` + `recipe_lines(recipe_id, kind filament|component|hidden, material_id, color_hex, grams, product_id/community_product_id, variant_id, qty, required, customer_selectable, price_behaviour)`; edited inside the existing product editor section; duplicated with POST /products/:id/duplicate"
 },
 {
  "ask": "Real cost & profit / profit simulator / auto cost calculation",
  "existing": "worker/lib/printQuote/cost.ts priceJob(PricingInputs) → CostLine[] over CostComponent incl. HARDWARE and PLATFORM_FEES; machineIqdPerHour from merchant_printers economics; loadMaterialPrices rungs; feeFor for the platform fee; print_quotes columns; order_items.cost_iqd/cost_basis (0095); CostingTab (merchant-only shape)",
  "how": "A merchant-only route (requireStoreOwner) that builds PricingInputs from a recipe (grams/hours from print_analyses or stated grams via the /grams-quote path, components as hardware{iqd} from linked variant prices, platformFeeIqd from feeFor) and returns QuoteResult; render with the existing CostingTab table; write the chosen figure to order_items.cost_iqd (cost_basis 'recipe') — never through the public Estimate"
 },
 {
  "ask": "Components from the store catalogue with real prices, stock and slots",
  "existing": "products / community_products + community_product_variants (price, stock, sku, low_stock_threshold), printAccessories admin setting priced as HARDWARE, orderInventory reserve/deduct/restore lifecycle, storeOrders.ts stock deduction after fences",
  "how": "Add a flag column (additive) `usable_in_prints INTEGER DEFAULT 0` + `component_meta JSON` on community_products (and products if Levonis SKUs qualify); recipe component lines reference variant ids; cart/order lines for chosen components are ordinary order_items (bundle_parent_item_id from 0058 groups them under the printed line) so stock and money follow the existing lifecycle; keep printAccessories as the fallback rung when no SKU is linked"
 },
 {
  "ask": "Material reservation and low-stock impact",
  "existing": "merchant_material_stock (material × colour → grams, merchant-level), eligibility 'stock' dimension already excludes jobs the shelf cannot cover, low_stock notices (crossing-write rule), attention stock source",
  "how": "Additive `material_reservations(job_id, merchant_id, material_id, color_hex, grams, state reserved|consumed|released)` keyed on the NATURAL key (the PUT replaces stock row ids); GET /material-stock returns reserved Σ per line; feasibility subtracts reservations; reconcile on the job's ready/delivered update"
 },
 {
  "ask": "Machine assignment (manual or suggested)",
  "existing": "community_request_matches.printer_id (the verdict's printer), costing's merchant_printer_id, merchant_printers.availability, printerEligibility/printerFits",
  "how": "production_jobs.printer_id nullable; suggestion = the persisted verdict's printer or the cheapest eligible from CostingTab's comparison; queue = COUNT(open jobs) per printer shown on the printers list"
 },
 {
  "ask": "Batch optimizer",
  "existing": "print_analyses (bbox, plate_count, pieces_per_plate, print_minutes_per_plate, tool_changes), merchant_printers build volume, DECISIONS 176 (bulk = one transition repeated, never a merge)",
  "how": "Additive `production_batches` + `batch_jobs`; suggestions computed on the Worker from open jobs' analyses grouped by (printer, material, colour) with piecesPerPlate; accept writes batch rows only — orders untouched"
 },
 {
  "ask": "Merchant-to-merchant subcontract / overflow / split manufacturing",
  "existing": "community_requests.created_by + target_merchant_id + origin_chat_id (0151 direct requests), community_offers (v2 with files and drafts), community_orders + escrow per order, communityOrdersApi",
  "how": "A subcontract = a direct request authored by merchant A's user targeting merchant B, carrying the approved file/version and BOM in the request snapshot; B's accepted offer creates a second community_orders/escrow funded from A's wallet; an additive `job_allocations(parent_job_id, child_order_id, quantity, completed)` tracks split quantities; the customer-facing order never changes hands"
 },
 {
  "ask": "Merchant capability passport",
  "existing": "merchant_printers facts, merchant_request_prefs (capabilities, technologies, max_build_mm, turnaround_days, governorates, delivery, workshop_intro), merchant_services kinds, merchant_showcase, matcher dimensions",
  "how": "Extend merchant_request_prefs with additive JSON columns (finishing_services, assembly_services, delivery_zones, capacity_per_day) read by eligibility/ranking as new preference facts; new service kinds stored in a JSON tag list rather than the CHECKed merchant_services.kind"
 },
 {
  "ask": "Merchant automation rules (recommend printer, tag NFC orders, route large jobs, manual review above a value)",
  "existing": "attention source() pattern (absent when nothing), CommandCenter tickets and QuickDock, community_request_matches reasons, printer_id suggestion, applyMerchantOrderMove",
  "how": "Additive `merchant_automation_rules(store_id, trigger, condition_json, action_json, enabled)`; a new attention source `automation` lists suggested actions per job; actions are drafts (a suggested printer on the job card, a tag), never a status move"
 },
 {
  "ask": "Merchant asset library (templates, models, logos, recipes, saved offer templates)",
  "existing": "product_files under the owner's prefix, upload sessions (purposes product_file, offer, order_update, community), fileOwnership.ownedFileObject, community_offer_drafts, product_file_grants",
  "how": "A Files sub-view inside Products listing the owner's product_files across products (GET /api/merchant/files?role=source_model), plus an additive store-level `offer_templates(store_id, title, payload_json)` reusing the offer draft payload shape"
 },
 {
  "ask": "Merchant teams & permissions (Owner, Manager, Products, Orders, Production, Messages, Delivery, Finance, Design)",
  "existing": "P10 spec (merchant_store_members, storeForMember, requireStoreAccess), nav.ts visibleNav(granted) and Capability type, order_status_history.changed_by, merchantNotifications kind filter",
  "how": "Land P10 as specified, then add 'production' and 'design' to the Capability union and gate the board/recipe routes with requireStoreAccess(c, 'production'); money stays owner-only"
 },
 {
  "ask": "Milestone payments (Deposit / Design approved / Production started / Delivery)",
  "existing": "community_escrows (one per order, UNIQUE community_order_id; release all-or-nothing to one merchant), wallet_holds atomic hold/commit/release, partial REFUND machinery, community_orders per request",
  "how": "Model each milestone as its own community_orders row (+ its own escrow) under one request/project id (additive `project_id` column on community_orders), released by the existing confirm/auto-confirm paths; do NOT add a partial-release op — the hold cannot be split"
 },
 {
  "ask": "Split compensation / designer royalty",
  "existing": "merchant_ledger_entries kind CHECK matrix (commission < 0 with escrow_id; adjustment any sign with note ≥ 3), escrowCreditStatements two-line release, one merchant_id per escrow",
  "how": "Additive `escrow_splits(escrow_id, payee_merchant_id, share_x100)` read by escrowCreditStatements to emit, inside the same guarded batch, a negative 'adjustment' on the printer (event_key escrow:<id>:release:royalty_out) and a positive 'adjustment' on the designer (…:royalty_in) — no CHECK change; the finance summary gains a 'royalty' line by event_key prefix"
 },
 {
  "ask": "Approval lock / Change Orders / revision budget",
  "existing": "community_requests.revision + community_offers.request_revision (0116), community_orders.request_revision/request_snapshot (0130), community_order_updates modification_request, admin price adjustments (orderPriceAdjust.ts accept/decline), offer_stale notices",
  "how": "Production references community_orders.request_revision as the locked version; a Change Order = a new request revision + a customer-accepted price adjustment row modelled on orderPriceAdjust (additive table for community orders, server-computed delta, escrow top-up as a second hold)"
 },
 {
  "ask": "Proof of production / QC checklist / serial numbers",
  "existing": "community_order_updates photo/progress/note with file_key (0160), product_file_grants, serialInventory routes (worker/routes/serialInventory.ts) for Levonis devices",
  "how": "Photos already ride the timeline; QC = an additive `qc_checklists(store_id)` + `job_qc_results(job_id, checklist_id, results_json)` surfaced as a 'quality_checked' update kind (new table, not a CHECK change); serials as an additive `production_serials(job_id, serial)` referencing the job and the order"
 },
 {
  "ask": "Dispute evidence package",
  "existing": "community_escrow_events (immutable, idempotency keys), community_order_updates + timeline route (actor as role), community_complaints, chat cards, admin escrows/:id/resolve, Community Phase 6 staff read-only chat access (pending)",
  "how": "A read-only admin route composing the existing rows chronologically (escrow events, order updates, revisions, complaint messages, payment history) — no new store; schedule after Community §9.6 lands its chat-access door"
 }
]

GAPS:
["No production job, batch, allocation, recipe/BOM, reservation, QC, serial or automation table exists anywhere in migrations 0001–0161; nothing links print_quotes/print_analyses to a community_orders row (only to request_id).","merchant_material_stock has grams only — no price per gram/kg; filament cost comes from the quote engine's price rungs (print_materials.default_iqd_per_kg or the linked filament SKU), so «real cost» needs the engine, not the shelf.","Print accessories (magnets, motors, LEDs) are an admin setting priced per piece with no product_id — Part 3's «components from the store catalogue» has no link today; community_products has no «usable inside printed products» flag.","Escrow is one hold per order (community_escrows.community_order_id UNIQUE), one payee, release all-or-nothing (released_iqd = gross); partial machinery exists only as refund-to-customer. No milestone, split or royalty seam; no 'royalty' ledger kind (CHECK matrix).","Staff/roles (P10), quick replies (P7), merchant invoice (P7), thread-in-workspace (P7) are specified but unbuilt; merchantAuth has only owner gates.","P4 speed is half-landed in the tree: server routes, library, migration 0161 and attention source exist; the client has only speed/api.ts, StoreDesignPanel has no speed tab, and CommandCenter passes speed=null.","custom_orders and coupons still render from the old SalesTabs chunk (43.4 KB closure); SalesTabs.OrdersTab is kept only because three tests pin it — its CSS payback is still owed (DECISIONS 176).","The workspace Playwright script covers 360/768/1280 in ar/en only — no ckb run and no reduced-motion pass, below the stated acceptance bar.","Sorani debt in merchant string files: shell 16, catalog 159, finance 79, share 27 «OWNER: Sorani» markers; only counter/strings.ts is fully D6-compliant.","No merchant-side «services» beyond six CHECKed kinds (print_service, design, finishing, scanning, repair, other); assembly/electronics/NFC/painting/packaging services have no home except the JSON `capabilities` list of merchant_request_prefs.","No queue/capacity data: merchant_printers.availability is a manual tri-state and merchant_request_prefs.workload a manual word; «real availability» needs job rows first.","Analytics has no production or cost figures (requests block only counts matches/offers/completed orders).","Returns and complaints are admin-decided and read-only for the merchant; there is no merchant-initiated replacement-part or warranty flow tied to community orders (warranty.ts is Levonis devices)."]

RISKS:
["CSS headroom is ≈0.5 KB (59.5 of 60 KB gzip, and the rule says never larger than the previous phase): every new merchant surface must reuse existing utilities/tokens; a board with new column styling risks the gate.","CHECK-constrained enumerations (community_orders.state, community_escrows.state, community_escrow_events.kind, merchant_ledger_entries.kind/bucket matrix, merchant_services.kind, product_files.role, community_order_updates.kind, community_offers.state) cannot be widened by ALTER in SQLite; 'additive only' means new tables or JSON columns, never a table rebuild on an append-only ledger.","PUT /api/merchant/material-stock deletes and reinserts stock rows with fresh ids — any reservation keyed on merchant_material_stock.id is orphaned on the next save; key reservations on (merchant_id, material_id, color_hex).","The tree is mid-landing: merchantWorkspace.ts, merchantPrinters.ts, adminCommunity.ts, marketplace.ts, community.ts, storeLayout.ts, uploadEntity.ts, attention.ts, eligibility.ts, printMatchingStore.ts are modified and 0159/0160/0161 untracked; Programme C phases touching these files must be sequenced after community Phase 5 + merchant P4/P5 merge (next free migration ≥ 0162 at merge).","Today (CommandCenter) is pinned at 18 KB gzip with 'room for a line, not for a sheet'; new tickets/sources must be lines only, and any new sheet must be a lazy chunk like RestockSheet.","StoreDesignPanel is already the heaviest workspace chunk (38.8 KB own / 71.7 KB closure); a merchant template builder placed there would need its own lazy chunk and budget pin, not a fifth tab in the same module.","Adding a workspace section changes the contract (SECTION_PATHS, NAV, SECTIONS, ROUTE_TABLE, WORKSPACE_SCREENS, tests/merchantRoutes.test.ts) and the stored-link parser; the plan's own rule is 'inside Product / Project / Order / Production / Asset workspaces, no 40 nav items' — prefer view= query words on existing sections (the closed list in readWorkspaceQuery must grow).","Money rules that bind any milestone/split design: releases and refunds are conditional UPDATEs fenced inside one db.batch with the wallet debit; a suspended merchant is never paid except by an admin (DECISIONS 137); admin settlement only from dispute; commission is snapshotted at acceptance (never recomputed).","Upload purposes 'offer' and 'order_update' were removed in row 177 and re-added by the landing tree — a Programme C purpose (e.g. template model, brand kit) must be added with its consumer in the same phase or the review will strip it again.","The customer-facing Estimate contract forbids cost/margin words in any public payload (test scans the whole body) — every BOM/cost/profit route must be merchant-only (requireStoreOwner) and never reused by a customer screen.","Analytics is PLUS-gated and reads live orders; production/cost analytics added there inherit the gate and the 16 KB chunk pin.","P10's Capability gating touches nav.ts, sections.tsx and SectionFallback; landing Production/Design roles before P10 would fork the seam — schedule team permissions with P10, not ahead of it."]

NUMBERS:
Measured from the dist built 2026-09-30T03:09Z (newer than every src file — not stale), gzip level 9, via scratchpad/programme-c/measure-merchant.mjs:
- entry index-DQ12qcUx.js **66.2 KB** (budget 72); initial payload **182.8 KB** over 4 files (budget 200); 308 JS chunks
- CSS total **59.5 KB** over 8 files (budget 60; index-B6C-KbqL.css 46.9, Auth 7.9, theme 1.5+1.2, StoreDesignPanel 0.5, swatches 0.5, ListingView 0.6, orderPrint 0.4) → ≈0.5 KB headroom
- workspace shell MerchantDashboardPage **15.1 KB** own (budget 25), **25.2 KB** with its non-vendor closure (budget 32: Button 1.1, Menu 2.4, Sheet 2.2, Toast 1.9, localeNumber 0.5, merchantRoutes 1.2, money 0.3, useMediaQuery 0.4); shares vendor-icons 12.2 KB
- Today/CommandCenter **14.8 KB** (budget 18), closure beyond shell 17.8 (Switch, baghdadTime, Money, KpiTile); RestockSheet 1.1 KB lazy
- AnalyticsSection **10.8 KB** (budget 16), closure 15.1; OrderDetailScreen 7.2 (budget 12), closure 34.0; OrdersList 8.1 / 41.2; OrdersSection 1.0
- SalesTabs 10.2 / 43.4 (still serves custom_orders + coupons); CatalogTabs 9.1 / 53.8; ProductsManager 5.6 / 27.6; ProductEditorSheet 9.4 / 48.9; ProductFilesEditor 2.7 / 45.8
- PrintersTab **16.5 KB** / 49.1 closure (largest workshop screen); CostingTab 6.3 / 10.2; StoreDesignPanel **38.8 KB** / 71.7 closure (largest workspace screen; no speed tab yet); StoreSettingsTab 12.7 / 56.7; DeliverySettingsEditor 7.5 / 16.8
- MerchantFinance 9.3 / 16.1; MerchantInbox 3.0 / 9.7; NotificationsSection 4.6 / 10.8; ReviewsSection 1.8 / 29.3; CustomersSection 3.9 / 35.4; RequestsSection 2.5 / 46.8; CommandPalette 2.4; MoreSheet 0.9
- refusalStrings 22.5 KB (lazy on first refusal); vendor-charts 116.8 KB (never in the workspace); vendor-webgl (ogl) 15.3 KB; ModelViewer 7.3 KB
- Admin: AdminCommunity 40.7 / 81.0 closure; AdminFinance 21.8 / 23.7; Admin shell 8.9; Wallet page 14.1; Requests page 39.5 / 91.2
Counts: 20 sections = 20 NAV entries in 10 groups, 4 phone tabs; 21 WORKSPACE_SCREENS pinned; 154 migration files, highest 0161 (0159–0161 untracked); 18 MERCHANT_KINDS; 11 ledger kinds × 4 buckets; 7 escrow event kinds; 9 community_orders states; 7 escrow states; 8 return states; 5 product_file roles; 17 CostComponents (16 + FAILURE_RESERVE); 5 eligibility dimensions; commission default 500 x100 = 5 % (store and request), auto-complete default 7 days, store release 3 days, bulk-status ≤ 50, attention 120/min, FIRST_ROWS 2, STOCK lines cap STOCK_MAX_LINES, speed MIN_SAMPLES 50 / attention 3 poor days × ≥30 samples.
Source sizes: escrowOps.ts 889 lines, merchantLedger.ts 1228, walletOps.ts 2546, marketplace.ts 3108, adminCommunity.ts 1691, merchantCatalog.ts 1394, merchantPrinters.ts 668, merchantWorkshop.ts 463, merchantWorkspace.ts 557, merchantAnalytics.ts 435, merchantFinance.ts 199; MerchantShell.tsx 793, CommandCenter.tsx 610, PrintersTab.tsx 1709, SalesTabs.tsx 1089, StoreSettingsTab.tsx 1026, ProductEditorSheet.tsx 534, AdminCommunity.tsx 2584; merchant component tree 27,101 lines; 622 test files, 60+ e2e scripts.
Sorani debt markers («OWNER: Sorani»): shell/strings.ts 16, catalog/strings.ts 159, finance/strings.ts 79, share/strings.ts 27, orders/strings.ts 0, counter/strings.ts 0.

---

## Survey — rules

## 0. Ground truth at survey time (2026-09-30, HEAD 98dc0305 «Community Phase 4 + merchant P3», committed 01:49Z)

- Working tree is **not clean**: 39 modified + 13 untracked paths (+3,490/−228 lines). Untracked: `migrations/0159_offers_v2.sql`, `0160_request_discussion_timeline.sql` (community Phase 5, server half), `0161_storefront_vitals.sql` + `worker/lib/storeSpeed.ts` + `src/lib/storeVitals.ts` + `src/components/merchant/storeDesign/speed/` (merchant P4), `worker/routes/{requestDiscussion,communityOrderTimeline}.ts`, tests `offersV2/requestDiscussion/orderTimeline/storeSpeed/storefrontVitals`. Modified hot files: `worker/routes/marketplace.ts` (+819), `src/components/community/requests/api.ts` (+362), `packages/storeLayout/src/*` (blocks/schema/normalize/verify/tokens/defaults/starters/data — merchant P5 media keys), `worker/routes/storeLayout.ts` (+235), `worker/lib/storeLayout.ts`, `worker/lib/uploadEntity.ts` (+122, re-adds `order_update`/`offer` purposes with their consumers), `src/lib/refusalStrings.ts` (+113), `worker/lib/notifications.ts`, `worker/lib/printMatchingStore.ts`/`printMatchingScore.ts`, `worker/routes/merchantPrinters.ts`, `worker/routes/community.ts`, `worker/routes/adminCommunity.ts`, `worker/index.ts` (two new `/api/marketplace` mounts), `worker/lib/schemaVersion.ts`, `packages/contracts/src/ownership.ts`.
- **Community Phase 5 client half is NOT yet in the tree**: no `src/pages/community/Request.tsx`, no `src/components/merchant/orders/CustomOrderScreen.tsx`, no OfferComposer V2 (only `requests/api.ts` changed). So `RequestWizard.tsx`, `src/pages/Requests.tsx`, `src/components/print/MyRequestsList.tsx`, `dashboard/SalesTabs.tsx`, `StoreSettingsTab` («ملف الورشة») and `storefront/blocks/{Hero,Stats}` are about to churn.
- Migrations: 154 files, last `0161_storefront_vitals.sql` → **next free = 0162**; `worker/lib/schemaVersion.ts:46/66` pins name and count (154). Numbering has gaps by design (row §9.0: «next free at merge»). DECISIONS last row = **177** → next free row 178. Provisional numbers in `MERCHANT_PLATFORM_V2.md §C.3` (0156–0161, rows 170–178) are already stale — roles, not numbers, are the contract.
- Measured against `dist/` (built 03:09Z, newer than every source, i.e. the gate would NOT rebuild): entry 66.2/72 KB; initial 182.8/200 KB (4 files); **CSS 60,964 B of 61,440 B → 476 B headroom**; storefront closure 43.5/47 KB; workspace shell 15.1/25, closure 25.2/32; Today 14.8/18; Order 7.2/12; Analytics 10.8/16; document 1.9/4 KB.
- Box: 4 CPUs (`os.availableParallelism()` = 4), 16 GB RAM; Playwright 1.56.1 global (`/opt/node22/lib/node_modules/playwright`, NOT in package.json), browsers at `/opt/pw-browsers` (chromium-1194).

## 1. Every binding rule, with the test that enforces it

| # | Rule (source) | Enforcing test / gate (file:line) |
|---|---|---|
| R1 | No new wallet/escrow/chat/products/orders/request-marketplace/notification system; extend `community_orders`/`community_escrows`/`orders`/`chats`/`user_notifications`/`community_products`/`community_requests`/`community_offers` (D9; DECISIONS 166–177; V2 §C.5) | **Review-enforced only.** Structural backstops: every created table needs an owner in `packages/contracts/src/ownership.ts` (`tests/ownership.test.ts:33-38`), so a new table is a visible contract edit; core foreign writes list may only shrink (`tests/serviceBoundaries.test.ts:99-119`, `worker/OWNERSHIP.tolerance.json`) — but that scan covers `services/*` sources only (`:88-94`), not `worker/` |
| R2 | Additive migrations only, file number = next free at merge, one migration per phase named by role (`COMMUNITY_ECOSYSTEM.md:485-491`; V2 §C.3) | `scripts/migrate-check.mjs --twice` (fresh SQLite, second pass applies 0 files; deploy gate); `tests/schemaVersion.test.ts:30-45` (EXPECTED_MIGRATION = newest file AND count); `tests/fixtures/d1.ts:98,108` applies `migrations/` to node:sqlite in every DB test; `tests/ownership.test.ts`. NOTE `scripts/check-migrations-additive.mjs` is applied to `studio/drizzle` only (`tests/migrationsAdditive.test.ts:26`) and would reject `ALTER TABLE`, which root migrations use (0159 has 9 ALTERs) — root additivity is by review + migrate-check |
| R3 | Server-authoritative money and state: ids in, decisions on the server; client never chooses price/margin/customer_id/merchant_id (row 174; D2; row 176) | `tests/printEstimateContract.test.ts` (public body free of `cost_/floor_/margin_/lines`; `target_margin_percent` ignored for non-merchants), `tests/printQuoteRoutes.test.ts`, `tests/offersV2.test.ts` (`expected_total_iqd` → `OFFER_CHANGED`), `tests/merchantWorkspaceShell.test.ts:353-358` (client never reads a tier string), `tests/storefrontIsolation.test.ts:125-160` (merchant string never reaches style/HTML) |
| R4 | Every customer-facing refusal code has ar/en/ckb, ckb ≠ ar ≠ en, no code leaks into a sentence; every translated code is emitted by a listed source file; every customer door decodes via `apiRefusal`/`refusalText` | `tests/refusalStrings.test.ts:48-76` (three languages, ckb ≠ ar/en), `:106-225` (**sources list** — a new route emitting a translated code must be added to it or the key is an «orphan»), `:240-274` (DOORS list: `set…Error(err.message)` forbidden), `:434-454` (P5 codes must also be decoded by `storeDesign/refusal.ts`) |
| R5 | Real Sorani in every new feature `strings.ts` (D6; row 166 (٤)); pending row 169 extends D6 to merchant/storefront/journey folders. Shared primitives/shell may NOT invent Sorani: a ckb string must already exist elsewhere in `src/`, or the Arabic stands in under `OWNER: Sorani to be written by hand.` | Feature regime: `tests/workspaceUi.test.ts:75-99` (key parity ar/en/ckb, ckb ≠ en, placeholder parity, no OWNER marker), `tests/ordersListUi.test.ts:73-92` (≥ 90 % of ckb values carry Kurdish letters `[ەۆێڕڵڤگچپژیک]`), `tests/postFilesUi.test.ts:87-106`, `tests/refusalStrings.test.ts:64-76`. Primitive regime: `tests/uiPrimitives.test.ts:352-397`, `tests/merchantWorkspaceShell.test.ts:335-351` |
| R6 | Theme tokens only: no hex, no `dark:`, logical (RTL) utilities only, no native `confirm/alert/prompt`, no `fixed bottom-0` | `tests/uiPrimitives.test.ts:327-337` (primitives), `tests/workspaceUi.test.ts:109-117`, `tests/postFilesUi.test.ts:230-235`, `tests/ordersListUi.test.ts:278`, `tests/themeSystem.test.ts:17-31,64-81` (app-wide: theme-specific hex and any `dark:`; storefront/viewer canvas/farm scene out of scope), `tests/merchantWorkspaceShell.test.ts:318-333` (no native dialogs across `src/components/merchant/**` + `adminCommunity/**`), `tests/uiSystem.test.ts:171,181`, `tests/uiSystem.test.ts:85-96` (semantic `--color-*` tokens, `.lv-choice` cue) |
| R7 | Motion: every spring via `useMotion()` (`SPRING` = ui/move/sheet/momentum/rotate/quick, `CROSS_FADE` under reduced motion), `m.*` from `motion/react-m` under `<MotionFeatures>` in any first-paint/shell closure, never the `motion` proxy or `useReducedMotion` from `motion/react`, no invented `duration` | `tests/motionLazy.test.ts:118,157-200,221`, `tests/merchantWorkspaceShell.test.ts:298-313`, `tests/bundleBudget.test.ts:282-283,478-482,535` (`vendor-motion` features chunk never static in entry/shell/Today), `tests/workspaceUi.test.ts:123`; `src/lib/motion.ts:62-91`, `src/lib/motionFeatures.tsx:123` |
| R8 | Byte budgets (gzip level 9): entry ≤ 72 KB; any chunk ≤ 250 KB; initial payload (entry + static closure) ≤ 200 KB with a never-eager list; CSS total (sum of all `dist/assets/*.css`) ≤ 60 KB **and ≤ previous phase (D7)**; storefront closure ≤ 47 KB with `extra`/`tabViews`/`StoreDesignPanel`/`MerchantDashboardPage`/`vendor-charts` never static; workspace shell ≤ 25 KB / closure ≤ 32 KB, 21 named screens lazy and never in the shell or storefront; Analytics ≤ 16, OrderDetailScreen ≤ 12, CommandCenter ≤ 18 (no charts, no motion features, no `refusalStrings`, no `RestockSheet` static); CompareTray ≤ 8; document ≤ 4 KB, no HTML comments; dist must be fresh and built with `_headers` | `tests/bundleBudget.test.ts:52,54,73,75,77` (numbers, `gzipSync level 9`), `:153-181` (staleness by mtime; `before()` runs `vite build` when stale), `:197-207`, `:216-224`, `:244-284` (lazy-only list `:271-274`), `:286-325` (chunk-of-its-own list), `:381-423`, `:442-497`, `:507-540`, `:542-552`, `:564-575` |
| R9 | Every new surface is a lazy chunk; every nav screen lazy; shell/page never statically import a screen; one component per block type in `Storefront`/`tabViews`/`extra` | `tests/merchantWorkspaceShell.test.ts:64-84`, `tests/bundleBudget.test.ts:286-325,455-497`, `tests/storefrontBlocks.test.ts:145` |
| R10 | Anonymous public reads cached at the edge only through `anonymousCached(c, {params, perViewer?, lifetime?}, build)`: GET without session only, canonical key = origin + path + **declared** params sorted, `public, max-age=60, s-maxage=120, swr=600`, weak ETag/304, only 200 stored, `Vary: Cookie` when `perViewer`, session answers `private, no-store`; purge seams on writes (`pathsChangedBySetting`, `afterCommunityGateWrite`, `afterStorefrontWrite`) | `worker/lib/edgePolicy.ts:14-60,88-101,124,182-226,246-264`; `tests/edgeCachePolicy.test.ts`, `tests/edgeCacheLifetime.test.ts`, `tests/d1Waves.test.ts`, `tests/storefrontIsolation.test.ts`; 21 call sites in 9 route files today |
| R11 | Uploads only through the Phase 4 platform: closed purpose lists (`UPLOAD_PURPOSES` 12, `SESSION_PURPOSES` 7, `KEY_PURPOSES`), a purpose exists only with a consumer (row 177 (٦)), keys private and owned (`PRODUCT_FILE_NOT_OWNED`/`POST_FILE_NOT_OWNED`), SHA-256 verified server-side, ZIP bound 2000 entries / 8×, limits+quotas are admin settings (`uploadLimits`/`uploadQuotas`), grants written in the payment batch and revoked with the refund, shared viewer via `viewer_grants` (60 min) | `worker/lib/uploadEntity.ts:31-56`; `tests/uploadSessions.test.ts`, `tests/uploadSession.client.test.ts`, `tests/productFiles.test.ts`, `tests/postFiles.test.ts`, `tests/postFilesUi.test.ts`, `tests/productFilesUi.test.ts` (rows 172, 177) |
| R12 | 3D viewer = `src/pages/ModelViewer.tsx` on `ogl` (only 3D lib in root `package.json`; `studio/` is a separate workspace with `three`/`three-slicer`), fed by an LVM1 mesh the Worker builds (`viewerMesh(…, maxTriangles = 250_000)`), `vendor-webgl` lazy-only | `worker/lib/modelGeometry.ts:1006-1048`; `tests/modelGeometry.test.ts:409`; `tests/bundleBudget.test.ts:272,320`; `vite.config.ts:60-67` |
| R13 | Community gate: `communityRoutes.use('*', communityGate())` puts every `/api/community/*` route behind `admin_settings.communityGate` (closed on any unreadable value; admins always enter; user-id allow-list); only `/access`, `/my-store`, `/profile-status` are outside; routes elsewhere that START community trade mount `requireCommunityOpen` route by route | `worker/lib/communityGate.ts:47-114,190-237`; `worker/routes/community.ts:130-153`; `tests/communityGate.test.ts`; `src/pages/community/access.tsx` (client) |
| R14 | Visibility is the lists' own SQL, never a new predicate (`POST_PUBLIC_SQL`, `communityDirectoryVisible`, `requestBoardVisible`, `merchantBlockSql`); block = 404 everywhere but messaging; grouped notifications count people (`meta.actors`); feeds cursor `(published_at,id)` exact (D8); bounded sections ≤ 12 rows, counts ≤ 200, `likePattern`, ≤ 60-char queries | rows 165, 167 (١,٢), 168 (٢,٣); `tests/communitySocial.test.ts`, `tests/communitySearch.test.ts`, `tests/requestBoard.test.ts`, `worker/lib/feedCursor.ts` |
| R15 | Link cards: normalised URL, allow-list per hop, never hot-linked images, guest never triggers a fetch | row 173, 177 (٥); `tests/linkCards.test.ts`, `tests/linkCardsUi.test.ts` |
| R16 | Store «open now» derived at read time, no column, no cron | row 175; `tests/storeHours.test.ts`, `worker/lib/storeHours.ts` |
| R17 | Merchant bulk actions = the single transition repeated (≤ 50 ids, cancel excluded, `{done[], refused[]}`) | row 176; `tests/merchantOrdersBulk.test.ts`, `tests/merchantOrderStatus.test.ts` |
| R18 | Workspace: route table IS the contract (`SECTION_PATHS`), one nav table, `capability === 'always'` (pin to MOVE at P10), phone tabs closed list, unknown paths → Command Center, one Toaster, one scroll owner, threads still «away» (pin to move at P7) | `tests/merchantWorkspaceShell.test.ts:49-62,86-128,146-162,287-291`; `:119` (away pin), `:60` (capability pin) |
| R19 | Store layout registry: `BLOCK_TYPES.length === 27` (P6 → 28 with `reels`), closed keys/tokens/theme presets, media caps, keys verified against `file_objects` | `tests/storeLayoutSchema.test.ts:72,249,556`; `tests/storeLayoutRoutes.test.ts`, `tests/storeDesignEditor.test.ts`, `tests/storeLayoutMalicious.test.ts` |
| R20 | New tables need exactly one owner among the 29 `SERVICE_NAMES` (`community_*` → `marketplace`; `orders/order_items/cart_items` → `commerce`; `products/product_variants` → `catalog`; `chats` → `chat`; `user_notifications` → `notifications`; `file_objects/upload_sessions` → `files`; `admin_settings` → `config`; `storefront_vitals_daily` → `analytics`) | `tests/ownership.test.ts:33-52`; `packages/contracts/src/ownership.ts` (277 entries); `packages/contracts/src/subscriptions.ts:15-20` |
| R21 | Any new TEXT column whose name matches the media pattern (`image|photo|logo|…|_key$|_json$`) or defaults to `'[]'`/`'{}'` must be classified in `worker/lib/mediaRefs.ts` (`MEDIA_REFERENCE_SOURCES` or `NON_MEDIA_COLUMNS`) or the orphan sweeper refuses its destructive path | `worker/lib/mediaRefs.ts:709-717,808-851`; `tests/mediaReferences.test.ts` (builds the real schema from every migration) |
| R22 | Playwright acceptance: fixture page under `tests/browser/<name>.html` + `<name>-fixture.tsx` (API answered locally, `?page&lang=ar|en|ckb&theme=dark|light&viewer=`), served by `npx vite --port 4191` (4192 for the builder), driven by `scripts/e2e-<name>.mjs`: widths `[360, 1280]`, `colorScheme`, `reducedMotion: 'reduce'` on one axis (light pass / ckb pass), checks = no horizontal overflow, no page errors, landmarks, behaviour | `scripts/e2e-projects.mjs:17-23,158-170`, `scripts/e2e-community-home.mjs:65-76`, `scripts/e2e-store-builder.mjs:25-33`, `tests/browser/projects.html`, `tests/browser/projects-fixture.tsx:1-8`; Tailwind scans `tests/browser` (`src/index.css` `@source "../tests/browser"`) |
| R23 | Each phase: a DECISIONS row at the next free number + the doc section; `npm run check` → `npm run test:unit` (root 617 files + workspaces + Studio) → `migrate-check --twice` → `npm run build` + budget test → browser scripts → deploy only after the owner's word; `/api/health` reports schema drift | `package.json` `check`/`test:unit`/`build`; `scripts/test-all.mjs:44-50`; `.github/workflows/deploy-staging-code.yml:83-84,134`; `docs/PERFORMANCE_LOG.md:150-166`; `COMMUNITY_ECOSYSTEM.md:1000-1008` |
| R24 | Tailwind reads only `src`, `index.html`, `packages/storeLayout/src`, `tests/browser` (`source(none)` + four `@source`); every genuinely new utility class costs CSS bytes | `src/index.css:73,92-95`; row 168 (٦) |
| R25 | The customer never sees CAD/slicer/mesh vocabulary; the merchant gets the depth (brief; standing rule) | **No enforcing test today** (grep of `tests/` finds the words only in geometry/attachment suites) — gap G1 |

## 2. Seam files every phase touches (integrator-owned; the collision list)

`worker/index.ts` (95 `/api/*` mounts; 1,038 lines) · `worker/lib/schemaVersion.ts` (name + count per migration) · `packages/contracts/src/ownership.ts` (per table) · `src/lib/refusalStrings.ts` (1,695 lines) + `tests/refusalStrings.test.ts` sources/DOORS lists · `worker/lib/uploadEntity.ts` purposes · `worker/lib/notifications.ts` (kinds; P11 ckb) · `src/App.tsx` (1,066 lines; routes; V2 §C.4 «single-file PRs rebased last») · `packages/contracts/src/merchantRoutes.ts` + `src/components/merchant/shell/{nav,sections,routeTable}.ts` (P7, P10) · `worker/lib/mediaRefs.ts` classification · `worker/lib/edgePolicy.ts` purge seams · `docs/DECISIONS.md` rows. Practice already used: «files outside the listed ownership touched with one-line-scope edits, each forced by a seam the plan names» (`docs/PERFORMANCE_LOG.md:1066`).

## 3. Remaining phases and the files each owns

### Community (docs/COMMUNITY_ECOSYSTEM.md §9)
- **Phase 5 (in flight; §9.5, L693-794)** — landed uncommitted: 0159/0160, `worker/routes/{marketplace,requestDiscussion,communityOrderTimeline,merchantPrinters,community,adminCommunity}.ts`, `worker/lib/{printMatchingStore,printMatchingScore,notifications,uploadEntity}.ts`, `src/components/community/requests/api.ts`. Still to come per spec: `src/pages/community/Request.tsx` (route file replacing `/requests?request=`), OfferComposer V2 (`community/requests/*`), `src/components/merchant/orders/CustomOrderScreen.tsx` (replacing `SalesTabs` custom orders), `MyCommunityOrders`/`src/components/print/MyRequestsList.tsx`, `StoreSettingsTab` «ملف الورشة», `storefront/blocks/{Hero,Stats}` workshop facts, tests `offersV2/requestDiscussion/orderTimeline`.
- **Phase 6 (§9.6, L834-916)** — migration role `moderation_v2` (`users.status*`, `moderation_actions`, `moderation_appeals`, `merchant_metrics_daily`, `chat_staff_reads`); NEW `worker/routes/adminModeration.ts`, NEW `worker/lib/reputation.ts` (nightly badges → `community_merchants.badges_json`), shared `AUTHOR_VISIBLE_SQL` fragment threaded into `POST_PUBLIC_SQL`/comment/creator predicates (`worker/routes/{communityPosts,communitySocial,communitySearch}.ts` read side), `worker/routes/chats.ts` staff read-only door while `community_orders.state='disputed'` + `chatCards.ts` staff viewer + `recordStaffChatFileRead`, `worker/lib/printMatchingScore.ts` (reads `response_minutes`/`trouble_rate`), admin escrow resolve bumps `completed_orders`; client: admin moderation desk (`src/components/adminCommunity/**`), `/community/badges` page, badge chips on store hero/directory card/creator page, dispute desk links. Tests: `moderationV2`, `reputationV2`, `disputeEvidenceAccess`.
- **Phase 7 (§9.7, L918-971)** — role `analytics_collections` (`community_post_views_daily`, `community_post_view_marks`, `user_collections`, `community_saves.collection_id`); `POST /api/community/events` beacon on `worker/lib/storefrontAnalytics.ts`'s `recordStatements` pattern; `GET /api/community/me/analytics`; `/api/merchant/analytics/report` gains `community{}`; collections CRUD + `/u/<username>/collections/<id>`; `/activity` centre + `GET /api/notifications?kind=&cursor` (`worker/routes/notifications.ts`); draft product preview = lazy `PreviewSheet` in the **merchant catalogue product form** (`src/components/merchant/catalog/*`) off the storefront budget. Client: `src/pages/community/{Creator,Saved}.tsx`, save button Sheet, header bell.
- **Phase 8 (§9.8, L973-1008)** — sweep, no migration: cursor paging everywhere, lazy media, `content-visibility:auto` past 60 rows, 44 px targets, `aria-pressed`, strings test walking `src/components/community/**/strings.ts` + `refusalStrings.ts` (ckb ≠ ar for > 90 %), notification titles ckb (Q5), full verification list, deploy after the owner's word. (Its budget prose «entry 120 KB, initial 240 KB» is stale vs the test's 72/200.)

### Merchant platform v2 (docs/MERCHANT_PLATFORM_V2.md §C.1, L134-151)
- **P4 (in flight)** `src/lib/storeVitals.ts`, `worker/routes/storefrontEvents.ts`, `worker/lib/storeSpeed.ts`, `worker/routes/{storeLayout,merchantWorkspace}.ts`, `storeDesign/{StoreDesignPanel,speed/SpeedPanel,strings}.ts`, `shell/{attention.ts,sections/CommandCenter.tsx}`; migration `storefront_vitals` (= 0161). **P5 (in flight)** `packages/storeLayout/src/*`, `src/components/storefront/{StoreRenderer,StoreHeader,theme}`, `theme.css`, NEW `BackgroundLayer.tsx`, `blocks/{Hero,HeroVariants,Gallery,Reviews,extra}.tsx`, NEW `reels/ReelsViewer.tsx` (images mode), `storeDesign/{panels,fields,pickers,BlockInspector,catalog,refusal}`, NEW `counter/AnnouncementSheet.tsx`, `worker/routes/storeLayout.ts`, `worker/lib/{storeLayout,mediaRefs}.ts`, `src/lib/refusalStrings.ts`; no migration.
- **P6 «Doors and journeys» (XL, three PRs; no migration)** — `src/components/estimate/*` (lazy `estimate` chunk), `src/components/journey/*`, `src/components/storefront/{runtime.tsx,StoreHeader.tsx,HostBar.tsx(new),blocks/{Tabs,tabViews,Reels(new)}.tsx,reels/*}`, `src/components/community/requests/RequestWizard.tsx` (read-mostly; `RequestComposer` wraps it), `src/components/chat/commerce/PrintRequestSheet.tsx`, `src/pages/{Storefront,StorefrontProduct,Tools,Chat,OrderDetail}.tsx`, `src/components/OrderTracker.tsx`, `worker/routes/{chats,chatCommerce,storefront,orders,printRequests}.ts`, `worker/lib/{orderNotify,chatCards}.ts`; pins: `storeLayoutSchema` 27→28, `storefrontBlocks` file-per-type, `uiSystem` no `fixed bottom-0`; budgets: storefront ≤ 47 KB (HostBar ≤ 0.35 KB), `reels` ≤ 5 KB; new `scripts/e2e-reels.mjs`, `scripts/e2e-store-journey.mjs`; owner row 170 (autoplay) decides the viewer.
- **P7 «The Counter answers» (L, migration `counter_ops`: `orders.merchant_note`, `merchant_stores.away_until/away_message`, `merchant_quick_replies`, `merchant_customer_notes`)** — NEW `src/components/chat/ChatThread.tsx` (extracted from `src/pages/Chat.tsx`), `merchant/{inbox/MerchantInbox.tsx, shell/{routeTable.ts,sections.tsx,sections/ThreadScreen.tsx}, orders/OrderDetailScreen.tsx, customers/*, dashboard/StoreSettingsTab.tsx, counter/*}`, `worker/routes/{merchant,merchantOrders,merchantCustomers,merchantQuickReplies(new),invoices,chats}.ts`, `worker/lib/{merchantAuth,storeOrderOps,storeHours}.ts`, `worker/index.ts` mount; moves pin `merchantWorkspaceShell.test.ts:119`; owner Q3 (vacation), Q17 (invoices).
- **P8 «Clips, SEO, coupon scope» (M, migrations `store_reels` + `store_seo_coupons`)** — `worker/routes/{merchant,storefront,storeOrders,merchantFinance,merchantAnalytics}.ts`, `worker/lib/{socialPreview,mediaRefs,storeLayout}.ts`, `packages/storeLayout/src/{blocks,data,starters}.ts`, `merchant/dashboard/{CatalogTabs,StoreSettingsTab}.tsx`, `storefront/blocks/{Tabs,tabViews}.tsx`, `storefront/addressedView.ts`; owner rows 170/173, Q7.
- **P9 «Sources and workshops» (M, migration `customer_journeys`: `community_request_files.origin/source_url`, `print_analyses.origin_url`, `merchant_request_prefs.show_indicative_price`, `merchant_stores.responds_within_minutes`)** — `worker/routes/{printRequests,printQuote,merchantPrinters}.ts`, `worker/lib/{externalModels,fetchGuard,attachments,printQuote/*}.ts`, `worker/index.ts:818` cron, `src/pages/{Requests,Tools}.tsx` (reads `?project=`), `merchant/dashboard/PrintersTab.tsx` (1,709 lines), `adminCommunity/PrintPricingAdmin.tsx`; owner Q14/Q15.
- **P10 «Staff» (M, migration `store_members`)** — `worker/lib/merchantAuth.ts` (`storeForMember`, `requireStoreAccess` opt-in per route; money/payout/settings/slug/delivery/design-publish/staff/coupon-create/exports stay owner-only), NEW `worker/routes/merchantStaff.ts`, `worker/routes/merchant.ts:148-187` (`/me.role`, `granted[]`), `packages/contracts/src/merchantRoutes.ts` (`store_staff`), `shell/{nav,sections,SectionFallback}` (`Capability` gating), NEW `merchant/staff/StaffSection.tsx`; MOVES pins `merchantWorkspaceShell.test.ts:60,155,161,215`; new `tests/merchantRouteGates.test.ts` (enumerates every `/api/merchant/*` gate), `tests/merchantStaff.test.ts`; owner Q16.
- **P11 «After the churn settles» (M–L)** — `src/App.tsx` host routes `/chat/:id`, `/clips`, `/saved-items`; `worker/lib/notifications.ts` ckb; `posts` reels source (row 173/Q9) in `worker/routes/storefront.ts`; `src/components/community/**` hand-backs (ProjectCard video cover, `?project=` sender); `worker/lib/printPricing.ts` + `worker/lib/printQuote/*` engine convergence E10 (+ optional `print_materials.process`); `packages/storeLayout/src/{blocks,tokens}.ts` lookbook 28→29 only inside measured CSS payback; PSI from the Worker if Q6; phone tabs if Q1.

## 4. Proposed interleaving (two lanes on a 4-CPU box)

Constraints that shape it: (a) ≤ 2 workshops in flight at once — each builder's gate is `tsc`×3 + eslint + a 617-file suite + `vite build` (the budget test rebuilds when `dist/` is stale, `bundleBudget.test.ts:165-174`) and each Playwright run wants a vite dev server + chromium; the integrator's gate must run alone. (b) A Programme C phase is admitted only when its file set is disjoint from the lane-A phase in flight; seam files (§2) are edited by the integrator only, as one-line-scope edits. (c) CSS headroom is 476 B: every Programme C surface must reuse existing utilities or pay back first (D7), and every new surface is a lazy chunk.

| Wave | Lane A (existing programmes, in their published order) | Lane B (Programme C) | Why here |
|---|---|---|---|
| 0 | Finish + commit community Phase 5 (client half) and merchant P4/P5; record budgets; next free = 0162 | — | Everything Programme C touches around requests/offers/timeline is churning until 5's client lands; committing gives a stable base for ownership lists |
| 1 | **Community 6** (moderation/reputation/dispute access — admin desk, chats staff door, `printMatchingScore`) | **C1a Customizable-product core, dark**: additive migration (template/region/option/pricing-rule tables + `community_products` customization columns), NEW `worker/routes/personalize.ts` + `worker/lib/personalizePricing.ts` (server prices; cart never sends a price), merchant **template builder** as a lazy chunk inside the catalogue product editor (`src/components/merchant/catalog/*`), behind an admin setting `enabled:false` (§5) | Needs no community phase; disjoint from 6 (6 owns adminModeration/reputation/chats/staff read; C1a owns catalogue + new files). Community 7's draft-preview also edits the catalogue product form → schedule 7 AFTER C1a or hand the form to one workshop |
| 2 | **Merchant P6** (estimate, composer, HostBar, tracker, reels) — three PRs | **C2 Personalization studio** (Part 1 «Choose → Personalize → Preview → Request»): NEW lazy `personalize` chunk (name/text Smart Fit, colours/themes, size/finish words, printability engine as a Worker lib, photo/logo paths through NEW upload purposes with consumers, QR/NFC data), NEW `worker/lib/personalizeGeometry.ts` emitting LVM1 for the existing viewer (`ModelViewer.tsx` unchanged), «I want to create something» door | Disjoint from P6 except `RequestWizard.tsx` (P6 wraps it read-mostly) and `printRequests.ts` (P6 R5): C2 must NOT edit either — it creates a request through the existing publish helper from its own route and adds its wizard door as one rebased-last PR (the `App.tsx` pattern). Storefront closure untouched (customer entry lives in Community, not the store page) |
| 3 | **Community 7** (analytics beacon, collections, activity centre, draft preview) | **C1b Customize-before-cart** (Part 2 customer half): `StorefrontProduct.tsx` «Customize» door → lazy sheet (after P6's HostBar so the closure is measured once), cart line `config_json` in `worker/routes/storeOrders.ts`/`MerchantCartView.tsx`/`StoreCheckout.tsx`, personalized spec on the merchant order (lazy sub-panel) | Needs P6 landed (StorefrontProduct/HostBar/tracker churn over); disjoint from 7 (7 owns Creator/Saved/notifications/catalog preview). Budget: storefront closure has 3.5 KB — the door is a button + dynamic import |
| 4 | **Merchant P7** (Counter ops: threads inside, quick replies, vacation, order Spine, customers) | **C4 Materials & components** (Part 3): `products` flag «usable inside printed products» + component metadata (admin product form, `worker/routes/products.ts` — P2's cached reads, declared params), template component slots + compatibility rules (extends C1a tables), BOM tables, reservation via the existing order lifecycle, «Use in a printing project» door | P7 owns `storeOrderOps.ts`/`OrderDetailScreen`/inbox/chats/StoreSettingsTab — C4 stays in catalogue/products/admin + new BOM files; the merchant BOM panel is a lazy sheet in the catalogue editor, not the order screen (P7's) |
| 5 | **Merchant P8** (showcase clips, SEO, coupon scope) | **C3 My Designs · share · remix · Make Another · inspiration · Digital Twin**: designs table (private by default), share tokens as `viewer_grants`-style rows, public designs as `community_posts.kind='design'` (D1 — no second feed), «Make it mine», reorder from the twin | Needs community 6 (reports/hide for public designs) and 7 (collections vs «My Designs» reconciled: one save model) landed; disjoint from P8 |
| 6 | **Merchant P9** (link sources, indicative quotes, `responds_within_minutes` cron) | **C5 Levo Project umbrella + Project Room** (Parts 4/5 «Project» group): project table linking request/offer/order/design/twin ids, versions + approval lock, 3D annotations, Change Orders, revision budget, handoff package, dispute evidence package (extends 6's `chat_staff_reads` + evidence rows), milestone payments as `community_escrows` partial releases (server-authoritative) | Wants community 5 (offers V2/timeline/`Request.tsx`) and 6 (dispute access) and P7 (`ChatThread` extraction) landed — the Room composes them. P9 owns `printRequests/printQuote/merchantPrinters/Requests.tsx/Tools` → C5 reads, never edits, those |
| 7 | **Merchant P10** (staff, `requireStoreAccess`, `Capability` gating) | **C7a Manufacturing network — capability passport, smart matching, production slots, services & packages** (extends `merchant_request_prefs`/`merchant_printers` (0159 derived columns), `printMatchingScore` after 6's metrics; UI inside existing Printers/Costing screens) | Passport first (the network waits on it); P10 owns merchantAuth/nav/sections — C7a adds no workspace section until P10's gating exists; P9's `PrintersTab` rewrite is over |
| 8 | **Merchant P11** (host routes, ckb notifications, posts reels, engine E10) | **C6 Production board · machine assignment · batch optimizer · split · material reservation · serials · QC · proof** — a `production` section registered through P10's `Capability` machinery + `store_members` roles (Part 4 #31 IS P10's matrix, extended not duplicated) | Needs P7 (order Spine/notes) and P10 (roles) landed; P11 is disjoint (App.tsx, notifications, printPricing, storefront posts) |
| 9 | **Community 8** (perf/a11y/l10n/verify) | **C7b subcontract/overflow/split network, automation rules (recommend/draft only), follow merchant (extends 0154 follows)** + **C8 business layer** (brand kit, bulk/event/group orders, vault/asset library, licensing/royalties feature-flagged, colour calibration/swatch photos, profit simulator after P11's E10 in `printPricing`) | The long tail; the simulator must wait for P11's engine convergence; royalties/licensing dark behind settings |
| 10 | — | **C9 Programme C's own perf/a11y/localisation/deploy pass**, run under community 8's checklist and gates, then deploy after the owner's word | Same acceptance bar (R22/R23) |

Owner decisions that gate the schedule: row 169 (Sorani scope — decides whether Programme C's merchant strings follow D6; recommend assuming YES since every new feature test already requires ckb ≠ ar), row 170 (autoplay, P6/P8), Q13 (numbering — already de-facto «next free»), Q16 (staff matrix — P10 → C6), Q3 (vacation → P7).

## 5. Feature-flag mechanisms available today (for shipping dark)

1. **Admin settings** (`worker/lib/settings.ts:198-660` `SETTING_DEFAULTS`, 50 keys): structured configs with an `enabled` switch already exist and default OFF — `printerGiftConfig` (:219), `preorderGiftConfig` (:233), `reviewPointsConfig` (:289), `orderExpiryConfig` (:305); `bnplPolicy`/`giniPolicy`/`proPriorityDelivery` carry `enabled:true`. Single write path `PUT /api/admin/settings/:key` (`worker/routes/admin.ts:3847-3850`: `SETTING_KEYS.includes(key)` else 400; per-key normalisers; `printerFarmConfig`/`mainPageMedia` refuse raw writes and have their own audited routes); edge purge by key through `pathsChangedBySetting` (`edgePolicy.ts:246-264`). Public exposure only via `PUBLIC_SETTING_KEYS` (`settings.ts:665+`). Recipe for Programme C: one key per capability group (e.g. `personalizationConfig: { enabled:false, … }`), a normaliser in the PUT, NOT public unless the client needs it (then add to the purge map), audited like `admin.upload_limits` (`adminCommunity.ts:244`).
2. **Community gate** (`worker/lib/communityGate.ts`): `admin_settings.communityGate = {"open": bool, "allowed_user_ids": [...]}`; anything unreadable = CLOSED; admins (`users.role==='admin'`) always enter; written by `adminCommunity.ts:446-457` with `audit('community.gate_update')` + `afterCommunityGateWrite`; read by `GET /api/community/access` → `{closed, admin, may_enter}` (`community.ts:130-146`, `anonymousCached perViewer`). Everything Programme C mounts under `/api/community/*` is dark by construction until the owner opens the community; a router mounted elsewhere (e.g. `/api/personalize`) is OUTSIDE the wall unless it adds `requireCommunityOpen` (`communityGate.ts:233-237`) route by route — the `/api/marketplace` precedent.
3. **Membership entitlements** (`worker/lib/entitlements.ts:96-142` `ENTITLEMENT_MINIMUM_TIER`; `benefits.*` :578-604; `hasEntitlement` requires an active server-resolved membership and honours `gated_benefits` from `restriction_cases.benefit_flags` (:375-395, migration 0010)); every merchant tool is `'plus'`; `/api/merchant/me.can{…}` feeds the client; `membership_benefit_rules` (0074) + `GATE` (`membershipBenefits.ts:428-432`) for money benefits. Recipe: a new entitlement key + `benefits.x` accessor + `can.x` on `/me`; the client never compares tier strings (`merchantWorkspaceShell.test.ts:353-358`).
4. **Per-merchant opt-ins as data**: `merchant_request_prefs` (`accepts_custom_requests`, P9's `show_indicative_price`), `merchant_printers`-derived `technologies`/`max_build_mm` (0159), `community_merchants.status` sanction ladder, `launchConfig` (`DEFAULT_LAUNCH activated:true`). Recipe for the capability passport: columns/rows on `merchant_request_prefs`, read by `loadCandidates`.
5. **Client-side**: `nav.ts` `Capability` is `'always'` only until P10 (`merchantWorkspaceShell.test.ts:60` pin); lazy chunks + `useIdlePrefetch` mean a dark surface costs no bytes if its door is not rendered.

## 6. The verification bar (what «green» means per phase)

`npm run check` (`tsc` ×3, eslint, `check:workspaces`, `check:boundaries` = 11 suites incl. `ownership`, `check:studio`, `check:runners`) → `npm run test:unit` = `scripts/test-all.mjs` (root `node --import tsx --test tests/*.test.ts` — 617 files, 7,468 tests recorded; workspaces 361; Studio 313 — hard-fails if `studio/node_modules/three-slicer` is missing) → `node scripts/migrate-check.mjs --twice` → `npm run build` (prepare-deploy-config → vite → write-asset-headers → check-live-markers) + `tests/bundleBudget.test.ts` (12/12) → browser scripts on `127.0.0.1:4191/4192` (e2e-community-home 867/867, e2e-projects 493/493, e2e-catalog 104, e2e-store-builder 34 at the last integration) → deploy after the owner's word. CI (`deploy-staging-code.yml:83-84,134`) runs `check`, `test:unit`, `build`; Playwright scripts are run by the integrator locally (`playwright` is global, not a devDependency).

## 7. Workflow practice used so far

Spec first («written before each phase's workflow so the builders code against one text», `COMMUNITY_ECOSYSTEM.md:489`); parallel builders with strict file ownership (seven for P0–P2, ten for Phase 4 + P3 — `PERFORMANCE_LOG.md:45,1226`); an integrator merges into one tree and runs the gates in a fixed order (`:150-166`), touching files outside ownership only as one-line seam edits (`:1066`) and respecting pins owned by other suites (`:1256`: `OrdersTab` kept because three tests outside P3b's ownership pin it); adversarial reviews and a fixer (row 167: «eight agents — server, social UI, home page, integration, three adversarial reviews, fixes»; row 177 is the post-merge review's fix list); the merchant programme itself came from a 27-agent design workflow (7 surveys → 9 proposals → 6 judges → 3 syntheses → completeness critic, `MERCHANT_PLATFORM_V2.md:3`); every phase ends with a DECISIONS row and a doc section; CSS is «paid for, not raised» (D7) with the payback measured before the spend (row 168 (٦)).

REUSE:
[
 {
  "ask": "Ship every Programme C capability dark and switch it on per group (personalization, components, project, production, network, business layer, royalties)",
  "existing": "admin_settings via SETTING_DEFAULTS + `PUT /api/admin/settings/:key` (worker/lib/settings.ts:198-700; worker/routes/admin.ts:3847-3850) with the `{enabled:false,…}` config shape already used by printerGiftConfig/preorderGiftConfig/reviewPointsConfig/orderExpiryConfig; communityGate for anything under /api/community/*; entitlements `benefits.*` + `/api/merchant/me.can{}` for tier-gated merchant tools",
  "how": "One additive key per capability group with a safe default, a normaliser branch in the PUT, an audit row, NOT in PUBLIC_SETTING_KEYS unless the client needs it (then add to pathsChangedBySetting); merchant-tool gating as a new ENTITLEMENT_MINIMUM_TIER key + benefits accessor; never a `feature_flags` table"
 },
 {
  "ask": "Real-time, server-authoritative personalization pricing (size, finish, colours, text, logo, photo, QR, NFC, components) and the profit simulator",
  "existing": "The `Estimate` public contract and its margin discipline (worker/lib/printEstimate/{contract,explain,index}.ts, worker/lib/printPricing.ts, tests/printEstimateContract.test.ts; DECISIONS 174); `walletSpendCents` / escrow rules (worker/lib/escrowOps.ts)",
  "how": "A sibling `personalizePricing` lib that returns the same closed public shape (factors/covers, no cost_/margin_ words) and a merchant-only cost view; option-pricing rules stored per template, evaluated only on the server; the client sends option ids"
 },
 {
  "ask": "Logo, photo, reference-image and design-asset uploads",
  "existing": "Phase 4 upload sessions (worker/routes/uploadSessions.ts, worker/lib/uploadEntity.ts purposes, fileOwnership.ownedFileObject, viewer_grants; src/lib/uploadSession.ts + src/components/upload/UploadTile)",
  "how": "Add purposes (e.g. design_asset, design_photo) to UPLOAD_PURPOSES/SESSION_PURPOSES/KEY_PURPOSES in the same phase as their consumer (row 177 (٦)); keys stay private under the owner's prefix and are checked with ownedFileObject at every consumer; never a second uploader"
 },
 {
  "ask": "Live 3D preview with tap-to-edit regions, AR size hint, shareable rotate-only links",
  "existing": "src/pages/ModelViewer.tsx on ogl (vendor-webgl lazy chunk), LVM1 meshes from worker/lib/modelGeometry.ts (≤ 250k triangles), viewer_grants / model_view_tokens",
  "how": "A new Worker geometry builder that emits LVM1 with per-region colour groups for the existing viewer; region taps mapped by mesh group index; share links minted as viewer-grant-style rows; no three.js, no second viewer"
 },
 {
  "ask": "Customer-facing refusals for personalization/components/projects",
  "existing": "REFUSAL_STRINGS + apiRefusal/refusalText and the sources/DOORS discipline (src/lib/refusalStrings.ts; tests/refusalStrings.test.ts:106-274)",
  "how": "Every new code lands with ar/en/ckb (ckb ≠ ar ≠ en), its emitting route file appended to the test's sources list, and every new customer door appended to DOORS; refusal sentences loaded lazily on the first refusal (row 177 (١٠))"
 },
 {
  "ask": "Three-language UI strings for each new surface",
  "existing": "Per-feature strings.ts + the UI-test template (tests/workspaceUi.test.ts:75-123, tests/ordersListUi.test.ts:73-92, tests/postFilesUi.test.ts)",
  "how": "One strings.ts per lazy chunk with real Sorani, one *Ui.test.ts copying the parity/Kurdish-letters/tokens/useMotion assertions; no new Sorani in shared primitives or the shell (uiPrimitives:352, merchantWorkspaceShell:335)"
 },
 {
  "ask": "Public template catalogue, inspiration feed, public designs, brand-kit previews readable by guests",
  "existing": "anonymousCached with declared params, perViewer Vary and purge seams (worker/lib/edgePolicy.ts:124-264); visibility = the lists' own SQL (POST_PUBLIC_SQL etc.)",
  "how": "Every anonymous GET of Programme C goes through anonymousCached with an explicit params list; writes call the existing purge helpers; public designs reuse community_posts' visibility SQL (kind = design) instead of a new predicate"
 },
 {
  "ask": "Shareable designs, remix, inspiration, follow merchant/designer, activity",
  "existing": "community_posts (D1 one table; kinds), community_saves/collections (Phase 7), follows + creator follows (0154), grouped user_notifications, community_reports",
  "how": "Public designs are posts of a new kind; «Make it mine» = remix link columns on the design row; follow-merchant notifications extend the 0154 follow tables and grouped notification keys; reports/hide come from community Phase 6 — no parallel moderation"
 },
 {
  "ask": "Project Room messaging, approvals, change orders, dispute evidence, milestone payments",
  "existing": "chats + chat cards (worker/lib/chatCards.ts, chatCommerce.ts), community_orders/community_escrows (escrowOps partial release, disputes), Phase 5 timeline (community_order_updates), Phase 6 chat_staff_reads/dispute access, request discussion",
  "how": "A project row that links existing ids; approvals/change orders/versions as new tables referencing community_orders + design versions; milestones as escrow partial releases inside the existing batch pattern; the evidence package is a read that assembles existing rows + Phase 6 audit; the Room's chat column is P7's ChatThread"
 },
 {
  "ask": "Merchant teams & permissions, production roles",
  "existing": "Merchant P10 `merchant_store_members` + `requireStoreAccess` + `Capability` gating in nav.ts",
  "how": "Extend P10's role matrix with production/QC/design capabilities; register the production board as a `Capability`-gated section through P10's machinery; never a second membership table"
 },
 {
  "ask": "Capability passport, smart matching, production slots, overflow/subcontract routing",
  "existing": "merchant_request_prefs (accepts_custom_requests, turnaround_days, technologies/max_build_mm derived from merchant_printers in 0159), loadCandidates/evaluateEligibility/matchRequest, printMatchingScore (Phase 6 feeds response_minutes/trouble_rate), P9 responds_within_minutes cron",
  "how": "Passport columns on merchant_request_prefs / rows keyed by merchant, read by loadCandidates; slots derived from live community_orders/production rows at read time (the storeHours read-time rule); subcontract = a linked community_order/offer between merchants under the same escrow rules"
 },
 {
  "ask": "Components from the Levonis store inside printed products, BOM, inventory reservation",
  "existing": "products/product_variants (catalog owner), inventory_ledger, order lifecycle (worker/routes/orders.ts, storeOrderOps), anonymousCached product reads",
  "how": "An additive `products` flag + component metadata JSON (classified in mediaRefs if key-bearing), template slots referencing product/variant ids, reservation through the existing order lifecycle statements; the catalogue stays the only inventory"
 },
 {
  "ask": "Acceptance evidence for every Programme C surface",
  "existing": "tests/browser/<name>.html + <name>-fixture.tsx driven by scripts/e2e-<name>.mjs (360/1280, ar/en/ckb, dark/cream, reducedMotion on one axis, no overflow/no page errors/landmarks), bundleBudget lazy-only lists",
  "how": "One fixture + one script per Programme C lazy chunk (personalize, project room, production board, template builder), and each new chunk name added to the budget suite's chunk-of-its-own list; the personalize chunk added to the storefront lazy-only list"
 }
]

GAPS:
["G1 — No test enforces the customer-vocabulary rule (no CAD/slicer/mesh/STL words in customer-facing strings); the brief makes it a standing rule. A strings-walk test over the new personalize/project strings.ts + refusal sentences (ar/en/ckb) is needed and does not exist.","G2 — Rule R1 (no new wallet/escrow/chat/products/orders/notification system) has no automated enforcement in worker/: tests/serviceBoundaries scans services/* only and the ownership test only requires an owner per table. Compliance is by review; a Programme C lint (e.g. forbid CREATE TABLE names matching /wallet|escrow|chat|notification|order/ outside a reviewed allow-list) would close it.","G3 — `scripts/check-migrations-additive.mjs` is not applied to root migrations/ (only studio/drizzle) and would reject the ALTER TABLE … ADD COLUMN the repo relies on; «additive» at the root is proven only by migrate-check --twice and review. No numbers exist for how long `vite build` or the 617-file suite take on this 4-CPU box (docs record counts, not durations), so wave sizing is a judgement.","G4 — Community Phase 5's client half (Request.tsx route file, OfferComposer V2, CustomOrderScreen, MyCommunityOrders, «ملف الورشة», Hero/Stats workshop facts) is not in the tree yet; its final file list is unknown until it lands, so the wave-2 collision map around RequestWizard/Requests.tsx/SalesTabs is provisional.","G5 — Merchant §C.3's provisional migration numbers (0156–0161) and DECISIONS rows (170–178) are stale; COMMUNITY_ECOSYSTEM §9.8 quotes budgets 120/240 KB that the test does not have (72/200). Both docs need the renumbering Q13 asks for; Programme C should cite roles, never numbers.","G6 — Owner decisions that gate scheduling are open: row 169 (Sorani scope beyond community — decides which regime Programme C's merchant strings follow), row 170 (autoplay), Q1 (phone tabs), Q3 (vacation), Q6 (PSI key), Q9 (posts as clips), Q13 (numbering), Q14/Q15 (link providers, indicative prices), Q16 (staff matrix → C6), Q17 (merchant invoices).","G7 — The e2e scripts run reduced motion on one axis (light pass or ckb pass), not as a full on/off matrix; C.5's «reduced motion on and off» bar is met by convention, not by a shared runner. `scripts/e2e-workspace.mjs` planned in P3 was never written (P3 deviation note).","G8 — Playwright is a global install (/opt/node22, browsers in /opt/pw-browsers, env PLAYWRIGHT_BROWSERS_PATH), not a devDependency; a fresh container without it cannot run the acceptance scripts, and CI does not run them.","G9 — CSS payback debts already owed before Programme C spends anything: retiring `SalesTabs.OrdersTab` (row 176) and the StoreSettingsTab rebuild (P7) — the only known sources of bytes for new utility classes.","G10 — tests/merchantRouteGates.test.ts, tests/merchantStaff.test.ts and tests/moderationV2.test.ts named by the docs do not exist yet (they belong to P10 and community 6), so the gate enumeration Programme C's new /api/merchant/* routes would be checked against is not written."]

RISKS:
["CSS headroom is 476 B (60,964 of 61,440 B) with D7 forbidding growth phase over phase: any Programme C surface that introduces utility classes not already in the built sheet fails the gate; each phase needs a measured payback before its spend (row 168 (٦) precedent), and inline styles/Toast pattern for one-offs.","Storefront closure headroom is 3.5 KB (43.5 of 47 KB, up from 42.7 with P4/P5 in flight) and P6's HostBar takes ≤ 0.35 KB more: Part 2's «Customize» door on StorefrontProduct.tsx must be a button + dynamic import, never a static import of the configurator.","Seam-file contention: worker/index.ts (95 mounts), schemaVersion.ts, ownership.ts, refusalStrings.ts + its test's sources/DOORS lists, uploadEntity purposes, notifications.ts and App.tsx are edited by every phase of all three programmes; without an integrator-only rule they will conflict on every merge.","The uncommitted tree (52 paths, +3,490 lines) is the base for nothing yet: community Phase 5's client half will churn RequestWizard.tsx (1,060 lines), Requests.tsx (1,441), MyRequestsList, SalesTabs and StoreSettingsTab — exactly where Part 1's «two starting methods» and Part 4's Project Room want to hook in; starting Programme C there before Phase 5 lands guarantees rework.","bundleBudget rebuilds dist inside the test whenever any src/public file is newer than dist/index.html: with two workshops editing src/ concurrently on 4 CPUs, every builder's test run triggers a full `vite build`, and concurrent builds against one dist/ directory race (a half-written dist reads as the site). Builds and the budget suite must be serialised through the integrator.","A router mounted outside /api/community/* is outside the community wall by construction (prefix match): a new /api/personalize or /api/projects router that starts community trade must mount requireCommunityOpen route by route or it ships LIVE while the community is closed.","Every new key-bearing column (design_json, logo_key, photo_key, config_json, bom_json…) matches MEDIA_NAME_PATTERN or the JSON-default heuristic and must be classified in worker/lib/mediaRefs.ts in the same migration's phase, or tests/mediaReferences fails and the orphan sweeper refuses.","Two Sorani regimes coexist: feature strings need real Sorani (ckb ≠ ar ≠ en, ≥ 90 % Kurdish letters, no OWNER marker) while shared primitives forbid any Sorani nobody wrote before; a builder who adds a Programme C word to src/components/ui or the shell fails uiPrimitives/merchantWorkspaceShell, and one who copies Arabic into a feature file fails its Ui test. Row 169 (pending) decides the merchant/storefront folders.","Programme C's Part 4 #31 (teams & permissions), #36 (follow), #2 (Room messaging), #22 (milestones) each already have an owner phase (P10 store_members, 0154 follows, P7 ChatThread, escrowOps): building them first duplicates systems the standing rules forbid; the interleaving must place them after their owner phase.","Pins that other phases move (merchantWorkspaceShell:60 capability 'always', :119 away routes, storeLayoutSchema:556 BLOCK_TYPES 27) will fail any Programme C branch rebased across P6/P7/P10 unless the pins are moved in the owning phase, not in Programme C.","P11's engine convergence (printPricing.ts/printQuote/*) collides with the profit simulator and auto-cost (Parts 3/4/5): scheduling the simulator before P11 forces a second convergence.","Studio (studio/) is a separate workspace with three/three-slicer; the rule «ogl is the only 3D library» holds for the SPA; Programme C's mesh generation must stay in the Worker (modelGeometry pattern) — a Studio-side dependency would silently break the 3D rule and the vendor-webgl lazy-only pin."]

NUMBERS:
Measured against dist/ built 2026-09-30T03:09Z (newer than every source at 02:48Z, so the gate would not rebuild), gate method = node zlib level 9 per file: entry index-DQ12qcUx.js 66.2 KB / 72 KB; initial payload 182.8 KB / 200 KB over 4 files (index, vendor-i18n, vendor-motion-core, vendor-react); CSS 60,964 B = 59.5 KB / 61,440 B → 476 B headroom (index-*.css 48,067; Auth 8,123; theme 1,516 + 1,243; ListingView 621; StoreDesignPanel 503; swatches 513; orderPrint 378); storefront closure beyond initial 43.5 KB / 47 KB (StoreRenderer 11.9, theme 6.8 + 3.0, Storefront 6.2, StorefrontProduct 6.3, QuantityInput 2.7 …; shares vendor-motion + vendor-icons); workspace shell 15.1 / 25 KB, closure 25.2 / 32 KB; CommandCenter 14.8 / 18; OrderDetailScreen 7.2 / 12; AnalyticsSection 10.8 / 16; CompareTray 2.6 / 8; document 1,905 B / 4 KB; ModelViewer chunk 7.3 KB + vendor-webgl 15.3 KB (lazy); Requests 39.5 KB; StoreDesignPanel 38.8 KB; OrdersList 8.1; tabViews 6.5; extra 8.0; refusalStrings 22.5 KB (lazy); largest chunks vendor-charts 119.8 KB, vendor-react 75.0 KB, vendor-qr 46.6 KB, ProductForm 44.0 KB (all ≤ 250). Repository: 154 migration files, last 0161 → next free 0162 (0159/0160/0161 untracked); 260 tables created by migrations (gate regex) vs 277 owner entries; 29 service names; DECISIONS last row 177 → next 178; 617 test files (root suite 7,468 tests recorded, workspaces 361, Studio 313); 61 scripts/e2e-*.mjs; 21 browser fixture pages; e2e counts at last integration: community-home 867, projects 493, catalog 104, store-builder 34; anonymousCached used at 21 call sites in 9 route files; UPLOAD_PURPOSES 12 / SESSION_PURPOSES 7; SETTING_DEFAULTS 50 keys; 6 SPRING names; worker/index.ts 95 /api mounts; in-flight tree 39 modified + 13 untracked = 52 paths, +3,490/−228 lines (marketplace.ts +819, requests/api.ts +362, storeLayoutSchema.test +307, storeLayout route +235); hot-file sizes: orders.ts 5,422 lines, products.ts 4,576, marketplace.ts 3,108, Cart.tsx 2,663, cart.ts 2,656, printRequests.ts 2,246, printQuote.ts 1,993, refusalStrings.ts 1,695, Requests.tsx 1,441, merchantCatalog.ts 1,394, chats.ts 1,294, storeOrders.ts 1,266, storeOrderOps.ts 1,088, App.tsx 1,066, modelGeometry.ts 1,065, RequestWizard.tsx 1,060, worker/index.ts 1,038, ModelViewer.tsx 959, chatCards.ts 934, escrowOps.ts 889, StoreCheckout.tsx 880; box: 4 CPUs (availableParallelism 4 → node --test runs 3 files in parallel), 16 GB RAM (15.1 GB free); Playwright 1.56.1 global, chromium-1194 in /opt/pw-browsers; viewer mesh cap 250,000 triangles; edge lifetime 60/120/600 s; ZIP bound 2,000 entries / 8×; viewer_grants 60 min; bulk ≤ 50 ids; CSV ≤ 5,000 rows; community lists ≤ 12 rows, counts ≤ 200, queries ≤ 60 chars, 120/min.

---

## Track — customer-personalization (judged synthesis; the judge chose Proposal 3 (systems-first) as the spine)

# Customer personalization — the merged design

**Spine:** Proposal 3, «one configuration value, committed two ways».

**Grafts:**
- From Proposal 1: the five-control first paint, the engine-chosen door, the full-screen host, one extracted viewer core, the analytic QR check, the request sheet and the minimal public twin.
- From Proposal 2: the surface compiler, the Confirm step, the ≥ 1024 inspector, the look card, name-free part trailers, stocked RGB in 3D, the price-uniform roster rule and the production exports.

**Code word: blueprint.** `template` is already taken by `worker/routes/template.ts`, `templateFamilies.ts` and store starters. Merchants see «Customization»; customers see neither word.

## 0. Facts this design stands on (verified read-only, 2026-09-30)

**Pricing and cart identity**
- `resolveCatalogLine` (`worker/lib/catalog/lines.ts:50-83`) is the one pricer for add, cart and checkout. Its simple branch validates `color_id` through `merchantVariantLabel`, so a configured branch must run first.
- Merchant cart identity is `idx_cart_merchant_line (user_id, community_product_id, option_id, color_id)` plus the table UNIQUE (0141). The add door's `ON CONFLICT` names those columns (`cart.ts:2409/2418`).
- Migrations apply before code (`deploy-staging-code.yml:136-139`). An index swap would therefore break the running add door; the 0082/0083 precedent needed two releases.
- Fingerprint v2 hashes `[cart_item_id, product_id, qty, unit_price_iqd, option_id, color_id]` per line (`storeOrders.ts:436-450`).

**Order lines and requests**
- `cancelStoreOrder` restocks `SUM(qty)` per `community_product_id` over every `order_items` row (`storeOrderOps.ts:374-385`).
- 0058 child lines are already folded by `invoices.ts:145` and `orders.ts` `topLevelItems`. `merchantOrders.ts:288` does not select `bundle_parent_item_id` yet.
- `canonicalFacts` (`requestRevisions.ts`) is a fixed array. Appending an element changes every existing `factsHash` unless it is appended only when present.
- The direct-request bodies are route-local in `chatCommerce.ts:152-246`. Only `openStoreThread` (`chats.ts:374`), `printRequestCard` and `cardInsertStatement` (`chatCards.ts:194/387`) are exported.

**Files and caching**
- `/files` serves `merchants/<uid>/public/*` as `public, max-age=31536000, immutable`, edge-cached, with Range and 0 D1 (`uploads.ts:1068-1187`, `mediaStorage.ts:670-682`). It copies R2 metadata with `writeHttpMetadata`, so a pre-gzipped mesh is stored as `application/gzip` and inflated with `DecompressionStream`.
- `anonymousCached` reads `built.text()`, so no binary goes through it.
- `storefrontPaths` does not include the product detail path, so a publish must purge that path explicitly.
- `GRANTED_ROLES` opens `download_after_purchase|source_model|reference|instruction` files to every buyer (`fileOwnership.ts:46`). A blueprint's source must never be a `product_files` row.
- fflate imports are pinned by `tests/store-isolation.test.ts`; the Worker gzips with the native `CompressionStream`.

**Client and rendering**
- `parseLvm` ignores bytes after the triangle block (`ModelViewer.tsx:209-217`).
- The harness Chromium renders WebGL with `--no-sandbox` (measured).
- `packages/catalog` exports `./*`, so `@levonis/catalog/personalize/*` resolves.
- `palette.ts` stays ar/en under the OWNER convention.
- `assertDecent`/`nameGuard` (`worker/lib/decency.ts`) exist for names.

**Pins and budgets**
- `tests/requestPageUi.test.ts:311-316` pins the `data-request-section` order in `Request.tsx`.
- Budgets today (gzip-9):

| Budget | Today | Limit |
|---|---|---|
| Entry | ≈ 67.7 KB | 72 KB |
| Initial payload | 182.8 KB | 200 KB |
| CSS | 60,964 B | 61,440 B (476 B headroom) |
| Storefront closure | ≈ 43.5–43.9 KB (P6 HostBar ≤ 0.35 KB still to come) | 47 KB |
| vendor-webgl | 15,629 B | — |
| ModelViewer | 7,430 B | — |
| OrderDetailScreen | 7,347 B | 12 KB pin |

## 1. Concept

**The merchant describes a product once, as a blueprint.**
- Which parts of their own 3D file take a colour.
- Where up to four content areas sit, as millimetre frames on the model: name/text, logo, photo, QR.
- Which sizes, finishes, quality levels, colours, add-ons, extras and rules exist, and what each adds to the price. Add-ons are the store's own products flagged «Can be used inside printed products».

**Each publish freezes three things:**
- An immutable revision: trigger-locked, with at most one live revision per product.
- A public, immutable, gzip LVM1 mesh with a part-range trailer.
- A **look card**: poster, region id map and area quads.

**Everything personal becomes one value.** It is an immutable, owner-scoped, canonical **DesignConfig**: palette keys, choice keys, short texts and the owner's own asset keys. Every existing door passes it by id:
- the store cart line (`color_id = 'cfg:'||id` under the existing merge index);
- the store order line (snapshot plus 0-IQD add-on child lines on the 0058 columns);
- a direct request to the same store (`community_requests.config_id` inside the existing revision/offer loop);
- My Designs, the Digital Twin, shares and rosters.

**One pure engine** lives in `packages/catalog/src/personalize`. In the browser it normalises, compiles the customer surface (≤ 4 controls + 1 door, generated only from what the blueprint declares), prices, checks and auto-fixes with zero round trips per tap. Inside the Worker it runs in the single pricer. So the price the customer watches is the price charged, and no automatic fix ever changes it.

**The customer sees:** Name · Look · Size · More · [Add to cart | Request printing], over a live ogl preview on the one viewer core. The merchant gets the depth. There is no new cart, order, request marketplace, wallet, chat, viewer or notification system. Everything ships dark behind `personalizationConfig`.

## 2. Screens (360 first; icons are lucide: Sparkles, Dices, Camera, Nfc, QrCode, CircleCheck, Star — no emoji in copy)

### S1 · Studio, first paint · 360 × 740

The host is an `Overlay mode="modal" solid` panel (`panelClassName="fixed inset-0 max-w-none bg-canvas"`), rendered in the app portal like `SellerConflictDialog` so app tokens apply on store hosts. It opens over the product page with `?customize=1`; Back closes it; a dirty guard protects unsaved work.

```
┌────────────────────────────────────┐
│ (x)  Controller stand        (...)  │ IconButton · h1 dir=auto line-clamp-1 · Menu: Start over (W3 + Make another, W4 + Share)
├────────────────────────────────────┤
│        [poster -> live 3D]         │ canvas role=img + live sentence («navy body, teal base, name ALI in white»)
│              A L I                 │ height = 52 % of visualViewport (inline style); drag turns, pinch zooms,
│                                    │ tap a part -> its editor (the part glows once, the camera frames it)
│ (CircleCheck) Ready to print   (↺) │ ReadyLine role=status data-verdict · IconButton reset view
├────────────────────────────────────┤
│ ┌───────┬───────┬───────┬───────┐  │ compiled surface: <= 4 .lv-choice tiles (label + current value),
│ │ Name  │ Look  │ Size  │ More  │  │ role=tablist, arrow keys follow the writing direction
│ │ ALI   │ o o o │ M (*) │ 2     │  │
│ └───────┴───────┴───────┴───────┘  │
│ ┌────────────────────────────────┐ │ Name panel OPEN at first paint, inline (never a sheet): Input dir=auto,
│ │ ALI                          9 │ │ letters-left counter, NO size control (Smart Fit)
│ └────────────────────────────────┘ │
│ (Bold)(Fun)(Gaming)(Elegant)(Kids)(Minimal) -> │ style chips, one snap-x row, each drawn in its own weight
├────────────────────────────────────┤
│ 25,000 IQD (i)    [  Add to cart  ] │ Money aria-live · Anchored «Why this price» · primary opens Confirm (S4)
└────────────────────────────────────┘
```

**Five controls at first paint:** the lead tile (Name | Logo | Photo | QR | Text, chosen by the compiler), Look, Size, More, and the door. A blueprint without size choices has no Size tile; one without colour choices has no Look tile.

**Contextual lines appear one at a time, only after a change** (`Note tone=gold` or `StatusChip`):
- «(Sparkles) The name reads better in white. [Apply] (x)» — undo via Toast.
- «Made the name smaller to fit».
- «Too long for Small — [Use Medium +3,000]» — a priced fix is always a tap, never automatic.

**S1a · Look panel (inline)**
- Ten theme chips (three `.lv-swatch` dots + name). Stocked themes come first; themes the shop cannot make are hidden.
- [(Sparkles) Choose for me] [(Dices) Try another].
- «Parts» rows, 48 px each (swatch + part + colour name). These are the list twin of tapping the model.
- Tapping a row opens the **PaletteSheet** (Sheet v2 medium/large): «Ready now» (the shop's stocked filament mapped to palette keys) first, then «Made to order» (hidden when the blueprint is stocked-only).
- Swatch buttons always show a name, never colour alone.
- After an unstocked pick: «Purple isn't in stock here — we used the closest: Navy».
- «Colours on screens are approximate», once per sheet.

**S1b · Size panel (inline)**
- `Segmented` [Small | Medium (Star) Recommended | Large], with ± IQD on each option.
- «≈ 15 × 10 × 12 cm» as secondary text.
- A rule line only when a rule applies.
- «Size in real life» (an SVG with the object's box to scale beside a phone, a mug and an A4 outline).
- «See it in your space» only where WebXR immersive-ar is supported.

### S2 · More sheet (Sheet v2 medium/large)

The sheet lists only the rows the blueprint declares. Tapping a row pushes a page inside the same sheet («‹ More», CROSS_FADE under reduced motion); there is never a second sheet.

| Row | What it shows |
|---|---|
| Finish | Chips Classic, Matte, Shiny, Silk, Wood, Marble, Glow, Flexible (declared ones only), each with its material name as secondary text. Changing finish re-filters colours and explains any automatic swap. |
| Look & quality | Good value \| Best look (production settings stay private). |
| Your logo | `UploadTile purpose=design_asset`, then a 1–2-colour preview on the model (posterised, uniform background knocked out). A detailed logo shows «The shop will check it» (verdict review). |
| Photo | Result cards of the SAME photo in each declared mode (Lithophane, Relief, Silhouette, Colour print), plus crop. |
| QR code | Kind chips (Instagram, TikTok, WhatsApp, Website, Menu, Contact, Link; «Reorder link» from W3) and one field. «Scans well» comes from the analytic check; if modules fall under 1 mm the page suggests a larger size. |
| (Nfc) Tap with your phone | The same shape. Wi-Fi and contact kinds add «The shop programs it and will see what you type». |
| Add-ons | Required slots are pre-filled with their default and show «Change». Options carry price deltas; sold-out options are shown disabled with the engine's alternative («Try White LED»). An option that forces another priced change shows the combined delta on its chip before the tap («20 mm · needs Large · +8,000»). A chosen light shows its marker part on the model. |
| Gift | Switch; once on: To, Message ≤ 140, Wrap (+IQD), Hide the price in the box. |
| + Make another (W4) | Adds a roster entry. |
| Ask the shop for changes | Only when the community is open and the store takes custom requests. |
| Note for the maker | Free text. |

### S3 · Studio · 1280 × 800

```
┌──────────────────────────────────────────────────────────────┬──────────────────────────────┐
│ (x) Controller stand · Levo Prints                                                   (...) │
├──────────────────────────────────────────────────────────────┼──────────────────────────────┤
│                                                              │ Name  [ALI_____________] 9   │ <aside> at the inline END,
│                                                              │       (Bold)(Fun)(Gaming)…   │ 380 px (inline style),
│                 canvas (flex-1)                              │ Look  (Choose for me)        │ overflow-y-auto
│                                                              │       themes · Parts rows    │
│ (CircleCheck) Ready to print                          (↺)    │ Size  [ S | M (*) | L ]      │
│                                                              │ > Finish · Silk              │ More rows = closed Disclosures
│                                                              │ > Add-ons · Magnet 15 mm ×2  │
│                                                              ├──────────────────────────────┤
│                                                              │ 25,000 IQD (i)  [Add to cart]│ in flow at the aside's foot
└──────────────────────────────────────────────────────────────┴──────────────────────────────┘
```

- There are no bottom sheets at this width; the palette and Confirm open as Sheet v2's centred windows.
- Tapping the model scrolls to and highlights the matching group.
- Keyboard: the focused canvas turns with the arrow keys and zooms with +/−.

### S4 · Confirm sheet (the brief's Confirm step; Sheet v2 medium → large)

```
│ ─── Your stand                          (x) │
│ [ look card 16:10 of THIS configuration   ] │
│ Medium · Silk · «ALI» · Navy / Teal / White │ the words the maker receives (= option_snapshot)
│ Magnet 15 mm × 2 · Gift wrap                │
│ We made the name a little smaller so it     │ Note tone=gold: each automatic fix, one line
│ fits on one line.                           │
│ How many   [ - 1 + ]                        │ QuantityInput (a roster line shows «3 names» instead)
│ 29,000 IQD      > Why this price            │ Money + Disclosure listing the adds in words
│ [              Add to cart              ]   │ footer; a guest signs in first and the draft survives
```

**Request variant** (the door is «Request printing»):
- Adds Needed by (optional date), Delivery to (governorate, prefilled from the profile) and Note.
- Shows «From 25,000 IQD — the shop confirms the price in your chat» and [Send request].
- On success: «Sent. Levo Prints will reply in your chat» [Open chat].

### S5 · Product page door (`StorefrontProduct.tsx`, store host and apex)

Shown only when the product answer carries `customizable`:
- A one-line summary «Customizable: name · colours · 3 sizes».
- The fixed buy bar's primary becomes [Customize it], a dynamic import on tap.
- The QuantityInput is hidden for customizable products; quantity lives in Confirm.
- Cost: ≤ 0.4 KB of storefront closure, no motion import.

### S6 · Cart line (`Cart.tsx`, `MerchantCartView.tsx`)

- [look card 72 px] · name · words («ALI · Medium · Navy/Teal»).
- [Edit design] opens the studio in edit mode; «Update cart» sends a PATCH (and merges into an identical line if one exists).
- Price; QuantityInput (a roster line reads «3 names»).
- `option_gone` shows «The shop changed this product — update your design», reopening the studio with the automatic migration applied.

### S7 · Merchant production summary

Lazy; opens from an `OrderDetailScreen` line, from `CustomOrderScreen` and from the request page. Sheet v2 large at 360, inline in two columns at 1280.

```
Line 1 · Controller stand × 2                                       [Open in 3D]
Print   Large ×1.25 · 150×100×125 mm · Silk -> your «PLA Silk» · Best look (your note: 0.12 mm · 20 %)
Parts   Body navy -> your «Navy PLA Silk» (in stock) · Base teal -> «Teal PLA» · Name white
Name    «علي» · Gaming · 1 line · cap 9.5 mm · 62×18 mm frame on Name plate · raised
Logo    [original] flat · 2 colours · 30×30 mm on Body
QR      instagram.com/ali.prints · v3 · 1.1 mm modules [SVG]
NFC     write https://wa.me/964…
Add-ons Round magnet 15×3 × 4 (2 per piece) — child lines, stock already taken
Gift    To Sara · «Happy birthday» · no prices in the box
Names   ALI · SARA · OMAR [CSV]            (roster lines)
[Artwork PNG 20 px/mm]  [Print job sheet]  (orderPrint.css layout)
```

Merchant words are allowed here; the vocabulary test exempts merchant files.

### S8 · Blueprint builder

Entry: ProductEditorSheet → new Disclosure «Customization» (summary: Off | Draft | Live · rev 3 · 4 parts) → [Open the builder]. It opens as a full-screen Overlay running the lazy `BlueprintBuilder` chunk.

```
┌────────────────────────────────────┐
│ (x) Customization · Controller stand│
│          [stage: tap a part]       │ same viewer core; the selected part is tinted
├────────────────────────────────────┤
│ Model Parts Areas Choices Add-ons Prices Publish │ TabStrip, scrollable, a done-dot per step
│ 5 parts found in your file         │
│ o «Body»   -> [ Body        v ]    │ role Select pre-filled from the part names (ar/en)
│ o «Base»   -> [ Base        v ]    │
│ o «Plate»  -> [ Name plate  v ]    │
│ o «Sample» -> [ Hidden      v ]    │ hidden parts are stripped from the public mesh
├────────────────────────────────────┤
│ [Preview as customer]     [ Next ] │
└────────────────────────────────────┘
```

| Step | What the merchant does |
|---|---|
| Model | `UploadTile purpose=product_file`, 1–12 files: one 3MF with objects/components, glTF nodes, OBJ groups, or one STL per part placed by its stored bbox. A compile StatusChip; ModelAnalysis warnings in merchant words; a heavy model gets «export a lighter model: at most 60,000 triangles». |
| Parts | Role per part (Body, Base, Name plate, Text, Border, Accent, Logo, Icon, Insert, Accessory, Fixed, Hidden). «Customers choose the colour». Allowed colours (default: my stocked colours). Default colour. Premium colour +IQD. «Shown when» an add-on slot is filled (accessory markers). |
| Areas | [+ Name] [+ Text] [+ Logo] [+ Photo] [+ QR], then tap the model: a frame lands on that face with draggable corners and mm shown. Settings: lines, max letters (suggested from the width), names 1–4, styles, make (raised/engraved/painted/inlay), +IQD. At most 4 areas. |
| Choices | Sizes S/M/L/XL as the longest side in cm, never %; a size over the shop's biggest printer (`merchant_request_prefs.max_build_mm`) is refused. Finishes, each mapped to a catalogue material pre-filled from stock. Good value/Best look (+IQD, +days, private quality note). Colours included and price per extra colour. Themes. Extras (gift wrap, NFC, roster fields). Rules from a closed list. |
| Add-ons | Slots filled from my live products flagged «Can be used inside printed products» (kind, qty, required, default). |
| Prices | Base = the product price (linked). One `NumberInput kind=money` per declared modifier. Segmented «Customers buy directly \| Customers send a request (I confirm the price)». KpiTile «ALI · Large · Silk · 2 magnets = 30,000 IQD». Merchant-only hint «Large uses ≈ 62 g more filament». |
| Publish | «Preview as customer» runs the real studio in preview mode. The look card and poster are captured automatically (Switch «Use as product picture»). [Publish] / [Pause]. |

At 1280: the steps as a vertical TabStrip | the stage | the step panel, with widths set by inline style.

### S9 · Create (`/community/create`, inside CommunityGate, lazy)

```
┌────────────────────────────────────┐
│ <  Create something                │
│ ┌────────────────────────────────┐ │ Textarea «Tell us what you want»; interpretIdea runs locally
│ │ Black and red controller stand │ │
│ │ with the name Ali              │ │
│ └────────────────────────────────┘ │
│ Understood: (Black x)(Red x)(Stand x)(«Ali» x) │ removable chips; only tags reach the server
│ [           Show me            ]   │
│ (Camera From a photo)(Sparkles Make something for me)(Dices Surprise me) │ .lv-choice chip rail
│ Ideas                              │ grid-cols-2 look cards already wearing «Ali» in black/red,
│ ┌───────┐ ┌───────┐                │ «from 20,000 IQD» · shop; tap -> product page ?customize=1,
│ │  ALI  │ │  ALI  │                │ prefill in router state (never in the URL)
│ └───────┘ └───────┘                │
│ Nothing fits? [Send it as a request] │ -> today's wizard, prefilled (board request)
└────────────────────────────────────┘
```

- **1280:** `max-w-5xl`, the idea box and chips on top, a 4-column grid below.
- **Make something for me** (Sheet): name · for whom · occasion · favourite colour · budget → up to 6 concept look cards.
- **Surprise me:** one concept at a time + «Try another».
- **From a photo:** the photo appears processed by every photo-capable blueprint → tap one. If no shop offers that kind: a «Make something like this» board request carrying the photo and one sentence.
- **S9a · Two starting methods** on `/requests?view=new` (a one-line seam): two `.lv-choice` cards, 76 px. «I already have a file» leads to today's wizard (P6's RequestComposer), untouched. «I want to create something» leads to `/community/create`.

### S10 · My Designs, twin, shares

- **My Designs** (`/designs`, ProtectedRoute, not community-gated). TabStrip Designs · Made (W4 adds Vault).
  - Designs rows: look card 56 px · «Controller stand · ALI» · shop · «edited 2 days ago» · Menu (Continue, Duplicate, Delete; W4 adds Share).
  - Made rows: [Order again] [Make another] [View].
- **Twin** (`/t/:code`). The owner lands on the Made item. Anyone else lands on the product page with «Make one like this» (defaults only; never the owner's name, photo or logo).
- **W4 · Shared design** (`/d/:token`): the studio in view mode + [Make it mine] [Request printing].
- **W4 · Group link** (`/g/:token`): the line «Class 6B keychains · 12 of 30 · closes Thu», then the studio in participant mode (only the unlocked fields) + [Add my name]. The organizer at 1280 sees KpiTiles, a DataList of entries, «Paste names» and [Order all (18)].

### States

| State | What the customer sees |
|---|---|
| Loading | The poster/look card at the stage's exact height + tile skeletons. |
| Blueprint gone or paused | `NotFoundState` «This product can't be customized right now». |
| Load failure | `ErrorState` with retry. |
| No WebGL, lost context, or no `DecompressionStream` (iOS < 16.4) | The look card with every control still working: «The live preview isn't available on this device — your choices are saved exactly». |
| Save-Data | The look card first + [Show the live preview (≈ 200 KB)]. |

## 3. Data model by role

All changes are additive. Migration numbers are «next free at merge» (0162+ today). `schemaVersion.ts` name and count move in the same commit.

### 3.1 Reused verbatim
- **Existing carts and orders:**
  - `cart_items` with `idx_cart_merchant_line`, the table UNIQUE and the add door's `ON CONFLICT` merge — no index change, no new column, `CART_LINE_COLUMNS` untouched.
  - `resolveCatalogLine`, `priceMerchantCart`, fingerprint v2, and the NULL-a-NOT-NULL fence pattern (beside `deliveryFenceStatement`).
  - `order_items.option_snapshot` (words), and `bundle_parent_item_id` / `component_value_iqd` on 0058's columns.
  - `cancelStoreOrder` and `trg_store_order_cancel_restocks_variants`.
- **Requests:** `community_requests` + the 0151 direct-request triggers, `publishRequest`, `openStoreThread`, the print_request card, `requestFileAccess`, `recordRevisionStatement`, `reviseIfOfferedStatement`, `supersedeStatement`.
- **Files and uploads:** `file_objects` + upload sessions + `ownedFileObject`, and the `/files` public immutable path.
- **Shop and catalogue data:** `merchant_material_stock` (stocked colours), `merchant_request_prefs.max_build_mm`, the `printMaterials` setting (finish → material), the 22-key palette and `.lv-swatch`.
- **Shared libraries:** `worker/lib/qr.ts` (+ an EC option), `nameGuard`/`assertDecent`, `anonymousCached` and its purge seams.
- **Social:** `community_posts`, `follows`, grouped `user_notifications`.

### 3.2 Migration `personalization_core` (W1)

```
product_blueprints                      -- owner: marketplace
  id TEXT PRIMARY KEY ('bp_…')
  product_id TEXT NOT NULL → community_products(id) ON DELETE CASCADE
  store_id TEXT NOT NULL, merchant_id TEXT NOT NULL           -- denormalised for the gallery
  rev INTEGER NOT NULL CHECK (rev >= 1)
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','live','retired'))
  spec TEXT NOT NULL DEFAULT '{}'        -- normalizeBlueprint output (public part + `private`)
  source_keys TEXT NOT NULL DEFAULT '[]' -- ≤ 12 PRIVATE product_file keys, never served, never product_files rows
  parts TEXT NOT NULL DEFAULT '[]'       -- [{i, name, tris, bbox}] merchant-only
  analysis TEXT NOT NULL DEFAULT '{}'    -- ModelAnalysis of the assembled piece
  mesh_state TEXT NOT NULL DEFAULT 'none' CHECK (mesh_state IN ('none','ready','failed'))
  draft_mesh_key TEXT                    -- private merchants/<uid>/blueprints/<id>-<hash12>.lvm.gz
  mesh_key TEXT                          -- public merchants/<uid>/public/bp/<id>-r<rev>-<hash12>.lvm.gz (set at publish)
  mesh_hash TEXT NOT NULL DEFAULT '', mesh_bytes INTEGER NOT NULL DEFAULT 0, triangles INTEGER NOT NULL DEFAULT 0
  look TEXT NOT NULL DEFAULT '{}'        -- LookCard {poster_key, w, h, idmap, quads, camera}
  family TEXT NOT NULL DEFAULT ''        -- closed code list (stand|keychain|sign|plaque|lamp|magnet|holder|decor|gift|business…)
  tags TEXT NOT NULL DEFAULT '[]'        -- occ:* for:* biz photo:* (closed vocabulary)
  from_iqd INTEGER NOT NULL DEFAULT 0    -- cheapest valid configuration, computed at publish
  created_by, created_at, updated_at, published_at, retired_at
  UNIQUE (product_id, rev)
  UNIQUE INDEX ux_blueprint_live ON product_blueprints(product_id) WHERE state = 'live'
  INDEX (state, published_at DESC, id) WHERE state = 'live'; INDEX (family, state); INDEX (store_id, state)
  TRIGGER trg_blueprint_locked BEFORE UPDATE OF spec, source_keys, mesh_key, rev, product_id
          WHEN OLD.state <> 'draft' → RAISE(ABORT,'BLUEPRINT_LOCKED')       -- edits are a new draft rev
  TRIGGER trg_blueprint_not_private BEFORE INSERT WHEN the product has audience_user_id
          → RAISE(ABORT,'BLUEPRINT_PRODUCT_INELIGIBLE')                     -- 0152 private products stay quotes

design_configs                          -- owner: marketplace; THE value every door references
  id TEXT PRIMARY KEY ('cfg_…')
  owner_id TEXT NOT NULL → users(id) ON DELETE CASCADE
  product_id TEXT NOT NULL → community_products(id) ON DELETE CASCADE
  rev INTEGER NOT NULL                   -- live revision at mint (informational; validity is judged against the live rev)
  hash TEXT NOT NULL                     -- sha256(canonical choices incl. product_id, excl. rev)[0:32]
  spec TEXT NOT NULL                     -- canonical DesignConfig
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0,1))    -- W4 redacted public copies
  twin_code TEXT                         -- 10 chars Crockford base32, random at mint (known before production)
  created_at TEXT NOT NULL
  UNIQUE (owner_id, hash); UNIQUE INDEX (twin_code) WHERE twin_code IS NOT NULL
  TRIGGER trg_config_immutable BEFORE UPDATE OF spec, hash, owner_id, product_id → RAISE(ABORT,'CONFIG_IMMUTABLE')

community_products + component_use TEXT NOT NULL DEFAULT ''    -- magnet|motor|led|nfc|screw|bearing|switch|module|insert|keyring|hook|cable|battery|other ('' = not a component; code-level list, no CHECK)
                   + component_spec TEXT NOT NULL DEFAULT '{}' -- {d_mm,l_mm,w_mm,h_mm,volts,fits[]} numbers and short words
```

If the merchant-templates-components track lands its component columns first, W1 reuses them: one flag, never two.

**Setting, entitlement and upload purpose**
- **Setting** (not a table): `personalizationConfig = {enabled:false, cart:false, create:false, social:false, components_levonis:false, pilot_store_ids:[], pilot_user_ids:[], max_triangles:60000, max_roster:200, design_quota:300}`.
  - A normaliser in `PUT /api/admin/settings/:key`, audited as `admin.personalization`.
  - Not in `PUBLIC_SETTING_KEYS` (the pilot ids would leak).
  - `pathsChangedBySetting` purges `/api/personalize/status`.
- **Entitlement** `customizableProducts: 'plus'`, surfaced as `/api/merchant/me.can.customize`.
- **Upload purpose `design_asset`**:
  - Added to `UPLOAD_PURPOSES`, `SESSION_PURPOSES`, `SIMPLE_UPLOAD_PURPOSES` and `KEY_PURPOSES`.
  - Images only (png/jpeg/webp; no SVG), placed privately at `users/<uid>/design-assets/<id>.<ext>`.
  - Quota `uploadQuotas.design_asset_gb` 0.5.
  - Its consumer is the config normaliser, which lands in the same workflow (row 177 (٦)).

### 3.3 Migration `personalization_commerce` (W3)

```
user_designs                            -- owner: marketplace; «My Designs», the mutable working copy
  id TEXT PRIMARY KEY ('dsg_…'), owner_id → users ON DELETE CASCADE, product_id → community_products ON DELETE SET NULL
  title TEXT NOT NULL DEFAULT ''         -- ≤ 60, auto «Controller stand · ALI»
  draft TEXT NOT NULL DEFAULT '{}'       -- leniently normalised DesignConfig (required areas may be empty)
  last_config_id TEXT, parent_config_id TEXT   -- remix / make-another lineage (the remix tree, Part 4 #14)
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived'))
  created_at, updated_at; INDEX (owner_id, state, updated_at DESC, id)
order_items        + config_id TEXT + configuration_snapshot TEXT; INDEX (config_id) WHERE config_id IS NOT NULL
community_requests + config_id TEXT;                              INDEX (config_id) WHERE config_id IS NOT NULL
```

### 3.4 Migration `personalization_social` (W4)

```
user_designs + share_token_hash TEXT (UNIQUE WHERE NOT NULL) + share_config_id TEXT + shared_at TEXT
design_batches                          -- roster | group | event (bulk, Part 4 #29/#30)
  id, owner_id → users, design_id → user_designs, product_id, kind CHECK (roster|group|event), base_config_id,
  vary TEXT '[]' (⊆ blueprint extras.roster.vary), join_token_hash UNIQUE, title ≤ 80, max_entries CHECK (1..200),
  closes_at (closed at read time when past — no cron, the storeHours rule), state CHECK (open|locked|committed|cancelled),
  committed_config_ids TEXT '[]', created_at, updated_at
design_batch_entries
  id, batch_id → design_batches ON DELETE CASCADE, author_id NULL (organizer-pasted), label ≤ 40,
  delta TEXT '{}' (vary fields only), qty CHECK (1..20), state CHECK (in|removed), created_at
  UNIQUE (batch_id, author_id) WHERE author_id IS NOT NULL
design_profiles                         -- the Brand Kit: user_id PK, brand TEXT '{}' {name, logo_key, colors[], style}, updated_at
community_posts + config_id TEXT        -- a public=1 redacted config → «Make it mine» (0153's kind CHECK is frozen)
follows + notify TEXT NOT NULL DEFAULT ''                      -- designs|colours; '' = quiet by default
merchant_material_stock + photo_key TEXT + finish TEXT NOT NULL DEFAULT ''   -- only if the materials track has not added them
```

### 3.5 JSON shapes (one owner: `packages/catalog/src/personalize`)

**BlueprintSpec v1**
- Size and count limits: ≤ 64 KB; regions ≤ 16 (vertex-shader colour array); areas ≤ 4 (one atlas, the WebGL1 varying budget); parts ≤ 64; sizes ≤ 4; finishes ≤ 8; slots ≤ 6; rules ≤ 24.

```
{ v:1, family:'stand', tags:['occ:birthday','for:kids'], sell:{cart:true, request:true},
  regions:[{id:'body', role:'body', parts:[0,1], tone:'primary',
            paint:{allowed:'stocked'|'all'|['black','white'], default:'black', premium:{gold:1000}},
            optional:null|{on:false, iqd:1500}, shown_by:null|'slot:lighting'}],
  areas:[{id:'name', kind:'text'|'logo'|'photo'|'qr', role:'name'|'text', region:'plate',
          frame:{o:[x,y,z], n:[..], u:[..], w:62, h:18},
          text:{lines:1..4, max:12, count:1..4, styles:'all'|[…], default_style:'bold', min_cap_mm:4,
                paint:{allowed, default}, sample:{ar:'علي', en:'ALI', ckb:'عەلی'}},
          logo:{max_colors:2, modes:['flat','raised']}, photo:{modes:['lithophane','relief','silhouette','print'], min_px_per_mm:5},
          qr:{kinds:['instagram','tiktok','whatsapp','website','menu','contact','url','reorder'], min_module_mm:1.0},
          make:'raised'|'engraved'|'painted'|'inlay', required:true, iqd:0}],
  sizes:[{key:'s', scale:0.8, iqd:-3000}, {key:'m', scale:1, iqd:0, recommended:true}, {key:'l', scale:1.25, iqd:6000}],
  finishes:[{key:'classic', material:'pla', iqd:0}, {key:'silk', material:'pla_silk', iqd:2000}, {key:'glow', material:'pla_glow', iqd:3000, paint:['glow','white']}],
  quality:null|{best_iqd:3000, days_add:1}, colors:{included:3, per_extra_iqd:1000, max:4}, themes:'all'|[…],
  slots:[{id:'magnet', kind:'magnet', required:true, qty:2, marker:'pockets'|null,
          options:[{src:'store'|'levonis', product_id:'cp_…', variant_id:null}], default:0}],
  rules:[{if:{slot:'magnet', is:1}, then:{size_at_least:'l'}, say:'big_magnet_needs_base'},
         {if:{text:'name', longer_than:10}, then:{size_at_least:'m'}, say:'long_name_needs_width'},
         {if:{finish:'glow'}, then:{region:'body', only:['glow','white']}, say:'finish_limits_colour'}],
  extras:{gift:{wrap_iqd:2000}|null, nfc:{kinds:[…], iqd:3500}|null, roster:{vary:['name','body'], max:200}|null, space:true},
  repeat:null, modules:null,              // reserved for W5
  prep_days_add:{best:1, l:1},
  private:{quality_notes:{value:'0.20 mm · 15 %', best:'0.12 mm · 20 %'}, notes:'…'} }
```

- `src:'levonis'` slot options are accepted by the shape but disabled until `components_levonis` is switched on after the owner's decision.
- Closed vocabularies live in `vocab.ts`:
  - 12 roles; 5 tones; 8 finishes; 6 styles (fun|gaming|elegant|kids|minimal|bold); 10 themes (gaming|fire|ocean|candy|pastel|mono|royal|fresh|sunset|cyber, each a tone → palette-key map); 4 sizes.
  - QR/NFC kinds; photo modes; families; occasions; recipients; 14 slot kinds; rule `say` codes.

**PublicBlueprint** (the guest projection of `spec`)
- Removed: `private`, areas' `make`, part names.
- Added:
  - product mini {id, slug, store_slug, name, price_iqd, prep_days};
  - mesh {url, hash, bytes, triangles, dims_mm};
  - look {poster_url, idmap, quads, camera};
  - stock per finish: palette key → `in` | `sub:<key>` | `out`, plus the stocked RGB triples and the shop's colour names — `null` when the shop tracks nothing;
  - slot options {product_id, variant_id, name, image, unit_iqd, in_stock};
  - printer {max_mm}, from_iqd, rev.
- Never included: a key, a cost, or merchant notes.

**DesignConfig v1** — the only thing a client sends: ids, palette keys, short text and the owner's asset keys; never a price.
- Limits: ≤ 16 KB, ≤ 32 KB with a roster.

```
{ v:1, p:'<product id>', rev:7, size:'m', finish:'silk', quality:'value'|'best', theme:'ocean'|null,
  colors:{body:'navy', base:'teal', name:'white'}, parts:{accessory:true},
  texts:{name:{value:['ALI'], style:'bold'}},
  logo:{logo:{key:'users/<uid>/design-assets/…', crop:[0,0,1,1], mode:'flat'}}|{}, photo:{…}|{},
  qr:{qr:{kind:'instagram', value:'ali.prints'}}|{}, nfc:null|{kind:'whatsapp', value:'+9647…'},
  slots:{magnet:{option:0}}, gift:null|{to:'Sara', message:'…', wrap:true, hide_price:true},
  roster:null|[{n:1, texts:{name:'SARA'}, colors:{body:'pink'}}], variant:null, parent:null, notes:'' }
```

- **Canonical form:** keys sorted, every declared control explicit, strings NFC.
- **Strict:** unknown keys or ids → `CONFIG_INVALID {path}`; any price-like key is refused.
- **Text rule:**
  - Letters (Arabic incl. Kurdish ە ۆ ێ ڕ ڵ ڤ, Latin), digits (Latin and Arabic-Indic), space and `. - ' & + ! ?`.
  - ZWNJ/ZWJ are kept.
  - C0/C1 controls, bidi overrides/isolates (U+202A–202E, U+2066–2069) and emoji → `DESIGN_TEXT_INVALID {path}`.
  - Grapheme count ≤ the area's `max`.
  - Decency (the nameGuard seed + the owner's `blocked_terms`) is checked at add, request and publish → `DESIGN_TEXT_NOT_ALLOWED`, never quoting the word.
- **Rosters** vary only the `roster.vary` fields and only unpriced fields. The engine splits entries whose unit price would differ into separate lines.

**Snapshot v1** (`order_items.configuration_snapshot`, written once in the place-order batch)

```
{ v:1, config_id, product_id, rev, mesh_hash, name, config:{…canonical…},
  words:{ar,en,ckb}, fitted:{name:{lines:['ALI'], cap_mm:11.2, frame_mm:[80,18]}},
  matched:{body:{swatch:'navy', stock_name:'Navy PLA Silk', material_id:'pla_silk', rgb:[31,45,92], in_stock:true}},
  price:{unit_iqd:30000, base_iqd:20000, adds:[{key:'size:l',iqd:6000},{key:'finish:silk',iqd:2000},{key:'slot:magnet',iqd:1000,qty:2}]},
  assets:[{n:0, kind:'logo'}], twin_code }
```

- No cost/floor/margin words (row 174's discipline).
- `rgb` is numeric, used by the 3D view only; merchant hex never reaches CSS (row 122).
- `option_snapshot` = the Arabic-first words line (≤ 200 characters), so every existing merchant list, receipt, invoice and chat order card shows the personalization with no code change.

**LookCard**
- `{poster_key (public, ≤ 400 KB like the layout poster cap), w:512, h:512, idmap (RLE region index per pixel at 256², ≤ 8 KB), quads:{areaId:[[x,y]×4]}, camera:[16]}`.
- Captured by the builder: a neutral grey render plus a flat ID pass read with `readPixels`.
- Rendered as pixel = poster luminance × region RGB, with each area's artwork warped affinely into its quad.

**Mesh**
- LVM1 byte-for-byte, then the trailer `'LVR1' | u16 parts | u16 0 | parts × (u32 start, u32 count)`. Part names are never in the file; today's `parseLvm` ignores the trailer.
- Parts are contiguous and coordinates are snapped to max(0.2 mm, longest/500).
- There is no stride decimation: a source over `max_triangles` is refused at compile (`BLUEPRINT_TOO_HEAVY {triangles, max}`), and hidden parts are removed at publish by range copy.
- Stored gzip via `CompressionStream` as `application/gzip` under the public key, served by `/files`, and inflated by `DecompressionStream` in the browser.
- Expected size ≈ 0.1–0.55 MB at 20–60k triangles.

### 3.6 Ownership and media references
- **Owners** (`marketplace`): `product_blueprints`, `design_configs`, `user_designs`, `design_batches`, `design_batch_entries`, `design_profiles`.
- **`MEDIA_REFERENCE_SOURCES`** — text: `product_blueprints.mesh_key`, `product_blueprints.draft_mesh_key`, `merchant_material_stock.photo_key`. JSON: `product_blueprints.source_keys`, `product_blueprints.look` (poster), `design_configs.spec` (logo/photo keys), `user_designs.draft`, `order_items.configuration_snapshot`, `design_profiles.brand`.
- **`NON_MEDIA_COLUMNS`:** `product_blueprints.spec/parts/analysis/tags`, `component_spec`, `vary`, `delta`, `notify`, `committed_config_ids`.
- **A bounded daily sweep** (≤ 500 rows, the existing scheduled jobs) deletes `design_configs` older than 30 days that nothing references: cart `color_id`, `order_items`, `community_requests`, `user_designs` (3 columns), `community_posts`, `design_batches`. The media sweeper then collects their now-orphaned assets.

## 4. API

### 4.1 Guards and gates
- **Server-authoritative:**
  - Ids in; prices, availability, merchant and customer come from the database.
  - Every write is one `db.batch` with an audit row.
  - Every answer carrying a configuration is `private, no-store`.
  - Anonymous GETs use `anonymousCached` with declared params.
  - «Waves» below = sequential D1 round trips.
- **Refusal codes:** every translated code gets ar/en/ckb (real Sorani) in `src/lib/refusalStrings.ts`. Its emitting file joins `tests/refusalStrings.test.ts` sources and each customer door joins DOORS. Sentences load on the first refusal.
- **Feature gate:** `personalizationOn(sub)` answers 404 when the feature is off. Admins and the product's own merchant can always preview. Pilot store ids apply to the store path (safe to cache: the store is in the path); pilot user ids apply to the community path (per viewer).
- **Community wall:** `/api/personalize` is mounted outside `/api/community`.
  - Commerce doors are **not** community-gated, so a store host sells customizable products while the community is closed: blueprint read, config mint, cart, checkout, own designs, own twins, the merchant builder, order summaries.
  - Doors that start community trade or publish mount `requireCommunityOpen`/`communityGate()` route by route (the `/api/marketplace` precedent): gallery, request exit, share, groups, publish, follow.

### 4.2 W1 doors

**Customer side (`worker/routes/personalize.ts`)**

| Door | Answer and guards | Cache | Waves | Rate |
|---|---|---|---|---|
| `GET /api/personalize/status` | `{on, may_use, may_build, cart, create, social}` | `anonymousCached {perViewer:true}`; purged by `pathsChangedBySetting` | 1 | — |
| `GET /api/personalize/blueprints/:productId?rev=` | PublicBlueprint; guests allowed. 404 `PERSONALIZATION_UNAVAILABLE` when not customizable, paused (without `rev`), dark, a private product, or the store is not servable/taking orders. | `anonymousCached {params:['rev']}`; purged on publish/pause and on the material-stock PUT (a one-line seam in `merchantPrinters.ts`); product edits age out within s-maxage like the product page | 2 (blueprint ⋈ product ⋈ store; then stock ∥ slot products ∥ `max_build_mm`) | session `personalize-read` 600/h |
| Mesh | The existing `GET /files/merchants/<uid>/public/bp/…` | edge + browser immutable | 0 | — |
| `POST /api/personalize/configs {product_id, configuration}` | `{config_id, twin_code, unit_iqd, adds, words, check, config}`. `requireAuth`. Strict normalise against the live revision + check (refuses `blocked`) + `ownedFileObject(['design_asset'])` + decency, then `INSERT OR IGNORE` by (owner, hash). The same lib (`mintConfig`) serves the add, request, share and publish doors. | private | 2–3 | `config-mint` 240/h |
| `GET /api/personalize/configs/:id` | Owner only, else 404: spec + words + live price + check | private | 2 | — |
| `GET /api/personalize/assets/:key+` | The owner's own design asset inline (nosniff, sandbox CSP, type from bytes). `requireAuth` + `ownedFileObject`; 404 otherwise. | private, no-store | 1 + R2 | 600/h |

**Builder (`worker/routes/merchantBlueprints.ts`)**
Mounted inside `/api/merchant` behind `requireStoreOwner`, `requireSellingPrivileges`, the entitlement and the gate. The product must be the caller's own, simple-mode and not private (else `BLUEPRINT_PRODUCT_INELIGIBLE`).

| Door | Behaviour | Refusals | Rate |
|---|---|---|---|
| `GET …/products/:id/blueprint` | `{draft, live, parts, mesh_state, warnings (merchant words), suggestions (roles from part names; grams per size = volume × scale³ × density)}` | — | — |
| `PUT …/blueprint/model {keys[1..12]}` | `ownedFileObject(['product_file'])` for each key ≤ `MODEL_MAX_BYTES` → `parseModelParts` → contiguous ranges → LVM1+LVR1 → gzip → private draft mesh. Runs inline like `deriveModelPreview`; `waitUntil` + polling `mesh_state` if staging CPU says so. | `BLUEPRINT_MODEL_UNREADABLE {format, hint}`, `BLUEPRINT_TOO_HEAVY` | `blueprint-derive` 20/h |
| `GET …/blueprint/mesh` | The owner's draft mesh, private no-store | — | — |
| `PUT …/blueprint/draft {spec}` | `normalizeBlueprint` + references: materials ∈ `printMaterials`; slot options are this store's live products with `component_use <> ''`; sizes fit `max_build_mm` | `BLUEPRINT_INVALID {errors:[{path, code}]}`, `BLUEPRINT_PRICE_INVALID`, `BLUEPRINT_COMPONENT_NOT_ELIGIBLE` | `blueprint-write` 120/h |
| `POST …/blueprint/publish {rev, look}` | Strict validation (poster included). The public mesh = draft minus hidden parts, written to the content-addressed public key. One batch: live → retired, draft(rev) → live fenced on state + rev (`ux_blueprint_live` makes two live revisions impossible), `from_iqd`, family/tags. Then purge the blueprint read and the product detail path on the store host and the apex. Audit `blueprint.published`. | `BLUEPRINT_NOT_READY {missing[]}` | 30/h |
| `POST …/blueprint/pause` | live → retired; open cart lines become `option_gone`; purge | — | — |
| `PATCH /api/merchant/products/:id` (existing) | `readProductInput` reads `component_use` and `component_spec` by name (unknown keys are ignored today) | — | — |

### 4.3 W2 doors

**`GET /api/personalize/gallery?family&occasion&for&budget&seed&cursor`**
- Answers cards {product_id, slug, store_slug, store_name, name, from_iqd, sell, look}.
- `communityGate()` is applied on the route, because the router is mounted outside `/api/community`.
- Visibility uses the lists' own SQL: `communityProductsVisible` + a live blueprint + the store taking orders (+ `accepts_custom_requests` for request-only blueprints) + `merchantBlockSql` for a signed-in member.
- ≤ 12 rows, exact `(published_at, id)` cursor, `anonymousCached` with declared params, 1 wave, 120/min.
- Magic = the top 6 by tag match within the budget; Surprise = a seeded pick (seed 0–999).
- The idea text and names never reach the server — only parsed tags.

**`worker/lib/qr.ts`:** `qrEncode(text, {ec:'M'|'Q'})`. M stays the default, byte-identical for warranty documents; printed codes use Q.

### 4.4 W3 doors

**`POST /api/cart/merchant-items`** (existing) gains `{configuration}` | `{config_id}` | `{design_id}`.
- Today's guards are unchanged.
- The configured branch reads the live blueprint, component facts and asset ownership in the same wave as today's reads, calls `mintConfig`, then writes `color_id = 'cfg:'||id`, `option_id = ''`.
- The existing `ON CONFLICT (user_id, community_product_id, option_id, color_id)` merges equal configurations and keeps different ones apart.
- Roster configurations upsert idempotently (qty = Σ entries).
- A customizable product added without a configuration gets the blueprint defaults, or `CONFIG_NEEDS_CHANGE {missing}` when a required area has no default.
- A configuration on a plain product → `CONFIG_NOT_ACCEPTED`.
- +0 waves.

**`PATCH /api/cart/merchant-items/:id`** + `{configuration}`
- Re-mints, then one batch: `UPDATE color_id` fenced on the old value, or merge into an identical line (`DELETE` + `qty` update, capped at 9999).
- A qty edit on a roster line → `QTY_FOLLOWS_ROSTER`.
- +1 wave.

**`GET /api/cart/merchant`** (existing): configured items gain `config {id, words, swatches[], look:{product_id, rev}}` — never an asset key. The studio's edit mode reads `GET /api/personalize/configs/:id`.

**Store checkout** (`POST /api/store-orders/quote` and `POST /api/store-orders`; contracts unchanged)
- `resolveCatalogLine`'s configured branch runs FIRST.
- `configRefOf` parses `cfg:` and the prefix is stripped before `merchantVariantLabel`/`merchantVariant`; a test pins that no other file contains the literal.
- unit = product price + Σ adds from the **live** revision and live component rows; label = the words.
- Children for store-own slots join the per-product and per-variant stock aggregation.
- Fingerprint v2 is unchanged.
- The place batch gains a live-revision fence: a publish or pause between quote and place → `CART_CHANGED`.
- The `order_items` INSERT gains `config_id` + `configuration_snapshot`. Children are rows at 0 IQD with `component_value_iqd` and `bundle_parent_item_id`.
- A private product minted from a configured request inherits its config through `origin_offer_id`.
- +1 wave only when a configured line has add-ons.

**Order reads and the product page**
- `GET /api/storefront/:slug/products/:productSlug` (existing) adds `customizable {rev, controls, from_iqd, poster_url}`, computed in the same `Promise.all` wave. It is absent when the feature is off, not piloted or not live. The public API DTO is unchanged (`stores.ts` maps extras field by field). The `d1Waves` ceiling and `storefrontIsolation` are asserted.
- `GET /api/orders/:id`, via a seam in `orders.ts`: items gain `configuration` (words, swatches, look ref; keys stripped).
- `GET /api/merchant/orders/:id`, via a seam in `merchantOrders.ts`: items gain `configuration` = `productionSummary` (words, fitted mm, stock names, QR payload + SVG path, NFC payload, gift, roster, asset door URLs), plus `children` folded under their parent.
- `GET /api/merchant/orders/:id/items/:itemId/assets/:n`: the order's store owner only (P10 later wraps it in `requireStoreAccess('orders')`). `attachmentResponse`, audited, 404 to anyone else, 600/h.

**Designs** (`requireAuth`, not community-gated)
- `GET /api/personalize/designs?tab=saved|made&cursor`: exact cursor, ≤ 24. «made» = the caller's store lines with a `config_id` ∪ community orders whose request carries one.
- `POST` (blank | from_config_id); `PUT /:id` (autosave, lenient; fenced on `updated_at` → `DESIGN_CHANGED`); `DELETE` (archives).
- `DESIGN_LIMIT` (the design quota); bucket `design-write` 600/h.

**Twin**
- `GET /api/personalize/t/:code` → `{owner:bool, product:{store_slug, product_slug}, design_id?}`. Strangers get the product only. no-store; `twin-resolve` 120/h per IP.
- Reorder = the add door with `{config_id}`. A choice the live revision no longer offers → 409 `BLUEPRINT_CHANGED {migrated}`.

**Request exit** (`requireCommunityOpen` + `requireAuth`)
- `POST /api/personalize/requests {config_id|configuration, qty ≤ 50, deadline?, governorate?, note?}` → `{request_id, chat_id}`.
  - Preconditions: the blueprint sells by request, or the verdict is review; the store accepts custom requests; `merchantTakesNewWork`; not the caller's own store.
  - Flow: `mintConfig` → `openStoreThread` → `directRequests.createAndSend`. `createAndSend` is extracted from chatCommerce's two route bodies, behaviour-preserving, with the chatQuotes and chatPrivateProducts suites unchanged.
  - It writes `config_id` and job fields from `specFromConfiguration` (title, dims × scale, colour count, material from the finish, quantity), plus the print_request card with the words in the same batch. Revision 1 records the facts.
  - Refusals: `STORE_NO_CUSTOM_REQUESTS`, `MERCHANT_UNAVAILABLE`, `OWN_STORE_PURCHASE`, `CONFIG_*`.
  - ≈ 4 waves; bucket `chat-print-request` 10/h (shared).
- `PUT /api/personalize/requests/:rid/config`: owner only, while draft | open | receiving_offers. Re-mint + `reviseIfOfferedStatement` + `supersedeStatement` + `recordRevisionStatement` in one batch. `REQUEST_NOT_OPEN`, `REQUEST_CHANGED`.
- `GET /api/personalize/requests/:rid/config` via `requestFileAccess`:
  - owner, admin, engaged or direct target → full;
  - a board-eligible merchant → masked (texts → {len, script}; logo/photo → present; qr/nfc → kind; gift → present);
  - anyone else → 404.
- `GET …/requests/:rid/assets/:n`: audited in `request_file_reads` (`what='original'`).
- `requestRevisions`: the config hash is appended to `canonicalFacts` **only when non-null**, so every existing `factsHash` is unchanged (pinned).

### 4.5 W4 doors
- **Share:** `POST|DELETE /api/personalize/designs/:id/share` issues or revokes a 32-byte token, stored as sha256. The shared copy is a frozen, redacted config: Wi-Fi and contact always dropped; logo/photo only if the owner keeps them. Bucket 30/h.
  - `GET /api/personalize/shares/:token` (+ `/assets/:n`): no-store, never edge-cached.
- **Remix:** `POST /api/personalize/designs {from_share|from_post}` keeps look, size, finish and slots; texts reset to the blueprint samples; logo/photo/qr/nfc/gift/roster are dropped; `parent` = the source config.
- **Publish:** `POST /api/personalize/designs/:id/publish {title, body, show_name, show_logo, media[]}` (`requireCommunityOpen`) creates a public=1 redacted config and a `community_posts` row through the posts service's own insert helper (D2/D11 media checks), with decency on a shown name. It never happens automatically.
- **Batches:** `POST /api/personalize/batches`; `GET|PUT|DELETE /batches/:id`; `POST /batches/:id/entries` (paste ≤ `max_roster`).
  - `GET /api/personalize/g/:token` and `POST …/g/:token/entries`: vary fields only; `GROUP_CLOSED` / `GROUP_FULL` / `GROUP_FIELD_LOCKED`; 30/h per user, 500/h per group.
  - `POST /batches/:id/commit {to:'cart'|'request'}` groups roster configs by unit price into cart lines (usually one) or ONE request with quantity = entries. The organizer pays.
- **Brand kit:** `GET|PUT /api/personalize/profile {brand}`.
- **Follow opt-in:** the existing store-follow route gains `notify:['designs','colours']` (a seam). A publish fans out, after the response, ONE grouped notification per follower per store per day (key `store_new_design:<store>:<day>`), capped like `printMatchNotifyLimit`.

### 4.6 Refusal codes

**Customer** (ar/en/ckb):
`PERSONALIZATION_UNAVAILABLE`, `BLUEPRINT_CHANGED {migrated}`, `CONFIG_INVALID {path}`, `CONFIG_NEEDS_CHANGE {codes|missing}`, `CONFIG_NOT_ACCEPTED`, `DESIGN_TEXT_INVALID {path}`, `DESIGN_TEXT_NOT_ALLOWED`, `DESIGN_ASSET_NOT_OWNED`, `DESIGN_TOO_LARGE`, `COMPONENT_UNAVAILABLE {slot, alternatives}`, `QR_TARGET_INVALID`, `QTY_FOLLOWS_ROSTER`, `ROSTER_TOO_LARGE`, `DESIGN_NOT_FOUND`, `DESIGN_CHANGED`, `DESIGN_LIMIT`, `GROUP_CLOSED`, `GROUP_FULL`, `GROUP_FIELD_LOCKED`.

**Merchant:**
`BLUEPRINT_MODEL_UNREADABLE`, `BLUEPRINT_TOO_HEAVY`, `BLUEPRINT_INVALID`, `BLUEPRINT_PRICE_INVALID`, `BLUEPRINT_NOT_READY`, `BLUEPRINT_PRODUCT_INELIGIBLE`, `BLUEPRINT_COMPONENT_NOT_ELIGIBLE`, `BLUEPRINT_LOCKED`.

**Reused, not re-worded:**
`CART_CHANGED`, `OUT_OF_STOCK`, `STORE_CLOSED`, `OWN_STORE_PURCHASE`, `CART_SELLER_CONFLICT`, `OPTION_UNAVAILABLE`, `STORE_NO_CUSTOM_REQUESTS`, `MERCHANT_UNAVAILABLE`, `COMMUNITY_CLOSED`, `REQUEST_NOT_OPEN`, `REQUEST_CHANGED`, `PRODUCT_FILE_NOT_OWNED`, `POST_MEDIA_NOT_OWNED`, `NOT_FOUND`, `RATE_LIMITED`.

**Engine check codes** are UI words in the feature strings, never HTTP errors:

| Group | Codes |
|---|---|
| fixed (price-neutral) | `TEXT_FITTED`, `TEXT_TWO_LINES`, `TEXT_STYLE_BOLDER`, `COLOR_MATCHED`, `COLORS_MERGED`, `CONTRAST_FIXED`, `QR_ENLARGED`, `LOGO_SIMPLIFIED` |
| suggest (priced, one tap) | `SIZE_UP_FOR_TEXT`, `SIZE_UP_FOR_QR`, `SIZE_UP_FOR_ADDON` |
| review | `LOGO_DETAIL`, `PHOTO_LOW_RES`, `PHOTO_NEEDS_CUTOUT` |
| blocked | `TEXT_TOO_LONG`, `COMPONENT_OUT`, `COLOR_OUT` |

### 4.7 Invariants (each pinned by a named test)

| # | Invariant |
|---|---|
| I1 | Price = f(live revision, config choices, live component rows), computed only in the configured branch; price-like keys are refused. |
| I2 | Configs are immutable and owner-scoped. Equal configs merge, different ones stay apart, another user's config id → 404. The `cartUpsert` and `cartIdentityContract` pins stay unchanged. |
| I3 | A publish or pause between quote and place → `CART_CHANGED`. |
| I4 | Children are same-store lines at 0 IQD with provenance: stock fenced at placement, restocked on cancel, never from another store. |
| I5 | Design-asset keys appear only in the owner's responses (`personalizePrivacy` walks every answer for `users/` and `merchants/` key patterns). |
| I6 | No customer data in any edge-cached body (`storefrontIsolation` extended). |
| I7 | Board merchants see masked configs. |
| I8 | Publication is explicit and redacted, with per-field consent; photos are never public. |
| I9 | A twin code reveals the owner's data to the owner only. |
| I10 | Capability tokens are hashed, revocable and capped, and limited to vary fields. |
| I11 | Text sanitation and decency apply at every door. |
| I12 | Customer vocabulary: no CAD/slicer/mesh words (`customerVocabulary`). |
| I13 | Dark by default: every door answers 404 with the switch off. |
| I14 | Live revisions are immutable; at most one live revision per product. |
| I15 | Automatic fixes never change the price. |

## 5. Client

### 5.1 Chunks and budgets

Gzip-9, as `bundleBudget` measures; estimates until built.

| Chunk | Budget | Notes |
|---|---|---|
| `viewer-core` (`src/lib/viewer/{lvm,scene,pick,shaders,xr}.ts`, extracted from ModelViewer) | ≤ 6 KB | Shared. ModelViewer's total stays ≈ 7.4 KB (±0.3). |
| `vendor-webgl` | ≤ 17.8 KB | +ogl `Texture` ≈ 2.0 KB; no Raycast, Text or GLTFLoader. |
| `personalize-engine` (`packages/catalog/src/personalize/*`, incl. the Cairo advance table) | ≤ 8 KB | Shared by studio, builder and Create. |
| `Personalize` (studio core + strings) | ≤ 20 KB | |
| `viewer-decals` | ≤ 3 KB | |
| `lookcard` | ≤ 2 KB | |
| `PersonalizeExtras` (W2) | ≤ 10 KB | |
| `CustomizeDoor` | ≤ 0.4 KB | The only static addition to the storefront closure; it dynamically imports the studio. |
| `BlueprintBuilder` | ≤ 28 KB | Lazy inside ProductEditorSheet's Disclosure, the ProductFilesEditor precedent; `BlueprintDoor` ≤ 1.5 KB; workspace shell/closure unchanged. |
| `Create` | ≤ 12 KB | |
| `Designs` | ≤ 10 KB | |
| `TwinResolve` / `SharedDesign` / `GroupJoin` | ≤ 5 KB each | |
| `ProductionSummary` | ≤ 6 KB | |
| `ConfiguredLine` | ≤ 1.5 KB | |
| `ConfiguredItem` | ≤ 2 KB | |

**Fixed budgets**
- **CSS:** +0 B. Only classes already in the built sheet (verified: `lv-choice`, `lv-swatch`, `lv-card`, `lv-button`, `bg-canvas`, `bg-surface(-raised)`, `text-text-*`, `border-border-subtle`, `text-success/warning`, `snap-x/snap-start`, `overflow-x-auto`, `touch-none`, `overscroll-contain`, `grid-cols-4/5`, `min-h-[44px]/[48px]`, `size-11`, `start-3/end-3/bottom-3`, `lg:grid-cols-2`, `lg:sticky`, `sm:max-w-5xl`, `max-w-6xl`, `rtl:rotate-180`).
  - One-off geometry goes in inline styles (the Toast pattern). Test fixtures follow the same rule, since Tailwind scans `tests/browser`.
  - Every workflow's acceptance runs a class diff against the dist CSS. Any unavoidable token names its payback in the same PR (row 176's `SalesTabs.OrdersTab` retirement is the known source).
- **Entry:** +0 in W1; +≤ 0.15 KB in W2 (`/community/create`); +≤ 0.25 KB in W3 (`/designs`, `/t/:code`); +≤ 0.2 KB in W4 (`/d/:token`, `/g/:token`).
- **Storefront closure:** +≤ 0.4 KB in W3, i.e. ≤ 44.6 of 47 KB with P6's HostBar.
- **OrderDetailScreen:** +≤ 0.2 KB, staying under its 12 KB pin.
- **Cart:** +≤ 0.5 KB. Initial payload unchanged.
- **Budget lists:** every new chunk joins «a chunk of its own». `Personalize`, the engine, decals and the look card join the storefront lazy-only and entry never-static lists.
- **Cold open:** ≈ 57 KB JS + 3–12 KB of blueprint JSON + 0.1–0.55 MB of mesh, fetched in parallel after the tap.

### 5.2 Rendering

**One viewer core**
- ModelViewer.tsx becomes a thin page over the core with identical behaviour, strings and `data-viewer` hooks; `e2e-print-request-ui` stays green.
- The core keeps `WEBGL_lose_context` on close, the WebXR path and the true-scale AR.

**Regions**
- A per-vertex Uint8 part attribute maps to a region index through `uniform vec3 uRegion[16]`, indexed in the **vertex** shader (dynamic indexing is guaranteed safe there in GLSL ES 1.00).
- Recolouring = one uniform write, one draw call.
- Finish parameters are sheen (silk/shiny), emissive (glow) and roughness.
- Accessory marker parts are visible only while their slot has an option.

**Decals**
- ≤ 4 areas share one 1024² canvas atlas (ogl `Texture`).
- Projective coordinates, the region mask and a facing test are computed per area in the **vertex** shader (≤ 7 of WebGL1's 8 varyings). The fragment shader only samples the atlas, which fits WebGL1's 16 fragment vec4.
- Text is drawn with `fillText` in the page's self-hosted Cairo after `document.fonts.load(font, text)`, so browser shaping and bidi give real Arabic and Sorani.
- The six styles are presets of weight, tracking, outline, shadow and skew. Per-glyph jitter applies only to non-joining scripts.
- Logos are posterised; QR modules come from `qrEncode`; lithophane previews as a back-lit grayscale plate.

**Picking and loading**
- Picking is our own Möller–Trumbore test over the Float32Array (≈ 1 KB, < 5 ms at 60k triangles): triangle → part (binary search over the LVR1 ranges) → region → editor.
- Tapping «Customize» starts, in parallel: the studio chunk, viewer core, vendor-webgl and engine; the blueprint JSON; and the font load.
- The look card paints at once. The mesh fetch starts as soon as its URL is known, and the canvas cross-fades in when `data-studio="ready"`.

### 5.3 Engine and automation

The engine is pure and lives in `packages/catalog/src/personalize/*`. The Worker imports it through `@levonis/catalog/personalize/*`.

**Surface compiler (`surface.ts`)**
- Slot 1 = the main content: name > photo > logo > text > qr.
- Slot 2 = Look, when any region offers ≥ 2 colours or themes apply.
- Slot 3 = Size, when there are ≥ 2 sizes.
- Empty slots are promoted from finish › QR › add-ons; More appears only when something is left.
- Save/share never appear in the control row.
- Tested over 30 generated blueprints, with five archetypes pinned:

| Archetype | Compiled controls |
|---|---|
| Name stand | Name · Look · Size · More |
| QR menu stand | Logo · Look · QR · More |
| Request-only photo lamp | Photo · Size · Text |
| Name keychain | Name · Look · More |
| Group participant | Name · Look |

**Door rule**
- **blocked** → the door is disabled and the fix chip shows.
- **review** → «Request printing» (community open and the store takes requests), else «Ask the shop» (P6's StoreDoor ask).
- **ready/adjusted** → «Add to cart» when the blueprint sells by cart, else «Request printing».

**Smart Fit (`fit.ts`)**
- A pure loop over a committed, conservative Cairo advance table. `scripts/cairo-advances.mjs` measures weights 300–900 once in Chromium, taking the maximum advance across contextual forms, so browser and Worker decide identically.
- Order: one line at the largest size → balanced wrap up to the area's lines → a bolder style when strokes are thin → a priced suggestion to size up → blocked.
- The minimum cap height comes from the blueprint. `measureText` only centres.
- An e2e calibration check asserts table ≥ measured for ar/en/ckb samples.

**Checks and automatic fixes (`check.ts`)**
- Fixes are price-neutral and explained in one line; a priced fix becomes a one-tap suggestion showing +IQD.
- QR readability is analytic: module ≥ `min_module_mm` at the chosen size, quiet zone inside the frame, contrast ≥ 3:1 between the QR colour and its background part.
- Also checked: photo px/mm, logo colour count, and colours over the blueprint's maximum (merged to the nearest).
- Rules adjust automatically only when price-neutral.

**Colour (`color.ts`)**
- Palette RGB/Lab as numeric triples; a test pins them equal to `swatches.css`.
- Nearest stocked filament per finish by Lab ΔE.
- The 3D view shows the stocked RGB; the UI shows palette keys with names.

**Choose for me and Make it better (`themes.ts`, `suggest.ts`)**
- «Choose for me» is seeded and picks among themes whose colours are all stocked for the finish, with text contrast ≥ 3:1, matching family/occasion, never the current one. «Try another» = seed + 1.
- «Make it better» uses closed codes (CONTRAST_TEXT, STOCKED_ONLY, FEWER_COLOURS, STYLE_FOR_LENGTH, BALANCE_ACCENT, LOGO_FIT, THEME_MATCH) and shows the top suggestion only, with undo.

**Idea parser (`idea.ts`, W2)**
- `interpretIdea(text, lang) → {family, colors, name, occasion, recipient, quantity, leftover, confidence}`, built from ar/en/ckb lexicons: palette names and synonyms, family and occasion words, and name markers «باسم», «with the name», «بە ناوی».
- It sits behind an Interpreter interface an AI implementation can replace later; nothing depends on AI.

**Price and words**
- `price.ts`: unit = base + size + finish + quality + Σ filled optional areas + premium colours + max(0, colours − included) × per_extra + Σ slot option unit × qty + gift wrap + NFC. Golden test: 20,000 + 2 × 1,000 + 5,000 + 8,000 = 35,000 IQD.
- `summary.ts` + `vocab.ts` produce the words in ar/en/ckb: 22 colour names (the ckb words live here, `palette.ts` is untouched), 10 themes, 6 styles, 8 finishes, 2 qualities, 4 sizes, 12 roles, 14 add-on kinds and the check sentences.

**State**
- `useStudio` is a reducer over the canonical config. Every change runs normalise → surface → price → check synchronously (< 2 ms). Undo is client-only.
- Autosave: a signed-in customer's draft is saved with PUT, debounced 2 s and only when it changed. A guest's draft lives in `localStorage` per product (in try/catch) and is offered once after sign-in.
- Modes are derived, never chosen: buy · edit · preview · view · request · participant.

### 5.4 Strings, motion, accessibility, tests

**Strings**
- Files: `src/components/personalize/strings.ts`, `personalize/create/strings.ts`, `merchant/catalog/blueprint/strings.ts` (row 169 assumed yes) and `vocab.ts` — all with real Sorani.
- The five labels reuse existing human Sorani: ناو · ڕەنگەکان · قەبارە · زیاتر · زیادکردن بۆ سەبەتە · داوای چاپکردنی بکە.
- Nothing new goes into `src/components/ui` or the shell.

**UI tests**
- `tests/personalizeUi.test.ts`: key parity; ckb ≠ ar ≠ en; ≥ 90 % Kurdish letters; no OWNER marker; tokens only; no hex; no `dark:`; logical utilities; no native dialogs; no `motion` proxy; lazy-only.
- `tests/customerVocabulary.test.ts` closes gap G1. It walks every customer strings file, `vocab.ts` and the new refusal sentences in three languages for STL/3MF/OBJ/mesh/polygon/triangle/vertex/slicer/infill/nozzle/layer/support/G-code/extruder/CAD/manifold and their ar/ckb forms. Merchant files are exempt.

**Motion**
- Everything goes through `useMotion()`, with `m.*` under `<MotionFeatures>` wherever a closure can be first paint; the storefront door imports no motion.
- Panel swaps use SPRING.ui; sheets use Sheet v2's own spring; in-sheet page pushes use SPRING.move or CROSS_FADE.
- Colours lerp in the render loop over ≈ 150–180 ms.
- Under reduced motion: no Orbit inertia, no idle turntable, no pulse, the camera jumps, colours switch instantly.
- No invented durations and no infinite animations.

**Accessibility**
- The canvas is `role=img` with a live sentence; every tap-on-the-model action has a list twin.
- Targets are ≥ 44 px; price and verdict are `aria-live`.
- Escape closes only the top sheet and focus returns to the trigger; RTL comes from logical utilities.

**Test hooks:** `data-studio`, `data-control`, `data-verdict`, `data-door`, `data-region`, `data-sheet`, `data-more-row`, `data-fit-lines`, `data-colors`, `data-config-hash`, `data-price-iqd`, `data-spin`.

**Acceptance (Playwright)**
- `tests/browser/personalize.{html,-fixture.tsx}` builds a real 3-part gzip LVM1+LVR1 in the page and answers the API locally.
- `scripts/e2e-personalize.mjs` runs 360/1280 × ar/en/ckb × dark/light, with reduced motion ON and OFF as two full passes. It checks:
  - `data-studio=ready`;
  - exactly the compiled controls (archetype A = 5, B = 4);
  - typing «علي» and «ناوی» updates `data-fit-lines`;
  - «Choose for me» changes `data-colors`;
  - a tap at the reset camera's centre opens the body's editor;
  - More rows equal the declared list;
  - the add body carries `configuration` and no price key;
  - `?gl=off` and `?dstream=off` show the look card;
  - no horizontal overflow, no page errors, landmarks present;
  - no forbidden vocabulary in visible text.
- Plus `e2e-blueprint-builder.mjs` (W1), `e2e-create.mjs` (W2), `e2e-personalize-store.mjs` and `e2e-designs.mjs` (W3), and `e2e-share.mjs`/`e2e-group.mjs` (W4).

## 6. Phases with file ownership

**Gates, in order, for every workflow:**
1. `npm run check`
2. `npm run test:unit`
3. `node scripts/migrate-check.mjs --twice`
4. `npm run build` + `tests/bundleBudget.test.ts` (CSS ≤ the previous phase; entry and storefront closure within the stated deltas)
5. The workflow's Playwright scripts, plus `e2e-print-request-ui`, `e2e-catalog` and `e2e-store-builder` unchanged
6. A DECISIONS row at the next free number + a section in `docs/PERSONALIZATION.md`
7. Deploy dark after the owner's word

The owner flips the switches in this order: builder pilots → cart (pilot stores, then everyone) → create/request → social.

**Integrator-only seams** (one-line-scope edits; builds serialised): `worker/index.ts`, `worker/lib/schemaVersion.ts`, `packages/contracts/src/ownership.ts`, `worker/lib/mediaRefs.ts`, `worker/lib/settings.ts` (+ the admin PUT normaliser), `worker/lib/entitlements.ts`, `worker/lib/uploadEntity.ts`, `worker/lib/edgePolicy.ts` (`pathsChangedBySetting`), `src/lib/refusalStrings.ts` + the `tests/refusalStrings.test.ts` lists, `src/App.tsx`, `vite.config.ts`, the `tests/bundleBudget.test.ts` lists, `worker/lib/notifications.ts` (W4), `docs/DECISIONS.md`.

| Wave | Lane A (running programmes) | Lane B (this track) | Why here |
|---|---|---|---|
| 0 | Commit community Phase 5 (client half) + merchant P4/P5 | — | A stable base: next free migration 0162, `max_build_mm` landed. |
| 1 | Community 6 | **W1** Blueprints, engine, studio core — dark | Disjoint files. W1 merges before community 7, since both touch ProductEditorSheet. |
| 2 | Merchant P6 (XL, 3 PRs) | **W2** Studio extras and Create — dark | Edits none of P6's files: StorefrontProduct, storefront.ts, orders.ts, chats.ts, chatCommerce.ts, chatCards.ts, printRequests.ts, RequestWizard, PrintRequestSheet, OrderDetail, OrderTracker. |
| 3 | Community 7 | **W3** The two commit paths, My Designs, the twin | After P6 has settled its files; before P7 (merchantOrders, OrderDetailScreen, storeOrderOps) and P8 (storeOrders coupon scope), which rebase on it. The StorefrontProduct door is a one-file PR rebased after community 7's draft-preview change, with the closure measured in that PR. |
| 4 | Merchant P7 | **W4** Many, shared, social | Needs community 6 (reports/hide) and 7 (collections/activity). Disjoint from P7. Wave 5 beside P8 if community 7 slips. |
| 6 | Merchant P9 | — | P9 extends W3's `readRequestPrefill()` for `?project=` and rebases the Requests.tsx door. |
| 7+ | P10, P11 | **W5** Parts, parameters, upgrades (owner-gated) | After the owner's component-money answer, P10's roles, P11's engine convergence, and the materials and Levo Project contracts. |

### W1 «Blueprints, engine, studio core — dark» (XL · 10 builders + integrator · migration `personalization_core`)

| Builder | Files | Tests |
|---|---|---|
| B1 Engine | `packages/catalog/src/personalize/{types,spec,config,canonical,surface,price,rules,fit,styles,themes,color,check,suggest,summary,vocab,index}.ts`; `scripts/cairo-advances.mjs` + the committed table | `personalize{Spec,Config,Surface,Price,Rules,Fit,Check,Themes}` |
| B2 Geometry | `worker/lib/modelGeometry.ts`: additive `parseModelParts` (3MF `<components>` with composed transforms and per-object names/colours; OBJ o/g/usemtl; glTF nodes, transforms and names; one STL per part by stored bbox), with `analyseModel`/`viewerMesh` byte-identical. NEW `worker/lib/personalize/compile.ts` | `blueprintCompile` + `modelGeometry` probes A–C; existing pins and `printQuoteGeometry` green |
| B3 Schema & store | `migrations/<next>_personalization_core.sql`; `worker/lib/personalize/{blueprints,configs,stock,access}.ts` | `personalizeSchema`: lock trigger, ≤ 1 live, immutability, private product refused |
| B4 Routes | NEW `worker/routes/personalize.ts` and `worker/routes/merchantBlueprints.ts`; `worker/lib/catalog/product.ts` (component keys); one-line purge seam in `worker/routes/merchantPrinters.ts` | `personalizeRoutes`, `blueprintRoutes`, `personalizePrivacy` (I5/I6/I13) |
| B5 Viewer core | NEW `src/lib/viewer/{lvm,scene,pick,shaders,xr,decals}.ts`, extracted from `src/pages/ModelViewer.tsx` | `viewerCore`; `e2e-print-request-ui` green |
| B6 Studio core | NEW `src/components/personalize/{Studio,ControlRow,NamePanel,LookPanel,SizePanel,MoreSheet,PaletteSheet,ConfirmSheet,ReadyLine,PriceLine,SceneFallback,lookcard,useStudio,api,strings}.tsx|ts`, mounted only by the builder preview and fixtures | `personalizeUi`, `customerVocabulary` |
| B7 Builder | NEW `src/components/merchant/catalog/blueprint/{BlueprintDoor,Builder,capture,api,strings}.tsx|ts` + `steps/*`; ONE Disclosure in `ProductEditorSheet.tsx` (builder door, «Can be used inside printed products», kind and sizes) | `blueprintBuilderUi` |
| B8 Browser | `tests/browser/{personalize,blueprint-builder}.*`; `scripts/e2e-{personalize,blueprint-builder}.mjs` | the full matrix |
| B9 · B10 | Adversarial review (money, public-mesh privacy, key leaks, bytes) · fixer | — |

- **Acceptance:** both e2e scripts green on the full matrix; CSS ≤ the previous phase; storefront closure and entry unchanged; every door 404 with the switch off.
- **Integrator seams:** migration + schemaVersion; ownership (2 tables); mediaRefs; 2 mounts in `worker/index.ts`; `personalizationConfig`; `customizableProducts`; the `design_asset` purpose + quota; the purge map; refusal strings + lists; the viewer-core chunk name; bundleBudget lists; docs + DECISIONS.

### W2 «Studio extras and Create — dark» (M–L · no migration)

| Builder | Files | Tests |
|---|---|---|
| B1 Extras | `src/components/personalize/extras/{LogoPage,PhotoPage,QrPage,NfcPage,GiftPage,AddonsPage,FinishPage,RealSizePage}.tsx`; engine `{logo,photo,qr,nfc}.ts` (posterise, background knock-out, photo modes, analytic QR); `worker/lib/qr.ts` EC option | `tests/qr.test.ts` extended: M default byte-identical |
| B2 Create | NEW `src/pages/community/Create.tsx` + `src/components/personalize/create/{IdeaBox,IdeaGrid,MagicSheet,SurpriseCard,PhotoStart,strings}.tsx|ts`; engine `idea.ts` | `ideaParse` (ar/en/ckb corpora), `createUi` |
| B3 Gallery | The gallery door in `worker/routes/personalize.ts` | `personalizeGallery`: visibility SQL, block, cursor, declared cache params, no names in keys |
| B4 Browser | `scripts/e2e-create.mjs`; `e2e-personalize` extended (extras pages, look-card fallback) | — |
| B5 | Review + fixer | — |

- **Integrator:** App.tsx route `/community/create` inside CommunityGate; refusal strings; bundleBudget lists.

### W3 «The two commit paths, My Designs and the twin» (XL · 10 builders · migration `personalization_commerce`)

| Builder | Files | Tests |
|---|---|---|
| B1 Pricer & cart | `worker/lib/catalog/lines.ts` (configured branch first); NEW `worker/lib/personalize/lineConfig.ts` (`configRefOf`, joins, `configuredLine`, children, words); `worker/routes/cart.ts` (add, patch, idempotent roster, cart shape) | `personalizeMoney`; `cartUpsert`/`cartIdentityContract` extended with their pins unchanged |
| B2 Checkout | `worker/routes/storeOrders.ts` (children, stock aggregation, live-revision fence, INSERT `config_id` + snapshot, private product inherits the config) | `personalizeCheckout`: forged price keys, another user's config, publish between quote and place, child stock race, cancel restocks children, receipts/invoices list parents. `storeCheckoutIntegrity`, `catalogCheckout`, `storeOrderCancel` unchanged |
| B3 Store door & cart UI | `worker/routes/storefront.ts` (summary in the same wave); `src/pages/StorefrontProduct.tsx`; NEW `src/components/personalize/{CustomizeDoor,ConfiguredLine}.tsx`; `src/pages/Cart.tsx`; `src/components/merchant/MerchantCartView.tsx` | `storefrontIsolation` + `d1Waves` assertions |
| B4 Orders | `worker/routes/merchantOrders.ts` (projection, children folded, order-scoped asset door); `worker/routes/orders.ts`; NEW `src/components/personalize/merchant/ProductionSummary.tsx` (artwork PNG, QR SVG, print job sheet); one lazy mount in `OrderDetailScreen.tsx`; `src/pages/OrderDetail.tsx` («View in 3D», «Order again») | — |
| B5 Request path | NEW `worker/lib/directRequests.ts`, extracted from `worker/routes/chatCommerce.ts` (behaviour-preserving); `worker/lib/requestRevisions.ts` (config hash only when non-null); NEW `worker/lib/personalize/requestPath.ts`; the request doors | `personalizeRequests`: revision + supersede, masking, asset door, no board leak; `chatQuotes`/`chatPrivateProducts` unchanged |
| B6 Request UI & doors | The request variant of ConfirmSheet; lazy `ConfiguredItem` in `src/pages/community/Request.tsx` (no new `data-request-section` — the requestPageUi pin) and `CustomOrderScreen.tsx`; the print_request card shows the words (`chatCards.ts` seam); the two-card door in `src/pages/Requests.tsx` view `new` + `readRequestPrefill()` (router state) | — |
| B7 Designs & twin | Design/twin doors; `worker/lib/personalize/{designs,twins,sweep}.ts`; NEW `src/pages/personalize/{Designs,TwinResolve}.tsx`; studio autosave; the QR «Reorder link» kind | — |
| B8 Browser | `scripts/e2e-personalize-store.mjs` (customize → confirm → add → edit from cart → checkout body has no price → production summary); `e2e-create` extended (request exit); `scripts/e2e-designs.mjs` | — |
| B9 · B10 | Adversarial money/privacy review · fixer | — |

- **Acceptance:** storefront closure ≤ +0.4 KB; OrderDetailScreen ≤ 12 KB; the product read keeps its `d1Waves` ceiling.
- **Integrator seams:** migration + schemaVersion; `user_designs` ownership; mediaRefs; App.tsx `/designs` and `/t/:code` outside CommunityGate; customer refusal strings + sources/DOORS; the sweep job registration; bundleBudget; docs + DECISIONS.

### W4 «Many, shared, social» (L · migration `personalization_social`)

| Builder | Scope |
|---|---|
| B1 | Shares & remix («Make it mine»); `src/pages/personalize/SharedDesign.tsx` |
| B2 | Inspiration: publish through the posts service's helper; «Make it mine» as one line each in `src/components/community/feed/PostCard.tsx` and `src/pages/community/Project.tsx` (community seams, rebased last); made-first ranking stays inside the existing feed |
| B3 | Roster & bulk: split by unit price; the roster branch in `cart.ts`; RosterSheet paste; roster CSV for the merchant |
| B4 | Groups & events: batches; `src/pages/personalize/GroupJoin.tsx`; organizer views in Designs |
| B5 | Brand kit & vault: `design_profiles`; «See it on» look cards of blueprints tagged `biz`; the vault = the user's design_asset objects + derived names and colours |
| B6 | Follow opt-ins (`follows.notify`; the `store_new_design` grouped kind) + reading colour photos |
| B7 | Pin mode: the studio's view mode emits `{part, p, n}` anchors in blueprint millimetres; where they are stored belongs to the Levo Project track |
| B8 | `scripts/e2e-share.mjs`, `scripts/e2e-group.mjs` |
| B9 · B10 | Review · fixer |

- **Integrator:** migration; ownership; mediaRefs; notification kinds; App.tsx `/d/:token` and `/g/:token` inside CommunityGate; refusal strings; bundleBudget.

### W5 «Parts, parameters, upgrades» (owner-gated, wave 7+)
- Levonis-catalogue slot options, per the owner's money decision.
- Sizes bound to variants (`variant` is already reserved in the config shape).
- Parametric repeats (instanced parts at a declared pitch) and stretch regions, with a rules editor.
- Upgrades and modules from the twin, with the Levo Project track.
- An approximate «in your space» overlay where WebXR is absent, only with the owner's agreement.
- B′ generated production geometry (raised text/logo relief traced from the client's mask, lithophane heightmaps as a 3MF), handed to the production track. The snapshot already carries frames, strings, fitted mm and colours.

## 7. Trade-offs

1. **Identity in `color_id` (`'cfg:'||config_id`) instead of a new column + index swap.**
   - Won: the existing index, ON CONFLICT merge and fingerprint v2 work unchanged during the migrations-before-code window.
   - Cost: an overloaded column name, confined to `configRefOf` plus a literal-scan test.
2. **Immutable, owner-scoped configuration rows instead of JSON copied onto each door.**
   - Won: one tamper-proof, deduplicated identity across cart, order, request, twin, share and roster.
   - Cost: a mint step inside each door, and a bounded daily sweep.
3. **Immutable revisions (≤ 1 live) with prices always read from the live revision.**
   - Won: price edits apply at once, and snapshots always re-render what was produced.
   - Cost: a line's price can move before checkout, exactly as variant prices do, and a publish between quote and place dies at the fence.
4. **Customizable ⇒ simple mode in v1.**
   - Won: one pricing path, and no region × colour × text explosion against 3 groups / 100 variants.
   - Cost: no per-size stock (product stock caps capacity).
5. **The browser prices with the same pure engine.**
   - Won: zero round trips per tap on Iraqi networks.
   - Cost: modifier amounts are public (they are customer-facing anyway); a republish mid-session answers the new unit at add.
6. **Painted decals, not raised geometry.**
   - Won: correct Arabic/Sorani shaping today with no font parser, shaper or dependency, and live typing.
   - Cost: the preview is flat. The copy says «preview», and the merchant gets mm frames, strings, 20 px/mm artwork and a vector QR.
7. **A public, hole-free mesh up to 60k triangles on `/files` instead of viewer grants.**
   - Won: fast, 0 D1, cached at the edge and in the browser.
   - Cost: the merchant's shape at preview fidelity is public (an owner question), and heavier models are refused rather than decimated.
8. **`application/gzip` + DecompressionStream instead of HTTP Content-Encoding.**
   - Won: no dependency on the runtime's encoding behaviour and no edit to the shared `/files` door.
   - Cost: browsers without it (iOS < 16.4) get the look card.
9. **One viewer core extracted from ModelViewer.**
   - Won: honours the one-viewer rule and reuses AR.
   - Cost: W1 touches a stable page, with its behaviour, strings and hooks pinned identical.
10. **The look card instead of per-add uploads or offscreen WebGL thumbnails.**
    - Won: cart, cards, fallback and merchant card render any configuration in 2D with no WebGL contexts.
    - Cost: one fixed view with affine warps; a merchant without WebGL uploads a photo poster instead.
11. **Smart Fit from a committed, conservative advance table.**
    - Won: browser and Worker agree exactly, so the server can refuse.
    - Cost: a long name may wrap or thicken slightly earlier than a pixel-exact fit would.
12. **Automatic fixes never change the price.**
    - Won: trust and server authority.
    - Cost: one extra tap for «Large fits your name (+5,000)».
13. **Store-own add-ons as 0-IQD child lines.**
    - Won: one seller, one ledger, existing stock fences, restock on cancel, invoices' child skip.
    - Cost: Levonis-catalogue parts wait for the owner's decision (W5).
14. **Rosters inside one configuration (one line per unit price).**
    - Won: bounded batches and one production sheet.
    - Cost: entries are edited in the roster sheet, not line by line in the cart.
15. **Blueprints are store-only (cart or a direct request).**
    - Won: no licensing system in v1.
    - Cost: board printing by other merchants waits for Part 4 #12/#13.
16. **Direct QR payloads, plus an optional reorder link to the twin.**
    - Won: printed objects never depend on a redirect service.
    - Cost: targets cannot be changed after printing.
17. **Commerce doors outside the community wall; creation, request and social doors inside.**
    - Won: store hosts keep selling customizable products while the community is closed.

## 8. Open questions for the owner

1. **Levonis-catalogue components inside a merchant's personalized product.** Proposed default (a): the part is priced live into the merchant's line and the merchant buys it separately, with an in-stock check but no reservation. Alternative (b): Levonis sells the part inside the same order — two sellers, which breaks the one-seller cart triggers and the goods-only commission, and needs `planInventory` reservation. W1–W4 ship store-own components only.
2. **Public preview exposure.** The merchant's parts at ≤ 60k triangles, snapped to 0.2 mm, public and immutable. Acceptable, or should guests see only the look card until they sign in?
3. **Is publishing customizable products a paid benefit?** A `'plus'` entitlement, like every merchant tool, or open to every selling merchant?
4. **Guests and uploads.** May guests customize and see prices, with sign-in required to add and to upload a logo or photo (proposed: yes)?
5. **Printed names.** Run the platform decency filter (the nameGuard seed + the owner's `blocked_terms`) at add, request and publish (proposed: yes, never quoting the word), or leave it to the merchant?
6. **NFC Wi-Fi and contact payloads** are visible to the merchant who programs the tag. Allow them with a notice (proposed), or offer links only?
7. **Group and event orders.** The organizer pays for every copy in v1. Is per-participant payment wanted later (it touches wallet/escrow rules)? And may group participants join without an account?
8. **Printability floors.** Raised text cap height 4 mm, engraved 3 mm, painted 2.5 mm, QR module 1.0 mm, photo 5 px/mm. May a merchant override them per blueprint? And may «Best look» and larger sizes add production days?
9. **Closest-colour substitution** happens automatically with a one-line note (proposed). Should the customer be asked each time instead, and may a shop opt out?
10. **Silhouette and pet photo products** have no background removal, so they always go to the shop's check. Acceptable, or leave them out of v1?
11. **Gift «hide the price».** Only the merchant's packing slip and printed receipt (P7's invoices), or the customer's own receipt too?
12. **Who seeds the first blueprints** (pilot merchants, or a Levonis-run starter store) so Create does not open empty? And is store-only licensing right for v1?
13. **Retention.** Design assets are kept while a saved design or order references them, with a 500 MB per-user default. And row 169: real Sorani in the builder's merchant strings (assumed yes)?

## 9. Interfaces with the sibling Programme C tracks

- **Merchant templates & components.** The builder UI and the component flag columns may be owned there. The shared contract is BlueprintSpec v1 + the engine + `product_blueprints`: one component flag, never two. Part-only hidden components need that track's PART predicate at checkout, because today's live-product fence refuses hidden products.
- **Levo Project.**
  - The request id is the project id, and `community_requests.config_id` + the revision loop are the configuration's place in a project.
  - This track emits the `{part, p, n}` anchor shape; that track stores anchors in discussion comments or order updates.
  - The twin read (`/t/:code`, the Made tab) is this track's; warranty, replacement parts and upgrades are that track's.
- **Production.** `productionSummary(snapshot)` is the job card's content. B′ generated 3MF consumes the snapshot's frames, strings, fitted mm and colours.
- **Materials.** `merchant_material_stock.photo_key/finish` (colour photos, calibration) is read by the palette sheet when present. Matching is always presented as approximate.

GRAFTS: ["P1 → first paint: exactly five controls. The lead panel (Name) is open and inline at first paint, and no suggestion shows until a change the engine can improve. Save/share/start-over live in the (...) overflow menu, never beside the controls.","P1 → the engine chooses the door, never the customer. Blocked: the door is disabled and a fix chip shows. Review (detailed logo, low-resolution photo): «Request printing» when the community is open, else «Ask the shop». Ready/adjusted: «Add to cart» when the blueprint sells by cart, else «Request printing».","P1 → the host is a full-screen Overlay over the product page (?customize=1, Back closes, dirty guard), rendered in the app portal like SellerConflictDialog so app tokens apply on store hosts. This replaces P3's Sheet v2 host, whose drag competes with orbiting.","P1 → one viewer core extracted from src/pages/ModelViewer.tsx into src/lib/viewer/*, with ModelViewer's behaviour, strings and data-viewer hooks unchanged. Decals live in a separate module so ModelViewer's download does not grow. This replaces P3's fresh scene module.","P1 → product-page door: a one-line capability summary («Customizable: name · colours · 3 sizes») and «Customize it» as the buy bar's primary. It is a dynamic import on tap costing ≤ 0.4 KB of storefront closure; quantity moves out of the buy bar.","P1 → customizable products must be simple-mode in v1, and a trigger refuses blueprints on 0152 private products.","P1 → analytic QR readability (module ≥ 1.0 mm at the chosen size, quiet zone fits the frame, filament contrast), with qrEncode gaining an EC option: default M stays byte-identical for warranty documents, printed codes use Q.","P1 → the request sheet (how many, needed by, delivery governorate, note, «the shop confirms the price in your chat») and the minimal public twin page (product, store, «Make one like this»; never a name, photo or owner).","P1 → a private product minted from a configured request inherits its configuration at store checkout through origin_offer_id, so the merchant's order still carries the full specification.","P1 → text rule that keeps ZWNJ/ZWJ for Sorani and refuses bidi controls and emoji (the readTrackingNo rule, row 177(9)). Also from P1: the customerVocabulary test closing gap G1, the «Size in real life» SVG card, the Save-Data gate on the mesh, and the data-* test hooks.","P2 → the surface compiler: a pure, unit-tested rule that turns any blueprint into ≤ 4 controls + 1 door. Slot 1 is the main content (name > photo > logo > text > QR), slot 2 Look, slot 3 Size, empty slots are promoted from finish › QR › add-ons, and More appears only when something is left.","P2 → the brief's Confirm step as a sheet. It shows a look card of this exact configuration, the summary words the maker will receive, each automatic fix in one line, quantity and «Why this price». Quantity lives here, not at first paint.","P2 → at ≥ 1024 px an inline 380 px inspector at the inline end replaces bottom sheets, and More rows become closed Disclosures.","P2 → the LOOK CARD: poster, a region id map and area quads, captured automatically at publish. It renders any configuration in 2D for the no-WebGL/Save-Data fallback, cart lines, Create/Magic/brand-kit cards, My Designs rows and the merchant card. This replaces both P1's per-add preview uploads and P3's offscreen WebGL thumbnails.","P2 → the mesh trailer carries part ranges only, never part names; names stay merchant-only in product_blueprints.parts.","P2 → the 3D view shows the shop's real stocked filament RGB while swatches show palette keys with names; «colours on screens are approximate» is said once per sheet.","P2 → roster entries may differ only in unpriced fields; entries whose price would differ are split into separate lines by unit price.","P2 → merchant exports and hints: artwork PNG at 20 px/mm, QR SVG, NFC payload, roster CSV, and a gram hint per size in the builder.","P2 → mesh_state with inline derive, falling back to waitUntil plus polling if staging shows the CPU limit bites. Also from P2: the 35,000 IQD golden price test, an always-available «Ask the shop for changes» row in More, and role suggestions from part names in the builder.","P1 → the owner's own design-asset door (GET /api/personalize/assets/:key+), because /files answers 404 for private users/<uid>/ keys. Also from P1: the per-viewer status door, with pilot lists kept out of PUBLIC_SETTING_KEYS."]

REJECTED: ["P3's fresh scene module (≈ 150 duplicated lines of orbit/XR code): it is a second viewer against the one-viewer rule. Replaced by one core extracted from ModelViewer.tsx.","P1's R2 contentEncoding=gzip through /files: the /files door copies metadata with writeHttpMetadata and returns without encodeBody:'manual', so the runtime may encode the body again. Fixing that would mean editing the shared door. Store application/gzip and inflate with DecompressionStream instead.","P1's fflate gzip in the Worker: tests/store-isolation.test.ts pins fflate imports to four files. Use the Worker's native CompressionStream instead.","P2's dedicated mesh route with caches.default and encodeBody manual: /files already serves merchants/<uid>/public/* as public, immutable, edge-cached, Range-capable and with 0 D1. A second file-serving path is duplication.","P1's template source as product_files rows: GRANTED_ROLES opens source_model/download_after_purchase files to every buyer, and the rows would appear in the storefront's file list. The blueprint references private product_file keys instead.","Stride decimation of the public blueprint mesh (all three proposals): dropping whole triangles punches holes in the surface the customer inspects. Sources above max_triangles (default 60,000, an admin setting) are refused at compile with guidance to export a lighter model; hidden parts are stripped at publish.","P1's 20k public-mesh cap: at 20k the product itself shows holes after decimation. Superseded by the 60k cap; the exposure question goes to the owner.","P2's smart links (object_tags, redirect QR codes with targets editable after printing): printed objects would depend on levonis-iq.com forever, it opens an open-redirect/phishing surface through a trusted domain, and it raises scan-privacy questions. v1 prints direct payloads plus an optional reorder link to the twin.","P2's idle prefetch of the studio chunk and blueprint JSON on every customizable product view: it spends data on Iraqi networks for visitors who never tap. Fetch on tap and paint the poster first.","P2's Name editor in a bottom sheet: on a phone the keyboard plus the sheet cover the model. Name edits inline under the canvas.","P2's Save/Share icons in the studio header at first paint: they break the five-control rule. They move to the overflow menu; drafts autosave.","P2's ≤ 8 decal anchors: WebGL1 only guarantees 16 fragment vec4 uniforms and 8 varyings. The synthesis allows ≤ 4 content areas and computes the projection in the vertex shader.","P2's ckb colour names added to packages/catalog/src/palette.ts: that shared file sits under the OWNER convention and the storefront consumes it. The ckb colour words live in the engine's vocab.ts; palette.ts is untouched.","P1's cart_items.configuration column and P2's cart_line_configs side table: both copy JSON onto the cart. Replaced by P3's immutable, owner-scoped design_configs referenced from color_id. That gives one identity across cart, order, request, twin, share and roster, with no cart column and no CART_LINE_COLUMNS edit.","P1's automatic size bump («20 mm needs Large — we switched it»): it silently changes the price. Automatic fixes never change the price (P3); a priced fix becomes a one-tap suggestion showing +IQD, and a forcing option shows its combined delta before the tap.","P1's group entries as N cart lines (pages of 50): 200 names would mean 200 lines, heavy checkout batches and 200 production cards. A roster inside one configuration becomes one line per unit price.","P1's trigger-locked community_request_designs: a customer could never reconfigure a sent request. Use community_requests.config_id inside the existing revision loop (reconfigure = new revision, stale offers superseded).","jsqr decoding of the rendered QR (P2/P3): it costs the 46.6 KB vendor-qr chunk, and decoding our own perfect render proves nothing about the printed object. The analytic check covers the real physical risks.","P3's QuantityInput beside «Add to cart» at first paint: it moves to the Confirm sheet.","Silently dropping unknown configuration keys (P1): the canonical object must be exactly what the customer saw. Unknown keys and ids are refused (CONFIG_INVALID {path}) and price-like keys are refused loudly.","Fingerprint child tuples (P3): the config id in color_id and the unit already move with every choice and every price change, and children derive from the config. Fingerprint v2 stays unchanged.","Putting the parsed name/colours in the product URL (P1 Create → ?customize=1 with prefill): names would enter history, logs and referrers. The prefill travels in router state only.","P1's twin code minted at placement: a printed «reorder» QR could not be exact in the preview. The code is minted with the immutable configuration.","P2's community_blueprint_tags side table: at gallery scale a family column plus a tags JSON array filtered with json_each is enough. Revisit when the scale demands it.","P2's size-to-variant binding in v1: it adds a second pricing path to the money path on day one. Deferred to W5, with `variant: null` reserved in the configuration shape.","Board printing of a store's blueprint by other merchants, in any proposal: it needs licensing/royalties (Part 4 #12/#13). Blueprints stay store-only (cart or a direct request to the same store)."]

### Judge's scores — customer-personalization

| Criterion | P1 · simplicity-first | P2 · capability-first | P3 · systems-first |
|---|---|---|---|
| Simplicity for the customer (five-control rule) | **5** — The first paint has exactly five controls, with the lead field already open. Save, share and start-over sit in the overflow menu. The engine shows one contextual suggestion at a time and chooses the door itself. This is the tightest reading of the brief's rule. | **4** — The surface compiler guarantees at most four controls plus one action for any blueprint, and it adds the brief's Confirm step. But Save and Share icons appear at first paint, Name opens in a sheet that covers the model, and a «Better» chip on the stage loosens the rule. | **4** — Four value tiles, a Name field inline under the canvas that the keyboard never covers, and a «Make it better» chip that appears only when it has something to offer. A quantity stepper and info icons at first paint make it slightly busier than P1. |
| Power for the merchant | **3.5** — A clear four-step builder, and a production card with fitted mm and stock matching. But there are no immutable revisions, rules and photo modes wait for W2/W3, and group orders become N cart lines for the maker. | **5** — The deepest merchant side: look-card capture, gram hints per size, artwork PNG at 20 px/mm, QR SVG, roster CSV, sizes that can bind to variants, and rules from day one. | **4.5** — Live revisions are immutable, quality notes stay private, there is a print job sheet, and reconfiguring a request is an ordinary revision with stale offers superseded. Production polish is a little behind P2. |
| Reuse of what exists | **4** — Keeps `idx_cart_merchant_line`, fingerprint v2, the 0058 child lines and one viewer core extracted from ModelViewer. It adds a `cart_items.configuration` column and uses `product_files` rows as the template source. | **3** — One viewer core, but several new mini-systems beside what exists: `object_tags` smart links, a vault table, a tag side table, a cart side table, and its own mesh route next to `/files`. | **4.5** — One configuration value that every door references: cart `color_id`, order line, request, twin, share and roster. It reuses the request revision/supersede loop and extracts `directRequests` from chatCommerce. Only the fresh scene module duplicates viewer code. |
| Budgets (bytes, CSS, D1 waves) | **4.5** — Measured. CSS +0 by using only existing classes, storefront closure +0.4 KB, entry +0 in W1, a cold open of about 51 KB with the mesh fetched in parallel, +0 D1 waves at add. | **3.5** — CSS +0 and every surface lazy, but it idle-prefetches the studio chunk and the blueprint on every customizable product view, and studio plus extras reach about 34 KB. | **4.5** — Measured against today's dist. A 1.5 KB door, `d1Waves` ceilings asserted, and CSS +0 backed by a class list verified with an extractor. |
| Security and money soundness | **3.5** — Ids only, a template fence at placement, text sanitation and asset ownership are all sound. But referencing `product_files` rows as the template source lets `GRANTED_ROLES` hand the merchant's source model to buyers. It also bumps a priced size automatically, drops unknown keys silently, and mints twin codes only at placement. | **3.5** — The server quote at Confirm and the price-uniform copies rule are good. The editable redirect QR through levonis-iq.com opens an open-redirect/phishing surface, and emoji are removed silently rather than refused. | **5** — Fourteen named invariants, each pinned by a test. Immutable configs and revisions with at most one live revision, automatic fixes that never change the price, strict canonical configs, board masking and per-field publish consent. |
| Mobile-first | **4.5** — The panel sits under a canvas sized to 52 % of the visual viewport, so the model stays visible while typing. The full-screen overlay avoids drag conflicts with orbiting. | **3.5** — The 1280 inspector is good, but on a phone the Name sheet puts the keyboard over the model. | **4.5** — Keyboard-aware inline Name, a `touch-none` canvas and poster-first loading. The Sheet v2 host competes with orbit drags; handle-only dragging mitigates it. |
| Feasibility on Workers/D1/ogl | **3** — Relies on R2 `contentEncoding: gzip` passing through `/files` (a runtime auto-encoding risk the author flags himself), a new fflate import that the store-isolation test pins against, and stride decimation to 20k triangles, which punches holes in the product being previewed. | **4** — CompressionStream, parts-based regions and measured compression. But up to 8 decal frames exceeds WebGL1's guaranteed 16 fragment vec4, and its own mesh route with `caches.default` duplicates what `/files` already does. | **4.5** — `application/gzip` plus `DecompressionStream` avoids runtime re-encoding, CompressionStream avoids fflate, and the committed Cairo advance table makes browser and Worker decide Smart Fit identically. Stride decimation remains. |
| Schedule fit with the running programmes | **3** — Puts the whole store money path, the StorefrontProduct door and merchantOrders edits into wave 1 beside a P6 that owns StorefrontProduct. W1 becomes XL and needs collision management. | **4** — Dark builder first, cart after P6, community last. Collisions are clean, but Part 1 (the brief's first part) arrives last, in wave 5. | **4.5** — Dark core in wave 1 before community 7, both commit paths in wave 3 after P6 and before P7/P8, social in wave 5. This matches the survey's interleaving, and the direct-request extraction sits correctly after P6. |
| **Total (of 40)** | **31** | **30.5** | **36** |

---

## Track — merchant-templates-components (judged synthesis; the judge chose Proposal 2 (systems-first) as the spine)

# Merchant customizable products, parts and build recipes: the synthesised design

**Track** «merchant-templates-components».

**What it is built from**
- The spine is Proposal 2 (systems-first) for the catalogue and money model.
- Proposal 1 (owner-first) supplies the grafts for the merchant experience, the economics and the schedule.
- The judge added corrections, each verified read-only against the tree on 2026-09-30.

**Measurements** (dist built 11:54, gzip-9 as `tests/bundleBudget.test.ts` measures):

| Chunk | Size |
|---|---|
| CSS total | 60,964 of 61,440 B (476 B headroom) |
| Entry | 67,912 B |
| ProductEditorSheet | 9,629 B |
| OrderDetailScreen | 7,344 B |
| CommandCenter | 15,652 B |
| AnalyticsSection | 11,071 B |
| StorefrontProduct | 6,706 B |
| Product | 41,798 B |
| vendor-webgl | 15,629 B |

**Code words**
- «blueprint» is what the merchant defines.
- «configuration» is what the customer chose.
- Neither word appears in worker/, src/, packages/ or migrations/, apart from decoration in the Auth UI.
- The admin switch keeps the brief's word: `customizationConfig`.

---

## 1. Concept

**The merchant sets it up.** A merchant makes any store product customizable from the product editor. They upload the file they already print: a Bambu/Prusa 3MF with named parts, an OBJ with groups, a multi-solid STL, or up to 12 part files. The Worker finds the parts, their names, file colours and weights, draws a parts map, and switches on what the customer may change.

**The blueprint.** The result is a blueprint: an immutable, versioned document.
- It annotates the product's own variant groups. Size, Look and Good Value/Best Look keep their price, stock, SKU and pictures on the 0126 variants.
- Through slots, kits and fixed parts, it points at the store's own part products.
- A part product is an ordinary community product marked «used inside printed products». It is usually hidden («inside products only») and can be created from a Levonis item in one sheet.

**Pricing.** One pure module turns a configuration made only of ids into a normalised, priced, rule-checked line. The customer's sheet runs it for an instant price. The Worker runs it again at add, cart read, quote and place.

**The order.** A configured line is one cart row and one order row. Its summary rides `option_snapshot` into every existing screen, receipt and chat card. Every part unit it takes is recorded in `order_item_parts`, decremented by the checkout's own fences, and put back by a cancel trigger that mirrors 0126 §9.

**Production and cost.** The merchant gets a production card: colours per part, text, QR/NFC payloads, parts taken, gift note. The second workflow adds a Build Recipe («What's used in this product?»):
- It is priced through one engine B adapter.
- It gives cost, profit, a live simulator and cost snapshots on orders.
- Committed filament is derived at read time.

**What the customer sees:** Name · Look/Colours · Size · More · Add to cart. Everything else belongs to the merchant.

---

## 2. Screens

Drawing conventions:
- Drawn left-to-right for legibility; ar/ckb mirror through logical utilities (ps/pe/start/end).
- Every class named below exists in the built CSS: lv-choice(+mark), lv-swatch, lv-alert-info/-warning, divide-y divide-border-subtle, grid-cols-2..5, lg:grid lg:grid-cols-2 lg:gap-6 lg:sticky lg:top-6, sm:max-w-5xl, aspect-square, aspect-[4/3], min-h-[44px], tabular-nums, snap-x, overflow-x-auto, bg-surface-raised.
- One-off sizes (canvas and still heights, column bases) are constant inline styles, the Toast pattern.
- `tests/blueprintUiTokens.test.ts` proves no new utility class was introduced.
- Customer colour chips are always `lv-swatch data-swatch=<palette key>` plus the merchant's colour name, plus a photo from W3. An exact filament hex is used only inside a canvas (DECISIONS 122, `storefrontIsolation.test.ts`).

**S1 · Product editor, 360.** ProductEditorSheet, Sheet v2, large detent. This is the only entry point.
```
┌────────────────────────────────────────┐
│ ‹ Edit product                  [Save] │
│ [photos/video strip]                   │ MediaEditor (unchanged)
│ Name [Controller stand             ]   │
│ Price [20,000] IQD · [Draft|Published] │
│ ▸ Options & variants  3 sizes · 2 looks│ existing VariantEditor = the price/stock axis
│ ▾ Customization   On · v7 · ✓ Ready    │ NEW Disclosure testId="customize"
│   ● Body ● Base  Aa Name  Magnet ×2    │ lv-swatch chips + words
│   [ Set up ]                           │ Button secondary → lazy BlueprintBuilder (stacked)
│ ▸ Used inside printed products   Off   │ NEW testId="part" → lazy PartFacts
│ ▸ Pricing & inventory                  │ W2: «What one costs you — only you see this»
│ ▸ What's used in this product?  (W2)   │ NEW testId="recipe": «≈35 g PLA · cost 4,100 · profit 79%»
│ ▸ 3D-printing details · Collections · Files │ unchanged
└────────────────────────────────────────┘
```
A new or unsaved product shows «Save the product first» inside Customization, the rule the Files section already follows.

**S2 · Builder, 360.** Lazy BlueprintBuilder, Sheet v2 large, stacked over the editor. Its footer is the HealthStrip.
```
┌────────────────────────────────────────┐
│ ‹ Customize · Controller stand  [Save] │
│ ┌────────────────────────────────────┐ │ W1: private parts-map still, parts tinted like their chips
│ │  parts map                 [⤢ 3D]  │ │ W2: customer track's shared scene in pick mode
│ └────────────────────────────────────┘ │ aspect-square rounded-2xl bg-surface-raised
│ Your file · 3 parts        [Replace]   │ or UploadTile (purpose product_file) / «use a product file»
│ ● Body 62% · ● Base 31% · ● Name 7%    │ chips → RoleSheet (S4)
│ What can your customer change?         │
│ [✓Name ] [✓Colours] [✓Size ]           │ grid grid-cols-3 gap-2, lv-choice aria-pressed,
│ [ Look ] [ Logo   ] [✓Add-ons]         │ switched on from the file: a part named name/text → Name;
│ [ QR   ] [Tap-phone] [ Photo ]         │ ≥2 parts → Colours; a size group or bbox → Size
│ ▸ Name     on «Name» · up to 12 letters│ one prefilled Disclosure per switched-on tile
│ ▸ Colours  from my shelf · 9 colours   │
│ ▸ Size     S · M ⭐ · L · XL ✕ too big │ SizesCard (S6)
│ ▸ Add-ons  Magnet ×2 (must) · Light    │ SlotSheet (S5)
│ ▸ Rules    3 automatic · 1 mine        │ switches + «+ rule» three-field sentence sheet
│ ▸ More     gift · extra days · photos  │
├────────────────────────────────────────┤
│ ✓ Ready · customer pays 20,000–38,000  │ HealthStrip; ⚠ «Large doesn't fit your printers» [Fix]
│ [Preview as customer]          [Save]  │
└────────────────────────────────────────┘
```
«Preview as customer» draws the surface outline in W1: the five controls and what each sheet offers. From W2 it renders the customer track's Customizer with the draft spec. With no model, «Customers see the product photos» appears and the list does everything.

**S3 · Builder, 1280.** Sheet v2 as a centred window (`sm:max-w-5xl`), body `lg:grid lg:grid-cols-2 lg:gap-6`.
- Left column (`lg:sticky lg:top-6`): the still or scene, the parts list (divide-y) with role, file colour and share, and a Segmented [Front|Top|Back] for the selected text or logo anchor.
- Right column: the tiles (grid-cols-5), then the cards.
- Header: «v7 · saved 2 min ago», [Preview as customer] and [Save].
- RoleSheet and SlotSheet become Overlay `Anchored` panels beside the row from 1024 up.

**S4 · RoleSheet**, Sheet medium (Anchored ≥1024).
```
│ ━━━  What is this part?                │
│ Part 3 · 7% of the model · «Text» in your file │
│ [Body][Base][Name][Text][Border]       │ grid grid-cols-5 gap-2 lv-choice
│ [Accent][Logo][Icon][Insert][Accessory]│
│ ( ) Customers can't change this part   │ role «fixed»
│ Starts as ● White (from your file)  ›  │ → colour list from the shelf
│                               [Done]   │
```

**S5 · SlotSheet («Add-ons»)**, Sheet medium/large.
```
│ ━━━  Magnet                            │
│ What goes in [Magnet ▾]  How many [2]  │ Select · NumberInput 1–20
│ Must have one ●   Customer chooses ●   │ Switch ×2
│ Customer pays [Part price | Included]  │ Segmented (included = difference only, never negative)
│ ☑ Round magnet 10×3   in stock   500   │ lv-choice rows, filtered by kind
│ ☑ Round magnet 15×3 ⭐ in stock  1,000  │ ⭐ = default
│ ☐ Round magnet 20×5  ⚠ bigger than the │ fit from part_spec dims vs the anchor/size
│   others · [Only with Large]           │ adds the rule «20 mm → Large» in one tap
│ [+ New part] [From Levonis] [+ Kit]    │
│ Show on the model [None|Spot|Glow|Part]│ rendered by the customer scene
│                               [Done]   │
```

**S6 · SizesCard.** The size axis is a variant group.
```
│ Size group [ Size ▾ ]  (from Options & variants) │ or [ Add sizes ]: drafts S/M/L at ×0.8/×1/×1.35
│ S   80×60×90 mm    15,000   ✓ fits             │ of the price, rounded to 250, through the product's
│ M⭐ 100×75×112     20,000   ✓ fits             │ own write gate (PATCH variant_model)
│ L   125×94×140     26,000   ✓ fits             │ dims editable; fit = fitsInBuild over merchant_printers
│ XL  160×120×180    32,000   ⚠ too big — hidden │ auto rule, merchant may override
│ Look group [ Look ▾ ]  Classic → PLA · Silk → PLA Silk │ annotates look + material per value
```

**S7 · Parts.**
- **PartFacts**, a Disclosure in the editor:
  - Switch «Used inside printed products».
  - Kind [Magnet ▾], Shape [Round ▾], Ø [10] mm, height [3] mm.
  - One row per option value (10 mm · Ø10 › / 15 mm · Ø15 ›).
  - Install [Press-fit ▾], minutes [2].
  - Segmented [In my store too | Inside products only], which sets publish_state hidden.
  - «From Levonis: N52 magnet ↗ [Restock]» and «Used in 3 customizable products».
- **FromLevonisSheet**, Sheet large; at 1280 `lg:grid-cols-2`, list and detail:
  - Kind chips in a Segmented row (overflow-x-auto snap-x) and a search box.
  - Rows from the Levonis parts door; pick options, set «your price» and «you have».
  - [Add to my parts] creates one hidden part product with variants.
- **KitSheet**: name (ar/en/ckb), members (part · option · qty), price [Sum | Fixed].

**S8 · Catalogue list** (CatalogManager).
- A Select «All · Customizable · Parts» sits beside the existing filters (contract query word `kind`).
- Row chips: «Customizable» or «Part · used in 3».
- The header Menu adds «From Levonis» and «Kits»; W2 adds «Library».

**S9 · Customer add-ons.** The component ships in W1, pinned by a fixture. The customer track mounts it from «More». It is Sheet medium at 360 and inline in the customizer's side panel from 1024.
```
│ ━━━  Add-ons                           │
│ Magnet · 2 included                    │ native radios in lv-choice rows
│  (•) 10 mm                 included    │
│  ( ) 15 mm                 +1,000      │
│  ( ) 20 mm  makes it Large  +7,000     │ picking it bumps the size and says so
│ Light                                  │
│  (•) No light   ( ) White light +3,000 │
│  ( ) Colour light — not now · White?   │ disabled + one-tap nearest alternative
│ Motor  [+ Add]  Motor A     +8,000     │
│ Total 35,000 IQD              [Done]   │ tabular-nums, aria-live=polite
```
The customer screen always starts with at most five controls (`surfaceOf`). Add-ons live inside More unless a primary place is free. A required slot shows one line under the price («Magnet 15 mm ×2 · Change»).

**S10 · Production card on a store order.** The merchant's OrderDetailScreen gets one lazy LineSpec mount under each configured line.
```
│ Controller stand ×1           35,000 IQD │ existing row; option_snapshot = the summary:
│ Large · Silk Blue/Black · «ALI» · Magnet 15 mm ×2 · RGB light │ same text in list, chat, receipt
│ ▾ Production card                        │
│  Size L · 150×90×110 mm · Silk (PLA)     │
│  ● Body Silk Blue  ● Base Black  ● Name White │ lv-swatch + merchant colour names
│  Name «ALI» · Gaming · ≈ 9 mm tall       │
│  QR  instagram · ali.prints     [QR SVG] │ server-built payload, qrToSvgPath
│  Tap-phone  WhatsApp +9647…     [Copy]   │
│  Parts  Magnet 15×3 ×2 · RGB module ×1 (taken from stock) │ from order_item_parts
│  Gift  to SARA · «…» · leave the price out │
│  W2: Filament 42/20/3 g · Glue · Felt ×4 · Steps (3) · Checks (4) │
│  W2: Used [42][20][3] g [Save] · Profit ≈ 21,300 (61%) (owner) · [Print] │ orderPrint stylesheet
```
At 1280 the card splits into two columns (`sm:grid-cols-2`): «Make» (size, colours, text, QR/NFC, parts) and «Prepare» (hidden materials, steps, checks, files, actuals).

**S11 · W2 · What's used (RecipeSheet).**
- At 360 (Sheet medium/large):
  - KpiTile ×3: cost 4,100 · price 20,000 · profit 79%.
  - «Estimated from your file · M», with StatusChip info and «I weighed one».
  - Filament per part (follows the customer's colour · PLA · grams).
  - Fixed parts, read-only from the blueprint.
  - Hidden materials as quick-add chips (+Glue +Screws +Insert +Packing) with cost only.
  - Time: printing ≈1 h 35 m, assembly [10].
  - Steps and quality checks, a floor [Warn|Never below cost], and ▸ Profit simulator.
- At 1280 (`lg:grid-cols-2`):
  - Left: the editors.
  - Right: KpiTile ×4 and a DataList per variant (variant · grams · minutes · cost · price · margin).
- The simulator:
  - Sliders (lv-range accent-gold) for price, grams and minutes, with an aria-live result.
  - «Where it goes: filament 630 · machine 1,100 …» in merchantQuote words.
  - No animation and no network.

**S12 · W2 · Filament panel and library.**
- The Filament panel lists the shelf lines with price/kg (and where the figure came from), look, brand, a Levonis link, and «≈ 120 g committed».
- The Library opens from the catalogue Menu as a Sheet: [Models | Customizable | Parts | Kits | Recipes] in a Segmented row that scrolls on a phone. DataList cards offer «Duplicate as new».

**S13 · W3.**
- **«Use in a printing project»** on a Levonis product page (only when the product is a printed part). It opens a Sheet with three lv-choice rows: «Add to my draft request», «Start a new request with it», «Products made with it ›».
- **PartsStep** in the request composer: kind chips, rows with option and QuantityInput, and «parts from the Levonis store · the shop may suggest a better fit».
- **Offer row** in OfferComposer and OfferCompare: «You asked Magnet 10 mm ×2 → Shop suggests 15 mm ×2 · +1,000 IQD», StatusChip info.
- **SwatchSheet**: a photo of a printed sample, then «tap the sample, then white paper» (white balance computed in the browser), then «Looks like Black · close match». Or [Use the Levonis photo].

---

## 3. Data model by role

All changes are additive. Each workflow has one migration, named by role and numbered «next free at merge» (≥0162 today). EXPECTED_MIGRATION and EXPECTED_MIGRATION_COUNT (`worker/lib/schemaVersion.ts`) move in the same commit.

**Owners** (in `packages/contracts/src/ownership.ts`):
- `order_item_parts` → commerce, like order_items.
- Every other new table → marketplace.

### Role A · Parts: the store catalogue is the only inventory (W1)

**Levonis `products`: no migration.**
- `worker/lib/templateFamilies.ts` gains a `printed_part` group on the three sections that declare no groups today (`cat_makers_elec`, `cat_makers_hw`, `cat_makers_parts`, templateFamilies.ts:1909-1913) and on `acc_general`.
- Its fields: `printed_use` (Yes/No = «Can be used inside printed products»), `part_kind`, `part_shape`, `diameter_mm`, `length_mm`, `width_mm`, `height_mm`, `power_w`, `install_minutes`, `fits_family`, `uses`. The existing `voltage` and `install_type` are reused.
- Per-option differences go in the existing multiline `variant_specs`, following the multicolor.ts precedent.
- The admin form, CSV columns and TXT template generate themselves; `readSpecFields` already accepts the keys.

**Merchant `community_products`:**
```sql
ALTER TABLE community_products ADD COLUMN part_spec TEXT;   -- NULL = not a part
CREATE INDEX IF NOT EXISTS idx_community_products_parts ON community_products(store_id) WHERE part_spec IS NOT NULL;
```
- `part_spec` is the same flat key map as the Levonis spec group, plus `source` = `levonis:<products.id>#<option key>` and `variant_specs` lines keyed by the product's own option-value ids.
- Price, stock, SKU, picture, weight and active stay on community_products and variants, untouched.
- A part-only part is simply `publish_state='hidden'`: the 0152 mirror trigger sets status 'hidden', so it fails every storefront, search and community predicate.
- `PART_BUYABLE_SQL(p, store)` = `p.part_spec IS NOT NULL AND p.store_id = ? AND p.publish_state IN ('published','hidden') AND p.admin_hidden_at IS NULL AND p.audience_user_id IS NULL`.
- One pure reader serves both catalogues: `readPartSpec(map, optionKeys)` returns a typed PartSpec (derived, never invented).

### Role B · Kits (W1)

```sql
community_part_kits(id PK, store_id → merchant_stores CASCADE, merchant_id → community_merchants CASCADE,
  name, name_ar, name_ckb, price_mode TEXT NOT NULL DEFAULT 'sum' CHECK (price_mode IN ('sum','fixed')),
  price_iqd INTEGER CHECK (price_iqd IS NULL OR price_iqd >= 0), active INTEGER NOT NULL DEFAULT 1,
  created_at, updated_at, CHECK (price_mode = 'sum' OR price_iqd IS NOT NULL))
community_part_kit_lines(kit_id → community_part_kits CASCADE, product_id → community_products CASCADE,
  variant_id TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 99), position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kit_id, product_id, variant_id));  INDEX (product_id)
```
- A kit's price is Σ(member price × qty) or its fixed price.
- It is available only when every member is buyable and in stock.
- A fixed price is allocated pro rata to the members' values.

### Role C · The blueprint (W1)

Precedent: the store layout's immutable revisions with a pure normaliser.
```sql
community_product_blueprints(product_id PK → community_products CASCADE, store_id → merchant_stores CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1), state TEXT NOT NULL CHECK (state IN ('live','off')),
  updated_at, updated_by);  INDEX (store_id, state)                       -- a POINTER, no content
community_product_blueprint_versions(product_id → community_products CASCADE, version INTEGER NOT NULL CHECK (version >= 1),
  spec_json TEXT NOT NULL,            -- public-safe, ids only, ≤ 32 KB
  model_json TEXT NOT NULL DEFAULT '{}', -- PRIVATE: source keys, derived keys, part facts
  spec_hash TEXT NOT NULL, created_at, created_by, referenced_at TEXT,
  PRIMARY KEY (product_id, version))
CREATE TRIGGER trg_blueprint_version_immutable BEFORE UPDATE OF product_id, version, spec_json, model_json, spec_hash
  ON community_product_blueprint_versions BEGIN SELECT RAISE(ABORT, 'BLUEPRINT_VERSION_IMMUTABLE'); END;
blueprint_part_refs(product_id → community_products CASCADE, slot_key, option_key,
  part_product_id → community_products CASCADE, part_variant_id TEXT NOT NULL DEFAULT '', kit_id TEXT NOT NULL DEFAULT '', qty,
  PRIMARY KEY (product_id, slot_key, option_key, part_product_id, part_variant_id));  INDEX (part_product_id)
```
- A save inserts a version only when the hash changed.
- The part refs are a derived index, rewritten in the same batch as every save. They drive «used in N», PART_IN_USE, dependent purges and one-wave part loads.
- The first order that uses a version stamps `referenced_at`.
- Pruning (in the save batch, beyond the newest 30) removes only versions whose `referenced_at` is NULL and that are not current.
- A product with orders is archived, never deleted, so its versions survive.

**Spec v1**, validated only by `normalizeBlueprint`:
```
{v:1,
 axes: { size?: {group:<option id>, values:{<value id>:{dims_mm:[x,y,z], recommended?:true}}},
         look?: {group, values:{<value id>:{look:'classic'|'matte'|'shiny'|'silk'|'wood'|'marble'|'glow'|'flexible'|'translucent'|'metallic', material_id}}},
         tier?: {group, values:{<value id>:{tier:'value'|'best'}}} },            // the product's OWN variant groups (≤3, the 0126 cap)
 model: {parts:[{key:'p1'..'p16', role:'body'|'base'|'name'|'text'|'border'|'accent'|'logo'|'icon'|'insert'|'accessory'|'fixed',
                 label?:{ar,en,ckb}, colour:{source:'shelf'|'list'|'fixed', list?:PaletteKey[], default:ColourRef}}]} | null,
 photos?: [{media_id /*community_product_media of this product*/, colour?:PaletteKey, value_id?:string}],   // photo-only blueprints
 text: [{key:'t1'..'t4', kind:'name'|'text', anchor:{part, face:'front'|'top'|'back', w_mm, h_mm}, max_chars /*default from anchor width at min letter height 6 mm FDM / 2 mm resin*/,
         lines:1|2, names:1|2|4, styles:('fun'|'gaming'|'elegant'|'kids'|'minimal'|'bold')[], required, fee_iqd}],
 logo?: {anchor, modes:('raised'|'engraved'|'flat')[], max_colours:1|2|3, fee_iqd},
 photo?: {anchor?, outputs:('plaque'|'litho'|'relief'|'silhouette')[], fee_iqd},
 qr?: {anchor, kinds:('instagram'|'tiktok'|'whatsapp'|'website'|'menu'|'contact'|'url')[], fee_iqd},
 nfc?: {slot:<slot key of an NFC part>, kinds:('profile'|'whatsapp'|'website'|'contact'|'wifi'|'url')[]},
 colours: {included:n, extra_fee_iqd},
 slots: [{key, kind:PartKind, label?, qty:1..20, required, choice, pricing:'add'|'included',
          options:[{key, part:{p,v}} | {key, kit:<kit id>}] /*≤12*/, default?:optionKey,
          show?:{effect:'marker'|'glow'|'visible', part?}, accepts?:{shape?, diameter_mm?, voltage?}}] /*≤8*/,
 fixed: [{part:{p,v}, qty, show:boolean}] /*≤8, always used, price included*/,
 repeat?: {part, counts:number[], pitch_mm, axis:'x'|'y', each_fee_iqd},
 rules: [{id, type:'min_size_for_text'|'min_size_for_option'|'requires'|'excludes'|'max_colours', …, fix:'auto'|'suggest', auto:boolean}] /*≤16*/,
 gift?: {fee_iqd},  prep_days_extra: 0..30,
 interfaces?: [{key, family, count}] /*W3*/}
```
- A ColourRef is `{key: PaletteKey, line?: '<material_id>|<#hex>'}`, where the line is the shelf's natural key.
- Automatic rules come from part dimensions against size dimensions, printer build volume (fitsInBuild), text length against anchor width, and printer max colours (resolvePrinter).

**model_json (private):**
```
{files:[{key, name, format}], derived:{full_key, coarse_key, still_key},
 parts:[{key, n /*LVR1 index*/, name, tri, share, bbox_mm, file_colour?, grams?}],
 source_meta:{sliced_minutes?, sliced_grams?}, license_ack?:true}
```
- Model files are the merchant's own `product_file`-purpose objects (ownedFileObject). They are deliberately not `product_files` rows: those are listed publicly and granted to buyers.
- Derived keys are content-addressed:
  - `blueprint-previews/<pid>/<hash>/full.lvm.gz` (≤50k triangles, LVM1 + LVR1 trailer `'LVR1'|u16 n|{u32 start,u32 count,u8 role,u8 len,name}`)
  - `…/parts.png` (the still)
  - public `merchants/<uid>/public/bp/<pid>/<hash>.lvm.gz` (≤20k triangles, snapped by the existing coarse rule, trailer carried)
- The first 32 + 36T bytes are byte-identical to LVM1, so today's `parseLvm` reads them.

### Role D · The configured cart line (W1)

```sql
ALTER TABLE cart_items ADD COLUMN configuration TEXT;   -- registered in CART_LINE_COLUMNS, sqlDefault 'NULL'
```
**Configuration v1.** It carries ids and customer words, never a price. Canonical JSON: sorted keys, NFC text, empty maps omitted, ≤4 KB.
```
{v:1, bp:<version at add>, colours?:{<partKey>:<colour option id>}, texts?:{t1:{value, style}}, names?:{t1:[…]},
 logo?:{key, mode}, photo?:{key, output} /*accepted once the customer track's upload purpose lands*/,
 qr?:{kind, value}, nfc?:{kind, value}, parts?:{<slot>:<option>|null}, repeat?:n,
 gift?:{to?, message? ≤140, wrap?, hide_price?}}
```
**Identity.**
- `option_id` = the chosen variant id (or '').
- `color_id` = `'cfg:' + sha256(canonical JSON without bp)[0..16]`, minted by one helper, `configRef()`.
- `color_id` already sits in both uniques (0141:38 and :50) and in fingerprint v2, so there is no index swap. Migrations apply before code, so an index swap would cost two releases.
- An equal configuration merges through the existing ON CONFLICT; a different one is a new line.
- A republish does not split equal lines, because `bp` is excluded from the hash.

### Role E · The configured order (W1, with cost added in W2)

```sql
ALTER TABLE order_items ADD COLUMN configuration_snapshot TEXT;  -- customer-safe
ALTER TABLE order_items ADD COLUMN production_snapshot TEXT;     -- merchant-only, never mapped for a buyer
order_item_parts(id PK, order_id → orders, order_item_id → order_items, product_id → community_products,
  variant_id TEXT NOT NULL DEFAULT '', slot TEXT NOT NULL /*'slot:<s>/<o>' | 'fixed:<n>' | 'kit:<k>/<member>'*/,
  qty INTEGER NOT NULL CHECK (qty > 0) /*per-unit qty × line qty*/, unit_price_iqd INTEGER NOT NULL CHECK (unit_price_iqd >= 0),
  unit_cost_iqd INTEGER CHECK (unit_cost_iqd IS NULL OR unit_cost_iqd >= 0) /*written from W2*/,
  name_snapshot TEXT NOT NULL, option_snapshot TEXT NOT NULL DEFAULT '', created_at);  INDEX (order_id), INDEX (product_id)
CREATE TRIGGER trg_store_order_cancel_restocks_parts AFTER UPDATE OF status ON orders FOR EACH ROW
WHEN NEW.status = 'cancelled' AND OLD.status IS NOT 'cancelled' AND NEW.seller_type = 'merchant'
BEGIN
  UPDATE community_product_variants SET stock = stock + (SELECT SUM(x.qty) FROM order_item_parts x
         WHERE x.order_id = NEW.id AND x.variant_id = community_product_variants.id), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id IN (SELECT x.variant_id FROM order_item_parts x WHERE x.order_id = NEW.id AND x.variant_id <> '');
  UPDATE community_products
     SET stock = stock + (SELECT COALESCE(SUM(x.qty),0) FROM order_item_parts x WHERE x.order_id = NEW.id
                          AND x.product_id = community_products.id AND x.variant_id = ''),
         sold_count = MAX(0, sold_count - (SELECT SUM(x.qty) FROM order_item_parts x WHERE x.order_id = NEW.id AND x.product_id = community_products.id)),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id IN (SELECT x.product_id FROM order_item_parts x WHERE x.order_id = NEW.id);
END;
```
- This mirrors the checkout decrement: `stock −qty` and `sold_count +qty` per need, and variant stock for variant needs, which the 0126 heal trigger folds into the product's stock.
- The parent row carries the whole line total, `option_snapshot` = variant label + « · » + summary (≤300), and `pricing_snapshot.composition = {kind:'configured', …}`.
- **configuration_snapshot** = `{bp:{product_id, version}, variant:{id,label}, config (normalised), words:[{k,label,value}], price:{base_iqd, fees:[{key,iqd}], parts_iqd, unit_iqd}}`. Asset keys stay server-side and are never mapped to the buyer.
- **production_snapshot v1** = `{dims_mm, look, tier, model_parts:[{key, role, name, colour:{material_id, hex, name}}], texts:[{key,value,style,height_mm}], qr:{kind,payload}, nfc:{kind,payload}, gift, fixed_shown}`. W2 adds `grams`, `minutes`, `hidden`, `steps`, `qc` and `recipe_version`.
- Deleting a product referenced by `order_item_parts` archives it, the rule `order_items` already gets.

### Role F · Economics (W2)

```sql
ALTER TABLE community_products ADD COLUMN cost_iqd INTEGER CHECK (cost_iqd IS NULL OR cost_iqd >= 0);
ALTER TABLE community_product_variants ADD COLUMN cost_iqd INTEGER CHECK (cost_iqd IS NULL OR cost_iqd >= 0);
community_product_recipes(product_id PK → community_products CASCADE, store_id, version INTEGER NOT NULL CHECK (version >= 1),
  recipe_json TEXT NOT NULL, basis TEXT NOT NULL CHECK (basis IN ('estimated','stated','sliced','weighed')), updated_at, updated_by)
merchant_filament_swatches(merchant_id → community_merchants CASCADE, material_id, color_hex CHECK (color_hex GLOB '#[0-9a-f]*'),
  look TEXT NOT NULL DEFAULT 'classic' CHECK (look IN (…10 looks…)), brand TEXT NOT NULL DEFAULT '',
  iqd_per_kg INTEGER CHECK (iqd_per_kg IS NULL OR iqd_per_kg BETWEEN 0 AND 10000000), supply_product_id TEXT,
  photo_key TEXT, photo_light TEXT NOT NULL DEFAULT '', calibrated_hex TEXT, lab_l REAL, lab_a REAL, lab_b REAL, updated_at,
  PRIMARY KEY (merchant_id, material_id, color_hex))        -- the shelf's NATURAL key: survives the DELETE+INSERT PUT
ALTER TABLE order_items ADD COLUMN production_actuals TEXT;
```
**Recipe v1** (≤16 KB):
```
{filament:[{part|'*', material_id, grams_m}], minutes_m, per_variant?:{<variant id>:{grams?, minutes?}},
 hidden:[{kind:'glue'|'screw'|'insert'|'support'|'paint'|'packaging'|'other', label, qty, unit, cost_iqd}],
 labour_minutes, packaging_iqd, printer_id?, steps[≤20], qc[≤12], target_margin, floor:'warn'|'block',
 coeffs /*server-computed at save; client values ignored*/:{iqd_per_g:{material:n}, iqd_per_min, iqd_per_labour_min, reserve_frac, fee_pct_x100, fee_min_iqd}}
```
- Grams per part come from engine B's `analysisFromGeometry` presets over each part's triangles (basis 'estimated'). A sliced 3MF's slice_info gives basis 'sliced'; a typed figure is 'stated'; production actuals are 'weighed'.
- **Filament price ladder:** swatch `iqd_per_kg`, then the Levonis filament product (via `supply_product_id` or `print_materials.product_id`), then platform by type. Every figure carries a provenance word. `merchant_spools` has no writer today.
- **Cost semantics (0095):**
  - A configured parent's `cost_iqd` = print + parts + hidden + packaging, with `cost_basis 'snapshot'`.
  - Any store line whose product or variant carries `cost_iqd` also gets a snapshot.
  - Lines with no cost stay `'unrecorded'`.
  - The platform fee stays the ledger's own line, never inside COGS.
  - Levonis finance already filters `seller_type='levonis'`.

**Committed filament (read time, no table):**
- The figure is shelf grams − Σ production_snapshot grams (actuals when present).
- The sum covers this merchant's orders that are open (pending|confirmed|processing), plus orders placed after the shelf's `updated_at` baseline that were not cancelled.
- It is exported as `committedGrams(db, merchantId)`.

### Role G · Requests and offers (W3)

```sql
ALTER TABLE community_print_requests ADD COLUMN parts TEXT;  -- NULL = none; [{product_id, option_value_id?, qty ≤500, note?}] ≤12
ALTER TABLE community_offers ADD COLUMN parts TEXT;          -- NULL = none; [{want:<index>|null, give:{src:'levonis'|'store', p, sel}, name, qty, unit_iqd, kind:'as_asked'|'swap'|'added'}] ≤12
```
- `parts` enters the request's factsHash only when non-null, so existing revision hashes stay equal.
- Offer parts reach `recordOfferRevisionStatement` terms and `composeSnapshot`.
- The `printAccessories` setting rows gain an optional `product_id`/`option_key`; this is a normaliser change, not a migration.

### Role H · The switch

The admin setting `customizationConfig`:
```
{enabled:false, pilot_store_ids:[], template_triangle_cap:50000, public_mesh_triangles:20000, max_blueprints_per_store:200}
```
- It has a normaliser in `PUT /api/admin/settings/:key`, writes an audit row, and is not public.
- The kill switch stops builder writes and new configurations. Lines already in carts still check out.

### Media references (`worker/lib/mediaRefs.ts`, integrator)

- **Sources:**
  - `community_product_blueprint_versions.model_json` (files + derived)
  - `cart_items.configuration` and `order_items.configuration_snapshot` (logo/photo JSON paths)
  - `merchant_filament_swatches.photo_key` (public)
- **Derived prefix:** `blueprint-previews/` is registered with the sweep.
- **NON_MEDIA:** `spec_json`, `part_spec`, `production_snapshot`, `production_actuals`, `recipe_json`, `order_item_parts.name_snapshot`/`option_snapshot`, `photo_light`, `community_print_requests.parts`, `community_offers.parts`.

### Invariants, each pinned by a test

| # | Invariant |
|---|---|
| I1 | One row per thing bought. Σ order_items line totals = subtotal; commission, coupon, ledger and receivable are unchanged; parts never appear as order lines. |
| I2 | Parts are counted like goods. They are decremented at placement through the same fences (PART_BUYABLE + track_stock) and restocked by the cancel trigger only; nothing else writes their stock. |
| I3 | Ids in. The body never carries a price. Parts and kits resolve only through this product's `blueprint_part_refs` in the same store. Texts are normalised and decency-checked; QR/NFC payloads are built on the server. |
| I4 | Version content never changes; referenced versions are never pruned. |
| I5 | `spec_json` is public-safe. Model keys (except the public coarse mesh), recipes, costs, grams and stock counts never leave merchant doors. Public reads carry `in_stock` booleans and 'now'/'later'. |
| I6 | A part is sold by the seller of the line that contains it; the one-seller cart triggers are untouched. |
| I7 | No part product's files are granted by an order: `productFileGrantStatement` is fed line product ids only (storeOrders.ts:1017-1023 feeds `cart.products` today). |
| I8 | Every valid spec yields ≤5 primary customer controls (`surfaceOf`). |

### Reused verbatim

- **Catalogue and checkout:** 0126 options/values/variants with VariantEditor and `resolveCatalogLine`; `priceMerchantCart` fences, decrements and `stockRefusal`; `cancelStoreOrder` and the 0126 §9 trigger; `option_snapshot`; quote fingerprint v2; `alertLowStock` (moves regardless of publish state).
- **Workshop:** `merchant_material_stock` and its PUT; `merchant_printers` + `resolvePrinter` + `fitsInBuild`; engine B (`priceJob`, `analysisFromGeometry`, `machineIqdPerHour`, and the route exports `analysisFromGrams`, `priceForPrinter`, `merchantQuote`); `feeFor`.
- **Files and cache:** `anonymousCached`/`purgeAnonymousCache`; `ownedFileObject` + UploadTile (purpose `product_file`); the /files/ public door; modelGeometry's parsers and bounded ZIP reader.
- **Helpers:** `qr.ts`; `decency.assertDecent`; `linkCards.normalizeLinkUrl`; `community_product_media`; `order_items.cost_iqd`/`cost_basis`; the `printAccessories` vocabulary and its human Sorani names.

---

## 4. API

### Merchant

Routers are mounted on the existing `/api/merchant` prefix (no gateway change):
- `worker/routes/merchantBlueprints.ts`
- `worker/routes/merchantParts.ts`
- W2: `worker/routes/merchantRecipes.ts`

Guards and responses:
- Reads use `requireStoreOwner`; writes use `requireSellingPrivileges`.
- Every door answers 404 CUSTOMIZATION_OFF unless the switch is on or the store is in `pilot_store_ids`.
- Responses are private, no-store.
- When P10 lands, builder and parts routes move to `requireStoreAccess(c,'products')` and economics to `'finance'`, listed in `merchantRouteGates`.

| Route | Contents | Waves | Limits and refusals |
|---|---|---|---|
| 1. `GET /blueprints/status` | `{enabled, pilot, limits}` | 1 | — |
| 2. `GET /products/:id/blueprint` | Head, current spec, model part summaries, suggestions (roles from names, tiles, sizes that fit, printer max colours), `health[]`, parts slice, own shelf palette | 1 parallel wave of ≤6 | — |
| 3. `PUT /products/:id/blueprint {spec, base_version, model_token?}` | Wave 1 reads: product (owner, not private), head, own option/value ids, referenced parts via json_each (store-scoped, `part_spec` present), own kits, printers, shelf. Then pure normalise + verify + health. Wave 2 `db.batch`: INSERT version (only if the hash changed), UPSERT the head fenced on `base_version` (NULL-abort), rewrite the part refs, prune unreferenced old versions, audit `merchant.blueprint_saved`. After the response: purge the blueprint doc and the product read. | 2 | 120/h. BLUEPRINT_INVALID {errors[{path,code}]}, BLUEPRINT_CHANGED 409, CUSTOM_PRODUCT_LOCKED 409, BLUEPRINT_PART_NOT_OWNED, BLUEPRINT_KIT_NOT_OWNED |
| 4. `DELETE /products/:id/blueprint` | Head state 'off'; versions kept; carted lines show `config_changed` | — | — |
| 5. `POST /products/:id/blueprint/model {files:[{key}\|{product_file_id}], license_ack?}` | Reads each file once (≤40 MiB inline, as `deriveModelPreview` does; otherwise `waitUntil` with a «processing» state). `modelParts.ts` + `templateMesh.ts` write the content-addressed full mesh, coarse mesh and still, and return `{model_token, parts[], suggestions, still_url}`. Nothing is referenced until a PUT; unreferenced keys are swept. | — | 30/h. BLUEPRINT_MODEL_NOT_OWNED, BLUEPRINT_MODEL_UNREADABLE («it still shows in 3D»), BLUEPRINT_MODEL_TOO_HEAVY 413 |
| 6. `GET /products/:id/blueprint/mesh` and `/still` | Owner streams | — | — |
| 7. `POST /parts/from-levonis {product_id, options:[{key, price_iqd, stock}]}` | One batch creates a hidden part product: variants from option values, `part_spec` copied with `source`, images copied into the merchant's prefix | — | Reuses `merchant-product-create` 60/h. PART_SPEC_INVALID |
| 8. `GET/POST /part-kits`, `PUT/DELETE /part-kits/:id` | Kits | — | KIT_INVALID; a kit in use → PART_IN_USE |
| 9. `GET /blueprints/orders/:orderId/production` | Cards for configured lines of the merchant's own order (else 404): `production_snapshot`, `order_item_parts`, file flags. `GET …/lines/:lineId/files/qr.svg` uses `attachmentResponse` with `qrToSvgPath`; logo/photo arrive with the customer upload purpose. No key in any body. | — | — |

Existing catalogue routes change as follows (`merchantCatalog.ts`, `worker/lib/catalog/product.ts`):
- PATCH `/products/:id` reads `part_spec` (W2: `cost_iqd`) explicitly and refuses both on private products.
- GET `/products?kind=parts|customizable` returns rows with `customizable` and `used_in`.
- DELETE answers 409 PART_IN_USE {products[]} while a live blueprint references the product, and archives when `order_item_parts` reference it.
- POST `/duplicate` copies the head and current version, remapping option and value ids (`remapBlueprintIds`); W2 also copies the recipe.

### Public

**`worker/routes/storefrontBlueprint.ts`**, mounted on `/api/storefront` before `storefrontRoutes`. It is GET only: the gateway treats `/api/storefront` as read-only (`services/gateway/src/validation.ts:45,103`).

10. **`GET /:slug/products/:productSlug/blueprint`**
    - Cached with `anonymousCached(c, {params: []})`; a session gets private, no-store.
    - Waves: `servableStoreBySlug` → product ⋈ head ⋈ version (one statement) → one statement over `refs ⋈ parts ⋈ variants ⋈ kits`.
    - Body: `{version, surface, axes, model:{mesh_url:'/files/merchants/<uid>/public/bp/<pid>/<hash>.lvm.gz', bbox, parts:[{key,role,label}]}, photos, text, logo, photo, qr, nfc, colours:{included, extra_fee_iqd, per part source}, slots:[{key,label,kind,qty,required,pricing,options:[{key,name,image,price_iqd,in_stock}],default,show}], fixed_shown, repeat, rules (customer words), gift, prep_days}`.
    - Variants come from the product read the page already holds.
    - 404 NOT_CUSTOMIZABLE when the switch is off, there is no live head, or the product or store is not live.
    - A whole-body scan test forbids cost, margin, grams, recipe, stock counts and any key other than `mesh_url`.
11. **`GET /:slug/palette`**
    - Cached with `anonymousCached {params: []}`.
    - Body: `{tracked, lines:[{id:'<material>|<hex>', key:PaletteKey, name, look (W2), photo (W3), available:'now'|'later'}]}`. Never grams.
    - Purged by the shelf PUT (a one-line seam in `merchantPrinters.ts`) and by filament-facts writes.

The mesh needs no route: the coarse file is a public, immutable `application/gzip` object behind /files/, and the client inflates it with `DecompressionStream`.

**Levonis parts: `worker/routes/printParts.ts`**, mounted on `/api/products` before `productRoutes`. The literal sub-path follows the `/print-calculator` precedent (products.ts:3048 before `/:slug` at :3864).

12. **`GET /print-parts?kind&q&cursor`** returns `printed_use=Yes` active Levonis products (guest price, `in_stock` boolean, spec summary), 24 per page, cached with `anonymousCached {params:['kind','q','cursor']}`, q ≤60 characters, via `likePattern`. W3 adds `GET /print-parts/:id/uses`.

### Money path

`worker/lib/catalog/configuredLines.ts`: `resolveConfiguredLines(db, rows)` is the one pricing and validation path, called by the add door, `loadMerchantCart` and `priceMerchantCart`.

**Wave A**, only when a line carries a configuration: head ⋈ version, plus `refs ⋈ parts ⋈ variants ⋈ kits` with PART_BUYABLE, plus the shelf if a slot uses 'shelf' colours.

**Then pure code:**
- base = `resolveCatalogLine({...row, color_id:''})`, so the legacy branch never sees 'cfg:'.
- `normalizeConfiguration` → `evaluateRules` → `priceConfiguration`.
- unit = base + fees + Σ part charges ('included' charges only the positive difference).
- Part needs join `perProduct`/`perVariant` flagged `part:true`.

**Cart** (`worker/routes/cart.ts`):
- `POST /api/cart/merchant-items` accepts `configuration` (≤8 KB body).
  - Waves: `loadBuyableMerchantProduct` → Wave A + existing lines (with `configuration`) → rarely the other configured lines' facts → one INSERT … ON CONFLICT.
  - Part stock is judged over every line.
  - Text runs through `assertDecent`; QR/NFC values are normalised per kind and the payload URL is built on the server (≤213 bytes).
- `PATCH /merchant-items/:id` accepts `configuration`. It re-prices as an add; if the result equals another line, one batch sets that line's qty to MIN(9999, sum) and deletes this one.
- `GET /api/cart/merchant` items gain `configuration` (normalised), the summary as `variant`, `edit_href` and `unavailable_reason: 'config_changed'`.

**Quote and place** (`POST /api/store-orders/quote`, `POST /api/store-orders` in `storeOrders.ts`):
- (a) Fingerprint: configured lines append a 7th element, the blueprint version. Non-configured carts hash exactly as today; v stays 2.
- (b) Version fence per configured product: `UPDATE orders SET address_snapshot = CASE WHEN EXISTS(SELECT 1 FROM community_product_blueprints b WHERE b.product_id=? AND b.state='live' AND b.version=?) THEN address_snapshot ELSE NULL END` → the existing CART_CHANGED 409. `orders.status` would answer OUT_OF_STOCK.
- (c) Part product and variant fences use PART_BUYABLE_SQL; `stockRefusal` re-reads parts by the same rule → OUT_OF_STOCK {available, part_product_id, cart_item_id}.
- (d) The parent INSERT carries `configuration_snapshot`, `production_snapshot` and `pricing_snapshot.composition`; `order_item_parts` rows follow; the used version's `referenced_at` is stamped.
- (e) `productFileGrantStatement` receives line product ids only.
- (f) The decrement loops are unchanged; parts are already inside the maps, and `stockMoves` includes them.
- W2 adds cost snapshots computed purely from stored coefficients inside the same batch.
- A configured line that no longer normalises answers CONFIG_CHANGED {cart_item_id}.

### W2 routes (merchantRecipes.ts)

- `GET/PUT /products/:id/recipe {recipe, base_version}`: the server recomputes `coeffs` through `recipeCost.ts`, the only engine B adapter. RECIPE_INVALID, RECIPE_CHANGED; PRICE_BELOW_COST {variant} only when `floor='block'`. 120/h.
- `GET /products/:id/economics?variant&qty`: cost lines in `merchantQuote` words, a per-variant table, simulator coefficients, suggested prices and below-cost combinations. Owner only. `qty` lets the Levo Project quote assistant reuse it.
- `GET /filament`: shelf lines, facts and committed grams.
- `PUT /filament/facts {material_id, color_hex, look, brand, iqd_per_kg, supply_product_id}`: an upsert on the natural key. FILAMENT_FACT_INVALID.
- `PUT /blueprints/orders/:orderId/lines/:lineId/actuals {grams:{part:g}, minutes}`: 120/h.
- `GET /library?kind=models|customizable|parts|kits|recipes&cursor`.

### W3 routes

- The print-request draft, publish and repeat routes and the offer create, edit and send routes accept `parts` (REQUEST_PARTS_INVALID, OFFER_PARTS_INVALID).
- `effectiveAccessories(db)` replaces the raw setting read at `printQuote.ts:165,373` and `printRequests.ts:163`; linked rows take their product's price, and `printEstimateContract` is unchanged.
- `publicRequest()` gains a parts summary (names and qty).
- `PUT /filament/facts` accepts `photo_key` (owned via `ownedMediaKey`, `merchants/<uid>/public/`), `photo_light` and the calibrated Lab. SWATCH_INVALID, MEDIA_NOT_OWNED.
- `GET /api/storefront/:slug/products/:productSlug/modules` returns same-store products whose `interfaces` match, cached.
- `GET /api/products/print-parts/:id/uses`.

### Admin

- `PUT /api/admin/settings/customizationConfig`.
- W3: the `printAccessories` normaliser accepts product links.
- The Levonis product form's `printed_part` group needs no route.

### Refusal codes

**Customer codes** live in `src/lib/refusalStrings.ts` in ar/en/ckb with ckb ≠ ar ≠ en. `storefrontBlueprint.ts` joins the test's sources list.

| Code | Status | Payload |
|---|---|---|
| CONFIG_INVALID | 400 | {path, why} |
| CONFIG_OPTION_UNAVAILABLE | 409 | {which: colour\|part\|size\|look, key, alternatives[]} |
| CONFIG_RULE | 409 | {rule, fix} |
| CONFIG_TEXT_REFUSED | 400 | {region} |
| CONFIG_CHANGED | 409 | {cart_item_id} |
| NOT_CUSTOMIZABLE | 404 | — |
| CUSTOMIZATION_OFF | 404 | — |
| CONFIG_ASSET_INVALID | — | lands with the customer upload purpose |

OUT_OF_STOCK, CART_CHANGED, VARIANT_*, STORE_CLOSED and PRODUCT_PRICE_REQUIRED are reused as they are.

**Merchant codes** are decoded by `src/components/merchant/catalog/blueprint/refusal.ts`, pinned the way `storeDesign/refusal.ts` is.

---

## 5. Client

### New lazy chunks

Each is pinned in `tests/bundleBudget.test.ts` as «a chunk of its own», and none is static in the entry, the workspace shell, MerchantDashboardPage or a storefront page.

| Workflow | Chunk | Ceiling | Contents |
|---|---|---|---|
| W1 | BlueprintBuilder | ≤18 KB | CapabilityTiles, PartsStrip, RoleSheet, SlotSheet, SizesCard, RuleRow, HealthStrip, PreviewOutline, builderModel, still |
| W1 | PartFacts | ≤3 KB | — |
| W1 | FromLevonisSheet | ≤4 KB | — |
| W1 | KitSheet | ≤3 KB | — |
| W1 | LineSpec | ≤4 KB | Production card |
| W1 | AddOnsSheet | ≤5 KB | Customer; added to the storefront lazy-only list |
| W2 | RecipeSheet | ≤9 KB | — |
| W2 | ProfitSimulator | ≤4 KB | Lazy inside RecipeSheet |
| W2 | FilamentPanel | ≤4 KB | — |
| W2 | AssetLibrary | ≤6 KB | — |
| W2 | ScenePick | ≤3 KB | Imports the customer track's scene module lazily; this track never imports ogl |
| W2 | LineSpec | grows to ≤6 KB | — |
| W3 | PartsStep | ≤4 KB | — |
| W3 | UseInProjectSheet | ≤3 KB | — |
| W3 | SwatchSheet | ≤5 KB | The pure `colourSample.ts` does white balance and Lab |
| W3 | OfferComposer | +≤1.5 KB | — |

### Growth ceilings on existing chunks

Relative to the build at merge:

| Chunk | Ceiling |
|---|---|
| ProductEditorSheet | 9,629 → ≤10,450 B over W1 + W2 |
| CatalogManager / ProductsManager | +≤0.4 KB |
| OrderDetailScreen | 7,344 → ≤7,600 B (12 KB pin) |
| CommandCenter | +≤0.1 KB (18 KB pin; 15,652 today) |
| AnalyticsSection | 11,071 → ≤11,700 B (16 KB pin) |
| Product | +≤0.3 KB |
| RequestComposer mount | +≤0.2 KB |

Entry, initial payload, storefront closure and workspace shell/closure: **+0 B**.

**CSS: +0 B.**
- `tests/blueprintUiTokens.test.ts` asserts that every className token in the new folders already appears in some src file outside them.
- One-offs are constant inline styles.

### Pure shared code

`packages/catalog/src/blueprint/*.ts`; the existing `"./*"` export pattern covers the subpath. Nothing in it touches a database or the DOM.

| Module | Exports |
|---|---|
| `spec` | `normalizeBlueprint`, `remapBlueprintIds` |
| `configure` | `normalizeConfiguration`, canonical JSON, `configRef` input |
| `price` | `priceConfiguration` |
| `rules` | `evaluateRules`, `autoRules`, Smart Fit letters vs anchor width |
| `parts` | `readPartSpec`, fits |
| `kits` | Kit pricing and pro-rata allocation |
| `surface` | `surfaceOf` |
| `colorMatch` | sRGB↔Lab, CIEDE2000, nearest stocked line, close/similar words |
| `summary` | Merchant-word summaries |
| `vocabulary` | ar/en/ckb for roles, part kinds, looks, styles, QR/NFC kinds |
| W2: `recipe`, `bom`, `economics` | `simulate` |
| W3: `modules` | `compatibleUpgrades` |

- The customer customizer imports `configure`, `price`, `rules` and `colorMatch` lazily (≈5–6 KB gz).
- Themes, «Choose for me» and «Make it better» belong to the customer track and build on `colorMatch`.

### Primitives only

Sheet v2 (detents, `dirty` guard), Overlay `Anchored` (≥1024), catalog `Disclosure` (`forceOpen` for server field errors mapped by path), Segmented, DataList, KpiTile, StatusChip, Money, NumberInput kind=money, Switch, Checkbox, Select, Menu, UploadTile, Skeleton, EmptyState, ErrorState, useConfirm (no native dialogs), and native radios and checkboxes inside lv-choice (the VariantPicker pattern). Every target is ≥44 px. The list does everything; a canvas is only an aid, with `role="img"` and a text alternative.

### Motion

- Sheets use Sheet v2, which calls `useMotion()` internally.
- «Parts found» is `m.li` with `SPRING.ui` under `<MotionFeatures>`, and CROSS_FADE under reduced motion.
- Tiles use lv-choice's existing CSS state.
- Prices, profit and simulator figures change instantly with aria-live=polite.
- There is no `motion` proxy and no `useReducedMotion` from `motion/react`.

### i18n

- **One strings file per chunk folder:** `blueprint/strings/*`, `parts/strings.ts`, `orders/production/strings.ts`, `customize/addons/strings.ts`, W2 `recipe/strings.ts`, W3 `customize/parts/strings.ts`.
- **Real Sorani** in every new key, assuming row 169 is approved. Human Sorani already in the repo is reused: the accessory names ماگنێت، مۆتۆری، بلی، کلیلەی بچووک، برغی، ئینسێرتی گەرمی, and ناو، ڕەنگەکان، قەبارە، زیاتر، زیادکردن بۆ سەبەتە، داوای چاپکردنی بکە.
- **UI tests** copy `workspaceUi`/`ordersListUi`: key parity, ckb ≠ ar ≠ en, ≥90% Kurdish letters, placeholder parity, no OWNER marker, tokens only, no hex, no `dark:`, logical utilities.
- **`tests/customerVocabulary.test.ts`** walks `src/components/customize/**/strings.ts` and the CONFIG_* sentences in three languages. It forbids mesh|stl|3mf|obj|slicer|infill|nozzle|extruder|ams|triangle|cad|g-code|layer height|support material and their Arabic/Sorani equivalents.
- **Merchant copy is plain too:** «your file has 3 parts».

### Playwright

Each script runs the full matrix: 360/1280 × ar/en/ckb × dark/light × reduced motion reduce/no-preference (closing G7). Checks: no horizontal overflow, no page errors, landmarks, behaviour.

| Workflow | Fixture and script |
|---|---|
| W1 | `tests/browser/blueprint-builder.{html,fixture.tsx}` + `scripts/e2e-blueprint-builder.mjs`: tiles auto-on; assign a role; add a slot from parts; the «20 mm → Large» fix; health; the save body is ids only |
| W1 | `addons.{html,fixture.tsx}` + `e2e-addons.mjs`: a pick changes `data-addon-price`; an unavailable option shows its alternative |
| W2 | `e2e-recipe.mjs` |
| W3 | `e2e-parts-everywhere.mjs` |

The existing `e2e-catalog`, `e2e-store-builder` and `e2e-order-fulfilment` also run: a configured order shows one line.

---

## 6. Phases with file ownership

**Scheduling rules**
- One Programme C workflow runs at a time, beside one lane-A phase, with disjoint file sets.
- Seam files are edited by the integrator only, as one-line-scope edits.
- Gates run in a fixed order: `npm run check` → `test:unit` → `migrate-check --twice` → `build` + bundleBudget → browser scripts.
- Deployment happens only on the owner's word.
- Nothing starts before wave 0, when community Phase 5 (its client half is now in the tree) and P4/P5 are committed.

### W1 · «Blueprints, parts and the configured line»

Wave 1, beside Community 6. Ships dark. Migration role `customizable_products`.

It touches no Community 6 file (moderation, reputation, chats, chatCards, printMatchingScore, admin desk) and no P6 file (storefront.ts, orders.ts, OrderDetail.tsx, StorefrontProduct, chatCommerce, printRequests), so neither waits for it.

| Builder | Owns | Tests |
|---|---|---|
| B1 Schema | `migrations/<next>_customizable_products.sql` | `tests/customizableProductsSchema.test.ts`: tables, CHECKs, content immutable but `referenced_at` stampable, the parts restock trigger for simple and variant parts and `sold_count`, the hidden-part mirror, PART_BUYABLE |
| B2 Pure core | `packages/catalog/src/blueprint/{spec,configure,price,rules,parts,kits,surface,colorMatch,summary,vocabulary}.ts` | `blueprintModel`; `configurePricing` (the brief's 20,000 + 2×1,000 + 5,000 + 8,000 = 35,000, identity excludes bp, kit sum/fixed allocation, included = positive difference); `blueprintRules`; `partSpecs`; `surfaceOf`; `colorMatch` (CIEDE2000 pairs) |
| B3 Model registration | `worker/lib/modelParts.ts`, `worker/lib/templateMesh.ts` (LVR1 writer, full ≤50k, coarse ≤20k with trailer, still rasteriser + PNG via CompressionStream('deflate'), gzip via CompressionStream); `worker/lib/modelGeometry.ts` export-only edits (bounded ZIP reader, `apply3mfTransform`) | `modelParts.test.ts` on Bambu-shaped 3MFs built with zipSync inside tests: components, names and extruders, paint states, slice_info, OBJ groups, multi-solid STL, N files in one frame, LVM1 prefix byte-identical. `modelGeometry`, `coarsePreviewMesh` and `store-isolation` stay untouched and green. |
| B4 Merchant server | `worker/routes/merchantBlueprints.ts`, `worker/routes/merchantParts.ts`, `worker/lib/blueprint/{store,verify,health,purge,production}.ts`; seams `worker/lib/catalog/product.ts` (`part_spec`), `worker/routes/merchantCatalog.ts` (kind filter + chips, PART_IN_USE, archive when parts were sold, duplicate copy + remap) | `merchantBlueprints` (owner scoping, private refused, foreign part refused, BLUEPRINT_CHANGED, versions immutable, purges called, switch/pilot 404), `partKits`, `partsFromLevonis`, `productionDoor` (other store 404, no key in any body) |
| B5 Money path | `worker/lib/catalog/configuredLines.ts`, `worker/lib/catalog/lines.ts` (hook), `worker/routes/cart.ts`, `worker/routes/storeOrders.ts` | `configuredCheckout` (~25 attacks: client price ignored; foreign part/kit refused; hidden part not buyable alone; blueprint edit between quote and place → CART_CHANGED; part race → OUT_OF_STOCK; cancel restocks parts and part variants; Σ lines = subtotal, commission and ledger unchanged; no part file granted; non-configured fingerprints unchanged; kill switch keeps carted lines). `cartConfigIdentity`. `configuredOrderReaders` (merchant list `item_count` = 1, chat card = 1 line, buyer detail = 1 line). `storeCheckoutIntegrity` B1–B25, `cartUpsert`, `cartIdentityContract` and `catalogCheckout` stay green. |
| B6 Public reads | `worker/routes/storefrontBlueprint.ts`, `worker/routes/printParts.ts`, `worker/lib/templateFamilies.ts` (`printed_part` group; pin updated) | `storefrontBlueprint` (cache headers, whole-body scan, 404s, palette 'now'/'later' only), `printParts` |
| B7 Builder UI | `src/components/merchant/catalog/blueprint/*`; seam `ProductEditorSheet.tsx` (Customization Disclosure) | `blueprintBuilderUi` |
| B8 Parts UI | `src/components/merchant/catalog/parts/*`; seams `ProductEditorSheet.tsx` (part Disclosure), `CatalogManager.tsx` (kind Select, chips, Menu), `catalogApi.ts` | `partsUi` |
| B9 Customer and production UI | `src/components/customize/addons/*`, `src/components/merchant/orders/production/*`; seam `OrderDetailScreen.tsx` (one lazy mount) | `addonsUi`, `lineSpecUi`, `customerVocabulary` |
| B10 Words and proof | Strings files, `blueprint/refusal.ts`, the fixtures and e2e scripts above | `blueprintUiTokens` |

**Integrator seams:**
- `worker/index.ts`: four mounts, all on existing prefixes: `/api/merchant` ×2, `/api/storefront` before `storefrontRoutes`, `/api/products` before `productRoutes`. The gateway routing test is unchanged.
- `schemaVersion.ts`; `ownership.ts` (five tables → marketplace; `order_item_parts` → commerce); `mediaRefs.ts`; `cartLineProjection.ts`.
- `settings.ts` + `admin.ts` normaliser (`customizationConfig`).
- `refusalStrings.ts` + its test's sources and decoders.
- `bundleBudget` (chunk lists and ceilings); `d1Waves` ceilings: builder GET ≤2, PUT ≤3, doc ≤3, palette ≤2, configured add ≤4, checkout +1 wave only with a configured line.
- `packages/contracts/src/merchantRoutes.ts` (`kind` query word) + `merchantRoutes.test.ts`.
- `merchantPrinters.ts` (palette purge after the shelf PUT).
- DECISIONS rows at the next free number:
  - blueprints annotate variants and are immutable, referenced versions;
  - parts are the same store's products, recorded in `order_item_parts`, counted at placement, restocked by trigger;
  - configured-line identity lives in `color_id`.

**Exit:** all green, zero bytes added to entry, initial, storefront, shell and CSS, and a doc section in `docs/MERCHANT_PLATFORM_V2.md` (Programme C).

Community 7 (wave 3), which edits the catalogue product form, runs after W1.

### Between W1 and W2 (customer track, not this track)

In wave 3, beside Community 7 and after P6, the customer track's customize-before-cart phase:
- mounts AddOnsSheet;
- builds the customizer and the shared scene with `pick()`;
- adds the storefront «Customize» door and the `customizable` flag to the storefront product read and list, plus the public API DTO;
- adds the customer asset upload purpose, with the `ownedFileObject` check inside `configuredLines.ts` (a declared seam);
- adds the cart «Edit» link.

It never edits `cart.ts` or `storeOrders.ts`.

**Pilot go-live** (owner switch, pilot stores) is possible after that phase. General availability comes after W2.

### W2 · «What's used, true cost, and the production card»

Wave 4, beside P7. Migration role `build_recipes`.

It touches none of P7's files: `storeOrderOps.ts`, `merchant.ts`, `merchantOrders.ts`, `OrderDetailScreen.tsx` (mounted in W1), inbox, chats, StoreSettingsTab. It lands in `storeOrders.ts` and `merchantAnalytics.ts` before P8 (wave 5), which rebases.

| Builder | Owns | Tests |
|---|---|---|
| B1 Schema | The migration above | `buildRecipesSchema` |
| B2 Pure | `packages/catalog/src/blueprint/{recipe,bom,economics}.ts` | `recipeModel`, `bom`, `simulateGolden` |
| B3 Cost adapter | `worker/lib/blueprint/{recipeCost,filamentPrices,committed}.ts`, `worker/routes/merchantRecipes.ts` | `recipeCost` (simulate ≈ priceJob ±1 IQD per line, ladder provenance, owner-only, never on a public route), `filamentFacts` (survives the shelf PUT), `committedFilament` |
| B4 Checkout cost | `storeOrders.ts` (cost snapshots from coefficients; production_snapshot grams and minutes), `worker/lib/catalog/product.ts` + `packages/catalog/src/variants.ts` (`cost_iqd`, optional) | `costSnapshot` (0095 semantics; Levonis finance ignores merchant rows) |
| B5 Production card | `src/components/merchant/orders/production/*` extended (grams, hidden, steps, checks, actuals, print view), `worker/lib/blueprint/production.ts` | `productionCard` |
| B6 Recipe UI | `src/components/merchant/catalog/recipe/*`; seam ProductEditorSheet (What's used Disclosure + the Pricing cost field; one key in `catalog/strings.ts`, rebased last) | `recipeUi` |
| B7 Builder in 3D | `blueprint/ScenePick.tsx` (tap a part → RoleSheet; anchors from the hit point) and PreviewAsCustomer using the customer track's Customizer with the draft spec | — |
| B8 Profit and attention | `merchantAnalytics.ts` (profit block, unknown costs counted), `AnalyticsSection.tsx` (one KpiTile row); integrator seam `merchantWorkspace.ts` (stock source adds `publish_state='hidden' AND part_spec IS NOT NULL`, `first[]` rows carry `used_in`) plus the counter row copy | `profitAnalytics`, `partsAttention` |
| B9 Library | `/library`, `src/components/merchant/catalog/library/AssetLibrary.tsx`; duplicate copies the recipe (seam) | — |
| B10 Proof | `recipe` fixture, `e2e-recipe.mjs`, strings, budgets | — |

DECISIONS row: merchant cost recorded for store lines (a 0095 amendment); committed filament at read time.

### W3 · «Parts everywhere and colour truth»

Wave 7, beside P10; fallback wave 9, beside Community 8. Migration role `print_parts`. It needs P6 (RequestComposer) and P9 (`printRequests`, `printQuote`, `PrintPricingAdmin`) merged, so W3 rebases on them and they never rebase on W3.

| Builder | Owns |
|---|---|
| B1 | Schema |
| B2 | Request parts: `printRequests.ts`, `worker/lib/printAccessories.ts` (+`effectiveAccessories`), `printQuote.ts` (two call-site swaps), `marketplace.ts` (`publicRequest` summary). Tests: `requestParts`, extended `printAccessories`, `printEstimateContract` unchanged. |
| B3 | Offer parts: `marketplace.ts` (offers), `worker/lib/requestRevisions.ts`. Tests: `offerParts`. |
| B4 | UI: `src/components/customize/parts/*`, `community/requests/{OfferComposer,OfferCompare}.tsx`, one mount line in RequestComposer |
| B5 | Levonis door: `src/pages/Product.tsx` (lazy mount), `customize/useInProject/UseInProjectSheet.tsx`, `/print-parts/:id/uses` |
| B6 | Colour truth: SwatchSheet (merchant photo or the linked Levonis filament product's image), palette photos |
| B7 | Admin: link picker per accessory row in `PrintPricingAdmin.tsx` |
| B8 | Ecosystems: `interfaces` + `fits_family`, the `/modules` door, `compatibleUpgrades` for the Digital Twin track |
| B9 | Proof: `e2e-parts-everywhere.mjs` |

### Cross-track seams (consumed, never edited here)

- **Customer track:** the spec, the doc, AddOnsSheet, the pure package and `surfaceOf`. Its «Request printing» path from a blueprint carries the same configuration and summary.
- **Manufacturing track:** `production_snapshot`, `order_item_parts`, recipes (steps, checks), actuals and `committedGrams()`. It adds custom-order grams there.
- **Digital Twin track:** immutable, referenced versions; the public coarse mesh per version; `configuration_snapshot`; `order_item_parts` (replacement parts); `compatibleUpgrades`.
- **Levo Project quote assistant:** the economics door with `qty`.
- **P10:** `requireStoreAccess` on these routes.
- **P11:** replaces the catalogue→engine material map inside `recipeCost.ts`, pinned by the golden test.

---

## 7. Trade-offs

1. **Variants stay the price, stock and SKU axis; the blueprint annotates them** (dims, recommended, look/material, tier).
   - Gain: VariantEditor, cancel restock, SKUs and per-variant photos work as they do, and products that already have variants become customizable without conversion.
   - Cost: two editors (Options & variants for prices, the builder for geometry) and the 0126 cap of three priced axes. Repeat counts and extras are fees.
2. **A versioned JSON document with a pure normaliser, a head pointer and a derived refs index**, rather than region, slot and option tables.
   - Gain: atomic versions, trivial duplication, immutable history for orders and twins, one-wave loads.
   - Cost: the spec is not queryable in SQL; the refs index and head cover every query needed.
3. **Parts are always the same store's products, often hidden («inside products only»).** Levonis is supply and vocabulary («From Levonis», «Restock»).
   - Gain: the one-seller cart, commission, ledger and cancel stories stay single.
   - Cost: the merchant must hold parts as products; «parts on demand from Levonis» is an owner question.
4. **Part units live in `order_item_parts`, not as 0058 child rows.**
   - Why: `merchant.ts:1102`, `chatCards.ts:519` and `chatCommerce.ts:732` list and count every `order_items` row; merchant readers never saw bundle children, and several are Community 6/P6/P7 files.
   - Gain: each configured line stays one row everywhere, restock comes from a trigger that mirrors 0126 §9, and the twin knows exact parts.
   - Cost: one more table, and the buyer sees parts in the summary words rather than per-part values via BundleContents.
5. **Configuration identity lives in `color_id = 'cfg:<hash>'`.**
   - Gain: one release, no index swap, fingerprint already covered.
   - Cost: a column with two meanings, owned by one helper and never exposed (`publicLine` shows `option_snapshot`).
6. **No quote door.** The client prices with the server's own pure function, and the server re-prices at add, cart, quote and place.
   - Gain: instant, no round trip from Iraq, and no POST under the gateway's read-only `/api/storefront`. The existing beacon POST already needs an exception there when the gateway flips; that is not this track's to fix.
   - Cost: about 5 KB lazy on the customer, and decency is judged only at add.
7. **Committed filament is derived at read time** rather than kept in a reservations ledger.
   - Gain: no hooks in P7's files, no drift, the DECISIONS 175 rule.
   - Cost: an approximation at a shelf recount («≈», plus a weekly «weigh your spools» nudge).
8. **Filament never blocks a sale** (sorted last, «ready later», merchant warned). Parts do block, because they are counted stock.
9. **Hidden materials are cost-only.** Product-backed always-used parts go in `fixed` and follow placement and cancel.
   - Gain: one stock lifecycle.
   - Cost: glue and screws are not counted unless the merchant makes them fixed parts.
10. **Recipe coefficients are computed at save through one engine B adapter.**
    - Gain: checkout does pure arithmetic and the simulator needs no network.
    - Cost: figures stay stale until the next save («costs changed — refresh»); P11 edits one file.
11. **The public template preview is a coarse (≤20k, snapped) immutable file behind /files/**; the full mesh stays private.
    - Gain: CDN caching for Iraqi phones and less exposure of the merchant's model.
    - Cost: preview fidelity; the owner may raise the cap.
12. **The builder is list-first with a server still in W1** and gains 3D pick mode from the customer track's scene in W2.
    - Gain: no second scene module in the codebase, and deterministic fixtures.
    - Cost: text and logo anchors are bbox faces until W2.
13. **Parametrics are honest:** uniform size scale and repeat. Hole diameters and wall thickness are different parts or products, because there is no CAD kernel.
14. **Exact hex appears only inside canvases**; chips are palette keys plus the merchant's name plus a photo (W3). Chips are approximate; the photo and the 3D view carry the truth.
15. **Kits are tables**, reusable across products and editable once, at the cost of two small tables and four routes.
16. **Merchant cost is recorded for store lines** when the merchant typed a cost. This reverses 0095's «merchant rows stay unrecorded» for merchant-only use, pinned by a Levonis-finance test.
17. **No new mount prefix.**
    - Gain: no gateway rows and no EXPECTED_OWNER edits.
    - Cost: the literal `/api/products/print-parts` shadows a Levonis product slugged «print-parts», the same class of risk `/print-calculator` carries.
18. **The money path lands in W1** (dark, wave 1, while `cart.ts` and `storeOrders.ts` are free) instead of inside the customer track's wave-3 workflow.
    - Gain: one owner and an early set of attack tests.
    - Cost: a heavy W1. If it must shrink, B5 splits into a W1b that has to land before the customer phase.

---

## 8. Open questions for the owner

1. **Who sells a part?** Recommended: always the merchant's own product, created from Levonis in one tap and restocked through normal Levonis orders. The alternative, Levonis-sold lines inside a merchant order, breaks the one-seller cart, commission and ledger.
2. **When a tracked shelf cannot cover a colour, may the customer still buy it?** Recommended: yes, «ready later» with extra prep days and the merchant warned. The alternative is to hide the colour.
3. **Minimum price protection:** warn by default, with the merchant switching to «never below my cost» per product (recommended), or block for everyone?
4. **Access:** every selling (PLUS) store, a pilot list first (recommended), or a PRO-only tool?
5. **Row 169:** approve real Sorani in merchant string files (assumed here), with one native-reader pass.
6. **Public template preview:** coarse ≤20k (recommended) or full detail? Buyers never receive template files (recommended).
7. **Retention:** how long are customer names, logos, photos and NFC phone numbers kept in configurations after completion (Digital Twin, reorder, disputes), and may the merchant keep downloading them?
8. **Parts inside products:** priced by default at their live store price, or included with difference-only upgrades?
9. **Which Levonis products are flagged `printed_use` first** (magnets, LEDs, NFC tags, inserts, keyrings)? Are the 26 accessory rows linked (recommended) and later retired?
10. **Should registering a model require «I have the right to sell prints of this model»** (`license_ack`, recommended), keeping the source for disputes?
11. **After P10:** do staff with «products» see costs, or only a «finance» capability?
12. **Should the recipe ask an optional courier cost per order** so profit subtracts delivery?
13. **May production actuals feed engine B calibration** (`print_actuals`)? This needs P11's material vocabulary.
14. **Ecosystem modules:** same-store only in v1 (recommended) or a Levonis-run cross-store family vocabulary?
15. **CPU plan:** inline registration of up to 40 MiB (Standard plan) or `waitUntil` with a «processing» state?
16. **Kill switch:** keep already-carted configured lines checking out (recommended), or block them too?

GRAFTS: ["From P1: `worker/lib/modelParts.ts` reads the file the merchant already prints. For 3MF it takes `<components>` with composed transforms, part names and extruders from Metadata/model_settings.config, filament colours from project_settings, paint states at whole-triangle resolution, and slice_info grams/time. It also reads OBJ o/g/usemtl groups and multi-solid ASCII STL. P2's 12 per-part files are kept, merged in their shared frame into ONE LVM1+LVR1 mesh per version. This replaces P2's 'the parts are the files until the geometry track lands'.","From P1: the tiles-first builder. «What can your customer change?» tiles switch on from the file, each opens one prefilled Disclosure card, and the 60-second path is upload → tiles on → Save. W1 shows a server parts-map still. W2 adds 3D pick mode from the customer track's shared scene; the builder never imports ogl. «Preview as customer» is included. P2's HealthStrip is kept as the footer.","From P1: `surfaceOf(spec)` in the pure package guarantees ≤5 primary customer controls, pinned by a test over a generated spec corpus.","From P1: committed filament is derived at read time from production snapshots of open orders against the shelf baseline (the DECISIONS 175 read-time rule), exported as `committedGrams()` for the manufacturing track. It replaces P2's production_reservations ledger.","From P1: `merchant_filament_swatches` on the shelf's natural key (merchant, material, hex) holds price per kg, look, brand, a supply link to the Levonis filament product, and later a photo and calibration. It survives the DELETE+INSERT shelf PUT. The Levonis filament product's own images are the reference photos, so there is no admin swatch desk.","From P1: `cost_iqd` on community_products and variants for EVERY product. Cost is written into order_items.cost_iqd/cost_basis 'snapshot' inside the placement batch, computed from stored recipe coefficients (0095 semantics). A profit KPI row counts unknown costs as unknown and never guesses them.","From P1: recipe coefficients are computed at save through ONE engine B adapter (`recipeCost.ts`). The client runs a pure `simulate(coeffs)` pinned to priceJob by a golden test (±1 IQD per line), so there is no network call per drag and P11 edits one file.","From P1: the production card's merchant-only file doors (qr.svg via qrToSvgPath now; logo/photo when the customer track's purpose lands), actual grams, and owner-only profit. P2's print view on the existing orderPrint stylesheet is kept.","From P1: the low-stock fix. The workspace stock source counts published products only (merchantWorkspace.ts:293-301), so hidden part-only products are added to it with `used_in` on its first rows.","From P1: `tests/blueprintUiTokens.test.ts` (every className token in the new folders already exists elsewhere in src) and `tests/customerVocabulary.test.ts` (closes gap G1).","From P1: request and offer parts through `effectiveAccessories(db)` at the three printAccessories call sites; factsHash only includes parts when non-null. Adds «Use in a printing project» on Product.tsx and photo-only blueprints (merchant photos per colour/size when there is no model).","From P1: slot pricing 'included' charges only the positive difference (never negative); a `repeat` modifier (2/4/6 slots) is priced per extra; a merchant status door means `/me` is not edited; builder conflict UX re-applies the draft over a newer version.","Judge's fix: part units are recorded in a new `order_item_parts` table (precedent: 0098 `order_item_inventory_allocations`) instead of both proposals' 0058 child rows. They are decremented through the existing fences and restocked by `trg_store_order_cancel_restocks_parts`, which mirrors 0126 §9. merchant.ts, chatCards.ts, chatCommerce.ts and merchantOrders.ts need no edit, and each configured line stays one order row.","Judge's fix: the public GET doors go on the existing `/api/storefront` prefix (GET only), the Levonis parts door is a new file mounted on the existing `/api/products` prefix before productRoutes (like `/print-calculator`), and merchant routers go on `/api/merchant`. No new gateway row, and no POST under the gateway's read-only prefix.","Judge's fix: the public coarse template mesh (≤20k triangles, snapped, LVR1 trailer kept) is written content-addressed under `merchants/<uid>/public/bp/<pid>/<hash>.lvm.gz` and served by the existing /files/ door (immutable, edge cache, Range), so there is no mesh route. The full ≤50k mesh and the still stay private under `blueprint-previews/`.","Judge's fix: modelParts reuses modelGeometry's bounded ZIP reader and 3MF transform through export-only edits, so fflate stays inside the allowlisted file and the ZIP-bomb guard exists once. The PNG still and gzip use CompressionStream.","Judge's fix: the blueprint head is a pointer only (version, state) and content lives in the immutable versions table. The immutability trigger covers content columns only, so the placement batch can stamp `referenced_at`, and pruning never removes a referenced version.","Judge's fix: W1 touches no P6 file. The storefront `customizable` flag and door belong to the customer track's post-P6 phase, and BundleContents is not needed. The LineSpec lazy mount in OrderDetailScreen lands in W1 (wave 1), so W2 never touches P7's files in P7's wave. Deleting a part product archives it when order_item_parts reference it."]

REJECTED: ["P1: pricing sizes, looks and tiers inside the spec, and refusing products that already have variants (CUSTOMIZATION_HAS_VARIANTS plus a forced conversion). It duplicates the 0126 price/stock/SKU axis. Rejected for P2's variant groups annotated by the blueprint; variant ids survive edits (product.ts:593-706).","P1: version fence written into orders.status. It aborts as OUT_OF_STOCK (storeOrders.ts:928-930,1133), not the CART_CHANGED it promises. Replaced by the address_snapshot fence.","P1 (missed): part products added to cart.products would reach productFileGrantStatement (storeOrders.ts:1017-1023) and grant their paid downloads. Grants are fed line product ids only.","P1: garbage-collecting versions older than current−20 while orders reference them. Replaced by referenced_at pinning and pruning only unreferenced versions.","P1: POST /api/storefront/…/customization/quote. The gateway treats /api/storefront as read-only (services/gateway/src/validation.ts:45,103), and the add door is already the authority. Dropped; the shared pure function gives the instant price.","P1: the spec version inside the line identity hash. Equal configurations would split across a merchant publish. bp is excluded from the hash, as in P2.","P1: the template as a product_files preview row plus a template_key column, and a public ≤50k mesh. It lists templates in the public file list, spends the 12-file budget and exposes a near-printable model. Replaced by private model_json keys, a private full mesh and a public coarse ≤20k mesh.","P1: new worker files importing fflate for 3MF unzip and the PNG writer. That breaks tests/store-isolation.test.ts's allowlist. modelGeometry's bounded ZIP reader is exported instead, and PNG/gzip use CompressionStream.","P1: purging every customizable-product document of the store on each shelf PUT. Replaced by one per-store palette door and one purge.","P1: a denormalised customizable flag on community_products, a separate PartsShelf chunk and ?view=parts|library contract words. Replaced by the head table's state, a kind filter on the existing list with one query word, and a library sheet.","P1: the Levonis starter library in this track. A starter is a Levonis-published design, and adoption needs the licence and royalty rules the design-marketplace track (Part 4 #12) owns. Handed over; the blueprint format supports it.","P1: merging this track's money path into the customer track's wave-3 workflow. That makes one very large workflow; the money path lands dark in W1 while cart.ts and storeOrders.ts are free, and the customer phase stays UI-only.","Both proposals: part lines as 0058 bundle child rows at 0 IQD. merchant.ts:1102 item_count, chatCards.ts:519 and chatCommerce.ts:732 would list and count them, and those are Community 6/P6/P7 files. Replaced by order_item_parts plus a cancel restock trigger mirroring 0126 §9.","P2: production_reservations (reserve at placement, consume at shipping with writes to the shelf and part stock, release at cancel). It is a second stock-movement path, puts hooks in P7's storeOrderOps.ts and merchant.ts in P7's wave, and admits oversell of hidden consumables. Replaced by read-time committed filament and by counting product-backed fixed parts at placement.","P2: community_part_costs table. Replaced by cost_iqd on community_products and variants, which serves profit for every product, not only parts.","P2: filament_swatches with Levonis/merchant owners, an admin CRUD desk and merchant_material_stock.swatch_id round-tripped through the replacing PUT. Replaced by P1's natural-key merchant_filament_swatches, with the Levonis filament product's own images as reference photos.","P2: new /api/customize and /api/parts prefixes. They need gateway rows and EXPECTED_OWNER entries it did not plan. Public GETs use /api/storefront, and the Levonis parts door uses the existing /api/products prefix.","P2: a dedicated mesh route. The coarse mesh is a content-addressed public object served by the existing /files/ door.","P2: MeshCanvas built in W1 with 'whichever workflow lands first owns it'. That races the customer track and makes two scene modules likely. The builder uses a server still in W1 and the customer track's scene in pick mode in W2.","P2: 'the parts are the files' until a geometry track parses named parts. A merchant's Bambu 3MF with <components> measures NO_GEOMETRY today. Replaced by modelParts.ts in W1, with P2's N-file option kept.","P2: W1 edits to storefront.ts (customizable summary) and OrderDetail.tsx (label) that force P6 to wait. Dropped: the flag belongs to the customer track's post-P6 phase, and BundleContents is not used.","P2: POST …/cost on every simulator change (240/h). Replaced by client simulate() over server-computed coefficients, pinned by a golden test.","P2: cost snapshot written after the response. It is computed purely from stored coefficients inside the placement batch.","P2: the four-tab TabStrip builder with a 40vh canvas at 360. Replaced by P1's tiles and prefilled cards; P2's HealthStrip is kept.","P2: a separate /blueprint/suggest door. Suggestions come back from the builder read and from model registration.","P2: custom-order reservations in the marketplace accept batch and eligibility subtracting reserved grams (C-MT3 B8/B9). Handed to the manufacturing track through the exported read-time committedGrams(); no accept-batch edit.","P2: extending the published-only stock source with used_in alone. Hidden part-only products would still be missed (merchantWorkspace.ts:293-301), so the predicate also admits hidden parts."]

### Judge's scores — merchant-templates-components

| Criterion | Proposal 1 (owner-first, «customization») | Proposal 2 (systems-first, «blueprint») |
|---|---|---|
| Simplicity for the customer (five-control rule) | **5** — `surfaceOf(spec)` pins ≤5 controls by test. Add-ons go inside More with one summary line under the price. A size bump forced by a part happens automatically and is explained. A disabled option offers a one-tap alternative. | **5** — Colors · Size · Add-ons. A required slot is one summary line under Size and never a sixth control. Unavailable options name the nearest alternative by spec. The price comes from the same pure function with no round trip. |
| Power for the merchant | **5** — Reads the 3MF the merchant already prints: components, part names and extruders, filament colours, paint states and slice grams. The capability tiles switch themselves on (the 60-second path). The simulator recalculates on every drag with no network. The production card has QR/logo file doors and actual grams, plus profit KPIs and a parts shelf. | **3.5** — Suggest door, automatic rule presets, reusable kits and «From Levonis» in one sheet are strong. But templates need one file per part until "the geometry track" parses named parts, and a Bambu 3MF with `<components>` measures NO_GEOMETRY today. Every simulator change is a POST (240/h). |
| Reuse of what exists (no duplicated systems) | **3** — Prices sizes, looks and tiers inside the spec, a second price axis beside the 0126 variants. It refuses products that already have variants (CUSTOMIZATION_HAS_VARIANTS plus a forced conversion). It adds a denormalised `customizable` flag and puts the template as a preview row in the public file list. Its read-time committed filament and natural-key shelf facts are good reuse. | **4** — Variants stay the one price/stock/SKU axis and the blueprint only annotates them. One flat part vocabulary serves Levonis `spec_fields` (no products migration) and merchant `part_spec`, and model keys stay private. But `production_reservations` is a second stock-movement path for community products and the shelf. `filament_swatches` with an admin desk duplicates the photos the Levonis filament products already carry. |
| Budgets (bytes, CSS, D1 waves) | **4** — +0 CSS proven by a tokens test, growth ceilings named, every surface lazy. But every shelf PUT purges every customizable-product document of the store. The builder chunk is 20 KB. Its CommandCenter ceiling (≤15,400 B) is already below today's 15,652 B. | **4.5** — +0 CSS by listing classes and using inline styles for one-offs. One palette door per store means one purge. The public mesh is coarse and immutable, and part facts load in one wave. MeshCanvas plus vendor-webgl sit in the builder, lazily. |
| Security and money soundness | **2.5** — The version fence NULLs `orders.status`, which answers OUT_OF_STOCK, not CART_CHANGED. Part products join `cart.products`, which feeds `productFileGrantStatement`, so a magnet would grant its paid files. GC deletes versions that orders reference while the design calls the order snapshot "the version". The POST quote door sits under the gateway's read-only `/api/storefront`. The spec version inside the line hash splits equal lines across a publish. In-batch cost and whole-body scans are right. | **4.5** — `address_snapshot` fence (CART_CHANGED). Grants are fed line ids. `PART_BUYABLE_SQL` includes store_id. Versions are made immutable by a trigger and referenced versions are never pruned. `bp` is excluded from the identity. QR payloads are built on the server, the kill switch has clear semantics, and there are about 25 attack tests. Misses that 0-IQD child rows appear in merchant and chat readers that never saw bundle children, and admits hidden-part oversell. |
| Mobile-first | **5** — Tiles and prefilled cards read top to bottom at 360. A still stands in for a canvas on phones. Every screen is drawn at 360 and 1280. | **4** — A four-tab strip plus a `min(40vh,300px)` canvas precede the first row at 360. The sheets are otherwise good. |
| Feasibility on Workers/D1/ogl | **3.5** — The parser and PNG writer are planned on fflate outside `tests/store-isolation.test.ts`'s allowlist. Three new mounts have no gateway rows. The inline 40 MiB parse runs on an unknown CPU plan (flagged honestly). | **4** — The per-file derive path is the proven one. A CPU picker keeps ogl's Raycast out, and SwiftShader renders headless. The two new prefixes (`/api/customize`, `/api/parts`) need gateway rows and EXPECTED_OWNER entries it does not plan. |
| Schedule fit with the running programmes | **4** — M1 in wave 1 carries no money path and touches no Community 6 or P6 file. M2 folds into the customer track's wave-3 workflow: one owner of cart/storeOrders, but one very large workflow. M3 before P9 makes P9 rebase. | **3** — W1 edits `storefront.ts` and `OrderDetail.tsx`, so P6 must wait for it. W2's reservations add statements to `storeOrderOps.ts` and `merchant.ts`, P7's files, in P7's own wave. "Whichever workflow lands first owns MeshCanvas" races the customer track. |
| **Total /40** | **32** | **32.5** |
| **Weighted (money soundness and reuse ×2)** | **37.5** | **41** |

---

## Track — levo-project (judged synthesis; the judge chose Proposal 1 (container-first) as the spine)

# Levo Project — the merged design (track «levo-project»)

The spine is Proposal 1 (container-first). Ideas taken from the other two are tagged **[P2]** (journey-first) and **[P3]** (systems-first).

Everything below was checked read-only against the tree on 2026-09-30 at about 12:30Z:
- dist built at 11:54, gzip level 9: CSS 60,964 of 61,440 B (476 B headroom); Request chunk 41,298 B; ModelViewer 7,428 B; vendor-webgl 15,629 B; CustomOrderScreen 3,197 B; entry 67,912 B.
- Migrations end at 0161 (next free number at merge: 0162).
- DECISIONS end at row 182 (next free row: 183).
- `/requests/:id` is now routed (App.tsx:948).
- Phase 5's client files (Request.tsx, OfferCompare, OfferComposer, OrderTimeline, CustomOrderScreen) are present but uncommitted.

## 1. Concept

**One request, one room.**
- A Levo Project is a family of requests, created lazily. Its id is the **root request's id**.
- Its Room is Phase 5's own page, `/requests/:id` (src/pages/community/Request.tsx), with one lazy frame added:
  - a **next-step card** (the "moment") inside the `status` landmark, where the draft card already sits;
  - a **lineage rail** inside `header`, shown only when the job has both a design stage and a print stage;
  - a **⋯ menu** in the TopBar;
  - a link-mode **tab strip** «الطلب · التصميم · القطعة». Its tabs appear only when the job has versions, notes, invited people or a finished piece.
- Every notice, chat card, board row and workspace door that already opens a request now opens its Room.
- A plain STL job looks exactly as it does today (no row, no tabs). The one exception: while it takes offers, its owner sees a single feasibility line.

**Side tables, decisions made at read time, money through the existing doors.**
- Around community_requests, community_offers, community_orders, community_escrows, chats and user_notifications, Levo adds only side tables, all owned by `marketplace`:
  - the request family, members and invites;
  - version files, immutable versions and 3D notes;
  - append-only decisions and change orders;
  - offer extras (terms and variants) and handoff manifests;
  - QC results, per-order serials, service events and evidence manifests.
- No existing table gains a column or a trigger.
- These are worked out at read time, never stored: the next step (one server-decided moment per role and state [P2]), the production lock, the revision budget, `production_hash` [P3], feasibility and the Digital Twin.
- Money moves only through the unchanged accept, confirm, refund and admin-resolve code.
  - A paid change or an extra revision is a small hidden **child order**, bought through the unchanged accept route.
  - A fenced cron follower starts, delivers and releases each child together with its parent, never on its own.
- The lock gates **delivery, not start** [P3]:
  - The first version a workshop sends starts the work, so design work can no longer be undone by a one-tap refunding cancel.
  - An order cannot be marked delivered while its latest version waits for approval, or while a change waits for the customer. Nothing is ever modified silently.

**Compact on top, deep underneath.**
- The customer sees one next step and at most five controls (back · ⋯ · the step · the tab strip · the 3D stage). They never see a mesh, slicer or file-format word.
- The workshop gets the depth in a **WorkPanel** inside its existing order screen [P3]: versions with handoff notes, priced changes with a diff the server computes, a cost-backed offer suggestion, QC, labels and the production summary.
- Invited viewers, commenters and approvers see only their slice.
- Staff get a frozen, hashed evidence package.
- Everything ships dark behind one admin setting, in three workflows:
  - **W1 «الغرفة»** (the Room) — moves no money;
  - **W2 «المال والعروض»** (money and makers);
  - **W3 «بعد الصنع»** (after the order).

## 2. Screens

**Conventions**
- ar and ckb run right-to-left, en left-to-right. Mirroring uses logical utilities only.
- Notation: «▢» picture or 3D stage; «[ ]» Button; «┌ a ┬ b ┐» TabStrip or Segmented; «╞═╡» top edge of a Sheet v2; «⋯» Menu.
- Every class below was checked in dist/assets/*.css (11:54 build): lv-surface lv-section lv-choice lv-hit lv-card lv-swatch lv-alert-info/-warning/-success · aspect-[4/3] aspect-square · lg:flex lg:flex-row lg:items-start lg:gap-6 lg:sticky lg:top-6 lg:shrink-0 lg:flex-1 lg:max-w-5xl lg:grid-cols-2 lg:hidden lg:block sm:hidden sm:block · size-8/9/11 min-h-11 · ring-2 ring-gold bg-gold/10 bg-warning/10 · touch-none · divide-y divide-border-subtle · tabular-nums · max-h-[60vh] · start-3 end-3 top-3 bottom-3 · snap-x grid-cols-2 line-clamp-2 border-s-2 opacity-60 · text-[11px] [12.5px] [13px] [13.5px] [16px] [19px] · h-1 bg-surface-selected min-w-0 flex-1 self-start scroll-mt-14.
- These classes are **absent** from the built CSS, so they become inline styles (the Toast/ComposerDock pattern): lg:w-80, lg:min-w-0, lg:col-span-2, lg:order-first, lg:self-start, translate-x-1/2, cursor-crosshair, max-h-64.
- **No new utility classes.**

**Landmarks: none added.**
- The next-step card sits inside `status`, the lineage rail inside `header`, the ⋯ inside TopBar.
- The TabStrip sits between `status` and `files`, outside any landmark. Tab bodies live in their own lazy files.
- So REQUEST_SECTIONS (requestStates.ts:133), tests/requestPageUi.test.ts:310-317 and e2e-request's ORDER array all stay untouched.

**S1 · 360 · ar · customer · a workshop designs and prints; version 2 waits · `/requests/:id?room=design`**
```
┌────────────────────────────────────┐
│ →  طلب طباعة                      ⋯ │ TopBar (existing) + RoomMenu ⋯ (lazy Menu: ادعُ شخصًا · من يتابع · أبلغ عن مشكلة)
│ حامل يد تحكّم «علي»    ⟦قيد التنفيذ⟧ │ <header data-request-section="header">: h1 text-[19px] + StatusChip — untouched
│ من علي · الورشة: ورشة نور             │ text-[12.5px] text-text-muted — untouched
│ ◉ التصميم ✓ ─── ● الطباعة             │ LineageRail [P2]: <ol> with aria-current, only for a family with ≥ 2 stages
│ ▬▬ ▬▬ ▬▬ ▬▬ ▭▭ ▭▭   الخطوة ٤ من ٦      │ status: the existing step strip — untouched
│┌──────────────────────────────────┐│ next-step card (lazy RoomFrame): lv-surface p-4, role=status, aria-live=polite
││ أرسلت الورشة النسخة ٢ — وافق قبل الطباعة ││ h2 text-[13.5px] font-semibold (the server sends a key; the words are client strings)
││ أعرض من النسخة ١ بـ٤ ملم             ││ the server's diff line, text-[12.5px] text-text-secondary
││ [ راجِع التصميم ]                   ││ exactly ONE primary Button sm → ?room=design; focus moves to the approve button
│└──────────────────────────────────┘│
│ ┌  الطلب  ┬  التصميم •  ┬  القطعة  ┐ │ TabStrip link mode group="room" fill; items[].show = the server's tabs[]; «•» = waits for you
├────────────────────────────────────┤ panel = lazy RoomDesign (Suspense → Skeleton aspect-[4/3] rounded-2xl)
│ ┌────────────────────────────────┐ │ PinStage: relative aspect-[4/3] rounded-2xl bg-surface-raised overflow-hidden touch-none
│ │               ▢          ①     │ │ ogl canvas via viewer/scene; the coarse mesh loads first
│ │     ②                     [⤢]  │ │ pins: size-8 buttons (lv-hit) ring-2 ring-gold bg-gold/10, repositioned each frame; opacity-60 facing away
│ └────────────────────────────────┘ │ ⤢ → Overlay (same canvas, full screen; full mesh for owner and approvers)
│ [📍 أضف ملاحظة]  [⟲]    ┌ ن١ ┬ ن٢● ┐ │ Button secondary sm · IconButton reset · Segmented sm group="version" (compare keeps the camera)
│ «وسّعتُ القاعدة ٥ ملم كما طلبت» — نور │ version note text-[13px] dir=auto
│ ملاحظتان مفتوحتان                  ›  │ row min-h-11 → PinsSheet (the accessible alternative to the dots)
│ التعديلات المشمولة: ١ من ٢            │ budget line, tabular-nums (W2; hidden without terms)
│ [      وافق على هذا التصميم       ]  │ approve button IN THE FLOW (never fixed bottom-0): primary block
│             اطلب تعديلًا              │ ghost → medium Sheet with one textarea ≤500; at 0 left (W2): «تعديل إضافي بـ٥٬٠٠٠ د.ع — ادفع وأرسل»
└────────────────────────────────────┘
```
- **Five-control rule.** Above the panel there are four tab stops: back, ⋯, the step, and the tab strip (one roving tab stop, per Tabs.tsx). The stage is the fifth control, inside the panel. e2e counts these.
- A job with no versions, notes, members or finished piece shows no rail, no tabs and no card.
- **S1b — the owner's pre-order line.** While a plain job takes offers, its owner sees one line inside `status`, with no button (the fix is the existing edit door):
  - «✓ جاهزة للطباعة — ١٢ ورشة تستطيع صنعها»
  - «تحتاج مراجعة سريعة: قدّرنا المقاس ٨×٦×٤ سم»
  - «أكبر مما تطبعه الورش القريبة»
  - Styling: lv-alert-info or -warning, text-[12.5px].
- Next to Phase 5's «عرض ثلاثي الأبعاد» door, a «ملاحظات على القطعة» link (owner and stage merchant) opens `?room=design`. The first note turns the request revision into version 1.

**S2 · 1280 · en · the same Room**
The frame uses `mx-auto max-w-2xl lg:max-w-5xl px-4` only while the design or piece tab is open.
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ←  Print request                                                           ⋯ │
│ Controller stand — ALI                                        [In progress]  │
│ by Ali · Workshop: Noor          ◉ Design ✓ ─── ● Print                      │
│ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▭▭▭▭ ▭▭▭▭   Published · Offers · Chosen · In progress …  │
│ ┌ The workshop sent version 2 — approve it before printing   [Review] ┐      │
│ ┌ Request ┬ Design • ┬ Your piece ┐                                          │
├─────────────────────────────────────────────┬────────────────────────────────┤ panel: lg:flex lg:items-start lg:gap-6
│ ┌─────────────────────────────────────────┐ │ «Widened the base 5 mm as asked»│ end column: inline inlineSize 26rem + lg:shrink-0
│ │                  ▢ 3D          ①        │ │ ① Make the logo smaller · Ali ✓ │ notes listed inline (no sheet at lg)
│ │      ②                            [⤢]   │ │ ② Round this edge · Ali         │
│ └─────────────────────────────────────────┘ │ Revisions: 1 of 2 used          │
│ [📍 Add a note] [⟲]      ┌ V1 ┬ V2● ┐        │ [Approve this design]           │
│ stage column: lg:sticky lg:top-6 lg:flex-1   │ Ask for changes                 │
└─────────────────────────────────────────────┴────────────────────────────────┘
```
- Header, status and tabs stay full width, in their DOM order. Only the panel splits.
- Hovering a note row lifts its dot (spring 'quick'). With reduced motion only the outline changes.

**S3 · 360 · ar · dropping a note** (owner, stage merchant, commenter or approver)
```
│ ┌────────────────────────────────┐ │
│ │ المس القطعة حيث تريد الملاحظة   ✕ │ │ lv-alert lv-alert-info absolute start-3 end-3 top-3 (note mode; aria-pressed on the button)
│ │                ▢       ✚        │ │ tap → CPU ray pick on the loaded mesh (viewer/pick); the dot springs in ('quick'; reduced: no scale)
│ └────────────────────────────────┘ │
╞════════════════════════════════════╡ Sheet detents ['medium'] dragHandle header footer — the stage stays visible above
│ ملاحظة على هذا الموضع                │ text-[16px] font-bold
│ [ اجعل الشعار أصغر هنا            ] │ Field textarea ≤500, dir=auto
│ ٤٨ / ٥٠٠                             │ tabular-nums text-text-muted
│ [ أضف الملاحظة ]            إلغاء     │ primary + ghost
```
- Tapping an existing dot opens the same sheet with its thread (one level of replies).
- The author, the owner or the stage merchant can mark it «تم» (resolved).
- On a picture, the note anchors at u/v coordinates instead.

**S4 · 360 · ar · customer · a paid change (W2)**
```
╞════════════════════════════════════╡ Sheet detents ['medium','large']
│ تعديل مقترح من ورشة نور              │
│ المغناطيس     ١٠ ملم  ←  ١٥ ملم        │ dl grid grid-cols-2 divide-y divide-border-subtle: the workshop's items (≤8) + the server's version diff
│ النسخة        ٣  ←  ٤    [عرض]         │ «عرض» swaps the stage to V4
│ «القاعدة الأعرض تحتاج مغناطيسًا أكبر»   │ the workshop's note
│ السعر         +٢٬٠٠٠ د.ع               │ Money = the child offer's server total
│ الموعد        +يوم → الجمعة             │ ready_by, a server date
│ يُحجز الفرق في محفظتك ولا يصل للورشة قبل تأكيدك الاستلام │ lv-alert lv-alert-info text-[12.5px]
│ [ وافق وادفع ٢٬٠٠٠ د.ع ]      لا، شكرًا  │ primary = UNCHANGED POST /offers/:childOfferId/accept {expected_total_iqd, offer_revision}
```
- INSUFFICIENT_FUNDS keeps its existing sentence and wallet link.
- A free change shows «وافق» only.
- A reduction (credits flag, W3) reads «وافق — يُعاد إليك ٥٬٠٠٠ د.ع عند تأكيد الاستلام».
- An invited approver sees only price-neutral changes [P2].

**S5 · 360 · ar · workshop · `/merchant/requests/orders/:id`**
CustomOrderScreen gets a lazy WorkPanel between its header card and its timeline [P3].
```
│ ← طلب مخصّص · علي ك.        ⦿ قيد التنفيذ │ existing header card (37,000 · يصلك 35,150)
│┌ العمل ─────────────────────────────┐│ WorkPanel: the workshop's moment [P2]
││ طلب علي تعديلًا على ن٢ — أرسل نسخة     ││ text-[13.5px] font-semibold
││ «اجعل الشعار أصغر» · ملاحظتان مفتوحتان  ││
││ [ أرسل نسخة جديدة ]                   ││ contextual primary; start/deliver stay the screen's own buttons
││ ⋯  اقترح تعديلًا · ملخّص الإنتاج · الفحص ││ Menu (rows appear as W2/W3 land)
│└──────────────────────────────────┘│
│ [ سلّمت العمل ]                        │ existing; refused with VERSION_AWAITS_APPROVAL while ن٣ waits — the panel says so first
│ … OrderTimeline (existing) …          │
```
- **VersionSheet** (Sheet 'large'; a centred window from sm up):
  - UploadTile ×≤4 (purpose `order_version`);
  - «ما الذي تغيّر؟» textarea ≤1000;
  - lv-choice «نسخة نهائية — أضف تعليمات التسليم», which reveals print notes, assembly steps (≤10), QC requirements (≤10) and replaceable parts (≤12);
  - licence Segmented (W2; limited by the accepted terms; hidden when only «خاص» is allowed);
  - the server's line «هذه النسخة تجيب طلب التعديل ٢ من ٢»;
  - [ أرسل للزبون ].
- On a funded order the sheet warns «إرسالها يبدأ العمل» [P3].
- **Production summary** (from ⋯): model · size · colours · name/logo · filament · parts · the lock («ن٣ · مرجع الإنتاج» plus `sha256:9f2c…` in an LTR island) [P3].

**S6 · 360 · ckb · the finished piece · `?room=piece`**
W1 ships a minimal version; W3 completes it.
```
│ ┌  داواکاری  ┬  دیزاین  ┬  پارچەکەت ● ┐ │ TabStrip
│ ┌────────────────────────────────┐ │ PinStage, read-only, showing the LOCKED version (W1)
│ │                ▢                │ │
│ └────────────────────────────────┘ │
│ ✓ گەیشت · ١٢/١٠/٢٠٢٦                 │ dl grid grid-cols-2 gap-3 (W1)
│ کۆدی پارچەکە   LEV-2026-091-0042   ›  │ <bdi dir="ltr"> → SerialSheet with the QR (W3)
│ گەرەنتی        تا ١٠/١/٢٠٢٧           │ from terms_extra (W2 terms, W3 display)
│ ✓ کوالیتییەکەی پشکنرا                ›  │ <details> → checked items + photos at ?w=320 (W3)
│ [ دووبارە داوای بکەرەوە ] [ یەکێکی تر ] │ W1: the existing /repeat (file jobs); W3: again from the lock, same | another workshop
│ زیاتر ⋯                              │ Menu (W3): گۆڕینی پارچەیەک · زیادکردن · داوای گەرەنتی · بڵاوکردنەوە لە کۆمەڵگا
│ مێژوو                                │ divide-y rows: دروستکرا · پشکنرا · گەیەنرا · داوای گەرەنتی (کراوە) (W3)
```
At 1280 the stage takes the start column and the facts take the 26rem end column.

**S7 · 360 · ar · owner · invite**
```
╞════════════════════════════════════╡ Sheet detents ['medium']
│ ادعُ شخصًا إلى هذا الطلب              │
│ ┌ يشاهد ┬ يعلّق ┬ يوافق ┐               │ Segmented sm group="invite-role"
│ «يرى النسخ والملاحظات فقط — لا المبلغ ولا العنوان ولا المحادثة» │ one hint per role, text-[12.5px]
│ [ أنشئ رابط دعوة ]                     │ navigator.share, else copy + Toast; /requests/:id#invite=<token> [P2]
│ المدعوّون (٢)                          │ rows: name · role · ⋯ (تغيير الدور · إلغاء الدعوة → ConfirmSheet)
```
The invite link lasts 7 days, binds to one account and requires signing in. At most 10 live members.

**S8 · 360 · ar · an offer with variants (W2)**, inside the existing OfferCompare card
```
│┌──────────────────────────────────┐│
││ ورشة نور ★4.8           ٣٥٬٠٠٠ د.ع ││ the total leads (existing)
││ ┌ بسعر أوفر ┬ الموصى به ┬ بأفضل مظهر ● ┐││ Segmented sm group="v-<offerId>", only when variants exist
││ حريري · PETG · ٦ أيام · جاهزة نحو ١٨/١٠ ││ the chosen variant; ready_by = a server date
││ ضمان ٩٠ يومًا · يشمل تعديلين · ترى التصميم قبل الطباعة ││ chips from the terms
││ [ اختر هذا ]                        ││ the existing AcceptSheet, now also sending the variant key
│└──────────────────────────────────┘│
```
- The quick comparison keeps its per-question winners (cheapest · fastest · top rated) and gains «جاهزة نحو» and «الضمان». It never names an overall «best».
- At 1280 the cards sit side by side (lg:grid-cols-2).
- **Composer (workshop):** one «شروط أكثر» disclosure containing:
  - الضمان [لا · ٣٠ · ٩٠ · ١٨٠ · سنة];
  - تعديلات مشمولة (QuantityInput; design scopes);
  - ثمن التعديل الإضافي (Field);
  - «أُري الزبون التصميم قبل الطباعة» (Switch; file jobs only; locked on for design scopes);
  - «＋ خيارات للزبون»: two more rows of price · days · look · one line.

**S9 · 360 · ar · design (W2)** [P2 + P1]
```
│ كيف تُصنع؟                                        │ one lv-choice pair in P6's RequestComposer, only when there is no file
│ ◉ ورشة تصمّمها وتطبعها — ترى التصميم قبل الطباعة   │ scope design_make (default): an ordinary board request
│ ◯ أريد مصمّمًا أولًا — الملفات تبقى لك              │ scope design_only → DesignerSheet
╞═ DesignerSheet (medium → large) ═╡
│ ◉ ورشة نور ★4.8 · يبدأ من ١٥٬٠٠٠   ▢ ▢ ▢           │ ≤12 stores with an active merchant_services kind 'design'; 3 public post covers
│ «يصل طلبك إلى هذه الورشة وحدها»                    │
│ [ أرسل لورشة نور ]                                 │ the existing chat print-request door in that store's thread + the project mark
╞═ after the final design is approved ═╡
│ التصميم لك — [ استلمت، أرسله للطباعة ]  هل من مشكلة؟ │ the moment: the existing confirm, then the handoff [P3]
╞═ HandoffSheet ═╡
│ من يطبعه؟ [ المصمّمة نفسها ] [ ورشة أخرى ] [ اللوحة ] │ the first only when the designer prints and takes work
│ نرسل الملفات المعتمدة والمقاسات والألوان مع الطلب      │
```

**S10 · 360 · ar · workshop · QC (W3)**
```
╞════════════════════════════════════╡ Sheet ['large'] — opens itself when «جاهز» is tapped and a checklist exists (a nudge) [P2]
│ فحص الجودة — قائمة «حوامل»      [عدّل] │ Segmented only with ≥ 2 checklists; «عدّل» = inline Field rows (≤12)
│ ☑ المقاسات صحيحة                       │ lv-choice rows min-h-11 aria-pressed; required items marked
│ ☐ الاسم مقروء   → [ سطر ملاحظة ]  📷     │ an unchecked item asks for one line; a photo is an ordinary «photo» update
│ [ سجّل الفحص ثم أعلن الجاهزية ]           │ POST qc, then the existing «ready» update; «passed» is computed by the server
```
The customer sees «✓ فُحصت الجودة», with details expandable.

**S11 · 360 · ar · a stranger scans the QR · `/t/:code` (W3)**
```
│ Levonis                                  │
│ ▢  a public template's cover or a neutral glyph — never the customer's photo, name or logo
│ قطعة مطبوعة من ورشة نور · تشرين الأول ٢٠٢٦  │
│ LEV-2026-091-0042                        │ <bdi dir="ltr">
│ [ اصنع واحدة مثلها ]                      │ only for a public/remixable design or a public template
│ هل هي لك؟ سجّل الدخول لفتح نسختها الرقمية    │ the owner lands on /requests/<root>?room=piece
```

**S12 · 1280 · en · admin · evidence (W3)**, a lazy panel linked from Phase 6's dispute desk
```
│ Evidence · order cord_… · frozen at the dispute 2026-10-14 09:12 · manifest sha256:9f2c… │ KpiTile ×3: items 31 · files 9 · changed since freeze 0
│ [Download JSON] [Read the conversation (audited, Phase 6)] [Resolve: order escrow] [Resolve: change escrow ×1] │ existing resolve route, one escrow at a time
│ 10-01 10:02 │ request  │ cust.  │ revision 3 published · hash      │ ✓ │ DataList, expandable rows
│ 10-02 18:40 │ offer    │ merch. │ accepted · premium · 35,000      │ ✓ │
│ 10-05 13:22 │ approval │ cust.  │ V3 approved (binding)            │ ✓ │
│ 10-07 09:00 │ change   │ merch. │ magnet 10→15 · +2,000 · paid     │ ✓ │
│ 10-10 12:05 │ qc       │ merch. │ passed 6/6 · production ref 9f2c │ ✓ │
│ 10-11 08:00 │ escrow   │ system │ held 35,000 · child held 2,000   │ ✓ │
│ 10-12 21:40 │ chat     │ —      │ 42 messages · last msg_… (no body)│ ⚠ changed since freeze │
```

**The moment table** (worker/lib/levo/moment.ts; pure; facts in, `{key, primary|null, more[]}` out) [P2]

*Customer (owner):*
- **Pre-order, plain job:** `feasibility_ready | feasibility_review | feasibility_adjust` — a line, no button.
- **Funded, design scope, no version yet:** `waiting_design` «الورشة تعمل على التصميم — ستراه قبل الطباعة».
- **A workshop version waits for the owner's binding decision:** `design_review` [راجِع التصميم].
- **A version was sent after an approval:** `reapproval` [راجِع التغيير].
- **W2 additions:**
  - `change_review` [راجِع التعديل];
  - `budget_spent` (the sheet offers the paid extra revision);
  - `design_done` [استلمت، أرسله للطباعة];
  - `stage_next` [افتح مرحلة الطباعة].
- **Approved and in production:** `making` «تُصنع الآن — جاهزة نحو {day}».
- **Completed with a project:** `owned` [اطلبها مرة أخرى].
- **W3 addition:** `owned_claim` [تابع الطلب].

*Workshop:*
- **Approval needed and no version, or the owner asked for changes:** `send_version` [أرسل نسخة].
- **A version waits:** `waiting_customer` (⋯ withdraw).
- **Approved:** `approved_go` (no button; the screen's own start/deliver buttons).
- **W2 addition:** `change_waiting`.
- **W3 additions:** `quality` [سجّل الفحص]; `claim_answer` [أجب].

*Member:* the owner's key, with a primary only for an approver on a version decision. Never money, never "again", never a contact detail.

## 3. Data model by role

**Principles**
- **The project id is the ROOT request id.** The family lives in ONE table, `levo_project_requests` (P2's single-table shape with P1's roles).
  - The root's row is written lazily by `ensureProjectStatement` (INSERT OR IGNORE), in the same batch as the first project feature: a version, a note, an invite, a change, a design mark or a recorded origin.
  - A request without a row is a plain job with defaults and costs nothing.
- **Additive only.** 15 new tables across three migrations, named by role and numbered next free at merge (≥ 0162):
  - W1 `levo_room` (6 tables);
  - W2 `levo_money_offers` (3 tables);
  - W3 `levo_after` (6 tables).
  - No column is added to an existing table, no CHECK is widened, no table is rebuilt.
- **No trigger on a money or state table** (community_requests, community_offers, community_orders, community_escrows). Triggers exist only on the new tables (immutable, append-only, decided once). Guards on existing rows are fenced clauses inside the routes' own UPDATEs.
- **Vocabularies other tracks extend** (roles, origins, licences, service kinds) are validated in TypeScript [P2]. The Levo lifecycles (member state, change state, decisions) keep CHECKs.
- **Worked out at read, never stored:** the moment, the lineage rail, the lock, the revision budget, production_ref, the twin, feasibility and ready_by.
- **Every new table** is owned by `marketplace` (packages/contracts/src/ownership.ts).

**W1 · `levo_room`**

`levo_project_requests` — the family
```
request_id TEXT PRIMARY KEY REFERENCES community_requests(id) ON DELETE CASCADE
project_id TEXT NOT NULL REFERENCES community_requests(id)      -- the root request id; equals request_id on the root
role TEXT NOT NULL DEFAULT 'root'   -- TS: root | print | change | extra_revision | replacement | upgrade; reserved for other tracks: subcontract | split | catalog_item
kind TEXT NOT NULL DEFAULT 'job'    -- TS, root only: job | design
origin_kind TEXT NOT NULL DEFAULT 'file' -- TS: file | idea | photo | design_request | config | template | product | remix | post | reorder | handoff
origin_ref TEXT NOT NULL DEFAULT '' CHECK (length(origin_ref) <= 80)   -- 'post:prj_…' | 'order:cord_…' | 'version:lpv_…' | 'design:…', checked against the caller's rights
parent_order_id TEXT REFERENCES community_orders(id)   -- the order a change / extra revision / replacement / upgrade serves
from_version_id TEXT REFERENCES levo_project_versions(id)   -- the handoff or replacement source
created_at TEXT NOT NULL
CHECK ((role = 'root') = (request_id = project_id))
INDEX (project_id, created_at); INDEX (parent_order_id) WHERE parent_order_id IS NOT NULL
```

`levo_members` — invites and members. One system; scope 'catalog' is reserved for the business track.
```
id 'lpm_' PK; scope_kind TEXT NOT NULL DEFAULT 'project'; scope_id TEXT NOT NULL (the root request id)
user_id TEXT REFERENCES users(id)          -- NULL while only invited
invite_hash TEXT UNIQUE                    -- SHA-256 of a 32-byte token shown once
role TEXT NOT NULL                         -- TS: viewer | commenter | approver
state TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','revoked'))
invited_by TEXT NOT NULL REFERENCES users(id); expires_at TEXT NOT NULL (+7 d); accepted_at; revoked_at; created_at
CHECK (state <> 'active' OR user_id IS NOT NULL)
UNIQUE (scope_kind, scope_id, user_id) WHERE user_id IS NOT NULL AND state = 'active'; INDEX (user_id, state)
```

`levo_project_files` — files a workshop adds on an order (in W2, also the customer's file for a change). P1's table, P2's placement.
```
id 'lpf_' PK; project_id NOT NULL; community_order_id TEXT REFERENCES community_orders(id)
uploader_id TEXT NOT NULL REFERENCES users(id)
file_key TEXT NOT NULL UNIQUE      -- private community-orders/<orderId>/versions/<id>.<ext>; never in any answer
name TEXT NOT NULL CHECK (length(name) <= 200); kind TEXT NOT NULL CHECK (kind IN ('model','image','document'))
bytes INTEGER NOT NULL CHECK (bytes > 0); sha256 TEXT NOT NULL DEFAULT ''   -- from file_objects (0156)
analysis TEXT NOT NULL DEFAULT '{}'    -- dims_mm, triangle_count, warnings[] as codes
preview_key TEXT NOT NULL DEFAULT ''   -- LVM1 at community-orders/<orderId>/versions/<id>.lvm (deriveModelPreview)
created_at
```

`levo_project_versions` — V1, V2 …; immutable
```
id 'lpv_' PK; project_id NOT NULL; no INTEGER NOT NULL CHECK (no >= 1); UNIQUE (project_id, no)
kind TEXT NOT NULL CHECK (kind IN ('request','config','design','change'))
    -- request = the customer's own revision (0130), materialised when first noted; config = the personalization snapshot from track C2
community_order_id TEXT REFERENCES community_orders(id)     -- NULL for request/config before an order
request_id TEXT REFERENCES community_requests(id); request_revision INTEGER
author_id TEXT NOT NULL; author_role TEXT NOT NULL CHECK (author_role IN ('customer','merchant'))
file_ids TEXT NOT NULL DEFAULT '[]'        -- ['lpf_…' | 'crf_…'] ≤ 4: ids, never keys
config_json TEXT NOT NULL DEFAULT '{}'; handoff_json TEXT NOT NULL DEFAULT '{}'
note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000)
final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0,1))     -- [P2] the design's deliverable
license TEXT NOT NULL DEFAULT 'private'    -- TS: private | shareable | remix | commercial | commercial_royalty (W2 limits it)
change_order_id TEXT                       -- W2
hash TEXT NOT NULL      -- sha256(kind, files' sha256 — or the revision row's hash for kind request [P3], config_json, handoff_json, note)
withdrawn_at TEXT       -- [P3] set once by the author, before any binding decision
created_at
TRIGGER BEFORE UPDATE OF no, kind, community_order_id, author_id, file_ids, config_json, handoff_json, note, final, license, change_order_id, hash
        → RAISE(ABORT,'LEVO_VERSION_IMMUTABLE')
TRIGGER BEFORE UPDATE OF withdrawn_at WHEN OLD.withdrawn_at IS NOT NULL → RAISE(ABORT,'LEVO_VERSION_IMMUTABLE')   -- no route deletes a version
INDEX (community_order_id, no DESC)
```

`levo_project_pins` — 3D and picture notes: clarifications, never revisions [P1]
```
id 'lpn_' PK; project_id; version_id NOT NULL; parent_id (one level of replies)
author_id; author_role CHECK (customer|merchant|member)
anchor TEXT NOT NULL DEFAULT '{}'; body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500)
state CHECK (open|resolved|removed) DEFAULT 'open'; resolved_by; resolved_at; client_id; created_at
INDEX (version_id, state, created_at); UNIQUE (author_id, client_id) WHERE client_id IS NOT NULL
```

`levo_project_approvals` — append-only decisions (P1's table with P3's invariant)
```
id 'lpa_' PK; project_id; version_id NOT NULL; community_order_id
decision TEXT NOT NULL CHECK (decision IN ('approved','changes_requested'))
binding INTEGER NOT NULL DEFAULT 1 CHECK (binding IN (0,1))       -- 0 = an advisory member's word
counts_revision INTEGER NOT NULL DEFAULT 0 CHECK (counts_revision IN (0,1))   -- W2 budget
by_user_id TEXT NOT NULL; by_role CHECK (customer|member); note ≤ 500; created_at
UNIQUE (version_id) WHERE binding = 1          -- one binding decision per version [P3]
TRIGGERs BEFORE UPDATE and BEFORE DELETE → RAISE(ABORT,'LEVO_APPROVAL_APPEND_ONLY')
INDEX (community_order_id, created_at DESC)
```

**W2 · `levo_money_offers`**

`levo_change_orders`
```
id 'lco_'; project_id; community_order_id NOT NULL; no INTEGER NOT NULL; UNIQUE (community_order_id, no)
kind TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change','extra_revision'))
proposed_by NOT NULL; proposed_role CHECK (customer|merchant)   -- the customer creates only extra_revision, priced from the snapshot
from_version_id, to_version_id
items_json TEXT NOT NULL DEFAULT '[]'   -- ≤ 8 {what, from, to} in the workshop's words [P2]; the server adds the version diff
note ≤ 500
price_delta_iqd INTEGER NOT NULL DEFAULT 0 CHECK (price_delta_iqd BETWEEN -100000000 AND 100000000)
days_delta INTEGER NOT NULL DEFAULT 0 CHECK (days_delta BETWEEN -60 AND 60)
answers_update_id TEXT                  -- the customer's modification_request (0160) it answers
child_request_id, child_offer_id
state CHECK (proposed|approved|declined|withdrawn|lapsed) DEFAULT 'proposed'; decided_by; decided_at; created_at; updated_at
CHECK ((price_delta_iqd > 0) = (child_offer_id IS NOT NULL))
UNIQUE (community_order_id) WHERE state = 'proposed'        -- one open change per order
TRIGGER BEFORE UPDATE OF price_delta_iqd, days_delta, items_json, from_version_id, to_version_id, child_request_id, child_offer_id → ABORT
TRIGGER BEFORE UPDATE OF state WHEN OLD.state <> 'proposed' → ABORT
```

`levo_offer_extras` — per offer revision; immutable (P1)
```
offer_id → community_offers ON DELETE CASCADE; offer_revision INTEGER NOT NULL; PK (offer_id, offer_revision)
variants_json '[]'; terms_json '{}'; created_at; TRIGGER BEFORE UPDATE → ABORT
```
- The extras in force for revision R are the row with the greatest `offer_revision` ≤ R.
- A new row is written only when the workshop changes them, always riding the revision bump the offer route already makes.
- Re-confirmations carry them forward with no write.

`levo_handoffs` — append-only (P1)
- Columns: id 'lho_'; project_id; version_id NOT NULL; from_order_id; to_request_id; target (TS: board | same_merchant | merchant); manifest_json NOT NULL; manifest_hash NOT NULL; created_by; created_at.

**W3 · `levo_after`**
- `merchant_qc_templates`: id 'mqc_'; merchant_id → community_merchants ON DELETE CASCADE; name ≤ 60; items_json '[]' (≤ 12); active; created_at; updated_at. At most 3 per merchant, enforced by the route.
- `levo_qc_results` (append-only): id 'lqc_'; community_order_id NOT NULL; template_json; results_json; passed CHECK (0,1); production_hash NOT NULL [P3]; checked_by; created_at; INDEX (community_order_id, created_at DESC).
- `levo_serial_counters`: year INTEGER PRIMARY KEY; next INTEGER NOT NULL DEFAULT 1.
- `levo_order_serials` [P2]: community_order_id TEXT PRIMARY KEY → community_orders; year; seq; serial TEXT NOT NULL UNIQUE ('LEV-2026-091'); production_hash; created_at.
  - Unit numbers (-0001 … -<quantity>) are derived and never stored, because 0098 PART 7 forbids a second device-serial chain.
- `levo_service_events` (P1's name, P2's states): id 'lse_'; project_id; community_order_id NOT NULL; kind (TS: claim | repair | replacement | upgrade); part_key '' (a handoff part key or a template region); body ≤ 1000; photo_keys '[]' (≤ 3, purpose order_update); state CHECK (open|covered|quoted|declined|done|withdrawn) DEFAULT 'open'; answer_note; child_request_id; opened_by; decided_by; decided_at; created_at; updated_at; UNIQUE (community_order_id, part_key) WHERE state IN ('open','covered','quoted').
- `levo_evidence_manifests` (append-only): complaint_id PK → community_complaints; community_order_id NOT NULL; items_json NOT NULL; manifest_hash NOT NULL; frozen_by (TS: 'dispute' | 'first_read'); created_at.

**JSON shapes** — normalised on the server; ids go in, keys never come out
- **anchor:**
  - `{"at":"mesh","file":"lpf_…|crf_…","p":[x,y,z],"n":[nx,ny,nz]}` in mm, in the file's centred LVM1 frame, so it survives the coarse mesh's snapping; numbers must be finite and inside the bounding box × 1.05;
  - or `{"at":"image","file":"…","u":0.42,"v":0.61}`;
  - or `{"at":"none"}` for a reply.
- **handoff_json:** `{print_notes ≤500, assembly[≤10 × 120], qc[≤10 × 120], parts[{key,label} ≤12], materials[], colors[{hex,name}], dims_mm{x,y,z}, components[]}`. Track C4 fills components later.
- **items_json (change):** `[{what: size|material|color|quantity|component|text|design|finish|other, from ≤80, to ≤80}]`, at most 8.
- **variants_json:** at most 3 `{key: economy|recommended|premium, price_iqd, completion_days, material_ids ≤5, look: classic|matte|shiny|silk|wood|marble|glow|flexible|'', quality: good_value|standard|best_look|'', note ≤200, warranty_days}`. 'recommended' is required and equals the offer's own price and days, so every existing reader keeps working.
- **terms_json:** `{scope: print|design_make|design_only, included_revisions 0–5, extra_revision_iqd ≥0, proof_required bool (print scope), warranty_days ∈ {0,30,90,180,365}, license_max, royalty: null}`.
  - The server infers scope from the request; it is never picked.
  - royalty is reserved and written only server-side, from track C3's design origin.
- **offer_snapshot additions at accept:** `"variant": {…}, "terms_extra": {…}`.
- **manifest_json (handoff):** `{version{id,no,license,hash}, files[{id,name,kind,bytes,sha256}], dims_mm, materials, colors, components, print_notes, assembly, qc, parts, designer{merchant_id,store}}`.
- **QC items:** `[{key, label, photo 0|1, required 0|1}]`, at most 12. Platform defaults (dims | colors | text | finish | assembly | packaging) carry no label and are translated on the client.
- **QC results:** `{items[{key, ok, note ≤200}], photo_update_ids[]}`.
- **Evidence item:** `{at, kind, actor (a role), summary, ref "table:id", hash, file{name, sha256}|null}`. The chat is a single item `{chat_id, last_message_id, count}`, never a body [P2].
- **Production spec [P3]:** `{v:1, base{request_revision, request_hash, offer_revision, variant_key}, version{id,no,hash}|null, changes[{id,no,items_hash}]}`. production_hash = sha256 of its canonical JSON.

**Worked out at read** (worker/lib/levo/*, pure where possible)
- **moment(role, facts)** → the table in §2.
- **lock(order)** → the latest non-withdrawn workshop version with a binding approval. Without one, the lock is the acceptance snapshot (request revision + hash).
- **may_deliver(order)** is true when all of these hold:
  - no newer workshop version is waiting;
  - (W2) no change is waiting for the customer;
  - (W2) if the terms require approval (design scopes or proof_required), an approved workshop version exists.
- **budget(order):**
  - included = terms_extra.included_revisions + the number of funded extra_revision children (a child whose offer is accepted counts at once);
  - used = binding changes_requested decisions with counts_revision = 1;
  - notes never count.
- **production_ref(order)** → `{spec, hash}` [P3].
- **twin(order):** the completed order + lock + serial + latest QC + warranty_until (completed_at + warranty_days) + service events. `TwinView` is exported for the store-purchase twin (C1b/C2).
- **feasibility(analysis, verdicts)** → `{verdict: ready | review | adjust, reasons ≤3, workshops ≤200}`.
  - Blocking warnings or no fitting workshop → adjust. Warnings, guessed units or unknown size → review. Otherwise ready.
  - Codes, always said as outcomes: SIZE_TOO_BIG, SIZE_UNKNOWN, THIN_PARTS, TINY_DETAILS, MANY_PIECES, COLOURS_TOO_MANY, MATERIAL_RARE, NO_WORKSHOP_YET, LONG_PRINT, UNITS_ASSUMED.
- **ready_by** = acceptance + completion_days + Σ approved days_delta, counted in Baghdad days.

**Reused verbatim**
- **Requests:** community_requests (with 0151's direct-request triggers), community_print_requests, community_request_files + preview_key, community_request_revisions (version 1 *is* the revision), community_request_comments (the pre-order discussion).
- **Offers:** community_offers with their files, drafts and revisions; the one-live-offer index; 0151's other-store trigger.
- **Orders and money:** community_orders (snapshots, chat_id, started_at/ready_at/delivered_at), community_escrows + events, wallet_holds, feeFor/splitFee, releaseEscrow/refundEscrow/disputeEscrow (escrowOps.ts:540/678/853), completionStatements (communityRequests.ts:272), sweepCommunityAutoComplete (:509), community_order_updates (photos are the proof of production), community_complaints.
- **Chat and notices:** customOrderCard/postSystemCard/announceCustomOrder (chatCards.ts), notifyCustomOrderStarted (customOrderNotify.ts:104), notifyGrouped/stampGroupedCkb, and the grouped `order_update:<orderId>` row.
- **Files and viewer:** file_objects + upload sessions + ownedFileObject; deriveModelPreview (viewerGrants.ts:315); coarsePreviewMesh (requestFilePolicy.ts:126); ModelViewer's ogl code (extracted, not rewritten); qrEncode/qrToSvgPath (qr.ts:412/458).
- **Costing:** merchantWorkshop's engine-B costing (:233), community_request_matches.printer_id, print_quotes.
- **Records:** merchant_services kind 'design' (0036); community_posts (sharing what was made, D3 consent); audit_log.

**Registries** — updated in the same PR as each migration
- ownership.ts: every new table under `marketplace`. schemaVersion.ts: name and count.
- mediaRefs.ts `MEDIA_REFERENCE_SOURCES`: levo_project_files.file_key and .preview_key (text); levo_project_versions.config_json (json — C2's logo and photo keys); levo_service_events.photo_keys (json list).
- mediaRefs.ts `NON_MEDIA_COLUMNS`, each with its reason: levo_project_files.analysis; levo_project_versions.file_ids and .handoff_json; levo_project_pins.anchor; levo_change_orders.items_json; levo_offer_extras.variants_json and .terms_json; levo_handoffs.manifest_json; merchant_qc_templates.items_json; levo_qc_results.template_json and .results_json; levo_evidence_manifests.items_json.
- mediaStorage.ts: **nothing** — the 0160 'community-orders' domain already covers the versions prefix.
- uploadEntity.ts: purpose `order_version` in UPLOAD_PURPOSES, SESSION_PURPOSES and KEY_PURPOSES.
  - Kinds image | model | document; the entity is the order; the uploader is the order's merchant (in W2, also its customer for a change's file).
  - Placement community-orders/<orderId>/versions/<id>.<ext>.
  - It lands in the same PR as POST /orders/:id/versions (row 177 (٦)).

## 4. API

**Routers** — new files, mounted beside Phase 5's routers in worker/index.ts
- `/api/marketplace`:
  - `levoRoom.ts` (W1): the Room read, the project mark, members, invites;
  - `levoVersions.ts` (W1): versions, files, meshes, decisions, withdraw;
  - `levoPins.ts` (W1);
  - `levoChanges.ts`, `levoHandoff.ts` (W2);
  - `levoService.ts` (W3).
- `/api/community`: `levoDesigners.ts` (W2), which mounts `use('*', communityGate())` like every community router.
- `/api/merchant`: merchantWorkshop.ts gains `suggest-offer` (W1); `levoQc.ts` (W3).
- `/api/admin/levo`: `adminLevo.ts` (W3; requireAdmin; audited).
- `/api/levo/pieces/:code` (W3): the public door, outside the wall on purpose.

**One access function** — worker/lib/levo/access.ts, derived on every call, nothing cached
- `projectAccess(db, requestId, user)` → `{projectId, rootId, role, stageRoles}`.
- Roles:
  - **owner** — the root request's customer;
  - **stage_merchant** — the engaged or direct merchant of THAT stage request (isEngagedMerchant/isDirectMerchant, communityRequests.ts:80; a completed job keeps access);
  - **member:viewer | commenter | approver** — an active row, and not blocked either way (blockedEither, userBlocks.ts:7);
  - **eligible** — a board-eligible merchant; reads the owner's pre-order notes only;
  - **null** — everyone else.
- null answers 404 PROJECT_NOT_FOUND everywhere, so the id reveals nothing.
- Staff do not read the Room; they read the audited evidence package [P3].
- A member never receives money, contact snapshots, chat or escrow. The designer never sees the print stage's money or thread, and vice versa.

**Community wall**
- A project with a live or finished order is in-flight trade: its reads and writes sit outside the wall (communityGate.ts:160-170: «a running order is not a new one»).
- Anything that STARTS trade mounts `requireCommunityOpen` route by route: the project mark, accepting an invite, again, handoff, designers, and the Room read of a request still taking offers.
- Changes belong to a running order and stay outside, like acceptance; the gate's comment lists them.
- The page itself stays behind Phase 5's CommunityGate.

**Cache**
- Every Room and project answer is `private, no-store`.
- Two guest-cacheable reads:
  - `GET /api/community/designers` — anonymousCached, params `['cursor','limit']`, 60 s;
  - `GET /api/levo/pieces/:code` — keyed by path, params `[]`, guests only.
- Mesh bytes are private, no-store, and never go through anonymousCached (it buffers text).

**Flag**
- Admin setting `levoProjectConfig {enabled:false, changes:false, credits:false, design_requests:false, piece_door:false, max_members:10, invite_days:7, change_days:7, decrease_cap_percent:50}`.
- Added to SETTING_DEFAULTS with a normaliser in PUT /api/admin/settings/:key; audited; not public. The server's `can{}` carries every switch, so no client reads the setting.
- When off, the Room read answers `{project:null, tabs:[]}` and every write answers 404 PROJECT_NOT_FOUND.

**W1 routes** — all requireAuth; no answer ever carries a file key

1. **`GET /requests/:id/room`**
   - Rate: levo-room 600/h.
   - D1: two waves, ≤ 12 statements. Wave 1: request + family + membership + stage orders joined with escrow state. Wave 2: latest versions joined with approvals, open-note counts, lock inputs, and feasibility facts for a pre-order owner.
   - Answer: `{project{id, kind, origin, role, can{}}|null, stages[], tabs[], moment, lock{version_id, no, production_hash}|null, feasibility|null, counts{versions, notes_open, members}, twin|null}`.
   - A child request's id resolves to its root (`root_id`); the page replaces the URL with the root's Room, focused on that stage.
   - It never writes.
2. **`POST /requests/:id/room/project {kind, origin_kind, origin_ref}`**
   - Owner only, before acceptance; inside the wall; 20/h.
   - Refusals: PROJECT_NOT_ALLOWED, PROJECT_ORIGIN_INVALID.
   - This is also the door C2's studio and P9's `?project=` receiver use to record origins.
3. **Versions**
   - `GET /requests/:id/room/versions` — participants; the 20 newest.
   - **`POST /orders/:id/versions {kind design|change, files[{key}] ≤4, note, final?, handoff?, license?}`**
     - Who: the order's merchant, on a funded or in_progress order. Rate: levo-version 30/h.
     - Keys are checked with ownedFileObject(key, uid, ['order_version']).
     - ONE batch, ≤ 10 statements:
       1. ensureProject;
       2. if the order is funded: the start route's own fenced UPDATE (funded → in_progress WHERE the escrow is held) + recordOrderEventStatement('started') [P3];
       3. INSERT the version WHERE the order is now in_progress;
       4. the file rows.
     - After commit:
       - previews via `waitUntil(deriveModelPreview)`;
       - the grouped order_update notice (meta.sub version);
       - notifyCustomOrderStarted + announceCustomOrder when this batch started the work.
     - Refusals: VERSION_ORDER_CLOSED, VERSION_FILES_INVALID, VERSION_FILE_NOT_OWNED, PROJECT_TEXT_TOO_LONG.
   - `POST /requests/:id/room/versions/:vid/withdraw` — the author, before a binding decision. Refusal: VERSION_DECIDED.
4. **Files: `GET /requests/:id/room/files/:fid/meta` · `/mesh?q=coarse|full` · `/download`**
   - Meshes are served to the signed-in session; no token table.
   - Coarse mesh for viewers, commenters and merchants before acceptance. Full viewer mesh for the owner, approvers and stage merchants. Never an original for members.
   - Download: stage merchants; the owner only once the design order is customer_confirmed or completed.
   - Rate: 600/h; download 60/h.
   - Audit: audit() rows for levo-file reads and member reads, because request_file_reads.access is a closed CHECK (0132).
   - Refusal: VERSION_FILE_LOCKED.
5. **`POST /requests/:id/room/versions/:vid/decision {decision approved|changes_requested, note?, expected_no}`**
   - The owner decides with binding effect; an approver's decision on a version is also binding (see the open questions). 60/h.
   - One read + one batch. The partial unique index refuses a second binding decision.
   - Refusals: VERSION_DECIDED, VERSION_STALE.
6. **Notes (pins)**
   - `GET /requests/:id/room/pins?version=` — participants; board-eligible merchants read the owner's pre-order notes; ≤ 200 per version.
   - `POST /requests/:id/room/pins {version_id, anchor, body, parent_id?, client_id}`
     - Who: owner, stage merchant, commenter, approver (before an order, the owner only).
     - assertDecent; levo-pin 120/h with a 3 s cooldown.
     - The first note on a plain job materialises version 1 from the request revision, copying its hash [P3].
     - Refusals: PIN_ANCHOR_INVALID, PROJECT_TEXT_TOO_LONG.
   - `POST /requests/:id/room/pins/:pid {state resolved|open|removed}` — the author; resolving is also open to the owner and the stage merchant.
7. **Members**
   - `GET /requests/:id/room/members` — owner.
   - `POST /requests/:id/room/invites {role}` — owner; inside the wall; levo-invite 20/h; more than max_members live → INVITE_LIMIT. Answers `{url: '/requests/<root>#invite=<token>'}`, shown once.
   - `POST /room/invites/accept {token}` — signed in; inside the wall; 30/h. Expired, used, revoked, own or blocked → **INVITE_INVALID**.
   - `POST /requests/:id/room/members/:mid {role}|{revoke:true}` — owner. A revoke takes effect on the very next read.
8. **Quote assistant: `POST /api/merchant/workshop/requests/:id/suggest-offer`**
   - Who: requireOfferPrivileges + the communityOffers benefit + a stored eligible verdict. Rate: shares request-costing 30/h.
   - Runs the EXISTING engine-B costing on the verdict's printer.
   - Answers `{draft{price_iqd, completion_days, material_ids, quantity, delivery_method, ready_by}, private{cost_iqd, profit_iqd, margin_percent, basis}}`. Merchant-only; writes nothing, sends nothing [P2].
   - Refusals: COSTING_MATERIAL_REQUIRED (existing), SUGGEST_NOT_POSSIBLE.

**W1 seams** — made by the integrator, one line each
- marketplace.ts `GET /requests/:id` (:294): add `|| isProjectMember(…)`. Members get files with access 'none'.
- marketplace.ts `POST /orders/:id/delivered` (:2547): a pre-check `levoDeliverRefusal()` for the exact code, plus `AND ${LEVO_MAY_DELIVER_SQL}` inside its UPDATE for the race → VERSION_AWAITS_APPROVAL.
- Also: mounts; uploadEntity; mediaRefs; ownership; schemaVersion; notifications (project_invite); settings; refusal strings.

**W2 routes and the money**

1. **Change orders: `POST /orders/:id/changes {items ≤8, note, to_version_id?, price_delta_iqd, days_delta, answers_update_id?}`**
   - Who: the order's merchant, priced. The customer creates only kind extra_revision, priced from the snapshot.
   - Conditions: the order is funded or in_progress and is not itself a child; the changes flag is on.
   - Rate: levo-change 20/h. D1: one read + one batch ≤ 10.
   - Refusals:
     - CHANGE_TOO_LATE; CHANGE_ALREADY_OPEN;
     - CHANGE_PRICE_INVALID — out of bounds, or splitFee(delta) would leave the workshop ≤ 0 (communityFeeMinIqd applies per split);
     - CHANGE_CREDIT_UNAVAILABLE — delta < 0 while credits are off, or beyond decrease_cap_percent [P3];
     - MERCHANT_UNAVAILABLE (existing).
   - **A paid change (delta > 0) is ONE batch:**
     1. ensureProject;
     2. directQuoteStatements, extracted from chatCommerce.ts:299 into worker/lib/directRequests.ts [P2]. It writes:
        - the child request: visibility 'direct', target = the order's merchant, created_by 'merchant', customer = the order's customer, origin_chat_id NULL, title «تعديل: <parent title>», quantity 1, expires after change_days;
        - its pending offer: price = delta, delivery fee 0, completion_days = max(1, days_delta), delivery_method 'pickup' (a change travels with its order, so no address is asked);
     3. recordOfferRevisionStatement('create');
     4. the levo_project_requests row (role change, parent_order_id);
     5. the levo_change_orders row.
   - After commit: `customOrderCard(parent, title, 'change_proposed')` goes into the PARENT's chat, and the grouped order_update notice (meta.sub change).
   - 0151's trigger still refuses an offer from any other store on the child request.
   - **`POST /orders/:id/changes/:cid/approve {expected_price_delta}`**
     - Who: the customer (delta ≤ 0); an approver only for delta 0.
     - One batch: the approval row for to_version; state → approved, fenced on 'proposed'.
     - delta > 0 → 409 CHANGE_NEEDS_PAYMENT `{offer_id, total_iqd, offer_revision}`.
   - **A change is paid through the UNCHANGED `POST /offers/:childOfferId/accept {expected_total_iqd, offer_revision}`**: the 20/h accept limit, the same batch, the same refusals. The child order is born funded, with its own held escrow.
   - `POST /orders/:id/changes/:cid/decline` (customer) · `/withdraw` (merchant): one batch — the change → declined | withdrawn, the child offer → rejected | withdrawn, the child request → cancelled.
2. **The child guard**
   - `loadOrderForParty` (marketplace.ts:2408) and `orderForParty` (communityOrderTimeline.ts:116) answer 404 for a money child (role change or extra_revision).
   - So every party door — GET, start, delivered, confirm, dispute, cancel, updates — is closed to it. Only the follower moves it; nobody can mark it delivered, cancel it alone or review it.
3. **The follower** — worker/lib/levo/followers.ts
   - One step, `levo_followers`, after `community_requests` in jobs.ts:529. Cron every 15 minutes (wrangler.jsonc:231). At most 50 per run. Every step catches up, is idempotent, keyed and fenced on state.
   - **Step 0.** A change is proposed and its child offer is accepted → mark it approved (decided_at = the child order's created_at), post the parent chat card 'change_approved' once, and send the notice.
   - **Step 1.** Child funded, its escrow held, and the parent in in_progress, merchant_marked_delivered, customer_confirmed or completed → move the child to in_progress (the start route's WHERE plus the parent condition) and record the 'started' event.
   - **Step 2.** Child in_progress and the parent in merchant_marked_delivered, customer_confirmed or completed → move the child to merchant_marked_delivered with delivered_at = the parent's and **auto_complete_at NULL**. The auto-complete sweep only selects rows with a non-NULL auto_complete_at, or in customer_confirmed, so a child is never released alone.
   - **Step 3.** Child merchant_marked_delivered and the parent customer_confirmed or completed →
     - `releaseEscrow(child, actor system, key confirm:<childId>, orderStates ['merchant_marked_delivered'], alsoWrite [an abort fence unless the parent is completed])`;
     - the suspension fence still holds (DECISIONS 137), so a suspended workshop waits;
     - then the child completes WITHOUT completionStatements: no completed_orders increment, no reputation.
   - **Step 4.** Parent disputed and the child live → `disputeEscrow(child, system, key dispute:<childId>)` and the child → disputed. The admin decides each escrow with the existing route; the desk lists linked escrows.
   - **Step 5.** Parent cancelled or refunded and the child's escrow held → `refundEscrow(child, full, system, key cancel:<childId>)`, with alsoWrite cancelling the child order and the child request.
   - **Step 6.** A change is still proposed but the parent is no longer funded or in_progress, or the child request has expired → mark it lapsed; withdraw the child offer and cancel the child request, fenced on the offer still being pending.
4. **Hidden everywhere**
   - `LEVO_HIDDEN_ORDER_SQL('o')` and `LEVO_HIDDEN_REQUEST_SQL('r')` (worker/lib/levo/children.ts) are applied at:
     - marketplace `/my-requests` (:781), `/orders` (:2888), `/my-offers` (:1898);
     - printRequests `/print/my-requests` (:2162);
     - merchantWorkspace attention custom_orders (:217);
     - merchant.ts (:2090);
     - merchantReviews eligibility (:152), so no second review;
     - communitySearch trendingStores (:627);
     - communityPosts order links;
     - merchantAnalytics custom-order counts (by the integrator, after community 7 merges).
   - NEW `tests/levoListFilters.test.ts` enumerates every SQL string over community_orders and community_requests in worker/ (about 41 today). Primary-key reads pass; every other reader carries the fragment or a reviewed reason [P3].
   - Community Phase 6 applies the same predicate to its metrics and to its admin-resolve completion bump.
5. **The lock, completed.** `LEVO_MAY_DELIVER_SQL` gains two clauses:
   - «no change waiting for the customer» (a proposed change whose child offer is not accepted) → CHANGE_PENDING;
   - «terms that require approval have an approved workshop version» → VERSION_AWAITS_APPROVAL.
6. **Offer extras** — the marketplace.ts offers seam (one builder owns marketplace.ts for the window)
   - `POST /requests/:id/offers` and `PATCH /offers/:id` take `terms{}` and `variants[]` (≤ 3).
     - A change to either rides the existing revision bump and writes one levo_offer_extras row in the same batch.
     - Scope is inferred on the server, never read from the body.
     - Refusals: OFFER_VARIANTS_INVALID, LICENSE_NOT_ALLOWED.
   - `GET /requests/:id/offers` adds variants, terms (never the royalty internals) and ready_by.
   - `POST /offers/:id/accept` gains `variant` (a key; required when variants exist):
     - total = the variant's price + delivery fee;
     - fences: the existing revision fence, plus EXISTS (the extras in force at that revision carry that key and price);
     - completion_days = the variant's;
     - the snapshot gains `variant` and `terms_extra`;
     - refusals: OFFER_VARIANT_REQUIRED, OFFER_VARIANT_UNKNOWN; OFFER_CHANGED and OFFER_STALE unchanged.
   - chatCommerce `POST/PATCH /:id/quotes` take the same fields.
7. **Revision budget**
   - At the decision route: changes_requested when used ≥ included → REVISION_BUDGET_USED `{included, used, extra_iqd}`.
   - The sheet's one tap «ادفع وأرسل التعديل» chains three calls:
     1. create the customer's extra_revision change (priced from the snapshot);
     2. pay it through the unchanged accept;
     3. re-send the decision — which now passes, because an accepted child counts at once.
   - Workshop versions are never refused for budget reasons.
8. **Design requests**
   - `GET /api/community/designers?cursor&limit`:
     - walled; guests cached for 60 s; community-search 120/min;
     - stores with an active merchant_services kind 'design', accepts_custom_requests, communityDirectoryVisible (community.ts:258) and merchantBlockSql;
     - ≤ 12 per page, each with 3 public post covers.
   - The project mark (kind design, origin design_request) rides the existing chat print-request door.
   - design_make needs no matcher change.
   - On a design_only order, approving a version marked final also moves the order to merchant_marked_delivered in the same batch (the delivered route's fenced UPDATE, auto_complete_at set) [P2]. The customer's next step «استلمت، أرسله للطباعة» calls the existing confirm, then the handoff [P3].
9. **Handoff: `POST /requests/:id/room/handoff {version_id, target board|same_merchant|merchant, merchant_id?}`**
   - Who: owner. Inside the wall. 10/h.
   - Refusals:
     - HANDOFF_NOT_READY — not the approved final version, or the design order is not customer_confirmed/completed (unless the target is the same designer);
     - DESIGNER_UNAVAILABLE; LICENSE_NOT_ALLOWED.
   - Writes the levo_handoffs manifest and a DRAFT child print request (role print, from_version_id).
   - Its files are cloned into the customer's request prefix by `worker/lib/requestClone.ts` — extracted from printRequests.ts /repeat (:1996), behaviour-preserving, previews and analysis included.
   - board → the one publish door; merchant → a direct draft in that store's thread.
   - `GET /requests/:id/room/handoff/:hid` — the owner, and the target merchant once engaged.
10. **suggest-offer** gains one costing per quality level when variants are asked [P3].

**W3 routes**

1. **QC**
   - `GET/POST/PATCH/DELETE /api/merchant/qc-templates` — requireStoreOwner, then requireStoreAccess('production') after P10. Refusal: QC_ITEMS_INVALID.
   - `POST /api/marketplace/orders/:id/qc {template_id?, items[], photo_update_ids[]}` — the order's merchant, while in_progress.
     - passed is computed on the server; production_hash is copied.
     - Photos are ordinary 'photo' updates (0160).
2. **Serials and labels**
   - `POST /orders/:id/serials` — the order's merchant; 20/h; also called lazily at the first QC pass. Runs UPDATE levo_serial_counters … RETURNING, then INSERT OR IGNORE levo_order_serials. At most 500 units (SERIALS_TOO_MANY).
   - `GET /orders/:id/serials/labels.svg` — drawn with qrEncode/qrToSvgPath; served as image/svg+xml with nosniff and a sandbox CSP.
   - The QR encodes `/t/<serial>-<unit>.<tag>`, where tag = the first 10 base32 characters of HMAC-SHA256(secret, serial-unit). Nothing is stored and codes cannot be enumerated [P1].
3. **The piece door: `GET /api/levo/pieces/:code`**
   - Anyone, when piece_door is on. Rate: 60/min per IP.
   - A bad tag answers exactly like an unknown code: PIECE_NOT_FOUND 404.
   - Guests get the cached card `{maker store, month, can_make_another}`. The signed-in owner gets `{room_url}` (private).
4. **Service: `POST /orders/:id/service {kind claim|replace_part|upgrade, part_key?, body, photo_keys?}`**
   - Who: the customer, on a customer_confirmed or completed order. 20/h.
   - The server decides [P3]: inside warranty_days → an open claim to the workshop; outside → a DRAFT direct child request to the same store (role replacement | upgrade, files from the lock).
   - `POST /service/:sid/answer {covered|quoted|declined, note}` (merchant) · `/done` · `/withdraw`.
   - Refusals: CLAIM_NOT_ELIGIBLE, CLAIM_ALREADY_OPEN, WARRANTY_EXPIRED `{suggest:'replacement'}`.
5. **Again from the lock: `POST /orders/:id/again {to same|another, quantity?, color?, material?, note?}`**
   - Who: the customer. Inside the wall. Shares request-repeat 20/h.
   - Seeds a NEW project (origin reorder) from the lock via requestClone.
   - same → a direct draft in that store's thread; another → a board draft.
   - Refusals: AGAIN_NOT_ALLOWED, MERCHANT_UNAVAILABLE.
6. **Timeline**
   - The mergedTimeline seam (communityOrderTimeline.ts:369) adds version, decision, change, QC, serial and service rows, with the actor as a role.
   - Update photos get `?w=320` through the IMAGES binding, falling back to the original [P2].
7. **Evidence**
   - The dispute route (marketplace.ts:2678) gains one line after the response: `waitUntil(writeLevoEvidence(env, complaintId, orderId))` → INSERT OR IGNORE, frozen_by 'dispute' [P3].
   - `GET /api/admin/levo/evidence/:complaintId` — requireAdmin; audit('admin.evidence_read'); 120/h; two waves ≤ 14.
     - Composes the chronological list, including the escrow events of the order AND its children.
     - Flags every row whose hash changed since the freeze.
     - A missing manifest is frozen now, with frozen_by 'first_read', and the screen says so.
   - Message bodies are read only through Phase 6's audited staff door, while the order is disputed.
8. **Change credits** (credits flag)
   - `worker/lib/levo/settle.ts` is called by the confirm route (:2594) and the auto-complete sweep (:509).
   - Σ approved credits = 0 → releaseEscrow, unchanged.
   - Σ > 0 → `refundEscrow({amountIqd: Σ, alsoWrite: [an abort fence while the merchant is suspended]})`. The fence is needed because the partial branch has none of its own (escrowOps.ts:678+).
   - Σ ≤ decrease_cap_percent of gross. One refund deposit per escrow (its id is fixed).

**Refusal codes**
- Each lives in src/lib/refusalStrings.ts in ar, en and ckb. Its emitting file joins the sources list of tests/refusalStrings.test.ts, and every new customer door joins DOORS.
- **W1 (15):** PROJECT_NOT_FOUND, PROJECT_NOT_ALLOWED, PROJECT_ORIGIN_INVALID, PROJECT_TEXT_TOO_LONG, VERSION_ORDER_CLOSED, VERSION_FILES_INVALID, VERSION_FILE_NOT_OWNED, VERSION_FILE_LOCKED, VERSION_STALE, VERSION_DECIDED, VERSION_AWAITS_APPROVAL, PIN_ANCHOR_INVALID, INVITE_INVALID, INVITE_LIMIT, SUGGEST_NOT_POSSIBLE.
- **W2 (13):** CHANGE_TOO_LATE, CHANGE_ALREADY_OPEN, CHANGE_PRICE_INVALID, CHANGE_NEEDS_PAYMENT, CHANGE_PENDING, CHANGE_CREDIT_UNAVAILABLE, REVISION_BUDGET_USED, OFFER_VARIANTS_INVALID, OFFER_VARIANT_REQUIRED, OFFER_VARIANT_UNKNOWN, LICENSE_NOT_ALLOWED, HANDOFF_NOT_READY, DESIGNER_UNAVAILABLE.
- **W3 (7):** QC_ITEMS_INVALID, SERIALS_TOO_MANY, CLAIM_NOT_ELIGIBLE, CLAIM_ALREADY_OPEN, WARRANTY_EXPIRED, AGAIN_NOT_ALLOWED, PIECE_NOT_FOUND.
- None of these exist today.
- Examples (the Sorani is a draft, to be checked against the repo's human Sorani):
  - **VERSION_AWAITS_APPROVAL**
    - ar «التصميم الأخير بانتظار موافقة الزبون؛ لا يُسلَّم الطلب قبلها»
    - en «The latest design is waiting for the customer's approval — the order can't be delivered before it»
    - ckb «دوایین دیزاین چاوەڕێی پەسەندکردنی کڕیارە؛ داواکارییەکە پێش ئەوە ناگەیەنرێت»
  - **CHANGE_NEEDS_PAYMENT**
    - ar «هذا التعديل يغيّر السعر؛ ادفع الفرق لتعتمده»
    - en «This change adds to the price — pay the difference to approve it»
    - ckb «ئەم گۆڕانکارییە نرخەکە زیاد دەکات؛ جیاوازییەکە بدە بۆ ئەوەی پەسەند بکرێت»
  - **REVISION_BUDGET_USED**
    - ar «استُخدمت المراجعات المشمولة؛ المراجعة الإضافية بـ{price}»
    - en «The included revisions are used — an extra one costs {price}»
    - ckb «پێداچوونەوە لەخۆگیراوەکان تەواو بوون؛ پێداچوونەوەیەکی زیادە {price}ی تێدەچێت»
  - **INVITE_INVALID**
    - ar «رابط الدعوة لم يعد صالحًا»
    - en «This invite link is no longer valid»
    - ckb «ئەم بەستەری بانگهێشتە چیتر کار ناکات»

**Notifications**
- One new kind: `project_invite` (entity_type request). Title in ar/en, with Sorani in meta via stampGroupedCkb until P11.
- Every order-bound event rides the existing grouped `order_update:<orderId>` row, with `meta.sub` = version | decision | note | change | qc | serial | service.
- Links: the customer goes to /requests/<root>?room=…; the workshop goes to merchantHref.customOrder.
- No new merchant kind; a claim uses order_needs_action.

## 5. Client

**URL contract** — no route family named «project» (/community/projects already means community_posts, App.tsx:921-924)
- `/requests/:id` — the request tab: Phase 5, landmarks unchanged.
- `/requests/:id?room=design&v=3#pin-lpn_…` — the design tab, V3 on the stage, that note open.
- `/requests/:id?room=piece` — the finished piece.
- `/requests/:id#invite=<token>` — the accept sheet; the fragment is removed at once with replaceState [P2].
- `/t/:code` — the W3 piece door: a lazy PieceDoor page and one App.tsx line, rebased last.
- Members read the page through the one-line GET seam. The page hides offers, chat, escrow and delivery when room.role is a member role.

**Chunks and budgets** — gzip level 9, pinned in tests/bundleBudget.test.ts:77; every new chunk joins the own-chunk list; vendor-webgl stays lazy-only
- **Request** (41,298 B today): ≤ +0.8 KB for the ?room reader, the ⋯ door, the wide-frame flag, three lazy loaders and the #invite handler. **Pinned ≤ 41.2 KB.**
  - RoomFrame and GET /room start in parallel, and only for signed-in viewers. Guests download nothing new.
- **RoomFrame** ≤ 5 KB: the next-step card and its words, the lineage rail, the TabStrip wiring, the RoomMenu, api/useRoom.
- **RoomDesign** ≤ 12 KB: the version list, the approve button, the notes list, the budget line, the change list.
- **The 3D stage:**
  - PinStage ≤ 6 KB;
  - viewer/scene ≤ 5 KB — parseLvm, the shaders and mountViewer extracted from ModelViewer.tsx:209-640, plus project(p) and flyTo(p, {instant});
  - viewer/pick ≤ 1.5 KB — a CPU ray–triangle test over the loaded Float32Array; ogl's Raycast is not imported;
  - ModelViewer drops to ≤ 3 KB, so the total is unchanged, and vendor-webgl stays at 15.6 KB.
- **Sheets**, ≤ 4 KB each, lazy on open:
  - W1: PinSheet, PinsSheet, VersionSheet, InviteSheet, MembersSheet;
  - W2: ChangeSheet, ProposeChangeSheet, DesignerSheet, HandoffSheet, Variants;
  - W3: QcSheet, ClaimSheet, SerialSheet.
- **Others:**
  - RoomPiece ≤ 6 KB in W1, ≤ 8 KB in W3;
  - WorkPanel ≤ 8 KB, lazy inside CustomOrderScreen, which itself grows ≤ 0.4 KB;
  - SuggestionCard ≤ 3 KB;
  - PieceDoor ≤ 3 KB and EvidencePanel ≤ 8 KB (W3).
- **Unchanged and asserted:** entry ≤ 72 KB, initial payload ≤ 200 KB, storefront closure ≤ 47 KB, workspace shell 25 KB / closure 32 KB, Today 18 KB. Nothing is static.
- **CSS +0 B.** The 476 B headroom is kept. Pin positions, the canvas height and the 26rem end column are inline styles.

**Files**
- **W1:**
  - src/components/community/room/{RoomFrame, NextStep, LineageRail, RoomMenu, RoomDesign, ApproveBar, PinStage, PinSheet, PinsSheet, InviteSheet, MembersSheet, RoomPiece, api, useRoom, strings, frameStrings}.ts(x);
  - src/components/viewer/{scene, pick}.ts — shared with track C2: whichever lands first extracts it, and the other extends it with region colours;
  - src/components/merchant/orders/{WorkPanel, VersionSheet, workStrings}.tsx, plus the CustomOrderScreen mount;
  - src/components/merchant/workshop/SuggestionCard.tsx, plus WorkshopRequestCard/CostingSheet (the one-tap «اقترح عرضًا»).
- **W2:** room/{ChangeSheet, ProposeChangeSheet, DesignerSheet, HandoffSheet, Variants}.tsx; community/requests/{OfferComposer, OfferCompare, strings}; chat/commerce/QuoteSheet.tsx; one «كيف تُصنع؟» card in P6's RequestComposer (rebased last).
- **W3:** room/{QcSheet, ClaimSheet, SerialSheet}.tsx; src/pages/PieceDoor.tsx; adminCommunity/EvidencePanel.tsx; community/requests/{OrderTimeline, timelineStrings}.

**Primitives** — none new
- Sheet v2 (detents, dragHandle, header, footer; a centred window from sm up).
- Segmented; TabStrip (fill, link mode, items[].show; one roving tab stop).
- Button and IconButton; Menu; Overlay (the full-screen stage).
- DataList; KpiTile; Skeleton and SkeletonGroup at exact heights; EmptyState, ErrorState, CommunityLoadError.
- StatusChip; Money; NumberInput; QuantityInput; Field; Switch; UploadTile; ConfirmSheet; Toast.

**State**
- The frame reads GET /room once per mount or version bump; useFreshOnReturn refreshes the next step when the tab regains visibility.
- Each tab lazy-loads its own reads.
- Only notes are optimistic (safe to replay by client_id).
- Money is never optimistic: a paid change or an extra revision is the unchanged accept, sending exactly expected_total_iqd and offer_revision.

**i18n** — ar/en/ckb with real Sorani in every new strings file (D6; row 169 assumed YES for the workshop files)
- Files: room/strings.ts (~150 keys: customer | merchant | shared); frameStrings.ts (~40: moments, tabs, stages); orders/workStrings.ts.
- tests/roomUi.test.ts enforces key parity, ckb ≠ ar ≠ en, placeholder parity, Kurdish letters in ≥ 90% of ckb values, and no OWNER marker.
- **NEW tests/customerVocabulary.test.ts** closes gap G1. It walks the customer and shared keys, the moment words and the customer refusal sentences, and forbids: STL, 3MF, OBJ, STEP, mesh, slicer, G-code, infill, nozzle, triangle, manifold, watertight, CAD, and their ar/ckb forms (مجسم شبكي، مثلث، تقطيع، فوهة، نسبة الملء؛ مێش، سلایس، نۆزڵ). Merchant keys may use them.
- **Core words** (ar / en / ckb):
  - tabs: «الطلب · التصميم · القطعة» / «Request · Design · Your piece» / «داواکاری · دیزاین · پارچەکەت»
  - «أضف ملاحظة» / «Add a note» / «تێبینییەک زیاد بکە»
  - «وافق على هذا التصميم» / «Approve this design» / «ئەم دیزاینە پەسەند بکە»
  - «اطلب تعديلًا» / «Ask for changes» / «داوای گۆڕانکاری بکە»
  - «وافق وادفع {price}» / «Approve and pay {price}» / «پەسەندی بکە و {price} بدە»
  - «تُصنع الآن — جاهزة نحو {day}» / «Being made — ready around {day}» / «ئێستا دروست دەکرێت — نزیکەی {day} ئامادە دەبێت»
  - «جاهزة للطباعة · تحتاج مراجعة · تحتاج تعديلًا» / «Ready to print · Needs a check · Needs an adjustment» / «ئامادەیە بۆ چاپ · پێویستی بە پشکنین هەیە · پێویستی بە دەستکاری هەیە»
  - «فُحصت الجودة» / «Quality checked» / «کوالیتییەکەی پشکنرا»
  - «اطلبها مرة أخرى» / «Order it again» / «دووبارە داوای بکەرەوە»
  - «ادعُ شخصًا» / «Invite someone» / «کەسێک بانگهێشت بکە»
  - «الضمان حتى {date}» / «Warranty until {date}» / «گەرەنتی تا {date}»
- Numbers go through localeNumber. Serials, hashes and tokens are LTR islands. Dates use the requests strings' dateLocale.

**Motion** — every spring from useMotion(); m.* from motion/react-m under the page's existing <MotionFeatures> (Request.tsx:507)
- Tab panel enter: `m.spring('ui')` with `m.travel(8)`.
- Note drop: 'quick', scale 0.6 → 1.
- The next-step card swaps with 'ui'.
- Camera fly-to: `scene.flyTo(p, {instant: m.reduced})`; orbit inertia is 0 under reduced motion.
- Sheets use the primitive's own springs.
- Reduced motion collapses everything to CROSS_FADE. No invented durations, no motion proxy in a first-paint closure.

**Accessibility**
- Each note is a `<button>` with a 44 px target (lv-hit), named «ملاحظة ٢: …». The notes list is the canonical alternative to the dots.
- The canvas is role="img" with a one-line summary.
- Keyboard: Tab through notes, arrow keys orbit, Enter opens a note.
- aria-pressed on the toggles; aria-controls on the tab panels.
- Focus moves to the next-step heading after a decision.
- Colour is never the only cue.

**Unit and UI tests**
- **W1:**
  - levoSchema;
  - levoAccess — the role matrix; members never see money, contact or chat; the designer/printer slices; a block → 404; a plain request → project:null; flag off → 404;
  - levoMoment — exhaustive over role × state [P2];
  - levoRoom — two waves, pinned in d1Waves;
  - levoInvites;
  - levoVersions — the first version starts the work; no key in any answer; coarse mesh for members; the owner downloads only after completion;
  - levoLock — delivered is refused while a version waits; plain orders unaffected;
  - levoPins; viewerScene; levoFeasibility;
  - quoteAssistant — never writes, never sends;
  - roomUi; workPanelUi; customerVocabulary.
- **W2:**
  - levoChangeOrders;
  - levoFollowers — start, deliver, release, dispute, refund, lapse; never auto-completes alone; no reputation; a suspended merchant waits; idempotent replays; 404 at every party door;
  - levoListFilters; offerVariants; levoBudget; designRequests; levoHandoff;
  - directQuoteExtraction and requestCloneExtraction — chatQuotes and /repeat unchanged.
- **W3:**
  - levoQc, levoSerials, levoPieceDoor, levoService, levoAgain, levoEvidence;
  - levoCredits — escrow (21) and communityEscrowDecisions (13) unchanged; a suspended merchant is still held.

**Browser bar**
- `scripts/e2e-room.mjs`, driving tests/browser/room.html + room-fixture.tsx.
- Matrix: 360 and 1280 × ar/en/ckb × dark/light × reduced motion on/off = **24 contexts**. This is the full matrix, above today's one-pass ckb convention.
- Fixtures: owner pre-order feasibility; design review V2; a version after approval; a paid change (W2); the piece; the workshop WorkPanel with delivery refused; a member viewer and a member approver; a guest.
- Checks:
  - no horizontal overflow; no page errors;
  - landmarks in the owner's order;
  - ≤ 5 tab stops above the panel for every customer fixture;
  - a WebGL frame drawn (SwiftShader) and a note dropped by a tap;
  - sheets open and close with focus returned;
  - no transform travel under reduced motion; RTL for ar and ckb;
  - members render no escrow, delivery or money figure;
  - a vocabulary scan of the visible text.
- W2 adds e2e-offers.mjs plus the change and design flows. W3 adds e2e-piece.mjs and extends e2e-order-timeline and e2e-admin-panels.
- e2e-request.mjs and e2e-order-timeline.mjs stay green, unchanged.

## 6. Phases, schedule and file ownership

**Schedule**
- Lane A runs the existing programmes; lane B runs Programme C.
- At most two workshops run on the 4-CPU box. Builds and the budget suite go through the integrator only.

- **W1 «الغرفة»**
  - Admitted once community Phase 5 and merchant P4/P5 are committed.
  - **Preferred slot: lane B, wave 1, beside community Phase 6.** The two are file-disjoint:
    - Phase 6 owns adminModeration, reputation, the chats staff door, the community read side, printMatchingScore and adminCommunity;
    - W1 owns new files, Request.tsx, CustomOrderScreen.tsx and the workshop card, plus three integrator seams in marketplace.ts, rebased after Phase 6.
  - The Room goes first because every other track writes into it: personalization (C2 config versions), designs (C3 twin), components (C4 manifests) and production (C6 jobs keyed on production_hash).
  - **Fallback: wave 2 beside merchant P6**, if the owner wants the customizable-product core (C1a) first. W1 touches none of printRequests.ts, chatCommerce.ts, chats.ts or RequestWizard.
- **W2 «المال والعروض»**
  - After W1 and P6 (so RequestComposer, chatCommerce and printRequests have settled).
  - **Preferred slot: lane B, wave 3, beside community 7.** They are disjoint except merchantAnalytics.ts, whose filter is an integrator seam applied after 7 merges.
  - It must precede P9 (wave 6), which retakes printRequests.ts.
  - **Fallback: wave 4 beside P7.**
- **W3 «بعد الصنع»**
  - After W2 and community Phase 6 (the dispute desk and chat_staff_reads).
  - **Preferred slot: lane B, wave 5, beside P8.**
  - It must precede production C6 (wave 8), which keys jobs on QC results, serials and production_hash.
  - **Fallback: wave 7 beside P10**; QC gating then uses requireStoreAccess('production').

**W1 · THE ROOM** — 9 builders + integrator · migration role `levo_room` · ships dark · moves no money
- **B1 schema.** Owns migrations/<next>_levo_room.sql and worker/lib/levo/schema.ts (the TS vocabularies). Tests: tests/levoSchema.test.ts.
- **B2 access, Room read, moment, members.** Owns worker/lib/levo/{access, moment, stage}.ts and worker/routes/levoRoom.ts. Tests: levoAccess, levoMoment, levoRoom, levoInvites.
- **B3 versions, files, previews, decisions, lock.** Owns worker/lib/levo/{versions, files, previews, lock}.ts and worker/routes/levoVersions.ts. Tests: levoVersions, levoLock.
- **B4 notes and viewer.** Owns worker/lib/levo/pins.ts, worker/routes/levoPins.ts, src/components/viewer/{scene, pick}.ts, src/pages/ModelViewer.tsx (becomes a consumer, behaviour identical) and room/{PinStage, PinSheet, PinsSheet}.tsx. Tests: levoPins, viewerScene.
- **B5 feasibility and the quote assistant.** Owns worker/lib/levo/feasibility.ts, the merchantWorkshop.ts suggest-offer route, and merchant/workshop/{SuggestionCard, WorkshopRequestCard, CostingSheet}.tsx. Tests: levoFeasibility, quoteAssistant.
- **B6 the frame.** Owns src/pages/community/Request.tsx (?room, #invite, the wide frame, the lazy loaders, the member view) and room/{RoomFrame, NextStep, LineageRail, RoomMenu, api, useRoom, frameStrings}.ts(x). Tests: roomUi (tab stops; tokens only; useMotion; lazy chunks; REQUEST_SECTIONS unchanged).
- **B7 the design tab.** Owns room/{RoomDesign, ApproveBar, InviteSheet, MembersSheet, strings}.tsx. Tests: roomDesignUi.
- **B8 the workshop side.** Owns merchant/orders/{WorkPanel, VersionSheet, workStrings}.tsx and the CustomOrderScreen mount. Tests: workPanelUi.
- **B9 the minimal piece tab and acceptance.** Owns room/RoomPiece.tsx, tests/browser/room.html + room-fixture.tsx, scripts/e2e-room.mjs and tests/customerVocabulary.test.ts.
- **Integrator:**
  - worker/index.ts mounts;
  - marketplace.ts seams: the members branch in GET /requests/:id; the delivered pre-check and fence;
  - uploadEntity.ts (`order_version`); mediaRefs.ts; ownership.ts; schemaVersion.ts;
  - notifications.ts, src/lib/notifications.ts and NotificationBell (project_invite);
  - settings.ts (levoProjectConfig and its normaliser);
  - refusalStrings.ts and its test's sources/DOORS lists;
  - bundleBudget.test.ts pins;
  - DECISIONS row ≥ 183: «مشروع ليفو: الغرفة هي صفحة الطلب؛ أول نسخة تبدأ العمل والتسليم ينتظر اعتمادها»;
  - the doc section.
  - Then two adversarial reviews (access matrix + lock bypass; vocabulary + privacy) and a fixer.
- **Must stay green untouched:** offersV2 (11), communityAcceptIntegrity (13), escrow (21), communityEscrowDecisions (13), communityRequestLifecycle (16), communityStates (12), orderTimeline (11), requestPageUi (14), requestFiles (18), requestViewerTokens (9), uploadSessions, mediaReferences, bundleBudget (12), e2e-request, e2e-order-timeline.

**W2 · MONEY AND MAKERS** — 9 builders + integrator · migration role `levo_money_offers` · money behind the `changes` and `design_requests` flags
- **M1 change orders and the follower.** Owns the migration, worker/lib/levo/{changes, followers, children}.ts and worker/routes/levoChanges.ts. Tests: levoChangeOrders.
- **M2 the sole owner of marketplace.ts for the window.** Offer extras on write and read, the accept variant seam, the child guard in loadOrderForParty, the list filters there, and the lock completion. Tests: offerVariants; offersV2 and communityAcceptIntegrity unchanged.
- **M3 the store-quote extraction.** Owns worker/lib/directRequests.ts (directQuoteStatements), chatCommerce.ts (adopts it, plus the quotes seam) and chat/commerce/QuoteSheet.tsx. Tests: chatQuotes unchanged.
- **M4 filters outside marketplace + the enumerator.** printRequests /print/my-requests, merchantWorkspace.ts, merchant.ts, merchantReviews.ts, communitySearch.ts, the communityPosts link check, the guard in communityOrderTimeline's orderForParty. Tests: tests/levoListFilters.test.ts.
- **M5 composer and compare.** Owns community/requests/{OfferComposer, OfferCompare, strings} and room/Variants.tsx. Tests: requestPageUi extended (no «best»; a ready-by row).
- **M6 the customer's money screens.** Owns room/{ChangeSheet, ProposeChangeSheet}.tsx and the budget purchase. Tests: roomChangesUi (paid only through expected_total_iqd and offer_revision; the client never sends a price or a diff).
- **M7 design requests.** Owns worker/routes/levoDesigners.ts, worker/lib/levo/{budget, license}.ts, the design-final delivery, room/DesignerSheet.tsx, and one line in P6's RequestComposer (rebased last). Tests: designRequests, levoBudget, levoLicense.
- **M8 handoff.** Owns worker/lib/requestClone.ts (extracted from printRequests /repeat), worker/lib/levo/handoff.ts, worker/routes/levoHandoff.ts and room/HandoffSheet.tsx. Tests: levoHandoff, requestCloneExtraction.
- **M9 an independent money test writer and acceptance.** Owns tests/levoFollowers.test.ts, scripts/e2e-offers.mjs, and the change and design flows in e2e-room.
- **Integrator:**
  - mounts; the `levo_followers` step in jobs.ts;
  - the merchantAnalytics filter, after community 7 merges;
  - adminCommunity.ts complaint detail: a «linked escrows» read;
  - refusal strings; registries; bundle pins;
  - DECISIONS row: «التعديل المدفوع طلب مرتبط يحرّكه الخادم مع أصله».
  - Then a **mandatory money adversarial review** and a fixer.

**W3 · AFTER THE ORDER** — 7 builders + integrator · migration role `levo_after`
- **A1 QC:** worker/routes/levoQc.ts, worker/lib/levo/qc.ts, room/QcSheet.tsx.
- **A2 serials, labels and the piece door:** worker/lib/levo/serials.ts, worker/routes/levoPieces.ts, src/pages/PieceDoor.tsx, room/SerialSheet.tsx, and the App.tsx `/t/:code` line — ONE route for whichever track lands it first.
- **A3 the twin and service:** room/{RoomPiece, ClaimSheet}.tsx, worker/routes/levoService.ts, and again from the lock.
- **A4 evidence:** worker/lib/levo/evidence.ts, worker/routes/adminLevo.ts, adminCommunity/EvidencePanel.tsx, the dispute route's line after the response, and one link in Phase 6's desk.
- **A5 change credits (flagged):** worker/lib/levo/settle.ts plus the confirm and sweep seams. Tests: levoCredits.
- **A6 the timeline:** communityOrderTimeline.ts (the merge and ?w=320) and community/requests/{OrderTimeline, timelineStrings}.
- **A7 acceptance:** scripts/e2e-piece.mjs; e2e-order-timeline and e2e-admin-panels extended.
- **Integrator:** seams, strings, registries, pins; DECISIONS row: «الأدلة تُجمَّد عند فتح النزاع، وباب القطعة لا يقول شيئًا عن صاحبها».

**Every workflow ends the same way**
1. npm run check
2. npm run test:unit
3. node scripts/migrate-check.mjs --twice
4. npm run build + tests/bundleBudget.test.ts
5. the browser scripts
6. the DECISIONS row + the doc section
7. deploy only on the owner's word

**Hand-offs — not built here**
- **Milestone payments (#22, the money track)** bind to the derived milestones: deposit held · design approved (the first binding approval) · production started · delivered · completed. They reuse `levo_project_requests` as the ONE parent/child link, rather than adding community_orders.parent_order_id.
- **Personalization:** C2 writes config versions through W1's exported configVersionStatements and shares viewer/scene. C1b renders the exported TwinView for store purchases.
- **Components (C4)** fill handoff_json.components.
- **Production (C6)** keys jobs on (order_id, production_hash).
- **The network track** adds a 'design' service dimension (design requests on the board) and the roles subcontract and split.
- **Designs (C3)** own remix trees, public templates and the royalty rule written into terms_extra.royalty.
- **The business layer (C8)** owns company catalogs (levo_members scope 'catalog' is ready) and royalty settlement. Recommended mechanism: an admin batch of merchant-ledger adjustment pairs, with no escrow code change.
- **P6's composer** mounts the feasibility line from W1's pure lib.
- **Community Phase 6** applies LEVO_HIDDEN_ORDER_SQL to its metrics and to its admin-resolve completion bump.
- **Community Phase 8** sweeps every levo surface.

## 7. Trade-offs

1. **Project id = root request id, with one lazy family table** — rather than a projects table with its own id and route.
   - Gain: nothing to backfill; every existing link lands in the Room; the request access rules are reused; the «project» slug stays with community_posts.
   - Cost: a project cannot exist without a request.
2. **The Room is Phase 5's page, with tabs only for serious jobs** — rather than a new page, or P2's next-step card on every job.
   - Gain: Phase 5's pinned order and its doors are untouched, and no button appears twice.
   - Cost: a plain job gains only the owner's feasibility line.
3. **The lock gates delivery, and the first version starts the work** — rather than gating start (P2) or enforcing by trigger (P3).
   - Gain: design work is protected from a refunding cancel; money never flows for an unapproved design; plain orders are untouched.
   - Cost: a physical print made before approval cannot be prevented, only left unpaid until approval.
4. **Version files get their own table under the 0160 domain, served to the session** — rather than becoming request-file rows.
   - Gain: no hot request reader needs a filter, and no designer original can leak into the customer's file list or cap.
   - Cost: a small mesh responder, and the full-screen view is the Room's Overlay rather than /model-viewer/:token.
5. **Paid changes are hidden child orders bought through the unchanged accept, followed by the cron** — rather than an escrow top-up, a partial release, triggers, or cascades in five routes.
   - Gain: amounts are written once (0031:141-143) and one escrow stays per order.
   - Cost: a child's money can lag up to 15 minutes; more rows; list filters (guarded by the enumerator test); in a dispute the admin decides each escrow.
6. **The child guard lives in loadOrderForParty (404)** — one line closes every party door, instead of per-route guards.
7. **Reductions become credits applied only at settlement**, behind a flag, capped at 50%, with an external suspension fence. The customer waits until confirmation to see the money back.
8. **Offer extras are a per-revision side table**, read as "in force at or before this revision" — rather than columns on community_offers. There is one extra join, but offer history stays honest and re-confirmations need no write.
9. **One serial per order with derived units and an HMAC tag** — cheap and readable, with no second serial system. Per-unit facts wait for C6.
10. **Evidence is frozen after the dispute commits, in D1** — rather than at first read or in R2. The dispute batch stays unchanged; a failed write falls back to a labelled first-read freeze.
11. **Members see versions, notes and progress, never money.** Approvers bind version decisions but never money; viewers and commenters get the coarse mesh.
12. **No new CSS.** Inline styles for geometry keep the 476 B headroom, at the cost of slightly more verbose components.
13. **One new notification kind.** Everything else rides order_update grouping.
14. **Feasibility is a pure mapping** over existing analyses and verdicts. It is only as good as the analysis, and says «تحتاج مراجعة» when it cannot measure.
15. **Children pay feeFor at their own acceptance**, including the minimum per split — rather than the parent's rate. A server floor refuses deltas that would leave the workshop nothing.
16. **Three workflows, W1 without money.** Value arrives earlier and the money change gets its own focused review, at the cost of W2 extending W1's lock fragment.

## 8. Open questions for the owner

1. Should customers ever see the word «مشروع»? Recommended: no — the Room says «الطلب · التصميم · القطعة».
2. Is it acceptable that each paid change is a linked order released automatically when the customer confirms the main order (one confirmation)?
3. Should change credits (price reductions) be switched on — refunded at confirmation as a partial refund, capped at 50%?
4. Invited approvers: binding on design approvals (proposed), with money always owner-only — or advisory only?
5. Invites: an account always required (recommended); 7-day links; at most 10 people; members cannot invite others?
6. Members' 3D: the coarse preview for viewers and commenters, and the full viewer mesh (never the original) for approvers?
7. Revision budget: what default applies when a design offer states none (proposed 2), and must a design offer always state the extra-revision price?
8. Designer files: may the customer download the approved originals once the design order completes (proposed), or can a designer choose «print with me only»?
9. Warranty: what default applies when an offer states none (0 proposed), and may free warranty repairs run outside escrow?
10. Serial format: LEV-YYYY-NNN (a global yearly sequence, which reveals volume) or a per-store sequence? Should the QR/NFC on the object carry this provenance link?
11. Piece door: a stranger sees only the store, the month, and «اصنع واحدة مثلها» for public or remixable designs — confirm?
12. Evidence: staff-only in v1 (proposed), or does each party also get their own view?
13. Proof of production: photos only (proposed), or short timelapse videos (a data cost in Iraq)?
14. Change commission: feeFor at the change's acceptance, including the minimum fee (proposed), or the parent's rate without a minimum?
15. On a design-only order, should approving the final version move it to delivered automatically (proposed), or should the designer tap delivered?
16. Scheduling: should the Room (W1) take lane B wave 1, ahead of the customizable-product core (C1a) — recommended, because C2, C3, C4 and C6 all write into it?

GRAFTS: ["From P2: one pure 'moment' table (worker/lib/levo/moment.ts). Facts go in; one next step per role and state comes out. It is tested exhaustively and read by the Room's next-step card (placed inside the status landmark, like the existing draft card), by the workshop's WorkPanel and by notification sub-keys, so one moment is never said two ways.","From P2: a lineage rail inside the header, shown only for a two-stage job (design then print). It replaces P1's eight-step StageLine, which duplicated the existing REQUEST_STEPS strip.","From P2: the ⋯ Room menu lives in the TopBar.","From P2: the invite token travels in the URL fragment (/requests/<root>#invite=<token>), so it never reaches a server log or a Referer header. It is dropped from history on arrival.","From P2: one serial per order in the brief's format LEV-2026-091. Unit numbers (-0001…) are derived and never stored, respecting 0098 PART 7. Combined with P1's QR tag: the first 10 base32 characters of an HMAC, nothing stored and nothing enumerable.","From P2: version files are stored under the existing private prefix community-orders/<orderId>/versions/ (the 0160 domain), so no new storage domain is needed.","From P2: a request without a file defaults to scope design_make (one workshop designs and prints, and the customer sees the design before printing). 'Designer first' is the alternative. On a design-only order, approving the final version moves it to delivered, because the file is the delivery.","From P2: the chat-quote statements that create a direct request and offer move from chatCommerce.ts:299 into worker/lib/directRequests.ts, and the /repeat copy moves into worker/lib/requestClone.ts. Both are behaviour-preserving extractions made after P6 frees those files; the change and handoff routes reuse them instead of copying.","From P2: the evidence manifest references the chat as {chat_id, last_message_id, count}, never message bodies.","From P2: the QC sheet opens by itself when the workshop taps «جاهز» and a checklist exists. It is a nudge, not a gate.","From P2: vocabularies that other tracks will extend (project roles, origins, licences, service kinds) are validated in TypeScript rather than by a CHECK constraint, which SQLite cannot widen.","From P2: proof photos in the Room and the piece view are served at 320 px through the IMAGES binding (?w=320), falling back to the original.","From P2: the quote assistant writes nothing and sends nothing. It returns a draft plus merchant-only cost figures, and the existing onUseAsOffer path fills the composer.","From P2: an invited approver may decide only price-neutral changes; money stays with the owner.","From P3: the first version a workshop submits on a funded order starts the work, using the start route's own fenced statements. Design work then cannot be undone by the customer's one-tap refunding cancel.","From P3: the lock gates delivery, not start. The order cannot be marked delivered while its latest workshop version lacks a binding approval, while a change waits for the customer, or while terms that require approval have no approved version. It is enforced as a fenced clause in the delivered route's UPDATE plus a pre-check for the exact refusal code, not as a trigger.","From P3: production_hash, a hash of one canonical production spec (request revision and hash, offer revision and variant, approved version hash, approved changes). It is shown in the workshop's production summary and copied onto QC rows, serial rows, handoffs and evidence.","From P3: tests/levoListFilters.test.ts enumerates every SQL string that reads community_orders or community_requests (about 41 today). Primary-key reads are allowed; every other reader must carry the hidden-child fragment or a reviewed reason. The full filter list covers /my-requests, /orders, /my-offers, the print my-requests list, the attention custom-orders source, merchant.ts, merchantReviews eligibility, trendingStores, post order links and merchant analytics.","From P3: at most one binding decision per version (a partial UNIQUE index), and a workshop may withdraw a version before any decision.","From P3: price reductions, when change credits are switched on, are capped at 50% of the order (decrease_cap_percent).","From P3: a WorkPanel inside the workspace custom-order screen, with a button that follows the order's stage and a production summary. The screen's existing start and deliver buttons remain the only doors for those moves.","From P3: one refusal code, INVITE_INVALID, for an expired, used, revoked, own or blocked invite, so the answer reveals nothing.","From P3: when the customer's own request revision becomes version 1, it copies the revision row's hash, because revision rows are rewritten in place until an offer prices them.","From P3: staff do not read the Room; they use the audited evidence package.","From P3: the evidence manifest is written right after the dispute commits (after the response, INSERT OR IGNORE). P1's freeze-at-first-read survives only as a labelled fallback.","From P3: the assistant extends to one costing per quality level when an offer carries variants."]

REJECTED: ["P3's triggers on community_orders (the delivery and ready locks, the child mirror, parent/child parity, change voiding, ORDER_TERMS_FROZEN). They stay active even while the feature is off, and one malformed snapshot or a bug in the view would block every delivery on the platform. Migration 0134 already rewrote request and contact snapshots for a legitimate privacy redaction that the freeze trigger would have refused. Fenced clauses in the routes plus the enumerator and static tests give the same guarantee.","P3's extraction of the acceptance batch (marketplace.ts:2097-2425) into offerAcceptance.ts. It refactors the most heavily pinned money route with no benefit to users; child orders go through the unchanged accept route instead.","P2's rule that child orders carry the parent's auto-complete date, and P3's mirror trigger that copies it. Neither fails safe: if a parent dispute's cascade fails, the sweep pays the child. Children keep a NULL auto-complete date and follow only the parent's confirmation (P1).","P2's parent/child cascade inside five order routes, plus extra statements in the accept batch. It is too invasive to money routes; one 404 guard in loadOrderForParty plus the fenced cron follower replace it.","P3's new 'work' landmark. It moves REQUEST_SECTIONS and e2e-request's ORDER, which are the owner's pinned order and belong to the community programme, and it pushes the decision below the whole record on a phone.","P2's and P3's storing version files as community_request_files rows with a version_id. Every hot reader (the file list, file_count, the 6-file cap, readRevisionFiles, the /repeat copy, the file policy) would need a filter, or the customer could download a designer's unapproved original. P6 and P9 own those files, and a per-entity files table matches the repo's existing pattern (offer, post and product files).","P2's new columns on community_orders (approval_required, approved_version_id, serial, warranty_days, parent_order_id, variant_key, royalty) and their triggers. GET /orders/:id spreads every order column to both parties, so the royalty JSON would reach the customer. Side tables leave the marketplace tables untouched.","P2's gating of the start route on approval. It leaves design work in 'funded', where the customer can cancel for a full refund. The lock gates delivery instead, and the first version starts the work.","P2's design-stage eligibility (a 'design' need, a NO_DESIGN_SERVICE reason, reach skipped, 'digital' delivery). It changes the pinned 29-code matcher and its client reasons in files that P6 and community Phase 6 touch. design_make needs no matcher change, design_only goes to one chosen designer through the existing chat door, and the network track's capability passport will own a 'design' service later.","P1's per-unit serial table and P3's random public code. The first is a second serial store, against 0098 PART 7; the second abandons the brief's LEV-2026-091-0042 format. The chosen design is one serial per order with derived units and an HMAC tag.","P1's eight-step StageLine. It repeats the existing REQUEST_STEPS strip on the same page; a lineage rail appears only for two-stage jobs.","P1's refusal of workshop versions once the revision budget is spent. It blocks goodwill versions. The budget is spent by the customer's «اطلب تعديلًا» and guarded at that decision.","P1's evidence frozen at the first admin read. Rows can drift between the dispute and the read. The manifest is written right after the dispute commits, with the first-read freeze kept only as a labelled fallback.","P1's follower writes inside GET /room. A GET should have no side effects; the Room computes the effective state of a lagging child and the cron does the writing.","P3's reuse of warranty_claims. The table is owned by the 'devices' service (the Levonis device desk, with its own status words and claim_messages), so a marketplace write there crosses a service boundary. levo_service_events is used instead.","P3's evidence manifest stored in R2 behind a new 'evidence' storage domain. A manifest of ids and hashes fits comfortably in a D1 row.","P3's levo_member_reads table. Member reads are recorded with audit() instead of adding a table.","P3's physical test-piece proof step and the 'sees price' switch on invites. Both add controls the brief never asked for; members never see money in v1.","P2 shipping its first workflow switched on. Every Programme C capability ships dark behind levoProjectConfig and is deployed only on the owner's word.","P1's remixes read (/api/community/remixes) and its catalog and royalty tables inside this track. Remix trees belong to the designs track (C3); company catalogs (#38) and royalty settlement belong to the business layer (C8). Levo only reserves terms_extra.royalty and levo_members scope 'catalog'.","P2's folding of Phase 5 sections by moment. It changes Phase 5's own page behaviour (the e2e-request landmarks) and is offered to community Phase 8's sweep instead.","P1's change credits and the full follower inside the first workflow. All money moves to W2, with a dedicated money adversarial review, and credits move to W3 behind a flag.","P3's charging child orders the parent's commission rate with no minimum. It would need a separate accept path; children pay feeFor at their own acceptance like any order, and a server floor refuses deltas that would leave the workshop nothing.","P1's and P3's separate container table (levo_projects, and P3's 'lvp_' id). It is merged into one levo_project_requests row per request, P2's lineage shape, with the root row created lazily.","P1's community_order_updates.stage column. The production track (C6) owns the vocabulary of production stages; proof photos already ride the timeline, and no existing table gains a column."]

### Judge's scores — levo-project

Scored 1–5 per criterion against the tree as it stood at about 12:30Z on 2026-09-30. I rebuilt dist at 11:54: CSS is 60,964 of 61,440 B, the Request chunk is 41,298 B, vendor-webgl is 15,629 B, migrations end at 0161 and DECISIONS ends at row 182.

| Criterion | P1 — container-first | P2 — journey-first | P3 — systems-first |
|---|---|---|---|
| Simplicity for the customer (five-control rule) | **4** — The first viewport holds back, next step, tabs, ⋯ and the stage. The frame only appears for serious jobs, so a plain STL page is untouched. Weakness: its eight-step StageLine repeats the existing REQUEST_STEPS strip, and the versions tab is dense. | **5** — One server-decided «moment» with at most two actions sits in the status landmark, where the draft card already lives. Versions and members open in sheets and 3D notes use the existing full-screen viewer. The proposal proves the rule by counting focusable controls in the first viewport. | **4** — Five controls and "automation instead of controls" are good. But the decision section is a new 'work' landmark placed after 'accepted', so a phone user scrolls past the whole record to act, and the owner's pinned section order moves. |
| Power for the merchant | **4** — Real depth: version uploads with handoff notes, priced changes with a diff the server computes, a one-tap quote draft, QC templates and serial labels. These are scattered as sheets rather than one work surface. | **4** — The same moment table drives the workshop order screen. It adds a QC nudge, printable labels and a suggestion card with cost and margin. There is no single work panel and no production summary. | **5** — The richest merchant surface: a WorkPanel whose main button changes with the order's stage, a production summary carrying production_hash, per-quality offer drafts, and a test that enumerates every order and request reader. |
| Reuse of what exists | **3** — Reuses accept, escrow, chat, notifications, uploads and the viewer as they are. But it adds about 19 tables, including a second container table, a per-unit serial table next to 0098's device chain, and a remixes read that belongs to the designs track. | **4** — Extracts rather than copies the store-quote statements and the /repeat copy, and one lineage table covers every stage. Downsides: version files as request-file rows force hot readers to filter, and it adds 7 columns to community_orders, 5 to community_offers and 2 to community_complaints. | **4** — Reuses request files, the one-open-proposal pattern from 0140 and a single acceptance core. But reusing warranty_claims writes into a table owned by the devices service, and it adds an R2 evidence domain and a member-read table. |
| Budgets (bytes, CSS, D1 waves) | **5** — Zero new utility classes, each checked in dist. Request grows by 0.6 KB. Every surface is its own lazy chunk (frame ≤4 KB, versions ≤12, stage ≤6+5+1.5). The Room read is two D1 waves and every batch is bounded. | **4** — No new CSS, verified classes, lazy sheets. Request grows 1.6 KB (a new 42.5 KB pin) and ModelViewer grows to 8 KB. | **4** — No new CSS and two-wave reads. The work section grows to 14.5 KB and the Request pin moves. |
| Security and money soundness | **5** — No trigger on any money or state table and the accept batch is untouched in the first workflow. Children never auto-release (their auto-complete date stays NULL). Credits get their own suspension fence and royalties only accrue. Gaps I close below: a child funded just before its parent is delivered never catches up, children stay callable through the order routes, and evidence freezes at first read. | **3** — Putting the invite token in the URL fragment is a real gain. Against it: the parent/child cascade edits five order routes and the accept batch; children copy the parent's auto-complete date, so a failed dispute cascade lets the sweep pay the child; royalties run inside releaseEscrow; a royalty column would reach the customer through GET /orders/:id, which spreads every order column; sequential serials can be enumerated. | **3** — Sharp invariants (one decision per subject, production_hash, a delivery lock, a cap on reductions). But they live in triggers on community_orders that stay active while the feature is off. Its terms-freeze trigger would have blocked 0134's legitimate snapshot redaction. A mirror trigger copies the auto-complete date to child orders. Its money workflow refactors the whole acceptance batch. |
| Mobile-first | **4** — Drawn at 360 first: sheets, 44 px pins, the approve button in the page flow rather than fixed. An inline WebGL stage in the phone's versions tab is heavier than a sheet. | **5** — Every screen starts at 360 with the fold marked at 740 px, one moment and at most two buttons. At 1280 it adds a sticky side column using existing utilities plus one inline width. | **4** — Sound 360 and 1280 layouts, but the decision buttons sit low on the phone page. |
| Feasibility on Workers/D1/ogl | **5** — Picks points on the CPU over the loaded LVM1 array without importing ogl's Raycast. Serves meshes to the signed-in session instead of adding a third viewer-token system. Derives previews after the response and follows children with a bounded cron job. | **4** — Feasible throughout. The start-route batch gains a serial-counter write and the Room read is one wide SELECT of scalar subqueries. | **3** — A lock VIEW read by BEFORE UPDATE triggers that parse offer_snapshot JSON on every order state change works on D1 but is fragile. The acceptance extraction and the R2 manifest add moving parts. |
| Schedule fit with the running programmes | **4** — The Room needs only Phase 5 committed. Keeping version files in its own table means it never touches printRequests.ts or chatCommerce.ts, which P6 and P9 own. But its second workflow sits in wave 6 beside P9 while needing P9's /repeat copy logic. | **3** — Wave 1 beside community Phase 6 depends on how Phase 6 lands its restricted-user refusals. Its hot-seam builder edits printRequests.ts, requestFilePolicy.ts and requestRevisions.ts. Its money workflow changes the pinned 29-code eligibility vocabulary. | **3** — The first workflow beside Phase 6 is plausible. But its money workflow edits marketplace.ts, communityRequests.ts, adminCommunity.ts, printRequests.ts and merchantAnalytics.ts together, and moving REQUEST_SECTIONS and e2e-request's ORDER takes pins the community programme owns. |
| **Total** | **34/40** | **32/40** | **30/40** |

---

## Track — manufacturing (judged synthesis; the judge chose Proposal 1 (operator-first) as the spine)

# Manufacturing — «الإنتاج · Production · بەرهەمهێنان»

*Merged design. The spine is Proposal 1 («the Floor», operator-first). Grafted from Proposal 2: derived commitments and derived lanes, «Needs you» only with a reason, serials in the brief's own format, the 17 service words, and the network's money and privacy rules.*

*Figures were re-measured on `dist/` built 2026-09-30 11:54, which is newer than every source file:*

| Budget | Now | Limit |
|---|---|---|
| CSS (all stylesheets) | 60,964 B | 61,440 B (476 B headroom) |
| Entry | 66.3 KB | 72 KB |
| Initial payload | 183.0 KB | 200 KB |
| Storefront closure | 46.6 KB | 47 KB |
| Workspace shell (own / closure) | 15.2 / 25.3 KB | 25 / 32 KB |
| Today — CommandCenter own chunk (the pinned figure) | 15.3 KB | 18 KB |
| OrderDetailScreen | 7.2 KB | 12 KB |

## 1. Concept

In one sentence: every paid job becomes a card by itself, the server plans it, one board moves it, and the floor never touches money or what the customer sees — while what it learns makes matching, offers and estimates truer without adding a single customer control.

**Intake never touches a money route.** Two additive AFTER INSERT triggers write a key row into `production_jobs` inside the transaction that commits the money:
- the accept batch's `INSERT INTO community_orders … 'funded'` (the only insert, `worker/routes/marketplace.ts:2294`);
- the store checkout's `INSERT INTO order_items` (`worker/routes/storeOrders.ts:1001`), for made-to-order lines.

Deterministic ids and `INSERT OR IGNORE` make both idempotent. Every JSON read is guarded by `json_valid`, and the columns the triggers write carry **no foreign-key clause**. OR IGNORE covers NOT NULL, CHECK and UNIQUE violations; FK errors are the one violation it does not cover, so there are none — the trigger provably cannot abort the money batch. A */15 sweep materialises anything a trigger skipped and backfills orders older than the migration. Because migrations apply before code, intake is also correct in the deploy window.

**The server plans; automation replaces controls.** A TypeScript planner:
- freezes the job's facts from the best source available: the merchant's own costing quote, then the request estimate, the product recipe, the product attributes, and finally manual entry;
- writes the job's filament lines;
- suggests a printer with reasons, using the matcher's own `printerCannot` and `resolvePrinter`;
- evaluates the store's rules;
- then either queues the job with the suggested printer assigned (the default) or places it in **Needs you**.

A job goes to Needs you only when the server has a reason: a rule says review, approval pending, material short, due date impossible, no printer can make it, no estimate, version changed since planning, or store order not confirmed.

**One board, one tap.** Lanes: Needs you · Queue · Printing · After print · Ready (Done is history). Each card has one primary verb: its natural next step.

**The floor never moves money or anything the customer sees.** «Start work», «Ready», «Delivered», shipping and every payment stay the existing order doors. The board calls them after a confirmation and never re-implements them. A structural test forbids production code from writing `community_orders`, `orders`, `order_items`, `community_order_updates`, escrow, wallet or ledger rows. When an order moves ahead through its own door, **the order wins**: a job's lane is derived at read time from the job's stage and the order's state. So no trigger follows an order's state, and nothing ever has to be released.

**What flows back:**
- Open jobs' frozen filament lines are the shelf's commitments. They are derived and keyed on the shelf's natural key, so the replace-all shelf PUT orphans nothing. The matcher subtracts them for workshops that actually run the floor.
- Queue minutes divided by stated machine hours become honest words — available today / earliest slot tomorrow / busy until Thursday. They feed the ranking, the offer composer and, only if the merchant opts in, the store page.
- Shortages surface with ranked alternatives before a customer is disappointed.
- The capability passport (derived facts plus stated answers — services, machine hours, the store-page switch) sharpens matching and partner routing.
- Serials (LEV-2026-091; units LEV-2026-091-0042, derived) print on travelers and labels.
- Print times and failures the merchant confirms finally feed the dormant 0078 loop: `print_actuals`/`print_failures` → `printer_calibration_stats`, at merchant scope, behind engine B's 8-sample gate.

**Help from a workshop is a direct request.** «Get help from a workshop» turns part or all of a job into an ordinary 0151 direct request from the owner's user to a partner:
- the partner quotes in the existing store thread;
- the owner accepts through the existing accept door, and escrow is held from the owner's Levo Wallet;
- disputes are ordinary custom-order disputes;
- no new money code is written.

The database keeps the network's promises: one winner per compete group, quantity conserved, depth 1, the child is always a direct request, and the partner never learns who the customer is.

**The customer** sees only three new things: an opt-in «can start tomorrow», up to six service words on the store page, and truer ready dates in offers. Never a stage, printer, partner, batch, serial, or CAD/slicer/mesh word.

## 2. Screens

**Where it lives.** One new section, `production`, in the Workshop group: **Production** · Printers · Costing · Requests.
- Icon: lucide `Factory`. Badge: needs you + late; absent when there is nothing, never 0.
- Addresses: `/merchant/production`, and `/merchant/production/<jobId>` (the job sheet open over the board).
- Closed query words: `view=board|printers|list` and `lane=needs|making|ready|done`.
- Phone: lights the Orders tab and sits in «More»; Today is the daily way in.
- Registered through P10's Capability machinery (`production`) and hidden while `productionConfig.floor` is off.
- No other new nav item: the passport lives on Printers; partner work lives in the job sheet and the existing threads.

**Layout facts.**
- The content column at 1280 is 960 px (`MerchantShell.tsx:309`: `max-w-6xl lg:px-8`; sidebar `lg:w-64` at `:460`). Lanes are therefore `w-56` (224 px): the four standing lanes take 932 px and fit beside the open sidebar. After print appears only when a job needs it; the lane strip then scrolls with snap. At 360 the content is 328 px.
- Every class used is already in the built sheet (verified): `w-56 w-64 snap-x snap-mandatory snap-start overflow-x-auto shrink-0 hide-scrollbar lv-card lv-surface lv-section lv-choice lv-swatch lv-alert-info lv-alert-warning bg-warning/10 bg-danger/10 text-warning h-1.5 rounded-full bg-gold size-10 size-12 object-cover divide-y divide-border-subtle min-h-[44px] tabular-nums text-[12.5px] text-[13px] line-clamp-2 border-dashed ring-2 ring-gold lg:flex lg:items-start lg:gap-6 print:hidden`.
- Absent, therefore never used: `lg:w-72 lg:col-span-2 lg:min-w-0 print:block cursor-grab xl:grid`.
- Data colours and progress widths go inline (the `PrintersTab.tsx:856` swatch precedent). **CSS delta: 0 B.**
- Drawings are LTR; ar/ckb mirror through logical utilities only.

### S1 · Board — 360 (view=board; the default lane is the first non-empty one)
```
+- 360 -----------------------------------------+
| Production                   [Rules] [Print]  | h1 · IconButtons (Rules: lead/owner)
| Earliest start tomorrow · 42 made · 95% on time| ONE statement line, 12.5px, muted
| +- lv-alert-warning -------------------------+ | only while a shortfall exists
| | PLA Black short 320 g · 3 jobs     [Fix]   | | → ShortageSheet
| +--------------------------------------------+ |
| Suggested: 8 jobs → 2 batches · ~45 min saved >| lv-alert-info button → BatchSheet; absent when none
| [Needs you 2][Making 7][Ready 2][Done]         | Segmented md (44 px), badge counts
| < P1● printing→14:20   P2○ free   P3⊘ >       | printer chips, overflow-x-auto snap-x → PrinterSheet
| +- lv-card ----------------------------------+ |
| | ▣ Controller stand ×2            ! Late    | | size-12 thumb · StatusChip
| | Ali · Custom · LEV-2026-091 · due Tue      | | first name only; serial once minted
| | ● PLA Black 184 g   ● Red 22 g             | | swatch (inline bg) + grams
| | Why here: short 40 g Black                 | | the server's first reason
| | [ Fix shortage ]                     [...] | | ONE primary + Menu
| +--------------------------------------------+ |
| (an empty lane → EmptyState, border-dashed)    |
+------------------------------------------------+
```
- Phone lanes: **Needs you** (review, waiting); **Making** (approved/Unassigned, queue, printing, after print); **Ready**; **Done** (delivered in the last 7 days).
- Card menu: Move to… · Hold (closed list of reasons) · Split… · Print traveler · Get help from a workshop (M-C).
- Primary verbs: Confirm order (pending store line) · Fix shortage · Assign P2 ✓ · Start printing · Printed › · QC ✓ · Tell customer · Ship.

### S2 · Board — 1280
```
| Production   [Board|Printers|List]   [Batches 2] [Rules] [Travelers]                  |
| Earliest start tomorrow · 3 printers · 14 h queued · this week 42 made · 3 failed prints |
| P1 X1C ● Stand ×2 62% · free 14:20 · PLA Black | P2 A1 ○ free | P3 ⊘ off    <- strip   |
| +Needs you 2--+ +Queue 5--------+ +Printing 3---+ +Ready 4---------+   >              |
| | card        | | P1 >1 Keys ×40| | P1 Stand ×2  | | #ORD-221 [Ship]|  <section> w-56  |
| | card !-40 g | | P2 >1 Tag ×12 | | ▓▓▓▓▓░ 62%   | | #CO-7A1 [Tell] |  shrink-0         |
| |             | | Unassigned 1  | |              | |                |  snap-start       |
| +-------------+ +---------------+ +--------------+ +----------------+                   |
| Delivered this week: 9 >                                                                |
```
- After print (sub-groups Assembly · Finishing · QC) joins as a fifth lane only while some job needs it.
- The lane strip is `flex gap-3 overflow-x-auto snap-x`, with `tabindex=0` and an aria-label.
- No drag-and-drop in v1: there are no cursor classes, and «Move to…» is the complete, accessible path.

**Moving a card:**
- The card animates out (`m.spring('move')`; under reduced motion `CROSS_FADE`, travel 0).
- A polite live region says «Controller stand ×2 → Printing».
- Focus goes to the next card in the lane, else to the lane heading (row 177 (11)).

**States:**
- Loading shows `ListRowsSkeleton`.
- Failure shows `ErrorState` with retry; a failed refresh keeps the last cards and says so.
- `EmptyState` appears only on a successful empty answer: «Nothing to make — new paid orders appear here by themselves».
- With no printer: «Add your first printer to plan production» → Printers.

### S3 · Printers view (view=printers)
- **1280:** one `lv-surface` row per printer, showing name · model · availability · loaded colours (derived from the last job that started there) · queue minutes · free-from time, then its queue as `w-56` cards with ↑/↓ IconButtons.
- An **Unassigned** row lists jobs no printer can take, with the `printerCannot` reasons in merchant words («bigger than P2 and P3 — get help from a workshop»).
- **360:** stacked printer cards open the **PrinterSheet** (Sheet v2, detents medium/large):
  - availability Segmented Available | Busy | Offline (narrow PATCH);
  - site label, shown only when at least 2 sites exist;
  - the queue with ↑/↓;
  - «Offline — move its 3 jobs back to suggestions?» (useConfirm).

### S4 · List view (view=list)
- `DataList`: a table at or above `wideAt`, cards below, with selection. Columns: Job · Order · Due · Stage · Printer · Material.
- Bulk actions: Move to… and Assign to…, up to 50. Each is the single move repeated and answers `{done[], refused[{id,code}]}`; refused rows keep their checkbox and reason (DECISIONS 176).
- For store lines, «Mark shipped» calls the existing bulk-status door.

### S5 · Job sheet (Sheet v2 — detents ['medium','large'], dragHandle, header, footer; a centred window from sm)
```
+ == --------------------------------------------+
| Controller stand ×2 · LEV-2026-091           x | header
| ● Printing on P1 · 62% · 1 day late            | StatusChip + h-1.5 bar (inline width, m.spring('ui'))
| Ali · Custom order   [Open order >]            | → /merchant/requests/orders/<id> or /orders/<id>
+------------------------------------------------+
| Make                                           | lv-section
| 120×80×95 mm · ~3 h 20 · 2 plates              | «~» when estimated; «time unknown [Add]» when absent
| Name «ALI» · Body Black · Accent Red           | personalization words, when the order line has a configuration
| ● PLA Black 184 g ✓   ● PLA Red 22 g  short 10 g [Fix] |
| Parts: Magnet 10×3 ×2 (from your stock)        | BOM lines only; parts the customer bought were already sold
| Printer P1 — fits · black loaded · earliest [Change] | reasons; an impossible printer asks «Assign anyway?»
| Needs [Assembly ✓][Finishing][QC ✓]            | lv-choice toggles (aria-pressed)
| Done 0 / 2 · passed —                          | counts, for big jobs
| > Files & notes (2)     > History              | Disclosure; «3D view» → mainHref('/model-viewer/<token>')
+------------------------------------------------+
| [ Printed > Assembly ]                   [...] | primary = next stage; Menu: Print failed…, Move to…, Hold,
+------------------------------------------------+   Split…, Get help (M-C), Traveler, Labels, Internal note
```
- **Starting a still-funded custom order.** Moving it to Printing first asks, through useConfirm, «Start this order? The customer is told work has begun». It then calls the existing `POST /api/marketplace/orders/:id/start`, then the move.
- **Moving to Ready.** useConfirm «Tell the customer it's ready?», then the existing `POST /api/marketplace/orders/:id/updates {kind:'ready'}`.
- If the first call fails, the second is never made. A half-step (the order moved, the job move refused) is harmless, because the lane follows the order.
- **«Printed»** asks nothing by default. An optional disclosure, «Record actual time and grams — makes your estimates truer», is prefilled from the timestamps and the estimate; only a saved disclosure writes `print_actuals`.
- **«Print failed…»** opens a small sheet: cause chips (0078's list: adhesion · spaghetti · clog · support · layer shift · filament · power · operator · unknown), Segmented Early | Middle | Late (15 / 50 / 85 %) and optional wasted grams (debited from the shelf). The job returns to Queue for a reprint.
- Photos for the customer go through the existing timeline photo door (purpose `order_update`), never a new upload purpose.

### S6 · Shortage sheet (Sheet v2 medium)
```
| Short: PLA Black — need 184 g, free 144 g                     |
| (o) Use «Charcoal» — very close · 900 g free   [Ask customer] | ≤ 3, ranked by Lab distance (shared colour lib)
| ( ) Material arrives [Thu v] → ready Sat       [Tell customer]| restock_on + a prefilled trilingual sentence
| ( ) Record arrival  + [1000] g                                | single natural-key upsert, never the replace-all PUT
| ( ) A workshop that has it (M-C)               [Find]         |
| ( ) Keep waiting                                              |
| [Done]                                                        |
```
- Customer messages go through existing doors only: a custom order gets a timeline `note`; a store order gets its conversation.
- A colour change is applied only after «Customer agreed», which is recorded in the job's history.
- Priced changes wait for the Project track's Change Orders.

### S7 · Batch sheet (Sheet v2 medium → large)
- One `lv-card` per suggestion: printer · material · plates · time · done by, with a checkbox per job (untick to drop it), then [Accept batch] [Ignore].
- Savings are shown only from measured minutes and grams; otherwise the card says «6 fewer setups».
- One quiet line: «Never delays a job past its due date».
- Orders are never merged: each job keeps its own order, stage, serial and QC.
- An ignored set is never offered again.

### S8 · Rules sheet (owner/lead)
- A list of up to 20 rules, each with a Switch and a Menu (edit · up · down · delete).
- A learned suggestion: «You put PLA Black on P2 9 times [Make it a rule]».
- A fixed footnote: «Rules suggest, tag or hold — they never accept, refund, pay, start or ship.»
- The editor is a sentence: «When [Material v][PLA v]» «then [Suggest printer v][P2 v]», with Selects over closed vocabularies only.

### S9 · Split sheet
```
| Split «Keys ×500»                                  |
| P1 (Karrada)   [200]  done Wed                     | NumberInput per row, prefilled by free capacity
| P2 (Karrada)   [150]  done Wed                     | grouped by site only when ≥ 2 sites
| Workshop …     [150]  [Choose…]   (M-C)            |
| Remaining 0 ✓ · finishes Wed instead of Sat        | live; the server refuses over-allocation
| [Split]                                            |
```
- The parts appear as normal cards with a «part 1/3 · 200» chip; the parent becomes their group header.

### S10 · Passport card (top of Printers; its own lazy chunk)
```
360                                              1280 (lg:flex lg:items-start lg:gap-6)
| Your workshop                          [Edit] | | Your workshop                    | Also offers   [+]          |
| FDM · up to 350×320×325 mm · 4 colours at once| | FDM · 350×320×325 · 4 colours    | Assembly · Painting · LED  |
| PLA · PETG · TPU — 14 colours on the shelf    | | PLA PETG TPU · 14 colours        | 16 h/day · next start today|
| Also: Assembly · Painting · LED fitting  [+]  | | Missed this month: 4 too big · 3 need a hardened nozzle       |
| Runs 16 h a day · 3 printers · next: today    |
| Missed this month: 4 too big · 3 hardened nozzle | from community_request_matches reasons (30 d): tells the owner what to buy
```
**Edit** opens the ServicesSheet:
- 17 service chips (`lv-choice`).
- «How many hours a day do your printers run?» — Segmented 8 | 12 | 16 | 24. Asked once; until it is answered, no capacity word appears anywhere.
- Switch «Show my next free day on my store page», off by default.
- From M-C: Switch «Take work from other workshops», plus a minimum job and «at most N at once».

### S11 · Partner finder (M-C; Sheet v2 large)
```
| Get help from a workshop                                        x |
| Quantity [150]   Due [Wed 1 Oct]   Also needs [ ]Paint [x]Assembly| due prefilled: parent due − buffer
| ★ Noor Workshop · Baghdad                    [ ]                  | trusted first
|   ✓ PLA Black · ✓ 4 colours · ✓ fits · ✓ assembly · available today · 12 partner jobs, all on time |
| Rafidain Workshop · Baghdad · earliest tomorrow  [ ]              | booleans and words only
| Zagros Workshop · Erbil · «you collect from Erbil» [ ]            |
| (none: «No workshop can right now — try fewer pieces or a later date») |
| Note to the workshop (optional)                                   |
| They receive the spec, files and checks — never your customer's name, address or price. |
| [ Send to 2 workshops > ]  «the first quote you accept takes the work; the others close» |
```
- A due date later than the customer's own turns the button into «Send anyway», after a confirm (`late_ack`).
- **In the job sheet**, each ask shows its derived state and its quote. [Accept] opens useConfirm «180,000 IQD goes from your wallet into escrow and is released when you confirm receipt · this job leaves you ≈ 62,000», then calls the existing `POST /api/marketplace/offers/:id/accept`.
- **The partner (B)** sees the ask as a direct-request card in the A↔B store thread and quotes with the existing QuoteSheet. B's order becomes B's own job through B's own trigger, with a chip «Partner work · <A's store>».

### S12 · Packages card (M-C; top of Services, lazy)
- Presets: Print only · Print + Assembly · Premium finish · Prototype · Full build, plus custom.
- Each sets its included services, extra days and an uplift (% or IQD).
- At most 8, edited in a Sheet v2.

### S13 · Printed sheets (server-rendered HTML: 0 SPA bytes, 0 CSS)
- **Job traveler, A6:** title, quantity, due, printer, swatches with grams, needs, notes, serial, and a QR to the job's workspace address. No price, no contact.
- **Unit labels, 50 × 30 mm:** the serial (LEV-2026-091-0042), a short title and a QR of the serial.
- They follow the `receipts.ts` `renderLabelSheet` pattern: a `.noprint` banner says what the sheet is NOT showing, and pages hold at most 50.
- They get their own small ar/en/ckb document wrapper, because `receipts.ts`'s `doc()` is private and ar/en only.

### S14 · Today, badge, chips, composer hint
- **Today** (the CommandCenter queue): ONE ticket, «Production: 3 need you (1 late) ›». Tone is warning when something is late; up to 2 first rows sit under it with the action on the row (the attention pattern). M-C adds one more ticket: «2 partner quotes wait · a workshop waits for your quote».
- When production is on, the existing custom-orders «to start» ticket opens the board instead: the same count, a better door.
- **Order screens:** a StatusChip link, «In production · Printing on P1 ›», in `OrderDetailScreen` and in `CustomOrderScreen`.
- **Offer composer** (`community/requests/OfferComposer.tsx`, merchant side): «Your earliest start: tomorrow on P2 — ready in ~3 days [Use]», which fills `completion_days`. Nothing appears when capacity is unknown.

**Customer-visible words — the only ones:**
- The store page's workshop block: up to six service words and, if the merchant opted in, «Earliest start: tomorrow». They are drawn by `blocks/extra.tsx` `WorkshopFacts` and `blocks/Stats.tsx` `workshopWords`, which ride the lazy `extra` chunk — 0 static bytes against the 46.6 / 47 KB storefront closure.
- Ready dates in offers, which the merchant fills from the slot hint.
- Service words are customer phrasings (file_repair = «تجهيز ملفك للطباعة», never «repair mesh») and are added to a customer-vocabulary walk test.

## 3. Data model by role

**Rules for all three migrations:**
- Each is additive, named by role, and takes the next free number at merge (≥ 0162 today). `EXPECTED_MIGRATION` and the count move in the same commit.
- Every new table is owned by `marketplace` in `packages/contracts/src/ownership.ts`, beside `print_actuals`.
- Every `'[]'`/`'{}'` column is classified NON_MEDIA in `worker/lib/mediaRefs.ts`; none holds an object key.
- No CHECK on an existing table is widened, and no table is rebuilt.
- Lists that may grow (stages, sources, hold reasons, event kinds, modes) are closed in TypeScript (`packages/contracts/src/production.ts`), not by CHECK — the lesson of the frozen enumerations. CHECK is used only for flags, ranges and exactly-one links.

### A) `production_floor` (M-A)

**production_jobs** — one row per unit of work.

| Column(s) | Definition |
|---|---|
| `id` | TEXT PK, deterministic: `'pjc_'‖community_order_id` · `'pjl_'‖order_item_id` · `'pjs_'‖parent‖'_'‖n` (split child) · `'pjm_'‖newId` (stock/free) |
| `merchant_id`, `store_id`, `community_order_id`, `order_id`, `order_item_id` | **No FK clause.** The intake triggers write them; integrity comes from the source row, and the sweep closes a job whose source vanished. |
| `source` | TS: custom_order \| store_line \| stock \| free \| split \| partner |
| `community_product_id`, `variant_id` | stock jobs and store lines |
| `parent_job_id` | REFERENCES production_jobs(id); written only by the floor route |
| exactly-one link | CHECK `((community_order_id IS NOT NULL) + (order_item_id IS NOT NULL) <= 1)` |
| `title`, `quantity`, `done_qty`, `passed_qty` | title ≤ 200 · quantity CHECK 1..100000 · counts ≥ 0 |
| `stage` | DEFAULT 'review'. TS: review \| approved \| waiting \| queue \| printing \| assembly \| finishing \| qc \| ready \| delivered \| closed (the brief's ten plus a terminal) |
| `hold_reason` | '' · TS: customer \| material \| parts \| partner \| file \| approval \| other |
| `printer_id`, `queue_position` | REFERENCES merchant_printers ON DELETE SET NULL · REAL |
| `suggestion`, `facts`, `needs`, `tags` | '{}' · '{}' · '[]' · '[]' |
| `version_ref` | '' — `'rev:<n>'` from `community_orders.request_revision`; the Project track's approved version id once its lock lands; `'line:<order_item_id>'` for store lines |
| dates and flags | `due_at` · `restock_on` (Baghdad day) · `priority` 0\|1 · `planned_at` · `printing_at` · `ready_at` · `consumed_at` · `consumed_basis` '' (estimate \| measured) · `closed_at` · `closed_reason` '' (TS: cancelled \| refunded \| not_needed \| source_gone) · `created_at` · `updated_at` |
| `rev` | INTEGER 0; optimistic lock → JOB_CHANGED |

- Indexes: UNIQUE (community_order_id) WHERE parent_job_id IS NULL AND community_order_id IS NOT NULL; UNIQUE (order_item_id) WHERE parent_job_id IS NULL AND order_item_id IS NOT NULL; (merchant_id, stage, due_at); (printer_id, stage, queue_position); (merchant_id) WHERE planned_at IS NULL.
- `trg_production_job_identity_locked`: BEFORE UPDATE OF id, merchant_id, source, community_order_id, order_item_id, parent_job_id → RAISE(ABORT,'JOB_SOURCE_LOCKED').

**production_job_events** — append-only; BEFORE UPDATE/DELETE → RAISE(ABORT,'PRODUCTION_EVENTS_APPEND_ONLY'), the 0121 pattern.
- Columns: id, job_id (no FK — the trigger writes the 'created' row), merchant_id, kind, from_stage, to_stage, actor_user_id (NULL = system; «by {member}» after P10), detail '{}', created_at.
- kind (TS): created | planned | moved | assigned | held | released | consumed | failed | split | batched | unbatched | serial | qc | rule | note | closed | asked | covered.
- Indexes: (job_id, created_at), (merchant_id, kind, created_at).

**production_job_materials** — the frozen filament lines: what the job will burn.
- Keyed on the shelf's natural key, because the shelf PUT deletes and reinserts rows with fresh ids (`merchantPrinters.ts:413-451`).
- Columns: id, job_id REFERENCES production_jobs ON DELETE CASCADE, merchant_id, material_id (a catalogue `printMaterials` id, the shelf's vocabulary), color_hex '' | #rrggbb, grams ≥ 0, mapped 0|1, used_grams NULL.
- `mapped` records whether an engine-B material id was mapped to a catalogue id. Unmapped lines are «untracked» and flagged in the sheet until P11's E10 converges the two vocabularies.
- UNIQUE (job_id, material_id, color_hex); INDEX (merchant_id, material_id, color_hex).
- No state column: a line is committed while its job is open and unconsumed (derived).

**merchant_request_prefs** (+ columns):
- `services` '[]' — the 17 SERVICE_KEYS.
- `run_hours_per_day` INTEGER, CHECK NULL | 1..24.
- `show_next_start` 0|1, DEFAULT 0.
- `max_colors` — derived by `refreshWorkshopFacts`.
- `queue_minutes`, `queue_at` — a derived snapshot, refreshed on job writes and by the sweep, decayed at read (the 0159 «derived facts on prefs» precedent).
- The prefs PUT is an UPSERT that names its own columns (`merchantPrinters.ts:616-637`), so it never touches these.

**community_products** (+) `made_to_order` 0|1, DEFAULT 0: the «Make each order» switch. Customizable-template products, and private products minted from a chat quote (0152 `audience_user_id`), are custom work by definition.

**Intake triggers** — they fire in the committing transaction and cannot abort it.
- `trg_production_intake_custom`: AFTER INSERT ON community_orders WHEN NEW.state IN ('funded','in_progress'):
  ```sql
  INSERT OR IGNORE INTO production_jobs
    (id, merchant_id, store_id, source, community_order_id, title, quantity,
     stage, due_at, version_ref, created_at, updated_at)
  VALUES (
    'pjc_'||NEW.id, NEW.merchant_id, NEW.store_id, 'custom_order', NEW.id,
    substr(COALESCE(CASE WHEN json_valid(NEW.request_snapshot)
                    THEN json_extract(NEW.request_snapshot,'$.spec.title') END, ''), 1, 200),
    MAX(1, COALESCE(
      CASE WHEN json_valid(NEW.offer_snapshot)   THEN json_extract(NEW.offer_snapshot,'$.quantity') END,
      CASE WHEN json_valid(NEW.request_snapshot) THEN json_extract(NEW.request_snapshot,'$.spec.quantity') END,
      1)),
    'review',
    strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+'||NEW.completion_days||' days'),
    'rev:'||COALESCE(NEW.request_revision, 1),
    NEW.created_at, NEW.created_at);
  ```
  plus the `'created'` event (`INSERT OR IGNORE`, id `'pje_'‖NEW.id‖'_created'`).
- `trg_production_intake_line`: AFTER INSERT ON order_items WHEN NEW.community_product_id IS NOT NULL AND NEW.bundle_parent_item_id IS NULL AND EXISTS (SELECT 1 FROM community_products p WHERE p.id = NEW.community_product_id AND (p.made_to_order = 1 OR p.audience_user_id IS NOT NULL)).
  - Merchant, store, created_at and `delivery_prep_days` are read from the `orders` row inserted earlier in the same checkout batch.
  - title = name_snapshot, quantity = qty, due = created_at + preparation days.
- No trigger follows an order's later state; the lane is derived (below).

### B) `production_throughput` (M-B)
- **production_jobs** (+ columns):
  - `batch_id` REFERENCES production_batches ON DELETE SET NULL.
  - `serial` TEXT, UNIQUE WHERE NOT NULL, locked by `trg_production_job_serial_locked` (BEFORE UPDATE OF serial WHEN OLD.serial IS NOT NULL AND NEW.serial IS NOT OLD.serial → RAISE(ABORT,'JOB_SERIAL_LOCKED')).
  - `assignee_user_id` (P10 members; the «Mine» filter).
- **production_serial_counters** (year INTEGER PK, next INTEGER DEFAULT 1).
  - The serial is `'LEV-'‖year‖'-'‖printf('%03d',next)`. It is minted lazily — at the first Printing, label or traveler, or on a call from the Project/Digital Twin track — in one batch: a conditional `UPDATE … WHERE serial IS NULL` plus the counter bump.
  - Unit serials such as `LEV-2026-091-0042` are **derived** (unit ≤ quantity); split children take consecutive ranges in child order.
  - There is no per-unit table, so no second serial system sits beside `order_item_units`/`device_serials` (0098 PART 7, `migrations/0098_inventory_lots.sql:316-328`).
- **production_batches**:
  - Columns: id, merchant_id, store_id, printer_id (SET NULL), fingerprint, state, plates ≥ 1, minutes, saved_minutes NULL, saved_grams NULL, created_by, created_at, started_at, done_at.
  - state (TS): planned | printing | done | dissolved.
  - Savings stay null, never a guess.
- **production_batch_dismissals** (merchant_id, fingerprint, created_at; PK on both).
- **production_rules**: id, store_id, merchant_id, name ≤ 60, trigger, conditions '{}', action '{}', enabled, position, created_by, created_at, updated_at. trigger (TS): job_opened; request_matched arrives in M-C. At most 20 per store.
- **production_part_commits** — components used INSIDE a job, taken from the merchant's own catalogue.
  - Only the Build Recipe's hidden or fixed lines are committed. A part the customer bought as its own order line was already decremented at checkout and is never committed again.
  - Columns: id, job_id (CASCADE), merchant_id, community_product_id, variant_id, qty > 0, state, created_at, settled_at. state (TS): committed | released. UNIQUE (job_id, community_product_id, variant_id).
  - Commit = the checkout's guarded decrement (`… SET stock = stock − ? WHERE id = ? AND stock >= ?`, variant-aware; the `storeOrders.ts:1024-1043` model), followed by `alertLowStock` (`worker/lib/catalog/lowStock.ts`).
  - Release (order cancelled or refunded, job closed) = a guarded restock by the sweep.
  - No second inventory.
- **merchant_printers** (+) `site` TEXT '' ≤ 40 — the «branch» label split sheets group by.
- **P10 amendment**, inside P10's `store_members` migration if it has not shipped, else here: `merchant_store_members` (+) `capabilities` TEXT '[]'. Capability words stored as data, so no CHECK rebuild is ever needed.

### C) `production_network` (M-C)
- **production_handoffs** — the immutable frozen package sent to a partner.
  - Columns: id, merchant_id, job_id (SET NULL), hash, manifest_json, created_by, created_at; UNIQUE (job_id, hash).
  - `trg_handoff_immutable`: BEFORE UPDATE → RAISE(ABORT,'HANDOFF_IMMUTABLE'). A change is a new row.
  - Built by ONE composer shared with the Project track's handoff package (#16): whichever lands first owns `worker/lib/handoff.ts`, and the other extends it.
- **production_network_asks**:
  - Columns: id; job_id (the partner child job) REFERENCES production_jobs; merchant_id (A, who asks and stays responsible); partner_merchant_id (B), with CHECK (partner_merchant_id <> merchant_id); group_id; mode (TS: compete | split); quantity ≥ 1; due_at; late_ack 0|1; child_request_id UNIQUE REFERENCES community_requests; chat_id; handoff_id REFERENCES production_handoffs; depth CHECK 1..2 (v1 allows 1); closed_at; closed_reason (TS: withdrawn | covered | expired | declined | parent_cancelled); created_by; created_at.
  - Indexes: (job_id), (group_id), (partner_merchant_id, created_at DESC), (merchant_id, created_at DESC).
  - The ask's state (sent / quoted / accepted / delivered / done) is **derived** from the child request, offer and order.
  - `trg_network_ask_child_direct`: BEFORE INSERT ON production_network_asks. The child must be a DIRECT request whose customer is A's owner and whose target is B's store, else RAISE(ABORT,'NETWORK_ASK_NOT_DIRECT').
  - `trg_network_compete_once`: BEFORE INSERT ON community_orders WHEN EXISTS (an ask with mode 'compete' whose child_request_id = NEW.request_id). It raises RAISE(ABORT,'NETWORK_ASK_COVERED: constraint failed') when another request in the same group already has a live community order. Because the message contains «constraint», the accept route's existing failure branch (`marketplace.ts` ≈ 2341-2366; `isConstraintAbort`, `walletOps.ts:448`) releases the reservation and answers 409. This gives one winner per compete group **without editing the accept route**.
- **merchant_partners** (merchant_id, partner_merchant_id, state, note ≤ 200, created_at, updated_at; PK on the pair).
  - state (TS): trusted | hidden.
  - Hidden works both ways: B hiding A refuses A's asks; A hiding B removes B from A's finder.
- **merchant_service_packages**:
  - Columns: id, store_id, merchant_id, preset, title ≤ 60, services '[]', extra_days 0..60, uplift '{}', active, position.
  - preset (TS): print_only | print_assembly | premium_finish | prototype | full_build | custom.
  - UNIQUE (store_id, preset) WHERE preset <> 'custom'; at most 8 per store.
- **merchant_request_prefs** (+ columns): `partner_work` 0|1, DEFAULT 0 (quiet by default); `partner_terms` '{}' = {min_iqd, max_open 1..20, note ≤ 200, pickup_ok}; INDEX (partner_work) WHERE partner_work = 1.
- **community_offers** (+) `package_key` — added only if the Project track's offer-variants phase has not added it. Their offer writer writes it; production reads it to pre-fill a custom job's needs.

### JSON shapes
Each is parsed by one pure normaliser; unknown keys are dropped.

**JobFacts v1** (`production_jobs.facts`, merchant-only):
```
{ v: 1,
  source: "quote|estimate|recipe|product|manual|none", quote_id|null, analysis_id|null,
  technology, quality, nozzle_mm, colors_count, pieces, piece_mm{x,y,z}|null,
  minutes: {per_plate, plates, setup} | {total} | null,
  materials: [{material_id, color_hex, grams, mapped}],
  components: [{community_product_id, variant_id, qty, line: "bom|order"}],
  personalization: [...],   // words from the order line's configuration snapshot, once the templates track has landed
  file_refs: [ids], warnings: [codes],
  confidence: "exact|estimated|insufficient" }
```
Facts come from the first source that answers:
1. `print_quotes` WHERE request_id AND merchant_id AND state IN ('offered','draft'), offered first, newest first. (`community_offers` has no quote_id; sending an offer marks the quote 'offered'.)
2. That quote's `print_analyses` and `print_analysis_materials`, × quantity.
3. The request's stored estimate (engine A grams and minutes; read on the server only).
4. The Build Recipe × quantity (components track).
5. Product attributes (weight_g, dimensions).
6. Manual entry.

Nothing is invented: unknown minutes stay null, and the card says «Add a costing to plan it».

**suggestion**: `{printer_id, reasons:["FITS","LOADED","EARLIEST","COSTED_ON","VERDICT","RULE"], rule_id|null, forced:false, at}`.

**rules:**
- Condition: `{all:[{field, op, value}]}`.
  - Fields: material | color | technology | longest_mm | quantity | total_iqd | collection | component (nfc | led | motor | magnet) | service | source.
  - Ops: is | in | over | under.
- Actions (a closed list with no state or money verb): suggest_printer · tag (≤ 24 characters, decency-checked) · review (hold in Needs you with a reason) · suggest_package (M-C) · suggest_partner (M-C) · assign_member (after P10).
- Rules are pure functions with no database handle, evaluated by the planner and at read time.

**batch savings**: `{plates_before, plates_after, setup_minutes|null, grams|null}`.
- Minutes = Δplates × (`printer_models.warmup_minutes` + `print_analyses.preparation_minutes`).
- Grams = Δplates × prime/purge/brim grams.
- Filled only when measured.

**handoff manifest v1:**
```
{ v,
  source {job_id, serial},
  approved {kind: "request_revision|design_version", ref, hash},
  job {title, quantity, due_on, destination: "workshop"},
  spec {process, material_id, colors[], quality, dims_mm, finish},
  personalization [],
  files [{id, name, kind, bytes, sha256}],   // the child request's copied rows; never an object key
  bom {filament[], parts[{name, qty, supplied_by}], hidden[]},
  steps {print_notes, assembly[], post_processing[]},
  qc [{check, required}],
  license | null,
  notes }
```
- Sections from tracks that have not landed are ABSENT, never empty.
- Forbidden anywhere — a test scans the serialised JSON: customer | contact | phone | address | email | price | fee | margin | cost_ | escrow | the parent's order id.

### Derived, never stored
- **Lane** = f(job.stage, order state):
  - custom order `cancelled|refunded` → closed (history);
  - custom order `merchant_marked_delivered|customer_confirmed|completed` → done;
  - custom order with `ready_at` set while the job is before Ready → ready;
  - store order `cancelled` → closed; `shipped|delivered` → done;
  - otherwise the job's own stage.
- **Partner child jobs** take their lane from the child order:
  - none or open → waiting (partner);
  - funded or in_progress → waiting (partner, in production);
  - merchant_marked_delivered → qc, «arrived — check it»;
  - cancelled or refunded → back to unallocated.
- **Review reasons** (why a job sits in Needs you): rule says review · approval pending (the Project track's lock, once landed) · material short · due impossible · no printer can make it · no estimate · version changed since planning · store order not confirmed.
- **Commitments** per (material, colour) = Σ grams × (quantity − done_qty) / quantity, over lines of jobs whose lane is open and whose `consumed_at` IS NULL.
  - A colour with no exact shelf line counts against that material's '' (untracked-colour) line, mirroring `stockVerdict`'s own rule (`eligibility.ts:311`).
  - The matcher subtracts commitments only for a workshop whose **floor is active** (a person moved a job in the last 30 days). Before a merchant adopts the board, matching behaves exactly as today.
- **Capacity:**
  - P = active printers that are not offline; H = `run_hours_per_day`.
  - queue = Σ remaining job minutes (for a printing job: estimate − elapsed, floored at 10 % of the estimate).
  - days = ceil(queue / (P × H × 60)).
  - word = today (0 days and Baghdad hour < 18) | tomorrow | busy_until(day).
  - H unknown → absent (never invented), and the declared workload keeps driving the ranking.
- Also derived: **loaded colours**, **lateness**, **ask state**, and **partner reliability** (private: completed count, on-time share against the ask's due, disputes lost, over B's network orders).

### Reused verbatim / not added
**Reused:**
- community_orders, orders and order_items — read only; the client calls their doors;
- community_order_updates and its routes;
- `applyMerchantOrderMove` and bulk-status;
- escrow, wallet, offers, direct requests (0151), the chat quote and cards;
- print_quotes, print_analyses, print_analysis_materials;
- print_actuals, print_failures, printer_calibration_stats (0078 §6, finally written);
- merchant_material_stock (natural key);
- merchant_printers + printer_models via `resolvePrinter`;
- `evaluateEligibility` / `printerCannot` / `fitsInBuild` / `rankScore` / `loadCandidates` — extended, never forked;
- `publicWorkshopFacts` / `storefrontWorkshopFacts` — still ONE statement;
- community_request_matches reasons;
- the `receipts.ts` label pattern and `qr.ts`;
- viewer tokens for 3D;
- the attention `source()` pattern;
- DataList, Sheet v2, Segmented, Menu, StatusChip;
- P10 membership.

**Not added:**
- no slots table (capacity is computed at read time, row 175);
- no reservation ledger;
- no per-unit serial table;
- no new wallet, escrow, chat, orders, products, request marketplace or notification kind;
- no upload purpose;
- no printer telemetry;
- no platform-wide calibration rows.

## 4. API

**Routers** — one mount line each in `worker/index.ts`, integrator-owned:

| Mount | File | Holds |
|---|---|---|
| `/api/merchant/production` | `worker/routes/merchantProduction.ts` | passport, slot, board, jobs, printers, materials |
| `/api/merchant/production/plan` | `merchantProductionPlan.ts` | batches, rules |
| `/api/merchant/production/print` | `merchantProductionPrint.ts` | serials, travelers, labels |
| `/api/merchant/production/network` | `merchantProductionNetwork.ts` | partners, asks, handoff |
| `/api/merchant/service-packages` | `merchantServicePackages.ts` | packages |

Every answer is `Cache-Control: private, no-store`. No `anonymousCached` read is added; the public words ride the existing store reads.

**Guards:**
- `requireAuth` on everything.
- `requireStoreOwner` until P10; after P10:
  - `requireStoreAccess(c,'production')` for the floor;
  - `requireStoreAccess(c,'production_lead')` for rules, batches, split, the passport, and the partner finder and asks.
- Owner-only: money, payouts, settings, staff, the partner-network opt-in. Accepting a partner quote is the owner's by construction: the owner's user is the child request's customer, and only the customer can accept.
- **Admin setting `productionConfig`**:
  ```
  { passport: false, floor: false, batches: true, rules: true, calibration: false,
    network: false, batch_suggestions: 5, plate_gap_mm: 5, max_asks_per_group: 3,
    max_open_asks: 20, ask_quote_hours: 72, ask_buffer_days: 1, max_chain_depth: 1 }
  ```
  - Lives in `SETTING_DEFAULTS`, with a normaliser in `PUT /api/admin/settings/:key`; audited; NOT public.
  - passport = false → the passport routes answer 404, the card is not mounted, and the matcher ignores services and hours.
  - floor = false → every floor route answers 404 to non-admins, `/me.can.production` is false, and the attention source is absent.
  - Intake and planning run from day one either way (private rows).
- Network create routes add `requireCommunityOpen` (they start trade) and refuse MERCHANT_SUSPENDED / STORE_SUSPENDED.
- Every statement carries the session's merchant id; no store, merchant, customer or price id is ever read from a body.

### M-A

**Routes:**

| Route | Answers / behaviour | Refusals | Rate |
|---|---|---|---|
| `GET /production/passport` | `{facts{technologies, max_build_mm, max_colors, nozzles[], enclosed, hardened, materials[], shelf_colors}, services[], run_hours_per_day\|null, show_next_start, capacity{printers[{id, name, free_from, queue_minutes, unknown_jobs}], next_start:'today'\|'tomorrow'\|'YYYY-MM-DD'\|null}, missed[{reason, count}]}` (missed = last 30 days) | — | 60/min |
| `PATCH /production/passport {services?, run_hours_per_day?, show_next_start?}` | An absent field is unchanged. Narrow UPDATE (+ INSERT OR IGNORE of the prefs row); `enqueueMatchStatement(merchant,'passport')` and the `afterStorefrontWrite` purge; audit `merchant.passport_saved`. | 400 PASSPORT_SERVICE_UNKNOWN {key} · 400 PASSPORT_HOURS_INVALID | 60/h |
| `GET /production/slot?request_id=` | `{start, ready_days, printer{id, name}}`, for a request this merchant may quote (`liveVerdictForUser`) | 404 NO_CAPACITY_DATA | 60/min |

**Matcher** (no new route):
- `evaluateEligibility` gains a SERVICE reason in the capability dimension:
  - a request that needs no service never fails it;
  - a workshop that never declared services counts as 'unknown' and passes;
  - `services_needed` stays [] until the components and design tracks feed it;
  - the client words go in `workshop/reasons.ts`, pinned equal by `tests/eligibility.test.ts`.
- `rankScore`'s 'availability' uses the derived start day when hours are stated: today 1 · tomorrow .85 · ≤ 3 days .5 · later .15 · missing the request's deadline → 0. Otherwise the old workload table stays (`printMatchingScore.ts:129`). No new weight; stored `printMatchWeights` untouched.
- `refreshWorkshopFacts` stores max_colors.
- `storefrontWorkshopFacts`/`publicWorkshopFacts` add services and the opt-in next_start inside their existing single statement (`tests/d1Waves` ceilings unchanged).

**Sweep** — a `runDurableJobs` step `'production'` after `'request_rematch'`, on the */15 cron:
- materialise missing jobs for open custom orders and made-to-order lines (same deterministic ids; this is also the backfill);
- plan up to 200 unplanned jobs;
- refresh the queue snapshots.

### M-B

**Board and job reads:**
- `GET /production/board?view=&lane=&mine=&cursor=` (120/min) →
  ```
  { lanes: [{id, count, jobs[≤ 60], next_cursor}],
    printers: [{id, name, availability, site, loaded[], queue_minutes, free_from}],
    header: {next_start, printers, queue_minutes, week{made, on_time_pct|null, failed}},
    suggestions: {batches, saves_minutes|null},
    generated_at }
  ```
  - Card shape: `{id, title, qty, lane, stage, reason|null, order{kind, id, ref, state, customer_first_name}, due_at, late, printer, suggestion, swatches[{hex, grams, short}], minutes, progress, done, passed, batch, tags, assignee, thumb, serial, rev}`.
  - D1: wave 0 runs only when unplanned jobs exist (up to 50 planned inline). Wave 1 is three statements in parallel: open jobs joined to orders, plus material lines and the shelf, as JSON aggregates · printers with their last loaded colours · the week's figures.
  - Batch suggestions are computed in TypeScript from the same rows. Cursors are exact (limit + 1, D8).
- `GET /production/jobs/:id` → detail: facts, material lines with alternatives, parts, suggestion reasons, up to 50 events, counts, serial, asks (M-C), `can{…}`. 404 JOB_NOT_FOUND — another store's id gets the same 404.

**Creating a job:**
- `POST /production/jobs` with `{kind:'line', order_item_id}` | `{kind:'stock', product_id, variant_id?, quantity}` | `{kind:'free', title, quantity}` → 201.
- Refusals: 400 JOB_SOURCE_INVALID · 404 JOB_LINE_NOT_FOUND · 409 JOB_EXISTS.
- A finished stock job offers «Add 20 to stock?» through the existing restock sheet (`PATCH /products/:id`); production never raises catalogue stock itself.

**The move — `POST /production/jobs/:id/move {to, rev, actual?{minutes?, grams?[]}, failure?{cause, stage:'early'|'middle'|'late', wasted_grams?}, note?}`** (240/min)

Transition table (pure):

| From | Allowed to |
|---|---|
| review | queue, waiting, closed |
| waiting | queue, review |
| approved | queue, waiting |
| queue | printing, waiting, review |
| printing | assembly, finishing, qc, ready, queue (failed) |
| assembly | finishing, qc, ready, printing |
| finishing | qc, ready, assembly |
| qc | ready, printing, assembly, finishing |
| ready | qc (stock/free/manual jobs also → delivered) |
| delivered, closed | terminal |

- **Guards**, read from the order:
  - moving to printing needs a printer; the suggested one is assigned in the same write;
  - the custom order must be 'in_progress'; the store order must be confirmed or processing;
  - approval is required when the Project track's lock says so.
- **One batch:**
  - a conditional `UPDATE … WHERE id AND merchant_id AND rev = ? AND stage = ?`;
  - the event row, fenced on the new rev;
  - a saved «actual» → a `print_actuals` row (material_id only when it is a `print_materials` id);
  - a failure → a `print_failures` row, a reprint, and the wasted grams taken off the shelf;
  - the first arrival at Ready → consumption, exactly once: the `consumed_at` fence, then `grams = MAX(0, grams − used)` on the exact-colour line, else on the '' line, each statement fenced on this batch's timestamp; parts are settled in the same batch.
- It never writes community_orders, orders, order_items, community_order_updates, escrow, wallet or ledger rows.
- **Refusals:** 409 JOB_CHANGED {job} · 409 JOB_MOVE_INVALID {from, to} · 409 JOB_ORDER_NOT_STARTED {order_id} (the client then offers the existing start door) · 409 JOB_ORDER_NOT_CONFIRMED · 409 JOB_ORDER_CLOSED · 409 JOB_ORDER_DISPUTED · 409 JOB_APPROVAL_REQUIRED · 409 JOB_PRINTER_REQUIRED · 400 FAILURE_CAUSE_INVALID.

**Bulk, edit and helpers:**
- `POST /production/jobs/bulk-move {ids ≤ 50, to}` → `{done[], refused[{id, code}]}`. Delivered and closed are not allowed in bulk (BULK_MOVE_NOT_ALLOWED); BULK_TOO_MANY is reused. 30/min.
- `PATCH /production/jobs/:id {rev, printer_id?, force?, queue_position?, needs?, tags?, priority?, restock_on?, hold_reason?, assignee_user_id?, facts?{minutes?, grams?[]}}`:
  - Hard `printerCannot` reasons (PROCESS, BUILD_VOLUME, MATERIAL, ENCLOSURE, HARDENED_NOZZLE, QUALITY, NOZZLE, MULTICOLOR) → 409 JOB_PRINTER_CANNOT {reasons[]}, unless `force:true`. Override is always allowed and is recorded in history; soft reasons come back as warnings.
  - Other refusals: 404 JOB_PRINTER_UNKNOWN · 400 JOB_NEEDS_INVALID / JOB_TAGS_INVALID / JOB_FACTS_INVALID.
- `POST /production/jobs/:id/assign-suggested {rev}`.
- `POST …/alternative {rev, from{material_id, color_hex}, to{…}, consent:'customer_agreed'|'internal'}` — 404 MATERIAL_LINE_UNKNOWN · 409 MATERIAL_SHORT {available}.
- `POST …/split {rev, parts[{printer_id|null, quantity}] 2..10}`:
  - children are created by a conditional INSERT: the open children's total plus the new part must stay ≤ the parent's quantity;
  - the parent's material lines are divided proportionally;
  - refusals: 409 SPLIT_OVER {remaining} · 400 SPLIT_TOO_MANY · 409 JOB_NOT_SPLITTABLE (once printing).
- `POST …/progress {done_delta, passed_delta?}` — 409 PROGRESS_OVER.
- `PATCH /production/printers/:id {availability?, site?}` → a narrow UPDATE of those two columns, then `refreshWorkshopFacts` and a rematch. The replace-all `PUT /printers/:id` stays PrintersTab's. 404 PRINTER_NOT_FOUND.
- `GET /production/materials` → `[{material_id, color_hex, color_name, grams, committed, available, jobs_short, runs_out_in_days|null}]`; runs_out_in_days needs ≥ 5 consumed samples in 14 days.
- `POST /production/materials/restock {material_id, color_hex, grams}` → a single natural-key upsert (+grams), never the replace-all PUT; the STOCK_* codes are reused. 60/h.

**Plan** (`/production/plan`):
- `GET …/batches/suggestions`, from the pure `batches.ts`:
  - groups open approved and queued jobs by (technology, material, colour set, nozzle class, quality);
  - a subset of colours may join a group when the union stays ≤ the printer's max_colors;
  - candidate printers are those `printerCannot` clears for every member;
  - piece footprints are shelf-packed onto the bed with `plate_gap_mm`;
  - jobs are ordered by (priority, due), and a job joins only if the batch finishes before its due date.
- `POST …/batches {fingerprint, printer_id, job_ids}` — re-validated on the server; 409 BATCH_INCOMPATIBLE {job_id, reason} · 409 BATCH_STALE.
- `POST …/batches/dismiss {fingerprint}`.
- `POST …/batches/:id/move {to: printing|done|dissolved}` → each member's single move repeated → `{done[], refused[]}`.
- Rules:
  - `GET/POST …/rules`, `PATCH/DELETE …/rules/:id`, `POST …/rules/reorder`, `GET …/rules/preview?job=`;
  - `GET …/rules/suggested` — learned: at least 5 manual assignments of one (material, colour) to one printer in 30 days, at an 80 % or higher share;
  - refusals: 400 RULE_INVALID {field} · 409 RULES_TOO_MANY {max:20} · 404 RULE_NOT_FOUND;
  - writes 60/h.

**Print** (`/production/print`, 60/h):
- `POST …/serial/:jobId` — idempotent mint.
- `GET …/travelers.html?jobs=a,b(≤ 50)&lang=ar|en|ckb`.
- `GET …/labels.html?job=|batch=&lang=` — mints a serial if missing; units are derived; pages hold at most 50.

**Attention** (`worker/routes/merchantWorkspace.ts`): ONE `source()` block, one statement with a JSON first-rows column: `production?: {needs_you, late, ready, short, first[≤ 2], link}`.
- Present only when the floor is enabled AND an open job exists.
- Not a member of `EVERY_SOURCE` (like `speed`: its silence forbids nothing).

**Matcher:** `loadCandidates` subtracts commitments from each stock line for active floors, with one aggregate in the candidate wave; `stockVerdict` is unchanged.

### M-C

**Finding partners** — `GET /production/network/jobs/:id/partners?qty=&due=&pickup=` (`requireCommunityOpen`; 60/h; 404 when the network is off):
- Answers up to 5 rows (plus trusted partners): `[{store{name, slug, logo, governorate}, fit{…booleans}, availability{word, day}, reliability{completed, on_time_share}, trusted}]`.
- Candidates must: have partner_work = 1 (partial index); be active; not be self; not be blocked (`merchantBlockSql`); not be hidden in either direction; not be at max_open.
- Each candidate is checked with `evaluateEligibility` over the job as an EligibilityRequest (trade judged on partner terms), reach to A's governorate (or B's for pickup), and services ⊇ needs.
- Ranked trusted first, then by `rankScore` + capacity + Phase 6 reliability.
- Never returns prices, grams, queue minutes or customers.

**Sending asks** — `POST /production/network/jobs/:id/asks {partner_ids 1..3, quantity, due_on, needs?, note ≤ 500, late_ack?, pickup?, client_key 8..80}` (20/h). In one flow:
1. The parent must be one its customer can no longer cancel alone: a custom order `in_progress` (the client calls the existing start door first) or a store order `confirmed|processing`.
2. The partner child job is created by a conditional INSERT (quantity conservation).
3. The handoff snapshot is written (reused when the hash matches).
4. Files are copied once per group (`requestFileCopy.ts`, up to 6).
5. For each partner, `openStoreThread` (A is the customer; one thread per pair).
6. ONE batch for the whole group through `directRequestWrite.ts`: the direct request (`expires_at` ≤ min(now + ask_quote_hours, due)), the print row from the handoff spec, the file rows, revision 1 and the print_request card — plus the ask rows.
7. A replay with the same client_key answers the same group.

Refusals: 409 NETWORK_JOB_NOT_READY {reason} · 409 SPLIT_OVER {remaining} · 409 NETWORK_TOO_MANY_ASKS {max} · 409 PARTNER_NOT_AVAILABLE {partner_id, reason off|full|suspended|hidden|blocked|self} · 409 NETWORK_DUE_AFTER_PARENT {parent_due} · 409 NETWORK_DEPTH · 409 HANDOFF_NO_FILES · 403 MERCHANT_SUSPENDED / STORE_SUSPENDED · COMMUNITY_CLOSED · IDEMPOTENCY_KEY_REUSED (reused).

**Managing asks:**
- `POST …/asks/:id/withdraw` → the child request is cancelled by the shared customer-cancel statements (draft | open | receiving_offers). 409 NETWORK_ASK_ACCEPTED. 60/h.
- `GET …/asks?side=mine|asked&cursor=`:
  - mine = grouped by job, with the derived state, the quote {offer_id, total_iqd, days, revision} and the server's «leaves you ≈»;
  - asked = asks addressed to me, with the asking store's name only.
- `POST …/asks/:id/proof {update_id}` → copies one of the partner's PHOTO updates on the child order into A's own `order_update` prefix (an owned `file_objects` row) and returns the key. The client then posts it through the existing timeline door, with A as the actor. 409 NETWORK_PROOF_NOT_PHOTO.

**Partners, handoff, passport and packages:**
- `GET …/partners/mine` · `PUT …/partners/:merchantId {state trusted|hidden|none, note?}`.
- `GET/POST …/jobs/:id/handoff` — the composed read, and the snapshot (idempotent by hash).
- `PATCH /production/passport {partner_work?, partner_terms?}` — owner only.
- `/api/merchant/service-packages` GET/POST/PATCH/DELETE — 400 PACKAGE_INVALID {field} · 409 PACKAGES_TOO_MANY {max:8}.

**Also in M-C:**
- Admin, after community Phase 6: `GET /api/admin/community/orders/:id/network` → `{parent?, children[]}`, read-only, for the dispute desk (money scope: none).
- Rules gain the `request_matched` trigger and the `suggest_package` / `suggest_partner` actions.
- The composed read `worker/lib/production/summary.ts` `productionSummaryForOrder(orderId)` → `{serial, units, version_ref, printed_on, qc{passed, done}, materials_words}` feeds the Project track (Digital Twin, evidence package, «✓ Quality checked»). It is never a customer route of ours.
- The sweep adds:
  - closing covered compete siblings (through the shared cancel statements);
  - cancelling dead partner allocations;
  - when `productionConfig.calibration` is on, a nightly merchant-scope roll-up of print_actuals and print_failures into printer_calibration_stats, on the first run of a Baghdad day. Engine B moves a quote only at 8 samples or more (`MIN_CALIBRATION_SAMPLES`).

### Refusal words
- Every code above lands in `src/lib/refusalStrings.ts` with ar, en and ckb (ckb ≠ ar ≠ en).
- The five router files are appended to `tests/refusalStrings.test.ts`'s sources list.
- The client decodes them through `merchantRefusal` (shell/refusal.ts), lazily.
- The trigger messages (JOB_SOURCE_LOCKED, JOB_SERIAL_LOCKED, HANDOFF_IMMUTABLE, NETWORK_ASK_NOT_DIRECT, PRODUCTION_EVENTS_APPEND_ONLY) are integrity backstops that no route relies on for its answer.
- NETWORK_ASK_COVERED surfaces as the accept route's 409, and the partner rows re-read.

### Invariant tests
- `productionSchema` — no FK on trigger-written columns; identity and serial locks; append-only events.
- `productionIntake` — drives the real accept, the real checkout and cancel through the routes on node:sqlite; malformed snapshots and a missing merchant row still commit the order.
- `productionLanes` — the order wins.
- `productionMoves` — the transition table, guards, JOB_CHANGED, bulk.
- `productionIsolation` — a structural grep: no write to community_orders | orders | order_items | community_order_updates | community_escrows | community_escrow_events | wallet_* | merchant_ledger_entries from `worker/lib/production/**` or `merchantProduction*.ts`; community_products written only from `parts.ts`; requests only through the shared writers.
- `productionShelf` — consumption once; exact colour else ''; the shelf PUT with fresh ids keeps commitments.
- `productionCommitments` — the matcher subtracts only for active floors.
- `productionCapacity` — Baghdad days; unknown hours → absent.
- `productionBatchPacker`.
- `productionRules` — pure; no state or money verb reachable.
- `productionSerials` — format; uniqueness under a race; the lock.
- `productionPrint` — no contact or price in the HTML.
- `productionParts` — BOM lines only; restock on release.
- `productionActuals` — only confirmed numbers; a quote moves only at 8 samples or more.
- `networkAsks`.
- `networkMoney` — escrow held from A's wallet through the existing accept; the compete trigger lets exactly one acceptance land and releases the losing hold; no cascade either way.
- `networkPrivacy` — every payload the end customer can read is scanned for the partner; every payload B can read is scanned for the customer's name, phone, address, the parent price and order id.
- `handoffManifest`.
- `eligibility` — the new SERVICE reason; client equality.
- `printMatching` — the old numbers when no hours are stated.
- `d1Waves` — board ≤ 2, job 1, move ≤ 2, ask create 3, finder 2; storefront unchanged.
- `customerVocabulary` — the brief's rule G1. Production's customer-facing keys join it; the test is created here if no other Programme C track has created it.

## 5. Client

### Layout
`src/components/merchant/production/`:
- `ProductionSection.tsx` — the board shell, lanes, printer strip, Printers view, and the List view via DataList;
- `JobCard.tsx`, `JobSheet.tsx`, `ShortageSheet.tsx`, `BatchSheet.tsx`, `RulesSheet.tsx`, `PrinterSheet.tsx`, `SplitSheet.tsx`;
- `PassportCard.tsx` + `ServicesSheet.tsx`;
- `PartnerSheet.tsx` (M-C);
- `api.ts` — typed; ids go in; the client never computes a price, a stage mapping or a margin;
- `strings.ts`.

Plus `src/components/merchant/services/PackagesCard.tsx` (M-C).

### Lazy chunks and budgets
gzip level 9, pinned in `tests/bundleBudget.test.ts`: WORKSPACE_SCREENS goes from 21 to 22 with `ProductionSection`, and the sheets join the chunk-of-its-own list. None may be static in the shell, Today, or any storefront closure.

| Chunk | Budget |
|---|---|
| ProductionSection | ≤ 12 KB own (the order-screen pin); closure beyond the shell ≤ 30 KB (DataList, Segmented, Menu and Sheet are already shared chunks) |
| JobSheet | ≤ 8 KB |
| ShortageSheet | ≤ 3 KB |
| BatchSheet | ≤ 4 KB |
| RulesSheet | ≤ 5 KB |
| PrinterSheet | ≤ 3 KB |
| SplitSheet | ≤ 3 KB |
| PassportCard (+ ServicesSheet) | ≤ 4 KB |
| PartnerSheet (M-C) | ≤ 5 KB |
| PackagesCard (M-C) | ≤ 3 KB |
| production strings (one lazy module) | ≤ 5 KB |

What the rest of the app pays:

| Surface | Now | Cost |
|---|---|---|
| Workspace shell (own / closure) | 15.2 / 25 KB; 25.3 / 32 KB | ≈ +0.25 KB: one NAV entry, BadgeSource `production`, the label, a module-level `lazy()` reference |
| Today (CommandCenter, own chunk) | 15.3 / 18 KB | ≈ +0.25 KB (M-B), +0.15 KB (M-C) |
| OrderDetailScreen / CustomOrderScreen | 7.2 / 12 KB; ≈ 3.2 KB | one chip each, ≤ 0.15 KB |
| OfferComposer | — | one line + a lazy fetch |
| Storefront closure | 46.6 / 47 KB | 0 static bytes (the lazy `extra` chunk) |
| Entry, initial payload | 66.3 / 72 KB; 183.0 / 200 KB | untouched |
| CSS | 60,964 / 61,440 B | **0 B** |

The class check over each chunk's class list is part of every builder's gate. D7 holds: CSS never larger than the previous phase.

### Printers entry (no PrintersTab edit — P9 owns it)
```tsx
printers: section(() => import('../dashboard/PrintersTab'), (m, _p, ws) => (
  <>
    <Suspense fallback={null}><PassportCard /></Suspense>
    <m.PrintersTab canSell={ws.canSell} />
  </>
)),
```
with `const PassportCard = lazy(() => import('../production/PassportCard'))` at module level in `sections.tsx`. The lazy-screen pin (`tests/merchantWorkspaceShell.test.ts:64-72`, which requires `section(() => import('…')`) still matches, and PrintersTab stays a chunk of its own.

### Primitives (no new ones)
- Segmented (lanes and views at `md`, 44 px, with badge counts), Button/IconButton, Menu.
- Sheet v2 (detents ['medium','large'], dragHandle, header, footer).
- DataList (table at or above `wideAt`, cards below, selection and bulk bar).
- StatusChip/Badge, Switch/Checkbox, Field/Select/NumberInput.
- useConfirm — start work, tell ready, offline printer, force assign, accept a partner quote.
- Toast; EmptyState/ErrorState/NotFoundState; ListRowsSkeleton/CardSkeleton; Disclosure (catalog/parts.tsx); useFreshOnReturn.
- No native confirm/alert/prompt.

### Data flow
- The board is fetched on mount, on returning to the tab (useFreshOnReturn), every 60 s while visible, and after every move.
- Moves are optimistic, with rollback and the refusal sentence on 409.
- After a move, the ONE attention read is refreshed (force), so the badge, Today and the board agree.
- Customer-visible steps are two explicit calls in sequence: the existing order door, then the job move.
- 3D: the existing viewer token → `ws.mainHref('/model-viewer/<token>')`. ModelViewer and vendor-webgl stay lazy; nothing 3D is imported here (pinned).
- Travelers and labels: `window.open` of the server-rendered HTML.

### i18n
- `production/strings.ts` carries every key in ar, en and ckb with REAL Sorani (D6; row 169 assumed yes; a native reader checks the table once). Placeholders go through `fill()`.
- `tests/productionUi.test.ts` checks key parity, ckb ≠ ar/en, ≥ 90 % Kurdish letters, no OWNER marker, tokens only, no `dark:`, logical utilities only, `useMotion`, no native dialogs.
- The shell label reuses a Sorani word already present in src; the shell may not invent Sorani.
- Other strings touched:
  - `counter/strings.ts` — the tickets;
  - `workshop/reasons.ts` — SERVICE with ckb (its older ar/en-only rows are named debt, not extended);
  - `catalog/strings.ts` — the made-to-order switch;
  - the print sheets, in ar/en/ckb in `production/print.ts`;
  - `storefront/blocks/Stats.tsx` `workshopWords` — services and next start.
- Numbers are tabular-nums; dimensions and serials are LTR islands; dates are Baghdad dates.

Glossary seed (a native reader checks it once):

| Arabic | English | Sorani |
|---|---|---|
| الإنتاج | Production | بەرهەمهێنان |
| يحتاجك | Needs you | پێویستی بە تۆیە |
| في الدور | Queue | ڕیز |
| يُطبع | Printing | چاپ دەکرێت |
| تجميع | Assembly | پێکەوەنان |
| تشطيب | Finishing | دەستکاری کۆتایی |
| فحص الجودة | Quality check | پشکنینی کوالیتی |
| جاهز | Ready | ئامادەیە |
| سُلِّم | Delivered | گەیەندرا |
| مراجعة | Review | پێداچوونەوە |
| بانتظار | Waiting | چاوەڕوان |
| ينقص ٤٠ غ | Short 40 g | ٤٠ گرام کەمە |
| متاحة اليوم | Available today | ئەمڕۆ بەردەستە |
| أقرب موعد غدًا | Earliest slot tomorrow | زووترین کات سبەینێ |
| مشغولة حتى الخميس | Busy until Thursday | تا پێنجشەممە سەرقاڵە |
| اطلب مساعدة ورشة | Get help from a workshop | داوای یارمەتی لە وۆرکشۆپێک بکە |
| ورشة شريكة | Partner workshop | وۆرکشۆپی هاوبەش |
| قسّم | Split | دابەشی بکە |
| القواعد | Rules | یاساکان |
| الرقم التسلسلي | Serial number | ژمارەی زنجیرە |

### Motion
- `const m = useMotion()`. Cards are `Motion.li` (motion/react-m) under `<MotionFeatures>`, with AnimatePresence and layout.
- `m.spring('move')` for lane changes, `m.spring('quick')` for chips, `m.spring('ui')` for progress.
- Under reduced motion: CROSS_FADE, and `m.travel()` = 0.
- Sheets keep Sheet v2's own springs; Segmented keeps its shared-layout indicator; no invented durations.

### Accessibility
- Each lane is a `<section aria-labelledby>` holding a `<ul>`; the lane scroller is focusable and named.
- Every card's title is a button that opens the sheet; actions are real buttons of at least 44 px.
- Moves are announced politely; colour is never the only signal (swatch plus words).
- The List view is a real table with a caption and `scope=col`.
- Every gesture has a keyboard path: «Move to…», ↑/↓, the grabber button.
- Focus returns to the next card after a move; Escape closes every sheet.

### Acceptance — the brief's bar, the full matrix (closing G7)
- `tests/browser/production.html` + `production-fixture.tsx`, with the API answered locally: jobs in every lane, a shortage, two batch suggestions, three rules, a passport, and (M-C) partner rows.
- `scripts/e2e-production.mjs`: widths [360, 1280] × ar/en/ckb × dark/light × reduced motion reduce/no-preference = 24 passes. Each pass checks:
  - no page-level horizontal overflow (the lane scroller is the only scroller);
  - no page errors; landmarks and an h1;
  - lane switching; a sheet opens as a dialog with focus trapped;
  - a move puts the card in its new lane and writes the live-region text;
  - the shortage and batch flows;
  - a keyboard-only move; RTL mirroring.
- `scripts/e2e-workshop.mjs` is extended for the passport card; it runs ar/en only today, and ckb and reduced motion are added.
- M-C: `scripts/e2e-network.mjs` at API level with a seeded D1, like `e2e-print-request.mjs`. Scenario: A asks B and C (compete) → B quotes → A accepts → C's acceptance is refused and its hold released → B delivers → A confirms → money released. It also asserts that the end customer's order, timeline and notifications never mention B, and that B's payloads never mention the customer.

## 6. Phases with file ownership

**Preconditions shared by all three workflows:**
- Community Phase 5 (client half) and merchant P4/P5 are committed; migration numbers are taken at merge.
- Seam files are edited only by the integrator, as one-line edits: `worker/index.ts`, `schemaVersion.ts`, `ownership.ts`, `mediaRefs.ts`, `settings.ts` plus the `admin.ts` normaliser, `refusalStrings.ts` and its test lists, `merchantRoutes.ts`, `shell/{nav,sections,routeTable,strings,attention}.ts`, `merchantWorkspace.ts`, `merchant.ts` (`/me`), `CommandCenter.tsx` + `counter/strings.ts`, the `jobs.ts` step, `bundleBudget.test.ts`, and the pins in `merchantWorkspaceShell.test.ts` and `merchantRouteGates.test.ts`.
- At most 2 workshops in flight on the 4-CPU box; builds and the budget suite are serialised through the integrator.
- The gate for each workflow, in order:
  1. `npm run check`
  2. `npm run test:unit`
  3. `node scripts/migrate-check.mjs --twice`
  4. `npm run build` + `tests/bundleBudget.test.ts`
  5. the browser scripts
  6. a DECISIONS row (next free — 183 or later today) and a doc section
  7. deploy only after the owner's word.

**Placement.** Programme C runs as lane B beside lane A, admitted only when the file sets are disjoint. The rules survey reserves the C7a / C6 / C7b slots for these three:
- M-A beside merchant **P10**;
- M-B beside merchant **P11**;
- M-C beside community **Phase 8**.

M-A can move earlier if Programme C's lane is free. Its only hard prerequisites are community Phase 6 (M-A edits `printMatchingScore.ts` after Phase 6's metrics land) and the Programme C phases that edit `ProductEditorSheet` (C1a templates, C4 components).

### M-A «اعرف ورشتك · Know the workshop» — size M; migration `production_floor`
**Ships:** the passport goes live on the owner's word (`productionConfig.passport`). Intake and planning run from day one as private rows. The floor stays dark (`productionConfig.floor = false`).

**Collisions:** disjoint from P10 (merchantAuth, merchantStaff, nav gating, StaffSection) except one integrator line in `sections.tsx`, serialised with P10's own edit there. Its routes start on `requireStoreOwner` and join P10's gate enumeration.

**Steps:**
- **A1 schema** (with the integrator): `migrations/<next>_production_floor.sql`, `ownership.ts`, `mediaRefs.ts`, `schemaVersion.ts`, `settings.ts` (+ productionConfig) and the normaliser in `worker/routes/admin.ts`; `tests/productionSchema.test.ts`.
- **A2 vocabulary and pure core:** `packages/contracts/src/production.ts` (stages, lanes, transitions, SERVICE_KEYS, hold reasons, rule vocabulary, refusal codes) and `worker/lib/production/{facts,transitions,lanes}.ts`; tests productionFacts, productionTransitions, productionLanes.
- **A3 intake and planner:** `worker/lib/production/{plan,materials,reasons}.ts`; tests productionIntake, productionPlan.
- **A4 capacity and passport:** `worker/lib/production/{capacity,passport}.ts` (Baghdad-day words via baghdadTime; the missed-work histogram); test productionCapacity.
- **A5 matcher:** `worker/lib/eligibility.ts` (SERVICE), `worker/lib/printMatchingStore.ts` (services, capacity snapshot, max_colors, public facts in the same statement), `worker/lib/printMatchingScore.ts` (availability from the derived start day), `src/components/merchant/workshop/reasons.ts` (+ SERVICE ar/en/ckb); tests eligibility, eligibilityRoutes, printMatching, workshopFactsSeams, d1Waves.
- **A6 routes:** `worker/routes/merchantProduction.ts` (passport, slot) and its mount; the refusal codes; tests productionRoutes, refusalStrings.
- **A7 passport UI:** `production/{PassportCard,ServicesSheet,api,strings}.ts(x)` and the printers line in `shell/sections.tsx` (integrator); `tests/productionPassportUi.test.ts`; `scripts/e2e-workshop.mjs` extended.
- **A8 made-to-order:** `worker/lib/catalog/product.ts` (reads `made_to_order`); `catalog/ProductEditorSheet.tsx` (one Switch in «3D-printing details»), `catalogApi.ts`, `strings.ts`; the catalogRoutes round trip.
- **A9 sweep:** `worker/lib/production/sweep.ts` and the `runDurableJobs` step (jobs.ts seam); test productionSweep.

One adversarial reviewer (the trigger cannot abort a money batch; idempotency; ranking numbers unchanged without hours) and a fixer.

**DECISIONS row:** «intake by a trigger that cannot abort; the job's lane is derived from its order; the floor reads orders and never writes them».

### M-B «شغّل الورشة · Run the floor» — size L; migration `production_throughput`
**Needs:** M-A; P7 (the order screens it adds chips to); P10 (the nav entry is Capability `production`, granted from `/me`); and, for part commits only, C4's Build Recipe — without it part commits are simply absent and nothing else waits.

**Collisions:** disjoint from P11 (App.tsx, notifications, printPricing/printQuote E10, storefront posts). Goes live on the owner's word.

**Steps:**
- **B1 contract and shell** (integrator): `packages/contracts/src/merchantRoutes.ts` (section `production`, id, query words, builders), `shell/{nav,sections,routeTable,strings,attention}.ts`, `worker/routes/merchantWorkspace.ts` source('production'), `worker/routes/merchant.ts` `can.production`. Moves the workshop-group pin (`merchantWorkspaceShell.test.ts:154` → production, printers, costing, requests) and the contract tests; adds bundleBudget WORKSPACE_SCREENS and the 12 KB pin.
- **B2 floor routes:** `merchantProduction.ts` (board, jobs, create, move, bulk-move, patch, assign-suggested, alternative, split, progress, printers PATCH, materials, restock); tests productionMoves, productionBoard, productionIsolation, productionShelf, productionCommitments.
- **B3 plan:** `merchantProductionPlan.ts` and its mount; `worker/lib/production/{batches,rules,learn}.ts`; tests productionBatchPacker, productionRules, productionPlanRoutes.
- **B4 serials and print sheets:** the migration parts (serial, counters); `worker/lib/production/{serials,print}.ts`; `merchantProductionPrint.ts` and its mount; tests productionSerials, productionPrint.
- **B5 parts and actuals:** `worker/lib/production/{parts,actuals}.ts`; tests productionParts, productionActuals.
- **B6 board UI:** `production/{ProductionSection,JobCard}.tsx` and the board keys; `tests/productionUi.test.ts`.
- **B7 sheets UI:** `production/{JobSheet,ShortageSheet,BatchSheet,RulesSheet,PrinterSheet,SplitSheet}.tsx`.
- **B8 integration seams** (integrator): the one CommandCenter ticket (plus the custom-orders «to start» ticket opening the board when production is on), `counter/strings.ts`, the chips in `orders/OrderDetailScreen.tsx` and `orders/CustomOrderScreen.tsx`, the slot hint in `community/requests/OfferComposer.tsx`, `refusalStrings.ts`.
- **B9 acceptance:** `tests/browser/production.html` + `production-fixture.tsx`, `scripts/e2e-production.mjs` (24 passes).

Reviewers: one on isolation and money, one on performance, accessibility and i18n.

**DECISIONS rows:**
- «the floor never moves money or customer-visible state; customer-visible steps are the existing doors, tapped explicitly»;
- «rules are pure and only suggest, tag or hold»;
- «serials: one yearly LEV counter on the job, unit numbers derived — no per-unit registry beside order_item_units/device_serials».

### M-C «شارك العمل · Share the work» — size M–L; migration `production_network`
**Needs:**
- P6 (the chatCommerce churn is over);
- P9 (the printRequests repeat route — the file-copy source);
- P10 (roles);
- P11 (E10 — the material ids the calibration roll-up needs);
- the Project track's C5 (approval lock and handoff composer; without them the handoff degrades to the order's frozen request revision and hash);
- community Phase 6 (reputation and metrics, for the partner-order exclusion).

**Collisions:** runs beside community 8, a sweep without a migration; strings and refusal edits go through the integrator.

**Steps:**
- **C1 schema and seams:** the migration, ownership, mediaRefs, schemaVersion, and the productionConfig network keys.
- **C2 one writer for each shared write, extracted:**
  - `worker/lib/directRequestWrite.ts`, from chatCommerce.ts's print-request and send statements (chatCommerce becomes its caller);
  - `worker/lib/requestFileCopy.ts`, from printRequests.ts's repeat route — shared with the Project track; whichever runs first extracts it;
  - `worker/lib/requestCancel.ts` — the customer-cancel statements.

  chatQuotes, printRequestsV2 and communityRequestLifecycle stay green unmodified.
- **C3 partners, asks, handoff:** `worker/lib/production/{partners,network}.ts`, `worker/lib/handoff.ts` (if C5 has not created it), `merchantProductionNetwork.ts` and its mount; tests networkAsks, networkMoney, networkPrivacy, handoffManifest.
- **C4 partner children and QC:** derived stages, a QC reject → a remake child, the proof copy, and `worker/lib/production/summary.ts`; tests.
- **C5 packages:** `merchantServicePackages.ts`, `services/PackagesCard.tsx` and the services factory line (integrator), package chips in OfferComposer (a seam, once C5's offer variants exist), the store-page service words (lazy `extra` chunk); tests.
- **C6 network UI:** `production/PartnerSheet.tsx`, partner rows in JobSheet and SplitSheet, the passport's partner switch and terms, the trusted/hidden list, and the Network Today ticket (integrator).
- **C7 gates and calibration:** `tests/merchantRouteGates.test.ts` rows for every production route (floor / lead / owner); the nightly merchant-scope calibration roll-up; `scripts/e2e-network.mjs` and the partner pages in e2e-production.
- **C8 seams — only on the owner's word:**
  - `/my-requests` filters in marketplace.ts and printRequests.ts, so network children live in Production, not in the owner's personal requests;
  - excluding partner orders from public reputation (Phase 6's reputation/metrics plus a `completionStatements` predicate) and from reviews (`merchantReviews.ts`, NETWORK_ORDER_NOT_REVIEWABLE);
  - a `network` fee kind (a FEE key behind requireFinancialScope plus one line in the accept route);
  - the admin dispute-desk read.

**DECISIONS row:** «partner work is a direct request in which the workshop is the customer; one winner per compete group and a direct child are database rules; the partner never learns the customer».

### Why this order
- The floor serves orders that already exist (custom orders and store lines). It needs neither the Levo Project container nor the personalization studio — only Phase 6's ranking inputs, P7's order screens (for the chips), P10's gating (for the section) and C4's recipe (for part commits).
- Knowing the workshop (M-A) comes first because it makes matching and offers truer even for merchants who never open the board, and because it records jobs from day one, so the board opens on real history.
- The network comes last because it moves money between merchants. It waits for roles (P10), for one writer of direct requests and file copies (P6/P9), and for the approval lock whose version the handoff references (C5).

## 7. Trade-offs

1. **Intake by trigger — not by editing the accept batch and the checkout, and not by a cron materialiser.**
   - Gain: zero hot-file edits, atomic with the money write, correct in the deploy window.
   - Cost: logic lives in SQL where a reader may not look.
   - Mitigation: safe by construction (OR IGNORE, json_valid, no FK on trigger-written columns), tested through the real routes, backstopped by the sweep, recorded in a DECISIONS row.
   - The rejected alternative: a cron-only overlay (Proposal 2) also leaves money paths untouched, but spreads «what is a job» into every reader through UNION ALL rows and lags 15 minutes.
2. **The lane is derived from the order, and the floor never writes orders.**
   - Gain: no state-following triggers, nothing to release, no second copy of the order state machine.
   - Cost: two explicit calls for customer-visible steps (the door, then the move), and a join on every board read.
   - A refused move after a successful door is harmless, because the lane follows the order.
3. **Commitments are derived from frozen material lines, not kept in a reservation ledger.**
   - Gain: nothing drifts, and nothing is orphaned by the replace-all shelf PUT.
   - Cost: no per-spool reservation history, and commitments are only as good as the estimate ladder (unknown estimates commit nothing, and the card says so).
   - The matcher subtracts them only for active floors; before the board is adopted, matching behaves as today.
4. **Components are committed by guarded decrement (the checkout's model); filament by derivation.**
   - Gain: the storefront's own stock predicate stays the truth for sellable parts, so a part cannot be committed twice.
   - Cost: a committed part is unsellable until the sweep releases it after a cancellation (up to 15 minutes).
5. **The serial is one yearly LEV counter on the job, with units derived.**
   - Gain: honest to 0098 PART 7, and zero merchant controls.
   - Cost: a serial reveals platform volume, and the counter row is a (tiny) write hotspot; the per-store prefix is an owner question.
   - Per-unit QC becomes aggregate counts, not rows.
6. **A new `production` section rather than `custom_orders?view=board`.**
   - Why: the board spans custom orders, store lines, stock and free jobs, and the brief names Production as a workspace.
   - Cost: the contract, nav and route-table pins move once — by the integrator, through P10's machinery.
7. **Board lanes scroll horizontally (w-56) instead of a five-column grid.**
   - Gain: the four standing lanes fit at 1280 beside the open sidebar; a grid would squeeze cards to about 131 px at 1024.
   - No drag-and-drop in v1: there are no cursor classes, and the menu path is the accessible one.
8. **Capacity is stated hours × open job minutes, with no slot calendar.**
   - Gain: it can never drift from the queue, and it needs only one question.
   - Cost: the words are approximate («never a promise») and, for merchants who don't run the board, pessimistic (open orders count as outstanding work).
9. **The matcher is extended inside its existing functions** (the SERVICE reason, commitments in `loadCandidates`, capacity inside the availability weight).
   - Gain: existing ranking tests keep their numbers.
   - Cost: one new reason code, whose Sorani is pinned beside the client list.
10. **Batches are greedy and explainable:** a compatibility key, shelf-packing, never past a due date, and savings only from measured numbers. Less optimal than full bin packing, but fully traceable, and never a merged order.
11. **Rules are a closed sentence vocabulary, pure and evaluated at read time.** They can never act: «route > 300 mm to Large Format» is a highlighted suggestion the merchant still taps, or the planner's default assignment when the job queues itself.
12. **Partner work is a direct request in which the workshop is the customer.**
    - Gain: reuses offers, escrow, acceptance, disputes, chat and the partner's own board, with no new money code.
    - Costs:
      - A needs Levo Wallet balance: there is no path from earnings to the wallet, and the payout methods are ki_card, rafidain, zaincash and cash_pickup;
      - the platform fee applies twice unless the owner sets otherwise;
      - the work is chat-mediated.
    - The compete fence is a trigger on the order insert (the database keeps the promise; the accept route is not edited). Its cost is a generic 409 on the losing acceptance, explained by the re-read.
13. **The finder shows booleans and words, never prices or grams** (row 174: margins never cross doors) — slower than a price list, deliberately.
    - **No drop-ship in v1:** partner deliveries go to A; the column is reserved for the owner's answer.
    - **Transfer of responsibility is not built:** it would be a cancellation and the customer ordering again.
14. **Calibration writes merchant-scope rows only, from confirmed numbers only, after P11's material-id convergence.** Each workshop's estimates get truer from its own machines. The data will be sparser than wall-clock guesses would give — which is the point.

## 8. Open questions for the owner / أسئلة للمالك

1. **Serial format:** LEV-2026-091 from one platform-wide yearly counter (readable, but it reveals how many jobs Levo made), or a per-store prefix such as LEV-NOOR-2026-091?
   صيغة الرقم التسلسلي: عدّاد سنوي واحد للمنصّة أم بادئة لكل متجر؟
2. **Paying a partner:** in v1 a workshop pays its partner from its Levo Wallet and must top up first. Should a later money phase move available earnings into the owner's wallet?
   دفع الشريك: من المحفظة (v1) أم مرحلة مالية لاحقة تنقل الأرباح المتاحة إلى المحفظة؟
3. **Network fee:** keep the usual request fee (5 %, no code change), use a reduced network fee (a new setting plus one line in the accept route), or charge none?
   عمولة العمل بين الورش: 5٪ أم مخفّضة أم لا شيء؟
4. **Files and disclosure:** may a workshop share a customer's model files with a partner for production without telling the customer? (Name, contact, address and price are never shared.) Should the customer's order ever say «made with a partner workshop»?
   مشاركة ملفات الزبون مع ورشة شريكة، والإفصاح له؟
5. **Drop-ship:** may a partner deliver straight to the customer — which gives the partner the customer's name, phone and address — after the customer's explicit consent? Until you decide, partner work always goes to the asking workshop.
   التسليم المباشر من الشريك للزبون بموافقته؟
6. **Transfer of responsibility** from workshop A to workshop B is not built (it would mean a cancellation and the customer ordering again). Do you confirm?
   نقل المسؤولية بين الورش خارج النطاق — تأكيد؟
7. **Reputation:** do you confirm that partner orders do not count in public completed orders, badges or reviews (only a private partner-reliability line), to stop two workshops inflating each other?
   ألا تُحتسب طلبات الشركاء في السمعة العامة؟
8. **Chains:** may a partner pass part of a partner job to a third workshop (at most two levels, never back to the original), or one level only (v1)?
   هل يجوز للشريك طلب مساعدة ورشة ثالثة؟
9. **Public availability:** show «can start tomorrow» on the store page and in offers only when the merchant opts in (off by default)?
   عرض «يمكن البدء غدًا» باختيار التاجر فقط؟
10. **Staff matrix** (extends Q16): amend P10 before it ships so members carry capability grants stored as data (production, production planning, design, finance read-only, delivery)? Money, payouts, settings, staff and the partner switch would stay owner-only.
    توسيع مصفوفة الفريق بصلاحيات مخزّنة كبيانات؟
11. **Calibration:** may a workshop's confirmed print times and failures correct its OWN estimates after 8 prints per printer and material? May anonymised platform-wide averages ever be computed?
    تصحيح تقديرات التاجر من طبعاته بعد 8 عيّنات؟ ومتوسطات عامة مجهولة؟
12. **Who gets production tools:** the same entitlement as the other merchant tools (PLUS), or every store that takes custom orders?
    لمن أدوات الإنتاج؟
13. **Made-to-order:** should printed products that have preparation days default the «Make each order» switch to ON? (Customizable templates and chat-quote products are made to order automatically.)
    تفعيل «يُصنع عند الطلب» افتراضيًا للمنتجات المطبوعة؟
14. **Printer telemetry and phone tab:** automatic Printing/Printed from Bambu, OctoPrint or Moonraker needs a local bridge the Worker cannot reach — a later programme, or never? And should Production become a phone tab for workshops (extends Q1)?
    ربط الطابعات تلقائيًا لاحقًا؟ وتبويب «الإنتاج» على الهاتف؟

GRAFTS: ["From P2 — the lane is derived from the order («the order wins when it is further along»). This replaces P1's two UPDATE triggers that followed order state on community_orders and orders; only the two INSERT intake triggers remain, and nothing on a cancel, refund or deliver path runs production code.","From P2 — material commitments are derived. They are computed over frozen per-job filament lines (`production_job_materials`), keyed on the shelf's natural key, and replace P1's holds state machine (reserved, consumed, released). Consumption happens once, immediately, at the job's first arrival at Ready, on the exact colour line or else the untracked-colour '' line. The matcher subtracts commitments only for workshops whose floor is active (a person moved a job in the last 30 days), so matching is unchanged until a merchant adopts the board.","From P2 — a job lands in «Needs you» only when the server has a reason: rule says review, approval pending, material short, due impossible, no printer can make it, no estimate, version changed, or store order not confirmed. Otherwise it queues itself with the suggested printer assigned (automation, not a control), and the planner re-queues review jobs whose reasons have gone.","From P2 — lists that may grow (stages, sources, hold reasons, event kinds, ask modes) are closed in TypeScript (`packages/contracts/src/production.ts`) rather than by CHECK. CHECK is kept for flags, ranges and exactly-one links.","From P2 — the serial lives on the job and comes from one yearly LEV counter, minted lazily on first need (first Printing, traveler, label, or a call from the Project/Digital Twin track). Unit serials follow the brief literally (LEV-2026-091-0042) and are derived, not stored. QC is done/passed counts on the job rather than per-unit rows.","From P2 — the brief's exact 17 SERVICE_KEYS, each with a customer phrasing (e.g. file_repair = «تجهيز ملفك للطباعة», never «repair mesh»), replacing P1's 16.","From P2 — the network's money and privacy rules:\n- compete and split ask groups;\n- quantity conserved by a conditional INSERT, reused for in-house split children;\n- a trigger requires the child to be a DIRECT request from A's owner to B;\n- one winner per compete group, enforced by a BEFORE INSERT trigger on community_orders whose message contains «constraint», so the accept route's existing failure branch (isConstraintAbort, walletOps.ts:448) releases the hold and answers 409 without editing marketplace.ts;\n- ask only for a parent its customer can no longer cancel alone;\n- no cascade in either direction;\n- chain depth limit and cycle check;\n- partner terms (minimum job, at most N open);\n- trusted/hidden partners, hidden working both ways;\n- the finder shows booleans and words only, never prices or grams.","From P2 — an immutable handoff snapshot row with a hash, plus a test that scans the serialised manifest for forbidden keys (customer, contact, phone, address, email, price, fee, margin, cost_, escrow, parent order id). It is built by one composer shared with the Project track's handoff package.","From P2 — the network test suites: networkPrivacy (both directions), networkMoney, handoffManifest, and the API-level scripts/e2e-network.mjs (A asks B and C, B quotes, A accepts, C's acceptance is refused and its hold released, B delivers, A confirms, money released).","From P2 — anti-collusion and list-hygiene seams, gated on the owner's word: partner orders excluded from public completed orders, badges and reviews; network children filtered out of the owner's /my-requests lists.","From P2 — print_actuals is written only from numbers the merchant confirmed, never from wall-clock gaps or the estimate copied back as an «actual». material_id is written only when it is a print_materials id; the merchant-scope calibration roll-up waits for P11's material-id convergence (E10).","From P2 — a capacity snapshot (queue_minutes, queue_at) on merchant_request_prefs, refreshed on job writes and by the sweep and decayed at read time (the 0159 derived-facts precedent), for cheap matcher and store-page reads; the board still computes exactly.","From P2 — «override always»: hard printerCannot reasons refuse an assignment unless force:true is sent after a confirm, and the override is recorded in the job's history. P1 refused outright.","From P2 — a shortfall line on the board and a single-line «record arrival +N g» restock (a natural-key upsert, never the replace-all shelf PUT) in the shortage sheet; the capacity words merged into P1's one header statement.","From P2 — done_qty/passed_qty counts and a progress route, so big jobs show real progress and commitments shrink as pieces are made.","From P2 — a merchant_printers.site label, so split sheets group printers by branch (shown only when at least two sites exist).","From P2, reshaped — forwarding a partner's photo as proof. Production copies the photo into A's own order_update prefix (an owned file_objects row), and the existing timeline door posts it with A as the actor, so the floor still never writes the customer's timeline.","Corrections to the spine:\n- no FOREIGN KEY clause on trigger-written columns (FK errors are the one violation OR IGNORE does not cover), so intake cannot abort the accept or checkout batch;\n- the passport card is a module-level lazy() rendered inside the existing printers entry, because P1's Promise.all factory fails the lazy-screen regex (tests/merchantWorkspaceShell.test.ts:64-72);\n- lanes are w-56, since the content at 1280 is 960 px (MerchantShell.tsx:309/:460);\n- the Today budget re-measured at 15.3 of 18 KB for the pinned own chunk, so no SetupChecklist payback is needed;\n- the store-page words live in the lazy `extra` chunk (blocks/Stats.tsx workshopWords), 0 static bytes against 46.6 of 47 KB;\n- the lane switcher uses the 44 px `md` size;\n- productionConfig has separate `passport` and `floor` switches, so the passport can go live while the floor stays dark.","New seam implied by both proposals — worker/lib/production/summary.ts productionSummaryForOrder (serial, units, version_ref, printer, QC counts, material words). The Project track consumes it for the Digital Twin, the evidence package and «Quality checked»; it is never a customer route of ours."]

REJECTED: ["P2's virtual jobs (UNION ALL over orders that have no overlay) plus a */15 materialiser as the main intake. It spreads «what is a job» into every reader and leaves commitments and capacity 15 minutes behind. Kept only as the sweep's backstop and backfill.","P2's job id = the order id. Split children, stock jobs and free jobs need ids of their own; P1's deterministic prefixed ids (pjc_/pjl_/pjs_/pjm_) give the same idempotency.","P2's board route moving customer-visible order state through an extracted customOrderMoves (the start/ready/delivered bodies lifted out of marketplace.ts and communityOrderTimeline.ts). It refactors freshly landed Phase 5 money code and gives the floor a path to customer-visible state. Tapping the existing doors explicitly, with the lane derived from the order, gives the same result.","P2's three seams in the accept batch of marketplace.ts for the compete winner. Replaced by a BEFORE INSERT trigger on community_orders, so the accept route is never edited.","P1's per-unit production_units table, per-store serial prefix, prefix lock and prefix UI. A per-unit registry beside order_item_units/device_serials leans against 0098 PART 7, writes up to 2,000 rows per job and adds a control. A job serial with derived unit numbers covers labels, QR and the Digital Twin.","P1's holds state machine (reserved/consumed/released) and its triggers that follow order state on community_orders and orders, closing, consuming or restocking inside cancel/deliver money batches. Derived commitments and derived lanes remove every UPDATE trigger from the money path.","P1's sweep that applies consumption later against a weighing baseline. Consumption is applied once, immediately, at the first arrival at Ready; a later shelf save supersedes it naturally.","P1's `section(() => Promise.all([import(PrintersTab), import(PassportCard)]))` factory. It does not match the lazy-screen regex in tests/merchantWorkspaceShell.test.ts:64-72 that it claims to satisfy; a module-level lazy() inside the existing printers entry does.","P1's claim that four w-64 lanes fit at 1280 (the content is 960 px beside the 256 px sidebar), and its SetupChecklist payback precondition, which rested on a 17.7 KB CommandCenter that measures 15.3 KB as pinned.","P2's `lg:grid-cols-5` board, which gives ≈131 px columns at 1024 with the sidebar open. Snap lanes of w-56 are used instead.","P2's Partners and Capabilities views inside Production. Asks already live in the A↔B store thread and in the job sheet, and the passport sits on Printers where its facts come from. Fewer surfaces, same power.","P2's six Today lines. Reduced to one production ticket (M-B) and one network ticket (M-C).","P2's folding of the custom-orders «to start» ticket into production. The two count different things, and folding would hide new paid orders that need no review; instead the existing ticket opens the board when production is on.","P2's new deadline_fit rank weight. Folded into the existing availability weight (missing a deadline → 0), so no stored printMatchWeights and no existing ranking test changes.","P2's rewriting of the manual workload word from derived days. It would give one column two writers (the prefs PUT still writes it from PrintersTab); the ranking reads derived days when hours are stated and leaves workload alone.","P2's public availability words on by default, and its request-page line «7 workshops can make it — 3 start today». Here availability is opt-in only (show_next_start defaults to 0); the feasibility line belongs to the Project track's instant feasibility (#5).","P2's store-page words in the static src/components/storefront/strings.ts. The storefront closure measures 46.6 of 47 KB, not the 3.5 KB of headroom P2 assumed; the words move to the lazy `extra` chunk (blocks/Stats.tsx workshopWords).","P1's rules with stored effects (assign_printer and hold written by the rule). Rules are pure and evaluated at read time; only the planner's chosen printer is stored.","P1's production_subcontracts stored state machine (draft|sent|accepted|delivered|done|cancelled) and its community_requests.subcontract_job_id column. The ask's state derives from the child request, offer and order, and production_network_asks.child_request_id (UNIQUE) already links the child, so community_requests needs no ALTER.","P1's print_actuals built from Printing→Printed timestamps and from held grams. Calibration must not learn wall-clock gaps or its own estimate; only numbers the merchant confirms are recorded.","P2's separate 'network' staff capability. Partner asks are production_lead work, and acceptance (the money) is the owner's by construction.","Production raising catalogue stock itself when a stock job finishes (P1). The existing restock sheet (PATCH /products/:id) does it on the merchant's tap, so that increment keeps a single writer.","P2's chains of depth 2 in v1. The default is depth 1 (max_chain_depth = 1) until the owner answers; the column already allows 2.","P2's production_allocations table. In-house portions are child jobs (each a real card with its own printer, queue, batch and stage), and partner portions are partner child jobs linked to their ask group; quantity conservation is the same conditional INSERT."]

### Judge's scores — manufacturing

Scored 1–5 per criterion against the tree as it stands (dist rebuilt 2026-09-30 11:54, newer than every source file): CSS 60,964 of 61,440 B, storefront closure 46.6 of 47 KB, Today 15.3 of 18 KB (own chunk, which is the pinned figure), workspace shell 15.2 of 25 KB.

| Criterion | Proposal 1 — «The Floor» (operator-first) | Proposal 2 — «An order seen from the workshop» (network-first) |
|---|---|---|
| Simplicity for the customer (five-control rule) | **5** — Adds no customer control at all. The only customer words are an opt-in «next free day», service words on the store page and truer offer dates. | **4** — Also adds no controls. But availability words go public by default once hours are stated, and it adds a request-page line («7 workshops can make it») the customer never asked for. |
| Power for the merchant | **5** — Board, per-printer queues, list with bulk moves, batches, rules with learned suggestions, splits, travelers and labels, a passport with «missed work», calibration and partners. | **4** — Strongest on the network (compete/split, terms, trusted/hidden, proof forwarding) and on capacity/shortfalls. Thinner on the floor: no printer-queue view, no travelers or labels, rules without learning. |
| Reuse of what exists | **4** — Intake needs no hot-file edit, the client calls the existing order doors, the matcher is extended in place. But a per-unit serial table leans against 0098 PART 7, and a holds state machine duplicates what open jobs already imply. | **4** — Reuses derived commitments, one function behind two doors, and direct requests. But it refactors freshly landed money code, its Partners/Capabilities views duplicate the inbox and Printers, and its handoff table half-duplicates request revisions. |
| Budgets (bytes, CSS, D1 waves) | **4** — 0 B CSS with verified classes, one Today row, every surface lazy and pinned. Three factual slips: CommandCenter is 15.3 KB, not 17.7 KB; four w-64 lanes do not fit the 960 px content at 1280; the `Promise.all` factory fails the lazy-screen regex it says it satisfies. | **3** — 0 B CSS verified and a one-wave board. But it plans six Today lines, `lg:grid-cols-5` gives ≈131 px columns at 1024, and its store-page words go into the static `storefront/strings.ts`, where 0.38 KB of headroom was measured (it assumed 3.5 KB). |
| Security and money soundness | **4** — The floor provably never writes an order, escrow, wallet or ledger row (structural test), and intake is INSERT OR IGNORE. But FK clauses on trigger-written columns could still abort a money batch, and the network has no compete fence and no collusion guard. | **4** — N-1…N-15 is the most rigorous network model: compete winner, quantity conservation, no public reputation from partner work, privacy scans, depth and cycle checks. But the board moves customer-visible order state, and two workflows edit the accept batch in the hottest money file. |
| Mobile-first | **5** — Lane switcher, printer strip and bottom-sheet detents everywhere, one primary action per card, keyboard parity. | **4** — The grouped collapsible list and sheets work, but at 360 a three-view switcher, a capacity line and two alert lines come before the first card. |
| Feasibility on Workers/D1/ogl | **4** — Triggers, JSON1, server-rendered HTML sheets and the */15 sweep all run natively on D1; ogl is untouched. The slips above are fixable in review. | **4** — Feasible, but virtual UNION ALL rows and `json_each` commitments put «what is a job» into every reader, and commitments and capacity lag 15 minutes behind acceptance. |
| Schedule fit with the running programmes | **5** — Its order A → B → C matches the survey's C7a → C6 → C7b, it never edits a hot money file, and it names exactly what each workflow waits for (Phase 6, P7, P10, C4, C5, P6/P9). | **3** — N1 refactors `marketplace.ts` and `communityOrderTimeline.ts` right after Phase 5 lands, N2 edits the accept batch beside P11, and the network ships before the floor it depends on. |
| **Total (of 40)** | **36** | **30** |

---

## Track — money (judged synthesis; the judge chose Proposal 2 (risk-first) as the spine)

# Money — the merged design (Programme C, track «money»)

**Spine:** Proposal 2 («risk-first»): escrow parts, one settlement function, red tests written first.

**Grafts from Proposal 1** («ledger-first»):
- options stored in the frozen offer revision;
- the earned deposit, and a production step that needs a customer act;
- net previews for the merchant, and the change-order screen anatomy;
- the read-side seams;
- gift money, realised profit and the wallet payout.

**Judge fixes:**
- cents computed once for the whole plan (0108's one-cent rule);
- the royalty carved in the pending bucket (no overdraw aborts);
- order-credit readers scoped to the seller;
- caps on parts per escrow and on group entries.

**Measured 2026-09-30** (dist 11:54, gzip-9):

| Budget | Now / limit |
|---|---|
| CSS | 60,964 / 61,440 B (476 B left) |
| Entry | 66.3 / 72 KB |
| Initial payload | 183.0 / 200 KB |
| Storefront closure | **46.6 / 47 KB** (P4/P5 grew it; ≈ 0.4 KB left) |
| Request | 40.3 KB |
| CustomOrderScreen | 3.1 KB |
| MerchantFinance | 9.3 KB |
| StoreCheckout | 8.2 KB |
| CommandCenter | 15.3 / 18 KB |

Next free migration ≥ 0162; next DECISIONS row ≥ 183.

## 1. Concept

Nothing new holds, moves or records money. The wallet hold, the escrow with its append-only events and the append-only merchant ledger remain the only three money objects. Programme C adds one primitive and one function on top of them:

- **The escrow part** — a slice of one community order's escrow, backed by exactly one wallet hold, written once and settled once.
- **`settleCommunityOrder`** — the one function that settles a community order. After the release/refund statement builders are refactored out of `worker/lib/escrowOps.ts` with byte-identical output, it is their only caller.

On that spine:

- **A payment plan** (up to four steps: عربون · design approved · production · delivery) is 2–4 parts written in the acceptance batch. Unreleased steps stay visibly *held* in the customer's wallet.
  - Money leaves a part only on a customer act (design or production approval, confirmation), the auto-confirm clock, a customer cancel of an earned deposit, or an admin.
  - A merchant act alone never pays, and an invited approver never pays.
- **A paid change or an extra revision** is one more part on the same order, with its own hold. **A price cut** is a credit applied at the final settlement. There is no hidden request and no second order.
- **Offer options** (Good value · Recommended · Best look) live in the offer's own `pricing_json`, frozen by the revision snapshot that offers already keep. The customer accepts one option by key and revision, and the server computes every total.
- **Store prices** come from one pure integer pricer in `packages/pricing`. The customize sheet runs it for display; the server runs it as the truth at add, quote and placement, under the v2 quote fingerprint and a pricing-version fence. When the server's figure differs from what was shown, the customer is told.
- **Royalties** use existing ledger kinds. They are carved from the seller's pending share at the sale (store) or from the delivery part (custom order), paid to the creator when the money becomes available, and clawed back (overdraw-exempt) when it is taken back.
- **A partner job** is an ordinary direct request, paid from the buying merchant's wallet at the network rate.
- **A group or event order** is one organizer checkout.

What each side sees:

- **The customer** sees one total, what is held and what is paid, and at most one decision at a time.
- **The merchant** sees net after commission and royalty, the steps, realised profit and a simulator.
- **No customer payload, screen or notification** ever carries cost, margin, floor, royalty, split or net.

Every leak in §7 is closed by a constraint, an in-batch fence or a server-minted key, and proven by a test written red before its feature. Everything ships dark behind one policy key and is switched on one capability group at a time.

### Money rules (each becomes a named node:test case)

1. **One escrow per order** (unchanged). A plan escrow's parent row has `hold_id NULL`, so every legacy release/refund path refuses it with WALLET_ERROR (escrowOps.ts:552, :689). Its gross, fee and receivable equal the sum of its step parts, fenced in the acceptance batch.
2. **One hold per part.** A plan's cents are computed once from its total (`walletSpendCents`) and split across the parts by largest remainder, so 0108's «at most one cent per order» still holds. A change part asks its own dinar question.
3. **Money leaves a part only inside `settleCommunityOrder`**, in one batch whose part flip requires all of:
   - the part is still `held`;
   - the parent escrow is `held` (`disputed` is allowed for an admin only);
   - the order is in the expected state;
   - the paying customer has approved the current version for that step;
   - for a non-admin, the merchant is not suspended.
4. **Credit only where the debit posted.** Every merchant credit and customer deposit carries `WHERE FUNDED_BY_HOLD(<the part's hold>)`. Each hold is committed at most once. Refunding an unreleased part releases its hold, with no currency conversion.
5. **Paid parts are final**, because no escrow claw-back path exists. A dispute freezes the parts still held and decides only them.
6. **Commission.**
   - The order's one split at acceptance is sliced across the steps by cumulative rounding, so the slices sum exactly to the fee.
   - Change parts pay the order's frozen rate, with no minimum fee.
   - On a partial outcome the commission is F5 on the order's total kept gross, less what earlier parts already charged, and never negative.
   - Commission is never refunded on an escrow.
7. **The delivery step** carries all of the offer's delivery fee and at least 30 % of the item price.
8. **Order terms are frozen.** Price, fee, receivable, commission rate and the money keys of `offer_snapshot` cannot change after insert (trigger). A price can change only through a change order.
9. **One pending change per order.** Delivery is refused while one is pending, and a dispute or cancel voids it in the same batch.
10. **Royalty.** It never changes the customer's total and never exceeds the share it comes from. It is never a negative line in a seller's *available* bucket, and it follows the money: paid when the money is available, clawed back when the money is taken back.
11. **Merchant-private money** (cost, royalty rule, partner price, net) lives only in merchant-only tables and payloads. `community_orders` gains no cost/margin/royalty/profit/partner column, and `pricing_snapshot` / `offer_snapshot` never carry any of these.
12. **Caps.** At most 4 step parts and 8 parts in all per escrow; at most 100 entries per group order.

## 2. Screens

### Anatomy rules (every screen)

- **Primitives only:**
  - Sheet v2 (drag handle, detents `medium`/`large`, header, footer; from `sm` up the same body in a centred `sm:max-w-md` window)
  - Segmented, Button/IconButton, DataList, Overlay, KpiTile
  - Skeleton/SkeletonGroup, EmptyState/ErrorState
  - Money, Note, Switch, NumberInput, Field/Textarea, useConfirm, Toast
- **Classes present in the built sheet** (checked against dist 11:54), and the only ones used:
  `lv-surface lv-section lv-card lv-choice lv-swatch lv-alert-{info,warning,success,danger} lv-field-error divide-y divide-border-subtle tabular-nums line-through h-1.5 rounded-full bg-gold bg-gold/10 ring-2 ring-gold text-{success,danger,warning,gold} bg-warning/10 border-warning/30 bg-surface-raised text-text-{muted,secondary} text-[12.5px] text-[13px] min-h-11 grid-cols-2 grid-cols-3 lg:grid lg:grid-cols-2 lg:grid-cols-3 lg:flex lg:items-start lg:gap-6 lg:sticky lg:top-6 lg:shrink-0 lg:max-w-5xl max-w-2xl sm:max-w-md w-72 ms-auto min-w-0 truncate whitespace-nowrap snap-x overflow-x-auto border-dashed border-s-2`
- **Classes absent and never used:** `lg:w-72 lg:w-80 w-80 lg:col-span-2 xl:max-w-6xl grid-cols-6 lv-chip top-6`.
  - A desktop side column is `w-72 shrink-0` inside a `useMediaQuery('(min-width: 1024px)')` branch.
  - One-off widths (the bar fill, an overlay) are inline styles, as Toast does.
  - **Target: 0 new CSS bytes.**
- **Figures and layout.** Every figure is `<Money iqd>` inside `<bdi>` with `tabular-nums`. Drawings are LTR for legibility; real rows are RTL, using logical utilities and theme tokens only.
- **Customer words** (ar): الإجمالي، محجوز، دُفع للورشة، الخطوة n من m، عربون، تغيير، هدية، خيار، رصيدك.
  - Never: ضمان/escrow, tranche, milestone, تكلفة، هامش، صافي، حق المصمم، شريك, receivable, hold.
  - Never any CAD, slicer or mesh word.
- **Merchant words:** خطة الدفع، الخطوات، لك، العمولة، حق المصمم، الربح.
- **Compactness:**
  - The personaliser stays Name · Look · Size · More · Add to cart (it is the templates track's sheet); money adds no control there.
  - The accept sheet has at most four controls, and the customer faces one decision at a time.
  - No new `data-request-section` (REQUEST_SECTIONS is pinned by tests/requestPageUi.test.ts). Money content lives inside the existing «escrow» section (Request.tsx:785).

### S1 · CUSTOMER · the price on the personaliser

The sheet is the templates track's; money owns the price label, the breakdown and the correction notice.

```
360
┌─ Customize (Sheet v2, templates track) ──────┐
│ [ live 3D preview ]                           │
│ Name    Look    Size    More                  │
├──────────────────────────────────────────────┤
│ [       Add to cart · 35,000 IQD          ]   │  the fifth control carries the live price
└──────────────────────────────────────────────┘
More › first row «What's in the price ›» → PriceBreakdown (lazy Overlay)
  │ Stand · Medium        20,000 │  divide-y; row words are the template's, never a rule key
  │ Magnet ×2              2,000 │
  │ RGB light              5,000 │
  │ Motor                  8,000 │
  │ Total                 35,000 │  font-semibold
After Add, when the server priced it differently (rules edited; a cached read up to ~12 min old):
  ┌ lv-alert-info ─────────────────────────┐
  │ The price is now 36,000 IQD.   [ OK ]  │  the cart line already carries 36,000
  └────────────────────────────────────────┘
```

- **A community template with no seller yet:** the label reads «About 30,000–38,000» (the Estimate contract range, DECISIONS 174) and the call to action becomes «Request printing». Workshops send exact prices.
- **1280:** the same footer inside the product page's `lg:flex` layout, with the controls `lg:sticky lg:top-6`. A price change cross-fades; it never counts up.

### S2 · CUSTOMER · offer card with options (OfferCompare)

```
360
┌ lv-surface ─────────────────────────────────┐
│ Al-Noor Workshop ★4.8 · 32 jobs              │
│ ┌ Segmented ─────────────────────────────┐  │  only when the offer carries options
│ │ Good value │ [Recommended] │ Best look  │  │  default = Recommended
│ └────────────────────────────────────────┘  │
│ Total 27,000 IQD                             │  server total for the chosen option
│ Ready in 4 days · PETG matte · 30-day warranty│
│ Paid in 2 steps ›                            │  only with a plan → PaymentPlanSheet (lazy)
│ [           Accept · 27,000            ]    │
└─────────────────────────────────────────────┘
```

- **1280:** the options become three `lv-choice` columns (`lg:grid lg:grid-cols-3`), with `aria-checked` on the chosen one.
- An offer without options renders exactly today's card.
- The collapsed board row reads «from 21,000» (`total_from_iqd`).

### S3 · CUSTOMER · accept sheet (at most four controls)

```
360
┌ Sheet v2 · detents [medium, large] ──────────┐
│ Accept Al-Noor's offer?                       │  header
│ Option        Recommended ›                   │  only with options (Segmented in place)
│ Address       Home · Karrada ›                │  existing select.lv-input
│ Gift          ( Switch )                      │  MW3; on → message ≤140 + «from» appear
│ How the workshop gets paid                    │  only for a plan of 2+ steps
│ 1  When you approve the design      8,100    │  divide-y
│ 2  When you receive it             18,900    │
│ ┌ lv-alert-info ──────────────────────────┐  │
│ │ All 27,000 is held from your balance now.│  │
│ │ Nothing reaches the workshop before your │  │
│ │ OK.                                      │  │
│ └──────────────────────────────────────────┘  │
│ (footer) [ Accept and hold 27,000 ]           │
└──────────────────────────────────────────────┘
```

- **INSUFFICIENT_FUNDS:** the footer becomes [ Top up · 27,000 needed ].
- **OFFER_CHANGED / OFFER_STALE:** keep today's `lv-alert-warning` + Refresh.
- **1280:** the same sheet as a centred window.

### S4 · BOTH · the money line, the plan sheet, the approval consequence

The money line sits inside the «escrow» section and is static in the Request chunk (≤ 0.8 KB).

```
360
│ The money                                      │
│ ▰▰▰▱▱▱▱▱▱▱  8,100 paid · 18,900 held            │  h-1.5 rounded-full bg-gold; fill = m.div scaleX
│ Step 1 of 2 · design approved ✓                 │  Sorani «هەنگاوی {n} لە {total}» already exists
│ Next: 18,900 when you receive it ›               │  → PaymentPlanSheet (lazy)
│ ┌ lv-alert-info ─────────────────────────────┐ │  only while a change is pending
│ │ Al-Noor proposes a change      [ Review ]   │ │
│ └────────────────────────────────────────────┘ │
PaymentPlanSheet (Sheet v2 [medium]) — DataList
│ Deposit (عربون)     5,400  held · the workshop keeps it only if you cancel after the first design │
│ Design approved    8,100  paid 12 Sep ✓                                                          │
│ Delivery          13,500  when you confirm, or 7 days after delivery                              │
│ Note: If you cancel now, 13,500 comes back to you.    ← refund_if_cancel_iqd, only while cancel is allowed
```

- **The bar fill** springs with `useMotion().SPRING.ui` under the Request page's existing `<MotionFeatures>` (Request.tsx:507), and becomes `CROSS_FADE` under reduced motion.
- **The approval sheet** belongs to the Project track; money adds one `lv-alert-info` line to it: «Approving pays Al-Noor 8,100. The other 18,900 stays held.» The approve body echoes `expected_release_iqd`.
- **The merchant** sees the same sheet with a «yours» column: net after commission and royalty.
- **1280:** the DataList renders inline in the section (no sheet). If the Project track gives the room a side column (`w-72`, `lg:sticky lg:top-6`), the section moves there.

### S5 · CUSTOMER · a proposed change (ChangeOrderSheet, lazy)

```
360
┌ Sheet v2 [medium] · «Al-Noor proposes a change» ┐
│ Bigger base for a 15 mm magnet                   │  summary
│ Before  Magnet 10 mm ×2              ~~1,500~~   │  line-through
│ After   Magnet 15 mm ×2                2,000     │
│ Price   +500 IQD · Ready +1 day                  │  text-danger (+) / text-success (−)
│ New total                             27,500     │  font-semibold
│ ┌ lv-alert-info ────────────────────────────┐   │
│ │ 500 more is held now and paid with the rest│   │
│ │ when you receive it.                        │   │
│ └────────────────────────────────────────────┘   │
│ Note: you will approve the new design after this. │  only when needs_new_approval
│ (footer) [ Approve and hold 500 ]  [ Keep as is ] │
└──────────────────────────────────────────────────┘
```

- **A negative change** reads «Price −2,000 · comes back to your balance when the order is done», and the primary button reads «Approve».
- **A zero change** reads «No change in price».
- **An extra revision** uses the same sheet: «One more revision · 5,000».
- **Opened from** the `change_order` notification or from the money line.

### S6 · MERCHANT · composer rows and OfferPricingSheet (lazy door in OfferComposer)

```
360
│ Price            [ 24,000 ] IQD                   │  existing
│ Delivery fee     [  3,000 ] IQD                   │  existing
│ Options & payment   Recommended only ›            │  → OfferPricingSheet
┌ Sheet v2 [large] · «Prices and options» ─────────┐
│ Segmented: [One price] │ Three options             │
│ Good value    18,000 · 5 d · PLA    yours 17,100 › │  row → price · days · material · finish · warranty · parts
│ Recommended ★ 24,000 · 4 d · PETG   yours 22,800 › │  exactly one recommended
│ Best look     30,000 · 4 d · Silk   yours 28,500 › │
│ Getting paid (•) All on delivery                   │  lv-choice radios, default
│              ( ) Design first 30 · 70              │  offered only when the job has a design stage
│              ( ) Deposit + design + delivery 20·30·50 │ design jobs above the policy minimum
│              ▸ Custom — 2 to 4 steps               │  Segmented (when) + NumberInput (10 % steps)
│ Revisions included [ 2 ]    Extra [ 5,000 ]         │  design jobs only
│ Parts: Magnet 10 mm ×2   [ Replace › ]              │  only when the request names parts; priced now from your catalogue
│ Design royalty 1,000 / piece (template «Hand stand»)│  template jobs only, read-only
│ (footer) [ Done ]                                    │
└─────────────────────────────────────────────────────┘
```

- **«yours»** is the net after commission and royalty, recomputed live from `GET /api/merchant/finance/fees` and the shared `offerPricing` module. It is never sent anywhere.
- **1280:** the three options sit side by side (`lg:grid lg:grid-cols-3`) with NumberInputs in place, and the plan presets become `lv-choice` cards.

### S7 · MERCHANT · money card and change composer (CustomOrderScreen, lazy doors)

At 360 this is the same DataList with two lines per row.

```
1280
┌ lv-surface · «The money» ───────────────────────────────────────────────────────┐
│ Total 27,500   Commission 1,375   Design royalty 1,000   Yours when done 25,125  │
│ Step              Amount   Commission   Yours    State                          │
│ Deposit            5,400      270       5,130    held · yours if the customer cancels after V1 │
│ Design approved    8,100      405       7,695    paid 12 Sep ✓                  │
│ Delivery          13,500      675      11,825    on confirmation (−1,000 royalty) │
│ Change +500 (magnet 15 mm)     25         475    held with the order            │
│ [ Propose a change ]     [ Ask a partner workshop › ]   ← the second door is the manufacturing track's │
└─────────────────────────────────────────────────────────────────────────────────┘
ChangeOrderComposer (Sheet v2 [large])
│ What changes      [ Textarea ≤ 300 ]                          │
│ Segmented: Same price │ [New total] │ Parts                     │
│ New total         [ 27,500 ]                                   │  NumberInput
│ The customer sees +500 · yours +475                             │  server delta; net via packages/pricing
│ Extra days (−) 1 (+)      Needs a new approval ( Switch )       │
│ (footer) [ Send to the customer ]                               │
```

- **Configured products:** instead of a new total, «Choose the new options ›» opens the personaliser in merchant mode, and the server computes the delta — nobody types it.
- **Access:** owner-only until P10 grants a finance capability.

### S8 · MERCHANT · profit simulator

Lazy, opened from a door in ProductEditorSheet «Pricing & stock» and a door in CostingTab. It arrives after P11's engine convergence.

```
360
┌ Sheet v2 [large] · «Profit on this product» ──┐
│ KpiTile ×4 (grid-cols-2): Cost 18,200 · Profit 12,050 · Margin 34 % · Lowest safe 21,500 │
│ Selling price [ 35,000 ]   Quantity [ 1 ]      │
│ Segmented: Store │ Custom order │ Partner job  │  fee kind store / request / network
│ Filament · 62 g silk PLA           2,480       │  engine lines, one server read
│ Printer time · 1 h 50              2,750       │
│ Magnets ×2 (your cost)             1,200       │
│ RGB light         not recorded        —        │  text-text-muted; never counted as 0
│ Packaging                            500       │
│ Levonis fee (5 % today)            1,750       │
│ Design royalty                     1,500       │
│ ⚠ Profit is under your 15 % minimum            │  lv-alert-warning, only when it applies
│ (footer) [ Use 35,000 as the price ]           │  existing product PATCH
```

- **1280:** `lg:flex lg:items-start lg:gap-6`, with the inputs in a `w-72` column and the tiles plus DataList beside them.
- **Recalculation** happens on every keystroke, client-side, from one server read.

### S9 · MERCHANT · finance additions (MerchantFinance; phones stack the rows)

```
│ Held for your custom orders          18,900 │  Σ unsettled parts (no longer the whole receivable)
│ Royalties paid (designs you print)   −6,000 │
│ Royalties earned (your designs)     +12,000 │  in − claw-backs
│ [ Profit › ]                                │  lazy ?view=profit: revenue (ledger) − recorded cost; «unknown» counted, never estimated as fact
```

### S10 · CUSTOMER · checkout gift (StoreCheckout row → GiftSheet, lazy; MW3)

```
360
│ … Delivery › · Coupon ›                          │
│ Gift ›                                           │  one row
┌ Sheet v2 [medium] · «Gift» ──────────────────────┐
│ Recipient  Sara · Zayouna ›  (address picker)     │  recipient = the chosen address (name + phone)
│ Message    [ Textarea ≤ 140 ]           90/140    │
│ From       [ Ali ]                                │
│ Gift wrap +2,500              ( Switch )          │  only if the store offers wrap
│ Note: no price appears in the parcel or for the recipient. │
│ (footer) [ Done ]                                  │
```

- **1280:** the same sheet; the totals column gains a wrap line that cross-fades in.
- **The custom-order accept sheet (S3)** gets the same Gift switch row.

### S11 · GROUP / EVENT ORDER (MW3)

```
360 participant — /g/:token (no balance asked)
│ Class 5-B stands · until Thu 9 Oct                │
│ [ the templates track's customize chunk, only the allowed controls ] │
│ Your name on it  [ Ali ]                           │
│ Colour  ● red  ○ blue  ○ black                     │  lv-swatch radios
│ [ Add my name ]                                     │
│ Paid by the organizer                               │  no price unless the organizer shows it
1280 organizer — /groups/:id
┌ Stands · Al-Noor · open until 3/11 · 23 of 30 ───────────────────────────────┐
│ [ Copy share link ]  [ Paste names ]                                          │
│ ┌ DataList ─────────────────────────┐ ┌ w-72 · lg:sticky lg:top-6 ────────┐  │
│ │ Ali · red                  [×]    │ │ 23 pieces                         │  │
│ │ Sara · blue                [×]    │ │ 23 × 4,000         92,000         │  │
│ │ …                                 │ │ [ Close and pay 92,000 ]          │  │
│ └───────────────────────────────────┘ └───────────────────────────────────┘  │
```

- **360 organizer:** the summary becomes a sticky footer inside the page's own scroll owner (no `fixed bottom-0`).
- **Empty state:** EmptyState «No names yet — share the link».

### S12 · ADMIN · escrow panel (lazy in AdminCommunity «disputes»)

```
1280
┌ Escrow esc_… · order cord_… · 27,500 · disputed ─────────────────────────────┐
│ DataList: step · gross · fee · state · settled_at; change parts listed below   │
│ Paid to the workshop already   8,100 (final)                                   │
│ Held                          19,400                                           │
│ Decide the 19,400: (•) workshop ( ) customer ( ) split [ 10,000 ] to workshop │  requireFinancialScope
└───────────────────────────────────────────────────────────────────────────────┘
```

## 3. Data model by role

### Principles

- Additive migrations only.
- Named by role and numbered at merge («next free»); `EXPECTED_MIGRATION` and its count move in the same commit.
- No new wallet, escrow, ledger kind, orders table or products table.
- No frozen CHECK is widened: new enumerations are TS-closed, or CHECKed only on new tables.
- Every new table gets one owner in `packages/contracts/src/ownership.ts`.
- Every new `_json` / `_snapshot` / `'{}'` / `'[]'` TEXT column is classified `NON_MEDIA` in `worker/lib/mediaRefs.ts` in the same phase.

### Reused verbatim

- **community_escrows (0031)** — amounts written once; one per order; `hold_id` nullable, and NULL on a plan escrow.
- **community_escrow_events** — existing kinds only; UNIQUE `idempotency_key`.
- **wallet_holds and the hold helpers:**
  - `kind 'purchase'`; the new `ref_type 'escrow_part'` is data, not DDL;
  - `commitHoldStatements` — one debit per hold, `wtx_hold_<hold>`;
  - `FUNDED_BY_HOLD`;
  - the partial-refund deposit pattern, now keyed per part.
- **merchant_ledger_entries (0121 kinds only)** — escrow_release/commission for parts; adjustment for royalty in/out; `refund` for the royalty claw-back, which is the kind the overdraw trigger exempts.
- **merchant_payouts + debtFence.**
- **Fee helpers** — `splitFee` / `feeFor` + `partialRefundCommission` (F5); `merchantSuspendedSql` (row 137).
- **Offers** — community_offers + `community_offer_revisions.terms` (frozen per revision); `community_offer_drafts.payload_json`.
- **community_orders** — no new state; the price identity CHECK; `offer_snapshot`.
- **order_items bundle columns (0058)** for zero-priced component children.
- **`orders.quote_fingerprint` v2.**
- **The 0140 pattern** — one pending proposal, frozen figures, decision_token.
- **0151 direct requests** — used for partner jobs.
- **Addresses** — name + phone = the gift recipient.

### Role `money_parts` (MW1)

**1. `community_escrow_parts`** — owner: marketplace.

Columns:
- `id` `'esp_…'`
- `escrow_id` → community_escrows NOT NULL
- `community_order_id` → community_orders NOT NULL
- `seq` INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 8)
- `kind` TEXT NOT NULL — `step | change | revision` (TS-closed)
- `release_on` TEXT NOT NULL — `deposit | design_approval | production | delivery` (TS-closed; change and revision parts use `delivery`)
- `gross_iqd` CHECK > 0
- `platform_fee_iqd` CHECK ≥ 0
- `merchant_receivable_iqd` CHECK ≥ 0
- `hold_id` TEXT NOT NULL UNIQUE → wallet_holds
- `state` CHECK IN (`held`, `released`, `refunded`, `partially_refunded`), default `held`
- `released_iqd`, `refunded_iqd` — default 0
- `earned_at` — deposit only; `due_at`; `settled_at`
- `source_id` — the change-order id; UNIQUE WHERE NOT NULL
- `created_at`

Constraints:
- UNIQUE (escrow_id, seq)
- CHECK (platform_fee_iqd + merchant_receivable_iqd = gross_iqd)
- CHECK (released_iqd + refunded_iqd ≤ gross_iqd)

Triggers:
- **amounts frozen** — any UPDATE of amounts, hold, keys, kind, release_on or source → RAISE `ESCROW_PART_IMMUTABLE`;
- **no delete**;
- **state machine** — `held → released | refunded | partially_refunded` only;
- **stamps** — `earned_at` and `due_at` are written once (NULL → value).

Invariants:
- A plan parent's gross/fee/receivable = Σ its step parts.
- The parent's released/refunded counters track step parts only; change and revision parts track themselves, so the parent CHECK always holds.
- ≤ 4 step parts; ≤ 8 parts in all.

**2. `community_escrow_events.part_id`** — `TEXT REFERENCES community_escrow_parts(id)`, NULL for legacy rows.
- Idempotency keys are `<event key>:p<seq>`.
- A part's `held` event records `rate=…;cents=…`, so `heldAtRate` works per part.

**3. `trg_co_money_frozen`** on community_orders.
- On UPDATE of `price_iqd`, `commission_percent_x100`, `platform_fee_iqd`, `merchant_receivable_iqd`, or of `json_extract(offer_snapshot, '$.price_iqd' | '$.delivery_fee_iqd' | '$.total_iqd' | '$.option' | '$.plan')`, it RAISEs `COMMUNITY_ORDER_TERMS_FROZEN`.
- request_snapshot and contact_snapshot are not frozen: 0134 legitimately redacted them.

### Role `deal_shapes` (MW2)

**4. `community_offers.pricing_json`** — `TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pricing_json))`.
- `recordOfferRevisionStatement` adds `'pricing', json(o.pricing_json)` to the revision terms.
- Drafts carry `pricing` in `payload_json`.
- `offerForAcceptance` already selects `o.*`, so no extra read wave is needed.

**5. `community_change_orders`** — owner: marketplace.

Columns:
- `id` `'cco_…'`
- `community_order_id` → community_orders
- `seq` INTEGER NOT NULL
- `kind` TEXT NOT NULL — `price | spec | parts | deadline | revision` (TS-closed)
- `proposed_by` → users
- `state` CHECK IN (`pending`, `approved`, `rejected`, `withdrawn`, `void`)
- `summary` CHECK (length BETWEEN 3 AND 300)
- `diff` TEXT NOT NULL DEFAULT '{}' CHECK (json_valid)
- `from_version_id`, `to_version_id` — the Project track's versions, nullable
- `priced_by` CHECK IN (`merchant`, `template`, `offer`)
- `old_total_iqd` CHECK > 0; `new_total_iqd` CHECK > 0
- `delta_iqd` CHECK (delta_iqd = new_total_iqd − old_total_iqd) — zero is allowed for a spec-only change
- `days_delta` CHECK (BETWEEN −60 AND 60)
- `needs_new_approval` CHECK IN (0, 1)
- `part_id` → community_escrow_parts — set on approval when Δ > 0
- `credit_iqd` CHECK ≥ 0 — set on approval when Δ < 0
- `decision_token`, `idempotency_key`
- `decided_by`, `decided_at`, `created_at`

Constraints:
- UNIQUE (community_order_id, seq)
- UNIQUE (community_order_id, idempotency_key)
- Partial UNIQUE index on (community_order_id) WHERE state = 'pending'

Trigger: figures, kind, priced_by and diff are immutable. `state`, `decided_*`, `part_id`, `credit_iqd` and `decision_token` may be written once, and only from `pending`.

**6. `trg_co_change_blocks_delivery`** on community_orders: BEFORE UPDATE OF state WHEN NEW.state = 'merchant_marked_delivered' AND a pending change exists → RAISE `CHANGE_ORDER_PENDING`. The dispute and cancel batches void a pending change themselves.

### Role `earnings_groups` (MW3)

**7. `sale_royalties`** — owner: marketplace.

Columns:
- `id` `'sry_…'`
- `subject_type` CHECK IN (`order_item`, `community_order`); `subject_id`
- `order_id` or `community_order_id`
- `seller_merchant_id`, `designer_merchant_id` — CHECK (designer ≠ seller)
- `design_ref`, `rule_version`
- `iqd_per_unit` > 0, `qty` > 0
- `royalty_iqd` CHECK (royalty_iqd = iqd_per_unit × qty)
- `created_at`

Constraints and triggers: UNIQUE (subject_type, subject_id); append-only trigger.

When it is written:
- in the store placement batch, or in the custom-order acceptance batch;
- from the licence revision pinned on the product or request — the licensing track owns rule versions and adoption pins; money owns this row, the caps and the ledger mapping.

It is never copied into `pricing_snapshot` or `offer_snapshot`.

**8. `merchant_cost_snapshots`** — owner: marketplace; merchant-private; not money.
- PRIMARY KEY (merchant_id, subject_type, subject_id, basis)
- `subject_type` CHECK IN (`product`, `order_item`, `community_order`)
- `basis` CHECK IN (`estimate`, `actual`)
- `cost_iqd` — NULL means unknown
- `breakdown` TEXT '[]'
- `engine_version`, `computed_at`

It is upserted, read by no customer route, and never written into `order_items.cost_iqd`: 0095 keeps merchant store lines `'unrecorded'` because that column is the platform's cost basis.

**9. `group_orders` + `group_order_entries`** — owner: commerce.

`group_orders`:
- `id` `'grp_…'`, `organizer_id`, `store_id`, `product_id`, `variant_id` NULL
- `mode` CHECK IN (`group`, `event`)
- `title` ≤ 80
- `allowed` TEXT, `locked` TEXT, `show_price` 0/1
- `deadline_at`
- `max_entries` CHECK (BETWEEN 2 AND 200) — policy default 100
- `share_token_hash` UNIQUE
- `state` CHECK IN (`open`, `closed`, `ordered`, `cancelled`) — «past the deadline» is derived; there is no cron
- `closed_hash`, `order_id`, `created_at`, `updated_at`

`group_order_entries`:
- `id` `'gre_…'`, `group_id`, `participant_user_id` NULL, `label` ≤ 40
- `configuration` TEXT, `config_hash`
- `state` CHECK IN (`active`, `removed`)
- `created_at`
- UNIQUE (group_id, participant_user_id) WHERE participant_user_id IS NOT NULL

**10. Gift columns.**
- `orders.gift_snapshot` TEXT NOT NULL DEFAULT '{}'
- `orders.gift_wrap_iqd` INTEGER NOT NULL DEFAULT 0 CHECK ≥ 0
- `community_orders.gift_snapshot` TEXT NOT NULL DEFAULT '{}'
- `merchant_stores.gift_wrap_iqd` INTEGER NULL CHECK (NULL OR 0..100,000) — NULL means wrap is not offered

### Settings (no migration)

`communityMoneyPolicy` is one structured key:
- It has a default in `SETTING_DEFAULTS`, with every flag false.
- It is written only through `PATCH /api/admin/community/settings`, behind `requireFinancialScope`, with a normaliser and an audit row.
- The generic `PUT /api/admin/settings/:key` refuses it, as it already refuses printerFarmConfig.

```json
{"flags":{"options":false,"plans":false,"deposit":false,"change_orders":false,"revisions":false,"royalties":false,
          "gift":false,"groups":false,"network":false,"wallet_payout":false,"profit":false},
 "plan":{"min_order_iqd":100000,"max_steps":4,"min_step_percent":10,"min_step_iqd":5000,"max_deposit_percent":30,"min_delivery_percent":30},
 "change":{"max_delta_multiple":2,"after_start":true},
 "revision":{"extra_max_iqd":100000},
 "royalty":{"max_iqd_per_unit":25000},
 "groups":{"max_entries":100,"guests":false}}
```

- `FEE_KEYS` gains `communityFeeNetworkPercentX100` (the owner decides the default).
- Merchants read the flags as `/api/merchant/me.can.*`; customers learn them only through payloads.

### JSON shapes

**A. `community_offers.pricing_json`** (stored; normalised by `readOfferPricing`)

```json
{"v":1,
 "options":[{"key":"good_value","price_iqd":18000,"delivery_fee_iqd":3000,"completion_days":5,"material_ids":["pla"],"finish":"classic","warranty_days":0,"parts":[]},
            {"key":"recommended","price_iqd":24000,"delivery_fee_iqd":3000,"completion_days":4,"material_ids":["petg"],"finish":"matte","warranty_days":30,
             "parts":[{"slot":"magnet","variant_id":"cpv_b","qty":2,"unit_iqd":1000,"replaces":{"variant_id":"cpv_a","unit_iqd":750}}]},
            {"key":"best_look","price_iqd":30000,"delivery_fee_iqd":3000,"completion_days":4,"material_ids":["pla-silk"],"finish":"silk","warranty_days":90,"parts":[]}],
 "plan":[{"release_on":"design_approval","pct":30},{"release_on":"delivery","pct":70}],
 "revisions":{"included":2,"extra_iqd":5000}}
```

- `unit_iqd` is written by the server from the catalogue at write time.
- The offer row's `price_iqd` / `delivery_fee_iqd` mirror the recommended option.

**Public projection** (what a customer reads):
- `options[{key, total_iqd, price_iqd, delivery_fee_iqd, parts_iqd, completion_days, materials[{id,name}], finish, warranty_days, parts[{slot, name, qty, line_iqd, replaces{name, line_iqd}, delta_iqd}], steps[{seq, release_on, iqd}]}]`
- `total_from_iqd`
- `revisions{included, extra_iqd}`

It never carries royalty, net, cost or a hold id. The merchant's own offer additionally carries `net_iqd` per option.

**B. Plan allocation** (`allocateSteps`, `splitCents`)
- Item price P = option price + Σ part lines; delivery fee D; G = P + D.
- One split `F = feeFor(kind, G)` at acceptance.
- Non-final steps: `g_i = ⌊P·pct_i/100⌋`. The delivery step: `g_last = P − Σ g_i + D`.
- Fees: `f_i = ⌊F·C_i/G⌋ − ⌊F·C_{i−1}/G⌋`, where C is the cumulative gross.
- Cents: `c = walletSpendCents(G, available, rate)`; each `c_i` is the largest-remainder share of `c·g_i/G`, every `c_i ≥ 1`.
- Worked example: 100,000 + 5,000 at 5 % → F = 5,250 → parts 30,000 (fee 1,500) and 75,000 (fee 3,750).

**C. Configured price rules** (stored by the templates track with the template version; money prices them)

```json
{"v":1,"size":{"small":0,"medium":0,"large":7000},"finish":{"classic":0,"matte":0,"silk":2000},
 "tier":{"good_value":0,"best_look":4000},
 "features":{"second_name":1500,"logo":3000,"photo":4000,"qr":1000,"nfc":6000},
 "text":{"free_chars":8,"per_char_iqd":250,"max_extra_iqd":3000},
 "colors":{"included":2,"each":1000,"max":6},
 "slots":{"magnet":{"required":true,"qty":2,"allow":["cp_m10:cpv_a","cp_m15:cpv_b"]},
          "light":{"required":false,"qty":1,"allow":["cp_led:cpv_w","cp_led:cpv_rgb"]}}}
```

- Every modifier is a non-negative table lookup. There are no percentages and no per-mm formulas in v1.
- Slot prices are the linked part's live catalogue price (same seller in v1).
- Pricer output: `{unit_iqd, price_parts[{key, iqd, variant_id?, qty?}], pricing_version, config_hash}`. The key is never named `lines`, which is a forbidden Estimate fragment.

**D. Gift snapshot:** `{"v":1,"message":"≤140","from_name":"≤40","wrap":true,"wrap_iqd":2500}`. Hiding the price from the recipient is implied; there is no toggle.

**E. Change diff:** `{"v":1,"from":{"version_id"?,"config_hash"?,"total_iqd"},"to":{…},"parts":[{"key":"slot:magnet","from_iqd":1500,"to_iqd":2000}],"note"?}`

**F. Group fields:**
- `allowed`: `{"v":1,"fields":{"region:name.text":{"max_len":12},"region:body.color":{"allow":["red","blue","black"]}}}`
- `locked`: `{"size":"medium","finish":"matte"}`

**G. Cost breakdown** (merchant only): `[{"key":"filament","iqd":2480,"basis":"engine"},{"key":"part:light","iqd":null,"basis":"not_recorded"},{"key":"platform_fee","iqd":1750,"basis":"today_rate"},{"key":"royalty","iqd":1500,"basis":"pinned_rule"}]`

**H. Order read `money` block:**
- `total_iqd` = price + approved change parts − credits
- `steps[{seq, release_on, amount_iqd, state (held|due|paid|returned|part_returned), due_at, settled_at, earned, net_iqd (merchant only)}]`
- `changes[{id, kind, state, delta_iqd, days_delta, summary, needs_new_approval}]`
- `paid_iqd`, `held_iqd`, `returned_iqd`, `credit_iqd`
- `refund_if_cancel_iqd` — customer only, while cancel is allowed
- `revisions{included, used, purchased, remaining, extra_iqd}`
- `promised_days`

### Pure arithmetic (`packages/pricing/src`)

No I/O, no clock, closed refusal unions (the `priceAdjustment.ts` precedent). The Worker and the client import the same files.

| File | Exports |
|---|---|
| `escrowPlan.ts` | `validatePlan`, `allocateSteps`, `splitCents`, `settleOutcome`, `royaltyCarve` |
| `offerPricing.ts` | `readOfferPricing`, `publicOfferPricing`, `optionTotal`, `netForMerchant` |
| `changeOrder.ts` | `agreedTotal`, `changeDelta`, `creditBound` |
| `configured.ts` | `priceConfiguration`, `minimumReachableUnit`, `configHash` |
| `royalty.ts` | `royaltyFor`, `capRoyalty` |
| `profit.ts` | `simulateProfit` |

### Ledger mapping (every line is `WHERE FUNDED_BY_HOLD(<the part's hold>)` unless stated)

| Event | Lines | Event keys |
|---|---|---|
| Part released | lead `escrow_release` +(g − r), available; lead `commission` −f; creator `adjustment` +r, available (delivery part only; no order or escrow link, so the creator's link never opens the lead's order) | `escrow:<esc>:p<seq>:release:{gross,commission}`, `royalty:<sry>:in` |
| Part partially refunded | commit the hold; deposit `wtx_escrow_refund_<part>` to the customer; lead `escrow_release` +kept; `commission` −(F5 target − already charged) | `escrow:<esc>:p<seq>:partial:*` |
| Unreleased part refunded | release its hold; no ledger line | refund event `…:p<seq>` |
| Legacy escrow (no parts) | today's statements byte for byte | `escrow:<esc>:{release,partial}:*` |
| Store sale placed | `storeSaleLedgerStatements` + seller `adjustment` −R, **pending**, with order_id | `sale:<order>:*`, `royalty:<sry>:out` |
| Store credit released (receipt `storeOrderOps.ts:558`, 3-day sweep `:670`) | the release moves the pending net (already less R); then creator `adjustment` +R, available, with order_id | `release:<order>:*`, `royalty:<sry>:in` |
| Store credit reversed after release (`cancelStoreOrder` `:463`, `creditTakeBack` `:992` / `:1050`) | `reverseOrderCreditStatement` nets the seller to 0, carve included; creator `refund` −R with order_id (overdraw-exempt, so a customer refund never waits on a creator) | `reversal:<order>:*`, `royalty:<sry>:clawback` |
| `levo_wallet` payout | the four payout legs + a system deposit | `payout:*`, `wtx_payout_<payout>` |

- **Store royalty:** the seller's carve sits in *pending*, so a release for a seller in debt can never abort on `LEDGER_BUCKET_OVERDRAWN`.
- **Custom-order royalty:** carved by reducing the lead's gross line, so no negative line ever enters the lead's *available* bucket.
- **Parity (named test):** Σ royalty out = Σ royalty in − Σ claw-back.

## 4. API

### Conventions

- **Responses.** Every money route is session-bound and answers `private, no-store`. Only the parties may call it; anyone else gets 404.
- **Edge cache.** The only edge-cached money inputs are public price inputs inside existing `anonymousCached` reads with declared params — the template price rules and part prices inside the storefront product read. A rules edit purges `/api/storefront/:slug/products/:productSlug` explicitly, because that path is not in `storefrontPaths` (edgePolicy.ts:276).
- **Community gate.**
  - In-flight trade (settlement, approvals, change orders, revisions) sits outside the community wall, like today's lifecycle routes (communityGate.ts:160-170).
  - Routes that start trade (offers, partner requests) keep `requireCommunityOpen`.
  - Store trade (cart, checkout, groups) sits outside the wall.
- **Who may move money.** Only four doors:
  - the payer's own routes;
  - merchant routes behind `requireStoreOwner` — never P10 staff access;
  - the system sweeps;
  - admin routes behind `requireFinancialScope`.
  Every route is classified *moves / shows / none* in `tests/moneyRouteClass.test.ts`.
- **What the client sends.** The client never sends a price, margin, royalty, payee, customer_id or merchant_id. It sends ids and echo-only `expected_*` figures; a mismatch is a refusal, never a charge.

### A. The settlement seam — `settleCommunityOrder(env, {orderId, event, actor, key})` (worker/lib/orderSettlement.ts)

**Events:** `due(seq)` · `confirm` · `auto_complete` · `cancel(by)` · `admin(release | refund | split merchant_iqd)`.

**Wave 1** is one SELECT returning:
- the order and the escrow;
- the parts (`json_group_array`);
- the approval rows for due steps and the suspension state;
- the approved credits and the royalty row.

**Then one batch:**
1. The parent flip, fenced on state (non-admin: `held`), on the order-state guard and on the stamp fence.
2. For each part:
   - the flip `WHERE state='held'` + the approval guard + the suspension guard;
   - the per-hold builders — commit and debit for a release, release the hold for a refund, commit + deposit for a partial;
   - the ledger lines;
   - an event carrying `part_id`.
3. The credits.
4. The royalty lines.
5. The caller's `alsoWrite`.

There is one internal re-read retry after a part-state conflict (an approval racing a confirm).

**Outcomes (from the pure `settleOutcome`):**

| Event | What happens |
|---|---|
| `due` | Releases that part in full. |
| `confirm` / `auto_complete` | Releases every unsettled part. Credits become partial refunds taken from the delivery part first, then from change parts, newest first. Commission = F5 on the total kept − already charged. The royalty is taken on the delivery part's kept share. |
| `cancel` by the customer | An earned deposit is released; every other unsettled part is refunded (its hold released). |
| `cancel` by the merchant | Every unsettled part is refunded. |
| `admin` | Acts on the unsettled remainder only (release, refund, or split). |

**Parent escrow:** it becomes `released`, `refunded` or `partially_refunded` once every step part has settled; until then it stays `held`/`disputed`.

**Legacy escrows** (a parent hold, no parts) go through the wrapper paths with byte-identical statements, guarded by a golden test.

**Callers moved to the seam:**
- `marketplace.ts` — confirm, cancel, dispute;
- `communityRequests.ts` — auto-complete, plus the new steps `reconcilePartHolds` and `sweepDueParts` (skips disputed and suspended; LIMIT 50);
- `adminCommunity.ts` — resolve.

**Source scan:** only `escrowOps.ts` and `orderSettlement.ts` call the release/refund builders or write parts.

### B. Offers and acceptance (worker/routes/marketplace.ts; existing routes, one new body key)

**`POST /requests/:id/offers` · `PATCH /offers/:id` · `PUT` draft · `POST /offers/:id/send`**

`body.pricing` → `readOfferPricing`, then the server checks:
- material ids are in the catalogue;
- parts are the merchant's own eligible, active parts, priced now;
- the royalty comes from the request's pinned licence and is ≤ the share;
- the plan satisfies the policy and the job's design/production stages (the Project track's facts).

The result is written to `pricing_json`. Any change bumps the revision (existing behaviour), and the revision terms carry the pricing.

Merchant refusals (through `merchant/shell/refusal.ts`):
- `OFFER_OPTIONS_INVALID{reason: count|recommended|price|materials}`
- `PAYMENT_PLAN_INVALID{reason}`
- `PAYMENT_PLAN_DISABLED`
- `PAYMENT_PLAN_TOO_SMALL{min_iqd}`
- `ROYALTY_EXCEEDS_SHARE{royalty_iqd, share_iqd}`
- `EXTRA_REVISION_PRICE_INVALID{max_iqd}`

**`GET /requests/:id/offers`** — `offerShape` + the public `pricing` projection + `total_from_iqd`. The merchant's own offer also carries `net_iqd` per option.

**`GET /api/merchant/finance/fees`** (requireStoreOwner) → `{store_pct_x100, request_pct_x100, network_pct_x100, min_iqd}`, for the live «yours» previews.

**`POST /offers/:id/accept`** — body `{option?, expected_total_iqd, offer_revision, address_id?, gift?}`.
- `option` is required if and only if the offer has options.
- total = option price + parts + option delivery fee, with one split (`'request'`, or `'network'` for a partner job).
- **A plan of 2+ steps:**
  1. `allocateSteps` + `splitCents`.
  2. ONE hold batch: N × `holdInsertStatement` (ref_type `'escrow_part'`, keys `escrow:accept:<order>:p<seq>`) plus a count fence.
  3. The existing acceptance batch, plus the escrow row (`hold_id NULL`), the parts, a Σ fence, and the offer freeze — which is also fenced on `pricing_json = ?` (the exact bytes priced).
  4. `offer_snapshot{option, options_offered, plan, revisions, parts}`; the royalty snapshot and the gift are added in MW3.
  5. The landing check reads the escrow by order id. On failure, `releasePartReservation` releases every hold that no part names; a crash is caught by `reconcilePartHolds` after 16 minutes.
- **Without a plan:** exactly today's path.
- **Waves:** reads ∥ → hold batch → acceptance batch. Rate limit: the existing 20/h.
- **Customer refusals:**
  - new: `OFFER_OPTION_REQUIRED`, `OFFER_OPTION_INVALID`;
  - existing: `OFFER_CHANGED`, `OFFER_STALE`, `INSUFFICIENT_FUNDS{required_iqd}`.

### C. Steps becoming due

There is no new public route. One statement from `worker/lib/escrowParts.ts` is appended to the batch that triggers it, and the settlement runs after the response (waitUntil), retried by `sweepDueParts`.

- **The Project track's approval route** (paying customer only):
  - kind `design` → `markPartDue('design_approval')`;
  - kind `production` records the production approval.
  The body echoes `expected_release_iqd`; a mismatch returns `APPROVAL_RELEASE_CHANGED`.
- **The Project track's version submit:** the first merchant version → `markPartEarned('deposit')`.
- **`POST /orders/:id/start`:** `markPartDue('production')`, fenced on an existing customer production approval, inside the start UPDATE's batch.
- **confirm / auto-complete** → settle; **cancel** → settle cancel; **dispute** → the parent goes `disputed` and a pending change is voided in the same batch.
- **Idempotency keys:** `due:<part>`, `confirm:<order>`, `cancel:<order>`, `admin:<decision>:<escrow>`.

### D. Change orders and paid revisions (NEW `worker/routes/communityChangeOrders.ts`, under /api/marketplace)

**`POST /orders/:id/change-orders`** — the order's owner; 30/h.
- Body: `{kind, summary, diff, to{configuration? | parts? | total_iqd?}, days_delta, needs_new_approval, idempotency_key}`.
- The server computes:
  - old = `agreedTotal` = price + approved change parts − credits;
  - new and the delta — from the pricer diff for a configured product, the catalogue diff for parts, or the merchant's new total for custom work;
  - the credit bound; and it checks |Δ| ≤ 2 × the order price.
- Requires: the order is `funded` / `in_progress`, the escrow is `held`, and the policy flag is on.
- Refusals: `CHANGE_ORDER_PENDING{id}`, `CHANGE_ORDER_NOT_ALLOWED{state}`, `CHANGE_ORDER_DELTA_INVALID{max_iqd}`, `CHANGE_ORDER_EXCEEDS_HELD`, `ORDER_CHANGED`.

**`GET /orders/:id/change-orders`** — both parties.

**`POST /change-orders/:id/approve`** — the payer; 60/h; body `{expected_delta_iqd, seq}`.
- **Δ > 0:**
  1. Reserve a part hold — its own dinar question; ref_type `'escrow_part'`; key `escrow:co:<cco>`.
  2. ONE batch: the change is approved, fenced on pending + `decision_token` + the expected delta + the order state; the part is inserted with fee `⌊Δ·pct/10000⌋` (no minimum); an event is written.
  3. On failure, the hold is released unless a part names it.
- **Δ < 0:** approved, with `credit_iqd` ≤ the unsettled parts − earlier credits.
- **Δ = 0:** approved.
- Refusals: `CHANGE_ORDER_NOT_PENDING`, `CHANGE_ORDER_CHANGED`, `INSUFFICIENT_FUNDS{required_iqd}`, `ORDER_CHANGED`.

**`POST /change-orders/:id/reject`** (payer) · **`POST /change-orders/:id/withdraw`** (merchant).

**`POST /orders/:id/revisions/extra`** — the payer; body `{expected_iqd}`. Creates a `revision` change priced from the frozen offer (`priced_by 'offer'`) and approves it through the same path. Refusal: `REVISION_BUDGET_USED{extra_iqd|null}`.

**Revision budget guard** in the Project track's version-submit route: merchant versions after V1 must be ≤ included + purchased, otherwise `REVISION_BUDGET_EXCEEDED` (merchant). Clarifications are comments, and comments never count.

**Where changes surface:**
- one notification kind, `change_order` (user_notifications, and merchantNotify under KIND_PREF new_orders), with an event key per change and state;
- the order timeline merges change rows — no new update kind, because that CHECK is frozen.

### E. Order read

`GET /orders/:id` and `GET /orders/:id/timeline` gain the `money` block (shape H) in their existing first wave. The legacy `escrow` block stays for older clients.

### F. Admin (adminCommunity.ts; `requireFinancialScope` for everything that moves money)

- **`GET /escrows/:id`** — the parts, changes, credits and royalty.
- **`POST /escrows/:id/resolve`** — `release | refund | partial_refund | split{merchant_iqd ≤ unsettled}`, acting only on the unsettled remainder; paid parts are final. Classified `guard` in tests/communityMoneyScope.test.ts.
- **`PATCH /settings`** — the `communityMoneyPolicy` normaliser + `communityFeeNetworkPercentX100`, audited.

### G. Store money

Ownership is split three ways:
- **The templates track** owns configuration identity (cart_items), the normaliser, rules storage and the configured branch of `resolveCatalogLine`.
- **The components track** owns slots, eligibility and stock.
- **Money** owns the arithmetic, the fences, royalties and gift.

Routes:

- **Storefront product read** (`anonymousCached`, no new params) carries:
  - `customization.price_rules` and the slot options with public part prices;
  - `in_stock` booleans (never counts);
  - `pricing_version`.
- **`POST /api/cart/merchant-items`** `{productId, variantId?, qty, configuration, shown_unit_iqd?}` and **`PATCH …/:id`** `{qty?, configuration?}`:
  - the line is normalised and then priced by `priceConfiguration` on the server;
  - the response line carries `{unit_price_iqd, price_parts, pricing_version, price_changed?{from,to}}`.
- **`POST /api/store-orders/quote` and `POST /api/store-orders`** keep their surface. Inside:
  - the fingerprint v2 is unchanged: it already covers the unit and `color_id`, the config-hash carrier;
  - an in-batch `pricing_version` NOT-NULL fence → `CART_CHANGED`;
  - component children are zero-priced (`component_alloc_iqd`), and child rows get no file grants;
  - gift `{on, message, from_name, wrap}` → `gift_snapshot` + `gift_wrap_iqd`; the fingerprint gains a top-level gift key only when it is non-zero;
  - `sale_royalties` INSERT…SELECT + the seller's pending carve;
  - a `merchant_cost_snapshots` estimate is upserted.
  D1 waves are unchanged: rules and part rows join the existing line SELECT.
- **Release and reversal sites** write the royalty in-lines and claw-backs (ledger table above).
- **`PATCH /api/merchant/store`** gains `gift_wrap_iqd` (owner).
- **Refusals:**
  - new: `GIFT_MESSAGE_INVALID{reason: too_long|indecent|link}`, `GIFT_WRAP_UNAVAILABLE`;
  - existing: `CART_CHANGED`, `QUOTE_CHANGED`, `OUT_OF_STOCK`;
  - configuration and component codes belong to their tracks.

### H. Group and event orders (NEW `worker/routes/groupOrders.ts` at /api/group-orders; commerce; outside the wall)

- **`POST /`** — organizer; requireAuth; 10/day.
  - Body: `{product_id, mode, title, allowed, locked, deadline_at ≤ 60 d, max_entries ≤ policy cap, show_price}` → `{id, share_url}`.
  - The product must be a published customizable product of a store taking orders; the organizer may not be the store owner (`OWN_STORE_PURCHASE`).
- **`GET /t/:token`** — participant; `private, no-store`; 60/min per IP. The token never enters an edge key. Returns the title, store, allowed fields, deadline, count, and the price only if `show_price`.
- **`POST /t/:token/entries`** — requireAuth unless `policy.groups.guests`; 30 per 10 min.
  - Body: `{label ≤ 40 (decency filter), configuration}`.
  - The cap and the deadline are checked inside the INSERT.
- **`DELETE /:id/entries/:entryId`** — the entry's own participant or the organizer.
- **`GET /:id`** — organizer; entries + the server-priced total.
- **`POST /:id/entries/bulk`** — ≤ 100 names; 10/h.
- **`POST /:id/close`** — one batch writes the organizer's cart lines (identical configurations merged into qty; the `CART_SELLER_CONFLICT` confirm flow is reused) and stamps `closed_hash`; checkout is then the normal quote/place.
- **`POST /:id/reopen`** — deletes those cart lines; refused once an order line carries the group.
- **Refusals:** `GROUP_CLOSED`, `GROUP_FULL`, `GROUP_FIELD_NOT_ALLOWED{field}`, `GROUP_ORDERED`, `GROUP_EMPTY`; an unknown token answers 404.

### I. Network and payouts

**Accept door:**
- `FeeKind 'network'` (the network rate, no minimum) is decided by the server when the accepted request is a partner job, identified by the manufacturing track's link row.
- `OWN_REQUEST` when the buying merchant and the partner are the same.
- `completionStatements` skip partner jobs, so reputation cannot be farmed through them.

**`POST /api/merchant/payouts`** with channel `levo_wallet` — owner; `policy.wallet_payout`; 10/h.
- ONE batch: debt fence, suspension fence, payout `requested → approved → paid` legs, and a system deposit `wtx_payout_<payout>` into the owner's wallet.
- Refusals: `PAYOUT_CHANNEL_DISABLED` (new); `MERCHANT_IN_DEBT`, `MERCHANT_SUSPENDED`, `STORE_SUSPENDED` (existing).

### J. Profit (NEW `worker/routes/merchantProfit.ts` under /api/merchant)

`requireStoreOwner` + the analytics entitlement. It writes nothing except cost snapshots.

- **`POST /products/:id/profit`** `{price_iqd?, qty?, channel}` — 60/min.
  - Combines engine B `priceJob` over the recipe (after P11), the recorded part costs, `feeFor` at today's rate, and the pinned royalty.
  - Returns `{cost_iqd|null, profit_iqd|null, margin_x100|null, lowest_price_iqd, breakdown[], basis}`.
- **`PUT /costs/:type/:id`** `{actual_iqd}` — writes a `basis 'actual'` cost.
- **`GET /finance/profit?from&to&cursor`** — rows `{order, kind, revenue_iqd, commission_iqd, royalty_iqd, partner_cost_iqd, cost_iqd|null, profit_iqd|null}`, plus totals over the known rows and an unknown count. Revenue comes from the ledger. Exact cursor (limit+1); ≤ 366 Baghdad days.
- **`GET /finance/summary`** gains `royalties_in`, `royalties_out`, and `escrow_held` computed over the parts.

### K. Refusal plumbing

- **Customer-facing codes** go into `src/lib/refusalStrings.ts` with ar/en/ckb (ckb ≠ ar ≠ en). Each emitting file is appended to the `sources` list of tests/refusalStrings.test.ts, and each new customer door to `DOORS`. The sentences load lazily on the first refusal.
- **Merchant-facing codes** go through `merchant/shell/refusal.ts`.

## 5. Client

### Chunks and budgets (gzip-9; each new chunk pinned in tests/bundleBudget.test.ts as a chunk of its own)

Nothing money-related goes static into the entry, the initial payload, the storefront closure, the workspace shell or CommandCenter.

| Chunk | Where | Budget |
|---|---|---|
| `community/money/PaymentLine` | static in Request | ≤ 0.8 KB |
| `community/money/OfferMoney` (option row/columns, plan block, gift fields) | lazy; loaded only when an offer carries pricing | ≤ 3 KB |
| `community/money/PaymentPlanSheet` | lazy | ≤ 2.5 KB |
| `community/money/ChangeOrderSheet` | lazy | ≤ 3 KB |
| `merchant/money/OfferPricingSheet` | lazy door in OfferComposer | ≤ 6 KB |
| `merchant/money/OrderMoneyCard` | lazy door in CustomOrderScreen | ≤ 3.5 KB |
| `merchant/money/ChangeOrderComposer` | lazy door in CustomOrderScreen | ≤ 3.5 KB |
| `merchant/money/ProfitSimulator` | lazy doors in ProductEditorSheet and CostingTab | ≤ 6 KB |
| `merchant/money/ProfitReport` | lazy view in MerchantFinance | ≤ 5 KB |
| `merchant/money/RoyaltiesCard` | lazy in MerchantFinance | ≤ 2 KB |
| `storefront/checkout/GiftSheet` | lazy from StoreCheckout | ≤ 2.5 KB |
| `pages/GroupOrder` | route `/g/:token`; reuses the templates track's customize chunk | ≤ 6 KB |
| `storefront/group/GroupManage` | route `/groups/:id` | ≤ 6 KB |
| `storefront/group/GroupOrderSheet` | lazy | ≤ 3 KB |
| `adminCommunity/EscrowPlanPanel` | lazy in the disputes tab | ≤ 4 KB |
| `PriceBreakdown` + `packages/pricing/src/configured.ts` | inside the templates track's customize chunk | ≤ 1 KB + ≤ 1.5 KB |

**Static growth allowed on existing chunks:**

| Chunk | Allowed growth |
|---|---|
| Request (PaymentLine + dynamic-import doors) | ≤ +1.0 KB |
| OrderTimeline (step and change labels) | ≤ +0.5 KB |
| MerchantFinance | ≤ +0.4 KB |
| CustomOrderScreen | ≤ +0.3 KB |
| StoreCheckout | ≤ +0.3 KB |
| ProductEditorSheet | ≤ +0.2 KB |
| CostingTab | ≤ +0.2 KB |
| AdminCommunity | ≤ +0.2 KB |

**Must stay byte-identical from money:**
- the storefront closure (46.6 / 47 KB);
- the workspace shell and closure;
- CommandCenter (15.3 / 18 KB).

**CSS:** zero new utility classes by construction. Every workflow gate asserts total CSS ≤ the previous phase's measured figure (60,964 B today). If a builder needs a class that is absent, the phase pays for it first by retiring SalesTabs.OrdersTab (the row-176 debt) — never by raising the budget.

### API clients

- `src/components/community/requests/api.ts` gains the `pricing`, `money` and change-order types.
- NEW `src/components/community/money/api.ts` and `src/components/merchant/money/api.ts` — fees, change orders, profit, royalties.
- NEW `src/lib/groupOrders.ts`.

### Strings — real Sorani (D6; row 169 assumed approved for merchant and storefront files)

**Strings files:**
- `src/components/community/money/strings.ts` — customer: options, steps, deposit sentence, held/paid, change, revisions, gift.
- `src/components/merchant/money/strings.ts` — merchant: pricing sheet, plan, net, change composer, royalties, profit, simulator.
- `src/components/storefront/group/strings.ts`, `src/components/storefront/checkout/giftStrings.ts`.
- Refusal sentences in `src/lib/refusalStrings.ts`.

**Tests, one per strings file** (copying the workspaceUi/ordersListUi regime) — `moneyCustomerUi`, `moneyMerchantUi`, `groupOrderUi`, `giftMode`. Each checks:
- key parity across ar/en/ckb, with ckb ≠ ar ≠ en;
- ≥ 90 % of ckb values contain Kurdish letters;
- no `OWNER` marker;
- tokens only; no `dark:`; no native dialogs.

**Sorani seed words** already hand-written in src/: پارەکە، ڕاگیراوە، کۆی گشتی، نرخ، باڵانس، گەڕێندرایەوە، بەستراوە، ناکۆکی، «هەنگاوی {n} لە {total}»، گۆڕانکاری، پەسەندکراوە، وەشان، تێچوو، قازانج، داشکاندن، پارەدان، ئازادکراو. New words (عربون, change order) are written by the phase's Sorani writer — never invented in shared primitives or the shell.

**Vocabulary tests:**
- `tests/customerMoneyWords.test.ts` walks every customer money and group strings file and the new refusal sentences in all three languages, forbidding the money words listed in the anatomy rules and CAD/slicer words. This closes gap G1 for money.
- `tests/moneyVocabularyLeak.test.ts` JSON-scans every customer money payload for `cost_ | floor_ | margin_ | lines | royalty | payee | split | net_ | profit | unit_cost`.

### Motion, states, accessibility

**Motion:**
- No new springs or durations: sheets use Sheet v2's own springs.
- The bar fill is `m.div` scaleX with `SPRING.ui` under Request's `<MotionFeatures>`.
- Prices cross-fade; they never count up. Under reduced motion everything is `CROSS_FADE`.
- No motion features enter the storefront or the workspace shell.

**States:**
- A Skeleton shows in the escrow section while the money block loads.
- Refusals are decoded with `apiRefusal` / `refusalText`.
  - `OFFER_CHANGED` shows the fresh terms from the refusal itself.
  - `CHANGE_ORDER_CHANGED` re-reads the change.
  - `INSUFFICIENT_FUNDS` shows the existing top-up link with the required amount.
- A group with no names shows an EmptyState; the profit sheet uses an ErrorState with Retry.
- Buttons are disabled with a reason, never hidden.

**Accessibility:**
- Steps and changes use DataList semantics; targets are 44 px.
- The Segmented options carry their price in the accessible name («Best look, 30,000 IQD»).
- Focus returns to the money line after a sheet closes.

### Acceptance (Playwright — the stated bar)

The full matrix: 360/1280 × ar/en/ckb × dark/cream × reduced motion on AND off.

| Script | Fixture | Checks |
|---|---|---|
| `scripts/e2e-deal-money.mjs` | `tests/browser/deal-money.{html,-fixture.tsx}` | choosing an option changes the accept total; plan steps show; accept; approving a design shows «8,100 paid»; approve and decline a change; extra revision; refund-if-cancel line |
| `scripts/e2e-store-money.mjs` | yes | configured price correction notice; gift sheet; the packing slip stays price-free; royalty invisible to the customer |
| `scripts/e2e-group-order.mjs` | yes | create, join, cap refusal, close → cart price groups |
| `scripts/e2e-merchant-money.mjs` | yes | pricing sheet «yours»; money card; change composer; simulator recalculates; finance royalty rows |

Every run also checks: no horizontal overflow, no page errors, landmarks present, and rendered customer text free of forbidden words. `e2e-request` and `e2e-order-timeline` are rerun unchanged.

## 6. Phases and file ownership

### Scheduling rules

- **Start condition.** Nothing starts before community Phase 5 and merchant P4/P5 are committed (0159–0161; next free ≥ 0162; DECISIONS ≥ 183).
- **Integrator-only seam files**, edited as one-line-scope edits:
  - `worker/index.ts`, `worker/lib/schemaVersion.ts`, `packages/contracts/src/ownership.ts`, `worker/lib/mediaRefs.ts`;
  - `src/lib/refusalStrings.ts` + the test's sources/DOORS lists;
  - `worker/lib/notifications.ts` / `merchantNotify.ts` kinds;
  - `src/App.tsx` routes (rebased last);
  - `packages/contracts/src/merchantRoutes.ts` query words;
  - `/me.can` in `worker/routes/merchant.ts`;
  - `tests/bundleBudget.test.ts` pins;
  - DECISIONS rows.
- **Red tests first.** The money tests for a feature are written RED by the money builders before that feature's builders start, and the feature merges only when they are green.
- **Dark shipping.** Each workflow ships dark and ends with a DECISIONS row and a doc section. The owner switches each capability group on through the audited policy route.

### MW1 «Money seams» — dark; no customer surface; migration role `money_parts`; 8 builders + integrator

**Depends on:**
- Phase 5 + P4/P5 committed.
- The `adminCommunity.ts` resolve hunk rebases after community Phase 6's reputation bump — or MW1 runs after Phase 6.

**Slot:** lane B, after C1a and before C1b, because C1b consumes the pricer. If C1b must run first, builder 6 moves into C1b's workflow and MW1 skips it. It is disjoint from P6 (lane A, wave 2) and from community 7.

**Builders:**

1. **Escrow builders (golden)**
   - Owns: `worker/lib/escrowOps.ts` — split into per-hold statement builders; `releaseEscrow`, `refundEscrow` and `disputeEscrow` keep their signatures as wrappers.
   - New tests: `tests/escrowStatementsGolden.test.ts` — SQL + binds byte-identical for release, full refund and partial refund of a legacy escrow. Lands before any behaviour change.
2. **Parts and holds**
   - Owns: the migration file; NEW `worker/lib/escrowParts.ts` (`splitCents`, `reservePartHolds` + count fence, `partRecordStatements`, `releasePartReservation`, `markPartDueStatement`, `markPartEarnedStatement`); `worker/lib/walletOps.ts` (export `holdInsertStatement` only; the `held_iqd` COALESCE line for parts).
   - New tests: `tests/escrowParts.test.ts`.
3. **Settlement**
   - Owns: NEW `worker/lib/orderSettlement.ts`.
   - New tests: `tests/orderSettlement.test.ts`; `tests/escrowPartsProperty.test.ts` — 10k generated plans and outcomes checking Σ credits + deposits + commission = Σ committed dinars, one debit per committed hold, the one-cent rule, and that a wallet holding exactly the total accepts.
4. **Callers and admin**
   - Owns: `worker/routes/marketplace.ts` (confirm, cancel, dispute, accept landing check by order id); `worker/lib/communityRequests.ts` (auto-complete through the seam; `reconcilePartHolds`; `sweepDueParts`); `worker/routes/adminCommunity.ts` (resolve through the seam + split; escrow read; PATCH /settings normaliser; `FEE_KEYS`).
   - New tests: `tests/orderMoneySeam.test.ts` (source scan); `tests/partHoldSweep.test.ts` (+16 min).
5. **Read model**
   - Owns:
     - `worker/lib/merchantLedger.ts` — `financeSummary.escrow_held` over unsettled parts; royalty rows by event-key prefix; `entryLink` 'none' for `royalty:*`; `orderCredit` and `orderCreditStateSql` scoped to the order's seller;
     - `worker/lib/communityStates.ts` — kept receivable from the merchant's ledger lines when parts or royalties exist;
     - `worker/lib/customOrderNotify.ts` — `escrowCreditedIqd` by the escrow's merchant;
     - `worker/lib/merchantSweeps.ts` — per-event amount and key;
     - `worker/routes/communityOrderTimeline.ts` — step labels on part events.
   - New tests: `tests/partsReadModel.test.ts`.
6. **Pure modules**
   - Owns: NEW `packages/pricing/src/{escrowPlan,offerPricing,changeOrder,configured,royalty}.ts`.
   - New tests: `tests/moneyPricingPure.test.ts` — Σ fee = F; the remainder goes to the last step; the delivery fee sits in the delivery step; F5 on partial outcomes; the 35,000 example; `minimumReachableUnit`; client/server parity over 200 generated configurations.
7. **Settings and red suite**
   - Owns: `worker/lib/settings.ts` (the policy default); `worker/routes/admin.ts` (one hunk: the generic PUT refuses the key).
   - New tests: `tests/fixtures/money.ts`, `tests/moneyVocabularyLeak.test.ts`, `tests/moneyRouteClass.test.ts`, `tests/customerMoneyWords.test.ts`, `tests/communityOrderTermsFrozen.test.ts`; `tests/configCheckoutMoney.test.ts` and `tests/milestoneRelease.test.ts` with cases marked todo until C1b / MW2.
8. **Adversarial money reviewer** (tests only) — double release; replay after a lost response; approval racing confirm; dispute racing a due part; suspension; rounding; cancel after a paid step; reconcile racing acceptance.

**Integrator:** schemaVersion, ownership, mediaRefs, the DECISIONS row, the doc section. No client file changes, so the bundle is byte-identical.

### MW2 «Deal shapes» — migration role `deal_shapes`; 8 builders + integrator

**Depends on:**
- MW1.
- The Project track's versions and approvals (C5): runs in lane B, wave 6, alongside or right after C5.
- Phase 5's CustomOrderScreen: coordinate the one card slot with the manufacturing track's production board if that board has replaced the section by then.

Lane A is P9 at that point (printRequests, printQuote, merchantPrinters, Requests.tsx, Tools), which is disjoint. Options and change orders may switch on before plans, because plans need C5's approvals.

**Builders:**

1. **Offers and acceptance server**
   - Owns:
     - the migration;
     - `worker/routes/marketplace.ts` — the pricing key on create/edit/draft/send; the `offerShape` projection; accept option + plan parts + pricing byte fence + snapshot; the start-route due hunk; the dispute/cancel void-change statements (built by builder 3); the `money` read block;
     - `worker/lib/requestRevisions.ts` — the terms carry pricing;
     - NEW `worker/lib/offerPricing.ts` — the server checks.
   - New tests: `tests/offerOptions.test.ts`, `tests/paymentPlanAccept.test.ts`.
2. **Project-track hooks**
   - Owns: `worker/lib/orderSettlement.ts` (due/earned events, approval guard); NEW `worker/lib/paymentPlan.ts` (policy); NEW `worker/lib/revisionBudget.ts`; one-line hunks in the Project track's approval route and version-submit route.
   - Tests: `tests/milestoneRelease.test.ts` (red → green); NEW `tests/revisionBudget.test.ts`.
3. **Change orders**
   - Owns: NEW `worker/routes/communityChangeOrders.ts`; NEW `worker/lib/changeOrders.ts`; `worker/routes/communityOrderTimeline.ts` (merges change rows).
   - New tests: `tests/changeOrders.test.ts`.
4. **Customer UI**
   - Owns: NEW `src/components/community/money/{PaymentLine,OfferMoney,PaymentPlanSheet,ChangeOrderSheet,strings,api}.tsx|ts`.
   - Seams:
     - `src/pages/community/Request.tsx` — escrow section content only;
     - `src/components/community/requests/OfferCompare.tsx` — option row + lazy OfferMoney;
     - `src/components/community/requests/{OrderTimeline.tsx,timelineStrings.ts,api.ts}`;
     - the one consequence line in the Project track's approval sheet.
   - New tests: `tests/moneyCustomerUi.test.ts`.
5. **Merchant UI**
   - Owns: NEW `src/components/merchant/money/{OfferPricingSheet,OrderMoneyCard,ChangeOrderComposer,strings,api}.tsx|ts`.
   - Seams: `src/components/community/requests/OfferComposer.tsx` (one door); `src/components/merchant/orders/CustomOrderScreen.tsx` (one card, one door); `worker/routes/merchantFinance.ts` (`GET /finance/fees`).
   - New tests: `tests/moneyMerchantUi.test.ts`.
6. **Admin**
   - Owns: NEW `src/components/adminCommunity/EscrowPlanPanel.tsx`; `src/components/adminCommunity/AdminCommunity.tsx` (lazy mount + split in the resolve dialog).
   - Updates: `tests/communityMoneyScope.test.ts`.
7. **Browser acceptance** — `tests/browser/deal-money.*`, `scripts/e2e-deal-money.mjs` (full matrix); reruns `e2e-request` and `e2e-order-timeline`.
8. **Adversarial reviewer** (tests only) — option tampering; stale offer; approval by an invited approver; change racing delivery; credit bigger than held; revision over budget; dispute mid-plan.

**Integrator:** refusal strings + test lists; notification kind `change_order`; `/me.can` flags; schemaVersion, ownership, mediaRefs; bundle pins; DECISIONS; doc.

### MW3 «Earnings, store money, network, profit, groups» — migration role `earnings_groups`; 10 builders + integrator

**Depends on:**
- MW1 and MW2.
- From the other Programme C tracks: the templates track's configured lines (C1b) and the components track (C4); the licensing track's rule versions and adoption pins; the manufacturing track's partner-job door.
- From the merchant programme:
  - P7 — `storeOrderOps.ts`, OrderDetailScreen, StoreSettingsTab;
  - P8 — the coupon scope in `storeOrders.ts` `priceMerchantCart`;
  - P10 — owner-only gates and `tests/merchantRouteGates.test.ts`;
  - P11 — engine convergence before the simulator; money calls `priceJob` and never edits `printQuote/*`.

**Slot:** lane B, waves 8–9. Lane A is P11, then community 8; disjoint except `App.tsx`, whose group routes are rebased last.

**Builders:**

1. **Royalty core**
   - Owns:
     - NEW `worker/lib/royalties.ts`;
     - `worker/lib/merchantLedger.ts` — carve, pay and claw-back builders; the `payoutToWallet` builder; finance-summary royalty rows;
     - `worker/lib/storeOrderOps.ts` — the release sites (:558, :670) and the reversal sites (:463, `creditTakeBack`);
     - `worker/lib/orderSettlement.ts` — the creator line on the delivery part;
     - `worker/routes/marketplace.ts` — the one accept hunk carrying the royalty snapshot, the gift snapshot and the fee kind computed by builders 3 and 6.
   - New tests: `tests/royalties.test.ts` — parity Σ out = Σ in − Σ claw-back; a release for a seller in debt does not abort; a creator never sees another shop's order.
2. **Store checkout money**
   - Owns: `worker/routes/storeOrders.ts` — gift-wrap line + gift snapshot; royalty snapshot + seller carve; cost-snapshot upsert; the fingerprint gift key.
   - New tests: `tests/storeMoneyCheckout.test.ts`, in the storeCheckoutIntegrity B-series pattern.
3. **Gift**
   - Owns: NEW `worker/lib/gift.ts` (validation); NEW `src/components/storefront/checkout/{GiftSheet,giftStrings}.tsx|ts`.
   - Seams: `StoreCheckout.tsx`; the merchant `OrderDetailScreen.tsx` (gift block on the slip, price-free); `StoreSettingsTab.tsx` (wrap field); `community/money/OfferMoney.tsx` (gift row); `CustomOrderScreen.tsx` (gift block).
   - New tests: `tests/giftMode.test.ts`.
4. **Groups server**
   - Owns: NEW `worker/routes/groupOrders.ts`, `worker/lib/groupOrders.ts`.
   - New tests: `tests/groupOrders.test.ts`, including a 100-entry close + checkout in one batch within the CPU budget.
5. **Groups client**
   - Owns: NEW `src/pages/GroupOrder.tsx`, `src/components/storefront/group/{GroupOrderSheet,GroupManage,strings}.tsx|ts`.
   - New tests: `tests/groupOrderUi.test.ts`.
6. **Network, wallet payout, chat quotes**
   - Owns: `worker/lib/merchantOps.ts` (`FeeKind 'network'`); `worker/routes/merchantFinance.ts` (the `levo_wallet` channel); `worker/routes/chatCommerce.ts` + `src/components/chat/commerce/QuoteSheet.tsx` (the same pricing key through `readOfferPricing`).
   - New tests: `tests/networkMoney.test.ts`.
7. **Profit server**
   - Owns: NEW `worker/routes/merchantProfit.ts`, `worker/lib/profitSimulator.ts`, `packages/pricing/src/profit.ts`.
   - New tests: `tests/profitSimulator.test.ts` — owner-only; «not recorded» is never 0; no customer route reads `merchant_cost_snapshots`.
8. **Merchant money UI**
   - Owns: NEW `src/components/merchant/money/{ProfitSimulator,ProfitReport,RoyaltiesCard}.tsx`.
   - Seams: `MerchantFinance.tsx` (lazy `?view=profit`); `ProductEditorSheet.tsx` and `dashboard/CostingTab.tsx` (doors).
   - New tests: `tests/merchantProfitUi.test.ts`.
9. **Browser acceptance** — `scripts/e2e-store-money.mjs`, `e2e-group-order.mjs`, `e2e-merchant-money.mjs` + fixtures; reruns `e2e-catalog` and the storefront budget.
10. **Adversarial reviewer** (tests only) — stale quote after a rules edit; part stock race; cancel restocking child lines; group close replay; royalty on a cancelled order; wallet payout while in debt; network fee spoofing; profit with an unknown basis.

**Integrator:** `App.tsx` routes (`/g/:token`, `/groups/:id`); the contract's closed query words (`view=profit`); refusal strings; ownership; mediaRefs; schemaVersion; bundle pins; DECISIONS; doc.

### Gates (every workflow)

1. `npm run check`
2. `npm run test:unit`. The existing money suites must stay green **unchanged**:
   - community orders: escrow (21), communityEscrowDecisions (13), communityRequestLifecycle (16), communityAcceptIntegrity (13), offersV2 (11), orderTimeline (11), communityMoneyScope;
   - merchant ledger and payouts: merchantLedgerFlows/Schema/Backfill, merchantPayouts, payoutMerchantDebt, suspendedMerchantMoneyHold;
   - store: storeCheckoutIntegrity (B1–B25), catalogCheckout, storeOrderCancel.
3. `node scripts/migrate-check.mjs --twice`
4. `npm run build` + `tests/bundleBudget.test.ts` — CSS no larger than the previous phase; new chunks pinned; storefront, shell and CommandCenter byte-identical.
5. The workflow's e2e scripts.
6. Flags stay off; deploy only on the owner's word.

## 7. Risk register (leak → the seam that makes it impossible → the test that proves it)

| # | Leak | Seam | Test |
|---|---|---|---|
| 1 | Client-chosen money (price, total, option price, royalty, payee, margin, customer_id, merchant_id) | ids in; echo-only `expected_*`; the payee comes from the escrow or product owner; option totals from `pricing_json` | configCheckoutMoney, offerOptions, changeOrders, moneyRouteClass |
| 2 | Stale price | fingerprint v2 → QUOTE_CHANGED; pricing_version fence → CART_CHANGED; accept fence on the `pricing_json` bytes → OFFER_CHANGED | a rules edit mid-placement writes zero rows, debits or stock moves |
| 3 | Double checkout or settlement replay | per-user idempotency bound to the fingerprint; server-minted keys `<event>:<order>[:p<seq>]`; part flip `WHERE held` | same key twice → one debit; settling twice → one ledger pair |
| 4 | Two configurations merged into one cart line | the config hash in the line identity (the templates track's `color_id` carrier) | two names → two lines |
| 5 | Parts counted twice or oversold | the unit includes the parts; children are zero-priced; demand is aggregated per product and variant; cancel restocks children | catalogCheckout extension |
| 6 | Price edited after acceptance | `trg_co_money_frozen`; changes only through change orders | a money UPDATE raises; a 0134-style snapshot redaction passes |
| 7 | Option tampering | options live in the revision; accept fences revision + price + `pricing_json` | offerOptions |
| 8 | Release before approval, or by the wrong person | the part flip requires the order customer's approval of the current version; start alone never pays; the delivery step ≥ 30 % + the whole fee | milestoneRelease |
| 9 | Double release | flip `WHERE held` + stamp fence; UNIQUE ledger and event keys; the parent CHECK | approve racing confirm |
| 10 | A legacy path pays a plan escrow | `hold_id NULL` → WALLET_ERROR; source scan | orderMoneySeam |
| 11 | The orphan sweep frees live part holds (sweep step 3, communityRequests.ts ~801) | part holds use ref_type `escrow_part`, with their own reconcile that asks «does a part name this hold» inside its UPDATE | partHoldSweep |
| 12 | Cents drift, or the one-cent rule broken | cents computed once from the total and split by largest remainder; change parts ask their own dinar question | escrowPartsProperty (a wallet with exactly 105,000 accepts a 105,000 plan) |
| 13 | Rounding drift, or the minimum fee multiplied (`splitFee` applies the minimum per call) | steps carved from the one split; change parts at the order's rate with minimum 0; Σ fence | escrowPartsProperty |
| 14 | Change-order races | one pending per order; decision_token; the delivery trigger; dispute/cancel void in the same batch; UNIQUE source_id | changeOrders |
| 15 | A credit larger than the money held | credit ≤ unsettled parts − earlier credits at proposal; min() again at settlement | changeOrders |
| 16 | A revision fee charged wrongly | the server counts versions; beyond the budget a funded revision part is needed; comments never count | revisionBudget |
| 17 | Royalty paid on refunded money | the creator's in-line only at release; a claw-back (kind `refund`, overdraw-exempt) in every post-release reversal; the drift report sees an un-clawed line | royalties |
| 18 | A royalty aborting a release | the store carve sits in *pending* from placement; the custom carve reduces the lead's gross; never a negative line in a seller's *available* bucket | royalties (a seller in debt still releases) |
| 19 | Royalty abuse | designer ≠ seller; pinned rule version; ≤ the share (floor at save, min at snapshot, cap at settlement); flag off by default | royalties |
| 20 | A creator sees another shop's order, or a seller's figure includes a creator's line | `entryLink` 'none' for `royalty:*`; `orderCredit` / `orderCreditStateSql` scoped to the seller (their readers include `notifyOrderCreditAvailable`) | partsReadModel |
| 21 | A partner job paid twice, or tied to the customer's money | an ordinary direct request/offer/escrow funded from the buyer's wallet; no statement links parent and child money | networkMoney |
| 22 | A group paid in part, or oversold | one organizer checkout; cap + deadline inside the INSERT; closed hash; reopen refused once ordered | groupOrders |
| 23 | Cost, margin, royalty or net shown to customers | forbidden-fragment scan over every customer payload; merchant-private tables; the words test in three languages | moneyVocabularyLeak, customerMoneyWords |
| 24 | Staff moving money | routes classed *moves / shows / none*; *moves* ⇒ the payer or requireStoreOwner; P10 access never gates a *moves* route | moneyRouteClass |
| 25 | A suspended merchant paid | the fence inside each part flip; due parts released by `sweepDueParts` after the suspension lifts | suspendedMerchantMoneyHold extension |
| 26 | A dispute in the middle of a plan | the parent freeze; the admin decides only the unsettled remainder; paid parts are final | orderSettlement |
| 27 | Wrong displayed money | wallet `held_iqd` over part gross; `escrow_held` = Σ unsettled parts; kept receivable from the ledger; notices per released part | partsReadModel |
| 28 | A zero, negative or overflowing price | non-negative lookups; unit > 0; unit ≤ 50,000,000; qty ≤ 9,999; safe integers | moneyPricingPure |
| 29 | The delivery fee released early | the fee sits wholly in the delivery part | moneyPricingPure |
| 30 | Reputation farmed through partner jobs | `completionStatements` skip partner-job orders | networkMoney |
| 31 | Private money in a row both parties can read (GET /orders/:id spreads `o.*`; `pricing_snapshot` is served to buyers) | community_orders gains no cost/margin/royalty/profit/partner column; a schema scan | moneyVocabularyLeak |
| 32 | An oversized settlement batch | ≤ 4 step parts and ≤ 8 parts per escrow; ≤ 100 group entries | orderSettlement, groupOrders |

## 8. Trade-offs

1. **One hold per part, rather than one hold committed at the first release.**
   - Why: each slice keeps every existing per-escrow invariant (credit only where the debit posted; refunding an unreleased slice releases its hold; one debit per hold), unreleased money stays visibly held in the wallet, and change top-ups become possible — which «amounts written once» (0031:141-143) forbids anywhere else.
   - Cost: a new ref_type, its own reconcile step, one wallet-display line and an N-hold batch.
2. **One settlement function plus a source scan, rather than teaching each caller.**
   - Cost: the most sensitive file is refactored first.
   - Mitigation: the byte-identical golden test lands before any behaviour changes.
3. **Funded in full at acceptance, rather than pay-as-you-go.**
   - Why: no merchant ever works on unfunded steps.
   - Cost: the customer needs the whole balance on day one — today's rule anyway. Pay-as-you-go is an owner question and fits the same parts table.
4. **Release only on customer acts.** The deposit is *earned*, not paid; the production step needs approval plus start.
   - Why: paid money is final, since no escrow claw-back exists.
   - Cost: merchants get early cash only at design approval.
5. **Change orders as parts of the same order, rather than child requests, offers and orders.**
   - Why: no hidden rows, no second state machine, no list filters; completion and reputation are counted once.
   - Cost: `community_orders.price_iqd` keeps the original price, so the current total is computed on read.
6. **Price cuts credited at the final settlement, rather than refunded at once.**
   - Why: a non-admin cannot settle part of an escrow mid-way, and every refund path is terminal.
   - Cost: the customer waits until completion for the money.
7. **Options as JSON in the frozen revision, rather than a variants table.**
   - Why: one column, frozen for free, and the byte fence stops tampering.
   - Cost: analytics read the options from JSON.
8. **Royalty carved from the seller's share as a fixed IQD per piece, clawed back with the money.**
   - Why: the customer's total never moves, there is no allocation arithmetic, and every party nets to zero on a reversal.
   - Cost: merchants price the royalty in themselves, and a creator may go negative after a post-release refund (payouts pause).
9. **The live price computed on the client with the shared pricer, rather than a server call per tap.**
   - Why: zero D1 reads while personalising and zero storefront bytes.
   - Cost: the price rules become public — harmless, since they are prices, not costs — and a stale cached read is corrected at add with a visible notice.
10. **Merchant costs in a private table, rather than `order_items.cost_iqd`.**
    - Why: keeps 0095's platform cost basis honest.
    - Cost: one more table and a join in the merchant's profit view.
11. **Partner jobs as separate contracts funded from the buyer's wallet (plus an optional wallet payout), rather than payee splits inside the customer's escrow.**
    - Why: responsibility stays with the lead, and no other merchant's suspension or dispute touches the customer's money.
    - Cost: a merchant must hold wallet balance, or use the payout channel.
12. **Organizer-pays groups, rather than split payments.**
    - Why: no money object depends on N payers.
    - Cost: the organizer fronts the whole amount.
13. **Same-seller parts in v1, rather than Levonis parts inside a merchant's order.**
    - Why: one seller, one commission base, one ledger per order.
    - Cost: merchants must list the parts they sell.
14. **Red tests first.**
    - Why: no money seam ships untested.
    - Cost: features start later.

## 9. Open questions for the owner

1. **Payment plans:** hold the whole amount at acceptance (recommended), or let the customer pay each step when it becomes due, with the workshop carrying the non-payment risk?
2. **Deposit (عربون):** the workshop keeps it only if the customer cancels after the first design has been sent, and it is at most 30 % — agree? Is a grace window after acceptance needed?
3. **Plan limits:** plans only above 100,000 IQD; each step ≥ 10 % and ≥ 5,000 IQD; the delivery step ≥ 30 % plus the whole delivery fee — are these the right numbers?
4. **Production step:** paid only when the customer has approved production AND the workshop has started — never on «start» alone — agree?
5. **Final steps and disputes:** paid steps are final, and a later dispute decides only what is still held. A workshop that cancels after being paid for a design keeps that design payment. Agree, or should workshops keep a reserve or return it?
6. **Commission:** one split at acceptance, sliced across the steps; changes charged at the order's rate with no minimum fee; on partial outcomes the order's rate on what was kept; never refunded on an escrow — agree?
7. **Price cuts:** returned when the order completes (a credit), not immediately — acceptable?
8. **Paid changes and revisions:** paid changes are allowed until the work is marked delivered, and extra revisions are priced by each workshop, capped at 100,000 IQD — agree?
9. **Who releases money:** only the paying customer's approval, never an invited approver's; and no automatic approval after silence (the workshop may open a dispute instead) — agree?
10. **Royalty model:** a fixed IQD per piece out of the seller's share (proposed), or a percentage, or added on top of the price? Is a cap of 25,000 IQD per piece right? Paid only to creators who own a store (PLUS), or also into any creator's Levo Wallet?
11. **Royalty on refunds:** when a store sale is refunded after release, the royalty is taken back from the creator, who may go negative with payouts paused — agree? For custom orders the royalty shrinks in proportion to a partial refund.
12. **Levonis-sold parts** inside a merchant's personalised product: v1 allows only the merchant's own listed parts. Later: two linked orders under one checkout, or merchants buying wholesale from Levonis?
13. **Partner jobs:** what commission rate — the same as custom orders, lower, or zero? Is the customer ever told that a partner made part of the order (proposed: no)?
14. **Earnings to wallet:** may merchants move available earnings into their own Levo Wallet instantly, to pay partners — refused while in debt or suspended?
15. **Group and event orders:** the organizer pays for everyone in v1. Should participants later pay their own share (separate orders shipped together)? Must participants sign in? Is 100 names per group the right cap?
16. **Gift mode:** the recipient never sees any amount anywhere — is there any exception (customs, returns by the recipient)? Is the gift-wrap fee set per store?
17. **Minimum price protection** on customizable products: a warning when a reachable combination falls below the merchant's floor (proposed), or a hard refusal at template save? And quantity-break discounts later (percentages)?

GRAFTS: ["From P1 — offer options live in `community_offers.pricing_json`, frozen by the revision terms (`recordOfferRevisionStatement` adds 'pricing'). The offer freeze in the acceptance batch also fences `pricing_json = ?`, the exact bytes priced. This replaces P2's append-only community_offer_variants table.","From P1 — one payment plan per offer rather than per option; the server computes each option's step amounts. Presets are «All on delivery» (the default), «Design first 30·70» and «Deposit + design + delivery».","From P1 — the deposit (عربون) is an optional step, earned when the merchant submits the first version. The workshop keeps it only on a customer cancel; a merchant cancel refunds it. It ships only after an owner decision.","From P1 — the production step is released only when the customer's production approval exists AND the merchant starts. This replaces P2's optional start release (milestonePolicy.start_max_percent): a merchant act alone never pays.","From P1 — step fee slices use cumulative rounding (f_i = ⌊F·C_i/G⌋ − ⌊F·C_{i−1}/G⌋, so Σ = F exactly). On a partial outcome the commission is F5 on the order's total kept gross, less what earlier parts charged. Commission is never refunded on an escrow.","From P1 — a pending change blocks `merchant_marked_delivered` through a community_orders trigger, and the dispute and cancel batches void it. This replaces P2's change_hold_id column and freeze trigger.","From P1 — the order read gains refund_if_cancel_iqd (customer, only while cancel is allowed), a per-step «yours» net (merchant only) and promised days that include approved change days.","From P1 — the live price rides inside the fifth control's label («Add to cart · 35,000») and the price breakdown sits under More. This keeps the five-control rule; P2's ⓘ IconButton is dropped.","From P1 — merchant net previews («لك» after commission and royalty) come from GET /api/merchant/finance/fees plus the shared pure offerPricing module, recomputed live in the composer.","From P1 — offers can carry component substitutions (10 mm → 15 mm magnet) priced from the merchant's own catalogue at write time. The customer sees them as line-through before/after rows with the difference.","From P1 — read-side seams: customOrderNotify.escrowCreditedIqd filtered by the escrow's merchant; merchantSweeps notices per released event amount and key; kept receivable read from ledger lines for plan escrows; timeline step labels.","From P1 — a custom-order royalty is a positive creator line paired with a reduced lead escrow_release on the delivery part, so no negative line ever lands in the lead's available bucket.","From P1 — a realised-profit view (ledger revenue − recorded cost, with 'unknown' kept unknown) in a lazy ?view=profit of the Money section, beside P2's simulator.","From P1 — gift money: a store gift-wrap fee (merchant_stores.gift_wrap_iqd; NULL means not offered), gift snapshots on store and community orders, and the rule that no recipient-facing surface carries an amount. The packing slip is already price-free (OrderDetailScreen.tsx:429-459).","From P1 — an owner-gated instant levo_wallet payout channel, so merchants can fund partner jobs from their earnings. It is one batch: debt fence, suspension fence, payout legs, system deposit.","From P1 — money policy is written only through adminCommunity PATCH /settings behind requireFinancialScope (audited), as ONE structured key, communityMoneyPolicy, in P2's config shape. The generic PUT /api/admin/settings/:key refuses that key, because it has no financial-scope check.","From P1 — a customer money-vocabulary strings test in three languages (also forbidding CAD/slicer words), plus the JSON scan of every customer money payload.","From P1 — the admin EscrowPlanPanel, lazily mounted in the AdminCommunity disputes tab.","From P1 — chat quotes accept the same pricing key through readOfferPricing, in the last workflow once P6/P7 are done with chatCommerce.ts.","From P1 — an adversarial money reviewer (tests only) in every workflow, alongside P2's red-first suite.","Judge fix — a plan's cents are computed once from its total with walletSpendCents, then split across the part holds by largest remainder (every part ≥ 1 cent). This keeps 0108's at-most-one-cent-per-order rule, and a wallet holding exactly the plan total can still accept. P2 converted each part separately.","Judge fix — the store royalty is carved as a seller adjustment in the PENDING bucket at placement. The release then moves the net, a reversal nets the seller to zero, and a release for a seller in debt can never abort on LEDGER_BUCKET_OVERDRAWN. P2 wrote a negative line in available at release.","Judge fix — orderCredit and orderCreditStateSql are scoped to the order's seller; six readers, including notifyOrderCreditAvailable, would otherwise count a creator's royalty line in the seller's figure. entryLink returns 'none' for every royalty:* event key.","Judge fix — at most 4 step parts and 8 parts in all per escrow, to bound every settlement batch. Group orders are capped at 100 entries until a measured 200-entry close-and-checkout batch test passes."]

REJECTED: ["From P1 — one hold for the whole order, committed at the first paid step. The wallet then reads 100 % spent while most of the money is still in escrow. Every later return must be the single `wtx_escrow_refund_<escrow>` deposit, and top-ups become impossible — which is what forced P1 into child orders.","From P1 — change orders and paid revisions as hidden child requests + offers + orders + escrows (link_kind 'supplement', parent_order_id). This needs a filter in every customer and merchant list, attention source, analytics query and completion path, plus a second state machine coupled to the parent in about eight call sites. Parts on the same order do the same job.","From P1 — collaborator payee lines inside the customer's escrow (community_order_payees, with a proposal/accept flow). It is a second way to pay a partner beside subcontracts, and it couples another merchant's suspension and disputes into the customer's money. «Split compensation where supported» is met by a partner job plus the wallet payout.","From P1 — writing merchant costs into order_items.cost_iqd ('snapshot'/'unpriced'). Migration 0095 keeps merchant store lines 'unrecorded' because that column is the platform's cost basis; merchant costs live in merchant_cost_snapshots instead.","From P1 — royalty lines with order_id NULL and «never reversed». On a post-release refund the seller silently pays the royalty and parity with storeOrderMoneyDrift is lost. The carve-plus-claw-back design leaves every party at zero.","From P1 — Levonis parts as a merchant pass-through that is «checked, not reserved». That is an inventory promise without a reservation, and commission taken on money that is not the merchant's. v1 allows only the merchant's own parts; the two-seller answer is an owner decision.","From P1 — percentage royalties (pct_x100) and quantity-break discounts in v1. Both create allocation arithmetic against coupons, parts and partial refunds. v1 uses a fixed IQD per piece and non-negative table lookups only.","From P1 — a MW1 that ships options, plans and change orders together before the Project track lands. Plans cannot switch on without approvals, so the seams land dark first and the deal shapes land with C5.","From P1 — the «الشركاء» Money view for payee invites. It is dropped along with payee splits; partner jobs are listed by the manufacturing track.","From P2 — the community_offer_variants append-only table. The offer revision snapshot already freezes JSON, so one column plus a byte fence in the acceptance batch gives the same tamper guarantee.","From P2 — a separate payment plan per option. One plan per offer is a single thing to explain, and the amounts per option are computed.","From P2 — community_orders.change_hold_id plus trg_co_change_freeze. It copies 0140's pattern where a delivery-block trigger and same-batch voiding on dispute/cancel already cover the only race that matters.","From P2 — an optional start release (milestonePolicy.start_max_percent). A merchant act alone never pays; the production step needs the customer's production approval as well as the start.","From P2 — calling walletSpendCents for each part. Flooring each part separately can cost up to one cent per part, which breaks 0108's one-cent-per-order rule and makes a wallet holding exactly the plan total fail on the last hold.","From P2 — royalty_out as a negative adjustment in the seller's available bucket at release. For a merchant in debt, trg_mle_no_overdraw aborts the whole release batch, so the credit would stay stuck.","From P2 — the ⓘ IconButton beside the price in the customize footer. It is a sixth control; the breakdown moves under More.","From P2 — customer-proposed change-order rows. The existing «اطلب تعديلًا» (modification_request) update already carries the customer's ask, and the merchant prices it as a change.","From P2 — a CommandCenter attention line «a change is waiting for the customer». It is not a merchant action, and CommandCenter stays byte-identical under its 18 KB pin.","From P2 — writing money policy through the generic PUT /api/admin/settings/:key. That door has no financial-scope check; money policy goes through adminCommunity PATCH /settings behind requireFinancialScope.","From both — auto-approving a design after customer silence (both left it as a question). It would release money without a customer act; the workshop opens a dispute instead."]

### Judge's scores — money

| Criterion | Proposal 1 (ledger-first) | Proposal 2 (risk-first) |
|---|---|---|
| Simplicity for the customer (five-control rule) | **8** — The live price rides inside «أضف إلى السلة · 35,000», so the personaliser keeps five controls. The accept sheet is capped at four controls, gift mode hides prices automatically, and the order says «إن ألغيتَ الآن يعود إليك …». But committing the whole hold at the first step makes the wallet read 100 % spent while 70 % is still in escrow, and every paid change spawns a hidden request that one missed filter would put in the customer's lists. | **7** — The accept sheet shows exactly how the workshop gets paid, and unreleased steps stay visibly «held» in the wallet. The customer is told «the price is now 36,000» instead of being corrected silently, and gets an Estimate range when no seller exists. The ⓘ IconButton beside the price adds a sixth tap target to the five-control footer. |
| Power for the merchant | **9** — The richest surface: three options with a live «لك» net after commission and royalty, plan presets, and part substitutions priced from the catalogue. Configured change deltas are computed, not typed. It adds collaborator payees, a realised-profit report beside the simulator, and an instant wallet payout for funding partner jobs. | **7** — Covers plans, three variants with «Fill from my costs», a change composer, a subcontract sheet with quantity allocation, and a profit sheet with honest «not recorded» lines. It has no net-after-fees preview, no realised-profit view, and no way to spend ledger earnings on a partner job. |
| Reuse of what exists | **6** — Leaves the hold, sweep and wallet-display seams untouched, and freezes options in the existing revision snapshot with one column. But every price increase manufactures a hidden request + offer + order + escrow, which needs a link_kind filter in every list, attention source, analytics query and completion path. Payee splits are a second way to pay a partner beside subcontracts. | **8** — One money slice under the existing escrow; change orders as parts on the same order; subcontracts as ordinary direct requests; royalties in existing ledger kinds; a merchant-private cost table that respects 0095. It spends a variants table where the revision snapshot already freezes JSON, and a change_hold_id column where a trigger is enough. |
| Budgets (bytes, CSS, D1 waves) | **8** — Zero new utility classes (checked present/absent against the 11:54 build). Every surface is a lazy chunk; storefront, shell and CommandCenter stay byte-identical; acceptance D1 waves are unchanged. The change-approval batch that writes a child request, offer, order and escrow is the heaviest write in the design. | **7** — Zero new utility classes (checked) and lazy sheets. But it grows the Request chunk by about 1.7 KB statically, plus OrderTimeline, CustomOrderScreen, MerchantFinance and ProductEditorSheet, and adds an attention line to the 18 KB-pinned CommandCenter. The N-hold batch keeps acceptance at three waves. |
| Security and money soundness | **6** — Strong named invariants (I1–I12, C1–C5, S1–S5), with these gaps:<br>• The single committed hold turns every later return into the one allowed deposit.<br>• Children-follow-parent coupling is spread over about eight call sites.<br>• Store royalties with order_id NULL are never clawed back, so the seller silently pays royalties on refunded sales.<br>• Merchant costs go into order_items.cost_iqd, against 0095.<br>• A negative royalty line in «available» can abort releases for a merchant in debt. | **9** — Strengths:<br>• Legacy paths fail closed (hold_id NULL → WALLET_ERROR, checked at escrowOps.ts:552/:689).<br>• One settlement function behind a byte-identical golden refactor and a source scan.<br>• «Credit only where the debit posted» holds per slice.<br>• A money-frozen trigger, and a royalty claw-back that the overdraw trigger exempts (checked, trg_mle_no_overdraw).<br>• Invited approvers never release money; 31 leaks each have a red-first test.<br>Gaps: converting cents per part breaks 0108's one-cent rule, and a negative royalty line in «available» can still abort a release for a seller in debt. |
| Mobile-first | **8** — Anatomy is 360-first: sticky summaries sit inside the page's own scroll owner (no fixed bottom-0), DataList rows stack into two lines at phone width, and rows are 44 px. | **8** — Sheets are 360-first and become centred sm:max-w-md windows (class checked). Money sits in <bdi> with tabular-nums, accessible names carry the option price, and focus returns to the money line. |
| Feasibility on Workers/D1/ogl | **6** — Everything runs on Workers and D1 with no ogl involvement. The riskiest code in the design is the one-batch child creation, the child/parent coupling in every settlement path, and the delegation inside escrowOps. | **8** — Everything is ordinary D1: N conditional hold inserts plus a count fence, then one SELECT and one batch per settlement. The riskiest step, refactoring escrowOps first, is covered by a golden test that lands before any behaviour changes. |
| Schedule fit with the running programmes | **7** — Three workflows with honest dependencies. But MW1 lands options, plans and change orders together in marketplace.ts, escrowOps.ts and merchantLedger.ts, and plans cannot switch on until the Project track provides approvals. | **9** — Lands the money seams dark early (lane B, or inside C1a), deal shapes with C5 in wave 6 once approvals exist, and earnings after C1b/C4/P7/P10/P11. That is the rules survey's interleave, with red tests written before each feature. |
| **Total** (money soundness counted twice) | **64 / 90** (unweighted 58 / 80) | **72 / 90** (unweighted 63 / 80) |
