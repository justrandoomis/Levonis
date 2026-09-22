-- ============================================================================
--  0103 — «خدمه اقساطي على تطبيق جني ( مصرف الرافدين )» : THE GINI ORDER.
-- ============================================================================
-- NONDESTRUCTIVE: six ADD COLUMNs on `orders` and one partial index. Nothing
-- existing is touched, nothing is dropped, NO ROW IS BACKFILLED — every order
-- that exists when this applies reads `gini_state = ''`, `gini_paid_iqd = 0`
-- and a NULL hold, which is the truth about an order placed before the
-- service existed.
--
-- ---------------------------------------------------------------------------
--  WHY NOT A NEW `orders.status`
-- ---------------------------------------------------------------------------
-- `status` has carried a CHECK pinning it to six values since migration 0001,
-- and every reader of this schema — the stock lifecycle, the invoice writer,
-- the admin filter, the customer's list — is built on those six. There is no
-- 'gini_pending' and there must not be one. A Gini order waiting for its
-- receipt is `status = 'pending'` with `stage = 'received'`, exactly like any
-- other unconfirmed order, and the column below is what distinguishes «waiting
-- for a scan that has not happened» from «waiting for an admin».
--
-- THAT DISTINCTION IS THE WHOLE FEATURE. «يجب اعلام منصه جني بانه استلم
-- المنتج قبل ان يتم تجهيز الطلب من الاداره» — Gini is told the customer
-- received the goods BEFORE we prepare them, because the receipt barcode is
-- what closes the purchase inside the app. `stage = 'confirmed'` maps to a
-- status inside STOCK_DEDUCTED_STATES, so confirming is what turns the
-- checkout's hold into a real decrement; gating that one transition on
-- `gini_state = 'received'` is what makes the rule a rule and not a note.
ALTER TABLE orders ADD COLUMN gini_state TEXT NOT NULL DEFAULT ''
  CHECK (gini_state IN ('', 'awaiting_receipt', 'received', 'expired'));

-- THE SIX DIGITS THE CUSTOMER TYPES AT CHECKOUT — «رقم الطلب في تطبيق جني»،
-- «رقم مكون من ٦ ارقام». It is the only handle Levonis has on a purchase it
-- did not process: nobody here can look an order up in Gini without it, so a
-- typo is an order that can never be reconciled.
--
-- CHECKED IN THREE PLACES ON PURPOSE. The client refuses to enable its confirm
-- button (Checkout's ordered blockReason), the server refuses the checkout
-- (`GINI_ORDER_NO_RE` in packages/pricing/src/paymentPolicy.ts), and this
-- constraint refuses the row. The GLOB pattern is 30 bytes against D1's
-- 50-byte cap on a LIKE/GLOB pattern — see 0094 for what crossing that cap
-- does to a live checkout — so there is room, but not for a prettier one.
--
-- '' means "not a Gini order", which is every row that exists today.
ALTER TABLE orders ADD COLUMN gini_order_no TEXT NOT NULL DEFAULT ''
  CHECK (gini_order_no = '' OR gini_order_no GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]');

-- WHAT GINI SETTLED, FROZEN AT CHECKOUT. «يتم جعل السعر كله (يتم الحساب داخل
-- تطبيق جني)» — the goods are paid for inside the app, and only the delivery
-- fee is ours to collect. The money view and the invoice read THIS column
-- rather than subtracting one stored figure from another, so an order whose
-- door fee was later collected still reports what Gini paid instead of showing
-- its whole price outstanding for ever.
--
-- The invariant the checkout writes it under, and the only one that makes the
-- two numbers add up:
--     gini_paid_iqd + due_on_delivery_iqd = the payable after wallet/points
-- Both halves are produced inside `settle()` (worker/routes/orders.ts) and
-- returned from it, because `settle` runs up to three times per checkout and a
-- figure computed after it belongs to a pricing basis that did not win.
ALTER TABLE orders ADD COLUMN gini_paid_iqd INTEGER NOT NULL DEFAULT 0;

-- «يبقى الطلب معلقا حتى ٢٤ ساعه ويلغي في حال عدم الاستجابة» — the instant the
-- hold expires, frozen at checkout from `giniPolicy.hold_hours`.
--
-- FROZEN, NOT RECOMPUTED. An owner who lengthens the hold tomorrow must not
-- extend an order placed today, and one who shortens it must not cancel an
-- order that was still inside its promised window when it was placed. The
-- sweep compares against this stored instant and never re-derives it — the
-- same rule `delivery_day_window_end` states one migration family over.
--
-- NULL means "no hold" and is every non-Gini order. It is never COALESCEd to
-- a time: an order with no hold is not an order whose hold expired.
ALTER TABLE orders ADD COLUMN gini_hold_until TEXT;

-- THE RECEIPT BARCODE, as scanned. «عند طلب المنتج من جني يتم اعطاءه باركود
-- للاستلام (يعتبر انه استلم المنتج)» — scanning it is the act that tells Gini
-- the customer has the goods, so the code itself is kept beside the order: a
-- dispute with the bank is answered with the barcode that was scanned and
-- when, not with a boolean.
ALTER TABLE orders ADD COLUMN gini_receipt_barcode TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN gini_received_at TEXT;

-- ---------------------------------------------------------------------------
--  THE INDEX THE SWEEP READS THROUGH — AND THE WARNING ON IT
-- ---------------------------------------------------------------------------
-- worker/lib/giniSweep.ts selects the orders whose hold has run out, every
-- cron tick, for ever. Without an index that is a full scan of `orders` on a
-- table that only ever grows, to find the handful of rows still waiting.
--
-- ############################################################################
-- #  THE WHERE CLAUSE BELOW MUST APPEAR VERBATIM IN THE SWEEP'S QUERY.       #
-- ############################################################################
--
-- A PARTIAL index is usable only when the query's WHERE is SYNTACTICALLY
-- implied by the index's — SQLite matches the text of the expression rather
-- than reasoning about it. Rewriting the sweep's clause into an equivalent
-- form (`gini_state <> ''`, `gini_state IN ('awaiting_receipt')`) is logically
-- identical and costs the sweep this index, with no visible symptom until the
-- table is large. 0094 spells out the same trap for the admin board, in more
-- detail, and it is worth reading before touching either.
CREATE INDEX IF NOT EXISTS idx_orders_gini_hold
  ON orders(gini_hold_until)
  WHERE gini_state = 'awaiting_receipt';
