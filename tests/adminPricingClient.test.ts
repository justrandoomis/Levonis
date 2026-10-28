/**
 * «التسعير والشحن» P1 — THE CLIENT (MVP plan §6 P1; owner decision 2; S1's
 * client-hint pattern).
 *
 *   - the tab is the owner's: the sidebar entry and the tab body need
 *     `can_write_cost === true` (fail-closed); the owner before the address is
 *     verified keeps the entry and meets OwnerCostVerifyCard, never the screen;
 *   - the screen is its own lazy chunk, imported nowhere else;
 *   - it speaks to /api/admin/pricing alone — two GETs and the what-if POST —
 *     and keeps nothing in browser storage;
 *   - a refusal is said by code: OWNER_EMAIL_UNVERIFIED opens the card;
 *   - the preview banner is the first thing on the screen;
 *   - the what-if request carries every decimal as TEXT (never a float), reads
 *     the digits people in Iraq type, and refuses a half box before sending.
 *
 * Run: node --import tsx --test tests/adminPricingClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { codeOf } from './fixtures/source';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import { buildRequest, decimalOf, emptyDraft, isDecimalComma, wholeOf } from '../src/components/adminPricing/whatIfRequest';
import { PRICING_UI_STRINGS } from '../src/components/adminPricing/strings';

const DIR = 'src/components/adminPricing';
const files = readdirSync(join(ROOT, DIR)).map((f) => `${DIR}/${f}`);

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) srcFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}

test('the tab is the owner’s: can_write_cost === true for the entry and the body; the unverified owner gets the card', () => {
  const admin = codeOf('src/pages/Admin.tsx');
  assert.match(admin, /const canSeePricing = user\?\.can_write_cost === true;/);
  assert.match(admin, /const pricingMustVerify = !canSeePricing && user\?\.owner_email_unverified === true;/);
  assert.match(admin, /\.\.\.\(canSeePricing \|\| pricingMustVerify\s*\?\s*\[\{ id: 'pricing'/);
  assert.match(admin, /activeTab === 'pricing' && canSeePricing && <AdminPricing \/>/);
  assert.match(admin, /activeTab === 'pricing' && pricingMustVerify && <OwnerCostVerifyCard \/>/);
  // Lazy: its own chunk, never in a customer's first byte.
  assert.match(admin, /const AdminPricing = React\.lazy\(\(\) => import\('\.\.\/components\/adminPricing\/AdminPricing'\)\);/);
  for (const file of srcFiles(join(ROOT, 'src'))) {
    if (file === 'src/pages/Admin.tsx' || file.startsWith(DIR)) continue;
    // FX-1: the owner's dashboard card reads the rates route, the panel's own
    // words and its formatter — never a component of the tab.
    if (file === 'src/components/admin/OwnerRatesCard.tsx') {
      const reached = [...codeOf(file).matchAll(/from '\.\.\/adminPricing\/([^']+)'/g)].map((m) => m[1]).sort();
      assert.deepEqual(reached, ['api', 'format', 'fxStrings'], `${file} reaches further into the pricing screen`);
      continue;
    }
    assert.doesNotMatch(codeOf(file), /adminPricing\//, `${file} reaches into the pricing screen`);
  }
});

test('FX-1: the exchange-rate panel is the tab’s first section, in its chunk; the dashboard card is the owner’s alone, lazily', () => {
  const root = codeOf(`${DIR}/AdminPricing.tsx`);
  assert.match(root, /import RatesPanel from '\.\/RatesPanel';/);
  const panel = root.indexOf('<RatesPanel');
  assert.ok(panel > 0 && panel < root.indexOf('data-pricing-v2-card'), 'the rates panel is not the first section');
  assert.match(root, /<RatesPanel lang=\{rawLang\} dir=\{dir\}[^>]* \/>/);
  // Nothing outside the tab imports the panel or its cards.
  for (const file of srcFiles(join(ROOT, 'src'))) {
    if (file.startsWith(DIR)) continue;
    assert.doesNotMatch(codeOf(file), /RatesPanel|FxPairCard|FxReviewSheet|FxHistorySheet|ShippingRatesCard/, `${file} mounts the owner's FX panel`);
  }
  // The overview: its own chunk, behind the same fail-closed hint as the tab.
  const overview = codeOf('src/components/AdminOverview.tsx');
  assert.match(overview, /const OwnerRatesCard = React\.lazy\(\(\) => import\('\.\/admin\/OwnerRatesCard'\)\);/);
  assert.match(overview, /const canSeeRates = user\?\.can_write_cost === true;/);
  assert.match(overview, /\{canSeeRates && \(\s*<React\.Suspense fallback=\{null\}>\s*<OwnerRatesCard /);
  assert.equal((overview.match(/<OwnerRatesCard\b/g) ?? []).length, 1);
  // A refusal or an older database shows nothing — never a dead end on the first screen.
  assert.match(codeOf('src/components/admin/OwnerRatesCard.tsx'), /if \(failed\) return null;/);
});

test('it speaks to /api/admin/pricing alone — the preview’s three, the owner’s rates routes — and stores nothing in the browser', () => {
  const api = codeOf(`${DIR}/api.ts`);
  assert.match(api, /export const PRICING_API = '\/api\/admin\/pricing';/);
  const calls = [...api.matchAll(/api\.(get|post|put|patch|delete)<[^>]+>\(`([^`]+)`/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(calls.sort(), [
    // The clean start (addendum A.6/A.8): the V2 counts only — no V1 overview, product sheet, what-if or stale list.
    'get ${PRICING_API}/overview',
    // FX-1 (plan §8): the owner's exchange and shipping rates.
    'get ${PRICING_API}/rates',
    'get ${PRICING_API}/rates/history?${p.toString()}',
    'post ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/confirm',
    'post ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/review',
    'post ${PRICING_API}/rates/fx/refresh',
    'put ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/manual',
    'put ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/settings',
    'put ${PRICING_API}/rates/shipping/${encodeURIComponent(profile)}',
    // FX-5 (plan §7.8, §8): the preview before an owner rate act — reads only.
    'post ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/review/preview',
    'post ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/manual/preview',
    'post ${PRICING_API}/rates/shipping/${encodeURIComponent(profile)}/preview',
  ].sort());
  // Every write of this screen is a rates route.
  for (const [, method, path] of api.matchAll(/api\.(put|patch|delete|post)<[^>]+>\(`([^`]+)`/g)) {
    assert.match(path!, /^\$\{PRICING_API\}\/rates\//, `a write outside the rates routes: ${method} ${path}`);
  }
  for (const file of [...files, 'src/components/admin/OwnerRatesCard.tsx']) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /\b(localStorage|sessionStorage|indexedDB)\b/, `${file}: cost data must not persist in the browser`);
    if (file !== `${DIR}/api.ts`) {
      assert.doesNotMatch(code, /\bapi\.(get|post|put|patch|delete)\b/, `${file}: a request outside api.ts`);
      assert.doesNotMatch(code, /['"`]\/api\//, `${file}: a request outside api.ts`);
    }
    assert.doesNotMatch(code, /parseFloat\(|Number\(\s*(p|pair|row|pending)\.[a-z_]*rate/, `${file}: no float parsing near money or a rate`);
  }
});

test('a refusal is said by code: OWNER_EMAIL_UNVERIFIED opens the verification card', () => {
  const parts = codeOf(`${DIR}/parts.tsx`);
  assert.match(parts, /error instanceof ApiError && error\.code === 'OWNER_EMAIL_UNVERIFIED'\) return <OwnerCostVerifyCard \/>;/);
  assert.match(parts, /apiRefusal\(error, lang, fallback\)/);
  // The V2 card routes its failures through it.
  assert.match(codeOf(`${DIR}/AdminPricing.tsx`), /<PricingFailure error=\{error\}/);
});

test('the clean start: the screen is the rates and the V2 card — counts and the door to the «يحتاج تسعيرًا» queue, no V1 sheet', () => {
  const root = codeOf(`${DIR}/AdminPricing.tsx`);
  assert.match(root, /data-pricing-v2-card/);
  assert.match(root, /fetchPricingV2Counts\(/);
  assert.match(root, /view', 'needs-pricing'/);
  assert.doesNotMatch(root, /PricingProducts|ProductPricingSheet|EngineSaveList|WhatIfPanel/);
  for (const gone of ['PricingProducts.tsx', 'ProductPricingSheet.tsx', 'EngineSaveList.tsx', 'WhatIfPanel.tsx']) {
    assert.ok(!files.includes(`${DIR}/${gone}`), `${gone} is deleted with the V1 doors`);
  }
});

test('the what-if request: decimals as text, Iraqi digits read, a half box refused, nothing sent on an error', () => {
  const s = PRICING_UI_STRINGS.en;
  const d = emptyDraft('EUR');
  d.cost = '١٢٬٥٠٠٫٧٥';
  d.cbm = '0.024';
  d.weight = '۱۲۰۰';
  d.additional = '0';
  d.fx.EUR = '1610.25';
  d.shipping.CHINA_SEA = '350000';
  const { body, errors } = buildRequest(d, s);
  assert.deepEqual(errors, {});
  assert.deepEqual(body, {
    supplier_cost: '12500.75',
    currency: 'EUR',
    additional_cost_iqd: 0,
    measures: { weight_g: 1200, manual_cbm: '0.024' },
    rates: { fx: { EUR: '1610.25' }, shipping: { CHINA_SEA: '350000' } },
  });
  // Every decimal is a string on the wire; only whole units are numbers.
  assert.equal(typeof body!.supplier_cost, 'string');
  assert.equal(typeof body!.measures!.manual_cbm, 'string');
  assert.equal(typeof body!.rates!.fx!.EUR, 'string');
  // A digit string longer than a float holds survives byte for byte.
  assert.equal(decimalOf('123456789012.3456', 12, 4), '123456789012.3456');

  const bad = emptyDraft('USD');
  bad.cost = '0';
  bad.length = '400';
  bad.width = '300';
  const refused = buildRequest(bad, s);
  assert.equal(refused.body, null, 'nothing is sent while a field is wrong');
  assert.equal(refused.errors.cost, s.invalidCost);
  assert.equal(refused.errors.box, s.boxAllThree);

  assert.equal(decimalOf('12.34567', 12, 4), null, 'five decimals');
  assert.equal(decimalOf('-5', 12, 4), null);
  assert.equal(decimalOf('0.0000', 12, 4), null, 'zero is not a cost');
  assert.equal(wholeOf('12.5', 1), null, 'a decimal is not a whole number');
  assert.equal(wholeOf('0', 1), null);
  assert.equal(wholeOf('0', 0), 0);
});

test('the client never computes a price or a rate: no import of the engine or the FX chain anywhere in src/, and the panel shows the server’s figures', () => {
  for (const file of srcFiles(join(ROOT, 'src'))) {
    const code = codeOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // (packages/pricing has client-safe leaves — quantity, trade-in — that other screens use; the cost and FX maths are not among them.)
    assert.doesNotMatch(code, /from '[^']*(costToPrice|ruleResolution|legacyTargets|pricingEngine|fxChain)[^']*'/, `${file} imports pricing or FX maths`);
  }
  for (const file of files) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /costToPrice|ruleResolution|legacyTargets|pricingEngine|packages\/pricing|fxChain/, `${file} imports pricing maths`);
  }
});

// ------------------------------------------------------------- review fixes

test('a decimal comma is never read as a thousands separator: «420,5» is refused with a hint, «1,250» is 1250 (review findings M3 / UX 6)', () => {
  const s = PRICING_UI_STRINGS.en;
  // Refused — before: 4205, 42050, 125, 15, 2505.
  for (const raw of ['420,5', '420,50', '12,5', '1,5', '250،5', '0,5', '0,024', '1.250,75', '1,2,3', '12,50.5']) {
    assert.equal(decimalOf(raw, 12, 4), null, raw);
  }
  // Grouping that really groups thousands still reads, in every separator people in Iraq type.
  assert.equal(decimalOf('1,250', 12, 4), '1250');
  assert.equal(decimalOf('12,500.75', 12, 4), '12500.75');
  assert.equal(decimalOf('1 250 000', 12, 4), '1250000');
  assert.equal(decimalOf('١٢٬٥٠٠٫٧٥', 12, 4), '12500.75');
  assert.equal(decimalOf('12٬500', 12, 4), '12500');
  assert.equal(decimalOf('12.5', 12, 4), '12.5');
  assert.equal(decimalOf('١٢٫٥', 12, 4), '12.5');
  // Whole fields follow the same rule.
  assert.equal(wholeOf('1,5', 1), null);
  assert.equal(wholeOf('1,500', 1), 1500);
  // The hint says what to do when the comma was meant as a point, and only then.
  assert.equal(isDecimalComma('12,50', 12, 4), true);
  assert.equal(isDecimalComma('250،5', 12, 4), true);
  assert.equal(isDecimalComma('1,250', 12, 4), false, 'a real thousands separator is not a decimal comma');
  assert.equal(isDecimalComma('12,5,0', 12, 4), false);
  const d = emptyDraft('EUR');
  d.cost = '12,50';
  d.cbm = '0,024';
  d.fx.EUR = '1610,25';
  const r = buildRequest(d, s);
  assert.equal(r.body, null, 'nothing is sent');
  assert.deepEqual([r.errors.cost, r.errors.cbm, r.errors.fx], [s.decimalComma, s.decimalComma, s.decimalComma]);
  d.cost = 'abc';
  assert.equal(buildRequest(d, s).errors.cost, s.invalidCost);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.match(PRICING_UI_STRINGS[lang].decimalComma, /12\.5/);
});

// ------------------------------------------------------------- rendered

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

// ------------------------------------------------- FX-1: the pair card, rendered

import FxPairCard from '../src/components/adminPricing/FxPairCard';
import { FX_STRINGS } from '../src/components/adminPricing/fxStrings';
import type { FxPairDto, FxRatesAnswer } from '../src/components/adminPricing/api';

const usdPair = (over: Partial<FxPairDto> = {}): FxPairDto => ({
  pair: 'USD_IQD',
  provider: 'iqwealth',
  attribution: { text: 'IQWealth', url: 'https://iraqsm.com' },
  mode: 'AUTO',
  interval_hours: 6,
  market_rate: '1660',
  market_buy: '1655',
  official_rate: '1310',
  market_adjustment_iqd: '15',
  formula_holds: false,
  manual_rate: null,
  manual_base_rate: null,
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
  status: 'REVIEW_REQUIRED',
  fetch_status: 'OK',
  last_error_code: null,
  failing_since: null,
  pending: { market_rate: '1720', effective_rate: '1735', published_at: '2026-10-09T05:58:00.000Z', observed_at: '2026-10-09T06:00:00.000Z', reason: 'ANOMALY', change_pct: '3.5820' },
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

const ratesOf = (pairs: FxPairDto[], key = true): FxRatesAnswer => ({
  success: true,
  pairs,
  effective_rates_iqd: { USD: { rate_iqd: '1675', version: 3, updated_at: null } },
  shipping: [],
  key_configured: key,
  refresh_budget: { used_today: 1, limit: 40 },
  provider_budget: { USD_IQD: { used_today: 4, cap: 150 } },
  engine_products: 0,
  reprice_blocked: 0,
  stale_products: 0,
});

test('FX-1: the USD card says the source, the shop’s effective rate, the held value and the attribution — in ar, en and ckb, with no request', () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('the card fetched during render');
  }) as typeof fetch;
  try {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const s = FX_STRINGS[lang];
      const p = usdPair();
      const html = render(createElement(FxPairCard, { pair: p, rates: ratesOf([p]), lang, s, onAnswer: () => {}, onStale: () => {}, onReview: () => {} }));
      // The digits follow the system's number format (an earlier test pins Arabic-Indic); read them back as ASCII.
      const text = textOf(html).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\u066C/g, ',');
      for (const want of [s.pairName.USD_IQD, s.srcParallel, s.effective, s.st.REVIEW_REQUIRED, s.reviewTitle, s.reviewOpen, s.tracking, s.guards]) {
        assert.ok(text.includes(want), `${lang}: «${want}» missing`);
      }
      assert.ok(text.includes('1,675'), `${lang}: the effective rate`);
      assert.ok(text.includes('1,735'), `${lang}: the held rate`);
      assert.match(html, /<a href="https:\/\/iraqsm\.com" target="_blank" rel="noopener noreferrer"/);
      assert.ok(text.includes(s.attribution), `${lang}: the attribution`);
      assert.match(html, /data-fx-confirm-current/, 'the effective rate differs from the anchor: «تأكيد السعر الحالي» is offered');
    }
    // A missing key is said; MANUAL says automatic updates never change it and offers the observed value.
    const manual = usdPair({ mode: 'MANUAL', manual_rate: '1675', pending: null, status: 'OK', last_observed: { market_rate: '1700', candidate: '1715', observed_at: '2026-10-09T06:00:00.000Z' } });
    const html = render(createElement(FxPairCard, { pair: manual, rates: ratesOf([manual], false), lang: 'en', s: FX_STRINGS.en, onAnswer: () => {}, onStale: () => {}, onReview: () => {} }));
    const text = textOf(html);
    assert.ok(text.includes(FX_STRINGS.en.keyMissing));
    assert.ok(text.includes(FX_STRINGS.en.manualNote));
    assert.ok(text.includes('Use 1,715 as my manual rate'));
    assert.match(html, /data-fx-back-auto/);
    assert.doesNotMatch(html, /data-fx-pending/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FX-1: owner acts carry owner_version, decimals as text, and the large-change confirmation only when the owner gives it', () => {
  const card = codeOf(`${DIR}/FxPairCard.tsx`);
  assert.match(card, /const base = \{ owner_version: p\.owner_version \};/);
  assert.match(card, /setFxManual\(p\.pair, \{ \.\.\.base, rate, \.\.\.\(confirm_large_change \? \{ confirm_large_change: true \} : \{\}\) \}\)/);
  const review = codeOf(`${DIR}/FxReviewSheet.tsx`);
  assert.match(review, /reviewFxRate\(p\.pair, \{\s*owner_version: p\.owner_version,\s*decision,/);
  const parts = codeOf(`${DIR}/fxParts.tsx`);
  // Refused once for want of the confirmation → the message offers it; a stale panel reloads.
  assert.match(parts, /code === 'PRICING_LARGE_CHANGE_CONFIRM' && !confirmLarge/);
  assert.match(parts, /if \(code === 'PRICING_CHANGED'\) onStale\(\);/);
  assert.match(parts, /error\.code === 'REAUTH_REQUIRED'\) return s\.reauth;/);
  // The tracking is a choice, then «حفظ» — an arrow key never sends a request.
  assert.match(card, /onChange=\{\(id\) => setTracking\(id as Tracking\)\}/);
  // Inputs are read as people in Iraq type them and travel as text.
  const input = codeOf(`${DIR}/fxInput.ts`);
  assert.match(input, /import \{ decimalOf \} from '\.\/whatIfRequest';/);
});
