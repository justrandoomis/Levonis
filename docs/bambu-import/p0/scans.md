# Bambu Lab import — P0 scans (step 3 c)

DRAFT, sandbox only. Built from the 1,115 crawled pages (`p0/raw`, all HTTP 200) by `p0/tools/build.py`; no network was used. Machine-readable detail: `scans.json`. Nothing here carries a source price, stock, discount or promotion.

## 0. Corpus

- Products: **1115**; unique source ids 1115; unique handles 1115; every sitemap handle equals its decoded `seoCode`.
- Types: spare_part 568, makers_supply 342, accessory 72, filament 48, laser_material 41, printer 18, hotend 13, build_plate 8, ams 4, laser_machine 1.
- Description formats: A 992, C 49, D1 1, B 64, D2 4, E 5. **Format E** (a component-list CMS payload, `props.data[{componentType…}]`) is not one of the spec's four (§C.5): bambu-lab-p2s-combo-starter-kit, h2c, h2s, p2s, refurbished-bambu-lab-p2s-3d-printer.
- Thin pages (no description, no feature bullets): bambu-lab-purifier-e1-pro.
- Machines (printers, AMS, R1) with no server-rendered spec table: h2d-pro, p1s, refurbished-p1s — their specs come only from curation.

## 1. `variant_key` uniqueness

Rule: variant_key = 'bv-' + H('bambu_us:value:' + source value id); value id ov_ = H(product_id + ':' + propertyKeyId + ':' + NFC(text)).

- Case-only duplicate values in one group: **1** — `h2d` Option: Standard / standard → bv-8d2f058ac91970d8964764e3, bv-55bae005452be46945d2f579. The two keys differ, so `legacyShapeErrors` passes.
- exact duplicate value text in group: **0**
- duplicate value ids in product: **0**
- empty value ids: **0**
- sku value not in group: **0**
- duplicate variant combos: **0**
- jsonld identity problems: **0**
- handle problems: **0**

So no `ov_` id collides, every SKU names a value of its group (no `IDENTITY_AMBIGUOUS` from §C.3), and every JSON-LD `productGroupID`/`hasVariant[].sku` agrees with `P`.

## 2. Order-type words (`availabilityFromName`)

| handle | group | value | reads_as |
|---|---|---|---|
| cyberbrick-omnidirectional-forklift | Item | Omnidirectional forklift - Remote included - ZL031 | direct_sale |
| cyberbrick-omnidirectional-forklift | Item | Omnidirectional forklift - Remote not included - ZL031-1 | direct_sale |

Products held `ORDER_TYPE_WORD`: cyberbrick-omnidirectional-forklift. The hit is a substring false positive: `/direct(\s*sale)?/i` matches "Omni**direct**ional". `legacyShapeErrors` would refuse these values for a new product, so the hold is real (§B.5, L-18). Option group names: 0 hits.

## 2b. Customer-text refusals (§C.10 layer 2, `IMPORT_PAYLOAD_KEY_REFUSED`)

Every source string copied verbatim into a customer-text payload field (title, option group name, option value name, variant label, their `source_label`) run through `tools/sentences.py`, a port of `sentences.ts` and `payload.ts` `REFUSED_FOR.customer` (money, promotion, shipping policy, warranty). Scanned: 1115 titles, 1317 groups, 2594 values. Ids and class only; the refused text is not written here.

| handle | queue_position | field | value_source_id | class | covered_by |
|---|---|---|---|---|---|
| ams-2-pro | 4 | $.groups[1].values[5].name_en | 758126084595167233 | promotion | value_labels |

`hold_code` cannot park such an item (0195 allows only '', OWNER_HIDDEN, ORDER_TYPE_WORD), and an unparked refusal is BLOCKED `PAYLOAD_REFUSED` at its turn, which stops the run. Each hit therefore carries a reviewed neutral label in its manifest row (`value_labels`, ar/en/ckb, owner question P0-11). Uncovered: 0. The step-4 package's own report (`parse-report.json`) refuses the same single value.

