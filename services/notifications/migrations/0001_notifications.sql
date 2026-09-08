-- levonis-notifications — the service's OWN database
-- (`levonis-notifications-db` / `-dark`).
-- Owning service: notifications (`01-TARGET.md` §2.1).
--
-- Applied by `svc-notifications.yml` against this D1 only. It is NOT part of
-- the root `migrations/` stream and never touches the shared core database:
-- the monolith keeps its own `outbox`, `user_notifications` and
-- `telegram_updates` rows and keeps sending from them until Phase 3
-- (`02-MIGRATION-PLAN.md` 1.7 — "WITHOUT removing the monolith copies").
--
-- `test/migrations.test.ts` applies this file twice against a fresh SQLite
-- database and proves the second pass is a no-op, which is the guarantee
-- `scripts/migrate-check.mjs --twice` gives the root stream.

-- ------------------------------------------------------------ the inbox
-- `notify_outbox` is the legacy `outbox` SHAPE, column for column, so the
-- monolith's rows can be copied across in Phase 3 with an INSERT SELECT and no
-- transform. Compare with `migrations/0003_final_phase.sql`:
--
--   id, kind, event_key (UNIQUE), recipient, payload, state, attempts,
--   last_error, created_at, sent_at
--
-- Two things are deliberately identical rather than "improved":
--
--   * `event_key` is UNIQUE. It is the idempotency of this whole service — the
--     same business event enqueued twice is one row, and it is the value sent
--     to the provider as `Idempotency-Key`, so an ambiguous first attempt
--     (a timeout after the provider accepted) cannot double-send.
--   * the `state` CHECK has no transient `sending` value. The claim is the
--     attempts bump itself (a compare-and-swap), exactly as `processOutbox`
--     does it today, so two processors can never send the same row.
--
-- It is called an INBOX in the design because in the target architecture the
-- rows arrive from the bus rather than from a business write in the same
-- database. The columns do not care, and matching the legacy shape is worth
-- more than matching the name.
CREATE TABLE IF NOT EXISTS notify_outbox (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('email','telegram')),
  event_key   TEXT NOT NULL UNIQUE,
  recipient   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed','dead','skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notify_outbox_state ON notify_outbox(state, created_at);

-- ------------------------------------------------- in-app notifications
-- A copy of `user_notifications` (`migrations/0045_print_requests.sql`) with
-- ONE difference: no `REFERENCES users(id)`. Identity owns `users` and it is
-- not in this database, so the foreign key cannot exist here — which is the
-- ordinary consequence of a service owning its own store, not a weakening.
-- Everything the feature actually depends on is kept: the per-language
-- columns, the in-app path, and the UNIQUE (user_id, event_key) index that
-- makes telling the same person about the same thing twice impossible rather
-- than merely unlikely.
CREATE TABLE IF NOT EXISTS user_notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title_ar    TEXT NOT NULL DEFAULT '',
  title_en    TEXT NOT NULL DEFAULT '',
  body_ar     TEXT NOT NULL DEFAULT '',
  body_en     TEXT NOT NULL DEFAULT '',
  link        TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',
  meta        TEXT NOT NULL DEFAULT '{}',
  event_key   TEXT NOT NULL DEFAULT '',
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user
  ON user_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notifications_event
  ON user_notifications(user_id, event_key) WHERE event_key <> '';

-- ------------------------------------------------------------ deliveries
-- The per-attempt record behind `GET /api/v1/notifications/admin/deliveries`
-- (`packages/contracts/src/http/notifications.ts`). `notify_outbox` is the
-- work queue; this is the history, and it is what an operator reads when a
-- customer says the mail never arrived.
--
-- `event_key` is the provider `Idempotency-Key`: one delivery per key, forever.
CREATE TABLE IF NOT EXISTS notify_deliveries (
  id           TEXT PRIMARY KEY,
  event_key    TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('inapp','email','telegram')),
  template     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('pending','sent','failed','dead','dropped')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT,
  UNIQUE (event_key, channel)
);
CREATE INDEX IF NOT EXISTS idx_notify_deliveries_status ON notify_deliveries(status, created_at);

-- ------------------------------------------------------ webhook ingress
-- Telegram redelivers an update until it is acknowledged, so the dedup is the
-- primary key, as it already is in `migrations/0003_final_phase.sql`. The
-- webhook answers 200 to every well-formed update — anything else and Telegram
-- retries forever — and a replay is reported `duplicate: true`.
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id   INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------- platform tables
-- `<svc>_processed_events` and `<svc>_idempotency` (`01-TARGET.md` §4 item 10,
-- `03-EVENTS.md` §2.3), kept in step with the platform kit's own SQL by
-- `test/migrations.test.ts`.
CREATE TABLE IF NOT EXISTS notifications_processed_events (
  event_id     TEXT PRIMARY KEY,
  consumer     TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  result       TEXT
);

CREATE TABLE IF NOT EXISTS notifications_idempotency (
  service      TEXT NOT NULL,
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (service, scope, key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_idempotency_created ON notifications_idempotency(created_at);
