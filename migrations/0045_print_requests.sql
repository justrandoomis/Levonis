-- ============================================================================
--  0045 — THE PRINT REQUEST JOURNEY
-- ============================================================================
-- A customer uploads a model, Levonis measures it and estimates a price, the
-- request is published ONCE, and the merchants whose machines can actually make
-- it are told about it.
--
-- THE ARCHITECTURAL RULE THE OWNER SET, AND WHAT IT MEANS HERE:
--
--   "ONE published request → Smart Matching finds eligible merchants → ONLY
--    notifications are sent → the notification opens that same request."
--
-- So there is NO second request table, no per-merchant copy, and no "invitation"
-- row that could be mistaken for one. `community_requests` stays exactly what it
-- is; everything print-specific hangs off it by request_id, and matching writes
-- an AUDIT of who was told — never a request.
--
-- WHAT ALREADY EXISTED AND IS NOT REBUILT:
--   community_requests, community_request_files, community_offers,
--   community_orders, community_escrows        (0001 / 0031)
--   merchant_stores, community_merchants,
--   merchant_notification_preferences          (0030)
--   outbox — the durable email/Telegram queue  (0003)
--
-- Every statement below is CREATE or ALTER ADD. Nothing is dropped, no existing
-- row is rewritten, and a database that never sees a print request is unchanged.
-- ============================================================================

-- ------------------------------------------------- 1. THE IN-APP NOTIFICATION
-- There is no user-facing notification system in this codebase. `outbox` sends
-- email and Telegram; `merchant_notification_preferences` stores switches that
-- nothing reads. A merchant cannot be "told about a request that opens the
-- request" without somewhere for that message to live, so this is the missing
-- piece — and it is general, not print-specific, because the next feature that
-- needs to tell a user something should not have to invent a second one.
CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- print_request_match | offer_received | ...
  -- Titles and bodies are stored per language rather than pre-rendered, because
  -- a notification read six months later must still be in the language the
  -- reader is using NOW, not the one they used when it arrived.
  title_ar TEXT NOT NULL DEFAULT '',
  title_en TEXT NOT NULL DEFAULT '',
  body_ar TEXT NOT NULL DEFAULT '',
  body_en TEXT NOT NULL DEFAULT '',
  -- Where tapping it goes. An in-app path, never an absolute URL: a stored
  -- origin is a stored mistake the day the domain changes.
  link TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT '',     -- 'request' | 'offer' | 'order' | ''
  entity_id TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  -- Replay protection, exactly as `outbox.event_key` does it: telling the same
  -- merchant about the same request twice is the failure this whole feature is
  -- defined against, so the database refuses it rather than the code promising
  -- not to. UNIQUE over (user_id, event_key) — two different merchants share an
  -- event key for the same request, and must both be told.
  event_key TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user
  ON user_notifications(user_id, created_at DESC);
-- The badge is a COUNT over unread rows and nothing else, so it gets its own
-- partial index: an inbox of ten thousand read rows must not slow it down.
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notifications_event
  ON user_notifications(user_id, event_key) WHERE event_key <> '';

