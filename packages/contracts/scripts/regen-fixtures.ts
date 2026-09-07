/**
 * Regenerates `src/events/fixtures/<Type>.v1.json` — one valid, signed-at-test-time
 * envelope per schema in the registry. Deterministic (fixed clock, counter ids)
 * so a regeneration only changes a fixture whose payload example changed.
 *
 *   node_modules/.bin/tsx packages/contracts/scripts/regen-fixtures.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_SCHEMAS } from '../src/events/index';
import { FIXTURE_SIG } from '../src/envelope';
import { PRODUCERS, ANY_PRODUCER } from '../src/subscriptions';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'events', 'fixtures');
const T0 = Date.UTC(2026, 8, 7, 10, 0, 0); // 2026-09-07T10:00:00Z
const AT = new Date(T0).toISOString();
const hex = (label: string) => createHash('sha256').update(label).digest('hex');

/** A stable UUIDv7: 48-bit ms timestamp, version 7, variant 10, deterministic tail. */
function uuidv7At(ms: number, seed: string): string {
  const ts = ms.toString(16).padStart(12, '0');
  const tail = hex(seed);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${tail.slice(0, 3)}-${(8 + (parseInt(tail[3], 16) % 4)).toString(16)}${tail.slice(4, 7)}-${tail.slice(7, 19)}`;
}

const items = { order_item_id: 'oi_01', product_id: 'prd_bambu_a1', qty: 1, unit_price_iqd: 899000, is_printer: true, warranty_plan_id: 'wp_12', ops_policy_id: null };

const PAYLOADS: Record<string, { aggregate_id: string; actor_id: string | null; payload: unknown }> = {
  'UserCreated.v1': { aggregate_id: 'usr_01', actor_id: 'usr_01', payload: { user_id: 'usr_01', method: 'email_first', locale: 'ar', referrer_code: 'ALI-7F2K', email_verified: false, created_at: AT } },
  'UserUpdated.v1': { aggregate_id: 'usr_01', actor_id: 'usr_01', payload: { user_id: 'usr_01', user_hash: hex('usr_01'), username: 'ali', name: 'Ali', avatar_key: null, locale: 'ar', marketing_consent: 'ads', email_hash: hex('ali@example.test'), phone_hash: hex('+9647700000000') } },
  'SessionRevoked.v1': { aggregate_id: hex('sid'), actor_id: 'usr_01', payload: { user_id: 'usr_01', sid_hash: hex('sid'), reason: 'logout' } },
  'RoleChanged.v1': { aggregate_id: 'usr_02', actor_id: 'usr_admin', payload: { user_id: 'usr_02', role: 'admin', admin_scope: 'assistant', is_investor: false, actor_id: 'usr_admin' } },
  'ProductViewed.v1': { aggregate_id: 'prd_bambu_a1', actor_id: null, payload: { product_id: 'prd_bambu_a1', slug: 'bambu-a1', catalog_id: 'cat_printers', brand_id: 'brd_bambu', lang: 'en', host_kind: 'main', tier: 'plus', viewer_hash: hex('usr_01:2026-09-07') } },
  'ProductAdded.v1': { aggregate_id: 'prd_bambu_a1', actor_id: 'usr_admin', payload: { product_id: 'prd_bambu_a1', slug: 'bambu-a1', status: 'active', catalog_ids: ['cat_printers'], brand_id: 'brd_bambu', is_printer: true, doc_version: 7, structure_hash: hex('doc7'), names: { ar: 'بامبو A1', en: 'Bambu A1', ckb: 'بامبو A1' }, images: ['products/prd_bambu_a1/main.webp'], op_id: 'op_save_7' } },
  'InventoryChanged.v1': { aggregate_id: 'prd_bambu_a1', actor_id: null, payload: { product_id: 'prd_bambu_a1', scope: { table: 'products', id: 'prd_bambu_a1' }, delta: -1, stock_after: 4, reserved_after: 1, reason: 'reserve', op_id: 'inv_ord_01', order_id: 'ord_01' } },
  'AddToCart.v1': { aggregate_id: 'usr_01', actor_id: 'usr_01', payload: { user_hash: hex('usr_01:2026-09-07'), product_id: 'prd_bambu_a1', line_key: 'prd_bambu_a1::', qty: 1, seller_type: 'platform', price_iqd_snapshot: 899000 } },
  'CheckoutStarted.v1': { aggregate_id: 'idem_9f2', actor_id: 'usr_01', payload: { session_id: 'idem_9f2', user_hash: hex('usr_01:2026-09-07'), lines: [{ product_id: 'prd_bambu_a1', qty: 1 }], totals: { items_iqd: 899000, delivery_iqd: 5000, discount_iqd: 0, grand_iqd: 904000 }, payment_method: 'wallet', seller_type: 'platform' } },
  'OrderCreated.v1': { aggregate_id: 'ord_01', actor_id: 'usr_01', payload: { order_id: 'ord_01', user_id: 'usr_01', user_hash: hex('usr_01:2026-09-07'), seller_type: 'platform', merchant_id: null, store_id: null, payment_state: 'authorized', items: [items], totals: { merchandise_iqd: 899000, delivery_iqd: 5000, discount_iqd: 0, total_iqd: 904000 }, payment: { method: 'wallet', wallet_usd_cents: 61500, points: 0, cod_iqd: 0, exchange_rate: 1470 }, shipping_type: 'direct', address_snapshot_ref: 'adr_01', coupon_code: null, membership_gift: false, referral_delivery_waived: false, idempotency_key: 'idem_9f2', created_at: AT } },
  'OrderPaid.v1': { aggregate_id: 'ord_01', actor_id: null, payload: { order_id: 'ord_01', ledger_tx_ids: ['wtx_ord_ord_01_usd'], paid_at: AT } },
  'PaymentAuthorized.v1': { aggregate_id: 'usr_01', actor_id: 'usr_01', payload: { order_id: 'ord_01', user_id: 'usr_01', kind: 'wallet_hold', currency: 'USD', amount: 61500, hold_id: 'hold_01', event_key: 'wtx_ord_ord_01_usd' } },
  'PaymentCompleted.v1': { aggregate_id: 'usr_01', actor_id: null, payload: { order_id: 'ord_01', user_id: 'usr_01', kind: 'wallet_debit', currency: 'USD', amount: 61500, ledger_tx_ids: ['wtx_ord_ord_01_usd'], event_key: 'wtx_ord_ord_01_usd' } },
  'PaymentFailed.v1': { aggregate_id: 'usr_01', actor_id: 'usr_01', payload: { order_id: 'ord_02', user_id: 'usr_01', kind: 'wallet_hold', currency: 'USD', amount: 999900, reason: 'INSUFFICIENT_FUNDS', event_key: 'wtx_ord_ord_02_usd' } },
  'RefundCompleted.v1': { aggregate_id: 'usr_01', actor_id: 'usr_admin', payload: { ref_type: 'order', ref_id: 'ord_01', user_id: 'usr_01', usd_cents: 61500, points: 0, ledger_tx_ids: ['wtx_refund_ord_01_usd'], event_key: 'wtx_refund_ord_01_usd' } },
  'OrderStatusChanged.v1': { aggregate_id: 'ord_01', actor_id: 'usr_admin', payload: { order_id: 'ord_01', from: 'pending', to: 'confirmed', stage: 'received', cause: 'admin', actor_id: 'usr_admin', at: AT } },
  'OrderDelivered.v1': { aggregate_id: 'ord_01', actor_id: 'usr_admin', payload: { order_id: 'ord_01', user_id: 'usr_01', seller_type: 'platform', merchant_id: null, delivered_at: AT, items: [items], payment_method: 'wallet', cod_amount_iqd: null, by: 'admin' } },
  'PurchaseCompleted.v1': { aggregate_id: 'ord_01', actor_id: null, payload: { order_id: 'ord_01', user_hash: hex('usr_01'), value_iqd: 904000, currency: 'IQD', content_ids: ['prd_bambu_a1'], num_items: 1 } },
  'ReferralUsed.v1': { aggregate_id: 'attr_01', actor_id: 'usr_01', payload: { referrer_id: 'usr_09', referee_id: 'usr_01', code: 'ALI-7F2K', attribution_id: 'attr_01', context: 'signup', order_id: null } },
  'SubscriptionChanged.v1': { aggregate_id: 'usr_01', actor_id: 'usr_01', payload: { user_id: 'usr_01', from_tier: 'free', to_tier: 'plus', plan_id: 'plan_plus_m', membership_id: 'mem_01', active: true, expires_at: new Date(T0 + 30 * 86400_000).toISOString(), reason: 'purchased' } },
  'RequestPublished.v1': { aggregate_id: 'req_01', actor_id: 'usr_01', payload: { request_id: 'req_01', owner_hash: hex('usr_01'), matched_merchant_ids: ['mer_01', 'mer_02'] } },
  'DepositRequested.v1': { aggregate_id: 'usr_01', actor_id: 'usr_01', payload: { request_id: 'dep_01', user_id: 'usr_01', usd_cents: 10000, method: 'zain_cash', receipt_key_present: true, approval_nonce: 'n_' + hex('dep_01').slice(0, 32) } },
  'DepositDecided.v1': { aggregate_id: 'usr_01', actor_id: 'usr_admin', payload: { request_id: 'dep_01', user_id: 'usr_01', decision: 'approved', decided_by: 'usr_admin', usd_cents: 10000 } },
  'WithdrawalStateChanged.v1': { aggregate_id: 'usr_01', actor_id: 'usr_admin', payload: { withdrawal_id: 'wd_01', user_id: 'usr_01', from: 'requested', to: 'approved', usd_cents: 5000 } },
  'AuditRecorded.v1': { aggregate_id: 'aud_01', actor_id: 'usr_admin', payload: { actor_id: 'usr_admin', action: 'wallet.credit', target: 'usr_01', detail_hash: hex('{"amount":10000}'), detail_ref: 'aud_01', source_service: 'ledger' } },
  'RateLimitHit.v1': { aggregate_id: 'gw', actor_id: null, payload: { class: 'auth', key_hash: hex('login:1.2.3.4'), route_class: 'auth', host_kind: 'main' } },
  'TurnstileFailed.v1': { aggregate_id: 'gw', actor_id: null, payload: { class: 'auth', key_hash: hex('register:1.2.3.4'), route_class: 'auth', host_kind: 'main' } },
  'EventRejected.v1': { aggregate_id: 'analytics', actor_id: null, payload: { event_id: uuidv7At(T0 - 1000, 'rejected'), consumer: 'analytics', reason: 'forged', event_type: 'SubscriptionChanged' } },
};

mkdirSync(OUT, { recursive: true });
let n = 0;
for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
  const ex = PAYLOADS[key];
  if (!ex) throw new Error(`no fixture example for ${key}`);
  const producers = PRODUCERS[key] ?? [];
  const source = producers.find((p) => p !== 'core' && p !== ANY_PRODUCER) ?? 'ledger';
  const env = schema.envelope({
    event_id: uuidv7At(T0 + n * 1000, key),
    created_at: new Date(T0 + n * 1000).toISOString(),
    source_service: source,
    correlation_id: uuidv7At(T0 - 60_000, 'request:' + key),
    causation_id: null,
    actor_id: ex.actor_id,
    aggregate_id: ex.aggregate_id,
    aggregate_seq: 1,
    payload: ex.payload,
  });
  writeFileSync(join(OUT, `${key}.json`), JSON.stringify({ ...env, sig: FIXTURE_SIG }, null, 2) + '\n');
  n++;
}
console.log(`regen-fixtures: wrote ${n} fixtures to ${OUT}`);
