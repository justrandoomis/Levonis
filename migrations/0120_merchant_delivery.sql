-- ============================================================================
--  0120 — THE MERCHANT SETS THEIR DELIVERY, BY GOVERNORATE; THE SERVER PRICES
--         IT FROM THE CUSTOMER'S SAVED ADDRESS, AND THE ORDER REMEMBERS WHY.
-- ============================================================================
-- Merchant platform wave 2, stream W2-A (docs/MERCHANT_PLATFORM.md §2
-- decisions 3–4, §4.2; audit 02 §8.1). The rule that turns these rows into a
-- fee is `resolveMerchantDelivery` in packages/shipping/src/merchantDelivery.ts
-- — the Worker asks it at the quote AND at place-order.
--
-- NONDESTRUCTIVE: two `CREATE TABLE IF NOT EXISTS`, one INSERT OR IGNORE
-- backfill, four nullable `ADD COLUMN` on `orders`. Nothing is dropped, no
-- existing CHECK is touched, no table is rebuilt. `merchant_stores.
-- delivery_settings` (wave 1's flat fee JSON) STAYS, and every save of the new
-- profile mirrors its default fee, threshold and note back into it — so a
-- rollback of the code keeps charging each merchant's latest default fee.
--
-- ---------------------------------------------------------------------------
--  merchant_delivery_profiles — one per store
-- ---------------------------------------------------------------------------
--   default_mode      fee | free | disabled — every governorate without a
--                     rule of its own is served this way
--   default_fee_iqd   the fee under `fee` (kept, unused, under the others so
--                     switching back does not lose it). 1,000,000 is wave 1's cap
--   free_over_iqd     a positive fee becomes 0 once the merchandise reaches it
--   free_over_basis   WHAT the threshold is judged on: the merchandise AFTER the
--                     merchant's coupon (wave 1, audit 02 B22). One value today,
--                     stated on the row so another basis is a migration, never a
--                     silent change of meaning
--   pickup_*          collect from the store: a closed-list place and a note
--   prep_days         days the store needs before dispatch
--   version           bumped by EVERY save; the checkout's quote fingerprint
--                     binds it, and the order batch fences on it, so an edit
--                     between the quote and the tap is a 409 QUOTE_CHANGED —
--                     never a silently different fee. A store with no row is
--                     priced from its legacy JSON as version 0.
CREATE TABLE IF NOT EXISTS merchant_delivery_profiles (
  store_id TEXT PRIMARY KEY NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  default_mode TEXT NOT NULL DEFAULT 'free' CHECK (default_mode IN ('fee','free','disabled')),
  default_fee_iqd INTEGER NOT NULL DEFAULT 0 CHECK (default_fee_iqd >= 0 AND default_fee_iqd <= 1000000),
  free_over_iqd INTEGER CHECK (free_over_iqd IS NULL OR (free_over_iqd > 0 AND free_over_iqd <= 1000000000)),
  free_over_basis TEXT NOT NULL DEFAULT 'after_discount' CHECK (free_over_basis IN ('after_discount')),
  pickup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pickup_enabled IN (0,1)),
  pickup_governorate TEXT NOT NULL DEFAULT '' CHECK (pickup_governorate IN (
    '','baghdad','basra','nineveh','erbil','sulaymaniyah','duhok','kirkuk','diyala','anbar',
    'babil','karbala','najaf','wasit','maysan','dhi_qar','muthanna','qadisiyyah','salahuddin')),
  pickup_note TEXT NOT NULL DEFAULT '' CHECK (length(pickup_note) <= 200),
  prep_days INTEGER NOT NULL DEFAULT 0 CHECK (prep_days >= 0 AND prep_days <= 60),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Pickup on means somewhere to pick up from.
  CHECK (pickup_enabled = 0 OR pickup_governorate <> '')
);

-- ---------------------------------------------------------------------------
--  merchant_delivery_rules — only where a governorate departs from the default
-- ---------------------------------------------------------------------------
-- The governorate is an id from the CLOSED list (packages/shipping/src/
-- iraqGovernorates.ts) — never a name; the CHECK is the last line behind the
-- API's own validation. A `fee` rule must carry its fee. Every save replaces a
-- store's whole set in the same batch that bumps the profile's version.
CREATE TABLE IF NOT EXISTS merchant_delivery_rules (
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  governorate_id TEXT NOT NULL CHECK (governorate_id IN (
    'baghdad','basra','nineveh','erbil','sulaymaniyah','duhok','kirkuk','diyala','anbar',
    'babil','karbala','najaf','wasit','maysan','dhi_qar','muthanna','qadisiyyah','salahuddin')),
  mode TEXT NOT NULL CHECK (mode IN ('fee','free','disabled')),
  fee_iqd INTEGER CHECK (fee_iqd IS NULL OR (fee_iqd >= 0 AND fee_iqd <= 1000000)),
  free_over_iqd INTEGER CHECK (free_over_iqd IS NULL OR (free_over_iqd > 0 AND free_over_iqd <= 1000000000)),
  prep_days INTEGER CHECK (prep_days IS NULL OR (prep_days >= 0 AND prep_days <= 60)),
  eta_note TEXT NOT NULL DEFAULT '' CHECK (length(eta_note) <= 80),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 120),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (store_id, governorate_id),
  CHECK (mode <> 'fee' OR fee_iqd IS NOT NULL)
);

