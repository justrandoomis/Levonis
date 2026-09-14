/**
 * THE CART HOLDS ONE MAIN ITEM WITH EXPANDABLE CONTENTS — case 10 of the
 * owner's seventeen, docs/BUNDLES_MYSTERY.md §5, run through the REAL routers
 * against real migrations.
 *
 * WHAT EACH GROUP PROVES, AND WHY IT IS WORTH A TEST OF ITS OWN.
 *
 *  - ONE TOP-LEVEL ITEM. A four-component bundle is ONE `items[]` entry with
 *    four entries under `composition.components`, four `cart_bundle_choices`
 *    rows behind it, and a merchandise sum that counts the bundle once. If the
 *    components ever became top-level items the coupon basis would double-count
 *    them and the customer would be charged twice for one box.
 *
 *  - CASE 10b — THE EMPTY SELECTION. A composition line derives an EMPTY
 *    selection: `optionId` AND `optionValueIds`. Blanking only `optionId`
 *    leaves `selectionFromCartRow` rebuilding `['bx_…']` from the legacy
 *    fallback, `resolveCartLine` rebuilding `optionId` from THAT, and
 *    `saleAvailability` pushing `OPTION_NOT_FOUND` into `selection.errors` —
 *    so `refuseIncompleteSelection` throws "Choose a colour before adding this
 *    item (OPTION_NOT_FOUND)" and every bundle checkout fails with VALIDATION.
 *    Both error lists are asserted, because the first one alone passes with the
 *    bug still present.
 *
 *  - LINE IDENTITY. Two adds of the same bundle with the same choices are ONE
 *    line at qty 2; two different colour choices are TWO lines. The key is
 *    server-computed and a client-supplied one is ignored.
 *
 *  - THE CLIENT SENDS NO PRICE. A body carrying a price, a component total, a
 *    saving and a tier is ignored, and the stored line carries the server's
 *    figures.
 *
 *  - THE DOOR REFUSES BY NAME. Membership, schedule, a choice that is not on
 *    the allow-list, a choice for a pinned dimension, the per-order cap and a
 *    bundle that became shipping-mixed after it was saved each produce their
 *    own code — never a silent repair and never a generic 400.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, patch, get, json, all, count, row, type StubUser } from './fixtures/app';
import { cartRoutes, resolveCartBundles, selectionFromCartRow, resolveCartLine, refuseIncompleteSelection } from '../worker/routes/cart';
import { saleAvailability } from '../worker/routes/products';
import { addBundle, seedCatalogue, DEFAULT_COMPONENTS, FUTURE, PAST } from './lib/bundles';

const appFor = (db: unknown, user: StubUser) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
  });
const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };

const cartOf = (raw: DatabaseSync) =>
  all<Record<string, unknown>>(raw, 'SELECT * FROM cart_items ORDER BY rowid');

// ------------------------------------------------- one item, four contents

test('a four-component bundle is ONE cart item with four contents and four stored choices', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    priceIqd: 400_000,
    components: [
      ...DEFAULT_COMPONENTS,
      { id: 'bc_abs', product: 'p_color', qty: 1, colorId: 'pc_black' },
    ],
  });
  const db = asD1(raw);
  const res = await json(await post(appFor(db, buyer), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(res.success, true);

  assert.equal(res.items.length, 1, 'the components must never be top-level cart items');
  const line = res.items[0];
  assert.equal(line.kind, 'bundle');
  assert.equal(line.composition.components.length, 4);
  assert.equal(line.unit_price_iqd, 400_000);
  // The bundle counts ONCE towards merchandise: the coupon basis and the
  // points cap both read this sum.
  const merchandise = res.items.reduce(
    (n: number, it: Record<string, number>) => n + Number(it.unit_price_iqd) * Number(it.qty),
    0
  );
  assert.equal(merchandise, 400_000);

  assert.equal(cartOf(raw).length, 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_bundle_choices'), 4);
  // The components' own value, shown as a standalone figure beside the bundle
  // price — the discount is stated once, on the bundle.
  assert.equal(line.composition.component_total_iqd, 400000 + 25000 * 2 + 5000 + 30000);
  assert.equal(line.composition.bundle_price_iqd, 400_000);
});

test('case 10b — a composition line derives an EMPTY selection, so neither the resolver nor saleAvailability sees OPTION_NOT_FOUND', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter' });
  const db = asD1(raw);
  await post(appFor(db, buyer), '/api/cart/items', { productId: 'prd_b1', qty: 1 });

  // The stored row as the cart and the checkout read it: `p.*` carries
  // `composition`, which is what lets one function decide this.
  const stored = row<Record<string, unknown>>(
    raw,
    `SELECT ci.*, p.* FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = 'buyer'`
  )!;
  assert.match(String(stored.option_id), /^bx_/, 'the composition key rides in option_id');

  const sel = selectionFromCartRow(stored);
  assert.deepEqual(
    { optionId: sel.optionId, optionValueIds: sel.optionValueIds, colorId: sel.colorId },
    { optionId: '', optionValueIds: [], colorId: '' },
    'BOTH optionId and optionValueIds must be empty — blanking one leaves the other carrying bx_…'
  );

  const { doc, resolved } = resolveCartLine(stored, sel, 'free', false, {
    proPolicy: { mode: 'explicit_only', percent: null },
    transportDefaults: [],
    benefitRules: [],
    benefitStatus: null,
    catalogAncestry: null,
    nowIso: '2026-09-14T12:00:00Z',
  });
  assert.deepEqual(resolved.errors, [], 'ResolvedPrice.errors must be empty for a composition line');
  const availability = saleAvailability(doc, {
    optionValueIds: sel.optionValueIds ?? [],
    colorId: sel.colorId || null,
    qty: 1,
    compositionMax: 3,
    compositionModes: ['direct_sale'],
  });
  assert.deepEqual(
    availability.selection.errors,
    [],
    'saleAvailability(...).selection.errors must be empty too — this is the half a partial fix leaves broken'
  );
  assert.equal(availability.selection.complete, true);
  assert.doesNotThrow(() => refuseIncompleteSelection(availability));
});

// ------------------------------------------------------------- identities

test('two adds with the SAME choices merge into one line; two different colours are two lines', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [{ id: 'bc_abs', product: 'p_color', qty: 1, picksColor: true }],
  });
  const db = asD1(raw);
  const app = appFor(db, buyer);
  const black = { productId: 'prd_b1', qty: 1, bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_black' }] };

  await post(app, '/api/cart/items', black);
  await post(app, '/api/cart/items', black);
  let lines = cartOf(raw);
  assert.equal(lines.length, 1, 'identical choices are identical lines');
  assert.equal(lines[0].qty, 2);

  await post(app, '/api/cart/items', {
    productId: 'prd_b1',
    qty: 1,
    bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_white' }],
  });
  lines = cartOf(raw);
  assert.equal(lines.length, 2, 'a different colour choice is a different line');
  assert.notEqual(lines[0].option_id, lines[1].option_id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_bundle_choices'), 2);
});

test('a client-supplied composition key, price or tier is ignored', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000 });
  const db = asD1(raw);
  const res = await json(
    await post(appFor(db, buyer), '/api/cart/items', {
      productId: 'prd_b1',
      qty: 1,
      optionId: 'bx_deadbeefdeadbeef',
      compositionKey: 'bx_deadbeefdeadbeef',
      bundle_price_iqd: 1,
      component_total_iqd: 1,
      saving_percent: 99,
      applied_tier: 'pro',
      discount_iqd: 399_999,
    })
  );
  assert.equal(res.items[0].unit_price_iqd, 400_000);
  assert.equal(res.items[0].composition.applied_tier, 'regular');
  assert.notEqual(cartOf(raw)[0].option_id, 'bx_deadbeefdeadbeef');
});

// ---------------------------------------------------------------- refusals

test('a choice that is not on the allow-list is refused, and a choice for a PINNED dimension is refused', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [
      { id: 'bc_abs', product: 'p_color', qty: 1, picksColor: true, choices: [{ dim: 'color', ref: 'pc_black' }] },
      { id: 'bc_nozzle', product: 'p_nozzle', qty: 1, colorId: '' },
    ],
  });
  const db = asD1(raw);
  const app = appFor(db, buyer);

  const offList = await json(
    await post(app, '/api/cart/items', {
      productId: 'prd_b1',
      qty: 1,
      bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_white' }],
    })
  );
  assert.equal(offList.code, 'BUNDLE_CHOICE_INVALID');

  const pinned = await json(
    await post(app, '/api/cart/items', {
      productId: 'prd_b1',
      qty: 1,
      bundleChoices: [
        { componentId: 'bc_abs', colorId: 'pc_black' },
        { componentId: 'bc_nozzle', colorId: 'pc_black' },
      ],
    })
  );
  assert.equal(pinned.code, 'BUNDLE_CHOICE_NOT_ALLOWED');

  const missing = await json(await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(missing.code, 'BUNDLE_CHOICE_INVALID', 'the server never chooses on the buyer’s behalf');
  assert.equal(cartOf(raw).length, 0, 'a refused add writes nothing');
});

test('a component that does not belong to this bundle is refused as a changed composition', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter' });
  const db = asD1(raw);
  const res = await json(
    await post(appFor(db, buyer), '/api/cart/items', {
      productId: 'prd_b1',
      qty: 1,
      bundleChoices: [{ componentId: 'bc_not_mine', colorId: 'pc_black' }],
    })
  );
  assert.equal(res.code, 'BUNDLE_COMPOSITION_CHANGED');
});

test('a PLUS bundle refuses a free account and admits inherited PREMIUM/PRO members', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', window: { required_tiers: '["plus"]' } });
  const db = asD1(raw);

  const refused = await post(appFor(db, buyer), '/api/cart/items', { productId: 'prd_b1', qty: 1 });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'MEMBERSHIP_REQUIRED');

  // PREMIUM and PRO both inherit PLUS — this is the purchase door agreeing
  // with the canonical matrix rather than keeping its own tier policy.
  const pro = await json(
    await post(appFor(db, { id: 'u_pro', role: 'customer', email: 'r@x.co' }), '/api/cart/items', {
      productId: 'prd_b1',
      qty: 1,
    })
  );
  assert.equal(pro.success, true);
  const prime = await json(
    await post(appFor(db, { id: 'u_prime', role: 'customer', email: 'n@x.co' }), '/api/cart/items', {
      productId: 'prd_b1',
      qty: 1,
    })
  );
  assert.equal(prime.success, true);
});

test('an expired window and an unopened one are refused by their own codes', async () => {
  const raw = seedCatalogue();
  // Two bundles in one database, so their component ids must differ — the
  // surrogate `bundle_components.id` is a real primary key, not a label.
  addBundle(raw, {
    id: 'prd_ended',
    slug: 'ended',
    window: { ends_at: PAST },
    components: [{ id: 'bc_e1', product: 'p_nozzle', qty: 1 }],
  });
  addBundle(raw, {
    id: 'prd_soon',
    slug: 'soon',
    window: { starts_at: FUTURE },
    components: [{ id: 'bc_s1', product: 'p_nozzle', qty: 1 }],
  });
  const db = asD1(raw);
  const app = appFor(db, buyer);
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'prd_ended', qty: 1 }))).code, 'OFFER_WINDOW_EXPIRED');
  assert.equal((await json(await post(app, '/api/cart/items', { productId: 'prd_soon', qty: 1 }))).code, 'OFFER_WINDOW_NOT_STARTED');
  assert.equal(cartOf(raw).length, 0);
});

test('the per-order cap is REFUSED with its number, never clamped — on the add and on the merge', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', config: { max_qty_per_order: 2 } });
  const db = asD1(raw);
  const app = appFor(db, buyer);

  const over = await json(await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 3 }));
  assert.equal(over.code, 'BUNDLE_QTY_LIMIT');
  assert.equal(over.details.max_qty_per_order, 2);

  await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 2 });
  const merged = await json(await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(merged.code, 'BUNDLE_QTY_LIMIT', 'a merge is an add, and the cap applies to what the line will hold');
  assert.equal(cartOf(raw)[0].qty, 2, 'the refused merge changed nothing');
});

test('case 5 at the door — a bundle that became shipping-mixed after it was saved is refused at add-to-cart', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [
      { id: 'bc_nozzle', product: 'p_nozzle', qty: 1 },
      { id: 'bc_pre', product: 'p_pre', qty: 1 },
    ],
  });
  const db = asD1(raw);
  const res = await json(await post(appFor(db, buyer), '/api/cart/items', { productId: 'prd_b1', qty: 1, transportMethod: 'air' }));
  assert.equal(res.code, 'BUNDLE_SHIPPING_MIXED');
  assert.equal(cartOf(raw).length, 0);
});

test('a pre-order bundle stores the chosen transport on its OWN cart row, and refuses a method a component does not offer', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_pre',
    slug: 'pre',
    components: [
      { id: 'bc_pre', product: 'p_pre', qty: 1 },
      { id: 'bc_pre2', product: 'p_pre2', qty: 1 },
    ],
  });
  const db = asD1(raw);
  const app = appFor(db, buyer);
  // p_pre offers air+sea, p_pre2 offers sea only: air is refused, sea is not.
  assert.equal(
    (await json(await post(app, '/api/cart/items', { productId: 'prd_pre', qty: 1, transportMethod: 'air' }))).code,
    'BUNDLE_SHIPPING_MIXED'
  );
  const ok = await json(await post(app, '/api/cart/items', { productId: 'prd_pre', qty: 1, transportMethod: 'sea' }));
  assert.equal(ok.success, true);
  assert.equal(cartOf(raw)[0].transport_method, 'sea', 'cartShippingType and the mixed-cart guard read this column');
  assert.equal(ok.shipping_type ?? ok.items[0].transport_method, 'sea');
});

test('an optional component the buyer declines lowers the price and leaves the order', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    config: { price_mode: 'discount_percent', discount_percent: 10 },
    components: [
      { id: 'bc_nozzle', product: 'p_nozzle', qty: 1 },
      { id: 'bc_pla', product: 'p_pla', qty: 1, optional: true },
    ],
  });
  const db = asD1(raw);
  const res = await json(
    await post(appFor(db, buyer), '/api/cart/items', {
      productId: 'prd_b1',
      qty: 1,
      bundleChoices: [{ componentId: 'bc_pla', included: false }],
    })
  );
  assert.equal(res.success, true);
  const line = res.items[0];
  assert.equal(line.composition.component_total_iqd, 5000, 'a declined component is worth nothing to the total');
  assert.equal(line.unit_price_iqd, 4500);
  assert.equal(
    row<{ included: number }>(raw, "SELECT included FROM cart_bundle_choices WHERE component_id = 'bc_pla'")!.included,
    0
  );
});

test('a required component cannot be declined', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter' });
  const db = asD1(raw);
  const res = await json(
    await post(appFor(db, buyer), '/api/cart/items', {
      productId: 'prd_b1',
      qty: 1,
      bundleChoices: [{ componentId: 'bc_pla', included: false }],
    })
  );
  assert.equal(res.code, 'BUNDLE_CHOICE_NOT_ALLOWED');
});

// ------------------------------------------------------------------ PATCH

test('PATCH refuses a quantity above the cap and above the scarcest component, and never clamps', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', config: { max_qty_per_order: 9 } });
  const db = asD1(raw);
  const app = appFor(db, buyer);
  const added = await json(await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  const lineId = added.items[0].id as string;

  const over = await json(await patch(app, `/api/cart/items/${lineId}`, { qty: 9 }));
  // The owner's example: printer 5, PLA 6 needing 2, nozzle 20 → 3 bundles.
  assert.equal(over.code, 'QTY_UNAVAILABLE');
  assert.equal(over.details.available, 3);
  assert.equal(cartOf(raw)[0].qty, 1, 'the refused edit changed nothing');

  const ok = await json(await patch(app, `/api/cart/items/${lineId}`, { qty: 3 }));
  assert.equal(ok.success, true);
  assert.equal(cartOf(raw)[0].qty, 3);
  assert.equal(ok.items[0].composition.max_qty, 3);
});

test('a PATCH that changes a choice onto an existing twin merges the two lines and says so', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [{ id: 'bc_abs', product: 'p_color', qty: 1, picksColor: true }],
  });
  const db = asD1(raw);
  const app = appFor(db, buyer);
  const black = await json(
    await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 1, bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_black' }] })
  );
  const white = await json(
    await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 1, bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_white' }] })
  );
  assert.equal(cartOf(raw).length, 2);
  const whiteId = (white.items as Array<Record<string, unknown>>).find(
    (it) => !black.items.some((b: Record<string, unknown>) => b.id === it.id)
  )!.id as string;

  const res = await json(
    await patch(app, `/api/cart/items/${whiteId}`, { bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_black' }] })
  );
  assert.equal(res.success, true);
  assert.ok(res.merged_into, 'the response says the line was merged');
  assert.equal(cartOf(raw).length, 1);
  assert.equal(cartOf(raw)[0].qty, 2);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_bundle_choices'), 1);
});

// --------------------------------------------------- the resolution itself

test('resolveCartBundles keys by CART LINE, so two lines of one bundle keep their own components', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    components: [{ id: 'bc_abs', product: 'p_color', qty: 1, picksColor: true }],
  });
  const db = asD1(raw);
  const app = appFor(db, buyer);
  await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 1, bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_black' }] });
  await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 1, bundleChoices: [{ componentId: 'bc_abs', colorId: 'pc_white' }] });

  const rows = all<Record<string, unknown>>(
    raw,
    `SELECT ci.id AS cart_item_id, ci.qty, p.* FROM cart_items ci JOIN products p ON p.id = ci.product_id`
  );
  const resolved = await resolveCartBundles(db, rows, 'free', false, {
    proPolicy: { mode: 'explicit_only', percent: null },
    transportDefaults: [],
    benefitRules: [],
    benefitStatus: null,
    catalogAncestry: null,
    nowIso: '2026-09-14T12:00:00Z',
  }, null);
  assert.equal(resolved.size, 2);
  const colours = [...resolved.values()].map((b) => b.components[0].selection.color_id).sort();
  assert.deepEqual(colours, ['pc_black', 'pc_white']);
});

test('GET /api/cart renders the bundle as one expandable line with no per-component stock count', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter' });
  const db = asD1(raw);
  const app = appFor(db, buyer);
  await post(app, '/api/cart/items', { productId: 'prd_b1', qty: 1 });

  const res = await json(await get(app, '/api/cart'));
  assert.equal(res.items.length, 1);
  const line = res.items[0];
  assert.equal(line.composition.components.length, 3);
  for (const k of line.composition.components) {
    assert.equal(typeof k.availability.state, 'string');
    assert.equal((k as Record<string, unknown>).available, undefined, 'no per-component count crosses the boundary');
    assert.equal((k as Record<string, unknown>).stock, undefined);
  }
  const body = JSON.stringify(res);
  assert.ok(!body.includes('"blocking"'), 'blocking[] carries real per-row stock numbers and stays on the server');
});
