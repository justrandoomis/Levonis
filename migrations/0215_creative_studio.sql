-- «استوديو Levonis الإبداعي» — the Creative Studio's own tables (owner request 2026-10-27;
-- docs/CREATIVE_STUDIO.md; DECISIONS row 270).
--
-- ADDITIVE ONLY: every statement is CREATE TABLE / CREATE INDEX IF NOT EXISTS, so a second run
-- changes nothing (scripts/migrate-check.mjs --twice). The studio READS the store's tables through
-- the public card path and never writes one of them; nothing here references a store table by a
-- foreign key, because a manual or test snapshot may name a product this database does not hold, and
-- a product deleted later keeps its studio history (worker/lib/productDeletion.ts HISTORY clears the
-- link, the row stays).
--
-- NO SECRET IN CLEAR, NO PROMPT, NO MODEL OUTPUT IN THE USAGE LEDGER. `key_sealed` is AES-256-GCM
-- ciphertext under the Worker secret CREATIVE_STUDIO_ENC_KEY, bound to this row by its additional
-- data (worker/lib/creative/keyVault.ts); `creative_usage` carries counts and codes only. No model id
-- is written anywhere in the repository: `model` is the owner's choice from the live model list.
--
-- Files live in the PRIVATE bucket under creative-studio/…; every `r2_key` below is registered in
-- worker/lib/mediaRefs.ts MEDIA_REFERENCE_SOURCES so the orphan sweeper can never delete one.

-- The provider settings: ONE row, the owner's. Read in full by the owner only; the key itself is read
-- by worker/lib/creative/anthropic.ts alone.
CREATE TABLE IF NOT EXISTS creative_provider_settings (
  id TEXT PRIMARY KEY CHECK (id = 'anthropic'),
  key_sealed TEXT,
  key_hint TEXT CHECK (key_hint IS NULL OR length(key_hint) <= 8),
  key_set_at TEXT,
  key_set_by TEXT,
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 120),
  effort TEXT CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high')),
  budget_json TEXT NOT NULL DEFAULT '{}',
  rates_json TEXT,
  vision_review INTEGER NOT NULL DEFAULT 0 CHECK (vision_review IN (0, 1)),
  priorities_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_test_at TEXT,
  last_test_ok INTEGER CHECK (last_test_ok IS NULL OR last_test_ok IN (0, 1)),
  last_test_code TEXT,
  updated_at TEXT,
  updated_by TEXT
);

-- The day's spend, keyed by the Asia/Baghdad civil date (worker/lib/baghdadTime.ts). One conditional
-- UPDATE reserves the worst case before every call; the settle replaces it with the real usage.
CREATE TABLE IF NOT EXISTS creative_spend_day (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  tokens_reserved INTEGER NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  usd_micro_reserved INTEGER NOT NULL DEFAULT 0 CHECK (usd_micro_reserved >= 0),
  usd_micro_spent INTEGER NOT NULL DEFAULT 0 CHECK (usd_micro_spent >= 0),
  in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight >= 0)
);

-- One row per provider call: who, what task, which model, the outcome code and the token counts.
-- Deliberately NO column for a prompt, a text, an image or a key.
CREATE TABLE IF NOT EXISTS creative_usage (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor_id TEXT,
  task TEXT NOT NULL CHECK (task IN ('test', 'ideas', 'compose', 'edit', 'review', 'carousel')),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'cancelled', 'refused')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  est_cost_micro_usd INTEGER,
  rate_source TEXT,
  job_id TEXT,
  document_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_creative_usage_created ON creative_usage(created_at);

-- A job per AI call: idempotency, the version it was asked against, the validated result, and the
-- reservation it holds on creative_spend_day until it settles.
CREATE TABLE IF NOT EXISTS creative_jobs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL CHECK (task IN ('test', 'ideas', 'compose', 'edit', 'review', 'carousel')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  actor_id TEXT,
  idempotency_key TEXT UNIQUE,
  request_hash TEXT NOT NULL,
  document_id TEXT,
  base_version INTEGER,
  target_ids_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
  reserved_day TEXT,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_usd_micro INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  cancelled_at TEXT,
  applied_at TEXT,
  applied_version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_created ON creative_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_running ON creative_jobs(status, started_at);

-- Brand-kit versions. A save is a NEW version; a document keeps the version it was made with.
CREATE TABLE IF NOT EXISTS creative_brand_versions (
  version INTEGER PRIMARY KEY,
  kit_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);

-- Studio files (logos, backgrounds, references, extra product shots), private, PNG/JPEG/WebP only.
CREATE TABLE IF NOT EXISTS creative_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'background', 'reference_liked', 'reference_rejected', 'product_extra', 'icon', 'element')),
  label TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'uploaded' CHECK (provenance IN ('uploaded', 'catalog', 'generated', 'derived')),
  derived_from TEXT,
  product_id TEXT,
  review TEXT NOT NULL DEFAULT 'approved' CHECK (review IN ('approved', 'needs_review', 'rejected')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_creative_assets_kind ON creative_assets(kind, created_at);

-- Marketing snapshots: the allow-listed product facts a design is built from, with their hash.
CREATE TABLE IF NOT EXISTS creative_product_snapshots (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  variant_key TEXT,
  data_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('live', 'manual', 'test')),
  fetched_at TEXT NOT NULL,
  fetched_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_creative_snapshots_product ON creative_product_snapshots(product_id, fetched_at);

-- Approved service claims (warranty, delivery, returns…): the identity, and its versions below.
CREATE TABLE IF NOT EXISTS creative_service_claims (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 60),
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- Every version of a claim. Editing makes a new PENDING version; approving it retires the older
-- approved one and marks the documents bound to an older version as needing review.
CREATE TABLE IF NOT EXISTS creative_service_claim_versions (
  claim_id TEXT NOT NULL REFERENCES creative_service_claims(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'retired')),
  title_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  details_path TEXT,
  product_ids_json TEXT NOT NULL DEFAULT '[]',
  valid_from TEXT,
  valid_until TEXT,
  last_verified_at TEXT,
  source_note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  PRIMARY KEY (claim_id, version)
);

