/**
 * «التسعير والشحن» P1 — THE CLIENT'S OWN WORDS (MVP plan §6 P1 tests;
 * docs/DECISIONS.md row 183).
 *
 *   - every string of src/components/adminPricing/strings.ts exists in ar, en
 *     and ckb with the same keys;
 *   - the ckb is real Sorani: never the Arabic or the English, at least one
 *     Sorani-only letter, none of the Arabic-only ones (ة ى ي ك);
 *   - the Arabic is Arabic script and the English carries none;
 *   - the minimum target profit is named as the owner named it (2026-10-07);
 *   - the formatting helpers never pass a decimal through a binary float, and
 *     a code no contract owns is shown as the code, never dropped.
 *
 * Run: node --import tsx --test tests/adminPricingStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICING_MIX_LABELS,
  PRICING_ROUTE_LABELS,
  PRICING_UI_STRINGS,
  changePercent,
  groupDecimal,
  groupWhole,
  nameOf,
  previewOnlyText,
  reasonText,
  reasonTone,
} from '../src/components/adminPricing/strings';
import { FX_STRINGS, fxEventLabel } from '../src/components/adminPricing/fxStrings';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import { PRICING_ISSUES } from '../packages/contracts/src/pricingIssues';
import { iqdUnit } from '../src/lib/money';
import { codeOf } from './fixtures/source';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Every value of one language, functions called with sample arguments. */
function flatten(table: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === 'string') out.set(key, value);
    else if (typeof value === 'function') out.set(key, String((value as (...a: unknown[]) => unknown)(7, 'EUR')));
    else assert.fail(`${key}: not a string or a function`);
  }
  return out;
}

test('every screen string exists in ar, en and ckb, with the same keys', () => {
  const ar = flatten(PRICING_UI_STRINGS.ar as unknown as Record<string, unknown>);
  const en = flatten(PRICING_UI_STRINGS.en as unknown as Record<string, unknown>);
  const ckb = flatten(PRICING_UI_STRINGS.ckb as unknown as Record<string, unknown>);
  assert.ok(ar.size >= 90, `only ${ar.size} strings`);
  assert.deepEqual([...en.keys()].sort(), [...ar.keys()].sort());
  assert.deepEqual([...ckb.keys()].sort(), [...ar.keys()].sort());
  for (const [key, value] of [...ar, ...en, ...ckb]) {
    assert.ok(value.trim().length > 0, `${key} is empty`);
    assert.equal(value, value.trim(), `${key} has stray whitespace`);
  }
});

test('the Sorani is its own: never the Arabic or the English, a Sorani letter, no Arabic-only letter', () => {
  const ar = flatten(PRICING_UI_STRINGS.ar as unknown as Record<string, unknown>);
  const en = flatten(PRICING_UI_STRINGS.en as unknown as Record<string, unknown>);
  const ckb = flatten(PRICING_UI_STRINGS.ckb as unknown as Record<string, unknown>);
  for (const [key, value] of ckb) {
    assert.notEqual(value, ar.get(key), `${key}: the Sorani slot carries the Arabic (row 183)`);
    assert.notEqual(value, en.get(key), `${key}: the Sorani slot carries the English`);
    assert.match(value, SORANI_ONLY, `${key}: no Sorani-only letter in «${value}»`);
    assert.doesNotMatch(value, ARABIC_ONLY, `${key}: an Arabic-only letter in the Sorani «${value}»`);
  }
  for (const [key, value] of ar) assert.match(value, ARABIC_SCRIPT, `${key}: the Arabic is not Arabic script`);
  for (const [key, value] of en) assert.doesNotMatch(value, ARABIC_SCRIPT, `${key}: Arabic script in the English`);
});

test('the sale-mix and route names follow the same rule', () => {
  for (const [key, label] of [...Object.entries(PRICING_MIX_LABELS), ...Object.entries(PRICING_ROUTE_LABELS)]) {
    assert.notEqual(label.ckb, label.ar, key);
    assert.notEqual(label.ckb, label.en, key);
    assert.match(label.ckb, SORANI_ONLY, key);
    assert.doesNotMatch(label.ckb, ARABIC_ONLY, key);
    assert.match(label.ar, ARABIC_SCRIPT, key);
  }
});

