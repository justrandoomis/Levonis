/**
 * Ledger argument policies per caller (`01-TARGET.md` §4 item 7, ADR-006 (c)):
 * a compromised Reviews Worker must not be able to `credit({currency:'USD',
 * amount:1e8})`; every violation is FORBIDDEN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLedgerPolicy, LEDGER_POLICIES, LEDGER_METHOD_CALLERS } from '@levonis/contracts/rpc/ledgerPolicy';
import { LEDGER_MONEY_METHODS, isWellFormedEventKey, type MoneyCmd } from '@levonis/contracts/rpc/ledger';

const cmd = (over: Partial<MoneyCmd>): MoneyCmd => ({
  eventKey: 'reviews:review:rev_01:award', userId: 'usr_01', currency: 'POINT', amount: 50, ref: { type: 'review', id: 'rev_01' }, reason: 'review award',
  actor: { kind: 'system', id: null }, correlationId: 'cid', ...over,
});

test('Reviews may mint only the configured POINT award for a review', () => {
  const limits = { reviewAward: 50 };
  assert.deepEqual(checkLedgerPolicy('reviews', 'credit', cmd({}), limits), { ok: true });
  assert.deepEqual(checkLedgerPolicy('reviews', 'credit', cmd({ currency: 'USD', amount: 100_000_000 }), limits), { ok: false, reason: 'FORBIDDEN', violation: 'CURRENCY' });
  assert.deepEqual(checkLedgerPolicy('reviews', 'credit', cmd({ amount: 51 }), limits), { ok: false, reason: 'FORBIDDEN', violation: 'AMOUNT' });
  assert.deepEqual(checkLedgerPolicy('reviews', 'credit', cmd({ ref: { type: 'order', id: 'o' } }), limits), { ok: false, reason: 'FORBIDDEN', violation: 'REF_TYPE' });
  assert.deepEqual(checkLedgerPolicy('reviews', 'debit', cmd({}), limits), { ok: false, reason: 'FORBIDDEN', violation: 'METHOD_NOT_ALLOWED' });
  assert.deepEqual(checkLedgerPolicy('reviews', 'credit', cmd({}), {}), { ok: false, reason: 'FORBIDDEN', violation: 'LIMIT_UNRESOLVED' }, 'an unconfigured award never means unbounded');
  assert.deepEqual(checkLedgerPolicy('reviews', 'credit', cmd({ amount: -5 }), limits), { ok: false, reason: 'FORBIDDEN', violation: 'AMOUNT' });
  assert.deepEqual(checkLedgerPolicy('reviews', 'credit', cmd({ amount: 1.5 }), limits), { ok: false, reason: 'FORBIDDEN', violation: 'AMOUNT' });
});

test('Subscriptions refunds at most what was paid; Commerce settles at most the settlement; Marketplace only escrow/store_order; unknown callers are refused', () => {
  const paid = (ref: MoneyCmd['ref']) => (ref.id === 'mem_1' ? 12_000 : null);
  assert.deepEqual(checkLedgerPolicy('subscriptions', 'refund', cmd({ currency: 'USD', amount: 12_000, ref: { type: 'membership', id: 'mem_1' } }), { paidForRef: paid }), { ok: true });
  assert.deepEqual(checkLedgerPolicy('subscriptions', 'refund', cmd({ currency: 'USD', amount: 12_001, ref: { type: 'membership', id: 'mem_1' } }), { paidForRef: paid }), { ok: false, reason: 'FORBIDDEN', violation: 'AMOUNT' });
  assert.deepEqual(checkLedgerPolicy('subscriptions', 'refund', cmd({ currency: 'USD', amount: 1, ref: { type: 'membership', id: 'mem_unknown' } }), { paidForRef: paid }), { ok: false, reason: 'FORBIDDEN', violation: 'LIMIT_UNRESOLVED' });
  const settlement = (_ref: MoneyCmd['ref'], currency: string) => (currency === 'USD' ? 61_500 : 300);
  assert.deepEqual(checkLedgerPolicy('commerce', 'refund', cmd({ currency: 'USD', amount: 61_500, ref: { type: 'order', id: 'ord_1' } }), { settlementOfRef: settlement }), { ok: true });
  assert.deepEqual(checkLedgerPolicy('commerce', 'refund', cmd({ currency: 'POINT', amount: 301, ref: { type: 'return', id: 'c1' } }), { settlementOfRef: settlement }), { ok: false, reason: 'FORBIDDEN', violation: 'AMOUNT' });
  assert.deepEqual(checkLedgerPolicy('commerce', 'credit', cmd({ currency: 'USD', amount: 1, ref: { type: 'review', id: 'r' } }), { settlementOfRef: settlement }), { ok: false, reason: 'FORBIDDEN', violation: 'REF_TYPE' });
  assert.deepEqual(checkLedgerPolicy('marketplace', 'hold', cmd({ currency: 'USD', amount: 5_000, ref: { type: 'escrow', id: 'e1' } })), { ok: true });
  assert.deepEqual(checkLedgerPolicy('marketplace', 'hold', cmd({ currency: 'USD', amount: 5_000, ref: { type: 'order', id: 'o1' } })), { ok: false, reason: 'FORBIDDEN', violation: 'REF_TYPE' });
  assert.deepEqual(checkLedgerPolicy('gateway', 'credit', cmd({})), { ok: false, reason: 'FORBIDDEN', violation: 'CALLER_UNKNOWN' });
  assert.deepEqual(checkLedgerPolicy('notifications', 'credit', cmd({})), { ok: false, reason: 'FORBIDDEN', violation: 'METHOD_NOT_ALLOWED' }, 'Notifications forwards deposit decisions and never moves money');
});

test('decideDeposit is callable only by Notifications and the admin BFF; every money method has an allowlist and requires a well-formed event key', () => {
  assert.deepEqual([...LEDGER_METHOD_CALLERS.decideDeposit], ['notifications', 'ledger-admin', 'core']);
  assert.ok(!LEDGER_METHOD_CALLERS.decideDeposit.includes('commerce'));
  for (const m of LEDGER_MONEY_METHODS) assert.ok(LEDGER_METHOD_CALLERS[m].length > 0, `${m} has callers`);
  assert.ok(!(LEDGER_METHOD_CALLERS.credit as readonly string[]).includes('gateway'), 'ADR-015: the gateway is never a money caller');
  assert.ok(Object.keys(LEDGER_POLICIES).every((c) => c !== 'gateway'));
  for (const good of ['wtx_ord_ord_01_usd', 'wtx_refund_ord_01_pts', 'wtx_ret_case1', 'wtx_pp_claim1', 'wtx_review_r1', 'wtx_acc_a1', 'wtx_refund_mem_1', 'commerce:order:ord_01:usd', 'store:order:ord_9:hold']) {
    assert.ok(isWellFormedEventKey(good), good);
  }
  for (const bad of ['', 'short', 'wtx_ord_ord_01', 'Idempotency-Key-from-client', 'commerce:order:ord 01:usd', 'x'.repeat(201)]) assert.ok(!isWellFormedEventKey(bad), bad);
});
