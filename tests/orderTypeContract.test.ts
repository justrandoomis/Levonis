/**
 * THE ORDER TYPE TRAVELS ON ITS OWN, ALL THE WAY DOWN.
 *
 * Before 0073 a line was a pre-order because a TRANSPORT came with it. That
 * conflated two of the owner's four independent concepts and made "pre-order
 * by land" the only way to say "pre-order". These tests pin the chain that
 * replaces it — page, cart column, resolver input, order snapshot — as SOURCE
 * facts, so a future edit that quietly drops the field anywhere along it fails
 * here rather than in a customer's basket.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { ROOT } from './fixtures/d1';
import { resolveUnitPrice } from '../worker/lib/pricing';
import type { PricingProduct } from '../worker/lib/pricing';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the cart line has a column for the order type, and it is constrained to nothing', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(read(join('migrations', f)));
  }
  const cols = db.prepare("SELECT * FROM pragma_table_info('cart_items')").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  const col = cols.find((c) => c.name === 'fulfillment_type');
  assert.ok(col, 'cart_items.fulfillment_type is missing');
  assert.equal(col!.notnull, 1);
  assert.equal(String(col!.dflt_value), "''", "'' is 'not stated', which is what every legacy line is");
});

test('the product page sends the order type it was told, and never one it guessed', () => {
  const page = read('src/pages/Product.tsx');
  assert.match(page, /const \[orderType, setOrderType\] = useState<'' \| 'direct_sale' \| 'pre_order'>\(''\)/);
  assert.match(page, /fulfillmentType: orderType \|\| undefined/, 'the quote carries it');
  assert.match(page, /if \(orderType\) body\.fulfillmentType = orderType/, 'and so does the add');
  // '' must stay possible: a product that sells one way never asks, and the
  // page inventing 'direct_sale' there would be a guess.
  assert.match(page, /setOrderType\(''\)/, 'a fresh product resets to unanswered');
  assert.ok(!/setOrderType\('direct_sale'\)[\s\S]{0,200}useEffect/.test(page), 'no effect defaults it');
});

test('the cart stores it, reads it back, and prefers it over the old inference', () => {
  const cart = read('worker/routes/cart.ts');
  assert.match(cart, /fulfillment_type = excluded\.fulfillment_type/, 'an upsert keeps it');
  assert.match(cart, /transport_method = \?, fulfillment_type = \?/, 'a patch writes it');
  assert.match(cart, /ci\.fulfillment_type/, 'and the read selects it');
  assert.match(
    cart,
    /preferredType: sel\.fulfillmentType \|\| \(sel\.transportMethod \? 'pre_order' : null\)/,
    'the stored answer wins; the inference is only the fallback'
  );
});

test('the quote route accepts it and refuses anything it does not recognise', () => {
  const products = read('worker/routes/products.ts');
  assert.match(
    products,
    /body\.fulfillmentType === 'direct_sale' \|\| body\.fulfillmentType === 'pre_order'/,
    'only the two real answers are taken'
  );
  const cart = read('worker/routes/cart.ts');
  assert.match(cart, /oneOf\(v, 'fulfillmentType', \['direct_sale', 'pre_order'\] as const\)/);
});

// ---------------------------------------------------------------------------

const product = (over: Partial<PricingProduct> = {}): PricingProduct => ({
  price_iqd: 499_000,
  pro_price_iqd: null,
  prime_price_iqd: null,
  product_cost_iqd: null,
  options: [],
  colors: [],
  preorder_transports: [{ method: 'air', commission_iqd: 50_000, active: true }],
  warranty_plans: [],
  selling_type: 'pre_order',
  sale_types: ['pre_order', 'direct_sale'],
  ...over,
});

test('a pre-order can be stated WITHOUT naming a route, which the old inference could not express', () => {
  const r = resolveUnitPrice({
    product: product(),
    fulfillmentType: 'pre_order',
    tier: 'free',
    tierActive: false,
  });
  assert.equal(r.fulfillment.type, 'pre_order');
  assert.equal(r.fulfillment.source, 'stated');
  // The route is still required to price the journey — the customer is simply
  // being asked for it as a SECOND question rather than as the first one.
  assert.ok(r.errors.includes('TRANSPORT_REQUIRED'));
});

test('the order snapshot carries every component, so a receipt never re-derives one', () => {
  const r = resolveUnitPrice({
    product: product({
      options: [
        {
          id: 'm',
          name_ar: 'Combo',
          name_en: 'Combo',
          name_ckb: '',
          image: '',
          order: 0,
          active: true,
          variant_key: 'combo',
          regular_price_iqd: null,
          prime_price_iqd: null,
          pro_price_iqd: null,
          cost_iqd: null,
          regular_adjust_iqd: 200_000,
          fulfillments: [
            {
              fulfillment_type: 'pre_order',
              regular_price_iqd: null,
              prime_price_iqd: null,
              pro_price_iqd: null,
              cost_iqd: null,
              regular_adjust_iqd: 10_000,
            },
          ],
        },
      ],
    }),
    optionId: 'm',
    fulfillmentType: 'pre_order',
    transportMethod: 'air',
    tier: 'free',
    tierActive: false,
  });

  assert.deepEqual(r.components, {
    base_iqd: 499_000,
    option_iqd: 699_000,
    fulfillment_iqd: 709_000,
    transport_iqd: 709_000,
    color_iqd: 709_000,
    membership_adjustment_iqd: 0,
    transport_fee_iqd: 50_000,
    direct_fee_iqd: 0,
    warranty_fee_iqd: 0,
  });
  // Every delta is a subtraction the reader can do, with no guessing about
  // which rung moved the price.
  assert.equal(r.components.option_iqd - r.components.base_iqd, 200_000, 'the model added this');
  assert.equal(r.components.fulfillment_iqd - r.components.option_iqd, 10_000, 'the order type added this');
  assert.equal(r.unit_subtotal_iqd, 709_000 + 50_000);
  assert.equal(r.fulfillment.variant_key, 'combo', 'the MODEL is named, not just the option row');
});

test('a PRO member sees the membership move reported separately from the fees', () => {
  const r = resolveUnitPrice({
    product: product({ price_iqd: 1_000_000, pro_price_iqd: 900_000 }),
    fulfillmentType: 'pre_order',
    transportMethod: 'air',
    tier: 'pro',
    tierActive: true,
  });
  assert.equal(r.components.membership_adjustment_iqd, -100_000);
  assert.equal(r.components.transport_fee_iqd, 0, 'waived for an active PRO');
  assert.equal(
    r.components.color_iqd + r.components.membership_adjustment_iqd + r.components.transport_fee_iqd,
    r.unit_subtotal_iqd,
    'the parts add up to what is charged'
  );
});
