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
import { PRICING_UI_STRINGS, readWhole } from '../src/components/adminPricing/strings';
import PricingProducts from '../src/components/adminPricing/PricingProducts';
import { ModelSection } from '../src/components/adminPricing/ProductPricingSheet';
import type { PricingModel, PricingOverview, PricingProductSummary } from '../src/components/adminPricing/api';

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
  assert.ok(panel > 0 && panel < root.indexOf('<PreviewBanner') && panel < root.indexOf('<PricingProducts'), 'the rates panel is not the first section');
  assert.match(root, /\{!productId && <RatesPanel lang=\{lang\} dir=\{dir\} \/>\}/);
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
    'get ${PRICING_API}/overview?page=${Math.max(1, Math.floor(page))}',
    'get ${PRICING_API}/products/${encodeURIComponent(id)}',
    // FX-1 (plan §8): the owner's exchange and shipping rates.
    'get ${PRICING_API}/rates',
    'get ${PRICING_API}/rates/history?${p.toString()}',
    'post ${PRICING_API}/products/${encodeURIComponent(id)}/what-if',
    'post ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/confirm',
    'post ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/review',
    'post ${PRICING_API}/rates/fx/refresh',
    'put ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/manual',
    'put ${PRICING_API}/rates/fx/${encodeURIComponent(pair)}/settings',
    'put ${PRICING_API}/rates/shipping/${encodeURIComponent(profile)}',
  ].sort());
  // The one write that is not a rate is none: the product preview still writes nothing.
  for (const [, method, path] of api.matchAll(/api\.(put|patch|delete|post)<[^>]+>\(`([^`]+)`/g)) {
    if (method === 'post' && path!.endsWith('/what-if')) continue;
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
  // Both the list and the product page route their failures through it.
  assert.match(codeOf(`${DIR}/AdminPricing.tsx`), /<PricingFailure error=\{error\}/);
  assert.match(codeOf(`${DIR}/ProductPricingSheet.tsx`), /<PricingFailure error=\{error\}/);
});

test('the preview banner comes first, in the contract’s own words', () => {
  const root = codeOf(`${DIR}/AdminPricing.tsx`);
  const banner = root.indexOf('<PreviewBanner');
  assert.ok(banner > 0, 'no preview banner');
  assert.ok(banner < root.indexOf('<ProductPricingSheet') && banner < root.indexOf('<PricingProducts'), 'the banner is not above the content');
  assert.match(codeOf(`${DIR}/parts.tsx`), /previewOnlyText\(lang\)/);
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
  const panel = codeOf(`${DIR}/WhatIfPanel.tsx`);
  assert.match(panel, /<Money iqd=\{c\.computed_price_iqd\} \/>/);
  assert.match(panel, /<ChangeLine change=\{c\.change_iqd\}/);
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

test('Calculate shows it is working while the server answers, and refuses more presses (review finding 2)', () => {
  const panel = codeOf(`${DIR}/WhatIfPanel.tsx`);
  assert.match(panel, /const \[busy, setBusy\] = useState\(false\);/);
  assert.match(panel, /<Button type="submit" variant="primary" loading=\{busy\} loadingLabel=\{s\.calculating\}/);
  // Busy from just before the request until it settles — cleared only by the request still being asked.
  const submit = panel.slice(panel.indexOf('const submit = async'), panel.indexOf('const clear = ()'));
  assert.match(submit, /if \(busy\) return;/);
  assert.ok(submit.indexOf('setBusy(true)') < submit.indexOf('await runPricingWhatIf('), 'busy is set before the request');
  assert.match(submit, /finally \{[\s\S]*if \(controller\.current === ac\) setBusy\(false\);/);
  assert.match(panel.slice(panel.indexOf('const clear = ()')), /setBusy\(false\);/);
});

test('touch targets: every disclosure on the pricing screens is at least 44px (review finding 14)', () => {
  for (const file of [`${DIR}/WhatIfPanel.tsx`, `${DIR}/ProductPricingSheet.tsx`]) {
    const code = codeOf(file);
    const summaries = [...code.matchAll(/<summary className="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(summaries.length > 0, file);
    for (const cls of summaries) {
      const h = /min-h-\[(\d+)px\]/.exec(cls);
      assert.ok(h && Number(h[1]) >= 44, `${file}: a summary under 44px («${cls}»)`);
    }
  }
  // The «not confirmed» chip never squeezes onto two lines beside its sentence.
  assert.match(codeOf(`${DIR}/WhatIfPanel.tsx`), /<StatusChip tone="warning" className="shrink-0">\{s\.notConfirmed\}<\/StatusChip>/);
});

test('the owner is told the decisions are made in the next update, under «ما يحتاج قرارك» (review finding 13)', () => {
  const sheet = codeOf(`${DIR}/ProductPricingSheet.tsx`);
  const decision = sheet.slice(sheet.indexOf('data-pricing-decision'), sheet.indexOf('{s.nothingHeld}'));
  assert.ok(decision.indexOf('{s.decisionLater}') > 0 && decision.indexOf('{s.decisionLater}') < decision.indexOf('<ReasonList items={holding}'));
  assert.match(PRICING_UI_STRINGS.en.decisionLater, /next update/);
});

// ------------------------------------------------------------- rendered

/** Arabic system digits, as an Arabic phone writes every dinar (`Money`, toLocaleString()). */
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

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

// Names and slugs without digits, so every digit on the rendered list is a count the screen wrote.
const product = (i: number, over: Partial<PricingProductSummary> = {}): PricingProductSummary => ({
  id: `lp_${i}`,
  slug: `p-${'xabc'[i]}`,
  name_ar: `منتج ${'_أبج'[i]}`,
  name_en: `Product ${'XABC'[i]}`,
  name_ckb: `بەرهەمی ${'_ئبپ'[i]}`,
  status: 'active',
  migration_status: 'WAITING_FOR_SUPPLIER_COST',
  reason_codes: [],
  info_codes: [],
  channel_mix: 'BOTH',
  routes: ['land'],
  model_count: 5,
  typed_member_prices: false,
  ...over,
});

function renderList(lang: 'ar' | 'en' | 'ckb') {
  const products = [product(1), product(2, { migration_status: 'TARGET_PROFIT_REVIEW_REQUIRED' })];
  const overview: PricingOverview = {
    success: true,
    preview_only: true,
    page: 1,
    page_size: 20,
    pages: 1,
    total: 41,
    status_counts: [
      { migration_status: 'TARGET_PROFIT_REVIEW_REQUIRED', count: 26 },
      { migration_status: 'WAITING_FOR_SUPPLIER_COST', count: 15 },
    ],
    typed_member_price_products: 0,
    products,
  };
  return render(
    createElement(PricingProducts, {
      overview,
      products,
      truncatedAt: null,
      query: '',
      onQuery: () => {},
      filter: 'all',
      onFilter: () => {},
      onOpen: () => {},
      lang,
      dir: lang === 'en' ? 'ltr' : 'rtl',
      s: PRICING_UI_STRINGS[lang],
    })
  );
}

test('the product list: a search or filter announces a count, not every row; one clear button; counts in the screen’s digits (review findings 8, 9, 10)', () => {
  const en = renderList('en');
  // 8: the list is no live region; one short sentence says how many are shown.
  assert.doesNotMatch(en, /aria-live/);
  assert.match(en, /<p role="status" class="sr-only" data-pricing-shown-count="true">Products shown: 2<\/p>/);
  // 9: the browser's own clear button is hidden; ours is the only one.
  assert.match(en, /<input id="pricing-search" type="search"[^>]*class="[^"]*\[&amp;::-webkit-search-cancel-button\]:hidden/);
  // 10: on an Arabic system every count is in Arabic-Indic digits, like every dinar on the screen.
  const ar = withArabicDigits(() => renderList('ar'));
  const text = textOf(ar);
  assert.equal(withArabicDigits(() => readWhole(41, 'ar')), '٤١');
  for (const want of ['عدد المنتجات: ٤١', 'الموديلات: ٥', 'المنتجات المعروضة: ٢']) assert.ok(text.includes(want), `missing «${want}» in ${text}`);
  for (const n of ['٤١', '٢٦', '١٥']) assert.match(ar, new RegExp(`>${n}</span>`), `badge ${n}`);
  assert.doesNotMatch(text, /[0-9]/, `a Latin digit on the Arabic list: ${text}`);
});

const pricingModel = (over: Partial<PricingModel> = {}): PricingModel => ({
  option_id: 'lp_01_o2',
  name_ar: 'موديل 3',
  name_en: 'Model 3',
  name_ckb: 'مۆدێلی 3',
  channel_mix: 'BOTH',
  base_route: 'air',
  channels: [
    {
      channel: 'pre_order_air',
      route: 'air',
      today_item_iqd: null,
      today_fee_iqd: null,
      today_prepaid_iqd: null,
      today_cod_iqd: null,
      cod_priced_as_direct: false,
      landed_cost_iqd: null,
      price_rung: null,
      cost_rung: null,
      resolver_errors: ['OPTION_INACTIVE', 'TRANSPORT_DISABLED'],
    },
  ],
  target: { migration_state: 'MIGRATED', target_profit_iqd: 47_000, reason_codes: [], reason_figures: [], candidates: [] },
  direct_sale_extra: { migration_state: 'DIRECT_SALE_EXTRA_REVIEW_REQUIRED', direct_sale_extra_iqd: null, reason_codes: ['LEGACY_DIRECT_BELOW_PREORDER'], reason_figures: [], candidates: [] },
  roundtrip_ok: null,
  suggested_measures: {
    shipping_weight_g: null,
    weight_scope: null,
    shipping_length_mm: null,
    shipping_width_mm: null,
    shipping_height_mm: null,
    box_scope: null,
    calculated_cbm: null,
  },
  missing: [],
  ...over,
} as PricingModel);

test('a collapsed model says its state at every width — on a phone under its name — and an unpriced channel shows words, never resolver codes (review findings 3, 12)', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = PRICING_UI_STRINGS[lang];
    const html = render(createElement(ModelSection, { model: pricingModel(), lang, s, defaultOpen: false, single: false }));
    // 3: one chip for phones (shown below sm), one for wide screens (shown from sm) — never a width with none.
    const narrow = /<span class="([^"]*)" data-model-state="narrow">([\s\S]*?)<\/span><\/span>/.exec(html);
    const wide = /<span class="([^"]*)" data-model-state="wide">/.exec(html);
    assert.ok(narrow && wide, lang);
    assert.match(narrow![1]!, /\bsm:hidden\b/);
    assert.doesNotMatch(narrow![1]!, /(^|\s)hidden(\s|$)/, 'the phone chip is not hidden on a phone');
    assert.match(wide![1]!, /(^|\s)hidden(\s|$)/);
    assert.match(wide![1]!, /\bsm:inline-flex\b/);
    assert.match(narrow![2]!, /data-status-chip=/);
    // 12: the sentence, not the machine codes.
    assert.ok(textOf(html).includes(s.channelUnpriced), lang);
    assert.doesNotMatch(html, /OPTION_INACTIVE|TRANSPORT_DISABLED/, lang);
  }
});

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
  assert.match(review, /reviewFxRate\(p\.pair, \{ owner_version: p\.owner_version, decision, /);
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
