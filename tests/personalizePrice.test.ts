/**
 * THE PRICE OF A CONFIGURATION (Programme C, C1 lane L2;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 3, §0 rows 5 and 24, P1; §F F4, F11).
 *
 * Pins: the brief's golden — base 20,000 + 2 × magnets 1,000 + RGB LED 5,000
 * + motor 8,000 = 35,000 IQD — from the store's OWN rows, priced by
 * resolveCatalogLine's rule, alike in the Worker-shaped context and the
 * studio's (`priceContextFromPublic` over a PublicBlueprint made of the same
 * rows); every fee kind with its stable key; 'included' charges the positive
 * difference only; the integer rules (negative, fractional, NaN, unsafe and
 * over 50,000,000 refused with EngineError, never priced); lineTotal's
 * quantity 1–9,999; a configuration cannot carry a price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EngineError, PRICE_LIMITS, customerColours, lineTotal, paintTargets, partKey, priceConfig, priceContext, priceContextFromPublic, regionShown, slotChoice,
  type PriceContext,
} from '../packages/catalog/src/personalize/price';
import { normalizeConfig } from '../packages/catalog/src/personalize/config';
import type { BlueprintSpec, DesignConfig, PublicBlueprint } from '../packages/catalog/src/personalize/types';
import { resolveCatalogLine } from '../worker/lib/catalog/lines';
import { partUnitIqd } from '../worker/lib/personalize/parts';
import { FIXTURES, GOLDEN_CONFIG, GOLDEN_UNIT_IQD, NAME_STAND_CONFIG, ROTATING_DISPLAY } from './fixtures/personalizeBlueprints';
import { FEES_ADDS, FEES_CONFIG, FEES_PUB, FEES_SPEC, FEES_UNIT_IQD, ROTATING_ROWS, STAND_ROWS, configOf, option, type PartRow, type ProductRow } from './fixtures/personalizeMoney';

type Rows = { product: ProductRow; parts: PartRow[] };
const clone = <T>(v: T): T => structuredClone(v);

/** The Worker's context for a line: resolveCatalogLine's unit for the variant, loadStoreParts' unit per part row. */
function workerContext(rows: Rows, variantId: string | null): PriceContext {
  const p = rows.product;
  const v = p.variants.find((x) => x.id === variantId);
  const line = resolveCatalogLine({
    variant_mode: p.variant_mode, price_iqd: p.price_iqd, ci_variant_id: variantId, v_id: v?.id ?? null, v_active: v?.active ?? null, v_price: v?.price_iqd ?? null,
    options: null, colors: null, option_id: '', color_id: '',
  });
  assert.ok(line.ok, `resolveCatalogLine refused ${variantId}`);
  const parts = rows.parts.map((r) => ({ product_id: r.product_id, variant_id: r.variant_id, unit_iqd: partUnitIqd({ price_iqd: r.price_iqd, v_price: r.v_price }), in_stock: !r.tracked || r.stock > 0 }));
  return priceContext(line.ok ? line.unit : NaN, parts);
}

/** The PublicBlueprint the Worker would serve for the same rows: each variant's price and each option's unit written independently of the engine. */
function publicFromRows(base: PublicBlueprint, rows: Rows): PublicBlueprint {
  const p = rows.product;
  const unit = (r: PartRow) => (r.v_price === null ? r.price_iqd : r.v_price);
  return {
    ...base,
    product: { ...base.product, id: p.id, price_iqd: p.price_iqd },
    variants: p.variants.filter((v) => v.active).map((v) => ({ id: v.id, values: v.values, price_iqd: v.price_iqd ?? p.price_iqd, in_stock: v.stock > 0 })),
    slot_options: Object.fromEntries(
      base.slots.map((s) => [
        s.id,
        s.options.map((o) => {
          const r = rows.parts.find((x) => x.product_id === o.part.p && x.variant_id === o.part.v)!;
          return option(o.key, r.product_id, r.variant_id, unit(r), !r.tracked || r.stock > 0);
        }),
      ])
    ),
  };
}

