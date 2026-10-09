/**
 * THE FX-1 REVIEW'S CLIENT FINDINGS, ONE TEST EACH (UX review #1–#15;
 * correctness #6 and #9/#10's screens). Each failed on the FX-1 client commit
 * as it was reviewed and passes now. Rendered with react-dom/server where a
 * screen can be rendered without a request; read from the source where the
 * behaviour is wiring (focus, navigation).
 *
 * Run: node --import tsx --test tests/fxReviewFixesClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codeOf } from './fixtures/source';
import { LanguageProvider } from '../src/LanguageContext';
import { ApiError } from '../src/lib/api';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import FxPairCard from '../src/components/adminPricing/FxPairCard';
import { PricingFailure } from '../src/components/adminPricing/parts';
import { FX_STRINGS } from '../src/components/adminPricing/fxStrings';
import * as fxParts from '../src/components/adminPricing/fxParts';
import * as fxStringsModule from '../src/components/adminPricing/fxStrings';
import * as rateText from '../src/lib/rateText';
// Read through the modules so each test runs (and fails on its own) on a commit without the fix.
const { FxMessage, fxRefusalText } = fxParts;
const refreshMessage = (...a: Parameters<typeof fxParts.refreshMessage>) => fxParts.refreshMessage(...a);
const fxCodeText = (...a: Parameters<typeof fxStringsModule.fxCodeText>) => fxStringsModule.fxCodeText(...a);
const fxErrorGroup = (...a: Parameters<typeof fxStringsModule.fxErrorGroup>) => fxStringsModule.fxErrorGroup(...a);
const roundDecimalText = (...a: Parameters<typeof rateText.roundDecimalText>) => rateText.roundDecimalText(...a);
const wholeRateText = (...a: Parameters<typeof rateText.wholeRateText>) => rateText.wholeRateText(...a);
const pairShortName = (name: string) => (fxStringsModule as unknown as { pairShortName: (n: string) => string }).pairShortName(name);
import type { FxPairDto, FxRatesAnswer } from '../src/components/adminPricing/api';

const DIR = 'src/components/adminPricing';
const LANGS = ['ar', 'en', 'ckb'] as const;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** An Arabic phone: the system number format writes Arabic-Indic digits, U+066B and U+066C. */
function withArabicDigits<T>(fn: () => T): T {
  const Real = Intl.NumberFormat;
  const Stub = function (this: unknown, _locales?: string | string[], options?: Intl.NumberFormatOptions) {
    return new Real('ar-IQ', options);
  } as unknown as typeof Intl.NumberFormat;
  Object.assign(Stub, Real);
  Intl.NumberFormat = Stub;
  const realLocale = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (this: number, locales?: string | string[], options?: Intl.NumberFormatOptions) {
    return realLocale.call(this, locales ?? 'ar-IQ', options);
  };
  try {
    return fn();
  } finally {
    Intl.NumberFormat = Real;
    Number.prototype.toLocaleString = realLocale;
  }
}

const pairOf = (over: Partial<FxPairDto> = {}): FxPairDto => ({
  pair: 'USD_IQD',
  provider: 'iqwealth',
  attribution: { text: 'IQWealth', url: 'https://iraqsm.com' },
  mode: 'AUTO',
  interval_hours: 6,
  market_rate: '1660',
  market_buy: '1655',
  official_rate: '1310',
  market_adjustment_iqd: '15',
  formula_holds: true,
  manual_rate: null,
  effective_rate: '1675',
  effective_version: 3,
  effective_source: 'provider',
  effective_applied_at: '2026-10-09T00:00:00.000Z',
  last_known_good_rate: '1675',
  drift_anchor_rate: '1650',
  drift_anchor_at: '2026-10-08T00:00:00.000Z',
  published_at: '2026-10-08T23:58:00.000Z',
  last_checked_at: '2026-10-09T00:00:00.000Z',
  last_check_result: 'APPLIED',
  last_successful_at: '2026-10-09T00:00:00.000Z',
  status: 'OK',
  fetch_status: 'OK',
  last_error_code: null,
  failing_since: null,
  pending: null,
  rejected: null,
  last_observed: null,
  anomaly_threshold_pct: '3',
  drift_threshold_pct: '6',
  min_change_pct: '0.5',
  bound_min: '1000',
  bound_max: '3000',
  next_check_at: '2026-10-09T12:00:00.000Z',
  owner_version: 4,
  ...over,
});

