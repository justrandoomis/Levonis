/**
 * «الاستبدال» — THE VALUATION ENGINE, ITS RULES AND ITS STATUS MACHINE.
 *
 * Pure: packages/pricing/src/tradeIn.ts has no I/O, so every rule the owner
 * named — each factor, the bands, the floor and the cap, the rounding, the
 * negative-difference rule, the family differences — is proved here with
 * arithmetic a person can check. The last tests hold the migration's seeded
 * rows to the engine's DEFAULT_RULE_SETS and the Combo → AMS split.
 *
 * Run: node --import tsx --test tests/tradeIn.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RULE_SETS,
  FACTOR_IDS,
  REQUIRED_PHOTOS,
  TRADE_IN_FAMILIES,
  TRADE_IN_STATUSES,
  blankInputs,
  canTransition,
  missingPhotoAngles,
  rolesForScope,
  tradeInSettlement,
  validateInputs,
  validateRuleSet,
  valuateComponent,
  warrantyMonthsLeft,
  wholeMonthsBetween,
  isAllowedAngle,
  type ComponentInputs,
  type FactorRule,
  type TradeInRuleSet,
} from '../packages/pricing/src/tradeIn';
import { amsSplit, loadRuleBook, paidPerUnit } from '../worker/lib/tradeIn';
import { asD1, freshDb } from './fixtures/app';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A rule set with every factor OFF except the ones named — one factor at a time. */
function only(family: keyof typeof DEFAULT_RULE_SETS, ...ids: string[]): TradeInRuleSet {
  const r = clone(DEFAULT_RULE_SETS[family]);
  r.floor_bp = 0;
  // Above 100% only here, so a bonus is visible in isolation; the editor
  // caps a real rule set at 10,000.
  r.cap_bp = 20_000;
  r.rounding_iqd = 1;
  for (const f of r.factors) f.enabled = ids.includes(f.factor);
  return r;
}
const factor = (r: TradeInRuleSet, id: string): FactorRule => r.factors.find((f) => f.factor === id)!;
const ctx = (over: Partial<{ base_iqd: number; usage_months: number; warranty_remaining_months: number; product_id: string }> = {}) => ({
  base_iqd: 1_000_000,
  usage_months: 0,
  warranty_remaining_months: 0,
  product_id: 'p1',
  ...over,
});
const inputs = (over: Partial<ComponentInputs> = {}): ComponentInputs => ({ ...blankInputs('fdm'), ...over });
const sum = (v: ReturnType<typeof valuateComponent>) => v.lines.reduce((s, l) => s + l.amount_iqd, 0);

// ------------------------------------------------------------ each factor

test('usage age: per-month depreciation, after the grace months, capped', () => {
  const r = only('fdm', 'usage_age');
  const v = valuateComponent(r, ctx({ usage_months: 10 }), inputs());
  // 10 × 150 bp = 1,500 bp of 1,000,000 = 150,000.
  assert.equal(v.value_iqd, 850_000);
  assert.deepEqual(v.lines.map((l) => l.factor), ['base', 'usage_age']);
  assert.equal(v.lines[1].effect_bp, -1500);
  assert.equal(valuateComponent(r, ctx({ usage_months: 100 }), inputs()).value_iqd, 1_000_000 - 450_000, 'capped at 4,500 bp');
  factor(r, 'usage_age').config = { kind: 'age', per_month_bp: 150, max_bp: 4500, grace_months: 4 };
  assert.equal(valuateComponent(r, ctx({ usage_months: 10 }), inputs()).value_iqd, 910_000, '6 billable months');
});

test('warranty remaining: a bonus per month left, capped', () => {
  const r = only('fdm', 'warranty_remaining');
  assert.equal(valuateComponent(r, ctx({ warranty_remaining_months: 5 }), inputs()).value_iqd, 1_030_000);
  assert.equal(valuateComponent(r, ctx({ warranty_remaining_months: 36 }), inputs()).value_iqd, 1_080_000, 'capped at 800 bp');
});

test('operating hours: the first band that holds the hours; the open band catches the rest', () => {
  const r = only('fdm', 'operating_hours');
  const at = (h: number) => valuateComponent(r, ctx(), inputs({ hours: h })).value_iqd;
  assert.equal(at(0), 1_000_000);
  assert.equal(at(300), 1_000_000, 'up_to is inclusive');
  assert.equal(at(301), 970_000);
  assert.equal(at(1500), 930_000);
  assert.equal(at(2999), 870_000);
  assert.equal(at(50_000), 800_000);
});

