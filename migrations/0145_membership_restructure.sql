-- ============================================================================
--  0145 — THE MEMBERSHIPS, RESTRUCTURED (owner, 2026-09-27)
-- ============================================================================
-- «إيقاف اشتراكات البرو وتعليق لمن لديه الاشتراك إلى إشعار آخر … البلس يتم
-- تخفيض سعرها مع الحفاظ على مميزاتها في فتح هوية التاجر في مجتمع ليفو،
-- والبريميوم يكون فقط إضافة ميزة أنه توصيل مجاني للعادي فوق 75 ألف … أي أن
-- اشتراك البريميوم لا يحمل خصومات … أما المميزات الأخرى فألغيها.»
--
--   1. PRO IS PAUSED. No PRO card is sold while `proPause.paused` is true
--      (worker/lib/tierPause.ts), and every running PRO membership is FROZEN:
--      `paused_at` stops its clock, so the days a member paid for are not
--      spent while the owner rebuilds the tier. Resuming (the admin's
--      «استئناف PRO») pushes each frozen `expires_at` forward by exactly the
--      time it was frozen and clears `paused_at`. While frozen, the member
--      keeps what PREMIUM and PLUS give (their store and merchant identity
--      stay up) — never a PRO price, PRO delivery, BNPL or PRO priority.
--   2. PLUS costs 1,000 IQD a month and 10,000 a year, the 3- and 6-month
--      cards in between; its benefits are unchanged.
--   3. PREMIUM is sold for 1, 3, 6 and 12 months from 12,000 to 99,000, and is
--      worth exactly: everything PLUS gives, free STANDARD delivery on orders
--      above 75,000, and its badge in the community. Its discounts, its
--      cash-on-delivery exemption and its points multiplier end — the rules
--      are switched off here, and the entitlements that granted them now start
--      at PRO (worker/lib/entitlements.ts), so no rule an admin re-enables can
--      bring a PREMIUM discount back by accident.
--
-- Nothing here re-prices an order already placed: an order carries the benefit
-- version it was priced under (0074), and a membership already bought keeps
-- its own dates and its own price paid.

-- ---------------------------------------------------------------- 1. PRO pause

ALTER TABLE memberships ADD COLUMN paused_at TEXT;

