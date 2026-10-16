# One-time Bambu Lab catalog import: implementation spec (FINAL)

Repository `/home/user/Levonis`, default branch `claude/new-session-2hq4ci` at `0988169f`.
This is a read-only design. Nothing here was pushed, deployed or run against levonis-iq.com or any production database.
This revision replaces `import-spec.draft1.md`. It answers the 42 review findings; the ledger is §N.

**Authority:**

- The owner's brief, «LEVONIS — BAMBU LAB COMPLETE PRODUCT INTELLIGENCE IMPORT»: rules R1–R15, sections 1–22.
- `docs/DECISIONS.md` row 239 (2026-10-15):
  - Levonis has Bambu Lab's permission to republish official images and descriptions.
  - Production D1 and R2 may be read and written for this task only.
  - Every unpriced product is visible catalog-only, and price requests are signed-in only.
- Rows 221–222 and 233–236 (Pricing V2) still apply. So does row 2: no machine or AI translation, only the local deterministic dictionary.
- Row 183: a `ckb` slot never carries a copy of the Arabic.
- Row 184: only workflow 7 deploys the live Worker.
- Row 237: migrations are additive only. No table rebuilds and no widened CHECKs.
- Row 240 is catalog-only's (`feat/catalog-only`, 0193). This import writes row **241**.

**Inputs this spec builds on:**

- `scratchpad/bambu/levonis-survey.md`
- `scratchpad/bambu/source-analysis.md`
- `scratchpad/bambu/collections.json`
- `scratchpad/bambu/samples/*.json` (8 fixtures)
- the parsers in `scratchpad/bambu_tools/`
- the catalog-only spec `scratchpad/bambu/b1a/spec.md` (branch `feat/catalog-only`, migration 0193)

**Migration numbers:**

| Number | Owner |
|---|---|
| 0192 | Services S-P2 |
| 0193 | catalog-only and price requests |
| **0194** | this import: the product knowledge model |
| **0195** | this import: the import run, its ledger and its guards |

Both import migrations were executed on `node:sqlite` while this spec was written (`scratchpad/bambu/final/ddl.sql`, `ddl2.sql`, `scan.mjs`): the DDL parses, the transition trigger refuses every illegal move it was tried with, and the media-name scan output is the list in §B.9.

All line references below are at `0988169f`.

---

## 0. Summary of the design

1. **Three moving parts, one write path.**
   - **The importer** (Node, `scripts/bambu-import/`) runs only inside the `workflow_dispatch` workflow 60. It crawls, parses, enriches, maps and verifies.
   - **The live Worker** is the only process that writes production D1 and R2. It exposes a token-guarded ops endpoint, `/api/ops/catalog-import`, which:
     - re-validates every payload against an allow-list;
     - enforces the **reviewed scope** bundled into the Worker: the manifest, the taxonomy map, the existing-product matches, the compatibility targets, the identity map, the media overrides and the curated index, each checked by SHA-256;
     - ingests images through the existing pipeline (`guardedFetchBytes` → IMAGES → content-addressed R2);
     - writes each product through the app's own `planProductSave`, in one atomic batch that also carries the checkpoint.
   - **The public site is the witness of COMPLETE.** Structure is checked through the anonymous site API (`/api/products/<slug>`, `/knowledge`), presence through the public v1 API, the listings and search, and the page itself through Playwright. The Worker independently recomputes the D1-side facts before it accepts COMPLETE.
2. **No new platform.** Every imported product is an ordinary `products` row with its usual option, variant, image, catalog and search rows.
   - Typed specs with provenance, documents, external ids, relations, source identity and swatches live in additive side tables keyed by `product_id`.
   - Existing readers keep working through mirrors written in the same batch: `spec_fields` and `specifications` feed compare, facets and the page; `product_printer_fits` feeds «يناسب».
3. **Sequential by construction.**
   - One active run, and one in-flight item per run (partial unique indexes; BLOCKED counts as in flight).
   - A transition trigger allows only the legal state graph: a BLOCKED item can never return to DISCOVERED or jump to COMPLETE.
   - A lease fenced by a trigger, so a stale executor's batch aborts.
   - The next store page is fetched only after the current COMPLETE has committed.
4. **Commerce data cannot enter.**
   - A strict allow-list payload, and a sentence classifier that removes money, promotion and shipping-policy text and withholds manufacturer warranty text.
   - The writer builds the `ProductDoc` from defaults and never forwards a price, cost or stock key.
   - DB guard triggers abort any money, stock, package or pricing write inside an import batch.
   - Merges read before/after fingerprints of the protected fields inside the same batch.
   - **An imported product cannot become sellable by accident.** It carries `stock_decision = 'not_configured'`, and the Pricing V2 write refuses to publish it until the owner chooses a stock mode (§B.10).
5. **Nothing private leaves in clear.** Actions logs and artifacts of the public repository are public. Logs carry counts, codes, booleans and public URLs only. Every artifact is sealed in the job to a one-time X25519 public key passed at dispatch, and only the agent holds the private key (§A.8).
6. **Catalog-only must be live first,** together with the live-probe changes it needs (§K.1). Not one product is written before that.

---

## 1. Deviations from the brief: where a requirement is met differently, and why

