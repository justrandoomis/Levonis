-- Canonical catalogue products selected from search, never raw queries or contact details.
CREATE TABLE IF NOT EXISTS search_selection_visitors (
  day INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  visitor_hash TEXT NOT NULL,
  PRIMARY KEY (day, product_id, visitor_hash)
);
CREATE INDEX IF NOT EXISTS idx_search_selection_product ON search_selection_visitors(product_id);
