-- ============================================================================
--  0098 — INVENTORY LOTS: THE SAME UNITS, AT THE COST THEY WERE REALLY BOUGHT AT
-- ============================================================================
-- «المخزون الحالي قد يحمل أكثر من تكلفة تاريخية، وكل عملية بيع تستهلك أقدم
--  دفعة تكلفة متاحة أولًا.»
--
-- NONDESTRUCTIVE. Six new tables, nine ADD COLUMNs, thirteen indexes, and one
-- guarded backfill. No table is rebuilt, no column is dropped, no existing row
-- is rewritten. `order_items` in particular is not touched at all — see PART 4.
--
-- ---------------------------------------------------------------------------
--  WHAT THIS IS NOT
-- ---------------------------------------------------------------------------
-- It is NOT a second inventory system. Levonis already has a good one:
-- `inventory_ledger` (0018, reshaped by 0020), `products.inventory_mode`
-- choosing exactly one authoritative stock rung, reserve/deduct/restore driven
-- off the ledger with a UNIQUE `idempotency_key`, and `planInventory()`
-- returning statements the caller appends to its OWN `db.batch` so an order and
-- its stock movement commit together or not at all.
--
-- Every requirement about holding, releasing, not overselling and not going
-- negative is already met by that code. What it cannot answer is
--
--     "these twenty units — what did each of them cost?"
--
-- because a single `cost_iqd` per product can hold exactly one answer, and the
-- moment a second shipment arrives at a different price that one answer is
-- wrong for half the shelf. This file adds the cost LAYERS. It adds no second
-- opinion about how many units there are: docs/INVENTORY-DECISIONS.md §7.
--
-- ---------------------------------------------------------------------------
--  THE IDENTITY IS THE LEDGER'S, NOT A NEW ONE
-- ---------------------------------------------------------------------------
-- `inventory_ledger` already names a stock row as the pair (scope, scope_id),
-- where scope is 'base' | 'option' | 'color' | 'variant' and scope_id is the
-- row id at that rung (empty string for 'base'). Lots use the SAME pair, which
-- is what makes the FIFO rule correct for free: a black spool cannot consume
-- white's older lot because white's lots are in a different queue. `product_id`
-- rides along for joins and for the deletion registry — never as the FIFO key.

-- ---------------------------------------------------------------------------
--  PART 1 — WHO WE BOUGHT FROM
-- ---------------------------------------------------------------------------
-- Deliberately four fields and not a procurement suite (§42). A supplier here
-- is a label on a purchase, so the owner can ask "what did the last Bambu
-- shipment cost" — not a party with terms, contacts and an account.

CREATE TABLE IF NOT EXISTS inventory_suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_inv_suppliers_active ON inventory_suppliers(active, name);

-- ---------------------------------------------------------------------------
--  PART 2 — المخزون القادم: GOODS BOUGHT, NOT YET SELLABLE
-- ---------------------------------------------------------------------------
-- An incoming record is ONE purchase of ONE inventory identity (§5). Not a
-- shipment holding four products — that is the mixed-shipment cost allocation
-- engine the owner explicitly rejected (§31). A real shipment carrying an H2D,
-- an A1 mini and filament is three incoming records, and the owner decides
-- outside this system what share of the freight belongs to each.
--
-- NULL VERSUS ZERO IS THE WHOLE POINT OF THIS TABLE'S NULLABILITY (§13).
-- `shipping_total_iqd` NULL means "not entered yet"; 0 means "genuinely free".
-- Nothing in the application may use truthiness on these columns, and receiving
-- refuses until each of the three components is STATED — a typed 0 is stated,
-- an empty box is not. There is deliberately no estimated/final duality (§12):
-- a field is either entered or it is not.
--
-- THE THREE COMPONENTS ARE THREE (§8): purchase, international shipping,
-- internal delivery to the warehouse. Not customs, not insurance, not bank
-- fees. A future reader looking for where to add a fourth: the answer is that
-- the owner ruled there is no fourth.
--
-- `purchase_total_iqd` IS NOT A COLUMN, and that is §7. It is always
-- qty_ordered x purchase_unit_iqd, and a stored copy is a number that can
-- disagree with its own factors.