-- ------------------------------------------------------ 2. MERCHANT PRINTERS
-- What a merchant can actually make. Today the closest thing is
-- `merchant_showcase`, which migration 0036 describes in its own comment as "a
-- titled, captioned picture" — content, not data. You cannot ask a photograph
-- whether 220x180x140mm fits on it, and matching has to ask exactly that.
--
-- These rows feed BOTH sides of the system: matching (can this shop take the
-- job at all) and pricing (what this shop's machine-hour really costs).
CREATE TABLE IF NOT EXISTS merchant_printers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES merchant_stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  technology TEXT NOT NULL DEFAULT 'fdm' CHECK (technology IN ('fdm','resin')),
  brand TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  -- The build volume, in millimetres. This is the single most decisive fact in
  -- matching: a part that does not fit cannot be printed at any price, by any
  -- merchant, however good their rating.
  build_x_mm INTEGER NOT NULL DEFAULT 0,
  build_y_mm INTEGER NOT NULL DEFAULT 0,
  build_z_mm INTEGER NOT NULL DEFAULT 0,
  nozzle_mm REAL NOT NULL DEFAULT 0.4,
  materials TEXT NOT NULL DEFAULT '[]',     -- material ids from the admin catalogue
  colors TEXT NOT NULL DEFAULT '[]',        -- hex strings the shop stocks
  multicolor INTEGER NOT NULL DEFAULT 0,
  enclosed INTEGER NOT NULL DEFAULT 0,      -- gates ABS/ASA/PC/PA
  hardened_nozzle INTEGER NOT NULL DEFAULT 0, -- gates every CF/GF filament
  -- The finest tier this machine is trusted to hit. A customer asking for
  -- 0.08mm layers should not be matched to a shop that only does 0.28.
  quality_max TEXT NOT NULL DEFAULT 'fine'
    CHECK (quality_max IN ('draft','standard','fine','ultra')),
  -- NULL = use the platform default for this technology. A merchant who has
  -- costed their own machine beats a platform average.
  machine_hour_iqd INTEGER,
  availability TEXT NOT NULL DEFAULT 'available'
    CHECK (availability IN ('available','busy','offline')),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_merchant_printers_merchant
  ON merchant_printers(merchant_id, active, sort_order);

-- ------------------------------------- 3. WHICH REQUESTS A MERCHANT WANTS TOLD
-- `merchant_notification_preferences.request_opportunities` already exists and
-- is the MASTER SWITCH — it is not duplicated here. What is missing is the
-- filter: which requests, out of the ones they could technically take, they
-- want to hear about. A shop that can print TPU but hates the job should be
-- able to say so without lying about their machine.
CREATE TABLE IF NOT EXISTS merchant_request_prefs (
  merchant_id TEXT PRIMARY KEY REFERENCES community_merchants(id) ON DELETE CASCADE,
  -- Empty array means NO FILTER — "everything my printers can do". That is the
  -- right default: a merchant who has said nothing wants the work.
  processes TEXT NOT NULL DEFAULT '[]',     -- ['fdm','resin']
  materials TEXT NOT NULL DEFAULT '[]',
  colors TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',  -- multicolor|large_format|high_detail|functional|flexible|cf
  governorates TEXT NOT NULL DEFAULT '[]',
  delivery TEXT NOT NULL DEFAULT '[]',      -- ['delivery','pickup']
  min_job_iqd INTEGER NOT NULL DEFAULT 0,
  max_job_iqd INTEGER,                      -- NULL = no ceiling
  min_size_mm INTEGER NOT NULL DEFAULT 0,   -- longest edge; below this, not worth it
  max_size_mm INTEGER,                      -- NULL = whatever the printers allow
  -- Self-declared load. It never blocks a match; it only lowers the rank, so a
  -- busy shop still hears about a job nobody else can take.
  workload TEXT NOT NULL DEFAULT 'normal'
    CHECK (workload IN ('light','normal','busy','full')),
  -- The owner's "Pause request notifications". Honoured absolutely.
  paused INTEGER NOT NULL DEFAULT 0,
  paused_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------------------ 4. THE PRINT SIDE OF A REQUEST
-- One row per request that came through the print wizard. A SIDE TABLE, not new
-- columns on community_requests, for one reason: `publicRequest()` in
-- worker/routes/marketplace.ts is a whitelist that decides what a merchant may
-- see about a customer, and widening the table it reads from is how a privacy
-- whitelist quietly stops being one.
CREATE TABLE IF NOT EXISTS community_print_requests (
  request_id TEXT PRIMARY KEY REFERENCES community_requests(id) ON DELETE CASCADE,
  process TEXT NOT NULL DEFAULT 'fdm' CHECK (process IN ('fdm','resin')),
  material_id TEXT NOT NULL DEFAULT '',
  color_hex TEXT NOT NULL DEFAULT '',
  color_name TEXT NOT NULL DEFAULT '',
  quality TEXT NOT NULL DEFAULT 'standard'
    CHECK (quality IN ('draft','standard','fine','ultra')),
  infill_percent INTEGER NOT NULL DEFAULT 20,
  supports INTEGER NOT NULL DEFAULT 1,
  colors_count INTEGER NOT NULL DEFAULT 1,
  post_processing_minutes INTEGER NOT NULL DEFAULT 0,
  -- Which attached file is THE model. The others are references and drawings.
  primary_file_id TEXT REFERENCES community_request_files(id) ON DELETE SET NULL,

  -- The external source, when the customer pasted a link instead of a file.
  source_kind TEXT NOT NULL DEFAULT 'upload'
    CHECK (source_kind IN ('upload','link')),
  source_provider TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  source_meta TEXT NOT NULL DEFAULT '{}',

  -- The measurement and the estimate, SNAPSHOT at publish time. Stored rather
  -- than recomputed because the catalogue moves: a merchant reading the request
  -- next week must see the numbers the customer was actually shown, and the
  -- price protection that follows depends on that not drifting.
  analysis TEXT NOT NULL DEFAULT '{}',
  estimate TEXT NOT NULL DEFAULT '{}',
  estimate_low_iqd INTEGER,
  estimate_high_iqd INTEGER,
  estimate_confidence TEXT NOT NULL DEFAULT ''
    CHECK (estimate_confidence IN ('','high','medium','low')),

  -- 0..100. What the wizard filled in, so the UI can nudge without demanding.
  completeness INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------- 5. WHAT WE MEASURED ABOUT EACH FILE
-- The analysis belongs to the FILE, not to the request: the same request may
-- carry three models and a drawing, and re-uploading a file must not silently
-- keep the previous file's dimensions.
ALTER TABLE community_request_files ADD COLUMN model_format TEXT NOT NULL DEFAULT '';
ALTER TABLE community_request_files ADD COLUMN analysis TEXT NOT NULL DEFAULT '';
ALTER TABLE community_request_files ADD COLUMN analysed_at TEXT;

-- ------------------------------------------------- 6. WHO WAS TOLD, AND WHY
-- The audit that proves the architecture. Every row here is a NOTIFICATION
-- DECISION about ONE request — including the merchants that were considered and
-- rejected, with the reason. Not a request, not an invitation, not a job: read
-- this table and you can answer "why did shop X never hear about this?" without
-- guessing, which is the question that otherwise has no answer.
CREATE TABLE IF NOT EXISTS community_request_matches (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  eligible INTEGER NOT NULL DEFAULT 0,
  -- Machine-readable, e.g. 'BUILD_VOLUME' | 'MATERIAL' | 'PAUSED' | 'PROCESS'.
  reject_reason TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  score_detail TEXT NOT NULL DEFAULT '{}',
  notified INTEGER NOT NULL DEFAULT 0,
  notification_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_matches_pair
  ON community_request_matches(request_id, merchant_id);
CREATE INDEX IF NOT EXISTS idx_request_matches_request
  ON community_request_matches(request_id, eligible, score DESC);

-- --------------------------------------------------- 7. THE VIEWER'S TOKEN
-- "/model-viewer/{secureToken}" — a link that opens the 3D preview without
-- signing in, and WITHOUT the model file ever becoming a public object.
--
-- The token is stored HASHED, exactly as tg_admin_actions does it (0017): the
-- table is then useless to anyone who reads it, and a leaked backup does not
-- leak the links. It expires, it can be revoked, and what it grants is the
-- DERIVED preview mesh — never the uploaded file.
CREATE TABLE IF NOT EXISTS model_view_tokens (
  token_hash TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES community_request_files(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_model_view_tokens_file ON model_view_tokens(file_id);

-- ------------------------------------------------------ 8. THE CACHED MESH
-- Parsing a 40MB model on every viewer load would be slow and wasteful, and the
-- preview never changes once the file is stored. The derived LVM1 mesh is
-- written to R2 beside the original under a separate prefix; this column is the
-- only thing that says it is there.
ALTER TABLE community_request_files ADD COLUMN preview_key TEXT NOT NULL DEFAULT '';