const ratesOf = (pairs: FxPairDto[], derived: FxRatesAnswer['effective_rates_iqd'] = { USD: { rate_iqd: '1675', version: 3, updated_at: null } }): FxRatesAnswer => ({
  success: true,
  pairs,
  effective_rates_iqd: derived,
  shipping: [],
  key_configured: true,
  refresh_budget: { used_today: 1, limit: 40 },
  provider_budget: { USD_IQD: { used_today: 4, cap: 150 } },
  engine_products: 0,
  reprice_blocked: 0,
  stale_products: 0,
});

const card = (p: FxPairDto, lang: (typeof LANGS)[number] = 'ar', rates = ratesOf([p])) =>
  render(createElement(FxPairCard, { pair: p, rates, lang, s: FX_STRINGS[lang], onAnswer: () => {}, onStale: () => {}, onReview: () => {} }));

// ------------------------------------------------------------- #1 digits and precision

test('UX #1: on an Arabic phone every figure of the rates panel is Latin — no U+066B/U+066C side by side; EUR/IQD in whole dinars; CNY/USD to six decimals, the exact text in the tooltip', () => {
  const eur = pairOf({ pair: 'EUR_USD', provider: 'ecb', market_rate: '1.1186', market_buy: null, official_rate: null, market_adjustment_iqd: null, effective_rate: '1.1186', last_known_good_rate: '1.1186', drift_anchor_rate: '1.1186', interval_hours: 24 });
  const cny = pairOf({ pair: 'CNY_USD', provider: 'ecb', market_rate: '0.1392023689', market_buy: null, official_rate: null, market_adjustment_iqd: null, effective_rate: '0.1392023689', last_known_good_rate: '0.1392023689', drift_anchor_rate: '0.1392023689', interval_hours: 24 });
  const derived = { USD: { rate_iqd: '1675', version: 3, updated_at: null }, EUR: { rate_iqd: '1873.655', version: 2, updated_at: null }, CNY: { rate_iqd: '233.1639679075', version: 2, updated_at: null } };
  for (const lang of LANGS) {
    const html = withArabicDigits(() => card(eur, lang, ratesOf([eur], derived)) + card(cny, lang, ratesOf([cny], derived)));
    const text = textOf(html);
    assert.doesNotMatch(text, /[٠-٩۰-۹٫٬]/, `${lang}: a localized digit or separator on the panel: ${text.slice(0, 200)}`);
    assert.ok(text.includes('1 EUR = 1.1186 USD'), `${lang}: EUR/USD as the ECB writes it`);
    assert.ok(text.includes('≈ 1,874'), `${lang}: EUR in dinars, whole`);
    assert.ok(!text.includes('1,873.655'), `${lang}: no three-decimal dinars`);
    assert.ok(text.includes('1 CNY ≈ 0.139202 USD'), `${lang}: CNY/USD to six decimals`);
    assert.ok(text.includes('≈ 233'), `${lang}: CNY in dinars, whole`);
    assert.ok(!text.includes('0.1392023689 USD'), `${lang}: never ten decimals on the face`);
    assert.match(html, /title="1 CNY = 0\.1392023689 USD"/, `${lang}: the exact rate in the tooltip`);
  }
  // Rounded as text, half up — never through a float.
  assert.equal(roundDecimalText('0.1392023689', 6), '0.139202');
  assert.equal(roundDecimalText('0.1392025', 6), '0.139203');
  assert.equal(roundDecimalText('1873.655', 0), '1874');
  assert.equal(roundDecimalText('999.9999', 2), '1000');
  assert.equal(roundDecimalText('1700', 0), '1700');
  assert.equal(roundDecimalText('0.0000004', 6), '0');
});

// ------------------------------------------------------------- #2 the fresh sign-in