CREATE TABLE IF NOT EXISTS incoming_inventory (
  id TEXT PRIMARY KEY,
  -- Nullable, and NOT `ON DELETE CASCADE`: a delisted product must not take the
  -- financial history of what it cost with it (§56). The deletion registry
  -- clears this pointer and keeps the row.
  product_id TEXT REFERENCES products(id),
  scope TEXT NOT NULL CHECK (scope IN ('base','option','color','variant')),
  scope_id TEXT NOT NULL DEFAULT '',

  qty_ordered INTEGER NOT NULL CHECK (qty_ordered > 0),
  -- Maintained by the receive operation, never typed. The CHECK is the
  -- last-resort guard behind the application's own: §33 forbids receiving more
  -- than was ordered, and a constraint says so in the database as well.
  qty_received INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),

  purchase_unit_iqd INTEGER NOT NULL CHECK (purchase_unit_iqd >= 0),
  shipping_total_iqd INTEGER CHECK (shipping_total_iqd IS NULL OR shipping_total_iqd >= 0),
  internal_delivery_total_iqd INTEGER
    CHECK (internal_delivery_total_iqd IS NULL OR internal_delivery_total_iqd >= 0),

  -- §43: the source currency is PRESERVED, never used for accounting. The
  -- authoritative inventory value is the IQD above. Bank and transfer fees are
  -- explicitly outside this cost model.
  source_currency TEXT NOT NULL DEFAULT 'IQD',
  source_unit_amount REAL,
  exchange_rate_used REAL,

  supplier_id TEXT REFERENCES inventory_suppliers(id),
  supplier_ref TEXT NOT NULL DEFAULT '',
  purchase_date TEXT,
  expected_at TEXT,
  tracking TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',

  -- §32: the MINIMAL operational lifecycle of a purchase. This is not a stock
  -- status: nothing here describes units on a shelf, and current stock keeps
  -- exactly the one state it has always had.
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','incoming','partial','received','cancelled')),

  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CHECK (qty_received <= qty_ordered)
);
CREATE INDEX IF NOT EXISTS idx_incoming_status ON incoming_inventory(status, expected_at);
CREATE INDEX IF NOT EXISTS idx_incoming_identity ON incoming_inventory(product_id, scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_incoming_supplier ON incoming_inventory(supplier_id, created_at);

-- ---------------------------------------------------------------------------
--  PART 3 — THE LOT: AN IMMUTABLE LAYER OF COST
-- ---------------------------------------------------------------------------
-- One row per physical receipt (§9). Ten units received today at 560,000 are
-- one lot; the ten received in August at 450,000 are another, and NEITHER
-- overwrites the other. That is the core business rule (§1), and it is why
-- there is no `products.cost_iqd = latestCost` anywhere in this feature.
--
-- `unit_cost_iqd` IS NULLABLE, AND ONLY FOR OPENING LOTS. §21: where the
-- current resolver cannot answer what existing stock cost, the migration does
-- not invent a number. An unpriced lot is still a real lot — it holds units and
-- it is consumed in FIFO order — and its allocations carry a NULL COGS that
-- finance reports as unknown rather than as zero.
--
-- THE THREE SHARES ARE STORED BESIDE THE DERIVED UNIT COST on purpose. The
-- per-unit figure is what FIFO consumes; the components are what makes it
-- CHECKABLE afterwards, so "why is this lot 560,000" has an answer that does
-- not require re-deriving it from a purchase that may since have been received
-- in two parts.

CREATE TABLE IF NOT EXISTS inventory_lots (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id),
  scope TEXT NOT NULL CHECK (scope IN ('base','option','color','variant')),
  scope_id TEXT NOT NULL DEFAULT '',

  qty_received INTEGER NOT NULL CHECK (qty_received > 0),
  -- Decremented by FIFO consumption, incremented by a restore. Never negative:
  -- §40, enforced here as well as in the guard that writes it.
  qty_remaining INTEGER NOT NULL CHECK (qty_remaining >= 0),

  unit_cost_iqd INTEGER CHECK (unit_cost_iqd IS NULL OR unit_cost_iqd >= 0),
  purchase_unit_iqd INTEGER CHECK (purchase_unit_iqd IS NULL OR purchase_unit_iqd >= 0),
  shipping_share_iqd INTEGER CHECK (shipping_share_iqd IS NULL OR shipping_share_iqd >= 0),
  internal_share_iqd INTEGER CHECK (internal_share_iqd IS NULL OR internal_share_iqd >= 0),
  total_cost_iqd INTEGER CHECK (total_cost_iqd IS NULL OR total_cost_iqd >= 0),

  -- 'received'         a real purchase came in through the receive flow
  -- 'opening'          existing stock at migration time, cost from the resolver
  -- 'opening_unpriced' existing stock at migration time, cost genuinely unknown
  cost_basis TEXT NOT NULL CHECK (cost_basis IN ('received','opening','opening_unpriced')),

  incoming_id TEXT REFERENCES incoming_inventory(id),
  supplier_id TEXT REFERENCES inventory_suppliers(id),
  purchase_date TEXT,
  -- THE FIFO SORT KEY. Not created_at: a lot received today for a purchase made
  -- in June is younger than one received in July, and "first in" means when it
  -- entered the shelf.
  received_at TEXT NOT NULL,

  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CHECK (qty_remaining <= qty_received)
);

