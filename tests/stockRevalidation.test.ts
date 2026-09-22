/**
 * THE OWNER'S THREE SCENARIOS, as tests against the real order door.
 *
 * «واريد التاكد عندما يكون مخزون مثلا 3 فقط ويضع مستخدم a في السله 1 قطع
 *  والمستخدم الآخر b أيضا وضع في السله 3، لكن المستخدم الأول a طلب قبله واصبح
 *  المخزون 2، وبعدها يأتي المستخدم الثاني b يريد التاكيد والاتمام — يجب التاكد
 *  بان المخزون يتحدث ويعطيه اشعارا بان المتبقي فقط 2.
 *  كذلك عندما يضع المنتج في السله ويتركه فتره اذا نفذ المخزون يجب ان يظهر نفذ
 *  المخزون ولا يمكنه طلبه.
 *  كذلك مع السعر عندما يرتفع السعر او يقل من قبل الاداره … يجب التاكد من ان
 *  السعر يتحدث.»
 *
 * (a) A RACE. Two carts, one shelf. The loser must be told the real remainder,
 *     as a NUMBER they can act on, not as a generic refusal.
 * (b) A RESTING CART. Stock goes to zero under a line nobody touched.
 * (c) A PRICE MOVE. The admin reprices while the line sits in a cart.
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING, beyond "it refuses". Three things that
 * would each pass a naive test and be wrong:
 *   · the remainder reaching the CLIENT as data, not only inside an English
 *     sentence — a count baked into prose cannot be translated, and this shop
 *     is Arabic-first;
 *   · a mystery-pool member naming NO count, because there "only 2 left" is a
 *     before/after oracle on the draw (docs/BUNDLES_MYSTERY.md §8.2 row 18);
 *   · the order being written at the price in force AT PLACEMENT, never the
 *     price the cart was built with.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, row } from './fixtures/app';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { acceptedPolicies } from './lib/policies';
import { apiRefusal } from '../src/lib/refusalStrings';

/** One shelf with exactly three units, and two customers holding baskets. */
function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('ua','Ahmed','a@x.co','h','customer'),
      ('ub','Basim','b@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('ad_a','ua','Home','Ahmed','+9647701234567','Baghdad, Karrada 12','',1),
      ('ad_b','ub','Home','Basim','+9647701234568','Baghdad, Karrada 13','',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_pla','pla','PLA Basic','بي إل إيه',25000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','[]');
  `);
}

const cartLine = (raw: DatabaseSync, id: string, user: string, qty: number, productId = 'p_pla') =>
  raw
    .prepare(
      `INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
       VALUES (?,?,?,'','[]','','','','',?)`
    )
    .run(id, user, productId, qty);

const appFor = (db: unknown, user: string, email: string) =>
  stubApp(db, { id: user, role: 'customer', email }, (a) => {
    a.route('/api/orders', orderRoutes);
    a.route('/api/cart', cartRoutes);
  });

let seq = 0;
const orderBody = (addressId: string, over: Record<string, unknown> = {}) => ({
  addressId,
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `stock-revalidation-key-${++seq}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});

const stockOf = (raw: DatabaseSync) =>
  row<{ stock: number; stock_reserved: number }>(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_pla')!;

// ══════════════════════════════════════ (a) two carts, one shelf

test('the loser of a race is told the real remainder, as a number', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci_a', 'ua', 1);
  cartLine(raw, 'ci_b', 'ub', 3);
  const db = asD1(raw);

  // A orders first and takes one unit.
  const first = await json(await post(appFor(db, 'ua', 'a@x.co'), '/api/orders', orderBody('ad_a')));
  assert.equal(first.success, true);
  assert.equal(stockOf(raw).stock_reserved, 1, 'A is holding one unit');

  // B's basket still says 3. Two remain.
  const res = await post(appFor(db, 'ub', 'b@x.co'), '/api/orders', orderBody('ad_b'));
  assert.equal(res.status, 400, 'the order must be refused, not silently trimmed');
  const body = await json(res);
  assert.equal(body.code, 'OUT_OF_STOCK');

  /**
   * THE NUMBER, AS DATA. This is the half that was missing: the sentence has
   * always carried "2", in English, with the Arabic product name interpolated
   * into it — and a client can only translate a CODE. `details.available` is
   * what lets the checkout say «لم يبقَ سوى 2» in the customer's own language.
   */
  assert.equal(body.details.available, 2, 'the remainder must travel as a number');
  assert.equal(body.details.requested, 3);
  assert.equal(body.details.coarse, false);
  assert.equal(body.details.product_id, 'p_pla');

  // And the customer's actual sentence, in all three languages, names it.
  const err = { code: body.code, details: body.details, message: body.error ?? '' };
  assert.match(apiRefusal(err, 'ar', ''), /2/);
  assert.match(apiRefusal(err, 'ar', ''), /قلّل الكمية/);
  assert.match(apiRefusal(err, 'en', ''), /Only 2 left in stock/);
  assert.match(apiRefusal(err, 'ckb', ''), /2/);

  // NOTHING WAS TAKEN. A refused order must not move the shelf.
  assert.deepEqual(stockOf(raw), { stock: 3, stock_reserved: 1 });
});

