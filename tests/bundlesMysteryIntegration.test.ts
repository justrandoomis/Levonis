/**
 * THE WHOLE MANDATE, END TO END, ON ONE FRESH DATABASE —
 * docs/BUNDLES_MYSTERY_PLAN.md §4 "definition of done".
 *
 * Ten slices were built in parallel, each with its own suite. Every one of
 * those suites is honest about the surface it owns and silent about the seams
 * between them, and a seam is exactly where a parallel build breaks: the admin
 * panel computes a component total with one function while the storefront
 * computes it with another, the cart accepts a line the door then refuses, an
 * allocation reaches the API and never reaches the screen the staff read.
 *
 * So this file walks the flow the owner described, in order, in ONE
 * continuous run per journey, through the REAL routers over the real
 * transactional `SqliteD1` with every migration applied:
 *
 *   admin composes  →  the shop lists it  →  the wrong tier is refused  →
 *   one cart line with its parts  →  checkout re-validates and reserves
 *   atomically  →  the snapshot is complete and immutable  →  the mystery
 *   allocation is permanent under replay  →  fulfilment sees what it must  →
 *   the customer sees the reveal only at its milestone  →  cancellation
 *   releases exactly what was reserved.
 *
 * WHAT THIS FILE ASSERTS THAT NO SLICE SUITE CAN
 *
 * 1. THE ADMIN'S NUMBERS AND THE SHOP'S NUMBERS ARE THE SAME NUMBERS. §2.3
 *    and §11.3 require it, and the two paths are genuinely different code:
 *    `resolveComposition` resolves ONE bundle from unsaved admin input,
 *    `resolveCompositionPage` resolves a PAGE of stored rows for a viewer.
 *    They agree only because both end in `bundleAvailability` and
 *    `resolveBundlePrice`, and nothing but a test that calls both proves it.
 *
 * 2. THE THING THE ADMIN PANEL WROTE IS THE THING THE DOOR SELLS. Every other
 *    buy-path test seeds `bundle_components` with SQL — deliberately, so it
 *    can build states the panel would refuse. That leaves the panel's own
 *    output untested as a purchase input. Here the bundle and the mystery
 *    offer are created ONLY through `/api/admin/bundles` and
 *    `/api/admin/mystery`, and then bought.
 *
 * 3. THE FOUR MONEY AND STOCK SUMS TIE OUT ACROSS THE WHOLE JOURNEY, not at
 *    one instant: what was reserved at checkout is what is released at
 *    cancellation, row for row, and the fence rows prove both landed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, all, row, count, type App, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { productRoutes } from '../worker/routes/products';
import { bundlesRoutes } from '../worker/routes/bundles';
import { adminRoutes } from '../worker/routes/admin';
import { adminBundlesRoutes } from '../worker/routes/adminBundles';
import { adminMysteryRoutes } from '../worker/routes/mystery';
import { templateRoutes } from '../worker/routes/template';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { eligibleMerchandiseIqd } from '../worker/lib/pointsOps';
import { seedCatalogue, orderBody } from './lib/bundles';
import { POOL_PRODUCTS, forbiddenTokens } from './lib/mysteryOffer';

const boss: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };
const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const plus: StubUser = { id: 'u_plus', role: 'customer', email: 'z@x.co' };
const prime: StubUser = { id: 'u_prime', role: 'customer', email: 'n@x.co' };
const pro: StubUser = { id: 'u_pro', role: 'customer', email: 'r@x.co' };

/** Everything the flow touches, mounted the way `worker/index.ts` mounts it. */
const appAs = (db: unknown, user: StubUser | null) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/products', productRoutes);
    a.route('/api/bundles', bundlesRoutes);
    a.route('/api/admin', adminRoutes);
    a.route('/api/admin/bundles', adminBundlesRoutes);
    a.route('/api/admin/mystery', adminMysteryRoutes);
    a.route('/api/admin/template', templateRoutes);
  });

const put = (a: App, path: string, body: unknown) =>
  a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const items = (raw: DatabaseSync, orderId: string) =>
  all<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid', orderId);
const ledgerRows = (raw: DatabaseSync, orderId: string, kind: string) =>
  all<Record<string, unknown>>(
    raw,
    'SELECT * FROM inventory_ledger WHERE order_id = ? AND kind = ? ORDER BY rowid',
    orderId,
    kind
  );
