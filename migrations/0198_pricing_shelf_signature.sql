-- 0198 — THE SHELF A COST-FIRST PRICE WAS COMPUTED FROM (DECISIONS row 244; docs/PRICING-V2.md §10)
--
-- A cost-first («من التكلفة») model with units on the shelf is priced, for the direct sale, from the
-- highest landed unit cost among its batches still on the shelf. Every V2 write stores here a HASH of
-- the shelf it priced at (each shelf identity's highest known cost, «unknown» or «sold out» — never a
-- unit count), so the quarter-hour repricing sweep knows when a batch received, a sale, an adjustment
-- or a return moved a model's costliest batch or emptied its shelf, and reprices it through the
-- existing queue (worker/lib/pricingEngine/v2/shelf.ts, autoReprice.ts).
--
-- Additive only: one nullable column, no row touched. NULL = priced before this migration, price-first,
-- or no batch at all. A hash, never a figure: the costs stay in inventory_lots (owner-only, row 220).
-- An older Worker never reads or writes it; every read of it probes for it first.
ALTER TABLE product_pricing_state ADD COLUMN shelf_sig TEXT
  CHECK (shelf_sig IS NULL OR (length(shelf_sig) = 64 AND shelf_sig NOT GLOB '*[^0-9a-f]*'));
