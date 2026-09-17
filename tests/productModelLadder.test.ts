/**
 * THE FIVE WRITE-TIME VIEWS OF THE LADDER REFUSE THE SAME INPUTS.
 *
 *   1. worker/lib/productModel.ts      validateProductDoc      (product save, TXT apply)
 *   2. worker/lib/productRelations.ts  validatePriceLadder     (relations PUT)
 *   3. worker/lib/importCsv.ts         parseImport             (CSV import)
 *   4. src/…/form/model.ts             validateForm            (the form's client mirror)
 *   5. worker/routes/adminPriceGrid.ts (tests/adminPriceGridRoute.test.ts runs the same list through the route)
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
import { validateForm, type FormColor, type FormValue, type RelationsState } from '../src/components/adminProducts/form/model';
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

/** 4. The form's own state, judged before the round trip. */
function viaClient(p: PricingProduct): string[] {
  const value = (o: PricingProduct['options'][number]): FormValue => ({
    id: o.id, name_en: o.id, sku_part: '', image: '', sort: 0, active: o.active !== false, stock: null, reserved: 0, low_stock_threshold: null,
    availability_type: '', lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null, variant_key: '', variant_label: '', fulfillments: [],
    regular_price_iqd: o.regular_price_iqd, prime_price_iqd: o.prime_price_iqd, pro_price_iqd: o.pro_price_iqd, cost_iqd: o.cost_iqd,
    regular_adjust_iqd: o.regular_adjust_iqd ?? null, prime_adjust_iqd: o.prime_adjust_iqd ?? null, pro_adjust_iqd: o.pro_adjust_iqd ?? null, cost_adjust_iqd: o.cost_adjust_iqd ?? null,
  });
  const colour = (c: PricingProduct['colors'][number]): FormColor => ({
    id: c.id, name_en: c.id, hex: '#000000', image: '', sku_part: '', sort: 0, active: c.active !== false, stock: null, reserved: 0, low_stock_threshold: null,
    option_value_ids: linkedOf(c),
    regular_price_iqd: c.regular_price_iqd, prime_price_iqd: c.prime_price_iqd, pro_price_iqd: c.pro_price_iqd, cost_iqd: c.cost_iqd,
    regular_adjust_iqd: c.regular_adjust_iqd ?? null, prime_adjust_iqd: c.prime_adjust_iqd ?? null, pro_adjust_iqd: c.pro_adjust_iqd ?? null, cost_adjust_iqd: c.cost_adjust_iqd ?? null,
  });
  const rel: RelationsState = {
    inventory_mode: 'BASE',
    groups: p.options.length ? [{ id: 'g', name_en: 'Model', sort: 0, active: true, values: p.options.map(value) }] : [],
    colors: p.colors.map(colour),
    variants: [],
    images: [],
  };
  const e = validateForm({
    name_en: 'P', price_iqd: p.price_iqd, prime_price_iqd: p.prime_price_iqd, pro_price_iqd: p.pro_price_iqd, product_cost_iqd: p.product_cost_iqd,
    category_id: null, sale_types: ['direct_sale'], rel, publishing: false,
  });
  return Object.entries(e).filter(([k]) => k === 'prices' || k.startsWith('value_price:') || k.startsWith('color_price:')).map(([, v]) => v);
}

const VALIDATORS = { productModel: viaProductModel, productRelations: viaProductRelations, importCsv: viaImportCsv, client: viaClient };

// ---------------------------------------------------------------- tests

test('INVARIANT: the four validators and the client mirror accept and refuse exactly the same fixtures', () => {
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
  assert.match(viaClient(p)[0], /^o1: سعر PRIME الناتج \(120,000\) أقل من سعر PRO الناتج \(125,000\)/);
});

test('M1: the client mirror derives the member price from an adjustment, and measures a fixed one against the effective regular', () => {
  const a = product({ prime_price_iqd: null, pro_price_iqd: null, options: [opt('o1', { regular_adjust_iqd: 25_000, pro_adjust_iqd: 10_000 })] });
  assert.match(viaClient(a)[0], /^o1: سعر PRO الناتج \(185,000\) أعلى من السعر الاعتيادي \(175,000\)/);
  assert.match(viaProductModel(a)[0], /the PRO price this row resolves to \(185000\) is above its regular price \(175000\)/);
  const b = product({ prime_price_iqd: null, pro_price_iqd: null, options: [opt('o1', { pro_price_iqd: 180_000 })] });
  assert.match(viaClient(b)[0], /^o1: سعر PRO الناتج \(180,000\) أعلى من السعر الاعتيادي \(150,000\)/);
  assert.match(viaProductModel(b)[0], /PRO \(180000\) must not be above the regular price \(150000\)/);
});

test('M3: a colour is judged under each option it is sold with, and the refusal names both', () => {
  const p = product({ options: [opt('o1', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })], colors: [col('c1', { option_id: 'o1', option_ids: ['o1'], regular_price_iqd: 130_000 })] });
  assert.match(viaProductModel(p)[0], /colors\.c1\.regular_price_iqd: with option "o1", the reduction on this colour is larger than the PRO price it inherits \(40000\) — state a PRO price for this colour, or reduce less/);
  assert.match(viaProductRelations(p)[0], /^c1: with option "o1", the reduction is larger than the PRO price this colour inherits \(40000\)/);
  assert.match(viaImportCsv(p)[0], /اللون c1 مع الخيار Model:o1: التخفيض أكبر من سعر PRO الموروث \(40000\)/);
  assert.match(viaClient(p)[0], /^c1 مع الخيار «o1»: التخفيض أكبر من سعر PRO الموروث \(40,000\)/);
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