test('UX #2: a fresh-sign-in refusal offers «سجّل الدخول مجددًا», which signs out and comes back to the pricing tab; the acts that need it say so first', () => {
  for (const lang of LANGS) {
    const s = FX_STRINGS[lang];
    const html = render(createElement(FxMessage, { message: { tone: 'danger', text: s.reauth, reauth: true }, s }));
    assert.match(html, /data-fx-sign-in-again/, lang);
    assert.ok(textOf(html).includes(s.signInAgain), lang);
    // No button on any other refusal.
    assert.doesNotMatch(render(createElement(FxMessage, { message: { tone: 'danger', text: 'x' }, s })), /data-fx-sign-in-again/);
  }
  assert.equal(fxParts.PRICING_TAB_PATH, '/admin?tab=pricing');
  const parts = codeOf(`${DIR}/fxParts.tsx`);
  assert.match(parts, /reauth: code === 'REAUTH_REQUIRED'/);
  assert.match(parts, /await auth\?\.logout\(\);[\s\S]{0,80}window\.location\.assign\(`\/auth\?next=\$\{encodeURIComponent\(PRICING_TAB_PATH\)\}`\)/);
  // Said before the act: the large-change confirmation, keep-as-manual, «تأكيد السعر الحالي».
  for (const lang of LANGS) {
    const s = FX_STRINGS[lang];
    assert.notEqual(s.largeChange('15'), s.reauth);
    assert.ok(s.keepManualHint.length > 10 && s.confirmCurrentHint.length > 10);
  }
  assert.match(FX_STRINGS.en.largeChange('15'), /recent sign-in/);
  assert.match(FX_STRINGS.en.keepManualHint, /recent sign-in/);
  assert.match(FX_STRINGS.en.confirmCurrentHint, /recent sign-in/);
  assert.match(codeOf(`${DIR}/FxReviewSheet.tsx`), /data-fx-keep-manual-hint/);
});

// ------------------------------------------------------------- #3 not installed

test('UX #3: 503 PRICING_NOT_INSTALLED is a calm notice in the contract\'s words — no «server error», no Retry', () => {
  for (const lang of LANGS) {
    const html = render(createElement(PricingFailure, { error: new ApiError(503, 'x', 'PRICING_NOT_INSTALLED'), lang, onRetry: () => {}, fallback: 'fallback' }));
    assert.match(html, /role="status"/, lang);
    assert.match(html, /data-pricing-not-installed/, lang);
    assert.ok(textOf(html).includes(COST_REFUSALS.PRICING_NOT_INSTALLED[lang]), lang);
    assert.doesNotMatch(html, /<button/, `${lang}: a Retry that cannot help`);
  }
});

// ------------------------------------------------------------- #4 refresh answers

test('UX #4: «تحديث الآن» says what the report found — never a bare «تم الحفظ»', () => {
  const s = FX_STRINGS.ar;
  const r = (checked: Array<{ pair: 'USD_IQD' | 'EUR_USD' | 'CNY_USD'; result: never | string; code: string | null }>, extra: { lease_held?: string[]; budget_deferred?: string[] } = {}) =>
    refreshMessage({ checked: checked as never, lease_held: (extra.lease_held ?? []) as never, budget_deferred: (extra.budget_deferred ?? []) as never }, s);
  assert.deepEqual(r([{ pair: 'USD_IQD', result: 'UNCHANGED', code: null }]), { tone: 'success', text: s.refreshOutcome.unchanged });
  assert.deepEqual(r([{ pair: 'USD_IQD', result: 'APPLIED', code: null }]), { tone: 'success', text: s.refreshOutcome.applied });
  assert.equal(r([{ pair: 'USD_IQD', result: 'REVIEW_HELD', code: 'ANOMALY' }]).tone, 'warning');
  // Every pair held back by today's provider budget: the owner hears it, not «تم الحفظ».
  const limit = r([{ pair: 'USD_IQD', result: 'DEFERRED', code: 'PROVIDER_BUDGET' }], { budget_deferred: ['USD_IQD'] });
  assert.deepEqual(limit, { tone: 'warning', text: s.refreshOutcome.limit });
  assert.notEqual(limit.text, s.saved);
  assert.equal(r([{ pair: 'USD_IQD', result: 'FAILED', code: 'TIMEOUT' }]).text, s.refreshOutcome.failed);
  assert.equal(r([], { lease_held: ['EUR_USD'] }).text, s.refreshOutcome.busy);
  assert.equal(r([{ pair: 'USD_IQD', result: 'OBSERVED', code: null }]).text, s.refreshOutcome.observed);
  // Two outcomes, each said once, the most important first.
  assert.equal(r([{ pair: 'USD_IQD', result: 'APPLIED', code: null }, { pair: 'EUR_USD', result: 'UNCHANGED', code: null }, { pair: 'CNY_USD', result: 'FAILED', code: 'NETWORK' }]).text, `${s.refreshOutcome.applied} ${s.refreshOutcome.failed}`);
  assert.match(codeOf(`${DIR}/RatesPanel.tsx`), /refresh\.run\('refresh', \(\) => refreshFxRates\(\), \(answer\) => refreshMessage\(answer\.report, s\)\)/);
  for (const lang of LANGS) for (const k of Object.keys(FX_STRINGS.ar.refreshOutcome)) assert.ok((FX_STRINGS[lang].refreshOutcome as Record<string, string>)[k], `${lang} ${k}`);
});