/** EngineError with this code (and path, when given). */
function refuses(fn: () => unknown, code: string, path?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof EngineError, `not an EngineError: ${String(e)}`);
    assert.equal(e.code, code);
    if (path !== undefined) assert.equal(e.path, path);
    return true;
  });
}

// ------------------------------------------------------------ the golden

test('the brief\'s golden: 20,000 + 2 × 1,000 + 5,000 + 8,000 = 35,000 IQD from the store\'s own rows — Worker and studio alike', () => {
  const pub = publicFromRows(FIXTURES.rotatingDisplay.pub, ROTATING_ROWS);
  const worker = workerContext(ROTATING_ROWS, null);
  const studio = priceContextFromPublic(pub, null);
  assert.deepEqual(studio, worker, 'the studio\'s context is the Worker\'s, key for key');
  // L1's fixture carries the same figures, so its studio context is the Worker's too.
  assert.deepEqual(priceContextFromPublic(FIXTURES.rotatingDisplay.pub, null), worker);
  assert.equal(worker.base_iqd, 20_000);
  assert.deepEqual(worker.parts[partKey('cp_magnet', 'pv_magnet_10')], { unit_iqd: 1_000, in_stock: true });
  assert.deepEqual(worker.parts[partKey('cp_magnet', 'pv_magnet_20')], { unit_iqd: 2_500, in_stock: false });
  assert.deepEqual(worker.parts[partKey('cp_led', 'pv_led_rgb')], { unit_iqd: 5_000, in_stock: true }, 'an untracked part is in stock');

  assert.ok(normalizeConfig(GOLDEN_CONFIG, pub).ok, 'the golden configuration is valid for the live revision');
  const golden = { unit_iqd: GOLDEN_UNIT_IQD, base_iqd: 20_000, adds: [{ key: 'slot:motor', iqd: 8_000 }, { key: 'slot:magnet', iqd: 1_000, qty: 2 }, { key: 'slot:lighting', iqd: 5_000 }] };
  assert.equal(GOLDEN_UNIT_IQD, 35_000);
  assert.deepEqual(priceConfig(ROTATING_DISPLAY, GOLDEN_CONFIG, worker), golden, 'the Worker, from the stored spec');
  assert.deepEqual(priceConfig(pub, GOLDEN_CONFIG, studio), golden, 'the studio, from the public blueprint');
  assert.equal(lineTotal(golden.unit_iqd, 3), 105_000);
});

test('a variant product: the base is the variant\'s own price, else the product\'s — resolveCatalogLine\'s rule on both sides', () => {
  const pub = publicFromRows(FIXTURES.nameStand.pub, STAND_ROWS);
  for (const v of STAND_ROWS.product.variants) {
    const worker = workerContext(STAND_ROWS, v.id);
    assert.deepEqual(priceContextFromPublic(pub, v.id), worker, v.id);
    assert.equal(worker.base_iqd, v.price_iqd ?? STAND_ROWS.product.price_iqd);
  }
  assert.equal(workerContext(STAND_ROWS, 'pv_s_classic').base_iqd, 20_000, 'no price of its own: the product\'s');
  const unit = priceConfig(pub, NAME_STAND_CONFIG, priceContextFromPublic(pub, NAME_STAND_CONFIG.variant));
  assert.deepEqual(unit, { unit_iqd: 29_000, base_iqd: 26_000, adds: [{ key: 'slot:magnet', iqd: 1_500, qty: 2 }] });
  assert.deepEqual(priceConfig(pub, NAME_STAND_CONFIG, workerContext(STAND_ROWS, 'pv_m_silk')), unit);

  // A variant the product does not sell — or none on a product that has variants — is refused, as the add door refuses it.
  refuses(() => priceContextFromPublic(pub, 'pv_nope'), 'VARIANT_UNKNOWN', 'variant');
  refuses(() => priceContextFromPublic(pub, null), 'VARIANT_UNKNOWN', 'variant');
  refuses(() => priceContextFromPublic(FIXTURES.rotatingDisplay.pub, 'pv_any'), 'VARIANT_UNKNOWN', 'variant');
});

