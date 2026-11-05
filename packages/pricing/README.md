# @levonis/pricing

The pure pricing engine, moved verbatim out of `worker/lib` in Phase 1.1 of
`docs/architecture/02-MIGRATION-PLAN.md`. Shared by the core today and by the
Catalog deployable from Phase 5 (`01-TARGET.md` §1.2 row 4). No I/O, no
Cloudflare bindings, no Hono, no imports outside this package — except the
engine maths' one declared dependency, `costToPrice` → `@levonis/contracts`
(`procurementCost` exact arithmetic, `pricingIssues` codes; `fxChain`,
`ruleResolution` and the Pricing V2 module `priceV2` take the same), which is as pure
(`tests/monorepo.test.ts` pins it).

The core files `worker/lib/<module>.ts` are one-line re-exports, so every
existing import path and every pinned test (`tests/pricing*.test.ts`,
`priceGrid*.test.ts`, `pinnedPrices.test.ts`, `cheapestBase.test.ts`,
`shippingType.test.ts`, `checkoutPayment.test.ts`, `availabilityPricing.test.ts`,
`extendedWarranty.test.ts`) keeps passing unchanged, and the SPA build stays
byte-identical (`src/components/adminProducts/*` imports `pinnedPrices` through
the core path).

| Module | What it is |
|---|---|
| `pricing` | `resolveUnitPrice`, the member ladder, sale mode, PRO policy, warranty-plan pricing — the resolver every price on the site goes through |
| `priceGrid` | the admin price grid (`adminPriceGrid.ts` reads it) |
| `pinnedPrices` | pinned option/colour prices and the reprice preview |
| `cheapestBase` | `normalizeCheapestBase` — the base row a product's price is anchored to |
| `shippingType` | `direct | preorder_air | preorder_sea | preorder_land`, transport mapping, cart shipping type |
| `paymentPolicy` | which payment methods a shipping type allows; COD vs prepaid (ids never renamed) |
| `availability` | `effectiveAvailability`, sale types, lead times (a dependency of `pricing`) |
| `warrantyPlanMath` | fee arithmetic, total months, read-time device-policy defaults (the pure half of `worker/lib/warrantyPlans.ts`, which re-exports every symbol) |
| `json` | `safeParse` — the one JSON helper the resolver needs (a copy of the core's) |
| `skuChannel` | the SKU × channel identity of engine prices: `direct_sale | pre_order_air | pre_order_sea | pre_order_land`, route → profile (air → CHINA_AIR, sea → CHINA_SEA, land → GERMANY_LAND), `skuComboKey` (byte-identical to `product_variants.combo_key`), `parseSkuComboKey`, the `sku:<combo_key>@<channel>` history key, and Pricing V2's stored key of the option-less product row (`'o:*'`, `storedSkuKey` / `skuKeyOfStored`) |
| `costToPrice` | the pricing engine's exact maths (master plan v2 §2.4): input resolution over product → option → colour → SKU, effective weight and CBM, `R_exact`, `ceil_step(R_exact + T_exact)` (+ the Direct Sale Extra after rounding), where `T_exact` = the minimum profit in USD × U (owner brief 2026-10-09) or a migrated dinar amount; the private breakdown, the display-only USD figures (K, F, freight and extras ÷ U, rounded up at 6 decimals), readiness codes. **Never imported by `src/`** (the formula is confidential) |
| `ruleResolution` | `resolveRuleAt`: minimum profit (USD, or a migrated dinar amount) and Direct Sale Extra (whole dinars), most specific wins (sku > colour > option > product > category ancestors > global), INHERIT skipped, BLOCKED stops, a tie takes the maximum in dinars at U with `RULE_TIE`; `canonicalUsdRuleAmount` normalises the owner's typing |
| `legacyTargets` | the owner's answer B, applied (master plan v2 §2.5): per model and route, the minimum profit `(item + route fee) − landed cost` and the Direct Sale Extra `P_dir − paid_base` the old prices carry, with their statuses (routes that disagree → CONFLICT, never averaged; direct-only → extra 0; no cost → unresolved; review cases), placement at product or option scope, and the round trip through `ceilStep` and `resolveRuleAt`. **Never imported by `src/`** |
| `priceV2` | Pricing V2 (docs/PRICING-V2.md §1, owner decisions A1, B1, C1): `priceProductV2` prices every SKU × channel from one anchor, the direct-sale price D — a typed USD price (SKU > model > product) or, cost-first, `R_stock + T` through E1's own input and cost maths — plus option and colour ± USD, then pre-order `P = ceil_1000((D_usd − Δ) × U)` with one discount for every route (SKU > colour > model > product). Cost-first, D is never below `R + T` and a route is never below its own cost (blocked when `R_r > D`; otherwise the discount is withdrawn and the route sells at D — never lifted to its cost, owner answer Q1); price-first only warns the owner below cost and below cost + minimum profit (Q3); a pre-order-only SKU sells every route at D. Codes, never numbers, for anything missing. **Never imported by `src/`** |
| `estimateInputs` | Estimated pre-order prices (docs/SMART_PRICING.md §4.4–§4.5): supplier-cost compaction (base → one option group → colour → per SKU, each re-resolved exactly by `resolveSkuInputs` over the merged store), measure planning (model and colour packages, then the product's package on the base row, then the type's defaults only where a SKU has none), and the three-way merge against `applied_wire_json`, emitted as the product form's V2 wire; under a type's profit ceiling (§4.11) each SKU's minimum profit as fixed USD rules at the least specific exact scope (`planEstimateProfits`). **Never imported by `src/`** |
| `charmPrice` | The dollar charm grid (below $10 every $0.50 ending .49/.99; $10–$100 every $1 ending .99; $100–$1,000 every $5 ending 4.99/9.99; from $1,000 every $10 ending 9.99) and `charmTarget`: an estimated SKU's minimum profit under its type's profit ceiling (DECISIONS row 291, SMART_PRICING §4.11) — from $5 up (`CHARM_MIN_USD`) the highest charm price at or under both today's price and its cost plus the ceiling whose profit keeps one rounding step over the cost (`marginNeededIqd`: 250 IQD, one dinar at or under 1,000 IQD — so FX-5 can follow any later rise without closing the route), else the lowest whose margin holds; under $5 the highest house price (250 IQD steps, whole dinars at or under 1,000) there with the same margin, else the lowest that keeps it; never above today's price while that clears the route floor; the owner's positive option and colour differences stay on top; T_sku = floor6(c − R ÷ U − Δ) or floor6((D − R) ÷ U − Δ), every price weighed through `roundPriceIqd`; and `priceAtProfit`, a SKU's price and whether its margin holds at a profit another SKU set (the planner's shared rules past the wire's 60 rows) |

Import a module by subpath: `import { resolveUnitPrice } from '@levonis/pricing/pricing'`.
