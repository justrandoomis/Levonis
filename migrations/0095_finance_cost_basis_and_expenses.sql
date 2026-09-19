-- ============================================================================
--  0095 — THE COST BASIS OF A SALE, AND THE OPERATING-EXPENSE LEDGER
-- ============================================================================
-- NONDESTRUCTIVE. Two ADD COLUMNs on `order_items` (the second with a default, so
-- every existing row keeps its meaning), two new tables and five indexes.
-- Nothing is dropped, nothing is rewritten, no existing row is touched.
--
-- ONE SENTENCE FROM THE OWNER GOVERNS THE WHOLE FILE:
--
--   «التكلفه على مستوى واحد في تفاصيل المنتج، لكن يستطيع الادمن في لوحه
--    الاداره اضافه تكاليف اخرى يمكن، لا علاقه لها بالمنتج الاساسي او ما يظهر
--    للمستخدم، انها خاصه في لوحه الادمن»
--
-- So there are exactly TWO kinds of cost in this business, and they are never
-- merged:
--
--   1. PRODUCT COST — one level, `cost_iqd` on the product/option/colour rungs
--      (0018, 0073). It is the COST OF GOODS SOLD. Revenue minus it is the
--      GROSS profit, and it can be attributed to a product and to a category.
--
--   2. OPERATING EXPENSE — rent, salaries, advertising, a shipping contract,
--      customs, bank fees. It belongs to NO product, it is never shown to a
--      customer, and it lives only in the admin panel. Gross profit minus it
--      is the NET profit, and net profit exists ONLY per period — an expense
--      row belongs to no product, so a per-product net profit would be an
--      invention, not a number.
--
-- Everything this migration adds is financial, and every route that reads it
-- is behind worker/lib/adminScope.ts §11: «cost وجميع تفاصيل الربح متاحة فقط
-- للمالك/الدور المالي. مساعد الأدمن العادي لا يراها في API ولا في HTML ولا في
-- export». An assistant admin may not see a cost, a margin or an expense.
--
-- ---------------------------------------------------------------------------
--  PART 1 — THE DEFECT THIS FIXES: THE COST AT THE MOMENT OF SALE WAS LOST
-- ---------------------------------------------------------------------------
-- `worker/routes/orders.ts` strips the resolved cost out of the persisted
-- pricing snapshot in three places, and did so on purpose:
--
--     const { cost_iqd, ...snapshot } = k.unit;      // :1183  bundle component
--     void cost_iqd;
--     const { cost_iqd, ...bundleSnapshot } = ...;   // :1248  bundle parent
--     const { cost_iqd, ...pricingSnapshot } = ...;  // :2234  ordinary line
--
-- The reason was right — `pricing_snapshot` is serialized straight back to the
-- BUYER by `orderPublic`, so a cost inside it is a cost published to the
-- customer. The CONSEQUENCE was not: `order_items` (0001_init.sql:164-175)
-- carries `unit_price_iqd` and `line_total_iqd` and NO cost column, and no
-- migration between 0002 and 0094 adds one — the ALTERs on this table add
-- pricing/warranty/transport snapshots, option ids, seller type, the four
-- composition columns, the membership discount and the coupon discount, and
-- not one of them is a cost. So the cost at the moment of sale was recorded
-- NOWHERE.
--
-- What that costs the owner: profit could only ever be computed against the
-- product's CURRENT cost, so editing one supplier price today silently
-- rewrites last month's reported profit. A dashboard whose history moves
-- behind the owner cannot be reconciled against anything, and must not ship.
--
-- `cost_iqd` below is therefore the unit cost AS RESOLVED AT CHECKOUT — the
-- exact value the three sites above discard, taken from the same resolver
-- output that priced the line, never re-derived from the product afterwards. A
-- second derivation walks the option/colour rungs a second time and can
-- disagree with the first, and then two honest numbers describe one sale.
--
-- THE COST STILL NEVER REACHES THE CUSTOMER. It moves from "not stored" to
-- "stored on a column no customer-facing serializer selects". `orderPublic`
-- builds its item objects field by field from an explicit list, so a new
-- column cannot appear in a customer payload by growing the row; the three
-- strips above STAY, so the cost never re-enters `pricing_snapshot` either.
--
-- ---------------------------------------------------------------------------
--  PART 2 — WHY THERE IS A SECOND COLUMN, `cost_basis`
-- ---------------------------------------------------------------------------
-- Every order placed before this migration has no snapshot and never will.
-- There is no honest way to invent one. The only question is whether the
-- reader can TELL — and a NULL cost cannot answer it, because NULL is also
-- what a product with no configured cost produces.
--
-- So the row says which of four things it is, and the dashboard (track B) must
-- label it on screen. An estimate presented as a fact is the single failure
-- this whole change exists to prevent.
--
--   'snapshot'    `cost_iqd` IS the unit cost resolved at the instant of sale.
--                 Authoritative. Profit computed from it is a FACT and stays
--                 the same for ever, whatever happens to the catalogue.
--
--   'unpriced'    The sale-time resolver walked every rung and found no cost
--                 at all, so `cost_iqd` IS NULL — and that NULL is a RECORDED
--                 FACT, not a gap. Gross profit on this line is UNKNOWN and
--                 must be reported as unknown. It must NOT be estimated from
--                 the product's cost today: the owner typed that cost AFTER
--                 the sale, so applying it backwards invents a margin that
--                 never existed.
--
--   'composed'    A composition PARENT row (a bundle). Its money is real but
--                 its goods are not: the physical items are its COMPONENT
--                 rows, which are separate `order_items` rows in the same
--                 order and each carry their own 'snapshot'. The parent's
--                 COGS is therefore ZERO BY CONSTRUCTION — adding a cost here
--                 as well would count the same goods twice. If the owner ever
--                 typed a `cost_iqd` on the bundle PRODUCT itself, it is
--                 deliberately not recorded here for that same reason.
--
--   'unrecorded'  DEFAULT, and what every pre-0095 row gets from this ALTER.
--                 Nothing was captured. A dashboard may estimate this line
--                 against the product's cost TODAY, but the estimate must be
--                 labelled «تقدير» on screen and must never be added into a
--                 total presented as a fact. A mystery-box spool row is also
--                 'unrecorded' — see PART 3.
--
-- The CHECK is on the ADD COLUMN so an unknown fifth value cannot be written
-- by a future writer that has not learned the rule. SQLite accepts a CHECK on
-- ADD COLUMN; it does not accept one added later without rebuilding the table,
-- and this table can never be rebuilt (it is the sales history).
--
-- ---------------------------------------------------------------------------
--  PART 3 — WHAT IS NOT SOLVED HERE, SAID OUT LOUD
-- ---------------------------------------------------------------------------
-- A MYSTERY-BOX SPOOL row is left 'unrecorded' on purpose. docs/BUNDLES_MYSTERY
-- §7.7 binds its `product_id` to NULL and its `pricing_snapshot` to NULL so the
-- draw cannot leak through the order row, and the draw's candidate record
-- (`loadCandidates`) carries no cost field to snapshot — so there is nothing to
-- write that would not have to be re-derived from the drawn product, which is
-- exactly what PART 1 forbids. Consequence, which the dashboard must state and
-- not hide: revenue from mystery boxes currently has NO cost basis at all, and
-- with `product_id` NULL it cannot even be estimated. It is reported as
-- unknown, never as 100% margin. Closing this needs a cost on the candidate
-- record, which is another track's file.
--
-- A MERCHANT-STORE order (worker/routes/storeOrders.ts) also stays
-- 'unrecorded'. Those are a merchant's own goods, not LEVONIS stock; their
-- cost is the merchant's business and the platform's profit on them is the
-- commission, which is already recorded on the order.
--
-- ============================================================================

