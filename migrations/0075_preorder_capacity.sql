-- ============================================================================
--  0075 — A PRE-ORDER MAY HAVE A CAPACITY. IT IS NEVER THE MODEL'S STOCK.
-- ============================================================================
-- THE DEFECT THIS FIXES, AND WHOSE DECISION IT IS.
--
-- 0073 put the order type in its own table and then REFUSED to give the cell a
-- counter, reasoning that "a pre-order has no stock by definition". That is
-- true of a shelf and false of a shop: the owner buys a fixed number of units
-- from a supplier, and a pre-order beyond that number is a promise nobody can
-- keep. The owner is overriding 0073 in writing — a pre-order needs an
-- OPTIONAL independent capacity, and each transport may hold its own quota —
-- and the comment in 0073 that states the old rule is rewritten in the same
-- change, because a comment that lies about the data is how defects ship here.
--
-- THE SHAPE THIS RESTORES. One counter per actual selection, and the ORDER
-- TYPE alone decides which counter a line consumes:
--
--   direct_sale  ->  the row products.inventory_mode already selects
--                    (products / product_option_values / product_colors /
--                    product_variants). NOT DUPLICATED HERE. `options.N.direct
--                    .stock` in the admin template is a documented ALIAS onto
--                    product_option_values.stock, not a second column: two
--                    columns for one physical shelf is exactly the fork 0073
--                    warned about, and the owner's rule is "استخدم مصدر مخزون
--                    واحد لكل اختيار فعلي".
--   pre_order    ->  the capacity added below, and NEVER the model's stock.
--
-- THE SHARED-VERSUS-INDEPENDENT RULE, which the owner asked to be written down:
--
--   product_option_transports.capacity IS NULL  the route draws on the
--       fulfilment cell's SHARED pool. Selling one unit by air leaves one
--       fewer for sea and for land, because there is one pile of units and
--       three ways to move it.
--   product_option_transports.capacity = N      the route holds its OWN N,
--       independent of the pool and of the other two routes.
--   A route with its own quota does NOT also consume the shared pool. One
--       counter per sale, never two.
--   NOTHING HERE COPIES A QUANTITY ONTO THE THREE ROUTES. "لا تكرر نفس الكمية
--       تلقائيًا على الطرق الثلاث." Three routes carrying N each is 3N units
--       sold from a supply of N.
--
-- CAPACITY ON A direct_sale CELL IS MEANINGLESS, and is refused by the WRITERS
-- (worker/lib/optionFulfillment.ts `parseFulfillmentPayload`, refusal code
-- CAPACITY_ON_DIRECT), not by a CHECK here. A CHECK would also reject the
-- legacy rows an older Worker may still write during a rolling deploy, and the
-- rule is a payload rule: the direct-sale number is the model's stock, and the
-- admin form must be told which field to use rather than handed a constraint
-- error. A direct cell that somehow carries a capacity is IGNORED by the
-- resolver — it never reaches a counter.
--
-- WHAT THIS DOES TO EXISTING DATA, AND WHY IT CANNOT CHANGE A PRICE OR LOSE A
-- RESERVATION.
--
--   Every new column arrives NULL (capacity) or 0 (capacity_reserved). NULL
--   means UNTRACKED, which is precisely how pre-orders behave today: unlimited,
--   nothing reserved, always sellable. So a catalogue that has never heard of
--   capacity behaves after this migration exactly as it behaved before it.
--
--   THE MODEL STOCK IS NOT COPIED INTO capacity, deliberately. Copying it would
--   put one physical quantity into two counters and let one unit be sold twice
--   — once as a direct sale off the shelf and once as a pre-order against the
--   same number.
--
--   Not one price column is read or written by this file, and no arithmetic is
--   performed anywhere in it. `stock`, `stock_reserved` and `reserved` are
--   never touched, so every live reservation still points at the units it
--   holds. The ledger rebuild copies every row VERBATIM — same ids, same keys,
--   same timestamps — so `inventory_ledger.idempotency_key`, which is what
--   makes a replayed release a no-op, keeps refusing exactly the keys it
--   refused before.
-- ============================================================================

