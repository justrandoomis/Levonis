/**
 * «ألوان الحجز المسبق تظهر نفد» — THE CART HALF OF THE OWNER'S COMPLAINT.
 *
 * The product page half shipped: `levelChip` stopped printing «نفد» under
 * «طلب مسبق», because «نفد» is a verdict about a SHELF and a pre-order is not
 * served off one (tests/preorderChoiceVisible.test.ts pins it). The cart kept
 * the untruth in a second place and in a second sentence:
 *
 *     const soldOut = item.availability?.mode === 'unavailable' || rem?.left === 0;
 *     … loc('نفد المخزون', 'Out of stock', 'کۆگا بەتاڵە')
 *
 * `lineRemaining` in that same file has ALWAYS said which counter its figure
 * came off — `preorder: true` when the IMPORT QUOTA answered — and the server
 * has always named a closed pre-order counter in `availability.reason`. Both
 * were discarded, so a full quota was read out as an empty shop: the customer
 * is told to give up on a product that is physically there and merely has to
 * be imported, when the true remedy is another route or a later month.
 *
 * WHAT THIS FILE PINS, and how each half is obtained:
 *
 *   · THE SHELF CASE IS UNCHANGED, end to end against the real cart route: a
 *     direct-sale line whose shelf empties while the basket rests still says
 *     «نفد المخزون», because there the sentence is simply true.
 *
 *   · THE QUOTA CASE, on a payload that is the REAL cart route's, with ONE
 *     block replaced — `availability.preorder.capacity`, rebuilt by calling
 *     the REAL `resolveCapacity` on a tracked cell. That substitution is
 *     deliberate and is itself asserted below: the storefront resolver
 *     currently calls `resolveCapacity(null, '')` for every route
 *     (worker/routes/products.ts, "pre-order is availability only"), so it
 *     publishes an UNTRACKED quota and no ordinary line can carry a tracked
 *     zero today. The page must still read the field correctly — the code is
 *     live on composition lines (worker/lib/bundleComposition.ts), both cart
 *     write doors still refuse with it (worker/routes/cart.ts) and the
 *     checkout still names it (src/lib/refusalStrings.ts) — and the day the
 *     counter is reconnected, this is the wording the cart owes.
 *
 * NOTHING HERE REIMPLEMENTS THE PAGE. `lineRemaining` and the two `const`s
 * that choose the sentence are LIFTED OUT OF src/pages/Cart.tsx and run, so
 * these assertions can only pass because the shipped code behaves.
 *
 * Run: node --import tsx --test tests/cartPreorderQuotaWording.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, stubApp, get, json, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { resolveCapacity } from '../worker/lib/inventory';
import { stockRefusal } from '../src/lib/refusalStrings';

const buyer: StubUser = { id: 'u1', role: 'customer', email: 's@x.co' };
const cartApp = (db: unknown) => stubApp(db, buyer, (a) => a.route('/api/cart', cartRoutes));

const CART_SRC = readFileSync(join(ROOT, 'src/pages/Cart.tsx'), 'utf8');

type Rem = { left: number; preorder: boolean } | null;

/** `lineRemaining`, lifted whole out of the page. */
function liftLineRemaining(): (item: unknown) => Rem {
  const m = /const lineRemaining = \(item: CartItem\)[^=]*=> \{\n([\s\S]*?)\n {2}\};/.exec(CART_SRC);
  assert.ok(m, 'lineRemaining is still a single arrow helper in src/pages/Cart.tsx');
  return new Function('item', m[1]) as (item: unknown) => Rem;
}

/** The two `const`s the blocked line decides its sentence with, lifted whole. */
function liftVerdict(): (item: unknown, rem: Rem) => { quotaFull: boolean; soldOut: boolean } {
  const m = /const quotaFull =([\s\S]*?);\n\s*const soldOut =([\s\S]*?);\n\s*return \(/.exec(CART_SRC);
  assert.ok(m, 'the blocked line still decides between the two sentences in two consts');
  return new Function(
    'item',
    'rem',
    `const quotaFull =${m[1]}; const soldOut =${m[2]}; return { quotaFull, soldOut };`
  ) as (item: unknown, rem: Rem) => { quotaFull: boolean; soldOut: boolean };
}

/** A direct-sale product with three on the shelf, and a line resting in a cart. */
function seedShelf(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images)
    VALUES ('p_pla','pla','PLA Basic','بي إل إيه',25000,'active',3,'[]','[]',
            'direct_sale','["direct_sale"]','[]','[]');
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                            shipping_method_id,transport_method,warranty_plan_id,qty)
    VALUES ('ci_shelf','u1','p_pla','','[]','','','','',1);
  `);
  return raw;
}

/** A PRE-ORDER-ONLY model with a priced LAND route, and a line resting in a cart. */
function seedPreorder(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','Bambu Lab A1','بامبو A1','بامبو A1',725000,'active',NULL,'[]','[]',
            'pre_order','["pre_order"]','[]','["https://cdn/a1.png"]','PRODUCT','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g','p_a1','Model',0,1);
    INSERT INTO product_option_values
      (id,product_id,group_id,name_en,name_ar,sort,active,stock,availability_type,variant_key,variant_label)
    VALUES ('v_a1','p_a1','g','A1','A1',0,1,0,'','a1','A1');
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity)
    VALUES ('f_a1_p','p_a1','v_a1','pre_order',1,0);
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,surcharge_iqd)
    VALUES ('t_a1_land','p_a1','f_a1_p','land',1,25000);
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,
                            shipping_method_id,transport_method,warranty_plan_id,qty)
    VALUES ('ci_pre','u1','p_a1','v_a1','["v_a1"]','','','land','',1);
  `);
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)").run(
    JSON.stringify({ ordinary_iqd: 5000 })
  );
  return raw;
}

