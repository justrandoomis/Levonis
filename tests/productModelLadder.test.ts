/**
 * THE WRITE-TIME VIEWS OF THE LADDER REFUSE THE SAME INPUTS.
 *
 *   1. worker/lib/productModel.ts      validateProductDoc      (product save, TXT apply)
 *   2. worker/lib/productRelations.ts  validatePriceLadder     (relations PUT)
 *   3. worker/lib/importCsv.ts         parseImport             (CSV import)
 *   4. worker/routes/adminPriceGrid.ts (tests/adminPriceGridRoute.test.ts runs the same list through the route)
 *
 * The product form's client mirror (src/…/form/model.ts `validateForm`) left
 * this list with Pricing V2 (DECISIONS row 222, spec addendum A.6): the form
 * types no dinar price any more, so it judges none (tests/productFormV2.test.ts).
 *
 * They are fed the shared fixture list (tests/pricingLadderFixtures.ts) and
 * must agree on every verdict, and every refusal must name the row — and, for
 * a colour judged under an option, that option. A rule one of them learns and
 * another does not is exactly how the product form ends up refusing a save on
 * a field it does not display (M1, M2).
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PricingProduct } from '../worker/lib/pricing';
import { validateProductDoc } from '../worker/lib/productModel';
import { optionLaddersFor, validatePriceLadder } from '../worker/lib/productRelations';
import { parseImport, templateShape, toCsv } from '../worker/lib/importCsv';
import { LADDER_FIXTURES, col, opt, product, type LadderFixture } from './pricingLadderFixtures';

// ------------------------------------------------------------- adapters

/** 1. The product document, as the form and the TXT apply post it. */
function viaProductModel(p: PricingProduct): string[] {
  try {
    validateProductDoc({
      name_ar: 'منتج', name_en: 'Product', price_iqd: p.price_iqd, prime_price_iqd: p.prime_price_iqd, pro_price_iqd: p.pro_price_iqd,
      product_cost_iqd: p.product_cost_iqd, selling_type: 'direct_sale', options: p.options, colors: p.colors,
    });
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}

const linkedOf = (c: PricingProduct['colors'][number]) => (c.option_ids && c.option_ids.length ? c.option_ids : c.option_id ? [c.option_id] : []);

/** 2. What the relations PUT runs on each row, with the option ladders its colour check needs. */
function viaProductRelations(p: PricingProduct): string[] {
  const base = { regular: p.price_iqd, prime: p.prime_price_iqd, pro: p.pro_price_iqd };
  const errors = validatePriceLadder(
    { regular_price_iqd: p.price_iqd, prime_price_iqd: p.prime_price_iqd, pro_price_iqd: p.pro_price_iqd, cost_iqd: p.product_cost_iqd },
    'product'
  );
  for (const o of p.options) errors.push(...validatePriceLadder(o, o.id, base));
  const options = p.options.map((o) => ({ id: o.id, where: `"${o.id}"`, active: o.active, prices: o }));
  for (const c of p.colors) errors.push(...validatePriceLadder(c, c.id, base, optionLaddersFor(base, options, linkedOf(c))));
  return errors;
}

/** 3. The same product as CSV rows. */
const shape = templateShape('printer', ['fdm-printers'], { includeCost: true });
const csvRow = (v: Record<string, string>) => shape.columns.map((c) => v[c] ?? '');
const cell = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
function viaImportCsv(p: PricingProduct): string[] {
  const rows = [
    csvRow({ row_type: 'product', key: 'K', name: 'X', price_iqd: cell(p.price_iqd), prime_price_iqd: cell(p.prime_price_iqd), pro_price_iqd: cell(p.pro_price_iqd) }),
    ...p.options.map((o) =>
      csvRow({
        row_type: 'option', key: 'K', group: 'Model', value: o.id, active: o.active === false ? 'no' : 'yes',
        price_iqd: cell(o.regular_price_iqd), prime_price_iqd: cell(o.prime_price_iqd), pro_price_iqd: cell(o.pro_price_iqd),
        regular_adjust_iqd: cell(o.regular_adjust_iqd), prime_adjust_iqd: cell(o.prime_adjust_iqd), pro_adjust_iqd: cell(o.pro_adjust_iqd),
      })
    ),
    ...p.colors.map((c) =>
      csvRow({
        row_type: 'color', key: 'K', value: c.id, hex: '#000000', links: linkedOf(c).map((id) => `Model:${id}`).join('|'),
        price_iqd: cell(c.regular_price_iqd), prime_price_iqd: cell(c.prime_price_iqd), pro_price_iqd: cell(c.pro_price_iqd),
        regular_adjust_iqd: cell(c.regular_adjust_iqd), prime_adjust_iqd: cell(c.prime_adjust_iqd), pro_adjust_iqd: cell(c.pro_adjust_iqd),
      })
    ),
  ];
  return parseImport(toCsv([shape.columns, ...rows]), shape).issues.filter((i) => i.severity === 'error').map((i) => i.message);
}

const VALIDATORS = { productModel: viaProductModel, productRelations: viaProductRelations, importCsv: viaImportCsv };

// ---------------------------------------------------------------- tests

test('INVARIANT: the server validators accept and refuse exactly the same fixtures', () => {
  for (const f of LADDER_FIXTURES) {
    for (const [name, run] of Object.entries(VALIDATORS)) {
      const errors = run(f.product);
      if (f.verdict === 'accept') assert.deepEqual(errors, [], `${name} refused "${f.name}"`);
      else assert.ok(errors.length > 0, `${name} accepted "${f.name}"`);
    }
  }
});

test('every refusal names the row — and the option a colour was judged under', () => {
  for (const f of LADDER_FIXTURES.filter((x): x is LadderFixture & { names: string[] } => x.verdict === 'refuse' && !!x.names)) {
    for (const [name, run] of Object.entries(VALIDATORS)) {
      const text = run(f.product).join('\n');
      for (const n of f.names) assert.ok(text.includes(n), `${name} on "${f.name}" does not name "${n}":\n${text}`);
    }
  }
});

test('H1: the derived-order refusal says which row, and which two numbers', () => {
  const p = product({ options: [opt('o1', { regular_adjust_iqd: 25_000, prime_price_iqd: 120_000 })] });
  assert.match(viaProductModel(p)[0], /options\.o1\.prime_price_iqd: the PRIME price this row resolves to \(120000\) is below the PRO price it resolves to \(125000\)/);
  assert.match(viaProductRelations(p)[0], /^o1: the PRIME price this row resolves to \(120000\) is below the PRO price it resolves to \(125000\)/);
  assert.match(viaImportCsv(p)[0], /الخيار o1: سعر PRIME الناتج \(120000\) أقل من سعر PRO الناتج \(125000\)/);
});

test('M3: a colour is judged under each option it is sold with, and the refusal names both', () => {
  const p = product({ options: [opt('o1', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })], colors: [col('c1', { option_id: 'o1', option_ids: ['o1'], regular_price_iqd: 130_000 })] });
  assert.match(viaProductModel(p)[0], /colors\.c1\.regular_price_iqd: with option "o1", the reduction on this colour is larger than the PRO price it inherits \(40000\) — state a PRO price for this colour, or reduce less/);
  assert.match(viaProductRelations(p)[0], /^c1: with option "o1", the reduction is larger than the PRO price this colour inherits \(40000\)/);
  assert.match(viaImportCsv(p)[0], /اللون c1 مع الخيار Model:o1: التخفيض أكبر من سعر PRO الموروث \(40000\)/);
  // …and stating the colour's own PRO is the way out every message points to.
  const fixed = product({ options: [opt('o1', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })], colors: [col('c1', { option_id: 'o1', option_ids: ['o1'], regular_price_iqd: 130_000, pro_price_iqd: 100_000 })] });
  for (const [name, run] of Object.entries(VALIDATORS)) assert.deepEqual(run(fixed), [], name);
});

