/**
 * THE «التسعير والشحن» P1 STRINGS — packages/contracts/src/pricingMigrationLabels.ts
 * (MVP plan §6 P1; master plan v2 §2.3, §6.2; DECISIONS row 183).
 *
 *   - the §2.3 statuses, worst first, each labelled;
 *   - every reason the derivation and the preview raise is labelled, and every
 *     code the router answers on the census fixture is labelled here or in
 *     the readiness list (pricingIssues.ts);
 *   - every string exists in ar, en and real Sorani: the ckb is never the
 *     Arabic or the English, carries a Sorani-only letter and no Arabic-only
 *     one; the `{slots}` agree across the three languages;
 *   - the §6.2 wording is kept verbatim, except the binding owner changes:
 *     the MINIMUM target profit (2026-10-07), «ناردن» for shipping (C46), and
 *     no switch and no gate (decision 8, 2026-10-09; DECISIONS row 191).
 *
 * Run: node --import tsx --test tests/pricingMigrationLabels.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_REASONS,
  LEGACY_VALUE_STATES,
  LEGACY_VALUE_STATE_LABELS,
  PRICING_MIGRATION_LABELS,
  PRICING_MIGRATION_STATUSES,
  PRICING_MIGRATION_STATUS_LABELS,
  isLegacyReasonCode,
  isPricingMigrationStatus,
  migrationText,
  worstMigrationStatus,
} from '../packages/contracts/src/pricingMigrationLabels';
import { PRICING_ISSUES, isPricingIssueCode } from '../packages/contracts/src/pricingIssues';
import { PRICING_FIELD_LABELS } from '../packages/contracts/src/pricingFieldLabels';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import type { PricingLabel } from '../packages/contracts/src/pricingFieldLabels';
import { LEGACY_TARGET_REASON_CODES } from '../packages/pricing/src/legacyTargets';
import { asD1, freshDb } from './fixtures/app';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { listPricedProducts, loadPreviewContext, loadRateReference } from '../worker/lib/pricingEngine/load';
import { evaluateProducts } from '../worker/lib/pricingEngine/compute';
import { PRICING_MIX_LABELS, PRICING_ROUTE_LABELS, PRICING_UI_STRINGS } from '../src/components/adminPricing/strings';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

const ALL: Array<[string, PricingLabel]> = [
  ...Object.entries(PRICING_MIGRATION_STATUS_LABELS).map(([k, v]) => [`status.${k}`, v] as [string, PricingLabel]),
  ...Object.entries(LEGACY_VALUE_STATE_LABELS).map(([k, v]) => [`state.${k}`, v] as [string, PricingLabel]),
  ...Object.entries(LEGACY_REASONS).map(([k, v]) => [`reason.${k}`, v.label] as [string, PricingLabel]),
  ...Object.entries(PRICING_MIGRATION_LABELS).map(([k, v]) => [`label.${k}`, v] as [string, PricingLabel]),
  ['refusal.PRICING_INPUT_INVALID', COST_REFUSALS.PRICING_INPUT_INVALID],
];

test('every string is in ar, en and real Sorani — the ckb never the Arabic or the English, with a Sorani letter and no Arabic-only one', () => {
  assert.ok(ALL.length >= 55, `only ${ALL.length} strings`);
  for (const [key, { ar, en, ckb }] of ALL) {
    for (const [lang, s] of Object.entries({ ar, en, ckb })) {
      assert.equal(typeof s, 'string', `${key}.${lang}`);
      assert.ok(s.trim().length > 0, `${key}.${lang} is empty`);
      assert.equal(s, s.trim(), `${key}.${lang} has stray whitespace`);
    }
    assert.notEqual(ckb, ar, `${key}: the Sorani slot carries the Arabic (row 183)`);
    assert.notEqual(ckb, en, `${key}: the Sorani slot carries the English`);
    assert.match(ckb, SORANI_ONLY, `${key}: no Sorani-only letter`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${key}: an Arabic-only letter in the Sorani`);
    assert.match(ar, ARABIC_SCRIPT, `${key}: the Arabic is not Arabic`);
    assert.doesNotMatch(en, ARABIC_SCRIPT, `${key}: Arabic script in the English`);
    // The slots a screen fills are the same in all three languages.
    const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(slots(ar), slots(en), `${key}: ar and en slots differ`);
    assert.deepEqual(slots(ckb), slots(en), `${key}: ckb and en slots differ`);
  }
});

test('terminology on pricing screens: shipping is «ناردن», never «گواستنەوە» (C46); product is «بەرهەم», never «کاڵا» (C32)', () => {
  for (const [key, { ckb }] of ALL) {
    assert.doesNotMatch(ckb, /گواستنەوە/, key);
    assert.doesNotMatch(ckb, /کاڵا/, key);
  }
  assert.match(PRICING_MIGRATION_LABELS['p.CHINA_AIR'].ckb, /^ناردنی ئاسمانی — چین$/);
  assert.match(PRICING_MIGRATION_LABELS['p.CHINA_SEA'].ckb, /^ناردنی دەریایی — چین$/);
  assert.match(PRICING_MIGRATION_LABELS['p.GERMANY_LAND'].ckb, /^ناردنی وشکانی — ئەڵمانیا$/);
});

test('the owner’s MINIMUM target profit (2026-10-07) replaces «target profit» wherever §6.2 said it', () => {
  for (const [key, { ar, en, ckb }] of ALL) {
    assert.doesNotMatch(ar, /الربح المستهدف/, key);
    assert.doesNotMatch(en, /(?<!minimum )target profit/i, key);
    assert.doesNotMatch(ckb, /قازانجی ئامانج/, key);
  }
  assert.match(PRICING_MIGRATION_LABELS['b.landedNote'].ar, /^الحد الأدنى للربح = /);
  assert.match(PRICING_MIGRATION_LABELS['b.landedNote'].en, /^Minimum target profit = old sale price including the applicable route fee, minus the old cost\./);
  assert.match(PRICING_MIGRATION_LABELS['b.landedNote'].ckb, /^کەمترین قازانجی مەبەست = /);
  // Answer B, in the owner's words: the landed cost is not given shipping again.
  assert.match(PRICING_MIGRATION_LABELS['b.landedNote'].en, /so shipping is not added to it again\.$/);
});

test('the §6.2 rows the owner did not change are verbatim', () => {
  assert.deepEqual(LEGACY_REASONS.TARGET_ROUTE_CONFLICT.label, {
    ar: 'مسارات الطلب المسبق تعطي أرباحاً قديمة مختلفة لهذا الاختيار بعد احتساب عمولة كل مسار. اختر المسار الذي يُعتمد أو حدّد الربح بنفسك؛ لا يُحسب متوسط.',
    en: "The pre-order routes give different old profits for this selection once each route's fee is counted. Choose the route to use or set the profit yourself; no average is taken.",
    ckb: 'ڕێگاکانی پێشداواکاری دوای حیسابکردنی کرێی هەر ڕێگایەک قازانجی کۆنی جیاواز دەدەن بۆ ئەم هەڵبژاردنە. ئەو ڕێگایە هەڵبژێرە کە بەکاردێت یان خۆت قازانج دیاری بکە؛ تێکڕا وەرناگیرێت.',
  });
  assert.equal(LEGACY_REASONS.LEGACY_DIRECT_SALE_EXTRA_NOT_ON_STEP.label.en, 'The extracted Direct Sale Extra ({iqd}) is not a multiple of 1,000. Choose the nearest lower or higher value, or set it yourself.');
  assert.equal(PRICING_MIGRATION_LABELS['L.NO_ADDITIONAL_COSTS'].ckb, 'ℹ هیچ تێچوویەکی زیادە تۆمار نەکراوە');
  assert.equal(PRICING_MIGRATION_LABELS['b.previewOnly'].en, 'Preview only — nothing changes in the store.');
});

/**
 * DECISION 8 (owner, 2026-10-09; DECISIONS row 191): «ENGINE STARTS WHEN THE
 * PRODUCT IS COMPLETE». The save that completes a product's pricing data shows
 * the new prices, and saving adopts the engine and writes them — no extra
 * activation step, no gate. So nothing the owner reads may still speak of a
 * switch or a first switch-on: the complete status asks for a review and a
 * save, the one button is «حفظ واعتماد الأسعار الجديدة», and the two reasons
 * that said "at / after the switch" now say "when you save the new prices".
 */
