/**
 * THE ADMIN PAYOUT IS ASKED IN A SHEET, AND ITS REFUSALS ARE WORDS — audit 04
 * #1's UI half (handed over from W1-A, whose route now answers 400
 * INSUFFICIENT_BALANCE, 409 IDEMPOTENCY_KEY_REUSED and 404 for a merchant that
 * is gone).
 *
 * The panel asked for the amount and the note with two `window.prompt`s and
 * answered with `alert(e.message)` — the server's raw English, INSUFFICIENT_BALANCE
 * included. The pure halves are tested here; the wiring is pinned by source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { ApiError } from '../src/lib/api';
import { parsePayoutAmount, payoutRefusal } from '../src/components/adminCommunity/PayoutSheet';

const ar = (a: string) => a;
const en = (_a: string, b: string) => b;

test('an amount is a whole number of dinars, in either digit script — and a decimal is refused, never misread', () => {
  assert.equal(parsePayoutAmount('12500'), 12500);
  assert.equal(parsePayoutAmount('12,500'), 12500);
  assert.equal(parsePayoutAmount('١٢٬٥٠٠'), 12500, 'Arabic-Indic digits and the Arabic thousands separator');
  assert.equal(parsePayoutAmount(' 7 000 '), 7000);
  assert.equal(parsePayoutAmount('12.5'), null, 'not 125: IQD is whole, and a misread amount is money');
  assert.equal(parsePayoutAmount('١٢٫٥'), null);
  for (const bad of ['', '0', '-5', 'abc', '1e6', '99999999999']) assert.equal(parsePayoutAmount(bad), null, bad);
});

test('each refusal of the payout route is a sentence, in the panel\'s language — never the code or the English', () => {
  const cases: Array<[ApiError, RegExp, RegExp]> = [
    [new ApiError(400, 'That is more than the merchant has available', 'INSUFFICIENT_BALANCE', { available_iqd: 4000 }), /المتاح/, /available now/],
    [new ApiError(409, 'This payout key was already used for a different payout. Start again.', 'IDEMPOTENCY_KEY_REUSED'), /تحويل آخر/, /different payout/],
    [new ApiError(404, 'Merchant not found', 'NOT_FOUND'), /لم يعد/, /no longer exists/],
    [new ApiError(403, 'Financial scope required', 'FINANCIAL_SCOPE_REQUIRED'), /الدور المالي/, /financial admin/],
  ];
  for (const [err, arabic, english] of cases) {
    const inArabic = payoutRefusal(err, ar, 'ar');
    assert.match(inArabic, arabic, err.code);
    assert.doesNotMatch(inArabic, /[A-Z]{3,}_[A-Z]/, `${err.code} leaks a machine code`);
    assert.notEqual(inArabic, err.message);
    assert.match(payoutRefusal(err, en, 'en'), english, err.code);
  }
  assert.match(payoutRefusal(new ApiError(400, 'That is more than the merchant has available', 'INSUFFICIENT_BALANCE', { available_iqd: 4000 }), en, 'en'), /4,000/);
  // A network failure is not an ApiError: the sheet's own sentence, not "Failed to fetch".
  assert.match(payoutRefusal(new TypeError('Failed to fetch'), en, 'en'), /check the connection/);
});

test('the panel records a payout through the sheet — no browser prompt, no alert, a fresh key per payout', () => {
  const panel = readFileSync(join(ROOT, 'src/components/adminCommunity/AdminCommunity.tsx'), 'utf8');
  // The code, not the comments that tell its history.
  const sheet = readFileSync(join(ROOT, 'src/components/adminCommunity/PayoutSheet.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(panel, /<PayoutSheet/);
  assert.doesNotMatch(panel, /Amount to pay out/, 'the old prompt is gone');
  assert.doesNotMatch(panel, /adminCommunityApi\.payout\(/, 'the panel no longer posts a payout itself');
  assert.doesNotMatch(sheet, /window\.(prompt|confirm|alert)|\balert\(/);
  assert.match(sheet, /setKey\(newIdempotencyKey\(\)\)/, 'a key is minted per payout, not per click');
  assert.match(sheet, /adminCommunityApi\.payout\(merchant\.id, value, note\.trim\(\), key\)/);
  // The button lives in the money view an assistant-scope admin is told they cannot see.
  const detail = /function MerchantDetail[\s\S]*?\n}\n/.exec(panel)?.[0] ?? '';
  assert.match(detail, /finRefused === 'scope'/);
  assert.match(detail, /<PayoutSheet/);
});
