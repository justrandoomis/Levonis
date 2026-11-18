/**
 * «خصص طابعتك» phase 4 (0242; DECISIONS row 355) — the customer side: the
 * sheet's kit colours, discounted add-ons and store bundles; the cart's add-on
 * lines under their printer; the order views' badges.
 *
 * Holds: the picks travel in the sheet's `extras` (kitColors / addonIds /
 * addonColors — the product page spreads `extras` into its add body, so no
 * Product.tsx change); the new modules ride the sheet's lazy chunk only; the
 * server's answer (WP-B's final shapes) is read as sent, with before/after
 * from the server and an older answer without add-ons or bundles read as [];
 * every word is written in Arabic, English and Sorani; an add-on line is never
 * grouped with ordinary lines and follows its printer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { attachedPrinterOf, groupCartLines, type GroupableLine } from '../src/lib/cartGroups';
import { OFFER_ERRORS, OFFER_STRINGS } from '../src/components/product/printerOfferStrings';
import { PHASE4_CODES } from '../packages/pricing/src/printerServices';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SHEET = read('src/components/product/CustomizeSheet.tsx');
const ROWS = read('src/components/product/PrinterOffersRows.tsx');
const LINES = read('src/components/cart/PrinterExtrasLines.tsx');

test('the picks travel in the sheet\'s extras, never as services', () => {
  assert.match(ROWS, /export interface OfferExtras extends SelectionExtras \{[\s\S]*kitColors\?: Record<string, string> \| null;[\s\S]*addonIds\?: string\[\] \| null;[\s\S]*addonColors\?: Record<string, string> \| null;/);
  // Colours and add-ons are written into draft.extras …
  assert.match(SHEET, /\{ \.\.\.x, \[field\]: \{ \.\.\.\(x\[field\] \?\? \{\}\), \[key\]: v \} \}/);
  assert.match(SHEET, /\{ \.\.\.x, addonIds: ids\.length \? ids : null \}/);
  // … the applied choice carries them in `extras` (only the colours of what is chosen) …
  assert.match(SHEET, /kitColors: only\(x4\.kitColors,/);
  assert.match(SHEET, /addonColors: only\(x4\.addonColors,/);
  assert.match(SHEET, /const applied: ServiceSelection = \{ \.\.\.asCustom\(draft\), \.\.\.\(extras4 \? \{ extras: extras4 \} : \{\}\), confirmed: true \};/);
  // … and the server's services quote never sees them.
  assert.match(SHEET, /const draftKey = JSON\.stringify\(servicesOnly\(applied\)\);/);
  // The product page spreads every truthy extra into its add body (no Product.tsx change needed).
  assert.match(read('src/pages/Product.tsx'), /for \(const \[k, v\] of Object\.entries\(svc\.extras \?\? \{\}\)\) if \(v\) body\[k\] = v;/);
});

test('the kits endpoint is read with the picked colours, and an older offer without add-ons or bundles is []', () => {
  assert.match(ROWS, /q\.set\('colors', picked\.map\(\(\[p, c\]\) => `\$\{p\}:\$\{c\}`\)\.join\(','\)\)/);
  assert.match(SHEET, /const offerAddons = offer\.addons \?\? \[\];/);
  assert.match(SHEET, /const offerBundles = offer\.store_bundles \?\? \[\];/);
});

test('the store bundle card: no choices → POST /api/cart/items {productId, qty:1} and «✓ أُضيف»; choices → its page; a guest signs in', () => {
  assert.match(ROWS, /api\.post\('\/api\/cart\/items', \{ productId: b\.id, qty: 1 \}\)/);
  assert.match(ROWS, /to=\{`\/bundles\/\$\{encodeURIComponent\(b\.slug\)\}`\}/);
  assert.match(ROWS, /!signedIn \?/);
  assert.equal(OFFER_STRINGS.ar.added, '✓ أُضيف');
});

test('the new modules ride the sheet\'s lazy chunk only', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|mjs)$/.test(name)) continue;
      const rel = relative(ROOT, p).replace(/\\/g, '/');
      const src = readFileSync(p, 'utf8');
      if (/from '\.\/PrinterOffersRows'|PrinterOffersRows'/.test(src) && rel !== 'src/components/product/CustomizeSheet.tsx') offenders.push(`${rel} imports PrinterOffersRows`);
      if (/printerOfferStrings'/.test(src) && !['src/components/product/CustomizeSheet.tsx', 'src/components/product/PrinterOffersRows.tsx'].includes(rel)) offenders.push(`${rel} imports printerOfferStrings`);
    }
  };
  walk(join(ROOT, 'src'));
  assert.deepEqual(offenders, []);
  // No icon of its own (an icon shared by two lazy chunks moves into the product page's opening).
  assert.doesNotMatch(ROWS, /lucide-react/);
  assert.doesNotMatch(LINES, /lucide-react/);
  // Swatches are inline styles, not classes.
  assert.match(ROWS, /style=\{\{ width: 14, height: 14, background: hex \|\| 'transparent' \}\}/);
});

test('every phase-4 word and refusal is in Arabic, English and Sorani (Sorani is not the Arabic copied)', () => {
  const keys = Object.keys(OFFER_STRINGS.ar) as Array<keyof typeof OFFER_STRINGS.ar>;
  for (const k of keys) {
    const a = OFFER_STRINGS.ar[k];
    const e = OFFER_STRINGS.en[k];
    const c = OFFER_STRINGS.ckb[k];
    const say = (v: unknown) => (typeof v === 'function' ? (v as (x: never) => string)(7 as never) : String(v));
    assert.ok(say(a) && say(e) && say(c), k);
    if (k !== 'added') assert.notEqual(say(c), say(a), `${k}: the Sorani is the Arabic copied`);
  }
  for (const code of PHASE4_CODES) {
    const e = OFFER_ERRORS[code];
    assert.ok(e, `${code} has no sheet sentence`);
    assert.ok(e.ar && e.en && e.ckb && e.ckb !== e.ar, code);
  }
  // The cart's own words (PrinterExtrasLines) carry the three languages too.
  for (const word of ['اجعله لوناً عشوائياً', 'Make it a random colour', 'بیکە بە ڕەنگی هەڕەمەکی', 'إزالة الإضافة', 'لابردنی زیادکراوەکە']) assert.ok(LINES.includes(word), word);
});

test('an add-on line is never grouped and follows its printer', () => {
  const colours = [{ id: 'black' }, { id: 'white' }];
  const base = (id: string, over: Partial<GroupableLine> = {}): GroupableLine => ({ id, productId: 'p_nozzle', colors: colours, color_id: 'black', ...over });
  const items = [
    base('a'),
    base('b', { color_id: 'white' }),
    base('c', { addon_line: { printer_cart_item_id: 'printer1', addon_id: 'nozzle04', qty_per_printer: 1 } }),
  ];
  const out = groupCartLines(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'group');
  assert.deepEqual(out[1], { kind: 'line', item: items[2] });
  assert.equal(attachedPrinterOf(items[2]), 'printer1');
  assert.equal(attachedPrinterOf({ kit_line: { printer_cart_item_id: 'printer2' } }), 'printer2');
  assert.equal(attachedPrinterOf(items[0]), null);
});

test('the cart: a sold-out chosen colour offers «اجعله لوناً عشوائياً», an add-on has its own remove, before is struck', () => {
  assert.match(LINES, /const colourOut = \(l: KitLineView\) => !!l\.blocked && l\.colorMode === 'chosen' && !!l\.productId;/);
  assert.match(LINES, /action\(w\.makeRandom, onRandomColour \? \(\) => onRandomColour\(l\.productId as string\) : undefined, 'random-colour'\)/);
  assert.match(LINES, /action\(w\.removeAddon, onRemoveAddon \? \(\) => onRemoveAddon\(a\.addon_id\) : undefined, 'remove-addon'\)/);
  // A sold-out chosen ADD-ON colour has the same fix, by add-on id.
  assert.match(LINES, /action\(w\.makeRandom, onRandomAddonColour \? \(\) => onRandomAddonColour\(addonId\) : undefined, 'random-addon-colour'\)/);
  const cart = read('src/pages/Cart.tsx');
  // Removing an add-on deletes its own lines (the others are never re-planned); «random» re-sends the current add-ons.
  assert.match(cart, /for \(const id of lineIds\) applyCartWrite\(await api\.delete<CartWriteResponse>\(`\/api\/cart\/items\/\$\{id\}`\)\)/);
  assert.match(cart, /addonColors: \{ \[addonId\]: 'random' \}/);
  assert.match(LINES, /line-through/);
});

test('the order views: colour mode and «السعر قبل الخصم»', () => {
  const modal = read('src/components/adminOrders/OrderDetailModal.tsx');
  assert.match(modal, /data-order-item-colour-mode="chosen"/);
  assert.match(modal, /data-order-item-colour-mode="random"/);
  assert.match(modal, /loc\('السعر قبل الخصم', 'Price before discount', 'نرخ پێش داشکاندن'\)/);
  const order = read('src/pages/OrderDetail.tsx');
  assert.match(order, /attached\.kit\?\.color_mode \?\? attached\.addon\?\.color_mode/);
  assert.match(order, /if \(!struckShown && pd && pd\.discount_unit_iqd > 0\)/);
});

test('the server\'s answer is read as sent (WP-B final shapes): before/after, colours, random, bundles', async () => {
  const { readOffers, colourProblem } = await import('../src/components/product/PrinterOffersRows');
  const colour = (id: string, available: boolean) => ({ id, name: `C ${id}`, name_ar: `ع ${id}`, name_ku: `ک ${id}`, hex: '#000000', available, unit_price_iqd: 9000, before_unit_price_iqd: 10000 });
  const r = readOffers({
    success: true,
    kits: [{
      id: 'k1', title: { ar: 'باقة', en: 'Kit', ckb: 'پاکێج' }, available: true, discount: { mode: 'percent', value: 10 },
      price_per_printer_iqd: 40500, before_per_printer_iqd: 45000, discount_per_printer_iqd: 4500,
      total_iqd: 81000, before_total_iqd: 90000, discount_iqd: 9000,
      items: [{ product_id: 'p_pla', slug: 'pla', name: 'PLA', name_ar: 'بلا', variant: '', option_value_ids: [], color_id: 'red', color_mode: 'customer', chosen: 'random', qty_per_printer: 2, qty: 4, unit_price_iqd: 9000, before_unit_price_iqd: 10000, discount_unit_iqd: 1000, available: true, reason: null, colors: [colour('red', true), colour('blue', false)], random: { available: true, color_id: 'red', unit_price_iqd: 9000, before_unit_price_iqd: 10000 } }],
    }],
    addons: [{ id: 'nozzle04', title: null, product_id: 'p_noz', slug: 'noz', name: 'Nozzle 0.4', name_ar: 'فوهة 0.4', variant: '', image: '/n.jpg', option_value_ids: [], color_id: null, color_mode: 'fixed', chosen: 'fixed', qty_per_printer: 1, qty: 2, discount: { mode: 'fixed_iqd', value: 2000 }, available: true, reason: null, unit_price_iqd: 8000, before_unit_price_iqd: 10000, discount_unit_iqd: 2000, price_per_printer_iqd: 8000, before_per_printer_iqd: 10000, total_iqd: 16000, before_total_iqd: 20000 }],
    store_bundles: [{ id: 'b1', slug: 'starter', name: 'Starter', name_ar: 'باقة البداية', name_ku: 'پاکێجی دەستپێک', image: '/b.jpg', before_iqd: 50000, after_iqd: 40000, saving_percent: 20, needs_choices: false, available: true }],
  }, 'ckb');
  assert.deepEqual(r.kits[0].money, { before_per: 45000, after_per: 40500, before_total: 90000, after_total: 81000, saving_total: 9000, saving_percent: 10 });
  assert.equal(r.kits[0].colours.length, 1);
  assert.equal(r.kits[0].colours[0].key, 'p_pla');
  assert.equal(r.kits[0].colours[0].colors[0].name, 'ک red');
  assert.equal(r.kits[0].colours[0].random_available, true);
  assert.equal(colourProblem(r.kits[0].colours, null), false, 'absent = random, which can be served');
  assert.equal(colourProblem(r.kits[0].colours, { p_pla: 'blue' }), true, 'a sold-out chosen colour holds the apply');
  assert.equal(colourProblem(r.kits[0].colours, { p_pla: 'red' }), false);
  assert.equal(r.addons[0].title, 'فوهة 0.4', 'a null title is the product name');
  assert.equal(r.addons[0].colour, null, 'a fixed-colour add-on has no chips');
  assert.equal(r.addons[0].money.saving_total, 4000);
  assert.equal(r.addons[0].money.saving_percent, 20);
  assert.deepEqual(r.store_bundles[0], { id: 'b1', slug: 'starter', name: 'پاکێجی دەستپێک', image: '/b.jpg', before_iqd: 50000, after_iqd: 40000, saving_percent: 20, needs_choices: false, available: true });
  // An older answer (kits only) reads as no add-ons and no bundles.
  const old = readOffers({ kits: [] }, 'ar');
  assert.deepEqual([old.addons, old.store_bundles], [[], []]);
});
