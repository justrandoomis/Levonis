-- 0047 — «PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية».
--
-- The benefit is a FULFILMENT fact, not a price: the customer pays the same
-- total and a spool ships with the order. So it does not belong in the price
-- resolver, the shipping quote or the wallet ledger — it belongs on the order,
-- frozen at purchase like `membership_tier_snapshot`, `delivery_waived` and
-- `priority` already are, so a later membership change cannot take back a gift
-- that was already earned.
--
-- One additive column holding a JSON snapshot, or '' for the overwhelming
-- majority of orders that earn nothing. The snapshot — not a foreign key —
-- because what the owner promised on the day of purchase must stay readable
-- even if the filament product is later renamed, repriced or delisted; that is
-- the same reason coupon_snapshot and support_snapshot are snapshots.
--
-- NOTHING IS GRANTED UNTIL THE OWNER CONFIGURES IT. The matching setting
-- (`preorderGiftConfig`) ships disabled with no product chosen, so this column
-- stays '' on every order until a human decides which filament the promise
-- means. An invented default here would be the store giving away stock nobody
-- approved.
ALTER TABLE orders ADD COLUMN membership_gift TEXT NOT NULL DEFAULT '';

-- Fulfilment's actual question is "which orders leave here with a gift in the
-- box?", and without this it is a full scan of the orders table for a column
-- that is empty on almost every row. The partial index holds only the orders
-- that earned one.
CREATE INDEX IF NOT EXISTS idx_orders_membership_gift
  ON orders(membership_gift) WHERE membership_gift <> '';
