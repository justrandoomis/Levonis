/**
 * ONE PRICE, THEN SURCHARGES (worker/lib/cheapestBase.ts).
 *
 * The owner's rule for the template: «سعر المنتج يوضع الأرخص ليكون الخيارات
 * والألوان والتوفر عبارة عن زيادة». The normalizer rewrites HOW prices are
 * written — cheapest sellable price as the base, everything else an increase
 * over it — and must never change WHAT anyone pays. So the central assertion
 * here is not about the representation at all: for every option × colour ×
 * tier, the real resolver (pricing.ts resolveUnitPrice) returns the same
 * numbers before and after.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCheapestBase, type CheapestBaseDoc } from '../worker/lib/cheapestBase';
import { resolveUnitPrice, type ColorV2, type OptionV2, type PricingProduct, type Tier } from '../worker/lib/pricing';
import { validateProductDoc } from '../worker/lib/productModel';

type Prices = Partial<Pick<OptionV2,
  'regular_price_iqd' | 'prime_price_iqd' | 'pro_price_iqd' | 'cost_iqd' |
  'regular_adjust_iqd' | 'prime_adjust_iqd' | 'pro_adjust_iqd' | 'cost_adjust_iqd'>>;

const NO_PRICES = {
  regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
  regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
};

function opt(id: string, prices: Prices = {}, extra: Partial<OptionV2> = {}): OptionV2 {
  return { id, name_ar: id, name_en: id, name_ckb: '', image: '', order: 0, active: true, ...NO_PRICES, ...prices, ...extra };
}
function col(id: string, prices: Prices = {}, extra: Partial<ColorV2> = {}): ColorV2 {
  return { id, name_ar: id, name_en: id, name_ckb: '', hex: '#000000', image: '', option_id: null, order: 0, active: true, ...NO_PRICES, ...prices, ...extra };
}
type Doc = CheapestBaseDoc & PricingProduct;
function product(base: number, options: OptionV2[], colors: ColorV2[] = [], extra: Partial<Doc> = {}): Doc {
  return {
    price_iqd: base, prime_price_iqd: null, pro_price_iqd: null, product_cost_iqd: null,
    selling_type: 'direct_sale', sale_types: ['direct_sale'], direct_surcharge_iqd: null,
    options, colors, preorder_transports: [], warranty_plans: [], ...extra,
  };
}

/**
 * Every price the shop could ever charge for this product, as one table.
 *
 * SELLABLE selections only, as the relational cart defines them
 * (productRelations.ts validateSelection): a product with an active option
 * group demands a choice (OPTION_GROUP_REQUIRED) and one with active colours
 * demands a colour (COLOR_REQUIRED). "No option" on a product that has
 * options is not a line anyone can buy — its number IS the base, and moving
 * the base is the whole point. (A legacy JSON-column product's cart path
 * does not enforce the choice; the apply therefore only re-expresses a
 * product when the file itself rewrites its option/colour rows.)
 */
function everyPrice(p: Doc) {
  const out: Record<string, unknown> = {};
  const optionIds: Array<string | null> = [
    ...(p.options.some((o) => o.active !== false) ? [] : [null]),
    ...p.options.map((o) => o.id),
  ];
  const colorIds: Array<string | null> = [
    ...(p.colors.some((c) => c.active !== false) ? [] : [null]),
    ...p.colors.map((c) => c.id),
  ];
  for (const optionId of optionIds) for (const colorId of colorIds) for (const tier of ['free', 'pro', 'prime'] as Tier[]) {
    const r = resolveUnitPrice({ product: p, optionId, colorId, tier, tierActive: tier !== 'free' });
    out[`${optionId ?? '-'}|${colorId ?? '-'}|${tier}`] = {
      regular: r.regular_iqd, pro: r.pro_iqd, prime: r.prime_iqd, applied: r.applied_iqd,
      subtotal: r.unit_subtotal_iqd, cost: r.cost_iqd, errors: r.errors,
    };
  }
  return out;
}

/** The invariant: a change of representation, never of price. */
function assertSamePrices(before: Doc, after: Doc) {
  assert.deepEqual(everyPrice(after), everyPrice(before), 'every option × colour × tier must resolve to the same numbers');
}

const regular = (p: Doc, id: string) => resolveUnitPrice({ product: p, optionId: id, tier: 'free', tierActive: false }).regular_iqd;

// ------------------------------------------------------------ the rewrite

