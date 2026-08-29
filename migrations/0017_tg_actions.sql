-- Levonis migration 0017 — Telegram admin-group wallet notifications and
-- fast approval buttons (integrated mandate §12.1 "admin group message",
-- §12.2 "button and server protection", §12.3 "reliable send without
-- duplicating money").
--
-- NONDESTRUCTIVE: three NEW tables plus their indexes. Nothing in 0001–0016
-- is dropped, rebuilt, backfilled or recomputed. No column is added to
-- wallet_transactions — the ledger stays exactly as it is; a Telegram
-- notification is a delivery artefact, never a financial fact.
--
-- WHY THREE TABLES
-- ----------------
--   admin_tg_identities     WHO may decide from Telegram. §12.2: "presence in
--                           the group, being a Telegram admin, or a matching
--                           name does NOT grant financial authority on the
--                           site". Authority is a SEEDED mapping to a site
--                           user that must ALSO still hold role='admin' at
--                           the moment of the click (checked by a JOIN in
--                           worker/lib/walletNotify.ts — never cached here).
--   tg_admin_notifications  The reliable-send record (§12.3): one row per
--                           business event, UNIQUE on event_key so retries,
--                           429s and lost responses can never enqueue a
--                           second message, let alone a second ledger entry.
--                           It also stores the message reference that the
--                           callback must match, and the dead-letter state
--                           an admin can see and retry.
--   tg_admin_actions        WHAT a button is allowed to do (§12.2): a short,
--                           unguessable, server-bound, expiring action token.
--                           callback_data carries ONLY the raw token; the
--                           row here carries the request id and the action.
--                           No amount and no user_id ever travel in a button.
--
-- WHAT IS DELIBERATELY **NOT** HERE
--   * No amount column on tg_admin_actions. A button must never be able to
--     tell the server how much money to move.
--   * No raw token column anywhere: only its SHA-256 digest is stored, so a
--     database read cannot forge a click (the same rule link_challenges and
--     otp_challenges already follow).
--   * No public URL for the proof image. The photo is uploaded to Telegram
--     as multipart bytes read from private R2; the key stays internal.
--   * No FK from tg_admin_notifications.request_id to wallet_transactions:
--     the same machinery serves withdrawals (whose lifecycle lives in
--     wallet_withdrawals, migration 0015), and a notification must survive
--     for audit even if its subject row is ever archived.

-- ------------------------------------------------- who may decide from TG
--
-- Seeded manually by an existing site admin through
-- POST /api/telegram/admin/tg-identities (requireAdmin) — never by the bot,
-- never by joining the group, never by /start.
CREATE TABLE admin_tg_identities (
  telegram_user_id INTEGER PRIMARY KEY,        -- callback_query.from.id
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',               -- human note ("finance – Ali")
  created_by TEXT REFERENCES users(id),         -- the admin who seeded it
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id),
  revoke_reason TEXT NOT NULL DEFAULT '',
  -- A revocation must say who did it and why: silent de-authorization would
  -- leave an unauditable hole in a financial approval path.
  CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revoke_reason <> ''))
);
-- One site admin owns at most ONE live Telegram identity: two live mappings
-- would make "who approved this" ambiguous in the ledger and the audit log.
CREATE UNIQUE INDEX idx_admin_tg_identity_user
  ON admin_tg_identities(user_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------ the reliable send record
CREATE TABLE tg_admin_notifications (
  id TEXT PRIMARY KEY,
  -- Business-event identity (§12.3 "a dedup key per event, recipient and
  -- channel"). e.g. 'wallet.deposit.requested:wtx_x:tg_admin'. UNIQUE, so a
  -- replayed enqueue is a no-op instead of a second group message.
  event_key TEXT NOT NULL UNIQUE,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('deposit','withdrawal')),
  request_id TEXT NOT NULL,
  -- Configured destination as it was at enqueue time (numeric id or @name);
  -- kept verbatim so a later settings change cannot silently retarget a
  -- pending message.
  target_chat TEXT NOT NULL,
  -- Resolved numeric chat id + message id, written ONLY from Telegram's own
  -- send response. Together they are the reference every callback must
  -- match (§12.2 "verify the original chat_id and message_id"): a forwarded
  -- or copied button from another group cannot pass.
  chat_id INTEGER,
  message_id INTEGER,
  -- Private R2 key of the proof image. NEVER a URL, never exposed; the
  -- worker reads the bytes and uploads them to Telegram as multipart.
  photo_key TEXT NOT NULL DEFAULT '',
  -- Pre-rendered, already-sanitized plain-text caption. Stored so a retry
  -- re-sends exactly the reviewed content and never re-derives it from
  -- mutable user data.
  caption TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','sent','failed','dead','skipped')),
  -- Honest record of HOW it went out: 'photo' = the proof really is
  -- attached; 'text' = the image could not be attached and the message says
  -- so (§12.1 "if a photo cannot be sent, the operation still shows up for
  -- review and is never dropped").
  sent_as TEXT NOT NULL DEFAULT '' CHECK (sent_as IN ('','photo','text')),
  -- Why the proof could not be attached, when it could not. Kept so the
  -- FINAL edit of the message repeats the same honest sentence instead of
  -- silently reverting to "attached" when it never was.
  delivery_note TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  -- Terminal presentation state of the group message after a decision.
  closed_state TEXT NOT NULL DEFAULT ''
    CHECK (closed_state IN ('','approved','rejected','closed')),
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  -- A row may only claim to be sent if it carries the message reference and
  -- says how it was delivered. "Sent" is otherwise unfalsifiable.
  CHECK (state <> 'sent' OR (message_id IS NOT NULL AND chat_id IS NOT NULL AND sent_as <> '')),
  CHECK (closed_at IS NULL OR closed_state <> '')
);
CREATE INDEX idx_tg_notif_state ON tg_admin_notifications(state, created_at);
CREATE INDEX idx_tg_notif_request ON tg_admin_notifications(request_kind, request_id);
-- Dead-letter view for the admin list (§12.3 "administration gets a failed
-- list and a retry — not a button that duplicates the balance").
CREATE INDEX idx_tg_notif_dead ON tg_admin_notifications(created_at DESC)
  WHERE state IN ('failed','dead');

-- ---------------------------------------------------------- action tokens
CREATE TABLE tg_admin_actions (
  -- SHA-256 hex of the raw token. The raw value lives ONLY inside
  -- callback_data on the button; it is never stored, logged or returned.
  token_hash TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES tg_admin_notifications(id) ON DELETE CASCADE,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('deposit','withdrawal')),
  request_id TEXT NOT NULL,
  -- 'approve' / 'reject' are DECISIONS (single-use, consuming).
  -- 'reject_menu' / 'menu_main' only redraw the keyboard so a rejection can
  --   pick a reason (§12.2 "rejection needs a selectable, recorded reason");
  --   they move no money and are therefore replayable until expiry.
  action TEXT NOT NULL CHECK (action IN ('approve','reject','reject_menu','menu_main')),
  -- Selected rejection reason code; empty for every other action.
  reason_code TEXT NOT NULL DEFAULT '',
  -- Bound to the delivered message AFTER a successful send. NULL means the
  -- token cannot be used yet: validation requires an exact match against the
  -- chat and message the callback actually came from.
  chat_id INTEGER,
  message_id INTEGER,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT REFERENCES users(id),        -- site admin resolved from the TG identity
  consumed_tg_user_id INTEGER,
  -- Why it was consumed: 'decided' (this click performed the transition),
  -- 'lost_race' (another decision won first), 'superseded' (a sibling button
  -- of the same message became irrelevant once the request was decided).
  outcome TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Decisions carry a reason only where one is meaningful, and a consumed
  -- token must always record what became of it.
  CHECK (reason_code = '' OR action = 'reject'),
  CHECK (consumed_at IS NULL OR outcome <> '')
);
CREATE INDEX idx_tg_actions_notif ON tg_admin_actions(notification_id);
CREATE INDEX idx_tg_actions_request ON tg_admin_actions(request_kind, request_id, consumed_at);
