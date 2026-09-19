-- ============================================================================
--  0096 — THE GIFT FILAMENT HAS A REAL COST, AND IT IS CAPTURED AT THE DRAW
-- ============================================================================
-- ADDITIVE. One CREATE TRIGGER and one CREATE INDEX. No ADD COLUMN, no new
-- table, no backfill, no row of history touched. The columns it writes are the
-- ones migration 0095 already added to `order_items`.
--
-- THE OWNER'S CORRECTION, VERBATIM:
--
--   «عندما يشتري المستخدم الفيلمنت الهدية فإن النظام سوف يسحب مخزونا من منتج
--    فعلي ويعتبر كمُباع، لأنه في عملية الدفع يكون دفعا مقدما غير قابل للإلغاء
--    … المخزون يؤخذ من البيع المباشر أو الطلب المسبق ويصبح كمباع واللون والخيار
--    يسحب، يعني له تكلفة»
--
-- ---------------------------------------------------------------------------
--  WHAT THIS OVERRULES, SAID OUT LOUD
-- ---------------------------------------------------------------------------
-- 0095 PART 3 wrote: "A MYSTERY-BOX SPOOL row is left 'unrecorded' on purpose
-- … revenue from mystery boxes currently has NO cost basis at all … Closing
-- this needs a cost on the candidate record, which is another track's file."
--
-- The owner has now ruled that the draw is a REAL stock movement: a specific
-- product, a specific option and a specific colour leave inventory and are
-- counted as sold, because the mystery payment is a non-cancellable prepayment.
-- So the cost is not unknowable — it was merely never asked for. 0095's
-- sentence stands as the record of what was true before this file; it is no
-- longer true after it.
--
-- WHAT DOES NOT CHANGE: `worker/lib/mysteryDraw.ts`'s `MysteryCandidate` still
-- carries no cost, `worker/routes/orders.ts` still binds the spool row's
-- `product_id` to NULL and its `pricing_snapshot` to NULL, and the draw's
-- identity still lives only in `mystery_allocations`. Not one line of the draw
-- path is edited by this feature. The cost is captured by the DATABASE, at the
-- instant the allocation row lands, inside the checkout's own batch.
--
-- ---------------------------------------------------------------------------
--  WHY A TRIGGER, AND WHY NOT A JOIN AT READ TIME
-- ---------------------------------------------------------------------------
-- The alternative — have the dashboard resolve the drawn product's cost when
-- the report is read — is the exact defect docs/FINANCE-DECISIONS.md §"cost is
-- captured at the sale" exists to abolish:
--
--   «تغيير سعر التكلفة للمنتج لاحقًا — المنتجات القديمة التي بيعت لا تتأثر،
--    فقط المنتجات التي سوف تُباع بالتكلفة الجديدة»
--
-- A read-time join means one edit to a filament's supplier price silently
-- rewrites the reported profit of every month in which that filament was ever
-- drawn. A history that moves behind the owner cannot be reconciled against a
-- cash count, a printed report or a decision already taken.
--
-- So the cost is FROZEN, and it is frozen at the only instant that is both the
-- draw and the sale: the INSERT into `mystery_allocations`, which
-- `worker/routes/orders.ts` pushes into the same `db.batch` as the
-- `order_items` INSERT it belongs to, one statement later. A trigger on that
-- INSERT runs inside that transaction — so the cost either lands with the
-- order or the order does not exist. There is no second batch, no post-response
-- write and no window in which a paid mystery line has no cost basis.
--
-- `trg_offer_redemption_limits` (0065) already establishes that a rule which
-- must hold inside the checkout's own transaction belongs in a trigger here,
-- and `trg_orders_mark_cancelled` (0081) already establishes the AFTER-INSERT
-- trigger that UPDATEs a column of a row the same transaction wrote.
--
-- ---------------------------------------------------------------------------
--  WHY THE COST GOES ON `order_items` AND NOT ON `mystery_allocations`
-- ---------------------------------------------------------------------------
-- This was the choice with the most ways to be wrong, so here is the argument.
--
-- 1. THE SECRET. A cost is a fingerprint: knowing a spool cost 9,000 د.ع when
--    the pool holds one 9,000 filament identifies the pick before the reveal.
--    A NEW column on a NEW table would need its own redaction rule in every
--    reader that ever learns to join it — and "remember to strip it" is the
--    failure mode 0061 already refused when it put the draw secret in
--    `mystery_offer_secrets` rather than on `mystery_offers`.
--
--    `order_items.cost_iqd` needs NO new rule, because it already carries the
--    cost of every ordinary line sold since 0095 and is already audited safe.
--    worker/routes/orders.ts states the audit beside the bind: `orderPublic`
--    builds each item object from an explicit field list, the invoice, the
--    delivery and warranty events, the returns screens and the stage sweep all
--    name their columns one by one, and the only two `SELECT *`-shaped readers
--    are `ORDER_ITEMS_SELECT` (whose rows go through `orderPublic`) and the
--    merchant-store endpoint (filtered to `orders.merchant_id`, which a
--    LEVONIS checkout never writes). worker/lib/adminScope.ts §11 already hides
--    every cost from an assistant admin on the same column.
--
--    So this feature creates NO new path by which a cost can reach a customer,
--    and therefore no new path by which the pick can be inferred. If
--    `order_items.cost_iqd` ever leaked, the shop's entire cost book would
--    already be public and a mystery pick would be the least of it.
--
-- 2. RETENTION AND DELETION ALREADY WORK. `order_items` is in
--    worker/lib/orderDeletion.ts's `ORDER_OWNED_TABLES`, whose own comment says
--    "D1 does not guarantee that foreign-key cascades are enabled, so every
--    owned row is removed explicitly". A new table would not be in that list,
--    and a hard-deleted cancelled order would leave its spool costs behind.
--
-- 3. THE DASHBOARD ALREADY KNOWS HOW TO READ IT. `costValueSql` /
--    `costConfidenceSql` (worker/lib/financeLedger.ts) are THE cost rule for
--    this codebase, and a 'snapshot' basis on the spool row makes the whole
--    existing machinery — COGS, the bundle-parent roll-up in
--    `worker/lib/financeReport.ts`'s `KIDS_SQL`, the estimate labelling —
--    produce the right answer with no second copy of the rule anywhere.
--
-- ---------------------------------------------------------------------------
--  WHICH RUNGS THIS WALKS, AND THE ONE IT CANNOT
-- ---------------------------------------------------------------------------
-- `pick('cost_iqd', …)` in packages/pricing/src/pricing.ts walks
-- base -> option -> fulfilment -> transport -> colour, where a rung with a
-- FIXED `cost_iqd` REPLACES the value beneath it and a rung with only a
-- `cost_adjust_iqd` MOVES it (clamped at zero). The four UPDATEs below are that
-- same walk, in that same order, over the facts a `mystery_allocations` row
-- actually names: `product_id`, `option_value_ids`, `sale_mode` and `color_id`.
--
-- THE TRANSPORT RUNG IS NOT WALKED, and this is a narrowing, not an oversight:
-- an allocation records WHICH SALE MODE it was drawn under but never WHICH
-- ROUTE, because a mystery line's route is a property of the offer's own cart
-- line and not of the pick. A pre-order pool whose landed cost lives only on a
-- `product_option_transports` row therefore resolves to the cost beneath that
-- rung. That is an under-statement of cost — the conservative direction for a
-- profit figure — and it is stated here rather than discovered later.
--
-- THIS IS NOT A SECOND DERIVATION OF A COST THE RESOLVER ALREADY PRODUCED,
-- which is what 0095 forbids. For a mystery spool the resolver produces NO
-- cost at all: `loadCandidates` carries no cost field, and the spool line is
-- priced at zero because the money is on the parent. There is exactly one
-- derivation of this number, it happens once, and it happens at the sale.
--
-- ---------------------------------------------------------------------------
--  THE FAILURE MODES THIS TRIGGER IS WRITTEN NOT TO HAVE
-- ---------------------------------------------------------------------------
-- A trigger inside the checkout batch can abort a purchase. This one cannot:
--
--   * No RAISE, no CHECK, no division. Every arm is a COALESCE over scalar
--     subqueries, so the worst outcome of a wrong join is a NULL, which is
--     recorded as 'unpriced' — "we looked and found no cost" — and reported as
--     unknown rather than as free goods.
--   * `json_valid(...)` guards every `json_each`. 0022 already records that
--     `json_each` on a non-JSON value RAISES "malformed JSON"; unguarded, one
--     malformed `option_value_ids` would abort a customer's whole order.
--   * `MAX(0, …)` mirrors the resolver's own clamp, so an adjustment larger
--     than the cost beneath it can never write a negative COGS.
--   * Every arm is fenced on `cost_basis = 'unrecorded'`, so the trigger can
--     only ever FILL a row nothing else costed. It never overwrites a snapshot
--     the checkout wrote, and a second allocation against one `order_items`
--     row (a shape the checkout does not produce — it writes one row per
--     spool) is inert rather than additive. A cost can be written once.
--   * If the `order_items` row is somehow absent, all four UPDATEs match zero
--     rows and the insert proceeds. Nothing depends on the trigger having run.
--
-- ---------------------------------------------------------------------------
--  THE DEPLOY WINDOW, BOTH WAYS
-- ---------------------------------------------------------------------------
-- A Worker can be live before its migrations have run, and after them.
--
--   DB BEHIND THE WORKER (no trigger yet): a spool row stays 'unrecorded',
--   exactly as every mystery sale before today, and the dashboard reports it
--   as unknown. No route reads a column this file adds, because it adds none.
--
--   DB AHEAD OF THE WORKER (trigger present, old code): the trigger fills two
--   columns the old code does not read. Nothing changes for it.
--
-- So this file needs no `SchemaFacts` flag and
-- worker/lib/financeReport.ts gained none: the only table it newly joins is
-- `mystery_allocations`, which has existed since migration 0061.
--
-- ---------------------------------------------------------------------------
--  THE ONE THING THIS MAKES HARDER, RECORDED SO IT IS NOT A SURPRISE
-- ---------------------------------------------------------------------------
-- A trigger that NAMES a column makes SQLite refuse to drop that column:
-- `ALTER TABLE order_items DROP COLUMN cost_iqd` now answers "error in trigger
-- trg_mystery_allocation_cost after drop column".
--
-- In production that costs nothing. Nothing in `migrations/` has ever dropped a
-- column (`scripts/check-migrations-additive.mjs` is there to keep it that
-- way), and 0095 already states that `order_items` "can never be rebuilt (it is
-- the sales history)". The two columns were undroppable before this file for a
-- stronger reason than this one.
--
-- Where it IS felt is a test that SIMULATES a pre-0095 database by dropping
-- them from a fully migrated one — `tests/financeLedger.test.ts`'s deploy-ahead
-- case. That simulation now needs `DROP TRIGGER IF EXISTS
-- trg_mystery_allocation_cost;` in front of its two DROP COLUMNs. The property
-- it asserts — a Worker ahead of its migrations answers 503 SERVICE_SETUP
-- rather than 500 — is untouched by this file.
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_mystery_allocation_cost
AFTER INSERT ON mystery_allocations
BEGIN
  -- RUNG 0 — THE PRODUCT. `products.product_cost_iqd` is the base of the
  -- ladder, exactly as `pick()` starts from it. NULL here is not yet an
  -- answer: a rung above may still state a fixed cost of its own.
  UPDATE order_items
     SET cost_iqd = (SELECT p.product_cost_iqd FROM products p WHERE p.id = NEW.product_id)
   WHERE id = NEW.order_item_id
     AND cost_basis = 'unrecorded';

  -- RUNG 1 — THE OPTION MODEL the pool entry named. A filament pool entry
  -- names at most one model; `ORDER BY v.sort, v.id LIMIT 1` makes the choice
  -- DETERMINISTIC for the malformed entry that names several, so two draws of
  -- the same entry can never disagree about what it cost.
  UPDATE order_items
     SET cost_iqd = COALESCE(
           (SELECT v.cost_iqd FROM product_option_values v
             WHERE v.product_id = NEW.product_id
               AND v.cost_iqd IS NOT NULL
               AND EXISTS (SELECT 1 FROM json_each(
                     CASE WHEN json_valid(NEW.option_value_ids) THEN NEW.option_value_ids ELSE '[]' END
                   ) j WHERE j.value = v.id)
             ORDER BY v.sort, v.id LIMIT 1),
           (SELECT MAX(0, order_items.cost_iqd + v.cost_adjust_iqd) FROM product_option_values v
             WHERE v.product_id = NEW.product_id
               AND v.cost_adjust_iqd IS NOT NULL
               AND order_items.cost_iqd IS NOT NULL
               AND EXISTS (SELECT 1 FROM json_each(
                     CASE WHEN json_valid(NEW.option_value_ids) THEN NEW.option_value_ids ELSE '[]' END
                   ) j WHERE j.value = v.id)
             ORDER BY v.sort, v.id LIMIT 1),
           order_items.cost_iqd)
   WHERE id = NEW.order_item_id
     AND cost_basis = 'unrecorded';

  -- RUNG 2 — THE FULFILMENT CELL for the mode this spool was actually drawn
  -- under. `mystery_allocations.sale_mode` is 'direct' | 'preorder' (0061) and
  -- `product_option_fulfillment.fulfillment_type` is 'direct_sale' |
  -- 'pre_order' (0073); the two vocabularies are mapped here rather than
  -- assumed equal. A DISABLED cell is skipped for the same reason the resolver
  -- skips it: a switched-off route must not price anything.
  UPDATE order_items
     SET cost_iqd = COALESCE(
           (SELECT f.cost_iqd FROM product_option_fulfillment f
             WHERE f.product_id = NEW.product_id
               AND f.enabled = 1
               AND f.cost_iqd IS NOT NULL
               AND f.fulfillment_type = CASE WHEN NEW.sale_mode = 'preorder' THEN 'pre_order' ELSE 'direct_sale' END
               AND EXISTS (SELECT 1 FROM json_each(
                     CASE WHEN json_valid(NEW.option_value_ids) THEN NEW.option_value_ids ELSE '[]' END
                   ) j WHERE j.value = f.option_id)
             ORDER BY f.sort, f.id LIMIT 1),
           (SELECT MAX(0, order_items.cost_iqd + f.cost_adjust_iqd) FROM product_option_fulfillment f
             WHERE f.product_id = NEW.product_id
               AND f.enabled = 1
               AND f.cost_adjust_iqd IS NOT NULL
               AND order_items.cost_iqd IS NOT NULL
               AND f.fulfillment_type = CASE WHEN NEW.sale_mode = 'preorder' THEN 'pre_order' ELSE 'direct_sale' END
               AND EXISTS (SELECT 1 FROM json_each(
                     CASE WHEN json_valid(NEW.option_value_ids) THEN NEW.option_value_ids ELSE '[]' END
                   ) j WHERE j.value = f.option_id)
             ORDER BY f.sort, f.id LIMIT 1),
           order_items.cost_iqd)
   WHERE id = NEW.order_item_id
     AND cost_basis = 'unrecorded';

  -- RUNG 3 — THE COLOUR, the most specific rung the resolver walks and, for a
  -- filament pool, the one that most often carries the real difference: a silk
  -- or a dual-colour spool costs the shop more than a basic one of the same
  -- model. `c.product_id = NEW.product_id` fences a stale colour id that
  -- belongs to another product.
  UPDATE order_items
     SET cost_iqd = COALESCE(
           (SELECT c.cost_iqd FROM product_colors c
             WHERE c.id = NEW.color_id AND c.product_id = NEW.product_id AND c.cost_iqd IS NOT NULL),
           (SELECT MAX(0, order_items.cost_iqd + c.cost_adjust_iqd) FROM product_colors c
             WHERE c.id = NEW.color_id AND c.product_id = NEW.product_id
               AND c.cost_adjust_iqd IS NOT NULL
               AND order_items.cost_iqd IS NOT NULL),
           order_items.cost_iqd)
   WHERE id = NEW.order_item_id
     AND cost_basis = 'unrecorded';

  -- THE BASIS, LAST, AND IT IS WHAT MAKES THE NUMBER READABLE.
  --
  -- 'snapshot' — a cost resolved at the instant of the draw, which is the
  -- instant of the sale. Authoritative and immutable, exactly as it is for an
  -- ordinary line: a later supplier-price edit cannot move it.
  --
  -- 'unpriced' — the walk above found no cost on any rung it can reach. 0095
  -- defines that as a RECORDED FACT, not a gap, and forbids estimating it from
  -- the catalogue afterwards. This is the important half: it is what stops the
  -- dashboard from reporting a mystery box whose filament nobody priced as
  -- pure profit. Unknown is said; free is never said.
  --
  -- No arm can write 'unrecorded' back, so a row that reaches here is costed
  -- one way or the other and this trigger is finished with it for ever.
  UPDATE order_items
     SET cost_basis = CASE WHEN cost_iqd IS NULL THEN 'unpriced' ELSE 'snapshot' END
   WHERE id = NEW.order_item_id
     AND cost_basis = 'unrecorded';
END;

-- The dashboard's mystery question is "which order item does this allocation
-- belong to, and which offer was it sold under" — asked once per line query in
-- worker/lib/financeReport.ts so a spool's cost can be attributed to the
-- MYSTERY OFFER's own product row instead of collapsing into the NULL
-- `product_id` bucket. The PRIMARY KEY already orders by `order_item_id`, but
-- it does not carry `offer_product_id`, so that grouping read the table rows
-- themselves; this index answers it from the index alone.
CREATE INDEX IF NOT EXISTS idx_mystery_alloc_item_offer
  ON mystery_allocations(order_item_id, offer_product_id);
