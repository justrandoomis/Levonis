/**
 * THE ORDER TYPE DECIDES THE COUNTER — ON THE SCREENS, NOT ONLY IN THE SERVER.
 *
 * 0075 gave a pre-order its own optional capacity and left direct-sale stock
 * exactly where it was: `product_option_values.stock`, the one row
 * `products.inventory_mode` selects. Every defect this file pins is one a
 * route test cannot see and a type error cannot catch, because each is a
 * statement the UI makes about numbers that are correct on the server:
 *
 *  1. AN EMPTY BOX THAT SILENTLY MEANS "UNLIMITED". `capacity` NULL is
 *     untracked and `0` is a tracked counter with nothing left. Those are
 *     different facts with opposite consequences, so the admin states which
 *     one they mean and the number box only exists once they have.
 *  2. A SECOND DIRECT-STOCK FIELD. The direct card edits the MODEL's stock
 *     through the options section's own state — the same number, not a copy —
 *     and the fulfilment payload never carries a direct capacity.
 *  3. A CAPACITY BOX ON A DIRECT-SALE CELL, which the server refuses with
 *     CAPACITY_ON_DIRECT and which the form must therefore never offer.
 *  4. A QUANTITY COPIED ONTO AIR, SEA AND LAND, or a shared-versus-own choice
 *     the admin can only understand by reading a migration.
 *  5. A BROWSER-COMPUTED AVAILABILITY. The storefront and the cart must print
 *     the figure the SERVER resolved for the chosen order type and route —
 *     never the legacy base `stock` column, never two levels added up.
 *
 * Static assertions over the source, in the house pattern of
 * tests/bundleAdminUi.test.ts: there is no browser DOM runner in this repo.
 *
 * Run: npx tsx --test tests/stockByOrderTypeUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const PANEL = 'src/components/adminProducts/FulfillmentPanel.tsx';
const PRODUCT = 'src/pages/Product.tsx';
const CART = 'src/pages/Cart.tsx';
const CHECKOUT = 'src/pages/Checkout.tsx';
/** Every file this change touched, for the sweeps at the bottom. */
const TOUCHED = [PANEL, PRODUCT, CART, CHECKOUT, 'src/components/adminProducts/ProductForm.tsx', 'src/lib/api.ts'];

/** The direct-sale half of a model's card, sliced between its own markers. */
function directCardSource(): string {
  const src = read(PANEL);
  const from = src.indexOf('DIRECT SALE */}');
  const to = src.indexOf('PRE-ORDER */}');
  assert.ok(from > 0 && to > from, 'the panel no longer has one card per order type');
  return src.slice(from, to);
}

// ------------------------------------------------------- the capacity control

