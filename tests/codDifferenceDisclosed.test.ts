/**
 * «كما أنه يجب توضيح هذا الفرق قبل أن يختار» — AND THE WALLET IS THE DEFAULT.
 *
 * Two owner sentences about the same two radio buttons:
 *
 *   1. the difference between paying from the wallet and paying at the door
 *      must be READABLE BEFORE either is chosen. The server already priced
 *      the cart both ways — `prepaidPriced` and `codPriced` have existed since
 *      bundles — but published only `cod_reprices`, a BOOLEAN. So the screen
 *      could say "cash is priced as a direct sale" in the abstract, and only
 *      after cash had been picked and re-quoted. The buyer could not read the
 *      price of each door before opening one.
 *   2. the wallet, being the cheaper door, is the one to land on. It was not:
 *      the screen rested on cash, deliberately, because the wallet method
 *      requires the WHOLE total to be covered and a screen that opens on a
 *      refusal is a poor first impression.
 *
 * Both are satisfied without either overruling the other: the amount is
 * published as a number and printed on the cash option, and the wallet is
 * selected once a quote proves the balance covers it — a fact, not a
 * preference. This file pins the wiring end to end, because every assertion
 * here is a JOIN between two files and a rename on either side silently
 * restores the boolean-only screen.
 *
 * The arithmetic itself is pinned executably in codPricedAsDirect.test.ts
 * (wallet 505,000, door 550,000, difference 45,000 on the owner's shape).
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const orders = readFileSync(join(ROOT, 'worker/routes/orders.ts'), 'utf8');
const checkout = readFileSync(join(ROOT, 'src/pages/Checkout.tsx'), 'utf8');

test('the server publishes the DIFFERENCE, not only that there is one', () => {
  assert.ok(
    /const codSurchargeIqd = isPreorderCart/.test(orders),
    'the amount is derived for a pre-order cart'
  );
  // It is the two priced bases subtracted, per unit, times the quantity —
  // reading either basis alone would make the number the total, not the delta.
  const at = orders.indexOf('const codSurchargeIqd = isPreorderCart');
  const body = orders.slice(at, at + 400);
  assert.ok(body.includes('codPriced.lines'), 'the cash basis is one side of it');
  assert.ok(body.includes('prepaidPriced.lines'), 'the wallet basis is the other');
  assert.ok(body.includes('* l.qty'), 'a two-unit line owes twice the difference');
  assert.ok(body.includes('Math.max(\n        0,'), 'floored at zero — cash is never shown as a discount');
});

test('it reaches the client on the quote, beside the boolean it replaces', () => {
  assert.ok(/cod_surcharge_iqd: comp\.codSurchargeIqd/.test(orders), 'the quote carries it');
  assert.ok(/codSurchargeIqd: number;/.test(orders), 'the computed type declares it');
  assert.ok(/cod_surcharge_iqd\?: number;/.test(checkout), 'the client DTO reads it');
  assert.ok(
    /const codSurchargeIqd = quote\?\.cod_surcharge_iqd \?\? 0;/.test(checkout),
    'absent on a direct cart means zero, not undefined arithmetic'
  );
});

test('the amount is printed ON the cash option, and only when there is one', () => {
  const at = checkout.indexOf('data-cod-surcharge');
  assert.ok(at > 0, 'the cash option carries the marker');
  const around = checkout.slice(at - 260, at + 260);
  assert.ok(around.includes("method.id === 'cash'"), 'on the cash option specifically');
  assert.ok(around.includes('codSurchargeIqd > 0'), 'a cart priced the same either way stays quiet');
  assert.ok(around.includes('S.payCodMore('), 'and says it in the buyer’s own language');
});

test('the wallet option says it is the cheaper one, in all three languages', () => {
  const at = checkout.indexOf('data-cod-cheapest');
  assert.ok(at > 0);
  const around = checkout.slice(at - 260, at + 200);
  assert.ok(around.includes("method.id === 'wallet'"));
  assert.ok(around.includes('codSurchargeIqd > 0'), 'never claims "cheapest" when the prices are equal');
  // Every language ships the pair, so no locale silently loses the disclosure.
  for (const key of ['payCheapest', 'payCodMore']) {
    const hits = checkout.split(`${key}:`).length - 1;
    assert.equal(hits, 3, `${key} is defined for ar, en and ckb`);
  }
});

test('the wallet becomes the default once a quote proves the balance covers it', () => {
  const at = checkout.indexOf('THE WALLET IS THE DEFAULT AS SOON AS IT IS A REAL ONE');
  assert.ok(at > 0, 'the rule is there and says why');
  const effect = checkout.slice(at, at + 1800);
  assert.ok(effect.includes('if (paymentPickedRef.current) return;'), 'a default, never an override');
  assert.ok(effect.includes('if (quoteLoading || !quote) return;'), 'it decides from a priced cart, not a guess');
  assert.ok(
    effect.includes('if (walletBalanceIQD < quote.total_iqd) return;'),
    'it never pre-selects a method that would refuse'
  );
  assert.ok(effect.includes("setPaymentMethod('wallet')"), 'and then lands on the wallet');
  assert.ok(
    effect.includes("if (paymentMethod === 'wallet') return;"),
    'idempotent — the switch cannot re-fire on the cheaper re-quote it causes'
  );
});

test('the buyer touching the radios ends the default’s opinion', () => {
  assert.ok(
    /paymentPickedRef\.current = true;/.test(checkout),
    'the onChange records that the choice is now the buyer’s'
  );
  const at = checkout.indexOf('paymentPickedRef.current = true;');
  const around = checkout.slice(at - 400, at + 200);
  assert.ok(around.includes('name="payment"'), 'it is the payment radios that set it');
  assert.ok(around.includes('setPaymentMethod(method.id)'), 'beside the selection it records');
});

test('the default is read AFTER the balance exists — a dependency array runs during render', () => {
  const balance = checkout.indexOf('const walletBalanceIQD =');
  const effect = checkout.indexOf('THE WALLET IS THE DEFAULT AS SOON AS IT IS A REAL ONE');
  assert.ok(balance > 0 && effect > 0);
  assert.ok(
    balance < effect,
    'the effect lists walletBalanceIQD as a dependency, and a const read above its own '
      + 'declaration is a TDZ ReferenceError on every render of this page'
  );
});
