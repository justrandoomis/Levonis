# @levonis/pricing

The pure pricing engine, moved verbatim out of `worker/lib` in Phase 1.1 of
`docs/architecture/02-MIGRATION-PLAN.md`. Shared by the core today and by the
Catalog deployable from Phase 5 (`01-TARGET.md` §1.2 row 4). No I/O, no
Cloudflare bindings, no Hono, no imports outside this package — except the
engine maths' one declared dependency, `costToPrice` → `@levonis/contracts`
(`procurementCost` exact arithmetic, `pricingIssues` codes), which is as pure
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
| `skuChannel` | the SKU × channel identity of engine prices: `direct_sale | pre_order_air | pre_order_sea | pre_order_land`, route → profile (air → CHINA_AIR, sea → CHINA_SEA, land → GERMANY_LAND), `skuComboKey` (byte-identical to `product_variants.combo_key`), `parseSkuComboKey`, the `sku:<combo_key>@<channel>` history key |
| `costToPrice` | the pricing engine's exact maths (master plan v2 §2.4): input resolution over product → option → colour → SKU, effective weight and CBM, `R_exact`, `ceil_step(R_exact + T)` (+ premium), the private breakdown, readiness codes. **Never imported by `src/`** (the formula is confidential) |
| `ruleResolution` | `resolveRuleAt`: target profit and direct premium, most specific wins (sku > colour > option > product > category ancestors > global), INHERIT skipped, BLOCKED stops, a tie takes the maximum with `RULE_TIE` |

Import a module by subpath: `import { resolveUnitPrice } from '@levonis/pricing/pricing'`.