test('decision 8: a complete product is reviewed and saved, never switched — no switch button, no gate title', () => {
  assert.deepEqual(PRICING_MIGRATION_LABELS['s.READY_TO_SWITCH'], {
    ar: 'مكتمل — راجع الأسعار الجديدة واحفظ',
    en: 'Complete — review the new prices and save',
    ckb: 'تەواوە — پێداچوونەوە بە نرخە نوێیەکاندا بکە و پاشەکەوتیان بکە',
  });
  assert.deepEqual(PRICING_MIGRATION_STATUS_LABELS.READY_TO_SWITCH, PRICING_MIGRATION_LABELS['s.READY_TO_SWITCH']);
  assert.deepEqual(PRICING_MIGRATION_LABELS['btn.saveAndApply'], {
    ar: 'حفظ واعتماد الأسعار الجديدة',
    en: 'Save and apply the new prices',
    ckb: 'پاشەکەوتکردن و جێبەجێکردنی نرخە نوێیەکان',
  });
  const keys = Object.keys(PRICING_MIGRATION_LABELS);
  assert.ok(!keys.includes('btn.switch'), 'the switch button is gone');
  assert.ok(!keys.some((k) => k.startsWith('gate.')), 'the first switch-on conditions are gone');
  // Nothing the owner reads speaks of a switch or of switching on — see the
  // next test, which walks every string of the tab, not only these labels.
  assert.equal(
    LEGACY_REASONS.LEGACY_MEMBER_PRICE_DROPPED.label.en,
    'The typed membership price will not be used once you save the new prices; the general membership benefits apply.'
  );
  assert.match(LEGACY_REASONS.ROUTE_FEE_INCLUDED.label.ar, /تُصفَّر عند حفظ الأسعار الجديدة لأن السعر الجديد يشمل الشحن\.$/);
  assert.match(LEGACY_REASONS.ROUTE_FEE_INCLUDED.label.ckb, /لە کاتی پاشەکەوتکردنی نرخە نوێیەکاندا/);
  assert.match(LEGACY_REASONS.LEGACY_MEMBER_PRICE_DROPPED.label.ckb, /دوای پاشەکەوتکردنی نرخە نوێیەکان/);
  // The refusal a save answers when the measures are unconfirmed says the same.
  assert.deepEqual(
    [COST_REFUSALS.PRICING_MEASURES_UNCONFIRMED.ar.endsWith('قبل حفظ أسعار المنتج الجديدة.'),
     COST_REFUSALS.PRICING_MEASURES_UNCONFIRMED.en.endsWith("before saving the product's new prices."),
     COST_REFUSALS.PRICING_MEASURES_UNCONFIRMED.ckb.includes('پێش پاشەکەوتکردنی نرخە نوێیەکانی بەرهەمەکە')],
    [true, true, true]
  );
});

