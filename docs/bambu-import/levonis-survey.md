## Levonis survey for a catalog-only Bambu Lab import

Read-only survey at commit 2b93fc91 on branch `claude/new-session-2hq4ci`, working tree clean. I edited nothing and contacted no live site or database.

All paths below are absolute. Line numbers refer to that commit.

**Repo facts that constrain any design** (/home/user/Levonis/CLAUDE.md:1-54):
- Every push to the default branch is a live deploy through workflow 7.
- Migrations are applied before the deploy.
- Every read of a new table or column must tolerate the table being absent.
- Every user-facing string must exist in ar, en and ckb, and a ckb string may never be a copy of the Arabic (DECISIONS row 183).
- Migrations are additive only. DECISIONS row 237 forbids table rebuilds and widened CHECKs.

---

### 1. Product data model

**`products` table** (/home/user/Levonis/migrations/0001_init.sql:71-111)
- Columns: `id`, `slug UNIQUE`, `status NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','hidden'))`, `name`/`name_ar`/`name_ku` (ku is exposed as ckb), the matching `description*` columns, and JSON columns `images`, `options`, `colors`, `specifications`, `labels`, `hashtags`, `algorithm_tags`, `features`, `description_images`, `description_videos`, `stores`, `warranty_plans`.
- Legacy taxonomy text: `brand`, `categories`, `subcategory_id`.
- Money and stock constraints:
  - `price_iqd INTEGER NOT NULL DEFAULT 0 CHECK (price_iqd >= 0)` (:86)
  - `original_price_iqd CHECK (NULL OR >= 0)` (:87)
  - `product_cost_iqd INTEGER` — nullable, no CHECK (:88)
  - `stock INTEGER CHECK (stock IS NULL OR stock >= 0)` (:105). NULL means "untracked", which an ordinary product reads as "sell 99" (/home/user/Levonis/worker/lib/productModel.ts:233-246).

**Later `ALTER TABLE products` columns**
- From /home/user/Levonis/migrations/0002_products_memberships.sql:
  - :55 `pro_price_iqd` with a `>= 0` CHECK
  - :56 `brand_id` FK to `brands`
  - :60 `preorder_transports`
  - :64 `content_blocks`
  - :68 `translation_meta`
  - :71 `content_rev`
  - :73 `doc_version`
- 0003:172 `ops_policy`.
- 0018:147-179: `prime_price_iqd` (no CHECK), `sale_types`, `inventory_mode`, `stock_reserved NOT NULL DEFAULT 0`, `low_stock_threshold`, `category_id`/`sub_category_id` (FK to `catalogs`), `template_family`, `sku` (partial unique `idx_products_sku`, :175), `spec_fields` (JSON `{field_id: string}`).
- 0034:20 `direct_surcharge_iqd`; 0035:19 `usage_guide`; 0058:22 `composition`; 0079:43-44 `how_to_use_ar`/`how_to_use_ckb`; 0085:23 `condition_doc`.
- 0098:306-313: eight physical-dimension columns.
- 0104:31 `gini_url`; 0138:29 `light_image`.

**Triggers on `products`**
- 0167:155-157: finance-clock triggers fire on every INSERT, UPDATE and DELETE. This is why 0184 deliberately added no column to `products` (/home/user/Levonis/migrations/0184_product_completeness.sql:4-7).
- 0181:370: `engine_lock_products` (raises ENGINE_MANAGED).
- 0189:249: `v2_lock_product_fees` (raises PRICING_V2_FEES_RETIRED).

**Options, colours, variants** (/home/user/Levonis/migrations/0018_prime_taxonomy_inventory.sql)
- `product_option_groups` (:186-194) has `name_en` only — there are no ar/ckb group names anywhere.
- `product_option_values` (:196-218):
  - Stock: `stock CHECK (NULL OR >= 0)`, `reserved NOT NULL CHECK (>= 0)`.
  - Prices: `regular/prime/pro/cost_iqd`, each `CHECK (NULL OR >= 0)`.
  - Later additions: `*_adjust_iqd` with no CHECK (0044:66-69); `name_ar`/`name_ckb` (0055:17-18); availability and lead-time columns (0043:53-58, 0079:57-58); `merged_into` (0073:172); dimensions (0099:17-31).
- `product_colors` (:220-238): `hex NOT NULL`, the same stock and price CHECKs, plus 0044:71-74, 0055:19-20 and 0099:37-51.
- `product_color_option_links (color_id, option_value_id, group_id)` (:246-253). Within a group the links mean OR; across groups they mean AND (/home/user/Levonis/worker/lib/productRelations.ts:1-24).
- `product_variants` (:258-275):
  - `combo_key NOT NULL` with `UNIQUE(product_id, combo_key)`; `sku` with a partial unique index (:274).
  - The same stock and price CHECKs; dimensions from 0099:57-71.
  - The `combo_key` encoding is the sorted `o:<valueId>` entries, then `c:<colourId>`, joined by `|` (0183:9-11).
  - An option-less product uses the sentinel key `o:*`, and the option id `*` is reserved by a trigger (0189:258).