-- --------------------------------------------------------- THE SHARED POOL
-- NULL = untracked: this cell claims no limit, reserves nothing and is always
-- sellable. 0 = tracked and exhausted: no pre-order may be taken right now.
-- The two are NOT the same thing and nothing in the resolver may conflate
-- them — `COALESCE(capacity, 0)` anywhere would turn every untracked
-- pre-order in the catalogue into a sold-out one.
ALTER TABLE product_option_fulfillment
  ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0);
-- Units HELD for orders that exist but are not yet confirmed. It moves with
-- exactly the same five verbs as `stock_reserved` (reserve / release / deduct /
-- restore / adjust), through the same planInventory guards, because a capacity
-- row is a stock row with a different name and a second engine for it would be
-- a second place to be wrong.
ALTER TABLE product_option_fulfillment
  ADD COLUMN capacity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (capacity_reserved >= 0);

-- ------------------------------------------------------ THE PER-ROUTE QUOTA
-- NULL = this route draws on the cell's shared pool above (the common case,
-- and the value every existing row gets). A number = this route is independent.
ALTER TABLE product_option_transports
  ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0);
ALTER TABLE product_option_transports
  ADD COLUMN capacity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (capacity_reserved >= 0);

-- The admin's "what is running out" reads, and the only predicate that is not
-- already served: the cell and transport lookups a sale performs go through
-- `idx_option_fulfillment_cell` and `idx_option_transport_cell` (0073), which
-- are the identity of the row. These two are PARTIAL on purpose — a catalogue
-- where almost nothing tracks capacity indexes almost nothing.
CREATE INDEX IF NOT EXISTS idx_option_fulfillment_capacity
  ON product_option_fulfillment(product_id, fulfillment_type) WHERE capacity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_option_transport_capacity
  ON product_option_transports(product_id, method) WHERE capacity IS NOT NULL;

-- ============================================================================
--  THE LEDGER LEARNS TWO SCOPES — the 0020 rebuild, again, for the same reason
-- ============================================================================
-- SQLite cannot widen a CHECK in place, and 0020 already established the safe
-- pattern for this exact table: create `_new`, copy verbatim, drop, rename,
-- recreate the indexes. It is followed here without improvisation.
--
-- WHY THE SCOPES BELONG IN *THIS* TABLE rather than a capacity journal of their
-- own: a pre-order unit is a unit. "Who took the last one, when, and under
-- which order" has one answer in this shop, and splitting the audit trail in
-- two would mean reading two tables to get it and reconciling them when they
-- disagree. The 0073 comment named forking the ledger as the cost of a fifth
-- counter; widening it is what removes that cost.
--
--   'preorder'            scope_id = product_option_fulfillment.id — the
--                         shared pool of one (model x pre-order) cell.
--   'preorder_transport'  scope_id = product_option_transports.id — one route
--                         that holds its own quota.
--
-- 'adjust' stays in the kind list for the same reason 0020 kept it: rows
-- written before it existed must stay readable. Nothing new writes it.
CREATE TABLE inventory_ledger_new (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN
    ('base','option','color','variant','preorder','preorder_transport')),
  scope_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN
    ('reserve','release','deduct','restore','adjust','adjust_in','adjust_out')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  order_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO inventory_ledger_new
  (id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key, actor_user_id, reason, created_at)
  SELECT id, product_id, scope, scope_id, kind, qty, order_id, idempotency_key, actor_user_id, reason, created_at
    FROM inventory_ledger;
DROP TABLE inventory_ledger;
ALTER TABLE inventory_ledger_new RENAME TO inventory_ledger;
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_product ON inventory_ledger(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_order ON inventory_ledger(order_id);
-- NEW, and needed by the new scopes only: a capacity row is identified by its
-- scope_id (a fulfilment or transport row id), and `product_id` does not
-- discriminate between the several cells one product carries. Without this,
-- "what has this cell's quota done" scans the whole journal.
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_scope ON inventory_ledger(scope, scope_id);
