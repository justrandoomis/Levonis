-- 0034 — direct-sale availability premium + real bundle entities.
--
-- 1) products.direct_surcharge_iqd: the owner prices IMMEDIACY the same way
--    pre-order transports price their journey. Example from the mandate:
--    base 100k — direct sale +50k, land +15k, air +25k, sea +0. The resolver
--    folds it into unit_subtotal_iqd on direct lines only (never stacked
--    with a transport commission) and the customer is shown only the final
--    price. NULL/0 = no premium — every existing product keeps its price.
--
-- 2) bundles / bundle_items: until now "bundle" was only a third value of
--    the sale-type enum on ordinary product rows — no composition, nothing
--    to administrate. The mandate moves bundles out of the product form into
--    their own admin-composed entity: a named group of catalog products,
--    visible to active PLUS / PRIME / PRO members only (enforced
--    server-side in worker/routes/bundles.ts, not by hiding a link).
--    A bundle deliberately has NO price of its own: its storefront price is
--    the live sum of its members' tier-resolved prices, so the display can
--    never drift from what checkout actually charges.

ALTER TABLE products ADD COLUMN direct_surcharge_iqd INTEGER;

CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  -- English-only name, like every product name (§3: names are never
  -- machine-translated; the storefront shows them verbatim).
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bundle_items (
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bundle_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_items_product ON bundle_items(product_id);
