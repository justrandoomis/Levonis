/**
 * THE BATCH DOOR'S RULES ARE THE SINGLE DOOR'S RULES (docs/ux/COLOUR-QUANTITIES.md §4.2).
 *
 * `POST /api/cart/items/batch` must never admit a line `POST /api/cart/items`
 * refuses, nor refuse one it admits, nor say it differently. Both doors call
 * the same extracted functions (worker/lib/cartAdd.ts); this is the proof that
 * they behave the same. Every body below goes through the single door on one
 * fresh database and through the batch door, as a one-line batch, on another:
 *
 *   * the status and the code are equal;
 *   * a LINE refusal's `details` (the counted remainder, the offered routes)
 *     equal the batch's `details.lines[0]` beyond its index and identity;
 *   * a PRODUCT refusal (said once per batch) carries the same `details`;
 *   * a success writes the identical `cart_items` row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, freshDb, json, post, stubApp } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';

const PLANS = JSON.stringify([
  { id: 'wp_ext12', title_ar: 'ضمان +12', title_en: 'Extended +12', duration_months: 12, duration_kind: 'extension', fee_iqd: 0, fee_percent: 7.5, order: 0, active: true },
]);

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');

    -- Options in two groups, colours with stock, one colour linked to one option, one inactive colour.
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode,warranty_plans)
      VALUES ('p_fil','fil','PLA Basic','بي إل إيه',24000,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','[]','COLOR','${PLANS}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES
      ('g_spool','p_fil','Spool',0,1),
      ('g_size','p_fil','Size',1,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock) VALUES
      ('v_spool','p_fil','g_spool','With spool','مع بكرة',0,1,NULL),
      ('v_refill','p_fil','g_spool','Refill','عبوة',1,1,NULL),
      ('v_1kg','p_fil','g_size','1 kg','1 كغ',0,1,NULL);
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('c_black','p_fil','Black','أسود','#000000',0,1,40),
      ('c_white','p_fil','White','أبيض','#FFFFFF',1,1,0),
      ('c_gold','p_fil','Gold','ذهبي','#D4AF37',2,1,10),
      ('c_old','p_fil','Retired','قديم','#777777',3,0,10);
    INSERT INTO product_color_option_links (color_id,option_value_id,group_id) VALUES ('c_gold','v_spool','g_spool');

    -- A pre-order product with one air route, and a direct-only product.
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_pre','pre','Imported printer','طابعة',500000,'active',0,'[]','[]','pre_order','["pre_order"]',
              '[{"method":"air","commission_iqd":25000,"active":true}]','[]'),
             ('p_dir','dir','Nozzle','فوهة',5000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','[]'),
             ('p_dual','dual','Hotend','رأس طباعة',90000,'active',0,'[]','[]','direct_sale','["direct_sale","pre_order"]',
              '[{"method":"air","commission_iqd":25000,"active":true}]','[]');
  `);
}

const KEEP = ['index', 'color_id', 'option_value_ids', 'code', 'message'];
const lineDetails = (line: Record<string, unknown>) => Object.fromEntries(Object.entries(line).filter(([k]) => !KEEP.includes(k)));
const rowsOf = (raw: DatabaseSync) =>
  all<Record<string, unknown>>(raw, "SELECT * FROM cart_items WHERE user_id = 'u1'").map(({ id: _id, created_at: _c, updated_at: _u, ...rest }) => rest);

interface Case {
  name: string;
  /** The single door's code this case is about (proves the case reaches its branch). */
  code: string;
  body: Record<string, unknown>;
  /** Run against the database before the request (after the first publish). */
  before?: (raw: DatabaseSync) => void;
  /** A product-level refusal: said once, with no `details.lines`. */
  product?: boolean;
  /** What the single door's `details` must hold (proves the data rides, not only the code). */
  details?: Record<string, unknown>;
}

const fil = (over: Record<string, unknown>) => ({ productId: 'p_fil', fulfillmentType: 'direct_sale', qty: 1, ...over });

