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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  iqdToUsdCentsAt,
  formatUsdFromIqd,
  DEFAULT_DISPLAY_CURRENCY,
  currencyValue,
  resolveDisplayRate,
  CurrencyValueProvider,
} from '../src/CurrencyContext';
import { iqdToUsdCents as walletIqdToUsdCents, formatIqd } from '../src/lib/api';
import {
  DISPLAY_RATE_CACHE_KEY,
  DISPLAY_RATE_CACHE_MAX_AGE_MS,
  iqdToUsdCentsExact,
  readCachedDisplayRate,
  rememberDisplayRate,
  usableRate,
} from '../src/lib/displayRate';
import { LanguageProvider } from '../src/LanguageContext';
import { CheckoutBar } from '../src/components/subscription/CheckoutBar';
import type { ApiPlan, PurchaseQuote } from '../src/components/subscription/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ------------------------------------------------------ the arithmetic

test('1400 dinars is a dollar, at the administrator’s own rate', () => {
  assert.equal(iqdToUsdCentsAt(1400, 1400), 100);
  assert.equal(formatUsdFromIqd(1400, 1400), '$1.00');
  // A real printer price, at the shop's default rate.
  assert.equal(formatUsdFromIqd(1_750_000, 1400), '$1,250.00');
  // And at a rate the administrator changed: the conversion follows the
  // setting, which is the whole of what was asked for. 1,166.666… FLOORS —
  // «وعند الدولار يقرب الى عدد صحيح اقل» — the rule the wallet reads with.
  assert.equal(formatUsdFromIqd(1_750_000, 1500), '$1,166.66');
});

test('one dollar-reading rule: the shop floors exactly as the wallet does', () => {
  // 50,007 د.ع at 1,400 is 3,571.9 cents. `Math.round` read it as $35.72 on a
  // product page while the wallet (iqdToUsdCents, floor) read $35.71.
  assert.equal(iqdToUsdCentsAt(50_007, 1400), 3571);
  assert.equal(formatUsdFromIqd(50_007, 1400), '$35.71');
  for (const rate of [1, 7, 1300, 1400, 1450, 1500, 1600]) {
    for (const iqd of [0, 1, 13, 14, 15, 999, 1400, 49_999, 50_000, 50_007, 1_750_000, 99_999_999]) {
      assert.equal(iqdToUsdCentsAt(iqd, rate), walletIqdToUsdCents(iqd, rate), `${iqd} at ${rate}`);
    }
  }
  // Integer arithmetic: an exact dollar is never a hair short of itself.
  assert.equal(iqdToUsdCentsAt(1400 * 3, 1400), 300);
});

test('the cent is kept — a price is not rounded twice', () => {
  // 50,000 IQD at 1400 is $35.714…; showing «$36» would widen the gap between
  // what is on screen and what is charged without telling anyone.
  assert.equal(formatUsdFromIqd(50_000, 1400), '$35.71');
  assert.equal(iqdToUsdCentsAt(50_000, 1400), 3571);
});

test('the wallet’s number helper: a broken rate is zero, never Infinity or NaN', () => {
  for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(iqdToUsdCentsAt(1000, rate), 0, `rate ${rate}`);
    assert.equal(formatUsdFromIqd(1000, rate), '$0.00', `rate ${rate}`);
  }
  assert.equal(formatUsdFromIqd(Number.NaN, 1400), '$0.00');
});

// ------------------------------------- the shop's rate (FX programme plan §13)

const noop = () => {};
const shop = (text: string) => ({ text, source: 'shop' as const });

test('1,500,000 dinars at the shop’s 1,500 is $1,000.00 — exactly, from the decimal text', () => {
  assert.equal(iqdToUsdCentsExact(1_500_000, '1500'), 100_000);
  assert.equal(currencyValue('USD', noop, shop('1500')).money(1_500_000), '$1,000.00');
  // A rate with a fraction is read as two integers, never a float: 1,000,000 / 1703.9167.
  assert.equal(iqdToUsdCentsExact(1_000_000, '1703.9167'), 58_688);
  assert.equal(iqdToUsdCentsExact(1_703_917, '1703.9167'), 100_000);
  // The same floor the wallet reads with, on every whole-number rate.
  for (const rate of [1, 7, 1300, 1400, 1450, 1500, 1600]) {
    for (const iqd of [0, 1, 13, 14, 15, 999, 1400, 49_999, 50_000, 50_007, 1_750_000, 99_999_999]) {
      assert.equal(iqdToUsdCentsExact(iqd, String(rate)), iqdToUsdCentsAt(iqd, rate), `${iqd} at ${rate}`);
    }
  }
  // A refund line reads with its sign; the magnitude is the same floor.
  assert.equal(iqdToUsdCentsExact(-1_500_000, '1500'), -100_000);
  assert.equal(currencyValue('USD', noop, shop('1703.9167')).money(1_000_000), '$586.88');
});

