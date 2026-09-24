# @levonis/storeLayout

The store page as data — the foundation of themes, the store builder and the
published-only storefront (`docs/MERCHANT_PLATFORM.md` §4.4, wave 2 stream
W2-C). Pure: no I/O, no Cloudflare bindings, no imports outside this package
(`tests/monorepo.test.ts` pins it). The Worker imports it as
`@levonis/storeLayout/<module>`; the SPA imports it by relative path
(`packages/storeLayout/src/<module>`), like `packages/shipping`.

| Module | What it is |
|---|---|
| `schema` | `StoreLayout` v1 — `{schema_version, theme, tokens, header, footer, blocks[]}` — header/footer variants, `Visibility`, the caps (40 blocks, 64 KB normalised, 256 KB request) |
| `tokens` | the token enums (accent, surface, radius, density, typography, card, product card, image ratio, section spacing, grid columns, width) and the seven theme presets: `classic` (the pre-builder storefront), `minimal`, `modern`, `premium_dark`, `workshop`, `portfolio`, `product_focused` |
| `blocks` | the block registry: 27 block types, their variants and every setting typed and bounded (`FieldSpec`), plus `SettingsOf<T>` for typed renderers |
| `text` | `LocalizedText` {ar, en, ckb}, `cleanText` (controls, bidi overrides and lone surrogates removed, capped), `pickText` |
| `refs` | media keys (owner-scoped, never URLs), ids, typed links (routes / product / collection / https only), social providers (handle + provider template) |
| `normalize` | `normalizeLayout(input, {ownerUserId})` → `{layout, issues, ok}` — the ONE gate, run by the Worker on write and read, by the builder, and by the storefront before rendering; `makeBlock`, `applyTheme` |
| `defaults` | `defaultLayoutFromStore(store)` — the classic page, so a store with no published revision renders exactly as before |
| `data` | `collectDataNeeds(layout)` — the batched reads a layout's visible blocks need (product lists, picked and LINKED products, collections, services, showcase, reviews, printers, coupons) — and the public data shapes |
| `verify` | `collectLayoutRefs` / `dropLayoutRefs` — the media keys and product / collection / coupon ids a layout names, for the Worker to check against the store's own rows, and their removal with an issue at each place |

`tests/storeLayoutSchema.test.ts` and `tests/storeLayoutMalicious.test.ts` pin
the schema and the refusals; `tests/storeLayoutRoutes.test.ts` pins the
draft / publish / restore contract built on it.
