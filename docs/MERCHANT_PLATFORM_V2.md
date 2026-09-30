# Merchant platform v2 — the owner's brief of 2026-09-29, surveyed, measured, designed, planned

> Produced by a 27-agent workflow (7 surveys + a measured performance baseline → 9 design proposals from three angles per track → 6 judges → 3 syntheses → a completeness critic). Facts cite HEAD 1444169f. The programme in §1 is the plan of record; §2–§4 are the judged track plans; the raw surveys are in docs/MERCHANT_PLATFORM_V2_SURVEY.md.

## 1. Programme (completeness critic)

# The Merchant Programme — completeness critique and unified build order

Read against HEAD `1444169f` («Community social layer and the home العدد», 2026-09-29) in `/home/user/Levonis`, clean tree. Everything below reuses the surveys' facts; the numbers that were re-measured or corrected in this pass are marked **(measured)** / **(corrected)**.

## 0. Ground truth the three plans disagreed on (settled here)

| Topic | What the plans said | Fact at HEAD | Consequence for the programme |
|---|---|---|---|
| CSS budget | 61,429 B (workspace), 61,361 B (storefront), 62,431 B (journeys) | **61,361 B gzip-9 per file summed over `dist/assets/*.css`, budget 61,440 B → 79 B headroom (measured)**; `src/index.css:63` is a bare `@import "tailwindcss";` | The `source()` restriction is PR #1 of the whole programme; its measured saving is the spend ceiling for every later phase. No plan may claim a payback it did not measure. |
| Migration numbers | 0156–0158 (workspace), 0156–0157 (storefront), 0159 (journeys) | `migrations/0155_community_comment_replay.sql` is **committed**; next free is **0156**. `docs/COMMUNITY_ECOSYSTEM.md` §9 still reserves 0156/0157/0158 in prose for its Phases 5/6/4 (unbuilt) | Plans name migrations by **role**; the number is taken at merge (`ls migrations | tail -1` + 1). Provisional map in §C.3. The ECOSYSTEM prose numbers must be renumbered (owner Q13). |
| DECISIONS rows | «rows 167–170» (storefront), «a row» (others) | `docs/DECISIONS.md` has **167 rows**; row 167 is community Phase 2 | New rows start at **168** (map in §C.3). |
| Community Phase 2 | «being built now» | Committed at HEAD (ECOSYSTEM §6 says Phase 2 landed; row 167). The harness still lists `src/App.tsx`, `src/components/community/**`, `src/pages/Community.tsx`, `src/pages/community/**`, `worker/routes/community*.ts`, `worker/lib/notifications.ts` as churn | «Waits for community» now means «touches one of those six paths» (§C.4), not «waits for Phase 2 semantics». `worker/index.ts` and `worker/routes/chats.ts` are **not** in the current churn list. |
| Vitals («measure my speed») | Two full systems: workspace (`merchant_store_vitals_*`, `GET /api/merchant/analytics/speed`, `analytics?view=speed`) and storefront (`storefront_vitals_*`, `POST /api/storefront/vitals`, `GET /api/merchant/store/speed`, builder tab) | Neither exists; `storefront_event_marks.event` is CHECK-constrained (0125:91) so both need their own marks table | **One** system (§C, Phase 4): the storefront plan's ingest/tables/report, the builder «السرعة» tab as the primary surface (it has the weight audit with «open the block»), the workspace Pulse line + attention source as doors to it. No `readWorkspaceQuery` change. |
| Reels/clips | Storefront: `merchant_showcase` video columns + `reels` block + `ReelsViewer`; journeys: `/clips` from `community_product_media` + `ClipRail/ClipViewer` + `store_posts` block | No reel code anywhere; product videos already exist in `community_product_media` (0126:178-190) | **One** viewer (`src/components/storefront/reels/ReelsViewer.tsx`), **one** route `GET /api/storefront/:slug/reels?source=` with three sources in order of cost: `products` (no migration, Phase 6), `showcase` (migration, Phase 8), `posts` (owner decision, Phase 11). One `reels` block with a `source` set. `ClipRail`/`store_posts` are dropped as separate components. |
| Announcement bar | Workspace: layout key `announcement`; storefront: `header.notice` + `notice_link` | Neither exists; `normalize.ts:491` allow-list | **One** key: `header.notice` / `header.notice_link` / optional `from`,`until`. The Counter's `AnnouncementSheet` edits it through `PUT /draft` + `POST /publish`. |
| Cart count on the host | Journeys: «no shared cart context, read `/api/cart/merchant-items` on mount» | `src/lib/cartCount.ts:105` exports `cartCountStore` (`useSyncExternalStore`) **(corrected)** | HostBar reads `cartCountStore`. |
| In-store search | All three extend `GET /api/storefront/:slug/products` | `worker/routes/storefront.ts:523-590` has no `q`/`sort` | One implementation (journeys F1 wording: `likePattern` + `sqlLikeClause`, keyset on `(sort_value,id)`), one UI (storefront §3.2 field + lazy `Search` tab view). |
| Store-addressed print request | Storefront A3 (PrintRequestSheet + link tab + estimate); journeys R4–R7 (`RequestComposer`, `readJob` spec fields, `Estimate` contract) | Direct requests are created only by `POST /api/chats/:id/print-requests` (`chatCommerce.ts:152`) behind `requireCommunityOpen` | Journeys owns the contract and the composer; storefront owns the doors (`custom_request_cta`, `LiveServiceDoors`, product page, HostBar quote). |
| Order tracking | Storefront A6/A7; journeys K1–K5 | `GET /api/orders/:id/tracking` (`orders.ts:5117-5150`) has no store, no events | Journeys K1–K5 (superset) is the one implementation. |
| Sorani policy | Each plan asks for its own DECISIONS row | `MERCHANT_PLATFORM.md:276-281` «never machine-written» (cites row 11 = referrals, drift); ECOSYSTEM D6 reverses it for community; `tests/merchantWorkspaceShell.test.ts:315-331` and `uiPrimitives.test.ts:352-398` police `shell/` and `ui/` | **One** row (168) extending D6 to `src/components/{storefront,estimate,journey,merchant/counter,merchant/storeDesign}/**` with the `communitySocialUi.test.ts:75-100` guard copied per folder; shell/ui copy verbatim. Fix the three «row 11» citations (`shell/strings.ts:4`, `MERCHANT_PLATFORM.md:279`, `hub/copy.ts:10`). |
| Autoplay | «ECOSYSTEM:680» / «:724» / «:745» | The rule «video tap-to-play, never autoplay» is in §9.8 (`COMMUNITY_ECOSYSTEM.md:729-745`) and `COMMUNITY_HOME_PLAN.md:161` | Muted autoplay **only** of the active slot inside an opened viewer needs row 169; the shelf, cards and feeds never autoplay. |
| Placement | «add `placement` to wrangler.jsonc» | No `placement` key anywhere; `scripts/prepare-deploy-config.mjs:185-201` folds a fixed key list into the top level and `placement` is **not** on it **(measured)** | Put `placement` at the **top level** (inheritable) or add it to that list, else the staging deploy silently drops it. |
| Live target | — | `levonis-iq.com` and `*.levonis-iq.com` → Worker **`levonis-staging`**, D1 `levonis-db-staging` created by `npx wrangler d1 create levonis-db-staging` with no `--location` (`.github/workflows/deploy-staging.yml:61`) | The D1 primary region is unknown; log `meta.served_by_region` before deciding anything. |

---

## A. Gap table — the owner's brief, sentence by sentence

Status is for HEAD. «Plan» names the synthesised track plan and the programme phase (§C) that covers it. **Bold** = no plan covered it before this document.

| # | Brief (translated) | Status at HEAD | Evidence | Covered by | Programme phase |
|---|---|---|---|---|---|
| 1 | Develop the merchant's store management completely, modern visual UI/UX | PARTIAL | 20 sections exist (`packages/contracts/src/merchantRoutes.ts:49-72`); shell has no motion (`shell/MerchantShell.tsx:33-57`); legacy kit `dashboard/ui.tsx` + 400+ raw palette classes across `StoreSettingsTab`, `SalesTabs`, `PrintersTab`, `CostingTab`, `pages/MerchantStore.tsx` | Workspace (Counter) §3.1–3.8, §6 P2/P3 | P3, P7, P10 |
| 2 | Many wide features so the merchant feels like the real owner of their own site | PARTIAL | Missing: staff roles (`merchantAuth.ts:122-131`), SEO fields, announcement bar, order search/bulk/tracking/note/CSV, customer notes/segments, saved replies, vacation mode, merchant invoice (`invoices.ts:63-73`), returns view | Workspace §4.1–4.10 | P3, P7, P8, P10 |
| 2a | — custom domain, payment methods, broadcasts, WhatsApp ordering | MISSING **by decision** | DECISIONS row 12 (🔴 custom domain); `storeOrders.ts:30-33` wallet only; standing rule: no new wallet/chat/notification system | Workspace §4.5/4.6/4.9 says «not built»; **owner must re-confirm** | Q12 |
| 3 | Expand the store designer so the merchant has many options and can put whatever they want | EXISTS / PARTIAL | 27 blocks, 7 templates, 11 closed tokens, preview 360/768/1280, undo 60, revisions 50 (`packages/storeLayout/src/*`, `storeDesign/*`); missing: backgrounds, footer links, notice, schedule, collection covers, lightbox, per-block reveal | Storefront §4.1 L1–L16 | P5 |
| 4 | GIFs, images, videos — in the profile, the background, anywhere | PARTIAL | Animated GIF passes through into every image slot raw up to 8 MB (`uploads.ts:453`, `refs.ts:34-37`); video only as its own block (`blocks.ts:268`); **no background media**, hero is `image` only (`blocks.ts:111`); store logo/banner images only (`merchant.ts:318-325`) | Storefront L3–L5 (hero video + poster, background image/GIF/video, `max_bytes`); GIF weight caps | P5 |
| 4a | — video/animated **profile** (logo/banner on the store row, used by OG cards and app icons) | MISSING | `mediaRefs.ts:40` `OBJECT_RE` images only; icons generated from the logo (`storeIcons.ts`) | **No plan.** Proposal: the store page's «profile» is the hero (`profile` variant), which gains video/GIF in P5; the store-row logo/banner stay still images because OG cards, app icons and chat headers consume them. Owner Q5. | P5 (hero) / Q5 |
| 5 | Measure the merchant's own site load speed | MISSING | No `PerformanceObserver`/web-vitals/PSI code in `src`, `worker`, `scripts`; CSP `connect-src` blocks browser calls to Google (`securityPolicy.ts:139`); bot filter already drops `lighthouse|pagespeed` (`storefrontAnalytics.ts:63`) | Storefront §4.5 S1–S7 (one system, see §0) + workspace Pulse/attention door; perf-measure #10 | **P4** |
| 6 | Modern, simple, soft smooth effects and transitions | PARTIAL | Kit exists (`src/lib/motion.ts:62-143`, `useRail`, MOTION.md); storefront has zero motion beyond `whileTap`; workspace shell has none; no route transitions **by design** (`NavigationRouter.tsx:49-63`) | Workspace §5 (Seam, settle, badge, tray, spine); storefront §5 (HostBar, viewer, CSS scroll-driven reveal token); journeys §5 | P3, P5, P6 |
| 6a | — page/route transitions | MISSING by design | View Transitions used only for language/theme swap (`lib/langSwap.ts:100`, `lib/theme.ts:181-188`) | **No plan.** The workspace «settle» (P3) covers section changes; a site-wide View Transition on `Routes` is an owner question (Q10) because it costs INP on low-end Androids. | Q10 |
| 7 | The merchant profile end to end: product cards | NEEDS REFACTOR | 6+ card variants (storefront-cx §4); hex at `parts.tsx:144`; first image only (`worker/lib/storeLayout.ts:116`); no video indicator | Storefront L10; journeys B4 | P3 |
| 7b | — chat | PARTIAL | Inbox list only; thread leaves the workspace (`routeTable.ts:49`); chips hardcoded (`Chat.tsx:402-410`); `'ku'` bug (`Chat.tsx:70`) | Workspace §3.5/4.3 (thread inside, saved replies, away line) | P3 (ckb fix), P7 |
| 7c | — orders | EXISTS / NEEDS REFACTOR | List has no search/bulk/export (`merchant.ts:1018`); no tracking-number UI, no internal note | Workspace §3.3/3.4/4.2 | P3, P7 |
| 7d | — reviews | PARTIAL | Merchant reply exists (`merchant.ts:1326`); storefront block ignores `images`/`next_cursor` (`blocks/Reviews.tsx`); form has no photo upload | Storefront L12 | P3 |
| 7e | — video reels | MISSING | No reel feed anywhere; posters missing; Range requests never edge-cached (`uploads.ts:837-841`) | Storefront §4.2 W1–W11 + journeys V1 (unified, §0) | P6 (product videos), P8 (showcase clips), P11 (posts) |
| 7f | — catalogue sections / collections | EXISTS / PARTIAL | `merchant_store_sections.image_key` exists (0126:209-210) but the storefront read never selects it (`storeLayout.ts:275`) | Storefront L9 | P3 |
| 7g | — products | EXISTS | `merchantCatalog.ts:218-1110` (import/export/bulk/duplicate/insights) | — (Sorani debt only: `catalog/strings.ts` 159 markers) | P7 |
| 8 | Customer experience: contacting the merchant | PARTIAL | `POST /api/chats/open {merchantId}` (`chats.ts:538-560`); no product context; host pages hard-hop to the apex (`Storefront.tsx:464`) | Storefront A1/A2; journeys C1–C6 | P6 (ask-about-product), P11 (host `/chat/:id`) |
| 8b | — creating a print request | NEEDS REFACTOR | Store door sends to the public board (`Storefront.tsx:60,288`); chat sheet has no link source and no estimate | Journeys R1–R7 + storefront A3 | P6 |
| 8c | — browsing Levo Community on the home | (community workflow) | Phase 2 landed (`COMMUNITY_HOME_PLAN.md`); Phase 3 search planned | Community workflow (ECOSYSTEM §6) | outside this programme |
| 8d | — browsing Levo Community inside a store | MISSING | Store posts readable via `GET /api/community/posts?store=` behind `communityGate()` (`communityPosts.ts:49,234-253`) | Storefront W9 / journeys V3 → unified «posts» source of the reels block + optional `store_posts` block | P11 (after row 170) |
| 8e | — buying | PARTIAL | No cart/orders entry on a store host (`StoreHeader.tsx:18-54`); success links to `/orders` not the order (`StoreCheckout.tsx:439-445`); no post-add cart link | Storefront A4/A5 + HostBar; journeys B1/B2 | P3, P6 |
| 8f | — finding things / search | MISSING in store | No `q` on the storefront products route; main `LiveSearch` covers the platform catalogue only | Storefront L11 / journeys F1–F3 (store); site-wide = community Phase 3 | P6 |
| 8g | — watching clips | MISSING | No viewer; product videos tap-to-play in `ProductGallery.tsx:52-60` | Reels viewer (unified) | P6 |
| 8h | — order tracking | PARTIAL | Static stages, one load (`OrderDetail.tsx:253-280`), no store identity on the order (`api.ts:930`), no «placed» notice for store orders (`storeOrders.ts:1204`), titles ar/en only (`orderNotify.ts:286-353`) | Journeys K1–K5 | P3 (identity, placed notice), P6 (live Thread) |
| 9 | Print-price calculation from links | PARTIAL → effectively MISSING | Every default provider has `api_url:''` (`externalModels.ts:51-57`); links never become files; no `source_meta` stored | Journeys S3–S4 (og: read, admin download templates, guest twin) | P9 |
| 9b | — from files | EXISTS with bugs | Two engines disagree; support over-count (`printPricing.ts:383`); margin leak on public routes (`printQuote.ts:925,1245,1469`) | Journeys E1–E10 | P3 (contract, leak, bed-contact), P11 (convergence) |
| 9c | — estimate at request creation | PARTIAL | Only at step 4 (`RequestWizard.tsx:365-378`); `confidence_reasons` rendered nowhere; chat sheet and store door have none | Journeys E1–E4, R2–R5 | P3, P6 |
| 10 | Many tests improving the whole site's PageSpeed Insights scores | MISSING | No Lighthouse/PSI/web-vitals script (perf-arch §9); lab scripts exist only in `scratchpad/perf/` | Perf plan §B.4 (lab script into `scripts/`, CI asserts) | P0 and every phase's exit gate |
| 11 | Very fast server, strong cache | PARTIAL | Edge cache only on catalog tree/slug, printer-finder, public API, `/files` non-Range; `/api/home`, `/api/products*`, `/api/storefront/*`, `/api/settings/public`, `/api/community/access` uncached; D1 in 3–5 serial waves | Perf plan §B.1 ranks 2, 4, 8, 9 | P2 |
| 12 | Especially Iraq: route servers to Iraq | MISSING | No `placement`; D1 primary location unknown (created by a US runner); ~450 ms first byte from Iraq recorded (`securityPolicy.ts:270-284`) | Perf plan §B.2 (owner-side switches) + §B.1 rank 4 | P2 + Q11 |
| 13 | Smooth navigation | PARTIAL | No SW navigation preload; product/store documents lose their `ETag` (`worker/index.ts:638`); idle prefetch competes with the LCP (`App.tsx:179-204`) | Perf plan ranks 3, 6, 10 | P1, P2 |
| 14 | «Use fable 5.1 ultracode … build the levo community» | (community workflow) | ECOSYSTEM Phases 1–2 landed | Community workflow | outside |

**Items no track plan covered before this document:** 4a (video profile assets), 6a (route transitions), the reconciliation of two vitals systems and two reels systems (§0), the Cloudflare-side switches (§B.2), the lab script promotion into `scripts/` with CI gates (§B.4), and the `placement` fold-list trap.

---

## B. Performance plan (from the measured baseline)

Baseline (perf-measure, Slow-4G/×4, 360×800): home LCP **4.96 s** (2.63 s once the Google Fonts stylesheet is local), community 11.2 s, CLS 0.08; entry 81.6 KB + react 72.7 + motion 45.6 + i18n 11.6 + CSS 47.5 KB before first paint; 7 boot API calls, none cached; D1 in 3–5 serial waves per hot route; `/files` Range never edge-cached.

### B.1 Ranked fixes (code)

| # | Fix | Files (exact) | Expected impact | Phase |
|---|---|---|---|---|
| 1 | **Self-host Cairo**: drop the Google `<link rel=stylesheet>` and both preconnects; `@font-face` for the three subsets in `src/index.css` (extend the patch-face pattern at `:43-50`), woff2 under `public/fonts/`, `<link rel=preload as=font crossorigin>` for the Arabic subset; SW persists `font/*` (`public/sw.js:536-575`) and bumps `VERSION` (`:85`); remove the two Google origins from `worker/lib/securityPolicy.ts:135-139,370-371` and `tests/securityPolicy.test.ts:108` | `index.html` (preconnects ~L266-267, stylesheet ~L280-283), `src/index.css`, `public/fonts/*`, `public/sw.js`, `worker/lib/securityPolicy.ts`, `packages/platform-kit/src/edge/securityPolicy.ts` (identical copy), `tests/firstPaintAndFonts.test.ts` | Lab: home LCP 4.96 → 2.63 s, community 11.2 → 2.5 s, repeat-view FCP 4.09 → ≈0.3 s; removes the Google single point of failure for Iraq | P1 |
| 2 | **Edge-cache the anonymous public GETs** with `edgeCache()/weakEtag()/conditional()` from `worker/lib/publicApi/cache.ts:24-60` and the gateway predicates (`services/gateway/src/cache.ts:62,108`): `/api/home`, `/api/home/sections`, `/api/products`, `/api/products/:slug` (anonymous variant), `/api/settings/public`, `/api/community/access`, `/api/storefront/resolve` (key by Host), `/api/storefront/:slug` **after** `delivery_to_you` moves to `GET /:slug/delivery` (`storefront.ts:110-116,389`), `/api/storefront/:slug/products|reviews|reels`, the print catalogue GETs (`printQuote.ts:320,366,390`, `printRequests.ts:207`). Policy `public, max-age=60, s-maxage=120, stale-while-revalidate=600`; re-stamp on hit as `catalog.ts:84-96` does; purge seams on the admin writes (`resetCommunityAccessCache` pattern) — P2 review: the seams are the settings PUT and the site-media routes, the community gate PUT, one middleware on the merchant routers (every merchant write), the store rename and the two admin sanctions, the admin product and benefit-rule routers and the PRO pause (the catalogue seam), the printer-model PATCH; the six per-viewer routes (`/api/home`, `/api/home/sections`, `/api/products`, `/api/products/:slug`, `/api/community/access`, `/api/print-quote/printers`) add `Vary: Cookie` so a browser never carries the guest body across a sign-in. Fix the double `/api/community/access` (`src/pages/community/access.tsx:68-83`, churn) | `worker/routes/{products,storefront,settings,community,printQuote,printRequests}.ts`, new `worker/lib/edgePolicy.ts` (one helper), `tests/edgeCachePolicy.test.ts` (extends `edgeCacheLifetime.test.ts`) | −1 edge→D1 round trip per call (150–400 ms from Iraq each); boot fan-out from 7 D1-bound calls to ≤2 on a warm colo | P2 |
| 3 | **Shorten the client waterfall**: start `resolve` and `/api/home` at module load (`src/StoreContext.tsx:97-131`, `src/pages/Home.tsx:97-122`); have `assetWithPreview` (`worker/index.ts:586-646`, already resolving store/product for OG) inject `<link rel=modulepreload>` for the route chunk (needs `build.manifest` in `vite.config.ts`) and `<link rel=preload as=image fetchpriority=high>` for the first hero/cover, plus an inline `<script type=application/json id=lv-resolve>` so `App.tsx:562` no longer waits on a fetch; keep a **weak ETag computed from the rewritten body** instead of deleting it (`index.ts:638`) | `worker/index.ts`, `worker/lib/socialPreview.ts`, `vite.config.ts`, `src/StoreContext.tsx`, `src/App.tsx:562` (churn — one small PR, rebased last) | −1 RTT + download (≈0.45 s Slow-4G) on every non-home route; LCP image discoverable before JS; 304s return for product/store documents | P2 |
| 4 | **D1 on the hot paths**: `db.batch()` per dependent wave in `GET /api/home` (`products.ts:4188-4408`), `/home/sections` (`:4435-4507`), `/products/:slug` (`:3835+`), `/products` (`:3130/3588`), storefront `resolve`/`:slug` (`storefront.ts:311-377`); memoise `pricingCtxForUser` inputs (settings, `catalogAncestry` `membershipBenefits.ts:297`, benefit rules, pro-pause) in the isolate for 30–60 s; skip `loadSessionUser` (`worker/lib/session.ts:68`, skip list at `worker/index.ts:130-260`) for public GETs whose anonymous variant is cached; log `meta.served_by_region` on one route per deploy | `worker/routes/products.ts`, `worker/routes/storefront.ts`, `worker/lib/membershipBenefits.ts`, `worker/index.ts`, `tests/d1Waves.test.ts` (counts `prepare` calls per route with the gated adapter from `tests/farmHardening.test.ts`) | TTFB −1 D1 RTT per removed wave (≈100–250 ms each from a far primary); tells us where D1 actually lives | P2 |
| 5 | **Responsive images**: a `?w=320|640|1080` variant route through `IMAGES` (`worker/lib/imageConvert.ts:233-262`, cached in `caches.default` like `/files`), `srcset`/`sizes` in `SafeImage` (`src/components/ui/SafeImage.tsx:100-112`), `parts.tsx:124`, `home/ProductCard.tsx:112/187`, `hub/ProductTile.tsx`; AVIF when `Accept` allows; drop the 300 ms opacity fade for `eager` images; GIF/video `max_bytes` caps per layout slot (storefront L5) | `worker/routes/uploads.ts`, `worker/lib/imageConvert.ts`, `src/components/ui/SafeImage.tsx`, the three card files, `packages/storeLayout/src/blocks.ts` | LCP bytes −60–80 % on cards and heroes (3000 px WebP → ≤1080 px); an 8 MB GIF hero becomes impossible | P2 (route), P5 (caps) |
| 6 | **Less JS before paint**: retime `useIdlePrefetch` (`App.tsx:179-204`, churn) to wait for `homeCriticalReadyStore` + `document.fonts.ready` and prefetch only `Products`; `vendor-icons` manualChunk for `lucide-react` (`vite.config.ts:47-61`; kills ~160 sub-1 KB chunks); `LazyMotion` + `domAnimation` + `m.*` in `ui/Overlay`, `ui/Sheet`, `ui/Toast`, `search/LiveSearch`, `lib/useRail`, and a `matchMedia` reduced-motion hook in `src/lib/motion.ts:45`; lazy `LiveSearch` (on focus), `NotificationBell`/`EmailVerifyBanner` (after auth), `ThemeIntroSheet`/`LangThemeSheet` (on open), `onboarding/strings`, `subscription/tierMeta`, `pages/farm` out of the entry | `vite.config.ts`, `src/App.tsx`, `src/lib/motion.ts`, the listed components, `tests/bundleBudget.test.ts` (lower `ENTRY_BUDGET` to 100 KB once measured) | −25–47 KB gz before paint (≈−0.25–0.5 s at 1.6 Mbps + parse at ×4); TBT −15–20 %; font swap ~5 s earlier | P1 |
| 7 | **CLS**: reserve the marquee row and give `Hero` a min-height while loading (`src/pages/Home.tsx:244-262`, `AppIntro` dock `App.tsx:450-467` churn); product page skeleton at the exact height (`src/pages/Product.tsx`, pattern `Home.tsx:204-214`); storefront skeletons instead of the black spinner (`Storefront.tsx:345-351`, `StorefrontProduct.tsx:199-205`) | `src/pages/Home.tsx`, `src/pages/Product.tsx`, `src/pages/Storefront.tsx`, `src/pages/StorefrontProduct.tsx` | CLS 0.08 → <0.01 on home and product | P1 |
| 8 | **Document bytes**: strip HTML comments at build (`vite.config.ts` `transformIndexHtml`: 7.5 → 1.6 KB gz on a `no-cache` document every visit); CI asserts `dist/_headers` exists (`tests/bundleBudget.test.ts:156-168` area; `npm run build` writes it, bare `vite build` does not) | `vite.config.ts`, `tests/bundleBudget.test.ts`, `scripts/write-asset-headers.mjs` | −5.9 KB gz per navigation; immutable caching/CSP can no longer silently vanish | P0 |
| 9 | **Video delivery**: serve Range requests from the edge-cached full object (`worker/routes/uploads.ts:828-841`, `:837-841`, `:864-935`; drop the extra R2 HEAD at `:867`, run the 304 check before the GET at `:885`); add Range to review media (`worker/routes/reviews.ts:947-1060`, iOS Safari cannot play without it); refuse non-faststart MP4 at upload or warn in the picker (`worker/lib/videoSniff.ts:89-90`); mandatory posters for every new video slot | `worker/routes/uploads.ts`, `worker/routes/reviews.ts`, `worker/lib/videoSniff.ts`, `tests/fileRangeDelivery.test.ts` | Every reel/hero-video play served from the Iraqi colo instead of R2's region; the prerequisite for reels (storefront W11) | P2 |
| 10 | **Service worker**: enable navigation preload; persist `/fonts/*`; keep `/api` and `/files` network-only | `public/sw.js:340-408, 536-575` | Repeat navigations no longer wait for SW boot (≈100–300 ms on mid-range Android) | P1 |
| 11 | **`/auth` never spins forever**: `AsyncStates` error card + retry when `/api/settings/public` fails | `src/pages/Auth.tsx`, `src/components/auth/AuthShell.tsx` | UX/INP; removes one «broken site» impression | P1 |
| 12 | **Stray CSS**: `@import "tailwindcss" source(none); @source "../src"; @source "../index.html"; @source "../packages/storeLayout/src";` (`src/index.css:63`) — removes ~41 selectors generated from docs/worker text | `src/index.css`, budget log | Measured bytes = the programme's CSS spend ceiling | P0 |
| 13 | **Merchant real-user vitals** (the brief's own «measure my speed») | see §C Phase 4 | first-party RUM per store, no Google call | P4 |

### B.2 Cloudflare-side settings the owner must switch on (and what the code must do to benefit)

| Setting (exact name, where) | Owner action | What the code must do first | Expected effect for Iraq |
|---|---|---|---|
| **Smart Placement** — `wrangler.jsonc` top level: `"placement": { "mode": "smart" }` | Add the key at the **top level** (it inherits into `env.staging`) or add `'placement'` to the fold list at `scripts/prepare-deploy-config.mjs:185-201`; deploy staging; read `cf-placement` header for a week | Nothing to benefit; but measure `/product/*` and store-home **document** TTFB before/after, because `assetWithPreview` HTML rewriting would move away from the Iraqi PoP with the Worker. If documents regress, keep placement off and rely on rank 3 (cached resolve + preload). Record the result as DECISIONS row 171 | Multi-wave API handlers run beside D1: −(waves−1) × D1 RTT per request |
| **D1 location hint** — `wrangler d1 create <name> --location <hint>` | Only at creation; an existing DB cannot move. Options: (a) log `served_by_region` first (rank 4) and accept; (b) create a new DB with `--location weur` or `eeur` (nearest hints available; there is no Middle-East hint at time of writing — verify in the dashboard) and migrate by export/import in a maintenance window | Rank 4 logging; migration runbook with `scripts/migrate-check.mjs --twice` | D1 RTT from a European primary is roughly a third of a US one for Iraqi PoPs |
| **D1 read replication (Sessions API)** — dashboard → D1 → database → Settings → «Read replication» | Enable when out of beta for the account | Public GET routes call `env.DB.withSession('first-unconstrained')` and pass the bookmark cookie for read-your-writes on the merchant/admin routes (`withSession` is never called today) | Reads served from a replica near Europe/Asia PoPs; primary only for writes |
| **R2 location hint / jurisdiction** — `wrangler r2 bucket create <name> --location <hint>` | Only at creation; today's `levonis-files-staging` is wherever it was made | Rank 9 (Range-from-cache) matters more: once `/files` video is edge-cached the R2 region is paid once per object per colo | Fewer cold fetches from a far region |
| **Argo Smart Routing** (dashboard → Traffic) and **Tiered Cache → Smart Tiered Cache** (dashboard → Caching → Tiered Cache) | Toggle both (Argo is billed per GB) | Rank 2 must emit `s-maxage` so the upper tier holds the answer; `/files` already immutable | Cold-cache misses from Baghdad/Erbil PoPs fetch from one upper tier instead of the origin region |
| **Browser Cache TTL** (Caching → Configuration) | Set to **«Respect Existing Headers»** (it is 4 h today; the code re-stamps around it, `catalog.ts:84-96`) | Nothing — the re-stamp remains as belt and braces | Removes a class of stale-answer bugs |
| **Cache Rules for HTML** (Rules → Cache Rules) | Rule: host `levonis-iq.com, *.levonis-iq.com`, path not `/api/*` and not `/files/*` and not `/assets/*`, Cache eligibility **Eligible**, Edge TTL **«Use cache-control header if present, bypass otherwise»**, **Respect Origin** | Documents must say what they mean: after rank 3 the store-home and product documents emit `Cache-Control: public, max-age=0, s-maxage=60` (no stale-while-revalidate — the document names chunk hashes; P2 review) **only when the rewrite is viewer-independent** (it is: OG tags + resolve JSON + preloads), and keep `no-cache` for everything with a session-dependent rewrite; `Vary: Accept-Language` if the document ever varies **PRECONDITION**: the `CLOUDFLARE_ZONE_ID` secret, so the deploy workflows purge the zone after every deploy (`scripts/purge-zone-cache.mjs`); without it the rule stays off | Document TTFB from the Iraqi PoP ≈ 20–40 ms instead of Worker + D1 |
| **Early Hints** (Speed → Optimization → Content) | Toggle on | Documents emit `Link: </assets/index-<hash>.css>; rel=preload; as=style, </fonts/cairo-arabic.woff2>; rel=preload; as=font; crossorigin` (generated in `scripts/write-asset-headers.mjs` into `dist/_headers` and by `assetWithPreview` for rewritten documents); Early Hints only fire on cached or fast 103-capable responses, so rank 3 first | CSS + font start one RTT earlier (~150 ms on 4G) |
| **Brotli** and **HTTP/3 (with QUIC)**, **0-RTT Connection Resumption** (Speed → Optimization → Protocol; Network) | Confirm all on (Brotli is on by default) | Nothing | ~10 % smaller transfers; fewer handshake RTTs on lossy Iraqi mobile |
| **Images → Transformations** enabled for the zone (Images → Transformations) | Enable (per-zone toggle; billed per unique transformation) | Rank 5: the `?w=` route can use the `IMAGES` binding (already bound) or `/cdn-cgi/image/width=…,format=auto/` URLs; pick one and pin it in a test | Cards download ≤ 60 KB instead of 300–800 KB |
| **Cache Reserve** (Caching → Cache Reserve) — optional | Enable if `/files` misses are frequent after Tiered Cache | Nothing | Long-tail product/reel media survives eviction |
| **Rocket Loader, Auto Minify, Mirage, Polish** | Keep **off** (Rocket Loader and Auto Minify break the CSP hash `THEME_BOOT_SCRIPT` and the inline theme script) | — | Avoids a broken first paint |
| **Speed Brain / Speculation Rules** (Speed → Optimization → Content) | Try on staging; measure with the lab script | The SPA already prefetches routes; may double-fetch | Possibly faster «back» navigations |
| **Web Analytics (RUM beacon)** (Analytics → Web Analytics) | Optional owner-level check; CSP already allows `cloudflareinsights` | Nothing (merchant vitals are first-party, §C P4) | Zone-wide LCP/INP/CLS by country, free |
| **Observability logs** (`observability.enabled` is already true) | Keep on; add a Logpush or dashboard query on `served_by_region` and `cf-placement` | Rank 4 logging | Evidence for the D1/placement decisions |

### B.3 What routing «to Iraq» honestly means

Cloudflare serves static assets and edge-cache hits from its Iraqi PoPs already; the Worker runs there too. What is far is **D1** (single primary) and **R2**. So «route servers to Iraq» is achieved by (1) answering from the Iraqi colo cache whenever the answer is anonymous (ranks 2, 3, 9, Cache Rules), (2) putting the Worker beside D1 for the remaining multi-query handlers (Smart Placement) and (3) moving/replicating D1 as close as the platform allows (Europe). The owner should not expect a D1 primary in Iraq.

### B.4 Tests and tooling (PageSpeed «many tests»)

- Promote `scratchpad/perf/{measure,variants,attrib}.cjs` to `scripts/perf-lab.mjs` (Playwright, Slow-4G/×4, routes `/ /community /products /product/x /requests /auth /community/store/x /p/x`), printing TTFB/FCP/LCP/CLS/TBT/req/KB as JSON into `scratchpad/perf/<date>.json`; every performance PR pastes the before/after table.
- `scripts/psi.mjs`: runs PageSpeed Insights API against `levonis-iq.com` and one store host when `PSI_API_KEY` is set (owner Q6), else prints the manual URLs; results recorded in `docs/PERFORMANCE_LOG.md` (new) per phase exit.
- `tests/bundleBudget.test.ts`: assert `dist/_headers`; lower `ENTRY_BUDGET` after rank 6; add a `vendor-icons` presence check; keep CSS at 60 KB and storefront at 47 KB.
- `tests/edgeCachePolicy.test.ts`: every route in the rank-2 list emits the policy and never for a session cookie; `tests/d1Waves.test.ts`: prepare-count ceilings per hot route; `tests/fileRangeDelivery.test.ts`: Range served from cache; `tests/firstPaintAndFonts.test.ts`: no third-party stylesheet in `index.html`.
- Exit gate for every programme phase: lab LCP on `/` and on a store home not worse than the previous phase; PSI mobile performance score recorded.

---

## C. The unified programme

### C.1 Phase order (each phase ships alone and ends green on the pinned tests)

Sizes: S ≤ 2 dev-days · M 3–6 · L 7–12 · XL > 12. «Browser scripts» are Playwright files under `scripts/`.

| # | Phase | Tracks | Ships | Files (principal) | Migration | Tests | Browser scripts | Budget gate | Size |
|---|---|---|---|---|---|---|---|---|---|
| **P0** | Budget and lab | perf + all | `source()` restriction measured; HTML comments stripped; `dist/_headers` CI assert; `scripts/perf-lab.mjs` + `scripts/psi.mjs`; `docs/PERFORMANCE_LOG.md` baseline; hoist `CommandCenter.tsx:53-54`; fix the three «row 11» citations; DECISIONS rows 168 (Sorani scope) and 169 (viewer autoplay) drafted for the owner | `src/index.css:63`, `vite.config.ts`, `tests/bundleBudget.test.ts`, `scripts/perf-lab.mjs`, `scripts/psi.mjs`, `docs/DECISIONS.md`, `docs/MERCHANT_PLATFORM.md:279`, `src/components/merchant/shell/strings.ts:4`, `src/components/community/hub/copy.ts:10` | none | `bundleBudget` (CSS total printed and recorded), `themeSystem` unchanged | `perf-lab.mjs` baseline run | CSS ≤ 61,361 B (must drop) | S |
| **P1** | First paint for Iraq | perf | B.1 ranks 1, 6, 7, 10, 11; storefront L1 (skeletons) + L2 (eager cover `<img>` in core for the lazy hero variants, `Hero.tsx:31-42`); storefront closure paybacks (`profileIcons`, `attributes`, `governorates` lazy) | `index.html`, `src/index.css`, `public/fonts/*`, `public/sw.js`, `worker/lib/securityPolicy.ts`, `packages/platform-kit/src/edge/securityPolicy.ts`, `vite.config.ts`, `src/lib/motion.ts`, `src/components/ui/{Overlay,Sheet,Toast}.tsx`, `src/components/search/LiveSearch.tsx`, `src/lib/useRail.ts`, `src/pages/{Home,Product,Auth,Storefront,StorefrontProduct}.tsx`, `src/components/storefront/blocks/Hero.tsx`; **churn:** `src/App.tsx:179-204,450-467` (one small PR rebased last) | none | `firstPaintAndFonts`, `securityPolicy`, `bundleBudget` (entry ≤ 100 KB after measuring, storefront closure ≤ 45 KB), `uiPrimitives` (LazyMotion still passes the Overlay pins), new `tests/motionLazy.test.ts` (no `motion/react` static import in the entry closure) | `perf-lab.mjs` before/after; `e2e-motion.mjs`, `e2e-ui-kit.mjs` unchanged | initial payload ≤ 190 KB; CSS unchanged | M |
| **P2** | Server, edge and Iraq | perf | B.1 ranks 2, 3, 4, 5 (route only), 9; `placement` on staging measured; D1 `served_by_region` logged; Early Hints `Link` lines; DECISIONS row 171 (Iraq routing) | `worker/routes/{products,storefront,settings,community,printQuote,printRequests,uploads,reviews}.ts`, `worker/lib/{edgePolicy(new),membershipBenefits,session,socialPreview,imageConvert,videoSniff}.ts`, `worker/index.ts:586-646`, `scripts/write-asset-headers.mjs`, `wrangler.jsonc` / `scripts/prepare-deploy-config.mjs:185`; **churn:** `src/pages/community/access.tsx:68-83`, `src/App.tsx:562` | none | new `tests/edgeCachePolicy.test.ts`, `tests/d1Waves.test.ts`; `fileRangeDelivery` (Range from cache), `seoRoutes` (ETag kept), `storefrontIsolation` (cached storefront never carries viewer data), `edgeCacheLifetime` | `perf-lab.mjs`; `e2e-subdomains.mjs` (resolve per host still correct with the inlined JSON) | — | L |
| **P3** | Quick wins, no migration (Counter 0 · Storefront A · Journeys 1) — **✅ landed 2026-09-29** (DECISIONS rows 174–176). Deviations: `tests/workspaceStrings.test.ts` was folded into `tests/workspaceUi.test.ts`; `scripts/e2e-workspace.mjs` was not written (the shell pins live in `merchantWorkspaceShell`/`workspaceUi`); `SalesTabs.OrdersTab` was KEPT because `storeCommerceClient` B26, `merchantLoadFailures` and `merchantOrderDetailUi` still pin it — its CSS payback is still owed; A9 (`Chat.tsx` `'ku'→'ckb'`) landed with the link-cards client; the storefront does not yet SHOW `open_now` (helpers ready: `resolveOpenState`/`openStateSentence`, `worker/lib/storeHours.ts`); `/quote` dropped `accessory_lines` from its public answer and `publishRequest` does not answer `estimate` yet; `/grams-quote` and `/link` answer no `estimate`; bulk status excludes cancel by design; `MerchantStore` gained optional `open_now`/`next_change_at`. | all three | **Counter:** shell motion (Seam `MerchantShell.tsx:352,599,609`, settle `:292`, badge `:326`), Operate\|Design `Segmented`, focus-to-h1; Today v2 (status strip with server `open_now` from new pure `worker/lib/storeHours.ts`, Pulse open/unpublished, sub-rows, act-on-row confirm/restock, dock); `orders/OrdersList.tsx` on `DataList` with `?q=`, bulk status, tracking on ship (existing `orders.delivery_tracking_no`), CSV via new `worker/lib/csv.ts`; `merchant/counter/strings.ts`. **Storefront A:** hex/red fixes (`parts.tsx:144,149`), collection covers (L9), card 2nd image + `has_video` (L10), in-store search + sort server side (L11), reviews photos/filter/«المزيد» + review-form photos (L12), success → `/orders/:id` (A5), `notifyOrderPlaced` for store orders (A8), `'ku'→'ckb'` (A9), store identity on orders (A6/K1 payload part). **Journeys 1:** `worker/lib/printEstimate/*` (`Estimate` contract, `factors/covers/quantity_curve`), margin leak closed at `printQuote.ts:925,1245,1469`, bed-contact fix `printPricing.ts:383`, client types (`community/requests/api.ts:89-97`, `printApi.ts:118-131`), revisions `estimate` typed | `src/components/merchant/shell/{MerchantShell,sections/CommandCenter}.tsx`, new `src/components/merchant/orders/OrdersList.tsx`, `src/components/merchant/shell/sections/OrdersSection.tsx:13-21`, `worker/routes/{merchant,merchantOrders,merchantWorkspace,storefront,storeOrders,orders,merchantReviews,printRequests,printQuote}.ts`, `worker/lib/{storeHours(new),csv(new),storeLayout,printPricing,printEstimate(new)}.ts`, `src/components/storefront/{parts.tsx,blocks/{Collections,Reviews,Tabs}.tsx,runtime.tsx}`, `src/components/community/reviews/StoreReviews.tsx`, `src/pages/{StoreCheckout,Chat,Orders,OrderDetail}.tsx`, `src/lib/api.ts` | none | new `tests/workspaceStrings.test.ts`, `tests/workspaceUi.test.ts`, `tests/storeHours.test.ts`, `tests/merchantOrdersBulk.test.ts`, `tests/storefrontSearch.test.ts`, `tests/storefrontReviews.test.ts`, `tests/printEstimateContract.test.ts`; extended `merchantOrderStatus` (tracking_no), `ordersCustomer` (store only on `merchant_id` orders), `orderNotify` (store placed), `printPricing` (bed contact), `printQuoteRoutes` (`target_margin_percent` ignored publicly); `merchantWorkspaceShell` untouched except the frame-motion pin | `e2e-store-builder.mjs` unchanged; new `scripts/e2e-workspace.mjs` (360/1280, ar/en/ckb, reduced motion on/off: Seam, settle, tray in flow) | shell ≤ 25 KB, closure ≤ 32 KB; storefront closure ≤ 47 KB; CSS ≤ P0 total — **measured after merge and the 2026-09-30 review fixes: shell 15.1 KB / closure 25.2 KB (HEAD 14.6 / 24.7, +0.5 KB); storefront closure 42.7 KB; CSS 60,964 B = 59.5 KB by the gate's method (HEAD 60,990 B, −26 B); entry 66.2 KB; initial 182.8 KB; Today 14.8 KB with 18 KB beyond the shell and no animation-features chunk; `vendor-motion` is out of the shell, Today, the orders list, Chat and Requests closures** (docs/PERFORMANCE_LOG.md 2026-09-29 Phase 4 + P3 and its «Review fixes» table; DECISIONS row 177); the `OrdersTab` payback is still owed | L |
| **P4** | «سرعة متجري» — measure my store's speed — **✅ landed 2026-09-30** (DECISIONS row 180, the real-user privacy statement; migration `0161_storefront_vitals.sql`). Deviations: the ingest rides the beacon mount at `POST /api/storefront/events/vitals` and the report the layout mount at `GET /api/merchant/store/layout/speed/report` (the plan's `/api/storefront/vitals` and `/api/merchant/store/speed` would each need a new mount, gateway owner row and 01-TARGET row; the alias routers `storefrontVitalsRoutes`/`storeSpeedRoutes` are exported and tested, not mounted); the tab lives in the builder (`/merchant/store/design?tab=speed`), not under Analytics; `storefront_vitals_marks` carries a `nonce` column (the event recorder's «counters only when THIS request made the mark» pattern); `VITALS_REJECTED` is silent (no refusal sentence — no screen shows it); the weight audit is phone-first (a desktop-only video weighs nothing in `first_view`); the Pulse line is read from `attention.speed` inside `PulseRow` (the empty slot in `CommandCenter` was retired at integration); `STOREFRONT_FIXED_KB` (the «ثابت للتطبيق» row) is now pinned by `tests/bundleBudget.test.ts` to within 3 KB of the build (230 ≈ initial 183.0 + storefront 46.6 = 229.6 KB). | storefront + workspace (unified) | `src/lib/storeVitals.ts` (~1 KB, dynamic import after load+idle from `Storefront.tsx`/`StorefrontProduct.tsx`); `POST /api/storefront/vitals` in `storefrontEvents.ts` (JSON, bot filter, owner excluded, once per visitor/day/device via new marks table, one `db.batch`); `worker/lib/storeSpeed.ts` weight audit (closed finding codes) + `GET /api/merchant/store/layout/speed`; `GET /api/merchant/store/speed?days=7\|28`; builder tab «السرعة» (`storeDesign/speed/SpeedPanel.tsx`, `Tab` union + `TabStrip` at `StoreDesignPanel.tsx:80,428-441`); outbound PageSpeed link tile; workspace Pulse line + attention `source('speed')` linking to the tab; DECISIONS row 170 (RUM privacy statement) | `src/lib/storeVitals.ts`, `worker/routes/storefrontEvents.ts`, `worker/lib/storeSpeed.ts`, `worker/routes/{storeLayout,merchantWorkspace}.ts`, `src/components/merchant/storeDesign/{StoreDesignPanel.tsx,speed/SpeedPanel.tsx,strings.ts}`, `src/components/merchant/shell/{attention.ts,sections/CommandCenter.tsx}` | **`storefront_vitals`** (`storefront_vitals_daily`, `storefront_vitals_marks`) | new `tests/storefrontVitals.test.ts` (bot filter, owner excluded, dedupe, clamps, DNT), `tests/storeSpeed.test.ts` (findings from fixture layouts, p75 bucket as a word, ≥50-sample rule), `merchantWorkspaceShell.test.ts:315-331` (attention words exist verbatim in `storeDesign/strings.ts`); `bundleBudget` (storefront static closure unchanged; **`storeVitals` and `SpeedPanel` pinned as lazy chunks**, and the fixed-weight pin); landed tests: `tests/storefrontVitals.test.ts` (9), `tests/storeSpeed.test.ts` (11), `tests/speedPanelUi.test.ts` (12), `tests/workspaceUi.test.ts` (10) | `e2e-store-builder.mjs` extended with the Speed tab (empty state + fixture; steps `speed`, `pulse`, `stale`, `vitals`, `light`, `reduced`) | storefront closure unchanged; `StoreDesignPanel` chunk ≤ 250 KB — **measured after P4 + P5 integration: `storeVitals` 1,036 B, its own lazy chunk, in no storefront static closure; `SpeedPanel` 6,295 B, lazy inside the builder; `StoreDesignPanel` 54,720 B = 53.4 KB; storefront closure 46.6 KB (the reporter adds 0 B to it); CSS unchanged (60,964 B)** (docs/PERFORMANCE_LOG.md 2026-09-30); **review 2026-09-30** (DECISIONS row 180 addendum): anonymous samples capped per network (`VITALS_ANON_PER_NETWORK` = 10 per store, day and device; `storefront_vitals_marks.net`, a salted hash of the IP alone, in 0161), `mean_ms` null under 50 samples and rounded to 100 ms above (no single reading by differencing two reads), CLS sent only where `PerformanceObserver.supportedEntryTypes` lists `layout-shift` (WebKit and Firefox sent an unmeasured 0 that counted «جيد»), the ingest 3 dependent D1 round trips (was 6–7) and `/speed`, `/speed/report` 4 (was 5), one scheduler for both store pages (`scheduleStoreVitals`, src/lib/storeBeacon.ts); tests `tests/storefrontVitals.test.ts` (11), `tests/storeSpeed.test.ts` (12), `tests/storeVitalsClient.test.ts` (3) | M |
| **P5** | Media everywhere (layout JSON only) — **✅ landed 2026-09-30** (DECISIONS rows 181 media caps / «phones see the still», 182 the announcement as a layout key; no migration). Deviations: the page background is ONE lazy chunk (`BackgroundMedia`, ≈ 2.5 KB) behind a small door (`BackgroundLayer.tsx`) — no core poster and no `theme.css` `[data-sf-bg]` rule: every block, the notice and the footer sit on opaque theme-ground cards over it (0 B of new CSS; a core version measured 47.9 KB against the 47 KB gate); the viewer shell's images mode for gallery/reviews (`reels/ReelsViewer`) was NOT delivered and moves to P6 with the reels; no `MOTION` token; the poster rule covers the hero video and the page background only (the video block's poster stays optional); DELETE `/api/merchant/store/layout/media/*` sets `deleted_at` only (bytes left to the sweep) and `used_in` also names services and the store's logo/banner; the announcement sheet's words are their own lazy module (`counter/announceStrings.ts`) — in the Counter's table they cost the Today chunk 2.5 KB (paid back at integration); the media registry (`mediaRefs.ts`) is unchanged because every new key lives inside the registered `layout_json` columns. | storefront B + Counter (announcement) | hero video + poster + `video_on_phone` (L3); page background image/GIF/video with dim and `data-sf-bg` (L4); `max_bytes` per media slot + `LAYOUT_MEDIA_TOO_HEAVY` (L5); `header.notice`/`notice_link` (L6) + Counter `AnnouncementSheet` and dock door; footer links (L7); scheduled blocks (L8); media library v2 (`byte_size`, `used_in`, `DELETE … MEDIA_IN_USE`, XHR progress, poster capture) (B1); Page panel (B2); «معاينة على هاتفي» QR (B3); viewer shell in **images mode** for gallery/reviews; motion token `MOTION` only if the measured P0 payback ≥ 300 B; `storefront/strings.ts` + `storeDesign/strings.ts`; DECISIONS row 172 (media caps, phones see the still) | `packages/storeLayout/src/{blocks,schema,tokens,data,normalize,verify,defaults}.ts`, `src/components/storefront/{StoreRenderer,StoreHeader,theme}.tsx\|ts`, `theme.css`, new `BackgroundLayer.tsx`, `blocks/{Hero,HeroVariants,Gallery,Reviews,extra}.tsx`, new `reels/ReelsViewer.tsx` (images mode first), `src/components/merchant/storeDesign/{panels,fields,pickers,BlockInspector,catalog,refusal}.tsx\|ts`, new `src/components/merchant/counter/AnnouncementSheet.tsx`, `worker/routes/storeLayout.ts:483-643`, `worker/lib/{storeLayout,mediaRefs}.ts`, `src/lib/refusalStrings.ts` | none | `storeLayoutSchema` (keys/tokens), `storeDesignEditor.test.ts:81-84,446` round-trips with `background`/`footer.links`/`schedule`/`header.notice`, `storeDesignRoutes.test.ts:85-99` (`byte_size`, `used_in`, DELETE refusal), `storeLayoutRoutes` (`media_too_heavy`), `themeSystem` (contrast under the three dims), `refusalStrings` (new codes), new `tests/storeAnnouncement.test.ts` (allow-list, dates) | `e2e-store-builder.mjs` (background, notice, media library); new `scripts/e2e-storefront-media.mjs` (hero video never mounts under reduced motion/Save-Data/phone default) | storefront closure ≤ 47 KB (ledger: +1.43 KB in, −3.4 KB out from P1); theme.css spend ≤ measured payback — **measured after P4 + P5 integration: storefront closure 46.6 KB of 47 (StoreRenderer 12.6 KB, `theme` 7.1 KB); `BackgroundMedia` 2,556 B, `AnnouncementSheet` 6,991 B, `PreviewQr` 1,530 B, `MediaLibraryPoster` 845 B — all lazy; theme.css spend 0 B, CSS 60,964 B = 59.5 KB (unchanged); Today (`CommandCenter`) 15,653 B of 18 KB after the payback (18,120 B as merged)**; landed tests: `tests/storeLayoutSchema.test.ts` (37), `tests/storeDesignEditor.test.ts` (21), `tests/storeDesignRoutes.test.ts` (10), `tests/storeLayoutRoutes.test.ts` (30), `tests/storefrontBackground.test.ts` (11), `tests/storeDesignPagePanel.test.ts` (12), `tests/storeAnnouncement.test.ts` (8); browser `scripts/e2e-storefront-media.mjs`, `scripts/e2e-store-builder.mjs` (`media`, `announce`); **review 2026-09-30** (DECISIONS rows 181–182 addenda): an animated GIF background is a moving background under the video's own rule (its still — the poster or its first frame — under reduced motion, under Save-Data, and on a phone unless «phones» is ticked; the stop control), `MEDIA_IN_USE` counts the owner's community posts and product options, colours and variants, scheduled blocks and a notice whose window opens later leave the edge-cached public payload until 20 minutes before they open (`publicLayoutAt`, `SCHEDULE_LEAD_MS`), the notice wraps to three lines, is read hidden at the first render and hands focus on when hidden; `StoreVideo` (422 B) and the hero's workshop facts (`workshopFacts`, 1,279 B) are their own lazy chunks and the layout tables one `store-layout` file — **storefront closure 47,480 B of 48,128 (648 B of headroom; 47,739 B as integrated)**, CSS the integration's 60,964 B byte for byte; open: the moving background's «stop» control still sits after the footer (WCAG 2.2.2 met in letter) — a fixed control over the blocks, a reserved row or a header slot is a design call left to the owner; tests `tests/storeDesignRoutes.test.ts` (11), `tests/storeDesignPagePanel.test.ts` (13), `tests/mediaReferences.test.ts` (18), `tests/storefrontBackground.test.ts` (11), `tests/storeAnnouncement.test.ts` (8), `tests/bundleBudget.test.ts` (13); browser `scripts/e2e-storefront-media.mjs` (the hide hands focus on; the toggles name their action), `scripts/e2e-store-builder.mjs` (the library's buttons, the announcement's question takes focus) | L |
| **P6** | Doors and journeys | journeys 2–3 + storefront D (minus D2) | `estimate/{EstimateCard,WhyThisPrice,useEstimate,strings}.tsx` (lazy `estimate` chunk); live estimate from step 2 + «خيارات أكثر» (R2/R3); Tools on the card; `RequestComposer` with `mode:'store'|'chat'` wrapping `RequestWizard` (R4), `readJob` spec fields (R5), `PrintRequestSheet` thin host (R6), gate wording (R7); `StoreDoor` («اسأل عن هذا» / «اطلب مثله»); ask-about-product via `chats/open {productId}` + product card with `existingCard` replay (C2/A1); customer chip ckb (C4); **HostBar** runtime slot (cart · chat · quote · search) with `cartCountStore`; lazy `Search` tab view + host `/products?q=`; «عرض السلة» toast action (B1); `MoreFromStore` (B3); live tracker `journey/Thread.tsx` with `useFreshOnReturn` polling, `events[]` on tracking, ckb status titles (K2–K5); **reels viewer video mode with the `products` source** (`GET /api/storefront/:slug/reels?source=products` from `community_product_media`, no migration) + `reels` block (`shelf|grid`, registry 27 → 28) + `?reel=` deep link; row 169 (viewer autoplay) decides muted autoplay vs tap-to-play | `src/components/estimate/*`, `src/components/journey/*`, `src/components/storefront/{runtime.tsx,StoreHeader.tsx,HostBar.tsx(new),blocks/{Tabs,tabViews,Reels(new)}.tsx,reels/*}`, `src/components/community/requests/RequestWizard.tsx` (read-mostly; churn-adjacent — the composer wraps it), `src/components/chat/commerce/PrintRequestSheet.tsx`, `src/pages/{Storefront,StorefrontProduct,Tools,Chat,OrderDetail}.tsx`, `src/components/OrderTracker.tsx`, `worker/routes/{chats,chatCommerce,storefront,orders,printRequests}.ts`, `worker/lib/{orderNotify,chatCards}.ts` | none | new `tests/estimateCard.test.ts`, `tests/chatQuotes.test.ts` (spec fields priced; card posted once per product per thread; `STORE_NO_CUSTOM_REQUESTS`/`COMMUNITY_CLOSED` still refuse), `tests/printRequestsV2` (options persisted), `tests/orderTrackingThread.test.ts` (no merchant-private text or ledger amounts; poll off at terminal stages; `data-order-tracker/data-stage/data-reached` kept), `tests/storefrontReels.test.ts` (one `<video>` mounted, poster always present, cache header, reduced motion never autoplays), `storeLayoutSchema.test.ts:59` 27 → 28, `storefrontBlocks.test.ts:145` file-per-type, `uiSystem.test.ts:102/112` (no `fixed bottom-0`), tokens/`useMotion` guard over `src/components/{storefront,estimate,journey}/**` | new `scripts/e2e-reels.mjs` (360/1280, ar/en/ckb, reduced motion on/off), `scripts/e2e-store-journey.mjs` (search → product → ask → add → cart → checkout → order thread) | storefront closure ≤ 47 KB (HostBar inside the `Storefront` chunk, ≤ 0.35 KB); `reels` chunk ≤ 5 KB; `estimate` chunk lazy | XL |
| **P7** | The Counter answers (ownership, no leaving) | workspace 1 | `ChatThread` extraction from `src/pages/Chat.tsx` + `shell/sections/ThreadScreen.tsx` (`routeTable.ts:49` stops `away`; move pin `merchantWorkspaceShell.test.ts:119`); master–detail inbox ≥ 1280; saved replies (`merchant_quick_replies`, `worker/routes/merchantQuickReplies.ts`, composer bar reading `GET /api/chats/:id/quick-replies`); Hours & Vacation Ledger Card + read-time `store_away` rule in `storeTakesOrders` (`storeOrderOps.ts:135`) + `vacation_over` nudge; away line in the thread header; Spine timeline + internal note + merchant invoice (`invoices.ts:63-73`) + read-only returns card + `returns` attention source; customer notes/tags/segments + customers CSV; `StoreSettingsTab` onto `Card`/`Field`/`Switch` (CSS payback P2); catalog/finance Sorani debt reduced through `counter/strings.ts` | `src/components/chat/ChatThread.tsx`(new), `src/pages/Chat.tsx`, `src/components/merchant/{inbox/MerchantInbox.tsx,shell/{routeTable.ts,sections.tsx,sections/ThreadScreen.tsx},orders/OrderDetailScreen.tsx,customers/*,dashboard/StoreSettingsTab.tsx,counter/*}`, `worker/routes/{merchant,merchantOrders,merchantCustomers,merchantQuickReplies(new),invoices,chats}.ts`, `worker/lib/{merchantAuth,storeOrderOps,storeHours}.ts`, `worker/index.ts` (mount) | **`counter_ops`** (`orders.merchant_note`, `merchant_stores.away_until/away_message`, `merchant_quick_replies`, `merchant_customer_notes`) | new `tests/storeAvailability.test.ts`, `tests/quickReplies.test.ts`, `tests/merchantNoteNeverLeaks.test.ts`, `tests/merchantInvoice.test.ts`; `merchantInbox` thread door; order-screen 12 KB pin (`bundleBudget.test.ts:410`) | `scripts/e2e-workspace.mjs` extended (thread inside on `/admin/inbox/<id>` on a store host) | shell/closure ≤ 25/32 KB; CSS ≤ previous | L |
| **P8** | Curated clips, SEO, coupon scope | storefront C + workspace 2 | `merchant_showcase` video columns (W1) + merchant write (W2) + `showcase` reels source (W3/W4) + poster capture in `ShowcaseTab` (W8) + `clips` tab kind (W6, `?tab=clips` until the host route lands) + OG for `?reel=` (W10); SEO fields (`seo_title`, `seo_description`, `og_image_key`) + card with the `ShareStore` unfurl preview + `resolveStorePreview` preference; coupon `scope_json` + `per_customer_limit` validated at quote and place-order; ledger/analytics exports; Channels card; starter `reels_first` | `migrations/*`, `worker/routes/{merchant,storefront,storeOrders,merchantFinance,merchantAnalytics}.ts`, `worker/lib/{socialPreview,mediaRefs,storeLayout}.ts`, `packages/storeLayout/src/{blocks,data,starters}.ts`, `src/components/merchant/dashboard/{CatalogTabs,StoreSettingsTab}.tsx`, `src/components/storefront/blocks/{Tabs,tabViews}.tsx`, `src/components/storefront/addressedView.ts` | **`store_reels`** (showcase columns + partial index), **`store_seo_coupons`** | `tests/storefrontReels` (showcase source, product ownership `SHOWCASE_PRODUCT_NOT_YOURS`), `tests/mediaRefs` registry count, `tests/socialPreviewSeo.test.ts`, `tests/couponScope.test.ts` (quote and place-order agree), `storeDesignEditor.test.ts:446` starters | `e2e-reels.mjs` (showcase clips), `e2e-store-builder.mjs` (Showcase «أضف مقطعًا») | unchanged | M |
| **P9** | Sources and workshops | journeys 4 | `bbox_fill_factor` admin key (owner-set; `priced:false` until set); link ladder: og: read via `guardedFetchBytes` (S3c), file download only from admin `printLinkProviders[].download` templates (S3d), guest twin `POST /api/print-quote/from-link` (S4), calculator → request `from-analysis` (S5); indicative workshop quotes (`GET …/indicative`, opt-in `show_indicative_price`, platform margin, `machine_hour_iqd` reaches `priceForPrinter`) (W1/W2/E9); `responds_within_minutes` on the `*/15` cron (C6) shown by StoreDoor; `?project=` prefill read in `Requests.tsx` (the sender is in the churn zone — read only) | `worker/routes/{printRequests,printQuote,merchantPrinters}.ts`, `worker/lib/{externalModels,fetchGuard,attachments,printQuote/*}.ts`, `worker/index.ts:818` (cron), `src/pages/{Requests,Tools}.tsx`, `src/components/merchant/dashboard/PrintersTab.tsx`, `src/components/adminCommunity/PrintPricingAdmin.tsx` | **`customer_journeys`** (`community_request_files.origin/source_url`, `print_analyses.origin_url`, `merchant_request_prefs.show_indicative_price`, `merchant_stores.responds_within_minutes`) | new `tests/linkImport.test.ts` (private hosts refused, 40 MiB cap, redirect cap, archive refused, no bytes stored on failure), `tests/indicativeQuotes.test.ts` (opt-out absent, eligible only, never a cost line, direct mode targets one store, `no-store`); `eligibilityRoutes` untouched | `scripts/e2e-store-journey.mjs` (link source path) | unchanged | M |
| **P10** | The owner hires (staff) | workspace 3 | `merchant_store_members`; `storeForMember` + `requireStoreAccess` (opt-in per route; `storeForUser`/`requireStoreOwner` unchanged and still the only gate for money, payouts, settings, slug, delivery, design publish, staff, coupon create, exports); `/me.role` + `granted[]`; `Capability` gating in `nav.ts`; `store_staff` section (contract `SECTION_PATHS`, `NAV`, `SECTIONS`, `SHAPE`, `WORKSPACE_SCREENS`); `StaffSection`; member bell filtering; «by {member}» from `order_status_history.changed_by` | `worker/lib/merchantAuth.ts`, new `worker/routes/merchantStaff.ts`, `worker/routes/merchant.ts:148-187`, `packages/contracts/src/merchantRoutes.ts`, `src/components/merchant/shell/{nav,sections,SectionFallback}.ts\|tsx`, new `src/components/merchant/staff/StaffSection.tsx` | **`store_members`** | new `tests/merchantRouteGates.test.ts` (enumerates every `/api/merchant/*` route and its gate), `tests/merchantStaff.test.ts`; **move** pins `merchantWorkspaceShell.test.ts:155,161,215`; `storefrontIsolation` extended | `e2e-workspace.mjs` (member sees only granted nav) | shell ≤ 25 KB (+1 lucide icon ≈ 0.2 KB) | M |
| **P11** | After the community churn settles, and owner-gated items | all | Host routes `/chat/:id`, `/clips`, `/saved-items` in `StorefrontApp` (`src/App.tsx:402-445`) + in-app `useOpenChat` on hosts; `useIdlePrefetch` final shape if P1's PR waited; ckb in `worker/lib/notifications.ts`; `posts` reels source (row 173) + optional `store_posts` block; ProjectCard video-cover bug (`ProjectCard.tsx:37-49`) and the `?project=` sender (`src/pages/community/Project.tsx:273`) handed to the community workflow; engine convergence E10 (`print_materials.process` if needed) + `docs/PRINT_QUOTE_ENGINE.md` §8; PSI from the Worker (`PSI_API_KEY`, 1/store/day) if Q6 yes; lookbook block + three accents only inside the remaining CSS payback; «usually replies within» line already fed by P9; phone-tab change if Q1 yes; A5 flyer print; custom domain stays «قريبًا» | `src/App.tsx`, `worker/lib/notifications.ts`, `src/components/community/**`, `worker/routes/storefront.ts` (posts source), `worker/lib/printPricing.ts`, `worker/lib/printQuote/*`, `packages/storeLayout/src/{blocks,tokens}.ts`, `scripts/theme-tokens.mjs` | optional `print_materials.process`; `merchant_store_psi_runs` if Q6 | golden-file test A-via-wrapper ≈ B on `tests/printQuoteGeometry` fixtures; `storeLayoutSchema` 28 → 29 if lookbook; `themeSystem` generated block if accents | `e2e-subdomains.mjs` (host chat in scope), `e2e-reels.mjs` (posts source) | CSS: only inside measured payback | M–L |

### C.2 Why this order

- P0–P2 are pure engineering with no owner decision pending and no churn-zone dependency except two small `App.tsx` edits; they also make every later phase's PageSpeed numbers honest (a merchant «speed» tab that shows a site-wide 5 s LCP would blame the merchant for the Google Fonts stylesheet).
- P3 groups every «no migration, no decision» item from the three tracks so the merchant, the shopper and the pricing engine all move in the first product release.
- P4 (measure my speed) is the brief's most explicit ask, is disjoint from the churn, and needs only the P1 storefront closure paybacks to fit.
- P5 before P6: the viewer's images mode, `max_bytes` and posters are prerequisites for reels and hero video; the announcement key lands once for both tracks.
- P6 is the largest phase because the shopper's doors, the estimate contract and the first reels source form one journey (search → product → ask/request/buy → track/watch); it is split into three PRs (estimate + composer; HostBar + search + tracker; reels) that each keep the closure ≤ 47 KB.
- P7–P10 each carry one migration and one owner decision (vacation semantics, autoplay/showcase, link providers/indicative prices, staff matrix), so an unanswered question blocks one phase only.

### C.3 Provisional numbering (assigned at merge; roles are the contract)

| Role | Provisional migration | Phase | DECISIONS row (new) |
|---|---|---|---|
| `storefront_vitals` | 0156 — **landed as `0161_storefront_vitals.sql`** | P4 | 170 — real-user vitals privacy statement — **landed as row 180** |
| `counter_ops` | 0157 | P7 | 168 — Sorani scope extended (D6 → merchant/storefront/journey folders); 174 — vacation read-time rule |
| `store_reels` | 0158 | P8 | 169 — viewer autoplay; 173 — posts as store clips (P11) |
| `store_seo_coupons` | 0159 | P8 | 175 — coupon scope/per-customer limit; announcement as a layout key |
| `customer_journeys` | 0160 | P9 | 176 — link providers and `bbox_fill_factor`; 177 — indicative workshop prices |
| `store_members` | 0161 | P10 | 178 — staff role matrix |
| — | — | P2 | 171 — Iraq routing (placement/D1 result) |
| — | — | P5 | 172 — media caps; phones see the still — **landed as row 181** (and row 182, the announcement as a layout key) |

`docs/COMMUNITY_ECOSYSTEM.md` §9 reserves 0156/0157/0158 in prose for unbuilt phases and claims 0155 (L468) which is already taken by `0155_community_comment_replay.sql`; that document needs renumbering to «next free at merge» (Q13).

### C.4 What must wait for the community workflow, and what is disjoint

| Waits (touches a churn path) | Path | Programme placement |
|---|---|---|
| Host routes `/chat/:id`, `/clips`, `/saved-items`; `useIdlePrefetch` retime; `AppIntro` CLS; resolve gate at `App.tsx:562` | `src/App.tsx` | P1/P2 as single-file PRs rebased last; routes in P11 |
| Double `/api/community/access` call | `src/pages/community/access.tsx` | P2 (tiny PR) or hand to the community workflow |
| ckb notification titles | `worker/lib/notifications.ts` | P11 (merchant notices already have ckb via `merchantNotify.ts` meta) |
| `?project=` sender, ProjectCard video cover, «اطلب طباعة مثلها» prefill | `src/pages/community/Project.tsx`, `src/components/community/projects/*` | Reader side (`Requests.tsx`) in P9; sender handed over |
| `posts` reels source, `store_posts` block | reads `worker/routes/communityPosts.ts` semantics; decision row 173 | P11 |
| Reel door on Today gated by `GET /api/community/access` | read-only use of `worker/routes/community.ts:126` | P3 (no edit) |
| Everything else — the Counter, the builder, media, vitals, reels from product videos and showcase, the estimate contract, doors, search, tracking, pricing sources, staff, all of P0–P2 except the App.tsx lines | disjoint | as scheduled |

### C.5 Standing rules every phase is tested against

No new wallet/escrow/chat/products/orders/notification system (quick replies insert text; indicative prices are reads; bulk status repeats the single transition); additive migrations only; server-authoritative (margin, availability, estimate, cache policy); ar/en/ckb with real Sorani in feature `strings.ts` files under row 168, shell/ui copying verbatim; theme tokens only, no hex, no `dark:`, logical utilities; springs through `useMotion()`; CSS ≤ 60 KB with every phase's total ≤ the previous phase's; storefront closure ≤ 47 KB with every new surface lazy; Playwright checks at 360 and 1280 in three languages with reduced motion on and off.

---

## D. Open questions for the owner / أسئلة مفتوحة للمالك

1. **AR:** هل نغيّر تبويبات الهاتف في مساحة التاجر من «نظرة عامة · الطلبات · المنتجات · المتجر» إلى «اليوم · الطلبات · الرسائل · المنتجات · المزيد»؟ (الردّ على الزبائن هو ثاني عمل يومي.)
   **EN:** Change the merchant phone tabs from Overview · Orders · Products · Store to Today · Orders · Inbox · Products · More? (Answering customers is the second daily verb.)
2. **AR:** هل توافق على كتابة سورانية حقيقية في كل ملفات النصوص الجديدة للتاجر والمتجر والرحلات (تمديد القرار D6)، بدل العربية المؤقتة تحت علامة OWNER؟ ونرجو مراجعة قارئ للجداول مرة واحدة.
   **EN:** Extend D6 (real Sorani, no Arabic placeholder) to the new merchant, storefront and journey string files? A native reader should check the tables once.
3. **AR:** أثناء الإجازة (`away_until` في المستقبل): هل يرفض المتجر الطلبات الجديدة تلقائيًا (القاعدة المقترحة) أم يعرض الرسالة فقط ويستمر البيع ما لم توقفه بنفسك؟
   **EN:** While on vacation, should the store refuse new orders by default (the proposed read-time rule) or only show the away message and keep selling unless you also pause it?
4. **AR:** قياس السرعة من الزوار الحقيقيين: توافق على بيان الخصوصية — فئات يومية فقط، عينة واحدة لكل زائر في اليوم لكل جهاز، نفس استثناء DNT/GPC، نافذة 28 يومًا، لا نتيجة تحت 50 زيارة؟
   **EN:** Real-user speed: approve the privacy statement — daily buckets only, one sample per visitor per day per device, same DNT/GPC opt-out, 28-day window, nothing shown under 50 visits?
5. **AR:** الشعار والغلاف في «صف المتجر» يبقيان صورًا ثابتة (تُستخدم لبطاقات المشاركة وأيقونات التطبيق والمحادثة)، والفيديو/GIF المتحرك يكون في واجهة صفحة المتجر (hero) والخلفية. موافق؟
   **EN:** The store-row logo and banner stay still images (they feed share cards, app icons and chat headers); video/GIF live in the store page's hero and background. Agreed?
6. **AR:** PageSpeed Insights: نكتفي بالرابط الخارجي المجاني + قياسات زوارك + تدقيق وزن الشاشة الأولى، أم توفّر مفتاح `PSI_API_KEY` لتشغيل فحص من الخادم مرة يوميًا لكل متجر (وسكربت `scripts/psi.mjs` للموقع كله)؟
   **EN:** PageSpeed Insights: the free outbound link + your real-visitor numbers + the first-screen weight audit, or provide a `PSI_API_KEY` for a Worker-side run once per store per day (and the site-wide `scripts/psi.mjs`)?
7. **AR:** التشغيل التلقائي: هل يُسمح بتشغيل المقطع النشط وحده مكتوم الصوت داخل العارض الذي فتحه الزائر (استثناء من قاعدة «لا تشغيل تلقائي»)، مع الملصقات في كل مكان آخر وإيقافه عند تقليل الحركة أو توفير البيانات؟
   **EN:** Autoplay: allow muted autoplay of the active clip only inside the viewer the shopper opened (an exception to «never autoplay»), posters everywhere else, off under reduced motion or Save-Data?
8. **AR:** سقوف الوسائط للعراق: صورة الواجهة/الغلاف/الخلفية 1.5 MB (بما فيها GIF)، الملصق 400 KB، الفيديو 12 MB، عنصر المعرض 1 MB؛ فيديو الخلفية على الحاسوب فقط افتراضيًا والهاتف يرى الصورة الثابتة. أرقام مناسبة؟
   **EN:** Media caps for Iraq: hero/banner/background image 1.5 MB (GIF included), poster 400 KB, video 12 MB, gallery item 1 MB; background video desktop-only by default, phones see the still. Right numbers?
9. **AR:** هل يجوز عرض منشورات صاحب المتجر العامة المنشورة كمقاطع داخل صفحة متجره خارج بوابة المجتمع (`communityGate`)؟ حتى القرار، مصادر المقاطع هي فيديوهات المنتجات ومعرض الورشة فقط.
   **EN:** May a store show its owner's own public, published posts as clips on its store page outside `communityGate()`? Until decided, clip sources are product videos and the workshop showcase only.
10. **AR:** انتقالات بين الصفحات على مستوى الموقع (View Transitions على الراوتر) — مطلوبة رغم كلفتها على هواتف أندرويد الضعيفة، أم نكتفي بانتقالات الأقسام داخل مساحة التاجر والمتجر؟
    **EN:** Site-wide page transitions (View Transitions on the router) — wanted despite the INP cost on low-end Androids, or are section/sheet transitions inside the workspace and store enough?
11. **AR:** توجيه العراق: توافق على تفعيل Smart Placement وقياسه أسبوعًا على staging، وتفعيل Argo وTiered Cache وEarly Hints وتحويلات الصور من لوحة Cloudflare (بعضها مدفوع)، وعلى إنشاء قاعدة D1 جديدة بموقع أوروبي ونقل البيانات إن ثبت أن القاعدة الحالية في أمريكا؟
    **EN:** Iraq routing: approve enabling Smart Placement (measured a week on staging), Argo + Tiered Cache + Early Hints + Image Transformations from the Cloudflare dashboard (some are billed), and creating a new D1 with a European location hint and migrating if the current primary proves to be in the US?
12. **AR:** تبقى خارج النطاق بقرار سابق: النطاق المخصص (الصف 12 «قريبًا»)، الدفع عند الاستلام/طرق دفع جديدة، الرسائل الجماعية للعملاء، بوت واتساب/تيليغرام. تأكيد؟
    **EN:** Still out of scope by earlier decision: custom domains (row 12 «قريبًا»), cash on delivery or new payment methods, customer broadcasts, a WhatsApp/Telegram bot. Confirm?
13. **AR:** الترقيم: الهجرة 0155 مستخدمة فعلًا؛ وثيقة `COMMUNITY_ECOSYSTEM.md` تحجز 0155–0158 نصًا. نعتمد قاعدة «الرقم التالي الحرّ عند الدمج» ونعيد ترقيم الوثيقة؟ ومن يملك تعديلها الآن؟
    **EN:** Numbering: migration 0155 is taken; `COMMUNITY_ECOSYSTEM.md` reserves 0155–0158 in prose. Adopt «next free number at merge» and renumber that document — and who owns it right now?
14. **AR:** مصادر الروابط: هل نملأ `printLinkProviders` لـ Printables وThingiverse (واجهات رسمية) فقط، ولا نكشط MakerWorld وCults3D احترامًا لشروطهم؟ وما قيمة `bbox_fill_factor` لتقدير الأبعاد المكتوبة (الصف 111 يمنعنا من اختراع رقم)؟
    **EN:** Link sources: fill `printLinkProviders` for Printables and Thingiverse (official APIs) only, and never scrape MakerWorld or Cults3D? And what `bbox_fill_factor` should price typed dimensions (row 111 forbids us inventing one)?
15. **AR:** الأسعار الاستدلالية للورش في المعالج: اختياري لكل ورشة، مدى فقط، بعبارة «تقديري — ليس عرضًا»، حدّ 5 ورش، والطلب المباشر يعرض المتجر المخاطَب وحده. موافق؟
    **EN:** Indicative workshop prices in the wizard: opt-in per workshop, range only, labelled «indicative — not an offer», capped at 5, direct requests show only the addressed store. Agreed?
16. **AR:** مصفوفة الفريق: مدير (الطلبات، الرسائل، الكتالوج، الكوبونات، العملاء، قراءة التحليلات) وموظف (الطلبات، الرسائل، المخزون فقط)؛ المال والتحويلات والإعدادات والتصميم والتوصيل والفريق للمالك وحده؛ حدّ 5 أعضاء؛ الإشعارات تبقى للمالك. تأكيد؟
    **EN:** Staff matrix: manager (orders, inbox, catalogue, coupons, customers, analytics read) and staff (orders, inbox, stock only); money, payouts, settings, design, delivery and staff owner-only; max 5 members; notifications stay with the owner. Confirm?
17. **AR:** فواتير التاجر: هل يجوز لصاحب المتجر تنزيل مستند الفاتورة الذي يصدره `invoices.ts` لطلبات متجره (اليوم للزبون والإدارة فقط)؟ وهل نعرض له حالة الإرجاع وسببه (قراءة فقط) أم العدد فقط؟
    **EN:** Merchant invoices: may the store owner download the invoice `invoices.ts` issues for a store order (customer/admin only today)? And should the merchant see an open return's state and reason (read-only) or only the count?
18. **AR:** التحديث الجماعي لـ50 طلبًا يرسل 50 إشعارًا و50 بطاقة محادثة كما تفعل التأكيدات الفردية — مقبول، أم نخفّض السقف إلى 20؟
    **EN:** A bulk confirm of 50 orders fans out 50 customer notices and 50 chat cards, as single confirms do — acceptable, or cap bulk at 20?

## 2. Track plan — workspace

# The Counter (الكاونتر · کاونتەر) — the merchant's daily stand
## Synthesised build plan for the «workspace» track (winner: owner-first; grafts from craft-first and systems-first)

Repo `/home/user/Levonis` at `b726a1c6`, read-only. Every path, line, class, route and table below was re-opened during this synthesis; where the winning proposal cited a wrong line it is corrected here and marked **(corrected)**. Status words: EXISTS / PARTIAL / MISSING / NEEDS REFACTOR; features: EXISTS (reuse) / EXTEND (file) / NEW (schema + route).

**Facts that move the plan (measured today)**

| Fact | Evidence |
|---|---|
| CSS total is **61,429 B of 61,440 B gzip (level 9, as the test measures) — 11 B of headroom**; the built sheet is `dist/assets/index-CUZYPlyH.css` (48,660 B) plus 7 route sheets | `tests/bundleBudget.test.ts:63,65,433-438`; measured with `gzipSync(level 9)` over `dist/assets/*.css` |
| Migration `0155_community_comment_replay.sql` is already claimed (untracked, other workflow); The Counter claims **0156, 0157, 0158** | `ls migrations`, `git status` |
| Churn zone today includes `worker/routes/chats.ts`, `worker/index.ts`, `worker/lib/http.ts`, `src/App.tsx`, `src/lib/refusalStrings.ts` — anything The Counter adds there lands **after** the community merge | `git status --short` |
| `text-ui-base / text-ui-sm / text-ui-xs` are theme tokens (`src/index.css:196-214`) but **no utility is emitted for them** (0 hits in the built sheet). The workspace uses the arbitrary sizes that already exist: `text-[22px] [17px] [15px] [14px] [13.5px] [13px] [12.5px] [12px]` (all 1 hit) — the craft-first hierarchy, not the winner's `text-ui-*` | grep of `dist/assets/index-CUZYPlyH.css` |
| `stroke-success`, `stroke-current`, `text-border-subtle`, `max-w-[1400px]`, `lg:grid-cols-[minmax(0,1fr)_360px]` do **not** exist; `lg:grid-cols-[minmax(0,1fr)_340px]`, `xl:grid-cols-[minmax(0,1fr)_360px]`, `xl:grid-cols-[minmax(0,1fr)_440px]`, `-start-[5px]`, `ring-canvas`, `bg-border-subtle`, `inset-y-2`, `w-0.5`, `h-0.5`, `inset-x-5`, `rounded-e-2xl`, `border-s-gold/70`, `bg-white/[0.04]`, `bg-white/[0.08]`, `bg-warning/[0.06]`, `min-h-16`, `min-h-14`, `min-h-12`, `lv-choice`, `lv-section`, `press-scale`, `scroll-edge`, `bleed-x`, `hide-scrollbar`, `bg-accent`, `material-thin`, `pb-safe`, `[text-wrap:balance]` all exist | same grep |
| `storePublicShape` is `worker/routes/merchant.ts:71`; `/me` is L148-187; `PATCH /store` is L280 and its `open` switch L360-402 (the winner said 358-404 for PATCH) **(corrected)** | file |
| The inbox thread leaves the workspace at `shell/routeTable.ts:49` and is pinned at `tests/merchantWorkspaceShell.test.ts:119` (`{kind:'away', to:'/chat/chat_1'}`) **(pin named)** | files |
| The static gold marks are `MerchantShell.tsx:352` (sidebar) and `:599` / `:609` (phone tabs; the runner-ups said 604/613) **(corrected)**; `CountBadge` L326-330; `Suspense key={section}` L292; `SideNav` L374; `BottomTabs` L571 | file |
| `src/pages/Chat.tsx` is 980 lines; the four hard-coded merchant chips are L402-410; `lang === 'ku'` is L70; lazy commerce sheets L30-34 | file |
| `PATCH /products/:id` is behind `requireSellingPrivileges` (`merchantCatalog.ts:824-826`, gate at `merchantAuth.ts:185`) — a restock from Today on a paused store is refused `STORE_PAUSED`; the sheet must show that refusal, not a generic error | files |
| `toCsv` already exists at `worker/lib/importCsv.ts:182` (used by `merchantCatalog.ts:407-412`); the graft becomes a `csvResponse()` wrapper in a new `worker/lib/csv.ts` that imports it | file |
| `dashboard/ui.tsx` (39 raw palette classes + 1 hex) is imported today only by `catalog/CatalogManager.tsx`, `shell/sections/ReviewsSection.tsx`, `workshop/reasons.ts`, `inbox/MerchantInbox.tsx`. `SalesTabs.tsx` (50 raw + 1 hex), `StoreSettingsTab.tsx` (75), `PrintersTab.tsx` (49 + 9 hex), `CostingTab.tsx` (27), `src/pages/MerchantStore.tsx` (49) carry their own raw classes | grep |
| `docs/DECISIONS.md:20` row 11 is referrals; row 12 (L21) is custom domains «قريبًا»; row 166 (L208) is the community phase whose D6 (`docs/COMMUNITY_ECOSYSTEM.md:138`) allows real Sorani for community strings. `shell/strings.ts:4`, `docs/MERCHANT_PLATFORM.md:279` **and** `src/components/community/hub/copy.ts:10` all cite «row 11» for the Sorani rule — doc drift | files |
| `CommandCenter.tsx:53-54` has two `import` lines after a function body | file |
| `GET /api/community/access` exists (`worker/routes/community.ts:126`) — the reel door can be gated honestly | file |

---

## 1) Concept — three sentences

A shop owner does five things every day — opens the orders, answers customers, restocks, posts something, and tweaks the front — so the workspace home stops being a dashboard and becomes **Today**: a status strip you can flip, a Pulse line that says whether the shop is open, published and fast, one queue of what is waiting with the action done on the row, this week's figures, and a dock of the four doors you open daily. Every other screen is refined on the incumbent frame (one nav table, one attention read, the `ui/` primitives, tokens only): the one gold Seam slides between destinations, the order screen grows a Spine, the inbox keeps the thread inside the workspace, settings cards say how the customer reads each setting. Ownership features are chosen by daily use and by what already exists in the schema — saved replies, hours and a read-time vacation rule, order search/bulk/tracking/note/CSV/invoice, customer notes and segments, SEO fields, an announcement bar, a real-user speed report under Analytics, and, last, staff roles behind an unchanged `requireStoreOwner` — with no new wallet, escrow, chat, products, orders or notification system.

---

## 2) Information architecture and navigation

### 2.1 Sections — what changes in the contract (`packages/contracts/src/merchantRoutes.ts`)

All 20 sections and paths stay (`SECTION_PATHS` L49-72; `SECTIONS_WITH_ID` L75-85). Changes, in order of phase:

| Address | Kind | Phase | Edits |
|---|---|---|---|
| `/merchant/inbox/<id>` | EXISTS as an address (`merchantHref.thread()` L117, `inbox` ∈ `SECTIONS_WITH_ID`) — today `away` | 1 | `shell/routeTable.ts:49` stops returning `away` for `inbox` + id; move the pin at `tests/merchantWorkspaceShell.test.ts:119`; `shell/sections.tsx:111` `inbox` becomes a `section()` that renders `ThreadScreen` when `id` is set |
| `/merchant/analytics?view=speed` | NEW closed query word, **not** a section (systems-first graft, adapted): `readWorkspaceQuery` (L168-187) gains `view: 'speed'` beside `status/stock/state/new`; the analytics header gets a `TabStrip` in **link mode** («الأرقام | السرعة», `ui/Tabs.tsx:41,62,106,167`) | 2 | contract + `tests/merchantRoutes.test.ts` pin for the closed list; `AnalyticsSection.tsx` lazy-loads `SpeedReport` (own chunk, listed in `WORKSPACE_SCREENS`) so the 16 KB analytics pin (`bundleBudget.test.ts:409`) holds. No nav row, no lucide icon in the shell closure |
| `/merchant/store/staff` | NEW section `store_staff`, group `store`, phone tab `store`, `capability: 'owner'` | 3 | `SECTION_PATHS` +1, `nav.ts NAV` +1 (one lucide icon ≈0.2 KB against the 1.3 KB closure headroom), `sections.tsx` +1 lazy, `SectionFallback.SHAPE` +`store_staff:'list'`, `WORKSPACE_SCREENS` +`StaffSection`, `merchantHref.storeStaff()`; **move** the pins `visibleNav().length === NAV.length` (`merchantWorkspaceShell.test.ts:161`) and `nav.items.length === NAV.length` (L215) and the store-group order (L155) |

Not sections (sheets or cards inside existing chunks, so no nav byte): Saved replies (sheet from the composer and from Inbox), Hours & Vacation card and SEO card (Store settings, replacing/adding beside the hours card at `StoreSettingsTab.tsx:463`), Announcement sheet (Store settings + a Today dock door), Restock sheet (Today and Products), Tracking sheet (order screen), Customer notes/tags (`customers/CustomerDetailView.tsx`), Returns card (order screen), Exports (menu items on Orders / Customers / Money / Analytics), Channels card (top of Notifications).

### 2.2 Phone tabs — an owner decision, not a Phase 0 change

`PHONE_TABS` is `home · orders · products · store` (`nav.ts:131-136`), pinned at `tests/merchantWorkspaceShell.test.ts:156` and written into `docs/MERCHANT_PLATFORM.md:194`. The plan **does not** change it until the owner answers Q1 (§10). If yes: Today · Orders · Inbox · Products · More — move the pin, add a DECISIONS row, update §4.6. Until then the inbox stays one tap away through the Today queue row and «More».

### 2.3 Modes (systems-first graft)

Operate | Design as a `Segmented` (`ui/Segmented.tsx:60-75`, items carry `badge`) in the desktop top bar at ≥1024 px, replacing the plain «تصميم المتجر» button; on phones the existing icon button stays. Design = `merchantHref.storeDesign()`; no new route.

### 2.4 Capabilities (Phase 3 only)

`Capability = 'always'` (`nav.ts:61`) becomes `'always' | 'manager' | 'owner'`; `visibleNav(granted)` (L145) already filters by a set. The grant set comes from `/me` (`role`, `granted[]`), never from a tier string (`merchantWorkspaceShell.test.ts:333` forbids tier reads).

### 2.5 The tree after Phase 3

```
/merchant                       Today
  orders[/id]                   list (+q, bulk, CSV) · order (+Spine, tracking, note, invoice, returns card)
  requests/orders               as is
  customers[/key]               list (+segment filter) · detail (+notes, tags)
  marketing/coupons[/id]        (+scope, per-customer limit — Phase 2)
  products[/id] · collections · services · showcase · printers · costing · requests    as is
  store/design                  as is (builder track)
  store/settings                identity · profile · contact · HOURS & VACATION · SEO · policies · social · status · address (+announcement door)
  store/delivery                as is
  store/staff        NEW        members and roles (owner only)
  money (+ledger CSV) · analytics (الأرقام | السرعة) · reviews · inbox[/id] (thread inside) · notifications (+Channels)
```

---

## 3) Screen-by-screen spec

Conventions: `[ ]` button, `( )` chip, `▣` thumbnail, `●` badge/dot, `⋯` menu, `▸` door, `═` sheet grabber. 360 has 16 px gutters; 1280 has the sidebar at 240 px (64 px rail when collapsed). Wireframes are drawn LTR for legibility; the build is logical (`ps/pe/ms/me/start/end`) and mirrors in ar/ckb.

### 3.0 The written visual contract (craft-first graft)

| Role | Class (exists in the build) | Used today at |
|---|---|---|
| Screen title | `text-[22px] font-bold leading-tight [text-wrap:balance] text-text-primary` | `CommandCenter.tsx:153` |
| Section heading | `text-[15px] font-bold text-text-primary` | `CommandCenter.tsx:187` |
| Row text | `text-[14px] font-medium leading-snug` | `CommandCenter.tsx:225` |
| Meta | `text-[12.5px] text-text-muted` | `CommandCenter.tsx:226` |
| Figure in a row | `text-[17px] font-bold tabular-nums` inside `<bdi>` | `CommandCenter.tsx:221-223` |
| Problem / ledger line | `text-[13.5px] leading-relaxed` | `CommandCenter.tsx:176` |
| Big figure | `KpiTile`'s own (`ui/KpiTile.tsx:26`) | — |

Rules: the numeral leads the sentence it counts; `tabular-nums` wherever a number can change; `<bdi>` / `<Money>` (`ui/Money.tsx:36`, `<bdi dir="ltr">`) for every figure; no `tracking-*` or uppercase on Arabic/Sorani (`index.css:818`); line-height ≥ 1.15. Grounds `bg-canvas / lv-surface / lv-surface-raised / bg-surface-selected`; text `text-text-primary / -secondary / -muted`; one accent `bg-gold / text-gold` (`--color-accent: var(--color-gold)`, `index.css:205`); status tones only as the pill, the chip and the alert (`MerchantShell.tsx:75` `TONE`). The two neutral alphas the shell already pays for (`bg-white/[0.04]`, `bg-white/[0.08]`) are reused; no new raw palette class anywhere.

One device per surface: the **Seam** (shell), the **Queue** (Today), the **Tray** (lists), the **Spine** (order), the **Ledger Card** (settings), the **Scale** (speed — bars, never SVG rings).

### 3.1 The shell (frame edits only: Seam, settle, badge, mode switch, focus)

**360**
```
┌──────────────────────────────────────────┐
│ ▣ متجر نور   ● مفتوح         🔍  🔔(3)   │ top bar (exists); status word beside the dot when key≠open
├──────────────────────────────────────────┤
│                                          │
│  <section content — motion.div settles>  │ data-scroll-owner
│                                          │
├──────────────────────────────────────────┤
│  ▔▔▔▔ ← the Seam (motion.span layoutId="ws-tabs-seam")
│  ⌂       🛍●      ▦●       🏬       ⋯    │ BottomTabs L571, in flow, pb-safe
│ اليوم   الطلبات  المنتجات  المتجر   المزيد│
└──────────────────────────────────────────┘
```
**1280**
```
┌──────────┬──────────────────────────────────────────────────────────────────────┐
│ ▣ نور    │ [ تشغيل | تصميم ]  [🔍 ⌘K ابحث عن طلب أو منتج…]  [＋ إنشاء ▾] [↗ عرض] 🔔 │
│ ● مفتوح  ├──────────────────────────────────────────────────────────────────────┤
│▎نظرة عامة│  (lv-alert-warning banner only while selling is off — exists)         │
│ المبيعات │                                                                      │
│  الطلبات 3│   <section content, max-w-6xl; Today/Orders/Inbox use the two-pane  │
│  مخصصة   │    grid classes that already exist>                                  │
│  العملاء │                                                                      │
│  الكوبونات│                                                                     │
│ …        │                                                                      │
│ المتجر   │                                                                      │
│  التصميم │                                                                      │
│  الإعداد │                                                                      │
│  التوصيل │                                                                      │
│  الفريق  │ ← Phase 3, owner only                                                │
│ ‹ طيّ    │                                                                      │
└──────────┴──────────────────────────────────────────────────────────────────────┘
```
Anatomy (all in `shell/MerchantShell.tsx`):
- Seam (sidebar): `MerchantShell.tsx:352` `<span … absolute inset-y-2 start-0 w-0.5 rounded-full bg-gold>` → `<motion.span layoutId="ws-side-seam" transition={m.spring('move')} …same classes>`; tabs L599/L609 `absolute inset-x-5 top-0 h-0.5 rounded-full bg-gold` → `layoutId="ws-tabs-seam"`. `aria-current` stays on the link.
- Settle: the `<Suspense key={section}>` child at L292 is wrapped by `<motion.div key={section} initial={{opacity:0, x:m.inline(12)}} animate={{opacity:1, x:0}} transition={m.spring('ui')}>`; no exit (the router keeps the old page under `useTransition`).
- Badge: `CountBadge` L326 keys the number: `<motion.span key={n} initial={{scale:.6,opacity:0}} animate={{scale:1,opacity:1}} transition={m.spring('quick')}>`.
- Mode switch: `Segmented size="sm"` with two items (`operate`, `design`); `onChange('design')` → `ws.go(ws.href(merchantHref.storeDesign()))`.
- Focus: on section change, focus the section's `h1` (or the frame's sr-only title for `ownHeading` entries, `nav.ts:78`).
- Byte rule: these are the only frame edits (`useMotion` and `motion/react` are already in the entry). Measured after Phase 0: `WORKSPACE_SHELL_BUDGET` 25 KB / `WORKSPACE_CLOSURE_BUDGET` 32 KB (`bundleBudget.test.ts:359-360`).

### 3.2 Today (`shell/sections/CommandCenter.tsx`, rewritten in place, same chunk)

**360**
```
┌──────────────────────────────────────────┐
│ ▣ متجر نور     مفتوح الآن · يغلق 9:00 م ⋯│ ← STATUS STRIP: Switch (open/paused), text = server open_now
├──────────────────────────────────────────┤
│ ● مفتوح · يغلق 9:00 م                  ▸ │ ← PULSE (lv-surface divide-y): each line a Door
│ ⚠ تعديلات محفوظة لم تُنشر               ▸ │    hours · layout_unpublished · speed grade (Phase 2)
│ ⚡ سرعة الصفحة: جيدة                    ▸ │
├──────────────────────────────────────────┤
│ ⚠ متجرك متوقف — أعد فتحه؟      [افتح]    │ ← problems (exist, L165-186) + vacation_over (Phase 1)
├──────────────────────────────────────────┤
│ بانتظارك                                 │ h2 (L187)
│ ┌──────────────────────────────────────┐ │
│ │ 🛍  3  طلبات جديدة تنتظر تأكيدك      ▸│ │ ← Queue ticket (anatomy L212-233 kept)
│ │     #A1F3 · نور · 45,000  [تأكيد] [▸] │ │    sub-rows: first ≤2 from attention.orders.first
│ │     #A1F4 · علي · 12,500  [تأكيد] [▸] │ │
│ │ 💬  2  محادثات فيها رسائل لم تقرأها  ▸│ │    sub-rows: inbox.first → thread door
│ │     نور: «هل يتوفر بالأسود؟»     [رد ▸]│ │
│ │ 📦  1  منتج نفد مخزونه               ▸│ │
│ │     ▣ حامل هاتف PLA · 0     [+ مخزون] │ │ ← RestockSheet (PATCH /products/:id)
│ │ ↩   1  طلب إرجاع — القرار عند Levonis ▸│ │ ← returns source (read-only, Phase 1)
│ │ ⭐  1  تقييم بلا رد منك              ▸│ │
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ اليوم وآخر 7 أيام            كل التحليلات ▸│
│ ┌ KpiTile ─┐ ┌ KpiTile ─┐ (2×2, L384-397)│
│ │ 4        │ │ 120,000  │                │
│ └──────────┘ └──────────┘                │
│ ┌ 18 ▁▂▃▅▆ ┐ ┌ 640k ▲   ┐                │
│ └──────────┘ └──────────┘                │
├──────────────────────────────────────────┤
│ افعل الآن                                │ ← DOCK (nav, scrolls)
│ (＋ منتج) (🎬 ريل) (📣 إعلان) (🖼 الغلاف)  │
├──────────────────────────────────────────┤
│ جهّز متجرك 4/7 ──────────────── [إخفاء]  │ ← SetupChecklist (L251+), only while incomplete
└──────────────────────────────────────────┘
```
**1280** (`grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]` — the exact class `OrderDetailScreen.tsx:205` emits)
```
┌ strip: ▣ متجر نور · مفتوح الآن · يغلق 9:00 م · إجازة: لا     [◉ مفتوح]   تعديل الساعات ▸ ┐
├──────────────────────────────────────────────────┬──────────────────────────────────┤
│ نبض المتجر  ● مفتوح ▸  ⚠ غير منشور ▸  ⚡ جيدة ▸   │ اليوم وآخر 7 أيام                 │
│ بانتظارك                                          │ [4][120,000][18 ▁▂▃▅][640k ▲]     │
│ 🛍 3 طلبات جديدة تنتظر تأكيدك                   ▸ │ افعل الآن                         │
│    #A1F3 نور · 45,000 · بغداد      [تأكيد] [▸]   │ (＋ منتج)(🎬 ريل)(📣 إعلان)(🖼 غلاف)│
│    #A1F4 علي · 12,500 · أربيل      [تأكيد] [▸]   │ جهّز متجرك 4/7                     │
│ 💬 2 محادثات لم تُقرأ                             ▸ │ ○ أضف صورة الغلاف                 │
│    نور: «هل يتوفر باللون الأسود؟»         [رد ▸]  │ ○ حدّد أين توصل وبكم               │
│ 📦 1 منتج نفد مخزونه                              ▸ │ ○ اختر شكل صفحتك وانشره           │
│    ▣ حامل هاتف PLA · 0                [+ مخزون]  │                                  │
│ ↩ 1 طلب إرجاع — القرار عند Levonis               ▸ │                                  │
└──────────────────────────────────────────────────┴──────────────────────────────────┘
```
Anatomy:
- `StatusStrip`: `<section class="lv-surface flex items-center gap-3 p-4">` › `StoreMark` (shell L365, reuse) › `<p class="text-[15px] font-bold text-text-primary truncate">` + `<p class="text-[12.5px] text-text-muted">{open_now text}</p>` › `Switch` (`ui/Switch.tsx:41`, `label`, `description`, `busy`) → `PATCH /api/merchant/store {open}` (merchant.ts:360-402). Tone words from `TONE`.
- `PulseRow`: `<ul class="lv-surface divide-y divide-border-subtle overflow-hidden">` › `<li>` › `Door class="flex min-h-12 items-center gap-3 px-4 text-[13.5px] text-text-primary hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"` › dot `h-1.5 w-1.5 rounded-full bg-success|bg-warning` › text › chevron `h-4 w-4 text-text-muted rtl:-scale-x-100`. Lines: open state (→ settings), `layout_unpublished` (→ design), speed grade (→ `analytics?view=speed`, Phase 2, only with ≥50 samples).
- `WaitingRow` (ticket): keeps `CommandCenter.tsx:212-233` classes verbatim; wrapped `<motion.li layout initial={false} exit={{height:0, opacity:0}} transition={m.spring('ui')}>` inside `AnimatePresence`. Sub-rows: `<ul class="ps-8 pb-3 space-y-2">` › `<li class="flex items-center gap-2 text-[12.5px] text-text-secondary">` › `min-w-0 flex-1 truncate` › `Button size="sm" variant="secondary" loading` (`ui/Button.tsx:85`) › `IconButton variant="ghost"` (L147). Confirm → `POST /api/merchant/orders/:id/status {status:'confirmed'}` then `useAttention().refresh(true)`.
- `QuickDock`: `<nav aria-label class="flex gap-2 overflow-x-auto hide-scrollbar bleed-x px-4 scroll-edge">` › `Door class="lv-button lv-button-secondary lv-button-sm press-scale"`. Doors: `merchantHref.newProduct()`; reel → `ws.mainHref(<community composer>)` **only when** `GET /api/community/access` (community.ts:126) allows (rule 13); announcement → sheet; cover → `merchantHref.storeSettings()`.
- `RestockSheet`: `Sheet` v2 (`ui/Sheet.tsx:107`, `detents={['medium']}`, `header`, `footer`), `NumberInput` (`ui/NumberInput.tsx:52`), refusal `STORE_PAUSED` rendered with the store's own sentence.

### 3.3 Orders list (`orders/OrdersList.tsx`, NEW lazy chunk replacing `SalesTabs.OrdersTab` in `shell/sections/OrdersSection.tsx:13-21`)

**360**
```
┌──────────────────────────────────────────┐
│ الطلبات                        [⇩ CSV] ⋯ │
│ [🔍 رقم الطلب أو اسم الزبون            ] │ ← Field+Input inputMode=search, debounced SEARCH_DEBOUNCE_MS → ?q=
│ (الكل)(جديد ●3)(مؤكد 5)(قيد التجهيز 2)(مشحون)│ ← Segmented sm, badges = attention.orders.by_stage
├──────────────────────────────────────────┤
│ ☐ #A1F3   نور محمد              45,000   │ ← DataList card (<640)
│   3 قطع · بغداد · منذ 12 د       [جديد]  │
│   [تأكيد]                            [▸] │ ← next step from MERCHANT_ORDER_FLOW
├──────────────────────────────────────────┤
│ ☐ #A1F2   علي حسن               12,500   │
│   1 قطعة · أربيل · أمس           [مؤكد]  │
│   [بدء التجهيز]                      [▸] │
├──────────────────────────────────────────┤
│ 2 محددة   [تأكيد الكل] [طباعة الملصقات] ✕│ ← TRAY, in flow (never fixed bottom-0)
└──────────────────────────────────────────┘
```
**1280**
```
│ الطلبات      [🔍 بحث…] (الكل)(جديد 3)(مؤكد)(قيد التجهيز)(مشحون)              [⇩ تصدير CSV] │
│ ┌──┬────────┬──────────────┬──────────┬──────────┬─────────┬────────┬────┐               │
│ │☐ │ الطلب  │ الزبون        │ المحافظة │ المبلغ    │ الحالة  │ منذ    │    │ DataList table│
│ │☐ │ #A1F3  │ نور محمد      │ بغداد    │ 45,000   │ [جديد]  │ 12 د   │ ⋯  │ ⋯: confirm ·  │
│ │☐ │ #A1F2  │ علي حسن       │ أربيل    │ 12,500   │ [مؤكد]  │ أمس    │ ⋯  │ ship (tracking)│
│ └──┴────────┴──────────────┴──────────┴──────────┴─────────┴────────┴────┘ · slip · invoice│
│ [2 محددة] [تأكيد] [بدء التجهيز] [طباعة ملصقات الشحن]                                        │
```
Anatomy: `DataList` (`ui/DataList.tsx:120`; props L77-99: `columns` with `card:'title'|'badge'|'meta'|'field'|'hidden'`, `rowHref`, `rowActions → MenuEntry[]`, `rowLabel`, `selection {selected,onChange,actions}`, `wideAt`, `skeletonRows`, `onRetry`). Status = `StatusChip` (`ui/Badge.tsx:48`) with `orderStatusTone` (`orders/labels.ts`). Tray = `DataListSelection.actions`: `<motion.div role="toolbar" class="lv-surface-raised flex items-center gap-2 px-3 py-2" initial={{y:m.travel(16),opacity:0}} animate={{y:0,opacity:1}} transition={m.spring('ui')}>`; in flow under the list (`tests/uiSystem.test.ts` forbids `fixed bottom-0`). Address: `?status=` stays the contract's; `q` is screen state.

### 3.4 Order screen additions (`orders/OrderDetailScreen.tsx`, 469 lines; 12 KB pin `bundleBudget.test.ts:410`)

**360 (changed strips only)**
```
│ [طباعة ملصق الشحن] [فاتورة PDF] [نسخ الرابط]        │ ← invoice door (Phase 1)
│ ┌ الخط الزمني — the SPINE ─────────────────────────┐ │
│ │ ●─ وصل الطلب                       اليوم 10:12   │ │ done: bg-gold
│ │ │                                                │ │
│ │ ◉─ أكّده                    [تأكيد الطلب]        │ │ ← next step: the only filled button
│ │ ○─ جهّزه                                          │ │
│ │ ○─ شحنه   رقم التتبع (اختياري) [________] [حفظ]  │ │ ← orders.delivery_tracking_no (0028:35)
│ │ ○─ سُلّم → يستلمه الزبون → المال يتحرر           │ │
│ └──────────────────────────────────────────────────┘ │
│ ┌ الإرجاع ─────────────────────────────────────────┐ │ ← read-only (Phase 1)
│ │ طلب إرجاع مفتوح منذ أمس · القرار عند Levonis      │ │
│ └──────────────────────────────────────────────────┘ │
│ ┌ ملاحظة داخلية — لا يراها الزبون ─────────────────┐ │ ← orders.merchant_note (0156)
│ │ [يريد التغليف هدية                             ] │ │
│ └──────────────────────────────────────────────────┘ │
```
**1280**: the existing `lg:grid-cols-[minmax(0,1fr)_340px]` (L205) — Spine + items on the start side, customer / payment / note / returns cards in the 340 px column.

Spine anatomy (replaces the `<ol class="relative" data-order-timeline>` at L235; `tests/merchantOrderDetailUi.test.ts` pins `eventText`/`actorText`, not the markup): `<ol class="relative ms-3 border-s border-border-subtle">` › `<li class="relative ps-6 pb-5">` › node `<span class="absolute -start-[5px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-canvas bg-border-subtle">` / done `bg-gold` › `<p class="text-[14px] font-medium">` + `<p class="text-[12.5px] text-text-muted">`. Events from `GET /api/merchant/orders/:id/timeline` (`merchantOrders.ts:245`; kinds L64-70: placed, status, cancelled, refunded, receipt_confirmed, credit_*). The next step is `lv-button lv-button-primary lv-button-sm` inside its `li`; the tracking field is `lv-input` + `Button size="sm"`. The node of the step just completed animates `scale 0→1` (`quick`); no SVG.

### 3.5 Inbox with the thread inside (`inbox/MerchantInbox.tsx`, 241 lines + NEW `shell/sections/ThreadScreen.tsx`)

**360**
```
List (exists; the row at L179/L220 stops being an <a href={mainHref('/chat/…')}> and becomes a Link to ws.href(merchantHref.thread(id)))
                    ──tap──▶
┌──────────────────────────────────────────┐
│ ‹  نور محمد · طلب #A1F3           ▸ الطلب │ ← header: back to inbox (in-workspace), context door
├──────────────────────────────────────────┤
│                         هل يتوفر بالأسود؟ │
│ نعم متوفر ✅                              │
├──────────────────────────────────────────┤
│ (أهلًا بك 👋)(متوفر ✅)(يجهز خلال يومين)(＋) │ ← QuickReplyBar: the store's saved replies
│ [اكتب رسالة…                        ] [↑] │ ← the existing composer (ChatThread), embedded
└──────────────────────────────────────────┘
Saved replies sheet (Sheet v2, detents medium/large):
│ ═══   الردود المحفوظة                 [＋] │
│ ≡ أهلًا بك 👋      «أهلًا بك في متجر نور…» ⋯│ ← Reorder.Group + MotionConfig reducedMotion="user" (BlockList.tsx:88 pattern)
│ ≡ مواعيد التجهيز   «نجهز الطلب خلال…»    ⋯│
│ 3/20                                      │
```
**1280** (`xl:grid-cols-[minmax(0,1fr)_440px]` exists — list on the start side, thread on the end side from 1280; below it the address opens the thread as the whole screen)
```
│ ┌ الرسائل ──────────────┬──────────────────────────────────────────────────────┐ │
│ │ [🔍 q](الكل)(طلبات)(طباعة)│ نور محمد · طلب #A1F3                        [▸ الطلب] │ │
│ │ ● نور محمد  هل يتوفر… │                          هل يتوفر باللون الأسود؟     │ │
│ │   علي حسن   متى يصل؟  │ نعم متوفر ✅                                          │ │
│ │                        │ (أهلًا بك 👋)(متوفر ✅)(يجهز خلال يومين)(التوصيل)(＋)  │ │
│ │                        │ [اكتب رسالة…                                   ] [↑] │ │
│ └────────────────────────┴──────────────────────────────────────────────────────┘ │
```
Anatomy: `QuickReplyBar` = `<div class="flex gap-2 overflow-x-auto hide-scrollbar px-4 py-2 scroll-edge">` › `<button class="lv-choice press-scale text-[13px]">` › `IconButton label variant="secondary"`. A tap **inserts** the body into the composer; the send stays `sendText` (`Chat.tsx:287`). `ChatThread` = a pure extraction of `Chat.tsx`'s message list + composer + lazy commerce sheets (L30-34) behind the same props; `Chat.tsx` becomes a thin page around it. `ThreadScreen` = header + `ChatThread` + the reply bar; on a store host `/admin/inbox/<id>` finally works (StorefrontApp has no `/chat`, `src/App.tsx` StorefrontApp routes).

### 3.6 Store settings → Hours & Vacation (Ledger Card) (`dashboard/StoreSettingsTab.tsx:463` card, rebuilt on `Card`/`Field`/`Switch`)

**360**
```
┌ ساعات العمل والإجازة ─────────────────────┐
│ الآن: مفتوح · يغلق 9:00 م                  │ ← server open_now / next_change_at (never computed on the client)
│ السبت    [09:00] – [21:00]       [◉]        │ ← existing rows (sanitizeHours merchant.ts:723; max 14)
│ …  الجمعة  مغلق                   [○]        │
├────────────────────────────────────────────┤
│ إجازة                                       │
│ [○] أنا في إجازة حتى  [ 2026-10-05 ]        │ ← away_until (0156)
│ رسالة الغياب  [نرجع يوم 5 تشرين الأول…]     │ ← away_message ≤200 (0156)
│ [☑] أوقف استقبال الطلبات أثناء الإجازة       │ ← read-time rule: storeTakesOrders false while away_until > now
│ ▍كيف يقرؤها الزبون: «المتجر في إجازة حتى ٥   │ ← the Ledger line (rounded-e-2xl border-s-2 border-s-gold/70
│ ▍تشرين الأول — نرجع يوم 5…»                 │    bg-white/[0.04] py-2 pe-3 ps-3 text-[13px] text-text-secondary)
│                                    [حفظ]    │
└────────────────────────────────────────────┘
```
**1280**: settings cards in `grid gap-4 lg:grid-cols-2` (exists), identity spanning both. The SEO card (Phase 2) sits beside it with the share preview reused from `share/ShareStore.tsx:55`.

### 3.7 Analytics → السرعة (`analytics?view=speed`, `SpeedReport` lazy inside `AnalyticsSection`)

**360**
```
┌──────────────────────────────────────────┐
│ [ الأرقام | السرعة ]                      │ ← TabStrip link mode (Tabs.tsx:41)
│ سرعة متجرك عند زبائنك الحقيقيين            │ h1 text-[22px]
│ آخر 28 يومًا · 312 زيارة هاتف مقاسة        │ nothing under 50 samples (speed.collecting)
│ ┌ KpiTile ─┐ ┌ KpiTile ─┐ ┌ KpiTile ─┐    │ value = p75 bucket word, hint = threshold
│ │ LCP  جيد │ │ INP  جيد │ │ CLS  جيد │    │
│ └──────────┘ └──────────┘ └──────────┘    │
│ توزيع زيارات الهاتف (LCP)                 │
│ جيد    ███████████████░░░░░ 71%           │ ← the SCALE: three DistributionBars, width inline
│ متوسط  ████░░░░░░░░░░░░░░░ 19%           │
│ ضعيف   ██░░░░░░░░░░░░░░░░░ 10%           │
├──────────────────────────────────────────┤
│ ما يُثقل صفحتك                            │
│ ▣ صورة الغلاف 6.2 MB (GIF) — أثقل عنصر    │ ← findings = ticket anatomy, SafeImage thumb
│   استبدلها بـ MP4 قصير أو WebP  [▸ التصميم]│
│ ▣ 3 فيديوهات في أول شاشة (38 MB) [▸ التصميم]│
│ ✓ الشعار والصور الأولى خفيفة (420 KB)      │
└──────────────────────────────────────────┘
```
**1280**: KPI row of four (`grid grid-cols-2 gap-3 lg:grid-cols-4`, L384) with TTFB; then `lg:grid-cols-[minmax(0,1fr)_340px]` — distribution on the start side, findings on the end side; `(الهاتف)(الحاسوب)` `Segmented` at the top. The optional PSI button (Phase 4) is **not rendered** unless the server says a key exists.

`DistributionBar`: `<div role="img" aria-label class="h-2 overflow-hidden rounded-full bg-surface-selected"><motion.div class="h-full bg-accent" initial={{width:0}} animate={{width:pct}} transition={m.spring('ui')}/></div>`; bucket words `text-success / text-warning / text-danger` beside each bar. No `stroke-*` classes (they do not exist).

### 3.8 Staff (`store/staff`, `staff/StaffSection.tsx`, Phase 3, owner only)

**360** = the 1280 table as `DataList` cards.
**1280**
```
│ الفريق                                                          [＋ دعوة عضو]  │
│ ┌──────────┬───────────────┬────────────────┬──────────────┬──────┐            │
│ │ العضو    │ الدور          │ الحالة         │ انضم          │      │ DataList   │
│ │ ▣ أنت    │ المالك         │ —              │ —             │      │            │
│ │ ▣ حسن    │ مدير  ▾        │ نشط            │ 2026-09-12    │ ⋯    │ ⋯ role/remove│
│ │ ▣ ريم    │ موظف  ▾        │ بانتظار القبول │ —             │ ⋯    │ ⋯ resend/cancel│
│ └──────────┴───────────────┴────────────────┴──────────────┴──────┘            │
│ ماذا يستطيع كل دور؟   (static matrix from GET /api/merchant/staff/roles)         │
│ الطلبات والرسائل ✓ ✓ ✓ · المنتجات والمخزون ✓ ✓ المخزون فقط · الكوبونات والعملاء ✓ ✓ — │
│ التحليلات ✓ قراءة — · الأرباح والسحب ✓ — — · التصميم والإعداد ✓ — — · الفريق ✓ — —   │
```
Invite = `usePrompt()` (`ui/PromptDialog.tsx:209`) asking for an existing account's phone or e-mail (answer is only found / not found); role = `Select` (`ui/Field.tsx:138`); remove = `useConfirm` destructive.

---

## 4) Feature list — EXISTS / EXTEND / NEW (files, routes, migrations, refusal codes)

Refusal helpers: `new HttpError(status, msg, 'CODE')`, `badRequest/conflict/forbidden/notFound` (`worker/lib/http.ts` — in churn; only used, not edited). Existing codes reused: `ORDER_TRANSITION_INVALID`, `ORDER_CHANGED` (merchant.ts:1176,1195), `STORE_PAUSED / STORE_SUSPENDED / MERCHANT_SUSPENDED` (merchantAuth.ts:191-200), `SEARCH_QUERY_TOO_LONG` (merchantWorkspace.ts:330), `BAD_KIND` (merchantInbox.ts:53).

### 4.1 Today
| Item | Status | Where / how |
|---|---|---|
| Queue, problems, setup, week figures | EXISTS | `CommandCenter.tsx`; attention `merchantWorkspace.ts:142-302`; `shell/kpis.ts:36` |
| Sub-rows (`orders.first[]`, `inbox.first[]`, `stock.first[]`, ≤2 each) | EXTEND | new `source()` fields (`merchantWorkspace.ts:88-97` wrapper) in the same read; `shell/attention.ts` types |
| Confirm / restock from the row | EXISTS routes | `POST /orders/:id/status` (merchant.ts:1160); `PATCH /products/:id` (merchantCatalog.ts:824, `requireSellingPrivileges`) |
| Status strip: `open_now`, `next_change_at`, `away_until`, `away_message` | NEW lib + EXTEND `/me` | `worker/lib/storeHours.ts` `openNow(business_hours, away_until, nowMs)` in Baghdad time (`worker/lib/baghdadTime.ts:86,125`), added to `storePublicShape` (merchant.ts:71) and `publicStore` (storefront.ts:59) |
| Pulse row | NEW UI | reads `/me` (open), attention `store.problems` (`layout_unpublished`), attention `speed` (Phase 2 source) |
| `vacation_over` problem | EXTEND | `StoreProblem` unions (`merchantWorkspace.ts:73-81`, `shell/attention.ts:44-51`); only when `away_until < now` and `away_message` still set — a nudge, never the mechanism |
| `returns` attention source (count of open returns on this merchant's orders) | NEW source | read from the returns tables `returns.ts` writes; decisions stay `requireAdmin` (returns.ts:571,602) |
| Dock | EXISTS doors | `merchantHref.newProduct()` (L143), design, settings; reel gated by `GET /api/community/access` |

### 4.2 Orders
| Item | Status | Where / how |
|---|---|---|
| `?q=` (order id prefix, customer name; phone digits ≥4 matched but never returned) | EXTEND `GET /api/merchant/orders` (merchant.ts:1018) | reuse `likePattern` (`sqlLike.ts:53`) + `phoneDigits` (`merchantWorkspace.ts:317`) + `rateLimit` as `merchantInbox.ts:54-55`; `SEARCH_QUERY_TOO_LONG` |
| Bulk status | NEW `POST /api/merchant/orders/bulk-status {ids[≤50], status, tracking_no?}` in `merchantOrders.ts` | the single transition repeated (`MERCHANT_ORDER_FLOW` L1127, history + `notifyOrderStatus` + `announceStoreOrder` per id); cancellation excluded; returns `{done[], refused[{id, code}]}`; refusals `BULK_TOO_MANY`, `BULK_CANCEL_NOT_ALLOWED`, per-row `ORDER_TRANSITION_INVALID`/`ORDER_CHANGED` |
| Tracking number on ship | EXTEND `POST /orders/:id/status` | accept `tracking_no` (≤60) when `to==='shipped'` → `orders.delivery_tracking_no` (0028:35) + `order_status_history.note` (0028:70); customer tracker already returns it as `tracking_no` (orders.ts:718, 5141). **No new column** |
| Internal note | NEW column `orders.merchant_note TEXT NOT NULL DEFAULT ''` (0156) + `PATCH /api/merchant/orders/:id/note` (≤1000) | never selected in `worker/routes/orders.ts`; test `merchantNoteNeverLeaks.test.ts`; `NOTE_TOO_LONG` |
| CSV export | NEW `GET /api/merchant/orders/export.csv?status&from&to` | `worker/lib/csv.ts` `csvResponse(rows, filename)` wrapping `toCsv` (`importCsv.ts:182`) + BOM + `Content-Disposition`, lifted from `merchantCatalog.ts:407-412`; ≤5,000 rows |
| Merchant invoice | EXTEND `worker/routes/invoices.ts` `loadAuthorized` (L63-73) | also authorise when `orders.merchant_id = storeForUser(...).merchant.id`; button beside the slip (`OrderDetailScreen.tsx:166-169`) |
| Batch packing slips | EXTEND `orders/orderPrint.css` pattern | print-only list of N slips from the selection; no server work |
| Orders list on `DataList` | NEEDS REFACTOR → NEW `orders/OrdersList.tsx` | retires `SalesTabs.OrdersTab` (L110) for this section; CSS payback |
| Spine | EXTEND `OrderDetailScreen.tsx:233-240` | classes §3.4 |
| Returns card + `orders?returns=1` chip | EXTEND | read-only; «القرار عند Levonis» |

### 4.3 Inbox and replies
| Item | Status | Where / how |
|---|---|---|
| Thread inside the workspace | NEEDS REFACTOR `src/pages/Chat.tsx` → `src/components/chat/ChatThread.tsx` + NEW `shell/sections/ThreadScreen.tsx` | `routeTable.ts:49` stops `away` for `inbox`+id; move pin `merchantWorkspaceShell.test.ts:119`; fix `formatMsgTime` `'ku'`→`'ckb'` (`Chat.tsx:70`); `MerchantInbox.tsx:179,220` rows become `Link`s to `merchantHref.thread(id)` (and drop the `useMainSiteHref` import from `dashboard/ui.tsx` L29) |
| Saved replies | NEW table (0156) `merchant_quick_replies(id TEXT PK, store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, created_at, updated_at)` + `idx_quick_replies_store(store_id, sort_order)`; NEW `worker/routes/merchantQuickReplies.ts` mounted at `/api/merchant/quick-replies` (`GET`, `POST`, `PATCH /:id`, `DELETE /:id`, `PUT /order`); composer read `GET /api/chats/:id/quick-replies` (store side only, participant check as `chats.ts:626` does) | cap 20 × (title ≤40, body ≤500); `QUICK_REPLY_LIMIT`, `QUICK_REPLY_NOT_FOUND`; **no auto-send, no greeting, no away auto-reply** (that would be a bot — refused). `chats.ts` and `worker/index.ts` are in churn: the composer read and the mount land after the community merge |
| Away message in the thread header | EXTEND `chats.ts:665-673` store block (`open`) with `away_message`, `away_until`, `open_now` | `Chat.tsx:652-664` shows it above the composer for the customer; the merchant sees a reminder chip |
| «Usually replies within» | MISSING, deferred to Phase 4 | `response_minutes: null` (`printMatchingStore.ts:371`); only from a measured median over ≥10 first replies |

### 4.4 Hours, vacation, status (read-time rule — systems-first graft)
| Item | Status | Where / how |
|---|---|---|
| Hours rows | EXISTS | `sanitizeHours` (merchant.ts:723-739, called L345); card `StoreSettingsTab.tsx:463` (its Sorani «کاتژمێرەکانی کار» is real) |
| `openNow()` | NEW `worker/lib/storeHours.ts` (pure, unit-tested) | exposed through `/me`, `/api/storefront/:slug`, chat thread |
| Vacation | NEW columns (0156) `merchant_stores.away_until TEXT NULL`, `away_message TEXT NOT NULL DEFAULT ''`; `PATCH /store` sanitises (ISO day ≥ today ≤ +180 d, message ≤200) | **rule**: `storeTakesOrders` (`storeOrderOps.ts:135`) returns `{ok:false, reason:'store_away'}` while `away_until > now` — new member of `StoreClosedReason` (L104-111), rendered by the storefront and the cart; `requireSellingPrivileges` also refuses `STORE_AWAY` for new commitments. The store reopens by itself; `vacation_over` only asks to clear the message. `AWAY_UNTIL_INVALID` |

### 4.5 Customers (CRM without broadcasts)
| Item | Status | Where / how |
|---|---|---|
| List / detail | EXISTS | `merchantCustomers.ts:65,137` (key = first-order id, header L5-19); `customers/CustomerList.tsx`, `CustomerDetailView.tsx` |
| Segments | EXTEND `GET /customers?segment=repeat|new30|quiet60|top` | SQL over `orders`; no table |
| Notes and tags | NEW table (0156) `merchant_customer_notes(store_id, customer_key TEXT, note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', updated_at, PRIMARY KEY(store_id, customer_key))`; `GET/PUT /api/merchant/customers/:key/notes` | note ≤1000, ≤8 tags × 20; never in any customer payload; `NOTE_TOO_LONG`, `TAGS_TOO_MANY` |
| Customers CSV | NEW `GET /api/merchant/customers/export.csv` (no phone, no user id) | `csv.ts` |
| Broadcasts | **Not built** (new outbound system; spam vector) | stated in DECISIONS row |

### 4.6 Marketing
| Item | Status | Where / how |
|---|---|---|
| Coupons | EXISTS | merchant.ts:1741-1827; validation `storeOrders.ts:202-231` |
| Scope + per-customer limit | NEW columns (0157) `merchant_coupons.scope_json TEXT NOT NULL DEFAULT '{}'` (`{product_ids?:[≤50], collection_id?}`), `per_customer_limit INTEGER NULL` | validated at quote **and** place-order in `storeOrders.ts` (count prior `orders.coupon_code` for this user); `COUPON_SCOPE_TOO_MANY`, `COUPON_NOT_FOR_THESE_ITEMS`, `COUPON_PER_CUSTOMER_EXHAUSTED`. No `auto=1` rows: `code TEXT NOT NULL UNIQUE(store_id, code)` (0036:92,104) makes code-less rules a schema fight — auto-apply is **not** proposed |
| Announcement bar | NEW layout key `StoreLayout.announcement?` (`packages/storeLayout/src/schema.ts:54-61`; allow-list `normalize.ts:491` gains `'announcement'`; `{text:{ar,en,ckb}, link?: LinkTarget (refs.ts:99 LINK_ROUTES), tone:'accent'|'neutral', from?, until?}`); edited through the existing `PUT /draft` + `POST /publish` (storeLayout.ts:336,385) | storefront paint in `StoreHeader.tsx` (≈300 B of the ~0.8 KB storefront closure) is the **builder track's**; The Counter owns the `AnnouncementSheet` and the dock door; dates checked server-side at publish read |
| Marketing kit | EXISTS `share/ShareStore.tsx:55` (link, share, QR, unfurl, icon) | EXTEND Phase 4: A5 print sheet via the `orderPrint.css` technique |
| Custom domain | MISSING by decision (DECISIONS row 12, `MERCHANT_PLATFORM.md:64`) | one honest «قريبًا» line stays |

### 4.7 SEO
| Item | Status | Where / how |
|---|---|---|
| Auto title/description/OG | EXISTS | `worker/lib/socialPreview.ts:469 resolveStorePreview`, `seo.ts` |
| Editable fields | NEW columns (0157) `merchant_stores.seo_title TEXT NOT NULL DEFAULT ''` (≤70), `seo_description` (≤160), `og_image_key TEXT NULL` (validated by `ownedMediaKey`, `mediaRefs.ts:51`) | `PATCH /store` allow-list; `resolveStorePreview` prefers them; SEO card reuses the ShareStore unfurl preview; `SEO_TITLE_TOO_LONG`, `SEO_DESCRIPTION_TOO_LONG`, `OG_IMAGE_NOT_OWNED` |
| Free-form pages | Deferred — builder track's addressed views | — |

### 4.8 Speed report («قياس سرعة موقعي»)
| Item | Status | Where / how |
|---|---|---|
| Real-user vitals | NEW: client `src/lib/storeVitals.ts` (≈1 KB gz, `PerformanceObserver` for LCP / CLS / INP / TTFB) dynamically imported from `Storefront.tsx` / `StorefrontProduct.tsx` **after first paint on store pages** (never in the storefront static closure, `bundleBudget.test.ts:331-338`); posts `{event:'vitals', store, lcp_ms, cls_x1000, inp_ms, ttfb_ms, dev}` through the existing beacon (`storeBeacon.ts` → `POST /api/storefront/events`, `worker/index.ts:467`), same DNT/GPC opt-out (`storeBeacon.ts:24-27`), same bot filter (`storefrontAnalytics.ts:63`, which already ignores `pagespeed|lighthouse`) | server: `STOREFRONT_EVENTS` (`storefrontAnalytics.ts:45`) + `StoreEvent` (`storeBeacon.ts:18`) gain `'vitals'`; because `storefront_event_marks.event` is `CHECK`-constrained (0125:91) the dedupe uses **its own table** |
| Tables (0157) | NEW `merchant_store_vitals_daily(store_id, day, device CHECK(device IN ('phone','desktop')), samples INTEGER, lcp_good, lcp_ni, lcp_poor, inp_good, inp_ni, inp_poor, cls_good, cls_ni, cls_poor, ttfb_good, ttfb_ni, ttfb_poor, PRIMARY KEY(store_id, day, device)) WITHOUT ROWID`; `merchant_store_vitals_marks(store_id, day, visitor, PRIMARY KEY(store_id, day, visitor)) WITHOUT ROWID`, swept with the daily salt sweep on the 15-minute cron (`wrangler.jsonc:206`) | buckets = PSI thresholds (LCP 2.5/4 s, INP 200/500 ms, CLS 0.1/0.25, TTFB 0.8/1.8 s); p75 = the bucket holding the 75th percentile, reported as a **word**, never an interpolated number; ≥50 samples or the collecting copy |
| Report | NEW `GET /api/merchant/analytics/speed?days=28` in `merchantAnalytics.ts` | also returns `findings[]` from the **published** layout + `file_objects.byte_size/mime` (0068:11): first-screen media bytes, GIF count/bytes, video count/bytes/autoplay, `MAX_BLOCKS` (schema.ts:64) use; each `{code, bytes, door}` |
| Attention `speed` source | NEW source (Phase 2) | `{grade:'good'|'ni'|'poor', samples}` for the Pulse line |
| PSI run | NEW, **Phase 4, optional** `POST /api/merchant/analytics/speed/psi` from the Worker (browser `connect-src` blocks it, `securityPolicy.ts:139`), `PSI_API_KEY` secret, 1 run / store / day, table `merchant_store_psi_runs` (0158) | rendered only when `/me.can.psi` is true (rule 13); DECISIONS row |

### 4.9 Integrations
| Item | Status | Where / how |
|---|---|---|
| Telegram / WhatsApp / e-mail outbound | EXISTS (`merchantNotify.ts:258-275`; switches `MerchantNotificationPreferences.tsx:84-90`) | EXTEND UI only: «القنوات» card at the top of Notifications (linked / not linked + door to main-site settings); no bot, no ordering over WhatsApp |

### 4.10 Staff and roles (Phase 3)
| Item | Status | Where / how |
|---|---|---|
| Members | NEW table (0158) `merchant_store_members(store_id REFERENCES merchant_stores ON DELETE CASCADE, user_id REFERENCES users ON DELETE CASCADE, role CHECK(role IN ('manager','staff')), invited_by, invited_at, accepted_at NULL, revoked_at NULL, PRIMARY KEY(store_id, user_id))` + partial index `(user_id) WHERE revoked_at IS NULL`; NEW `worker/routes/merchantStaff.ts` (`GET/POST /api/merchant/staff`, `PATCH/DELETE /:userId`, `GET /roles` — owner only; `POST /accept` — member); invite by existing account (found / not found only); max 5 | `STAFF_LIMIT`, `STAFF_NOT_FOUND`, `STAFF_ALREADY_MEMBER`, `FORBIDDEN` for non-owners; the accept lands as a `user_notifications` row (existing table), no new auth flow, no `/merchant/join` route in `App.tsx` |
| Auth | EXTEND `worker/lib/merchantAuth.ts`: add `storeForMember(db, userId)` and `requireStoreAccess(c, need)`; `storeForUser` (L122-134) and `requireStoreOwner` (L164-172) **unchanged** and remain the only gate for money, payouts, settings, slug, delivery, design publish, staff, coupon create, exports of money/customers | `/me` returns `role` and `granted: Capability[]`; notifications keep going to the owner (members see the bell filtered by kind in `merchantNotifications.ts:58-87`); audit line from `order_status_history.changed_by` (0028:69) — no `actor_user_id` column |
| Route-gate enumeration test | NEW `tests/merchantRouteGates.test.ts` | asserts, per route file, which gate each route calls |

---

## 5) Motion spec (every spring via `useMotion()`, `src/lib/motion.ts:127-143`; `m = useMotion()`)

| # | What moves | Spring | Property | Reduced motion (`spring()` → `CROSS_FADE` automatically; `travel()` → 0) |
|---|---|---|---|---|
| 1 | Seam — sidebar and phone tabs (`layoutId` per surface) | `move` | shared-layout move of the gold hairline | cross-fade |
| 2 | Section arrives (`Suspense key={section}` wrapper, L292) | `ui` | `opacity 0→1`, `x: m.inline(12)→0` (forward along the inline axis) | opacity only |
| 3 | Badge count changes (`CountBadge` L326) | `quick` | `key={n}`: `scale .6→1`, opacity | opacity |
| 4 | Queue ticket leaves after its action succeeds | `ui` | `motion.li layout` + `AnimatePresence` exit `{height:0, opacity:0}` | cross-fade |
| 5 | Tray appears on first selection | `ui` | `y: m.travel(16)→0`, opacity | opacity |
| 6 | Spine node of the step just completed | `quick` | `scale 0→1` | opacity |
| 7 | Order status chip after a move | `quick` | `key={status}` scale/opacity | opacity |
| 8 | DistributionBar fills once on data | `ui` | inline `width 0→n%` | set immediately |
| 9 | Sheets (restock, tracking, replies, announcement, invite) | built into `Sheet` v2 (`sheet`) | detents, rubber-band | primitive's |
| 10 | Saved-reply reorder | `Reorder.Group` + `MotionConfig reducedMotion="user"` (`storeDesign/BlockList.tsx:88` pattern) | drag on y | up/down buttons always present |
| 11 | Status strip switch | built into `Switch` | — | — |
| 12 | Skeleton → content | `CROSS_FADE` (150 ms) | opacity | same |
| 13 | Press feedback | CSS base `:active` dim (`index.css:633`); `press-scale` (`index.css:661`) only on chips and dock doors | — | — |

Forbidden (docs/MOTION.md §2, §8; `tests/communitySocialUi.test.ts:119-135` pattern copied to `tests/workspaceUi.test.ts`): `transition={{duration}}` outside `CROSS_FADE`, `AnimatedItem`, decorative stagger, parallax, the status-pill pulse, autoplaying media in the workspace, any `letter-spacing` on Arabic.

---

## 6) Theming and CSS-budget strategy

Measured: **11 B of CSS headroom** (61,429 / 61,440, level 9); storefront closure ≈0.8 KB; shell closure ≈1.3 KB; order screen 12 KB pin; analytics 16 KB pin. The Counter must be CSS-net-negative in every PR.

**Rules for every new file**
1. No class that is not already in `dist/assets/index-CUZYPlyH.css` (check `grep -cF '.<escaped-class>' dist/assets/index-*.css`). The anatomy in §3 uses only verified classes; in particular the **`text-[…px]` sizes, not `text-ui-*`** (not emitted).
2. One-offs (bar widths, `grid-template-columns` variants that do not exist, `bottom` offsets) are inline `style`.
3. No new `@layer components` rule, no new `@utility`, no raw palette class (`zinc-*`, `white/…`, `red-*`, hex), no `dark:` (`tests/themeSystem.test.ts` no-hex/no-dark rule).
4. Every new screen is `React.lazy` and listed in `WORKSPACE_SCREENS` (`bundleBudget.test.ts:362-368`): `OrdersList`, `ThreadScreen`, `SpeedReport`, `StaffSection`, `SavedRepliesSheet`, `AnnouncementSheet`, `RestockSheet`.
5. Frame edits are §3.1 only; the strip, pulse, sub-rows and dock live in the `CommandCenter` chunk.
6. Storefront: only the announcement bar (builder track, ≈300 B) touches the closure; `storeVitals.ts` is a dynamic import after first paint.

**Paybacks, in order of certainty** (measured in the budget test's own log)
- **P1 (Phase 0, first commit)** — `src/index.css:63` is a bare `@import "tailwindcss";`. Change to `@import "tailwindcss" source(none); @source "../src"; @source "../index.html"; @source "../packages/storeLayout/src";` so selectors generated from `docs/` and `worker/` text disappear. Zero visual change; `themeSystem.test.ts:23-27` (generated THEME TOKENS block) is untouched.
- **P2 (Phase 0-1)** — `OrdersList` on `DataList` retires the orders half of `SalesTabs.tsx` (50 raw + 1 hex, most of it in `OrdersTab`); `StoreSettingsTab.tsx` (75 raw) onto `Card`/`Field`/`Switch` with the Hours & Vacation card (Phase 1); `ReviewsSection.tsx` (7) and `MerchantInbox.tsx` (1) drop `dashboard/ui.tsx`; when `CatalogManager.tsx` and `workshop/reasons.ts` follow, `dashboard/ui.tsx`'s 39 raw classes + 1 hex leave the sheet.
- **P3 (later)** — `PrintersTab.tsx` (49 raw + 9 hex), `CostingTab.tsx` (27), `src/pages/MerchantStore.tsx` (49; still imported by `src/App.tsx` and `src/pages/Storefront.tsx` — coordinate with the storefront-cx track).

**Acceptance**: every PR prints the budget log; CSS total ≤ the previous commit's total; shell ≤ 25 KB, closure ≤ 32 KB; no `WORKSPACE_CLOSURE_BUDGET` raise.

---

## 7) Localisation plan

**Policy**: `docs/MERCHANT_PLATFORM.md:276-281` still says «never machine-written» and cites row 11 (referrals — drift); `docs/COMMUNITY_ECOSYSTEM.md:138` D6 allows real Sorani for community strings; `tests/merchantWorkspaceShell.test.ts:315-331` fails any `ckb` in `shell/**` that does not exist verbatim elsewhere in `src`; `uiPrimitives.test.ts` forbids invented Sorani in `ui/`.

**Mechanics**
1. All new words live in **`src/components/merchant/counter/strings.ts`** (outside `shell/` and `ui/`): `COUNTER_STRINGS = { ar, en, ckb }` with identical key sets, plus `useCounterStrings()` (pattern `community/social/strings.ts`). The shell may then copy any phrase verbatim, keeping its test green.
2. **`tests/workspaceStrings.test.ts`** modelled on `communitySocialUi.test.ts:75-100`: every key in all three; ≥90 % of ckb values contain Kurdish letters (ە ۆ ێ ڕ ڵ ڤ گ چ پ ژ ی ک); ≤10 % identical to ar; none identical to en.
3. A DECISIONS row (Q2) extends D6 to `src/components/merchant/counter/**`. Until it lands, the Arabic stands in under `// OWNER: Sorani to be written by hand.` and the test's Kurdish-letter assertion is the row's acceptance gate.
4. Phase 0 fixes the drift: `shell/strings.ts:4`, `MERCHANT_PLATFORM.md:279`, `hub/copy.ts:10` point at the OWNER-marker convention / D6 and the new row, not «row 11».
5. Counted nouns follow `src/components/community/hub/copy.ts` (1 / 2 / 3–10 / 11–99 / hundreds); Sorani counts with the bare noun; numbers stay LTR islands (`Money`, `<bdi>`, `tabular-nums`); Baghdad-time clock words come from the server's `next_change_at`.
6. New refusal codes get their sentences here too (not in `src/lib/refusalStrings.ts`, which is in churn) and are folded into that file after the community merge.

**The table** (↺ = already exists verbatim in `src`, usable by the shell today)

| Key | ar | en | ckb |
|---|---|---|---|
| generic.loading | جارٍ التحميل… | Loading… | بارکردن… ↺ |
| generic.retry | حاول مجددًا | Try again | دووبارە هەوڵ بدە ↺ |
| generic.error | حدث خطأ. حاول مجددًا. | Something went wrong. Try again. | هەڵەیەک ڕوویدا. دووبارە هەوڵ بدە. |
| generic.saved | حُفظ | Saved | پاشەکەوت کرا ↺ |
| generic.noResults | لا نتائج | No results | هیچ ئەنجامێک نییە |
| mode.operate / mode.design | تشغيل / تصميم | Operate / Design | کارپێکردن / دیزاین |
| today.loading | جارٍ عدّ ما ينتظرك… | Counting what is waiting… | ئەوەی چاوەڕوانتە دەژمێردرێت… |
| today.empty | لا شيء ينتظرك الآن. الطلبات والرسائل والمخزون كلها في حالها. | Nothing is waiting for you right now. Orders, messages and stock are all in hand. | ئێستا هیچ شتێک چاوەڕوانت نییە. داواکاری و نامە و کۆگا هەموو لە جێی خۆیاندان. |
| today.error | تعذّر عدّ ما ينتظرك. | What is waiting could not be counted. | نەتوانرا ئەوەی چاوەڕوانتە بژمێردرێت. |
| today.rowDone | تم — خرج من القائمة | Done — off the list | تەواو — لە لیستەکە دەرچوو |
| pulse.title | نبض المتجر | Store pulse | لێدانی فرۆشگا |
| status.openNow | مفتوح الآن · يغلق {time} | Open now · closes {time} | ئێستا کراوەیە · {time} دادەخرێت |
| status.closedNow | مغلق الآن · يفتح {day} {time} | Closed now · opens {day} {time} | ئێستا داخراوە · {day} {time} دەکرێتەوە |
| status.away | في إجازة حتى {date} | Away until {date} | لە پشوودایە تا {date} |
| status.vacationOver | انتهت إجازتك — امسح رسالة الغياب؟ | Your vacation is over — clear the away message? | پشووەکەت تەواو بوو — پەیامی نەبوون بسڕیتەوە؟ |
| status.unpublished | تعديلات محفوظة لم تُنشر | Saved changes not yet published | گۆڕانکاری پاشەکەوتکراو بڵاونەکراوەتەوە |
| orders.loading | جارٍ تحميل الطلبات… | Loading orders… | داواکارییەکان بار دەکرێن… |
| orders.emptyFilter | لا طلبات بهذا الفلتر | No orders match this filter | هیچ داواکارییەک بەم فلتەرە نییە |
| orders.emptySearch | لا نتائج لـ «{q}» | No results for “{q}” | هیچ ئەنجامێک بۆ «{q}» نییە |
| orders.error | تعذّر تحميل الطلبات. | Orders could not be loaded. | داواکارییەکان بار نەکران. |
| orders.selected | {n} محددة | {n} selected | {n} هەڵبژێردراوە |
| orders.bulkDone | حُدّثت {n} طلبات | {n} orders updated | {n} داواکاری نوێکرایەوە |
| orders.bulkPartial | حُدّثت {n}، وتعذّر {m} — الطلب تغيّر قبلك | {n} updated, {m} refused — the order changed before you | {n} نوێکرایەوە، {m} ڕەتکرایەوە — داواکارییەکە پێش تۆ گۆڕا |
| orders.trackingLabel | رقم التتبع (اختياري) | Tracking number (optional) | ژمارەی بەدواداچوون (ئارەزوومەندانە) |
| orders.trackingSaved | حُفظ رقم التتبع وسيراه الزبون. | Tracking number saved; the customer will see it. | ژمارەی بەدواداچوون پاشەکەوت کرا و کڕیار دەیبینێت. |
| orders.noteLabel | ملاحظة داخلية — لا يراها الزبون | Internal note — the customer never sees it | تێبینی ناوخۆیی — کڕیار نایبینێت |
| orders.exportReady | جاهز: {n} طلبًا في الملف | Ready: {n} orders in the file | ئامادەیە: {n} داواکاری لە فایلەکەدا |
| orders.nextStep | الخطوة التالية | Next step | هەنگاوی داهاتوو |
| returns.adminDecides | القرار في المرتجعات عند Levonis؛ هنا ترى الحالة. | Levonis decides returns; here you see the state. | بڕیاری گەڕاندنەوە لای Levonis‌ـە؛ لێرە دۆخەکە دەبینیت. |
| inbox.threadLoading | جارٍ فتح المحادثة… | Opening the conversation… | گفتوگۆکە دەکرێتەوە… |
| inbox.threadMissing | هذه المحادثة ليست لمتجرك. | This conversation is not your store's. | ئەم گفتوگۆیە هی فرۆشگاکەت نییە. |
| replies.title | الردود المحفوظة | Saved replies | وەڵامە پاشەکەوتکراوەکان |
| replies.empty | لا ردود محفوظة بعد. اكتب ردًا تكرره كثيرًا واحفظه هنا. | No saved replies yet. Write a reply you send often and keep it here. | هێشتا هیچ وەڵامێکی پاشەکەوتکراو نییە. وەڵامێک کە زۆر دەینێریت لێرە پاشەکەوتی بکە. |
| replies.saved | حُفظ الرد | Reply saved | وەڵامەکە پاشەکەوت کرا |
| replies.limit | الحد 20 ردًا محفوظًا | Up to 20 saved replies | زۆرترین ٢٠ وەڵامی پاشەکەوتکراو |
| replies.inserted | أُدرج في الرسالة — عدّله ثم أرسل | Inserted — edit, then send | خرایە ناو نامەکە — دەستکاری بکە پاشان بنێرە |
| hours.title | ساعات العمل والإجازة | Hours and vacation | کاتژمێری کار و پشوو |
| hours.awayMessageLabel | رسالة الغياب | Away message | پەیامی نەبوون |
| hours.awayHint | تُعرض رسالتك في المحادثة وصفحة المتجر أثناء الإجازة. | Shown in chat and on your store page while you are away. | لە کاتی پشوودا لە گفتوگۆ و پەڕەی فرۆشگاکەت پیشان دەدرێت. |
| hours.pauseDuring | لا تُستقبل طلبات جديدة أثناء الإجازة ويعود المتجر تلقائيًا. | No new orders while away; the store reopens by itself. | لە کاتی پشوودا داواکاری نوێ وەرناگیرێت و فرۆشگاکە خۆکارانە دەکرێتەوە. |
| ledger.howCustomerReads | كيف يقرؤها الزبون: | How the customer reads it: | کڕیار چۆن دەیخوێنێتەوە: |
| customers.notesEmpty | لا ملاحظات عن هذا العميل | No notes about this customer | هیچ تێبینییەک لەسەر ئەم کڕیارە نییە |
| customers.segmentEmpty | لا عملاء في هذه الفئة بعد | No customers in this group yet | هێشتا هیچ کڕیارێک لەم گروپەدا نییە |
| seo.preview | هكذا يظهر متجرك عند مشاركته | How your store looks when shared | فرۆشگاکەت کاتی هاوبەشکردن بەم شێوەیە دەردەکەوێت |
| announce.empty | لا شريط إعلان الآن | No announcement bar right now | ئێستا هیچ شریتی ڕاگەیاندنێک نییە |
| announce.published | نُشر الشريط | The bar is live | شریتەکە بڵاوکرایەوە |
| speed.tab | السرعة | Speed | خێرایی |
| speed.collecting | نجمع قياسات زوّارك الحقيقيين. تظهر النتيجة بعد {n} زيارة. | Collecting measurements from your real visitors. The result appears after {n} visits. | پێوانەکانی سەردانکەرە ڕاستەقینەکانت کۆدەکرێنەوە. ئەنجام دوای {n} سەردان دەردەکەوێت. |
| speed.good / speed.ni / speed.poor | جيد / متوسط / ضعيف | Good / Needs work / Poor | باش / مامناوەند / لاواز |
| speed.slows | ما يُثقل صفحتك | What weighs your page down | چی پەڕەکەت قورس دەکات |
| speed.findingCover | صورة الغلاف {size} — أثقل شيء في صفحتك | Your cover is {size} — the heaviest thing on your page | وێنەی بەرگەکەت {size}ـە — قورسترین شتی پەڕەکەت |
| speed.findingGif | {n} صور GIF ({size}) — استبدلها بفيديو MP4 قصير | {n} GIFs ({size}) — replace them with a short MP4 | {n} وێنەی GIF ({size}) — بە ڤیدیۆیەکی کورتی MP4 بیانگۆڕە |
| speed.findingVideos | {n} فيديوهات في أول شاشة — اجعل واحدًا فقط يُشغَّل تلقائيًا | {n} videos above the fold — autoplay only one | {n} ڤیدیۆ لە یەکەم شاشەدا — تەنها یەکێکیان خۆکار لێبدە |
| speed.how | نقيس من متصفحات زبائنك أنفسهم، بلا أي تعريف شخصي. | Measured in your own customers' browsers, with no personal identification. | لە وێبگەڕی کڕیارەکانی خۆتەوە دەپێورێت، بەبێ هیچ ناسینەوەیەکی کەسی. |
| speed.error | تعذّر قراءة القياسات. | Measurements could not be read. | پێوانەکان نەخوێندرانەوە. |
| channels.title | القنوات | Channels | کەناڵەکان |
| channels.linked / notLinked | مرتبط / غير مرتبط | Linked / Not linked | بەستراوە / نەبەستراوە |
| staff.empty | أنت وحدك في المتجر. أضف من يساعدك في الطلبات والرسائل. | It is just you in the store. Add someone to help with orders and messages. | تەنها تۆیت لە فرۆشگاکەدا. کەسێک زیاد بکە بۆ یارمەتی لە داواکاری و نامەکان. |
| staff.inviteSent | أُرسلت الدعوة | Invitation sent | بانگهێشتەکە نێردرا |
| staff.notFound | لا حساب بهذا الرقم أو البريد | No account with that phone or email | هیچ هەژمارێک بەم ژمارە یان ئیمەیڵە نییە |
| staff.ownerOnly | هذا الإجراء للمالك فقط | Only the owner can do this | ئەمە تەنها بۆ خاوەنەکەیە |
| staff.removeQ | إزالة {name} من الفريق؟ | Remove {name} from the team? | {name} لە تیمەکە لاببرێت؟ |
| staff.removeConsequence | يفقد الوصول فورًا. ما سجّله من تغييرات يبقى. | Access ends immediately. Their recorded changes remain. | دەستپێگەیشتنی دەستبەجێ کۆتایی دێت. گۆڕانکارییە تۆمارکراوەکانی دەمێننەوە. |
| staff.moneyNote | الأرباح والتحويلات تبقى لك وحدك. | Earnings and payouts stay yours alone. | قازانج و گواستنەوەکان تەنها بۆ تۆ دەمێننەوە. |

`section.failed` already exists in ar/en/ckb in `src/components/ChunkBoundary.tsx:48`.

---

## 8) Accessibility checklist

- [ ] Every Seam keeps `aria-current="page"` on the link; the hairline is `aria-hidden` decoration on top of state.
- [ ] Badge counts are in the accessible name («الطلبات (3)», as `NavLink` does), never colour alone.
- [ ] Every action row is a real link via `Door` (`CommandCenter.tsx:127`); sub-row actions are `Button` with press guard and `loading`; ≥44 px via `lv-button` (`index.css:402` min-block-size) or `lv-hit` (`index.css:331`).
- [ ] After a queue action succeeds focus moves to the next row's primary button; when the list empties, to the h2 «بانتظارك».
- [ ] Status strip `Switch` has `label` and `description` (the open/closed sentence); the change announces through `toast` (`Toaster` `aria-live`, shell L318).
- [ ] Tray: `role="toolbar"` + `aria-label`, count `aria-live="polite"`, Escape clears the selection, in flow above `--shell-bottom-inset` (never covers the last row).
- [ ] `DataList` rows carry `rowLabel` («طلب #A1F3 لنور محمد»); selection checkboxes are labelled per row.
- [ ] Spine: `<ol>` with the step state in words («تم», «التالي»), the next action a real `<button>`; the tracking field is a labelled `Field`.
- [ ] Sheets through `Sheet` v2 (focus trap, restore, Escape, `label`/`labelledBy`); no native `confirm/alert/prompt` (`merchantWorkspaceShell.test.ts:310-313`).
- [ ] Segmented filters are radiogroups with arrow keys, unique `group` per screen (`orders-status`, `speed-device`, `ws-mode`).
- [ ] Section change moves focus to the `h1` (or the frame title for `ownHeading`); the skip link stays first (shell L243).
- [ ] Reduced motion → cross-fades by `useMotion()`; reduced transparency → solid `material` (`index.css:766-774`); reorder always has up/down buttons.
- [ ] Focus rings on every new interactive element (`focus-visible:ring-2 focus-visible:ring-focus`, `lv-button`, `lv-input`, `lv-choice`; `uiPrimitives.test.ts:339-350`).
- [ ] Colour never carries meaning alone: chips have words, speed buckets have words beside the bar, `DistributionBar` has `role="img"` + `aria-label` («71% جيد، 19% متوسط، 10% ضعيف»); both themes ≥4.5:1 (`themeSystem.test.ts:42-59`).
- [ ] Logical properties only; slides through `m.inline()`; chevrons `rtl:-scale-x-100`.
- [ ] Arabic/Kurdish: no `tracking-*`, no uppercase, leading ≥1.15; long English labels wrap; `min-w-0 truncate` only on one-line identifiers.
- [ ] Numbers, prices, tracking refs and slugs are LTR islands (`Money`, `<bdi>`, `Input ltr`).
- [ ] Print: slips and invoices use the `orderPrint.css` `aria-hidden` pattern so nothing prints twice.

---

## 9) Phased delivery (each phase ships alone and passes the pinned tests)

**Phase 0 — bytes, tidy-ups, the daily loop (no migration).**
`@source` restriction (P1) · hoist `CommandCenter.tsx:53-54` · fix the «row 11» citations (`shell/strings.ts:4`, `MERCHANT_PLATFORM.md:279`, `hub/copy.ts:10`) · shell motion (Seam, settle, badge) + Operate|Design `Segmented` + focus-to-h1 · Today v2 (status strip with server `open_now` from the new pure `storeHours.ts`, Pulse with open state + unpublished, sub-rows, act-on-row confirm/restock, dock) · `OrdersList` on `DataList` with `?q=`, bulk status, tracking on ship (existing column), CSV via `worker/lib/csv.ts` · `counter/strings.ts`.
Tests: `tests/workspaceStrings.test.ts`, `tests/workspaceUi.test.ts` (tokens only, `useMotion` required, no `duration`, no `fixed bottom-0`), `tests/storeHours.test.ts` (Baghdad day boundaries, overnight hours, no hours = «حسب الاتفاق»), `tests/merchantOrdersBulk.test.ts` (cap 50, cancellation refused, partial results), `merchantOrderStatus.test.ts` extended for `tracking_no`; budget log shows CSS ≤ previous and shell/closure under 25/32 KB; `merchantWorkspaceShell.test.ts` untouched except the frame-motion pin added.

**Phase 1 — answer without leaving; the store's promises (0156: `orders.merchant_note`, `merchant_stores.away_until/away_message`, `merchant_quick_replies`, `merchant_customer_notes`).**
`ChatThread` extraction + `ThreadScreen` (routeTable stops `away`; move pin L119) · master–detail inbox at ≥1280 · saved replies (routes + sheet + composer bar; the `chats.ts` read and the `index.ts` mount land after the community merge) · `ku`→`ckb` fix · Hours & Vacation Ledger Card + read-time `store_away` rule + `vacation_over` nudge · Spine + internal note + merchant invoice + read-only returns card + `returns` attention source · customer notes/tags/segments · `StoreSettingsTab` onto `Card`/`Field` (P2 payback).
Tests: `tests/storeAvailability.test.ts` (checkout refused `store_away` while `away_until > now`, accepted after), `tests/quickReplies.test.ts` (cap, ownership, customer side never receives them), `tests/merchantNoteNeverLeaks.test.ts` (grep + payload), `tests/merchantInvoice.test.ts` (owner of the order's merchant only), `merchantInbox.test.ts` thread door, e2e thread smoke (`scripts/e2e-*.mjs` pattern), order-screen 12 KB pin.

**Phase 2 — see and steer (0157: SEO columns, coupon scope/limit, vitals tables).**
`storeVitals.ts` + `'vitals'` event + `merchant_store_vitals_daily/_marks` + `GET /analytics/speed` + page-weight findings + `analytics?view=speed` link tab + Pulse speed line + attention `speed` source · SEO card + `resolveStorePreview` preference · announcement layout key + `AnnouncementSheet` (storefront paint with the builder track) · coupon scope / per-customer limit with checkout tests · exports for customers, ledger, analytics · Channels card.
Tests: `tests/merchantSpeed.test.ts` (bucket maths, ≥50 rule, p75 as a word, dedupe by day, DNT respected, storefront closure unchanged), `tests/socialPreviewSeo.test.ts`, `tests/storeAnnouncement.test.ts` (normalize allow-list, dates), `tests/couponScope.test.ts` (quote and place-order agree), `merchantRoutes.test.ts` closed-query pin moved for `view`, analytics 16 KB pin.

**Phase 3 — the owner hires (0158: `merchant_store_members`).**
`storeForMember` + `requireStoreAccess` (opt-in per route) · `/me.role` + `granted[]` · `Capability` gating in `nav.ts` · `store_staff` section (`SECTION_PATHS`, `NAV`, `SECTIONS`, `SHAPE`, `WORKSPACE_SCREENS`) · `StaffSection` · member bell filtering · audit line «by {member}» from `changed_by`.
Tests: `tests/merchantRouteGates.test.ts` (enumerates every `/api/merchant/*` route and asserts owner-only lists: money, payouts, settings, slug, delivery, design publish, staff, coupon create, money/customer exports), `tests/merchantStaff.test.ts` (member sees only granted nav; owner-only routes refuse members 403; `storeForUser` untouched), **move** the pins at `merchantWorkspaceShell.test.ts:155,161,215`, `storefrontIsolation.test.ts` extended («nor who may act»).

**Phase 4 — optional, owner-gated.**
PSI run from the Worker (`PSI_API_KEY`, 1/day, DECISIONS row) · «usually replies within» from measured medians (≥10 samples) · A5 flyer print in `share/` · phone-tab change if Q1 is yes · custom domain stays «قريبًا».

---

## 10) Open owner questions

1. **Phone tabs**: keep `Overview · Orders · Products · Store` (pinned at `merchantWorkspaceShell.test.ts:156`, written in `MERCHANT_PLATFORM.md:194`) or move to `Today · Orders · Inbox · Products · More`? (Answering customers is the second daily verb; «Store» is weekly work.)
2. **Sorani scope**: extend D6 («real Sorani, no Arabic standing in») from community strings to `src/components/merchant/counter/**`, guarded by `workspaceStrings.test.ts`? Until then the Arabic stands in under the OWNER marker.
3. **Vacation semantics**: while `away_until > now`, should the store refuse new orders **by default** (the read-time rule proposed) or only show the message and keep selling unless the owner also pauses?
4. **Real-user vitals**: approve the privacy statement — daily buckets only, one sample per visitor per day, same DNT/GPC opt-out and salted visitor hash as the existing beacon, 28-day window, nothing shown under 50 samples?
5. **PageSpeed Insights**: provide a `PSI_API_KEY` (external Google call from the Worker, 1 run / store / day) or stay with real-user vitals + page-weight findings only?
6. **Staff role matrix** (§3.8): confirm manager (orders, inbox, catalogue, coupons, customers, analytics read) and staff (orders, inbox, stock only); owner-only money, payouts, settings, design, delivery, staff, slug; max 5 members; notifications stay with the owner?
7. **Merchant invoices**: may the store owner download the invoice document `invoices.ts` issues for a store order (customer/admin today)?
8. **Coupon scope / per-customer limit** in checkout (touches `storeOrders.ts`): approve; and confirm that automatic (code-less) promotions are **out** given `merchant_coupons.code NOT NULL UNIQUE(store_id, code)`.
9. **Announcement bar**: confirm it is a layout key (`StoreLayout.announcement`, published with the layout, painted by the builder track in `StoreHeader.tsx`) rather than a store-row column that bypasses publish.
10. **Bulk status notifications**: a bulk confirm of 50 orders fans out 50 customer notices and 50 chat cards, as single confirms do today — acceptable, or should bulk be capped lower (20)?
11. **Returns visibility**: show the merchant the open return's state and reason (read-only, decisions stay admin-only), or only the count?
12. **Custom domain**: DECISIONS row 12 stands («قريبًا», no UI) — confirm no change.

## 3. Track plan — storefront

# واجهة حيّة — The Living Storefront: the synthesised build plan (track «storefront»)

Ground truth: HEAD `b726a1c6`, `/home/user/Levonis`, read-only. Every path:line below was opened in this session. Latest migration on disk is **0155_community_comment_replay.sql**, so this track's migrations are **0156** and **0157** (renumber at merge if the community workflow moves). Measured today by `node --test tests/bundleBudget.test.ts` against the current `dist/`: storefront closure **46.2 KB of 47** (`Storefront` 6.2, `StorefrontProduct` 6.5, `attributes` 1.5, `governorates` 0.6, `profileIcons` 1.3, `storefrontApi` 0.6, two `theme-*` 3.0 + 3.9), CSS **61,361 B gz of 61,440** (79 B headroom; `index-*.css` 48,440, `Auth` 8,000, `theme` 1,535 + 1,261, others ≤ 649), `StoreDesignPanel` chunk 39.1 KB (limit 250), `extra` 8.3 KB, `tabViews` 5.9 KB.

## 0. What the winner absorbs from the judges (verified, not asserted)

| Correction / graft | Verified fact that settles it |
|---|---|
| Collection covers need **no migration** | `merchant_store_sections.image_key` exists (`migrations/0126_catalog_variants.sql:209-210`), is in the sweep registry (`worker/lib/mediaRefs.ts:316`), is PATCHable and returned as `image_url` (`worker/routes/merchantCatalog.ts:1194-1200`, `:1148`). The storefront read (`worker/lib/storeLayout.ts:275` selects no `image_key`) and `CollectionData` (`packages/storeLayout/src/data.ts:180-185`) are the only gaps. |
| Vitals get **their own tables** | `storefront_event_marks.event` is `CHECK (event IN ('visit','store_view','product_view','add_to_cart','checkout_started'))` (`0125_storefront_analytics.sql:91`). The beacon route parses **JSON** (`worker/routes/storefrontEvents.ts:93-98`), so the vitals beacon stays JSON, not `text/plain`. |
| `.sf-shelf` is at `theme.css:293`; `.sf-stack` at `:149`; `.sf-glow` at `:316-321` is `display` only — the blur lives in the `blur-[120px]` utility on `StoreRenderer.tsx:126` and stays | opened |
| Drop the invented `bytes/200KB/s + 0.9s` preview estimate | The speed tab shows measured first-screen bytes and real-visit buckets only (DECISIONS rows 100/111 spirit). |
| Perf-track items (#50 anonymous `/:slug` edge cache, #51 `?w=` renditions, #52 Range-from-cache, #53 review Range) leave Phase A | Coordination note in §9; prerequisites named. `uploads.ts:831-841` (Range bypasses the edge cache) is cited as a dependency, never edited here. |
| `checkMedia` at `communityPosts.ts:561-575` is **not** a media check (it is post-link ownership) | Showcase video ownership reuses the `verifyLayoutRefs` pattern: `ownedMediaKey` (`mediaRefs.ts:51`) + a `file_objects` mime lookup (`worker/lib/storeLayout.ts:510-521`). |
| `bg-accent/30`, `group-hover:opacity-100`, `bg-snow/30`, `text-snow/90`, `origin-[inline-start]`, `snap-y`, `aspect-[9/16]`, `max-h-[92dvh]`, `border-4` are **absent** from the built CSS | Checked `dist/assets/*.css`. Present: `[text-shadow:0_1px_8px_rgb(0_0_0/0.35)]`, `bg-black/60`, `bg-black/50`, `bg-white/20`, `bg-white/70`, `max-h-[88dvh]`, `h-dvh`, `press-scale`, `lv-bleed-scrim`, `material`, `material-thin`, `scroll-edge`, `pb-safe`, `hide-scrollbar`, `snap-start`, `size-11`, `text-snow/80`, `bg-danger`, `text-snow`, `border-s-2`, `bg-surface-selected`, `bg-gold`, `motion-reduce:transition-none`, `group-focus-visible:*`. Every anatomy below uses only the present set or inline `style`. |
| The chat-less direct request path must be explicit | Direct requests are created only by `POST /api/chats/:id/print-requests` (`worker/routes/chatCommerce.ts:152`; client `src/lib/chatCommerceApi.ts:67-68`). The store door therefore opens the store thread first (`POST /api/chats/open {merchantId}`, `chats.ts:553-560`, idempotent one-per-pair) and mounts `PrintRequestSheet` with that `chatId`. |
| «Ask about this product» needs **no new server verb** | A product card is sent as `POST /api/chats/:id/messages {card:{type:'product', ref}}` (`src/pages/Chat.tsx:361`; server `chats.ts:1038-1050`, `SENDABLE_CARDS = ['product','store']` in `worker/lib/chatCards.ts:53`). |
| Customer «placed» notice for **store** orders is missing | `notifyOrderPlaced` exists (`worker/lib/orderNotify.ts:229`) but is called only from the platform checkout (`worker/routes/orders.ts:4744`); `storeOrders.ts:1202-1207` tells only the merchant. `NOTIFIED_ORDER_STATUSES` (`orderNotify.ts:50`) is unrelated to this gap. |
| Sorani time bug | `src/pages/Chat.tsx:70` tests `lang === 'ku'`; the app's code is `'ckb'` (`src/LanguageContext.tsx:33-42` migrates `ku` → `ckb`), so Sorani times render `en-US`. |
| The Ribbon becomes the host's **one** app bar, not a second sticky layer | `StorefrontApp` (`src/App.tsx:402-445`) has `/cart`, `/orders`, `/orders/:id` routes and no cart/chat/quote/search entry; `StoreHeader.tsx:22-53` draws only Back and ⋯. With the `bar` header the controls are drawn **inside** the bar; with `overlay` they rise once the hero sentinel leaves, or immediately when the page is shorter than 1.5 viewports. Host-only (`NO_HOST` and the apex runtime render nothing — the apex has the app's Header/BottomNav). |
| Notice line in core `StoreHeader`, announcement block dropped | Keeps `tests/storefrontBlocks.test.ts:156` (`core == ['hero','products_grid','tabs']`) untouched and paints with the page. Registry goes 27 → **29** (`reels`, `lookbook`), lookbook last and budget-gated. |
| Autoplay citation | «video tap-to-play, never autoplay» is `docs/COMMUNITY_ECOSYSTEM.md:724` (678-682 is analytics copy); HOME_PLAN `:101`, `:161`. The viewer-only muted autoplay is DECISIONS row 168 before Phase C. |

---

## 1. Concept (three sentences)

The store page keeps its contract — layout schema v1, closed enums, dark grounds, the same renderer in the builder's 360/768/1280 canvas — and gains **media everywhere with a weight rule** (poster-first hero video, a dimmed page background, GIFs where an image goes, a notice line, footer links, collection covers, scheduled blocks, `max_bytes` on every media slot so an 8 MB GIF never ships to Iraq), a **reels door** (showcase clips in a one-video-mounted vertical viewer with a segmented thread and a shop chip, opened from a poster shelf and shareable by `?reel=`), and the host's **one app bar** (cart · chat · quote · search) plus the three doors a shopper lacks today (ask about this product, request a print from this store with a live estimate, follow my order). The owner gets a media library that knows bytes and «مستخدم في», a **«سرعة متجري»** tab that shows real-visitor LCP/INP/CLS buckets beside a deterministic first-screen weight audit whose hints open the offending block, and an outbound PageSpeed link kept apart from the real numbers. Everything is paid for before it is spent: `profileIcons`/`attributes`/`governorates` (3.4 KB gz) leave the storefront closure before ~1.3 KB enters it, CSS is measured after the `source()` payback and spent only up to what it frees, and every new surface is lazy by construction.

---

## 2. Information architecture and navigation

### 2.1 Shopper (host `slug.levonis-iq.com` and apex `/community/store/:slug`)

```
/                          StoreRenderer (StoreRenderer.tsx:132) — published layout
 ├─ [BackgroundLayer]      NEW layout.background            core poster (≤0.25 KB) + lazy video (extra)
 ├─ StoreHeader            EXTEND: notice line (header.notice), host bar drawn inline for `bar`
 ├─ hero                   EXTEND: video + poster, video_on_phone                core poster / lazy <video>
 ├─ [HostBar sentinel]     NEW runtime slot HostBar (host only): cart · chat · quote · search
 ├─ tabs: products(+search) · collections(covers) · deals · services · showcase · about · clips(NEW)
 ├─ reels (shelf|grid)     NEW block → ReelsViewer (own chunk), ?reel=<id> deep link
 ├─ products_grid / carousel / featured   cards: 2nd frame on hover+focus, ▶ when has_video
 ├─ gallery / reviews      EXTEND: lightbox = the viewer in images mode; photos, filter, «المزيد»
 ├─ lookbook               NEW (Phase D, budget-gated): hotspots → ProductCard
 ├─ custom_request_cta / ServiceDoors → store-addressed PrintRequestSheet (not the board)
 └─ footer                 EXTEND: footer.links (max 6)
/products?q=&section=      EXTEND route: q on GET /api/storefront/:slug/products (storefront.ts:523)
/clips  (?tab=clips)       NEW tab kind (TAB_KINDS blocks.ts:95, runtime.tsx:31, Tabs.tsx:53-60, addressedView.ts)
/p/:slug                   StorefrontProduct: «اسأل عن هذا المنتج», «اطلب طباعة مثلها», «عرض السلة ›», more from this store
/cart /checkout /store-checkout /orders /orders/:id   EXISTS on host (App.tsx:427-431); orders gain store identity
/chat/:id                  MISSING on host (hard hop to apex, Storefront.tsx:464, :723) — Phase D2, after churn
```

### 2.2 Owner (`/merchant/store/design`, host `/admin/store/design`; `SECTION_PATHS.store_design = 'store/design'`, `packages/contracts/src/merchantRoutes.ts:66`)

```
Tabs (StoreDesignPanel.tsx:80 `Tab`, TabStrip :428-441):  الأقسام | الشكل | الصفحة | السرعة (NEW) | السجل
  الأقسام   BlockList + BlockInspector (registry-driven; MediaControl v2 with bytes, «مستخدم في», replace/remove)
  الشكل     ThemePanel: 7 presets (tokens.ts:96-120), tokens (+ motion), «ابدأ من قالب…» (TemplateGallery)
  الصفحة    PagePanel (panels.tsx:201-227): header (+ notice, notice_link) · footer (+ links) · background (NEW)
  السرعة    SpeedPanel: verdict tiles · first-screen weight · hints → select(block) · «افحص في PageSpeed» (outbound)
  السجل     revisions (EXISTS)
Preview   PreviewCanvas 360/768/1280 (PreviewCanvas.tsx:21) + «معاينة على هاتفي» QR of GET /preview (routes/storeLayout.ts:546; QR encoder worker/lib/qr.ts via ShareStore.tsx:12)
Clips     Catalogue → الورشة (CatalogTabs.tsx ShowcaseTab :349): «أضف مقطعًا» = video + captured poster + caption + product
Command Center   attention source `speed` (merchantWorkspace.ts source() pattern :142+) → row linking to the Speed tab
```

No new workspace section; the contracts file does not change.

---

## 3. Screen-by-screen spec

Token classes: only `sf-*` from `src/components/storefront/theme.css` (`.sf-bg .sf-card .sf-card-pad .sf-col .sf-cover-fade .sf-display .sf-fact .sf-flush .sf-glow .sf-grid .sf-media .sf-menu .sf-name .sf-r-lg/md/sm .sf-row .sf-shelf .sf-stack .sf-subtitle .sf-tile .sf-tile-body .sf-title .sf-well`, plus `.sf-tile-flag` under `[data-sf-pcard='overlay']` at `:276`) and app utilities present in the build. No hex (the one violation `bg-[#10161f]/85` at `parts.tsx:144` is removed), no `dark:`, logical utilities only (the two physical corners — heart top-left `parts.tsx:130`, header corners `StoreHeader.tsx:4-7` — stay by recorded decision).

### 3.1 Store home — 360

```
┌──────────────────────────────────────┐
│ ‹                               ⋯    │  overlay header (StoreHeader.tsx:44-53), unchanged
│ ░ BackgroundLayer (fixed, dim) ░░░░░ │  NEW, only when layout.background.kind ≠ 'none'; phones: poster
│ ┌──────────────────────────────────┐ │
│ │ HERO poster <img eager high>     │ │  Hero.tsx:63 stays the LCP; GIF is this <img>
│ │ ▶ <video muted loop> fades in    │ │  lazy from `extra` after poster load + idle; never on a phone
│ │ ╲ sf-cover-fade                  │ │  unless settings.video_on_phone
│ └──────────────────────────────────┘ │
│ (◯) Store name ✓   ★4.8 · 96% · 120  │  ProfileHero (Hero.tsx:50-114)
│ [ راسل المتجر ] [ متابعة ] (⤴)        │  rt.ProfileActions (Storefront.tsx:435)
│ ┃ 🔔 رمضان: التوصيل خلال 3 أيام   ›┃ │  NEW NoticeLine: sf-card sf-r-md border-s-2 {accent.line}
│  المنتجات · المقاطع · المجموعات · …   │  TabStrip (layoutId, spring 'move'); «المقاطع» only when reels > 0
│ [🔍 ابحث في المتجر             ]     │  NEW search field (products tab): lv-input h-10 sf-r-md
│ ┌───────┐ ┌───────┐ ┌───────┐        │  ProductCard v2: heart (bg-black/60 disc), −15% bg-danger text-snow,
│ │ ♡  ▶  │ │ ♡ −15%│ │ ♡     │        │  ▶ bottom-end when has_video; 2nd frame on hover/focus (pointer:fine)
│ ├───────┤ ├───────┤ ├───────┤        │
│ │ اسم    │ │ اسم    │ │ اسم    │        │  sf-tile-body · DinarPrice
│ └───────┘ └───────┘ └───────┘        │
│ ▶ مقاطع المتجر                الكل › │  NEW reels block `shelf` (.sf-shelf theme.css:293): 9:16 posters,
│ ┌9:16┐ ┌9:16┐ ┌9:16┐ ┌9:16           │  duration chip bg-black/60 text-snow; tap → ReelsViewer (lazy chunk)
│ └────┘ └────┘ └────┘ └────           │
│ ★ التقييمات 4.8 (32)  [الكل|★5|📷]    │  Reviews: photo thumbs (ReviewData.images data.ts:210), «المزيد» by next_cursor
│ [ اطلب طباعة من هذا المتجر ]          │  custom_request_cta → store-addressed sheet
│ install card · روابط: الأسئلة · السياسات │  StoreFooter (StoreHeader.tsx:57-75) + footer.links
└──────────────────────────────────────┘
   after the hero scrolls out (host only) the HOST BAR docks at the top edge:
┌──────────────────────────────────────┐
│ (◯) Store name   [🔍] [💬] [🛠] [🛒 2]│  h-12 sticky top-0 z-30 material material-thin scroll-edge
└──────────────────────────────────────┘  IconButton ×4 (44 px); rises y: travel(-12)→0, spring('ui')
```

### 3.2 Store home — 1280 (`width: wide` → `--sf-col: 72rem`, theme.css:139-141)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ‹  (◯) Store name ✓            [ ابحث في المتجر         🔍 ]   [💬] [🛠 عرض سعر] [🛒 2]  ⋯ │  header `bar` (StoreHeader.tsx:22-42) with HostBar drawn INLINE — one layer
│ ┃ 🔔 رمضان: التوصيل خلال 3 أيام — اطلب الآن ›                                          ┃ │  notice line, full width
├────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────── HERO split (HeroVariants.tsx:63) ───────┐ ┌───────────────────────────┐ │
│ │ poster → video (16:9, sf-r-lg, object-cover)             │ │ headline (sf-display)     │ │
│ │                                                           │ │ ★4.8 · 96% · 120 · [CTA]  │ │
│ └───────────────────────────────────────────────────────────┘ └───────────────────────────┘ │
│  المنتجات · المقاطع · المجموعات · الخدمات · المعرض · عن المتجر                                │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐   grid-cols-3 @min-[40rem]:grid-cols-4 @min-[64rem]:grid-cols-5 │
│ │    │ │ ▶  │ │    │ │    │ │    │   (gridClasses theme.ts:84-91); hover: 2nd frame swap             │
│ └────┘ └────┘ └────┘ └────┘ └────┘                                                             │
│ مقاطع المتجر                                                                        ‹ ›  الكل › │
│ ┌9:16┐ ┌9:16┐ ┌9:16┐ ┌9:16┐ ┌9:16┐ ┌9:16┐   .sf-shelf 24% columns; arrows = useRail().page(±1)     │
│ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘   (useRail.ts:190-194), hidden size-11 … sm:flex        │
│ ┌ التقييمات ─────────────────────────────┐ ┌ اطلب طباعة من هذا المتجر ───────────────────────┐   │
│ │ [الكل|★5|★4|📷 بالصور]  thumbs 4-col   │ │ ملفك أو رابطك → تقدير فوري → يصل هذا المتجر وحده  │   │
│ └────────────────────────────────────────┘ └──────────────────────────────────────────────────┘   │
│ footer: install · name · since · روابط (max 6)                                                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Anatomy (classes exist unless marked inline):**

- `BackgroundLayer` (NEW `src/components/storefront/BackgroundLayer.tsx`, rendered by `StoreRenderer.tsx` beside `Glow` at `:152`): `<div aria-hidden className="fixed inset-0 z-0 pointer-events-none">` → `<img className="w-full h-full object-cover" loading="eager" decoding="async">` → `<div className="absolute inset-0" style={{background:'rgb(0 0 0 / .45|.6|.75)'}}>` (dim light/medium/heavy, inline). Video (`kind:'video'`) mounts from `extra` after `requestIdleCallback`, `!reduced && !saveData && (container ≥ 48rem || background.phones)`. The theme root gets `data-sf-bg` and **one** theme.css rule `[data-sf-bg]{--sf-tile:rgb(10 10 10/.82);--sf-card:rgb(10 10 10/.82)} [data-sf-bg]>.sf-glow{display:none}` (~110 B gz); with a background every non-hero block is wrapped in `sf-card sf-card-pad` by the renderer (0 B), because bare text over a picture cannot pass 4.5:1 at any honest dim (§8 has the arithmetic).
- Hero video (EXTEND `blocks/Hero.tsx` profile; `HeroVariants.tsx` cover/split/minimal): poster `<img loading="eager" fetchPriority="high">` unchanged; `<HeroVideo>` exported from `extra.tsx` renders `<video className="absolute inset-0 w-full h-full object-cover" muted loop playsInline preload="none" poster={cover} style={{opacity: playing?1:0, transition:'opacity 150ms'}}>` (opacity only — MOTION §٢). Phase A moves the cover `<img>` of the lazy variants into core so the LCP no longer waits for `extra` (`Hero.tsx:31-42`).
- `NoticeLine` (EXTEND `StoreHeader.tsx`; rendered in flow after the first block for `overlay`, under the bar for `bar`): `<a|div role="note" className="sf-card sf-r-md px-4 py-2 flex items-center gap-2 text-[12.5px] text-zinc-300 border-s-2 {accent.line}"><Megaphone className="w-3.5 h-3.5 {accent.text}"/><span dir="auto" className="truncate flex-1 min-w-0">…</span>{link && <ChevronGlyph/>}<IconButton label=«إخفاء»/></a>`; dismissed per session in `sessionStorage` (`lv_notice_<storeId>_<hash>`), never server state.
- `HostBar` (NEW runtime slot `HostBar: ComponentType<{ inline?: boolean }>` in `runtime.tsx:38-89`, `NO_HOST.HostBar = Nothing`; live implementation lazy from `Storefront.tsx`): `<nav aria-label=«شريط المتجر» className="sticky top-0 z-30 material material-thin scroll-edge">` → `Column h-12 flex items-center gap-2`: avatar `w-8 h-8 rounded-full sf-bg border {accent.ring} overflow-hidden` (copied from `StoreHeader.tsx:29`), name `flex-1 min-w-0 truncate text-snow text-[14px] font-bold` (`hidden @min-[40rem]:inline` for long Sorani), `IconButton` search / chat (`useOpenChat`, `Storefront.tsx:450`) / quote (opens the print sheet) / cart with count from `cartCountStore` (`src/lib/cartCount.ts:105`, `useSyncExternalStore`) → `rt.routeHref('cart')` (`Storefront.tsx:264`). Sentinel: a `<div aria-hidden className="h-px">` after the hero; `IntersectionObserver` flips `visible`; `visible` is forced `true` at mount when `scrollHeight < 1.5 × innerHeight`. Never `fixed bottom-0` (`tests/uiSystem.test.ts:102,112`).
- `ProductCard` v2 (EXTEND `parts.tsx:110-171`): `Link className="sf-tile press-scale"` (replaces `active:scale-[0.98] transition-transform`); heart disc `bg-black/60` (replaces the hex); discount `bg-danger text-snow` (replaces `bg-red-600/90 text-white`), corner utilities unchanged; second frame = **React state**, not a class: `src={hover||focus ? images[1] : images[0]}` on `onPointerEnter/Leave` (`(pointer:fine)` only) and `onFocus/onBlur`, so `group-hover:opacity-100` (absent) is never spent; `has_video` → `<span aria-hidden className="absolute bottom-1 end-1 size-6 rounded-full bg-black/60 text-snow flex items-center justify-center"><Play className="w-3 h-3 fill-current"/></span>` with «فيديو» in the link's `aria-label`. Server: `worker/lib/storeLayout.ts:117` `images.slice(0,2)`; `has_video` via `EXISTS(SELECT 1 FROM community_product_media m WHERE m.product_id = p.id AND m.kind='video')` added to `PRODUCT_CARD_COLUMNS` (`:106`; table `0126:178-190`).
- Reels shelf (NEW `blocks/Reels.tsx`, in `EXTRA_BLOCKS` `extra.tsx:32`): `<button className="sf-tile press-scale relative shrink-0 snap-start overflow-hidden text-start" style={{aspectRatio:'9 / 16'}} aria-label="{caption} — {m:ss}">` + `<img loading="lazy" className="w-full h-full object-cover">` + duration chip `absolute bottom-1.5 start-1.5 rounded-full bg-black/60 text-snow text-[10px] px-1.5 tabular-nums` (`dir="ltr"`) + centred `size-9 rounded-full bg-black/60 text-snow` play disc. `grid` variant: `grid grid-cols-3 @min-[40rem]:grid-cols-4 sf-grid`. The shelf never plays anything.
- Search door: products tab (`blocks/Tabs.tsx`) and HostBar both render `<label className="lv-input flex items-center gap-2 h-10 sf-r-md"><Search className="w-4 h-4 text-text-muted"/><input type="search" enterKeyHint="search" dir="auto" className="bg-transparent flex-1 min-w-0 text-[13px]"/></label>`; 250 ms debounce; `?q=` in the URL; results through `rt.loadProducts({source:'latest', collection_id:'', cursor, q})` (`ProductQueryRequest` `runtime.tsx:33-37` gains `q`).
- Footer links: `<nav className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] text-zinc-400">` of `LinkTo` from `layout.footer.links`.

### 3.3 Reels viewer — 360 (`Overlay mode="modal" placement="center" solid trapFocus label=«مقاطع المتجر»`, `panelClassName="fixed inset-0 max-w-none bg-black"`; props at `ui/Overlay.tsx:280-345`)

```
┌──────────────────────────────────────┐
│ ▬▬▬▬▬▬▬ ▬▬▬▬░░░░ ░░░░░░░ ░░░░░░░     │  THE THREAD: one h-0.5 flex-1 rounded-full bg-white/20 per clip;
│ ✕                              🔇    │  active fill bg-white/70 style={{transform:`scaleX(${p})`, transformOrigin: dir===-1?'right':'left'}}
│                                      │  IconButton close (top start) · mute (top end), 44 px, aria-pressed
│          ┌────────────────┐          │
│          │  <video 9:16>  │          │  ONLY the active slot mounts <video>; ±1 slots are <img poster>
│          │   tap = ▶/❚❚   │          │  playsInline muted loop preload="none" → play() when ≥ .75 visible
│          └────────────────┘          │  swipe = native scroll-snap (style: scrollSnapType 'y mandatory')
│                                      │
│ (◯) Store name ✓ · 0:24              │  bottom: lv-bleed-scrim pb-safe px-4 pt-16, text-snow
│ «حامل سماعات PETG بلون النحاس»       │  caption dir="auto" line-clamp-2 text-snow/80
│ ┌──────────────────────────────────┐ │  SHOP CHIP (when reel.product): motion.div y: travel(24)→0 spring('sheet')
│ │ (img) اسم المنتج    ع. 12,000  › │ │  sf-card sf-r-md flex items-center gap-2 p-2 → rt.productHref
│ └──────────────────────────────────┘ │
│ «المقطع 3 من 12»  (visible + sr)     │  aria-live="polite"
└──────────────────────────────────────┘
Reduced motion / saveData: no autoplay; poster + 56 px play disc «اضغط للتشغيل»; snap stays native.
```

### 3.4 Reels viewer — 1280

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ✕                                                                               │
│                  ┌──────── 9:16, max-h-[88dvh] ────────┐   ┌ Store ───────────┐ │
│            ▲     │ ▬▬▬▬ ▬▬░░ ░░░░ ░░░░                 │   │ (◯) name ✓ [متابعة]│ │
│          prev    │                                       │   │ «caption…»        │ │
│                  │             <video>                   │   │ ┌ ProductCard ─┐  │ │
│            ▼     │                                  🔇   │   │ └──────────────┘  │ │
│          next    └───────────────────────────────────────┘   │ ‹ 3 / 12 ›        │ │
│   arrows: hidden size-11 rounded-full bg-black/50 text-snow sm:flex (MediaStrip.tsx:106-121 verbatim)          │
│   keys: ↑/↓, PageUp/PageDown = clip; Space = pause; M = mute; Esc = close (Overlay dismissOnEscape)            │
└────────────────────────────────────────────────────────────────────────────────┘
```

Behaviour: active index from `IntersectionObserver` (threshold .75); the next slot's poster is prefetched and its `<video>` is created with `preload="metadata"` only when it becomes active; mute persists in `sessionStorage` (`lv_reels_muted`); progress from `timeupdate` (no timers); pause on `visibilitychange`; `overscroll-behavior: contain` inline; opening pushes `?reel=<id>` (`history.replaceState`) so a shared clip opens in place and the installed store PWA stays in scope; `images` mode serves the gallery and review photos with the same shell (pinch through native `touch-action: pinch-zoom`).

### 3.5 Product page — 360 (`src/pages/StorefrontProduct.tsx`; only what changes)

```
┌──────────────────────────────────────┐
│ ‹                              ⋯  🛒²│  cart pill on host (HostBar inline in the product header)
│ ┌────────────────────────────────┐   │  ProductGallery (catalog/ProductGallery.tsx, static :50): unchanged
│ └────────────────────────────────┘   │
│ اسم المنتج                 ★4.8 (12) │
│ ع. 12,000  ~~14,000~~  −15%          │
│ [ variants ]  التوصيل إليك: بغداد … │  exists (the governorates panel becomes lazy behind first paint — payback)
│ [ − 1 + ]  [ 🛍 أضف إلى السلة ]        │  StorefrontProduct.tsx:375-398
│  ✓ أُضيف · [ عرض السلة › ]            │  NEW: after add, a lv-button lv-button-secondary lv-button-sm link → rt.routeHref('cart')
│ [💬 اسأل عن هذا المنتج] [🖨 اطلب طباعة مثلها] │  NEW doors row: lv-button lv-button-ghost lv-button-sm, inside lazy ProductActions (:70)
│ المزيد من هذا المتجر  ‹ ▢ ▢ ▢ ▢ ›     │  NEW lazy MoreFromStore: storefrontApi.products(slug,'?limit=6') (storefrontApi.ts:28) in .sf-shelf
└──────────────────────────────────────┘
1280: the same, two columns (gallery | facts + buy bar + doors), the shelf full width below.
```

### 3.6 Store-addressed print request — 360 (`Sheet` v2 `detents={['medium','large']}` `dragHandle` `header` `footer`, `ui/Sheet.tsx:53-66`)

```
┌──────────────────────────────────────┐
│ ═══                                  │
│ طلب طباعة إلى «اسم المتجر»       ✕   │  PrintRequestSheet.tsx:136-140 already says «يصل إلى {store} وحده»
│ ┌ ملف أو رابط ───────────────────┐   │
│ │ [⬆ STL / 3MF / صور]  [🔗 رابط]  │   │  EXTEND: link tab → POST /api/marketplace/print/link (printRequests.ts:323)
│ └────────────────────────────────┘   │
│ ┌ تقدير Levonis ─────────────────┐   │  printApi.quote → POST /api/marketplace/print/quote (printRequests.ts:473, requireAuth;
│ │ ع. 18,000 – 24,000 · ثقة متوسطة │   │  client printApi.ts:249; same call as RequestWizard.tsx:372)
│ │ ▸ لماذا هذا السعر               │   │  renders confidence_reasons (typed printApi.ts:131, rendered nowhere today)
│ └────────────────────────────────┘   │
│ الكمية [1]  الخامة [PLA ▾]  اللون …  │
│ [ أرسل الطلب إلى هذا المتجر ]        │  footer (in-flow, clear of --shell-bottom-inset)
│ تريد عروضًا من عدة ورش؟ الطلب العام › │  PrintRequestSheet.tsx:224-228 exists
└──────────────────────────────────────┘
Flow: signed-in → POST /api/chats/open {merchantId} (chats.ts:553) → mount the sheet with chatId → POST /api/chats/:id/print-requests
(chatCommerce.ts:152) → success copy + «افتح المحادثة» (apex hop on a host until D2). Guests → /auth?next=. Community closed (DECISIONS 110)
→ the door is hidden exactly as LiveServiceDoors hides the quote today (Storefront.tsx:485-488).
1280: the sheet becomes a centred card (Sheet v2 behaviour), two columns: sources | estimate.
```

### 3.7 Builder — 1280 (Sections tab, media library v2)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ تصميم المتجر    ● محفوظ 12:04   ↶ ↷   [معاينة على هاتفي ▦]   [نشر التغييرات (3)]          │
├───────────────────────────┬──────────────────────────────────────┬───────────────────────┤
│ الأقسام│الشكل│الصفحة│السرعة│السجل │  المعاينة (360)(768)(1280) مسودة       │ المفتّش: واجهة المتجر   │
│ ≡ واجهة المتجر   cover  👁 ⋯ │ ┌──────────────────────────────────┐ │ الشكل  profile cover split minimal │
│ ≡ المقاطع        shelf  👁 ⋯ │ │ ‹ (◯) name  notice ›      🔍  ⋯  │ │ الصورة (الملصق) [▣ 1.2 MB ✎ استبدال]│
│ ≡ شبكة منتجات           👁 ⋯ │ │ ▒▒ cover ▶ 4.1 MB ▒▒              │ │ فيديو الغلاف [▶ 4.1 MB · 0:14 ✎ ✕] │
│ ≡ التقييمات             👁 ⋯ │ │ ▢ ▢ ▢ ▢ ▢                         │ │ ☐ يعمل على الهاتف                 │
│ + أضف قسمًا                  │ │ 9:16 9:16 9:16 9:16                │ │ ⓘ يظهر الملصق أولًا ثم يبدأ الفيديو │
│                             │ └──────────────────────────────────┘ │ ⚠ lv-field-error: 6.2 MB > 1.5 MB  │
│                             │ انقر قسمًا في المعاينة لتعديله.        │ الجدولة  من [ ] إلى [ ]  (date)   │
├───────────────────────────┴──────────────────────────────────────┴───────────────────────┤
│ MEDIA LIBRARY (MediaPicker, pickers.tsx:317): grid of MediaThumb · 1.2 MB · «مستخدم في: الغلاف، المعرض» ·       │
│ [حذف] only when unused (DELETE → MEDIA_IN_USE otherwise) · upload with XHR progress «جارٍ الرفع 42٪» ·         │
│ video pick → poster captured at 0.5 s → sibling poster field filled · pre-check File.size against the slot cap  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.8 Builder — 360 (existing `phoneView` editor ⇄ preview, `StoreDesignPanel.tsx:115` wide breakpoint)

```
┌──────────────────────────────┐
│ ‹ تصميم المتجر   ● محفوظ  نشر ³│
│ ( تعديل | معاينة )   ↶ ↷      │  Segmented (EXISTS)
│ الأقسام·الشكل·الصفحة·السرعة·السجل│  TabStrip scroll-x
│ ≡ واجهة المتجر          ✎  ›  │
│ ≡ المقاطع (4)           ✎  ›  │  inspector opens as Sheet v2 large (EXISTS pattern)
│ ≡ شبكة منتجات           ✎  ›  │
│ [ + أضف قسمًا ]               │
└──────────────────────────────┘
```

### 3.9 «سرعة متجري» — 360

```
┌──────────────────────────────────────┐
│ سرعة متجري         (هاتف | حاسوب)    │  Segmented (ui/Segmented.tsx); آخر 7 | 28 يومًا
│ ┌ الحكم ────────────────────────┐    │  KpiTile ×4 (ui/KpiTile.tsx:65): value + StatusChip text («مقبول»),
│ │ ● مقبول     من 312 زيارة · 7 أيام│    │  never colour alone; Sparkline (:134) of the daily good-share
│ │ ظهور الصفحة 2.9 ث   ▂▃▅▆▇▆▅   │    │
│ │ الاستجابة 180 مث · ثبات 0.04    │    │
│ └───────────────────────────────┘    │
│ ┌ وزن الشاشة الأولى 6.8 MB ───────┐  │  deterministic audit (needs no visitors)
│ │ ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ 6.2 غلاف GIF ›│  │  DataList rows (ui/DataList.tsx:120); bar = h-1.5 rounded-full
│ │ ▇▇ 0.4 ملصقات المقاطع           ›│  │  bg-surface-selected track + bg-gold fill, width inline
│ │ ▇ 0.2 صور المنتجات (أول صف)     ›│  │
│ │ ▇ 0.2 التطبيق (ثابت لكل المتاجر)  │  │  fixed rows carry no arrow
│ └─────────────────────────────────┘  │
│ ┌ ما الذي يسرّع متجرك ───────────┐   │  hints = closed codes → copy; «افتح القسم» selects the block
│ │ 1. غلافك GIF 6.2 MB — استبدله  │   │
│ │    بفيديو أو صورة WebP  [افتح]  │   │
│ │ 2. فيديو تلقائي فوق الطية [افتح]│   │
│ └────────────────────────────────┘   │
│ [ افحص في PageSpeed ↗ ]  (رابط خارجي)│  lv-button lv-button-ghost → pagespeed.web.dev/analysis?url=<store url>
│ الأرقام من زوار حقيقيين لمتجرك، لا من أداة. │  honesty line; «p75 مقدَّر من الفئات»
└──────────────────────────────────────┘
Empty: EmptyState «لا قياسات بعد…» + the weight audit still renders.
```

### 3.10 «سرعة متجري» — 1280

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ سرعة متجري                                  (هاتف | حاسوب)   آخر 7 | 28 يومًا · 312 زيارة │
│ ┌ ● مقبول ─────┐ ┌ ظهور الصفحة ─────┐ ┌ الاستجابة ───┐ ┌ ثبات الصفحة ──┐ ┌ أول بايت ──┐  │
│ │ 312 زيارة     │ │ 2.9 ث  ▂▃▅▆▇▆▅   │ │ 180 مث ▃▃▂▂▂ │ │ 0.04  ▂▂▂▂▂    │ │ 0.6 ث       │  │
│ └──────────────┘ └─────────────────┘ └──────────────┘ └───────────────┘ └────────────┘  │
│ ┌ وزن الشاشة الأولى 6.8 MB ──────────────────────────┐ ┌ ما الذي يسرّع متجرك ───────────┐ │
│ │ ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ 6.2 MB غلاف GIF    [افتح]   │ │ 1. … [افتح القسم]               │ │
│ │ ▇▇ 0.4 MB ملصقات المقاطع (6)                        │ │ 2. …                            │ │
│ │ ▇ 0.2 MB صور المنتجات (أول صف)                      │ │ ✓ الصور بمقاسات مناسبة          │ │
│ └─────────────────────────────────────────────────────┘ └─────────────────────────────────┘ │
│ ┌ قياس مختبري (خارجي) ─────────┐  «افحص في PageSpeed ↗» — a separate tile, never mixed with the tiles above │
│ ملاحظة: توزيع زيارات حقيقية (LCP/INP/CLS) خلال اليوم؛ p75 مقدَّر من الفئات، لا من أداة.                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Feature list — EXISTS / EXTEND / NEW (files, routes, migrations, refusal codes)

### 4.1 Land (first paint)

| # | Item | Status | Where / minimal change |
|---|---|---|---|
| L1 | Skeleton instead of the black spinner | **EXTEND** `Storefront.tsx:345-350`, `StorefrontProduct.tsx:199-204` | `bg-canvas` page + `ProductGridSkeleton` (`ui/Skeleton.tsx:108`) under an `h-36` cover box. |
| L2 | Eager LCP for cover/split/minimal heroes | **NEEDS REFACTOR** `Hero.tsx:31-42` | Render the cover `<img>` in core for every variant; only the variant's chrome stays in `HeroVariant` (`extra.tsx:29`). |
| L3 | Hero video + poster | **EXTEND** `blocks.ts:107-124` | `video: {t:'media', kind:'video', max_bytes: 12·MB}`, `video_on_phone: {t:'bool', d:false}`; `image` is the poster (max 1.5 MB). `SHOWN_WHEN.hero.video = v !== 'minimal'` (`BlockInspector.tsx:23-37`). Ownership/mime free via `verify.ts walkFields` (`:43`) + `verifyLayoutRefs` (`storeLayout.ts:483`). |
| L4 | Page background (image/GIF/video) | **NEW layout key** | `schema.ts` `StoreLayout.background: {kind:'none'|'image'|'video', media:string, poster:string, dim:'light'|'medium'|'heavy', phones:boolean}`; `normalize.ts:491` allow-list + `normalizeBackground`; `verify.ts` walks it; `defaults.ts:46-48` `kind:'none'`; `themeAttributes` (`theme.ts:64-77`) emits `data-sf-bg` when set; renderer wraps blocks in `sf-card` (§3.1). |
| L5 | `max_bytes` per media slot | **NEW spec field + server rule** | `blocks.ts` `{t:'media', kind, max_bytes?}`; `verifyLayoutRefs` adds `byte_size` to the `file_objects` SELECT (`storeLayout.ts:512-513`; column `0068:11`) and drops the key with issue `media_too_heavy` (non-fatal, like a foreign key today); builder refusal `LAYOUT_MEDIA_TOO_HEAVY` (`storeDesign/refusal.ts:13`) shown as `lv-field-error`; the picker pre-checks `byte_size` from `GET /media` v2 and `File.size` before an upload starts. Defaults: hero/banner/background image 1.5 MB (GIF included), poster 400 KB, video 12 MB (under `VIDEO_MAX` 40 MB, `uploads.ts:37`), gallery item 1 MB. No global purpose cap — per slot only. |
| L6 | Notice line | **NEW layout keys** | `header.notice: LocalizedText(120)`, `header.notice_link: LinkTarget` (`schema.ts:57` header box); `PagePanel` (`panels.tsx:201-227`) gets a text + link control from the field kit. Core `StoreHeader.tsx`. |
| L7 | Footer links | **NEW layout key** | `footer.links: Array<{label: LocalizedText(30), link: LinkTarget}>` max 6; `StoreFooter` (`StoreHeader.tsx:57-75`). |
| L8 | Scheduled blocks | **NEW optional** | `BlockOf.schedule?: {from:string, until:string}` (`schema.ts:41-49`, `date` rules); `renderableBlocks` filters by now in `live` mode; preview shows all with a dashed «مجدول» ring in `builder.css`. |
| L9 | Collection covers | **EXTEND** (no migration) | `storeLayout.ts:275` selects `image_key`; `CollectionData.image_url: string|null` (`data.ts:180-185`); `Collections.tsx:72-88` cards get `.sf-media` + `sf-cover-fade` name overlay; `CollectionsManager` gets `MediaControl` writing `image_key` through the existing PATCH (`merchantCatalog.ts:1194`). |
| L10 | Product card: 2nd image, `has_video` | **EXTEND** `storeLayout.ts:106-121`, `parts.tsx:110-171` | §3.1 anatomy. |
| L11 | In-store search + sort | **EXTEND** `GET /api/storefront/:slug/products` (`storefront.ts:523-531`) | `q` (≤ 60 chars, `LIKE` on `name`, `name_ar`, escaped), `sort=new|price_asc|price_desc`; keyset unchanged. Client: `ProductQueryRequest.q` (`runtime.tsx:33-37`), field in Tabs + HostBar. |
| L12 | Reviews: photos, filter, «المزيد» | **EXTEND** `blocks/Reviews.tsx` (uses `images` **nowhere** today; `ReviewData.images` exists `data.ts:210`; route returns `images` + `next_cursor`, `storefront.ts:650-690`) | Chips `Segmented size="sm"` (all / ★5 / ★4 / 📷); thumbs `grid grid-cols-4 gap-1 sf-r-sm overflow-hidden`, tap → viewer in images mode; `?rating=&photos=1` on the route. Review-form photos: `StoreReviews.tsx` (`src/components/community/reviews/`) gains the picker (server takes 6, `merchantReviews.ts:235`). |
| L13 | Templates | **EXISTS** (`starters.ts` 6 + classic = 7, `TemplateGallery.tsx:4`, `POST /preview` `routes/storeLayout.ts:581`, DECISIONS 161) | Add starter `reels_first` after Phase C; round-trip pin `tests/storeDesignEditor.test.ts:446`. |
| L14 | Motion token | **NEW token** `tokens.ts` `MOTION = ['none','calm','lively']` | `data-sf-motion`; CSS-only scroll-driven reveal (§5); presets `classic`/`workshop` `none`, others `calm`. Ships only if the measured CSS payback covers ~170 B (§6). |
| L15 | Three accents (`rose`, `amber`, `emerald`) | **EXTEND** `tokens.ts:19-21`, `merchant.ts:606 ACCENTS`, `theme.ts:33-41` | Last in Phase E, only inside the measured payback (~250 B). |
| L16 | Fonts | **DECISION** | Cairo only (`tokens.ts:14-16`); a second face is an owner question (§10). |

### 4.2 Watch (reels)

| # | Item | Status | Where |
|---|---|---|---|
| W1 | Showcase clips | **NEW additive migration `0156_store_reels.sql`** | `ALTER TABLE merchant_showcase ADD COLUMN video_key TEXT CHECK (video_key IS NULL OR video_key GLOB 'merchants/*'); … poster_key TEXT (same CHECK); … duration_s INTEGER CHECK (duration_s IS NULL OR duration_s BETWEEN 1 AND 180); … product_id TEXT REFERENCES community_products(id) ON DELETE SET NULL; … caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 200); CREATE INDEX IF NOT EXISTS idx_merchant_showcase_reels ON merchant_showcase(store_id, sort_order, created_at) WHERE video_key IS NOT NULL AND active = 1;` `kind` CHECK (`0036:71`) untouched — a reel is a `work` row with a `video_key`. Register both keys in `mediaRefs.ts` beside `:305`. |
| W2 | Merchant write | **EXTEND** `merchant.ts:1622` POST / `:1652` PATCH showcase | Accept `video_key` (owner's key, `file_objects.mime_type LIKE 'video/%'` else `SHOWCASE_VIDEO_KIND`), `poster_key` (required with video → `LAYOUT_POSTER_REQUIRED`), `duration_s` (client `loadedmetadata`, clamp ≤ 180), `product_id` (this store's live product else `SHOWCASE_PRODUCT_NOT_YOURS`), `caption`. `showcaseShape` (`:1601`) returns `videoUrl/posterUrl/duration_s/product`. UI: `ShowcaseTab` (`CatalogTabs.tsx:349`) gains «أضف مقطعًا» with `MediaPicker kind="video"` (`pickers.tsx:317`, `ACCEPT.video` `:304`) and poster capture. |
| W3 | Public read | **NEW route** `GET /api/storefront/:slug/reels?cursor=&limit=1..24` in `storefront.ts` beside `/:slug/showcase` (`:508`) | `{items: ReelData[], next_cursor}`; `ReelData = {id, video, poster, duration_s, caption, product: ProductCardData|null, source:'showcase'}`; `Cache-Control: public, max-age=60, s-maxage=300` (no viewer data; the first cacheable storefront answer — today none sets `Cache-Control`). |
| W4 | BlockData | **EXTEND** `data.ts:253-262` `reels: ReelData[] | null`; `collectDataNeeds` gets `needs.reels` like `showcase` (`data.ts:80-120`); `blockDataFor` (`storeLayout.ts:142`) loads the first `limit` (≤ 8, posters + keys only). |
| W5 | `reels` block | **NEW registry entry** `reels: { variants:['shelf','grid'], max:2, requires:'merchant_video_upload', settings:{ title:title(), limit:{t:'int',min:1,max:24,d:8}, show_product:{t:'bool',d:true}, source:{t:'set', values:['showcase','posts'], min:1, max:2, d:['showcase']} } }` | Component `blocks/Reels.tsx` in `EXTRA_BLOCKS`; pins `tests/storeLayoutSchema.test.ts:59` 27 → 29 (with lookbook) and the file-per-type rule `storefrontBlocks.test.ts:159-161`; copy in `catalog.ts` `CATEGORIES.content` (`:33`). |
| W6 | `clips` tab kind | **EXTEND** `TAB_KINDS` (`blocks.ts:95`), `TabKind` (`runtime.tsx:31`), `show` map (`Tabs.tsx:53-60`: `clips: reels.length > 0`), `tabViews.tsx`, `addressedView.ts` (`/clips`), `Storefront.tsx:57` TAB_KINDS, host route `/clips` (App.tsx, D2 — until then `?tab=clips`). |
| W7 | Viewer | **NEW** `src/components/storefront/reels/ReelsViewer.tsx` + `useActiveSlot.ts`, own lazy chunk `reels` (target ≤ 5 KB gz; added to the lazy-only list `bundleBudget.test.ts:331-336`) | §3.3–3.4. Opened by the shelf, by `?reel=`, and by gallery/reviews in images mode. |
| W8 | Poster capture | **NEW client rule** in `MediaPicker` and `ShowcaseTab` | `<video>` → `canvas` at 0.5 s → `uploadFile(blob,'community')` (`src/lib/api.ts:1991`) → sibling poster field. Fallback when decode fails (AV1/HEVC on some Androids): viewer uses `#t=0.001` and the inspector shows `media.posterRequired`. No server transcoding exists (`videoSniff.ts:85-92` only sniffs). |
| W9 | Posts as a source | **NEW, gated by DECISIONS row 169** | `community_posts.store_id` (`0153:69`) + first `community_post_media kind='video'` (`0153:117-128`), `state='published' AND visibility='public' AND admin_hidden_at IS NULL`, owner-authored, read by the storefront route (outside `communityGate()`, `communityGate.ts:215`; `communityPosts.ts:49`). Until the row lands the `source` set offers `showcase` only and `posts` answers `REELS_SOURCE_NOT_ENABLED`. |
| W10 | Deep link + OG | **EXTEND** `worker/lib/socialPreview.ts` `resolveStorePreview` (`:469`) | `?reel=<id>` → the reel's poster as the card image. |
| W11 | Video delivery | **DEPENDENCY (perf track)** | Range requests bypass the edge cache (`uploads.ts:831-841`). Until fixed: `preload="none"`, one mounted video, mandatory posters, and the speed tab shows video bytes. |

### 4.3 Ask · request · buy · track

| # | Item | Status | Where |
|---|---|---|---|
| A1 | Ask about this product | **EXTEND client only** | `useOpenChat` (`Storefront.tsx:450-467`) gains `productId`: after `POST /api/chats/open {merchantId}` → `POST /api/chats/:id/messages {card:{type:'product', ref: productId}, client_id}` (`Chat.tsx:361` pattern; server `chats.ts:1038-1050`). Doors: product page, reel shop chip menu, HostBar chat (no product). |
| A2 | Chat stays in the store app | **EXTEND** `src/App.tsx:402-445` (churn zone) — **D2, last** | One lazy `<Route path="/chat/:id">` on the host; `useOpenChat` navigates in-app when `onHost`. |
| A3 | Store-addressed print request with estimate | **EXTEND** `src/components/chat/commerce/PrintRequestSheet.tsx` | Mounted lazily from `custom_request_cta`, `LiveServiceDoors` (`Storefront.tsx:473-503`) and the product page; link tab via `POST /api/marketplace/print/link` (`printRequests.ts:323`); estimate via `printApi.quote` (`printApi.ts:249` → `printRequests.ts:473`); renders `confidence_reasons`. `QUOTE_PATH` (`Storefront.tsx:60`) stays as the secondary «الطلب العام» link. The pricing engine is untouched (pricing track). |
| A4 | Cart entry + post-add link | **NEW** HostBar cart pill (host) + **EXTEND** `StorefrontProduct.tsx:375-398` «عرض السلة ›» | `cartCountStore` (`cartCount.ts:105`). |
| A5 | Success → the order | **EXTEND** `StoreCheckout.tsx:439-445` | `to={`/orders/${orderId}`}`. |
| A6 | Store identity on orders | **EXTEND** `orders.ts:4822` `GET /:id` and the list | Join `merchant_stores` on `orders.store_id` (`0030:242`) → `store: {slug, name, logo_url} | null`; `ApiOrder` (`api.ts:930`) gains it; `Orders.tsx` card header «طلبك من {store}»; `OrderDetail` store strip → the store. |
| A7 | Live tracker | **EXTEND** `OrderDetail.tsx:253-277` | `useFreshOnReturn(load, {pollWhileVisibleMs: 30_000})` (`useFreshOnReturn.ts:45-48`) while a stage is pending; a customer-safe projection of the merchant timeline (`merchantOrders.ts:245`) into `/api/orders/:id/tracking`. |
| A8 | «placed» notice to the customer for store orders | **EXTEND** `storeOrders.ts:1202-1207` | `c.executionCtx.waitUntil(notifyOrderPlaced(c.env, orderId))` (`orderNotify.ts:229`, idempotent by event key). |
| A9 | Sorani time | **EXTEND** `Chat.tsx:70` | `'ku'` → `'ckb'`. |
| A10 | Saved list on host | **PARTIAL** (hearts work; no `/saved-items` route on host) | D2 with A2. |

### 4.4 Owner: builder

| # | Item | Status | Where |
|---|---|---|---|
| B1 | Media library v2 | **EXTEND** `routes/storeLayout.ts:607-636` `GET /media` (returns `object_key, mime_type, width, height, created_at` — **no byte_size**) | Add `byte_size` (one column) and `used_in: Array<{kind:'layout'|'showcase'|'collection'|'product'|'avatar', id?, block_id?}>` from a narrow `usedIn(keys)` helper over the store-owned registry rows (draft + published layout via `collectLayoutRefs` `verify.ts:82`; `merchant_showcase`, `merchant_store_sections`, `community_products`, `community_merchants.avatar_key`). **NEW** `DELETE /api/merchant/store/layout/media/:key` → `MEDIA_IN_USE` when `used_in` is non-empty, else dates `file_objects.deleted_at` (the sweep's contract). Client: `MediaControl` (`fields.tsx:291`) shows bytes/duration and `used_in`; `MediaPicker` (`pickers.tsx:317`) uploads over XHR with progress (`src/components/tradeIn/TradeInWizard.tsx:86-95` pattern); poster capture (W8). |
| B2 | Page panel | **EXTEND** `panels.tsx:201-227` | notice, footer links, background (kind / media / poster / dim / phones). |
| B3 | «معاينة على هاتفي» | **EXTEND** header of `StoreDesignPanel` | QR (`worker/lib/qr.ts` through `ShareStore.tsx:34-38` helpers) of the owner-only `GET /preview` address (`routes/storeLayout.ts:546`, `private, no-store`). |
| B4 | Speed tab | **NEW** `src/components/merchant/storeDesign/speed/SpeedPanel.tsx`, `Tab` union + TabStrip item | §4.5. |
| B5 | Builder Sorani | **NEEDS REFACTOR** `catalog.ts:12-13` (ar/en, OWNER marker) | New strings in **NEW** `src/components/merchant/storeDesign/strings.ts` and `src/components/storefront/strings.ts` (neither under `ui/` nor `merchant/shell/`, so `uiPrimitives.test.ts:352-382` and `merchantWorkspaceShell.test.ts:315-331` hold). Needs DECISIONS row 167 (§10). |

### 4.5 «سرعة متجري»

| # | Piece | Status | Detail |
|---|---|---|---|
| S1 | Reporter | **NEW** `src/lib/storeVitals.ts` (~1 KB), dynamic import after `load` + idle from `Storefront.tsx` / `StorefrontProduct.tsx` (outside the static closure) | `PerformanceObserver`: `largest-contentful-paint`, `layout-shift` (session window), `event` (`durationThreshold: 40` → INP), `navigation` (TTFB). One `navigator.sendBeacon('/api/storefront/vitals', Blob(JSON))` on `visibilitychange → hidden`; DNT/GPC opt-out as `storeBeacon.ts:24-27`; values clamped (LCP ≤ 60 000, INP ≤ 10 000, CLS×1000 ≤ 5 000); `device = innerWidth < 768 ? 'phone' : 'desktop'`. |
| S2 | Ingest | **NEW** `POST /api/storefront/vitals` in `storefrontEvents.ts` (mounted `worker/index.ts:467`) | JSON like `:93-98`; `MAX_EVENT_BYTES` (`:81`); same `isBotUserAgent` (`storefrontAnalytics.ts:61-68`, already drops `lighthouse|pagespeed`); never the owner; once per visitor per day per device through the new marks table using `saltedHash` (`:134`); one `db.batch` like the event recorder (`:174-199`). Refusal `VITALS_REJECTED` is silent (client never shows it). |
| S3 | Tables | **NEW migration `0157_storefront_vitals.sql`** | `CREATE TABLE IF NOT EXISTS storefront_vitals_daily (store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE, day TEXT NOT NULL, device TEXT NOT NULL CHECK (device IN ('phone','desktop')), samples INTEGER NOT NULL DEFAULT 0, lcp_good/lcp_ok/lcp_poor, inp_good/inp_ok/inp_poor, cls_good/cls_ok/cls_poor INTEGER NOT NULL DEFAULT 0, lcp_sum_ms INTEGER NOT NULL DEFAULT 0, ttfb_sum_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (store_id, day, device));` `CREATE TABLE IF NOT EXISTS storefront_vitals_marks (store_id TEXT NOT NULL, day TEXT NOT NULL, device TEXT NOT NULL, visitor TEXT NOT NULL, PRIMARY KEY (store_id, day, device, visitor)) WITHOUT ROWID;` Baghdad day (`baghdadTime.ts:86`); pruned with `storefront_event_marks` by the existing prune. Buckets at the Web Vitals thresholds (2.5/4 s, 200/500 ms, 0.1/0.25); the verdict is the bucket holding the 75th sample — «مقدَّر من الفئات». |
| S4 | Weight audit | **NEW** `worker/lib/storeSpeed.ts` + `GET /api/merchant/store/layout/speed?source=published|draft` (`requireStoreOwner`, `private, no-store`) | Media keys of background + header logo/banner + hero + first two blocks via `collectLayoutRefs`, plus the first product row's `images` keys; `SELECT object_key, byte_size, mime_type FROM file_objects WHERE owner_id=?1 AND object_key IN (json_each(?2))`; returns `{first_view:[{block_id,label,bytes,mime}], fixed:{app_kb, font_kb}, findings:[{code, block_id, params}]}`. Closed codes: `HERO_HEAVY`, `HERO_GIF`, `POSTER_MISSING`, `BACKGROUND_VIDEO_ON_PHONE`, `AUTOPLAY_VIDEO_COUNT`, `ABOVE_FOLD_BLOCKS`, `PRODUCT_IMAGES_LARGE`, `OK_IMAGES`. Copy lives in `storeDesign/strings.ts`, never server text. |
| S5 | Report route | **NEW** `GET /api/merchant/store/speed?days=7|28` | `{rum:{days[], verdict, p75_bucket:{lcp,inp,cls}, samples}, weight, findings}`. |
| S6 | Attention | **EXTEND** `merchantWorkspace.ts` (`source()` pattern `:142+`, `StoreProblem` `:78-85`) | `source('speed')` → `{poor_days, samples, link: merchantHref.storeDesign()}` when the phone LCP p75 bucket is `poor` on 3 consecutive days with ≥ 30 samples each; client `attention.ts:44-51` + a `CommandCenter.tsx:107-127` row whose ar/en/ckb words live in `storeDesign/strings.ts` first and are reused verbatim by the shell (the shell test `:315-331` requires every ckb word to exist elsewhere). |
| S7 | PSI | **NEW zero-cost link**; Worker-side PSI **optional, owner question** | `<a href="https://pagespeed.web.dev/analysis?url=<store url>" target="_blank" rel="noopener">` — not a fetch, so `connect-src` (`securityPolicy.ts:139`) is irrelevant. Shown as a separate «قياس مختبري» tile, never mixed with RUM. |

### 4.6 Lookbook («تسوّق المشهد») — Phase D, budget-gated

**NEW block** `lookbook: { variants:['single'], settings:{ title, image:{t:'media',kind:'image',max_bytes:1.5·MB}, spots:{t:'list', max:6, requires:['product'], item:{ x:{t:'int',min:0,max:100,d:50}, y:{t:'int',min:0,max:100,d:50}, product:{t:'ref',ref:'product'} } } } }`. Hotspots `<button className="absolute w-11 h-11 lv-hit" style={{left:x+'%', top:y+'%', transform:'translate(-50%,-50%)'}}>` (physical %, the picture is not mirrored) with a `size-6 rounded-full bg-white/70` dot (`ring-4` exists; `border-4` does not); the active product renders a `ProductCard` in a `.sf-card` beside/below with `layoutId` `spring('move')`. Picked products already arrive through `BlockData.picked` (`linkedProducts` walks list items, `data.ts:65-76` — extend to `ref` specs inside lists).

### 4.7 Refusal codes (server → `src/lib/refusalStrings.ts` + `storeDesign/refusal.ts`; `tests/refusalStrings.test.ts:48-92`: ar ≠ en ≠ ckb, no code leaks)

| Code | ar | en | ckb |
|---|---|---|---|
| `LAYOUT_MEDIA_TOO_HEAVY` | الملف {size} يتجاوز حدّ هذا الموضع ({max}). اضغطه أو اختر ملفًا أخف. | The file is {size}, over this slot's {max} limit. Compress it or pick a lighter one. | فایلەکە {size}ـە و لە سنووری ئەم شوێنە ({max}) زیاترە. بچووکی بکەرەوە یان فایلێکی سووکتر هەڵبژێرە. |
| `LAYOUT_POSTER_REQUIRED` | اختر صورة ملصق للفيديو حتى يظهر شيء قبل التشغيل. | Pick a poster image so something shows before the video plays. | وێنەی پۆستەر بۆ ڤیدیۆکە هەڵبژێرە تا پێش لێدان شتێک دەربکەوێت. |
| `MEDIA_IN_USE` | هذا الملف مستخدم في: {where}. أزله من هناك أولًا. | This file is used in: {where}. Remove it there first. | ئەم فایلە بەکارهاتووە لە: {where}. سەرەتا لەوێ لایبە. |
| `SHOWCASE_VIDEO_KIND` | هذا الملف ليس فيديو يعمل في المتصفح — ارفع MP4 أو WebM. | This file is not a browser-playable video — upload MP4 or WebM. | ئەم فایلە ڤیدیۆیەک نییە کە لە وێبگەڕدا کار بکات — MP4 یان WebM بار بکە. |
| `SHOWCASE_PRODUCT_NOT_YOURS` | المنتج المربوط ليس من منتجات متجرك المتاحة. | The linked product is not one of your store's live products. | بەرهەمە بەستراوەکە لە بەرهەمە بەردەستەکانی فرۆشگاکەت نییە. |
| `REELS_SOURCE_NOT_ENABLED` | عرض منشوراتك كمقاطع في المتجر غير مفعّل بعد. | Showing your posts as store clips is not enabled yet. | پیشاندانی بڵاوکراوەکانت وەک کلیپ لە فرۆشگادا هێشتا چالاک نەکراوە. |

---

## 5. Motion spec (every spring through `useMotion()`, `src/lib/motion.ts:127-143`; `SPRING` `:62-86`; `CROSS_FADE` `:91`)

| Moment | Spring / rule | Reduced motion |
|---|---|---|
| HostBar appears / leaves | `motion.nav initial={{opacity:0, y: travel(-12)}} animate={{opacity:1, y:0}} exit symmetric` `spring('ui')` | `CROSS_FADE` |
| Tab indicator (Clips tab), collection chips | existing `TabStrip` `layoutId` → `spring('move')` | cross-fade |
| Hero / background video wakes | `<video>` opacity 0 → 1 over 150 ms CSS after `canplay` (colour/opacity only, MOTION §٢) | video never mounts |
| Card second frame | `src` swap on pointer/focus; no transform | same (state, not motion) |
| Reels open / close | `Overlay` panel from the tapped poster (`anchor`) with `spring('sheet')`; close symmetric (MOTION §٣) | fade |
| Reel change | native `scroll-snap` on touch; keys/arrows `scrollTo({behavior:'smooth'})`; nothing sprung | `behavior:'auto'` |
| Thread fill | `scaleX` from `timeupdate` in rAF — it is a clock, not a gesture | same |
| Shop chip | `initial {y: travel(24), opacity 0} → {y:0, opacity 1}` `spring('sheet')` on slide activation | opacity only (`travel()` = 0) |
| Mute / play glyph | `spring('quick')` scale 0.9 → 1 on press-down; `press-scale` on the disc | swap |
| «أُضيف» → «عرض السلة ›» | label crossfade + link row `y: travel(8) → 0` `spring('ui')` | fade |
| Cart pill count change | scale .9 → 1 `spring('ui')` | fade |
| Print sheet | `Sheet` v2 (`spring('sheet')` inside `Overlay`, `Overlay.tsx:562-570`) | built-in fade |
| Block reveal (`motion` token) | **CSS only, 0 JS**: `@supports (animation-timeline: view()) { @media (prefers-reduced-motion: no-preference) { [data-sf-motion='calm'] .sf-stack > * + * { animation: sf-rise linear both; animation-timeline: view(); animation-range: entry 0% entry 25%; } } } @keyframes sf-rise { from { opacity:.001; translate: 0 12px } }`; `lively` = 20px + `scale(.98)`. The hero (first child) never animates; browsers without scroll-driven animations show the page static. | off by media query |
| Speed bars | `motion.span animate={{scaleX}} transition={spring('ui')}` with `transformOrigin` by `dir` | jump |
| Builder block insert / remove | existing `Reorder.Group` under `MotionConfig reducedMotion="user"` (`BlockList.tsx:88`) | — |
| Press | base `:active` dim (`index.css:646-657`); `press-scale` (`:661`) only on tiles, discs, chips, hotspots | dim stays |

Never: parallax, Ken Burns, autoplay outside the opened viewer, `AnimatedItem`, invented durations (`tests/communitySocialUi.test.ts:133-135` pattern extended to the new folders).

---

## 6. Theming and CSS-budget strategy

**Facts.** CSS 61,361 B gz of 61,440 (79 B). `src/index.css:63` is a bare `@import "tailwindcss";` (no `source()` restriction); the built CSS still holds stray selectors generated from non-UI text — `32xl`, `text-[>16px]`, `shadow/log-only` are present in `dist/assets/index-*.css`. `theme.css` is 9,004 B raw (~1.5 KB gz) and counts.

**Pay first (Phase A, one PR, measured):**
1. `@import "tailwindcss" source("../src");` plus `@source "../index.html";` and `@source "../packages/storeLayout/src";` — then `npm run build && node --test tests/bundleBudget.test.ts` (`:429-440` prints the total). The freed amount **is the spend ceiling** for this track.
2. `parts.tsx:144` `bg-[#10161f]/85` → `bg-black/60` (present in 9 files): removes one arbitrary utility and the hex. `parts.tsx:149` `bg-red-600/90 text-white` → `bg-danger text-snow` (both present; payback only if no other file uses `bg-red-600/90` — measured, not assumed). `active:scale-[0.98] transition-transform` → `press-scale` on the card (house pattern; no payback claimed — `Storefront.tsx:492` still uses it).
3. Not a payback: `drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]` at `Storefront.tsx:404` shadows an **SVG glyph**; `text-shadow` would not. It stays.

**Spend, itemised, all in `theme.css`, capped by the measured payback (worst case: 79 B → only items marked ★ ship, the rest go inline or wait):**
- ★ `[data-sf-bg]` surface variables + glow-off rule ≈ 110 B (the dim itself is inline).
- Notice line 0 B (`sf-card`, `border-s-2`, `{accent.line}`).
- HostBar 0 B (`material material-thin scroll-edge`, `sticky top-0 z-30`, `h-12`).
- Reels shelf + viewer 0 B (inline `aspect-ratio`, `scroll-snap-type/align`, `scaleX`; `bg-white/20`, `bg-white/70`, `max-h-[88dvh]`, `h-dvh`, `lv-bleed-scrim`, `pb-safe`, `hide-scrollbar`, `snap-start` all present).
- Speed tab ≤ 60 B (KpiTile/DataList/Segmented exist; bar = `bg-surface-selected` + `bg-gold`, width inline — no `bg-accent/30`).
- Motion token ≈ 170 B — only if the payback ≥ 300 B.
- Lookbook dot 0 B (`size-6 rounded-full bg-white/70 ring-4`).
- Three accents ≈ 250 B in the generated ramps (`scripts/theme-tokens.mjs`, `tests/themeSystem.test.ts:87-104`) — last, only inside the remaining payback.

**Storefront closure ledger (47 KB, 46.2 today):** + hero video hook 0.15, + background poster layer 0.25, + notice 0.15, + footer links 0.10, + HostBar slot + sentinel 0.35 (in the `Storefront` page chunk), + card 2nd frame / `has_video` 0.15, + schedule filter 0.08, + search field 0.20 ≈ **+1.43 KB**; − `profileIcons` 1.3 KB (static import `Hero.tsx:18`; its own chunk already, 1,309 B gz, verified inside the closure) via `lazy()` in the info cards with a 16 px placeholder; − `attributes` 1.5 KB (`ProductFacts`, `StorefrontProduct.tsx:341`, below the fold) and − `governorates` 0.6 KB lazy behind first paint → **net ≈ −2.0 KB**. `ReelsViewer`, `BackgroundVideo`, `HeroVideo`, `Reels`, `Lookbook`, `PrintRequestSheet`, `MoreFromStore`, `storeVitals.ts` are lazy by construction. The pin at `bundleBudget.test.ts:303` is not raised.

**Theme rules kept:** tokens are names only (`tokens.ts:1-16`, MERCHANT_PLATFORM §4.4 `:149`, DECISIONS 122(١)); every new token = one enum + one `data-sf-*` attribute (`theme.ts:64-77`) + one attribute selector; stores stay a dark island (`tests/themeSystem.test.ts:224-229`); the builder's Speed tab reads on the light workspace with `bg-surface`, `text-text-*`, `success/warning/danger` tokens.

---

## 7. Localisation plan

**Files (new, outside `ui/` and `merchant/shell/`):** `src/components/storefront/strings.ts` (search, doors, notice, reels, background hints, order/store lines), `src/components/storefront/reels/strings.ts` may fold into it; `src/components/merchant/storeDesign/strings.ts` (media library, speed, findings, attention words); refusal sentences in `src/lib/refusalStrings.ts` (§4.7). Shape: `export const STRINGS = { ar: {...}, en: {...}, ckb: {...} } as const` + a typed `t(lang)` like `community/projects/strings.ts`. `LocalizedText` in the layout stays `{ar,en,ckb}` (`packages/storeLayout/src/text.ts:17-21`). Numbers, durations, prices are LTR islands with `tabular-nums`; no letter-spacing on Arabic/Kurdish (theme.css `:141`, MOTION §٩).

**Policy prerequisite:** DECISIONS row 167 extends D6 (`COMMUNITY_ECOSYSTEM.md:138`) to `src/components/storefront/**` and `merchant/storeDesign/**`; until it lands, the same keys ship with Arabic under the `OWNER` marker (`MERCHANT_PLATFORM.md:276-281`) and no screen changes when the Sorani is switched on. The shell's own words (`CommandCenter.tsx:107-127`) stay under their markers; the speed row reuses the strings-file Sorani verbatim.

**Core table (excerpt — the full table lands in the files):**

| Key | ar | en | ckb |
|---|---|---|---|
| reels.title | مقاطع المتجر | Store clips | کلیپەکانی فرۆشگا |
| reels.emptyBuilder | لا مقاطع بعد — ارفع أول مقطع من معرض ورشتك. | No clips yet — upload your first from your workshop showcase. | هێشتا هیچ کلیپێک نییە — یەکەم کلیپ لە پیشانگای وەرشەکەتەوە بار بکە. |
| reels.loading | جارٍ تحميل المقاطع… | Loading clips… | کلیپەکان بار دەکرێن… |
| reels.error | تعذّر تشغيل المقطع. حاول مرة أخرى. | The clip could not play. Try again. | کلیپەکە لێنەدرا. دووبارە هەوڵ بدە. |
| reels.of | المقطع {n} من {N} | Clip {n} of {N} | کلیپی {n} لە {N} |
| reels.mute / unmute | كتم الصوت / تشغيل الصوت | Mute / Unmute | بێدەنگکردن / دەنگ کردنەوە |
| reels.play / pause | تشغيل / إيقاف مؤقت | Play / Pause | لێدان / وەستاندن |
| reels.shop | اطلب هذا المنتج | Shop this product | ئەم بەرهەمە بکڕە |
| reels.tapToPlay | اضغط للتشغيل | Tap to play | بۆ لێدان دەست لێبدە |
| reels.saveData | الاتصال بطيء — نعرض الصور أولًا. | Slow connection — showing pictures first. | هێڵی ئینتەرنێت خاوە — سەرەتا وێنەکان پیشان دەدرێن. |
| search.placeholder | ابحث في المتجر | Search this store | لە فرۆشگادا بگەڕێ |
| search.empty | لا نتائج لـ «{q}» | No results for “{q}” | هیچ ئەنجامێک بۆ «{q}» نییە |
| search.error | تعذّر البحث الآن. | Search is unavailable right now. | ئێستا گەڕان بەردەست نییە. |
| bar.label | شريط المتجر | Store bar | شریتی فرۆشگا |
| bar.quote | عرض سعر | Quote | نرخ |
| door.ask | اسأل عن هذا المنتج | Ask about this product | دەربارەی ئەم بەرهەمە بپرسە |
| door.print | اطلب طباعة من هذا المتجر | Request a print from this store | داوای چاپکردن لەم فرۆشگایە بکە |
| door.printLike | اطلب طباعة مثلها | Request a print like this | داوای چاپێکی وەک ئەمە بکە |
| door.viewCart | عرض السلة | View cart | سەبەتە ببینە |
| quote.estimate | تقدير تقريبي: {low}–{high} د.ع | Rough estimate: {low}–{high} IQD | خەمڵاندنی نزیکەیی: {low}–{high} د.ع |
| quote.needsFile | التقدير يحتاج ملفًا مقيسًا أو رابطًا معروفًا. | An estimate needs a measured file or a known link. | خەمڵاندن پێویستی بە فایلێکی پێوراو یان بەستەرێکی ناسراوە. |
| quote.loading | جارٍ حساب التقدير… | Working out the estimate… | خەمڵاندنەکە دەژمێردرێت… |
| quote.error | تعذّر حساب التقدير، ويمكنك الإرسال بدونه. | The estimate could not be worked out; you can still send. | خەمڵاندنەکە نەژمێردرا، بەڵام دەتوانیت بەبێ ئەو بینێریت. |
| quote.why | لماذا هذا السعر | Why this price | بۆچی ئەم نرخە |
| quote.sent | أُرسل طلبك إلى المتجر وحده — سيصلك عرضه في المحادثة. | Your request went to this store alone — its offer arrives in the chat. | داواکارییەکەت تەنها بۆ ئەم فرۆشگایە نێردرا — پێشنیارەکەی لە گفتوگۆدا پێت دەگات. |
| order.from | طلبك من {store} | Your order from {store} | داواکاریەکەت لە {store} |
| notice.label | شريط الإعلان | Announcement bar | شریتی ڕاگەیاندن |
| notice.dismiss | إخفاء الإعلان | Hide the notice | شاردنەوەی ڕاگەیاندن |
| hero.video | فيديو الغلاف | Cover video | ڤیدیۆی بەرگ |
| hero.videoOnPhone | يعمل على الهاتف أيضًا | Play on phones too | لە مۆبایلیشدا کار بکات |
| bg.label | الخلفية | Background | پاشبنەما |
| bg.dim.light / medium / heavy | تعتيم خفيف / متوسط / عميق | Soft / medium / deep dim | تاریککردنی سووک / مامناوەند / قووڵ |
| bg.phoneStill | على الهاتف تُعرض الصورة الثابتة بدل الفيديو | Phones see the still image instead of the video | لە مۆبایلدا وێنەی جێگیر دەبینرێت لە جیاتی ڤیدیۆ |
| token.motion.none / calm / lively | ثابت / هادئة / حيّة | Still / Calm / Lively | وەستاو / هێمن / زیندوو |
| media.usedIn | مستخدم في: {where} | Used in: {where} | بەکارهاتووە لە: {where} |
| media.posterCaptured | التُقط ملصق من الفيديو. | A poster was captured from the video. | پۆستەرێک لە ڤیدیۆکە گیرا. |
| media.uploading | جارٍ الرفع {p}٪ | Uploading {p}% | بار دەکرێت {p}٪ |
| media.tooHeavyPick | هذا الملف {size} — الحد هنا {max}. | This file is {size} — the limit here is {max}. | ئەم فایلە {size}ـە — سنوور لێرە {max}ـە. |
| speed.title | سرعة متجري | My store's speed | خێرایی فرۆشگاکەم |
| speed.empty | لا قياسات بعد. تأتي الأرقام من زيارات حقيقية لمتجرك خلال اليوم. | No measurements yet. The numbers come from real visits to your store during the day. | هێشتا هیچ پێوانەیەک نییە. ژمارەکان لە سەردانە ڕاستەقینەکانی فرۆشگاکەتەوە دێن لە ماوەی ڕۆژدا. |
| speed.loading | جارٍ حساب السرعة… | Measuring… | خێرایی دەپێورێت… |
| speed.error | تعذّر تحميل تقرير السرعة. | The speed report could not be loaded. | ڕاپۆرتی خێرایی بار نەکرا. |
| speed.good / ok / poor | سريع / مقبول / بطيء | Fast / Okay / Slow | خێرا / باشە / خاو |
| speed.lcp / inp / cls / ttfb | ظهور الصفحة / الاستجابة / ثبات الصفحة / أول بايت | Page shows / Response / Stability / First byte | دەرکەوتنی لاپەڕە / وەڵامدانەوە / جێگیری لاپەڕە / یەکەم بایت |
| speed.weight | وزن الشاشة الأولى | First-screen weight | کێشی یەکەم شاشە |
| speed.fixed | ثابت لكل متاجر Levonis | Fixed for every Levonis store | جێگیرە بۆ هەموو فرۆشگاکانی Levonis |
| speed.samples | من {n} زيارة | from {n} visits | لە {n} سەردان |
| speed.HERO_GIF | غلافك GIF بحجم {size} — استبدله بفيديو أو صورة WebP | Your cover is a {size} GIF — replace it with a video or a WebP picture | بەرگەکەت GIFـێکە بە قەبارەی {size} — بە ڤیدیۆیەک یان وێنەیەکی WebP بیگۆڕە |
| speed.HERO_HEAVY | صورة الواجهة {size} — استخدم صورة أخف من 400 KB | The header image is {size} — use one under 400 KB | وێنەی سەرەتا {size}ـە — وێنەیەکی سووکتر لە 400 KB بەکاربهێنە |
| speed.AUTOPLAY_VIDEO_COUNT | {n} فيديوهات تعمل تلقائيًا — اترك واحدًا | {n} videos autoplay — keep one | {n} ڤیدیۆ خۆکار کاردەکەن — تەنها یەکێک بهێڵەوە |
| speed.ABOVE_FOLD_BLOCKS | {n} أقسام قبل المنتجات — الزائر يبحث عن المنتجات أولًا | {n} sections before the products — visitors look for products first | {n} بەش پێش بەرهەمەکان — سەردانکەر یەکەم جار بەدوای بەرهەمدا دەگەڕێت |
| speed.POSTER_MISSING | فيديو بلا ملصق — يظهر مربع أسود قبل التشغيل | A video without a poster shows a black box before it plays | ڤیدیۆیەک بەبێ پۆستەر — پێش لێدان چوارگۆشەیەکی ڕەش دەردەکەوێت |
| speed.openBlock | افتح القسم | Open the section | بەشەکە بکەرەوە |
| speed.psi | افحص في PageSpeed (رابط خارجي) | Check in PageSpeed (external) | لە PageSpeed بیپشکنە (بەستەری دەرەکی) |
| speed.honesty | الأرقام من زوار حقيقيين لمتجرك، لا من أداة. | Numbers come from your real visitors, not from a tool. | ژمارەکان لە سەردانکەرانی ڕاستەقینەی فرۆشگاکەتەوەن، نەک لە ئامرازێکەوە. |
| attention.speed | صفحة متجرك بطيئة على الهواتف منذ 3 أيام — راجع «سرعة متجري». | Your store page has been slow on phones for 3 days — see “My store's speed”. | لاپەڕەی فرۆشگاکەت لە مۆبایلدا ٣ ڕۆژە خاوە — «خێرایی فرۆشگاکەم» ببینە. |
| block.reels.name / line | المقاطع / مقاطع قصيرة رأسية من ورشتك، تُفتح في عارض | Clips / Short vertical clips from your workshop, opened in a viewer | کلیپەکان / کلیپی کورتی ستوونی لە وەرشەکەت، لە بینەرێکدا دەکرێنەوە |
| block.lookbook.name | تسوّق المشهد | Shop the look | دیمەنەکە بکڕە |
| schedule.label | يظهر من … إلى … | Show from … to … | لە … تا … پیشان بدە |

---

## 8. Accessibility checklist

- [ ] HostBar is `<nav aria-label>` in flow; four `IconButton`s (44 px, required `label`, `ui/Button.tsx`); it never covers the overlay corners (it appears only after they scroll out, or replaces nothing when inline in `bar`); under `prefers-reduced-transparency` the material goes solid (`index.css:766-775`).
- [ ] Hero/background video `aria-hidden`, `muted`, no controls; poster `<img alt="">` (the name is the `<h1>`); never mounts under `prefers-reduced-motion` or `saveData`; never on a phone unless opted in.
- [ ] Contrast over a background: `dim ≥ .45`, cards at `α .82` black → worst case (white picture): card luminance ≈ 0.55 × 0.18 ≈ 0.10, zinc-300 (L ≈ 0.72) reads at ≈ 5.1:1; bare text is never placed over the picture (renderer wraps blocks in `sf-card`). `tests/themeSystem.test.ts:106-124` gains this assertion for the three dims.
- [ ] Notice line `role="note"`, one per page, dismiss button labelled, icon + text (never colour alone).
- [ ] Search: visible `sr-only` label + placeholder, `type="search"`, `enterKeyHint="search"`, results region `aria-live="polite"` with a count; `?q=` in the URL so Back restores.
- [ ] Product card: one link per tile; heart a separate `aria-pressed` button (exists); `▶` `aria-hidden` with «فيديو» in the link's `aria-label`; second frame on `focus-visible` too.
- [ ] Reels viewer: `Overlay` focus trap, `Esc`, `restoreFocus` to the poster; list `aria-roledescription="carousel"`, each slot `role="group" aria-label="المقطع n من N: {caption}"`; the thread `role="progressbar"` with `aria-valuenow`; mute `aria-pressed`; `aria-live="polite"` announces the slide; keyboard ↑/↓, PageUp/PageDown, Space, M, Esc; no clip starts under reduced motion or Save-Data (56 px play control instead); captions are text, not burned in.
- [ ] Doors row buttons ≥ 44 px (`lv-button-sm` inside `lv-hit`); the «عرض السلة» row does not steal focus.
- [ ] Print sheet: `Sheet` v2 header/footer, `focusFirstInvalid` on the file/link step, estimate region `aria-live="polite"`.
- [ ] Order tracker: timeline is an `<ol>`; a poll update announces via the existing toast, never by refocusing.
- [ ] Builder Speed tab: `KpiTile`s carry text verdicts; bars `aria-valuenow`; findings are a list of real buttons with `loadingLabel`; undo stays ⌘Z.
- [ ] Lookbook hotspots are 44 px buttons labelled with the product name; the active card region `aria-live="polite"`.
- [ ] RTL: logical utilities only (`start/end`, `ps/pe`, `border-s`); every horizontal travel through `useMotion().inline()`; the thread's `transformOrigin` follows `dir`; arrows mirror (`rtl:-scale-x-100` present); durations, prices, KB are `dir="ltr"` islands with `tabular-nums`.
- [ ] ar/en/ckb everywhere from the strings files; line-height ≥ 1.15; no uppercase/tracking on Arabic or Kurdish.
- [ ] Focus rings `focus-visible:ring-2 focus-visible:ring-focus` on every new control (`uiPrimitives.test.ts:339-350` pattern).
- [ ] Both hosts and the installed PWA: every door works on `slug.levonis-iq.com` and `/community/store/:slug`; the viewer is a query on the same page, so no scope escape.
- [ ] Playwright: `scripts/e2e-store-builder.mjs` (prints `passes/failures`, `:263`) extended with the Speed tab and the reels block; new `scripts/e2e-reels.mjs` at 360/1280 in ar/en/ckb with reduced motion on and off.

---

## 9. Phased delivery (each phase ships alone, ends green on the pinned tests)

| Phase | Ships | Schema | Tests (pins that move, and the new ones) |
|---|---|---|---|
| **A — Pay back and fix** (no schema) | `source()` restriction + hex/red/press fixes; `profileIcons`, `attributes`, `governorates` lazy; skeletons (L1); eager hero poster for lazy variants (L2); success → `/orders/:id` (A5); `ku`→`ckb` (A9); `notifyOrderPlaced` for store orders (A8); reviews photos/filter/«المزيد» (L12); collection covers (L9); `has_video` + 2nd frame (L10); in-store search + sort (L11); post-add «عرض السلة» (A4 part) | none | `bundleBudget` numbers (closure must drop; CSS payback recorded in the PR); `storefrontBlocks` unchanged; new `tests/storefrontSearch.test.ts` (q escaping, store scoping, keyset), `tests/storefrontReviews.test.ts` (`?rating`, `?photos`); `tests/orderNotify` case for store orders; `tests/storefrontViews.test.ts:37-40` unchanged |
| **B — Media everywhere** (layout JSON only) | hero video + poster + phone rule (L3); background (L4); `max_bytes` (L5); notice (L6); footer links (L7); schedule (L8); media library v2 with `byte_size`, `used_in`, DELETE `MEDIA_IN_USE`, XHR progress, poster capture (B1); Page panel (B2); QR preview (B3); viewer shell in **images mode** for gallery/reviews; strings files; DECISIONS rows 167 (Sorani scope), 170 (caps + phones-see-the-still); motion token only if payback ≥ 300 B | none | `storeLayoutSchema` (tokens/keys), `storeDesignEditor.test.ts:81-84` round-trip with `background`/`footer.links`/`schedule`, `:446` starters; `storeDesignRoutes.test.ts:85-99` gains `byte_size`, `used_in`, DELETE refusal; `storeLayoutRoutes` gains `media_too_heavy`; `themeSystem` contrast for dims; `refusalStrings` for the new codes; `bundleBudget` lazy list gains `reels` |
| **C — Reels** | 0156; showcase write (W2); `GET /:slug/reels` (W3); `BlockData.reels` (W4); `reels` block (W5); `clips` tab (W6); viewer video mode (W7); poster capture in ShowcaseTab (W8); deep link + OG (W10); DECISIONS 168 (viewer autoplay); C2 posts source after row 169 | **0156_store_reels.sql** | `storeLayoutSchema.test.ts:59` 27 → 28 (29 with lookbook in D); `storefrontBlocks` file-per-type; new `tests/storefrontReels.test.ts` (one `<video>` mounted, no autoplay when reduced, poster required, product ownership, cache header); `tests/mediaRefs` registry count; `edgeCacheLifetime.test.ts` pattern for `/reels` |
| **D — Doors and journey** | HostBar (cart · chat · quote · search); ask-about-product (A1); store-addressed print sheet with link tab + estimate + `confidence_reasons` (A3); store identity on orders (A6); live tracker (A7); MoreFromStore; lookbook (budget-gated) + starter `reels_first`; **D2 after the community churn settles:** host `/chat/:id`, `/clips`, `/saved-items` in `App.tsx` | none | `bundleBudget` (HostBar inside the Storefront chunk, closure ≤ 47); `tests/storefrontIsolation` for the order payload's store fields; chat tests for open→card; `uiSystem.test.ts:102/112` (no `fixed bottom-0`); `communitySocialUi`-style tokens/`useMotion` check over `src/components/storefront/**` |
| **E — «سرعة متجري»** | 0157; reporter (S1); ingest (S2); audit (S4); report route (S5); SpeedPanel tab + PSI link (S7); attention source (S6); three accents last, inside the remaining payback (L15) | **0157_storefront_vitals.sql** | `storefrontEvents.test.ts` pattern for `/vitals` (bot filter, owner excluded, once per visitor/day/device, clamps, batch); `tests/storeSpeed.test.ts` (findings from fixture layouts, bucket p75); `merchantWorkspaceApi`/`merchantWorkspaceShell.test.ts:315-331` (attention words exist in the strings file); `themeSystem` generated block if accents ship |

**Coordination note (perf track, not this plan):** anonymous `/:slug` edge cache after `delivery_to_you` moves to `GET /:slug/delivery` (`storefront.ts:110-116`, `:389`); `?w=` renditions through `IMAGES` (`imageConvert.ts`); Range-from-cache in `uploads.ts:831-841`; review media Range. Prerequisites this track supplies: every card image request is already `loading="lazy"` with a `sizes` attribute ready for `srcset`; the reels route is cache-safe; the speed tab will show TTFB truthfully either way. Nothing in Phases A–C touches `src/App.tsx`, `src/components/community/**`, `worker/routes/community*.ts` or `worker/lib/notifications.ts`; `RequestWizard.tsx` (churn zone) is read, not edited — the sheet calls `printApi.quote` directly.

---

## 10. Open owner questions

1. **Sorani scope (row 167):** confirm real Sorani may be written in `src/components/storefront/**` and `merchant/storeDesign/**` (MERCHANT_PLATFORM §8 says never machine-written; D6 allows it for the community). Until then the same keys ship in Arabic under the OWNER marker.
2. **Viewer autoplay (row 168):** muted autoplay of the in-view clip only inside the viewer the shopper opened; posters everywhere else; off with reduced motion or Save-Data. Acceptable exception to ECOSYSTEM:724 / HOME_PLAN:101?
3. **Posts as store clips (row 169):** may a store show its owner's own public, published posts on its own page outside `communityGate()`? Until decided the block offers `showcase` only.
4. **Media caps (row 170):** hero/banner/background image 1.5 MB (GIF included), poster 400 KB, video 12 MB, gallery item 1 MB; background video desktop-only by default, phones see the still. Right numbers for Iraq?
5. **Migration numbers:** 0156/0157 assumed after 0155; renumber if the community workflow claims them first.
6. **PSI from the Worker:** the tab ships with the free outbound link; a Worker-side lab tile needs a key, a cache and a decision. Wanted later?
7. **Second Arabic typeface:** `typeface: 'cairo'|'tajawal'` as a closed token costs a self-hosted subset per store that picks it — after Cairo is self-hosted by the perf track, or never?
8. **Lookbook and three accents:** both are owner-fit but cost bytes; ship only if the measured `source()` payback covers them, or drop?
9. **Hero video on phones:** default off (poster only) with an opt-in per store — or never on phones at all?
10. **`/chat/:id` on the host (D2):** the installed store PWA leaves its scope on every chat until then; land it right after the community workflow settles, or hold for the CX track?
11. **Product-level reviews and Q&A** stay MISSING (store-level reviews only) — in scope for a later track?
12. **Which starters get video/reels by default:** `reels_first` only, or also `portfolio`/`workshop`?

### Files this plan touches
`packages/storeLayout/src/{blocks,schema,tokens,data,normalize,verify,defaults,starters}.ts` · `src/components/storefront/{StoreRenderer,StoreHeader,parts,runtime,theme,addressedView}.tsx|ts`, `theme.css`, `blocks/{Hero,HeroVariants,Tabs,Gallery,Reviews,Collections,extra,tabViews}.tsx`, NEW `blocks/{Reels,Lookbook}.tsx`, NEW `BackgroundLayer.tsx`, NEW `reels/{ReelsViewer,useActiveSlot}.tsx`, NEW `strings.ts` · `src/pages/{Storefront,StorefrontProduct,StoreCheckout,OrderDetail,Orders,Chat}.tsx` · `src/components/merchant/storeDesign/{StoreDesignPanel,panels,fields,pickers,catalog,refusal,BlockInspector}.tsx|ts`, NEW `speed/SpeedPanel.tsx`, NEW `strings.ts` · `src/components/merchant/dashboard/CatalogTabs.tsx` (ShowcaseTab) · `src/components/merchant/shell/{attention.ts,sections/CommandCenter.tsx}` (one row) · `src/components/chat/commerce/PrintRequestSheet.tsx` · `src/lib/{storeVitals(new),refusalStrings,api}.ts` · `worker/routes/{storefront,storeLayout,merchant,storefrontEvents,storeOrders,orders,merchantWorkspace}.ts` · `worker/lib/{storeLayout,mediaRefs,socialPreview}.ts`, NEW `worker/lib/storeSpeed.ts` · `migrations/0156_store_reels.sql`, `migrations/0157_storefront_vitals.sql` · docs: `DECISIONS.md` rows 167–170, `MERCHANT_PLATFORM.md` §4.4/§8 notes · tests named in §9 · `src/App.tsx` only in D2.

## 4. Track plan — journeys-pricing

# الخيط — The Thread, synthesised build plan (track «journeys-pricing»)

Measured against HEAD `b726a1c6` in `/home/user/Levonis` (read-only; every path below was opened). Winner across both judges is **الخيط — The Thread** (84 + 80 = 164; One Estimate 157; Counter 155). This plan keeps the Thread's device, contract and phasing, grafts what both judges flagged, and corrects every claim the re-verification refuted.

**Re-verification findings that change the plan (all opened):**

| Claim in the proposals | Fact at HEAD | Consequence |
|---|---|---|
| «61 B of CSS headroom» | `dist/assets/*.css` per-file gzip sum = **62,431 B** against `CSS_BUDGET = 60 * KB` = 61,440 B (`tests/bundleBudget.test.ts:63`, summed per file at `:429-438`; dist built 07:49, after the HEAD commit at 05:21) | The build is already **991 B over**. Phase 1's first PR restricts `@import "tailwindcss"` (`src/index.css:63`, Tailwind `^4.1.14` in `package.json:57`) with `source(...)` and measures; nothing else lands until the budget test passes. |
| «Retiring OrderTracker/Tools selectors frees ≥ 400 B» | `border-gold/30` ×2 rules, `from-gold/[0.07]` ×3, `bg-emerald-500/20` ×2, `text-[10.5px]` and `min-h-[18px]` present and shared — refuted (dist grep) | No selector-retirement ledger; the only lever is `source()`. |
| «snap-y / overscroll-y-contain are in the inventory» | dist has `snap-y` **0**, `overscroll-y-contain` **0**, `aspect-[9/16]` **0**, `grid-cols-[auto_minmax(0,1fr)]` **0**, `border-success/60` **0**, `bg-canvas/70` **0**; present: `h-dvh`, `snap-mandatory`, `snap-start`, `snap-x`, `snap-center`, `text-[30px]/[22px]/[17px]/[13px]/[12.5px]/[12px]/[11px]`, `min-h-[18px]`, `bg-success/15`, `bg-canvas/85`, `ring-gold/40`, `h-1.5`, `h-2.5`, `w-2.5`, `transition-[width]`, `motion-reduce:animate-none`, `aria-[current…]` | Clip snapping is inline `style={{scrollSnapType:'y mandatory', overscrollBehaviorY:'contain'}}` + `scrollSnapAlign`; 9:16 is inline `aspectRatio`. |
| «OrderDetail must stay under the 12 KB order-screen pin» | `ORDER_SCREEN_BUDGET` pins `OrderDetailScreen` = `src/components/merchant/orders/OrderDetailScreen.tsx` (merchant), `tests/bundleBudget.test.ts:410,418` | The customer `OrderDetail` is a route chunk with no pin; the Thread still ships lazy for the entry's sake, but the 12 KB argument is dropped. |
| «Direct drafts go through directRequests.ts» | The insert is `worker/routes/chatCommerce.ts:152-190`; `readJob` (`:97-115`) knows title/description/quantity/material/color/dimensions/budget/deadline/governorate/delivery_pref/customer_notes only; **both** `/:id/print-requests` and `/:rid/send` sit behind `requireCommunityOpen` (`:152`, `:196`; `worker/lib/communityGate.ts:233-237`) | Feature 14 extends `readJob` with the spec fields; the StoreDoor must word `COMMUNITY_CLOSED` as well as `STORE_NO_CUSTOM_REQUESTS` (`chatCommerce.ts:158-159`) and `MERCHANT_UNAVAILABLE` (`:166`). |
| `refusalStrings` words the closed door | `src/lib/refusalStrings.ts:632-636`: `STORE_NO_CUSTOM_REQUESTS.ckb` is the **Arabic** placeholder | The feature strings file carries real Sorani for `door.closed`; `refusalStrings` stays the fallback. |
| Migration «0156» | Files end at `0155_community_comment_replay.sql`; `docs/COMMUNITY_ECOSYSTEM.md` claims 0155 (L468, collides with the existing file), 0156 (L592), 0157 (L676), 0158 (L328) | This track's single migration is **`0159_customer_journeys.sql`** (provisional; take the next free number at merge). |
| Autoplay rule at ECOSYSTEM:680 | It is at `docs/COMMUNITY_ECOSYSTEM.md:745` («video tap-to-play, never autoplay») and `docs/COMMUNITY_HOME_PLAN.md:161`; `:101` forbids layout animation on list items | Thread's `motion.li layout` is dropped; ClipViewer ships tap-to-play; muted in-viewer autoplay is an owner question. |
| `print_analyses.source` CHECK at 0078:213 | `migrations/0078_print_quote_engine.sql:215` | Origin goes in a new column, as all three said. |
| `notifyOrderStatus(...,'placed')` | `notifyOrderPlaced` exists, `worker/lib/orderNotify.ts:229`, with ar/en/ckb placed texts (`:97, :112, :127`) | Reuse it from `storeOrders.ts` (today only `notifyMerchantOfStoreOrder`, `:1204`). |
| `useFreshOnReturn` «StoreCheckout only» | 11 files; `pollWhileVisibleMs` at `src/lib/useFreshOnReturn.ts:40,47,112-115`, used in `MerchantCartView.tsx:49`, `Checkout.tsx:834`, `StoreCheckout.tsx:278`, `Cart.tsx:650` | The live timeline is `useFreshOnReturn(load, { pollWhileVisibleMs: 20_000, enabled: !terminal })`; no `setInterval`. |
| Margin leak at 925/1245 | Confirmed `Number(body.target_margin_percent) || PLATFORM_TARGET_MARGIN_PERCENT` at `worker/routes/printQuote.ts:925`, `:1245` **and `:1469`** (`/analyses/:id/compare`, `requireAuth` only) | All three sites reviewed in Phase 1; public callers get the platform margin. |
| Sorani for workshop | `وۆرکشۆپ` 10 occurrences in 3 files; `وەرشە` 1 | Strings use وۆرکشۆپ. |

---

## 1. Concept (three sentences)

One 1-px gold line — **الخيط** — is drawn wherever the customer stands on a line with a known start and end: under the price estimate as a range track, down the order page as the timeline rail, across a clip as its progress, and under the in-store search field as its caret. One server contract, `Estimate`, feeds the wizard, the store door, the chat sheet and the calculator, explains itself in ordinal terms («لماذا هذا السعر؟») and never lets a cost line leave the Worker. Nothing new is added to the chrome or the systems: every journey (ask, request, price, find, watch, buy, track) attaches to a route, table and primitive that already exists, sized to a CSS budget that is already over and a 47 KB storefront closure with ~0.8 KB left.

## 2. Information architecture and navigation

```
Customer
├── FIND
│   ├── Store (host `/`, `/products`; apex `/community/store/:slug`)
│   │   ├── header: Back · [🔍 search pill] · [🛍 cart pill] · ⋯   ← two NEW runtime slots (runtime.tsx:35-45 has Back/Menu/ProfileActions/ServiceDoors/ChatButton/InstallCard)
│   │   ├── layout blocks (27, blocks.ts) + `store_posts` (Phase 5, lazy `extra`)
│   │   └── search: host `/products?q=&sort=` · apex `?tab=products&q=`      ← EXTEND storefront.ts:523
│   └── Product `/p/:slug`
│       ├── gallery · variants · qty · add  (EXISTS, StorefrontProduct.tsx)
│       ├── «أُضيف» → toast action «السلة»                             ← EXTEND (toastStore.ts:23,57-58)
│       ├── StoreDoor: «اسأل عن هذا» · «اطلب مثله»                    ← NEW component, EXISTS routes
│       └── «المزيد من هذا المتجر» (lazy, below the fold)              ← EXTEND
├── ASK   `/chat/:id` — the store thread; product card posted on open; host mounts the lazy Chat route
├── REQUEST — ONE composer (RequestComposer), three doors
│   ├── board  `/requests?view=new` (EXISTS RequestWizard)
│   ├── store  StoreDoor «اطلب مثله» / hero «اطلب عرض سعر» → Sheet, mode:'store' → chatCommerce.ts:152 → :196
│   └── chat   «طلب طباعة» (PrintRequestSheet.tsx becomes a thin host of the composer)
│       sources: file · link · photo+size · project     estimate live from step 2, same <EstimateCard/>
├── PRICE `/tools` (guest) — same <EstimateCard/>, «أرسله طلب طباعة» carries the analysis
├── BUY   `/cart` → `/store-checkout` → success → `/orders/:id`          ← EXTEND StoreCheckout.tsx:440
└── TRACK `/orders/:id` — the Thread timeline (store identity, events, live while open)
```

Routes added to the SPA: **none** on the apex; on the host (`StorefrontApp`, `src/App.tsx:402-431`) one lazy route `/chat/:id` (the `Chat` chunk already lazy at the apex `:680`). New query words: `q`, `sort` on the store products tab. New API routes: `GET /api/storefront/:slug/clips`, `POST /api/marketplace/print/requests/:id/files/from-link`, `POST /api/marketplace/print/requests/:id/files/from-analysis`, `POST /api/print-quote/from-link` (guest twin), `GET /api/marketplace/print/requests/:id/indicative`. Extended: `POST /api/marketplace/print/quote`, `POST /api/chats/open`, `POST /api/chats/:id/print-requests`, `GET /api/orders/:id/tracking`, `GET /api/orders` and `/:id`, `GET /api/storefront/:slug/products`, `PUT /api/merchant/printers/request-prefs` (`merchantPrinters.ts:509`).

## 3. Screen-by-screen spec

Type scale (all present in dist): number `text-[22px] font-black tabular-nums` → range `text-[17px] font-bold` → sentence `text-[13px] text-text-secondary` → facts `text-[12.5px] text-text-muted` → time `text-[11px]`. Every surface `lv-surface` (`src/index.css:304`), choices `lv-choice` (`:338`), hits `lv-hit` (`:331`), floating chrome `material material-thin` (`:709`).

### 3.1 EstimateCard — the one component (`src/components/estimate/EstimateCard.tsx`, lazy chunk `estimate`)

**360**
```
┌──────────────────────────────────────────┐
│ قيمة تقديرية                 ● ثقة متوسطة │  label text-[12.5px] text-text-muted · StatusChip tone=warning
│ 18,000 – 24,500 د.ع                      │  text-[17px] font-bold · <Money/> ×2 (bdi ltr, Money.tsx:44-45)
│ ─────────────●───────────────────────    │  THE THREAD: h-px bg-surface-raised; fill bg-gold via inline insetInlineStart/width
│ للقطعة 21,000                 ×4 قطع     │  text-[11px] text-text-muted tabular-nums
│ [لم يُقَس الملف] [أكثر من لون]            │  reason chips: lv-choice text-[12px] px-2.5 py-1 (tap → sheet)
│ الكمية  ×1  ×2  ×5  ×10                   │  Segmented size="sm" group="estimate-qty" (Segmented.tsx:49,64)
│ ▸ لماذا هذا السعر؟                        │  Button variant="ghost" size="sm" → Sheet
│ قيمة تقديرية — السعر النهائي من عرض      │  text-[12px] leading-relaxed text-text-muted
│ الوۆرکشۆپ.                                │
└──────────────────────────────────────────┘
```
Anatomy: `<section class="lv-surface px-4 py-3.5" data-wizard="estimate" aria-live="polite" aria-atomic="true">`; thread `<div class="relative h-px w-full bg-surface-raised" aria-hidden>` + `<span class="absolute inset-y-0 bg-gold" style={{insetInlineStart, width}}>` + marker `<motion.span class="absolute -top-1 h-2.5 w-2.5 rounded-full bg-gold" style={{insetInlineStart}}>` (scale: 0 = 0.6×low, 100 = 1.3×high — kept only as a *relative* cue; the text carries the meaning; owner may drop the marker, §10). `priced:false` → thread empty, `lv-alert lv-alert-info` sentence with the reason, two `lv-choice` rows «ارفع ملفًا» / «أدخل الأبعاد». Loading → `Skeleton` two rows (`Skeleton.tsx:26`); error → `ErrorState` (`AsyncStates.tsx:205`) with retry.

**«لماذا هذا السعر؟»** — `Sheet` v2 `detents={['medium','large']} dragHandle` (`Sheet.tsx:57-59,108`) on the phone, `Anchored` (`Overlay.tsx:757`, as `Menu.tsx` uses it) at ≥ 1024 px:
```
┌──────────────────────────────────────────┐
│ ━━━                                      │
│ لماذا هذا السعر؟         18,000 – 24,500 │  text-[17px] font-bold
│ ما يرفع السعر                             │
│  ● المادة              الأكبر            │  factors[]: gold dot = most · muted = some · omitted = little
│  ● زمن الطابعة          الأكبر            │
│  ○ الدعامات             أقل              │
│ يشمل   المادة · الطابعة · التجهيز        │  covers[] from cost-line KEYS only
│ لا يشمل   التوصيل إلى محافظتك            │  excludes[] (DELIVERY until W4)
│ ما يخفض الثقة                            │
│  ○ لم يُقَس الملف → ارفع STL/3MF          │  reasons[] (confidence_reasons codes + fix)
│ كلما زاد العدد                            │
│  ×1 21,000 · ×5 18,250 · ×10 16,900       │  quantity_curve[]
│ التقدير عند النشر: 17,500 – 23,000        │  revisions[].estimate when it differs (R6)
└──────────────────────────────────────────┘
```
Rows `<li class="flex items-start gap-2 py-2 text-[13px]">`; direction glyph in `text-success` / `text-warning` / `text-text-muted` with a `sr-only` word.

**1280 — composer**
```
┌───────────────────────────────────────┬──────────────────────────┐
│ 1 المصدر  2 المواصفات  3 التسليم  4 راجع │ قيمة تقديرية   ● الثقة  │  TabPanels order=['1','2','3','4'] (Tabs.tsx:219,231)
│ ─────────────●──────────────────      │ 18,000 – 24,500          │  card sticky (inline position:sticky; top from --nav-stack)
│ [FDM] [ريزن] [لست متأكدًا]             │ ───────●──────────       │
│ المادة  ○PLA ●PETG ○TPU ○لست متأكدًا    │ chips · ×1 ×2 ×5 ×10     │
│ الجودة  ○سريع ●قياسي ○ناعم              │ ▸ لماذا هذا السعر؟       │
│ ▸ خيارات أكثر: ألوان · تشطيب · دعامات   │──────────────────────────│
│   الألوان ×1 ×2 ×3   التشطيب [بدون][خفيف]│ وۆرکشۆپات قد تنفّذه (3)   │  Phase 4, after publish, opt-in
│   [تنعيم][تلوين]   الدعامات ●تلقائي ○بدون│  ▣ ورشة بغداد  19–23k     │
│ ─────────────────────────────────────  │  «تقديري — ليس عرضًا»     │
│ [رجوع]                    [التالي →]    │                          │
└───────────────────────────────────────┴──────────────────────────┘
```

### 3.2 Store quote door and product page StoreDoor

**360 — product page under the price**
```
┌──────────────────────────────────────────┐
│ ◀  [🔍 ابحث في المتجر…]   [🛍 2]   ⋯      │  header slots (bar variant, StoreHeader.tsx:22-46)
│ حامل هاتف مطبوع                   ♡ ⤴   │
│ 9,000 د.ع  ~~12,000~~  −25%              │
│ [ أضف إلى السلة ]                        │  EXISTS (StorefrontProduct.tsx:375-398) → toast.success + action «السلة»
│ ┌────────────────┐ ┌────────────────┐    │
│ │ 💬 اسأل عن هذا  │ │ 🖨 اطلب مثله    │    │  StoreDoor: 2× Button variant="secondary" size="sm"; lazy row beside ProductActions (:70)
│ └────────────────┘ └────────────────┘    │
│ عادةً يرد خلال ساعتين                     │  only when responds_within_minutes non-null (Phase 4)
│ المزيد من هذا المتجر  ▣ ▣ ▣ ▣ →           │  ProductShelf (parts.tsx:185), lazy below the fold
└──────────────────────────────────────────┘
```
Disabled state: when the store payload carries `accepts_custom_requests = 0` (`0030:92`) the quote button renders `aria-disabled` with `door.closed`; when the community gate is closed (`runtime.communityOpen` false, `Storefront.tsx:275`) it renders `door.communityClosed`; a refusal that still arrives (`STORE_NO_CUSTOM_REQUESTS`, `MERCHANT_UNAVAILABLE`, `COMMUNITY_CLOSED`) is worded by the strings table with `refusalStrings` as fallback.

**360 — the door sheet (mode:'store')**
```
┌──────────────────────────────────────────┐
│ ━━━            طلب إلى «مطبعة النور» وحده │  Sheet v2 header · detents ['large'] · dirty guard (Sheet.tsx:13)
│ يصلك العرض في محادثتك مع المتجر.          │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────┐│  SourcePicker: 4 lv-choice tiles, role=radio, 44 px
│ │ ملف    │ │ رابط   │ │ صورة   │ │ قياس ││  (no «مشروع» in store mode)
│ └────────┘ └────────┘ └────────┘ └──────┘│
│ [ https://www.printables.com/model/…  ]  │  lv-input dir=ltr · «نقرأ الرابط…» role=status
│ ▣ Benchy — 60×31×48 مم — ملف مقيس ✓       │  link result (og:title/og:image cover, dims when fetched)
│ ─────────────●───────────────────────    │  EstimateCard compact
│ 18,000 – 24,500     ▸ لماذا؟              │
│ [أرسل الطلب إلى المتجر]                   │  lv-button lv-button-primary, in-flow
│ تريد عروضًا من عدة وۆرکشۆپات؟ انشره في   │
│ مجتمع ليفو ›                              │  EXISTS line (PrintRequestSheet.tsx:226-228)
└──────────────────────────────────────────┘
```
**1280**: the same sheet becomes `Overlay placement="center"` 720 px wide, form start / card end as in 3.1.

### 3.3 Chat with a product in hand (`/chat/:id`)

**360**
```
┌──────────────────────────────────────────┐
│ ◀ ▣ مطبعة النور                           │  EXISTS header
│           ┌────────────────────────┐     │
│           │ ▣ حامل هاتف · 9,000    │ أنت │  ProductCardView (ChatCardView.tsx:42) posted by the server on open
│           │ [افتح المنتج]          │     │
│           └────────────────────────┘     │
│  كم السعر؟  متى يجهز؟  هل يتوفر بلون آخر؟  │  existing chip row (Chat.tsx:403-409) with real ckb added
│ [+] [ اكتب رسالة…                 ] [➤]   │  in-flow bar (uiSystem.test.ts rule)
└──────────────────────────────────────────┘
```
**1280**: unchanged two-column chat; the card is the first message of the thread when the product is new to it.

### 3.4 In-store search (`src/components/storefront/blocks/tabViews.tsx` gains a lazy `Search` view)

**360**
```
┌──────────────────────────────────────────┐
│ ◀ [ Benchy|                        ✕ ]   │  Input type=search; the caret line: border-b border-gold (the thread)
│   الأحدث · الأرخص · الأغلى               │  Segmented sm (sort)
│ ┌────────────┐ ┌────────────┐            │
│ │  ▣         │ │  ▣  ▶      │            │  ProductCard (parts.tsx:110) — the ONE card; ▶ when has_video
│ │ Benchy PLA │ │ Benchy XL  │            │
│ │ 6,000      │ │ 9,500      │            │
│ └────────────┘ └────────────┘            │
│ 12 نتيجة · [المزيد]                       │  countNoun (src/lib/catalog/copy.ts:80); keyset «المزيد»
│ لم تجد ما تريد؟ [اسأل المتجر]             │  StoreDoor compact
└──────────────────────────────────────────┘
```
**1280**: the search pill centred in the header (max 480 px); results in the store's `gridClasses` (`theme.ts:84`) at 4 columns; sort as the same `Segmented`.

### 3.5 Order tracking — the live thread (`/orders/:id`, tab «التتبع»)

**360**
```
┌──────────────────────────────────────────┐
│ ◀  طلب #A1B2C3        [▣ مطبعة النور]     │  store identity (NEW on the payload): SafeImage 24 px + name
│ التتبع · العناصر · الدفع · الدعم           │  TabStrip (EXISTS)
│ ● استلمنا طلبك                 09:14 اليوم │  reached: bg-gold border-gold text-accent-contrast
│ │                                        │  rail: w-px min-h-[18px] bg-gold
│ ● المتجر يجهّز الطلب            10:02      │  current: + animate-pulse motion-reduce:animate-none while polling
│ │  «الطباعة بدأت، الطلب جاهز غدًا» 💬      │  event from the store's card announcement, text-[12.5px]
│ ┆                                        │  future: inline borderInlineStart '1px dashed'
│ ○ في الطريق إليك                          │
│ ○ تم التسليم                              │
│ رقم التتبع  LV-77812  [نسخ]               │  EXISTS
│ يتحدّث تلقائيًا · آخر تحديث قبل دقيقتين     │  role=status text-[11px]
└──────────────────────────────────────────┘
```
**1280**
```
┌─────────────────────────────┬───────────────────────────┐
│ ◀ الطلب #A1B2C3  ▣ مطبعة النور│ المنتجات (٢)   45,000 د.ع │  TabStrip in href mode (Tabs.tsx:41,62,106) down the start column
│ ● استلمنا طلبك    أمس ١٨:٠٢   │ ▣ حامل سماعات ×1          │
│ ● أكّد المتجر      أمس ١٨:٤٠   │ ▣ قاعدة هاتف  ×1          │
│ ● جارٍ التجهيز     اليوم ٠٩:١٥ │ التوصيل  الكرادة · الثلاثاء│
│ │ «الطباعة بدأت…»               │ الدفع    محفظة · مدفوع    │
│ ○ في الطريق إليك              │ [محادثة مع المتجر]        │
│ ○ تم التسليم                  │ [مشكلة في الطلب]          │
└─────────────────────────────┴───────────────────────────┘
```
`OrderTracker.tsx` keeps `data-order-tracker`, `data-stage`, `data-reached` (`:92,105`) and becomes a thin adapter over `src/components/journey/Thread.tsx`; the zinc/emerald set (`:79-140`) is replaced by tokens. Delivered → `StoreReceipt` docks under the rail; cancelled → `border-danger text-danger` dot with the reason.

### 3.6 Clips (`src/components/clips/ClipRail.tsx` in `extra`, `ClipViewer.tsx` own chunk)

**360 — rail on the store page / viewer**
```
┌──────────────────────────────┐   ┌──────────────────────────────────────────┐
│ مقاطع من الوۆرکشۆپ    الكل › │   │ ▬▬▬▬▬▬▬▬▬●─────────────  ✕                │  progress: h-px bg-gold, inline width
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐  │   │                                          │
│ │ ▶  │ │ ▶  │ │ ▶  │ │ ▶  │  │   │              [ 9:16 poster ]  ▶ (tap)     │  <video playsInline preload="metadata" poster muted>
│ │0:12│ │0:30│ │0:08│ │0:21│  │   │                                          │  poster = product's first image (always exists)
│ └────┘ └────┘ └────┘ └────┘  │   │ ▣ مطبعة النور                      🔇     │  material material-thin chips · IconButton
└──────────────────────────────┘   │ ┌────────────────────────┐               │
   useRail({snap:true}) tiles       │ │ ▣ حامل هاتف · 9,000 →  │               │  product chip → productHref
   style={{aspectRatio:'9/16'}}     │ └────────────────────────┘               │
                                    │ اسحب للأعلى للمقطع التالي ↑              │  first-run hint only
                                    └──────────────────────────────────────────┘
```
Viewer container: `Overlay placement="center" solid` (`Overlay.tsx:305,338`) + `fixed inset-0 bg-canvas h-dvh overflow-y-auto` with inline `scrollSnapType:'y mandatory'`, `overscrollBehaviorY:'contain'`; slides `h-dvh` with inline `scrollSnapAlign:'start'`; one mounted `<video>` per visible slide plus one ahead (MediaStrip's pause-off-slide, `MediaStrip.tsx:135`). **1280**: 9:16 frame centred at max 460 px, chips in a side column, ↑/↓ page.

### 3.7 Calculator (`/tools`) on the same card — 1280
```
┌──────────────────────────────────────┬────────────────────────────────────────────────┐
│ [ملف] [رابط] [بالوزن]                │ قيمة تقديرية                      ● ثقة عالية   │  EstimateCard replaces Tools.tsx:1112-1144
│ ┌ اسحب ملف STL/3MF/OBJ ┐             │ 4,750 – 6,000 د.ع              للقطعة 5,250    │
│ └───────────────────────┘            │ ─────────●─────────                             │
│ 84×40×22 مم · 31 سم³ · ٣ س ٢٠ د     │ ▸ لماذا هذا السعر؟                             │
│ الطابعة (A1)(P1S) · المادة (PLA)      │ [ أرسله طلب طباعة → ]  الملف ينتقل معك بلا رفع │  from-analysis handoff
│ الكمية ×1 ×2 ×5 ×10 · الألوان (1)(2)  │ للتجار: المقارنة بين طابعاتك ›                 │  merchant compare stays
└──────────────────────────────────────┴────────────────────────────────────────────────┘
```

## 4. Feature list

Status words: EXISTS (reuse) / EXTEND (file) / NEW (route, component or column). Refusal codes are existing unless marked new.

### 4.1 The estimate contract (server spine)
| # | Item | Build | Where / facts |
|---|---|---|---|
| E1 | `Estimate` public shape `{priced, reason?, price_iqd, price_low_iqd, price_high_iqd, unit_price_iqd, quantity, confidence, reasons[], factors[{key, weight:'most'|'some'}], covers[], excludes[], quantity_curve[{qty, unit_iqd}], material_id, process, time_minutes, material_grams, range_basis?, engine:{name,version}}`; never `cost_lines/cost_iqd/floor_iqd/margin_percent/lines` | NEW module | `worker/lib/printEstimate/{contract,explain,index}.ts`; adapters from engine A `Quote` (`printPricing.ts:302-350`, reasons at `:570-598`) and engine B `publicQuote` (`printQuote.ts:1663-1673`) |
| E2 | `factors[]` as ordinal buckets from cost-line shares (≥ 40 % most, ≥ 15 % some, else omitted); `covers/excludes` from line keys (`printPricing.ts:291-298`) | NEW | `explain.ts`; test: `JSON.stringify` of the public payload never contains `cost_`, `floor_`, `margin_`, `lines` |
| E3 | Client `Quote` type gains the fields (`src/components/community/requests/api.ts:89-97` has none of them); `PublicQuote` (`src/lib/printApi.ts:118-131`) already types `confidence_reasons` | EXTEND | both types converge on `Estimate` |
| E4 | `quantity_curve` for qty ∈ {1,2,5,10} ∪ {requested}: pure re-run of the engine (log2 discount at `printPricing.ts:543`) | EXTEND | `printRequests.ts:473-520` `/quote`; `printQuote.ts:887` `/analyses/:id/quote` |
| E5 | Margin leak: public routes stop reading `target_margin_percent` (`printQuote.ts:925`, `:1245`; review `:1469` `/compare`) | NEEDS REFACTOR (security) | platform margin for every non-merchant caller |
| E6 | Support over-count in A (`printPricing.ts:383` uses `overhang_area_mm2` raw) → `max(0, overhang − bed_contact)` as `geometryAdapter.ts:231` | NEEDS REFACTOR | `printPricing.ts` |
| E7 | Catalogue GETs cached `public, max-age=60, s-maxage=300` via `edgeCache()/conditional()` (`worker/lib/publicApi/cache.ts:24,46`) | EXTEND | `printQuote.ts:320,366,390`; `printRequests.ts:207` |
| E8 | Estimate history: `/revisions` (`printRequests.ts:1448`) already returns `estimate` (`requestRevisions.ts:236,258`); client type at `api.ts:151-153` drops it | EXTEND | `api.ts`; WhyThisPrice «التقدير عند النشر» |
| E9 | `machine_hour_iqd` of `merchant_printers` reaches `priceForPrinter` (`printQuote.ts:1535`, override plumbing at `:1580`, `cost.ts:367-368`) | EXTEND | for indicative quotes only |
| E10 | Engine convergence: B reads admin `printPricingConfig` (constants at `printQuote.ts:112-115`), gains resin (`merchantWorkshop.ts:270-272` refuses today), A wrapped over B with a platform reference printer; `print_materials` (`0078:148-162`) has **no `process` column** — add in 0159 if convergence needs it | NEEDS REFACTOR (last phase) | `printQuote/*`, `printPricing.ts` |

### 4.2 Sources
| # | Item | Build | Where |
|---|---|---|---|
| S1 | Upload + analysis + preview | EXISTS | `printRequests.ts:251-312` |
| S2 | Typed size → estimate: `stated_dimensions_mm` (sent at `RequestWizard.tsx:137`) × `bbox_fill_factor` (NEW admin key in `printPricingConfig`, `printPricing.ts:225-258`; **owner sets it — no invented number**, DECISIONS 111); until set → `priced:false`, reason `GEOMETRY_NOT_MEASURED` | EXTEND | `printRequests.ts:502-505` |
| S3 | Link ladder: (a) `parseModelLink` (`externalModels.ts:81`) EXISTS; (b) provider JSON when `api_url` filled (all empty, `:52-56`) EXISTS; (c) **NEW** guarded `og:title/og:image` read via `guardedFetchBytes(url,{maxBytes:2 MB, maxRedirects:3, timeoutMs:8000})` (`fetchGuard.ts:222-224`, `validateOutboundUrl` `:97`); (d) **NEW** file download only from admin-configured `printLinkProviders[].download` templates, capped at `MODEL_MAX_BYTES` (`attachments.ts:42`), sniffed by `classifyAttachment` (`:84`), stored `origin='link'`, analysed by the existing pipeline; zip → `LINK_ARCHIVE_UNSUPPORTED` (new) with the «نزّل ثم ارفع» fallback | NEW route `POST /api/marketplace/print/requests/:id/files/from-link` (`rateLimit('model-link',40,3600)` as `:324`) | 0159: `community_request_files + origin TEXT NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload','link','project','analysis'))`, `+ source_url TEXT NOT NULL DEFAULT ''`. Refusals (new): `NO_FILE_IN_LINK`, `PROVIDER_NOT_CONFIGURED`, `LINK_FILE_TOO_LARGE`, `LINK_NOT_A_MODEL`, `FETCH_BLOCKED` |
| S4 | Guest twin `POST /api/print-quote/from-link` → `print_analyses` row (48 h token, `printQuote.ts:406-507` pattern); `source` CHECK (`0078:215`) → new column `origin_url TEXT NOT NULL DEFAULT ''` | NEW route + column | 0159 |
| S5 | Calculator → wizard: `POST /api/marketplace/print/requests/:id/files/from-analysis {analysis_id}` copies the private object (owner or token match) | NEW route | `Tools.tsx:564-565` navigates with the id instead of the link |
| S6 | Project source: `?project=` sent at `src/pages/community/Project.tsx:273` (churn zone), read by nobody → `Requests.tsx` reads it like `link` (`:99-125`) | EXTEND | wizard prefills title/cover; file only after ECOSYSTEM Phase 4 file rights |

### 4.3 Contact
| # | Item | Build | Where |
|---|---|---|---|
| C1 | `POST /api/chats/open {merchantId}` → store thread | EXISTS | `chats.ts:406`, merchant branch `:559-576` |
| C2 | `{merchantId, productId}`: verify `community_products.store_id = m.store_id`, then post the product card through `cardInsertStatement`/`postSystemCard` (`chatCards.ts:387,439`) with `existingCard` replay (`chatCommerce.ts:118-127`) so reopening never duplicates | EXTEND | `chats.ts`; `useOpenChat` (`Storefront.tsx:451-470`) gains the id |
| C3 | `formatMsgTime` checks `'ku'` (`Chat.tsx:70`) → `'ckb'` | NEEDS REFACTOR | one line |
| C4 | Customer chip row (`Chat.tsx:403-409`, ar/en only) gains real ckb from the strings file; merchant quick replies stay the merchant track's | EXTEND | `Chat.tsx` |
| C5 | Host `/chat/:id`: mount the lazy `Chat` route in `StorefrontApp` (`App.tsx:402-431`) **after** verifying `Chat.tsx`'s imports (`MotionCharacterHome` from `components/bloub`, `useChatPresence`, `AuthContext`) render inside the host tree; else keep `window.location` (`Storefront.tsx:464`) with `?next=` for one phase | EXTEND (conditional) | churn-zone file: one route line, rebased last |
| C6 | `responds_within_minutes`: nightly aggregate on the existing `*/15` cron (`wrangler.jsonc:206`, handler `worker/index.ts:818`) over `chat_messages` first-reply gaps; NULL until ≥ 10 samples; StoreDoor shows the line only when non-null (`response_minutes: null` today, `printMatchingStore.ts:371`) | NEW column | 0159: `merchant_stores + responds_within_minutes INTEGER` |

### 4.4 Request a print — one composer
| # | Item | Build | Where |
|---|---|---|---|
| R1 | Board wizard | EXISTS | `RequestWizard.tsx` |
| R2 | Live estimate from step 2: drop `step !== 4` (`:369`), debounce 400 ms, abort stale calls, keep the last priced answer while recomputing | EXTEND | `RequestWizard.tsx:365-378` |
| R3 | Send what `readSpec` already parses (`printRequests.ts:408-416`: infill, supports, colors ≤ 16, post-processing ≤ 600, quantity, accessories) — `wizardPayload` (`RequestWizard.tsx:123-143`) sends none; stored on `community_print_requests` (`0045:160-163`) | EXTEND | «خيارات أكثر» disclosure on step 2 |
| R4 | `mode:'store'`: composer in a Sheet from StoreDoor and the hero (`Storefront.tsx:60,288,483-499` → today the public board); publish path = `POST /api/chats/open` → `POST /api/chats/:id/print-requests` → files → `/:rid/send` (`chatCommerce.ts:152,196`) | NEW door, EXISTS backend | `src/components/estimate/RequestComposer.tsx` wrapping `RequestWizard` |
| R5 | `readJob` (`chatCommerce.ts:97-115`) gains `process, material_id, quality, infill_percent, colors_count, supports, post_processing_minutes, stated_dimensions_mm, source_url`, writes the `community_print_requests` side row (`0045:152+`) and stores the `Estimate` on the draft; `/quote` already prices the draft's files by `customer_id` (`printRequests.ts:485-491`) | EXTEND | required by every direct-mode estimate |
| R6 | `PrintRequestSheet.tsx` → thin host of the composer (`mode:'chat'`) | NEEDS REFACTOR | `src/components/chat/commerce/PrintRequestSheet.tsx` |
| R7 | Gate wording: `COMMUNITY_CLOSED` (from `communityClosedRefusal()`), `STORE_NO_CUSTOM_REQUESTS`, `MERCHANT_UNAVAILABLE` worded in the strings file; `refusalStrings` fallback | EXTEND | StoreDoor |

### 4.5 Find, buy, track
| # | Item | Build | Where |
|---|---|---|---|
| F1 | `GET /api/storefront/:slug/products` gains `q` (`likePattern` + `sqlLikeClause(PRODUCT_SEARCH, q)` from `worker/routes/community.ts:167,180`, store-scoped, ignored under 2 chars) and `sort=new|price_asc|price_desc` with the `(sort_value, id)` keyset the collection branch uses (`storefront.ts:548-567`); anonymous responses `public, max-age=60, s-maxage=120` with a sorted-query key | EXTEND | `storefront.ts:523-590`; `loadProducts({source, collection_id, cursor})` (`Storefront.tsx:289-298`) gains `q, sort` |
| F2 | Header slots `SearchDoor`, `CartPill` on `StorefrontRuntime` (`runtime.tsx:35-45`; preview renders `Nothing`, `:50`); `StoreHeader.tsx:22-46` draws them in both variants | NEW slots | `IconButton badge` (`Button.tsx:132,184`); count from one `GET /api/cart/merchant-items` read on mount (no shared cart context exists — `useAddToCart` at `src/components/chat/cards/useAddToCart.tsx:17` is per-action) |
| F3 | Lazy `Search` view in `blocks/tabViews.tsx`; host `/products?q=`, apex `?tab=products&q=` via `addressedView.ts` | NEW view | `parts.tsx:110` card, `Segmented sm`, `EmptyState`/`ErrorState` |
| B1 | Toast action after «أُضيف» (`StorefrontProduct.tsx:375-398`): `toast.success(title, {action:{label, onClick}})` (`toastStore.ts:23,57-58`) | EXTEND | — |
| B2 | Success → `/orders/<id>` (`StoreCheckout.tsx:440` links `/orders`) | EXTEND | — |
| B3 | «المزيد من هذا المتجر»: `loadProducts({source:'all'})` first 8 minus self on `ProductShelf` (`parts.tsx:185`), lazy | EXTEND | — |
| B4 | One card: `parts.tsx:110` `ProductCard` adopts `useMoney` (retiring `DinarPrice`, `:49`), fixes the hex at `:144` (`bg-[#10161f]/85` → `bg-canvas/85`, present in dist), gains `has_video` ▶ (worker `productCard`, `worker/lib/storeLayout.ts:111-122` adds it from `community_product_media`); `hub/ProductTile.tsx:18` stays the apex tile on the same slot order | EXTEND | — |
| K1 | `GET /api/orders/:id/tracking` (`orders.ts:5117-5150`, reads `stage, changed_at` only) gains `store:{slug,name,logo_url}|null` (join `merchant_stores` on `orders.merchant_id`; `orders.ts` has no such join today) and `events[{at, kind:'status'|'note', text}]` from `order_status_history.note` (`0028:70`) + the store's card announcements read by `card_ref` (`announceStoreOrder`, `chatCards.ts:514`; `merchant.ts:1201,1281`) — text in `lang` | EXTEND | `src/lib/api.ts:1133 OrderTrackingPublic`, `:930 ApiOrder` (+ list route `store_name/store_logo_url`) |
| K2 | `OrderDetail.tsx:253-280` loads once → `useFreshOnReturn(load, {minIntervalMs: 8_000, pollWhileVisibleMs: 20_000, enabled: !terminal})` with `quiet` (`:255`) | EXTEND | — |
| K3 | `OrderTracker.tsx` → `journey/Thread.tsx`, tokens replace zinc (`:79-140`), data attributes kept | NEEDS REFACTOR | — |
| K4 | Customer «placed» notice for store orders: `notifyOrderPlaced(env, orderId)` (`orderNotify.ts:229`, ar/en/ckb) beside `notifyMerchantOfStoreOrder` (`storeOrders.ts:1204`) | EXTEND | — |
| K5 | `orderNotify` status titles ar/en only (`:286-353`) → add ckb in the three-language shape `merchantNotify.ts:1-8` uses | EXTEND | — |

### 4.6 Workshops (indicative prices) and watch
| # | Item | Build | Where |
|---|---|---|---|
| W1 | `GET /api/marketplace/print/requests/:id/indicative` (owner of a published request): rows `community_request_matches WHERE request_id=? AND eligible=1 AND revision=r.revision` (`0045:209`, `0132:160`) joined to `merchant_request_prefs.show_indicative_price=1`, max 5 → `priceForPrinter` on `printer_id` (`0132:162`) with the merchant's economics (E9) and the **platform** margin → `{merchant:{id,name,slug,logo_url,rating}, price_low_iqd, price_high_iqd, confidence, delivery_iqd|null}`; delivery from `deliveryToGovernorate` (`worker/lib/merchantDelivery.ts:448`); `private, no-store`; direct mode quotes only the target (`assertDirectStanding`, `directRequests.ts:79`) | NEW route + column | 0159: `merchant_request_prefs + show_indicative_price INTEGER NOT NULL DEFAULT 0` |
| W2 | Opt-in switch in request prefs (`merchantPrinters.ts:467,509`; `PrintersTab.tsx`) labelled «تقديري — ليس عرضًا» | EXTEND | merchant track shows it; this track adds the column and the read |
| V1 | `GET /api/storefront/:slug/clips` (no migration): `community_product_media` video rows (`0126:178-190`) joined to their visible product → `{items:[{id, video_url, poster_url, duration_s|null, product:{id,slug,name,price_iqd}}]}`; poster = product's first image; anonymous `public, max-age=60, s-maxage=120` | NEW route | gate-independent; timelapse posts join only after the community-gate decision |
| V2 | `ClipRail` (`extra`), `ClipViewer` (own chunk): tap-to-play per slide, `preload="metadata"`, poster required, one ahead mounted, Range requests uncached (`uploads.ts:837-841`) so nothing prefetches beyond neighbours' metadata | NEW components | inline snap styles (dist has no `snap-y`) |
| V3 | `store_posts` block in `extra` (registry 27 → 28; `storeLayoutSchema.test.ts:59` pin moves; `storefrontBlocks.test.ts:145` one component per type): renders only when `runtime.communityOpen`; fetches `GET /api/community/posts?store=` (`communityPosts.ts:234-256`, behind `communityGate()` `:49`) as the viewer; hidden without placeholder when closed. **Not** a `TAB_KINDS` entry (`blocks.ts:95,374` defaults every kind on; `storeLayoutSchema.test.ts:189,334` pin the six) | NEW block (Phase 5) | `reels` block deferred: needs `merchant_video_upload` gating (`blocks.ts:83,271`) and a poster the media kind cannot produce |

### 4.7 Migration `migrations/0159_customer_journeys.sql` (additive, Phase 4)
```sql
ALTER TABLE community_request_files ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload'
  CHECK (origin IN ('upload','link','project','analysis'));
ALTER TABLE community_request_files ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE print_analyses          ADD COLUMN origin_url TEXT NOT NULL DEFAULT '';
ALTER TABLE merchant_request_prefs  ADD COLUMN show_indicative_price INTEGER NOT NULL DEFAULT 0 CHECK (show_indicative_price IN (0,1));
ALTER TABLE merchant_stores         ADD COLUMN responds_within_minutes INTEGER;   -- NULL = not enough data
-- Phase 5 only if convergence needs it: ALTER TABLE print_materials ADD COLUMN process TEXT NOT NULL DEFAULT 'fdm' CHECK (process IN ('fdm','resin'));
```
No new tables (`order_updates`, quick replies, away message are deferred to the merchant track / ECOSYSTEM Phase 5).

## 5. Motion spec (every value through `useMotion()`, `src/lib/motion.ts:127-143`; springs `ui/move/sheet/momentum/rotate/quick` at `:62-86`, `CROSS_FADE` at `:91`)

| Moment | Spring | What moves | Reduced |
|---|---|---|---|
| Estimate marker after an option change | `spring('move')` | the dot's `insetInlineStart` (animate the style value, not `layout`); the two `Money` values cross-fade in `AnimatePresence` (opacity only) | `CROSS_FADE`, `travel()` = 0 |
| Reason chip appears/disappears | `spring('quick')` | opacity + `y: travel(4)` | fade |
| Quantity ladder | `spring('ui')` (Segmented's own indicator) | indicator + marker | jump |
| «لماذا هذا السعر» / door / search sheets | `spring('sheet')` (Sheet v2 owns it); `Anchored` uses `ui` | the sheet; inner dots enter `spring('ui')`, no stagger | fade |
| Composer step change | `TabPanels` (`spring('move')`, direction by `dir`) | slides forward = logical inline direction | cross-fade |
| Tracking: new event on poll | `spring('ui')` | **only the new row** enters `opacity 0→1, y: travel(8)`; no `layout` on list items (HOME_PLAN:101) | fade |
| Tracking: current dot | CSS `animate-pulse motion-reduce:animate-none` **only while the poll is live** (non-terminal, tab visible) | opacity | none |
| Search results replace | `spring('ui')`, `opacity` + `y: travel(6)` on the grid as one, no per-card stagger | the grid | fade |
| Cart pill count | `AnimatePresence mode="popLayout"` on the digit, `spring('quick')`; `press-scale` on the badge | the badge | colour only |
| Clip snap after a flick | native scroll-snap; `useRail` (`useRail.ts:199`) + `spring('momentum')` for mouse drags | the slide | same |
| Clip mute toggle / StoreDoor press | `spring('quick')` icon swap; base `:active` dim | — | — |

No `transition={{duration}}` anywhere; the `communitySocialUi.test.ts:137+` spring guard is copied for the new folders.

## 6. Theming and CSS-budget strategy

Facts: total CSS gzip **62,431 B** (per-file sum, the way the test counts) vs 61,440 B; storefront closure ~46.2 of 47 KB; the entry must not grow.

1. **Payback first, measured** (Phase 1 PR #1): `@import "tailwindcss" source("../src")` plus explicit `@source` for `index.html` and `packages/*/src` at `src/index.css:63`, so class names in `docs/`, `worker/`, `tests/` and `migrations/` stop generating rules. Run `npm run build` + `node --test tests/bundleBudget.test.ts` in the PR; if the freed bytes are below 1 KB, the second lever is splitting `Tools.tsx`'s route CSS (it is the only importer of `from-gold/[0.07]`) — never raising the number.
2. **Zero new utility classes.** Every class named in §3 was counted in dist: `lv-surface`, `lv-choice`, `lv-hit`, `lv-alert-info`, `lv-input`, `lv-button*`, `material material-thin`, `bg-gold`, `bg-surface-raised`, `bg-surface-selected`, `border-border-subtle`, `text-text-*`, `text-success/warning/danger`, `text-accent-contrast`, `bg-success/15`, `bg-canvas/85`, `ring-gold/40`, `h-px`, `w-px`, `min-h-[18px]`, `h-1.5`, `h-2.5`, `w-2.5`, `-top-1`, `inset-y-0`, `h-dvh`, `tabular-nums`, `line-clamp-2`, `size-11`, `min-h-11`, `press-scale`, `scroll-edge-up`, `hide-scrollbar`, `animate-pulse motion-reduce:animate-none`, `transition-[width] duration-500 motion-reduce:transition-none`, `focus-visible:ring-focus`, `aria-[current…]`, the type sizes. **Not** used because absent: `snap-y`, `overscroll-y-contain`, `aspect-[9/16]`, `grid-cols-[auto_minmax(0,1fr)]`, `border-success/60`, `bg-canvas/70`, `bg-border-subtle/60`. Geometry (thread offsets, clip progress, 9:16, dashed rail, sticky top) is inline `style`.
3. **Tokens only**: no hex (fix `parts.tsx:144`), no `dark:` (the storefront is always `[data-store-theme]`, the card uses `text-text-*` which re-point per theme), logical utilities only (`ps/pe/ms/me`, `insetInlineStart`).
4. **JS placement**: `estimate/*`, `RequestComposer`, `journey/Thread`, `clips/*`, `tabViews` `Search` are `React.lazy`; the storefront closure gains only two `IconButton` slots (≤ 0.8 KB) — if over, `InstallAppButton`/`PremiumMemberBadge` go lazy first; the host `/chat/:id` is a route chunk; nothing new imports into the entry.

## 7. Localisation plan

Strings live in feature files outside `ui/` and `merchant/shell/` (`tests/uiPrimitives.test.ts:352`, `merchantWorkspaceShell.test.ts:315` do not fire): `src/components/estimate/strings.ts`, `src/components/journey/strings.ts`, `src/components/clips/strings.ts`, `src/components/storefront/blocks/searchStrings.ts`. A DECISIONS row extends D6 (`docs/COMMUNITY_ECOSYSTEM.md:138`) to «customer journeys». Each file gets the `tests/communitySocialUi.test.ts:75-100` guard (all keys ar/en/ckb, ≤ 10 % ckb identical to ar, ≥ 90 % with a Kurdish letter, ckb ≠ en). Counted nouns through `countNoun` (`src/lib/catalog/copy.ts:80`), prices through `<Money>`, Latin digits.

| key | ar | en | ckb |
|---|---|---|---|
| estimate.label | قيمة تقديرية | Estimate | نرخی خەمڵێنراو |
| estimate.loading | نحسب التقدير… | Working out the estimate… | خەمڵاندنەکە دەژمێرین… |
| estimate.noFile | لا تقدير بلا ملف مقيس — ارفع ملفًا أو أدخل الأبعاد. | No estimate without a measured file — add one or type the size. | بەبێ فایلی پێوراو خەمڵاندن نییە — فایلێک بار بکە یان قەبارەکە بنووسە. |
| estimate.error | تعذّر حساب التقدير. حاول مرة أخرى. | The estimate could not be worked out. Try again. | خەمڵاندنەکە نەژمێردرا. دووبارە هەوڵ بدە. |
| estimate.only | قيمة تقديرية — السعر النهائي من عرض الورشة. | An estimate — the final price comes from the workshop's offer. | نرخی خەمڵێنراوە — نرخی کۆتایی لە پێشنیاری وۆرکشۆپەکەوە دێت. |
| estimate.materialsOpen | المادة لم تُحدد، فالمدى يغطي المواد الممكنة. | The material is open, so the range covers what it could be. | کەرەستە دیاری نەکراوە، بۆیە مەودەکە کەرەستە گونجاوەکان دەگرێتەوە. |
| estimate.why | لماذا هذا السعر؟ | Why this price? | بۆچی ئەم نرخە؟ |
| estimate.raises / lowers | ما يرفع السعر / ما يخفّضه | What raises it / What lowers it | ئەوەی نرخەکە بەرز دەکاتەوە / ئەوەی کەمی دەکاتەوە |
| estimate.covers / excludes | يشمل / لا يشمل | Includes / Does not include | دەیگرێتەوە / نایگرێتەوە |
| estimate.lowersConfidence | ما يخفض الثقة | What lowers confidence | ئەوەی متمانە کەم دەکاتەوە |
| estimate.ladder / perUnit | كلما زاد العدد / للقطعة | The more you print / per piece | تا ژمارە زیاتر بێت / بۆ هەر پارچەیەک |
| estimate.atPublish | التقدير عند النشر | Estimate when published | خەمڵاندن لە کاتی بڵاوکردنەوە |
| conf.high / medium / low | ثقة عالية / ثقة متوسطة / تقدير مبدئي | High / Medium confidence / Rough estimate | متمانەی بەرز / متمانەی مامناوەند / خەمڵاندنی سەرەتایی |
| factor.most / some | الأكبر / أقل | Biggest / Smaller | گەورەترین / کەمتر |
| factor.material / time / labor / risk / hardware | المادة / زمن الطابعة / العمل اليدوي / مخاطر الفشل / العتاد | Material / Printer time / Handwork / Failure risk / Hardware | کەرەستە / کاتی چاپکەر / کاری دەستی / مەترسی شکست / ئامێر |
| reason.GEOMETRY_NOT_MEASURED | لم يُقَس الملف | The file was not measured | فایلەکە نەپێوراوە |
| reason.VOLUME_ESTIMATED_BY_CUSTOMER | الحجم من أبعادك | Volume from your size | قەبارە لە پێوانەی تۆوە |
| reason.MESH_NOT_WATERTIGHT | الشبكة غير مغلقة | Mesh not watertight | تۆڕەکە داخراو نییە |
| reason.MULTICOLOR | أكثر من لون | More than one colour | زیاتر لە ڕەنگێک |
| reason.MATERIAL_NOT_CHOSEN | المادة غير محددة | Material not chosen | کەرەستە هەڵنەبژێردراوە |
| reason.MANY_PARTS / POST_PROCESSING_ESTIMATED | قطع كثيرة / التشطيب مقدّر | Many parts / Finishing is estimated | پارچەی زۆر / تەواوکاری خەمڵێنراوە |
| source.file / link / photo / project / size | ملف / رابط / صورة / مشروع / قياس | File / Link / Photo / Project / Size | فایل / لینک / وێنە / پڕۆژە / قەبارە |
| link.reading | نقرأ الرابط… | Reading the link… | لینکەکە دەخوێنینەوە… |
| link.noFile | الرابط مقروء، لكن لا ملف قابل للقياس منه. أدخل الأبعاد أو ارفع الملف. | The link was read, but no measurable file came from it. Type the size or upload the file. | لینکەکە خوێندرایەوە، بەڵام فایلێکی پێواو لێی نەهات. قەبارەکە بنووسە یان فایلەکە بار بکە. |
| link.fetched | جلبنا الملف من الرابط وقسناه. | We fetched the file from the link and measured it. | فایلەکەمان لە لینکەکەوە هێنا و پێومان. |
| link.tooLarge | الملف أكبر من 40 ميغابايت. | The file is larger than 40 MB. | فایلەکە لە ٤٠ مێگابایت گەورەترە. |
| link.archive | الملف مضغوط — نزّله وفكّه ثم ارفع الملف. | It is an archive — download, unzip, then upload the file. | فایلەکە پەستێنراوە — دایبگرە و بیکەرەوە و پاشان فایلەکە بار بکە. |
| link.refused | لا نستطيع قراءة هذا الرابط. | We cannot read this link. | ناتوانین ئەم لینکە بخوێنینەوە. |
| door.ask / askStore | اسأل عن هذا / اسأل المتجر | Ask about this / Ask the store | لەبارەی ئەمەوە بپرسە / لە فرۆشگاکە بپرسە |
| door.quote | اطلب مثله | Request one like it | داوای وەک ئەمە بکە |
| door.toStore | طلب إلى «{store}» وحده | A request to {store} only | داواکاری بۆ «{store}» بە تەنیا |
| door.arrives | يصلك العرض في محادثتك مع المتجر. | The quote arrives in your conversation with the store. | پێشنیارەکە لە گفتوگۆکەتدا لەگەڵ فرۆشگاکە پێت دەگات. |
| door.closed | لا تستقبل طلبات مخصصة الآن | Not taking custom requests right now | ئێستا داواکاری تایبەت وەرناگرێت |
| door.communityClosed | طلبات الطباعة متوقفة مؤقتًا في مجتمع ليفو. | Print requests are paused in Levo Community for now. | داواکارییەکانی چاپ لە کۆمەڵگەی لیڤۆ بۆ ئێستا ڕاگیراون. |
| door.responds | عادةً يرد خلال {n} | Usually replies within {n} | زۆربەی کات لە ماوەی {n} وەڵام دەداتەوە |
| door.chatError | تعذّر فتح المحادثة. | The conversation could not be opened. | گفتوگۆکە نەکرایەوە. |
| search.placeholder | ابحث في المتجر… | Search this store… | لەم فرۆشگایەدا بگەڕێ… |
| search.searching | نبحث… | Searching… | دەگەڕێین… |
| search.empty | لا نتائج لـ «{q}» في هذا المتجر. | Nothing for “{q}” in this store. | هیچ ئەنجامێک بۆ «{q}» لەم فرۆشگایەدا نییە. |
| search.error | تعذّر البحث. حاول مرة أخرى. | Search failed. Try again. | گەڕان سەرکەوتوو نەبوو. دووبارە هەوڵ بدە. |
| sort.new / cheap / dear | الأحدث / الأرخص / الأغلى | Newest / Cheapest / Priciest | نوێترین / هەرزانترین / گرانترین |
| cart.pill / added / view | السلة / أُضيف إلى السلة / اعرض السلة | Cart / Added to cart / View cart | سەبەتە / خرایە ناو سەبەتەکە / سەبەتەکە ببینە |
| product.more | المزيد من هذا المتجر | More from this store | زیاتر لەم فرۆشگایە |
| timeline.live | يتحدّث تلقائيًا · آخر تحديث {t} | Updates automatically · last {t} | خۆکارانە نوێ دەبێتەوە · دوایین {t} |
| timeline.received | استلمنا طلبك. سيظهر كل تحديث هنا. | We have your order. Every update will show here. | داواکارییەکەت وەرگیرا. هەموو نوێکردنەوەیەک لێرە دەردەکەوێت. |
| timeline.noteFrom | من {store} | From {store} | لە {store}ەوە |
| timeline.failed (reuse) | تعذّر تحميل حالة الشحن. | Shipping status could not be loaded. | دۆخی گەیاندن بار نەکرا. (`OrderTracker.tsx:36`) |
| workshops.title | وۆرکشۆپات قد تنفّذه | Workshops that could make it | ئەو وۆرکشۆپانەی دەتوانن دروستی بکەن |
| workshops.indicative | تقديري — ليس عرضًا | Indicative — not an offer | خەمڵێنراوە — پێشنیار نییە |
| workshops.none | لا ورشة مطابقة الآن — انشر الطلب وسيصلك عرض. | No workshop matches right now — publish and offers will come. | ئێستا هیچ وۆرکشۆپێکی گونجاو نییە — داواکارییەکە بڵاو بکەرەوە و پێشنیارت بۆ دێت. |
| workshops.delivery | + توصيل تقديري | + estimated delivery | + گەیاندنی خەمڵێنراو |
| clips.title | مقاطع من الورشة | Clips from the workshop | کلیپەکانی وۆرکشۆپ |
| clips.loading / empty / error | نجهّز المقاطع… / لا مقاطع بعد. / تعذّر تشغيل المقطع. | Loading clips… / No clips yet. / The clip could not play. | کلیپەکان بار دەکرێن… / هێشتا هیچ کلیپێک نییە. / کلیپەکە لێنەدرا. |
| clips.tap / mute / unmute | اضغط للتشغيل / كتم / تشغيل الصوت | Tap to play / Mute / Unmute | دەست لێبدە بۆ لێدان / بێدەنگکردن / دەنگ کردنەوە |
| clips.hint | اسحب للأعلى للمقطع التالي | Swipe up for the next clip | بۆ کلیپی داهاتوو بۆ سەرەوە ڕابکێشە |

Reused verbatim: «داوای نرخ بکە» (`Storefront.tsx:499`), «داواکاریەکەت وەرگیرا» (`StoreCheckout.tsx:429`), «بارکردنی بەدواداچوون…» / «ژمارەی بەدواداچوون» (`OrderTracker.tsx:36`), «داوای چاپکردنی وەک ئەمە بکە» (`community/projects/strings.ts:264`), «زیادکردن بۆ سەبەتە» (`StorefrontProduct.tsx:395`), «دووبارە هەوڵ بدە» (refusalStrings). Server-side: `notifyOrderPlaced` texts exist in ckb; status titles (K5) get ckb in the merchantNotify shape.

## 8. Accessibility checklist
- [ ] The thread is never the only carrier: range, point and confidence are text (`Money`, `StatusChip`); the track is `aria-hidden`; the card is `aria-live="polite" aria-atomic` and speaks once per settled recompute (debounced with the fetch), never per keystroke.
- [ ] Reason chips are `<button aria-expanded>`; the sheet is `Sheet` v2 (focus trap, `labelledBy`, Escape, `dirty` guard on the door with attachments); `Anchored` restores focus to the trigger.
- [ ] SourcePicker and sort are `radiogroup`s (`Segmented` gives real radio semantics); arrow keys move; each tile ≥ 44 px (`lv-hit`).
- [ ] StoreDoor buttons carry the product in the name («اسأل عن حامل هاتف») via `aria-label` when compact; the disabled door is `aria-disabled` with the reason as visible text, not `disabled`.
- [ ] Link field `dir=ltr inputMode=url autocomplete=off`; fetch progress is one `role=status` row; failures are `lv-field-error` under the input; the fallback rows are real buttons.
- [ ] Timeline is `<ol>`; the current step has `aria-current="step"`; store notes are `<blockquote cite>`; the pulse is opacity only and stops under `motion-reduce`; new events are announced through an `sr-only` polite region; polling never steals focus.
- [ ] Search input `type=search enterKeyHint=search` with an `sr-only` label; results region `aria-busy` while loading; the count is text («12 نتيجة»); «المزيد» is a button; Escape closes the sheet and focus returns to the header icon.
- [ ] Clips: `Overlay` traps focus; each slide is a `region` labelled by the product name; Space toggles, M mutes, ↑/↓ page; every control ≥ 44 px; `prefers-reduced-motion` never autoplays and shows the play control; no audio-only information (the title and price are visible text).
- [ ] Numbers, prices and tracking numbers are LTR islands (`Money`'s `<bdi dir=ltr>`, `tabular-nums`); Arabic and Sorani never tracked or uppercased (the `tracking-wider` at `Tools.tsx:894,1047,1073` goes when the page is retokened); `leading` ≥ 1.15.
- [ ] Contrast ≥ 4.5:1 in cream and dark (`tests/themeSystem.test.ts`), including inside `[data-store-theme]`; `text-success/warning/danger` only beside text.
- [ ] Focus rings on every control (`focus-visible:ring-focus`, `lv-button`, `lv-input`); no native `alert/confirm`; `/auth` round-trips carry `?next=`.

## 9. Phased delivery (each independently shippable)

| Phase | Ships | Tests |
|---|---|---|
| **1 — Server truth, the contract, the budget** (no schema, no churn-zone file) | `source()` restriction measured; E1–E8 (façade, `factors/covers/quantity_curve`, margin leak at 925/1245/1469, bed-contact fix, catalogue cache, client types, revisions `estimate`); C3 (`'ckb'`); B2 (success → `/orders/:id`); K4 (`notifyOrderPlaced` for store orders); K1 store identity on the order list/detail/tracking payloads | `tests/bundleBudget.test.ts` passes (CSS ≤ 61,440 B — the gate for everything after); new `tests/printEstimateContract.test.ts` (no `cost_/floor_/margin_/lines` key serialises from `/quote`, `/analyses/:id/quote`, publish snapshots; `target_margin_percent` in a public body is ignored — `printQuoteRoutes.test.ts` has no such assertion today; `quantity_curve` unit price non-increasing); `printPricing.test.ts` bed-contact case; `ordersCustomer.test.ts` extended (store only on `merchant_id` orders; a stranger 404s) |
| **2 — The card and the doors** | `estimate/*` (EstimateCard, WhyThisPrice, strings, `useEstimate`), R2, R3 (options), quantity ladder, Tools on the card (T2/T3 with ckb moved to the strings file), `MyRequestsList` adopts the card; R4–R7 (RequestComposer store/chat modes, `readJob` spec extension, StoreDoor with gate wording); C2 (`chats/open {productId}` with `existingCard` replay); C4; B1 (toast action); C5 host `/chat/:id` if the import check passes | `tests/estimateCard.test.ts` (tokens only, `useMotion`, no `duration`, strings guard copied from `communitySocialUi.test.ts:75-100`); `tests/chatQuotes.test.ts` extended (a draft with spec fields is priced by `/quote` through `customer_id`; `STORE_NO_CUSTOM_REQUESTS`/`COMMUNITY_CLOSED` still refuse; the product card is posted once per product per thread); `printRequestsV2.test.ts` (options persisted on `community_print_requests`); storefront closure unchanged |
| **3 — Find, buy, track** | F1–F3 (`q/sort`, header slots, lazy Search view), B3, B4 (one card, `has_video`, hex fix), K2, K3, K5 (`journey/Thread`, live poll via `useFreshOnReturn`), `events[]` on tracking | new `tests/storefrontSearch.test.ts` (LIKE escaping via `likePattern`, hidden/draft never matched, keyset stable under price sort, anonymous cache header, signed-in private); new `tests/orderTrackingThread.test.ts` (events never carry merchant-private text or ledger amounts; poll disabled at terminal stages; `data-order-tracker/data-stage/data-reached` kept); `bundleBudget` closure ≤ 47 KB and `tabViews`/`extra` still lazy |
| **4 — Sources and workshops** (migration **0159**) | S2 (owner-set `bbox_fill_factor`, `priced:false` until then), S3(c) og: read, S3(d) behind admin `download` templates, S4 guest twin, S5 from-analysis, S6 `?project=` (after the community workflow lands); W1–W2 indicative quotes from `community_request_matches`; E9; C6 `responds_within_minutes` on the `*/15` cron | new `tests/linkImport.test.ts` (private hosts refused by `validateOutboundUrl`, 40 MiB cap, redirect cap, non-model refused, archive refused, no bytes stored on failure, `origin='link'`); new `tests/indicativeQuotes.test.ts` (opted-out merchants absent; only `eligible=1` at the current revision; never a cost line; direct mode quotes only the target; `no-store`); `eligibilityRoutes.test.ts` untouched |
| **5 — Watch, community in the store, convergence** | V1 `/clips`, V2 ClipRail/ClipViewer (tap-to-play), V3 `store_posts` block (gate-aware, lazy `extra`), DECISIONS rows (autoplay, D6 extension, link providers); E10 convergence (B reads admin config, resin, `print_materials.process` if needed, A wrapped over B) with `docs/PRINT_QUOTE_ENGINE.md` §8 fixed | `storeLayoutSchema.test.ts:59` 27 → 28 and `storefrontBlocks.test.ts:145` one component per type; new `tests/storefrontClips.test.ts` (only visible products' videos; poster always present; anonymous cache header; reduced motion never autoplays; no `snap-y` class in the new files); golden-file test that A-via-wrapper and B agree within `round_to_iqd` on the `tests/printQuoteGeometry` fixtures; the 17 existing print tests keep passing |

## 10. Open owner questions
1. **Autoplay inside the full-screen viewer**: tap-to-play per slide ships (ECOSYSTEM:745, HOME_PLAN:161). Do you want muted autoplay of the current slide once the viewer is open (a DECISIONS row)?
2. **`bbox_fill_factor`** for photo/typed-size estimates: what value (row 111 forbids our inventing it)? Until set, typed sizes stay unpriced with `GEOMETRY_NOT_MEASURED`.
3. **Indicative workshop prices**: opt-in per workshop, range only, «تقديري — ليس عرضًا» — confirm the label and the cap of 5, and that direct requests show only the addressed store.
4. **Link providers**: fill `printLinkProviders[].api_url`/`download` for Printables and Thingiverse? Without them links yield title + cover (step c) only; MakerWorld/Cults are never scraped (ToS) — confirm.
5. **Sorani policy**: extend D6 to `src/components/estimate|journey|clips` (real Sorani, tables above) — please have a reader check the table once; `refusalStrings.STORE_NO_CUSTOM_REQUESTS.ckb` stays an Arabic placeholder unless you allow the same there.
6. **The thread marker's scale** (0 = 0.6×low, 100 = 1.3×high) is a relative cue judged arbitrary by one reviewer; keep the marker, or keep only the low–high fill?
7. **Chat on the store host** (`/chat/:id` in the PWA) versus the apex link with `?next=`: mounting depends on `Chat.tsx`'s bloub/presence imports rendering in the host tree — approve the conditional plan (mount if the check passes in Phase 2, else Phase 3)?
8. **Community tab vs block**: store posts ship as a gate-aware block merchants add, not a default tab (adding to `TAB_KINDS` would switch it on for every store). Agree?
9. **Migration number**: 0159 provisional — the ecosystem doc's 0155 claim (L468) collides with the existing `0155_community_comment_replay.sql`; who renumbers that doc?
10. **Merchant progress photos** (`order_updates`), quick replies and away messages are deferred to the merchant track / ECOSYSTEM Phase 5 so this track adds no new table — confirm the split.

