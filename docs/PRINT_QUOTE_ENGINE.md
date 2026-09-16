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

---

# Part 2 — what was built

Added after the fact, so the record is what shipped rather than what was
planned. Where this contradicts Part 1, this wins.

## 5. The decision that shaped everything: where the measurement happens

The plan in Part 1 assumed the browser slicer would produce the numbers and the
Worker would price them. Building it surfaced two invariants that point the
other way, and one of them is a pricing rule rather than an engineering one.

**§4** forbids a native slicer inside a Cloudflare Worker — `three-slicer` is
multi-megabyte WASM that has already OOM'd an Android phone in this repo.

**`docs/STUDIO_PLAN.md` decision 6**, pinned by `tests/store-isolation.test.ts`,
forbids the store bundle carrying slicer payload OR embedding LEVO Studio in an
iframe. That test states the reason in its own words:

> The browser never parses a model: measurement decides a price, so it happens
> on the server where the customer cannot edit it.

Together those rule out three of the four obvious designs. What is left, and
what shipped:

| Path | Who measures | Provenance | Confidence |
| --- | --- | --- | --- |
| **Customer** (`/tools`) | the Worker, from the stored bytes | `platform` | `estimated`, always a range |
| **Merchant slice** (`POST /analyses/:id`) | LEVO Studio, the merchant's own | `measured` | `exact`, a single figure |

A real slice REPLACES a geometric estimate wholesale, because `measured`
outranks `platform` on the provenance ladder. Nothing re-derives a measured
number, and nothing presents an estimate as a measurement.

### 5.1 What is exact and what is modelled

`worker/lib/modelGeometry.analyseModel` — the same function the print-request
flow already trusts — streams the mesh and returns integrals over the real
triangles. These are **exact** for a closed mesh:

- bounding box, solid volume, surface area, triangle count
- downward-facing overhang area, and (new) the part of it lying on the bed

`worker/lib/printQuote/geometryAdapter.ts` turns that solid into **modelled**
extrusion and minutes:

```
wall      = surfaceArea × (extrusionWidth × wallLoops), capped at the volume
interior  = volume − wall
extruded  = wall + infillFraction × interior
support   = (overhangArea − bedContactArea) × height × heightFraction × density
time      = extruded / (maxFlow × sustainedFraction) + layers × layerOverhead
```

Every coefficient is a real printing parameter, named, stored on the printer row
or the preset, and changeable by an admin. None is a fudge factor and none is
hidden. `supportHeightFraction` is called out in the source as the weakest of
them — a bounding box cannot know what is under an overhanging face — and is
kept separate precisely so it can be argued with and replaced by the two-slice
differential in `slicerAdapter.attributeSupport` when a real slice exists.

### 5.2 The bug this found in the existing code

`analyseModel` counted every downward-facing triangle as overhang, including the
face resting on the build plate. A 20 mm cube was charged ~12% of its own mass
to support its own base. Fixed with `bed_contact_area_mm2`, measured in a second
pass over the same buffer.

**`worker/lib/printPricing.ts:329` has the same defect** — it reads
`overhang_area_mm2` for the existing print-request quote. It is left alone here
deliberately: correcting it would change the price of live print requests, which
is the owner's call, not a side effect of this work.

## 6. The cost model

`worker/lib/printQuote/cost.ts`. Sixteen components, each its own row.

**Risk is not a multiplier (§13).** Expected failed attempts is `1/p − 1`. Each
burns a FRACTION of the variable cost (`averageFailureFraction`, default 0.45 —
adhesion failures die early, spaghetti dies late, so assuming either extreme
biases every quote) plus restart labour in full, and none of the packaging,
overhead or platform fee a retry does not repeat.

**Margin is a share of the price (§21).** `price = cost ÷ (1 − margin)`. The
other reading is a markup, and confusing them is how a shop aiming at 40% runs
at 28.6%. Both numbers are emitted, named separately.

**A material nobody can price stops the quote.** `resolveMaterialPrice` returns
`null` rather than zero, and the quote comes back `insufficient` — not free.

**Every line carries its own provenance.** A fix, not a feature: the first cut
stamped each line with the running weakest provenance across the whole quote, so
a merchant pricing from a spool they actually bought saw «من المنصة» on their own
material. A calibration factor of exactly 1 — what `resolveFactor` returns when a
shop has too little history — no longer speaks for anything.

## 7. Who sees what

Two payloads built by two functions, never one with a flag:

| | `publicQuote` | `merchantQuote` |
| --- | --- | --- |
| price, range, hours, waste | ✓ | ✓ |
| cost, margin, markup, profit, break-even | ✗ | ✓ |
| the sixteen component lines | ✗ | ✓ |

A customer's STL is their intellectual property (§34): bytes are stored
`visibility: 'private'` and are served by this module's own authorised handler,
never through `/files/*` — that route's private branch is a hardcoded if/else
over `receipts/` and `chat/`, it participates in `caches.default` (shared across
every visitor in a colo) and its public predicate skips the session lookup.

## 8. What is NOT built

- The merchant's browser-side slice producer in LEVO Studio. The endpoint that
  receives a slice (`POST /analyses/:id`) exists and is tested; nothing in
  Studio calls it yet, so `measured`/`exact` is reachable by API only.
- The print-request linkage (§42/§43): `print_quotes.request_id` exists and is
  nullable; nothing writes it.
- The actual-vs-estimate calibration loop (§15/§47/§48): `print_actuals`,
  `print_failures` and `printer_calibration_stats` exist, `loadCalibration` and
  `resolveFactor` read them, and no route writes them. Until one does, every
  shop is on the platform baseline and the engine says so.
- The admin printer-profile management UI (§45). The seed is admin-editable by
  SQL only.