test('fixed option prices become increases over the cheapest one, which becomes the base', () => {
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 }), opt('b', { regular_price_iqd: 60_000 }), opt('c')]);
  const { doc, base_before, base_after, changed } = normalizeCheapestBase(before);
  assert.equal(base_before, 60_000);
  assert.equal(base_after, 50_000, 'the cheapest sellable item is the base');
  const [a, b, c] = doc.options;
  assert.deepEqual([a.regular_price_iqd, a.regular_adjust_iqd], [null, null], 'the cheapest option simply inherits');
  assert.deepEqual([b.regular_price_iqd, b.regular_adjust_iqd], [null, 10_000], 'a dearer fixed price is +10,000');
  assert.deepEqual([c.regular_price_iqd, c.regular_adjust_iqd], [null, 10_000], 'an inheriting row must keep its 60,000 when the base moves under it');
  assert.ok(changed.includes('price_iqd'));
  assertSamePrices(before, doc);
  assert.equal(regular(doc, 'a'), 50_000);
  assert.equal(regular(doc, 'b'), 60_000);
  assert.equal(regular(doc, 'c'), 60_000);
});

test('the base is never raised — a "starting from" price below every option stays', () => {
  const before = product(50_000, [opt('a', { regular_price_iqd: 60_000 }), opt('b', { regular_price_iqd: 70_000 })]);
  const { doc, base_after } = normalizeCheapestBase(before);
  assert.equal(base_after, 50_000);
  assert.deepEqual(doc.options.map((o) => o.regular_adjust_iqd), [10_000, 20_000]);
  assertSamePrices(before, doc);
});

test('a switched-off option does not set the base, but is still written relative to it', () => {
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 }, { active: false }), opt('b', { regular_price_iqd: 70_000 })]);
  const { doc, base_after } = normalizeCheapestBase(before);
  assert.equal(base_after, 60_000, 'an unsellable 50,000 is not the cheapest sellable item');
  assert.equal(doc.options[0].regular_adjust_iqd, -10_000, 'a signed difference keeps its price for the day it is switched on');
  assert.equal(doc.options[1].regular_adjust_iqd, 10_000);
  assertSamePrices(before, doc);
});

test('already in the owner\'s form: nothing changes and nothing is reported', () => {
  const before = product(50_000, [opt('a'), opt('b', { regular_adjust_iqd: 10_000 })], [col('k', { regular_adjust_iqd: 5_000 })]);
  const r = normalizeCheapestBase(before);
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.doc, before);
});

test('normalizing twice is normalizing once', () => {
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 }), opt('b', { regular_price_iqd: 65_000 })], [col('k', { regular_price_iqd: 55_000 })]);
  const once = normalizeCheapestBase(before);
  const twice = normalizeCheapestBase(once.doc);
  assert.deepEqual(twice.doc, once.doc);
  assert.deepEqual(twice.changed, []);
});

// ------------------------------------------------------------ member prices

test('OWNER RULE: when the base moves, PRIME and PRO move with it — member prices are offsets', () => {
  // base 60,000 / PRIME 55,000 / PRO 50,000; option a FIXED 50,000 (cheapest),
  // option b inherits. Under the member-follows-regular rule b's PRO is
  // 50,000 today (no surcharge) and a's is 40,000 (a is 10,000 below base).
  // After: base 50,000 / PRIME 45,000 / PRO 40,000; a inherits (PRO 40,000),
  // b is +10,000 (PRO 40,000 + 10,000 = 50,000). Same numbers, every tier.
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 }), opt('b')], [], { prime_price_iqd: 55_000, pro_price_iqd: 50_000 });
  const { doc, base_after } = normalizeCheapestBase(before);
  assert.equal(base_after, 50_000);
  assert.equal(doc.prime_price_iqd, 45_000);
  assert.equal(doc.pro_price_iqd, 40_000);
  assertSamePrices(before, doc);
});

test('the base does not move where a member offset would reach zero', () => {
  // PRO 5,000 (55,000 below the base); an option 10,000 below the base.
  // Moving the base down 10,000 would put PRO at −5,000 → the base stays,
  // with a warning naming the offset.
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 }), opt('b')], [], { pro_price_iqd: 5_000 });
  const { doc, base_after, warnings } = normalizeCheapestBase(before);
  assert.equal(base_after, 60_000);
  assert.equal(doc.pro_price_iqd, 5_000);
  assert.ok(warnings.some((w) => w.startsWith('price_iqd:') && w.includes('PRO')), warnings.join('\n'));
  assertSamePrices(before, doc);
});

