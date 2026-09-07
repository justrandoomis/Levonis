# @levonis/pricing

The pure pricing engine, moved verbatim out of `worker/lib` in Phase 1.1 of
`docs/architecture/02-MIGRATION-PLAN.md`. Shared by the core today and by the
Catalog deployable from Phase 5 (`01-TARGET.md` §1.2 row 4). No I/O, no
Cloudflare bindings, no Hono, no imports outside this package
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

Import a module by subpath: `import { resolveUnitPrice } from '@levonis/pricing/pricing'`.
