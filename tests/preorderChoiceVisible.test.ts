/**
 * THE OWNER'S BAMBU LAB A1 PAGE, AND THE QUESTION IT HAS TO ANSWER OUT LOUD:
 * «بيع مباشر أم طلب مسبق؟»
 *
 * The complaint was a screenshot: a product whose every model carries BOTH
 * order types, with a priced LAND route on the pre-order side, showing a green
 * «بيع مباشر» badge, two flat chips («A1 Combo — بقي ٤», «A1 — نفد»), and no
 * availability choice anywhere on the page.
 *
 * Two separate untruths produced it, one on each side of the wire, and this
 * file pins both:
 *
 *   1. THE READER ANSWERED ABOUT A SELECTION NOBODY HAD MADE YET. The cells
 *      were consulted only for models already in `selectedValueIds`, which is
 *      empty on the first paint — so a product with pre-order on every model
 *      came back `PREORDER_NOT_ENABLED`, `modes: [direct_sale]`,
 *      `transports: []`. Before a model is picked the honest answer is what the
 *      product OFFERS, which is the union of its models.
 *
 *   2. THE PAGE HID THE CHOICE UNLESS BOTH HALVES WERE OPEN TODAY. The chooser
 *      was gated on `directUsable && preUsable`, so a model sold out on the
 *      shelf with its pre-order wide open rendered nothing at all — the buyer
 *      read «نفد» and had no way to learn the thing could still be ordered.
 *
 * Every assertion below is against the REAL product router and the REAL
 * migrations; the page's own JSX conditions are applied to the real response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, stubApp, get, post, json, type StubUser } from './fixtures/app';
import { productRoutes } from '../worker/routes/products';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const shopApp = (db: unknown) => stubApp(db, buyer, (a) => a.route('/api/products', productRoutes));

interface Mode {
  type: 'direct_sale' | 'pre_order';
  usable: boolean;
  reason: string | null;
}

/**
 * The owner's product. `availability_type` is EMPTY on both models — which is
 * exactly what the «نوع الطلب لكل موديل» door writes — and the order types live
 * in `product_option_fulfillment` with the route in `product_option_transports`.
 *
 * A1 Combo has four on the shelf; A1 has none. Both can be pre-ordered by land.
 */
