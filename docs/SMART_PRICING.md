# Smart pricing for Bambu Lab products: estimated pre-order prices

**Final design, 2026-10-31.** Built on the "engine-native" proposal, with the safety rules of "safest" and several ideas from "estimate-layer" added, and every fatal flaw the judges found removed. Every file, function, column and constant named here was read in the codebase at `deb15586`. Where a claim comes from data rather than code, the source is named.

Symbols used throughout:

| Symbol | Meaning |
|---|---|
| U | USD→IQD rate (`fx.USD`) |
| E | EUR→USD rate |
| C | CNY→USD rate |
| T | Minimum profit in USD |
| R | Replacement cost in IQD |
| D | Direct price (the V2 anchor) |
| P_r | Pre-order price on route r |

The word "estimate" in this document always means the **customer-facing estimated price**. It has nothing to do with the owner-only frozen cost columns `order_items.estimated_cost_*` (0190) or with `worker/lib/printEstimate/`.

---

## Decisions taken

**The owner's request (2026-10-31):**

1. Find the official price of every Bambu Lab product and of the selected variant, option or colour.
   - Electronics (printers, AMS units, mainboards and similar) are priced from the EU (Germany) store in EUR and travel by land only, freight per kg.
   - Filament, accessories, parts and consumables are priced from the China store in CNY. Filament travels by sea only (per CBM); other items by sea or air.
2. Compute an estimated cost and price from that purchase price, the shop's existing exchange rates, freight, other expenses and the configured minimum profit. Sourcing, currency and freight follow the product category.
3. Every Bambu product becomes orderable as a pre-order at that price, shown as an **estimate** with a small label, a "final price may differ" notice and a small "Contact us for more information" link. Admins can review and correct the estimated cost and selling price.
4. Reuse the existing rates. Hard-code no price or rate. Stay flexible for new products, variants and colours. When weight or dimensions are missing, flag the product and never present an unreliable estimate as a confirmed price.

**The owner's answers (2026-10-31):**

| # | Question | Decision |
|---|---|---|
| D1 | May customers order at the estimate? | Yes. If the real price differs, the existing "approve the new price" step (migration 0140) asks them before anything extra is charged. |
| D2 | What if package weight or box is missing? | Use standard measures per product type (for example a 1 kg filament box). Flag the product for the owner, and still show the price as an estimate. |
| D3 | How is profit set? | A fixed minimum profit in USD per product type, set by the owner in admin. No percentage (keeps DECISIONS row 184(3)). **Amended 2026-11-05 (DECISIONS row 291):** a type may carry a profit ceiling, 0–100% of each SKU's own cost (the owner chose 3–10% per type), and each SKU then sells, from $5 up, at the highest dollar charm price ($x.99) at or under both today's price and that ceiling whose profit keeps one rounding step over its cost, and under $5 at the highest plain house price (250 IQD steps; whole dinars at or under 1,000) there that keeps it; where none fits, the lowest one that keeps it — never above today's price (§4.11). |
| D4 | Where do EU prices come from? | Read from the EU store in a browser, refreshable. The EU store sends visitors from Iraq to the US store, so the system accepts EUR snapshots when available, a US-store USD price as a flagged reference, and manual entry. |

**Standing rules that bind this design:**
- Every push to `claude/new-session-2hq4ci` is a live deploy through workflow 7.
- A migration may ship with its code, but every new read must tolerate the new table or column being absent.
- Every user-facing string exists in Arabic, English and Sorani, and a Sorani string is never a copy of the Arabic (DECISIONS row 183).

**How the three proposals were combined:**

| Topic | Final choice | Source |
|---|---|---|
| What an estimate is | An ordinary Pricing V2 cost-first price, written by `v2WriteStatements` in one atomic batch together with the product's pre-order structure and its import stock decision | engine-native |
| The public label | **A column on `products`** (`price_estimate`), set in the same batch as the first estimate price and cleared only by the owner's confirmation. Per-SKU exceptions exist only when the owner confirms a SKU. A SKU priced later by any other door is an estimate. | Fixes engine-native's per-SKU marks flaw; safest's product label, kept per-SKU |
| Checkout record | Not decided by a probe. A trigger on `order_items` refuses any line of a labelled product unless the checkout batch holds `estimate-checkout:<order>`. | Fixes engine-native's fail-open probe |
| Where orders wait | At «تم الاستلام» (`pending` / `received`). The owner cannot confirm, prepare, ship or book a courier until the final price is settled. The customer's own cancel stays open, and the stage sweep never picks these orders. | estimate-layer + safest's courier arm |
| Courier booking | Blocked by the gate trigger (`delivery_remote_id`). The courier door also checks before calling the courier. | safest |
| Which products the apply may restructure | Only import-created products with no stock, no fulfilment cells and no firm V2 price | Fixes engine-native's stocked-product flaw |
| Statement budget | At most 900 statements per invocation, counted with `countingD1` | Fixes engine-native's 5 × 600 > 1,000 |
| Acknowledgement | Must equal the notice version, not just a boolean | safest |
| Default measures | Written only to private `pricing_inputs`. The label cannot be removed while any SKU is priced from one. | safest |
| Supplier data | Source↔currency CHECK. Store captures record the page's real host and currency. Import-guard triggers protect the new tables. | estimate-layer |
| Kept out of the design | A third `price_status`, which breaks workflow 7's live probes; a parallel price table or sweep; estimate-only carts; admin-approved price cuts (offered to the owner as an option in row 282) | Judges' fatal flaws on estimate-layer |

---

## 1. Architecture in one paragraph

An owner-only **supplier price catalogue** holds dated snapshots of official Bambu Lab prices from three sources, plus the owner's typed or single-page prices:
- the Tmall store in CNY;
- the EU store in EUR;
- the US store in USD, used only as a reference.

A deterministic matcher maps each catalogue SKU onto a Levonis product, option, colour or SKU, using:
- the import's own identities (`product_external_ids`: `bambu_variant_id`, `bambu_sku_code`, `color_code`);
- store handles;
- Bambu colour and part codes;
- a short Chinese option dictionary.

Exact and high-confidence matches are confirmed automatically, and the high ones are listed for the owner to audit; the owner reviews the rest. An owner-edited **per-type table** holds, for each product type:
- sourcing and route (fixed by CHECKs: EU types use land, filament uses sea);
- default package weight and box;
- extra cost in IQD;
- minimum profit in USD.

All figures are NULL until the owner types them.

For each eligible product, a new module in `worker/lib/pricingEngine/estimate/` turns these inputs into the same V2 wire the product form sends: `{method:'cost', cost:{inputs, minimum_profit}}`. It evaluates the wire with the existing engine, at the rates of `loadPricingRates` only:

    desiredFor → evaluateDesired → evaluateV2Write → priceProductV2 → roundPriceIqd

The owner reviews the preview and applies it. Each product is written in **one atomic batch**, which:
1. makes the product pre-order-only on its type's one route (`planProductSave` statements as the V2-3b `structure`);
2. records the import stock decision `untracked`;
3. writes the V2 price through `v2WriteStatements`;
4. sets `products.price_estimate = 1`. A trigger allows this only while the batch holds `engine-price:<id>`.

From then on the product is an ordinary SELLABLE V2 product:
- FX-5 reprices it when rates or freight move, under the 15% / 30% holds;
- price requests are answered by the writer's own transitions;
- every customer surface shows the label, read from the product row that the price itself is read with.

At checkout, the batch:
- records each estimated line in `order_price_estimates`;
- requires an acknowledgement that equals the notice version;
- offers only wallet or cash on delivery.

A trigger on `order_items` makes this record impossible to skip. A gate trigger on `orders` keeps the order at «تم الاستلام» (no confirm, no preparation, no courier, no reopening) until every line is settled. The customer may cancel at any time until then. A financial admin settles each line in one of two ways:
- **same price:** the line is confirmed;
- **different price:** the existing 0140 proposal asks the customer to approve or reject. Its money rules are unchanged, and triggers carry the decision onto the lines.

The owner removes the label by confirming the product. A trigger forbids removing it while any SKU is still priced from a type-default measure.

**Invariants (each is pinned by a test in §10):**
- **I1. There is one price system.** Every estimate price is written by `v2WriteStatements`, and nothing else publishes a price.
- **I2. The label fails closed.** The label lives on `products` and is set in the batch that first prices the product. Every priced SKU of a labelled product is an estimate unless the owner made that SKU firm. If a read of the firm-SKU list fails, the product is labelled everywhere.
- **I3. An estimate sells only by pre-order.** It is paid only from the wallet or cash on delivery, and only after an acknowledgement that equals the current notice version.
- **I4. Every line of a labelled product is recorded at checkout.** The database refuses any other way in. The order cannot leave «تم الاستلام», be booked with a courier or be reopened until every recorded line is settled.
- **I5. Nothing extra is charged without approval.** A different final price is settled only through the 0140 proposal and the customer's approval.
- **I6. Supplier data stays with the owner.** Supplier prices, matches, type defaults, flags and breakdowns are owner-only. Customers see final prices and a boolean label.
- **I7. The import still writes no price.** It writes no price, cost or stock (DECISIONS row 239), and the database refuses any import-batch write to the new tables.
- **I8. Nothing is hard-coded.** Rates come only from `loadPricingRates`. No price, rate, measure or profit is hard-coded.

---

## 2. Schema / migrations

### 2.1 One additive migration: `migrations/0218_price_estimates.sql`

- **Number.** 0218 is the next number after `0217_creative_studio_planning.sql`. The same push moves `worker/lib/schemaVersion.ts`: `EXPECTED_MIGRATION` to `'0218_price_estimates.sql'` and `EXPECTED_MIGRATION_COUNT` from 210 to 211. If another migration lands first, the file is renumbered.
- **Additive only.** One defaulted column is added to `products` and one to `order_price_adjustments`, together with twelve new tables, their triggers and their seed rows. No table is rebuilt, no CHECK is widened and no existing row changes.
- **Re-runnable.** Every `CREATE` uses `IF NOT EXISTS` and every seed uses `INSERT OR IGNORE`, so `scripts/migrate-check.mjs --twice` re-runs the idempotent statements. `ALTER TABLE … ADD COLUMN` is excluded from the re-run by the harness itself.
- **One file on purpose.** The label, the order gate and the checkout guard must exist together in every database. Splitting them would allow a labelled product in a database with no gate.

**Grammar shorthand.** The file spells each grammar out in full, because SQLite has no macros.
- `DEC(x, n)` is the 0181 `supplier_cost_amount` grammar: `x GLOB '[0-9]*' AND x NOT GLOB '*[^0-9.]*' AND x NOT GLOB '*.*.*' AND x NOT GLOB '*.' AND length(x) <= n AND CAST(x AS REAL) > 0`.
- `USD6(x)` is the 0211 `amount_usd` grammar: `DEC(x, 13) AND x NOT GLOB '*.???????*' AND CAST(x AS REAL) <= 100000`.

### 2.2 The SQL

```sql
-- ======================================================================
-- (0) THE PUBLIC LABEL. NOT NULL DEFAULT 0: a database without this column
-- holds no labelled product, so a reader that finds the key absent answers
-- exactly what the column would say (tests/deployAheadOfMigrations.test.ts:
-- substitution, not degradation). PRODUCT_COLUMNS (productModel.ts) never
-- names it, so no product save ever writes it.
-- ======================================================================
ALTER TABLE products ADD COLUMN price_estimate INTEGER NOT NULL DEFAULT 0 CHECK (price_estimate IN (0,1));

-- ======================================================================
-- (1) SUPPLIER PRICE CATALOGUE — OWNER-ONLY
-- ======================================================================
CREATE TABLE IF NOT EXISTS supplier_price_snapshots (
  id TEXT PRIMARY KEY CHECK (id GLOB 'sps_*' AND length(id) <= 40),
  source TEXT NOT NULL CHECK (source IN ('tmall_cn','bambu_eu','bambu_us')),
  currency TEXT NOT NULL CHECK (currency IN ('CNY','EUR','USD')),
  price_basis TEXT NOT NULL DEFAULT 'list' CHECK (price_basis IN ('list','net_of_vat')),   -- recorded, never converted in code
  capture TEXT NOT NULL CHECK (capture IN ('browser_sweep','store_script','open_api')),
  captured_on TEXT NOT NULL CHECK (captured_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  captured_by TEXT NOT NULL DEFAULT '' CHECK (length(captured_by) <= 120),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count BETWEEN 0 AND 20000),
  sku_count  INTEGER NOT NULL DEFAULT 0 CHECK (sku_count BETWEEN 0 AND 200000),
  state TEXT NOT NULL DEFAULT 'loading' CHECK (state IN ('loading','complete','superseded','discarded')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
  -- A geo-redirected "EU" capture that carries USD can never be stored as EUR.
  CHECK ((source = 'tmall_cn' AND currency = 'CNY') OR (source = 'bambu_eu' AND currency = 'EUR') OR (source = 'bambu_us' AND currency = 'USD')),
  CHECK (state NOT IN ('complete','superseded') OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sps_current ON supplier_price_snapshots(source) WHERE state = 'complete';

CREATE TABLE IF NOT EXISTS supplier_price_items (
  snapshot_id TEXT NOT NULL REFERENCES supplier_price_snapshots(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 120),     -- Tmall item_id | store handle (stable across captures)
  url TEXT NOT NULL DEFAULT '' CHECK (length(url) <= 600),
  page_host TEXT NOT NULL DEFAULT '' CHECK (length(page_host) <= 120),   -- the host that actually served the page
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 400),           -- source language (Chinese on Tmall)
  name_en TEXT NOT NULL DEFAULT '' CHECK (length(name_en) <= 400),
  category TEXT NOT NULL DEFAULT '' CHECK (length(category) <= 40),
  sourcing_hint TEXT NOT NULL DEFAULT '' CHECK (sourcing_hint IN ('','EU_STORE_EUR','CHINA_CNY')),
  route_hint TEXT NOT NULL DEFAULT '' CHECK (route_hint IN ('','GERMANY_LAND','CHINA_SEA','CHINA_SEA_OR_AIR')),
  codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(codes_json) AND json_type(codes_json) = 'array' AND length(codes_json) <= 4000),
  props_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(props_json) AND length(props_json) <= 16000),
  PRIMARY KEY (snapshot_id, item_key)
);
CREATE TABLE IF NOT EXISTS supplier_price_skus (
  snapshot_id TEXT NOT NULL, item_key TEXT NOT NULL,
  sku_key TEXT NOT NULL CHECK (length(sku_key) BETWEEN 1 AND 120),       -- Tmall sku_id | store variant id
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json) AND json_type(options_json) = 'object' AND length(options_json) <= 2000),
  options_en_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_en_json) AND json_type(options_en_json) = 'object' AND length(options_en_json) <= 2000),
  codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(codes_json) AND json_type(codes_json) = 'array' AND length(codes_json) <= 2000),
  sku_code TEXT NOT NULL DEFAULT '' CHECK (length(sku_code) <= 120),     -- Bambu SKU code from store JSON-LD
  price TEXT NOT NULL CHECK (DEC(price, 24)),                            -- decimal TEXT, as captured
  price_label TEXT NOT NULL DEFAULT '' CHECK (length(price_label) <= 60),-- the label shown beside the price (Tmall: 优惠前)
  quantity INTEGER CHECK (quantity IS NULL OR quantity >= 0),
  pack_units INTEGER NOT NULL DEFAULT 1 CHECK (pack_units BETWEEN 1 AND 1000),          -- parsed at upload (10件装 → 10)
  net_weight_g INTEGER CHECK (net_weight_g IS NULL OR net_weight_g BETWEEN 1 AND 100000000), -- parsed at upload (1kg → 1000)
  PRIMARY KEY (snapshot_id, item_key, sku_key),
  FOREIGN KEY (snapshot_id, item_key) REFERENCES supplier_price_items(snapshot_id, item_key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS supplier_price_keys (                          -- the matcher's index, written at upload
  snapshot_id TEXT NOT NULL REFERENCES supplier_price_snapshots(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL CHECK (key_type IN ('color_code','part_code','sku_code','variant_id','handle','model_token','name_token')),
  key_value TEXT NOT NULL CHECK (length(key_value) BETWEEN 1 AND 120),
  item_key TEXT NOT NULL, sku_key TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (snapshot_id, key_type, key_value, item_key, sku_key)
);
CREATE INDEX IF NOT EXISTS ix_spk_lookup ON supplier_price_keys(key_type, key_value);

-- Keyed by SOURCE IDENTITY, not by snapshot: Tmall ids and store handles are
-- stable, so a confirmed match carries over to the next capture.
CREATE TABLE IF NOT EXISTS supplier_price_matches (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),              -- canonical skuComboKey; '' = the product itself
  source TEXT NOT NULL CHECK (source IN ('tmall_cn','bambu_eu','bambu_us')),
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 120),
  sku_key TEXT NOT NULL CHECK (length(sku_key) BETWEEN 1 AND 120),
  confidence TEXT NOT NULL CHECK (confidence IN ('exact','high','medium','low')),
  method TEXT NOT NULL CHECK (method IN ('variant_id','sku_code','part_code','color_code','handle','name','owner')),
  reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array' AND length(reasons_json) <= 2000), -- codes only
  units_per_offer INTEGER NOT NULL DEFAULT 1 CHECK (units_per_offer BETWEEN 1 AND 1000),
  state TEXT NOT NULL CHECK (state IN ('suggested','confirmed','rejected')),
  decided_by TEXT NOT NULL DEFAULT '', decided_at TEXT NOT NULL DEFAULT '',  -- 'auto' for an automatic confirmation
  found_in_snapshot TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), updated_at TEXT NOT NULL,
  CHECK (state = 'suggested' OR (decided_by <> '' AND decided_at <> '')),
  CHECK (units_per_offer = 1 OR (state = 'confirmed' AND decided_by NOT IN ('','auto'))),  -- a pack is divided only by the owner
  PRIMARY KEY (product_id, combo_key, source, item_key, sku_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_spm_confirmed ON supplier_price_matches(product_id, combo_key, source) WHERE state = 'confirmed';
CREATE INDEX IF NOT EXISTS ix_spm_source ON supplier_price_matches(source, item_key, sku_key);

CREATE TABLE IF NOT EXISTS supplier_price_manual (                        -- the owner's typed price, or one store page he read
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  amount TEXT NOT NULL CHECK (DEC(amount, 24)),
  currency TEXT NOT NULL CHECK (currency IN ('USD','EUR','CNY')),
  origin TEXT NOT NULL DEFAULT 'typed' CHECK (origin IN ('typed','store_page')),
  evidence_url TEXT NOT NULL DEFAULT '' CHECK (length(evidence_url) <= 600),
  evidence_host TEXT NOT NULL DEFAULT '' CHECK (length(evidence_host) <= 120),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  entered_by TEXT NOT NULL, entered_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (origin = 'typed' OR (evidence_url <> '' AND evidence_host <> '')),
  PRIMARY KEY (product_id, combo_key)
);

-- ======================================================================
-- (2) PER-TYPE DEFAULTS — OWNER-ONLY. Seeded WITHOUT any measure, cost or profit.
-- ======================================================================
CREATE TABLE IF NOT EXISTS price_estimate_types (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 2 AND 40 AND key NOT GLOB '*[^a-z_]*'),
  name_ar TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 80),
  name_en TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 80),
  name_ckb TEXT NOT NULL CHECK (length(name_ckb) BETWEEN 1 AND 80 AND name_ckb <> name_ar),
  sourcing TEXT NOT NULL CHECK (sourcing IN ('EU_STORE_EUR','CHINA_CNY')),
  route TEXT NOT NULL CHECK (route IN ('land','sea','air')),
  allow_air INTEGER NOT NULL DEFAULT 0 CHECK (allow_air IN (0,1)),
  us_reference_allowed INTEGER NOT NULL DEFAULT 0 CHECK (us_reference_allowed IN (0,1)),
  default_weight_g INTEGER CHECK (default_weight_g IS NULL OR default_weight_g BETWEEN 1 AND 100000000),
  default_length_mm INTEGER, default_width_mm INTEGER, default_height_mm INTEGER,
  default_cbm TEXT CHECK (default_cbm IS NULL OR DEC(default_cbm, 12)),
  additional_cost_iqd INTEGER CHECK (additional_cost_iqd IS NULL OR additional_cost_iqd BETWEEN 0 AND 1000000000),
  min_profit_usd TEXT CHECK (min_profit_usd IS NULL OR USD6(min_profit_usd)),
  stale_after_days INTEGER NOT NULL DEFAULT 60 CHECK (stale_after_days BETWEEN 1 AND 365),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  CHECK ((sourcing = 'EU_STORE_EUR') = (route = 'land')),                  -- electronics: EU store, land only
  CHECK (sourcing = 'CHINA_CNY' OR allow_air = 0),
  CHECK (route <> 'air' OR allow_air = 1),
  CHECK (key NOT IN ('filament','filament_pack') OR (route = 'sea' AND allow_air = 0)),  -- filament: sea only
  CHECK (sourcing = 'EU_STORE_EUR' OR us_reference_allowed = 0),
  CHECK ((default_length_mm IS NULL) = (default_width_mm IS NULL) AND (default_width_mm IS NULL) = (default_height_mm IS NULL)),
  CHECK (default_length_mm IS NULL OR (default_length_mm BETWEEN 1 AND 100000 AND default_width_mm BETWEEN 1 AND 100000 AND default_height_mm BETWEEN 1 AND 100000))
);
-- Seed (INSERT OR IGNORE, names in three languages, every figure NULL), see §4.1:
--   EU_STORE_EUR / land, us_reference_allowed 1: printer, ams, laser_machine, electronics_device, electronics_part
--   CHINA_CNY / sea, allow_air 0:                filament, filament_pack
--   CHINA_CNY / sea, allow_air 1:                spare_part, hotend, build_plate, accessory, makers_supply, laser_material

CREATE TABLE IF NOT EXISTS price_estimate_control (                       -- the owner's two switches
  id INTEGER PRIMARY KEY CHECK (id = 1),
  apply_enabled INTEGER NOT NULL DEFAULT 0 CHECK (apply_enabled IN (0,1)),
  ordering_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ordering_enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO price_estimate_control (id) VALUES (1);

-- ======================================================================
-- (3) THE ESTIMATE ON A PRODUCT (owner-only bookkeeping) AND ITS FIRM SKUs (public fact)
-- ======================================================================
CREATE TABLE IF NOT EXISTS product_price_estimates (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  type_key TEXT REFERENCES price_estimate_types(key),
  type_source TEXT NOT NULL DEFAULT '' CHECK (type_source IN ('','owner','supplier_category','import_type')),
  sourcing_override TEXT CHECK (sourcing_override IS NULL OR sourcing_override IN ('EU_STORE_EUR','CHINA_CNY')),
  route_override TEXT CHECK (route_override IS NULL OR route_override IN ('land','sea','air')),
  state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate','estimated','confirmed','paused')),
  measure_basis TEXT NOT NULL DEFAULT '' CHECK (measure_basis IN ('','real','type_default','mixed')),
  flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags_json) AND json_type(flags_json) = 'array' AND length(flags_json) <= 4000),
  preview_hash TEXT CHECK (preview_hash IS NULL OR length(preview_hash) = 64),
  computed_at TEXT,
  applied_at TEXT, applied_by TEXT, applied_write_seq INTEGER,
  applied_wire_json TEXT CHECK (applied_wire_json IS NULL OR (json_valid(applied_wire_json) AND length(applied_wire_json) <= 200000)),
  confirmed_at TEXT, confirmed_by TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  CHECK (state <> 'estimated' OR (type_key IS NOT NULL AND applied_at IS NOT NULL AND applied_wire_json IS NOT NULL)),
  CHECK (state <> 'confirmed' OR (confirmed_at IS NOT NULL AND measure_basis = 'real'))
);
CREATE INDEX IF NOT EXISTS ix_ppe_state ON product_price_estimates(state, updated_at);

CREATE TABLE IF NOT EXISTS price_estimate_lines (                         -- the last computed preview per SKU × channel (owner-only cache)
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  channel TEXT NOT NULL CHECK (channel IN ('pre_order_air','pre_order_sea','pre_order_land')),
  price_source TEXT NOT NULL CHECK (price_source IN ('tmall_cn','bambu_eu','bambu_us','typed','store_page','none')),
  supplier_amount TEXT, supplier_currency TEXT CHECK (supplier_currency IS NULL OR supplier_currency IN ('USD','EUR','CNY')),
  measure_source TEXT NOT NULL CHECK (measure_source IN ('model','colour','product','type_default','owner','none')),
  flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags_json) AND json_type(flags_json) = 'array' AND length(flags_json) <= 2000),
  est_cost_iqd INTEGER, est_price_iqd INTEGER, published_price_iqd INTEGER,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (product_id, combo_key, channel)
);

CREATE TABLE IF NOT EXISTS price_estimate_firm_skus (                     -- PUBLIC fact: the owner confirmed this SKU's price
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL,
  PRIMARY KEY (product_id, combo_key)
);

-- ======================================================================
-- (4) THE ORDER SIDE
-- ======================================================================
CREATE TABLE IF NOT EXISTS order_price_estimates (
  order_item_id TEXT PRIMARY KEY REFERENCES order_items(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  combo_key TEXT NOT NULL CHECK (length(combo_key) <= 400),
  channel TEXT NOT NULL CHECK (channel IN ('pre_order_air','pre_order_sea','pre_order_land')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  estimate_unit_iqd INTEGER NOT NULL CHECK (estimate_unit_iqd > 0),       -- the regular unit price the line was sold at
  notice_version INTEGER NOT NULL CHECK (notice_version > 0),             -- what the customer acknowledged
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','proposed','confirmed','approved','rejected','void')),
  final_unit_iqd INTEGER CHECK (final_unit_iqd IS NULL OR final_unit_iqd > 0),
  adjustment_id TEXT,
  decided_by TEXT NOT NULL DEFAULT '', decided_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (state NOT IN ('proposed','approved','rejected') OR adjustment_id IS NOT NULL),
  CHECK (state NOT IN ('proposed','confirmed','approved','rejected') OR final_unit_iqd IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_ope_open ON order_price_estimates(order_id) WHERE state IN ('open','proposed','rejected');
CREATE INDEX IF NOT EXISTS ix_ope_order ON order_price_estimates(order_id);

ALTER TABLE order_price_adjustments ADD COLUMN reason_code TEXT NOT NULL DEFAULT ''
  CHECK (reason_code IN ('','ESTIMATE_FINAL_PRICE'));

-- ======================================================================
-- (5) TRIGGERS
-- ======================================================================
-- T1. The label is SET only inside a price write: the V2 writer holds 'engine-price:<id>' (v2/write.ts step 3 → end).
CREATE TRIGGER IF NOT EXISTS trg_products_price_estimate_set BEFORE UPDATE OF price_estimate ON products
FOR EACH ROW WHEN NEW.price_estimate = 1 AND OLD.price_estimate = 0
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'engine-price:' || NEW.id)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LABEL_OUTSIDE_PRICE_WRITE'); END;
-- T2. The label is CLEARED only by the owner's confirmation, recorded in the same batch, with no default measure left.
CREATE TRIGGER IF NOT EXISTS trg_products_price_estimate_clear BEFORE UPDATE OF price_estimate ON products
FOR EACH ROW WHEN NEW.price_estimate = 0 AND OLD.price_estimate = 1
 AND NOT EXISTS (SELECT 1 FROM product_price_estimates e WHERE e.product_id = NEW.id AND e.state = 'confirmed' AND e.measure_basis = 'real')
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LABEL_CLEAR_REFUSED'); END;
-- T3. No product is born labelled (the import, a copy, a create).
CREATE TRIGGER IF NOT EXISTS trg_products_price_estimate_insert AFTER INSERT ON products
FOR EACH ROW WHEN NEW.price_estimate <> 0
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LABEL_OUTSIDE_PRICE_WRITE'); END;
-- T4. A firm SKU exists only on a labelled product.
CREATE TRIGGER IF NOT EXISTS trg_price_estimate_firm_ins BEFORE INSERT ON price_estimate_firm_skus
FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.price_estimate = 1)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_FIRM_UNLABELLED'); END;
-- T5. A product's overrides obey its type's rules (filament never by air; EU sourcing only by land).
CREATE TRIGGER IF NOT EXISTS trg_ppe_route_rule_ins BEFORE INSERT ON product_price_estimates
FOR EACH ROW WHEN (NEW.route_override = 'air' AND (NEW.type_key IN ('filament','filament_pack')
                     OR NOT EXISTS (SELECT 1 FROM price_estimate_types t WHERE t.key = NEW.type_key AND t.allow_air = 1)))
   OR (COALESCE(NEW.sourcing_override, (SELECT t.sourcing FROM price_estimate_types t WHERE t.key = NEW.type_key)) = 'EU_STORE_EUR'
       AND COALESCE(NEW.route_override, 'land') <> 'land')
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_TYPE_RULE'); END;
-- (trg_ppe_route_rule_upd: the same condition, BEFORE UPDATE OF type_key, sourcing_override, route_override.)

-- T6. Every order line of a labelled product goes through the estimate checkout: the checkout batch inserts
--     'estimate-checkout:<order id>' before its lines and deletes it after its estimate rows. An older Worker,
--     the community-store door or any other door cannot sell a labelled product at all.
CREATE TRIGGER IF NOT EXISTS trg_order_items_price_estimate_guard AFTER INSERT ON order_items
FOR EACH ROW WHEN NEW.product_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM products p WHERE p.id = NEW.product_id AND p.price_estimate = 1)
 AND NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'estimate-checkout:' || NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_CHECKOUT_REQUIRED'); END;
-- T7. Estimate rows are born with their order (checkout only) and their identity never changes.
CREATE TRIGGER IF NOT EXISTS trg_ope_insert_guard BEFORE INSERT ON order_price_estimates
FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.status = 'pending' AND o.stage = 'received' AND o.delivery_remote_id = '')
  OR NOT EXISTS (SELECT 1 FROM ops_guards g WHERE g.id = 'estimate-checkout:' || NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LINE_OUTSIDE_CHECKOUT'); END;
CREATE TRIGGER IF NOT EXISTS trg_ope_frozen BEFORE UPDATE OF order_item_id, order_id, product_id, combo_key, channel, qty, estimate_unit_iqd, notice_version ON order_price_estimates
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_LINE_FROZEN'); END;

-- T8. THE GATE: while a line is open, proposed or rejected, the order stays at «تم الاستلام» — no confirm,
--     no preparation, no shipping, no courier booking — whatever door moves it. Cancellation stays open.
CREATE TRIGGER IF NOT EXISTS trg_orders_price_estimate_gate BEFORE UPDATE OF status, stage, delivery_remote_id ON orders
FOR EACH ROW
WHEN ((NEW.status IS NOT OLD.status AND NEW.status NOT IN ('pending','cancelled'))
   OR (NEW.stage IS NOT OLD.stage AND NEW.stage NOT IN ('received','cancelled'))
   OR (NEW.delivery_remote_id IS NOT OLD.delivery_remote_id AND NEW.delivery_remote_id <> ''))
 AND EXISTS (SELECT 1 FROM order_price_estimates e WHERE e.order_id = NEW.id AND e.state IN ('open','proposed','rejected'))
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_UNCONFIRMED'); END;
-- T9. A cancelled order with estimate lines is never reopened (the customer places a new order; 0175's gift rule, same shape).
--     <> and not IS NOT, like 0175: a NULL fence (a lost deletion or refund race) must still fail on NOT NULL, the message its caller maps.
CREATE TRIGGER IF NOT EXISTS trg_orders_price_estimate_reopen BEFORE UPDATE OF status ON orders
FOR EACH ROW WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
 AND EXISTS (SELECT 1 FROM order_price_estimates e WHERE e.order_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'PRICE_ESTIMATE_REOPEN_REFUSED'); END;
-- T10. Cancellation voids the unsettled lines, whatever door cancels (customer, admin, expiry).
CREATE TRIGGER IF NOT EXISTS trg_orders_price_estimate_cancel AFTER UPDATE OF status ON orders
FOR EACH ROW WHEN NEW.status = 'cancelled' AND OLD.status IS NOT 'cancelled'
BEGIN
  UPDATE order_price_estimates SET state = 'void', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state IN ('open','proposed','rejected');
END;
-- T11. A 0140 decision reaches its lines, whatever door decided (web, Telegram, admin withdraw, customer cancel).
CREATE TRIGGER IF NOT EXISTS trg_price_adj_estimate_lines AFTER UPDATE OF state ON order_price_adjustments
FOR EACH ROW WHEN OLD.state = 'pending' AND NEW.state IN ('approved','rejected','withdrawn','void')
BEGIN
  UPDATE order_price_estimates
     SET state = CASE NEW.state WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' WHEN 'withdrawn' THEN 'open' ELSE 'void' END,
         adjustment_id  = CASE NEW.state WHEN 'withdrawn' THEN NULL ELSE adjustment_id END,
         final_unit_iqd = CASE NEW.state WHEN 'withdrawn' THEN NULL ELSE final_unit_iqd END,
         decided_by = COALESCE(NEW.decided_by, ''), decided_at = NEW.decided_at
   WHERE adjustment_id = NEW.id AND state = 'proposed';
END;

-- T12. THE IMPORT GUARD (DECISIONS row 239 in the database): for each of the twelve new tables,
--      trg_import_guard_<table>_{ins,upd,del} in the exact shape 0200 and 0211 re-emit:
--      BEFORE <verb> ON <table> WHEN EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch')
--      BEGIN SELECT RAISE(ABORT, 'IMPORT_FINANCIAL_WRITE_REFUSED'); END;
```

**Checked.** The block above was run through `node:sqlite`, with the shorthand expanded, against stub `products`, `orders`, `order_items`, `order_price_adjustments` and `ops_guards` tables. It parses (table CHECKs come after the columns, as SQLite requires), and T1–T11 refuse and propagate exactly as described here.

### 2.3 Why the triggers are safe beside 0140

The four batches in `worker/lib/orderPriceAdjust.ts` were read for this table. T11 fires only on the first UPDATE that leaves `pending`; none of the fence statements fires it.

| 0140 batch | What it writes to `state` | T11 |
|---|---|---|
| Propose fence | `pending → pending` | Does not fire |
| Approve claim | `pending → approved` | Fires |
| Approve final fence | `approved → approved`, or NULL, which aborts the whole batch, T11's effects included | Does not fire |
| `closeWithoutMoney` first statement | `pending → rejected / withdrawn` | Fires |
| `closeWithoutMoney` fence | `rejected → rejected` | Does not fire |
| `voidPendingPriceAdjustmentStatement` | `pending → void` | Fires |

Two more facts:
- `trg_orders_price_hold_freeze` (0140) and T8 are independent, and both must pass. The customer's cancel releases the hold and sets `cancelled`, which both allow.
- The 0140 approve batch never writes `status` or `stage`, so T8 never sees it.

### 2.4 Tolerating absence (CLAUDE.md rule 2)