/**
 * The words decision 8 retired. Arabic is compared without its marks, so
 * «تحوّل» and «تحول» are the one word a reader sees; the Sorani covers the
 * noun, the verb forms the old labels used and the old gate title.
 */
const bareArabic = (s: string) => s.replace(/[ً-ْـ]/g, '');
const SWITCH_WORDS = {
  en: /\bswitch/i,
  ar: /تحويل|تحول|بوابة|التشغيل الأول/,
  ckb: /گۆڕین|بیگۆڕیت|دەگۆڕیت|بگۆڕە|دەروازە|یەکەم دەستپێکردن/,
} as const;

/** Every string of «التسعير والشحن», as [key, {ar, en, ckb}] — the contracts' and the screen's own. */
function everyStringOfTheTab(): Array<[string, PricingLabel]> {
  const out: Array<[string, PricingLabel]> = [...ALL];
  const text = (v: unknown) => (typeof v === 'function' ? String((v as (...a: unknown[]) => unknown)(7, 'EUR')) : String(v));
  for (const key of Object.keys(PRICING_UI_STRINGS.ar)) {
    const at = (lang: 'ar' | 'en' | 'ckb') => text((PRICING_UI_STRINGS[lang] as unknown as Record<string, unknown>)[key]);
    out.push([`ui.${key}`, { ar: at('ar'), en: at('en'), ckb: at('ckb') }]);
  }
  for (const [k, v] of Object.entries(PRICING_MIX_LABELS)) out.push([`mix.${k}`, v]);
  for (const [k, v] of Object.entries(PRICING_ROUTE_LABELS)) out.push([`route.${k}`, v]);
  for (const [k, v] of Object.entries(PRICING_ISSUES)) out.push([`issue.${k}`, v.label]);
  for (const [k, v] of Object.entries(PRICING_FIELD_LABELS)) out.push([`field.${k}`, v as PricingLabel]);
  // The pricing refusals a save can answer. The two retired gate codes stay in
  // the contract (it only grows) but are never raised, so no one reads them.
  for (const [k, v] of Object.entries(COST_REFUSALS)) if (k.startsWith('PRICING_') && !k.startsWith('PRICING_GATE_')) out.push([`refusal.${k}`, v]);
  return out;
}

