-- PRINTER PACKAGES, PHASE 4 — «خصص طابعتك»: kit colours chosen by the customer, discounted printer add-ons, and the
-- owner's printer discount inside the unit price (owner rulings 2026-11-18; DECISIONS row 355).
--
-- (1) THE CART. An add-on line is an ordinary cart line attached to its printer line exactly like a kit line
--     (kit_parent_id / kit_unit_qty / the 0235 triggers follow the printer's quantity, type and removal), with
--     `addon_id` instead of `kit_id` and the discriminator `shipping_method_id = 'addon:' || parent || ':' || addon_id`.
--     `kit_color_mode` says who picked the colour of a kit or add-on line: '' = the owner's fixed colour (every line
--     written before phase 4), 'chosen' = the customer, 'random' = the system (cheapest available colour, most free
--     stock, then the colour order, then its id), reserved like any colour at checkout.
-- (2) THE ORDER LINE. order_items.addon_id / kit_color_mode name the same facts on the order;
--     printer_discount_iqd = the owner's printer discount per unit × qty, ALREADY INSIDE unit_price_iqd. It is
--     report-only («خصومات الطابعة الممنوحة») and never subtracted again; pricing_snapshot.printer_discount keeps its
--     terms.
-- Additive, no foreign keys. Every reader tolerates its absence (worker/lib/cartLineProjection.ts fills the cart
-- columns with these defaults; the order insert writes them only when a line carries them).
ALTER TABLE cart_items ADD COLUMN addon_id TEXT;
ALTER TABLE cart_items ADD COLUMN kit_color_mode TEXT NOT NULL DEFAULT '' CHECK (kit_color_mode IN ('', 'chosen', 'random'));
CREATE INDEX IF NOT EXISTS idx_cart_items_addon ON cart_items(kit_parent_id, addon_id) WHERE addon_id IS NOT NULL;

ALTER TABLE order_items ADD COLUMN addon_id TEXT;
ALTER TABLE order_items ADD COLUMN kit_color_mode TEXT CHECK (kit_color_mode IS NULL OR kit_color_mode IN ('chosen', 'random'));
ALTER TABLE order_items ADD COLUMN printer_discount_iqd INTEGER NOT NULL DEFAULT 0 CHECK (printer_discount_iqd >= 0);

-- A line attached to a printer is a kit line or an add-on line, never both.
CREATE TRIGGER IF NOT EXISTS trg_cart_attached_one_kind BEFORE INSERT ON cart_items
WHEN NEW.kit_id IS NOT NULL AND NEW.addon_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'ATTACHED_LINE_KIND');
END;
