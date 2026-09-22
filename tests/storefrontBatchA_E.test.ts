/**
 * FIVE STOREFRONT REPORTS FROM ONE MESSAGE, PINNED.
 *
 * They are unrelated to each other and they are together here because they
 * arrived together and every one of them is a JOIN between two files — a type
 * and its renderer, a helper and its call site, a setting and the card that
 * reads it. Each is the kind of thing a rename quietly undoes.
 *
 *   A  «اجعل المستخدم يسحب البراندات scroll horizontal ليس فقط ان يتوقف»
 *   B  «في bloub … ٣ مرات او اكثر يفتح /support»
 *   C1 «عند اختيار من الغرامات اختيار الماده اجعلها بالانجليزي»
 *   D  «بدل عرض كلمة محسوب حسب القطع بالكمية … عرض مكان المخزن على الخريطة»
 *   E  «يجب أن يظهر هناك العدد في السلة مع زر عرض السلة»
 *
 * There is no browser DOM runner here, so the markup contracts are asserted
 * against the source the way tests/uiSystem.test.ts does; the arithmetic that
 * CAN be executed (the marquee wrap, the tap window) is stated as the exact
 * expression, because an approximation of it would pass while the belt
 * stuttered and the shortcut fired on three separate visits.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ------------------------------------------------------------------- B: bloub

test('three rapid taps on the bloub open the support chat; one and two are Home', () => {
  const nav = read('src/components/BottomNav.tsx');
  assert.match(nav, /const BLOUB_TAPS_FOR_SUPPORT = 3;/, 'the third tap is the one that diverts');
  assert.match(nav, /const BLOUB_MULTI_TAP_MS = 700;/);
  assert.match(nav, /navigate\('\/support'\)/);
  // A <Link to="/"> stays a real link — middle-click, open-in-new-tab and the
  // screen reader's "link, Home" are all still true. The shortcut works by
  // cancelling the navigation, not by replacing the element with a button.
  assert.match(nav, /to="\/"/);
  assert.match(nav, /e\.preventDefault\(\);/);
});

test('the shortcut is RAPID taps, not three visits to Home over an afternoon', () => {
  const nav = read('src/components/BottomNav.tsx');
  // The gap between consecutive taps, not a count since mount: without the
  // window, a customer who pressed Home three times in a session would land in
  // the support chat with no idea why.
  assert.match(nav, /run\.count = now - run\.at <= BLOUB_MULTI_TAP_MS \? run\.count \+ 1 : 1;/);
  // And the run ends when it fires, so a fourth and fifth tap do not
  // re-navigate to the page the customer is already standing on.
  const at = nav.indexOf('if (run.count >= BLOUB_TAPS_FOR_SUPPORT)');
  assert.ok(at > 0);
  const body = nav.slice(at, at + 400);
  assert.ok(body.includes('run.count = 0;') && body.includes('run.at = 0;'), 'the run resets');
});

// ------------------------------------------------------- C1: material names

test('a material is named in English in every language, in BOTH quote flows', () => {
  /**
   * A material name is an identifier — «PLA Matte», «PETG-CF», «ASA». It is
   * what is printed on the spool, what the slicer profile is named after and
   * what the shop sells, and it is the same string in every language. This is
   * the rule already applied to product names; an Arabic rendering is a second
   * name for one thing, and the customer cannot then match what they chose
   * here against what they are buying.
   */
  for (const rel of ['src/pages/Tools.tsx', 'src/components/tools/GramsQuotePanel.tsx']) {
    const src = read(rel);
    assert.ok(
      !/name_ar \|\| m\.name|m\.name_ar \? m\.name_ar/.test(src),
      `${rel} still prefers an Arabic material name`
    );
    assert.match(src, /m\.name \|\| m\.material_type/, `${rel} falls back to the TYPE, never to a blank`);
  }
});

// ------------------------------------------------------------ D: pickup map

test('a pickup card offers the map instead of a sentence about a fee it does not charge', () => {
  const checkout = read('src/pages/Checkout.tsx');
  const at = checkout.indexOf('data-pickup-map');
  assert.ok(at > 0, 'the link exists');
  const around = checkout.slice(at - 900, at + 900);
  assert.ok(around.includes('pickupMapUrl ?'), 'drawn only when the owner configured one');
  assert.ok(around.includes('target="_blank"') && around.includes('rel="noopener noreferrer"'));
  // It sits inside the <label> for the radio: without this, tapping the map
  // would also change the delivery method.
  assert.ok(around.includes('onClick={(e) => e.stopPropagation()}'));
  // «محسوب حسب القطع والكمية» is a sentence about a FEE, so it is no longer
  // printed on a method that has none.
  assert.ok(around.includes('!isPickupMethod'), 'the fee line is gone from the pickup card');
});