- Order-type cells and routes:
  - `product_option_fulfillment` (0073:67-121): one per option × `direct_sale|pre_order`, with price and cost columns `>= 0`.
  - `product_option_transports` (0073:131+): `air|sea|land`, `surcharge_iqd`, price columns.
  - 0075 adds capacity to both.

**Engine locks**
- /home/user/Levonis/migrations/0181_pricing_engine_core.sql:370-455 and 0188:36-107. While `product_pricing_state.mode='engine'` and no `engine-price:<id>` guard is held, any price-column change, option/cell/route insert or delete, or priced colour/variant insert raises ENGINE_MANAGED.

**Images and media**
- `product_images` (0018:278-298):
  - Columns: `url`, `alt_en`, `sort_order`, `is_primary` (one primary per product via a unique partial index), `width`/`height`/`bytes`/`content_type`.
  - Nullable bindings `option_value_id`, `color_id`, `variant_id` (FK, ON DELETE SET NULL).
  - 0048:20-23 adds `alt_ar`, `alt_ckb`, `r2_key`, `source_url`.
  - 0099:110-119 adds `quarantined` with a CHECK (a quarantined row must have empty `url`/`r2_key` and a non-empty `source_url`) and `quarantine_reason`.
- The legacy scalar `image` columns on option values and colours were drained into `product_images` (0099:93-99).
- The write path allows at most one binding per image (/home/user/Levonis/worker/lib/productPersistence.ts:938-951).
- Selection precedence is exact variant → colour → option → primary (/home/user/Levonis/packages/pricing/src/productSelectionMedia.ts header; /home/user/Levonis/worker/lib/productSelectionImage.ts).
- `products.images` is only a JSON mirror; `product_images` is the authority.
- Ownership ledger: `file_objects` (0068:4-21, plus 0156:47-48 `sha256` and `purpose`).
- Cleanup machinery: `media_cleanup_jobs` (0072:39, `not_before` from 0099) and `media_object_guards` (0099:634-644).

**Taxonomy**
- `brands`: `slug UNIQUE`, `name_ar NOT NULL`, `name_en`, `name_ckb`, `active` (0002:15-23).
- `catalogs` tree (0002:25-38): `parent_id`, `slug UNIQUE`, `is_printer_catalog`. Later additions: `template_family` (0018:116), image keys (0100, 0136, 0142, 0149), descriptions (0136:22-25), `serial_policy` (0178:120). Slug history in `catalog_slug_history` (0136:27).
- Multi-category membership: `product_catalogs (product_id, catalog_id, position)` with `UNIQUE(catalog_id, position)` (0002:42-49). Effective membership is the UNION of `product_catalogs`, `category_id` and `sub_category_id` (/home/user/Levonis/worker/lib/catalogMembership.ts:71-88).
- Facets: `facets` / `product_facets` (0018:118-138).
- Hashtag vocabulary: `hashtags` (0041:15-25); `products.hashtags` JSON stays the source of truth.

**Product types and families**
- `template_family` (devices / materials) is stored on catalogs and products.
- The six product types (`printer|parts|filament|accessory|laser|laser_material`) are derived from the section and never stored (/home/user/Levonis/worker/lib/templateFamilies.ts:1476-1600, 2053-2100).

**Specs**
- `spec_fields` holds string values typed by template field definitions: `type text|number|select|multiline|hex`, `unit`, `options`, `required`, and a `compare` annotation (/home/user/Levonis/worker/lib/templateFamilies.ts:30-108).
- Free spec groups are stored in `specifications` as `SpecGroupV2`/`SpecRowV2` (label and value in ar/en/ckb, `unit`) (/home/user/Levonis/worker/lib/productModel.ts:82-101).
- The public projection merges both (productModel.ts:1744).
- The only per-option spec is the `variant_specs` multiline field (templateFamilies.ts:440).

**Documents and links**
- Platform products have no document table. `product_files` references `community_products` (0157:25-27).
- What exists:
  - `usage_guide` (official_url plus steps with `link_url`/`video_url`/images) (productModel.ts:140-165)
  - `content_blocks` (text/image/video_embed)
  - legacy `description_videos`
  - legacy `stores` JSON [{name, url, price_iqd}]
  - `gini_url`

**Compatibility**
- `product_printer_fits (product_id, printer_id)` (0148:90-103).
- Spec text fields `compatibility` and `ams_compatibility` (templateFamilies.ts:224, 383).