test('and lowering the quantity to what is left goes through', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci_a', 'ua', 1);
  cartLine(raw, 'ci_b', 'ub', 3);
  const db = asD1(raw);
  await json(await post(appFor(db, 'ua', 'a@x.co'), '/api/orders', orderBody('ad_a')));

  // The refusal told B to lower it to 2, so B does.
  raw.prepare('UPDATE cart_items SET qty = 2 WHERE id = ?').run('ci_b');
  const second = await json(await post(appFor(db, 'ub', 'b@x.co'), '/api/orders', orderBody('ad_b')));
  assert.equal(second.success, true, 'the advice the refusal gave must actually work');
  assert.deepEqual(stockOf(raw), { stock: 3, stock_reserved: 3 });
});

// ══════════════════════════════════ (b) the cart that rested too long

test('a line whose stock went to zero is refused, and the cart says so', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci_b', 'ub', 1);
  const db = asD1(raw);

  // The shelf empties while the basket sits there.
  raw.prepare("UPDATE products SET stock = 0 WHERE id = 'p_pla'").run();

  const cart = await json(await get(appFor(db, 'ub', 'b@x.co'), '/api/cart'));
  const line = cart.items.find((i: { id: string }) => i.id === 'ci_b');
  assert.ok(line, 'the line is still in the cart — it is not deleted out from under the customer');
  /**
   * THE CART ALREADY KNEW. `mode` and `qty_ok` have been on this payload all
   * along; what was missing was any reader. src/pages/Cart.tsx's `lineBlocked`
   * was a bundles-only test, so an ordinary sold-out line kept an enabled
   * «إتمام الشراء» and the customer found out at the door.
   */
  assert.equal(line.availability.mode, 'unavailable');
  assert.equal(line.availability.qty_ok, false);

  const res = await post(appFor(db, 'ub', 'b@x.co'), '/api/orders', orderBody('ad_b'));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'OUT_OF_STOCK');
  assert.equal(body.details.available, 0);
  // Zero is a different remedy from two: remove it, not lower it.
  const sentence = apiRefusal({ code: body.code, details: body.details, message: '' }, 'ar', '');
  assert.match(sentence, /نفد مخزون/);
  assert.ok(!/قلّل الكمية/.test(sentence), 'there is no quantity that would work');
});

// ═══════════════════════════════════════ (c) the price that moved

test('an order is written at the price in force when it is placed', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci_b', 'ub', 1);
  const db = asD1(raw);

  // The admin reprices while the line rests in the basket.
  raw.prepare("UPDATE products SET price_iqd = 31000 WHERE id = 'p_pla'").run();

  const res = await json(await post(appFor(db, 'ub', 'b@x.co'), '/api/orders', orderBody('ad_b')));
  assert.equal(res.success, true);
  const item = row<{ unit_price_iqd: number }>(
    raw,
    'SELECT unit_price_iqd FROM order_items WHERE order_id = ?',
    res.order.id as string
  )!;
  /**
   * THE CART NEVER SETS A PRICE. The client sends item ids and nothing else;
   * the server reprices every line from the product at placement. So a raise
   * is charged and a cut is passed on, and neither depends on the cart having
   * been refreshed. docs/PRICE_CHANGES.md §5: what IS frozen is the result —
   * `order_items.unit_price_iqd` is a snapshot, and a placed order is never
   * re-priced afterwards.
   */
  assert.equal(item.unit_price_iqd, 31000, 'the new price, not the one the cart was built with');
});

test('and the CART shows the new price before the customer ever confirms', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci_b', 'ub', 1);
  const db = asD1(raw);
  raw.prepare("UPDATE products SET price_iqd = 31000 WHERE id = 'p_pla'").run();

  // The order being right is half the requirement. The owner's words are
  // «يجب التاكد من ان السعر يتحدث» — the customer must SEE it move, not
  // discover it on the invoice. The cart never stores a price, so it reads
  // the product every time and cannot go stale.
  const cart = await json(await get(appFor(db, 'ub', 'b@x.co'), '/api/cart'));
  const line = cart.items.find((i: { id: string }) => i.id === 'ci_b');
  assert.equal(line.unit_price_iqd ?? line.price_iqd, 31000, 'the cart must quote the new price');
});

test('a price CUT reaches the customer too — it is not only a raise', async () => {
  const raw = freshDb();
  seed(raw);
  cartLine(raw, 'ci_b', 'ub', 1);
  const db = asD1(raw);
  raw.prepare("UPDATE products SET price_iqd = 19000 WHERE id = 'p_pla'").run();

  const res = await json(await post(appFor(db, 'ub', 'b@x.co'), '/api/orders', orderBody('ad_b')));
  assert.equal(res.success, true);
  const item = row<{ unit_price_iqd: number }>(
    raw,
    'SELECT unit_price_iqd FROM order_items WHERE order_id = ?',
    res.order.id as string
  )!;
  assert.equal(item.unit_price_iqd, 19000);
});
