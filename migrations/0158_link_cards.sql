-- LINK CARDS (docs/COMMUNITY_ECOSYSTEM.md §9.4 — "Link cards"). Additive only:
-- one new table, nothing rebuilt.
--
-- WHAT A ROW IS. One URL somebody pasted into a conversation, a request
-- comment or a project body, and what the server learned about it ONCE on
-- everybody's behalf: the host, the Open Graph title/description, a picture
-- RE-HOSTED under a public key of ours (never hot-linked from the source), and
-- what kind of page it is. The row is reused for 24 h by every reader who
-- meets the same URL, so a link shared in a busy thread costs one fetch, not
-- one per screen.
--
-- THE CHAT MESSAGE IS NOT CHANGED. `chat_messages.card_type` (0150) carries a
-- CHECK that admits only the commerce cards, and a rebuild is not allowed; a
-- link card message is therefore an ordinary line (card_type NULL, body = the
-- URL) whose `card_snapshot` holds `{type:'link', card_id, …}`, which the
-- reader exposes as `link`.
--
-- `status`:
--   ok       fetched and parsed; title/description/image_key may still be
--            empty when the page offered none
--   blocked  the host is not on the preview allow-list — a bare card (host
--            only) that was NEVER fetched; the allow-list is code, so the row
--            is reused indefinitely
--   failed   the fetch or the parse failed; retried after 1 h
--
-- `image_key` is a PUBLIC key `link-cards/<id>.webp` written through the
-- IMAGES binding; registered with the media sweeper in the same change
-- (worker/lib/mediaRefs.ts). `url` is the OUTBOUND address, never a key.

CREATE TABLE IF NOT EXISTS link_cards (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('model_page','video','article','unknown')),
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'failed' CHECK (status IN ('ok','blocked','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- «Is this card stale?» — the sweep of the day reads by age.
CREATE INDEX IF NOT EXISTS idx_link_cards_fetched ON link_cards(status, fetched_at);
