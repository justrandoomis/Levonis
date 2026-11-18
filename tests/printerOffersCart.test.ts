/**
 * «خصص طابعتك», PHASE 4 — THE BUYING PATH IN THE CART (DECISIONS row 355; 0242):
 * the kits endpoint's three answers, kit colours the customer picks (or «random»,
 * picked by the system), the owner's discount inside the unit price, the printer
 * add-ons (their own lines, deletable, following the printer), and their refusals.
 *
 * Fixture: tests/fixtures/printerOffers.ts (a real SQLite with every migration, the real routes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDON_NOZZLE, KIT_COLOUR, addPrinter, appAs, attachedRows, del, get, json, liveConfig, orderBody, patch, post, printerId, put, setConfig, setup, smart,
  type Json,
} from './fixtures/printerOffers';
import { pickRandomColour } from '../worker/lib/printerOffers';

const kitsOf = async (db: D1Database, query = 'qty=1&fulfillmentType=direct_sale') => json(await get(appAs(db, null), `/api/products/a1-printer/kits?${query}`));
const cartOf = async (a: ReturnType<typeof appAs>) => json(await get(a, '/api/cart'));
const line = (cart: Json, productId: string, key: 'kit_line' | 'addon_line') =>
  cart.items.find((i: Json) => i.productId === productId && i[key]);

test('pickRandomColour: cheapest, then most free stock, then the colour order, then the id', () => {
  assert.equal(pickRandomColour([]), null);
  assert.equal(pickRandomColour([{ id: 'b', unit_iqd: 2, free: 1, sort: 0 }, { id: 'a', unit_iqd: 1, free: 0, sort: 9 }]), 'a');
  assert.equal(pickRandomColour([{ id: 'b', unit_iqd: 1, free: 3, sort: 0 }, { id: 'a', unit_iqd: 1, free: 9, sort: 9 }]), 'a');
  assert.equal(pickRandomColour([{ id: 'b', unit_iqd: 1, free: 9, sort: 1 }, { id: 'a', unit_iqd: 1, free: 9, sort: 2 }]), 'b');
  assert.equal(pickRandomColour([{ id: 'b', unit_iqd: 1, free: Infinity, sort: 1 }, { id: 'a', unit_iqd: 1, free: Infinity, sort: 1 }]), 'a');
});

test('kits endpoint: {kits, addons, store_bundles}; before / after per item and per printer; colours with «random»', async () => {
  const { db } = setup();
  const body = await kitsOf(db, 'qty=2&fulfillmentType=direct_sale');
  assert.deepEqual(Object.keys(body).sort(), ['addons', 'kits', 'store_bundles', 'success']);
  assert.deepEqual(body.store_bundles, []);
  const fixed = body.kits.find((k: Json) => k.id === 'a1-starter');
  assert.deepEqual(
    [fixed.available, fixed.before_per_printer_iqd, fixed.price_per_printer_iqd, fixed.discount_per_printer_iqd, fixed.total_iqd, fixed.before_total_iqd, fixed.discount_iqd],
    [true, 50_000, 45_000, 5_000, 90_000, 100_000, 10_000]
  );
  assert.deepEqual([fixed.items[0].before_unit_price_iqd, fixed.items[0].unit_price_iqd, fixed.items[0].discount_unit_iqd, fixed.items[0].color_mode], [25_000, 22_500, 2_500, 'fixed']);
  assert.deepEqual(fixed.discount, { mode: 'percent', value: 10 });

  const colour = body.kits.find((k: Json) => k.id === 'a1-colour');
  const petg = colour.items.find((i: Json) => i.product_id === 'p_petg');
  assert.equal(petg.color_mode, 'customer');
  // Two printers → two PETG: red (3) and black/blue (10) can serve, white is sold out.
  assert.deepEqual(petg.colors.map((x: Json) => [x.id, x.available]), [['c_red', true], ['c_black', true], ['c_white', false], ['c_blue', true]]);
  // Same price everywhere: the most free stock wins, then the colour order (black before blue).
  assert.deepEqual([petg.random.available, petg.random.color_id, petg.chosen, petg.color_id], [true, 'c_black', 'random', 'c_black']);
  // 5,000 per printer split over its 2 spools: 2,500 off each.
  assert.deepEqual([petg.before_unit_price_iqd, petg.unit_price_iqd, petg.colors[0].unit_price_iqd], [30_000, 27_500, 27_500]);
  assert.deepEqual([colour.before_per_printer_iqd, colour.price_per_printer_iqd, colour.discount_iqd], [55_000, 50_000, 10_000]);

  const nozzle = body.addons.find((x: Json) => x.id === 'nozzle');
  assert.deepEqual(
    [nozzle.qty_per_printer, nozzle.qty, nozzle.before_unit_price_iqd, nozzle.unit_price_iqd, nozzle.before_total_iqd, nozzle.total_iqd, nozzle.title.ar],
    [1, 2, 10_000, 8_000, 20_000, 16_000, 'فوهة 0.4']
  );
  assert.ok(body.addons.find((x: Json) => x.id === 'petg-extra').colors.length === 4);

  // A chosen colour: priced on it; a sold-out one makes the kit unavailable with its own reason.
  const chosen = await kitsOf(db, 'qty=1&fulfillmentType=direct_sale&colors=p_petg:c_red');
  const red = chosen.kits.find((k: Json) => k.id === 'a1-colour').items.find((i: Json) => i.product_id === 'p_petg');
  assert.deepEqual([red.chosen, red.color_id, red.available], ['chosen', 'c_red', true]);
  const white = (await kitsOf(db, 'qty=1&fulfillmentType=direct_sale&colors=p_petg:c_white')).kits.find((k: Json) => k.id === 'a1-colour');
  assert.deepEqual([white.available, white.items.find((i: Json) => i.product_id === 'p_petg').reason], [false, 'KIT_COLOR_UNAVAILABLE']);
  // A product that is not an enrolled printer: three empty arrays.
  const notPrinter = await json(await get(appAs(db, null), '/api/products/pla-basic/kits'));
  assert.deepEqual([notPrinter.kits, notPrinter.addons, notPrinter.store_bundles], [[], [], []]);
});

test('cart: a chosen kit colour is stored as chosen, priced after the discount; a sold-out or unknown colour is refused, nothing written', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  const sold = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), kitId: 'a1-colour', kitColors: { p_petg: 'c_white' } }));
  assert.equal(sold.code, 'KIT_COLOR_UNAVAILABLE', JSON.stringify(sold));
  assert.deepEqual([sold.details.kit_id, sold.details.product_id, sold.details.color_id, sold.details.reason], ['a1-colour', 'p_petg', 'c_white', 'SOLD_OUT']);
  const unknown = await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), kitId: 'a1-colour', kitColors: { p_petg: 'c_nope' } }));
  assert.deepEqual([unknown.code, unknown.details.reason], ['KIT_COLOR_UNAVAILABLE', 'NOT_A_COLOUR']);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE user_id = 'buyer'").get()!.n, 0, 'nothing written');

  await addPrinter(a, { kitId: 'a1-colour', kitColors: { p_petg: 'c_red' } });
  const rows = attachedRows(raw);
  const petgRow = rows.find((r) => r.product_id === 'p_petg')!;
  assert.deepEqual([petgRow.color_id, petgRow.kit_color_mode, petgRow.kit_id, petgRow.addon_id], ['c_red', 'chosen', 'a1-colour', null]);
  assert.equal(rows.find((r) => r.product_id === 'p_pla')!.kit_color_mode, '', 'a fixed item writes no colour mode');
  const cart = await cartOf(a);
  const petg = line(cart, 'p_petg', 'kit_line');
  assert.deepEqual([petg.unit_price_iqd, petg.kit_line.color_mode, petg.kit_line.printer_discount], [27_500, 'chosen', { before_unit_iqd: 30_000, discount_unit_iqd: 2_500 }]);
  assert.equal(petg.breakdown.offer_before_iqd, 30_000, 'struck like an offer line');
  assert.equal(petg.unit_price_usd_cents, undefined, 'no dollar twin on a discounted line');
  const printer = cart.items.find((i: Json) => i.productId === 'p_a1');
  assert.deepEqual([printer.kit.kit_id, printer.kit.total_iqd, printer.kit.before_iqd, printer.kit.discount_iqd, printer.kit.current], ['a1-colour', 50_000, 55_000, 5_000, true]);
});

test('cart: «random» picks for the customer and is reserved like any colour; GET re-picks in memory when it sells out, never writing', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  await addPrinter(a, { kitId: 'a1-colour' });
  const petgRow = () => attachedRows(raw).find((r) => r.product_id === 'p_petg')!;
  assert.deepEqual([petgRow().color_id, petgRow().kit_color_mode], ['c_black', 'random']);
  // Black sells out: the cart shows the system's next pick (blue), the row still says black.
  raw.prepare("UPDATE product_colors SET stock = 0 WHERE id = 'c_black'").run();
  const cart = await cartOf(a);
  const petg = line(cart, 'p_petg', 'kit_line');
  assert.deepEqual([petg.color_id, petg.kit_line.color_mode], ['c_blue', 'random']);
  assert.equal(petgRow().color_id, 'c_black', 'GET wrote nothing');
  // A colour the customer CHOSE is never swapped: it is shown as it is (and the checkout refuses it).
  await put(a, `/api/cart/items/${printerId(raw)}/extras`, { kitColors: { p_petg: 'c_red' } });
  assert.deepEqual([petgRow().color_id, petgRow().kit_color_mode], ['c_red', 'chosen']);
  raw.prepare("UPDATE product_colors SET stock = 0 WHERE id = 'c_red'").run();
  assert.equal(line(await cartOf(a), 'p_petg', 'kit_line').color_id, 'c_red');
  // «اجعله لوناً عشوائياً»: colours alone re-choose the current kit; the fixed item is untouched.
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { kitColors: { p_petg: 'random' } })).status, 200);
  assert.deepEqual([petgRow().color_id, petgRow().kit_color_mode, petgRow().kit_id], ['c_blue', 'random', 'a1-colour']);
});

test('add-ons: their own lines under the printer, deletable alone, locked for PATCH, following the printer; a kit change leaves them', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  assert.equal((await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), addonIds: ['nope'] }))).code, 'ADDON_NOT_OFFERED');
  assert.equal((await json(await post(a, '/api/cart/items', { productId: 'p_a1', qty: 1, services: smart(), addonIds: ['nozzle', 'nozzle'] }))).code, 'VALIDATION');
  await addPrinter(a, { kitId: 'a1-starter', addonIds: ['nozzle', 'petg-extra'], addonColors: { 'petg-extra': 'c_blue' } });
  const addons = () => attachedRows(raw).filter((r) => r.addon_id);
  assert.deepEqual(addons().map((r) => [r.addon_id, r.product_id, r.qty, r.kit_unit_qty, r.kit_color_mode, r.color_id, r.kit_id]),
    [['nozzle', 'p_nozzle', 1, 1, '', '', null], ['petg-extra', 'p_petg', 1, 1, 'chosen', 'c_blue', null]]);
  assert.equal(addons()[0].shipping_method_id, `addon:${printerId(raw)}:nozzle`);
  const cart = await cartOf(a);
  const nozzle = line(cart, 'p_nozzle', 'addon_line');
  assert.deepEqual(nozzle.addon_line, { printer_cart_item_id: printerId(raw), addon_id: 'nozzle', qty_per_printer: 1, color_mode: 'fixed', printer_discount: { before_unit_iqd: 10_000, discount_unit_iqd: 2_000 } });
  assert.equal(nozzle.unit_price_iqd, 8_000);
  const printer = cart.items.find((i: Json) => i.productId === 'p_a1');
  assert.deepEqual(printer.addons.map((x: Json) => [x.addon_id, x.total_iqd, x.before_iqd, x.discount_iqd, x.current]), [['nozzle', 8_000, 10_000, 2_000, true], ['petg-extra', 30_000, 30_000, 0, true]]);
  assert.deepEqual([printer.kit.kit_id, printer.kit.line_ids.length], ['a1-starter', 1], 'the kit groups its own lines only');

  // The printer's quantity moves them; a kit change does not touch them.
  assert.equal((await patch(a, `/api/cart/items/${printerId(raw)}`, { qty: 2 })).status, 200);
  assert.deepEqual(addons().map((r) => r.qty), [2, 2]);
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { kitId: 'a1-colour' })).status, 200);
  assert.equal(addons().length, 2, 'choosing another kit leaves the add-ons');
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { kitId: null })).status, 200);
  assert.equal(addons().length, 2, 'removing the kit leaves the add-ons');
  // Locked for PATCH; DELETE removes one add-on alone.
  assert.equal((await json(await patch(a, `/api/cart/items/${addons()[0].id}`, { qty: 1 }))).code, 'KIT_LINE_LOCKED');
  assert.equal((await del(a, `/api/cart/items/${addons()[0].id}`)).status, 200);
  assert.deepEqual(addons().map((r) => r.addon_id), ['petg-extra']);
  // addonIds [] removes the rest; the printer's removal takes every attached line.
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { kitId: 'a1-starter', addonIds: ['nozzle'] })).status, 200);
  assert.deepEqual(addons().map((r) => r.addon_id), ['nozzle']);
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: [] })).status, 200);
  assert.equal(addons().length, 0);
  assert.equal(attachedRows(raw).length, 1, 'the kit stays');
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: ['nozzle'] })).status, 200);
  assert.equal((await del(a, `/api/cart/items/${printerId(raw)}`)).status, 200);
  assert.equal(attachedRows(raw).length, 0, 'every attached line left with its printer');
});

test('add-ons at checkout: ticking the printer ticks them; one without its printer, or one the owner changed, is refused', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  await addPrinter(a, { addonIds: ['nozzle'] });
  const addonId = String(attachedRows(raw)[0].id);
  assert.equal((await json(await post(a, '/api/orders/quote', orderBody({ itemIds: [addonId] })))).code, 'ADDON_WITHOUT_PRINTER');
  const q = (await json(await post(a, '/api/orders/quote', orderBody({ itemIds: [printerId(raw)] })))).quote;
  const nozzle = q.lines.find((l: Json) => l.product_id === 'p_nozzle');
  assert.deepEqual(nozzle.addon_line, { printer_cart_item_id: printerId(raw), addon_id: 'nozzle', qty_per_printer: 1, color_mode: 'fixed', printer_discount: { before_unit_iqd: 10_000, discount_unit_iqd: 2_000 } });
  assert.equal(q.printer_discount_iqd, 2_000);
  // The owner changes the add-on's count: the cart's line no longer matches it.
  setConfig(raw, liveConfig({ addons: [{ ...ADDON_NOZZLE, qty: 2 }] }));
  const changed = await json(await post(a, '/api/orders/quote', orderBody()));
  assert.deepEqual([changed.code, changed.details.addon_id, changed.details.cart_item_id], ['ADDON_CHANGED', 'nozzle', printerId(raw)]);
  assert.equal((await cartOf(a)).items.find((i: Json) => i.productId === 'p_a1').addons[0].current, false);
  // …or withdraws it.
  setConfig(raw, liveConfig({ addons: [] }));
  assert.equal((await json(await post(a, '/api/orders/quote', orderBody()))).code, 'ADDON_CHANGED');
});

test('kits: a customer-colour kit matches in any colour; the kit lines PATCH/DELETE stay locked', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  await addPrinter(a, { kitId: 'a1-colour', kitColors: { p_petg: 'c_red' } });
  const q = await json(await post(a, '/api/orders/quote', orderBody()));
  assert.equal(q.success, true, JSON.stringify(q));
  const petg = q.quote.lines.find((l: Json) => l.product_id === 'p_petg');
  assert.deepEqual([petg.unit_price_iqd, petg.kit_line.color_mode, petg.kit_line.kit_id], [27_500, 'chosen', 'a1-colour']);
  const kitLine = attachedRows(raw).find((r) => r.product_id === 'p_petg')!;
  assert.equal((await json(await patch(a, `/api/cart/items/${kitLine.id}`, { qty: 3 }))).code, 'KIT_LINE_LOCKED');
  assert.equal((await json(await del(a, `/api/cart/items/${kitLine.id}`))).code, 'KIT_LINE_LOCKED');
  // A kit whose customer-colour item became fixed no longer matches → KIT_CHANGED.
  setConfig(raw, liveConfig({ kits: [{ ...KIT_COLOUR, items: [{ ...KIT_COLOUR.items[0], color_mode: 'fixed', color_id: 'c_black' }, KIT_COLOUR.items[1]] }] }));
  assert.equal((await json(await post(a, '/api/orders/quote', orderBody()))).code, 'KIT_CHANGED');
});

test('add-ons: removing one leaves the others exactly as they are — the same line, its chosen colour and who chose it', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  await addPrinter(a, { addonIds: ['nozzle', 'petg-extra'], addonColors: { 'petg-extra': 'c_red' } });
  const petg = () => attachedRows(raw).find((r) => r.addon_id === 'petg-extra')!;
  const before = petg();
  assert.deepEqual([before.color_id, before.kit_color_mode], ['c_red', 'chosen']);
  // Removing the nozzle names only what is left, with no colour: the PETG is not re-planned (no random colour).
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: ['petg-extra'] })).status, 200);
  assert.deepEqual(attachedRows(raw).map((r) => r.addon_id), ['petg-extra']);
  assert.deepEqual([petg().id, petg().color_id, petg().kit_color_mode], [before.id, 'c_red', 'chosen']);
  // A random one stays random (and keeps the system's pick) the same way.
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: ['petg-extra', 'nozzle'], addonColors: { 'petg-extra': 'random' } })).status, 200);
  const random = petg();
  assert.equal(random.kit_color_mode, 'random');
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: ['petg-extra'] })).status, 200);
  assert.deepEqual([petg().id, petg().color_id, petg().kit_color_mode], [random.id, random.color_id, 'random']);
  // An explicit colour still re-chooses it.
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: ['petg-extra'], addonColors: { 'petg-extra': 'c_blue' } })).status, 200);
  assert.deepEqual([petg().color_id, petg().kit_color_mode], ['c_blue', 'chosen']);
});

test('add-ons: removing one works while another add-on on the printer has sold out (it is left as it is)', async () => {
  const { db, raw } = setup();
  const a = appAs(db, 'buyer');
  await addPrinter(a, { addonIds: ['nozzle', 'petg-extra'], addonColors: { 'petg-extra': 'c_red' } });
  const petg = () => attachedRows(raw).find((r) => r.addon_id === 'petg-extra')!;
  const before = petg();
  // The chosen red PETG and the nozzle both sell out.
  raw.prepare("UPDATE product_colors SET stock = 0 WHERE id = 'c_red'").run();
  raw.prepare("UPDATE products SET stock = 0 WHERE id = 'p_nozzle'").run();
  const res = await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: ['petg-extra'] });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.deepEqual(attachedRows(raw).map((r) => r.addon_id), ['petg-extra']);
  assert.deepEqual([petg().id, petg().color_id, petg().kit_color_mode], [before.id, 'c_red', 'chosen'], 'never swapped');
  // …and the other way round: a sold-out nozzle (fixed colour) stays when the PETG goes.
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: [] })).status, 200);
  raw.prepare("UPDATE product_colors SET stock = 3 WHERE id = 'c_red'").run();
  raw.prepare("UPDATE products SET stock = 20 WHERE id = 'p_nozzle'").run();
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: ['nozzle', 'petg-extra'], addonColors: { 'petg-extra': 'c_red' } })).status, 200);
  raw.prepare("UPDATE products SET stock = 0 WHERE id = 'p_nozzle'").run();
  const nozzleId = attachedRows(raw).find((r) => r.addon_id === 'nozzle')!.id;
  assert.equal((await put(a, `/api/cart/items/${printerId(raw)}/extras`, { addonIds: ['nozzle'] })).status, 200);
  assert.deepEqual(attachedRows(raw).map((r) => [r.addon_id, r.id]), [['nozzle', nozzleId]]);
});