/** Every reserved counter in the four REAL stock tables, as one comparable map. */
const reservedEverywhere = (raw: DatabaseSync) => ({
  products: all<{ id: string; n: number }>(
    raw,
    'SELECT id, stock_reserved AS n FROM products WHERE stock_reserved <> 0 ORDER BY id'
  ),
  colors: all<{ id: string; n: number }>(
    raw,
    'SELECT id, reserved AS n FROM product_colors WHERE reserved <> 0 ORDER BY id'
  ),
  optionValues: all<{ id: string; n: number }>(
    raw,
    'SELECT id, reserved AS n FROM product_option_values WHERE reserved <> 0 ORDER BY id'
  ),
  variants: all<{ id: string; n: number }>(
    raw,
    'SELECT id, reserved AS n FROM product_variants WHERE reserved <> 0 ORDER BY id'
  ),
});

// =====================================================================
// JOURNEY ONE — a bundle, from the admin panel to the cancelled order
// =====================================================================

test('a bundle walks the whole mandate: composed, listed, gated, carted, reserved, snapshotted, cancelled', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);

  // ---------------------------------------------- 1. the admin composes it
  //
  // The ONLY way this bundle comes into existence. Nothing below seeds a
  // component row by hand, so what the panel writes is what the shop sells.
  const created = await json(
    await post(appAs(db, boss), '/api/admin/bundles', {
      name_en: 'Starter Bundle',
      name_ar: 'حزمة البداية',
      name_ku: 'پاکێجی دەستپێک',
      description: 'A printer, two spools and a nozzle.',
      price_iqd: 400_000,
      status: 'active',
      components: [
        { member_product_id: 'p_printer', qty: 1, sort: 0 },
        { member_product_id: 'p_pla', qty: 2, sort: 1 },
        { member_product_id: 'p_nozzle', qty: 1, sort: 2 },
      ],
      config: { price_mode: 'fixed', max_qty_per_order: 5, min_price_iqd: 1 },
      // Members-only, PLUS. PRO inherits PLUS; PRIME is a buyer tier standing
      // alone and must NOT be admitted (§9).
      offer: { required_tiers: ['plus'], active: true },
    })
  );
  assert.equal(created.success, true, JSON.stringify(created));
  const bundleId = String(created.product.id);
  const bundleSlug = String(created.product.slug);

  // The panel's own numbers, computed by the server (§11.3: nothing is
  // computed in the panel). The owner's worked example: printer 5, spool 6
  // needing 2, nozzle 20 → three bundles.
  const preview = created.preview as Record<string, unknown>;
  const availability = preview.availability as Record<string, unknown>;
  assert.equal(availability.max_bundles, 3, 'the scarcest component decides: floor(6/2) = 3');
  // `low` is the documented rule of §2.1, not an invention: `max_bundles <=
  // COMPOSITION_LOW_BUNDLES` (3). The membership gate DECORATES it rather than
  // replacing it, so the card can say both "members only" and "nearly gone".
  assert.equal(availability.state, 'low');
  assert.equal(availability.member_exclusive, true, 'an entitled viewer of a gated offer');
  assert.equal(preview.component_total_iqd, 400_000 + 25_000 * 2 + 5_000);
  assert.equal(preview.bundle_price_iqd, 400_000);

  // The pins of §1.2, read back from the table rather than from the response.
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', bundleId)!;
  assert.equal(stored.composition, 'bundle');
  assert.equal(stored.stock, null, 'a bundle is NEVER stocked');
  assert.equal(stored.inventory_mode, 'BASE');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM bundle_components WHERE bundle_product_id = ?', bundleId), 3);

  // ------------------------------------- 2. the shop lists it, honestly
  //
  // A guest sees a LOCKED CARD — a 200 with the §9 allow-list, never a 403 and
  // never a price they cannot pay.
  const guestList = await json(await get(appAs(db, null), '/api/bundles'));
  assert.equal(guestList.signed_in, false);
  assert.equal(guestList.entitled, false);
  const guestCard = (guestList.bundles as Record<string, unknown>[]).find((b) => b.id === bundleId)!;
  assert.equal(guestCard.locked, true);
  for (const stripped of [
    'display_price_iqd',
    'display_prime_iqd',
    'display_pro_iqd',
    'display_applied_tier',
    'composition',
  ]) {
    assert.equal(stripped in guestCard, false, `a locked card must not carry ${stripped}`);
  }
  assert.equal(guestCard.display_regular_iqd, 400_000, 'locked_preview allows the regular price as a teaser');

  // A PLUS member sees the real card — and its figures are the ADMIN'S
  // figures. Two different resolution passes, one answer (§2.3).
  const plusList = await json(await get(appAs(db, plus), '/api/bundles'));
  const plusCard = (plusList.bundles as Record<string, unknown>[]).find((b) => b.id === bundleId)!;
  assert.equal(plusCard.locked, false);
  const cardComposition = plusCard.composition as Record<string, unknown>;
  assert.equal(
    cardComposition.component_total_iqd,
    preview.component_total_iqd,
    'the admin preview and the storefront card quote the same component total'
  );
  assert.equal(cardComposition.availability_state, availability.state, 'one verdict, two surfaces');
  assert.equal(cardComposition.member_exclusive, true);
  // Coarse state only: no count, no component list, no pool, no weight (§14).
  const cardBody = JSON.stringify(plusCard);
  assert.equal('max_bundles' in cardComposition, false);
  assert.equal('blocking' in cardComposition, false);
  assert.ok(!cardBody.includes('"available"'), 'no per-row availability count reaches a card');

  // THE KEYS THE STOREFRONT SHELVES ACTUALLY READ. `src/pages/Bundles.tsx`,
  // `src/components/home/BundlesShelf.tsx` and the members' shelf on
  // `src/pages/Profile.tsx` all render a card from this payload, and a card
  // that silently stopped carrying its price renders `0 IQD` rather than
  // failing — so the contract's key list is asserted, not assumed.
  for (const key of ['id', 'product_slug', 'name', 'name_ar', 'name_ku', 'image', 'availability_state']) {
    assert.ok(key in plusCard, `the listing card must carry ${key}`);
  }
  assert.equal(typeof plusCard.display_price_iqd, 'number', 'and a price a shelf can render');

  // The detail page carries the parts; the listing never did.
  const detail = await json(await get(appAs(db, plus), `/api/bundles/${bundleSlug}`));
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.equal((detail.bundle.composition.components as unknown[]).length, 3);

  // ------------------------------------------ 3. eligibility, at the door
  //
  // PRIME is not PLUS. The list may show a lock; the purchase API is the
  // decision, and it refuses independently of anything the browser did.
  const primeAdd = await post(appAs(db, prime), '/api/cart/items', { productId: bundleId, qty: 1 });
  const primeBody = await json(primeAdd);
  assert.equal(primeAdd.status, 403, JSON.stringify(primeBody));
  assert.equal(primeBody.code, 'MEMBERSHIP_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0, 'a refused add writes nothing');

  // A guest is refused too, and PRO — which inherits PLUS — is not.
  const proAdd = await json(await post(appAs(db, pro), '/api/cart/items', { productId: bundleId, qty: 1 }));
  assert.equal(proAdd.success, true, JSON.stringify(proAdd));
  raw.prepare('DELETE FROM cart_items').run();

  // ------------------------------- 4. the cart: ONE line, parts preserved
  const added = await json(await post(appAs(db, plus), '/api/cart/items', { productId: bundleId, qty: 2 }));
  assert.equal(added.success, true, JSON.stringify(added));

  const cart = await json(await get(appAs(db, plus), '/api/cart'));
  assert.equal((cart.items as unknown[]).length, 1, 'a four-part box is ONE top-level cart item');
  const line = (cart.items as Record<string, unknown>[])[0];
  const comp = line.composition as Record<string, unknown>;
  assert.equal((comp.components as unknown[]).length, 3, 'the parts are preserved, nested under the line');
  assert.equal(comp.bundle_price_iqd, 400_000);
  assert.equal(comp.component_total_iqd, preview.component_total_iqd);
  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM cart_bundle_choices'),
    3,
    'the readable choices ride their own child table'
  );
  // The composition key rides in `option_id` and NOTHING derives a selection
  // from it (§5.1) — the failure mode is a nonsense OPTION_NOT_FOUND at the
  // door, so it is asserted on the cart row itself.
  const cartRow = row<Record<string, unknown>>(raw, 'SELECT * FROM cart_items')!;
  assert.match(String(cartRow.option_id), /^bx_/);
  assert.equal(String(cartRow.option_value_ids), '[]');

  // ---------------------- 5. checkout re-validates EVERYTHING, then reserves
  //
  // The cart row is already written. Everything the door checks is checked
  // again on the STORED row, against the live catalogue — never on what the
  // browser believed when it added the line (§6.1).
  raw.prepare("UPDATE products SET stock = 1 WHERE id = 'p_pla'").run();
  const short = await post(appAs(db, plus), '/api/orders', orderBody({ addressId: 'addr_p' }));
  const shortBody = await json(short);
  assert.equal(short.status, 400, JSON.stringify(shortBody));
  assert.equal(shortBody.code, 'OUT_OF_STOCK', 'a component that ran short after the cart refuses at the door');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0, 'a refused checkout writes nothing');
  raw.prepare("UPDATE products SET stock = 6 WHERE id = 'p_pla'").run();

  raw.prepare('UPDATE offer_windows SET active = 0 WHERE subject_id = ?').run(bundleId);
  const closed = await post(appAs(db, plus), '/api/orders', orderBody({ addressId: 'addr_p' }));
  const closedBody = await json(closed);
  assert.equal(closed.status >= 400, true, JSON.stringify(closedBody));
  assert.equal(closedBody.code, 'OFFER_INACTIVE', 'an offer switched off after the cart refuses at the door');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 0);
  raw.prepare('UPDATE offer_windows SET active = 1 WHERE subject_id = ?').run(bundleId);

  const quote = await json(await post(appAs(db, plus), '/api/orders/quote', orderBody({ addressId: 'addr_p' })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.equal((quote.quote.lines as unknown[]).length, 1, 'the last screen before payment shows ONE line');

  const before = reservedEverywhere(raw);
  assert.deepEqual(before.products, [], 'nothing is held before the order');

  const placed = await json(await post(appAs(db, plus), '/api/orders', orderBody({ addressId: 'addr_p' })));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = String(placed.order.id);

  const rows = items(raw, orderId);
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
  const kids = rows.filter((r) => r.bundle_parent_item_id !== null);
  assert.equal(kids.length, 3);
  const order = row<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', orderId)!;

  // The money ties out three ways at once.
  assert.equal(
    rows.reduce((n, r) => n + Number(r.line_total_iqd), 0),
    Number(order.subtotal_iqd)
  );
  assert.equal(
    kids.reduce((n, k) => n + Number(k.component_alloc_iqd), 0),
    Number(parent.line_total_iqd),
    'largest-remainder allocation leaves nothing over'
  );
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
    'points accrue on the parent only, and on the number actually charged'
  );

  // The stock moved on the REAL rows, and only there (case 3).
  const after = reservedEverywhere(raw);
  assert.deepEqual(
    after.products.map((p) => [p.id, p.n]).sort(),
    [['p_nozzle', 2], ['p_pla', 4], ['p_printer', 2]],
    'two bundles hold 2 printers, 4 spools and 2 nozzles — on `products`, nowhere else'
  );
  assert.deepEqual(after.colors, []);
  assert.deepEqual(after.optionValues, []);
  assert.deepEqual(after.variants, []);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id = ? AND stock IS NULL", bundleId), 1);

  // The reservation is fenced: `expected = actual` inside the order's own
  // batch, so a partial reservation could not have committed (§3.3).
  const reserves = ledgerRows(raw, orderId, 'reserve');
  assert.equal(reserves.length, 3, 'one guarded ledger row per component');
  const fence = row<Record<string, unknown>>(
    raw,
    "SELECT * FROM order_reservation_fence WHERE order_id = ? AND kind = 'reserve'",
    orderId
  )!;
  assert.equal(Number(fence.expected), 3);
  assert.equal(Number(fence.actual), 3);

  // Exactly one redemption row for the subject, with the quantity summed.
  const redemptions = all<Record<string, unknown>>(
    raw,
    'SELECT * FROM offer_redemptions WHERE order_id = ?',
    orderId
  );
  assert.equal(redemptions.length, 1);
  assert.equal(Number(redemptions[0].qty), 2);

  // ------------------------------- 6. the snapshot: complete and immutable
  const snapshot = JSON.parse(String(parent.pricing_snapshot)) as Record<string, unknown>;
  const block = snapshot.composition as Record<string, unknown>;
  assert.equal(block.kind, 'bundle');
  assert.equal(block.bundle_price_iqd, 400_000);
  assert.equal(block.component_total_iqd, preview.component_total_iqd);
  assert.equal((block.items as unknown[]).length, 3);
  assert.equal(snapshot.applied_iqd, 400_000, 'the parent snapshot carries what was CHARGED');
  assert.ok(!JSON.stringify(snapshot).includes('cost_iqd'), 'cost never crosses a public boundary');
  // Every component names its own reservation line, and that id is the ledger
  // line id — the "inventory reservation reference" of §6.2, with no new column.
  const ledgerLineIds = reserves.map((r) => String(r.idempotency_key).split(':')[2]).sort();
  assert.deepEqual(
    (block.items as Record<string, unknown>[]).map((i) => String(i.reservation_line_id)).sort(),
    ledgerLineIds
  );

  const asPlaced = await json(await get(appAs(db, plus), `/api/orders/${orderId}`));
  assert.equal((asPlaced.order.items as unknown[]).length, 1, 'the customer sees one line, not four');

  // Now break the catalogue underneath it. The snapshot must not move.
  raw.prepare("UPDATE products SET price_iqd = 999999, name = 'Renamed' WHERE id = 'p_pla'").run();
  raw.prepare("UPDATE products SET status = 'draft' WHERE id = 'p_nozzle'").run();
  const afterEdit = await json(await get(appAs(db, plus), `/api/orders/${orderId}`));
  assert.deepEqual(afterEdit.order.items, asPlaced.order.items, 'the order snapshot is immutable');

  // -------------------------- 7. fulfilment sees the physical truth
  const adminOrder = await json(await get(appAs(db, boss), `/api/admin/orders/${orderId}`));
  assert.equal(adminOrder.success, true, JSON.stringify(adminOrder).slice(0, 300));
  const adminItems = adminOrder.order.items as Record<string, unknown>[];
  assert.equal(adminItems.length, 1, 'the parts are GROUPED under their parent, not four loose zero-price rows');
  const packed = adminItems[0].bundle as Record<string, unknown>;
  assert.equal((packed.components as unknown[]).length, 3, 'the staff packing the box see every part');

  // -------- 8. cancellation releases exactly what the reservation reserved
  const cancelled = await json(await post(appAs(db, plus), `/api/orders/${orderId}/cancel`, {}));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled).slice(0, 300));

  const releases = ledgerRows(raw, orderId, 'release');
  assert.equal(releases.length, reserves.length, 'row for row, what was reserved is what is released');
  assert.deepEqual(
    releases.map((r) => [String(r.product_id), Number(r.qty)]).sort(),
    reserves.map((r) => [String(r.product_id), Number(r.qty)]).sort()
  );
  const releaseFence = row<Record<string, unknown>>(
    raw,
    "SELECT * FROM order_reservation_fence WHERE order_id = ? AND kind = 'release'",
    orderId
  )!;
  assert.equal(Number(releaseFence.expected), Number(releaseFence.actual));
  assert.deepEqual(reservedEverywhere(raw), before, 'every counter is back exactly where it started');
  // §17 decision 4, made explicit: the row is kept, never deleted — and on a
  // NORMAL bundle the owner ruled that a genuine cancellation gives the slot
  // back, so it is `released`. A mystery order is the one that never releases
  // (journey two, and tests/offerRedemptionState.test.ts).
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE order_id = ?', orderId), 1);
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM offer_redemptions WHERE order_id = ? AND state = 'released'", orderId),
    1
  );
});

