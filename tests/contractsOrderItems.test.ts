/**
 * THE EVENT A MYSTERY ORDER MUST STILL EMIT — docs/BUNDLES_MYSTERY.md §7.7.
 *
 * A mystery spool's `order_items` row stores `product_id = NULL` on purpose:
 * it is what keeps the drawn filament out of the `ORDER_ITEMS_SELECT` join, the
 * units endpoint, the invoice and the courier payload with no filtering code at
 * all. That single decision reaches the event bus, and BOTH obvious ways of
 * handling it were wrong before this slice:
 *
 *   `product_id` was `nonEmptyStr` in the v1 ref, so a producer binding null
 *   fails `buildEnvelope`; `outboxStatement` CATCHES and returns null; and
 *   `OrderCreated` disappears SILENTLY for every mystery order — the one
 *   analytics surface the mandate names. A test that only checked the payload's
 *   contents would pass against no row at all, which is why the row's EXISTENCE
 *   is asserted here first.
 *
 *   `OrderDelivered` had the mirror-image bug: `String(r.product_id)` writes the
 *   literal string `"null"` — a value no consumer can tell from a real id.
 *
 * So the ref is widened (`product_id` nullable, plus an optional `item_kind`),
 * and this file pins both halves: every producer written before the change
 * still validates, and a mystery line now travels as what it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, all, count } from './fixtures/app';
import { orderItemRef } from '@levonis/contracts/events/common';
import { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
import { OrderDeliveredV1 } from '@levonis/contracts/events/v1/OrderDelivered';
import { ContractViolation } from '@levonis/contracts/schema';
import { configureEventBus, resetEventBus, outboxStatement } from '../worker/lib/eventBus';
import type { Env } from '../worker/lib/types';

const ORDINARY = {
  order_item_id: 'oi_1',
  product_id: 'p_pla',
  qty: 1,
  unit_price_iqd: 1000,
  is_printer: false,
  warranty_plan_id: null,
  ops_policy_id: null,
};
const MYSTERY_SPOOL = { ...ORDINARY, order_item_id: 'oi_2', product_id: null, unit_price_iqd: 0, item_kind: 'mystery' as const };

const envFor = (raw: DatabaseSync, extra: Record<string, unknown> = {}): Env =>
  ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ...extra }) as unknown as Env;

/** The payload a checkout would publish. Typed loosely on purpose: the point
 *  of this file is what the CONTRACT accepts and refuses, not what TypeScript
 *  infers about a literal. */
const payload = (items: Record<string, unknown>[]) => ({
  order_id: 'ORD-1',
  user_id: 'usr_1',
  user_hash: 'a'.repeat(64),
  seller_type: 'platform' as const,
  merchant_id: null,
  store_id: null,
  payment_state: 'cod' as const,
  items,
  totals: { merchandise_iqd: 60000, delivery_iqd: 0, discount_iqd: 0, total_iqd: 60000 },
  payment: { method: 'cash' as const, wallet_usd_cents: 0, points: 0, cod_iqd: 60000, exchange_rate: 1400 },
  shipping_type: 'direct',
  address_snapshot_ref: 'adr_1',
  coupon_code: null,
  membership_gift: false,
  referral_delivery_waived: false,
  idempotency_key: 'idem-mystery-1',
  created_at: new Date().toISOString(),
});

// ------------------------------------------------------------- the ref

test('the widened ref still validates every producer written before it', () => {
  assert.deepEqual(orderItemRef(ORDINARY, '$'), ORDINARY, 'an ordinary line is unchanged, item_kind absent');
});

test('a mystery line travels with a NULL product id and says why', () => {
  const parsed = orderItemRef(MYSTERY_SPOOL, '$') as Record<string, unknown>;
  assert.equal(parsed.product_id, null);
  assert.equal(parsed.item_kind, 'mystery');
});

test('the ref is still an allow-list: a missing key, a wrong kind and an extra key are all refused', () => {
  const { product_id: _omitted, ...missing } = ORDINARY;
  assert.throws(() => orderItemRef(missing, '$'), ContractViolation, 'product_id may be null, never absent');
  assert.throws(() => orderItemRef({ ...ORDINARY, item_kind: 'whatever' }, '$'), ContractViolation);
  assert.throws(() => orderItemRef({ ...ORDINARY, drawn_product_id: 'p_secret' }, '$'), ContractViolation);
  for (const kind of ['ordinary', 'bundle_parent', 'bundle_component', 'mystery']) {
    assert.equal((orderItemRef({ ...ORDINARY, item_kind: kind }, '$') as { item_kind: string }).item_kind, kind);
  }
});

// -------------------------------------------------- the row actually written

test('a mystery order emits exactly ONE valid OrderCreated row, and it carries no drawn product id', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw, { EVENT_BUS_ENABLED: 'on' });
  configureEventBus(env);

  const pending = await outboxStatement(env.DB, OrderCreatedV1, payload([ORDINARY, MYSTERY_SPOOL]) as never, { aggregateId: 'ORD-1' });
  // THE EXISTENCE FIRST: `outboxStatement` swallows a validation failure and
  // returns null, so an assertion about the contents alone would pass against
  // an event that never happened.
  assert.ok(pending, 'OrderCreated was swallowed for a mystery order');
  await pending!.statement.run();

  const rows = all<{ envelope: string }>(raw, 'SELECT envelope FROM core_outbox_events');
  assert.equal(rows.length, 1, 'exactly one row');
  const body = (JSON.parse(rows[0].envelope) as { payload: { items: Array<{ product_id: string | null; item_kind?: string }> } }).payload;
  assert.equal(body.items.length, 2);
  assert.equal(body.items[1].product_id, null);
  assert.equal(body.items[1].item_kind, 'mystery');
  // The drawn filament is not an analytics fact until the reveal milestone.
  assert.ok(!rows[0].envelope.includes('p_drawn'));
  assert.ok(!/"product_id":"null"/.test(rows[0].envelope), 'never the literal string "null" as an id');
});

test('OrderDelivered accepts the same shape, so the delivery event is not the leak either', () => {
  const delivered = {
    order_id: 'ORD-1',
    user_id: 'usr_1',
    seller_type: 'platform' as const,
    merchant_id: null,
    delivered_at: new Date().toISOString(),
    items: [ORDINARY, MYSTERY_SPOOL],
    payment_method: 'cash' as const,
    cod_amount_iqd: null,
    by: 'admin' as const,
  };
  const parsed = OrderDeliveredV1.parse(delivered) as { items: Array<{ product_id: string | null }> };
  assert.equal(parsed.items[1].product_id, null);
});

test('the delivered emitter never writes the string "null" as a product id', () => {
  // The map is inside `emitOrderDelivered`, so the guarantee is asserted on the
  // source: `String(r.product_id)` on a nullable column is the bug.
  const src = readFileSync(join(ROOT, 'worker/lib/orderStageOps.ts'), 'utf8');
  assert.doesNotMatch(src, /product_id:\s*String\(r\.product_id\)/, 'String(null) writes the literal "null"');
  assert.match(src, /product_id:\s*String\(r\.product_id \?\? ''\) \|\| null/);
});

test('with the bus off a mystery order changes nothing about the batch', async () => {
  resetEventBus();
  const raw = freshDb();
  const env = envFor(raw); // the live Worker today: EVENT_BUS_ENABLED unset
  configureEventBus(env);
  assert.equal(await outboxStatement(env.DB, OrderCreatedV1, payload([MYSTERY_SPOOL]) as never, { aggregateId: 'ORD-1' }), null);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM core_outbox_events'), 0);
  resetEventBus();
});