test('PRIME, PRO and cost keep their own mode — only the regular ladder is rewritten', () => {
  const before = product(60_000, [
    opt('a', { regular_price_iqd: 50_000, pro_price_iqd: 45_000, prime_price_iqd: 48_000, cost_iqd: 30_000 }),
    opt('b', { regular_price_iqd: 70_000, pro_adjust_iqd: -5_000, cost_adjust_iqd: 2_000 }),
  ], [], { product_cost_iqd: 25_000 });
  const { doc } = normalizeCheapestBase(before);
  const [a, b] = doc.options;
  assert.deepEqual([a.pro_price_iqd, a.prime_price_iqd, a.cost_iqd], [45_000, 48_000, 30_000]);
  assert.deepEqual([b.pro_adjust_iqd, b.cost_adjust_iqd, b.pro_price_iqd], [-5_000, 2_000, null]);
  assertSamePrices(before, doc);
});

test('a product PRO price above the cheapest option no longer blocks the move — the offset travels', () => {
  // PRO 45,000 (offset 15,000). Base 60,000 → 50,000 takes PRO to 35,000:
  // the same 15,000 below the base, on every option.
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 }), opt('b')], [], { pro_price_iqd: 45_000 });
  const { doc, base_after } = normalizeCheapestBase(before);
  assert.equal(base_after, 50_000);
  assert.equal(doc.pro_price_iqd, 35_000);
  assert.deepEqual([doc.options[0].regular_adjust_iqd ?? null, doc.options[1].regular_adjust_iqd], [null, 10_000]);
  assertSamePrices(before, doc);
  validateProductDoc(asBody(doc));
});

test('the base is not lowered onto the product cost — a selling price must differ from the cost', () => {
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 })], [], { product_cost_iqd: 50_000 });
  const { base_after, warnings } = normalizeCheapestBase(before);
  assert.equal(base_after, 60_000);
  assert.ok(warnings.some((w) => w.startsWith('price_iqd:') && w.includes('كلفة')), warnings.join('\n'));
});

// ------------------------------------------------------------------ colours

test('a fixed colour price on a product whose options price differently stays fixed, and says why', () => {
  // The colour's anchor is the option the customer picks. Two options, two
  // anchors: no single increase is right for both, so the number is kept.
  const before = product(50_000, [opt('a'), opt('b', { regular_adjust_iqd: 10_000 })], [col('k', { regular_price_iqd: 55_000 })]);
  const { doc, warnings } = normalizeCheapestBase(before);
  assert.equal(doc.colors[0].regular_price_iqd, 55_000);
  assert.ok(warnings.some((w) => w.startsWith('colors.1.regular_price_iqd:')), warnings.join('\n'));
  assertSamePrices(before, doc);
});

test('a fixed colour price becomes an increase when every option it can go with inherits the base', () => {
  const before = product(50_000, [opt('a'), opt('b')], [col('k', { regular_price_iqd: 55_000 })]);
  const { doc, warnings } = normalizeCheapestBase(before);
  assert.deepEqual([doc.colors[0].regular_price_iqd, doc.colors[0].regular_adjust_iqd], [null, 5_000]);
  assert.deepEqual(warnings.filter((w) => w.startsWith('colors.')), []);
  assertSamePrices(before, doc);
});

test('with no options, the cheapest colour is the base and the others are increases', () => {
  const before = product(50_000, [], [col('black', { regular_price_iqd: 45_000 }), col('red'), col('gold', { regular_adjust_iqd: 3_000 })]);
  const { doc, base_after } = normalizeCheapestBase(before);
  assert.equal(base_after, 45_000);
  const [black, red, gold] = doc.colors;
  assert.deepEqual([black.regular_price_iqd, black.regular_adjust_iqd], [null, null]);
  assert.deepEqual([red.regular_price_iqd, red.regular_adjust_iqd], [null, 5_000], 'red sold at 50,000 and still does');
  assert.deepEqual([gold.regular_price_iqd, gold.regular_adjust_iqd], [null, 8_000], 'gold sold at 53,000 and still does');
  assertSamePrices(before, doc);
});

