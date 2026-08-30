# §12 — اختبارات القبول الإلزامية / Acceptance matrix

Every row of the mandate's §12 list, what proves it, and the number that came
back. Run on `claude/new-session-2hq4ci`.

Nothing in this table is a claim about intent. Each entry names a file you can
run, and the counts below are the output of running them, in order, on a clean
build against `wrangler dev` with a migrated local D1.

```
npm run check                     0 errors, 119 warnings
npm run test:unit                 504 passed, 0 failed
node scripts/migrate-check.mjs --twice
node scripts/migrate-check.mjs --from <copy of the current db> --twice
node scripts/e2e-permissions.mjs   46 passed, 0 failed
node scripts/e2e-images.mjs        78 passed, 0 failed
node scripts/e2e-import.mjs        61 passed, 0 failed
node scripts/e2e-import-ui.mjs     44 passed, 0 failed
node scripts/e2e-product-form.mjs  67 passed, 0 failed
node scripts/e2e-subscription.mjs  73 passed, 0 failed
                                  ---
browser + API totals              369 passed, 0 failed
```

## The matrix

| # | §12 row | Proof | Result |
|---|---------|-------|--------|
| 1 | typecheck, lint, unit tests and build with no errors | `npm run check`, `npm run test:unit`, `npm run build` | 0 errors · 504 tests · build clean |
| 2 | migrations apply to a fresh database **and** to a copy of the current schema, twice, with no duplication or corruption | `tests/migrations.test.ts` → `scripts/migrate-check.mjs --twice` and `--from <copy> --twice` | fresh: 94 tables, FK violations 0, orphan catalogs 0 · from a copy: 95 tables, FK 0 · second pass applied 0 files · `0025` re-ran its 2 statements with no row added and no value changed |
| 3 | responsive at 360/390/768/1024/1440 — no horizontal overflow, no field behind the sidebar, the save bar covers nothing | `scripts/e2e-product-form.mjs` | 67/67 across all five widths |
| 4 | the form shows English only, with no ar/ckb fields | `scripts/e2e-product-form.mjs` — "no ar/ckb fields in the form" at each width | 5/5 |
| 5 | the English product name is unchanged in every language; other text is translated locally with no AI network call | `tests/translate.test.ts` — "translating never performs a network call", "the translator source contains no fetch, no AI provider and no API key" | 19/19 |
| 6 | no working section or endpoint for extracting a product from a URL | `tests/migrations.test.ts` §2 test (no `extract.ts`, no `ExtractPanel.tsx`, no mounted route) + `scripts/e2e-product-form.mjs` "no URL-extraction panel" at each width | pass · 5/5 |
| 7 | direct and pre-order can both be selected, saved, read back and shown to the customer | `tests/saleMode.test.ts` | 18/18 |
| 8 | direct is the default with stock; pre-order becomes the default when direct is out and pre-order is enabled | `tests/saleMode.test.ts` — "stock > 0 defaults to direct sale…", "admin-enabled pre-order … is the default and ignores stock", "out of stock does NOT become a pre-order when the admin did not enable it" | pass |
| 9 | Regular/PRIME/PRO prices, the ladder PRO ≤ PRIME ≤ Regular, and the sale price never equal to the cost | `tests/pricing.test.ts` — resolve-time ladder **and** the write-time refusals added in this batch | 33/33 |
| 10 | PRIME free delivery: 150,000 does **not** qualify, 150,001 does, after discounts and points and before delivery | `tests/shipping.test.ts` — "PRIME: exactly 150,000 does NOT qualify; 150,001 does", "…tested on the AFTER coupon-and-points basis" | 15/15 |
| 11 | a colour linked to two options, and to three, appears only with the right combinations | `tests/productRelations.test.ts` — "links in TWO groups are AND", "the mandate's own three-group example: A1 + Combo + EU only" | 19/19 |
| 12 | with `inventory_mode = COLOR`, an exhausted colour blocks the sale even when base stock is above zero | `tests/inventory.test.ts` — "COLOR mode: an exhausted colour blocks the sale even when base stock is high" | 22/22 |
| 13 | no double stock decrement on retry or a duplicated webhook | `tests/orderInventory.test.ts` — "confirmation turns the hold into a real decrement, exactly once", "a repeated cancellation does not return the units twice" | 12/12 |
| 14 | several images, reordering, exactly one primary, and binding an image to a colour/option — on phone and tablet | `scripts/e2e-images.mjs` at 390 / 768 / 1024 | 78/78 |
| 15 | the Devices and Materials templates download, preview writes nothing, confirm is idempotent, round-trip preserves everything | `scripts/e2e-import.mjs`, `scripts/e2e-import-ui.mjs`, `tests/importCsv.test.ts` | 61/61 · 44/44 · 32/32 |
| 16 | permission tests proving an assistant admin sees no cost or financial data **even by calling the API directly** | `scripts/e2e-permissions.mjs` + `tests/adminScope.test.ts` | 46/46 · 19/19 |