test('decision 8 on the screen: no string of «التسعير والشحن» speaks of a switch, a switch-on or a gate (review finding, WP-POL)', () => {
  // The guard is not vacuous: it refuses the wording the tab carried before this fix.
  assert.match('Store prices change only when you switch a product to the new pricing', SWITCH_WORDS.en);
  assert.match(bareArabic('تتغير أسعار المتجر فقط عندما تحوّل منتجاً إلى التسعير الجديد'), SWITCH_WORDS.ar);
  assert.match(bareArabic('لن تُستخدم بعد التحويل'), SWITCH_WORDS.ar);
  assert.match('شروط البوابة', SWITCH_WORDS.ar);
  assert.match('کە بەرهەمێک دەگۆڕیت بۆ نرخدانانی نوێ', SWITCH_WORDS.ckb);
  assert.match('دوای گۆڕین بەکارناهێنرێن', SWITCH_WORDS.ckb);

  const all = everyStringOfTheTab();
  assert.ok(all.length >= 180, `only ${all.length} strings`);
  assert.ok(all.some(([k]) => k === 'ui.previewBody') && all.some(([k]) => k === 'ui.membersDropped'), 'the screen strings are not scanned');
  for (const [key, { ar, en, ckb }] of all) {
    assert.doesNotMatch(en, SWITCH_WORDS.en, `${key}: «${en}»`);
    assert.doesNotMatch(bareArabic(ar), SWITCH_WORDS.ar, `${key}: «${ar}»`);
    assert.doesNotMatch(ckb, SWITCH_WORDS.ckb, `${key}: «${ckb}»`);
  }

  // The banner on every visit and the note under typed member prices say what the contract's reasons say.
  assert.deepEqual(
    (['ar', 'en', 'ckb'] as const).map((l) => PRICING_UI_STRINGS[l].previewBody.split(/(?<=\.) /).pop()),
    [
      'تتغير أسعار المتجر فقط عندما تحفظ الأسعار الجديدة لمنتج، في تحديث لاحق.',
      "Store prices change only when you save a product's new prices, in a later update.",
      'نرخەکانی فرۆشگا تەنها ئەو کاتە دەگۆڕێن کە نرخە نوێیەکانی بەرهەمێک پاشەکەوت دەکەیت، لە نوێکردنەوەیەکی داهاتوودا.',
    ]
  );
  assert.deepEqual(
    { ar: PRICING_UI_STRINGS.ar.membersDropped, en: PRICING_UI_STRINGS.en.membersDropped, ckb: PRICING_UI_STRINGS.ckb.membersDropped },
    {
      ar: 'لن تُستخدم بعد حفظ الأسعار الجديدة؛ تُطبَّق مزايا العضوية العامة.',
      en: 'They will not be used once you save the new prices; the general membership benefits apply.',
      ckb: 'دوای پاشەکەوتکردنی نرخە نوێیەکان بەکارناهێنرێن؛ سوودە گشتییەکانی ئەندامێتی جێبەجێ دەکرێن.',
    }
  );
  assert.ok(LEGACY_REASONS.LEGACY_MEMBER_PRICE_DROPPED.label.en.includes('once you save the new prices'));
});

test('the §2.3 statuses, worst first, and the worst of a set', () => {
  assert.deepEqual([...PRICING_MIGRATION_STATUSES], ['CONFLICT', 'TARGET_PROFIT_REVIEW_REQUIRED', 'NEEDS_MANUAL_REVIEW', 'WAITING_FOR_SUPPLIER_COST', 'READY_TO_SWITCH', 'READY']);
  assert.equal(worstMigrationStatus(['READY', 'NEEDS_MANUAL_REVIEW', 'WAITING_FOR_SUPPLIER_COST']), 'NEEDS_MANUAL_REVIEW');
  assert.equal(worstMigrationStatus([]), 'WAITING_FOR_SUPPLIER_COST');
  assert.equal(isPricingMigrationStatus('READY_TO_SWITCH'), true);
  assert.equal(isPricingMigrationStatus('MIGRATED'), false);
  assert.ok(LEGACY_VALUE_STATES.every((s) => s in LEGACY_VALUE_STATE_LABELS));
});

test('every reason the derivation raises has a label and a severity; migrationText fills the slots it is given and no other', () => {
  for (const code of LEGACY_TARGET_REASON_CODES) {
    assert.ok(isLegacyReasonCode(code), code);
    assert.ok(['conflict', 'review', 'unresolved', 'info'].includes(LEGACY_REASONS[code].severity), code);
  }
  for (const code of ['CHANNEL_NOT_PRICED', 'COLOR_PRICE_UNSUPPORTED', 'OPTION_GROUPS_UNSUPPORTED', 'LEGACY_MEMBER_PRICE_DROPPED']) assert.ok(isLegacyReasonCode(code), code);
  assert.equal(
    migrationText(LEGACY_REASONS.ROUTE_FEE_INCLUDED.label, 'en', { method: 'air', iqd: '25,000' }),
    'The old route fee (air: 25,000) was part of what the customer paid, so it counts in the minimum target profit; it is set to zero when you save the new prices, because the new price includes shipping.'
  );
  assert.match(migrationText(LEGACY_REASONS.LEGACY_DIRECT_SALE_EXTRA_NOT_ON_STEP.label, 'ckb', {}), /\(\{iqd\}\)/, 'an unfilled slot is left visible, never guessed');
});

