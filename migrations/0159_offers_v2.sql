-- ============================================================================
--  0159 — OFFERS V2 + WORKSHOP FACTS (docs/COMMUNITY_ECOSYSTEM.md §9.5, Phase 5a)
-- ============================================================================
-- An offer on a print request grows the terms a customer actually compares —
-- the delivery fee (the total is price + fee, computed on the server), the
-- quantity it prices, the colour, the merchant's terms — and may carry files
-- (a photo of a sample, a PDF quote, a model). A merchant can also SAVE an
-- offer before sending it.
--
-- WHY DRAFTS ARE THEIR OWN TABLE. 0031's one-live-offer index is
--
--     CREATE UNIQUE INDEX idx_community_offers_one_live
--       ON community_offers(request_id, merchant_id)
--       WHERE state IN ('pending','accepted');
--
-- and the state CHECK is closed, so a draft stored as a `pending` row with
-- `is_draft = 1` would collide with the same merchant's later live offer, and
-- every existing reader of `state = 'pending'` (the customer's list, the
-- count, the sweeps, the accept) would have to learn to skip it. A draft is
-- therefore a row in `community_offer_drafts` — a payload the eligibility-
-- fenced offer INSERT reads on «send» in the same batch that deletes it —
-- and nothing that reads `community_offers` ever sees one. `is_draft` is
-- still added to `community_offers` as the spec names it, DEFAULT 0 on every
-- row, reserved for the release that rebuilds the index with `AND is_draft = 0`
-- and moves drafts inline; no reader branches on it today.
--
-- WORKSHOP FACTS on `merchant_request_prefs`: the merchant's own turnaround
-- and intro, and two DERIVED columns (technologies, the largest bed) that the
-- printer and prefs saves recompute from `merchant_printers` — the public
-- store page reads them without joining the printers.
--
-- ADDITIVE: ADD COLUMNs with defaults and two new tables. No CHECK is rebuilt,
-- no row is rewritten.
-- ============================================================================

ALTER TABLE community_offers ADD COLUMN delivery_fee_iqd INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_iqd >= 0);
ALTER TABLE community_offers ADD COLUMN quantity INTEGER;
ALTER TABLE community_offers ADD COLUMN color TEXT NOT NULL DEFAULT '';
ALTER TABLE community_offers ADD COLUMN terms TEXT NOT NULL DEFAULT '';
ALTER TABLE community_offers ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0,1));

-- The files a SENT offer carries. `file_key` is a private object under the
-- merchant's own upload prefix (purpose `offer`, worker/lib/uploadEntity.ts),
-- checked in `file_objects` by owner before the row is written; it never
-- leaves the server — parties read through /api/marketplace/offers/:id/files/:fileId.
CREATE TABLE IF NOT EXISTS community_offer_files (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES community_offers(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','pdf','model')),
  name TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  content_type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (offer_id, file_key)
);
CREATE INDEX IF NOT EXISTS idx_community_offer_files_offer
  ON community_offer_files(offer_id, created_at);

-- «احفظ مسودة»: one per (request, merchant). `payload_json` holds the offer
-- terms exactly as the offer route validated them; `files_json` the checked
-- file list. «send» validates the payload again, inserts the offer through the
-- same fenced statement a new offer uses, and deletes this row in that batch.
CREATE TABLE IF NOT EXISTS community_offer_drafts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  files_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (request_id, merchant_id)
);
CREATE INDEX IF NOT EXISTS idx_community_offer_drafts_merchant
  ON community_offer_drafts(merchant_id, updated_at DESC);

-- Workshop facts: the merchant's own word (turnaround, intro) and what is
-- derived from their printers on every printer or prefs save.
ALTER TABLE merchant_request_prefs ADD COLUMN turnaround_days INTEGER;
ALTER TABLE merchant_request_prefs ADD COLUMN technologies TEXT NOT NULL DEFAULT '[]';
ALTER TABLE merchant_request_prefs ADD COLUMN max_build_mm TEXT NOT NULL DEFAULT '{}';
ALTER TABLE merchant_request_prefs ADD COLUMN workshop_intro TEXT NOT NULL DEFAULT '';
