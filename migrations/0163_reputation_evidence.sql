-- ============================================================================
--  0163 — REPUTATION V2 AND DISPUTE EVIDENCE ACCESS
--         (docs/COMMUNITY_ECOSYSTEM.md §9.6, Phase 6b)
-- ============================================================================
-- Two things the community could not say about a workshop, and one door staff
-- could not open while two people's money was frozen:
--
--   · HOW A WORKSHOP BEHAVES, AS NUMBERS. A merchant's day — how fast they
--     answered the customers who wrote to them, what they finished, what they
--     cancelled themselves, which disputes they lost — kept as ONE row per
--     merchant per Baghdad day (`merchant_metrics_daily`), written once a
--     night by the */15 cron (worker/lib/reputation.ts). Everything a badge,
--     the ranking and the store's «يرد عادةً خلال …» line say is read from
--     these rows, never from a figure somebody typed.
--   · WHICH BADGES THAT EARNS, WITH ITS EVIDENCE. `community_merchants.
--     badges_json` holds `[{key, since, evidence}]`, recomputed nightly beside
--     the tier badge; the public reads carry `{key, since}` only, the
--     merchant's own reputation page the evidence too.
--   · WHO READ A DISPUTED CONVERSATION. Staff may read the store or request
--     thread a disputed order came from — read-only, only while the dispute is
--     open — and every read SESSION is one `chat_staff_reads` row beside the
--     `admin.chat_read` audit row (worker/routes/chats.ts).
--
-- ADDITIVE. Two new tables (IF NOT EXISTS), two nullable/defaulted columns,
-- three indexes. Nothing is rebuilt, dropped or backfilled: every merchant
-- starts with no badges (`'[]'`) and no response line (NULL), which is the
-- truth until the first nightly run has measured them.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  1. A MERCHANT'S DAY
-- ---------------------------------------------------------------------------
--   first_reply_minutes_sum / first_reply_count
--                  one SAMPLE per store/request thread per day: the customer's
--                  first message that opened a turn that day (the message
--                  before it was not theirs) → the merchant's first reply
--                  after it, in whole minutes, each gap capped at 1440. A turn
--                  nobody answered within a day is a sample too (1440 in the
--                  sum, in no `within` column) — silence is not left out.
--   first_reply_within_<N>
--                  how many of those samples were answered within N minutes
--                  (cumulative: a 12-minute reply counts in every column). The
--                  median is therefore EXACT against these bounds — «half the
--                  replies came within an hour» is a count, not an estimate —
--                  and `merchant_stores.responds_within_minutes` is the
--                  smallest bound holding the median.
--   orders_completed           community orders completed + store orders
--                              delivered that day
--   custom_orders_completed    the community (custom) part of the above
--   orders_cancelled_by_merchant  the merchant's own cancellations that day
--   disputes_lost              dispute outcomes against the merchant that day
-- Days are BAGHDAD calendar days (worker/lib/baghdadTime.ts). A day is written
-- whole — its rows replaced — so re-running a night is a no-op; a merchant
-- with nothing that day has no row. The merchant's deletion cascades.
CREATE TABLE IF NOT EXISTS merchant_metrics_daily (
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  first_reply_minutes_sum INTEGER NOT NULL DEFAULT 0,
  first_reply_count INTEGER NOT NULL DEFAULT 0,
  first_reply_within_15 INTEGER NOT NULL DEFAULT 0,
  first_reply_within_30 INTEGER NOT NULL DEFAULT 0,
  first_reply_within_60 INTEGER NOT NULL DEFAULT 0,
  first_reply_within_120 INTEGER NOT NULL DEFAULT 0,
  first_reply_within_240 INTEGER NOT NULL DEFAULT 0,
  first_reply_within_480 INTEGER NOT NULL DEFAULT 0,
  first_reply_within_1440 INTEGER NOT NULL DEFAULT 0,
  orders_completed INTEGER NOT NULL DEFAULT 0,
  custom_orders_completed INTEGER NOT NULL DEFAULT 0,
  orders_cancelled_by_merchant INTEGER NOT NULL DEFAULT 0,
  disputes_lost INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (merchant_id, day)
);
-- The nightly window sums read every merchant's last 30 / 90 days at once.
CREATE INDEX IF NOT EXISTS idx_merchant_metrics_daily_day ON merchant_metrics_daily(day);

-- ---------------------------------------------------------------------------
--  2. ONE ROW PER STAFF READ SESSION OF A DISPUTED CONVERSATION
-- ---------------------------------------------------------------------------
-- Written when staff open the thread (or one of its files) while the order it
-- belongs to is disputed or its store-order complaint is open — once per admin
-- per thread per 30 minutes, not per poll or page. The `admin.chat_read`
-- audit row is written with it. No key, no message text: who looked, at
-- which thread, for which case, when.
CREATE TABLE IF NOT EXISTS chat_staff_reads (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL REFERENCES users(id),
  complaint_id TEXT REFERENCES community_complaints(id),
  community_order_id TEXT REFERENCES community_orders(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_staff_reads_chat ON chat_staff_reads(chat_id, created_at);

-- ---------------------------------------------------------------------------
--  3. WHAT THE EVIDENCE DOOR ASKS — a thread's orders and their complaints
-- ---------------------------------------------------------------------------
-- «Is an order of this thread disputed?» is asked by chat id (0151/0159 write
-- `community_orders.chat_id`) and by request (a request thread), and «is its
-- complaint still open?» by community order. None of the three had an index.
CREATE INDEX IF NOT EXISTS idx_community_orders_chat ON community_orders(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_orders_request ON community_orders(request_id, merchant_id);
CREATE INDEX IF NOT EXISTS idx_community_complaints_community_order
  ON community_complaints(community_order_id, status)
  WHERE community_order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
--  4. THE BADGES AND THE RESPONSE LINE
-- ---------------------------------------------------------------------------
-- `badges_json`: `[{key, since, evidence}]` over the closed catalogue
-- (verified_merchant | fast_response | reliable_seller | custom_specialist |
-- high_completion) — counts and rates, never a picture (mediaRefs classifies
-- it). `responds_within_minutes`: the 30-day median first reply as the
-- smallest bound holding it (15 … 1440); NULL under 10 samples or when the
-- median is past a day (journeys C6 — StoreDoor shows the line only when set).
ALTER TABLE community_merchants ADD COLUMN badges_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE merchant_stores ADD COLUMN responds_within_minutes INTEGER;