test('the pre-order capacity control exists and is bound to the cell’s own field', () => {
  const panel = read(PANEL);
  // The control, addressable and labelled.
  assert.match(panel, /data-capacity-mode=\{m\.id\}/, 'there is no pre-order capacity control at all');
  // It writes `capacity` on the PRE-ORDER cell — the `product_option_fulfillment`
  // column — and on nothing else.
  assert.match(
    panel,
    /update\(m\.id, 'pre_order', \{\s*capacity:/,
    'the capacity control does not write the pre-order cell’s capacity'
  );
  // And the number box is bound to that same field, not to a local mirror.
  assert.match(panel, /value=\{pre\.capacity\}/, 'the units box is not bound to pre.capacity');
  // The payload carries it, so the admin’s number reaches the server.
  assert.match(panel, /capacity: cell\.fulfillment_type === 'pre_order' \? cell\.capacity : null/);
});

test('a route can hold its own quota, bound to the transport row’s own field', () => {
  const panel = read(PANEL);
  assert.match(panel, /data-route-capacity-mode=/, 'a route has no quota control');
  assert.match(
    panel,
    /updateTransport\(m\.id, t\.method, \{\s*capacity:/,
    'the route control does not write the transport row’s capacity'
  );
  assert.match(panel, /value=\{t\.capacity\}/, 'the route units box is not bound to t.capacity');
});

// --------------------------------------------- no capacity on a direct cell

test('a direct-sale cell is never offered a capacity — the server refuses one', () => {
  const direct = directCardSource();
  assert.doesNotMatch(
    direct,
    /capacity/i,
    'the direct-sale card mentions a capacity: a direct sale’s number IS the model’s stock (CAPACITY_ON_DIRECT)'
  );
  const panel = read(PANEL);
  // Nothing anywhere writes a capacity onto the direct cell…
  assert.doesNotMatch(panel, /update\(m\.id, 'direct_sale', \{[^}]*capacity/);
  // …and the save forces it to null even for a cell switched from pre-order.
  assert.match(panel, /capacity: cell\.fulfillment_type === 'pre_order' \? cell\.capacity : null/);
  assert.match(panel, /CAPACITY_ON_DIRECT/, 'the panel does not record WHY it never sends one');
});

test('the direct number is the model’s own stock, edited through the options section’s state', () => {
  const panel = read(PANEL);
  // The panel receives section 5's state and writes the model row THERE.
  assert.match(panel, /setRel: \(fn: \(r: RelationsState\) => RelationsState\) => void/);
  assert.match(panel, /const patchModel = \(optionId: string, patch: Partial<FormValue>\)/);
  assert.match(panel, /patchModel\(m\.id, \{ stock:/, 'the direct card does not set the model’s stock');
  assert.match(
    panel,
    /patchModel\(m\.id, \{ low_stock_threshold:/,
    'the low-stock threshold cannot be set where the direct sale is edited'
  );
  // Writing a stock must re-derive the inventory source exactly as section 5
  // does, or the form claims one level while the rows say another.
  assert.match(panel, /deriveInventoryMode\(next\)/);
  // There is NO second direct-stock field in the payload this panel sends.
  assert.doesNotMatch(panel, /direct_stock|directStock|direct\.stock/);
  // And the call site really hands it that state.
  const form = read('src/components/adminProducts/ProductForm.tsx');
  assert.match(form, /<FulfillmentPanel productId=\{productId\} rel=\{rel\} setRel=\{setRel\} \/>/);
});

// ------------------------------------ untracked is not zero, and says so

test('untracked is a state the admin picks, and it is distinguishable from zero', () => {
  const panel = read(PANEL);
  // Two named states, chosen out loud — not inferred from an empty box.
  assert.match(panel, /<option value="untracked">/, 'untracked is not selectable');
  assert.match(panel, /<option value="tracked">/, 'a set quota is not selectable');
  // NULL-versus-zero, never truthiness: `capacity ? … : …` would read 0 as
  // "untracked" and reopen an exhausted counter.
  assert.match(panel, /pre\.capacity === null \? 'untracked' : 'tracked'/);
  assert.match(panel, /t\.capacity === null \? 'shared' : 'own'/);
  assert.match(panel, /mv\.stock === null \? 'untracked' : 'tracked'/);
  assert.doesNotMatch(panel, /!pre\.capacity|!t\.capacity|capacity \|\|/);
  // The units box can never emit null, so an emptied box is 0 (tracked and
  // empty) rather than a silent "unlimited".
  assert.match(panel, /onChange\(raw === '' \? 0 : Number\(raw\)\)/);
  // And both meanings are written where the admin is choosing between them.
  assert.ok(panel.includes('غير محدودة (غير مُتتبعة)'), 'the untracked state is not named in Arabic');
  assert.ok(panel.includes('Unlimited (untracked)'), 'the untracked state is not named in English');
  assert.ok(panel.includes('0 means none available right now'), 'zero is not explained');
});

// ------------------------------------------- shared versus its own quota

test('the shared-pool versus own-quota choice is explained in the UI, in both languages', () => {
  const panel = read(PANEL);
  assert.match(panel, /<option value="shared">/);
  assert.match(panel, /<option value="own">/);
  // The consequence of each, one short line, Arabic first with the English
  // beside it — so nobody has to read a migration to know what they picked.
  assert.ok(
    panel.includes('بيع وحدة جوًا يُنقص المتاح بحرًا وبرًا — عدّاد واحد مشترك.'),
    'the shared-pool consequence is not stated in Arabic'
  );
  assert.ok(
    panel.includes('Selling one by air leaves one fewer by sea and by land — one shared counter.'),
    'the shared-pool consequence is not stated in English'
  );
  assert.ok(
    panel.includes('هذه الطريقة تملك كميتها ولا تمسّ السعة المشتركة.'),
    'the own-quota consequence is not stated in Arabic'
  );
  assert.ok(
    panel.includes('This route holds its own quota and never spends the shared capacity.'),
    'the own-quota consequence is not stated in English'
  );
  // «لا تكرر نفس الكمية تلقائيًا على الطرق الثلاث» — said to the admin, and
  // true of the code: a new route starts on the shared pool, never on a copy.
  assert.match(panel, /data-no-auto-copy/);
  assert.match(panel, /capacity: null,\s*\n\s*capacity_reserved: 0,\s*\n\s*lead_time_text: '',/);
});

// ------------------------------------------- the storefront reads the server

test('the product page prints the server’s counter and computes none of it', () => {
  const page = read(PRODUCT);
  // The per-route answer is LOOKED UP, with its scope and its reason.
  assert.match(page, /availability\?\.preorder\.routes\?\.find\(\(r\) => r\.method === method\)/);
  assert.match(page, /const preorderCapacity = availability\?\.preorder\.capacity \?\? null/);
  // The figure shown is the server's own field, substituted into a sentence —
  // never arithmetic over two levels.
  assert.match(page, /s\.preorderLeft\.replace\('\{n\}', String\(preorderCapacity\.available\)\)/);
  assert.doesNotMatch(page, /capacity\.available\s*[-+*]\s/, 'the page does arithmetic on a capacity');
  assert.doesNotMatch(
    page,
    /stock\.available[^\n]*\+[^\n]*capacity|capacity[^\n]*\+[^\n]*stock\.available/,
    'the page adds a shelf and a quota together'
  );
  // A route whose own quota is exhausted is not offered; the others still are,
  // and the two refusals are told apart.
  assert.match(page, /const routeUsable = \(t: TransportView\): boolean/);
  assert.match(page, /disabled=\{!usable\}/, 'a full route can still be chosen');
  assert.match(page, /s\.routeQuotaFull/);
  assert.match(page, /PREORDER_CAPACITY_EXHAUSTED/, 'the new refusal has no sentence on this page');
  // Sold out for direct sale, still open for pre-order, said in those words —
  // from the server's own per-type verdict.
  assert.match(page, /data-direct-sold-out-preorder-open/);
  assert.match(page, /m\.type === 'direct_sale' && !m\.usable && m\.reason === 'OUT_OF_STOCK'/);
  // The quantity ceiling stays the server's.
  assert.match(page, /availability\?\.stock\.max_qty/);
  // And a refusal at the door is spoken, not echoed in English: the one
  // refusal a customer must not read as "sold out" is the pre-order quota.
  assert.match(page, /const said = code \? reasonText\(s, code\) : ''/);
});

test('the cart counts from the line’s own counter, not from the legacy base column', () => {
  const cart = read(CART);
  assert.match(cart, /const lineRemaining = \(item: CartItem\)/);
  // A pre-order line answers from its capacity; a direct line from the shelf
  // at the authoritative level. Both are the server's resolution.
  assert.match(cart, /a\.preorder\?\.capacity/);
  assert.match(cart, /cap\.tracked && cap\.available !== null/);
  assert.match(cart, /st\.tracked && st\.available !== null/);
  // The old "Only N left" read `item.stock` — the product's BASE row, which is
  // the wrong number for an option-tracked product and not a counter at all
  // for a pre-order.
  assert.doesNotMatch(cart, /item\.stock !== null &&\s*\n\s*item\.stock < 10/);
  // The stepper's ceiling is the published one, already clamped by capacity.
  assert.match(cart, /item\.availability\?\.stock\?\.max_qty/);
  assert.match(cart, /Math\.min\(q, lineCap\(item\) \?\? 99\)/);
});

test('the cart and the checkout refuse with the server’s sentence and name the counter', () => {
  for (const file of [CART, CHECKOUT]) {
    const src = read(file);
    assert.match(src, /apiRefusal\(/, `${file} no longer decodes the server's own sentence`);
    assert.match(src, /PREORDER_CAPACITY_EXHAUSTED/, `${file} says nothing about the pre-order counter`);
    assert.ok(
      src.includes('The counter: this selection’s pre-order quota — not direct-sale stock.'),
      `${file} does not say WHICH counter refused`
    );
    assert.ok(
      src.includes('The counter: direct-sale stock for this selection.'),
      `${file} does not distinguish the shelf from the quota`
    );
  }
  // The decoded sentence is never replaced — the counter is added after it.
  assert.match(read(CART), /\$\{said\} \$\{counter\}/);
  assert.match(read(CHECKOUT), /\$\{said\} \$\{counter\}/);
});

// ------------------------------------------------------------------ sweeps

test('no commercial quantity is hardcoded anywhere this change touched', () => {
  for (const file of TOUCHED) {
    const src = read(file);
    // A stock or a capacity is never seeded with a number: it arrives from the
    // server, or it is null (untracked) / 0 (tracked and empty).
    assert.doesNotMatch(src, /\bcapacity:\s*[1-9]/, `${file} hardcodes a capacity`);
    assert.doesNotMatch(src, /\bcapacity_reserved:\s*[1-9]/, `${file} hardcodes a held quantity`);
    assert.doesNotMatch(src, /\bstock:\s*[1-9]/, `${file} hardcodes a stock`);
    assert.doesNotMatch(src, /low_stock_threshold:\s*[1-9]/, `${file} hardcodes a low-stock level`);
    // Neither is a price: every figure on these screens is the server's.
    assert.doesNotMatch(src, /_iqd:\s*[1-9]\d*/, `${file} hardcodes a price`);
  }
  // The customer-facing sentences carry a placeholder, never a number.
  const page = read(PRODUCT);
  assert.ok(page.includes("preorderLeft: 'بقي {n} من حصة الطلب المسبق'"));
  assert.ok(page.includes("preorderLeft: '{n} left in the pre-order quota'"));
});

test('no Sorani was invented for the new sentences', () => {
  const page = read(PRODUCT);
  // The four sentences 0075 adds are new copy. The Kurdish for them is the
  // owner's to write by hand, so the ckb block carries the ARABIC sentence and
  // says so — the documented fallback in this app — rather than a machine
  // translation of a refusal.
  const ckb = page.slice(page.indexOf('  ckb: {'));
  assert.ok(ckb.includes('NO SORANI IS INVENTED HERE'), 'the fallback is undocumented');
  for (const key of ['PREORDER_CAPACITY_EXHAUSTED', 'routeQuotaFull', 'preorderLeft', 'directSoldOutPreorderOpen']) {
    assert.ok(new RegExp(`${key}:`).test(ckb), `${key} is missing from the ckb block, so it would render as its code`);
  }
  // The cart and the checkout add nothing to the trilingual table: `loc(ar, en)`
  // falls back to Arabic for a Kurdish reader, which is this app's own rule.
  for (const file of [CART, CHECKOUT]) {
    assert.match(
      read(file),
      /loc\(\s*\n?\s*'العدّاد: حصة الطلب المسبق[^']*',\s*\n?\s*'The counter/,
      `${file} passes a third argument for a sentence nobody has written in Sorani`
    );
  }
});