-- The designs. `content_json` is the normalised CreativeDocument (packages/creativeDoc); approval,
-- the version counter and authorship live in these columns, never in the JSON.
CREATE TABLE IF NOT EXISTS creative_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('idea', 'draft', 'in_review', 'approved', 'scheduled', 'published', 'archived', 'failed')),
  kind TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'slide', 'experiment')),
  campaign_id TEXT,
  parent_id TEXT,
  format_id TEXT NOT NULL CHECK (format_id IN ('square', 'portrait', 'story', 'custom')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  product_id TEXT,
  template_id TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  content_json TEXT NOT NULL,
  brand_version INTEGER,
  approved_version INTEGER,
  needs_review_json TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_creative_documents_status ON creative_documents(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_creative_documents_product ON creative_documents(product_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_creative_documents_updated ON creative_documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_creative_documents_campaign ON creative_documents(campaign_id, updated_at);

-- Version history at meaningful points (an AI edit, a restore, a template change, a checkpoint, or
-- ten minutes since the last one); approved versions are never pruned.
CREATE TABLE IF NOT EXISTS creative_document_versions (
  document_id TEXT NOT NULL REFERENCES creative_documents(id),
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'ai', 'template', 'restore', 'relayout', 'import')),
  change_summary TEXT NOT NULL DEFAULT '',
  job_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, version)
);

-- Approvals and rejections of one specific version. A later content change invalidates the approval.
CREATE TABLE IF NOT EXISTS creative_reviews (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES creative_documents(id),
  version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  brand_version INTEGER,
  export_ids_json TEXT NOT NULL DEFAULT '[]',
  qa_json TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidated_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_creative_reviews_document ON creative_reviews(document_id, created_at);

-- Exported files (PNG/JPEG/WebP renders and Project JSON), private.
CREATE TABLE IF NOT EXISTS creative_exports (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES creative_documents(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('png', 'jpeg', 'webp', 'project_json', 'background')),
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1)),
  source_check TEXT NOT NULL DEFAULT 'none' CHECK (source_check IN ('fresh', 'changed', 'unverified', 'none')),
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_exports_document ON creative_exports(document_id, created_at);

-- «شنو أنشر اليوم؟» ideas, as validated and stored.
CREATE TABLE IF NOT EXISTS creative_ideas (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'used', 'dismissed')),
  idea_json TEXT NOT NULL,
  product_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_ideas_created ON creative_ideas(created_at);

-- The owner's reasons and notes («المنتج صغير», «مزدحم» …), the visual memory of spec §22.
CREATE TABLE IF NOT EXISTS creative_feedback (
  id TEXT PRIMARY KEY,
  document_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reject', 'note', 'like')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'document' CHECK (scope IN ('document', 'brand')),
  promoted_brand_version INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_feedback_created ON creative_feedback(created_at);

-- The studio's own record of what the public card said about each product at the last sync — the
-- only source of "arrived" and "back in stock" (the first pass is a baseline and announces nothing).
CREATE TABLE IF NOT EXISTS creative_catalog_watch (
  product_id TEXT PRIMARY KEY,
  availability TEXT NOT NULL CHECK (availability IN ('available', 'preorder', 'unavailable', 'unknown')),
  price_status TEXT NOT NULL CHECK (price_status IN ('priced', 'unpriced', 'members_only')),
  display_price_iqd INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  baseline INTEGER NOT NULL DEFAULT 0 CHECK (baseline IN (0, 1))
);

-- Where the bounded sync stands: the cursor through the catalogue, and whether the baseline pass is
-- complete (until it is, nothing is announced).
CREATE TABLE IF NOT EXISTS creative_watch_state (
  id TEXT PRIMARY KEY CHECK (id = 'catalog'),
  cursor TEXT NOT NULL DEFAULT '',
  baseline_complete INTEGER NOT NULL DEFAULT 0 CHECK (baseline_complete IN (0, 1)),
  baseline_completed_at TEXT,
  last_sync_at TEXT,
  passes INTEGER NOT NULL DEFAULT 0
);

-- The documented transitions the sync found, with their evidence.
CREATE TABLE IF NOT EXISTS creative_events (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('arrival', 'back_in_stock')),
  detected_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_creative_events_detected ON creative_events(detected_at);
