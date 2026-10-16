/**
 * THE COLOUR AS A FIELD, FOR THE CART AND THE CHECKOUT (docs/ux/COLOUR-QUANTITIES.md §4.6).
 *
 * The checkout drew a line's colour as the last word of a 12px grey label
 * («With spool — 1 kg / BEIGE») — on the last screen where a customer could
 * still have seen that every one of their 56 pieces was beige. The cart line
 * and the checkout quote line now carry `color_tag` (the colour's id, its
 * English name, a hex and its own picture) and `options_label` (the label
 * without the colour), so the screens can draw a swatch and a name.
 *
 * ADDITIVE: `variantLabel` / `variant` keep their exact values (invoices,
 * emails and `option_snapshot` read them), and a database without 0194 — where
 * an option group has no `kind` — answers `color_tag: null` and nothing fails
 * (CLAUDE.md rule 2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, json, post, stubApp } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';

const KEY = 'products/p_pla/beige-1.webp';

function seed(raw: DatabaseSync, withKind: boolean) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_1','u1','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_pla','pla','PLA Basic','بي إل إيه',24000,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','[]','COLOR');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_spool','p_pla','Spool',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock) VALUES
      ('ov_1kg','p_pla','g_spool','With spool — 1 kg','مع بكرة — 1 كغ',0,1,NULL);
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('c_black','p_pla','Black','أسود','#000000',0,1,100),
      ('c_beige','p_pla','Beige','بيج','#E8DCC4',1,1,100);
    INSERT INTO product_images (id, product_id, url, r2_key, content_type, sort_order, is_primary, color_id)
      VALUES ('img_beige','p_pla','/files/${KEY}','${KEY}','image/webp',0,0,'c_beige');

    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_grp','grp','PLA Matte','بي إل إيه مطفي',26000,'active',500,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');
  `);
  raw.exec(
    withKind
      ? `INSERT INTO product_option_groups (id,product_id,name_en,sort,active,kind) VALUES
           ('gg_spool','p_grp','Spool',0,1,''), ('gg_col','p_grp','Colour',1,1,'color');`
      : `INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES
           ('gg_spool','p_grp','Spool',0,1), ('gg_col','p_grp','Colour',1,1);`
  );
  raw.exec(`
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock) VALUES
      ('gv_1kg','p_grp','gg_spool','1 kg','1 كغ',0,1,NULL),
      ('gv_tan','p_grp','gg_col','Desert Tan','رملي',0,1,NULL),
      ('gv_ivory','p_grp','gg_col','Ivory White','أبيض عاجي',1,1,NULL);
  `);
  if (withKind) {
    raw.exec(`
      INSERT INTO product_option_value_swatches (option_value_id, product_id, url, r2_key, published_hex, hex_source_ref)
        VALUES ('gv_tan','p_grp','/files/swatches/tan.webp','swatches/tan.webp','#C8A27A','store:page#tan');
    `);
  }
}

function setup(raw: DatabaseSync) {
  const app = stubApp(asD1(raw), { id: 'u1', role: 'customer', email: 's@x.co' }, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });
  return app;
}

type Line = { productId: string; color_id: string; variantLabel: string; color_tag: Record<string, string> | null; options_label: string };

async function cartAfterAdds(raw: DatabaseSync) {
  const app = setup(raw);
  for (const body of [
    { productId: 'p_pla', optionValueIds: ['ov_1kg'], colorId: 'c_beige', qty: 56 },
    { productId: 'p_pla', optionValueIds: ['ov_1kg'], colorId: 'c_black', qty: 2 },
    { productId: 'p_grp', optionValueIds: ['gv_1kg', 'gv_tan'], colorId: '', qty: 3 },
  ]) {
    const res = await post(app, '/api/cart/items', { ...body, fulfillmentType: 'direct_sale' });
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())).slice(0, 400));
  }
  const cart = await json(await get(app, '/api/cart'));
  return { app, items: cart.items as Line[] };
}

test('a product colour line carries color_tag {id, English name, hex, own image} and the label without the colour', async () => {
  const raw = freshDb();
  seed(raw, true);
  const { items } = await cartAfterAdds(raw);
  const beige = items.find((i) => i.color_id === 'c_beige')!;
  assert.deepEqual(beige.color_tag, { id: 'c_beige', name: 'Beige', hex: '#E8DCC4', image: `/files/${KEY}` });
  assert.equal(beige.options_label, 'With spool — 1 kg');
  assert.equal(beige.variantLabel, 'With spool — 1 kg / Beige', 'the label invoices and option_snapshot read is unchanged');
  const black = items.find((i) => i.color_id === 'c_black')!;
  assert.deepEqual(black.color_tag, { id: 'c_black', name: 'Black', hex: '#000000', image: '' }, 'no picture of its own: empty, never the product photo');
});

test('a colour OPTION GROUP value (0194 kind = color) gives the value\'s name and published hex, and leaves it out of options_label', async () => {
  const raw = freshDb();
  seed(raw, true);
  const { items } = await cartAfterAdds(raw);
  const grp = items.find((i) => i.productId === 'p_grp')!;
  assert.deepEqual(grp.color_tag, { id: 'gv_tan', name: 'Desert Tan', hex: '#C8A27A', image: '/files/swatches/tan.webp' });
  assert.equal(grp.options_label, '1 kg');
  assert.equal(grp.variantLabel, '1 kg / Desert Tan');
});

test('0194 absent (no group kind on this database): color_tag is null for a group value and nothing fails', async () => {
  const raw = dbThrough('0193');
  seed(raw, false);
  const { items } = await cartAfterAdds(raw);
  const grp = items.find((i) => i.productId === 'p_grp')!;
  assert.equal(grp.color_tag, null);
  assert.equal(grp.options_label, '1 kg / Desert Tan', 'the whole label, as before');
  // A product colour needs no 0194: it still carries its tag.
  assert.equal(items.find((i) => i.color_id === 'c_beige')!.color_tag?.name, 'Beige');
});

test('the checkout quote line carries the same two fields, beside the unchanged variant', async () => {
  const raw = freshDb();
  seed(raw, true);
  const { app } = await cartAfterAdds(raw);
  const res = await post(app, '/api/orders/quote', {
    addressId: 'addr_1',
    deliveryMethodId: 'standard',
    paymentMethodId: 'cash',
    useWallet: false,
    usePoints: false,
    itemIds: [],
  });
  const quote = await json(res);
  assert.equal(res.status, 200, JSON.stringify(quote).slice(0, 400));
  const lines = (quote.quote?.lines ?? quote.lines) as Array<Record<string, unknown>>;
  const beige = lines.find((l) => (l.color_tag as { id?: string } | null)?.id === 'c_beige');
  assert.ok(beige, JSON.stringify(lines).slice(0, 400));
  assert.equal(beige.variant, 'With spool — 1 kg / Beige');
  assert.equal(beige.options_label, 'With spool — 1 kg');
  assert.deepEqual(beige.color_tag, { id: 'c_beige', name: 'Beige', hex: '#E8DCC4', image: `/files/${KEY}` });
  const grp = lines.find((l) => l.product_id === 'p_grp')!;
  assert.equal((grp.color_tag as { name: string }).name, 'Desert Tan');
});

test('a hex that is not a colour never reaches a style', async () => {
  const raw = freshDb();
  seed(raw, true);
  raw.exec("UPDATE product_colors SET hex = 'red;background:url(x)' WHERE id = 'c_black'");
  const { items } = await cartAfterAdds(raw);
  assert.equal(items.find((i) => i.color_id === 'c_black')!.color_tag?.hex, '');
});
