-- Levonis migration 0077 — TARGETED COUPONS.
--
-- STRICTLY ADDITIVE to `coupons` and `coupon_redemptions`: nineteen ADD
-- COLUMNs, one ADD COLUMN on order_items, four indexes, and ONE trigger
-- replaced (the limit trigger must stop counting released redemptions).
-- Nothing is dropped, no existing value is rewritten, no row is deleted.
-- Every existing coupon keeps working byte-identically: the defaults below are
-- chosen so an untouched row means "global scope, no cap, merchandise only,
-- stacks" — exactly today's behaviour.
--
-- ============================== WHY ========================================
--
-- The owner asked for coupons that can name an audience, a product, a section,
-- a sub-section, a brand, a bundle, an option model, a colour, an order type,
-- an import route and a delivery method — with a percentage that may be
-- capped, a minimum cart value, a validity window and usage limits.
--
-- `coupons` (0002, rebuilt 0029) carries nine columns and expresses about a
-- third of that. But the vocabulary for the rest ALREADY EXISTS in this tree,
-- in migration 0074's `membership_benefit_rules`: scope/category_id/
-- sub_category_id/product_id matched through `catalogAncestry`, percent-or-
-- fixed, `max_discount_iqd` WITH `cap_scope`, `max_quantity`,
-- `min_subtotal_iqd`, a validity window and a JSON array of delivery methods.
-- 0074's own comments explain why each exists. This migration COPIES that
-- vocabulary rather than inventing a fourth promotion model, so that one
-- resolver, one ancestry walk and one set of words serve both.
--
-- Two axes 0074 does not have are added because the owner's own example needs
-- them: an OPTION MODEL and a COLOUR. "A1 Combo" is not a product and not a
-- bundle — it is a `product_option_values` row (see 0073's four-axis note),
-- and a coupon keyed only on `products.id` would fire on every A1 ever sold,
-- in every colour, direct sale included.

-- ------------------------------------------------------------- AUDIENCE

-- ONE NAMED CUSTOMER. NULL = the coupon is not personal.
--
-- A USER ID, NEVER A USERNAME. `users.username` is UNIQUE but MUTABLE and is
-- FREED on rename (0013:23-27, worker/routes/profile.ts), so a coupon storing
-- the handle would be redeemable by whoever holds it at redemption time: the
-- original owner renames, a second account claims the handle, and a 950,000
-- IQD discount changes hands with no audit trail. 0016:73 already states the
-- rule for this exact hazard — "stable user ids, never usernames". The admin
-- types a username; the server resolves it once, at save time, and stores this.
ALTER TABLE coupons ADD COLUMN assigned_user_id TEXT REFERENCES users(id);

-- The handle as typed, kept ONLY as a label so the admin list can show who the
-- coupon is for without a join. Never matched against.
ALTER TABLE coupons ADD COLUMN assigned_username TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------- SCOPE

-- 0074's four scopes plus the two this shop needs. 'global' carries no target
-- and matches every line, which is what every pre-0077 coupon is.
ALTER TABLE coupons ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE coupons ADD COLUMN category_id TEXT;
ALTER TABLE coupons ADD COLUMN sub_category_id TEXT;
ALTER TABLE coupons ADD COLUMN product_id TEXT;
ALTER TABLE coupons ADD COLUMN brand_id TEXT;
ALTER TABLE coupons ADD COLUMN bundle_product_id TEXT;

-- THE MODEL AND THE COLOUR, the two axes 0074 has no word for. Both are
-- FILTERS, not scopes: they narrow whatever `scope` selected. A coupon with
-- scope='product' + option_value_id set means "this product, but only this
-- model"; option_value_id alone with scope='global' is refused by the writer,
-- because a model id is meaningless without the product that owns it.
ALTER TABLE coupons ADD COLUMN option_value_id TEXT;
ALTER TABLE coupons ADD COLUMN color_id TEXT;

-- THREE INDEPENDENT AXES 0073 forbids conflating, each a JSON array.
-- '[]' (the default) means ANY — no filter. A non-empty array is an allowed
-- set, matched against the line's own value.
--   fulfillment_types  'direct_sale' | 'pre_order'   — the ORDER TYPE
--   transport_methods  'air' | 'sea' | 'land'        — the IMPORT ROUTE
--   delivery_methods   'standard' | 'personal'       — the LAST MILE
ALTER TABLE coupons ADD COLUMN fulfillment_types TEXT NOT NULL DEFAULT '[]';
ALTER TABLE coupons ADD COLUMN transport_methods TEXT NOT NULL DEFAULT '[]';
ALTER TABLE coupons ADD COLUMN delivery_methods TEXT NOT NULL DEFAULT '[]';

-- ------------------------------------------------------- VALUE AND CAP

-- THE CEILING ON A PERCENTAGE, and the thing it is a ceiling ON. 0074's words
-- and 0074's reasoning, verbatim: per_unit means each eligible unit is
-- discounted at most this much, so two printers at a 100,000 cap save 200,000;
-- per_order caps the whole coupon once. Getting it wrong is a real amount of
-- money, so it is stored rather than assumed. NULL = uncapped, which is the
-- owner's "بدون حد".
ALTER TABLE coupons ADD COLUMN max_discount_iqd INTEGER;
ALTER TABLE coupons ADD COLUMN cap_scope TEXT NOT NULL DEFAULT 'per_order';

-- HOW MANY UNITS QUALIFY. NULL = every matching unit in the cart.
ALTER TABLE coupons ADD COLUMN max_quantity INTEGER;

-- ------------------------------------------------------ WHAT IT REDUCES

-- The owner's second example discounts the DELIVERY, not the goods. The first
-- discounts the goods and only uses delivery as a condition. Both are real, so
-- the admin chooses per coupon rather than the engine assuming.
--   'merchandise' — the matching lines' goods value (the default, and what
--                   every pre-0077 coupon does)
--   'delivery'    — the delivery fee only; merchandise is untouched
--   'both'        — merchandise first, then any remainder against delivery
ALTER TABLE coupons ADD COLUMN applies_to TEXT NOT NULL DEFAULT 'merchandise';

