/**
 * ONE PRODUCT, FOUR WAYS TO BUY IT — the owner's Bambu Lab A1 case, pinned.
 *
 *     A1        — pre-order        A1        — direct sale
 *     A1 Combo  — pre-order        A1 Combo  — direct sale
 *
 * Each cell must carry its own regular price, PRIME price, PRO price,
 * internal cost, stock and lead time, and choosing one must fix how the line
 * is fulfilled. The tests below are grouped by the promise they protect:
 *
 *   1. inheritance — an option with no opinion behaves exactly as before, so
 *      no product that existed before this feature changes;
 *   2. constraint — a declared option narrows the line to its own route and
 *      cannot be talked out of it by a crafted request;
 *   3. independence — the four cells price separately, cost separately and
 *      stock separately;
 *   4. grouping — A1 and A1 Combo are told apart by DATA, with name parsing
 *      surviving only as the fallback the owner asked for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice } from '../worker/lib/pricing';
import type { PricingProduct, OptionV2 } from '../worker/lib/pricing';
import {
  availabilityFromName,
  deriveSaleTypes,
  effectiveAvailability,
  expandSellingType,
  isMixed,
  leadTimeLabel,
  normalizeAvailability,
  variantKeyFrom,
  variantLabelFallback,
} from '../worker/lib/availability';

const opt = (over: Partial<OptionV2> & { id: string }): OptionV2 => ({
  name_ar: over.id, name_en: over.id, name_ckb: over.id, image: '', order: 0, active: true,
  regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
  ...over,
});

const product = (over: Partial<PricingProduct> = {}): PricingProduct => {
  const selling_type = over.selling_type ?? 'direct_sale';
  return {
    price_iqd: 100_000, pro_price_iqd: null, prime_price_iqd: null, product_cost_iqd: 60_000,
    options: [], colors: [], preorder_transports: [], warranty_plans: [],
    ...over,
    selling_type,
    sale_types: over.sale_types ?? [selling_type as 'direct_sale' | 'pre_order' | 'bundle'],
  };
};

const free = { tier: 'free' as const, tierActive: false };
const pro = { tier: 'pro' as const, tierActive: true };
const prime = { tier: 'prime' as const, tierActive: true };

/** The owner's product, exactly as described. */
const A1 = () =>
  product({
    price_iqd: 899_000,
    sale_types: ['direct_sale', 'pre_order'],
    preorder_transports: [{ method: 'air', commission_iqd: 25_000, active: true }],
    options: [
      opt({
        id: 'a1-preorder', name_en: 'A1 - Pre-order', variant_key: 'a1', variant_label: 'A1',
        availability_type: 'pre_order', lead_time_text: '3-4 weeks',
        regular_price_iqd: 899_000, prime_price_iqd: 885_000, pro_price_iqd: 799_000, cost_iqd: 700_000,
        stock: null,
      }),
      opt({
        id: 'a1-direct', name_en: 'A1 - Direct Sale', variant_key: 'a1', variant_label: 'A1',
        availability_type: 'direct_sale',
        regular_price_iqd: 950_000, prime_price_iqd: 935_000, pro_price_iqd: 799_000, cost_iqd: 720_000,
        stock: 4,
      }),
      opt({
        id: 'a1-combo-preorder', name_en: 'A1 Combo - Pre-order', variant_key: 'a1-combo', variant_label: 'A1 Combo',
        availability_type: 'pre_order', lead_time_text: '3-4 weeks',
        regular_price_iqd: 1_099_000, prime_price_iqd: 1_085_000, pro_price_iqd: 999_000, cost_iqd: 900_000,
        stock: null,
      }),
      opt({
        id: 'a1-combo-direct', name_en: 'A1 Combo - Direct Sale', variant_key: 'a1-combo', variant_label: 'A1 Combo',
        availability_type: 'direct_sale',
        regular_price_iqd: 1_150_000, prime_price_iqd: 1_135_000, pro_price_iqd: 999_000, cost_iqd: 920_000,
        stock: 2,
      }),
    ],
  });

// ------------------------------------------------ 1. nothing old changes

