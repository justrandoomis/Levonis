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
 *   - the §6.2 wording is kept verbatim, except the two binding owner changes:
 *     the MINIMUM target profit (2026-10-07) and «ناردن» for shipping (C46).
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
import { isPricingIssueCode } from '../packages/contracts/src/pricingIssues';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import type { PricingLabel } from '../packages/contracts/src/pricingFieldLabels';
import { LEGACY_TARGET_REASON_CODES } from '../packages/pricing/src/legacyTargets';
import { asD1, freshDb } from './fixtures/app';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { listPricedProducts, loadPreviewContext, loadRateReference } from '../worker/lib/pricingEngine/load';
import { evaluateProducts } from '../worker/lib/pricingEngine/compute';

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
  assert.deepEqual(PRICING_MIGRATION_LABELS['s.READY_TO_SWITCH'], {
    ar: 'مكتمل — بانتظار تحويله إلى التسعير الجديد',
    en: 'Complete — waiting for you to switch it to the new pricing',
    ckb: 'تەواوە — چاوەڕێیە تۆ بیگۆڕیت بۆ نرخدانانی نوێ',
  });
  assert.equal(LEGACY_REASONS.LEGACY_PREMIUM_NOT_ON_STEP.label.en, 'The extracted direct-sale premium ({iqd}) is not a multiple of 1,000. Choose the nearest lower or higher value, or set it yourself.');
  assert.equal(PRICING_MIGRATION_LABELS['L.NO_ADDITIONAL_COSTS'].ckb, 'ℹ هیچ تێچوویەکی زیادە تۆمار نەکراوە');
  assert.equal(PRICING_MIGRATION_LABELS['b.previewOnly'].en, 'Preview only — nothing changes in the store.');
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
    'The old route fee (air: 25,000) was part of what the customer paid, so it counts in the minimum target profit; it is set to zero at the switch because the new price includes shipping.'
  );
  assert.match(migrationText(LEGACY_REASONS.LEGACY_PREMIUM_NOT_ON_STEP.label, 'ckb', {}), /\(\{iqd\}\)/, 'an unfilled slot is left visible, never guessed');
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
      for (const r of [...m.legacy.target.reasons, ...m.legacy.premium.reasons]) codes.add(r.code);
      for (const x of m.missing) codes.add(x.code);
    }
  }
  assert.ok(codes.size >= 10, `only ${codes.size} codes seen`);
  assert.deepEqual([...codes].filter((c) => !isLegacyReasonCode(c) && !isPricingIssueCode(c)).sort(), []);
});