test('no usable rate → dinars, never $0.00', () => {
  for (const bad of [null, '', '0', '0.0', '-1400', '1e3', '1,400', ' 1400', 'NaN', 'Infinity', '1400.', '.5']) {
    assert.equal(usableRate(bad), null, String(bad));
    assert.equal(iqdToUsdCentsExact(1000, bad as string | null), null, String(bad));
  }
  assert.equal(usableRate(1400), null, 'a number is not decimal text');
  const none = currencyValue('USD', noop, null);
  assert.equal(none.converted, false);
  assert.equal(none.money(1_750_000), formatIqd(1_750_000));
  assert.equal(none.moneyBoth(1_750_000), formatIqd(1_750_000));
  assert.doesNotMatch(none.money(5000), /\$/);
  // Dinars chosen: dinars, whatever the rate.
  assert.equal(currencyValue('IQD', noop, shop('1500')).money(1_500_000), formatIqd(1_500_000));
});

test('the rate source: displayUsdRate, or nothing (dinars) — NEVER the wallet rate (owner decision 9); the cached shop rate only before the settings arrive', () => {
  const r = (displayUsdRate: unknown, settingsLoaded = true, cached: string | null = null) => resolveDisplayRate({ settingsLoaded, displayUsdRate, cached });
  assert.deepEqual(r('1703.9167'), { text: '1703.9167', source: 'shop', attributed: true });
  // A rate the owner typed is still the shop's rate — just not credited to IQWealth (FX-1 review #10).
  assert.deepEqual(resolveDisplayRate({ settingsLoaded: true, displayUsdRate: '1650', cached: null, attributed: false }), { text: '1650', source: 'shop', attributed: false });
  // Not approved yet, an older server, garbage: prices read in dinars. The wallet's 1,400 is not a market reading.
  for (const none of [null, undefined, 'garbage', '0', '1e3', 1400, '1,680']) {
    assert.equal(r(none), null, `${String(none)}: dinars, never a wallet source`);
  }
  // Even with a cached rate on the device: once the settings say «none», the cache is not used.
  assert.equal(r(null, true, '1700'), null);
  // Before the settings: the last SHOP rate this device showed prices at, or nothing (dinars) — never a hard-coded 1,400.
  assert.deepEqual(r(undefined, false, '1700'), { text: '1700', source: 'cache' });
  assert.equal(r(undefined, false, null), null);
  // The input has no wallet rate at all: the resolver cannot reach it.
  const ctx = read('src/CurrencyContext.tsx');
  assert.doesNotMatch(ctx.slice(ctx.indexOf('export function resolveDisplayRate'), ctx.indexOf('interface CurrencyContextValue')), /exchangeRate:|'wallet'/);
  assert.doesNotMatch(ctx, /source: 'wallet'|\| 'wallet'/);
  // The context reads WalletContext's `displayUsdRate` (undefined until the settings arrive) — and not its exchangeRate.
  assert.match(ctx, /const \{ displayUsdRate, displayUsdRateAttributed: attributed \} = useWallet\(\);/);
  assert.match(ctx, /const settingsLoaded = displayUsdRate !== undefined;/);
  // …and hands it to the screens, so a «not approved yet» note can wait for the settings (FX-1A review #5).
  assert.match(ctx, /currencyValue\(currency, setCurrency, rate, settingsLoaded\)/);
  assert.equal(currencyValue('USD', noop, null, false).settingsLoaded, false);
  assert.equal(currencyValue('USD', noop, null).settingsLoaded, true);
  assert.match(read('src/WalletContext.tsx'), /displayUsdRate: settings \? \(settings\.displayUsdRate \?\? null\) : undefined,/);
  assert.match(read('src/lib/api.ts'), /displayUsdRate\?: string \| null;/);
  assert.match(read('src/WalletContext.tsx'), /displayUsdRateAttributed: settings\?\.displayUsdRateAttributed !== false,/);
});