**Translations**
- `product_translations (product_id, field, source_en, source_hash, text_ar, text_ckb, status CHECK machine|review_needed|approved)` (0018:327-339) and `translation_meta` JSON.
- Slots are defined in /home/user/Levonis/worker/lib/translationSlots.ts.
- No AI or machine translation; translation uses the local dictionary (DECISIONS row 2).

**Pricing and visibility tables**
- `product_pricing_state` (0181:44-71, plus 0189:27-37 `pricing_method cost|usd` and `v2_since`).
- `product_sku_prices`: `regular_price_iqd NOT NULL BETWEEN 1000 AND 1e11 AND %1000=0`, INSERT/UPDATE/DELETE guards (0183:28-51).
- `pricing_price_points`, `pricing_preorder_discounts`, `pricing_v2_sku_results`, `pricing_legacy_snapshots` (0189:43-241). `pricing_v2_sku_results` has `final_price_iqd NOT NULL` and CHECKs, guarded by the `engine-price:` token.
- `product_completeness` (0184:25-44).
- `pricing_v2_purchase_reviews` (0190:123).

---

### 2. Visibility and purchasability today

**The predicate** (/home/user/Levonis/worker/lib/listing.ts)
- `listedSql` (:191-196) is `status='active'`, plus not held (the `product_completeness.held=1` clause), plus the V2 clause (:133-134): `product_pricing_state` has `mode='engine'` and `pricing_method IS NOT NULL` and a `pricing_v2_sku_results` row exists.
- `unlistedIds` (:235-255) fails closed.
- `optimisticListed` / `runListed` (:107-173) use regex fallbacks for databases without 0184 or 0189; without 0189 the clause becomes `AND 0` and nothing is listed.
- Helpers: `listedProductBySlug` (:176), `isV2Published` (:264).
- /home/user/Levonis/worker/lib/needsPricing.ts:6-23 computes the same V2 test.
- Completeness hold:
  - The switch `catalogHideIncomplete` ships ON (0184:56).
  - Required codes: NAME_AR, PRICE, COST, ENGINE_INPUTS, IMAGE, CATEGORY, PACKAGE_WEIGHT, PACKAGE_BOX (/home/user/Levonis/worker/lib/productCompleteness.ts:6-26).
  - A catalog-only product would therefore be held for PRICE and COST.
- The guard test /home/user/Levonis/tests/listingPredicateGuard.test.ts lists 28 customer files that must use the predicate.

**Customer reads that apply it**

| Surface | Location |
|---|---|
| Listing | /home/user/Levonis/worker/routes/products.ts:3246, :3369 (cap `LISTING_CANDIDATE_CAP=300` at :3102) |
| Search | products.ts:3408-3445; /home/user/Levonis/worker/routes/communitySearch.ts:374, 559 |
| Category pages | /home/user/Levonis/worker/routes/catalog.ts:126, 197; catalogMembership.ts:71-88, 184; /home/user/Levonis/worker/lib/catalogPresentation.ts:107 |
| Product page | products.ts:4000-4005 (anonymous edge cache); quote at :4111-4115 |
| Home | /home/user/Levonis/worker/lib/homeShelves.ts:66-210; products.ts:4353 (open box), :4410-4578 |
| Public API v1 | /home/user/Levonis/worker/lib/publicApi/meta.ts:154-160; resources/products.ts:534, 599; shop.ts:71; catalog.ts:152 |
| Sitemap | /home/user/Levonis/worker/routes/seo.ts:311 |
| Social preview | /home/user/Levonis/worker/lib/socialPreview.ts:363 |
| Compare | /home/user/Levonis/worker/routes/compare.ts:510-517 (COMPARE_NOT_VISIBLE), :816, :965, :1033 |
| Favourites | /home/user/Levonis/worker/routes/profile.ts:332, 356; communityFavorites.ts:78 |
| Recommendations / assistant | /home/user/Levonis/worker/routes/support.ts:1354-1851; printerFinder.ts:57-64; printerFits.ts:243-333 |
| Community posts | communityPosts.ts:235, 664 |
| RPC | /home/user/Levonis/worker/entrypoints/CatalogEntrypoint.ts:63 |
| Reviews / returns | reviews.ts:843; returns.ts:1456 |
| Stock alerts | marked unavailable but stay armed (/home/user/Levonis/worker/lib/stockAlertResolve.ts:503-527, :1108) |

- Telegram bots read no products.
- The search index is built for every `status='active'` product (/home/user/Levonis/worker/lib/search/store.ts:519, 615); the predicate is applied at query time.

**Purchase paths and their refusals**

