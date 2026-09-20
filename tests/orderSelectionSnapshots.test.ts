import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  all,
  asD1,
  freshDb,
  get,
  json,
  post,
  row,
  stubApp,
} from './fixtures/app';
import { acceptedPolicies } from './lib/policies';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { productGalleryForSelection } from '../src/lib/productImage';
import { seedCatalogue, orderBody } from './lib/bundles';
import { addMysteryOffer } from './lib/mysteryOffer';

const DIMENSIONS = {
  net_weight_g: 8300,
  width_mm: 385,
  depth_mm: 410,
  height_mm: 430,
  package_weight_g: 13500,
  package_width_mm: 560,
  package_depth_mm: 540,
  package_height_mm: 430,
};

test('order-item image and physical facts remain immutable after catalogue edits', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO users (id,email,name) VALUES ('u1','u1@example.com','Buyer');
    INSERT INTO products
      (id,slug,name,name_ar,price_iqd,images,net_weight_g,width_mm,depth_mm,height_mm,
       package_weight_g,package_width_mm,package_depth_mm,package_height_mm)
    VALUES
      ('p1','a1-combo','A1 Combo','A1 Combo',500000,'[]',8300,385,410,430,13500,560,540,430);
    INSERT INTO orders
      (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
       subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
    VALUES ('ORD-1','u1','{}','standard','{}','cod',500000,1400,500000,500000);
    INSERT INTO order_items
      (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,
       net_weight_g,width_mm,depth_mm,height_mm,package_weight_g,package_width_mm,package_depth_mm,package_height_mm)
    VALUES
      ('oi1','ORD-1','p1','A1 Combo','/files/products/a1-combo-old.webp','A1 Combo',1,500000,500000,
       8300,385,410,430,13500,560,540,430);

    UPDATE products
       SET images='["/files/products/a1-combo-new.webp"]',
           net_weight_g=9000, width_mm=400, depth_mm=420, height_mm=440,
           package_weight_g=15000, package_width_mm=600, package_depth_mm=580, package_height_mm=460
     WHERE id='p1';
  `);

  const saved = row<Record<string, unknown>>(
    db,
    `SELECT image_snapshot, net_weight_g, width_mm, depth_mm, height_mm,
            package_weight_g, package_width_mm, package_depth_mm, package_height_mm
       FROM order_items WHERE id = ?`,
    'oi1'
  )!;
  assert.equal(saved.image_snapshot, '/files/products/a1-combo-old.webp');
  for (const [field, value] of Object.entries(DIMENSIONS)) assert.equal(saved[field], value, field);
});

test('checkout persists the exact resolved dimensions and invoice/units read the image snapshot', () => {
  const orders = readFileSync(new URL('../worker/routes/orders.ts', import.meta.url), 'utf8');
  const invoices = readFileSync(new URL('../worker/lib/invoices.ts', import.meta.url), 'utf8');

  assert.match(orders, /resolveSelectionPhysicalDimensions\(/);
  assert.match(
    orders,
    /INSERT INTO order_items[^`]*net_weight_g[^`]*package_height_mm[\s\S]*it\.physical_dimensions\.net_weight_g[\s\S]*it\.physical_dimensions\.package_height_mm/
  );
  assert.match(orders, /image:\s*String\(r\.image_snapshot \?\? ''\),/);
  assert.match(invoices, /SELECT id, product_id, name_snapshot, image_snapshot/);
  assert.match(invoices, /image:\s*it\.image_snapshot \|\| undefined/);
});

test('authored and lexical multi-option order keep one image through Product, cart, checkout, and snapshot', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role)
    VALUES ('buyer_multi','Sara','multi@example.com','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
    VALUES ('addr_multi','buyer_multi','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);

    INSERT INTO products
      (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,inventory_mode)
    VALUES
      ('p_multi','multi-option','Multi option','متعدد الخيارات',125000,'active',5,'[]','[]','direct_sale',
       '["direct_sale"]','[]','BASE');

    INSERT INTO product_option_groups (id,product_id,name_en,sort,active)
    VALUES ('g_model','p_multi','Model',0,1),
           ('g_nozzle','p_multi','Nozzle',1,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,active)
    VALUES ('z_model','p_multi','g_model','Model Z',0,1),
           ('a_nozzle','p_multi','g_nozzle','0.4 nozzle',0,1);

    INSERT INTO product_images
      (id,product_id,url,r2_key,sort_order,is_primary,content_type,bytes)
    VALUES ('img_primary','p_multi','/files/products/p_multi/primary.webp','products/p_multi/primary.webp',0,1,'image/webp',90);
    INSERT INTO product_images
      (id,product_id,url,r2_key,sort_order,is_primary,option_value_id,content_type,bytes)
    VALUES ('img_model','p_multi','/files/products/p_multi/model.webp','products/p_multi/model.webp',1,0,
            'z_model','image/webp',100),
           ('img_nozzle','p_multi','/files/products/p_multi/nozzle.webp','products/p_multi/nozzle.webp',2,0,
            'a_nozzle','image/webp',110);
  `);

  const authoritativeGallery = [
    { id: 'img_primary', url: '/files/products/p_multi/primary.webp', primary: true, order: 0 },
    {
      id: 'img_model', url: '/files/products/p_multi/model.webp', primary: false, order: 1,
      option_value_id: 'z_model',
    },
    {
      id: 'img_nozzle', url: '/files/products/p_multi/nozzle.webp', primary: false, order: 2,
      option_value_id: 'a_nozzle',
    },
  ];
  const productLead = productGalleryForSelection(authoritativeGallery, authoritativeGallery, {
    optionValueIds: ['z_model', 'a_nozzle'],
    colorId: null,
    variantId: null,
  })[0]?.url;
  assert.equal(productLead, '/files/products/p_multi/model.webp', 'Product uses authored group order');

  const db = asD1(raw);
  const app = stubApp(
    db,
    { id: 'buyer_multi', role: 'customer', email: 'multi@example.com' },
    (router) => {
      router.route('/api/cart', cartRoutes);
      router.route('/api/orders', orderRoutes);
    }
  );
  const added = await json(await post(app, '/api/cart/items', {
    productId: 'p_multi',
    qty: 1,
    optionValueIds: ['z_model', 'a_nozzle'],
  }));
  assert.equal(added.success, true, JSON.stringify(added));
  assert.equal(
    row<{ option_value_ids: string }>(raw, "SELECT option_value_ids FROM cart_items WHERE user_id='buyer_multi'")!.option_value_ids,
    '["a_nozzle","z_model"]',
    'cart identity deliberately stores the same set in lexical order'
  );

  const cart = await json(await get(app, '/api/cart'));
  assert.equal(cart.items[0].image, productLead, 'cart lexical order cannot change the selected option image');

  let request = 0;
  const orderBody = () => ({
    addressId: 'addr_multi',
    deliveryMethodId: 'standard',
    paymentMethodId: 'cash',
    itemIds: [],
    useWallet: false,
    usePoints: false,
    idempotencyKey: `multi-option-image-${++request}`,
    policyAcceptance: acceptedPolicies(),
  });
  const quoted = await json(await post(app, '/api/orders/quote', orderBody()));
  assert.equal(quoted.success, true, JSON.stringify(quoted));
  assert.equal(quoted.quote.lines[0].image, productLead, 'checkout uses the same authoritative gallery tie-break');

  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  assert.equal(
    row<{ image_snapshot: string }>(
      raw,
      'SELECT image_snapshot FROM order_items WHERE order_id = ?',
      String(placed.order.id)
    )!.image_snapshot,
    productLead,
    'the immutable order snapshot freezes the same URL'
  );
});