const lineOf = async (raw: DatabaseSync, id: string) => {
  const cart = await json(await get(cartApp(asD1(raw)), '/api/cart'));
  const line = (cart.items as Array<{ id: string }>).find((i) => i.id === id);
  assert.ok(line, `the line is still in the cart — ${id}`);
  return line as { id: string; availability: Record<string, unknown> };
};

// ═════════════════════════════════ the shelf, which was never the bug

test('a direct-sale line whose shelf emptied still reads «نفد المخزون»', async () => {
  const raw = seedShelf();
  // The shelf empties while the basket sits there.
  raw.prepare("UPDATE products SET stock = 0 WHERE id = 'p_pla'").run();

  const line = await lineOf(raw, 'ci_shelf');
  assert.equal(line.availability.mode, 'unavailable', 'the real route says the line is refused');
  assert.equal(line.availability.reason, 'OUT_OF_STOCK', 'and names the SHELF as what closed');

  const rem = liftLineRemaining()(line);
  assert.deepEqual(rem, { left: 0, preorder: false }, 'a shelf count, and it says so');

  const v = liftVerdict()(line, rem);
  assert.deepEqual(
    v,
    { quotaFull: false, soldOut: true },
    'nothing about the pre-order half may weaken the sentence that is simply true'
  );
});

// ═════════════════════════ the import quota, which is not a shelf

/**
 * The counter as the RESOLVER publishes one. `resolveCapacity` holds the whole
 * shared-versus-independent rule, so the block below is its answer and not a
 * shape invented here; the three fields are read off it exactly as
 * `saleAvailability` reads them (worker/routes/products.ts).
 */
function trackedQuotaBlock() {
  const res = resolveCapacity(
    { cell: { id: 'f_a1_p', capacity: 0, reserved: 0, label: 'A1' }, transports: [], conflict: null },
    ''
  );
  assert.equal(res.tracked, true, 'a cell with a capacity column IS a tracked counter');
  assert.equal(res.available, 0, 'and zero is full, never untracked');
  const target = res.targets[0] ?? null;
  return {
    tracked: res.tracked,
    scope: target?.scope ?? null,
    scope_id: target?.scope_id ?? '',
    available: res.available,
    max_qty: 0,
  };
}

test('the storefront currently publishes an UNTRACKED quota — which is why the block below is substituted', () => {
  // worker/routes/products.ts: `const capacityFor = (_method: string) => resolveCapacity(null, '');`
  const neutered = resolveCapacity(null, '');
  assert.deepEqual(
    { tracked: neutered.tracked, available: neutered.available },
    { tracked: false, available: null },
    'no ordinary cart line can carry a tracked quota until that call is reconnected'
  );
});

test('a pre-order line whose IMPORT QUOTA is full must not read «نفد المخزون»', async () => {
  const line = await lineOf(seedPreorder(), 'ci_pre');
  assert.equal(line.availability.mode, 'preorder', 'the real route types the line as a pre-order');

  const a = line.availability as { preorder: Record<string, unknown>; qty_ok: boolean };
  // The one substitution, and the reason for it is asserted by the test above.
  a.preorder.capacity = trackedQuotaBlock();
  // A line the door would refuse: the quota cannot cover the single unit asked
  // for, which is exactly what `qty_ok: false` says.
  a.qty_ok = false;

  const rem = liftLineRemaining()(line);
  assert.deepEqual(rem, { left: 0, preorder: true }, 'the page already knows which counter answered');

  const v = liftVerdict()(line, rem);
  assert.equal(v.quotaFull, true, 'the zero is the import quota');
  assert.equal(v.soldOut, false, '«نفد المخزون» is a SHELF verdict and this line has no shelf');
});

test('and a pre-order route the server itself calls exhausted is read the same way', async () => {
  const line = await lineOf(seedPreorder(), 'ci_pre');
  // The other shape the same fact arrives in: every priced route is full, so
  // the resolver closes the line and names the counter (worker/routes/products.ts).
  const a = line.availability as { mode: string; reason: string | null; qty_ok: boolean };
  a.mode = 'unavailable';
  a.reason = 'PREORDER_CAPACITY_EXHAUSTED';
  a.qty_ok = false;

  const rem = liftLineRemaining()(line);
  const v = liftVerdict()(line, rem);
  assert.equal(v.quotaFull, true, 'the server named the counter and the page must read it');
  assert.equal(v.soldOut, false, 'an `unavailable` mode is not by itself an empty shelf');
});

// ══════════════════════════════ the sentence itself: reused, never invented

test('the quota sentence is the one refusalStrings already publishes, and invents no Sorani', () => {
  const said = stockRefusal({ code: 'PREORDER_CAPACITY_EXHAUSTED', details: { available: 0 } }, 'ar');
  assert.ok(said && said.length > 0, 'refusalStrings has an Arabic sentence for an exhausted quota');
  assert.ok(
    CART_SRC.includes(said),
    'the cart prints the checkout door’s own Arabic, so one counter is described one way'
  );
  assert.ok(!/نفد/.test(said), 'and that sentence denies the sold-out reading rather than repeating it');

  // The `loc` call for it takes TWO arguments: Kurdish falls back to the
  // Arabic, which is this app's documented behaviour and what every other 0075
  // sentence in this file does. A third argument here would be a machine
  // translation of a refusal.
  const call = new RegExp(`loc\\(\\s*'${said.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}',\\s*'[^']+'\\s*\\)`);
  assert.match(CART_SRC, call, 'the quota sentence must not carry an invented ckb string');

  // The shelf sentence keeps the hand-written Kurdish it already had.
  assert.match(CART_SRC, /loc\('نفد المخزون', 'Out of stock', 'کۆگا بەتاڵە'\)/);
});
