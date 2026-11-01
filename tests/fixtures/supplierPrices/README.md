# Supplier price fixtures (docs/SMART_PRICING.md §10, WP2)

Real records, copied on 2026-10-31. The live captures under `data/bambu-*-prices/`
are the shop's cost basis and stay out of git (owner question 282(g)); these
few records are the test corpus.

| File | What it is |
|---|---|
| `tmall-batch-records.json` | 21 product-page captures of the official Tmall store (拓竹官方旗舰店), verbatim from `data/bambu-cn-prices/batches/batch-*.json`: PLA Basic, the PLA Basic and PLA Matte 10-packs, TPU 95A HF, ASA, flush cutters QA018, the ZH121 drill, the KC008 pumpkin lamp, three hotend listings, the textured PEI plate, the hotend heating assembly with its "do not buy" placeholder SKU, the flash-sale and members-only promotion links, the refurbished and the new X2D, the AA013 screws, the AMS 2 Pro feeder, the X2D hotend fan and the E1 Pro purifier. |
| `tmall-2026-10-31.v1.json` | The same 21 items as a `levonis.supplier-prices.v1` file, built the way §3.3's normaliser does (`item_id → item_key`, `sku_id → sku_key`, `price_cny → price`, `price_title → price_label`), with `category`, `sourcing`, `freight_route`, `codes`, `name_en` and `options_en` from the capture's own rules (`data/bambu-cn-prices/tools/enrich.mjs`). |
| `eu-store-records.json` | The 4 products of the EU store snapshot (`data/bambu-eu-prices/eu-store-2026-10-31.json`, read with `?skr=yes`), verbatim: H2D, H2C, X2D and the filament buffer, with the store's own variant ids (`596571526982115329`, `43719762903259`) and EUR prices. |
| `eu-2026-10-31.v1.json` | The same as a v1 file: source `bambu_eu`, currency `EUR`, `item_key` = the store handle, `sku_key` = the JSON-LD `sku` (the variant id), the variant's values keyed `option1`, `option2`. |
| `manifest-rows.json` | 20 real rows of `data/bambu-import/manifest.json` (SKU codes by variant id, type and subtype). |
| `load.ts` | Loaders, and the Levonis side: the Bambu import's own option model (`tests/fixtures/bambu` samples through `buildOptions`) with the manifest row's SKU codes. |
