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

## Still open

Batches 3–6 (product API for options/colours/variants/images/inventory, the
form rebuild, the Devices/Materials import templates, and the §12 acceptance
suite with staging evidence) are not done yet and are **not** claimed as
working. Nothing so far has been deployed to staging or production.