| # | Brief requirement | How it is met here | Why |
|---|---|---|---|
| 1 | §2 "complete pagination of every collection" | The products sitemap (1,115 URLs) is the coverage source. Collection pages give page-1 membership, used for naming and secondary memberships. The end-of-run re-check re-reads the three sitemaps. | Collection grids are paginated client-side and only page 1 is server-rendered (source-analysis §8). Crawling an undocumented pagination API would mean guessing, and it touches robots-disallowed patterns (`*filter*`, `sort_by`). |
| 2 | §2 breadcrumbs from the source | Derived from `P.currentAllIdRoute` plus the reviewed taxonomy map (§D). | Category names are not server-rendered (source-analysis §0.6). |
| 3 | §4 SKU / MPN / GTIN | Product pages publish none (`skuCode` is null for 134/134 variants). Bambu ids are kept as external ids. Real SKU codes are harvested in P0 by a dedicated cross-sell reader (§C.1) and frozen in the reviewed manifest. Barcodes: none. | No fabricated identifiers. |
| 4 | §4ج / §14د.4 colour HEX | Colours are option values in a group with `kind = 'color'`. Their swatch is the official swatch image. A hex is stored only where Bambu publishes one (for example the PLA Basic "Hex Code" PDF), through curated data with provenance. | `product_colors.hex` is `NOT NULL` and validated (`worker/lib/productPersistence.ts:824-826`); an invalid value becomes `#000000` (:861). Using `product_colors` would force an invented hex. |
| 5 | §5 "Black Refill and Black With Spool each have their own image" | The source publishes one image per colour, shared by Refill and Spool (source-analysis §7). It is bound at colour level. The report lists every variant without an image of its own as "shares its colour's image". | No image is invented or borrowed from another SKU (§5). |
| 6 | §5 "keep the original resolution" | Originals are fetched (the URL without `__op__`), converted to WebP and stored at most 2048² px / 3,072 px edge, aspect kept. The original URL is owner-only provenance (`product_images.source_url`). | Levonis media policy (`worker/lib/imageConvert.ts:86-105`, row 226). |
| 7 | §11 ENRICH from external sources at run time | Flagship products (§F) are enriched before the run by agents from TDS/SDS PDFs, the wiki and manuals, committed with page and quote. At run time ENRICH re-checks every document link, resolves tracker links, and follows at most 3 wiki links per product that the store page itself gives (≥ 5 s apart), parsing their tables with the deterministic parser. | bambulab.com is behind a bot challenge that must not be bypassed. PDF tables need review, not a blind parser. wiki.bambulab.com is reachable and structured (source-analysis §9). |
| 8 | §6 / §19 third-party sources | None by default. The schema supports `confidence = 'independent'` with a mandatory label. | The brief ranks official data first. No third-party source has been vetted. |
| 9 | §8 `price = NULL`, `stock = NOT_CONFIGURED` | See below. | Row 237 (no table rebuild) and catalog-only §1.1. |
| 10 | §4و logistics with CBM | Logistics live in the typed-spec table (group `logistics`), separate from `products.package_*` / `net_weight_g`, which the importer **never writes**. CBM is derived from documented carton dimensions of one scope and one source, inputs kept. | Those columns feed Pricing V2 freight and the PACKAGE_* completeness codes. The brief says logistics must "never link to pricing". |
| 11 | §17 "Resume" control on the dashboard | The dashboard is read-only. It shows the exact resume instruction: a dispatch of workflow 60. | The Worker holds no GitHub credential; adding one is a Worker secret, and a secret change redeploys outside workflow 7 (row 184). |
| 12 | §10 admin notification centre | catalog-only §4.7: a throttled Telegram digest to the `report` topic. | There is no in-panel admin centre (survey §4). |
| 13 | §4ز documents | Verified links to the official URLs (store CDN PDFs, wiki, YouTube), not re-hosted (decision L-3). | The media pipeline is images-only. |
| 14 | §5 every description image | All gallery, variant, swatch and in-the-box images are ingested. Marketing-section images are capped at 40 distinct per product, in page order; extras are listed by URL in the report (L-2). | Bespoke printer pages carry dozens of 4–18 MP banners. |
| 15 | §19 names in every language | `name`, `name_ar` and `name_ku` hold the official English title. | §19 "keep the English name as-is in all languages". Not Arabic copied into ckb. |
| 16 | §19 translation | Prose stays English. ar/ckb slots get only what the local dictionary renders, with status `review_needed`. Labels come from authored dictionaries (§C.8). | Row 2. |
| 17 | §1 test environment like production | Migrations proven on a throwaway database by workflow 7; an in-process dry run in CI; a `wrangler dev --local` dry run (§K step 10). | No separate staging Worker exists. |
| 18 | §1 backup / restore point | A D1 Time Travel bookmark at every job start, in the job summary. R2 writes are content-addressed put-if-absent. | The workflow 7 mechanism. Restore also rolls back customer activity, so it is a last resort; the controlled rollback is §A.10. |
| 19 | §5 screenshot test per product | Playwright checks every product page. Screenshots are kept for the 8 audit classes, 1 in 25, and every failure, and leave the job only sealed. | Artifacts of a public repository are public. |
| 20 | §11 "a product disappears from the source mid-run" | Not a skip. The item goes BLOCKED `SOURCE_WITHDRAWN`. With evidence (404/410 or a redirect to a collection, plus absence from the sitemap, on two fetches ≥ 24 h apart) and the owner's approval it moves to the terminal `WITHDRAWN_AT_SOURCE`, which is never COMPLETE; the run then closes as "partial". | Only COMPLETE, BLOCKED or an evidenced withdrawal can end an item. |
| 21 | §4ب manufacturer specs "specific to the option" | The US store's tables are the US 110 V versions. Their electrical and region-dependent package/weight values are stored with `region = 'us_110v'`, `status 'unverified'` and the condition «النسخة الأمريكية (100–120 فولت)». For curated printers the 220 V / "UK and other version" values that the same official page carries are stored as `intl_220v` and shown first. | The table itself says "purchase the version corresponding to your region's voltage". Iraq is 220 V. |
| 22 | §22 "the price request was tested" for every product | Every product's request path is checked through the Worker's own request validator (eligibility per selection, no row created). A real signed-in request is sent only for the canary and the audit classes, and only if the owner provides a dedicated test account (L-17). | No customer credential exists in the repository, and creating one is the owner's call. |
| 23 | §6/§8 Bambu warranty never presented as Levonis's | Manufacturer warranty, return and refund sentences are withheld from customer content and kept as owner-only spec rows (L-19). | Showing them, even labelled, is an owner choice. |
| 24 | §9 / §G.5 a card's 2–4 key properties (printers: enclosure, colours; plates: size, surface) | The card reads the registry's card keys, then the shop's own fields `enclosed`, `max_colors`, `plate_size` and `plate_surface` (`worker/lib/knowledge/cards.ts` `CARD_FIELDS`), a yes/no or a count worded in ar/en/ckb («هيكل مغلق», «حتى 16 لونًا»). The importer mirrors none of these four: an imported printer's card shows its section and build volume, an imported plate's its section, until the owner or curated data (§F) fills them. | The store publishes no «Enclosure» row and states colours only in prose; the registry gains no key without a source (no invented value). |
| 25 | §G.3 "Cards keep the house 1:1 frame with `contain` for imported products" | Not done: imported products keep the house compact card (6:5 photo, top-anchored cover). | The house card is 6:5, not 1:1 (DECISIONS row 142); a 1:1 frame for some cards breaks the fixed card height in mixed rows. `contain` needs an import marker on every listing statement (`product_source_refs`, behind a 0194 fallback) and leaves charcoal bars beside a white-background photo: an owner decision. |
| 26 | §G.5 "one muted line under the name" | The line's row is reserved on every compact card and on its skeleton, drawn or not, and the home page's cards carry the line too: the fixed card height is 280 px at 174 px wide (it was 262, DECISIONS row 142); `lv-cv` and the browser checks follow (6:5 photo + 137 px body). | A line on some cards only stairstepped the rails and grids and shifted the skeleton (review of step 7). |
| 27 | §G.3 "a value that forms no active variant … is shown disabled" | It says «غير متاح مع هذا الاختيار» (dimmed) and stays pressable: pressing it selects it and lets go of the other groups' values that clash with it (a group left with exactly one fitting value takes it) — `src/lib/productChooser.ts` `chooseValue`. | Disabled, the H2D opened with two of its three versions unreachable (review of step 7). |
| 28 | §I.1.7 "the breadcrumb contains the leaf section name" | Not checked: the browser check records `breadcrumb` as not applicable («the product page draws no breadcrumb», `scripts/bambu-import/browser.ts` `NOT_APPLICABLE`) and never fails on it. The section is proven by check 3 (the leaf, root and secondary listings, the tree count) and check 10 (the Worker's `category_id` / `sub_category_id` and `product_catalogs` recompute). No breadcrumb is added to the live page; the owner is told. | The product page draws no breadcrumb and never has (step-8 integration, a local run against the built page): the check could only fail, every product. |

Row 9 in detail:

- `products.price_iqd` is `NOT NULL DEFAULT 0` (0001:86). The writer never sets a price: the new row holds the schema default.
- "Unpriced" is derived: VISIBLE and not SELLABLE, with no `pricing_v2_sku_results` row. Every customer projection emits `price_iqd: null`, `price_status: 'unpriced'` and never reads the column (catalog-only §3.1).
- `stock` is `NULL`, which in Levonis means **untracked and unlimited** (`worker/lib/inventory.ts:126`, `:205-210`), not "not configured". So the import records "not configured" explicitly: `product_source_refs.stock_decision = 'not_configured'`. The Pricing V2 write refuses to publish such a product (409 `IMPORT_STOCK_NOT_CONFIGURED`) until the owner chooses "track quantity" or "untracked, to order" (§B.10, L-16). This is the brief's PRICED_NOT_CONFIGURED_FOR_SALE (§18C).

Every other rule is met as written. The R1–R15 matrix is in §M.

---

## A. Architecture and the production write route

### A.1 Shape

```
GitHub Actions workflow 60 (dispatch-only, default branch only, concurrency group "bambu-import")
  job import (permissions: contents read; persist-credentials false; inputs only through env, validated first)
  ├─ deadline = job start + 330 min (timeout-minutes 350)
  ├─ wrangler steps ONLY (step-level CLOUDFLARE_* env): resolve + mask DB id; preflight; Time Travel bookmark;
  │    mint per-job token T (256-bit) into a 0600 file, store SHA-256(T) on the run row
  └─ node scripts/bambu-import/run.ts  (env: IMPORT_TOKEN_FILE, DEADLINE_EPOCH, SEAL_PUBKEY; reads T, deletes the file)
        /hello (protocol, migrations, reviewed-bundle SHA-256s equal the runner's files)
        loop, ONE item at a time:
          lease ─► EXTRACT (store page: only after the previous COMPLETE, ≥ 11 s after the last store request) ─► ENRICH (curated JSON, doc + tracker checks,
          ≤ 3 wiki links) ─► VALIDATE (local) ─► POST /stage (reviewed-scope + allow-list + plan size)
          ─► POST /media (×N, ≤ 4 per call; the Worker fetches store.bblcdn.com only)
          ─► POST /write (ONE atomic batch: product + relations + side tables + checkpoint; status active)
          ─► POST /publish-finish (completeness recompute + purge of site, knowledge, v1, tree; idempotent)
          ─► VERIFY (public v1 + anonymous site API + knowledge + listings + search + compare + HEADs + Playwright)
          ─► POST /complete (runner evidence; the Worker recomputes the D1 facts and price-request eligibility)
          ─► next item
        every wait is checked against the deadline; a wait that does not fit releases the lease and exits more=true
  └─ always(): revoke the token (wrangler step); seal every artifact; upload *.sealed only
  job chain (needs: import; permissions: actions write; no checkout, no npm): dispatches the next job when
       more=true, blocked=false, chain=true, chain_count < 12
```

**Four changes to the recommended shape (kept from the draft):**

1. **`/stage` is a separate call before media.** It is the brief's PREVIEW step (§11.6). The server re-runs the allow-list, the reviewed-scope checks and taxonomy resolution, and plans against placeholder media. Cheap failures therefore happen before any byte is downloaded.
2. **`/publish-finish` is separate from `/write`.** Completeness recompute and purge cannot sit in the D1 batch (`recomputeMany` reads first). A crash between the two leaves the item at `PUBLISHING`; the retry runs only the finish.
3. **Incoming pending relations are resolved inside the subject's own write batch** (§B.6). There is no separate pass that edits a COMPLETE product outside its cycle.
4. **One token per job, not per run.** It expires at the job's end (≤ 6 h 15 min), is revoked in `always()`, and each chained job mints a fresh one.

### A.2 Why this route and not the alternatives

| Alternative | Why not |
|---|---|
| Write D1 directly from the workflow with `wrangler d1 execute` | Bypasses `planProductSave` and its gates: media verification, composition pins, the cost gate, search tokens, translations, the outbox. Images need the IMAGES binding, which exists only inside the Worker. `--file` executions are not one atomic transaction per product. |
| An admin session for the importer | Would put the owner's credentials in a public repository's Actions. Admin routes are owner/role-gated and cookie/CSRF-shaped. |
| A Worker secret as the importer credential | A secret change redeploys the Worker outside workflow 7 (row 184), and it would outlive the run. |
| Cron / Queues / DO inside the Worker | None is bound (survey §7). The quarter-hour D1 budget is already shared. The brief forbids anything scheduled after the run (R11). |

### A.3 The ops endpoint (Worker)

New router `worker/routes/catalogImportOps.ts`, mounted at **`/api/ops/catalog-import`**.

**Authentication middleware (`requireImportToken`), in order:**

1. `Authorization: Bearer <64 hex>` and `X-Levonis-Import-Protocol: 2` must both be present.
2. `h = sha256Hex(token)` (`worker/lib/crypto.ts:23`).
3. `SELECT … FROM catalog_import_runs WHERE token_sha256 = ? AND state IN ('open','running','blocked') AND token_expires_at > now`.
4. Any miss answers **404 `{ error: 'Not found' }`**, with the same body and timing class for no header, a bad token, an expired token and a closed run.
5. `c.set('importRun', row)`.

Every answer is `Cache-Control: private, no-store`. The route is CSRF-exempt (bearer token, no cookies). The deception gate (`worker/lib/deception/gate.ts`) must not treat it as a probe: add the prefix to its known routes and assert that in a test. Rate limit `rateLimit(c, 'catalog-import-ops', 600, 60)`, keyed by run id.

**The reviewed scope, enforced by the Worker.** `worker/lib/catalogImport/reviewed.ts` loads these committed files, imported as wrangler `Text` modules and parsed only by this router:

| File | What the Worker enforces |
|---|---|
| `data/bambu-import/manifest.json` | `/manifest` refuses any source id or handle not listed. Each row carries `type`, `curated`, `hold_code`, `queue_position`, `sku_codes`. |
| `data/bambu-import/taxonomy-map.json` | `/run/prepare-taxonomy` and every `/stage` and `/write` resolve the leaf from it only. |
| `data/bambu-import/existing-matches.json` | `/stage` and `/write` refuse `write_mode: 'merge'` unless `(source_product_id → levonis_product_id, decision merge or merge_publish)` is listed. They refuse `create` for any source the file marks `merge`, `merge_publish` or `hold_owner_hidden`, and refuse a merge into any Levonis id the file does not name for that source. |
| `data/bambu-import/compat-targets.json` | Relations and printer fits resolve only through it (§B.6). |
| `data/bambu-import/identity-map.json` | Model, series and family keys come only from it (§C.1). |
| `data/bambu-import/media-overrides.json` | The only way an image without a source binding gets one (§C.4). |
| `data/bambu-import/curated/index.json` | `handle → sha256` of each reviewed curated file. A curated-scope payload must carry the matching `curated_sha256`. |
| `data/bambu-import/search-synonyms.json` | The only synonyms `/run/prepare-taxonomy` inserts. |

`/hello` returns the SHA-256 of each file; the runner refuses to continue when its own copies differ. The open run stores the combined digest in `catalog_import_runs.reviewed_bundle_sha256`, and every job compares it. A changed file therefore needs a reviewed commit, which deploys through workflow 7.

| Method and path | Purpose | Side effects |
|---|---|---|
| `POST /hello` | `{ protocol: 2, expected_migration, migrations_present: {0193, 0194, 0195}, reviewed: {file: sha256}, run: {id, state, cursor}, worker_build }`. Called after `mode=open` has created the run and minted a token, at every job start and every 50 items. | none |
| `POST /manifest` | ≤ 100 rows per call. Rows must exist in the bundled manifest with the same handle, type, curated flag, hold code and queue position. `INSERT … ON CONFLICT(run_id, source, source_product_id) DO UPDATE` of discovery fields only, and only while the row is DISCOVERED. | `catalog_import_items` |
| `POST /items/:sid/lease` | Takes or renews the lease (15 min). Fenced by `ux_cii_inflight`. Returns `{lease_token, state, last_completed_stage, attempts, stage_attempts, retry_at, stage_data}`. | item row |
| `POST /items/:sid/event` | Records a transition the runner performed (EXTRACTING … RETRYING, BLOCKED) with a code from a fixed list and a template message. **On BLOCKED after WRITTEN for a product this run created, the Worker unpublishes it in the same call (§A.10).** | items, events |
| `POST /items/:sid/stage` | Preview: allow-list, reviewed-scope, identity, taxonomy, plan against placeholder media → `{payload_sha256, invocation_estimate, conflicts[], warnings[]}`. Refuses `PLAN_TOO_LARGE` (§A.6). Stores `payload_sha256`. | items |
| `POST /items/:sid/media` | ≤ 4 media per call, 45 s wall budget. Skips a medium already `stored` whose R2 object HEADs. Returns `{source_media_id, status, r2_key, width, height}` per medium. | R2, `file_objects`, `media_cleanup_jobs`, `catalog_import_media` |
| `POST /items/:sid/write` | The staged payload (same SHA-256). Re-validates, re-checks the reviewed scope, re-plans, counts the whole invocation (§A.5), then runs **one** `db.batch`. Answers `{product_id, slug, created|merged, counts, before_fp_equal, after_money_default}`. | product, relations, side tables, checkpoint |
| `POST /items/:sid/publish-finish` | If the item was unpublished on a block, a guarded batch first sets it `active` again. Then `recomputeMany` + purge for the product and every product whose relations changed: `cataloguePaths(slugs)`, `/api/products/<slug>/knowledge`, the tree cache (`purgeCatalogTreeCache`, `worker/routes/catalog.ts:73`), `/api/catalog/<leaf>` per affected section, and the public v1 keys `/api/public/v1/products/<slug>` and `/api/public/v1/sections/<leaf>`, built with the same `canonicalUrl` + `withCacheEpoch` as `worker/routes/publicApi.ts:136-142`. Then `state = VERIFYING_LIVE`. Idempotent. | completeness, cache |
| `GET /items/:sid/readback` | `reloadForVerification` + `verifyApplied` (`productPersistence.ts:3641`, `:3686`) against the payload, plus ownership checks. The admin-side half only. | none |
| `POST /items/:sid/complete` | Runner evidence (§I.1). The Worker recomputes the D1 facts and price-request eligibility (§I.1.10) and stores both. COMPLETE only when every hard check is true on both sides and their counts agree. | items, events |
| `POST /items/:sid/withdraw` | Owner-approved withdrawal (workflow 60 `mode=withdraw`, an approval reference required). Allowed only from BLOCKED `SOURCE_WITHDRAWN` with the two-fetch evidence. | items, events |
| `POST /run/prepare-taxonomy` | Insert-only, one batch: missing catalog nodes and the brand from the bundled map, and the reviewed ar/ckb search synonyms (`INSERT OR IGNORE INTO search_synonyms (term, canonical)`, so an existing or owner-added term is never overwritten). | `catalogs`, `brands`, `search_synonyms` |
| `POST /run/protect-snapshot` | Protected fingerprints (§E.4), `phase = 'before' | 'after'`. | `catalog_import_protected` |
| `POST /run/finish` | `state = 'closed'` (or `'partial'` when any item is BLOCKED or WITHDRAWN_AT_SOURCE), `token_sha256 = ''`, `closed_at`. | runs |
| `GET /run/status` | Counts by state, current item, rate, last verified URL. | none |

Every body is JSON ≤ 2 MB. Errors are `{ code, message }`, message ≤ 300 chars from fixed templates plus ids, never echoed input or SQL text.

**Kill switch.** Workflow 60 `mode=revoke` sets `token_sha256 = ''` and marks the run stopped (`notes = 'kill_switch'`, one wrangler command). With no open run every path is 404. The mark lasts: the mint step of a chained job (`chain_count` above 0, dispatched before the switch or after a door that only answered 503s while the token was cleared) refuses the marked run, so no chain re-arms it. Only the owner's own dispatch (`chain_count 0`) lifts it, and its mint step says so. The always() revoke at the end of every job clears the token only.

### A.4 Inside `/write`: reusing the app's write path

New module `worker/lib/catalogImport/writer.ts`:

1. `assertImportPayload(payload)`: the allow-list validator (§C.10). Unknown key → 400 `IMPORT_PAYLOAD_KEY_REFUSED` with its JSON path.
2. Resolve the item, lease and run. Check the reviewed scope (§A.3). Resolve the brand (`brands.slug = 'bambu-lab'`, created by the prepare step if absent; `name_en` / `name_ar` / `name_ckb` all "Bambu Lab") and the taxonomy (§D), every target catalog id read from D1.
3. **Build the intent.**

   **create:**
   - `doc = newImportProductDoc(fields)`, a new function in `worker/lib/catalogImport/doc.ts`:
     `validateProductDoc({ ...allowListedFields, price_iqd: 0 }, { costBlind: true })` (`worker/lib/productModel.ts:980`). `price_iqd: 0` equals the column default; every other money key is absent, so the validator's defaults apply. A unit test asserts that every money, stock, package, warranty, ops, offer and condition field of the result is the schema default or null.
   - Allow-listed fields only: names, descriptions, `category_id` / `sub_category_id`, `brand_id`, `spec_fields` (mirror, §C.6), `specifications` (mirror), `content_blocks`, `usage_guide`, `description_videos`, `template_family`, `status = 'active'`, `inventory_mode` (`BASE`, or `VARIANT_COMBINATION` when there are groups), and the form-default `sale_types`.
   - **No price, cost, stock, sku, warranty, ops, offer or condition key is ever set.**
   - `relations` = the wire body (`RequestedRelations`, `productPersistence.ts:503-582`) with deterministic ids (§B.8). Every option value carries an explicit **`variant_key = 'bv-' + H(source value id)`** and `variant_label` = the source text, so `legacyShapeErrors` (`worker/lib/optionFulfillment.ts:819-850`) never sees two new values sharing a key (H2D's `Standard` / `standard`). Every `prices` is the empty `PriceInput`, every `stock` / `low_stock_threshold` null, `colors: []`, `facet_ids: null`.
   - `catalogIds` = primary + secondary memberships. `printerFits` = resolved compatible printers. `translations` = local-dictionary output (§C.8).
   - `actor = { adminId: 'system:catalog-import', money: false }`, `allowComposition: false`.
   - **Slug:** `uniqueProductSlug(productSlugFrom(handle))`. Both are new exports: `uniqueProductSlug` moves out of `worker/routes/adminImport.ts:2277` (module-private today) into `worker/lib/productSlug.ts` with `productSlugFrom` (ASCII, the same rules as the admin import), and `adminImport.ts` imports them. No behaviour change; covered by the existing import tests. The slug is stored on the item and stays stable on retries.

   **merge:** the intent is built from stored state (§E.3), only for a pair the bundled matches file lists.
4. `preflightProductSave(db, intent)`, then `verifyAndNormalizeProductMedia` (`worker/lib/productMediaWrite.ts:28`) for every `/files/...webp`, then `planProductSave(db, intent, { relationMediaMetadata: 'authoritative' })`.
5. **Assemble the batch** (§A.5).
6. **Count the invocation** (§A.5). Over the limit → BLOCKED `PLAN_TOO_LARGE`.
7. Run `db.batch()`. Compare `fpBefore` / `fpAfter` in memory and return only the two booleans. A mismatch cannot happen without a guard trigger firing; if it does, BLOCKED `PROTECTED_FIELDS_CHANGED` with the slug and no values.
8. Post-commit, through the new `postCommitProductSave(db, plan, auditRows)` exported from `saveProductAtomic`'s body (no behaviour change; `saveProductAtomic` calls it): audit rows `catalog_import.write`, and `queueDetachedProductMediaAfterCommit` (always empty for a create or a merge).

**Side statements the planner does not write**, appended in the same batch after `plan.statements`:

- `UPDATE product_option_groups SET name_ar = ?, name_ckb = ?, kind = ?, default_value_id = ? WHERE id = ? AND product_id = ?` per group. A later admin save leaves these columns alone, because the planner's group upsert does not name them.
- `product_source_refs` (with `stock_decision = 'not_configured'` for a create), `product_option_source_refs` (with `binding_rule` per image row), `product_spec_values`, `product_documents`, `product_external_ids`, `product_relations`, `product_option_value_swatches`.

### A.5 The atomic batch, its fences and its statement budget

```
0  INSERT INTO ops_guards (id, ok) VALUES ('catalog-import-batch', 1)          -- arms the DB guards (§B.4); ops_guards is (id, ok CHECK ok=1), 0162:4
1… protected fingerprint SELECTs, one per protected table, only for merges (new products: SELECT 1)
…  plan.statements                                                              -- products, relations, images, catalogs, printer fits,
                                                                                --   search tokens, translations, outbox ProductAdded
…  side statements (§A.4)
…  incoming: UPDATE product_relations SET target_product_id=?, state='resolved', resolved_at=? WHERE state='pending' AND target_source='bambu_us' AND target_source_handle=?
             INSERT OR IGNORE INTO product_printer_fits … (when this product is a printer)
n-2 INSERT INTO catalog_import_events (…, stage='WRITTEN', lease_token=?)      -- FENCED by trg_cie_lease_fence
n-1 UPDATE catalog_import_items SET processing_state='PUBLISHING', last_completed_stage='WRITING', levonis_product_id=?, slug=? WHERE … AND lease_token=?
n…  protected fingerprint SELECTs again; the money-default probe for a new product
n+1 DELETE FROM ops_guards WHERE id = 'catalog-import-batch'
```

- D1 executes a batch as one transaction: the product and its checkpoint commit together or not at all (the `product_import_items` precedent, 0099:676-720).
- D1 serialises batches, so no other writer's batch observes the guard row. On abort the INSERT rolls back; on commit statement n+1 removes it.
- The fingerprint material is read **one table per statement**, never one UNION chain, so no statement exceeds D1's 100 bound parameters or 5 compound terms.

**The statement budget counts the whole invocation, not the batch.** D1's limit is 1,000 queries per Worker invocation and a batch counts each statement (`D1_INVOCATION_STATEMENT_LIMIT`, `worker/lib/quarterHourBudget.ts:44-45`). The ops router wraps `c.env.DB` in a counting proxy. Before `db.batch()` the writer checks:

```
reads so far (auth, rate limit, lease, reviewed checks, preflight, media verification, planner reads)
+ batch length
+ post-commit estimate (audit rows, media queue)
≤ IMPORT_INVOCATION_LIMIT = D1_INVOCATION_STATEMENT_LIMIT − IMPORT_RESERVE (100) = 900
```

`/stage` returns the same estimate. Tests run the writer through `tests/fixtures/d1Limits.ts` (`LimitD1`), which enforces the 100-parameter and 5-term limits.

### A.6 Very large products

There is no staged path. `planProductSave` replaces relations wholesale: a missing `images` collection becomes `[]` (`productPersistence.ts:230-231`), stored images not in the body are deleted (`:1418-1434`), and every group, value, variant and image is re-upserted on every save (`:1486-1735`). A partial save would either delete earlier slices or resend them, so it cannot shrink anything.

Above the invocation limit, or above the planner's `MAX_ROWS_PER_COLLECTION = 400`, the item goes BLOCKED `PLAN_TOO_LARGE` or `ROW_CAP`. P0 measures every manifest product's estimated plan size (§K step 3); none is expected near the limit.

If one ever is, the fix is a separate, reviewed **append-only image stage**: plain `INSERT` of new `product_images` rows with their own media verification, after a normal save without those images. It is never a partial replace, and it is not built unless P0 finds such a product.

### A.7 Resumability and the job deadline

- **The durable state is D1:** `catalog_import_items` (state, `last_completed_stage`, `stage_data`, `attempts`, `stage_attempts`, `retry_at`, lease) and `catalog_import_media`. The runner keeps nothing it cannot rebuild.
- **On lease** the server answers with `last_completed_stage`; the runner resumes at the next stage, re-fetching the page if EXTRACT's fingerprint is older than 24 h.
- **Media already `stored`** (R2 HEAD confirmed) is never re-fetched; a vanished object is re-ingested.
- **An ambiguous write failure** (timeout after send): `/lease` reports `levonis_product_id` when the checkpoint committed, and the runner continues at `publish-finish`. Otherwise deterministic ids make the re-send idempotent. A duplicate create is impossible: the `product_source_refs` primary key `(source, source_product_id)` aborts the batch.
- **Leases** last 15 min and every call renews them.

**The deadline is absolute.** The workflow's first step computes `DEADLINE_EPOCH = job start + 330 min` (the job's `timeout-minutes` is 350). The runner keeps a table of worst-case stage durations:

| Stage | Worst case |
|---|---|
| EXTRACT | 60 s (11 s spacing + 30 s timeout + parse) |
| ENRICH | 6 min (≤ 20 document checks, ≤ 5 tracker HEADs, ≤ 3 wiki pages at ≥ 5 s) |
| VALIDATE + `/stage` | 45 s |
| one `/media` call | 50 s |
| `/write` | 90 s |
| `/publish-finish` | 30 s |
| VERIFY | 10 min (including a ≤ 360 s cache wait) |

Rules:

1. Every wait (backoff, `Retry-After`, cache wait, spacing) must satisfy `now + wait + worst(stage) < deadline`.
2. `/write` starts only when `now + worst(write) + worst(publish-finish) + worst(verify) < deadline`, i.e. at least about 13 minutes remain. A committed product is therefore verified in the same job.
3. When a wait does not fit, the runner sends `event RETRYING` with `retry_at`, sets the lease to expire now, and exits `more=true blocked=false`, so the chain job continues. The next job resumes the same item first: RETRYING is in flight, so no other item can start.
4. `stage_attempts` persists in D1. Eight attempts of one stage across jobs → BLOCKED `RETRIES_EXHAUSTED`.
5. A resumed item (no `/write` answer in this job) rebuilds its payload from the page read now, and is verified only when that payload's digest equals the `payload_sha256` the Worker staged and wrote (`/lease`). A difference is retried (`VERIFY_STALE`, twice), then BLOCKED `VERIFY_FAILED_PERSISTENT`: the source changed after the write. Its documents are judged as the write stored them, never by the checks it takes again (a timeout, a 429, a link that died or came back since; nothing rewrites `product_documents.active` after WRITING): the write's checkpoint records the ids it stored inactive (`stage_data.documents_inactive`, which `/lease` answers). Against a Worker that records none, the documents the live answer shows are accepted when the payload holds each one.

`tests/bambuImportRunner.test.ts` drives these rules with a fake clock: a 30-minute backoff near the deadline releases and exits, and a `/write` is never started with fewer than 13 minutes left.

### A.8 No secrets or private data in logs or artifacts

**Logs.** The logger (`scripts/bambu-import/log.ts`) is an allow-list formatter. It prints only:

- the Bambu handle, stage, HTTP status, counts, durations and booleans;
- the public live URL of a COMPLETE product;
- error codes and template messages.

It never prints the token, request headers, the D1 database id (masked as in `.github/workflows/pricing-legacy-census.yml:41`), account ids, any protected fingerprint (low-entropy money values are brute-forceable from a hash), any Levonis product name, slug or id that is not public, `source_url` or `canonical_url` values, or conflict details.

Unhandled exceptions print `err.name` plus a scrubbed message: hex runs of 32+ characters, `Bearer` substrings and anything after `://` are redacted.

**Artifacts are sealed.** Every dispatch passes `seal_pubkey`, a one-time X25519 public key (base64url, 43 characters) that the agent generates in its sandbox for that dispatch. `scripts/bambu-import/seal.mjs` (Node `crypto` only: ephemeral X25519, HKDF-SHA-256, AES-256-GCM) seals each file in the same step that produced it, deletes the plaintext, and only `*.sealed` files are uploaded (retention 3 days). The agent unseals locally with `scripts/bambu-import/unseal.mjs` and its private key, which never leaves the sandbox. This covers the live snapshot, the match candidates, the per-item and closing reports, and screenshots.

**Committed files carry no private data.** `existing-matches.json`, `compat-targets.json` and the taxonomy map hold ids, public slugs (only of products active at review time), source handles, a decision and a reason code from a fixed list. They carry no free-text notes, no stock or order facts, and no name or slug of a non-active product.

**Tests.** `tests/catalogImportLogs.test.ts` runs the logger, the job-summary writer and the artifact producers over a recorded run with planted values: a token, a hidden product's name and slug, a draft product's SKU, an inactive catalog's name, a planted `source_url` and a `canonical_url`. It fails if any appears in the log, the summary or any unsealed file. `tests/bambuSeal.test.ts` checks the round trip, a wrong key, a tampered byte and an unsealed upload path.

### A.9 Closing the run

When the queue holds no DISCOVERED, in-flight or RETRYING item and the end-of-run audit (§I.3) is green, workflow 60 `mode=close`:

1. calls `/run/protect-snapshot {phase:'after'}`;
2. calls `/run/finish`, which closes as `closed`, or `partial` when any item is BLOCKED or WITHDRAWN_AT_SOURCE or an end-of-queue hold is still queued (the held items `/run/status` lists are not open work: the close subtracts them, and `/run/finish` names them). The call is not idempotent: when its answer is lost (a 5xx, no answer), `/hello` says whether it committed. A 404 records the end `unconfirmed`, never sends it again, seals the report and passes (the owner reads the state with `mode=report`); a 200 means the run is still open, so it is sent again after the §B.5 wait (its `UPDATE` is guarded on an open run); a `/hello` that never settles leaves the end `unconfirmed` and the close not green;
3. asserts `/hello` now answers 404 with the job's token: a 200 fails the close; a transient answer (429, 5xx, none) is asked again with backoff inside the deadline, and one that never settles is recorded `unconfirmed` without failing the close (the run is already finished, and a second close could not start: its first `/hello` meets the 404);
4. seals and uploads the report.

Nothing is scheduled: no cron, trigger, webhook or Worker binding. `tests/noImportSync.test.ts` asserts that the `wrangler.jsonc` crons are unchanged and that no `scheduled()` branch references `catalog_import`. The ops route stays in the code, inert (404 without an open run), until a later cleanup commit removes it (L-15).

### A.10 Controlled rollback and unpublish on block

| Scope | How |
|---|---|
| A product created by the run that reaches BLOCKED after WRITTEN | Automatic, in the `event BLOCKED` call: a guarded batch (guard row, `UPDATE products SET status = 'hidden' WHERE id = ? AND id IN (SELECT product_id FROM product_source_refs WHERE match_kind = 'created' AND import_run_id = ?)`, an `UNPUBLISHED` event fenced by the lease trigger, guard off), then a purge. `unpublished_on_block = 1`. On resume, `/publish-finish` sets it `active` again (a `REPUBLISHED` event) before verification. |
| A merged existing product that reaches BLOCKED | Never unpublished. Its additions are listed for the owner (`catalog_import_events.detail.added`). |
| Removing one created product | The existing hard-delete path (`worker/lib/productDeletion.ts`, every new child table registered, §B.9), only for a product with no orders, carts or requests. The item moves from COMPLETE to DISCOVERED **at the end of the queue** (`queue_position = max + 1`); the transition trigger allows nothing else (§B.3). A `rolled_back` event is logged. |
| Whole database | Time Travel to the job's bookmark: the last resort, because it also rolls back customer activity. |

---

## B. Product model extensions (migrations 0194 and 0195)

### B.1 What reuses existing structures

| Need | Reused structure | New structure |
|---|---|---|
| Product row, names, descriptions | `products` | none |
| Option groups and values | `product_option_groups`, `product_option_values` | 0194 adds to groups: `name_ar`, `name_ckb`, `kind`, `default_value_id` |
| Real variants | `product_variants` (`combo_key` = sorted `o:<valueId>`) | none |
| Images at 4 levels | `product_images` with its single binding (`option_value_id` / `variant_id` / `color_id`) | none (+ swatches table; `binding_rule` provenance in `product_option_source_refs`) |
| Colour swatch | none fits (`product_colors.hex NOT NULL`) | `product_option_value_swatches` |
| Categories and memberships | `catalogs`, `products.category_id` / `sub_category_id`, `product_catalogs` | none (new nodes are inserted rows) |
| Printer compatibility on the site | `product_printer_fits` (0148) | `product_relations` is the authority with evidence; fits are mirrored |
| Specs readable by the page, compare and facets | `spec_fields`, `specifications` (`SpecGroupV2`) | `product_spec_values` is the authority with provenance; both are mirrored in the same batch; compare reads it directly (§G.5) |
| In the box | template field `in_the_box` (`templateFamilies.ts:273`) | a typed list spec `package.contents` whose items carry `{text, qty, media_key?}` (mirror to the field) |
| Long description, feature sections, FAQ | `content_blocks`, `description_*` | none |
| Manual hub, setup steps | `usage_guide.official_url` / steps | none |
| Documents | none for platform products (`product_files` is community) | `product_documents` |
| External identifiers | `products.sku` is Levonis's own | `product_external_ids` |
| Source identity, variant mapping, stock setup | none | `product_source_refs` (with `stock_decision`), `product_option_source_refs` |
| Translations | `product_translations` + `translation_meta`, local dictionary | none |
| Search | `search_tokens` written by the save path and the cron backfill through `toSearchDoc` | one shared alias loader feeding both writers; `INDEX_STAMP` bump (§B.9); reviewed ar/ckb rows inserted into `search_synonyms` by `/run/prepare-taxonomy` |
| Import run, ledger, checkpoints | `product_imports` is CSV-shaped and not reused | 0195: `catalog_import_*` |

### B.2 Migration `0194_catalog_knowledge.sql` (additive only)

```sql
-- 0194 — the product knowledge model for imported (and later hand-entered) catalogue facts, with provenance.
-- DECISIONS rows 239, 241. Additive only: new tables, four new defaulted columns on product_option_groups,
-- indexes. No UPDATE/DELETE of existing rows, no trigger on an existing table, no CHECK widened.
-- Every reader probes for these tables/columns (CLAUDE.md rule 2).

-- (1) Option group labels in three languages, a semantic kind, and the source's default value.
--     The kind list is complete now so it never needs widening.
ALTER TABLE product_option_groups ADD COLUMN name_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_groups ADD COLUMN name_ckb TEXT NOT NULL DEFAULT '';
ALTER TABLE product_option_groups ADD COLUMN kind TEXT NOT NULL DEFAULT ''
  CHECK (kind IN ('','color','spool','printer','version','size','nozzle','plate','units','pack','item','other'));
ALTER TABLE product_option_groups ADD COLUMN default_value_id TEXT NOT NULL DEFAULT '';   -- '' = none; an unknown id is ignored

-- (2) Where a product came from, and whether its stock has been set up. canonical_url is OWNER-ONLY.
CREATE TABLE IF NOT EXISTS product_source_refs (
  source TEXT NOT NULL CHECK (source IN ('bambu_us')),
  source_product_id TEXT NOT NULL,                 -- string: 18-digit ids exceed 2^53
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_handle TEXT NOT NULL,                     -- decoded, NFC
  canonical_url TEXT NOT NULL,
  source_route TEXT NOT NULL DEFAULT '',           -- currentAllIdRoute
  source_collections_json TEXT NOT NULL DEFAULT '[]',
  match_kind TEXT NOT NULL CHECK (match_kind IN ('created','merged')),
  stock_decision TEXT NOT NULL DEFAULT 'not_required'
    CHECK (stock_decision IN ('not_required','not_configured','tracked','untracked')),   -- §B.10
  stock_decided_by TEXT NOT NULL DEFAULT '',
  stock_decided_at TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,                       -- sha256 of the normalised extraction
  fetched_at TEXT NOT NULL,
  import_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (match_kind = 'created' OR stock_decision = 'not_required'),
  CHECK (stock_decision NOT IN ('tracked','untracked') OR (stock_decided_by <> '' AND stock_decided_at <> '')),
  PRIMARY KEY (source, source_product_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_psr_handle ON product_source_refs(source, source_handle);
CREATE INDEX IF NOT EXISTS ix_psr_product ON product_source_refs(product_id);
CREATE INDEX IF NOT EXISTS ix_psr_stock ON product_source_refs(product_id) WHERE stock_decision = 'not_configured';

-- (3) Source id <-> Levonis id for groups, values, variants and image rows, with the rule that bound each image.
CREATE TABLE IF NOT EXISTS product_option_source_refs (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('group','value','variant','image')),
  source TEXT NOT NULL CHECK (source IN ('bambu_us')),
  source_id TEXT NOT NULL,      -- propertyKeyId | property value id | sku id | resourceFileId
  levonis_id TEXT NOT NULL,     -- product_option_groups.id | product_option_values.id | product_variants.id | product_images.id
  source_label TEXT NOT NULL DEFAULT '',
  binding_rule TEXT NOT NULL DEFAULT '' CHECK (binding_rule IN
    ('','general','value','value_set','variant','representative','content_duplicate','reviewed_override')),
  import_run_id TEXT NOT NULL,
  PRIMARY KEY (product_id, kind, source, source_id, levonis_id)
);
CREATE INDEX IF NOT EXISTS ix_posr_levonis ON product_option_source_refs(levonis_id);

-- (4) Typed specifications with provenance: the authority; spec_fields/specifications are mirrors.
CREATE TABLE IF NOT EXISTS product_spec_values (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL CHECK (length(canonical_key) BETWEEN 1 AND 80),   -- registry key, or 'x.<slug>'
  group_key TEXT NOT NULL,                       -- printing, motion, extrusion, thermal, electrical, connectivity, physical,
                                                 -- logistics, material, mechanical, print_settings, drying, safety, compat,
                                                 -- contents, identity, manufacturer_terms, other
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '' CHECK (region IN ('','us_110v','intl_220v')),  -- §C.6 region rule
  data_type TEXT NOT NULL CHECK (data_type IN ('string','number','boolean','enum','range','list','date','object')),
  original_label TEXT NOT NULL DEFAULT '',
  original_value TEXT NOT NULL DEFAULT '',       -- ≤ 1000
  value_text TEXT NOT NULL DEFAULT '',
  value_num REAL,
  value_num_max REAL,
  value_bool INTEGER CHECK (value_bool IS NULL OR value_bool IN (0,1)),
  value_list TEXT NOT NULL DEFAULT '[]',         -- JSON: strings, or {text, qty, media_key?} (in the box) — a MEDIA source
  unit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('verified','unverified','not_found','not_published','not_applicable','unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('official_variant','official_doc','official_page','component_maker','independent','derived')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('store_page','store_messages','store_doc','tds','sds','manual','wiki','curated','derived')),
  source_ref TEXT NOT NULL DEFAULT '',           -- URL; a store_page ref is owner-only, doc/wiki refs are public
  source_title TEXT NOT NULL DEFAULT '',
  source_locator TEXT NOT NULL DEFAULT '' CHECK (length(source_locator) <= 200),  -- 'p.2', 'Specifications › row 3', a message key path
  source_excerpt TEXT NOT NULL DEFAULT '' CHECK (length(source_excerpt) <= 200),  -- the quoted words the value came from
  retrieved_at TEXT NOT NULL DEFAULT '',
  test_method TEXT NOT NULL DEFAULT '',
  test_condition TEXT NOT NULL DEFAULT '',
  derived_from TEXT NOT NULL DEFAULT '',
  missing_reason TEXT NOT NULL DEFAULT '' CHECK (missing_reason IN
    ('','not_found_in_checked_sources','not_published_by_manufacturer','not_applicable')),
  checked_sources TEXT NOT NULL DEFAULT '[]',    -- JSON [{kind, url, title}] actually parsed for this key
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','owner')),
  conflict TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  import_run_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status <> 'verified' OR source_ref <> ''),
  CHECK (status NOT IN ('not_found','not_published','not_applicable','unknown') OR (value_num IS NULL AND value_text = '')),
  CHECK (status <> 'not_found' OR (missing_reason = 'not_found_in_checked_sources' AND checked_sources <> '[]')),
  CHECK (status <> 'not_published' OR (missing_reason = 'not_published_by_manufacturer' AND source_kind = 'curated')),
  CHECK (status <> 'not_applicable' OR missing_reason = 'not_applicable'),
  CHECK (status <> 'verified' OR value_num IS NULL OR source_kind NOT IN ('tds','sds','manual') OR source_excerpt <> ''),
  CHECK (region <> 'us_110v' OR status <> 'verified')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_psv_key ON product_spec_values(product_id, canonical_key, scope_kind, scope_id, region);
CREATE INDEX IF NOT EXISTS ix_psv_facet ON product_spec_values(canonical_key, value_num) WHERE value_num IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_psv_status ON product_spec_values(product_id, status);

-- (5) Documents: links, never re-hosted bytes (L-3).
CREATE TABLE IF NOT EXISTS product_documents (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('manual','quick_start','installation','tds','sds','certificate','hex_codes','spec_sheet',
                                     'wiki','faq','guide','video','model_file','other')),
  title_en TEXT NOT NULL, title_ar TEXT NOT NULL DEFAULT '', title_ckb TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL CHECK (url LIKE 'https://%'),
  host TEXT NOT NULL,                            -- allow-listed: store.bblcdn.com, cdn.shopify.com (legacy), wiki.bambulab.com,
                                                 -- www.youtube.com, youtube.com, makerworld.com
  tracker_source TEXT NOT NULL DEFAULT '',       -- the e.bambulab.com/t?c=… link it was resolved from (§C.5)
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  version_label TEXT NOT NULL DEFAULT '', published_on TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '', byte_size INTEGER, content_sha256 TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT '', check_status INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL DEFAULT 'store_page', retrieved_at TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  import_run_id TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdoc_url ON product_documents(product_id, url, scope_kind, scope_id);

-- (6) External identifiers, distinct from Levonis ids.
CREATE TABLE IF NOT EXISTS product_external_ids (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  id_type TEXT NOT NULL CHECK (id_type IN ('bambu_product_id','bambu_variant_id','bambu_sku_code','mpn','gtin','upc','ean','color_code','part_code')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 120),
  source_kind TEXT NOT NULL DEFAULT 'store_page', source_ref TEXT NOT NULL DEFAULT '', retrieved_at TEXT NOT NULL DEFAULT '',
  searchable INTEGER NOT NULL DEFAULT 1 CHECK (searchable IN (0,1)),   -- bambu_*_id rows are 0 (opaque numbers)
  PRIMARY KEY (product_id, scope_kind, scope_id, id_type, value)
);
CREATE INDEX IF NOT EXISTS ix_pext_value ON product_external_ids(id_type, value);
CREATE INDEX IF NOT EXISTS ix_pext_search ON product_external_ids(product_id) WHERE searchable = 1;

-- (7) Compatibility and other relations, with evidence. target NULL while pending (no fake FK).
CREATE TABLE IF NOT EXISTS product_relations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL DEFAULT 'product' CHECK (scope_kind IN ('product','option_value','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL CHECK (relation IN ('compatible_with','not_compatible_with','requires','recommended_with','related',
                                             'replacement_for','included_in','includes')),
  target_kind TEXT NOT NULL DEFAULT 'other' CHECK (target_kind IN
    ('printer','ams','hub','buffer','laser_module','toolhead','spool','family','part','material','other')),
  target_product_id TEXT,
  target_source TEXT NOT NULL DEFAULT '',
  target_source_handle TEXT NOT NULL DEFAULT '',
  target_family TEXT NOT NULL DEFAULT '',
  target_label TEXT NOT NULL,                     -- the source's own words
  state TEXT NOT NULL CHECK (state IN ('resolved','pending','unresolvable')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('option_value','compat_section','spec_row','feature_bullet',
                                                       'description_text','wiki_table','manual','curated')),
  evidence_text TEXT NOT NULL DEFAULT '' CHECK (length(evidence_text) <= 300),
  source_ref TEXT NOT NULL DEFAULT '', retrieved_at TEXT NOT NULL DEFAULT '',
  import_run_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT NOT NULL DEFAULT '',
  CHECK (state <> 'resolved' OR target_product_id IS NOT NULL),
  CHECK (state = 'resolved' OR target_product_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_prel ON product_relations(product_id, scope_kind, scope_id, relation, target_source_handle, target_family, target_label);
CREATE INDEX IF NOT EXISTS ix_prel_pending ON product_relations(target_source, target_source_handle) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS ix_prel_target ON product_relations(target_product_id) WHERE target_product_id IS NOT NULL;

-- (8) The official colour swatch of an option value (and a hex ONLY when the manufacturer publishes one).
CREATE TABLE IF NOT EXISTS product_option_value_swatches (
  option_value_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL DEFAULT '', r2_key TEXT NOT NULL DEFAULT '', width INTEGER, height INTEGER,
  published_hex TEXT NOT NULL DEFAULT '' CHECK (published_hex = '' OR published_hex GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'),
  hex_source_ref TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',            -- owner-only provenance
  CHECK (published_hex = '' OR hex_source_ref <> '')
);
CREATE INDEX IF NOT EXISTS ix_povs_product ON product_option_value_swatches(product_id);

-- (The authored ar/ckb search synonyms are NOT in this migration: /run/prepare-taxonomy inserts them with
--  INSERT OR IGNORE from the reviewed data/bambu-import/search-synonyms.json, so their review never waits on a migration.)
```

### B.3 Migration `0195_catalog_import_runs.sql` (operational, additive only)

```sql
CREATE TABLE IF NOT EXISTS catalog_import_runs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cir_[0-9a-f]*' AND length(id) = 28),   -- the shape workflow 60 validates
  source TEXT NOT NULL CHECK (source IN ('bambu_us')),
  state TEXT NOT NULL CHECK (state IN ('open','running','blocked','closed','partial')),
  token_sha256 TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT NOT NULL DEFAULT '',
  github_run_id TEXT NOT NULL DEFAULT '',
  manifest_total INTEGER NOT NULL DEFAULT 0,
  reviewed_bundle_sha256 TEXT NOT NULL DEFAULT '',
  sitemap_fingerprint TEXT NOT NULL DEFAULT '',
  code_commit TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cir_active ON catalog_import_runs(source) WHERE state IN ('open','running','blocked');
CREATE INDEX IF NOT EXISTS ix_cir_token ON catalog_import_runs(token_sha256) WHERE token_sha256 <> '';

CREATE TABLE IF NOT EXISTS catalog_import_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES catalog_import_runs(id),
  source TEXT NOT NULL, source_product_id TEXT NOT NULL, handle TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  product_type TEXT NOT NULL DEFAULT '',
  queue_position INTEGER NOT NULL,                 -- stable order (§J.4); never reused
  curated_scope INTEGER NOT NULL DEFAULT 0 CHECK (curated_scope IN (0,1)),
  hold_code TEXT NOT NULL DEFAULT '' CHECK (hold_code IN ('','OWNER_HIDDEN','ORDER_TYPE_WORD')),   -- known in P0; queued last
  source_collections TEXT NOT NULL DEFAULT '[]',
  breadcrumbs TEXT NOT NULL DEFAULT '',
  discovery_sources TEXT NOT NULL DEFAULT '[]',
  discovered_at TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (processing_state IN
    ('DISCOVERED','EXTRACTING','ENRICHING','VALIDATING','INGESTING_MEDIA','WRITING','PUBLISHING','VERIFYING_LIVE',
     'COMPLETE','RETRYING','BLOCKED','WITHDRAWN_AT_SOURCE')),
  last_completed_stage TEXT NOT NULL DEFAULT '' CHECK (last_completed_stage IN
    ('','EXTRACTING','ENRICHING','VALIDATING','INGESTING_MEDIA','WRITING','PUBLISHING','VERIFYING_LIVE')),
  attempts INTEGER NOT NULL DEFAULT 0,
  stage_attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT NOT NULL DEFAULT '',
  last_error_code TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 300),
  blocker_code TEXT NOT NULL DEFAULT '', resume_instruction TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '',
  source_fingerprint TEXT NOT NULL DEFAULT '', payload_sha256 TEXT NOT NULL DEFAULT '',
  stage_data TEXT NOT NULL DEFAULT '{}',           -- JSON: description kind, plan estimate, counts …
  match_kind TEXT NOT NULL DEFAULT '' CHECK (match_kind IN ('','created','merged')),
  levonis_product_id TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '', live_url TEXT NOT NULL DEFAULT '',
  unpublished_on_block INTEGER NOT NULL DEFAULT 0 CHECK (unpublished_on_block IN (0,1)),
  quality TEXT NOT NULL DEFAULT '{}',              -- JSON counts (§H.3), never values
  d1_checks TEXT NOT NULL DEFAULT '{}',            -- what the Worker itself recomputed at /complete (§I.1.10)
  edge_evidence TEXT NOT NULL DEFAULT '{}',        -- what the runner saw on the public site
  withdrawn_evidence TEXT NOT NULL DEFAULT '{}',   -- two fetches ≥ 24 h apart + sitemap absence
  withdrawn_by TEXT NOT NULL DEFAULT '',           -- the owner approval reference (DECISIONS row or message id)
  source_sold_out_variants INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NOT NULL DEFAULT '', completed_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (processing_state <> 'COMPLETE' OR (levonis_product_id <> '' AND live_url <> '' AND verified_at <> ''
         AND d1_checks <> '{}' AND edge_evidence <> '{}')),
  CHECK (processing_state <> 'BLOCKED' OR (blocker_code <> '' AND resume_instruction <> '')),
  CHECK (processing_state <> 'WITHDRAWN_AT_SOURCE' OR (blocker_code = 'SOURCE_WITHDRAWN' AND withdrawn_evidence <> '{}' AND withdrawn_by <> ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cii_source ON catalog_import_items(run_id, source, source_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cii_position ON catalog_import_items(run_id, queue_position);
-- THE GATE: at most one item of a run between DISCOVERED and a terminal state — BLOCKED and RETRYING included.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cii_inflight ON catalog_import_items(run_id)
  WHERE processing_state NOT IN ('DISCOVERED','COMPLETE','WITHDRAWN_AT_SOURCE');

-- THE LEGAL GRAPH. Nothing (route, wrangler UPDATE, runner bug) can move an item outside it.
CREATE TRIGGER IF NOT EXISTS trg_cii_transition BEFORE UPDATE OF processing_state ON catalog_import_items
WHEN NEW.processing_state IS NOT OLD.processing_state
BEGIN
  SELECT RAISE(ABORT, 'IMPORT_RUN_NOT_OPEN') WHERE NOT EXISTS (
    SELECT 1 FROM catalog_import_runs r WHERE r.id = NEW.run_id AND r.state IN ('open','running','blocked'));
  SELECT RAISE(ABORT, 'IMPORT_ILLEGAL_TRANSITION') WHERE NOT (
       (OLD.processing_state = 'DISCOVERED' AND NEW.processing_state = 'EXTRACTING' AND OLD.last_completed_stage = '')
    OR (OLD.processing_state = 'EXTRACTING'      AND NEW.processing_state = 'ENRICHING')
    OR (OLD.processing_state = 'ENRICHING'       AND NEW.processing_state = 'VALIDATING')
    OR (OLD.processing_state = 'VALIDATING'      AND NEW.processing_state = 'INGESTING_MEDIA')
    OR (OLD.processing_state = 'INGESTING_MEDIA' AND NEW.processing_state = 'WRITING')
    OR (OLD.processing_state = 'WRITING'         AND NEW.processing_state = 'PUBLISHING')
    OR (OLD.processing_state = 'PUBLISHING'      AND NEW.processing_state = 'VERIFYING_LIVE')
    OR (OLD.processing_state = 'VERIFYING_LIVE'  AND NEW.processing_state = 'COMPLETE')
    OR (OLD.processing_state IN ('EXTRACTING','ENRICHING','VALIDATING','INGESTING_MEDIA','WRITING','PUBLISHING','VERIFYING_LIVE')
        AND NEW.processing_state IN ('RETRYING','BLOCKED'))
    OR (OLD.processing_state = 'RETRYING' AND NEW.processing_state = 'BLOCKED')
    OR (OLD.processing_state = 'BLOCKED'  AND NEW.processing_state = 'RETRYING')
    OR (OLD.processing_state IN ('RETRYING','BLOCKED') AND NEW.processing_state = CASE OLD.last_completed_stage
          WHEN '' THEN 'EXTRACTING' WHEN 'EXTRACTING' THEN 'ENRICHING' WHEN 'ENRICHING' THEN 'VALIDATING'
          WHEN 'VALIDATING' THEN 'INGESTING_MEDIA' WHEN 'INGESTING_MEDIA' THEN 'WRITING'
          WHEN 'WRITING' THEN 'PUBLISHING' WHEN 'PUBLISHING' THEN 'VERIFYING_LIVE' END)
    OR (OLD.processing_state = 'BLOCKED' AND OLD.blocker_code = 'SOURCE_WITHDRAWN' AND NEW.processing_state = 'WITHDRAWN_AT_SOURCE')
    -- a rollback (§A.10): only a COMPLETE item whose product was removed, and only to the END of the queue
    OR (OLD.processing_state = 'COMPLETE' AND NEW.processing_state = 'DISCOVERED'
        AND NEW.levonis_product_id = '' AND NEW.last_completed_stage = ''
        AND NEW.queue_position > (SELECT COALESCE(MAX(i.queue_position), 0) FROM catalog_import_items i
                                   WHERE i.run_id = NEW.run_id AND i.id <> NEW.id AND i.processing_state <> 'DISCOVERED'))
  );
END;

-- A stage is completed only by leaving it: last_completed_stage can only become the state the item was in.
CREATE TRIGGER IF NOT EXISTS trg_cii_stage_monotonic BEFORE UPDATE OF last_completed_stage ON catalog_import_items
WHEN NEW.last_completed_stage IS NOT OLD.last_completed_stage
BEGIN
  SELECT RAISE(ABORT, 'IMPORT_ILLEGAL_TRANSITION') WHERE NOT (
       NEW.last_completed_stage = OLD.processing_state
    OR (NEW.last_completed_stage = '' AND OLD.processing_state = 'COMPLETE' AND NEW.processing_state = 'DISCOVERED'));
END;

CREATE TABLE IF NOT EXISTS catalog_import_events (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, item_id TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL, stage TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('start','ok','retry','blocked','info','resume','rolled_back','unpublished','republished','withdrawn')),
  code TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 300), detail TEXT NOT NULL DEFAULT '{}',
  lease_token TEXT NOT NULL DEFAULT '',
  github_run_id TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cie_seq ON catalog_import_events(run_id, seq);
CREATE INDEX IF NOT EXISTS ix_cie_item ON catalog_import_events(item_id, seq);

-- The lease fence (0099:699-720 shape): a checkpoint from a stale executor aborts its whole batch.
CREATE TRIGGER IF NOT EXISTS trg_cie_lease_fence BEFORE INSERT ON catalog_import_events
WHEN NEW.stage IN ('WRITTEN','UNPUBLISHED','REPUBLISHED','COMPLETED')
BEGIN
  SELECT RAISE(ABORT, 'IMPORT_LEASE_LOST') WHERE NOT EXISTS (
    SELECT 1 FROM catalog_import_items i JOIN catalog_import_runs r ON r.id = i.run_id
     WHERE i.id = NEW.item_id AND i.lease_token = NEW.lease_token AND i.lease_token <> ''
       AND i.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND r.state IN ('open','running'));
END;

CREATE TABLE IF NOT EXISTS catalog_import_media (
  run_id TEXT NOT NULL, source_product_id TEXT NOT NULL, source_media_id TEXT NOT NULL,  -- resourceFileId | 'swatch:'||value id | 'desc:'||sha1(url) | 'witb:'||sha1(url)
  role TEXT NOT NULL CHECK (role IN ('gallery','swatch','description','in_the_box')),
  source_url TEXT NOT NULL, fetched_variant TEXT NOT NULL DEFAULT 'original' CHECK (fetched_variant IN ('original','cdn_resized')),
  status TEXT NOT NULL CHECK (status IN ('pending','stored','failed','omitted_cap')),
  r2_key TEXT NOT NULL DEFAULT '', width INTEGER, height INTEGER, bytes INTEGER, sha256 TEXT NOT NULL DEFAULT '',
  source_etag TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, source_product_id, source_media_id)
);

CREATE TABLE IF NOT EXISTS catalog_import_conflicts (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, item_id TEXT NOT NULL, product_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('field_kept_existing','variant_not_merged','spec_sources_disagree','image_unbound','image_review',
    'taxonomy_note','relation_unresolvable','translation_review','region_value','sentence_withheld','curation_disagreement',
    'tracker_unresolved','category_filled')),
  field TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Protected-field fingerprints of EXISTING products and global counters (§E.4). Hashes only; never logged.
CREATE TABLE IF NOT EXISTS catalog_import_protected (
  run_id TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('before','after','write')),
  subject TEXT NOT NULL, digest TEXT NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, phase, subject, at)
);
```

Tried on `node:sqlite` while writing this spec: DISCOVERED → EXTRACTING passes; a second item in flight fails on `ux_cii_inflight`; EXTRACTING → VALIDATING, BLOCKED → DISCOVERED, BLOCKED → COMPLETE, BLOCKED → VERIFYING_LIVE and a jump of `last_completed_stage` all fail with `IMPORT_ILLEGAL_TRANSITION`; BLOCKED → the stage after `last_completed_stage` passes. `tests/catalogImportTransitions.test.ts` makes this exhaustive: every pair of the 12 states, with and without an open run.

### B.4 The DB-level import guard (also in 0195)

New triggers on existing money tables. They are additive (nothing rebuilt, no CHECK widened; the 0191 precedent) and fire **only** while the guard row `ops_guards.id = 'catalog-import-batch'` exists, which is only inside an import batch.

```sql
-- Generated by scripts/gen-import-guard-triggers.mjs from ONE list (worker/lib/catalogImport/protectedTables.ts):
-- for each table T in PROTECTED_TABLES: BEFORE INSERT / UPDATE / DELETE ON T WHEN EXISTS (guard) → RAISE(ABORT,'IMPORT_FINANCIAL_WRITE_REFUSED')
--   product_pricing_state, product_sku_prices, pricing_v2_sku_results, pricing_price_points, pricing_preorder_discounts,
--   pricing_legacy_snapshots, pricing_inputs, pricing_rules, price_history, inventory_lots, inventory_ledger,
--   product_option_fulfillment, product_option_transports, orders, order_items, wallet_transactions, accounting_entries,
--   procurement_selection_cost_defaults, product_price_requests, product_price_request_stats
--   (checked against the live schema by tests/catalogImportGuards.test.ts; a missing table is a failure, not a skip)
-- for products / product_option_values / product_variants: BEFORE UPDATE OF <every money, stock and package column> WHEN guard
--   AND (NEW.x IS NOT OLD.x for any of them) → RAISE; BEFORE INSERT WHEN guard AND (any money column non-default OR stock IS NOT NULL) → RAISE.
CREATE TRIGGER IF NOT EXISTS trg_import_guard_products_ins BEFORE INSERT ON products
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
 AND (NEW.price_iqd <> 0 OR NEW.prime_price_iqd IS NOT NULL OR NEW.pro_price_iqd IS NOT NULL OR NEW.original_price_iqd IS NOT NULL
      OR NEW.product_cost_iqd IS NOT NULL OR COALESCE(NEW.direct_surcharge_iqd,0) <> 0 OR NEW.stock IS NOT NULL
      OR NEW.net_weight_g IS NOT NULL OR NEW.package_weight_g IS NOT NULL OR NEW.package_width_mm IS NOT NULL
      OR NEW.package_depth_mm IS NOT NULL OR NEW.package_height_mm IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
-- The import may record "stock not configured", never a stock decision:
CREATE TRIGGER IF NOT EXISTS trg_import_guard_stock_decision BEFORE INSERT ON product_source_refs
WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch') AND NEW.stock_decision IN ('tracked','untracked')
BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
-- … the same shapes for product_option_values / product_variants inserts, BEFORE UPDATE OF (money, stock, package) on all three,
--   and BEFORE UPDATE OF stock_decision ON product_source_refs.
```

Notes: the exact `products` money and package column list is generated from `FINANCIAL_FIELDS` plus the 0099 dimension columns at implementation time; `product_price_request*` is listed so the import can never create demand; the `products` triggers fire the finance clock (0167:155-157) as any product write does, and §E.4 excludes that counter.

### B.5 Processing state machine

```
DISCOVERED ─lease─► EXTRACTING ─► ENRICHING ─► VALIDATING ─(/stage ok)─► INGESTING_MEDIA ─► WRITING
                                                                                               │ (atomic batch)
                                                               VERIFYING_LIVE ◄─(/publish-finish)─ PUBLISHING
                                                                      │ runner evidence + Worker recompute agree
                                                                      ▼
                                                                   COMPLETE   (next item may start)
any working stage ──transient──► RETRYING ──► the stage after last_completed_stage (or BLOCKED)
any working stage ──permanent / retries exhausted──► BLOCKED ──► RETRYING or the stage after last_completed_stage
BLOCKED (SOURCE_WITHDRAWN, evidence, owner approval) ──► WITHDRAWN_AT_SOURCE (terminal, never COMPLETE)
COMPLETE ──rollback (product removed)──► DISCOVERED at the end of the queue
```

The trigger in §B.3 is the authority; this drawing is its picture.

**Transient failures** retry with backoff 30 s × 2^k, capped at 30 min per wait and by the deadline (§A.7), ≤ 8 attempts per stage across jobs:

- network errors, 5xx, 429 (`Retry-After` honoured);
- D1 `SQLITE_BUSY` or overload;
- media timeouts;
- a cache still stale during verification (for up to `s-maxage` + 60 s);
- `CURATION_PENDING`: a curated-scope item whose curated file is not in the bundled index (1 h, at most twice, then BLOCKED `CURATION_MISSING`). It is parked, never waited out in the job: the file can only arrive with a new commit, so the runner releases the lease (`RETRYING` with `retry_at`) and the job exits `more=true`.

**Permanent failures** go BLOCKED at once:

| Code | Meaning |
|---|---|
| `ACCESS_CHALLENGE` | Bot challenge, 403 or a robots `Disallow` from the store. Never bypassed. |
| `SOURCE_WITHDRAWN` | The page is 404/410, or redirects to a non-product. |
| `IDENTITY_AMBIGUOUS` | The page `seoCode` differs from the manifest and no redirect explains it, or a JSON-LD/SKU cross-check fails. |
| `REVIEWED_SCOPE_REFUSED` | The source, handle, merge target or create is not what the bundled files allow. |
| `REVIEWED_BUNDLE_MISMATCH` | The runner's reviewed files differ from the Worker's. |
| `TAXONOMY_UNMAPPED` | No map entry for the product's route. |
| `PAYLOAD_REFUSED` | The allow-list or the sentence classifier refused the payload. |
| `PLAN_TOO_LARGE` / `ROW_CAP` | Over the invocation limit, or over 400 rows in one collection (§A.6). |
| `PRIMARY_MEDIA_FAILED` / `MEDIA_HOST_NOT_ALLOWED` | The primary image failed after retries, or is on a host outside the allow-list. |
| `PROTECTED_FIELDS_CHANGED` | Protected fingerprints differ. |
| `IMPORT_FINANCIAL_WRITE_REFUSED` | A guard trigger fired. |
| `VERIFY_FAILED_PERSISTENT` | A check failed again after a purge and a wait beyond `s-maxage`, or the runner and the Worker disagree. |
| `CURATION_MISSING` | A curated-scope product reached its turn without its reviewed file. |
| `OWNER_HIDDEN` | A reviewed match targets a product the owner hid and no owner decision exists (L-7). |
| `ORDER_TYPE_WORD` | An option value name that `availabilityFromName` reads as an order type (`packages/pricing/src/availability.ts:144-148`), which `legacyShapeErrors` refuses for a new value. |
| `RETRIES_EXHAUSTED` | Eight attempts of one stage. |

`OWNER_HIDDEN` and `ORDER_TYPE_WORD` are known from P0's scans. Those items carry `hold_code` and are queued **last**, so they cannot hold the rest of the catalogue. At their turn they block with their code unless the owner has decided.

**Optional data is never a blocker.** Specs, documents, secondary images and relations are recorded as `not_found` / `missing` / `failed` and appear in the report (R3).

### B.6 Relations and their targets

**Evidence only.** A relation is created only from:

- an option value naming a target (`Printer Model`, `Compatibility`, the AMS 2 Pro printer question);
- an explicit "Compatibility" / "Compatible with" section, a spec row, or a feature bullet ("All AMS Series Compatible");
- a description sentence the classifier marks as a requirement ("The refill needs to be used with a spool");
- the wiki tables and manual statements (curated, or parsed from a followed wiki page).

Name similarity never creates one. An "A1" part is not related to "A1 mini" unless the source names "A1 mini".

**Labels to targets: `data/bambu-import/compat-targets.json`** (reviewed, committed, bundled). Every compatibility label seen in the P0 crawl maps to exactly one entry:

```jsonc
{ "version": 1,
  "labels": {
    "A1 mini":       { "kind": "printer", "to": { "source_handle": "a1-mini" }, "reviewed_by": "…", "reason": "same_model" },
    "X1 Series":     { "kind": "family", "family": "x1_series",
                       "members": [ { "levonis_product_id": "<existing X1C id>" }, { "levonis_product_id": "<existing X1E id>" } ],
                       "reviewed_by": "…", "reason": "family_members_in_levonis" },
    "AMS 2 Pro":     { "kind": "ams", "to": { "source_handle": "ams-2-pro" }, "reviewed_by": "…", "reason": "same_model" },
    "AMS Series":    { "kind": "family", "family": "ams_series", "members": [ { "source_handle": "ams-2-pro" }, { "source_handle": "ams-lite" }, … ] },
    "Reusable Spool":{ "kind": "spool", "to": { "source_handle": "<the reusable spool handle>" } },
    "Laser Module 10W": { "kind": "laser_module", "to": { "source_handle": "…" } }
  } }
```

- Targets may be a manifest handle, a family, or an **existing Levonis product id** taken from the sealed snapshot. This links X1/P1 spare parts to Levonis's own X1C/P1P/X1E printers, which are discontinued and absent from the sitemap.
- Kinds cover printers, the AMS family, hubs and buffers, laser modules, toolheads and spools.
- `reason` is a code from a fixed list; there is no free text.
- A label not in the file gives `state = 'unresolvable'` with the label kept, plus a `relation_unresolvable` conflict. P0's exit criterion is that every crawled label is either mapped or listed as reviewed-unresolvable.

**Pending and resolution.**

- Target handle in the manifest but not yet COMPLETE: `state = 'pending'`, `target_source_handle` set, `target_product_id` NULL, no fits row.
- When the target's own batch runs, it resolves every pending row targeting its handle. Every family row whose member it is gets a resolved child row.
- An existing Levonis target resolves at once in the subject's batch.
- The knowledge DTO shows a resolved target as a link only while the target is VISIBLE; otherwise it shows the label alone.

**Mirror rule.** `product_printer_fits` holds a resolved `compatible_with` whose target is a printer-template product, at any scope. A part fits a printer if any of its options does; per-option detail stays in `product_relations` and the Compatibility tab. Non-printer targets (AMS, hubs, modules) are never mirrored into fits. `not_compatible_with` is never mirrored.

**Queue order** (§J.4) puts printers and AMS first, so most compatibility resolves at the subject's own write. At the end of the run, rows pending on a handle outside the manifest become `unresolvable`; rows pending on a manifest handle must be zero (§I.3).

### B.7 Logistics, kept separate, with CBM derived

| Group | Keys |
|---|---|
| Product | `product.net_weight` (g), `product.length` / `width` / `height` (mm), `physical.recommended_space` (mm, object) |
| Individual package | `package.weight` (g; only when the source calls it the package weight), `package.length` / `width` / `height` (mm), `package.contents` (list) |
| Shipment | `shipment.gross_weight` (g; "Gross weight" on a printer: everything shipped for that version) |
| Master carton | `carton.pieces`, `carton.length` / `width` / `height` (mm), `carton.weight` (g) |
| Derived | `package.volume_m3` |

**Parsing:**

- Units `mm|cm|m|in`, `g|kg|lb`; separators `*`, `x`, `×`, `X`; `mm³` suffixes stripped; values positive and plausible (edge 1–3,000 mm, weight 1 g–200 kg); L/W/H order kept as published.
- **Composite cells** go through the labelled sub-value parser (§C.6): the A1 and H2D "Physical Dimensions" and "Net Weight" cells give product size, package size, net weight, per-version gross weight and recommended space, each with its key and scope.
- "Gross weight" maps to `shipment.gross_weight`, scoped to the version value when the segment names one. It becomes `package.weight` only when the source says "package weight" or "packaging weight" (spare parts).

**`package.volume_m3`** (CBM) is derived only when all three `package.*` edges come from the same source, scope and region: L×W×H mm ÷ 10⁹, with `derived_from` and `confidence = 'derived'`. It is **not** derived when:

- the version's note says it ships in separate boxes (H2D Laser Full Combo: "Laser module(s) will be shipped in separate boxes");
- the dimensions and the weight have different scopes;
- the edges are `us_110v`-only for a printer (§C.6 region rule).

Each omission writes a `region_value` or `spec_sources_disagree` conflict naming the reason.

**Never written:** `products.net_weight_g`, `package_*_mm`, `package_weight_g`, and the option and variant dimension columns (0099). They are Pricing V2 freight inputs (§1 row 10), and the guard triggers refuse them.

### B.8 Deterministic ids and keys (the stable upsert keys of §13)

`H(x)` is `sha256(x)` as hex, cut to 24 characters.

| Row | Id |
|---|---|
| New product | `p_` + H(`bambu_us:product:` + source_product_id) |
| Option group | `og_` + H(product_id + `:` + propertyKeyId) |
| Option value | `ov_` + H(product_id + `:` + propertyKeyId + `:` + NFC(value text)) |
| Option value `variant_key` | `bv-` + H(`bambu_us:value:` + source property value id) (27 chars, under the 60 limit) |
| Variant | `pv_` + H(product_id + `:sku:` + source variant id) |
| Image row | `pi_` + H(product_id + `:` + resourceFileId + `:` + binding) |
| Spec value | `sv_` + H(product_id + key + scope + region) |
| Document | `pd_` + H(product_id + url + scope) |
| Relation | `pr_` + H(…the unique tuple) |

- Value ids use the text because `propertyValueId` is null on SKUs (source-analysis §3.3); the property list itself carries value ids (`productPropertyValueList[].id`), which feed `variant_key`.
- Image row ids use `binding` = `'p'` | `'v:'+valueId` | `'x:'+variantId` | `'r:'+valueId` (representative).
- Ids are scoped by product; R2 objects are shared only by content hash.
- A test checks that `validateProductDoc` and the relations validators accept every id and key shape, and that `legacyShapeErrors` passes the H2D fixture.

### B.9 Registries the repository requires

| Registry | Change |
|---|---|
| `worker/lib/schemaVersion.ts:46,66` | `EXPECTED_MIGRATION = '0195_catalog_import_runs.sql'`; count = previous + 2, settled at landing after 0192 and 0193. `tests/schemaVersion.test.ts`. |
| `worker/lib/mediaRefs.ts` `MEDIA_REFERENCE_SOURCES` | `product_option_value_swatches.url` and `.r2_key` (text): the swatch object. `product_spec_values.value_list` (json): in-the-box item images (`media_key`). `catalog_import_media.r2_key` (text): keeps staged media alive across a long block; after close, a cleanup commit may move it to `NON_MEDIA_COLUMNS` (L-15). |
| `worker/lib/mediaRefs.ts` `NON_MEDIA_COLUMNS` | Exactly the wide-net catches of the 0194/0195 DDL (`MEDIA_NAME_PATTERN` or a `'[]'`/`'{}'` default, `mediaRefs.ts:906-913`), from the `node:sqlite` scan, each with its reason: `product_source_refs.canonical_url` (an external page address) and `.source_collections_json` (source collection handles); `product_spec_values.canonical_key` and `.group_key` (registry vocabulary), `.checked_sources` (external source addresses); `product_documents.url` (an external document address); `product_relations.evidence_kind` (an enum) and `.evidence_text` (an excerpt); `product_option_value_swatches.source_url` (external provenance); `catalog_import_items.canonical_url`, `.live_url` (page addresses), `.source_collections`, `.discovery_sources` (handle lists), `.discovered_at` (a timestamp; "cover" inside "discovered"), `.payload_sha256` (a hash), `.stage_data`, `.quality`, `.d1_checks`, `.edge_evidence`, `.withdrawn_evidence` (counts and booleans); `catalog_import_events.detail` (counts and ids); `catalog_import_media.source_media_id` (a source id string) and `.source_url` (an external image address). `tests/mediaReferences.test.ts` runs the scanner over every migration on `node:sqlite` and requires `unclassified = []`. |
| `worker/lib/productDeletion.ts` child tables | `product_source_refs`, `product_option_source_refs`, `product_spec_values`, `product_documents`, `product_external_ids`, `product_option_value_swatches`, each by `product_id`. `product_relations` by `{ sql: 'product_id = ?1 OR target_product_id = ?1' }`, following the `product_printer_fits` reasoning. The `catalog_import_*` ledger is exempt with a reason ("the import ledger keeps the history of a deleted product by id"). |
| `packages/contracts/src/ownership.ts` | Every new table in `catalog`. `tests/ownership.test.ts`. |
| Routes | `tests/fixtures/roleMatrix.ts` `BASE_MOUNTS` gains `['/api/ops/catalog-import', catalogImportOpsRoutes]` (every session role gets 404 and no body leak) and `['/api/admin/catalog-import', adminCatalogImportRoutes]`. New `tests/routeClass/catalogImport.ts` classifies every admin route `owner`, and the stock-setup route as admin products-permission (§B.10). The public `GET /api/products/:slug/knowledge` is swept as anonymous. `tests/costRouteClassification.test.ts`, `tests/costRoleMatrix.test.ts`. |
| `FINANCIAL_FIELDS` (`worker/lib/adminScope.ts:243+`, `packages/platform-kit/src/scope.ts:41`, kept identical) | No new key is money. `canonical_url` and `source_ref` join the owner-only provenance projection rule, like `source_url` (V6). The knowledge DTO emits `source_title`, `source_locator`, `source_excerpt` and a public `source_url` only for `wiki` / `tds` / `sds` / `manual` / `store_doc` kinds, and never an `owner`-visibility row. No spec canonical key equals a `FINANCIAL_FIELDS` key (CBM is `package.volume_m3`). |
| Search (`worker/lib/search/store.ts`) | `INDEX_STAMP` `'#doc:4'` → `'#doc:5'`, with a history line ("the document started carrying external-id and model aliases"). The new `worker/lib/search/aliases.ts` `loadSearchAliases(db, productIds)` is used by both writers (§C.1). |
| `tests/listingPredicateGuard.test.ts` | The knowledge route is a customer file using `visible`. |
| `tests/bundleBudget.test.ts` | New lazy chunks (§G) listed as excluded from the product opening; the card key-spec line measured (§G.6). |
| `tests/programmeRefusals.test.ts` | New refusal codes (§C.11) in ar/en/ckb. |
| `scripts/live-cost-probes.d/import.json` | New: `GET /api/ops/catalog-import/run/status` → 404 anonymously, and a knowledge answer carries no `source_ref`, `canonical_url` or `owner` row. |
| `docs/DECISIONS.md` | Row 241 (§K.5). `docs/HANDOFF.md` gets the operational notes. |

### B.10 Stock setup for imported products

`stock = NULL` means untracked and unlimited (`worker/lib/inventory.ts:126`, `:205-210`). An imported product is unsellable today only because it is unpriced; the moment the owner prices it, every variant would become orderable with no limit, for goods Levonis may not hold. So:

- **Recorded.** A created product's `product_source_refs` row has `stock_decision = 'not_configured'`; a merged one keeps `'not_required'` (its stock is the owner's existing setup). The import can never write `tracked` or `untracked` (§B.4 trigger).
- **Enforced where a product becomes sellable.** Only a Pricing V2 publish makes a product SELLABLE. `v2WriteStatements` (`worker/lib/pricingEngine/v2/write.ts:135`) prepends a fence (`worker/lib/operations.ts:111`):
  `NOT EXISTS (SELECT 1 FROM product_source_refs WHERE product_id = ? AND stock_decision = 'not_configured')`.
  A miss answers 409 `IMPORT_STOCK_NOT_CONFIGURED`. The fence is added only when a presence probe finds 0194, so a Worker on an older database is unchanged.