const CASES: Case[] = [
  { name: 'a group left unchosen (no SKU for half a selection)', code: 'VARIANT_UNAVAILABLE', body: fil({ optionValueIds: ['v_spool'], colorId: 'c_black' }) },
  { name: 'no option at all', code: 'OPTION_REQUIRED', body: fil({ optionValueIds: [], colorId: 'c_black' }) },
  { name: 'no colour', code: 'COLOR_REQUIRED', body: fil({ optionValueIds: ['v_spool', 'v_1kg'], colorId: '' }) },
  { name: 'a colour not offered with the chosen option', code: 'COLOR_OPTION_MISMATCH', body: fil({ optionValueIds: ['v_refill', 'v_1kg'], colorId: 'c_gold' }) },
  { name: 'an inactive colour', code: 'COLOR_NOT_FOUND', body: fil({ optionValueIds: ['v_spool', 'v_1kg'], colorId: 'c_old' }) },
  { name: 'a sold-out colour', code: 'OUT_OF_STOCK', body: fil({ optionValueIds: ['v_spool', 'v_1kg'], colorId: 'c_white' }) },
  {
    name: 'more than the colour holds',
    code: 'QTY_UNAVAILABLE',
    body: fil({ optionValueIds: ['v_spool', 'v_1kg'], colorId: 'c_black', qty: 41 }),
    details: { available: 40, preorder: false },
  },
  { name: 'a pre-order with no route', code: 'TRANSPORT_REQUIRED', body: { productId: 'p_pre', qty: 1 } },
  {
    name: 'a dual-mode product with an empty shelf and no route named (the offered routes ride in details)',
    code: 'TRANSPORT_REQUIRED',
    body: { productId: 'p_dual', qty: 1 },
    details: { transport_methods: ['air'] },
  },
  { name: 'a pre-order of a direct-only product (no pre-order channel)', code: 'VARIANT_UNAVAILABLE', body: { productId: 'p_dir', qty: 1, fulfillmentType: 'pre_order', transportMethod: 'air' } },
  {
    name: 'a colour added after the price was published (no SKU price)',
    code: 'VARIANT_UNAVAILABLE',
    body: fil({ optionValueIds: ['v_spool', 'v_1kg'], colorId: 'c_new' }),
    before: (raw) =>
      raw.exec("INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES ('c_new','p_fil','Jade','يشمي','#00A86B',9,1,10)"),
  },
  {
    name: 'a live offer whose price falls below the floor',
    code: 'OFFER_INACTIVE',
    body: { productId: 'p_dir', qty: 1, fulfillmentType: 'direct_sale' },
    before: (raw) =>
      raw.exec(`INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,offer_price_iqd,
                                           discount_percent,discount_iqd,plus_price_iqd,locked_preview,active)
                VALUES ('product','p_dir','ofw_zero',NULL,NULL,'[]','fixed',0,NULL,NULL,NULL,0,1)`),
  },
  { name: 'a warranty plan on a non-printer', code: 'WARRANTY_NOT_PRINTER', product: true, body: fil({ optionValueIds: ['v_spool', 'v_1kg'], colorId: 'c_black', warrantyPlanId: 'wp_ext12' }) },
  { name: 'an unknown product', code: 'NOT_FOUND', product: true, body: { productId: 'p_none', qty: 1 } },
];

/** One fresh database per door, published by the first customer request, then the case's own setup. */
async function world(before?: (raw: DatabaseSync) => void) {
  const raw = freshDb();
  seed(raw);
  const app = stubApp(asD1(raw), { id: 'u1', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/cart', cartRoutes));
  // The fixture publishes every seeded product on the first customer request (tests/fixtures/autoPublish.ts).
  await app.request('/api/cart', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  before?.(raw);
  return { raw, app };
}

const asBatch = (body: Record<string, unknown>) => {
  const { qty, optionValueIds, colorId, ...shared } = body;
  return { ...shared, lines: [{ optionValueIds: optionValueIds ?? [], colorId: colorId ?? '', qty: qty ?? 1 }] };
};

for (const c of CASES) {
  test(`parity: ${c.name} — ${c.code}`, async () => {
    const one = await world(c.before);
    const single = await post(one.app, '/api/cart/items', c.body);
    const s = await json(single);
    assert.equal(s.code, c.code, `the single door answers ${c.code} here: ${JSON.stringify(s)}`);
    if (c.details) assert.deepEqual(s.details, c.details);

    const two = await world(c.before);
    const batch = await post(two.app, '/api/cart/items/batch', asBatch(c.body));
    const b = await json(batch);
    assert.equal(batch.status, single.status, JSON.stringify(b));
    assert.equal(b.code, s.code);
    assert.equal(b.error, s.error, 'the same sentence');
    if (c.product) {
      assert.deepEqual(b.details, s.details, 'a product-level refusal carries the same details, said once');
    } else {
      assert.equal(b.details.lines.length, 1);
      assert.equal(b.details.lines[0].index, 0);
      assert.equal(b.details.lines[0].code, s.code);
      assert.deepEqual(lineDetails(b.details.lines[0]), s.details ?? {}, 'the line carries exactly the single door\'s details');
    }
    assert.deepEqual(rowsOf(two.raw), [], 'nothing written by the batch');
  });
}

test('parity: a success writes the identical row through either door', async () => {
  const body = fil({ optionValueIds: ['v_1kg', 'v_spool'], colorId: 'c_black', qty: 7 });
  const one = await world();
  const single = await post(one.app, '/api/cart/items', body);
  assert.equal(single.status, 200, JSON.stringify(await json(single.clone())));
  const two = await world();
  const batch = await post(two.app, '/api/cart/items/batch', asBatch(body));
  assert.equal(batch.status, 200, JSON.stringify(await json(batch.clone())));
  assert.deepEqual(rowsOf(two.raw), rowsOf(one.raw));
  assert.equal(rowsOf(one.raw)[0].option_value_ids, '["v_1kg","v_spool"]', 'canonical identity, either door');
});

test('parity: a second add merges to the same ceiling through either door', async () => {
  const body = fil({ optionValueIds: ['v_spool', 'v_1kg'], colorId: 'c_black', qty: 30 });
  const one = await world();
  await post(one.app, '/api/cart/items', body);
  await post(one.app, '/api/cart/items', body);
  const two = await world();
  await post(two.app, '/api/cart/items', body);
  await post(two.app, '/api/cart/items/batch', asBatch(body));
  assert.deepEqual(rowsOf(two.raw).map((r) => r.qty), [40]);
  assert.deepEqual(rowsOf(two.raw), rowsOf(one.raw), '30 + 30 on a shelf of 40 is 40 either way');
});