test('the minimum target profit is named as the owner named it, and the banner is the contract’s', () => {
  assert.equal(PRICING_UI_STRINGS.ar.minProfit, 'الحد الأدنى للربح');
  assert.equal(PRICING_UI_STRINGS.en.minProfit, 'Minimum target profit');
  assert.equal(PRICING_UI_STRINGS.ckb.minProfit, 'کەمترین قازانجی مەبەست');
  assert.equal(previewOnlyText('ar'), 'معاينة فقط — لا يتغير شيء في المتجر.');
  assert.equal(previewOnlyText('en'), 'Preview only — nothing changes in the store.');
  assert.match(previewOnlyText('ckb'), SORANI_ONLY);
  // No string calls a route fee or a cost by a word the pricing vocabulary retired.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const value of flatten(PRICING_UI_STRINGS[lang] as unknown as Record<string, unknown>).values()) {
      assert.doesNotMatch(value, /الربح المستهدف|(?<!minimum )target profit|قازانجی ئامانج|گواستنەوە/i, value);
    }
  }
});

test('decimals are grouped as text, never through a float', () => {
  assert.equal(groupDecimal('1610.25'), '1,610.25');
  assert.equal(groupDecimal('350000'), '350,000');
  assert.equal(groupDecimal('0.024'), '0.024');
  // 16 significant digits: a float would round the last ones away.
  assert.equal(groupDecimal('123456789012.3456'), '123,456,789,012.3456');
  assert.equal(groupDecimal('9007199254740993'), '9,007,199,254,740,993');
  assert.equal(groupDecimal(null), '—');
  assert.equal(groupDecimal(''), '—');
  assert.equal(groupDecimal('abc'), 'abc', 'an unexpected shape is shown as sent, not invented');
  assert.equal(groupWhole(1200), '1,200');
  assert.equal(groupWhole(null), '—');
});

test('the change percentage is for reading only, and absent without a base', () => {
  assert.equal(changePercent(-9000, 450000), -2);
  assert.equal(changePercent(1000, 3000), 33.3);
  assert.equal(changePercent(null, 1000), null);
  assert.equal(changePercent(1000, 0), null);
  assert.equal(changePercent(1000, null), null);
});

test('reasons are said by code with their figures; an unknown code is shown, never dropped', () => {
  const fee = reasonText('ROUTE_FEE_INCLUDED', 'en', { method: 'Pre-order — air', iqd: '25,000 IQD' });
  assert.match(fee, /Pre-order — air: 25,000 IQD/);
  assert.doesNotMatch(fee, /\{/);
  // An engine readiness code takes the currency in its slot.
  assert.match(reasonText('FX_RATE_MISSING', 'en', { currency: 'USD' }), /USD/);
  assert.equal(reasonText('SOMETHING_NEW', 'ar'), 'SOMETHING_NEW');
  assert.equal(reasonTone('TARGET_ROUTE_CONFLICT'), 'danger');
  assert.equal(reasonTone('ROUTE_FEE_INCLUDED'), 'info');
  assert.equal(reasonTone('LEGACY_DIRECT_BELOW_PREORDER'), 'warning');
  assert.equal(reasonTone('SUPPLIER_COST_MISSING'), 'warning');
});

test('a name falls back across the three languages, then to the caller’s word', () => {
  const n = { name_ar: 'منتج', name_en: 'Product', name_ckb: '' };
  assert.equal(nameOf(n, 'ckb'), 'منتج');
  assert.equal(nameOf(n, 'en'), 'Product');
  assert.equal(nameOf({ name_ar: '', name_en: '', name_ckb: '' }, 'ar', 'slug-x'), 'slug-x');
  assert.equal(nameOf(null, 'ar', 'x'), 'x');
});

// ------------------------------------------------------------- review fixes

test('the screen has ONE name in each language — the tab, the title and every contract sentence that sends the owner to it (review finding 5)', () => {
  // The contracts point the owner at the screen by name; the tab and the heading must carry that very name.
  const named = [COST_REFUSALS.CENTRAL_RATES_MOVED, PRICING_ISSUES.FX_RATE_UNCONFIRMED.label, PRICING_ISSUES.SHIPPING_RATE_UNCONFIRMED.label];
  for (const label of named) {
    assert.equal(/«([^»]+)»/.exec(label.ar)?.[1], PRICING_UI_STRINGS.ar.title, label.ar);
    assert.equal(/«([^»]+)»/.exec(label.ckb)?.[1], PRICING_UI_STRINGS.ckb.title, label.ckb);
  }
  const admin = codeOf('src/pages/Admin.tsx');
  assert.ok(
    admin.includes(`loc('${PRICING_UI_STRINGS.ar.title}', '${PRICING_UI_STRINGS.en.title}', '${PRICING_UI_STRINGS.ckb.title}')`),
    'the sidebar tab is not the screen title'
  );
  // The Sorani name is real Sorani (row 183 rule, master plan v2 rule 7): it carries a Sorani-only letter.
  assert.match(PRICING_UI_STRINGS.ckb.title, SORANI_ONLY);
});

test('Sorani wording: rules are «ڕێسا», never «یاسا» (law); rate units say «د.ع» like every price (review findings 7, 11)', () => {
  for (const [key, value] of flatten(PRICING_UI_STRINGS.ckb as unknown as Record<string, unknown>)) assert.doesNotMatch(value, /یاسا/, key);
  assert.match(PRICING_UI_STRINGS.ckb.whatIfIntro, /بە ڕێسا نوێیەکان/);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(PRICING_UI_STRINGS[lang].perKg.startsWith(`${iqdUnit(lang)} `), `${lang} perKg «${PRICING_UI_STRINGS[lang].perKg}»`);
    assert.ok(PRICING_UI_STRINGS[lang].perCbm.startsWith(`${iqdUnit(lang)} `), `${lang} perCbm «${PRICING_UI_STRINGS[lang].perCbm}»`);
  }
});

