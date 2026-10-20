# Levo Reference Matrix (master spec §02)

**Study date:** 2026-10-19. **Levonis baseline:** `b8233ee3` (2026-10-18), read-only (grep and line ranges; "absent" means a bounded grep found nothing). **Spec:** the Levo master spec of 2026-10-19 (the Arabic master spec, kept outside the repository; §02 asks, per feature, for: reference, observed behaviour, evidence and date, what we adopt, what we will not copy, the local implementation, and licence or integration limits).

**Scope.** 17 references (Shopify Sidekick counted inside Shopify). Six were studied in depth (Shopify, MakerWorld/MakerLab, STLbuddy, Xometry, Sketchfab, Reddit) and ten at UX level (Etsy, Linear, Printables, Thangs, Discord, Circle, Behance, Pinterest, GitHub, iFixit). The 195 study rows are condensed here into 166 entries: rows from different references that describe the same Levo feature are merged into one entry with each reference's evidence kept separate.

**Per-study notes and raw evidence** (full row text, fetch logs, saved pages) are kept outside the repository. Each REA run is identified by its evidence id (`ev_…`) in the [REA usage log](#rea-usage-log) below.

**State of the «Levo» lines.** They describe the code at `b8233ee3`. Work landed since then (merchant approval enforcement, P1-02, Studio P1-09 and P1-10) is tracked per requirement in `docs/LEVO_ACCEPTANCE_MATRIX.md`; the companion map is `docs/LEVO_GAP_MAP.md` and the pushes are in `docs/LEVO_PLAN_PHASE1_2.md`.

## How to read an entry

Each entry header gives: **ID · feature — references · priority · master-spec phase**.

- **Observed**: what the reference does, as seen in the evidence. Nothing here is a claim about a reference's server, database or closed algorithm unless the evidence states it.
- **Evidence**: source and date, with a grade tag:
  - `[DOC]` official page or developer doc fetched directly on 2026-10-19;
  - `[REA-S]` REA static analysis of a shipped artifact (inert text, never executed; it shows what code exists, not that it runs);
  - `[REA-R]` REA runtime capture (screenshot);
  - `[CODE]` read from a public open-source tree (described, not copied);
  - `[WS]` WebSearch summary of a named official page that could not be fetched (secondary);
  - `[INF]` inferred, not observed.
- **Adopt**: the Levo behaviour we will build. This is an independent re-implementation.
- **Not copied**: brand, text, assets, code, numbers or policies we will not take.
- **Levo**: status today (**Present / Mostly present / Partial / Absent / Absent by design / Not adopted**), the files involved, the change, and the master-spec section.
- **Limits**: evidence limits, and licence or integration limits.

**Phase** = master-spec delivery phase: 1 foundation (images and multi-source requests, tenant isolation, KYC and merchant approval, single cart, Shopify-style admin and filters, Studio link and private project files); 2 first complete journey (medallion + names + organiser generators, template model, merchant capability profile, unified check/slice/price, approved offer, acceptance, Production Package, order and delivery); 3 rest of the tool and template library, materials and parts data, merchant comparison, plates and batches, reorder, BOM and assembly, Store Builder; 4 community, projects, versions, profiles, search, collections, reputation, events and rewards; 5 3D viewer, AR, device tests and server-side rendering; 6 self-hosted image-to-3D, geometric search, maintenance centre and contextual assistant, VR. Phase 0 is this study; phase 7 is the integration audit. "Later" means an owner decision is needed first.

## Ground rules applied to every row

1. Independent re-implementation only: no brand, wording, assets, fonts, geometry recipes or unlicensed code from any reference (§02). Open-source libraries are taken from their upstream package under their own licence, never lifted from a reference's bundle.
2. Observed and inferred are kept apart. Static presence of code does not prove a live feature.
3. No policy value (fee, commission, duration, threshold, surcharge, royalty, point value) is invented; each needs an owner decision (§01.13, §19, §22).
4. Every new read of a new table or column tolerates its absence (CLAUDE.md rule 2).
5. Every user-facing string ships in Arabic, English and real Sorani Kurdish; a `ckb` slot never carries the Arabic (DECISIONS row 183).
6. Security and file protection are not deferred to phase 5 (spec phase list).

## Coverage

| Reference | Rows | Levo areas | REA static | REA runtime | Main evidence | Blocked or not studied |
|---|---|---|---|---|---|---|
| Shopify + Sidekick | 27 (+57 in the earlier Shopify gap study) | A, H | ev_963caf97… (+ ev_8942f218… first study) | none (admin needs login) | shopify.dev, changelog.shopify.com, shopify.com/sidekick | help.shopify.com 403 bot interstitial → [WS] |
| MakerWorld + MakerLab | 29 | B, C, E, F | ev_e303bcef… on the open-source Bambu Studio web UI (proxy) | none | wiki.bambulab.com, blog.bambulab.com, makerworld.com sitemaps | every makerworld.com HTML page behind a Cloudflare challenge |
| STLbuddy | 25 | A, B, C, D, E | ev_f56c650f…, ev_a5f5e664… | ev_e2d62ffd…, ev_e94bae50… | public pages + 75 JS chunks | /backend and /api robots-disallowed; paid and AI tools not run |
| Xometry | 28 | B, C, D, F, H | ev_5535d0ff… (partial graph) | ev_2aa7d9bf… (blocked by Vercel checkpoint) | xometry.com pages, community.xometry.com KB | quoting app robots-excluded; help.xometry.eu Disallow: / |
| Sketchfab | 26 | D | ev_b940ef31… (official Viewer API client) | none | help.sketchfab.com | sketchfab.com and api.sketchfab.com behind AWS WAF challenge |
| Reddit | 27 | E, F | none | none | developers.reddit.com (Devvit docs), reddit-archive code | reddit.com refuses automated clients; help centre Cloudflare 403 → [WS] |
| Etsy | 5 | A | none | none | [WS] help pages | help.etsy.com 403, etsy.com captcha |
| Linear | 5 | F | none | none | linear.app/docs | none |
| Printables | 4 | B, E | none | none | help.prusa3d.com | printables.com Cloudflare 403 |
| Thangs | 3 | B, E | none | none | thangs.com pages | none |
| Discord | 2 | E | none | none | discord.com developer docs and blog | support.discord.com 403 |
| Circle | 4 | E | none | none | help.circle.so | none |
| Behance | 3 | E | none | none | [WS] | help.behance.net 403; www.behance.net robots disallow Claude agents |
| Pinterest | 2 | E | none | none | create.pinterest.com | help.pinterest.com robots disallow Claude agents |
| GitHub | 3 | E | none | none | docs.github.com | none |
| iFixit | 2 | G | none | none | one public guide page | /api robots-disallowed |

## Areas

- A. Merchant workspace and store builder (§06, §07, §08)
- B. Studio tools, templates, generators and pipeline (§10–§14, §25)
- C. Pricing, requests and manufacturing orders (§17–§20)
- D. 3D preview and protection (§15, §16)
- E. Community, projects, discussions and reputation (§04, §05, §22)
- F. Admin operations and moderation (§09)
- G. Maintenance guides (§23)
- H. AI assistant (§24)

Then: Adoption plan by phase, REA usage log, owner decisions and open Levonis questions.

---

## A. Merchant workspace and store builder (§06, §07, §08)

| ID | Feature | Reference | Levo today | P | Phase |
|---|---|---|---|---|---|
| A-01 | Host-owned strip that layouts cannot hide | Shopify | Partial | P1 | 1 |
| A-02 | Builder canvas: partial re-render, motion pauses on select | Shopify | Mostly present | P3 | 3 |
| A-03 | Undo, redo and save | Shopify | Present | P3 | 3 |
| A-04 | Scheduled publish and timed revert | Shopify | Partial | P2 | 3 |
| A-05 | Shareable draft preview | Shopify | Present (private by design) | P3 | only on request |
| A-06 | Templates per page type | Shopify | Absent by design | P3 | later |
| A-07 | Edit products from the canvas | Shopify | Absent | P2 | 3 |
| A-08 | Per-block surface variant | Shopify | Absent | P3 | 3 |
| A-09 | Analytics comparison periods | Shopify | Partial | P2 | 3 |
| A-10 | A definition for every metric | Shopify | Absent | P1 | 1 |
| A-11 | Named report library with CSV | Shopify | Partial | P2 | 3 |
| A-12 | Chart annotations from store events | Shopify | Absent | P2 | 3 |
| A-13 | Targets | Shopify | Absent | P3 | later |
| A-14 | Deterministic "what changed" lines | Shopify | Absent | P2 | 3 |
| A-15 | Filament and material stock states | Shopify | Partial | P2 | 3 |
| A-16 | Bulk stock edits detect concurrent changes | Shopify | Absent | P1 | 1 |
| A-17 | Bulk dry-run summary and hidden-field validation | Shopify | Partial | P2 | 1 |
| A-18 | Saved views | Shopify | Partial | P2 | 1 |
| A-19 | Customer segment presets | Shopify | Absent | P2 | 3 (owner) |
| A-20 | Typed buyer personalisation fields | Etsy | Absent | P1 | 2 |
| A-21 | Private service indicators | Etsy | Absent | P2 | 3 |
| A-22 | Saved replies and order-linked help requests | Etsy | Partial | P2 | 3 |
| A-23 | Review replies and rating edit lock | Etsy | Mostly present | P3 | 4 |
| A-24 | Setup checklist tied to approval states | Etsy | Partial | P2 | 1 |
| A-25 | Seller helpers: profit view, listing drafts | STLbuddy | Partial | P3 | 3 (AI 6) |

#### A-01 · Host-owned strip that store layouts cannot hide — Shopify · P1 · Phase 1
- **Observed:** Section files without presets cannot be added or removed in the theme editor. A section can be capped per template, holds at most 50 blocks, and a template or section group renders at most 25 sections. Presets are alphabetical, groupable and get an auto preview. A static section shares one instance everywhere.
- **Evidence:** [DOC] shopify.dev …/editor/integrate-sections-and-blocks, …/sections/section-schema, …/templates/json-templates, …/section-groups; fetched 2026-10-19.
- **Adopt:** A fixed host strip on every store page holding: report this store, delivery and return policy, account access, the real price. A `verify.ts` rule refuses any layout that would hide it. Keep Levo's per-type caps and page cap.
- **Not copied:** Liquid schema syntax, Shopify's 25/50 numbers, Dawn or Horizon code.
- **Levo:** Partial. Grouped picker with live preview and visible limits (`src/components/merchant/storeDesign/BlockPicker.tsx:1-8`); MAX_BLOCKS 40 (`packages/storeLayout/src/schema.ts:146`). Gap: no report-store action on the storefront (the ⋯ menu holds share and copy-link only, `src/pages/Storefront.tsx:830-895`); header variant `none` removes back and ⋯ (`storefront/StoreHeader.tsx:48`). Change: strip in `StoreRenderer.tsx` and `Storefront.tsx` reusing `community/social/ReportSheet.tsx`; rule in `packages/storeLayout/src/verify.ts`. §08 (price, warnings and report cannot be hidden). Ships with approval (the Shopify gap study Wave 1).
- **Limits:** Developer docs only. The Levo gap is a bounded grep; confirm with the owner that no other report path exists.

#### A-02 · Builder canvas: partial re-render, motion pauses on select — Shopify · P3 · Phase 3
- **Observed:** The theme editor re-renders only the changed section in the live DOM and emits bubbling, non-cancellable events (section load, unload, select, deselect, reorder; block select, deselect; inspector activate, deactivate). A selected section scrolls into view and stays visible (a slideshow pauses on the selected slide). `designMode`, `inspectMode` and `visualPreviewMode` flags let theme code behave differently in the editor.
- **Evidence:** [DOC] shopify.dev …/integrate-sections-and-blocks (2026-10-19).
- **Adopt:** Keep the same-renderer preview with no iframe; re-render only the changed block; pause carousels, countdowns and autoplay video while their block is selected; never fire analytics or speed beacons in preview.
- **Not copied:** The iframe and postMessage model (the CSP forbids framing; the Shopify gap study not_to_copy #2).
- **Levo:** Mostly present. The selected block scrolls into view and respects reduced motion (`PreviewCanvas.tsx:97-102`); the runtime has `mode: 'live' | 'preview'` (`storefront/runtime.tsx:58,116`). Add a `selected` prop to `storefront/blocks/Deals.tsx`, `FeaturedProducts.tsx`, `extra.tsx`. §08, Wave 5.
- **Limits:** Whether Levo carousels already pause was not checked at runtime.

#### A-03 · Undo, redo and save — Shopify · P3 · Phase 3
- **Observed:** Undo and redo apply only to unsaved changes and are lost after Save; shortcuts Ctrl/⌘+Z, Ctrl/⌘+Y, Ctrl+S or ⌘⇧S.
- **Evidence:** [WS] help.shopify.com …/theme-editor/features-overview (2026-10-19; direct fetch blocked).
- **Adopt:** Keep Levo's stronger model (autosave is not an undo boundary, keystrokes coalesce, 50 revisions). Add ⌘Y as a second redo. Say in the history tab that restoring a revision only replaces the draft.
- **Not copied:** Losing undo after save.
- **Levo:** Present. `StoreDesignPanel.tsx:184-196, 347-348`; `editorModel.ts:405-438`; 900 ms autosave with version fencing and 50 revisions (the Shopify gap study row 41). §08.
- **Limits:** Search summary only.

#### A-04 · Scheduled publish and timed revert — Shopify · P2 · Phase 3
- **Observed:** Rollouts (2026-06-05) schedule a whole theme to go live, swap temporarily and revert automatically, roll out to a percentage of visitors, or A/B test; the live theme is copied so it stays editable.
- **Evidence:** [DOC] changelog.shopify.com/posts/schedule-publish-and-a-b-test-new-themes-and-checkout-and-customer-account-configurations (2026-10-19).
- **Adopt:** Schedule a whole draft to publish (for Eid or Ramadan) with an optional "revert on" date that republishes the previous revision; both server-side by cron and audited; publishing stays refused until the store is approved (V3 E10).
- **Not copied:** A/B tests and percentage rollouts (visitor bucketing is ruled out by decision row 168; traffic is too low).
- **Levo:** Partial. Per-block schedule exists (`packages/storeLayout/src/schema.ts:46-56`); draft, publish and 50 revisions exist (`worker/routes/storeLayout.ts`, `storeDesign/flows.tsx:89-171`). Add `store_layout_schedules {revision, publish_at, revert_at}` and a worker cron; reads tolerate the table's absence. §08, Wave 5.
- **Limits:** Changelog only; not seen in the admin.

#### A-05 · Shareable draft preview — Shopify · P3 · only if the owner asks
- **Observed:** A merchant can create a link that lets others preview an unpublished theme.
- **Evidence:** [WS] help.shopify.com …/online-store/themes/adding-themes (2026-10-19).
- **Adopt:** Keep the draft owner-only. If sharing is ever needed (for example with a designer), a signed, expiring, view-only token with noindex and no-store, revocable from the builder.
- **Not copied:** An open preview URL anyone holding the link can view.
- **Levo:** Present, private by design: the QR opens the signed-in workspace and draft reads are `private, no-store` behind `requireStoreOwner` (`src/components/merchant/storeDesign/PreviewQr.tsx:1-17`). §08.
- **Limits:** Shopify link lifetime unknown.

#### A-06 · Templates per page type and shared section groups — Shopify · P3 · Later (owner decision)
- **Observed:** JSON templates per page type with alternates assignable per resource (at most 1,000 per theme); header, footer, aside and custom section groups shared by every template; contextual groups per market.
- **Evidence:** [DOC] shopify.dev …/json-templates, …/section-groups (2026-10-19).
- **Adopt:** Later only: an optional product-page layout from a small safe block set (gallery, specs and print capabilities, reviews, FAQ, delivery). Header and footer stay one shared setting.
- **Not copied:** The 1,000-template model and per-market groups (Levo stores are single-market).
- **Levo:** Absent by design: one store page with a flat block list and header/footer variants (`schema.ts:1-15, 28-34`); product pages are fixed. Needs schema v2 (S8/S9). §08.
- **Limits:** Merchant demand not measured.

#### A-07 · Edit products from the builder canvas — Shopify · P2 · Phase 3
- **Observed:** Since 2025-12-15 the theme editor creates and edits products, collections, markets and metaobjects through an overlay, and the preview updates at once.
- **Evidence:** [DOC] changelog …/create-and-edit-resources-directly-in-the-theme-editor (2026-10-19).
- **Adopt:** «عدّل هذا المنتج» on product-list and featured blocks opens the existing ProductEditorSheet over the builder; after save only that block refetches; an empty product block offers "add a product" through the same sheet.
- **Not copied:** Metaobject and market editing.
- **Levo:** Absent (the canvas only selects blocks; the Shopify gap study row 40). Sheet over `StoreDesignPanel.tsx` using `catalog/ProductEditorSheet.tsx`, then refresh `BlockData` (`packages/storeLayout/src/data.ts`). §08, §07. Wave 5.
- **Limits:** Changelog only.

#### A-08 · Per-block surface variant — Shopify · P3 · Phase 3
- **Observed:** Themes define colour schemes and each section picks one.
- **Evidence:** [INF] general Shopify knowledge, not verified on 2026-10-19.
- **Adopt:** A per-block enum `surface: inherit | alt`, where `alt` is the second safe surface of the chosen style family, with contrast checked in `verify.ts`. Still no colour picker.
- **Not copied:** Free hex colour schemes.
- **Levo:** Absent: closed token enums, one surface per page (`packages/storeLayout/src/tokens.ts:1-31`). §08, Wave 5.
- **Limits:** Not verified today.

#### A-09 · Analytics comparison periods — Shopify · P2 · Phase 3
- **Observed:** Metric cards can be added, removed, reordered, grouped and resized; date presets or a custom range; Compare to previous period, previous year, custom or none; a percentage change per card; target cards keep their own period.
- **Evidence:** [WS] help.shopify.com …/overview-dashboard, …/using-the-overview-dashboard (2026-10-19).
- **Adopt:** A "compare to" choice (previous period, same period last year, none). A delta appears only when the server returned a comparable figure. Simple mode keeps a fixed card set by stage (the Shopify gap study row 7); Advanced mode may show or hide cards but not resize them.
- **Not copied:** Resizable grids; a per-user metric picker in Simple mode.
- **Levo:** Partial: 7/30/90-day or custom ranges, previous-period deltas only when valid, no 0 for missing data (`src/components/merchant/shell/sections/AnalyticsSection.tsx:1-23`; `analytics/chartMath.ts` `periodDelta`). Add a `compare` parameter to GET /api/merchant/analytics/report. §07. Waves 3–4.
- **Limits:** Search summary.

#### A-10 · A definition for every metric — Shopify · P1 · Phase 1 (quick win)
- **Observed:** Shopify publishes a definition per metric (net sales = gross − discounts − sales reversals; gross = price × quantity before taxes, shipping, discounts and reversals; total adds taxes, duties, shipping, fees; AOV = (gross − discounts) / orders; "Returns" replaced by "sales reversals"). Chart annotations mark metric-definition changes.
- **Evidence:** [WS] help.shopify.com …/report-types/analytics-fields; [DOC] changelog …/annotations-bring-store-event-context-directly-to-your-analytics (2026-10-19).
- **Adopt:** A definitions registry: each metric gets a formula and a sentence on what counts and what is excluded, in ar, en and real ckb, shown in an ⓘ sheet on every tile and on a glossary page; definitions are versioned and a change is marked on charts. Levo's own metrics: gross, receivable after commission, cancellation rate, late orders, repeat-buyer rate, offer win rate.
- **Not copied:** Shopify wording; tax and duty metrics.
- **Levo:** Absent: one definition sentence exists, for visitors (`AnalyticsSection.tsx:279`). Add `src/components/merchant/analytics/definitions.ts` and the ⓘ on `src/components/ui/KpiTile.tsx`. §07 (every metric defined).
- **Limits:** Formulas from a search summary; Levo defines its own.

#### A-11 · Named report library with CSV export — Shopify · P2 · Phase 3
- **Observed:** Explorations: Sidekick turns a question into ShopifyQL, runs it and explains it; "Refine query"; hand-written queries. Since 2025-10-29 Sidekick draws bar, line and donut charts and exports CSV, JSONL, XML or Parquet.
- **Evidence:** [WS] help.shopify.com …/custom-reports/create-custom-explorations; [DOC] changelog …/sidekick-data-visualization-and-export-updates (2026-10-19).
- **Adopt:** A fixed library of named reports, each with a table and CSV: sales by product, governorate and coupon; cancellations and late orders; repeat buyers; offer win rate; template performance. CSV uses the `worker/lib/csv.ts` cap and the X-Truncated header.
- **Not copied:** A free-form query language or editor; Parquet, JSONL, XML.
- **Levo:** Partial: one report route; every chart has a table view (`src/components/merchant/analytics/report.ts:17-57`, `charts.tsx`); no export (the Shopify gap study row 27). §07. Wave 4.
- **Limits:** Explorations known from a search summary only.

#### A-12 · Chart annotations from store events — Shopify · P2 · Phase 3
- **Observed:** Automatic coloured markers for product published or unpublished; theme published, app installed or uninstalled; system events (data delays, metric-definition changes). Filterable by type; product events ranked by revenue.
- **Evidence:** [DOC] changelog …/annotations-bring-store-event-context-directly-to-your-analytics (2026-05-05; fetched 2026-10-19).
- **Adopt:** Markers on DailyChart from Levo's own events: layout publishes, product publish and hide, store paused or away, coupon start and end, days the beacon did not count. Each marker opens that day's list.
- **Not copied:** App-install events.
- **Levo:** Absent, but the sources exist: `store_layout_revisions`; audit events `merchant.product_created`, `merchant.products_bulk` (`worker/routes/merchantCatalog.ts:783, 824`). Add `annotations[]` to the report and markers in `analytics/charts.tsx`. §07, §24 (explain a change from real events). Wave 4.
- **Limits:** Changelog only.

#### A-13 · Targets — Shopify · P3 · Later
- **Observed:** A target is a metric, filter, period and goal; a gauge shows percent complete, current against target and days left; periods from a week to two years; a Target index.
- **Evidence:** [DOC] changelog …/set-and-track-targets-in-shopify-analytics (2026-04-27; fetched 2026-10-19).
- **Adopt:** An optional monthly goal for orders or gross sales, one card on Today in Advanced mode.
- **Not copied:** Dozens of target metrics; two-year horizons.
- **Levo:** Absent; would be prefs JSON in `merchant_workspace_prefs` (the Shopify gap study Wave 3). §07.
- **Limits:** Value for small print shops is inferred.

#### A-14 · Deterministic "what changed" lines — Shopify · P2 · Phase 3
- **Observed:** Daily insights over sales, sessions and fulfilment show the top 5 by business impact with badges; "See why" opens the report with Sidekick. Pulse shows up to 5 cited recommendations handed to Sidekick, only for stores with recent sales, and never changes the store without approval.
- **Evidence:** [DOC] changelog …/data-driven-insights-now-appear-on-your-analytics-dashboard (2026-04-28), …/proactive-business-recommendations-from-sidekick (2025-12-10), fetched 2026-10-19; [WS] help.shopify.com …/sidekick/pulse.
- **Adopt:** Computed lines such as «طلبات بغداد ارتفعت 40% مقارنة بالفترة السابقة». Each names its period, comparison and source, appears only above a minimum sample (for example 10 orders in each period), and links to the report. No generated prose.
- **Not copied:** AI-generated cards; "deep research" on market trends (the Shopify gap study not_to_copy #5).
- **Levo:** Absent. Build on `analytics/chartMath.ts` and AnalyticsSection. §07, §24 ("why are my sales lower?" must show a real comparison). Wave 4; any AI part later.
- **Limits:** Shopify's impact ranking is undocumented.

#### A-15 · Filament and material stock states — Shopify · P2 · Phase 3
- **Observed:** On hand = Committed + Unavailable + Available. Committed covers unfulfilled orders, draft orders and transfers ready to ship. Unavailable is split into damaged, quality control, safety stock and other. Incoming does not count until received. Reports use On hand from 2026-10-01.
- **Evidence:** [WS] help.shopify.com …/inventory/fundamentals/inventory-states and inventory reports (2026-10-19).
- **Adopt:** Per material and colour: available grams, grams reserved by accepted jobs and offers, unavailable grams (wet or damaged spool) with a reason. For products, show "reserved by open orders" only once stock-decrement timing is confirmed (the Shopify gap study row 36).
- **Not copied:** Incoming, transfers, purchase orders, multi-location (the Shopify gap study not_to_copy #9).
- **Levo:** Partial: `merchant_material_stock` stores only grams per material and colour (`migrations/0132_eligibility_capability_stock.sql:109-120`), read by `worker/routes/merchantPrinters.ts` and `worker/lib/printMatchingStore.ts`; product stock is one number. Add `reserved_g`, `unavailable_g` and a movement log. §07, §18. Wave 4C.
- **Limits:** Search summary; reservation semantics are an owner decision.

#### A-16 · Bulk stock edits detect concurrent changes — Shopify · P1 · Phase 1
- **Observed:** Since 2025-12-11 the bulk editor shows original and new values side by side (increases green, decreases red), explains that a new value overrides the old one, and opens an "inventory mismatch" dialog (Save suggested, Save original, Discard) when stock changed during the edit.
- **Evidence:** [DOC] changelog …/prevent-accidental-inventory-overwrite-in-bulk-editor (2026-10-19).
- **Adopt:** Bulk and quick stock edits send the expected `before` per item; the server updates only rows that still match and refuses the rest with STOCK_CHANGED and the current value; the UI shows before → after with a +/− sign as well as colour and offers: current plus delta, keep mine, discard.
- **Not copied:** Colour as the only signal; Shopify's dialog copy.
- **Levo:** Absent. Bulk `set_stock` writes one value to every selected product with no expected-value check, so the last write wins (`worker/routes/merchantCatalog.ts:690-699`; the previous value is read only for low-stock alerts, `:768-780`). Add `WHERE stock = ?expected` per id and a per-item result code (`CatalogManager.tsx:145-180`). §07 (safe bulk editing). Wave 4C.
- **Limits:** The concurrency risk is inferred from code, not observed in production.

#### A-17 · Bulk dry-run summary and hidden-field validation — Shopify · P2 · Phase 1
- **Observed:** The merchant picks visible columns; saving is blocked by invalid values even in hidden columns; large jobs are pointed to CSV; no product cap was found.
- **Evidence:** [WS] help.shopify.com …/productivity-tools/bulk-editing (2026-10-19).
- **Adopt:** A summary before any bulk price, state or stock commit («12 منتجاً: السعر 15,000 → 18,000؛ 3 منشورة لا يُسمح بسعر صفر لها»). A failing field that is not shown is added as a column with the reason next to the row.
- **Not copied:** A full spreadsheet editor (the Shopify gap study row 33 keeps price and stock cells, Advanced mode, desktop only).
- **Levo:** Partial: 1–100 ids per bulk action with per-item reasons (`catalog/catalogApi.ts:146-148`; `CatalogManager.tsx:145-180`); zero price refused on published products (`merchantCatalog.ts:637`). Add a dry-run mode to the bulk route. §07. Wave 4C.
- **Limits:** Search summary; cached pages may be old.

#### A-18 · Saved views — Shopify · P2 · Phase 1
- **Observed:** Since 2026-04-13 search, filter chips and saved views share one bar on Orders, Products, Customers, Discounts and Collections; a filter, column and sort setup saves as a named view; an edited view can be saved as new; Sidekick can open a filtered view. The All view cannot be changed; views update live; product views are desktop-only.
- **Evidence:** [DOC] changelog …/search-filter-and-saved-views-for-orders-products-and-more; [WS] help.shopify.com …/searching-orders, …/products/searching-filtering (2026-10-19).
- **Adopt:** Confirms the Shopify gap study row 12, plus: save as new view; edit without overwriting; views live in URL state so the ⌘K palette and a later assistant can open one by link; views can be created on a phone.
- **Not copied:** Desktop-only management; typed filter syntax.
- **Levo:** Partial: locked presets with count badges for orders, products and KYC; no custom views (`src/components/ui/DataList.tsx:82-105`). Prefs JSON in `merchant_workspace_prefs`. §07 (saved filters). Wave 4A.
- **Limits:** Staff sharing and view limits undocumented.

#### A-19 · Customer segment presets — Shopify · P2 · Phase 3 (owner decision for coupon eligibility)
- **Observed:** Segments are ShopifyQL queries with templates and autocomplete; the editor shows matching customers, total and percentage; "Use segment" emails subscribers; discounts accept up to 5 segments (automatic) or 100 (codes). Sidekick builds segments from plain language (2025-10-29).
- **Evidence:** [WS] help.shopify.com …/customer-segmentation and its create and manage pages; [DOC] changelog …/sidekick-data-visualization-and-export-updates (2026-10-19).
- **Adopt:** Fixed server-computed presets over the merchant's own customers only (first-time; returning 2+; lapsed over 60 days; by governorate; top 10% by spend) with count and percentage, usable as a customer-list filter and as coupon eligibility through an `eligible_segment` column checked at checkout.
- **Not copied:** The query language; email broadcasts (no consent model); browsing other merchants' customers.
- **Levo:** Absent: the customer list has search and paging; the report has new and returning counts (`analytics/report.ts:44`); `merchant_coupons` has no eligibility field (`migrations/0036_store_builder.sql:88-104`; `worker/routes/merchant.ts:2050-2075`). §07. Wave 4D.
- **Limits:** Coupon eligibility changes checkout money rules.

#### A-20 · Typed buyer personalisation fields — Etsy · P1 · Phase 2
- **Observed:** Shop Manager has an "Instructions for buyers" field and a "Personalisation is optional" checkbox; a beta allows several questions of new types; the API caps instructions at 120 characters (Etsy also called a 256 → 120 reference wrong); the answer is entered at purchase and travels with the order.
- **Evidence:** [WS] help.etsy.com/hc/en-us/articles/33478801738519, /360000344528; github.com/etsy/open-api discussion #1551 (2026-10-19). The page load was blocked (403 challenge).
- **Adopt:** A typed customer-input schema per product or template (text with max length, choice from a list, required or optional, instructions in ar/en/ckb), validated on the server at add-to-cart and frozen into the order-line snapshot.
- **Not copied:** Etsy wording, beta UI and limits. Free text never replaces §12 typed geometry variables.
- **Levo:** Absent: extend `community_product_options/variants` (migration 0126) or the §12 template variables with `personalization_fields` JSON; snapshot into `community_order_items`; UI on the product sheet and `src/components/merchant/orders/OrderDetailScreen.tsx`. §12, §07.
- **Limits:** Question types and the character limit are unconfirmed and conflict between sources.

#### A-21 · Private service indicators — Etsy · P2 · Phase 3
- **Observed:** Two tiers. Baseline: 80% of first messages answered within 24–48 h. Star Seller: 95% of first messages within 24 h, 95% of orders dispatched on time with tracking, average rating ≥ 4.8 over 3 months. Auto-replies count. Missing the standard may lower search visibility.
- **Evidence:** [WS] help.etsy.com/hc/articles/29654393638679; etsy.com/seller-handbook/article/476775452989 (2026-10-19; handbook load was a captcha 403).
- **Adopt:** Private per-merchant indicators (time to first reply, on-time dispatch, qualified rating) computed from real order and chat rows, each with a written definition and period, on the Today and attention screen.
- **Not copied:** The "Star Seller" name, badge and thresholds. No SLA, ranking penalty or public badge without an owner-approved policy (§09, §22).
- **Levo:** Absent: metrics in `worker/routes/merchantAnalytics.ts` and `/api/merchant/attention`, rendered in `src/components/merchant/shell/sections/CommandCenter.tsx`. §07, §22.
- **Limits:** Thresholds from snippets and third-party guides; ranking effect is closed.

#### A-22 · Saved replies and order-linked help requests — Etsy · P2 · Phase 3
- **Observed:** Saved replies (a third-party guide says up to 250 in 50 categories); an order sidebar in the conversation; later messages merge into one thread per buyer; a buyer's order-problem message is labelled "help request" in a separate section.
- **Evidence:** [WS] help.etsy.com/hc/articles/115015654988; community.etsy.com threads; erank and alura guides (2026-10-19).
- **Adopt:** Per-store saved replies (localised, categorised) inside the existing merchant inbox; order and request context beside the thread; a "help request" message type that opens or links a complaint case instead of a separate chat.
- **Not copied:** Etsy text; the thread-merge behaviour (a source of confusion in community threads).
- **Levo:** Partial: `worker/routes/merchantInbox.ts`, `src/components/merchant/inbox/MerchantInbox.tsx`, chat cards (0150), `community_complaints` in `adminCommunity.ts`. §07 (one message centre).
- **Limits:** Not observed directly; limits are third-party.

#### A-23 · Review replies and rating edit lock — Etsy · P3 · Phase 4
- **Observed:** Since 2022 sellers can reply publicly to every review; once the seller replies, the buyer cannot change the rating without Etsy Support; replies do not count toward response metrics.
- **Evidence:** [WS] community.etsy.com announcement "Responding to reviews with three or more stars"; ecommercebytes 2022-04-09 (2026-10-19).
- **Adopt:** One merchant reply per review; edit history, or a rating freeze after a reply, with an appeal; reviews stay tied to completed orders.
- **Not copied:** Etsy policy text. Levo keeps its own 24 h edit rule unless the owner decides otherwise.
- **Levo:** Mostly present: `merchant_reviews.merchant_reply` (0031); `worker/routes/merchantReviews.ts:301-347` (24 h window, `edited_count`, append-only log). Missing: the reply-lock decision and an appeal in the §09 queue. §22, §07.
- **Limits:** The rule may have changed since 2022.

#### A-24 · Setup checklist tied to approval states — Etsy · P2 · Phase 1
- **Observed:** Not observed (Etsy blocked). Etsy opens a shop through a staged wizard (preferences, name, first listings, payments, billing, security) and does not open it until the required steps are done.
- **Evidence:** [INF] general product knowledge; help.etsy.com and etsy.com returned 403 (fetch log 13:50:17, 13:52:47).
- **Adopt:** Split the checklist into "required for review and approval" and "recommended"; link each step to its screen and to the §06 states (draft, under review, needs completion, approved, rejected, suspended).
- **Not copied:** Etsy step names and flow.
- **Levo:** Partial: `setupSteps()` in `src/components/merchant/shell/sections/CommandCenter.tsx:73` (logo, banner, about, phone, delivery, products, design); approval state in `merchantApplication.ts` and `adminMerchantApplications.ts` (0204). §06, §07.
- **Limits:** No current observation.

#### A-25 · Seller helpers: profit view and listing drafts — STLbuddy · P3 · Phase 3 (AI part phase 6)
- **Observed:** Free Etsy Profit Calculator and Business Planner (`/api/business-planner`); AI Etsy Listing Generator (5 credits per listing) and Listing Photo Enhancer (7 credits per image); a "vendor opportunity finder" alias; the cost-calculator page says marketplace fees and shipping eat 25–35% of revenue.
- **Evidence:** [DOC] stlbuddy.com/pricing, /3d-calc (2026-10-19); [REA-S] ev_a5f5e664… chunk 9072 registry, 18727/23701 alias maps.
- **Adopt:** A per-product profit view using Levo commission and delivery rules; an AI listing draft in ar/en/ckb that is always editable and never auto-published; product-photo cleanup only with consent; all tied to existing merchant costing.
- **Not copied:** Etsy fee logic, copy, credit pricing.
- **Levo:** Partial: `src/components/merchant/workshop/CostingSheet.tsx`, dashboard CostingTab; AI parts follow §24. §07, §24.
- **Limits:** Not exercised; AI providers unknown.

---

## B. Studio tools, templates, generators and pipeline (§10–§14, §25)

| ID | Feature | References | Levo today | P | Phase |
|---|---|---|---|---|---|
| B-01 | Outcome-named tool library from one registry | STLbuddy, MakerLab | Absent | P1 | 2 (rest 3) |
| B-02 | Studio tool shell: step rail, progressive disclosure | STLbuddy | Absent | P1 | 2 |
| B-03 | Generator engine: manifold-3d in a worker, hashed results | STLbuddy | Absent | P1 | 2 |
| B-04 | Text-to-solid with Arabic and Sorani shaping | STLbuddy | Absent | P1 | 2 |
| B-05 | Name, letter sign and nameplate generator | STLbuddy, MakerLab | Absent | P1 | 2 |
| B-06 | Image to medallion, coaster, charm | STLbuddy, MakerLab | Absent | P1 | 2 |
| B-07 | Organiser by dimensions | STLbuddy, MakerLab | Absent | P1 | 2 |
| B-08 | Lithophane with frame and light kit | MakerLab, STLbuddy | Absent | P1 | 3 |
| B-09 | Fit clearance and calibration coupons | STLbuddy | Absent | P2 | 2 (coupons 3) |
| B-10 | Mechanism templates with locked regions | STLbuddy | Absent | P3 | 3 |
| B-11 | Parametric customiser on the project page | MakerWorld | Absent | P1 | 2 (schema) / 4 (page) |
| B-12 | Output matrix: assembled or separate × STL or colour 3MF | STLbuddy | Partial | P2 | 3 |
| B-13 | Model splitter: cuts, pins, corrections list | STLbuddy | Partial | P1 | 3 |
| B-14 | Modify tools on owned or licensed files | STLbuddy | Absent | P2 | 3 |
| B-15 | Printability gate and DFM feedback | STLbuddy, Xometry | Partial | P1 | 2 |
| B-16 | Server-side profile validation per printer | MakerWorld | Partial | P1 | 2 |
| B-17 | Per-file pipeline states | Xometry | Partial | P1 | 1 |
| B-18 | Local-first drafts that survive sign-in | STLbuddy | Mostly present | P1 | 1 |
| B-19 | Tool → Studio handoff and trusted "open in Studio" links | MakerWorld (Bambu Studio), Printables | Partial | P1 | 1 |
| B-20 | "Price this" from Studio; upload before login | Xometry | Partial | P3 | 1 |
| B-21 | Publishing to MakerWorld (honest handoff) | MakerWorld | Present | P2 | — |
| B-22 | Template display modes and designer licences | STLbuddy, Thangs | Absent | P1 | 2 |
| B-23 | Template-to-sale lifecycle with approvals | Thangs | Partial | P2 | 2 |
| B-24 | Image or video to 3D as background jobs | MakerLab, STLbuddy | Absent | P2 | 6 |
| B-25 | Failure report that keeps the work | STLbuddy | Partial | P2 | 2 |

#### B-01 · Outcome-named tool library from one registry — STLbuddy, MakerLab · P1 · Phase 2 (first set), 3 (rest)
- **Observed:** STLbuddy ships a client registry of 66 tools (id, name, href, tier, category, description, status, `acceptsImageAsset`, beta flags; 19 free, 15 tinkerer, 26 maker, 6 inventor; 27 accept an image) plus a second map of purposes, input kinds, aliases ("STL splitter", "cut model", "name sign") and use cases ("fit a model on my printer"). /tools filters by purpose, tier, free, saved and recent; legacy slugs are aliased. MakerLab lists about 19 tools named by outcome (Make My Sign, Make My Lithophane, Image to Keychain, Parametric Bento Tray Generator, AI Scanner …) and an "Experiments" area; the Bambu Studio home fetches the list (thumbnail, link, localised name, description, author) from an operations endpoint every 6 h; opening a tool requires login.
- **Evidence:** [REA-S] ev_a5f5e664… chunks `9072-41ed9898743d31a0.js`, `25591-98f50ce5880f174f.js`; [DOC] stlbuddy.com/, /tools (2026-10-19); the extracted tool registry. [DOC] wiki.bambulab.com exclusive-model-guideline; blog.bambulab.com/new-launch-of-makerlab-experiments; [REA-S][CODE] ev_e303bcef… `test.js` Test_MakerlabList, `WebViewDialog.cpp` get_makerlab_list.
- **Adopt:** One typed registry served by the Worker (`/api/tools`): outcome, input kind (text, image, model, blank), purpose group, ar/en/ckb aliases for smart search, honest status (available, beta, experimental), template or generator id, and a real licensed example per card. The hub, search and the Studio home all read this list, so a tool never exists only as a card (§11).
- **Not copied:** Tool names, poster images, category wording, tier names, the MakerLab catalogue; brand-name tools (Bath & Body Works, Bogg, Mandalorian, Pokemon).
- **Levo:** Absent: `src/pages/Tools.tsx` is only the quote flow; no generators exist in `src/` or `studio/app` (no `studio/app/generators`). New `worker/lib/tools/registry.ts` and `/api/tools`; aliases fed into unified search (smart search and assistant lane). §11, §12.
- **Limits:** Registries are client data and change at any time; discovery ranking not observed; MakerLab tool inputs not observed (Cloudflare challenge).

#### B-02 · Studio tool shell: step rail and progressive disclosure — STLbuddy · P1 · Phase 2
- **Observed:** Name Maker has a rail Design → Fit & parts → Finish; Modular Storage has Layout → Edit → Style → Print & fit with "Next: …" calls to action; "Advanced layout" and "Advanced manufacturing" are collapsed; a sticky footer shows readiness ("Ready to export", "6 modules · 10 sliding connections"); undo, redo and New sit in the header.
- **Evidence:** [REA-R] SHOT-MSB ev_e94bae50…, SHOT-NM ev_e2d62ffd…; [REA-S] ev_a5f5e664… chunk 19140.
- **Adopt:** One shell for every generator: numbered steps (create → adjust → check → order or export), an advanced group hidden by default, a persistent readiness line, undo and redo, and a call to action that names the next step. RTL-first and usable at 390 px. This is §10's "a beginner does not see every slicer setting at once".
- **Not copied:** Step names, icons, colours, microcopy.
- **Levo:** Absent: `studio/app/components/tool-shell/*`; strings in `studio/app/i18n` (ar/en/ckb). §10, §11.
- **Limits:** Only the first screen of each tool was seen; the mobile layout was not captured (1280 px viewport).

#### B-03 · Generator engine: manifold-3d in a worker, hashed results — STLbuddy · P1 · Phase 2
- **Observed:** Name Maker and Modular Storage generate geometry in dedicated Web Workers that import manifold-3d (Emscripten glue and a `.wasm` binary) and use CrossSection with NonZero fill, extrude, offset with round joins, simplify, union, subtract, intersect and getMesh. Workers report init and elapsed times; a request id discards stale results; a timeout message says the design was kept.
- **Evidence:** [REA-S] ev_a5f5e664… `worker/60919…js` (glue and .wasm URL), `68732…js`, `35739…js`, `20241…js`.
- **Adopt:** manifold-3d (Apache-2.0, compatible with Studio's AGPL-3.0) from its upstream npm package in a Studio worker for Levonis-owned public generators: stale-request guard, timeouts that keep state, performance telemetry, and `generator_version + parameter_hash + output_hash` on every result (§12). Merchant-private templates whose generator would reveal the source run server-side in a sandbox (no network, memory and time caps).
- **Not copied:** STLbuddy worker code, geometry recipes, parameter tunings. The library is never lifted from their bundle; record it in `studio/OPEN_SOURCE_NOTICES.md`.
- **Levo:** Absent: `studio/app/generators/engine.worker.ts` with a pinned manifold-3d; server twin for private templates. §12, §14.
- **Limits:** Library identity inferred from API names and glue path (high confidence); version not found; .wasm not downloaded.

#### B-04 · Text-to-solid with Arabic and Sorani shaping — STLbuddy · P1 · Phase 2
- **Observed:** Fonts are parsed with opentype.js (MIT); glyph commands become polygons, then a NonZero cross-section fitted and scaled to a target box. Some display fonts ship as pre-baked outline JSON (a 5.2 MB "Pokemon Classic" chunk). 31 fonts: OFL faces (Lobster, Pacifico, Bungee, Cherry Bomb One …) and custom "Buddy*", "KawaiiCat" and "Pokemon*" faces; `/api/font-fallback/` exists. No Arabic font is offered.
- **Evidence:** [REA-S] ev_a5f5e664… `worker/63628…js`, `15361…js`, `18932…js`, `55571…js`.
- **Adopt:** The same pipeline shape (font → outline polygons → 2D boolean and offset → extrude), shaped with HarfBuzz (harfbuzzjs, MIT) so Arabic and Sorani get correct joining, ligatures, harakat and RTL order; licence-reviewed OFL Arabic fonts (for example Noto Kufi or Naskh Arabic, Amiri, Cairo) with per-font checks for embedding and geometry generation; island and dot detection that warns or bridges to the base (§11.2).
- **Not copied:** Their fonts (especially the trademark-derived "Pokemon*" and custom "Buddy*" faces) and outline JSON.
- **Levo:** Absent: `studio/app/generators/text/` and a font registry with licence fields, admin-approved. §11.2, §12.
- **Limits:** HarfBuzz is our design choice, not an observation.

#### B-05 · Name, letter sign and nameplate generator — STLbuddy, MakerLab · P1 · Phase 2
- **Observed:** STLbuddy Name Maker: large letter and font picker (each font shown in its own face); letter height 20–460 mm (step 0.1, slider plus mm field); thickness 2–138 mm; name text and font, optional second name; outline width ("a wider outline helps connect the name's letters into a single piece"); raised text and insertion depth; fit clearance 0–1 mm, step 0.05 ("start at 0.2 mm"); rotation, scale, stand; per-part colours; "All dimensions are the final printed size"; status "2 printable parts ready". MakerLab Make My Sign ("name plate, badge, sign, light box, anything flat") embeds the template and assets in the exported 3MF so others can reopen and personalise a shared creation; basic Image to Keychain is free [WS].
- **Evidence:** [REA-S] ev_a5f5e664… chunk 20241; [REA-R] SHOT-NM ev_e2d62ffd…; [REA-S] ev_e303bcef… Test_MakerlabList; [DOC] MakerWorld release note RN 20240311 #2 (2026-10-19).
- **Adopt:** The Arabic/English name and door sign as the first generator on the §12 schema (type, unit, min, max, step, default, hint). Every number is a slider plus an exact field; the final printed size is shown; a fit-clearance variable has a recommended start; Arabic shaping, connection and dot checks apply (§11.2). Generator parameters and asset references are saved in the project, so a published result offers "make your own".
- **Not copied:** Font set, defaults, layout, styles, the internal ×2.3 scale quirk, MakerLab templates.
- **Levo:** Absent: Studio generator `nameSign` on §12 variables, priced through `worker/lib/printQuote`; `studio/app/project-store.ts` keeps generator metadata. §11.2, §12. Phase 2 names this generator.
- **Limits:** Ranges read from minified code; server checks invisible; neither reference supports Arabic.

#### B-06 · Image to medallion, coaster or charm — STLbuddy, MakerLab · P1 · Phase 2
- **Observed:** 27 STLbuddy tools take an image: coaster (flat or raised colours, backing, border lip), ornament (outline or round, movable loop, per-colour heights), charm (string hole), magnet, earrings, candle holder (painted, single or separated colour files), a bathroom organiser from a photo, lithophane, SVG to STL. Sample SVGs are bundled; one image library is reused across tools; 0-byte or >100 MB images are rejected.
- **Evidence:** [REA-S] ev_a5f5e664… 9072 registry descriptions, `63788…js`, 83952; [DOC] stlbuddy.com/ (2026-10-19).
- **Adopt:** The §11.1 medallion or logo generator: safe image and SVG intake (server-side SVG sanitising, size limits, §14) → crop and background removal → colour-reduction preview → colour regions as separate parts or height layers; drag to place a loop or hole; warnings for islands and fine detail; the price changes with size, count and colours; one private image library per account.
- **Not copied:** Sample art, vectorisation tuning, brand-holder shapes.
- **Levo:** Absent: Studio generator `medallion` plus a shared intake service feeding the B-03 worker. §11.1, §11.10, §14. Phase 2 names the medallion.
- **Limits:** The vectorisation engine was not identified (tool chunks not fetched).

#### B-07 · Organiser by dimensions — STLbuddy, MakerLab · P1 · Phase 2
- **Observed:** STLbuddy Modular Storage: mm/in toggle; columns stepper; split and merge cells (Shift+click); compartment types (cubby, drawer, tray, shelf, open top) dragged onto slots; an "Edit in 3D" panel with W/H/D in mm; dividers, pulls, sliding rails with a housing minimum ("at least 7.2 mm of stock for sliding channels"); bed keep-out zones; tip-over warning; a confirmation "Keep module sizes · grow layout" vs "Keep overall size · resize tracks"; housing readout "240.4 × 120 × 120.2 mm W×D×H nominal"; field validation; "Download print files — free · Account required · STL + 3MF + assembly guide". MakerLab offers a Parametric Bento Tray, Make My Vase (width, height, thickness, cross-section, body shape [WS]) and ParamaCraft lite.
- **Evidence:** [REA-R] SHOT-MSB ev_e94bae50…; [REA-S] ev_a5f5e664… chunks 19140, 91358, 35739; [DOC] stlbuddy.com/modular-storage-builder, wiki exclusive-model-guideline, blog …makerlab-experiments (2026-10-19); [WS] third-party vase guide.
- **Adopt:** The §11.5 organiser: inner, outer and nominal sizes in the displayed unit; grid split and merge in 2D and 3D; typed compartments; wall and rail minimums enforced by the schema; an explicit choice when a change would resize others; tip-over and bed-fit warnings. Dimensions are never inferred from a photo of a drawer.
- **Not copied:** Module geometry, rail profile, handles, palette, copy.
- **Levo:** Absent: Studio generator `organizer` on §12 (variables with unit, min, max, requires and forbids); plate layout via `studio/app/plate-packing.ts`; priced via printQuote. §11.5, §12. Phase 2 names the organiser template.
- **Limits:** Nothing past the first screen was exercised; drag behaviour inferred from strings; 3D canvas blank in headless capture.

#### B-08 · Lithophane with frame and light kit — MakerLab, STLbuddy · P1 · Phase 3
- **Observed:** Make My Lithophane: choose type (mono or colour, fixed frame) → image → orientation, scale, rotation → colour and light → preview. Download asks for printer and nozzle (0.2 mm recommended); generation takes minutes; the 3MF includes the frame and light-guide plate; the tool is tied to a CMYK filament bundle and an LED backlight kit sold in the store, and is also in the mobile app. STLbuddy lists a free Lithophane Maker (lamps, layered colour).
- **Evidence:** [DOC] wiki.bambulab.com/en/knowledge-sharing/CMYK-color-lithophane-printing-instructions (2026-10-19); [REA-S] ev_a5f5e664… 9072.
- **Adopt:** A template-driven lithophane with a frame (§11.3): approximate backlight preview, output containing every part, an honest generation-time message, and a BOM offering the LED kit and filaments from Levonis merchants (C-15).
- **Not copied:** The CMYK colour-separation algorithm; frame designs.
- **Levo:** Absent. §11.3, §15.
- **Limits:** Algorithm closed; only the flow was observed.

#### B-09 · Fit clearance and calibration coupons — STLbuddy · P2 · Phase 2 (coupons phase 3)
- **Observed:** Name Maker: per-side clearance 0–1 mm ("start at 0.2 mm; increase for an easier fit") with a cavity view. Modular Storage offers calibration pieces ("six clearances, dual rails and a full-depth pair; engraved digits show hundredths of a millimetre"); presets Tight, Normal, Loose; `print-notes.txt` records profile id and version plus clearance.
- **Evidence:** [REA-S] ev_a5f5e664… 20241, 19140, 35739.
- **Adopt:** A schema variable class `clearance`: per-side value, a named preset bound to a value tested by a merchant on a material, and an optional calibration coupon generated alongside. The tested profile id and version go into the Production Package (§11.7, §11.8).
- **Not copied:** Coupon geometry and numeric presets; Levonis values come from merchants' tested materials.
- **Levo:** Absent: §12 field kind and a calibration-part generator; values supplied by the merchant capability profile (§18). §11.7, §11.8, §12.
- **Limits:** Preset values not extracted.

#### B-10 · Mechanism templates with locked regions — STLbuddy · P3 · Phase 3
- **Observed:** Clicker Factory, Letter & Character Clickers (55 designs), Sliding Fidget, Flexi Maker, Bolt Factory (bolts with matching nuts, free), Bracket Maker, Hinged Box Maker (compartments in base and lid), Evil Box, Marble Machine.
- **Evidence:** [REA-S] ev_a5f5e664… 9072 registry; [DOC] stlbuddy.com/pricing (2026-10-19).
- **Adopt:** Mechanism templates bind a switch, loop, magnet or screw to a catalogued part with tested interfaces and tolerances; visual customisation cannot change the locked mechanism zone (§11.7, §11.8); thread generators say "non-structural" and need review for load-bearing use.
- **Not copied:** Mechanism geometry; character designs.
- **Levo:** Absent: §12 "locked regions" and catalogue-part references; `worker/lib/printAccessories.ts` already models magnets, LEDs and rings. §11.7, §11.8, §12.
- **Limits:** Inventory only; no geometry inspected.

#### B-11 · Parametric customiser on the project page — MakerWorld · P1 · Phase 2 (schema), 4 (project page)
- **Observed:** Parametric Model Maker moved from MakerLab onto the model page. The creator's OpenSCAD script is validated at upload; the creator previews and tweaks; users press Customize and keep a per-user configuration history; a "Customizable" search filter exists; customised downloads are counted.
- **Evidence:** [DOC] MakerWorld release notes RN 20240510 #2, RN 20240628 #2–#3 (wiki, 2026-10-19).
- **Adopt:** A template is a declarative parameter schema (type, unit, min, max, default, constraints) plus a generator version. "Customise" sits on the project page; each user's saved configurations carry `parameter_hash` and `output_hash`; generation runs in a server sandbox when the source is protected; a "customisable" filter.
- **Not copied:** The UI; creators' scripts without a licence. OpenSCAD is GPL and would run only as a separate process if ever adopted.
- **Levo:** Absent: §12 template tables and a worker generation job, previewed in Studio; generator code stays out of the customer's browser for protected sources (§12, §16).
- **Limits:** Whether MakerWorld runs this in the browser or on the server is unknown.

#### B-12 · Output matrix: assembled or separate × STL or colour 3MF — STLbuddy · P2 · Phase 3
- **Observed:** Name Maker downloads: Assembled STL, Assembled colour 3MF, Separate parts STL ZIP, Separate parts colour 3MF ZIP ("Color 3MF keeps these assignments"). The 3MF is written client-side as a Bambu-style project (model file, project settings with filament colours, model settings with per-part assignments); one writer's Application metadata claims "BambuStudio-02.04.00.70"; JSZip DEFLATE level 6; the filename comes from the name text.
- **Evidence:** [REA-S] ev_a5f5e664… `20241…js`, `21966-…js`, `33479…js`, `85115-…js`.
- **Adopt:** The two axes for allowed downloads. For orders the colour-assigned 3MF is the production artefact (C-22). Producer metadata states Levonis honestly.
- **Not copied:** Claiming another application's identity in metadata.
- **Levo:** Partial: `studio/app/bambu-project-3mf.ts` already wraps Bambu's project grammar with an honest producer; add a "separate parts ZIP" in `export-manager.ts`; downloads follow the template display mode (§12). §12, §14.
- **Limits:** Whether the colour 3MF opens with correct assignments in Bambu Studio was not tested.

#### B-13 · Model splitter: cuts, pins and a corrections list — STLbuddy · P1 · Phase 3
- **Observed:** STL or OBJ processed on device ("your model stays on your device") with limits of 100 MB, 1,000,000 triangles and 240 s; sample models; small auto-repair. Straight cuts drawn across the model; curved seams with spline points; automatic alignment pin and socket (size, shape, swap side; shrunk automatically to keep parts connected); contour cutouts of 3–64 points, at most 16. Preview split → exploded view → "Parts needing correction" → STL ZIP that keeps real scale. A 256 × 256 mm bed warning; a disclaimer that cuts may need repair and pin fits need testing. Engine: three-bvh-csg and three-mesh-bvh in a worker, with a lazily loaded precise evaluator.
- **Evidence:** [REA-S] ev_a5f5e664… model-splitter page chunk (limits object), `worker/98932…js`; [DOC] stlbuddy.com/model-splitter (2026-10-19).
- **Adopt:** Extend Studio's plane cut with "suggest cuts from the printer bed" (§11.11); pins and dowels only once our algorithm is tested; seam, part count and cost change shown before approval; a corrections list that blocks ordering; declared input limits; a cancellable job that keeps state. Protected or merchant templates are never cut beyond their customisation licence (§16).
- **Not copied:** Pin and socket geometry, curve UI, samples, copy. three-bvh-csg and three-mesh-bvh (MIT) may be evaluated from upstream only.
- **Levo:** Partial: `studio/app/plane-cut.ts` (watertight caps, volume-conservation tests). Add `studio/app/cut-plan.ts` (multi-cut plan, pins) and run B-15. §11.11, §14, §16.
- **Limits:** Static only; cut quality and pin tolerance not measured; the precise-evaluator chunk was not fetched.

#### B-14 · Modify tools on owned or licensed files — STLbuddy · P2 · Phase 3
- **Observed:** STL Customizer (free) adds names, quotes and logos to any uploaded STL, curving text onto surfaces, each design a separate part; Texture Studio; Make It Wearable (hollow, eye openings, split); Make It Life Size; Mold Maker; Flexi Cutter; fitted-cavity tools; Color Splitter (beta, "some models may not split successfully"); MyFit.
- **Evidence:** [REA-S] ev_a5f5e664… 9072, text-logo-customizer page chunk ("printable-output checks"); [DOC] stlbuddy.com/text-logo-customizer (2026-10-19).
- **Adopt:** Studio modify operations only on files the user owns or is licensed to customise (§16); every modification is a new revision with before and after and runs B-15; honest "beta, may fail" labels.
- **Not copied:** Texture library; wearable and flexi algorithms; copy.
- **Levo:** Absent: a Studio operations registry limited to what the engine supports (§10), with a rights check from the protection layer before any operation on a template or marketplace model. §10, §11, §14, §16.
- **Limits:** These tool chunks were not analysed in depth.

#### B-15 · Printability gate and DFM feedback — STLbuddy, Xometry · P1 · Phase 2
- **Observed:** STLbuddy's export gate welds vertices, rejects collapsed triangles, counts edges not shared by exactly two oppositely oriented faces, counts disconnected components and requires positive volume; an offset/simplify repair is accepted only when the volume change is below max(0.005, 0.05%); each failure has its own message; "No download has been charged". Xometry's Analyze tab lists voids, oversize, small gaps, thin areas, supported volumes, sharp internal corners, fidelity, floating parts, tool access, file type and multiple shells, warns that results may be false positives and offers a manual review. Its client types carry `dfmChecks {key, title, severity ERROR/WARNING/SUCCESS, occurrences {description, recommendation, geometryHighlights {faceIds, edgeIds}}}`; parts with errors are listed as blocking.
- **Evidence:** [REA-S] ev_a5f5e664… `68732…js` module 45303, text-logo-customizer and model-splitter chunks; [DOC] xometry.com/how-xometry-works Step 4, community.xometry.com/kb/articles/721 (2026-10-19); [REA-S] ev_5535d0ff… operation names (ConfigurePartPricingSnapshotFields, QuoteBuyBox_Quote).
- **Adopt:** One check module shared by Studio and the server: closed and manifold, one component per part (or declared multi-part), positive volume, no degenerate faces, bed fit, walls thinner than the nozzle, overhang, floating shells, tiny text. A closed vocabulary `{key, severity, recommendation_key, face_ids}` rendered with face highlights; errors block READY_TO_EXECUTE, warnings stay visible; every check offers "request human review"; a shape-changing repair needs before/after and approval (§14); the result is stored with the revision and tool version.
- **Not copied:** CNC and sheet checks; their thresholds and wording; any suggestion that an automated check is final.
- **Levo:** Partial: `worker/lib/modelGeometry.ts` already computes shells, watertightness, overhang ratio and part count with caps and honest nulls. Extend its outputs into the vocabulary; render in Studio and the viewer (§15); feed NEEDS_REVIEW (§19). §14, §15, §19.
- **Limits:** Static and docs only; Xometry's algorithms are closed; Levo sets its own tolerances on its own fixtures.

#### B-16 · Server-side profile validation per printer — MakerWorld · P1 · Phase 2
- **Observed:** Cloud slicing verifies every print profile on publish, once per selected printer, and drops incompatible printers. Limits: 5 min per plate, 15 min per 3MF, 200 MB. Custom filament or printer presets are rejected; modified custom G-code is stripped and the uploader told; high- and low-temperature filaments cannot be mixed.
- **Evidence:** [DOC] wiki how-to-upload-models FAQ; RN 20231207 #6; RN 20240311 #10 (2026-10-19).
- **Adopt:** Publishing a profile queues a validation job in the Levo engine: bed fit per printer, plate cap, time limit, flagging or stripping custom G-code, material compatibility. Each printer gets "verified" or "not verified" with an honest reason.
- **Not copied:** Bambu's cloud slicer; its numeric thresholds.
- **Levo:** Partial: the checks in `studio/app/makerworld/preflight.ts` (build volume, ENGINE_PLATE_CAP 9) can run as a server job. §14.
- **Limits:** Our engine (three-slicer 0.2.2) differs; only documented behaviour was seen.

#### B-17 · Per-file pipeline states — Xometry · P1 · Phase 1
- **Observed:** Upload batches (create, add files, finalize, commit, discard), a presigned upload per file with progress, a subscription for batch updates; pending parts carry geometry-ready and geometry-failed flags and failed parts an error message. Job states: ENQUEUED, PROCESSING, COMPLETED, ERROR, SUPERSEDED, CANCELLED, MAX_RECOVERY_ATTEMPTS_EXCEEDED. Failed or pending parts can be removed.
- **Evidence:** [REA-S] ev_5535d0ff… operation names (PartUpload_*, PartsList_PendingPart, PartsList_FailedPart), enum in `f650e620…js`.
- **Adopt:** Every file shows a pipeline state: queued, measuring, ready, failed (with reason) or superseded by a newer upload. A capped retry ends in "gave up, needs review". Push updates instead of polling.
- **Not copied:** Their GraphQL schema and names.
- **Levo:** Partial: `worker/lib/requestFileHooks.ts` and `modelGeometry.ts` measure after upload. Add a state column per request file and a UI event. §14, §17 (thumbnails with retryable failures).
- **Limits:** Server behaviour and timings unknown.

#### B-18 · Local-first drafts that survive sign-in — STLbuddy · P1 · Phase 1
- **Observed:** "Autosaved on this device" with undo, redo and New. localStorage holds the design; IndexedDB holds a handoff store with expiry, image designs, exports up to 256 MB and a "return after paid download" key. A 401 opens sign-in inline; an account change is detected ("Your account changed. Your edits are preserved; try again"); locally saved tools are merged into the account. /learn says there is no customer file-storage workspace.
- **Evidence:** [REA-S] ev_a5f5e664… storage nodes, chunk 2021 module 80131, handoff module 13640; [REA-R] SHOT-MSB ev_e94bae50…; [DOC] stlbuddy.com/learn (2026-10-19).
- **Adopt:** Edits made before sign-in stay local (IndexedDB) and join the account only with explicit consent; private images are never uploaded silently (§10); the pending action (order or download) resumes after sign-in or payment; an account switch is detected and nothing is adopted across accounts. Server revisions remain the source of truth.
- **Not copied:** The device as the only store (§10 forbids localStorage-only projects).
- **Levo:** Mostly present: `studio/app/project-sync.ts` (revision protocol, five visible states, dispose on account switch) and `project-store.ts`. Add the consent step and the pending-intent resume. §10; phase 1 names "Studio link and project saving".
- **Limits:** Handoff expiry durations not read.

#### B-19 · Tool → Studio handoff and trusted "open in Studio" links — MakerWorld (Bambu Studio), Printables · P1 · Phase 1
- **Observed:** The Bambu Studio home is a webview talking to the native app with JSON `{sequence_id, command}`. A tool opens at `<host>makerlab?from=bambustudio` and hands its output to the slicer as base64 3MF; the app saves it under a sanitised name and opens it as a project; STL output gets an explicit success or fail reply. The `bambustudio://open?file=` deep link downloads only from allowlisted https hosts; other hosts get an "open anyway?" confirmation and URLs containing user info are rejected. PrusaSlicer 2.9.0 has a Printables tab that searches and downloads STL or 3MF into the slicer, follows the slicer's language and dark mode, and enables "send G-code" only when the connected printer matches the printer the G-code was sliced for.
- **Evidence:** [REA-S][CODE] ev_e303bcef… BambuStudio@79df7ae `GUI_App.cpp` ~1110–1240, 5191–5330; `WebViewDialog.cpp` 1074–1215; `home.js` 560–575, 900–955; [DOC] help.prusa3d.com/article/printables-in-prusaslicer_822448 (2026-10-19).
- **Adopt:** Tools write straight into a server-side Studio project of the same account, not a file download. "Open in Studio" carries a project and version reference and accepts only Levonis hosts or signed project ids; names are sanitised; the result is replied explicitly; login is required. A hand-off to a merchant or printer is refused when its capabilities do not match the sliced profile.
- **Not copied:** AGPL source and command names; PrusaSlicer and Prusa Connect APIs; embedding the website inside Studio (§01.5 forbids an iframe Studio).
- **Levo:** Partial: `studio/app/project-store.ts`, `project-sync.ts`, `studio-auth.ts`, `import-orchestrator.ts`; Studio handoff (migration 0012, `worker/routes/studio.ts`); capabilities (`merchantPrinters.ts`, 0144). §10, §14, §18, §25.
- **Limits:** Static reading only, nothing executed. That MakerLab generates on the server is inferred.

#### B-20 · "Price this" from Studio; upload before login — Xometry · P3 · Phase 1
- **Observed:** Drop-zone copy "No login required to upload — sign in to submit"; an `upload_first` URL parameter with persistence; a public test-drive demo (not opened). CAD add-ins (Fusion, SOLIDWORKS, Onshape) give price, lead time and DFM inside the CAD tool; Onshape hands off to the web quote for features, certificates and ordering.
- **Evidence:** [REA-S] ev_5535d0ff… `f929f910…js`; [DOC] xometry.com/how-xometry-works Tip #5, kb/articles/721 (2026-10-19).
- **Adopt:** A "get offers / price this" action in Studio sends the saved project version (same account) to a request draft; advanced options and ordering stay in Community; a guest can try Studio and upload, and signs in only to submit.
- **Not copied:** Third-party CAD plugins.
- **Levo:** Partial: `worker/routes/studio.ts`, the `studio/` app and the request wizard. §10, §17.
- **Limits:** The funnel experiment state is unknown.

#### B-21 · Publishing to MakerWorld (honest handoff) — MakerWorld · P2 · keep as is
- **Observed:** Uploading is web-only; a print profile must be a Bambu Studio 3MF with Bambu printer and filament presets; "Export Generic 3MF" is advised on parse failures; drafts can be imported from linked accounts (not Printables); MakerWorld prints run on the user's own printer.
- **Evidence:** [DOC] wiki how-to-upload-models; blog makerworld-3d-model-platform (2026-10-19).
- **Adopt:** Keep the four-step handoff: prepare the 3MF, open the official upload page, the user uploads with their own account, never claim it uploaded. Explain it arrives as a model or raw file, not a print profile.
- **Not copied:** Any unofficial upload API.
- **Levo:** Present: `studio/app/makerworld/preflight.ts`, `prepare.tsx`, `export-manager.ts` (MAKERWORLD_UPLOAD_URL; reason `makerworld-rejects-non-bambu-studio-profiles`, which the wiki confirms). §25.
- **Limits:** No public upload API observed.

#### B-22 · Template display modes and designer licences — STLbuddy, Thangs · P1 · Phase 2
- **Observed:** STLbuddy: "Free to design. Choose how you download." Free $0 (21 tools), Tinkerer $10/mo (38), Maker $20/mo (71), Inventor $32/mo (77); 5/7/10 credits per download without membership; packs of 40 credits for $10 and 100 for $20; Image to STL charged per generation for everyone; Stripe or PayPal; the tool header states what the next step costs; free tools still need an account to download. Thangs: membership plans with up to five tiers including commercial memberships that let customers sell prints; a multi-designer Bundle subscription (14.99 USD/month, 15,000+ models); a print-on-demand store; free or one-off downloads; designer onboarding (profile → Stripe → upload with print photos, description, category and print instructions → audience → publish → account approval); versioning, collections, analytics.
- **Evidence:** [DOC] stlbuddy.com/pricing (2026-10-19); [REA-S] ev_a5f5e664… 9072 (tier credits, plan prices), endpoints `/stripe/checkout`, `/paypal/create-credit-order`; [REA-R] SHOT-NM header; [DOC] thangs.com/resources/getting-started-for-designers, thangs.com/ (2026-10-19).
- **Adopt:** Designing and previewing are free; the commitment point (normally an order or quote, not a file paywall) states its cost before it is reached. Template display modes: private, view-only, customise-and-order, download-with-conditions, authorised-merchants-only (§12). Licence types that separate download, manufacture by authorised merchants, and commercial print rights. Designer onboarding requires print photos and instructions; approval comes before paid publishing.
- **Not copied:** Plan names, prices, credit values, the subscription-for-files model; Thangs fees, Bundle pricing, Stripe dependence. No invented royalty percentage (§01.13); designer rights never mixed with points or investor shares (§12).
- **Levo:** Absent: §12 display modes and a designer entitlement ledger tied to the licence version; permission base `product_file_grants` and `viewer_grants` (0157); orders through existing payment methods (§11). §11, §12, §16, §19.
- **Limits:** Billing internals unobserved; Thangs enforcement unknown.

#### B-23 · Template-to-sale lifecycle with approvals — Thangs · P2 · Phase 2
- **Observed:** Print on Demand: pick a model → set up the print → request a quote and check printability → after approval choose materials → submit for approval → after approval set a price and list it. Thangs/Shapeways produce, ship and support.
- **Evidence:** [DOC] thangs.com/resources/sell-prints (2026-10-19).
- **Adopt:** A two-stage lifecycle (printability and quote check, then material and price listing), each with explicit approval before customers can order: draft → generation test → manufacturing approval → publish.
- **Not copied:** A single fulfilment partner; Levonis matches approved local merchants (§17).
- **Levo:** Partial: quote engine (0078 `print_quote_engine`, `worker/routes/printQuote.ts`); merchant eligibility (0132). §12, §14, §18.
- **Limits:** Marketing page.

#### B-24 · Image or video to 3D as background jobs — MakerLab, STLbuddy · P2 · Phase 6
- **Observed:** MakerLab AI Scanner turns an orbit video into a mesh in about 30 min; the user can leave and return, choose object or portrait mode and pick the subject; Image to 3D, PrintMon, PrintU and Make My Statue exist; [WS] credits are charged at start and vary by tool and provider. STLbuddy Image to STL lives at `/generate/new` (`/image-to-stl` is a 404): "uses credits per generation, including for Inventor members. The cost is shown before you generate."
- **Evidence:** [DOC] blog …makerlab-experiments; wiki exclusive-model-guideline; [WS] MakerLab credit guide; [DOC] stlbuddy.com/pricing, /image-to-stl → 404 (2026-10-19); [REA-S] ev_a5f5e664… 9072, `63788…js`.
- **Adopt:** §13 as a background job with real states (queued, running, failed, done), resumable, with no fake progress. Any cost or quota is shown before running, under an owner policy. Output is always NEEDS_REVIEW and never a final price (§19), and is labelled as generated (E-09). Generation quota stays separate from order pricing.
- **Not copied:** Providers, credit prices, outputs.
- **Levo:** Absent: §13 service (self-hosted engine in phase 6) on a worker queue; results enter the §14 pipeline. §13, §19, §24.
- **Limits:** Providers, quality and latency unknown; not run.

#### B-25 · Failure report that keeps the work — STLbuddy · P2 · Phase 2
- **Observed:** When processing failed (headless, no GPU) a modal said "Sorry for the failure. Your design stays right where you left it … Would you like to report this?" with Dismiss and Report. The form has topic, tool, "what were you trying to make" (≥10 chars), steps (≥20), a required screenshot (≤5 MB), "Did you use an image?" and a honeypot; page, browser and failure details are attached automatically; workers have timeouts.
- **Evidence:** [REA-R] SHOT-NM ev_e2d62ffd…; [DOC] home and pricing HTML (2026-10-19); [REA-S] ev_a5f5e664… `/api/feedback`, events `stlbuddy:download-failure`, `stlbuddy:open-feedback`.
- **Adopt:** Studio failures open an in-context support case through the unified support assistant (smart search and assistant lane), pre-filled with tool, revision, engine version and error code. Work is never lost; attaching an image needs consent.
- **Not copied:** Wording; form layout.
- **Levo:** Partial: support exists (`src/pages/Support.tsx`, adminSupport). Add a Studio error boundary → support case API; strings ar/en/ckb. §10.
- **Limits:** The form was not submitted, by rule.

---

## C. Pricing, requests and manufacturing orders (§17–§20)

| ID | Feature | References | Levo today | P | Phase |
|---|---|---|---|---|---|
| C-01 | Format capability matrix before upload | Xometry | Partial | P1 | 1 |
| C-02 | Client pre-check from one config; guest draft | Xometry | Partial | P1 | 1 |
| C-03 | Explicit unit choice for mesh files | Xometry | Partial | P1 | 1 |
| C-04 | Result types and per-part pricing states | Xometry | Partial | P1 | 2 |
| C-05 | Re-quote only when a priced fact changes | Xometry | Partial | P1 | 2 |
| C-06 | Customer price breakdown without merchant economics | Xometry | Partial | P1 | 2 |
| C-07 | Closed acceptance-rejection reasons | Xometry | Partial | P1 | 2 |
| C-08 | Idempotency keyed on revision and output hash | STLbuddy | Absent | P1 | 2 |
| C-09 | Offer validity and expiry | Xometry (gap at source) | Partial | P2 | 2 |
| C-10 | Version pin, where-used, archive not delete | Xometry | Partial | P1 | 2 (library 4) |
| C-11 | Speed options as parallel price tiers | Xometry | Partial | P1 | 3 |
| C-12 | Quantity price breaks | Xometry | Partial | P2 | 3 |
| C-13 | Per-part configuration and saved presets | Xometry | Partial | P1 | 2 (presets 3) |
| C-14 | Plates, parts and copies; reprint one part | MakerWorld | Partial | P2 | 3 |
| C-15 | Bill of materials linked to the catalogue | MakerWorld | Absent | P1 | 3 |
| C-16 | Mixed request split | Xometry | Absent | P2 | 3 |
| C-17 | Assisted request path for complex work | Xometry | Partial | P2 | 3 |
| C-18 | Reorder as a direct request | Xometry | Partial | P2 | 3 |
| C-19 | Shareable offer summary and PDF | Xometry | Partial | P3 | 3 |
| C-20 | Request and offer activity feed | Xometry | Partial | P2 | 2 |
| C-21 | Merchant job card: accept or decline with reason | Xometry | Partial | P1 | 2 |
| C-22 | Production Package and confidential handoff | STLbuddy, Xometry | Absent | P1 | 2 (BOM/assembly 3) |
| C-23 | Default print standard per technology | Xometry | Partial | P2 | 3 |
| C-24 | QualityCheck evidence before "ready" | Xometry | Partial | P2 | 2 |
| C-25 | Cancellation branches | Xometry | Partial | P2 | 2 |
| C-26 | Educational cost calculator | STLbuddy | Partial | P2 | 3 |
| C-27 | A model linked to whoever prints it | MakerWorld | Present | P2 | — |

#### C-01 · Format capability matrix before upload — Xometry · P1 · Phase 1
- **Observed:** Accepted formats: STEP, STP, SLDPRT, STL, DXF, IPT, X_T, X_B, 3DXML, CATPART, PRT, SAT, 3MF, JT. Solids can be quoted for any process; meshes (STL, 3MF, 3DXML) only for 3D printing and urethane casting and may need an inch/mm choice; DXF is sheet cutting only; native assemblies do not load. For a coloured OBJ, upload an STL for pricing and attach the OBJ as a "drawing"; 3MF is preferred for full colour. The list is printed under every upload button.
- **Evidence:** [DOC] community.xometry.com/kb/articles/643; xometry.com hero copy (2026-10-19); [REA-S] ev_5535d0ff… format array in `f929f910…js`.
- **Adopt:** A small matrix shown before upload: format → what Levonis can do with it (FDM or resin quote, preview only, reference only). Say plainly that a mesh without colour data cannot make a multicolour job and that OBJ or GLB colour is reference-only unless a 3MF with per-part assignment is supplied (§17).
- **Not copied:** The CAD-native list Levonis cannot parse; Xometry's wording.
- **Levo:** Partial: `worker/lib/attachments.ts` already classifies stl, 3mf, obj, amf, glb, gltf, step, stp by magic bytes. Add a capability map `{kind → quotable processes, preview, colour-capable}` and show it in the request wizard's source picker in ar/en/ckb. §17.
- **Limits:** Which formats the server accepts today is not proven.

#### C-02 · Client pre-check from one config; guest draft — Xometry · P1 · Phase 1
- **Observed:** KB 688: 100 MB per file; a red bar means processing failed (assembly without part data, geometry timeout, size); special characters break parsing; ZIPs must be extracted. Client code checks 150 MB ("File size exceeds the maximum limit of 150 MB"), an executable and script denylist, and a missing extension; a second uploader checks 250 MB. Drop zone: "Up to 150 MB per file. No login required to upload — sign in to submit." Images and documents are accepted as supporting files.
- **Evidence:** [DOC] kb/articles/688 (2026-10-19); [REA-S] ev_5535d0ff… `f929f910…js`, `ce230291…js`.
- **Adopt:** A per-file check before upload with one explicit message per case (too large, blocked type, no extension, archive); retryable per-file failure; a guest draft (upload first, sign in to submit); one limit, served from config and shown in the UI.
- **Not copied:** Their limits: three different numbers (100, 150, 250 MB) are the drift to avoid. Their copy.
- **Levo:** Partial: `worker/routes/uploadSessions.ts` (resumable R2 multipart, SHA-256, 300 MB target, ZIP and glTF caps). Add a shared client pre-check reading the same limits from one config endpoint, and a guest-draft path in the request wizard (§17 real drafts).
- **Limits:** The server limit is unknown; static code does not prove which uploader is live.

#### C-03 · Explicit unit choice for mesh files — Xometry · P1 · Phase 1
- **Observed:** Mesh files may need an inch or mm choice. Client types: enum INCHES/MM, part state UNIT_SELECTION_REQUIRED, a quote count of parts needing a unit, a mutation to set units. No price until a unit is chosen.
- **Evidence:** [DOC] kb/articles/643 (2026-10-19); [REA-S] ev_5535d0ff… enums in `f650e620…js`, the operation texts.
- **Adopt:** When an STL's unit is undeclared and the size is implausible, the part enters "needs unit" showing the measured box in mm and the inch alternative; no price until the customer confirms.
- **Not copied:** Nothing proprietary; the pattern is generic.
- **Levo:** Partial: `worker/lib/modelGeometry.ts` detects unit mix-ups; reason UNIT_ASSUMED_AND_SIZE_IMPLAUSIBLE exists in `worker/lib/printEstimate/contract.ts`. Add a per-part `unit_choice_required` state and a rescale action that creates a new priced revision (`worker/lib/requestRevisions.ts`). §17, §19.
- **Limits:** Static and documentation only.

#### C-04 · Result types and per-part pricing states — Xometry · P1 · Phase 2
- **Observed:** Part pricing states CONFIGURATION_REQUIRED, UNIT_SELECTION_REQUIRED, PRICING_IN_PROGRESS, MANUAL_QUOTE_REQUIRED, MANUAL_QUOTE_IN_PROGRESS (plus priced). Manual-quote reasons carry key, severity, title, description and recommendation; the quote carries a no-price reason and priced/unpriced counts. KB 686: "Don't see a price? … request a manual review."
- **Evidence:** [REA-S] ev_5535d0ff… `f650e620…js`, operation names (PartsList_QuotedPart, QuoteBanner_Quote); [DOC] kb/articles/686 (2026-10-19).
- **Adopt:** §19's READY_TO_EXECUTE and NEEDS_REVIEW plus named intermediate states (needs configuration, needs unit, pricing, needs material, capability unavailable, needs repair, offer expired), each with a reason key, a recommendation and a next action, never a vague error.
- **Not copied:** Their state names and enum strings.
- **Levo:** Partial: `worker/lib/printEstimate/contract.ts` has priced, reason, confidence and reasons. Add an explicit `result_type` and a localised recommendation per reason. §19.
- **Limits:** Server criteria for "manual required" unknown.

#### C-05 · Re-quote only when a priced fact changes — Xometry · P1 · Phase 2
- **Observed:** "Pricing and lead times will update instantly as you make selections"; "apply all" after a change. Updating a part returns the pricing state and selected tier; pricing returns a full snapshot. A part revision updates open quotes but not placed orders (KB 839).
- **Evidence:** [DOC] xometry.com/how-xometry-works Step 3; kb/articles/686, 839 (2026-10-19); [REA-S] ev_5535d0ff… operation names (UpdateQuotedPart, PriceQuotedPart).
- **Adopt:** Re-price on the server only when a priced fact changes (size, geometry-affecting text, material, process-affecting colour, quality, quantity, address, delivery), with a visible "recalculating" state. Viewer zoom or background never re-prices. Pending offers on an older revision become superseded, never silently edited.
- **Not copied:** Their client architecture.
- **Levo:** Partial: `worker/lib/requestRevisions.ts` already hashes priced facts and supersedes pending offers. Wire the same hash into the instant estimate and Studio's "get offers". §19 invalidation list.
- **Limits:** Debounce, latency and caching not observed.

#### C-06 · Customer price breakdown without merchant economics — Xometry · P1 · Phase 2
- **Observed:** The buy box carries subtotal, tools cost, coupon and points discounts, carbon offset, adjusted subtotal, savings, an "is estimate" flag, priced and unpriced counts, delivery (order-by countdown, ship-by, estimated arrival, free-shipping eligibility), ready-for-checkout and checkout blockers. No cost, margin or supplier payout appears in any customer-facing fragment.
- **Evidence:** [REA-S] ev_5535d0ff… operation names QuoteBuyBox_Quote, BuyBoxMoney.
- **Adopt:** Customer lines for product or print, customisation, quantity, add-ons, delivery, discounts and total, with an explicit "estimate" flag when not READY. An "order by" countdown only when derived from the merchant's real hours and queue. Merchant cost lines never reach customers or other merchants.
- **Not copied:** Carbon offset; points as a discount (Levonis wallet and points rules differ; §19 forbids double discounts); layout.
- **Levo:** Partial: `worker/lib/printEstimate/contract.ts` (ordinal factors, covers and excludes, ESTIMATE_FORBIDDEN_FRAGMENTS test), `worker/routes/printQuote.ts` publicQuote. Add the explicit line list to the offer snapshot. §19.
- **Limits:** The rendered layout was not seen.

#### C-07 · Closed acceptance-rejection reasons — Xometry · P1 · Phase 2
- **Observed:** Checkout blockers ITAR_UNCONFIRMED, MIXED_ITAR, PARTS_NOT_ORDERABLE, UNPRICED_PARTS. Order placement rejections ALREADY_ORDERED, NOT_PURCHASABLE, ORDER_STATE_UNKNOWN, PAYMENT_DECLINED, PRICE_CHANGED, SHIPPING_STALE, SHIP_DATE_CHANGED, TOS_NOT_ACCEPTED, USER_NOT_REGISTERED.
- **Evidence:** [REA-S] ev_5535d0ff… enums in `f650e620…js`, operation names PlaceQuoteOrder.
- **Adopt:** Accepting an offer returns one closed reason (price changed, date changed, delivery stale, offer expired, already accepted, payment failed, terms not accepted), each with a re-confirm path. This enforces §19 (a changed or expired offer needs new approval; the invoice never changes silently) and §20 (no double acceptance).
- **Not copied:** Export-control blockers; their names.
- **Levo:** Partial: the acceptance batch in `worker/routes/printRequests.ts` and `worker/lib/communityRequests.ts` (fenced money hold). Add the reason enum, client handling and the C-08 key. §19, §20.
- **Limits:** Server checks behind each reason unknown.

#### C-08 · Idempotency keyed on revision and output hash — STLbuddy · P1 · Phase 2
- **Observed:** The client builds the file, hashes the bytes (SHA-256), reuses or creates an operation id per owner, tool, hash, revision and variant, then calls authorise and charge with that id. 401 opens inline sign-in; 402 raises insufficient credits; any response not matching `{charged, unlimited, cost ≥ 0, creditsLeft}` shows "The download charge was not confirmed. Retry with the same download." Identical bytes reuse the id, so there is no double charge. Library downloads verify the returned URL before clicking.
- **Evidence:** [REA-S] ev_a5f5e664… `2021…js` modules 72223, 80131; `26157-…js`; API base `/backend` in `88699-…js` module 54031.
- **Adopt:** Idempotency keys bound to `(account, project_revision, output_hash, variant)` for quote acceptance, order creation and permitted downloads, so Studio, cart and order never double-charge or double-discount (§19). Every money response is validated strictly on the client, and the retry is safe to repeat.
- **Not copied:** Their trust model: the server charges for bytes it never sees, so it cannot verify what was generated [INF]. Levonis prices and validates on the server from the project revision (§19: the client never sends a trusted final amount).
- **Levo:** Absent: an idempotency table used by `worker/lib/printQuote` and order creation; a client helper in the `studio/app/project-sync.ts` style. §12 (hashes), §19.
- **Limits:** `/backend` is robots-disallowed; the server ledger is unobserved.

#### C-09 · Offer validity and expiry — Xometry (gap at source) · P2 · Phase 2
- **Observed:** Not found. No public page or KB article states how long a quote is valid; the only expiry field in the bundles is on tax certificates; reorder price and lead time may change (KB 839); the PDF quote is a "timestamped copy". help.xometry.eu, which seems to answer this, is robots-disallowed and was not read.
- **Evidence:** [REA-S] ev_5535d0ff… grep "expir" in the operation texts; [DOC] kb/articles/839, blog share-online-manufacturing-quotes (2026-10-19).
- **Adopt:** Every Levonis offer shows its own expiry from an approved setting plus a timestamped snapshot; once lapsed it is labelled "expired" with a re-quote action (§19: validity comes from approved config, never invented).
- **Not copied:** Any Xometry duration (unknown anyway).
- **Levo:** Partial: `community_offers.expires_at` (migrations/0031), request expiry (`worker/routes/printRequests.ts` ~1123), printQuote `expires_at`. Surface the expiry and add an admin-set validity policy. §19.
- **Limits:** Recorded as a gap, not a behaviour.

#### C-10 · Version pin, where-used, archive not delete — Xometry · P1 · Phase 2 (pin), 4 (library UI)
- **Observed:** Every uploaded file gets a Part ID that keeps its history; re-uploading breaks the chain; a revision updates open quotes but not placed orders (KB 839). Client types include locking and unlocking a revision, open quotes and orders per revision, archive and restore, copy to organisation, and library statuses uploaded, configured, quoted, ordered.
- **Evidence:** [DOC] kb/articles/839 (2026-10-19); [REA-S] ev_5535d0ff… operation names PartRevision*.
- **Adopt:** The project version is the unit priced and ordered. An accepted order pins its version and fingerprint (§19 snapshot). A new version re-prices only open requests and notifies their merchants. A "used in" panel lists open requests and orders for a version. A version in an order can be archived, never deleted.
- **Not copied:** Their part-number scheme; organisation and team model.
- **Levo:** Partial: `worker/lib/requestRevisions.ts` (request revisions); project versions per E-07 and Studio save (§10). Add `version_fingerprint` to the offer and order snapshot and a where-used query. §05, §19.
- **Limits:** Static and documentation only.

#### C-11 · Speed options as parallel price tiers — Xometry · P1 · Phase 3
- **Observed:** Expedite (fastest, higher cost), Standard, Economy (cheaper) and International economy (lowest, longer, duties); availability varies by process; the FAQ gives typical expedite days (FDM 1–2, SLA 2–3, SLS 1–2, MJF 1–3). Client types carry per-tier unit and extended price, speed, lead days, estimated arrival, and cheapest, fastest and standard flags; the customer selects a tier.
- **Evidence:** [DOC] xometry.com/resources/blog/lead-time-options/, …/answers-to-most-frequently-asked-questions/ (2026-10-19); [REA-S] ev_5535d0ff… ConfigurePartPriceTierFields.
- **Adopt:** A merchant's capability profile declares speed options (for example normal and urgent) with its own surcharge and queue rule. The server computes each option's price, ready date and delivery date and badges cheapest and fastest; the customer chooses explicitly; dates come from working hours and queue, never a constant.
- **Not copied:** Tier names, day ranges, the domestic and international split; no invented default surcharges or days (§19).
- **Levo:** Partial: an offer has one `completion_days` (0031) and the workshop a `turnaround_days` (`requestRevisions.ts`, 0159). Add `speed_options` to the capability profile (§18) and `price_tiers` to the estimate and offer snapshot (§19). Fits phase 3's merchant comparison.
- **Limits:** Tier pricing and date derivation are server-side and unknown.

#### C-12 · Quantity price breaks — Xometry · P2 · Phase 3
- **Observed:** A volume-discount query returns rows of quantity, unit price, extended price and savings percent for the selected tier; the price updates when quantity changes.
- **Evidence:** [REA-S] ev_5535d0ff… operation names VolumeDiscountForQuotedPart; [DOC] kb/articles/686 (2026-10-19).
- **Adopt:** A small server-computed table of unit price and total at a few quantities with savings against quantity 1, using the same engine and merchant rules, so plate packing and per-job setup show honestly.
- **Not copied:** Their discount curve.
- **Levo:** Partial: `worker/lib/printPricing.ts` has quantity discount percent and cap. Expose an estimate-breaks endpoint calling `priceJob` in `worker/lib/printQuote/cost.ts` for N quantities; a card in request and offer views. §19.
- **Limits:** Breakpoints and placement not observed.

#### C-13 · Per-part configuration and saved presets — Xometry · P1 · Phase 2 (panel), 3 (presets)
- **Observed:** Process, material (about 200, narrowed by process), finish, quantity, inspection reports, features (threads, inserts, markings, tolerances), certificates, notes and a PDF drawing; an "Other" material triggers expert review. Organisation presets are grouped by team and flagged when invalid.
- **Evidence:** [DOC] how-xometry-works Step 3; kb/articles/686; FAQ blog (2026-10-19); [REA-S] ev_5535d0ff… operation names QuoteOrgPresets, ApplyQuotePreset.
- **Adopt:** A per-part panel (technology, material, colour swatch with search, quality profile, quantity, finishing, notes, drawing) whose options are filtered by what eligible merchants can make (§17 matching). "Other / not listed" turns the result into NEEDS_REVIEW. A saved preset whose options became invalid is flagged, never applied silently.
- **Not copied:** Their material catalogue, finish names, aerospace and medical inspection standards.
- **Levo:** Partial: the material and colour dictionary linked to catalogue variants (§17); printers and preferences in `worker/routes/merchantPrinters.ts`; capability profile (§18). Presets per customer and merchant.
- **Limits:** Live UI and filtering logic not observed.

#### C-14 · Plates, parts and copies; reprint one part — MakerWorld · P2 · Phase 3
- **Observed:** Variants go on separate named plates. The phone app lets a user set copies (re-arranged by cloud slicing), print only selected parts (to reprint a failed or lost part), go to the next plate, or jump from print history.
- **Evidence:** [DOC] wiki print-profile-upload §4; printing-tutorial-on-bambu-handy (2026-10-19).
- **Adopt:** In requests and Studio the customer picks plates, parts and copies from a profile; the price is recalculated from that selection; a single failed part can be reprinted.
- **Not copied:** App UI.
- **Levo:** Partial: `worker/routes/printRequests.ts` (§17), §19 pricing, `studio/app/plate-packing.ts`. Phase 3 names plates and batches.
- **Limits:** Documentation level.

#### C-15 · Bill of materials linked to the catalogue — MakerWorld · P1 · Phase 3
- **Observed:** Every model page has a BOM in three groups (kits and parts, filaments, laser materials). Creators find items by fuzzy search, dropdown or product id and set quantity and order; users buy everything in one click. Creators earn 3–15% commission after a threshold; orders count only when completed and delivered for 14 days; access is blocked above a 30% refund rate.
- **Evidence:** [DOC] wiki creator-commission-incentives; RN 20240417 #2 (2026-10-19).
- **Adopt:** BOM rows point to Levonis catalogue SKUs (filament, LED, NFC, magnets, rings, switches) or to free-text parts. "Add all" respects the single-seller cart by splitting per seller and letting the customer choose. Creator attribution is recorded for a future approved policy.
- **Not copied:** Commission rates, thresholds and windows (owner policy, §01.13).
- **Levo:** Absent: a `project_bom` table; catalogue search through `worker/routes/catalog.ts`; the single-seller rule in `cart.ts` (§01.10). §05, §20; phase 3 names BOM and assembly.
- **Limits:** Commission is a policy decision; only the infrastructure is proposed.

#### C-16 · Mixed request split — Xometry · P2 · Phase 3
- **Observed:** A quote can be "mixed"; a mutation moves parts that need a manual quote into a separate manual quote, so the priced parts can be checked out.
- **Evidence:** [REA-S] ev_5535d0ff… operation names (QuoteBuyBox_Quote, SplitRfqRequiredPartsFromQuote).
- **Adopt:** In a multi-part request the customer can accept the READY parts and send the rest to the offers board as a linked NEEDS_REVIEW request; both stay connected to the same project and conversation.
- **Not copied:** Their naming; splitting without the customer's consent.
- **Levo:** Absent: parts modelling on `community_requests` (§17 several parts per request), a `parent_request_id` link and a split action in `worker/routes/printRequests.ts`. §17, §19.
- **Limits:** The split UX was not observed.

#### C-17 · Assisted request path for complex work — Xometry · P2 · Phase 3
- **Observed:** For complex packages, buyers unsure of technical details, assemblies, multiple scheduled shipments, help choosing, or a human in the loop. Inputs: files, processes, materials, quantities, certifications, address, delivery schedule including split shipments, contacts; results appear in quote history. "Production" means 10+ parts or 100+ quantity; bulk upload takes CAD, drawings and BOM.
- **Evidence:** [DOC] xometry.com/how-xometry-works/request-a-quote/, …/xometry-enterprise/production-quotes/ (2026-10-19); [REA-S] ev_5535d0ff… SubmitBulkUpload.
- **Adopt:** §17 path (c), a free request that needs offers, with explicit routing reasons ("sent to review because …"); an optional split-delivery schedule; a BOM attachment for assemblies.
- **Not copied:** Their thresholds as Levonis policy; enterprise procurement (PO terms, punchout).
- **Levo:** Partial: the `community_requests` board, offers, `worker/lib/directRequests.ts`. Add routing reasons and a BOM or assembly part list (§17, §20).
- **Limits:** Documentation only.

#### C-18 · Reorder as a direct request — Xometry · P2 · Phase 3
- **Observed:** "Reorder Parts" builds a new quote with the same lines, quantities and configurations; a "Repeat Part" toggle marks earlier orders; the same supplier is used for tooled processes and otherwise preferred, not guaranteed; reorder price and lead time may differ.
- **Evidence:** [DOC] kb/articles/839; manufacturing-partner-network-overview FAQ (2026-10-19); [REA-S] reorder button ids in `ce230291…js`, `41e810e4…js`.
- **Adopt:** "Order again" on a completed community order creates a draft direct request to the same merchant with the same project version, parts and options, freshly priced. If the merchant's profile changed, the new price is shown as new; old terms never carry over silently.
- **Not copied:** Supplier-guarantee wording; pricing behaviour.
- **Levo:** Partial: `worker/lib/directRequests.ts` and the order snapshot; a new reorder action. §17; phase 3 names reorder.
- **Limits:** Documentation and button ids only.

#### C-19 · Shareable offer summary and PDF — Xometry · P3 · Phase 3
- **Observed:** Share (the recipient may check out on the customer's behalf), email with PDF, or PDF download listing project details, notes, contacts, estimated delivery, requirements and totals, timestamped, with a checkout link; "Forward to Purchaser" under checkout. Client types include share modals and an autoshare toggle.
- **Evidence:** [DOC] blog share-online-manufacturing-quotes; how-xometry-works Step 6 (2026-10-19); [REA-S] ev_5535d0ff… EntityShareModal_*.
- **Adopt:** An access-checked, expiring, read-only offer link and a printable trilingual offer PDF with a timestamp, useful when a family member or company pays. The shared view never exposes private files, phone or address.
- **Not copied:** Team and organisation procurement; the design and PDF template.
- **Levo:** Partial: `worker/lib/linkCards.ts`, `chatCards.ts`, `worker/lib/printDocument.ts`, `receipts.ts`. New share token over the offer snapshot. §17, §19.
- **Limits:** The current PDF was not seen.

#### C-20 · Request and offer activity feed — Xometry · P2 · Phase 2
- **Observed:** A quote activity query with `customerView: true` returns entries with actor, title, part name and lines, implying a separate internal view and a filtered customer view.
- **Evidence:** [REA-S] ev_5535d0ff… QuoteSummaryActivity.
- **Adopt:** A request and offer feed (revision created, offer received or superseded, price changed, material substituted with its price and time impact, accepted, expired) with a customer-safe projection and an internal one, so merchant economics never leak (§17, §19).
- **Not copied:** Their schema.
- **Levo:** Partial: `worker/routes/communityOrderTimeline.ts` (after acceptance) and `worker/lib/requestRevisions.ts` (revision rows). Add pre-acceptance events. §17, §19, §20.
- **Limits:** Event types unknown.

#### C-21 · Merchant job card: accept or decline with reason — Xometry · P1 · Phase 2
- **Observed:** After an order: engineering review, then assignment to a vetted supplier; AI matching on process, material and lead time with human oversight. A partner's job board shows matching jobs; the partner accepts with one click or rejects with feedback; no bidding. Non-instant jobs go to an RFQ marketplace. Payouts are invoiceless (net 40); most jobs are 1–20 units.
- **Evidence:** [DOC] xometry.com/how-xometry-works Step 7; kb/articles/498; capabilities/community/; manufacturing-partner-network-overview (2026-10-19).
- **Adopt:** For template and approved-price paths (§17 a, b) the merchant receives a job card with frozen terms (version, materials, price, date) and accepts, or declines with a reason code, without renegotiation. The free path (c) keeps offers. Decline reasons feed capability and preference tuning.
- **Not copied:** The platform assigning a supplier (§17 forbids choosing a merchant for the customer or binding a merchant to terms it has not approved); net-40 payouts; price arbitrage.
- **Levo:** Partial: `worker/lib/printMatching.ts` (notify-only), `eligibility.ts`, `printMatchingScore.ts`, `worker/routes/merchantInbox.ts`. Add accept or decline-with-reason on READY orders before work starts (§20 awaiting merchant acceptance).
- **Limits:** Workcenter and the job board are behind login.

#### C-22 · Production Package and confidential handoff — STLbuddy, Xometry · P1 · Phase 2 (BOM and assembly guide phase 3)
- **Observed:** STLbuddy's storage ZIP contains parts (STL), individual 3MFs, plates (3MF), `parts-list.csv`, `print-notes.txt` (tool, profile id and version, clearance, "print calibration parts first"), and an assembly guide in HTML (inline SVG) and PDF; dimensions are in print orientation; repeated parts share one STL; preview has Explode and Assembly. Xometry: customer data is used only to estimate, fabricate and review; jobs reach partners under internal ids not tied to the customer or end project; partners sign NDAs; data is encrypted with access controls.
- **Evidence:** [REA-S] ev_a5f5e664… `35739…js`, `19140…js`; [DOC] community.xometry.com/kb/articles/689; manufacturing-partner-network-overview FAQ (2026-10-19).
- **Adopt:** A Production Package created at acceptance from the same generator run: deduplicated parts with quantities, plates, a BOM and parts CSV, print notes (profile, material, clearance, versions) and an RTL assembly guide in ar/en/ckb with SVG diagrams. Customer and merchant receive the same hashed package linked to the order snapshot. It carries an order-specific reference and only what manufacturing needs (allowed print files, not editable sources; approved preview; profiles; materials; quantities; delivery fields the role may see). Eligible merchants that have not accepted see coarse previews only.
- **Not copied:** File naming, guide styling and text; compliance claims (ITAR, CMMC, FedRAMP).
- **Levo:** Absent as an object (no Production Package in the code today): `studio/app/export-manager.ts` plus a server package writer tied to the revision and `output_hash`; file access through `worker/lib/requestFilePolicy.ts` (original vs coarse mesh), `worker/lib/viewerGrants.ts`, `model_view_tokens`. §14, §16, §20; phase 2 names the Production Package.
- **Limits:** The PDF generator was not identified; Xometry's internal process was not observed.

#### C-23 · Default print standard per technology — Xometry · P2 · Phase 3
- **Observed:** A published standard applies unless the customer specifies otherwise: support vestiges allowed; the technician chooses orientation; FDM tolerance ±1 layer for the first inch then ±0.002"/inch; desktop FDM (Prusa MK3S/MK4, Bambu X1C) at 0.008" layers; filament colour and layer may vary between batches; raised text under 0.040" may not resolve; threads should be tapped or use inserts; tolerances apply before post-processing; tighter tolerances only after manual review.
- **Evidence:** [DOC] xometry.com/manufacturing-standards/; …/capabilities/3d-printing-service/ (2026-10-19).
- **Adopt:** An original Levonis default print standard for FDM and resin, written with merchants and approved by the owner, versioned and referenced by every offer: what is normal (layer lines, support marks, batch colour variance) and what counts as a defect. A stricter requirement (tight tolerance, cosmetic face) makes the job NEEDS_REVIEW. Disputes are judged against the snapshot (§20).
- **Not copied:** Their numbers and text; Levonis measures its own merchants' machines.
- **Levo:** Partial: `worker/lib/policyPublication.ts`, `policyOps.ts` (versioned published policies). Add an offer-snapshot reference to the standard version. §18, §20.
- **Limits:** Xometry's numbers are not transferable.

#### C-24 · QualityCheck evidence before "ready" — Xometry · P2 · Phase 2
- **Observed:** Standard inspection with every order; add-ons (dimensional report, CMM, first-article inspection, source and custom inspections) with a ballooned drawing. "Virtual Quality Control" reviews partner-uploaded photos and documents before shipping [INF, job postings only]. A visual status tracker and emails; shipment states created, purchased, purchase failed, shipped, delivered, returned, cancelled.
- **Evidence:** [DOC] FAQ blog (2026-10-19); [INF] VQC job postings via WebSearch; [REA-S] ev_5535d0ff… shipment enum in `f650e620…js`.
- **Adopt:** An optional QualityCheck step: the merchant uploads photos of the finished part and, when requested, measured key dimensions; the customer sees them before "ready for pickup or delivery". Shipment state is kept separate from order state (§20: one status variable must not carry everything).
- **Not copied:** Aerospace inspection standards as defaults.
- **Levo:** Partial: `worker/routes/communityOrderTimeline.ts` (progress and photo updates, migration 0160) and order states (0031). Add a QualityCheck stage and photo consent. §20.
- **Limits:** VQC is inferred.

#### C-25 · Cancellation branches — Xometry · P2 · Phase 2
- **Observed:** Because parts are made to order, an order may not be changeable or cancellable once placed; contact support within 4 hours, with no guarantee and possible charges; review the quote thoroughly before ordering (KB 687). A new revision on a placed order needs support (KB 839).
- **Evidence:** [DOC] community.xometry.com/kb/articles/687, 839 (2026-10-19).
- **Adopt:** Explicit branches: free cancel before merchant acceptance; after acceptance or start, cancellation under an owner-approved policy with exactly one refund or void (§20); a pre-acceptance review screen showing exactly what is being bought.
- **Not copied:** The 4-hour window and fees (owner policy only).
- **Levo:** Partial: `worker/lib/orderCancelOps.ts`, `escrowOps.ts`, community order states (accepted → funded → in progress …; cancelled, refunded). §20.
- **Limits:** Enforcement not observed.

#### C-26 · Educational cost calculator — STLbuddy · P2 · Phase 3
- **Observed:** Inputs and defaults: spool $22 per 1 kg, 85 g, multi-colour purge 30 g (off), 6.5 h, 130 W, $0.16/kWh, printer $700 over 5,000 h, failure 5%, 1 copy. Result $3.06: material 61% ($1.87), electricity 4% ($0.14), machine wear 30% ($0.91), failure 5% ($0.15) (hand-checked). The FAQ publishes the formulas; USD, EUR and GBP with dated rates and a "stale" flag; "Save as my profile"; "Download calculation" exports JSON with inputs, results and assumptions; "Live calculation · No sign-up".
- **Evidence:** [DOC] stlbuddy.com/3d-calc (2026-10-19); [REA-S] ev_a5f5e664… 3d-calc page chunk.
- **Adopt:** The presentation: a stated formula, a share-of-cost breakdown, a saved personal profile, and an export with its assumptions and exchange-rate date. Labelled «تقدير تعليمي», distinct from a merchant-approved quote (§11.12), computed by the same Levonis engine, in IQD from the approved rate source.
- **Not copied:** Failure as a markup on the subtotal (Levonis models a failure reserve: `worker/lib/printQuote/cost.ts` "RISK IS NOT A MULTIPLIER"); their defaults; USD-centric copy.
- **Levo:** Partial: `worker/lib/printQuote/cost.ts` (component model, purge and tower named, failure reserve), `worker/lib/printEstimate/contract.ts` (no merchant economics), `src/pages/Tools.tsx`, `src/components/tools/GramsQuotePanel.tsx`. Add an educational mode, a saved profile per account and JSON/PDF export. §11.12, §19.
- **Limits:** Rounding and copies logic not traced.

#### C-27 · A model linked to whoever prints it — MakerWorld · P2 · keep as is
- **Observed:** MakerWorld prints on the user's own printer through its slicer and app; no third-party fulfilment was observed.
- **Evidence:** [DOC] blog makerworld-3d-model-platform; wiki printing-tutorial-on-bambu-handy (2026-10-19).
- **Adopt:** Keep Levonis's own edge: a member without a printer sends a project, profile or external link as a print request and merchants make offers; show which model is meant; never scrape.
- **Not copied:** Not applicable.
- **Levo:** Present: `worker/lib/externalModels.ts` (parses MakerWorld `/models/<id>`, no HTML scraping), `worker/routes/printRequests.ts`, `src/pages/Tools.tsx`. §17, §02.4.
- **Limits:** Absence of the feature at MakerWorld is not proven.

---

## D. 3D preview and protection (§15, §16)

Key finding for §16: any WebGL or WebXR viewer sends vertex data to the device; Sketchfab itself says its served data is lossy and scrambled but readable once it reaches the GPU, its AR hands a whole USDZ or glTF file to the OS viewer, and it withholds AR for password-protected models. On the Levonis side, the LVM1 view copy is unindexed full-precision float32 in mm (36 bytes per triangle): for any model under 250k triangles the "full" grant is the original geometry, and a 250k view is about 9 MB. There is no level-1 (images only) mode, AR is WebXR only (no iOS), and the viewer's strings exist in ar and en only.

| ID | Feature | References | Levo today | P | Phase |
|---|---|---|---|---|---|
| D-01 | Honest protection statement and asset levels | Sketchfab | Partial | P1 | 1 |
| D-02 | Download as its own permission; licence fixed at grant time | Sketchfab | Absent | P1 | 1 |
| D-03 | Signed short-lived download grants; print-ready package | Sketchfab | Partial | P1 | 1 |
| D-04 | Compact lossy view copy (LVM2) | Sketchfab | Partial | P1 | 2 |
| D-05 | Click-to-load poster | Sketchfab | Absent | P1 | 2 |
| D-06 | Server-rendered turntable (level 1) and no-WebGL fallback | Sketchfab (original to Levo) | Absent | P1 | 5 |
| D-07 | Audience levels per file | Sketchfab | Partial | P2 | 2 |
| D-08 | Crawler and cache hygiene | Sketchfab | Mostly present | P3 | 1 |
| D-09 | Rights declaration gate | Xometry (pattern) | Partial | P3 | 2 |
| D-10 | Gestures with pivot re-targeting | Sketchfab | Partial | P1 | 5 |
| D-11 | Spatial annotations and comments | Sketchfab | Absent | P1 | 5 |
| D-12 | AR handoff and true scale | Sketchfab | Partial | P1 | 5 |
| D-13 | Progressive loading and device budgets | Sketchfab | Partial | P2 | 5 |
| D-14 | Preview and render modes | STLbuddy, Sketchfab | Partial | P1 | 2 (Studio) / 5 (site) |
| D-15 | Print inspector | Sketchfab | Partial | P2 | 5 |
| D-16 | Measurement | Sketchfab (absent there) | Partial | P2 | 5 |
| D-17 | Printer plate and bed fit | STLbuddy, Sketchfab | Partial | P2 | 2 (Studio) / 5 (site) |
| D-18 | Owner default view and orbit limits | Sketchfab | Absent | P2 | 5 |
| D-19 | Internal viewer controller | Sketchfab | Partial | P2 | 3 |
| D-20 | Screenshot of the approved view | Sketchfab | Absent | P2 | 5 |
| D-21 | Part visibility and colour per part | Sketchfab | Absent | P2 | 3 |
| D-22 | Inline viewer without a scroll trap | Sketchfab | Absent | P2 | 5 |
| D-23 | Embed route for Levonis surfaces | Sketchfab | Absent | P3 | 3 |
| D-24 | Presentation defaults and Sorani strings | Sketchfab | Partial | P3 | ckb now; rest 5 |
| D-25 | Lighting rotation | Sketchfab | Partial | P3 | 5 |
| D-26 | VR mode | Sketchfab | Absent | P3 | 6 |

#### D-01 · Honest protection statement and asset levels — Sketchfab · P1 · Phase 1
- **Observed:** Sketchfab says piracy cannot be fully prevented: once data reaches the video card it is readable and can be intercepted (true for any WebGL or WebXR app). Served data is lossy and "scrambled"; it monitors and invalidates rippers; its terms forbid reverse engineering; private or password visibility adds a layer.
- **Evidence:** [DOC] help.sketchfab.com/en/articles/16152580-model-security (2026-10-19).
- **Adopt:** An owner-facing matrix (§16): what a visitor sees | whether geometry is sent to the device | customise | download | manufacture, with plain wording that any 3D or AR view copy can be extracted. Three levels: L1 server-rendered images only, L2 an approved lossy view copy, L3 a licensed download.
- **Not copied:** Their wording, plan gating of protection, "ripper" monitoring claims.
- **Levo:** Partial: grant levels today are `'full' | 'preview'` (`worker/lib/viewerGrants.ts`, `worker/lib/requestFilePolicy.ts`). Add `images_only` and an owner settings UI for products and projects. Until D-04 lands, a "full" grant of a model under 250k triangles delivers the original geometry. §16, §01 rule 12.
- **Limits:** Sketchfab's anti-ripper monitoring is not observable.

#### D-02 · Download as its own permission; licence fixed at grant time — Sketchfab · P1 · Phase 1
- **Observed:** Download is a per-model owner setting (no, free, or store for sellers). Enabling it requires a licence (Standard, CC BY, BY-NC, BY-ND, BY-SA; ND and SA exclusive; CC0 listed). The licence in force at download time prevails even if the owner changes it later. Turning downloads off needs upload credits; some capture tools forbid free download.
- **Evidence:** [DOC] help 16152220 (making downloadable), 16152217 (downloading) (2026-10-19).
- **Adopt:** Download is separate from view, customise and manufacture (§16). Choosing a licence is part of enabling download. Each download or grant row records the licence id and version, so the licence at grant time prevails.
- **Not copied:** Their licence texts; credit rules.
- **Levo:** Absent: file permissions plus a licence table with versions and a grant log (`worker/routes/productFiles.ts`, community files API). §16, §05, §12.
- **Limits:** Docs only.

#### D-03 · Signed short-lived download grants; print-ready package — Sketchfab · P1 · Phase 1
- **Observed:** A download offers the author's original files plus a transcoded glTF, GLBs at several texture sizes and a USDZ. The Download API needs end-user OAuth and returns short-lived signed archive URLs per format (a sample expiry of 300 s, "do not cache"); source formats are not offered through the API.
- **Evidence:** [DOC] help 16152217 (2026-10-19); [WS] sketchfab.com/developers/download-api (not fetched: AWS WAF challenge).
- **Adopt:** Authorised download (L3) as a per-user, per-purpose signed URL with a TTL in minutes, never cached, logged. The production file (STL or 3MF) and the view copy are separate objects. Offer a print-ready package (STL or 3MF plus settings) instead of game formats. A merchant receives the production file only for an accepted order (§20).
- **Not copied:** API shape and names; the OAuth flow.
- **Levo:** Partial: private bucket in `worker/lib/mediaStorage.ts`. Add a download-grant route mirroring `viewerGrants.ts` (hash-stored token, TTL, bound, re-checked at read). §16, §20.
- **Limits:** API facts are second-hand.

#### D-04 · Compact lossy view copy (LVM2) — Sketchfab · P1 · Phase 2
- **Observed:** Served data is lossy-compressed and scrambled; originals are never public unless download is enabled; at load the viewer merges materials and meshes and strips unused attributes.
- **Evidence:** [DOC] help 16152580, 16152043 (performance) (2026-10-19).
- **Adopt:** Replace LVM1 (raw unindexed float32, 36 bytes per triangle, lossless under 250k triangles) with an indexed, quantised view copy (for example 16-bit positions over the bounding box, a grid of roughly 0.05–0.2 mm) plus HTTP compression: about 4–6× smaller and no longer production-grade geometry. Use real quadric simplification instead of dropping triangles by stride, which leaves holes.
- **Not copied:** Their scrambling and file format (unknown and protected by their terms).
- **Levo:** Partial: `worker/lib/modelGeometry.ts` `viewerMesh()` → new LVM2 with a decoder in `src/pages/ModelViewer.tsx`; keep the LVM1 reader for stored previews. §16 level 2, §14 derivatives.
- **Limits:** Quantisation and decimation deter extraction but do not stop it. Whether owners and merchants accept a lossy view copy is an open decision.

#### D-05 · Click-to-load poster — Sketchfab · P1 · Phase 2
- **Observed:** With autostart off, the embed shows the model's screenshot with a play button and loads 3D only after a click. Autostart, animated entrance, turntable, preload textures and navigation hint are embed options.
- **Evidence:** [DOC] help 16152734 (embed customisation) (2026-10-19); [WS] poster behaviour from a Sketchfab community blog summary.
- **Adopt:** Product and project pages show the server thumbnail first and mint the viewer grant and fetch the mesh only when the user taps "view in 3D". This saves mobile data and sends no geometry to visitors who never ask for it (§15-أ: the viewer does not auto-load the asset).
- **Not copied:** Play-button art; the term "autostart".
- **Levo:** Absent: an inline viewer component (today the viewer is only the standalone `/model-viewer/:token` route) with grant minting through `viewerGrants.ts` on tap. §15-أ, §16.
- **Limits:** Partly from a search summary.

#### D-06 · Server-rendered turntable (level 1) and no-WebGL fallback — Sketchfab (original to Levo) · P1 · Phase 5
- **Observed:** media.sketchfab.com robots.txt disallows the geometry, upload, download and archive paths but explicitly allows thumbnails and `/fallback/`, which suggests image fallbacks kept apart from geometry [INF]. The docs describe no server-side interactive rendering.
- **Evidence:** media.sketchfab.com/robots.txt (2026-10-19); purpose [INF].
- **Adopt:** An original level 1: a compute job pre-renders a turntable (for example 24–36 frames at two elevations) from the private file; dragging scrubs the frames, so it feels like 3D with no mesh on the device. The same frames serve as the no-WebGL fallback (Levonis shows measurements only today).
- **Not copied:** Nothing to copy; Sketchfab does not offer this.
- **Levo:** Absent: a compute job in the §14 pipeline writing private R2 renditions; the viewer chooses frames or mesh by owner policy. §16 level 1, §15-أ. Phase 5 names server rendering "where the infrastructure exists".
- **Limits:** Needs a compute host (GPU or software rasteriser) and has a cost; owner and hosting decision.

#### D-07 · Audience levels per file — Sketchfab · P2 · Phase 2
- **Observed:** Higher plans get Private and Password-protected visibility; password-protected models are excluded from AR; public downloadable models cannot be disabled.
- **Evidence:** [DOC] help 16152580, 16152686 (AR) (2026-10-19).
- **Adopt:** An owner-chosen audience per project file (public, link holders, named merchants); AR and download follow the stricter level automatically.
- **Not copied:** Password-gate UX; plan gating.
- **Levo:** Partial: `viewerGrants.ts` binds links to an account or an anonymous day-scoped session with a 60-minute TTL; add project audience fields. §16, §05.
- **Limits:** Docs only.

#### D-08 · Crawler and cache hygiene — Sketchfab · P3 · Phase 1
- **Observed:** sketchfab.com robots disallows its internal API and AR redirects; media.sketchfab.com disallows geometry paths and allows thumbnails and fallbacks.
- **Evidence:** sketchfab.com/robots.txt, media.sketchfab.com/robots.txt (2026-10-19).
- **Adopt:** `X-Robots-Tag: noindex` on `/model-viewer/*` and any future `/embed/*`; public thumbnails in a key space separate from private renditions (§16: previews never enter public caches or search engines).
- **Not copied:** Not applicable.
- **Levo:** Mostly present: mesh routes live under `/api/` (disallowed) with `private, no-store` (`worker/routes/printRequests.ts` meshResponse). Add the paths to `worker/routes/seo.ts` and the SPA shell meta. §16.
- **Limits:** robots.txt is advisory, not a control.

#### D-09 · Rights declaration gate — Xometry (pattern) · P3 · Phase 2
- **Observed:** An export-control prompt on quote creation (confirmed controlled, confirmed not controlled, unconfirmed), set per batch or revision; checkout blocked while unconfirmed or mixed; updating a part is rejected when a selection implies a controlled part.
- **Evidence:** [REA-S] ev_5535d0ff… the operation texts, ItarPromptStatus in `a676cfc8…js`, `605deabf…js`.
- **Adopt:** Levonis's equivalent gate is rights: before a request is published or a merchant prints a third-party design, the customer declares ownership or a licence (or links a licensed template), recorded per version. A selection that implies a licence change (for example a commercial quantity) forces re-confirmation (§16; §19 licence fee).
- **Not copied:** Export-control semantics.
- **Levo:** Partial: `worker/lib/fileOwnership.ts`, `entitlements.ts`, licence fields on requests and templates. §16, §17 (a licence is never exceeded automatically).
- **Limits:** A pattern transfer, not a like-for-like feature.

#### D-10 · Gestures with pivot re-targeting — Sketchfab · P1 · Phase 5
- **Observed:** Orbit by default: one finger or left mouse rotates; two fingers, right mouse or Shift+left pans; pinch, wheel or Ctrl+left zooms. Double-tap on the model zooms in and moves the pivot to that point; double-tap on the background zooms out and re-centres on the bounding box. Owners on paid plans can save a pivot and default view. A first-person mode exists.
- **Evidence:** [DOC] help 16152696 (navigation and controls) (2026-10-19).
- **Adopt:** Keep orbit and pinch zoom; add double-tap to set the pivot and double-tap on the background to re-centre. That built-in way back is what makes two-finger pan safe to enable (Levonis turned pan off because a part could drift away with only Reset to recover it). A Reset control and a keyboard map documented in all three languages.
- **Not copied:** Key map, icons, wording; first-person mode.
- **Levo:** Partial: `src/pages/ModelViewer.tsx` sets `enablePan: false` (line 473). Add a ray-cast pick on the CPU-side LVM triangles. §15-أ.
- **Limits:** Help text only; no runtime observation (AWS WAF challenge).

#### D-11 · Spatial annotations and comments — Sketchfab · P1 · Phase 5
- **Observed:** Each annotation has a surface position, a camera position and target, a title (required, ≤64 chars) and an optional Markdown description (≤1024 chars). They form an ordered list with prev/next, a toggle, an automatic tour and an owner default; `?annotation=N` deep-links one; plans cap the count at 10/20/50/100; only the author edits; the original file never changes.
- **Evidence:** [DOC] help 16152328 (annotations) (2026-10-19).
- **Adopt:** Two original uses: (a) owner "explanation points" on product and project viewers (§15-أ); (b) spatial comments in a print request or offer thread ("make this hole 5 mm"), anchored to {file revision, mesh fingerprint, point, normal, camera}, ordered, deep-linkable, visible only to the request parties, and re-anchored or flagged when the revision changes.
- **Not copied:** Numbered-bubble styling, the tour name, plan limits.
- **Levo:** Absent: a `file_annotations` table (file, revision, owner or request scope) and a projected overlay in `ModelViewer.tsx`, tied to request messages (`worker/routes/printRequests.ts`); text in ar/en/ckb. §15-أ, §17, §21.
- **Limits:** Anchoring on coarse meshes is our own problem to solve.

#### D-12 · AR handoff and true scale — Sketchfab · P1 · Phase 5
- **Observed:** For downloadable models, iOS AR downloads the USDZ and opens Quick Look. Premium "app-free AR" converts to USDZ (iOS) or glTF (Android) and gives the device a link; per the help text, the file is then "on your mobile device and no longer linked". Desktop shows a QR code. Password-protected models are not available in AR; the AR redirect path is robots-disallowed. The VR/AR editor has a "World Scale" setting [WS]; users can pinch-scale in Quick Look.
- **Evidence:** [DOC] help 16152686 (2026-10-19); [WS] help 16152684 (app-free AR), 16152315, 16152687; sketchfab.com/robots.txt.
- **Adopt:** iOS AR through Quick Look (USDZ generated server-side from the approved view copy, in metres, at true scale), an Android Scene Viewer fallback beside WebXR, and a desktop QR handoff. AR is disabled with an explanation when the owner chose "no geometry to the device" (§16). A "100% real size" badge, a "restore real size" action after any pinch, bounding-box dimensions in AR, and WebXR hit-test placement. Viewing scale never changes the manufacturing size (§15-ج).
- **Not copied:** Their AR redirect endpoint and branding.
- **Levo:** Partial: `ModelViewer.tsx` supports WebXR `immersive-ar` only (no AR on iOS Safari) with `AR_SCALE 0.001` (mm → m). Add USDZ and GLB derivatives to the §14 pipeline, a short-lived link per grant, and hit-test with a reticle. §15-ج, §16.
- **Limits:** Needs tests on real iPhone and Android devices. Quick Look files can be saved and shared (a signed URL is not unshareable), and users can rescale there.

#### D-13 · Progressive loading and device budgets — Sketchfab · P2 · Phase 5
- **Observed:** A "Loading 3D model" screen, then a top progress bar while higher-resolution textures stream. Textures are optimised at upload; SD or HD by a pixel budget (mobile 6144², desktop 12288²); HD cannot be forced. Guidance: ≤2M polygons on desktop, ≤500k on mobile; a solid background costs no download.
- **Evidence:** [DOC] help 16152722 (SD/HD textures), 16152043 (2026-10-19).
- **Adopt:** Two-stage geometry: the coarse mesh first, the finer one on idle or on request, capped by a device budget (smaller on mobile); a determinate progress bar from Content-Length.
- **Not copied:** Their thresholds as-is; their texture pipeline.
- **Levo:** Partial: `viewerMesh` caps at 250k triangles; `requestFilePolicy.ts` `coarsePreviewMesh` ≤20k; fetch and progress in `ModelViewer.tsx`. §15-أ, §14.
- **Limits:** Their streaming format is unknown.

#### D-14 · Preview and render modes — STLbuddy, Sketchfab · P1 · Phase 2 (Studio), 5 (site viewer)
- **Observed:** STLbuddy (three.js r179 with @react-three/fiber, orbit and transform controls): Assembled, Cavity and X-ray toggles; an exploded-spacing slider; Explode and Assembly animations; Fit view, Front, zoom buttons, reset to three-quarter view; gesture hints including touch; readouts "256 × 256 mm bed · Letter 116.1 × 184.0 mm" and "Z up · Y back · X right"; "Visibility and spacing only affect the preview, not your files"; "Preview colors are for identification only"; a modal when WebGL fails. Sketchfab: modes Default, Shadeless, MatCap, Wireframe; Shadeless skips tangent data and loads faster.
- **Evidence:** [REA-R] SHOT-NM ev_e2d62ffd…, SHOT-MSB ev_e94bae50…; [REA-S] ev_a5f5e664… `bd904a5c-…js` (REVISION 179), `15867-…js`; [DOC] help 16152696, 16152718 (2026-10-19).
- **Adopt:** Assembled, exploded, x-ray and cavity modes; an axis legend; live dimensions in the chosen unit; explicit "preview only" labels (§15: zoom does not change size or price); touch hints; a clay or "raw filament" MatCap shading with a filament tint beside flat and wireframe; a WebGL-unavailable fallback that keeps the measurements visible; only the vertex attributes a mode needs are sent.
- **Not copied:** UI chrome, icons, MatCap textures, hotkey numbers. The store bundle stays three-free: `ModelViewer.tsx` uses ogl (`tests/store-isolation.test.ts`).
- **Levo:** Partial: Studio viewer (three 0.160); `src/pages/ModelViewer.tsx` (ogl, positions only, flat and wireframe). §15-أ, §15-ب.
- **Limits:** The 3D canvas did not render in headless capture (no GPU).

#### D-15 · Print inspector — Sketchfab · P2 · Phase 5
- **Observed:** The Model Inspector shows single-sided, wireframe with colour pick, 3D, 2D texture or side-by-side views, material channels, MatCap and vertex normals, a UV checker and bones. The owner cannot disable it (only hide its icon on Premium) but can disable the 2D texture view.
- **Evidence:** [DOC] help 16152718 (model inspector) (2026-10-19).
- **Adopt:** A print-oriented inspector instead: wireframe, shells, non-manifold and open-edge highlights, an overhang heat map, thin-wall flags and the bounding box on the plate, fed by the server checks (B-15). The lesson: whatever geometry the viewer holds can be inspected; the owner controls only what is sent.
- **Not copied:** UV checker, bones view, layout.
- **Levo:** Partial: viewer metadata already carries shell and triangle counts from `worker/lib/modelGeometry.ts`; overlay in `ModelViewer.tsx` after B-15 lands. §14, §15-أ.
- **Limits:** Sketchfab targets game and VFX assets, not printability.

#### D-16 · Measurement — Sketchfab (absent there) · P2 · Phase 5
- **Observed:** No built-in measuring tool was found in the fetched docs or searches; no dimensions are shown by default.
- **Evidence:** Absence across help 16152696 and 16152718 and WebSearch (2026-10-19).
- **Adopt:** Levonis is already ahead (bounding box in mm, volume, triangles, shells). Add point-to-point measuring with vertex and edge snapping through the D-10 pick, the bounding box drawn in the scene, and a label that the measurement is on the preview mesh (coarse previews are approximate).
- **Not copied:** Not applicable.
- **Levo:** Partial: the Ruler panel in `ModelViewer.tsx`. §15-أ (clear dimensions and units).
- **Limits:** Absence is not proven.

#### D-17 · Printer plate and bed fit — STLbuddy, Sketchfab · P2 · Phase 2 (Studio), 5 (site viewer)
- **Observed:** STLbuddy uses a fixed "256 × 256 mm bed reference" ("Printer reference · optional") and warns "Wider than the 256 mm bed. Reduce Letter height or use a larger printer; exports keep your size." Sketchfab has no plate concept; its VR/AR editor has a floor and a reference character [WS]; its 3D-printing article lists watertight, manifold, wall thickness, under 1M triangles, and price by volume.
- **Evidence:** [REA-S] ev_a5f5e664… 20241, 19140, model-splitter chunk; [REA-R] SHOT-NM ev_e2d62ffd…; [DOC] help 16152049 (3D printing) (2026-10-19).
- **Adopt:** Draw the chosen merchant's (or Studio profile's) real plate with keep-out zones under the part; flag out-of-bed parts and overhang; show orientation. A part that does not fit triggers split suggestions or "needs a larger printer", never a silent rescale. This layout view stays distinct from a post-slicing layer preview (§15-ب).
- **Not copied:** A hard-coded single bed size.
- **Levo:** Partial: `studio/app/printer-profiles.ts`, `plate-packing.ts`; merchant printers (`src/components/merchant/dashboard/PrintersTab.tsx`); a ground grid in `ModelViewer.tsx`. §15-ب, §18.
- **Limits:** None significant.

#### D-18 · Owner default view and orbit limits — Sketchfab · P2 · Phase 5
- **Observed:** The owner sets the default camera (thumbnail and start view) with Save View; Camera Limits constrain orbit and zoom and allow a custom pivot; Camera Limits do not combine with annotations except through the API.
- **Evidence:** [DOC] help 16152696, 16152328 (2026-10-19).
- **Adopt:** Per file revision, a stored default view {eye, target, fov} and optional constraints (for example never from under the plate), so the product-card thumbnail and the viewer's first frame show the same angle.
- **Not copied:** Plan gating; UI.
- **Levo:** Absent: a `view_preset` JSON column on `product_files` and project file revisions, applied in `ModelViewer.tsx`; reads tolerate its absence. §15-أ, §05.
- **Limits:** Docs only.

#### D-19 · Internal viewer controller — Sketchfab · P2 · Phase 3
- **Observed:** The official client library talks to the viewer iframe through a postMessage protocol (ready, initialize with a server-returned member list from which methods are generated, request and result, events), accepting messages only when the origin is the viewer domain and the instance id matches. Docs list camera look-at, screenshot, go to annotation, node map, show and hide, materials [WS].
- **Evidence:** [REA-S] ev_b940ef31… (`sketchfab-viewer-1.12.1.js`, sha256 2fac7133…, 2026-10-19); [WS] developers viewer functions page (not fetched).
- **Adopt:** An internal typed controller (not a public API) for Levo tools and Studio hand-off: set view, show and hide part, set part colour, screenshot, focus annotation, on ready. If it is ever iframe-hosted, use strict origin and instance checks.
- **Not copied:** Message and method names; code.
- **Levo:** Partial: `ModelViewer.tsx` exposes reset, grid, wireframe and AR; extract a reusable component. §11, §17.
- **Limits:** The full function list is unverified.

#### D-20 · Screenshot of the approved view — Sketchfab · P2 · Phase 5
- **Observed:** A screenshot call returns a base64 image of the current view at a given size and type.
- **Evidence:** [WS] developers viewer functions page (2026-10-19, not fetched).
- **Adopt:** Capture the exact angle, colours and parts the customer approved and attach it to the request, offer or order as "what you saw", next to the server thumbnail; only on an explicit user action and under the request's access rules.
- **Not copied:** The API.
- **Levo:** Absent: render to canvas in the ogl viewer and upload through `worker/lib/attachments.ts`. §17, §20.
- **Limits:** Second-hand.

#### D-21 · Part visibility and colour per part — Sketchfab · P2 · Phase 3
- **Observed:** Help articles titled "Building a configurator", "What can and can't a Sketchfab configurator do" and "Managing materials in the Viewer API"; the API changes material colour and hides or moves parts [WS].
- **Evidence:** [DOC] help collection 19704691 (titles, 2026-10-19); bodies not fetched.
- **Adopt:** For multi-part and multi-colour requests and templates: list parts, toggle visibility, assign filament colour per part, show per-part dimensions, so the preview matches the order lines (§17).
- **Not copied:** Their configurator product.
- **Levo:** Absent: the view copy needs per-part ids (LVM has none; shells are only counted in analysis). §17, §12.
- **Limits:** Article bodies unread.

#### D-22 · Inline viewer without a scroll trap — Sketchfab · P2 · Phase 5
- **Observed:** On touch screens a swipe over the viewer rotates the model, so the page cannot scroll past it; disabling the scroll wheel only helps desktop, so the docs advise side gutters; buttons scale with a viewport meta tag; embed size comes from the host CSS.
- **Evidence:** [DOC] help 16152734 (2026-10-19).
- **Adopt:** An inline viewer stays inactive (poster, or `touch-action: pan-y`) until tapped, with an explicit "exit 3D", a 16 px side gutter and fullscreen on demand.
- **Not copied:** Not applicable.
- **Levo:** Absent: the inline component is new; the standalone route uses `touch-none`, which is right only for a full-viewport page. §15-أ, §03.
- **Limits:** Docs only.

#### D-23 · Embed route for Levonis surfaces — Sketchfab · P3 · Phase 3
- **Observed:** The embed is an iframe to `/models/{uid}/embed` configured by URL parameters (autostart, autospin, UI toggles, scroll wheel, preload), some plan-gated. The client library appends non-function init options to the URL, forwards host `?skfb_*` parameters, and defaults the iframe `allow` to "vr; autoplay; fullscreen".
- **Evidence:** [REA-S] ev_b940ef31…; [DOC] help 16152734 (2026-10-19).
- **Adopt:** An embed route for Levonis's own surfaces (stores on `<slug>.levonis-iq.com`, community posts) with a small option set (poster, spin, hint, background) and `frame-ancestors` limited to `*.levonis-iq.com`. Third-party embedding only if the owner's policy allows it.
- **Not copied:** Parameter names, client library code, watermark rules.
- **Levo:** Absent: `/embed/model/:token`. `worker/lib/securityPolicy.ts` sends `frame-ancestors 'none'` and `X-Frame-Options: DENY` for everything, so the change must be per route. §08, §15-أ.
- **Limits:** The client library is the only Sketchfab code inspected (static; Last-Modified 2022-06-14).

#### D-24 · Presentation defaults and Sorani strings — Sketchfab · P3 · ckb now; rest phase 5
- **Observed:** Embed options include an animated entrance, a turntable (a negative speed reverses it) and a navigation hint that can be forced.
- **Evidence:** [DOC] help 16152734; [WS] parameter semantics (2026-10-19).
- **Adopt:** A slow auto-rotate that stops at the first touch and respects `prefers-reduced-motion`, plus a first-use hint in ar/en/ckb.
- **Not copied:** Animations and assets.
- **Levo:** Partial: `ModelViewer.tsx` shows "Drag to rotate · pinch to zoom", but its string table has only ar and en (`lang === 'en' ? en : ar`), so Sorani readers get Arabic, against DECISIONS row 183. Add ckb now. §15-أ, §01 rule 15.
- **Limits:** Docs only.

#### D-25 · Lighting rotation — Sketchfab · P3 · Phase 5
- **Observed:** Users can rotate all lighting (three-finger drag or Alt+left), only the environment, or only real-time lights; lights attached to the camera do not rotate. Owners pick HDRI or solid backgrounds; a solid colour needs no download.
- **Evidence:** [DOC] help 16152696, 16152043 (2026-10-19).
- **Adopt:** One "rotate light" gesture or button to reveal surface detail; solid or gradient backgrounds only (no HDRI download on mobile).
- **Not copied:** HDRI library.
- **Levo:** Partial: shader uniforms in `ModelViewer.tsx`. §15-أ.
- **Limits:** Docs only.

#### D-26 · VR mode — Sketchfab · P3 · Phase 6
- **Observed:** WebXR VR in Chrome and Oculus Browser with teleport and scale controls and a quality parameter; Cardboard support dropped; opt-in from the viewer.
- **Evidence:** [WS] help 16152690, 16152687 (2026-10-19, not fetched).
- **Adopt:** Defer (§15-د). If built, reuse the AR WebXR plumbing with `immersive-vr`; never required for ordering.
- **Not copied:** Everything; low value for printed parts.
- **Levo:** Absent. §15-د.
- **Limits:** Second-hand evidence.

---

## E. Community, projects, discussions and reputation (§04, §05, §22)

| ID | Feature | References | Levo today | P | Phase |
|---|---|---|---|---|---|
| | **Projects, files, versions and licences (§05)** | | | | |
| E-01 | Project page as the hub | MakerWorld, Behance | Partial | P1 | 4 |
| E-02 | File roles: source, production profile, display mesh | MakerWorld | Partial | P1 | 4 |
| E-03 | Several print profiles per project | MakerWorld | Absent | P1 | 4 |
| E-04 | Makes attached to a profile and version | MakerWorld, Printables | Absent | P1 | 4 |
| E-05 | Make and rating prompt after delivery or export | MakerWorld | Absent | P2 | 4 |
| E-06 | Honest counters and distinct signals | MakerWorld, Behance | Partial | P2 | 4 |
| E-07 | Immutable versions with a changelog | MakerWorld, GitHub | Absent | P1 | 4 (pin 2) |
| E-08 | Licence picker, rights card, remix lineage | MakerWorld, GitHub, STLbuddy | Absent | P1 | 4 (template rights 2) |
| E-09 | Provenance: generated and AI disclosure | MakerWorld, Printables | Partial | P2 | 4 |
| E-10 | Creator page, credits and analytics | MakerWorld, Behance | Partial | P2 | 4 |
| E-11 | File-problem reports separate from Q&A | GitHub | Absent | P2 | 4 |
| | **Discussions and spaces (§04)** | | | | |
| E-12 | Help questions with an accepted answer | Reddit, GitHub | Absent | P1 | 4 |
| E-13 | Helpful ranking for answers | Reddit | Absent | P2 | 4 |
| E-14 | Feed sorts with decay and an explanation | Reddit | Partial | P1 | 4 |
| E-15 | Reactions without downvotes; hidden early counts | Reddit | Partial | P2 | 4 |
| E-16 | Controversial sort | Reddit | Not adopted | P3 | — |
| E-17 | Post kinds per space | Reddit | Partial | P2 | 4 |
| E-18 | Interest spaces as forum boards | Reddit, Discord, Circle | Absent | P2 | 4 |
| E-19 | Space labels | Reddit | Partial | P2 | 4 |
| E-20 | Comment threads: collapse and paging | Reddit | Partial | P2 | 4 |
| E-21 | Comment editing with marker and history | Reddit | Absent | P2 | 4 |
| E-22 | Follow a discussion; notification levels; auto-archive | Discord | Partial | P2 | 4 |
| E-23 | Polls | Reddit | Absent | P3 | later |
| E-24 | Scheduled recurring threads | Reddit | Absent | P3 | 4 |
| | **Collections, search and discovery (§04)** | | | | |
| E-25 | Collections (many-to-many, sections, search) | Pinterest, Reddit, MakerWorld | Partial (structural gap) | P1 | 4 |
| E-26 | Visual grid and "more like this" | Pinterest | Partial | P2 | 4 |
| E-27 | Search sorts, windows, comment search, scope | Reddit | Partial | P2 | 4 |
| E-28 | For You with negative feedback and diversity | Reddit | Partial | P2 | 4 |
| E-29 | Shape descriptors: duplicates first | Thangs | Absent | P3 | 6 |
| | **Reputation, rewards and events (§22)** | | | | |
| E-30 | Community reputation ledger | Reddit, Printables, Circle, MakerWorld | Partial (merchants only) | P1 | 4 |
| E-31 | Scarce appreciation tokens | MakerWorld | Absent | P2 | 4 |
| E-32 | Achievements and leaderboards | Reddit, Circle | Absent | P3 | 4 |
| E-33 | Non-monetary level unlocks | Circle | Absent | P3 | 4 |
| E-34 | Paid awards and virtual currency | Reddit | Not adopted | P3 | — |
| E-35 | Contests | MakerWorld | Absent | P2 | 4 |
| E-36 | Engagement game teaching real costs | STLbuddy | Present | P3 | — |

#### E-01 · Project page as the hub — MakerWorld, Behance · P1 · Phase 4
- **Observed:** A MakerWorld model has raw files in folders, 3MF print profiles, separate web (4:3) and app (4:3 or 3:4) covers with a crop tool, title, description, category, tags, licence, upload type (Original or Remix), visibility, video by URL, an optional BOM and an optional synced community post; the April 2024 redesign simplified the right-hand panel. Behance requires a cover (shown at 202×158, uploaded at least 808×632), a title and creative fields to publish; tags and "Tools Used" are optional; content sits on a reorderable canvas; drafts are possible; projects do not autosave.
- **Evidence:** [DOC] wiki how-to-upload-models; release notes RN 20240417 #4, RN 20240510 #5 (2026-10-19). [WS] help.behance.net/hc/en-us/articles/204483684, /204483484 (the page returned 403; www.behance.net robots disallow Claude agents).
- **Adopt:** One project page in clear sections: gallery (a real print photo required as cover), goal and instructions, files, print profiles, BOM, makes, questions. The side panel keeps one primary action: order a print, customise, or download when allowed. A publish-readiness check: cover with a correct aspect ratio (no stretching, §03), title and category required; printer, material and tools optional. An ordered block canvas (images, video, steps, before/after) with autosave.
- **Not copied:** Layouts, wording, the "Boost Me" badge, Behance's creative-fields taxonomy, brands.
- **Levo:** Partial: `src/pages/community/Project.tsx`; `community_posts` (0153: kind, print_settings, dimensions, store, product, request and order links); `src/components/community/projects` (MediaPicker, MediaStrip, SpecList); media dimensions (0099). §05.
- **Limits:** Live pages not observed (MakerWorld challenge; Behance blocked).

#### E-02 · File roles: source, production profile, display mesh — MakerWorld · P1 · Phase 4
- **Observed:** About 30 raw formats (stl, step, 3mf, scad, f3d, obj …) are kept apart from Bambu Studio 3MF print profiles, which carry arrangement, orientation, per-object parameters, painted colours and the target printer; a user prints a profile from the phone without configuring anything.
- **Evidence:** [DOC] wiki how-to-upload-models (2026-10-19).
- **Adopt:** Every file has a role: source, production profile, display mesh or thumbnail. Each production profile is bound to printer, nozzle, material SKU and engine version (§05).
- **Not copied:** Bambu's 3MF profile schema. Levo Studio output is never presented as a Bambu print profile (`export-manager.ts` already says it is unavailable).
- **Levo:** Partial: `community_post_files.kind` is only `model | document`; add role, engine version and printer and material links; storage on R2. The Production Package (C-22) depends on these roles. §05, §14.
- **Limits:** MakerWorld's internal 3MF metadata unknown.

#### E-03 · Several print profiles per project — MakerWorld · P1 · Phase 4
- **Observed:** Anyone can add a print profile to a published model. Order: the designer's own, then designer-recommended, then everyone else's; designers can reorder. A third-party uploader can pass the reward to the designer; the first profile on a model is rewarded [WS].
- **Evidence:** [DOC] RN 20231207 #1, RN 20240311 #6, how-to-upload-models; [WS] forum points thread (2026-10-19).
- **Adopt:** A `project_print_profiles` entity (author, printer, nozzle, material SKU, plates, time, grams, tested flag, print photos). Order: owner, recommended, then community by make rating. Merchants can add "tested on our printers" profiles linked to their capability records (§18).
- **Not copied:** Point-gifting mechanics and values.
- **Levo:** Absent: a new table and a profiles tab in `Project.tsx`, linked to `merchantPrinters.ts` capabilities. §05, §18.
- **Limits:** Ranking inside the community tier unknown.

#### E-04 · Makes attached to a profile and version — MakerWorld, Printables · P1 · Phase 4
- **Observed:** On MakerWorld a rating belongs to a print profile, not the model; users are invited to rate after printing; 1–3 stars need a reason; photos and settings are encouraged; self-rating is prohibited; users can delete their own low rating; "Top" sorts photos and likes first; the guidelines separate the print result from design discussion with a table of creator-fixable vs user-fixable issues. On Printables a make is a photo of a printed model attached to it; it is rewarded only when the photo matches and only for a user's first make of that model; profiles count models, makes and collections [WS].
- **Evidence:** [DOC] wiki rating-guidelines; RN 20240104 #2, #12; RN 20231207 #5; RN 20240311 #7; Bambu Handy tutorial step 6; help.prusa3d.com/article/how-do-prusameters-on-printables-work_365065 (2026-10-19); [WS] printables.com profile snippet.
- **Adopt:** A "make" is a member's print result: photos, printer, material, colour, settings changes, stars, and an issue tag (creator-fixable or environment), attached to a profile and version and counted on both the project and the maker's page. It stays separate from likes and from verified-purchase reviews (§05, §22). Low scores need a reason; owners cannot rate their own work; disputes go to manual review, not silent deletion.
- **Not copied:** Wording, star UI, Printables naming.
- **Levo:** Absent: add `make` to the `community_posts.kind` CHECK (0153 allows project, post, tutorial, timelapse, before_after) through an additive migration with a parent post and version link, or a `community_makes` table; `worker/routes/reviews.ts` stays order-linked. §04, §05, §22.
- **Limits:** Aggregation unknown; printables.com model pages were challenged.

#### E-05 · Make and rating prompt after delivery or export — MakerWorld · P2 · Phase 4
- **Observed:** A dev fixture links design → profile → plate → device → filament mapping → status → feedback status → slicing mode → bed type; the Studio home has print-history commands.
- **Evidence:** [REA-S][CODE] ev_e303bcef… BambuStudio@79df7ae `resources/web/homepage3/js/test.js` (Test_PrintTaskList, about lines 59–106), `js/home.js`.
- **Adopt:** When a community order is delivered, or a Studio export of a profile completes, queue a "share your make / rate this profile" prompt prefilled with printer and material, with a feedback status per job.
- **Not copied:** Field names and data model.
- **Levo:** Absent: `communityOrderTimeline.ts` and `community_posts.community_order_id`; Studio `project-sync.ts`. §05, §20.
- **Limits:** That production drives prompts from the feedback status is inferred; the fixture is dev data.

#### E-06 · Honest counters and distinct signals — MakerWorld, Behance · P2 · Phase 4
- **Observed:** MakerWorld shows downloads and prints separately (they used to be combined as downloads + 2 × prints); downloads are de-duplicated across a model's profiles per user; a customiser download counts once; printing a customised file counts as a print. A 2019 Behance redesign has separate Appreciate, Save, Follow and Share actions [WS].
- **Evidence:** [DOC] RN 20240104 #3, RN 20231207 #2, RN 20240510 #2, RN 20240628 #2 (2026-10-19); [WS] abduzeedo.com (2019).
- **Adopt:** Count each event once per user, project and kind; show views, saves, downloads, makes and orders separately and never inflate them (§01.16). Like, save, follow, make and verified review stay separate signals in the UI and in ranking.
- **Not copied:** Reward formulas; naming and icons.
- **Levo:** Partial: counters on `community_posts` (0154 triggers), `community_post_files.downloads`; `community_likes`, `community_saves`, `user_follows` (0154); `merchant_reviews`. Add makes and orders counts. §05.
- **Limits:** De-duplication windows unknown; the Behance source is old.

#### E-07 · Immutable versions with a changelog — MakerWorld, GitHub · P1 · Phase 4 (order pin in phase 2 via C-10)
- **Observed:** MakerWorld designers can notify profile uploaders when the geometry changes; published models and profiles are edited in place, including replacing the 3MF. GitHub releases are tag-based; notes are written or generated from merged pull requests between tags, grouped by label; a release holds up to 1000 assets under 2 GiB each with creation dates; source archives are added automatically; anyone with read access can view and compare; users can subscribe to releases only.
- **Evidence:** [DOC] RN 20240104 #9; how-to-upload-models; docs.github.com …/about-releases, …/automatically-generated-release-notes (2026-10-19).
- **Adopt:** Published versions are immutable, with a file-hash snapshot, a changelog entry, a link to the previous version and a compare view. New geometry means a new version; dependent profiles, makes and templates are marked "made for vN"; orders pin the version (C-10); followers can subscribe to new versions only; statuses current, deprecated, unsupported.
- **Not copied:** Editing files already used in place; the Git and pull-request model; naming.
- **Levo:** Absent: there is no version table for posts or projects (only `product_files` and `community_post_files` in 0157). Add `project_versions` (number, files hash, changelog, supersedes, status) referenced by requests and orders; Studio `project-store.ts`. §05, §12 (source version), §14.
- **Limits:** MakerWorld's internal versioning unknown.

#### E-08 · Licence picker, rights card and remix lineage — MakerWorld, GitHub, STLbuddy · P1 · Phase 4 (template rights phase 2 via B-22)
- **Observed:** MakerWorld: minor edits (scale, cut, recolour, fix, add text) are not a remix; the source link must point to the exact source; ND forbids derivatives, SA requires the same licence, incompatible multi-source licences are forbidden; CC0 needs your own print photo; profiles under its standard digital licence or ND cannot change geometry; designers are notified of remixes. GitHub: without a licence default copyright applies, yet public repositories can still be viewed and forked under GitHub's terms; the licence file is detected and shown; a fork shows its upstream. STLbuddy's library generates a plain-language explainer from the SPDX id (CC0 → public domain; otherwise credit and link; NC → noncommercial only, else commercial allowed; ND → do not share adaptations; SA → share alike; else adaptations allowed) with facets for commercial use, attribution, licence and remix.
- **Evidence:** [DOC] wiki model-upload-guidelines, print-profile-upload §9, exclusive-model-guideline, RN 20240104 #8; docs.github.com …/licensing-a-repository, …/about-forks (2026-10-19); [REA-S] ev_a5f5e664… `26157-…js`, export-sharing module 52408.
- **Adopt:** A licence per project version from a vetted closed list (a Levonis "all rights reserved / view only" option plus Creative Commons variants) with a generated plain-language rights card in ar/en/ckb: may I print it, sell prints, adapt it; attribution; and "buying a print does not grant the source" (§12). Remix only when both the licence and the owner allow; a mandatory internal source link, a compatibility check, a notice to the source owner, and a lineage tree. A remix inherits privacy constraints; a selection that implies a licence change forces re-confirmation (D-09).
- **Not copied:** MakerWorld's licence texts; GitHub's automatic fork rights on public content (§05, §16); STLbuddy's text.
- **Levo:** Absent: grep finds no licence or remix column. Add `licence_code`, `remix_policy`, `remix_of_post_id` and version on posts or templates; enforce a server-side "remix" permission next to `viewer_grants` (0157). §05, §12, §16.
- **Limits:** Licence wording needs an owner and legal decision (record in DECISIONS.md).

#### E-09 · Provenance: generated and AI disclosure — MakerWorld, Printables · P2 · Phase 4 (generator id recorded from phase 2)
- **Observed:** The MakerWorld sitemap has a generative-model category with sub-categories for lithophane, Make My Sign, Make My Vase, pixel puzzle, relief and AI Scanner; MakerLab outputs are excluded from its exclusive programme; a fixture field marks MakerLab customisation. Printables' changelog (Feb 2026) made an AI-usage disclosure required when creating or editing a model, mixed free and paid results by default, and (Jan 2026) added a purchase button to the file list [WS].
- **Evidence:** [DOC] makerworld.com/sitemap/sitemap-categories-2-0.xml (2026-10-19); wiki exclusive-model-guideline; [REA-S] ev_e303bcef… `test.js`; [WS] printables.com/article/printables-changelog-VNGborZ.
- **Adopt:** A required provenance field: original, remix, made with a Levo tool (`generator:<tool>@<version>`), or AI / image-to-3D. A "made with a Levo tool" badge and filter. Generated items are excluded from originality rewards and contests unless the rules say otherwise. Free, paid and print-only items are clearly labelled in mixed results (§13).
- **Not copied:** Category names and labels.
- **Levo:** Partial: `image_provenance` (0048). Add source, generator and provenance columns on `community_posts`; labels in `worker/routes/communitySearch.ts`. §05, §11, §13, §22.
- **Limits:** Printables evidence is a snippet.

#### E-10 · Creator page, credits and analytics — MakerWorld, Behance · P2 · Phase 4
- **Observed:** MakerWorld profiles live at `@handle`; creator fields include fans, follows, certification, level and grade [REA-S fixture]; each model has an analytics board (views, downloads, prints, collects, impressions, conversion); the Creator Center shows the most-searched terms; email notifications and @mentions exist. Behance co-owners must accept an invitation, and the project then appears in every co-owner's portfolio; credits list names; non-members can be invited by email [WS].
- **Evidence:** [DOC] RN 20240311 #4–#5, RN 20240104 #2, RN 20240417 #3, exclusive-model-guideline (2026-10-19); [REA-S] ev_e303bcef… designCreator fixture; [WS] help.behance.net/hc/en-us/articles/204483494; adobe.com behance-for-teams.
- **Adopt:** The creator page aggregates projects, profiles, makes, templates and the store link. A verified badge appears only for real verification (a designer is not a KYC'd merchant, §05). Real per-project analytics, and "what people search for" from search logs. Project collaborators with an accept step and credit roles (designer, printer, finisher, manufacturing merchant), without merging accounts.
- **Not copied:** The level and grade scheme; Behance terms and UI.
- **Levo:** Partial: `src/pages/community/Creator.tsx`; the `worker/routes/merchantAnalytics.ts` pattern; `communitySearch.ts`. Add `project_credits` with consent (like `consent_status`, 0153). §05, §12.
- **Limits:** Level formula unknown; Behance is snippet-only.

#### E-11 · File-problem reports separate from Q&A — GitHub · P2 · Phase 4
- **Observed:** Issues track bugs and tasks with sub-issues, dependencies, labels, types and assignees. Discussions have categories and Q&A with mark-as-answer, pin, lock, close and polls; an issue can be converted into a discussion.
- **Evidence:** [DOC] docs.github.com …/about-issues, …/about-discussions (2026-10-19).
- **Adopt:** On each project, a "problem with this file" report that the owner resolves with "fixed in version X", kept separate from a Q&A thread with an accepted answer; moderators can convert between the two.
- **Not copied:** GitHub UI and terms.
- **Levo:** Absent: `community_reports` (0154) covers moderation only. Add a project-issue type (or a comment kind). §05, §04.
- **Limits:** Docs only.

#### E-12 · Help questions with an accepted answer — Reddit, GitHub · P1 · Phase 4
- **Observed:** Reddit has a Q&A comment sort and Q&A-style community defaults; the historical "qa" sort rewards threads the original poster answered. No native accepted answer was found; communities use a "Solved" flair [INF]. GitHub Discussions has mark-as-answer (E-11).
- **Evidence:** [WS] support.reddithelp.com article 15484546290068 "Community settings" (2026-10-19); [CODE] github.com/reddit-archive/reddit `r2/r2/lib/db/_sorts.pyx` (WebFetch summary, CPAL-1.0, historical); [DOC] docs.github.com …/about-discussions.
- **Adopt:** A first-class «سؤال مساعدة» kind with structured fields (printer, material, photo of the problem). The author, or staff, marks one comment as the accepted answer; it is pinned under the question and the question becomes solved. A "needs answer" filter in the help space. An accepted answer is a reputation event (E-30).
- **Not copied:** Stack Overflow branding. This is an original design.
- **Levo:** Absent: add `question` to POST_KINDS (`worker/routes/communityPosts.ts:65`; the CHECK is in 0153, so an additive migration); `accepted_comment_id` and `solved_at` on posts; `POST /posts/:id/accept {comment_id}`, author only, audited; an accepted badge in `CommentsSheet.tsx`; reuse the merchant_question / customer_answer pattern from `src/components/community/requests/Discussion.tsx`. §04 (accepted answers in help questions).
- **Limits:** Reddit offers no documented reference for accepted answers.

#### E-13 · Helpful ranking for answers — Reddit · P2 · Phase 4
- **Observed:** The historical "best" comment sort ranks by the lower bound of a Wilson score interval at 80% confidence on up / (up + down), with 0 when there are no votes; "qa" adds the question's confidence to the confidence and length of the original poster's best answer. Moderators can suggest a default comment sort (none, Q&A, top, live); comment search sorts by relevance, top or new.
- **Evidence:** [CODE] `_sorts.pyx` (WebFetch, 2026-10-19, CPAL, historical); [WS] support articles 15484546290068, 19695647891988.
- **Adopt:** Rank answers and comments marked "helpful" by a confidence lower bound (public statistics, implemented independently), so 3 of 3 does not beat 95 of 100. Each space or post kind gets a suggested default comment sort: oldest for discussion, helpful for help questions.
- **Not copied:** The CPAL source, its lookup table, its 80% constant as-is; we choose and document our own level.
- **Levo:** Absent: `community_comment_votes (user_id, comment_id)` with a counter trigger as in 0154; `?sort=oldest|newest|helpful` on `GET /posts/:id/comments` (`communitySocial.ts:281`); a sort control in `CommentsSheet.tsx`. §04 ("helpful").
- **Limits:** Reddit's current comment ranking is not observed.

#### E-14 · Feed sorts with decay and an explanation — Reddit · P1 · Phase 4
- **Observed:** Hot is the default on a community page and favours recent posts gaining upvotes (one version adds comments); New ignores votes; Top uses votes and comments with a time window; Rising favours "posts with the most recent views"; signed-in users can change the default; the help text warns that new posts can be buried under Hot. The Devvit client exposes hot, new, top, rising, controversial and best listings. The historical hot formula is sign × log10(|score|) + age / 45000 s, so 10× the votes buys 12.5 h of freshness.
- **Evidence:** [WS] support article 19695706914196 (2026-10-19); [DOC] developers.reddit.com/docs/api/redditapi/RedditClient/classes/RedditClient (HTTP 200, 2026-10-19); [CODE] `_sorts.pyx`.
- **Adopt:** An explicit sort control with the spec's names: جديد (new), أتابعهم (following), شائع (popular, time-decayed), مفيد (helpful), تجارب مؤكدة (verified makes); Top with a window (week, month, all). Popular is a decayed score over saves, comments, makes and likes in which saves and verified makes weigh more than likes, so likes alone never decide (§04). The chosen sort is remembered per tab, with a one-line "why it ranks here".
- **Not copied:** Reddit's constants, the CPAL code, Hot and Rising as vocabulary. Reddit's current ranking is closed; no parity is claimed.
- **Levo:** Partial: `GET /feed` (`worker/routes/communitySocial.ts:690`) and `GET /posts` (`communityPosts.ts:264`) sort by `published_at DESC` only; `/posts/trending` (`communityPosts.ts:312`) uses like×3 + comment×4 + save×5 + view over 30 days with no decay. Add `?sort=&window=`, compute popular in SQL from the 0154 counters with a decay term, use a cursor that snapshots the score, and persist the choice in the URL plus a try/catch localStorage (as `hub/tabs.ts` does). §04.
- **Limits:** The help pages define each sort in one line; Rising and current Hot weights are unknown; the 45000 s constant comes from archived code.

#### E-15 · Reactions without downvotes; hidden early counts — Reddit · P2 · Phase 4
- **Observed:** An upvote means the item adds to the conversation, a downvote that it is off-topic; votes decide what surfaces. Counts are withheld for the first few hours and communities may hide scores; the displayed score is net; vote fuzzing exists; manipulation is prohibited.
- **Evidence:** [WS] support articles 7419626610708, 204511579, 205926439 (Reddiquette) (2026-10-19).
- **Adopt:** No public downvotes on makers' and merchants' work (in a marketplace a downvote harms livelihoods). Keep one positive reaction plus a private "show fewer like this" and the report flow. Hide counts for the first hours on new posts so early likes do not snowball. Anti-manipulation: one reaction per account, rate limits, reactions from blocked or very new accounts ignored.
- **Not copied:** Downvotes, the fuzzing algorithm, karma vocabulary.
- **Levo:** Partial: `PUT /posts/:id/like` (`communitySocial.ts:111`) is idempotent by primary key, capped at 240/h, with 0154 counter triggers. Add `hide_counts_until` (published_at + N h) applied in `postCard()` (`communityPosts.ts:89`) for non-authors. §04 (popularity never by likes alone).
- **Limits:** Fuzzing method and hiding duration undocumented.

#### E-16 · Controversial sort — Reddit · P3 · Not adopted
- **Observed:** Controversial is listed as a sort and exposed by the Devvit client; the historical formula scores items highest when up and down votes are balanced; the help pages do not define it.
- **Evidence:** [DOC] RedditClient reference; [CODE] `_sorts.pyx`; [WS] support article 19695706914196 (2026-10-19).
- **Adopt:** Not adopted. Levonis has no downvotes, and surfacing conflict harms a maker marketplace; disputes belong in the §09 complaint and dispute flows.
- **Not copied:** The sort.
- **Levo:** None; recorded so the decision is explicit (§02).
- **Limits:** Current formula unknown.

#### E-17 · Post kinds per space — Reddit · P2 · Phase 4
- **Observed:** Moderators toggle text, links, images and galleries, videos, AMAs, polls and reposts separately; videos are not allowed in private or mature communities; moderators may use types prohibited to users; the composer offers only enabled types.
- **Evidence:** [WS] support articles 15484546290068, 360060422572 (2026-10-19).
- **Adopt:** A closed list of kinds per §04 (post, question, project, make, tutorial, merchant update, timelapse, before/after). Each space declares the kinds it accepts and the composer offers only those; staff may post any kind.
- **Not copied:** AMA and repost concepts; Reddit's names.
- **Levo:** Partial: POST_KINDS is project, post, tutorial, timelapse, before_after (`communityPosts.ts:65`). Add question, make and merchant_update additively; `allowed_kinds` JSON on `community_spaces`, enforced in `POST /posts` (`communityPosts.ts:822`) and read by `ComposerDock.tsx` and `ProjectComposer.tsx`. §04.
- **Limits:** The composer UI was not observed.

#### E-18 · Interest spaces as forum boards — Reddit, Discord, Circle · P2 · Phase 4
- **Observed:** Each Reddit community has its own settings (post types, default comment sort, hidden scores, collapse of removed comments, rules, flair, trust filters); muting a community removes it from notifications, home and popular; apps add tools per community. A Discord forum channel accepts only threads; its topic is shown as "Guidelines" on the composer; tags come from an allowed list and one can be required; moderators may let everyone create tags and set a default reaction; per-user rate limits apply to posts and messages; pinned posts never auto-archive; locked posts block edits by non-moderators; the archive is searchable; forums can be role-private. Circle organises a community into spaces (posts, images, chat, events with RSVP and live sessions, courses), each with access and visibility settings.
- **Evidence:** [WS] support articles 15484546290068, 9810475384084 (2026-10-19); [DOC] developers.reddit.com intro-mod-tools; discord.com/blog/forum-channels-space-for-organized-conversation (2022-09-14), discord.com/developers/docs/topics/threads; circle.so/_llms/help.md (2026-10-19).
- **Adopt:** Staff-created interest spaces (printers, materials, design, maintenance, per §04) that users follow or mute. Each space has guidelines in ar/en/ckb shown in the composer, rules, allowed kinds (E-17), a required label from a curated list (E-19), a pinned FAQ, lock and archive, a default sort, slow mode for new accounts and a trust level (F-07). Platform-run first; delegated moderators later with scoped permissions.
- **Not copied:** User-created communities from day one; "r/" naming; Discord UI and bot API; Circle paywalls.
- **Levo:** Absent: `community_spaces` (slug, three names, guidelines, rules, settings JSON), follows and mutes, `posts.space_id`; the "following" feed includes followed spaces (`communitySocial.ts:690`); a hub tab or filter in `src/components/community/hub/tabs.ts`; hashtags exist (0041). §04 (interest spaces with less notification noise).
- **Limits:** Full settings pages not read; the Discord help centre was blocked.

#### E-19 · Space labels — Reddit · P2 · Phase 4
- **Observed:** Moderators create post-flair templates and can require one (this works only when templates exist and users may assign them); user flair is enabled per community and the user chooses whether it shows; flair set by AutoModerator leaves no log entry. The Devvit client has flair template operations and a flair-update trigger.
- **Evidence:** [WS] support articles 15484545678996, 15484540805012; [DOC] developers.reddit.com triggers page, RedditClient (2026-10-19).
- **Adopt:** Staff-curated labels per space, each with three translations (for example «تم الحل», «يحتاج مساعدة», PLA, Bambu X1). The help space can require a label; labels are filterable. The user-side equivalent is existing badges (PRO, verified merchant) plus earned reputation badges; optional ones are the user's choice.
- **Not copied:** The word "flair" in UI text; emoji styling; free-text user flair (an abuse risk).
- **Levo:** Partial: posts have free tags (POST_TAGS_MAX 10) and catalogue printer and material links (`communityPosts.ts`). Add `community_labels (space_id, key, name_ar, name_en, name_ckb, colour, required)` and `posts.label_id`, filtered in `GET /posts`; badges from `membershipBadges()` (`worker/lib/entitlements.ts`). §04.
- **Limits:** Template limits and styling not observed.

#### E-20 · Comment threads: collapse and paging — Reddit · P2 · Phase 4
- **Observed:** Comments from blocked users are collapsed but expandable; trust filters can collapse comments from untrusted members; likely spam is auto-collapsed and labelled; a setting collapses removed comments behind a click. Deep nesting with per-branch collapse is inferred.
- **Evidence:** [WS] support articles 4413520308372, 15484545006996, 32042638057748, 15484546290068 (2026-10-19); nesting [INF].
- **Adopt:** Keep Levonis's single reply level (easier on mobile and in RTL). Collapse long reply groups ("show 5 replies") with paging; collapse removed stubs by default; show held or low-confidence comments collapsed with a label instead of dropping them silently; announce each collapse state to screen readers.
- **Not copied:** Deep infinite nesting; thread lines; the "Potential Spam" wording.
- **Levo:** Partial: `communitySocial.ts:281` serves comments oldest first at one level (a reply to a reply is filed under the root), and a removed stub keeps its replies; `CommentsSheet.tsx:178-190` builds threads with no collapse. Add collapse state, a replies cursor per root (`GET /comments/:id/replies`) and a `collapsed` flag in `commentPublic()`. §04 (organised threads).
- **Limits:** Reddit's paging limits not observed.

#### E-21 · Comment editing with marker and history — Reddit · P2 · Phase 4
- **Observed:** An "Edited" moderation queue shows only edited content; a help article on editing exists (body not read); locking a post still lets members edit their existing comments; the Devvit client lists edited items.
- **Evidence:** [WS] support articles 15484440494356, 15484642147988; [DOC] RedditClient (2026-10-19); edit-window rules [INF].
- **Adopt:** Comment edits within a window, with an «عُدّل» marker and a timestamp. Previous bodies are kept for staff (audit); an edit of an already-reported item goes back to the review queue.
- **Not copied:** A grace period for unmarked edits; UI.
- **Levo:** Absent: there is no `PATCH /comments/:id` in `communitySocial.ts`. Add it with the decency check (`isIndecent`, `worker/lib/nameGuard.ts:285`), `community_comment_revisions`, `edited_at`, and re-opening a matching `community_reports` row when the target changed. §04 (clear edit rights), §09 (audit).
- **Limits:** Edit-window behaviour undocumented.

#### E-22 · Follow a discussion; notification levels; auto-archive — Discord · P2 · Phase 4
- **Observed:** Threads auto-archive after inactivity (sooner when a server nears its limit); each thread tracks members with notification flags; archived threads stay listable and searchable; only moderators or the creator change the name, archive state or archive delay. Per-server and per-channel levels (all messages, mentions only, nothing) and timed mutes are inferred.
- **Evidence:** [DOC] discord.com/developers/docs/topics/threads (2026-10-19); levels [INF] (support.discord.com returned 403).
- **Adopt:** "Follow this discussion" with a level per thread or space (all, replies to me, none); mutes with an expiry; digest batching; auto-archive of inactive help threads, reopened on reply.
- **Not copied:** Discord's notification UI and copy.
- **Levo:** Partial: `user_notifications`, `user_notification_channels`, `merchant_notification_preferences` (0124), `user_mutes` (0154). Add `thread_subscriptions`. §04 (customisable notifications).
- **Limits:** Partly inferred.

#### E-23 · Polls — Reddit · P3 · Later
- **Observed:** Polls are a post type moderators must enable; a 2025-08-07 changelog segments results between general voters and "core contributors" (active in the community in the last month). Option limits and duration were not found.
- **Evidence:** [WS] support article 15484546290068, changelog 40018943136660 (2026-10-19).
- **Adopt:** Optional and later: one server-counted vote per account; results split by verified owners of that printer or material versus everyone (useful for "which filament for X").
- **Not copied:** Reddit's poll UI and its core-contributor definition.
- **Levo:** Absent: `community_poll_options` and `community_poll_votes (post_id, user_id)` attached to `kind=question`. §04 (not explicitly required).
- **Limits:** Duration, maximum options and visibility before voting unknown.

#### E-24 · Scheduled recurring threads — Reddit · P3 · Phase 4
- **Observed:** Moderators can schedule posts and set them to recur.
- **Evidence:** [WS] support article 15484443169556 (2026-10-19).
- **Adopt:** Staff can schedule a recurring pinned thread in a space (a weekly "show your print", a monthly maintenance Q&A), published by the existing cron.
- **Not copied:** Reddit's scheduler UI.
- **Levo:** Absent: a `scheduled_at` column on `community_posts` (draft → published by cron), reusing `POST /posts/:id/publish` (`communityPosts.ts:929`). §22 (events).
- **Limits:** Title and extract only.

#### E-25 · Collections (many-to-many, sections, search) — Pinterest, Reddit, MakerWorld · P1 · Phase 4
- **Observed:** Pinterest: saving opens a board list with inline create (long-press on mobile); boards live in the profile's Saved tab; sections hold sub-themes; a board can be merged into another board's section; secret boards are visible only to the owner and invited collaborators; group boards let collaborators add and edit; the mobile grid defaults to two wide with Wide (1) and Compact (3) options; "Find more ideas" sits below a board. Reddit saves posts and comments into a Saved tab; named collections were not found [WS]. MakerWorld has public collections, including a per-user default and up to 200, tag pages, 76 categories in 10 locales, "Customizable" and "Maker's Supply" filters, an NSFW hide toggle, fuzzy search and prediction.
- **Evidence:** [DOC] create.pinterest.com/product-features/how-to-create-boards/ (2026-10-19; help.pinterest.com robots disallow Claude agents); [WS] support articles 205243605, 360043483511; [DOC] makerworld.com sitemaps (index, favorites, tags, categories); RN 20240104 #10, RN 20240628 #3, RN 20240311 (2026-10-19).
- **Adopt:** First-class collections (name, description, cover, public or private, optional sections, collaborators later). Saving is many-to-many through a "Save to…" sheet with inline create. Saved comments, so a helpful answer can be bookmarked. Search and filter inside saves; a public collection page with "more like this". Tag pages and filters such as "customisable", "has BOM" and "has a verified profile". Saving stays private and notifies nobody.
- **Not copied:** Pin and board names, UI, visual identity; taxonomy wording.
- **Levo:** Partial with a structural gap: `community_saves` has `PRIMARY KEY (user_id, post_id)` and one free-text `collection` column (0154), so a post can sit in only one collection and saving it again moves it (`worker/routes/communitySocial.ts:155-170`); `GET /saved` (`:188`) cannot filter by collection; `src/pages/community/Saved.tsx` is one flat list. Add `community_collections` and `collection_items` with an additive migration that maps the existing names, keep reading the old column while the new tables are absent, and add `?collection=&q=` to `/saved`. §04 (public or private collections, search inside saves).
- **Limits:** The Pinterest help centre was not loaded.

#### E-26 · Visual grid and "more like this" — Pinterest · P2 · Phase 4
- **Observed:** Boards and feeds use a masonry grid that keeps each image's natural aspect ratio, with "Find more ideas" and related pins. Camera search (Lens) and Shop the Look are known only from 2017 press [WS].
- **Evidence:** [DOC] create.pinterest.com boards page (2026-10-19); [WS] cnbc.com 2017-02-08, socialmediatoday.
- **Adopt:** A responsive masonry grid for projects and products that uses stored media dimensions (no stretching), with a keyboard and screen-reader alternative and "more like this" from tags and category. Image search waits for the measured pipeline in §04.
- **Not copied:** Pinterest's layout identity; the Lens brand.
- **Levo:** Partial: `GET /recommend` in `worker/routes/communitySearch.ts`; media dimensions (0099); hub components (WorksRail, ProjectsPanel). §04 (visual exploration with an accessible alternative).
- **Limits:** The current Pinterest UI was not observed.

#### E-27 · Search sorts, windows, comment search and scope — Reddit · P2 · Phase 4
- **Observed:** Search covers posts, communities, comments, media and people (people not inside a community). Post sorts: relevance by default (word rarity, age, votes, comments), hot, top, comment count; time filter hour to all; comment search by relevance, top or new; comment and user searches must match all words; operators for author, flair and self-text; search can be scoped to a community with a way to widen it; an AI answer summarises with inline citations.
- **Evidence:** [WS] support articles 19695647891988, 19696541895316, 32026729424916; [DOC] RedditClient searchPosts (2026-10-19).
- **Adopt:** Sort (relevance, new, top) and a time window on projects and questions; filter chips for space, label, kind, printer and material; search inside a space with a "search everywhere" escape; comment and answer search for help content; later an AI answer that cites only public Levo posts and labels itself as generated (§24). Text search first.
- **Not copied:** Operator syntax as a user requirement (use chips); the AI answer brand.
- **Levo:** Partial: `worker/routes/communitySearch.ts` runs a seven-section search, suggestions, trending with a 5-minute edge cache, and recommendations, bounded at 12 rows per section, with no sort or time parameters and no comment section. Add sort and window to `searchProjects` and a comments section that reuses `commentVisibleSql` (`communitySocial.ts`); keep the no-tracking rule. §04 (text search first).
- **Limits:** Relevance weights closed.

#### E-28 · For You with negative feedback and diversity — Reddit · P2 · Phase 4
- **Observed:** Recommendations run candidates → filtering (spam, already seen, blocked) → predictive models → sorting with diversity, using votes, comments, activity, subscriptions and settings. "Show fewer posts like this" stops that community and down-weights similar ones; recommendations can be turned off; a 2026-08-12 test adds an X that hides a post as a negative signal; a 2026-10-08 test splits home into For You and Following.
- **Evidence:** [WS] support articles 23511859482388, 4402284777364; changelogs 52393330268436, 54353370049684 (2026-10-19).
- **Adopt:** Keep the transparent, rule-based For You (no opaque models; §01.16). Add a per-page cap per author or store, exclusion of already-seen items through a client-side seen set, "show fewer like this" (hides the post and down-weights its space and tags for that viewer, stored on the server), and a switch to turn personalisation off. Any PRO boost is capped and labelled (§04).
- **Not copied:** Reddit's models and signals; claims of ML personalisation.
- **Levo:** Partial: For You and Following already exist (`communitySocial.ts:690`, newest first minus muted and blocked users); `GET /recommend` matches tags, material and printer. Add `community_feed_feedback (user_id, post_id, kind)`, a per-viewer down-weight in SQL and the diversity cap. §04.
- **Limits:** Reddit's models are closed.

#### E-29 · Shape descriptors: duplicates first — Thangs · P3 · Phase 6
- **Observed:** 2020 press describes uploading a 3D model to find geometrically similar models and matching parts; 2023 press describes 2D image search. On 2026-10-19 the home page showed text search, trending searches and tags, categories and browse tabs, with no visible shape-search entry; the upload guide shows folders, private or public permission and an attached licence.
- **Evidence:** [DOC] thangs.com/, thangs.com/resources/blog/thangs-101-uploading-files (2026-10-19); [WS] tctmagazine.com, core77.com/posts/102035, develop3d.com, fabbaloo.com/?p=213548.
- **Adopt:** Text search first (§04). Later, a separate measured pipeline that computes shape descriptors at upload, used first for duplicate and re-upload detection (protecting original designers, §16) and only then for "similar shapes".
- **Not copied:** Physna's geometric engine; no claim of shape search before an engine exists.
- **Levo:** Absent: a descriptor job on the compute queue next to `communitySearch.ts`. §04, §16; phase 6 names advanced geometric search.
- **Limits:** Whether Thangs still offers shape search is unknown; the algorithm is closed.

#### E-30 · Community reputation ledger — Reddit, Printables, Circle, MakerWorld · P1 · Phase 4
- **Observed:** Reddit karma reflects votes on posts and comments but is not 1:1; some communities require karma to post; karma is also available per community; the Contributor Program pays money by karma tier [WS]. Printables Prusameters counts per model over 30 days (10 points at 30 downloads and 3 likes, up to 200 at 400 downloads and 20 likes), 20 for a complete profile, 10 per published model up to 10, 5 per collection up to 3, 1–10 per make capped at 100 a month; makes of popular models earn less; makes of your own model or a repeat make earn nothing; 350 points buys a voucher, approved by hand within two weeks and irreversible; a user notes that likes undervalue functional parts. Circle gives 1 point per like received (not for liking); removing a like keeps the point and re-liking adds none; deleting content keeps its points; 9 levels with custom thresholds applied retroactively; admins award points through workflows, and only those can be revoked, as a whole, irreversibly, possibly lowering the level, and logged on the member's rewards tab. MakerWorld points redeem for gift cards, coupons, models and credits, do not expire, and can be revoked for violations [WS].
- **Evidence:** [WS] support articles 204511829, 17331620007572; [DOC] RedditClient; help.prusa3d.com …_365065; help.circle.so/p/audience/gamification/get-to-know-gamification (updated October 2026), …/revoke-a-member-s-gamification-points; [WS] wiki.bambulab.com/en/makerworld/faq (curl 404) (all 2026-10-19).
- **Adopt:** An event-sourced `community_reputation_events (id, user_id, kind, points, rule_version, source_event_id UNIQUE, space_id, created_at)` written in the same batch as the triggering action. Events: accepted answer, verified make, original project, qualified review, helpful marks from distinct accounts. Caps per action and per month, diminishing returns, no self-credit or repeat credit, idempotency per (actor, target, event type). Revocation is a full compensating entry with a reason, an audit row, a member-visible log and an appeal. Rules are versioned; an optional per-space reputation sets thresholds (for example, posting links or files). Kept separate from the wallet, merchant earnings, designer rights and purchase points; any redemption only through manual review under an owner policy.
- **Not copied:** Karma as a name or score; likes as the main source; Printables point values, vouchers and rewards; any conversion of points to money (§22; the Contributor Program is exactly what not to copy).
- **Levo:** Partial: only merchants have reputation (`merchant_reputation_events`, append-only, `adminCommunity.ts:986-1060`; `badgeFor()` in `worker/lib/merchantOps.ts`); purchase points are separate (`points_accruals` 0014 with its `source_ref` pattern, `points_awards`, `reward_claims`, `review_rewards`; `src/pages/Rewards.tsx`). Add the new ledger and a "why" breakdown on `/u/<username>`. §22, §04.
- **Limits:** Formulas and fraud detection are closed; `Rewards.tsx` data sources were not read in depth.

#### E-31 · Scarce appreciation tokens — MakerWorld · P2 · Phase 4
- **Observed:** Boost replaced download-based rewards, which favoured small simple models and were abused (6,000 fake accounts banned in one day; about 25% of vouchers went to non-contributors). At most 1 token a week, expiring after 2 weeks; accounts linked to a printer get them first; the designer redeems; models sort by boosts; boost notifications; the booster also earns points. Rules were tuned often.
- **Evidence:** [DOC] blog.bambulab.com/rethinking-rewards-makerworld-boost-system; RN 20240417 #1; RN 20240510 #1, #8, #9 (2026-10-19).
- **Adopt:** Limited appreciation tokens issued only from verified events (a delivered order or a posted make), each with a unique event id; tokens expire; abuse limits; sort and filter by appreciation. No money value until the owner approves one.
- **Not copied:** The $1 value, the 1:12 rate, the "Boost" name and brand.
- **Levo:** Absent: a `community_appreciations` ledger following the `points_awards` (`source_ref` primary key) pattern. §22.
- **Limits:** Current rates unknown and changed often.

#### E-32 · Achievements and leaderboards — Reddit, Circle · P3 · Phase 4
- **Observed:** Reddit community achievements are badges for contribution milestones (for example 20 distinct days of activity in one community), with no money value, in communities of 100+ members excluding mature, private and restricted ones; leaderboard eligibility needs 100+ upvotes in a month. Circle's leaderboard shows the top 10 for 7 days, 30 days and all time with the top 3 highlighted and the viewer's own standing; admins can exclude staff, make it private or turn it off; members can hide themselves.
- **Evidence:** [WS] support articles 25564722077588, 27063106698004; [DOC] RedditClient getSubredditLeaderboard; help.circle.so get-to-know-gamification (2026-10-19).
- **Adopt:** Achievements computed from real ledger events under versioned rules (first verified make, 10 accepted answers, 5 original projects with downloads). Monthly per-space leaderboards (week, month, all time) counting only qualified events, with minimum activity before ranking, staff excluded, a member opt-out and the viewer's own rank. Fraud is revoked by compensating events (§22).
- **Not copied:** Names, art, thresholds, layout.
- **Levo:** Absent for the community: `src/pages/Leaderboards.tsx` serves the farm game. A nightly cron next to `refreshStaleMerchantBadges`; shown on creator pages and in spaces. §22.
- **Limits:** Catalogues not read in full.

#### E-33 · Non-monetary level unlocks — Circle · P3 · Phase 4
- **Observed:** A "level up" workflow can grant tags, unlock direct messages, give access to spaces, events or courses, or start a paywall trial (custom rewards need a higher plan).
- **Evidence:** [DOC] circle.so/_llms/help.md; help.circle.so get-to-know-gamification (2026-10-19).
- **Adopt:** Non-monetary capability unlocks by level (posting without slow mode, creating tags, joining a members-only library) under owner-approved rules.
- **Not copied:** Paywall trials and paid clubs (§22 forbids inventing paid clubs or value conversion).
- **Levo:** Absent: a space access rule that can reference the reputation level (E-18). §22, §04.
- **Limits:** Docs only.

#### E-34 · Paid awards and virtual currency — Reddit · P3 · Not adopted
- **Observed:** Awards cost 15–50 gold bought in packs; one free award per eligible item; awards are barred in sensitive communities; awards can be reported and removed by moderators; gold is non-transferable, non-refundable and funds contributor payouts.
- **Evidence:** [WS] support articles 26465598697876, 17331548463764, 17331620007572 (2026-10-19).
- **Adopt:** At most a free, non-monetary «شكراً / مفيد» with a daily limit that feeds the ledger under its caps, reportable and removable like any content.
- **Not copied:** Paid awards, a virtual currency, payouts, any link from likes to money (§22).
- **Levo:** Absent: if built, a kind on the helpful-vote table, never touching `worker/lib/walletOps.ts` or `merchant_ledger`. §22.
- **Limits:** Reddit's award catalogue changes often.

#### E-35 · Contests — MakerWorld · P2 · Phase 4
- **Observed:** The header previews ongoing and upcoming contests; a model carries a contest record (id, rank, status, name) [REA-S fixture]; at most 5 entries; remixes, models published before the contest period and models already awarded are ineligible; staff judge [WS].
- **Evidence:** [DOC] RN 20240510 #7; [REA-S] ev_e303bcef… `test.js`; [WS] forum.bambulab.com contest threads (2026-10-19).
- **Adopt:** A contest entity (terms, dates, eligibility = new originals made within the period, entry limit, review, ranking, rights statement). Entries link to project versions; entering never forces a public download.
- **Not copied:** Prize structures and judging rules.
- **Levo:** Absent: contest and entry tables and an admin workflow (§09). §22.
- **Limits:** Official rules pages not fetched.

#### E-36 · Engagement game teaching real costs — STLbuddy · P3 · keep as is
- **Observed:** A /games hub with analytics events for viewing, starting, tutorial steps, days started, finished and abandoned, tool selection, printer purchase and trade, shop expansion, advertising and saves; game state in localStorage.
- **Evidence:** [REA-S] ev_a5f5e664… `88699-…js` module 60846; stlbuddy.com navigation (2026-10-19).
- **Adopt:** Confirms Levonis's existing idea. Possible link: the game teaches the real cost model (the same factors as the quote engine) and points to real tools.
- **Not copied:** Game design, art, event names.
- **Levo:** Present: `src/pages/farm/*`, `worker/lib/farm/*` (simulation, failure, ledger). §04.
- **Limits:** The game itself was not opened.

---

## F. Admin operations and moderation (§09)

Levonis context: `community_reports` (0154) and `community_complaints` exist, but `GET /reports` in `worker/routes/adminCommunity.ts:1655` is read-only ("the decision routes arrive with moderation V2"). Moderation V2 is designed in `docs/COMMUNITY_ECOSYSTEM.md` §9.6 (`adminModeration.ts`, `moderation_actions`, appeals, `users.status`) but not built: `worker/routes/adminModeration.ts` does not exist.

| ID | Feature | References | Levo today | P | Phase |
|---|---|---|---|---|---|
| F-01 | One intake and review queue | Linear, Reddit | Partial | P1 | 2 (cases) / 4 (moderation) |
| F-02 | Rules that double as report reasons | Reddit | Partial | P1 | 4 |
| F-03 | Removal reasons and author notice | Reddit | Partial | P1 | 4 |
| F-04 | Typed moderation log, user notes, audit viewer | Reddit, Linear | Partial | P1 | 2 (viewer) / 4 |
| F-05 | Sanctions ladder and appeals | Reddit | Partial | P1 | 4 |
| F-06 | Automations and composer guidance | Reddit | Partial | P2 | 4 |
| F-07 | New or low-trust account hold | Reddit | Partial | P2 | 4 |
| F-08 | Lock, pin and staff marker | Reddit | Partial | P2 | 4 |
| F-09 | Domain events consumed once | Reddit (Devvit) | Absent | P2 | 4 |
| F-10 | Routing rules and on-duty reviewer | Linear | Partial | P2 | 3 |
| F-11 | List and board parity, multi-select, peek | Linear | Partial | P2 | 1 (merchant) / 3 (admin) |
| F-12 | Role-scoped command search | Linear | Partial | P2 | 3 |
| F-13 | Profile quality rules and review checklist | MakerWorld | Absent | P2 | 4 |
| F-14 | Editor's picks with a recorded reason | MakerWorld | Absent | P3 | 4 |
| F-15 | Rights notice-and-takedown with counter-notice | MakerWorld | Partial | P2 | 4 |
| F-16 | Progressive merchant tiers and a score | Xometry | Partial | P2 | 4 |

#### F-01 · One intake and review queue — Linear, Reddit · P1 · Phase 2 (cases for the first journey), 4 (community moderation)
- **Observed:** Linear Triage: issues from integrations or from people outside the team land in Triage. Accept (optional comment, moves to the default status); Decline (Canceled, optional explanation); Duplicate (pick the canonical issue; attachments and customer requests move; the duplicate is Canceled); Snooze (until a time or new activity). A team can require a priority before an issue leaves Triage; triage items are excluded from views by default. Reddit's queues: Needs Review, Reported (still visible, so prioritise), Removed (not deleted, still reviewable), Edited, Unmoderated; bulk selection by checkbox, select-all or criteria, then approve, remove or mark spam; "ignore reports and approve"; Devvit exposes queue reads, approve, remove and report triggers.
- **Evidence:** [DOC] linear.app/docs/triage.md (2026-10-19); [WS] support articles 15484440494356, 15484384020756; [DOC] developers.reddit.com triggers page, RedditClient (2026-10-19).
- **Adopt:** One admin intake for content reports, rights claims, merchant applications and complaints, inside the §09 operations centre. Views: Needs review, Reported (grouped by target with reporter count and rules cited), Held by automation, Removed, Edited. Actions: accept into a workflow; decline with a reason (notifies the reporter, with an appeal path); merge a duplicate (moves the evidence to the canonical case); snooze until activity. Priority is required to leave intake; assignee; keyboard bulk actions; "approve and ignore future reports" per target. Removal hides and never deletes evidence; every action is audited.
- **Not copied:** Linear's branding, keymap and UI; any automatic decision by an AI triage (§09, §24); Reddit's queue layout and moderator shield.
- **Levo:** Partial: `community_reports` (0154: open, reviewed, actioned, dismissed) and `community_complaints` (submitted … closed, priority, `assigned_admin_id`). Add `merged_into`, `snoozed_until`, `decision_reason`, grouping by target, bulk endpoints and an ignore-reports flag; UI in `src/components/adminCommunity/AdminCommunity.tsx`, then the operations centre. Build Moderation V2 as designed in `docs/COMMUNITY_ECOSYSTEM.md` §9.6. §09.
- **Limits:** Docs only; some Linear automation is plan-gated; Reddit queue filters beyond the extracts unverified.

#### F-02 · Rules that double as report reasons — Reddit · P1 · Phase 4
- **Observed:** A rule has a name, description, report reason and scope (posts, comments, chat); rules become the reasons members pick when reporting, and sitewide rules also apply; free-text reasons can be allowed; rules compatible with auto-enforcement default to "report" or "remove for review"; mass-reporting content that breaks no rule is itself abuse.
- **Evidence:** [WS] support articles 15484500104212, 360043066412; [DOC] RedditClient rules operations (2026-10-19).
- **Adopt:** Report reasons become Levonis-wide rules (the current seven) plus each space's own rules, each in three translations. Every report and every removal cites a rule id, so the author sees which rule. Track reporter accuracy (the share of a reporter's reports that were actioned) to weight the queue and spot report abuse.
- **Not copied:** Reddit's rule texts, content policy and report-flow copy.
- **Levo:** Partial: REPORT_REASONS is fixed (`communitySocial.ts:606`: spam, abuse, nudity, fraud, copyright, offtopic, other); `ReportSheet.tsx` is a radio group over them. Add `community_rules` (scope sitewide or space, translations, order) and `rule_id` on `community_reports` through an additive migration that keeps `reason`. §09, §04.
- **Limits:** Auto-enforcement internals unknown.

#### F-03 · Removal reasons and author notice — Reddit · P1 · Phase 4
- **Observed:** Saved responses are grouped (general, removal, bans, mod mail); a removal reason is sent as a comment or a private message, from the team or from the moderator's own account; on mobile the choice is comment, message or none. Since 2026-03-10 removal reasons are suggested by machine learning and can be edited or ignored.
- **Evidence:** [WS] support article 15484471320980, changelog 46960495326612; [DOC] RedditClient removal-reason operations (2026-10-19).
- **Adopt:** Removal-reason templates in Arabic, English and Sorani, each linked to a rule. Every hide or removal notifies the author privately in their own language, with the rule and an appeal link, always from «فريق ليفو» and never from a staff member's personal account. Later, optionally, an AI-suggested reason that staff confirm (§24); a suggestion never acts alone.
- **Not copied:** Reddit's template texts; public removal comments (a private notice suits marketplace authors better).
- **Levo:** Partial: `admin_hidden_reason` exists on posts, comments and products (0154, 0118). Add `moderation_reason_templates (rule_id, body_ar, body_en, body_ckb)`; send through `notify()` and `stampGroupedCkb()` in `worker/lib/notifications.ts`; appeals per the §9.6 design. A `ckb` body never copies the Arabic. §09 (each decision has a reason, a notice and an appeal path).
- **Limits:** The ML suggestion is closed.

#### F-04 · Typed moderation log, user notes and audit viewer — Reddit, Linear · P1 · Phase 2 (audit viewer), 4 (moderation log)
- **Observed:** Devvit's moderation action has id, type, moderator name and id, created time, target, details, description and community; the moderation log lists all actions for the last 90 days; a per-user panel shows actions on that member plus labelled moderator notes (for example spam warning, good contributor); AutoModerator flair changes leave no entry. Linear's audit log records account-access, subscription and settings events with the actor's IP and country, keeps them 90 days, filters by type, is owner-only and has an API on the top plan.
- **Evidence:** [DOC] developers.reddit.com/docs/api/redditapi/models/interfaces/ModAction (HTTP 200, 2026-10-19); [WS] support articles 15484464549524, 15484640563860; [DOC] linear.app/docs/audit-log.md (2026-10-19).
- **Adopt:** A queryable `moderation_actions` log with typed actions (hide, remove, restore, warn, restrict, suspend, ban, lock, pin, label), recording the actor (staff, or "system" for automations, which are always logged), the target, the rule, the reason and a link to the report. Staff-only labelled user notes. Each target page shows its history. Kept permanently. An admin audit viewer filtered by actor, action, target and version, restricted to a dedicated scope, with secrets and KYC data redacted.
- **Not copied:** Field names verbatim; the 90-day window; plan gating.
- **Levo:** Partial: `audit()` in `worker/lib/audit.ts` writes `audit_log` rows (`adminCommunity.ts:1396`, `core_audit_details`) but not a typed per-target history. The §9.6 design defines `moderation_actions` and `GET /api/admin/moderation/audit?target=`. Add `moderation_user_notes (user_id, label, body, author_id)` and a read UI under `src/components/adminSecurity`. §09 (who did what, when, on which version).
- **Limits:** Only Devvit field names are observed; their semantics are inferred from doc strings.

#### F-05 · Sanctions ladder and appeals — Reddit · P1 · Phase 4
- **Observed:** Bans are temporary or permanent with a message; replies to a ban land in an appeals folder; message mutes last 3, 7 or 28 days or are permanent (another version of the page says 72 hours by default); sitewide account bans can be appealed within 6 months, separately from community bans.
- **Evidence:** [WS] support articles 15484464549524, 23511059871252, 15484158762260; [DOC] RedditClient ban and mute operations (2026-10-19).
- **Adopt:** A ladder: warn → restrict (read-only) → suspend until a date → ban → restore. Each step has a reason, a notice and one appeal per action, handled in the operations centre. A suspended merchant keeps their order history (§46). Space-level bans come later, once spaces have moderators.
- **Not copied:** A separate moderator-mail inbox product; Reddit's durations as policy (the owner sets them).
- **Levo:** Partial: planned in §9.6 (`users.status` active, restricted, suspended, banned; `AUTHOR_VISIBLE_SQL`; `moderation_appeals`), not built. Merchant sanctions exist (`adminCommunity.ts:535` merchant status, `:594` store status); user-to-user block and mute exist (`communitySocial.ts:551-590`). §09.
- **Limits:** Durations differ between page versions.

#### F-06 · Automations and composer guidance — Reddit · P2 · Phase 4
- **Observed:** AutoModerator is rule-based: removal rules run first; "filter" removes but keeps the item in the queue while "remove" drops it; moderators are exempt by default. Post and comment guidance takes keyword or regex conditions (up to 2,000 keywords of up to 100 characters, regex up to 20,000 characters) and acts by informing, reporting or blocking until revised (block wins); it never triggers for moderators. A model-based post check never prevents posting.
- **Evidence:** [WS] support articles 52866343172500, 52865423682452, 17625458521748, 33702751586836; [DOC] developers.reddit.com triggers page (2026-10-19).
- **Adopt:** A small rule engine with a staff UI rather than YAML. Conditions: keywords or regex in ar/en/ckb with digit and diacritic normalisation, account age, reputation, links present, kind or space. Actions: inform in the composer, report to the queue, hold for review, block with a revision hint. Every automatic action is logged as actor "system" and can be appealed. Composer guidance comes from space rules (for example "a help question needs printer, material and a photo"). An AI pre-check is advisory only (§24).
- **Not copied:** AutoModerator's YAML syntax and documentation, rule libraries, exemption semantics.
- **Levo:** Partial: the only automatic check is `isIndecent()` plus owner terms (`worker/lib/nameGuard.ts:285`, `worker/lib/decency.ts`), applied to comments (`communitySocial.ts:369`) and requests. Add `community_automation_rules`, evaluated in `POST /posts`, `POST /comments` and request comments before INSERT; a held item is `state='hidden'` plus a queue row; reuse the search `normalizeText`. §09, §04.
- **Limits:** Regex cost on Workers must be measured.

#### F-07 · New or low-trust account hold — Reddit · P2 · Phase 4
- **Observed:** Crowd Control: moderate filters accounts with negative community karma, high adds new accounts, maximum adds non-members; it applies per community or per post; comments are collapsed or held and posts filtered into the queue. A reputation filter uses sitewide signals (likely spammers, frequently removed, unestablished accounts) and exempts approved users. Harassment and ban-evasion filters send items to the queue. None of these delete.
- **Evidence:** [WS] support articles 15484545006996, 27441485903124, 15484574845460, 23856209638932, 15484544471444 (2026-10-19).
- **Adopt:** Content from accounts younger than N days, with no verified purchase or make, or with recent removals is held for review or shown collapsed, by space setting. Approved (trusted) users bypass it; it can be raised temporarily during a spam wave. Only signals Levonis really has (account age, verified orders, sanctions history), never invented scores.
- **Not copied:** Reddit's sitewide classifiers and level names.
- **Levo:** Partial: only rate limits exist (comments 60/h, reports 20/h and similar). Derive a trust level per request from `users.created_at`, verified orders, the reputation ledger (E-30) and `moderation_actions`, and apply it in the F-06 step; approved users in a space-members table. §04 (anti-spam and anti-manipulation), §09.
- **Limits:** Reddit's thresholds and signals are closed.

#### F-08 · Lock, pin and staff marker — Reddit · P2 · Phase 4
- **Observed:** Locking means only moderators comment; members can still vote and edit or delete their own comments. Up to 6 posts can be highlighted at the top of a community. Spoiler tags must be enabled first; NSFW is set from the moderator menu; moderator comments can be stickied and marked.
- **Evidence:** [WS] support articles 15484642147988, 15484641176724, 15484365010196 (2026-10-19).
- **Adopt:** Staff (later space moderators) can lock a discussion, which stays readable but takes no new comments; pin a small number of posts per space or on the community home («مثبت»); an official "Levonis team" marker on staff comments. NSFW is not adopted: adult content is out of scope and decency rules apply.
- **Not copied:** The moderator shield, the "sticky" term, spoiler blur.
- **Levo:** Partial: today posts can only be archived or restored by their author (`communityPosts.ts:953, :968`). Add `locked_at` and `pinned_rank` (scoped to a space); check `locked_at` in `POST /posts/:id/comments`; a staff badge in `commentPublic()`. §04, §09.
- **Limits:** Extracts only.

#### F-09 · Domain events consumed once — Reddit (Devvit) · P2 · Phase 4
- **Observed:** Devvit apps subscribe to triggers for post submit, create, update, report, delete and flair update; comment create, submit, update, report and delete; moderator actions; moderator mail; and AutoModerator filters. Moderators install apps for tools, bots, governance and leaderboards.
- **Evidence:** [DOC] developers.reddit.com/docs/capabilities/server/triggers, /docs/introduction/intro-mod-tools (HTTP 200, 2026-10-19).
- **Adopt:** Community writes become domain events with unique ids (post published, comment created, report filed, moderation action, answer accepted). Reputation, automations, notifications and the operations centre all consume the same event, so nothing is computed twice and §22's unique event ids hold.
- **Not copied:** The Devvit platform, its app marketplace and payouts; third-party apps.
- **Levo:** Absent: side effects are inline in each route (`notifyGrouped`, `audit`, `announceAfterResponse` in `worker/lib/adminTopicRouting.ts`). Add `community_events (id, kind, actor, target, payload, created_at)` written in the same D1 batch as the action, with a queue or cron consumer. §22, §09.
- **Limits:** Delivery guarantees (the trigger catalogue page) not read.

#### F-10 · Routing rules and on-duty reviewer — Linear · P2 · Phase 3
- **Observed:** Triage rules run in order from the top, match filterable properties and set team, status, assignee, label, project and priority; moving an issue to another team applies that team's rules; conflicts are shown. Triage responsibility names members who are notified or auto-assigned, with rotations from incident tools.
- **Evidence:** [DOC] linear.app/docs/triage.md (2026-10-19).
- **Adopt:** Deterministic, ordered routing rules over case type and properties (for example a copyright report goes to a rights reviewer, an escrow dispute to an admin with financial scope through `requireFinancialScope`); an on-duty reviewer per scope; rule conflicts shown.
- **Not copied:** Integrations; AI routing.
- **Levo:** Partial: `ops_permissions` scopes (0162). Add `ops_routing_rules` evaluated in `worker/lib/operations.ts`. §09.
- **Limits:** Docs only.

#### F-11 · List and board parity, multi-select, peek — Linear · P2 · Phase 1 (merchant orders), 3 (admin cases)
- **Observed:** One shortcut switches list and board with a shared ordering; boards group by status, project, priority, cycle, label or SLA status and support swimlanes; hidden columns still accept drops; keyboard multi-select and move to top or bottom; a peek preview; no board in Triage or Inbox; a view can set the default layout.
- **Evidence:** [DOC] linear.app/docs/board-layout.md (2026-10-19).
- **Adopt:** Merchant orders and admin cases share one query model with list and Kanban layouts, saved views (A-18), keyboard multi-select with bulk actions that show scope and ask for confirmation, and a peek drawer. Shortcuts work on Arabic and Kurdish keyboard layouts (`e.code`, as CommandPalette already does).
- **Not copied:** Visual design; shortcuts.
- **Levo:** Partial: `src/components/merchant/orders/ordersView.ts` and `bulk.ts` (merchant); the admin cases view is new. §07 (orders Kanban and list), §09.
- **Limits:** Docs only.

#### F-12 · Role-scoped command search — Linear · P2 · Phase 3
- **Observed:** "/" searches titles, descriptions and comments; an exact or shorthand id opens the issue; results rank unstarted and in-progress work first, then backlog, completed, cancelled, archived; single-letter prefixes scope the command menu; quotes match an exact term.
- **Evidence:** [DOC] linear.app/docs/search.md (2026-10-19).
- **Adopt:** Scope prefixes in the Levonis palette (order, product, project, merchant, report), id shorthand (ORD-…, REQ-…), open work ranked first, and role scoping enforced on the server so no other tenant's records or private file names appear (§03).
- **Not copied:** Prefix letters; copy.
- **Levo:** Partial: `src/components/ui/CommandPalette.tsx` and `merchant/shell/WorkspacePalette.tsx` for merchants. Extend to admin and user through a role-scoped search endpoint. §03, §09.
- **Limits:** Docs only.

#### F-13 · Profile quality rules and review checklist — MakerWorld · P2 · Phase 4
- **Observed:** A photo of a real print is mandatory. Invalid: colour-only or parameter-only edits, duplicates, splitting or merging collections, single-colour copies of multi-colour profiles. Title words "fast", "better", "official", "best" and "100%" are banned, as are misleading print times and geometry edits under no-derivative licences. Spam report types: repeated upload, no real print image, someone else's image.
- **Evidence:** [DOC] wiki print-profile-upload ("Prohibited practices" 1–10); RN 20231207 #4 (2026-10-19).
- **Adopt:** Composer checks, an admin review checklist and report reasons in ar/en/ckb; a per-language lint for unprovable claims in titles; a rule that the print photo matches the profile's colours.
- **Not copied:** The rule text.
- **Levo:** Absent: `ProjectComposer.tsx`, `worker/routes/adminCommunity.ts`, `community_reports`. §09, §16.
- **Limits:** Enforcement tooling not visible.

#### F-14 · Editor's picks with a recorded reason — MakerWorld · P3 · Phase 4
- **Observed:** Featured criteria: originality, design quality, printability, complete information, engagement; a staff pick records a reason; the exclusive programme needs 100+ cumulative prints, original work only, and removal from other platforms.
- **Evidence:** [DOC] wiki featured-model-guidelines, exclusive-model-guideline (2026-10-19); [REA-S] ev_e303bcef… fixture fields.
- **Adopt:** An editor's pick that records its reason and criteria, with the admin action logged. No exclusivity demand (not in the spec).
- **Not copied:** The exclusive programme and its agreement.
- **Levo:** Absent: `worker/routes/adminCommunity.ts`. §09, §22.
- **Limits:** Policy only.

#### F-15 · Rights notice-and-takedown with counter-notice — MakerWorld · P2 · Phase 4
- **Observed:** A reported model is taken down at once and both parties are notified; the creator has 14 days to counter-notify; the claimant then has 14 days to show legal action, otherwise the model may be reinstated; one right type per report; a reply in about 7 business days; personal data shared only as needed.
- **Evidence:** [DOC] wiki.bambulab.com/en/makerworld/tutorials/IP-Report-FAQ (2026-10-19).
- **Adopt:** A rights-report workflow (§16) with its own type, a takedown state that keeps files and existing orders, a counter-notice window and an audit trail. Timelines are set by the owner or legal counsel.
- **Not copied:** Their legal timelines without a decision.
- **Levo:** Partial: `community_reports` has a copyright reason; the workflow goes in `adminCommunity.ts` and F-01. §16, §09.
- **Limits:** Legal decision required.

#### F-16 · Progressive merchant tiers and a score — Xometry · P2 · Phase 4
- **Observed:** Every supplier makes a test part and is vetted on certifications, quality and capacity; it gets a low-risk first job and harder work after proving reliability. A partner score measures on-time delivery, quality and engagement; an in-house lab and engineers add a checkpoint; certifications are not required to join but open more work.
- **Evidence:** [DOC] manufacturing-partner-network-overview FAQ; capabilities/community/ (2026-10-19).
- **Adopt:** Newly approved merchants start in a capped tier (job value or size, or template orders only) and move up after N verified completions. A transparent merchant score (on time against the declared date, QC pass, disputes, response time) is shown to the merchant and used in ranking. Ranking only orders eligible merchants; it never makes an ineligible merchant eligible.
- **Not copied:** The score name and formula; a test part as a fixed rule unless the owner decides it.
- **Levo:** Partial: `worker/lib/merchantApproval.ts` (mandatory approval), `printMatchingScore.ts` (reliability weight). Add tier caps to `eligibility.ts`. §18, §22.
- **Limits:** Score inputs and weights unknown.

---

## G. Maintenance guides (§23)

| ID | Feature | Reference | Levo today | P | Phase |
|---|---|---|---|---|---|
| G-01 | Structured step-by-step guide | iFixit | Absent | P1 | 6 |
| G-02 | Per-step hazards and a scoped assistant | iFixit | Absent | P2 | 6 |

#### G-01 · Structured step-by-step guide — iFixit · P1 · Phase 6
- **Observed:** The "Prusa i3 Mk2 Nozzle Replacement" guide header shows title, contributors ("and 5 other contributors"), last updated (May 7, 2024), views (24 h, 7 d, 30 d, all time), a "Completed" count with "Mark complete", Favorites (which also subscribes), time required (30 minutes) and difficulty (moderate). Then an introduction; "What you need" split into parts (an E3D V6 nozzle) and tools (2.5 mm hex key, adjustable wrench, tweezers, 7 mm socket and wrench), each with a store link; numbered steps with images and colour-coded bullet lines (normal, red, caution icon); per step a "tool used on this step", comments, an assistant entry and Edit. Step 1 heats the nozzle (190 °C for PLA, 220 °C for ABS); the conclusion says to reassemble in reverse order.
- **Evidence:** [DOC] ifixit.com/Guide/Prusa+i3+Mk2++Nozzle+Replacement/98094 (2026-10-19).
- **Adopt:** A Levo guide entity: applicable printer models and firmware, time, difficulty, parts and tools lists, numbered steps with media, typed bullets (normal, caution, heat, electric or moving-part warning), a "worked for me" completion count, per-step comments, "report a wrong step", and a versioned guide with its sources and review date.
- **Not copied:** iFixit text, images, layout, affiliate model and guide library (§23 forbids copying without rights).
- **Levo:** Absent: `guides`, `guide_steps`, `guide_versions`, `guide_sources` with ar/en/ckb slots. Parts link to the catalogue only through a verified fit (`maintenance_parts` and `product_printer_fits`, 0148); extends `products.usage_guide` (0035). §23; phase 6 names the maintenance centre.
- **Limits:** One guide observed; iFixit's `/api` is robots-disallowed, so its schema was not studied.

#### G-02 · Per-step hazards and a scoped assistant — iFixit · P2 · Phase 6
- **Observed:** Caution-styled bullet lines appear inside steps; the heating step states the temperature before the work; every step has an "Ask FixBot" entry and comments (three caution icons and six assistant entries in the markup).
- **Evidence:** [DOC] same page markup (2026-10-19).
- **Adopt:** Mandatory hazard bullets on steps tagged heat, electric or moving parts, with a referral to support. «اسأل Levo AI عن هذه الخطوة» passes the step, guide version and sources as context and answers with citations, separating official from community answers.
- **Not copied:** The FixBot brand and behaviour.
- **Levo:** Absent: `guide_steps.hazard_tags`; Levo AI user mode (§24) with retrieval scoped to the guide. §23, §24.
- **Limits:** The assistant was not tested; only its presence was observed.

---

## H. AI assistant (§24)

Levonis context: the support assistant is deterministic (an intent allowlist, handlers that read only the user's own rows, clarifying choices, no LLM; `worker/routes/support.ts:1-25`, `worker/lib/assistantNlu.ts:1-40`). The repository forbids AI or generative translation (`worker/lib/translate/index.ts:9`, `support.ts:236`); Gemini is used only for admin translation behind a key and says honestly when it is not configured (`worker/routes/misc.ts:61-93`). Sidekick internals were not observable (login); REA ev_963caf97… covers only the marketing page's bundles.

| ID | Feature | Reference | Levo today | P | Phase |
|---|---|---|---|---|---|
| H-01 | Scope and permissions before retrieval | Shopify Sidekick | Partial | P1 | 6 |
| H-02 | Changes are drafts the merchant saves | Shopify Sidekick | Partial | P1 | 6 |
| H-03 | Typed tool registry with limits; untrusted outputs | Shopify Sidekick | Partial | P1 | 6 |
| H-04 | Numeric answers name period, filters and source | Shopify Sidekick | Absent | P2 | 6 |
| H-05 | Contextual "Ask" on a specific object | Shopify Sidekick | Absent | P3 | 6 |
| H-06 | Saved questions | Shopify Sidekick | Absent | P3 | 6 |
| H-07 | Budgets, quotas and languages | Shopify Sidekick | Absent | P2 | 6 |
| H-08 | Generated product copy as drafts | Shopify Sidekick | Absent | P3 | later |
| H-09 | Drawing and photo reader with discrepancy chips | Xometry | Absent | P3 | 6 |

#### H-01 · Scope and permissions before retrieval — Shopify Sidekick · P1 · Phase 6
- **Observed:** The marketing page says every staff member uses Sidekick "based on their admin permissions", that it "respects access controls", "has direct access to your Shopify data" and "takes action in your admin". [WS] It cannot share other merchants' private data; memory is per user (about 3 months, plus about 12 hours of admin activity) and can be turned off per conversation; theme-editor chats are not remembered.
- **Evidence:** [DOC] shopify.com/sidekick (2026-10-19); [DOC] changelog …/sidekick-now-remembers-your-preferences; [WS] help.shopify.com …/sidekick/memory, …/help-and-guidance; [REA-S] ev_963caf97… (marketing UI only).
- **Adopt:** Merchant mode as new intents inside the existing assistant: every handler scoped by `requireStoreOwner` and `merchant_id` before any retrieval; small allowlisted DTOs, never raw rows; no cross-store data and no competitor costs; no memory at first, and if added later, per user, visible and deletable.
- **Not copied:** Broad direct data access; memory of admin activity.
- **Levo:** Partial: the deterministic support assistant already works this way. Extend it with merchant intents (the smart search and assistant lane) rather than building a new assistant. §24 (merchant mode; retrieval limited by user, tenant and file permission before search).
- **Limits:** Sidekick internals not observable.

#### H-02 · Changes are drafts the merchant saves — Shopify Sidekick · P1 · Phase 6
- **Observed:** [WS] Orders and draft orders are edited but update only on Save; existing policies are replaced only after asking, and the privacy policy cannot be changed; product, collection and SEO forms are filled but nothing applies until Save; theme changes happen only in the editor and only on save; using an installed app needs approval for one conversation; long jobs run in the background and notify when ready. [DOC] Since 2025-12-10 Sidekick applies theme changes in the preview, and a section can be clicked to direct it.
- **Evidence:** [WS] help.shopify.com …/sidekick/help-and-guidance, …/set-up; [DOC] changelog …/customize-your-theme-with-sidekick (2026-10-19).
- **Adopt:** The AI may only fill an existing editor as a draft (ProductEditorSheet, the coupon form, the builder draft); the merchant saves through the normal route, which keeps its permission checks and audit. Builder changes go to the draft with undo and never publish. The AI never touches money, prices sent to customers, publishing, rights or file access.
- **Not copied:** AI theme edits that go live; session-long app approval.
- **Levo:** Partial: support tickets are created only after explicit confirmation (`support.ts:16-17`); the builder already has a draft, undo and a publish dialog (the Shopify gap study row 41). An assistant action returns a typed draft payload that the client opens in the right editor. §24 (a write starts with a preview of the change; payment, publishing, price, rights and file access need separate approval and audit).
- **Limits:** The preview UX in Shopify's admin was not observed.

#### H-03 · Typed tool registry with limits; untrusted outputs — Shopify Sidekick · P1 · Phase 6
- **Observed:** Apps expose data extensions (search) and action extensions: "Keep data extensions read-only. Mutations belong in action extensions, where the merchant confirms the change." Limits: 20 tools per app; names ≤64 characters; descriptions ≤512; instructions ≤2,048 tokens; 5 intents per app; queries ≤500 characters; responses ≤4,000 tokens; 1 s for data and 3 s for actions; 20 apps per user. Descriptions and schemas are validated at deploy; responses are checked at runtime before entering the conversation; extensions may not override behaviour, bypass confirmation, sell, or embed directives or credentials.
- **Evidence:** [DOC] shopify.dev/docs/apps/build/sidekick (2026-10-19).
- **Adopt:** A Levo tool registry: each tool has a name, a description and a validated input schema; read tools and action tools are separate, and action tools require confirmation; each tool has a response-size cap and a timeout; every tool output is treated as untrusted (directives stripped or flagged before the model sees it); no free SQL, shell or arbitrary API calls.
- **Not copied:** A third-party extension platform (Levonis has none); the in-assistant "awareness" upsell surface.
- **Levo:** Partial: the support assistant uses a fixed intent allowlist and allowlisted DTOs (`support.ts:5-15`). Add `worker/lib/assistantTools.ts` sharing the existing auth helpers. §24 (typed tools, allowlist, retrieved content treated as untrusted).
- **Limits:** These are limits for third-party extensions; Sidekick's internal limits are unknown.

#### H-04 · Numeric answers name period, filters and source — Shopify Sidekick · P2 · Phase 6
- **Observed:** [WS] Sidekick writes ShopifyQL, runs it, shows the query with a plain explanation, and can refine an open report. [DOC] Since 2026-01-06 it writes queries for payments and web performance; the page lists prompts such as a weekly summary and a low-stock alert.
- **Evidence:** [WS] help.shopify.com …/create-custom-explorations; [DOC] shopify.com/sidekick (2026-10-19).
- **Adopt:** Map a merchant's question to one of the named reports (A-11) with an explicit range and filters. The answer card names the period, filters and source with «افتح التقرير», and separates what is proven from a possible cause. When no report fits, it says so instead of composing an answer.
- **Not copied:** Generated query language or SQL.
- **Levo:** Absent: reuses `GET /api/merchant/analytics/report` and the planned named reports. §24 (every numeric answer shows period, filters and source), §07.
- **Limits:** Behaviour inside the admin not observed.

#### H-05 · Contextual "Ask" on a specific object — Shopify Sidekick · P3 · Phase 6
- **Observed:** An icon in the admin opens Sidekick with no setup; since 2025-12-10 a target tool selects any on-screen element as context, and theme-preview sections can be clicked; an insight's "See why" pre-loads it (2026-04-28); the changelog index lists Home conversations, voice in the mobile app and to-do lists.
- **Evidence:** [DOC] shopify.com/sidekick; changelog …/select-elements-to-give-sidekick-context, …/data-driven-insights-now-appear-on-your-analytics-dashboard (2026-10-19).
- **Adopt:** An «اسأل» action on specific objects (an order, an offer, an analytics tile, a builder block) passing a typed context `{type, id}` that the server re-reads under its own permissions; nothing is scraped from the screen.
- **Not copied:** Brand icon and colour; an always-on floating assistant; voice.
- **Levo:** Absent: hangs off `src/components/merchant/shell/MerchantShell.tsx` and the palette. §24 (a contextual assistant, not a separate app with broad access).
- **Limits:** Changelog only.

#### H-06 · Saved questions — Shopify Sidekick · P3 · Phase 6
- **Observed:** Up to 25 "skills" invoked with "/"; a skill can be shared by URL and the recipient reviews it before adding; shared skills go through safety checks.
- **Evidence:** [DOC] changelog …/sidekick-skills (2025-10-03); [WS] help.shopify.com …/sidekick/skills (2026-10-19).
- **Adopt:** Per-user "saved questions" mapped to named reports with fixed parameters («مبيعات أمس حسب المنتج»).
- **Not copied:** Sharing prompts between stores; free-form prompt macros.
- **Levo:** Absent: a field in the `merchant_workspace_prefs` JSON. §24.
- **Limits:** Low value until merchant mode exists.

#### H-07 · Budgets, quotas and languages — Shopify Sidekick · P2 · Phase 6
- **Observed:** Included in the plan, with features and usage limits by plan; it follows the store's language settings. [WS] App generation has store-wide rolling hourly and weekly limits and image generation monthly and short-term limits; not available in the admin on mobile browsers (the app works); read-only on a watch.
- **Evidence:** [DOC] shopify.com/sidekick; [WS] help.shopify.com …/sidekick/set-up, …/generate-apps (2026-10-19).
- **Adopt:** A per-store AI budget with the remaining quota shown; a provider adapter; every function keeps working without the LLM. Sorani quality is unverified, so fall back to the deterministic assistant there and never machine-generate `ckb` text.
- **Not copied:** Plan-tier upsells inside the assistant (Shopify's own extension rules forbid upsells).
- **Levo:** Absent (see the area note on the translation ban and the Gemini key). §24 (state the service limit, cost and retention; budgets; works without an LLM).
- **Limits:** Arabic and Sorani support in Sidekick unknown.

#### H-08 · Generated product copy as drafts — Shopify Sidekick · P3 · Later (owner decision)
- **Observed:** Sidekick is presented as a writer (product copy, SEO), photo editor, designer and marketer, with prompts for product descriptions and social posts. [WS] It fills product and SEO forms but nothing applies until Save; it cannot edit images in a theme or in the product list.
- **Evidence:** [DOC] shopify.com/sidekick; [WS] help.shopify.com …/sidekick/generate-content (2026-10-19).
- **Adopt:** A product-description draft in the merchant's chosen language, inserted into the editor and marked as a draft; the merchant must edit or accept it.
- **Not copied:** AI translation into `ckb` (decision row 183 and the translation ban); AI "studio shots" that misrepresent a printed item.
- **Levo:** Absent: a button in `catalog/ProductEditorSheet.tsx`. §24 (draft product descriptions; image or text improvements only with permission).
- **Limits:** Content-quality claims are marketing copy.

#### H-09 · Drawing and photo reader with discrepancy chips — Xometry · P3 · Phase 6
- **Observed:** Updating a part returns whether a drawing is required and missing, whether to prompt for one, the triggers that require it, and a user override. A drawing-AI result (status, overrides applied, discrepancies with found and normalised values per attribute) is fetched and polled; a warning about pausing drawing attachment exists. Some selections prompt for a drawing, and an AI reads it and flags mismatches against the selected attributes.
- **Evidence:** [REA-S] ev_5535d0ff… operation names (UpdateQuotedPart, QuotedPartDrawingAiFields, PollQuotedPartDrawingAi).
- **Adopt:** When a request includes a dimensioned photo, sketch or PDF, an assistant may extract candidate values (size, material, quantity) and show "found X, you chose Y". The customer confirms; nothing is applied silently; the result stays NEEDS_REVIEW until confirmed (§24: the AI assists and never sets prices).
- **Not copied:** Their model, prompts and field names; automatically applied overrides.
- **Levo:** Absent: request attachments (`worker/lib/attachments.ts`, `requestFilePolicy.ts`) plus the assistant; discrepancy chips in the request review step, behind a flag. §17, §24.
- **Limits:** Whether this is live, and how accurate it is, is unknown.

---

## Adoption plan

The highest-value adoptions per master-spec phase, each with the concrete Levo change. Entry ids point back to the matrix. Every item follows CLAUDE.md: `npm run check` and `npm run test:unit` green before the push, the push deploys through workflow 7, every new table or column read tolerates its absence, and every string ships in ar, en and real ckb. Phase 0 (this study) is done; phase 7 is the integration audit.

### Phase 1 — Fix the shared foundation

1. **Honest request intake** (C-01, C-02, C-03, B-17; Xometry). Add a format capability map to `worker/lib/attachments.ts`; serve one upload-limit config read by `worker/routes/uploadSessions.ts` and by a shared client pre-check (too large, blocked type, no extension, archive); allow a guest draft that signs in only to submit; add a per-file state column (queued, measuring, ready, failed, superseded) written by `worker/lib/requestFileHooks.ts`; add `unit_choice_required` with a rescale that creates a new revision in `worker/lib/requestRevisions.ts`.
2. **Bulk stock edits that cannot overwrite** (A-16, A-17; Shopify). `worker/routes/merchantCatalog.ts:690-699` updates with `WHERE stock = ?expected` and returns STOCK_CHANGED per item; a dry-run mode returns the summary without writing; `CatalogManager.tsx` shows before → after with a sign as well as colour.
3. **Saved views and board parity** (A-18, F-11; Shopify, Linear). Custom views in `src/components/ui/DataList.tsx` stored in `merchant_workspace_prefs`, with save-as-new, URL state and phone support; list and Kanban for merchant orders on one query model (`merchant/orders/ordersView.ts`, `bulk.ts`).
4. **A definition for every metric** (A-10; Shopify). `src/components/merchant/analytics/definitions.ts` (formula, what counts, what is excluded) and an ⓘ sheet on `src/components/ui/KpiTile.tsx`.
5. **Approval-aware setup checklist** (A-24; Etsy). Split `setupSteps()` in `CommandCenter.tsx` into "required for approval" and "recommended", wired to the §06 states in `merchantApplication.ts`.
6. **Host-owned storefront strip** (A-01; Shopify). Report store (reusing `community/social/ReportSheet.tsx`), policy, account and real price in `StoreRenderer.tsx` and `Storefront.tsx`; a `packages/storeLayout/src/verify.ts` rule that refuses layouts hiding it. Ships with approval.
7. **Studio link that keeps work** (B-18, B-19, B-20; STLbuddy, Bambu Studio, Printables, Xometry). `studio/app/project-sync.ts`: a local draft joins the account only with consent; the pending order or download resumes after sign-in; "Open in Studio" accepts only Levonis hosts or signed project ids; "price this" sends the saved version to a request draft.
8. **Protection baseline** (D-01, D-02, D-03, D-08; Sketchfab). An owner-facing asset-level matrix (images only, lossy view copy, licensed download); download as its own permission with the licence id and version stored on each grant; a download-grant route mirroring `worker/lib/viewerGrants.ts` (hashed token, TTL in minutes, `no-store`, logged); `noindex` on `/model-viewer/*`. Until D-04 lands, note that a "full" grant of a model under 250k triangles is the original geometry.
9. **Viewer strings in Sorani** (D-24). The string table in `src/pages/ModelViewer.tsx` has no `ckb` (DECISIONS row 183); a quick fix that can ship at any time.

### Phase 2 — First complete journey (medallion, names and organiser → approved offer → Production Package → delivery)

1. **Tool registry, engine and shell** (B-01, B-02, B-03, B-25; STLbuddy, MakerLab). `worker/lib/tools/registry.ts` served at `/api/tools` and read by the Tools hub, search and the Studio home; `studio/app/generators/engine.worker.ts` with manifold-3d from upstream npm (Apache-2.0, listed in `studio/OPEN_SOURCE_NOTICES.md`), stale-request guard, timeouts and `{generator_version, parameter_hash, output_hash}`; one step-rail tool shell; failures open a pre-filled support case.
2. **The three named generators** (B-04, B-05, B-06, B-07, B-09). `nameSign` with harfbuzzjs shaping, licence-reviewed OFL Arabic fonts and island and dot checks; `medallion` with sanitised server-side image and SVG intake; `organizer` with schema-enforced minimums and explicit resize choices; a `clearance` variable class.
3. **Template model and rights** (B-22, B-23, A-20, D-09; STLbuddy, Thangs, Etsy, Xometry pattern). §12 display modes (private, view-only, customise-and-order, download-with-conditions, authorised merchants only); licence types separating download, manufacture and commercial print rights; a two-stage approval lifecycle; typed buyer fields frozen into order lines; a rights declaration per version before a request is published.
4. **One printability gate** (B-15, B-16, D-17 Studio part; STLbuddy, Xometry, MakerWorld). A check module shared by Studio and `worker/lib/modelGeometry.ts` with a closed vocabulary `{key, severity, recommendation_key, face_ids}`; errors block READY_TO_EXECUTE; bed fit against the real printer profile; a per-printer profile validation job reusing `studio/app/makerworld/preflight.ts`.
5. **Result types and honest re-quotes** (C-04, C-05, C-06, C-09, C-20; Xometry). `result_type` and localised recommendations in `worker/lib/printEstimate/contract.ts`; the priced-fact hash from `requestRevisions.ts` wired into instant estimates and Studio; an explicit customer line list in the offer snapshot; visible offer expiry from an admin-set policy; a request and offer activity feed with a customer-safe projection.
6. **Safe acceptance** (C-07, C-08, C-10; Xometry, STLbuddy). Closed rejection reasons with re-confirm paths in `worker/routes/printRequests.ts` and `worker/lib/communityRequests.ts`; an idempotency table keyed on `(account, project_revision, output_hash, variant)`; the version fingerprint pinned into offer and order snapshots.
7. **Production Package** (C-22; STLbuddy, Xometry). A server package writer at acceptance (deduplicated parts, plates, parts CSV, print notes with versions, RTL assembly guide), an order-specific reference, and least-privilege file access through `worker/lib/requestFilePolicy.ts`.
8. **Merchant job card, QC and cancellation** (C-21, C-24, C-25; Xometry). Accept or decline with a reason before work starts (`merchantInbox.ts`); a QualityCheck photo stage in `communityOrderTimeline.ts`, with shipment state kept separate; free cancel before acceptance, owner policy after, exactly one refund or void.
9. **A view copy that is not the original** (D-04, D-05, D-07; Sketchfab). LVM2 (indexed, quantised, quadric-simplified) in `viewerMesh()` with a decoder in `ModelViewer.tsx`, keeping the LVM1 reader; a click-to-load poster that mints the grant only on tap; an audience setting per file that AR and download follow.
10. **First slice of the operations queue** (F-01, F-04 viewer; Linear). Complaints and disputes from the first journey in one intake with accept, decline with reason, merge, snooze and required priority; an admin audit viewer over `audit_log` with a dedicated scope and redaction.

### Phase 3 — Library, materials, comparison, plates, reorder, BOM; Store Builder

1. **Merchant comparison with speed and quantity** (C-11, C-12; Xometry). `speed_options` in the capability profile and `price_tiers` in estimate and offer snapshots, with server-computed ready and delivery dates and cheapest and fastest badges; a quantity-breaks endpoint calling `priceJob` in `worker/lib/printQuote/cost.ts`.
2. **The rest of the tool library** (B-08, B-10, B-12, B-13, B-14, C-26; MakerLab, STLbuddy). Lithophane with frame and light-kit BOM; mechanism templates with locked regions and catalogued parts; a separate-parts export; `studio/app/cut-plan.ts` (bed-driven cut suggestions, pins only after testing, a corrections list that blocks ordering); modify operations only on owned or licensed files; an educational calculator mode in IQD.
3. **Plates, parts, copies and split requests** (C-14, C-16, D-19, D-21; MakerWorld, Xometry, Sketchfab). Plate, part and copy selection with re-pricing and single-part reprints; a linked NEEDS_REVIEW split for unpriced parts; an internal viewer controller and per-part ids in the view copy for visibility and colour per part.
4. **BOM and assembly** (C-15; MakerWorld). `project_bom` pointing to catalogue SKUs or free-text parts; "add all" split per seller under the single-seller cart rule; assembly guides in the Production Package.
5. **Reorder, assisted requests, presets and sharing** (C-18, C-17, C-13 presets, C-19; Xometry). "Order again" as a freshly priced direct request (`worker/lib/directRequests.ts`); routing reasons and split-delivery schedules; customer and merchant presets flagged when invalid; an expiring read-only offer link and trilingual PDF.
6. **Material stock states** (A-15; Shopify). `reserved_g`, `unavailable_g` with a reason, and a movement log on `merchant_material_stock`.
7. **Store Builder** (A-04, A-07, A-02, A-08, D-23; Shopify, Sketchfab). `store_layout_schedules` with a worker cron; product editing from the canvas; carousels pause on select; a per-block `surface` enum; an embed route with per-route `frame-ancestors` limited to `*.levonis-iq.com`.
8. **Analytics** (A-09, A-11, A-12, A-14; Shopify). A `compare` parameter; named reports with CSV; annotations from layout, product, store and coupon events; deterministic "what changed" lines above a minimum sample.
9. **Merchant service and inbox** (A-21, A-22, A-19; Etsy, Shopify). Private service indicators with definitions; saved replies and help-request messages linked to complaint cases; customer segment presets (coupon eligibility only after an owner decision).
10. **Operations routing and the print standard** (F-10, F-12, C-23; Linear, Xometry). `ops_routing_rules` in `worker/lib/operations.ts` with on-duty reviewers; role-scoped palette search; a versioned default print standard referenced from every offer snapshot.

### Phase 4 — Community, projects, versions, profiles, search, collections, reputation, events

1. **Moderation V2 before any new community write surface** (F-01, F-02, F-03, F-04, F-05; Reddit, Linear). Build `docs/COMMUNITY_ECOSYSTEM.md` §9.6 (`worker/routes/adminModeration.ts`, `moderation_actions`, `moderation_appeals`, `users.status`), plus `community_rules` as report reasons, removal-reason templates in ar/en/ckb sent through `notify()`, grouped queue views with bulk actions, labelled user notes and the sanctions ladder.
2. **Domain events, automations and trust hold** (F-09, F-06, F-07; Reddit). `community_events` written in the same D1 batch as each action; `community_automation_rules` evaluated before INSERT with system-actor logging; a hold for new or low-trust accounts based on signals Levonis really has.
3. **Versions, licences, remixes and customisation** (E-07, E-08, E-02, C-10 library, B-11; GitHub, MakerWorld, STLbuddy). `project_versions` with changelog, compare and status; a closed licence list with a generated rights card; remix lineage with notice to the source owner; file roles; where-used; "Customise" on the project page with saved configurations.
4. **Print profiles and makes** (E-03, E-04, E-05, E-06, F-13; MakerWorld, Printables). `project_print_profiles`; `make` as a post kind (or table) attached to profile and version; prompts after delivery or export; separate honest counters; composer quality checks.
5. **Help questions and accepted answers** (E-12, E-13, E-11; Reddit, GitHub). `question` kind with `accepted_comment_id`; a helpful vote with confidence-bound ranking; file-problem reports separate from Q&A.
6. **Spaces and threads** (E-18, E-19, E-17, E-22, F-08, E-20, E-21; Reddit, Discord, Circle). `community_spaces` with guidelines, allowed kinds and required labels; follow and mute with notification levels; lock and pin; reply collapse and paging; comment editing with history.
7. **Feed and search** (E-14, E-15, E-27, E-28; Reddit). Sort control with decay and an explanation; hidden early counts; comment search and time windows; "show fewer like this" and a diversity cap in For You.
8. **Collections** (E-25, E-26; Pinterest, Reddit, MakerWorld). `community_collections` and `collection_items` replacing the one-collection-per-save limit of `community_saves`, with search inside saves, public collection pages and a masonry grid.
9. **Reputation, recognition and merchant tiers** (E-30, E-31, E-32, E-33, F-16; Printables, Circle, Reddit, MakerWorld, Xometry). `community_reputation_events` with caps, idempotency and compensating revocation; appreciation tokens from verified events; achievements and per-space leaderboards; non-monetary unlocks; capped tiers for new merchants and a transparent merchant score. No money value without an owner decision.
10. **Contests, picks, credits, provenance and takedown** (E-35, F-14, E-10, E-09, F-15; MakerWorld, Behance, Printables). A contest entity tied to versions; editor's picks with a recorded reason; project credits with consent on the creator page; a required provenance field; a rights takedown workflow with counter-notice (timelines from the owner).

### Phase 5 — 3D viewer, AR, device tests and server rendering

1. **Gestures** (D-10). Double-tap pivot and background re-centre in `ModelViewer.tsx`, then enable two-finger pan; Reset; a documented keyboard map.
2. **Spatial annotations** (D-11). `file_annotations` anchored to revision and mesh fingerprint; owner explanation points and request-thread spatial comments visible only to the parties.
3. **AR on iOS and Android** (D-12). USDZ and GLB derivatives from the approved view copy; Quick Look, Scene Viewer and a desktop QR; true-scale badge and restore; hit-test placement; AR off when the owner chose no geometry to the device.
4. **Level-1 server rendering** (D-06). A turntable render job writing private renditions; frame scrubbing as both the images-only mode and the no-WebGL fallback; host and cost decided by the owner.
5. **Progressive loading** (D-13). Coarse mesh first, finer on idle or request, under a device budget; a determinate progress bar.
6. **Preview modes** (D-14, D-25). Assembled, exploded, x-ray, cavity; clay shading and filament tint; "preview only" labels; one-gesture light rotation.
7. **Measurement and inspector** (D-16, D-15). Point-to-point measuring with snapping; print-oriented overlays (open edges, overhang heat map, thin walls) fed by the B-15 checks.
8. **Real plate in the site viewer** (D-17). The chosen merchant's plate and keep-out zones under the part.
9. **Inline viewer and default view** (D-22, D-18, D-20). An inline component without a scroll trap; an owner default view per revision; "what you saw" screenshots attached to requests on explicit action.
10. **Device test matrix.** Real iPhone and Android checks for AR, gestures and memory budgets before release.

### Phase 6 — Image-to-3D, geometric search, maintenance centre, contextual assistant, VR

1. **Image and video to 3D** (B-24; MakerLab, STLbuddy). A background job with real, resumable states; cost or quota shown before running under an owner policy; output always NEEDS_REVIEW and labelled as generated.
2. **Assistant safety core** (H-01, H-03; Sidekick). Merchant intents in the existing assistant scoped by `requireStoreOwner` before retrieval; `worker/lib/assistantTools.ts` with validated inputs, read and action tools separated, response caps, timeouts and untrusted-output handling.
3. **Draft-only writes** (H-02). Assistant actions return typed drafts opened in the normal editor; the merchant saves through the existing route; no money, publishing, rights or file access.
4. **Answers with sources and saved questions** (H-04, H-06). Questions mapped to named reports with period, filters and source; proven vs possible causes; per-user saved questions.
5. **Contextual "Ask"** (H-05). Typed `{type, id}` context on orders, offers, analytics tiles and builder blocks, re-read under server permissions.
6. **Budgets and languages** (H-07). Per-store AI budget with quota shown; a provider adapter; everything works without the LLM; no machine-generated `ckb`.
7. **Maintenance guides** (G-01, G-02; iFixit). Guide, step, version and source tables with hazard tags; parts linked only through verified fits; a guide-scoped "ask about this step" with citations.
8. **Shape descriptors** (E-29; Thangs). Descriptors computed at upload, used first for duplicate detection, then for similar shapes.
9. **Drawing reader and product-copy drafts** (H-09, H-08). "Found X, you chose Y" chips that the customer confirms; product-description drafts only after an owner decision.
10. **VR** (D-26). Deferred; if built, it reuses the WebXR plumbing and is never required for ordering.

---

<a id="rea-usage-log"></a>
## REA usage log

**Tool.** REA (`rea-agents` 6.7.0; github.com/morluto/rea), used through the `reverse-engineer-anything` skill. Two commands were used: `analyze-javascript-application` (static) and `capture-web-screenshot` (runtime, through the headless Chromium proxy). Static runs parse shipped files as inert text and never execute them. No login, form, upload, checkout or payment was performed, and no bot challenge was solved or bypassed.

### What REA did (evidence ids)

| Evidence id | Reference | Command | Subject | Coverage | What it showed |
|---|---|---|---|---|---|
| ev_8942f21834b0ad272b1c883a45c16b3862d38cea07b8ca25544d9a0b6ee2611c | Shopify (first study) | static | Polaris web-component bundles | — | Basis of the 57-row Shopify gap study; reused, not redone |
| ev_963caf9707f55f7f5ea392a9b83922992926e9ace6f35a90c02d21c0bf4b3f33 | Shopify Sidekick | static | 6 cdn.shopify.com bundles of shopify.com/sidekick | 6 files, 287 findings, 0 parse failures | Marketing components and `sidekick-panel-*` animation classes only; no Sidekick logic (it runs in the logged-in admin) |
| ev_e303bcef198dba6a6dd63b09ee32186b4c7202a09294f131a6b4992936010bac | MakerWorld / MakerLab (proxy) | static | Open-source Bambu Studio web UI, `github.com/bambulab/BambuStudio@79df7ae` (AGPL-3.0), `resources/web/homepage3` and `data/text.js` | 9 files, 5 JS parsed, 19,444 AST nodes, 0 failures | Generic graph. Facts came from reading that tree plus three C++ files: the slicer ↔ MakerLab bridge commands, the trusted-host deep link, and dev fixtures of model, print-history and MakerLab-list data. Not MakerWorld's own code |
| ev_f56c650f4ab454aa0a1159f120fbf2e3b4977c164f225ab052386a6fd4da556c | STLbuddy | static | 71 Next.js chunks | Partial (React-DOM chunk hit the worker heap limit) | First pass |
| ev_a5f5e66468dfc52eeed10fd517b766ccb2773a9531f3fc80ee06f9a5befd315b | STLbuddy | static | All 75 chunks (about 9.5 MB) from stlbuddy.com/_next/static | 767 modules, 2,265 findings, 164 endpoint candidates, 48 storage nodes, 5 workers; graph partial | Tool registry, generator parameters, manifold worker, export gate, 3MF writer, credit idempotency, local storage |
| ev_e2d62ffde4c7a4945716efe4185fa490fb6fb1ff1a2240892c4132778c40d6e3 | STLbuddy | runtime screenshot | /name-maker, 2026-10-19 13:26:47Z | No GPU: failure modal | Step rail, header, failure-report flow |
| ev_e94bae509cb6a33634a9c8717b1dd812d2f2c4546074431d783a8cc2aa75dc7f | STLbuddy | runtime screenshot | /modular-storage-builder, 13:27:31Z | 3D canvas blank | Step rail, controls, readiness line |
| ev_5535d0ffd53848762cb1a136371d07e05e843a89b0b11e9b0d3c3434b918fe38 | Xometry | static | 56 same-origin Next.js chunks referenced by the public homepage | Partial: `b41ed3ad7873bb75.js` exhausted the worker heap and the graph was truncated; 283 endpoint nodes; GraphQL observations of 138 queries, 276 mutations, 13 subscriptions (with duplicates) | The homepage bundles ship the client code of the authenticated upload, quote, checkout and parts-library screens; operation texts and enums read as inert text |
| ev_2aa7d9bf697f1310270316e1068460d3730374222976fdf216da600b6a9deb0d | Xometry | runtime screenshot (one attempt) | Homepage | Vercel Security Checkpoint ("Failed to verify your browser", code 11) | Stopped there and closed the tab; no runtime evidence |
| ev_b940ef3122b90841503cb1bb05c4600ebc94287321546c97f58ff328ad689bb4 | Sketchfab | static | Official public Viewer API client `static.sketchfab.com/api/sketchfab-viewer-1.12.1.js` (6,573 B, sha256 2fac7133…) | 1 file, 1,768 AST nodes, 0 failures | postMessage RPC protocol, embed URL construction, origin checks, default iframe permissions |

Static analysis shows what code exists in a shipped artifact. It does not prove that a feature is live, how a server prices or ranks, or what users see.

### Documentation only (no REA)

- **Reddit:** six developers.reddit.com (Devvit) pages fetched; the historical ranking code in `github.com/reddit-archive/reddit` (`_sorts.pyx`, CPAL-1.0) through a WebFetch summary, described and not copied; help-centre facts from WebSearch extracts of named support.reddithelp.com articles (17 searches).
- **Shopify:** shopify.dev (5 docs), changelog.shopify.com (13 posts plus the index), shopify.com/sidekick; Help Center facts through WebSearch summaries marked [WS].
- **MakerWorld:** wiki.bambulab.com (13 pages), blog.bambulab.com (3 posts), makerworld.com sitemaps (9 loads, not challenged); contest and points details from WebSearch.
- **Xometry:** 11 public xometry.com pages and 8 community.xometry.com KB articles; VQC only from job postings (inferred).
- **Sketchfab:** help.sketchfab.com root, 3 collections and 11 articles; developer pages only through WebSearch summaries.
- **Breadth (10 sites):** 33 page loads logged in the study's fetch log (Linear docs, help.prusa3d.com, Thangs pages, Discord developer docs and blog, help.circle.so, create.pinterest.com, docs.github.com, one iFixit guide); Etsy and Behance from WebSearch snippets. No REA by scope (UX level).

### What could not be studied, and why

- **Reddit:** reddit.com/robots.txt answers a "Blocked" page to automated clients; every support.reddithelp.com article returned a Cloudflare challenge (HTTP 403), not bypassed; WebFetch failed with ENOTFOUND; redditinc.com is refused to the search agent. So there is no screenshot, runtime capture or bundle analysis of reddit.com, by robots and by the owner's rules.
- **Xometry:** the quoting app (`/quoting/`, `/checkout/`, `/orders/`) is disallowed by robots and by the task, so the live quote, real prices, quote expiry and server limits were not observed; runtime capture hit the Vercel checkpoint; help.xometry.eu has `Disallow: /` with `ai-input=no` and was skipped.
- **MakerWorld:** every makerworld.com HTML page returns 403 with a Cloudflare challenge. The headless browser was not used there because it would solve the challenge automatically. web.archive.org snapshots were reset by the egress, and makerworld.com.cn was reset too. No MakerWorld bundle was analysed; the REA evidence is from the open-source Bambu Studio proxy.
- **Sketchfab:** sketchfab.com and api.sketchfab.com answer HTTP 202 with `x-amzn-waf-action: challenge` (AWS WAF). No screenshot and no main viewer bundle analysis; `/i/*` and media.sketchfab.com geometry paths are robots-disallowed and were not touched.
- **Shopify:** every admin surface (theme editor, analytics, bulk editor, Sidekick) needs a login, so no runtime REA; help.shopify.com returned a 403 bot interstitial and WebFetch could not resolve it.
- **STLbuddy:** `/backend` (the API base), `/api/` and `/models/browse?` are robots-disallowed and were never called, so the credit ledger, entitlements and the Image to STL engine are known from client code only; paid and AI tools were not run; nothing was clicked past the first screen; the headless browser had no GPU; the 390 px layout was not captured.
- **Breadth:** help.etsy.com (403 challenge), etsy.com (captcha), developer.etsy.com (404), support.discord.com, help.behance.net and www.printables.com (Cloudflare 403) were not retried; help.pinterest.com and www.behance.net disallow Claude agents in robots.txt, so nothing was loaded from them.

---

## Owner decisions this matrix depends on

1. Licence vocabulary and wording for projects, templates and remixes (E-08, B-22, D-02), recorded in DECISIONS.md.
2. Offer validity and reservation policy, cancellation after acceptance, and whether platform defaults exist for speed surcharges (C-09, C-25, C-11).
3. The default print standard text for FDM and resin (C-23).
4. Whether a lossy view copy is acceptable to merchants and owners, and the host and cost of level-1 server rendering (D-04, D-06).
5. Takedown and counter-notice timelines, and sanction durations (F-15, F-05).
6. Any money value or redemption for community points, appreciation tokens, BOM creator attribution or designer royalties (E-30, E-31, C-15, B-22).
7. Coupon eligibility by customer segment (A-19), and product stock-decrement timing (A-15; the Shopify gap study row 36).
8. AI scope, budgets and providers for merchant mode, and whether product-copy drafts are allowed (H-01 to H-08).
9. Templates per page type in the store builder (A-06) and merchant targets (A-13).

## Open Levonis questions found by the study

- Whether any report-store path exists outside the storefront components (a bounded grep found none; A-01).
- Whether carousels and countdowns already pause while their block is selected in the builder (A-02).
- Whether product stock goes down when an order is placed or when it is delivered (A-15).
- The data sources of `src/pages/Leaderboards.tsx` (the farm game) and `src/pages/Rewards.tsx` (purchase points) were not read in depth; neither is a community reputation source today (E-30, E-32).
- Moderation V2 (`docs/COMMUNITY_ECOSYSTEM.md` §9.6) is designed but unbuilt; this plan schedules it first in phase 4 (F-01 to F-05).
- Real-device AR (iOS Quick Look, Android Scene Viewer) has not been tested; today's WebXR path does not work on iOS Safari (D-12).