{
  test('an option with NO availability inherits a direct-only product', () => {
    assert.equal(effectiveAvailability(opt({ id: 'x' }), ['direct_sale']), 'direct_sale');
  });

  test('and inherits a pre-order-only product', () => {
    assert.equal(effectiveAvailability(opt({ id: 'x' }), ['pre_order']), 'pre_order');
  });

  test('on a product that sells BOTH ways a silent option stays undecided', () => {
    // Deliberately '': guessing here would change the behaviour of a product
    // nobody edited. The transport selection keeps deciding, as it always did.
    assert.equal(effectiveAvailability(opt({ id: 'x' }), ['direct_sale', 'pre_order']), '');
  });

  test('a legacy direct product still prices with no transport and refuses one', () => {
    const p = product({ options: [opt({ id: 'o1', regular_price_iqd: 120_000 })] });
    const ok = resolveUnitPrice({ product: p, optionId: 'o1', ...free });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.applied_iqd, 120_000);
    const bad = resolveUnitPrice({ product: p, optionId: 'o1', transportMethod: 'air', ...free });
    assert.ok(bad.errors.includes('TRANSPORT_NOT_APPLICABLE'));
  });

  test('a legacy pre-order product still demands a transport', () => {
    const p = product({
      selling_type: 'pre_order',
      preorder_transports: [{ method: 'air', commission_iqd: 10_000, active: true }],
      options: [opt({ id: 'o1' })],
    });
    assert.ok(resolveUnitPrice({ product: p, optionId: 'o1', ...free }).errors.includes('TRANSPORT_REQUIRED'));
    const ok = resolveUnitPrice({ product: p, optionId: 'o1', transportMethod: 'air', ...free });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.unit_subtotal_iqd, 110_000);
  });

  test('a mixed product with silent options still lets the transport decide, both ways', () => {
    const p = product({
      sale_types: ['direct_sale', 'pre_order'],
      direct_surcharge_iqd: 5_000,
      preorder_transports: [{ method: 'air', commission_iqd: 10_000, active: true }],
      options: [opt({ id: 'o1' })],
    });
    const direct = resolveUnitPrice({ product: p, optionId: 'o1', ...free });
    assert.deepEqual(direct.errors, []);
    assert.equal(direct.unit_subtotal_iqd, 105_000);
    const pre = resolveUnitPrice({ product: p, optionId: 'o1', transportMethod: 'air', ...free });
    assert.deepEqual(pre.errors, []);
    assert.equal(pre.unit_subtotal_iqd, 110_000);
  });
}

// --------------------------------- 2. a declared option narrows the line

{
  test('a pre-order option demands a transport even on a product that also sells direct', () => {
    const r = resolveUnitPrice({ product: A1(), optionId: 'a1-combo-preorder', ...free });
    assert.ok(r.errors.includes('TRANSPORT_REQUIRED'), r.errors.join(','));
  });

  test('a direct option REFUSES a transport, however the request is crafted', () => {
    const r = resolveUnitPrice({ product: A1(), optionId: 'a1-combo-direct', transportMethod: 'air', ...free });
    assert.ok(r.errors.includes('TRANSPORT_NOT_APPLICABLE'), r.errors.join(','));
  });

  test('the direct premium never lands on a pre-order option', () => {
    const p = A1();
    p.direct_surcharge_iqd = 50_000;
    const r = resolveUnitPrice({ product: p, optionId: 'a1-preorder', transportMethod: 'air', ...free });
    assert.deepEqual(r.errors, []);
    assert.equal(r.direct, null);
    // 899,000 + 25,000 air commission, and no immediacy premium.
    assert.equal(r.unit_subtotal_iqd, 924_000);
  });

  test('and it DOES land on the direct option of the very same product', () => {
    const p = A1();
    p.direct_surcharge_iqd = 50_000;
    const r = resolveUnitPrice({ product: p, optionId: 'a1-direct', ...free });
    assert.deepEqual(r.errors, []);
    assert.equal(r.direct?.surcharge_iqd, 50_000);
    assert.equal(r.unit_subtotal_iqd, 1_000_000);
  });

  test('a bundle product stops enabling direct fulfilment once an option names its route', () => {
    const p = product({
      sale_types: ['bundle', 'pre_order'],
      preorder_transports: [{ method: 'air', commission_iqd: 1_000, active: true }],
      options: [opt({ id: 'o1', availability_type: 'pre_order' })],
    });
    assert.ok(resolveUnitPrice({ product: p, optionId: 'o1', ...free }).errors.includes('TRANSPORT_REQUIRED'));
  });
}

// ------------------------------------------- 3. four genuinely separate cells

