# Performance log

One entry per measured state of the site. The lab is Playwright Chromium on a
360×800 mobile context, CPU ×4, Slow-4G (150 ms RTT, 1.6 Mbps down), cold cache,
served from a production build (`npm run build`; note when a bare `vite build`
was used — it lacks `dist/_headers`). PageSpeed Insights mobile scores are
recorded when run (`scripts/psi.mjs`, owner key) — see
docs/MERCHANT_PLATFORM_V2.md §B.4 for the tooling plan.

## 2026-09-29 — baseline at HEAD 1444169f (before the merchant programme)

Measured by the survey lab (docs/MERCHANT_PLATFORM_V2_SURVEY.md «perf-measure»);
`/api/*` answered 500 in the lab, so every route rendered its no-API state.

| route | TTFB | FCP | LCP | CLS | long tasks (n / ms) | requests @load | KB @load (wire) |
|---|---|---|---|---|---|---|---|
| `/` | 5 | 4756 | **4964** | **0.081** | 4 / 442 | 7 | 271 |
| `/community` | 5 | 10960 | **11164** | 0 | 5 / 362 | 7 | 270 |
| `/products` | 4 | 5540 | 6092 | 0.001 | 4 / 376 | 7 | 271 |
| `/product/x` | 5 | 5068 | 5228 | **0.075** | 3 / 232 | 7 | 271 |
| `/requests` | 5 | 6204 | 6408 | 0.001 | 5 / 549 | 7 | 271 |
| `/auth` | 6 | 5332 | 5332 | 0 | 4 / 306 | 7 | 271 |

What the numbers say:

- The same seven requests precede every first paint (document 7.6 KB,
  entry 82.2, vendor-react 73.2, vendor-motion 46.1, vendor-i18n 12.0,
  index.css 48.9, the Google Fonts stylesheet) and everything waits for the
  third-party stylesheet: with it served locally the home's LCP falls from
  4.96 s to **2.63 s** and the community's from 11.2 s to **2.5 s**. That is
  fix #1 (self-host Cairo, preload the Arabic subset).
- The idle prefetch pulls 57 chunks / 119.5 KB while the woff2 and the LCP
  are still in flight (the Arabic font finished at 9.4 s).
- CLS 0.08 on the home (the sheet under the hero shifting when AppIntro and
  the marquee settle) and 0.075 on the product page (loading → content swap).
- No boot API answer carries `Cache-Control`; D1 is a single primary of
  unknown region; `/files` Range responses are never edge-cached.

Targets for the programme's exit (P0–P2): home LCP ≤ 2.5 s and CLS < 0.01 in
this lab; initial payload ≤ 190 KB gzip; every anonymous boot GET cached at the
edge with `s-maxage`; the Cloudflare-side switches (Smart Placement measured,
Argo/Tiered Cache, Early Hints, Image Transformations, Cache Rules for the
viewer-independent documents) recorded with their measured effect.

## 2026-09-29 — P2 exit: the consolidated gate after P0–P2 (integration of the seven builders, working tree on d3dc28a3)

The same lab as the baseline (`scripts/perf-lab.mjs`: 360×800, CPU ×4 via CDP,
Slow-4G 150 ms / 1.6 Mbps, cold context per run, median of 3), against
`npx vite preview --outDir <snapshot of the real npm run build> --port 4173`;
`/api/*` answers 500 under `vite preview`, so every route is its no-API state,
exactly as in the baseline. Command:
`node scripts/perf-lab.mjs --label P2-exit --sw-repeat` (JSON in the session
scratchpad `integ/lab-P2-exit.json`). Run on a quiet machine (nothing else
compiling), after `npm run check` had finished.

Three columns because the baseline was taken on another machine: the survey's
numbers (HEAD 1444169f, the survey's network, where the Google Fonts
stylesheet cost seconds), the earliest snapshot this sandbox measured with the
same tool on all seven routes (P1b's «before»: P0 and P1a's self-hosted fonts
done, the JS diet / CLS / P2 work not yet — its 295.0 KB wire and TTFB 161 on
the repeat are P1a's signatures), and this tree. The pure post-P0 tree was
measured in this sandbox only for `/` and `/community` (P1a's «before»:
FCP / LCP 2416 / 2616 and 2332 / 2584). CAVEAT, corrected by the P2 review:
in this sandbox Chromium cannot fetch the Google Fonts stylesheet at all —
the request shows status `?`, 0 B, never finished, because the headless
browser does not trust the proxy's CA (curl through the same proxy answers
200 in 0.5 s) — so every pre-P1a column here rendered with NO web font and
zero font bytes, and understates the baseline rather than measuring the
third-party penalty; the survey row is the before for fix #1. The current
tree, by contrast, downloads the Arabic (31 KB) and Latin (34 KB) subsets
before its LCP, so the same-rig deltas UNDERSTATE the font fix.

### Cold — FCP / **LCP** / CLS / long tasks n / long tasks ms / requests @load / KB @load (wire)

| route | survey baseline (HEAD 1444169f) | P0 + P1a fonts, before P1b/P1c/P2 (this sandbox) | **P2 exit** (this tree) | Δ LCP vs the middle column | **P2 exit + review fixes** (same rig, `--label P2-review`) |
|---|---|---|---|---|---|
| `/` | 4756 / **4964** / 0.081 / 4 / 442 / 7 / 271 | 2636 / **2928** / 0.078 / 5 / 564 / 7 / 295.0 | 2232 / **2232** / **0** / 3 / 419 / 9 / 265.7 | −696 | 2260 / **2260** / **0** / 4 / 442 / 9 / 265.8 |
| `/community` | 10960 / **11164** / 0 / 5 / 362 / 7 / 270 | 2720 / **2868** / 0 / 5 / 591 / 7 / 295.0 | 2132 / **2380** / 0 / 3 / 287 / 8 / 265.5 | −488 | 2100 / **2432** / 0 / 3 / 249 / 8 / 265.6 |
| `/products` | 5540 / **6092** / 0.001 / 4 / 376 / 7 / 271 | 2376 / **3020** / 0 / 3 / 315 / 7 / 295.0 | 2108 / **2616** / 0 / 4 / 328 / 8 / 265.5 | −404 | 2120 / **2692** / 0 / 4 / 330 / 8 / 265.6 |
| `/product/x` | 5068 / **5228** / 0.075 / 3 / 232 / 7 / 271 | 2604 / **3032** / 0.075 / 5 / 384 / 7 / 295.0 | 2464 / **2704** / 0.075 / 3 / 274 / 8 / 265.5 | −328 | 2516 / **2672** / 0.075 / 4 / 361 / 8 / 265.6 |
| `/requests` | 6204 / **6408** / 0.001 / 5 / 549 / 7 / 271 | 2464 / **2776** / 0 / 4 / 400 / 7 / 295.0 | 2092 / **2376** / 0 / 2 / 202 / 8 / 265.5 | −400 | 2112 / **2436** / 0 / 3 / 253 / 8 / 265.6 |
| `/auth` | 5332 / **5332** / 0 / 4 / 306 / 7 / 271 | 2956 / **3040** / 0 / 4 / 495 / 7 / 295.0 | 2448 / **2680** / 0 / 5 / 465 / 8 / 265.5 | −360 | 2432 / **2664** / 0 / 4 / 434 / 8 / 265.6 |
| `/community/store/x` | — (not in the survey) | 2436 / **2740** / 0 / 4 / 349 / 7 / 295.0 | 2084 / **2384** / 0 / 2 / 222 / 8 / 265.5 | −356 | 2100 / **2452** / 0 / 2 / 196 / 8 / 265.6 |