test('the colour check honours the link set: a colour linked to two options is judged under both, not under every option', () => {
  const options = [opt('o1', { regular_adjust_iqd: 25_000 }), opt('o2', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 }), opt('o3', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })];
  const refused = product({ options, colors: [col('c1', { option_ids: ['o1', 'o2'], regular_price_iqd: 130_000 })] });
  const accepted = product({ options, colors: [col('c1', { option_ids: ['o1'], regular_price_iqd: 130_000 })] });
  for (const [name, run] of Object.entries(VALIDATORS)) {
    const text = run(refused).join('\n');
    assert.ok(text.includes('o2') && !text.includes('o3'), `${name}: judged under the linked o2, not the unlinked o3:\n${text}`);
    assert.deepEqual(run(accepted), [], name);
  }
});

test('the validators do not refuse what only the resolver caps: a colour PRO above one option\'s regular is accepted everywhere', () => {
  // cheapestBase.ts measures colours against the base for THIS rule and the
  // resolver caps the member price on the line; refusing here would turn
  // every such catalogue unsaveable overnight.
  const p = product({ price_iqd: 60_000, prime_price_iqd: null, pro_price_iqd: null, options: [opt('a', { regular_price_iqd: 50_000 }), opt('b')], colors: [col('k', { pro_price_iqd: 58_000 })] });
  for (const [name, run] of Object.entries(VALIDATORS)) assert.deepEqual(run(p), [], name);
});