| Path | Location and refusal |
|---|---|
| Cart add | /home/user/Levonis/worker/routes/cart.ts:2098 (listed, else 404); SKU-strict refusal at :2171-2173 and :2639-2641 |
| Cart read | cart.ts:756-757, :726-744 (PRODUCT_CURRENTLY_UNAVAILABLE) |
| Checkout | /home/user/Levonis/worker/routes/orders.ts:2248-2255 (unlisted lines refused before pricing); second guard at :2722-2723 (`doc.sku_strict !== true \|\| price_source !== 'sku'` gives productsUnavailable) |
| Quick Buy | /home/user/Levonis/worker/lib/quickBuy/session.ts:551-553; finalize.ts:443-451 (gives up if not V2-published) |
| Gifts | /home/user/Levonis/worker/lib/gifts/selection.ts:148-149, 170-171; a granted gift is honoured with its frozen value (cart.ts:1916-1920, orders.ts:2602) |
| Bundles / mystery | /home/user/Levonis/worker/lib/bundleComposition.ts:1025; bundleRead.ts:1206; routes/bundles.ts:132, 254; mysteryDraw.ts:485-490 |
| Trade-in | /home/user/Levonis/worker/lib/tradeIn.ts:1226 (target), :1314 (targets), :658 (`needsPricingIds` for valuation) |
| Price reports | /home/user/Levonis/worker/routes/priceReports.ts:168-173 |
| Print-quote materials | printQuote/repository.ts:323, 378 |

- Merchant stores sell only `community_products` (0126:216-221, 0152), so they never touch platform products.

**How price is rendered**
- Server card: `publicWithDisplayPrice` (products.ts:2524-2600) always resolves a number.
- Server page: `catalogProductDetail` (products.ts:3737-3993) always emits `pricing`, `membership_preview`, `price_levels`, `pricing_modes`, priced `warranty_plans` and `availability`.
- Client card: /home/user/Levonis/src/components/CardPrice.tsx:50-56 and :129-136 render `money(display_price_iqd ?? price_iqd)`; /home/user/Levonis/src/components/home/ProductCard.tsx:131, :209 do the same.
- Client page: /home/user/Levonis/src/pages/Product.tsx:2735-2753 renders the amount plus `priceUnavailable` («أكمل الاختيار لعرض السعر النهائي», :170/:243/:318). The buy button is gated by `canBuy` (:2463-2470).
- **There is no "no price" UI state anywhere.** Unpriced products are simply 404 or absent. A price-0 row would render "0".
- There is no JSON-LD Offer markup.

---

### 3. Existing import machinery

**CSV/ZIP import** (/home/user/Levonis/worker/routes/adminImport.ts)
- Routes: `/template`, `/export`, `/preview`, `/confirm`, `/history`, `/:id/report`, mounted at `/api/admin/import`.
- Limits (:145-162): `MAX_CSV_BYTES` 4 MB, `MAX_ZIP_BYTES` 40 MB, `MAX_ZIP_FILES` 400, `MAX_PRODUCTS` 500, image cap = `IMAGE_SOURCE_CAP` 8 MB.
- Preview writes no DB rows (only R2 and the `product_imports` row with its payload, 0024:20). `resolveImages` (:965-1054) fetches every URL cell inline through `ingestImageUrl` with **no budget**.
- **Likely bug:** `loadExisting` (:1189-1196) binds 2×N parameters. On live D1, which allows 100 bound parameters (/home/user/Levonis/tests/fixtures/d1Limits.ts), more than 50 rows would fail. I inferred this from the code; I did not run it.
- Confirm (:1860-2214):
  - Takes a lease with `apply_token` (5 minutes, :1626, :1674-1740).
  - Each product is one `planProductSave` plus `saveProductAtomic` batch, with the checkpoint row last (:2063-2122).
  - The `product_import_items` checkpoint (0099:678-695) is fenced by trigger `trg_product_import_item_lease_fence` (0099:699-720); a stale executor's whole batch aborts.
  - Price cells are pinned and reported as `PRICING_V2_MANAGED` (:2108-2109).
  - New slug via `uniqueProductSlug` (:2277).
  - Re-runs match existing products by `sku` or `slug` only.
- /home/user/Levonis/worker/lib/importApply.ts:1-36: rows are resolved into the same document and relations payload the admin form uses. Ids are reused (groups and values by name, images by URL), and a missing collection means "preserve".

**The single write path** (/home/user/Levonis/worker/lib/productPersistence.ts)
- `planProductSave` (:2570-3282). The clean start (:2639-2651, `pinLegacyDocMoney` / `pinLegacyRelationMoney` in /home/user/Levonis/worker/lib/pricingEngine/v2/legacyMoney.ts:154-165, 282+) means a new product is born at price 0 with no ladder or cost, and stays hidden until its V2 write.
- Other gates in the planner:
  - Composition rows are refused (:2595-2637).
  - Costs are carried forward for non-owners (:2479-2493, :2660-2668).
  - `SKU_TAKEN` on a duplicate SKU (:2678-2693).
