# @levonis/catalog

The merchant catalogue model (`docs/MERCHANT_PLATFORM.md` §2 decision 8, §3
"variants"; wave 2 stream W2-F), shared by the Worker — which is the only
authority on what is stored, priced and sold — and the SPA (the product editor
and the storefront product page). Pure: no I/O, no Cloudflare bindings, no
imports outside this package (`tests/monorepo.test.ts` pins it). The Worker
imports it as `@levonis/catalog/<module>`; the SPA by relative path
(`packages/catalog/src/<module>`).

| Module | What it is |
|---|---|
| `variants` | option groups / values / variants, the caps, `normalizeVariantModel` (the one gate), `comboKey`, `allCombinations`, and the storefront helpers `findVariant`, `valueState`, `initialSelection`, `priceRange` |
| `lifecycle` | `draft | published | hidden | archived`, the legacy `lifecycle` mapping, derived sold-out and low-stock |
| `legacy` | the pre-0126 `options` / `colors` JSON read with the add door's own rules, and `convertLegacyOptions` — a variant model when nothing must be invented, else the reason it stays legacy |
| `palette` | the closed list of swatch colours (names, never CSS) |
| `attributes` | 3D-printing attributes: technology, finish, colour, dimensions, weight (material ids are checked by the Worker against `printMaterials`) |
| `bambuImport/*` | the one-time Bambu Lab import's pure mapping, shared by the runner and the Worker (import spec §C): `rsc` (flight decoder), `extract` (the product by shape, through the closed read list; description formats A–E), `crossSell` (the one reader of SKU codes), `options`, `media` (binding), `describe`, `sentences` (the classifier), `specs` and `logistics` (typed specs, composite cells, the region rule, CBM), `relations`, `payload` (the closed wire shape and `assertImportPayload`), `fingerprint`, and `registry/` (spec keys, group labels, value words, colours, units, documents, models, product types — every label in ar, en and ckb). No price, cost, stock, discount or promotion of the source can reach its output. |

## The Bambu import builder and its manifest row

`buildImportPayload` (in `bambuImport/payload`) composes one product's payload
from its extraction and the reviewed files. The runner (step 8) and the
writer behind `/api/ops/catalog-import` (step 6) call it the same way:

```ts
buildImportPayload({
  extraction,                 // extractPage(html).extraction
  writeMode: 'create',        // or 'merge' with mergeProductId
  extractionSha256,           // extractionFingerprint(extraction)
  manifestRow,                // the product's row of manifest.json, as the file holds it
  targets,                    // compat-targets.json (null: every label unresolvable)
  overrides, contentKey,      // media-overrides.json; server-side content keys at /write
  retrievedAt,
});
```

`manifestRow` is passed whole; the builder reads four fields and ignores the
rest (queue position, leaf, plan estimate, a label's evidence …):

- `source_product_id` and `handle` must name the page's product. A row that
  names another product applies nothing and the report carries
  `IDENTITY_AMBIGUOUS`.
- `sku_codes` — the frozen SKU codes by source variant id (spec §C.1). The
  older `skuCodes` input is read only when no row is given (tests).
- `value_labels` — reviewed display labels by source value id,
  `{ group_source_id?, name_en, name_ar, name_ckb }` (owner-questions §E.1,
  owner question P0-11: a value whose source wording the classifier refuses).
  The option model applies a label after the ids, the `variant_key` and the
  SKU join are computed from the source text, and before media binding, so
  every derived customer string carries it: the value's names and variant
  label, its `source_refs.source_label`, and the `alt_en/alt_ar/alt_ckb` of
  every image row whose selection names it (alt texts use each language's
  value name, the English where none exists). The source text stays on the
  model (`sourceText`, read through `sourceTextOf`) for matching only: the SKU
  join, in-the-box and composite-cell scoping, and compat-targets lookups.
  Nothing is parsed out of a labelled value (no nozzle or weight spec), and
  the order-type check reads the name the value is written with. A label that
  cannot be applied as written — a missing language, `name_ckb` equal to
  `name_ar` (DECISIONS row 183), another group, a name another value of its
  group already shows, over 200 characters — is a `VALUE_LABEL_INVALID` error
  (the product is never written with half a label); a label whose value the
  page no longer lists is a `VALUE_LABEL_UNUSED` note.

`tests/bambuValueLabels.test.ts` proves it on the trimmed real AMS 2 Pro page
(`tests/fixtures/bambu/ams-2-pro.page.html`) and its real manifest row.

`targets` is the reviewed `compat-targets.json`. A label resolves through its
entry's `to` or `members`; an entry whose members depend on the product that
names it ("A1 Series", owner question P0-1) has neither, on purpose, and
carries `by_subject[<subject handle>]` and `default` instead: relations.ts
reads the subject's own members first and the default otherwise
(`entryTargetsFor`). The same file decides two printer questions the group
registry cannot read alone (owner-questions §E.9): "Select your printer
series" and "Device" are printer groups (the latter labelled «الجهاز» /
Device / «ئامێر») only when every value is a label the file maps or lists as
reviewed-unresolvable (`compatLabelReviewed`).

`tests/bambu*.test.ts` pin the import mapping on `tests/fixtures/bambu/`.
`tests/catalogModel.test.ts` pins the model; `tests/catalogRoutes.test.ts`,
`tests/catalogCheckout.test.ts` and `tests/catalogMigration.test.ts` pin the
contracts built on it.