Cross-check with the real TypeScript code (`work/step4/check.ts`, imports from the step-4 package, no network): `classifySentence` with `payload.ts`'s sentence split over the same 1115 titles, 1317 groups and 2594 values finds 1 hit(s), the same as the port. On `ams-2-pro`, applying the label to the value's names, variant label and source label is not enough: `assertImportPayload` still refuses `refused_text:promotion at $.images[].alt_en` — the alt text of 3 image rows carries the value as its selection label (one representative row, two variant rows "<printer> / <value>"). With the label applied in the option model before media binding (names, variant label, source label and those alt texts) the whole payload passes: `ok`. See owner-questions.md §E item 1.

## 3. Composite cells (§C.6 labelled sub-value parser)

27 distinct composite cells on 18 products:

| handle | label | segments | excerpt |
|---|---|---|---|
| a1-mini | Physical Dimensions | 3 | A1 mini : 347*315*365 mm³ , Package size : 385*430*460 mm³ , Net weight 5.5 kg , Gross weight 8.2 kg ⏎ A1 mini C |
| a1 | Physical Dimensions | 5 | A1 : 465*410*430 mm³ , Package size : 596*536*325 ⏎ mm³ , Net weight 8.3 kg , Gross weight 13 kg ⏎ A1 Combo : Pack |
| side-panel-with-glass-window | Packaging Weight | 2 | Left - 1.958 kg ⏎ Right - 2.256 kg |
| laser-safety-window | Packaging Weight | 4 | Left Side Panel - 1.925 kg ⏎ Right Side Panel - 2.1 kg ⏎ Side Panel - 2.492 kg ⏎ Front Laser Safety Window - 2.1 kg |
| h2d | Build Volume (W*D*H) | 3 | Single Nozzle Printing: 325*320*325 mm³ ⏎ Dual Nozzle Printing: 300*320*325 mm³ ⏎ Total Volume for Two Nozzles: 35 |
| h2d | Physical Dimensions | 2 | 492*514*626 mm³(Package Size: 580*605*750mm) ⏎ 700*700*1100 mm³ (Recommended Space for Printer) |
| h2d | Net Weight | 4 | 31 kg ⏎ (Gross weight: H2D: 40.6 kg; H2D AMS Combo: 44.2 kg; ⏎ H2D Laser Full Combo: 48.2 kg) |
| h2s | Net Weight | 7 | H2S: 30 kg ⏎ H2S Laser Edition: 30.5 kg ⏎ (Gross weight: H2S: 39.2 kg; H2S AMS Combo: 42.6 kg; H2S Laser Full Comb |
| p2s | Physical Dimensions | 3 | 392*406*478 mm³ ⏎ Package Size: 490*490*560 mm³ ⏎ Recommended Space for Printer: 500mm*500mm*950mm |
| p2s | Weight | 6 | P2S ⏎ Net Weight: 15.0kg ⏎ Gross weight: 18.58kg ⏎ P2S Combo (AMS 2 Pro included) ⏎ Net Weight: 16.4kg ⏎ Gross weight: 2 |
| h2c | Build Volume (W*D*H) | 4 | Single Nozzle Printing: 325*320*320 mm³ (Left) ⏎ Single Nozzle Printing: 305*320*325 mm³ (Right) ⏎ Dual Nozzle Pri |
| h2c | Net Weight | 4 | 32.5 kg ⏎ (Gross Weight: H2C AMS Combo 44.7 kg; H2C Laser Full Combo-10W 49.0kg; ⏎ H2C Laser Full Combo-10W 49.5 k |
| x2d | Build Volume (W*D*H) | 4 | Main Nozzle Printing: 256*256*260 mm³ ⏎ Auxiliary Nozzle Printing: 235.5*256*256 mm³ ⏎ Dual Nozzle Printing: 235.5 |
| refurbished-a1 | Physical Dimensions | 3 | A1 : 385*410*430 mm³ , Package size : 596*536*325 mm³ , Net weight 8.3 kg , Gross weight 13 kg ⏎ A1 Combo : Pack |
| refurbished-x1c | Physical Dimensions | 5 | X1C：389 × 389 × 457 mm³ ⏎ Package size 480 × 480 × 535 mm³ ⏎ Net weight 14.13kg,Gross weight 18kg ⏎ X1C Combo：Packag |
| refurbished-bambu-lab-h2d-3d-printer | Build Volume (W*D*H) | 3 | Single Nozzle Printing: 325*320*325 mm³ ⏎ Dual Nozzle Printing: 300*320*325 mm³ ⏎ Total Volume for Two Nozzles: 35 |
| refurbished-bambu-lab-h2d-3d-printer | Physical Dimensions | 2 | 492*514*626 mm³(Package Size: 580*605*750mm) ⏎ 700*700*1100 mm³ (Recommended Space for Printer) |
| refurbished-bambu-lab-h2d-3d-printer | Net Weight | 4 | 31 kg ⏎ (Gross weight: H2D: 40.6 kg; H2D AMS Combo: 44.2 kg; ⏎ H2D Laser Full Combo: 48.2 kg) |
| refurbished-bambu-lab-p2s-3d-printer | Physical Dimensions | 3 | 392*406*478 mm³ ⏎ Package Size: 490*490*560 mm³ ⏎ Recommended Space for Printer: 500mm*500mm*950mm |
| refurbished-bambu-lab-p2s-3d-printer | Weight | 6 | P2S ⏎ Net Weight: 15.0kg ⏎ Gross weight: 18.58kg ⏎ P2S Combo (AMS 2 Pro included) ⏎ Net Weight: 16.4kg ⏎ Gross weight: 2 |
| r1 | Working area | 2 | Standalone: 600×300mm ⏎ With Conveyor: 600×3000mm |
| r1 | Space required | 8 | Standalone: W940 × D660 × H650mm (lid open). Allowing 100mm of clearance on the left, right, rear, and top: 11 |
| bambu-lab-a1-combo-starter-kit | Physical Dimensions | 3 | A1 : 385*410*430 mm³ , Package size : 596*536*325 mm³ , Net weight 8.3 kg , Gross weight 13 kg ⏎ A1 Combo : Pack |
| bambu-lab-p2s-combo-starter-kit | Physical Dimensions | 3 | 392*406*478 mm³ ⏎ Package Size: 490*490*560 mm³ ⏎ Recommended Space for Printer: 500mm*500mm*950mm |
| bambu-lab-p2s-combo-starter-kit | Weight | 6 | P2S ⏎ Net Weight: 15.0kg ⏎ Gross weight: 18.58kg ⏎ P2S Combo (AMS 2 Pro included) ⏎ Net Weight: 16.4kg ⏎ Gross weight: 2 |
| bambu-lab-x2d-combo-starter-kit | Build Volume (W*D*H) | 4 | Main Nozzle Printing: 256*256*260 mm³ ⏎ Auxiliary Nozzle Printing: 235.5*256*256 mm³ ⏎ Dual Nozzle Printing: 235.5 |
| riser-base | Working Area | 2 | R1: 600*300 mm ⏎ With Conveyor: 600*3000 mm |

Source anomalies to keep as published (with a `spec_sources_disagree` / review note, never "fixed"): H2C gross weight lists "H2C Laser Full Combo-10W" twice (49.0 kg and 49.5 kg); the A1 product size is 465×410×430 mm on `a1` but 385×410×430 mm on `refurbished-a1` and the A1 starter kit.

## 4. US / region tables (§C.6 region rule)

| handle | type | hits | matches |
|---|---|---|---|
| p1s | printer | 2 | @110V |
| h2d | printer | 5 | 100-120 V, @110 V, purchase the version corresponding to your region |
| h2s | printer | 5 | 100-120 V, @110 V, purchase the version corresponding to your region |
| p2s | printer | 6 | 100-120 V, @110 V, purchase the version corresponding to your region |
| h2c | printer | 5 | 100-120 V, @110 V, purchase the version corresponding to your region |
| mini-heat-press | accessory | 2 | 110V, 110~240V |
| x2d | printer | 6 | 100 – 120 V, 100-120 V, @110 V, purchase the version corresponding to your region |
| a2l | printer | 2 | 100-120 V, @110 V |
| refurbished-p1s | printer | 2 | @110V |
| refurbished-x1c | printer | 2 | @110V |
| refurbished-bambu-lab-h2d-3d-printer | printer | 4 | 100-120 V, @110 V, purchase the version corresponding to your region |
| refurbished-bambu-lab-p2s-3d-printer | printer | 5 | 100-120 V, @110 V, purchase the version corresponding to your region |
| bambu-lab-p2s-combo-starter-kit | printer | 6 | 100-120 V, @110 V, purchase the version corresponding to your region |
| bambu-lab-x2d-combo-starter-kit | printer | 6 | 100 – 120 V, 100-120 V, @110 V, purchase the version corresponding to your region |

The 8 `Electrical Requirements` rows ("Please purchase the version corresponding to your region's voltage…") are region evidence, not specs.

## 5. Spec-label coverage (draft registry `p0/tools/registry.py`)

- Label occurrences 5414; mapped 5124 (**94.6 %**).
- Distinct labels 609; mapped 361; unknown 248 (each becomes `x.<slug>`, `unverified`).
- Products without any spec-table row: 259 (filaments by design — TDS only — plus parts and kits whose page has no table).
- Matrix tables kept as text (not key/value): `support-for-pa-pet` (Parameters Comparison), `p1s` (Parameters Comparison), `refurbished-p1s` (Parameters Comparison).
- Labels over 80 characters (a value printed in the label cell): `h2d`, `refurbished-bambu-lab-h2d-3d-printer`.

### Top 50 unknown labels

| # | label | occurrences | products | example | value | proposed_key |
|---|---|---|---|---|---|---|
| 1 | shape | 17 | 16 | round-magnet | Disc | x.shape |
| 2 | electrical requirements | 8 | 8 | h2d | Please purchase the version correspondin | x.electrical_requirements |
| 3 | l length | 3 | 3 | rectangle-dual-lock-3m-sj3550-reclosable-fastener-mounting-tape | 100 | x.l_length |
| 4 | specification | 2 | 2 | xy-belt | GT2 | x.specification |
| 5 | connectivity | 2 | 2 | wireless-mouse-components-kit-002 | Wireless, 2.4G USB Receiver | x.connectivity |
| 6 | led board type | 2 | 1 | 3030-5v-led-board-with-sh1-0-connector | 3030 LED | x.led_board_type |
| 7 | rate of fire | 2 | 2 | electric-water-spray-kit-02 | 8 round/s | x.rate_of_fire |
| 8 | lanyard circumference | 2 | 1 | adjustable-hand-wrist-strap | 32cm | x.lanyard_circumference |
| 9 | supported filament type | 2 | 2 | h2s | PLA, PETG, TPU, PVA, BVOH, ABS, ASA, PC, | x.supported_filament_type |
| 10 | main extruder gear | 2 | 2 | x2d | Hardened Steel | x.main_extruder_gear |
| 11 | main extruder motor | 2 | 2 | x2d | Bambu Lab High-precision Permanent Magne | x.main_extruder_motor |
| 12 | auxiliary extruder gear | 2 | 2 | x2d | Hardened Steel | x.auxiliary_extruder_gear |
| 13 | auxiliary extruder motor | 2 | 2 | x2d | Stepper Motor | x.auxiliary_extruder_motor |
| 14 | main hotend | 2 | 2 | x2d | PLA, PETG, ABS, ASA, TPU, Support for PL | x.main_hotend |
| 15 | auxiliary hotend | 2 | 2 | x2d | PLA (excluding PLA Aero), PETG, ABS, ASA | x.auxiliary_hotend |
| 16 | auxiliary hotend (print with caution) | 2 | 2 | x2d | PLA Silk, PETG-CF, ASA-CF, PA6-CF, TPU f | x.auxiliary_hotend_print_with_caution |
| 17 | steady-state power | 2 | 2 | x2d | PLA (25 °C): 250 W@110 V ⏎ PC (25 °C): 550 | x.steady_state_power |
| 18 | working area | 2 | 2 | r1 | Standalone: 600×300mm ⏎ With Conveyor: 600 | x.working_area |
| 19 | software | 2 | 1 | r1 | Software | x.software |
| 20 | parameter | 2 | 2 | riser-base | Specification | x.parameter |
| 21 | screen ratio | 1 | 1 | high-resolution-screen | 16:09 | x.screen_ratio |
| 22 | external interface | 1 | 1 | high-resolution-screen | Micro SD card | x.external_interface |
| 23 | rotating angle | 1 | 1 | high-resolution-screen | 5°-55° | x.rotating_angle |
| 24 | feature | 1 | 1 | glue-stick-for-build-plate | Water dissolvable | x.feature |
| 25 | life cycle | 1 | 1 | glue-stick-for-build-plate | 24 months | x.life_cycle |
| 26 | cable width | 1 | 1 | display-connector-flex-cable | 24 mm | x.cable_width |
| 27 | lcd type | 1 | 1 | p1-series-screen | FSTN/NEGATIVE/TRANSMISSIVE | x.lcd_type |
| 28 | module power consumption | 1 | 1 | p1-series-screen | 2.45mW@3.3V | x.module_power_consumption |
| 29 | recommended viewing direction | 1 | 1 | p1-series-screen | 12:00 | x.recommended_viewing_direction |
| 30 | backlight type | 1 | 1 | p1-series-screen | LED | x.backlight_type |
| 31 | viewing area (wh) | 1 | 1 | p1-series-screen | 67.6*23.19 | x.viewing_area_wh |
| 32 | active area (wh) | 1 | 1 | p1-series-screen | 66.6*22.19 | x.active_area_wh |
| 33 | humidity | 1 | 1 | p1-series-screen | 90%RH max @(60℃ max) | x.humidity |
| 34 | number of dots | 1 | 1 | p1-series-screen | 192*64 | x.number_of_dots |
| 35 | constrast ratio | 1 | 1 | p1-series-screen | Cr=50 Typical | x.constrast_ratio |
| 36 | luminance uniformity | 1 | 1 | p1-series-screen | 70%min | x.luminance_uniformity |
| 37 | surface luminance | 1 | 1 | p1-series-screen | 80 cd/m^2 Typical | x.surface_luminance |
| 38 | viewing angle range | 1 | 1 | p1-series-screen | 35deg Typical | x.viewing_angle_range |
| 39 | package volume | 1 | 1 | liquid-glue-for-build-plate | 60 mL | x.package_volume |
| 40 | button | 1 | 1 | wireless-mouse-components-kit-002 | Silence Button | x.button |
| 41 | dpi | 1 | 1 | wireless-mouse-components-kit-002 | 800-1200-1600 | x.dpi |
| 42 | hardware platform | 1 | 1 | wireless-mouse-components-kit-002 | PC, Mac | x.hardware_platform |
| 43 | sensor | 1 | 1 | wireless-mouse-components-kit-002 | Optical | x.sensor |
| 44 | operating systems | 1 | 1 | wireless-mouse-components-kit-002 | Windows, Linux, Mac OS | x.operating_systems |
| 45 | power source | 1 | 1 | wireless-mouse-components-kit-002 | Battery Source | x.power_source |
| 46 | batteries | 1 | 1 | wireless-mouse-components-kit-002 | AA battery * 1 required (not included) | x.batteries |
| 47 | resolution | 1 | 1 | touch-screen-a1-mini | 240(W)*3(RGB)*320(H) | x.resolution |
| 48 | display color | 1 | 1 | touch-screen-a1-mini | 262K Colors | x.display_color |
| 49 | active area | 1 | 1 | touch-screen-a1-mini | 36.72(W)*48.96(H) mm | x.active_area |
| 50 | led life time | 1 | 1 | touch-screen-a1-mini | 30,000 Hours | x.led_life_time |

## 6. Media review list (same file name, different upload)

P0 fetched no image bytes (no network); content hashes are computed at /media. File-name evidence only.

| handle | file_name | gallery_indexes | distinct_urls | any_variant_bound |
|---|---|---|---|---|
| a1 | A1-compressed.jpg | [0, 3] | 2 | True |
| a1 | A1_C-compressed.jpg | [1, 4] | 2 | True |
| potentiometer-board-with-sh1-0-connector | IA007.png | [0, 1] | 2 | True |
| pc4-m6-pneumatic-connector-for-ptfe-tube | FC001.png | [0, 1] | 2 | True |
| wind-up-walking-mechanisms | MD001.png | [2, 3] | 2 | False |
| birch-plywood | birch.png | [1, 3] | 2 | False |
| ams-2-pro | ams.jpg | [3, 6] | 2 | False |
| h2d | H2D-compressed.jpg | [0, 5] | 2 | True |
| h2d | H2DC-compressed.jpg | [1, 6] | 2 | True |
| h2d | H2DL-10w-compressed.jpg | [2, 7] | 2 | True |
| h2d | 1.jpg | [10, 11] | 2 | False |
| h2d | 3.jpg | [12, 15] | 2 | False |
| cyberbrick-hardware-kit | CyberBrick_beginner_Kit.png | [0, 11] | 2 | False |
| pla-tough-upgrade | PLA_Tough_(2).jpg | [0, 7] | 2 | True |
| white-matte-printable-vinyl-sticker-paper-25pcs | Matte_Printable_Vinyl__Sticker_Paper.png | [0, 2] | 2 | True |
| x-axis-assembly-p2s | FAC172.jpg | [0, 1] | 2 | True |
| mag-alloy-scraper | 4.png | [3, 4] | 2 | False |
| cyberbrick-truck-fleet | 1.png | [0, 5] | 2 | False |
| helixcore-–-press-to-spin-squishy-ball | B-ZH171-1.jpg | [0, 1] | 2 | True |
| 360-rotating-capsule-lamp | B-ZH159.png | [0, 1] | 2 | False |
| refurbished-a1 | A1-compressed.jpg | [0, 2] | 2 | True |
| refurbished-x1c | X1C.jpg | [2, 3] | 2 | False |
| diy-framework-for-ams-lite | B-ZH130.png | [0, 4] | 2 | True |
| refurbished-bambu-lab-h2d-3d-printer | 1.jpg | [1, 2] | 2 | False |
| refurbished-bambu-lab-h2d-3d-printer | 3.jpg | [3, 6] | 2 | False |

- Same URL twice in one gallery: 0.
- Variants with no hero image: `ams-multicolor-printing` (13); `ptfe-tubes` (1); `plastic-deep-groove-ball-bearings` (1); `h2d-pro` (1); `accessory-box-for-h2d` (1); `360-rotating-capsule-lamp` (1); `electric-train` (1).
- Variant hero not in the gallery: 0.
- Binding rules over the corpus (P0 file-level, §C.4): variant 2223, general 1522, representative 1455, value_set 74, value 90.
- Description images over the 40 cap (L-2): `p2s` 128, `h2c` 119, `refurbished-bambu-lab-p2s-3d-printer` 128, `bambu-lab-p2s-combo-starter-kit` 128.
- `store-test.bblcdn.com` references: 0.

### Override candidates by file name (NOT applied; `media-overrides.json` stays empty until a visual review)

| handle | image_file | candidate_value | group | score |
|---|---|---|---|---|
| m2-double-pass-knurled-brass-stud | M2x6_20PCS_356d4f67-9455-4e1e-8fd8-dbf68c1328d7.png | M2x6 Double-pass Knurled Brass Stud (20PCS) - AD001 | Size | 0.67 |
| round-threaded-brass-heat-insert-nut | M2x3.5x4_20PCS.png | M2x3.5x4 Round Threaded Brass Heat-Insert Nut (20PCS) - AB009 | Size | 0.75 |
| hotend-heating-assembly-h2d-and-h2c | FAH028_Hotend_Heating_Assembly_-_Left_(3).png | Left | Version | 1.0 |
| filament-cutter-stopper | FAC102_Filament_Cutter_Stopper_-_Right_(2).png | Right | Version | 1.0 |
| birch-plywood | Birch_Plywood_-_YA002.png | 3mm Birch Plywood (6pcs) - YA002 | Quantity | 1.0 |
| bambu-basswood-plywood | Basswood_Plywood_-_YA001.png | 3mm Basswood Plywood (6pcs) - YA001 | Quantity | 1.0 |
| h2d | AMS_2_Pro.jpg | Dual AMS 2 Pro Bundle | Option | 0.75 |
| h2d | AMS_HT.jpg | AMS HT bundle | Option | 1.0 |
| bambu-lab-stickers | B-MG001-1-1.jpg | Bambu Lab Stickers - MG001 | Item | 1.0 |
| bambu-lab-stickers | B-MG001-models.png | Bambu Lab Stickers - MG001 | Item | 1.0 |
| ws2812-rgb-led-with-idc0-8-4pin-2pcs | B-KB003.png | WS2812 RGB LED with IDC0.8 4PIN (2PCS) - KB003 | Item | 1.0 |
| ws2812-led-hub-with-3pin-sh1-0-connector-1pcs | B-XA006.png | WS2812 LED Hub with 3Pin SH1.0 Connector (1PCS) - XA006 | Item | 1.0 |
| ws2812-led-hub-with-3pin-sh1-0-connector-1pcs | B-XA006-2.png | WS2812 LED Hub with 3Pin SH1.0 Connector (1PCS) - XA006 | Item | 1.0 |
| cyberbrick-timelapse-kit | ZK005-F.png | CyberBrick Time-lapse Kit - ZK005 | Select your printer series | 1.0 |
| cyberbrick-timelapse-kit | ZK005-D.png | CyberBrick Time-lapse Kit - ZK005 | Select your printer series | 1.0 |
| obxidian-high-flow-hotend | E3D_Complete_Hotend_0.4_2.png | Complete Hotend | Hotend Type | 1.0 |
| handheld-vacuum-cleaner-kit | ZC011.png | Handheld Vacuum Cleaner Kit - ZC011 | Item | 1.0 |
| handheld-vacuum-cleaner-kit | ZC011_B.png | Handheld Vacuum Cleaner Kit - ZC011 | Item | 1.0 |
| handheld-vacuum-cleaner-kit | ZC011_C.png | Handheld Vacuum Cleaner Kit - ZC011 | Item | 1.0 |
| handheld-vacuum-cleaner-kit | ZC011_D.png | Handheld Vacuum Cleaner Kit - ZC011 | Item | 1.0 |
| handheld-vacuum-cleaner-kit | ZC011_H.png | Handheld Vacuum Cleaner Kit - ZC011 | Item | 1.0 |
| handheld-vacuum-cleaner-kit | ZC011_F.png | Handheld Vacuum Cleaner Kit - ZC011 | Item | 1.0 |
| handheld-vacuum-cleaner-kit | ZC011_G.png | Handheld Vacuum Cleaner Kit - ZC011 | Item | 1.0 |
| handheld-vacuum-cleaner-kit | ZC011_E.png | Handheld Vacuum Cleaner Kit - ZC011 | Item | 1.0 |

## 7. In-the-box images

24 products carry 176 in-the-box images; over the 30 cap: 0.

| handle | images | items |
|---|---|---|
| h2c | 23 | 20 |
| ams-multicolor-printing | 16 | 0 |
| h2s | 14 | 14 |
| ams-lite | 13 | 0 |
| refurbished-a1 | 13 | 0 |
| bambu-lab-a1-combo-starter-kit | 13 | 0 |
| p1s | 12 | 0 |
| a1-mini | 12 | 0 |
| a1 | 12 | 11 |
| refurbished-p1s | 12 | 0 |
| ams-hub | 7 | 0 |
| support-for-pa-pet | 4 | 0 |
| cyberbrick-hardware-kit | 4 | 0 |
| refurbished-x1c | 4 | 0 |
| p2s | 3 | 6 |

## 8. Tracker links (`e.bambulab.com/t?c=…`)

340 tracker links on 328 products (one HEAD each at ENRICH, no redirect followed). Link texts: "Bambu Lab Wiki" 314, "here" 15, "Wiki" 5, "Here" 3, "wiki" 1, "R1" 1. Full list in `scans.json` → `tracker_links`.

## 9. Wiki links

374 products link 451 distinct wiki URLs; 6 products have more than 3 (only the first 3 are followed, L-21): `replacement-filament-cutter` 5, `ams-multicolor-printing` 6, `heatbed-signal-cable` 4, `ams-lite` 4, `laser-upgrade-kit` 7, `laser-module` 4.

Other documents: 359 PDF links, 260 model files (.zip/.3mf/.stl/.step), 58 YouTube videos, 233 MakerWorld links, 251 store links to rewrite to slugs or text.

## 10. Plan size (statements per `/write` invocation, §A.5 budget 900)

Method: tools/build.py plan(): reads 45 + media-verify chunks; batch = fixed 22 + memberships + 3G + 3V + 3N + 2I + swatches + search tokens(+2) + spec rows (incl. expected not_found) + documents + external ids + relations + fits + translation slots; post-commit 3. Median 158, max 906.

| handle | type | per_row_writes | multirow_side_inserts | values | variants | image_rows | search_tokens | external_ids |
|---|---|---|---|---|---|---|---|---|
| pla-basic-filament | filament | 906 | 643 | 33 | 43 | 51 | 264 | 116 |
| pla-matte | filament | 810 | 597 | 28 | 31 | 48 | 263 | 88 |
| wireless-inductive-coil-kit | makers_supply | 651 | 514 | 30 | 22 | 55 | 147 | 23 |
| micro-steel-deep-groove-ball-bearings | makers_supply | 631 | 512 | 25 | 25 | 52 | 226 | 26 |
| bambu-matte-heat-transfer-vinyl | laser_material | 621 | 500 | 15 | 11 | 27 | 156 | 22 |
| ptfe-tubes | spare_part | 603 | 463 | 27 | 44 | 33 | 158 | 45 |

**`pla-basic-filament` (audit class, queue position 5) is over 900** when every side row is its own statement; with multi-row side INSERTs (≤ 100 bound parameters each) it is ~643 and only it stays above 600. See owner-questions.md §E.

## 11. Relation collections over 400 rows (`MAX_ROWS_PER_COLLECTION`)

0 products. The largest are `pla-basic-filament` (51 image rows, 43 variants) and its peers — far below 400.

## 12. SKU codes harvested from the cross-sell payload (§C.1)

254 distinct cross-sell SKU entries (seen 579 more times); all matched a sitemap handle and one of its variant ids; frozen for 87 products / 254 variants; conflicts 0. Only `{id, productId, seoCode, skuCode}` were read.

## 13. Other findings

- Handle/title disagreements (identity from the title, never the handle): `glue-stick-for-build-plate` = "Glue Stick", `ams-multicolor-printing` = "Bambu Lab AMS - Automatic Material System", `liquid-glue-for-build-plate` = "Liquid Glue", `boat-model-components-kit-010` = "Boat Kit Collection", `usb-speed-controller-compatible-with-tt-motor` = "USB Speed Controller(1PCS) - IA002", `high-torque-drive-timing-belt` = "HTD Timing Belt", `stemfie-electronics-components` = "STEMFIE Projects", `black-aluminium-card-10pcs` = "Aluminum Card", `snapatrack` = "Snapa Track", `hwb-pumpkinfamily` = "Halloween Special Bundle - Pumpkin Family", `hwb-hauntedhouse` = "Halloween Special Bundle - Haunted House".
- Option-group kinds: printer 574, other 163, size 197, item 172, nozzle 8, units 3, version 51, color 55, spool 44, pack 45, plate 5. Group names with kind `other` (English label + `translation_review`): "Bundle", "Cable Type", "Combo", "Compatibility", "Device", "Do you have an AMS connected?", "Flow Type", "Hotend Type", "Laser Power", "Material", "Nozzle Diameter", "Option", "Options", "Processing Mode", "Product", "Quantity", "Select your printer series", "Time-lapse kit type", "Type", "Usage Type".
- Sentence classifier counts (§C.10, counts only): money 34 sentences / 20 products, promotion 27 sentences / 20 products, shipping_policy 127 sentences / 118 products, warranty 72 sentences / 49 products, region 32 sentences / 9 products.
- Compatibility: 45 atomic labels mapped, 7 reviewed-unresolvable, 110 raw strings; targets missing from the manifest: 0. "A1 Series" resolves per subject (24 by page evidence, 5 on the narrow default; P0-1); "A1/A2L" is reviewed to the atoms A1, A2L.
- Spec §C.4 golden test vs its own rule: on `ams-2-pro` gallery #0 is the hero of 13 variants that are exactly the union of the five "Connect …" values, so rule 2 (value_set) applies before the per-variant fallback — the golden test expects 13 variant rows. Step 4 must pick one.
- Spec §D.2 says the canary's route "already resolves it to `@parts-x1p1`"; route L2 `552709760676352000` is in fact the AMS feeder subtree (its other five members are AMS feeder parts), so `filament-buffer` needs, and has, a handle override quoting "Compatibility: X1 Series and P1 Series".
