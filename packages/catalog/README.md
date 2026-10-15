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

`tests/bambu*.test.ts` pin the import mapping on `tests/fixtures/bambu/`.
`tests/catalogModel.test.ts` pins the model; `tests/catalogRoutes.test.ts`,
`tests/catalogCheckout.test.ts` and `tests/catalogMigration.test.ts` pin the
contracts built on it.
