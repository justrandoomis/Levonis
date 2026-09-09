-- 0060 — ONE PROMOTION MODEL (docs/BUNDLES_MYSTERY.md §1.8, §9)
--
-- Windows, limits and redemptions for ANY subject. The subject key is
-- ('product', productId) for a bundle, a mystery offer AND an ordinary
-- product, which is what makes this literally one promotion model rather than
-- three: a scheduled, tier-gated, limited, discounted special offer on an
-- ordinary product is the same pair of rows, with no new table and no second
-- discount code path.
--
-- These tables are INERT until a row exists: a checkout for a subject with no
-- offer_windows row behaves exactly as it does today.
--
-- (0059 is reserved for the legacy bundles backfill, which lands with the
-- admin panel that can price the migrated drafts.)

CREATE TABLE IF NOT EXISTS offer_windows (
  subject_type  TEXT NOT NULL,            -- 'product'
  subject_id    TEXT NOT NULL,
  id            TEXT NOT NULL UNIQUE,     -- 'ofw_<20 hex>' — the offer identity frozen into the order snapshot
  starts_at     TEXT,                     -- ISO-8601 with an explicit Z; NULL = no start bound
  ends_at       TEXT,                     -- ISO-8601 with an explicit Z; NULL = no end bound
  -- THE ALLOWED SET, not a ladder minimum. JSON array of tier names, sorted.
  -- '[]' = public, including a signed-out visitor. '["plus"]' admits PLUS and
  -- PRO (PRO inherits PLUS) and NOT PRIME. '["plus","prime"]' admits all three
  -- paid tiers. A linear minimum cannot express "plus+pro but not prime", and
  -- would hand PRIME every PLUS-exclusive price. See §9.
  required_tiers TEXT NOT NULL DEFAULT '[]',
  -- THE SCHEDULED PRICE. '' = the window changes no price and is a pure
  -- schedule/gate/limit. Otherwise this offer, and only this offer, sets the
  -- price for its window (§4.6). Never stacked with bundle_config.price_mode —
  -- the two together are refused at admin save with OFFER_PRICE_CONFLICT.
  offer_price_mode TEXT NOT NULL DEFAULT '',  -- ''|'fixed'|'discount_percent'|'discount_iqd'
  offer_price_iqd  INTEGER,                   -- offer_price_mode='fixed'
  discount_percent INTEGER,                   -- 1..90
  discount_iqd     INTEGER,                   -- > 0
  plus_price_iqd   INTEGER,                   -- the offer's PLUS rung (§4.4)
  locked_preview INTEGER NOT NULL DEFAULT 1,   -- may a non-eligible viewer see a polished lock?
  active        INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS offer_limits (
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  max_per_user INTEGER,                   -- NULL = unlimited
  max_global   INTEGER,                   -- NULL = unlimited
  PRIMARY KEY (subject_type, subject_id)
);

-- ONE row per (subject, order), with qty SUMMED over that subject's lines.
-- An order may legitimately hold two lines of the same bundle (two different
-- colour choices, §5.1); inserting one row per LINE would abort the batch on
-- the UNIQUE below with a message containing neither 'idempotency_key' nor any
-- code the catch block maps — a permanent generic failure on a cart that could
-- never succeed. Summing is also exactly what the trigger's SUM(qty) limit
-- semantics want.
CREATE TABLE IF NOT EXISTS offer_redemptions (
  id           TEXT PRIMARY KEY,          -- 'ofr_<20 hex>'
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (subject_type, subject_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_offer_redemptions_user
  ON offer_redemptions(subject_type, subject_id, user_id);
CREATE INDEX IF NOT EXISTS idx_offer_redemptions_subject
  ON offer_redemptions(subject_type, subject_id);

-- The read-time count in the route is ADVICE for a friendly message; this
-- trigger is THE DECISION, and a refusal aborts the whole checkout batch —
-- exactly the contract the coupon limits already state. Copied in shape from
-- migrations/0049_security_hardening.sql:29-40, the only concurrency-safe
-- limit mechanism in the tree.
CREATE TRIGGER IF NOT EXISTS trg_offer_redemption_limits
BEFORE INSERT ON offer_redemptions
BEGIN
  SELECT RAISE(ABORT, 'OFFER_PER_USER_LIMIT') WHERE EXISTS (
    SELECT 1 FROM offer_limits l
     WHERE l.subject_type = NEW.subject_type AND l.subject_id = NEW.subject_id
       AND l.max_per_user IS NOT NULL
       AND NEW.qty + COALESCE((SELECT SUM(r.qty) FROM offer_redemptions r
             WHERE r.subject_type = NEW.subject_type AND r.subject_id = NEW.subject_id
               AND r.user_id = NEW.user_id), 0) > l.max_per_user);
  SELECT RAISE(ABORT, 'OFFER_GLOBAL_LIMIT') WHERE EXISTS (
    SELECT 1 FROM offer_limits l
     WHERE l.subject_type = NEW.subject_type AND l.subject_id = NEW.subject_id
       AND l.max_global IS NOT NULL
       AND NEW.qty + COALESCE((SELECT SUM(r.qty) FROM offer_redemptions r
             WHERE r.subject_type = NEW.subject_type AND r.subject_id = NEW.subject_id), 0) > l.max_global);
END;