{
  const cells: Array<[string, number, number, number, number]> = [
    // id, regular, prime, pro, cost
    ['a1-preorder', 899_000, 885_000, 799_000, 700_000],
    ['a1-direct', 950_000, 935_000, 799_000, 720_000],
    ['a1-combo-preorder', 1_099_000, 1_085_000, 999_000, 900_000],
    ['a1-combo-direct', 1_150_000, 1_135_000, 999_000, 920_000],
  ];

  for (const [id, regular, primeP, proP, cost] of cells) {
    test(`${id}: regular / PRIME / PRO / cost are its own`, () => {
      const transportMethod = id.includes('preorder') ? 'air' : null;
      const asFree = resolveUnitPrice({ product: A1(), optionId: id, transportMethod, ...free });
      assert.deepEqual(asFree.errors, []);
      assert.equal(asFree.regular_iqd, regular);
      assert.equal(asFree.applied_iqd, regular);
      assert.equal(asFree.cost_iqd, cost);

      const asPrime = resolveUnitPrice({ product: A1(), optionId: id, transportMethod, ...prime });
      assert.equal(asPrime.applied_iqd, primeP);
      assert.equal(asPrime.applied_tier, 'prime');

      const asPro = resolveUnitPrice({ product: A1(), optionId: id, transportMethod, ...pro });
      assert.equal(asPro.applied_iqd, proP);
      assert.equal(asPro.applied_tier, 'pro');
    });
  }

  test('the PRO price may be IDENTICAL across the two availabilities of one model', () => {
    // The owner said so explicitly: PRO pays 799,000 for the A1 whichever way
    // it is bought, while regular and PRIME differ by 51,000 and 50,000.
    const preorder = resolveUnitPrice({ product: A1(), optionId: 'a1-preorder', transportMethod: 'air', ...pro });
    const direct = resolveUnitPrice({ product: A1(), optionId: 'a1-direct', ...pro });
    assert.equal(preorder.applied_iqd, direct.applied_iqd);
    assert.equal(preorder.applied_iqd, 799_000);
    // And a PRO member pays the SAME total either way on this product, which
    // is not a coincidence to paper over: the air commission is waived for PRO
    // and no immediacy premium is configured, so the only two things that
    // could separate the journeys are both zero for this buyer.
    assert.equal(preorder.unit_subtotal_iqd, 799_000);
    assert.equal(direct.unit_subtotal_iqd, 799_000);
    // The journeys DO separate for anyone who pays the commission...
    const freePre = resolveUnitPrice({ product: A1(), optionId: 'a1-preorder', transportMethod: 'air', ...free });
    const freeDirect = resolveUnitPrice({ product: A1(), optionId: 'a1-direct', ...free });
    assert.notEqual(freePre.unit_subtotal_iqd, freeDirect.unit_subtotal_iqd);
    // ...and for PRO too, the moment the owner prices immediacy.
    const withPremium = A1();
    withPremium.direct_surcharge_iqd = 50_000;
    const proDirect = resolveUnitPrice({ product: withPremium, optionId: 'a1-direct', ...pro });
    assert.equal(proDirect.unit_subtotal_iqd, 849_000);
  });

  test('PRO has the air commission waived; a free customer pays it', () => {
    const asPro = resolveUnitPrice({ product: A1(), optionId: 'a1-preorder', transportMethod: 'air', ...pro });
    assert.equal(asPro.transport?.waived, true);
    assert.equal(asPro.unit_subtotal_iqd, 799_000);
    const asFree = resolveUnitPrice({ product: A1(), optionId: 'a1-preorder', transportMethod: 'air', ...free });
    assert.equal(asFree.transport?.waived, false);
    assert.equal(asFree.unit_subtotal_iqd, 924_000);
  });

  test('cost is carried per option and is never part of what the buyer pays', () => {
    for (const [id, regular, , , cost] of cells) {
      const r = resolveUnitPrice({
        product: A1(), optionId: id, transportMethod: id.includes('preorder') ? 'air' : null, ...free,
      });
      assert.equal(r.cost_iqd, cost);
      assert.ok(r.unit_subtotal_iqd >= regular, 'the buyer never pays less than the regular price');
      assert.notEqual(r.unit_subtotal_iqd, cost);
    }
  });

  test('stock is per option: the direct cells track it, the pre-order cells do not', () => {
    const byId = new Map(A1().options.map((o) => [o.id, o]));
    assert.equal(byId.get('a1-direct')?.stock, 4);
    assert.equal(byId.get('a1-combo-direct')?.stock, 2);
    assert.equal(byId.get('a1-preorder')?.stock, null);
    assert.equal(byId.get('a1-combo-preorder')?.stock, null);
  });
}

// -------------------------------------------- 4. grouping by data, not names

