/**
 * THE MYSTERY WHEEL AND THE MYSTERY CARD ASK THE SAME QUESTION AS THE SALE
 * (0075, DECISION 4) — the fourth adversarial round, on the two doors that
 * were still answering about something else.
 *
 * DECISION 4 says the ORDER TYPE alone picks the counter a line spends:
 * `products.inventory_mode`'s row for a direct sale, the route's OWN quota or
 * the (model x pre-order) cell's shared pool for a pre-order. Never both,
 * never a sum, never the shelf for a pre-order. `tests/stockByOrderType.test.ts`
 * pins that for a bare line, `tests/stockByOrderTypeBundle.test.ts` for a
 * bundle component and `tests/capacitySurfaces2.test.ts` for the mystery
 * RESERVATION. Two things were still outside it, and both were reproduced
 * against the real routers and the real migrations.
 *
 *  M1  THE WHEEL PUT TWO SLOTS ON ONE CAPACITY ROW. `loadCandidates`
 *      de-duplicated pool entries on `product_id|values|colour`. That IS the
 *      counter for a DIRECT candidate — colour is half of what a
 *      `product_colors` row and a variant combo key identify. It is NOT the
 *      counter for a PRE-ORDER candidate: that is the (option_id, pre_order)
 *      cell or one of its routes, and COLOUR APPEARS IN NEITHER ROW. So one
 *      model offered in two colours became two wheel slots on ONE cell:
 *      `poolSupply` added their `available` together and published a supply of
 *      two against a capacity of one, and `drawSpools` gave each slot its own
 *      `remaining` so two spools could each claim the same last place. A cell
 *      of two advertised `{"state":"preorder","max_qty":4}` and took a qty-4
 *      add with a 200.
 *
 *  M2  A POOL WITH NO ROUTE CHOSEN WAS JUDGED AGAINST AIR. `resolveMysteryLines`
 *      passed `req.transportMethod || 'air'` to the candidate query, while
 *      `loadCandidates`' own documentation says an EMPTY method is the "no
 *      route chosen" case, answered from the cell's SHARED pool. The listing
 *      and the detail page send no method at all, so a member whose AIR quota
 *      was full dropped off the wheel and the whole offer read `sold_out` on
 *      the card — while sea, drawing on a pool with five places in it, sold
 *      the very same box with a 200.
 *
 * A GREEN ROUTE PROVES NOTHING HERE: M1's add returned 200 and M2's add
 * returned 200. So every assertion below names the counter — the row, the
 * column and the published number — rather than the status code.
 *
 * Run: npx tsx --test tests/capacityMystery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, get, post, json, all, row, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { bundlesRoutes } from '../worker/routes/bundles';
import { seedCatalogue, orderBody } from './lib/bundles';
import { addMysteryOffer } from './lib/mysteryOffer';
import { drawSpools, loadCandidates, loadPool, poolSupply, type MysteryCandidate } from '../worker/lib/mysteryDraw';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };

const shopApp = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/products', productRoutes);
    a.route('/api/bundles', bundlesRoutes);
  });

// ---------------------------------------------------------------- the shop

interface ColourShop {
  /** The (model x pre-order) SHARED pool. null = untracked. */
  cell?: number | null;
  /** Air's OWN quota. null = air draws on the shared pool. */
  air?: number | null;
  /** Sea's OWN quota. null = sea draws on the shared pool. */
  sea?: number | null;
  /** The member's DIRECT shelf, kept plentiful so it can never be the reason
   *  a pre-order assertion fails. */
  shelf?: number | null;
}

/**
 * ONE pre-order model, TWO colours, ONE capacity cell.
 *
 * That is the smallest shop in which M1 is a sentence: the two entries differ
 * by nothing a capacity row records, so anything that treats them as two
 * counters is publishing the same places twice. The shelf is nine and the cell
 * is small and they are deliberately far apart, because a fixture where the
 * two numbers matched could not say which one had been read.
 */