function seedA1(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','Bambu Lab A1','بامبو A1','بامبو A1',725000,'active',NULL,'[]','[]',
            'direct_sale','["direct_sale"]','[]','["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g','p_a1','Model',0,1);
    INSERT INTO product_option_values
      (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type,variant_key,variant_label) VALUES
      ('v_combo','p_a1','g','A1 Combo','A1 كومبو',0,1,4,'','a1-combo','A1 Combo'),
      ('v_a1','p_a1','g','A1','A1',1,1,0,'','a1','A1');
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity) VALUES
      ('f_combo_d','p_a1','v_combo','direct_sale',1,NULL),
      ('f_combo_p','p_a1','v_combo','pre_order',1,NULL),
      ('f_a1_d','p_a1','v_a1','direct_sale',1,NULL),
      ('f_a1_p','p_a1','v_a1','pre_order',1,NULL);
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,surcharge_iqd) VALUES
      ('t_combo_land','p_a1','f_combo_p','land',1,25000),
      ('t_a1_land','p_a1','f_a1_p','land',1,25000);
  `);
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)").run(
    JSON.stringify({ ordinary_iqd: 5000 })
  );
  return raw;
}

const modesOf = (a: { modes?: Mode[] }): Mode[] => a.modes ?? [];
const usable = (a: { modes?: Mode[] }, type: Mode['type']) =>
  modesOf(a).some((m) => m.type === type && m.usable);
/** The page's own gate, quoted: `modesArr.length >= 2`. */
const chooserRenders = (a: { modes?: Mode[] }) => modesOf(a).length >= 2;

test('THE FIRST PAINT names both ways and defaults to the stocked direct-sale model', async () => {
  const app = shopApp(asD1(seedA1()));
  const detail = await json(await get(app, '/api/products/a1'));
  const a = detail.availability;

  assert.deepEqual(
    detail.initial_selection,
    {
      option_id: 'v_combo',
      option_value_ids: ['v_combo'],
      color_id: null,
      fulfillment_type: 'direct_sale',
    },
    'the first stocked complete selection is chosen server-side'
  );
  assert.deepEqual(
    modesOf(a).map((m) => [m.type, m.usable]),
    [['direct_sale', true], ['pre_order', true]],
    'the stocked opening selection keeps both offered ways visible'
  );
  assert.equal(a.preorder.enabled, true, 'pre-order is enabled by the MODELS, not only by sale_types');
  assert.equal(a.preorder.usable, true);
  assert.equal(a.preorder.reason, null, 'PREORDER_NOT_ENABLED was the old answer and it was false');
  assert.deepEqual(
    a.preorder.transports.map((t: { method: string; configured: boolean }) => [t.method, t.configured]),
    [['land', true]],
    'the route the admin priced on the model reaches the page with nothing selected'
  );
  assert.equal(chooserRenders(a), true, 'so «طريقة التوفر» is on the page');
});

test('the option cells reach the browser, with the cost stripped', async () => {
  const app = shopApp(asD1(seedA1()));
  const detail = await json(await get(app, '/api/products/a1'));
  const options: Array<Record<string, unknown>> = detail.product.options;

  for (const o of options) {
    const cells = o.fulfillments as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(cells) && cells.length === 2, `${o.id} publishes its order-type cells`);
    // §11/§22: what the shop paid never leaves the building.
    for (const c of cells) {
      assert.ok(!('cost_iqd' in c), 'a cell must not publish cost');
      for (const t of (c.transports as Array<Record<string, unknown>>) ?? []) {
        assert.ok(!('cost_iqd' in t), 'a route must not publish cost');
      }
    }
  }
  // The legacy field is empty on a product configured through the new door —
  // which is why nothing may be decided from it alone.
  assert.deepEqual(options.map((o) => o.availability_type), ['', '']);
});

test('choosing a model narrows the answer to that model, and keeps both types', async () => {
  const app = shopApp(asD1(seedA1()));
  const q = await json(
    await post(app, '/api/products/a1/quote', {
      productId: 'p_a1', qty: 1, optionId: 'v_combo', optionValueIds: ['v_combo'],
    })
  );
  const a = q.availability;
  assert.equal(usable(a, 'direct_sale'), true, 'four on the shelf');
  assert.equal(usable(a, 'pre_order'), true, 'and it can be ordered too');
  assert.equal(a.mode, 'direct_sale', 'with stock present, direct sale is the default');
});

test('SOLD OUT ON THE SHELF still shows the choice, with the closed half named', async () => {
  const app = shopApp(asD1(seedA1()));
  const q = await json(
    await post(app, '/api/products/a1/quote', {
      productId: 'p_a1', qty: 1, optionId: 'v_a1', optionValueIds: ['v_a1'],
    })
  );
  const a = q.availability;

  assert.equal(chooserRenders(a), true, 'the chooser is drawn even though one half is shut');
  assert.equal(usable(a, 'direct_sale'), false);
  assert.equal(
    modesOf(a).find((m) => m.type === 'direct_sale')?.reason,
    'OUT_OF_STOCK',
    'and the disabled button has a reason to print — never a dead chip'
  );
  assert.equal(usable(a, 'pre_order'), true, 'pre-order is the way to buy it, and it is offered');
  assert.equal(a.mode, 'preorder', 'so the page defaults to pre-order and shows its journeys');
});

test('a product with no pre-order anywhere is untouched — one mode, no chooser', async () => {
  const raw = seedA1();
  raw.exec(`DELETE FROM product_option_transports; DELETE FROM product_option_fulfillment WHERE fulfillment_type = 'pre_order';`);
  const app = shopApp(asD1(raw));
  const detail = await json(await get(app, '/api/products/a1'));
  const a = detail.availability;

  assert.deepEqual(modesOf(a).map((m) => m.type), ['direct_sale'], 'nothing invented');
  assert.equal(chooserRenders(a), false, 'and no chooser on a product that offers one way to buy');
  assert.equal(a.preorder.enabled, false);
  assert.equal(a.preorder.reason, 'PREORDER_NOT_ENABLED', 'which is TRUE here, and only here');
});

test('the page draws the chooser from `modes`, and explains a closed half', () => {
  const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.match(page, /const offersBoth = modesArr\.length >= 2/, 'the gate is what the product OFFERS');
  assert.doesNotMatch(
    page,
    /\{bothUsable \? \(/,
    'and never again what happens to be buyable today'
  );
  // The closed half must carry a sentence, not just a grey box.
  assert.match(page, /data-mode-closed[\s\S]{0,200}reasonText\(s, modeOf\('direct_sale'\)\?\.reason\)/);
  assert.match(page, /data-mode-closed[\s\S]{0,200}reasonText\(s, modeOf\('pre_order'\)\?\.reason\)/);
  // The transports follow the order type in force, not the button state, so a
  // pre-order-only product shows its journeys before anything is clicked.
  assert.match(page, /const effectivePreorder = orderType \? wantPreorder : mode === 'preorder'/);
  assert.match(page, /const showTransports = effectivePreorder &&/);
});
