/**
 * Printer services (owner brief 2026-11-17): the price list, the choice for one
 * printer line, and the one pricing function. Pins the owner's rulings:
 * warranty months are TOTALS (no free base, no stacking), no package discount
 * until set, no-warranty needs an explicit acknowledgment, a visual default is
 * never a confirmation, null = not offered (never 0).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRINTER_SERVICES, EMPTY_SELECTION, canonicalConfig, classesFor, configIssues, encodeSelection, mappingResolves, parseSelection,
  presetPrices, presetSelection, priceServices, publishIssues, sameServices, servicesOffer, withPhase2Defaults,
  SERVICES_NOT_CONFIRMED, SERVICES_NO_WARRANTY_ACK, SERVICES_OPTION_UNAVAILABLE, SERVICES_PACKAGE_MISMATCH,
  type PrinterServicesConfig, type ServiceSelection,
} from '../packages/pricing/src/printerServices';

const clone = (): PrinterServicesConfig => JSON.parse(JSON.stringify(DEFAULT_PRINTER_SERVICES));
const A1 = { warranty_family: 'a1', delivery_class: 'd1' } as const;
const H3C = { warranty_family: 'h3c', delivery_class: 'd5' } as const;
const confirmed = (s: ServiceSelection): ServiceSelection => ({ ...s, confirmed: true });

test('the seeded draft is valid and carries exactly the brief prices', () => {
  assert.deepEqual(configIssues(DEFAULT_PRINTER_SERVICES), []);
  const c = DEFAULT_PRINTER_SERVICES;
  assert.deepEqual(c.warranty.w12, { a1: 25_000, xpa2: 29_000, h2: 35_000, h3c: 39_000 });
  assert.deepEqual(c.warranty.w24, { a1: 100_000, xpa2: 150_000, h2: 200_000, h3c: 250_000 });
  assert.equal(c.care.price_iqd, 19_000);
  assert.equal(c.packaging.extra_iqd, 7_000);
  assert.equal(c.inspection.price_iqd, 5_000);
  assert.deepEqual([c.academy.recorded_iqd, c.academy.live_iqd], [0, 50_000]);
  assert.deepEqual(c.delivery.classes.d1, { economy_iqd: 5_000, personal_iqd: 15_000 });
  assert.deepEqual(c.delivery.classes.d5, { economy_iqd: 20_000, personal_iqd: 65_000 });
  // Owner ruling 2026-11-17: no package discount until the owner sets one.
  assert.equal(c.packages.smart.discount_iqd, null);
  assert.equal(c.packages.complete.discount_iqd, null);
});

test('the seed is not publishable until printers are mapped', () => {
  assert.ok(publishIssues(clone()).some((m) => m.startsWith('products:')));
  const c = clone();
  c.products.p_a1 = { warranty_family: 'a1', delivery_class: 'd1' };
  assert.deepEqual(publishIssues(c), []);
});

test('a package that includes an unpriced service cannot be published', () => {
  const c = clone();
  c.products.p_a1 = { warranty_family: 'a1', delivery_class: 'd1' };
  c.care.price_iqd = null;
  assert.ok(publishIssues(c).some((m) => m.includes('Levo Care')));
});

test('configIssues refuses fractional money, unknown families and a 95% care cap', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = clone() as unknown as Record<string, any>;
  c.warranty.w12.a1 = 25_000.5;
  c.products = { p1: { warranty_family: 'zz' } };
  c.care.max_discount_pct = 95;
  const issues = configIssues(c);
  assert.ok(issues.includes('warranty.w12.a1: whole IQD or null'));
  assert.ok(issues.includes('products.p1.warranty_family: unknown'));
  assert.ok(issues.includes('care.max_discount_pct: 0..90'));
});

test('a version mapping wins over the product (A1 vs A1 Combo delivery)', () => {
  const c = clone();
  c.products.p_a1 = { warranty_family: 'a1', delivery_class: 'd1', by_option_value: { ov_combo: { delivery_class: 'd2' } } };
  assert.deepEqual(classesFor(c, 'p_a1', []), { warranty_family: 'a1', delivery_class: 'd1' });
  assert.deepEqual(classesFor(c, 'p_a1', ['ov_combo']), { warranty_family: 'a1', delivery_class: 'd2' });
  assert.equal(classesFor(c, 'p_other', []), null, 'unmapped product = not enrolled');
  assert.equal(classesFor(null, 'p_a1', []), null, 'unpublished config = not enrolled');
});

test('a product missing a class is not enrolled (no guessed family)', () => {
  const c = clone();
  c.products.p = { warranty_family: 'h2' };
  assert.equal(classesFor(c, 'p', []), null);
});

test('warranty months are totals and never stack', () => {
  const c = clone();
  const w12 = priceServices(c, A1, confirmed({ ...EMPTY_SELECTION, warranty: 'w12' }));
  const w24 = priceServices(c, A1, confirmed({ ...EMPTY_SELECTION, warranty: 'w24' }));
  assert.equal(w12.warranty_months, 12);
  assert.equal(w24.warranty_months, 24);
  assert.equal(w12.fee_iqd, 25_000);
  assert.equal(w24.fee_iqd, 100_000);
  assert.equal(priceServices(c, H3C, confirmed({ ...EMPTY_SELECTION, warranty: 'w24' })).fee_iqd, 250_000);
});

test('no warranty needs the acknowledgment; with it the printer is 0 extra', () => {
  const c = clone();
  const noAck = priceServices(c, A1, confirmed(EMPTY_SELECTION));
  assert.ok(noAck.blockers.includes(SERVICES_NO_WARRANTY_ACK));
  const ok = priceServices(c, A1, confirmed({ ...EMPTY_SELECTION, ack_no_warranty: true }));
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.fee_iqd, 0);
  assert.equal(ok.warranty_months, 0);
});

test('a visual default is never a confirmation', () => {
  const p = priceServices(clone(), A1, presetSelection(clone(), 'smart'));
  assert.ok(p.blockers.includes(SERVICES_NOT_CONFIRMED));
});

test('Smart Choice = 12-month warranty + Care, sum of parts, no saving', () => {
  const c = clone();
  const p = priceServices(c, A1, confirmed(presetSelection(c, 'smart')));
  assert.deepEqual(p.blockers, []);
  assert.equal(p.fee_iqd, 25_000 + 19_000);
  assert.equal(p.package_discount_iqd, 0);
  assert.equal(p.care_months, 12);
  // Phase 5 (DECISIONS row 358): Care runs for the warranty and 12 months after it — 12 + 12 here.
  assert.equal(p.care_total_months, 24);
});

test('Care total months: Care alone 12, with a 12-month warranty 24, with 24 months 36; none without Care', () => {
  const c = clone();
  const total = (warranty: 'none' | 'w12' | 'w24', care: 'none' | 'c12') =>
    priceServices(c, A1, confirmed({ ...presetSelection(c, 'just'), package: 'custom', warranty, care })).care_total_months;
  assert.deepEqual([total('none', 'c12'), total('w12', 'c12'), total('w24', 'c12')], [12, 24, 36]);
  assert.deepEqual([total('none', 'none'), total('w12', 'none'), total('w24', 'none')], [0, 0, 0]);
  assert.equal(servicesOffer(c, A1).care?.after_warranty, true, 'the offer says Care runs after the warranty');
  assert.equal(servicesOffer(c, A1).care?.months, 12);
});

test('Complete = 24 months + Care + extra packaging + inspection with its lead time', () => {
  const c = clone();
  const p = priceServices(c, H3C, confirmed(presetSelection(c, 'complete')));
  assert.deepEqual(p.blockers, []);
  assert.equal(p.fee_iqd, 250_000 + 19_000 + 7_000 + 5_000);
  assert.deepEqual(p.inspection_lead_business_days, [2, 3]);
});

test('a package edited away from its preset is refused (it must become custom)', () => {
  const c = clone();
  const s = { ...confirmed(presetSelection(c, 'smart')), care: 'none' as const };
  assert.ok(priceServices(c, A1, s).blockers.includes(SERVICES_PACKAGE_MISMATCH));
  assert.deepEqual(priceServices(c, A1, { ...s, package: 'custom' }).blockers, []);
});

test('no package discount (owner ruling): refused by configIssues, never applied by priceServices', () => {
  const c = clone();
  c.packages.smart.discount_iqd = 1_000_000;
  assert.ok(configIssues(c).some((i) => i.startsWith('packages.smart.discount_iqd')));
  (c.packages.complete as unknown as Record<string, unknown>).discount_pct = 10;
  assert.ok(configIssues(c).some((i) => i.startsWith('packages.complete.discount_pct')));
  // Even a config that slipped past validation prices the plain sum.
  const p = priceServices(c, A1, confirmed(presetSelection(c, 'smart')));
  assert.equal(p.fee_iqd, 44_000);
  assert.equal(p.package_discount_iqd, 0);
  const ok = clone();
  ok.packages.smart.discount_iqd = 0;
  assert.deepEqual(configIssues(ok), []);
});

test('size caps: products, versions per product and id lengths', () => {
  const many = clone();
  for (let i = 0; i <= 500; i++) many.products[`p${i}`] = { ...A1 };
  assert.ok(configIssues(many).some((i) => i.startsWith('products: at most 500')));
  const versions = clone();
  versions.products.p1 = { ...A1, by_option_value: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${i}`, {}])) };
  assert.ok(configIssues(versions).some((i) => i.includes('at most 50 versions')));
  const longId = clone();
  longId.products['x'.repeat(65)] = { ...A1 };
  longId.products.p2 = { ...A1, by_option_value: { ['y'.repeat(65)]: { ...A1 } } };
  const issues = configIssues(longId);
  assert.ok(issues.some((i) => /^products\.x{64}\.\.\.: bad id/.test(i)));
  assert.ok(issues.some((i) => /^products\.p2\.by_option_value\.y{64}\.\.\.: bad id/.test(i)));
  const fine = clone();
  fine.products['x'.repeat(64)] = { ...A1, by_option_value: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`v${i}`, {}])) };
  assert.deepEqual(configIssues(fine), []);
});

test('canonicalConfig keeps only the known fields', () => {
  const c = clone() as unknown as Record<string, any>;
  c.extra = 'x';
  c.products = { p1: { ...A1, junk: 1, by_option_value: { v1: { delivery_class: 'd2', junk: 2 } } } };
  c.warranty.w12.zz = 5;
  c.delivery.classes.d9 = { economy_iqd: 1, personal_iqd: 1 };
  c.packages.smart.note = 'hi';
  assert.deepEqual(configIssues(c), []);
  const out = canonicalConfig(c as PrinterServicesConfig) as unknown as Record<string, any>;
  assert.equal(out.extra, undefined);
  assert.deepEqual(out.products, { p1: { warranty_family: 'a1', delivery_class: 'd1', by_option_value: { v1: { warranty_family: null, delivery_class: 'd2' } }, store_bundle_ids: [] } });
  assert.equal(out.warranty.w12.zz, undefined);
  assert.equal(out.delivery.classes.d9, undefined);
  assert.equal(out.packages.smart.note, undefined);
  const plain = canonicalConfig(DEFAULT_PRINTER_SERVICES);
  assert.deepEqual(plain, DEFAULT_PRINTER_SERVICES);
});

test('publish refuses a mapping no single selection resolves; mappingResolves names some selection', () => {
  const c = clone();
  c.products.split = { by_option_value: { v1: { warranty_family: 'a1' }, v2: { delivery_class: 'd1' } } };
  assert.ok(publishIssues(c).some((i) => i.startsWith('products.split: no version has both')));
  assert.equal(mappingResolves(c, 'split'), false);
  c.products.split.delivery_class = 'd2';
  assert.equal(mappingResolves(c, 'split'), true, 'v1 + the product class resolves');
  assert.ok(!publishIssues(c).some((i) => i.startsWith('products.split')));
  c.products.base = { ...A1 };
  assert.equal(mappingResolves(c, 'base'), true);
  assert.equal(mappingResolves(c, 'missing'), false);
  assert.equal(mappingResolves(c, 'constructor'), false, 'never an inherited key');
  assert.equal(mappingResolves(null, 'base'), false);
});

test('an unpriced option is a blocker, never a made-up number', () => {
  const c = clone();
  c.warranty.w24.h3c = null;
  const p = priceServices(c, H3C, confirmed({ ...EMPTY_SELECTION, warranty: 'w24' }));
  assert.ok(p.blockers.includes(SERVICES_OPTION_UNAVAILABLE));
  assert.equal(presetPrices(c, H3C).complete, null);
});

test('delivery is priced by class and kept out of the line fee', () => {
  const c = clone();
  const econ = priceServices(c, H3C, confirmed({ ...EMPTY_SELECTION, ack_no_warranty: true, delivery: 'economy' }));
  const pers = priceServices(c, H3C, confirmed({ ...EMPTY_SELECTION, ack_no_warranty: true, delivery: 'personal' }));
  assert.equal(econ.delivery_fee_iqd, 20_000);
  assert.equal(pers.delivery_fee_iqd, 65_000);
  assert.equal(pers.fee_iqd, 0);
  const none = priceServices(c, H3C, confirmed({ ...EMPTY_SELECTION, ack_no_warranty: true }));
  assert.equal(none.delivery_fee_iqd, null);
  assert.deepEqual(none.delivery_options, { economy_iqd: 20_000, personal_iqd: 65_000 });
});

test('live Academy costs 50,000 whichever way it is held; recorded videos are free', () => {
  const c = clone();
  for (const academy of ['live_whatsapp', 'live_in_person'] as const) {
    assert.equal(priceServices(c, A1, confirmed({ ...EMPTY_SELECTION, ack_no_warranty: true, academy })).fee_iqd, 50_000);
  }
  assert.equal(priceServices(c, A1, confirmed({ ...EMPTY_SELECTION, ack_no_warranty: true })).fee_iqd, 0);
});

test('the selection round-trips canonically; junk is refused', () => {
  const s = confirmed(presetSelection(clone(), 'complete', 'personal'));
  assert.deepEqual(parseSelection(encodeSelection(s)), s);
  assert.equal(encodeSelection(parseSelection(JSON.parse(encodeSelection(s)))!), encodeSelection(s));
  assert.equal(parseSelection('{"v":1,"package":"gold"}'), null);
  assert.equal(parseSelection(''), null);
  assert.equal(parseSelection('not json'), null);
  assert.ok(sameServices(s, { ...s, delivery: 'economy' }));
  assert.ok(!sameServices(s, { ...s, inspection: 'none' }));
});

test('preset prices per printer for the package cards', () => {
  const c = clone();
  assert.deepEqual(presetPrices(c, A1), { just: 0, smart: 44_000, complete: 100_000 + 19_000 + 7_000 + 5_000 });
});

test('the refusal dictionary carries the printer-services refusals word for word (copied, never drifted)', async () => {
  const { SERVICES_ERRORS } = await import('../src/components/product/printerServicesStrings');
  const { REFUSAL_STRINGS } = await import('../src/lib/refusalStrings');
  for (const [code, words] of Object.entries(SERVICES_ERRORS)) {
    assert.deepEqual({ ar: REFUSAL_STRINGS[code]?.ar, en: REFUSAL_STRINGS[code]?.en, ckb: REFUSAL_STRINGS[code]?.ckb }, words, code);
  }
});

// ---------------------------------------------------------------- phase 3: the Levo Care terms (DECISIONS row 347)

test('phase 3: the seeded draft carries Care terms and no inspection labour figure; a stored config without them reads null', () => {
  const c = DEFAULT_PRINTER_SERVICES;
  assert.ok(c.care.terms && c.care.terms.eligible_parts.length > 0);
  assert.equal(c.inspection.labor_iqd, null);
  // Every seeded label and exclusion has its own Sorani.
  for (const t of [...c.care.terms!.eligible_parts.map((p) => p.label), ...c.care.terms!.exclusions]) {
    assert.ok(t.ar && t.en && t.ckb && t.ckb !== t.ar && t.ckb !== t.en, JSON.stringify(t));
  }
  // A config saved before phase 3: no terms, no labour — null, never the seeded defaults.
  const old = clone() as unknown as Record<string, any>;
  delete old.care.terms;
  delete old.inspection.labor_iqd;
  assert.deepEqual(configIssues(old), []);
  const read = withPhase2Defaults(old as PrinterServicesConfig);
  assert.equal(read.care.terms, null);
  assert.equal(read.inspection.labor_iqd, null);
  // …and an active, priced Care cannot be published until the terms are written.
  const mapped = { ...read, products: { p_a1: { ...A1 } } };
  assert.ok(publishIssues(mapped).some((i) => i.startsWith('care.terms')));
  assert.ok(!publishIssues({ ...mapped, care: { ...mapped.care, active: false } }).some((i) => i.startsWith('care.terms')));
});

test('phase 3: configIssues judges the Care terms and the labour figure', () => {
  const bad = clone() as unknown as Record<string, any>;
  bad.care.max_discount_pct = 40;
  bad.care.terms = {
    eligible_parts: [{ key: 'Nozzle!', label: { ar: 'x', en: 'x', ckb: 'x' } }, { key: 'fan', label: { ar: 'x' } }, { key: 'fan', label: { ar: 'a', en: 'b', ckb: 'c' } }],
    discount_pct: 50, max_claims: 0, max_benefit_iqd: 1.5, labor: 'free', shipping: 'discounted', exclusions: [{ ar: 'x'.repeat(201), en: '', ckb: '' }],
  };
  bad.inspection.labor_iqd = -1;
  const issues = configIssues(bad);
  for (const needle of ['eligible_parts[0].key', 'eligible_parts[1].label', 'eligible_parts[2].key: used twice', 'discount_pct: 0..care.max_discount_pct',
    'max_claims', 'max_benefit_iqd', 'care.terms.labor', 'exclusions[0]', 'inspection.labor_iqd']) {
    assert.ok(issues.some((i) => i.includes(needle)), `${needle}: ${issues.join(' | ')}`);
  }
  // null money cap and a set labour figure are valid; canonicalConfig keeps both and trims the texts.
  const ok = clone();
  ok.care.terms = { ...ok.care.terms!, max_benefit_iqd: null, exclusions: [{ ar: ' حريق ', en: ' Fire ', ckb: ' ئاگر ' }] };
  ok.inspection.labor_iqd = 3_000;
  assert.deepEqual(configIssues(ok), []);
  const canon = canonicalConfig({ ...ok, care: { ...ok.care, terms: { ...ok.care.terms!, junk: 1 } as never } });
  assert.equal(canon.care.terms!.max_benefit_iqd, null);
  assert.deepEqual(canon.care.terms!.exclusions, [{ ar: 'حريق', en: 'Fire', ckb: 'ئاگر' }]);
  assert.equal((canon.care.terms as unknown as Record<string, unknown>).junk, undefined);
  assert.equal(canon.inspection.labor_iqd, 3_000);
});
