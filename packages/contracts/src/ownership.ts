/**
 * Table → owning service (`01-TARGET.md` §2.1), generated once here so that
 * `tests/ownership.test.ts` can fail when a migration creates a table nobody
 * owns or two services claim one table, and so a service's `OWNERSHIP.json`
 * `owns` list can be checked against the design rather than trusted.
 *
 * Owners are named by their END-STATE service (`ledger`, `commerce`, …). While
 * a table still lives in the shared D1 and the legacy core writes it, the
 * core's writes are listed in `worker/OWNERSHIP.tolerance.json`.
 */
import type { ServiceName } from './subscriptions';

type Owner = ServiceName;

const owned = (owner: Owner, tables: string[]): Array<[string, Owner]> => tables.map((t) => [t, owner]);

/** The design's table list as written — checked for duplicates by `tests/ownership.test.ts`. */
export const TABLE_OWNER_ENTRIES: ReadonlyArray<readonly [string, Owner]> = [
  ...owned('identity', [
    'users', 'sessions', 'password_reset_tokens', 'email_verification_tokens', 'pending_signups', 'telegram_links',
    'link_challenges', 'otp_challenges', 'auth_otp', 'studio_handoff_codes', 'addresses', 'favorites', 'community_product_favorites',
    // A sign-up proof waiting to become an account, and the words a name may
    // not contain. Both belong to whoever creates accounts, which is Identity:
    // `signup_tickets` authorises an INSERT into `users` and nothing else, and
    // `blocked_terms` is consulted by the same request that writes the name.
    'signup_tickets', 'blocked_terms',
    'follows', 'service_keys', 'rate_limits',
  ]),
  ...owned('kyc', ['kyc_cases', 'approved_addresses']),
  ...owned('catalog', [
    'products', 'product_option_groups', 'product_option_values', 'product_colors', 'product_color_option_links',
    'product_variants', 'product_images', 'product_facets', 'product_catalogs', 'product_translations', 'glossary',
    // The MODEL x ORDER TYPE cell and the MODEL x PRE-ORDER x TRANSPORT cell
    // (migration 0073). Catalogue shape and catalogue pricing, so they belong
    // to the same owner as the option rows they hang off.
    'product_option_fulfillment', 'product_option_transports',
    // The import header and its per-product crash-resume checkpoints are one
    // Catalogue aggregate: the checkpoint commits in the same batch as the
    // product rows it says were applied.
    'product_imports', 'product_import_items', 'price_history', 'inventory_ledger', 'catalogs', 'brands', 'facets', 'hashtags', 'bundles', 'bundle_items',
    // 0135 — a section's pooled quantity delivery rule is an attribute of the
    // section, written on the taxonomy screen beside it.
    'category_delivery_rules',
    // 0136 — a slug a section was renamed away from, so old links resolve.
    'catalog_slug_history',
    // 0148 — which printer a maintenance part fits. Two catalogue products and
    // the link between them, written on the product form beside the sections.
    'product_printer_fits',
    /**
     * 0098 — THE COST LAYERS UNDER THE STOCK COUNTERS.
     *
     * `inventory_ledger` is already Catalogue's, and these are the same
     * question one level down: the ledger records that four units moved, and a
     * lot records what those four units cost to acquire. They hang off exactly
     * the identity the ledger names — (scope, scope_id) — so splitting them
     * from it would put one shelf under two owners.
     *
     * `incoming_inventory` is a PURCHASE and could argue for an owner of its
     * own. It does not get one, because this file's tie-break is ownership
     * follows THE WRITER: the only thing that ever writes it is the act of
     * receiving stock, which is a catalogue-stock write, and the only thing
     * that reads it is the same admin screen that reads the lots.
     */
    'inventory_lots', 'incoming_inventory', 'incoming_inventory_receipts',
    'stock_locations', 'inventory_lot_locations', 'stock_transfers', 'purchase_orders', 'purchase_lines',
    'purchase_charges', 'purchase_receiving_notes', 'purchase_receiving_events', 'stock_counts', 'stock_count_lines',
    'inventory_suppliers', 'inventory_reorder_settings',
    'procurement_cost_profiles', 'procurement_selection_cost_defaults',
    // 0179 (FX plan §4.1) — the central exchange rates and shipping rates the
    // pricing engine reads, beside the purchase profiles they replace as the
    // pricing source (procurement keeps its own actual rates, decision D12):
    // the three source pairs, their append-only history, the effective IQD
    // rates derived from them, and the owner's shipping rates in IQD.
    'fx_rate_pairs', 'fx_rate_log', 'pricing_fx_rates', 'pricing_shipping_rates',
    // 0181 (FX plan §4.2, USD design §10) — the pricing engine's private
    // tables: its control row, each product's engine state, the owner's
    // inputs and rules, the computed costs per SKU and channel, and the
    // append-only pricing audit. Catalogue owns them for the reason above:
    // the writer is the act of pricing a catalogue product.
    'pricing_engine_control', 'product_pricing_state', 'pricing_inputs', 'pricing_rules', 'pricing_sku_costs', 'pricing_audit',
    // Stock purchases keep their recurring direct-sale inputs separate from preorder inputs.
    'pricing_direct_purchase',
    // 0183 (FX plan §4.4, FX-7) — the per-SKU final price rung the cart's
    // resolver reads after the colour: written only by the engine's writer.
    'product_sku_prices',
    // 0184 (owner brief 2026-10-10) — each catalogue product's verdict against
    // the one central list of required fields, and the owner's «hide
    // incomplete» hold. Derived from the product row and its pricing data, and
    // written only after a catalogue write or by the catalogue's own sweep.
    'product_completeness',
    'lot_cost_adjustments', 'lot_cost_adjustment_shares', 'inventory_lot_cost_versions', 'lot_count_events',
    // 0093 — «لكيتها بمكان أرخص». A customer's report that a competitor sells
    // this product for less, with OUR price frozen into the row at the moment
    // it was filed.
    //
    // It looks like a Support table (a customer wrote it) and it is not: this
    // file's tie-break is ownership follows THE WRITER, and nothing here is
    // ever answered as a conversation. It is read by exactly one decision —
    // "should this product's price move" — which is Pricing, and it sits
    // beside `price_history`, the other table that exists only to say what a
    // catalogue row cost and when. Its frozen `our_price_iqd` is a copy of
    // `products.price_iqd`, so filing it anywhere else would mean a second
    // service holding a snapshot of a column Catalogue owns.
    'price_reports',
    // THE SEARCH INDEX (migration 0089) and the dictionary it reads. Both are
    // derived from the catalogue and rebuilt from it, so they belong to the
    // owner that writes it — a search index owned by anyone but the catalogue
    // is an index that can disagree with the catalogue.
    'search_tokens', 'search_synonyms',
    // A bundle and a mystery offer ARE `products` rows (docs/BUNDLES_MYSTERY.md §1.2);
    // their composition is catalogue structure, beside options and colours.
    'bundle_config', 'bundle_components', 'bundle_component_choices',
    // A mystery pool is a CURATED SET OF CATALOGUE ROWS with weights, and the
    // offer that draws from it is a `products` row (docs/BUNDLES_MYSTERY.md
    // §1.9). Its draw secret is catalogue configuration too — and the one table
    // no read route joins.
    'mystery_pools', 'mystery_pool_entries', 'mystery_offers', 'mystery_offer_secrets',
  ]),
  ...owned('commerce', [
    'cart_items', 'orders', 'order_items', 'order_payment_settlements', 'checkout_sagas', 'checkout_saga_steps', 'coupons',
    'ops_guards', 'stock_return_inspections',
    'stock_return_lot_evidence',
    'coupon_redemptions', 'return_cases', 'price_protection_claims',
    // 0140 — an admin's proposed new final total and the customer's decision on it.
    'order_price_adjustments',
    // 0143 — «استبدال الجهاز». A delivered LEVONIS line exchanged against a new
    // device. Commerce's and not Devices': the unit and its warranty are only
    // READ (to date the usage and the cover left); what this feature writes is
    // a valuation and a credit, and the credit is spent at Commerce's own
    // checkout through a coupon the request mints (`coupons.trade_in_id`).
    'trade_in_rule_sets', 'trade_in_rules', 'trade_in_requests', 'trade_in_components',
    'trade_in_photos', 'trade_in_events', 'trade_in_claims',
    // The buyer's choices behind one bundle cart line, and the fence that makes a
    // partial inventory movement impossible inside the order's own batch (§1.5, §1.7).
    'cart_bundle_choices', 'order_reservation_fence',
    /**
     * 0098 — WHICH COST LAYERS ONE SOLD LINE ACTUALLY ATE.
     *
     * Commerce's and not Catalogue's, although it points at `inventory_lots`.
     * The row is part of the ORDER RECORD: it sits beside `pricing_snapshot`
     * and `option_snapshot` as a frozen fact about what was sold, it is written
     * once by the deduction inside the order's own batch, and it is never
     * rewritten when the catalogue changes. That is the same reason
     * `order_items` is here while `products` is not.
     */
    'order_item_inventory_allocations',
    // The one promotion model (§1.8): entity-attached windows, limits and
    // redemptions, beside the code-entry mechanism `coupons` already here.
    'offer_windows', 'offer_limits', 'offer_redemptions',
    // What one order actually drew, frozen, and the candidate list it drew
    // against — per-order facts, written in the order's own batch (§1.9).
    'mystery_allocations', 'mystery_draw_audits',
    // 0176 — «الشراء السريع». The draft of ONE ordinary order: Commerce's,
    // because it ends as an order through Commerce's own checkout. Its money
    // is a wallet hold and its stock an inventory reservation — both still
    // written through the ledgers that own them.
    'quick_buy_profiles', 'quick_buy_sessions', 'quick_buy_items', 'quick_buy_actions', 'quick_buy_events',
  ]),
  ...owned('fulfilment', ['order_status_history', 'delivery_status_map', 'order_fulfilment']),
  ...owned('ledger', [
    'wallet_transactions', 'wallet_holds', 'wallet_adjustments', 'ledger_balances', 'ledger_idempotency', 'wallet_withdrawals',
    'wallet_deposit_meta', 'wallet_review_requests', 'admin_tg_identities', 'bnpl_accounts', 'bnpl_ledger', 'points_accruals',
    'points_reservations', 'points_awards', 'reward_claims', 'browse_sessions', 'mission_streaks', 'ticket_ledger', 'game_sessions',
    // 0095 — THE OPERATING-EXPENSE LEDGER: «تكاليف اخرى ... خاصه في لوحه الادمن».
    // Rent, salaries, advertising, customs. They belong to no product and no
    // order, which is exactly why they are not Commerce's: an expense row has
    // no product id and there is no column for one, deliberately, because a
    // per-product net profit would be an invention.
    //
    // They sit with the money for the same reason `admin_tg_identities` does —
    // «who may approve stays with the money» two lines up. These rows ARE the
    // shop's cost base: they are the second half of the net-profit arithmetic
    // whose first half is `wallet_transactions` and `bnpl_ledger`, and every
    // route that touches them is behind the same financial scope §11 uses to
    // keep a cost away from an assistant admin. `expense_categories` is the
    // label set those rows point at, under ON DELETE RESTRICT, so it cannot
    // live under a different owner than the rows it names.
    'operating_expenses', 'expense_categories',
    'supplier_payments', 'finance_staff', 'finance_cost_centers', 'finance_cost_rules', 'finance_rule_versions',
    'finance_order_snapshots', 'finance_task_assignments', 'finance_order_costs', 'finance_advance_settlements', 'finance_staff_payments',
    'finance_payment_allocations', 'finance_cost_reversals', 'finance_expense_links', 'accounting_periods',
    'accounting_accounts', 'accounting_entries', 'accounting_lines', 'finance_collections',
    'finance_posting_errors', 'finance_refund_facts',
    // Order-only revisions, monthly owner promotion and account-linked dues.
    'finance_order_versions', 'finance_order_adjustments', 'finance_order_calculations', 'finance_line_departments',
    'finance_workspace_postings',
    'finance_monthly_promotions', 'finance_promotion_history', 'finance_cost_adjustments', 'finance_staff_basis',
    'finance_staff_reconciliations', 'finance_staff_order_rules',
    // Effective wage timelines, resumable previews and immutable adjustment/payment evidence.
    'finance_wage_versions', 'finance_wage_targets', 'finance_wage_changes', 'finance_withdrawal_reviews',
    'finance_mutation_clock', 'finance_withdrawal_payment_lines', 'finance_wage_preview_jobs', 'finance_wage_pending_targets',
    // Investor defaults are separate from immutable funded-purchase agreements.
    'investment_profiles', 'investment_profile_history', 'investment_legacy_links',
    'purchase_investor_agreements', 'purchase_investor_allocations', 'purchase_investor_receipts', 'purchase_investor_lot_capital',
    'finance_withdrawals', 'finance_withdrawal_allocations', 'finance_withdrawal_payments',
    'investment_contracts', 'investment_contract_voids', 'investor_finance_events', 'investor_allocation_results', 'finance_investor_earnings', 'investor_capital_losses',
  ]),
  ...owned('subscriptions', [
    'membership_plans', 'memberships', 'entitlement_snapshots',
    // What a membership is WORTH, and the versions an order was priced under.
    'membership_benefit_rules', 'membership_benefit_versions',
  ]),
  ...owned('referrals', ['referral_codes', 'referral_attributions', 'referral_rewards', 'support_gift_entitlements']),
  ...owned('marketplace', [
    'community_requests', 'community_request_files', 'community_offers', 'community_orders', 'community_order_items',
    'community_complaints', 'community_complaint_messages', 'merchant_printers', 'merchant_request_prefs',
    'community_print_requests', 'community_request_matches', 'model_view_tokens', 'community_escrows', 'community_escrow_events',
    // 0130 — what each published revision of a request said, and each offer's terms over time (print requests v2).
    'community_request_revisions', 'community_offer_revisions',
    // 0159 — offers V2 (docs/COMMUNITY_ECOSYSTEM.md §9.5): the files a sent offer carries, and a merchant's saved draft.
    'community_offer_files', 'community_offer_drafts',
    // 0132 — eligibility as data (W5-B): the workshop's material stock, the re-match queue, and every read of a request file.
    'merchant_material_stock', 'community_match_queue', 'request_file_reads',
    'merchant_payout_ledger', 'community_merchants', 'merchant_stores', 'merchant_store_slugs', 'reserved_slugs',
    'merchant_notification_preferences', 'community_products', 'merchant_store_sections', 'merchant_services', 'merchant_showcase',
    'merchant_coupons', 'merchant_reviews', 'merchant_reputation_events',
    // 0153 — what the community MAKES (docs/COMMUNITY_ECOSYSTEM.md Phase 1): a
    // maker's projects and posts, and their pictures. Marketplace, because a
    // project is the door into a store, a product and a print request.
    'community_posts', 'community_post_media',
    // 0157 — files on posts and products (Phase 4, §9.4): the model/PDF rows
    // under a post, the merchant's product files, who may download them, and
    // the viewer tokens minted for either (model_view_tokens keeps requests).
    'community_post_files', 'product_files', 'product_file_grants', 'viewer_grants',
    // 0154 — the social graph around it (Phase 2): follows between people,
    // likes, saves, comments, blocks, mutes and content reports.
    'user_follows', 'community_likes', 'community_saves', 'community_comments',
    'user_blocks', 'user_mutes', 'community_reports',
    // 0160 — the discussion under a request, the order's timeline, and which
    // row a content report really names (docs/COMMUNITY_ECOSYSTEM.md §9.5).
    'community_request_comments', 'community_order_updates', 'community_report_targets',
    // 0122 — the store page as data (docs/MERCHANT_PLATFORM.md §4.4): the
    // merchant's working draft and the immutable published revisions the
    // storefront reads through merchant_stores.published_revision_id.
    'store_layout_drafts', 'store_layout_revisions',
    // 0123 — the store's own app identity: one row per rendered home-screen
    // icon size, cut from the merchant's logo (docs/MERCHANT_PLATFORM.md §4.5).
    'merchant_store_icons',
    // 0120 — the merchant's delivery by governorate (W2-A, §4.2): one profile
    // per store and a rule per governorate that departs from its default.
    'merchant_delivery_profiles', 'merchant_delivery_rules',
    // 0121 — the append-only merchant ledger and payout requests (docs/MERCHANT_PLATFORM.md §4.3).
    'merchant_ledger_entries', 'merchant_payouts', 'merchant_ledger_legacy_parts',
    // 0126 — the merchant catalogue (W2-F): option groups, their values and the
    // variants sold, a product's ordered media, and manual collection membership.
    'community_product_options', 'community_product_option_values', 'community_product_variants',
    'community_product_media', 'merchant_collection_products',
    // The print quote engine (migration 0078, `docs/PRINT_QUOTE_ENGINE.md`).
    // It sits here rather than in Catalog because every one of these rows is
    // read to answer «كم تكلف طباعتي» for a `community_requests` job on a
    // `merchant_printers` machine — and `print_quotes.request_id` is a foreign
    // key into this service's own aggregate. `printer_models` and
    // `print_materials` are platform reference data, but a reference table read
    // only by one service is that service's to own.
    'printer_models', 'print_materials', 'merchant_spools',
    'print_analyses', 'print_analysis_materials',
    'print_quotes', 'print_quote_cost_components',
    // What actually happened, which is what turns the estimate into a
    // calibration rather than a permanent guess (§15).
    'print_actuals', 'print_failures', 'printer_calibration_stats',
  ]),
  ...owned('reviews', ['reviews', 'review_rewards', 'gift_entitlements', 'gift_pool_items', 'gift_redemptions', 'gift_pools', 'review_media']),
  ...owned('devices', [
    'order_item_units', 'device_serials', 'device_registrations', 'warranty_claims', 'claim_messages', 'warranty_receipts', 'serial_inventory', 'stock_serial_links',
    // 0178 — a serial bound to an order unit at preparation, before delivery
    // creates the warranty unit (worker/lib/serialAssignments.ts). The
    // device's own history, so Devices' — like device_serials beside it.
    'serial_assignments',
    // 0180 — the owner's serial FORMAT rules per brand and per product (owner
    // decision 2; worker/lib/serialRules.ts). They judge what may become a
    // device's serial, so Devices' — read by every serial door.
    'serial_brand_rules',
  ]),
  ...owned('chat', [
    'chats', 'chat_participants', 'chat_messages', 'chat_typing_presence',
    // 0158 — what the server learned about a pasted URL, once, for every
    // reader (docs/COMMUNITY_ECOSYSTEM.md §9.4 "Link cards"). Chat, because
    // the conversation is the door that writes it; comments and posts read it.
    'link_cards',
  ]),
  ...owned('notifications', [
    'outbox', 'user_notifications', 'telegram_updates', 'tg_admin_notifications', 'tg_admin_actions', 'notification_preferences',
    // 0080 — the ADMIN bot (@alilevobot): the group it learned from a
    // `/topic_here`, the topic it routes each notification into, and its OWN
    // update-dedup table (a second bot's update_id sequence collides with the
    // first bot's, so they cannot share one).
    'telegram_admin_config', 'telegram_admin_topics', 'telegram_admin_updates',
    'notify_deliveries',
    // 0092 — «أبلغني عند التوفر». Which channels a customer wants, and the
    // standing requests the back-in-stock sweep answers.
    //
    // `product_stock_alerts` NAMES A CATALOGUE ROW, so it looks like it belongs
    // to Catalogue, and it is a per-customer wish about a product, so it looks
    // like `favorites` under Identity. It is neither, and the tie-break is this
    // file's own rule: ownership follows THE WRITER. Nobody but the customer
    // ever changes a `favorites` row; a stock alert has a state machine
    // (armed → firing → notified, re-armed when the outbox row dies) that is
    // driven entirely by `lib/stockAlerts.ts` and settled against `outbox.state`
    // — both of which are here. Filing it anywhere else would mean the
    // Notifications service mutating a table it does not own on every cron tick.
    // Catalogue stays the authority on AVAILABILITY, which the sweep reads
    // through `saleAvailability` and never re-derives.
    'product_stock_alerts', 'user_notification_channels',
    // `notify_outbox` is the service's own copy of the legacy `outbox` SHAPE
    // (`02-MIGRATION-PLAN.md` 1.7), column for column, so the monolith's rows
    // can be copied into the Notifications database in Phase 3 without a
    // transform. The legacy table keeps its own name in the shared D1 and both
    // exist until the dual-write ends.
    'notify_outbox',
  ]),
  ...owned('invoices', ['invoices']),
  ...owned('policies', ['policy_documents', 'policy_acceptances']),
  ...owned('support', ['support_tickets', 'support_ticket_messages']),
  // 0185 — the deception layer (DECISIONS row 206): blocks, canary batches and
  // actor scores. The planned `risk_scores` / `risk_signals` belong to the
  // future risk service's own D1 and are not these.
  ...owned('risk', ['restriction_cases', 'risk_signals', 'risk_scores', 'risk_rules', 'security_blocks', 'security_canaries', 'security_scores']),
  ...owned('invest', ['investments', 'investment_items', 'investor_messages']),
  ...owned('farm', [
    'farm_profiles', 'farm_ledger', 'farm_printers', 'farm_spools', 'farm_jobs', 'farm_assignments', 'farm_events', 'farm_daily',
    'farm_achievements', 'farm_requests', 'farm_config',
  ]),
  // 0177 (owner decision 2): `admin_private_grants` is access configuration
  // beside `ops_permissions`; `security_events` is the owner's refusal log.
  ...owned('config', ['admin_settings', 'feature_flags', 'config_versions', 'ops_permissions', 'admin_private_grants']),
  ...owned('audit', ['audit_log', 'audit_events', 'audit_chain_heads', 'security_events']),
  ...owned('analytics', [
    'merchant_store_analytics_daily', 'analytics_events', 'analytics_daily_platform', 'analytics_daily_merchant',
    // The three composition facts no other table records — a detail-page view,
    // a successful add, a purchase availability refused (docs/BUNDLES_MYSTERY.md
    // §1.10, §12). An aggregate counter with no user id and no order id;
    // everything else on those screens is a query over rows commerce owns.
    'composition_daily_metrics',
    // 0125 — a store's first-party traffic (docs/MERCHANT_PLATFORM.md §4.8):
    // each product's day beside the store's day above, the short-lived
    // once-per-visitor-per-day marks that dedupe them, and the daily salt the
    // visitor hash is cut with (deleted two days later).
    'merchant_product_analytics_daily', 'storefront_event_marks', 'storefront_salts',
    // 0161 — «سرعة متجري» (merchant platform v2 P4): each store's real-user
    // vitals as daily buckets per device, and the once-per-visitor-per-day
    // marks that dedupe them (the event marks' CHECK on `event` cannot hold a
    // sixth name, so the vitals have their own). Same owner, same sweep.
    'storefront_vitals_daily', 'storefront_vitals_marks',
  ]),
  ...owned('ads', ['ads_providers', 'ads_event_map', 'ads_deliveries', 'ads_consent_snapshots', 'ads_dead_letters']),
  ...owned('search', ['search_products', 'search_stores', 'search_index_state']),
  // `media_cleanup_jobs` and `media_object_guards` are FILES tables, not
  // catalogue ones: both coordinate the lifetime of an R2 object key after
  // the product write has finished. Commerce writes a job or briefly holds a
  // guard the way it writes any cross-service intent — through the owner's
  // media path — and the Files service executes and retires that state.
  ...owned('files', [
    'file_objects', 'file_migration_log', 'media_cleanup_jobs', 'media_object_guards',
    // 0156 — a resumable multipart upload in flight (docs/COMMUNITY_ECOSYSTEM.md
    // §9.4): the R2 upload id, the parts received, the key it will become.
    'upload_sessions',
  ]),
];