test('"is this a pickup" is the method’s own flag, not a hardcoded id', () => {
  const checkout = read('src/pages/Checkout.tsx');
  assert.match(
    checkout,
    /typeof method\.home_delivery === 'boolean' \? !method\.home_delivery : method\.id === 'pickup'/,
    'a bare id test breaks the day the owner adds «استلام من الفرع الثاني»'
  );
});

test('nothing invents an address, and the owner has somewhere to put the real one', () => {
  // The shop's address is not something this repository knows. A guessed pin
  // sends customers to a place that does not exist, so the link is a stored
  // setting on the METHOD — a shop with two pickup points gives each its own.
  assert.match(read('worker/lib/settings.ts'), /map_url\?: string;/, 'the server type carries it');
  assert.match(read('src/lib/api.ts'), /map_url\?: string;/, 'and so does the client one');
  const admin = read('src/components/AdminStoreSettings.tsx');
  assert.match(admin, /placeholder="Map link \(pickup only, optional\)"/, 'and there is a field for it');
  assert.match(admin, /map_url: \(r\.value\.map_url \|\| ''\)\.trim\(\)/, 'whitespace is not a configured link');
  // Never embedded: an iframe would put a third party's script inside the
  // checkout, which the CSP refuses and which nothing here needs.
  assert.ok(!/<iframe[^>]*map/i.test(read('src/pages/Checkout.tsx')));
});

// -------------------------------------------------------- E: the in-cart note

test('the count is about THIS selection, not this product', () => {
  const product = read('src/pages/Product.tsx');
  const at = product.indexOf('const inCartQty = useMemo(');
  assert.ok(at > 0);
  const body = product.slice(at, at + 900);
  // The same identity the server upserts a line on: product + full selection +
  // colour. Counting by product alone would tell a customer choosing white
  // that they already have two, when the two are black.
  assert.ok(body.includes('line.productId !== product.id'));
  assert.ok(body.includes("(line.color_id || '') !== (colorId || '')"));
  assert.ok(body.includes('[...ids].sort().join'), 'group order is the admin’s, not the customer’s');
  assert.ok(body.includes('legacy'), 'and a line written before option_value_ids still matches');
});

test('the note is above the quantity, on both the desktop panel and the phone bar', () => {
  const product = read('src/pages/Product.tsx');
  assert.equal(
    product.split('data-in-cart-note').length - 1,
    1,
    'one note component, rendered in both places — not two copies to drift apart'
  );
  // Desktop: inside qtyControl, before the stepper row.
  const qty = product.indexOf('const qtyControl = (');
  assert.ok(qty > 0);
  assert.ok(product.slice(qty, qty + 300).includes('{inCartNote}'), 'above the stepper');
  // Phone: the bar is the only place a quantity decision is made below `lg`.
  assert.match(product, /\{!notice \? <div className="mx-auto w-full max-w-\[640px\]">\{inCartNote\}<\/div> : null\}/);
});

test('it comes from the server’s cart and is refreshed by the add that changed it', () => {
  const product = read('src/pages/Product.tsx');
  assert.match(product, /api\s*\n?\s*\.get<\{ items: CartItem\[\] \}>\('\/api\/cart'\)/, 'one read, for a signed-in visitor');
  assert.match(product, /if \(!isAuthenticated \|\| !product\?\.id\) return;/, 'and never for a guest');
  // The add response IS the saved cart, so the note updates from the same
  // answer that proved the add worked — no second request, and no window in
  // which the badge and the note disagree.
  const at = product.indexOf('const count = countCartItems(data.items);');
  assert.ok(at > 0);
  assert.ok(product.slice(at, at + 300).includes('setCartLines('));
  // A failed read leaves no note rather than a made-up number — the same rule
  // the nav badge follows.
  assert.match(product, /no note rather than a made-up one/);
});

test('every language has the sentence, and the button is the existing one', () => {
  const product = read('src/pages/Product.tsx');
  assert.equal(product.split('inCart: (n: number) =>').length - 1, 3, 'ar, en and ckb');
  const at = product.indexOf('data-in-cart-note');
  assert.ok(product.slice(at, at + 600).includes('{s.viewCart}'), '«عرض السلة» is the string that already exists');
});
