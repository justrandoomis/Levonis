/**
 * THE BUY PATH — cases 1, 2, 4, 5, 6, 8, 9, 11 and 17 of the owner's
 * seventeen, docs/BUNDLES_MYSTERY.md §3 (reservation), §5.3, §6.1 and §6.3,
 * run through the REAL routers, the REAL batch and real migrations.
 *
 * THE FIVE THINGS THAT WOULD SILENTLY COST MONEY IF THEY WERE WRONG, and are
 * therefore asserted directly rather than inferred from a green route:
 *
 * 1. `Σ order_items.line_total_iqd === orders.subtotal_iqd` with a bundle in
 *    the order, and `Σ component_alloc_iqd === the parent's line_total_iqd`
 *    EXACTLY. The components are zero-priced and the money is on the parent, so
 *    any other arrangement makes `financialSnapshot`'s legacy recomputation and
 *    the invoice totals disagree with the order they describe.
 *
 * 2. `eligibleMerchandiseIqd(items) === orders.merchandise_iqd`. That function
 *    prefers `pricing_snapshot.applied_iqd`, so a component whose snapshot did
 *    not carry 0 would accrue points a second time on the same box, and a
 *    parent whose snapshot carried the stale cached `products.price_iqd` would
 *    reverse the wrong number on a refund. Asserted in a derived price mode as
 *    well as `fixed`, because the derived mode is where the two numbers diverge.
 *
 * 3. EVERY COMPONENT RESERVES, IN THE ORDER'S OWN BATCH, AND THE FENCE PROVES
 *    IT. A concurrent writer taking the second component's stock between the
 *    plan and the commit rolls back the WHOLE order — no order row, no items,
 *    no ledger rows, no redemption, and the wallet untouched.
 *
 * 4. ONE QUOTE LINE PER CART LINE. `POST /api/orders/quote` never touches
 *    `order_items`, so the component filter there is a different filter from
 *    the order one — and the checkout screen maps `quote.lines` 1:1 with
 *    `key={l.cart_item_id}`, which a four-component bundle would break on the
 *    last screen before payment.
 *
 * 5. ONE `offer_redemptions` ROW PER (SUBJECT, ORDER), with the quantity
 *    summed across two lines of the same bundle. A second row would hit
 *    `UNIQUE (subject_type, subject_id, order_id)` and abort a cart that could
 *    never succeed, with a message the catch block does not map.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, failingD1, stubApp, post, json, all, count, row, spendable, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { eligibleMerchandiseIqd } from '../worker/lib/pointsOps';
import { addBundle, seedCatalogue, orderBody, DEFAULT_COMPONENTS, PAST } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown, user: StubUser = buyer) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

const items = (raw: DatabaseSync, orderId: string) =>
  all<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid', orderId);
const orderRow = (raw: DatabaseSync, orderId: string) =>
  row<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', orderId)!;

async function addBundleToCart(db: unknown, body: Record<string, unknown>, user: StubUser = buyer) {
  const res = await json(await post(appFor(db, user), '/api/cart/items', body));
  assert.equal(res.success, true, `add-to-cart failed: ${JSON.stringify(res)}`);
  return res;
}

// ------------------------------------------------------ the money invariants

test('the parent carries the money, the components carry zero, and every sum ties out', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000 });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 2 });

  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  const orderId = res.order.id as string;
  const rows = items(raw, orderId);
  const order = orderRow(raw, orderId);

  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
  const kids = rows.filter((r) => r.bundle_parent_item_id !== null);
  assert.equal(rows.length, 4, 'one parent and three components are FOUR real order_items rows');
  assert.equal(kids.length, 3);

  assert.equal(Number(parent.unit_price_iqd), 400_000);
  assert.equal(Number(parent.line_total_iqd), 800_000);
  for (const k of kids) {
    assert.equal(Number(k.unit_price_iqd), 0, 'a component is zero-priced: the money is on the parent');
    assert.equal(Number(k.line_total_iqd), 0);
    assert.equal(String(k.bundle_parent_item_id), String(parent.id));
    assert.ok(k.bundle_component_id, 'the component keeps its provenance');
  }

  // Σ line_total === subtotal, and Σ alloc === the parent's line total EXACTLY.
  assert.equal(
    rows.reduce((n, r) => n + Number(r.line_total_iqd), 0),
    Number(order.subtotal_iqd)
  );
  assert.equal(
    kids.reduce((n, k) => n + Number(k.component_alloc_iqd), 0),
    Number(parent.line_total_iqd),
    'largest-remainder allocation leaves nothing over'
  );
  // The component quantities are per BUNDLE times the line quantity.
  assert.deepEqual(
    kids.map((k) => [String(k.product_id), Number(k.qty)]).sort(),
    [['p_nozzle', 2], ['p_pla', 4], ['p_printer', 2]]
  );
});

test('points accrue on the parent only, and on the number ACTUALLY charged — in a derived price mode too', async () => {
  for (const mode of ['fixed', 'derived'] as const) {
    const raw = seedCatalogue();
    addBundle(raw, {
      id: 'prd_b1',
      slug: 'starter',
      // The cached `products.price_iqd` is deliberately WRONG in the derived
      // case: §4.3 lets it drift and makes the live component total the
      // charged price, so this is exactly where a snapshot that copied the
      // resolver's `applied_iqd` would freeze the wrong number.
      priceIqd: mode === 'fixed' ? 400_000 : 999_999,
      config: mode === 'fixed' ? {} : { price_mode: 'discount_percent', discount_percent: 20 },
    });
    const db = asD1(raw);
    await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
    const res = await json(await post(appFor(db), '/api/orders', orderBody()));
    assert.equal(res.success, true, JSON.stringify(res));
    const rows = items(raw, res.order.id);
    const order = orderRow(raw, res.order.id);

    const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
    const snapshot = JSON.parse(String(parent.pricing_snapshot)) as Record<string, number>;
    const expected = mode === 'fixed' ? 400_000 : Math.floor((400000 + 50000 + 5000) * 0.8);
    assert.equal(snapshot.applied_iqd, expected, `${mode}: the parent's snapshot is pinned to the charged price`);
    assert.equal(snapshot.regular_iqd, expected);
    for (const k of rows.filter((r) => r.bundle_parent_item_id !== null)) {
      assert.equal((JSON.parse(String(k.pricing_snapshot)) as Record<string, number>).applied_iqd, 0);
    }

    // THE INVARIANT, stated as the money model states it.
    assert.equal(
      eligibleMerchandiseIqd(
        rows.map((r) => ({
          qty: Number(r.qty),
          unit_price_iqd: Number(r.unit_price_iqd),
          pricing_snapshot: r.pricing_snapshot as string | null,
          warranty_snapshot: r.warranty_snapshot as string | null,
          transport_snapshot: r.transport_snapshot as string | null,
        }))
      ),
      Number(order.merchandise_iqd),
      `${mode}: eligibleMerchandiseIqd must equal orders.merchandise_iqd`
    );
    assert.equal(Number(order.merchandise_iqd), expected);
    // No cost ever crosses this boundary.
    assert.ok(!String(parent.pricing_snapshot).includes('cost_iqd'));
  }
});

test('case 6 — a body carrying prices, savings and a tier changes nothing about what is stored', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000 });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  const res = await json(
    await post(
      appFor(db),
      '/api/orders',
      orderBody({
        bundle_price_iqd: 1,
        component_total_iqd: 1,
        saving_percent: 99,
        discount_iqd: 399_999,
        applied_tier: 'pro',
        merchandise_iqd: 1,
      })
    )
  );
  assert.equal(res.success, true);
  const order = orderRow(raw, res.order.id);
  assert.equal(Number(order.merchandise_iqd), 400_000);
  assert.equal(Number(order.subtotal_iqd), 400_000);
  const parent = items(raw, res.order.id).find((r) => r.bundle_parent_item_id === null)!;
  const composition = (JSON.parse(String(parent.pricing_snapshot)) as { composition: Record<string, number | string> }).composition;
  assert.equal(composition.bundle_price_iqd, 400_000);
  assert.equal(composition.applied_tier, 'regular');
});

// ------------------------------------------------------ availability, case 1

test('case 1 at the door — the scarcest component decides: qty 3 is sold, qty 4 is refused', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', config: { max_qty_per_order: 9 } });
  const db = asD1(raw);
  // The cart refuses 4 outright (the owner's example bounds it at 3)…
  const refused = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 4 }));
  assert.equal(refused.code, 'QTY_UNAVAILABLE');

  await addBundleToCart(db, { productId: 'prd_b1', qty: 3 });
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  // …and the stock actually moved: 3 printers, 6 PLA, 3 nozzles held.
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_printer'), {
    stock: 5,
    stock_reserved: 3,
  });
  assert.deepEqual(row(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', 'p_pla'), {
    stock: 6,
    stock_reserved: 6,
  });
});

test('case 1 aggregated — a bundle and a bare product of the same row are summed, and refused at PLAN time', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [{ id: 'bc_abs', product: 'p_color', qty: 2, colorId: 'pc_black' }],
  });
  const db = asD1(raw);
  const app = appFor(db);
  // The Black row holds 4. The bundle needs 2, and the bare product needs 3.
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  await post(app, '/api/cart/items', { productId: 'p_color', qty: 3, colorId: 'pc_black' });

  const res = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(res.code, 'OUT_OF_STOCK', 'the demand is summed per stock row across lines, not judged per line');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'a refused checkout writes nothing');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
});

// ------------------------------------------------------- atomicity, case 2

test('case 2 — a component taken between the plan and the commit rolls the WHOLE order back', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter' });
  const { failing, db } = failingD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  const before = spendable(raw, 'buyer');

  // A concurrent writer empties the SECOND component's row after the plan read
  // it and before the batch commits: every guarded statement for that row then
  // matches zero rows WITHOUT failing the batch, and the fence's
  // CHECK (actual = expected) is what turns that into a rollback.
  failing.beforeBatch = (stmts) => {
    if (!stmts.some((s) => s.sql.includes('INSERT INTO orders'))) return;
    failing.beforeBatch = null;
    raw.exec("UPDATE products SET stock_reserved = stock WHERE id = 'p_pla'");
  };

  const res = await json(await post(appFor(db), '/api/orders', orderBody({ useWallet: true })));
  assert.equal(res.code, 'CONFLICT_RETRY', JSON.stringify(res));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_reservation_fence'), 0);
  assert.equal(spendable(raw, 'buyer'), before, 'the wallet is untouched');
  // Nothing was consumed: the printer's hold was rolled back with the rest.
  assert.deepEqual(row(raw, 'SELECT stock_reserved FROM products WHERE id = ?', 'p_printer'), { stock_reserved: 0 });
});

test('every component reserves in the order’s own batch, and the fence counts them', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter' });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  const orderId = res.order.id as string;

  const ledger = all<Record<string, unknown>>(
    raw,
    "SELECT product_id, qty, idempotency_key FROM inventory_ledger WHERE order_id = ? AND kind = 'reserve' ORDER BY product_id",
    orderId
  );
  assert.equal(ledger.length, 3, 'one guarded move per component, never one for the bundle row');
  assert.deepEqual(
    row(raw, 'SELECT expected, actual FROM order_reservation_fence WHERE order_id = ? AND kind = ?', orderId, 'reserve'),
    { expected: 3, actual: 3 }
  );
  // The reservation reference the mandate asks for: the component's own
  // `order_items.id`, provably the same value inside the ledger key.
  const kids = items(raw, orderId).filter((r) => r.bundle_parent_item_id !== null);
  for (const k of kids) {
    assert.ok(
      ledger.some((l) => String(l.idempotency_key).split(':')[2] === String(k.id)),
      'every component order_item id appears as a ledger line id'
    );
  }
  const parent = items(raw, orderId).find((r) => r.bundle_parent_item_id === null)!;
  const composition = (JSON.parse(String(parent.pricing_snapshot)) as {
    composition: { items: Array<{ reservation_line_id: string; order_item_id: string }> };
  }).composition;
  for (const it of composition.items) assert.equal(it.reservation_line_id, it.order_item_id);
});

// ------------------------------------------------------ idempotency, case 17

test('case 17 — a double tap, a retry and a replay all produce exactly one order and one set of ledger rows', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', limits: { max_per_user: 5 } });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  const body = orderBody();

  const [a, b] = await Promise.all([
    json(await post(appFor(db), '/api/orders', body)),
    json(await post(appFor(db), '/api/orders', body)),
  ]);
  const ok = [a, b].filter((r) => r.success);
  assert.equal(ok.length, 2, 'the loser is served the stored order, not a second charge');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items'), 4);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind='reserve'"), 3);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 1);

  // A third POST with the same key is the replay branch: nothing recomputed.
  const again = await json(await post(appFor(db), '/api/orders', body));
  assert.equal(again.replay, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM order_items'), 4);
});

test('two lines of ONE bundle write exactly one offer_redemptions row with the summed quantity', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    limits: { max_per_user: 9 },
    components: [{ id: 'bc_abs', product: 'p_color', qty: 1, picksColor: true }],
  });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1, bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_black' }] });
  await addBundleToCart(db, { productId: 'prd_b1', qty: 2, bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_white' }] });

  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  const redemptions = all<Record<string, unknown>>(raw, 'SELECT * FROM offer_redemptions');
  assert.equal(redemptions.length, 1, 'one row per (subject, order) — a second would abort the batch on its UNIQUE');
  assert.equal(Number(redemptions[0].qty), 3, 'the quantity is summed across both lines');
});

test('the per-user limit is the database’s decision, and its refusal is mapped', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', limits: { max_per_user: 1 } });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  assert.equal((await json(await post(appFor(db), '/api/orders', orderBody()))).success, true);

  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  const second = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(second.code, 'PER_USER_LIMIT_REACHED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);
});

// -------------------------------------------------------- the quote, case 20

test('case 20 — a four-component bundle is ONE quote line with its parts nested, and the printer note still fires', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [...DEFAULT_COMPONENTS, { id: 'bc_abs', product: 'p_color', qty: 1, colorId: 'pc_black' }],
  });
  raw.exec(`
    INSERT OR IGNORE INTO catalogs (id,slug,name_ar,name_en,is_printer_catalog)
      VALUES ('cat_pr','printers-test','طابعات','Printers',1);
    INSERT INTO product_catalogs (product_id,catalog_id,position)
      SELECT 'p_printer', id, 0 FROM catalogs WHERE is_printer_catalog = 1 LIMIT 1;
  `);
  raw.exec("INSERT INTO admin_settings (key, value) VALUES ('printerHomeDeliveryNoteIqd', '25000')");
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });

  const res = await json(await post(appFor(db), '/api/orders/quote', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.quote.lines.length, 1, 'four extra 0 IQD rows on the last screen before payment is the bug this catches');
  assert.equal(res.quote.lines[0].included.length, 4);
  assert.equal(res.quote.lines[0].is_printer, true, 'is_printer is carried UP onto the parent');
  assert.equal(res.quote.notes.printer_home_delivery_iqd, 25000);
  // Read-only: the quote allocates nothing and writes nothing.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
});

test('the customer’s order payload shows ONE item with its parts nested underneath', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter' });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));

  assert.equal(res.order.items.length, 1);
  assert.equal(res.order.items[0].bundle.components.length, 3);
  assert.equal(res.order.items[0].bundle.bundle_price_iqd, 400_000);
  for (const k of res.order.items[0].bundle.components) assert.ok(k.alloc_iqd > 0);

  const detail = await json(
    await (await import('./fixtures/app')).get(appFor(db), `/api/orders/${res.order.id}`)
  );
  assert.equal(detail.order.items.length, 1);
  assert.equal(detail.order.item_count, 1, 'a bundle is ONE thing on the card, not four');
});

// ------------------------------------------------- re-validation, case 11

const MUTATIONS: Array<{ name: string; sql: string; code: string }> = [
  { name: 'the bundle is hidden', sql: "UPDATE products SET status='hidden' WHERE id='prd_b1'", code: 'OFFER_INACTIVE' },
  { name: 'the offer window is switched off', sql: "UPDATE offer_windows SET active=0 WHERE subject_id='prd_b1'", code: 'OFFER_INACTIVE' },
  { name: 'the window has not opened', sql: "UPDATE offer_windows SET starts_at='2099-01-01T00:00:00.000Z' WHERE subject_id='prd_b1'", code: 'OFFER_WINDOW_NOT_STARTED' },
  { name: 'the window has closed', sql: `UPDATE offer_windows SET ends_at='${PAST}' WHERE subject_id='prd_b1'`, code: 'OFFER_WINDOW_EXPIRED' },
  { name: 'a tier gate appears', sql: `UPDATE offer_windows SET required_tiers='["plus"]' WHERE subject_id='prd_b1'`, code: 'MEMBERSHIP_REQUIRED' },
  { name: 'a component sells out', sql: "UPDATE products SET stock=0 WHERE id='p_pla'", code: 'OUT_OF_STOCK' },
  { name: 'a component is hidden', sql: "UPDATE products SET status='hidden' WHERE id='p_nozzle'", code: 'OUT_OF_STOCK' },
  { name: 'a component becomes a pre-order beside a direct one', sql: `UPDATE products SET sale_types='["pre_order"]', selling_type='pre_order', preorder_transports='[{"method":"air","active":true}]' WHERE id='p_nozzle'`, code: 'BUNDLE_SHIPPING_MIXED' },
  { name: 'the per-order cap drops below the line', sql: "UPDATE bundle_config SET max_qty_per_order=1 WHERE product_id='prd_b1'", code: 'BUNDLE_QTY_LIMIT' },
];

for (const m of MUTATIONS) {
  test(`case 11 — ${m.name} AFTER the cart row is written ⇒ refused at the door, writing nothing`, async () => {
    const raw = seedCatalogue();
    addBundle(raw, { id: 'prd_b1', slug: 'starter', window: { active: 1 } });
    const db = asD1(raw);
    await addBundleToCart(db, { productId: 'prd_b1', qty: 2 });
    raw.exec(m.sql);

    const res = await json(await post(appFor(db), '/api/orders', orderBody()));
    assert.notEqual(res.success, true, `${m.name}: the door let it through`);
    assert.equal(res.code, m.code, `${m.name}: ${JSON.stringify(res)}`);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM inventory_ledger'), 0);
  });
}

test('case 11 — a chosen colour deactivated after the cart row is written is refused by name', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [{ id: 'bc_abs', product: 'p_color', qty: 1, picksColor: true }],
  });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1, bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_black' }] });
  raw.exec("UPDATE product_colors SET active = 0 WHERE id = 'pc_black'");

  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.code, 'BUNDLE_CHOICE_INVALID');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
});

test('case 11 — an opted-in optional component that cannot be satisfied is REFUSED by name, never dropped', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [
      { id: 'bc_nozzle', product: 'p_nozzle', qty: 1 },
      { id: 'bc_printer', product: 'p_printer', qty: 1, optional: true },
    ],
  });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  raw.exec("UPDATE products SET stock = 0 WHERE id = 'p_printer'");

  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.code, 'BUNDLE_OPTIONAL_UNAVAILABLE', JSON.stringify(res));
  assert.equal(res.details.component_id, 'bc_printer', 'the refusal names the component to un-tick');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
});

// ------------------------------------------------------- case 4, pre-order

test('case 4 — a pre-order bundle sells with no physical stock, on the 14-stage path, and reserves nothing', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_pre',
    slug: 'pre',
    priceIqd: 90_000,
    components: [
      { id: 'bc_pre', product: 'p_pre', qty: 1 },
      { id: 'bc_pre2', product: 'p_pre2', qty: 1 },
    ],
  });
  raw.exec(
    `INSERT INTO admin_settings (key, value) VALUES ('preorderTransportDefaults', '[{"method":"air","commission_iqd":7000},{"method":"sea","commission_iqd":3000}]')`
  );
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_pre', qty: 1, transportMethod: 'sea' });

  const res = await json(await post(appFor(db), '/api/orders', orderBody({ paymentMethodId: 'wallet', useWallet: true })));
  assert.equal(res.success, true, JSON.stringify(res));
  const order = orderRow(raw, res.order.id);
  assert.equal(order.shipping_type, 'preorder_sea', 'the parent cart row carried the transport, so the journey follows');

  const rows = items(raw, res.order.id);
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
  // The components' commissions are charged ON THE PARENT — the store never
  // eats the air-versus-sea difference — while merchandise stays the bundle
  // price so the points basis and the coupon minimum are unaffected.
  assert.equal(Number(parent.unit_price_iqd), 90_000 + 3000 * 2);
  assert.equal(Number(order.merchandise_iqd), 90_000);
  const transport = JSON.parse(String(parent.transport_snapshot)) as { method: string; commission_iqd: number };
  assert.equal(transport.method, 'sea');
  assert.equal(transport.commission_iqd, 6000);

  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind='reserve'"), 0, 'nothing physical is held');
  assert.deepEqual(
    row(raw, 'SELECT expected, actual FROM order_reservation_fence WHERE order_id = ? AND kind = ?', res.order.id, 'reserve'),
    { expected: 0, actual: 0 },
    'the fence still records that nothing was held'
  );
});

// ------------------------------------------------------------ case 8, money

test('case 8 — a coupon applies once, to merchandise that already contains the bundle price', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000 });
  raw.exec(
    `INSERT INTO coupons (id,code,kind,value,min_total_iqd,active) VALUES ('cp1','SAVE10','percent',10,0,1)`
  );
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });

  const res = await json(await post(appFor(db), '/api/orders', orderBody({ couponCode: 'SAVE10' })));
  assert.equal(res.success, true, JSON.stringify(res));
  const order = orderRow(raw, res.order.id);
  const coupon = JSON.parse(String(order.coupon_snapshot)) as { discount_iqd: number };
  // 10% of (subtotal + delivery), applied once — `settle` is untouched.
  assert.equal(Number(order.merchandise_iqd), 400_000);
  assert.ok(coupon.discount_iqd > 0);
  assert.equal(
    Number(order.total_iqd),
    Number(order.subtotal_iqd) + Number(order.shipping_iqd) - coupon.discount_iqd
  );
});

test('case 8 — a derived price that falls below its floor stops the sale rather than selling at nothing', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    config: { price_mode: 'discount_iqd', discount_iqd: 400_000, min_price_iqd: 1000 },
    components: [{ id: 'bc_nozzle', product: 'p_nozzle', qty: 1 }],
  });
  const db = asD1(raw);
  const res = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(res.code, 'OFFER_INACTIVE', 'a component that went free must not drag the bundle to zero');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0);
});

// ------------------------------------------------------------ case 9, tiers

test('case 9 — a PLUS member is charged the offer’s PLUS rung, and the ladder never inverts', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    priceIqd: 400_000,
    primeIqd: 380_000,
    proIqd: 360_000,
    config: { plus_price_iqd: 390_000 },
  });
  const db = asD1(raw);
  const plus: StubUser = { id: 'u_plus', role: 'customer', email: 'z@x.co' };
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 }, plus);

  const res = await json(await post(appFor(db, plus), '/api/orders', orderBody({ addressId: 'addr_p' })));
  assert.equal(res.success, true, JSON.stringify(res));
  const order = orderRow(raw, res.order.id);
  assert.equal(Number(order.merchandise_iqd), 390_000, 'the door charges the same PLUS number the card showed');
  const parent = items(raw, res.order.id).find((r) => r.bundle_parent_item_id === null)!;
  const snapshot = JSON.parse(String(parent.pricing_snapshot)) as {
    applied_iqd: number;
    applied_tier: string;
    composition: { applied_tier: string };
  };
  assert.equal(snapshot.applied_iqd, 390_000);
  assert.equal(snapshot.composition.applied_tier, 'plus', 'the four-value tier lives on the composition block');
  assert.equal(snapshot.applied_tier, 'regular', 'the shared ResolvedPrice tier union is not widened');
});

test('a printer bought INSIDE a bundle still gets its device unit and its warranty clock', async () => {
  // The proof of §6.2's claim that device units, warranty coverage, return
  // cases and price-protection claims all key on `order_items.id` — and that
  // the COMPONENT row is the one naming the real product, so none of them
  // needed a special case for bundles.
  const raw = seedCatalogue();
  raw.exec(`
    INSERT OR IGNORE INTO catalogs (id,slug,name_ar,name_en,is_printer_catalog)
      VALUES ('cat_pr','printers-test','طابعات','Printers',1);
    INSERT INTO product_catalogs (product_id,catalog_id,position)
      SELECT 'p_printer', id, 0 FROM catalogs WHERE is_printer_catalog = 1 LIMIT 1;
  `);
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000 });
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_b1', qty: 1 });
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));

  const { createUnitsOnDelivery } = await import('../worker/lib/deviceOps');
  const created = await createUnitsOnDelivery({ DB: db } as never, res.order.id, new Date().toISOString());
  assert.equal(created.created, 1, 'the printer component produced exactly one serialized unit');
  const unit = row<Record<string, unknown>>(raw, 'SELECT * FROM order_item_units WHERE order_id IS NOT NULL OR 1=1')!;
  const component = items(raw, res.order.id).find((r) => r.product_id === 'p_printer')!;
  assert.equal(String(unit.order_item_id), String(component.id), 'the unit hangs off the COMPONENT row');
  assert.equal(String(unit.product_id), 'p_printer');
});

test('case 4 — a pre-order bundle paid CASH ON DELIVERY is priced by the direct-sale rules, and the quote says so', async () => {
  // The owner's rule: «إذا اختار الزبون الدفع عند الاستلام فيجب أن يتبع السعر
  // نفس قواعد البيع المباشر». For a bundle the money that changes is its
  // COMPONENTS' transport commissions — they ride on the parent (§2.2) — so a
  // bundle resolved only at the prepaid basis would collect an air-freight
  // commission on an order paying cash at the door.
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_pre',
    slug: 'pre',
    priceIqd: 90_000,
    components: [{ id: 'bc_pre', product: 'p_pre', qty: 2 }],
  });
  raw.exec(
    `INSERT INTO admin_settings (key, value) VALUES ('preorderTransportDefaults', '[{"method":"air","commission_iqd":7000},{"method":"sea","commission_iqd":3000}]')`
  );
  // "Priced as a direct sale" needs a direct-sale premium to price WITH: a
  // pre-order product with none configured keeps its commission under cash on
  // delivery, deliberately, so the door is never cheaper than the wallet.
  raw.exec("UPDATE products SET direct_surcharge_iqd = 5000 WHERE id = 'p_pre'");
  const db = asD1(raw);
  await addBundleToCart(db, { productId: 'prd_pre', qty: 1, transportMethod: 'air' });

  const prepaid = await json(await post(appFor(db), '/api/orders/quote', orderBody({ paymentMethodId: 'wallet' })));
  const cod = await json(await post(appFor(db), '/api/orders/quote', orderBody({ paymentMethodId: 'cash' })));
  assert.equal(prepaid.quote.lines[0].unit_price_iqd, 90_000 + 7000 * 2, 'prepaid pays the commission on both spools');
  assert.equal(
    cod.quote.lines[0].unit_price_iqd,
    90_000 + 5000 * 2,
    'cash on delivery pays the DIRECT premium instead of the transport commission'
  );
  assert.equal(cod.quote.cod_reprices, true, 'and the screen is told the number really does move');
  // Merchandise is the bundle price either way: the points basis, the coupon
  // minimum and the accrual never see a fee.
  assert.equal(prepaid.quote.merchandise_iqd, 90_000);
  assert.equal(cod.quote.merchandise_iqd, 90_000);

  const res = await json(await post(appFor(db), '/api/orders', orderBody({ paymentMethodId: 'cash' })));
  assert.equal(res.success, true, JSON.stringify(res));
  const parent = items(raw, res.order.id).find((r) => r.bundle_parent_item_id === null)!;
  assert.equal(Number(parent.unit_price_iqd), 90_000 + 5000 * 2, 'the order charges what the cash quote showed');
  assert.equal(orderRow(raw, res.order.id).shipping_type, 'preorder_air', 'and it is still a pre-order on its journey');
});