test('the breakdown says a direct sale adds the Direct Sale Extra after the rounding, and takes the step in the reader’s digits; the member chip says «يدوياً» (review finding 14)', () => {
  const extra = { ar: /زيادة البيع المباشر/, en: /Direct Sale Extra/, ckb: /زیادەی فرۆشتنی ڕاستەوخۆ/ } as const;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const how = PRICING_UI_STRINGS[lang].minimumKeptHow('١٬٠٠٠');
    assert.match(how, extra[lang], lang);
    assert.ok(how.includes('١٬٠٠٠'), `${lang}: the step is the caller's, written in the reader's digits`);
    assert.doesNotMatch(how, /1,000/, lang);
  }
  assert.equal(PRICING_UI_STRINGS.ar.typedMemberPrices, 'أسعار عضوية مكتوبة يدوياً');
  // Counts are formatted by the screen, never inside the sentence.
  assert.equal(PRICING_UI_STRINGS.ar.productsCount('٤١'), 'عدد المنتجات: ٤١');
  assert.equal(PRICING_UI_STRINGS.ar.shownCount('٢'), 'المنتجات المعروضة: ٢');
});

// ------------------------------------------------- FX-1: the exchange-rate panel

/** Every leaf of the FX table, nested records flattened as `a.b`, functions called with sample arguments. */
function flattenDeep(table: Record<string, unknown>, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(table)) {
    const k = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(k, value);
    else if (typeof value === 'function') out.set(k, String((value as (...a: unknown[]) => unknown)('7', '8', '9', '10')));
    else if (value && typeof value === 'object') flattenDeep(value as Record<string, unknown>, k, out);
    else assert.fail(`${k}: not a string, a function or a table`);
  }
  return out;
}

test('FX panel: every string exists in ar, en and ckb with the same keys; the Sorani is its own (row 183)', () => {
  const ar = flattenDeep(FX_STRINGS.ar as unknown as Record<string, unknown>);
  const en = flattenDeep(FX_STRINGS.en as unknown as Record<string, unknown>);
  const ckb = flattenDeep(FX_STRINGS.ckb as unknown as Record<string, unknown>);
  assert.ok(ar.size >= 120, `only ${ar.size} strings`);
  assert.deepEqual([...en.keys()].sort(), [...ar.keys()].sort());
  assert.deepEqual([...ckb.keys()].sort(), [...ar.keys()].sort());
  for (const [key, value] of [...ar, ...en, ...ckb]) {
    assert.ok(value.trim().length > 0, `${key} is empty`);
    assert.equal(value, value.trim(), `${key} has stray whitespace`);
  }
  for (const [key, value] of ckb) {
    assert.notEqual(value, ar.get(key), `${key}: the Sorani slot carries the Arabic`);
    assert.notEqual(value, en.get(key), `${key}: the Sorani slot carries the English`);
    assert.match(value, SORANI_ONLY, `${key}: no Sorani-only letter in «${value}»`);
    assert.doesNotMatch(value, ARABIC_ONLY, `${key}: an Arabic-only letter in the Sorani «${value}»`);
  }
  for (const [key, value] of ar) assert.match(value, ARABIC_SCRIPT, `${key}: the Arabic is not Arabic script`);
  for (const [key, value] of en) assert.doesNotMatch(value, ARABIC_SCRIPT, `${key}: Arabic script in the English`);
});