function seedColourPreorderMystery(o: ColourShop = {}): DatabaseSync {
  const { cell = 1, air = null, sea = null, shelf = 9 } = o;
  const n = (v: number | null) => (v === null ? 'NULL' : String(v));
  const raw = seedCatalogue();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('mp_pre','fil-pre','Filament Pre','فتيل مسبق','فتیلی پێشوەخت',30000,'active',${n(shelf)},'[]','[]',
            'pre_order','["pre_order"]',
            '[{"method":"air","active":true,"commission_iqd":3000},{"method":"sea","active":true,"commission_iqd":1500}]',
            '["https://cdn/pre.png"]','BASE','{"is_spool":true}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active)
      VALUES ('pog_pre','mp_pre','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type)
      VALUES ('pov_pre','mp_pre','pog_pre','Standard','عادي',0,1,NULL,'pre_order');
    -- Two COLOURS of one model. A colour is not a pre-order counter: no column
    -- of product_option_fulfillment or product_option_transports names one.
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,stock,reserved,sort,active) VALUES
      ('pcm_blue','mp_pre','Blue','أزرق','#00f',NULL,0,0,1),
      ('pcm_red','mp_pre','Red','أحمر','#f00',NULL,0,1,1);
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity,capacity_reserved)
      VALUES ('ofl_pre','mp_pre','pov_pre','pre_order',1,${n(cell)},0);
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,surcharge_iqd,capacity,capacity_reserved)
      VALUES ('otr_air','mp_pre','ofl_pre','air',1,3000,${n(air)},0),
             ('otr_sea','mp_pre','ofl_pre','sea',1,1500,${n(sea)},0);

    INSERT INTO mystery_pools (id,name,kind) VALUES ('mpl_pre','Pre-order pool','preorder');
    INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active) VALUES
      ('mpe_blue','mpl_pre','mp_pre','["pov_pre"]','pcm_blue','',1,1),
      ('mpe_red','mpl_pre','mp_pre','["pov_pre"]','pcm_red','',1,1);
  `);
  addMysteryOffer(raw, { spoolQty: 1, poolId: 'mpl_pre', maxQtyPerOrder: 5 });
  raw.exec(
    `UPDATE mystery_offers SET direct_pool_id = NULL, preorder_pool_id = 'mpl_pre',
            allow_direct = 0, allow_preorder = 1 WHERE product_id = 'p_mystery'`
  );
  return raw;
}

/** Every counter this file argues about, read straight out of the real tables. */
const counters = (raw: DatabaseSync) => ({
  shelf: all<{ id: string; stock: number | null; stock_reserved: number }>(
    raw,
    'SELECT id, stock, stock_reserved FROM products WHERE stock_reserved <> 0 ORDER BY id'
  ),
  cells: all<{ id: string; capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT id, capacity, capacity_reserved FROM product_option_fulfillment ORDER BY id'
  ),
  routes: all<{ id: string; capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT id, capacity, capacity_reserved FROM product_option_transports ORDER BY id'
  ),
  ledger: all<{ scope: string; scope_id: string; qty: number; kind: string }>(
    raw,
    'SELECT scope, scope_id, qty, kind FROM inventory_ledger ORDER BY rowid'
  ),
});

const addBox = (db: unknown, over: Record<string, unknown> = {}) =>
  post(shopApp(db), '/api/cart/items', { productId: 'p_mystery', qty: 1, mysteryMode: 'preorder', ...over });

const detail = async (db: unknown) => (await json(await get(shopApp(db), '/api/products/mystery-box'))).product;

// =====================================================================
//  M1 — COLOUR IS NOT PART OF A PRE-ORDER COUNTER
// =====================================================================

test('two colours of one model are TWO prizes drawn from ONE pre-order counter', async () => {
  const raw = seedColourPreorderMystery({ cell: 1 });
  const db = asD1(raw);
  const pool = (await loadPool(db, 'mpl_pre'))!;
  const set = await loadCandidates(db, pool, { preview: true });

  // BOTH stay on the wheel. Blue and red are two different things to win, and
  // a customer who wins one has not won the other — collapsing them deletes a
  // real prize, and with duplicate_policy 'forbid' it makes the offer
  // unsellable while its quota sits full.
  assert.deepEqual(
    set.candidates.map((c) => c.entry_id).sort(),
    ['mpe_blue', 'mpe_red'],
    'a colour is half of what the customer receives — it is not a duplicate'
  );
  assert.deepEqual(set.excluded, [], 'nothing here is a duplicate of anything');

  // ...and they name the SAME counter, because colour is a column of neither
  // product_option_fulfillment nor product_option_transports.
  assert.deepEqual(
    [...new Set(set.candidates.map((c) => c.counter_key))],
    ['preorder:ofl_pre'],
    'two colours of one model spend one capacity row'
  );

  // So the supply counts that row ONCE. This is the half that oversells if the
  // grouping is wrong: two slots, one place, and the card advertises two.
  assert.equal(poolSupply(set.candidates), 1, 'one capacity row was counted twice');

  const live = await loadCandidates(db, pool);
  assert.deepEqual(live.candidates.map((c) => c.entry_id).sort(), ['mpe_blue', 'mpe_red']);
});

test('the card publishes the capacity, and the door refuses the quantity the old card advertised', async () => {
  const raw = seedColourPreorderMystery({ cell: 2 });
  const db = asD1(raw);

  // THE DESCRIPTIVE PASS. Two colours on a cell of two published max_qty 4.
  const product = await detail(db);
  assert.equal(product.composition.availability_state, 'preorder');
  assert.equal(product.composition.max_qty, 2, 'the detail page advertised twice the capacity');

  // THE DOOR. The quantity the old card advertised is refused, and the
  // quantity the cell can really back is taken.
  const four = await addBox(db, { qty: 4, transportMethod: 'sea' });
  assert.notEqual(four.status, 200, 'a qty-4 add went through on a capacity of two');
  assert.deepEqual(counters(raw).cells, [{ id: 'ofl_pre', capacity: 2, capacity_reserved: 0 }]);

  const two = await addBox(db, { qty: 2, transportMethod: 'sea' });
  assert.equal(two.status, 200, JSON.stringify(await json(two)));

  // AND THE CART SAYS THE SAME NUMBER. This is the payload the defect was
  // reproduced on: {"state":"preorder","max_qty":4} against a capacity of two.
  const cart = await json(await get(shopApp(db), '/api/cart'));
  const line = (cart.items as Array<Record<string, unknown>>).find((i) => i.productId === 'p_mystery') as
    | { availability: { state: string; max_qty: number } }
    | undefined;
  assert.ok(line, 'the mystery line left the cart');
  assert.equal(line.availability.state, 'preorder');
  assert.equal(line.availability.max_qty, 2, 'the cart advertised twice the capacity');
});

test('one sale moves one counter: two spools fill the cell, the third is refused, the shelf never pays', async () => {
  const raw = seedColourPreorderMystery({ cell: 2 });
  const db = asD1(raw);

  assert.equal((await addBox(db, { qty: 2, transportMethod: 'sea' })).status, 200);
  const placed = await post(shopApp(db), '/api/orders', orderBody({ transportMethod: 'sea' }));
  assert.equal(placed.status, 200, JSON.stringify(await json(placed)));

  const c = counters(raw);
  assert.deepEqual(c.cells, [{ id: 'ofl_pre', capacity: 2, capacity_reserved: 2 }], 'the cell is not the counter that moved');
  assert.deepEqual(c.routes, [
    { id: 'otr_air', capacity: null, capacity_reserved: 0 },
    { id: 'otr_sea', capacity: null, capacity_reserved: 0 },
  ], 'a route with no quota of its own was charged as well — one sale, two counters');
  assert.deepEqual(c.shelf, [], 'a pre-order took a unit from under the direct buyer');
  assert.deepEqual(
    c.ledger.map((l) => `${l.kind}:${l.scope}:${l.scope_id}:${l.qty}`),
    ['reserve:preorder:ofl_pre:1', 'reserve:preorder:ofl_pre:1'],
    'the ledger names a row the release cannot aim at'
  );

  // The cell is full. Nothing else in the shop makes another box appear.
  const again = await addBox(db, { qty: 1, transportMethod: 'sea' });
  const status = again.status === 200 ? (await post(shopApp(db), '/api/orders', orderBody({ transportMethod: 'sea' }))).status : again.status;
  assert.notEqual(status, 200, 'a third spool sold against a capacity of two');
  assert.deepEqual(counters(raw).cells, [{ id: 'ofl_pre', capacity: 2, capacity_reserved: 2 }], 'the quota was oversold');
});

test('a held pre-order place is releasable — cancelling gives both back, exactly once', async () => {
  // A HELD UNIT MUST ALWAYS BE RELEASABLE. De-duplicating on the counter is
  // only safe while the release aims at that same row.
  const raw = seedColourPreorderMystery({ cell: 2 });
  const db = asD1(raw);
  assert.equal((await addBox(db, { qty: 2, transportMethod: 'sea' })).status, 200);
  const placed = await json(await post(shopApp(db), '/api/orders', orderBody({ transportMethod: 'sea' })));
  const orderId = String(placed.order.id);

  const cancelled = await json(await post(shopApp(db), `/api/orders/${orderId}/cancel`, { reason: 'changed my mind' }));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled).slice(0, 300));
  assert.deepEqual(
    counters(raw).cells,
    [{ id: 'ofl_pre', capacity: 2, capacity_reserved: 0 }],
    'the places were never given back — the quota is stranded'
  );
  await post(shopApp(db), `/api/orders/${orderId}/cancel`, { reason: 'changed my mind' });
  assert.equal(counters(raw).ledger.filter((l) => l.kind === 'release').length, 2, 'a repeated cancel released twice');
});

// ------------------------------------ the other side of the same key

/**
 * A DIRECT pool, whose counter IS colour-shaped, must keep both colours on the
 * wheel — otherwise "de-duplicate on the counter" would have deleted prizes
 * rather than fixed a double count.
 */
function seedDirectColourPool(mode: 'COLOR' | 'BASE', shelf = 3): DatabaseSync {
  const raw = seedCatalogue();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('mp_dir','fil-dir','Filament Direct','فتيل','فتیل',30000,'active',
            ${mode === 'BASE' ? shelf : 'NULL'},'[]','[]',
            'direct_sale','["direct_sale"]','[]','["https://cdn/dir.png"]','${mode}','{"is_spool":true}');
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,stock,reserved,sort,active) VALUES
      ('pcd_blue','mp_dir','Blue','أزرق','#00f',${mode === 'COLOR' ? 4 : 'NULL'},0,0,1),
      ('pcd_red','mp_dir','Red','أحمر','#f00',${mode === 'COLOR' ? 3 : 'NULL'},0,1,1);
    INSERT INTO mystery_pools (id,name,kind) VALUES ('mpl_dir','Direct pool','direct');
    INSERT INTO mystery_pool_entries (id,pool_id,product_id,option_value_ids,color_id,family_id,weight,active) VALUES
      ('mpe_d_blue','mpl_dir','mp_dir','[]','pcd_blue','',1,1),
      ('mpe_d_red','mpl_dir','mp_dir','[]','pcd_red','',1,1);
  `);
  return raw;
}

