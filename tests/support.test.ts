/**
 * Unit tests for the deterministic support-assistant intent matcher
 * (worker/routes/support.ts). Pins the §8 semantics: keyword dictionaries
 * only — a single match resolves, ambiguous input yields MULTIPLE matches
 * (the route then answers with clarifying choices, never a guess), and
 * unknown text yields none.
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchIntents, RESTRICTABLE_BENEFITS, RESTRICTION_CASE_TYPES } from '../worker/routes/support';

test('single keyword resolves to exactly one intent (en)', () => {
  assert.deepEqual(matchIntents('what is my warranty?'), ['warranty_status']);
  assert.deepEqual(matchIntents('I forgot my password'), ['password_help']);
});

test('single keyword resolves to exactly one intent (ar)', () => {
  assert.deepEqual(matchIntents('شنو حالة الطلب؟'), ['order_status']);
  assert.deepEqual(matchIntents('اريد استرجاع البضاعة'), ['return_help']);
});

test('ar text touching two topics is ambiguous — clarify, never guess', () => {
  // 'استرجاع' (returns) + 'منتج' (product search) → both dictionaries hit.
  const m = matchIntents('اريد استرجاع المنتج');
  assert.ok(m.includes('return_help'));
  assert.ok(m.includes('product_search'));
});

test('single keyword resolves to exactly one intent (ckb)', () => {
  assert.deepEqual(matchIntents('گەرەنتی چۆنە؟'), ['warranty_status']);
  assert.deepEqual(matchIntents('خاڵەکانم چەندە'), ['points_balance']);
});

test('ambiguous text matches multiple intents — route must clarify, not guess', () => {
  const m = matchIntents('order delivery');
  assert.ok(m.includes('order_status'));
  assert.ok(m.includes('delivery_estimate'));
  assert.ok(m.length >= 2);
});

test('unknown text matches nothing', () => {
  assert.deepEqual(matchIntents('xyzzy blorp'), []);
});

test('matching is deterministic and order-stable', () => {
  const a = matchIntents('warranty and points and ticket');
  const b = matchIntents('warranty and points and ticket');
  assert.deepEqual(a, b);
});

test('restriction allowlists cover the mandated shapes', () => {
  // §10 case taxonomy is exactly the owner's four types.
  assert.deepEqual(
    [...RESTRICTION_CASE_TYPES].sort(),
    ['abuse', 'debt', 'dropshipping_suspected', 'repeated_refusal']
  );
  // Only benefit-computation flags are restrictable (matching the benefit
  // names in worker/lib/entitlements.ts) — never an access-level switch:
  // support/warranty/orders/wallet ACCESS must not be gateable here.
  assert.deepEqual(
    [...RESTRICTABLE_BENEFITS].sort(),
    [
      'exclusiveSections',
      'freeDelivery',
      'merchantProfile',
      'noPreorderCommission',
      'priorityService',
      'proExclusive',
      'proPricing',
      'verifiedMerchant',
    ]
  );
});