- **The owner's choice.** `PUT /api/admin/products/:id/import-stock-decision` `{ decision: 'tracked' | 'untracked' }`, behind the same permission as editing stock in the product form, writes `stock_decision`, `stock_decided_by` and `stock_decided_at`, with an audit row:
  - `tracked` requires a non-null stock at the level `inventory_mode` makes authoritative, else 400 `IMPORT_STOCK_TRACKED_EMPTY`;
  - `untracked` is an explicit "to order, no limit" choice.
- **The product form** shows the card «إعداد المخزون للمنتج المستورد» / "Stock setup for an imported product" / «ڕێکخستنی کۆگا بۆ بەرهەمی هاوردەکراو» with «تتبّع الكمية» / "Track quantity" / «بەدواداچوونی بڕ» and «بلا تتبّع (حسب الطلب)» / "Untracked (to order)" / «بێ بەدواداچوون (بەپێی داواکاری)». The V2 pricing panel shows the refusal text instead of the publish button while the decision is missing.
- **Tests** (`tests/importStockDecision.test.ts`): pricing an imported product through the V2 write is refused until the decision; after `untracked` it publishes and is orderable; after `tracked` with stock 3 it sells 3 and refuses the 4th; a merged product is never gated; a database without 0194 behaves as today.

This is a precondition on the V2 publish of import-created products only. The V2 maths, rules and screens are unchanged. It is recorded in row 241 and is owner decision L-16 (default: on).

---

## C. Bambu → Levonis data mapping

Pure TypeScript in `packages/catalog/src/bambuImport/`, with no Node or Worker APIs, shared by the runner and the Worker:

