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
 *   · THE THREE REFUSALS THAT ACTUALLY REACH A CART LINE TODAY. The quota is
 *     only ONE of the four codes a pre-order can be refused with, and the test
 *     above says why it is the one an ordinary line cannot carry: the
 *     storefront publishes an untracked capacity, so a pre-order-only line
 *     that goes dark goes dark as NO_TRANSPORT_OFFERED,
 *     TRANSPORT_COMMISSION_UNCONFIGURED or PREORDER_NOT_ENABLED — and «نفد
 *     المخزون» was printed over all three. Pinning the quota alone left the
 *     owner's own symptom live on the path it travels.
 *
 *   · THE SENTENCE IS DECODED, NOT COPIED. It was hand-copied into the page as
 *     an Arabic literal, and the copy had already lost the remedy clause the
 *     table's entry carries.
 *
 * NOTHING HERE REIMPLEMENTS THE PAGE. `lineRemaining`, the `const`s that
 * choose the sentence and the page's own set of pre-order refusal codes are
 * all LIFTED OUT OF src/pages/Cart.tsx and run, so these assertions can only
 * pass because the shipped code behaves.
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
import { apiRefusal } from '../src/lib/refusalStrings';

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

/** The page's own set of "this refusal is not about a shelf" codes, lifted. */
function liftPreorderRefusals(): Set<string> {
  const m = /const PREORDER_REFUSALS = new Set\(\[([\s\S]*?)\]\);/.exec(CART_SRC);
  assert.ok(m, 'the page still names the pre-order refusals in one Set');
  return new Function(`return new Set([${m[1]}]);`)() as Set<string>;
}

/**
 * The `const`s the blocked line decides its sentence with, lifted whole.
 *
 * THREE NOW, NOT TWO. The quota is one of four refusals a pre-order can carry
 * and the other three were still printing «نفد المخزون» — so the whole block
 * from `const reason` to `const soldOut` is lifted, comments and all, rather
 * than two named captures that would silently stop covering the branch the
 * day a fourth line is added between them.
 */
