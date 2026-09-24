-- ============================================================================
--  0114 — «سلة واحدة = بائع واحد» : THE DATABASE REFUSES A SECOND SELLER.
-- ============================================================================
-- NONDESTRUCTIVE: two `CREATE TRIGGER IF NOT EXISTS` on `cart_items`. No
-- table is rebuilt, no column is added, no row is read, written or deleted.
-- A re-run changes nothing.
--
-- ---------------------------------------------------------------------------
--  WHY A TRIGGER (docs/MERCHANT_PLATFORM.md §2 decision 1)
-- ---------------------------------------------------------------------------
-- «A cart holds one merchant's goods, or Levonis's — never two merchants,
--  never a merchant with Levonis. Enforced on the server (and by a database
--  trigger).» 0030 wrote that rule into worker/routes/cart.ts alone, on the
-- note that SQLite "cannot express all rows for this user share a seller" as
-- a constraint. It cannot as a CHECK; it can as a trigger, and it has to: the
-- two add doors read the cart, decide, and then insert as separate
-- statements, so two adds from two tabs — one Levonis item, one store item,
-- or two different stores — could both pass their read and both insert
-- (docs/merchant-platform/audit/02-commerce-money.md B8). The store checkout
-- then billed the second store's goods inside the first store's order.
--
-- The trigger is the last word: whatever door writes a line, and however two
-- requests interleave, the second seller's line aborts its statement with
-- RAISE(ABORT, 'CART_SELLER_CONFLICT'). The routes map that message to the
-- same 400 CART_SELLER_CONFLICT the read-then-decide check has always
-- answered, so a client cannot tell which of the two refused it — and does
-- not need to.
--
-- ---------------------------------------------------------------------------
--  WHAT "THE SAME SELLER" MEANS HERE
-- ---------------------------------------------------------------------------
-- The seller type, and for a store line the MERCHANT — exactly
-- worker/lib/cartSeller.ts `sameSeller`. A merchant has one store
-- (`merchant_stores.merchant_id` is UNIQUE), so comparing the merchant is
-- comparing the store, and a Levonis line's merchant is NULL on every row.
--
-- Scoped to ONE USER'S rows. Two customers holding two different sellers'
-- carts is the normal state of the table (tests/cartSeller.test.ts pins it).
--
-- The UPDATE trigger watches only the columns that decide the seller. A
-- quantity or option change — every UPDATE the routes issue today — never
-- fires it.
--
-- ---------------------------------------------------------------------------
--  EXISTING ROWS
-- ---------------------------------------------------------------------------
-- Nothing is repaired. A cart that already mixes sellers (the race above
-- could have produced one) keeps its rows; the store checkout now refuses it
-- with CART_SELLER_CONFLICT (worker/routes/storeOrders.ts) and the customer
-- empties it. Deleting a customer's lines in a migration would be the silent
-- clearing §14 forbids.
CREATE TRIGGER IF NOT EXISTS trg_cart_items_one_seller_insert
BEFORE INSERT ON cart_items
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM cart_items x
   WHERE x.user_id = NEW.user_id
     AND x.id <> NEW.id
     AND (x.seller_type <> NEW.seller_type
          OR COALESCE(x.merchant_id, '') <> COALESCE(NEW.merchant_id, ''))
)
BEGIN
  SELECT RAISE(ABORT, 'CART_SELLER_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS trg_cart_items_one_seller_update
BEFORE UPDATE OF user_id, seller_type, merchant_id ON cart_items
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM cart_items x
   WHERE x.user_id = NEW.user_id
     AND x.id <> NEW.id
     AND (x.seller_type <> NEW.seller_type
          OR COALESCE(x.merchant_id, '') <> COALESCE(NEW.merchant_id, ''))
)
BEGIN
  SELECT RAISE(ABORT, 'CART_SELLER_CONFLICT');
END;