// ------------------------------------------------------------ every fee kind

test('every fee kind, keyed stably and in order: areas, pieces, premium colours, extra colours, slots, NFC', () => {
  const ctx = priceContextFromPublic(FEES_PUB, FEES_CONFIG.variant);
  const price = priceConfig(FEES_PUB, FEES_CONFIG, ctx);
  assert.deepEqual(price, { unit_iqd: FEES_UNIT_IQD, base_iqd: 20_000, adds: FEES_ADDS });
  assert.equal(price.base_iqd + price.adds.reduce((s, a) => s + a.iqd * (a.qty ?? 1), 0), price.unit_iqd, 'unit = base + Σ iqd × qty');
  assert.deepEqual(priceConfig(FEES_SPEC, FEES_CONFIG, ctx), price, 'the stored spec prices exactly as its public projection');
  assert.deepEqual(priceConfig(FEES_PUB, FEES_CONFIG, ctx), price, 'deterministic');
});

test('areas: a required one always, an optional one when filled — and never on a piece that is not there', () => {
  const ctx = priceContextFromPublic(FEES_PUB, 'pv_m');
  const adds = (c: DesignConfig) => Object.fromEntries(priceConfig(FEES_PUB, c, ctx).adds.map((a) => [a.key, a.iqd * (a.qty ?? 1)]));
  const off = configOf(FEES_PUB, (c) => {
    c.texts.name.value = ['ALI'];
  }, 'pv_m');
  assert.equal(adds(off)['area:tagline'], undefined, 'an empty optional area is free');
  assert.equal(adds(off)['area:logo'], undefined);
  assert.equal(adds(off)['area:plaque'], undefined, 'a required area on a piece switched off is not there');
  assert.equal(adds(off)['region:stand'], undefined);
  const on = configOf(FEES_PUB, (c) => {
    c.parts.stand = true;
    c.logo.logo = { key: 'users/u_owner/design-assets/a1.png', crop: [0, 0, 1, 1], mode: 'flat' };
  }, 'pv_m');
  assert.equal(adds(on)['area:plaque'], 1_200, 'a required area costs while still empty');
  assert.equal(adds(on)['region:stand'], 2_500, 'an optional piece switched on');
  assert.equal(adds(on)['area:logo'], 3_000, 'an optional area once filled');
  assert.ok(regionShown(FEES_PUB, on, 'stand') && !regionShown(FEES_PUB, off, 'stand'));
});