-- THE FIFO QUEUE, AND THE ONLY INDEX ON THE HOT PATH. Partial on
-- `qty_remaining > 0` because an exhausted lot is never a candidate and a shop
-- that has traded for two years is mostly exhausted lots. `id` is the tiebreak
-- so two lots received in the same millisecond still have ONE deterministic
-- order — without it, two replicas of the same consumption could disagree about
-- which lot went first and produce two different COGS for one sale.
CREATE INDEX IF NOT EXISTS idx_lots_fifo
  ON inventory_lots(scope, scope_id, received_at, id)
  WHERE qty_remaining > 0;
CREATE INDEX IF NOT EXISTS idx_lots_product ON inventory_lots(product_id, received_at);
CREATE INDEX IF NOT EXISTS idx_lots_incoming ON inventory_lots(incoming_id);
-- Aging (§46) reads every lot still holding units, oldest first.
CREATE INDEX IF NOT EXISTS idx_lots_aging ON inventory_lots(received_at) WHERE qty_remaining > 0;

-- ---------------------------------------------------------------------------
--  PART 3b — EACH PHYSICAL RECEIPT, RECORDED ONCE
-- ---------------------------------------------------------------------------
-- §17: a double-tapped Receive must never double the inventory. The UNIQUE
-- `idempotency_key` is the same mechanism `inventory_ledger` already uses, and
-- it is the database — not the browser, not a flag — that refuses the second
-- attempt: the duplicate INSERT aborts the whole D1 batch, so the lot, the
-- ledger row and the counter increase all roll back together.

