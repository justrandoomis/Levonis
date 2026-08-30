# Product form, taxonomy, inventory and LEVO PRIME — implementation record

Mandate: `LEVONIS Product Form / Taxonomy / PRIME` (§1–§13). This document is
the §13 deliverable: what the code actually said before the work started, what
each batch changed, and what is still open. Numbers here are real test output,
never estimates.

---

## §13.1 — Opening report: what exists, what changes, what is actually broken

### Confirmed from the code (not assumed)

| # | Finding | Evidence |
|---|---|---|
| 1 | Options and colours were **JSON blobs**, not rows: `products.options` and `products.colors` are `TEXT` columns. A colour could link to exactly ONE option (`option_id`), so the mandate's "link a colour to two or three option values across groups" was impossible. | `migrations/0001_init.sql:82-83`, `worker/lib/pricing.ts` `ColorV2.option_id` |
| 2 | Sale type was a **scalar with a CHECK**: `selling_type TEXT CHECK (selling_type IN ('direct_sale','pre_order','bundle'))`. A product could not be both direct-sale and pre-order. | `migrations/0001_init.sql:84` |
| 3 | **Three CHECK constraints blocked a `prime` tier**: `membership_plans.tier`, `memberships.tier` and `users.subscription_plan` all admit only `('plus','pro')` / `('free','plus','pro')`. SQLite cannot widen a CHECK in place. | `migrations/0001_init.sql:22`, `migrations/0002_products_memberships.sql:107,128` |
| 4 | **Compare-at was wired through eight layers**: `products.original_price_iqd` → `ProductDoc` → the resolver's `compare_at_iqd` → cart/product/listing strikethroughs → the price-history audit field. Removing the field visually only would have left the data path intact. | 85 references across `worker/` and `src/` before the change |
| 5 | The **taxonomy table already existed but was never seeded** (`catalogs` had 0 seeded rows) and had no `template_family`, so the import template could not vary by section. | `migrations/0002_products_memberships.sql:25-38`; no `INSERT INTO catalogs` anywhere |
| 6 | There were **no facets** — filters would have had to be mixed into the category tree. | no `facets` table in 0001–0017 |
| 7 | Stock was a **single nullable integer on the product**. There was no option-, colour- or combination-level stock, no reservation counter, and no idempotency record, so a retried checkout could deduct twice. | `migrations/0001_init.sql:106` |
| 8 | URL extraction was live on **two endpoints**: `/api/admin/extract-v2` (`worker/routes/extract.ts`, 722 lines) and the legacy `/api/extract` in `worker/routes/misc.ts`. | `worker/index.ts:63`, `worker/routes/misc.ts:97` |
| 9 | The product form showed **three visible language fields per text** (ar/en/ckb) for name, description and specs. | `src/components/adminProducts/ProductEditor.tsx`, `editorSections.tsx` |
| 10 | `price_history.field` had `CHECK (field IN ('regular','pro','compare_at'))` — no room to audit a PRIME price or a cost change, which §11 requires. | `migrations/0003_final_phase.sql:269` |

### Tables and files in scope

**Rebuilt (contained, every row copied):** `membership_plans`, `memberships`
(0018), `price_history` (0019).
**Extended:** `products`, `catalogs`, `users`.
**New:** `facets`, `product_facets`, `product_option_groups`,
`product_option_values`, `product_colors`, `product_color_option_links`,
`product_variants`, `product_images`, `inventory_ledger`,
`product_translations`, `product_imports`.
**Deleted:** `worker/routes/extract.ts`, `src/components/adminProducts/ExtractPanel.tsx`.

---

## Batch 1 — LEVO PRIME, taxonomy/inventory schema, compare-at retirement

### Migrations

