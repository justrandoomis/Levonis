# The print quote engine — audit and architecture

Written before any of it was built, because §54 of the mandate asks for the
audit first and because the single largest risk in this feature is duplicating
systems that already exist.

## 1. What exists today

### 1.1 The calculator (`src/pages/Tools.tsx`, 257 lines)

Four inputs — filament, grams, hours, quantity — and this arithmetic:

```
material = grams × iqd_per_gram × qty
machine  = hours × machine_iqd_per_hour × qty
setup    = setup_fee_iqd
total    = (material + machine + setup) × (1 + margin_percent/100)
```

It is honest about what it is (its own header says so) and it refuses to invent
material prices: `GET /api/products/print-calculator` derives `iqd_per_gram`
from real filament PRODUCTS — `price_iqd ÷ spec_fields.net_weight` — and skips
any spool whose net weight is not recorded.

**That is why the owner's screenshot is empty.** No product in the `materials`
template family currently carries a `net_weight` spec, so the list is empty and
the page correctly says «لا توجد مواد مسجّلة بوزن صافٍ بعد». The fix is data,
not code — and the engine below removes the dependency anyway, because a
merchant's own spool cost outranks a catalogue product.

There is no file upload, no geometry, no printer, no waste, no risk.

### 1.2 LEVO Studio (`studio/`, its own Vite app and Worker)

This is where every measurable number already lives:

| What | Where |
| --- | --- |
| Slicing (WASM, client-side) | `three-slicer` engine, patched in `studio/patches/` |
| Printer presets | `studio/app/printer-profiles.ts` — `PROFILES` (X2D, H2D, H2C, H2S, H2D Pro, P2S, P1S, P1P, X1C, X1, A1…) with `nozzle`, `presetName`, `settingId`, `materialPreset` |
| Quality → layer height | `QUALITY` = fine / standard / draft |
| Strength → infill + walls | `STRENGTH` = light / standard / strong |
| Plate packing | `studio/app/plate-packing.ts` |
| Orientation search | `studio/app/auto-orient.ts` |
| Engine control surface | `studio/app/engine-adapter.ts` |

**Architectural consequence (§4).** The slicer is a multi-megabyte WASM core
that already OOM'd an Android phone in this repo. It cannot run in a Cloudflare
Worker and it must not be added to the storefront's first paint (§52). So:

- **slicing happens in the browser**, in the Studio engine, lazily loaded;
- **the Worker orchestrates**: it authorises, stores the analysis, prices it,
  and snapshots the result.

The Worker never re-derives grams or minutes. It receives them, records their
provenance as `slicer`, and prices them.

### 1.3 Merchant printers — `merchant_printers` (migration 0045)

Already carries, per merchant printer: `technology`, `brand`, `model`,
`build_x_mm / build_y_mm / build_z_mm`, `nozzle_mm`, `materials`, `colors`,
`multicolor`, `enclosed`, `hardened_nozzle`, `quality_max`,
`machine_hour_iqd`, `availability`, `active`.

That is a real capability model and §24 says to build on it, not beside it.

**What it does not have** (and what the engine needs):

- a link to a canonical printer MODEL — every merchant re-types the same build
  volume for the same machine, which §24 explicitly forbids;
- purchase price, purchase date, expected useful hours, residual value;
- maintenance reserve, electricity tariff, labour rate;
- a multi-material ARCHITECTURE (AMS-style single nozzle vs independent
  toolheads vs IDEX vs toolchanger) — `multicolor` is one bit, and one bit
  cannot distinguish a 40 g purge from a 2 g prime;
- reliability history.

### 1.4 Materials

There is **no materials catalogue table**. Filament exists only as products in
the `materials` template family, and the only per-spool economics anywhere is
the retail `price_iqd`. A merchant's own acquisition cost — which §7 says must
outrank everything — has nowhere to live.

### 1.5 Print requests — `community_print_requests` (migration 0045)

The customer→merchant journey exists, with `merchant_request_prefs` filtering
and a matching endpoint (`GET /merchant/request-matches`). §42 connects the
calculator into this rather than creating a second request system.

## 2. What must be added

Nothing here replaces anything above.

| New | Why |
| --- | --- |
| `printer_models` | one canonical row per machine, referenced by `merchant_printers.model_id`; specs stored once |
| `printer_model_economics` | power profile, depreciation defaults, maintenance defaults, reliability baseline |
| `multi_material_profiles` | per-architecture purge/prime/change coefficients — measured and configurable, never hardcoded per brand |
| `merchant_printer_economics` | the merchant's overrides: purchase price/date, hours, tariff, labour rate, margins |
| `merchant_spools` | brand, material, colour, acquisition price, original and remaining grams |
| `print_analyses` + `print_analysis_materials` | the slicer's measured output, per material, with provenance |
| `print_quotes` + `print_quote_cost_components` | the priced result, one row per component, plus an immutable snapshot |
| `print_actuals` + `print_failures` | estimate-vs-actual and the failure STAGE, which is what makes the reserve accurate |
| `printer_calibration_stats` | merchant-specific correction factors, above a minimum sample threshold |

## 3. The rule that governs every number

Every value the engine uses carries a **provenance**, and the engine refuses to
present an estimate as a measurement:

```
measured        the slicer said it
profile         a printer/quality profile said it
merchant        this merchant configured it
platform        a Levonis default, because nothing better exists
inferred        derived from an image or a heuristic — never from an LLM for a
                measurable quantity
```

§53 is absolute: no random percentages, no hardcoded multiplier pretending to be
intelligence, no LLM-generated grams or minutes. AI advises on orientation,
support strategy, printability and material choice; it never replaces a number
the slicer can measure.

## 4. Build order

1. **The deterministic core** — cost model, risk model, multi-material waste,
   printer capability/economics, engine versioning. Pure functions, unit-tested,
   no database and no browser. *(this is what the first commit lands)*
2. Migrations for the tables in §2, additive and backward compatible.
3. The Worker's orchestration routes: analysis intake, quote creation, snapshot.
4. The Studio-side analysis producer (lazy-loaded slicing, real outputs).
5. Guest/customer flow, then merchant economics and printer comparison.
6. Print-request integration, then the actual-vs-estimate feedback loop.

Each stage is useless without the one before it, which is why the core comes
first and why it is the part that must be provably correct.
