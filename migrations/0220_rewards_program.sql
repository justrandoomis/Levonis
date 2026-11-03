-- ============================================================================
-- 0220 — THE REWARDS PROGRAMME (owner, 2026-11-03; docs/DECISIONS.md row 286).
--
-- The owner's brief, in their words: «complete the reward page and system that
-- contain 1-5 rating reward on printer and 1 coupon free shipping for every
-- printer on 1 week and 1 coupon discounted on selected filament also for
-- every printer on 1 week. redeem point and competition and etc.»
--
-- And the answers to the four open choices (2026-11-03):
--   * the filament coupon is 15% off, at most 25,000 IQD, on the filaments the
--     owner ticks in Admin → Rewards (every FDM filament until they tick any);
--   * both coupons are issued WHEN THE PRINTER IS DELIVERED, one pair per
--     printer unit, each valid seven days;
--   * the points rates stay (1 point per 1,000 IQD, 1 point = 1 IQD at the
--     checkout) and a POINTS SHOP lets a customer swap points for the same two
--     coupons at point prices the owner sets;
--   * competitions are created later by the owner, with entry free or paid in
--     points, winners chosen by the owner.
--
-- What this file lands:
--   (1) two defaulted columns on `coupons`: the reward that minted a coupon,
--       and the 'products' LIST scope the filament coupon names;
--   (2) `reward_grants`: one row per reward coupon, the idempotency key that
--       makes a replayed delivery issue nothing twice;
--   (3) the two competition tables;
--   (4) the triggers that withdraw a printer's coupons when its order is
--       cancelled by ANY door, and give them back when the order is reopened.
--
-- ADDITIVE ONLY: two defaulted columns, three new tables, their indexes and
-- two triggers. No table is rebuilt, no CHECK is widened and no existing row
-- changes.
--
-- RE-RUNNABLE: every CREATE says IF NOT EXISTS, so scripts/migrate-check.mjs
-- --twice re-runs them and proves nothing moves. The two ADD COLUMNs are
-- excluded from that re-run by the harness itself (SQLite has no ADD COLUMN
-- IF NOT EXISTS; D1 applies a file once).
--
-- DEPLOY-AHEAD (CLAUDE.md rule 2): every reader of what this file adds
-- tolerates its absence (worker/lib/rewards/*.ts). A database without the
-- columns holds no reward coupon and no list-scoped coupon, which is exactly
-- what the columns' defaults say.
-- Comments use `--` only: tests/d1CompoundLimit.test.ts strips no block
-- comment, and no statement here chains a compound SELECT.
-- ============================================================================

-- ============================================================================
-- (1) COUPONS. `reward_grant_id` names the reward_grants row that minted the
-- coupon (NULL for every promo code and trade-in credit). The promo-code
-- editor refuses such a row, exactly as it refuses a trade-in credit: its
-- terms are the programme's, frozen when it was issued.
--
-- `product_ids` is the 'products' scope's list (a JSON array of product ids).
-- '[]' — the default — names nothing, and a 'products' coupon whose list is
-- empty matches no line and is refused: a list scope fails CLOSED, never open
-- (packages/pricing/src/coupons.ts `scopeNamesLine`).
-- ============================================================================
ALTER TABLE coupons ADD COLUMN reward_grant_id TEXT;
ALTER TABLE coupons ADD COLUMN product_ids TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_coupons_reward_grant ON coupons(reward_grant_id)
  WHERE reward_grant_id IS NOT NULL;

-- ============================================================================
-- (2) REWARD GRANTS. One row per reward coupon.
--
--   kind        'free_shipping'      standard delivery free on one order;
--               'filament_discount'  the owner's percentage on the filaments
--                                    they selected.
--   source      'printer'      issued on delivery, one pair per printer unit;
--               'points_shop'  bought with points on the rewards page;
--               'admin'        issued or replaced by an admin.
--   source_ref  THE IDEMPOTENCY KEY. 'printer:<order_item_id>:<unit>:<kind>'
--               for a printer unit, 'shop:<grant id>' for a purchase. UNIQUE:
--               a delivery replayed by a walk-back, a retried hook or the
--               catch-up sweep collides here and issues nothing twice.
--   coupon_id   the coupons row this grant minted (one each, UNIQUE).
--   points_spent / points_tx_id  what a shop purchase cost, and its POINT
--               withdrawal in wallet_transactions.
--   terms       the promise as issued (JSON), for the page and for support.
--   expires_at  the coupon's own `ends_at`, copied for the indexes below.
--   reminded_at the 24-hour expiry reminder was sent.
--   revoked_at / revoke_reason  withdrawn: 'order_cancelled', 'return:<case>'
--               or 'admin'. A coupon already spent on an order is never
--               taken back from that order.
--
-- No foreign key on order_id: a cancelled order is deleted after seven days
-- (worker/lib/orderDeletion.ts lists this table as history, unlinked, never
-- deleted).
-- ============================================================================
CREATE TABLE IF NOT EXISTS reward_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('free_shipping', 'filament_discount')),
  source TEXT NOT NULL CHECK (source IN ('printer', 'points_shop', 'admin')),
  source_ref TEXT NOT NULL,
  order_id TEXT,
  order_item_id TEXT,
  unit_index INTEGER,
  coupon_id TEXT NOT NULL,
  points_spent INTEGER NOT NULL DEFAULT 0 CHECK (points_spent >= 0),
  points_tx_id TEXT,
  terms TEXT NOT NULL DEFAULT '{}',
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reminded_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'system'
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_reward_grants_source ON reward_grants(source_ref);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reward_grants_coupon ON reward_grants(coupon_id);
CREATE INDEX IF NOT EXISTS idx_reward_grants_user ON reward_grants(user_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_reward_grants_order ON reward_grants(order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reward_grants_live ON reward_grants(expires_at)
  WHERE revoked_at IS NULL;

-- ============================================================================
-- (3) COMPETITIONS. The owner creates them later from Admin → Rewards.
--
--   entry_mode    'free' or 'points' (entry_points are withdrawn on entry and
--                 given back if the competition is cancelled);
--   submission    what an entry carries: nothing, a written answer, a photo,
--                 or both;
--   eligibility   'everyone', or 'printer_owners' (a printer delivered to the
--                 customer from this shop);
--   prize_points  a JSON array of points for 1st, 2nd, 3rd … place, credited
--                 when the owner announces the winners;
--   prize_*       the prize in words (a spool, a nozzle …) for anything that
--                 is not points; handed over by the shop.
--   state         'draft' → 'published' → 'finished', or 'cancelled'. Whether a
--                 published competition is OPEN is its window, read from the
--                 server's clock, never stored.
--
-- WINNERS ARE CHOSEN BY THE OWNER. There is no random draw here: the legality
-- of draws in Iraq is still open (DECISIONS row 25), so nothing in this
-- schema can pick a winner by chance.
-- ============================================================================
CREATE TABLE IF NOT EXISTS reward_competitions (
  id TEXT PRIMARY KEY,
  title_ar TEXT NOT NULL,
  title_en TEXT NOT NULL DEFAULT '',
  title_ckb TEXT NOT NULL DEFAULT '',
  description_ar TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  description_ckb TEXT NOT NULL DEFAULT '',
  prize_ar TEXT NOT NULL DEFAULT '',
  prize_en TEXT NOT NULL DEFAULT '',
  prize_ckb TEXT NOT NULL DEFAULT '',
  entry_mode TEXT NOT NULL DEFAULT 'free' CHECK (entry_mode IN ('free', 'points')),
  entry_points INTEGER NOT NULL DEFAULT 0 CHECK (entry_points >= 0),
  submission TEXT NOT NULL DEFAULT 'none' CHECK (submission IN ('none', 'text', 'photo', 'photo_text')),
  eligibility TEXT NOT NULL DEFAULT 'everyone' CHECK (eligibility IN ('everyone', 'printer_owners')),
  prize_points TEXT NOT NULL DEFAULT '[]',
  max_entries INTEGER CHECK (max_entries IS NULL OR max_entries > 0),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'finished', 'cancelled')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT,
  finished_at TEXT,
  cancelled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reward_competitions_state ON reward_competitions(state, ends_at);

-- One entry per customer per competition (UNIQUE). `place` is set on the
-- winners only, once, by the owner's announcement; two entries can never hold
-- the same place.
CREATE TABLE IF NOT EXISTS reward_competition_entries (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES reward_competitions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  answer TEXT NOT NULL DEFAULT '',
  media_key TEXT NOT NULL DEFAULT '',
  entry_points INTEGER NOT NULL DEFAULT 0 CHECK (entry_points >= 0),
  entry_tx_id TEXT,
  state TEXT NOT NULL DEFAULT 'entered' CHECK (state IN ('entered', 'disqualified', 'winner', 'refunded')),
  place INTEGER CHECK (place IS NULL OR place > 0),
  prize_points INTEGER NOT NULL DEFAULT 0 CHECK (prize_points >= 0),
  prize_tx_id TEXT,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  decided_by TEXT,
  UNIQUE (competition_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_reward_competition_place
  ON reward_competition_entries(competition_id, place) WHERE place IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reward_competition_entries_user
  ON reward_competition_entries(user_id, created_at);

-- ============================================================================
-- (4) A CANCEL BY ANY DOOR WITHDRAWS THE PRINTER'S COUPONS.
--
-- The coupons are issued on delivery, and `delivered → cancelled` is refused,
-- but `delivered → shipped → cancelled` is not (worker/lib/orderStages.ts):
-- an order walked back from delivered and then cancelled never left a printer
-- with the customer, so the coupons it earned go off. Every door writes
-- `orders.status`, so a trigger catches the customer's cancel, the admin
-- dropdown, the stage door and the expiry and Gini sweeps alike (the 0191 and
-- 0175 pattern).
--
-- A coupon already spent on another order stays spent: that order keeps its
-- discount. Switching the coupon off only means that, if that other order is
-- cancelled in turn, the released use cannot be spent again.
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_orders_reward_coupons_withdrawn
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
BEGIN
  UPDATE coupons
     SET active = 0
   WHERE active = 1
     AND reward_grant_id IN (SELECT g.id FROM reward_grants g
                              WHERE g.order_id = NEW.id AND g.source = 'printer' AND g.revoked_at IS NULL);
  UPDATE reward_grants
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoke_reason = 'order_cancelled'
   WHERE order_id = NEW.id AND source = 'printer' AND revoked_at IS NULL;
END;

-- Reopening the order gives back exactly what its cancel withdrew (and only
-- that: a coupon withdrawn for a return or by an admin stays off). A coupon
-- whose seven days ran out meanwhile comes back expired — the checkout refuses
-- it on its own `ends_at`.
CREATE TRIGGER IF NOT EXISTS trg_orders_reward_coupons_restored
AFTER UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
BEGIN
  UPDATE coupons
     SET active = 1
   WHERE active = 0
     AND reward_grant_id IN (SELECT g.id FROM reward_grants g
                              WHERE g.order_id = NEW.id AND g.source = 'printer' AND g.revoke_reason = 'order_cancelled');
  UPDATE reward_grants
     SET revoked_at = NULL, revoke_reason = ''
   WHERE order_id = NEW.id AND source = 'printer' AND revoke_reason = 'order_cancelled';
END;