- `rsc.ts`: flight decoder (port of `bambu_tools/rsc.py`, `resolve.py`);
- `extract.ts`: locates `P` by shape, plus the description element, through a recording accessor that refuses any path outside the closed read list (§C.10);
- `crossSell.ts`: the one reader of the cross-sell payload (§C.1);
- `normalize.ts`, `options.ts`, `media.ts` (binding), `describe.ts` (the 4 formats), `sentences.ts` (the classifier), `specs.ts` (tables, composite cells, region rule), `logistics.ts`, `relations.ts`;
- `payload.ts`: the allow-list types and validator;
- `fingerprint.ts`: over the two public answers (§I.1);
- `registry/`: spec keys, group labels, units, value dictionary, colour vocabulary.

### C.1 Identity

| Field | Source |
|---|---|
| `source_product_id` | `P.id` (string) |
| `handle` | `decodeURIComponent(P.seoCode)`, then NFC |
| `canonical_url` | `P.seoUrlHandle`, never `<link rel=canonical>` (it echoes the request case) |
| `title_en` | `P.name`, whitespace normalised |
| Names | `name`, `name_ar`, `name_ku` = `title_en` (§1 row 15) |
| Short description | `P.seoMetaDescription`, through the sentence classifier (§C.10) |

**Cross-check:** the JSON-LD `productGroupID` must equal `P.id`, and every `hasVariant[].sku` must be a `productSkuList` id. A disagreement → BLOCKED `IDENTITY_AMBIGUOUS`.

**Model, series and family** come from the reviewed `data/bambu-import/identity-map.json`: `handle → { model, series, family }`, built in P0 from the route L2/L3 ids and the registry's model tokens matched in titles. They are written as spec rows `identity.model`, `identity.series`, `identity.family` (group `identity`, `status verified`, `source_kind store_page`, the route as `source_locator`) and mirrored to the new template field `product_family` (§G.5).

**SKU codes.** `crossSell.ts` reads only `relationProducts.randomBuyRangeGroupList[].{spuList,skuList}[].productSku.{id, seoCode, skuCode}`. `tests/bambuCrossSell.test.ts` proves through the recording accessor that no other key (prices, `availableStock`, discounts) is read. Harvesting runs in **P0 across all pages**, because a product's code appears on other products' pages. A code is kept only when `seoCode` equals the product's handle and `productSku.id` is one of its variant ids. Codes are frozen in the manifest (`sku_codes: { "<variant id>": "<code>" }`); the run uses the manifest's codes only.

**Search aliases**, through one shared loader:

- `worker/lib/search/aliases.ts` exports `loadSearchAliases(db, productIds): Map<productId, string[]>`. It reads `product_external_ids` where `searchable = 1` (colour codes, part codes, `bambu_sku_code`) and `product_spec_values` rows `identity.model` / `identity.series`, in one statement per ≤ 90 ids. Without 0194 it returns an empty map.
- `toSearchDoc` gains `aliases?: string[]`, indexed in the `model` field with the variant names.
- **Both writers call the loader:** `planProductSave` (`worker/lib/productPersistence.ts:3195-3210`), so the first owner edit of an imported product keeps the tokens, and `searchDocsForRows` / `backfillSearchIndex` (`worker/lib/search/store.ts:602-640`), so a backfilled product keeps them too. Within an import batch the planner reads the aliases the same batch is about to write, so the writer passes them explicitly as `intent.searchAliases`; the loader result is the default.
- `INDEX_STAMP` becomes `'#doc:5'` in the same commit. The cron backfill then re-indexes the whole catalogue at 50 products per tick: about 45 products today, and the alias read adds one statement per tick. `tests/fxSweepBudget.test.ts` is extended so the quarter-hour tick stays under `QUARTER_HOUR_TICK_LIMIT` with the alias read included.
- `tests/searchAliases.test.ts`: an imported fixture product saved by the admin form, and the same product rebuilt by the backfill, both keep the colour code, part code and model tokens.

**Slug:** `uniqueProductSlug(productSlugFrom(handle))` (§A.4), stored on the item.

### C.2 Option groups and values

**Source:** `P.productPropertyList[]`, sorted by `position`. Groups go in by `position`, values by array order.

**Default value.** The value with `selectedDefault = 1` becomes `product_option_groups.default_value_id` (the first one if several are flagged; `''` if none). The page preselects it when the server gives no `initial_selection` (§G.3).

**Group label → canonical group** (`registry/groups.ts`), by exact or regex match on `propertyKey` and the shape of the values:

| Canonical | `kind` | Matches | ar / en / ckb |
|---|---|---|---|
| `color` | `color` | `Color`, `Colour`, any group whose values carry `colorUrl` | «اللون» / Colour / «ڕەنگ» |
| `spool` | `spool` | `Type` with values ⊆ {Refill, Spool, With Spool, Filament with spool, …} | «البكرة» / Spool / «ماسوورە» |
| `net_weight` | `pack` | `Size` whose every value is a weight (`1kg`, `0.5kg`, `250g`) | «الوزن الصافي» / Net weight / «کێشی پوخت» |
| `printer` | `printer` | `Printer Model`, `Compatibility` (printer-label values), `/^Select the type of printer/` | «الطابعة» / Printer / «چاپکەر» |
| `version` | `version` | `type: 4` or `Variant` with printer configurations | «الإصدار» / Version / «وەشان» |
| `units` | `units` | `/How many .* unit/` | «عدد الوحدات» / Units / «ژمارەی یەکە» |
| `nozzle` | `nozzle` | `Size` with nozzle values (`0.4mm Hardened Steel`) | «النوزل» / Nozzle / «نۆزڵ» |
| `size` | `size` | `Size` with plate or part sizes | «المقاس» / Size / «قەبارە» |
| `plate_type`, `item`, `combo_type`, `option`, `pack` | `plate`, `item`, `other` | … | (registry) |

Notes:

- An unmatched group keeps `name_en = propertyKey` (≤ 80 chars, shortened only by registry rules), `name_ar = name_ckb = ''`, `kind 'other'`, and a `translation_review` conflict. The page falls back to English.
- The original wording is always kept in `product_option_source_refs.source_label`.
- Group-name case variants (`item` / `Item`) are normalised.

**Values:**