ALTER TABLE order_items ADD COLUMN cost_iqd INTEGER;

ALTER TABLE order_items ADD COLUMN cost_basis TEXT NOT NULL DEFAULT 'unrecorded'
  CHECK (cost_basis IN ('snapshot','unpriced','composed','unrecorded'));

-- The dashboard's hot path is "every item of every order in this period", and
-- it will want to count how much of a period is estimate rather than fact.
-- `order_id` is already indexed (0001); this one answers the basis question
-- without a table scan of the whole sales history.
CREATE INDEX IF NOT EXISTS idx_order_items_cost_basis ON order_items(cost_basis);

-- ============================================================================
--  THE OPERATING-EXPENSE LEDGER — «تكاليف اخرى ... خاصه في لوحه الادمن»
-- ============================================================================
--
-- ---------------------------------------------------------------------------
--  CATEGORIES ARE ROWS, NOT AN ENUM
-- ---------------------------------------------------------------------------
-- The owner names their own costs. A frozen `CHECK (category IN (...))` would
-- mean a deploy every time a new kind of expense appears — and on SQLite a
-- CHECK cannot be widened without rebuilding the table, so the enum would
-- become permanent. This follows the pattern `catalogs`/`facets` already set
-- (0018, §4/§9: «أنشئ taxonomy قابلة للإدارة من قاعدة البيانات ... لا تضع
-- الشجرة hard-coded في الواجهة»): database rows with a slug, localized names,
-- a sort order and an active flag, which the admin panel edits.
--
-- Three languages, because this is Arabic-first and 'ckb' is a real language
-- here and not a fallback to English.
--
-- NOTHING IS SEEDED FROM THIS FILE. A seeded INSERT is a write, and this
-- repository's `scripts/check-migrations-additive.mjs` classifies a write as
-- non-additive for a good reason: a re-applied migration would resurrect a
-- category the owner had deliberately removed. The default set is created
-- once, on demand and idempotently, by worker/routes/adminFinance.ts, where
-- it is audited like any other admin write and the owner can rename or
-- deactivate every row afterwards.
CREATE TABLE IF NOT EXISTS expense_categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  name_ckb TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_expense_categories_active ON expense_categories(active, sort);