export const TABLE_OWNER: Readonly<Record<string, Owner>> = Object.fromEntries(TABLE_OWNER_ENTRIES);

/**
 * Platform tables: one set per service, in the service's own store
 * (`<svc>_outbox_events`, `<svc>_outbox_deliveries`, `<svc>_processed_events`,
 * `<svc>_idempotency`, `<svc>_sagas`, `<svc>_audit_details`) plus `pump_lock`.
 */
export const PLATFORM_TABLE_SUFFIXES = [
  '_outbox_events', '_outbox_deliveries', '_processed_events', '_idempotency', '_sagas', '_audit_details',
] as const;
export const PLATFORM_SHARED_TABLES = ['pump_lock'] as const;

export function platformTableOwner(table: string): string | null {
  if ((PLATFORM_SHARED_TABLES as readonly string[]).includes(table)) return 'platform';
  for (const suffix of PLATFORM_TABLE_SUFFIXES) {
    if (table.endsWith(suffix)) return table.slice(0, -suffix.length);
  }
  return null;
}

/**
 * Rebuild migrations create `X_new` / `X_v2` / `_migNN_X` and rename them to
 * `X`; those artefacts belong to the owner of the final table and are never
 * referenced by code.
 */
export function baseTableName(table: string): string {
  return table.replace(/^_mig\d+_/, '').replace(/_(new|v2|old|tmp|backup)$/, '');
}

/** The owner of a table, or null when the design does not know it. */
export function ownerOfTable(table: string): string | null {
  return TABLE_OWNER[table] ?? TABLE_OWNER[baseTableName(table)] ?? platformTableOwner(table);
}
