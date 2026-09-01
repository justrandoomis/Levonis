-- Saved products (the storefront heart). A visitor keeps a private list of
-- community/store products they want to come back to — the profile grid's
-- heart toggles membership, /api/community-favorites reads it back. Mirrors
-- the main-site `favorites` table and the `follows` pattern: a bare
-- (user, product) pair, no counters denormalised anywhere.
CREATE TABLE IF NOT EXISTS community_product_favorites (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_cpf_product ON community_product_favorites(product_id);