- `name_en` = the source text, trimmed. Codes such as `(10101)` and `ZH133` are kept. `name_ar` / `name_ckb` come from the generic-word dictionary only (`Refill` → «عبوة بدون بكرة» / «پڕکردنەوە بەبێ ماسوورە», `With Spool` → «مع بكرة» / «لەگەڵ ماسوورە», `Standard` → «قياسي» / «ستاندارد»), otherwise `''`.
- **`variant_key = 'bv-' + H(source value id)`, `variant_label` = the source text** (§B.8). Case-only duplicates within a group (`Standard` / `standard` on H2D, ids `581025672340709381` and `…384`) stay distinct, never merged by guess, and now pass `legacyShapeErrors`.
- **Order-type words.** P0 runs every manifest value through `availabilityFromName` (`/pre[\s-]?order|direct(\s*sale)?/i`, `packages/pricing/src/availability.ts:144-148`). Any hit is listed for the owner and the product gets `hold_code ORDER_TYPE_WORD` (§B.5). None was found in the 8 fixtures.
- Typos (`Texture PEl`) stay as the source wrote them and go to the review list.
- `sku_part = ''`, `image = ''` (images are rows). Prices empty, stock null, `availability_type` = the form default, no lead time.
- **Weight-valued Size values** (PLA Basic's single `1kg`) also become `material.net_weight` rows scoped to that value (`confidence official_variant`, `status verified`). A one-value group is still kept, for fidelity and variant mapping.

**Colour codes** `(\d{5})` in a `color` value become `product_external_ids(scope option_value, id_type 'color_code')`.

**Single-value groups** (`Compatibility: X1 Series`, `Item: …`) are kept. The page auto-selects them (§G.3), and a printer meaning also produces relation evidence (§B.6).

### C.3 Only real variants

- One `product_variants` row per `P.productSkuList[]` entry.
- `combo_key` = sorted `o:<valueId>`, each SKU property joined to its group by `propertyKeyId` and to its value by NFC text. A SKU naming a value absent from the group list → BLOCKED `IDENTITY_AMBIGUOUS`.
- `inventory_mode = 'VARIANT_COMBINATION'` whenever there is a group. Missing combinations (PLA Basic 43/60, H2D 6/18, AMS 2 Pro 15/42) are never created; dependent options are expressed only by the variant list.
- `product_option_source_refs(kind 'variant')`: the source sku id ↔ `pv_` id. `product_external_ids(scope variant, bambu_variant_id, searchable 0)`.
- Variant notes (`.description`) go through the sentence classifier (§C.10). What remains is a variant-scoped spec `variant.note` (`string`, `unverified`). A "shipped in separate boxes" note also sets the multi-box flag that stops CBM (§B.7).
- `isSoldOut`, `outOfStockMsg`, `eta`, `requiresNotify` and `saleTime` are counted into `source_sold_out_variants` for the audit and **never written to the product**.

### C.4 Media at four levels, one binding per row, binary reuse

**Inputs:** the gallery `P.mediaFiles[]` in order; the variant hero `sku.mediaFile.resourceFileId` (always in the gallery); swatches `value.colorUrl`; description and in-the-box images (§C.5).

**The rule the brief sets (§5, R6):** for an explicit selection, show that selection's images and the general ones, and never an image bound to another value of a chosen group. Every image the source ties to a variant is bound, the primary included.

**Binding algorithm** (`media.ts`, pure). The runner computes it for `/stage`. The Worker recomputes it at `/write` from the payload and its own `catalog_import_media` rows, so the content-duplicate step uses server-side hashes and the payload does not change after media.

1. **Content duplicates.** Gallery entries whose ingested WebP has the same R2 key collapse into the earliest position. If any copy is source-bound, the collapsed row takes that binding (`binding_rule 'content_duplicate'`). A gallery image with the **same file name but a different hash** from a bound one is not bound: it goes to the review list (`image_review`). Examples: A1 #3/#4 copy A1/A1_C; H2D #5/#6/#7 copy H2D/H2DC/H2DL.
2. For every remaining gallery image `g` (**index 0 included**), let `V(g)` be the variants whose hero is `g`.
   - `V(g)` empty → **general** (unbound), unless `media-overrides.json` binds it (`reviewed_override`, with reviewer and reason). The H2D bundle-content shots `AMS_2_Pro.jpg` and `AMS_HT.jpg` are on the P0 review list as candidates for the two bundle variants. Without a reviewed override they stay general.
   - `|V(g)| = 1` → **variant level**: one row bound to that variant. It ranks first when the full selection resolves to that variant (H2DC → `H2D AMS Combo + Standard`).
   - `V(g)` equals the variant set of **one value X** of some group → one row bound to X (`value`). If several groups each have such a value, prefer `kind 'color'`, then the earlier group by `position`. Example: H2DL → `H2D Laser Full Combo`, not `{10W, 40W}`.
   - `V(g)` equals the union over a set S of values of one group → one row per value in S, all with the same R2 key (`value_set`). Example: the PEI plate FAP033 → X2D, P2S, A1, P1 Series, X1 Series; FAP035 → A2L, H2C; FAP025 → H2S, H2D.
   - Otherwise → one row per variant in `V(g)` (`variant`).
3. **Representative image per value.** For every value X of a group with ≥ 2 values that received no row of its own, take the variant reached by X plus the `selectedDefault` of the other groups (else the first variant containing X, in SKU order). If that variant has a hero image, add a row binding that image to X (`representative`). Example: selecting `H2D AMS Combo` alone leads with H2DC, the image the store itself shows for that choice. With the full selection `H2D AMS Combo + Dual AMS 2 Pro Bundle`, the variant-bound H2DUSMS2PRo still ranks first (variant rank 0 < value rank 200).
4. **Primary.** `is_primary = 1` goes on the first row of gallery index 0, whatever its binding; a bound primary is supported (the planner only requires one primary, `productPersistence.ts:984-991`). With no selection the primary leads. With a selection that contradicts its binding, the client leaves it out (§G.3).
5. **Swatches** are not gallery rows (below).

**Golden tests** (`tests/bambuMediaBinding.test.ts`, all 8 fixtures):

- A1: `Standard` leads with A1, `Combo` with A1_C; no A1_C image while `Standard` is selected.
- H2D: `H2D + standard` → H2D; `H2D AMS Combo` alone → H2DC; `Laser Full Combo` → H2DL; no H2DL or H2DC image while `H2D` is selected.
- PEI plate: H2C → FAP035; H2D → FAP025; P2S → FAP033.
- PLA Basic: each colour → its colour image; Black Refill and Black Spool share one (`shares_image_with_siblings`).
- AMS 2 Pro: the 13 variants on gallery #0 → 13 variant rows of one key; the other 2 → their own.

**Report:** every variant whose hero image is shared with siblings that differ in another group is listed as `shares_image_with_siblings`; every representative and content-duplicate binding is listed with its rule.

**Swatches:**

- `colorUrl` is ingested with role `swatch`: bytes sniffed (the `.media` extension is served as `multipart/form-data`), converted and stored in `product_option_value_swatches`, never `product_images`, so a 128×128 swatch can never become a gallery or card image.
- `published_hex` only from curated data with `hex_source_ref`.

**Alt text** (the source has none):

| Language | Alt |
|---|---|
| en | `<title>` or `<title> — <selection label>` |
| ar | `صورة <title>` (+ ` — <selection label>`) |
| ckb | `وێنەی <title>` (+ ` — <selection label>`) |

**Image size and original policy** (`worker/lib/imageConvert.ts:64-105`):

1. Fetch the original (`P.mediaFiles[].url` exactly, with no `__op__` suffix) with `guardedFetchBytes({ maxBytes: IMAGE_SOURCE_CAP (8 MB), allowHost: h => h === 'store.bblcdn.com', timeoutMs: 20_000 })`. `ingestProductMediaUrl` gains a pass-through `allowHost` option; `fetchGuard.ts:213-215` already supports it.
2. On `SOURCE_TOO_LARGE`, or an IMAGES failure caused by input size, retry once through the CDN resizer `<url>__op__resize,m_lfit,w_2400__op__format,f_auto__op__quality,q_90` (`Accept: image/jpeg,image/png`) and record `fetched_variant = 'cdn_resized'`. The stored result is capped at 2048² anyway.
3. Convert to WebP through IMAGES. The key is `products/import/gallery/<sha256>.webp` (`productMediaIngest.ts:668-676`), so identical WebP bytes share one object.
4. `cleanup_grace_minutes = 10080` (7 days) for staged objects, together with the `catalog_import_media.r2_key` reference source.
5. A host outside the allow-list: the primary → BLOCKED `MEDIA_HOST_NOT_ALLOWED`; otherwise `failed` media with the reason, and the product continues.

**Rights:** row 239 covers Bambu's official images. The only image host fetched is `store.bblcdn.com`; `store-test.bblcdn.com` is ignored.

### C.5 Descriptions: four source formats into Levonis content, with provenance

`describe.ts` detects the format in the order A → B → C → D (source-analysis §4) and produces one neutral tree:

```
{ sections: [{ kind: 'overview'|'features'|'specs'|'in_the_box'|'compat'|'instructions'|'faq'|'warning'|'comparison'|'other',
               title_en, path, blocks: [ {t:'text', text} | {t:'image', url, alt?} | {t:'table', rows: string[][], header?: string[]} |
                                          {t:'list', items: string[]} | {t:'link', url, text} | {t:'video', url} |
                                          {t:'box_item', text, qty?, image?} ] }] }
```

| Format | Source | Sectioning |
|---|---|---|
| A, `legacy_html` | the `pct_*` template | split at `<h3>`; titles map to section kinds by registry |
| B, `sections_html` | named sections | one HTML string each |
| C, `page_builder` | the component tree | content blocks → text/image; `Download` → documents; `content-block-21-pro` → FAQ |
| D1 | `shopify-section … product_description_<kind>` | `special` → specs, `what_is_in_the_box` → in the box (image + item name pairs; "Combo Add-ons" → that value's scope), `faq`, `pic_and_text`, `grip` |
| D2 | client-component props plus `messages.*` i18n | `collapseTable` / `notCollapseTable` HTML, `messages.AMSPro.SpecificationTable` |

**Cleaning, on every format:**

- drop `<style>`, comments, `paste-helper` buttons and the placeholder alt `图片加载失败文案`;
- turn relative store links into a handle, then into a Levonis slug if imported (else plain text);
- **tracker links** (`https://e.bambulab.com/t?c=…`) are resolved during ENRICH by one `HEAD` with `redirect: 'manual'`, reading `Location`. The target is kept only when its host is allow-listed (`wiki.bambulab.com`, `store.bblcdn.com`, `www.youtube.com`, `youtube.com`, `makerworld.com`). It becomes a document with `tracker_source` = the tracker URL. A challenge, an error or another host gives `tracker_unresolved` and no document; it is never bypassed. Example: the AMS 2 Pro feeder unit's "Installation … on Bambu Lab Wiki" becomes a `kind 'installation'` wiki document;
- strip Shopify `?id=…&_pos…` and every query from kept links;
- `.zip` / `.3mf` downloads become documents of kind `model_file`; `makerworld.com` links kind `other`;
- every sentence goes through the classifier (§C.10).

**Into Levonis:**

| Neutral section | Levonis target |
|---|---|
| overview / features / pic_and_text / warning / comparison text | `content_blocks` text blocks (`body_en`; ar/ckb from the local translator only, `review_needed`), in order |
| images in those sections | `content_blocks` image blocks (`media_key`), capped at 40 per product (§1 row 14) |
| `P.productFeaturesModuleList` bullets | **parsed first:** `Label: value` bullets go through the spec registry (`status unverified` unless the label and scope are unambiguous; `Diameter: 1.75mm +/- 0.03mm` → `material.diameter` 1.75 mm and `material.diameter_tolerance` ±0.03 mm, verified); compatibility bullets ("All AMS Series Compatible") → relation evidence (`feature_bullet`, §B.6); requirement notes ("The refill needs to be used with a spool") → a `requires` relation through `compat-targets.json`. Whatever is left becomes one text block "Highlights", without any voltage bullet (§C.6 region rule). |
| `P.externalVideoLinkList` (YouTube) | `content_blocks` `video_embed`, YouTube only, plus a `product_documents(kind 'video')` row |
| `.mp4` on the CDN | `product_documents(kind 'video')`, a link |
| specs tables | `product_spec_values` (§C.6), never content text |
| comparison / matrix tables (rowspan, glue × plate) | a text block rendering the table as rows, kept as a table in `stage_data` for curation |
| in the box | `package.contents` list spec whose items are `{text, qty, media_key}`. Item images are ingested with role `in_the_box` (outside the 40-image cap, at most 30 per product) and shown in the In the box tab (§G.2). A1: 7 items plus the "A1 Combo Add-ons" scoped to the combo value. AMS 2 Pro: names from the image alt text. Mirrored to `spec_fields.in_the_box` as text. |
| compatibility section | relation evidence (§B.6), plus a `compat.statement` string spec holding the published sentence |
| FAQ | a text block "FAQ" (Q/A pairs), `review_needed` |
| instructions | `usage_guide.steps` (kind `usage`, English, `link_url` official) |
| wiki links | `product_documents(kind 'wiki')`; the first wiki hub link → `usage_guide.official_url` |

**Provenance:** each content block's source section is recorded in `stage_data.description = {kind, sections:[{kind, title, path, block_count}]}`. The product-level `translation_meta` marks each imported field `imported` (`productModel.ts:167`).

### C.6 Specification parsing per product type

**Registry** (`packages/catalog/src/bambuImport/registry/specKeys.ts`):

```ts
{ key: 'printing.build_volume', group: 'printing', type: 'object' /* {x,y,z} mm */, unit: 'mm',
  labels: { en: 'Build volume', ar: 'حجم الطباعة', ckb: 'قەبارەی چاپ' },
  synonyms: ['Build Volume', 'Print Volume', 'Printing volume', 'Build volume (W×D×H)'],
  appliesTo: ['printer'], templateField: 'build_volume', facet: true, compare: true, expected: true,
  cardKey: true, regionDependent: false }
```

It covers at least every field in the brief's §4ب, §4ج and §4د:

- **Printers:** printing, motion, extrusion, thermal, connectivity, electrical, physical, safety.
- **Filament:** material (diameter, tolerance, net weight, density), mechanical (with `test_method`), thermal, print_settings, drying, safety.
- **Parts:** compat, mechanical, electrical, contents.
- **All:** identity (model, series, family), manufacturer_terms (owner-only warranty notes, §C.10).

Synonyms unify meaning (Build Volume = Print Volume) while `original_label` keeps the words.

**Deterministic table parse (the bulk):**

- 4-cell rows (`Voltage | 24V | Electricity | Below 10mA`) give two pairs; 2-cell rows one. `rowspan` cells are expanded only for key/value tables. A table whose header names option values gives one spec per column scope.
- **Composite cells go through the labelled sub-value parser** (`specs.ts compositeCell`):
  - split on `<br>`, `;`, a comma followed by a sub-label, and parenthesised groups;
  - recognise sub-labels from the registry ("Package size", "Net weight", "Gross weight", "Recommended Space", "Product size", "Dimensions");
  - scope a segment to an option value when its prefix (`A1 Combo :`, `H2D AMS Combo:`, or the value text without the product's `identity.model` token, so `AMS Combo:` on H2D) equals a value of the version group;
  - a trailing unit applies to every number in the segment list ("H2D: 40.6; AMS Combo: 44.2; Laser Full Combo: 48.2 kg").

  On the fixtures:
  - A1 "Physical Dimensions" → `product.length/width/height` 465×410×430 mm, `package.*` 596×536×325 mm (scope A1), `product.net_weight` 8.3 kg, `shipment.gross_weight` 13 kg (A1) and 13.5 kg (A1 Combo), and the Combo's package 560×540×430 mm.
  - H2D "Physical Dimensions" → product 492×514×626 mm, package 580×605×750 mm (region `us_110v`), `physical.recommended_space` 700×700×1100 mm.
  - H2D "Net Weight" → `product.net_weight` 31 kg, `shipment.gross_weight` 40.6 / 44.2 / 48.2 kg per version (`us_110v`).
- **Label → key:** registry synonym, case- and punctuation-insensitive. An unknown label gives `x.<slug>` (`string`, `unverified`, shown under "Other" with its English label).
- **Value → typed:** numbers with units (`°C`, `℃`, `mm/s²`, `≤`, `±`); ranges (`190–240 °C`); `x*y*z`; booleans (`Yes`/`No`, `Supported`/`Not supported`); lists (only for `list` keys).
- **Unparseable values** keep `original_value` and `value_text`, `status 'unverified'`.
- **`verified`** requires an official source and an unambiguous parse. A value from prose stays `unverified`.
- **Provenance per value:** `source_locator` is the section and row path (`Product Specifications › row 3`, `collapseTable › Physical Dimensions › segment 2`, `messages.AMSPro.SpecificationTable.netWeightValue`); `source_excerpt` is the cell text (≤ 200 chars).

**Region rule.** Registry keys flagged `regionDependent` are every `electrical.*` key and, for printers, `package.*`, `shipment.gross_weight` and `product.gross_weight`.

- A US store table is recognised by `100-120` / `@110 V` / `110V` text. Its region-dependent values get `region = 'us_110v'`, `status 'unverified'` (enforced by a CHECK) and `test_condition` "US version (100–120 V)".
- For curated printers (§F), the curated file takes the 220 V / "UK and other version" values that the same official page carries in its messages bundle ("Specs Table No Collapse 220V", "Gross Weight UK", "Physical Dimensions Asia" … "UK and other Version: 620*620*755mm"), with `source_kind 'store_messages'`, `region 'intl_220v'`, `confidence 'official_page'` and the message key path as `source_locator`.
- The page shows `intl_220v` and region-free rows. `us_110v` rows sit only under "Other versions" with the label «النسخة الأمريكية (100–120 فولت)» / "US version (100–120 V)" / «وەشانی ئەمریکی (100–120 ڤۆڵت)».
- No CBM is derived from a US-only box (§B.7).
- Highlights bullets carrying a voltage ("Voltage Range: 100-120 V") are dropped from the Highlights block and kept as `us_110v` evidence.
- The table note "Please purchase the version corresponding to your region's voltage" is recorded as region evidence and not shown.
- Golden test on `h2d`: no `verified` row says 100–120 V; the curated fixture gives the 220 V values; no `package.volume_m3` exists from the US box.

**Statuses for absent values** (never 0 or false):

- **`not_found`** (`missing_reason 'not_found_in_checked_sources'`, `checked_sources` = the sources actually parsed for that key): written for every `expected` key of the product's type that no checked source supplied. Customers see «غير متوفر في المصادر التي رُوجعت» / "Not in the sources checked" / «لەو سەرچاوانەی پشکنران نییە».
- **`not_published`** (`not_published_by_manufacturer`, `source_kind 'curated'` enforced by a CHECK): only for curated products whose official documents were actually searched for that key. Customers see «لم تنشره الشركة المصنّعة».
- **`not_applicable`** only from registry rules (for example `thermal.chamber_temp` for an open-frame printer whose source says "Not supported").

**Per type:**

| Type | Source | Notes |
|---|---|---|
| Printers (A, D1, D2 tables) | ~18–19 rows, composite cells, plus curated (§F) | Variant differences scoped to the version value by the composite parser; region rule applies. A1 "Download TDS" has no URL, so none is invented. |
| Filament | No spec table on the page (format C) | Curated TDS extraction (§F) for material, mechanical, thermal, print settings and drying. The deterministic layer records documents, `material.net_weight` from the weight-valued Size group, `material.diameter` and tolerance from the feature bullets, the spool type, and AMS compatibility as a relation. |
| Hotends, plates | The A table | Matrix tables stay text plus curated relations. Nozzle diameter and material from the `Size` value text (`0.4mm Hardened Steel` → `nozzle.diameter` 0.4 mm, `nozzle.material` "Hardened Steel", value scope, `official_variant`). |
| Spare parts | 4–6 rows | `package.*` (here "Packaging Weight/Size" is the package), `part.material`; compatibility from the option value. |
| Maker's Supply | A/B "Basic Information" | Electronics keys (voltage, current, power, connector, battery, with a transport warning when a battery is listed). Kit counts from "In the box". |

**Mirrors written in the same batch:**

- `spec_fields[templateField]`: formatted English text. A `select` field gets a value only when it equals a declared option (`docs/IMPORT_TEMPLATE.md:139`). Only fields allowed for the product's branch are written. Facet mirrors: `product_family`, `spool_type`, and `color_name` as base colours joined by ` | ` (§G.5).
- `specifications`: `SpecGroupV2` groups ordered by registry group, ar/en/ckb labels from the registry, values language-neutral. Rows other than `verified` / `unverified`, and every `us_110v` and `owner` row, are omitted from the legacy mirror; the new tab renders them.

**Conflicts:** two sources giving different values for one key, scope and region keep the higher-ranked one (official_variant > official_doc > official_page > component_maker > independent), set `conflict`, and write a `spec_sources_disagree` conflict row. No number is picked at random (§6).

### C.7 Documents

- **Collected from:** Download blocks, `link`/`dtsLink` props, `<a href>` to PDF/ZIP, wiki links, resolved tracker links and video links.
- **Kind** from registry rules on link text and filename: TDS, SDS, RoHS / EN71-3 / TSCA / CP65 / PAHS / POPs / SVHC → `certificate`, Hex Code → `hex_codes`, Spec → `spec_sheet`, Manual / Quick Start / Installation → `manual` / `quick_start` / `installation`.
- **Scope:** product, or option value when the link sits in a variant description.
- **Check during ENRICH:** HEAD, falling back to a ranged GET of 0–1023 bytes, ≥ 1 s apart. `check_status`, `content_type`, size and the first-KB SHA are recorded. A dead link is kept with `active = 0`, listed in the report, and never shown to customers.
- **Wiki follow:** at most 3 `wiki.bambulab.com` links per product that the store page itself gives, ≥ 5 s apart. Their tables are parsed by the same deterministic parser (`source_kind 'wiki'`, `status unverified` unless label and scope are unambiguous), and each successfully parsed page joins `checked_sources` for the keys it was searched for.
- **Titles:** en = the link text or the registry default; ar / ckb = the registry title by kind (§G.4), with the English source title after a dash.

### C.8 Translations (row 2)

- `translationInputsOf(doc)` plus the local translator (`worker/lib/translate/index.ts translateField`) run **in the Worker** during `/write`. The runner never supplies ar/ckb prose.
- Every imported prose slot is written with `status = 'review_needed'`, whatever the dictionary covered.
- Identity terms (PLA, PETG-CF, AMS, model names, part codes, units) are never translated (`dictionary.ts IDENTITY_TERMS`).
- ckb is never filled from Arabic. `tests/catalogImportTranslations.test.ts` asserts that no ckb slot equals its ar slot when either contains Arabic script.
- **Authored dictionaries** (group labels, spec labels, generic value words, document kinds, category names, colour names, synonyms) are repository strings, reviewed like every UI string (rows 2 and 183). They are not machine translation of imported prose.

### C.9 Sold-out, stock, sale

- **Sold-out at Bambu** is recorded in the item ledger only, and never affects visibility, labels, stock or ordering.
- **Stock** stays NULL. The importer never sends `stock`, `low_stock_threshold`, reservations, lead times, availability types beyond the form default, cells or routes. It records `stock_decision = 'not_configured'` (§B.10).
- **The product is never sellable** until the owner prices it through Pricing V2 **and** sets its stock mode. A later admin price needs no re-import and has no link to the source.

### C.10 The allow-list: no price, cost, stock, promotion or US policy from the source

Three layers.

**1. Extraction** (`extract.ts`, `crossSell.ts`):

- A closed read list: identity, options, SKU ids and value lists, `mediaFile`, `mediaFiles`, `colorUrl`, description elements, `productFeaturesModuleList`, `externalVideoLinkList`, `currentAllIdRoute`, the JSON-LD identity fields, and — only through `crossSell.ts` — `productSku.{id, seoCode, skuCode}`. The recording accessor throws on any other path; a test asserts it.
- The keys in source-analysis §3.3 "Do not import" and §3.9 (`trackingQuantity`, `availableStock`, `price*`, `discount*`, `quantityLimit*`, `points*`, `flashSale*`, `preSale`, `buyAndGet`) are never read.
- **The sentence classifier** (`sentences.ts`) labels each sentence of every prose field. Hits never reach the logs as text, only as counts.

| Class | Matches (case-insensitive, on one sentence) | Effect |
|---|---|---|
| `money` | a currency form: `$`/`US$` + digit, digit + `USD`/`dollars`, `price` + number, `price protection` / `price match` / `price adjustment` | removed |
| `promotion` | `discount`, `coupon`, `deal(s)`, `bundle discount`, `free shipping`, `on sale`, `sale price`, `limited[- ]time`, `save` followed by `on`/`up to`/`$`/a number/`%`, `% off`, `off` followed by a currency amount | removed, digits or not |
| `shipping_policy` | `shipping cost(s)`, `ships within`, `delivery time`, `packaging may vary`, `orders placed`, `return shipping` | removed |
| `warranty` | `warranty`, `guarantee`, `return(s)`, `refund`, `RMA`, `defective … covered` | withheld from customer content; stored as `manufacturer_terms.warranty_note` (`visibility 'owner'`, L-19) and a `sentence_withheld` conflict |
| `region` | voltage purchase advice ("purchase the version corresponding to your region's voltage") | region evidence (§C.6); not shown |
| everything else | technical and safety text, recall FAQs | kept |

Golden tests (`tests/bambuSentences.test.ts`):

- **kept:** "Prints come off easily when the temperature of the heatbed reaches room temperature, and we always recommend waiting until it reaches 35℃ or lower." (PEI plate and build-plate combo), and the A1 recall FAQ;
- **removed:** "30-day price protection", every `$` sentence, "Check out our Multi-Size Hotends Kit for an exclusive bundle discount." (hotend), "Save on officially refurbished Bambu Lab H2D." (refurbished H2D), "Packaging may vary, shipping costs are the same for all orders placed at the same time." (H2D table note);
- **withheld:** "The warranty will only cover manufacturing defects, not cosmetic damage… Defective sheets upon arrival are the only ones covered by the warranty." (PEI plate, build-plate combo).

**2. Payload** (`payload.ts`, the same code in the runner and the Worker):

- A closed TypeScript type plus a validator that refuses any key not in the schema, at any depth.
- It also refuses any key matching `/price|cost|stock|inventor|discount|msrp|amount|currency|margin|profit|wallet|coupon|quantity|qty_available|reserved|lot|fifo|supplier|tariff|freight|cbm|landing/i` anywhere, except `carton.pieces` **as a spec value, not a key**.
- Any customer-facing string the classifier labels `money`, `promotion`, `shipping_policy` or `warranty` is refused.
- The refusal is `IMPORT_PAYLOAD_KEY_REFUSED` (400, ar/en/ckb) with the JSON path.

**3. Writer and DB:** the doc is built from defaults, money fields are never assigned, and the guard triggers (§B.4) abort any money, stock, stock-decision, package or pricing write.

**Tests** (`tests/catalogImportAllowList.test.ts`):

- **Fuzz:** every `FINANCIAL_FIELDS` key plus every key in source-analysis §3.3/§3.9, injected at every depth of a valid payload, is refused by the validator. The same payloads sent to `/write` with the validator bypassed (a test-only seam) abort at the DB with `IMPORT_FINANCIAL_WRITE_REFUSED`, and zero rows are written.
- **End state:** after a full fixture import, every imported product has `price_iqd = 0`; `prime`, `pro`, `original` and `cost` NULL; `stock` NULL; package columns NULL; `stock_decision 'not_configured'`; no `product_pricing_state`, `product_sku_prices`, `pricing_*`, `inventory_*` or `price_history` row; catalog-only projection `price_status: 'unpriced'`, `price_iqd: null`.
- The leak scanner passes over every customer DTO of the imported fixtures, the knowledge DTO included.

### C.11 New refusal and error codes (ar / en / ckb)

| Code | ar | en | ckb |
|---|---|---|---|
| `IMPORT_PAYLOAD_KEY_REFUSED` | رُفض حقل غير مسموح في بيانات الاستيراد. | A field that is not allowed was refused in the import data. | خانەیەکی ڕێپێنەدراو لە زانیارییەکانی هاوردەدا ڕەتکرایەوە. |
| `IMPORT_FINANCIAL_WRITE_REFUSED` | الاستيراد لا يكتب أي سعر أو تكلفة أو مخزون. | The import never writes a price, cost or stock. | هاوردەکردن هیچ نرخ، تێچوو یان کۆگایەک نانووسێت. |
| `IMPORT_LEASE_LOST` | انتهت مهلة هذا المنتج في الاستيراد؛ سيُعاد بأمان. | This product's import lease expired; it will be retried safely. | ماوەی هاوردەکردنی ئەم بەرهەمە تەواو بوو؛ بە سەلامەتی دووبارە دەکرێتەوە. |
| `IMPORT_IDENTITY_AMBIGUOUS` | هوية المنتج في المصدر غير مؤكدة، فتوقف الاستيراد عنده. | The product's source identity could not be confirmed; the import stopped at it. | ناسنامەی سەرچاوەی بەرهەمەکە پشتڕاست نەکرایەوە؛ هاوردەکردن لێی ڕاوەستا. |
| `IMPORT_REVIEWED_SCOPE_REFUSED` | هذا المنتج أو هذا الدمج غير موجود في القوائم المراجَعة، فلم يُكتب. | This product or merge is not in the reviewed lists, so it was not written. | ئەم بەرهەمە یان ئەم تێکەڵکردنە لە لیستە پێداچوونەوەکراوەکاندا نییە، بۆیە نەنووسرا. |
| `IMPORT_ILLEGAL_TRANSITION` | انتقال غير مسموح في حالة الاستيراد؛ لم يتغير شيء. | That import state change is not allowed; nothing changed. | ئەم گۆڕینی دۆخەی هاوردەکردن ڕێگەپێدراو نییە؛ هیچ نەگۆڕا. |
| `IMPORT_STOCK_NOT_CONFIGURED` | حدّد طريقة المخزون لهذا المنتج المستورد قبل نشر سعره. | Set this imported product's stock mode before publishing its price. | پێش بڵاوکردنەوەی نرخ، شێوازی کۆگای ئەم بەرهەمە هاوردەکراوە دیاری بکە. |
| `IMPORT_STOCK_TRACKED_EMPTY` | لتتبّع الكمية أدخل كمية المخزون أولاً. | To track quantity, enter the stock quantity first. | بۆ بەدواداچوونی بڕ، سەرەتا بڕی کۆگا بنووسە. |

These are admin and ops strings, registered in `tests/programmeRefusals.test.ts`.

---

## D. Taxonomy

### D.1 Reading the live tree

1. **Public:** `GET https://levonis-iq.com/api/catalog/tree` (`worker/routes/catalog.ts:163`, `s-maxage=300`) and `GET /api/public/v1/sections`. They show only sections with a visible product, so empty owner-made nodes are missing.
2. **Complete, sealed:** workflow 60 `mode=snapshot` runs `wrangler d1 execute --remote --json`, in one step that also seals the output (§A.8), over:
   - `SELECT id, parent_id, slug, name_ar, name_en, name_ckb, active, sort, template_family, is_printer_catalog FROM catalogs`
   - `SELECT id, slug, name, name_ar, sku, brand_id, category_id, sub_category_id, status FROM products`
   - `SELECT id, slug, name_en FROM brands`
   - `SELECT product_id, source_url FROM product_images WHERE source_url LIKE 'https://store.bblcdn.com/%' OR source_url LIKE 'https://cdn.shopify.com/%'` (the match signal; owner-only)
   - `SELECT g.product_id, g.name_en, v.id, v.name_en FROM product_option_values v JOIN product_option_groups g …` and `SELECT id, product_id, name_en FROM product_colors` (for `value_map`)

   These include draft and hidden products, inactive catalogs and owner-only image provenance, so the file is **never uploaded in clear and never committed**. The log prints row counts only. The agent unseals it in its sandbox; the match candidates (§E.1) are computed there.
3. **The repo:** the seeded ids and slugs (0018, 0102, 0147, 0148; `templateFamilies.ts:1858-1930`) give the stable anchors: `cat_printers_fdm`, `cat_pacc_fdm`, `cat_materials_fdm`, `cat_materials_laser`, `cat_maint_hotend`, `cat_maint_plate`, `cat_maint_spare`, `cat_makers_*`, `cat_laser_*`.

### D.2 The reviewed map file `data/bambu-import/taxonomy-map.json`

```jsonc
{
  "version": 1, "reviewed_by": "<agent+integrator>", "reviewed_at": "…", "snapshot_sha256": "<sealed snapshot it was built against>",
  "create": [                                   // inserted once by /run/prepare-taxonomy, insert-only, never update/move
    { "key": "ams", "parent": "cat_pacc_fdm", "slug": "ams-feeding", "name_en": "AMS & filament feeding",
      "name_ar": "أنظمة تغذية المواد (AMS)", "name_ckb": "سیستەمەکانی پێدانی کەرەستە (AMS)", "template_family": "devices", "sort": 5 }
  ],
  "routes": {                                   // deepest matching prefix of currentAllIdRoute wins
    "552709755391528960>552709755685130240": { "primary": "@ams" },
    "552709755819347968>552709755857096704":  { "primary": "@pla" },
    "552709757765505024>552709757979414528":  { "primary": "cat_maint_hotend" },
    "552709757765505024>552709757794865152":  { "primary": "cat_maint_plate" },
    "552709758222684160>552709760676352000":  { "primary": "@parts-x1p1" }
  },
  "handles": { },                               // overrides: each must cite the route and a quote (rule 7)
  "collections": {                              // TYPE collections may add secondary memberships; marketing ones are ignored
    "laser-crafting": { "also": "cat_laser" }, "refurbished-3d-printers": { "primary_if_route": "@printers-refurb" },
    "sale": { "ignore": "marketing" }, "new-arrivals": { "ignore": "marketing" }, "best-seller": { "ignore": "marketing" }
  },
  "leaf_limit": 250
}
```

The canary `filament-buffer` has route `552709758222684160>552709760676352000>552709760709906432` (spare parts › X1/P1) and the Compatibility section "X1 Series and P1 Series", so the route already resolves it to `@parts-x1p1`. The draft's override to `@parts-ams` is removed.

**Rules:**

1. **Resolution order:** handle override → route (deepest prefix) → refuse (BLOCKED `TAXONOMY_UNMAPPED`, resumed after a reviewed map commit). No product falls into a generic "General" node.
2. **Primary:** `category_id` = the root of the primary leaf's branch, `sub_category_id` = the leaf. Secondary memberships go to `product_catalogs`. One product row, no copies (R7).
3. **Separate types:**
   - A part's compatibility with a printer is a relation, never a membership of the printer section.
   - Maker's Supply, filament and parts are separate subtrees.
   - Marketing collections (57 handles: sale, deals, new arrivals, seasonal, best sellers, app landings) and SEO landings never create memberships or tags.
4. **`leaf_limit`:** `tests/catalogImportTaxonomy.test.ts` rejects the map if the manifest puts more than 250 products in a leaf. Listings resolve at most `LISTING_CANDIDATE_CAP = 300` candidates (`worker/routes/products.ts:3102`), and catalog-only sorts priced first. Spare parts (~470) are therefore split by machine family under `cat_maint_spare`, and Maker's Supply by the existing `cat_makers_*` leaves.
5. **New nodes:**
   - Names in ar, en and real Sorani, reviewed with the app's vocabulary (row 183).
   - `template_family` set so the section's template applies; `is_printer_catalog = 1` only under printers.
   - Slug from the English name, `-2` if taken. Insert-only: existing nodes are never renamed, moved, re-sorted or deactivated.
6. **Brand:** `brands.slug = 'bambu-lab'`, reused or created once.
7. **Overrides are evidence-backed.** Every `handles` entry carries `{ primary, route, quote }`: the product's actual `currentAllIdRoute` and a quote of the page text that justifies the override. `tests/catalogImportTaxonomy.test.ts` checks both against the manifest facts, and refuses an override whose route already resolves to the same leaf.

**Proposed new nodes** (confirmed against the snapshot):

| Node | Parent | ar | en | ckb |
|---|---|---|---|---|
| `@printers-refurb` | `cat_printers` | طابعات مجدَّدة من المصنع | Factory-refurbished printers | چاپکەرە نوێکراوەکانی کارگە |
| `@ams` | `cat_pacc_fdm` | أنظمة تغذية المواد (AMS) | AMS & filament feeding | سیستەمەکانی پێدانی کەرەستە (AMS) |
| `@pla` `@petg` `@abs-asa` `@tpu` `@pc` `@engineering` `@support` `@fiber` | `cat_materials_fdm` | PLA / PETG / ABS وASA / TPU / PC / مواد هندسية / مواد الدعم / مواد مقوّاة بالألياف | PLA / PETG / ABS & ASA / TPU / PC / Engineering materials / Support materials / Fibre-reinforced | PLA / PETG / ABS و ASA / TPU / PC / کەرەستەی ئەندازیاری / کەرەستەی پاڵپشت / کەرەستەی بەهێزکراو بە ڕیشاڵ |
| `@parts-x1p1` `@parts-a1` `@parts-h2` `@parts-p2x2` `@parts-ams` `@parts-laser` | `cat_maint_spare` | قطع غيار سلسلة X1 وP1 / … A1 / … H2 / … P2S وX2D / قطع غيار AMS / قطع غيار الليزر | X1 & P1 series parts / A1 series parts / H2 series parts / P2S & X2D parts / AMS parts / Laser parts | پارچە یەدەگەکانی زنجیرەی X1 و P1 / … A1 / … H2 / … P2S و X2D / پارچە یەدەگەکانی AMS / پارچە یەدەگەکانی لەیزەر |
| `@bundles` (secondary only) | `cat_accessories` | الحزم والمجموعات | Bundles & kits | کۆمەڵە و پاکێجەکان |

### D.3 Verification

Taxonomy verification is part of §I.1 (the category and subcategory listing, the breadcrumb on the real page) and of the Worker's own recompute (§I.1.10). It is never just the foreign key.

---

## E. Existing products

### E.1 The reviewed match file `data/bambu-import/existing-matches.json`

1. **Candidates** are computed **in the agent's sandbox** by `scripts/bambu-import/match-candidates.ts`, from the unsealed snapshot (§D.1) and the manifest. Signals:
   - brand Bambu;
   - shared model tokens from the registry (A1, A1 mini, P1S, X1C, H2D, AMS lite, PLA Basic…);
   - existing image `source_url` on `store.bblcdn.com` / `cdn.shopify.com` (owner-only; it stays in the sandbox);
   - a slug or handle overlap.

   The candidate list contains private data and is never committed or uploaded.
2. **Names are evidence for review only** (§13). They never merge on their own.
3. **Each committed entry holds ids, public slugs, a decision and a reason code, nothing else:**

   ```jsonc
   { "source_product_id": "…", "source_handle": "a1",
     "levonis_product_id": "…", "levonis_slug": "bambu-lab-a1",   // slug only when the product was active at review
     "decision": "merge",
     "value_map": { "<bambu variant id>": { "option_value_ids": ["<existing value id>"] },
                    "<bambu variant id>": { "color_id": "<existing product_colors id>" } },
     "unmapped_variants": ["<bambu variant id>"],
     "reason": "same_model", "reviewed_by": "…", "reviewed_at": "…" }
   ```

   - `decision` ∈ `merge` | `merge_publish` | `distinct` | `not_bambu` | `hold_owner_hidden`:
     - `merge_publish`: the owner approved publishing a hidden product, with `approval_ref`;
     - `distinct`: same family, different product, so the source is created;
     - `not_bambu`: the Levonis candidate is not this Bambu product, so the source is created;
     - `hold_owner_hidden`: the target is owner-hidden and no decision exists yet.
   - `reason` ∈ a fixed list (`same_model`, `different_generation`, `different_bundle`, `not_bambu_product`, `owner_decision`).
   - There are no notes about stock, orders or anything else. An entry for a non-active product carries its id only.
4. **The gate is enforced twice.** The runner blocks at VALIDATING, and the Worker refuses at `/stage` and `/write` (`REVIEWED_SCOPE_REFUSED`, §A.3):
   - a product a candidate rule flagged but the file does not list;
   - a merge not listed;
   - a create for a source listed as `merge`, `merge_publish` or `hold_owner_hidden`.
   The file is completed in P0 (§K step 3).

### E.2 Merge mode: rules

**Never changed:**

- `name`, `name_ar`, `name_ku` (unless empty), `slug`, `status` (except under `merge_publish`), and a non-empty `category_id` / `sub_category_id`;
- existing memberships, which are only added to;
- option groups, values and variants: no add, remove or rename;
- every money, stock and package column; `sale_types`, `inventory_mode`, `sku`;
- warranty plans, ops policy, condition doc, labels, existing images (no delete, reorder or re-bind; the primary is unchanged unless the product has none);
- orders, carts, reservations, lots, serials;
- `description_*` and `content_blocks` when non-empty.

**Added (non-financial only):**

- images appended after the existing ones, bound only through `value_map`: to existing option values or variants, or **by `color_id` to existing `product_colors`** (a hex is never written); unmapped images stay product-level;
- secondary category memberships;
- an **empty** `category_id` or `sub_category_id` filled from the map (an additive change, logged as `category_filled` and in the merge report);
- `product_spec_values`, `product_documents`, `product_external_ids`, `product_relations`, `product_source_refs` (`match_kind 'merged'`, `stock_decision 'not_required'`), `product_option_source_refs` (mapped values);
- swatches for mapped colour **option values** (not for `product_colors`, which carry their own swatch);
- `spec_fields` keys that are empty today;
- an appended `specifications` group «مواصفات Bambu Lab الرسمية» / "Bambu Lab official specifications" / «تایبەتمەندییە فەرمییەکانی Bambu Lab» when no existing row has the same canonical label;
- `content_blocks` / `usage_guide` only when empty;
- search aliases.

**Conflicts:**

- An existing non-empty value that differs from the source → kept, plus a `field_kept_existing` conflict (owner-only, in D1; never logged, and only sealed in artifacts).
- An unmapped Bambu variant → `variant_not_merged` (L-6).
- A conflict touching identity, image integrity or an unresolvable taxonomy → BLOCKED (§13).

**Owner-hidden existing products (L-7)** are settled in the file before the run, so COMPLETE always has public evidence:

- `merge_publish` (owner approval recorded) → the merge also sets `status = 'active'`, and the product is verified publicly like any other;
- `distinct` / `not_bambu` → the source product is created as a new product, and the hidden one is untouched;
- `hold_owner_hidden` → the item is queued last with `hold_code OWNER_HIDDEN` and blocks at its turn, so the run reports "partial" until the owner decides;
- a `merge` whose target is found non-active at write time → BLOCKED `OWNER_HIDDEN`.

### E.3 Merge mode: how it is written

The intent is built from the stored state:

- `prev = doc` from the row;
- `relations` = `loadRelationsResponse` (`productPersistence.ts:3586`) converted to the wire body, unchanged, plus the appended image rows;
- `catalogIds` = current ∪ new; `printerFits` = current ∪ new;
- `translations` only for newly filled slots.

`planProductSave` is called in update mode with `actor.money = false`. The engine locks are value-compared (0181:360-372: "Never locked: … names, images, sort, the JSON columns"), so an unchanged full save passes. The guard triggers prove that no money column moved.

Tests, on a fixture "A1" priced through `publishV2` (and one with a `product_colors` colour model):

- after the merge, `isV2Published` is still true;
- the `pricing_v2_sku_results` rows are byte-identical;
- the queue state is unchanged (no "stale");
- the SKU universe is unchanged;
- a colour-model product receives colour-bound images by `color_id`, with `product_colors` rows unchanged;
- an empty `sub_category_id` is filled, and a non-empty one is not touched.

### E.4 Before/after fingerprints of protected fields

**Per write (exact):** for a merge, batch statements 1… and n… select the protected material of that product, **one table per statement** (no UNION chains; every statement under 100 parameters, checked through `LimitD1`). The Worker hashes each side. The material is:

- every money, stock, reserved and package column of `products`, `product_option_values`, `product_colors` and `product_variants`;
- `product_option_fulfillment` and `product_option_transports` rows;
- `product_pricing_state`, `product_sku_prices`, `pricing_v2_sku_results`, `pricing_price_points` and `pricing_preorder_discounts` for the product;
- counts and sums of `inventory_lots`, `inventory_ledger`, `order_items` and `price_history` for the product.

The batch is one transaction, so equality is proof. The digest is stored in `catalog_import_protected(phase 'write')` and never logged.

**Per run:**

- `phase 'before'` at the first job, before item 1; `'after'` at close.
- Subjects: every pre-existing product, plus global counters (rows and sums of `orders`, `order_items`, `wallet_transactions`, `accounting_entries`, `inventory_lots`, `inventory_ledger`, `price_history`, `product_sku_prices`, `pricing_v2_sku_results`, `product_pricing_state`, `coupon_*`, investor and wage tables), each hashed.
- **Customer activity during a 1–2 day run legitimately changes some of these.** The close report lists every changed subject with the non-import writes that explain it, from `audit_log`, `orders` and `inventory_ledger` rows inside the window. Unexplained changes → `PROTECTED_FIELDS_CHANGED`, which fails the run.
- `finance_mutation_clock` is excluded: it is a version counter (0167:155-157).
- Only `equal: yes/no` and counts reach the logs. Subject ids and slugs appear only in the sealed report and the owner dashboard.

---

## F. Curated enrichment for flagship products

**Scope.** Fixed in P0 and marked in the manifest (`curated: true`), expected 70–95 products:

- every new printer and starter kit (~18);
- AMS units (4);
- every filament product (~46; their specs exist only in the TDS);
- hotends and nozzles (~18);
- build plates (~8).

**Work** (offline, by agents, before each product's turn; committed):

1. For each product the agent reads the parsed store facts, the official documents (TDS and SDS PDFs on `store.bblcdn.com`, the AMS and printer spec PDFs, the wiki pages `/en/general/filament-guide-material-table`, `/en/filament/<family>`, `/en/filament-acc/acc/nozzles`, `/en/<printer>/manual/acc-in-the-box`) and, for printers, the page's own messages bundle for the 220 V / international values (§C.6). Spacing: ≥ 5 s per wiki request, ≥ 1 s per CDN document.
2. It writes `data/bambu-import/curated/<handle>.json`:

   ```jsonc
   { "handle": "pla-basic-filament", "schema": 2, "curated_by": "agent", "reviewed_by": "agent-2", "curated_at": "…",
     "searched": [ { "kind": "tds", "url": "https://store.bblcdn.com/…/Bambu_PLA_Basic_TDS_V3.pdf", "keys": ["mechanical.*", "thermal.*", "drying.*"] } ],
     "specs": [ { "key": "mechanical.tensile_strength", "scope": {"kind": "product"}, "value": 35, "unit": "MPa",
                  "status": "verified", "confidence": "official_doc", "source_kind": "tds",
                  "source_url": "https://store.bblcdn.com/…/Bambu_PLA_Basic_TDS_V3.pdf", "source_title": "Bambu PLA Basic TDS V3",
                  "locator": "p.2", "quote": "Tensile Strength (X-Y) 35 ± 4 MPa", "test_method": "ISO 527", "test_condition": "printed, X-Y",
                  "region": "", "retrieved_at": "…" } ],
     "hex": [ { "value_text": "Jade White (10100)", "hex": "#FFFFFF", "source_url": "…/Bambu_PLA_Basic_Hex_Code.pdf", "locator": "p.1" } ],
     "relations": [ { "relation": "compatible_with", "target_label": "AMS lite", "evidence_kind": "wiki_table", "source_url": "…", "quote": "…" } ],
     "in_the_box": [ … ], "documents": [ … ], "not_published": ["thermal.vicat"] }
   ```

3. `locator` and `quote` are written to `product_spec_values.source_locator` / `source_excerpt`. A CHECK requires an excerpt on every verified numeric TDS/SDS/manual value (§B.2). `not_published` keys must be covered by a `searched` entry, or the schema test fails.
4. `data/bambu-import/curated/index.json` maps `handle → sha256` of each reviewed file plus the class agreement figures. The Worker bundles it (§A.3).

**Rules:**

- TDS values keep `test_method` and `test_condition`.
- Printed-specimen results are never mixed with raw-material properties: distinct keys, `*.printed` vs `*.material`.
- A third-party lab value is never stored as a manufacturer spec.
- Marketing prose never proves a number (§6).

**The curated gate.** A curated-scope item whose file is not in the bundled index waits at VALIDATING (RETRYING `CURATION_PENDING`, 1 h, at most twice), then goes BLOCKED `CURATION_MISSING`. In practice the bulk run does not start until the whole curated scope is committed (§K step 13), so the gate is a safety net.

**Merge at run time.** For the same key, scope and region, curated beats deterministic only by source rank; a conflict is recorded either way. The deterministic page value is kept as `original_*` evidence in the event log.

**Quality validation per class:**

| Class | Gate |
|---|---|
| Curated (every file) | (1) A schema test: allowed keys, units, types, hosts, `locator` present and `quote` ≤ 200 chars for every verified numeric value, `not_published` covered by `searched`. (2) A consistency test: every curated value that also appears on the parsed store page agrees, or carries a conflict note. (3) An independent second-agent extraction of a 25 % sample per class, diffed field by field. **If disagreement exceeds 2 % of compared fields in a class, the second extraction is extended to 100 % of that class.** Disagreements are adjudicated in the file before commit, and each class's figures are recorded in `curated/index.json` and the report. (4) Unit and range sanity per key (nozzle 150–350 °C, density 0.9–2.5 g/cm³…). |
| Deterministic bulk (spare parts, Maker's Supply, others) | (1) Golden tests on the 8 fixtures plus 30 more saved discovery pages. (2) A label-coverage report from P0: every distinct label maps to a key or `x.*`, and the top 50 unknown labels by frequency join the registry before the run. (3) Range sanity. (4) A random 5 % post-run audit: an agent compares the live page with the source page and records the result in the report. |
| Media bindings (all) | Golden tests on the 8 fixtures (§C.4), plus Playwright selection checks per product (§I.1.7). |
| Taxonomy (all) | The map test (every manifest route resolves; leaf ≤ 250; overrides cite route and quote) plus listing verification per product. |

---

## G. Customer UI for the new data

All strings below are ar / en / ckb. Every new component follows the Clay primitives (`Button`, `Sheet`, `Note`, `Badge`; tokens only; `tests/claySystem.test.ts`).

### G.1 Data delivery that keeps first paint lean

**New** `GET /api/products/:slug/knowledge` on `productRoutes`. It is VISIBLE-gated, so hidden and missing products get the same 404:

```jsonc
{ "specs": [{ "group": "printing", "label": {ar,en,ckb}, "rows": [{ "key", "label": {ar,en,ckb}, "value_text", "value_num", "value_num_max",
              "unit", "status", "region", "scope": {"kind","id"}, "source": {"kind","title","locator","excerpt","url"?},
              "test_method", "test_condition", "conflict": false }] }],
  "logistics": { "product": {…}, "package": {…}, "shipment": {…}, "carton": {…} },   // no CBM to customers by default (L-4)
  "in_the_box": [{ "text", "qty", "image"?, "scope" }],
  "compatibility": { "compatible": [...], "not_compatible": [...], "requires": [...], "related": [...] },  // {label, product?: {slug,name,image}, scope}
  "documents": [{ "kind", "title": {ar,en,ckb}, "url", "host", "scope" }],
  "completeness": { "applicable", "verified", "unverified", "not_found", "not_published", "unknown" } }
```

- `source.url` only for official document, wiki, TDS and SDS kinds; a `store_page` ref is never emitted. Rows with `visibility = 'owner'` are never emitted.
- Anonymous-edge-cached, `s-maxage=300`, purged by `/publish-finish` and every admin product write (`cataloguePaths` gains `/api/products/<slug>/knowledge`).
- Without 0194 the answer is empty.

**Swatches, group labels and defaults** ride in the existing page body. The relations view's option-values read LEFT JOINs `product_option_value_swatches`, and the groups read selects `name_ar`, `name_ckb`, `kind` and `default_value_id`, both behind a 0194 presence probe. No new D1 wave: the `tests/d1Waves.test.ts` ceilings stay.

### G.2 Product page tabs (`src/pages/Product.tsx`, already a lazy route chunk)

A lazy `ProductKnowledgeTabs` (`React.lazy`) mounts below the buy block, fetches `/knowledge` when it nears the viewport (`IntersectionObserver`, `rootMargin` 400 px), and renders the existing `Section` accordion on phones and tabs on desktop.

| Tab | ar | en | ckb | Shown when |
|---|---|---|---|---|
| Specifications | المواصفات | Specifications | تایبەتمەندییەکان | any spec row |
| Materials & printing | المواد وإعدادات الطباعة | Materials & printing | کەرەستە و ڕێکخستنی چاپ | rows in `material`, `print_settings` or `drying`, or nozzle/plate material and glue rows |
| Packaging & Shipping | التغليف والشحن | Packaging & shipping | پاکەتکردن و ناردن | any logistics row or in-the-box item |
| (in Packaging) In the box | محتويات العلبة | In the box | ناوەڕۆکی سندوق | any item; each item shows its picture (`/files/<key>?w=`) when it has one |
| Compatibility | التوافق | Compatibility | گونجاوی | any relation |
| Documents | المستندات والأدلة | Documents & manuals | بەڵگەنامە و ڕێنماییەکان | any active document |

**Value states** (never 0 or false):

| State | ar | en | ckb |
|---|---|---|---|
| `not_found` | غير متوفر في المصادر التي رُوجعت | Not in the sources checked | لەو سەرچاوانەی پشکنران نییە |
| `not_published` | لم تنشره الشركة المصنّعة | Not published by the manufacturer | لەلایەن بەرهەمهێنەرەوە بڵاو نەکراوەتەوە |
| `not_applicable` | لا ينطبق | Not applicable | پەیوەندی پێوە نییە |
| `unknown` | غير متوفر | Not available | بەردەست نییە |
| `unverified` (badge) | غير مؤكَّد | Unverified | پشتڕاست نەکراوەتەوە |
| `us_110v` (row note) | النسخة الأمريكية (100–120 فولت) | US version (100–120 V) | وەشانی ئەمریکی (100–120 ڤۆڵت) |

A `not_found` row's popover lists the checked sources: «المصادر التي رُوجعت» / "Sources checked" / «ئەو سەرچاوانەی پشکنران».

| Label | ar | en | ckb |
|---|---|---|---|
| Source line | المصدر: … | Source: … | سەرچاوە: … |
| Official (Bambu Lab) | رسمي (Bambu Lab) | Official (Bambu Lab) | فەرمی (Bambu Lab) |
| Test method | طريقة الاختبار | Test method | ڕێگای تاقیکردنەوە |
| Applies to (variant scope) | خاص بـ | Applies to | تایبەتە بە |
| Other versions | إصدارات أخرى | Other versions | وەشانەکانی تر |
| Compatible with | متوافق مع | Compatible with | گونجاوە لەگەڵ |
| Not compatible with | غير متوافق مع | Not compatible with | گونجاو نییە لەگەڵ |
| Requires | يتطلب | Requires | پێویستی پێیەتی |
| Related products | منتجات ذات صلة | Related products | بەرهەمە پەیوەندیدارەکان |
| Net weight | الوزن الصافي | Net weight | کێشی پوخت |
| Package weight | وزن العبوة | Package weight | کێشی پاکەت |
| Shipment gross weight | الوزن الإجمالي للشحنة | Shipment gross weight | کێشی گشتی بارەکە |
| Product dimensions | أبعاد المنتج | Product dimensions | قەبارەی بەرهەم |
| Package dimensions | أبعاد العبوة | Package dimensions | قەبارەی پاکەت |
| Recommended space | المساحة الموصى بها | Recommended space | ئەو شوێنەی پێشنیار دەکرێت |
| Opens on the manufacturer's site | يُفتح في موقع الشركة المصنّعة | Opens on the manufacturer's site | لە ماڵپەڕی بەرهەمهێنەر دەکرێتەوە |

- **Variant-scoped rows** show for the current selection, then the product-level rows. A row scoped to an unselected value is hidden. With no explicit selection, the default selection (§G.3) applies, so A1's per-version package shows for the A1 Combo default.
- **Numbers** render with `<bdi>` and the unit as published. RTL first.

### G.3 Selection and images

- **Default selection.** When the server sends no `initial_selection` (always the case for an unpriced product, catalog-only §3.3), the page preselects each group's `default_value_id`, but only while those defaults form a real variant. Otherwise it preselects the first group's default alone. Variant-scoped rows and the gallery follow it.
- **Gallery for a selection** (`galleryOf`, `Product.tsx:757-768`):
  1. **Drop contradicting images.** While a selection exists, leave out every image bound to a value of a group in which another value is selected, every image bound to a variant whose `combo_key` contains such a value, and every image bound to a colour other than the selected one. Unbound images always stay. If nothing would remain, use the full list.
  2. **Rank** with `productMediaForSelection` (`packages/pricing/src/productSelectionMedia.ts:83`) over the full remaining list.
  3. **De-duplicate by URL afterwards,** keeping the first occurrence. Today the de-duplication runs first and drops the second binding of a shared image.

  `src/lib/productGallery.ts` holds the pure function; `tests/productGallerySelection.test.ts`:
  - PEI plate: select H2C → hero FAP035; select H2D → hero FAP025 (both fail before the fix, because FAP035/FAP025's second binding is de-duplicated away and the primary FAP033 leads);
  - H2D: select `H2D AMS Combo` → H2DC, with no H2DL or plain-H2D image in the gallery;
  - A1: select `Standard` → no A1_C image.
- **Colour groups** (`kind = 'color'`):
  - values render as swatch chips (`swatch.url`, 28 px, `object-fit: cover` in a circle; a colour sample, not product imagery);
  - otherwise a published-hex dot;
  - otherwise the text chip;
  - the accessible name is always the value name.
- **Impossible combinations:** a value that forms no active variant with the current selection is shown disabled with «غير متاح مع هذا الاختيار» / "Not offered with this choice" / «لەگەڵ ئەم هەڵبژاردنە بەردەست نییە». This is never «نفد». It is computed from `relations.variants[].combo_key`; catalog-only keeps `combo_key` (§K.1 D-2).
- **A single-value group** is auto-selected.
- **Images** use `object-fit: contain` in the main gallery. Cards keep the house 1:1 frame with `contain` for imported products. Every gallery image after the first lazy-loads, with responsive widths from the stored variants (row 226).

### G.4 Documents tab titles by kind

| Kind | ar | en | ckb |
|---|---|---|---|
| `manual` | دليل الاستخدام | User manual | ڕێبەری بەکارهێنان |
| `quick_start` | دليل البدء السريع | Quick start guide | ڕێبەری دەستپێکی خێرا |
| `installation` | دليل التركيب | Installation guide | ڕێبەری دامەزراندن |
| `tds` | ورقة البيانات الفنية (TDS) | Technical data sheet (TDS) | پەڕەی زانیاری تەکنیکی (TDS) |
| `sds` | ورقة بيانات السلامة (SDS) | Safety data sheet (SDS) | پەڕەی زانیاری سەلامەتی (SDS) |
| `certificate` | شهادة مطابقة | Compliance certificate | بڕوانامەی گونجان |
| `hex_codes` | رموز الألوان | Colour codes | کۆدەکانی ڕەنگ |
| `spec_sheet` | ورقة المواصفات | Specification sheet | پەڕەی تایبەتمەندییەکان |
| `wiki` | ويكي Bambu Lab | Bambu Lab Wiki | ویکی Bambu Lab |
| `video` | فيديو | Video | ڤیدیۆ |
| `model_file` | ملف نموذج | Model file | فایلی مۆدێل |
| `faq`, `guide`, `other` | الأسئلة الشائعة / دليل / رابط | FAQ / Guide / Link | پرسیارە باوەکان / ڕێبەر / بەستەر |

Every link opens in a new tab with `rel="noopener noreferrer"`, shows the host, and carries the "Opens on the manufacturer's site" hint.

### G.5 Cards, compare, filters and search

**Cards** (the brief's §9: section name and 2–4 real key properties):

- The card projection gains `key_specs` (≤ 4 entries of ≤ 40 characters each), read from the product's `spec_fields` mirrors for registry keys flagged `cardKey` for its type: printers (build volume, enclosure, colours), filament (material, diameter, net weight), hotends (nozzle diameter, material), plates (size, surface). There is no new query: `spec_fields` is on the row the card already reads.
- It also gains `section_name {ar, en, ckb}` for `sub_category_id`, from the taxonomy the listing routes already load (`loadCatalogs`). `tests/d1Waves.test.ts` asserts no new wave.
- `ProductCard` renders one muted line under the name. The bundle cost is measured (§G.6). If it does not fit the budget after pay-back, the line ships behind the card's existing lazy detail area and §1 gains a deviation row with the measured numbers.

**Compare.** `worker/lib/compareSpecs.ts` reads `product_spec_values` for registry keys flagged `compare` when 0194 is present, and falls back to `spec_fields`. Each cell carries the unit, the test method when present, and the state label («غير متوفر في المصادر التي رُوجعت» … from §G.2) instead of a blank. It is one extra `IN` query for ≤ 4 products on a route that is not first paint; the compare route's `d1Waves` ceiling is updated with the measured number. Imported printers, filaments, hotends and plates become comparable.

**Filters** (`packages/catalog/src/discovery.ts:43-52`, `worker/lib/listingFacets.ts`):

- `FACET_FIELDS` gains `product_family: 'family'` and `spool_type: 'spool'`, read from new template fields `product_family` (shared by every family) and `spool_type` (materials family), both mirrored by the importer.
- `color_name` becomes multi-valued: the importer mirrors the base colours of the colour group's values (through `registry/colours.ts`, e.g. "Jade White" → white) as `"white | black | …"`, and `facetTokensOf('color_name')` splits on ` | `. An unmapped colour name gives no facet token, but it is still searchable.
- Labels: «العائلة» / Family / «خێزان»; «البكرة» / Spool / «ماسوورە», with values «عبوة بدون بكرة» / Refill / «پڕکردنەوە بەبێ ماسوورە» and «مع بكرة» / With spool / «لەگەڵ ماسوورە».
- Base colours (authored):

  | key | ar | en | ckb |
  |---|---|---|---|
  | black / white / grey | أسود / أبيض / رمادي | Black / White / Grey | ڕەش / سپی / خۆڵەمێشی |
  | red / orange / yellow | أحمر / برتقالي / أصفر | Red / Orange / Yellow | سوور / پرتەقاڵی / زەرد |
  | green / blue / purple | أخضر / أزرق / بنفسجي | Green / Blue / Purple | سەوز / شین / مۆر |
  | pink / brown / beige | وردي / بني / بيج | Pink / Brown / Beige | پەمەیی / قاوەیی / بێژ |
  | gold / silver | ذهبي / فضي | Gold / Silver | زێڕین / زیوی |
  | transparent / multicolour | شفاف / متعدد الألوان | Transparent / Multicolour | ڕوون / فرەڕەنگ |

- **Printer compatibility** filtering is the existing «يناسب طابعة» narrowing over `product_printer_fits`.
- Nozzle-diameter and max-nozzle-temperature facets are added after the run only for keys with values on more than 20 products.

**Search.** Aliases (§C.1) and the authored ar/ckb synonyms that `/run/prepare-taxonomy` inserts into `search_synonyms` (§A.3): materials, product types and compatibility words, for example فلامنت، خيط طباعة، بكرة، عبوة بدون بكرة، نوزل، فوهة، صفيحة طباعة → filament, spool, refill, nozzle, build plate, and فیلامێنت، ماسوورە، نۆزڵ، پلێتی چاپ in Sorani. Step 4 checks the direction (term → canonical) against `worker/lib/search/vocabulary.ts` and the 0089/0091 seeds.

### G.6 Bundle budget

- `ProductKnowledgeTabs`, the swatch chips and the in-the-box images are lazy, inside the product chunk. Swatch chips are ~0.4 KB gzip, inside the option chooser that already ships.
- The card key-spec line and section line are in the storefront's first chunk. They are measured with `npm run build` + `node --import tsx --test tests/bundleBudget.test.ts` before and after, with the numbers in the commit message. If the opening grows, it is paid back by making a below-the-fold piece lazy (`bundleBudget.test.ts:381-384`); otherwise §G.5's fallback applies.
- `ProductKnowledgeTabs` joins the "product opening excludes …" list.

---

## H. Admin import dashboard and coverage report

### H.1 API (owner-only, read-only)

Router `worker/routes/adminCatalogImport.ts` at `/api/admin/catalog-import`, all `requireOwner` (`worker/lib/costAccess.ts:155`):

- `GET /runs`, `GET /runs/:id`:
  - state, start and end, and the §15 progress fields (§H.3);
  - the current item with its stage, last checkpoint time, and its media and option counts;
  - the last verified public URL, the measured rate (items per hour, median and p90 per stage), an ETA labelled as an estimate, and the GitHub run link.
- `GET /runs/:id/items?state=&q=&cursor=` (paged at 50); `GET /items/:id`: events, media rows, conflicts, missing info by reason, quality counts, the Worker's `d1_checks` next to the runner's `edge_evidence`, the resume instruction.
- `GET /runs/:id/report.json` and `GET /runs/:id/report.csv`: streamed from D1 (§H.3).

Classified `owner` in `tests/routeClass/catalogImport.ts`.

### H.2 UI

A lazy admin chunk `src/components/adminImport/CatalogImportDashboard.tsx`, a tab under products: «استيراد Bambu Lab» / "Bambu Lab import" / «هاوردەکردنی Bambu Lab».

**There is no SKIP button and no "advance cursor" control.**

**Blocked items** show the blocker in ar/en/ckb and the resume instruction:

| ar | en | ckb |
|---|---|---|
| «لاستئناف هذا المنتج: عالج السبب أعلاه ثم شغّل سير العمل 60 بوضع run مع resume.» | "To resume this product: fix the cause above, then run workflow 60 in run mode with resume." | «بۆ دەستپێکردنەوەی ئەم بەرهەمە: هۆکارەکەی سەرەوە چارەسەر بکە، پاشان ڕێڕەوی کاری 60 بە دۆخی run لەگەڵ resume کار پێبکە.» |

**State labels:**

| State | ar | en | ckb |
|---|---|---|---|
| `DISCOVERED` | مكتشَف | Discovered | دۆزراوە |
| `EXTRACTING` | استخراج | Extracting | دەرهێنان |
| `ENRICHING` | إثراء | Enriching | دەوڵەمەندکردن |
| `VALIDATING` | تدقيق | Validating | پشکنین |
| `INGESTING_MEDIA` | حفظ الصور | Saving images | پاشەکەوتکردنی وێنەکان |
| `WRITING` | حفظ | Writing | پاشەکەوتکردن |
| `PUBLISHING` | نشر | Publishing | بڵاوکردنەوە |
| `VERIFYING_LIVE` | تحقق حي | Verifying live | پشتڕاستکردنەوەی ڕاستەوخۆ |
| `COMPLETE` | مكتمل | Complete | تەواو |
| `RETRYING` | إعادة المحاولة | Retrying | هەوڵدانەوە |
| `BLOCKED` | متوقف لعائق | Blocked | ڕاگیراوە بەهۆی ڕێگرێک |
| `WITHDRAWN_AT_SOURCE` | سُحب من المصدر (غير مكتمل) | Withdrawn at the source (not complete) | لە سەرچاوەوە کشێنرایەوە (تەواو نییە) |

**Information completeness in the product list and form** (the brief's §18A), for any product with `product_spec_values` rows:

- computed per product type from the registry's `expected` keys that apply to the type: `ratio = (verified + unverified) / applicable`;
- `not_found` + `not_published` («ناقص» / "Missing" / «کەم»), `unknown` («غير معروف» / "Unknown" / «نەزانراو») and `unverified` («غير مؤكَّد» / "Unverified" / «پشتڕاست نەکراوەتەوە») shown separately; `not_applicable` excluded;
- the list column «اكتمال المعلومات» / "Information completeness" / «تەواوی زانیاری» is one `GROUP BY product_id, status` query for the page's ≤ 50 ids; the form shows the same as a card with the missing keys by name;
- it is separate from the existing commercial `product_completeness`.

### H.3 Final coverage report (generated from D1 only; sealed when it leaves the Worker)

**Per item** (CSV and JSON): source id, handle, title, state, `match_kind`, Levonis id, slug, live URL, primary category path, memberships, groups, values, variants, colour values, gallery images, images by binding rule, swatches, description images, in-the-box images, omitted by cap, failed media, specs by status and region, conflicts by kind, documents (active/dead, TDS/SDS/manual counts), relations (resolved/pending/unresolvable), translation slots `review_needed`, attempts, first and last timestamps, blocker.

**Progress fields (the brief's §15), D1 aggregates, in `report.json`, `report.csv`, the dashboard, and the job summary after every product** (counts only):

`discovered_total`, `queued_total`, `complete_count`, `current_product`, `blocked_count`, `withdrawn_count`, `remaining_count`, `created_count`, `updated_existing_count`, `deduplicated_references` (one source product seen under several collections or handles), `category_links`, `subcategory_links`, `option_count`, `variant_count`, `color_count`, `saved_media_count`, `linked_variant_media_count`, `failed_media_count`, `extracted_specs_count`, `verified_specs_count`, `missing_info_by_reason`, `document_count`, `tds_count`, `sds_count`, `public_product_url` (per complete item), `failed_stage`, `attempts`, `blocker`, `resumption_instruction`, and the finance-protection results.

**Summary layers** (no invented numbers, no "100 %"):

| Layer | Contents |
|---|---|
| Coverage | discovered, processed, complete, blocked, withdrawn, queued, canonical duplicates |
| Taxonomy | created and reused nodes, memberships, listing checks passed |
| Media | discovered, stored, colour-bound, variant-bound, representative, content-duplicate, shared, failed, omitted |
| Structured data | groups, values, variants, numeric specs, logistics fields, relation edges |
| Provenance | official vs curated vs derived, `us_110v` vs `intl_220v`, conflicts, not-found and not-published by key, documents/TDS/SDS, curated agreement per class |
| Storefront | anonymous-visible, searchable, compare-visible, catalog-only valid, price-request eligibility checked, live signed-in requests (if L-17) |
| Finance protection | per-write equality count, run before/after with explanations, guard trigger hits (must be 0), stock decisions `not_configured` |
| Operations | one-at-a-time proof (the index, the transition trigger, and the event sequence: no two items with overlapping EXTRACT-start..COMPLETE windows), checkpoints, retries, deadline exits, first and last public URLs, run closed, no active schedule |

---

## I. Verification

### I.1 Per product, before COMPLETE

The runner reads the live public site, never the payload it just sent, and records each check's evidence (HTTP status, counts, URL) in `edge_evidence`. The Worker independently recomputes the D1-side facts (check 10). COMPLETE is accepted only when both sides pass and agree.

The public v1 product DTO has no option-value or group ids, no variant `combo_key`, no per-image binding and no spec status (`worker/lib/publicApi/resources/products.ts:391-401`, `:417-427`, `:437-439`, `:470-477`; `common.ts:68-79`). So structure is checked against the **anonymous site API**, whose `publicRelations` carries group and value ids, `variants[].combo_key` and image bindings (`worker/lib/productOverlay.ts:1016-1105`), and `/knowledge`. Both are public production reads, so the brief's §20.2 is still met.

1. **Public v1** — `GET /api/public/v1/products/<slug>` → 200:
   - the name equals the title;
   - `sections` = the primary path plus the secondary memberships;
   - the image count equals the expected number of distinct images;
   - `price.status = 'unpriced'`, `amount = null`, `purchase` null.
2. **Structure** — `GET /api/products/<slug>` (anonymous) → 200, `price_status: 'unpriced'`:
   - `relations.option_groups`: ids, order and labels equal the payload;
   - `relations.variants`: the set of `combo_key`s equals the payload's real variants, with no extra combination;
   - `relations.images` (`worker/lib/productOverlay.ts:1094-1105`: `id`, `url`, `is_primary`, `option_value_id`, `color_id`, `variant_id`): count per binding, the primary, and every URL `/files/…webp`;
   - `default_value_id` per group and swatch URLs present.

   `GET /api/products/<slug>/knowledge` → 200: spec row counts by status and region, document, relation and in-the-box counts equal the payload.

   **Fingerprint:** `fingerprint.ts` hashes a canonical projection of these two answers (group, value and variant ids and keys; media URLs with bindings; spec keys, scopes, regions, statuses, units and numbers; document kinds and URLs; relation labels and targets). The runner computes the expected value from the payload, the `/write` answer and the `/media` results with the same code. `tests/catalogImportE2E.test.ts` proves the equality on all 8 fixtures **through the real routes**.
3. **Category listing and subcategory listing:**
   - `GET /api/products?category=<leaf slug>&search=<exact title>` and the same for the root: the product is present, or found by paging when the answer is `truncated`;
   - secondary memberships checked the same way;
   - the tree count for the leaf is ≥ 1 (`/api/catalog/tree` after the purge).
4. **Search:**
   - `GET /api/public/v1/search?q=<exact title>` → the slug is present (hard);
   - each registry model code: the slug in the first 24 (hard when the code is unique to the product, soft otherwise);
   - each searchable external id (colour code, part code, SKU code): present (hard).
5. **Not sellable, and the request door works:**
   - `POST /api/products/<slug>/quote` (anonymous, a valid selection) → 409 `PRICE_NOT_AVAILABLE`;
   - `POST /api/price-requests` without a session → 401 (a smoke check only: it proves nothing about the product);
   - the product's own request eligibility is proven by the Worker in check 10.
6. **Media integrity:** `HEAD` on every `/files/<key>` of the product (gallery, swatches, in the box) → 200 `image/webp`; `readback`: every bound value, variant and image id belongs to the product, every key exists, `verifyApplied` reports no mismatch.
7. **Browser** (Playwright, Chromium headless, one browser per job). Open `/product/<slug>` in Arabic (the default):
   - the main image decodes (`naturalWidth > 0`) and keeps its ratio (`object-fit: contain`);
   - «السعر غير متوفر حالياً» is visible, «طلب السعر» is present, there is no add-to-cart, buy-now or Quick Buy control, and no `0` followed by a dinar unit;
   - the default selection is applied when the product has one;
   - for each colour, version or size value (at most 12 per product; all of them for the audit classes): click it and assert that **the hero URL equals the expected binding** and that **no image bound to another value of the same group, or to a contradicted variant, is present in the gallery**. A disabled impossible value shows the helper;
   - the breadcrumb: not applicable, the page draws none (§1 row 28; the section is checks 3 and 10);
   - screenshots for the 8 audit classes, 1 in 25, and every failure, sealed.
8. **Existing products:** for a merge, `before_fp_equal` is true and the V2 status is unchanged (§E.3). A merge keeps the existing product's name, price, options and images (§E.2), so checks 1, 2, 5 and 7 read only what the import owns: 1 the sections and the appended images (not the name or the price); 2 the appended images by URL and a `/knowledge` answer (its counts are the Worker's recompute, check 10; no fingerprint: the ids are the existing product's); 5 the request smoke only (the quote is the existing product's); 7 the main image, the dinar text and the store requests (not the chooser, the price or the buying controls).
9. **Cache:** a stale answer makes the runner re-call `/publish-finish` (which purges the site, knowledge and v1 keys) and wait up to `s-maxage + 60 s` (max 360 s, within the deadline rules) before failing the check. A persistent failure → BLOCKED `VERIFY_FAILED_PERSISTENT`.
10. **The Worker's own recompute at `/complete`**, stored in `d1_checks`:
    - VISIBLE true and SELLABLE false, through catalog-only's own predicates;
    - `category_id` / `sub_category_id` equal the map's resolution, and the `product_catalogs` set equals the secondary memberships;
    - `search_tokens` has the current `INDEX_STAMP` row, the title tokens, and every searchable alias;
    - R2 `HEAD` on every image, swatch and in-the-box key;
    - row counts per group, value, variant, image binding, spec status and region, documents and relations equal `stage_data`;
    - `stock_decision = 'not_configured'` for a create; guard hits 0;
    - **price-request eligibility:** catalog-only's shared validator `validatePriceRequestSelection(db, productId, selection)` (§K.1 D-5), the same code the `POST` uses but creating no row, is called for the default selection and each selection the runner checked. It must answer eligible for a complete selection and `SELECTION_REQUIRED` for an incomplete one.

    Any false value, or any count that differs from the runner's `edge_evidence`, refuses COMPLETE (`VERIFY_FAILED_PERSISTENT` after the cache rule).
11. **Compare:** `GET /api/compare?ids=<id>` → 200 with the card. When the registry gives the product's type ≥ 3 compare keys with values, `GET /api/compare/candidates?q=<title>` contains it; otherwise its absence is recorded as expected for the type.

Then `/complete` stores `verified_at`, `live_url`, `edge_evidence` and `d1_checks`. The `catalog_import_items` CHECK refuses COMPLETE without them.

**Live signed-in price request (L-17).** If the owner provides a dedicated customer test account as two GitHub secrets, used only by the importer step, the canary and the 8 audit-class products each get one real request through the signed-in API. Before it is withdrawn, a read-only wrangler query checks that it reached the needs-pricing queue order, printing booleans only. It is then withdrawn (`DELETE /api/price-requests/:id`, state `closed`, reason `withdrawn`), so it does not count as demand. Without that account this is not done, and the report says so.

### I.2 The brief's §14 checklist, mapped

| §14 item | Where it is proven |
|---|---|
| §14أ migrations, unit/integration, build, typecheck | Workflow 7 on every push (full CI, migrate-check `--twice`) |
| §14أ pricing, profit, discount and stock tests unbroken | Full CI, plus `tests/importStockDecision.test.ts` |
| §14أ unpriced product public and checkout refused | catalog-only §7.3; `tests/catalogImportE2E.test.ts` |
| §14أ general plus colour plus model images | §C.4 golden tests; `tests/productGallerySelection.test.ts`; dry runs (§K step 10) |
| §14أ category, subcategory, search, filters | Dry runs plus §I.1.3–4; facet tests (§G.5) |
| §14أ price request, unique count, admin notice, ordering | catalog-only §7.5; §I.1.10 eligibility per product; live requests on the canary and audit classes when L-17 allows |
| §14أ idempotency, no duplicates on retry | `tests/catalogImportIdempotency.test.ts`: kill between `write` and `publish-finish`, kill mid-media, re-send `write` → no new rows |
| §14أ old products financially untouched | §E.3 tests plus the guard trigger tests |
| §14ب per product | §I.1 checks 1–11 |
| §14ج 8 audit classes | §I.4 |
| §14د 1–20 | 1: §I.1.1–2. 2: §I.1.3. 3: §I.1.7. 4: §C.4 plus swatches. 5: §I.1.7. 6: §C.3 plus §I.1.2. 7: §I.1.1–2. 8: §B.7 plus the Packaging tab. 9: §C.7. 10: §B.6. 11: §I.1.1–4. 12: §I.1.7. 13: §I.1.5/10 plus catalog-only §7.3. 14–16: catalog-only §7.5 plus L-17. 17: §E.4. 18: §I.1.3/4/9. 19: the idempotency test plus `ux_cii_*` and the transition trigger. 20: §B.3/§B.5 (no SKIPPED state; WITHDRAWN_AT_SOURCE is never COMPLETE). |

### I.3 End of run (brief §15 and §20)

1. Re-read `/sitemap.xml`, `sitemap_products_1.xml` and `sitemap_collections_1.xml` at ≥ 11 s spacing and diff with the manifest.
   - **New handles** are listed. Adding them to the run needs a reviewed manifest commit (bundled, so it deploys through workflow 7); then they are processed in the same run.
   - **Removed handles** already COMPLETE stay published (the import is not a sync) and are reported as "no longer in the source sitemap".
2. Assert:
   - every manifest row is COMPLETE exactly once, or WITHDRAWN_AT_SOURCE with evidence, or BLOCKED and named;
   - `COUNT(product_source_refs WHERE import_run_id = run)` equals created plus merged;
   - the variant and value counts in D1 equal the summed payload counts;
   - zero `pending` relations whose target is in the manifest.
3. **Public sweep:** every COMPLETE slug, `GET /api/public/v1/products/<slug>` at 2 per second (~10 min): 200 and visible. It is priced only if the owner priced it meanwhile, which needs his stock decision too.
4. **Category sweep:** every leaf's public listing count equals the D1 count of its visible members.
5. **Storefront sweep:** the facet counts for `family`, `spool` and `color` equal D1 aggregates; compare candidates include every type with ≥ 3 compare keys.
6. **Price requests:** if L-17 allowed live requests, they were seen in the queue order and were withdrawn; catalog-only's admin digest delivered, checked by its own sweep status (booleans).
7. Run the `after` protected snapshot and the explanation pass (§E.4).
8. `/run/finish`. Assert the old token now gets 404, the `wrangler.jsonc` crons are unchanged, and no scheduled task exists.
9. Seal and upload the report (§H.3).

**Wording rules:** the job summary says "partial" and names the exact BLOCKED and WITHDRAWN items when any exists. It never uses «تم» or "100 %" unless every count proves it.

### I.4 The 8 audit sample classes (§14ج), processed first after the canary (§J.4)

| Class | Handle (from the fixtures) | Extra assertions |
|---|---|---|
| Printer, standard and combo | `h2d` (and `a1` if it is a merge, §E) | the version images per §C.4's golden expectations; combo-only in-the-box rows scoped; per-version shipment weight scoped; no `verified` 100–120 V row; `Standard` and `standard` both present |
| Multi-colour filament, Refill/Spool | `pla-basic-filament` | 30 colour values with swatches; 43 variants (not 60); a colour-level image per colour, gallery #0 included; published hex from the curated Hex Code PDF; 10 documents; TDS specs with test methods and excerpts; `material.net_weight` from `1kg`; diameter 1.75 mm ± 0.03 mm; AMS compatibility and the spool requirement as relations |
| Hotend, multiple nozzle sizes | `bambu-hotend-a1-a2` | images bound to the `nozzle` values; `nozzle.diameter` per value; relations to A1, A1 mini and A2L per printer value; the "bundle discount" sentence absent |
| AMS, units and spare parts | `ams-2-pro`, `ams-2-pro-feeder-unit` | dependent options (15/42); the 13 variants of gallery #0 bound at variant level; compatibility via the printer question; **the feeder unit → `ams-2-pro` relation resolved** through `compat-targets.json`; its installation wiki document resolved from the tracker link |
| Build plate, multiple compatibility | `bambu-textured-pei-plate` | FAP033 bound to 5 values with one key; selecting H2C leads with FAP035 and H2D with FAP025; 10 printer relations; `Texture PEl` kept; "Prints come off easily…" kept; the warranty sentences withheld |
| Maker's Supply kit or electronic part | `wireless-charger-kit-k012` | electronics specs; the `.zip` model document; in the box with images |
| Product in more than one category | `h2d` (3d-printer + laser-crafting) or `pla-pure` | the secondary membership listing verified |
| Sold out at the supplier | `refurbished-bambu-lab-h2d-3d-printer` | `source_sold_out_variants = 1` in the ledger; visible catalog-only with no «نفد»; "Save on officially refurbished…" absent |

---

## J. Rate, politeness, duration, chaining

### J.1 Store pages (`us.store.bambulab.com`)

- One request at a time, **at least 10 s** apart (we use 11 s). **The page for item N+1 is fetched only after item N's COMPLETE has committed.** The runner asserts it against the event sequence before each EXTRACT, and §H.3's one-at-a-time proof covers EXTRACT.
- User-Agent `Mozilla/5.0 (compatible; LevonisCatalogImport/1.0; +https://levonis-iq.com)`.
- Only `/products/<handle>`, the three sitemaps and robots.txt. robots.txt is re-read once per job; a `Disallow` matching a planned URL → BLOCKED `ACCESS_CHALLENGE` (policy).
- `Accept-Encoding: br, gzip`. No cookies.
- 429 or 503 → honour `Retry-After`, else 60 s, 120 s, 240 s … 30 min, within the deadline rules (§A.7).
- A `cf-mitigated` header, a "Just a moment…" body, or a 403 → BLOCKED `ACCESS_CHALLENGE` at once. **Never bypassed:** no header spoofing, no headless browser on the store, no proxies.

### J.2 Other hosts

| Host | Who fetches | Spacing |
|---|---|---|
| `store.bblcdn.com` images | the Worker only, sequentially, ≤ 4 per call, 20 s deadline each | ≥ 1 s between media calls |
| `store.bblcdn.com` / `cdn.shopify.com` document checks | the runner | ≥ 1 s |
| `e.bambulab.com` tracker HEADs (no redirect followed) | the runner | ≥ 1 s; a challenge is never bypassed |
| `wiki.bambulab.com` | the runner (≤ 3 per product) and curation | ≥ 5 s |
| `levonis-iq.com` (verification) | the runner | ≤ 4 requests per second |

### J.3 Expected duration

Re-measured after the first 25 products and shown on the dashboard. This is not a promise.

| Stage | Estimate |
|---|---|
| Store page | 1 per product, ≥ 11 s, **strictly after the previous COMPLETE**: 1,115 × 11 s ≈ **3.4 h** of pure spacing |
| Wiki follow, document and tracker checks | ≈ 0.5 wiki link and ≈ 4 HEADs per product on average: **≈ 2 h** |
| Media | ~7.5 gallery images per product (166/22 sampled), plus swatches, in-the-box and description images (≤ 40): 12–16 k ingests at ~1.5–3 s: **6–12 h** |
| Write and finish | ~5–10 s per product: **1.5–3 h** |
| Verification (public v1, site API, knowledge, listings, search, compare, HEADs, browser with selection clicks) | ~15–30 s per product: **4.5–9 h** |
| **Total** | **≈ 17–30 h of job time: 4–6 chained jobs of ≤ 5.5 h** |

### J.4 Queue order (stable, recorded as `queue_position`, reviewed in the manifest)

1. **The canary:** `filament-buffer`. It is new, single-variant, has 4 images, specs, in the box and compatibility text (X1/P1 series), and lands in `@parts-x1p1`.
2. **The audit classes** (§I.4), printers first.
3. **The rest, by type:** printers → AMS → laser machines → filament → hotends and nozzles → build plates → accessories and tools → spare parts → laser and cutting materials → Maker's Supply.
4. Within a type, by sitemap order.
5. **Last:** items with a `hold_code` (`OWNER_HIDDEN`, `ORDER_TYPE_WORD`), so an owner question never holds the rest.

Printers come first so that most compatibility resolves at the subject's own write (§B.6).

### J.5 Chaining jobs

A separate `chain` job (`needs: import`, `permissions: { actions: write }`, no checkout, no `npm`, no repository code) dispatches workflow 60 again when **all** of these hold:

- `needs.import.result == 'success'`;
- `needs.import.outputs.more == 'true'` and `needs.import.outputs.blocked != 'true'`;
- the mode is `run`, the input `chain` is true, `max_items` is `0` (a bounded job is reviewed before the next one; the first step refuses `chain` with any other `max_items`), and `chain_count < 12`.

It dispatches with `mode=run`, the same `run_id` and `seal_pubkey`, and `chain_count + 1`. It builds the request body with `jq` from env values, which it validates again. `GITHUB_TOKEN` may dispatch a `workflow_dispatch` (a documented exception to the no-recursion rule). Because the deadline rules make the import job exit cleanly, a job is not killed by its timeout in normal operation; if it is, the chain stops and the agent resumes by hand. **Nothing is scheduled at any time.** The agent watches each job's log and the dashboard, and stops the chain by not re-dispatching after any anomaly. A chained job never re-arms a run the kill switch stopped (§A.3): its mint step refuses it.

---

## K. Build plan

### K.0 Conventions for every code step

- **Workspace.** Each code step is built in its own local worktree:
  `git worktree add /home/user/levonis-import-<step> -b import/<name> origin/claude/new-session-2hq4ci`.
  The `import/<name>` branch is a local workspace only and is **never pushed**. CLAUDE.md allows no feature branches, merges or pull requests on the remote.
- **Landing.**
  1. `git fetch origin && git rebase origin/claude/new-session-2hq4ci`.
  2. `npm run check` and `npm run test:unit`, both green.
  3. `git push origin HEAD:claude/new-session-2hq4ci` (fast-forward only, never forced).
  4. Follow workflow 7 to green, including "Cost-privacy probes", and check the live site.
- **Every push is a deploy** through workflow 7 (row 184). Prose-only pushes are skipped by workflow 7; a push touching only a workflow file still runs the full CI and redeploys the unchanged Worker.
- Commits end with the session's trailer lines. Each commit is green on its nearby tests plus `npm run check`.
- Migrations are additive (row 237). A migration and the code that needs it may ship in one push; every new read tolerates the table's absence (CLAUDE.md rule 2).
- `EXPECTED_MIGRATION_COUNT` is settled at landing, after 0192 (S-P2) and 0193 (catalog-only).

### K.1 Hard dependencies on `feat/catalog-only` (must be in its C2 push, or workflow 7 goes red)

Once unpriced products are visible, today's probes fail:

- `scripts/live-cost-probes.d/s1.json:3-8` and `leaks.json` take `{slug}` from `/api/products?limit=1`.
- `s1.json:35-56` requires an integer `price_iqd` everywhere in `/api/products?limit=3` and `/api/products/{slug}` (`scripts/live-cost-probes.mjs:18-21`: "every occurrence must be an integer").
- `cleanstart.json` asserts that a not-yet-V2 product is **hidden** (`deploy-staging-code.yml:724-756`).

The first unpriced card at the top of the default listing, or inside a priced product's page body, would turn every later push red. The catalog-only spec mentions no probe file. These items are therefore part of catalog-only's C2 push. The integrator refuses to land C2 without them.

| # | Dependency | Owner | Proof |
|---|---|---|---|
| D-1 | **Probe runner** (`scripts/live-cost-probes.mjs`): a new rule `priceKeys: ["price_iqd"]`, meaning every occurrence is an integer, or `null` only when the same object has `price_status: "unpriced"`; `requirePriceKeys` = the same plus presence; `expectValues: {key: literal}`. **`s1.json`, `leaks.json`:** `{slug}` from the listing filtered by a price range that excludes unpriced products (catalog-only R3; the exact `price=` syntax is `formatPriceRange`, `packages/catalog/src/discovery.ts:74-90`), and `requireIntegerKeys` on mixed answers replaced by `requirePriceKeys`. **`cleanstart.json`** (and the workflow 7 step that fills it): the not-yet-priced product is **visible, unpriced, unsellable**: `/api/products/{unpriced_slug}` → 200 with `expectValues {price_status: "unpriced"}` and `price_iqd` null; `/api/public/v1/products/{unpriced_slug}` → 200. All in one commit. | catalog-only C2 | `tests/liveCostProbes.test.ts` runs **every** probe definition against an in-process fixture catalogue mixing priced and unpriced products (including a priced product whose page body embeds an unpriced related product): all pass. A priced product with a null price fails. |
| D-2 | `catalogOnlyCard` and `publicRelations({catalogOnly:true})` keep `variants[].combo_key`, group and value ids, image bindings (`option_value_id`, `variant_id`, `color_id`), and pass through the 0194 additions when present (group `kind`, `name_ar`, `name_ckb`, `default_value_id`, swatches). | catalog-only C1 | its §7.2 projection tests plus one assertion per key |
| D-3 | `/api/public/v1/context` has `products_priced` (catalog-only §3.5). | catalog-only C2 | its §7.2 |
| D-4 | The price-range filter excludes unpriced products (R3). | catalog-only C2 | its §7.2 |
| D-5 | `validatePriceRequestSelection(db, productId, selection)` exported from `worker/lib/priceRequests.ts`: the pure validation of `POST /api/price-requests` steps 3–6 (§4.3), used by the route and by the import's `/complete`. No row is created. | catalog-only C5 (refactor only) | the route's §7.5 tests unchanged, plus a direct test |
| D-6 | DECISIONS row 240 lands first; the import writes row 241. | catalog-only C9 | — |
| D-7 | The SELLABLE predicate is not changed by the import. The stock gate lives in the V2 write (§B.10). | — | `tests/listingPredicateGuard.test.ts` unchanged by the import |

### K.2 The numbered build plan

```
 1 catalog-only + D-1…D-7 ───────────┐
 2 wf60 snapshot + sealing ──┐       │
                             ▼       ▼
 3 P0 data (sandbox; runs alongside 4–12) ─────────────────────────────┐
 4 schema 0194/0195 + shared package ─► 5 search + stock gate ─► 6 ops ─┤
                                   ├─► 7 customer + admin UI ───────────┤
                                   └─► 8 runner + workflow 60 ──────────┤
                                                                        ▼
                        9 reviewed data ─► 10 dry runs ─► 11 canary ─► 12 audit classes ─► 13 bulk ─► 14 close ─► 15 cleanup
```

Steps 4–8 need step 1 merged into their base only for the catalog-only predicates. Step 4 may start in parallel and rebases onto step 1 before landing. Step 7 must be live before step 11, because the browser checks need the new gallery and tabs.

---

**Step 1 — catalog-only, with the import's dependencies**

| | |
|---|---|
| Branch | `feat/catalog-only` (worktree `/home/user/levonis-catalog`) |
| Base | default tip; rebased after S-P2's 0192 lands |
| Migrations | 0193 |
| Files | per its spec §9, plus D-1 (`scripts/live-cost-probes.mjs`, `scripts/live-cost-probes.d/{s1,leaks,cleanstart}.json`, the workflow 7 step that reads the unpriced slug), D-2, D-5 |
| Tests | its §7, plus `tests/liveCostProbes.test.ts` (fixture catalogue) |
| Deploys | yes: catalog-only goes live |
| Exit | workflow 7 green including "Cost-privacy probes", with at least one visible unpriced product live; `/api/public/v1/context` answers `products_priced`; an unpriced product page answers 200 with `price_status: 'unpriced'` |

**Step 2 — workflow 60 skeleton: `snapshot` and `revoke` modes, sealing**

| | |
|---|---|
| Branch | `import/wf60-snapshot` |
| Base | default tip (independent of step 1) |
| Migrations | none |
| Files | `.github/workflows/bambu-import.yml` (only `snapshot` and `revoke` are implemented; other modes exit 1 "not yet"); `scripts/bambu-import/seal.mjs`, `unseal.mjs`; `scripts/bambu-import/snapshot.sql` (§D.1 SELECTs) |
| Tests | `tests/bambuImportWorkflow.test.ts` (§K.3 shape rules), `tests/bambuSeal.test.ts`, `tests/workflowNaming.test.ts` (the new name) |
| Deploys | workflow 7 runs the full CI and redeploys the unchanged Worker |
| Exit | one dispatch `mode=snapshot seal_pubkey=<one-time key>` is green; the log shows row counts only; the only artifact is `snapshot.sealed`; it unseals in the sandbox |

**Step 3 — P0 data preparation (no push of its own; outputs land in steps 4 and 9)**

| | |
|---|---|
| Where | the agent sandbox, `scratchpad/bambu/p0/`; reads public store pages at ≥ 11 s, the wiki at ≥ 5 s, the CDN at ≥ 1 s; unseals the step 2 snapshot locally |
| Work | (a) crawl the 1,115 product pages, page 1 of each type collection and the sitemaps into a local cache of flight data and description elements only (~3.4 h, background), parsed with the step 4 package as soon as it exists. (b) **`manifest.json`**: id, handle, type, route, `queue_position` (§J.4), `curated`, `hold_code`, `sku_codes` (cross-sell harvest across all pages), plan-size estimate. (c) **Scans**: `variant_key` uniqueness, `availabilityFromName` hits, composite cells, US/region tables, label coverage and the top 50 unknown labels, same-name/different-hash images (the media review list), in-the-box image counts, tracker links, wiki links, plans estimated over 600 statements, collections over 400 rows. (d) **`taxonomy-map.json`**, **`compat-targets.json`**, **`identity-map.json`**, **`media-overrides.json`**, **`search-synonyms.json`**. (e) **`existing-matches.json`** from the unsealed snapshot. (f) The owner questions (§L.2), each with its default. (g) **Curated files**: the canary and the audit classes first, then in queue order (this continues through step 12). |
| Tests | the schema tests land with the files in step 9; the agent runs them locally first |
| Deploys | nothing |
| Exit | 1,115 unique source ids (or the sitemap's current count) and no unmapped route; every leaf ≤ 250; every compatibility label mapped or reviewed-unresolvable; every match candidate decided; no plan near the invocation limit (or a written exception, §A.6); holds listed with their owner question; curated files reviewed for the canary and the audit classes |

**Step 4 — schema and the shared package**

| | |
|---|---|
| Branch | `import/schema` |
| Base | default tip after step 1 and 0192 |
| Migrations | **0194, 0195** |
| Files | `migrations/0194_catalog_knowledge.sql`, `migrations/0195_catalog_import_runs.sql` (with the generated guard triggers), `scripts/gen-import-guard-triggers.mjs`, `worker/lib/catalogImport/protectedTables.ts`, `worker/lib/schemaVersion.ts`, `worker/lib/mediaRefs.ts`, `worker/lib/productDeletion.ts`, `packages/contracts/src/ownership.ts`, `packages/catalog/src/bambuImport/**` (rsc, extract, crossSell, normalize, options, media, describe, sentences, specs, logistics, relations, payload, fingerprint, registry incl. colours), `tests/fixtures/bambu/*` (the 8 samples and a trimmed `filament-buffer.page.html` ≤ 200 KB) |
| Tests | `bambuRsc`, `bambuExtract` (closed read list), `bambuCrossSell`, `bambuOptions` (H2D `Standard`/`standard`, `legacyShapeErrors` passes), `bambuMediaBinding` (§C.4 golden cases), `bambuDescribe`, `bambuSentences` (§C.10 golden sentences), `bambuSpecs` (composite cells on A1 and H2D, region rule, PLA net weight and diameter), `bambuLogistics` (no CBM from multi-box or US-only), `bambuPayloadAllowList`, `catalogImportGuards` (the triggers on `node:sqlite` with all migrations), `catalogImportTransitions` (all 12×12 state pairs), `mediaReferences` (`unclassified = []`), `schemaVersion`, `ownership`, the product-deletion tests |
| Deploys | yes: workflow 7 applies 0194 and 0195; nothing reads them yet |
| Exit | CI green; workflow 7 green with migrate-check `--twice`; the live `d1_migrations` last name is 0195 (read by workflow 7's own check) |

**Step 5 — shared search aliases and the stock gate**

| | |
|---|---|
| Branch | `import/search-stock` |
| Base | default tip after step 4 |
| Migrations | none |
| Files | `worker/lib/search/aliases.ts`, `worker/lib/search/document.ts` (`aliases`), `worker/lib/search/store.ts` (`INDEX_STAMP '#doc:5'`, backfill through the loader), `worker/lib/productPersistence.ts` (loader + `intent.searchAliases`), `worker/lib/pricingEngine/v2/write.ts` (the fence), the stock-decision route and product-form card, refusal strings |
| Tests | `searchAliases`, `fxSweepBudget` (extended), `importStockDecision`, `programmeRefusals`, route class and role matrix |
| Deploys | yes. The stamp bump makes the cron re-index the live catalogue (~45 products, about one tick). Sellability does not change for any existing product. |
| Exit | workflow 7 green; a public search for a known product's name still finds it; `products_priced` in `/context` unchanged by the deploy |

**Step 6 — ops endpoint, writer, knowledge route, admin API**

| | |
|---|---|
| Branch | `import/ops` |
| Base | default tip after step 5 |
| Migrations | none |
| Files | `worker/routes/catalogImportOps.ts`; `worker/lib/catalogImport/{auth,reviewed,writer,doc,budget,unpublish,purge,verifyD1,complete}.ts`; `worker/lib/productSlug.ts` (export refactor of `uniqueProductSlug` + `productSlugFrom`); `postCommitProductSave` refactor; `ingestProductMediaUrl` `allowHost`; `cataloguePaths` + knowledge path; a v1 purge-key helper exported next to `serve` in `worker/routes/publicApi.ts`; `GET /api/products/:slug/knowledge`; `worker/routes/adminCatalogImport.ts`; the deception gate's known routes; `wrangler.jsonc` `rules` (reviewed JSON as Text modules); `data/bambu-import/*.json` as **empty, valid placeholders** (zero manifest rows), so the route is inert; `scripts/live-cost-probes.d/import.json` |
| Tests | `catalogImportAuth` (404 uniformity, expiry, revocation, rate limit, no-store, deception gate, reviewed-scope refusals: an unlisted id at `/manifest`, an unlisted merge, a create for a `merge` source), `catalogImportWriter` (create, merge, colour-model merge, empty-category fill, H2D, fences, guard aborts, fingerprints, invocation budget, all through `LimitD1`), `catalogImportIdempotency`, `catalogImportAllowList`, `catalogImportTranslations`, `catalogImportDoc` (`newImportProductDoc` defaults), `catalogImportUnpublish`, `catalogImportComplete` (D1 recompute; refusal on disagreement; eligibility via D-5), `catalogImportE2E` (in-process: the 8 samples through the real Hono app with the D1 shim, the R2 and IMAGES doubles `tests/fixtures/imageDoubles.ts`, and a fetcher double; fingerprints through the real routes), role matrix and route class, the leak scanner over every customer DTO including `/knowledge` |
| Deploys | yes, inert: no open run, so every ops path is 404 |
| Exit | workflow 7 green including the new `import.json` probe (`GET /api/ops/catalog-import/run/status` → 404); `/api/products/<an existing slug>/knowledge` → 200 and empty |

**Step 7 — customer UI, facets, compare, cards, admin dashboard**

| | |
|---|---|
| Branch | `import/ui` |
| Base | default tip after step 4 (parallel with 5, 6, 8; rebased before landing) |
| Migrations | none |
| Files | `src/pages/Product.tsx`, `src/lib/productGallery.ts`, `ProductKnowledgeTabs` (lazy), swatch chips, default preselection, `ProductCard` key line, the card projection's `key_specs` / `section_name`, `worker/lib/compareSpecs.ts`, `packages/catalog/src/discovery.ts` (`FACET_FIELDS`), `worker/lib/listingFacets.ts`, `templateFamilies.ts` (`product_family`, `spool_type`), `src/components/adminImport/CatalogImportDashboard.tsx`, the information-completeness column and card (and their server query), all strings ar/en/ckb |
| Tests | `productGallerySelection` (H2C → FAP035, H2D → FAP025, H2D AMS Combo, A1 Standard), `bundleBudget` (measured numbers in the commit message), `claySystem`, i18n coverage (ar/en/ckb, no ckb = ar), `d1Waves`, compare tests, facet tests, a Playwright local e2e on fixture data |
| Deploys | yes. Nothing new renders until data exists, except the gallery order fix, which applies to every product; the tests prove an unbound gallery is unchanged. |
| Exit | bundle numbers recorded; local screenshots in ar, en and ckb, phone and desktop, light and dark; workflow 7 green |

**Step 8 — the runner and workflow 60 in full**

| | |
|---|---|
| Branch | `import/runner` |
| Base | default tip after step 4 (parallel with 6 and 7) |
| Migrations | none |
| Files | `scripts/bambu-import/{run,discover,fetch,robots,enrich,wiki,tracker,log,summary,verify,browser,deadline,opsClient,match-candidates}.ts`; `.github/workflows/bambu-import.yml` with every mode (§K.3); `scripts/e2e-bambu-import.mjs` |
| Tests | `catalogImportLogs` (planted hidden names, slugs, SKUs, inactive catalogs, `source_url`, `canonical_url`, token: none in the log, the summary or any unsealed file), `bambuImportRunner` (against a fake ops server with a fake clock: retries, BLOCKED stops the loop, resume, the deadline rules, `/write` never started with < 13 min left, EXTRACT never before the previous COMPLETE, the chain outputs), `bambuImportWorkflow` (extended), `workflowNaming` |
| Deploys | workflow 7 runs; the Worker is unchanged |
| Exit | tests green; `mode=dryrun` is dispatchable |

**Step 9 — the reviewed data**

| | |
|---|---|
| Branch | `import/data` |
| Base | default tip after steps 6 and 8 |
| Migrations | none |
| Files | `data/bambu-import/{manifest,taxonomy-map,existing-matches,compat-targets,identity-map,media-overrides,search-synonyms}.json`, `data/bambu-import/curated/*.json`, `data/bambu-import/curated/index.json` |
| Tests | `catalogImportTaxonomy` (every route resolves, leaf ≤ 250, overrides cite route and quote), `catalogImportReviewedFiles` (schemas; `reason` and `decision` enums; no free-text key; a slug only on active entries as recorded at review; every compatibility label of the manifest covered), `catalogImportCurated` (schema, locator/quote, `not_published` covered by `searched`, consistency with the parsed page, agreement figures present), `catalogImportReviewedSha` (the Worker's bundled SHA-256s equal the files) |
| Deploys | yes: the bundled files change the Worker. Later curated additions are data-only pushes of the same kind. |
| Exit | workflow 7 green; the curated index covers the canary and the audit classes |

**Step 10 — dry runs**

| | |
|---|---|
| (a) In-process | `tests/catalogImportE2E.test.ts`, already in CI since step 6 |
| (b) Local workerd | in the sandbox: `npm run build`, then `node scripts/e2e-bambu-import.mjs` → `wrangler dev --local` with a fresh `--persist-to`, all migrations, the seed (the seeded catalog ids, the map's nodes, an existing "A1" priced with `publishV2`), a run row with a token hash, then the importer for `filament-buffer`, `bambu-hotend-a1-a2` and `pla-basic-filament` from fixture pages; images through a fetcher double if workerd cannot reach the CDN; Playwright §I.1.7 in ar/en/ckb, phone/desktop, light/dark. Any request to a host other than 127.0.0.1 is aborted and counted (the `e2e-pricing-v2-clean-start.mjs` pattern). |
| (c) Workflow | workflow 60 `mode=dryrun`: the same as (b) on the runner, with real `store.bblcdn.com` images (~60 at ≥ 1 s), no Cloudflare credential referenced, screenshots sealed |
| Exit | 3/3 COMPLETE in (b) and (c); a full re-run writes zero rows; the kill-at-each-stage resume test passes; guard hits 0; the agent has reviewed the screenshots |

**Step 11 — production preflight, open, canary**

| | |
|---|---|
| Run | (1) `mode=preflight`: no write; the live `d1_migrations` count and last name equal the code; the public `/api/public/v1/context` carries `products_priced` (catalog-only is live); no CSV import lease (`product_imports` with an unexpired `apply_lease_until`); no active run; the Time Travel bookmark printed. (2) `mode=open confirm=IMPORT-LIVE`: creates the run (`cir_` + 24 hex), mints a token, `/hello` (protocol, reviewed SHA-256s), `/manifest` (all rows), `/run/prepare-taxonomy` (nodes, brand, synonyms), `/run/protect-snapshot before`, revoke; then `mode=snapshot` to confirm the nodes (sealed). (3) `mode=run run_id=… max_items=1 confirm=IMPORT-LIVE`: the canary `filament-buffer`. |
| Exit | the canary is COMPLETE and the §K.4 review is green; the next workflow 7 run is green, probes included |

**Step 12 — the audit classes**

| | |
|---|---|
| Run | `mode=run max_items=1` for each audit-class product in queue order (§I.4), each followed by the §K.4 review. The first merge, if any, gets its own stop and an owner-visible note. |
| Exit | every audit-class product COMPLETE with its extra assertions; L-7 and L-17 answered or their defaults recorded |

**Step 13 — the bulk**

| | |
|---|---|
| Precondition | the curated index covers the whole curated scope |
| Run | `mode=run max_items=0 chain=true`. The agent reads each job's log and the dashboard, and every 100 items unseals and reviews the 1-in-25 screenshots. On a BLOCKED item: fix the cause with a code or data commit (which deploys through workflow 7), then `mode=run resume=true`. |
| Exit | no DISCOVERED, in-flight or RETRYING item remains except the end-of-queue holds; every BLOCKED item is a hold or a withdrawal with evidence |

**Step 14 — close**

| | |
|---|---|
| Run | `mode=close confirm=IMPORT-LIVE`: §I.3, then `/run/finish`, then the sealed report. Then a prose-only commit: DECISIONS row 241 status and commit hashes, `docs/HANDOFF.md`. |
| Exit | the run is `closed`, or `partial` with every remaining item named; the old token gets 404; the crons are unchanged; the report is reviewed |

**Step 15 — cleanup (later, L-15)**

| | |
|---|---|
| Branch | `import/cleanup` |
| Files | remove `catalogImportOps.ts`, workflow 60 and the bundled reviewed files; move `catalog_import_media.r2_key` to `NON_MEDIA_COLUMNS` after a sweep grace; keep the tables and the knowledge model |
| Deploys | yes |
| Exit | workflow 7 green; staged-only media swept by the existing cleanup |

### K.3 Workflow 60 (sketch)

```yaml
name: 60 - Bambu one-time import (writes live D1/R2 catalogue, no deployment)
on:
  workflow_dispatch:
    inputs:
      mode:        { type: choice, required: true, options: [snapshot, preflight, open, run, close, report, dryrun, withdraw, revoke] }
      run_id:      { description: 'catalog_import_runs.id', default: '' }
      max_items:   { description: '0 = until the deadline', default: '1' }
      resume:      { type: boolean, default: false }
      chain:       { type: boolean, default: false }
      chain_count: { default: '0' }
      item:        { description: 'source product id (withdraw only)', default: '' }
      seal_pubkey: { description: 'one-time X25519 public key that seals every artifact', required: true }
      confirm:     { description: 'IMPORT-LIVE for open/run/close/withdraw', default: '' }
permissions: { contents: read }
concurrency:                # the kill switch (revoke) has a group of its own: it runs AT ONCE, beside a running import
  group: ${{ inputs.mode == 'revoke' && format('bambu-import-revoke-{0}', github.run_id) || 'bambu-import' }}
  cancel-in-progress: false
jobs:
  import:
    if: ${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}
    runs-on: ubuntu-latest
    timeout-minutes: 350
    permissions: { contents: read }
    outputs: { more: ${{ steps.run.outputs.more }}, blocked: ${{ steps.run.outputs.blocked }}, run_id: ${{ steps.run.outputs.run_id }} }
    env:                       # inputs reach shell ONLY through env; never ${{ inputs.* }} inside run:
      IN_MODE: ${{ inputs.mode }}
      IN_RUN_ID: ${{ inputs.run_id }}
      IN_MAX_ITEMS: ${{ inputs.max_items }}
      IN_CHAIN_COUNT: ${{ inputs.chain_count }}
      IN_ITEM: ${{ inputs.item }}
      IN_SEAL_PUBKEY: ${{ inputs.seal_pubkey }}
      IN_CONFIRM: ${{ inputs.confirm }}
    steps:
      - name: Deadline and input validation
        run: |
          echo "DEADLINE_EPOCH=$(( $(date +%s) + 330*60 ))" >> "$GITHUB_ENV"
          [[ "$IN_MODE" =~ ^(snapshot|preflight|open|run|close|report|dryrun|withdraw|revoke)$ ]] || exit 1
          [[ -z "$IN_RUN_ID" || "$IN_RUN_ID" =~ ^cir_[0-9a-f]{24}$ ]] || exit 1
          [[ "$IN_MAX_ITEMS" =~ ^[0-9]{1,4}$ ]] && [[ "$IN_CHAIN_COUNT" =~ ^([0-9]|1[0-2])$ ]] || exit 1
          [[ -z "$IN_ITEM" || "$IN_ITEM" =~ ^[0-9]{1,20}$ ]] && [[ "$IN_SEAL_PUBKEY" =~ ^[A-Za-z0-9_-]{43}$ ]] || exit 1
          case "$IN_MODE" in open|run|close|withdraw) [[ "$IN_CONFIRM" == "IMPORT-LIVE" ]] || exit 1;; esac
      - uses: actions/checkout@<pinned sha>
        with: { persist-credentials: false }
      - uses: actions/setup-node@<pinned sha>
        with: { node-version: 22 }
      - run: npm ci                                   # no Cloudflare or import credential exists in this step's env
      - if: env.IN_MODE == 'run' || env.IN_MODE == 'dryrun'
        run: npx playwright install --with-deps chromium
      - name: Live database id (masked), preflight, Time Travel bookmark     # not in dryrun
        env: { CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}, CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }} }
        run: node scripts/bambu-import/cf.mjs preflight      # wrangler only; prints counts, names of migrations, the bookmark
      - name: Snapshot, sealed in the same step          # snapshot mode only
        env: { CLOUDFLARE_API_TOKEN: …, CLOUDFLARE_ACCOUNT_ID: … }
        run: node scripts/bambu-import/cf.mjs snapshot --seal "$IN_SEAL_PUBKEY" --out "$RUNNER_TEMP/out"
      - name: Mint the job token (0600 file; hash stored on the run row)    # open/run/close/withdraw
        env: { CLOUDFLARE_API_TOKEN: …, CLOUDFLARE_ACCOUNT_ID: … }
        run: node scripts/bambu-import/cf.mjs mint --run "$IN_RUN_ID" --chain-count "$IN_CHAIN_COUNT" --token-file "$RUNNER_TEMP/import-token"
      - id: run
        name: Importer                                  # reads and deletes the token file at start; no Cloudflare env
        env: { IMPORT_TOKEN_FILE: '${{ runner.temp }}/import-token' }
        run: node --import tsx scripts/bambu-import/run.ts
      - if: always()
        name: Revoke
        env: { CLOUDFLARE_API_TOKEN: …, CLOUDFLARE_ACCOUNT_ID: … }
        run: node scripts/bambu-import/cf.mjs revoke --run "$IN_RUN_ID"
      - if: always()
        uses: actions/upload-artifact@<pinned sha>
        with: { name: bambu-import-sealed, path: '${{ runner.temp }}/out/*.sealed', retention-days: 3 }
  chain:
    needs: import
    if: ${{ needs.import.result == 'success' && needs.import.outputs.more == 'true' && needs.import.outputs.blocked != 'true'
            && inputs.mode == 'run' && inputs.chain && inputs.max_items == '0' && fromJSON(inputs.chain_count) < 12 }}
    runs-on: ubuntu-latest
    permissions: { actions: write }
    steps:                     # no checkout, no npm, no repository code
      - env: { GH_TOKEN: ${{ github.token }}, RUN_ID: ${{ needs.import.outputs.run_id }}, COUNT: ${{ inputs.chain_count }},
               KEY: ${{ inputs.seal_pubkey }}, REPO: ${{ github.repository }}, REF: ${{ github.ref_name }} }
        run: |
          [[ "$RUN_ID" =~ ^cir_[0-9a-f]{24}$ && "$COUNT" =~ ^([0-9]|1[01])$ && "$KEY" =~ ^[A-Za-z0-9_-]{43}$ ]] || exit 1
          body=$(jq -n --arg ref "$REF" --arg run "$RUN_ID" --arg c "$((COUNT+1))" --arg k "$KEY" \
            '{ref:$ref, inputs:{mode:"run", run_id:$run, max_items:"0", chain:"true", chain_count:$c, seal_pubkey:$k, confirm:"IMPORT-LIVE"}}')
          curl -fsS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/$REPO/actions/workflows/bambu-import.yml/dispatches" -d "$body"
```

`scripts/bambu-import/cf.mjs` is the only code that runs with Cloudflare credentials. It runs `wrangler d1 execute` with SQL built only from validated values, and prints counts, migration names and the bookmark.

**`tests/bambuImportWorkflow.test.ts`** asserts the shape:

- top-level `permissions` is `contents: read`; the `import` job has no `actions: write`;
- the `chain` job has `actions: write`, no checkout, no `npm` and no repository script;
- every checkout has `persist-credentials: false`;
- `CLOUDFLARE_*` appear only in step-level `env` of steps that run `scripts/bambu-import/cf.mjs`;
- the token reaches only the importer step, through a file, never `GITHUB_ENV` or job-level `env`;
- no `${{ inputs.` or `${{ github.event.inputs.` appears inside any `run:`;
- every input is validated by the first step with the listed patterns;
- every `upload-artifact` path ends in `.sealed`;
- the concurrency group is set (`bambu-import` for every mode but `revoke`, whose group is its own so the kill switch never waits behind the job it stops), `timeout-minutes` is 350, and the deadline is 330.

### K.4 The review after each canary and audit-class product

No further item is started until every line is green:

1. The live page in ar, en and ckb, phone and desktop, light and dark: the sealed Playwright screenshots plus a direct look.
2. The default selection, every value's hero image and the absence of contradicting images.
3. The category and subcategory listings, search (title, model code, colour/part code), compare, the facets.
4. The knowledge tabs: Specifications, Materials & printing, Packaging & Shipping with In the box, Compatibility, Documents, with the status labels and sources.
5. The price-request door (signed out → the sign-in sheet), the Worker's eligibility result, and the live request if L-17 allows.
6. The dashboard item: `d1_checks` next to `edge_evidence`; the report row.
7. For a merge: the per-write fingerprint flag, V2 status unchanged.
8. Workflow 7's next run green, probes included.

### K.5 DECISIONS row 241 (Arabic; appended after row 240 by the implementer, with commit hashes)

> | 241 | **استيراد Bambu Lab لمرة واحدة — التنفيذ (الترحيلان `0194_catalog_knowledge.sql` و`0195_catalog_import_runs.sql`؛ سير العمل 60)** — الكتابة في الإنتاج تتم عبر العامل وحده من خلال باب تشغيل محمي برمز لكل مهمة (يُخزَّن تجزيئه فقط، وينتهي بانتهاء المهمة، ويُلغى في نهايتها)، وبمسار الحفظ نفسه للمنتج (`planProductSave`) في دفعة ذرية واحدة تحمل نقطة التحقق. **النطاق المراجَع يفرضه العامل**: قائمة المنتجات، وخريطة الأقسام، ومطابقات المنتجات القديمة، وأهداف التوافق، مضمّنة في العامل ومتحقق من بصمتها، فلا يُكتب منتج أو دمج خارجها. منتج واحد في كل لحظة يفرضه فهرس فريد ومحفّز يمنع أي انتقال غير مشروع بين الحالات، والعائق يوقف الطابور، ولا يُحسب المنتج مكتملاً إلا بأدلة من الموقع العام يعيد العامل حساب جانب القاعدة منها بنفسه. لا سعر ولا تكلفة ولا مخزون ولا أبعاد شحن تسعيرية ولا عروض ولا سياسة شحن أمريكية من المصدر، ونصوص ضمان الشركة المصنّعة لا تُعرض كضمان Levonis. **المنتج المستورد يُسجَّل «مخزونه غير مضبوط»، ولا يقبل نشر تسعير V2 له حتى يختار المالك تتبّع الكمية أو «بلا تتبّع حسب الطلب»** (شرط على النشر وحده؛ حسابات V2 وقواعدها لم تتغير). الألوان قيم خيار بصورتها الرسمية، ولا لون HEX إلا إذا نشرته الشركة؛ وكل صورة يربطها المصدر بخيار تُربط به، ولا تظهر صورة خيار آخر عند اختيار خيار. المواصفات المصنّفة مع مصدر كل حقل وموضعه ونصه المقتبس وحالته (مؤكد/غير مؤكد/غير موجود في المصادر التي رُوجعت/لم تنشره الشركة/لا ينطبق/غير معروف)، وجداول المتجر الأمريكي تُسجَّل «النسخة الأمريكية 110 فولت» غير مؤكدة. لا يخرج من سجلات GitHub العامة إلا أعداد ورموز وروابط عامة، وكل ملف ناتج مختوم بمفتاح لمرة واحدة. لا مزامنة بعد الانتهاء. | قيد التنفيذ | … |

---

## L. Risks and the owner decisions still open (each with a safe default; nothing blocks on them)

### L.1 Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | The store challenges GitHub runner IPs (bambulab.com already does) | BLOCKED `ACCESS_CHALLENGE`, never bypassed. Fallback: EXTRACT from another legitimate egress the owner approves, or a feed from Bambu (the permission holder). Discovery already showed 46/46 OK from the sandbox. |
| R-2 | The source changes mid-run (new handles, rotated image ids) | A fresh fetch at EXTRACT, fingerprint compared and logged; the end-of-run sitemap diff; new handles need a reviewed manifest commit; COMPLETE products are not re-synced (R11). |
| R-3 | D1 limits on big products | The whole-invocation budget (§A.5) measured at `/stage`; `PLAN_TOO_LARGE` / `ROW_CAP` blockers; P0 measures every plan in advance. No staged path. |
| R-4 | IMAGES conversion failures (`.media` multipart swatches, huge PNGs) | Byte sniffing; the CDN-resized fallback; an optional image fails softly while the primary blocks. |
| R-5 | A deploy mid-run changes the endpoint | Protocol and reviewed SHA-256s checked by `/hello` at every job and every 50 items; calls are idempotent. |
| R-6 | Public logs or artifacts leak something | Allow-list logger; sealed artifacts; committed files without private data; the planted-value log test. |
| R-7 | The media sweeper deletes staged objects during a long block | 7-day grace, the `catalog_import_media.r2_key` reference source, re-verification before write. |
| R-8 | The 300-candidate listing cap hides older imports | `leaf_limit` 250 enforced by test; spare parts split by family. |
| R-9 | 1,115 unpriced products crowd the storefront | Catalog-only R1–R4 (priced first, sellable-only home shelves, ≤ 5 of 20 new arrivals). |
| R-10 | A merge marks a V2-published product stale | The §E.3 tests on a published fixture; merges run as separate canaries. |
| R-11 | The translation review backlog (~1,100 products × several slots) | Honest `review_needed`; English fallback; the existing review tooling. |
| R-12 | Category counts and tree cache stale in other colos | Purge in the verifying colo; others age out within 300 s. Accepted. |
| R-13 | Wrong compatibility | Evidence-only relations; the reviewed `compat-targets.json`; unresolvable labels kept as text; curated review for plates and hotends. |
| R-14 | Storage growth | ≈ 13 k WebP × ~150 KB ≈ 2 GB R2; ≈ 45 k spec values, 100 k search tokens, 16 k image rows in D1. Within limits. |
| R-15 | Completeness sweep load | Each write recomputes its own product; the sweep's 60 per tick catches the rest. |
| R-16 | A job killed by its timeout mid-item | The absolute deadline (§A.7); `/write` only with ≥ 13 min left; the chain stops on a non-success, and the agent resumes by hand. |
| R-17 | Workflow 7 turns red once unpriced products are visible | D-1 lands with catalog-only C2 and is proven against a mixed fixture catalogue (§K.1). |
| R-18 | The re-index after the `INDEX_STAMP` bump loads the cron | ~45 products today, at 50 per tick; budget test extended (§C.1). |
| R-19 | An owner question holds part of the catalogue | Holds are known in P0 and queued last; the run closes "partial" and names them. |

### L.2 Open owner decisions (the safe default is in effect until the owner answers)

| # | Question | Safe default |
|---|---|---|
| L-1 | Show a colour HEX when Bambu does not publish one? | No. Official swatch image only; hex only when published. |
| L-2 | Description-image cap per product | 40, extras listed in the report (in-the-box images are separate, ≤ 30). |
| L-3 | Re-host PDFs (TDS/SDS/manuals) in R2? | No. Verified links to the official URLs; dead links hidden and reported. |
| L-4 | Show package CBM to customers? | No. Admin-only. Dimensions and weights are shown. |
| L-5 | Arabic display names for products? | No. The English official name in all languages (§19). |
| L-6 | Add missing Bambu variants to an existing Levonis product? | No. Logged as `variant_not_merged`. |
| L-7 | For each owner-hidden Levonis product that matches a Bambu product: publish it with the merge, or leave it hidden and create the Bambu product as new? | Neither until answered: the item is queued last (`hold_owner_hidden`), blocks at its turn as `OWNER_HIDDEN`, and the run reports "partial". |
| L-8 | Refurbished printers placement | Their own leaf «طابعات مجدَّدة من المصنع», not «المستعمل». |
| L-9 | Bambu bundles and starter kits | Ordinary products with a secondary «الحزم والمجموعات» membership; contents as text. |
| L-10 | A product withdrawn at the source mid-run | BLOCKED `SOURCE_WITHDRAWN`. With two-fetch evidence the owner may approve `WITHDRAWN_AT_SOURCE` (never COMPLETE); the run then closes "partial". |
| L-11 | Marketing collections as tags | Ignored (US commerce state). |
| L-12 | Source URLs visible to staff (non-owner admins) | Owner-only, like `source_url` today. |
| L-13 | Third-party technical sources | Not used. |
| L-14 | Adopt documented package measures into Pricing V2 inputs | No automatic adoption; a later admin action. |
| L-15 | Remove the ops route and workflow 60 after the run | Keep both until a later cleanup commit (§K step 15). |
| L-16 | Refuse the V2 publish of an imported product until its stock mode is chosen | Yes (on). |
| L-17 | A dedicated customer test account (two GitHub secrets) for real signed-in price requests on the canary and audit classes | Not created: eligibility is proven per product by the Worker's validator, and the report says that no live request was sent. |
| L-18 | An option value whose name reads as an order type («Pre-order», «Direct…») | Queued last and blocked as `ORDER_TYPE_WORD` (none in the 8 fixtures). The alternative is a narrow, tested exemption in `legacyShapeErrors` for import-created values with a `bv-` key. |
| L-19 | Show Bambu's warranty sentences to customers, labelled «معلومة ضمان من الشركة المصنّعة — ليست ضمان Levonis»? | No. Owner-only spec rows. |
| L-20 | Show US 110 V table values to customers? | Only under the collapsed «إصدارات أخرى» with the US label; 220 V and region-free values first. |
| L-21 | Follow up to 3 Bambu wiki links per product during the run? | Yes, at ≥ 5 s spacing. |

---

## M. R1–R15 compliance matrix

| Rule | Met by |
|---|---|
| R1 every product, sold-out included, no skip | The sitemap manifest (1,115) enforced by the Worker, plus the end-of-run re-check (§I.3). No SKIP state; WITHDRAWN_AT_SOURCE needs evidence and the owner, and is never COMPLETE. Sold-out is ignored (§C.9). |
| R2 one product per cycle, strict sequence | `ux_cii_inflight`, the transition trigger, the lease and fence, COMPLETE only after verification, and EXTRACT of N+1 only after N's COMPLETE (§A, §B.3, §J.1). |
| R3 retry, diagnose, BLOCKED stops | §B.5 transient/permanent classes; deadline-aware retries; optional data never blocks. |
| R4 visible unpriced with «السعر غير متوفر حالياً» and «طلب السعر» | catalog-only (0193) live first; verified per product (§I.1.1/2/5/7/10). |
| R5 no supplier commerce data | The three-layer allow-list, the sentence classifier, and the DB guard triggers (§C.10, §B.4). |
| R6 image, option and colour accuracy first | §C.4 binding with representative and content-duplicate rules; the contradiction filter and rank-then-dedupe gallery; golden tests; browser checks of the hero and the absence of other values' images (§G.3, §I.1.7). |
| R7 category and subcategory, multi-membership, tree preserved | The reviewed map, insert-only nodes, evidence-backed overrides, `product_catalogs` (§D). |
| R8 publish only after identity, media, specs, taxonomy and URL checks | `/stage` and `/write` validation within the reviewed scope, then §I.1 before COMPLETE; a created product that fails after WRITTEN is unpublished (§A.10). |
| R9 no financial or inventory change | Guard triggers, per-write fingerprints, the run snapshot (§E.4), and the stock gate (§B.10). |
| R10 coverage audit before "done" | §I.3, §H.3; the "partial" wording rule. |
| R11 no sync | Dispatch-only; the run is closed and the token revoked; no cron or webhook; tested (§A.9). |
| R12 check, save, then publish at once; no partial records | One atomic batch with `status = 'active'`; no staged path (§A.5/6). |
| R13 separate catalog visibility from purchasability | catalog-only's VISIBLE/SELLABLE split, plus the stock decision before a V2 publish (§B.10). |
| R14 traceable data, no invention | `product_spec_values` with source, locator, excerpt, region and checked sources; relations with evidence; documents with source; curated quotes (§B, §C.6, §F). |
| R15 per-variant accuracy (colours, Spool/Refill, combos) | Real variants only; explicit `variant_key`s; colour-level and variant-level images; composite cells scoped to versions; variant-scoped specs (§C.2–C.6). |

---

## N. Review findings: fixed and refuted

42 findings were reviewed. 38 are fixed as proposed or with a stronger fix. 4 (findings 4, 11, 19 and 32) are fixed, except for one proposed detail each, which is refuted below. Nothing was dismissed outright.

| # | Sev. | Finding | Verdict | Where |
|---|---|---|---|---|
| 1 | high | Private catalogue data published through artifacts and committed files | Fixed: every artifact sealed to a one-time X25519 key; the snapshot and candidates never leave the sandbox in clear; committed files carry ids, public slugs, decisions and reason codes only; the planted-value log test | §A.8, §D.1, §E.1, §H.3 |
| 2 | high | Workflow 7 probes fail once unpriced products are visible | Fixed: D-1 (`priceKeys` rule, slug from a priced-only listing, `cleanstart.json` inverted, a mixed-catalogue CI test) required in catalog-only's C2 push | §K.1 |
| 3 | medium | Structural checks impossible against the public v1 DTO | Fixed: v1 for presence; the anonymous site API and `/knowledge` for structure; fingerprint over those two answers, tested through the real routes | §I.1.1–2 |
| 4 | medium | The job token could write outside the reviewed scope | Fixed: manifest, matches, compatibility targets, identity, media overrides, synonyms and curated index bundled and SHA-checked; `/manifest`, `/stage` and `/write` refuse anything else; tests in `catalogImportAuth` and `catalogImportWriter`. **Partly refuted:** a create is not refused for `not_bambu` (below) | §A.3, §E.1 |
| 5 | medium | The staged path cannot shrink the batch; the 850 cap ignores the rest of the invocation | Fixed: staged path removed (`PLAN_TOO_LARGE`); whole-invocation budget of 900 with a counting proxy; `LimitD1` in the writer tests; fingerprints read one table per statement | §A.5, §A.6 |
| 6 | medium | Workflow 60 exposes the Cloudflare token and `actions: write` | Fixed: step-level Cloudflare env only in `cf.mjs` steps; `persist-credentials: false`; `contents: read`; the token through a file to the importer step only; a separate chain job; a shape test | §K.3 |
| 7 | medium | Search aliases lost on backfill and on the first admin save | Fixed: one shared alias loader used by both writers; `INDEX_STAMP` bump; budget test; an admin-save and backfill test | §C.1, §B.9 |
| 8 | medium | Retry waits not bounded by the job deadline | Fixed: absolute deadline, worst-case table, release-and-exit with `more=true`, `/write` only with ≥ 13 min left; fake-clock tests | §A.7 |
| 9 | medium | `stock = NULL` means untracked, so pricing makes the product orderable without limit | Fixed: `stock_decision 'not_configured'`; a fence in the V2 write; the owner's stock-mode action; tests; row 241; L-16 | §B.10 |
| 10 | low | Four new columns missing from `NON_MEDIA_COLUMNS` | Fixed: the scanner was run over the final DDL on `node:sqlite`; the list is now exactly its output (including `discovered_at`, which also matches) | §B.9 |
| 11 | low | The scrubber deletes technical sentences | Fixed (keyword branch limited to currency forms; golden tests keep the plate sentences). **Partly refuted:** "Save on officially refurbished Bambu Lab H2D." is a promotion, not a technical instruction, and is still removed, by the promotion class finding 27 asks for | §C.10 |
| 12 | low | L-10's withdrawn outcome has no state | Fixed: terminal `WITHDRAWN_AT_SOURCE` in 0195's CHECK, outside the in-flight index, with evidence and owner approval, never COMPLETE | §B.3, §L.2 |
| 13 | low | A product failing verification stays public | Fixed: a created product that blocks after WRITTEN is unpublished in the same call and republished at resume; merged products never | §A.10 |
| 14 | low | `parseProductBody`, an exported `uniqueProductSlug` and `asciiSlug` do not exist | Fixed: `newImportProductDoc` on `validateProductDoc({…, price_iqd: 0})`; `uniqueProductSlug` and `productSlugFrom` moved to `worker/lib/productSlug.ts` with no behaviour change | §A.4 |
| 15 | low | Preflight cannot call `/hello` | Fixed: preflight reads `products_priced` and `d1_migrations`; `/hello` only after `mode=open` | §A.3, §K step 11 |
| 16 | low | Dispatch inputs injectable into shell and SQL | Fixed: inputs only through env, validated by pattern first; SQL built from validated values in `cf.mjs`; the chain job re-validates; a shape test | §K.3 |
| 17 | low | `/publish-finish` does not purge v1 answers | Fixed: `/api/public/v1/products/<slug>` and `/sections/<leaf>` purged with the same canonical key and epoch | §A.3 |
| 18 | high | H2D `Standard`/`standard` collide on `variant_key` | Fixed: an explicit `bv-` key and label on every value; an H2D writer test; a P0 scan for `availabilityFromName` hits (hold `ORDER_TYPE_WORD`, L-18) | §A.4, §B.8, §C.2 |
| 19 | high | Other options' images shown for an explicit selection | Fixed: every source-tied image bound (primary included); content-duplicate inheritance; a reviewed override list; the client drops contradicting images; the browser asserts no other value's image. **Partly refuted:** the proposed "coarser group" rule does not fix H2DC, because `H2D AMS Combo` has three variants; H2DC is variant-bound and also the representative image of `H2D AMS Combo` | §C.4, §G.3, §I.1.7 |
| 20 | high | Rule 2 contradicts its own examples; the regression test passes on buggy code | Fixed: rule 2 removed; examples and golden tests aligned; the tests are now H2C → FAP035 and H2D → FAP025, which fail before the `Product.tsx` fix | §C.4, §G.3 |
| 21 | high | The US 110 V H2D table imported as verified | Fixed: the region rule (`us_110v` unverified, enforced by a CHECK), 220 V values from the page's messages for curated printers, voltage bullets dropped, no CBM from a US-only box, an h2d golden test | §C.6, §B.7, §1 row 21 |
| 22 | high | Composite cells cannot be represented; gross weight conflated | Fixed: the labelled sub-value parser with version scoping; `shipment.gross_weight`; `physical.recommended_space`; no CBM for multi-box or mixed scope; a1 and h2d golden tests | §B.7, §C.6 |
| 23 | medium | «لم تنشره الشركة المصنّعة» asserted without searching | Fixed: `not_found` with `checked_sources` and the label «غير متوفر في المصادر التي رُوجعت»; `not_published` only for curated products whose documents were searched (CHECK); up to 3 wiki links followed and recorded only when parsed (L-21) | §B.2, §C.6, §G.2 |
| 24 | medium | Nothing gates an item on its curated file; no threshold | Fixed: `curated` in the manifest; `CURATION_PENDING` → `CURATION_MISSING`; the bulk starts only with the full curated index; a 2 % disagreement threshold extends the second extraction to 100 % of the class; locator and quote in D1 | §F, §B.5, §K step 13 |
| 25 | medium | PLA "Size 1kg" mislabelled; feature bullets unparsed | Fixed: weight-valued Size → `net_weight` group and `material.net_weight`; `Label: value` bullets through the registry; compatibility bullet and refill note as relations; a PLA golden test | §C.2, §C.5, §C.6 |
| 26 | medium | No locator or excerpt per measurement | Fixed: `source_locator` and `source_excerpt` in 0194, filled from curated page/quote and the parser's path; a CHECK on verified TDS/SDS/manual numbers | §B.2, §C.6, §F |
| 27 | medium | Warranty, US shipping policy and promotions reach customers | Fixed: the sentence classifier (money, promotion, shipping policy, warranty withheld as owner-only, region); tests on the four samples; L-19 | §C.10 |
| 28 | medium | No targets for non-printer compatibility or for Levonis's own X1/P1 printers | Fixed: `compat-targets.json` (printers, AMS family, hubs, buffers, laser modules, toolheads, spools; manifest handles, families or existing Levonis ids); only printer targets mirrored to fits; the feeder → AMS 2 Pro audit assertion | §B.6, §I.4 |
| 29 | medium | No transition guard; COMPLETE self-attested | Fixed: `trg_cii_transition` and `trg_cii_stage_monotonic` (tested on `node:sqlite`); the Worker recomputes D1 facts and refuses on disagreement | §B.3, §I.1.10 |
| 30 | medium | The page fetch overlaps the previous product | Fixed: overlap deleted; the next page only after the COMPLETE commit, asserted against the event sequence; the estimate re-stated (17–30 h) | §J.1, §J.3 |
| 31 | medium | Withdrawn and owner-hidden outcomes have no terminal state | Fixed: `WITHDRAWN_AT_SOURCE`; L-7 settled per product in the matches file (`merge_publish`, `distinct`, `not_bambu`) or held last as `OWNER_HIDDEN`; no admin-side COMPLETE | §B.3, §E.2 |
| 32 | medium | The price-request check proves nothing about the product | Fixed: the Worker runs catalog-only's own validator per product and selection (D-5); live requests on the canary and audit classes, withdrawn after a queue-order check, if L-17 provides an account. **Partly refuted:** a real signed-in request on production needs a customer credential the repository does not have, so it is the owner's decision | §I.1.5/10, §K.1 |
| 33 | medium | Family/series/model, colour and spool filters, ar/ckb synonyms and compare missing | Fixed: identity keys and map; `product_family` and `spool_type` facets; multi-valued colour facet with an authored base-colour list; synonyms; compare from `product_spec_values` in scope; a compare check per product | §C.1, §G.5, §I.1.11 |
| 34 | medium | No card key specs, no Materials tab, no information completeness | Fixed: `key_specs` and `section_name` on cards (measured, with a recorded fallback); the Materials & printing tab; the type-aware completeness column and card | §G.2, §G.5, §H.2 |
| 35 | low | In-the-box images lost | Fixed: items `{text, qty, media_key}`; role `in_the_box` outside the 40 cap; `value_list` registered as a media source; an a1 golden test | §C.5, §B.9 |
| 36 | low | The feeder unit's tracker link lost | Fixed: one HEAD without following, `Location` kept only for allow-listed hosts, `tracker_source` stored; never bypassed | §C.5 |
| 37 | low | The canary's override misfiles it | Fixed: override removed (the route resolves to `@parts-x1p1`); overrides must cite route and quote, checked by test | §D.2 |
| 38 | low | SKU harvest breaches the closed read list | Fixed: `crossSell.ts`, a proven-narrow reader; harvested in P0 across all pages and frozen in the manifest | §C.1, §C.10 |
| 39 | low | `value_map` cannot target `product_colors`; empty categories never filled | Fixed: `{color_id}` entries binding images by `color_id`, no hex; empty `category_id` / `sub_category_id` filled and logged | §E.1, §E.2 |
| 40 | low | `selectedDefault` never stored | Fixed: `product_option_groups.default_value_id`; preselection when the server gives none; variant-scoped rows for the default | §B.2, §C.2, §G.3 |
| 41 | low | `parseProductBody` does not exist (duplicate of 14) | Fixed with 14: `newImportProductDoc` and its defaults test | §A.4 |
| 42 | low | Brief §15 progress fields missing | Fixed: every field as a D1 aggregate in the report, the dashboard, and the job summary after every product | §H.3 |

**Refuted parts, one line each:**

- **Finding 4's "refuse create for `not_bambu`".** `not_bambu` means the Levonis candidate is *not* this Bambu product, so the source must be created. Refusing the create would skip a product (R1). The Worker refuses creates for `merge`, `merge_publish` and `hold_owner_hidden` instead.
- **Finding 11's "Save on officially refurbished…" example.** It is promotional and stays removed, by the promotion class finding 27 asks for. Only the two technical plate sentences are restored.
- **Finding 19's coarser-group rule.** It does not cover H2DC: `H2D AMS Combo` has three variants (`Standard`, `Dual AMS 2 Pro Bundle`, `AMS HT bundle`). The fix is variant-level binding plus a representative image per value (§C.4 steps 2–3).
- **Finding 32's live signed-in request for every product.** Production has no test customer credential, and creating one is the owner's call (L-17). Per-product proof is the Worker's own validator.
