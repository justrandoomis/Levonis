/**
 * A QUOTE PRICES. IT DOES NOT REFUSE.
 *
 * `computeCheckout` is shared by POST /api/orders/quote and POST /api/orders;
 * `options.allocate` is the only thing separating them. The printer home
 * -delivery advance threw INSUFFICIENT_BALANCE inside that shared function, so
 * a cash order with an empty wallet 400'd the PREVIEW — and four separate
 * owner reports were that one throw:
 *
 *   «سعر التوصيل لا يظهر للخيارات»  — the cards read the quote; no quote, «—».
 *   «الضريبة لا تعمل»                — the COD tax row reads quote.cod_tax_iqd.
 *   «تعذر حساب عرض السعر»            — the catch nulls the quote.
 *   «لا يوضح بأن الرصيد غير كافي»     — the panel explaining it is gated on
 *                                      `quote !== null`, so the condition that
 *                                      caused the refusal destroyed the quote
 *                                      that would have explained it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const orders = readFileSync(join(ROOT, 'worker/routes/orders.ts'), 'utf8');
const checkout = readFileSync(join(ROOT, 'src/pages/Checkout.tsx'), 'utf8');

test('the advance refusal fires on the ORDER door only', () => {
  const at = orders.indexOf('if (walletApplied < requiredAdvance) {');
  assert.ok(at > 0, 'the shortfall branch still exists');
  const block = orders.slice(at, at + 3200);
  // The throw must sit behind the allocate gate — the same flag the two doors
  // already differ by, not a new concept.
  assert.match(block, /if \(options\.allocate\) \{[\s\S]{0,400}throw badRequest\(/);
  assert.match(block, /'INSUFFICIENT_BALANCE'/, 'and still refuses with the same code');
  // The rounding branch below it takes the same door.
  assert.match(orders, /if \(options\.allocate && walletApplied < requiredAdvance\) \{/);
});

test('the quote still reports the shortfall as data the screen can read', () => {
  // The client decides sufficiency from these two fields; the fix works only
  // because the quote carries them. If either is dropped the button silently
  // re-enables over an unpayable order.
  assert.match(checkout, /quote\.wallet\.applied_iqd >= quote\.wallet\.required_advance_iqd/);
});

test('the refusal the customer reads is the server’s own sentence', () => {
  // `refusalWithCounter` computes the server's reason; rendering a constant
  // instead threw it away.
  assert.match(checkout, /setQuoteError\(refusalWithCounter\(err, lang, 'quote failed'\)\)/);
  assert.match(
    checkout,
    /typeof quoteError === 'string' && quoteError\.trim\(\) \? quoteError : S\.quoteError/,
    'the stored reason is preferred, with the constant only as a fallback'
  );
});

test('the tax rule itself was never broken — only unreachable', () => {
  // Worth pinning: the owner reported «الضريبة لا تعمل», and the arithmetic is
  // correct. floor(payable / blockIqd) x perBlockIqd — the ADMIN'S CONFIGURED
  // rate (codTaxPerBlockIqd / codTaxBlockIqd in worker/lib/settings.ts, 3,000
  // per 500,000 unconfigured), tax base excluding the tax. The figures are not
  // restated here on purpose: tests/codTax.test.ts owns the numbers, and a
  // comment that repeats them goes stale the next time the owner edits them.
  const codTax = readFileSync(join(ROOT, 'packages/shipping/src/codTax.ts'), 'utf8');
  assert.match(codTax, /delivery === 'standard' \|\| delivery === 'personal'/, 'pickup is taxless by rule');
  const boundary = readFileSync(join(ROOT, 'tests/codTax.test.ts'), 'utf8');
  assert.match(boundary, /499[,_]?999/, 'the bracket boundary stays pinned');
});