-- MAY IT COMBINE WITH A MEMBERSHIP DISCOUNT OR A PRODUCT OFFER?
-- 1 = yes (today's behaviour, and what "خصم لكل الأعضاء" means). 0 = the
-- coupon is refused on any line that already carries one, so a VIP price is
-- not quietly discounted twice.
ALTER TABLE coupons ADD COLUMN stacks INTEGER NOT NULL DEFAULT 1;

-- ------------------------------------------------- REDEMPTION LIFECYCLE

-- A REDEMPTION MUST BE RELEASABLE. Until now a cancelled or expired order left
-- its `coupon_redemptions` row counting against the limit for ever: the
-- customer never received anything, the code cannot be edited (the admin route
-- refuses) and the row cannot be deleted, so a single-use 950,000 coupon was
-- destroyed by an order that was never paid for. Every other reservation in
-- this tree already releases — wallet, points, accruals, stock, BNPL and offer
-- slots all do (worker/lib/orderCancelOps.ts) — and `offer_redemptions` got
-- exactly these two columns in 0065 for exactly this reason.
ALTER TABLE coupon_redemptions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE coupon_redemptions ADD COLUMN released_at TEXT;

-- WHICH LINE THE COUPON ACTUALLY HIT, frozen on the order.
--
-- Without this a refund has nothing to go on and prorates the discount across
-- every line by gross value, which is wrong in BOTH directions once a coupon
-- is targeted: returning the untouched filament from a 950,000-printer-coupon
-- order refunds a fraction of what the customer paid, and returning the
-- printer refunds more. Same shape, same column name, same reason as 0074's
-- `order_items.membership_discount_iqd`.
ALTER TABLE order_items ADD COLUMN coupon_discount_iqd INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------------------- INDEXES

CREATE INDEX IF NOT EXISTS idx_coupons_assigned_user ON coupons(assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_scope ON coupons(scope, active);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_active
  ON coupon_redemptions(coupon_id, user_id) WHERE state = 'active';

-- --------------------------------------------------- THE LIMIT TRIGGER

-- REPLACED, not added to. `trg_coupon_redemption_limits` (0049) is the only
-- concurrency-safe limit in the coupon path — validateCoupon's COUNT(*) is
-- explicitly advice, because two requests can both count zero. The trigger
-- must now ignore released rows, or a released redemption would still consume
-- the use it was released from.
DROP TRIGGER IF EXISTS trg_coupon_redemption_limits;

CREATE TRIGGER trg_coupon_redemption_limits
BEFORE INSERT ON coupon_redemptions
BEGIN
  SELECT RAISE(ABORT, 'COUPON_PER_USER_LIMIT')
   WHERE (SELECT COUNT(*) FROM coupon_redemptions r
           WHERE r.coupon_id = NEW.coupon_id AND r.user_id = NEW.user_id
             AND r.state = 'active')
         >= (SELECT c.max_per_user FROM coupons c WHERE c.id = NEW.coupon_id);
  SELECT RAISE(ABORT, 'COUPON_GLOBAL_LIMIT')
   WHERE (SELECT c.max_global FROM coupons c WHERE c.id = NEW.coupon_id) IS NOT NULL
     AND (SELECT COUNT(*) FROM coupon_redemptions r
           WHERE r.coupon_id = NEW.coupon_id AND r.state = 'active')
         >= (SELECT c.max_global FROM coupons c WHERE c.id = NEW.coupon_id);
  -- A PERSONAL COUPON IS REFUSED TO EVERYONE ELSE, IN THE TRANSACTION.
  -- The resolver checks this too, but a guard that only lives in application
  -- code is one forgotten call site away from handing a 950,000 IQD discount
  -- to whoever learned the code.
  SELECT RAISE(ABORT, 'COUPON_NOT_YOURS')
   WHERE (SELECT c.assigned_user_id FROM coupons c WHERE c.id = NEW.coupon_id) IS NOT NULL
     AND (SELECT c.assigned_user_id FROM coupons c WHERE c.id = NEW.coupon_id) <> NEW.user_id;
END;
