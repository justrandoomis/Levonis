-- ============================================================================
--  0160 — THE REQUEST'S DISCUSSION AND THE ORDER'S TIMELINE
--         (docs/COMMUNITY_ECOSYSTEM.md §9.5, Phase 5b)
-- ============================================================================
-- Two conversations that had nowhere to live:
--
--   · THE DISCUSSION UNDER A REQUEST — a public comment while the job is on
--     the board, a workshop's question, the customer's answer, and the
--     server's own «تغيّر الطلب» / «قُبل عرض» / «أُغلق» rows written beside
--     them (`system_update`), so the page reads as one thread rather than a
--     comment list next to a changelog.
--   · THE ORDER'S TIMELINE — what the workshop did between «بدأ التنفيذ» and
--     «تم التسليم»: progress notes, photos, «جاهز», and the customer's own
--     «اطلب تعديلًا». «ready» is a timeline event inside `in_progress`, never
--     a state: the order's CHECK is not widened, no money moves.
--
-- ADDITIVE: three new tables and two nullable columns. `community_reports`
-- keeps its 0154 CHECK (post|comment|user|store|product|request) — a report
-- of a request comment is filed as target_type 'comment' and a report of an
-- order update as 'request', and the side table below says which row is
-- really meant, so the moderation queue resolves the real target without a
-- rebuild.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  THE DISCUSSION. `author_id` is NULL for a `system_update` row (the server
--  wrote it; `body` then carries `{"code": …, "meta": …}` as JSON). One level
--  of replies (`parent_id`): a customer's answer names the question it answers.
--  `state` follows 0154's comments: removed by its author (omitted from the
--  thread), hidden by Levonis with a reason (shown to staff only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_request_comments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES community_request_comments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('public_comment','merchant_question','customer_answer','system_update')),
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'visible' CHECK (state IN ('visible','removed','hidden')),
  admin_hidden_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_request_comments_request ON community_request_comments(request_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_request_comments_author ON community_request_comments(author_id, created_at DESC);

-- ---------------------------------------------------------------------------
--  THE TIMELINE. `started` and `delivered` are written by the order's own
--  routes; the merchant writes progress|photo|ready|note, the customer
--  modification_request (only before delivery). `file_key` is a PRIVATE key
--  under community-orders/<orderId>/updates/… and never leaves the server: a
--  party reads the bytes through the order's own file route.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_order_updates (
  id TEXT PRIMARY KEY,
  community_order_id TEXT NOT NULL REFERENCES community_orders(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('started','progress','photo','ready','note','modification_request','delivered')),
  body TEXT NOT NULL DEFAULT '',
  file_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_order_updates_order ON community_order_updates(community_order_id, created_at, id);

-- «بدأ التنفيذ» and «جاهز» as instants on the order itself, beside
-- delivered_at / confirmed_at / completed_at (0031). Neither is a state.
ALTER TABLE community_orders ADD COLUMN ready_at TEXT;
ALTER TABLE community_orders ADD COLUMN started_at TEXT;

-- ---------------------------------------------------------------------------
--  WHICH ROW A REPORT REALLY NAMES. One row per report, written in the same
--  batch as the report (cascade with it): kind request_comment → target_id is
--  a community_request_comments id (the report's own target_type is
--  'comment'); kind order_update → a community_order_updates id (the report
--  is filed under 'request' with the request id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_report_targets (
  report_id TEXT PRIMARY KEY REFERENCES community_reports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('request_comment','order_update')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_report_targets_target ON community_report_targets(kind, target_id);
