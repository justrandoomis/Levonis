-- ============================================================================
--  0130 — PRINT REQUESTS v2: THE JOB HAS REVISIONS, THE OFFER HAS REVISIONS,
--         AND THE ORDER KEEPS THE ONE THAT WAS ACCEPTED.
-- ============================================================================
-- NONDESTRUCTIVE: two new tables, ADD COLUMNs with constant defaults, one
-- index, and two INSERT … SELECT backfills that only ADD rows (OR IGNORE, so
-- a re-run adds nothing). No table is rebuilt, no CHECK is touched, and no
-- request, offer, order, escrow or money row is rewritten.
-- Stream W5-A (docs/merchant-platform/audit/03 §9 G1–G5, G15–G17, §11 items
-- 9–12 and 19–20; docs/MERCHANT_PLATFORM.md §4.7).
--
-- ---------------------------------------------------------------------------
--  1. community_request_revisions — WHAT A MERCHANT PRICED
-- ---------------------------------------------------------------------------
-- 0116 gave the request a revision NUMBER and the offer the number it priced;
-- nothing recorded what that number MEANT. A merchant told «the customer
-- changed the job» could not see the change, and the order kept the offer's
-- promise but not the job it was a promise about. One row per (request,
-- revision): the spec, the attachment list and the estimate as they stood,
-- and a hash of the priced facts. Written by the publish path and by an
-- attachment change on a published job (worker/lib/requestRevisions.ts);
-- the order copies its accepted revision into `request_snapshot` (§4).
--
-- A revision is created by a MATERIAL change AFTER THE FIRST OFFER. A change
-- nobody priced yet rewrites the current revision's row in place: there is no
-- offer it could strand.
--
-- ---------------------------------------------------------------------------
--  2. community_offer_revisions — WHAT THE CUSTOMER SAW
-- ---------------------------------------------------------------------------
-- An edit is a new offer revision (0116); the customer accepts exactly the
-- revision and price they saw. The terms of every revision are kept here so
-- the customer's comparison can say «السعر كان 50,000» and a dispute can read
-- what was on screen. Append-only by convention: every writer INSERTs.
--
-- ---------------------------------------------------------------------------
--  3. The request's new facts
-- ---------------------------------------------------------------------------
--   community_requests.customer_notes   notes FOR the merchants, a real
--        column. The old wizard stashed the model link in `notes`, which is
--        why `notes` stays private and is never shown; this one is shown.
--   community_requests.published_at     when the draft became public.
--   community_print_requests.source_type    model | link | images |
--        description. `source_kind` keeps its 0045 CHECK (upload | link) and
--        its meaning for every old reader.
--   community_print_requests.process_unsure / material_unsure   «لست
--        متأكدًا». `process` keeps its CHECK (fdm | resin), so an unsure
--        process is stored as 'fdm' WITH the flag; every reader in this
--        codebase goes through one helper that answers null for it.
--   community_print_requests.stated_dims    dimensions the customer TYPED
--        (JSON {x,y,z} mm) when there is no measured model. Measured geometry
--        always wins.
--   community_offers.material_ids   the offer's materials from the
--        catalogue (JSON array of ids). `materials` stays the free-text note.
--
-- ---------------------------------------------------------------------------
--  4. The order keeps the job and the contact it was accepted on
-- ---------------------------------------------------------------------------
--   community_orders.request_revision   the job revision accepted.
--   community_orders.request_snapshot   that revision's spec/files/estimate.
--   community_orders.contact_snapshot   the customer's delivery contact for
--        the merchant and the merchant's contact for the customer, written at
--        acceptance and never before (§4.7: contact is revealed on accept).
--
-- ---------------------------------------------------------------------------
--  5. Backfill — every existing row keeps meaning what it meant
-- ---------------------------------------------------------------------------
-- A published request gets its CURRENT revision recorded from what it holds
-- now (hash 'legacy', reason 'backfill'), so an offer on an old request
-- references a revision row like a new one does. A draft gets none: nobody
-- priced it. Every existing offer gets its current revision recorded.
-- ============================================================================