- The same batch also writes search tokens (:3179-3212), translations (:3216), the `ProductAdded` outbox event (:3227-3249) and hashtags.
- `MAX_ROWS_PER_COLLECTION` is 400 (:262).
- Atomicity: `saveProductAtomic` (:3520-3560) is one `db.batch`; audit and detached-media queueing happen only after commit.

**Media pipeline** (/home/user/Levonis/worker/lib/productMediaIngest.ts)
- Conversion: `ingestProductMediaBytes` (:635-715) sniffs the bytes, converts to WebP through the IMAGES binding, and hashes the final WebP with SHA-256.
- Key: `products/<entity>/gallery/<sha>.webp`, where entity defaults to `import` (:668-676; `buildMediaKey` at /home/user/Levonis/worker/lib/mediaStorage.ts:79-87).
- Write order:
  - The cleanup intent row is written in `media_cleanup_jobs` before the conditional R2 put (:164-238, :608).
  - `putMediaObjectIfAbsent` writes the `file_objects` row.
  - An existing object is re-verified (:694-703).
- `verifyStoredProductMedia` (:249+) requires an exact `/files/<key>.webp` URL/key pair, re-reads the bytes, checks the SHA against the content-addressed key (:345-348), and refuses to run without IMAGES (:278-283).
- `ingestProductMediaUrl` (:718-758) fetches through `guardedFetchBytes`.
- Ownership:
  - `isOwnedMediaUrl` / `isSafeMediaKey` (mediaStorage.ts:105-116).
  - `validateProductDoc` refuses any non-canonical media (/home/user/Levonis/worker/lib/productModel.ts:1061-1069).
  - `verifyAndNormalizeProductMedia` (/home/user/Levonis/worker/lib/productMediaWrite.ts:28).
  - Guards: `protectMediaObjectFromCleanup` (/home/user/Levonis/worker/lib/productDeletion.ts:1129); `MEDIA_REFERENCE_SOURCES` coverage (/home/user/Levonis/worker/lib/mediaRefs.ts:179). Any new media-bearing column must be classified there or cleanup halts.
- Caps (/home/user/Levonis/worker/lib/imageConvert.ts:44-94): 8 MB source and output; stored size at most 2048² pixels and 3072 px on the edge.
- Stored small copies are kept in R2 (/home/user/Levonis/worker/lib/imageVariants.ts; DECISIONS row 226).

**TXT round trip** (/home/user/Levonis/worker/routes/template.ts)
- Routes `/blank`, `/export/:productId`, `/parse`, `/apply`, `/parse-zip`, `/apply-status` (:2131-3531).
- Limits: `MAX_TEMPLATE_CHARS` 1.5 M, ZIP 15 MB and 100 files (:154-156). The apply fingerprint is deduplicated for 15 minutes (:1889).
- When a supplied image URL fails, the importer reads that product's page for its images, with a budget of 48 fetches / 96 MB (:2626-2660).
- Data file: 25 products (/home/user/Levonis/worker/lib/productDataFile.ts:45); preview budget 950 statements (/home/user/Levonis/worker/routes/templateDataFile.ts:148-170).
- Docs: /home/user/Levonis/docs/IMPORT_TEMPLATE.md:203-205 (format table), :139 (a `select` spec value must be one of its declared options); /home/user/Levonis/docs/TXT_IMPORT_PARITY.md.

**D1 limits**
- 1,000 statements per invocation (/home/user/Levonis/worker/lib/quarterHourBudget.ts:46).
- 100 bound parameters and 5 compound terms per statement (d1Limits.ts).
- A product's search rows cost 2 statements plus 1 per token row (store.ts:572-600).

---

### 4. Request and notify-me features

**Back-in-stock alerts (`product_stock_alerts`)**
- Table (/home/user/Levonis/migrations/0092_stock_alerts.sql:102-141):
  - `kind product|option_value|color|combination`.
  - `option_value_id` and `color_id` are NOT NULL DEFAULT '' so that `UNIQUE(user_id, product_id, kind, option_value_id, color_id)` actually works; the rationale is at :30-60.
  - States `armed|firing|notified|cancelled|dead`.
  - `user_notification_channels` (:168).
- Routes (/home/user/Levonis/worker/routes/stockAlerts.ts:384-671):
  - Rate limits: `stock-alert-arm` 30 per 600 s; `stock-alert-save` 20 per 600 s.
  - `MAX_ARMED_PER_USER` 40, `MAX_WISHES_PER_PRODUCT` 20 (:102-107).