test('a DIRECT pool keeps both colours — the shelf row IS colour-shaped, so the key is', async () => {
  const raw = seedDirectColourPool('COLOR');
  const db = asD1(raw);
  const set = await loadCandidates(db, (await loadPool(db, 'mpl_dir'))!, { preview: true });

  assert.deepEqual(
    set.candidates.map((c) => `${c.entry_id}:${c.counter_key}:${c.available}`),
    ['mpe_d_blue:color:pcd_blue:4', 'mpe_d_red:color:pcd_red:3'],
    'the pre-order key was applied to a direct pool and deleted a prize'
  );
  assert.deepEqual(set.excluded, []);
  // Two rows, two piles: the sum is the honest supply here.
  assert.equal(poolSupply(set.candidates), 7);
});

test('two colours on ONE base shelf stay two prizes, but are ONE pile — on the wheel and in the supply', async () => {
  // The same shape on the other side of the rule: in BASE mode the colours are
  // not stock rows at all, so both entries spend `products.stock`. They remain
  // two distinct prizes, and the supply and the wheel must still count that
  // shelf ONCE — the two answers have to be the same answer.
  const raw = seedDirectColourPool('BASE', 3);
  const db = asD1(raw);
  const set = await loadCandidates(db, (await loadPool(db, 'mpl_dir'))!, { preview: true });

  assert.deepEqual(
    set.candidates.map((c) => `${c.entry_id}:${c.counter_key}`),
    ['mpe_d_blue:base:mp_dir', 'mpe_d_red:base:mp_dir'],
    'a direct pool lost a colour it can really ship'
  );
  assert.equal(poolSupply(set.candidates), 3, 'one shelf of three was published as six');

  // AND THE WHEEL SPENDS THAT ONE PILE. Four spools against a shelf of three
  // is a refusal, not four picks off a shelf that holds three.
  const seed = 'c0ffee'.repeat(10) + 'abcd';
  const three = drawSpools({ seed, cartItemId: 'ci_1', spools: 3, candidates: set.candidates, duplicatePolicy: 'allow' });
  assert.equal(three.ok, true, 'the shelf backs three spools');
  const four = drawSpools({ seed, cartItemId: 'ci_1', spools: 4, candidates: set.candidates, duplicatePolicy: 'allow' });
  assert.deepEqual(four, { ok: false, code: 'MYSTERY_NO_ELIGIBLE_STOCK' }, 'each slot held its own copy of one shelf');
});

