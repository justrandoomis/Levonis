# @levonis/shipping

The pure shipping quote engine and the Iraq governorate table, moved verbatim
out of `worker/lib` in Phase 1.1 (`docs/architecture/02-MIGRATION-PLAN.md`
§1.1). Used by Cart/Checkout today through the core's one-line re-exports
(`worker/lib/shipping.ts`, `worker/lib/iraqGovernorates.ts`) and by the
Fulfilment deployable from Phase 7b (`01-TARGET.md` §1.2 row 10). No I/O, no
bindings, no imports outside this package.

| Module | What it is |
|---|---|
| `shipping` | `quoteShipping` and the `ShippingConfig` / `ShippingItem` / `ShippingQuote` shapes |
| `iraqGovernorates` | the governorate list, `normalizeGovernorate`, `governorateName` |

`tests/shipping.test.ts` and `tests/governorates.test.ts` pin the behaviour from the core paths.
