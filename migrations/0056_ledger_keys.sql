-- ---------------------------------------------------------------------------
-- 0056 — ledger idempotency keys, and the indexes the read paths already need.
-- Owner: ledger (01-TARGET.md §2.1). Applied by workflow 7 BEFORE any code
-- that writes the new columns (02-MIGRATION-PLAN.md slice 0.4, two-PR rule).
-- ---------------------------------------------------------------------------
-- Numbering: the plan reserved `0055_ledger_keys`; `0055_option_color_names`
-- was merged first by the TXT-import parity round, so every reserved number
-- moved up one (see the renumbering note at the top of 02-MIGRATION-PLAN.md).
--
-- WHY THE COLUMNS. `wallet_transactions` is the money journal. Its writers
-- already mint deterministic ids (`wtx_ord_<id>_usd`, `wtx_ret_<caseId>`,
-- `wtx_refund_<id>_pts`, …) and rely on the PRIMARY KEY to make a replay a
-- no-op. `event_key` makes that contract explicit and portable: it is the key
-- `LedgerApi` commands carry (packages/contracts `rpc/ledger.ts`), the key
-- `PaymentCompleted`/`RefundCompleted` publish (03-EVENTS.md §3.9/§3.11), and
-- the column the partial UNIQUE index below refuses to see twice — so the same
-- business event cannot post two rows even under two different row ids.
-- `correlation_id` and `source_service` say which request and which service
-- wrote a row, which is what a reconciliation report can otherwise only guess.
--
-- ADDITIVE AND UNUSED ON ARRIVAL. All three columns are NOT NULL DEFAULT '',
-- so every existing row keeps its meaning ('' = "written before the key
-- existed") and every reader that has never heard of them is unaffected. No
-- existing row is rewritten. The UNIQUE index is PARTIAL — `WHERE event_key
-- <> ''` — so today's rows, all of them '', do not collide with each other;
-- uniqueness starts applying the moment a writer supplies a key.
ALTER TABLE wallet_transactions ADD COLUMN event_key TEXT NOT NULL DEFAULT '';
ALTER TABLE wallet_transactions ADD COLUMN correlation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE wallet_transactions ADD COLUMN source_service TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_event_key
  ON wallet_transactions(event_key) WHERE event_key <> '';

-- Every balance SUM filters currency + status + type; the admin lists filter
-- currency/type without a user (00-ASSESSMENT.md §4.3). The existing indexes
-- lead on (user_id, created_at) and status alone, so each balance read scans.
CREATE INDEX IF NOT EXISTS idx_wallet_tx_balance
  ON wallet_transactions(user_id, currency, status, type);

-- ---------------------------------------------------------------------------
-- The pure CREATE INDEX list of 00-ASSESSMENT.md §4.3. Indexes only: not one
-- of these changes a column, a value or a row — they make predicates the code
-- already writes stop scanning.
-- ---------------------------------------------------------------------------
-- products: ORDER BY display_order (products.ts), and the admin/taxonomy/import
-- filters on brand, category and sub-category. NOTE for §4.3's open question:
-- BOTH spellings exist on this table — `subcategory_id` (indexed since 0001)
-- and `sub_category_id` (what the queries actually filter on). The second is
-- the one that was unindexed; this adds it and leaves the first alone.
CREATE INDEX IF NOT EXISTS idx_products_display_order ON products(display_order);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_sub_category ON products(sub_category_id);

-- orders: the admin stage labels and the status+date list.
CREATE INDEX IF NOT EXISTS idx_orders_stage ON orders(stage);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);

-- Identity lookups that today read an unindexed column on every auth attempt.
CREATE INDEX IF NOT EXISTS idx_telegram_links_phone ON telegram_links(phone_e164);
CREATE INDEX IF NOT EXISTS idx_link_challenges_chat ON link_challenges(chat_id);
CREATE INDEX IF NOT EXISTS idx_link_challenges_phone_entered ON link_challenges(phone_entered);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- The cron's prune predicates (jobs.ts steps 2-6) and the 2% rate-limit sweep.
CREATE INDEX IF NOT EXISTS idx_otp_challenges_expires ON otp_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_link_challenges_expires ON link_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- Lists that filter one status/owner column the existing composite indexes
-- do not lead with.
CREATE INDEX IF NOT EXISTS idx_memberships_state ON memberships(state);
CREATE INDEX IF NOT EXISTS idx_community_products_status ON community_products(status);
CREATE INDEX IF NOT EXISTS idx_community_requests_status ON community_requests(status);
CREATE INDEX IF NOT EXISTS idx_merchant_reviews_customer ON merchant_reviews(customer_id);
CREATE INDEX IF NOT EXISTS idx_merchant_payout_ledger_order ON merchant_payout_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_request_matches_merchant ON community_request_matches(merchant_id);
CREATE INDEX IF NOT EXISTS idx_return_cases_unit ON return_cases(unit_id);
CREATE INDEX IF NOT EXISTS idx_claim_messages_file ON claim_messages(file_key);