// =====================================================================
// JOURNEY TWO — a mystery offer, from the pool to the reveal
// =====================================================================

/** The four filament products the pool draws from, each at its own price so
 *  "no number equal to the drawn item's price leaked" is a real assertion. */
function seedFilaments(raw: DatabaseSync): void {
  for (const p of POOL_PRODUCTS) {
    raw
      .prepare(
        `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                               selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
         VALUES (?,?,?,?,?,?,'active',?,'[]','[]','direct_sale','["direct_sale"]','[]',?,'BASE','{"is_spool":true}')`
      )
      .run(
        p.id,
        p.slug,
        p.name,
        `${p.name} AR`,
        `${p.name} KU`,
        p.price,
        p.stock,
        JSON.stringify([`https://cdn/${p.slug}.png`])
      );
  }
}

test('a mystery offer walks the whole mandate: pooled, published, bought, permanent, packed, revealed on time', async () => {
  const raw = seedCatalogue();
  seedFilaments(raw);
  const db = asD1(raw);
  const adminApp = appAs(db, boss);

  // ------------------------------- 1. the admin configures pool and offer
  const pool = await json(
    await post(adminApp, '/api/admin/mystery/pools', { name: 'Filament pool', kind: 'direct', min_available: 1 })
  );
  assert.equal(pool.success, true, JSON.stringify(pool));
  const poolId = String(pool.pool.id);

  // The bulk generator expands products into entries ON THE SERVER (§10) —
  // nothing about the pool is invented in a browser.
  const generated = await json(
    await post(adminApp, `/api/admin/mystery/pools/${poolId}/entries/generate`, {
      product_ids: POOL_PRODUCTS.map((p) => p.id),
      weight: 1,
    })
  );
  assert.equal(generated.success, true, JSON.stringify(generated));
  assert.equal(generated.inserted, POOL_PRODUCTS.length);

  // The eligible-stock preview: per-entry probability and the distinct-choice
  // count §7.5 keeps out of every customer refusal.
  const eligible = await json(await get(adminApp, `/api/admin/mystery/pools/${poolId}/eligible`));
  assert.equal(eligible.success, true, JSON.stringify(eligible));
  assert.equal((eligible.eligible as unknown[]).length, POOL_PRODUCTS.length);
  assert.equal(eligible.distinct_choices, POOL_PRODUCTS.length, 'the count §7.5 keeps out of every customer refusal');
  const probabilities = (eligible.eligible as Record<string, unknown>[]).map((x) => Number(x.probability));
  assert.ok(
    Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-9,
    'equal weights over four entries are four equal probabilities that sum to one'
  );

  const offer = await json(
    await post(adminApp, '/api/admin/mystery/offers', {
      name_en: 'Mystery Filament Box',
      name_ar: 'صندوق فتيل عشوائي',
      name_ku: 'سندووقی نهێنی',
      price_iqd: 60_000,
      status: 'active',
      direct_pool_id: poolId,
      spool_qty: 2,
      allow_direct: true,
      duplicate_policy: 'allow',
      // The milestone this offer is SOLD under, frozen onto every allocation.
      reveal_stage: 'delivered',
      offer: { required_tiers: [], active: true, max_per_user: 5 },
    })
  );
  assert.equal(offer.success, true, JSON.stringify(offer));
  const offerId = String(offer.product.id);
  const offerSlug = String(offer.product.slug);

  // ---------------------------------- 2. the shop lists it, revealing nothing
  const list = await json(await get(appAs(db, buyer), '/api/bundles?kind=mystery'));
  const card = (list.bundles as Record<string, unknown>[]).find((b) => b.id === offerId)!;
  assert.equal(card.locked, false, 'an ungated offer is public, guests included');
  assert.equal((card.composition as Record<string, unknown>).availability_state, 'in_stock');
  const listBody = JSON.stringify(list);
  for (const p of POOL_PRODUCTS) {
    assert.ok(!listBody.includes(p.id), 'the listing names no pool member');
    assert.ok(!listBody.includes(p.slug), 'the listing names no pool member');
  }
  assert.ok(!listBody.includes(poolId), 'no pool id ever reaches the browser');
  assert.ok(!listBody.includes('weight'), 'no weight ever reaches the browser');

  const detail = await json(await get(appAs(db, buyer), `/api/bundles/${offerSlug}`));
  assert.equal(detail.bundle.mystery.spool_qty, 2);
  assert.equal(
    (detail.bundle.composition.components as unknown[]).length,
    0,
    'a mystery offer lists no components, ever'
  );

  // ------------------------------------------- 3. the cart reveals nothing
  const added = await json(await post(appAs(db, buyer), '/api/cart/items', { productId: offerId, qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const salt = String(row<Record<string, unknown>>(raw, 'SELECT draw_salt FROM cart_items')!.draw_salt);
  assert.match(salt, /^[0-9a-f]{64}$/, 'the server writes the draw salt; the client never sees an input to the seed');

  const cart = await json(await get(appAs(db, buyer), '/api/cart'));
  const comp = (cart.items as Record<string, unknown>[])[0].composition as Record<string, unknown>;
  assert.deepEqual(comp.components, [], 'a mystery cart line carries NO components (§8.2 row 12)');
  assert.equal((comp.mystery as Record<string, unknown>).spool_qty, 2);

  // A quote must draw nothing and write nothing (§7.4).
  const quote = await json(await post(appAs(db, buyer), '/api/orders/quote', orderBody()));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 0, 'the quote allocates nothing');

  // -------------------------------------- 4. checkout draws, once, for ever
  const catalogueBefore = await json(await get(appAs(db, null), '/api/products?limit=50'));
  assert.ok(
    (catalogueBefore.products as Record<string, unknown>[]).some((p) => POOL_PRODUCTS.some((x) => x.id === p.id)),
    'the differential below is only meaningful if the pool members are actually published'
  );

  const body = orderBody();
  const placed = await json(await post(appAs(db, buyer), '/api/orders', body));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 400));
  const orderId = String(placed.order.id);

  const allocations = all<Record<string, unknown>>(
    raw,
    'SELECT * FROM mystery_allocations WHERE order_id = ? ORDER BY spool_index',
    orderId
  );
  assert.equal(allocations.length, 2, 'two spools, two allocations');
  const drawn = allocations.map((a) => String(a.product_id));
  for (const a of allocations) {
    assert.equal(a.reveal_stage_snapshot, 'delivered', 'the milestone is FROZEN onto the allocation');
    assert.equal(a.revealed_at, null);
    assert.ok(String(a.candidates_sha256).length > 0, 'the draw is reproducible from its candidate snapshot');
  }
  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM mystery_draw_audits WHERE order_id = ?', orderId),
    1,
    'one audit row per line carries the candidate list the draw ran against'
  );

  // The spool rows exist, name no product, and reserve real stock.
  const spoolRows = items(raw, orderId).filter((r) => r.bundle_parent_item_id !== null);
  assert.equal(spoolRows.length, 2);
  for (const s of spoolRows) {
    assert.equal(s.product_id, null, 'product_id = NULL makes the leak structurally impossible');
    assert.equal(s.pricing_snapshot, null, 'a mystery component persists no price ladder');
  }
  assert.equal(ledgerRows(raw, orderId, 'reserve').length, 2, 'each spool reserves the product actually drawn');

  // Surface 18: the public catalogue must not move. Two anonymous GETs around
  // a purchase would otherwise identify the pick with no statistics at all.
  const catalogueAfter = await json(await get(appAs(db, null), '/api/products?limit=50'));
  assert.deepEqual(catalogueAfter.products, catalogueBefore.products, 'no per-product number changed publicly');

  // ------------------------------------ 5. permanence under every replay
  const replay = await json(await post(appAs(db, buyer), '/api/orders', body));
  assert.equal(replay.success, true, JSON.stringify(replay).slice(0, 300));
  assert.equal(String(replay.order.id), orderId, 'the same idempotency key replays the stored order');
  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => post(appAs(db, buyer), '/api/orders', body))
  );
  for (const r of concurrent) await json(r);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1, 'one order, whatever the tap count');
  assert.deepEqual(
    all<Record<string, unknown>>(raw, 'SELECT * FROM mystery_allocations ORDER BY spool_index').map(
      (a) => String(a.product_id)
    ),
    drawn,
    'the pick never changes'
  );
  assert.equal(ledgerRows(raw, orderId, 'reserve').length, 2, 'and it reserves exactly once');

  // ------------------------------ 6. fulfilment sees the pick, from second one
  const adminOrder = await json(await get(appAs(db, boss), `/api/admin/orders/${orderId}`));
  const adminBody = JSON.stringify(adminOrder);
  for (const id of drawn) {
    assert.ok(adminBody.includes(id), 'the staff packing the box see the real filament from the first second');
  }

  // --------------- 7. the customer sees nothing until the frozen milestone
  const forbidden = forbiddenTokens(raw, drawn);
  assert.ok(forbidden.length >= 5, 'id, slug, name, image and price — the leak walk has real tokens to look for');
  const surfaces: Array<[string, unknown]> = [
    ['order detail', await json(await get(appAs(db, buyer), `/api/orders/${orderId}`))],
    ['order list', await json(await get(appAs(db, buyer), '/api/orders'))],
    ['units', await json(await get(appAs(db, buyer), `/api/orders/${orderId}/units`))],
    ['tracking', await json(await get(appAs(db, buyer), `/api/orders/${orderId}/tracking`))],
  ];
  for (const [label, payload] of surfaces) {
    const text = JSON.stringify(payload);
    for (const token of forbidden) {
      assert.ok(!text.includes(token), `${label} leaked "${token}" before the reveal`);
    }
  }

  // Walk the order to its milestone. `delivered` is the frozen stage, so
  // `confirmed` and `preparing` must still show nothing.
  const env = { DB: db } as never;
  for (const stage of ['confirmed', 'preparing', 'out_for_delivery'] as const) {
    await moveOrderStage(env, { orderId, to: stage, source: 'manual', changedBy: boss.id, note: '' });
    const mid = JSON.stringify(await json(await get(appAs(db, buyer), `/api/orders/${orderId}`)));
    for (const token of forbidden) {
      assert.ok(!mid.includes(token), `stage ${stage} revealed "${token}" before the milestone`);
    }
  }
  await moveOrderStage(env, { orderId, to: 'delivered', source: 'manual', changedBy: boss.id, note: '' });

  const revealed = await json(await get(appAs(db, buyer), `/api/orders/${orderId}`));
  const revealedText = JSON.stringify(revealed);
  for (const id of drawn) {
    assert.ok(revealedText.includes(id), 'at the milestone the customer is told exactly what they received');
  }
  for (const a of all<Record<string, unknown>>(raw, 'SELECT * FROM mystery_allocations')) {
    assert.ok(a.revealed_at, 'the reveal is stamped, and `revealed_at` is the truth from then on');
  }

  // Monotone on the second axis: editing the offer's configuration moves no
  // milestone an order was already sold under.
  raw.prepare("UPDATE bundle_config SET reveal_stage = 'paid' WHERE product_id = ?").run(offerId);
  assert.deepEqual(
    all<Record<string, unknown>>(raw, 'SELECT reveal_stage_snapshot FROM mystery_allocations').map(
      (a) => a.reveal_stage_snapshot
    ),
    ['delivered', 'delivered'],
    'the frozen snapshot is what governs, not the mutable config row'
  );
});