test('the three 1–5 scales read effects_bp[score − 1]', () => {
  const r = only('fdm', 'cleanliness', 'exterior', 'scratches');
  const v = valuateComponent(r, ctx(), inputs({ cleanliness: 1, exterior: 5, scratches: 3 }));
  // −800 + 100 − 150 = −850 bp.
  assert.equal(v.value_iqd, 915_000);
  assert.deepEqual(v.lines.map((l) => [l.factor, l.effect_bp]), [['base', 0], ['cleanliness', -800], ['exterior', 100], ['scratches', -150]]);
});

test('faults and replaced parts: ticked items add up, and the total is capped', () => {
  const r = only('fdm', 'faults');
  assert.equal(valuateComponent(r, ctx(), inputs({ faults: ['nozzle_clog', 'wifi'] })).value_iqd, 940_000);
  const all = factor(r, 'faults').config;
  assert.equal(all.kind, 'checklist');
  const every = all.kind === 'checklist' ? all.items.map((i) => i.id) : [];
  assert.equal(valuateComponent(r, ctx(), inputs({ faults: every })).value_iqd, 400_000, 'capped at −6,000 bp');
  const p = only('fdm', 'replaced_parts');
  assert.equal(valuateComponent(p, ctx(), inputs({ replaced_parts: ['mainboard', 'nozzle'] })).value_iqd, 940_000);
});

test('repairs: per repair, capped', () => {
  const r = only('fdm', 'repairs');
  assert.equal(valuateComponent(r, ctx(), inputs({ repairs_count: 2 })).value_iqd, 940_000);
  assert.equal(valuateComponent(r, ctx(), inputs({ repairs_count: 20 })).value_iqd, 880_000);
});

test('accessories: their condition and whether the originals are present', () => {
  const r = only('fdm', 'accessory_condition', 'original_accessories');
  assert.equal(valuateComponent(r, ctx(), inputs({ accessory_condition: 2, original_accessories: 'partial' })).value_iqd, 950_000);
  assert.equal(valuateComponent(r, ctx(), inputs({ accessory_condition: 4, original_accessories: 'none' })).value_iqd, 930_000);
});

test('market: the family resale view, overridden per product', () => {
  const r = only('fdm', 'market');
  assert.equal(valuateComponent(r, ctx(), inputs()).value_iqd, 900_000);
  factor(r, 'market').config = { kind: 'market', resale_bp: -1000, product_overrides: [{ product_id: 'p1', effect_bp: -300 }] };
  assert.equal(valuateComponent(r, ctx(), inputs()).value_iqd, 970_000);
  assert.equal(valuateComponent(r, ctx({ product_id: 'p2' }), inputs()).value_iqd, 900_000);
});

test('product type: one flat effect per family — resin and laser start lower than FDM', () => {
  const at = (f: 'fdm' | 'resin' | 'laser' | 'accessory') =>
    valuateComponent(only(f, 'product_type'), ctx(), { ...blankInputs(f) }).value_iqd;
  assert.equal(at('fdm'), 1_000_000);
  assert.equal(at('resin'), 950_000);
  assert.equal(at('laser'), 970_000);
  assert.equal(at('accessory'), 900_000);
});

test('the weight scales a factor’s effect («نسبة تأثير مستقلة»); zero or disabled prints nothing', () => {
  const r = only('fdm', 'exterior');
  factor(r, 'exterior').weight_bp = 5000;
  const v = valuateComponent(r, ctx(), inputs({ exterior: 1 }));
  assert.equal(v.lines[1].effect_bp, -600, 'half of −1,200');
  assert.equal(v.value_iqd, 940_000);
  factor(r, 'exterior').weight_bp = 20_000;
  assert.equal(valuateComponent(r, ctx(), inputs({ exterior: 1 })).value_iqd, 760_000, 'double');
  factor(r, 'exterior').weight_bp = 0;
  assert.deepEqual(valuateComponent(r, ctx(), inputs({ exterior: 1 })).lines.map((l) => l.factor), ['base']);
});

// ------------------------------------------------------------ clamp and rounding

test('the floor and the cap are their own lines, and the lines always add up to the value', () => {
  const r = clone(DEFAULT_RULE_SETS.fdm);
  // Everything bad: far below the 10% floor.
  const worst = valuateComponent(
    r,
    ctx({ usage_months: 60 }),
    inputs({ hours: 9999, cleanliness: 1, exterior: 1, scratches: 1, faults: ['mainboard', 'heating_error', 'screen_touch'], repairs_count: 9, original_accessories: 'none', accessory_condition: 1 })
  );
  assert.equal(worst.value_iqd, 100_000);
  assert.equal(worst.lines.at(-1)!.factor, 'clamp');
  assert.equal(sum(worst), worst.value_iqd);
  // Everything good plus a long warranty and a generous market: capped at 85%.
  factor(r, 'market').config = { kind: 'market', resale_bp: 5000, product_overrides: [] };
  const best = valuateComponent(r, ctx({ warranty_remaining_months: 24 }), inputs({ exterior: 5 }));
  assert.equal(best.value_iqd, 850_000);
  assert.equal(best.cap_iqd, 850_000);
  assert.equal(sum(best), best.value_iqd);
});

