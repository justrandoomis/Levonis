-- FILES ON PRODUCTS AND POSTS, AND THE GRANTS THAT OPEN THEM
-- (docs/COMMUNITY_ECOSYSTEM.md §9.4 — "Files on products", "Post attachments",
-- "The shared viewer"). Additive only: four new tables and two nullable-by-
-- default columns on model_view_tokens. Nothing here rebuilds a table.
--
-- WHAT A ROW MEANS, in one line each:
--   product_files          a file a merchant attached to a catalogue product,
--                          with the ROLE that decides who may reach its bytes
--   product_file_grants    «this buyer may download this file» — written once
--                          per (file, buyer) by the store checkout's own batch,
--                          never by a client, never twice (the UNIQUE)
--   community_post_files   a model or document a maker attached to a project
--   viewer_grants          a 3D-viewer link for a PRODUCT or POST file — the
--                          same 60-minute hashed token model_view_tokens keeps
--                          for request files, kept apart because that table's
--                          file_id/request_id are NOT NULL foreign keys into the
--                          request world and cannot be made nullable additively
--
-- THE KEYS ARE PRIVATE. `file_key` sits under a prefix `/files/*` refuses
-- (merchants/<uid>/product-files/…, users/<uid>/post-files/…), and the only
-- doors to the bytes are the download routes behind a grant and the viewer
-- mesh behind a token. `preview_key` is the derived LVM mesh, under
-- product-previews/ or post-previews/ — private for the same reason.

CREATE TABLE IF NOT EXISTS product_files (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('preview','download_after_purchase','reference','instruction','source_model')),
  name TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  mime TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'document' CHECK (kind IN ('model','document','image','archive')),
  -- the measured model (worker/lib/modelGeometry.ts `ModelAnalysis`), JSON or NULL
  analysis TEXT,
  preview_key TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_product_files_product ON product_files(product_id, position, id);
CREATE INDEX IF NOT EXISTS idx_product_files_store ON product_files(store_id);

CREATE TABLE IF NOT EXISTS product_file_grants (
  id TEXT PRIMARY KEY,
  product_file_id TEXT NOT NULL REFERENCES product_files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- the store order (orders.id) that paid for it, or the community order — one of them, informational
  order_id TEXT,
  community_order_id TEXT,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  UNIQUE (product_file_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_product_file_grants_user ON product_file_grants(user_id, granted_at DESC);

CREATE TABLE IF NOT EXISTS community_post_files (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('model','document')),
  name TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  mime TEXT NOT NULL DEFAULT '',
  analysis TEXT,
  preview_key TEXT NOT NULL DEFAULT '',
  -- the author's tick: may a signed-in reader take the original?
  downloadable INTEGER NOT NULL DEFAULT 0 CHECK (downloadable IN (0,1)),
  downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_community_post_files_post ON community_post_files(post_id, position, id);

-- A viewer link for a product or post file. `token_hash` is SHA-256 of the
-- 32-byte token the client holds; the row never carries the token itself.
-- `bound_user` is the account that minted it, or NULL for a guest, whose link
-- is bound to `bound_session` instead — SHA-256 of IP + user agent + UTC day.
-- `grant_level` is what the link grants: the coarse mesh (`preview`) or the
-- stored one (`full`). Named like model_view_tokens.grant_level on purpose.
CREATE TABLE IF NOT EXISTS viewer_grants (
  token_hash TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('product','post')),
  -- product_files.id or community_post_files.id
  source_id TEXT NOT NULL,
  file_key TEXT NOT NULL,
  grant_level TEXT NOT NULL DEFAULT 'preview' CHECK (grant_level IN ('preview','full')),
  bound_user TEXT,
  bound_session TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_viewer_grants_source ON viewer_grants(source_type, source_id);

-- Every request token that exists today is a request token; the columns are
-- here so the one viewer can say which world a token came from. Product and
-- post tokens live in viewer_grants above, so these stay 'request'/NULL.
ALTER TABLE model_view_tokens ADD COLUMN source_type TEXT NOT NULL DEFAULT 'request'
  CHECK (source_type IN ('request','product','post'));
ALTER TABLE model_view_tokens ADD COLUMN source_id TEXT;
