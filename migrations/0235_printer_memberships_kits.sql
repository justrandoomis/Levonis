-- PRINTER PACKAGES, PHASE 2 — «خصص طابعتك»: a membership bought with a printer, and the owner's filament kits
-- (owner rulings 2026-11-17; DECISIONS row 339, phase 2).
--
-- (1) THE OWNER'S KITS IN THE CART. A kit is made by the owner from real products / variants (the `printerServices`
--     setting); the customer picks one for a printer or skips. Its items are ORDINARY cart lines priced at their live
--     prices (no discount) and reserved like any line at checkout, linked to the printer line:
--       kit_parent_id   the printer's cart line;   kit_id   the kit;   kit_unit_qty   units per printer unit.
--     A kit line carries `shipping_method_id = 'kit:' || kit_parent_id` (the 0175 gift lines' discriminator pattern):
--     it never merges with the same filament bought alone, and every ordinary lookup (`shipping_method_id = ''`) skips
--     it. One kit per printer unit: the two triggers below make the kit follow the printer's quantity and removal,
--     whatever door changes the printer line.
-- (2) THE MEMBERSHIP IN THE CART: one choice per cart (`cart_membership_choice`), tied to the printer line it was
--     chosen with; removed with that line.
-- (3) THE ORDER LINE. order_items.line_kind 'membership' is the membership bought with the order: product_id NULL,
--     qty 1, unit = the live plan price less the upgrade credit frozen at checkout, cost 0. Kit lines carry
--     kit_parent_item_id (the printer's order line) and kit_id.
-- (4) THE PURCHASE. order_membership_purchases holds what the checkout froze (plan, tier, months, price, credit, the
--     member's row it upgrades) and its state: 'pending' until the order is delivered AND fully paid, then
--     'active' (the memberships row exists, id mem_ord_<order item>) — final, never refunded (only the owner's correction ends it, with the order); 'cancelled' when the order
--     is cancelled before that (its money goes back with the order); 'blocked' when activation found another live
--     membership the purchase cannot replace (needs a person). One open purchase per customer.
-- Additive. RE-RUNNABLE as this repo's rules allow (scripts/migrate-check.mjs --twice leaves ADD COLUMN to D1's own
-- bookkeeping). Every reader tolerates its absence.
ALTER TABLE cart_items ADD COLUMN kit_parent_id TEXT;
ALTER TABLE cart_items ADD COLUMN kit_id TEXT;
ALTER TABLE cart_items ADD COLUMN kit_unit_qty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_cart_items_kit_parent ON cart_items(kit_parent_id) WHERE kit_parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cart_membership_choice (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES membership_plans(id),
  printer_cart_item_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cart_membership_choice_line ON cart_membership_choice(printer_cart_item_id);

-- The kit and the membership follow their printer line out of the cart (a delete from any door, the checkout's own).
CREATE TRIGGER IF NOT EXISTS trg_cart_printer_extras_removed AFTER DELETE ON cart_items
WHEN OLD.kit_parent_id IS NULL
BEGIN
  DELETE FROM cart_items WHERE kit_parent_id = OLD.id;
  DELETE FROM cart_membership_choice WHERE printer_cart_item_id = OLD.id;
END;

-- One kit per printer unit: the kit lines' quantity is the printer's × the per-unit count, whatever door moved it.
CREATE TRIGGER IF NOT EXISTS trg_cart_kit_follows_printer_qty AFTER UPDATE OF qty ON cart_items
WHEN OLD.kit_parent_id IS NULL AND NEW.qty IS NOT OLD.qty
BEGIN
  UPDATE cart_items SET qty = MIN(9999, NEW.qty * kit_unit_qty) WHERE kit_parent_id = NEW.id AND kit_unit_qty > 0;
END;

-- The kit ships the way its printer ships: a change of the printer line's order type or route (PATCH, a re-add's
-- upsert) moves its kit lines with it. A row that states no type takes the read model's fallback (a route = a
-- pre-order, none = a direct sale); the checkout still judges every kit line against the printer's RESOLVED type
-- (KIT_CHANGED when they differ) and the cart re-judges a kit chosen again.
CREATE TRIGGER IF NOT EXISTS trg_cart_kit_follows_printer_type AFTER UPDATE OF fulfillment_type, transport_method ON cart_items
WHEN OLD.kit_parent_id IS NULL
 AND (NEW.fulfillment_type IS NOT OLD.fulfillment_type OR NEW.transport_method IS NOT OLD.transport_method)
BEGIN
  UPDATE cart_items
     SET fulfillment_type = CASE WHEN COALESCE(NEW.fulfillment_type, '') <> '' THEN NEW.fulfillment_type
                                 WHEN COALESCE(NEW.transport_method, '') <> '' THEN 'pre_order'
                                 ELSE 'direct_sale' END ,
         transport_method = COALESCE(NEW.transport_method, '')
   WHERE kit_parent_id = NEW.id;
END;

ALTER TABLE order_items ADD COLUMN line_kind TEXT NOT NULL DEFAULT 'product' CHECK (line_kind IN ('product', 'membership'));
ALTER TABLE order_items ADD COLUMN kit_parent_item_id TEXT;
ALTER TABLE order_items ADD COLUMN kit_id TEXT;
CREATE INDEX IF NOT EXISTS idx_order_items_kit_parent ON order_items(kit_parent_item_id) WHERE kit_parent_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_membership_purchases (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_item_id TEXT NOT NULL UNIQUE REFERENCES order_items(id),
  -- The printer line it was chosen with.
  printer_item_id TEXT,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL REFERENCES membership_plans(id),
  tier TEXT NOT NULL CHECK (tier IN ('plus', 'prime', 'pro')),
  duration_months INTEGER NOT NULL CHECK (duration_months >= 1),
  -- new: no live membership; upgrade: ends the lower live row at activation (credit frozen now).
  -- No renewal through a printer order (owner ruling 2026-11-17 ~10:20): a member is offered a HIGHER tier only.
  kind TEXT NOT NULL CHECK (kind IN ('new', 'upgrade')),
  price_iqd INTEGER NOT NULL CHECK (price_iqd >= 0),
  credit_iqd INTEGER NOT NULL DEFAULT 0 CHECK (credit_iqd >= 0),
  charge_iqd INTEGER NOT NULL CHECK (charge_iqd >= 0),
  base_membership_id TEXT,
  base_expires_at TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'cancelled', 'blocked')),
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  review_reason TEXT NOT NULL DEFAULT '',
  activation_token TEXT,
  membership_id TEXT,
  starts_at TEXT,
  expires_at TEXT,
  activated_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (charge_iqd = price_iqd - credit_iqd),
  -- Active ⇔ a memberships row and an activation time — except a purchase the OWNER ended by correction, which
  -- keeps both as its history.
  CHECK ((state = 'active') = (membership_id IS NOT NULL AND activated_at IS NOT NULL)
         OR (state = 'cancelled' AND cancel_reason = 'owner_correction'))
);
CREATE INDEX IF NOT EXISTS idx_order_membership_purchases_order ON order_membership_purchases(order_id);
CREATE INDEX IF NOT EXISTS idx_order_membership_purchases_open ON order_membership_purchases(state, updated_at) WHERE state IN ('pending', 'blocked');
-- One purchase waiting per customer: a second order with a membership is refused (MEMBERSHIP_ORDER_PENDING).
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_membership_purchases_one_pending ON order_membership_purchases(user_id) WHERE state = 'pending';

-- ACTIVE IS FINAL (owner ruling: a membership bought with an order is non-refundable once it started). The one
-- way out is the OWNER's correction (ruling ~10:20; worker/lib/orderMembershipSale.ts ownerCorrectionStatements):
-- active → cancelled with cancel_reason 'owner_correction', in the same batch that cancels and refunds the order.
CREATE TRIGGER IF NOT EXISTS trg_order_membership_active_final BEFORE UPDATE ON order_membership_purchases
WHEN OLD.state = 'active'
 AND NOT (NEW.state = 'cancelled' AND NEW.cancel_reason = 'owner_correction' AND NEW.membership_id IS OLD.membership_id)
 AND (NEW.state IS NOT 'active' OR NEW.membership_id IS NOT OLD.membership_id)
BEGIN
  SELECT RAISE(ABORT, 'ORDER_MEMBERSHIP_ACTIVE_FINAL');
END;

-- Cancelled before activation → it never starts; its money goes back with the order's own refund.
CREATE TRIGGER IF NOT EXISTS trg_orders_membership_cancelled AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status IS NOT 'cancelled'
BEGIN
  UPDATE order_membership_purchases
     SET state = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cancel_reason = 'order_cancelled',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state IN ('pending', 'blocked');
END;

-- AN OWNER-CORRECTED ORDER STAYS CANCELLED (review, 2026-11-17): the correction ended the membership and refunded
-- the order; re-opening it would charge the membership line again for a membership that is not revived. Every
-- door that re-opens a cancelled order meets this (ORDER_MEMBERSHIP_CORRECTED); a new order is placed instead.
CREATE TRIGGER IF NOT EXISTS trg_orders_membership_corrected_no_reopen BEFORE UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status IS NOT 'cancelled'
 AND EXISTS (SELECT 1 FROM order_membership_purchases p WHERE p.order_id = NEW.id AND p.cancel_reason = 'owner_correction')
BEGIN
  SELECT RAISE(ABORT, 'ORDER_MEMBERSHIP_CORRECTED');
END;

-- An order re-opened from cancelled takes its purchase back to pending (or to review, when another one waits).
-- An UPGRADE whose base membership was cancelled (or refunded) while the order was cancelled is not restored to
-- pending — its frozen credit is that base's unused value (review S4): it waits for a person ('blocked',
-- review_reason 'base_membership_ended'; the activation keeps it blocked while the base stays ended).
CREATE TRIGGER IF NOT EXISTS trg_orders_membership_reopened AFTER UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status IS NOT 'cancelled'
BEGIN
  UPDATE order_membership_purchases
     SET state = 'blocked', needs_review = 1, review_reason = 'base_membership_ended', cancelled_at = NULL, cancel_reason = '',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state = 'cancelled' AND cancel_reason = 'order_cancelled' AND kind = 'upgrade'
     AND EXISTS (SELECT 1 FROM memberships b WHERE b.id = order_membership_purchases.base_membership_id AND b.state = 'cancelled');
  UPDATE order_membership_purchases
     SET state = 'pending', cancelled_at = NULL, cancel_reason = '', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state = 'cancelled' AND cancel_reason = 'order_cancelled'
     AND NOT EXISTS (SELECT 1 FROM order_membership_purchases o WHERE o.user_id = order_membership_purchases.user_id AND o.state = 'pending');
  UPDATE order_membership_purchases
     SET state = 'blocked', needs_review = 1, review_reason = 'reopened_while_another_waits', cancelled_at = NULL, cancel_reason = '',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE order_id = NEW.id AND state = 'cancelled' AND cancel_reason = 'order_cancelled';
END;

-- The order of an ACTIVE membership is not cancelled by any door: the membership is final and a cancel refunds the
-- whole order. The printer is returned through the returns desk instead (ORDER_MEMBERSHIP_ACTIVE; the worker asks first).
-- The owner's correction ends the purchase first, in the cancel's own batch, so this trigger then finds none active.
CREATE TRIGGER IF NOT EXISTS trg_orders_membership_active_no_cancel BEFORE UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status IS NOT 'cancelled'
 AND EXISTS (SELECT 1 FROM order_membership_purchases p WHERE p.order_id = NEW.id AND p.state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'ORDER_MEMBERSHIP_ACTIVE');
END;

-- The membership line is never returned (MEMBERSHIP_NOT_RETURNABLE; the returns desk refuses first).
CREATE TRIGGER IF NOT EXISTS trg_return_cases_no_membership_line BEFORE INSERT ON return_cases
WHEN EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = NEW.order_item_id AND oi.line_kind = 'membership')
BEGIN
  SELECT RAISE(ABORT, 'MEMBERSHIP_NOT_RETURNABLE');
END;