test('rounding goes DOWN to the rule’s step, as its own line', () => {
  const r = only('fdm', 'usage_age');
  r.rounding_iqd = 1000;
  const v = valuateComponent(r, ctx({ base_iqd: 1_234_567, usage_months: 1 }), inputs());
  // 1,234,567 − trunc(1,234,567 × 150 / 10,000) = 1,234,567 − 18,518 = 1,216,049 → 1,216,000.
  assert.equal(v.value_iqd, 1_216_000);
  assert.equal(v.lines.at(-1)!.factor, 'rounding');
  assert.equal(v.lines.at(-1)!.amount_iqd, -49);
  assert.equal(sum(v), v.value_iqd);
  for (const l of v.lines) assert.ok(Number.isSafeInteger(l.amount_iqd), 'every amount is integer dinars');
});

test('an AMS has no hour counter: the hours factor never prints for it', () => {
  const r = clone(DEFAULT_RULE_SETS.ams);
  const v = valuateComponent(r, ctx({ base_iqd: 300_000, usage_months: 12 }), blankInputs('ams'));
  assert.ok(!v.lines.some((l) => l.factor === 'operating_hours'));
  // 12 × 120 = 1,440 bp; market −1,000 → 300,000 × 0.756 = 226,800 → 226,000.
  assert.equal(v.value_iqd, 226_000);
});

test('the same answers are worth less on a resin machine than on an FDM one', () => {
  const answers = (f: 'fdm' | 'resin') => ({ ...blankInputs(f), hours: 600 });
  const fdm = valuateComponent(DEFAULT_RULE_SETS.fdm, ctx({ usage_months: 12 }), answers('fdm')).value_iqd;
  const resin = valuateComponent(DEFAULT_RULE_SETS.resin, ctx({ usage_months: 12 }), answers('resin')).value_iqd;
  assert.ok(resin < fdm, `${resin} < ${fdm}`);
});

// ------------------------------------------------------------ the settlement

test('the difference: target − value; a value above the target is capped, never paid out', () => {
  assert.deepEqual(tradeInSettlement(1_500_000, 400_000), {
    target_price_iqd: 1_500_000,
    trade_in_value_iqd: 400_000,
    credit_iqd: 400_000,
    difference_iqd: 1_100_000,
    excess_iqd: 0,
  });
  const over = tradeInSettlement(300_000, 450_000);
  assert.equal(over.credit_iqd, 300_000);
  assert.equal(over.difference_iqd, 0);
  assert.equal(over.excess_iqd, 150_000);
});

// ------------------------------------------------------------ time

test('months used and months of warranty left', () => {
  assert.equal(wholeMonthsBetween('2025-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z'), 12);
  assert.equal(wholeMonthsBetween(null, '2026-09-26T00:00:00.000Z'), 0);
  assert.equal(warrantyMonthsLeft('2026-10-06T00:00:00.000Z', '2026-09-26T00:00:00.000Z'), 1, 'ten days is a month of cover');
  assert.equal(warrantyMonthsLeft('2026-01-01T00:00:00.000Z', '2026-09-26T00:00:00.000Z'), 0);
});

// ------------------------------------------------------------ inputs

test('answers are validated against the family’s own allow-list', () => {
  const fdm = DEFAULT_RULE_SETS.fdm;
  assert.equal(validateInputs(blankInputs('fdm'), fdm).ok, true);
  const bad = validateInputs({ ...blankInputs('fdm'), faults: ['mainboard', 'no_fault_bonus'] }, fdm);
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors.includes('faults:no_fault_bonus'));
  assert.equal(validateInputs({ ...blankInputs('fdm'), hours: -1 }, fdm).ok, false);
  assert.equal(validateInputs({ ...blankInputs('fdm'), hours: 1.5 }, fdm).ok, false, 'integer hours');
  assert.equal(validateInputs({ ...blankInputs('fdm'), cleanliness: 6 }, fdm).ok, false);
  assert.equal(validateInputs({ ...blankInputs('fdm'), original_accessories: 'most' }, fdm).ok, false);
  // An AMS answer carries no hours even when the client sends some.
  const ams = validateInputs({ ...blankInputs('ams'), hours: 400 }, DEFAULT_RULE_SETS.ams);
  assert.ok(ams.ok && ams.value.hours === null);
  // Notes are cleaned and capped.
  const noted = validateInputs({ ...blankInputs('fdm'), notes: `  hi\u0000there ${'x'.repeat(2000)}` }, fdm);
  assert.ok(noted.ok && noted.value.notes.length === 1000 && !noted.value.notes.includes('\u0000'));
});