| New read | When the migration is absent |
|---|---|
| `products.price_estimate`, read through the existing `SELECT *` of every listing, detail, cart and checkout row | The key is absent, which means not labelled. This is the column's own default, and no product can be labelled without the column. |
| The firm-SKU arm added to `skuRowsV2Sql` (`worker/lib/productOverlay.ts`) | On `no such table: price_estimate_firm_skus` the statement is re-run without the arm (today's statement), and the absence is remembered per binding for 60 s, as `listing.ts` `absentLately` does. |
| SQL exclusions `AND COALESCE(<a>.price_estimate, 0) = 0` (print materials, mystery and bundle candidates) | On `no such column: price_estimate` the statement is re-run without the clause, using a `withoutEstimateClause` helper modelled on `listing.ts` `withoutV2`. |
| Checkout | Nothing is probed. Estimate rows and the `estimate-checkout:` token are laid only for a labelled line, which cannot exist without the migration. The control row (`ordering_enabled`) is read only for a labelled line, and a failed read refuses with 503 `PRICE_ESTIMATES_READ_FAILED`: fail closed. |
| Stage doors' pre-check (`EXISTS order_price_estimates`) | "No such table" means no lines and no trigger. On the stage door, any other error lets the move proceed and the trigger decide. On the courier door, it refuses with 503 before the courier is called. |
| Expiry-sweep exclusion | Re-run without the clause only on `no such table: order_price_estimates`. |
| `order_price_adjustments.reason_code` | Read through `SELECT *`, so an absent key reads as `''`, which gives today's copy. Written only by estimate proposals. |
| Owner routes (supplier prices, estimates, order estimate panel) | 503 `PRICE_ESTIMATES_NOT_INSTALLED`, the shape of `PRICING_NOT_INSTALLED` in `adminPricing.ts`. Probed once per binding. |

### 2.5 An older Worker on the migrated database

If an older Worker serves a migrated database, it ignores the label and shows estimate prices as ordinary prices. It still cannot sell them: T6 refuses its order lines, because it never holds `estimate-checkout:`. It cannot confirm, prepare or ship an existing estimate order either, because T8 still holds the order. Customers are safe in a rollback, though without the label. Workflow 7 only deploys forward and workflow 51 is manual, so `docs/HANDOFF.md` records the one-line check before any revert: `SELECT COUNT(*) FROM products WHERE price_estimate = 1`.

---

## 3. Supplier price catalogue

### 3.1 The sources and what is on disk today

Checked on 2026-10-31.

| Source | State | Key facts |
|---|---|---|
| **Tmall (CNY)**, the official 拓竹官方旗舰店 store | Captured into `data/bambu-cn-prices/` (git-ignored). `list-2026-10-31.json` holds the store's 741 items with `id` and `title` only. `tools/assemble-snapshot.mjs` builds `tmall-store-2026-10-31.json` from `batches/batch-*.json`: all 741 items and 1,671 SKUs, 58 of them marked not for sale. Its v1 file (§3.3) has 737 items and 1,617 SKUs: the H3C printer and S1 scanner pre-launch listings, TPU 75A (not on sale yet) and one placeholder listing are left out. | Each batch record has `item_id`, `url`, `title`, `from_price_cny`, `hidden_price`, `props[]` and `skus[{sku_id, options{group:value}, price_cny, price_title, quantity}]`. `price_cny` is decimal text such as `"99"` or `"241"`. **`price_title` is the label printed beside the price (`"优惠前"`, "before discounts") or `null`. It is not a figure.** The assembler adds `category` (16 values), `sourcing`, `freight_route`, `codes`, `name_en` and `options_en` (`tools/enrich.mjs`). |
| **EU store (EUR)**, `eu.store.bambulab.com` | **Readable from Iraq when the address carries the store selector's skip-redirect parameter `?skr=yes`** (`https://eu.store.bambulab.com/products/h2d?skr=yes`). Without it, visitors from Iraq are sent to another region's store. A browser snapshot of the EU electronics (printers, AMS, laser, electronic parts; EUR from the JSON-LD offers) is being captured on 2026-10-31 into `data/bambu-eu-prices/` (untracked). `eu-electronics-list-2026-10-31.json` lists the 292 manifest products it targets (printer 18, ams 4, laser_machine 1, and the spare_part 251 and accessory 18 whose title or handle names an electronic part). `tools/assemble-snapshot.mjs` builds `eu-store-2026-10-31.json` (and a `.csv` twin) from `batches/batch-*.json` and the regular prices of the variants on sale (`strike/*.json`): 267 products and 359 variants. Its v1 file has 266 items and 358 SKUs. The store answers fast automated access with a Cloudflare challenge, so captures are slow and stop at a challenge. `scripts/supplier-prices/normalize-eu-snapshot.mjs` turns the snapshot into a v1 file (§3.3). | Each page carries the same schema.org JSON-LD as the US store: `ProductGroup.hasVariant[]` with `sku` (the store's variant id) and `offers {price, priceCurrency, availability, url}`. A variant's page is `https://eu.store.bambulab.com/products/<handle>?id=<variant id>`, for example `https://eu.store.bambulab.com/products/h2d?id=596571526982115329`. Among other fields, the snapshot keeps per product `handle`, `name`, `type`, `sourcing`, `freight_route` and `product_group_id`, and per variant `sku` (the variant id), `name`, `option_values` (the values only, in page order, without group names), `colour_code`, `price_eur` (a JSON number such as `1599` or `27.99`), `currency`, `availability` and `url`. **The ids are the EU store's own.** Handles are shared with the US store, but product and variant ids are not (H2D AMS Combo / Standard: EU `596571526982115329`, US `581025672340709385`), so an EU `sku_key` never equals the import's `bambu_variant_id`, which holds US ids. **During a sale the offer's `price` is the sale price and `offers.priceSpecification` carries the regular one (a `StrikethroughPrice`); every store reader writes the regular price** (the rule is in §13, "Review fixes"). An entry with a `referenceQuantity` is a unit price (per kg, per metre) and never the item's regular price: both copies of the rule skip it before its price is read, and a `referenceQuantity` of null counts as none. Whether the EUR price includes German VAT is open (282(a)). |
| **US store (USD)**, `us.store.bambulab.com` | Read by the import. Each page carries JSON-LD `ProductGroup.hasVariant[].offers {price, priceCurrency}` and `sku`. | `data/bambu-import/manifest.json` has 1,115 rows. By type: spare_part 568, makers_supply 342, accessory 72, filament 48, laser_material 41, printer 18, hotend 13, build_plate 8, ams 4, laser_machine 1. By sub-type: filament/pack 6, printer/refurbished 5, printer/starter_kit 3, accessory/ams_accessory 8. 87 rows carry `sku_codes` (variant id → SKU code, for example `A00-W1-1.75-1000-SPLFREE`). |

**What the import stores today** (`packages/catalog/src/bambuImport/payload.ts`, lines 1199–1205):
- `bambu_product_id` per product;
- `bambu_variant_id` and `bambu_sku_code` per variant;
- `color_code` per option value.

It writes no `part_code`, although the 0194 CHECK allows one. Spare-part matching against Tmall therefore leans on the codes Tmall prints in its titles (ZH122, QA018, KA004 and so on) and on names, which means more of it goes to owner review.

### 3.2 One file format: `levonis.supplier-prices.v1`

The pure parser is `packages/catalog/src/supplierPrices/format.ts`: `parseSupplierPriceFile(json): SupplierPriceFile`. It throws `SupplierPriceFormatError {path, reason}`.

```json
{ "format": "levonis.supplier-prices.v1",
  "source": "tmall_cn", "currency": "CNY", "price_basis": "list",
  "capture": "browser_sweep", "captured_on": "2026-10-31", "captured_by": "browser sweep",
  "items": [ { "item_key": "1053109777521", "url": "https://detail.tmall.com/item.htm?id=1053109777521",
     "page_host": "detail.tmall.com", "title": "拓竹 3D打印模型手捻钻… 创客宝库-ZH121", "name_en": "…",
     "category": "tool", "sourcing": "CHINA_CNY", "freight_route": "CHINA_SEA_OR_AIR", "codes": ["ZH121"], "props": [ … ],
     "skus": [ { "sku_key": "6264995743059", "options": {"商品规格": "手捻钻钻头套装（1套）"}, "options_en": { … },
                 "price": "40", "price_label": "优惠前", "quantity": 59, "sku_code": "" } ] } ] }
```

Parser rules:
- **Keys.** Keys are strict: an unknown key is refused by name. `source` must pair with `currency`, as the §2.2 CHECK does.
- **Prices.** A price is decimal text in the 0181 grammar. A JSON number is accepted only when its shortest decimal form has at most two decimals, because the engine refuses binary floats (`assertNoFloat` in `priceV2.ts`).
- **Limits.**
  - at most 20,000 items and 200 SKUs per item;
  - no duplicate `(item_key, sku_key)`;
  - each string within its column's limit.

A future Taobao Global Open Platform connector, which needs the owner's credentials, would emit the same file with `capture: "open_api"`.

### 3.3 Capture tools (scripts only; no production door)

| Script | What it does |
|---|---|
| `scripts/supplier-prices/normalize-tmall.mjs <tmall-store-YYYY-MM-DD.json>` | Converts the assembled Tmall snapshot to v1: `item_id → item_key`, `sku_id → sku_key`, `price_cny → price`, `price_title → price_label`. Items with `hidden_price` or with no SKU price are dropped and listed in its report. SKUs the capture marks `not_for_sale: true` (reminder options and parked 9999 / 99999 prices) are dropped and listed too (`not_for_sale`), and an item left with no SKU is dropped (`no_priced_sku`). A listing without options (no SKU rows and no option groups: one product at one price) is one SKU keyed by its own item id, with no options, at the page's price (`from_price_cny`, the capture's `price_source: "from_price"`); its option link is the item page (`links.ts`). It is kept only when it is an offer: a not-for-sale, placeholder, pre-launch or discontinued flag, a parked price (all 9s from 9999 up), a price range or a malformed price drops it, with the reason as the drop's `detail`. A listing whose SKUs were all refused never falls back to its page price. It writes `<name>.v1.json` beside the input. |
| `scripts/supplier-prices/normalize-eu-snapshot.mjs <eu-store-YYYY-MM-DD.json>` | Converts the EU browser snapshot (§3.1) to v1: `source "bambu_eu"`, `currency "EUR"`, `price_basis "list"` (the price as listed, 282(a)), `capture "browser_sweep"`, `captured_on` from the file. `handle → item_key`, `name → title` and `name_en`, `sourcing` and `freight_route` as recorded, `category` = the manifest type (`printer`, `ams`, `spare_part` …; `''` when unknown or outside the parser's grammar — §3.8 reads only the categories of CONFIRMED `tmall_cn` matches, so a store category never classifies a product), the handle percent-decoded, NFC-normalised and lower-cased (the import's `productHandleOf` rule), `sku → sku_key` (the variant id), `option_values → options` and `options_en` (the same object, because the store writes English, keyed by position `"option1"`, `"option2"`, … since the snapshot carries no group names, as the parser's header in `format.ts` says for store captures), `colour_code` into the SKU's `codes` when present (a positional key does not say which value is the colour), `price_eur → price` as decimal text (`1599` → `"1599"`, `27.99` → `"27.99"`; a value with more than two decimals is refused, never rounded). `page_host` is `eu.store.bambulab.com`; `sku_code` stays `""`, because the page carries no Bambu SKU code. An `OutOfStock` (or `SoldOut`) variant gets `quantity 0`; any other availability gives `null` (unknown). A variant whose `currency` is not `EUR`, or whose `url` host is not `eu.store.bambulab.com`, is refused, so a USD page is never labelled EUR. Products with no priced variant are dropped and listed in its report. It reads no network and writes `<name>.v1.json` beside the input. Exit codes of both normalisers: 0 written, 2 nothing priced (nothing written), 1 a refused or unreadable input. |
| `scripts/supplier-prices/capture-store-offers.ts --store us\|eu` | Reads the pages listed in `data/bambu-import/manifest.json` (`canonical_url`, rewritten to the requested store). Under `--store eu` every request carries `skr=yes` (robots.txt and same-origin redirect targets included, so a geo-redirected robots.txt never reads as "no rules"), added by the script's own wrapper around the `fetch` that `StoreFetcher` takes, so `scripts/bambu-import/**` stays unedited. It uses the import's own `StoreFetcher` (`scripts/bambu-import/fetch.ts`) with its `origin` option, so it keeps the import's robots handling, 11 s spacing (`STORE_SPACING_MS`) and User-Agent. `StoreFetcher` never follows a redirect off its origin: such a page stops with `SOURCE_WITHDRAWN`. An EU page that still redirects to another region's store is therefore listed as "redirected" and never captured. A challenge (`ACCESS_CHALLENGE`: a 403, a `cf-mitigated` header or a challenge body, `isChallenge` in `fetch.ts`) stops the run with what it has captured; the script never works around a challenge. The script parses JSON-LD `hasVariant[].offers` and records each page's host (`page_host`) and `priceCurrency`. A page whose `priceCurrency` does not match the requested store's currency is refused, so USD is never labelled EUR. A page can describe its product in several JSON-LD blocks (a theme's and an app's): the script reads the variants of every ProductGroup of the page's product (the first group's: the same `productGroupID`, else, when either block has none, the same `/products/<handle>` of its `url`), or, with no ProductGroup, every lone Product of the first Product's product, and never another product's. That first block is not compared with the requested handle: when another product's block comes first, its variants are written under the requested handle. A gathered block is checked as the first is: one offer in another currency or on another host refuses the whole page (`currency_mismatch`, `offer_host_mismatch`). A variant the page repeats (one key) follows the one-page read's rule (§3.6): copies of one value are one, a plain copy at another copy's sale price is that copy's sale, and any other disagreement refuses the variant as `copies_disagree` (in `refused_variants`, the copies' prices in `detail`), so nothing of it is written. Some shapes still read differently from the one-page read, and no stored page has any of them: the script reads only the first offer of a node's `offers` list, so a node that gives a variant two prices is written at the first (the one-page read saves nothing); on a page with a ProductGroup it reads no lone Product (the one-page read takes one of the same variant as a copy); it prices the first offer inside an `AggregateOffer`, and the variant of a `hasVariant` given as one object rather than a list, where the one-page read reads neither; it keys a variant by its digits `sku` before its offer's `?id=`, where the one-page read takes the `?id=` first; and it reads no other product's block, whose offers the one-page read answers beside the page's own. The script has no `duplicate_sku` reason any more; the two normalisers keep theirs. `sku_key` is the variant id: JSON-LD `hasVariant[].sku`, which is also the `?id=` of `offers.url`; the SKU code is used only when that is absent. The US reference is a separate `--store us` run. For the EU store the browser snapshot and `normalize-eu-snapshot.mjs` are the main path; this script is the fallback. Exit codes: 0 written, 3 stopped early by a challenge, a rate limit or the deadline (the partial file is written), 2 nothing captured, 1 bad arguments. |

**Recommendation (owner question 282(g)):** git-ignore `data/bambu-*-prices/`, because these files are the shop's cost basis. They are uploaded through the owner's door, not committed.

### 3.4 Ingestion: owner routes

The router is `worker/routes/adminSupplierPrices.ts`. It is mounted **inside** `adminPricingRoutes` (`worker/routes/adminPricing.ts`, `.route('/supplier-prices', …)`), so it inherits that router's door:

    requireAdmin → limitByMethod(['pricing-read', 1200], ['pricing-write', 600]) → requireCostRead

It also declares its own `use('*', requireCostRead)`, so `tests/costPredicateUsage.test.ts` `LATER_ROUTERS` can pin it, and every write calls `assertCostWrite`. The gateway already classes `/api/admin/pricing` as `admin:owner` (`services/gateway/src/routes.ts`), so the gateway needs no change.

| Route | Effect |
|---|---|
| `GET /snapshots` | Lists snapshots: source, date, state, counts, matched and unmatched counts, age. |
| `POST /snapshots` `{source, currency, price_basis, capture, captured_on, captured_by, file_sha256, item_count}` | Creates a snapshot in state `loading`. |
| `POST /snapshots/:id/items` `{items[≤50]}` | Runs the strict parser on the chunk, and refuses a chunk whose JSON exceeds 256 KB. It writes items, SKUs (with `pack_units` and `net_weight_g` parsed by `keys.ts`) and index keys through `INSERT … SELECT … FROM json_each(?)`: one bound parameter per statement, and no SQL function call with more than 32 arguments (`tests/fixtures/d1Limits.ts`). It is idempotent on the primary keys. |
| `POST /snapshots/:id/complete` `{item_count, sku_count, file_sha256}` | Checks the counts, then in one batch marks the snapshot `complete` and the source's previous `complete` snapshot `superseded` (the unique index `ux_sps_current` enforces this). |
| `POST /snapshots/:id/discard` | Discards a snapshot. Superseded snapshots beyond the newest three per source are deleted, and the delete cascades. |

The owner's browser reads the file, computes its SHA-256 with `crypto.subtle` and posts it in chunks. The Worker never fetches a snapshot file.

### 3.5 Matching (deterministic, no AI)

**Pure code** in `packages/catalog/src/supplierPrices/`:

| File | Contents |
|---|---|
| `keys.ts` | Extracts the matching keys (patterns below) and `packOf(texts) → {pack_units, net_weight_g}`. |
| `dictionary.ts` | Chinese option vocabulary by group `kind` (0194 `product_option_groups.kind`), material and model token lists, and the English words of the electronics rule (§3.8). These are vocabularies, not prices. |
| `match.ts` | `matchProduct(identity, candidates) → {item scores, SKU map, confidence, reasons}`. |
| `classify.ts` | §3.8. |

Keys extracted by `keys.ts`:

| Key | Pattern |
|---|---|
| Colour code | `\b\d{5}\b`, kept only when it sits in a colour-kind option or a title |
| Part or kit code | `\b(?:B-)?[A-Z]{2,3}\d{3,4}(?:-V\d+)?\b`, normalised to upper case with the leading `B-` removed |
| Bambu SKU code | The store's `sku` |
| Model token | A1, A1 mini, P1S, P1P, P2S, X1C, X1E, H2D, H2S, X2D, AMS 2 Pro, AMS HT, AMS lite |
| Material token | PLA Basic, PLA Matte, PETG HF, ABS, ASA, TPU 95A, PA6-CF and the rest of `dictionary.ts` |
| Pack and weight | `10件装`, `N卷`, `(20个)`, `20 pcs`, `xN` / `*N` / `×N`, `净重10kg`, `1kg`, `500g` |

A count stated outright (`件装`, `卷`, `(20个)`, `20 pcs`) wins over a multiplier, and counts stated outright are never added: `黑5卷+白5卷` reads 5, and a text whose counts differ states none. A `+`-joined list with one multiplier on every term (`*N`, `×N`, or `xN` where the `x` follows a space or starts the term: `黑x5` states none) adds up only for filament, an offer one of whose texts names a filament line (`MATERIAL_TOKENS`: PLA Basic, PETG HF …) or a spool state (含料盘, 无料盘, refill …): rolls by colour, `黑*5+白*5` → 10. Any other such list names the parts of one set (`膜*2+弹簧钢板*1`: 2 films and 1 spring steel plate) and states no count: the next text's multiplier is read, else 1, unstated. One part ×N (`膜*2`) is N. The words "filament" or 耗材 alone do not make an offer filament.

Option groups mapped through `dictionary.ts`:

| Group kind | Chinese wording | Maps to |
|---|---|---|
| `spool` | 带料盘 | spool |
| `spool` | 补充装, 替换装, 不带料盘 | refill |
| `nozzle` | 0.2, 0.4, 0.6, 0.8 mm | the nozzle size |
| `plate` | 纹理 PEI, 光面 PEI, 纹理+光面, 工程板, 增稳低温, 低温打印板, 高温打印板, 转印板 / 转印膜; 一代 / 二代 | the plate type (textured, smooth, dual-texture, engineering, Cool Plate SuperTack, cool, high-temperature, 3D Effect) and its generation |
| `pack` | N件装 | `pack_units` N |

**Add-on SKUs.** A SKU that is another product offered beside the item is none of the item's SKUs (`ADDON_SKU`): a value that contains 推荐加购 or 推荐选购 (Tmall writes 【推荐加购】 and 【推荐选购】: the glue beside a build plate, the silicone sock beside a nozzle), 【加购】 or 【赠品】, or one that starts with 赠品. The matcher drops them before it pairs, so an add-on is in no could-be list. A listing with one SKU besides its add-ons is a one-SKU listing, and its title speaks for that SKU; a listing of add-ons only sells nothing (`PLACEHOLDER_LISTING`).

The electronics rule used for classification is the EU capture's own `judgeElectronic` (`data/bambu-eu-prices/tools/assemble-snapshot.mjs`), ported word for word into `dictionary.ts` (`ELECTRONIC_HEAD_WORDS`, `MECHANICAL_HEAD_WORDS`, `ELECTRONIC_NAME_WORDS`, `GENERIC_NAME_WORDS`, `ELECTRONIC_NAME_RULES`); read the lists there rather than here. Its clean-up order is ported too (`classify.ts` `isElectronicsName`, the capture's `partCore`): every dash made "-", spaces collapsed and trimmed, then ™ and ® dropped, then the part before " - ". Any change must be made in both places.
- **The head noun decides:** the last word before " - model", "(…)" or " for/with/of …", skipping generic words and words with a digit. Electronic heads are boards, motors, sensors, cables, fans, heaters, cameras, screens, switches, LEDs, ports, power supplies and the like.
- **Mechanical heads veto,** even after an electronic word: covers, housings, lids, panels, bases, mounts, heatsinks, cams, magnets, ducts, filters, pulleys, belts, connectors, tubes and the like.
- **When the head says neither,** an electronic word anywhere decides (hall, rfid, usb, wifi, power, laser, piezo …).
- **Fixed names are tested first.** Electronic: AMS hub, laser or cutting module or upgrade kit, laser tube, Vortek, power filter or adapter, heat press, soldering iron, flash drive, conveyor feeder, fire extinguishing system. Not electronic: Vision Encoder.

**Plates.** A product's plate type and generation also come from its own name when it says "plate": the type for each SKU none of whose plate-kind values states a type, the generation for each SKU none of whose plate-kind values states a generation. A value in a group of another kind states no plate. An item whose title (else its English name) states a different type or generation is refused with `LISTING_MISMATCH` when it contradicts every SKU's name-stated plate; otherwise each such SKU is refused against that item. A SKU with a plate-kind value is judged by what that value states, against each catalogue SKU's own words (a one-SKU listing's title speaks for its SKU):
- a value that states a type pairs only with a catalogue SKU that states that type, and no generation other than the one the value (else the product's name) states;
- a value that states only a generation ("1st Gen", 一代) refuses a catalogue SKU of another generation and keeps the name's type; otherwise it is compared by its label like any other value.

A catalogue SKU whose own words state another plate never pairs. "Cool Plate SuperTack" reads as the SuperTack. The 3D Effect Plate is a type of its own (on Tmall a transfer plate or film, 转印板 / 转印膜), so the 【创意打印】…转印板 options inside the textured and dual-texture listings are never those plates' SKUs. A build plate (its name states a plate type) also refuses, with `LISTING_MISMATCH`, any item whose capture category is set and is not `build_plate`: Tmall's capture category, or a store item's manifest type.

**The Levonis side**, loaded per page of products by `worker/lib/supplierPrices/matcher.ts` in three statements:
- `product_external_ids`, which carry variant-scope `bambu_variant_id` / `bambu_sku_code` and option-value-scope `color_code`;
- `product_source_refs.source_handle`;
- active option groups with `kind`, their values (names in ar, en and ckb), variants with their canonical combo keys, and `products.name`.

**Per product**, in pages of 25 products (`POST /supplier-prices/match {cursor}`):
1. Candidates come from indexed lookups into `supplier_price_keys` (`ix_spk_lookup`): one statement for the page's keys, through `json_each`.
2. Each candidate item is scored. Pack and weight must agree: a `10件装` item against a single spool is **refused** (`PACK_MISMATCH`), and a pack price is never divided silently. A candidate whose `sourcing_hint` contradicts a type **the owner chose** is refused (`TYPE_MISMATCH`). Against a type that came from the import, the candidate is kept, and once confirmed its category reclassifies the product (§3.8). This is how a spare part that Tmall sells as an electronic part ends up EU-sourced.
3. Every structurally sellable SKU (`sellableSkus`, `worker/lib/pricingEngine/legacy.ts`; for a product stocked by combination, the cells the cart sells, past `ENGINE_MAX_SKUS` too: §13, "Review fixes") is mapped to **exactly one** catalogue SKU, value by value:
   - a colour by its 5-digit code;
   - `spool`, `nozzle`, `plate` and `pack` through the dictionary;
   - any other group by its exact normalised English name (`options_en`).

   If two Levonis SKUs land on one catalogue SKU, or one Levonis SKU on two, both stay unmapped (`AMBIGUOUS`).

| Confidence | Rule | Handling |
|---|---|---|
| `exact` | US / EU: every SKU's `bambu_variant_id` equals the store variant id, or its `bambu_sku_code` equals the store SKU code. Tmall: a single-SKU product and a single-SKU item with an equal normalised part code. | Confirmed automatically (`decided_by 'auto'`) |
| `high` | Tmall: item-level code evidence (an equal part code, or colour-code coverage of at least 80% of the product's colour values with an equal material token), and every SKU mapped one to one by code or dictionary, and pack and weight equal. EU: equal handle, and every SKU mapped by equal English option labels. | Confirmed automatically and listed as "auto-confirmed" for the owner to audit or reject |
| `medium` | Name and model tokens agree (token Jaccard at least 0.6, model tokens equal), and every SKU mapped | `suggested`; the owner can accept a whole product at once |
| `low` | Anything weaker, or some SKUs unmapped | `suggested`; the owner accepts SKU by SKU |

Reason codes stored in `reasons_json` (codes only): `CODE_EQUAL`, `REVISION_STRIPPED`, `COLOUR_COVERAGE`, `MATERIAL_EQUAL`, `MODEL_EQUAL`, `NAME_SIMILAR`, `SPOOL_DICT`, `NOZZLE_DICT`, `PLATE_DICT`, `PACK_EQUAL`, `AMBIGUOUS`, `PACK_MISMATCH`, `TYPE_MISMATCH`.

Matching never publishes anything. A confirmed match only feeds an estimate preview, and publishing is the owner's apply (§4.8).

**Lifecycle across captures:**
- A new capture re-attaches every confirmed match through its `(source, item_key, sku_key)` with the new price.
- A matched key missing from the current complete snapshot flags its lines `EST_SOURCE_ITEM_MISSING`.
- A match whose `combo_key` no longer exists on the product (the owner changed its options) is pruned by the next match run.

### 3.6 Owner review, manual entry, lookup and one-page store reads

| Route (under `/api/admin/pricing/supplier-prices`) | Effect |
|---|---|
| `GET /matches?state=suggested\|auto\|rejected\|missing&cursor` | Per product: the Levonis SKUs beside the candidate items and SKUs, with titles in both languages, codes, price, the price label, capture date, confidence and reasons |
| `PUT /matches/:product_id` `{version, skus:[{combo_key, source, item_key, sku_key \| null, units_per_offer?}]}` | Confirms, re-points or rejects (`sku_key: null`). Version-fenced. A `units_per_offer` other than 1 is accepted only here, from the owner, and flags the line `EST_UNITS_DIVIDED`. The unit price is `ceil(price / units, 4 decimals)`, computed exactly with BigInt rationals, so the cost is never understated. |
| `PUT /manual/:product_id` `{version, skus:[{combo_key, amount, currency, note}]}` | The owner's typed price (USD, EUR or CNY). The UI's "same as colour X" button is an explicit owner act stored as `typed` with a note, never an inferred price. |
| `GET /lookup?q=` | Search by the owner's text in any of these forms: a Tmall URL (with or without `skuId`) or item id; a store URL (a product or variant page, with or without `?id=` and `skr=yes`) or handle; a store variant id; a 5-digit colour code; a part or SKU code; words of `title` or `name_en`. Searches the complete snapshots and returns at most 50 items with their SKUs, prices and the Levonis products already matched to them. **This meets "by product URL or name".** |
| `POST /read-store-page` `{url, save?: {product_id, combo_keys}}` | One owner-initiated read of a single EU or US store page through `guardedFetchBytes` (`worker/lib/fetchGuard.ts`), with `allowHost` limited to `eu.store.bambulab.com` and `us.store.bambulab.com` on every hop, the existing byte cap, and the JSON-LD walk that `worker/lib/productPageImages.ts` uses. **The owner's URL is not fetched as typed.** Its host must be one of the two stores; the handle (`[a-z0-9-]` only) and the optional `?id=` (digits only) are taken from it, and the address fetched is rebuilt by the §3.9 builder, so an EU read always carries `skr=yes` (`https://eu.store.bambulab.com/products/<handle>?id=<variant id>&skr=yes`). It returns the variants with the **final host and the page's own `priceCurrency`**. With `save`, it writes `supplier_price_manual` rows with `origin 'store_page'` and the evidence URL and host. On a sale page each offer's `price` is the regular price and its optional `sale_price` the sale price: a save writes the regular price, the audit detail records `on_sale` (a boolean, no amount), and «تحديث السعر» tells the owner in ar / en / ckb that the page is on sale and which price was saved. It names the sale price (`PRICE_SHEET.storeSavedSale`) only when that price is the saved variant's: the link named the variant, or every offer has the same sale price; otherwise it names only the regular price saved (`storeSavedRegular`); a page with no sale, or a named variant that is not on sale, gives `storeSaved`. **One offer per variant.** A page can repeat a variant (one id, one currency) across JSON-LD nodes, and one copy may show only the sale price. Each copy is priced by the sale rule, then: copies of one value (259 and 259.00) are one offer, the first copy that states a regular price, else the first; a plain copy whose price is another copy's sale price is that copy's sale; any other disagreement keeps every copy (one per price text), and a save of that variant is refused: 502 `PRICE_ESTIMATE_STORE_PAGE_UNREADABLE` with `details: {reason: 'copies_disagree'}` when the address names the variant (the same code and text; every other 502 carries no `details`), 400 `{field: 'url'}` without a variant. A copy whose stated regular price cannot be read is dropped by the sale rule before the copies are compared, so a plain copy in another node decides alone and a save writes its price, perhaps the sale price (`capture-store-offers.ts` does the same; no stored page has two blocks). Offers are copies only across nodes: within one node (a Product with a list of offers) they are only deduplicated, one per price text, so a node that gives a variant two prices (259 and 259.00 included) is never saved. Offers without an id are only deduplicated. With `?id=`, the variant's offers in the first currency it is offered in must come down to one. The answer's shape is unchanged. When the page gives the option the link names several prices, the sheet says so (`PRICE_SHEET.copiesDisagree`, «تعرض الصفحة لهذا الخيار أكثر من سعر، فلا يمكن حفظ أيٍّ منها؛ اكتب السعر بنفسك.»): after «اقرأ واحفظ» in place of the unreadable-page text (`isStoreCopiesDisagree`), after «اقرأ فقط» in place of `noOffer` (`storeCopiesDisagree`). An EU URL that still redirects to the US store comes back as USD and is stored as USD, never as EUR. A refused or challenged fetch (the store answers automated access with a Cloudflare challenge, §3.1), or a page without JSON-LD offers, gives no price: the call saves nothing and answers the owner-only refusal `PRICE_ESTIMATE_STORE_PAGE_UNREADABLE` (502, ar / en / ckb in the §5.5 contract), and the owner types the price instead. No schedule, no crawl, and Tmall is never fetched. |

### 3.7 Which price an estimate uses, per SKU (`worker/lib/supplierPrices/store.ts`, `supplierPricesFor`)

Per SKU, the first available price is taken:

| # | `CHINA_CNY` types | `EU_STORE_EUR` types |
|---|---|---|
| 1 | Owner manual entry (typed or store page, any currency) | The same |
| 2 | Confirmed `tmall_cn` match | Confirmed `bambu_eu` match |
| 3 | (none) | Only when the type allows the US reference: confirmed `bambu_us` match, flagged `EST_US_REFERENCE` |
| 4 | Otherwise the SKU has no price | Otherwise the SKU has no price |

Then:
- Any SKU with no price flags the product `EST_NO_PRICE`, which blocks it. A V2 write needs every structural SKU priced: `complete = codes.size === 0` in `evaluateV2Write`, and a missing supplier cost is not one of its `BLOCK_CODES`. Nothing is ever inferred from a sibling.
- When every SKU shares one currency, the compaction of §4.4 may use option or base scopes. Mixed currencies force SKU-scope absolutes.

### 3.8 Product type (`packages/catalog/src/supplierPrices/classify.ts` + `worker/lib/pricingEngine/estimate/classify.ts`)

A Bambu product's estimate type is taken from the first source that gives one:
1. **The owner's choice** (`type_source 'owner'`).
2. **The confirmed Tmall match's category** (`supplier_category`). The assembler's 16 categories map to types (table below). This is how a spare part such as a mainboard becomes `electronics_part`.
3. **The import's type** (`import_type`): `catalog_import_items.product_type` of the product's COMPLETE item (joined on `levonis_product_id`), plus the bundled reviewed manifest's `subtype` (`worker/lib/catalogImport/reviewed.ts`, `manifest.bySourceId`). Filament with subtype `pack` becomes `filament_pack`; a `spare_part` whose English name is electronic by the rule of §3.5 becomes `electronics_part`, and an `accessory` (registry `tool` too) whose name is electronic becomes `electronics_device`.
4. Otherwise the product is flagged `EST_TYPE_MISSING` and gets no estimate.

| Tmall category | Type |
|---|---|
| printer | printer |
| multi_material_unit | ams |
| laser_or_cutter_device | laser_machine |
| scanner, air_purifier | electronics_device |
| electronic_part | electronics_part |
| filament | filament |
| filament_bundle | filament_pack |
| nozzle_hotend | hotend |
| build_plate | build_plate |
| spare_part | spare_part |
| tool, accessory | accessory |
| maker_kit | makers_supply |
| laser_material | laser_material |
| other | (none) |

The table and the type's sourcing agree with the capture's own rule (`data/bambu-cn-prices/README.md`): electronic devices and electronic parts come from the EU store by land, filament by sea only, everything else by sea or air.

**Merged products** (`match_kind 'merged'`, the owner's existing listings) and products with no source row are never enrolled automatically. The owner may enrol one by choosing its type; their structure is never changed (§4.7).

### 3.9 Supplier links for the owner

**The owner's request (2026-10-31, DECISIONS row 278):** "for tmall saved id of every product and link for admin so here can easily found the product by tap on link to order it or update the price".

**What the owner sees.** For every Levonis product with matched supplier items (a `confirmed` match, by the owner or automatic, or a `suggested` one; §3.5), per source and item:
- the source (`tmall_cn`, `bambu_eu` or `bambu_us`) and the item's title (Chinese and English for Tmall);
- the **Tmall item id**, with a copy button, and a link to the item page;
- per Levonis option, colour or SKU: the supplier SKU it is matched to (its options as the source writes them and in English, and its id), a link that opens **that exact option**, the captured price with its currency and price label, the capture date (`captured_on`) and the match state;
- for the EU and US stores, the store link per product and per variant;
- the owner's own price for that SKU, when one exists (§3.6), because an estimate uses it first (§3.7);
- **«تحديث السعر» (update the price):**
  - for any source, manual entry (`PUT /manual/:product_id`, §3.6), opened on that combo key with the source's currency selected;
  - for an EU or US link, the one-page store read of that link (`POST /read-store-page` with `save` for that combo key);
  - Tmall is never fetched by the Worker: the owner taps the link (on a phone the Tmall app opens), reads the price and types it.

A match whose key is missing from the source's newest complete snapshot (`EST_SOURCE_ITEM_MISSING`, §3.5) keeps its link and shows no price, so the owner can open the page and check. A new capture (§3.3, §3.4) updates every price at once, and the links stay the same because they are built from the same ids.

**Link formats.** Only `packages/catalog/src/supplierPrices/links.ts` (pure) builds a supplier link, and only from validated ids:

| Source | Item | Option, colour or variant |
|---|---|---|
| `tmall_cn` | `https://detail.tmall.com/item.htm?id=<item_key>` | `https://detail.tmall.com/item.htm?id=<item_key>&skuId=<sku_key>` |
| `bambu_eu` | `https://eu.store.bambulab.com/products/<handle>?skr=yes` | `https://eu.store.bambulab.com/products/<handle>?id=<sku_key>&skr=yes` |
| `bambu_us` | `https://us.store.bambulab.com/products/<handle>` | `https://us.store.bambulab.com/products/<handle>?id=<sku_key>` |

`skr=yes` is the EU store's skip-region-redirect parameter: without it, visitors from Iraq are sent to another region's store (§3.1). For a store, `<handle>` is the item's `item_key`.

Rules:
- A Tmall item id and every `sku_key` in a link are digits only. A store handle is `[a-z0-9-]` only. Each is non-empty and within its column's length (§2.2).
- An id that fails gets no link. It is shown as text, and is never repaired, encoded or guessed. A store SKU keyed by a SKU code (§3.3) gets the product link only.
- Checked against the data on disk: every Tmall item and SKU id captured so far is digits only (at most 13 digits), and so is every EU variant id. Ten of the 1,115 manifest handles hold non-ASCII characters (U+2011, U+2013, U+2014, `×`, `°`, `ä`; for example `usb‑c-soldering-iron-kit-for-heat-set-inserts` or `cutting-material-kit-–-starter-pack`). A store item with such a handle shows its handle as text, with no link. All ten are China-sourced types (accessory, laser_material, makers_supply), so their own links are Tmall links.
- A link is never built from free text: not from the stored `url` or `evidence_url`, a title, an option or the owner's search. The hosts and paths are constants of the builder, and it produces `https` only.
- Amended by DECISIONS row 293 for the owner's OWN links only (§3.10): an address he saves himself is free text by nature, so it is held to the shared parser's contract instead (https, a named host, the builder's form for a Tmall item or a store page, ≤ 1000 characters, never fetched). Every matched link above is still built by the builder alone.
- A link opens in a new tab with `rel="noopener noreferrer"`, so no admin address reaches the store.

**Where the links appear** (WP12):
- **The Links tab** of the estimates workspace (§7): every linked product, searchable (product name, Tmall URL or item id, store URL or handle, SKU id, colour or part code), with a source filter, in pages.
- **The Review grid** (§7): every candidate item and SKU carries its link and id beside its price.
- **The product form banner** (`PricesSectionV2.tsx`, §7): the owner's banner lists the product's links. It reads them only for a viewer with cost read, the viewer who also gets Review and Confirm. Every other admin sees the state only.

**Routes.** The read is `worker/lib/supplierPrices/links.ts` (WP5), served by `worker/routes/adminSupplierPrices.ts`, so it sits behind the §3.4 door and is owner-only like every supplier datum (I6).

| Route (under `/api/admin/pricing/supplier-prices`) | Effect |
|---|---|
| `GET /links?q=&source=&cursor=` | The products that have a `confirmed` or `suggested` match, 25 per page, with the next `cursor`. `q` takes the owner's text in the forms `GET /lookup` reads (§3.6), or words of the product name. `source` narrows the list to one source. |
| `GET /links/:product_id` | One product, in the same shape. The banner and the Review grid read this. A product with no match answers an empty list, so the banner can offer the lookup instead. |

- **The answer.** Per product: its id and name. Per source and item: the item id, title, link, capture date and currency. Per SKU: the Levonis combo key with its option and colour names, the supplier SKU id, its options and link, the price and price label, the match confidence and state, and the owner's own price for that SKU. A link is the builder's output or `null`.
- **Key names.** As built, every supplier fact sits in one array under the `FINANCIAL_FIELDS` key `supplier_prices` (per SKU: `products[].skus[].supplier_prices[]`; for the lookup, the top-level `supplier_prices`), with plain leaf names inside (`source`, `state`, `item_key`, `sku_key`, `title`, `name_en`, `options`, `options_en`, `codes`, `price`, `currency`, `price_label`, `captured_on`, `quantity`, `item_url`, `sku_url`, `missing`, `match_confidence`, `match_method`, `match_reasons`, `units_per_offer`, `decided_at`, `note`). `stripFinancials`, the second net, therefore removes the whole array from any payload projected for a non-owner (tested in `tests/supplierPricesLinksRoute.test.ts`).
- **Reads.** A fixed number of statements per page, whatever its size, with the ids bound through `json_each`. The price comes from the SKU row of the source's current complete snapshot (`ux_sps_current`), the row an estimate reads (§3.7).
- **Absence.** As built, without 0218 both routes answer an empty list (WP5's brief): a product with no link and a database without the catalogue read the same, so the banner offers the lookup and the deploy-ahead sweeps hold both reads to strict equality. Every other owner route of §3.4–§3.6 and §4 answers 503 `PRICE_ESTIMATES_NOT_INSTALLED` (§2.4), after the owner door.
- **Writes.** None. "Update the price" goes through the §3.6 routes, which call `assertCostWrite`.

**Proof** (both files are listed with their packages in §12):
- `tests/supplierPriceLinks.test.ts` (WP2): the three formats. Digits-only ids and `[a-z0-9-]` handles: an empty, overlong, upper-case or spaced value, or one holding `/`, `?`, `&`, `#`, `%`, `..` or a whole URL, gets no link. An EU link always carries `skr=yes` and a US link never does. Only `https` is produced.
- `tests/supplierPricesLinksRoute.test.ts` (WP5): owner-only, with a non-owner admin refused in the same bytes as the other supplier-price routes; the list with search and cursor; one product; a hostile stored `url` or `evidence_url` never appears in an answer; a key missing from the newest capture keeps its link and shows no price; 503 without 0218.

### 3.10 The owner's own supplier links (DECISIONS row 293; migration 0223)

**The owner's request (2026-11-05):** «i need to save the link so i can easily track price from supplier or on pre order item to order it or when i need to future buy on inventory».

**What it is.** Beside the matched Tmall and EU links of §3.9, the owner keeps his own addresses for a product, at any supplier: Tmall or Taobao, AliExpress, 1688, Amazon, a local supplier's site. Each is kept for the whole product, one model or option, one colour, or one exact option and colour combination, with an optional name, an optional supplier name (free text) and an optional note of a few lines (`ownerLinkNote`, the same file's rule for the sheet and the Worker: its line breaks kept as `\n`, any other control or bidi character refused). Saving one writes no price and never becomes the confirmed match: «تحديث السعر» (§3.6) stays the only price door, and `PUT /matches` the only match door.

**The amended rule.** §3.9 says a link is never built from free text. Row 293 amends that for the owner's own links only; every matched link is still built by `packages/catalog/src/supplierPrices/links.ts` from validated ids, and `safeSupplierHref` is unchanged. An address of his is read by one pure parser that the Worker and the owner's admin chunk both run, `packages/catalog/src/supplierPrices/ownerLink.ts` (`ownerLinkUrl`):
- the text is trimmed; whitespace, C0 and C1 controls, bidi marks and overrides are refused; an address with no scheme is read as https (`tmall.com/…`), and any other scheme (http included) is refused;
- https only, no user name or password, no port, and a named host: dotted `[a-z0-9-]` labels, never an IP literal, `localhost` or a single label. The host is the URL standard's lower-case punycoded name, shown left to right on every screen, so a look-alike host reads as what it is;
- one canonical form: a Tmall item page (`*.tmall.com/item.htm?id=…[&skuId=…]`) and a Bambu EU or US store product page are rebuilt by the §3.9 builder (tracking parameters dropped, a region prefix dropped, EU links with `skr=yes`); every other address keeps the URL standard's own serialisation (`URL.href`, ASCII). Taobao is not read as Tmall: that equivalence is unverified;
- at most 1000 characters once rebuilt (a long Tmall address with its tracking is rebuilt short), refused by reason (`empty`, `not_url`, `not_https`, `credentials`, `port`, `host`, `too_long`).

The Worker stores the address and never fetches it. The browser opens it in a new tab with `rel="noopener noreferrer"` and `referrerPolicy="no-referrer"`, and only when `safeOwnerLinkHref` reads the stored text back to exactly itself; anything else is shown as text. Nothing is repaired.

**Storage** (`migrations/0223_product_supplier_links.sql`): `product_supplier_links(id 'psl_…', product_id → products ON DELETE CASCADE, combo_key, url, host, label ≤ 80, supplier_name ≤ 80, note ≤ 300, version, created_by/at, updated_by/at)`. Its CHECKs hold the parser's shape whatever door writes: an https address of 12 to 1000 printable ASCII characters, a lower-case dotted host, a key that is `''`, `o:…` or `c:…`. One address once per key of a product (`ux_psl_link`); at most 40 links a product (the write). The table is owner-only like every supplier datum (I6): Catalog ownership, the import guard's three triggers (`LATE_PROTECTED_TABLES`), the deletion registry (`OWNED_TABLES`, counted under the neutral `pricing_engine`), and two `NON_MEDIA_COLUMNS` (an external address is never ours to delete).

**What a link belongs to.** `combo_key` is `''` (the whole product), `o:<value>` (a model or option), `c:<colour>` (a colour across models) or one exact SKU key: a canonical subset of a SKU's key, in the space of `supplier_price_matches.combo_key`. A link applies to a SKU when every part of its key is a part of the SKU's key. A new link is saved only for a key the product offers today (`choices`: the product, each option and colour a sellable SKU holds, each sellable SKU; a grid too large for the engine offers the product, its options and its colours); a stored one whose option was removed since stays readable and removable.

**Routes** (inside `worker/routes/adminSupplierPrices.ts`, behind the §3.4 door; `worker/lib/supplierPrices/ownerLinks.ts`):

| Route (under `/api/admin/pricing/supplier-prices`) | Effect |
|---|---|
| `GET /owner-links/:product_id[?combo_key= \| ?scope=&scope_id=]` | His links of the product (`supplier_links`, the most specific first, each with its key's names in ar / en / ckb, host and source), the matched facts of the same SKUs (`skus[].supplier_prices`, confirmed and suggested matches and his own prices, as `GET /links/:product_id` answers them), the keys a link may be saved for (`choices`), the token `versions.links`, `scope_key` and `installed`. `combo_key` reads an order line's exact SKU; `scope` is a purchase line's stock row: `base`, `option`, `color`, or `variant` (its combination read from `product_variants.combo_key`). 404 for no such product; 400 `PRICING_INPUT_INVALID {field}` for a bad query. |
| `PUT /owner-links/:product_id {version, upsert?, remove?}` | Adds (no `id`), edits (`id`) and removes (`remove: [id]`) at most 20 of each, fenced on the token he read (409 `PRICING_CHANGED`) — checked when the write reads the rows and again inside its own batch, so another tab's save landing in between is kept and this write is refused whole — with `assertCostWrite`. A refused address answers `PRICING_INPUT_INVALID {field: 'url', reason}`; a duplicate `{field: 'url', reason: 'duplicate'}`; the cap `{field: 'upsert', reason: 'limit'}`. One batch: the fence, the delete, the upsert and the audit row `supplier_prices.owner_links_set` (counts only, never an address or a host). |

Both answers are `private, no-store`. The links sit under `supplier_links` and the matched facts under `supplier_prices`, both in the two FINANCIAL_FIELDS copies, so `stripFinancials` drops them whole from anything projected for a non-owner.

**Where it shows.** One lazy chunk (`src/components/adminEstimates/SupplierLinksPanel.tsx`, `OwnerLinkSheet.tsx`), mounted only for the owner, so no other admin downloads it or calls its route:
- the product form's section ٣ (`PricesSectionV2.tsx`), under `v2.owner && productId && v2.mode === 'stored'`, after the estimate banner: a card with every link, add, edit and remove, the matched links behind their count, and the Links tab one tap away for «تحديث السعر»;
- the purchase wizard (`ProcurementPanel.tsx`), under `can_view_cost === true`: a strip under each step-2 line head, beside the raw price he types (up to three pages to open at once, his links first, then the items of CONFIRMED matches; the last known supplier price; add), and a read-only strip on each saved purchase line («اشترِ مجددًا من المورّد»). The strip trusts what the estimate trusts: his own price and confirmed matches (by him or automatically). A suggested match is never one tap away nor quoted as the supplier's price; it waits in the full list with its «مقترح» chip. «آخر سعر معروف عند المورّد» is the most recent of those prices (his own first on the same day), for one unit: a pack he divides (`units_per_offer`) is divided by `unitPriceOf`, the very function the estimate calls (now in `packages/catalog/src/supplierPrices/format.ts`), and «مقسوم على {n} قطع» is said beside it, with the price's own words (Tmall's 优惠前), its day, «نفد عند المورّد» when the capture had none, and the SKU it belongs to when the stock row covers several. DECISIONS row 286 stands: a link is never a blocker and never an «اذهب» target; `nextBlocked`, `confirmBlocked`, `purchaseBlockers`, the dock and the `purchase-*` ids are untouched;
- the order view (`OrderDetailModal.tsx`), under `can_view_cost === true`, on each pre-order line with a product (never a gift or a bundle): a strip of the exact SKU bought («اطلبها من المورّد»), its key as the cart keys it (`skuComboKey`). Never inside `EstimateConfirmPanel`, `PriceAdjustPanel` or `PreorderOriginsPanel`, which any admin reads.

Write controls show only on the session's `can_write_cost === true`; each row's «عدّل» and «احذف» are named by their link for a screen reader, and after a removal the keyboard lands on the panel's heading. Nothing is kept in browser storage. A read with nothing to show is not a failure: an older Worker without the route answers its bare 404 (no code) and a product deleted since a purchase was saved answers `NOT_FOUND`, so a strip draws nothing and the card says the calm «not on this server yet» instead of a red refusal; any other failure offers a retry.

**Absence.** On a database with 0218 but without 0223, the read answers `installed: false` with the matched links still there (its own batch, its own missing-table check: `isMissingEstimateSchema` does not know this table) and the write answers 503 `SUPPLIER_LINKS_NOT_INSTALLED` (owner audience, ar / en / ckb). Without 0218 the read answers the product's name alone and the write 503 `PRICE_ESTIMATES_NOT_INSTALLED`, as every other owner write. The deploy-ahead sweeps hold the read at 200 on both.

**Proof:** `tests/migration0223SupplierLinks.test.ts` (the CHECKs, the unique key, the import guard, re-runnable, the deletion), `tests/supplierOwnerLinkUrl.test.ts` (the parser, `safeOwnerLinkHref` and `ownerLinkNote`), `tests/supplierOwnerLinksRoute.test.ts` (the door, the read and its filters, the write and its refusals, the fence inside the batch, a grid too large for the engine, multi-line notes, the audit, the second net, absence, one reader), `tests/supplierLinksUi.test.ts` (the anchors, the card and the strip, the strip's trusted links and price, the named acts and the focus, the quiet 404, the sheet's refusals, the three hosts' gates), with `tests/costRoleMatrix.test.ts`, `tests/routeClass/pricing.ts` and `tests/costPublicChannels.test.ts`.

---

## 4. Estimate computation

### 4.1 Type → sourcing, currency, route and profile

| Type key (seeded) | Sourcing / currency | Route → profile (`ROUTE_PROFILE`, `packages/pricing/src/skuChannel.ts`) | Freight basis (`PROFILE_BASIS`) | Fixed by CHECK |
|---|---|---|---|---|
| printer, ams, laser_machine, electronics_device, electronics_part | EU store, EUR. US USD reference if `us_reference_allowed` (seeded on). Manual entry. | land → `GERMANY_LAND` | per kg | EU ⇒ land |
| filament, filament_pack | Tmall, CNY | sea → `CHINA_SEA` | per CBM | sea only, never air |
| spare_part, hotend, build_plate, accessory, makers_supply, laser_material | Tmall, CNY | sea by default; air when the owner sets it per type or per product → `CHINA_SEA` / `CHINA_AIR` | per CBM / per kg | air only when `allow_air` |

The owner fills in each type in the workspace (§7): default weight, default box or CBM, extra cost in IQD, minimum profit in USD, and staleness days. A type with no minimum profit, or with no default where a product lacks a measure, gives `EST_TYPE_INCOMPLETE`.

`GET /estimates/types/:key/suggest` proposes the **median of real package measures** of products of that type. It is never saved without the owner's click.

**One route per estimated product.** Two published routes would leak their freight difference (DECISIONS row 220 (a), pinned by `tests/leakAudit_customer-api_route_price_spread_reveals_freight.test.ts`). An estimate therefore never publishes a second route.

### 4.2 What is reused, function by function

| Step | Existing code |
|---|---|
| Rates: U; `fx.EUR = E × U`, `fx.CNY = C × U` (`composeIqdRates`); `GERMANY_LAND` / `CHINA_AIR` IQD per kg, `CHINA_SEA` IQD per CBM | `worker/lib/pricingEngine/rates.ts` `loadPricingRates`, through `loadV2Read`. Nothing else reads a rate, and the estimator imports nothing from `worker/lib/fx/*` (`tests/pricingCurrencyRoles.test.ts`). |
| Read, desired set, evaluation | `worker/lib/pricingEngine/v2/api.ts` `loadV2Read`, `parseV2Wire`, `desiredFor` (`viewer 'owner'`), `evaluateDesired` → `v2/evaluate.ts` `evaluateV2Write`, which writes nothing |
| Inputs → cost | `packages/pricing/src/costToPrice.ts` `resolveSkuInputs`, `replacementCost`, over `worker/lib/pricingEngine/store.ts` `chainOfUnit` and `packagesOf`. Model and colour packages are read by the engine itself (DECISIONS row 247). |
| Price | `packages/pricing/src/priceV2.ts` `priceProductV2`; `packages/pricing/src/priceRounding.ts` `roundPriceIqd` (above 1,000 IQD, up to the next 250, DECISIONS row 245) |
| Minimum profit | `cost.minimum_profit` (a USD string = the product-scope `target_profit` rule), parsed by `parseRuleWrites` (`worker/lib/pricingEngine/ownerRules.ts`), resolved by `resolveRuleAt` / `targetProfitExactIqd` (`packages/pricing/src/ruleResolution.ts`) |
| Gates and the write | `api.ts` `gateV2` (with `preparedImportStock`), `v2PriceKey`, `v2BatchOutcome`; `v2/write.ts` `v2WriteStatements`; `v2/firstWrite.ts` `firstWriteStatements` / `foldedReviewOf` / `pendingReviewsOf`; `worker/lib/productPersistence.ts` `planProductSave`; `v2/draft.ts` `draftLoadedOf`. This is the composition `v2/productSave.ts` `planV2ProductSave` already uses. |
| Import stock decision | `worker/lib/importStock.ts`: the statement form of `decideImportStock('untracked')`, new export `untrackedDecisionStatements`. The precedent is `worker/lib/procurementImportStock.ts`, which lays `tracked` in the price batch. |
| Correcting after apply | `v2/procurementLine.ts` `procurementLinePricing` (`POST /api/admin/pricing/procurement/line-pricing`: `final_cost_usd`, `customer_price_usd`), then the normal `PUT /api/admin/products-v2/:id/pricing` |

### 4.3 The formula

For one estimated SKU, the product is pre-order-only on route r, and its base `shipping_profile` is `ROUTE_PROFILE[r]`, so R_stock = R_r.

```
supplier_iqd = amount × FX(currency)                      FX(CNY) = C·U, FX(EUR) = E·U, FX(USD) = U
freight      = weight_g / 1000 × rate(GERMANY_LAND | CHINA_AIR)
             | effective_CBM × rate(CHINA_SEA)            CBM = manual CBM, else L×W×H / 1e9 of the deciding box
R            = supplier_iqd + freight + additional_cost_iqd          (replacementCost)
E_D          = R + T × U                                  T = the type's minimum profit, as the product's own rule
D            = roundPriceIqd(E_D)
P_r          = D                                          a pre-order-only SKU has no discount (priceV2.ts C-8)
```

`priceProductV2` asserts D − R ≥ T × U (`PRICING_INVARIANT`). The Q1 floor blocks the route when `roundPriceIqd(R_r) ≥ D` (`V2_ROUTE_BELOW_COST`, priceV2.ts line 675). That cannot happen once T × U ≥ 250 IQD, so the type editor warns below that amount.

**Under the profit ceiling (§4.11, DECISIONS row 291)** T is each SKU's own T_sku. From $5 up it is `floor6(c − R ÷ U)`, c its dollar charm price, the highest on the owner's grid whose dinar price is at or under the lower of today's price `roundPriceIqd(R + T × U)` and `R × (1 + P / 100)` and whose profit keeps one rounding step over R, `T_sku × U ≥ 250` IQD (one dinar where the price is at or under 1,000 IQD): `E_D = R + T_sku × U` sits less than U ÷ 10⁶ under `c × U`, so D is `roundPriceIqd(c × U)` and the dollar price (`usd_ceil6`) is c. Under $5 it is `floor6((D − R) ÷ U)` for the highest house price D there that keeps the same margin: `E_D` sits less than U ÷ 10⁶ under D, so the price is D. The Nozzle Wiping Plate at U = 1,600 (R = 3,659.5 IQD, $6, P = 10): 3,999.9992 → **4,000** (13,500 with T alone), 340.5 IQD over R. The same reasoning as the warning above: with one step of profit no ceiling trips Q1, at the owner's compute or after any later rise of R or U that FX-5 prices with T_sku kept in dollars (`tests/charmPrice.test.ts`, `tests/priceEstimateProfitCap.test.ts`).

*Illustrative figures only, not the shop's rates:* PLA Basic refill at 69.00 CNY, with C = 0.14, U = 1,400, sea freight at 250,000 IQD per CBM, a 200 × 200 × 100 mm box (0.004 CBM) and T = $2:

| Step | Calculation | IQD |
|---|---|---|
| Supplier cost | 69 × 196 | 13,524 |
| Freight | 0.004 × 250,000 | 1,000 |
| R | 13,524 + 1,000 | 14,524 |
| E_D | 14,524 + 2,800 | 17,324 |
| D = P_sea | rounded up to the next 250 | **17,500** |

Route floor: `roundPriceIqd(14,524)` is 14,750, which is below 17,500, so the route stays open.

### 4.4 Building the wire

The pure functions are in `packages/pricing/src/estimateInputs.ts` and are confidential: `src/` may never import them, and `tests/pricingCostToPrice.test.ts` gains `estimateInputs` in its regex. The I/O is in `worker/lib/pricingEngine/estimate/compute.ts`.

**Supplier cost.** The V2 form wire carries absolute costs only. `FORM_INPUT_FIELDS` in `worker/lib/pricingEngine/productInputs.ts` has no `supplier_cost_delta`. `resolveSupplier` lets an absolute at a more specific level replace everything less specific, and two different absolutes at the option level are `INPUT_CONFLICT`. `compactSupplierPrices` therefore picks the least specific exact representation:
1. If every SKU has the same amount and currency, write one `base` absolute.
2. If the amount depends on the values of **one** option group only (for example spool against refill, or the model), write `option` absolutes on that group's values. Each SKU then meets exactly one option absolute.
3. If it depends on the colour only (a product with colour rows), write `color` absolutes.
4. Otherwise, or when currencies are mixed, write `sku` absolutes on the canonical combo keys.

Every SKU chain is then re-resolved with `resolveSkuInputs`. Any difference of even one decimal falls back to step 4. More than 61 input entries (`MAX_SCOPES`, `parseProductInputs`) gives `EST_TOO_MANY_SCOPES`, which blocks the product.

**Measures, in order of precedence:**
1. Model and colour package columns, read by the engine itself through `packagesOf`.
2. The product's own `products.package_weight_g` and box, written onto the `base` row and mapped `[depth, width, height]` as the form's `withPackageMeasure` does (`src/components/adminProducts/form/v2/v2Model.ts`). These are public specs the owner already publishes. The owner's existing «تعبئة أبعاد الشحن» (`POST /api/admin/catalog-import/fill-package-measures`, `worker/lib/catalogImport/packageMeasures.ts`) fills them from verified logistics rows, but **only before** a product is priced, because it skips priced products by design. The go-live list (§12) runs it first. The estimator never reads spec rows, which keeps IMPORT-SPEC row 10 ("logistics must never link to pricing").
3. Type defaults: `shipping_weight_g` and the box (`shipping_*_mm`), or `manual_cbm` when the type holds a CBM and no box exists at base, since a manual CBM always beats a box at its level (LD6). They go **into the private `base` pricing input only, never into `products.package_*`**, and the SKUs priced from them are flagged `EST_DEFAULT_WEIGHT` / `EST_DEFAULT_BOX`.
   - The one way a type default reaches `products.package_*` is the owner's own statement in the confirmation (§4.9 step 0; DECISIONS row 292). The weight or box he declares correct for this product (never a weight lighter than the product's own net weight) is written into its package where that is empty, and its record becomes `product_package`. That is exactly what the next apply records once the package holds the stored value. The estimator itself still never writes a package.

Both weight and box are required, because engine-mode completeness counts the resolved weight and effective CBM towards `PACKAGE_WEIGHT` / `PACKAGE_BOX` (`worker/lib/productCompleteness.ts`, lines 323–334). A SKU still missing either gives `EST_TYPE_INCOMPLETE`.

**Profile and extras.** `shipping_profile = ROUTE_PROFILE[route]` and `additional_cost_iqd` (from the type) go on the `base` row. The base `shipping_profile` is the estimator's only when it is empty or holds what it last wrote. An owner-held stock route (any level, form or `SOURCE`) that is not `ROUTE_PROFILE[route]` is never overwritten: the product is blocked with `EST_STRUCTURE_OWNER {combo_keys, fields: ['shipping_profile']}`, because V2 anchors D on the stock route (§4.3's premise R_stock = R_r). The owner clears it with the product form's «مسار شحن المخزون» (set to the route's profile, or cleared), or with the product's route override or type in the Review tab, then computes again.

**Minimum profit.** `cost.minimum_profit = "<type min_profit_usd>"`, a product-scope `target_profit` rule. Category and global rules stay unused: `unitRuleTarget` passes `ancestry: []` (`procurementPreview.ts`, line 401) and `ownerRules.ts` refuses those scopes. A percentage is impossible by construction (DECISIONS row 184(3)). Under the profit ceiling (§4.11, DECISIONS row 291) that still holds for every rule: the type's ceiling and the dollar charm grid (from $5 up; the house rounding under it) decide each SKU's fixed USD amount when the owner computes, and only that amount is written — the product's rule as text, or the form's rule rows (`{kind: 'target_profit', scope, scope_id, amount_usd}`) when option, colour or SKU rules are needed.

**Origin.** The rows are ordinary `MANUAL_OVERRIDE` rows. The retired `SOURCE` origin is not revived (`docs/PRICING-V2.md` §1.9). On the input writes it authored, the estimator sets `InputWrite.source_ref = 'estimate:<snapshot id | type>'`; the form path sets `'owner'` (`productInputs.ts` line 220). Field ownership is tracked in `applied_wire_json`.

### 4.5 Refresh: a three-way merge (owner corrections always win)

`applied_wire_json` records, for every `(scope, scope_id, field)` the estimator wrote and for the product rule, both the value and where it came from. The source is one of `tmall_cn`, `bambu_eu`, `bambu_us`, `typed`, `store_page`, `product_package` or `type_default`.

| Stored field | Who owns it | What a refresh does |
|---|---|---|
| Equals the value the estimator last applied | The estimator | Writes the new value, or clears the field when it is no longer wanted |
| Differs from it | The owner: the form, `procurementLinePricing` or a purchase | Keeps it and adds the informational flag `EST_OWNER_EDITED` (field names only) |
| Never written by the estimator but holds a value | The owner | Keeps it |

Under the profit ceiling (§4.11) the record also holds every option, colour or SKU rule the estimator wrote, `minimum_profit_scopes: [{scope, scope_id, amount_usd, source}]` — only when there is one, so every older record stays byte for byte — and each such rule is merged as a field: equal to the record, the estimator's (rewritten, or back to inherit when no longer wanted); different, or a value never recorded, the owner's (kept; `EST_OWNER_EDITED` with `minimum_profit` when it replaced the estimator's); recorded but now inherit, the owner cleared it (kept, and its SKUs stay off the ceiling). When the product's own minimum profit is the owner's, every such rule still the estimator's goes back to inherit, so his product rule decides as it did before the ceiling.

The estimator never touches a product when:
- its stored V2 method is `usd` (`EST_METHOD_OWNER`);
- its state is `confirmed` or `paused`;
- a purchase review is pending for it (`pendingReviewsOf` → `EST_PURCHASE_REVIEW_PENDING`). `desiredFor` lays the request over the review fold, so an estimate would otherwise override a real purchase cost.

### 4.6 Flags (codes only, owner-only, in `flags_json`)

**Blocking: no apply.**

| Code | Meaning |
|---|---|
| `EST_TYPE_MISSING` | No type could be decided |
| `EST_TYPE_INCOMPLETE` | The type has no minimum profit, or a needed measure default is missing |
| `EST_NO_PRICE` | Some sellable SKU has no price (lists combo keys) |
| `EST_MATCH_REVIEW` | Some SKU is priced only through a suggested match |
| `EST_PACK_MISMATCH` | A refused pairing |
| `EST_TYPE_MISMATCH` | A refused pairing |
| `EST_STRUCTURE_OWNER` | The structure cannot be prepared automatically (§4.7), or the owner holds a stock route other than the type's (`fields: ['shipping_profile']`, §4.4) |
| `EST_FIRM_PRICE` | V2-published without the label: never touched |
| `EST_METHOD_OWNER` | The stored V2 method is `usd` |
| `EST_PURCHASE_REVIEW_PENDING` | A purchase review is waiting |
| `EST_TOO_MANY_SCOPES` | More than 61 input entries |
| `EST_IMPORT_RUNNING` | `ops_guards('catalog-import-batch')` exists |
| The evaluation's own codes | `FX_RATE_MISSING`, `SHIPPING_RATE_MISSING`, `PRICING_ENGINE_PAUSED`, `V2_ROUTE_BELOW_COST`, `FX_DERIVED_STALE`, `WEIGHT_MISSING`, `CBM_MISSING`, … |

**Published as an estimate and listed for the owner.**

| Code | Meaning | At label removal (§4.9) |
|---|---|---|
| `EST_DEFAULT_WEIGHT`, `EST_DEFAULT_BOX` | Priced from a type default (owner decision D2) | **Hard.** The label can never be removed while it is open (T2). |
| `EST_US_REFERENCE` | An EU device priced from the US USD reference | Needs `accept_flags` |
| `EST_MANUAL_PRICE`, `EST_STORE_PAGE_PRICE` | A typed price or a single page read | Needs `accept_flags` |
| `EST_UNITS_DIVIDED` | The owner divided a pack price | Needs `accept_flags` |
| `EST_SNAPSHOT_STALE` | Snapshot older than the type's `stale_after_days` | Needs `accept_flags` |
| `EST_SOURCE_ITEM_MISSING` | The matched key is gone from the newest snapshot | Needs `accept_flags` |
| `EST_SUPPLIER_OUT_OF_STOCK` | Tmall `quantity` is 0 | Needs `accept_flags` |
| `EST_OWNER_EDITED` | The owner changed fields the estimator wrote | Information only |
| `EST_LARGE_CHANGE_HELD` | FX-5 set `reprice_blocked_code = 'PRICING_V2_LARGE_CHANGE'` | Information only |
| `EST_CEILING_SHARED` | Under the type's profit ceiling (§4.11) no exact representation fits the wire's 60 rows: the SKUs it names share a dearer profit of their group (or, failing even that, the product keeps today's rule) — above their own ceiling price (a dollar charm price, or under $5 a house price), never above today's price | Information only |

**How the flags are stored.** An apply stores its flags whole when they fit the 4,000-character column, else with each entry's combo keys replaced by their count (codes and field names kept), else codes only. A later compute keeps an `estimated` row's soft and hard entries exactly (§4.8). A counted entry reaches the workspace with its number of options: `parseFlags` keeps `count` (a whole number ≥ 0) when an entry has no combo-key array, and the lists read «({n} خيارات)» / '({n} options)' / «({n} هەڵبژاردە)» (`FLAG_SKUS`). Everything that reads options (§4.9, the shown flags, the confirmation sheet) reads only combo keys, so a counted entry counts as the product's.

**What the workspace shows** (`shownFlags` in `compute.ts`). For an estimated or paused product, the banner's «وزن افتراضي» / «صندوق افتراضي», the lists and `GET /estimates/products(/:id)` show the row's flags and what the latest compute's lines say of their SKUs (§7). The row's default measures are the last apply's, so they are shown only for options the latest compute does not show as real:
- A latest line on the owner's, a colour's or a model's measures (`owner`, `colour`, `model`: values the estimator never writes) clears its option. A line on the product's package (`product`) or on the type's default does not. «الأبعاد والوزن» fills only an empty pricing measure, so a package measure the store does not hold yet reaches it only at the next apply, and §4.9 refuses meanwhile. A `product` line can also be on a package measure an earlier apply took in, beside a measure entered since (the package's box taken in, then the owner's weight at the colour): §4.9 accepts that option, «التحديث» does not list the product for it (§7), and its chip stays shown until the next apply.
- A line names the weaker of an option's two measures, so an option clears only when both are real; one real measure keeps both chips.
- While the type's CBM still decides the product level (`typeCbmHidesBox`: the last apply wrote the type's CBM there as `manual_cbm`, and the store still holds that value beside a whole box entered there since; the pricing form has no manual-CBM field), that box prices nothing until the next apply removes the type's CBM (LD6). The lines describe the store as that apply leaves it, so they call the box the owner's. Until then an option's default box clears only on a line that names its colour's or model's own package (both of its measures from packages), or, when an owner's pricing row at its option, colour or SKU level holds a box (any axis) or a manual CBM (`boxDecidedAbove`), on a line on real measures as above (`owner`, `colour` or `model`). With the owner's weight beside a colour's package box the line reads `owner`, so «صندوق افتراضي» stays shown though §4.9 accepts that option.
- A default measure that names no option (stored counted or bare) goes only when every line clears it.
- The row's default measures stand whole, until the next compute or apply, when there is no line, or when an owner's pricing row of any field (a supplier or an additional cost too) was written after the latest lines (`pricing_inputs.updated_at` later than the row's `computed_at`; an apply writes both at the same instant).
- A measure removed from a package after the latest compute shows as default again only from the next compute, because packages carry no write time. For a colour's or a model's package, §4.9 refuses meanwhile where the type's default now decides. A measure removed from the product's package stays in the store, as the package's, until the next apply, so §4.9 accepts it until then.

The Flags tab lists exactly the estimated products (not paused) that have something to show, by the same rule in SQL (`LIST_WHERE.flags`). §4.9 is unchanged: it reads the row's soft codes and the store (D2).

### 4.7 Eligibility: which products an apply may write

A product may be applied only when **all** of these hold:
1. `price_estimate_control.apply_enabled = 1`. The owner turns it on (§7), and turning it on is refused until the purchase policy in force carries the estimate clause (§9 row 280; `purchase.version ≥ 7`).
2. `product_price_estimates.state` is `candidate` or `estimated`; its type is set and complete; `composition = ''`.
3. It is **never-on-published**: no `pricing_v2_sku_results` exist, or `products.price_estimate = 1`. A firm V2 price is never turned into an estimate (`EST_FIRM_PRICE`). If a stored method exists, it is `cost`.
4. No pending purchase review, and no import batch guard.
5. **Structure.** Either:
   - (a) the product is already pre-order-only on exactly its route: `sale_types = ['pre_order']`, one active transport equal to the route, and no enabled `direct_sale` fulfilment cell. No structure is written. This is how a merged or owner-built product is estimated. If its import stock decision is still `not_configured`, the stock conditions of (b) must also hold before the apply records `untracked`. Or:
   - (b) it can be prepared automatically. All of these must hold:
     - a `product_source_refs` row with `match_kind 'created'` and `stock_decision` `not_configured` or `untracked`;
     - **no** `product_option_fulfillment` row (owner-defined cells are the owner's);
     - every stock counter NULL: product, option values, colours and variants;
     - no `inventory_lots` row with `qty_remaining > 0`.

     The imported document is direct-sale-only today (`worker/lib/catalogImport/doc.ts`, lines 115–117) and its option values inherit (`availability_type: ''`, `writer.ts` line 1719). With no cells, the product's own `sale_types` decide (`adminProducts.ts`, lines 652–655).

   Anything else gives `EST_STRUCTURE_OWNER`. **A stocked or owner-configured product is never restructured.**
6. Every sellable SKU is priced (§3.7), no blocking flag is open, and the evaluation is complete.

### 4.8 Compute, then apply: one atomic batch per product

The router is `worker/routes/adminPriceEstimates.ts`, mounted inside `adminPricingRoutes` at `/estimates`, with the same door as §3.4.

**`POST /estimates/compute {cursor | product_ids[≤10]}`** writes no V2 table. For each product it:
1. classifies the product (§3.8);
2. builds the draft as the apply will (step 1 below) and the wire (§4.4–4.5);
3. calls `evaluateDesired`;
4. stores `price_estimate_lines`, the flags, `preview_hash` and `computed_at`. A candidate stores its latest preview's flags. An `estimated` row keeps the soft and hard flags its apply wrote (the published estimate's, the ones §4.9 accepts and D2 holds) and takes every compute's blocking and information flags: whole when they fit the 4,000-character column beside the kept entries, else with their combo keys counted (codes and field names kept), else none, so a previous refresh's blocking or information entry never outlives a newer refresh. The row keeps its flags as stored only when even its applied entries alone no longer fit (bare codes written long ago); a flag is never cut. The merge happens inside compute's upsert (§13, "Review fixes"). A refresh's own soft and hard codes are in the compute answer and on its lines.

It answers per product with `{state, type, sourcing, route, currency, flags, blocking, preview_hash, lines:[{combo_key, channel, source, supplier_amount, supplier_currency, measure_source, est_cost_iqd, est_price_iqd, published_price_iqd, change_pct, large}]}`.

**`POST /estimates/apply {items:[{product_id, preview_hash, confirm_large_change?}], cursor?}`** takes up to 5 products per call. It runs under the **per-invocation budget**: `countingD1` from `worker/lib/catalogImport/budget.ts` counts every read and batch, and the call stops before 900 statements (`D1_INVOCATION_STATEMENT_LIMIT` 1,000 minus a reserve of 100). A product whose reads plus batch would cross the budget is returned in `cursor`. One product's refusal never stops the others.

For each product, in order:
1. **Draft.** Read `products.updated_at` and the stored document. When §4.7 (5b) applies, build a `ProductWriteIntent` with:
   - `mode 'update'` and `relations: null`;
   - the document changed only in `sale_types = ['pre_order']`, `selling_type = 'pre_order'` and `preorder_transports = [{method: route, commission_iqd: 0, active: true}]`.

   A new route row with 0 commission passes the legacy money door, `pinLegacyDocMoney` (`v2/legacyMoney.ts`: 0 / '' / null are "nothing"). Pass the intent to `planProductSave`, then `draftLoadedOf`, then `loadV2Read(db, pid, draft)`.
2. **Evaluate.** Merge the wire (§4.5), then `desiredFor`, then `evaluateDesired`. If `ev.hash !== preview_hash`, answer `PRICING_PREVIEW_STALE` for that product with the fresh preview.
3. **Gate.** `gateV2({c, ev, hash, confirm, priceChange: true, publishing: <no V2 results yet>, preparedImportStock: true, preview})`. On a refresh, the 15% / 30% change needs the tick (no fresh sign-in since DECISIONS row 285). An incomplete product is refused (`PRICING_V2_PRICE_MISSING`).
4. **One batch.**
   - (i) `fence`: `price_estimate = 1 OR NOT EXISTS (V2 results)`, which is never-on-published at write time.
   - (ii) For (5b) only, `fence`: still no stock, no lots and no cells.
   - (iii) `untrackedDecisionStatements(db, pid, actor, now)`, only when `not_configured`. It writes the UPDATE `stock_decision = 'untracked' … WHERE match_kind = 'created' AND stock_decision = 'not_configured'` plus the audit row `product.import_stock_decision` with `source: 'estimate_apply'`. It is laid **before** `importStockFence`, the writer's step 0, exactly as `procurementImportStock.ts` does for `tracked`.
   - (iv) `v2WriteStatements(db, ev, {actor, now, source: 'estimate_apply', idempotencyKey: v2PriceKey(pid, ev.hash), structure: plan.statements, updatedAt, firstWrite, estimate})`:
     - `structure` is omitted in case (5a);
     - `firstWrite` is `firstWriteStatements(db, read.stored, foldedReviewOf(read, 'owner', actor, now))` when `ev.kind === 'v2_create'`, as `productSave.ts` does;
     - `estimate` is the **one new, additive option** of `v2/write.ts`. It is laid after step 9b and before the audit, inside the `engine-price:` token, and holds:
       - `fence(PREORDER_OFFERED_SQL)`, the `untracked` decision's own condition, now true after the structure;
       - `UPDATE products SET price_estimate = 1 WHERE id = ? AND price_estimate = 0` (T1 passes);
       - `DELETE FROM price_estimate_firm_skus WHERE product_id = ?`. A re-apply makes every SKU an estimate again;
       - the `product_price_estimates` upsert (`state 'estimated'`, `applied_*`, `applied_wire_json`, `measure_basis`, flags), fenced on the version read;
       - the replacement of `price_estimate_lines` through `json_each`.
   - The batch is capped at `V2_SAVE_STATEMENT_CAP` (600) when it carries structure, otherwise at `V2_PRICING_STATEMENT_CAP` (200), the caps `v2/write.ts` names for its two callers.
5. **After the batch.**
   - `afterProductsChanged(c, [pid])` (`worker/lib/completenessHooks.ts`);
   - the page purge: `c.set('catalogueSlug')` for a single product, or `purgeCatalogueFromJob` (`worker/lib/edgePolicy.ts`) for a page of products;
   - outcomes as `v2BatchOutcome`: `already`, `PRICING_CHANGED`, `IMPORT_STOCK_NOT_CONFIGURED`.

   The V2 batch's own `priceRequestTransitions` (step 9b) answers open price requests.

**There is no unlabelled moment.** The label and the first price commit together; FX-5, form saves and purchase reviews never touch the label; a SKU added later and priced by any door is labelled because the label is per product.

### 4.9 Confirmation: removing the label

`POST /estimates/products/:id/confirm {version, accept_flags: string[], combo_keys?: string[], real_measures?: {weight_g?, box_mm?}}`:
0. **The owner's statement of real measures** (DECISIONS row 292; owner 2026-11-04, «there as problem i cant click on تأكيد السعر»). `real_measures` is sent only after the owner ticks «هذه القياسات صحيحة لهذا المنتج» under the very values the estimate is priced from, which the sheet shows from `confirm_gate` (below). The weight is whole grams; the box is `[L, W, H]` in whole millimetres, as the pricing form's box. Each is within the form's limits (`MAX_WEIGHT_G`, `MAX_BOX_MM`); at least one is present, and no other key. Otherwise the answer is 400 `PRICING_INPUT_INVALID {field: 'real_measures'}` (or `UNKNOWN_FIELD`). The pure judgement is `attestBaseMeasures` (`packages/pricing/src/estimateInputs.ts`):
   - Each stated value must be a base field that `applied_wire_json` records as `type_default`, that the store still holds (the estimator's, §4.5), and that equals the stated value. For the weight, no pricing weight may decide the level first; for the box, no manual CBM may be there. Otherwise the answer is 409 `PRICING_CHANGED`: what the owner saw is no longer the store, and the sheet reads it again.
   - The type's CBM written as `manual_cbm` decides its level before any box (LD6), so there is no box to state. The product's own package must be empty there or hold the very value. A stated weight is never lighter than the product's own net weight (`products.net_weight_g`): packed, a product weighs at least itself, and the product form already says «الصندوق أخف من محتواه» of such a package. These refuse with 409 `PRICE_ESTIMATE_DEFAULT_MEASURES {combo_keys, reason: 'type_cbm' | 'package_differs' | 'package_partial' | 'below_net', waiting_on_apply?}`. No new code is added; the workspace says the reason with its cure (`CONFIRM.typeCbm`, `packageDiffers`, `packagePartial`, `belowNet`).
   - Taken, the statement is written in the confirmation's own batch, after its two fences and before step 3's statements:
     - The package where it is empty, `[L, W, H]` → depth, width, height (the conditional UPDATE of `catalogImport/packageMeasures.ts`). The product's `updated_at` moves with it, so an open product form meets `STALE_EDIT` and never writes its empty package back over the new one. A fence holds the package to the stated values, so a value typed meanwhile stays and the batch is refused (`PRICING_CHANGED`).
     - The record: the stated fields are re-sourced to `product_package`.
     - The row's default-measure flags keep only the SKUs still on a default, and `measure_basis` is recomputed (`measureBasisOf`, the very rule `planEstimateInputs` states it by).
     - The latest lines of every SKU whose measures the record now reads as real: their `measure_source` and default-measure codes, the line's other codes kept, within the column through compute's own `lineFlags` — exactly as the next compute writes them (`tests/priceEstimateAttest.test.ts` compares the stored lines after the statement with those after the next compute).
     - The audit `price_estimate.measures_attested {product_id, fields, package, skus}` (names only). The confirmation's own audit adds `measures_attested: true`.
   - **No price moves.** The base pricing row is untouched (`inputs_seq` and `write_seq` stay), V2 never reads the product-level package (`chainOfUnit`), and the price image has no package column. `tests/estimateInputs.test.ts` proves that the next plan writes nothing and records exactly what the statement recorded. `tests/priceEstimateAttest.test.ts` proves that the pricing inputs, the sequence and every published price are unchanged.
   - The statement is the product's (its base row), so every option priced from those defaults becomes real; only the options confirmed turn firm.
   - All the checks run before the batch, so a refusal at any step writes nothing. A catalogue import's guard (0195 on the package, 0218 on the bookkeeping) answers `PRICE_ESTIMATE_NOT_ELIGIBLE {flags: ['EST_IMPORT_RUNNING']}`, which the sheet says in the flag's own words, «استيراد الكتالوج يعمل الآن — أعد المحاولة بعده» / 'A catalogue import is running — try again after it', not the contract's «compute again».
   - Without `real_measures` the call is exactly as before; the only exception is step 3's flag strip. D2, trigger T2 and the CHECK are unchanged.
1. **Resolve the measures.** Each targeted SKU is resolved with `resolveSkuInputs(chainOfUnit(…))`. A measure is **defaulted** when it resolves from the base-row field that `applied_wire_json` records as `type_default` and the stored value still equals it. If any targeted SKU is defaulted, the call is refused with 409 `PRICE_ESTIMATE_DEFAULT_MEASURES`, and **no flag can override this**. It is owner decision D2 together with requirement 4.
   - The refusal also carries `waiting_on_apply: true` when the real measures of every refused SKU wait on the refresh's apply: every latest line of each is on measures no type default is left in once that refresh is applied (`product`, `owner`, `colour` or `model`), «التحديث» lists the product (`refreshStateOf`, the rule of §7), and no owner's pricing row was written since those lines. The workspace then says `CONFIRM.applyFirst`, «قياساتك الحقيقية تنتظر تطبيق التحديث: طبّقه من «التحديث» أولًا، ثم أكّد السعر.» / 'Your real measures are waiting for the refresh to be applied: apply it in “Refresh” first, then confirm the price.' / «پێوانە ڕاستەقینەکانت چاوەڕێی جێبەجێکردنی نوێکردنەوەکەن: سەرەتا لە «نوێکردنەوە» جێبەجێی بکە، پاشان نرخەکە پشتڕاست بکەرەوە.», in place of the contract's words.
   - This changes words only: which SKUs are refused is unchanged, and a failed read gives no field.
   - A measure typed in the pricing form at the product level that equals the type's default is read as the estimator's (the merge compares values, §4.5). It is refused with the contract's words until it is entered in «الأبعاد والوزن» or at a colour or model level. The confirmation now offers the owner's statement (step 0) for exactly those values, which makes them real in one step.
   - **The sheet's live gate.** `GET /estimates/products/:id` of an estimated product carries `confirm_gate` (`confirmGateOf`, `confirm.ts`), read from the same store, record and package as this step, and null on any failed read:
     - `defaulted`: the SKUs this step refuses now.
     - `waiting_on_apply` and `waiting_keys`: whether that refusal would carry `waiting_on_apply`, for the whole product and option by option.
     - `real_measures`: the statement on offer and the SKUs it makes real (`measureGate`; each measure is judged alone, so an option whose box is its colour's needs the weight alone).
     - `blocked`: why the other SKUs cannot be stated real.
   - The sheet holds exactly the options the gate holds. Only an older server's answer, which has no gate, falls back to the latest lines (`confirmGate`); the press then goes to the server, which judges. Every confirmation of the test worlds (`tests/fixtures/confirmGate.ts`) holds the gate and the server to each other, for the whole product and for chosen options.
2. **Check the soft flags.** Every open soft flag must be named in `accept_flags`, else 409 `PRICE_ESTIMATE_FLAGS_OPEN`, which lists the codes. The open soft flags of the targeted SKUs are the applied estimate's `flags_json` plus what the catalogue says of those SKUs at confirm time: `EST_SNAPSHOT_STALE` (the type's `stale_after_days`), `EST_SOURCE_ITEM_MISSING` and `EST_SUPPLIER_OUT_OF_STOCK`, read with the same `supplierPricesFor` as compute.
3. **Write.**
   - **Whole product** (no `combo_keys`, or every priced SKU): one batch that sets `product_price_estimates.state = 'confirmed'`, `measure_basis = 'real'` and `confirmed_*` **first**, then `UPDATE products SET price_estimate = 0` (T2 passes), then deletes the firm rows and writes the audit. The pages are purged afterwards.
     - The same UPDATE drops the default-measure entries (`EST_DEFAULT_WEIGHT`, `EST_DEFAULT_BOX`) from the row's `flags_json`. Step 1 has just proved that none is left. Before this a product confirmed on the owner's typed measures kept those entries and showed «وزن افتراضي»; `shownFlags` now never shows a confirmed row's default-measure entries, so a product confirmed before this change shows none either (its other entries are shown as stored).
   - **Some SKUs:** INSERT those SKUs into `price_estimate_firm_skus` (T4 passes) and write the audit. The label stays for the others.

Other actions:
- **"Return to estimate"** is a re-apply (§4.8).
- **Pause** (`PUT /estimates/products/:id {state:'paused'}`) stops refreshes and leaves the label alone.

### 4.10 Repricing

| Trigger | What happens |
|---|---|
| Rates move (U, E, C) or freight moves | `staleReasonsV2` (`v2/stale.ts`) lists the product and FX-5 (`autoReprice.ts`) rewrites prices only, under `large_change_pct` 15% / `max_drop_pct` 30%. A held change shows `EST_LARGE_CHANGE_HELD`. The label is unaffected, since FX-5 lays no `estimate` statements. Placed orders keep their order-time prices. While an FX review is pending, the effective rate does not move (`rates.ts` `review_pending`). |
| New snapshot, type edit, new SKUs (a delta import added a colour), or match decisions | The workspace's Refresh tab runs compute and lists old → new with %, keeping owner-edited fields. The owner applies in bulk under the same gates. Automatic application is owner question 282(b), default no. |
| The owner sets or changes a type's profit ceiling (§4.11) | Like a type edit: compute plans each SKU's price under the ceiling (a dollar charm price from $5 up, a house price under it) and lists the moved prices in «التحديث» (and «جاهز للتطبيق» for candidates); the large drops need the tick, which one box gives the whole page; each product is applied on its own preview hash. Between applies FX-5 keeps each SKU's USD profit and never re-derives the ceiling or the price. |

### 4.11 The profit ceiling and the dollar charm price (DECISIONS row 291; migration 0222)

The owner, 2026-11-05: «re calculator of price f all  سعر تقديري to products because they are become very expensive». A first version capped every type at 25%; he then ruled «dont make 25% on all product . it called the smart pricing so priced from 0% to 25% or 30 or 35 or even 50 and 100», «do from 0 to 100 you choose what you want, but we want cheap price so we need to become cheapest iraqi supplier < recommand 0% to 25% >» and «still nor cheapest enough . more cheaper» — ceilings of 3–10% per type — and the same day «… low the usd calculate to 1600 instead of 1690 … and make the price for product be like that 9.99$ , 19.99$ 24.99$ and ect …», «product prices, the $ display and customer wallets is 1600»; asked what a dollar really costs him: «1,600 is my real cost now». One fixed profit per type had made cheap parts dear: the Nozzle Wiping Plate (R = 3,862 IQD at 1,690, a spare part at $6) sold at 14,250.

**The ceiling.** `price_estimate_types.profit_cap_pct` is the type's profit ceiling P, a percentage of cost (TEXT; 0 ≤ P ≤ 100, at most two decimals; NULL is no ceiling, today's prices exactly; no seed). The type's dollar profit T stays as it is: today's price, R + T × U rounded, is the top. The owner's ceilings, typed in «الأنواع والمفاتيح» after the deploy:

| Types | P |
|---|---|
| makers_supply, spare_part, accessory | 10 |
| electronics_part, laser_material, hotend, build_plate | 8 |
| filament, filament_pack, electronics_device | 6 |
| ams | 4 |
| printer, laser_machine | 3 |

**The dollar charm grid** (`packages/pricing/src/charmPrice.ts`), the grid the owner set his own products on the same day ($11.99, $18.99, $329.99, $749.99, $1,249.99):

| Dollar price | A price every | Ending in |
|---|---|---|
| under $10 | $0.50 | .49 / .99 |
| $10–$100 | $1 | .99 |
| $100–$1,000 | $5 | 4.99 / 9.99 |
| from $1,000 | $10 | 9.99 |

**From $5 up only** (`CHARM_MIN_USD = 5`; the lead's ruling for the owner the same day, who wants the cheapest Iraqi prices and charm prices «like 9.99$ , 19.99$ 24.99$»). Under $5 the grid's $0.50 step is too coarse: 800 IQD at 1,600, a tenth of a $5 price and most of a $0.99 one — at a 10% ceiling a cost of 784–1,334 IQD sold at $0.99 = 1,750 (+31% to +123%) and one of 1,335–2,134 at $1.49 = 2,500. So a charm price is used only at $5 or more ($5.49 the lowest used, `LOWEST_USED_CHARM_CENTS`), and under that a SKU takes the plain house price under its ceiling — the shop's own rounding (`roundPriceIqd`, DECISIONS row 245): multiples of 250 IQD above 1,000, whole dinars at or under it. Its dollar display is then that price's own figure (4,000 IQD shows $2.50), not a charm price — accepted.

**The choice** (`charmTarget`), per SKU: R its exact replacement cost on its route (`replacement_exact`), U the USD rate the engine prices at — 1,600, the owner's real cost of a dollar (a manual rate, adjustment 0: no separate cost rate) —, T the type's minimum profit, rp = `roundPriceIqd`:

```
todayD = rp(R + T × U)            the top: nothing ever goes up
capD   = R × (1 + P / 100)        the owner's ceiling, not rounded
margin = T_sku × U                the profit over R; it must keep one rounding step: 250 IQD,
                                  one dinar where the price is at or under 1,000 IQD (marginNeededIqd)

from $5 up — min(todayD, capD) reaches rp($5.49 × U), 9,000 IQD at 1,600 (9,500 at 1,690):
c      = the highest charm price of at least $5 with rp(c × U) ≤ min(todayD, capD) whose margin holds;
         with none, the lowest charm price whose margin holds
T_sku  = floor6(c − R ÷ U)        USD: the engine's dollar price (usd_ceil6) is c, its dinar price rp(c × U)

under it — whenever min(todayD, capD) < $5 × U, and from $5 × U to just under rp($5.49 × U),
where the only charm prices within the ceiling are under $5:
D      = the highest house price ≤ min(todayD, capD) whose margin holds;
         with none, the lowest house price whose margin holds
T_sku  = floor6((D − R) ÷ U)      USD: the engine's dinar price is D, its dollar price D's own figure
```

At exactly $5 × U (8,000 IQD at 1,600) the ceiling's only charm prices are $4.99 and below, so the house price applies: 8,000 at $5.00, where the grid's $4.99 sold it at the same dinar price; at 7,999, 7,750. At $5.49's dinar price (9,000) the grid applies, $5.49; at 8,999, the house price 8,750. At 1,690 the same edges are 8,450 (8,250 either side) and 9,500 ($5.49; 9,250 just under it). Between the two edges a house price's own dollar figure is $5 or more and off the grid — $5.00 to $5.79 at 1,600 — and where no house price within the ceiling keeps the margin, the lowest that does can reach $5.49's own dinar price or one step over it: 9,000–9,250 IQD at 1,600 (R 8,600 at 0%: 9,000 at $5.63; R 8,999: 9,250 at $5.79), 9,500–9,750 at 1,690 (R 9,400: 9,750 at $5.77) — still cheaper than the grid's lowest charm price that keeps the margin ($5.99 = 9,750 at 1,600). Read literally — the grid from a ceiling of $5 × U, the plain rule only under it — the ruling would sell these ceilings at $5.49 or more, above the ceiling (a ceiling of 8,000 at 9,000); the plain rule keeps them within it wherever a house price there keeps the margin, and is never dearer.

**The floor is a margin, not a price.** priceV2's route floor (Q1) blocks a route whose price is not above its cost rounded up, `roundPriceIqd(R_r) ≥ D` (`V2_ROUTE_BELOW_COST`), and between the owner's applies FX-5 keeps T_sku in dollars and prices R + T_sku × U at each new rate. A price only just above rp(R) clears the route at the compute and closes it at the next rate tick: with a margin of 10 IQD (R 4,990 at 5,000) a cost of 5,001 rounds up to the very price (5,011 → 5,250 = rp(5,001)); the review's own case was 34 IQD (R 4,750 at the grid's $2.99). FX-5 then holds the product (`V2_ROUTE_BELOW_COST`, the owner's bell) and it keeps selling at its old price — under its new cost once that passes it. The review of 2026-11-05 measured it on 60 cheap makers parts applied under a 10% ceiling at 1,600: after CNY 0.15 → 0.153 four were held; after USD 1,650 three, one selling under cost; after USD 1,700 three, two under cost. Today's rule (T × U ≥ 2,400) held none. With a margin of one rounding step, R + T_sku × U stays above rp(R) whatever R and U do upward, so FX-5 follows every rise (`tests/priceEstimateProfitCap.test.ts`: the dollar at 1,700 and the yuan at 0.153 over twenty such parts, no route held, none at or under its cost; FX-5's own 15% guard holds the cheapest for review, below). A fall of U alone shrinks the margin in dinars: FX-5 may then hold a product, at its old price, which stays above its new cost, until the owner's next compute.

Every dinar figure the choice weighs is the engine's own price at that profit, `roundPriceIqd(R + T_sku × U)`; for a whole-dinar U it is `rp(c × U)` (R + T_sku × U sits less than U ÷ 10⁶ under c × U, a whole number of hundredths), and under $5 it is D for any U short of a million (no rounding step lies within U ÷ 10⁶ under a house price). One exception keeps a promise the grid cannot, and one rule says what today's own dinar price shows:
- **nothing goes up**: when the lowest price (charm or house) whose margin holds is dearer than today's price while today's price clears the route floor rp(R), the type's T stays — today's price exactly, no new rule;
- **today's dinar price shows c** (the lead's ruling for the owner after the live re-pricing of 2026-11-05, on his «make the price for product be like that 9.99$ , 19.99$ 24.99$»): a charm price whose dinar price IS today's sells there at its own T_sku = floor6(c − R ÷ U − Δ), so the dollar shown is c. Until then it kept T («no new rule for no change») and showed today's own figure, ceil(100 × (R ÷ U + T + Δ)) cents, which lands within one rounding step's worth of c on either side at the very same dinar price: that day 14 of the 785 estimated cards at 9,000 IQD or more were off the grid that way — the hardened-steel combo showed $69.04 at 110,500, where $68.99 sells at the same 110,500. No dinar price moves at that compute's R and U (between applies see «The route floor and FX-5», below). T_sku keeps the margin like any charm price and lies within one rounding step's worth of T (under 250 ÷ U, $0.156 at 1,600), below it or above it — so some dollar figures rise a few cents at the same dinar price ($99.94 → $99.99 on a mainboard; orders and wallets are charged in dinars). T still stays — no new rule for no change — where nothing a customer sees would change: today's own dollar figure already is c (the storefront's rounding up to the cent decides: $19.9815 shows $19.99), or the price is a house price (under $5 its dollar figure is its own either way); and where T_sku would pass the $100,000 a rule may carry.

**Today's plan unless the new one costs nothing: at most 19 SKUs, both plans exact.** The ruling's extra rules must never cost a dinar, now or at any later compute. Past the wire's 60 rows the planner falls back to one profit per group or to no ceiling (below), which would lift a sibling the ceiling sells under today's price back up to today's: 70 colours of a makers part, 35 at $19.99 = 32,000 under today's 32,500 and 35 at $19.99's dinar price, today's own 32,000 — their 35 new profits need 70 rules, and the shared profit sells the first 35 at 32,500. Written where they fit, the same rules stay on the record and count against every later wire, which must take them back or rewrite them: a 62-SKU part with 60 SKUs on such rules, when its last colour's supplier price moves to 450 CNY, needs 60 clears + 2 rules, so that colour shares 117,750 where today's code sells 117,000; with all 62 on record a re-compute with nothing changed is `EST_TOO_MANY_SCOPES`, the ceiling emptied too; 16 colours × 3 models, 48 SKUs, ride a dearer profit, up to 500 IQD, when two models take boxes of their own. So `planEstimateProfits` plans today's targets first (each such SKU at T) and takes the new ones only
- **on a product of at most 19 SKUs** (`MAX_SKUS_SHOWING_C_AT_TODAY`; every SKU of the grid counts, the owner's too). A write is at most the product's own row, one rule per SKU it wants and one per SKU of the last apply to take back, so at N SKUs at most 2N + 1 rows, 3N + 1 if the grid doubled since: 58 at 19. So those rules on the record can never be what passes the wire at a later compute, and both codes plan the product alike. (2N + 1 ≤ 60, 29 SKUs, would hold only while the grid stands still: 27 colours gaining a model need 64 rows where today's code needs 47.) Past 19 SKUs no such rule is ever written, and a product that grows past 19 takes them back at its next apply; and
- **when both plans resolve every SKU to exactly its own target** within the wire.

Otherwise today's plan stands, byte for byte (`tests/estimateProfitCap.test.ts` (g), against the pre-change planner kept verbatim, `tests/fixtures/charmBeforeRuling.ts`: two worlds, compute after compute). On 2026-11-05 no affected product had more than 10 SKUs; of the seven estimated products past 19 SKUs (21, 22, 25, 26, 44, 50, 60) none showed such a figure. The one limit, pinned: a product of at most 19 SKUs carrying such rules that jumps past 40 SKUs between two computes, its next plan needing so many rules of its own that their sum passes the wire (19 colours, 17 of them on such rules, take three models at once and the 17 fall under today's the same day: 42 SKU rules + 19 colour rules, 61 rows, where today's code needs 44). Its colours then share the dearest profit: flagged `EST_CEILING_SHARED`, never above T, never blocked, for as long as those rules leave no room.

So the price is above todayD only when today's own price would not clear rp(R) (T × U under one rounding step, which `MIN_PROFIT_BELOW_ROUTE_FLOOR` already warns of): the floor forces it. P = 0 is the lowest price whose margin holds — a house price under $5, a charm price from $5 up. The first version's sub-$0.49 rule, min(T, floor6(P% × R ÷ U)), is gone with the threshold: under $5 the house price is the highest within the ceiling, never a dinar above it (696 IQD at 10%: 765, where min(T, P%) priced 766).

**The owner's differences and his own prices.** A cost-first price is R + T × U plus the SKU's option and colour differences Δ (the product form's ± in USD), never less than R + T × U (C-9), so only a positive sum moves it. The choice counts it: the price is rp(R + (T_sku + Δ) × U), the ceiling R × (1 + P / 100) + Δ × U — his difference stays on top of the share — and T_sku = floor6(c − R ÷ U − Δ), so the dollar price is still c (under $5, floor6((D − R) ÷ U − Δ), the price still D); the margin is (T_sku + Δ) × U. A negative sum moves nothing. A SKU priced at his own fixed dollar price (a «سعر خاص $» on it or its model, anchor `sku_fixed` / `model_fixed`) keeps T: its minimum profit is only its floor, and the ceiling leaves his price alone. Both are read from compute's first evaluation (`deltas_usd`, `anchor`; `routeFiguresOf`).

At U = 1,600:

| SKU | R (IQD) | Today | P | The ceiling's price | T_sku | Price | $ shown |
|---|---|---|---|---|---|---|---|
| Nozzle Wiping Plate (spare part, $6, 15 CNY) | 3,659.5 | 13,500 | 10 (or 0) | under $5: the house price, 340.5 over R | $0.212812 | 4,000 | $2.50 |
| The same, gold at the owner's +$1.30 | 3,659.5 + 2,080 | 15,500 | 10 | under $5: the house price under 6,105.45 | $0.162812 | 6,000 | $3.75 |
| The same at 100% | 3,659.5 | 13,500 | 100 | under $5: the house price under 7,319 | $2.244062 | 7,250 | $4.54 |
| Flush Cutter (accessory, $4.50, 75 CNY) | 18,431.2 | 25,750 | 10 | $11.99 | $0.4705 | 19,250 | $11.99 |
| An AMS ($45, 249 EUR by land) | 458,224 | 530,250 | 4 | $294.99 | $8.6 | 472,000 | $294.99 |
| A printer ($135, 1,599 EUR, 25,000 extra) | 2,928,824 | 3,145,000 | 3 | $1,879.99 | $49.475 | 3,008,000 | $1,879.99 |
| A spare part at 400.33 CNY | 96,138.7 | 105,750 | 10 | $65.99, at today's dinar price | $5.903312 | 105,750 | $65.99 (at T: $66.09) |
| The hardened-steel combo (accessory, $4.50, a 57.98 EUR store page) | 103,262.48 | 110,500 | 10 | $68.99, at today's dinar price | $4.45095 | 110,500 | $68.99 (at T: $69.04) |
| A spare part at 406.3 CNY | 97,571.5 | 107,250 | 10 | $66.99, today's own figure already | T, $6 | 107,250 | $66.99 |
| An accessory at 160,000 IQD | 160,000 | 167,250 | 10 | none between the margin and 167,250 | T, $4.50 | 167,250 | today's |
| At $5 × U exactly ($6 type) | 4,000 | 13,750 | 100 | only $4.99 under 8,000: the house price | $2.5 | 8,000 | $5.00 |
| At $5.49's dinar price ($6 type) | 4,500 | 14,250 | 100 | $5.49, the lowest charm price used | $2.6775 | 9,000 | $5.49 |
| Just under it ($6 type) | 4,499.5 | 14,250 | 100 | the house price under 8,999 | $2.656562 | 8,750 | $5.47 |
| A makers part ($1.50) at 4,760 IQD | 4,760 | 7,250 | 10 | 5,250 (5,000 would keep 240) | $0.30625 | 5,250 | $3.29 |
| A spare part at 5.94 CNY | 1,485.1 | 11,250 | 10 | 1,750 (1,500 would keep 14.9) | $0.165562 | 1,750 | $1.10 |
| An accessory at 3.4 CNY | 1,056 | 8,500 | 0 | 1,500 (444 over R) | $0.2775 | 1,500 | $0.94 |
| An accessory at 1.9 CNY | 696 | 8,000 | 0 / 10 | whole dinars: a dinar over R / its ceiling 765.6 | $0.000625 / $0.043125 | 697 / 765 | $0.44 / $0.48 |

`tests/charmPrice.test.ts` proves it over 374,880 cases — every whole-dinar cost to 17,000, a stride to 60,000, every 997th dinar to 3,000,000, the band edges, the $5 edges, random costs and fractions; P in {0, 3, 4, 6, 8, 10, 25, 100}; U in {1,600, 1,690}; the thirteen types' T and two under one rounding step; a difference on one case in nine: a ceiling under $5 × U, or under the dinar price of $5.49, never prices on the grid and one at or above that never prices plainly (225 cases exactly at $5 × U, 458 exactly at $5.49's dinar price, thousands just under each); on the grid c is at least $5, rp(R + (T_sku + Δ) × U) = rp(c × U) and the dollar price is c; plainly the price is a house price D, T_sku = floor6((D − R) ÷ U − Δ) and the dollar price is D's own, within a millionth; the price is above rp(R) and its margin holds, and after sampled rises of R and U it still clears rp(R); it is never above today's unless the floor forces it (a branch the small T reach); the price is the highest within the ceiling whose margin holds, else the lowest whose margin holds, in each branch; T stays only for today's price, and at a charm price only where today's own dollar figure already is c (4,626 charm prices at today's dinar price show c, 313 keep T). `tests/charmPriceAtToday.test.ts` sets the ruling against the rule it replaced — the pre-change `charmTarget`, kept verbatim as its oracle (`tests/fixtures/charmBeforeRuling.ts`) — over 300,000 seeded random figures (R to 4,000,000 IQD with fractions, P with decimals, U in {1,600, 1,690, 1,650, 1,525.5}, differences on a tenth): not one dinar figure moves; every difference is a T kept at today's price now `charm` there, its dollar figure exactly c (usd_ceil6 c itself), today's own not c, its margin kept, T_sku a storable rule within one rounding step's worth of T (6,390 moved, 4,125 above T and 2,265 below); everything else field for field; and at later rates, FX-5's arithmetic, each moved SKU at most one step from T's own price, two only after a rise of U. An independent reference that walks every house price from the cost up to the ceiling, and every charm price of at least $5, agreed on 420,000 further random cases — U in {1,450, 1,525.5, 1,600, 1,650, 1,690, 1,699.99}, costs to 3,000,000 with fractions, P with decimals, differences of either sign (this change's probe, not in the suite).

**Where it lives.** In the estimator only: `charmTarget`, `CHARM_MIN_USD`, `marginNeededIqd` and `priceAtProfit` (a SKU's price and margin at a profit another SKU set; `packages/pricing/src/charmPrice.ts`, pure), `planEstimateProfits`, `ceilingProfitUsd` and `withEstimateProfits` (`packages/pricing/src/estimateInputs.ts`, pure), `profitInputOf` and `routeFiguresOf` (`merge.ts`), steps 5a and 5b of `prepareEstimate` (`compute.ts`). The engine still sees fixed USD `target_profit` rules: D − R ≥ T_sku is asserted on every write, FX-5 keeps T_sku in dollars between applies (it never writes a rule, `v2/write.ts`), no percentage is stored in a rule, and no category or global rule exists. The ceiling moves only through the owner's reviewed compute and apply.

**Two evaluations.** Compute first evaluates the product as it sells with **no ceiling**: the plan, with every SKU the estimator prices at the type's T and the ceiling's own option, colour and SKU rules of the last apply back to inherit (the planner run with no P). Only so is every such SKU's R read whatever its last rule. When the type has a ceiling, or the last apply wrote ceiling rules, the planner takes each SKU's R, its differences and whether it sells at the owner's fixed price from that evaluation; when the planned wire differs from the first one, the engine evaluates it once more, and that second evaluation is the preview: its lines, flags and hash. Nothing planned for want of a cost (a SKU with no cost even at T) keeps the first wire and its evaluation, which blocks. Both are pure CPU with no D1 statement, so the 900-statement budget and `ESTIMATE_PRODUCT_READS` are unchanged, and apply re-prepares through the same code, so compute and apply agree on the hash. With no ceiling and no ceiling rule recorded, the first evaluation is today's, byte for byte, and nothing else runs.

**The representation** is the least specific exact one, as the supplier compaction picks (§4.4):
1. one product rule when every SKU the estimator prices takes the same profit (every single-SKU product; a filament whose colours cost the same);
2. otherwise the product rule stays T, and the SKUs whose profit is not T get rules on the values of **one** option group (option rules of two groups on one SKU would tie, and a tie takes the maximum);
3. else colour rules;
4. else one rule per SKU, at its canonical combo key.

Every candidate is resolved SKU by SKU with `resolveRuleAt` over the rules as the write would leave them; the first exact one wins. The product's row alone travels as text, as before; scope rows travel as the form's rule rows (`amount_usd: null` is inherit). T_sku depends on each SKU's own R, so SKUs of different costs take profits of their own nearly always.

**More than the wire takes.** When no exact candidate fits the form parser's 60 rows (`MAX_RULES_PER_WRITE`), the planner takes **one profit per group**: one product rule, the values of one option group, or the colours (a value whose SKUs would all take T, or one reaching an owner's SKU, gets no rule: its SKUs fall to the product's T). Each rule is the highest profit among the free SKUs it reaches, so every one sells at or above its own price's profit, its dollar price off the grid. Under $5 that would cost a step: a house price leaves no slack under the next one, so a SKU riding a dearer profit sells a whole 250 IQD step above its own price. So where every SKU a rule reaches sells under $5 at its plain house price, the rule is the **cheapest** of their profits — the highest at which none sells above its own house price — whenever each keeps its margin there (`priceAtProfit`); otherwise the least profit that keeps each at or above its own price with its margin (a group across 1,000 IQD, where the cheapest profit, a dinar's worth, is under one step for the SKUs above it); otherwise the dearest. Each candidate is resolved with `resolveRuleAt` and kept only when every SKU lands at most at T, so never above today's price (above it only where its own price already is), from $5 up at or above its own profit, and — whenever its profit is not its own nor today's T — with its margin at the price it resolves to. The one adding the least profit above the SKUs' own wins, then the one taking the least under their own prices, then the fewest rows, then the least specific. The SKUs above their own profit are named by `EST_CEILING_SHARED` (information: listed in Flags, never blocking); a SKU under $5 at a cheaper profit than its own sells at or under its own price and is not named. 61 SKUs at 2,000–2,060 IQD under 10%: one product rule at R 2,000's $0.15625, every one at its own price (2,250 and 60 at 2,500, each 250 IQD or more over its cost), no flag — the dearest profit, $0.311875, sold 59 at 2,750; at 900–960 IQD the cheapest, $0.025, sells each at or under its own price in whole dinars (900 at 940, 960 at 1,000), where the dearest sold 50 at 1,250 with a 90 IQD margin; at 970–1,030, $0.15625: the thirty under 1,000 IQD at 1,250, the others at their own. From $5 up the same 61 SKUs at 17,000–17,060 share $10.99's dearest profit, every one still at 17,750. The reviewer's 62-SKU filament (31 colours × spool / refill; the cost by colour, the box by model) is priced on its 31 colours, each the dearer of its two SKUs. When not even that fits (an owner-cleared ceiling rule keeps the product rule at T and the colours or values number more than 60), the product keeps today's rule at today's U — the very wire the first evaluation priced — with the same flag, and is not blocked: a product today's rule prices is never held back. `EST_TOO_MANY_SCOPES {fields: ['minimum_profit']}` now blocks only what no wire can carry: an owner's product rule with more than 60 of the ceiling's rules to take back to inherit.

**The record** (`applied_wire_json`): the product rule's amount stays in `minimum_profit` with source `type_default`; the scope rules go in `minimum_profit_scopes`, written only when non-empty, merged as §4.5 says.

**The owner's rules win.** A SKU an owner's option, colour or SKU rule reaches is his: no estimator rule at those levels ever reaches it (at the same level it would tie, more specific it would override), and only the product rule does, which his rule shadows. A SKU whose ceiling rule the owner cleared stays off the ceiling: the product rule it falls to then stays T. So does a SKU on c's own profit whose rule he overtyped and later removed, or whose T he typed over it: this is how any ceiling rule behaves, and it now reaches SKUs today's code left without a rule (never above T, `EST_OWNER_EDITED`). An owner's product rule means no profit amount is written, and the ceiling's own option, colour and SKU rules go back to inherit and leave the record — they would otherwise keep deciding their SKUs before his rule, unseen in the product form — so his rule decides every SKU as it did before the ceiling (a reviewed change: where the ceiling had lowered a price it is a rise, listed in «التحديث» and applied with the tick). His own scope rules and the ones he cleared are kept. A type with no T writes nothing (blocked). So the printers' model rules, and any price the owner set himself, stay exactly as they are.

**The route floor and FX-5.** No ceiling, 0 included, closes a route — at the owner's compute or after a later rise of R or U — and the first version's warning below a quarter of the cost (`PROFIT_CAP_BELOW_ROUTE_FLOOR`) is gone, words and all. Between applies FX-5 keeps each SKU's USD profit, so its price follows R and U and its dollar price leaves the grid (5.94 CNY of a spare part at 1,750: after CNY 0.15 → 0.1517 its cost is 1,501.26, FX-5 reprices it to 2,000, $1.11, +14.3%, and holds nothing); the owner's next compute reads the cost at T and prices it again (2,000, $0.311714). A SKU on c's own profit at today's dinar price is such a SKU, so «no dinar price moves» holds at the R and U of the apply, not past them: FX-5 prices R + T_sku × U where T would have priced R + T × U, (T_sku − T) × U apart, under one rounding step at the apply's rate, so at a later rate it sells at T's own price or one 250 IQD step from it, either side — above T's own price where T_sku is above T (two parts both at $65.99 = 105,750: at U 1,607 one sells at 106,250 where T sells 106,000; at 1,650 the other at 109,000 where T sells 109,250; the hardened-steel combo at 1,612, 111,250 where T sold 111,500; the mainboard at 1,590, 159,250 where T sold 159,000). Two steps only after a rise of U, rarely: T_sku almost a full step from T. At a given rate the odds are roughly its gap over 250 (78 IQD on the combo, 96 on the mainboard; about four in ten over random such SKUs); its dollar figure stays c while its cost follows the dollar. The next compute and apply read R at T and price it exactly as today's code (`tests/priceEstimateProfitCap.test.ts`), so this is one step, between applies, on those SKUs alone. FX-5's own guard still holds a move of 15% or more for the owner's review (`PRICING_V2_LARGE_CHANGE`, at the old price, above the new cost), and under $5 one 250 IQD step is that much below about 1,667 IQD: twenty makers parts under 10%, then the dollar at 1,700 — the cheapest, 1,500 → 1,750 (+16.7%), is held; the other nineteen follow.

**Deploy-ahead.** `loadTypes` reads `SELECT *`, so on a database without 0222 a type carries no `profit_cap_pct` key: no ceiling, today's prices, and the editor offers no field. `PUT /estimates/types/:key` writes the ceiling in a statement of its own, only when one is sent; on an older database a ceiling answers 503 `PRICE_ESTIMATES_NOT_INSTALLED {field: 'profit_cap_pct'}` and nothing is written (so does a column gone between the read and the write). `POST /estimates/types` answers and audits a new type's ceiling (null) only where the column exists (`pragma_table_info`). An older Worker on the migrated database ignores the column and the record's new key: its next reviewed apply puts T back on the product rule and leaves the scope rules, which it then reads as the owner's.

**The workspace.** Types: «سقف الربح (٪ من التكلفة، 0–100)» / 'Profit ceiling (% of cost, 0–100)' / «بەرزترین ڕێژەی قازانج (٪ی تێچوو، 0–100)», next to the minimum profit, 0 accepted, with its hint and no warning. The hint names the shop's dollar price grid, today's price as the top and the cost plus the share as the ceiling, says that a cheap item, where the grid's steps are too wide, takes the highest of the shop's usual dinar prices there instead, and that where none there keeps a safe margin over the cost the lowest that does decides, never above today's price; it carries no figure (invariant I8), held by name in `tests/estimateAdminUi.test.ts`. `EST_CEILING_SHARED` reads «خيارات أكثر من أن تأخذ كلٌّ منها قاعدة: بعضها مسعَّر فوق سعره تحت السقف، ولا يتجاوز سعر اليوم» / 'Too many options for a rule each: some are priced above their own ceiling price, never above today’s price' / its Sorani. Ready and Refresh: one box, «علّم كل التغييرات الكبيرة في هذه الصفحة» / 'Tick every large change on this page' / «هەموو گۆڕانە گەورەکانی ئەم پەڕەیە نیشانە بکە», ticks the tick of every row of the page that has a large change; each product is still applied on its own preview hash (DECISIONS row 278 (٤)). It ticks a large rise too (a new supplier price, or the owner's own product rule taking over): a row whose price goes up is left unselected unless the owner means it.

**Known consequences, left to the owner.**
- Under $5 there is no charm price: a price under it shows its own dollar figure (4,000 IQD: $2.50; 1,750: $1.10), even right after an apply — accepted with the threshold. From $5 × U to just under the dinar price of $5.49 (8,000–8,999 IQD at 1,600; 8,450–9,499 at 1,690) the ceiling's only charm prices are under $5, so the house price applies there too and fills the ceiling: a ceiling of 8,750 sells at 8,750, where the grid's $4.99 sold it at 8,000. Its dollar figure is then $5 or more and off the grid ($5.00 to $5.79 at 1,600), and where no house price within such a ceiling keeps the margin the lowest that does reaches 9,000–9,250 IQD at 1,600 ($5.63–$5.79) and 9,500–9,750 at 1,690 — $5.49's own dinar price or a step over it, not a charm price, still under the grid's $5.99.
- Under $5 the margin, not the grid, lifts cheap items above P where the ceiling's share is under one rounding step — always under today's price. At 10% and U = 1,600 a cost up to 909 IQD sells at its ceiling in whole dinars (784 → 862), 910–999 at 1,000 and 1,000 at 1,250; above that, wherever the highest house price under the ceiling keeps less than 250 over the cost, the lowest house price that keeps it decides (1,001–1,250 at 1,500, +20% to +50%; 1,251–1,500 at 1,750; 2,501 at 3,000; 4,751 at 5,250, +10.5%), elsewhere the ceiling (3,200 → 3,500); from 5,000 IQD, where 10% is 500, always the ceiling (5,000 → 5,500). The grid sold 784–1,334 IQD at $0.99 = 1,750 (+31% to +123%) and 1,335–2,134 at $1.49 = 2,500 (+17% to +87%). From $5 up the grid still decides, and where no charm price fits under the ceiling with its margin the lowest one whose margin holds does, above P (a 9,000 IQD cost at 0%: $5.99 = 9,750). The review's measures (80% of makers_supply SKUs above R × 1.1 at a mean of 18.9%, 21% of filament at 6%, 13% of laser_material at 8%) were taken before the $5 threshold.
- The margin costs one rounding step where the highest house price under the ceiling would have kept less than one (5.94 CNY of a spare part sells at 1,750, not 1,500 with 14.9 over its cost).
- Where no charm price lies between the margin and today's price (an accessory just over $100: the $5 step is 8,000 IQD, more than its $4.50 × 1,600 = 7,200), today's price stays and its dollar price is not a charm price.
- Between applies the price follows R and U and the dollar price leaves the grid (the Nozzle after CNY 0.15 → 0.16: 4,250, $2.65) until the next compute and apply price it again. A product whose dinar prices did not move is not listed in «التحديث» (the list shows price moves only); its computed hash still applies through `POST /apply`.
- **After deploying «today's dinar price shows c»** (above): a product of at most 19 SKUs whose only change is a SKU's rule and dollar figure — every charm price at today's own dinar price, 14 cards and about ten more product-page figures on 2026-11-05, none on a product past 10 SKUs — moves no dinar price, so «التحديث» does not list it and the workspace, which applies from Ready and Refresh only, never reaches it. Past 19 SKUs a compute changes nothing here: today's plan stands. Compute them, then apply each through `POST /api/admin/pricing/estimates/apply` with its fresh `preview_hash` (no tick: nothing moves 15%); a hash computed before the deploy no longer matches. Some of those dollar figures rise a few cents at the same dinar price ($19.95 → $19.99, $99.94 → $99.99), the rest fall ($69.04 → $68.99). The rule-(a) cards (the soccerbot, the wheel loader's «No» model, the 3 mm plywood kit) and an owner-edited product stay as they are.
- Between applies a SKU on c's own profit can sell one or two 250 IQD steps from where T would, above or under, until the next compute and apply («The route floor and FX-5»): the ruling's price at any later rate, on those SKUs alone. Compute skips a paused product, so it stays there.
- An owner's form save between applies acts on c's profit until the next compute and apply: $9 on a model sold 105,750 where today's code sells 110,500. The two match again after that compute and apply.
- FX-5's 15% guard holds the cheapest items for review on a rate rise where their next house price is one 250 IQD step of 15% or more (prices under about 1,667 IQD: 1,500 → 1,750 is +16.7%), at their old price; the grid's cheapest charm prices (1,750 and up) stayed under it.
- A fall of U alone can hold a thin-margin product under FX-5 at its old price (above its new cost) until the owner's next compute.
- A product with more options of distinct costs than one wire's 60 rules (the 62-SKU filament) carries `EST_CEILING_SHARED`: one SKU of each colour rides its sibling's dearer profit, off the grid, never above today's price. Under $5 its options share the cheapest profit that keeps every margin instead, each at or under its own price (some under it, their dollar figures under their dinar price's own); only a group whose prices straddle 1,000 IQD (or whose SKUs differ by the owner's differences) can still sell some a 250 IQD step above their own.
- After the rate change 1,690 → 1,600 (2026-11-05) about 1,078 estimated products are stale: their published prices still reflect 1,690. Compute and apply re-price them at 1,600, under the ceilings.
- Row 281's regression leak is easier (price ≈ (1 + P) × R within one grid step); 282(e)'s default (accept) stands.
- Percent offers, coupons and fixed member discounts can take cheap items below cost (warned, never refused).
- Open estimate orders keep their frozen estimate (T7): settling at the old price or proposing the lower one through 0140 is his call.
- Trade-in «سعر اليوم» values a device from its lowest new price, so some valuations fall.
- Colour- and SKU-scope minimum profits are not drawn in the product form (`v2Model.ts` draws the product's and the models'); a form save of the product's minimum profit leaves them deciding their SKUs until the next compute and apply take them back (his product rule wins, above). With a profit per SKU, more products carry such rules than under the first version.
- Confirmed products keep their old prices; firm SKUs are reset by any apply (§4.8), so the live run skips those products.

---

## 5. Customer surfaces

### 5.1 State model

- **`price_status` stays `'priced' | 'unpriced'`** (`worker/lib/commercialState.ts`, `src/lib/priceStatus.ts`). An estimated SKU is priced: it carries an integer price. A third status would break `scripts/live-cost-probes.mjs` (lines 258–276 allow `null` only on objects marked `unpriced`) and the `=== 'priced'` checks. It would also make workflow 7's `unpriced_slug` probe meaningless. Estimated products are V2-published, so that probe never picks one.
- **One new boolean, `price_estimate`.** It is emitted **only when true**, so every non-estimate payload is byte-identical to today's. It carries no figure and is not in `CUSTOMER_ARITHMETIC_KEYS`.
- **No customer ever sees** a source, supplier price, flag, type, measure basis or match.

### 5.2 Where the label comes from

- **The product row.** `products.price_estimate` is read by the existing `SELECT *` of every listing, detail, cart and checkout query: `worker/routes/products.ts` reads `SELECT * FROM products`, and `computeCheckout` reads `p.*`. It is the same row the price is read with, so there is no extra statement or D1 wave. `parseProductRow` sets `doc.price_estimate = true` only when the column is 1. The key is read-only: it is not in `PRODUCT_COLUMNS`, so saves never write it.
- **Firm SKUs.** One more arm in the overlay's single SKU-price statement (`skuRowsV2Sql`, `worker/lib/productOverlay.ts`), for both the single and the batch read:

  `UNION ALL SELECT product_id, combo_key, NULL, NULL, 3, NULL, NULL FROM price_estimate_firm_skus WHERE <same where>`

  `skuPriceRows.parse` treats a row with marker `3` and a non-null key as a firm key **before** the price-row branch. `ProductRelationsView` gains `sku_firm?: string[]`, and `applyRelations` copies it onto the customer document. There is one fallback tier: with the arm, then without it, then the existing V2 → V1 chain.
- **Fail-closed reads.** On a failed read, `sku_firm` is absent and every priced SKU of a labelled product is an estimate. Unlabelled products are never affected, unlike safest's "unread label" fallback.
- **Helpers** in `commercialState.ts`:
  - `skuEstimated(doc, comboKey)` is `doc.price_estimate && !doc.sku_firm?.includes(comboKey)`;
  - `productEstimated(doc)` is true when any priced SKU (`skuPriced`) is estimated.

### 5.3 Surfaces

| Surface | Server | UI |
|---|---|---|
| Cards: home rails, `/products`, sections, search, favourites, the compare row | `price_estimate: true` on the **priced** card (`productEstimated`), added to `CARD_FIELDS` (`worker/routes/products.ts`). `catalogOnlyCard` never carries it. | `src/components/CardPrice.tsx`. Compact rows: second-line priority is a live offer's struck price, then «تقديري», then the member line. Regular rows: a muted «سعر تقديري» line under the price. `src/components/compare/PriceRow.tsx`: the same label. The strings come from the eager `src/lib/priceStatus.ts` (`ESTIMATE_TEXT`, `ESTIMATE_SHORT`, about 120 bytes). |
| Product page `GET /api/products/:slug` | `price_estimate` for the default selection | A chip beside the price, and the lazy `src/components/product/EstimateNotice.tsx` (notice + "Contact us") under the price card. In «عدة ألوان» the notice and «تواصل معنا» also show while the panel's total is an estimate (`onEstimateChange`: a colour with a quantity whose own quote, or until it answers the page's label, says so). ⚡ Quick Buy is hidden for an estimated selection. The pre-order route and lead time show as today. |
| Quote `POST /api/products/:slug/quote` | `price_estimate: skuEstimated(doc, selectionKey(...))`, after the per-SKU unpriced branch. `pricingModes` is unchanged, with one route. | The chip and notice follow the selection. A firm SKU of a mixed product shows none. |
| Cart (`worker/routes/cart.ts`, the `customerLinePrice` wrapper) | Each line carries `price_estimate`; the cart carries `has_estimates` | A chip per line and one note (cartNotice) under the total |
| Checkout quote `POST /api/orders/quote` | `estimate: {lines: [line ids], notice_version}`; `payment_methods` without `bnpl` / `gini` | The notice, the **required** checkbox, the button text «اطلب بالسعر التقديري», and a line saying the order can be cancelled until the final price is confirmed |
| Order page and order list (`orderPublic`, `customerOrderPricing`) | `items[].price_estimate: {state}`; `pricing_snapshot.estimate` projected through the allow-list; adjustments carry `reason_code` and, for estimate proposals, `lines[]` | `src/pages/OrderDetail.tsx`: a banner while any line is open, proposed or rejected; per-line state chips; `PriceApprovalCard` (estimate variant). The new lazy `src/components/orders/EstimateStatusCard.tsx` has the contact link with `orderId`. `OrderCard.tsx`: a small «بانتظار تأكيد السعر النهائي» chip. |
| Public API v1 (`worker/lib/publicApi/common.ts` `PRICE_SCHEMA` / `priceFromCard`; `resources/products.ts`; `docs/PUBLIC_API.md`) | `price.estimate: boolean` ("the amounts are an estimated pre-order price; the final price may differ") | n/a |
| Support assistant | It returns the listing's own cards (`resolveListingCards`), so `price_estimate` reaches its cards with no assistant change (`tests/assistPriceParity.test.ts` gains an estimated case) | Its cards render with `CardPrice` |
| Creative Studio (`worker/lib/creative/store.ts` `priceOfCard`) | A card with `estimate` is treated as **unpriced** for creatives: no advert states an estimate as a price | n/a |
| Print calculator materials (`worker/lib/printQuote/repository.ts` `loadMaterialPrices`) | Labelled products are skipped, falling back to the material default, so no firm print quote rests on an estimate | n/a |
| Notifications | The order-placed message (`notifyOrderPlaced`, `worker/lib/orderNotify.ts`) adds the orderPlaced sentence. These are server texts, so they reach customers on old tabs too. | n/a |
| Structured data | None exists today: no `priceCurrency` / `og:price` in `worker/` or `src/` | n/a |

**A combination the product does not sell** (row 283: a cell of a `VARIANT_COMBINATION` grid that `sellableSkus` leaves out) is never offered «طلب السعر», and the product page shows no figure for it.
- **Page body.** When the whole grid fits `ENGINE_MAX_SKUS`, `unoffered_selections` lists those combinations as canonical combo keys (`unofferedSkuKeys`). Past the limit they are not listed; for a `VARIANT_COMBINATION` grid whose kept set fits, the body carries `offered_selections` instead (`offeredPastLimitKeys`): the SKUs the product sells, at most 240 keys. A selection that is part of no SKU in that list is refused by the cart and by «طلب السعر», because the selection check answers from that very set. When the kept set itself passes the limit, or the grid passes `SKU_GRID_SCAN_MAX`, neither list is published, nothing counts as left out, and the selection check falls back to the relational validator, as before. Each list is absent when empty, so every other body is byte-identical, and the public API carries neither.
- **Page.** Such a selection (listed, or past the limit part of no listed SKU) is not offered. The page asks no quote for it. Through `noPrice`, the price card, the fulfilment choice with its «من …» pill, the route rows, the warranty plans, the status lines, the sales-mode chip and shelf note, «خبرني لما يرجع», the estimate notice and the buy controls step aside, and no level price stands for it (`levelPrice`). A priced product shows, in the price's place, only the chooser's words (`NOT_OFFERED`): «غير متاح مع هذا الاختيار» / 'Not offered with this choice' / «لەگەڵ ئەم هەڵبژاردنە بەردەست نییە». A catalog-only product keeps «السعر غير متوفر حالياً» and its sentence, with those words where the request panel was. On a phone the bottom bar says the same words (`data-bar-not-offered`) instead of an empty request slot.
- **«عدة ألوان».** A colour row whose combination the product does not sell is not offered: it is never quoted or priced, has no level figure and a disabled stepper, and its chip says the same words. When the colour the page holds behind the rows can no longer take a quantity (a change of the shared selection makes it a combination the product does not sell, or leaves it with no price, sold out on a direct sale or no longer offered with that selection), the page takes the first row that can, as entering «عدة ألوان» does, so the panel keeps its summary, total and add.
- **Quote (API).** On a strict (V2) product such a combination is answered on its ordinary path, availability `VARIANT_NOT_MODELLED` and the strict `VARIANT_UNAVAILABLE`, never `price_status: 'unpriced'`; its figures are other SKUs', and the page never asks for them. A valid unpriced SKU, and a part of a selection that names an unpriced choice, still answer 'unpriced'. A catalog-only product keeps 409 `PRICE_NOT_AVAILABLE` and adds `details.selection_errors: ['VARIANT_NOT_MODELLED']` for such a combination only. `selectionUnoffered` is never true for a part of a SKU the product sells (`PRICE_REQUEST_SELECTION_REQUIRED`), nor on a grid without relational rows past `ENGINE_MAX_SKUS`, where the check cannot tell a whole cell from a part; there the quote answers as before, and the page reads `offered_selections`.

**The product page words every code.** `reasonText` answers '' for a code it has no sentence for, and a blocking code with no sentence shows nothing (a cart refusal coded `VALIDATION` in a race is the one exception, §13). The page's `STRINGS` word every code the detail and the quote can bring it, in ar / en / ckb: `VARIANT_NOT_MODELLED`, `FULFILLMENT_NOT_OFFERED` and `FULFILLMENT_DISABLED` say «غير متاح مع هذا الاختيار»; `TRANSPORT_DISABLED` says the page's own «وسيلة النقل غير معروضة.»; `VARIANT_UNAVAILABLE` (a V2 SKU with no price on the chosen way) says the cart door's sentence «هذا الاختيار لم يعد معروضًا للبيع. اختر خيارًا آخر.», copied from `src/lib/refusalStrings.ts` so that file stays a lazy chunk. The add-to-cart refusal and the colour panel's per-row refusals read the same words.

**Edge cache.** `PUBLIC_PROJECTION_REVISION` (`worker/lib/edgePolicy.ts`) moves from `'usd-base-2026-10'` to `'price-estimate-2026-11'`, so no cached body without the key is served. Every apply and confirm purges the product's pages.

### 5.4 "Contact us for more information"

The link opens `/support?ask=price_estimate` with router state `{subject: <support.subject with the product name>}`. `src/pages/Support.tsx` already turns `routeState.subject` into the ticket prefill (`TicketPrefill`). Its `?ask=` allow-list (`qAsk !== 'choose_printer'`) gains `price_estimate`.

`worker/routes/support.ts` gains the intent `price_estimate`:
- It answers with support.answer and offers «تحدث مع فريقنا», which opens the ticket form with the subject filled.
- Guests read the answer without signing in. Creating a ticket still needs sign-in, through the existing `useSignInPrompt`.
- The link never sends a message by itself.

On the order page, the link also passes `orderId`.

### 5.5 Customer strings

These live in the new `packages/contracts/src/priceEstimates.ts`, imported only by lazy chunks and the server. Two copies exist, each pinned equal to the contract by a test:
- the two eager card labels in `src/lib/priceStatus.ts` (`tests/estimateStorefrontUi.test.ts`);
- the three estimate refusals the customer's trade-in screens can receive, in `src/components/tradeIn/parts.tsx` (`ESTIMATE_REFUSAL_COPY`, `tests/tradeInEstimateRefusal.test.ts`), so a /trade-in visit never loads the contract.

Every `ckb` string is written in Sorani with the codebase's own words:
- «خەمڵێنراو» for estimated (already used in several places);
- «پێشداواکاری» for pre-order (61 occurrences across `src`, `worker` and `packages`, against 5 for «داواکاریی پێشوەختە»);
- «پەیوەندیمان پێوە بکە» for "contact us";
- «دابینکەر» for supplier;
- «جزدان» for wallet;
- «پەسەند» for approve.

A native review is still recommended (DECISIONS row 183).

| Key | ar | en | ckb |
|---|---|---|---|
| label | سعر تقديري | Estimated price | نرخی خەمڵێنراو |
| labelShort | تقديري | Estimate | خەمڵێنراو |
| notice | هذا سعر تقديري للطلب المسبق، وقد يختلف السعر النهائي عند تأكيد طلبك مع المورّد. إن تغيّر السعر نرسله إليك لتوافق عليه أو تلغي الطلب، ولا نأخذ أي مبلغ إضافي دون موافقتك. | This is an estimated pre-order price. The final price may differ once we confirm your order with the supplier. If it changes, we send you the new price to approve or cancel — nothing extra is charged without your approval. | ئەمە نرخێکی خەمڵێنراوە بۆ پێشداواکاری، و لەوانەیە نرخی کۆتایی جیاواز بێت کاتێک داواکارییەکەت لەگەڵ دابینکەر پشتڕاست دەکەینەوە. ئەگەر نرخەکە گۆڕا، نرخە نوێیەکەت بۆ دەنێرین تا پەسەندی بکەیت یان داواکارییەکە هەڵبوەشێنیتەوە — بەبێ ڕەزامەندیی تۆ هیچ بڕە پارەیەکی زیاتر وەرناگیرێت. |
| contact | تواصل معنا لمزيد من المعلومات | Contact us for more information | بۆ زانیاریی زیاتر پەیوەندیمان پێوە بکە |
| cartNotice | في سلتك منتجات بسعر تقديري؛ قد يختلف سعرها النهائي، وسنطلب موافقتك قبل أي مبلغ إضافي. | Your cart has items at an estimated price. Their final price may differ, and we will ask for your approval before charging anything extra. | لە سەبەتەکەتدا بەرهەمی بە نرخی خەمڵێنراو هەیە؛ لەوانەیە نرخی کۆتاییان جیاواز بێت، و پێش وەرگرتنی هەر بڕە پارەیەکی زیاتر ڕەزامەندیت وەردەگرین. |
| checkoutAck | أفهم أن أسعار المنتجات المعلَّمة «سعر تقديري» قد تتغيّر، وأن طلبي لا يُجهَّز قبل تأكيد السعر النهائي، وأن أي تغيير سيُعرض عليّ لأوافق عليه أو ألغي الطلب قبل تحصيله. | I understand that items marked “Estimated price” may change in price, that my order is not prepared until the final price is confirmed, and that any change will be sent to me to approve or cancel before it is charged. | تێدەگەم کە نرخی ئەو بەرهەمانەی نیشانەی «نرخی خەمڵێنراو»یان هەیە لەوانەیە بگۆڕێت، و داواکارییەکەم ئامادە ناکرێت تا نرخی کۆتایی پشتڕاست نەکرێتەوە، و هەر گۆڕانکارییەک پێش وەرگرتنی پارەکەی بۆم دەنێردرێت تا پەسەندی بکەم یان داواکارییەکە هەڵبوەشێنمەوە. |
| checkoutButton | اطلب بالسعر التقديري | Order at the estimated price | بە نرخی خەمڵێنراو داوا بکە |
| checkoutCancel | حتى تأكيد السعر النهائي يمكنك إلغاء الطلب واسترداد ما دفعته. | Until the final price is confirmed, you can cancel the order and get back what you paid. | تا نرخی کۆتایی پشتڕاست نەکرێتەوە، دەتوانیت داواکارییەکە هەڵبوەشێنیتەوە و ئەوەی داوتە وەربگریتەوە. |
| line.open | بانتظار تأكيد السعر النهائي | Awaiting final price confirmation | چاوەڕێی پشتڕاستکردنەوەی نرخی کۆتایی |
| line.proposed | مطلوب موافقتك على السعر النهائي | Your approval of the final price is needed | پێویستە نرخی کۆتایی پەسەند بکەیت |
| line.confirmed (also approved) | تأكّد السعر النهائي | Final price confirmed | نرخی کۆتایی پشتڕاست کرایەوە |
| line.rejected | رفضت السعر النهائي — يمكنك إلغاء الطلب واسترداد ما دفعته، أو انتظار تواصلنا. | You rejected the final price — you can cancel the order and get back what you paid, or wait for us to contact you. | نرخی کۆتاییت ڕەت کردەوە — دەتوانیت داواکارییەکە هەڵبوەشێنیتەوە و ئەوەی داوتە وەربگریتەوە، یان چاوەڕێی پەیوەندیی ئێمە بیت. |
| orderPlaced (message) | طلبك يتضمّن منتجات بسعر تقديري؛ سنؤكد السعر النهائي قبل الطلب من المورّد ونطلب موافقتك إن تغيّر. | Your order includes items at an estimated price; we will confirm the final price before ordering from the supplier and ask for your approval if it changes. | داواکارییەکەت بەرهەمی بە نرخی خەمڵێنراوی تێدایە؛ پێش داواکردن لە دابینکەر نرخی کۆتایی پشتڕاست دەکەینەوە و ئەگەر گۆڕا ڕەزامەندیت وەردەگرین. |
| confirmedNoChange (message) | تأكّد السعر النهائي لطلبك {id} دون تغيير. | The final price of your order {id} is confirmed — no change. | نرخی کۆتایی داواکارییەکەت {id} بەبێ گۆڕانکاری پشتڕاست کرایەوە. |
| confirmedTotalUnchanged (message; its body lists each moved line, estimate → final) | تأكّدت الأسعار النهائية لطلبك {id}: تغيّر سعر بعض المنتجات، ولم يتغيّر الإجمالي. | The final prices of your order {id} are confirmed: some item prices changed, but the total is unchanged. | نرخە کۆتاییەکانی داواکارییەکەت {id} پشتڕاست کرانەوە: نرخی هەندێک بەرهەم گۆڕا، بەڵام کۆی گشتی نەگۆڕا. |
| estimateReason (0140 reason, `reason_code` ESTIMATE_FINAL_PRICE) | تأكّد سعر المورّد النهائي لمنتجات طلبتها بسعر تقديري. | The supplier's final price is now confirmed for items you ordered at an estimated price. | نرخی کۆتایی دابینکەر بۆ ئەو بەرهەمانەی بە نرخی خەمڵێنراو داوات کردبوون ئێستا پشتڕاست کرایەوە. |
| estimateRejectNote (approval card) | إن رفضت السعر الجديد فإما أن نُبقي سعرك الأصلي أو نلغي الطلب ونعيد لك كامل المبلغ، ويمكنك أنت أيضًا إلغاء الطلب. | If you reject the new price, we either keep your original price or cancel the order and refund you in full; you can also cancel the order yourself. | ئەگەر نرخە نوێیەکە ڕەت بکەیتەوە، یان نرخە سەرەتاییەکەت دەهێڵینەوە یان داواکارییەکە هەڵدەوەشێنینەوە و هەموو پارەکەت دەگەڕێنینەوە؛ هەروەها خۆشت دەتوانیت داواکارییەکە هەڵبوەشێنیتەوە. |
| support.chip | ما معنى السعر التقديري؟ | What does “estimated price” mean? | نرخی خەمڵێنراو مانای چییە؟ |
| support.answer | السعر التقديري هو السعر المتوقَّع لطلب مسبق قبل أن يؤكّده المورّد. نؤكد السعر النهائي عند طلب منتجك من المورّد، وإن تغيّر نرسل لك السعر الجديد لتوافق عليه أو تلغي الطلب. هل تريد التحدث مع فريقنا؟ | An estimated price is our expected price for a pre-order before the supplier confirms it. We confirm the final price when we order your item from the supplier; if it changes, we send you the new price to approve or cancel. Would you like to talk to our team? | نرخی خەمڵێنراو ئەو نرخەیە کە بۆ پێشداواکاری چاوەڕێی دەکەین پێش ئەوەی دابینکەر پشتڕاستی بکاتەوە. کاتێک بەرهەمەکەت لە دابینکەر داوا دەکەین نرخی کۆتایی پشتڕاست دەکەینەوە؛ ئەگەر گۆڕا، نرخە نوێیەکەت بۆ دەنێرین تا پەسەندی بکەیت یان داواکارییەکە هەڵبوەشێنیتەوە. دەتەوێت لەگەڵ تیمەکەمان قسە بکەیت؟ |
| support.subject | سؤال عن السعر التقديري: {name} | Question about the estimated price: {name} | پرسیار دەربارەی نرخی خەمڵێنراو: {name} |
| priceRequest.title | {name} متاح الآن للطلب المسبق بسعر تقديري | {name} can now be pre-ordered at an estimated price | {name} ئێستا بە نرخی خەمڵێنراو بۆ پێشداواکاری بەردەستە |

**Refusal codes.** The texts live in the same contract as `ESTIMATE_REFUSALS`. They are **not** added to `src/lib/refusalStrings.ts`, a lazy chunk of its own (never in the entry: `tests/bundleBudget.test.ts`) that many screens load for their refusals, the product page only on its first one. Every screen that can receive one (Product, Cart, Checkout, OrderDetail, the admin panels, all lazy), except the customer's trade-in screens, resolves it through `estimateRefusalText(code, lang)` before `apiRefusal`; the admin trade-in intake sheet does the same (`intakeRefusalText`, `src/components/adminTradeIn/IntakeSheet.tsx`). Elsewhere the server's ar / en message is the fallback. The customer's trade-in screens resolve the three refusals their doors answer through the copy (`estimateRefusalCopy`, read first by `tradeInRefusalText` in `src/components/tradeIn/parts.tsx`):
- 503 `PRICE_ESTIMATES_READ_FAILED`: the paid-net read of the eligible, draft, preview and submit doors, and the cart's estimate switch;
- 409 `PRICE_ESTIMATE_ORDERING_PAUSED` and 409 `PRICE_ESTIMATE_PREORDER_ONLY`: the cart door that «أكمل الشراء» adds the credit's device through, once that device's price became an estimate.

No other door those screens call answers an estimate code; any other code reads `src/lib/refusalStrings.ts`, then the server's sentence, then the fallback.

| Code (HTTP) | ar | en | ckb |
|---|---|---|---|
| PRICE_ESTIMATE_ACK_REQUIRED (409, with the fresh quote) | في طلبك منتجات بسعر تقديري. راجع الملاحظة وأكّد أنك تفهم أن السعر قد يتغيّر، ثم أعد المحاولة. | Your order has items at an estimated price. Read the note and confirm that you understand the price may change, then try again. | لە داواکارییەکەتدا بەرهەمی بە نرخی خەمڵێنراو هەیە. تێبینییەکە بخوێنەوە و پشتڕاستی بکەرەوە کە تێدەگەیت نرخەکە لەوانەیە بگۆڕێت، پاشان دووبارە هەوڵ بدەرەوە. |
| PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED (400) | المنتجات بسعر تقديري تُدفع مقدمًا من المحفظة أو نقدًا عند التسليم فقط. | Items at an estimated price can be paid only in advance from the wallet or in cash on delivery. | بەرهەمی بە نرخی خەمڵێنراو تەنها بە پارەدانی پێشوەخت لە جزدانەوە یان پارەدان لە کاتی گەیاندن دەکڕدرێت. |
| PRICE_ESTIMATE_PREORDER_ONLY (409) | هذا المنتج متاح بالطلب المسبق فقط لأن سعره تقديري. | This item is available by pre-order only, because its price is an estimate. | ئەم بەرهەمە تەنها بە پێشداواکاری بەردەستە، چونکە نرخەکەی خەمڵێنراوە. |
| PRICE_ESTIMATE_QUICK_BUY (409) | الشراء السريع غير متاح لمنتج بسعر تقديري؛ أضفه إلى السلة لتراجع الملاحظة. | Quick Buy is not available for an item at an estimated price; add it to the cart to review the note. | کڕینی خێرا بۆ بەرهەمی بە نرخی خەمڵێنراو بەردەست نییە؛ بیخەرە سەبەتەکەتەوە بۆ ئەوەی تێبینییەکە ببینیت. |
| PRICE_ESTIMATE_ORDERING_PAUSED (409) | الطلب بالسعر التقديري متوقف مؤقتًا لهذا المنتج. تواصل معنا لمزيد من المعلومات. | Ordering at the estimated price is paused for this item for now. Contact us for more information. | داواکردن بە نرخی خەمڵێنراو بۆ ئەم بەرهەمە بە شێوەیەکی کاتی ڕاگیراوە. بۆ زانیاریی زیاتر پەیوەندیمان پێوە بکە. |
| PRICE_PROTECTION_ESTIMATE_PENDING (409) | تبدأ حماية السعر لهذا المنتج بعد تأكيد سعره النهائي. | Price protection for this item starts once its final price is confirmed. | پاراستنی نرخ بۆ ئەم بەرهەمە دوای پشتڕاستکردنەوەی نرخی کۆتایی دەست پێدەکات. |
| PRICE_ESTIMATE_UNCONFIRMED (409, staff) | لا يمكن تأكيد هذا الطلب أو تجهيزه أو شحنه قبل تأكيد السعر النهائي لمنتجاته التقديرية. | This order cannot be confirmed, prepared or shipped until the final price of its estimated items is confirmed. | ئەم داواکارییە ناتوانرێت پشتڕاست بکرێتەوە یان ئامادە بکرێت یان بنێردرێت تا نرخی کۆتایی بەرهەمە خەمڵێنراوەکانی پشتڕاست نەکرێتەوە. |
| PRICE_ESTIMATE_REOPEN_REFUSED (409, staff) | لا يُعاد فتح طلب ملغى فيه منتجات بسعر تقديري؛ يضع الزبون طلبًا جديدًا. | A cancelled order with items at an estimated price is not reopened; the customer places a new order. | داواکارییەکی هەڵوەشاوە کە بەرهەمی بە نرخی خەمڵێنراوی تێدایە دووبارە ناکرێتەوە؛ کڕیار داواکارییەکی نوێ دەکات. |
| PRICE_ESTIMATE_OPEN (409, staff) | لهذا الطلب أسعار تقديرية لم تُؤكَّد بعد؛ استخدم «تأكيد السعر النهائي» بدل تعديل السعر العادي. | This order has estimated prices that are not confirmed yet; use “Confirm the final price” instead of an ordinary price change. | ئەم داواکارییە نرخی خەمڵێنراوی پشتڕاستنەکراوەی هەیە؛ لە جیاتی گۆڕینی ئاسایی نرخ، «پشتڕاستکردنەوەی نرخی کۆتایی» بەکاربهێنە. |

The owner-only refusals have ar / en / ckb texts in the same file and are shown only in the admin chunks: `PRICE_ESTIMATES_NOT_INSTALLED` (503), `PRICE_ESTIMATES_DISABLED`, `PRICE_ESTIMATE_POLICY_MISSING`, `PRICE_ESTIMATE_NOT_ELIGIBLE` (with flag codes), `PRICE_ESTIMATE_DEFAULT_MEASURES` (with `waiting_on_apply` when the refresh's apply is the cure, §4.9), `PRICE_ESTIMATE_FLAGS_OPEN`, `PRICE_ESTIMATE_TYPE_RULE` (409, trigger T5) and `PRICE_ESTIMATE_STORE_PAGE_UNREADABLE` (502, §3.6; with `details.reason` `copies_disagree` when the page gives the named variant several prices). `PRICE_ESTIMATES_READ_FAILED` (503) is written for a customer, because the checkout answers it too (§2.4); the courier door answers it to staff. `ESTIMATE_NOTICE_VERSION = 1` is in the same file and is bumped whenever the notice or the acknowledgement text changes.

### 5.6 Old clients

| Client | Outcome |
|---|---|
| A tab or installed app on the previous bundle | Sees the price without the label. It **cannot place an estimate order**: `POST /api/orders` requires `price_estimate_ack === ESTIMATE_NOTICE_VERSION` and answers 409 `PRICE_ESTIMATE_ACK_REQUIRED` with the fresh quote. |
| Quick Buy | Refused in its session. |
| Server messages | Order placed, proposal and confirmation carry the estimate sentences on every client. |

---

## 6. Ordering at an estimated price

### 6.1 What can be bought, and how it is paid

- **Pre-order only.**
  - The apply makes the product pre-order-only on one route.
  - `worker/lib/cartAdd.ts` (`judgeLevonisLine`) refuses a `direct_sale` line on an estimated SKU with `PRICE_ESTIMATE_PREORDER_ONLY`; the batch add door stays identical (`tests/cartBatchParity.test.ts`). Checkout refuses the same again.
  - This matters only if the owner later re-enables direct sale before confirming.
  - A cash-on-delivery pre-order is priced from its route row: `codPricesAsDirect` (`packages/pricing/src/pricing.ts`, line 1118) needs a direct cell or a V2 direct row, and an estimated SKU has neither. Wallet and cash on delivery therefore pay the same D.
- **Payment.** Wallet prepayment or cash on delivery. This is DECISIONS row 90 for pre-orders.
  - `allowedPaymentMethods` and `isPaymentMethodAllowed` (`packages/pricing/src/paymentPolicy.ts`) gain `PaymentMethodOptions.hasEstimate`, which drops `bnpl` and `gini`.
  - A posted `bnpl` / `gini` is refused with `PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED`.
  - The reason: `planPriceAdjustment` refuses financed orders (`PRICE_ADJUST_FINANCED`), so a financed estimate could never be settled.
- **Ordering switch.** When `price_estimate_control.ordering_enabled = 0`, cart add, line update and checkout refuse estimated lines with `PRICE_ESTIMATE_ORDERING_PAUSED`. The product page still shows the estimate, the notice and the contact link. This is the owner's emergency brake.
- **Quick Buy.** `worker/lib/quickBuy/session.ts` refuses estimated SKUs (`PRICE_ESTIMATE_QUICK_BUY`). Its finaliser calls `placeOrder` (`worker/lib/quickBuy/finalize.ts`), which would also refuse for lack of the acknowledgement.
- **Kept as usual.** Coupons, memberships and offers apply as they do today. The owner did not ask to restrict them, and the final-price proposal lets the admin edit the total.

### 6.2 The acknowledgement

`POST /api/orders/quote` returns `estimate: {lines, notice_version}`. `POST /api/orders` requires the body field `price_estimate_ack` to equal `ESTIMATE_NOTICE_VERSION` whenever any line is estimated, else 409 `PRICE_ESTIMATE_ACK_REQUIRED` with the fresh quote. The acknowledged version is stored on every estimate line (`notice_version`).

### 6.3 How the order records the estimate

The new `worker/lib/orderEstimates.ts` provides `estimateCheckoutStatements(db, orderId, lines, noticeVersion)`. The file sits outside `pricingEngine/` because engine files may not name `order_items` (`tests/pricingCurrencyRoles.test.ts`).

In the `placeOrder` batch (`worker/routes/orders.ts`), whenever a line's product row has `price_estimate = 1`:
1. After the order INSERT and **before** the `orderItemInsertStatement` loop: `INSERT INTO ops_guards (id, ok) VALUES ('estimate-checkout:<order id>', 1)`.
2. On each estimated line, `pricing_snapshot.estimate = {v: notice_version}`, which `customerOrderPricing` projects as `price_estimate`.
3. One `INSERT INTO order_price_estimates … SELECT … FROM json_each(?)` with one row per estimated line:
   - `combo_key` comes from the line's selection, computed in code (`skuComboKey`), so a line priced under an offer window is covered too. `engineBasisOf` writes `engine_combo_key` only when the price equals the engine price.
   - `channel` comes from the line's transport.
   - `estimate_unit_iqd` = `benefit.regular_unit_iqd`.
   - Gift lines, mystery spools and bundle components are never estimate lines. Estimated products are excluded from those doors (§8), so no zero-priced gift line can break the `estimate_unit_iqd > 0` CHECK.
4. `DELETE FROM ops_guards WHERE id = 'estimate-checkout:<order id>'`.

Two triggers enforce this:
- T6 refuses any `order_items` row of a labelled product inserted without the token. A labelled line therefore cannot be sold around this record: not by a stale read, an older Worker or another door. A label set between the read and the batch aborts the checkout, and the client retries into the acknowledgement.
- T7 refuses estimate rows outside such a batch.

Existing order data is unchanged:
- The 0181 snapshot (`engine_regular_iqd`, `usd_iqd_at_purchase`) is unchanged.
- The 0190 frozen `estimated_cost_iqd` comes from the V2 result's R through `v2EstimateOf`. It is owner-only and already "estimated" under DECISIONS row 184(9).

### 6.4 The hold: the order waits at «تم الاستلام»

T8 refuses, for an order with any line `open`, `proposed` or `rejected`:
- every status other than `pending` / `cancelled`;
- every stage other than `received` / `cancelled`;
- setting `delivery_remote_id`.

That covers every door that moves an order:

| Door | What happens |
|---|---|
| `moveOrderStage` (`worker/lib/orderStageOps.ts`) | Pre-reads open lines (one indexed statement) and returns `reason: 'PRICE_ESTIMATE_UNCONFIRMED'`. It also maps the trigger's abort, the way it handles `PRICE_APPROVAL_PENDING` / `isPriceHoldAbort` today. `PRICE_ESTIMATE_REOPEN_REFUSED` is mapped like `GIFT_ORDER_REOPEN_REFUSED`. |
| `PATCH /api/admin/orders/:id/stage` and the legacy `PATCH /api/admin/orders/:id` (`worker/routes/admin.ts`) | 409 with the sentence. The legacy door changes `status` first, so T8 refuses that change itself. |
| `POST /api/admin/orders/:id/delivery` (courier booking) | Today it checks only the 0140 hold (`isPriceHeld`, line 3141). It gains the estimate pre-check **before** calling the courier API, and refuses with 503 if the read fails. T8 is the backstop. |
| Telegram confirm (`worker/lib/orderTelegramConfirm.ts`) | Maps the reason to the admin's message. |
| Courier sync | Cannot apply: no shipment can exist. |
| Stage sweep | Never selects these orders. `sweepDueStages` picks only due automatic stages, and `confirmed` is a manual stage (`STAGE_SOURCE.confirmed = 'manual'`, `worker/lib/orderStages.ts`), so a `received` order has no clock. This removes the starvation the judges found under `LIMIT 200`. |

**The customer can always leave.** The order stays `pending`, so the existing `POST /api/orders/:id/cancel` (`status === 'pending'`, `orders.ts` line 5992) keeps working. Its existing batch refunds the wallet and points (`cancelledOrderRefundStatements`) and voids a pending proposal (`voidPendingPriceAdjustmentStatement`). T10 voids the lines.

**Expiry sweep.** `orderExpirySweep.ts` would otherwise cancel an untouched cash-on-delivery order at `pending` / `received`. Its `CANDIDATES` statement gains `AND NOT EXISTS (SELECT 1 FROM order_price_estimates e WHERE e.order_id = o.id AND e.state IN ('open','proposed','rejected'))`, with the absent-table retry (§2.4).

### 6.5 The owner confirms the final price

The endpoints are added to the existing `adminOrderPriceRoutes` (`worker/routes/orderPriceAdjust.ts`, mounted at `/api/admin/orders`) and classified in `tests/routeClass/money.ts`.

**`GET /:id/price-estimate`** (class `op`; any admin may read). Per line it returns:
- name and qty;
- `estimate_unit_iqd`;
- the SKU × channel's **current published price**, a final price, never a cost;
- the state;
- only on a line bought under an offer: `offer_before_unit_iqd` (the frozen pre-offer regular, `order_items.pricing_snapshot.offer_before_iqd`) and `offer_today_unit_iqd` (the same offer on today's published price). Such a line's estimate is the offer price, so the panel compares today's price with `offer_before_unit_iqd`, says in ar / en / ckb that the line was bought under an offer, and its button, «استخدم سعر اليوم بنفس العرض» / 'Use today’s price under the same offer' / «نرخی ئەمڕۆ بە هەمان ئۆفەر بەکاربهێنە» (a plain line keeps «استخدم سعر اليوم» / 'Use today’s price' / «نرخی ئەمڕۆ بەکاربهێنە»), proposes `offer_today_unit_iqd`; the button is hidden while today's price equals `offer_before_unit_iqd`. `offer_today_unit_iqd` re-applies a frozen `discount_percent` with the offer's clamp (1–90) and rounding (up), trusted only when it gives back the estimate from `offer_before`. If the offer would no longer lower today's price, it is today's price. Otherwise (an amount off, `fixed_usd` or `fixed`, or unreadable terms) it is estimate + (current − offer_before), rounded up on the rule and capped at current. It is null without a price today or when the result is not a valid final. A line without an offer reads exactly as before. `POST /:id/price-estimate/confirm` answers its `lines` in the same view but reads no price today: `current_unit_iqd` is null, `offer_before_unit_iqd` stays, and `offer_today_unit_iqd` is left out, so only this read carries it.

**`POST /:id/price-estimate/confirm`** (class `money`, `requireFinancialScope`) takes `{idempotency_key, lines:[{order_item_id, final_unit_iqd}], new_total_iqd?, note?}`:
- It must name **every** line in `open` or `rejected` state.
- Each `final_unit_iqd` must be on the rounding rule (`isOnPriceRule`).
- It refuses while a proposal is pending (`PRICE_APPROVAL_PENDING`).

| Case | What happens |
|---|---|
| Every final equals its estimate (this includes **honouring** the estimate after a rejection) | One batch: the lines become `confirmed` (fenced on `state IN ('open','rejected')`), with the audit row and the in-app confirmedNoChange notice. No money moves, and the gate opens. |
| Some lines differ and Σ (final − estimate) × qty = 0, with no edited total | The same batch, with each line `confirmed` at its own final price. The notice is confirmedTotalUnchanged (§5.5): one row per moved line, «name — option × qty: estimate ← final» («→» and IQD in English), in `body_ar`, `body_en` and `meta.body_ckb`, bounded to 1,000 characters. The same notice goes out when a line moved and the financial admin keeps the total by hand (`new_total_iqd` = the current total). |
| Some lines differ and the total changes | `proposePriceAdjustment` is called, with `newTotalIqd = new_total_iqd ?? total_iqd + Σ (final − estimate) × qty`. The financial admin may edit the total, because coupons and percentage discounts are not re-derived; today's 0140 rule is that "the admin's figure is the final total". The call also passes `reasonCode: 'ESTIMATE_FINAL_PRICE'`, the stored trilingual `reason`, a per-line old → new `note`, and `extra` statements laid in the proposal's own batch: lines that equal their estimate become `confirmed`; lines that differ become `proposed` with `final_unit_iqd` and `adjustment_id = proposalId(order, admin, key)`, the deterministic 0140 id; and a fence that no line is left `open` / `rejected`. |

**After the customer decides** (on the web, in Telegram, or by cancelling), T11 moves the lines:

| Decision | Lines become | Gate |
|---|---|---|
| Approved | `approved` | Opens once no other line is unsettled |
| Rejected | `rejected` | Stays closed. The admin honours the estimate, proposes again or cancels, and the customer may cancel. |
| Withdrawn by an admin | `open` again | Stays closed |
| Customer cancel | `void` | n/a |

### 6.6 The 0140 flow as it works today (read in `worker/lib/orderPriceAdjust.ts`, `worker/routes/orderPriceAdjust.ts`, `packages/pricing/src/priceAdjustment.ts`, `migrations/0140`)

**Propose.** `POST /api/admin/orders/:id/price-adjustment`, under `requireFinancialScope`.
- **Id.** Deterministic: `padj_` plus 24 hex characters of sha256(`order:admin:key`). A replay returns the stored row; a different body on the same key is `IDEMPOTENCY_KEY_REUSED`.
- **`priceAdjustBlocker`** refuses:
  - a merchant order;
  - an order already held;
  - a status outside `pending` / `confirmed` / `processing`;
  - a stage of `out_for_delivery`, `delivered` or `cancelled`;
  - a booked courier.
- **`planPriceAdjustment`** refuses financed orders and an unchanged total. A higher total grows only the door amount, and the wallet is never debited again. A lower total shrinks the door amount first and then refunds the wallet part. A cut it cannot source is refused.
- **One batch:** the proposal row; `orders.price_hold_id`, fenced on status, stage, total, due amount, wallet and no courier; a NULL-state fence; an in-app notice (ar / en, with ckb in `meta`); the audit.
- **After the response:** email, WhatsApp and Telegram with `pa:y` / `pa:n` buttons, through the outbox on failure.

**While held.** `trg_orders_price_hold_freeze` aborts status and stage moves, and both the stage door and the expiry sweep skip the order.

**Approve.** `decidePriceAdjustment`, from the web or from Telegram after `handlePriceAdjustCallback`; only the order's own customer may approve. One batch with a decision token:
- moves `total_iqd`, `due_on_delivery_iqd`, `wallet_applied_iqd` and cents, and adds the delta to `price_adjustment_iqd`;
- releases the hold;
- writes the idempotent wallet credits `wtx_padj_<id>_<n>`;
- caps the points accrual and adjusts its settlement;
- runs a final fence and writes the audit.

`afterDecision` then revises the invoice and posts to the admin topic.

**Reject, withdraw, void.**
- Reject (`closeWithoutMoney`) releases the hold and nothing else.
- Withdraw is available to any admin.
- The customer's cancel voids the proposal.

**`PriceApprovalCard.tsx` and `PriceAdjustPanel.tsx`** have ar / en only, and their headers say "OWNER: Sorani to be written by hand".

### 6.7 What changes in the 0140 code

**In `worker/lib/orderPriceAdjust.ts`:**
- `ProposeInput` gains `reasonCode?: 'ESTIMATE_FINAL_PRICE'` and `extra?: D1PreparedStatement[]`.
  - The INSERT names `reason_code` only when it is set, which requires 0218.
  - `extra` is laid after the hold's fence, before the in-app notice and the audit, in the same batch.
- A proposal **without** `reasonCode` on an order with unsettled estimate lines is refused with the new code `PRICE_ESTIMATE_OPEN`. It is one indexed read, and an absent table means none. Estimates have one way to settle, and 0140's one-pending index already forbids two proposals.
- `publicAdjustment` adds `reason_code`. For estimate proposals it also adds `lines[{name, qty, estimate_unit_iqd, final_unit_iqd}]`, which are customer prices only.
- When `reason_code` is set, `CUSTOMER_COPY`, `promptText`, the in-app bodies and `outcomeStamp` print the localized estimateReason instead of the free text. The stored `reason` keeps a trilingual sentence, which satisfies the 3–500 CHECK and serves older readers.
- `notifyAdminsOfDecision`: on an estimate rejection it adds «اختر: إبقاء السعر التقديري أو الإلغاء مع الاسترداد».
- **Unchanged:** `decidePriceAdjustment`, `closeWithoutMoney`, `withdrawPriceAdjustment`, `voidPendingPriceAdjustmentStatement`, `planFor` / `planPriceAdjustment` and the hold trigger. T11 carries every decision.

**Elsewhere:**
- `worker/routes/orderPriceAdjust.ts`: the customer GET passes `reason_code` and `lines` through, and the two admin estimate endpoints of §6.5 are added.
- `src/components/orders/PriceApprovalCard.tsx`: a Sorani argument to every `loc`, reusing `CUSTOMER_COPY.ckb`'s words; the estimate variant (per-line old → new rows and the estimateRejectNote).
- `src/components/adminOrders/PriceAdjustPanel.tsx`: Sorani. When the order has unsettled estimate lines, it shows `EstimateConfirmPanel` instead of the free proposal form.

### 6.8 The money outcome: nothing extra is charged without approval

| Payment | Final price higher | Final price lower |
|---|---|---|
| Cash on delivery | Collected only at the door, only after approval | The door amount shrinks after approval |
| Wallet prepaid (charged the acknowledged estimate) | The difference is collected at the door after approval; the wallet is never debited again | Refunded to the wallet on approval |
| Financed | Excluded at checkout | Excluded at checkout |

**Rejected.** The estimate is honoured or the order is cancelled with a full refund, through the existing cancel batch.

**Applying cuts at once without asking** would need a narrow admin-approval path in 0140. It is offered to the owner as row 282(d) and is not built.

### 6.9 Price protection

Owner default 282(h): yes. `worker/lib/protectionClaims.ts` and the claim door in `worker/routes/returns.ts`:
- A claim on a line whose `order_price_estimates` row is not `confirmed` / `approved` is refused with `PRICE_PROTECTION_ESTIMATE_PENDING` (§5.5).
- After settlement, the claim's paid unit price is the line's charged unit plus (`final_unit_iqd − estimate_unit_iqd`). This is the same shift the order total took.
- **One rule for returns, trade-in and protection.** Return refunds, trade-in values and price protection all read one per-line attribution for a line settled at its own final price: `estimateLineAdjustments` in `worker/lib/paidNet.ts`.
  - **Approved lines** each keep their own (final − estimate) × qty. Only the remainder of `orders.price_adjustment_iqd` (an edited total, or a later ordinary 0140 proposal) is spread by net goods.
  - **Confirmed lines** carry their own shift when their finals net to zero (no money moved). When an edited total absorbed them (they do not net to zero), they count for nothing: the lines stay at what was charged, and protection's engine-regular shift is 0.
  - The lines never add up to more goods than `calculateGoods` says the order kept, and no line goes below zero; when a shift cuts below its own line's goods, the kept goods are split exactly by each line's own figure. The refund's cap at the order total also applies to an order whose lines carry their own shifts.
  - An order without counted shifts, and a database without 0218, read exactly as before. Unreadable records make the refund door and every trade-in door that values a unit (eligible list, draft, preview, submit, intake) answer 503 `PRICE_ESTIMATES_READ_FAILED`, like the claim door, and nothing is written; so does the product page's trade-in entry count, whose refusal that page swallows (no entry is drawn). The customer's trade-in screens say it in the reader's language from the pinned copy (§5.5); the desk's intake sheet from the contract, with the desk's own «تعذّر الإجراء.» / 'The action failed.' / «کردارەکە سەرنەکەوت.» as the last fallback. The Worker log line `paid net: estimate records unreadable` carries how many orders were asked for, the first five order ids and the D1 message, never a figure or customer data.
  - The finance report still spreads the settlement by net goods (`tests/financeReportPriceAdjustment.test.ts`), so on an estimate order its per-product revenue split can differ from the per-line refund; the order totals agree.
- The policy text says so (§9 row 280, `price_protection.ts`).

---

## 7. Admin surfaces

Everything with a cost in it is owner-only:
- The routes sit behind `requireCostRead` (§3.4).
- The UI is the lazy `src/components/adminEstimates/` chunk, opened from a card in «التسعير والشحن» (`src/components/adminPricing/AdminPricing.tsx`). `src/pages/Admin.tsx` already mounts that page only when `can_write_cost === true`.
- Every string is in ar / en / ckb. Flag labels live in `src/components/adminEstimates/strings.ts`.

**«التسعير التقديري» workspace (`EstimateWorkspace.tsx`):**

| Tab | Contents and actions |
|---|---|
| Snapshots | Upload a v1 file: hashed in the browser, posted in chunks of 50 items with a progress bar, then completed. Per-source list with counts and age; discard; «مطابقة» runs matching in pages of 25 with progress. |
| Types & switches | `PUT /estimates/types/:key` (version-fenced) edits route (air only where allowed), US reference (EU types), default weight, box or CBM, extra cost in IQD, minimum profit in USD and staleness days. Each edit is audited in `pricing_audit` (`entity 'rule'`, `action 'rule_set'`, `entity_key 'estimate_type:<key>'`, 0181's vocabulary). The tab offers "suggest from catalogue" and warns when T × U < 250 IQD. `POST /estimates/types` creates a new type key. `PUT /estimates/control` (version-fenced; no fresh sign-in since DECISIONS row 285) holds the two switches: **apply** (refused until the purchase policy carries the clause) and **ordering**. |
| Review | Suggested and auto-confirmed matches; the per-SKU mapping grid; lookup by URL, code or name; the one-page store read; manual price entry; the product's type, sourcing and route overrides; bulk accept of `high` and `medium` per product. |
| Ready | Products with no blocking flag: source, supplier amount and currency, R (`est_cost_iqd`), D, the soft flags. Bulk select, then apply in pages under the budget with per-product outcomes. A stale hash shows the fresh preview. |
| Estimated | All labelled products. **Confirm** (whole product, or chosen SKUs) per §4.9, showing the soft flags to accept. The sheet scopes its checks to the options it confirms: for those options it asks the soft flags shown, per SKU, and keeps every code a `PRICE_ESTIMATE_FLAGS_OPEN` refusal named, tied to the options that call sent (a whole-product refusal's codes apply to every option), until it opens on another estimate. The default-measure check is the server's live `confirm_gate` (§4.9 step 1), read when the sheet opens and again after any stale answer; only an older server's answer falls back to the latest lines. The server's refusals stay the backstop, and a refusal whose cure is the refresh's apply says so (§4.9). The sheet states measures real in one step (§4.9 step 0, below). Pause and resume. |
| Flags | Estimated products (not paused) with something to show: default measures, US reference, typed or page price, stale snapshot, item missing, out of stock, owner-edited, large change held. For an estimated or paused product the lists and the product form's banner show the row's flags plus what the latest compute's lines say of their SKUs (`EST_DEFAULT_WEIGHT` / `BOX`, `EST_SNAPSHOT_STALE`, `EST_SOURCE_ITEM_MISSING`, `EST_SUPPLIER_OUT_OF_STOCK`), each with its combo keys, and the row's default measures only where §4.6 says; `GET /estimates/products` and `/products/:id` answer these in `flags`. A held change shows `EST_LARGE_CHANGE_HELD` from the next compute and keeps it until the next compute after the hold ends (the product's next price write ends it: the owner's save, an apply or a later FX-5 run), because information flags are the latest compute's. |
| Refresh | Products whose refresh moves a price, or whose apply takes real measures in with no price moved (below): old → new and %. The 15% / 30% rows need the tick (`gateV2`; no fresh sign-in since DECISIONS row 285). |

**The profit ceiling in the workspace (§4.11, DECISIONS row 291).** Types & switches also edits the type's profit ceiling, «سقف الربح (٪ من التكلفة، 0–100)», next to the minimum profit — offered only when the server's type carries the key (a database without 0222 answers none), sent as text only when changed, 0 accepted (the lowest price each route allows), an emptied one as null, a decimal comma or a figure past the grammar (above 100, three decimals) refused before sending; no warning goes with it, since its planner never prices under a route's floor, and its hint carries words, no figure (the shop's price grid, today's price as the top, the shop's usual dinar prices that cheap items take instead, the safe margin that decides where none under the share keeps it). `EST_CEILING_SHARED` (information) lists a product in Flags when some of its options share their group's dearer profit. In Ready and Refresh one box, «علّم كل التغييرات الكبيرة في هذه الصفحة», ticks the large-change tick of every row of the page an apply may take (`largeChangeIds`); each item still carries its own product's preview hash, so nothing is published unreviewed (DECISIONS row 278 (٤)).

**«التحديث» (Refresh)** lists an estimated product with a current preview (a hash) when a line's price moves, or when the next apply puts real measures in place of a type default, which §4.9 refuses until then (`LIST_WHERE.refresh` in `compute.ts`):
- the type's CBM still decides the product level (§4.6), and some latest line's box is still under it: neither a line on its colour's or model's own package (`colour` or `model`: both of its measures from packages) nor a SKU whose CBM an owner's pricing row above the product level decides;
- or the next apply puts the product's own package in place of the type's default weight or box at the product level, and that measure reaches a latest line on the product's package (no owner's pricing row above the product level decides it for that SKU). That is: the last apply recorded the base measure as the type's default (the weight; the box, or the type's CBM written as `manual_cbm`), the store still holds that value, no owner's value there decides the level before it (a pricing weight before the recorded shipping weight, `weightCell`; a manual CBM before the recorded box, `cbmCell`, LD6), and the package now has the measure (a whole weight; a box of three whole axes, each at most 100,000 mm). The rule reads the record and the store, never how the row's entries are stored (with their options, counted or bare).

An apply that takes nothing in is not offered, the residual below aside: like every apply it deletes the product's firm SKUs (§4.8), so options confirmed since would become estimates again. The apply that takes the measures in leaves none of these conditions, so the product leaves the list until a price moves or more real measures wait. Known residual, erring toward listing: a colour's or model's own package is read only through a line that names it (`colour` or `model`: both of its measures from packages). (A `SOURCE`-origin row is not read either, but no app path writes one: the origin is retired, `docs/PRICING-V2.md` §1.9.) So such a product can still be offered an apply that changes nothing for it (and resets its firm SKUs). Under the package rule this needs a product package measure that arrived after the last apply. Under the type's CBM it needs none: an option whose box is its colour's or model's package and whose weight is the owner's has an `owner` line (a line names the weaker of its two measures), so it keeps the product listed until an apply removes the type's CBM.

In the tab:
- A listed row none of whose lines moves its price says so under its flags (`LISTS.refreshMeasuresOnly`): «لا يتغيّر أي سعر: تطبيق هذا التحديث يضع قياساتك الحقيقية مكان القياسات الافتراضية.» / 'No price changes: applying this refresh puts your real measures in place of the default ones.' / «هیچ نرخێک ناگۆڕێت: جێبەجێکردنی ئەم نوێکردنەوەیە پێوانە ڕاستەقینەکانت دەخاتە شوێنی پێوانە بنەڕەتییەکان.». The tab's intro (`LISTS.refreshIntro`) names both kinds of row.
- Each row also shows where the refresh's lines take their supplier prices (`EST_US_REFERENCE`, `EST_MANUAL_PRICE`, `EST_STORE_PAGE_PRICE`, `EST_UNITS_DIVIDED`), each with its options (`rowFlags`). They sit beside the row's flags, which are the published estimate's and stay, so a code's options are the published estimate's and the refresh's together; each line shows its own source. The other lists show the flags as the server answers them.

**Flags that name fields** say them in the pricing screens' words (`flagFieldNames` over `packages/contracts/src/pricingFieldLabels.ts`), in every list and the Review tab: `EST_STRUCTURE_OWNER {fields: ['shipping_profile']}` reads «… (مسار شحن المخزون)», and `EST_TYPE_INCOMPLETE` and `EST_OWNER_EDITED` name their fields the same way. The estimator's `minimum_profit` reads as `target_profit_iqd`'s whole label, «الحد الأدنى للربح (فوق تكلفة الاستبدال الحالية)» / 'Minimum target profit (above current replacement cost)' / «کەمترین قازانجی مەبەست (لەسەر تێچووی ئێستای جێگرتنەوە)». An unknown name is left out.

**Correcting cost or selling price** (requirement 3):
- **Before apply:** a typed supplier price (manual entry), the product's package fields in the product form, or a type or route override, then compute again.
- **After apply:** the drawer calls `POST /api/admin/pricing/procurement/line-pricing`. `final_cost_usd` corrects the cost, and `customer_price_usd` becomes a minimum profit (cost-first). It saves through the normal `PUT /api/admin/products-v2/:id/pricing` (preview hash, audit, large-change gates).
- The label stays until Confirm. The three-way merge keeps these corrections on every refresh.
- Price editors who are not the owner already get 403 `PRICING_V2_OWNER_ONLY` on cost-first products (`desiredFor`).

**Product form.** `src/components/adminProducts/form/v2/PricesSectionV2.tsx` shows a lazy banner, for example «سعر تقديري — Tmall ‎2026-10-31 · وزن افتراضي».
- The owner gets Review and Confirm buttons. The banner reads the estimate again whenever the form's stored pricing moves (its `inputs_seq:write_seq`), so a pricing save that writes real measures is seen at once.
- Every other admin sees only the state, because `GET /api/admin/products-v2/:id` (`worker/routes/adminProducts.ts`) gains a non-financial `price_estimate: {label, state}`.

**«تأكيد السعر», the sheet** (`ConfirmSheet.tsx`, from the Estimated list and from the banner; DECISIONS row 292):
- **On open**, it reads `GET /estimates/products/:id` (a skeleton meanwhile). It reads it again after a 409 `PRICING_CHANGED` (every compute moves the version), a compute run from the sheet, and a refusal on the measures. The caller's list or banner is told too, so nothing stays stuck until a page reload.
- **A statement on offer** (`confirm_gate.real_measures` covers every option confirmed that a default holds). The sheet shows «القياسات التي يُحسب منها السعر الآن» with the weight in kg and the box `L × W × H` in cm, as the pricing form shows them. The figures are exact (`kgText`, `cmText`: integer scaling, never a float), each an LTR island. It says they are the type's defaults, not the product's.
  - The tick «هذه القياسات صحيحة لهذا المنتج» is bound to exactly those values: a read that shows other values leaves it unticked. The line under it says they are saved in «الأبعاد والوزن», customers see them under «العبوة», and no price changes.
  - «ليست صحيحة؟ أدخل الحقيقية» says to type the real ones in «التكلفة — للمالك فقط» and save. A priced save makes them the owner's, and the live gate then frees the confirmation with no compute. It offers «افتح «التكلفة»» and «افتح «الأبعاد والوزن»».
  - «أكّد السعر» without the tick says `CONFIRM.attestFirst` and sends nothing. With it, the confirmation carries `real_measures` exactly as the gate answered them.
- **Nothing to state.** The sheet says exactly why, with the way to the cure:
  - the type's CBM: `CONFIRM.typeCbm`, with «الأبعاد والوزن», «احسب من جديد» and «التحديث»;
  - a package that differs: `packageDiffers`, with «احسب من جديد» and «التحديث»;
  - a partial package box: `packagePartial`, with «الأبعاد والوزن»;
  - the type's weight lighter than the product's own net weight: `belowNet`, with «التكلفة» (the real packed weight) and «الأبعاد والوزن» (the net weight);
  - real measures waiting on the refresh's apply: `applyFirst`, with «التحديث».
  - A press says the same and sends nothing.
- **The submit is never silently disabled.** It waits only while nothing has been read, with the read's failure said beside it.
- **The ways in.**
  - In the product form they are the form's own: «الأبعاد والوزن» opens section ٤ and focuses its «صندوق الشحن» block (`data-package-measures`); «التكلفة» opens section ٣ and focuses the cost card's weight.
  - In the workspace they are links to the editor (`productDimensionsHref`, section ٤; `productEditorHref`, section ٣). «التحديث» is the workspace's own tab.
- **After a statement**, the sheet hands the product form the values stated, and the form reads the product again in the background (`afterEstimateMeasures`; never the spinner, which unmounts the form, and never the load-failure page that has only «رجوع»):
  - The read becomes the baseline, with the new package and the moved `updated_at`. Every edit the admin had not saved is laid back on top (`keepEdits`, `src/components/adminProducts/types.ts`), «المواصفات والمحتوى الإضافي» included since nothing else wrote it. `dimensions` holds the product's own size and its package in one object, so it is merged field by field: an unsaved net weight never lays the old, empty package back over the new one, and only a package field the admin typed himself keeps his value. The next save therefore neither meets `STALE_EDIT` nor writes the empty package back.
  - A read that fails leaves the form on screen with the admin's edits. The stated package is laid in where the form's own is empty (`withStatedPackage`, as the server wrote it), and the form says so (`measuresUnread`). The next save then meets `STALE_EDIT` (the package write moved the version; a package that already held the values is not written), and even «احفظ تغييراتي فوقها» writes the package back as the server holds it.
  - A read overtaken by a save or another load is dropped (the form's baseline generation).
- Done, it says `CONFIRM.doneAttested` / `doneAttestedSkus` (with a statement) or `doneWhole` / `doneSkus`.

**Orders:**
- `src/components/adminOrders/EstimateConfirmPanel.tsx`, in `OrderDetailModal.tsx`, shows per line the estimate, the current price and a final-price input, with «تأكيد السعر كما هو» and «إرسال السعر النهائي للزبون». It shows customer prices only, so any admin may view it; only a financial-scope admin may act.
- The orders board (`OrdersBoard.tsx`, served by `worker/routes/admin.ts`) gains the filter «بانتظار تأكيد السعر», which is absence-tolerant.
- `OrderBoardBadges.tsx` gains a badge.
- The admin new-order message (`orderAnnouncement`, `worker/lib/adminTopicRouting.ts`) adds «⚠️ يتضمن أسعارًا تقديرية — أكّد السعر النهائي قبل الطلب من المورّد».

---

## 8. File by file: completeness, SELLABLE, price_status, purchase doors, quote and cart

**Completeness, SELLABLE and price_status**

| File | Change | Why |
|---|---|---|
| `packages/contracts/src/productCompleteness.ts`, `worker/lib/productCompleteness.ts` | **None** | An estimated product is an engine product. `COST` is met by the resolved supplier cost, `ENGINE_INPUTS` by its own `target_profit` rule, and `PACKAGE_WEIGHT` / `PACKAGE_BOX` by the engine-mode resolved weight and CBM (lines 323–334), so type-default measures keep it sellable, as owner decision D2 requires. The default is tracked by `EST_DEFAULT_*` and enforced by T2, not by a completeness code, because every code other than IMAGE and CATEGORY blocks sale. |
| `worker/lib/listing.ts` | **None** | SELLABLE = active, not held and V2-published (`sellableSql` / `v2Clause`), byte for byte. `tests/listingPredicateGuard.test.ts` is untouched. |
| `worker/lib/commercialState.ts` | `skuEstimated`, `productEstimated` | `PriceStatus` stays binary |
| `src/lib/priceStatus.ts` | `isEstimated(p)`, `ESTIMATE_TEXT`, `ESTIMATE_SHORT` | Eager and tiny |
| `worker/lib/productModel.ts` | `parseProductRow` sets `price_estimate: true` when the column is 1; `ProductDoc.price_estimate?: true`, `sku_firm?: string[]` | Absent otherwise, so docs of other products are unchanged |
| `worker/lib/productOverlay.ts` | The firm arm, the parse of marker 3, `ProductRelationsView.sku_firm`, the fallback tier | §5.2 |
| `worker/lib/customerPricing.ts` | `CustomerLinePrice.price_estimate?: true`; `customerOrderPricing` projects `estimate` | Not arithmetic |
| `worker/lib/edgePolicy.ts` | `PUBLIC_PROJECTION_REVISION = 'price-estimate-2026-11'` | §5.3 |
| `worker/lib/priceEstimateLabel.ts` (new, leaf) | `isEstimateRow`, `estimateClause(alias)`, `withoutEstimateClause(sql)`, `isMissingEstimateSchema(e)`, `estimateAbsentLately(db)` | §2.4 |
| `worker/lib/priceEstimateGate.ts` (new, leaf, no imports) | `isEstimateGateAbort`, `isEstimateReopenAbort`, `hasOpenEstimates(db, orderId)`, `PRICE_ESTIMATE_UNCONFIRMED_MESSAGE` | Same shape as `priceHold.ts` |

**Quote, cart and checkout**

| File | Change |
|---|---|
| `worker/routes/products.ts` | `CARD_FIELDS += 'price_estimate'`. The priced card and the detail set it. The quote sets it per selection. |
| `worker/lib/cartAdd.ts` | Refuses a direct-sale line on an estimated SKU, and refuses estimated lines while ordering is paused |
| `worker/routes/cart.ts` | Line `price_estimate`, cart `has_estimates`. Line update refuses as add does. |
| `worker/routes/orders.ts` | `computeCheckout`: `hasEstimate` payment options and the quote's `estimate` block. `placeOrder`: the acknowledgement, the ordering switch, `estimateCheckoutStatements`. Order read: `items[].price_estimate.state`. The cancel route is unchanged. |
| `packages/pricing/src/paymentPolicy.ts` | `hasEstimate` |

**Other purchase doors** (the DECISIONS row 240 inventory). Estimated products are SELLABLE, so each door that freezes or derives a value from a price excludes them explicitly. A row check in code is used where the door reads `SELECT *`; a SQL clause with the absence retry is used elsewhere.

| File | Change |
|---|---|
| `worker/lib/quickBuy/session.ts` | Refuses estimated SKUs |
| `worker/lib/gifts/selection.ts` | Excludes labelled products. Gifts may be pre-order, and a gift of an estimate would carry a price nobody confirmed. |
| `worker/lib/bundleComposition.ts`, `worker/lib/mysteryDraw.ts` | Exclude labelled members and entries. Both accept pre-order members. |
| `worker/lib/tradeInTargets.ts` | Excludes labelled targets. Targets are already priced as `direct_sale`, so this is defence in depth. |
| `worker/lib/printQuote/repository.ts` | `loadMaterialPrices` skips labelled products |
| `worker/lib/priceRequests.ts` | The sweep uses the priceRequest.title wording when the product is labelled |
| `worker/lib/creative/store.ts` | `priceOfCard`: estimate means unpriced for creatives |
| `worker/lib/publicApi/common.ts`, `resources/products.ts` | `price.estimate` |

**Order side**

| File | Change |
|---|---|
| `worker/lib/orderEstimates.ts` (new) | Checkout statements, the confirm/propose orchestration (§6.5), `openEstimateLines` |
| `worker/lib/orderStageOps.ts` | The pre-check, and the reasons `PRICE_ESTIMATE_UNCONFIRMED` / `PRICE_ESTIMATE_REOPEN_REFUSED` |
| `worker/routes/admin.ts` | Maps the reasons on the stage and status doors; the courier-door pre-check; the board filter |
| `worker/lib/orderTelegramConfirm.ts` | Maps the reason |
| `worker/lib/orderPriceAdjust.ts`, `worker/routes/orderPriceAdjust.ts` | §6.7 |
| `worker/lib/orderNotify.ts`, `worker/lib/adminTopicRouting.ts` | The orderPlaced sentence and the admin warning |
| `worker/lib/orderExpirySweep.ts` | The exclusion |
| `worker/lib/protectionClaims.ts`, `worker/routes/returns.ts` | §6.9 |

**Engine**

| File | Change |
|---|---|
| `worker/lib/pricingEngine/v2/write.ts` | One additive option, `estimate?: readonly D1PreparedStatement[]`, laid after step 9b. Nothing else in the engine changes. |
| `worker/lib/importStock.ts` | New export `untrackedDecisionStatements` (the statement form of `decideImportStock('untracked')`) |

**Privacy**

| File | Change |
|---|---|
| `worker/lib/adminScope.ts` and `packages/platform-kit/src/scope.ts` (both copies of `FINANCIAL_FIELDS`; `tests/edgeParity.test.ts`) | Add the new owner-only key names (list below) |

Keys added to `FINANCIAL_FIELDS`: `supplier_price`, `supplier_prices`, `supplier_price_amount`, `supplier_price_currency`, `supplier_item_key`, `supplier_sku_key`, `supplier_url`, `supplier_title`, `catalogue_price`, `price_cny`, `price_eur`, `price_usd_reference`, `price_label`, `snapshot_price_basis`, `units_per_offer`, `match_confidence`, `match_method`, `match_reasons`, `estimate_flags`, `measure_basis`, `measure_source`, `est_cost_iqd`, `est_price_iqd`, `default_weight_g`, `default_length_mm`, `default_width_mm`, `default_height_mm`, `default_cbm`, `min_profit_usd`, `applied_wire_json`, `type_source`.

Migration 0222 (the profit ceiling, §4.11, DECISIONS row 291) adds `profit_cap_pct` to both copies (`tests/edgeParity.test.ts`).

Kept public: `price_estimate`, `estimate_unit_iqd`, `final_unit_iqd` and `notice_version`, because they are customer prices and facts.

---

## 9. Owner DECISIONS rows to add

The next row is 278. Each row is written Arabic first with an English summary, as the register is.

| Row | Title | Content | Amends |
|---|---|---|---|
| **278** | «التسعير التقديري لمنتجات Bambu Lab» (Bambu Lab estimated pricing) | Records the owner's four answers of 2026-10-31. An estimate is an ordinary V2 cost-first price, written by the V2 writer in one batch with the pre-order structure, the `untracked` stock decision and the product label `products.price_estimate`. The label is cleared only by the owner's confirmation and never while a default measure prices a SKU. A private supplier catalogue (Tmall CNY, EU EUR, US USD reference, typed or one store page) feeds prices only through the owner's reviewed apply. Each product in a bulk apply is bound to its own reviewed preview hash. Apply is switched on by the owner only after the purchase policy carries the clause. | **239**: the import still writes no price, cost or stock and keeps no sync; the separate, owner-reviewed catalogue is the supplier-price source; import-guard triggers protect the new tables. **240**: an estimated product is sellable (pre-order, labelled); price requesters are told with the estimate wording. **184(3) / 221**: the per-type USD minimum profit reaches products as product rules; no percentage, no category or global rule. **222 / spec addendum A.8** ("no bulk publish — every product is opened, reviewed in the one sheet and published", as quoted in `worker/lib/pricingEngine/v2/queue.ts`): the estimate apply is a reviewed bulk publish, product by product, each bound to its own preview hash. |
| **279** | «المصدر والشحن حسب النوع، والمقاسات الافتراضية» (Sourcing and freight by type; default measures) | Printers, AMS, laser machines and electronic devices and parts: EU store in EUR, by land (`GERMANY_LAND`, per kg); US USD reference allowed per type and flagged; typed entry. Filament and filament packs: Tmall in CNY, sea only (`CHINA_SEA`, per CBM; enforced by CHECK). Other China items: sea by default, air where the owner allows it, one route per product, so no route spread is published (row 220 (a) does not grow). Missing weight or box: the type's default, written only to private pricing inputs, flagged, still sold as an estimate, and the label stays until real measures exist. A product needs a price for every sellable SKU; nothing is inferred from a sibling. | **247** (measure precedence unchanged; the default sits below model, colour and product measures) |
| **280** | «الطلب بسعر تقديري» (Ordering at an estimated price) | Pre-order only. Wallet or cash on delivery; BNPL and Gini are not offered. An acknowledgement bound to the notice version is required. Every estimated line is recorded at checkout, which the database enforces. The order stays at «تم الاستلام» (no confirm, preparation, shipping, courier booking or reopening) until every line is settled, and the customer may cancel until then. Equal price: confirmed. Different price: a 0140 proposal with `reason_code ESTIMATE_FINAL_PRICE`. Rejection: honour the estimate or cancel with a full refund. Price protection starts at settlement. Purchase policy v7 (§ on estimated prices), price protection policy and the FAQ say so. | **90**: payment methods for estimate lines. **149**: estimate reason code, Sorani for the approval card and panel. **221 §7 default 1**: for estimate lines the price is fixed at settlement, not at placement. **191 / 223**: price-protection timing. |
| **281** | «ما يُقال للزبون والخصوصية» (What the customer is told; privacy) | `price_status` stays binary; a `price_estimate` boolean is added, with the label, notice, checkout, order and support texts of §5.5. "Contact us" opens the support assistant's estimate answer and a prefilled ticket. Provenance (source, supplier price, flags, type, measures) is owner-only. **Acknowledged, not solved:** Bambu's supplier list prices are public, so across many estimated products of one type, public supplier prices, public package dimensions, public FX and the published estimates let anyone fit the private freight rate and the per-type profit by regression. This generalises row 220 (a) across products. It is pinned as a `todo` audit test until the owner rules on 282(e). | **225** (one more non-arithmetic customer key), **220** (provenance under `FINANCIAL_FIELDS`; spread rule kept) |
| **282** | «أسئلة مفتوحة والافتراضات المطبّقة حتى الإجابة» (Open questions and the defaults applied until answered) | **(a)** EU prices gross or net of VAT? Default: as listed, recorded in `price_basis`, never converted; correct with typed prices or extra cost. **(b)** Apply catalogue refreshes under 15% automatically? Default: no. **(c)** Air for China types? Default: sea, the owner switches per type or product. **(d)** Apply price cuts at once without the customer's approval (needs an admin-approval path in 0140)? Default: no, the customer approves every difference. **(e)** The regression leak of 281: accept, hide package dimensions on estimated products, or round estimates more coarsely? Default: accept, with the audit pinned. **(f)** Percentage expenses (customs as % of value)? The engine has a flat IQD extra only; default: flat per type. **(g)** Keep supplier price files out of git? Default: yes. **(h)** Estimated products in gifts, bundles, mystery boxes, trade-in targets and print materials; price protection waits for settlement? Default: excluded; yes. **(i)** Per-type lead times written to routes? Default: not in phase 1 (lead times stay in the product form). **(j)** May US-reference prices be applied in bulk? Default: yes, flagged; label removal needs explicit acceptance. **(k)** Native Sorani review of §5.5? Recommended. | n/a |
| **291** (2026-11-05) | «سقف الربح وأسعار الدولار المقرَّبة في الأسعار التقديرية» (Profit ceiling and dollar charm prices on estimated prices) | The owner's «re calculator of price f all  سعر تقديري to products because they are become very expensive», then «dont make 25% on all product … priced from 0% to 25% or 30 or 35 or even 50 and 100», «we want cheap price so we need to become cheapest iraqi supplier», «still nor cheapest enough . more cheaper» (ceilings of 3–10% per type) and «make the price for product be like that 9.99$ , 19.99$ 24.99$ and ect …», U = 1,600 his real cost. Per type a profit ceiling P, 0–100% of cost (`profit_cap_pct`, migration 0222; empty is today's rule; no seed). Per SKU, from $5 up (`CHARM_MIN_USD`), the highest dollar charm price whose dinar price is at or under the lower of today's price and R × (1 + P/100) and whose profit keeps one rounding step over R (one dinar at or under 1,000 IQD, so FX-5 can follow any rise), else the lowest whose margin holds; under $5 (a ceiling below the dinar price of $5.49) the highest house price — 250 IQD steps, whole dinars at or under 1,000 — under the same ceiling with the same margin, else the lowest that keeps it, its dollar display its own figure — never above today's while that clears rp(R); a charm price at today's own dinar price shows c there (T only where today's own figure already is c, or for a house price; the new profits only on a product of at most 19 SKUs, both the new plan and today's exact within the wire; between applies FX-5 can then sell such a SKU one step from T's own price, until the next compute and apply); T_sku = floor6(c − R ÷ U − Δ) or floor6((D − R) ÷ U − Δ), the owner's positive differences Δ on top, his fixed dollar prices at T. Between a ceiling of $5 × U and $5.49's dinar price the plain rule too, its dollar figure off the grid ($5.00–$5.79 at 1,600; 9,000–9,250 IQD where only the margin's lowest fits, 9,500–9,750 at 1,690). Written as fixed USD rules at the least specific exact scope (or, past the wire's 60 rows, one profit per group — the dearest, under $5 the cheapest that keeps every margin; `EST_CEILING_SHARED` names the SKUs above their own, never blocking), recorded in `applied_wire_json`; owner-written rules always win (an owner product rule takes the ceiling's own scope rules back to inherit); confirmed and paused products untouched; firm SKUs reset by any apply, so the live run skips them (§4.11). | **278**: D3 and its "184 (٣) and 221" clause, for estimated products only. **184 (٣)**: its policy wording, for estimated products only; its engine side is unchanged (fixed USD rules, D − R ≥ T, FX moves prices, never profits). |

---

## 10. Tests to add and existing tests that must change

Each file belongs to exactly one work package (§12). "Stays green" means the test runs unchanged and must pass.

### New tests

| Test file | What it proves | WP |
|---|---|---|
| `tests/migration0218PriceEstimates.test.ts` | **Migration:** `migrate-check --twice`; every CHECK (source↔currency, filament sea-only, EU land-only, `units_per_offer` owner-only, `confirmed` ⇒ `measure_basis 'real'`). **Label triggers:** T1 refuses without `engine-price:`; T2 refuses without confirmed + real; T3 refuses a labelled insert; T4. **Checkout triggers:** T6 refuses a labelled `order_items` row without `estimate-checkout:` and lets it through with it; T7. **Gate:** T8 blocks status `confirmed` / `processing` / `shipped`, stage `confirmed` / `supplier_preparing`, and courier booking; it allows cancel and the `pending` → `pending` updates. **Other triggers:** T9 reopen (a NULL status fence is no reopening: NOT NULL answers; a NULL fence also passes T8 and T11 to NOT NULL); T10 cancel → void; T11 approve / reject / withdraw / void; the 0140 fences do not fire T11. **Import guards:** all 36 (twelve tables × insert, update, delete) refuse inside `ops_guards('catalog-import-batch')`. | 1 |
| `tests/estimateStrings.test.ts` | Every key and refusal in `priceEstimates.ts` has ar, en and ckb; no ckb equals the ar | 1 |
| `tests/supplierPriceFormat.test.ts` | The parser: unknown keys refused, floats refused, decimal text kept, source↔currency, caps, duplicates | 2 |
| `tests/supplierPriceMatch.test.ts` | **Fixtures:** real records from `data/bambu-cn-prices/batches` and real manifest rows, copied into `tests/fixtures/supplierPrices/`. **Matching:** colour code, part code (with `B-`), SKU code, variant id and handle; spool / refill and nozzle dictionaries; pack mismatch refused; ambiguity leaves both sides unmapped; the confidence levels; ids carried across captures; a Tmall listing without options (one SKU keyed by its item id); `packOf`: rolls by colour add up, the parts of one set (`膜*2+弹簧钢板*1`) do not. | 2 |
| `tests/supplierPriceClassify.test.ts` | Precedence: owner > Tmall category > import type (+ pack subtype, the electronics rule) > missing; ™ and ® dropped in the capture's order | 2 |
| `tests/estimateInputs.test.ts` | Compaction (base, one-group option absolutes, colour, SKU) reproduced exactly by `resolveSkuInputs`; mixed currencies go to SKU scope; the 61-entry cap; measure precedence; defaults never reach `products.package_*`; `manual_cbm` only without a box; the three-way merge | 3 |
| `tests/supplierPriceCaptureScripts.test.ts` | The Tmall normaliser (`price_title` becomes `price_label`, never a price) and the store JSON-LD reader on stored pages; under `--store eu`, a redirected page is listed as redirected and a USD page is refused; no network (a stubbed fetch) | 4 |
| `tests/supplierPricesRoutes.test.ts` | The door (owner only, the same 403 bytes), chunked upload, completion / supersede, discard, manual entry, lookup, version fences | 5 |
| `tests/supplierPricesMatcher.test.ts` | Paged matching writes suggestions and automatic confirmations; prunes vanished combo keys; flags missing items; a Tmall listing without options is suggested, confirmed and priced like any other, and a part in two colours pairs nothing with it | 5 |
| `tests/supplierPricesStorePage.test.ts` | `read-store-page` with a stubbed fetch: host allow-list on every hop; the stored currency is the page's own; a redirect to the US store is stored as USD; a sale page saves the regular price; a variant repeated across JSON-LD nodes is one offer, or saves nothing when its copies disagree (502 `copies_disagree` with `?id=`, 400 without); within one node offers are only deduplicated | 5 |
| `tests/priceEstimateCompute.test.ts` | Preview rows, flags and hash; no V2 table written; blocking flags; eligibility (§4.7); an estimated row's flags after a refresh (whole, counted or none; never cut); what the lists read of the store: the Flags tab as `shownFlags` shows, «التحديث» by its rule (§7), counted or bare entries included | 6 |
| `tests/priceEstimateApply.test.ts` | **One batch:** pre-order structure with one route; `untracked` before `importStockFence`; inputs, rule and prices; label and bookkeeping. **Refusals:** a stale hash answers with the fresh preview; never-on-published; a stocked, celled or merged product is never restructured; an incomplete product is refused. **The label:** it exists in the same commit as the first price, so there is no unlabelled window. | 6 |
| `tests/priceEstimateConfirm.test.ts` | Default measures refuse; soft flags need `accept_flags`; whole-product clear; firm SKUs; re-apply clears firm SKUs | 6 |
| `tests/priceEstimateFx5.test.ts` | A CNY / EUR / U / freight move reprices through `autoReprice` and keeps the label; a large change is held and flagged | 6 |
| `tests/priceEstimateBudget.test.ts` | A page of applies stops before 900 statements and returns a cursor (`countingD1`) | 6 |
| `tests/priceEstimateCustomerSurfaces.test.ts` | **Where the label appears:** card, detail, quote, cart, checkout, order read, public API and Creative Studio carry it or honour it; a firm SKU of a mixed product carries none; a failed firm read labels every SKU of a labelled product and no other product; a new SKU priced through the form after apply is labelled. **What never appears:** no supplier or catalogue key in any customer or staff payload (the `tests/fixtures/costlyProduct.ts` scanner). | 7 |
| `tests/priceEstimateDeployAhead.test.ts` | On a database without 0218, every reader answers as today | 7 |
| `tests/priceEstimateRouteSpread.test.ts` | An estimated product publishes exactly one route | 7 |
| `tests/leakAudit_customer-api_estimate_supplier_regression.test.ts` | `todo` pin of row 281's cross-product regression, modelled on the route-spread audit | 7 |
| `tests/priceEstimateDoors.test.ts` | **Refused:** a direct-sale line, Quick Buy, ordering while paused. **Excluded:** gifts, bundles, mystery boxes, trade-in targets and print materials exclude labelled products. **Price requests:** the sweep uses the estimate wording. | 8 |
| `tests/priceEstimateCheckout.test.ts` | **Acknowledgement:** a missing or old one is refused with the fresh quote. **Payment:** BNPL and Gini refused; wallet and cash on delivery allowed and priced the same. **Recording:** guard token, rows and snapshot in the order batch; a gift line never recorded; T6 catches a stale read. | 9 |
| `tests/orderEstimateGate.test.ts` | Every door: stage, the legacy status door, courier (pre-check before the API stub), Telegram; the stage sweep never selects; the expiry sweep skips; the customer can cancel | 9 |
| `tests/orderEstimates.test.ts` | **Confirm:** equal confirms; equal-total confirms; a different price proposes with `reason_code` and lines move to `proposed`. **Decisions:** approve moves the money exactly as 0140 and opens the gate; reject keeps it closed, and honour or cancel follows; withdraw reopens; customer cancel voids. **Blocker:** a plain proposal is refused (`PRICE_ESTIMATE_OPEN`). | 9 |
| `tests/priceEstimateProtection.test.ts` | Claims refused until settled; the settled baseline | 9 |
| `tests/estimateStorefrontUi.test.ts` | `EstimateNotice` is lazy; UI strings come from the contract; the eager copies in `priceStatus.ts` equal the contract; Quick Buy hidden for an estimated selection; the support `ask` allow-list; in «عدة ألوان» the notice follows the panel's total | 10 |
| `tests/estimateOrderUi.test.ts` | Checkout checkbox and button; order banner and states; three languages | 11 |
| `tests/estimateAdminUi.test.ts` | The workspace is lazy, owner-mounted and in three languages; every call goes to `/api/admin/pricing`; a flag's field names in the pricing screens' words; the apply-first words of §4.9; «التحديث»'s price sources and its no-price-moves note | 12 |
| `tests/estimateAdminOrdersUi.test.ts` | The confirm panel: three languages, customer prices only, actions only with financial scope | 13 |
| `tests/migration0218Fences.test.ts` | Every `<column> = CASE … THEN <column> ELSE NULL END` fence in `worker/` on a table a 0218 trigger watches (today `orders.status`, `address_snapshot`, `coupon_code`, `delivery_method_snapshot` and `order_price_adjustments.state`), run on every row of a world with estimate orders in every state: the lost branch fails on NOT NULL, and the held branch changes no estimate line | review |
| `tests/priceEstimateVariantGrid.test.ts`, `tests/priceEstimateVariantGridLive.test.ts` | A combination with no variant row is not a SKU when each of its choices is stocked elsewhere (the Bus Cable: 3 real variants of a 6-cell grid match `high` and estimate without `EST_NO_PRICE`; the H2D sample is no longer AMBIGUOUS); a choice no stocked combination holds keeps its cells; every census shape answers as before; a published product keeps its rows until its next write | review |
| `tests/priceEstimateConfirmScope.test.ts`, `tests/priceEstimateConfirmScopeRefresh.test.ts` | The confirm sheet's per-option asks equal the server's 409 / 200 answers, after an apply and after a refresh | review |
| `tests/priceEstimateReturns.test.ts`, `…ReturnsRule`, `…ReturnsTradeIn`, `…ReturnsFlow` | One per-line attribution for refunds, trade-in and protection: approved, cancel-out, absorbed, past-its-goods and unreadable cases, through the real doors; orders without estimates and a database without 0218 as before | review |
| `tests/orderEstimateOffer.test.ts` | A line bought under an offer: «استخدم سعر اليوم بنفس العرض» proposes the same offer on today's price and never takes the saving back; the confirm answer leaves `offer_today_unit_iqd` out | review |
| `tests/supplierPriceSaleRule.test.ts` | The regular-price rule of the browser snapshot, the capture script and the one-page read, held to one table; a unit price (`referenceQuantity`) is never the regular price; the save message names the sale price only for the saved variant | review |
| `tests/estimateColourPanel.test.ts` | «عدة ألوان»: the total and each estimated colour's price are labelled in ar / en / ckb; nothing changes for non-estimate products; a row's answered quote is its row (`rowQuoteOf`); a colour the product does not sell with the shared selection shows the chooser's words, no figure and no quantity | review |
| `tests/supplierPriceTmallSinglePrice.test.ts` | A Tmall listing without options is one SKU keyed by its item id at the page price, its link is the item page, and a listing that is not an offer is dropped with the reason | review |
| `tests/priceEstimateVariantGridLarge.test.ts` | Past `ENGINE_MAX_SKUS` a `VARIANT_COMBINATION` grid is counted on the cells it keeps, round 1's rule over the whole grid: a 264-cell kit with 22 variants answers the 22 in grid order and is matched `high`, estimated and applied on them; 130 colours × spool / refill answer the 130 stocked; another mode, no active row, rows naming no cell, or a kept set still past 240 overflow as before; the scan stops at `SKU_GRID_SCAN_MAX` | review |
| `tests/priceEstimateStorefrontUnoffered.test.ts` | A combination the product does not sell (`unofferedSkuKeys`, §5.3): a partly priced product's quote answers it on its ordinary path (`VARIANT_NOT_MODELLED`), never 'unpriced', while its unpriced SKU still answers 'unpriced'; a catalog-only quote keeps its 409, names it, and the page body lists it; a full grid carries no list; `selectionUnoffered` is never a part of a sold SKU nor a grid without relations past the limit; the page asks no quote and shows no figure and no «طلب السعر», only the chooser's words; the page never prints a code | review |
| `tests/priceEstimateStorefrontOffered.test.ts` | Past `ENGINE_MAX_SKUS` the page body lists the SKUs the product sells (`offered_selections`), and a selection part of none is exactly one «طلب السعر» refuses; no other body carries the list; the page and its colour rows read it by one rule | review |
| `tests/priceEstimateStorefrontRowQuote.test.ts` | «عدة ألوان»'s row quote (`rowQuoteOf`) on the real quote route's answers: an estimated colour and a firm one each carry their own label and figures; the unlabelled twin none; an unpriced colour no ceiling and no label; a refused selection keeps both lists of errors | review |
| `tests/priceEstimateFlagsShown.test.ts` | What the workspace shows (§4.6), through the real compute, apply, form, GET and confirm routes: real measures saved in the pricing form clear their options and confirm answers 200; measures in «الأبعاد والوزن» stay shown until the apply, as the server refuses; under the type's CBM the owner's box keeps «صندوق افتراضي» except where an option's own box or package decides; real measures removed after the compute show the defaults again; «التحديث» shows a price typed since the apply | review |
| `tests/priceEstimateWaitingApply.test.ts` | «التحديث» and `waiting_on_apply` (§4.9, §7): the package's very measures, or the type's CBM beside the owner's box of the same CBM, are listed with no price moved, the refusal says to apply first and the apply lets the price be confirmed; the type's own defaults, or pricing rows written after the lines, keep the contract's words; counted applied flags are offered the apply once, then never again; no apply that takes nothing in is offered (the package's box taken in, then a colour weighed a day; every colour weighed, then a package weight; the type's CBM with each colour's own box), and confirmed options stay firm | review |
| `tests/orderEstimatePolish.test.ts` | The unreadable-records log names how many orders were asked for and the first five ids, never a figure; the trade-in screens say the eligible door's 503 and the copied estimate refusals in ar / en / ckb, and every other refusal exactly as before | review |
| `tests/tradeInEstimateRefusal.test.ts` | No static import path from the /trade-in route reaches `packages/contracts/src/priceEstimates.ts`, and none of its modules loads it lazily (the import graph, read from the syntax tree); the copy is the contract's own words for exactly the refusals those doors answer; through the real client the draft door's 503 and the cart door «أكمل الشراء» adds the device through (409 `PRICE_ESTIMATE_PREORDER_ONLY`, 409 `PRICE_ESTIMATE_ORDERING_PAUSED`) read in ar / en / ckb; the desk's intake sheet says the intake door's 503 in the reader's language | review |
| `tests/supplierPricePlates.test.ts` | The 3D Effect Plate is a type of its own in English and Tmall's words, and refuses another plate's listing; a plate-kind value keeps its type's listings; a build plate refuses an item of another category; a value that states only a generation refuses a SKU of another generation; a 3D Effect set (2 films + 1 spring steel plate) is one offer, not a pack of 3 | review |
| `tests/supplierPriceAddonSkus.test.ts` | 【推荐选购】 marks an add-on as 【推荐加购】 does; the glue beside the real engineering-plate listings is never one of their SKUs, nor in a could-be list | review |
| `tests/supplierPriceBlocks.test.ts` | A variant repeated across JSON-LD blocks follows one rule in the one-page read and the capture script, held to one table; the capture script reads every block of the page's own product (the same `productGroupID`, else the same handle), never another product's; the price sheet says the page gives the option several prices, in ar / en / ckb | review |
| `tests/charmPrice.test.ts` | The dollar charm grid and choice, pure (§4.11): the grid (.49/.99 under $10, .99 to $100, 4.99/9.99 to $1,000, then 9.99) agrees with its definition cent by cent to $3,000 and holds the owner's own prices; the Flush Cutter, AMS and printer shapes on the grid at U = 1,600, the Nozzle at the house price 4,000 ($2.50); the $5 threshold (`CHARM_MIN_USD`, $5.49 the lowest used): a ceiling at exactly $5 × U and just under it prices plainly (8,000 at $5.00; 7,750), as does every one under $5.49's dinar price (8,999 → 8,750), which itself is on the grid ($5.49 = 9,000), at 1,600 and 1,690 — where none under such a ceiling keeps the margin, the lowest house price that does, off the grid (R 8,600 at 0%: 9,000 at $5.63; R 8,999: 9,250 at $5.79; at 1,690 R 9,400: 9,750 at $5.77); the margin of one rounding step (one dinar at or under 1,000 IQD): R 4,760 at 5,250, never 5,000's 240 IQD, which a later rise closes; the grid's old edges 784 / 1,334 / 1,335 / 2,134 now at 862 / 1,750 / 1,750 / 2,500; today's dinar price showing c (R 96,137: $65.99 at 105,750, not $66.09; the hardened-steel combo $68.99 at 110,500; a mainboard $99.99, T_sku above T), T kept where today's own dollar figure already is c (R 97,580; R 29,570.4 at $19.9815), for a house price, at the $100,000 bound and where none lies between the margin and today's; the floor forces a rise only when today's own price would not clear it; under $5 the highest house price within the ceiling (whole dinars at or under 1,000), else the lowest that keeps the margin; the owner's differences on top (+$1.30 → 6,000 under $5, $5.49 at 100%), a negative sum moves nothing; nothing guessed; the property over 374,880 cases (every whole-dinar cost to 17,000, a stride to 60,000, every 997th dinar to 3,000,000, edges, the $5 edges, random and fractional costs; P in {0, 3, 4, 6, 8, 10, 25, 100}; U in {1,600, 1,690}; the thirteen types' T and two under one step; differences on one case in nine): no charm price under a ceiling below $5 × U or $5.49's dinar price, no house price at or above it (both boundaries reached); on the grid c ≥ $5, rp(R + (T_sku + Δ) × U) = rp(c × U), the dollar price c; plainly a house price D, T_sku = floor6((D − R) ÷ U − Δ), the dollar price D's own; above rp(R) with its margin, still above rp(R') after sampled rises of R and U, never above today's unless the floor forces it (reached), the highest price within the ceiling whose margin holds else the lowest whose margin holds, in each branch, a charm price at today's dinar price only where today's own figure is not c (both reached) | row 291 |
| `tests/charmPriceAtToday.test.ts` | The ruling «today's dinar price shows c» against the rule it replaced (§4.11), pure: the pre-change `charmTarget` kept verbatim as the oracle (`tests/fixtures/charmBeforeRuling.ts`); the live cards' shapes (the hardened-steel combo $69.04 → $68.99 at 110,500, a mainboard $99.94 → $99.99 at 160,000, the 12 V adapter, the tea lights; the soccerbot, a figure already $19.99 and the $100,000 bound as they were); 300,000 seeded random figures: both read alike, not one dinar figure moves, every difference a T kept at today's price now `charm` there showing exactly c (usd_ceil6 c), today's own not c, its margin kept, T_sku within one rounding step's worth of T, above and below; everything else field for field | row 291 |
| `tests/estimateProfitCap.test.ts` | The profit ceiling's planner, pure (§4.11), at U = 1,600: each SKU's profit is its ceiling price's — a charm price from $5 up (a printer $1,879.99), the house price under it (the Nozzle shape 4,000) — with its margin (R 4,760 at 5,250), a charm price at today's dinar price at c's own profit (R 96,137: $5.904375), T where today's price stays as it shows (R 97,580, already $66.99); the owner's colour difference on top (gold 6,000), negative ones moving nothing; T for a model at his own fixed dollar price; the ceiling's grammar 0–100; the least specific exact representation (product, one option group, colour, SKU), every SKU re-resolved by `resolveRuleAt`, never above today's and keeping its margin (random grids, every ceiling); no ceiling and no ceiling record changes nothing; 0% is the lowest price whose margin holds; the owner's rules win (option, colour and SKU holds, live or blocked; an owner product rule takes the ceiling's own rules back to inherit; a changed, cleared or never-recorded rule); the first evaluation's plan is the product with no ceiling, and nothing planned falls back to it; no exact representation within 60 rows: one profit per group (61 SKUs on one product rule — under $5 the cheapest profit, every one at its own house price, no flag; at $10.99 the dearest, all at 17,750; the 62-SKU filament on its 31 colours), never above T, from $5 up at or above its own profit, under $5 at or under its own price where the cheapest keeps every margin (R 900–960: never 1,250 on a 90 IQD margin; across 1,000 IQD the least that keeps each at or above its own, 970–1,030: 1,250, not 1,500), and a property over random grids past 60 rows (differences, small T, every band): no margin lost at the price a SKU resolves to, `EST_CEILING_SHARED` naming exactly the SKUs above their own, never blocking; not even that: today's rule, flagged, not blocked; an owner's product rule with more than 60 ceiling rules to take back is `EST_TOO_MANY_SCOPES`; the record round-trips, its new key only when non-empty; today's plan unless the new one costs nothing, against the pre-change planner kept verbatim (`tests/fixtures/charmBeforeRuling.ts`) — 70 colours (35 at $19.99 under today's 32,500, 35 at $19.99's dinar price, today's own) keep today's plan byte for byte, every one at 32,000 (the shared profit would sell 35 at 32,500), so do 61 at today's dinar price, 55 and 20, the owner's SKU counted, and 19 take the new plan, every one at $19.99; a plan not exact stands, the other one exact or not (59 rules of a larger past to take back); two worlds, one product through both codes, each from the state its own applies left — the 62-SKU part whose one colour moves (117,000, not a shared 117,750; a re-compute with nothing changed never blocked), the 44-SKU product with an owner's SKU rule, the 70 colours past a second apply and a rate move, the 48 SKUs whose models take boxes of their own, 27 colours gaining a model, 19 doubling: every dinar price as today's code at every step, no block in one world only, and a property over random sequences to 72 SKUs, growth among the events, each SKU moved showing c, none past 19 SKUs; its one limit pinned (19 SKUs on such rules jumping past 40). A property over random grids to 72 SKUs, the owner's rules among them, against today's plan: every dinar price today's plan's, the two different only where both are exact, each SKU moved showing c | row 291 |
| `tests/priceEstimateProfitCap.test.ts` | The profit ceiling end to end at U = 1,600: the Nozzle Wiping Plate 13,500 → the house price 4,000 at 10% (listed large, refused without the tick, applied with it, one hash over both evaluations, `usd_ceil6` 2.5; FX-5 moves the price and no rule); from $5 up the Flush Cutter 25,750 → $11.99 / 19,250, an AMS 530,250 → $294.99 / 472,000 at 4%, a printer 3,145,000 → $1,879.99 / 3,008,000 at 3%, every published dollar price on the grid, every one under $5 its house price's own; no ceiling or an emptied one is today's byte for byte; a SKU whose charm price's dinar price is today's shows c there (105,750 at $65.99, rule $5.903312; not listed in «التحديث», applied through `POST /apply` on its fresh hash) and one already showing c keeps T (the same hash, lines and record); past 19 SKUs today's plan at every compute (62 SKUs at today's dinar price keep T and their hash; one colour's supplier price moves: 117,000 at $72.99 on rules of its own, not a shared 117,750; re-computed, at a new rate, the ceiling emptied: never blocked); 19 colours show c on rules of their own, 20 keep T; FX-5 between applies keeps c's profit in dollars (106,250 where T sells 106,000 at U 1,607, 109,000 where T sells 109,250 at 1,650, the dollar figure still c), the next compute and apply pricing it as today's code; the hardened-steel combo as it sold on 2026-11-05 (a 57.98 EUR store page, the type's default box): 110,500 at $69.04 → $68.99, usd_ceil6 68.99, the storefront card 6,899 cents, the soccerbot (nothing goes up) and an owner-priced twin unchanged; an owner's model rules and prices kept, and on a product with one owner model the others priced on one option group; colour and SKU rules through the form's own parser, written and recorded; 0% sells a 1,056 IQD part at 1,500 and a 696 IQD part at 697, nothing blocked, no warning; paused and confirmed untouched; firm SKUs reset (pinned); a SKU at 792 IQD whose cost then moves just past 1,000 IQD (a supplier price) is priced again by the next compute (1,500), never stuck; the CNY rate alone after a ceiling apply: the margin keeps the route open, FX-5 follows and holds nothing, and the next compute and apply price it under the ceiling again; twenty cheap parts, then the dollar at 1,700 and the yuan at 0.153: no route held and none sells at or under its new cost — FX-5's own 15% guard holds the cheapest (1,500 → 1,750) for review; the owner's +$1.30 gold colour at 6,000 beside red's 4,000, and a model at his fixed $20 kept at T and his price; the 62-SKU filament priced on its colours under 6% (`EST_CEILING_SHARED`), applied, never above today's rule; an owner's product rule after a ceiling apply takes the ceiling's colour rules back (a reviewed rise); the rollback puts T back and the ceiling's rules to inherit, an owner-priced product to his own rule | row 291 |
| `tests/migration0222ProfitCap.test.ts` | Migration 0222: one ADD COLUMN, no seed; `migrate-check --twice`; the CHECK grammar (0 to 100, two decimals); the import guard; `PUT /estimates/types/:key` writes the ceiling in its own statement, audited in `pricing_audit` with names only in `audit_log`; 0 stored canonical, null clears it; a column gone between the read and the write is 503; `POST /estimates/types` answers and audits the new type's ceiling | row 291 |

### Existing tests that change

| Test file | Change | WP |
|---|---|---|
| `tests/orderDeletion.test.ts` | A cancelled estimate order that loses its deletion race (its cancellation clock, a receipt or a posting error lands before the batch) is `ORDER_CHANGED` and keeps its rows; the sweep counts it as skipped; uncontended, it is deleted with its `order_price_estimates` row | review |
| `tests/priceRequestPanel.test.ts` | Its pins of the quote effect's early return and of `noPrice` carry a combination the product does not sell (`selectionUnoffered`, §5.3) | review |
| `tests/catalogImportGuards.test.ts` | The twelve late tables in `protectedTables.ts` `LATE_PROTECTED_TABLES` (`guardedBy: '0218_price_estimates.sql'`) each carry their three triggers in the fully migrated schema. The 0195 generated block is unchanged. | 1 |
| `tests/edgeParity.test.ts` | Both copies of `FINANCIAL_FIELDS` match | 1 |
| `tests/costPredicateUsage.test.ts` | `LATER_ROUTERS` gains `adminSupplierPrices.ts` and `adminPriceEstimates.ts` (`/requireCostRead/`) | 1 |
| `tests/schemaVersion.test.ts` | Stays green with the bumped pin | 1 |
| `tests/pricingCostToPrice.test.ts` | The src-import regex gains `estimateInputs` | 3 |
| `tests/pricingV2Writer.test.ts` | The `estimate` option is laid after 9b inside the token; without it the batch is byte-identical | 6 |
| `tests/importStockDecision.test.ts` | The in-batch `untracked` decision and its `PREORDER_OFFERED` fence | 6 |
| `tests/pricingV2Overlay.test.ts` | The firm arm, marker 3 and the fallback tier | 7 |
| `tests/d1Waves.test.ts` | No new wave and no new prepared statement on the hot routes | 7 |
| `tests/customerFinalPrices.test.ts`, `tests/costPublicChannels.test.ts`, `tests/securityPricingLeak.test.ts`, `tests/publicProjection.test.ts` | Fixtures with an estimated product; `price_estimate` allowed, no private key | 7 |
| `tests/assistPriceParity.test.ts` | An estimated product: the assistant's card equals the grid's | 7 |
| `tests/publicApi.test.ts` | `price.estimate` | 7 |
| `tests/priceRequestsSweep.test.ts`, `tests/cartBatchParity.test.ts` | Estimate wording; the batch add refuses like the single add | 8 |
| `tests/orderPriceAdjust.test.ts`, `tests/orderStages.test.ts`, `tests/checkoutPayment.test.ts`, `tests/orderExpiry.test.ts`, `tests/financeReportPriceAdjustment.test.ts` | `reason_code` and `extra`; the new reasons; `hasEstimate`; the sweep exclusion; an estimate adjustment in the finance report | 9 |
| `tests/routeClass/money.ts` | `GET /:id/price-estimate` (`op`), `POST /:id/price-estimate/confirm` (`money`) | 9 |
| `tests/pricingCurrencyRoles.test.ts` | `worker/lib/orderEstimates.ts` joins the "imports nothing from the engine or FX" list. Everything under `pricingEngine/estimate/` must stay free of `order_items` and FX imports. | 9 |
| `tests/soraniStorefrontGaps.test.ts`, `tests/bundleBudget.test.ts`, `tests/support.test.ts` | New storefront files under `twoLanguageLoc(…, {copies: true})`; `EstimateNotice` in its own chunk with the entry budget unchanged; the `price_estimate` intent | 10 |
| `tests/checkoutSorani.test.ts` | The new checkout strings | 11 |
| `tests/policyCorpus.test.ts`, `tests/policyHashLedger.test.ts` | Purchase v7, price protection and the FAQ entry | 14 |
| `tests/routeClass/pricing.ts`, `tests/costRoleMatrix.test.ts` | The two sub-routers' routes classified `cost_read` / `cost_write`; owner-only refusals | 15 |
| `tests/edgeParity.test.ts`, `tests/schemaVersion.test.ts` | `profit_cap_pct` in both copies of `FINANCIAL_FIELDS`; the expected migration is `0222_estimate_profit_cap.sql`, 213 files | row 291 |
| `tests/estimateAdminUi.test.ts` | The type editor's profit ceiling, 0–100 (sent as text only when changed, 0 accepted, emptied as null, a comma or a figure past the grammar refused, never offered by an older server; no warning of its own; its hint names the grid, today's price, the shop's usual dinar prices cheap items take instead and the safe margin in words, no figure, in the three languages); `EST_CEILING_SHARED`'s words (information); the page's one box for every large change, each item still on its own hash | row 291 |
| `tests/priceEstimateDeployAhead.test.ts` | On a database without 0222, at U = 1,600: no ceiling key on a type, compute byte for byte (the same hash), a type edit without a ceiling works, a ceiling is 503 `PRICE_ESTIMATES_NOT_INSTALLED`, a new type is answered without the key, nothing logged | row 291 |
| `tests/monorepo.test.ts` | `packages/pricing/src/charmPrice.ts` joins `PURE_PACKAGE_IMPORTS` with the one contracts edge (`@levonis/contracts/procurementCost`), the exact arithmetic of the charm price; `estimateInputs.ts` stays relative-only | row 291 |

**Must stay green without edits:** `tests/listingPredicateGuard.test.ts`, `tests/liveCostProbes.test.ts` (and `scripts/live-cost-probes.d/*.json`; no probe forbids `price_estimate`, which was checked), `tests/costRouteClassification.test.ts` (it discovers `tests/routeClass/*.ts` itself), `tests/deployAheadOfMigrations.test.ts`, `tests/pricingV2AutoReprice.test.ts`, `tests/listingSplit.test.ts`, `tests/catalogOnlyProjectionKeys.test.ts`, `tests/bundlePrivateNames.test.ts` (the admin chunk calls `/api/admin/pricing`, so it is an owner pricing chunk).

`scripts/test-timings.json` is refreshed with `scripts/update-test-timings.mjs` in WP15, so the sixteen shards stay balanced.

---

## 11. Risks and how the design contains each

| Risk | Containment |
|---|---|
| An estimate is shown as a confirmed price | The label is per product, on the row the price is read with, and set in the batch that first prices the product (T1). Any later SKU is labelled. A failed firm read labels every SKU, and only of labelled products. The edge revision is bumped and pages are purged. Old clients cannot buy without the versioned acknowledgement. The label cannot be removed while a default measure prices a SKU (T2). |
| An estimate is sold without its record or settlement | T6: no labelled line without the checkout token. T7: estimate rows are born with the order. T8: no confirm, preparation, shipping, courier booking or reopening while a line is unsettled. No probe decides any of this. |
| Wrong match (product, colour, pack) | Only exact and high matches are confirmed automatically, and high ones are listed for audit. Pack and weight must agree, ambiguity unmaps both sides, and only the owner divides a pack. Matching never publishes; the owner's apply does, product by product. The customer is protected anyway: an increase needs approval, and cancelling is open until settlement. |
| A stocked or firm product is turned into an estimate | Never-on-published (pre-check and in-batch fence). Structure changes only on import-created products with no stock, no lots and no cells; otherwise `EST_STRUCTURE_OWNER`. |
| Owner corrections overwritten | The three-way merge against `applied_wire_json`. `usd`-method, confirmed and paused products are never touched. A pending purchase review blocks. |
| Money surprise on settlement | The 0140 money rule is unchanged: an increase is collected only at the door after approval, and a cut is refunded to the wallet. Financed payments are excluded at checkout. A rejection is honoured or cancelled with a full refund. |
| Orders stuck at «تم الاستلام» | The board filter, the badge, the admin Telegram warning and the confirm panel. The customer can always cancel. The expiry sweep skips these orders. The stage sweep never selects them, because they have no clock. |
| Freight or profit leak | One route per product (row 220 (a) does not grow). All estimate routes are owner-only. New `FINANCIAL_FIELDS` keys. Default measures stay private. The customer flag carries no figure. The cross-product regression of row 281 is acknowledged, pinned and left to the owner (282(e)). |
| Stale supplier prices or moving rates | Rates: FX-5 with the 15% / 30% holds. Catalogue: `EST_SNAPSHOT_STALE`, `EST_SOURCE_ITEM_MISSING` and the Refresh tab. Placed orders keep their price until settlement. |
| D1 limits | 900 statements per invocation (`countingD1`), 600 per product batch with structure (`V2_SAVE_STATEMENT_CAP`) and 200 without (`V2_PRICING_STATEMENT_CAP`), `json_each` writes, ≤ 100 bound parameters, ≤ 32 function arguments, upload chunks ≤ 256 KB, pages of 25 / 10 / 5. |
| Deploy ahead of 0218, or a rollback | Every reader tolerates absence (§2.4). An older Worker cannot sell an estimate (T6) or ship one (T8). Every package is inert until the owner turns on apply. |
| Clash with an import run | The 0195 guard row stops pricing writes and the new tables' guards (T12). Apply refuses first (`EST_IMPORT_RUNNING`). |
| EU VAT and the geo-redirect | `price_basis` is recorded and never converted. Store reads store the page's own currency and host, and the source↔currency CHECK refuses USD labelled as EUR. The US reference is flagged. Typed entry exists. |
| Route floor blocks a SKU (T × U < 250 IQD) | `V2_ROUTE_BELOW_COST` is a blocking code, and the type editor warns. |
| Bundle size and Sorani quality | The eager addition is two labels (about 120 bytes) in `priceStatus.ts`. Refusal texts stay out of `refusalStrings.ts`, a lazy chunk of its own (§5.5). The lazy /trade-in route never loads the contract: it carries a pinned copy of its three estimate refusals in `src/components/tradeIn/parts.tsx` (about 1.6 KB minified, under 1 KB gzip, against about 6.8 KB gzip for the contract chunk). `src/components/tradeIn/copy.ts`, which the product page's trade-in entry and the profile's services card also load, is unchanged. The admin trade-in desk (lazy, staff only) loads the contract with its intake sheet. Strings are checked by tests (no copy of the Arabic), and a native review is recommended. |
| CPU of grids past `ENGINE_MAX_SKUS` | Only a `VARIANT_COMBINATION` product of 241 to 4,096 cells with active rows reads its grid from the rows (`stockedPastLimit`); the scan is bounded by `SKU_GRID_SCAN_MAX`, and products under the limit cost what they did. Measured in the review: 0.5–1.6 ms per `sellableSkus` call on realistic shapes, up to about 10 ms near 4,096 cells with about 170 values and several colours, about 0.8 ms for a product that overflows anyway. Each `VARIANT_COMBINATION` detail request also builds the page's two lists (`unofferedSkuKeys`, `offeredPastLimitKeys`, each two `sellableSkus` calls), each list under 0.1 ms on the census, and about 0.86 ms on a 264-cell kit, 1.4 ms on a 240-cell grid and 9 ms on a 4,080-cell grid. No live product is past 60 cells (2026-10-07 census). |

---

## 12. Work packages: goals, disjoint files, dependencies, proof

Every push runs `npm run check` and `npm run test:unit` locally first, then workflow 7 is followed to green and the live site is checked. A package owns the files listed against it; no file appears in two packages. "Must not touch" lists the files a package is most tempted to edit; those belong to another package. Until WP15 is live and the owner turns on **apply**, no customer can see or buy an estimate.

### WP0: Decisions and docs (prose; workflow 7 skips docs-only pushes)
- **Goal:** record DECISIONS rows 278–282 and this design before any code.
- **Owns:** `docs/DECISIONS.md`, `docs/SMART_PRICING.md`, `docs/PRICING-V2.md` (a new §12 pointing here), `docs/HANDOFF.md` (go-live list and the rollback check of §2.5), `docs/bambu-import/IMPORT-SPEC.md` (a note under row 10 that the supplier catalogue is separate from the import).
- **Must not touch:** code, migrations, policies.
- **Depends on:** nothing.
- **Proof:** review. `npm run check` stays green.

### WP1: Schema, contracts and leaf guards
- **Goal:** land 0218 and every shared name. Inert: no label can exist yet.
- **Owns:** `migrations/0218_price_estimates.sql`, `worker/lib/schemaVersion.ts`, `worker/lib/catalogImport/protectedTables.ts`, `worker/lib/priceEstimateLabel.ts`, `worker/lib/priceEstimateGate.ts`, `packages/contracts/src/priceEstimates.ts`, `worker/lib/adminScope.ts`, `packages/platform-kit/src/scope.ts`, `tests/migration0218PriceEstimates.test.ts`, `tests/estimateStrings.test.ts`, `tests/catalogImportGuards.test.ts`, `tests/edgeParity.test.ts`, `tests/costPredicateUsage.test.ts`.
- **Must not touch:** `scripts/gen-import-guard-triggers.mjs` and 0195's generated block; any route; any UI.
- **Depends on:** WP0.
- **Proof:** the new migration test and string test; `migrate-check --twice`; `tests/schemaVersion.test.ts`, `tests/deployAheadOfMigrations.test.ts` and `tests/d1Waves.test.ts` stay green.

### WP2: Supplier catalogue library (pure)
- **Goal:** the file format, key extraction, dictionary, matcher and classifier, and the supplier link builder (§3.9).
- **Owns:** `packages/catalog/src/supplierPrices/format.ts`, `keys.ts`, `dictionary.ts`, `match.ts`, `classify.ts`, `links.ts`; `tests/supplierPriceFormat.test.ts`, `tests/supplierPriceMatch.test.ts`, `tests/supplierPriceClassify.test.ts`, `tests/supplierPriceLinks.test.ts`; `tests/fixtures/supplierPrices/*`.
- **Must not touch:** `packages/catalog/src/bambuImport/**` (the import stays as it is).
- **Depends on:** nothing (it can land with or after WP1).
- **Proof:** its four tests.

### WP3: Estimate inputs library (pure, confidential)
- **Goal:** compaction, measure planning, three-way merge.
- **Owns:** `packages/pricing/src/estimateInputs.ts`, `tests/estimateInputs.test.ts`, `tests/pricingCostToPrice.test.ts`.
- **Must not touch:** `costToPrice.ts`, `priceV2.ts`, `skuChannel.ts`, which are reused unchanged.
- **Depends on:** nothing.
- **Proof:** `tests/estimateInputs.test.ts`; the src-import regex.

### WP4: Capture tooling
- **Goal:** turn the Tmall sweep, the EU browser snapshot and store pages into v1 files.
- **Owns:** `scripts/supplier-prices/normalize-tmall.mjs`, `scripts/supplier-prices/normalize-eu-snapshot.mjs`, `scripts/supplier-prices/capture-store-offers.ts`, `.gitignore`, `tests/supplierPriceCaptureScripts.test.ts`, `tests/fixtures/supplierPricePages/*`.
- **Must not touch:** `data/bambu-cn-prices/**` and `data/bambu-eu-prices/**` (the captures in progress), `scripts/bambu-import/**` (imported, not edited).
- **Depends on:** WP2.
- **Proof:** `tests/supplierPriceCaptureScripts.test.ts` (both normalisers and the store reader), with no network.

### WP5: Supplier catalogue server
- **Goal:** upload, match, review, manual entry, lookup, one-page store reads and the supplier links (§3.9), all owner-only. The router stays unmounted until WP15.
- **Owns:** `worker/lib/supplierPrices/store.ts`, `upload.ts`, `matcher.ts`, `lookup.ts`, `storePage.ts`, `links.ts`; `worker/routes/adminSupplierPrices.ts`; `tests/supplierPricesRoutes.test.ts`, `tests/supplierPricesMatcher.test.ts`, `tests/supplierPricesStorePage.test.ts`, `tests/supplierPricesLinksRoute.test.ts`.
- **Must not touch:** `worker/routes/adminPricing.ts` (mount line in WP15), `worker/lib/fetchGuard.ts` (reused).
- **Depends on:** WP1, WP2.
- **Proof:** its four tests (the router is mounted in a test app).

### WP6: Estimator (compute, apply, confirm)
- **Goal:** §4 end to end, owner-only. The router stays unmounted until WP15.
- **Owns:**
  - `worker/lib/pricingEngine/estimate/types.ts`, `classify.ts`, `compute.ts`, `merge.ts`, `apply.ts`, `confirm.ts`, `control.ts`;
  - `worker/lib/pricingEngine/v2/write.ts` (the `estimate` option only);
  - `worker/lib/importStock.ts` (`untrackedDecisionStatements`);
  - `worker/routes/adminPriceEstimates.ts`;
  - `worker/routes/adminProducts.ts` (the non-financial `price_estimate` state on the product read);
  - tests: `tests/priceEstimateCompute.test.ts`, `tests/priceEstimateApply.test.ts`, `tests/priceEstimateConfirm.test.ts`, `tests/priceEstimateFx5.test.ts`, `tests/priceEstimateBudget.test.ts`, `tests/pricingV2Writer.test.ts`, `tests/importStockDecision.test.ts`.
- **Must not touch:** `v2/api.ts`, `v2/evaluate.ts`, `autoReprice.ts`, `rates.ts` (reused unchanged), `worker/lib/fx/*`.
- **Depends on:** WP1, WP3, WP5.
- **Proof:** its tests; `tests/pricingCurrencyRoles.test.ts` and `tests/pricingV2AutoReprice.test.ts` stay green.

### WP7: Customer read path (server)
- **Goal:** the label on every read surface. Inert until a label exists.
- **Owns:** `worker/lib/productModel.ts`, `worker/lib/productOverlay.ts`, `worker/lib/commercialState.ts`, `worker/lib/customerPricing.ts`, `worker/routes/products.ts`, `worker/lib/publicApi/common.ts`, `worker/lib/publicApi/resources/products.ts`, `docs/PUBLIC_API.md`, `worker/lib/edgePolicy.ts`, `worker/lib/creative/store.ts`.
- **Tests:** new `tests/priceEstimateCustomerSurfaces.test.ts`, `tests/priceEstimateDeployAhead.test.ts`, `tests/priceEstimateRouteSpread.test.ts`, `tests/leakAudit_customer-api_estimate_supplier_regression.test.ts`; changed `tests/pricingV2Overlay.test.ts`, `tests/d1Waves.test.ts`, `tests/customerFinalPrices.test.ts`, `tests/costPublicChannels.test.ts`, `tests/securityPricingLeak.test.ts`, `tests/publicProjection.test.ts`, `tests/assistPriceParity.test.ts`, `tests/publicApi.test.ts`.
- **Must not touch:** `worker/lib/listing.ts`, `productCompleteness.ts`, `worker/routes/cart.ts`.
- **Depends on:** WP1.
- **Proof:** the tests above; `tests/listingPredicateGuard.test.ts` and `tests/liveCostProbes.test.ts` stay green.

### WP8: Purchase doors other than checkout
- **Goal:** §6.1 refusals and the row-240 exclusions.
- **Owns:** `worker/lib/cartAdd.ts`, `worker/routes/cart.ts`, `worker/lib/quickBuy/session.ts`, `worker/lib/gifts/selection.ts`, `worker/lib/bundleComposition.ts`, `worker/lib/mysteryDraw.ts`, `worker/lib/tradeInTargets.ts`, `worker/lib/printQuote/repository.ts`, `worker/lib/priceRequests.ts`, `tests/priceEstimateDoors.test.ts`, `tests/priceRequestsSweep.test.ts`, `tests/cartBatchParity.test.ts`.
- **Must not touch:** `worker/routes/orders.ts`, `packages/pricing/src/pricing.ts`.
- **Depends on:** WP1, WP7.
- **Proof:** the tests above; the gift, mystery and bundle suites stay green.

### WP9: Orders and money
- **Goal:** §6.2–6.9.
- **Owns:** `worker/lib/orderEstimates.ts`, `worker/routes/orders.ts`, `packages/pricing/src/paymentPolicy.ts`, `worker/lib/orderPriceAdjust.ts`, `worker/routes/orderPriceAdjust.ts`, `worker/lib/orderStageOps.ts`, `worker/routes/admin.ts`, `worker/lib/orderTelegramConfirm.ts`, `worker/lib/orderNotify.ts`, `worker/lib/adminTopicRouting.ts`, `worker/lib/orderExpirySweep.ts`, `worker/lib/protectionClaims.ts`, `worker/routes/returns.ts`.
- **Tests:** new `tests/priceEstimateCheckout.test.ts`, `tests/orderEstimateGate.test.ts`, `tests/orderEstimates.test.ts`, `tests/priceEstimateProtection.test.ts`; changed `tests/orderPriceAdjust.test.ts`, `tests/orderStages.test.ts`, `tests/checkoutPayment.test.ts`, `tests/orderExpiry.test.ts`, `tests/financeReportPriceAdjustment.test.ts`, `tests/routeClass/money.ts`, `tests/pricingCurrencyRoles.test.ts`.
- **Must not touch:** `packages/pricing/src/priceAdjustment.ts` (the money rule is unchanged), `worker/lib/priceHold.ts`, the 0140 decide, close and void statements.
- **Depends on:** WP1, WP7.
- **Proof:** the tests above; `tests/costRouteClassification.test.ts` green.

### WP10: Customer UI (catalogue, product, support)
- **Goal:** the label, notice and contact on cards and the product page; the support intent.
- **Owns:** `src/lib/priceStatus.ts`, `src/lib/api.ts` (all new response types, including cart, order and the admin product read's `price_estimate`), `src/components/CardPrice.tsx`, `src/components/compare/PriceRow.tsx`, `src/pages/Product.tsx`, `src/components/product/EstimateNotice.tsx`, `src/pages/Support.tsx`, `worker/routes/support.ts`, `tests/estimateStorefrontUi.test.ts`, `tests/soraniStorefrontGaps.test.ts`, `tests/bundleBudget.test.ts`, `tests/support.test.ts`.
- **Must not touch:** `src/lib/refusalStrings.ts` (bundle budget), cart, checkout and order pages.
- **Depends on:** WP7 (and WP1's contract).
- **Proof:** the tests above; the entry budget unchanged.

### WP11: Customer UI (cart, checkout, orders)
- **Goal:** the cart note, the checkout acknowledgement and button, order states, the approval card's estimate variant and Sorani.
- **Owns:** `src/pages/Cart.tsx`, `src/pages/Checkout.tsx`, `src/pages/OrderDetail.tsx`, `src/components/orders/OrderCard.tsx`, `src/components/orders/PriceApprovalCard.tsx`, `src/components/orders/EstimateStatusCard.tsx`, `tests/estimateOrderUi.test.ts`, `tests/checkoutSorani.test.ts`.
- **Must not touch:** `src/lib/api.ts` (WP10), `tests/bundleBudget.test.ts` (WP10; it must stay green).
- **Depends on:** WP8, WP9, WP10.
- **Proof:** the tests above; `tests/bundleBudget.test.ts` green.

### WP12: Admin UI (estimates workspace)
- **Goal:** §7's workspace and the product-form banner.
- **Owns:** `src/components/adminEstimates/*` (`EstimateWorkspace.tsx`, the tab components, `api.ts`, `strings.ts`), `src/components/adminPricing/AdminPricing.tsx`, `src/components/adminProducts/form/v2/PricesSectionV2.tsx`, `tests/estimateAdminUi.test.ts`.
- **Must not touch:** `src/pages/Admin.tsx` (the mount is unchanged); `src/lib/api.ts` (WP10). The workspace's own request and response types live in `src/components/adminEstimates/api.ts`.
- **Depends on:** WP5, WP6, WP10 (the admin product read's type).
- **Proof:** `tests/estimateAdminUi.test.ts`; `tests/bundlePrivateNames.test.ts` green.

### WP13: Admin UI (orders)
- **Goal:** the confirm panel, the board filter and badge, Sorani in the price panel.
- **Owns:** `src/components/adminOrders/EstimateConfirmPanel.tsx`, `src/components/adminOrders/PriceAdjustPanel.tsx`, `src/components/adminOrders/OrderDetailModal.tsx`, `src/components/adminOrders/OrdersBoard.tsx`, `src/components/adminOrders/OrderBoardBadges.tsx`, `tests/estimateAdminOrdersUi.test.ts`.
- **Must not touch:** server files.
- **Depends on:** WP9.
- **Proof:** `tests/estimateAdminOrdersUi.test.ts`.

### WP14: Policies
- **Goal:** purchase policy v7 (the estimated-price clause: estimate, acknowledgement, the order held until settlement, cancel and full refund, approval of any difference); price protection (claims wait for settlement); the FAQ entry. All in ar / en / ckb, with the archive kept byte for byte.
- **Owns:** `worker/lib/policies/purchase.ts`, `worker/lib/policies/price_protection.ts`, `worker/lib/policies/faq.ts`, `tests/policyCorpus.test.ts`, `tests/policyHashLedger.test.ts`.
- **Must not touch:** other policies.
- **Depends on:** WP0.
- **Proof:** the policy tests. WP6's switch refuses apply until `purchase.version ≥ 7`.

### WP15: Wiring (makes the routes reachable)
- **Goal:** mount the two owner routers and classify them; rebalance the shards.
- **Owns:** `worker/routes/adminPricing.ts` (two `.route()` lines: `/supplier-prices`, `/estimates`), `tests/routeClass/pricing.ts`, `tests/costRoleMatrix.test.ts`, `scripts/test-timings.json`.
- **Must not touch:** `worker/index.ts` and `services/gateway/src/routes.ts`. Neither needs a change: `/api/admin/pricing` is already `admin:owner`, and the order endpoints sit in the mounted `adminOrderPriceRoutes`.
- **Depends on:** WP5, WP6, WP8, WP9, WP11, WP12, WP13, WP14. Everything a customer or the owner touches must be live before the owner can apply.
- **Proof:** `tests/costRouteClassification.test.ts`, `tests/costRoleMatrix.test.ts`, the full gate in workflow 7.

### Landing order

1. WP0.
2. WP1.
3. WP2 and WP3 in parallel, then WP4.
4. WP5 and WP7 in parallel.
5. WP6 (after WP5), WP8 and WP9 in parallel.
6. WP10, WP13 and WP14 in parallel, then WP11 and WP12.
7. WP15.

### Go-live, for the owner

1. Finish the Tmall capture: run `data/bambu-cn-prices/tools/assemble-snapshot.mjs`, then `scripts/supplier-prices/normalize-tmall.mjs`.
2. Finish the EU capture (in a browser, with `?skr=yes`, §3.1): run `data/bambu-eu-prices/tools/assemble-snapshot.mjs`, then `scripts/supplier-prices/normalize-eu-snapshot.mjs`. Optionally, capture the US reference with `capture-store-offers.ts --store us`.
3. Fill in the type table: minimum profit, default weight and box or CBM, extra cost, routes. Use "suggest" where it helps.
4. Run «تعبئة أبعاد الشحن من بيانات الاستيراد» while the products are still unpriced.
5. Upload the snapshots and run matching. Audit the automatic confirmations and review the suggestions.
6. Turn on **apply** (needs the published purchase policy v7).
7. Apply one filament, one part and one printer as a canary. Check the label, the notice, the contact link, the acknowledgement, the order held at «تم الاستلام», the courier refusal, and both settlement paths (same price, and a different price approved).
8. Apply the rest in bulk.

---

## 13. As built: where the code departs from the text above (integration of WP0–WP15, 2026-11-01)

The sixteen packages were built in parallel and integrated in one checkout. Every departure below is deliberate; none weakens I1–I8.

**Schema and shared names (WP1).**
- T11's `CASE`s close with `END ,` (a space before the comma): Wrangler's splitter closes a `CASE` only on `END` followed by whitespace or `;`. Behaviour is unchanged.
- T5 is stricter than §2.2: filament and filament packs are China-sourced by sea only (`route_override` NULL or `sea`, `sourcing_override` NULL or `CHINA_CNY`), and China sourcing is never by land. EU sourcing with no route override still means land.
- T4 has an update twin (`trg_price_estimate_firm_upd`), and T7 also requires the estimate row to describe a line of that order (the same `order_id`, `product_id` and `qty`).
- One more index, `ix_ope_adjustment`, serves T11's lookup by proposal on every 0140 decision. The file is 74 statements; `migrate-check --twice` re-runs 72.
- §12 missed four registries that must change in the same push as 0218, and they did: `packages/contracts/src/ownership.ts` (eleven Catalog tables, `order_price_estimates` to Commerce; also `docs/architecture/01-TARGET.md` §2.1), `worker/lib/productDeletion.ts` (five owned tables, `order_price_estimates` as frozen history, the owner-only four reported as `pricing_engine`), `worker/lib/mediaRefs.ts` (32 non-media columns) and `worker/lib/orderDeletion.ts` (`order_price_estimates`, deleted before its line).
- The contract's table is `ESTIMATE_STRINGS` (not `ESTIMATE_TEXT`, the eager copies' name). It also carries `PRICE_ESTIMATE_TYPE_RULE` (409, T5) and `PRICE_ESTIMATE_STORE_PAGE_UNREADABLE` (502, §3.6), and `PRICE_ESTIMATES_READ_FAILED` is written for a customer (§5.5).

**Supplier catalogue (WP2, WP4, WP5).**
- The matcher has four more reasons (`MODEL_MISMATCH`, `LISTING_MISMATCH`, `PLACEHOLDER_LISTING`, `PROMO_LISTING`; 17 in `MATCH_REASONS`). A refused pairing maps no SKU and is never stored, so the estimator never raises `EST_PACK_MISMATCH` or `EST_TYPE_MISMATCH`: such a SKU is blocked by `EST_NO_PRICE` (and `EST_MATCH_REVIEW` when a suggestion exists).
- EU variant ids are the EU store's own, never the import's US `bambu_variant_id`, so EU matches are `high` by handle and English labels, never `exact` (§3.1).
- The matcher reads products as the cart does (`loadProducts`) plus one batch of five reads, not three statements; upload statements bind two parameters (the snapshot id and the `json_each` list).
- The links reads answer an empty list without 0218, and nest every supplier fact under `supplier_prices` (§3.9 as corrected).
- Every catalogue write adds an `audit_log` row carrying ids and counts only, never an amount.

**Estimator (WP3, WP6).**
- An owner's supplier entry protects its SKU at every level: the estimator never writes a supplier absolute at or above it, and compacts only catalogue-priced SKUs. Any unpriced SKU forces per-SKU writes, so nothing is inferred from a sibling. A type's default CBM beats its default box (a manual CBM beats a box at its level).
- `applied_wire_json` is `{v: 1, inputs: [{scope, scope_id, field, value, source}], minimum_profit}`; the type's defaults are recorded with source `type_default`.
- The no-stock condition of §4.7 lives in `worker/lib/importStock.ts` (`NO_STOCK_SETUP_SQL`), because no file under `pricingEngine/` may name `inventory_lots`.
- Added blocks: `EST_PURCHASE_REVIEW_PENDING` (a stock-purchase overlay), a blocked route or any channel other than the type's route, and `EST_IMPORT_RUNNING` while an import batch runs. The apply switch needs `purchase.version >= 7` in force.
- Apply and confirm purge pages with `afterCatalogueWrite` directly (the pricing router mounts no purge middleware). Pause and resume are `PUT /estimates/products/:id {version, state}`.
- The 900-statement budget is counted by `countingD1` of `worker/lib/invocationCounter.ts`, moved out of the import's `catalogImport/budget.ts` (which re-exports it), so the estimator imports none of the import's code but its validated reviewed-manifest reader (`currentReviewedBundle`, §3.8 step 3). `tests/noImportSync.test.ts` names that one read and proves the estimator's only door is the owner's estimates router, never a cron path.

**Customer surfaces and purchase doors (WP7, WP8, WP10).**
- The doors decide with `selectionEstimated(doc, optionValueIds, colorId)`: a complete selection is `skuEstimated`; a partial one is labelled when some priced SKU completing it is an estimate.
- A firm-arm failure other than "no such table" is logged and the statement re-run without the arm (not remembered): every SKU of a labelled product is then labelled (I2).
- §5.3's favourites and compare row are not `CARD_FIELDS` cards. The label is read from the row the price is read with: the favourites lists through `runWithEstimateClause` (a computed column), the compare columns and the priced picker from their `SELECT *` rows. The compare label is product level, so a firm SKU of a labelled product is still labelled there (fail closed). The support assistant's cards copy `price_estimate` and append «سعر تقديري» to their subtitle, because `Support.tsx` draws the subtitle, not `CardPrice`.
- The print calculator's filament list (`GET /api/products/print-calculator`) also skips labelled products, beside `loadMaterialPrices`.
- Gifts refuse with a new code, `GIFT_PRICE_ESTIMATE` (its admin words in `src/components/adminGifts/strings.ts`), and a gift cart line of a labelled product answers 409 `GIFT_NOT_AVAILABLE` (`details.errors: ['PRICE_ESTIMATE']`). A labelled bundle member reads as hidden (`COMPONENT_UNAVAILABLE`, admin warning `COMPONENT_PRICE_ESTIMATE`); a mystery preview names `PRICE_ESTIMATE`.
- The public API's bundle `price` now carries `status` and `estimate: false`, so it matches `PRICE_SCHEMA`; `/context` explains `estimate: true`.
- Estimate refusals are said in the reader's language on every screen that can receive one, the contract loaded lazily: the product page, the colour batch add, Quick Buy (a stale page), the cart, the checkout, price protection, the order, and the admin stage and status doors (since the later rounds the desk's intake sheet too, and the customer's trade-in screens from a pinned copy of their three refusals, without the contract, §5.5).

**Orders (WP9, WP11, WP13).**
- The quote's `estimate` block also carries `ordering_paused: true` (with the blocker `PRICE_ESTIMATE_ORDERING_PAUSED`); 409 `PRICE_ESTIMATE_ACK_REQUIRED` carries `details.quote`. The checkout sends its own bundle's `ESTIMATE_NOTICE_VERSION`, and a stale tab is told to reload.
- Settlement refusals reuse the 0140 codes; an edited `new_total_iqd` with no changed line is refused (400). The same-total confirm is fenced by `ops_guards('estimate-settle:<order>')` and restarts the expiry clock.
- Price protection on an engine line moves the frozen `engine_regular_iqd` by the same per-unit final − estimate; a settled line carries its own difference, never spread over the order's other lines.
- `publicAdjustment` always emits `reason_code`; the admin price-adjustment read gains `estimate_open` and the blocker `PRICE_ESTIMATE_OPEN`; a held board row offers no one-tap move.
- The confirm panel is mounted through `PriceAdjustPanel`, and the board badge through `PriceHoldBadge`.

**Admin workspace (WP12).** There is no separate after-apply drawer: a correction opens the product's own editor at section ٣, which saves through the same `PUT /api/admin/products-v2/:id/pricing`, so every workspace call stays under `/api/admin/pricing`. The workspace opens on the Links tab.

**Policies (WP14).** Purchase 7 adds 1.3, one sentence in 3.10 and 4.11–4.17 (no article renumbered); price protection 6 adds 1.2, 5.6, 6.6 and 10.12; FAQ 7 adds 12.12. The legal text uses the corpus's defined Sorani term «داواکاری پێشوەخت» (not the UI's «پێشداواکاری») and names the stage as the code labels it, «تم استلام الطلب».

**Wiring (WP15).** The 25 routes are classified under the `adminPricingRoutes` mount. `tests/fixtures/deployAhead.ts` lists the eight owner reads that read only 0218's tables (the two by-id reads answer 404 on the migrated database: `ahead: 404`), and its cap is 12. `scripts/test-timings.json` carries local measurements for the 30 new test files until the next CI-log refresh.

**Review fixes (2026-11-01).** An adversarial review of the integrated feature confirmed 13 defects (2 high, 7 medium, 4 low); each was fixed on its own files and re-checked by a second reviewer. Where the text above was wrong it now says what the code does (§2.2 T9, §3.1, §3.3, §3.5, §3.6, §3.8, §4.4, §4.6, §4.8, §4.9, §5.5, §6.5, §6.9, §7, §10). The rest:
- **Products stocked by combination** (row 283; `docs/PRICING-V2.md` §12). `sellableSkus` leaves out a combination with no active `product_variants` row when each of its choices is stocked in another combination, so an imported multi-group product is matched, typed, decided and estimated on the variants it sells: the Bus Cable's 3 real variants of a 6-cell grid now match `high` and are priced without `EST_NO_PRICE`. A choice that no stocked combination holds keeps its cells, and its estimate fails closed with `EST_NO_PRICE` until the owner deactivates it, adds a variant or types a price; that the Bambu import never creates such a choice is true of the samples, not guaranteed by `bambuImport/options.ts`. Past `ENGINE_MAX_SKUS` (240) such a product is counted on the cells it keeps, not on the whole cross product (second round, below). A transient failure of the soft variants read gives the whole grid back for that evaluation (past 240, `SKU_GRID_TOO_LARGE`), the same class as the groups, values and links reads.
- **Estimator.** An owner-held stock route other than the type's blocks (§4.4). An estimated row keeps its applied soft and hard flags (§4.8), and confirm re-reads the catalogue for the targeted SKUs (§4.9). Known gap, the owner's to decide (282(l)): `EST_SNAPSHOT_STALE` is judged on the source's newest capture, not on the capture the published amount came from.
- **Sale prices.** One rule in every store reader (the browser snapshot through `assemble-snapshot.mjs` and `strike/*.json`, `capture-store-offers.ts`, the one-page read): `offers.priceSpecification` entries of `priceType` `StrikethroughPrice` or `ListPrice` (the schema.org URL or the bare name, an object or a list) in the offer's currency (an entry with no currency counts as the offer's); the highest such price above `offers.price` is the price, and `offers.price` is the sale price; a missing, empty or zero regular price means none is stated; a stated regular price that cannot be read refuses the variant (`regular_price_invalid`), or drops the offer in the one-page read (502 `PRICE_ESTIMATE_STORE_PAGE_UNREADABLE` when it was the only one). The rule lives in `normalize-eu-snapshot.mjs` `offerPriceOf` and, because the Worker cannot import the `.mjs`, again in `worker/lib/supplierPrices/storePage.ts`; `tests/supplierPriceSaleRule.test.ts` holds the two to one table. The reports of `capture-store-offers.ts` and `normalize-eu-snapshot.mjs` gain `on_sale: [{handle, sku, price, sale_price}]`; the sale price is never written and `price_basis` stays `list`. On 2026-10-31, 86 EU variants were on sale; the v1 file carries their regular prices. Without a variant id, the one-page read's "one distinct price" check compares regular prices.
- **Classification.** Accessories are judged by name too and map to `electronics_device`. All 267 products of the EU snapshot and all 1,115 manifest rows now classify as the capture's sourcing says; about 96 products changed estimate type (89 to the EU, 17 of them accessories now `electronics_device`, and 7 to China). The capture's rule has inherited weaknesses on some Tmall English names (heatbed scraper blades, laser platform clamp blocks, a drag-chain cable clip, a heatbed magnetic sheet, a filament tube expansion port, a laser-module air tube connector read as electronic); no Levonis product has such a name, the confirmed Tmall category decides first for Tmall items, and a fix belongs in both places. Some electro-mechanical assemblies stay China by the owner's rule (AMS lite, AMS 2 Pro and AMS HT feeder units, the Adaptive Airflow Switching Unit, the Automatic Top Vent Kit, extruder units, the TPU Feed Assist Module, the Rotary Attachment); the owner can choose their type by hand.
- **Orders.** Offer lines and the "total unchanged" notice (§5.5, §6.5); one attribution for refunds, trade-in and protection (§6.9). T9 is written `<>` like 0175, so a lost cancelled-order deletion answers 409 `ORDER_CHANGED` instead of 500 (§2.2); the statement counts are unchanged (74, 72 re-run). Like 0081, 0175 and 0191, T9 cannot see an `UPDATE OR REPLACE … SET status = NULL`, which REPLACE turns into the default; no code writes `UPDATE OR <conflict>` on any table, so this is accepted as the house shape.
- **Customer surfaces.** In «عدة ألوان» (`ColourQuantityPanel.tsx`) the total in the phone bar and the desktop panel reads «سعر تقديري · الإجمالي» while any colour with a quantity is an estimate, and the spoken total says it too; when the colours' prices differ, an estimated colour's price carries «تقديري» (`ESTIMATE_SHORT`). Each colour's own quote decides; until it answers, the product's or the page's label stands in (fail closed, I2).
- **Tmall listings without options** become one SKU keyed by their item id (§3.3): four real listings (a laser work platform ¥399, a laser platform support bar set ¥80, an X1 display rear cover ¥79, an X1C heatbed ¥799) are in the v1 file instead of being dropped.

**Review fixes, second and third rounds (2026-11-01).** A second round fixed the 23 lows the first round left, in six groups; a third fixed the 20 lows the second round left, in five. Every item was low. Each fix was re-checked by an adversarial verifier, who found three medium regressions on the way, all in the estimator's owner lists, each fixed and re-checked: in the second round a line on the owner's measures hid a default box the type's CBM still priced (§4.6, `typeCbmHidesBox`); in the third, «التحديث» offered an apply that took nothing in but deleted every firm SKU, first for a product whose applied flags are stored counted, then for an option weighed after the package's box was taken in (§7; the last fixed by hand after the round, then checked by its own tests and probes and by an adversarial reviewer, whose one further case — the owner's own manual CBM or pricing weight at the product level, which decides that level before the recorded type default — was fixed the same way). Where the text above was wrong it now says what the code does (§3.1, §3.3, §3.5, §3.6, §4.6, §4.8, §4.9, §5.3, §5.5, §6.5, §6.9, §7, §10, §11). The rest:
- **Products stocked by combination, past `ENGINE_MAX_SKUS`** (row 283; `docs/PRICING-V2.md` §12). A `VARIANT_COMBINATION` product with active rows is counted on the cells it keeps (`stockedPastLimit`), and is `SKU_GRID_TOO_LARGE` only when those pass 240, when no row names a cell, or past `SKU_GRID_SCAN_MAX` = 4,096 cells. No product is confirmed past 240: in the manifest only the wireless inductive coil kit (3 groups, 30 values, 22 variants; its split is not in the repo) can be. If each of its values is in one of its variants, it is matched and estimated on those 22 in any split (`tests/priceEstimateVariantGridLarge.test.ts` runs a 264-cell split end to end).
- **Storefront.** On the product page a combination the product does not sell (one `sellableSkus` leaves out, under `ENGINE_MAX_SKUS` or past it) is never quoted, priced or offered «طلب السعر», and every code the detail and the quote can bring it has words (§5.3; a cart refusal coded `VALIDATION` in a race is a known low, below). In «عدة ألوان» the notice follows the panel's total (§5.3), and a row's quote is the pure `rowQuoteOf`.
- **Estimator and workspace.** A refresh's flags sit beside the applied ones whole, counted or not at all, never cut (§4.8), and a counted entry keeps its count (§4.6). The default measures shown follow the latest lines, with the type's-CBM, level-above and late-pricing-row rules (§4.6). «التحديث» lists a refresh whose apply takes real measures in and shows the refresh's price sources (§7); it offers no apply that takes nothing in, but for one residual (a known low, below). §4.9's refusal says when that apply is the cure (`waiting_on_apply`). A flag names its fields in the pricing screens' words (§7).
- **Orders and trade-in.** An offer line's button reads «استخدم سعر اليوم بنفس العرض», and the confirm answer leaves `offer_today_unit_iqd` out (§6.5). The customer's trade-in screens and the desk's intake sheet say estimate refusals in the reader's language (§5.5), and the unreadable-records log names its orders (§6.9). `tests/priceEstimateReturnsFlow.test.ts` also covers a confirmation absorbed by a kept total through the real doors: refund, trade-in and protection each read the line's charge.
- **Supplier readers.** A unit price is never the regular price (§3.1). A variant repeated across JSON-LD nodes follows one rule in the one-page read and the capture script, `copyKept` in each (§3.3, §3.6): the Worker cannot import the scripts, and the script would load about 229 Worker modules through `storePage.ts` (it loads 9), so `tests/supplierPriceBlocks.test.ts` holds the two to one table. The save message names the sale price only for the saved variant (§3.6). The fixture README lists the two sale pages.
- **Matching.** Plate types and generations, the category rule, add-on SKUs, the `+`-joined set and the classifier's ™ / ® order (§3.5). On the 2026-10-31 captures the category rule removes wrong suggestions for plate products (spare-part "plates", EU parts, the EU A1 Combo Starter Kit). With 【推荐选购】 the engineering-plate listings 995409205368 (A2L/H2C) and 997242295770 (H2D/H2S) each have one real SKU: a product's H2C SKU maps to 6139846547314, and the H2D or H2S SKU of a product without an H2C SKU to 5980973024945 (low suggestions; only the best listing per source is stored, and a product with both H2D and H2S leaves both for the owner). The 3D Effect listing 800769896817 now reads each of its 8 sets (2 films and a spring steel plate) as one offer, but its only key shared with a 3D Effect product is the name token "plate", so it is still never among the top six candidates: the owner confirms it by hand or types a price, and directly against it each printer size stays `AMBIGUOUS`. Tmall listings without options needed no matcher change: a one-SKU product pairs with the item-id SKU as with any one-SKU item, confirmed automatically only on the same evidence (an equal part code, or colour codes covering its colours with an equal material); the four 2026-10-31 listings carry neither, so they come out as suggestions (medium at best), and a product with options maps at most one SKU to such a listing.

**The owner's statement of real measures (2026-11-05; DECISIONS row 292).** The owner could not press «أكّد السعر» on a Maker's Supply flush cutter (52.5 CNY by sea, shown at 0.1 kg and 16 × 11 × 3 cm). The cause is inferred, since no production data was read. Those were almost certainly the type's defaults, and the sheet held its submit disabled on them with no way out from the product form. Three more defects were found on the way. All four are fixed:
- **The one-step statement.** §4.9 step 0, `attestBaseMeasures` / `measureGate` in `estimateInputs.ts`, and the sheet in §7. D2, T2 and the CHECK are unchanged.
- **The sheet held what the server would accept.** It read the latest lines, so after a pricing-form save it stayed shut until a compute. It now holds the server's live `confirm_gate` (§4.9 step 1).
- **The sheet stayed stuck after `PRICING_CHANGED`.** Nothing read the product again until a page reload. It now reads on open and after any stale answer (§7).
- **A confirmed product kept «وزن افتراضي».** The whole confirmation never rewrote `flags_json`. It now drops the default-measure entries (§4.9 step 3), and a confirmed row's are never shown, so products confirmed before this change lose the chips too (`shownFlags`).
- **Found in review and fixed:** the product form's read after a statement laid the whole `dimensions` object back when the net weight had an unsaved edit, so the next save wrote the stated package back as NULL; it now merges `dimensions` field by field, keeps every other unsaved edit, never shows the spinner and survives a failed read (§7). A type weight lighter than the product's own net weight is no longer stated real (`below_net`, §4.9 step 0). The import guard's refusal is said in its own words. The statement shares compute's line-flag rule and the planner's basis rule.
- The confirmation route, its route class and its call list are unchanged. Only its body gains `real_measures`, and the by-id read gains `confirm_gate`. `confirm_gate` and `real_measures` join both copies of `FINANCIAL_FIELDS`, since they carry the type's default measures.
- Not built: confirming many products at once from «المنتجات التقديرية». Confirmation stays per product, and each product's statement is its own tick.

**Known lows left as documented** (pre-existing ones marked):
- (pre-existing) The public API's `combinations` (`GET /api/public/v1/products/:slug`, from a complete `price_levels.combo`) can list a pair the product does not sell; no live product has one.
- (pre-existing) In a race where the quote already carries the error, the add can show the cart door's English «Invalid selection: TRANSPORT_DISABLED» (code `VALIDATION`, which has no sentence).
- On a grid without relational rows past `ENGINE_MAX_SKUS`, a strict quote of a complete left-out cell naming an unpriced choice answers 'unpriced' (an API-only dead end on a shape no product has; the page reads `offered_selections`).
- The page's two lists repeat their `sellableSkus` calls on every `VARIANT_COMBINATION` detail request (§11).
- A line names the weaker of its two measures, so one real measure keeps both chips (§4.6).
- The display follows the latest compute: a measure removed from a package after it shows as default only from the next compute (§4.6).
- (pre-existing) While the type's CBM decides, an option whose box is its colour's or model's own package and whose weight is the owner's keeps «صندوق افتراضي», though §4.9 accepts it.
- A type priced from its CBM (`default_cbm`) cannot be stated real: no form and no package holds a CBM. Such a product still needs a real box in «الأبعاد والوزن», a compute and an apply, and its price can move; the sheet says so and opens each step (§4.9, §7).
- The statement writes the product's public package. Customers then see the type's values under «العبوة»; new order rows and the courier data carry them; and the type's suggestion median (`suggestTypeMeasures`) counts them as real. That is the owner's statement by design (row 292).
- The sheet's «تم» line does not stay on screen. The sheet closes when the confirmation lands (as before); after a statement the product form reads the product again in the background, and the banner then shows the product confirmed.
- A catalogue import's guard refusing the batch is said in `EST_IMPORT_RUNNING`'s words («استيراد الكتالوج يعمل الآن — أعد المحاولة بعده») only when the confirmation carries a statement. The plain confirmation is unchanged and still answers the import guard's raw 500 (pre-existing).
- «التحديث» can still offer an apply that changes nothing for the product but, like every apply, makes the options confirmed since estimates again, when a colour's or model's own package decides the measure above the product level; under the type's CBM this needs no product package measure (§7).
- The Refresh row shows the published estimate's and the refresh's price sources together, by design (§7).
- (pre-existing) `EST_LARGE_CHANGE_HELD` stays until the next compute after the hold ends (§7).
- (pre-existing) `POST /api/trade-in/target-quote` does not check the estimate label; «أكمل الشراء» then refuses with `PRICE_ESTIMATE_PREORDER_ONLY`, in the customer's language.
- (pre-existing) `refusalText` in `src/lib/refusalStrings.ts` looks a code up without an own-property check; no Worker code is named like an `Object.prototype` member.
- The store-page readers, none on a stored page: a copy whose regular price cannot be read is dropped before the copies are compared, so a plain copy (perhaps the sale price) decides alone, in `capture-store-offers.ts` and (pre-existing) in the one-page read, whose save then writes that price (§3.6). In `capture-store-offers.ts` the kept copy's other fields come from its own block, and on a page without variant ids, variants sharing one SKU code are treated as copies.
- (pre-existing) `capture-store-offers.ts` reads only a node's first offer and no lone Product beside a ProductGroup, where the one-page read reads both. It also prices an `AggregateOffer`'s first offer and a one-object `hasVariant`, which the one-page read skips, keys a variant by its `sku` before its offer's `?id=` (the one-page read the other way round), and reads no other product's block. So the two readers can see different copies and keys; no stored page has any of these shapes (§3.3).
- (pre-existing) A plate value that states only a generation is compared with the catalogue SKU's generation, not with a multi-SKU listing's title.
- (pre-existing) `ADDON_SKU` does not know 【选购】. The AMS 2 Pro upgrade-kit listing 904971839831 sells a power adapter and an AMS Hub as 【选购】 SKUs, so a one-SKU kit product stays `AMBIGUOUS` against it. Dropping them would also hide those two offers from the Power Adapter and AMS Hub products, so it is the owner's call.
- The pack rule's filament test is a proxy (`MATERIAL_TOKENS`, `SPOOL_WORDS`): a colour mix whose texts say only "filament" or 耗材 reads as one set.
- The category rule trusts the capture's category: a plate listing filed elsewhere is refused for plate products, which fails closed (the owner can still confirm by hand).
- Past 240 the import's default-selection check (`verifyD1`) follows the kept set, as under 240; a product with no option group (colours only) past 240 still overflows.

**Left for the owner.** `worker/lib/tradeInToday.ts` («سعر اليوم») still values a device from its lowest new price, an estimate included (282(h) names only trade-in targets). Price protection 5.2 and 6.2–6.3 still say an ordinary order's total is never edited in place, while 0140 lets an admin propose a higher total on a paid order. Row 281's regression leak stays a `todo` pin until 282(e) is ruled.

**Profit cap (2026-11-05, DECISIONS row 291; §4.11).** Built as the read-only map of the same day recommended, with these departures:
- The migration is `0222_estimate_profit_cap.sql`, not 0221: 0219 and 0221 are held by other unpushed work. `EXPECTED_MIGRATION_COUNT` is 213 counting this file alone on top of origin's 212. When 0219 and 0221 land, `EXPECTED_MIGRATION` stays `0222_estimate_profit_cap.sql` (still the newest file, `tests/schemaVersion.test.ts`) and `EXPECTED_MIGRATION_COUNT` becomes 215.
- A type on a database without 0222 carries no `profit_cap_pct` key at all (rather than `null`), so the editor can tell "no cap" from "not installed" and offers the field only where it can be saved.
- A capped rule the owner cleared keeps its SKUs off the cap: they fall to the product rule, which the estimator then keeps at T (a product rule capped for the other SKUs would cap them silently).
- The optional line marker (`EST_PROFIT_CAPPED`) was not added: a capped line is already visible as its lower price, and a new code would have needed registering as information on lines only. The owner's product form still draws only product and model minimum profits, so colour- and SKU-scope rules the cap writes are not shown there (§4.11, known consequences).
- No change to apply: compute swaps the final plan into the prepared estimate, so apply binds the final record (`p.plan.applied_json`) as it always did, and its firm-SKU handling is unchanged.
- The first evaluation prices the product with no cap (the cap's own scope rules back to inherit), not the plan as stored, as the map had it: a rule capped while its SKU cost under 1,000 IQD would otherwise close that SKU's route once its cost moved just past it, hide its R and block the product on every later compute.
- An owner's product rule takes the cap's own option, colour and SKU rules back to inherit. The brief's "an owner product rule means no profit writes" is read as no profit amount written: left in place, those rules (which the form does not draw) would keep overriding his product rule for good, and emptying the cap would not remove them.

**The ceiling and the dollar charm price (the owner's later rulings the same day; DECISIONS row 291, §4.11).** The flat cap above (min(T, P% × R), 0 < P ≤ 1000, a warning under 25%) was reworked to the owner's later rule before it reached origin; 0222 was edited in place (it had never been pushed). Departures from that brief:
- **The floor is a margin of one rounding step, not the smallest price above rp(R)** (review of 2026-11-05, major). The brief's floor cleared the route at the compute and let the next rate tick close it: FX-5 keeps T_sku in dollars, so a SKU kept only a few dozen dinars over its cost was held (`V2_ROUTE_BELOW_COST`) and sold at its old price, some under their new cost (1–4 of 60 cheap parts after CNY or USD moves). A price is admitted only when T_sku × U ≥ 250 IQD (one dinar where the price is at or under 1,000 IQD), so FX-5 follows every rise of R or U; the cost is one step on the SKUs it lifts (5.94 CNY: then $1.49 = 2,500, not $0.99 = 1,750; under the $5 threshold below, 1,750, not 1,500). "P 0 → the floor" is the lowest price whose margin holds; the property proves the margin and samples later rises.
- **Nothing goes up, ahead of the grid.** The brief's fallback is the lowest charm price above the floor. Where that is dearer than today's price while today's price itself clears the floor (no charm price between the two: an accessory just over $100, whose $5 step of 8,000 IQD is wider than its $4.50 × 1,600 = 7,200), today's price stays — T, no new rule — rather than rising: the brief's own top, "nothing ever goes up", wins over the grid, so a price exceeds today's only when today's own price would not clear the floor. Such a SKU keeps a dollar price off the grid.
- **No new rule when the dinar price is today's**, whether the ceiling binds or not: the dollar price then stays today's, not c. *Superseded the same day, after the live re-pricing* (the lead's ruling for the owner; §4.11 «today's dinar price shows c»): such a SKU now sells at today's very dinar price at c's own profit and shows c; T stays only where today's own figure already is c, or for a house price, and the planner takes these profits only on a product of at most 19 SKUs, its new plan and today's both exact within the wire. No dinar price moves at the R and U of the apply; between applies FX-5 can sell such a SKU one step from T's own price.
- **Charm prices from $5 up; the plain house price under it** (the lead's ruling for the owner the same day, replacing the sub-$0.49 rule). The grid was too coarse for the cheapest items: at 10% and 1,600 a cost of 784–1,334 IQD sold at $0.99 = 1,750 (+31% to +123%), one of 1,335–2,134 at $1.49 = 2,500. `CHARM_MIN_USD = 5`: a charm price is used only at $5 or more ($5.49 the lowest); when the ceiling, min(todayD, capD), is below $5 × U the SKU takes the highest house price (multiples of 250 IQD above 1,000, whole dinars at or under it) within it that keeps the margin, else the lowest that keeps it, T_sku = floor6((D − R) ÷ U), its dollar display D's own figure. The ruling's two sentences — charm prices only when the chosen price is at least $5 (c ≥ 5.00), the plain rule below a ceiling of $5 × U — leave open the ceilings from $5 × U to just under $5.49's dinar price (8,000–8,999 IQD at 1,600; 8,450–9,499 at 1,690), where the only charm prices within the ceiling are under $5: the plain rule decides there too (8,000 at $5.00 rather than $4.99; a ceiling of 8,750 at 8,750 rather than $4.99's 8,000), never a charm price of $5.49 above the ceiling; its dollar figure there is $5.00 to $5.79 at 1,600, off the grid, and where no house price within such a ceiling keeps the margin the lowest that does reaches 9,000–9,250 IQD at 1,600 ($5.63–$5.79; 9,500–9,750 at 1,690), still under the grid's lowest that keeps it ($5.99 = 9,750). Everything else is as it was: the margin, nothing goes up, T for today's price, no ceiling byte for byte. The sub-$0.49 rule (min(T, P%) lifted to the margin) is gone with it: under $5 the house price never rounds a dinar over the ceiling (696 IQD at 10%: 765, not 766).
- **The owner's differences and fixed prices** (review, minor): the engine adds a SKU's positive option and colour differences on top of R + T × U, so the choice counts them (T_sku = floor6(c − R ÷ U − Δ), the ceiling + Δ × U) and his gold colour sold at $3.99, on the grid, instead of $3.79 (under the $5 threshold, at the house price 6,000); a SKU at his own fixed dollar price keeps T. Both come from the first evaluation (`routeFiguresOf`).
- **No exact representation in 60 rows is no longer a block** (review, minor): one profit per group that adds the least, flagged `EST_CEILING_SHARED` (a new information code in `@levonis/contracts/priceEstimates`, its words in the three languages), then today's rule, flagged, unblocked; the reviewer's 62-SKU filament now prices on its colours. Only an owner's product rule with more than 60 ceiling rules to take back still blocks.
- **Under $5 a shared profit is the cheapest that keeps every margin, and no shared profit costs a SKU its margin** (review of the $5 threshold, minor; and the fix's own finding). The dearest of each group lifted cheap SKUs a whole 250 IQD step over their own house price (61 SKUs at 2,000–2,060: 59 at 2,750 against their own 2,500), and admitted any SKU at or above its own profit without looking at the price it reached: at 900–960 IQD 50 SKUs sold at 1,250 with 90 IQD of margin, which the next rise of the cost closes. Now a group whose SKUs all sell under $5 shares the cheapest of their profits when every one keeps its margin there (each at or under its own price), else the least that keeps each at or above its own; from $5 up the dearest, as before; and every SKU whose profit is not its own (nor T) must keep its margin at the price it resolves to. A SKU under its own profit is not flagged.
- **The Types hint carries no figure** (review, minor): the grid is named in words, with the shop's usual dinar prices that cheap items take instead and the safe margin, and the test holds the hint to the no-figure rule by name rather than through the TYPES group's exemption. `EST_CEILING_SHARED`'s words say «above their own ceiling price», not «above their dollar grid price», which a SKU under $5 does not have.
- **Every comparison is on the engine's own price at the planned profit**, `roundPriceIqd(R + T_sku × U)`, not on rp(c × U): the two are equal for any whole-dinar U (the property test's 1,600 and 1,690), and the first is what the engine publishes for any U.
- **The helpers live in `packages/pricing/src/charmPrice.ts`** (`charmTarget`, `CHARM_MIN_USD` and the grid walk); `estimateInputs.ts` no longer imports the contracts edge, so its `PURE_PACKAGE_IMPORTS` entry moved to `charmPrice.ts`.
- The workspace's `decimalText` gains `allowZero` for the ceiling alone; every other decimal field still refuses 0.