test('the supply sums a counter once however many candidates name it', () => {
  // `poolSupply` is exported and the admin preview reads it, so it answers
  // this on its own rather than only because the loader de-duplicated first.
  const of = (entry: string, counter: string, available: number | null): MysteryCandidate =>
    ({
      entry_id: entry,
      product_id: 'mp_pre',
      option_value_ids: ['pov_pre'],
      color_id: '',
      family_id: '',
      weight: 1,
      available,
      targets: [],
      counter_key: counter,
      name_snapshot: entry,
      image_snapshot: '',
      variant_snapshot: '',
    }) satisfies MysteryCandidate;

  assert.equal(poolSupply([of('a', 'preorder:ofl_pre', 1), of('b', 'preorder:ofl_pre', 1)]), 1);
  assert.equal(poolSupply([of('a', 'preorder:ofl_pre', 2), of('b', 'preorder:ofl_other', 5)]), 7);
  // One untracked candidate still makes the whole pool unbounded.
  assert.equal(poolSupply([of('a', 'preorder:ofl_pre', 2), of('b', '', null)]), null);
  // A candidate with no counter is its own pile, exactly as the wheel treats it.
  assert.equal(poolSupply([of('a', '', 2), of('b', '', 3)]), 5);
});

// =====================================================================
//  M2 — NO ROUTE CHOSEN IS THE SHARED POOL, NEVER AIR'S OWN QUOTA
// =====================================================================