// ------------------------------------------------------------- #5 the stale panel

test('UX #5: 409 PRICING_CHANGED on the rates panel says it reloaded — not P1\'s «export the file again»', () => {
  for (const lang of LANGS) {
    const t = fxRefusalText(new ApiError(409, 'x', 'PRICING_CHANGED'), lang, FX_STRINGS[lang]);
    assert.equal(t, FX_STRINGS[lang].panelChanged);
    assert.doesNotMatch(t, /صدّر|export|هەناردە/i);
  }
});

// ------------------------------------------------------------- #6 a manual rate is not «Working»

test('UX #6: a manual pair shows «يدوي», not the green «يعمل» — on the card and on the overview card', () => {
  for (const lang of LANGS) {
    const s = FX_STRINGS[lang];
    const html = card(pairOf({ mode: 'MANUAL', manual_rate: '1675', status: 'OK' }), lang);
    assert.match(html, /data-fx-mode-chip="MANUAL"/);
    assert.ok(textOf(html).includes(s.modeManual), lang);
    assert.ok(!textOf(html).includes(s.st.OK), `${lang}: «${s.st.OK}» on a manual rate`);
    // An automatic pair still says its status.
    assert.ok(textOf(card(pairOf(), lang)).includes(s.st.OK));
  }
  assert.match(codeOf('src/components/admin/OwnerRatesCard.tsx'), /p\.mode === 'MANUAL' \? <StatusChip tone="neutral">\{s\.modeManual\}<\/StatusChip>/);
});

// ------------------------------------------------------------- #7 focus

test('UX #7: focus never falls to <body> — an editor focuses its field when it opens and gives focus back to its opener when it closes', () => {
  const c = codeOf(`${DIR}/FxPairCard.tsx`);
  assert.match(c, /<Input autoFocus ltr inputMode="decimal" autoComplete="off" value=\{manual\}/);
  assert.match(c, /<Button ref=\{manualOpenRef\}/);
  assert.match(c, /setManualOpen\(false\);\s*setManualError\(null\);\s*setFocusBack\('manual'\);/, 'Cancel gives focus back to «تعيين سعر يدوي»');
  assert.match(c, /setManual\(''\);\s*setFocusBack\('manual'\);/, 'a saved manual rate too');
  assert.match(c, /setTracking\(trackingOf\(p\)\);\s*setFocusBack\('tracking'\);/, 'Cancel under the tracking choice');
  assert.match(c, /querySelector<HTMLElement>\('\[role="radio"\]\[aria-checked="true"\]'\)\?\.focus\(\)/);
  const ship = codeOf(`${DIR}/ShippingRatesCard.tsx`);
  assert.match(ship, /<Input autoFocus ltr inputMode="decimal" autoComplete="off" value=\{draft\}/);
  assert.match(ship, /ref=\{editRef\}/);
  assert.match(ship, /setError\(null\);\s*setFocusEdit\(true\);/);
  assert.match(ship, /setEditing\(false\);\s*setFocusEdit\(true\);/);
});

// ------------------------------------------------------------- #8 loading announced

test('UX #8: the loading status is announced — it is no longer inside the aria-hidden skeleton', () => {
  // (The panel mounts its sheets through a portal, so it is read, not rendered, here.)
  const panel = codeOf(`${DIR}/RatesPanel.tsx`);
  const loading = panel.slice(panel.indexOf(') : !data ? ('), panel.indexOf(') : (', panel.indexOf(') : !data ? (') + 5));
  assert.ok(loading.length > 50, 'the loading branch was not found');
  assert.match(loading, /^\) : !data \? \(\s*<div className="mt-4">\s*<p className="sr-only" role="status" data-fx-loading>/);
  const status = loading.indexOf('role="status"');
  const hidden = loading.indexOf('aria-hidden="true"');
  assert.ok(hidden > status, 'the hidden skeleton comes after, beside the status — not around it');
  assert.doesNotMatch(loading, /aria-hidden="true">\s*<p className="sr-only" role="status"/);
});