| File | What it does | Why it is safe |
|---|---|---|
| `0018_prime_taxonomy_inventory.sql` | Rebuilds `membership_plans` + `memberships` to admit `'prime'`; seeds `prime_12mo` (12 months, 99,000 IQD); adds `users.membership_tier`; adds `products.prime_price_iqd / sale_types / inventory_mode / stock_reserved / low_stock_threshold / category_id / sub_category_id / template_family / sku / spec_fields`; adds `catalogs.template_family`; creates the facet, option, colour, link, variant, image, inventory-ledger, translation and import tables; seeds the §9 tree and the §9 facets. | Additive except two rebuilds. `membership_plans` has exactly one child FK and nothing references `memberships(id)`. The child rows are parked in a constraint-free staging table and the child dropped FIRST — SQLite's deferred-FK counter is incremented by dropping a parent with live children and is **not** decremented by re-creating it, which is why the naive rebuild order fails at COMMIT with `FOREIGN KEY constraint failed`. |
| `0019_price_history_prime.sql` | Widens `price_history.field` to `('regular','prime','pro','cost','compare_at')`. | Nothing references `price_history`; historic `compare_at` rows are retained so the audit trail is never rewritten. |

`users` is deliberately **not** rebuilt: 60 foreign keys point at it, and
`subscription_plan` is documented in the code itself as a legacy cache. See
DECISIONS row 32.

The seed inserts one statement per node rather than one multi-row `INSERT OR
IGNORE`: `catalogs.slug` is UNIQUE and the dev database already owns
`printers`, so a single statement silently dropped the parent and then failed
the FK of every child under it. Each node is guarded on its stable seed id and
takes the first slug still free, so an existing catalog is never renamed,
merged into, or shadowed.

### Behaviour

* **Price ladder** — `PRO <= PRIME <= Regular` is enforced at resolve time:
  a PRIME price above regular clamps down to regular, and a PRIME price below
  the PRO price clamps up to PRO, so a legacy row can never invert the ladder
  at checkout.
* **Precedence** — active PRO, then active PRIME, then regular
  (`worker/lib/pricing.ts`, `TIER_RANK`, `getTierStatus` ORDER BY).
* **No fabricated PRIME discount** — PRIME has no store-wide percent policy;
  an unpriced product simply costs the regular price.
* **PRIME grants no other PRO benefit** — the preorder-commission waiver stays
  PRO-only, and the delivery waiver covers the ordinary fee only.
* **Delivery threshold** — strictly greater than 150,000 IQD on merchandise
  after product discounts, coupons **and points**, before delivery.
  `worker/routes/orders.ts` now computes the points redemption BEFORE the final
  shipping quote so that basis exists; there is no circularity because neither
  the coupon cap nor the points cap depends on the delivery fee.
* **Compare-at retired** — gone from the resolver, the cart, the product page,
  every listing page, the favourites query and the admin editor. Any
  strikethrough now compares the viewer's own server-resolved price against the
  regular price. `products.original_price_iqd` still exists but nothing reads
  it; a later migration drops it.
* **URL extraction removed (§2)** — both endpoints and the panel are deleted.
  A single narrow route remains, `POST /api/admin/media/ingest`, which accepts
  a **direct image file URL only**: magic-byte sniffing rejects an HTML page,
  so a product page cannot be scraped through it. Same SSRF discipline as
  before (validated on every redirect hop, 10s timeout, 4MB cap, images only,
  content-addressed under `products/import/`).

### Verification (real output)

```
npm run check                     clean (frontend + worker tsc)
npm run build                     built in 11.30s
npm run test:unit                 338 pass / 0 fail          (before this batch)
                                  → pricing 21/21, shipping 15/15, migrations 4/4
node scripts/migrate-check.mjs --twice
  fresh database                  20 files, 94 tables, 0 FK violations, 0 orphan catalogs
  second full pass                applied 0 files (bookkeeping holds)
  0018 idempotent re-run          51 statements, no row change
node scripts/migrate-check.mjs --from <copy of the live dev D1> --twice
                                  95 tables, 0 FK violations, 0 orphan catalogs
wrangler d1 migrations apply levonis-db --local
                                  56 commands executed successfully
```

---

## Batch 2 — the local deterministic translator (§3)

English is now the source language. The admin types English once; the Arabic
and Sorani copies are produced by `worker/lib/translate/`, which contains no
`fetch` at all — a test greps the compiled-away comments out of the source and
fails the build if a network call, an AI provider name or an API key appears in
it, and a second test swaps `globalThis.fetch` for a throwing stub while a
translation runs.

### What it will and will not do

