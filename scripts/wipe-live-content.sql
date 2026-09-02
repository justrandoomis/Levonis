-- ============================================================================
-- LIVE CONTENT WIPE — owner-ordered reset of levonis-db-staging (2026-09-02).
--
-- Scope, confirmed by the owner in three explicit answers:
--   1. ALL products, ALL community merchants/stores, ALL points/wallets,
--      ALL orders/invoices, and every dummy/test row.
--   2. ALL user accounts are deleted EXCEPT real admin accounts (the owner's
--      login must survive; a run that would keep zero admins must be aborted
--      by the caller BEFORE this file is executed).
--   3. Structure and configuration stay: catalogs, facets, brands, coupons,
--      membership plans, shipping/delivery config, policies, glossary,
--      admin settings, reserved slugs.
--
-- The caller records a D1 Time Travel bookmark first — the entire
-- pre-wipe state stays restorable for 30 days.
--
-- KEPT USERS: POSITIVE selection only. __KEEP_EMAILS__ is substituted by the
-- workflow with the exact quoted email list the owner named; the guard step
-- has already verified every one of them exists as a live admin account.
-- Pattern-based exclusion was rejected: rehearsal showed test fixtures
-- slipping through lookalike domains.
--
-- Ordering is strictly children-before-parents so foreign keys hold at every
-- intermediate statement.
-- ============================================================================

-- The order below is the machine-verified topological sort of the REAL FK
-- graph read from sqlite_master (ALTER-added references included), children
-- strictly before parents. One genuine cycle exists — community_orders.chat_id
-- and the chat pointing back at its order — broken by nulling the nullable
-- side first.

UPDATE community_orders SET chat_id = NULL;
DELETE FROM rate_limits;
DELETE FROM cart_items;
DELETE FROM outbox;
DELETE FROM telegram_updates;
DELETE FROM tg_admin_actions;
DELETE FROM tg_admin_notifications;
DELETE FROM audit_log;
DELETE FROM browse_sessions;
DELETE FROM game_sessions;
DELETE FROM studio_handoff_codes;
DELETE FROM claim_messages;
DELETE FROM warranty_claims;
DELETE FROM return_cases;
DELETE FROM price_protection_claims;
DELETE FROM device_registrations;
DELETE FROM device_serials;
DELETE FROM support_ticket_messages;
DELETE FROM support_tickets;
DELETE FROM order_item_units;
DELETE FROM order_payment_settlements;
DELETE FROM order_status_history;
DELETE FROM invoices;
DELETE FROM inventory_ledger;
DELETE FROM coupon_redemptions;
DELETE FROM gift_redemptions;
DELETE FROM gift_entitlements;
DELETE FROM review_rewards;
DELETE FROM reviews;
DELETE FROM order_items;
DELETE FROM points_accruals;
DELETE FROM points_reservations;
DELETE FROM bnpl_ledger;
DELETE FROM support_gift_entitlements;
DELETE FROM chat_messages;
DELETE FROM chat_participants;
DELETE FROM chats;
DELETE FROM orders;
DELETE FROM favorites;
DELETE FROM bundle_items;
DELETE FROM bundles;
DELETE FROM product_catalogs;
DELETE FROM product_facets;
DELETE FROM product_color_option_links;
DELETE FROM product_images;
DELETE FROM product_variants;
DELETE FROM product_colors;
DELETE FROM product_option_values;
DELETE FROM product_option_groups;
DELETE FROM product_translations;
DELETE FROM product_imports;
DELETE FROM price_history;
DELETE FROM products;
DELETE FROM community_complaint_messages;
DELETE FROM community_complaints;
DELETE FROM community_escrow_events;
DELETE FROM merchant_payout_ledger;
DELETE FROM community_escrows;
DELETE FROM community_order_items;
DELETE FROM merchant_reviews;
DELETE FROM community_orders;
DELETE FROM community_offers;
DELETE FROM community_request_files;
DELETE FROM community_requests;
DELETE FROM community_product_favorites;
DELETE FROM community_products;
DELETE FROM merchant_coupons;
DELETE FROM merchant_notification_preferences;
DELETE FROM merchant_reputation_events;
DELETE FROM merchant_services;
DELETE FROM merchant_showcase;
DELETE FROM merchant_store_analytics_daily;
DELETE FROM merchant_store_sections;
DELETE FROM merchant_store_slugs;
DELETE FROM follows;
DELETE FROM merchant_stores;
DELETE FROM community_merchants;
DELETE FROM points_awards;
DELETE FROM wallet_deposit_meta;
DELETE FROM wallet_review_requests;
DELETE FROM wallet_withdrawals;
DELETE FROM wallet_adjustments;
DELETE FROM wallet_holds;
DELETE FROM wallet_transactions;
DELETE FROM bnpl_accounts;
DELETE FROM ticket_ledger;
DELETE FROM reward_claims;
DELETE FROM gift_pool_items;
DELETE FROM gift_pools;
DELETE FROM referral_rewards;
DELETE FROM referral_attributions;
DELETE FROM investor_messages;
DELETE FROM investment_items;
DELETE FROM investments;
DELETE FROM addresses WHERE user_id NOT IN (SELECT id FROM users WHERE email IN (__KEEP_EMAILS__));
DELETE FROM approved_addresses WHERE user_id NOT IN (SELECT id FROM users WHERE email IN (__KEEP_EMAILS__));
DELETE FROM telegram_links WHERE user_id NOT IN (SELECT id FROM users WHERE email IN (__KEEP_EMAILS__));
DELETE FROM admin_tg_identities WHERE user_id NOT IN (SELECT id FROM users WHERE email IN (__KEEP_EMAILS__));
DELETE FROM policy_acceptances WHERE user_id NOT IN (SELECT id FROM users WHERE email IN (__KEEP_EMAILS__));
DELETE FROM memberships WHERE user_id NOT IN (SELECT id FROM users WHERE email IN (__KEEP_EMAILS__));
DELETE FROM referral_codes WHERE user_id NOT IN (SELECT id FROM users WHERE email IN (__KEEP_EMAILS__));
DELETE FROM kyc_cases;
DELETE FROM restriction_cases;
DELETE FROM link_challenges;
DELETE FROM otp_challenges;
DELETE FROM email_verification_tokens;
DELETE FROM password_reset_tokens;
DELETE FROM sessions;
DELETE FROM users WHERE email NOT IN (__KEEP_EMAILS__);

-- Kept admins start from zero too: no points streaks bought with test data.
UPDATE users SET checkin_streak = 0, last_checkin_day = NULL;
