/**
 * THE FINANCE SCREENS SAY WHAT THE LEDGER SAYS, IN WORDS (W2-B).
 *
 *   · every kind and bucket has a label in Arabic and English, and Sorani is
 *     either the hand-written word the app already had or the Arabic
 *     fallback — never machine-written;
 *   · every payout refusal code is a sentence, never the code or the English;
 *   · the screen reads its figures from the API — it computes no money — and
 *     uses no native dialog; the dashboard mounts it lazily.
 *
 * Run: node --import tsx --test tests/merchantFinanceUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { bucketLabel, kindLabel, payoutRefusalText, payoutStateLabel } from '../src/components/merchant/finance/strings';
import { queueRefusal } from '../src/components/adminCommunity/PayoutQueue';
import { ApiError } from '../src/lib/api';

const ar = (a: string) => a;
const en = (_a: string, b: string) => b;
const ckb = (a: string, _b: string, c?: string) => c ?? a;
const money = (n: number) => `${n.toLocaleString('en-US')} IQD`;

test('every ledger kind, bucket and payout state has words in Arabic and English; Sorani only hand-written or the Arabic', () => {
  const kinds = ['sale_gross', 'commission', 'delivery_fee', 'refund', 'commission_refund', 'delivery_refund', 'escrow_release', 'adjustment', 'release', 'payout', 'payout_reversal'] as const;
  const handWritten = new Set(['فرۆشتن', 'کۆمیشن', 'گەڕاندنەوە', 'داواکاری تایبەت', 'گۆڕانکاری', 'دراوە بە تۆ', 'چاوەڕوان', 'بەردەست', 'دراوە']);
  for (const k of kinds) {
    assert.match(kindLabel(k, ar), /[؀-ۿ]/, k);
    assert.match(kindLabel(k, en), /^[A-Z]/, k);
    const c = kindLabel(k, ckb);
    assert.ok(handWritten.has(c) || c === kindLabel(k, ar), `${k}: ${c}`);
  }
  for (const b of ['pending', 'available', 'reserved', 'paid'] as const) {
    assert.notEqual(bucketLabel(b, en), '');
    const c = bucketLabel(b, ckb);
    assert.ok(handWritten.has(c) || c === bucketLabel(b, ar), b);
  }
  for (const st of ['requested', 'approved', 'paid', 'failed', 'cancelled'] as const) assert.notEqual(payoutStateLabel(st, en), '');
});

test('every payout refusal is a sentence in the merchant’s language, with the balance when the server sent it', () => {
  for (const code of ['INSUFFICIENT_BALANCE', 'INVALID_AMOUNT', 'UNKNOWN_PAYOUT_METHOD', 'PAYOUT_ACCOUNT_REQUIRED', 'IDEMPOTENCY_KEY_REUSED', 'PAYOUT_NOT_CANCELLABLE', 'RATE_LIMITED', undefined]) {
    const a = payoutRefusalText(code, { available_iqd: 4000 }, ar, money);
    assert.match(a, /[؀-ۿ]/, String(code));
    assert.doesNotMatch(a, /[A-Z]{3,}_[A-Z]/, String(code));
  }
  assert.match(payoutRefusalText('INSUFFICIENT_BALANCE', { available_iqd: 4000 }, en, money), /4,000/);
  const t = (a: string, b: string) => b;
  assert.match(queueRefusal(new ApiError(409, 'x', 'PAYOUT_STATE_CONFLICT'), t), /changed/);
  assert.match(queueRefusal(new ApiError(403, 'x', 'FINANCIAL_SCOPE_REQUIRED'), t), /financial admin/);
});

test('the screen computes no money, asks no native dialog, and is mounted lazily in the dashboard', () => {
  const dir = join(ROOT, 'src/components/merchant/finance');
  for (const f of ['MerchantFinance.tsx', 'FinanceLedger.tsx', 'PayoutRequestSheet.tsx']) {
    const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /window\.(confirm|alert|prompt)|\balert\(/, f);
    assert.doesNotMatch(code, /\.reduce\(/, `${f} sums nothing itself`);
  }
  const page = readFileSync(join(ROOT, 'src/pages/MerchantDashboardPage.tsx'), 'utf8');
  assert.match(page, /lazy\(\(\) => import\('\.\.\/components\/merchant\/finance\/MerchantFinance'\)\)/);
  assert.doesNotMatch(page, /function MoneyTab/);
  const admin = readFileSync(join(ROOT, 'src/components/adminCommunity/AdminCommunity.tsx'), 'utf8');
  assert.match(admin, /<PayoutQueue t=\{t\} \/>/);
});