-- The switch. Written only where no row exists yet, so an owner who resumes
-- PRO and later re-deploys is not paused again by a replay of this file.
INSERT INTO admin_settings (key, value)
SELECT 'proPause', json_object('paused', json('true'), 'since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 WHERE NOT EXISTS (SELECT 1 FROM admin_settings WHERE key = 'proPause');

-- Every PRO membership still running is frozen now. One that has already run
-- out is not revived; one frozen before is left with its own moment. Only
-- while the switch says paused: a replay after the owner resumed PRO freezes
-- nobody.
UPDATE memberships
   SET paused_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE tier = 'pro' AND state = 'active' AND paused_at IS NULL
   AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   AND EXISTS (SELECT 1 FROM admin_settings
                WHERE key = 'proPause' AND json_valid(value) AND json_extract(value, '$.paused') = 1);

CREATE INDEX IF NOT EXISTS idx_memberships_paused ON memberships(tier, paused_at) WHERE paused_at IS NOT NULL;

-- ------------------------------------------------------------- 2. PLUS prices

UPDATE membership_plans SET price_iqd = 1000, active = 1 WHERE id = 'plus_1mo';
UPDATE membership_plans SET price_iqd = 2750, active = 1 WHERE id = 'plus_3mo';
UPDATE membership_plans SET price_iqd = 5250, active = 1 WHERE id = 'plus_6mo';
UPDATE membership_plans SET price_iqd = 10000, active = 1 WHERE id = 'plus_12mo';

INSERT OR IGNORE INTO membership_plans (id, tier, duration_months, price_iqd, active, sort) VALUES
  ('plus_1mo', 'plus', 1, 1000, 1, 1),
  ('plus_3mo', 'plus', 3, 2750, 1, 2),
  ('plus_6mo', 'plus', 6, 5250, 1, 3),
  ('plus_12mo', 'plus', 12, 10000, 1, 4);

-- ---------------------------------------------------------- 3. PREMIUM prices

INSERT OR IGNORE INTO membership_plans (id, tier, duration_months, price_iqd, active, sort) VALUES
  ('prime_1mo', 'prime', 1, 12000, 1, 5),
  ('prime_3mo', 'prime', 3, 33000, 1, 6),
  ('prime_6mo', 'prime', 6, 60000, 1, 7),
  ('prime_12mo', 'prime', 12, 99000, 1, 8);

UPDATE membership_plans SET price_iqd = 12000, active = 1, sort = 5 WHERE id = 'prime_1mo';
UPDATE membership_plans SET price_iqd = 33000, active = 1, sort = 6 WHERE id = 'prime_3mo';
UPDATE membership_plans SET price_iqd = 60000, active = 1, sort = 7 WHERE id = 'prime_6mo';
UPDATE membership_plans SET price_iqd = 99000, active = 1, sort = 8 WHERE id = 'prime_12mo';

-- One tier after another in every list that orders by \`sort\` (the admin's
-- plan table above all): PLUS 1–4, PREMIUM 5–8, PRO after them.
UPDATE membership_plans SET sort = 9 WHERE tier = 'pro' AND sort < 9;

-- ------------------------------------------------------ 4. PREMIUM's benefits

-- No PREMIUM discount of any kind: store-wide, per section or per product.
UPDATE membership_benefit_rules
   SET enabled = 0, updated_at = datetime('now'), updated_by = 'migration:0145'
 WHERE tier = 'prime' AND benefit_type = 'product_discount' AND enabled = 1;

-- The cash-on-delivery tax applies to PREMIUM.
UPDATE membership_benefit_rules
   SET cod_tax_exempt = 0, updated_at = datetime('now'), updated_by = 'migration:0145'
 WHERE tier = 'prime' AND benefit_type = 'cod_tax_exemption' AND COALESCE(cod_tax_exempt, 0) <> 0;

-- Free STANDARD delivery above 75,000 — the one store-wide rule. A section's
-- own PREMIUM delivery rule would outrank it there, so none stays switched on.
INSERT OR IGNORE INTO membership_benefit_rules
  (id, tier, benefit_type, scope, free_shipping_threshold_iqd, shipping_methods, enabled, priority, label)
VALUES
  ('seed-premium-free-shipping', 'prime', 'free_shipping', 'global', 75000, '["standard"]', 1, 0,
   'PREMIUM free delivery — standard only');

UPDATE membership_benefit_rules
   SET free_shipping_threshold_iqd = 75000, shipping_methods = '["standard"]', max_shipping_subsidy_iqd = NULL,
       scope = 'global', category_id = NULL, sub_category_id = NULL, product_id = NULL,
       enabled = 1, valid_from = NULL, valid_until = NULL,
       label = 'PREMIUM free delivery — standard only, above 75,000',
       updated_at = datetime('now'), updated_by = 'migration:0145'
 WHERE id = 'seed-premium-free-shipping';

UPDATE membership_benefit_rules
   SET enabled = 0, updated_at = datetime('now'), updated_by = 'migration:0145'
 WHERE tier = 'prime' AND benefit_type = 'free_shipping' AND id <> 'seed-premium-free-shipping' AND enabled = 1;

-- The legacy fallback the shipping engine reads when no PREMIUM rule exists
-- says the same number, so the two can never disagree at the door.
UPDATE admin_settings
   SET value = json_set(value, '$.prime_threshold_iqd', 75000)
 WHERE key = 'shippingPolicy'
   AND json_valid(value) AND json_type(value) = 'object'
   AND COALESCE(json_extract(value, '$.prime_threshold_iqd'), 0) <> 75000;

-- THE VERSION THE NEXT ORDER IS PRICED UNDER. Every change to the rules
-- appends the whole rule set (0074 §6); this is the set as it stands after the
-- statements above, in the shape `allBenefitRules` writes, so an order placed
-- from now on points at a version that describes it.
INSERT INTO membership_benefit_versions (actor_user_id, action, rule_id, before_json, after_json, rules_json)
SELECT NULL, 'restructure', NULL, NULL,
       json_object('note', 'PREMIUM = PLUS + free standard delivery above 75,000 + badge; PRO paused'),
       (SELECT json_group_array(json(r.doc)) FROM (
          -- `END ,` (a space before the comma): Wrangler's splitter closes a CASE
          -- only on an END followed by a space or a semicolon.
          SELECT json_object(
                   'id', id, 'tier', tier, 'benefit_type', benefit_type, 'scope', scope,
                   'category_id', category_id, 'sub_category_id', sub_category_id, 'product_id', product_id,
                   'discount_mode', discount_mode, 'percent', percent, 'fixed_iqd', fixed_iqd,
                   'max_discount_iqd', max_discount_iqd, 'cap_scope', cap_scope, 'max_quantity', max_quantity,
                   'min_subtotal_iqd', min_subtotal_iqd,
                   'free_shipping_threshold_iqd', free_shipping_threshold_iqd,
                   'shipping_methods', CASE WHEN shipping_methods IS NULL OR NOT json_valid(shipping_methods) THEN NULL ELSE json(shipping_methods) END ,
                   'max_shipping_subsidy_iqd', max_shipping_subsidy_iqd,
                   'cod_tax_exempt', CASE WHEN cod_tax_exempt IS NULL THEN NULL WHEN cod_tax_exempt = 1 THEN json('true') ELSE json('false') END ,
                   'enabled', CASE WHEN enabled = 1 THEN json('true') ELSE json('false') END ,
                   'priority', priority, 'valid_from', valid_from, 'valid_until', valid_until, 'label', label
                 ) AS doc
            FROM membership_benefit_rules
           ORDER BY tier, benefit_type, scope, priority DESC, id
        ) r)
 WHERE NOT EXISTS (SELECT 1 FROM membership_benefit_versions WHERE action = 'restructure');