// ------------------------------------------------------------ the rules editor

test('every seeded default is a valid rule set with all thirteen factors', () => {
  for (const f of TRADE_IN_FAMILIES) {
    const r = validateRuleSet(DEFAULT_RULE_SETS[f], f);
    assert.ok(r.ok, `${f}: ${!r.ok ? r.errors.join(', ') : ''}`);
    assert.deepEqual(DEFAULT_RULE_SETS[f].factors.map((x) => x.factor).sort(), [...FACTOR_IDS].sort());
  }
});

test('the rules editor refuses what the engine could not honestly price', () => {
  const base = clone(DEFAULT_RULE_SETS.fdm);
  const errs = (mut: (r: TradeInRuleSet) => void) => {
    const r = clone(base);
    mut(r);
    const out = validateRuleSet(r, 'fdm');
    return out.ok ? [] : out.errors;
  };
  assert.ok(errs((r) => (r.floor_bp = 9000)).includes('floor_above_cap'));
  assert.ok(errs((r) => (r.factors = r.factors.filter((f) => f.factor !== 'market'))).includes('market.missing'));
  assert.ok(errs((r) => (factor(r, 'exterior').weight_bp = 20_001)).includes('exterior.weight_bp'));
  assert.ok(errs((r) => (factor(r, 'exterior').weight_bp = 1.5)).includes('exterior.weight_bp'), 'integers only');
  assert.ok(
    errs((r) => (factor(r, 'operating_hours').config = { kind: 'hours', bands: [{ up_to: 500, effect_bp: 0 }, { up_to: 300, effect_bp: -100 }, { up_to: null, effect_bp: -200 }] })).some((e) =>
      e.startsWith('operating_hours.bands[1]')
    ),
    'bands ascend'
  );
  assert.ok(
    errs((r) => (factor(r, 'operating_hours').config = { kind: 'hours', bands: [{ up_to: 500, effect_bp: 0 }] })).includes('operating_hours.bands.last_open'),
    'the last band is open-ended'
  );
  assert.ok(
    errs((r) => {
      const c = factor(r, 'faults').config;
      if (c.kind === 'checklist') c.items.push({ ...c.items[0] });
    }).some((e) => e.startsWith('faults.items[')),
    'checklist ids are unique'
  );
  assert.ok(errs((r) => (factor(r, 'scratches').config = { kind: 'scale', effects_bp: [0, 0, 0, 0] as never })).includes('scratches.effects_bp'));
  assert.ok(errs((r) => (factor(r, 'cleanliness').config = { kind: 'flat', effect_bp: 0 })).includes('cleanliness.kind'), 'a factor never changes shape');
  assert.ok(errs((r) => (factor(r, 'market').config = { kind: 'market', resale_bp: 0, product_overrides: [{ product_id: '../x', effect_bp: 0 }] })).some((e) => e.startsWith('market.product_overrides')));
});

// ------------------------------------------------------------ photos

test('the required photographs differ by family, and damage close-ups are optional', () => {
  assert.ok(REQUIRED_PHOTOS.resin.some((a) => a.id === 'vat') && REQUIRED_PHOTOS.resin.some((a) => a.id === 'lcd_screen'));
  assert.ok(REQUIRED_PHOTOS.laser.some((a) => a.id === 'lens') && REQUIRED_PHOTOS.laser.some((a) => a.id === 'laser_module'));
  assert.ok(REQUIRED_PHOTOS.ams.some((a) => a.id === 'interior'));
  assert.ok(REQUIRED_PHOTOS.fdm.some((a) => a.id === 'hotend'));
  assert.deepEqual(missingPhotoAngles('ams', ['front', 'interior', 'damage']), ['back', 'serial']);
  assert.deepEqual(missingPhotoAngles('ams', ['front', 'interior', 'back', 'serial']), []);
  assert.equal(isAllowedAngle('ams', 'lens'), false);
  assert.equal(isAllowedAngle('ams', 'damage'), true);
});

// ------------------------------------------------------------ status machine