CREATE TABLE IF NOT EXISTS community_request_revisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  spec TEXT NOT NULL DEFAULT '{}',
  files TEXT NOT NULL DEFAULT '[]',
  estimate TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT 'publish'
    CHECK (reason IN ('publish','edit','files','backfill')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (request_id, revision)
);

CREATE TABLE IF NOT EXISTS community_offer_revisions (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES community_offers(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  request_revision INTEGER NOT NULL DEFAULT 1,
  price_iqd INTEGER NOT NULL,
  terms TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT 'create'
    CHECK (reason IN ('create','edit','reconfirm','backfill')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (offer_id, revision)
);

ALTER TABLE community_requests ADD COLUMN customer_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE community_requests ADD COLUMN published_at TEXT;

ALTER TABLE community_print_requests ADD COLUMN source_type TEXT NOT NULL DEFAULT '';
ALTER TABLE community_print_requests ADD COLUMN process_unsure INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_print_requests ADD COLUMN material_unsure INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_print_requests ADD COLUMN stated_dims TEXT NOT NULL DEFAULT '';

ALTER TABLE community_offers ADD COLUMN material_ids TEXT NOT NULL DEFAULT '[]';

ALTER TABLE community_orders ADD COLUMN request_revision INTEGER;
ALTER TABLE community_orders ADD COLUMN request_snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE community_orders ADD COLUMN contact_snapshot TEXT NOT NULL DEFAULT '{}';

-- The abandoned-draft and expiry sweeps ask «state X, past its expiry».
CREATE INDEX IF NOT EXISTS idx_community_requests_state_expires
  ON community_requests(state, expires_at);

-- 5. Backfill: the current revision of every published request, as it stands.
INSERT OR IGNORE INTO community_request_revisions
  (id, request_id, revision, spec, files, estimate, hash, reason, created_by, created_at)
SELECT 'crv_' || r.id || '_' || r.revision,
       r.id,
       r.revision,
       json_object(
         'title', r.title,
         'quantity', r.quantity,
         'process', p.process,
         'material_id', COALESCE(p.material_id, r.material),
         'color_hex', p.color_hex,
         'color_name', COALESCE(p.color_name, r.color),
         'quality', p.quality,
         'dimensions', r.dimensions,
         'governorate', r.governorate,
         'delivery_pref', r.delivery_pref,
         'deadline', r.deadline,
         'source_kind', p.source_kind,
         'source_url', p.source_url,
         'primary_file_id', p.primary_file_id
       ),
       (SELECT json_group_array(json_object('id', f.id, 'kind', f.kind, 'content_type', f.content_type,
                                            'size_bytes', f.size_bytes, 'file_name', f.file_name))
          FROM community_request_files f WHERE f.request_id = r.id),
       COALESCE(p.estimate, '{}'),
       'legacy',
       'backfill',
       r.customer_id,
       COALESCE(r.updated_at, r.created_at)
  FROM community_requests r
  LEFT JOIN community_print_requests p ON p.request_id = r.id
 WHERE r.state <> 'draft';

INSERT OR IGNORE INTO community_offer_revisions
  (id, offer_id, revision, request_revision, price_iqd, terms, reason, created_at)
SELECT 'cor_' || o.id || '_' || o.revision,
       o.id,
       o.revision,
       o.request_revision,
       o.price_iqd,
       json_object(
         'completion_days', o.completion_days,
         'delivery_method', o.delivery_method,
         'materials', o.materials,
         'included', o.included,
         'warranty_terms', o.warranty_terms,
         'message', o.message,
         'expires_at', o.expires_at
       ),
       'backfill',
       COALESCE(o.updated_at, o.created_at)
  FROM community_offers o;
