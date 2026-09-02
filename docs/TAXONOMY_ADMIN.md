# التصنيفات — the taxonomy admin

*صفحة «التصنيفات» في لوحة الإدارة، وما يترتب عليها في نموذج المنتج وقالب الاستيراد.*

The first section of the product form — «التصنيف: القسم والعلامة
والهاشتاقات» — picks from four vocabularies. Until this round every one of
them was database-managed but **admin-unmanageable**: the API existed, the
screen did not, and hashtags were not an entity at all. This page is that
screen, and the import template now carries the same lists as its accepted
values.

---

## 1. The four vocabularies

| tab | table | what it decides |
|---|---|---|
| الأقسام / Sections | `catalogs` | the tree: one main section and one sub-section per product, plus the `template_family` (devices / materials) that decides the product form's spec fields and the import file's columns |
| العلامات التجارية / Brands | `brands` | the product's brand, and the `brand` column of an import |
| الفلاتر / Filters | `facets` | the filters a product may carry (many per product), grouped by an open `kind` axis; the `facets` column of an import, written by slug |
| الهاشتاقات / Hashtags | `hashtags` (migration 0041) + `products.hashtags` | the discovery tags, suggested in the form and listed in the template |

Sections and filters are deliberately never merged: a filter is not a place
in the tree, and a product in one section may carry any number of filters.

---

## 2. Delete means delete — until something depends on it

Every tab offers add, edit, activate/deactivate and delete. The delete
endpoints share one contract:

* **nothing uses the row → it is deleted for real**;
* **something uses it → it is deactivated instead**, and the response says
  exactly what stood in the way (how many products, sub-sections, placements).

A section or brand that products and past orders point at may not evaporate
from them, and an admin is told which of the two happened rather than being
left to guess. An inactive row is offered by neither the form nor the import.

`DELETE /api/admin/taxonomy/brands/:id` was added in this round; sections and
filters already had theirs.

---

## 3. Hashtags: a managed list over a free-form field

`products.hashtags` stays a JSON array on the product and remains the truth
about *that* product. The `hashtags` table is the **vocabulary**: what the
form suggests and the template lists.

The two are kept in step in both directions:

| event | effect |
|---|---|
| a product is saved (form or import confirm) | its tags are registered in the vocabulary (`INSERT OR IGNORE`, isolated from the save — a missing table can never fail a product save) |
| a tag is renamed in the admin | every product carrying it is rewritten (matched in JS after a `LIKE` pre-filter, so `pla` inside `plastic` is never touched) |
| a tag is deleted with «أزل من المنتجات» | it is stripped from the products too; without it the products keep it and it re-appears in the list as **غير مُعتمد / unlisted** |
| a tag exists on products but not in the table | listed as unlisted, with «اعتماد» to adopt it and an eraser to strip it |

Equality is case-insensitive (`PLA` and `pla` are one tag, enforced by a
`UNIQUE … COLLATE NOCASE` index); the stored spelling is kept unless an
explicit rename by id changes it. Normalization (`#My Tag ` → `My-Tag`) is one
function, `worker/lib/hashtags.ts`, shared by the form, the admin and the
import.

---

## 4. The import template follows the taxonomy

«عند إضافة قسم جديد أو براند أو هاشتاق يجعل في قالب الاستيراد خيارات للاختيار».
A CSV cannot carry a dropdown, so the accepted values travel with the file,
read from the database **at download time**:

* **`hashtags` is now a base column.** A file *without* the column leaves the
  product's stored tags alone (an older export must not wipe them); the column
  present and empty clears them on purpose.
* **the blank template ends with a `#lookup:` block** — one row per accepted
  value, with the value in the `key` column and the target column in
  `row_type`. The parser skips it by its marker, exactly like the `#labels`
  row, so the file still imports with the block left in place.
* **the ZIP adds `lookups.csv`** — the same values as a sortable sheet
  (`column, value, name_en, name_ar, slug, parent, extra`) — and the README
  gains a section listing them.
* **`GET /api/admin/import/lookups`** serves the same four lists as JSON; the
  import panel renders them as copyable chips under step 1.

Only **active** rows are offered, because that is exactly what the importer's
`buildMaps` resolves — offering an inactive brand would be offering a value
that fails.

Every value is advertised **by slug**, including sections and brands. Display
names are not unique (the working database has twenty-three sections called
"Printers"), and a sheet that says `category: Printers` used to be filed under
whichever of them the importer read first. It now resolves slugs and ids
first — both unique by construction — and refuses a name claimed by two rows,
naming the slug as the way to say which one is meant.

---

## 5. Quick-add from inside the product form

The classification section carries a `+` beside the main section, the
sub-section and the brand. It creates the row through the same taxonomy
endpoints this page uses and selects it immediately, so an admin who
discovers a missing section mid-product does not lose the product. Hashtags
are offered as suggestion chips plus a `datalist`; typing a new tag still
works and registers it on save.