// ------------------------------------------------------------- #10 digits in sentences

test('UX #10: no sentence of the panel bakes a digit in — every number is a parameter the panel writes', () => {
  const leaves = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') out.push(String((v as (...a: string[]) => string)('N', 'M', 'K', 'L')));
    else if (v && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out);
    return out;
  };
  for (const lang of LANGS) {
    for (const text of leaves(FX_STRINGS[lang])) assert.doesNotMatch(text, /[0-9٠-٩۰-۹]/, `${lang}: «${text}»`);
  }
  assert.equal(FX_STRINGS.ar.int6Short('6'), '6 ساعات');
  assert.equal(FX_STRINGS.ckb.int12Short('12'), '12 کاتژمێر');
  assert.equal(FX_STRINGS.ar.reasons.ANOMALY_24H('3', '24'), 'تغيّر أكبر من 3٪ خلال 24 ساعة');
});

// ------------------------------------------------------------- #11 the history sheet

test('UX #11: the history names the pair in words with a real gap, says a code in words, and filters by pair names', () => {
  const h = codeOf(`${DIR}/FxHistorySheet.tsx`);
  assert.doesNotMatch(h, /font-mono/);
  assert.doesNotMatch(h, /className="ms-2 [^"]*" dir="ltr"/, 'the margin on the dir=ltr span lands on the far side in RTL');
  assert.match(h, /<span className="ms-2 text-\[12px\] font-normal text-text-muted" data-fx-history-pair>\s*<bdi>\{s\.pairName\[it\.pair\] \?\? it\.pair\}<\/bdi>/);
  assert.match(h, /\{fxCodeText\(s, it\.error_code\)\}/);
  assert.match(h, /label: pairShortName\(s\.pairName\[id\]\)/);
  assert.equal(pairShortName(FX_STRINGS.ar.pairName.USD_IQD), 'الدولار');
  assert.equal(pairShortName(FX_STRINGS.ckb.pairName.CNY_USD), 'یوان');
  assert.equal(pairShortName(FX_STRINGS.en.pairName.EUR_USD), 'EUR');
  // The codes the server writes, in words.
  const s = FX_STRINGS.en;
  assert.equal(fxCodeText(s, 'TIMEOUT'), s.errorText.timeout);
  assert.equal(fxCodeText(s, 'HTTP_503'), s.errorText.unreachable);
  assert.equal(fxCodeText(s, 'KEY_MISSING'), s.errorText.key);
  assert.equal(fxCodeText(s, 'FX_RATE_OUT_OF_BOUNDS'), s.errorText.bounds);
  assert.equal(fxCodeText(s, 'FX_INVALID_SHAPE'), s.errorText.invalid);
  assert.equal(fxCodeText(s, 'FX_DECIDE_FAILED'), s.errorText.save);
  assert.equal(fxCodeText(s, 'ANOMALY_24H'), s.reasonName.ANOMALY_24H);
  assert.equal(fxErrorGroup('SOMETHING_NEW'), 'other');
  for (const lang of LANGS) assert.doesNotMatch(fxCodeText(FX_STRINGS[lang], 'SOMETHING_NEW'), /SOMETHING_NEW/);
  // The cursor is (time, id): no row of a batch is dropped at a page edge (correctness C4).
  assert.match(codeOf(`${DIR}/api.ts`), /p\.set\('before_id', q\.before\.id\);/);
});

// ------------------------------------------------------------- #12 the intro

test('UX #12: the intro does not say «this update» (read as «Refresh now»), and says what the rate is for', () => {
  assert.doesNotMatch(FX_STRINGS.ar.intro, /هذا التحديث|يحسب الحاسب/);
  assert.doesNotMatch(FX_STRINGS.en.intro, /this update/);
  assert.doesNotMatch(FX_STRINGS.ckb.intro, /لەم نوێکردنەوەیەدا/);
  assert.match(FX_STRINGS.ar.intro, /لا يغيّر أسعار المنتجات حاليًا/);
  assert.match(FX_STRINGS.en.intro, /does not change product prices for now/);
});

