# Capture-tool fixtures (docs/SMART_PRICING.md §3.3, §10, WP4)

What `tests/supplierPriceCaptureScripts.test.ts` feeds the three capture tools under
`scripts/supplier-prices/`; the owner's one-page store read reads the same store pages
(`tests/supplierPricesStorePage.test.ts`, `tests/supplierPriceSaleRule.test.ts`). Nothing here is
fetched: the store reader runs against a stubbed `fetch`. The live captures under `data/bambu-*-prices/` are the shop's cost basis and stay out of
git (owner question 282(g)); these few records are copied from them on 2026-10-31.

| File | What it is |
|---|---|
| `eu-store-2026-10-31.sample.json` | Eight products of the EU store snapshot as `data/bambu-eu-prices/tools/assemble-snapshot.mjs` builds it from the browser captures (read with `?skr=yes`), verbatim: H2D and H2C (the H2C's laser combos out of stock), the filament buffer (27.99), the H2D Pro (its one variant has no price), the USB-C soldering iron kit (its handle captured percent-encoded, `usb%E2%80%91c-…`), the toolhead cooling fan (three option values), the R1 vision encoder (a product name that holds " - ") and the laser module. `coverage` is trimmed. |
| `tmall-store-2026-10-31.sample.json` | Five items of the Tmall snapshot as `data/bambu-cn-prices/tools/assemble-snapshot.mjs` builds it, verbatim: the ZH121 drill (one SKU labelled 优惠前, one with no label), the KC008 maker kit (decimal prices and a reminder option marked `not_for_sale`), the A1 hotend heating assembly (a 99999 placeholder SKU), the AA013 screws (2.1 CNY) and TPU 75A (every SKU parked at 9999, trimmed to two). `coverage` is trimmed. |
| `eu-h2d.page.html`, `eu-h2c.page.html`, `eu-filament-buffer.page.html` | Store pages in the store's JSON-LD shape (`ProductGroup.hasVariant[].offers`, as in `tests/fixtures/bambu/*.page.html`), carrying the EU capture's own ids, names, EUR prices, availability and variant URLs. |
| `eu-a1-sale.page.html`, `eu-h2c-sale.page.html` | Sale pages in the store's JSON-LD shape, with the EU capture's own ids and names: each offer's `price` is the sale price and its `priceSpecification` the regular one, a StrikethroughPrice (the A1 as a list holding the sale UnitPriceSpecification and the regular one, priceType the schema.org URL; the H2C as one object, priceType the bare name). Prices from `data/bambu-eu-prices/strike/strike-001.json`: A1 239/259 and 339/369; H2C 1799/2149, 2149/2549, 2499/2949, 2019/2449. |
| `us-pla-basic-filament.page.html` | Three variants of the US store's PLA Basic page (`tests/fixtures/bambuPlaBasicPage.html`), USD, with colour codes in the names. Served by the EU stub, it stands for another region's store answering. |
| `challenge.page.html` | A Cloudflare "Just a moment..." challenge body. |
| `robots.txt` | A store robots.txt that disallows one product page. |