// =====================================================================
// The seam the two journeys share: one refusal vocabulary, one gate
// =====================================================================

test('the composition surface refuses the same way everywhere: the panel, the shop and the door agree', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);

  // An unpriced publish is refused BY THE PANEL, verbatim and in three
  // languages — never repaired into a free bundle (§4.7, §11.3).
  const refused = await post(appAs(db, boss), '/api/admin/bundles', {
    name_en: 'Free box',
    name_ar: 'صندوق',
    price_iqd: 0,
    status: 'active',
    components: [{ member_product_id: 'p_nozzle', qty: 1, sort: 0 }],
    config: { price_mode: 'fixed' },
  });
  const refusedBody = await json(refused);
  assert.equal(refused.status, 400, JSON.stringify(refusedBody));
  assert.equal(refusedBody.code, 'BUNDLE_VALIDATION');
  const issue = (refusedBody.details.errors as Record<string, unknown>[])[0];
  for (const lang of ['ar', 'en', 'ckb']) {
    assert.equal(typeof issue[lang], 'string', `a refusal carries ${lang}`);
    assert.ok(String(issue[lang]).length > 0);
  }
  assert.equal(typeof issue.message, 'string', 'and a `message`, or both admin decoders print "undefined"');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM products WHERE composition <> \'\''), 0, 'nothing was written');

  // A DRAFT bundle is not listed and cannot be bought — the same row, two
  // doors, one answer.
  const draft = await json(
    await post(appAs(db, boss), '/api/admin/bundles', {
      name_en: 'Quiet box',
      name_ar: 'صندوق هادئ',
      price_iqd: 50_000,
      status: 'draft',
      components: [{ member_product_id: 'p_nozzle', qty: 1, sort: 0 }],
      config: { price_mode: 'fixed' },
    })
  );
  assert.equal(draft.success, true, JSON.stringify(draft));
  const draftId = String(draft.product.id);
  const listed = await json(await get(appAs(db, buyer), '/api/bundles'));
  assert.equal((listed.bundles as Record<string, unknown>[]).some((b) => b.id === draftId), false);
  const blocked = await post(appAs(db, buyer), '/api/cart/items', { productId: draftId, qty: 1 });
  assert.equal(blocked.status >= 400, true, 'a draft composition row is not purchasable');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0);

  // Publishing it is one call, and it becomes buyable at that instant —
  // through `planProductSave`, the ONE writer of the product tables.
  const published = await json(
    await put(appAs(db, boss), `/api/admin/bundles/${draftId}`, {
      name_en: 'Quiet box',
      name_ar: 'صندوق هادئ',
      price_iqd: 50_000,
      status: 'active',
      components: [{ member_product_id: 'p_nozzle', qty: 1, sort: 0 }],
      config: { price_mode: 'fixed' },
    })
  );
  assert.equal(published.success, true, JSON.stringify(published));
  const nowBuyable = await json(await post(appAs(db, buyer), '/api/cart/items', { productId: draftId, qty: 1 }));
  assert.equal(nowBuyable.success, true, JSON.stringify(nowBuyable));

  // And the OTHER product writers still cannot touch it. The TXT template is
  // the sharpest case: it can still EXPORT a bundle — and §1.2 pins what it
  // writes, because `sale_types = ["bundle","pre_order"]` would otherwise
  // export the word `mixed`, which describes no bundle at all — while
  // `planProductSave` refuses to apply one back, so
  // `worker/lib/productPersistence.ts` stays the single writer
  // (docs/TXT_IMPORT_PARITY.md §5.1, §15.1 rule 12).
  const exported = await get(appAs(db, boss), `/api/admin/template/export/${draftId}`);
  const text = await exported.text();
  assert.match(text, /^selling_type=bundle$/m);
  const applied = await post(appAs(db, boss), '/api/admin/template/apply', {
    text,
    mode: 'update',
    confirm: true,
  });
  const appliedBody = await json(applied);
  assert.equal(applied.status, 400, JSON.stringify(appliedBody).slice(0, 300));
  assert.equal(appliedBody.code, 'COMPOSITION_NOT_ALLOWED');
});
