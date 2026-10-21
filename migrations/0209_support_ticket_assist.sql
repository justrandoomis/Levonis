-- 0209 — WHAT THE ASSISTANT HANDS THE TEAM (support assistant v2, push A).
--
-- «تحدث مع الفريق» at the end of the printer-problem triage opens a ticket
-- that already says which printer, which symptom and which steps were tried,
-- and carries the photos, clips and voice notes attached in the assistant
-- chat. Two things are stored for that, and both are additive:
--
--   support_tickets.handoff_summary
--       The triage's closed-set summary as JSON (model token, symptom key,
--       step keys tried, an HMS code, the product ids shown, the number of
--       attachments). Written once, by the ticket door, after
--       worker/lib/assist/handoff.ts `readHandoff` kept only closed-set
--       values. STAFF ONLY: the customer's own ticket read never returns it.
--       NULL on every ticket written before this, and on every ticket that
--       did not come from the triage.
--
--   support_ticket_attachments
--       One row per assistant attachment handed to a ticket. The object
--       lives under `assist/<uploader id>/<attachments|video|audio>/…`
--       (private); this row is what lets staff read it (worker/routes/uploads.ts
--       `/files` gate: the uploader always, an admin only once a row names
--       the key) and what keeps the retention sweep away from it
--       (worker/lib/mediaRefs.ts registers `file_key`). Audio is why this is
--       its own table: support_ticket_messages.kind is CHECKed to
--       text/image/video (0107).
--
-- Additive only: one nullable column and one new table. An older Worker never
-- reads or writes either; the ticket door detects the column before naming it
-- and refuses attachments by name (ATTACHMENTS_UNAVAILABLE) on a database
-- before 0209, and every read tolerates the absence of both.
ALTER TABLE support_tickets ADD COLUMN handoff_summary TEXT;

CREATE TABLE IF NOT EXISTS support_ticket_attachments (
  ticket_id  TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  file_key   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
  mime_type  TEXT NOT NULL DEFAULT '',
  byte_size  INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (ticket_id, file_key)
);

-- The `/files` gate asks «does any ticket name this key?» on every staff read.
CREATE INDEX IF NOT EXISTS idx_support_ticket_attachments_key ON support_ticket_attachments(file_key);