- Sweep: `sweepStockAlerts(env, 60, 200)` (/home/user/Levonis/worker/lib/jobs.ts:571); /home/user/Levonis/worker/lib/stockAlerts.ts:838.

**«لكيتها بمكان أرخص» price reports — the closest analogue to a price request**
- Table `price_reports` (/home/user/Levonis/migrations/0093_price_reports.sql:70-95): `state new|reviewed|actioned|rejected`, indexes on `(state, created_at)` and `(product_id, created_at)`.
- POST (/home/user/Levonis/worker/routes/priceReports.ts:147-253):
  - Rate limit 5 per hour.
  - One open report per user per product (`REPORT_ALREADY_OPEN`).
  - Telegram admin topic `report` via `announceAfterResponse`.
- The admin list orders by `created_at` only (:307-389).

**Other pieces**
- Admin notifications: Telegram topics only, from a fixed key set (/home/user/Levonis/worker/lib/telegramAdmin.ts:122-135; /home/user/Levonis/worker/lib/adminTopicRouting.ts:445-512). There is no in-panel admin notification centre; only merchants have one.
- Customer in-app notifications: `user_notifications` (0045:36), /home/user/Levonis/worker/lib/notifications.ts.
- Rate limiting: a D1 fixed window keyed by user, else IP (/home/user/Levonis/worker/lib/ratelimit.ts:10-64; table at 0001:55).
- Nothing else resembles a price request. `direct_requests` (0151) is merchant print quotes.

---

### 5. Admin product list and the needs-pricing queue

**List API: `GET /api/admin/products-v2`** (/home/user/Levonis/worker/routes/adminProducts.ts:622-861)
- Filters: `search`, `status`, `brand`, `catalog`, `stock`, `days`, `featured`, `needs_pricing=1` (:741, `NOT v2Published`), `price_min`/`price_max` (from the V2 from-price), `incomplete`.
- Sorts (`ORDERS` map, :771-780): `updated`, `newest`, `oldest`, `price_asc`, `price_desc`, `sales`, `stock`. `limit` is at most 100.
- A "requests" sort fits here as a subquery count.

**Queue API: `GET /needs-pricing`** (:875-881, implemented in /home/user/Levonis/worker/lib/pricingEngine/v2/queue.ts:193-300)
- `queueCandidates` (:113-157) takes at most `QUEUE_LIST_MAX` = 200 candidates, `ORDER BY p.updated_at DESC` (:129).
- Each candidate is then run through the engine (`loadQueueReads`, `evaluateDesired`), filtered in memory by `QUEUE_FILTERS` (all, ready, saved, usd, cost, below_min_profit, purchase_review), and paged 20 per page. The response carries a `truncated` flag.
- Counts come from `v2PublicationCounts` (:27-57).

**UI**
- /home/user/Levonis/src/components/adminProducts/NeedsPricingQueue.tsx (filters at :69, fetch at :139).
- /home/user/Levonis/src/components/AdminProducts.tsx: sort select :1015-1022, needs-pricing toggle :957-960, banner :398/:800-806.

---

### 6. Search, facets, compare

**Search**
- There is no FTS. Products are indexed in `search_tokens (product_id, token, weight)` and `search_synonyms` (/home/user/Levonis/migrations/0089_search_index.sql:13-70).
- Indexed fields are name ×3, brand, sections, hashtags, sku, option and colour names, and description (low weight). Specs are not indexed (productPersistence.ts:3191-3209).
- The index is written in the same batch as the product save.
- Catch-up: `INDEX_STAMP '#doc:4'` (store.ts:88). `backfillSearchIndex` handles 50 products per tick within a budget (store.ts:602+; jobs.ts:225-255; worker/index.ts:1277-1282).

**Facets**
- Filtering and sorting happen in memory over at most 300 candidates (/home/user/Levonis/worker/lib/listingFacets.ts). `ListingItem.price` is a non-null number.
- Spec facets: `FACET_FIELDS` technology, max_colors, build_volume, enclosed, skill_level, material_type, diameter, color_name (/home/user/Levonis/packages/catalog/src/discovery.ts:43-52).
- Sorts: relevance, newest, price_asc, price_desc, name, available, direct (:31).

**Compare**
- `/api/compare` and `/candidates` (compare.ts:463, 1010).
- Specs are read through /home/user/Levonis/worker/lib/compareSpecs.ts using the template `compare` annotations; prices go through `resolveVariantPricing`.

---

### 7. Cron and background work