test('the status machine: only the owner’s arrows exist', () => {
  const yes: Array<[string, string]> = [
    ['draft', 'submitted'],
    ['submitted', 'under_review'],
    ['submitted', 'approved_as_estimated'],
    ['under_review', 'value_changed'],
    ['value_changed', 'value_changed'],
    ['value_changed', 'customer_accepted'],
    ['value_changed', 'customer_rejected'],
    ['approved_as_estimated', 'awaiting_payment'],
    ['customer_accepted', 'awaiting_payment'],
    ['awaiting_payment', 'completed'],
    ['awaiting_payment', 'cancelled'],
    ['draft', 'cancelled'],
  ];
  for (const [a, b] of yes) assert.equal(canTransition(a as never, b as never), true, `${a} → ${b}`);
  const no: Array<[string, string]> = [
    ['draft', 'awaiting_payment'],
    ['submitted', 'completed'],
    ['value_changed', 'awaiting_payment'],
    ['customer_rejected', 'awaiting_payment'],
    ['completed', 'cancelled'],
    ['cancelled', 'submitted'],
    ['awaiting_payment', 'value_changed'],
  ];
  for (const [a, b] of no) assert.equal(canTransition(a as never, b as never), false, `${a} ↛ ${b}`);
  assert.equal(TRADE_IN_STATUSES.length, 10);
});

test('a Combo trades whole, printer only or AMS only; anything else trades whole', () => {
  assert.deepEqual(rolesForScope('whole', true), ['device', 'ams']);
  assert.deepEqual(rolesForScope('printer_only', true), ['device']);
  assert.deepEqual(rolesForScope('ams_only', true), ['ams']);
  assert.deepEqual(rolesForScope('whole', false), ['device']);
  assert.deepEqual(rolesForScope('ams_only', false), []);
});

// ------------------------------------------------------------ the Worker's pure parts

const v = (id: string, name: string, key: string | null, price: number | null) => ({
  id,
  product_id: 'p_a1',
  group_id: 'g1',
  name_en: name,
  name_ar: name,
  variant_key: key,
  regular_price_iqd: price,
  regular_adjust_iqd: null,
  active: 1,
  merged_into: null,
});

test('the AMS of a Combo is the gap to its plain sibling, as a share of what was PAID', () => {
  const combo = v('c', 'A1 Combo', 'a1-combo', 1_150_000);
  const plain = v('p', 'A1', 'a1', 850_000);
  const s = amsSplit({ paidIqd: 1_100_000, combo, siblings: [combo, plain], productPriceIqd: 850_000, referenceIqd: 0 });
  assert.equal(s.method, 'option_gap');
  assert.equal(s.share_bp, 2608); // 300,000 / 1,150,000
  assert.equal(s.ams_base_iqd, 286_880);
  // No sibling: the owner's reference, capped at half the paid price.
  const ref = amsSplit({ paidIqd: 500_000, combo, siblings: [combo], productPriceIqd: 850_000, referenceIqd: 400_000 });
  assert.deepEqual(ref, { method: 'reference', share_bp: null, ams_base_iqd: 250_000 });
  // Neither: unknown, said as such.
  assert.equal(amsSplit({ paidIqd: 500_000, combo, siblings: [combo], productPriceIqd: 0, referenceIqd: 0 }).method, 'none');
});

test('the base is what ONE unit cost the customer: minus the warranty fee and the line’s own discounts', () => {
  assert.equal(
    paidPerUnit({ unit_price_iqd: 1_100_000, qty: 2, warranty_snapshot: JSON.stringify({ fee_iqd: 50_000 }), membership_discount_iqd: 20_000, coupon_discount_iqd: 10_000 }),
    1_035_000
  );
  assert.equal(paidPerUnit({ unit_price_iqd: 900_000, qty: 1, warranty_snapshot: null, membership_discount_iqd: null, coupon_discount_iqd: null }), 900_000);
});

test('migration 0143 seeds EXACTLY the engine’s defaults, version 1, marked as defaults', async () => {
  const book = await loadRuleBook(asD1(freshDb()));
  for (const f of TRADE_IN_FAMILIES) {
    const got = book[f];
    const want = DEFAULT_RULE_SETS[f];
    assert.equal(got.version, 1);
    assert.equal(got.is_default, true, `${f} is marked default`);
    for (const k of ['floor_bp', 'cap_bp', 'rounding_iqd', 'min_base_iqd', 'ams_reference_iqd'] as const) assert.equal(got[k], want[k], `${f}.${k}`);
    assert.deepEqual(
      [...got.factors].sort((a, b) => a.factor.localeCompare(b.factor)),
      [...want.factors].sort((a, b) => a.factor.localeCompare(b.factor)),
      `${f} factors`
    );
  }
});