CREATE TABLE IF NOT EXISTS incoming_inventory_receipts (
  id TEXT PRIMARY KEY,
  incoming_id TEXT NOT NULL REFERENCES incoming_inventory(id),
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_incoming ON incoming_inventory_receipts(incoming_id, created_at);

-- ---------------------------------------------------------------------------
--  PART 4 — WHICH LOTS A SALE ACTUALLY ATE
-- ---------------------------------------------------------------------------
-- §23/§24: an order for 7 against lots of 3 and 10 is 3 + 4, and that exact
-- split is preserved for ever. One order item therefore has SEVERAL rows here.
--
-- WHY `order_items` IS NOT TOUCHED BY THIS MIGRATION. 0095 declared
-- `cost_basis TEXT NOT NULL CHECK (cost_basis IN ('snapshot','unpriced',
-- 'composed','unrecorded'))`. SQLite cannot widen a CHECK without rebuilding
-- the table, and `order_items` is live history with real customers' orders in
-- it. So FIFO COGS is DERIVED from the rows below rather than stored back —
-- which §25 explicitly permits ("or deriving it from immutable lot
-- allocations") and which is the better half of that choice: a derived total
-- cannot drift from the allocations it is derived from.
--
-- `unit_cost_iqd` AND `cogs_iqd` ARE COPIED HERE, NOT JOINED FROM THE LOT.
-- That is what makes §26 true. A lot is immutable, but a correction workflow
-- may one day restate one; January's reported profit must not move when it
-- does. The allocation records what the unit cost WAS when the sale consumed
-- it, exactly as `order_items.pricing_snapshot` records what the price was.

CREATE TABLE IF NOT EXISTS order_item_inventory_allocations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  scope TEXT NOT NULL CHECK (scope IN ('base','option','color','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL CHECK (qty > 0),
  -- NULL when the lot it consumed had no known cost. Finance reports unknown.
  unit_cost_iqd INTEGER CHECK (unit_cost_iqd IS NULL OR unit_cost_iqd >= 0),
  cogs_iqd INTEGER CHECK (cogs_iqd IS NULL OR cogs_iqd >= 0),
  -- Same shape as inventory_ledger's: one allocation per (operation, item, lot).
  idempotency_key TEXT NOT NULL UNIQUE,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_alloc_item ON order_item_inventory_allocations(order_item_id);
CREATE INDEX IF NOT EXISTS idx_alloc_order ON order_item_inventory_allocations(order_id);
CREATE INDEX IF NOT EXISTS idx_alloc_lot ON order_item_inventory_allocations(lot_id);

-- ---------------------------------------------------------------------------
--  PART 5 — REORDER ADVICE
-- ---------------------------------------------------------------------------
-- §47/§48: ADMIN reorder planning, which is a different thing from the
-- customer's «خبرني لما يرجع» restock alert (0092) and must not be mixed with
-- it. This is advisory only; nothing here ever creates a purchase by itself.
-- Configuration with no financial meaning, so it is OWNED by the product and
-- goes when the product does.

CREATE TABLE IF NOT EXISTS inventory_reorder_settings (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('base','option','color','variant')),
  scope_id TEXT NOT NULL DEFAULT '',
  reorder_point INTEGER CHECK (reorder_point IS NULL OR reorder_point >= 0),
  lead_time_days INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (product_id, scope, scope_id)
);

-- ---------------------------------------------------------------------------
--  PART 6 — THE PHYSICAL FACTS: الأبعاد والوزن
-- ---------------------------------------------------------------------------
-- §28/§29: a printer measuring 385x410x430 mm ships in a carton measuring
-- 500x550x600 mm. They are two different datasets and confusing them produces
-- a freight quote that is wrong by half.
--
-- REAL COLUMNS, NOT SPEC FIELDS, and §75 is the reason. `products.spec_fields`
-- is a JSON object keyed by whatever the section's template declares, which is
-- right for "nozzle diameter" and wrong for a value the SYSTEM must compute
-- with: a packaged volume, a freight estimate and a "packaged weight is below
-- net weight" warning all need a number the database can compare, not a string
-- a template happened to name.
--
-- ONE CANONICAL UNIT EACH: grams and millimetres, integers. The UI shows kg and
-- cm where that reads better, but nothing is persisted in a unit that has to be
-- guessed from context. There is no `package_volume` column: it is
-- length x width x height and a stored copy is a third number that can disagree
-- with the two it came from (§30).

ALTER TABLE products ADD COLUMN net_weight_g INTEGER;
ALTER TABLE products ADD COLUMN width_mm INTEGER;
ALTER TABLE products ADD COLUMN depth_mm INTEGER;
ALTER TABLE products ADD COLUMN height_mm INTEGER;
ALTER TABLE products ADD COLUMN package_weight_g INTEGER;
ALTER TABLE products ADD COLUMN package_width_mm INTEGER;
ALTER TABLE products ADD COLUMN package_depth_mm INTEGER;
ALTER TABLE products ADD COLUMN package_height_mm INTEGER;

-- ---------------------------------------------------------------------------
--  PART 7 — THE SERIAL CHAIN, COMPLETED BY ONE COLUMN
-- ---------------------------------------------------------------------------
-- §41/§71 asks to trace supplier -> lot -> serial -> order -> customer ->
-- warranty. Four of those five links already exist: `order_item_units`
-- (0003:112) is one row per delivered unit carrying the warranty dates, and
-- `device_serials` (0003:132) holds the serial against it. Building a second
-- serial system beside them is exactly what §41 forbids, so this adds the ONE
-- link that is missing — which lot the unit came off.
--
-- Nullable for ever: serials are optional by design, and nothing forces one
-- onto a spool of filament.

ALTER TABLE order_item_units ADD COLUMN inventory_lot_id TEXT REFERENCES inventory_lots(id);

-- ---------------------------------------------------------------------------
--  PART 8 — THE BACKFILL: NOT ONE EXISTING UNIT MAY DISAPPEAR
-- ---------------------------------------------------------------------------
-- §21/§79. Every stock identity that currently holds units gets ONE opening lot
-- for exactly that quantity, so that the invariant the whole feature rests on
--
--     SUM(lots.qty_remaining) per identity  ===  that identity's stock column
--
-- holds from the first second this schema exists, rather than from whenever
-- somebody remembers to run a repair.
--
-- THE COST COMES FROM THE LADDER THAT ALREADY EXISTS, not a new one. Migration
-- 0096's `trg_mystery_allocation_cost` writes it out for the mystery draw:
-- `products.product_cost_iqd` is rung 0, an option value's own `cost_iqd` wins
-- over it, and `cost_adjust_iqd` adjusts rung 0 when there is no fixed cost.
-- The same precedence is used below. Where no rung answers, `unit_cost_iqd`
-- stays NULL and the basis is 'opening_unpriced' — §21: "do NOT invent one".
--
-- EVERY INSERT IS GUARDED BY `NOT EXISTS`, so re-running this file is a no-op
-- rather than a doubling. That is also what lets scripts/migrate-check.mjs
-- re-run it and prove the property instead of assuming it.
--
-- `received_at` is the product's creation time and not `now`: these units have
-- been on the shelf for as long as the shop has had them, and stamping them all
-- with the migration date would make every one of them look one day old on the
-- aging report (§46) — a report that opens by lying is a report nobody uses.
-- COALESCE to now only where a row somehow carries no timestamp at all.

-- ---- BASE: the product's own counter -------------------------------------
INSERT INTO inventory_lots (
  id, product_id, scope, scope_id, qty_received, qty_remaining,
  unit_cost_iqd, purchase_unit_iqd, total_cost_iqd, cost_basis, received_at, created_at
)
SELECT
  'ilot_open_base_' || p.id,
  p.id, 'base', '', p.stock, p.stock,
  p.product_cost_iqd,
  p.product_cost_iqd,
  CASE WHEN p.product_cost_iqd IS NULL THEN NULL ELSE p.product_cost_iqd * p.stock END,
  CASE WHEN p.product_cost_iqd IS NULL THEN 'opening_unpriced' ELSE 'opening' END,
  COALESCE(p.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM products p
WHERE p.inventory_mode = 'BASE'
  AND p.stock IS NOT NULL AND p.stock > 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_lots l
     WHERE l.product_id = p.id AND l.scope = 'base' AND l.scope_id = ''
  );

-- ---- OPTION: each tracked option value ------------------------------------
INSERT INTO inventory_lots (
  id, product_id, scope, scope_id, qty_received, qty_remaining,
  unit_cost_iqd, purchase_unit_iqd, total_cost_iqd, cost_basis, received_at, created_at
)
SELECT
  'ilot_open_opt_' || v.id,
  v.product_id, 'option', v.id, v.stock, v.stock,
  COALESCE(v.cost_iqd, MAX(0, p.product_cost_iqd + v.cost_adjust_iqd), p.product_cost_iqd),
  COALESCE(v.cost_iqd, MAX(0, p.product_cost_iqd + v.cost_adjust_iqd), p.product_cost_iqd),
  CASE
    WHEN COALESCE(v.cost_iqd, MAX(0, p.product_cost_iqd + v.cost_adjust_iqd), p.product_cost_iqd) IS NULL
      THEN NULL
    ELSE COALESCE(v.cost_iqd, MAX(0, p.product_cost_iqd + v.cost_adjust_iqd), p.product_cost_iqd) * v.stock
  END,
  CASE
    WHEN COALESCE(v.cost_iqd, MAX(0, p.product_cost_iqd + v.cost_adjust_iqd), p.product_cost_iqd) IS NULL
      THEN 'opening_unpriced' ELSE 'opening'
  END,
  COALESCE(v.created_at, p.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM product_option_values v
JOIN products p ON p.id = v.product_id
WHERE p.inventory_mode = 'OPTION'
  AND v.stock IS NOT NULL AND v.stock > 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_lots l
     WHERE l.scope = 'option' AND l.scope_id = v.id
  );

-- ---- COLOR: each tracked colour -------------------------------------------
INSERT INTO inventory_lots (
  id, product_id, scope, scope_id, qty_received, qty_remaining,
  unit_cost_iqd, purchase_unit_iqd, total_cost_iqd, cost_basis, received_at, created_at
)
SELECT
  'ilot_open_col_' || c.id,
  c.product_id, 'color', c.id, c.stock, c.stock,
  COALESCE(c.cost_iqd, MAX(0, p.product_cost_iqd + c.cost_adjust_iqd), p.product_cost_iqd),
  COALESCE(c.cost_iqd, MAX(0, p.product_cost_iqd + c.cost_adjust_iqd), p.product_cost_iqd),
  CASE
    WHEN COALESCE(c.cost_iqd, MAX(0, p.product_cost_iqd + c.cost_adjust_iqd), p.product_cost_iqd) IS NULL
      THEN NULL
    ELSE COALESCE(c.cost_iqd, MAX(0, p.product_cost_iqd + c.cost_adjust_iqd), p.product_cost_iqd) * c.stock
  END,
  CASE
    WHEN COALESCE(c.cost_iqd, MAX(0, p.product_cost_iqd + c.cost_adjust_iqd), p.product_cost_iqd) IS NULL
      THEN 'opening_unpriced' ELSE 'opening'
  END,
  COALESCE(c.created_at, p.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM product_colors c
JOIN products p ON p.id = c.product_id
WHERE p.inventory_mode = 'COLOR'
  AND c.stock IS NOT NULL AND c.stock > 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_lots l
     WHERE l.scope = 'color' AND l.scope_id = c.id
  );

-- ---- VARIANT_COMBINATION: each modelled combination -----------------------
INSERT INTO inventory_lots (
  id, product_id, scope, scope_id, qty_received, qty_remaining,
  unit_cost_iqd, purchase_unit_iqd, total_cost_iqd, cost_basis, received_at, created_at
)
SELECT
  'ilot_open_var_' || pv.id,
  pv.product_id, 'variant', pv.id, pv.stock, pv.stock,
  COALESCE(pv.cost_iqd, p.product_cost_iqd),
  COALESCE(pv.cost_iqd, p.product_cost_iqd),
  CASE
    WHEN COALESCE(pv.cost_iqd, p.product_cost_iqd) IS NULL THEN NULL
    ELSE COALESCE(pv.cost_iqd, p.product_cost_iqd) * pv.stock
  END,
  CASE WHEN COALESCE(pv.cost_iqd, p.product_cost_iqd) IS NULL THEN 'opening_unpriced' ELSE 'opening' END,
  COALESCE(pv.created_at, p.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
WHERE p.inventory_mode = 'VARIANT_COMBINATION'
  AND pv.stock IS NOT NULL AND pv.stock > 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_lots l
     WHERE l.scope = 'variant' AND l.scope_id = pv.id
  );