function liftVerdict(): (item: unknown, rem: Rem) => { quotaFull: boolean; soldOut: boolean; notAShelf: boolean } {
  const m = /(const reason = [\s\S]*?const soldOut =[\s\S]*?;)\n\s*return \(/.exec(CART_SRC);
  assert.ok(m, 'the blocked line still decides its sentence in consts above the return');
  const fn = new Function(
    'item',
    'rem',
    'PREORDER_REFUSALS',
    `${m[1]} return { quotaFull, soldOut, notAShelf };`
  ) as (item: unknown, rem: Rem, set: Set<string>) => { quotaFull: boolean; soldOut: boolean; notAShelf: boolean };
  const set = liftPreorderRefusals();
  return (item, rem) => fn(item, rem, set);
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
    { quotaFull: false, soldOut: true, notAShelf: false },
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

test('the quota sentence is DECODED from refusalStrings, not copied into the page', () => {
  /**
   * IT WAS A COPY, AND THE COPY HAD ALREADY LOST HALF THE SENTENCE. The page
   * hard-coded `'اكتملت حصة الطلب المسبق لهذا الاختيار — وهذا ليس نفادًا
   * للمخزون.'`, which is `stockRefusal(…, available: 0)`'s SHORT form and not
   * the table's own entry — so the cart dropped «جرّب طريقة شحن أخرى أو عُد
   * لاحقًا», the clause refusalStrings' contract requires of this code ("the
   * sentence has to point at the thing the customer can still do"). The cart
   * pointed at nothing while the checkout pointed at another route.
   */
  const table = apiRefusal({ code: 'PREORDER_CAPACITY_EXHAUSTED' }, 'ar');
  assert.match(table, /جرّب طريقة شحن أخرى أو عُد لاحقًا/, 'the table entry carries the remedy');
  assert.ok(!/نفد المخزون/.test(table), 'and denies the sold-out reading rather than repeating it');

  // The page asks the table; it does not keep a copy that can drift from it.
  assert.match(
    CART_SRC,
    /apiRefusal\(\{ code: 'PREORDER_CAPACITY_EXHAUSTED' \}, lang as 'ar' \| 'en' \| 'ckb'\)/,
    'the blocked line decodes the code instead of printing a literal'
  );
  assert.ok(
    !CART_SRC.includes('اكتملت حصة الطلب المسبق لهذا الاختيار'),
    'no copy of the sentence is left in the page to drift'
  );

  // The shelf sentence keeps the hand-written Kurdish it already had.
  assert.match(CART_SRC, /loc\('نفد المخزون', 'Out of stock', 'کۆگا بەتاڵە'\)/);
});

test('NO SORANI IS INVENTED for any of the four pre-order refusals', () => {
  /**
   * Three of the four are sentences src/pages/Product.tsx has carried by hand
   * in all three languages since 0073; the table now holds that same wording
   * so the two screens cannot drift. The fourth — the quota — has no Kurdish
   * anybody has written, so its `ckb` IS the Arabic, which is this app's
   * documented fallback and the choice the entry states in its own comment.
   * What must never appear is a machine translation.
   */
  const productSrc = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  for (const code of ['PREORDER_NOT_ENABLED', 'NO_TRANSPORT_OFFERED', 'TRANSPORT_COMMISSION_UNCONFIGURED']) {
    const ckb = apiRefusal({ code }, 'ckb');
    assert.ok(ckb.length > 0, `${code} answers in Kurdish`);
    assert.ok(productSrc.includes(ckb), `${code}'s Sorani is the one already hand-written in Product.tsx`);
    const ar = apiRefusal({ code }, 'ar');
    assert.ok(productSrc.includes(ar), `${code}'s Arabic is the one already hand-written in Product.tsx`);
  }
  assert.equal(
    apiRefusal({ code: 'PREORDER_CAPACITY_EXHAUSTED' }, 'ckb'),
    apiRefusal({ code: 'PREORDER_CAPACITY_EXHAUSTED' }, 'ar'),
    'the quota sentence falls back to the Arabic rather than inventing Kurdish'
  );
});

test('a pre-order line with NO USABLE ROUTE is not told its shelf is empty', async () => {
  /**
   * THE CASE THAT ACTUALLY HAPPENS ON THIS CATALOGUE. The quota code cannot
   * reach an ordinary cart line today — the test above pins WHY: the
   * storefront resolves every route to an untracked capacity, so `hasRoom` is
   * always true and `preorderUsable` fails only for want of a ROUTE. A
   * pre-order-only line whose admin unprices its route, disables its cell or
   * switches pre-order off closes with NO_TRANSPORT_OFFERED,
   * TRANSPORT_COMMISSION_UNCONFIGURED or PREORDER_NOT_ENABLED — and the page
   * printed «نفد المخزون» over all three: the same untruth about a line that
   * has no shelf, reached by the three doors the customer can actually reach.
   */
  for (const code of ['NO_TRANSPORT_OFFERED', 'TRANSPORT_COMMISSION_UNCONFIGURED', 'PREORDER_NOT_ENABLED']) {
    const line = await lineOf(seedPreorder(), 'ci_pre');
    const a = line.availability as { mode: string; reason: string | null; qty_ok: boolean };
    a.mode = 'unavailable';
    a.reason = code;
    a.qty_ok = false;

    const rem = liftLineRemaining()(line);
    const v = liftVerdict()(line, rem);
    assert.equal(v.notAShelf, true, `${code} is a refusal about the pre-order route`);
    assert.equal(v.soldOut, false, `${code} must not print «نفد المخزون»`);
    // And the sentence it does print says something true and actionable.
    assert.ok(apiRefusal({ code }, 'ar').length > 0, `${code} has an Arabic sentence to print`);
  }
});

test('an OUT_OF_STOCK direct-sale line is untouched by all of that', async () => {
  // The guard on the guard: widening the "not a shelf" set must never swallow
  // the sentence that is simply true.
  const raw = seedShelf();
  raw.prepare("UPDATE products SET stock = 0 WHERE id = 'p_pla'").run();
  const line = await lineOf(raw, 'ci_shelf');
  const rem = liftLineRemaining()(line);
  const v = liftVerdict()(line, rem);
  assert.equal(v.notAShelf, false);
  assert.equal(v.soldOut, true);
});
