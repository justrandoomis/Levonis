-- Preserve historical records while removing live-product dependencies.
-- Deferred foreign keys permit the table replacement without deleting children.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE reviews_preserved AS SELECT * FROM reviews;
DROP TABLE reviews;
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  order_item_id TEXT REFERENCES order_items(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',     
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected')),
  moderation_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), order_id TEXT REFERENCES orders(id), source TEXT NOT NULL DEFAULT 'user'
  CHECK (source IN ('user','system')), quality_score INTEGER
  CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100), quality_summary TEXT NOT NULL DEFAULT '{}', fallback_points_awarded INTEGER NOT NULL DEFAULT 0
  CHECK (fallback_points_awarded >= 0),
  UNIQUE (user_id, product_id)          
);
INSERT INTO reviews (id,user_id,product_id,order_item_id,stars,body,media,status,moderation_note,created_at,order_id,source,quality_score,quality_summary,fallback_points_awarded) SELECT id,user_id,product_id,order_item_id,stars,body,media,status,moderation_note,created_at,order_id,source,quality_score,quality_summary,fallback_points_awarded FROM reviews_preserved;
DROP TABLE reviews_preserved;
CREATE INDEX idx_reviews_product ON reviews(product_id, status);
CREATE INDEX idx_reviews_order ON reviews(order_id);
CREATE INDEX idx_reviews_source_created
  ON reviews(source, created_at DESC);
CREATE INDEX idx_reviews_system_due_guard
  ON reviews(user_id, product_id, source);

CREATE TABLE mystery_allocations_preserved AS SELECT * FROM mystery_allocations;
DROP TABLE mystery_allocations;
CREATE TABLE mystery_allocations (
  order_item_id    TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  spool_index      INTEGER NOT NULL CHECK (spool_index >= 0),
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  offer_product_id TEXT NOT NULL,
  pool_id          TEXT NOT NULL REFERENCES mystery_pools(id),
  pool_entry_id    TEXT NOT NULL,
  product_id       TEXT NOT NULL,
  option_value_ids TEXT NOT NULL DEFAULT '[]',
  color_id         TEXT NOT NULL DEFAULT '',
  
  name_snapshot    TEXT NOT NULL,
  image_snapshot   TEXT NOT NULL DEFAULT '',
  variant_snapshot TEXT NOT NULL DEFAULT '',
  sale_mode        TEXT NOT NULL,                        
  seed             TEXT NOT NULL,                        
  
  
  
  
  reveal_stage_snapshot TEXT NOT NULL,
  
  
  candidates_sha256 TEXT NOT NULL,
  revealed_at      TEXT,                                 
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (order_item_id, spool_index)
);
INSERT INTO mystery_allocations (order_item_id,spool_index,order_id,offer_product_id,pool_id,pool_entry_id,product_id,option_value_ids,color_id,name_snapshot,image_snapshot,variant_snapshot,sale_mode,seed,reveal_stage_snapshot,candidates_sha256,revealed_at,created_at) SELECT order_item_id,spool_index,order_id,offer_product_id,pool_id,pool_entry_id,product_id,option_value_ids,color_id,name_snapshot,image_snapshot,variant_snapshot,sale_mode,seed,reveal_stage_snapshot,candidates_sha256,revealed_at,created_at FROM mystery_allocations_preserved;
DROP TABLE mystery_allocations_preserved;
CREATE INDEX idx_mystery_alloc_order   ON mystery_allocations(order_id);
CREATE INDEX idx_mystery_alloc_product ON mystery_allocations(product_id, color_id);
CREATE INDEX idx_mystery_alloc_entry   ON mystery_allocations(pool_entry_id, created_at);

CREATE TABLE inventory_ledger_preserved AS SELECT * FROM inventory_ledger;
DROP TABLE inventory_ledger;
CREATE TABLE "inventory_ledger" (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('base','option','color','variant','fulfillment')),
  scope_id TEXT NOT NULL DEFAULT '',
  
  
  
  
  
  
  
  kind TEXT NOT NULL CHECK (kind IN
    ('reserve','release','deduct','restore','adjust','adjust_in','adjust_out')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  order_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO inventory_ledger (id,product_id,scope,scope_id,kind,qty,order_id,idempotency_key,actor_user_id,reason,created_at) SELECT id,product_id,scope,scope_id,kind,qty,order_id,idempotency_key,actor_user_id,reason,created_at FROM inventory_ledger_preserved;
DROP TABLE inventory_ledger_preserved;
CREATE INDEX idx_inventory_ledger_product ON inventory_ledger(product_id, created_at DESC);
CREATE INDEX idx_inventory_ledger_order ON inventory_ledger(order_id);

CREATE INDEX IF NOT EXISTS idx_fulfillment_stock ON product_option_fulfillment(option_id, fulfillment_type, enabled);