## What writing this batch found

The matrix is not a formality — three rows had no proof at all, and each one
was hiding a real defect.

**Row 16 — the assistant could not save any priced product.** An assistant's
own `GET` returns the product with every cost removed, so their panel posts it
back with no cost key. `validateProductDoc` defaults a missing cost to null,
and the refusal compared the *validated* document against the stored value —
so absence read as "you tried to set the cost to null" and refused the save
outright. An assistant could not edit even the name of a product that had a
cost. The carry-forward branch written for exactly this case was unreachable.
Absent is now told apart from sent.

**Row 9 — nothing enforced §5's price rules on save.** §5 says in as many
words: "يجب أن يختلف سعر البيع عن التكلفة. امنع الحفظ مع رسالة واضحة إذا
تساويا". `lib/pricing.ts` clamps the ladder when *resolving* a price and its
comment claimed a bad row "would be rejected at write time" — nothing rejected
it. And a clamp cannot help with the cost rule at all: a cost typed into the
price field resolves to a perfectly valid price and sells the product at cost.
Both rules are now enforced in `validateProductDoc`, at product, option and
colour level, with a message naming the field.

**Row 14 — the image panel had six controls under the touch minimum.** §1 sets
controls at 44–48px and every other control in the form complies. The four
icon buttons and two inputs in each image card were 36px. They survived because
`e2e-product-form.mjs` builds its fixture with `images: []`, and the panel
renders nothing at all without an image — so the responsive checks never saw
it. All six are now 44px and the card grew from 150px to 196px to hold them.

**Row 2 — the migration harness printed a green line over an empty set.** It
reported "0 idempotent statements re-ran with no row change" for migration
0025, because `isIdempotent()` did not recognise a plain `UPDATE`. It now
recognises an `UPDATE` that assigns only literals, **fails** on a migration it
cannot re-run at all rather than passing it, and compares the full contents of
each table rather than only its row count — §12 asks for "دون تكرار أو تلف",
and a row count answers only the duplication half.

## Evidence on disk

| Path | What it is |
|------|-----------|
| `docs/evidence/import/template-devices.csv` | the real Devices template, as downloaded |
| `docs/evidence/import/template-devices.zip` | the same as a ZIP with `README.txt` and `images/` |
| `docs/evidence/import/template-materials.csv` | the real Materials template — a different column list |
| `docs/evidence/import/export-devices.csv` | a real export, the round-trip input |
| `docs/evidence/import/import-report-applied.csv` | a real result report: created/updated/skipped/failed |
| `docs/evidence/import/import-report-rejected.csv` | a real result report with the reason per row |
| `docs/evidence/images/images-390.png` | the gallery on a phone |
| `docs/evidence/images/images-768.png`, `images-1024.png` | the gallery on a tablet |
| `docs/evidence/product-form/form-*.png` | the form at 360/390/768/1024/1440 |
| `docs/evidence/subscription/subscription-*.png` | /subscription at five widths |

## Still open

These are recorded as pending in `docs/DECISIONS.md`, not as passes.

* **`plus_12mo` has no price** (row 39). Every PLUS plan has carried
  `price_iqd = NULL` since migration 0002 — the owner's price was never
  supplied. `GET /api/memberships/plans` lists it, the page shows "السعر
  قريبًا" and the subscribe button stays disabled, and the server refuses an
  unpriced plan. PLUS is therefore **not purchasable** until a price is set in
  the memberships admin. This is not a regression from migration 0025: the
  short PLUS durations it retired were unpriced too.
* **`product_images` backfilled 0 rows** in migration 0022 (row 37). No visible
  effect — `applyRelations` only replaces media when the relational layer
  actually holds images, so the storefront still renders from the legacy
  column — but the cause is unverified and it is listed as open.
* The owner-action items in `docs/DECISIONS.md` rows 3, 10, 14, 16, 21, 22, 24,
  26, 28 and 30 remain blocked on a decision or a secret only the owner can
  supply.
