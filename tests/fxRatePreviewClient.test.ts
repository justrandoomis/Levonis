/**
 * FX-5 — THE PREVIEW SHEET BEFORE AN OWNER RATE ACT, ON THE OWNER'S PANEL
 * (FX programme plan §7.8, §8, §12).
 *
 * Rendered with react-dom/server where it renders without a request (the
 * preview body), read from the source where the behaviour is wiring (which
 * act previews first, the hash it carries, the fresh preview a 409 brings).
 *
 * Run: node --import tsx --test tests/fxRatePreviewClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codeOf } from './fixtures/source';
import { LanguageProvider } from '../src/LanguageContext';
import { RatePreviewBody } from '../src/components/adminPricing/RatePreview';
import { FX_STRINGS } from '../src/components/adminPricing/fxStrings';
import { previewOfRefusal, type FxRatePreview } from '../src/components/adminPricing/api';

const DIR = 'src/components/adminPricing';
const LANGS = ['ar', 'en', 'ckb'] as const;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const names = (ar: string, en: string, ckb: string) => ({ name_ar: ar, name_en: en, name_ckb: ckb });
const model = (ar: string, en: string, ckb: string) => ({ model_ar: ar, model_en: en, model_ckb: ckb });

const PREVIEW: FxRatePreview = {
  act: { kind: 'manual', pair: 'USD_IQD', profile: null, effective_before: '1600', effective_after: '1700' },
  engine_products: 3,
  affected: { products: 3, models: 3 },
  changed_products: 2,
  rows: [
    {
      product_id: 'p_big',
      ...names('طابعة كبيرة', 'Big printer', 'چاپکەری گەورە'),
      option_id: 'p_big_o0',
      ...model('أساسي', 'Base', 'بنەڕەتی'),
      channel: 'pre_order_land',
      today_prepaid_iqd: 1_500_000,
      computed_price_iqd: 1_598_000,
      change_iqd: 98_000,
      change_pct: '6.53',
      deficit_iqd: 97_200,
      large: false,
      drop_flag: false,
    },
    {
      product_id: 'p_big',
      ...names('طابعة كبيرة', 'Big printer', 'چاپکەری گەورە'),
      option_id: 'p_big_o0',
      ...model('أساسي', 'Base', 'بنەڕەتی'),
      channel: 'direct_sale',
      today_prepaid_iqd: 1_550_000,
      computed_price_iqd: 1_648_000,
      change_iqd: 98_000,
      change_pct: '6.32',
      deficit_iqd: -2_800,
      large: false,
      drop_flag: false,
    },
    {
      product_id: 'p_small',
      ...names('بكرة', 'Spool', 'بکرە'),
      option_id: 'p_small_o0',
      ...model('', '', ''),
      channel: 'pre_order_air',
      today_prepaid_iqd: 40_000,
      computed_price_iqd: 47_000,
      change_iqd: 7_000,
      change_pct: '17.5',
      deficit_iqd: 6_400,
      large: true,
      drop_flag: false,
    },
  ],
  blocked: [{ product_id: 'p_blocked', ...names('محجوب', 'Blocked one', 'ڕاگیراو'), code: 'TARGET_PROFIT_MISSING' }],
  follows: 4,
  large_change: true,
  drop_flag: false,
  fresh_sign_in: false,
  preview_hash: 'a'.repeat(64),
};

test('the preview body: the act from → to, the counts, each product in the server’s order with today → new per model × channel, the deficit only when today lies below, the flags, the blocked codes and the 15-minute tail — in ar, en and Sorani', () => {
  for (const lang of LANGS) {
    const s = FX_STRINGS[lang];
    const html = render(createElement(RatePreviewBody, { preview: PREVIEW, label: s.pairName.USD_IQD, lang, s }));
    const text = textOf(html);
    // Products in the server's order (largest deficit first), never re-sorted here.
    const order = [...html.matchAll(/data-fx-preview-product="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['p_big', 'p_small'], lang);
    assert.equal([...html.matchAll(/data-fx-preview-row=/g)].length, 3, lang);
    // The figures are the server's, in Latin digits (UX review #1).
    assert.match(text, /1,500,000/);
    assert.match(text, /1,598,000/);
    assert.match(text, /47,000/);
    assert.doesNotMatch(text, /[٠-٩]/, `${lang}: Arabic-Indic digits`);
    // The act line names the pair and both rates.
    assert.ok(text.includes(s.previewAct(s.pairName.USD_IQD, '', '').split(':')[0]!), lang);
    assert.match(text, /1,600/);
    assert.match(text, /1,700/);
    // The deficit: said for the two rows below the new floor, not for the one above it.
    assert.equal([...html.matchAll(/data-fx-preview-deficit/g)].length, 2, lang);
    assert.match(text, /97,200/);
    assert.doesNotMatch(text, /2,800/);
    // The flags, the blocked product (a code, never a figure), the tail.
    assert.match(html, /data-fx-preview-large/);
    assert.doesNotMatch(html, /data-fx-preview-drop/);
    assert.match(html, /data-fx-preview-blocked-code="TARGET_PROFIT_MISSING"/);
    assert.ok(text.includes(s.previewBlockedTitle), lang);
    assert.match(html, /data-fx-preview-follows="4"/);
    assert.ok(text.includes(s.previewFollows('4', '15')), lang);
    assert.ok(text.includes(s.previewSummary('3', '3')), lang);
  }
  // Nothing to reprice: one sentence, no list.
  const none = render(
    createElement(RatePreviewBody, {
      preview: { ...PREVIEW, affected: { products: 0, models: 0 }, rows: [], blocked: [], follows: 0, large_change: false },
      label: FX_STRINGS.ar.pairName.USD_IQD,
      lang: 'ar',
      s: FX_STRINGS.ar,
    })
  );
  assert.ok(textOf(none).includes(FX_STRINGS.ar.previewNone));
  assert.doesNotMatch(none, /data-fx-preview-rows|data-fx-preview-flags|data-fx-preview-follows/);
});

test('a 409 PRICING_PREVIEW_STALE / _REQUIRED carries the fresh preview under details.preview; anything else is not one', () => {
  assert.equal(previewOfRefusal({ preview: PREVIEW })?.preview_hash, PREVIEW.preview_hash);
  assert.equal(previewOfRefusal(undefined), null);
  assert.equal(previewOfRefusal({ preview: { rows: [] } }), null);
  assert.equal(previewOfRefusal({ missing_codes: [] }), null);
});

test('wiring: once a product is engine-priced, a manual rate, «استخدم … سعرًا يدويًا», the adjustment and a shipping rate are previewed first and applied with the hash; approving a held rate shows its preview and carries its hash', () => {
  const card = codeOf(`${DIR}/FxPairCard.tsx`);
  assert.match(card, /const previewed = rates\.engine_products > 0 && !!onPreviewAct;/);
  assert.match(card, /load: \(\) => previewFxManual\(p\.pair, \{ rate \}\),\s*commit: \(preview_hash, confirm\) => setFxManual\(p\.pair, \{ \.\.\.base, rate, preview_hash, \.\.\.confirmOf\(confirm\) \}\)/);
  assert.match(card, /load: \(\) => previewFxManual\(p\.pair, \{ market_adjustment_iqd: adj \}\),\s*commit: \(preview_hash, confirm\) => saveFxSettings\(p\.pair, \{ \.\.\.base, market_adjustment_iqd: adj, preview_hash/);
  assert.match(card, /onClick=\{\(\) => applyObserved\(p\.last_observed!\.candidate\)\}/);
  const ship = codeOf(`${DIR}/ShippingRatesCard.tsx`);
  assert.match(ship, /onPreviewAct=\{engineProducts > 0 \? onPreviewAct : undefined\}/);
  assert.match(ship, /load: \(\) => previewShippingRate\(row\.profile, rate_iqd\)/);
  assert.match(ship, /saveShippingRate\(row\.profile, \{ version: row\.version, rate_iqd, preview_hash/);
  const review = codeOf(`${DIR}/FxReviewSheet.tsx`);
  assert.match(review, /previewFxReview\(p\.pair\)/);
  assert.match(review, /decision === 'approve' && preview \? \{ preview_hash: preview\.preview_hash \} : \{\}/);
  assert.match(review, /const fresh = e instanceof ApiError \? previewOfRefusal\(e\.details\) : null;\s*if \(fresh\) setPreview\(fresh\);/);
  assert.match(review, /<RatePreviewBody preview=\{preview\}/);
  const panel = codeOf(`${DIR}/RatesPanel.tsx`);
  assert.match(panel, /<RatePreviewSheet request=\{actRequest\}/);
  assert.match(panel, /onPreviewAct=\{setActRequest\}/);
  assert.match(panel, /engineProducts=\{data\?\.engine_products \?\? 0\}/);
  const sheet = codeOf(`${DIR}/RatePreview.tsx`);
  // The fresh preview replaces the stale one, read before applying again; the 15% tick before the act.
  assert.match(sheet, /\(code === 'PRICING_PREVIEW_STALE' \|\| code === 'PRICING_PREVIEW_REQUIRED'\) && fresh\) \{\s*setPreview\(fresh\);/);
  assert.match(sheet, /disabled=\{needsTick && !confirmLarge\}/);
  assert.match(sheet, /request\.commit\(preview\.preview_hash, confirmLarge \|\| rateConfirm\)/);
  // The fresh sign-in is said before the act, with the way through.
  assert.match(sheet, /preview\.fresh_sign_in \?/);
  assert.match(sheet, /data-fx-preview-sign-in/);
  // No browser storage, no rate computed here.
  for (const f of ['RatePreview.tsx', 'FxReviewSheet.tsx', 'ShippingRatesCard.tsx', 'FxPairCard.tsx']) {
    const src = codeOf(`${DIR}/${f}`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/, f);
    assert.doesNotMatch(src, /from\s+['"][^'"]*(fxChain|costToPrice|pricingEngine)[^'"]*['"]/, f);
  }
});

test('the client speaks to the three preview routes the server serves', () => {
  const api = codeOf(`${DIR}/api.ts`);
  assert.match(api, /`\$\{PRICING_API\}\/rates\/fx\/\$\{encodeURIComponent\(pair\)\}\/review\/preview`/);
  assert.match(api, /`\$\{PRICING_API\}\/rates\/fx\/\$\{encodeURIComponent\(pair\)\}\/manual\/preview`/);
  assert.match(api, /`\$\{PRICING_API\}\/rates\/shipping\/\$\{encodeURIComponent\(profile\)\}\/preview`, \{ rate_iqd \}/);
  const server = codeOf('worker/routes/adminPricing.ts');
  for (const route of ["'/rates/fx/:pair/review/preview'", "'/rates/fx/:pair/manual/preview'", "'/rates/shipping/:profile/preview'"]) assert.ok(server.includes(`adminPricingRoutes.post(${route}`), route);
});

test('the preview’s words: every new string in ar, en and real Sorani, no digit baked in', () => {
  const keys = [
    'previewTitle', 'previewLoading', 'previewAct', 'previewSummary', 'previewNone', 'previewLarge', 'previewLargeConfirm', 'previewDrop',
    'previewToday', 'previewNew', 'previewBelowFloor', 'previewBlockedTitle', 'previewFollows', 'previewApply', 'previewStale', 'adjustmentLabel',
  ] as const;
  const text = (lang: (typeof LANGS)[number], k: (typeof keys)[number]) => {
    const v = FX_STRINGS[lang][k] as unknown;
    return typeof v === 'function' ? (v as (...a: string[]) => string)('N', 'M', 'K') : String(v);
  };
  for (const k of keys) {
    for (const lang of LANGS) assert.doesNotMatch(text(lang, k), /[0-9٠-٩۰-۹]/, `${lang} ${k}`);
    assert.notEqual(text('ckb', k), text('ar', k), k);
    assert.match(text('ckb', k), /[ڕڵێۆەڤ]/, `${k}: Sorani`);
    assert.doesNotMatch(text('ckb', k), /[ةىيك]/, `${k}: an Arabic-only letter in the Sorani`);
    assert.doesNotMatch(text('en', k), /[؀-ۿ]/, k);
  }
  assert.equal(FX_STRINGS.ar.previewTitle, 'قبل التطبيق: ما الذي سيتغيّر');
  assert.equal(FX_STRINGS.ar.previewFollows('3', '15'), 'و3 منتجًا آخر خلال 15 دقيقة');
});
