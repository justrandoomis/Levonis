/**
 * «1- تغيير العملة وأقصد بها هو أن الدينار مقابل الدولار, في لوحة الإدارة يكون
 *  سعر الدولار يساوي 1400 دينار فيتم التحويل عند تغيير العملة.»
 *
 * THE RATE WAS ALREADY THE ADMINISTRATOR'S. `exchangeRate` is an
 * `admin_settings` row, served to every visitor by GET /api/settings/public,
 * editable in «إعدادات المحفظة» and defaulting to 1400; the wallet page has
 * converted with it for months. What did not exist was any way for a customer
 * to ask for that conversion on the shop itself — src/pages/Settings.tsx said
 * so in as many words: «لا يوجد إعداد عملة عرض لكل حساب».
 *
 * WHAT THIS SUITE IS ACTUALLY GUARDING. A currency switch is one line of UI
 * and three ways to lie:
 *
 *   1. converting a number that is then SENT somewhere — a cart line, a
 *      checkout body, an amount typed into a form;
 *   2. showing an approximation on the screen where money is committed;
 *   3. converting most prices and missing one, so two figures on the same
 *      page disagree about what currency they are in.
 *
 * The arithmetic is exercised against the real module; the three failures
 * above are source rules, because each of them is a thing that would still
 * pass every behavioural test written for the formatter.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iqdToUsdCentsAt, formatUsdFromIqd, DEFAULT_DISPLAY_CURRENCY } from '../src/CurrencyContext';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ------------------------------------------------------ the arithmetic

test('1400 dinars is a dollar, at the administrator’s own rate', () => {
  assert.equal(iqdToUsdCentsAt(1400, 1400), 100);
  assert.equal(formatUsdFromIqd(1400, 1400), '$1.00');
  // A real printer price, at the shop's default rate.
  assert.equal(formatUsdFromIqd(1_750_000, 1400), '$1,250.00');
  // And at a rate the administrator changed: the conversion follows the
  // setting, which is the whole of what was asked for.
  assert.equal(formatUsdFromIqd(1_750_000, 1500), '$1,166.67');
});

test('the cent is kept — a price is not rounded twice', () => {
  // 50,000 IQD at 1400 is $35.714…; showing «$36» would widen the gap between
  // what is on screen and what is charged without telling anyone.
  assert.equal(formatUsdFromIqd(50_000, 1400), '$35.71');
  assert.equal(iqdToUsdCentsAt(50_000, 1400), 3571);
});

test('a broken rate is zero, never Infinity or NaN on a price tag', () => {
  for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(iqdToUsdCentsAt(1000, rate), 0, `rate ${rate}`);
    assert.equal(formatUsdFromIqd(1000, rate), '$0.00', `rate ${rate}`);
  }
  assert.equal(formatUsdFromIqd(Number.NaN, 1400), '$0.00');
});

test('the shop’s own currency is what an unanswered question means', () => {
  assert.equal(DEFAULT_DISPLAY_CURRENCY, 'IQD');
});

// -------------------------------------------- nothing is sent converted

test('the conversion never leaves the screen', () => {
  const src = read('src/CurrencyContext.tsx');
  // No request, no body, no write of a converted number anywhere in the
  // module that owns the conversion.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of ['api.post', 'api.put', 'api.patch', 'fetch(']) {
    assert.ok(!code.includes(forbidden), `the currency module reaches for ${forbidden}`);
  }
  // It stores ONE thing, and it is the preference itself.
  assert.match(src, /window\.localStorage\.setItem\(STORAGE_KEY, currency\)/);
  assert.equal((code.match(/setItem\(/g) ?? []).length, 1);
});

test('storage that throws is not a blank shop', () => {
  const src = read('src/CurrencyContext.tsx');
  // Private mode, blocked site data, a thumbnail capture: every read and
  // write is wrapped and the fallback is the shop's own currency.
  assert.match(src, /try \{[\s\S]{0,200}getItem\(STORAGE_KEY\)[\s\S]{0,120}\} catch \{/);
  assert.match(src, /try \{[\s\S]{0,160}setItem\(STORAGE_KEY[\s\S]{0,120}\} catch \{/);
  assert.match(src, /readStored\(\) \?\? DEFAULT_DISPLAY_CURRENCY/);
});

// --------------------------------------- the committed figure stays IQD

test('the checkout total keeps the dinar, whatever the switch says', () => {
  const src = read('src/pages/Checkout.tsx');
  // The screen with the pay button on it is the last place to be
  // approximate: a converted figure at a rate the shop can change tomorrow is
  // not the number the customer's bank will see.
  assert.match(src, /data-testid="checkout-order-total"[\s\S]{0,200}\{moneyBoth\(orderTotal\)\}/);
  assert.match(src, /const \{ money, moneyBoth \} = useMoney\(\);/);
});

test('an order’s total keeps the dinar too — it is a record of a charge', () => {
  const src = read('src/components/orders/PaymentBreakdown.tsx');
  assert.match(src, /<Row label=\{s\.total\} value=\{moneyBoth\(f\.total_iqd\)\} strong \/>/);
});

test('moneyBoth really shows both, and the charge first', () => {
  const src = read('src/CurrencyContext.tsx');
  assert.match(
    src,
    /converted \? `\$\{formatIqd\(iqd\)\} · \$\{formatUsdFromIqd\(iqd, exchangeRate\)\}` : formatIqd\(iqd\)/
  );
});

// ------------------------------------------------- no figure left behind

test('every customer-facing price goes through the hook, not formatIqd', () => {
  // THE FAILURE THIS CATCHES: converting most of a page and missing one
  // figure, so two numbers beside each other disagree about their currency.
  // The admin screens, the merchant dashboard, the wallet ledger and the
  // investor page are deliberately not in this set — each reads a stored
  // figure for somebody doing accounting, not a price for somebody shopping.
  const roots = ['src/pages', 'src/components'];
  const skip = /admin|Admin|Merchant|merchant\/|pages\/Wallet|pages\/Invest/;

  /**
   * THE ONE EXCEPTION, NAMED AND BOUNDED.
   *
   * A RATE IS NOT A PRICE. «3 الف لكل 500 الف» is how the cash-on-delivery
   * charge is DEFINED, and converting a definition would make the explanation
   * depend on a rate the shop can change tomorrow.
   *
   * IT IS QUOTED FROM THE ADMIN'S SETTING, NOT FROM THE PACKAGED CONSTANT.
   * This used to assert `formatIqd(COD_TAX_PER_BLOCK_IQD)` — the compiled-in
   * default — which pinned the sentence to a number the owner could no longer
   * change once «وتكون قابله للتغير من قبل الادارة» was implemented: the shop
   * charged 3,000 and the screen kept explaining 6,000. `codTaxPerBlockIqd`
   * and `codTaxBlockIqd` are `settingRate(settings?.…, CONSTANT)`, so the
   * constants survive as the fallback and the sentence follows the rate.
   *
   * The allowance is for those two values and nothing else: any OTHER
   * formatIqd in this file fails the count below, which is what keeps the
   * exception from spreading.
   */
  const RATE_SENTENCE = 'src/pages/Checkout.tsx';
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skip.test(rel)) walk(rel);
        continue;
      }
      if (!entry.name.endsWith('.tsx') || skip.test(rel)) continue;
      const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      const calls = code.match(/\bformatIqd\(/g) ?? [];
      if (rel === RATE_SENTENCE) {
        // Exactly the four: two constants, twice (Arabic and English).
        assert.equal(calls.length, 4, `${rel}: the rate-sentence allowance is for those two rates only`);
        assert.equal(
          (code.match(/formatIqd\(codTax(PerBlock|Block)Iqd\)/g) ?? []).length,
          4,
          `${rel}: the rate sentence must quote the ADMIN's configured rate, not the packaged constant`
        );
        continue;
      }
      if (calls.length) offenders.push(rel);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], `these still format a customer price in dinars unconditionally`);
});