The engine translates a segment only when it can PROVE the whole segment is
covered — an exact catalog phrase, a measurement whose unit it knows, a
`Label: value` line where both halves are covered, an enumeration where every
member is covered, or a token that is correct as-is (`PLA`, `USB-C`, `X1C`).
Anything else — in particular free prose — keeps its English text and the field
is reported as `review_needed`. That is not a shortfall to fix later: §3 forbids
inventing a translation, and a rule-based engine cannot write correct Arabic or
Sorani sentences. Saving is never blocked, and the admin response names the
fields that still need a human instead of showing a green tick.

The catalog records `ar` and `ckb` independently. A term with a confident
Arabic rendering but no confident Sorani one (`Acceleration`, for example)
produces Arabic and leaves Sorani in English with `review_needed` — a
per-language honest degrade rather than a guess.

`segment(s).join('') === s` is asserted for every shape of input, so a save can
never silently reflow the author's spacing.

### Wiring

* `worker/lib/translate/index.ts` — the engine, rules R1–R6, `TRANSLATION_VERSION`.
* `worker/lib/translate/dictionary.ts` — the terminology catalog: identity
  terms, units, and ~180 phrases across device specs, material specs, commerce
  vocabulary and colours.
* `worker/lib/translate/localizeProduct.ts` — applies it to a whole ProductDoc:
  description, how-to-use, spec groups and rows, labels, content blocks and
  warranty plans. Product, option and colour NAMES are copied, never translated.
* `worker/lib/translate/store.ts` — upserts `product_translations`, skips
  unchanged sources by hash, and never overwrites a human `approved` row while
  its English source is unchanged.
* `worker/routes/adminProducts.ts` — runs the localizer before serialization, so
  the row written already carries the generated text and the storefront needs no
  runtime translation. `applyTranslationTracking` was rewritten from
  Arabic-sourced to English-sourced.
* Storefront: the product name is now read from the English field in every
  language (`Home`, `Products`, `Bundles`, `Profile`, `Cart`, `Checkout`,
  `Product`, `MyReviewsTab`), satisfying §12's "اسم المنتج الإنجليزي يبقى كما هو
  في جميع الواجهات". Community/merchant listings are a different table
  (`community_products`, seller-authored) and are untouched.

### Lint

The repository had **no** lint configuration at all, so §12's "lint … بلا
أخطاء" could not be satisfied as written. `eslint.config.js` is now a real flat
config covering the frontend, the Worker, the scripts and the tests, wired into
`npm run lint` and `npm run check`. It went from 66 errors to 0 by fixing the
actual findings (dead imports, unused bindings, `prefer-const`, two expression
statements, an unnamed caught error) — not by disabling rules. The two
`no-control-regex` sites are deliberate sanitizers and carry a targeted
disable with the reason. 119 warnings remain, all `no-explicit-any` and
`react-hooks/exhaustive-deps` on pre-existing code; they are reported, not
suppressed.

### Verification (real output)

```
npm run check      tsc (frontend) + tsc (worker) + eslint → 0 errors, 119 warnings
npm run test:unit  369 pass / 0 fail
                     translate      19/19
                     translateStore  8/8   (real SQLite, real 0018 schema)
                     walletOps      31/31  (moved onto the shared fixture)
npm run build      built in 6.86s
```

---

## Batches 3–4 — the model, the API and the rebuilt form

### The form (§1–§8)

`src/components/adminProducts/ProductForm.tsx` replaces `ProductEditor.tsx`,
which is deleted along with `editorSections.tsx`. Eight numbered accordion
sections in the mandate's order, each showing a one-line summary and an item
count when collapsed, only one open at a time.

* **§1 sizing** — 44px controls, 13–14px text, a textarea that starts at 96px
  and stops at 240px, one 880px content column, every grid track
  `minmax(0,1fr)`, every text-bearing flex child `min-w-0`. The only element
  that scrolls sideways is the combinations table, inside its own container.
* **§1 save bar** — sticky at the bottom of the CONTENT column, not fixed to
  the viewport, so it can cover neither the sidebar nor the app's bottom nav.
  It carries save-draft, publish, the dirty/saved state and the first error.
