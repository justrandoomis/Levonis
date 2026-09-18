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
    'product_imports', 'price_history', 'inventory_ledger', 'catalogs', 'brands', 'facets', 'hashtags', 'bundles', 'bundle_items',
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
    'coupon_redemptions', 'return_cases', 'price_protection_claims',
    // The buyer's choices behind one bundle cart line, and the fence that makes a
    // partial inventory movement impossible inside the order's own batch (§1.5, §1.7).
    'cart_bundle_choices', 'order_reservation_fence',
    // The one promotion model (§1.8): entity-attached windows, limits and
    // redemptions, beside the code-entry mechanism `coupons` already here.
    'offer_windows', 'offer_limits', 'offer_redemptions',
    // What one order actually drew, frozen, and the candidate list it drew
    // against — per-order facts, written in the order's own batch (§1.9).
    'mystery_allocations', 'mystery_draw_audits',
  ]),
  ...owned('fulfilment', ['order_status_history', 'delivery_status_map', 'order_fulfilment']),
  ...owned('ledger', [
    'wallet_transactions', 'wallet_holds', 'wallet_adjustments', 'ledger_balances', 'ledger_idempotency', 'wallet_withdrawals',
    'wallet_deposit_meta', 'wallet_review_requests', 'admin_tg_identities', 'bnpl_accounts', 'bnpl_ledger', 'points_accruals',
    'points_reservations', 'points_awards', 'reward_claims', 'browse_sessions', 'mission_streaks', 'ticket_ledger', 'game_sessions',
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
    'merchant_payout_ledger', 'community_merchants', 'merchant_stores', 'merchant_store_slugs', 'reserved_slugs',
    'merchant_notification_preferences', 'community_products', 'merchant_store_sections', 'merchant_services', 'merchant_showcase',
    'merchant_coupons', 'merchant_reviews', 'merchant_reputation_events',
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
  ...owned('devices', ['order_item_units', 'device_serials', 'device_registrations', 'warranty_claims', 'claim_messages', 'warranty_receipts']),
  ...owned('chat', ['chats', 'chat_participants', 'chat_messages', 'chat_typing_presence']),
  ...owned('notifications', [
    'outbox', 'user_notifications', 'telegram_updates', 'tg_admin_notifications', 'tg_admin_actions', 'notification_preferences',
    // 0080 — the ADMIN bot (@alilevobot): the group it learned from a
    // `/topic_here`, the topic it routes each notification into, and its OWN
    // update-dedup table (a second bot's update_id sequence collides with the
    // first bot's, so they cannot share one).
    'telegram_admin_config', 'telegram_admin_topics', 'telegram_admin_updates',
    'notify_deliveries',
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
  ...owned('risk', ['restriction_cases', 'risk_signals', 'risk_scores', 'risk_rules']),
  ...owned('invest', ['investments', 'investment_items', 'investor_messages']),
  ...owned('farm', [
    'farm_profiles', 'farm_ledger', 'farm_printers', 'farm_spools', 'farm_jobs', 'farm_assignments', 'farm_events', 'farm_daily',
    'farm_achievements', 'farm_requests', 'farm_config',
  ]),
  ...owned('config', ['admin_settings', 'feature_flags', 'config_versions']),
  ...owned('audit', ['audit_log', 'audit_events', 'audit_chain_heads']),
  ...owned('analytics', [
    'merchant_store_analytics_daily', 'analytics_events', 'analytics_daily_platform', 'analytics_daily_merchant',
    // The three composition facts no other table records — a detail-page view,
    // a successful add, a purchase availability refused (docs/BUNDLES_MYSTERY.md
    // §1.10, §12). An aggregate counter with no user id and no order id;
    // everything else on those screens is a query over rows commerce owns.
    'composition_daily_metrics',
  ]),
  ...owned('ads', ['ads_providers', 'ads_event_map', 'ads_deliveries', 'ads_consent_snapshots', 'ads_dead_letters']),
  ...owned('search', ['search_products', 'search_stores', 'search_index_state']),
  // `media_cleanup_jobs` is a FILES table, not a catalogue one: it names an R2
  // object key and a bucket, and the product that queued it is already gone by
  // the time the row is read. Commerce writes a job the way it writes any
  // cross-service intent — through the owner's delete path — and the Files
  // service is what executes and retires it.
  ...owned('files', ['file_objects', 'file_migration_log', 'media_cleanup_jobs']),
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
