/**
 * THE MERCHANT'S RULES AND THE BUILD VOLUME (Programme C, C1 lane L2;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 3, P15; the brief's «smart
 * constraints»: prevent, auto-adjust when safe, explain, suggest).
 *
 * Pins: each `if` (a text longer than n graphemes — roster names included —,
 * a slot option, a filled QR, a variant's axis value) and each `then`
 * (size_at_least, requires, excludes, only_colors, max_colors), satisfied and
 * not; the ONE fix each rule offers, with its price delta; `auto` only when
 * the merchant said auto AND the fix is price-neutral (P15), a priced fix is
 * always a suggestion; fitsInBuild in every orientation (the same answer as
 * the eligibility engine's permutations); sizes above the printer, and
 * variants sold out, are never offered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourChoices, evaluateRules, fitsInBuild, mergeColours, ruleApplies, sizeValuesInBuild, stockedKeys, withPublic, type RulesContext } from '../packages/catalog/src/personalize/rules';
import { customerColours, partKey, priceConfig, priceContextFromPublic } from '../packages/catalog/src/personalize/price';
import type { DesignConfig, PublicBlueprint, Rule } from '../packages/catalog/src/personalize/types';
import { fitsInBuild as eligibilityFits } from '../worker/lib/eligibility';
import { FIXTURES, GOLDEN_CONFIG } from './fixtures/personalizeBlueprints';
import { FEES_CONFIG, FEES_PUB, SHELF_STOCK, configOf, prng, qrPanel, shelfPub } from './fixtures/personalizeMoney';

const STAND = FIXTURES.nameStand.pub;
const ROTATING = FIXTURES.rotatingDisplay.pub;
const clone = <T>(v: T): T => structuredClone(v);
const ctxOf = (pub: PublicBlueprint, c: DesignConfig, more: Partial<RulesContext> = {}): RulesContext => ({ price: priceContextFromPublic(pub, c.variant), ...more });
const outcome = (pub: PublicBlueprint, c: DesignConfig, id: string, more: Partial<RulesContext> = {}) => evaluateRules(pub, c, ctxOf(pub, c, more)).find((o) => o.rule === id);
const unit = (pub: PublicBlueprint, c: DesignConfig) => priceConfig(pub, c, priceContextFromPublic(pub, c.variant)).unit_iqd;
const stand = (variant: string, set: (c: Record<string, any>) => void = () => {}) => // eslint-disable-line @typescript-eslint/no-explicit-any
  configOf(STAND, (c) => {
    c.texts.name.value = ['ALI'];
    set(c);
  }, variant);

// ------------------------------------------------------------ size_at_least

test('size_at_least for a text length: longer than n graphemes asks for the size — a priced suggestion to the smallest size that satisfies it', () => {
  const long = stand('pv_s_classic', (c) => (c.texts.name.value = ['ABCDEFGHIJK']));
  const o = outcome(STAND, long, 'long-name')!;
  assert.equal(o.satisfied, false);
  assert.equal(o.say, 'text_needs_size');
  assert.equal(o.fix!.kind, 'suggest');
  assert.equal(o.fix!.config.variant, 'pv_m_classic', 'the smallest size from the rule\'s value up, the same look');
  assert.equal(o.fix!.delta_iqd, 3_000);
  assert.equal(o.fix!.delta_iqd, unit(STAND, o.fix!.config) - unit(STAND, long), 'the delta is the whole price difference');
  // Ten graphemes is not longer than ten: the rule does not apply at all.
  assert.equal(outcome(STAND, stand('pv_s_classic', (c) => (c.texts.name.value = ['ABCDEFGHIJ'])), 'long-name'), undefined);
  // Graphemes, not code units: eleven Sorani letters with a ZWNJ count as eleven.
  assert.equal(outcome(STAND, stand('pv_s_classic', (c) => (c.texts.name.value = ['ئەڤینی‌ئاسۆکە'])), 'long-name')?.satisfied, false);
  // At the size or above: satisfied, no fix.
  assert.deepEqual(outcome(STAND, stand('pv_m_classic', (c) => (c.texts.name.value = ['ABCDEFGHIJK'])), 'long-name'), { rule: 'long-name', satisfied: true, say: 'text_needs_size' });
  // A roster name counts: the whole line is made at one size.
  const roster = { ...stand('pv_s_classic'), roster: [{ n: 1, texts: { name: ['ABCDEFGHIJKL'] } }] };
  assert.ok(ruleApplies(STAND, roster, ctxOf(STAND, roster), { text: 'name', longer_than: 10 }));
});

test('size_at_least for an add-on: the big magnet asks for Large — never a size the product does not sell in stock, nor one above the printer', () => {
  const classic = stand('pv_m_classic', (c) => (c.slots.magnet = { option: 'm15' }));
  const o = outcome(STAND, classic, 'big-magnet')!;
  assert.equal(o.satisfied, false);
  assert.equal(o.fix!.config.variant, 'pv_l_classic');
  assert.equal(o.fix!.kind, 'suggest');
  assert.equal(o.fix!.delta_iqd, 3_000);
  // Large silk is sold out: no fix is offered.
  const silk = stand('pv_m_silk', (c) => {
    c.slots.magnet = { option: 'm15' };
    c.colors.body = 'black';
  });
  assert.equal(outcome(STAND, silk, 'big-magnet')!.fix, undefined);
  // Large is above a 160 mm printer: not offered either.
  assert.equal(outcome(STAND, classic, 'big-magnet', { printer: { max_mm: [160, 160, 160] } })!.fix, undefined);
  // Already large: satisfied.
  assert.equal(outcome(STAND, stand('pv_l_classic', (c) => (c.slots.magnet = { option: 'm15' })), 'big-magnet')!.satisfied, true);
});

test('size_at_least for a QR: a filled code asks for the size; an empty one does not', () => {
  const rule: Rule = { id: 'big-qr', if: { qr: 'qr' }, then: { size_at_least: 'ov_m' }, fix: 'suggest', say: 'qr_needs_size' };
  const pub = qrPanel({ rules: [rule] });
  const filled = configOf(pub, (c) => (c.qr.qr = { kind: 'instagram', value: 'ali.prints' }), 'pv_s');
  const o = outcome(pub, filled, 'big-qr')!;
  assert.equal(o.fix!.config.variant, 'pv_m');
  assert.equal(o.fix!.delta_iqd, 2_000);
  assert.equal(outcome(pub, configOf(pub, () => {}, 'pv_s'), 'big-qr'), undefined);
});

// ------------------------------------------------------------ requires / excludes

test('requires: the slot on that option — a priced fix is a suggestion even when the merchant said auto; an option out of stock is never offered', () => {
  const big = { ...clone(GOLDEN_CONFIG), slots: { ...GOLDEN_CONFIG.slots, magnet: { option: 'm20' } } };
  const o = outcome(ROTATING, big, 'big-magnet')!;
  assert.equal(o.satisfied, false);
  assert.equal(o.say, 'addon_needs_addon');
  assert.deepEqual(o.fix!.config.slots.motor, { option: 'b' });
  assert.equal(o.fix!.kind, 'suggest');
  assert.equal(o.fix!.delta_iqd, 3_000);
  const auto = { ...ROTATING, rules: ROTATING.rules.map((r) => ({ ...r, fix: 'auto' as const })) };
  assert.equal(outcome(auto, big, 'big-magnet')!.fix!.kind, 'suggest', 'priced: never automatic');
  // Motor B sold out: nothing to offer.
  const out = { ...ROTATING, slot_options: { ...ROTATING.slot_options, motor: ROTATING.slot_options.motor.map((x) => (x.key === 'b' ? { ...x, in_stock: false } : x)) } };
  assert.equal(outcome(out, big, 'big-magnet')!.fix, undefined);
  // Satisfied once motor B is chosen.
  assert.equal(outcome(ROTATING, { ...big, slots: { ...big.slots, motor: { option: 'b' } } }, 'big-magnet')!.satisfied, true);
});

test('excludes: an optional slot is emptied, a required one goes to its default — automatic only at the same price', () => {
  const emptyIt: Rule = { id: 'no-rgb', if: { slot: 'motor', is: 'b' }, then: { excludes: { slot: 'lighting', is: 'rgb' } }, fix: 'auto', say: 'addons_conflict' };
  const back: Rule = { id: 'no-b', if: { slot: 'lighting', is: 'rgb' }, then: { excludes: { slot: 'motor', is: 'b' } }, fix: 'auto', say: 'addons_conflict' };
  const pub = { ...ROTATING, rules: [emptyIt, back] };
  const both = { ...clone(GOLDEN_CONFIG), slots: { ...GOLDEN_CONFIG.slots, motor: { option: 'b' } } };
  const a = outcome(pub, both, 'no-rgb')!;
  assert.deepEqual(a.fix!.config.slots.lighting, { option: null }, 'the optional light is taken out');
  assert.deepEqual([a.fix!.kind, a.fix!.delta_iqd], ['suggest', -5_000], 'cheaper is still a price change: a suggestion');
  const b = outcome(pub, both, 'no-b')!;
  assert.deepEqual(b.fix!.config.slots.motor, { option: 'a' }, 'the required motor goes back to its default');
  assert.deepEqual([b.fix!.kind, b.fix!.delta_iqd], ['suggest', -3_000]);
  // With motor B priced like motor A the same fix is price-neutral: automatic.
  const ctx = ctxOf(pub, both);
  const same = { ...ctx, price: { ...ctx.price, parts: { ...ctx.price.parts, [partKey('cp_motor', 'pv_motor_b')]: { unit_iqd: 8_000, in_stock: true } } } };
  const n = evaluateRules(pub, both, same).find((o) => o.rule === 'no-b')!;
  assert.deepEqual([n.fix!.kind, n.fix!.delta_iqd], ['auto', 0]);
  // Outcomes come only for rules whose `if` holds, in spec order.
  assert.deepEqual(evaluateRules(pub, GOLDEN_CONFIG, ctxOf(pub, GOLDEN_CONFIG)).map((o) => o.rule), ['no-b']);
  assert.deepEqual(evaluateRules(pub, both, ctxOf(pub, both)).map((o) => o.rule), ['no-rgb', 'no-b']);
});

// ------------------------------------------------------------ colours

test('only_colors for a look: the nearest colour the target may wear on that look\'s shelf — automatic when price-neutral, else a suggestion', () => {
  const silk = stand('pv_m_silk', (c) => {
    c.colors.body = 'navy';
    c.colors.base = 'gold';
    c.colors.name = 'gold';
  });
  const o = outcome(STAND, silk, 'silk-colours')!;
  assert.equal(o.satisfied, false);
  assert.equal(o.say, 'look_limits_colors');
  // Blue is in the rule but silk blue is the shop's navy (sub:) — not blue itself; gold and silver are finishes further away.
  assert.equal(o.fix!.config.colors.body, 'black');
  assert.deepEqual([o.fix!.kind, o.fix!.delta_iqd], ['auto', 0]);
  // With base black the fix drops a colour (4 → 3, one past the included three): the price changes, so it is only suggested.
  const priced = stand('pv_m_silk', (c) => {
    c.colors.body = 'navy';
    c.colors.base = 'black';
    c.colors.name = 'gold';
  });
  const p = outcome(STAND, priced, 'silk-colours')!;
  assert.deepEqual([p.fix!.kind, p.fix!.delta_iqd], ['suggest', -1_000]);
  // Classic is not silk: the rule does not apply.
  assert.equal(outcome(STAND, stand('pv_m_classic', (c) => (c.colors.body = 'navy')), 'silk-colours'), undefined);
});

test('max_colors: the nearest colours merge — automatic at the same price, a suggestion when the extra-colour fee changes', () => {
  const rule: Rule = { id: 'two', if: { slot: 'magnet', is: 'm15' }, then: { max_colors: 2 }, fix: 'auto', say: 'fewer_colors' };
  const pub = { ...FEES_PUB, rules: [rule] };
  const c = clone(FEES_CONFIG);
  Object.assign(c.colors, { body: 'black', base: 'black', name: 'white', tagline: 'white' });
  assert.deepEqual(customerColours(pub, c), ['black', 'white']);
  assert.equal(outcome(pub, c, 'two')!.satisfied, true);
  c.colors.tagline = 'red';
  const o = outcome(pub, c, 'two')!;
  assert.equal(o.satisfied, false);
  // black–red is the nearest pair, but neither side may wear the other everywhere (the base, the tagline): red joins white.
  assert.deepEqual(o.fix!.config.colors, { ...c.colors, tagline: 'white' });
  assert.deepEqual([o.fix!.kind, o.fix!.delta_iqd], ['suggest', -750], 'one colour fewer past the included two: priced, so suggested');
  const free = { ...pub, colors: { ...pub.colors, per_extra_iqd: 0 } };
  const f = outcome(free, c, 'two')!;
  assert.deepEqual([f.fix!.kind, f.fix!.delta_iqd], ['auto', 0]);
  // Merging gold away also drops its premium: never automatic.
  c.colors.body = 'gold';
  c.colors.tagline = 'white';
  c.colors.name = 'black';
  const g = outcome(free, c, 'two')!;
  assert.equal(g.fix!.kind, 'suggest');
  assert.equal(g.fix!.delta_iqd, unit(free, g.fix!.config) - unit(free, c));
});

test('what a colour target may wear: a \'stocked\' paint the shelf, a list or \'all\' also made to order — never a key out or replaced; only_colors narrows it', () => {
  const pub = shelfPub();
  const c = configOf(pub, () => {});
  const cx = withPublic(pub, ctxOf(pub, c)); // the low-level helpers take a resolved context
  const st = stockedKeys(pub, c, cx)!;
  assert.deepEqual([...st.shelf].sort(), ['black', 'navy', 'teal', 'white'], '`in` keys and every `sub:` target');
  assert.deepEqual(colourChoices(pub, c, cx, 'body'), ['black', 'white', 'teal', 'navy'], 'a \'stocked\' paint: the shelf only');
  assert.deepEqual(colourChoices(pub, c, cx, 'trim'), ['white', 'red', 'blue', 'navy'], 'a list may be made to order');
  assert.equal(colourChoices(pub, c, cx, 'base').length, 21, '\'all\' is every paintable key');
  assert.equal(SHELF_STOCK.default!.blue, 'sub:navy');
  // only_colors in force narrows it.
  const ruled = shelfPub({ axes: { tier: { group: 'og_tier', values: { ov_value: { tier: 'value' }, ov_best: { tier: 'best' } } } }, rules: [{ id: 'best', if: { value: 'ov_best' }, then: { only_colors: { target: 'body', keys: ['navy', 'teal', 'red'] } }, fix: 'auto', say: 'look_limits_colors' }] }, { variants: [{ id: 'pv_value', values: { og_tier: 'ov_value' }, price_iqd: 10_000, in_stock: true }, { id: 'pv_best', values: { og_tier: 'ov_best' }, price_iqd: 12_000, in_stock: true }] });
  const best = configOf(ruled, () => {}, 'pv_best');
  assert.deepEqual(colourChoices(ruled, best, withPublic(ruled, ctxOf(ruled, best)), 'body'), ['teal', 'navy'], 'the shelf ∩ the rule (red is out)');
  const value = configOf(ruled, () => {}, 'pv_value');
  assert.equal(colourChoices(ruled, value, withPublic(ruled, ctxOf(ruled, value)), 'body').length, 4, 'the rule is not in force');
  // A shop that tracks nothing refuses nothing its paint allows.
  const open = shelfPub({}, { stock: null });
  assert.equal(stockedKeys(open, c, withPublic(open, ctxOf(open, c))), null);
  assert.equal(colourChoices(open, c, withPublic(open, ctxOf(open, c)), 'body').length, 21);
  // Merging needs a key every moved target may wear.
  const three = configOf(pub, (x) => {
    x.colors.body = 'black';
    x.colors.trim = 'navy';
    x.colors.base = 'white';
  });
  const merged = mergeColours(pub, three, withPublic(pub, ctxOf(pub, three)), 2)!;
  assert.equal(customerColours(pub, merged).length, 2);
  assert.deepEqual(merged.colors, { base: 'white', body: 'navy', trim: 'navy' }, 'black and navy are the nearest pair; the trim may not wear black, so the body moves');
  const apart = shelfPub({ regions: pub.regions.map((r, i) => ({ ...r, paint: [{ allowed: ['black', 'teal'], default: 'black' }, { allowed: ['white', 'navy'], default: 'white' }, { allowed: ['red', 'blue'], default: 'red' }][i] as never })) }, { stock: null });
  const disjoint = configOf(apart, () => {});
  assert.equal(mergeColours(apart, disjoint, withPublic(apart, ctxOf(apart, disjoint)), 2), null, 'no key two targets may share: no merge');
});

// ------------------------------------------------------------ the printer

test('fitsInBuild: any orientation — the six rotations agree, and so does the eligibility engine', () => {
  const perms = (d: number[]) => [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map((p) => p.map((i) => d[i]));
  assert.ok(fitsInBuild([250, 20, 20], [256, 256, 30]));
  assert.ok(fitsInBuild([20, 250, 20], [30, 256, 256]));
  assert.ok(!fitsInBuild([250, 250, 40], [256, 256, 30]));
  assert.ok(fitsInBuild([256, 256, 256], [256, 256, 256]), 'touching the limit fits');
  assert.ok(!fitsInBuild([256.1, 10, 10], [256, 256, 256]));
  assert.ok(!fitsInBuild([Number.NaN, 10, 10], [256, 256, 256]));
  assert.ok(!fitsInBuild([10, 10], [256, 256, 256]));
  const rnd = prng(42);
  for (let i = 0; i < 400; i++) {
    const d = [1, 2, 3].map(() => Math.round(rnd() * 300));
    const m = [1, 2, 3].map(() => Math.round(rnd() * 300));
    const want = eligibilityFits({ x: d[0], y: d[1], z: d[2] }, { build_x_mm: m[0], build_y_mm: m[1], build_z_mm: m[2] });
    for (const p of perms(d)) assert.equal(fitsInBuild(p, m), want, `${p} in ${m}`);
    for (const p of perms(m)) assert.equal(fitsInBuild(d, p), want, `${d} in ${p}`);
  }
});

test('sizes above the printer are not offered — smallest first, every size when the printer is unknown', () => {
  assert.deepEqual(sizeValuesInBuild(STAND, null), ['ov_s', 'ov_m', 'ov_l']);
  assert.deepEqual(sizeValuesInBuild(STAND, { max_mm: [256, 256, 256] }), ['ov_s', 'ov_m', 'ov_l']);
  assert.deepEqual(sizeValuesInBuild(STAND, { max_mm: [160, 160, 160] }), ['ov_s', 'ov_m']);
  assert.deepEqual(sizeValuesInBuild(STAND, { max_mm: [130, 130, 130] }), ['ov_s']);
  assert.deepEqual(sizeValuesInBuild(STAND, { max_mm: [200, 130, 110] }), ['ov_s', 'ov_m'], 'turned to fit');
  assert.deepEqual(sizeValuesInBuild(STAND, { max_mm: [50, 50, 50] }), []);
  assert.deepEqual(sizeValuesInBuild(FIXTURES.qrMenuStand.pub, { max_mm: [256, 256, 256] }), [], 'no size axis');
});
