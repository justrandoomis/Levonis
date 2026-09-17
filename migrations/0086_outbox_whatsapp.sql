-- Levonis migration 0086 — the outbox learns a third channel: WHATSAPP.
--
-- `outbox.kind` has been `CHECK (kind IN ('email','telegram'))` since 0003,
-- and SQLite cannot alter a CHECK in place. So this is the table-rebuild
-- pattern migration 0011 already used for link_challenges: create the new
-- shape, copy every row, drop, rename, recreate the index. Nothing references
-- outbox by foreign key, and the copy is a plain `SELECT *`-shaped insert, so
-- no row and no queue state is lost — a pending row stays pending and is
-- picked up by the next cron exactly as before.
--
-- WHY WHATSAPP BELONGS IN THE OUTBOX AND NOT IN A DIRECT CALL.
--
-- WasenderAPI drives a real WhatsApp account, and its published send limit is
-- as low as ONE MESSAGE PER FIVE SECONDS when Account Protection is on (and
-- 1/minute, 50/day on a trial plan). A shop that ships four orders in the same
-- minute would, on a direct-send design, simply lose three notifications to a
-- 429. The outbox already has exactly the machinery that answers this: a
-- unique event key so a replay is a no-op, a claim-and-bump so two processors
-- never double-send, bounded attempts, and a cron that drains it. A 429
-- becomes a retry instead of a silent loss.
--
-- The OTP does NOT go through here — a customer staring at a sign-in form
-- cannot wait for a 15-minute cron. That path sends directly and reports
-- RATE_LIMITED honestly when the provider says so.
--
-- `recipient` holds the E.164 number for this kind (the same column holds an
-- email address or a Telegram chat id for the other two). The staging
-- allowlist in lib/outbox.ts applies to email only, deliberately: it exists to
-- stop a staging deploy mailing a real customer, and the WhatsApp channel is
-- gated instead by whether WASENDER_API_KEY is present at all.

PRAGMA defer_foreign_keys = true;

CREATE TABLE outbox_v2 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'telegram', 'whatsapp')),
  event_key TEXT NOT NULL UNIQUE,       -- e.g. invoice:ORD-X:1, order.placed:<id>:wa
  recipient TEXT NOT NULL,              -- email address, chat id, or E.164 number
  payload TEXT NOT NULL,                -- JSON (subject/body/template ref)
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'dead', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT
);

INSERT INTO outbox_v2 (id, kind, event_key, recipient, payload, state, attempts, last_error, created_at, sent_at)
SELECT id, kind, event_key, recipient, payload, state, attempts, last_error, created_at, sent_at FROM outbox;

DROP TABLE outbox;
ALTER TABLE outbox_v2 RENAME TO outbox;

CREATE INDEX idx_outbox_state ON outbox(state, created_at);
