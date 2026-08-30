-- Levonis migration 0019 — widen the price-change audit trail for the LEVO
-- PRIME price and the product cost (product-form mandate §11: "أضف audit log
-- لتغيير السعر والتكلفة والمخزون والتصنيف والصورة الرئيسية والاستيراد").
--
-- price_history.field carries CHECK (field IN ('regular','pro','compare_at')),
-- which SQLite cannot widen in place. The rebuild is completely contained:
-- nothing references price_history, and price_history.product_id is a plain
-- TEXT column with no foreign key of its own, so no constraint counter is
-- disturbed. Every existing row is copied verbatim, including historic
-- 'compare_at' rows — the audit trail is never rewritten just because the
-- field was retired from the product form.

CREATE TABLE price_history_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  variant_key TEXT NOT NULL DEFAULT '', -- '' | option:<id> | color:<id> | variant:<id>
  -- 'compare_at' is RETAINED so pre-0018 history stays readable; the product
  -- form no longer produces new rows with it.
  field TEXT NOT NULL CHECK (field IN ('regular','prime','pro','cost','compare_at')),
  old_iqd INTEGER,
  new_iqd INTEGER,
  changed_by TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO price_history_new (id, product_id, variant_key, field, old_iqd, new_iqd, changed_by, changed_at)
  SELECT id, product_id, variant_key, field, old_iqd, new_iqd, changed_by, changed_at FROM price_history;
DROP TABLE price_history;
ALTER TABLE price_history_new RENAME TO price_history;
CREATE INDEX idx_price_history_product ON price_history(product_id, changed_at);