* **§3 English only** — no ar/ckb input exists anywhere in the form; every
  input is `dir="ltr"`. Fields the local translator could not cover come back
  in `translation_review_needed` and are named on screen after saving instead
  of being hidden behind a green tick.
* **§4** — brand from the database with a search box, main section required,
  sub-section limited to that section's children, facets as a separate axis.
* **§5** — Regular / PRIME / PRO / Cost, with the ladder validated live and
  again on the server; cost is rendered only for a financial admin.
* **§6** — sale types as multi-select cards.
* **§7** — unlimited option groups and values, colours with a small checkbox
  matrix per group, and the rule stated on screen: OR inside a group, AND
  across groups, unlinked = shown with everything. The inventory-source picker
  disables a level that cannot answer yet, and combination rows are generated
  honouring the colour links so an impossible pairing is never offered.
* **§8** — many files at once with per-file progress, error and retry; drag or
  keyboard reordering; exactly one primary (choosing one clears the rest in the
  same update, and a partial unique index enforces it in the database);
  per-option/colour binding; `object-contain` so the stored original is never
  cropped. Direct image-file URLs are accepted and verified by magic bytes —
  an HTML page is rejected, which is what keeps §2 enforced.

`worker/lib/templateFamilies.ts` defines the Devices and Materials field sets
once and serves them; the form renders them and the importer will generate its
columns from the same definition, so a field and a column cannot drift apart.

### Verification (real browser, real server)

`scripts/e2e-product-form.mjs` drives the built app under `wrangler dev` with
the real API and D1. **67 checks, 0 failures.**

Three findings came out of writing it, and all three were fixed:

1. The first version of the script measured the admin LIST page, not the form —
   every responsive assertion would have passed without the form ever being
   rendered. It now asserts the form is on screen (8 sections + the save bar)
   before measuring anything.
2. `PUT /:id/relations` accepted a payload naming ANOTHER product's group,
   colour or image id. The upserts key on id, so it would have silently
   re-parented those rows, and two products sharing an id collided on the link
   table's primary key and surfaced as a 500. Foreign ids are now refused by
   name.
3. `json_each`'s `value` column unquotes JSON strings, so `json_type(value)` on
   a plain URL raises "malformed JSON" — the kind comes from `json_each`'s own
   `type` column. Found by the backfill tests, fixed in migration 0022.

```
360 / 390 / 768 / 1024 / 1440 px, each:
  the fixture product is listed
  the product form is actually rendered
  no horizontal page overflow
  no element pushes past the viewport
  every control is at least 40px tall
  English inputs are LTR
  no ar/ckb fields in the form
  no URL-extraction panel
  the save bar sits inside the viewport
  the save bar does not cover the content beneath it
  the save bar stays inside the content column

API: taxonomy seeded · section resolves devices template · product saved ·
     translation review list returned · relations saved and round-tripped ·
     a colour with no links stores no rows ·
     /api/admin/extract-v2 → 404 · /api/extract → 404
```

Screenshots: `docs/evidence/product-form/` — `form-<width>-top.png` for each of
the five widths and `links-<width>.png` showing the colour↔option matrix with
Black linked to A1 and EU. Playwright's `fullPage` is one viewport here because
the dashboard scrolls an inner column rather than the document, so the link
matrix is scrolled into view before its shot rather than cropped out of one.

---

## Batch 5 — the Devices/Materials import templates (§10)

The single giant TXT template is no longer the bulk path. Columns are now
generated per section from the same `worker/lib/templateFamilies.ts` the form
renders, so a Materials sheet has no `spec.nozzle` and a Devices sheet has no
filament diameter.

### The file format

