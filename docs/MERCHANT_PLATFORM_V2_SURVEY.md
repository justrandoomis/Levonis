# Merchant platform v2 — survey appendix (read-only facts at HEAD 1444169f)

## Survey — workspace

## 1. Workspace frame and routing
- **Addresses:** `packages/contracts/src/merchantRoutes.ts` defines `MerchantSection` (L26-46), `SECTION_PATHS` (L49-72), `SECTIONS_WITH_ID` (L75-85), `merchantHref` (L108-146), `readWorkspaceQuery` with its closed query words `status/stock/state/new` (L153-187), `parseMerchantPath` (L206-228) and `hostPath` (`/merchant` becomes `/admin` on the store's subdomain, L240-247). `src/lib/merchantRoutes.ts` re-exports it.
- **Nav:** `src/components/merchant/shell/nav.ts` has `NAV_GROUPS` (L89-100), `NAV` with 20 entries (L102-128), `PHONE_TABS` home/orders/products/store (L131-136) and `badgeCount` (L173-195). `Capability` is only `'always'` (L61, L145), so there is no gating in the UI.
- **Screens:** `src/components/merchant/shell/sections.tsx` holds `SECTIONS`, one lazy screen per section (L41-111). The router is `shell/routeTable.ts`: inbox/<thread> and requests/<id> are marked "AWAY" and open outside the workspace.
- **Frame:** `shell/MerchantShell.tsx` (709 lines) provides the sidebar, rail, phone tabs, ⌘K palette, bell and store status. It has **no motion or section transitions** (imports at L33-57). `useMotion()` is used only in `share/ShareStore.tsx` and `share/OwnerShareMenuItem.tsx`.
- **Mounts:** API routes are mounted at `worker/index.ts` L433-469. SPA routes are `/merchant/*` (`src/App.tsx` L686) and `/admin/*` on the store host (L438).

## 2. Sections: screen → API → state
| Section (path) | Screen | API | State |
|---|---|---|---|
| home `''` | shell/sections/CommandCenter.tsx (404 lines) | GET /api/merchant/attention (merchantWorkspace.ts:132; `setup` source at L252) and GET /analytics/report (merchantAnalytics.ts:77) | EXISTS |
| orders `orders[/id]` | sections/OrdersSection.tsx → dashboard/SalesTabs.tsx `OrdersTab` (L110) and orders/OrderDetailScreen.tsx (469 lines) | merchant.ts GET /orders L1018 (status filter plus keyset only, **no search**), GET /orders/:id L1054, POST /orders/:id/status L1160; merchantOrders.ts GET /:id/timeline L245 | EXISTS. List NEEDS REFACTOR (legacy kit, no bulk actions, no export, no tracking number or internal notes) |
| custom_orders `requests/orders` | SalesTabs `CustomOrdersTab` (L605) | merchant.ts GET /custom-orders/summary L1851 | EXISTS / NEEDS REFACTOR |
| customers `customers[/key]` | customers/CustomerList.tsx, CustomerDetailView.tsx | merchantCustomers.ts L65, L137 | EXISTS (no tags, notes or segments) |
| coupons `marketing/coupons` | SalesTabs `CouponsTab` (L776) | merchant.ts L1741-1827 (fixed_iqd or percent up to 90, min_total, max_uses, starts/ends) | EXISTS |
| products | catalog/CatalogManager.tsx, ProductEditorSheet, VariantEditor, MediaEditor, BulkValueSheet, ImportSheet, InsightsSheet | merchantCatalog.ts L218-1110 (stats L268, export.csv L407, import L483, bulk L586, duplicate L947, insights L1022) | EXISTS |
| collections | CatalogTabs `SectionsTab` → catalog/CollectionsManager.tsx | merchantCatalog.ts L1273-1370 | EXISTS |
| services / showcase | CatalogTabs `ServicesTab` (L61), `ShowcaseTab` (L349) | merchant.ts L1526-1588 / L1614-1681 | EXISTS, NEEDS REFACTOR (legacy `dashboard/ui.tsx`) |
| printers | dashboard/PrintersTab.tsx (**1709 lines**) and workshop/MaterialStockSection | merchantPrinters.ts L153-571 (printers, material-stock, request-prefs, request-matches) | EXISTS, NEEDS REFACTOR |
| costing | dashboard/CostingTab.tsx and workshop/CostingSheet | merchantWorkshop.ts L84-426 | EXISTS |
| requests | sections/RequestsSection.tsx (MyOffersList and CustomOrdersTab) | the board itself lives on the main site at `/requests` | EXISTS (board is outside the workspace) |
| money | finance/MerchantFinance, FinanceLedger, PayoutRequestSheet | merchantFinance.ts L62-186 | EXISTS (no export) |
| analytics | sections/AnalyticsSection.tsx (662 lines) and analytics/charts, chartMath, report | merchantAnalytics.ts:77 (traffic, funnel, products, customers, coupons, governorates, requests, previous period); legacy merchant.ts L1369 | EXISTS (no export) |
| reviews | sections/ReviewsSection.tsx | merchant.ts GET L1293, reply L1326 | EXISTS |
| inbox `inbox[/id]` | inbox/MerchantInbox.tsx | merchantInbox.ts L47, L174 | PARTIAL: list only; a thread opens in `/chat`, which is on the main site when viewed from a subdomain |
| notifications | NotificationsSection → MerchantNotificationCenter + MerchantNotificationPreferences | merchantNotifications.ts L58-87; prefs at merchant.ts L856/L880 | EXISTS |
| store_design `store/design` | storeDesign/StoreDesignPanel.tsx (588 lines) | storeLayout.ts L268-602 (draft, publish, revisions, restore, preview GET/POST, media) | EXISTS |
| store_settings `store/settings` | dashboard/StoreSettingsTab.tsx (1026 lines) and storeSettingsModel.ts | PATCH /store L280-464, POST /store/slug L782, GET /store/share L600 | EXISTS, NEEDS REFACTOR |
| store_delivery `store/delivery` | delivery/DeliverySettingsEditor.tsx | merchant.ts GET L509, PUT L526 | EXISTS |

## 3. Command Center, store CTA and plan gating
- **Attention sources** (merchantWorkspace.ts L140-163): orders by stage, custom orders, inbox, notices, requests, stock low/out, reviews, money, payouts, coupons ending, problems (`StoreProblem`, L73-81) and `setup` (logo, banner, about, phone, delivery, products, design; L252-273). A source that fails to answer is left out rather than shown as zero.
- **KPIs** (`shell/kpis.ts` L36-60): today, the week against the previous week, a 14-day trend and visitors7. All are sliced from the analytics report.
- **`/me`** is merchant.ts L148-179. `can{store, products, orders, offers, analytics, subdomain}` is at L163-170, and `selling` at L172.
- **Tiers:** every merchant benefit requires `'plus'` (worker/lib/entitlements.ts L97-103, L579-585). There are no PRO-only merchant tools apart from `proMerchantBadge` (L137).
- **Where `can` is read:** client-side only `me.can.offers`, in src/pages/Requests.tsx L388/L712. Analytics is gated on the server (merchant.ts L1373 and merchantAnalytics).
- **Store CTA:** `src/components/merchant/StoreCta.tsx` covers four server-driven states.

## 4. Merchant vs a real shop owner
| Capability | State | Evidence |
|---|---|---|
| Staff / roles | MISSING | One owner only: `storeForUser` uses `WHERE s.user_id = ?` (worker/lib/merchantAuth.ts L122-131), and `requireStoreOwner` is at L164. No table exists. |
| Custom domain | MISSING (deliberately) | DECISIONS row 12 (🔴, needs Cloudflare for SaaS cost approval); MERCHANT_PLATFORM.md L64 |
| SEO title / description / OG | PARTIAL | Built automatically from name, description and logo (worker/lib/socialPreview.ts); per-host robots and sitemap in worker/routes/seo.ts. There is no merchant-editable SEO field or column (merchant_stores schema: migrations/0030 L66-104 plus 0123 and later ALTERs). |
| Pages (about, policies, FAQ) | PARTIAL | Storefront routes `/`, `/products`, `/about`, `/reviews`, `/p/:slug` (App.tsx L416-420). Policies allow up to 12 entries of 2000 characters (PATCH L346, rendered in storefront/blocks/About.tsx). There are `faq` (blocks.ts L235) and `about` (L380) blocks. No free-form custom pages. |
| Announcement bar | MISSING | Closest things: the `countdown` block's 'bar' variant (L199), a `text` block callout, `coupon_banner`. Header variants are only overlay/bar/none (schema.ts L24). |
| Promotions / discount rules | PARTIAL | Coupons, compare-at "deals" and countdown exist. No automatic or cart rules, no BOGO, no per-customer limit, no coupons scoped to products. |
| Inventory alerts | EXISTS | `low_stock_threshold` per product and variant (merchantCatalog.ts L147-150); `low_stock` notification (merchantNotify.ts L499); stock badge and `?stock=` filter |
| Bulk edit / import / export | EXISTS for products | See §2. Orders and customers have nothing. |
| Invoices / receipts | PARTIAL | Packing slip only (OrderDetailScreen L166-169, L423-429; orderPrint.css). `worker/routes/invoices.ts` serves customers and admins only. |
| Returns | PARTIAL | returns.ts L243 freezes merchant money, but decisions are admin-only (L571, L602). No merchant returns screen or API. |
| CRM segments / broadcasts | MISSING | Customers list and detail only |
| Auto-replies / quick replies | MISSING | Nothing in chats.ts, chatCommerce.ts or merchant/inbox |
| Vacation mode / business hours | PARTIAL | Pause switch (`open`, PATCH L358-404, sets status `paused`). Hours are display rows (`sanitizeHours` L345, shown in blocks/Contact.tsx when `show_hours`). No "open now", no scheduled vacation, no away message. |
| Payment methods | MISSING (by design) | storeOrders.ts L30-33: wallet only, `payment_method_id` fixed to 'wallet', no cash on delivery. The standing rule forbids a new wallet. |
| Telegram / WhatsApp integrations | PARTIAL | Merchant notifications also go out through the Telegram/WhatsApp/email outbox (merchantNotify.ts L261-273), with switches in MerchantNotificationPreferences (L86). Account linking lives in main-site settings (telegram.ts L178). No merchant bot or WhatsApp ordering. |
| Reports export | PARTIAL | Products CSV only |
| QR / marketing kit | EXISTS | share/ShareStore.tsx (link, native share, QR as PNG, unfurl preview, app icon), mounted in StoreSettingsTab L753-755 and the storefront owner menu (Storefront.tsx L50). No printable flyer or poster. |
| Subdomain / app icon | EXISTS | Slug change with parking (L782; UI at StoreSettingsTab L958-969). Icons refresh after the logo changes (merchant.ts L448-450, worker/lib/storeIcons.ts, migration 0123). `can.subdomain` is returned but never read. |

## 5. Store designer: media, background, speed
- **Blocks:** 27 types in `packages/storeLayout/src/blocks.ts` `BLOCKS` (L99-390): hero, banner, image_text, products_grid, products_carousel, featured_products, collections, deals, coupon_banner, countdown, services, showcase, reviews, faq, text, gallery, video, social_links, cta, contact, delivery_info, printers, custom_request_cta, stats, info_cards, tabs, about.
- **Limits:** `MAX_BLOCKS` 40 and `MAX_LAYOUT_BYTES` 64 KB (schema.ts L57-66).
- **Theme choices** (tokens.ts): 11 tokens, all closed enums (L19-32), 7 presets (L92). Store themes are always dark grounds, by decision (L10-12).
- **Media:** only two kinds, `image` and `video` (refs.ts L29-37). Image files may be jpg, png, gif, webp or avif; video files mp4 or webm.
- **GIFs:** they pass through store uploads unconverted (uploads.ts L453), but animated GIFs are refused for product images (`IMAGE_ANIMATED_GIF_UNSUPPORTED`, uploads.ts ~L384-420).
- **Video:** the merchant's own uploads only, with a 1 GB quota (uploads.ts L46) and sniffing. The `video` block (L268) has one variant, 'inline'.
- **Background image, video or GIF:** MISSING. `surface` is one of five preset grounds.
- **Profile:** logo and banner are images only (PATCH L318-325). No video banner or animated avatar.
- **Reels:** MISSING. No reel feed; "reel" appears only in unrelated files. The community's `timelapse` post kind belongs to the other workflow.
- **Measuring site speed:** MISSING. There is no PerformanceObserver, web-vitals or PSI code anywhere in src, worker or scripts.
- **Builder features:** preview at 360/768/1280, autosave, publish with a diff, history and restore, and 7 starter templates.

## 6. Merchant-facing string files and Sorani
Counts: `OWNER` = number of "OWNER: Sorani to be written by hand" markers (Arabic standing in for Sorani); `S` = lines containing Sorani-only letters. Both are approximate.

**String tables**
| File | OWNER | S | Sorani state |
|---|---|---|---|
| shell/strings.ts | 16 | 53 | PARTIAL |
| catalog/strings.ts | 159 | 166 | about half |
| finance/strings.ts | 79 | 51 | mostly Arabic |
| share/strings.ts | 27 | 24 | PARTIAL |
| storeDesign/catalog.ts | 1 | 111 | mostly real |
| storeDesign/samples.ts | 0 | – | real |
| storeDesign/refusal.ts | 1 | 17 | mostly real |
| workshop/reasons.ts | 1 | 23 | mostly real |
| orders/labels.ts | 0 | – | real |
| orders/timelineText.ts | 1 | – | real |
| notifications/notificationKinds.tsx | 1 | – | mostly real |
| src/lib/refusalStrings.ts | 36 | 238 ckb entries | PARTIAL |

**Screens with inline `loc()` and OWNER markers:** StoreSettingsTab 39, DeliverySettingsEditor 27, CollectionsManager 23, SalesTabs 17, CommandCenter 16, StoreCheckout 15, CheckoutDeliveryPanel 12, AnalyticsSection 10, MerchantCartView 7, MerchantFinance 5, StoreDesignPanel 4, Storefront 4, StorefrontProduct 4, MerchantDashboardPage 3, MerchantNotificationCenter 3, MerchantNotificationPreferences 3.

**No markers:** PrintersTab, CostingTab, StoreCta, the storeDesign pickers/flows/panels/Block*, MaterialStockSection.

**Worker side:** merchant notification titles are ar/en; ckb exists only in the matching_request meta (merchantNotify.ts L440-452). `worker/lib/notifications.ts` has no ckb.

**Conflict to settle before writing real Sorani:**
- MERCHANT_PLATFORM.md §8 (L276-281) says Sorani is never machine-written.
- COMMUNITY_ECOSYSTEM.md D6 (L138) reverses that, but for community strings only.
- `tests/merchantWorkspaceShell.test.ts` L315-330 fails any new ckb in `shell/` that does not already appear elsewhere in `src`.

So real Sorani for merchant strings needs a DECISIONS row and a change to that test.

## 7. Design-system debt (raw palette classes; the rule is theme tokens only)
- **Raw palette counts per file:** StoreSettingsTab 86, pages/MerchantStore.tsx 78, SalesTabs 67 (+1 hex), PrintersTab 52 (+9 hex), dashboard/ui.tsx 43, CostingTab 36, MerchantStart 34, MerchantCartView 30, ShareStore 29 (+4 hex), CatalogTabs 15, MaterialStockSection 8 hex. For example, StoreSettingsTab L573 uses `bg-black/30 border-white/5` and `text-red-400`.
- **Legacy kit:** `dashboard/ui.tsx` (`Btn`, `Card`, `Input`, `Toggle`, `Chip`, `ChipListEditor`) is still imported by CatalogTabs, SalesTabs, StoreSettingsTab, PrintersTab, CostingTab, CatalogManager, ReviewsSection, MerchantInbox and workshop/reasons.
- **Legacy page:** `pages/MerchantStore.tsx` is the old merchant page, still the fallback in `CommunityStorePage.tsx` L27.
- `dark:` variants: none.

## 8. Budgets and constraints
- **Budgets in `tests/bundleBudget.test.ts`:** CSS 60 KB (L63), entry 120 KB (L52), any chunk 250 KB (L54), initial payload 240 KB (L61), storefront 47 KB (L303), workspace shell 25 KB and its closure 32 KB (L359-360).
- **Migrations:** the latest is `0154_community_social.sql`. The community workflow may claim 0155 at the same time, so coordinate the number.

## 9. Reuse list
- **UI primitives in `src/components/ui/`:** DataList, KpiTile/Sparkline, Money, Sheet, Overlay, Menu, CommandPalette, ConfirmDialog, Toast, Segmented, Switch, Tabs, AsyncStates, DashboardSkeletons.
- **Adding a workspace section** takes four edits: the contract's `SECTION_PATHS`, `NAV`, `SECTIONS` and `routeTable`.
- **Other patterns to reuse:**
  - the attention `source()` pattern for new badges;
  - `BLOCKS` plus `normalizeLayout` and `mediaKey` for new block types or background media (renderers in storefront/blocks, copy in storeDesign/catalog.ts);
  - GET /layout/media as the media picker;
  - storeSettingsModel `LIMITS`;
  - ShareStore, the analytics report, `merchantRefusal` / `refusalStrings`, and `useMotion()`.

Key files: /home/user/Levonis/packages/contracts/src/merchantRoutes.ts, /home/user/Levonis/src/components/merchant/shell/nav.ts, /home/user/Levonis/src/components/merchant/shell/sections.tsx, /home/user/Levonis/src/components/merchant/shell/MerchantShell.tsx, /home/user/Levonis/src/components/merchant/shell/routeTable.ts, /home/user/Levonis/src/components/merchant/shell/strings.ts, /home/user/Levonis/src/components/merchant/shell/kpis.ts, /home/user/Levonis/src/components/merchant/shell/sections/CommandCenter.tsx, /home/user/Levonis/worker/routes/merchant.ts, /home/user/Levonis/worker/routes/merchantWorkspace.ts, /home/user/Levonis/worker/routes/merchantCatalog.ts, /home/user/Levonis/worker/routes/storeLayout.ts, /home/user/Levonis/worker/routes/uploads.ts, /home/user/Levonis/worker/lib/entitlements.ts, /home/user/Levonis/worker/lib/merchantAuth.ts, /home/user/Levonis/worker/lib/merchantNotify.ts, /home/user/Levonis/packages/storeLayout/src/blocks.ts, /home/user/Levonis/packages/storeLayout/src/tokens.ts, /home/user/Levonis/packages/storeLayout/src/refs.ts, /home/user/Levonis/packages/storeLayout/src/schema.ts, /home/user/Levonis/src/components/merchant/dashboard/StoreSettingsTab.tsx, /home/user/Levonis/src/components/merchant/dashboard/SalesTabs.tsx, /home/user/Levonis/src/components/merchant/dashboard/ui.tsx, /home/user/Levonis/src/components/merchant/storeDesign/StoreDesignPanel.tsx, /home/user/Levonis/tests/bundleBudget.test.ts, /home/user/Levonis/tests/merchantWorkspaceShell.test.ts, /home/user/Levonis/docs/MERCHANT_PLATFORM.md, /home/user/Levonis/docs/COMMUNITY_ECOSYSTEM.md

## Survey — builder

## Store builder and themes: what the code does today (read-only audit)

### 1. Layout contract: packages/storeLayout/src
- **schema.ts**: `StoreLayout {schema_version:1, theme, tokens, header:{variant}, footer:{variant}, blocks[]}` (54-61). `HEADER_VARIANTS` overlay|bar|none (24). `FOOTER_VARIANTS` minimal|standard|none (30). `Visibility {mobile, desktop}` only (34-39). Caps: `MAX_BLOCKS=40` (64), `MAX_LAYOUT_BYTES=64KB` (70), `MAX_REQUEST_BYTES=256KB` (72). **EXISTS**
- **blocks.ts**: data-driven registry. `ScalarSpec` types are bool/enum/int/text/media/link/date/ref/refs/set/socials, plus `list` (24-45). `BlockDef.requires:'merchant_video_upload'` (83). There are **27 blocks** (99-389). Media per block:
  - hero: variants profile|cover|split|minimal. `image` is **kind 'image' only** (111), with headline, subheadline, show_* toggles, cta, align.
  - banner: image only (128), overlay dim|none, height short|medium|tall.
  - image_text (138), gallery (list of up to 24 {image, caption}, variants grid|carousel, 255-266).
  - video: variant `inline`, max 4, `video` kind video, `poster`, caption, `autoplay` bool (268-279).
  - Others: faq (235), countdown bar|card (199), text, cta, contact, delivery_info, printers, custom_request_cta, stats, info_cards, social_links, tabs (`TAB_KINDS` products|collections|deals|services|showcase|about, 95/370), about (show_policies, 380).
- **tokens.ts**: closed enums only. The header comment (1-16) says there is no colour picker, font field or CSS box, and that store themes are always dark. Tokens:
  - `ACCENT_TOKENS` store + 7 colours (19); `SURFACES` glow|ink|graphite|carbon|midnight (22); `RADII` (23); `DENSITIES` (24).
  - `TYPOGRAPHY` standard|bold|refined|compact (25). These only change Cairo's weight and scale.
  - `CARD_STYLES` (26), `PRODUCT_CARDS` tile|bordered|overlay|minimal (27), `IMAGE_RATIOS` (28), `SECTION_SPACING` (29), `GRID_COLUMNS` 2|3 (31), `WIDTHS` (32).
  - 7 `THEME_PRESETS` (92-124).
- **refs.ts**: `MediaKind='image'|'video'` (29). `OBJECT_NAME` accepts **.gif** for images and mp4|webm for video (34-37). `mediaKey` is owner-scoped and accepts only a storage key, never a URL (58-79). `mediaSrc` → `/files/<key>` (82-85). `LINK_ROUTES` (99), `safeExternalUrl` https only (125), `SOCIAL_PROVIDERS` 8 (255-264).
- **starters.ts**: 6 starters plus classic (34-109), `starterLayout` (112). **EXISTS**
- **normalize.ts**: an unknown block type is reported non-fatally and dropped (353). An unknown top-level key is reported (491). `unsupported_schema_version` is fatal (455-461). So adding blocks, settings or tokens to v1 is safe.
- **verify.ts**: `walkFields` visits every `media` spec generically, so any new media field gets its ownership check for free. The worker then checks mime against `file_objects` (worker/lib/storeLayout.ts `verifyLayoutRefs` 483; mime-kind check ~522). Layout JSON is already registered as a media-reference source (worker/lib/mediaRefs.ts:333-334). **EXISTS**
- **data.ts**: `BlockData` covers products, picked, collections, services, showcase, reviews, printers and coupons (254-263). There are **no posts, reels or video rows**. `CollectionData` has no image (180-185).

### 2. Server routes and migrations
- worker/routes/storeLayout.ts, mounted at `/api/merchant/store/layout` (worker/index.ts:446):
  - GET / (268), PUT /draft (336, version-fenced, 409 DRAFT_CHANGED), POST /publish (385).
  - GET /revisions (430) and /revisions/:rev (469), POST /restore/:rev (476).
  - GET /preview (546), POST /preview for the template gallery (581), GET /media?kind=image|video for the builder library (602-643).
  - `MAX_REVISIONS=50` (59). **EXISTS**
- migrations/0122_store_layouts.sql: `store_layout_drafts`, `store_layout_revisions`, `merchant_stores.published_revision_id`. **EXISTS**
- migrations/0123_store_app_icons.sql: `merchant_store_icons` (192/512/maskable/180/32 renditions, lease). **EXISTS**
- Collections come from `merchant_store_sections` (0036, plus kind/description in 0126:205-207). It has **no image/cover column**. **MISSING** (would need an additive migration)

### 3. Media upload for store assets (worker/routes/uploads.ts)
- Limits: `IMAGE_MAX` 8 MB (36), `VIDEO_MAX` 40 MB (37), `MERCHANT_PUBLIC_VIDEO_QUOTA_BYTES` 1 GiB (46).
- `purpose=community` requires an open store (283-285) and allows video (324-326). `sniffVideo` walks the file and accepts MP4 (H.264/HEVC/AV1) or WebM (335-344).
- There is no duration limit, no transcoding and no automatic poster.
- **GIF and AVIF pass through without conversion** on the server (453) and on the client (src/lib/imagePreprocess.ts:262). So an **animated GIF already works in every image slot** (hero image, banner, image_text, gallery, logo/banner in settings), raw and up to 8 MB. Product stills refuse animated GIF (≈400-420).
- Public `/files` responses get `public, max-age=31536000, immutable` (913-916).
- **There are no resized or srcset variants** for layout media, the hero cover or product cards: they serve the full original (products up to a 3000 px edge).
- Pickers:
  - src/components/merchant/storeDesign/pickers.tsx: `MediaPicker` (317+), with the library, upload via `uploadFile(f,'community')` (367), a kind check (368-371) and `ACCEPT` (302-305).
  - `MediaControl` in fields.tsx:291.
  - src/components/media/ImagePicker.tsx (logo/banner, ACCEPT includes gif, line 33).
  - src/components/merchant/catalog/MediaEditor.tsx (product photos and videos).
  - All **EXIST**.

### 4. Storefront renderer (src/components/storefront)
- **StoreRenderer.tsx**:
  - Normalises again before rendering (87-93).
  - `CORE_BLOCKS` hero|tabs|products_grid ship in the storefront chunk (43-47). `TAB_VIEW_BLOCKS` are one lazy chunk prefetched when idle (50-84). Everything else lives in the `extra` chunk (55).
  - `visibilityClass` switches at 48rem (100-104). The `Glow` is a fixed `blur-[120px]` layer (122-130).
  - `@container` page (154).
- **Hero.tsx**: the profile cover is eager with `fetchPriority="high"` (63). The **cover/split/minimal variants are lazy** (31 → blocks/extra.tsx:29), so their LCP image waits for a chunk. That is a PageSpeed issue.
- **HeroVariants.tsx**: cover (25-60), split (65-102), minimal (107-136). All of them use `<img>` only.
- Media by block:
  - Video.tsx: `<video controls playsInline preload="metadata">`. Autoplay is muted and looping, and is off under reduced motion through its own hook (12-23), not `useMotion`. There is no IntersectionObserver play/pause.
  - Gallery.tsx: grid or shelf, `loading="lazy"`, **no lightbox**.
  - Banner.tsx: image only.
- **Backgrounds**: nothing. Only the `surface` token (theme.css:53-90).
- **Animations**: none in theme.css (9 KB) or in any storefront block, apart from `active:scale` and the tab indicator. Only StorefrontProduct.tsx imports motion.
- **theme.ts**: `ACCENTS` class table with 7 entries (33-41) and `themeAttributes` data-sf-* (64-77).
- **StoreTheme.tsx**: context plus the `[data-store-theme]` wrapper (33-57).
- **StoreHeader.tsx**: header is back button, logo, name and menu (18-55). The footer is the **install card plus name and date only** (57-74). **No footer links, no announcement bar.**
- **Product card** (parts.tsx:110-171):
  - First image only (the worker's `productCard` does `images.slice(0,1)`, worker/lib/storeLayout.ts:116).
  - Heart, −% badge, «unavailable» flag. There is **no second image and no video preview on the card**.
  - **Hex violation**: `bg-[#10161f]/85` at parts.tsx:144.
  - Card styles come from `[data-sf-pcard]` (theme.css:236-280).
- **Product page**: StorefrontProduct.tsx:134-140 builds the gallery from `product.media` (image or video) → src/components/catalog/ProductGallery.tsx (`<video controls>`, never autoplays). **EXISTS**
- **Collections.tsx**: chips, list and cards, all text only with no cover (72-88).
- **About.tsx**: shows policies (87-90). **addressedView.ts** gives standalone pages for tab kinds only.
- **Caching**: `/api/storefront/:slug` sends no Cache-Control, and it is per-viewer (worker/routes/storefront.ts:59-66 `viewerGovernorate`, 377-379). It cannot be edge-cached as it stands.

### 5. Builder UI (src/components/merchant/storeDesign)
Lazily loaded as `store_design` (src/components/merchant/shell/sections.tsx:88).

- **StoreDesignPanel.tsx**:
  - Tabs: sections, theme, page, history (80, 428-441).
  - Undo and redo buttons plus ⌘Z (148-165, 302-303), with undo on delete and template actions.
  - Device preview 360/768/1280 (484-496), block list, inspector, publish dialog, conflict banner.
- **editorModel.ts**: `HISTORY_DEPTH=60` (407-427), plus pure edits and limits.
- **useLayoutEditor.ts**: undo/redo dispatch (26-41, 283-286). **autosave.ts**: debounced and version-fenced.
- **PreviewCanvas.tsx**: `DEVICE_WIDTHS` (21), scaled, `inert`, click-to-select by position.
- **TemplateGallery.tsx**: live preview of the 7 templates through POST /preview; «whole page» or «look only». **templatePick.ts** picks a recommended template.
- **BlockPicker.tsx**: live preview per block from samples.ts.
- **BlockInspector.tsx**: forms generated from the registry. `SHOWN_WHEN` hides fields per variant (23-37).
- **panels.tsx**: ThemePanel (106-197) with presets and every token as chips or segmented controls (no colour or font input). PagePanel (201-227) only covers header and footer variants.
- **catalog.ts**: categories (29-35), names (39+). The header says **ar/en only**, with ckb falling back to Arabic (11-13). **No `loc` call in the whole builder has a Sorani argument.** **NEEDS REFACTOR** (real Sorani)

### 6. The owner's asks, item by item
| Ask | Status | Evidence / gap |
|---|---|---|
| Video in hero | MISSING | hero `image` is kind image (blocks.ts:111). Video exists only as its own block (268) |
| GIF in hero / banner / gallery / profile | PARTIAL | Works today as raw GIF (refs.ts:35, uploads.ts:453). But no size cap below 8 MB, no GIF→MP4 conversion, no poster, heavy for LCP |
| Page / section background (image, video, GIF) | MISSING | No layout-level background; surfaces are colour tokens only. The top-level key allow-list is at normalize.ts:491 |
| Gallery / lookbook | PARTIAL | gallery grid/carousel EXISTS. No lightbox, no product hotspots ("shop the look"), no masonry |
| Reels block | MISSING | No video list in `BlockData`. Store posts can be filtered with `GET /api/community/posts?store=` (communityPosts.ts:234-253) but sit behind `communityGate()` (line 49), so a storefront reels block reading them would leak gated content. Safer: a block holding a `list` of the merchant's own {video, poster, caption, product ref} |
| Announcement bar | MISSING | Only countdown `bar` (tied to a deadline) comes close |
| FAQ / policies pages | PARTIAL | FAQ block EXISTS (235). Policies render inside About (About.tsx:87). No standalone FAQ or policies page and no `TAB_KINDS` entry (blocks.ts:95) |
| Footer links | MISSING | StoreHeader.tsx:57-74 |
| Custom fonts | MISSING by decision | Cairo weights only (tokens.ts:14-16, 25). A closed font enum would be allowed but costs font bytes |
| Colour palettes | PARTIAL | 7 accents in a closed table (tokens.ts:19-21, theme.ts:33-41, worker merchant.ts `ACCENTS`). Free colours and custom CSS are forbidden by decision 12 (docs/MERCHANT_PLATFORM.md §2 item 12; DECISIONS row 122 (5)) |
| Layout templates | EXISTS | starters.ts plus TemplateGallery (DECISIONS row 161) |
| Per-block animation | MISSING | `StoreBlock` only has id/type/variant/settings/visibility/hidden (schema.ts:41-49). Nothing animates on the storefront |
| «Measure my site's speed» | MISSING | Nothing in src or worker. The CSP `connect-src` (worker/lib/securityPolicy.ts:139) blocks browser calls to googleapis, so PageSpeed Insights would have to be called by the Worker. There is no PSI key in the environment. The analytics bot filter already drops lighthouse/pagespeed user agents (storefrontAnalytics.ts:63). The beacon (src/lib/storeBeacon.ts; `STOREFRONT_EVENTS` storefrontAnalytics.ts:45) could carry real-user web-vitals (LCP/INP/CLS) |
| Device preview | EXISTS | 360/768/1280 (PreviewCanvas.tsx:21) |
| Undo history | EXISTS | 60 steps plus ⌘Z. Published history is 50 revisions with restore |
| Per-block schedule (show from/to) | MISSING | Only countdown hides itself |
| Collection covers | MISSING | No column (0036/0126) |
| Product card: second image / video preview | MISSING | worker/lib/storeLayout.ts:116 |
| Responsive images | MISSING | `mediaSrc` serves the original. No width/srcset anywhere in the storefront |

### 7. Constraints for whoever builds this
- **Tests pinned to the registry**:
  - tests/storeLayoutSchema.test.ts:59 expects exactly **27 block types**, so it must change.
  - tests/storefrontBlocks.test.ts:145 requires one component per type (core, tabViews or `EXTRA_BLOCKS` in blocks/extra.tsx:32-51).
  - tests/storeDesignEditor.test.ts:84 and the starters' canonical round-trip.
- **Budgets** (tests/bundleBudget.test.ts): CSS 60 KB gzip (63); storefront closure 47 KB (≈264-293).
  - New blocks belong in the lazy `extra` chunk.
  - A hero-video variant must not pull code into `Hero.tsx` core.
  - theme.css is part of the storefront CSS.
- **Additive path**: add an enum, setting or block to v1; there is no schema bump, because unknown keys are stripped non-fatally. Layout-level additions such as a background need `normalize.ts` plus a `schema.ts` key.
- **Motion**: the storefront has no `useMotion`. Per-block reveal should be CSS keyframes under `prefers-reduced-motion`, which costs CSS bytes, or else a lazy import.

### 8. Reuse list
- New media settings: `FieldSpec` `{t:'media', kind:'video'}`, `MediaControl`/`MediaPicker`/`GET /media`, and `verifyLayoutRefs`. Ownership and mime checks come for free.
- Video playback: the `Video.tsx` autoplay rules (muted, loop, playsInline, reduced motion) and the `/files` Range support (uploads.ts ~835-880).
- Previews: `StoreRenderer` in `PreviewCanvas` (any block or device), and `POST /preview` for "see before choose".
- Look presets: `THEME_PRESETS`/`starterLayout` pattern and the `ThemeSwatch`/`ChoiceChips` pickers (panels.tsx).
- Real-user speed data: the storefront beacon plus `storefront_event_marks`/daily counters (0125).
- Store posts: `community_posts.store_id` (0153:69, index at 94) with `community_post_media` video (0153:117-120). This needs the community-gate decision first.

Key files: /home/user/Levonis/packages/storeLayout/src/blocks.ts, /home/user/Levonis/packages/storeLayout/src/tokens.ts, /home/user/Levonis/packages/storeLayout/src/schema.ts, /home/user/Levonis/packages/storeLayout/src/refs.ts, /home/user/Levonis/packages/storeLayout/src/normalize.ts, /home/user/Levonis/packages/storeLayout/src/verify.ts, /home/user/Levonis/packages/storeLayout/src/data.ts, /home/user/Levonis/packages/storeLayout/src/starters.ts, /home/user/Levonis/worker/routes/storeLayout.ts, /home/user/Levonis/worker/lib/storeLayout.ts, /home/user/Levonis/worker/routes/uploads.ts, /home/user/Levonis/worker/routes/storefront.ts, /home/user/Levonis/migrations/0122_store_layouts.sql, /home/user/Levonis/migrations/0123_store_app_icons.sql, /home/user/Levonis/src/components/storefront/StoreRenderer.tsx, /home/user/Levonis/src/components/storefront/StoreHeader.tsx, /home/user/Levonis/src/components/storefront/theme.ts, /home/user/Levonis/src/components/storefront/theme.css, /home/user/Levonis/src/components/storefront/parts.tsx, /home/user/Levonis/src/components/storefront/blocks/Hero.tsx, /home/user/Levonis/src/components/storefront/blocks/HeroVariants.tsx, /home/user/Levonis/src/components/storefront/blocks/Video.tsx, /home/user/Levonis/src/components/storefront/blocks/Gallery.tsx, /home/user/Levonis/src/components/storefront/blocks/extra.tsx, /home/user/Levonis/src/components/merchant/storeDesign/StoreDesignPanel.tsx, /home/user/Levonis/src/components/merchant/storeDesign/panels.tsx, /home/user/Levonis/src/components/merchant/storeDesign/pickers.tsx, /home/user/Levonis/src/components/merchant/storeDesign/BlockInspector.tsx, /home/user/Levonis/src/components/merchant/storeDesign/catalog.ts, /home/user/Levonis/src/components/merchant/storeDesign/editorModel.ts, /home/user/Levonis/src/components/merchant/storeDesign/PreviewCanvas.tsx, /home/user/Levonis/tests/bundleBudget.test.ts, /home/user/Levonis/tests/storeLayoutSchema.test.ts, /home/user/Levonis/tests/storefrontBlocks.test.ts

## Survey — storefront-cx

## Customer journey inside a store and across the site: gap report (read-only)

All paths are under /home/user/Levonis. Line numbers are from HEAD b726a1c6.

### 0. Budgets as measured
- **Storefront closure** (`tests/bundleBudget.test.ts:303`, `STOREFRONT_BUDGET = 47 KB`): I measured **46.2 KB** from the existing `dist/`. That build is slightly stale (at least one src file is newer). So there is about 0.8 KB of room. What is inside the closure:
  - `Storefront` 6.2 and `StorefrontProduct` 6.5.
  - `StoreRenderer` 10.7, which holds Hero, Tabs and ProductsGrid, `parts.tsx`, StoreHeader, the runtime and the layout normaliser.
  - Two `theme-*` chunks (3.9 + 3.0), `QuantityInput` 2.7, `attributes` 1.5 (ProductFacts), the `Tabs` primitive 1.4, `profileIcons` 1.3.
  - Small pieces: InstallAppButton, PremiumMemberBadge, storefrontApi, storeBeacon, useGoBack, feedCache, governorates, productText, and lucide icons.
- **Lazy by rule** (`bundleBudget.test.ts:331-336`): `extra` (non-classic blocks), `tabViews`, `StoreDesignPanel`, `OwnerShareMenuItem`, `StoreUnavailable`, `ProductActions` (`StorefrontProduct.tsx:70`) and `refusalStrings` (dynamic import at `StorefrontProduct.tsx:182`). Anything new on a store page has to be lazy or pay for itself.
- **CSS**: the stale dist totals **61,445 B gzip against a 61,440 B budget**. `docs/COMMUNITY_HOME_PLAN.md:5` recorded 53 B of headroom. In practice every new utility class must be paid back (ECOSYSTEM D7).
- **Initial payload**: 211.5 KB (budget 240). Entry chunk: 81.6 KB (budget 120).

### 1. Host shell and navigation
- **`StorefrontApp`** (`src/App.tsx:402-445`): the only routes are `/ /products /about /reviews /p/:slug /policies /cart /checkout /store-checkout /orders /orders/:id /auth /admin/*`.
  - It has **no Header, no BottomNav, and no `/chat`, `/saved-items`, `/wallet`, `/requests` or search**.
  - **MISSING: any cart, orders or account entry on a store host.** The store header (`src/components/storefront/StoreHeader.tsx:18-54`) draws only Back and the ⋯ menu.
  - The only cart link is a merchant-configured CTA with route `cart` (`Storefront.tsx:264`). After «أُضيف» on the product page there is no link to the cart (`StorefrontProduct.tsx:375-398`).
- **Back arrow on a host** leaves the store for `${MAIN_SITE}/community` (`Storefront.tsx:405-408`).
- **Chat and quote doors on a host are hard navigations to the apex**:
  - Chat: `Storefront.tsx:464`, `:723`.
  - Quote: `QUOTE_PATH` at `:60` and `:288`.
  - Wallet top-up: `StoreCheckout.tsx:403-415`.
  - In an installed store PWA these land outside the app's scope. **NEEDS REFACTOR** for a smooth, app-like journey.
- **Every first paint waits on one API call**: `if (!resolved) return <RouteFallback/>` (`App.tsx:562`), which waits for `GET /api/storefront/resolve` (`src/StoreContext.tsx:97-131`). This applies to the main site as well as store hosts. The chain is HTML → entry → resolve → Storefront chunk → paint. This is a direct PSI/LCP cost. The worker already rewrites HTML for social previews (`worker/index.ts:~600-644`), so it could inline the resolve answer.
- **Main site, `/community/store/*`**:
  - Header renders only on `/` (`src/components/Header.tsx:93`).
  - BottomNav (profile, cart, home, chats, community) shows on the store page and is hidden on `/community/store/:s/p/:p` (`src/components/BottomNav.tsx:20-36`).
  - `CommunityStorePage` does `window.location.replace(subdomain)` (`src/pages/CommunityStorePage.tsx:127-139`), a full reload. It can also make two sequential fetches (slug, then by-id: `:114-119`). It statically imports the legacy `MerchantStore` page (`:27`).

### 2. Storefront page (`src/pages/Storefront.tsx`, 872 lines)
- **Architecture**:
  - The published layout is rendered by `StoreRenderer` (`src/components/storefront/StoreRenderer.tsx`).
  - The runtime contract is `src/components/storefront/runtime.tsx:38-89`. Every action is injected from `Storefront.tsx:251-321`.
  - There are **27 block types** (`packages/storeLayout/src/blocks.ts:107-392`). None of them is a reels, community-posts, search or store-projects block.
- **Loading**: a full-screen `bg-black` spinner (`Storefront.tsx:345-351`, and `StorefrontProduct.tsx:199-205`). There are no skeletons.
- **Motion**: none via `useMotion()`. The storefront's only motion is `motion.button whileTap` (`StorefrontProduct.tsx:375`) and the `ui/Tabs` layoutId indicator. `theme.css` (9 KB) has no transitions.
- **Tokens: NEEDS REFACTOR.**
  - Raw `bg-black`/`zinc`/`white`/`red`/`rose`/`sky` classes throughout.
  - A hex value `bg-[#10161f]/85` at `src/components/storefront/parts.tsx:144`.
  - An rgba drop-shadow at `Storefront.tsx:404`.
- **Sorani gaps** («OWNER: Sorani to be written by hand»): `Storefront.tsx:512-513, 541-543, 646-653, 743`; `StorefrontProduct.tsx:258-259, 288, 389`.

### 3. In-store search: MISSING
- **Server**: `GET /api/storefront/:slug/products` (`worker/routes/storefront.ts:523-590`) accepts `limit, cursor, category, section|collection, deals`. It has **no `q` and no sort**.
- **Client**: nothing in `src/components/storefront/*`.
- **Reusable**:
  - `GET /api/chats/:id/products?q=` (`worker/routes/chats.ts:~700-760`, the store's own products searched by name).
  - `GET /api/community/products?q=` (`worker/routes/community.ts:182-207`, LIKE across all stores, not store-scoped).
  - The site's `LiveSearch` (`src/components/search/LiveSearch.tsx:155`) covers only the platform catalogue (`/api/products?search=`). Community and store products are not searchable from the main search.

### 4. Product cards: 6+ inconsistent variants (NEEDS REFACTOR)
| # | Where | Price formatter | Notes |
|---|---|---|---|
| 1 | `src/components/storefront/parts.tsx:110` `ProductCard` (grid `:173`, shelf `:185`) | `DinarPrice` «ع. 12,000» (`:49`) | heart, −% badge, no store name, `<img loading=lazy>` with no srcset (`:124`) |
| 2 | `src/components/community/hub/ProductTile.tsx:17` | `useMoney().money` | store mark, «نفد», struck price, no heart |
| 3 | `src/components/home/ProductCard.tsx:49` (CompactCard `:81`, RegularCard `:171`) | `CardPrice` | platform catalogue, compare toggle |
| 4 | `src/pages/SavedProducts.tsx:~125-145` inline | `toLocaleString + ' IQD'` (`:143`) | |
| 5 | `src/pages/MerchantStore.tsx:269` inline (legacy) | `formatIqd` | |
| 6 | `src/components/chat/cards/ChatCardView.tsx:42` `ProductCardView` | `money` | live-vs-snapshot price |
| (7) | `src/components/bundles/BundleTile.tsx:99` | — | bundles only |

The product page itself uses `iqd()` (`src/lib/storefrontApi.ts:62`). No card shows a video indicator.

### 5. Product page (`src/pages/StorefrontProduct.tsx`)
- **EXISTS**: variants, gallery with video (`src/components/catalog/ProductGallery.tsx`), typed quantity, lazy save/share (`ProductActions`), delivery-to-you, prep days, seller-conflict dialog.
- **MISSING**:
  - A «message the store about this product» door (chat opens only by `merchantId`, with no product context: `chats.ts:538-557`).
  - Product reviews. Only the merchant rating shows (`:312-316`).
  - Related products or more from this store.
  - A go-to-cart link or buy-now after adding.
  - A «request a custom print like this» entry.
  - Swipe, zoom or lightbox in the gallery, and a poster for videos (`ProductGallery.tsx:52-60`).

### 6. Store chat door and chat page
- **`POST /api/chats/open`** (`worker/routes/chats.ts:386-590`) accepts `orderId` (`:391`), `requestId` (`:500`), `merchantId` (`:538`) or `userId`. There is **no `storeId` key**: the store is derived from the merchant. It opens one store thread per customer.
- **Chat page** (`src/pages/Chat.tsx`):
  - Polls every 5 s (`:235-255`).
  - Header carries the store identity (`:638-663`); the logo navigates to `/community/store/<slug>` (`chats.ts:~649`).
  - Commerce sheets load lazily (`:30-34`).
  - Empty state is generic: «لا توجد رسائل بعد» (`:700-704`).
- **Quick replies / first-response UX: PARTIAL.**
  - The chips are hardcoded, 4 per role (`Chat.tsx:400-409`).
  - The merchant cannot configure them, there is no Sorani, and Sorani users get the Arabic set via `dir==='rtl'`.
  - There is no away message, greeting or «usually replies within».
  - Response time is not measured: `response_minutes: null` (`worker/lib/printMatchingStore.ts:371`).
- **Bug**: `formatMsgTime` checks `lang === 'ku'` (`Chat.tsx:70`), but the app's code is `'ckb'` (`src/LanguageContext.tsx:33-42`). Sorani users therefore get `en-US` times.
- **Notifications**: the customer does get an in-app notice for each store message (`notifyStoreThread`, `chats.ts:~215-250`).

### 7. Orders and tracking
- **Orders list** (`src/pages/Orders.tsx`): server-side filters and paging, plus the pending store-review cards (`:14`, `:511`).
- **Order detail** (`src/pages/OrderDetail.tsx`):
  - Loads once (`:253-280`); there is no polling and no `useFreshOnReturn` (`src/lib/useFreshOnReturn.ts` is used by StoreCheckout only).
  - Tabs: tracking, items, payment, support.
  - `StoreReceipt` «استلمت طلبي» at `:554` (`src/components/orders/StoreReceipt.tsx`, ar/en only).
- **Store orders have no store identity**: the `ApiOrder` type (`src/lib/api.ts:930+`) has no store fields, and the server payload (`worker/routes/orders.ts`) sends none. The list and detail never say which shop an order came from. **MISSING.**
- **Tracker** (`src/components/OrderTracker.tsx`): the server's stage path from `GET /api/orders/:id/tracking` (`worker/routes/orders.ts:5117-5150`).
  - A merchant status change maps to the `'direct'` path (`worker/routes/merchant.ts:1206`) and writes `order_status_history`.
  - The merchant has a richer story (`GET /api/merchant/orders/:id/timeline`, `worker/routes/merchantOrders.ts:245`); the customer does not.
  - **Order timeline with live states: PARTIAL** (static stages, no live refresh, no store branding, no progress photos).
- **Customer notifications per step** for store orders:
  - Placed: **none**. `storeOrders.ts:1204` notifies only the merchant.
  - Confirmed, shipped, cancelled: in-app plus outbox via `notifyOrderStatus` (`worker/lib/orderNotify.ts:50`, `:286-353`), triggered from `merchant.ts:1180-1190`.
  - `processing`: deliberately silent.
  - Delivered: store copy with a confirm-receipt CTA (`orderNotify.ts:385-415`).
  - Titles are ar/en only; the bell falls back to Arabic for Sorani.
  - Status changes are also posted into the store chat (`announceStoreOrder`, `merchant.ts:1201`).
- **Success screen** (`src/pages/StoreCheckout.tsx:417-449`) links to `/orders`, not to the order itself.

### 8. Reviews
- **Writing**: `StoreReviews` (`src/components/community/reviews/StoreReviews.tsx`) offers stars and text. The server accepts up to 6 images (`worker/routes/merchantReviews.ts:235`), but the form has **no photo upload**.
- **Reading**: the storefront Reviews block (`src/components/storefront/blocks/Reviews.tsx`) shows a summary and the list. It **ignores `images` and `next_cursor`**, so there are no photos, no "more" and no star filter. The server returns both (`worker/routes/storefront.ts:650-691`).
- Platform product reviews are a separate system (`src/components/orders/ReviewSheet.tsx`, `src/components/reviews/ReviewSection.tsx`).

### 9. Print-request entry points
- **Store «اطلب عرض سعر»** → `/requests?view=new` (`Storefront.tsx:60`, `:288`, `:483`). That is the **public board wizard, not a request addressed to this store.** Direct requests exist (migration 0151, `worker/lib/directRequests.ts`) but are reachable only from the chat's `PrintRequestSheet` (`src/components/chat/commerce/PrintRequestSheet.tsx`). That sheet is a second, simpler form: no link source, no estimate. **NEEDS REFACTOR.**
- **Community home**: `NEW_REQUEST_PATH` (`src/pages/Community.tsx:67`).
- **Price calculator** → `/requests?link=` (`src/pages/Tools.tsx:565`). `Requests.tsx:106-125` reads `link` and `view`.
- **Bug**: «اطلب طباعة مثلها» in `src/pages/community/Project.tsx:273` sends `?project=` and `state.project`. Neither `Requests.tsx` nor `RequestWizard.tsx` reads `project`, so the prefill is dropped. This file is in the other workflow's churn zone.
- **Estimate**: `RequestWizard.tsx:365-373` (`requestsApi.quote`). There is no estimate in the chat sheet or on the store door.

### 10. Video and clips today
- **Store Video block**: `blocks/Video.tsx`, spec at `blocks.ts:268-279`. Max 4 per store, `aspect-video` only, needs the merchant-video entitlement, and autoplays muted only when the merchant turned autoplay on.
- **Product videos**: `ProductGallery`, tap-to-play with `preload=metadata`.
- **Community post video**: `src/components/community/projects/MediaStrip.tsx:140`.
- **Chat and review videos** also play inline.
- The Showcase block is images only (`blocks/Showcase.tsx`).
- **Reels viewer: MISSING.** There is no vertical 9:16 feed, swipe player or reels table anywhere, and none in the docs.

### 11. Status summary
| Item | State | Evidence |
|---|---|---|
| Reels viewer | MISSING | §10 |
| In-store search | MISSING (server and client) | `storefront.ts:523` |
| Order timeline, live states | PARTIAL | `OrderTracker.tsx`, `OrderDetail.tsx:253` |
| Quick replies / first response | PARTIAL (hardcoded) | `Chat.tsx:403` |
| Product Q&A | MISSING (no table, route or UI) | grep over migrations, worker, src |
| Wishlist inside store | PARTIAL: hearts on cards and product page (`Storefront.tsx:170-204`, `ProductActions.tsx`), but the saved list is main-site only (`App.tsx:829`) and there is none on a host | |
| Share / deeplinks | EXISTS: share pin and menu (`Storefront.tsx:763`, `:798`), owner QR kit, OG cards for store and product (`worker/lib/socialPreview.ts:92-105`). MISSING: collection link cards, chat-about-product deeplink | |
| PWA on store host | PARTIAL: per-host manifest and icons (`worker/lib/webManifest.ts:465-471`, shortcut names Arabic-only), `HostAppleIdentity`, install card (`Storefront.tsx:565`), network-first SW (`public/sw.js`). No web push, no offline store page, no in-app nav; chat, quote and wallet leave the app scope | |
| Cart entry on host | MISSING | §1 |
| Store identity on orders | MISSING | §7 |
| Store-addressed quote door | NEEDS REFACTOR | §9 |
| Product-level reviews for store products | MISSING | §5 |
| Edge cache for public storefront reads | MISSING. Nothing is cached at the edge (`storefront.ts:113-114` says so); only `/files` uses `caches.default` | |

### 12. What can be reused (no new systems)
- The runtime slots (`runtime.tsx`) for new host-drawn controls: a cart pill or search door, with no import of workspace code.
- The lazy-chunk groups `extra` and `tabViews` for any new block (reels, search, store posts).
- `useOpenChat` (`Storefront.tsx:451`) and `openStoreThread` (`chats.ts:~338`) for a product-context door.
- The chat card send (`Chat.tsx:356`) to post a product card.
- The chat product picker's `?q=` query, as the model for store search.
- `/api/community/products?q=` plus a store filter.
- `directRequests.ts` and `PrintRequestSheet` for a store-addressed quote. Reuse `RequestWizard`'s estimate rather than writing another.
- `useFreshOnReturn` for OrderDetail and Orders.
- `notifyOrderStatus` / `notify()` to add a customer "placed" notice.
- The `announceStoreOrder` chat events.
- The merchant order timeline query for a customer-facing timeline.
- `SPRING` / `useMotion()` (`src/lib/motion.ts:62`, `:127`) and the `ui/Tabs` layoutId for transitions.
- `SafeImage` (the community tiles) as the single card image primitive.
- `communityFavoritesApi` for the saved state.
- `socialPreview.ts` for new deeplink cards.

Key files: /home/user/Levonis/src/pages/Storefront.tsx, /home/user/Levonis/src/pages/StorefrontProduct.tsx, /home/user/Levonis/src/pages/StoreCheckout.tsx, /home/user/Levonis/src/pages/CommunityStorePage.tsx, /home/user/Levonis/src/App.tsx, /home/user/Levonis/src/StoreContext.tsx, /home/user/Levonis/src/components/storefront/StoreRenderer.tsx, /home/user/Levonis/src/components/storefront/runtime.tsx, /home/user/Levonis/src/components/storefront/parts.tsx, /home/user/Levonis/src/components/storefront/StoreHeader.tsx, /home/user/Levonis/src/components/storefront/blocks/Reviews.tsx, /home/user/Levonis/src/components/storefront/blocks/Video.tsx, /home/user/Levonis/src/components/storefront/blocks/ProductsGrid.tsx, /home/user/Levonis/packages/storeLayout/src/blocks.ts, /home/user/Levonis/worker/routes/storefront.ts, /home/user/Levonis/worker/routes/chats.ts, /home/user/Levonis/src/pages/Chat.tsx, /home/user/Levonis/src/pages/Orders.tsx, /home/user/Levonis/src/pages/OrderDetail.tsx, /home/user/Levonis/src/components/OrderTracker.tsx, /home/user/Levonis/src/components/orders/StoreReceipt.tsx, /home/user/Levonis/src/components/community/reviews/StoreReviews.tsx, /home/user/Levonis/src/components/community/hub/ProductTile.tsx, /home/user/Levonis/src/components/home/ProductCard.tsx, /home/user/Levonis/src/components/catalog/ProductGallery.tsx, /home/user/Levonis/src/components/chat/commerce/PrintRequestSheet.tsx, /home/user/Levonis/src/pages/Requests.tsx, /home/user/Levonis/worker/lib/orderNotify.ts, /home/user/Levonis/worker/routes/merchant.ts, /home/user/Levonis/worker/lib/webManifest.ts, /home/user/Levonis/tests/bundleBudget.test.ts

## Survey — pricing

## 0. The main finding: two pricing engines that disagree (NEEDS REFACTOR)

| | Engine A: request estimate | Engine B: calculator and merchant costing |
|---|---|---|
| Code | `worker/lib/printPricing.ts` `quotePrint()` L356-620 | `worker/lib/printQuote/cost.ts` `priceJob()` L282-480, called through `priceForPrinter()` at `worker/routes/printQuote.ts:1535-1659` |
| Callers | `POST /api/marketplace/print/quote` (`printRequests.ts:473-520`, requireAuth); publish (`printRequests.ts:1080-1098`) | `/api/print-quote/*` (/tools), `/analyses/:id/compare` (merchant), `POST /api/merchant/workshop/requests/:id/cost` |
| Materials | setting `printMaterials` (`DEFAULT_MATERIALS` L94-113: 10 FDM + 8 resin) | table `print_materials` (`migrations/0078:527-538`: 9 FDM, no resin, `default_iqd_per_kg` NULL) |
| Machines | none (per-process config) | `printer_models` (`0078:444-477`: 15 Bambu machines, all FDM) |
| Config | admin `printPricingConfig` (`DEFAULT_PRICING` L225-258), edited in `src/components/adminCommunity/PrintPricingAdmin.tsx` | Fixed in code: `PLATFORM_TARGET_MARGIN_PERCENT=35` (printQuote.ts:115), electricity 120 and labour 6000 (L112-113). From the admin config it reads only `min_job_iqd` and `machine_hour_iqd` (L190-258) |
| Confidence | high / medium / low plus `confidence_reasons` | exact / estimated / insufficient |
| Support | counts the area resting on the bed as overhang (`printPricing.ts:383`, a bug) | subtracts `bed_contact_area_mm2` (`geometryAdapter.ts:231`) |

The material ids also differ between the two catalogues (for example `pa`, `petg-cf`, `resin-*` exist only in A; see `docs/merchant-platform/audit/03…md` L73). When the owner edits the admin margin, energy or labour rates, only engine A moves.

## 1. The estimate's JSON shape and how the range is computed

**Wizard (A).** The quote is returned without `cost_lines`, `cost_iqd`, `floor_iqd` and `margin_percent` (`printRequests.ts:517-519`; `requestRevisions.ts:200-207` `publicEstimate`). Fields that remain: `priced, reason?, process, material_id, printed_volume_cm3, material_grams, print_time_minutes, total_time_minutes, price_iqd, price_low_iqd, price_high_iqd, confidence, confidence_reasons[], unit_price_iqd, accessory_lines[], accessories_unknown[], range_basis?`.

Where it is stored:
- `community_print_requests.estimate / estimate_low_iqd / estimate_high_iqd / estimate_confidence` (`printRequests.ts:964-1010`)
- per revision in `community_request_revisions.estimate` (`requestRevisions.ts:247-275`)

How the range is built:
- point = `roundTo(max(cost/(1-target%) × (1-qtyDiscount), floor), 250)`
- low = `max(point×0.88, floor)`; high = `max(point×1.12, low+250)` (L541-567)
- floor = max(min-margin price, material `min_economic_iqd`, `min_job_iqd`)
- If the material is "unsure": every candidate material is priced, and the range runs from the cheapest low to the dearest high, with `range_basis:'materials'` (`estimateFor` `printRequests.ts:431-465`).

The client type is narrower than the server payload: `src/components/community/requests/api.ts:90-97`. Display is `RequestWizard.tsx:853-871` («تقدير Levonis», the range and one sentence). The estimate is fetched only at step 4 (effect L368-378), so it is not live during step 2. Without geometry the wizard shows «لا تقدير بلا ملف مقيس».

**Calculator (B).** Customers get `publicQuote` (printQuote.ts:1663-1673): `{confidence, price_iqd, range_iqd{low,high}, machine_hours, waste_grams, waste_percent, engine_version}`. Merchants get `merchantQuote` (L1676-1694), which adds the lines with provenance (`from`), cost, profit, margin, markup and break-even. The range is ±12% only when the result is not `exact`, and the low end is clamped to the floor (cost.ts:454-478). Display is `src/pages/Tools.tsx:1110-1144`.

## 2. The pipeline, piece by piece

- **Mesh analysis: EXISTS.** `worker/lib/modelGeometry.ts` `analyseModel` L254. Formats L56-74: STL, 3MF, OBJ, AMF, GLB, glTF are measured; STEP is reference only. `ModelAnalysis` L154-200 carries volume, surface area, bounding box, triangle and shell counts, watertight, overhang, bed contact, complexity, warnings, and suggested material/colours. The LVM viewer mesh is `viewerMesh` L1003-1045.
- **Request file analysis: EXISTS.** `printRequests.ts:251-312` caches the result in `community_request_files.analysis` and writes a `.lvm` preview.
- **File upload: EXISTS.**
  - Request files: `marketplace.ts:409`, typed by `classifyAttachment` (`worker/lib/attachments.ts:84`); limits are 40 MB for models and 8 MB for images (L41-42).
  - Calculator: `printQuote.ts:406-507`; guests allowed with a token, kept 48 h in `print_analyses`.
- **Time model.**
  - A: FDM flow L398-418, resin layer exposure plus lift plus post time L419-428, complexity uplift L432, resin batch exponent 0.35 L442.
  - B: volumetric flow × sustained fraction + per-layer overhead + warm-up, with grid plate packing (`geometryAdapter.ts:164-177, 260-303`).
- **Supports and infill.**
  - A: support = overhang × height × 0.25 × 0.15. Infill comes from the spec (default 20%), but wizard v2 never sends infill, supports, colours, post-processing or accessories (`wizardPayload` RequestWizard.tsx:123-143).
  - B: strength presets 10/15/30% infill (`geometryAdapter.ts:106-110`); support 0.35 × 0.12 with a 0.18 interface share.
  - B is FDM-only and does not check the machine type. The calculator is safe today only because no resin printer is seeded; workshop costing refuses resin explicitly (`merchantWorkshop.ts:269-273`).
- **Material price ladder: PARTIAL.** Logic is `cost.ts:79-96` and `repository.ts:276-391`.
  - The **`merchant_spools` rung has no writer anywhere in the worker**, so it is unreachable.
  - The `merchantDefault` rung is never filled.
  - The `print_materials.product_id` rung has no writer either.
  - What is actually used is the shop's own filament products, matched by type (L364-386), which is `platform` provenance. So engine B can never return `exact`.
  - `merchant_material_stock` (0132:109) stores grams only, no price.
- **Merchant economics: PARTIAL.** `merchant_printers` purchase, residual, useful hours, maintenance, electricity and labour (0078:125-131) are edited in `PrintersTab.tsx:88-89, 1168-1176` and consumed at printQuote.ts:1549-1604.
  - **`merchant_printers.machine_hour_iqd` (0045:105), editable at PrintersTab.tsx:1142, never reaches any price.** It is only a matching tie-break (`eligibility.ts:392`).
  - `QuoteInput.machine_hour_iqd` (printPricing.ts:288) is never passed.
  - `merchant_request_prefs.min_job_iqd` is used only in matching (`eligibility.ts:377`).
- **Calibration loop: MISSING.** `print_actuals`, `print_failures` and `printer_calibration_stats` are read by `loadCalibration` (repository.ts:490), but nothing writes them.
- **Costing tab: EXISTS.** `src/components/merchant/dashboard/CostingTab.tsx` uploads, measures, then calls `/compare` (L212-216). The compare route (printQuote.ts:1417-1506) returns per-printer lines plus `because` facts.
- **Workshop costing: EXISTS, FDM only.** `merchantWorkshop.ts:233-423`. A request whose material is not in `print_materials` gets `COSTING_MATERIAL_REQUIRED` (L279-289). The costs list is L426-463, with a `stale` flag. UI: `WorkshopRequestCard.tsx:124-162` and `CostingSheet.tsx:102, 158` («استخدم هذا كعرضي»).
- **Link source: PARTIAL.**
  - Endpoints: `POST /api/marketplace/print/link` (printRequests.ts:323-332, auth) and `POST /api/print-quote/link` (printQuote.ts:1347-1405, guests allowed).
  - `externalModels.ts` parses MakerWorld, Printables, Thingiverse, Thangs and Cults3D ids offline (L69-75). Provider lookups are JSON only, with each redirect hop checked by `validateOutboundUrl` (`fetchGuard.ts:97`).
  - **Every default provider has `api_url:''` (L51-57), so every lookup returns `NO_API_CONFIGURED`.** In practice links resolve to no preview, no weight and no price.
  - Links are never turned into files (no STL is downloaded).
  - The wizard takes only `info.name` for the title (RequestWizard.tsx:248-272) and sends no `source_meta`, so no cover image is ever stored.
  - A link request gets no estimate: `/quote` reads only `file_id`, `analysis` or `volume_cm3`; no client sends `volume_cm3`, and `stated_dimensions_mm` is ignored.
  - The `?link=` prefill works: `src/pages/Requests.tsx:99-120, 368` and `Tools.tsx:563-565`.
- **Calculator → request handoff: PARTIAL.** «أرسل طلب طباعة» just navigates to `/requests` (Tools.tsx:1155). The calculator's `print_analyses` upload is not carried over, so the customer uploads the file again.

## 3. A price-confidentiality leak (NEEDS REFACTOR)

The public routes accept `target_margin_percent` from the request body: `/analyses/:id/quote` (printQuote.ts:925) and `/grams-quote` (L1245). A guest sending 0.01 gets a price roughly equal to the true cost, which defeats the cost-hiding that `publicQuote` exists for. The server should use its own margin on these routes.

## 4. Checklist

| Item | Status | Evidence |
|---|---|---|
| Multi-material / colour pricing | PARTIAL | A: `colors_count` adds purge, setup and a time multiplier (L405, 417, 445, 465), but the v2 UI never sends it. B file path: one material only (geometryAdapter.ts:116-118). Grams path: up to 8 rows, purge excluded (printQuote.ts:1003-1006, 1186). Slicer path `/analyses/:id` handles multiple tools but has no client |
| Resin vs FDM models | PARTIAL | A has both code paths. B, the calculator and workshop costing are FDM only |
| Quantity discounts | PARTIAL | A: log2 × 6%, capped at 30% (L541-545). B: no discount, only plate packing and shared warm-ups |
| Post-processing options | PARTIAL | A accepts `post_processing_minutes`; the UI doesn't collect it. B: only support-removal labour (printQuote.ts:1562-1566); the grams path offers a "finishing" accessory |
| Shipping in the estimate | MISSING | `gramsCoverage` excludes DELIVERY (L1187). The wizard collects governorate and handover but prices neither. Offers have no delivery-fee column |
| Per-merchant live quotes in the wizard | MISSING | The wizard shows only the Levonis estimate. Merchant prices exist only as private costings or offers |
| Link → file fetching | MISSING | See §2 |
| «لماذا هذا السعر» (why this price) | PARTIAL | Calculator: a generic «why» text, unmeasured items, waste (Tools.tsx:1087-1104, 1138-1140); grams path shows included/excluded. Merchant: lines with provenance and `because`. **`confidence_reasons` is computed but rendered nowhere** (not in the wizard or `src/components/print/PrintSummary.tsx`) |
| Estimate history | PARTIAL | Revisions store the estimate (`GET /print/requests/:id/revisions` L1448-1506), but the client type drops it. `print_quotes` keeps every calculator quote with a snapshot, but no customer list route exists. Merchants see their last 10 costings |
| Estimate in the public API | MISSING | `worker/lib/publicApi/resources/community.ts:264-291` exposes no estimate fields |

## 5. UI and rules debt in scope

- **Theme tokens:** `Tools.tsx` has about 105 raw palette classes (zinc, amber, emerald, white). `GramsQuotePanel.tsx` has 63, `CostingTab.tsx` 26, `PrintSummary.tsx` 22.
- **Sorani:** `Tools.tsx:312-330` puts Arabic text in the ckb block («NO NEW SORANI PROSE»). `RequestWizard.tsx` (122 calls), `CostingTab.tsx` and `CostingSheet.tsx` use two-argument `loc(ar,en)`, so Kurdish falls back to Arabic.
- **Motion:** none of these files use `useMotion`.
- **Caching:** the catalogue GETs set no Cache-Control (`printQuote.ts:320, 366, 390`; `printRequests.ts:207`), which is an easy edge-cache win.
- **Doc drift:** `docs/PRINT_QUOTE_ENGINE.md` §8 says `print_quotes.request_id` is never written (it now is, at merchantWorkshop.ts:391-406) and that there is no admin editor (it now exists: printQuote.ts:1840-1950 and `PrinterModelsEditor.tsx`).
- **Decisions to respect:** DECISIONS rows 100 and 111 (printer economics, link option, no invented numbers) and 134 (eligibility).

## 6. Existing tests

`tests/printPricing`, `printQuoteEngine`, `printQuoteGeometry`, `printQuoteGrams`, `printQuoteLinkAndPrinters`, `printQuoteRoutes`, `printQuoteUi`, `printQuoteUnlinkedPrinter`, `printJobMinimum`, `printToolsRepair`, `toolsLinkAndPrinterClient`, `externalModelCover`, `modelGeometry`, `printAccessories`, `printRequestsV2`, `materialPricedFromShopFilament`, `eligibilityRoutes` (all `.test.ts`).

## 7. What to reuse

- `analyseModel` + `analysisFromGeometry` + `priceForPrinter`: one engine to converge on. Give B resin support and the admin config, then retire `quotePrint` or wrap it.
- `priceAccessories` (`printAccessories.ts`) and `pricedAccessories`: already shared by both engines.
- `externalModels.resolveModelLink` + `guardedFetchBytes` (`fetchGuard.ts:222`): the base for fetching a file from a link.
- `community_request_revisions.estimate`, `print_quotes.snapshot`: already hold history; they need read routes and UI.
- `confidence_reasons`, `covers`, `because`, `CostLine.from`: the data for «لماذا هذا السعر» already exists.
- `merchant_printers` economics + `loadMerchantPrinters`: the base for per-merchant live quotes at wizard time. It needs writers for `merchant_spools` and use of `machine_hour_iqd`.
- `packages/shipping` + `worker/lib/shipping.ts`: for adding delivery to the estimate.

Key files: /home/user/Levonis/worker/lib/printPricing.ts, /home/user/Levonis/worker/lib/printQuote/cost.ts, /home/user/Levonis/worker/lib/printQuote/model.ts, /home/user/Levonis/worker/lib/printQuote/geometryAdapter.ts, /home/user/Levonis/worker/lib/printQuote/repository.ts, /home/user/Levonis/worker/routes/printQuote.ts, /home/user/Levonis/worker/routes/printRequests.ts, /home/user/Levonis/worker/routes/merchantWorkshop.ts, /home/user/Levonis/worker/routes/merchantPrinters.ts, /home/user/Levonis/worker/lib/externalModels.ts, /home/user/Levonis/worker/lib/fetchGuard.ts, /home/user/Levonis/worker/lib/modelGeometry.ts, /home/user/Levonis/worker/lib/requestRevisions.ts, /home/user/Levonis/worker/lib/attachments.ts, /home/user/Levonis/src/pages/Tools.tsx, /home/user/Levonis/src/components/tools/GramsQuotePanel.tsx, /home/user/Levonis/src/components/tools/linkQuoteApi.ts, /home/user/Levonis/src/lib/printQuote.ts, /home/user/Levonis/src/components/community/requests/RequestWizard.tsx, /home/user/Levonis/src/components/community/requests/api.ts, /home/user/Levonis/src/components/merchant/dashboard/CostingTab.tsx, /home/user/Levonis/src/components/merchant/dashboard/PrintersTab.tsx, /home/user/Levonis/src/components/merchant/workshop/WorkshopRequestCard.tsx, /home/user/Levonis/src/components/merchant/workshop/CostingSheet.tsx, /home/user/Levonis/src/components/print/PrintSummary.tsx, /home/user/Levonis/src/pages/Requests.tsx, /home/user/Levonis/migrations/0078_print_quote_engine.sql, /home/user/Levonis/migrations/0045_print_requests.sql, /home/user/Levonis/worker/lib/publicApi/resources/community.ts, /home/user/Levonis/docs/PRINT_QUOTE_ENGINE.md

## Survey — perf-arch

# Performance and caching architecture: what the code and config show

Caveat: `worker/index.ts` and `src/App.tsx` have uncommitted edits from the community workflow, so line numbers there may shift. `dist/` on disk (built 05:35) is newer than every file in src/ and public/, so the numbers below were measured on that build.

## 1. wrangler.jsonc

| Item | Status | Facts |
|---|---|---|
| Worker / assets | EXISTS | `main: worker/index.ts`. `assets` is at L72. `not_found_handling: single-page-application`. `run_worker_first` (L76, repeated at L218 staging and L304 dark) covers `/api/*`, `/files/*`, `/product/*`, `/bundles/*`, `/p/*`, `/community/store/*`, `/manifest.webmanifest`, `/robots.txt`, `/sitemap.xml`, `/store-icon/*` and the exact path `/`. |
| Live target | FACT | levonis-iq.com and `*.levonis-iq.com` are served by the Worker **`levonis-staging`** (`env.staging`, with DB `levonis-db-staging`). Source: docs/WORKERS.md, "The mapping". The top-level `levonis` Worker does not exist. |
| Compat | EXISTS | `compatibility_date 2026-08-01`, `nodejs_compat` (L40). |
| D1 | PARTIAL | One `DB` binding (L112/L238). No location hint, no read replication, and `withSession` is never called in worker/. The live DB is created with a bare `wrangler d1 create levonis-db-staging` in `.github/workflows/deploy-staging.yml:61`, on an `ubuntu-latest` runner, with no `--location`. D1 then places the primary near the request that created it, which was probably a US GitHub runner. This is unverified: nothing in the repo logs `meta.served_by_region`. |
| R2 | EXISTS | `BUCKET`, `R2_PUBLIC` and `R2_PRIVATE` (L121). No public R2 custom domain: every image goes through the Worker's `/files/*`. |
| IMAGES | EXISTS | L159/L260/L348. |
| KV / DO / Queues | MISSING | None declared. |
| Placement | MISSING | No `placement` key in any environment. docs/architecture/01-TARGET.md:522 notes that D1 has a single home region and that `placement:{mode:"smart"}` still has to be measured. **Deploy gotcha:** `scripts/prepare-deploy-config.mjs:185-202` copies a fixed list of keys from the environment block into the top level, and `placement` is not on it. Either put `placement` at the top level (it is inheritable) or add it to that list. |
| Cron | EXISTS | `*/15 * * * *` (L206). |
| Observability | EXISTS | `enabled: true` (L202). |

## 2. Request pipeline in worker/index.ts

- **Middleware order** (L130-260): `securityHeaders` → `gatewayAssertion` → `originCheck` → `classifyHost` (L141-144) → www-to-apex 301 (L152-157) → `loadSessionUser`.
- **Session read.** `loadSessionUser` is one `sessions × users` JOIN (worker/lib/session.ts:68). It is skipped only for public `/files/*`, product document paths, the manifest, robots/sitemap, `/`, `/store-icon/*`, `/community/store/*` and `/api/public/v1`.
- **Every other `/api/*` call from a signed-in user pays that JOIN first**, including `/api/storefront/resolve`, `/api/home` and `/api/products`.
- **SPA fallback** is `assetWithPreview` (L586-645), reached through `app.notFound` (L647).
  - On the apex, `/` passes `ASSETS.fetch` through untouched.
  - `/product/*` and a store home run 1–2 sequential D1 reads (worker/lib/socialPreview.ts:327-498) before any byte is sent. That puts D1 on the document's TTFB, and the rewrite also deletes the `ETag` (L638), so those documents are never answered with a 304.
- **Static asset headers** come from `dist/_headers`, generated by `scripts/write-asset-headers.mjs` from `assetHeadersFile()` in `worker/lib/securityPolicy.ts:301-363`:
  - `/*`: `no-cache` (L192)
  - `/assets/*`: `public, max-age=31536000, immutable` (L191), with unsets so it is not appended to the catch-all
  - `/sw.js`: `no-cache`
  - `/icons/*` and `/fonts/*`: `public, max-age=604800` (L299)
- The comment at L270-284 records a measured **~450 ms first byte from Iraq**. The `dist/_headers` file is missing from the local dist because a bare `vite build` does not write it; `npm run build` does.
- `worker/lib/securityPolicy.ts` and `packages/platform-kit/src/edge/securityPolicy.ts` are identical.

## 3. Edge caching layers (`caches.default`)

| Route | Status | TTL / key |
|---|---|---|
| `/files/*` public keys | EXISTS | `worker/routes/uploads.ts:828-841` looks up the edge cache, then R2. Minted keys get `public, max-age=31536000, immutable`. Rewritable brand keys get `public, max-age=300, must-revalidate` (L912-917). A 304 comes from R2's etag (L927). **Range requests bypass the cache in both directions (L837-841)**, so every `<video>` play or seek is Worker + R2 HEAD + R2 GET. Merchant videos (DECISIONS row 127: MP4/WebM up to 40 MB) are **never edge-cached**. |
| `/api/catalog/tree` | EXISTS | `public, max-age=60, s-maxage=300` (catalog.ts:56). Purged per colo by `purgeCatalogTreeCache`. |
| `/api/catalog/:slug` (signed out) | EXISTS | `public, max-age=60`, key = path only (catalog.ts:57, 272-275). Signed in: `private, no-store`. |
| `/api/printer-finder` | EXISTS | `public, max-age=60, s-maxage=300` (printerFinder.ts:166/185). |
| `/api/public/v1/*` | EXISTS | worker/routes/publicApi.ts:130-176. Canonical sorted-query key, weak ETag, 304s, `max-age=min(60,maxAge), s-maxage=maxAge`. TTLs are 60–3600 s, set in `worker/lib/publicApi/resources/*.ts`. **The SPA never calls it.** |
| **"Cache lifetime fix"** | EXISTS | The zone's Browser Cache TTL (4 h, seen live) was raising `max-age` on cache hits. Every hit is now re-stamped with the route's own policy: catalog.ts:84-96, publicApi/cache.ts:13-18/46-60, tested in tests/edgeCacheLifetime.test.ts. The zone setting itself still says 4 h (dashboard). |
| `/api/home`, `/api/home/sections`, `/api/products`, `/api/products/:slug`, `/api/storefront/*`, `/api/settings/public`, `/api/auth/me` | **MISSING** | No Cache-Control and no edge cache. |
| Browser-only caching | PARTIAL | `/api/bundles` and `/api/farm/leaderboard` send `public, max-age=60` (bundles.ts:89, farm.ts:718). `/api/auth/capabilities` does the same (auth.ts:351). |
| Gateway anonymous-GET cache | EXISTS but DARK | `services/gateway/src/cache.ts` has an allowlist covering `/api/home`, `/api/products`, `/api/products/:slug`, `/api/storefront/*` and `/files/products`. Key is host+path+sorted query+lang; requests with the session cookie bypass it. Not live: cut-over is gate G3 (02-MIGRATION-PLAN.md row 3.2). Its predicates can be reused in the core Worker. |
| HTML stale-while-revalidate | MISSING | The document is `no-cache` only. There is no SWR anywhere. |

## 4. D1 query patterns on hot paths (`worker/routes/products.ts`)

- **No isolate memoisation.** `pricingCtxForUser` (L1921-1948) re-reads settings, the whole `catalogs` table (`catalogAncestry`, membershipBenefits.ts:297), the benefit rules and the pro-pause flag on **every** request, plus the tier for signed-in users.
- **Batching is rare.** `.batch()` appears only in `routes/storeLayout.ts` among the hot files. Everything else is `Promise.all` over separate statements, which means parallel subrequests but one D1 round trip per wave.

**`GET /api/home` (L4188-4408)** runs about 20–24 statements in three dependent waves:
1. pricingCtx (4–5 statements) ∥ settings ∥ discounted ∥ latest (20) ∥ openBox ∥ homeCategoryTree ∥ brands
2. `loadRelationsViews` (8 parallel statements, productOverlay.ts:248-257) ∥ pools ∥ offers
3. reference prices

**`GET /api/home/sections` (L4435-4507)** has four waves: filament root → ids (5) → rows → views + offers + pools.

**`GET /api/products/:slug` (L3835+)** starts with a row read, then a `Promise.all` of pricingCtx, brand, relations, isPrinter, salesBadge and rating. After that come sequential reads: ref, pool member, offer, fits and catalogIndex. That is about 15–20 statements in 5 or more waves, plus an analytics emit. The response is personalised (favorite, tier).

**`GET /api/products` (listing, L3130/3588)** takes 3–4 waves of about 10–14 statements.

**Storefront (`worker/routes/storefront.ts`):**
- `/resolve` (L311-375) and `/:slug` (L377) run `storeBySlug` (1 JOIN), then `publicStore` (tier ∥ delivery ∥ viewerGov, then `storeTakesOrders`), `storeStats` (4 COUNTs) and `storefrontLayoutPayload` (published revision, then block data). That is 3–4 waves.
- On the apex, `/resolve` returns `store:null` without touching D1, but it still pays the session JOIN for signed-in users.
- Verdict for all hot paths: **NEEDS REFACTOR**. Candidates are `db.batch` per wave, memoising settings, rules and ancestry in the isolate for 30–60 s, and edge-caching the anonymous variants.

## 5. Images

| Item | Status | Facts |
|---|---|---|
| IMAGES binding | PARTIAL | Used only to convert uploads to WebP q85 at their original dimensions (`worker/lib/imageConvert.ts:233-262`, `WEBP_QUALITY` L73). It also produces the fixed-size PNG icons in `storeIcons.ts:504`. |
| Client-side downscale | PARTIAL | Uploads are capped at a **3000 px** edge (`src/lib/imagePreprocess.ts:23`); avatars at 512 px. |
| Responsive sizes / srcset / AVIF | MISSING | No per-width renditions, no `?w=` variant route and no Accept-based AVIF. `srcSet` exists only for phone/desktop art-direction crops (CropPhoto.tsx:70, PromoPhoto.tsx:77) and LogoLoop. Product cards (`src/components/home/ProductCard.tsx:112/187`) load the full-size file. |
| Loading hints | EXISTS | `SafeImage` (`src/components/ui/SafeImage.tsx:100-112`) reserves a box, loads lazy by default, and uses `eager` + `fetchPriority="high"` for the hero (Hero.tsx:175) and storefront heroes. It also fades in over 300 ms from `opacity-0` after `onLoad` (L110-112). |

## 6. Fonts and index.html head

- **Cairo** comes from a render-blocking cross-origin `<link rel=stylesheet>` to Google Fonts (`index.html:281-284`, `wght@300..900`, `display=swap`), with preconnects to both Google hosts (L266-267). There is **no Inter** in the project.
- **Kurdish patch face:** self-hosted `/fonts/cairo-kurdish-patch.woff2` (4.8 KB) in `src/index.css:43-50`, restricted by `unicode-range`, `font-display: swap`, cached for 1 week.
- **No preload** for the font or the LCP image. **No Early Hints** `Link` headers.
- **Inline theme script** at L264; its CSP hash is `THEME_BOOT_SCRIPT` in securityPolicy.ts. The inline ground colour is at L286-297.
- **Modulepreload:** Vite adds it automatically for vendor-react, vendor-motion and vendor-i18n.
- **HTML weight:** dist/index.html is 18.5 KB raw / 7.5 KB gzip, but **about 6 KB of the gzip is HTML comments**. Stripped, it is 1.6 KB gzip. No per-request canonical tag.

## 7. PWA service worker (`public/sw.js`, plain JS, `VERSION='v3'` at L85)

| Item | Status | Facts |
|---|---|---|
| Strategies | EXISTS | Documents are network-first, with only `/` stored as the offline fallback. `/assets/*` is cache-first with a 500-entry cap. `/icons/*` is stale-while-revalidate. `/api`, `/files` and the manifest are network-only (`strategyFor` L340-408). |
| Precache | EXISTS | Only the 7 versioned icons (L131-139). |
| Navigation preload | **MISSING** | Never enabled. Every controlled navigation waits for the service worker to boot before its fetch starts. |
| Registration | EXISTS | Happens after `load` (`src/main.tsx:87-112`). |
| Runtime image / API caching | MISSING | By design. |

## 8. vite.config.ts and the bundle as built

- **Config:** `manualChunks` (L47-61) defines vendor-react, vendor-motion (motion only; gsap is referenced only by the unused ScrollReveal.tsx), vendor-webgl, vendor-charts, vendor-phone, vendor-qr and vendor-i18n. No build target, minifier or CSS options are set (defaults). No compression plugin, which Cloudflare makes unnecessary.
- **Initial static closure: 211.5 KB gzip**, about 650 KB raw to parse:
  - index: 81.6 KB (Home is eager, `src/App.tsx:212`)
  - vendor-react: 72.7 KB
  - vendor-motion: 45.6 KB (no `LazyMotion` anywhere)
  - vendor-i18n: 11.6 KB (all three languages)
- **Entry CSS:** 47.5 KB gzip / 335.6 KB raw.
- **CSS budget is currently exceeded:** all stylesheets total **61,447 B = 60.01 KB** against 61,440 B. `tests/bundleBudget.test.ts:63/429-439` would fail by 7 bytes on this build, which includes the community workflow's uncommitted edits.
- **Stray Tailwind classes:** `@import "tailwindcss"` (index.css:63) has no `source()` restriction. About 41 generated selectors are not referenced anywhere in src, packages or index.html (for example `32xl:*`, `text-[>16px]`, `shadow/log-only`); they come from docs and worker text. That is a small, free saving.
- **Budgets** (tests/bundleBudget.test.ts): entry 120 KB (L52), any chunk 250 KB (L54), initial payload 240 KB (L61), CSS 60 KB (L63), storefront closure 47 KB (L331, "AT THE BUDGET"), workspace shell 25 KB and closure 32 KB, analytics screen 16 KB, order screen 12 KB.
- **Idle prefetch:** Products, Product, Cart and Addresses are prefetched when idle (App.tsx:179-202).

## 9. Perf tooling

| Item | Status | Facts |
|---|---|---|
| Lighthouse / PSI / web-vitals scripts | **MISSING** | None in scripts/, package.json or workflows. `tests/firstPaintAndFonts.test.ts` and `tests/seoRoutes.test.ts` only pin earlier PageSpeed fixes statically. |
| Browser automation | EXISTS | Playwright is already used by the scripts/e2e-*.mjs files (for example e2e-motion.mjs:27-32). |

## 10. Client boot waterfall (src/)

1. **HTML, then assets:** CSS, the Google font CSS and its font file, and 4 JS files.
2. **`StoreProvider`** calls `GET /api/storefront/resolve` (`src/StoreContext.tsx:98-128`), and **`AppContent` renders nothing but `RouteFallback` until it answers** (App.tsx:562).
3. **Home mounts** and only then starts `/api/home` (`src/pages/Home.tsx:97-122`). The page cache is in memory with a 60 s TTL (`src/lib/pageCache.ts:74-76`), so a cold visit has no snapshot. `/api/home/sections` goes out in parallel.
4. **The hero image** is discovered only from the `/api/home` payload.
5. **Parallel boot calls:** `/api/auth/me`, `/api/settings/public` (WalletContext.tsx:105), BrowseMissionTimer and the NotificationBell poll.
6. **Mascot:** the `AppIntro` chunk (11.8 KB gzip, requestAnimationFrame engine) waits for resolve, auth and home data before it docks (App.tsx:479).

## Ranked likely costs for an Iraqi visitor (mid-range Android, 4G)

1. **TTFB and LCP: uncached D1 in serial waves, far from Iraq.** The D1 primary is probably outside the region, there is no Smart Placement or read replication, and `/api/home` (~22 statements, 3 waves), resolve (3–4 waves) and the product page (5+ waves) each cross the Worker-to-D1 distance per wave. Signed-in users add a session JOIN, and settings and ancestry are re-read on every call. Mitigations: edge-cache the anonymous `/api/home`, `/api/home/sections`, `/api/products`, product pages and storefront for 30–60 s (port the gateway rules); `db.batch` each wave; memoise in the isolate; add a D1 location hint or smart placement; measure with `served_by_region`.
2. **LCP: a serial client waterfall.** Render is gated on resolve, `/api/home` starts only after mount, and the hero image is discovered late with no preload. Mitigations: start resolve and home fetches at module load; decide apex versus merchant from `location.host` when possible; add a preload or early hint for the hero.
3. **LCP bytes: full-resolution images.** Files up to 3000 px WebP are used for cards and the hero, with no srcset and no AVIF. Every public image is a Worker invocation even on an edge hit, and each image adds a 300 ms opacity fade.
4. **LCP/FCP: render-blocking resources.** 47.5 KB gzip of CSS plus a cross-origin Google Fonts stylesheet and font (two extra origins, and a Cairo swap that reflows Arabic text), plus 211 KB gzip / ~650 KB raw of JS to parse before anything renders. There is no SSR; the eager `motion` chunk (45.6 KB) and the all-language i18n chunk (11.6 KB) are part of it.
5. **INP / TBT: main-thread load.** Full `motion` with no LazyMotion, the mascot's requestAnimationFrame engine and pointer tracking during boot, 89 `backdrop-blur` usages, polling timers, and client-only rendering of the whole shell.
6. **Video (reels, backgrounds):** range requests are never edge-cached, so every play is R2 through the Worker (uploads.ts:837-841).
7. **Repeat navigations:** no navigation preload; product and store documents lose their ETag, so they are never answered with a 304.
8. **CLS: low to medium.** Font swap on Cairo and the Kurdish patch, and the switch from `RouteFallback` to the shell. Hero (380 px) and SafeImage boxes are already reserved.
9. **Small free wins:** about 6 KB gzip of HTML comments in index.html, about 41 stray Tailwind selectors, and the CSS already 7 bytes over its 60 KB budget.

## Reuse list
- `worker/lib/publicApi/cache.ts`: `edgeCache`, `weakEtag`, `conditional`.
- `cached()` in `worker/routes/catalog.ts:81`.
- `services/gateway/src/cache.ts`: `canCache`, `canStore`, `cacheKey`, `CACHE_ALLOWLIST`.
- `ASSET_CACHE_CONTROL` / `DOCUMENT_CACHE_CONTROL` and `assetHeadersFile()` in securityPolicy.ts; Early Hints `Link` lines could be generated in write-asset-headers.mjs.
- `strategyFor` in `public/sw.js`, where navigation preload could be added.
- `SafeImage` `eager` / `fetchPriority`.
- The Playwright harness in scripts/e2e-*.mjs, which a Lighthouse or web-vitals script could build on.
- The budget helpers in `tests/bundleBudget.test.ts` (`staticClosure`, `staticImports`).

Key files: /home/user/Levonis/wrangler.jsonc, /home/user/Levonis/worker/index.ts, /home/user/Levonis/worker/lib/securityPolicy.ts, /home/user/Levonis/scripts/write-asset-headers.mjs, /home/user/Levonis/scripts/prepare-deploy-config.mjs, /home/user/Levonis/.github/workflows/deploy-staging.yml, /home/user/Levonis/worker/routes/uploads.ts, /home/user/Levonis/worker/routes/catalog.ts, /home/user/Levonis/worker/lib/publicApi/cache.ts, /home/user/Levonis/worker/routes/publicApi.ts, /home/user/Levonis/worker/routes/products.ts, /home/user/Levonis/worker/routes/storefront.ts, /home/user/Levonis/worker/lib/productOverlay.ts, /home/user/Levonis/worker/lib/session.ts, /home/user/Levonis/worker/lib/socialPreview.ts, /home/user/Levonis/worker/lib/imageConvert.ts, /home/user/Levonis/services/gateway/src/cache.ts, /home/user/Levonis/index.html, /home/user/Levonis/src/index.css, /home/user/Levonis/src/main.tsx, /home/user/Levonis/src/App.tsx, /home/user/Levonis/src/StoreContext.tsx, /home/user/Levonis/src/pages/Home.tsx, /home/user/Levonis/src/components/ui/SafeImage.tsx, /home/user/Levonis/src/lib/imagePreprocess.ts, /home/user/Levonis/src/lib/pageCache.ts, /home/user/Levonis/public/sw.js, /home/user/Levonis/vite.config.ts, /home/user/Levonis/tests/bundleBudget.test.ts, /home/user/Levonis/tests/edgeCacheLifetime.test.ts, /home/user/Levonis/tests/firstPaintAndFonts.test.ts, /home/user/Levonis/docs/WORKERS.md, /home/user/Levonis/docs/architecture/01-TARGET.md

## Survey — media-reels

## Media pipeline for video, GIF and reels (read-only survey, HEAD, latest migration 0154)

### 1. Upload path: `worker/routes/uploads.ts` (950 lines). EXISTS
- Limits: `IMAGE_MAX` = 8 MB (L36), `VIDEO_MAX` = 40 MB (L37). The client mirrors them in `src/lib/imagePreprocess.ts:19-22`. Rate limit is `upload` 60/h (L262).
- Purposes (L267): receipt, avatar, chat, product, community, support, complaint, post. `community` requires a store and otherwise returns 403 `STORE_REQUIRED` (L283-285).
- Video is allowed for product, chat, support, complaint, community and post (L324-326). The whole body is read into memory (L331). There is no multipart or resumable upload.
- Full container sniff only for `community`/`post` (L335-344): `sniffVideo` (`worker/lib/videoSniff.ts:185`) walks the MP4 boxes or WebM EBML and requires a `vide` track in avc1/avc3/hvc1/hev1/av01/vp09 or V_VP8/VP9/AV1 (videoSniff.ts:30-31, 80-108). A failure returns 400 `VIDEO_UNSUPPORTED`. Chat, support and admin product clips pass only the magic-byte `sniff` check (L139-193).
- Quota: `MERCHANT_PUBLIC_VIDEO_QUOTA_BYTES` = 1 GiB (L46). It counts live public videos per owner per domain (`merchants` for community, `users` for post) with a soft `SUM(byte_size)` check (L345-358), and refuses with `VIDEO_QUOTA_EXCEEDED`. Images have no quota.
- Keys (L581-593): community goes to `merchants/<uid>/public/<id>.<ext>`, post to `users/<uid>/posts/…`. Public objects are stored with `public, max-age=31536000, immutable` (L594).
- Video `width`/`height` are always NULL in `file_objects`: dimensions are only read for images (L498). Duration is never measured on the server, even though `sniffMp4` already walks `moov` (it could read `mvhd`/`tkhd`).
- **No faststart check.** `sniffMp4` only requires that `moov` exists somewhere (videoSniff.ts:89-90). An MP4 with `moov` after `mdat` is accepted, and the browser then needs an extra ranged round trip to the end of the file before the first frame.
- **Transcoding and posters: MISSING (confirmed).** There are no ffmpeg, HLS, m3u8 or Stream references anywhere in worker/src/packages/services. The only bindings are D1 `DB`, R2 `BUCKET`/`R2_PUBLIC`/`R2_PRIVATE` and `images: IMAGES` (wrangler.jsonc; `worker/lib/types.ts:8-22`). **There is no Cloudflare Stream binding, account id or API token.** `IMAGES` is used only for PNG/JPEG→WebP (`worker/lib/imageConvert.ts:191` `CONVERTIBLE = {png, jpeg}`).

### 2. Delivery: `GET /files/*` (uploads.ts L696-950). PARTIAL / NEEDS REFACTOR for video speed
- Public prefixes (`worker/lib/mediaStorage.ts:667-695`) include `merchants/<uid>/(public|logos|covers)/` and `users/<uid>/(avatar|public-avatars|posts)/`. Private prefixes are checked per request: receipts, chat participant, support, complaints, trade-in (L700-799).
- Ranges: `parseByteRange` (L637-656) gives 206 with `Content-Range`, 416, `If-Range` and `Accept-Ranges: bytes` on every response (L864-935). Tested in `tests/fileRangeDelivery.test.ts`.
- Headers: `Content-Type` comes from R2 httpMetadata (L888). Minted keys get `immutable` for a year; rewritable brand keys get `max-age=300, must-revalidate` (L912-917). Also `nosniff` and `CSP default-src 'none'; sandbox` (L921-922), and 304 on `If-None-Match` (L927).
- **Problem 1: the edge cache is skipped for every Range request** (L837-841, L938). Browsers fetch `<video>` with Range, so every public reel or store video segment costs a Worker call, an R2 HEAD (L867) and a ranged R2 GET (L885) from the R2 region, never from the colo cache. This is the main latency cost for visitors in Iraq.
- Possible fixes: fill the cache with the full object and answer ranges from the cached copy (check whether the Workers Cache API answers Range on `match`), or serve public video from an R2 custom domain with CDN caching.
- **Problem 2:** the 304 check runs after a full R2 GET (L885 vs L927), and the HEAD could be dropped because R2's range GET already returns the size.
- **Review media does not support Range.** `GET /api/reviews/media/*` (`worker/routes/reviews.ts:947-1060`) serves the full body with `no-cache` and never reads `Range`. The `/files` comment (L844-854) explains that iOS Safari will not play video from a server like that, so review videos (40 MB, reviews.ts:68) probably do not play on iPhone.
- CSP for pages is `media-src 'self' blob: https:` (`worker/lib/securityPolicy.ts:138`), which is fine for same-origin video.

### 3. GIF end to end. EXISTS for merchant and user surfaces, MISSING optimisation
- Client: `detectConvertibleRaster` handles PNG/JPEG only (imagePreprocess.ts:55-59). GIF and AVIF are passed through unchanged under the 8 MB cap (L343-359, `passthroughLimit` L78-86). **Animation is preserved.**
- Server: `isConvertibleToWebp` excludes GIF (imageConvert.ts:184-195), so GIFs are stored as `image/gif` (uploads.ts L453-458). The exception is `purpose=product` (admin catalogue): an animated GIF is refused with `IMAGE_ANIMATED_GIF_UNSUPPORTED` (uploads.ts L422-426; imageConvert.ts:292-296).
- Accepted as references: layout media (`packages/storeLayout/src/refs.ts:34-37`, image regex includes gif), store logo, banner and showcase (`worker/lib/mediaRefs.ts:40` `OBJECT_RE`, `worker/routes/merchant.ts:318-325`, 1631-1635), merchant product media (`src/components/merchant/catalog/MediaEditor.tsx:24`), and the builder picker (`src/components/merchant/storeDesign/pickers.tsx:302-305`).
- Missing: no GIF→animated WebP or MP4 conversion, no GIF-specific size cap. An 8 MB GIF hero is sent to every visitor as-is with `fetchPriority="high"` (`src/components/storefront/blocks/Hero.tsx:63`), which hurts LCP.

### 4. Components that render `<video>` today
| File:line | autoplay | muted | poster | preload | notes |
|---|---|---|---|---|---|
| `src/components/storefront/blocks/Video.tsx:38-48` | only if `s.autoplay` and not reduced motion | when autoplay | **merchant-chosen** `s.poster` | metadata | controls, loop when autoplay; has its own `usePrefersReducedMotion` |
| `src/components/community/projects/MediaStrip.tsx:129-166` | no (tap to play) | yes | **none** | metadata | loop, pauses off-slide |
| `src/components/catalog/ProductGallery.tsx:52-60` | no | no | none | metadata | video thumbnails are a Play icon on black (L76-79) |
| `src/components/merchant/storeDesign/pickers.tsx:311` | no | yes | none | metadata | library thumbnail |
| `src/components/community/projects/MediaPicker.tsx:136` | no | yes | none | metadata | composer thumbnail |
| `src/components/chat/ChatAttachment.tsx:81-88`, `src/pages/Support.tsx:1173`, `src/components/adminSupport/MessageMedia.tsx:28` | no | no | none | metadata | |
| `src/components/reviews/ReviewSection.tsx:715`, `src/components/AdminReviews.tsx:642`, `src/pages/Product.tsx:3820,3955`, `src/components/warranty/ClaimThreadOverlay.tsx:250` | no | no | none | none | |
| `src/pages/Rewards.tsx:802` | yes | **no** | none | default | admin `adVideoUrl` (any http(s) URL, `worker/routes/admin.ts:3869-3871`) |

**Bug:** a project whose first media item is a video gets `cover.url` pointing to the `.mp4` (`worker/routes/communityPosts.ts:92`). `ProjectCard.tsx:37-49` renders that URL in `<SafeImage>`, so the card shows the ImageOff fallback (`src/components/ui/SafeImage.tsx:109,123-125`) with a play badge. There is no poster or thumbnail to show instead. This is in the churn zone (community components).

### 5. merchant_showcase. EXISTS, image only
- `migrations/0036_store_builder.sql:67-79`: columns id, store_id, `kind` CHECK (printer | material | work), title, details, `image_key`, sort_order, active, created_at. **There is no video or media_kind column.**
- Routes `worker/routes/merchant.ts:1597-1690` (GET/POST/PATCH/DELETE `/showcase`, maximum 60) validate with `ownedMediaKey`, whose regex is images only. Block settings: `packages/storeLayout/src/blocks.ts:218-225`.

### 6. community_posts media (0153). EXISTS
- `migrations/0153_community_posts.sql`: `community_posts.kind` is project | post | tutorial | timelapse | before_after. `community_post_media` (L118-128) has kind (image | video), media_key, width, height, `duration_s`, sort_order.
- width, height and `duration_s` are **declared by the client**. The route clamps them (`communityPosts.ts:484-494`), and the composer measures duration with `loadedmetadata` (`MediaPicker.tsx:50,99`).
- `checkMedia` (communityPosts.ts:561-575) checks ownership and the ledger's image/video kind.
- The client also accepts `video/quicktime` (`MediaPicker.tsx:34`). The server stores a `qt  ` brand only when the codec passes `sniffVideo`.
- `community_product_media` (0126:178-190) is image|video, positions 0-11. `MAX_VIDEOS = 2` (`worker/lib/catalog/product.ts:35,402`).

### 7. Model-viewer token pattern (reusable for private media). EXISTS
`worker/routes/printRequests.ts:1657-1860`, table `model_view_tokens`:
- 32-byte random token stored as a sha256 hash.
- TTL of 60 minutes (`VIEWER_TOKEN_TTL_MINUTES`).
- Bound to the account that minted it (`bound_user`), and to the request revision and grant level.
- Revoked when the request closes (`worker/lib/communityRequests.ts:227-240`).
- Every read is audited (`fileReadStatement`), responses are `no-store`, and the original file is never served.

This fits private clips (for example request or order videos), but it would need Range support added.

### 8. Planned but not built
`docs/COMMUNITY_ECOSYSTEM.md` §9.4 (L242-300) plans migration **0158** with:
- `upload_sessions`: R2 multipart, resumable, with sha256 verification.
- `file_objects.sha256` and `purpose` columns.
- An admin `uploadLimits` setting (defaults video 100 MB, chunk 8 MB).
- `worker/routes/uploadSessions.ts`.

None of it exists; the latest migration is 0154. Earlier merchant decisions are in `docs/DECISIONS.md` row 127 (merchant video W2-F: MP4/WebM, 40 MB, 2 videos and 12 files per product) and row 132 (only store owners upload public video).

**Doc conflict:** `COMMUNITY_ECOSYSTEM.md:680` («video tap-to-play, never autoplay») and `COMMUNITY_HOME_PLAN.md:161` (poster, `preload="none"`, tap to play, one at a time) forbid autoplay. A reels feed needs an explicit owner decision recorded as a new DECISIONS row.

### 9. Verdicts
| Item | Status | Evidence |
|---|---|---|
| Reels (vertical swipe feed, mute toggle, progress) | **MISSING** | "reel" appears in no route, page or component (grep hits are unrelated). Candidate sources: `community_posts` kind `timelapse`/`post` with video media, product videos, store video blocks. Pieces to build on: `MediaStrip` snap pattern, `useRail`, `useMotion` |
| Video posters/thumbnails | **PARTIAL** | Only the store video block has a manually chosen poster (blocks.ts:275). No automatic posters; the ProjectCard video cover is broken (§4) |
| HLS / transcoding | **MISSING** | No Stream binding, no ffmpeg. Progressive MP4/WebM only, no faststart check |
| GIF end to end | **EXISTS, needs optimisation** (§3) | Refused for admin products only |
| Background video on storefront hero | **MISSING** | `hero` settings are `image` only (blocks.ts:107-124). `Hero.tsx:36,63` and `HeroVariants.tsx:33,73` render `<img>`. `ThemeTokens` has no background media (tokens.ts:47-59). Store logo and banner are images only (mediaRefs.ts:40). Adding a `video` media field is additive under `SCHEMA_VERSION` 1 |
| Per-store media library | **PARTIAL** | `GET /api/merchant/store/layout/media?kind=image\|video` (`worker/routes/storeLayout.ts:590-640`, keyset paging, owner's `merchants` domain, filtered by `mediaKey`). `MediaPicker` sheet with grid, upload and pick (pickers.tsx:317-460). Gaps: builder only (MediaEditor.tsx:141-142 and store settings use bare file inputs), no delete, no alt text, no used-in or size/quota display, no search, `users/<uid>/posts` media is not shown |
| Media quotas per plan | **MISSING** | Flat 1 GiB public video per owner (uploads.ts:46), no image quota. `membership_plans` (0030) has no storage fields. Limits are constants; the planned `uploadLimits` setting is unbuilt |
| Range/caching for video | **NEEDS REFACTOR** | Ranges are served from R2 every time (§2); review media has no Range |
| Upload progress UX | **MISSING** | `uploadFile` (`src/lib/api.ts:1991-2046`) uses fetch with no progress, only a timeout sized at 32 KB/s. `TradeInWizard.tsx:92` has an XHR `upload.onprogress` pattern to copy |

### Reuse list
- **Validation and storage:** `sniffVideo`, `sniff`, `MERCHANT_PUBLIC_VIDEO_QUOTA_BYTES`, `buildMediaKey`, `putMediaObject`, `isAnonymousPublicMediaKey`, `parseByteRange`, `edgeCacheKey` (uploads.ts, mediaStorage.ts).
- **Store layout:** `mediaKey`/`mediaSrc` (refs.ts) and the `{t:'media', kind:'video'}` field spec (blocks.ts), `storeLayoutRoutes.get('/media')`, `MediaPicker` and `MediaThumb` (pickers.tsx).
- **Rendering:** `VideoBlock` and its reduced-motion hook (storefront/blocks/Video.tsx), `MediaStrip` (tap to play, pause off-screen).
- **Community data:** `community_post_media.duration_s` and the `timelapse` kind.
- **Private access:** the `model_view_tokens` flow (printRequests.ts:1657-1860).
- **Cleanup:** media cleanup cron and jobs (`worker/lib/mediaRefs.ts`, `SWEEP_MIN_AGE_MS` = 24 h at L1496). The sweep registry already covers layout blocks, `community_post_media` and `community_product_media` (mediaRefs.ts:311-368).

Key files: /home/user/Levonis/worker/routes/uploads.ts, /home/user/Levonis/worker/lib/videoSniff.ts, /home/user/Levonis/worker/lib/imageConvert.ts, /home/user/Levonis/worker/lib/mediaStorage.ts, /home/user/Levonis/worker/lib/mediaRefs.ts, /home/user/Levonis/src/lib/imagePreprocess.ts, /home/user/Levonis/src/lib/api.ts, /home/user/Levonis/worker/routes/reviews.ts, /home/user/Levonis/worker/routes/storeLayout.ts, /home/user/Levonis/worker/routes/merchant.ts, /home/user/Levonis/worker/routes/communityPosts.ts, /home/user/Levonis/worker/routes/printRequests.ts, /home/user/Levonis/packages/storeLayout/src/blocks.ts, /home/user/Levonis/packages/storeLayout/src/refs.ts, /home/user/Levonis/packages/storeLayout/src/tokens.ts, /home/user/Levonis/src/components/storefront/blocks/Video.tsx, /home/user/Levonis/src/components/storefront/blocks/Hero.tsx, /home/user/Levonis/src/components/merchant/storeDesign/pickers.tsx, /home/user/Levonis/src/components/community/projects/MediaStrip.tsx, /home/user/Levonis/src/components/community/projects/ProjectCard.tsx, /home/user/Levonis/src/components/community/projects/MediaPicker.tsx, /home/user/Levonis/src/components/catalog/ProductGallery.tsx, /home/user/Levonis/migrations/0036_store_builder.sql, /home/user/Levonis/migrations/0153_community_posts.sql, /home/user/Levonis/migrations/0126_catalog_variants.sql, /home/user/Levonis/wrangler.jsonc, /home/user/Levonis/docs/COMMUNITY_ECOSYSTEM.md, /home/user/Levonis/tests/fileRangeDelivery.test.ts

## Survey — i18n-motion-shell

## UI system audit: what new merchant/store work has to fit into

Measured against HEAD b726a1c6. The `dist/` build is from 05:35 and no source file is newer, so these numbers are current.

**Budget headroom (read from dist/assets):**

| Budget | Now | Limit | Left |
|---|---|---|---|
| CSS total | 61,379 B | 61,440 B | 61 B |
| Storefront closure | 46.2 KB | 47 KB | ~0.8 KB |
| Workspace shell | 15.9 KB | 25 KB | ~9 KB |
| Shell closure | 30.7 KB | 32 KB | ~1.3 KB |
| Entry | 81.6 KB | 120 KB | ~38 KB |
| Initial payload | 211.5 KB | 240 KB | ~28 KB |

The `StoreDesignPanel` chunk is 38.5 KB, under the 250 KB per-chunk limit.

### 1. Motion — EXISTS
`src/lib/motion.ts`
- `SPRING` (L62-86):
  - `ui` = spring(0, .35)
  - `move` = (0, .4)
  - `sheet` = (.2, .3)
  - `momentum` = (.2, .4)
  - `rotate` = (.2, .4)
  - `quick` = (0, .25)
- Constants: `CROSS_FADE` = 150 ms (L91), `PRESS_MS` = 100 (L98).
- `useMotion()` (L127-143) returns `{reduced, spring(name), dir ±1, inline(px), travel(px)}`.
- Gesture maths:
  - `project(v, d=.998)` (L164)
  - `rubberband(overshoot, dim, .55)` (L176)
  - `nearestSnap` (L182)
  - `VelocityTracker` (100 ms window, L192)
  - `DRAG_THRESHOLD_PX` = 10 (L226)

`src/lib/useRail.ts:199`
- `useRail({items, decelerationRate, snap, drag})` returns `{ref, page(±1)}`.
- Mouse drag uses project + snap + rubberband. It leaves touch fling to the browser and fixes the RTL `scrollLeft` direction.

`docs/MOTION.md` rules:
- Feedback starts on press-down (§1).
- Springs for anything touchable; CSS transitions only for colour/opacity (§2).
- Bounce only when the gesture carried momentum.
- Overlays are symmetric and scale from their anchor (§3).
- Reduced motion becomes a cross-fade, not a dead UI (§6).
- "Forward" is the logical direction (§7).
- No `letter-spacing` on Arabic (§9).
- Browser checks: `scripts/e2e-motion.mjs`, `e2e-rails.mjs`, `e2e-ui-kit.mjs`.

**Legacy that bypasses the kit — NEEDS REFACTOR**
- `src/components/AnimatedItem.tsx:4-18`: `any` props, scale 0.8, `stiffness:100`, index stagger. It has no `useMotion`, so reduced motion is ignored; there is no global `MotionConfig` (only `storeDesign/BlockList.tsx:88`). Its only user is `home/BundlesShelf.tsx`. `docs/COMMUNITY_HOME_PLAN.md` §5 says not to use it.
- `Counter.tsx` and `Stack.tsx` also use raw `stiffness`.
- 34 files use `useMotion()`.

### 2. Route and page transitions — MISSING by design (PARTIAL overall)
- No animation between routes: no `AnimatePresence` around `Routes`, no `view-transition-name`.
- `NavigationRouter.tsx:49-63` wraps history in `useTransition`, so the old page stays on screen. `useBusy(pending,'route')` shows the `AppBusy` overlay after `ROUTE_BUSY_DELAY_MS` = 250 (`ui/AppBusy.tsx:94`).
- `RouteFallback` (`App.tsx:106-133`) is `min-h-dvh` plus `useBusy(true,'route')`.
- `ChunkBoundary.tsx` reloads when a chunk fails and has ar/en/ckb copy.
- Scroll restore per `location.key`, with POP restoring the offset: `App.tsx:~485-550`.
- `pageCache.ts` keeps "back" from refetching; `useFreshOnReturn.ts` handles bfcache.
- View Transitions are used only for:
  - the language swap (`lib/langSwap.ts:100`, `index.css:1380-1404`)
  - the theme switch (`lib/theme.ts:181-188`, circular reveal)
- `busy.ts:165` `useBusy(active, reason)`: the reasons are a closed set (`order|payment|subscribe|quote|route`). A new reason needs hand-written ar/en/ckb in `AppBusy.tsx:126-131`.

### 3. Primitives (`src/components/ui/`) — EXISTS

**Overlay.tsx** (904 lines, eager)
- `UI_LAYERS` {header 100, bottomNav 120, popover 160, overlay 200, toast 280} (L79).
- `Overlay` (L364), props L274-344:
  - `open`, `onClose`, `children` (node or function)
  - `label`, `labelledBy`, `describedBy`, `alert`
  - `mode: 'modal'|'parallel'`, `anchor`, `placement: center|bottom|top|dock`, `panelClassName`
  - `dismissOnEscape`, `dismissOnScrim`, `dirty`
  - `initialFocus`, `trapFocus`, `restoreFocus`
  - `z`, `testId`, `panelMotion`, `solid`, `onExited`
- Legacy `Sheet` (L631-657): `height`, `docked`.
- `Anchored` popover (L722-757): `anchor`, `align start|end`, `role`.
- The stack lives in `overlayStack.ts` (`pushLayer` L118).

**Sheet.tsx** (v2, lazy only)
- Adds `dragHandle`, `detents: ('medium'|'large')[]`, `defaultDetent`, `header`, `footer` on top of the legacy props (L55-66).
- medium = 50% of the visible height; large = H − max(56, 8%) (L78-80).
- **PARTIAL:** ckb `expand`/`collapse` is the Arabic under the OWNER marker (L68-75).

**Menu.tsx:196**
- `MenuItem` {id, label, icon, onSelect, href, destructive, disabled, hint}, plus `{id, separator}`.
- Props: `label`, `items`, `trigger(props)`, `align`, `presentation: 'auto'|'popover'|'sheet'`, `onOpenChange`.
- Becomes a sheet on a coarse-pointer phone.

**Tabs.tsx**
- `TabStrip` (L90): `items` {id, label, badge, show, href}, `value`, `onChange`, `group` (the layoutId), `indicatorClassName`, `activeClassName`, `idleClassName`, `fill`, `label`, `panels`.
- `TabPanels` (L231): `value`, `order[]`, `group`. The body slides in by `dir`.

**Segmented.tsx:69**
- `items` {id, label, icon, badge, accent{indicator, text}, disabled}.
- Props: `value`, `onChange`, `label`, `group`, `dataAttr`, `size md|sm`.
- A radiogroup with a travelling indicator.

**Switch.tsx**
- `Switch` (L41): `checked`, `onChange`, `label`, `description`, `disabled`, `busy`, `id`.
- `Checkbox` (L99): `indeterminate`.

**Field.tsx**
- `Field` (L64): `label`, `hint`, `error`, `required`, `optional`, `id`.
- `Input` (L119, `ltr`), `Textarea` (L126), `Select` (L138).
- `useFieldControl`; `focusFirstInvalid` (L157).

**Button.tsx**
- `Button` (L85): variant `primary|secondary|ghost|danger|accent`, `size md|sm`, `loading`, `loadingLabel`, `icon`, `iconEnd`, `block`.
- `onClick` may return a promise; a synchronous press guard blocks a second press.
- `IconButton` (L147): `label` required, `variant ghost|secondary|danger`, `badge`. 44 px hit target, 36 px disc.

**Dialogs and toasts**
- `ConfirmDialog.tsx`: {`title`, `consequence`, `confirmLabel`, `cancelLabel`, `destructive`, `busy`, `error`}; `useConfirm()` (L167).
- `PromptDialog.tsx`: `usePrompt()` (L209) with {`label`, `validate`, `multiline`, `maxLength`, `inputMode`…}.
- Toasts: `toast.success|error|info(title, {description, action, duration, id})` (`lib/toastStore.ts:72`); `<Toaster aboveNav/>` (`Toast.tsx:162`); `ToasterGate`.

**Loading states**
- `Skeleton.tsx`: `Skeleton`, `SkeletonGroup`, `ProductCard/Grid/Row/Detail`, `Cart`, `Bundle*` (`animate-pulse motion-reduce:animate-none`).
- `DashboardSkeletons.tsx`: `ListRows`, `TableRows`, `KpiRow`, `Form`, `Card`.
- `AsyncStates.tsx`: `ErrorState`, `EmptyState`, `NotFoundState`, `UnauthorizedState`.

**DataList.tsx:120**
- Columns {id, header, cell, `card: title|badge|meta|field|hidden`, numeric, width}.
- Props: `rows`, `rowKey`, `loading`, `error`, `onRetry`, `empty`, `rowActions`, `rowLabel`, `rowHref`, `selection`, `wideAt`, `skeletonRows`.
- Shows either a table or cards (one layout), sized by a container ResizeObserver.

**KpiTile.tsx:65**
- `label`, `value` (null shows «—»), `delta` {value, format, label, good}, `trend`, `hint`, `icon`, `loading`, `to`.
- `Sparkline` (L134).

**Card.tsx:37**
- `title`, `description`, `action`, `level 2|3|4`, `padding md|none`, `as`, `id`. It is `.lv-surface`.

**Also available:** `Badge`/`StatusChip` (6 tones), `Money` (`<bdi dir=ltr>`), `NumberInput` (never `type=number`), `QuantityInput`, `SafeImage` (`aspect`, `fit`, `eager`, `onStatus`), `Note`, `Spinner`, `Countdown`, `CommandPalette`, `SummaryInfo`.

**NEEDS REFACTOR:** `statCards.tsx:20-26` defines five TINTS (purple/sky/emerald/amber/red). That conflicts with the one-accent rule `KpiTile` pins (`uiPrimitives.test.ts:300`).

### 4. `src/index.css` (1,849 lines) — EXISTS

**Tokens**
- Core `@theme` (L144-173): black, white, canvas, surface, surface-raised, surface-selected, border-subtle, text-primary/secondary/muted, success, warning, danger, info, focus, olive(-dark/-light), gold(-light).
- Radius sm/md/lg/xl (L174-177). `--default-font-family` = Cairo (L185).
- L205-223: accent, accent-contrast, `--shadow-1/2/3`, `text-ui-2xs…xl`.
- `:root` (L231-242): `--z-header/bottom-nav/popover/overlay/toast/busy`, `--duration-press/quick/ui`, `--shell-bottom-inset`.
- Fixed and tone colours (L1437-1475): ivory, paper, ink, charcoal, gold-muted/ink, snow, onyx, cream, gold-fill, primary-fill, danger-ink, error-ink, and tones gilt, iris, mint, crimson, honey, coral, leaf, moss, blush, sage, scarlet, apricot, sprout, aqua, flame, petal, wheat.

**Utilities**
- `@layer components` (L303-552):
  - `.lv-surface` (L304), `-raised` (L310), `.lv-section` (L317), `.lv-hit` (L331)
  - `.lv-choice` (L338, inset gold bar mirrored in RTL at L363), `.lv-choice-mark` (L378)
  - `.lv-button` (L400) with primary (L433), secondary (L443), ghost (L449), danger (L455), sm (L472), accent (L484)
  - `.lv-input` (L508), `.lv-field-error` (L534), `.lv-alert` plus success/warning/danger/info (L541-551)
- Coarse-pointer 16 px input floor: L614-631.
- Press feedback:
  - base `:active` opacity .72 over 100 ms (L633-657)
  - `@utility press-scale` 0.97 (L661), `no-press` (L672)
- `.material` (L699), `-thick` (L704), `-thin` (L709) — the filter is a single variable (minifier trap, see MOTION §5).
- `.scroll-edge`, `-up` (L718-731).
- Reduced motion / reduced transparency / more contrast: L741-787.
- Arabic/Kurdish tracking reset and leading floor: L818-830.
- `pb-safe`, `hide-scrollbar`, `bleed-x`: L832-873.
- `.nav-clearance` (L976); `--nav-stack` (L994-1005).
- An open overlay hides the nav: L1008.
- Compact density (pointer: fine only): L254-293.
- Light-theme bars (`.lv-topbar-scrim/solid`, `[data-bottom-nav-group]`, `[data-nav-scrim]`): L1543-1583.
- `.lv-bleed-scrim` (L1620), `-ground` (L1633), `-scrim-deep` (L1662).
- Shadows follow the theme: L1700-1710. `.lv-scrim` (L1715). `.lv-promo-zone/photo` (L1730). `.lv-fade-top/start` (L1756).

**Themes**
- L1478-1479 is generated by `scripts/theme-tokens.mjs --write`: `[data-theme='light']` and `[data-theme='dark'],[data-store-theme]` re-point every `--color-*` and the zinc/red/… ramps.
- Utilities are `var()`-based, so a theme is simply a set of values.
- A subtree with `data-theme="dark"` stays dark.
- Feature surfaces (`[data-feature]`) re-point charcoal, ivory and gold-muted in light (see `lightThemeFeatureSurfaces`).

### 5. Store themes — EXISTS (closed enums)
`packages/storeLayout/src/tokens.ts`
- 11 tokens (L47-59): accent (store + 7), surface (glow/ink/graphite/carbon/midnight), radius, density, typography, card, product_card, image_ratio, section_spacing, grid_columns 2|3, width.
- 7 presets (L92-124). The file itself says: "no colour picker, no font field, no CSS box" (L4-8, `MERCHANT_PLATFORM.md` §2 rule 12).

`src/components/storefront/theme.ts`
- `ACCENTS` are Tailwind class sets (L33-41).
- `themeAttributes` emits `data-store-theme` plus nine `data-sf-*` attributes (L64-77).
- `gridClasses` uses container queries (L84-89).

`StoreTheme.tsx:33` wraps the page; `useStoreTheme()` (L29).

`theme.css` (lazy, about 1.5 KB gz)
- `[data-store-theme]` sets `--sf-bg/card/line/tile/fact/well/raised/menu`, `--sf-r-*`, `--sf-pad/grid-gap/tile-pad`, `--sf-section-gap`, `--sf-strong/scale`, `--sf-col` (L17-50), and lifts zinc-500/600 for contrast.
- One attribute selector per enum value, plus classes `.sf-col`, `.sf-stack`, `.sf-name/display/title`, `.sf-card/row/fact/well/menu/tile/media`, `.sf-cover-fade`.
- Hex is allowed here only because `themeSystem.test.ts:48` exempts `src/components/storefront/`.
- **MISSING:** any media, background or GIF token. Store themes are dark only by decision.

### 6. Language — PARTIAL, and the Sorani policies conflict
- `LanguageContext.tsx`: `loc(ar, en, ckb?)` (L56) falls back from ckb to Arabic. The context also gives `t`, `dir`, `setLang`.
- Per-feature `strings.ts` tables:
  - admin*: 6 tables
  - `community/projects`, `community/social` — real Sorani, 0 OWNER markers
  - `compare/*`, `finder`
  - `merchant/{catalog,finance,share,shell}`
  - `onboarding`, `scanner`, `warranty`, `lib/refusalStrings.ts`
- The two policies:
  - `MERCHANT_PLATFORM.md` §8 and the header of `shell/strings.ts`: Sorani is never machine-written; the Arabic stands in with `// OWNER: Sorani to be written by hand.`
  - `DECISIONS.md` row 166 (4): reversed for the community scope — real Sorani (D6).
- Tests that police Sorani:

| Test | Lines | Covers | Rule |
|---|---|---|---|
| `uiPrimitives.test.ts` | L352-398 | the 16 primitives in `NEW_PRIMITIVES` plus Overlay/Tabs, and 5 lib files | every ckb string must already exist verbatim elsewhere in `src`, or be the Arabic under the marker |
| `merchantWorkspaceShell.test.ts` | L315-331 | `W` and `src/components/merchant/shell/**` | same corpus rule |
| `finderStrings.test.ts` | L225-231 | finder and lens strings | ckb must EQUAL ar, with the marker |
| `communitySocialUi.test.ts` | L70-100 | social strings | ≤10% identical to ar, ≥90% contain a Kurdish letter |
| `refusalStrings.test.ts` | L48-92 | refusal codes | ckb ≠ ar ≠ en |

- **Implication:** write real Sorani in a new feature strings file outside `shell/` and `ui/`. The shell and primitives can then reuse it verbatim.
- **Shell `W` table** (`merchant/shell/strings.ts:21-88`): 45 keys, 14 without ckb:
  - storeDesign, catalogue, workshop, store
  - searchPlaceholder, newCollection, goTo, actions, results, skipToContent, storeStatus
  - suspended, lapsed, restricted
  - Also `sellingReason('merchant_restricted')` (L118-124) is ar/en only.
- **Merchant Sorani debt (OWNER markers):** catalog/strings 159, finance/strings 79, StoreSettingsTab 39, share/strings 27, DeliverySettingsEditor 27, CollectionsManager 23, SalesTabs 17, shell/strings 16, CommandCenter 16.

### 7. Chrome
**BottomNav.tsx** — EXISTS
- Fixed at `z-[120]`: two `material material-thin` pill groups (profile/cart, chats/community) around the bloub home character (L145-190).
- Active tab: gold top bar. Three quick taps on bloub open /support.
- Hidden on routes listed in `isBottomNavHidden` (L7-26) and through `bottomNavSuppress.ts` (a refcount).
- Hidden while an overlay is open (css L1008). No hide-on-scroll.

**Header.tsx** — EXISTS
- Fixed at `z-[100]`. Past 30 px of scroll in `#main-scroll-container` (L41-56) it swaps from the scrim gradient to `lv-topbar-solid material material-thin` (L98-102) with `transition-all duration-500`, not a spring.
- Measures itself into `--app-header-height` with a ResizeObserver (L61-74). The search field goes compact on scroll (L206).

**Merchant shell** — EXISTS
- Sets `--shell-bottom-inset` (`MerchantShell.tsx:181-185`), `data-scroll-owner` (L264), its own Toaster (L318).
- `MoreSheet` is lazy (L61).
- Every screen sits under `<ChunkBoundary><Suspense SectionFallback>`.

### 8. Tests that pin UI conventions
**uiPrimitives.test.ts**
- L77-135: Overlay hooks, the stack, the rule that it never imports lazy primitives.
- L139-156: Sheet v2.
- L160-219: dialogs, toasts, form kit, Button.
- L233-304: DataList, Menu, Tabs, CommandPalette, KpiTile/Money.
- L308-323: tokens, and compact density only under pointer: fine.
- L327-337: no physical left/right utilities, no `dark:`, no native dialogs, no `fixed bottom-0`, no hex — but only in the listed primitive and lib files.
- L339-350: every interactive element has a focus style.
- House rule: when code moves, move the pin.

**uiSystem.test.ts**
- `lv-choice` inset gold bar (L16-27); portals and one stack (L54-66); the nav hides under an overlay (L68-76).
- Checkout and chat use in-flow bars — no `fixed bottom-0` (L78-114).

**themeSystem.test.ts**
- No colour that belongs to one theme — a hex in a colour utility or a `dark:` variant — anywhere in `src` except the storefront and farm room (L69-85).
- The generated block is current (L87-104); light text contrast ≥ 4.5 (L106-124); storefront stays dark (L224-229).

**lightThemeFeatureSurfaces.test.ts**
- Cream grounds (L43-54), `data-feature` surfaces (L70-94), clean bars (L123-138), home widths (L140-155).

**bundleBudget.test.ts**
- Entry 120 (L52), chunk 250 (L54), initial 240 (L61), CSS 60 (L63), storefront 47 (L303), shell 25 / closure 32 (L359-360).
- A new workspace screen must be lazy and added to `WORKSPACE_SCREENS` (L362-368).
- Analytics 16 KB, order screen 12 KB (L409-410); compare tray 8 KB.
- It rebuilds `dist/` when it is stale.

**communitySocialUi.test.ts** (L119-135) is the pattern to copy for new feature folders: tokens only, `useMotion()` required, no `transition={{duration…}}`.

### Reuse list
- Motion: `useMotion`/`SPRING`/`CROSS_FADE`, `useRail`.
- Windows and menus: `Overlay` (modal/parallel/dock), `Sheet` v2 with detents, `Anchored`, `Menu`.
- Navigation and choice: `TabStrip`/`TabPanels` (link mode for sub-routes), `Segmented`.
- Forms and actions: `Field`/`Input`/`NumberInput`, `Switch`, `Button`/`IconButton`, `useConfirm`/`usePrompt`, `toast`.
- Data display: `DataList`, `KpiTile`/`Sparkline`, `Card`, `SafeImage`, `Money`.
- States: skeletons, `AsyncStates`.
- Busy and layout: `useBusy`, `ChunkBoundary`, `nav-clearance`/`--nav-stack`, `--shell-bottom-inset`.
- Store theming: `StoreTheme`/`useStoreTheme`, `.sf-*` classes.
- Full class inventory in `COMMUNITY_HOME_PLAN.md` §8.

### Rules a designer must obey here
- [ ] Colour comes only from tokens: `bg-canvas/surface/surface-raised/surface-selected`, `text-text-*`, `text-gold`/`accent`, `border-border-subtle`. `snow`/`onyx` only on photographs and fills.
- [ ] No hex, and no `dark:`.
- [ ] Logical utilities only (`ps/pe/ms/me/start/end`, `border-s`). Every slide goes through `useMotion().inline()` or `dir`.
- [ ] Every animation uses `useMotion().spring(name)`: `ui` by default, `move` for repositioning, `sheet` for drawers, `quick` for chips. Bounce only after a throw.
- [ ] Transforms go through `travel()`. No invented durations, no parallax, no Ken Burns, no autoplay, no `AnimatedItem`.
- [ ] CSS transitions only for colour/opacity. Press feedback is the base dim; add `press-scale` on small controls only.
- [ ] 44 px hit targets (`lv-hit`, `IconButton`); visible focus rings (`focus-visible:ring-focus`, `lv-button`, `lv-input`).
- [ ] Windows go through `Overlay`/`Sheet` v2. No native dialogs, no `fixed bottom-0`. Bars stay in flow, above `--nav-stack`/`--shell-bottom-inset`.
- [ ] `material*` only on floating chrome, never stacked; `scroll-edge` instead of a divider line.
- [ ] Every string is ar/en/ckb. Real Sorani goes in a feature `strings.ts` outside `ui/` and `merchant/shell/`; the shell and primitives may only copy existing Sorani verbatim. Never letter-spacing or uppercase on Arabic; line-height ≥ 1.15.
- [ ] Numbers and prices are LTR islands (`Money`, `NumberInput`, `tabular-nums`).
- [ ] CSS budget: 61 B left. Reuse existing classes, use inline `style` for one-offs, or pay back bytes by deleting rules.
- [ ] Storefront closure: ~0.8 KB left, so new store blocks go into lazy `extra`/`tabViews`. New workspace screens are `React.lazy` and listed in `WORKSPACE_SCREENS`.
- [ ] Store design stays closed enums (no free CSS, colour picker or HTML). Store pages stay dark (`[data-store-theme]`); any new token needs an enum in `tokens.ts`, a `data-sf-*` attribute and CSS in `theme.css`.
- [ ] Both themes must read at 4.5:1 (light is cream; `data-feature` for feature tiles), and everything must hold at 360–1920 px in ar, en and ckb.
- [ ] Reduced motion becomes a cross-fade, not nothing. Reduced transparency makes glass solid.
- [ ] When code moves, move its test pin; never delete it.

Key files: /home/user/Levonis/src/lib/motion.ts, /home/user/Levonis/src/lib/useRail.ts, /home/user/Levonis/docs/MOTION.md, /home/user/Levonis/src/index.css, /home/user/Levonis/src/components/ui/Overlay.tsx, /home/user/Levonis/src/components/ui/Sheet.tsx, /home/user/Levonis/src/components/ui/Menu.tsx, /home/user/Levonis/src/components/ui/Tabs.tsx, /home/user/Levonis/src/components/ui/Segmented.tsx, /home/user/Levonis/src/components/ui/Button.tsx, /home/user/Levonis/src/components/ui/Field.tsx, /home/user/Levonis/src/components/ui/DataList.tsx, /home/user/Levonis/src/components/ui/KpiTile.tsx, /home/user/Levonis/src/components/ui/statCards.tsx, /home/user/Levonis/src/components/AnimatedItem.tsx, /home/user/Levonis/src/components/NavigationRouter.tsx, /home/user/Levonis/src/components/ChunkBoundary.tsx, /home/user/Levonis/src/lib/busy.ts, /home/user/Levonis/src/components/BottomNav.tsx, /home/user/Levonis/src/components/Header.tsx, /home/user/Levonis/src/components/merchant/shell/strings.ts, /home/user/Levonis/src/components/merchant/shell/MerchantShell.tsx, /home/user/Levonis/src/LanguageContext.tsx, /home/user/Levonis/packages/storeLayout/src/tokens.ts, /home/user/Levonis/src/components/storefront/theme.ts, /home/user/Levonis/src/components/storefront/theme.css, /home/user/Levonis/src/components/storefront/StoreTheme.tsx, /home/user/Levonis/tests/uiPrimitives.test.ts, /home/user/Levonis/tests/uiSystem.test.ts, /home/user/Levonis/tests/themeSystem.test.ts, /home/user/Levonis/tests/lightThemeFeatureSurfaces.test.ts, /home/user/Levonis/tests/bundleBudget.test.ts, /home/user/Levonis/tests/merchantWorkspaceShell.test.ts, /home/user/Levonis/tests/communitySocialUi.test.ts, /home/user/Levonis/docs/COMMUNITY_HOME_PLAN.md, /home/user/Levonis/docs/MERCHANT_PLATFORM.md, /home/user/Levonis/docs/DECISIONS.md

## Survey — perf-measure

# Performance baseline — Levonis SPA as an Iraqi phone loads it

## Method and caveats (read first)
- `dist/` was fresh (no `src/` file newer than `dist/index.html`, 05:35 today) but built by a bare `vite build`: **`dist/_headers` is absent**, so the immutable asset caching + CSP that `npm run build` writes (scripts/write-asset-headers.mjs → worker/lib/securityPolicy.ts:301-362) were not part of this lab. A separate sourcemapped build into the scratchpad succeeded in 22 s despite the other workflow's edits.
- Served with `vite preview` (HTTP/1.1, gzip on the fly, no brotli). "wire KB" below = gzip as served; "gz-9" = `gzip -9` of the dist file. Production (Cloudflare, H2/H3, brotli) will be ~10 % smaller and far less request-count-sensitive.
- Playwright Chromium 141, 360×800 mobile, CPU ×4, Slow-4G (150 ms RTT, 1.6 Mbps). `/api/*` answered 500 text/plain, so every route rendered its no-API state (below). Scripts and raw data: `scratchpad/perf/measure.cjs`, `variants.cjs`, `results.json`, `variants.json`, `attrib.cjs`; screenshots `perf/home-lcp.png`, `perf/community-lcp.png` (+ `*-settled.png`).
- The sandbox reaches `fonts.googleapis.com` only through a CONNECT relay, which added 3.8-5.2 s to that one request and on `/community` hung 10.4 s (ERR_TOO_MANY_RETRIES). Absolute numbers for that request are not Iraq's, but the **coupling it exposes is real and is the #1 finding**; the variant runs isolate it.

## 1. Baseline per route (first visit, cold)
| route | TTFB | FCP | LCP (element) | DCL | load | CLS | long tasks n / total / TBT-after-FCP | req@load (js/css/font/img) | KB@load wire/gz-9 | req@settle | KB@settle wire | no-API state |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/` | 5 | 4756 | 4964 (H1 hero text) | 4233 | 4239 | **0.081** | 4 / 442 / 2 | 7 (4/2/0/0) | 271/268 | 74 | 349 | hero + «خطأ في الخادم» card |
| `/community` | 5 | 10960 | 11164 (P error text) | 10526 | 10533 | 0 | 5 / 362 / 0 | 7 (4/2/0/0) | 270/267 | 67 | 283 | gate error card only |
| `/products` | 4 | 5540 | 6092 (P error) | 5062 | 5082 | 0.001 | 4 / 376 / 16 | 7 | 271/268 | 70 | 349 | title + error card |
| `/product/x` | 5 | 5068 | 5228 (P error) | 4297 | 4302 | **0.075** | 3 / 232 / 0 | 7 | 271/268 | 70 | 285 | error card |
| `/requests` | 5 | 6204 | 6408 (P error) | 5668 | 5677 | 0.001 | 5 / 549 / 11 | 7 | 271/268 | 69 | 349 | error card |
| `/auth` | 6 | 5332 | 5332 («جارٍ التحميل…») | 4641 | 4648 | 0 | 4 / 306 / 0 | 7 | 271/268 | 82 | 284 | **spinner forever** (no error state when `/api/settings/public` fails) |

The same 7 requests precede every first paint: document 7.6 KB, `index-*.js` 82.2, `vendor-react` 73.2, `vendor-motion` 46.1, `vendor-i18n` 12.0, `index-*.css` 48.9, Google Fonts CSS 1.4 — all done by ~1.7 s. Everything after that waited for the third-party stylesheet: the first long task (entry execution) starts 40 ms after it resolves on every route (home 4062→4101, products 4948→4952, requests 5449→5472, auth 4497→4519). FCP follows ~0.7-0.9 s later = JS execution at ×4 CPU. Long-task totals 232-549 ms are pre-FCP, so classic TBT is ≤16 ms.

Fonts: the three Cairo woff2 (arabic 30,712 B, latin 33,644, latin-ext 16,632) are all `font-display: swap`, so text is never invisible; the woff2 is requested only after React renders text (home 4282 ms) and finished at **9445 ms** because ~57 idle-prefetch chunks started at 4346 ms and shared the pipe.

## 2. Variants — what the app costs without the Google dependency (`/` and `/community`)
| mode | DCL | FCP | LCP | first long task |
|---|---|---|---|---|
| Google CSS fulfilled locally (≈ inlined `@font-face`), woff2 still remote | 1857 / 1847 | 2368 / 2316 | **2628 / 2512** | 1750 |
| fully self-hosted CSS + woff2 | 1918 / 1878 | 2468 / 2268 | 2684 / 2544 | 1750 |
| Google blocked (connection refused) | 1828 / 1833 | 2276 / 2252 | 2516 / 2540 | 1737 |

So the app's own critical path on Slow-4G/×4 is ≈2.5-2.7 s LCP; the baseline's 5.0 s (home) and 11.2 s (community) are the third-party render-blocking stylesheet. Repeat view of `/` with the SW active: document + CSS + JS all served by the SW (index.css at 87 ms, 64/74 requests from SW, 2.7 KB wire) yet **DCL 3781 / FCP 4092** because the Google CSS again went to the network (SW is network-only for third parties; public/sw.js:361-399).

## 3. Heaviest assets (wire KB, union of routes; gz-9 in brackets)
1. `/assets/index-DhtYesPA.js` 82.2 (81.6) — entry
2. `vendor-react-*.js` 73.2 (72.7)
3. `index-*.css` 48.9 (47.5) — one sheet for all routes, 343 KB raw
4. `vendor-motion-*.js` 46.1 (45.6) — motion-dom 94 KB raw + framer-motion 42 KB raw; **no gsap** (gsap rides only with lazy `ScrollReveal`)
5. Cairo latin woff2 33.6 · 6. Cairo arabic woff2 30.7
7. `AppIntro-*.js` 12.2 (11.8) — fetched at load+13 ms on every route
8. `vendor-i18n-*.js` 12.0 (11.6)
9. document 7.6 (18,008 B raw, **14 KB of it HTML comments**; stripped = 3,916 B / 1.6 KB gz)
10. Google Fonts CSS 1.4. Not on these routes but in dist: `vendor-charts` 119.5 gz, `vendor-qr` 46.3, `ProductForm` 44.5, `Auth` 43.3 + 8.0 css, `AdminCommunity` 41.8, `Product` 41.7.

dist has **384 JS chunks, 166 under 1 KB gz** (mostly single lucide icons: `pencil`, `gift`, `camera`, `plus`, `minus`…). The home idle prefetch alone pulls 57 chunks / 119.5 KB gz, 44 of them <1 KB.

## 4. Render-blocking resources (PerformanceResourceTiming.renderBlockingStatus)
- `https://fonts.googleapis.com/css2?family=Cairo…&display=swap` — index.html:281-284 → blocks paint, deferred/module script execution and DCL. NEEDS REFACTOR.
- `/assets/index-*.css` — 48.9 KB, same-origin, done at ~1.43 s. EXISTS, within budget (60 KB total / 47 KB storefront).
- Inline theme script (index.html:264, hash-allowed by securityPolicy.ts:94-98) — negligible. EXISTS.

## 5. Head audit (index.html ⇄ dist/index.html:298-302)
EXISTS: `lang="ar" dir="rtl"`, theme boot script + CSP hash, inline ground colour, `preconnect` ×2, `modulepreload` for `vendor-react`/`vendor-motion`/`vendor-i18n` (Vite, static imports only), manifest, per-host icons, SW registered after `load` only in PROD and not on `www.` (src/main.tsx:88-114; `apex` is the www→apex redirect, so the SW does register on the apex host).
MISSING: `<link rel="preload" as="font">` for the Arabic subset; a `modulepreload` for the route's own chunk (Storefront/Community/Products/Product/Requests/Auth are all discovered only after the entry executes: entry → route chunk → its deps, one extra RTT + download per non-home route); any `preload` for the hero banner (Hero.tsx:175 uses `SafeImage eager` → `loading=eager fetchPriority=high`, SafeImage.tsx:105-107, but the URL comes from `/api/home`, so in production the LCP image is discovered at ≈ JS-done + API RTT).
PARTIAL: self-hosted fonts — only the 4.8 KB Kurdish patch face (src/index.css:43-48, dist/fonts/cairo-kurdish-patch.woff2); public/sw.js `handleStatic` persists only `image/*` (`isImage`, sw.js:536-575) so `/fonts/*` never enters the SW cache.

## 6. What is in the entry (sourcemap attribution, 248 KB raw / 83.6 KB gz; budget 120 KB, tests/bundleBudget.test.ts:52)
src/lib 45.4 KB raw · components/ui 31.7 (Overlay 10.4, AsyncStates 6.1, Skeleton 5.6) · lucide-react 19.6 (**50 icon modules**) · components/home 17.7 (Hero 6.4) · App.tsx 17.5 · search/LiveSearch 10.4 · notifications/NotificationBell 7.8 · profile 7.6 (ThemeIntroSheet 4.6) · auth/EmailVerifyBanner 7.4 · onboarding/strings 6.7 · subscription/tierMeta 5.1 · LangThemeSheet 3.5 · CardPrice 3.4 · pages/community/access 3.4 · BrowseMissionTimer 2.3 · pages/farm 2.3.
`vendor-motion` is a static dependency of the entry because src/lib/motion.ts:45 imports `useReducedMotion` from `motion/react`, and ui/Overlay, ui/Toast, ui/Sheet, search/LiveSearch, lib/useRail import `motion` eagerly; the biggest single file is `motion-dom/projection/node/create-projection-node.mjs` 22.9 KB raw (layout animations) + drag 7.2 + pan 3.8.

## 7. Server/cache facts relevant to Iraq
- wrangler.jsonc: no `placement` key (MISSING; no decision in docs/DECISIONS.md — its Baghdad rows 94/537/586 are day boundaries). Static assets and `assetWithPreview` run at the nearest edge; D1 is single-region, so every API call = edge→D1 RTT.
- `run_worker_first` (wrangler.jsonc:77-104): `/api/*`, `/files/*`, `/product/*`, `/bundles/*`, `/p/*`, `/community/store/*`, manifest, robots, sitemap, `/store-icon/*`. `assetWithPreview` (worker/index.ts:586-646) reads the HTML and does up to two D1 lookups per `/product/*` / store-home document → TTFB cost on exactly the shareable pages.
- Boot fan-out after JS executes: `/api/storefront/resolve`, `/api/auth/me`, `/api/home`, `/api/home/sections`, `/api/community/access` **×2** (BottomNav.tsx:11, ServicesGrid.tsx:10, PrinterFinder.tsx:4 through access.tsx:68-83), `/api/settings/public` = 7 serial-ish RTTs on home; none sets Cache-Control (grep across worker/routes: only devices.ts:1101, kyc.ts:820). `worker/lib/publicApi/cache.ts` already has `edgeCache()`, `weakEtag()`, `conditional()` — PARTIAL (public API only).
- Headers at build: `ASSET_CACHE_CONTROL` immutable 1y, document `no-cache`, sw `no-cache`, icons 7d (securityPolicy.ts:191-299). EXISTS, but absent from this dist (see caveat).
- SW (public/sw.js v3): navigation network-first with cached `/` as offline fallback (520-535), `/assets/*` cache-first (570-586), images SWR, `/api|/files` untouched. EXISTS.

## 8. Ranked fixes (expected impact measured or derived above)
1. **Self-host Cairo, inline `@font-face`, preload the Arabic subset** — index.html:266-284 (drop the Google `<link rel=stylesheet>` + both preconnects), src/index.css:43-48 (extend the patch-face pattern; put woff2 under public/fonts/), public/sw.js:536-575 (persist `font/*` or route `/fonts/` to CACHE_FIRST like line 399), worker/lib/securityPolicy.ts:135-139 & 370-371 + tests/securityPolicy.test.ts:108 (remove the two Google font origins). Measured: home LCP 4.96→2.63 s, community 11.2→2.5 s, repeat-view FCP 4.09→≈0.3 s; removes the single point of failure Iraq's Google reachability represents. LCP/FCP.
2. **Re-time and shrink `useIdlePrefetch`** — src/App.tsx:179-204 fires at load+110 ms with `timeout: 3000` and pulls 57 chunks/119.5 KB (Product 41 KB, refusalStrings 17.5 KB) while the woff2 and LCP are in flight (font took 5.2 s for 33.6 KB). Gate on `homeCriticalReadyStore` + `document.fonts.ready`, no rIC timeout, prefetch only `Products`; leave `Product/Cart/Addresses` to first interaction. LCP stability, font swap ~5 s earlier, fewer competing requests. LCP/CLS.
3. **Group lucide icons; lazy-load non-first-screen entry modules** — vite.config.ts:57-70 add a `vendor-icons` rule for `lucide-react` (kills ~160 sub-1 KB chunks; one cached ~8 KB gz file); lazy `LiveSearch` on search focus, `NotificationBell`/`EmailVerifyBanner` after auth resolves, `ThemeIntroSheet`/`LangThemeSheet` on open, `onboarding/strings`, `subscription/tierMeta`, `pages/farm` out of the entry (≈50 KB raw / ~15 KB gz). Budget test keeps it honest. TBT −15-20 %, FCP −0.2 s. INP/FCP.
4. **Take `motion` off the first paint** — src/lib/motion.ts:45 replace `useReducedMotion` with a `matchMedia('(prefers-reduced-motion)')` hook (same API for `useMotion()`); ui/Overlay, Sheet, Toast, LiveSearch use `LazyMotion` + `domAnimation` with `m.*` (drops projection/drag/pan ≈ 55 % of motion-dom) or lazy-import the animated shell. −25-47 KB gz before paint ≈ −0.25-0.5 s at 1.6 Mbps plus parse at ×4. FCP/LCP/INP.
5. **Fix the two measured CLS sources** — src/pages/Home.tsx:244-262: the `-mt-7 rounded-t-[28px]` sheet shifts 0.078 at 4925 ms when `AppIntro` (App.tsx:450-467, fetched at load+13 ms) and the marquee row (`homeAds` → `py-2.5` row vs `h-4` placeholder) settle; reserve the row height and give `Hero` a min-height while `loading`. src/pages/Product.tsx (chunk `Product-*.js`): 0.075 from `MAIN.flex-1` swapping loading→error/content; skeleton at the exact height (pattern already used at Home.tsx:204-214). CLS 0.08→<0.01.
6. **Strip HTML comments at build + preload the route chunk and hero image from the Worker** — vite.config.ts `transformIndexHtml` (−5.9 KB gz on a `no-cache` document every visit); emit `build.manifest` and have `assetWithPreview` (worker/index.ts:586-646) / worker/lib/socialPreview.ts inject `<link rel=modulepreload>` for the route's chunk and `<link rel=preload as=image>` for the first hero banner (it already resolves the store/product for the OG tags). Saves one RTT+download (≈0.45 s on Slow-4G) on every non-home route and makes the production LCP image discoverable before JS. LCP/TTFB-to-paint.
7. **Edge-cache the public boot GETs and dedupe** — reuse worker/lib/publicApi/cache.ts (`edgeCache`, `weakEtag`, `conditional`) on `/api/home`, `/api/home/sections`, `/api/settings/public`, `/api/community/access`, `/api/storefront/resolve` (key by Host) with `public, max-age=60, s-maxage=120, stale-while-revalidate=600`, purge on the admin writes that exist (`resetCommunityAccessCache` shows the seam); fix the double `/api/community/access` (access.tsx:68-83 key churn). One edge→D1 RTT saved per call (typically 150-400 ms from Iraq); consider a single server-authoritative `/api/boot`. Data-ready/INP.
8. **Iraq routing decision** — record a DECISIONS.md row: measure `cf-placement` with `placement: { mode: "smart" }` in wrangler.jsonc staging (helps multi-query API handlers near D1; may move `assetWithPreview` HTML rewriting away from Iraqi PoPs — keep it if `/product/*` TTFB regresses). Also make CI assert `dist/_headers` exists (tests/bundleBudget.test.ts:156-168 area) so immutable caching/CSP can't silently vanish as in this dist. TTFB.
9. **/auth without settings** — src/pages/Auth.tsx / components/auth/AuthShell.tsx: replace the infinite «جارٍ التحميل…» with the `AsyncStates` error card + retry used elsewhere. UX/INP.
10. **Merchant "measure my store speed" (brief item) — MISSING**: add a ~1.5 KB `web-vitals` reporter posting LCP/CLS/INP per store host to the existing storefront analytics beacon (docs/COMMUNITY_ECOSYSTEM.md:111), shown in the merchant dashboard; CSP already allows `cloudflareinsights` only, so the beacon is first-party.

## 9. Status summary
EXISTS: route lazy-loading + manualChunks; budget test (entry 83.6/120, initial ≈214/240, CSS 48.9/60); theme boot + CSP; SW v3; immutable asset headers at build; error states on 5/6 routes; `SafeImage eager` for LCP images.
PARTIAL: self-hosted fonts (patch face only); SW font persistence; edge caching lib (public API only); CLS reservations (some sections only).
MISSING: font preload; route/hero preload hints; `placement` decision; `dist/_headers` in this dist; /auth error state; merchant speed metrics; comment stripping.
NEEDS REFACTOR: Google Fonts render-blocking link; `useIdlePrefetch` timing/closure; `motion` in the entry closure; icon micro-chunking.

## Reuse list
src/lib/motion.ts `useMotion()`; src/components/ui/SafeImage.tsx (`eager`); src/components/ui/AsyncStates.tsx; src/lib/appBootstrap.ts `homeCriticalReadyStore`; worker/lib/publicApi/cache.ts; worker/lib/securityPolicy.ts `assetHeadersFile()`; public/sw.js STATIC/ASSET handlers; scripts/write-asset-headers.mjs; tests/bundleBudget.test.ts; the lab scripts in `scratchpad/perf/` (rerunnable against any build).

Key files: /home/user/Levonis/index.html, /home/user/Levonis/dist/index.html, /home/user/Levonis/vite.config.ts, /home/user/Levonis/src/App.tsx, /home/user/Levonis/src/main.tsx, /home/user/Levonis/src/index.css, /home/user/Levonis/src/lib/motion.ts, /home/user/Levonis/src/pages/Home.tsx, /home/user/Levonis/src/components/home/Hero.tsx, /home/user/Levonis/src/components/ui/SafeImage.tsx, /home/user/Levonis/src/pages/community/access.tsx, /home/user/Levonis/public/sw.js, /home/user/Levonis/worker/index.ts, /home/user/Levonis/worker/lib/securityPolicy.ts, /home/user/Levonis/worker/lib/publicApi/cache.ts, /home/user/Levonis/wrangler.jsonc, /home/user/Levonis/scripts/write-asset-headers.mjs, /home/user/Levonis/tests/bundleBudget.test.ts, /home/user/Levonis/tests/securityPolicy.test.ts, /home/user/Levonis/docs/MERCHANT_PLATFORM.md, /home/user/Levonis/docs/COMMUNITY_ECOSYSTEM.md, /tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/perf/results.json, /tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/perf/variants.json, /tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/perf/measure.cjs, /tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/perf/variants.cjs, /tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/attrib.cjs, /tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/perf/home-lcp.png, /tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/perf/community-lcp.png