TTFB 3–5 ms on every route (vite preview on loopback). TBT: `/` 5, `/products`
14, `/auth` 92 (the blueprint's annotations), 0 elsewhere. The LCP element on
`/` is the H1 (painted at first render, the same instant as FCP); on the other
routes it is the no-API refusal paragraph; on `/auth` the blueprint's DIV.
The two extra requests at load are the self-hosted Arabic woff2 (was after
load, behind the Google stylesheet) and, on `/`, the `/api/home` boot
request that now leaves at module evaluation (P2b) instead of after mount.

### Repeat visit with the service worker — TTFB / FCP / **LCP** / requests served by the SW at load

| route | P0 tree, SW v3 (P1a «before») | P0 + P1a, SW v4 (P1b «before») | **P2 exit** (SW v4, navigation preload) | **P2 exit + review fixes** |
|---|---|---|---|---|
| `/` | 9 / 932 / **1132** / 64 | 161 / 708 / **876** / 66 | 158 / 592 / **592** / 20 | 159 / 608 / **608** / 20 |
| `/community` | 7 / 680 / **912** / 62 | — | 161 / 500 / **720** / 19 | 162 / 540 / **776** / 19 |
| `/products` | — | 162 / 700 / **1272** / 64 | 161 / 540 / **1020** / 19 | 160 / 508 / **1000** / 19 |
| `/product/x` | — | — | 163 / 512 / **1012** / 33 | 160 / 492 / **984** / 33 |
| `/requests` | — | — | 164 / 512 / **756** / 19 | 158 / 516 / **752** / 19 |
| `/auth` | — | — | 157 / 496 / **888** / 28 | 160 / 516 / **860** / 28 |
| `/community/store/x` | — | — | 158 / 500 / **728** / 19 | 162 / 508 / **760** / 19 |

(The v4 rows' TTFB of ~160 ms is the CDP throttle on the browser-issued
navigation-preload request; v3's worker-issued fetch bypassed it — see P1a.
The 64 → 20 requests from the SW is the 57-chunk idle prefetch that no longer
runs before the fonts and the LCP are settled — P1b. The last column is the
tree after the P2 review fixes, measured in the same lab run as the entry
below: within ±80 ms of the P2 exit column on every route — the fixes are
seams, a `Vary` header, a failure path and a font range, and the byte gate
moved by +0.1 KB on the entry.)

### Bytes (gzip −9, the bundle test's closure walk on `npm run build`; 12/12 pass)

| what | baseline | **P2 exit** | gate |
|---|---|---|---|
| entry chunk | 81.9 KB (82.2 in the survey) | **66.0 KB** | ENTRY_BUDGET 72 KB (was 120; lowered after measuring, P1b) |
| initial payload (entry + static closure) | 212.1 KB / 4 files | **182.5 KB** / 4 files (entry 66.0, vendor-react 73.3, vendor-motion-core 31.7, vendor-i18n 11.6) | INITIAL_BUDGET 200 KB (was 240); plan exit ≤ 190 KB met |
| storefront pages beyond the initial payload | 46.3 KB | **39.5 KB** (+ shared vendor-motion 15.7, vendor-icons 12.0 on first lazy route) | 47 KB; «not above 46.3» met |
| CSS, all files | 61,033 B = 59.60 KB over 8 files | **60,992 B = 59.56 KB** over 8 files (index-*.css 47.0) | 60 KB; «may not grow» met (−41 B) |
| document `dist/index.html` | 18,511 B raw / 7,511 B gzip (7 comments) | **5,327 B raw / 1,906 B gzip**, 0 comments | DOCUMENT_BUDGET 4 KB |
| third-party origins before first paint | 2 (fonts.googleapis, fonts.gstatic) | **0** | — |
| JS chunks / sub-1 KB chunks | 395 / 138 | 296 / 29 | — |

### The programme's exit targets (set in the baseline entry above)

- home LCP ≤ 2.5 s in this lab: **2232 ms** (baseline 4964 on the survey
  machine; 2616 on the post-P0 tree in this sandbox) — met.
- home CLS < 0.01: **0** (baseline 0.081) — met. `/product/x` keeps 0.075:
  the App.tsx `MotionCharacterFallbackHeader` strip (60 px / 800 = 0.075,
  P1c's residual, for the App.tsx churn PR) — not met on that route.
- initial payload ≤ 190 KB gzip: **182.5 KB** — met.
- every anonymous boot GET cached at the edge with `s-maxage`: `/api/home`,
  `/api/home/sections`, `/api/products(/:slug)`, `/api/settings/public`,
  `/api/community/access`, `/api/storefront/resolve`, the storefront router,
  the print catalogue — `public, max-age=60, s-maxage=120,
  stale-while-revalidate=600` with weak ETag and 304, session answers
  `private, no-store` (tests/edgeCachePolicy.test.ts 12/12; P2a). Provable in
  this lab only by the tests: `vite preview` has no Worker.
- the Cloudflare-side switches: prepared, not flipped — the commented
  `placement` block in wrangler.jsonc + `prepare-deploy-config.mjs` fold,
  the `d1_region` / `document_region` log lines, DECISIONS rows 169–171, the
  Cache Rule for HTML, Early Hints (`Link` emitted on the document and in
  `_headers`), Images → Transformations, Tiered Cache / Argo / «Respect
  Existing Headers» — each with its measurement recipe in the P2a/P2b/P2c
  entries. Their effect is measured on staging after deploy (`npm run
  perf:psi`), never here.

### Integration gates (all run on the final tree, in this order)

- `npx tsc --noEmit -p tsconfig.json`, `-p worker/tsconfig.json`,
  `-p tests/tsconfig.json`: 0 errors each.
- `npx eslint` over the 90 files the seven reports list: clean.
- 81 test suites named by the reports plus the integration list
  (securityPolicy, edgeParity, uiPrimitives, themeSystem, communityHubUi,
  communitySearchUi, storefrontIsolation, store-isolation, publicApi,
  edgeCacheLifetime, fileRangeDelivery, publicMediaDelivery, mediaCachePolicy,
  seoRoutes, …): **1123 pass / 0 fail**. tests/bundleBudget.test.ts after
  `npm run build`: 12/12.
- Browser (vite dev on 127.0.0.1:4191/4192, Playwright): e2e-community-home
  750/750, e2e-projects 247/247, e2e-store-builder 34/34 — no page errors, no
  horizontal overflow, ar/en/ckb, light/dark, 360/1280. e2e-subdomains needs
  the live apex and admin credentials (not run here).
- `node scripts/migrate-check.mjs --twice`: second full pass applied 0 files,
  238 tables, 0 foreign-key violations, 0 orphan catalogs.
- `npm run check`: its first run failed on 21 eslint errors, all in
  `scratchpad/` (P0 gitignored the directory; P2b/P2c left one-off lab scripts
  there and `eslint .` walked it) — fixed at the root: `scratchpad/**` added
  to eslint.config.js `ignores` and `scratchpad` to tsconfig.json `exclude`
  (the SPA project has no `include` list; P2b saw 680 fixture errors from the
  same directory mid-run). The 151 warnings are in files this programme never
  touched (pre-existing `no-explicit-any` in chat/farm tests and legacy
  components).

### Caveats

- No-API state throughout: the content LCP (the bento's promo photo on `/`,
  ~4.7 s in P1c's fixture lab) is the `/api/home` wait plus the image — that
  is what P2a's edge policy, P2b's early `/api/home` request and P2c's image
  variants address, and only a Worker + D1 + `caches.default` can measure it
  (staging).
- vite preview is HTTP/1.1 + gzip; production is HTTP/2/3 + brotli behind
  Cloudflare, so absolute numbers differ; the deltas between snapshots on the
  same rig are what this table stands on.
- The survey column is another machine and network; the sandbox reaches
  Google's font CSS through a fast proxy, so the headline 4.96 → ~2.6 s
  effect of self-hosting Cairo remains the survey's measurement until PSI on
  the live site confirms it.

## 2026-09-29 — P2 review fixes: the cache seams that were missing, the sign-in boundary in the browser cache, the motion failure path, the Kurdish patch face (working tree on d3dc28a3, after the P2 exit)

The seventeen findings of the P0–P2 review, what changed for each, and the
gates and the lab re-run on the resulting tree. Every number below was
measured here (the same rig and tool as the «P2 exit» entry above; the lab
ran alone on the machine after the browser suites had finished).

### Security / cache (all four majors, both minors)

- **Guest bodies in the browser cache across a sign-in** — the six routes
  whose session variant differs (`/api/home`, `/api/home/sections`,
  `/api/products`, `/api/products/:slug`, `/api/community/access`,
  `/api/print-quote/printers`) declare `perViewer: true` and their anonymous
  200 AND 304 now carry `Vary: Cookie` (`worker/lib/edgePolicy.ts`
  `varyOnViewer`). A browser keys such an entry on the Cookie header, so the
  guest body stored a moment before sign-in cannot answer the first request
  after it; guest → guest keeps the full minute. The colo's own key never
  consults `Vary`, so the edge hit rate is unchanged. Same-bytes routes
  (settings, storefront, print catalogue) keep the plain policy. Pinned:
  tests/edgeCachePolicy «after a guest answer of a per-viewer route, a
  request that carries a session cookie cannot be satisfied without
  revalidation» (`browserMayReuse`, RFC 9111 §4.1 semantics, against the real
  routers), plus the Vary assertions in the policy test for all 19 routes.
- **Suspension, merchant suspension, rename purged nothing** — the two admin
  sanctions (`adminCommunity.ts` stores/:id/status, merchants/:id/status) and
  the rename (`merchant.ts` POST /store/slug: the OLD slug through the router
  middleware, the NEW slug explicitly, so the old host's `/resolve` is dropped)
  call `afterStorefrontWrite`. `storefrontPaths(slug, id)` now covers
  `/resolve`, `/:slug`, `/:slug/sections|services|showcase|products|reviews`
  and `/by-id/<id>`, and `storefrontDocumentPaths` drops the store's `/` and
  `/community/store/<slug|id>` documents from the same colo. Pinned: three
  tests — suspension → the next anonymous GET on the store host is
  `STORE_UNAVAILABLE` 404 with `store: null`; merchant suspension → same;
  rename → old host `STORE_MOVED` with the new address, new slug 200.
- **Site media never purged** — POST/DELETE `/api/admin/site-media/:slot`
  call `afterSettingsWrite(c, 'mainPageMedia')` (home, sections, public
  settings). Audit of the other direct `setSetting` writers: `printerFarmConfig`
  (farmAdmin), `warrantyConfig` (warranty), `launchConfig` (memberships) are
  NOT in `PUBLIC_SETTING_KEYS` — no public answer carries them, nothing to
  purge. Pinned: DELETE then the stand-in cache holds only `/api/products`;
  the POST route's seam is pinned in the source (it needs the bucket and the
  image service).
- **Documents with `stale-while-revalidate=600`, no purge on deploy** —
  `DOCUMENT_SHARED_CACHE_CONTROL` is `public, max-age=0, s-maxage=60` (worst
  case a minute, not eleven); `scripts/purge-zone-cache.mjs` runs after the
  deploy in `deploy-staging-code.yml` (7 – the LIVE code deploy) and
  `deploy-staging.yml` (2): `purge_everything` on `CLOUDFLARE_ZONE_ID`, a
  notice and exit 0 when the secret is unset, a failed step when it is set and
  the purge is refused. Recorded as the Cache Rule's PRECONDITION in DECISIONS
  row 171 and plan §B.2. Pinned: tests/documentPreloads (the string) and
  tests/edgeCachePolicy (both workflows purge after `wrangler deploy`).
- **Every other guest-visible write** (minor, fixed rather than documented):
  `purgeStorefrontAfterWrite` is ONE middleware on `merchantRoutes` and
  `merchantCatalogRoutes` — after any successful non-GET, the store
  `requireStoreOwner` recorded on the context (`merchantStore`, new
  `Variables` key) has its shopfront purged: profile, delivery, services,
  showcase, review reply, products, collections, import, bulk. Pinned: a
  PATCH /api/merchant/store drops all eight warmed entries and the guest reads
  the new tagline at once; a refused write (400) purges nothing.
- **Admin product / benefit-rule / PRO-pause writes** (two minors):
  `afterCatalogueWrite(c, slugs)` (home, sections, listing, the product pages
  named; forgets the pricing memo) as a middleware on `adminProductsRoutes`
  (slug from `catalogueSlug` set by the save/delete handlers, else one read by
  the id in the path) and `adminMembershipBenefitRoutes`; explicit calls in
  the legacy `POST/DELETE /api/admin/products`; the PRO pause calls
  `afterSettingsWrite(c, PRO_PAUSE_KEY)` (memo + the mapped paths). Pinned:
  hide a product → listing/home/its page gone, restore, refused write purges
  nothing, a rule POST purges the priced answers; the pause purges
  home/sections/products and leaves the verdict.

### Behaviour / a11y

- **Sheets, toasts, AppBusy, the update toast invisible when the motion
  chunk fails** — `src/lib/motionFeatures.tsx` records a failed import
  (`useMotionFeaturesFailed`, a `useSyncExternalStore` flag; the loader
  handed to `LazyMotion` never rejects, so the uncaught page error is gone)
  and Overlay (window, anchored, scrim), ToastItem, AppBusy, UpdateReadyToast
  and LiveSearchPanel render `initial={false}` while failed — an `m` element
  then paints at its `animate` values with no features, and the next mount
  retries the chunk. Measured (`scripts/e2e-resilience.mjs`, real build,
  SW blocked, `motionFeaturesBundle-*` + `vendor-motion-*` aborted, ar/en):
  the language sheet's `[role=dialog]` rect top **520 / bottom 800** in the
  800 px viewport, opacity 1 (before: top 800, off screen), scrim opacity 1
  (before 0), **0** page errors (before 2), Escape closes; control with the
  chunk: mid-flight top ≠ settled top, settles opaque.
- **Full-screen routes had no ChunkBoundary** — App.tsx wraps the
  full-screen `<Routes>` like the other two trees; the P1c sentence in this
  log is corrected. Measured: `Auth-*.js` aborted → `[data-chunk-boundary]`
  with reload button in ar/en/ckb, root innerHTML 5333–5354 B (before 0).
- **Kurdish patch face never consulted** — `font-weight: 300 900`
  (Cairo's range) in src/index.css; comments in index.css and index.html
  corrected (document order does not decide this). Measured on the Sorani
  home: `/fonts/cairo-kurdish-patch.woff2` requested, `document.fonts` face
  `300 900:loaded`, `CSS.getPlatformFontsForNode` on the weight-900 H1 =
  **Cairo×29 + Vazirmatn×6** (before: Cairo×29 + DejaVu Sans Bold×6). CSS
  budget byte-neutral (59.6 KB).
- **scripts/e2e-motion.mjs stale** — re-pointed at the hub markup (the four
  quick actions are links with hrefs and 44 px targets; the tab ids are the
  hub's; the strip is awaited) and a new section 5b flips
  `prefers-reduced-motion` mid-session on the header search panel. Against
  the local Worker: **22/22**. `scripts/e2e-resilience.mjs` (new, against the
  preview build): **42/42** — the panel's first twelve frames
  [2,4,9,17,27,37,47,52,58,62,65,67] under full motion, [194,72,…,72] (full
  height from frame 1) after `emulateMedia({reducedMotion:'reduce'})` with
  no reload, [2,2,9,15,…,66] toggled back.
- **Log caveat about the fonts** — corrected in the «P2 exit» entry: the
  sandbox's Chromium never receives the Google Fonts stylesheet (proxy CA),
  so the pre-P1a columns rendered with no web font and understate the
  baseline; the survey row is the before for fix #1.

### Deferred (minor, with the reason)

- **Home without ads shifts 24 px** (CLS 0.012 ar / 0.0112 en on an ad-less
  home; the live site has ads and measures 0): the loaded-without-ads cap is
  `h-4` against the `h-10` reservation. Making them equal changes the ad-less
  home's spacing by 24 px — a design call for the owner (keep the 40 px cap,
  or reserve 16 px and let a home with ads grow once from the pageCache
  snapshot). Not changed.
- **`/product/x` CLS 0.075** (the `MotionCharacterFallbackHeader` strip
  unmounting when the page's own anchor registers): already in the open
  issues; needs a seeded product locally to re-measure and a decision on
  keeping the strip out of flow on anchor-owning routes. Not changed.

### Gates on this tree

- `npx tsc --noEmit` for the SPA, the worker and the tests: 0 errors each;
  `npx eslint` over every touched file: clean.
- Unit: the full `tests/*.test.ts` set (594 files): **7309 pass / 1 fail** on the first pass — the one failure was tests/busyOverlay pinning the old `initial="hidden"` literal; re-pinned to the failure-path form and 36/36 on re-run.
  tests/edgeCachePolicy 21/21 (was 12), motionLazy, firstPaintAndFonts,
  documentPreloads 17, securityPolicy 16, uiPrimitives 21, edgeCacheLifetime
  4, d1Waves 3, storefrontIsolation 16, communityGate 35, homeOwnerControls
  16, proPause 11, membershipBenefitsWired 30, storeDeliveryCheckout 19.
- `npm run build` + tests/bundleBudget: **12/12** — entry **66.1 KB** (was
  66.0; the failure path is +0.1), initial **182.7 KB** (66.1 + react 73.3 +
  motion-core 31.7 + i18n 11.6), storefront closure **39.5 KB** (unchanged),
  CSS **59.6 KB** over 8 files (unchanged; the patch face edit is
  byte-neutral), document 1.9 KB gzip.
- Browser: e2e-community-home **750/750**, e2e-projects **247/247** (vite
  dev 4191), e2e-motion **22/22** (Worker 8787), e2e-resilience **42/42**
  (preview 4173).

### Lab — `node scripts/perf-lab.mjs --label P2-review --sw-repeat` (vite preview of this tree's `npm run build` on 4173; 360×800, CPU ×4, Slow-4G; cold context per run, median of 3; run alone after the suites; JSON `scratchpad/perf/P2-review.json`)

Cold — FCP / **LCP** (element) / CLS / TBT / long tasks n / ms / requests @load / KB @load (wire):

| route | P2 exit (entry above) | **P2 exit + review fixes** | Δ LCP |
|---|---|---|---|
| `/` | 2232 / **2232** / 0 / 5 / 3 / 419 / 9 / 265.7 | 2260 / **2260** (H1) / **0** / 4 / 4 / 442 / 9 / 265.8 | +28 |
| `/community` | 2132 / **2380** / 0 | 2100 / **2432** (no-API P) / 0 / 0 / 3 / 249 / 8 / 265.6 | +52 |
| `/products` | 2108 / **2616** / 0 | 2120 / **2692** / 0 / 16 / 4 / 330 / 8 / 265.6 | +76 |
| `/product/x` | 2464 / **2704** / 0.075 | 2516 / **2672** / 0.075 / 0 / 4 / 361 / 8 / 265.6 | −32 |
| `/requests` | 2092 / **2376** / 0 | 2112 / **2436** / 0 / 0 / 3 / 253 / 8 / 265.6 | +60 |
| `/auth` | 2448 / **2680** / 0 | 2432 / **2664** (blueprint DIV) / 0 / 91 / 4 / 434 / 8 / 265.6 | −16 |
| `/community/store/x` | 2084 / **2384** / 0 | 2100 / **2452** / 0 / 0 / 2 / 196 / 8 / 265.6 | +68 |

Repeat visit with the service worker — TTFB / FCP / **LCP** / requests served by the SW at load:

| route | P2 exit | **P2 exit + review fixes** |
|---|---|---|
| `/` | 158 / 592 / **592** / 20 | 159 / 608 / **608** / 20 |
| `/community` | 161 / 500 / **720** / 19 | 162 / 540 / **776** / 19 |
| `/products` | 161 / 540 / **1020** / 19 | 160 / 508 / **1000** / 19 |
| `/product/x` | 163 / 512 / **1012** / 33 | 160 / 492 / **984** / 33 |
| `/requests` | 164 / 512 / **756** / 19 | 158 / 516 / **752** / 19 |
| `/auth` | 157 / 496 / **888** / 28 | 160 / 516 / **860** / 28 |
| `/community/store/x` | 158 / 500 / **728** / 19 | 162 / 508 / **760** / 19 |

Every route is within the lab's run-to-run spread (the three cold runs of
`/products` alone span 2608–2776) of the P2 exit column; nothing in this
round touched the critical path, and the byte gate says the same (entry
+0.1 KB, everything else unchanged). Home CLS stays 0 (0.0001 per run),
`/product/x` stays 0.075 (deferred above). The lab still answers `/api/*`
with 500 (no Worker), so the cache seams and the `Vary` header are proven by
tests/edgeCachePolicy (21 tests on the real routers with the stand-in
`caches.default`), not by this table.

For one before/after on ONE machine with ONE tool, the review measured the
pre-programme HEAD d3dc28a3 build on this same rig (its finding «verification
record»): cold LCP `/` 2684 (CLS 0.078), `/community` 2532, `/products`
2904, `/product/x` 2872, `/requests` 2448; SW repeat LCP 992 / 928 / 1256 /
1260 / 1044 with 62–64 requests from the SW — against this tree's 2260 / 2432
/ 2692 / 2672 / 2436 cold and 608 / 776 / 1000 / 984 / 752 repeat: −12 to
−424 ms cold, −292 to −384 ms on the repeat, home CLS 0.078 → 0. (And that
HEAD rendered with NO web font, per the corrected caveat above, so the cold
deltas understate the programme.)

## 2026-09-29 — P1a: self-hosted Cairo, service-worker fonts and navigation preload (working tree on a075f21f after P0)

What changed (docs/MERCHANT_PLATFORM_V2.md §B.1 #1 and #10): the Google Fonts
`<link rel=stylesheet>` and both preconnects are gone from index.html; the three
Cairo subsets Google served for `wght@300..900` (arabic 30,896 B, latin 33,820 B,
latin-ext 16,648 B, byte for byte the same files) live under
`public/fonts/cairo/` with their OFL notice; their `@font-face` rules — same
family name, axis, `swap` and `unicode-range` values — sit in the document's
inline `<style>` (the entry stylesheet had 545 B of budget left and the rules
cost 572 B gzip; the document budget had the room, and faces declared in the
document are known before index.css arrives); the Arabic subset is preloaded
(`as=font crossorigin`); the /auth screen's IBM Plex Mono (latin 400/500) is
self-hosted the same way so `src/components/auth/auth.css` no longer `@import`s
a remote stylesheet; `spaCsp()` names no Google font origin in style-src,
font-src or connect-src (documentCsp still does — the print documents link
Cairo from Google, worker/lib/printDocument.ts, a follow-up); `dist/_headers`
gives `/fonts/cairo/*` and `/fonts/ibm-plex-mono/*` the immutable year (the
names carry the upstream version) while the fixed-name Kurdish patch keeps its
week; `public/sw.js` v4 routes `/fonts/*` to the cache-first branch, enables
navigation preload on activate and answers a navigation from
`event.preloadResponse` when the browser has one; `/api`, `/files` and the
manifest stay network-only. Pinned by the new tests/firstPaintAndFonts.test.ts
and the updated tests/securityPolicy.test.ts and tests/serviceWorker.test.ts.

Bytes (gzip -9 of the built files, measured on the two builds):

| | before (post-P0 build) | after | Δ |
|---|---|---|---|
| CSS, all 8 files | 60,895 B (59.47 KB) | 61,023 B (59.59 KB) | +128 B, all in the lazy `Auth` chunk (7,995 → 8,123: two `@font-face` replace one `@import`); `index-*.css` byte-identical at 48,126 B |
| document `dist/index.html` | 3,922 B raw / 1,404 B | 5,004 B raw / 1,901 B | +497 B: the three `@font-face` rules and the preload line; no comments survive the build |
| third-party origins before first paint | 2 (fonts.googleapis.com, fonts.gstatic.com) | 0 | |
| requests before `load`, cold | 7 (incl. the Google stylesheet) | 7 (the Arabic woff2 instead) | wire 264.1 → 295.0 KB: the 30.9 KB font now arrives before `load` instead of after it |

`node --import tsx --test tests/bundleBudget.test.ts` after `npm run build`:
document 1.9 KB, css 59.6 KB, 12/12 pass (the entry and initial-payload
numbers in that run already include the parallel P1 builders' work).

Lab (`scripts/perf-lab.mjs --routes /,/community --sw-repeat`, median of 3;
vite preview of a snapshot of each `npm run build`; `/api/*` answered 500, so
every route rendered its no-API state). READ THE CAVEAT FIRST: this sandbox
reaches fonts.googleapis.com through a fast proxy, so the "before" row does
NOT carry the third-party penalty the survey measured from an Iraqi
connection (home LCP 4.96 s with the Google link, 2.63 s with the stylesheet
local). What the lab can compare is everything else — the same-origin
delivery, the preload's cost, the service worker's repeat visit.

Cold:

| build | route | TTFB | FCP | LCP | CLS | long tasks | req / KB @load |
|---|---|---|---|---|---|---|---|
| before (Google link) | `/` | 4 | 2416 | 2616 | 0.078 | 4 / 507 | 7 / 264.1 |
| before | `/community` | 6 | 2332 | 2584 | 0 | 5 / 398 | 7 / 264.1 |
| **after (preload, shipped)** | `/` | 6 | 2676 | **2796** | 0.078 | 5 / 640 | 7 / 295.0 |
| after | `/community` | 5 | 2428 | **2788** | 0 | 3 / 241 | 7 / 295.0 |
| variant: preload `fetchpriority=low` | `/` | 7 | 2560 | 2720 | 0.078 | 4 / 435 | 7 / 295.0 |
| variant | `/community` | 9 | 2604 | 2988 | 0 | 5 / 521 | 7 / 295.0 |
| variant: no preload | `/` | 5 | 2428 | 2632 | 0.078 | 5 / 504 | 6 / 264.5 |
| variant | `/community` | 4 | 2280 | 2600 | 0 | 5 / 455 | 6 / 264.5 |

Repeat visit with the service worker installed:

| build | route | TTFB | FCP | LCP | req @load (from SW) |
|---|---|---|---|---|---|
| before (sw v3) | `/` | 9 | 932 | 1132 | 7 (64) |
| before | `/community` | 7 | 680 | 912 | 7 (62) |
| **after (sw v4)** | `/` | 161 | **700** | **904** | 7 (66) |
| after | `/community` | 158 | 672 | 880 | 7 (64) |

What the numbers say:

- The repeat visit is the clear win and it is under-measured here: FCP on `/`
  932 → 700 ms and LCP 1132 → 904 ms (−228 ms), `/community` LCP 912 → 880,
  with two more files (the fonts) answered by the worker. The TTFB column
  shows why it is under-measured: with navigation preload the document
  request is issued by the browser and goes through the lab's 150 ms RTT
  throttle (161 ms), whereas v3's worker-issued `fetch` was NOT throttled by
  the CDP emulation (9 ms). In production both go over the same network, so
  the repeat-visit gain is at least what is shown.
- The cold first visit is the honest cost of the preload in a first paint that
  is still JS-bound: the 30.9 KB Arabic font now shares the 1.6 Mbps pipe with
  219 KB of JavaScript before React can paint the H1, and LCP on `/` moves
  2616 → 2796 ms (+180) while the no-preload variant sits at 2632 — the very
  2.63 s the survey predicted for a local stylesheet. Without the preload the
  font is discovered at React's first render and arrives ≈ one RTT + 155 ms
  later (a ≈300 ms fallback-font flash); with it, Cairo is on screen at first
  paint. The preload is shipped as §B.1 #1 specifies; the phase-exit gate
  («LCP on `/` not worse than the previous phase») must be judged on the
  whole of P1 once the JS-before-paint work (§B.1 #6, parallel P1 builders)
  has cut the contention, and the one-line removal is the documented fallback
  if it still costs LCP then. `fetchpriority="low"` on the preload cannot be
  judged in this HTTP/1.1 lab (six connections share bandwidth equally
  regardless of priority); under HTTP/3 in production it should let the
  scripts finish first — unmeasured, so not shipped.
- CLS is unchanged on both routes (0.078 on `/` is the hero/marquee settle,
  §B.1 #7, not the font).
- Follow-ups: move worker/lib/printDocument.ts onto the self-hosted files
  (absolute URLs — receipts are saved and opened from disk) so documentCsp
  can drop the two Google origins as well; re-measure the preload at the
  phase exit.

## 2026-09-29 — P1b «less JavaScript before paint» (plan §B.1 #6), working tree on a075f21f

What changed (all client-side; nothing a visitor sees changed in meaning):

- **Motion off the first paint.** `src/lib/motion.ts` answers the
  reduced-motion question with `matchMedia('(prefers-reduced-motion: reduce)')`
  (same `MotionKit` API, SSR-safe, live on change) instead of importing the
  library's hook; the eager primitives (`ui/Overlay`, `ui/Toast`,
  `ui/Segmented`, `ui/AppBusy`, `pwa/UpdateReadyToast`, the search panel)
  render `m.*` from `motion/react-m` under a `LazyMotion` seam
  (`src/lib/motionFeatures.tsx`, features = `domMax` because the sheets drag
  and the toasts animate layout) and `useRail` keeps only `animate`.
  `vite.config.ts` splits the library by module: `vendor-motion-core` (the
  value animator, `m`, AnimatePresence — eager) and `vendor-motion` (the
  projection tree, drag/pan/hover/press, layout, the `motion` proxy and the
  `motion` package's own module — lazy, reached by the features bundle and by
  every page that still renders `motion.*`).
- **Lazy where the first screen does not look.** Header: the notification
  bell (rendered once `isAuthenticated`), the tier table (loaded for a paid
  plan; the pill changes once, «free» → plan, never through a raw id); the
  live-search panel's animated container (`LiveSearchPanel`, armed on
  `pointerdown`/`focus` of the field — the input, the request, the rows and
  the keyboard stay in `LiveSearch.tsx`); App: the verify banner, «complete
  your profile» and «choose the appearance» (mounted once the session resolves
  to a user — each renders nothing before that moment anyway).
- **`useIdlePrefetch` retimed.** Waits for `homeCriticalReadyStore` (on `/`)
  AND `document.fonts.ready`, then an idle slot with no timeout (Safari: a
  2 s timer); prefetches `Products` and the motion features only.
  `Product`/`Cart`/`Addresses` are fetched on the first `pointerdown`
  (capture) or `focusin` over a link that leads there.
- **`vendor-icons`.** Lucide icons that two or more LAZY modules share become
  one chunk (`iconChunk` reads each module's import list and the package
  index's alias table; icons the entry uses stay inlined; the factory rides
  with `vendor-react`). 112 icon-only chunks under 1 KB → 0.

### Bytes (gzip −9, `npm run build`, measured with the bundle test's closure walk)

| | before | after | Δ |
|---|---|---|---|
| entry chunk | 81.9 KB | **65.0 KB** | −16.9 |
| initial payload (entry + static closure) | 212.1 KB / 4 files (react 72.7, motion 45.9, i18n 11.6) | **181.6 KB / 4 files** (react 73.3, motion-core 31.7, i18n 11.6) | **−30.5** |
| animation features before paint | 45.9 KB (all of motion) | 0 (`vendor-motion` 15.7 KB, lazy) | −45.9 / +31.7 core |
| JS chunks / under 1 KB raw / icon-only | 395 / 138 / 112 (39.2 KB gz together) | 294 / 29 / 0 (`vendor-icons` 12.0 KB) | −101 files |
| CSS total | 59.6 KB | 59.6 KB | 0 (nothing new to pay for) |
| storefront pages' own closure beyond initial | 46.3 KB (15 icon chunks, 4.8 KB, inside it) | **40.3 KB** + shared `vendor-motion` 15.7 + `vendor-icons` 12.0 | own −6.0; a store visitor's total 258.4 → 249.6 |
| merchant workspace shell closure | 30.9 KB | 24.6 KB + shared `vendor-icons` 12.0 | own −6.3; +5.7 on the first workspace open |
| document | 1.9 KB gz (P0 strip) | 1.9 KB | — |

Budgets re-cut in `tests/bundleBudget.test.ts`: entry 120 → **72 KB**, initial
240 → **200 KB** (measured + ~10 %); the storefront and workspace closures
now count the pages' own weight and print the shared `vendor-*` chunks, which
`tests/motionLazy.test.ts` caps on their own (features ≤ 20, core ≤ 40, icons
≤ 16 KB; ≤ 45 chunks under 1 KB; no projection/drag/pan fingerprint anywhere
in the initial payload).

### Lab (`scripts/perf-lab.mjs`, cold, median of 3; `/api/*` answers 500 under `vite preview`, so every route is its no-API state)

CAVEAT — READ BEFORE COMPARING. The two snapshots are the working tree ~45
minutes apart, and P1a's self-hosted Cairo landed in between: the «after»
document preloads `/fonts/cairo/cairo-v31-arabic.woff2` and has no Google
stylesheet, the «before» one has the Google `<link>` (which this sandbox's
proxy answered quickly — hence 2.6 s and not the survey's 4.96 s). The byte
deltas above are P1b's alone; the timing deltas below are P1b + P1a's fonts,
on the same machine, same throttle, same routes, run back to back.

| route | FCP before → after | LCP before → after | CLS | long tasks before → after (n / ms) | KB @load (wire) |
|---|---|---|---|---|---|
| `/` | 2636 → **2484** | 2928 → **2688** | 0.078 → 0.078 | 5 / 564 → 5 / 539 | 295.0 → 264.4 |
| `/community` | 2720 → 2272 | 2868 → 2520 | 0 | 5 / 591 → 3 / 295 | 295.0 → 264.4 |
| `/products` | 2376 → 2256 | 3020 → 2840 | 0 | 3 / 315 → 5 / 384 | 295.0 → 264.4 |
| `/product/x` | 2604 → 2332 | 3032 → 2840 | 0.075 → 0.075 | 5 / 384 → 3 / 320 | 295.0 → 264.4 |
| `/requests` | 2464 → 2200 | 2776 → 2428 | 0 | 4 / 400 → 3 / 245 | 295.0 → 264.4 |
| `/auth` | 2956 → 2412 | 3040 → 2796 | 0 | 4 / 495 → 5 / 447 | 295.0 → 264.4 |
| `/community/store/x` | 2436 → 2252 | 2740 → 2512 | 0 | 4 / 349 → 3 / 279 | 295.0 → 264.4 |

Repeat visit with the service worker (median of 3):

| route | FCP before → after | LCP before → after | requests @load (served by the SW) before → after |
|---|---|---|---|
| `/` | 708 → 696 | 876 → 896 | 7 (66) → 7 (**20**) |
| `/products` | 700 → 740 | 1272 → 1256 | 7 (64) → 7 (**19**) |

What the numbers say:

- Every route paints 120–540 ms earlier and reaches its LCP 180–350 ms
  earlier; the home's LCP 2928 → 2688 ms. −30 KB on the wire before `load`
  is the JavaScript that left the first paint (the fonts P1a added are in the
  same figure). TBT is near zero in every run of this lab either way; the
  long-task total on the home moved little (564 → 539 ms — the parse of the
  motion core, React and the entry is still there), and fell by a third to a
  half on the routes whose first screen is small (community 591 → 295,
  requests 400 → 245).
- The idle prefetch no longer floods the pipe: the repeat visit served 66
  requests from the service worker before, 20 now — the 57-chunk prefetch of
  the survey is gone; the cold `/` still shows 7 requests at `load` because
  `Products` and the features arrive after the fonts and the idle slot.
- CLS is untouched (0.078 on `/`, 0.075 on `/product/x`) — that is P1a/P1c's
  skeleton and hero work, not this change.

Runtime check (Playwright against the preview, 360×800, both motion
preferences, 30/30): no features bundle or `vendor-icons` request before
`load`; the features and `Products` requested from idle, `Product` not;
focusing the header search requests `LiveSearchPanel`; typing opens the panel
at opacity 1; the «اللغة والمظهر» sheet opens, its panel reaches opacity 1,
the grabber shows (and hides under reduced motion), the segmented indicator
draws; no page errors.

Not done / for the owner: `pages/farm` stays in the entry (0.7 KB gz) because
`tests/farmShelved.test.ts:382` pins the eager `FarmGate` import and the
skeleton is its dependency; `LangThemeSheet` stays because
`tests/langThemeSheet.test.ts` pins its import in the Header and its Sheet in
the same file (its `Segmented` now renders `m.*`, so it costs no feature
code). The store pages (`StorefrontProduct.tsx`, `StoreCta`, the follow pill)
and ~60 lazy modules still render the `motion.*` proxy, so the 15.7 KB feature
chunk is in the storefront's closure — converting them to `m.*` under
`<MotionFeatures>` takes it off the store's first paint (P11 / P1c's files).

## 2026-09-29 — P1c: layout stability, skeletons, the /auth check, storefront first paint (plan §B.1 #7, #11; storefront L1/L2; closure paybacks), working tree on a075f21f after P0/P1a/P1b

What changed (nothing a visitor reads changed; every box below is the box
the content lands in):

- **Home** (`src/pages/Home.tsx`, `src/components/home/Hero.tsx`). The hero's
  loading state was a grey 380/460px box; the brand hero it resolves to on the
  live site (no banners configured) is content-sized — **491px at 360 wide** —
  so every first visit moved the sheet below by 111px when `/api/home`
  answered. The fallback hero is now drawn at once (its words need no data;
  `data-hero-loading` marks the in-flight state) and the ticker row keeps its
  40px (`py-2.5` around a 13px line) while the answer is in flight or never
  comes, instead of a 16px cap that grew by 24px. A loaded page WITHOUT ads
  keeps the 16px cap it had. Residual: a site with banners configured swaps
  the brand hero for the 380px carousel once, on the first visit only (the
  page-cache snapshot paints every later visit right) — the alternative, a
  fixed-height brand hero, would change its look and is left to the owner.
- **Product page** (`src/components/ui/Skeleton.tsx` `ProductDetailSkeleton`):
  the skeleton was the OLD page (full-bleed 320px hero, `rounded-b-3xl`, no
  side padding); it now mirrors `src/pages/Product.tsx` box for box — the
  `max-w-[1540px] px-4 pt-2` shell, the gallery frame at its responsive
  height, the thumbnail row, then title, store line and signal chips drawn
  inside real line boxes (the same type classes around a zero-width space,
  so each row is exactly as tall as its words at every breakpoint), the price
  card, and the lg two-column layout. Measured at 360, skeleton → loaded:
  gallery 80/281 → 80/281, thumbs 373/68 → 373/68, title block 461–553 →
  461–553, price card 573/66 → 573/66. Not one new utility class: every
  class was already in the stylesheet (CSS unchanged).
- **Storefront** (new `src/components/storefront/skeletons.tsx`, in the store
  pages' lazy closure, never in the entry): `StoreHomeSkeleton` replaces the
  black spinner of `Storefront.tsx` (cover 144, identity 103, stats 43, bio
  36, links 28, cards 51, actions 30, strip 44, tiles 103×156);
  `StoreProductPageSkeleton` replaces the spinner of `StorefrontProduct.tsx`
  (back row 60, square gallery, name 25, price 28, store card 70, three
  description lines, the buy bar's box); `ProductGridLoading` replaces the
  products tab's spinner in `blocks/ProductsGrid.tsx` with tiles in the
  theme's own grid (`sf-grid`/`sf-tile`/`sf-media`, so columns, gap, ratio
  and card style follow the merchant's tokens) under the view's 36px title
  row. Measured at 360 on the host root: grid 661/322 in both phases, footer
  at 1007 in both phases (before: spinner 27px → grid 322px, footer moved,
  CLS 0.0205).
- **Hero L2** (`blocks/Hero.tsx`): for the `cover` and `split` variants the
  Suspense fallback is the variant's own picture frame with the eager
  `<img fetchpriority=high>`, so the LCP image is requested with the page
  instead of after the `extra` chunk; the variant re-renders the same URL and
  the browser serves it from the request in flight. `minimal` keeps
  `min-h-48`.
- **Closure paybacks**: `profileIcons` (`WidgetIcon`, link pills and info
  cards) is `lazy()` with a same-size empty slot as fallback; `ProductFacts`
  (which carries `attributes`, the palette and `swatches.css`) is `lazy()` in
  `StorefrontProduct.tsx`, its chunk requested in parallel with the product
  answer and its box held by `ProductFactsSkeleton` (the same `dl` classes,
  one dt/dd line pair per row the answer says it has — `factRows` repeats
  `ProductFacts`'s own tests). `governorates` (0.6 KB) stays static: its
  label is first-screen text in the profile hero's info card and in the
  delivery line, and loading it behind the paint would show the word a beat
  late — a visible change for 0.6 KB; the honest payback there is the server
  sending the label (not this phase).
- **/auth** (plan #11): NOT a code change — the survey's «جارٍ التحميل…»
  forever was reproduced on the P0-baseline dist with the API failing:
  `Unable to preload CSS for /assets/Auth-*.css` — the Auth stylesheet's
  remote `@import` of IBM Plex Mono from fonts.googleapis, which never
  resolved from the sandbox, so the lazy route never mounted and the route
  fallback stayed. P1a self-hosted that font and removed the import; on the
  current build `/auth` paints the sign-in form with every `/api/*` answering
  500 (FCP 2.3 s, no spinner, no loading text, 3/3 runs). A capabilities
  failure already falls back to email/password (`loadCapabilities` → offline
  set). CORRECTED by the P2 review: a chunk failure did NOT show the
  `ChunkBoundary` card on `/auth` — the full-screen route tree had no
  boundary (only the storefront and main trees did), so an aborted
  `Auth-*.js` unmounted the root to a blank page; the boundary was added in
  the review fixes (App.tsx, tests/firstPaintAndFonts, scripts/e2e-resilience.mjs).
  Nothing on the page blocks on `/api/settings/public`.
- `tests/storefrontBlocks.test.ts`: `ui/Skeleton` added to the storefront
  blocks' import allow-list (react and the language context only).

### Bytes (gzip −9, `npm run build`, the bundle test's closure walk; 12/12 pass)

| | before (P1b build) | after | Δ |
|---|---|---|---|
| storefront pages' own closure beyond initial | 40.3 KB (`attributes` 1.5, `profileIcons` 1.2, `theme` 3.9, `StoreRenderer` 10.2, `StorefrontProduct` 6.4) | **39.2 KB** (`attributes`/`profileIcons`/`ProductFacts` lazy; `swatches` 0.6 now its own chunk, reached by the variant picker; `theme` 5.0 with the skeletons, `StoreRenderer` 10.4 with the hero frame, `StorefrontProduct` 6.0) | −1.1 (paybacks −2.7, skeletons +1.1, frame +0.2, swatches split +0.6 gross) |
| entry chunk | 65.0 KB | 65.3 KB | +0.3 (the product skeleton mirrors more of the page) |
| initial payload | 181.6 KB / 4 files | 181.9 KB / 4 files | +0.3 |
| CSS, all 8 files | 59.6 KB (`index` 47.0) | 59.6 KB (`index` 47.0, byte-identical) | 0 — no new utility class |

### Lab A — the official lab (`scripts/perf-lab.mjs`, cold, median of 3, `/api/*` answers 500 under `vite preview`, so every route is its no-API state; the two builds served side by side from snapshots)

| route | FCP before → after | LCP before → after | CLS before → after | long tasks (n / ms) |
|---|---|---|---|---|
| `/` | 2488 → **2340** | 2732 → **2340** (the H1 is painted at first render, not after the failed fetch) | **0.078 → 0** | 5 / 548 → 3 / 358 |
| `/product/x` | 2732 → 2776 | 2900 → 2912 | 0.075 → 0.075 (see below) | 5 / 422 → 4 / 381 |

### Lab B — the same phone with the API answered from fixtures captured from the live site (so the pages go loading → content; each shift attributed to the element that moved; scratchpad `p1c/cls-lab.mjs`, `p1c/fixtures/*`; fulfilled answers delayed by 250 ms + bytes/200 to stand in for the throttle they bypass; a synthetic store `demo3d` under `demo3d.localhost`, since no store exists on the live site yet). Median of 3, cold.

| route | CLS before → after | the shift, before | FCP before → after | LCP before → after (element) |
|---|---|---|---|---|
| `/` | **0.0942 → 0** (3/3 runs each) | 4033 ms: the black cap `div.relative.z-30.-mt-7` moved 352 → 463 (hero 380 → 491, ticker 16 → 40) | 2488 → 2540 | 4756 → 4700 (the bento's promo photo, both) |
| `/product/bambu-hotend-a1-a2` | 0.075 → 0.075 | 2666 ms: `main#main-scroll-container` moved 60 → 0 — exactly 60 px / 800 = 0.075 | 2248 → 2440 | 4148 → 4172 (the gallery image, both) |
| `demo3d.localhost/` (store home, host) | **0.0205 → 0** | 3042 ms: the footer column moved when the products tab's 27 px spinner became the 322 px grid | 2240 → 2332 | 3228 → 3164 (the cover image, both) |
| `demo3d.localhost/p/…` (store product) | 0 → 0 | — | 2300 → 2360 | 3880 → 3860 (the gallery image, both) |
| `/auth` | 0 → 0 | — | 2368 → 2368 | 3092 → 3052 |

(Lab B's first `before` run of the store host is discarded: its images were
being fetched from the live site for the disk cache and did not paint inside
the settle window; the numbers above are the warm re-run.)

### What the numbers say

- The home's CLS is gone in both states (0.078 → 0 no-API; 0.094 → 0 with
  data) and its LCP in the no-API state falls 392 ms because the fallback
  hero — the LCP element — is on screen at first render. With data the LCP is
  the bento's photo at ≈4.7 s either way: that is the D1/`/api/home` wait
  (207 KB of JSON on the live site) and the image after it — P2's cache work
  and §B.2, not layout.
- **The product page's 0.075 is not the skeleton and is not in P1c's files.**
  It is `MotionCharacterFallbackHeader` (App.tsx, rendered while
  `navHidden`): a 60 px landing strip above `#main-scroll-container` that
  unmounts the moment the page's own `lv-character-header` registers an
  anchor, so `main` moves up 60 px (0.075 = 60/800, 3/3 runs, at 2.7 s — when
  the route chunk mounts, before any data). The page's header then occupies
  the same pixels, so the viewer sees nothing move; the metric does. The fix
  belongs to the App.tsx churn PR (§C P1): keep the fallback strip out of
  flow on routes whose page owns the anchor (`/product/*`), or reserve it as
  the page's header height in `RouteFallback` — one of the two, measured.
  Everything else on `/product/x` already lands on its own pixels (the
  geometry table above).
- The store pages: 0.0205 → 0 on the host root (the tab grid), 0 → 0 on the
  product; the closure fell to 39.2 KB with the skeletons paid for by the
  paybacks; LCP within noise (the cover / gallery image at ≈3.2 / 3.9 s under
  the fixture delays).
- CSS is byte-identical; no `@source`, no new class, no hex, no `dark:`.

Follow-ups: the App.tsx fallback-strip fix above; `governorates` via the
server's label; a `--fixtures` mode for `scripts/perf-lab.mjs` (Lab B's
route table and delay model) so data-ready CLS/LCP is measured in the same
tool; `tests/communitySearchUi.test.ts:11` («Tailwind scans docs/ again»)
fails against P0's `source(none)` + `@source` list in `src/index.css` — a
textual pin on the old `@source not` lines, for the index.css owner (the
docs tree is not scanned either way).

## 2026-09-29 — P2b: documents, preloads and the client waterfall (plan §B.1 #3; §B.2 Early Hints / Cache Rules readiness; placement prep), working tree after P0/P1/P2a-in-flight

What changed (same pages, same words; the browser learns earlier what it was
going to learn anyway):

- **The documents the Worker already rewrites** (`/product/*`, `/bundles/*`,
  a store's `/` and `/p/*` on its host, `/community/store/<ref>[/p/*]` —
  `worker/index.ts` `assetWithPreview`, helpers in `worker/lib/socialPreview.ts`)
  now also carry: `<link rel="modulepreload">` for the route's chunk and its
  whole static closure beyond the entry (from `dist/.vite/manifest.json`,
  `build.manifest = true`, read once per isolate per ASSETS binding);
  `<link rel="preload" as="image" fetchpriority="high">` for the product's
  lead image / the store's cover (same-origin `/files/` path only); and the
  ANONYMOUS `/api/storefront/resolve` answer as `<script
  type="application/json" id="lv-resolve">` (dispatched to the route itself
  inside the Worker with the Host and no cookie; accepted only when it names
  this host's kind and slug). The response keeps a **weak ETag of the
  rewritten body** (304 on `If-None-Match`; the asset's own validator never
  survives), a `Link` header naming the entry stylesheet and the Arabic font
  (Early Hints readiness), and `Cache-Control: public, max-age=0,
  s-maxage=60, stale-while-revalidate=600` when nothing about the response
  depended on a session (`!c.get('user')` and no `Set-Cookie`; these paths skip
  the session lookup, and the inline answer is the anonymous one) — otherwise
  `no-cache`. Every other document passes through as the asset came.
  `dist/_headers` (`scripts/write-asset-headers.mjs`) gains the same `Link`
  on `/*` and `! Link` on every rule after it.
- **The client** (`src/lib/bootFetch.ts`, new; `src/StoreContext.tsx`;
  `src/pages/Home.tsx`; a comment at the gate in `src/App.tsx`): the data
  block is read synchronously, so `resolved` is true on the first render and
  the route fallback frame never renders on those documents; on every other
  document `/api/storefront/resolve` — and on `/`, `/api/home` — leave at
  module evaluation, before React mounts, and the consumers take the primed
  response once (`settleJson` mirrors `api.get`: same deadline, same
  `ApiError` shape, same mascot feedback; a retry goes through `api.get`).
- **Placement prep**: a commented top-level `"placement": { "mode": "smart" }`
  block in `wrangler.jsonc` with the reason and the measurement recipe;
  `placement` on the fold list of `scripts/prepare-deploy-config.mjs`; a
  sampled (≈2 %) `document_region` log line from `assetWithPreview`
  (`colo`, `country`, `cf-placement` request header, D1
  `meta.served_by_region` and its round trip, the rewrite's own ms) beside
  P2a's once-per-isolate `d1_region` line in `worker/routes/products.ts`;
  DECISIONS row 171 drafted «⏳ للمالك».

### Bytes (gzip −9; `npm run build` on this tree, 12/12 bundle tests pass)

| | value | note |
|---|---|---|
| entry chunk | 65.8 KB (budget 72) | P1c measured 65.3; `bootFetch` is ≈1.2 KB of source gzip before minification, the rest is concurrent P2 client edits |
| initial payload | 182.4 KB / 4 files (budget 200) | |
| CSS, all files | unchanged by this PR (no new class) | |
| store home document, rewritten | 3,599 B wire (3,170 B gzip −9; 10.2 KB raw) vs 1,996 B before | +1.6 KB: the resolve answer (store profile, stats, published layout) that the client fetched as its own request before — the bytes moved, they were not added |
| store product document | 3,585 B wire vs 1,993 | same |
| platform product document | 2,412 B wire vs 2,017 | the apex answer is 70 B; the rest is 18 preload links |
| preloaded closure | Storefront 15 chunks 57.2 KB + 1.5 KB css; StorefrontProduct 13 / 48.2 + 2.0; Product 18 / 98.0 | bytes the route fetches anyway, now discovered from the document |

### Lab — the Worker in place (`wrangler dev` on the built dist with a seeded local D1 + local R2, `STORE_ROOT_DOMAIN=localhost`; Playwright 360×800, CPU ×4, Slow-4G 150 ms / 1.6 Mbps, cold context, median of 3; scratchpad `p2b/waterfall.mjs`, JSON in `scratchpad/p2b/*.json`)

Columns: when the ROUTE CHUNK was requested → finished; when `resolve` was
requested → answered («inline» = read from the document, no request); when
the first `/files` image was requested → finished; `h1` = the page's own
heading in the DOM; all ms from the document request.

| route | TTFB | doc B | route chunk | resolve | image | React root | h1 | FCP | LCP | CLS |
|---|---|---|---|---|---|---|---|---|---|---|
| store home `ali3d/` — before | 30 | 1996 | 2294→2560 | 2024→2239 | 3148→3470 | 1984 (fallback) | 3281 | 2672 | 3536 (cover) | 0 |
| store home — **after** | 22 | 3599 | **210→1333** | **inline** | **223→2392** | 2259 (the page) | **2934** | 2640 | **3088** (cover) | 0 |
| store product `/p/…` — before | 21 | 1993 | 2237→2265 | 1958→2194 | 2968→3288 | 1925 (fallback) | 2967 | 2820 | 3332 (gallery) | 0 |
| store product — **after** | 32 | 3585 | **198→1508** | **inline** | **202→2311** | 2222 (the page) | 3035 | **2528** | **3104** (gallery) | 0 |
| `/product/filament-pla` — before (two runs of 3) | 21 / 27 | 2017 | 2219→2250 / 2240→2309 | 1980→2153 | — (fixture had no gallery image) | 1952 | 3087 | 2660 / 2300 | 3204 / 3120 (price text) | 0.075 |
| `/product/filament-pla` — **after** | 39 | 2412 | **216→1935** | **inline** | 217→2784 | 2411 | 3181 | 2780 | 3608 (gallery image — not comparable, see below) | 0.075 |
| `/` (apex home) — before | 15 | 2204 | — | 2001→2171 | — | 1964 | 2419 | 2472 | 2472 (H1) | 0.016 |
| `/` — **after** | 47 | 2205 | — | **1898→2062** (module evaluation) | 2883→3214 | 2001 | 2365 | 2448 | 2448 (H1) | 0.016 |

`/api/home` on `/`: requested at **2400 → 1900 ms** (−500 ms; it leaves with
the resolve request instead of after `Home` mounts).

### The variants that were measured before choosing (store home / store product; same lab)

| variant | route chunk done | image done | h1 | FCP | LCP | KB before FCP |
|---|---|---|---|---|---|---|
| before (no preloads, resolve fetched) | 2560 / 2265 | 3470 / 3288 | 3281 / 2967 | 2672 / 2820 | 3536 / 3332 | — |
| A: 8 chunks, image `fetchpriority=high` | 1340 / 1504 | 2099 / 2171 | 3125 / 3161 | 2604 / 2612 | 3292 / 3228 | 374 / 385 |
| B: 8 chunks, image default priority | 1336 / 1533 | 2094 / 2177 | 3079 / 3204 | 2636 / 2748 | 3236 / 3260 | 374 / 385 |
| C: no chunk preloads, image default, inline resolve only | 2386 / 2394 | 1862 / 1885 | 3348 / 3393 | **2500 / 2516** | 3564 / 3468 | 331 / 349 |
| D: whole closure (cap 24), image high — **shipped** | 1328 / 1543 | 2388 / 2320 | **2883 / 3117** | 2628 / 2556 | **3028 / 3196** | 394 / 385 |
| E: whole closure, image default | 1331 / 1547 | 2387 / 2322 | 2813 / 3110 | 2752 / 2532 | 2980 / 3196 | 428 / 385 |
| final re-run of D (the table above) | 1333 / 1508 | 2392 / 2311 | 2934 / 3035 | 2640 / 2528 | 3088 / 3104 | 397 / 385 |

What the numbers say:

- **The route chunk is discovered with the document** (2.2–2.3 s → ≈0.2 s) and
  is on the phone before the entry has finished executing (done at 1.3–1.5 s
  against a React root at 2.2 s). The entry's own arrival did not move in any
  variant (entry / vendor-react / css done ≈1.9 / 2.0 / 1.5 s throughout), so
  the fear that the preloads would starve the critical path did not
  materialise in this lab.
- **The resolve gate is gone on those documents**: no fallback frame; the
  first React commit is the page. The cost is the document: +1.6 KB wire on a
  store host, and — in production, not visible locally — the resolve's D1
  waves now sit on the document's TTFB (locally 22–32 ms, unchanged). That is
  exactly the trade the plan's «Cache Rules for HTML» row absorbs: with the
  rule on, the Iraqi PoP answers the document from cache for 60 s and serves
  stale for 600 s while revalidating; the header is already emitted.
- **Store pages**: LCP −448 ms (home) and −228 ms (product); FCP −32 / −292;
  the heading is in the DOM 347 ms earlier on the home. The cover / gallery
  image is requested at ≈0.2 s instead of ≈3 s; it finishes ≈1.1 s earlier.
- **Whole closure beats a cap of eight** (D vs A: LCP −264 / −32, h1 −242 /
  −44) because the browser otherwise learns the remaining chunks only when
  the route chunk arrives. Naming no chunk at all (C) has the best FCP
  (−100 ms) and the worst LCP and content time (+250–300 ms): the chunk
  bytes are spent either way, and spending them early wins on this
  connection. `fetchpriority=high` on the image (D vs E) is within noise
  (±100 ms between runs); the plan's value is kept.
- **The platform product page did not gain** in this lab: FCP 2660/2300 →
  2780, data request 2671 → 2825, root commit 1952 → 2411 (before, that
  commit was the fallback; after, it is the page). Its preloaded closure is
  the largest (18 chunks, 98 KB gzip: the page carries the tier table,
  recently-viewed, the pro-address notice…) and on a 6-connection HTTP/1.1
  lab it delays the entry's arrival by ≈140 ms (entry done 2041 vs 1898 on
  the store host). LCP is not comparable (the before fixture had no gallery
  image; after, the image IS the LCP at 3608 — the lab's local R2 serves it,
  the real site's `/files` cache does not exist locally). Measured next, on
  this route alone, cap 8 vs the whole closure (cap 24, median of 3): route
  chunk done 1921 vs 1913, data request **3108 vs 2776**, h1 **3570 vs 3151**,
  FCP 2720 vs 2872, LCP **3988 vs 3568**. The whole closure wins on content
  and LCP by ≈420 ms and loses ≈150 ms of FCP (the skeleton paints later);
  the entry's arrival is identical (2024 ms). Kept at the whole closure.
- `/`: no document change (it is not rewritten); the two boot requests leave
  ≈100 / 500 ms earlier and FCP/LCP are within noise. CLS unchanged
  everywhere (0.075 on `/product/*` is the App.tsx strip P1c documented).

Caveats: `wrangler dev` is HTTP/1.1 without server priorities and its D1 is
a local SQLite — TTFB deltas from the resolve sub-request and the Early Hints
`Link` (which needs Cloudflare's 103) are NOT measured here; the deltas that
are measured are the browser's (discovery, gate, order of requests). Other
P2 builders were editing worker routes in the same tree while this ran (the
"before" worker is the tree at the moment of the run, snapshot dist
`p2b/dist-before`; the "after" is the same tree with this PR, dist
`p2b/dist-after`).

### Production measurement the owner runs (nothing here can be measured locally)

1. `curl -sI https://<store>.levonis-iq.com/ | grep -iE 'etag|cache-control|link|cf-cache-status'` — the ETag, the policy and the `Link` are there; `cf-cache-status` stays `DYNAMIC` until the HTML Cache Rule exists, then `HIT`/`STALE`.
2. Cache Rules → host `levonis-iq.com, *.levonis-iq.com`, path not `/api/*`, `/files/*`, `/assets/*`; «Use cache-control header if present, bypass otherwise»; Respect Origin. Documents that say `no-cache` (everything not rewritten, anything session-dependent) are bypassed by that rule.
3. Speed → Early Hints on; verify with `curl -sv --http2 https://levonis-iq.com/product/<slug> 2>&1 | grep -E '^< HTTP/2 103|^< link'`.
4. `scripts/psi.mjs` before/after for `/`, a product page and a store host: «Server response time» and LCP.
5. Observability: query `event:"d1_region"` (P2a, once per isolate) and `evt:"document_region"` (this PR, 2 % of rewritten documents: `colo`, `cf_placement`, `d1_region`, `d1_ms`, `doc_ms`) — then DECISIONS row 171.

Follow-ups: `worker/lib/printDocument.ts` still links Cairo from Google
(P1a note); P2c's responsive `?w=` variants, when they land in `SafeImage`,
must be mirrored in `preloadImagePath` (`socialPreview.ts`) or the image
preload becomes a second download — `tests/documentPreloads.test.ts` pins the
exact href, so the drift will fail a test, not a visitor; P2a's `d1_region`
line could carry `cf-placement` too (their file); the browser typecheck
(`tsc -p tsconfig.json`) has no `include` list and does not exclude
`scratchpad/`, so a `.ts` scratch file there (P2a's, mid-run) briefly put
680 fixture errors into it — clean again at the end of this PR (0 errors),
but a `scratchpad` entry in `exclude` would make that impossible.

## 2026-09-29 — P2a: the edge policy for the anonymous public reads, and the D1 waves under them (plan §B.1 #2, #4), working tree after P0/P1a/P1b/P1c

What changed (nothing a visitor reads changed; the same bodies, from nearer):

- **One helper, `worker/lib/edgePolicy.ts`** over `publicApi/cache.ts`
  (`edgeCache`/`weakEtag`/`conditional`): `anonymousCached(c, {params,
  lifetime}, build)`. A GET with no session cookie, no `Authorization` and no
  resolved user is served from the colo's cache under the canonical key
  `https://<Host>/<path>?<declared params, sorted>` and leaves — hit or miss,
  200 or 304 — with `public, max-age=60, s-maxage=120,
  stale-while-revalidate=600` and a weak ETag; a request that carries a
  session runs the route as before and leaves `private, no-store` (the
  community verdict keeps its pinned `no-store`). Only a non-empty 200 is
  stored; a HEAD, a refusal and a session answer never are. The re-stamp of
  `catalog.ts:84-96` is kept (the zone's four-hour Browser Cache TTL would
  otherwise reach the browser on a hit).
- **Applied to** `/api/home`, `/api/home/sections`, `/api/products` (key from
  `search/category/type/limit/offset` + the listing grammar's keys),
  `/api/products/:slug`, `/api/settings/public`, `/api/community/access`,
  `/api/storefront/resolve` (keyed by Host: each store host its own, the apex
  its `store: null`), `/api/storefront/:slug`, `/:slug/products` (+ `/:productSlug`),
  `/:slug/reviews`, `/:slug/sections|services|showcase`, `/by-id/:id`,
  `/api/print-quote/printers|materials|accessories`, `/api/marketplace/print/catalog`.
- **`delivery_to_you` left the store body.** It was the one viewer-dependent
  field in `/api/storefront/:slug` and `/resolve` and the product answer's
  store; `publicStore` takes no viewer any more and the shopfront is
  byte-identical for a guest and a member (tests/edgeCachePolicy.test.ts,
  tests/storefrontIsolation.test.ts). The signed-in visitor's «التوصيل إلى
  محافظتك» is the existing `GET /:slug/delivery` answer, asked for by
  `storefrontApi.deliveryToYou(slug)` from `Storefront.tsx` and
  `StorefrontProduct.tsx` once the store and the viewer are known, and merged
  under the key the parts already read — the words on the page are unchanged
  (`deliveryToYou`/`parts.tsx` untouched; tests/deliveryClient pins hold). A
  guest asks nothing.
- **Purge seams** (per colo, like `purgeCatalogTreeCache`): the settings PUT
  (`afterSettingsWrite`: `/api/settings/public`, and by key the first screen,
  the shelves, the listing, the print catalogue, plus the isolate's pricing
  inputs), the community gate PUT (`/api/community/access`), a store's layout
  publish and restore-and-publish (`/resolve` + `/api/storefront/:slug` on
  the store's own host, on the apex, and on the request's host), the
  printer-model PATCH (the four print catalogue paths).
- **The session-free GETs** (`worker/lib/session.ts sessionFreePublicGet`,
  one branch in `worker/index.ts` before `loadSessionUser`): the public
  settings, the whole storefront router but `/:slug/delivery`, the print
  materials/accessories, the wizard's catalogue. Their handlers never read
  `user` (pinned by source in tests/edgeCachePolicy.test.ts), so a signed-in
  shopper opening a store no longer pays the `sessions` × `users` JOIN for
  the store, its products, its reviews or its shelves. `/api/home`,
  `/api/products*`, `/api/community/access`, `/print-quote/printers` price or
  answer per viewer and keep loading the session.
- **D1 waves.** `pricingCtxForUser`'s four shared inputs (policy settings,
  benefit rules, section ancestry, PRO pause) are `pricingInputsFor(db)` in
  `membershipBenefits.ts`: read in ONE wave with the viewer's tier on a cold
  isolate (they used to wait for the settings first), from memory for 30 s
  (WeakMap by binding, as `catalogIndexFor`), forgotten at once by
  `saveBenefitRule`/`deleteBenefitRule` and the settings PUT. The product
  page's pool membership, offer window and «يناسب» links moved into the
  row's first wave (they were three dependent awaits). The home shelves'
  filament-root lookup no longer heads the whole wave. The shopfront reads
  the owner's tier ONCE (`storeTakesOrders`/`sellingVerdict` accept the
  already-read tier — it was read twice, four dependent round trips each),
  its four stat counts are one `db.batch`, and the reviews page and its
  distribution go out together.
- **`meta.served_by_region`** is logged once per isolate from the first
  `/api/home` answer as `{"event":"d1_region", served_by_region,
  served_by_primary, colo, country, host}` — the evidence §B.2's D1 location /
  Smart Placement decision (DECISIONS row 171) needs. Nothing else about
  placement changed.
- **The double `/api/community/access`** (survey): reproduced only while the
  API fails — the first refusal was forgotten instantly and the services grid,
  mounting ~700 ms after the bottom bar, asked again. A failed answer is now
  shared for 4 s by the components of one page load (`reload` still clears
  it; a later mount still retries).

### D1 per request — prepares / executions / **dependent waves**, wall ms with a simulated 20 ms round trip (tests/fixtures/wavesD1.ts through the real routers and migrations; cold = first request of the isolate, warm = second, member = signed-in customer, warm)

| route | before: guest cold · guest warm · member | after: guest cold · guest warm · member |
|---|---|---|
| `/api/home` | 21/21/**4** 151 · 21/21/**4** 98 · 25/25/**7** 158 | 21/21/**3** 136 · 17/17/**3** 75 · 21/21/**6** 134 |
| `/api/home/sections` | 21/21/**5** 116 · 21/21/**5** 107 · 25/25/**8** 170 | 17/17/**4** 91 · 17/17/**4** 87 · 21/21/**6** 129 |
| `/api/products` | 17/17/**3** 75 · 16/16/**3** 70 · 20/20/**6** 136 | 13/13/**2** 52 · 12/12/**2** 51 · 16/16/**5** 117 |
| `/api/products/:slug` | 21/21/**6** 135 · 21/21/**6** 129 · 26/26/**9** 215 | 17/17/**2** 50 · 17/17/**2** 47 · 22/22/**5** 107 |
| `/api/storefront/resolve` (store host) | 23/23/**9** 193 · 23/23/**9** 191 · 24/24/**9** 192 | 19/16/**5** 109 · 19/16/**5** 107 · 19/16/**5** 116 |
| `/api/storefront/:slug` | 23/23/**9** 192 · same · 24/24/**9** 191 | 19/16/**5** 109 · same · 19/16/**5** 107 |
| `/api/storefront/:slug/reviews` | 3/3/**3** 65 | 3/3/**2** 45 |
| `/api/storefront/:slug/products` | 2/2/**2** 45 | 2/2/**2** 44 (unchanged) |
| `/api/settings/public`, `/api/community/access`, print materials/accessories/catalog | 1 wave each | 1 wave each (unchanged) |
| `/api/print-quote/printers` | 2/2/**2** 46 · member 3/3/**3** | unchanged |

Where the shopfront's nine waves went: `getTierStatus` is four dependent
round trips (expiry sweep → memberships → restriction flags → the mirror
UPDATE on `users`) and ran twice per shopfront — once for the badges, once
inside `storeTakesOrders`; it runs once now. The remaining five are: the store
row; [tier sweep ∥ delivery profile+rules ∥ the stats batch ∥ the published
layout]; [memberships ∥ the blocks' rows]; the restriction flags; the mirror
UPDATE. The last two are `entitlements.ts`'s (not this PR's); the mirror
UPDATE is a write on a read path and a candidate for `waitUntil`.

Each removed wave is one D1 round trip off the TTFB of that route from every
colo — 100–250 ms from an Iraqi PoP to a far primary (plan #4); the exact
figure is what the `d1_region` line will tell us. And for every GUEST the
whole table is now paid once per colo per `s-maxage`, not per request.

### API calls per page load (Playwright, the P1c fixtures, 360×800, ×4, Slow-4G)

| state | before | after |
|---|---|---|
| `/` guest, API answering | 6 calls, `/api/community/access` ×1 | 6 calls, ×1 |
| `/` member, API answering | 12 calls, ×1 | 12 calls, ×1 |
| `/` guest, every `/api/*` answering 500 (the survey's state) | 7 calls, `/api/community/access` **×2** (2/2 runs; the second at +700 ms) | 6 calls, **×1** (3/3 runs) |

(The after build also carries the P2b/P2c client work in flight — `/api/home`
now leaves with `/resolve` at 1.9 s; not this PR's.)

### Bytes (gzip −9, `npm run build`; tests/bundleBudget.test.ts 12/12)

| | P1c | P2a | Δ |
|---|---|---|---|
| entry chunk | 65.3 KB | 65.8 KB | +0.5 (the two delivery effects, the access grace timer; budget 72) |
| initial payload | 181.9 KB | 182.4 KB | +0.5 |
| storefront pages beyond initial | 39.2 KB | 39.4 KB | +0.2 (`storefrontApi` 0.6 KB with `deliveryToYou`) |
| CSS, all 8 files | 59.6 KB | 59.5 KB (60,910 B) | no new utility class |

### Lab exit gate (`scripts/perf-lab.mjs`, cold, median of 3; `/api/*` answers 500 under `vite preview`, so every route is its no-API state — a lab without the Worker cannot see this PR's server work)

| route | FCP | LCP | CLS | P1c |
|---|---|---|---|---|
| `/` | 2356 | 2356 | 0 | 2340 / 2340 / 0 |
| `raf3d.localhost:4173/` (store host) | 2288 | 2288 | 0 | — (P1c measured the store host in the fixture lab only) |
| `/product/x` | 2620 | 2900 | 0.075 | 2776 / 2912 / 0.075 (the App.tsx fallback strip, P1c's residual) |

Not worse. The server side of this PR is measurable only against a Worker
with D1 and `caches.default`: the prepare/wave table above is the measurement
this phase stands on, and the live TTFB before/after belongs to the staging
deploy (read `cf-cache-status` and `Age` on `/api/home` as a guest, and the
`d1_region` line in the Worker logs).

### Tests

- new `tests/edgeCachePolicy.test.ts` (12): every route in the list — the
  policy, the ETag, the 304 for a guest; never a shared policy with the cookie
  alone or a resolved user; the shopfront byte-identical for guest and member
  and free of `delivery_to_you`; store / hit / re-stamp / a session never
  touches the cache; the canonical key (sorted, declared-only, per Host,
  one scheme); HEAD, refusals and session answers never stored; the settings
  PUT, the gate PUT and a layout publish purge what they changed; the
  session-free predicate's truth table; source pins that the storefront
  router reads `user` in `/:slug/delivery` only and that every other GET is
  behind `anonymousCached`, that the other session-free handlers read no
  user, and that the pipeline asks the predicate before the session load.
- new `tests/d1Waves.test.ts` (3): wave and prepare ceilings per route (cold,
  warm, member) on the wave-counting adapter; the pricing inputs one wave
  cold / none warm / forgotten by the seam / re-read past the TTL / never
  shared across bindings; the shopfront's single tier read and stats batch.
- `tests/edgeCacheLifetime.test.ts` +1 (the first screen and the settings:
  hit and 304 re-stamped); `tests/storefrontIsolation.test.ts` +1 (a cached
  storefront never carries viewer data — structural pins on `publicStore`,
  the policy's refusals, the pipeline's exclusion, the client's merge);
  `tests/storeDeliveryCheckout.test.ts` last test re-pinned to the new
  contract (the body never carries the line; `/delivery` does).

### Caveats and follow-ups

- Purges are per colo (Cache API); other colos age out within `s-maxage`
  (120 s) and browsers within `max-age` (60 s). The product-form's own
  membership rules (`planProductMembershipRules`) and the PRO pause toggle
  (`memberships.ts`) reach the pricing memo through its 30 s TTL, not a seam.
- `ProductViewed` is sampled 1:5 for guests and best-effort; a cache hit
  emits none, so anonymous view sampling drops with the hit rate.
- Owner-facing: with the anonymous answers cached, §B.2's «Browser Cache TTL
  → Respect Existing Headers», Tiered Cache and Argo are the settings that
  turn `s-maxage` into fewer origin trips from Baghdad/Erbil; the `d1_region`
  line decides the D1 hint / placement row.
- Files outside the listed ownership touched with one-line-scope edits, each
  forced by a seam the plan names: `worker/routes/admin.ts` (settings PUT →
  `afterSettingsWrite`), `worker/routes/adminCommunity.ts` (gate PUT →
  `afterCommunityGateWrite`), `worker/routes/storeLayout.ts` (publish and
  restore-with-publish → `afterStorefrontWrite`), `worker/lib/storeOrderOps.ts`
  and `worker/lib/merchantAuth.ts` (an optional pre-read `ownerTier`
  parameter), `worker/lib/publicApi/resources/stores.ts` (`publicStore` lost
  its viewer argument), `tests/storeDeliveryCheckout.test.ts` (the re-pin).

## 2026-09-29 — P2c: images and video delivery (plan §B.1 #5 route part, #9), working tree after P0/P1/P2a/P2b

What changed (same pictures, same clips, same words; a card downloads a
card-sized picture and a video plays from the Iraqi colo):

- **`GET /files/<key>?w=320|640|1080`** (`worker/routes/uploads.ts`
  `serveImageVariant`; widths, negotiation and the cut in
  `worker/lib/imageConvert.ts`): a PUBLIC still image (`webp`/`jpg`/`png` by
  key extension — never a GIF, a video or a private key) is resized by the
  `IMAGES` binding with `fit: scale-down` (never enlarged) into the format the
  browser's `Accept` allows — AVIF, else WebP, else the stored format — and
  stored in `caches.default` under `/files/<key>?w=<w>&f=<format>` with
  `Vary: Accept`, the original's own Cache-Control (immutable for minted keys,
  `max-age=300, must-revalidate` for the brand folder, with the rewritable
  generation), a variant ETag (`"<r2 etag>-w640-avif"`) and a 304 on it. The
  original is read from the edge cache when the colo has it and from R2 ONCE
  otherwise (and written to the cache then), so three widths of one picture
  cost one R2 GET. A width off the list is a 400 (`IMAGE_VARIANT_WIDTH`), a
  private key `IMAGE_VARIANT_PRIVATE`, a non-image `IMAGE_VARIANT_NOT_IMAGE` —
  refused before the cache or the bucket is touched. Without the binding, or
  when it refuses a picture, the visitor gets the stored file exactly as
  `/files/<key>` sends it. Quality: WebP 85 (the converter's own), AVIF 75 —
  the AVIF value is the plan's, NOT measured (no encoder in the lab beside
  miniflare's, whose ratios are below; the owner's zone decides).
- **`SafeImage`** (`src/components/ui/SafeImage.tsx`): a `sizes` prop; when
  given AND `src` is a `/files/` still picture with no query, the `<img>`
  carries `srcset="…?w=320 320w, …?w=640 640w, …?w=1080 1080w"` and `sizes`;
  every other source (external, GIF, data URI, a URL with a query) passes
  through untouched, and `src` stays the original. Opt-in on purpose: the
  store cover and the product lead image are preloaded by the document at
  their original address (P2b `preloadImagePath`), and a srcset there would
  make the preload a second download. Eager images no longer fade: the 300 ms
  opacity ramp was 300 ms after the largest paint on every visit for nothing
  visible (`revealCls`). The three card sites pass `sizes`: home/listing
  `ProductCard` compact `(min-width: 1024px) 20vw, (min-width: 640px) 33vw,
  50vw` and regular `160px`; hub `ProductTile` `(…) 16vw, 33vw, 50vw`; the
  store tile in `storefront/parts.tsx` — a bare `<img>`, given the same
  srcset by a three-line local builder (importing `SafeImage` there would put
  its icons and strings into every store visit and trips the blocks'
  import allow-list) — `(…) 20vw, 25vw, 50vw`.
- **Range from the cached whole file** (`/files/*`, public keys): a ranged
  request looks the whole object up in the edge cache (Cloudflare's cache
  answers a ranged `match` with a 206 itself; a runtime that hands back the
  200 gets it sliced by `answerRangeFromFull`/`sliceStream`); on a miss the
  object is read from R2 ONCE and WHOLE — no HEAD, the GET carries the size —
  sliced for this player and written to the cache under the plain key
  (`edgeCachePutKey`, Range and If-Range stripped) so only a whole 200 is ever
  stored. The 304 check runs before any body is read (the stream is released
  unread). `Content-Length` now travels with every public whole-file answer
  so a cached entry knows its own size. The PRIVATE path (support, chat,
  receipts) is unchanged: HEAD, then ranged GET, never the shared cache.
- **Review media Range** (`worker/routes/reviews.ts` `/media/*`): 206/416/
  `Accept-Ranges: bytes` after the same authorisation, the same revocable
  `no-cache` policy, HEAD then ranged GET (private storage, per-request
  permission, never cached). `If-Range` honoured; a `Range` + matching
  `If-None-Match` is a 304.
- **Non-faststart MP4 → a warning** (`worker/lib/videoSniff.ts`
  `mp4IsFastStart`: `moov` after `mdat` among the top-level boxes): the
  upload route stores the file and adds `warnings: ['VIDEO_NOT_FASTSTART']`
  to its answer (only when true; `purpose=community` and `post`);
  `MediaEditor` and `ProjectMediaPicker` show the hint as a `role="status"`
  line (never an error) through `refusalText` — ar/en/ckb in
  `src/lib/refusalStrings.ts`. `sniffVideo`'s own shape is untouched.

### Bytes on the wire — a product card at 360 px (Playwright Chromium, `isMobile`, viewport meta, the card's own `sizes`; served by `wrangler dev` with the local `IMAGES` binding, scratchpad `p2c/pick2.mjs`)

The three pictures: two REAL catalogue photographs from the live site
(`/files/products/catalog/gallery/34cb…webp` 1900×1917 and
`/files/products/import/gallery/fc35…webp` 1400×1050 — the live catalogue is
already client-downscaled WebP) and one synthetic 3000×2500 gradient+noise
picture standing in for a camera upload at the preprocess ceiling.

| picture | before (the original, every card, every DPR) | compact grid card, DPR 2 and 3 (2 across) | rail card 148 px, DPR 2 | rail card, DPR 3 |
|---|---|---|---|---|
| live 1900×1917 WebP | 38,312 B | `?w=640` AVIF **5,885 B** (−84.6 %) | `?w=320` AVIF 2,655 B (−93.1 %) | `?w=640` AVIF 5,885 B |
| live 1400×1050 WebP | 55,994 B | `?w=640` AVIF **7,369 B** (−86.8 %) | `?w=320` AVIF 3,122 B (−94.4 %) | `?w=640` AVIF 7,369 B |
| synthetic 3000×2500 WebP | 2,364,872 B | `?w=640` AVIF 6,789 B | `?w=320` AVIF 2,892 B | `?w=640` AVIF 6,789 B |

The same variants for a browser that sends only `image/webp` (older Safari):
live 1900 px `w=320` 4,098 B / `w=640` 9,588 B / `w=1080` 17,770 B (−75 % at
640); live 1400 px 4,566 / 12,852 / 25,324 B (−77 % at 640); the synthetic
picture 4,282 / 12,194 / 58,244 B. AVIF runs 40–45 % below WebP at every
width on these three files (the local encoder; the zone's may differ).
Decoded sizes confirm the cut (`sharp` metadata: 320×323, 640×646, 1080×1090
for the 1900 px original; a 500 px original asked at 1080 stays 500 px by
`scale-down`). The 20-tile home rail that was 20 × 38–56 KB ≈ 0.9 MB is
20 × 3–7 KB ≈ 100 KB.

Route behaviour measured through the same Worker: `?w=500` → 400;
`If-None-Match` on the variant ETag → 304; `Vary: Accept` and the original's
Cache-Control on every variant; a second request for the same variant reaches
neither the binding nor the bucket (`tests/imageVariants.test.ts` counts
both: 1 R2 GET and 1 transformation for the first request, 0 and 0 for the
second, 0 R2 and 1 transformation for a second width of the same picture).

### R2 operations for two Range requests on one public clip (the test harness's recording bucket, `tests/fileRangeDelivery.test.ts`)

| | R2 ops, 1st `Range: bytes=0-1` | R2 ops, 2nd `Range: bytes=500-` | stored at the edge |
|---|---|---|---|
| before (HEAD: this file's own comment and tests at HEAD — a Range bypassed the cache in both directions) | HEAD + ranged GET = **2** | HEAD + ranged GET = **2** | nothing — a video was never edge-cached |
| after | one whole GET = **1** | **0** | the whole file, as a 200 under the plain key |

Two ranges: 4 → 1 operations; every later range, seek and replay by every
visitor of that colo: 0. A 416 on a cold colo costs the one GET (its body
released) instead of a HEAD; a 304 the same GET instead of GET + body.
Through `wrangler dev` (miniflare's cache): `Range: bytes=0-1` on the 2.36 MB
object → `206`, `Content-Range: bytes 0-1/2364872`, `Content-Length: 2`,
`CF-Cache-Status: HIT` from the second request on; `bytes=1000000-1000003` →
4 bytes with the right `Content-Range`; `bytes=9000000-` → 416.

### Bytes (gzip −9; `npm run build`, the bundle test's closure walk; 12/12 pass)

| | before this PR (same tree, `parts.tsx` at HEAD) | after | note |
|---|---|---|---|
| CSS, all files | 59.6 KB | **59.6 KB** | no new utility class: the hints reuse the pickers' own classes, `opacity-100` existed |
| entry chunk | 65.9 KB | 65.9 KB (budget 72) | `SafeImage`'s srcset builder is ≈ 0.1 KB inside it |
| initial payload | 182.5 KB | 182.5 KB (budget 200) | |
| storefront pages beyond initial | 39.4 KB (`theme-*.js` 5,175 B) | **39.5 KB** (`theme-*.js` 5,284 B, **+109 B**) | the store tile's srcset + `sizes`. Three payback passes inside `parts.tsx` (a relative-only guard, one `monthYear` for two date formats, `LinkTo` folded to one `<Link>`/one `<span>`, one `digits` formatter, `deliveryToYou`/`factsWithFallback` deduplicated) recovered 16 B of ≈125 — gzip already absorbed those repetitions. Gate 47 KB passes; the «may not grow» rule is missed by 0.1 KB and stands as an open item (drop the store tile's srcset, or pay in a storefront file outside this PR's ownership) |

### Caveats

- The `IMAGES` binding in the lab is miniflare's local implementation; the
  zone's encoder, its AVIF quality scale and its per-transformation billing
  are the owner's to observe (Images → Transformations must be enabled for
  the zone, plan §B.2). The ratios above are that encoder's; the widths, the
  formats and the cache behaviour are the route's and hold anywhere.
- `caches.default` slicing a ranged `match` into a 206 is Cloudflare's; the
  route does not rely on it (a 200 hit is sliced in the Worker), which is the
  branch the tests exercise.
- The srcset is opt-in through `sizes`; the product page gallery, the store
  cover and every `SafeImage` without `sizes` still fetch the original. Those
  are P2b's preloaded images — moving them needs `preloadImagePath` to name
  the same variant (their file; `tests/documentPreloads.test.ts` pins the
  href).
- `tests/storefrontBlocks.test.ts` fails 2 of 11 on this tree with
  `parts.tsx` at HEAD as well (section order, «Deals») — another P2/P3
  builder's in-flight storefront work, not this PR (verified by swapping the
  file).
- Not measured here: the LCP effect of the variants on a real page (the lab's
  `/api/*` answers 500 under `vite preview`, so no card renders); the
  `pick2.mjs` numbers are the bytes the browser actually requested for the
  card's own `sizes` at 360 px, which is the quantity that changes.

Follow-ups: `preloadImagePath` variant (above); `worker/lib/mediaStorage.ts`
`getMediaObject` could take R2's `onlyIf: { etagDoesNotMatch }` so a cold-colo
304 costs no GET at all (not this PR's file); GIF/video `max_bytes` caps per
layout slot are P5 (plan #5, `packages/storeLayout/src/blocks.ts`); posters
for every new video slot (plan #9) belong to the reels phase.

## 2026-09-29 — Community Phase 4 (files, viewer grants, link cards) + merchant programme P3 (Counter 0 · Storefront A · Journeys 1), the integrated working tree

Ten builders' work merged into one tree (docs/COMMUNITY_ECOSYSTEM.md §4d/§9.4,
docs/MERCHANT_PLATFORM_V2.md §C.1 row P3, docs/DECISIONS.md rows 172–176). Nothing
here was measured in the lab; these are the bundle figures the gate prints.

### Bytes (gzip −9; `npm run build`, tests/bundleBudget.test.ts 12/12; exact CSS bytes from `gzip -9c | wc -c` over `dist/assets/*.css`)

| | before (P2c row above) | after | gate |
|---|---|---|---|
| document | 1.9 KB | 1.9 KB (5,009 B raw) | — |
| entry chunk | 65.9 KB | **66.2 KB** (`index-*.js` 67,454 B; 307 chunks) | 120 KB (test pin 72) |
| initial payload | 182.5 KB | **182.7 KB** over 4 files | 240 KB (test pin 200) |
| storefront pages beyond the initial payload | 39.5 KB | **42.6 KB** | 47 KB |
| workspace shell / with its closure | 14.6 / 24.7 KB (HEAD c41a1301, measured — the earlier «15.1 / 25.2» before column was copied from an older row) | **15.1 / 25.2 KB** (+0.5 KB: the Operate\|Design segmented, the Seam, the settle) | 25 / 32 KB |
| CSS, all 8 files | 60,990 B (HEAD c41a1301 built with the gate's method: node zlib level 9 over `dist/assets/*.css`; the P2-exit row's 60,992 B) | **60,964 B = 59.5 KB** as the gate prints it (`gzip -9c \| wc -c` gives 60,876 B; `index-*.css` 48,067 B node / 47,844 B gzip) | 60 KB; «may not grow» against P0–P2: **met (−26 B)** — no new utility class in any Phase 4 / P3 file (each builder ran a class census against the built CSS). The earlier row's «60,845 B / −147 B» did not reproduce and is corrected here; `orderPrint-*.css` (378 B) is `OrderDetailScreen-*.css` renamed, not a saving |

New lazy chunks (none in the entry, the storefront closure or the workspace shell):
OrdersList `OrdersList-DzQ34mVI.js` 7.9 KB; ProductFilesEditor `ProductFilesEditor-Dw5pzuyV.js` 2.8 KB; ProductFiles
`ProductFiles-DJqoA3mJ.js` 1.6 KB; LinkSheet `LinkSheet-xI7DsWYT.js` 1.0 KB; UploadTile `UploadTile-DwuXNwCc.js` 5.7 KB;
the SHA-256 worker `sha256.worker-DLW96Ikd.js` 1.5 KB.
`tests/bundleBudget.test.ts` WORKSPACE_SCREENS now pins `OrdersList` as lazy beside
`OrdersSection`/`OrderDetailScreen`.

What grew and why: the storefront closure +3.2 KB against HEAD (40,450 → 43,686 B: the theme chunk +1.6 KB
for the blocks' runtime, StoreRenderer +0.7 KB, `community/files/api.ts` 654 B as a new static member, the
two pages +0.3 KB — recorded against P2c's open «may not grow» item; the files door itself is now asked only
when the product read's `file_count` is not 0) (in-store search field + sort `Segmented`,
review chips / photo strip / «المزيد», collection covers, the card's second-image swap and video
mark, the product page's files read + lazy mount, the storefront strings file in three languages);
the entry +0.3 KB (`ApiOrder.store`, the orders pages' store line, the `'ku'→'ckb'` clock; the
chat's link branch sits inside the lazy Chat chunk). `SalesTabs.OrdersTab` is still built
(`SalesTabs-bAXM-snZ.js` 10.2 KB) because three tests outside P3b's ownership pin it; retiring it is the
recorded CSS payback still owed (docs/MERCHANT_PLATFORM_V2.md §C.1 P3).

### Review fixes (2026-09-30; DECISIONS row 177)

Static-import closures beyond the initial payload, gzip −9 (node zlib, the gate's method), HEAD c41a1301 →
as merged → after the fixes:

| page / chunk | HEAD | merged | **after** | what moved |
|---|---|---|---|---|
| Chat | 37,406 B | 84,392 B | **47,767 B** | `vendor-motion` (16,046 B) and `refusalStrings` (20,777 B) left: `UploadTile` and `LinkCard` render `m.*` under `<MotionFeatures>` and load the sentences on the first failure; what remains of the growth is the tile (6,159 B), the card (2,636 B) and `useLinkCard` (775 B) |
| Requests | 100,080 B | 127,257 B | **111,416 B** | the same tile, no `vendor-motion` |
| workspace shell (own / closure) | 14,964 / 37,567 B | 15,482 / 54,307 B | **15,488 / 38,271 B** | the Seam, the settle and the badge are `m.*` under `<MotionFeatures>`; `vendor-motion` is no longer a static import of the frame (the gate now prints the shell's vendor share and pins the features chunk out) |
| Today (own / closure) | 5,874 / 45,083 B | 14,897 / 95,953 B | **15,110 / 56,521 B** (18,250 B beyond the shell) | the restock sheet is a lazy chunk, the sentences load on the first refusal, the ticket list is `m.li`, and the `Switch` primitive — the last path to the features chunk — renders `m.span`; the chunk's own bytes are the Counter's three-language strings. New pin: `TODAY_SCREEN_BUDGET` 18 KB, no `vendor-motion`, no `refusalStrings`, no `RestockSheet` in its closure |
| orders list (OrdersSection / OrdersList) | 38,490 / 77,315 B (SalesTabs) | 55,318 / 94,100 B | **39,265 / 78,228 B** | the tray and the chip are `m.*`; the `Switch` fix; `refusalStrings` stays (the row's `merchantRefusal`, as at HEAD) |
| Project (reader) | 87,366 B | 104,861 B | **96,758 B** | `FileComposer` is its own module: the reader's `FileRows` no longer carries the tile, the switch and the input (FileRows 1,384 B) |
| storefront pages (own) | 40,450 B | 43,658 B | **43,686 B** (42.7 KB) | unchanged in kind; the product read carries `file_count` so the files door is asked only when there is something behind it |
| entry / initial | 65.9 / 182.5 KB (P2c row) | 67,454 B = 66.2 KB / 182.7 KB | **67,741 B = 66.2 KB / 187,158 B = 182.8 KB** over 4 files | +287 B against the merge (the `file_count` gate, the bulk deadline) |

Server side (no bundle figure): the product-files list reads the store and the product in one wave and folds
the viewer's grants into the files statement (one wave fewer for a member); `productFilesReady` is memoised
(one `LIMIT 0` probe per isolate instead of one per checkout); `GET /api/link-cards` is session-free, so a
member's feed hits the colo entry as a guest's does; the bulk status door reads its whole list in one statement
and defers each move's audit row and chat card past the response, while the client's deadline grows with the
list and the screen re-reads on any failure.

### Tests

After the review fixes (2026-09-30): `npm run check` exit 0; `npm run build` exit 0 and
`tests/bundleBudget.test.ts` 12 / 12 (entry 66.2 KB, initial 182.8 KB over 4 files, storefront pages 42.7 KB,
workspace shell 15.1 / 25.2 KB, Today 14.8 KB, CSS 59.5 KB); `tests/motionLazy.test.ts` 4 / 4;
`node scripts/migrate-check.mjs --twice` ✔ through 0158 (244 tables, 0 FK violations); root suite
`node scripts/test-all.mjs` 8,153 / 8,154 on the first pass — the one failure (storeLayoutRoutes, a
pre-0122 database inheriting another handle's `productFilesReady` memo) fixed by keying the memo per
database handle, `tests/storeLayoutRoutes.test.ts` 26 / 26 on the re-run; browser: `scripts/e2e-projects.mjs`
493 / 0, `scripts/e2e-community-home.mjs` 867 / 0, `scripts/e2e-catalog.mjs` 104 / 0 (the 360 editor scenes
reach the file rows now that the fixture opens the sheet after mount).

Root suite `node --import tsx --test tests/*.test.ts` 7,468 / 7,468 after integration;
`node scripts/test-workspaces.mjs` 361 / 361 (the gateway's routing, rate-limit-parity and body-class
registries gained the three new mounts and the session part class); Studio 313 pass, 6 declared
skips; `npm run check` exit 0; `node scripts/migrate-check.mjs --twice` ✔ through 0158; browser:
`scripts/e2e-projects.mjs` 493 / 0, `scripts/e2e-community-home.mjs` 867 / 0,
`scripts/e2e-catalog.mjs` 104 / 0 (files editor and product files), `scripts/e2e-store-builder.mjs` 34 / 0.

## 2026-09-30 — Community Phase 5 (offers V2, the request discussion, the order timeline, the request page) + merchant P4 («سرعة متجري») + P5 (media everywhere), the integrated working tree

Eight builders' work merged into one tree (docs/COMMUNITY_ECOSYSTEM.md §4e/§9.5,
docs/MERCHANT_PLATFORM_V2.md §C.1 rows P4 and P5, docs/DECISIONS.md rows 178–182). Nothing here
was measured in the lab; these are the bundle figures the gate prints, plus exact bytes.

### Bytes (gzip −9; `npm run build`, tests/bundleBudget.test.ts 12/12; exact bytes with node zlib level 9, the gate's method; CSS also by `gzip -9c | wc -c`)

| | before (Phase 4 + P3 after the review fixes) | after | gate |
|---|---|---|---|
| document | 1.9 KB (5,009 B raw) | 1.9 KB (5,009 B raw) | 4 KB |
| entry chunk | 67,741 B = 66.2 KB | **67,912 B = 66.3 KB** (328 chunks; +171 B: the `/requests/:id` route and its lazy import) | 72 KB |
| initial payload | 187,158 B = 182.8 KB over 4 files | **187,345 B = 183.0 KB** over 4 files | 200 KB |
| storefront pages beyond the initial payload | 43,686 B = 42.7 KB | **46.6 KB** (+3.9 KB) | 47 KB — **0.4 KB of headroom left** |
| a store page's fixed app weight (initial + storefront) | 225.5 KB (`STOREFRONT_FIXED_KB` 226) | **229.6 KB** (`STOREFRONT_FIXED_KB` 230, now pinned within 3 KB by the gate) | — |
| workspace shell / with its closure | 15.1 / 25.2 KB | **15.2 / 25.3 KB** | 25 / 32 KB |
| Today (`CommandCenter`) | 15,110 B | **15,653 B** (18,120 B as merged: the announcement sheet's three-language words rode in the Counter's table; moved to the lazy `counter/announceStrings.ts` at integration, −2,467 B) | 18 KB |
| `StoreDesignPanel` | — | **54,720 B = 53.4 KB** | 250 KB |
| CSS, all 8 files | 60,964 B (node) / 60,876 B (`gzip -9`) | **60,964 B / 60,876 B — unchanged, 0 B** (`index-*.css` 48,067 B; no builder added a utility class: each ran a class census against the built CSS) | 60 KB and «may not grow»: **met** |

New lazy chunks (none in the entry, the storefront closure or the workspace shell): the request page
`Request-*.js` 41,300 B (the board chunk `Requests-*.js` is 12,515 B now that the detail moved out);
`OrderTimeline` 4,183 B + `timelineStrings` 3,169 B; `CustomOrderScreen` 3,197 B; `BoardRail` 1,744 B;
`SpeedPanel` 6,295 B; `storeVitals` 1,036 B (the reporter, imported after `load` + idle — the gate now pins it
as a lazy chunk in no storefront static closure, and `SpeedPanel` as no static import of the builder);
`BackgroundMedia` 2,556 B (the gate pins it lazy too); `AnnouncementSheet` 6,991 B (its words included);
`PreviewQr` 1,530 B; `MediaLibraryPoster` 845 B.

What grew and why: the storefront closure +3.9 KB (the notice line and footer links in `StoreHeader`, the
background door and the scheduled-block filter in `StoreRenderer` 12.6 KB, the storefront strings' `media`
group, the hero's workshop-facts frame, `backgroundAttributes` in the theme chunk 7.1 KB, the reporter's
dynamic-import call). The first P5 version measured 47.9 KB; the background was split into a door and a
2.5 KB lazy chunk, whose layer is fixed/absolute so nothing shifts when it arrives. **The next storefront
surface must pay back before it spends.** The entry +171 B is the new route.

### Tests

`npm run check` exit 0 (tsc root, worker and tests: 0 errors; `eslint .` 0 errors, 151 warnings, none in a
file this phase touched; check:workspaces, check:boundaries 67/67, check:studio, check:runners); `npm run build`
exit 0; `tests/bundleBudget.test.ts` 12/12; `node scripts/migrate-check.mjs --twice` ✔ through 0161 (251
tables, 0 FK violations, 0 orphan catalogs); `node scripts/test-all.mjs` exit 0 on the final tree — root
`tests/*.test.ts` 7,622 / 7,622, workspaces 361 / 361, Studio 313 pass + 6 declared skips. Browser (vite on :4191):
`scripts/e2e-projects.mjs` 493 / 0, `scripts/e2e-community-home.mjs` 966 / 0, `scripts/e2e-request.mjs`
738 / 0, `scripts/e2e-order-timeline.mjs` 577 / 0, `scripts/e2e-storefront-media.mjs` 125 / 0,
`scripts/e2e-store-builder.mjs` 332 / 0.

### Review fixes on the same tree (post-merge review of 2026-09-30: behaviour/a11y/i18n, perf budget, money/state, files/privacy)

Exact bytes (node zlib level 9, the gate's method; `npm run build` then tests/bundleBudget.test.ts):

| | as integrated (the review's measurement) | after the review's fixes, before the payback | **final** | gate |
|---|---|---|---|---|
| storefront pages beyond the initial payload | 47,739 B (389 B of headroom) | 47,862 B (266 B) | **47,480 B (648 B of headroom)** | 48,128 B |
| entry / initial payload | 67,912 B / 187,345 B | — | **67,883 B / 187,316 B** (66.3 / 182.9 KB, 328 chunks) | 72 / 200 KB |
| a store page's fixed app weight | 229.6 KB | — | **229.3 KB** (`STOREFRONT_FIXED_KB` 230, within 3 KB) | — |
| CSS, all 8 files | 60,964 B | 60,978 B (+14 B: `min-h-[168px]`, `sm:mt-1.5`, `sm:pt-4`) | **60,964 B** — `index-B6C-KbqL.css`, the integration's file byte for byte (the skeleton's height inline; `sm:pt-5` and a column gap the stylesheet already had) | 60 KB, «may not grow» |

What paid the store pages back:

- **One scheduler for the speed reporter** (`scheduleStoreVitals`, src/lib/storeBeacon.ts): the same load + idle
  effect was written into both store pages. `Storefront` 6,636 → 6,379 B, `StorefrontProduct` 6,709 → 6,461 B,
  `storeBeacon` 520 → 817 B: −208 B net.
- **The store layout's tables as one file** (`store-layout`, vite.config.ts `manualChunks`): packages/storeLayout
  `tokens`, `refs`, `blocks` and src/components/storefront/theme.ts, 4,665 B, where Rollup had split them by
  importer set into `theme` 1,503 + `refs` 1,805 + `blocks` 1,615 = 4,923 B: −258 B and two fewer requests on every
  store visit. Its cost is on the merchant side, once: the lazy screens that imported one table
  (`AnnouncementSheet`, `PreviewQr`, `SpeedPanel`, `StoreSettingsTab`, `ProductFiles`, `AccentSample`) fetch the
  4.6 KB file instead of 1.5–1.8 KB — the same file the builder and the store pages use.
- **Off the first render, not in the closure:** the hero's workshop-facts row is `workshopFacts` (1,279 B) and the
  store's video element `StoreVideo` (422 B), each its own lazy chunk; a classic workshop store, or a classic page
  with a background video, no longer fetches the 8.4 KB `extra` chunk of non-classic blocks for them.
- What the review's own fixes spend inside the closure: the notice line's three lines, its read at the first
  render (no collapse on reload), the animated-GIF rule and the focus hand-off after «إخفاء الإعلان»
  (`StoreRenderer` 12,762 → 12,856 B).

The gate names the new lazy chunks (tests/bundleBudget.test.ts, 13 tests): `Request` 42,028 B, `OrderTimeline`
4,343 B, `CustomOrderScreen` 3,289 B, `AnnouncementSheet` 7,202 B, `BoardRail` 1,469 B — each a chunk of its own, in
none of the entry, store-page and workspace-frame closures; the announcement sheet in none of Today's, the rail in
none of the community home's; `workshopFacts` and `StoreVideo` lazy and never pulling `extra`; `store-layout`
exists. `refusalStrings` 23,005 → 23,880 B (+875 B: the 36 Sorani sentences that replaced Arabic copies in the
Phase-5 codes, and `OFFER_PICKUP_FEE`); the review's proposal to move the new surfaces' codes into lazily loaded
tables is not done here (63 importers; codes such as `OFFER_CHANGED` are shared with the chat's commerce flow) —
an open item, with the 40-route cost it names.

D1 round trips (dependent waves, tests/fixtures/wavesD1; each now a test's ceiling):

| read | review measured | now | pinned in |
|---|---|---|---|
| GET `/api/marketplace/requests/:id/offers` | 7 (customer) / 8 (merchant) | **4 / 4** — [request, caller's store] → [offers, revisions, files by the list's rule in SQL, draft] → the badges' two | tests/offersV2.test.ts |
| GET `/api/marketplace/my-offers` | 4 | **2** — the store → [page, its files by the page's own subquery, drafts] | tests/offersV2.test.ts |
| GET `/api/community/store/:id` | 7 | **4** | tests/offersV2.test.ts |
| GET `/api/marketplace/orders/:id/timeline` | 3, every update | **2**, the newest 200 updates + `older_updates` (the 30 s poll while open now reads ≤ 201 rows) | tests/orderTimeline.test.ts |
| POST `/api/storefront/events/vitals` | 6–7 | **3** — [limit, store] → [salt, one batch] → [mark + counters]; the discarded COUNT is gone | tests/storefrontVitals.test.ts |
| GET `…/layout/speed`, `…/speed/report` | 5 / 5 | **4 / 4** (the limit rides the first read; the sizes wave needs the block data's product rows) | tests/storeSpeed.test.ts |
| GET `/api/marketplace/requests/:id/comments` | 4 (member, workshop); COUNT on every page | **3** for every reader; COUNT on the first page only | tests/requestDiscussion.test.ts |
| GET `/api/community/requests?for=me` | driven from the merchant's whole match history, sorted, the COUNT repeating the scan | driven from the open board (`idx_community_requests_state_expires`), the verdict an EXISTS on the pair index | tests/offersV2.test.ts (`EXPLAIN QUERY PLAN`) |

The beacon and the speed routes call `rateLimit`, which awaits one more statement — its stale-window DELETE — on
2 % of the hits that open a window (worker/lib/ratelimit.ts; every limited route alike, unchanged here). Their two
tests hold that coin (`Math.random`) so the ceiling is the route's own cost on every run: the first final suite
failed once on it (the beacon at 4 waves), and with the coin held under 2 % the beacon measures 4 / 4 and the audit 5.

Layout shift (the home's «طلبات تناسبك», perf review major): scripts/e2e-community-home.mjs now measures every
page load's layout shifts for the workshop viewer and requires a return visit to reserve the rail's frame
(< 0.02): measured first visit / return visit ar-360 0.007 / 0.007, ar-1280 0.007 / 0.007, en-360 0.010 / 0.010,
en-1280 0.007 / 0.007, ckb-360 (reduced motion) 0.006 / 0.006 — the rail no longer lands above the issue (0.206 as reviewed,
«even with a 0 ms /api/merchant/me»). With `/api/merchant/me` held back 800 ms (the same fixture, Chromium 360×800, a
fresh context, then a reload): first visit 0.219, return visit 0.007; a customer 0 / 0. The 0.219 is the one case
left — a workshop's first visit on a device whose `me` answers after the issue has painted; the device learns it
then, and every later visit reserves the frame (recorded in docs/COMMUNITY_ECOSYSTEM.md §9.5 deviation 8).

### Gates on the final tree (review fixes)

`npm run check` exit 0 — tsc root, worker and tests 0 errors; `eslint .` «✖ 151 problems (0 errors, 151 warnings)»,
none in a file this pass touched; check:workspaces clean (12 packages and services), check:boundaries 67 / 67, check:studio
clean, check:runners «3 embedded runner(s) typecheck clean». `npm run build` exit 0 («check-live-markers: all 7 live
markers survive the build»); tests/bundleBudget.test.ts 13 / 13 (figures above). `node scripts/migrate-check.mjs
--twice`: ✔ through 0161, «second full pass applied 0 files (bookkeeping holds)», «0161_storefront_vitals.sql: 4
idempotent statement(s) re-ran — no row added, no value changed», «tables: 251 foreign_key_check violations: 0
orphan catalogs: 0»; D1's own engine agrees — `wrangler d1 migrations apply --local` took 0150–0161 onto the old local
D1 and 0001–0161 onto a fresh one without an error (the local state then restored).
Root suite `node --import tsx --test tests/*.test.ts`: «# tests 7650 # pass 7650 # fail 0 # cancelled 0 # skipped 0
# todo 0» (1,991 s; the run before it 7649 / 1 — the limiter's coin in the beacon's wave test, see above; the two
wave tests now hold it). Browser (vite :4191, PLAYWRIGHT_MODULE):
`scripts/e2e-request.mjs` 740 / 0 (with the #discussion landing), `scripts/e2e-order-timeline.mjs` 586 / 0 (581 / 5 on the first pass:
its header check read ASCII digits only, and `<Money>` — the one way the workspace writes a dinar amount, the review's fix — writes «٥٥٬٠٠٠ د.ع» on an Arabic page; the check now reads either script),
`scripts/e2e-community-home.mjs` 971 / 0 (with the return-visit layout-shift check),
`scripts/e2e-storefront-media.mjs` 132 / 0, `scripts/e2e-store-builder.mjs` 335 / 0. Wrangler (:8787; the local D1 state copied first and
restored byte for byte after): `scripts/e2e-print-request.mjs` — HEAD's script, which the phase does not touch —
98 / 9 on a clean D1 migrated 0001–0161 and seeded with the operator's three settings (90 / 17 on the old local
D1, whose open requests the new workshops were matched to as well). All nine are the script's drift from HEAD
behaviour it predates (last changed 2026-09-24): the workshop match notice is `matching_request` →
`/merchant/requests/<id>` (Wave 2's merchant notifications) and a paused workshop is a notify-block, not a reject
(«eligibility as data», 2026-09-25); a viewer token opens
only for the account that minted it (W5-B); «order again» makes a draft the customer publishes.
`scripts/e2e-print-request-ui.mjs` stops at its first step on HEAD's code too: the one-time «complete your
profile» sheet covers «طلب جديد», and past it the wizard has no `[data-wizard="stepper"]` any more, so the phase's
edits to it (the `/requests/<id>` landing) are never reached. Neither is a regression of this tree; both scripts
want a rewrite against today's wizard and notices (an open item).

## 2026-10-04 — finance overview and customer loading

Baseline measured on deployed revision `925aea8c` using PageSpeed Insights,
Lighthouse 13.5.0, emulated Moto G Power, Slow 4G and an initial page load:

| Page | Mobile score | FCP | LCP | TBT | CLS | Speed index |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [Home](https://pagespeed.web.dev/analysis/https-levonis-iq-com/zdz2bams0u?form_factor=mobile) | 70 | 3.0 s | 6.2 s | 0 ms | .002 | 4.4 s |
| [Products](https://pagespeed.web.dev/analysis/https-levonis-iq-com-products/hbavvebsny?form_factor=mobile) | 80 | 2.9 s | 4.2 s | 60 ms | .002 | 3.7 s |
| [A1 product](https://pagespeed.web.dev/analysis/https-levonis-iq-com-product-bambu-lab-a1/ts356nqvhq?form_factor=mobile) | 72 | 3.5 s | 5.0 s | 0 ms | .077 | 3.6 s |

The same home report's desktop score was 95, FCP .6 s and LCP 1.1 s. These are
single lab measurements, not guarantees for every connection. The origin's
28-day mobile field figures were LCP 4.1 s, INP 118 ms and CLS .11; historical
field data cannot establish the effect of a just-published revision.

The home LCP was a lazily loaded `lv-promo-photo` catalogue image. The report
estimated 635 KiB of image savings: original 1254-square images were displayed
at much smaller sizes. Product rails also declared a 50vw image slot despite
their fixed 148px cards. The product page additionally loaded closed purchase
dialogs, the refusal translation dictionary, and below-fold reviews eagerly.
These observations guided the responsive image, preload and lazy-loading work.

**Location limitation:** PageSpeed's inspected report did not identify an Iraqi
measurement location. A separate public Globalping probe inventory contained
5,201 probes and none with country `IQ`. One explicitly Iraq-only HTTPS request
for the home page returned `no_probes_found` / “No matching IPv4 probes
available.” No nearby-country result is presented as an Iraqi result. This
attempt did not measure Iraqi HTTP latency or browser rendering.


The local production build after these changes measures the complete product
static JavaScript closure at **257.2 KiB gzip**, down from **287.2 KiB**
(30.0 KiB, about 10.4%). The initial application closure is 184.2 KiB, and all
15 bundle-budget assertions pass without increasing limits. This is a transfer
size measurement; the after-deployment PageSpeed report remains the browser
performance comparison. Main-host opening requests are one-use, deadline-bound,
identity-invalidated and never substitute for authoritative cart/checkout data.

### Published revision 830b4e2 — follow-up measurement

Measured at 20:24 UTC on 2026-10-04 with the same PageSpeed mobile profile:

| Page | Mobile score | FCP | LCP | TBT | CLS | Speed index |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [Home](https://pagespeed.web.dev/analysis/https-levonis-iq-com/e4ls1nigtb?form_factor=mobile) | 76 | 2.9 s | 4.6 s | 30 ms | .002 | 4.8 s |
| [Products](https://pagespeed.web.dev/analysis/https-levonis-iq-com-products/ipdineaqpl?form_factor=mobile) | 77 | 3.0 s | 4.7 s | 10 ms | .002 | 3.0 s |
| [A1 product](https://pagespeed.web.dev/analysis/https-levonis-iq-com-product-bambu-lab-a1/fc4fen3dok?form_factor=mobile) | 71 | 3.6 s | 5.1 s | 0 ms | 0 | 5.1 s |

The home improves, but these single runs do **not** establish faster product
pages. Inspecting the live document and report found two concrete remaining
causes: the A1 document preloads a different relation image from the first
displayed gallery image, and four 62px gallery thumbnails still download their
originals (about 210 KiB). At the emulated phone's pixel density, some card slots
also fall just above the 320px candidate and jump directly to 640px.

A second provider inventory, Check-Host's public `/nodes/hosts`, contained 59
nodes and none in Iraq on this date. No Iraqi measurement was obtained from
either checked provider; this is a limitation of the available test locations,
not a claim that no Iraqi testing service exists.

The follow-up correction uses bounded 160/320/480/640/1080px variants and actual
64/40/36px thumbnail slots. It suppresses speculative catalogue image preloads
when a light-theme override or a bound selection can change the opening image;
social cards, route module preloads and unambiguous image preloads retain their
behaviour. This does not change the gallery's selection or zoom originals,
personalise shareable HTML, or add an inventory/pricing query to the document.

### Published revision b6f667d — CSS request reuse correction

The 2026-10-04 21:20 UTC mobile runs measured Home 77 / LCP 4.4 s,
Products 82 / LCP 3.8 s and A1 76 / LCP 4.4 s (CLS .077). The A1
report `ax0g1tky7e` identified the exact same entry stylesheet twice,
each 44.7 KiB transferred, with 590 ms estimated render-blocking savings.
The HTTP Link preload lacked `crossorigin`, whereas Vite's stylesheet
link uses anonymous CORS. Both the asset-header generator and Worker
rewrite now match that mode, including the existing font and route CSS
conventions. The generated-header/Worker parity and real document tests
cover both delivery paths. Post-deployment measurement must establish
request reuse; these estimates are not a promise of a score improvement.
No layout fix is claimed: the remaining A1 CLS needs separate evidence.

## 2026-10-05 — product image sizing and loading handoff

The live A1 page at revision `be1039c` was measured again at 23:29 Baghdad
with [PageSpeed Insights mobile](https://pagespeed.web.dev/analysis/https-levonis-iq-com-product-bambu-lab-a1/aalcynl7du?form_factor=mobile):
performance **81**, FCP **3.2 s**, LCP **3.9 s**, TBT **0 ms**, CLS **0**,
speed index **3.7 s**. This is one initial-load lab run (emulated Moto G Power,
Slow 4G, Lighthouse 13.5.0), not an Iraqi-location test or a real-device check.
The [home report](https://pagespeed.web.dev/analysis/https-levonis-iq-com/1v5slaucnx?form_factor=mobile)
from 23:27 Baghdad measured **81**, FCP **2.7 s**, LCP **3.8 s**, TBT **0 ms**,
CLS **.002** and speed index **5.1 s** with the same mobile profile.
The report's origin field figures cover the prior 28 days: LCP 4.1 s,
INP 121 ms and CLS .11; they do not isolate this revision.

The image audit identified the opening A1 image at `?w=1080`, 72.3 KiB,
displayed at 517×517 device pixels, with estimated image savings of 55.7 KiB.
The shared gallery `sizes` declaration included the frame's 1px border and
the image's 12px padding on each side. Removing those 26px describes the
actual image content width: at 412 CSS pixels and DPR 1.75, the declared
requirement falls from 665 to 619.5 device pixels, so the existing 640w
candidate is sufficient. Client and document preload use the same declaration.
Wide photos retain their full content-width allocation, and zoom still uses
the original. No extra transformation widths or quality reduction were added.

The product route's lazy fallback now owns a header anchor inside the route,
matching the loading and ready product header. The shell fallback yields
before paint instead of later removing a 60px row above the main scroll area.
This addresses the timing-dependent shift described in earlier measurements;
the current baseline already measured CLS 0, so it does not establish a new
CLS improvement. Host resolution and non-product fallbacks remain unchanged.

Related private-workspace fixes keep financial numbers visible on narrow
cards, wrap purchase-line actions, leave checkboxes at their native size,
and follow the active language direction in chart tooltips. Those styles
remain lazy and subject to the existing 7 KiB combined operations budget.
Source and automated checks do not substitute for real-phone visual QA.
Post-deployment lab results must establish any speed change.

## 2026-10-10 — clay Phase 1, push 1.1: tokens, the shared components and Funding A (DECISIONS row 207)

The «Layered clay» redesign's first push (the build plan's Phase 1, push 1.1): the per-theme clay
primitives and the composite rule, the shadow and radius scales in `@theme`, the workbench light
(`.lv-canvas`) on the two non-scrolling shells, clay on `lv-surface`/`lv-surface-raised`/`lv-choice`/
`lv-button`/`lv-input` plus the new `lv-well`/`lv-chip`, glass made solid (`.material` lost its 18–24 px
backdrop blur), and the funding that pays for it: 27 of the 28 one-off `shadow-[…]` sites became
named utilities or nothing. Nothing was measured in the lab; these are the gate's figures.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (HEAD `a68790b9`, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 48,517 B (342,519 B raw) | **48,308 B** (337,421 B raw) | — |
| CSS, public files (8) | 61,414 B | **61,205 B (−209 B)**; local headroom 235 B (≈ 225 B on CI, which builds ≈ 10 B larger) | 60 KB = 61,440 B, **not raised** |
| CSS, private operations (3) | 7,216 B | 7,216 B (untouched) | 7.5 KB |
| entry chunk / initial payload | — | 63.8 KB / 180.5 KB over 4 files | 72 KB / 200 KB |

Where the bytes went (the plan's `measure-final.mjs` steps, re-run on this HEAD before building): tokens,
primitives and composites +149 B; the theme's shadow and radius remap −100 B; glass to solid −136 B;
the Tier-1 component classes, the canvas and the two accessibility blocks +358 B; Funding A
(arbitrary shadows) −595 B in the plan's model. The real build lands at −209 B rather than the model's
−282 B because the map's 28 sites are not exactly the model's 25 rules: the model also deleted three
rules the plan keeps (the two printer-finder rings, whose escaped form its keep-pattern missed, and the
`.ap` button's inset hairline in `adminProducts/theme.ts`, which is not on the map); the store page's
back-arrow `drop-shadow-[…]` stays (legibility of a white arrow on a merchant's photograph, not
decoration); and the replacements emit `shadow-2`, `shadow-dock`, `shadow-well` and
`aria-selected:shadow-1` once each. `lv-chip` writes its
own `@supports (color: color-mix(…))` so the fallback on an old WebView is the untinted raised fill
(Tailwind's own fallback would have been a full-strength tone under tone-coloured text).

Paint: every backdrop filter in `src/index.css` is gone (the 89 `backdrop-blur*` call sites in pages go in
push 1.2); a resting card paints one blurred layer (12 px), a lifted one two, held by
`tests/claySystem.test.ts`. The scroll trace on a ×4-throttled 360 × 800 phone (plan §8) is still owed.

## 2026-10-10 — clay Phase 1, push 1.2: the glass sweep, Funding B (DECISIONS row 208)

The build plan's Phase 1, push 1.2: no surface in the pages blurs what is behind it any more. All 85
`backdrop-blur*`/`backdropFilter` call sites in 59 files are gone, with 5 mentions in old comments
(Tailwind reads class candidates out of comments, so a utility named in one ships), the
`backdrop-saturate-150` and `supports-[backdrop-filter]:` variants, and the backticked `backdrop-filter`
in an `AppBusy` comment that was emitting a `.backdrop-filter` utility. Bars and panels are opaque fills
of their own family (page fill, `zinc-900`, `surface`, `surface-raised`); over photographs the backing
rose one alpha step (`onyx/70 → 80`, `black/50 → 60` …), and the open-box grade chip on a photo is an
opaque `lv-chip`. The three `blur-[120px]` glows are the same tint under a `radial-gradient(closest-side)`
mask: no filter raster. Nothing was measured in the lab; these are the gate's figures.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (push 1.1, `799be624`, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 48,308 B (337,421 B raw) | **47,762 B** (328,012 B raw) | — |
| CSS, public files (8) | 61,205 B | **60,659 B (−546 B)**; local headroom 781 B (≈ 771 B on CI, which builds ≈ 10 B larger) | 60 KB = 61,440 B, **not raised** |
| CSS, private operations (3) | 7,216 B | 7,216 B (untouched) | 7.5 KB |
| entry chunk / initial payload | 63.8 KB / 180.5 KB | 63.8 KB / 180.4 KB over 4 files | 72 KB / 200 KB |

Where the bytes went: the eight `backdrop-blur*` rules (each a nine-variable `-webkit-backdrop-filter`
and `backdrop-filter` pair), `.backdrop-saturate-150`, `.backdrop-filter`, the nine
`@property --tw-backdrop-*` registrations and their nine `initial` slots in the properties layer, and
`.blur-[120px]`; plus the translucent fills nothing names any more (`bg-canvas/96`, `/92`, `/90`,
`/85`, `/[0.92]`, `/[0.88]`, the `supports-[backdrop-filter]:bg-canvas/80` variant, each with its
`color-mix` fallback, and the arbitrary `bg-[rgb(11_12_15/0.45)]` and `bg-[rgba(10,11,15,0.7)]`).
Added: the shared glow mask (with its `-webkit-` twin) and `[--chip:var(--color-info)]`. The plan's model counted −222 B for this push because it removed
only the `backdrop-blur` rules; the opaque fills and the comment candidates are the other −324 B.

Paint: no element in `src/` has a backdrop filter or a filter glow any more (held by
`tests/claySystem.test.ts`, item 5, over every TypeScript source and every public stylesheet; the
operations sheet's `fw-sheet::backdrop` waits for Phase 3.5a). The scroll trace on a ×4-throttled
360 × 800 phone (plan §8) is still owed.

## 2026-10-10 — clay Phase 2: the shared primitives and the app chrome (DECISIONS row 209)

The build plan's Phase 2. The primitives in `src/components/ui` take the clay grammar (IconButton dents,
Segmented is a pill well with one lifted thumb, Switch's off track is a well, StatusChip/Badge/OfferBadge
are the opaque `lv-chip`, dialogs are the level-3 slab at 24 px and phone sheets cast upward, menus are
lifted at 18 px, the quantity steppers are one well with two lifted keys, DataList marks a selected row
with the gold start bar, skeletons and AsyncStates lose their zinc shells); the top bar (flush account
pill and icon buttons, a pill-well search, the purple «لوحة الأدمن» pill in gold, D1), the bottom bar
(opaque pods, the current tab a dimple, one label weight, a crimson count badge), the product card
(`rounded-xl shadow-sm`, a 4 px photo tray, no image zoom, a press) and the two scoped sheets (storefront
`raised` → `var(--clay-1)`, D3; `.ap` radii and shadows → the role tokens). Nothing was measured in the
lab; these are the gate's figures.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (push 1.2, `0f7792af`, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 47,762 B (328,012 B raw) | **47,885 B** (328,845 B raw) | — |
| storefront `theme-*.css` | 1,516 B | **1,492 B** (`raised` is `var(--clay-1)`) | — |
| `.ap` `theme-*.css` | 1,243 B | **1,185 B** (role radii and clay shadows; the light copies deleted) | — |
| CSS, public files (8) | 60,659 B | **60,700 B (+41 B)**; local headroom 740 B (≈ 730 B on CI, which builds ≈ 10 B larger) | 60 KB = 61,440 B, **not raised** |
| CSS, private operations (3) | 7,216 B | 7,216 B (untouched) | 7.5 KB |
| entry chunk / initial payload | 63.8 KB / 180.4 KB | 63.7 KB / 180.3 KB over 4 files | 72 KB / 200 KB |
| merchant workspace shell closure | — | 32,733 B (35 B under) | 32 KB = 32,768 B, **not raised** |

Where the bytes went: the new named variants (`shadow-xs`, `shadow-press`, `active:`/`group-active:`/
`has-[a:active]:shadow-press`, `hover:shadow-lg`, `sm:shadow-2xl`), the well fill and field line as
arbitrary values (`bg-[var(--clay-well-bg)]` with its `active:`/`group-active:` forms,
`border-[var(--clay-field)]`), `rounded-t-3xl`/`sm:rounded-2xl`, `bg-crimson`, `bg-text-muted/40`, the
four `lv-chip` tone properties and `bg-rose-600`; against the storefront `raised` recipe (−24 B), the
`.ap` light shadow copies and literal radii (−58 B) and the class strings nothing names any more. The
workspace shell's JS closure (Button, Menu, Overlay, Segmented, Sheet) grew by its new class strings and
was funded by dropping the dialog's `filter: blur()` enter/exit — a raster of the whole window on every
frame of the spring, and glass in a solid-clay system.

Paint: a product card is one blurred layer at rest and a press (no shadow transition, no image zoom), and
`content-visibility` moved from the grid's `<li>` to the card (and to the list row), so the cast of every
card from the 9th on is no longer clipped at the wrapper; the two horizontal shelves keep 8 / 12 px of
room for the cast. No window animates a filter any more. The scroll trace on a ×4-throttled 360 × 800
phone (plan §8) is still owed.

## 2026-10-10 — clay foundation QA: the screenshot pass after Phases 1–2 and one batch of fixes (DECISIONS row 210)

Every screen of `scripts/e2e-theme-shots.mjs` at 390 px in both themes (plus 1280 px for home, product, admin
overview, the merchant workspace and the kit) against the `a68790b9` baseline, with a read-only DOM pass over
the same screens (a raised container inside a raised one, a black shadow on cream, a cast cut by a clipping
ancestor, and the keyboard focus ring). Fixed in one batch: a card inside a card, a dialog or a sheet is flush
(one components-layer rule; AsyncStates sat raised inside cards), the admin tab wrapper is a flat tray, a
focused `lv-input` adds a solid 1 px focus ring (on cream the field line and the focus ink are a near match),
the quantity stepper's figure shows its own focus, four photo tiles drop the resting inset hairline that put
their focus ring under the photo, and the workspace quick dock leaves room for its buttons' cast.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (Phase 2, `fea0b7e8`, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 47,885 B (328,845 B raw) | **47,806 B** | — |
| CSS, public files (8) | 60,700 B | **60,621 B (−79 B)**; local headroom 819 B (≈ 809 B on CI, which builds ≈ 10 B larger) | 60 KB = 61,440 B, **not raised** |
| CSS, private operations (3) | 7,216 B | 7,216 B (untouched) | 7.5 KB |
| entry chunk / initial payload | 63.7 KB / 180.3 KB | 63.7 KB / 180.3 KB over 4 files | 72 KB / 200 KB |
| merchant workspace shell closure | 32,733 B | under 32 KB (gate green; the dock and the stepper are in lazy screens) | 32 KB = 32,768 B, **not raised** |

Where the bytes went: the nested-card rule and the input's 1 px focus ring (about +40 B) against ten comment
mentions of utilities no code uses (`bg-canvas/88`, `from-olive/40`, the multiply and screen blends, a light/dark
hex pair and the cart's old 80/100 px offset), which Tailwind had been compiling out of the comments — reworded,
−118 B. No new class names: every utility the fixes use (`-my-1/-my-2`, `py-1/py-2`, `focus-visible:ring-inset`)
was already in the sheet.

Paint: unchanged in kind — a nested card loses its blurred cast (one fewer blurred layer per nested card), the
admin wrapper loses its `--clay-2` cast, and the four photo tiles lose an inset ring layer. The scroll trace on a
×4-throttled 360 × 800 phone (plan §8) is still owed.

## 2026-10-10 — clay Phase 3: the page families, swept by hand (DECISIONS row 211)

The build plan's Phase 3, integrated as nine family commits on top of the foundation (`4b5fc125`): auth (D4),
the admin kits and operations sheets (3.5a), the 27 heaviest admin screens (3.5b), the rest of admin (3.5c),
the merchant workspace (3.4), community (3.3), account (3.2), the storefront's «Do first» screens with the
feature surfaces (3.1), and the rest of the shop with the merchant stores and the two games exceptions (3.1).
Hand-drawn zinc cards became `lv-surface`, read-outs wells, raw fields `lv-input`, ad-hoc buttons
`lv-button`/`IconButton`, tone pills `lv-chip`/`StatusChip`, arbitrary radii the role tokens, and zinc
utilities semantic tokens. Nothing was measured in the lab; these are the gate's figures.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (foundation `4b5fc125`, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 47,773 B (327,964 B raw) | **42,969 B** (278,872 B raw) | — |
| `Auth-*.css` | 8,123 B (40,057 B raw) | **7,787 B** (39,013 B raw) | — |
| CSS, public files (8) | 60,588 B | **55,445 B (−5,143 B)**; local headroom 5,995 B (≈ 5,985 B on CI, which builds ≈ 10 B larger) | 60 KB = 61,440 B, **not raised** |
| CSS, private operations (3) | 7,216 B | **7,258 B (+42 B)**; headroom 422 B | 7.5 KB = 7,680 B, **not raised** |
| entry chunk / initial payload | 63.7 KB / 180.3 KB (row 210) | 63.9 KB / 180.5 KB over 4 files | 72 KB / 200 KB |
| merchant workspace shell closure | 32,733 B (Phase 2) | **32,743 B**; headroom 25 B | 32 KB = 32,768 B, **not raised** |

Where the bytes went: the sweep deleted far more utilities than it added. Every legacy card (`rounded-* border
border-zinc-* bg-zinc-*/NN`), every hand-drawn button and field, the `bg-<tone>/10` pills and almost all zinc
utilities (2,024 → 42 census hits) left the source, so their rules — each tinted variant with its
`color-mix` fallback — left the sheet; the replacements are the component classes the foundation already
shipped (`lv-surface`, `lv-well`, `lv-input`, `lv-button-*`, `lv-chip`, `lv-alert-*`) plus a few new
utilities (`rounded-b-3xl`, `sm:rounded-lg`, `text-danger-ink`). Auth's
sheet shrank by its own bare `.lv-alert` rule (now `.lv-notice`) and the light ground literals (D4).
The operations sheets grew by the two-theme `--fw-shadow` card cast (+42 B) after the `.fw` backdrop blur
was removed. The workspace closure grew 10 B (the shell's class strings) and is 25 B under its gate:
the next merchant-shell change needs funding first.

Census (`node scripts/clay-census.mjs`), before → after: legacy cards 422 → 0, ad-hoc buttons 159 → 14,
raw inputs 461 → 172, arbitrary radii 100 → 2 (the ratchet ceilings in `tests/claySystem.test.ts` are now
0 / 14 / 172 / 2), canvas wrappers 42 → 8, zinc utilities 2,024 → 42, files with a finding 340 → 101.

Paint: nothing in kind — no element blurs what is behind it (the operations sheet's backdrop blur was the
last, held by `tests/claySystem.test.ts` item 5 now walking the three operations sheets), a card nested in a
card, a dialog or a sheet stays flush, and the admin orders board is one tray per day with flat rows instead of
a card per order. The scroll trace on a ×4-throttled 360 × 800 phone (plan §8) is still owed.

## 2026-10-13 — Images R2: small copies kept in R2, the right size everywhere (DECISIONS row 226)

Owner request: «أريد تحويل الصور كلها وضغطها بتكون بحجم صغير وليس بحجمها الأصلي الكبير».
Layout and rules of the stored copies: `docs/MEDIA_STORAGE.md` «Small copies — `variants/`».

### What was wrong (read-only public GETs of the live site, 2026-10-13)

- A small copy (`/files/<key>?w=`) lived only in one data centre's `caches.default`, so every
  cold data centre resized it again: time to first byte 0.85–2.34 s, against 0.20–0.27 s for
  the original.
- `CropPhoto` (category hero, row banners, related categories) and most `<img>`/`SafeImage`
  sites downloaded the stored original — a 1254² photo into a 192–495 px box; 814 of the
  1,350 KB of phone image bytes on the six pages below.
- The ladder jumped 640 → 1080, so a 700 px desktop promo or a 558 px product photo took 1080.
- Stored originals had no pixel limit.

### Quality (luma SSIM, Gaussian 11×11 σ 1.5, against a lanczos3 resize of the original; 24 live copies)

| Encoding at the same widths | Bytes | vs live | Mean SSIM |
|---|--:|--:|--:|
| live `IMAGES` AVIF q75 (before) | 656,545 | 1.00 | 0.9777 |
| sharp WebP q75 | 579,248 | 0.88 | 0.9775 |
| sharp WebP q80 | 695,916 | 1.06 | 0.9819 |
| sharp AVIF q50 / q55 / q60 | 378,453 / 437,854 / 522,294 | 0.58 / 0.67 / 0.80 | 0.9755 / 0.9787 / 0.9826 |

The binding's WebP is ≈ 1.14× sharp's at the same quality, so its WebP q75 and AVIF q75
cost the same bytes: WebP drops from q85 to q75 (≈ −30 % for browsers without AVIF).

**AVIF is q60** (the verification of row 226 found the product grid's bytes unchanged at q75).
The calibration (34 live copies, `verify-perf/calibration.json`): the binding's AVIF q75 bytes
equal libaom's (sharp) at q68. Assuming the same offset, q60 ≈ sharp q53. On the 7 grid
photographs at the drawn size: sharp q53 is −41 % of the bytes at the 640 rung with SSIM
0.978 against 0.984 at q68; desktop 320 rung −38 %, SSIM 0.975 against 0.982. The offset is
measured at one point only — the first live check after release compares a kept `?w=640`
copy's bytes with today's (expected ≈ −40 %).

### Image bytes per page — calibrated local lab, before (`f7f44ca2`) and after

Method (the verification lab, `scratchpad/images-perf/verify-perf/` + `fix2/`): each build
served by its own `wrangler dev --local` with the real `/files` route, local R2 holding the 23
live originals and the local `IMAGES` binding; `/api/*` from fixtures of live public GETs. A
local proxy re-encodes every `?w=` copy's body with sharp AVIF at the calibrated quality —
q68 for the base (= the live binding's q75 bytes) and q53 for the after build (q60) — so the
bytes are live-equivalent. Playwright Chromium, phone 390×844 at DPR 3, desktop 1280×800 at
DPR 1, page loaded then scrolled to the end; both builds fetched the same number of pictures
on every page.

| Page | Phone before | Phone after | Desktop before | Desktop after |
|---|--:|--:|--:|--:|
| `/` | 162,711 | 92,267 (−43 %) | 264,263 | 125,383 (−53 %) |
| `/products` (grid) | 218,359 | **86,469 (−60 %)** | 81,533 | 50,810 (−38 %) |
| `/product/esun-pla-plus` | 56,195 | 37,142 (−34 %) | 22,335 | 15,661 (−30 %) |
| `/product/bambu-lab-round-magnet` | 96,711 | 57,022 (−41 %) | 86,237 | 35,555 (−59 %) |
| `/categories` | 524,150 | 108,465 (−79 %) | 524,150 | 76,731 (−85 %) |
| `/categories/printing-materials` | 347,833 | 76,020 (−78 %) | 323,947 | 53,352 (−84 %) |
| **All six** | **1,405,959** | **457,385 (−67 %)** | **1,302,465** | **357,492 (−73 %)** |

What moved: on the phone grid the 174 px card at DPR 3 takes the 480 copy (`(min-resolution:
2.5dppx)` clause, 0.92 image px per screen px) instead of 640; every AVIF copy is q60; the
category banners take 800 / 640 copies instead of the 1254² originals; the magnet's 558 px
desktop photo takes 800, not 1080. Sensitivity to the q60 calibration (`fix2/sens.json`, the
same copies re-encoded): the sizing alone, every copy at the old quality (sharp q68), is
788,709 B phone (−44 %) / 614,263 B desktop (−53 %); if the binding's q60 behaves like sharp
q58 rather than q53, 551,488 (−61 %) / 431,355 (−67 %), and the phone grid −53 % instead of −60 %.

The first report of row 226 said −45 % / −59 %: that was a WebP q75 stand-in (≈ 0.89× the
live AVIF) and, for the home page on the phone, a different cache-reuse timing; it does not
reproduce and is replaced by the table above.

Not in the table: the store pages and `/community` (closed live), and the ~140 other sites
(cart, account, chat cards, compare, community feed, back office) that downloaded originals
and now take thumbnail rungs — a 512 px avatar drawn at 32 px becomes a 160 px copy.

### Latency

LCP, Slow 4G (150 ms, 1.6 Mbit/s) + CPU ×4, warm caches, median of 3, builds alternated, the
same calibrated lab (`fix2/lcp.json`, `fix2/lcp-sum.json`; load average 3.6–6.9 during the
run, so differences under ≈ 300 ms are noise):

| Page | Phone before → after | Desktop before → after |
|---|--:|--:|
| `/` | 3,972 → 3,448 ms | 2,264 → 2,232 ms |
| `/products` | 3,984 → 3,488 ms | 3,572 → 3,404 ms |
| `/product/esun-pla-plus` | 3,876 → 3,844 ms | 3,956 → 3,872 ms |
| `/product/bambu-lab-round-magnet` | 4,360 → 3,996 ms | 4,264 → 3,912 ms |
| `/categories` | **5,060 → 3,584 ms** | **5,080 → 3,464 ms** |
| `/categories/printing-materials` | 4,548 → 4,132 ms | **5,220 → 3,952 ms** |

Every copy cut once is kept in R2 and read from there by every data centre afterwards
(`X-Variant-Source: r2`), at about the original's first-byte time instead of a fresh resize
(0.85–2.34 s live). Right after the release, a data centre that still holds a copy cut before
it (edge key without `v`) answers from it at once (`legacy`, one hour in the browser) and the
kept copy is cut after the response; the AVIF rungs of a new upload are cut at upload; pictures
already stored are cut by the quarter-hour sweep (72 cuts a tick, three at a time — the ≈ 1,800
copies of the live shop in about six hours). Live checks after deploy: `?w=640` twice from two
data centres (`render` or `legacy` once, then `r2`/`edge`), its bytes against today's copy,
`GET /files/variants/v1/…` → 404, `/categories` HTML with `?w=800` in the `CropPhoto` srcset,
and `image_variant_failed` / sweep pauses in the Workers logs.

### Verification round (2026-10-14) — what was found and what changed

| Finding | Change |
|---|---|
| The grid's bytes did not move (0 %) | AVIF q60; the phone grid at DPR ≥ 2.5 takes the 480 copy |
| Reported −45 % / −59 % did not reproduce | the calibrated table above |
| First views slow right after deploy (new edge key, empty R2, 24 cuts a tick) | the old edge copy answers while the kept copy is cut; sweep 72 cuts a tick |
| Each width held the original again (17 MB JPEG: +180 MB) | one Blob read afresh for every width |
| Cropped-to-fill pictures stretched (community covers, store gallery and hero, store product photo, admin form on a phone) | `coverSizes` with the picture's aspect, `coverFit` after load where none is known, hero `150vw` on a phone, admin sizes per real column |
| A refreshed link card's copy stayed old, from R2, for good | `link-cards/` is rewritten in place: copies checked against the original's ETag, 5-minute revalidation, the sweep re-cuts on a new ETag |
| Ten bad customer posts paused the sweep 12 h | a probe tells the binding's failure from the picture's; a bad picture is marked once and skipped |
| A deleted picture's copies stayed in that data centre's edge | `invalidateMediaCache` drops every copy's entry |
| A public WebP kept its GPS EXIF | `stripWebpMetadata` at every door that keeps a public WebP as it came |
| WebP q85 → q75 for browsers without AVIF | kept (the same grade as the AVIF most visitors get) |
| CLS 0.004 on a category page (the sort button) | not from this change: the base shows the same shift |
| `source_url` in live `/api/products/<slug>` | already removed in the base (`projectPublic`, row 220); goes live with this push |

### Bytes of code (gzip −9, the gate's method; `vite build`, tests/bundleBudget.test.ts green, no budget raised)

| | before (`f7f44ca2`, built locally) | after | gate |
|---|--:|--:|--:|
| entry chunk | 65,425 B | 65,926 B (+501 B: the one width list, the srcset builder, the store hero's phone `sizes`) | 72 KB |
| initial payload | 184,858 B | 185,359 B | 200 KB |
| storefront app payload | 238,931 B | 239,553 B (`coverFit` in the store's parts); headroom 63 B | 234 KB = 239,616 B, **not raised** |
| merchant workspace shell closure | 32,751 B | 32,751 B (the shell's logo keeps its plain `<img>`) | 32 KB = 32,768 B, **not raised** |
| CSS (11 files) | 62,708 B | 62,708 B | — |

The storefront has 63 bytes left: the next storefront change needs bytes freed first.

## 2026-10-13 — clay polish, batch 1: the system level (DECISIONS row 229)

The owner's «أريد اكمال التطوير في التصميم ولجعله افضل اكثر», batch 1 of the clay polish plan: the dark
clay's rim and base, the workbench light (stronger, and an ellipse that covers the first screen) carried
through the four top bars that rest at the scroller's top, gold as the only focus ring (a base-layer
`:focus-visible` fallback, the admin kit's fields on the `.lv-input` focus rule), no continuous decorative
motion in the header, a flat disabled primary, the selection's second cue as a straight logical `::before`
bar, and the dark Segmented thumb on the selected fill. Measured locally against a build of `30aa30d0`
(this batch's base) with the same toolchain.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (`30aa30d0`, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 42,994 B | **43,004 B (+10 B)** | — |
| `theme-*.css` (admin products kit) | 1,185 B | **1,188 B (+3 B)** | — |
| CSS, public files (8) | 55,470 B | **55,483 B (+13 B)**; local headroom 5,957 B | 60 KB = 61,440 B, **not raised** |
| CSS, private operations (3) | 7,238 B | 7,238 B (untouched); headroom 442 B | 7.5 KB = 7,680 B, **not raised** |
| entry chunk | 65,425 B | **65,234 B (−191 B)** | 72 KB |
| initial payload (4 files) | 184,858 B | **184,667 B (−191 B)** | 200 KB |
| merchant workspace shell closure | 32,716 B | 32,711 B (no shell source changed; chunk-hash noise); headroom 57 B | 32 KB = 32,768 B, **not raised** |

Where the bytes went: added — the base `:focus-visible` rule, the `.ap-field:focus-visible` selector, the
flat disabled-primary rule, the `::before` selection bar and its `:has(.lv-choice-mark)` opt-out, the dark
Segmented thumb rule, the forced-colours focus selectors on a chosen option, and three `enabled:` iris
utilities on the admin primaries. Removed — the RTL copy of the selected rule, `@keyframes rainbow`, the
`animate-spin`/`w-[300%]`/`h-[300%]`/`w-[200%]` utilities, and the arbitrary purple focus utilities
(`focus:shadow-[0_0_0_3px_var(--ap-accent-soft)]`, `focus:border-[var(--ap-accent)]`,
`focus-within:border-[var(--ap-accent)]`, `focus-visible:ring-iris(/60)`). The entry lost the spinning
conic ring and the seven-stop animated gradient of the header.

Paint: the scroll trace owed since row 210 was run — home and `/products`, 360 × 800, CPU ×4, three screens of
scroll, both themes, local Vite: no Paint or raster task over 16 ms (paint max 7.9 ms, raster max 12.5 ms).
Home shows a few style recalculations over 16 ms while its lazy sections mount; none is a shadow. A resting
card still paints one blurred layer; the selection bar is a 3 px solid box, not a shadow.

## 2026-10-13 — clay polish, batch 2: the customer screens (DECISIONS row 230)

Batch 2 of the clay polish plan: the profile in Sorani (no sideways scroll, readable labels, one colour), a
real not-found page, the points page (honest error, readable balance, one raised coin and one raised check-in
slab), no third-party avatars, the phone cart as clay trays with one raised summary (two columns from 1024 px),
calm order lists with ink totals, clay hero buttons, the buy column that starts with its identity, empty states
with a next step, quiet checkout step numbers, «طلب جديد» that opens nothing while the community is shut, and
Sorani for every string on the points page, the cart and the profile. Measured locally against the batch-1
build with the same toolchain.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (batch 1, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 43,004 B | **42,544 B (−460 B)** | — |
| CSS, public files (8) | 55,483 B | **55,023 B (−460 B)**; local headroom 6,417 B | 60 KB = 61,440 B, **not raised** |
| CSS, private operations (3) | 7,238 B | 7,238 B (untouched); headroom 442 B | 7.5 KB = 7,680 B, **not raised** |
| entry chunk | 65,234 B | **65,368 B (+134 B)** | 72 KB |
| initial payload (4 files) | 184,667 B | **184,801 B (+134 B)** | 200 KB |
| `NotFound-*.js` (new, lazy) | — | 785 B | 250 KB per chunk |
| merchant workspace shell closure | 32,711 B | 32,712 B (no shell source changed; ±3 B import-hash noise in Button, Menu, Overlay, Segmented, Sheet, money); headroom 56 B | 32 KB = 32,768 B, **not raised** |

Where the bytes went: removed — the profile's ten one-off tile colours (`text-sky-500` … `bg-orange-900/30`),
`text-flame`, `after:bg-zinc-700`, the label sizes `text-[9px] sm:text-[10px] leading-[12px] min-h-[24px]`;
the points coin's hex layers, tilts and offsets (`bg-[#6b5f3c]`, the `#BAA369 → #ffe55c` gradient,
`border-[4px]`, `-rotate-12`, `translate-x-[3px]`, `translate-y-[4px]`), the check-in card's rotated
under-layer, binder holes and paperclip, the spend row's rose tint; the cart's `sm:mx-4 sm:mt-4 sm:rounded-xl`
bands; the hero's private white/black button utilities; `fill-sky-500`; the typeset cover's 36 px title.
Added — `lg:sr-only` (the product title, visually hidden only from 1024 px) and `fill-info`. Everything else
reuses classes already in the sheet (the trade-in form's `lg:grid-cols-[minmax(0,1fr)_340px]` grid,
`lv-surface`, `lv-surface-raised`, `lv-well`, `top-20`). The entry gained the initials helper, the header's
avatar-failure state and the lazy `NotFound` import, and lost the third-party avatar URL.

## 2026-10-13 — clay polish, batch 3: admin, merchant workspace and auth leftovers (DECISIONS row 231)

Batch 3 of the clay polish plan: the admin-kit primary legible in light (snow ink) and one purple (`iris`); the
finance workspace on the app's own tokens (wells, gold focus, no dark copy); the admin tabs on the canvas
instead of a same-colour panel; kit selection as a press (`.ap-chip`); the overview's queue tiles as real raised
buttons and its statuses as words; the users panel in three languages; one raised action per order row; the
inventory tabs as one scrolling row with neutral stat icons and raised doors; the USD panel as a flat group;
11 px sidebar labels; one store-colour swatch, governorate-first order rows and a 720 px settings column in the
merchant workspace (lazy screens only); the support desks as a `Segmented`; the security panel, the theme
preview and `SafeImage` on semantic tokens; the /auth copy row as a well; the clay ratchet lowered. Measured
locally against the batch-2 build with the same toolchain.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (batch 2, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 42,544 B | **42,433 B (−111 B)** | — |
| admin-kit `theme-*.css` | 1,188 B | 1,239 B (+51 B: the `.ap-chip` press rule) | — |
| CSS, public files (8) | 55,023 B | **54,961 B (−62 B)**; local headroom 6,479 B | 60 KB = 61,440 B, **not raised** |
| `FinanceWorkspace-*.css` | 3,903 B | **3,756 B (−147 B)** | — |
| `AdminInventory-*.css` | 1,301 B | 1,317 B (+16 B: the raised doors) | — |
| CSS, private operations (3) | 7,238 B | **7,107 B (−131 B)**; headroom 573 B | 7.5 KB = 7,680 B, **not raised** |
| entry chunk | 65,368 B | 65,340 B (−28 B) | 72 KB |
| initial payload (4 files) | 184,801 B | 184,773 B (−28 B) | 200 KB |
| merchant workspace shell closure | 32,712 B | 32,710 B (no shell source changed; import-hash noise); headroom 58 B | 32 KB = 32,768 B, **not raised** |

Where the bytes went: removed — finance's private palette and its dark copy, the slate focus ring, the
`--fw-*` hex values; the admin panel frame (`rounded-2xl p-4 md:p-5` on a `bg-surface` panel), the kit's
`aria-pressed:`/`aria-[current=page]:` purple text, tint and border utilities, `bg-[#6B46FF]`, the farm bar's
`rounded-[28px]`, AdminSecurity's zinc borders and fills, `uppercase tracking-[0.12em]` and `text-[9px]`.
Added — the `.ap-chip` press rule, the inventory doors' clay cast and press, the /auth copy row's well, and a few
utilities already in the sheet (`text-snow`, `bg-iris`, `bg-surface-selected/60`, `max-w-[720px]`).

### The clay ratchet (tests/claySystem.test.ts 7)

| count | before | after |
|---|---|---|
| legacy cards | 0 | 0 |
| ad-hoc buttons | 13 (ceiling 14) | **10** |
| raw inputs | 172 | **29** |
| arbitrary radii | 2 | **0** |
| zinc utilities (new key) | 40 | **19** |
| canvas wrappers (new key) | 6 | **5** |

The census gained four documented refinements, each pinned by a test that also proves a hand-drawn control
still counts: a field or fill named in a comment is not code; a skeleton bar is not a button; an arrow function
inside a tag does not end it; a house well (`lv-input`, the kit's `ap-field` recipes `T.input`/`T.select`/
`T.selectSm`, `lv-well`, `fw-input`/`fw-select`, the /auth wells) is styled.

## 2026-10-14 — clay polish QA: the screenshot pass after batches 1–3 and one batch of fixes (DECISIONS row 232)

One bounded QA pass over `feat/clay-polish` after the three polish batches: every customer screen re-shot in
Arabic and Sorani, light and dark, at 390 and 1280 (208 shots), the populated screens (48) and the staff screens
(62), compared with the critique's "before" shots; then the plan's §8 passes that had never run — a keyboard Tab
pass on home, product, cart and checkout (28 stops per theme, judged by the visible difference between focused
and blurred), reduced-motion and forced-colours emulation on home, product and checkout, and a contrast / clipped
text / overflow probe on 17 screens in ar and ckb at 390 and ckb at 360. No regression was found: no sideways
scroll, no clipped Sorani label, no focus stop without an indicator or under the bottom chrome, nothing moving
under reduced motion, 0 contrast misses across the 62 staff shots. Fixed in one batch: the interrupted earlier
QA run's edits (kept after review — `:has()` focus on hidden-radio choice cards, the cart's offers header as a
real button, `scroll-padding-bottom` under the bottom chrome, forced-colours button lines and switch knobs,
stronger search halos, the product signals row in the buy column, the points page's unknown balance, Sorani for
the appearance controls and the community requests board), plus this pass's own findings: 21 gold focus rings
now use the focus ink, `/points` is one centred column from 1024 px, the Sorani wallet toolbar wraps the status
select and the search button together, the member pill passes 4.5:1, and the chosen gallery picture keeps a
Highlight frame in forced colours. Measured locally against the batch-3 build with the same toolchain.

### Bytes (gzip −9, node zlib level 9 — the gate's method; `vite build` + `write-asset-headers`, tests/bundleBudget.test.ts green)

| | before (batch 3, built locally) | after | gate |
|---|---|---|---|
| `index-*.css` | 42,433 B | 42,572 B (+139 B) | — |
| CSS, public files (8) | 54,961 B | **55,100 B (+139 B)**; local headroom 6,340 B | 60 KB = 61,440 B, **not raised** |
| CSS, private operations (3) | 7,107 B | 7,107 B (unchanged); headroom 573 B | 7.5 KB = 7,680 B, **not raised** |
| entry chunk | 65,340 B | 65,341 B (+1 B) | 72 KB |
| initial payload (4 files) | 184,773 B | 184,774 B (+1 B) | 200 KB |
| merchant workspace shell closure | 32,710 B | 32,713 B (no shell source changed; import-hash noise); headroom 55 B | 32 KB = 32,768 B, **not raised** |

Where the bytes went: added — `.lv-choice:has(input:focus-visible)` in the focus rule and in forced colours, the
forced-colours `.lv-button` line and switch knob/fill rules, `scroll-padding-bottom` on the main scroller (and its
`:has([data-bottom-bar])` variant), the `ring-focus/40` halos, `focus-visible:ring-inset`, `max-w-2xl`,
`border-gold/40`, and the forced-colours Highlight frame on the chosen gallery picture. Removed — the
`focus-visible:ring-gold`, `focus-within:ring-gold`, `peer-focus-visible:ring-gold` and `ring-gold/70` focus
utilities (their `ring-focus` twins were already in the sheet, or are now) and `hover:bg-gold/15`.

## 2026-10-16 — speed audit, payload lane: a card carries its picture; the spec table is sent once

Two confirmed causes of the 2026-10-16 speed audit (findings 7 and 21: card galleries; finding 24: the
printer detail's spec table twice). Code: `worker/lib/cardGallery.ts`, `cardShape` and
`publicSpecifications` in `worker/routes/products.ts`. No client code, no query, no D1 statement changed
(tests/d1Waves.test.ts green); the product page's own answer keeps the whole gallery.

### Bytes — the live answers, anonymous GETs 2026-10-16, before and with the new code applied

Recorded with `curl -H 'Accept-Encoding: br'`; "after" is the same JSON passed through the lane's real
functions (`cardGallery` on every card, `publicSpecifications`' rule on the detail) and re-compressed with
brotli quality 4, which reproduces the live wire within 1.1 % on all eleven answers.

| Answer | JSON before → after | On the wire before (live) → after |
|---|--:|--:|
| `/api/products?limit=50` (`/products`, preloaded by the document) | 171,557 → 27,121 | 26,635 → 5,620 |
| `/api/products?sort=available&limit=50` (the `/categories` photo pool) | 171,605 → 27,169 | 26,672 → 5,658 |
| `/api/products?category=cat_materials_fdm&facets=1&limit=24` (a listing) | 117,917 → 20,308 | 18,514 → 4,399 |
| `/api/home` | 45,249 → 23,121 | 9,449 → 6,031 |
| `/api/catalog/printing-materials` | 60,155 → 17,695 | 9,705 → 3,358 |
| `/api/products?search=pla&limit=6` (live search, per query) | 57,674 → 5,965 | 9,156 → 1,365 |
| `/api/products/bambu-lab-h2d` | 237,416 → 193,648 | 34,279 → 30,271 |
| `/api/products/bambu-lab-h2c` | 252,234 → 205,251 | 36,689 → 32,351 |
| `/api/products/bambu-lab-p1s` | 160,505 → 134,278 | 25,769 → 23,254 |

97 live cards checked: `productPrimaryImage`, `productMainImage` (both themes), `photoOf`, `images[0]` and the
public API's `cardImage` (url, size, alt texts) pick the same picture before and after. The card keeps id, url,
primary, order, width, height and the three alt texts of its one picture (0.7 KB on the wire of the 50-card
answer against url + primary alone, kept so the public API v1 card image does not change). The audit's "≈ 33 KB" for the spec table
counted each copy compressed on its own; inside the answer brotli already shares most of the duplicate, so
dropping it is worth 2.4–4.2 KB per printer, as both skeptics measured.

### Display time — a replay lab, both arms interleaved

`scratchpad/perf/payload-lab/` (server.mts, drive.mjs after the category lane's lab): one `npm run build` of
this branch served over HTTP/2 as levonis-iq.com; `/api` and `/files` replayed from one recording of the live
answers, each API answered after 250 ms (an edge hit); the after arm applies the lane's code to the recorded
answers. Chromium 360×800 DPR 3, CPU ×4, Slow-4G (150 ms, 1.6 Mbit/s), a cold context per visit, 8 + 8 runs
per route. The machine's load average was ≈ 10 on 4 cores during the run (other work), so single runs are
noisy; paired differences (after − before, by run) with their standard error:

| Route | Key answer finished | FCP | First image requested | LCP |
|---|--:|--:|--:|--:|
| `/products` | −694 ± 16 ms (1,467 → 776, median) | −107 ± 43 ms | −197 ± 125 ms | −117 ± 114 ms (median 2,990 → 2,932) |
| `/categories/printing-materials/fdm-materials` | −185 ± 93 ms | −25 ± 39 ms | −167 ± 114 ms | −173 ± 142 ms (median 4,948 → 4,900) |
| `/categories` | −254 ± 79 ms | −36 ± 52 ms | −215 ± 90 ms | **−219 ± 88 ms** (median 3,654 → 3,380) |
| `/product/bambu-lab-h2d` | −75 ± 15 ms | +1 ± 69 ms | +27 ± 164 ms | +89 ± 164 ms (noise) |

On `/products` the 26 KB answer shared the link with the route's JavaScript; it now arrives 0.7 s sooner and
the first paint follows ≈ 0.1 s sooner. `/categories` borrows its banner photographs from the 50-card pool, so
the pool's 21 KB were on the LCP chain. The spec-table change is too small to see in display time (≈ 4 KB);
moving `spec_groups` off the critical detail answer is the change that would be (see below). On a cache
miss (server 1.0–1.6 s) the bytes hide behind the wait and the gain shrinks to noise, as one of the audit's
skeptics measured; on ordinary 4G (10 Mbit/s and more) every number above is ≈ 20 ms or less. The saving
grows with the catalogue: an imported Bambu card carries up to 31 gallery entries.

### Not changed here

- `spec_groups` itself (≈ 22 KB brotli of the H2D detail, three languages, drawn only when «المواصفات» is
  opened). Deferring it needs a new cached endpoint, the product page fetching it near the viewport, and the
  document preload — three other lanes' files — and an older cached bundle would show no table; measured by
  the audit at −113 ± 58 ms title paint on H2D only.
- The detail's other legacy aliases (`name`/`name_ku`, `description`/`description_ku`): each under 1 KB.

## 2026-10-16 — speed audit, the product page and the boot code (branch perf/product on 0d8ed43b)

The client half of the speed audit's product-page and boot findings (scratchpad
`perf/speed-audit-findings.json`: the light-theme lead picture, the product route's
code before first pixel, the lazy-route blank flash and React 19's 300 ms reveal hold,
the 239 KB critical payload, `/api/auth/me` and the community gate, the marquee loop).
No Worker file changed. Six commits:

- **The light theme's lead picture keeps a size** (`src/lib/productGallery.ts`
  `lightMainImageSize`): its own stored size when the answer carries
  `light_image_width/height` (the Worker does not send it yet), else its twin's (every
  live pair is 1254 × 1254), dropped again if the loaded file proves another shape. The
  drawn square's `sizes` and a srcset that stops at `1254w`, as the dark theme had.
- **The product opening no longer carries `vendor-motion`** (15.7 KB): `ui/Note.tsx`
  was its one static importer (the `motion` proxy); an inert note is a plain element.
- **The session and the gate's question leave with the entry** (`src/lib/bootFetch.ts`):
  `/api/auth/me` on every page, `/api/community/access` on the gated paths; the access
  read no longer waits for `/me` (asked under the cookie's key, adopted by the viewer's,
  never across a sign-in); the gate still draws after the session, so nothing moves.
- **A route whose code has arrived is shown at once** (`src/lib/routeReveal.ts`): a
  module in memory renders in the same pass (a thenable that resolves at once); one that
  lands while a fallback is up is revealed by an ordinary update, not React's throttled
  retry; the opening page's module is asked for at module evaluation; the product route's
  fallback is the product page's own loading screen.
- **The animation library's core leaves the first download**: the busy scrim and the
  update line fade with the Web Animations API (`src/lib/presenceFade.ts`), the shell asks
  for the features through a dynamic import, the rails import their spring on first use.
- **The home's ticker runs only where it is seen and out of a navigation's way**
  (starts after the first screen, stops off screen and during a `route` wait).

### Bytes (gzip −9, the bundle test's closure walk; `vite build` + `write-asset-headers`)

| | 0d8ed43b | perf/product | gate |
|---|---|---|---|
| initial payload | 178.8 KB / 4 files (entry 62.2, react 73.3, motion-core 31.7, i18n 11.6) | **148.3 KB / 3 files** (entry 62.9, react 73.7, i18n 11.6) | INITIAL 200 → **160 KB**; `vendor-motion-core` on the never-initial list |
| entry chunk | 62.2 KB | 62.9 KB | ENTRY 72 → **68 KB** |
| `/product/:slug` first visit (complete closure) | 270.8 KB / 28 files | **257.2 KB / 27** (24 beyond the entry = the document's preload cap) | new PRODUCT_OPENING 265 KB; ≤ 24 files beyond the entry |
| `/products` first visit | 205.4 KB / 16 | **174.8 KB / 15** | — |
| `/categories/:cat`, a store's home (core moved into their closures) | 243.5 / 244.7 KB | 245.2 / 246.4 KB | — |
| `/community` while shut (initial only) | 178.8 KB | **148.3 KB** | — |
| chunks under 1 KB | 45 | 45 | 45 (unchanged) |

### Lab — before (0d8ed43b) / after (this branch), cold, median of 5

Local HTTP/2 replay of live data (scratchpad `perf/plab/server.mts`: the arm's `dist`, the
documents rewritten exactly as the live Worker does — inline resolve, fetch preload, the
route's modulepreloads from the arm's manifest, the lead-image rule — and `/api`, `/files`
replayed from anonymous live GETs with a fixed 120 ms server delay); Playwright 360 × 800
DPR 3, CPU ×4, Slow-4G 150 ms / 1.6 Mbps, light theme (`perf/plab/drive.mjs`).

| route | FCP | LCP | h1 | lead picture | CLS |
|---|---|---|---|---|---|
| `/product/bambu-lab-pla-basic-filament` | 2828 → **2564** | 4240 → **3876** | 3195 → 2988 | `?w=1080` 43.3 KB → `?w=800` 29.9 KB | 0.0165 = |
| `/product/esun-pla-plus` (opens on a bound picture) | 2808 → **2552** | 3688 → **3448** | 3202 → 2871 | 18.5 KB = | 0.0165 = |
| `/products` | 2220 → **2008** | 3124 → **2612** | 2656 → 2076 | — | 0.0013 → 0.0037 (see below) |
| `/` | 2268 → **1828** | 2268 → **1828** | 2038 → 1726 | — | 0.0043 → 0.0023 |
| `/community` (closed: the card) | 1956 → 1840 | 2244 → **1880** | 2203 → 1846 | — | 0.0013 = |
| `/categories/printer-accessories` | 1976 → 1852 | 3768 → 3632 | 3095 → 2977 | — | 0.0013 = |

430 × 932 DPR 3, light, median of 3: PLA Basic lead 99.7 KB (the 1254 px original, `?w=1280`)
→ 43.3 KB (`?w=1080`), LCP 4924 → **4080**; H2D 75.4 → 36.8 KB, LCP 4356 → **3860**. Dark theme,
360@3 (lead unchanged, 37.2 KB): LCP 4424 → 4156. Filmstrip of a cold product landing: the
screen under the mascot's bar was empty until ~3.1 s; it is the product skeleton from ~2.5 s.
In-app home → «تسوّق الآن» → grid painted (5 runs): 197 → 175 ms with the ticker's change alone.

What the numbers say, and what to know:

- `/products` CLS 0.0013 → 0.0037: the grid now paints ~580 ms earlier, before the Latin
  Cairo subset (requested when the first Latin product name renders) has arrived, and its
  swap re-lays the card names once (0.0024). The cure is the font, not the grid: preloading
  `cairo-v31-latin.woff2` on the `/products` document is the document lane's call.
- A cold product landing now paints before the mascot's chunk is drawn, so its intro
  arrives more than `BOOT_LATE_MS` after the first paint and the character appears at its
  dock (AppIntro's own rule for a page that is already showing).
- Signed-in pages behind `ProtectedRoute` start their code one `/me` round trip earlier;
  not measured (no sign-in in the lab).

### For the integrator

- The edge lane's light-theme lead preload (`worker/lib/productOpeningLead.ts`,
  `socialPreview.ts previewFrom`) writes the light picture with no size, as Product.tsx did;
  with this branch Product.tsx draws it at the primary's size (`lightMainImageSize`), so the
  Worker's light line must carry the primary row's `width`/`height` too (or send
  `light_image_width/height`), or the preload and the <img> pick different copies. Its
  tests pin the old Product.tsx line (`tests/productLeadPreload.test.ts`) and will say so.
- The edge lane's category and community documents modulepreload the page closures; those
  closures now contain `vendor-motion-core` (it left the entry), which is what keeps the
  category page's reveal where it was.
- Not done here: the mascot's own loop (AppIntro) still runs every frame while docked
  (pausing it changes what the character visibly does); StockAlertPanel / ConditionPanel /
  ShippingConflictDialog stay static in the product chunk (≈ 9 KB; the first two would
  pop in on the products that show them); routes outside the documents the Worker rewrites
  keep plain `React.lazy` (only cold landings on them meet the 300 ms hold).

## 2026-10-16 — speed audit, the category lane: the category pages' reads in parallel, the explorer's photographs on the map, the grids' first screen

The owner: the site is slow to display on Iraqi phones — «loading all products at once is wrong; holding the page
until every image has loaded is wrong». The audit's category findings (every one verified twice on the live site):
the category pages were the slowest of the audit (phone LCP 5.98 s on `/categories/printer-accessories` and
`/categories/printing-materials/fdm-materials`, 4.10 s on `/categories`, live medians) because each read waited for
the one before it; the explorer's first banner photograph (its LCP) waited for a 50-product pool; `/products`
downloaded 16 of its 26 card pictures before any scroll while two visible cards were lazy and faded in; the
category banners took the 800 copy where 640 covers the drawn box.

What changed (branch `perf/cats`, seven commits before this entry):

| | Change |
|---|---|
| sizes | `cropBanner` follows the drawn row banner (205–223 px on a phone): `(max-width: 375px) 213px, 224px`; the compact hero's photo `195px`; the full hero keeps its value (279 px drawn; the truthful 280 px would take 1080 on DPR 3). `tests/categoryImageSizes.test.ts` |
| grids | the first screen eager and never faded (six cards on `/products`, four on a listing), `fetchpriority=high` only for the lead row's two, the rest held until within 300 px of the screen **in their scroller** (`#main-scroll-container`; `src/lib/nearViewport.ts`). `tests/gridImageLoading.test.ts` (real SafeImage in Chromium) |
| reads | every category URL's first reads start with the entry script and on the press of a link (`src/lib/bootFetch.ts categoryOpeningPaths`); the listing is asked for by slug, beside the map; a listing department names its list on its headers (`X-Catalog-Listing`); the loaders take the early request. `tests/categoryOpeningReads.test.ts` |
| map photos | `GET /api/catalog/tree` carries one photograph per section (off the card; available now, priced, shop order; never a sibling's); the explorer reads the pool only for a section without one. `tests/categoryTreePhotos.test.ts` |
| explorer extras | `GET /api/home/graded` (count + one photograph) instead of the whole `/api/home`; both extra banners after the map. `tests/explorerGradedSummary.test.ts` |
| related tiles | the map's photographs; the 3 KB map (not the 27 KB pool) only when the row nears the screen. `tests/relatedCategoriesPhotos.test.ts` |

### Method

A local lab (`scratchpad/perf/cats-lab`): the base build (`0d8ed43b`) and the branch build each served over
HTTPS/HTTP2 as `https://levonis-iq.com` (Chromium's host mapped to a loopback address), assets from the build with
brotli, the document as the Worker serves it (`/products` rewritten with `chunkPreloads`/`injectDocumentPreloads`,
category documents plain, as live). `/api` and `/files` replayed from ONE recording of anonymous live GETs, each
after a fixed 120 ms server delay; for the branch arm the recorded answers carry what the lane's Worker changes add
(the map's photographs, `/api/home/graded`, `X-Catalog-Listing`) — those are unit-tested on the real router.
Playwright Chromium 360×800 at DPR 3, CPU ×4, Slow-4G (150 ms, 1.6 Mbit/s down), a cold context per visit, arms
alternated, one unmeasured warm-up visit each, median of 5. An A/A control (the base build on both slots, 8 pairs)
read +62 ms LCP for the second slot and ±300 ms per pair: differences under ~150 ms are noise. The machine was shared
with other test runs (load average 4–21).

| Route | LCP before → after | First screen complete | Pictures before scroll | Page API bytes | Page data ready |
|---|--:|--:|--:|--:|--:|
| `/categories` | 3,168 → **2,944** ms | 3,986 → 3,531 ms | 6 / 189 KB → 6 / 135 KB | 33.7 → **2.6 KB** | 2,663 → 1,898 ms |
| `/categories/printer-accessories` | 3,820 → 3,728 ms | 3,781 → 3,733 ms | 4 / 85 → 4 / 67 KB | 5.3 → 5.3 KB | 3,307 → **2,098** ms |
| `/categories/printing-materials` | 4,716 → **4,228** ms | — | 14 / 247 → 9 / 169 KB | 32.7 → **8.9 KB** | 2,990 → 1,915 ms |
| `/categories/printing-materials/fdm-materials` | 4,892 → **3,716** ms | 5,259 → **3,797** ms | 14 / 223 → 8 / 122 KB | 18.5 → 19.4 KB | 3,513 → **2,016** ms |
| `/products` | 2,844 → 3,068 ms (noise: 8-pair run 2,952 → 2,972) | 4,347 → **3,575** ms | 16 / 245 → **8 / 116 KB** | unchanged | unchanged |

An earlier full run of the same arms (before the bundle trim) read `/categories` 3,440 → 2,992, printer-accessories
3,888 → 3,500, printing-materials 4,440 → 4,232, fdm-materials 4,920 → 3,940 and `/products` 2,996 → 3,044 ms. A tap
from `/categories` on the printer-accessories banner (4 runs): its list request leaves 325–470 ms after the press instead of
975–1,170 ms, and the new page's first screen is complete 1,542 ms after the press instead of 1,811.

What is left on these pages is the JavaScript: with the data ready at ~1.9–2.1 s, the route chunks (26–28 for the
category routes) still finish at ~3 s on Slow-4G. The document head start (inline resolve, route modulepreloads for
`/categories*`) is the next lever and belongs to the shell's lane (`worker/index.ts mainOpening`).

### Bytes of code (gzip −9; `vite build`, tests/bundleBudget.test.ts 16/16, no budget raised)

| | base `0d8ed43b` | after | gate |
|---|--:|--:|--:|
| entry chunk | 63,699 B | 64,481 B (+782: the category opening reads, the near-screen observer, SafeImage's two props) | 72 KB |
| initial payload (4 files) | 183,132 B | 183,914 B | 200 KB |
| a store page's fixed app weight | 231.8 KB | 232.5 KB | 234 KB |
| `CategoriesExplorer` beyond the initial payload | 24,822 B | 25,387 B | — |
| `CategoryPage` beyond the initial payload | 66,202 B | 66,929 B | — |
| `CategoryListing` beyond the initial payload | 60,382 B | 60,918 B | — |
| `Products` beyond the initial payload | 27,221 B | 27,321 B | — |

A new guard in tests/bundleBudget.test.ts keeps the listing grammar (`discovery`), `ListingView` and `listingQuery`
out of the explorer's static closure: an intermediate build of this lane had put the grammar there (+3.1 KB).

### Review fixes (2026-10-17)

The lane's review raised three findings. The hero and slug findings were upheld by both of their skeptics. The map
finding was upheld by one: the other found it already answered by `b3d5f57e`, which landed after the probe was written.

| Finding | Fix | Measured |
|---|---|---|
| Past `TREE_AVAILABILITY_CAP` (the Bambu import's ~1,142 products) an uncached `/api/catalog/tree` took 4 dependent D1 waves (base: 1) | `b3d5f57e`: the photographs' short list is one statement in the first wave | real router at 150 ms per round trip: 4 waves / ~650 ms → 2 waves / ~345 ms (base 1 / ~165 ms; the category page fetches the map and its list together, so a cold page no longer waits longer than base). Ceilings under and past the cap in `tests/d1Waves.test.ts` |
| The compact hero's `195px` assumed a one-line title. A wrapped title is drawn at 249 px and took the 640 copy for 747 device px (0.86): the en/ckb «Printer Accessories» at 320 px, and longer department names at 360–430 px in all three languages | the hero measures its photograph's zone before it inserts the picture (CropPhoto `fit`, a layout effect: same task, before paint, one request). It asks for that width, held between 195 px and the 230 px it asked for before the lane (`cropHeroCompactSizes`) | lab, three arms (base, lane, fix) × three languages × seven phones, with the real titles and with longer names: every one-line title (19 runs) keeps the lane's copy (640 on DPR 3); every wrapped title (23 runs) takes exactly the base's copy (800 on DPR 3 and 2.8125, 640 on 2.625–2.75, 480 on 2). A truthful 249 px would take 800 on the DPR 2.625–2.75 Android screens, where base took 640 (0.93–0.98). Throttled A/B on `/categories/printer-accessories` (360×800 DPR 3, CPU ×4, Slow-4G, 6 pairs): LCP 3,712 → 3,692 ms, first picture 3,073 → 3,102 ms, 67 KB in both (noise) |
| A section whose slug is longer than 60 characters (the admin's slugs reach 63 through uniqueSlug and 127 through quick-create) got 400 from `/api/products` by slug, where by id it had listed | above 60 characters the storefront asks by id and starts nothing early by slug; `X-Catalog-Listing` names the id; `/api/products` accepts 80 characters, as `/api/catalog/:slug` does | the review's probe: by slug 400 → 200; the header now carries `cat_pacc` |

Bytes of code (gzip −9, the lab's method): entry 64,481 → 64,516 B; `CategoryPage` beyond the initial payload
66,929 → 67,250; `CategoryListing` 60,918 → 61,227; `CategoriesExplorer` 25,387 → 25,705 (CropPhoto's measuring is
shared by all three); `Products` 27,321 → 27,314.

One wave stays on purpose. Past the cap, a miss of the map's edge entry costs 2 D1 waves where the bare map cost 1
(the review's probe at 150 ms per round trip: 1 wave / ~164 ms in base, 2 waves / ~350–366 ms now). The second wave reads
the short list's cards, because a section's photograph is read off the card, after the relational image overlay
(`worker/lib/cardPhoto.ts`). That wave buys one photograph per section, so the explorer no longer sends its own
`/api/products?sort=available&limit=50` request from the phone. On such a miss, the explorer's banners appear one round
trip later, with their photographs, and no second request follows. A category page asks for the map and its list
together, so it does not wait longer. The review's other options were not taken. Picking the photograph from the row in SQL would duplicate the card's
image overlay. A stale-while-revalidate map would keep «متوفرة الآن» stale for longer than its 300 s. The ceilings in
`tests/d1Waves.test.ts` hold the cost at 2 waves past the cap and 3 waves under it.

## 2026-10-16 — speed audit, the edge lane: stale serving, the category head start, the lead photo, the large rungs, the search dictionary

The owner asked to remove every cause of the slow display on Iraqi phones. The audit (25 confirmed causes,
each re-measured live by two skeptics) gave this lane the server side: findings «the edge cache never serves
stale», «category and other non-rewritten pages get no head start» / «the 5-step serial waterfall», «the
product's main photo is not preloaded on 25 of 26 product pages», «?w=1280 and ?w=1600 return the untouched
original», and «live search: 5 dependent D1 round trips». Nothing a visitor reads changed; no header, budget
or migration changed.

- **Stale serving, as the headers have always said** (`worker/lib/edgePolicy.ts` `edgeServe`). The Workers
  Cache API ignores `stale-while-revalidate`, so every anonymous answer died at `s-maxage=120` and the next
  guest in that colo paid the whole D1 build (live: 0.5–1.5 s, 2–5 dependent round trips). A copy is now kept
  for its declared window and stamped with when its data was read: fresh to half of `s-maxage`; served and
  rebuilt behind it to `s-maxage`; served AT ONCE and rebuilt behind it inside `stale-while-revalidate`; a miss
  past it. Per route class: price/stock answers (listing, search, product, home, shelves, a store's products)
  keep their declared 120 s + 600 s — the bound the header publishes and browsers already apply — and a
  session never sees a shared copy; the catalogue tree and category pages declare no stale window and keep
  their own `s-maxage` exactly (background refresh only). The refresh is a guest's request replayed through
  the whole Worker after the answer has gone (one per key per isolate; a 404 drops the copy). A purge also
  writes a per-path marker, so in the colo that wrote every copy of the path read before the write is retired —
  parameterised listings and searches included, which before lived on 120 s even there.
- **The head start for the category map and the community home** (`mainOpeningFor`, `run_worker_first`):
  `/categories`, `/categories/<slug>`, `/categories/<a>/<b>` carry the main host's resolve answer, their page's
  chunk closure (since the review: the page's own chunk only, at low priority — below) and a `preload as=fetch`
  of the page's first read (`/api/catalog/tree`, `/api/catalog/<slug>`);
  `/community` carries the resolve and `/api/community/access` (not the 32-file page closure: while the
  community is shut the gate never renders it — measured +0.19 s LCP with it, below).
- **The lead photo in both themes** (`leadImagePreloads`, `worker/lib/productOpeningLead.ts`): once per theme
  under the boot script's media query, exactly as Product.tsx renders it in that theme; with option- or
  colour-bound pictures only when the page's own answer (this colo's copy of `/api/products/<slug>`, no build)
  proves its opening selection empty.
- **Large rungs** (`clampRung`, `cutVariant`): `?w=1600` of a 1254 px picture is its `?w=1280` copy; a rung the
  binding will not encode in AVIF is cut in WebP at full size and kept in the AVIF place; the sweep no longer
  marks large photos unreadable; when no copy can be had the colo keeps the original under the copy's address
  for an hour instead of failing per request (since the review: never for a fixed-name picture — below).
- **The search dictionary** once per isolate for 30 s (`synonymsFor`), forgotten by its writers.

### Lab — the Worker in place (`wrangler dev --local` on the built dist, the catalogue seeded by `scripts/lib/e2e-catalog-only-seed.ts` with 1254 px main and light-theme photos and colour-bound pictures on half the products; Playwright 360×800 DPR 3, CPU ×4, Slow-4G 150 ms / 1.6 Mbps, light scheme, a cold context per visit with the HTTP cache on, median of 5; before = `0d8ed43b`, after = this lane)

| route | LCP before → after | FCP before → after | first page read done | lead image requested |
|---|---|---|---|---|
| `/categories` | 3216 → **3096** | 2076 → 2112 | 2457 → **989** (tree) | — |
| `/categories/printers` | 3936 → **3672** | 2124 → 2360 | 3090 → **1303** (`/api/catalog/printers`) | — |
| `/categories/printers/fdm-printers` | 4256 → **3684** | 2036 → 2148 | 3046 → **1219** (tree) | — |
| `/community` | 2404 → **2280** | 2032 → **1928** | 2325 → **948** (access) | — |
| `/product/bambu-lab-a1` | 3520 → **3320** | 2868 → **2732** | 1098 → 1101 | 3118 → **220** |
| `/product/bambu-lab-x2d` | 3468 → **3348** | 3004 → **2788** | 1093 → 1101 | 3234 → **205** |

No picture was downloaded twice (with the HTTP cache off — not how a phone loads — a preloaded picture was
sometimes fetched again; the skeptics saw the same harness artefact). The shell paints 36–236 ms later on the
category routes: their 24 modulepreloads share the link with the entry (the trade P2b measured and kept for
the product page). Fixed by the review below: the category documents now paint earlier than before. Locally D1 answers in milliseconds, so the lab shows only the removed round trips; on the
live site each removed step also carries its server time (resolve 0.2–1.1 s, the catalogue read 0.3–1.0 s on
a miss), which is where the audit's A/B measured −1.0 to −1.4 s on these category pages.

Stale serving in workerd (`wrangler dev --local`, `/api/products?limit=50`): miss 167 ms; fresh hit 20–61 ms;
at 72 s a late-fresh hit 69 ms (refreshed behind it: Age 2 two seconds later); at 200 s the stale copy served
in 58 ms with `Age: 127` and rebuilt behind it (Age 3 three seconds later); the tree past its `s-maxage` is a
miss. Before the refresh waited one turn of the event loop, the stale copy left in 158–194 ms — no faster than
a build — because the rebuild shared the isolate's thread with the answer on its way out.

Search (the wave-counting adapter on the real listing route, `tests/searchSynonymsMemo.test.ts`): a warm
isolate answers a keystroke in 4 dependent D1 waves instead of 5 (16 → 15 statements).

### Tests

New: `tests/edgeStaleWhileRevalidate.test.ts` (10), `tests/mainOpeningDocuments.test.ts` (7),
`tests/imageVariantFallback.test.ts` (7), `tests/productLeadPreload.test.ts` (6), `tests/searchSynonymsMemo.test.ts`
(3). Changed: `tests/documentPreloads.test.ts` (the light-image case now preloads both themes; a source pin),
`tests/imageVariants.test.ts` (1600 of a 1254 px picture is kept as its 1280 copy; a failed cut says
`X-Variant-Source: original`), `tests/securityPolicy.test.ts` (the run_worker_first revisit),
`tests/leakAudit_cache-headers_accessory_buying_cost_anon_edge_cached_and_exempted.test.ts` (the stored copy is
public for its declared window), `tests/fixtures/imageDoubles.ts` (the binding's AVIF ceiling).

### Not changed, and why

- `/api/bundles` stays uncached (both skeptics: an empty 49-byte list off the LCP path, +0.05–0.1 s).
- The listing read of `/categories/<a>/<b>` is not preloaded: its URL needs the section id, a D1 lookup on the
  document's own path (the skeptics measured 0–0.26 s for it). The `/categories` photo pool is not preloaded
  either: the category lane may stop the banner waiting on it, and an unused preload costs 27 KB on the link.
- The chunk cap stays 24 (CategoryPage's closure is 28, CategoryListing's 26). The category documents no longer
  name the closure at all (review fixes below).
- Search answers are not trimmed here (the slim card is the payload lane's), and the vocabulary and postings
  reads are not merged (a one-letter prefix range is about a tenth of the index at 1,115 products).

### Review fixes (2026-10-17)

Six findings of the lane's review, each upheld by two skeptics, each fixed with a test that fails without it.

- **The background refresh never frames a visitor** (high). The replay carried the visitor's
  `CF-Connecting-IP` and no `Sec-Fetch-*` header, so the deception gate read it as a TOOL presenting the
  visitor's URL: a planted link with trap data, kept at the edge, got the next visitor's carrier address a
  24 h network block, a device block and an owner alert on every refresh. The replay now carries no address
  and the gate lets this isolate's own refresh requests (`isEdgeRefresh`, a WeakSet nothing outside can
  forge) through untouched; the visitor's request that caused it was gated already. Pinned in
  `tests/deceptionCanary.test.ts` («NEVER FRAMED, WITH THE EDGE CACHE») and `tests/edgeStaleWhileRevalidate.test.ts`.
- **One odd `Accept` header no longer decides a colo's copy** (medium, and the low «`*/*` re-cut»). An asker
  naming AVIF but not WebP was refused the WebP kept in the AVIF place, cut without the WebP fallback, failed,
  and left the ORIGINAL under the shared AVIF edge address for an hour for every browser in that colo; a
  `*/*` asker (a crawler) was refused a WebP copy in its own WebP place and cut it again. Every browser that
  decodes AVIF decodes WebP and the edge entry is shared by format, so the kept copy is now every asker's and
  every AVIF cut may fall back to WebP (`cutVariant` lost its `webpFallback` switch).
- **A fixed-name picture whose cut fails keeps its own five minutes** (medium). The original kept under the
  copy's address for an hour also applied to brands/, ui/, services/ and link cards, which are rewritten in
  place with nothing purging the copy's address: a replaced logo stayed old for up to an hour instead of
  5 min. Such a key leaves with its own `public, max-age=300, must-revalidate` and nothing is kept at the
  copy's address. Not changed: an immutable picture whose cut fails still keeps the original an hour per colo
  (a transient binding error cannot be told from the picture's own — both are an HTTP error or a throw —
  and an immutable key risks no staleness, only the original's weight for that hour).
- **The category documents name their page's own chunk only, at low priority** (low: «category pages paint
  their first frame up to 236 ms later»). The closure's 24 modulepreloads shared the Slow-4G link with the
  entry. Named alone at default priority the page's chunk still painted `/categories/printers` 64 and 116 ms later
  than before in two of three runs; at `fetchpriority="low"` it yields the link to the entry and the first read, and every
  route paints both earlier than before. `/products` keeps its whole closure at default priority (P2b).
- **Two behaviours got their tests** (low): the tree purge marker (`purgeCatalogTreeCache` retires a rebuild
  that read the map before a taxonomy write) and `prepareTaxonomy`'s `forgetSearchSynonyms` (the import's
  words are found on the next search in its isolate, not after 30 s).

Lab (same set-up as above; interleaved, one `wrangler dev` per arm, the order rotated each run). Medians of
14 (two quiet runs of 7); «closure» is the lane before the review, from a third run of 7 against its own
«before» (2132 / 2064 / 2144 FCP there):

| route | FCP before → closure → own chunk → **own chunk, low** | LCP before → own chunk → **own chunk, low** | first read done before → after |
|---|---|---|---|
| `/categories` | 2084 → 2172 → 2014 → **2004** | 3212 → 3190 → **3114** | 2855 → 993 |
| `/categories/printers` | 2108 → 2316 → 2064 → **2026** | 4248 → 3930 → **3756** | 3481 → 1091 |
| `/categories/printers/fdm-printers` | 2064 → 2284 → 2002 → **1958** | 4276 → 4046 → **3942** | 3321 → 990 |

## 2026-10-19 — the listing pages every candidate (branch feat/listing-paging on b8233ee3)

The owner: customers must be able to browse ALL products. `GET /api/products?brand=bambu-lab` answered
`total: 300, truncated: true` for ~1,100 products, because every listing request put its first 300 candidates
(catalog-only ones included) through the pricing path and paged in memory.

**What changed** (`worker/routes/products.ts` `pagedListing`): a browse listing (a section, a brand, the whole
shop, `type=featured|discounted|preorder`; not a search, not `type=bundle`) reads every candidate's KEYS first
(id, name, date, brand, the sellable flag — no price) in the shelf order made total by the id, then resolves only
what it must:

| request | resolved |
|---|---|
| newest / name, stored-key filters (brand, fits, specs), no counts | the page (24) |
| relevance / price / available / direct, a price or stock filter, or the counts | the sellable candidates (≤ `LISTING_CANDIDATE_CAP` = 1,000, shelf order) + the page's catalog-only cards |

A catalog-only candidate is never priced to be ordered or counted: its listing item is exact from its keys
(DECISIONS row 240: no price, no stock, no sale type), so which catalog-only cards are on the page is known before
anything is priced. Past the cap nothing is hidden: the rest follow in the shelf order and `truncated: true` says
so. The row read leaves out the long text no card carries (descriptions, guides, content blocks, spec groups,
translation memory — the columns learned from the isolate's first whole row, no PRAGMA). The offers and the
mystery-pool reads are one `json_each` statement each (they were 50-id chunks, a dependent wave per chunk).
The answer carries `has_more`; `page` (1-based) is read when `offset` is absent and keys the edge cache.

**Measured** — the real router over node:sqlite (`tests/fixtures/wavesD1.ts`, statements / dependent waves; ms is
the in-process handler, warm, median of 3; before = b8233ee3):

| world | request | before | after |
|---|---|---|---|
| 60 sellable + 1,140 catalog-only, one brand | `brand=…&facets=1` (page 1) | 30 / 9 · 228 ms · total 300, truncated | 15 / 2 · 133 ms · total 1,200 |
| | `sort=relevance&offset=24` («عرض المزيد») | 29 / 8 · 120 ms | 14 / 2 · 32 ms |
| | `sort=newest&offset=480` | 29 / 8 · 119 ms · **0 products** | 14 / 2 · 22 ms · 24 products |
| | `sort=price_asc&facets=1` | 30 / 9 · 149 ms | 15 / 2 · 91 ms |
| 1,000 sellable + 200 catalog-only | `brand=…&facets=1` | 30 / 9 · 215 ms · total 300 | 15 / 2 · 479 ms · total 1,200 |
| | `sort=price_asc&offset=24` | 29 / 8 · 97 ms | 14 / 2 · 216 ms |
| | `sort=newest&offset=480` | 29 / 8 · 104 ms · 0 products | 14 / 2 · 25 ms |
| live catalogue (14), `tests/d1Waves.test.ts` | facets page / relevance / price_asc+facets / newest | waves 5/5/7 · 4/4/6 · 4/4/7 · 3/3/6 (warm/cold/member), 16 · 15 · 15 · 14 statements | waves 3/3/4 · 3/3/4 · 2/2/4 · 2/2/4, the same statements |

The worst case — a thousand priced products under a price order — costs ~0.25 ms of CPU per sellable candidate
(the pricing path; the facet counts read each candidate's spec sheet once now, `tokensOf`), and two round trips
instead of eight or nine. Every other request prices 24 cards. The statements no longer grow with the
catalogue (`tests/listingPaging.test.ts`: the same count at 120 and 1,200 products).

**Client:** the truncated note says what it means now, in ar / en / ckb; «عرض المزيد» stops on `has_more: false`
(or a page that adds nothing) and otherwise counts down `total` to the last product.