test('real quote and checkout freeze the exact variant image and resolved dimensions', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role)
    VALUES ('buyer','Sara','buyer@example.com','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
    VALUES ('addr','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);

    INSERT INTO products
      (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,
       inventory_mode,net_weight_g,width_mm,depth_mm,height_mm,
       package_weight_g,package_width_mm,package_depth_mm,package_height_mm)
    VALUES
      ('p_a1','bambu-a1','Bambu A1','Bambu A1',500000,'active',5,'[]','[]','direct_sale',
       '["direct_sale"]','[]','BASE',8000,430,400,450,10000,500,550,590);

    INSERT INTO product_option_groups (id,product_id,name_en,sort,active)
    VALUES ('g_model','p_a1','Model',0,1);
    INSERT INTO product_option_values
      (id,product_id,group_id,name_en,sort,active,net_weight_g,package_weight_g,package_height_mm)
    VALUES ('a1_combo','p_a1','g_model','A1 Combo',0,1,8400,12000,650);
    INSERT INTO product_colors
      (id,product_id,name_en,hex,sort,active,width_mm,package_width_mm)
    VALUES ('black','p_a1','Black','#000000',0,1,440,520);
    INSERT INTO product_color_option_links (color_id,option_value_id,group_id)
    VALUES ('black','a1_combo','g_model');
    INSERT INTO product_variants
      (id,product_id,combo_key,active,package_depth_mm)
    VALUES ('combo_black','p_a1','o:a1_combo|c:black',1,620);

    INSERT INTO product_images
      (id,product_id,url,r2_key,sort_order,is_primary,content_type,bytes)
    VALUES ('img_primary','p_a1','/files/products/p_a1/primary.webp','products/p_a1/primary.webp',0,1,'image/webp',100);
    INSERT INTO product_images
      (id,product_id,url,r2_key,sort_order,is_primary,variant_id,content_type,bytes)
    VALUES ('img_combo','p_a1','/files/products/p_a1/combo-black.webp','products/p_a1/combo-black.webp',1,0,
            'combo_black','image/webp',120);

    INSERT INTO cart_items
      (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,
       transport_method,warranty_plan_id,qty)
    VALUES ('cart_a1','buyer','p_a1','a1_combo','["a1_combo"]','black','','','',1);
  `);

  const db = asD1(raw);
  const app = stubApp(
    db,
    { id: 'buyer', role: 'customer', email: 'buyer@example.com' },
    (router) => router.route('/api/orders', orderRoutes)
  );
  let request = 0;
  const body = () => ({
    addressId: 'addr',
    deliveryMethodId: 'standard',
    paymentMethodId: 'cash',
    itemIds: [],
    useWallet: false,
    usePoints: false,
    idempotencyKey: `selection-snapshot-${++request}`,
    policyAcceptance: acceptedPolicies(),
  });

  const quoted = await json(await post(app, '/api/orders/quote', body()));
  assert.equal(quoted.success, true, JSON.stringify(quoted));
  assert.equal(
    quoted.quote.lines[0].image,
    '/files/products/p_a1/combo-black.webp',
    'the last screen before payment resolves the exact variant image'
  );

  const placed = await json(await post(app, '/api/orders', body()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = String(placed.order.id);
  const items = all<Record<string, unknown>>(
    raw,
    `SELECT image_snapshot, net_weight_g, width_mm, depth_mm, height_mm,
            package_weight_g, package_width_mm, package_depth_mm, package_height_mm
       FROM order_items WHERE order_id = ?`,
    orderId
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    image_snapshot: '/files/products/p_a1/combo-black.webp',
    net_weight_g: 8400,
    width_mm: 440,
    depth_mm: 400,
    height_mm: 450,
    package_weight_g: 12000,
    package_width_mm: 520,
    package_depth_mm: 620,
    package_height_mm: 650,
  });

  raw.exec(`
    UPDATE products
       SET net_weight_g=9000,width_mm=900,depth_mm=900,height_mm=900,
           package_weight_g=19000,package_width_mm=900,package_depth_mm=900,package_height_mm=900
     WHERE id='p_a1';
    UPDATE product_option_values
       SET net_weight_g=8800,package_weight_g=13000,package_height_mm=700
     WHERE id='a1_combo';
    UPDATE product_colors SET width_mm=460,package_width_mm=550 WHERE id='black';
    UPDATE product_variants SET package_depth_mm=680 WHERE id='combo_black';
    UPDATE product_images
       SET url='/files/products/p_a1/combo-black-new.webp',r2_key='products/p_a1/combo-black-new.webp'
     WHERE id='img_combo';
  `);

  const afterEdit = row<Record<string, unknown>>(
    raw,
    `SELECT image_snapshot, net_weight_g, width_mm, depth_mm, height_mm,
            package_weight_g, package_width_mm, package_depth_mm, package_height_mm
       FROM order_items WHERE order_id = ?`,
    orderId
  )!;
  assert.deepEqual(afterEdit, items[0], 'catalogue edits cannot rewrite the purchased physical facts');

  const shown = await json(await get(app, `/api/orders/${orderId}`));
  assert.equal(shown.success, true, JSON.stringify(shown));
  assert.equal(
    shown.order.items[0].image,
    '/files/products/p_a1/combo-black.webp',
    'customer order detail still reads image_snapshot, not the live catalogue'
  );
});

test('checkout ignores an inactive exact variant when freezing physical dimensions', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role)
    VALUES ('buyer_inactive','Sara','inactive@example.com','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
    VALUES ('addr_inactive','buyer_inactive','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1);

    INSERT INTO products
      (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,
       inventory_mode,net_weight_g,width_mm,depth_mm,height_mm,
       package_weight_g,package_width_mm,package_depth_mm,package_height_mm)
    VALUES
      ('p_inactive','inactive-variant','Inactive variant','Inactive variant',500000,'active',5,'[]','[]',
       'direct_sale','["direct_sale"]','[]','BASE',8000,430,400,450,10000,500,550,590);

    INSERT INTO product_option_groups (id,product_id,name_en,sort,active)
    VALUES ('g_inactive','p_inactive','Model',0,1);
    INSERT INTO product_option_values
      (id,product_id,group_id,name_en,sort,active,net_weight_g,package_weight_g,package_height_mm)
    VALUES ('model_inactive','p_inactive','g_inactive','Model',0,1,8400,12000,650);
    INSERT INTO product_colors
      (id,product_id,name_en,hex,sort,active,width_mm,package_width_mm)
    VALUES ('black_inactive','p_inactive','Black','#000000',0,1,440,520);
    INSERT INTO product_color_option_links (color_id,option_value_id,group_id)
    VALUES ('black_inactive','model_inactive','g_inactive');

    INSERT INTO product_variants
      (id,product_id,combo_key,active,package_weight_g,package_depth_mm)
    VALUES ('inactive_exact','p_inactive','o:model_inactive|c:black_inactive',0,99000,990);

    INSERT INTO product_images
      (id,product_id,url,r2_key,sort_order,is_primary,content_type,bytes)
    VALUES ('inactive_primary','p_inactive','/files/products/p_inactive/primary.webp',
            'products/p_inactive/primary.webp',0,1,'image/webp',100);
    INSERT INTO product_images
      (id,product_id,url,r2_key,sort_order,is_primary,variant_id,content_type,bytes)
    VALUES ('inactive_variant_image','p_inactive','/files/products/p_inactive/inactive.webp',
            'products/p_inactive/inactive.webp',1,0,'inactive_exact','image/webp',120);

    INSERT INTO cart_items
      (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,
       transport_method,warranty_plan_id,qty)
    VALUES ('cart_inactive','buyer_inactive','p_inactive','model_inactive','["model_inactive"]',
            'black_inactive','','','',1);
  `);

  const db = asD1(raw);
  const app = stubApp(
    db,
    { id: 'buyer_inactive', role: 'customer', email: 'inactive@example.com' },
    (router) => router.route('/api/orders', orderRoutes)
  );
  const placed = await json(await post(app, '/api/orders', {
    addressId: 'addr_inactive',
    deliveryMethodId: 'standard',
    paymentMethodId: 'cash',
    itemIds: [],
    useWallet: false,
    usePoints: false,
    idempotencyKey: 'inactive-variant-snapshot',
    policyAcceptance: acceptedPolicies(),
  }));
  assert.equal(placed.success, true, JSON.stringify(placed));

  assert.deepEqual(
    row<Record<string, unknown>>(
      raw,
      `SELECT image_snapshot, net_weight_g, width_mm, depth_mm, height_mm,
              package_weight_g, package_width_mm, package_depth_mm, package_height_mm
         FROM order_items WHERE order_id = ?`,
      String(placed.order.id)
    ),
    {
      image_snapshot: '/files/products/p_inactive/primary.webp',
      net_weight_g: 8400,
      width_mm: 440,
      depth_mm: 400,
      height_mm: 450,
      package_weight_g: 12000,
      package_width_mm: 520,
      package_depth_mm: 550,
      package_height_mm: 650,
    },
    'inactive variant media and dimensions cannot override active broader sources'
  );
});