test('the last good display rate is cached per device as {rate, at}; a stale, future or broken entry is ignored; storage that throws is fine', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = g.localStorage;
  const store = new Map<string, string>();
  try {
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const now = 1_800_000_000_000;
    rememberDisplayRate('1703.9167', now);
    assert.deepEqual(JSON.parse(store.get(DISPLAY_RATE_CACHE_KEY)!), { rate: '1703.9167', at: now });
    assert.equal(readCachedDisplayRate(now + 1000), '1703.9167');
    assert.equal(readCachedDisplayRate(now + DISPLAY_RATE_CACHE_MAX_AGE_MS + 1), null, 'too old');
    store.set(DISPLAY_RATE_CACHE_KEY, JSON.stringify({ rate: '1703.9167', at: now + 3_600_000 }));
    assert.equal(readCachedDisplayRate(now), null, 'from the future');
    store.set(DISPLAY_RATE_CACHE_KEY, JSON.stringify({ rate: '0', at: now }));
    assert.equal(readCachedDisplayRate(now), null, 'not a usable rate');
    store.set(DISPLAY_RATE_CACHE_KEY, '{not json');
    assert.equal(readCachedDisplayRate(now), null);
    rememberDisplayRate('1e3', now);
    assert.equal(store.get(DISPLAY_RATE_CACHE_KEY), '{not json', 'an unusable rate is never written');
    g.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.equal(readCachedDisplayRate(now), null);
    assert.doesNotThrow(() => rememberDisplayRate('1500', now));
    delete g.localStorage;
    assert.equal(readCachedDisplayRate(now), null, 'no storage at all');
  } finally {
    g.localStorage = saved;
  }
  // The context caches the SHOP rate prices were shown at — never the cache itself, never another source, and only when it changed.
  assert.match(read('src/CurrencyContext.tsx'), /if \(rate && rate\.source === 'shop' && rate\.text !== cached\) rememberDisplayRate\(rate\.text\);/);
});

test('two tabs agree: a storage event for the preference key moves this tab too', () => {
  const ctx = read('src/CurrencyContext.tsx');
  assert.match(ctx, /window\.addEventListener\('storage', onStorage\)/);
  assert.match(ctx, /if \(e\.key !== STORAGE_KEY\) return;\s*setCurrencyState\(readStored\(\) \?\? DEFAULT_DISPLAY_CURRENCY\);/);
  assert.match(ctx, /return \(\) => window\.removeEventListener\('storage', onStorage\);/);
  assert.match(ctx, /const STORAGE_KEY = 'levonis\.displayCurrency\.v1';/);
});

test('a tab left open picks up a new rate: settings are read again on return after 30 minutes', () => {
  const w = read('src/WalletContext.tsx');
  assert.match(w, /export const SETTINGS_STALE_MS = 30 \* 60 \* 1000;/);
  assert.match(w, /document\.addEventListener\('visibilitychange', onVisible\)/);
  assert.match(w, /Date\.now\(\) - settingsAt\.current > SETTINGS_STALE_MS\) void refreshSettings\(\)/);
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
  // The rate module asks nothing of the network either: the rate arrives with
  // the public settings, and the browser never calls an exchange-rate provider.
  const rate = read('src/lib/displayRate.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of ['api.', 'fetch(', 'XMLHttpRequest', 'import(']) {
    assert.ok(!rate.includes(forbidden), `the display-rate module reaches for ${forbidden}`);
  }
});

test('no FX provider is ever called from the browser: no provider host, no rates route outside the owner’s panel', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
    }
    return out;
  };
  const iqwealthMentions: string[] = [];
  for (const file of walk('src')) {
    const code = read(file);
    assert.doesNotMatch(code, /iraqsm\.com\/api|eurofxref|ecb\.europa\.eu\/stats|IRAQ_PARALLEL_FX_API_KEY|X-API-Key/i, `${file} names a provider endpoint or key`);
    if (/iraqsm\.com/.test(code)) iqwealthMentions.push(file);
    const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    if (!file.startsWith('src/components/adminPricing/')) assert.doesNotMatch(bare, /\/rates\/fx|\/api\/admin\/pricing\/rates/, `${file} calls the owner's rates routes`);
  }
  // The one mention is the attribution link IQWealth's terms ask for, in the top-bar menu.
  assert.deepEqual(iqwealthMentions, ['src/components/LangThemePanel.tsx']);
  assert.match(read('src/components/LangThemePanel.tsx'), /export const IQWEALTH_URL = 'https:\/\/iraqsm\.com';/);
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
  assert.match(src, /const \{ money, moneyBoth, walletMoney, walletCharge \} = useMoney\(\);/);
});