test('a colour linked only to some options still needs EVERY active option at the base to convert', () => {
  // The colour is for option b only (+10,000). Its link set is honoured by
  // the relational cart, but a legacy JSON-column product sells it with any
  // option — so one increase is right for every line only when every option
  // sits at the base. Here they do not: it stays fixed.
  const before = product(50_000, [opt('a'), opt('b', { regular_adjust_iqd: 10_000 })], [col('k', { regular_price_iqd: 65_000 }, { option_ids: ['b'] })]);
  const { doc, warnings } = normalizeCheapestBase(before);
  assert.equal(doc.colors[0].regular_price_iqd, 65_000);
  assert.ok(warnings.some((w) => w.startsWith('colors.1.regular_price_iqd:') && w.includes('تختلف')), warnings.join('\n'));
  assertSamePrices(before, doc);
});

test('REVIEW: a link-set colour is not converted when a non-linked option prices differently (legacy cart sells it with any option)', () => {
  // base 60,000; a FIXED 50,000 (the new base); b inherits; colour k fixed
  // 55,000 linked to a only. Converting k to +5,000 would sell b|k — a line
  // the JSON-column cart accepts — at 65,000 instead of 55,000.
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 }), opt('b')], [col('k', { regular_price_iqd: 55_000 }, { option_ids: ['a'] })]);
  const { doc, base_after } = normalizeCheapestBase(before);
  assert.equal(base_after, 50_000);
  assert.equal(doc.colors[0].regular_price_iqd, 55_000, 'kept fixed');
  assertSamePrices(before, doc); // everyPrice ignores link sets: every option × colour line
});

test('REVIEW: with every option switched off, the base and the colours are left alone', () => {
  // Colours anchor on the base today and on the option the day it is switched
  // back on; no rewrite is right for both, so nothing moves.
  const before = product(60_000, [opt('a', {}, { active: false })], [col('k', { regular_price_iqd: 50_000 }), col('m')]);
  const { doc, base_after, warnings } = normalizeCheapestBase(before);
  assert.equal(base_after, 60_000);
  assert.deepEqual(doc.colors, before.colors);
  assert.ok(warnings.some((w) => w.includes('معطّلة')), warnings.join('\n'));
  assertSamePrices(before, doc);
  // …and switching the option back on afterwards charges what it always did.
  const on = (d: Doc): Doc => ({ ...d, options: d.options.map((o) => ({ ...o, active: true })) });
  assert.deepEqual(everyPrice(on(doc)), everyPrice(on(before)));
});

test('REVIEW: the "kept fixed" note names the right direction', () => {
  // A product PRO of 5,000 (55,000 below the base) keeps the base at 60,000
  // although option a sells at 50,000; the colour on a is below the base,
  // and the note must say so.
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 })], [col('k', { regular_price_iqd: 52_000 })], { pro_price_iqd: 5_000 });
  const { doc, warnings } = normalizeCheapestBase(before);
  assert.equal(doc.colors[0].regular_price_iqd, 52_000);
  assert.ok(warnings.some((w) => w.startsWith('colors.1.') && w.includes('تحت الأساسي')), warnings.join('\n'));
  assertSamePrices(before, doc);
});

// ---- the review's three counter-examples: a colour anchors on the OPTION, not the base

test('REVIEW: when the base moves under inheriting options, colours on them are left alone', () => {
  // base 60,000; a and b inherit; colour k FIXED 50,000 sets the new base;
  // colour m inherits. After: a and b are +10,000 (still 60,000), k must be
  // -10,000 relative to the OPTION (still 50,000) and m must not move at all.
  const before = product(60_000, [opt('a'), opt('b')], [col('k', { regular_price_iqd: 50_000 }), col('m')]);
  const { doc, base_after } = normalizeCheapestBase(before);
  assert.equal(base_after, 50_000);
  assertSamePrices(before, doc);
  const [k, m] = doc.colors;
  assert.equal(m.regular_price_iqd, null);
  assert.equal(m.regular_adjust_iqd ?? null, null, 'an inheriting colour on a product with options is untouched');
  assert.equal(k.regular_price_iqd, 50_000, 'k stays fixed: its anchor (60,000) is not the new base');
});

test('REVIEW: a colour linked to one inheriting option keeps its price when the base moves', () => {
  const before = product(50_000, [opt('o0'), opt('o1', { regular_price_iqd: 40_000 }), opt('o2', { regular_price_iqd: 60_000 })],
    [col('c0', { regular_price_iqd: 55_000 }, { option_id: 'o0' })]);
  const { doc, base_after } = normalizeCheapestBase(before);
  assert.equal(base_after, 40_000);
  assertSamePrices(before, doc);
});