-- ---------------------------------------------------------------------------
--  THE BACKFILL — every existing store gets the profile its JSON describes
-- ---------------------------------------------------------------------------
-- Exactly `profileFromLegacySettings` (tests/merchantDeliveryMigration.test.ts
-- runs both over the same rows): a positive `fee_iqd` (floored, capped at the
-- 1,000,000 the old sanitiser capped at) is the default fee; none is free
-- delivery, which is what an empty JSON always meant; `free_over_iqd` becomes
-- the threshold, rounded UP — an integer basket reaches x exactly when it
-- reaches ceil(x); `note` is kept, trimmed to 200. A JSON that does not parse
-- is treated as empty rather than failing the migration. OR IGNORE: running
-- this twice changes nothing.
INSERT OR IGNORE INTO merchant_delivery_profiles
  (store_id, default_mode, default_fee_iqd, free_over_iqd, note, version, updated_by)
SELECT id,
       CASE WHEN fee > 0 THEN 'fee' ELSE 'free' END,
       CASE WHEN fee > 0 THEN MIN(CAST(fee AS INTEGER), 1000000) ELSE 0 END,
       CASE WHEN free_over > 0
            THEN MIN(CAST(free_over AS INTEGER) + (free_over > CAST(free_over AS INTEGER)), 1000000000)
            ELSE NULL END,
       COALESCE(substr(trim(note), 1, 200), ''),
       1,
       'migration:0120'
  FROM (
    SELECT s.id,
           CASE WHEN json_valid(s.delivery_settings) AND json_type(s.delivery_settings, '$.fee_iqd') IN ('integer','real')
                THEN json_extract(s.delivery_settings, '$.fee_iqd')
                WHEN json_valid(s.delivery_settings) AND json_type(s.delivery_settings, '$.fee_iqd') = 'text'
                THEN CAST(json_extract(s.delivery_settings, '$.fee_iqd') AS REAL)
                ELSE 0 END AS fee,
           CASE WHEN json_valid(s.delivery_settings) AND json_type(s.delivery_settings, '$.free_over_iqd') IN ('integer','real')
                THEN json_extract(s.delivery_settings, '$.free_over_iqd')
                WHEN json_valid(s.delivery_settings) AND json_type(s.delivery_settings, '$.free_over_iqd') = 'text'
                THEN CAST(json_extract(s.delivery_settings, '$.free_over_iqd') AS REAL)
                ELSE 0 END AS free_over,
           CASE WHEN json_valid(s.delivery_settings) AND json_type(s.delivery_settings, '$.note') = 'text'
                THEN json_extract(s.delivery_settings, '$.note')
                ELSE '' END AS note
      FROM merchant_stores s
  );

-- ---------------------------------------------------------------------------
--  THE ORDER REMEMBERS WHAT WAS APPLIED — queryable, never recomputed
-- ---------------------------------------------------------------------------
--   delivery_governorate  where it went: the address's governorate id, or the
--                         pickup point's for a pickup order
--   delivery_rule         override | default | free_governorate | free_over |
--                         pickup — which branch of the resolver priced it
--   delivery_prep_days    the preparation days the customer was shown
--   quote_fingerprint     the agreement the customer confirmed; a retry with
--                         the same checkout key and a DIFFERENT fingerprint is
--                         409 IDEMPOTENCY_KEY_REUSED, never a replay
-- `delivery_method_snapshot` (0001) keeps the whole applied rule, the profile
-- version and the threshold as JSON. NULL on every order placed before this
-- migration, which is the truth about them: nothing was applied by governorate.
-- SQLite checks an ADD COLUMN's CHECK against new writes only.
ALTER TABLE orders ADD COLUMN delivery_governorate TEXT;
ALTER TABLE orders ADD COLUMN delivery_rule TEXT
  CHECK (delivery_rule IS NULL OR delivery_rule IN ('override','default','free_governorate','free_over','pickup'));
ALTER TABLE orders ADD COLUMN delivery_prep_days INTEGER CHECK (delivery_prep_days IS NULL OR delivery_prep_days >= 0);
ALTER TABLE orders ADD COLUMN quote_fingerprint TEXT;