---

## 6. API

All routes are behind `requireAdmin` (router-level).

| route | behaviour |
|---|---|
| `GET /api/admin/taxonomy/catalogs` | the tree with `effective_template_family` and `product_count` |
| `POST /api/admin/taxonomy/catalogs` | create or update by `id` (slug derived and de-duplicated; a parent that would close a loop is refused) |
| `DELETE /api/admin/taxonomy/catalogs/:id` | delete, or deactivate with `reason: 'IN_USE'` and the counts |
| `GET/POST /api/admin/taxonomy/brands`, `DELETE /brands/:id` | same contract |
| `GET/POST /api/admin/taxonomy/facets`, `DELETE /facets/:id` | same contract; `kind` is an open axis |
| `GET /api/admin/taxonomy/hashtags[?counts=0]` | the vocabulary merged with the tags products actually carry (`managed`, `product_count`); `counts=0` returns the managed rows only and skips the product scan, which is what the product form asks for |
| `POST /api/admin/taxonomy/hashtags` | create, adopt, rename (rewrites the products, returns `products_updated`) or toggle |
| `POST /api/admin/taxonomy/hashtags/strip` | remove one tag from every product |
| `DELETE /api/admin/taxonomy/hashtags/:id[?strip=1]` | remove the row, optionally from the products too |
| `GET /api/admin/import/lookups` | the accepted values for the classification columns |

A note on partial updates: `str()` returns `''` for an absent field, so the
three POST handlers fall back with `||`, never `??`. With `??` a partial
update — an active toggle — wrote an empty `name_en` over the real one; the
regression is covered by `scripts/e2e-taxonomy.mjs`.

---

## 7. Verification

| suite | what it covers |
|---|---|
| `scripts/e2e-taxonomy.mjs` (69) | the tree and inheritance, loop refusal, delete-vs-deactivate for sections / brands / filters, the whole hashtag lifecycle, every new value appearing in `/lookups`, in the CSV lookup block, in `lookups.csv` and in the README, and an import whose `hashtags` column registers a new tag |
| browser probe (38) | add / edit / toggle / delete from the UI, Arabic and English, 390px with no horizontal scroll, quick-add selecting the new row, arrow keys between tabs, focus returning to the button that opened a dialog, the import panel's accepted-values box |
| `tests/hashtags.test.ts`, `tests/importCsv.test.ts` | normalization, the lookup block parsing back with zero errors, the round-trip with the new column |
| `e2e-import`, `e2e-import-ui`, `e2e-product-form`, `api-tests-v2` | the pipeline and the form still pass unchanged |

---

## 8. What the adversarial review changed

Five review lenses raised 33 findings; each was checked by two independent
skeptics. The ones that survived, and what they cost:

* **A wrapped control loses its label.** `Field` clones its single child to
  give it the label's id; wrapping a select in a flex row to fit the quick-add
  button next to it put that id on the wrapper. `Field` now takes `htmlFor`,
  and the main section, sub-section, brand and hashtag inputs name it — which
  also repaired the brand and hashtag labels, broken before this round.
* **`autoFocus` breaks focus return.** The dialog records
  `document.activeElement` on mount to know where to send focus back; a field
  focused in the same commit is recorded as its own opener. The dialogs let
  the modal do the focusing.
* **A section with sub-sections could be filed under another one**, and its
  children then fell out of a two-level tree entirely. The table now renders
  any depth the data holds, and the dialog refuses that move with the reason.
* **Display names are not unique** — see section 4.
* **A collapsed `<details>` still lays out its contents**: 166 chips measured,
  which also broke the integrated suite's "every dialog action is in view"
  check. The box renders nothing until it is opened.
* **A live region that appears with its text is not announced**, so the page's
  result line is now permanently mounted and only its content changes.
* **`COLLATE NOCASE` folds ASCII and nothing else.** `Çap` and `çap` do not
  collide in the index, while `hashtagKey` folds all of Unicode — so one tag
  became two vocabulary rows, each claiming both products, listed twice in the
  template, and a rename moved both products while stranding the sibling. The
  write path now reads the rows and folds them itself; the index stays as a
  cheap backstop, and an import registers its tags once rather than per row.
* **The product form offered deactivated brands.** Sections and filters were
  filtered by `active`, brands were not — harmless until this round made
  deactivating a brand one click, at which point the form would assign a brand
  the importer refuses. The list is filtered, keeping whatever brand the
  product already carries.
* Plus: hints bound to their controls, checkbox hints outside the label, a
  real `tablist` with one tab stop and RTL-aware arrows, Kurdish names read
  rather than only collected, chips keyed by id, and focus parked on the add
  button after a row is deleted.