test('colours: premium per target wearing it; extras = max(0, customer colours − included) × per_extra — fixed colours and empty texts do not count', () => {
  const ctx = priceContextFromPublic(FEES_PUB, 'pv_m');
  const adds = (c: DesignConfig) => Object.fromEntries(priceConfig(FEES_PUB, c, ctx).adds.map((a) => [a.key, a]));
  const plain = configOf(FEES_PUB, (c) => {
    c.parts.stand = true;
    c.slots.light = { option: 'rgb' };
  }, 'pv_m');
  // body black, base white; the stand (silver only) and the glow (clear only, shown by the light) are the merchant's colours.
  assert.deepEqual(customerColours(FEES_PUB, plain), ['black', 'white']);
  assert.ok(paintTargets(FEES_PUB, plain).some((t) => t.id === 'glow' && !t.choice), 'the glow is shown, and not the customer\'s');
  assert.ok(paintTargets(FEES_PUB, plain).some((t) => t.id === 'stand' && !t.choice));
  assert.equal(adds(plain)['colours:extra'], undefined, 'two colours are included');

  const three = clone(plain);
  three.colors.base = 'gold';
  three.texts.name.value = ['ALI'];
  assert.deepEqual(customerColours(FEES_PUB, three), ['black', 'gold', 'white'], 'a filled text\'s own colour counts');
  assert.deepEqual(adds(three)['colours:extra'], { key: 'colours:extra', iqd: 750 });
  assert.deepEqual(adds(three)['colour:gold'], { key: 'colour:gold', iqd: 1_000 }, 'gold on the base: its premium');
  three.colors.body = 'gold';
  assert.deepEqual(adds(three)['colour:gold'], { key: 'colour:gold', iqd: 2_500 }, 'two targets wear gold: both premiums');
  assert.equal(adds(three)['colours:extra'], undefined, 'gold twice is one colour');

  const four = clone(three);
  four.colors.body = 'red';
  four.colors.name = 'black';
  four.texts.tagline.value = ['Hi'];
  four.colors.tagline = 'white';
  assert.deepEqual(customerColours(FEES_PUB, four), ['red', 'gold', 'black', 'white']);
  assert.deepEqual(adds(four)['colours:extra'], { key: 'colours:extra', iqd: 750, qty: 2 }, 'each colour past the included two');
  four.texts.tagline.value = [];
  assert.deepEqual(customerColours(FEES_PUB, four), ['red', 'gold', 'black'], 'an empty text prints no colour');
  assert.deepEqual(adds(four)['colours:extra'], { key: 'colours:extra', iqd: 750 });

  // A text's own colour carries its paint's premium.
  const spec = clone(FEES_SPEC);
  spec.areas[0].text!.paint.premium = { gold: 700 };
  four.colors.name = 'gold';
  assert.equal(priceConfig(spec, four, ctx).adds.find((a) => a.key === 'colour:gold')!.iqd, 1_000 + 700);
});

test('slots: \'add\' = the live unit × qty; \'included\' = the positive difference only, never negative; fixed choices and fixed parts', () => {
  const ctx = priceContextFromPublic(FEES_PUB, 'pv_m');
  const slot = (set: (c: DesignConfig) => void, key: string) => {
    const c = clone(FEES_CONFIG);
    set(c);
    return priceConfig(FEES_PUB, c, ctx).adds.find((a) => a.key === key);
  };
  assert.deepEqual(slot((c) => (c.slots.magnet = { option: 'm10' }), 'slot:magnet'), { key: 'slot:magnet', iqd: 1_000, qty: 2 });
  assert.equal(slot((c) => (c.slots.light = { option: 'warm' }), 'slot:light'), undefined, 'the included default costs nothing');
  assert.equal(slot((c) => (c.slots.light = { option: 'cold' }), 'slot:light'), undefined, 'a cheaper option than the included one is never a discount');
  assert.equal(slot((c) => (c.slots.light = { option: null }), 'slot:light'), undefined, 'no light, no charge — and no discount');
  assert.deepEqual(slot((c) => (c.slots.light = { option: 'rgb' }), 'slot:light'), { key: 'slot:light', iqd: 2_500 });
  assert.equal(slot((c) => (c.slots.motor = { option: 'a' }), 'slot:motor'), undefined, 'included without a default: measured from the cheapest option');
  assert.deepEqual(slot((c) => (c.slots.motor = { option: 'b' }), 'slot:motor'), { key: 'slot:motor', iqd: 3_000 });
  assert.deepEqual(slot(() => {}, 'slot:screw'), { key: 'slot:screw', iqd: 100, qty: 4 }, 'a fixed choice is on its default, priced as its pricing says');
  assert.equal(FEES_SPEC.fixed.length, 1);
  assert.ok(!priceConfig(FEES_PUB, FEES_CONFIG, ctx).adds.some((a) => a.key.includes('glue')), 'fixed parts are in the price already');
  assert.equal(slotChoice(FEES_PUB.slots[2], { ...FEES_CONFIG, slots: {} }), 's3');
  // A cheaper part price makes 'included' cheaper, never negative.
  const cheap: PriceContext = { ...ctx, parts: { ...ctx.parts, [partKey('cp_led', 'pv_led_rgb')]: { unit_iqd: 1_000, in_stock: true } } };
  assert.equal(priceConfig(FEES_PUB, FEES_CONFIG, cheap).adds.find((a) => a.key === 'slot:light'), undefined);
});