test('mystery checkout freezes the drawn candidate exact dimensions without exposing them', async () => {
  const raw = seedCatalogue();
  raw.exec(`
    INSERT INTO products
      (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,
       inventory_mode,net_weight_g,width_mm,depth_mm,height_mm,
       package_weight_g,package_width_mm,package_depth_mm,package_height_mm)
    VALUES
      ('mystery_dims_candidate','mystery-dims-candidate','Mystery dimensions candidate','مرشح أبعاد',25000,
       'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','BASE',
       8000,430,400,450,10000,500,550,590);

    INSERT INTO product_option_groups (id,product_id,name_en,sort,active)
    VALUES ('mystery_dims_group','mystery_dims_candidate','Model',0,1);
    INSERT INTO product_option_values
      (id,product_id,group_id,name_en,sort,active,net_weight_g,package_weight_g,package_height_mm)
    VALUES ('mystery_dims_model','mystery_dims_candidate','mystery_dims_group','Combo',0,1,
            8400,12000,650);
    INSERT INTO product_colors
      (id,product_id,name_en,hex,sort,active,width_mm,package_width_mm)
    VALUES ('mystery_dims_black','mystery_dims_candidate','Black','#000000',0,1,440,520);
    INSERT INTO product_color_option_links (color_id,option_value_id,group_id)
    VALUES ('mystery_dims_black','mystery_dims_model','mystery_dims_group');
    INSERT INTO product_variants
      (id,product_id,combo_key,active,depth_mm,package_depth_mm)
    VALUES ('mystery_dims_exact','mystery_dims_candidate',
            'o:mystery_dims_model|c:mystery_dims_black',1,410,620);

    INSERT INTO mystery_pools (id,name,kind)
    VALUES ('mystery_dims_pool','Dimension pool','direct');
    INSERT INTO mystery_pool_entries
      (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active)
    VALUES ('mystery_dims_entry','mystery_dims_pool','mystery_dims_candidate',
            '["mystery_dims_model"]','mystery_dims_black','',1,1);
  `);
  const offerId = addMysteryOffer(raw, {
    id: 'mystery_dims_offer',
    slug: 'mystery-dims-offer',
    poolId: 'mystery_dims_pool',
    spoolQty: 1,
  });

  const db = asD1(raw);
  const app = stubApp(
    db,
    { id: 'buyer', role: 'customer', email: 's@x.co' },
    (router) => {
      router.route('/api/cart', cartRoutes);
      router.route('/api/orders', orderRoutes);
    }
  );
  const added = await json(await post(app, '/api/cart/items', { productId: offerId, qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));

  const quote = await json(await post(app, '/api/orders/quote', orderBody()));
  assert.equal(quote.success, true, JSON.stringify(quote).slice(0, 500));
  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 500));
  const orderId = String(placed.order.id);
  const allocation = row<{ order_item_id: string; product_id: string }>(
    raw,
    'SELECT order_item_id, product_id FROM mystery_allocations WHERE order_id = ?',
    orderId
  )!;
  assert.equal(allocation.product_id, 'mystery_dims_candidate');

  const selectSnapshot = () => row<Record<string, unknown>>(
    raw,
    `SELECT net_weight_g, width_mm, depth_mm, height_mm,
            package_weight_g, package_width_mm, package_depth_mm, package_height_mm
       FROM order_items WHERE id = ?`,
    allocation.order_item_id
  )!;
  const expected = {
    net_weight_g: 8400,          // option
    width_mm: 440,               // colour
    depth_mm: 410,               // active exact variant
    height_mm: 450,              // product
    package_weight_g: 12000,     // option
    package_width_mm: 520,       // colour
    package_depth_mm: 620,       // active exact variant
    package_height_mm: 650,      // option
  };
  assert.deepEqual(selectSnapshot(), expected);

  // The values are operational facts, not a pre-reveal oracle. Neither the
  // customer order projection nor the quote line exposes the internal columns.
  const publicPayloads = [JSON.stringify(quote.quote), JSON.stringify(placed.order)];
  for (const field of Object.keys(expected)) {
    for (const payload of publicPayloads) assert.ok(!payload.includes(`"${field}"`), `${field} leaked`);
  }

  raw.exec(`
    UPDATE products
       SET net_weight_g=9001,width_mm=901,depth_mm=902,height_mm=903,
           package_weight_g=19001,package_width_mm=904,package_depth_mm=905,package_height_mm=906
     WHERE id='mystery_dims_candidate';
    UPDATE product_option_values
       SET net_weight_g=9002,package_weight_g=19002,package_height_mm=907
     WHERE id='mystery_dims_model';
    UPDATE product_colors SET width_mm=908,package_width_mm=909 WHERE id='mystery_dims_black';
    UPDATE product_variants SET depth_mm=910,package_depth_mm=911 WHERE id='mystery_dims_exact';
  `);
  assert.deepEqual(selectSnapshot(), expected, 'catalogue edits cannot rewrite mystery shipping facts');
});