**Live bindings** (/home/user/Levonis/wrangler.jsonc)
- DB (:160), BUCKET / R2_PUBLIC / R2_PRIVATE (:169), IMAGES (:207), ASSETS.
- Crons (:257): `*/15`, `* * * * *`, `0 */6`.
- There are no Queues, Durable Objects, KV or Workflows. The `Q_*` queue producers and service bindings are optional and absent on the live Worker (/home/user/Levonis/worker/lib/types.ts:131-145); service bindings exist only in the dark environment (wrangler.jsonc:468-473).
- Platform probes for Workflows (h) and DO SQLite (i) are still "unverified" (/home/user/Levonis/docs/architecture/04-DECISIONS.md:236-237).

**`scheduled()`** (/home/user/Levonis/worker/index.ts:1176-1296; dispatch in /home/user/Levonis/worker/lib/cronSchedules.ts)
- Every minute: order finance recovery and Quick Buy finalisation only.
- Every 6 hours: FX.
- Every quarter hour, all in one invocation on a counted DB:
  - staff reconciliation (one job, one order)
  - `runDurableJobs` (about 30 steps, jobs.ts:320-728)
  - upload sweep
  - image-variant sweep (no D1)
  - then, sequentially: search catch-up, FX-5 sweep (200), completeness (60)
- Budgets (quarterHourBudget.ts:46-80): limit 1000, reserve 50, so the tick may spend 950 in total.

**Precedents for a cursor-driven job**
- `finance_wage_preview_jobs` (cursor, state) (0169:3-17).
- The staff recalculation runs one order per tick, and the owner's open page drives one order per request.
- The `product_imports` lease plus checkpoints.
- The search index's version stamp.
- `waitUntil` is used only for post-response sends (adminTopicRouting.ts:493-512). The tick's completeness flip calls `purgeCatalogueFromJob` (index.ts:1290-1291; /home/user/Levonis/worker/lib/edgePolicy.ts:387-439).

---

### 8. Outbound fetch

**SSRF guard** (/home/user/Levonis/worker/lib/fetchGuard.ts)
- `validateOutboundUrl` (:97-111): http(s) only, no credentials, no private, loopback, CGNAT or mapped-IPv6 literals.
- `guardedFetchBytes` (:230-344): manual redirects re-validated on each hop, at most 3 redirects by default, 10 s total deadline, streamed byte cap, optional `allowHost`, shared fetch/byte budget.

**Vendor page reading** (/home/user/Levonis/worker/lib/pageImages.ts:13-21, 54-68; /home/user/Levonis/worker/routes/media.ts:47-62)
- Only `VENDOR_HOSTS` (bambulab.com and .cn, makerworld, qidi, biqu, esun, creality) may be parsed as HTML.
- **Policy: only image addresses are read. "No prices, titles, descriptions… no product copy is ever lifted."**
- Per request: 40 fetches / 64 MB (media.ts:212), at most 10 images per page.
- `fetchPageImages` (/home/user/Levonis/worker/lib/productPageImages.ts:149-163) has a 4 MB page cap and **no host allow-list**.
- Bambu images are now served from `store.bblcdn.com` (DECISIONS row 151). A trimmed Bambu page fixture exists at /home/user/Levonis/tests/fixtures/bambuPlaBasicPage.html.

**Other outbound callers**
- Link cards (/home/user/Levonis/worker/lib/linkCards.ts:15-21, 108-150): a fixed host allow-list, 5 s, 2 MiB.
- FX providers (/home/user/Levonis/worker/lib/fx/providers/transport.ts:1-80): constant URLs, no redirects, 8 s per attempt, SSRF guard.

---

### 9. Security constraints

**FINANCIAL_FIELDS**
- /home/user/Levonis/worker/lib/adminScope.ts:243-700 and its identical copy /home/user/Levonis/packages/platform-kit/src/scope.ts:41.
- It covers cost, supplier, FX, freight, margin, replacement, `v2_*` and similar keys. Any new private key must be added to both (DECISIONS rows 220 and 233).
- Cost is visible to the owner only: `PRIVATE_DELEGATION_ENABLED=false` (adminScope.ts:91). `V2_STAFF_SEES_USD=true` (:102).

**Leak scanner** (/home/user/Levonis/tests/fixtures/costlyProduct.ts:119-165)
- It flags:
  - any key matching `/cost/i` that carries a number
  - any FINANCIAL_FIELDS key that carries a value
  - price-chain and V2 result keys
  - a non-empty `source_url` inside media (:97)
- Customer arithmetic allow-lists: /home/user/Levonis/worker/lib/customerPricing.ts:43-76.
- `projectPublic` blanks `media.source_url` (productModel.ts:1683). Whether staff may see supplier links is an open question (/home/user/Levonis/tests/leakVerify_variants_staff_product_media_supplier_source_url.test.ts).

**Money authority**
- /home/user/Levonis/worker/lib/moneyAuthority.ts:1-80 governs gifts, coupons, member price rules and similar money acts; the owner-only acts are listed there.