test('NFC: its fee only when the customer set a target; hidden pieces follow their switch', () => {
  const ctx = priceContextFromPublic(FEES_PUB, 'pv_m');
  const none = clone(FEES_CONFIG);
  none.nfc = null;
  assert.equal(priceConfig(FEES_PUB, none, ctx).unit_iqd, FEES_UNIT_IQD - 3_500);
  none.slots.light = { option: null };
  assert.ok(!regionShown(FEES_PUB, none, 'glow'), 'the glow shows only while the light slot is filled');
  assert.ok(regionShown(FEES_PUB, FEES_CONFIG, 'glow'));
});

// ------------------------------------------------------------ the integer rules

test('integer rules: a negative, fractional, NaN, infinite or unsafe figure is refused with EngineError, never priced', () => {
  const ctx = priceContextFromPublic(FIXTURES.rotatingDisplay.pub, null);
  const pub = FIXTURES.rotatingDisplay.pub;
  for (const bad of [-1, 0.5, 20_000.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '20000' as unknown as number, null as unknown as number]) {
    refuses(() => priceConfig(pub, GOLDEN_CONFIG, { ...ctx, base_iqd: bad }), 'PRICE_INVALID', 'base_iqd');
    refuses(() => priceConfig(pub, GOLDEN_CONFIG, { ...ctx, parts: { ...ctx.parts, [partKey('cp_motor', 'pv_motor_a')]: { unit_iqd: bad, in_stock: true } } }), 'PRICE_INVALID', 'slots.motor.a');
  }
  // A figure from the blueprint itself (a public body is data too).
  const spec = clone(FEES_SPEC) as BlueprintSpec;
  spec.areas[1].fee_iqd = -500;
  refuses(() => priceConfig(spec, FEES_CONFIG, priceContextFromPublic(FEES_PUB, 'pv_m')), 'PRICE_INVALID', 'areas.1.fee_iqd');
  const premium = clone(FEES_SPEC) as BlueprintSpec;
  premium.regions[0].paint.premium = { gold: 1.5 };
  refuses(() => priceConfig(premium, FEES_CONFIG, priceContextFromPublic(FEES_PUB, 'pv_m')), 'PRICE_INVALID', 'colors.body');
  const extra = clone(FEES_SPEC) as BlueprintSpec;
  extra.colors.per_extra_iqd = Number.NaN;
  refuses(() => priceConfig(extra, FEES_CONFIG, priceContextFromPublic(FEES_PUB, 'pv_m')), 'PRICE_INVALID', 'colors.per_extra_iqd');
});

test('integer rules: the unit is at most 50,000,000 IQD — at the cap it prices, one dinar over it is refused', () => {
  const pub = FIXTURES.rotatingDisplay.pub;
  const ctx = priceContextFromPublic(pub, null);
  assert.equal(PRICE_LIMITS.unit, 50_000_000);
  const fees = GOLDEN_UNIT_IQD - 20_000;
  assert.equal(priceConfig(pub, GOLDEN_CONFIG, { ...ctx, base_iqd: 50_000_000 - fees }).unit_iqd, 50_000_000);
  refuses(() => priceConfig(pub, GOLDEN_CONFIG, { ...ctx, base_iqd: 50_000_000 - fees + 1 }), 'PRICE_TOO_HIGH', 'unit_iqd');
  refuses(() => priceConfig(pub, GOLDEN_CONFIG, { ...ctx, base_iqd: 50_000_001 }), 'PRICE_TOO_HIGH', 'unit_iqd');
  refuses(() => priceConfig(pub, GOLDEN_CONFIG, { ...ctx, parts: { ...ctx.parts, [partKey('cp_magnet', 'pv_magnet_10')]: { unit_iqd: 25_000_000, in_stock: true } } }), 'PRICE_TOO_HIGH');
});

