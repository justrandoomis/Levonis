-- FILAMENT LIMITS — «حد الفلامنت الشهري» (owner 2026-11-19; migration 0245).
--
-- Each filament KIND (one product, all its colours) may be bought at most N pieces per rolling 30 days
-- (setting `filamentMonthlyLimits`: none 50, PLUS 100, PREMIUM 250, PRO unlimited), and the count follows
-- the PERSON: orders placed by the account OR delivered to the same phone pool together
-- (worker/lib/filamentLimits.ts).
--
-- orders.delivery_phone_key  the delivery phone's pooling key: the last ten digits of the phone in
--                            `address_snapshot` (Arabic-Indic digits made ASCII; spaces, dashes, '+', brackets,
--                            dots, tabs and direction marks removed; fewer than seven digits, or anything else
--                            left over, = NULL). `+964 770 123 4567`, `07701234567` and `7701234567` share one key.
--                            Written by every new order; the rule is `phoneKey` and the SQL below is
--                            `PHONE_DIGITS_SQL` + `PHONE_KEY_SQL` (tests/filamentLimits.test.ts proves them equal).
ALTER TABLE orders ADD COLUMN delivery_phone_key TEXT;

-- Backfill, step 1: the snapshot's phone with its separators removed and its digits made ASCII.
UPDATE orders
   SET delivery_phone_key = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(CASE WHEN json_valid(address_snapshot) THEN json_extract(address_snapshot, '$.phone') END AS TEXT), '٠', '0'), '۰', '0'), '١', '1'), '۱', '1'), '٢', '2'), '۲', '2'), '٣', '3'), '۳', '3'), '٤', '4'), '۴', '4'), '٥', '5'), '۵', '5'), '٦', '6'), '۶', '6'), '٧', '7'), '۷', '7'), '٨', '8'), '۸', '8'), '٩', '9'), '۹', '9'), ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', ''), char(9), ''), char(8206), ''), char(8207), '')
 WHERE address_snapshot IS NOT NULL;

-- Backfill, step 2: those digits → the key.
UPDATE orders
   SET delivery_phone_key = CASE WHEN length(delivery_phone_key) >= 7 AND delivery_phone_key NOT GLOB '*[^0-9]*' THEN substr(delivery_phone_key, -10) ELSE NULL END
 WHERE delivery_phone_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_delivery_phone_key ON orders(delivery_phone_key, created_at)
  WHERE delivery_phone_key IS NOT NULL;

-- PRO plan section (added by the subscriptions session)

-- PRO RETURNS (owner, 2026-11-19; DECISIONS row 358): `pro_12mo` is sold at
-- 499,000 IQD for 12 months once the owner presses «استئناف PRO». Migrations
-- 0002 and 0025 left it priced and active and nothing since changed it, so on
-- a database that kept them these statements change nothing. They only fill a
-- price that is missing and re-activate a row that was switched off, so the
-- resume button finds the plan ready; the pause itself (`proPause`) is not
-- touched here.
INSERT OR IGNORE INTO membership_plans (id, tier, duration_months, price_iqd, active, sort)
VALUES ('pro_12mo', 'pro', 12, 499000, 1, 9);
UPDATE membership_plans SET price_iqd = 499000 WHERE id = 'pro_12mo' AND price_iqd IS NULL;
UPDATE membership_plans SET active = 1 WHERE id = 'pro_12mo' AND active = 0;
