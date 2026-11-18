/**
 * «لون عشوائي» ON A BUNDLE LINE (owner 2026-11-18; migration 0241, DECISIONS row 357).
 *
 * One bundle holds the same product several times — eSUN PLA+ ×2 black, ×2 white, ×1 random colour — and the
 * random line's colour is the STORE's: picked from stock (most free units, tie by sort then id) at every read,
 * shown to the customer as random, and frozen on the order line as the colour actually reserved, so the
 * packer sees a real colour and the ledger moves a real row.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asD1, stubApp, post, get, json, all, row, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { pickRandomColour } from '../worker/lib/bundleComposition';
import { addBundle, seedCatalogue, orderBody } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

test('pickRandomColour: most free units wins, ties by sort then id, inactive and refused colours never win', () => {
  const colours = [
    { id: 'b', sort: 1, active: 1 },
    { id: 'a', sort: 1, active: 1 },
    { id: 'z', sort: 0, active: 0 },
    { id: 'c', sort: 2, active: 1 },
  ];
  const avail: Record<string, { available: number | null; error?: string | null }> = {
    a: { available: 3 },
    b: { available: 3 },
    c: { available: 0, error: 'OUT_OF_STOCK' },
    z: { available: 99 },
  };
  assert.equal(pickRandomColour(colours, (id) => avail[id])?.color_id, 'a', 'tie on 3 → sort 1 → id a; z is inactive');
  avail.c = { available: 7 };
  assert.equal(pickRandomColour(colours, (id) => avail[id])?.color_id, 'c');
  avail.b = { available: null };
  assert.equal(pickRandomColour(colours, (id) => avail[id])?.color_id, 'b', 'untracked beats any count');
  assert.equal(pickRandomColour([], () => ({ available: 1 })), null);
});

function world() {
  const raw = seedCatalogue();
  // A third colour with the most stock: the store's random pick.
  raw.exec(
    "INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,stock,reserved,sort,active) VALUES ('pc_red','p_color','Red','أحمر','#f00',9,0,2,1)"
  );
  addBundle(raw, {
    id: 'prd_rb',
    slug: 'abs-five',
    components: [
      { id: 'bc_black', product: 'p_color', qty: 2, colorId: 'pc_black' },
      { id: 'bc_white', product: 'p_color', qty: 2, colorId: 'pc_white' },
      { id: 'bc_rand', product: 'p_color', qty: 1, randomColor: true },
    ],
  });
  return { raw, db: asD1(raw) };
}

test('one product three times: the cart shows the random line as random; the order reserves the fullest colour and names it', async () => {
  const { raw, db } = world();
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_rb', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));

  const cart = await json(await get(appFor(db), '/api/cart'));
  const text = JSON.stringify(cart);
  assert.ok(text.includes('"random_color":true'), 'the random line is flagged random in the cart');
  assert.ok(!/"variant":"Red"/.test(text), 'the cart does not announce the colour the read happened to take');

  const placed = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = String(placed.order?.id ?? placed.id ?? placed.order_id);
  const lines = all<Record<string, unknown>>(raw, 'SELECT product_id, color_id, qty, option_snapshot AS variant FROM order_items WHERE order_id = ? ORDER BY rowid', orderId);
  const colourLines = lines.filter((l) => l.product_id === 'p_color').map((l) => `${l.color_id}×${l.qty}`).sort();
  assert.deepEqual(colourLines, ['pc_black×2', 'pc_red×1', 'pc_white×2'], JSON.stringify(lines));
  assert.ok(lines.some((l) => l.color_id === 'pc_red' && String(l.variant).includes('Red')), 'the packer reads the real colour');

  const stock = (id: string) => row<{ stock: number; reserved: number }>(raw, 'SELECT stock, reserved FROM product_colors WHERE id = ?', id)!;
  const free = (id: string) => stock(id).stock - stock(id).reserved;
  assert.equal(free('pc_red'), 8, 'one red unit left the shelf');
  assert.equal(free('pc_black'), 2);
  assert.equal(free('pc_white'), 2);
});

test('the random line is never chosen by the customer: a submitted colour is refused', async () => {
  const { db } = world();
  const res = await json(
    await post(appFor(db), '/api/cart/items', { productId: 'prd_rb', qty: 1, bundleChoices: [{ componentId: 'bc_rand', colorId: 'pc_white' }] })
  );
  assert.equal(res.code, 'BUNDLE_CHOICE_NOT_ALLOWED', JSON.stringify(res));
});

test('when the fullest colour runs dry the store picks the next one, and with nothing left over the bundle is refused', async () => {
  const { raw, db } = world();
  raw.exec("UPDATE product_colors SET stock = 0 WHERE id = 'pc_red'");
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_rb', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = String(placed.order?.id ?? placed.id ?? placed.order_id);
  const rand = all<Record<string, unknown>>(raw, "SELECT color_id FROM order_items WHERE order_id = ? AND product_id = 'p_color' AND qty = 1", orderId);
  assert.deepEqual(rand.map((r) => r.color_id), ['pc_black'], 'black 4 and white 4 tie: sort 0 (black) wins');

  // Now black 1 / white 2 / red 0 free: 2 black + 2 white cannot be met at all.
  raw.exec("UPDATE product_colors SET stock = reserved + 1 WHERE id = 'pc_black'");
  const again = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_rb', qty: 1 }));
  assert.notEqual(again.success, true, JSON.stringify(again));
});

test('the random pick leaves the pinned lines their colour: black 2 / white 2 / red 1 → the random spool is red', async () => {
  const { raw, db } = world();
  raw.exec("UPDATE product_colors SET stock = 2 WHERE id IN ('pc_black','pc_white'); UPDATE product_colors SET stock = 1 WHERE id = 'pc_red'");
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_rb', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = String(placed.order?.id ?? placed.id ?? placed.order_id);
  const colours = all<Record<string, unknown>>(raw, "SELECT color_id, qty FROM order_items WHERE order_id = ? AND product_id = 'p_color'", orderId)
    .map((r) => `${r.color_id}×${r.qty}`)
    .sort();
  assert.deepEqual(colours, ['pc_black×2', 'pc_red×1', 'pc_white×2']);
});