One product spans several rows, told apart by a `row_type` column and joined
by `key` (the product's SKU, or its slug when it has none):

| row_type | what it carries |
|---|---|
| `product` | the product, its four prices, stock, sale types, section, facets and the spec columns its section declares |
| `option` | one value of one option group, with its own stock and price overrides |
| `color` | one colour, its HEX, and its links written `Group:Value|Group:Value` |
| `image` | one image, its order, its primary flag and its `color:Name` / `option:Group:Value` binding |

Packing all of that into encoded strings inside one row would be unreadable in
Excel and impossible to point an error at. With row types, *"row 14: colour hex
is not #RRGGBB"* names a line the admin can actually see.

### Endpoints (`/api/admin/import`)

| route | behaviour |
|---|---|
| `GET /template?category=&format=csv\|zip` | a real download — header, an Arabic `#labels` row skipped by its marker rather than by position, and a worked example. The ZIP adds `README.txt` and an `images/` folder. |
| `GET /export?category=\|ids=&format=csv\|zip` | the same shape, filled with real products — the bulk-edit path |
| `POST /preview` | parses, resolves every name to an id, reports per row. **Writes no product, catalog, stock or order row.** |
| `POST /confirm` | applies a previewed import, idempotent on `import_id` |
| `GET /:id/report?format=csv` | the downloadable result report — created / updated / skipped / failed with a reason each |
| `GET /history` | the last 30 imports |

### The decisions this batch made, stated rather than hidden

* **The preview writes nothing to the database**, but it *does* upload image
  bytes from an uploaded ZIP to content-addressed R2 keys. That makes confirm a
  pure database operation that cannot fail halfway on a slow download; an
  unconfirmed import leaves an orphan blob and never a half-made product.
* **The importer is not a second writer.** `resolveProduct` produces exactly
  the two payloads the admin form produces, and both go through
  `validateProductDoc` and `planRelationsWrite` — which was extracted out of
  the relations route for this. A rule added to the form is enforced on an
  import for free.
* **Ids are reused, never regenerated.** An update matches an option group by
  name, a value by (group, name), a colour by name and an image by URL. Stock
  and reserved units live on those rows; a fresh id would silently reset both.
* **`VARIANT_COMBINATION` cannot be created from a sheet.** A row cannot name a
  combination unambiguously, so existing ones are carried through and a new
  product asking for that mode is refused by name.
* **Spec fields merge, they do not replace** — a value with no column in this
  section's sheet survives the import.
* **The TXT tools were demoted, not deleted.** They are the second tab of the
  import dialog; §10 allows keeping TXT as long as it is not the only option.

### Verification — real numbers

```
npm run check      0 errors, 119 warnings
npm run build      clean
npm run test:unit  467 / 467   (32 of them tests/importCsv.test.ts)
migrate-check      0024 applies to a fresh DB and twice, 0 FK violations

node scripts/e2e-import.mjs        61 / 61   (API, against wrangler dev)
node scripts/e2e-import-ui.mjs     44 / 44   (Chromium at 390/768/1024)
```

What the API script proves, in its own words: the Devices and Materials
templates download as non-empty attachments with different column lists; the
preview creates NO product; confirm creates one and a second confirm creates
none; the written structure really holds 2 groups, 2 values, 2 colours, 2 links
and 2 stored images with exactly one primary; export → preview → confirm comes
back as an **update** that preserves every id, order, stock and link; a bad file
reports its price-ladder violation, its bad hex and its orphan row instead of
500ing; and an image cell pointing at a product page is refused rather than
scraped (§2).

The browser script proves the panel is reachable and correct: the dialog opens
on the section-templates tab, downloads stay disabled until a section is chosen,
nothing spills past the viewport at 390px, every control is ≥40px, and a file
chosen **through the UI** previews, confirms and produces a product that a
follow-up query finds.

Evidence in `docs/evidence/import/`:

| file | what it is |
|---|---|
| `template-devices.csv`, `template-materials.csv` | the real downloads, different column lists |
| `template-devices.zip` | data.csv + README.txt + images/ |
| `import-file-devices.csv` | the file that was actually imported |
| `export-devices.csv` | the round-trip export of what it produced |
| `import-report-applied.csv` | the result report for the successful import |
| `import-report-rejected.csv` | the report naming why a row was refused |
| `import-390.png`, `import-768.png`, `import-1024.png` | the dialog at three widths |
| `import-preview-1024.png`, `import-result-1024.png` | preview and result, driven through the UI |

---

## Still open

Batch 6 — the §12 acceptance matrix end to end and the staging deploy with its
evidence — is not done yet and is **not** claimed as working. Nothing so far
has been deployed to staging or production.