{
  test('the four options collapse into two models', () => {
    const keys = [...new Set(A1().options.map((o) => o.variant_key))];
    assert.deepEqual(keys, ['a1', 'a1-combo']);
  });

  test('each model offers both availabilities', () => {
    for (const key of ['a1', 'a1-combo']) {
      const inModel = A1().options.filter((o) => o.variant_key === key);
      assert.deepEqual(inModel.map((o) => o.availability_type).sort(), ['direct_sale', 'pre_order']);
    }
  });

  test('name parsing is the FALLBACK, and it reads the owner’s own labels', () => {
    assert.equal(variantLabelFallback('A1 Combo - Pre-order'), 'A1 Combo');
    assert.equal(variantLabelFallback('A1 - Direct Sale'), 'A1');
    assert.equal(variantLabelFallback('A1 Combo (Pre-order)'), 'A1 Combo');
    assert.equal(variantLabelFallback('A1 Combo — طلب مسبق'), 'A1 Combo');
    // A name with no suffix is left entirely alone.
    assert.equal(variantLabelFallback('P1S'), 'P1S');
    assert.equal(availabilityFromName('A1 - Pre-order'), 'pre_order');
    assert.equal(availabilityFromName('A1 - Direct Sale'), 'direct_sale');
    assert.equal(availabilityFromName('P1S'), '');
  });

  test('a key is derived from a label, latin or arabic', () => {
    assert.equal(variantKeyFrom('A1 Combo'), 'a1-combo');
    assert.equal(variantKeyFrom('  A1  '), 'a1');
    assert.ok(variantKeyFrom('طابعة A1').length > 0);
  });
}

// ------------------------------------------------- 5. sale types, derived

{
  test('options that disagree make the product mixed', () => {
    const st = deriveSaleTypes(A1().options, ['direct_sale']);
    assert.deepEqual(st.sort(), ['direct_sale', 'pre_order']);
    assert.equal(isMixed(st), true);
  });

  test('options that agree make the product that one thing', () => {
    const st = deriveSaleTypes([opt({ id: 'a', availability_type: 'pre_order' })], ['direct_sale']);
    assert.deepEqual(st, ['pre_order']);
    assert.equal(isMixed(st), false);
  });

  test('silent options leave the product exactly as it declared itself', () => {
    assert.deepEqual(deriveSaleTypes([opt({ id: 'a' })], ['direct_sale']), ['direct_sale']);
    assert.deepEqual(deriveSaleTypes([], ['pre_order']), ['pre_order']);
  });

  test('an inactive option does not drag the product into its route', () => {
    const st = deriveSaleTypes(
      [opt({ id: 'a', availability_type: 'direct_sale' }), opt({ id: 'b', availability_type: 'pre_order', active: false })],
      ['direct_sale']
    );
    assert.deepEqual(st, ['direct_sale']);
  });

  test('a bundle stays a bundle whatever its options say', () => {
    const st = deriveSaleTypes([opt({ id: 'a', availability_type: 'pre_order' })], ['bundle']);
    assert.ok(st.includes('bundle'));
    assert.ok(st.includes('pre_order'));
  });

  test('`mixed` is a word the template accepts, never a value it stores', () => {
    assert.deepEqual(expandSellingType('mixed'), ['direct_sale', 'pre_order']);
    assert.equal(expandSellingType('direct_sale'), null);
    assert.equal(expandSellingType(''), null);
  });
}

// ------------------------------------------------------------ 6. lead time

{
  test('prose wins over arithmetic', () => {
    assert.equal(leadTimeLabel({ text: '3-4 weeks', min_days: 21, max_days: 28 }, 'en'), '3-4 weeks');
    assert.equal(leadTimeLabel({ text: 'بعد العيد', min_days: null, max_days: null }, 'ar'), 'بعد العيد');
  });

  test('numbers are used only when there is no prose', () => {
    assert.equal(leadTimeLabel({ text: '', min_days: 21, max_days: 28 }, 'en'), '21–28 days');
    assert.equal(leadTimeLabel({ text: '', min_days: 21, max_days: 21 }, 'en'), '21 days');
    assert.equal(leadTimeLabel({ text: '', min_days: null, max_days: 30 }, 'en'), 'about 30 days');
  });

  test('an unset lead time says nothing rather than inventing a date', () => {
    assert.equal(leadTimeLabel({ text: '', min_days: null, max_days: null }, 'ar'), '');
  });
}

// -------------------------------------------------------- 7. input hygiene

{
  test('availability accepts what a human or an old file writes', () => {
    for (const v of ['pre_order', 'preorder', 'PRE-ORDER', ' Pre Order ']) {
      assert.equal(normalizeAvailability(v), 'pre_order', v);
    }
    for (const v of ['direct_sale', 'direct', 'in_stock', 'DIRECT SALE']) {
      assert.equal(normalizeAvailability(v), 'direct_sale', v);
    }
    for (const v of ['', null, undefined, 'bundle', 'nonsense']) {
      assert.equal(normalizeAvailability(v), '', String(v));
    }
  });
}