// ------------------------------------------------------------- #13 what «تأكيد السعر الحالي» does

test('UX #13: what «تأكيد السعر الحالي» does — and that it asks for a fresh sign-in — is on screen, not in a tooltip', () => {
  for (const lang of LANGS) {
    const html = card(pairOf(), lang); // effective 1,675 ≠ the anchor 1,650
    assert.match(html, /data-fx-confirm-current/);
    assert.match(html, /data-fx-confirm-hint/);
    assert.ok(textOf(html).includes(FX_STRINGS[lang].confirmCurrentHint), lang);
    assert.doesNotMatch(html, new RegExp(`title="${FX_STRINGS[lang].confirmCurrentHint.slice(0, 10)}`));
  }
});

// ------------------------------------------------------------- #14 one verb

test('UX #14: the rate the owner last confirmed is said with the verb of «تأكيد السعر الحالي» — not «اعتمد», which names the rate in force', () => {
  assert.equal(FX_STRINGS.ar.anchor, 'آخر سعر أكّدته');
  assert.match(FX_STRINGS.ar.drift, /آخر سعر أكّدته/);
  assert.match(FX_STRINGS.ar.reasons.DRIFT('6', '24'), /آخر سعر أكّدته/);
  assert.doesNotMatch(FX_STRINGS.ar.anchor, /اعتمد/);
  assert.match(FX_STRINGS.ckb.anchor, /پشتڕاستت کردەوە/);
  assert.match(FX_STRINGS.ckb.confirmCurrent, /پشتڕاست/);
});

// ------------------------------------------------------------- #15 the smaller items

test('UX #15: one line for a pair nothing has reached; who sets the key; whole dinars for the customer; the first-value body; Sorani word order; a 44px link', () => {
  for (const lang of LANGS) {
    const s = FX_STRINGS[lang];
    const fresh = card(pairOf({ effective_rate: null, market_rate: null, market_buy: null, official_rate: null, last_known_good_rate: null, drift_anchor_rate: null, effective_applied_at: null, published_at: null, last_checked_at: null, last_check_result: null, status: 'NOT_CONFIGURED', fetch_status: 'NOT_CONFIGURED' }), lang);
    assert.match(fresh, /data-fx-not-set-up/);
    assert.doesNotMatch(fresh, /data-fx-facts/);
    assert.ok(textOf(fresh).split(s.unknown).length - 1 <= 1, `${lang}: «${s.unknown}» repeated`);
    assert.match(s.keyMissing, /Cloudflare/, `${lang}: who sets the key`);
    assert.notEqual(s.reviewFirstBody, s.reviewFirst);
  }
  assert.match(codeOf(`${DIR}/FxReviewSheet.tsx`), /\? s\.reviewFirstBody\s*\n\s*: s\.reviewBody/);
  assert.equal(wholeRateText('1703.9167'), '1,704');
  assert.equal(wholeRateText('1400'), '1,400');
  assert.match(FX_STRINGS.ckb.rejectedRecently('1,735', 'D', '24'), /^نرخی 1,735 لە D ڕەتت کردەوە/);
  assert.match(card(pairOf()), /class="inline-flex min-h-\[44px\] items-center[^"]*"[^>]*data-fx-attribution-link/);
});

// ------------------------------------------------------------- correctness #6: wallet figures

test('correctness #6: a wallet refund, a wallet payment and a price-protection credit read at the wallet\'s rate, never the market\'s (Q5)', () => {
  const approval = codeOf('src/components/orders/PriceApprovalCard.tsx');
  assert.doesNotMatch(approval, /[^t]money\(pending\.wallet_refund_iqd\)/);
  assert.match(approval, /walletMoney\(pending\.wallet_refund_iqd\)/);
  const breakdown = codeOf('src/components/orders/PaymentBreakdown.tsx');
  assert.match(breakdown, /value=\{walletMoney\(f\.wallet_applied_iqd\)\}/);
  const protection = codeOf('src/components/orders/PriceProtection.tsx');
  assert.match(protection, /\$\{walletMoney\(c\.credited_iqd\)\}/);
  assert.doesNotMatch(protection, /[^t]money\(c\.credited_iqd\)/);
});