test('a full AIR quota does not sell out an offer every other route can still ship', async () => {
  // Air holds ZERO of its own — tracked and empty. Sea has no quota, so it
  // draws on the cell's five places. Nothing on the listing or the detail page
  // has chosen a route yet.
  const raw = seedColourPreorderMystery({ cell: 5, air: 0, sea: null });
  const db = asD1(raw);

  const listing = await json(await get(shopApp(db), '/api/bundles?kind=mystery'));
  const card = (listing.bundles as Array<Record<string, unknown>>).find((b) => b.product_slug === 'mystery-box') as
    | { availability_state: string }
    | undefined;
  assert.ok(card, 'the mystery card left the listing entirely');
  assert.equal(card.availability_state, 'preorder', 'a full air quota sold out the whole offer');

  const product = await detail(db);
  assert.equal(product.composition.availability_state, 'preorder', 'the detail page read air’s quota');
  assert.equal(product.composition.max_qty, 5, 'the before-you-pick figure is the cell’s shared pool');
  // The caption stays a PRE-ORDER caption: an empty method is "no route yet",
  // not "direct shipping".
  assert.notEqual(product.composition.shipping_type, 'direct');

  // And the sale the card was refusing really does go through, on sea.
  const sea = await addBox(db, { qty: 1, transportMethod: 'sea' });
  assert.equal(sea.status, 200, JSON.stringify(await json(sea)));
  const placed = await post(shopApp(db), '/api/orders', orderBody({ transportMethod: 'sea' }));
  assert.equal(placed.status, 200, JSON.stringify(await json(placed)));
  assert.deepEqual(
    counters(raw).cells,
    [{ id: 'ofl_pre', capacity: 5, capacity_reserved: 1 }],
    'sea drew on a counter that is not the shared pool'
  );
  assert.deepEqual(counters(raw).routes.find((r) => r.id === 'otr_air'), {
    id: 'otr_air',
    capacity: 0,
    capacity_reserved: 0,
  });
});