test('the four contexts nest in the order the conversion needs', () => {
  const app = read('src/App.tsx');
  // The rate lives in WalletProvider, so CurrencyProvider must be inside it;
  // a reading preference is not a route, so it is outside the Router.
  const wallet = app.indexOf('<WalletProvider>');
  const currency = app.indexOf('<CurrencyProvider>');
  const router = app.indexOf('<Router>');
  assert.ok(wallet >= 0 && currency > wallet, 'CurrencyProvider must be inside WalletProvider');
  assert.ok(router > currency, 'CurrencyProvider must wrap the Router, not sit inside it');
});

// --------------------------------------------------------- the control

test('the settings row is a real switch and states the rate it converts at', () => {
  const src = read('src/pages/Settings.tsx');
  assert.match(src, /\(\['IQD', 'USD'\] as const\)\.map\(\(code\) => \(/);
  assert.match(src, /onClick=\{\(\) => setCurrency\(code\)\}/);
  assert.match(src, /aria-pressed=\{currency === code\}/);
  // A conversion whose rate is not on screen is a number the reader cannot
  // check, and the disclosure only appears while a conversion is being shown.
  assert.match(src, /\{s\.currencyRate\(rate\.toLocaleString\('en-US'\)\)\}/);
  assert.match(src, /\{converted \? \([\s\S]{0,200}currencyConvertedNote/);
  // The old copy said there was no such setting. It must not still say so.
  assert.ok(!src.includes('لا يوجد إعداد عملة عرض'), 'the row still denies the setting exists');
});

test('all three dictionaries carry the new currency strings', () => {
  const src = read('src/pages/Settings.tsx');
  for (const key of ['currency', 'currencyNote', 'currencyRate', 'currencyConvertedNote']) {
    assert.equal(
      (src.match(new RegExp(`^ *${key}:`, 'gm')) ?? []).length,
      3,
      `${key} is missing from one of ar / en / ckb`
    );
  }
});

test('the wallet’s own toggle opens on the same answer as the shop', () => {
  // Two controls disagreeing about the same word on first paint is the
  // confusion this shop removes, not adds.
  const src = read('src/pages/Wallet.tsx');
  assert.match(src, /const \{ currency: siteCurrency \} = useMoney\(\);/);
  assert.match(src, /useState<'IQD' \| 'USD'>\(siteCurrency \?\? defaultCurrency\)/);
});