test('every code the preview answers on the census is labelled — a legacy reason here, or a readiness code in pricingIssues.ts', async () => {
  const raw = freshDb();
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  const db = asD1(raw);
  const [refs, ctx, ref] = await Promise.all([listPricedProducts(db), loadPreviewContext(db), loadRateReference(db)]);
  const all = await evaluateProducts(db, refs.map((r) => r.id), ctx, ref);
  const codes = new Set<string>();
  for (const p of all) {
    for (const c of [...p.reason_codes, ...p.info_codes]) codes.add(c);
    for (const m of p.models) {
      for (const r of [...m.legacy.target.reasons, ...m.legacy.extra.reasons]) codes.add(r.code);
      for (const x of m.missing) codes.add(x.code);
    }
  }
  assert.ok(codes.size >= 10, `only ${codes.size} codes seen`);
  assert.deepEqual([...codes].filter((c) => !isLegacyReasonCode(c) && !isPricingIssueCode(c)).sort(), []);
});

test('the PRODUCT status a held Direct Sale Extra rolls up to names both values; one value’s own state names only its own (review finding 1)', () => {
  // check (1)7: a held Direct Sale Extra rolls up to TARGET_PROFIT_REVIEW_REQUIRED, so the product chip must not
  // say only «the minimum profit needs review» above a minimum-profit card that reads «taken from the old prices».
  const product = PRICING_MIGRATION_STATUS_LABELS.TARGET_PROFIT_REVIEW_REQUIRED;
  assert.deepEqual(product, {
    ar: 'الحد الأدنى للربح أو زيادة البيع المباشر يحتاج مراجعة',
    en: 'Minimum profit or Direct Sale Extra needs review',
    ckb: 'کەمترین قازانج یان زیادەی فرۆشتنی ڕاستەوخۆ پێویستی بە پێداچوونەوە هەیە',
  });
  // The per-value labels are unchanged: each names its own value only.
  assert.equal(LEGACY_VALUE_STATE_LABELS.TARGET_PROFIT_REVIEW_REQUIRED.en, 'Minimum target profit needs review');
  assert.equal(LEGACY_VALUE_STATE_LABELS.DIRECT_SALE_EXTRA_REVIEW_REQUIRED.en, 'Direct Sale Extra needs review');
});

test('NO_BASE_ROUTE does not claim the routes charge different prices — it is raised for every model with more than one route and no owner choice (review finding M2)', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.doesNotMatch(LEGACY_REASONS.NO_BASE_ROUTE.label[lang], /different prices|بأسعار مختلفة|بە نرخی جیاواز/, lang);
  }
  assert.match(LEGACY_REASONS.NO_BASE_ROUTE.label.en, /^Pre-order has more than one route; choose the base route/);
});

test('one Arabic word for the Direct Sale Extra on every pricing screen: «زيادة البيع المباشر», never «علاوة» (review finding 4; DECISIONS rows 70, 90)', () => {
  const labels: Array<[string, string]> = [
    ...Object.entries(PRICING_ISSUES).map(([k, v]) => [`issue.${k}`, v.label.ar] as [string, string]),
    ...Object.entries(PRICING_FIELD_LABELS).map(([k, v]) => [`field.${k}`, (v as PricingLabel).ar] as [string, string]),
    ...ALL.map(([k, v]) => [k, v.ar] as [string, string]),
    ['refusal.DIRECT_SALE_EXTRA_NOT_ON_STEP', COST_REFUSALS.DIRECT_SALE_EXTRA_NOT_ON_STEP.ar],
  ];
  for (const [key, ar] of labels) assert.doesNotMatch(ar, /علاو[ةتا]/, `${key}: «${ar}»`);
  assert.equal(PRICING_FIELD_LABELS.direct_sale_extra_iqd.ar, 'زيادة البيع المباشر');
  assert.equal(PRICING_ISSUES.DIRECT_SALE_EXTRA_BLOCKED.label.ar, 'زيادة البيع المباشر موقوفة حتى تقرر');
});
