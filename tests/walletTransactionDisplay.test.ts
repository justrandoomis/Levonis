import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { walletTransactionDisplay } from '../src/lib/walletTransactionDisplay';
import { usdCentsToIqd } from '../src/lib/api';

test('admin refund keeps its exact 50,000 IQD and original rate after exchange rates change', () => {
  assert.equal(usdCentsToIqd(3571, 1400), 49_994, 'reconversion loses six dinars');
  assert.deepEqual(walletTransactionDisplay({
    cents: 3571, recordedIqd: 50_000, recordedRate: 1400, currentRate: 1500,
  }), { amountIqd: 50_000, rate: 1400 });
});

test('authoritative ledger dinars precede testimony while old deposit and withdrawal testimony survive', () => {
  assert.equal(walletTransactionDisplay({
    cents: 3571, recordedIqd: 50_000, recordedRate: 1400,
    deposit: { amount_iqd: 49_000, exchange_rate: 1300 },
    withdrawalIqd: 48_000, withdrawalRate: 1200, currentRate: 1500,
  }).amountIqd, 50_000);
  assert.deepEqual(walletTransactionDisplay({
    cents: 3571, deposit: { amount_iqd: 50_000, exchange_rate: 1400 }, currentRate: 1500,
  }), { amountIqd: 50_000, rate: 1400 });
  assert.deepEqual(walletTransactionDisplay({
    cents: 3571, withdrawalIqd: 50_000, withdrawalRate: 1400, currentRate: 1500,
  }), { amountIqd: 50_000, rate: 1400 });
});

test('legacy conversion prefers any recorded rate and uses current rate only when none exists', () => {
  assert.deepEqual(walletTransactionDisplay({ cents: 3571, recordedRate: 1400, currentRate: 1500 }),
    { amountIqd: 49_994, rate: 1400 });
  assert.deepEqual(walletTransactionDisplay({ cents: 3571, withdrawalRate: 1400, currentRate: 1500 }),
    { amountIqd: 49_994, rate: 1400 });
  assert.deepEqual(walletTransactionDisplay({ cents: 3571, currentRate: 1500 }),
    { amountIqd: 53_565, rate: 1500 });
  assert.deepEqual(walletTransactionDisplay({
    cents: 3571, recordedIqd: -1, recordedRate: 0, withdrawalRate: Number.NaN, currentRate: 1400,
  }), { amountIqd: 49_994, rate: 1400 });
});

test('admin card renders both the chosen dinars and the chosen historical rate', () => {
  const card = readFileSync(new URL('../src/components/AdminWalletRequests.tsx', import.meta.url), 'utf8');
  assert.match(card, /recordedIqd: t\.amount_iqd/);
  assert.match(card, /recordedRate: t\.exchange_rate_snapshot/);
  assert.match(card, /formatIqd\(display\.amountIqd\)/);
  assert.match(card, /display\.rate\.toLocaleString\(\)/);
});