-- ---------------------------------------------------------------------------
--  THE EXPENSE ROW
-- ---------------------------------------------------------------------------
-- `amount_iqd` is an INTEGER of DINARS, because that is how this codebase
-- stores money everywhere (`unit_price_iqd`, `total_iqd`, `cost_iqd`). A float
-- would be a second money representation and the first rounding disagreement
-- between the dashboard and the order it came from.
--
-- `expense_day` IS THE DAY THE EXPENSE BELONGS TO, AND IT IS NOT `created_at`.
-- A January invoice paid in March belongs to January: if the period a cost
-- lands in were the day somebody typed it, then entering three months of
-- arrears in one sitting would wipe out one month's profit and inflate two
-- others, and every earlier report the owner has already acted on would
-- silently change. So the day is DATA the admin sets, `created_at` is the
-- audit fact, and the two are never the same column.
--
-- It is a 'YYYY-MM-DD' BAGHDAD CIVIL DAY, the shape worker/lib/baghdadTime.ts
-- defines and 0094 already GLOBs on `orders.delivery_due_day`. It is TEXT and
-- not a timestamp on purpose: a fixed-width zero-padded civil date compares
-- lexicographically in date order, in SQL and in TypeScript alike, so a period
-- filter needs no timezone anywhere. `date('now')` is UTC and Baghdad is
-- UTC+3, so a day computed in SQL is the WRONG DAY for the first three hours
-- of every Iraqi night — nothing here may default this column to it, which is
-- why it has no default at all and the server always binds a resolved value.
--
-- ---------------------------------------------------------------------------
--  RECURRING EXPENSES: MATERIALISED ROWS, NEVER A RULE EVALUATED AT READ TIME
-- ---------------------------------------------------------------------------
-- Rent and salaries repeat, so the obvious design is a recurrence rule and a
-- generator. It is rejected, and this is the argument.
--
-- A rule evaluated when the dashboard is read makes a reported profit depend
-- on CODE rather than on rows the owner can see. The month the rent goes from
-- 500,000 to 600,000, a single edited rule rewrites every month the report has
-- ever shown — the exact class of silent history rewriting that PART 1 of this
-- migration exists to abolish. And a generator that quietly writes rows on a
-- cron produces expenses nobody typed, in months nobody was looking at, which
-- is worse than typing twelve.
--
-- So: ONE ROW PER PERIOD, ALWAYS, and every row is a real row the owner can
-- see, edit and void one at a time. What the panel offers instead of a rule is
-- a REPEAT at entry time: «كرّر ١٢ شهر» writes twelve ordinary rows in one
-- audited batch, right then, with the months visible before they are saved.
-- `series_id` ties them together so the panel can show them as a group and the
-- owner can find the other eleven — it is a label, never an authority: no
-- report reads it, and deleting one row of a series changes that month only.
--
-- ---------------------------------------------------------------------------
--  DELETION IS A VOID, NOT A DELETE
-- ---------------------------------------------------------------------------
-- A deleted expense changes a NET PROFIT the owner may already have acted on —
-- a price they set, a salary they approved, a purchase they made. If the row
-- vanishes, the number changes and nothing anywhere says why, and the old
-- report can never be reproduced.
--
-- So a removal sets `voided_at`/`voided_by`/`void_reason` and the row stays.
-- Reports read `voided_at IS NULL`; the ledger screen can show the voided rows
-- and say who voided them and when. This is the same choice 0081 made for
-- cancelled-order retention and the same one `merchant_store_slugs` makes for
-- retired slugs: in a financial table, forgetting is a defect.
CREATE TABLE IF NOT EXISTS operating_expenses (
  id TEXT PRIMARY KEY,
  -- RESTRICT, not CASCADE: deleting a category must never take the money with
  -- it. The panel deactivates a category that is in use; the rows survive.
  category_id TEXT NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd > 0),
  expense_day TEXT NOT NULL CHECK (expense_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  -- A label that groups the rows one "repeat" produced. NULL on a single row.
  series_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  voided_at TEXT,
  voided_by TEXT REFERENCES users(id),
  void_reason TEXT NOT NULL DEFAULT ''
);

-- The period query the dashboard runs on every load: "every live expense
-- between two days". `voided_at` leads so the index serves the
-- `voided_at IS NULL` half of the predicate before the range scan.
CREATE INDEX IF NOT EXISTS idx_operating_expenses_live_day
  ON operating_expenses(voided_at, expense_day);
-- "This period, broken down by category" — the second question every expense
-- screen asks, answered without re-reading the period for each category.
CREATE INDEX IF NOT EXISTS idx_operating_expenses_category_day
  ON operating_expenses(category_id, expense_day);
-- "Show me the other eleven months of this rent." Partial, because most rows
-- carry no series and an index over their NULLs would be dead weight.
CREATE INDEX IF NOT EXISTS idx_operating_expenses_series
  ON operating_expenses(series_id) WHERE series_id IS NOT NULL;