**What an importer must never write**
- Any price or cost column: product, options, colours, variants, cells, routes; `original_price_iqd`, `direct_surcharge_iqd`, route commissions.
- `product_pricing_state`, `pricing_price_points`, `pricing_preorder_discounts`, `pricing_v2_sku_results`, `product_sku_prices`, `pricing_inputs`/`pricing_rules`. Writing these would publish the product or bypass the preview hash.
- `pricing_legacy_snapshots`, `product_completeness` (computed), inventory lots, procurement tables.
- A supplier or US list price under a non-financial name.
- `stock = NULL` as a sellable state.
- External image URLs (only owned `/files/*.webp` is allowed).
- Arabic copied into ckb slots.

---

### Gaps that would block each goal

**(a) Catalog-only visibility**
1. The single `listedSql` is used for both display and purchase: cart add (cart.ts:2098), quote (products.ts:4114), Quick Buy (session.ts:551), trade-in target (tradeIn.ts:1226), favourites, price reports. It must be split into "visible" and "sellable", and every call site in listingPredicateGuard reclassified. Today the cart resolver would price a visible-but-unpriced row from its ladder (0); only the orders.ts:2723 belt stops it at checkout.
2. There is nowhere to store the state. `status` has a CHECK that cannot be widened, and `products` carries finance-clock triggers. This needs a side table plus a third deploy-ahead clause in the `runListed` regex fallbacks (listing.ts:122-170).
3. The completeness hold (switch ON) hides products missing PRICE, COST and PACKAGE_*. Catalog-only products need an exemption.
4. Every price projection (card, page blocks, listing sort and filter, public API, compare, CardPrice/ProductCard/Product.tsx) assumes a number. A null "price unavailable" state is needed end to end, with ar/en/ckb strings.
5. Edge-cache purge on the state flip, and category counts, also need handling.

**(b) Price requests with a unique-requester count and a priority queue**
1. There is no table. One would model the '' vs NULL uniqueness rule from 0092 and the one-open-per-user rule from `price_reports`.
2. The queue takes 200 candidates by `updated_at` *before* the request count could be considered, and evaluates each through the engine. With about 1,115 unpriced products, the request sort must happen in candidate SQL (queue.ts:113-139) and in `ORDERS` (adminProducts.ts:771).
3. There is no admin in-panel notification centre (Telegram topics only, a fixed set).
4. Notifying requesters needs a hook on the first V2 publication (pricingEngine/v2/firstWrite.ts) or an unlisted→listed sweep like stock alerts.
5. Anonymous requests cannot be uniquely counted; the rate limiter falls back to IP.
6. A new table must be registered in productDeletion.ts (child-table list around :100-135), /home/user/Levonis/packages/contracts/src/ownership.ts, /home/user/Levonis/worker/lib/schemaVersion.ts:46,66, and media coverage if it carries media.

**(c) Per-product sequential importer with checkpoints**
1. No Queues, DO or Workflows are bound. The quarter-hour D1 budget is already shared; a new step needs its own share, and one product can cost hundreds of statements against 1,000.
2. Checkpointing exists only as the preview-payload, admin-actor CSV lease (`product_imports` / `product_import_items`).
3. CSV preview: `loadExisting` will likely exceed 100 parameters above 50 rows, and image URL fetches have no budget.
4. There is no external-source identity column (handle, variant id, page URL) for idempotent re-runs. Only sku/slug matching and `product_images.source_url` exist.
5. Lifting names, specs, descriptions or options from bambulab.com contradicts the documented images-only rule (pageImages.ts:19-21; media.ts:57-58) and needs an owner decision row. Translation must use the local dictionary only: imported English becomes `review_needed`, and ckb may never copy Arabic.
6. `completenessAfterWrite`, cache purge and audit run only on admin routes; a background importer must invoke them itself.

**(d) Variant- and colour-level images**
1. The schema supports binding images, but only one selector per image. A model×colour image needs a `product_variants` row per combo (stock and price columns, engine-lock triggers).
2. The existing caps still apply: 400 rows per product and 8 MB / 2048² per picture. The IMAGES binding is required.
3. Bambu `source_url` provenance on images is owner-only and flagged by the leak scanner.
4. Any new media column must join `MEDIA_REFERENCE_SOURCES`.

**(e) Typed specifications with provenance**
1. `spec_fields` is a string map validated only against template definitions; select values must match declared options.
2. Free spec groups are untyped text with a unit.
3. There are no per-variant typed specs beyond `variant_specs` free text and the dimension columns.
4. There are no provenance fields (source URL, fetch time, verifier) for any spec. Only translations carry `source_hash` and status.
5. Facets read a whitelisted handful of fields, and search ignores specs.