test('REVIEW: adjusting colours on an inheriting option are not double-shifted', () => {
  const before = product(60_000, [opt('a')], [col('k', { regular_adjust_iqd: -5_000 }), col('m', { regular_adjust_iqd: 2_000 }), col('z', { regular_price_iqd: 40_000 })]);
  const { doc } = normalizeCheapestBase(before);
  assertSamePrices(before, doc);
  assert.equal(doc.colors[0].regular_adjust_iqd, -5_000);
  assert.equal(doc.colors[1].regular_adjust_iqd, 2_000);
});

test('REVIEW: a fixed PRIME/PRO on an inheriting colour floors the base — the validator measures it against the base', () => {
  // base 60,000; a FIXED 50,000; b inherits; colour k inherits regular with
  // PRO 58,000. Lowering the base to 50,000 would make the validator refuse
  // k (PRO 58,000 > 50,000), so the base stays and the file says why.
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 }), opt('b')], [col('k', { pro_price_iqd: 58_000 })]);
  assert.doesNotThrow(() => validateProductDoc(asBody(before)));
  const { doc, base_after, warnings } = normalizeCheapestBase(before);
  assert.equal(base_after, 60_000);
  assert.ok(warnings.some((w) => w.includes('PRO للون')), warnings.join('\n'));
  assertSamePrices(before, doc);
  assert.doesNotThrow(() => validateProductDoc(asBody(doc)), 'what is written still validates');
});

test('a colour that no active option offers is kept, and told that — not that "the options differ"', () => {
  const before = product(50_000, [opt('a'), opt('b', {}, { active: false })], [col('k', { regular_price_iqd: 55_000 }, { option_ids: ['b'] })]);
  const { doc, warnings } = normalizeCheapestBase(before);
  assert.equal(doc.colors[0].regular_price_iqd, 55_000);
  assert.ok(warnings.some((w) => w.includes('لا يتوفر لأي خيار فعّال')), warnings.join('\n'));
});

test('§11: an assistant admin is not told the cost through the "equals the cost" warning', () => {
  const before = product(60_000, [opt('a', { regular_price_iqd: 50_000 })], [], { product_cost_iqd: 50_000 });
  const forOwner = normalizeCheapestBase(before, { money: true });
  const forAssistant = normalizeCheapestBase(before, { money: false });
  assert.ok(forOwner.warnings.some((w) => w.includes('كلفة')));
  assert.ok(!forAssistant.warnings.some((w) => w.includes('كلفة') || w.includes('50,000 د.ع) يساوي')), forAssistant.warnings.join('\n'));
  assert.equal(forAssistant.base_after, 60_000, 'same decision, different words');
});

// -------------------------------------------------- the validator's half

/** A minimal create body around a normalized document. */
function asBody(doc: Doc): Record<string, unknown> {
  return {
    name_ar: 'منتج', name_en: 'Product', price_iqd: doc.price_iqd,
    pro_price_iqd: doc.pro_price_iqd, prime_price_iqd: doc.prime_price_iqd, product_cost_iqd: doc.product_cost_iqd,
    selling_type: 'direct_sale', options: doc.options, colors: doc.colors,
  };
}

test('the validator measures a member price against base + increase, not the bare base', () => {
  // "+10,000 over 50,000" sells at 60,000; a PRO price of 55,000 is a real
  // discount on it and must be accepted…
  const ok = product(50_000, [opt('a', { regular_adjust_iqd: 10_000, pro_price_iqd: 55_000 })]);
  assert.doesNotThrow(() => validateProductDoc(asBody(ok)));
  // …while the same PRO price on a row that really does sell at 50,000 is
  // still refused, exactly as before.
  const bad = product(50_000, [opt('a', { pro_price_iqd: 55_000 })]);
  assert.throws(() => validateProductDoc(asBody(bad)), /PRO \(55000\) must not be above the regular price \(50000\)/);
});

test('what the normalizer writes, the validator accepts — fixed member prices survive the rewrite', () => {
  const before = product(60_000, [
    opt('a', { regular_price_iqd: 50_000, pro_price_iqd: 47_000 }),
    opt('b', { regular_price_iqd: 70_000, pro_price_iqd: 65_000, prime_price_iqd: 68_000 }),
  ]);
  assert.doesNotThrow(() => validateProductDoc(asBody(before)), 'the input is valid');
  const { doc } = normalizeCheapestBase(before);
  assert.doesNotThrow(() => validateProductDoc(asBody(doc)), 'and so is the rewrite');
});
