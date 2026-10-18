-- 0201 — BUNDLES AND MYSTERY BOXES ARE OPEN TO EVERY VISITOR (the owner's decision of 2026-10-18,
-- DECISIONS row 251, amending addendum A.14 / Q7 and §17 decision 2)
--
-- «واجعل القسم ايضا يظهر للكل (حاليا منحصر لدى المشتركين فقط)». The section was members-only through
-- one thing alone: the `required_tiers` set 0063 wrote onto every migrated bundle's offer window,
-- ["plus","prime","pro"], which `offerEligible` (worker/lib/offers.ts) turns into MEMBERSHIP_REQUIRED
-- on the card, the cart and the checkout door. 0063 left clearing it to the owner (§17 decision 2);
-- this is that decision, for every composition at once.
--
-- ONLY THE GATE MOVES. The window's schedule, its percent or amount discount, its limits and its
-- `active` flag stay; no price, no stock and no membership benefit changes here (a member's benefit
-- is a pricing rule, not a gate). An admin may still gate one promotion deliberately afterwards; the
-- bundles panel announces any gate it finds (BUNDLE_MEMBERS_ONLY_RESTRICTION).
--
-- Idempotent: a second pass matches no row. An ordinary product's window is never touched.
UPDATE offer_windows
   SET required_tiers = '[]'
 WHERE subject_type = 'product'
   AND COALESCE(required_tiers, '[]') <> '[]'
   AND subject_id IN (SELECT id FROM products WHERE COALESCE(composition, '') <> '');