test('an order’s total keeps the dinar too — it is a record of a charge', () => {
  const src = read('src/components/orders/PaymentBreakdown.tsx');
  assert.match(src, /<Row label=\{s\.total\} value=\{moneyBoth\(f\.total_iqd\)\} strong \/>/);
});

test('moneyBoth really shows both, and the charge first', () => {
  const src = read('src/CurrencyContext.tsx');
  assert.match(src, /return usd \? `\$\{formatIqd\(iqd\)\} · \$\{usd\}` : formatIqd\(iqd\);/);
  const v = currencyValue('USD', noop, shop('1400'));
  assert.equal(v.moneyBoth(1_750_000), `${formatIqd(1_750_000)} · $1,250.00`);
  assert.equal(currencyValue('IQD', noop, shop('1400')).moneyBoth(1_750_000), formatIqd(1_750_000));
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
  // The router is NavigationRouter — BrowserRouter's own shape, reporting a
  // pending navigation as a busy wait (src/components/NavigationRouter.tsx).
  const router = app.indexOf('<NavigationRouter>');
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
  // The shop's rate once the owner approved one (named as the shop's, critique
  // L8) and credited to IQWealth with its link, as the menu does (Appendix A
  // L8; FX-1 UX review #9) — only when it is the provider's figure; a typed
  // rate is «a rate set by the shop» (review #10); whole dinars after «≈»
  // (review #15). Never the wallet's rate (owner decision 9): without a shop rate, dollars wait and the row says so.
  assert.match(src, /rate\.source === 'shop' && rate\.attributed !== false \? \(/);
  assert.match(src, /\{s\.currencyRateShop\(wholeRateText\(rate\.text\)\)\}\{' '\}\s*<a\s+href=\{IQWEALTH_URL\}\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(src, /s\.currencyRateSet\(wholeRateText\(rate\.text\)\)/);
  assert.doesNotMatch(src, /s\.currencyRate\(|groupRateText/, 'the old sentence at the wallet rate is gone');
  // The note waits for the settings: before they arrive, no rate is only "not known yet" (FX-1A review #5).
  assert.match(src, /\) : currency === 'USD' && settingsLoaded \? \(\s*<p[^>]*data-currency-usd-pending>\s*\{s\.usdPending\}/);
  assert.match(src, /const \{ currency, setCurrency, rate, converted, settingsLoaded \} = useMoney\(\);/);
  assert.ok(src.includes('سعر الصرف: 1 دولار ≈ ${rate} دينار — سعر المتجر للعرض فقط، بناءً على بيانات'));
  assert.ok(src.includes("Exchange rate: 1 dollar ≈ ${rate} dinars — the shop's rate, display only, based on"));
  assert.ok(src.includes('نرخی ئاڵوگۆڕ: 1 دۆلار ≈ ${rate} دینار — نرخی فرۆشگا، تەنها بۆ پیشاندان، لەسەر بنەمای زانیاریی'));
  assert.match(src, /\{converted \? \([\s\S]{0,200}currencyConvertedNote/);
  // The old copy said there was no such setting. It must not still say so.
  assert.ok(!src.includes('لا يوجد إعداد عملة عرض'), 'the row still denies the setting exists');
});

test('all three dictionaries carry the new currency strings', () => {
  const src = read('src/pages/Settings.tsx');
  for (const key of ['currency', 'currencyNote', 'currencyRateShop', 'currencyRateSet', 'usdPending', 'currencyConvertedNote']) {
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

test('the wallet toggle still converts at the wallet’s own rate (Q5)', () => {
  const src = read('src/pages/Wallet.tsx');
  assert.match(src, /const \{ paymentMethods, currency: defaultCurrency, exchangeRate, refreshWallet, settings \} = useWallet\(\);/);
  assert.match(src, /iqdToUsdCents\(iqd, exchangeRate\)/);
  assert.doesNotMatch(src, /displayUsdRate|money\(/, 'the wallet page never reads the market-rate display');
});

// ------------------------------- critique M2: one charge, one dollar figure

const plan: ApiPlan = { id: 'pro_12mo', tier: 'pro', duration_months: 12, price_iqd: 140_000, purchasable: true, per_month_iqd: null, sort: 1 };
const quote = (over: Partial<Extract<PurchaseQuote, { ok: true }>> = {}): PurchaseQuote => ({
  ok: true,
  plan,
  price_iqd: 140_000,
  credit_iqd: 0,
  charge_iqd: 140_000,
  exchange_rate: 1400,
  charge_usd_cents: 10_000,
  balance_usd_cents: 10_000,
  shortfall_usd_cents: 0,
  balance_iqd: 140_000,
  shortfall_iqd: 0,
  activate_now: true,
  launch_at: null,
  expires_at: '2027-09-23T00:00:00.000Z',
  upgrade_from_tier: null,
  ...over,
});

function renderBarUsd(q: PurchaseQuote, rate = '1500'): string {
  const bar = createElement(CheckoutBar, {
    plan,
    standing: 'open',
    quote: q,
    quoteLoading: false,
    quoteError: null,
    onRetryQuote: noop,
    isGuest: false,
    busy: false,
    onSubscribe: noop,
    ctaRef: { current: null },
    currentExpiry: null,
  });
  return renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(CurrencyValueProvider, { value: currencyValue('USD', noop, shop(rate)), children: createElement(MemoryRouter, null, bar) }),
    })
  );
}

test('in USD mode no screen shows one charge in two dollar figures at different rates (critique M2)', () => {
  // A 140,000 IQD membership and a $100 wallet. At the shop's 1,500 the charge
  // would read $93.33 — beside a wallet debit of $100.00 at the wallet's 1,400.
  const html = renderBarUsd(quote());
  const dollars = [...html.matchAll(/\$[\d,]+\.\d{2}/g)].map((m) => m[0]);
  assert.ok(!dollars.includes('$93.33'), `a market-rate dollar figure for the charge: ${dollars.join(' ')}`);
  for (const d of dollars) assert.equal(d, '$100.00', `only the ledger's own cents may be dollars: ${d}`);
  assert.ok(html.includes(formatIqd(140_000)), 'the charge is said in dinars');
  // A shortfall is the ledger's figure too.
  const short = renderBarUsd(quote({ balance_usd_cents: 5000, balance_iqd: 70_000, shortfall_iqd: 70_000, shortfall_usd_cents: 5000 }));
  for (const d of [...short.matchAll(/\$[\d,]+\.\d{2}/g)].map((m) => m[0])) assert.equal(d, '$50.00');

  // The value itself: wallet amounts are the ledger's cents, a wallet charge is dinars, a catalogue price the shop's rate.
  const v = currencyValue('USD', noop, shop('1500'));
  assert.equal(v.walletMoney(140_000, 10_000), '$100.00');
  assert.equal(v.walletMoney(140_000), formatIqd(140_000), 'only dinars known: dinars');
  assert.equal(v.walletCharge(140_000), formatIqd(140_000));
  assert.equal(v.money(140_000), '$93.33');
  assert.equal(currencyValue('IQD', noop, shop('1500')).walletMoney(140_000, 10_000), formatIqd(140_000));

  // The confirmation sheet: no market-rate money() at all.
  const confirm = read('src/components/subscription/PurchaseConfirm.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(confirm, /\bmoney\(/);
  assert.match(confirm, /walletCharge\(ok\.price_iqd\)/);
  assert.match(confirm, /walletCharge\(ok\.charge_iqd\)/);
  assert.match(confirm, /walletMoney\(ok\.balance_iqd, ok\.balance_usd_cents\)/);
  assert.match(confirm, /walletMoney\(result\.res\.charged_iqd, result\.res\.charged_usd_cents\)/);
  // The checkout's wallet block: every figure at the wallet's rate or in dinars.
  const checkout = read('src/pages/Checkout.tsx');
  const block = checkout.slice(checkout.indexOf('<div data-checkout-wallet '), checkout.indexOf('POINTS, AS A QUIET LINE'));
  assert.ok(block.length > 1000, 'the wallet block was not found');
  assert.doesNotMatch(block, /\bmoney\(/);
  assert.match(block, /walletMoney\(quote\.wallet\.applied_iqd\)/);
  assert.match(block, /walletMoney\(walletRemainderIqd\)/);
  assert.match(checkout, /−\{walletMoney\(walletDiscount\)\}/);
  // The profile's balance card: the ledger's cents in dollars.
  assert.match(read('src/pages/Profile.tsx'), /currency === 'USD' \? <bdi dir="ltr">\{walletMoney\(balanceIqd, balanceUsdCents\)\}<\/bdi>/);
});
