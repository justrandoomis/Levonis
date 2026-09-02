-- Levonis migration 0041 — a managed hashtag vocabulary for the taxonomy admin.
--
-- Hashtags were, until now, a free-form JSON array on products.hashtags with
-- nothing an admin could list, rename or delete. This table is the managed
-- list the admin edits and the product form / import template offer as
-- options. products.hashtags is LEFT IN PLACE and stays the source of truth
-- for what a product carries; the worker keeps the two in step (a product
-- save registers its tags here, a rename here rewrites the products' arrays).
--
-- ADDITIVE and idempotent: nothing is dropped, rewritten or backfilled.
-- Existing product tags surface in the admin as "unmanaged" rows at read
-- time, and become managed the moment an admin adopts them or a product is
-- saved again.

CREATE TABLE IF NOT EXISTS hashtags (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL COLLATE NOCASE,
  name_ar TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hashtags_tag ON hashtags(tag COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_hashtags_active_sort ON hashtags(active, sort);
