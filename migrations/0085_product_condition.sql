-- OPEN BOX / USED / REFURBISHED LISTINGS.
--
-- A product row that carries a condition document is a graded, not-new unit:
-- a repaired printer, an opened box, a trade-in. Everything the distinction
-- implies — the warranty length, the blocked return reasons, the price
-- comparison against the new listing — is decided in worker/lib/condition.ts
-- and read from this one column.
--
-- WHY A COLUMN AND NOT A TABLE. A condition is a property OF a product row,
-- one-to-one, read on every product page and on the home shelf. A side table
-- would add a join to the busiest read in the shop to store a document that
-- has exactly one owner and no independent lifetime.
--
-- WHY NOT ops_policy. That column is internal operations data the customer
-- never sees (size_class, serialization). This document is the opposite: its
-- whole purpose is to be shown, in three languages, on the page where someone
-- decides whether to buy a used machine. Mixing them would put customer-facing
-- copy behind a name that says it is not.
--
-- `'{}'` is NEW. Every row that exists today gets it, and
-- `parseConditionDoc` returns null for it, so nothing about an ordinary
-- product changes.
ALTER TABLE products ADD COLUMN condition_doc TEXT NOT NULL DEFAULT '{}';

-- The home shelf asks for "active products that are not new, newest first".
-- Without an index that is a full scan of the catalogue on the first screen.
-- Partial, so it indexes only the handful of graded rows rather than carrying
-- an entry for every new product in the shop.
CREATE INDEX IF NOT EXISTS idx_products_condition
  ON products(status, created_at DESC)
  WHERE condition_doc <> '{}';
