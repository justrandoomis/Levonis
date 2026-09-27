-- ============================================================================
--  0146 — ONE POINT PER 1,000 IQD, AND THE POINTS STILL ON HOLD (owner, 2026-09-27)
-- ============================================================================
-- «في نظام النقاط اجعل لكل 1000 دينار نقطة واحدة وليس لكل 100 دينار … كذلك في
-- الأشخاص الذين لم يحصلوا على نقاط (لأنها تبقى معلقة لـ7 أيام) عدّل عليها قبل
-- أن يتم المطالبة للمستخدمين جميعهم»
--
--   1. THE RULE. `pointsRuleConfig` moves to v3: 1 point per full 1,000 IQD of
--      net eligible merchandise (worker/lib/pointsOps.ts). v2 paid 1 per 100.
--      The rate is still frozen on each accrual at the purchase instant, so
--      every order placed from now on earns at v3.
--
--   2. THE POINTS STILL ON HOLD. A purchase accrual waits seven days (and its
--      payment) before it reaches the wallet (0014 §4.3). Every accrual still
--      PENDING at the v2 rate is re-rated to v3 here — for every customer —
--      before the release job can pay it: base = floor(eligible / 1,000), then
--      the subscription multiplier the accrual was FROZEN at, half up, exactly
--      as `buildPurchaseAccrualStatements` computes a new one. The multiplier
--      itself is not re-decided: it is what the member held when they bought.
--
--      Points already RELEASED are history and are not touched (they are in
--      the wallet ledger, possibly spent). A cancelled accrual stays cancelled.
--
--   3. THE RETURNS AGAINST THEM. A partial return on an order still on hold
--      wrote a PENDING reversal row that nets against the purchase at release.
--      Those rows are re-rated with it, each one as `recomputeReversal` would
--      have written it at v3 — the target after the return minus the target
--      before it, in the order the returns happened — so the order's net at
--      release is exactly floor(remaining eligible / 1,000) × its multiplier.
--
-- The reversal rows go first: they are found through a purchase row that is
-- still at 100, which the last statement moves. Every statement is guarded by
-- `iqd_per_point = 100`, so a replay re-rates nothing twice.

-- -------------------------------------------------------------- 1. the rule

UPDATE admin_settings
   SET value = json_set(value,
                        '$.iqd_per_point', 1000,
                        '$.version', 'v3',
                        '$.previous_iqd_per_point', json_extract(value, '$.iqd_per_point'),
                        '$.previous_version', json_extract(value, '$.version'),
                        '$.changed_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 WHERE key = 'pointsRuleConfig'
   AND json_valid(value) AND json_type(value) = 'object'
   AND (json_extract(value, '$.iqd_per_point') IS NOT 1000 OR json_extract(value, '$.version') IS NOT 'v3');

-- A database that never had the row (or had it unreadable) reads the code's
-- defaults, which are v3 too; the row is written so the admin sees the rule.
INSERT INTO admin_settings (key, value)
SELECT 'pointsRuleConfig',
       json_object('iqd_per_point', 1000, 'legacy_iqd_per_point', 1000, 'version', 'v3', 'legacy_version', 'v1',
                   'effective_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 WHERE NOT EXISTS (SELECT 1 FROM admin_settings WHERE key = 'pointsRuleConfig');

-- --------------------------------------------- 3. pending returns, re-rated

UPDATE points_accruals AS r
   SET points = (
         SELECT ((CAST(MAX(0, c.after_iqd) / 1000 AS INTEGER) * c.mult) + 50) / 100
              - ((CAST(MAX(0, c.before_iqd) / 1000 AS INTEGER) * c.mult) + 50) / 100
           FROM (SELECT CAST(COALESCE(p.multiplier_x100, 100) AS INTEGER) AS mult,
                        p.eligible_iqd + COALESCE((SELECT SUM(e.eligible_iqd) FROM points_accruals e
                                                    WHERE e.order_id = r.order_id AND e.kind = 'reversal'
                                                      AND e.state <> 'cancelled'
                                                      AND (e.created_at < r.created_at
                                                           OR (e.created_at = r.created_at AND e.id < r.id))), 0)
                          AS before_iqd,
                        p.eligible_iqd + COALESCE((SELECT SUM(e.eligible_iqd) FROM points_accruals e
                                                    WHERE e.order_id = r.order_id AND e.kind = 'reversal'
                                                      AND e.state <> 'cancelled'
                                                      AND (e.created_at < r.created_at
                                                           OR (e.created_at = r.created_at AND e.id <= r.id))), 0)
                          AS after_iqd
                   FROM points_accruals p
                  WHERE p.order_id = r.order_id AND p.kind = 'purchase') c),
       iqd_per_point = 1000,
       rule_version = 'v3'
 WHERE r.kind = 'reversal' AND r.state = 'pending' AND r.iqd_per_point = 100
   AND EXISTS (SELECT 1 FROM points_accruals p
                WHERE p.order_id = r.order_id AND p.kind = 'purchase' AND p.state = 'pending' AND p.iqd_per_point = 100);

-- ----------------------------------------- 2. pending purchases, re-rated

UPDATE points_accruals
   SET base_points = eligible_iqd / 1000,
       points = ((CAST(eligible_iqd / 1000 AS INTEGER) * CAST(COALESCE(multiplier_x100, 100) AS INTEGER)) + 50) / 100,
       iqd_per_point = 1000,
       rule_version = 'v3'
 WHERE kind = 'purchase' AND state = 'pending' AND iqd_per_point = 100;