test('FX panel: the plan’s own wording (§12), the attribution, and «the shop’s rate» (critique L8)', () => {
  const want: Array<[keyof typeof FX_STRINGS.ar, string, string, string]> = [
    ['title', 'أسعار الصرف', 'Exchange rates', 'نرخەکانی ئاڵوگۆڕ'],
    ['srcParallel', 'المصدر: السوق الموازية العراقية', 'Source: Iraqi parallel market', 'سەرچاوە: بازاڕی هاوتەریبی عێراق'],
    ['effective', 'السعر المعتمد', 'Effective rate', 'نرخی کارپێکراو'],
    ['approve', 'اعتماد السعر الجديد', 'Apply the new rate', 'نرخە نوێیەکە جێبەجێ بکە'],
    ['reject', 'رفض والإبقاء على الحالي', 'Reject and keep the current rate', 'ڕەتی بکەرەوە و نرخی ئێستا بهێڵەوە'],
    ['keepManual', 'أبقِ سعري الحالي يدويًا', 'Keep my current rate as manual', 'نرخی ئێستام وەک دەستی بهێڵەوە'],
    ['refresh', 'تحديث الآن', 'Refresh now', 'ئێستا نوێی بکەرەوە'],
    ['manual', 'تعيين سعر يدوي', 'Set a manual rate', 'نرخێکی دەستی دابنێ'],
    ['backAuto', 'العودة إلى التلقائي', 'Back to automatic', 'گەڕانەوە بۆ خۆکار'],
    ['confirmCurrent', 'تأكيد السعر الحالي', 'Confirm the current rate', 'نرخی ئێستا پشتڕاست بکەرەوە'],
    ['guards', 'إعدادات الحماية', 'Safety settings', 'ڕێکخستنەکانی پاراستن'],
    ['reauth', 'لحماية الأسعار، سجّل الدخول مجددًا ثم أعد المحاولة', 'To protect prices, sign in again, then retry', 'بۆ پاراستنی نرخەکان، دووبارە بچۆ ژوورەوە و پاشان هەوڵ بدەرەوە'],
    ['shipTitle', 'أسعار الشحن المركزية', 'Central shipping rates', 'نرخەکانی ناردنی ناوەندی'],
  ];
  for (const [key, ar, en, ckb] of want) {
    assert.equal(FX_STRINGS.ar[key], ar, `ar ${String(key)}`);
    assert.equal(FX_STRINGS.en[key], en, `en ${String(key)}`);
    assert.equal(FX_STRINGS.ckb[key], ckb, `ckb ${String(key)}`);
  }
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.match(FX_STRINGS[lang].attribution, /IQWealth$/);
  assert.equal(FX_STRINGS.en.attribution, 'Data: IQWealth');
  assert.match(FX_STRINGS.ar.intro, /سعر المتجر/);
  assert.match(FX_STRINGS.en.intro, /the shop's rate/);
  assert.match(FX_STRINGS.ckb.intro, /نرخی فرۆشگا/);
  // The review sentence carries its figures in the slots, as the screen wrote them.
  assert.equal(
    FX_STRINGS.en.reviewBody('1,720', '1,660', '3.6', '3'),
    'The new rate 1,720 differs from the effective 1,660 by 3.6%, above the 3% limit. It was not applied, and no price changes until you decide.'
  );
  // An event a later push adds is shown by its code, never dropped.
  assert.equal(fxEventLabel(FX_STRINGS.ar, 'apply'), 'طُبّق سعر جديد');
  assert.equal(fxEventLabel(FX_STRINGS.ar, 'SOMETHING_NEW'), 'SOMETHING_NEW');
  // The dashboard card names the tab as the tab names itself.
  assert.equal(FX_STRINGS.ar.ownerCardOpen, `فتح «${PRICING_UI_STRINGS.ar.title}»`);
  assert.equal(FX_STRINGS.ckb.ownerCardOpen, `«${PRICING_UI_STRINGS.ckb.title}» بکەرەوە`);
});