test('air’s own empty quota still refuses an add ON AIR — the pool is not opened for everyone', async () => {
  const raw = seedColourPreorderMystery({ cell: 5, air: 0, sea: null });
  const db = asD1(raw);

  const air = await addBox(db, { qty: 1, transportMethod: 'air' });
  const status = air.status === 200 ? (await post(shopApp(db), '/api/orders', orderBody({ transportMethod: 'air' }))).status : air.status;
  assert.notEqual(status, 200, 'a route with its own empty quota sold from the shared pool');
  assert.deepEqual(counters(raw).cells, [{ id: 'ofl_pre', capacity: 5, capacity_reserved: 0 }], 'air spent the shared pool');
  assert.equal(row<{ capacity_reserved: number }>(raw, 'SELECT capacity_reserved FROM product_option_transports WHERE id = ?', 'otr_air')!.capacity_reserved, 0);
});

test('a route WITH its own quota is still judged on that quota once the buyer picks it', async () => {
  // The fix must not have flattened the route question: sea holds one of its
  // own beside a shared pool of fifty, and a sea line spends sea's row.
  const raw = seedColourPreorderMystery({ cell: 50, air: null, sea: 1 });
  const db = asD1(raw);

  assert.equal((await addBox(db, { qty: 1, transportMethod: 'sea' })).status, 200);
  assert.equal((await post(shopApp(db), '/api/orders', orderBody({ transportMethod: 'sea' }))).status, 200);

  const c = counters(raw);
  assert.deepEqual(c.routes.find((r) => r.id === 'otr_sea'), { id: 'otr_sea', capacity: 1, capacity_reserved: 1 });
  assert.deepEqual(c.cells, [{ id: 'ofl_pre', capacity: 50, capacity_reserved: 0 }], 'one sale charged two counters');
  assert.deepEqual(c.ledger, [{ scope: 'preorder_transport', scope_id: 'otr_sea', qty: 1, kind: 'reserve' }]);

  // Sea is now full; the offer is still live because air draws on the fifty.
  const product = await detail(db);
  assert.equal(product.composition.availability_state, 'preorder');
  const seaAgain = await addBox(db, { qty: 1, transportMethod: 'sea' });
  const status = seaAgain.status === 200 ? (await post(shopApp(db), '/api/orders', orderBody({ transportMethod: 'sea' }))).status : seaAgain.status;
  assert.notEqual(status, 200, 'sea sold a second unit against a quota of one');
});