test('lineTotal: unit × qty for a quantity of 1–9,999 and a unit the engine prices — anything else is refused', () => {
  assert.equal(lineTotal(35_000, 1), 35_000);
  assert.equal(lineTotal(35_000, 9_999), 349_965_000);
  assert.equal(lineTotal(50_000_000, 9_999), 499_950_000_000);
  assert.ok(Number.isSafeInteger(lineTotal(PRICE_LIMITS.unit, PRICE_LIMITS.qty)));
  assert.equal(lineTotal(0, 5), 0);
  for (const qty of [0, -1, 10_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) refuses(() => lineTotal(35_000, qty), 'QTY_INVALID', 'qty');
  for (const unit of [-1, 1.5, Number.NaN, 2 ** 53]) refuses(() => lineTotal(unit, 1), 'PRICE_INVALID', 'unit_iqd');
  refuses(() => lineTotal(50_000_001, 1), 'PRICE_TOO_HIGH', 'unit_iqd');
});

test('a part without a live price is PART_UNPRICED — never priced as free', () => {
  const pub = FIXTURES.rotatingDisplay.pub;
  const ctx = priceContextFromPublic(pub, null);
  const parts = { ...ctx.parts };
  delete parts[partKey('cp_motor', 'pv_motor_a')];
  refuses(() => priceConfig(pub, GOLDEN_CONFIG, { ...ctx, parts }), 'PART_UNPRICED', 'slots.motor');
  // The included option a slot is measured against must be priced too.
  const light = { ...priceContextFromPublic(FEES_PUB, 'pv_m') };
  const without = { ...light.parts };
  delete without[partKey('cp_led', 'pv_led_warm')];
  refuses(() => priceConfig(FEES_PUB, FEES_CONFIG, { ...light, parts: without }), 'PART_UNPRICED', 'slots.light');
  // An option the customer did not choose may be unpriced: it prices nothing.
  const lighting = { ...ctx.parts };
  delete lighting[partKey('cp_led', 'pv_led_white')];
  assert.equal(priceConfig(pub, GOLDEN_CONFIG, { ...ctx, parts: lighting }).unit_iqd, 35_000);
});

test('a configuration never carries a price: normalizeConfig refuses a price-like key, at the top or inside a slot', () => {
  const pub = FIXTURES.rotatingDisplay.pub;
  const top = normalizeConfig({ ...clone(GOLDEN_CONFIG), price: 1 }, pub);
  assert.ok(!top.ok && top.code === 'CONFIG_INVALID' && top.path === 'price');
  const inner = clone(GOLDEN_CONFIG) as unknown as Record<string, Record<string, Record<string, unknown>>>;
  inner.slots.motor.unit_iqd = 1;
  const deep = normalizeConfig(inner, pub);
  assert.ok(!deep.ok && deep.code === 'CONFIG_INVALID' && deep.path === 'slots.motor.unit_iqd');
});

test('pure: the inputs are never written, and the same inputs give the same breakdown', () => {
  const freeze = <T>(v: T): T => {
    if (v && typeof v === 'object') {
      Object.values(v as object).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  const pub = freeze(clone(FEES_PUB));
  const config = freeze(clone(FEES_CONFIG));
  const ctx = freeze(priceContextFromPublic(FEES_PUB, 'pv_m'));
  const a = priceConfig(pub, config, ctx);
  assert.deepEqual(priceConfig(pub, config, ctx), a);
  assert.deepEqual(a.adds, FEES_ADDS);
});
