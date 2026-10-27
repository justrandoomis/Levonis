/**
 * EVERY CUSTOMER-FACING REFUSAL CODE IS TRANSLATED — docs/BUNDLES_MYSTERY.md
 * §15.3 ("A static test walks this table and fails if any customer-facing code
 * lacks all three languages").
 *
 * WHY A STATIC TEST AND NOT A ROUTE TEST. `HttpError` carries ONE untranslated
 * sentence; the cart renders `err.message` verbatim and the product page maps a
 * code through `reasonText`, whose fallback is `map[code] || code`. So a code
 * nobody translated does not fail anywhere — it is quietly printed to an Iraqi
 * customer as the literal string `BUNDLE_OPTIONAL_UNAVAILABLE`. The only thing
 * that catches that is a test that walks the contract's own table.
 *
 * The table below IS the contract's customer-facing subset, copied from §15.3.
 * Adding a code to the contract without adding its three sentences fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { REFUSAL_STRINGS, apiRefusal, refusalText, stockRefusal } from '../src/lib/refusalStrings';
import { isCostRefusalCode } from '../packages/contracts/src/costRefusals';

/** §15.3, verbatim: "the customer-facing subset of the tables above". */
const CUSTOMER_FACING = [
  'MEMBERSHIP_REQUIRED',
  'OFFER_INACTIVE',
  'OFFER_WINDOW_NOT_STARTED',
  'OFFER_WINDOW_EXPIRED',
  'PER_USER_LIMIT_REACHED',
  'GLOBAL_LIMIT_REACHED',
  'BUNDLE_QTY_LIMIT',
  'BUNDLE_CHOICE_INVALID',
  'BUNDLE_CHOICE_NOT_ALLOWED',
  'BUNDLE_COMPOSITION_CHANGED',
  'BUNDLE_OPTIONAL_UNAVAILABLE',
  'BUNDLE_PARTIAL_RETURN_NOT_ALLOWED',
  'BUNDLE_COMPONENT_ALREADY_CLAIMED',
  'COMPOSITION_TOO_LARGE',
  'COMPOSITION_NOT_ELIGIBLE',
  'MYSTERY_NO_ELIGIBLE_STOCK',
  'MYSTERY_NOT_ENOUGH_VARIETY',
  'MYSTERY_MODE_NOT_AVAILABLE',
  'MYSTERY_NOT_REVEALED',
  'MYSTERY_REVEALED_NO_CANCEL',
  'IDEMPOTENCY_KEY_REUSED',
] as const;

test('every customer-facing refusal code has an ar, an en AND a ckb sentence', () => {
  const missing: string[] = [];
  for (const code of CUSTOMER_FACING) {
    const entry = REFUSAL_STRINGS[code];
    if (!entry) {
      missing.push(`${code}: absent`);
      continue;
    }
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const value = entry[lang];
      if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${code}.${lang}`);
    }
  }
  assert.deepEqual(missing, [], `untranslated customer-facing codes: ${missing.join(', ')}`);
});

test('no sentence is the code itself, and Sorani is never a copy of the Arabic', () => {
  for (const code of CUSTOMER_FACING) {
    const e = REFUSAL_STRINGS[code];
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      assert.notEqual(e[lang], code, `${code}.${lang} is the bare identifier`);
      assert.ok(!/^[A-Z_]{6,}$/.test(e[lang]), `${code}.${lang} reads as a machine code`);
    }
    // Sorani is a real translation, not the Arabic pasted across — the repo's
    // own rule for ckb, and the failure mode a three-column table invites.
    assert.notEqual(e.ckb, e.ar, `${code}: ckb is a copy of the Arabic`);
    assert.notEqual(e.ckb, e.en, `${code}: ckb is a copy of the English`);
  }
});

test('across the WHOLE table, no Sorani sentence is the Arabic or the English pasted across', () => {
  // The rule above, for every code a customer, a merchant or a workshop can
  // meet — not only the list above. 112 of them once carried the Arabic.
  const copies = Object.entries(REFUSAL_STRINGS)
    .filter(([, e]) => e.ckb === e.ar || e.ckb === e.en)
    .map(([code]) => code);
  assert.deepEqual(copies, [], `ckb copies the Arabic or the English: ${copies.join(', ')}`);
});

test('the Arabic and Sorani sentences carry no latin identifier fragments', () => {
  for (const code of CUSTOMER_FACING) {
    const e = REFUSAL_STRINGS[code];
    for (const lang of ['ar', 'ckb'] as const) {
      assert.ok(
        !/[A-Z]{3,}_[A-Z]/.test(e[lang]),
        `${code}.${lang} leaks a machine code into a sentence a customer reads`
      );
    }
  }
});

test('refusalText answers in the asked language and NEVER returns the bare code', () => {
  assert.equal(refusalText('MEMBERSHIP_REQUIRED', 'ar'), REFUSAL_STRINGS.MEMBERSHIP_REQUIRED.ar);
  assert.equal(refusalText('MEMBERSHIP_REQUIRED', 'ckb'), REFUSAL_STRINGS.MEMBERSHIP_REQUIRED.ckb);
  // A code this table does not own keeps the server's own sentence.
  //
  // OUT_OF_STOCK USED TO BE THE EXAMPLE HERE, on the premise that a reused
  // code already has a sentence elsewhere. That premise was false for it: the
  // server's sentence is English with the product name inside it, so an Arabic
  // customer read English at the moment they lost a race for the last unit. It
  // is in the table now, so the example moved to a code that genuinely is not.
  assert.equal(refusalText('CART_SHIPPING_CONFLICT', 'ar', 'تعارض'), 'تعارض');
  assert.equal(refusalText('OUT_OF_STOCK', 'ar', 'ignored'), REFUSAL_STRINGS.OUT_OF_STOCK.ar);
  assert.equal(refusalText(null, 'en', 'fallback'), 'fallback');
  assert.equal(refusalText('UNKNOWN_CODE', 'en', ''), '', 'an unknown code never becomes its own identifier');
});

test('every code the table translates is one the server can actually emit', () => {
  // The other half of the drift: a sentence for a code no route throws is dead
  // weight that reads as coverage. Every key is grepped for in the worker.
  const sources = [
    'worker/routes/cart.ts',
    'worker/routes/orders.ts',
    'worker/routes/returns.ts',
    // Who may move money in the services (owner decision 3, row 223): every
    // service money door answers through this one rule.
    'worker/lib/moneyAuthority.ts',
    // The address book refuses on the money path too: a parcel with an
    // undialable number or no governorate is a delivery that fails.
    'worker/routes/addresses.ts',
    'worker/routes/memberships.ts',
    // validateCoupon's reasons (CODE_REQUIRED … TIER_REQUIRED): the checkout
    // answers each as the refusal code itself (orders.ts, `check.reason`).
    'worker/lib/membershipOps.ts',
    // «وجدتها بمكان أرخص» refuses in the customer's own sheet, so its codes are
    // translated rather than rendered as the route's slash-joined ar/en pair.
    'worker/routes/priceReports.ts',
    'worker/lib/bnpl.ts',
    'worker/lib/bundleCart.ts',
    'worker/lib/offers.ts',
    /**
     * NOT EVERY REFUSAL IS THROWN. `saleAvailability` here does not raise an
     * error — it WRITES the code into `availability.reason` on every cart line
     * and every product view, and the cart's blocked line decodes it through
     * the same table a thrown one goes through. The four pre-order refusals
     * (the quota, the route nobody priced, no route offered, pre-order off)
     * reach a customer only this way, so a source list of throwers alone would
     * call them dead weight while they are on screen.
     */
    'worker/routes/products.ts',
    // Custom print requests, their offers and the escrow behind them (merchant
    // platform wave 1): the board, acceptance, cancellation and the 3D preview
    // refuse with codes the request screens decode through this table.
    'worker/routes/marketplace.ts',
    'worker/routes/printRequests.ts',
    // The request model v3 (P1-04): the parts, materials, colours and sources
    // a v3 body is refused for, each beside the field it names.
    'worker/lib/requestModel.ts',
    // Readers and offers v3 (P1-05, row 267): what an offer covers and substitutes.
    'worker/lib/offerCoverage.ts',
    // The request editor's entries (P1-06, row 268): a project, a product or a store,
    // and the store's own questions they ask (OWN_STORE_REQUEST among them).
    'worker/routes/requestEntries.ts',
    'worker/lib/directRequests.ts',
    'worker/lib/requestHandoff.ts',
    // Community projects (docs/COMMUNITY_ECOSYSTEM.md Phase 1): the composer
    // decodes POST_* and CONSENT_* beside the field each one names.
    'worker/routes/communityPosts.ts',
    // The social graph (Phase 2): likes, comments, follows, blocks, reports —
    // BLOCKED, CANNOT_FOLLOW_SELF, COMMENT_TOO_FAST and their siblings.
    'worker/routes/communitySocial.ts',
    // Unified search and discovery (Phase 3): the term's length, the
    // recommendation anchor.
    'worker/routes/communitySearch.ts',
    // The community-store checkout and the merchant's order door (wave 1):
    // QUOTE_CHANGED, COUPON_EXHAUSTED, ORDER_CHANGED and their siblings.
    'worker/routes/storeOrders.ts',
    'worker/routes/merchant.ts',
    // The merchant selling gate every offer and store write passes through:
    // one code per sanction, MERCHANT_RESTRICTED among them (wave 1).
    'worker/lib/merchantAuth.ts',
    // The store checkout's delivery by governorate (wave 2, W2-A): the address
    // and delivery refusals are raised from the saved address here.
    'worker/lib/merchantDelivery.ts',
    // The workspace's analytics page, order screen and customers (W3-B), and
    // the palette search whose length refusals the customers search shares.
    'worker/routes/merchantAnalytics.ts',
    'worker/routes/merchantOrders.ts',
    'worker/routes/merchantCustomers.ts',
    'worker/routes/merchantWorkspace.ts',
    // Review W2-5 (W5-C): public store media needs a store and has a video
    // quota; a payout is not approved or paid while the merchant is in debt.
    'worker/routes/uploads.ts',
    'worker/routes/adminCommunity.ts',
    // Resumable uploads (§9.4 Phase 4a): the session lifecycle, the checksum,
    // the archive bound, the per-purpose quota and the configurable ceilings.
    'worker/routes/uploadSessions.ts',
    'worker/lib/uploadEntity.ts',
    // A request's file room and state, asked by both upload doors and by the
    // guarded insert where the row lands (DECISIONS row 258).
    'worker/lib/requestFileRoom.ts',
    'worker/lib/requestFileHooks.ts',
    // Eligibility as data (W5-B): the offer gate, the printer and stock routes,
    // and the private request costing.
    'worker/lib/printMatchingStore.ts',
    'worker/routes/merchantPrinters.ts',
    'worker/routes/merchantWorkshop.ts',
    // Catalog discovery: a category with no products, the reserved slug.
    'worker/routes/catalog.ts',
    'worker/routes/adminTaxonomy.ts',
    // «تعديل السعر النهائي» (0140): the proposal, the customer's decision, the hold.
    'worker/lib/orderPriceAdjust.ts',
    'worker/routes/orderPriceAdjust.ts',
    'packages/pricing/src/priceAdjustment.ts',
    // «الاستبدال» (0143): eligibility, the draft, the photos, the value, the credit.
    'worker/lib/tradeIn.ts',
    'worker/routes/tradeIn.ts',
    // Trade-in v2 (S-P2, row 238): the schema probe's 503, intake, completion, the credit given back.
    'worker/lib/tradeInSchema.ts',
    // The store's conversation (docs/COMMUNITY_COMMERCE_CHAT.md): a card names
    // an entity of THIS thread or it is refused, in the thread's own words.
    'worker/lib/chatCards.ts',
    'worker/routes/chats.ts',
    'worker/routes/chatCommerce.ts',
    // Files on products and posts (§9.4): the merchant editor's refusals, the
    // download door's PRODUCT_FILE_NOT_GRANTED, and the shared viewer's dead link.
    'worker/routes/productFiles.ts',
    // Link cards (§9.4): a pasted address that is not a web page, one we will
    // not touch, and a preview that could not be fetched (a reason on the card).
    'worker/lib/linkCards.ts',
    'worker/routes/linkCards.ts',
    // The request's discussion and the order's timeline (Phase 5b, §9.5):
    // COMMENT_* and ORDER_UPDATE_* land on the request page and the order screen.
    'worker/routes/requestDiscussion.ts',
    'worker/routes/communityOrderTimeline.ts',
    // Media everywhere in the store page (P5, storefront §4.7): a slot's weight
    // cap, the poster a video needs, a library file still in use.
    'worker/routes/storeLayout.ts',
    // Gifts (0175, docs/GIFTS_QUICK_BUY.md §1): choose, redeem, the gift line
    // in the cart and at checkout.
    'worker/routes/gifts.ts',
    // Serials at order preparation (0178): the slots, the camera sheet, the
    // §19 gate, the serial page and the hardened device doors.
    'worker/lib/serialAssignments.ts',
    'worker/routes/adminOrderSerials.ts',
    'worker/routes/warranty.ts',
    // Owner decision 1 (row 192): every serial write door refuses a revoked
    // «الاستلام» with SERIAL_WRITE_NOT_ALLOWED (`requireSerialWrite`).
    'worker/lib/operations.ts',
    // Owner decision 3 (row 193): a device that came back to Levonis cannot be
    // re-linked or claimed from its buyer's account (DEVICE_NOT_WITH_CUSTOMER).
    'worker/routes/devices.ts',
    // «ملف بيانات المنتج» (row 204): the round trip's DATA_FILE_* refusals,
    // rendered by code on the sheet (packages/contracts/src/dataFileRefusals.ts).
    'worker/routes/templateDataFile.ts',
    'worker/lib/productDataFile.ts',
    // «ناقص» / «إخفاء المنتجات الناقصة عن الزبائن» (0184): the switch's and the
    // recount's refusals (packages/contracts/src/productCompleteness.ts).
    'worker/routes/adminCompleteness.ts',
    'worker/routes/admin.ts',
    // The deception layer (row 206): a blocked browser's every API answer (ACCESS_BLOCKED).
    'worker/lib/deception/strings.ts',
    // The special-offers door and the product form's discount card (docs/ux/PRODUCT-DISCOUNT.md §5.8):
    // the dollar sale price's refusals, the lost update and the two warnings the card renders.
    'worker/routes/offers.ts',
    'worker/lib/offerDiscount.ts',
    // The merchant approval gate (DECISIONS row 256): the applicant's routes,
    // the transition refusals, and KYC's self-decision guard.
    'worker/lib/merchantApproval.ts',
    'worker/routes/merchantApplication.ts',
    'worker/routes/kyc.ts',
    // …and its reviewer side (push 1.2, row 257): scope, revision, reason, the owner's grants.
    'worker/routes/adminMerchantApplications.ts',
  ]
    .map((p) => readFileSync(join(ROOT, p), 'utf8'))
    .join('\n');
  const mystery = ['worker/lib/mysteryDraw.ts', 'worker/routes/mystery.ts', 'worker/lib/mysteryReveal.ts']
    .map((p) => {
      try {
        return readFileSync(join(ROOT, p), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  const emitted = `${sources}\n${mystery}`;
  // A code this build no longer sends but an OLDER build, redeployed by hand,
  // still answers: its words stay so that answer is never a raw code
  // (REQUEST_PARTS_NOT_YET, lifted by P1-05 — DECISIONS row 267).
  const RETIRED_STILL_ANSWERED = new Set(['REQUEST_PARTS_NOT_YET']);
  const orphans = Object.keys(REFUSAL_STRINGS).filter(
    // The mystery engine is a later slice; its codes are translated ahead of it
    // deliberately, so the strings land with the table rather than after the
    // first customer has seen one in English. The pricing programme's contract
    // (packages/contracts/src/costRefusals.ts) is the same case: S1 lands every
    // step's codes at once, and tests/programmeRefusals.test.ts owns them.
    (code) => !emitted.includes(code) && !code.startsWith('MYSTERY_') && !isCostRefusalCode(code) && !RETIRED_STILL_ANSWERED.has(code)
  );
  assert.deepEqual(orphans, [], `translated codes no route can emit: ${orphans.join(', ')}`);
});


/**
 * THE GIFT CARD'S REFUSALS (0175, docs/GIFTS_QUICK_BUY.md §1). Every code the
 * gift doors answer a customer with — the card on «هداياي», the gift line in
 * the cart and the checkout — has three real sentences, the Sorani its own.
 */
const GIFT_CUSTOMER_FACING = [
  'GIFT_NOT_FOUND',
  'GIFT_STATE',
  'GIFT_CHOICE_REQUIRED',
  'GIFT_ITEM_UNAVAILABLE',
  'GIFT_NOT_REDEEMED',
  'GIFT_ALREADY_ORDERED',
  'GIFT_NOT_AVAILABLE',
  'GIFT_NOT_ORDERABLE',
  'GIFT_LINE_LOCKED',
  'GIFT_SALE_TYPE_UNAVAILABLE',
] as const;

test('every gift refusal a customer can meet has ar, en and its own ckb', () => {
  for (const code of GIFT_CUSTOMER_FACING) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e, `${code}: absent`);
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      assert.ok(typeof e[lang] === 'string' && e[lang].trim().length > 0, `${code}.${lang} is empty`);
      assert.ok(!/^[A-Z_]{6,}$/.test(e[lang]), `${code}.${lang} reads as a machine code`);
    }
    for (const lang of ['ar', 'ckb'] as const) {
      assert.ok(!/[A-Z]{3,}_[A-Z]/.test(e[lang]), `${code}.${lang} leaks a machine code`);
    }
    assert.notEqual(e.ckb, e.ar, `${code}: ckb is a copy of the Arabic`);
    assert.notEqual(e.ckb, e.en, `${code}: ckb is a copy of the English`);
  }
});

// ------------------------------------------- the codes actually REACH a screen

/**
 * A TRANSLATED CODE THAT NO DOOR DECODES IS NOT TRANSLATED.
 *
 * The tests above prove the strings EXIST. They passed while `refusalText` was
 * wired to exactly ONE call site — `Cart.updateQuantity` — and every other
 * customer door rendered the server's raw sentence: an Arabic customer at the
 * last screen before payment read
 * `"حزمة البداية" is not available right now (OFFER_WINDOW_EXPIRED)`.
 * So this walks the doors themselves.
 */
const DOORS = [
  'src/pages/Cart.tsx',
  'src/pages/Checkout.tsx',
  // The address form raises INVALID_PHONE and GOVERNORATE_REQUIRED, and both
  // land inside a form the customer is filling in — the one place an English
  // sentence is least excusable.
  'src/pages/Addresses.tsx',
  'src/pages/BundleDetail.tsx',
  'src/components/orders/CancelOrderSheet.tsx',
  'src/components/returns/ReturnsSection.tsx',
  'src/components/orders/PriceProtection.tsx',
  // The community-store doors (merchant platform wave 1): the store cart, its
  // checkout — where QUOTE_CHANGED and COUPON_EXHAUSTED land — and the
  // customer's «استلمت طلبي».
  'src/components/merchant/MerchantCartView.tsx',
  'src/pages/StoreCheckout.tsx',
  'src/components/orders/StoreReceipt.tsx',
  // A store's product page: the add-to-cart door, where OWN_STORE_PURCHASE,
  // STORE_CLOSED and OUT_OF_STOCK land (the seller conflict opens its dialog).
  'src/pages/StorefrontProduct.tsx',
];

test('every customer door decodes the refusal CODE rather than printing the server sentence', () => {
  for (const rel of DOORS) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(
      /apiRefusal\(|refusalText\(/.test(src),
      `${rel} never decodes a refusal code — a new server code reaches the customer as English prose`
    );
    // The raw-message idiom is what this replaces. Any surviving occurrence
    // that feeds an error state is the same bug coming back.
    const raw = src.match(/set\w*Error\((?:err|e) instanceof Error \? (?:err|e)\.message/g) ?? [];
    assert.deepEqual(raw, [], `${rel} still renders the server's untranslated sentence into an error state`);
  }
});

test('no server refusal prints a machine code inside the sentence a customer reads', () => {
  // `("${label}" is not available right now (${reason}))` put the identifier in
  // parentheses after a product name, with no bidi isolation, on the money path.
  for (const rel of ['worker/lib/bundleCart.ts', 'worker/lib/mystery/issues.ts', 'worker/routes/cart.ts']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(
      !/\(\$\{reason\}\)/.test(src),
      `${rel} interpolates a machine code into a customer sentence`
    );
  }
  // And a mystery refusal is ONE language, not three run together: the code is
  // what the client localises.
  const issues = readFileSync(join(ROOT, 'worker/lib/mystery/issues.ts'), 'utf8');
  assert.ok(
    !/\$\{t\.ar\} \/ \$\{t\.en\} \/ \$\{t\.ckb\}/.test(issues),
    'a mystery refusal still concatenates all three languages into one message'
  );
});

test('apiRefusal decodes the code and falls back to the server sentence, never to the identifier', () => {
  const err = { code: 'OFFER_WINDOW_EXPIRED', message: '"حزمة البداية" is not available right now (OFFER_WINDOW_EXPIRED)' };
  assert.equal(apiRefusal(err, 'ar'), REFUSAL_STRINGS.OFFER_WINDOW_EXPIRED.ar);
  assert.equal(apiRefusal(err, 'ckb'), REFUSAL_STRINGS.OFFER_WINDOW_EXPIRED.ckb);
  // A code this table does not own keeps the server's own sentence.
  assert.equal(apiRefusal({ code: 'CART_SHIPPING_CONFLICT', message: 'تعارض' }, 'ar', 'x'), 'تعارض');

  /**
   * THE COUNT, WHEN THE SERVER SENT ONE.
   *
   * «يعطيه اشعارا بان المتبقي فقط 2» — the second customer in a race for the
   * last units is told how many are actually left, in their own language, so
   * they can lower the quantity instead of guessing.
   */
  const short = { code: 'OUT_OF_STOCK', details: { available: 2, requested: 3, coarse: false }, message: 'Only 2 left' };
  assert.match(apiRefusal(short, 'ar', 'x'), /2/);
  assert.match(apiRefusal(short, 'ar', 'x'), /قلّل الكمية/);
  assert.match(apiRefusal(short, 'en', 'x'), /Only 2 left in stock/);
  assert.match(apiRefusal(short, 'ckb', 'x'), /2/);
  // Zero is a different remedy — remove it, not lower it.
  const none = { code: 'OUT_OF_STOCK', details: { available: 0, coarse: false }, message: 'x' };
  assert.match(apiRefusal(none, 'ar', 'x'), /نفد مخزون/);
  assert.ok(!/قلّل الكمية/.test(apiRefusal(none, 'ar', 'x')));
  // A MYSTERY-POOL MEMBER NAMES NO COUNT — docs/BUNDLES_MYSTERY.md §8.2 row 18:
  // "only 2 left" there is a before/after oracle on the draw. The server omits
  // the number and flags `coarse`; the client must fall back to the count-free
  // sentence even if a number somehow arrives.
  const coarse = { code: 'OUT_OF_STOCK', details: { coarse: true, available: 2 }, message: 'x' };
  assert.equal(apiRefusal(coarse, 'ar', 'x'), REFUSAL_STRINGS.OUT_OF_STOCK.ar);
  assert.ok(!/2/.test(apiRefusal(coarse, 'ar', 'x')));
  // An older server sends no details at all: the count-free sentence, never a
  // sentence with `undefined` in it.
  assert.equal(apiRefusal({ code: 'OUT_OF_STOCK', message: 'x' }, 'ar', 'y'), REFUSAL_STRINGS.OUT_OF_STOCK.ar);
  // No code at all, and no message: the caller's own fallback, never ''.
  assert.equal(apiRefusal({}, 'en', 'fallback'), 'fallback');
  assert.equal(apiRefusal(null, 'en', 'fallback'), 'fallback');
  // An unknown code is never printed as itself.
  assert.equal(apiRefusal({ code: 'NOPE_NOT_A_CODE' }, 'en', 'fallback'), 'fallback');
});


/**
 * `QTY_UNAVAILABLE` — THE CART DOOR'S "NOT THAT MANY", IN THREE LANGUAGES.
 *
 * §15.3 files this under "reused codes, unchanged in meaning", on the premise
 * that a reused code already has a sentence elsewhere. That premise was false
 * for `OUT_OF_STOCK` and it was false here for the same reason: the only
 * sentence was the server's `Only 2 left`, in English, raised by BOTH cart
 * write doors (`POST /api/cart/items` and `PATCH /api/cart/items/:id`) — and
 * `src/pages/Cart.tsx` appends its Arabic counter note to whatever comes back,
 * so the customer who lost the race read one line in two languages.
 */
test('the cart door refusal names the remainder in all three languages, never in English prose', () => {
  const short = { code: 'QTY_UNAVAILABLE', details: { available: 2, preorder: false }, message: 'Only 2 left' };
  assert.match(apiRefusal(short, 'ar', 'x'), /2/);
  assert.match(apiRefusal(short, 'ar', 'x'), /قلّل الكمية/);
  assert.match(apiRefusal(short, 'en', 'x'), /Only 2 left in stock/);
  assert.match(apiRefusal(short, 'ckb', 'x'), /2/);
  for (const lang of ['ar', 'ckb'] as const) {
    assert.ok(!/Only 2 left/.test(apiRefusal(short, lang, 'x')), `${lang} still reads the server's English clause`);
  }

  // NO REMAINDER TO NAME. The per-order ceiling and a mystery-pool member both
  // arrive without `available` — §8.2 row 18 forbids publishing the count for
  // the latter — so the count-free table entry answers, in every language, and
  // never the server's sentence and never the bare identifier.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const capped = { code: 'QTY_UNAVAILABLE', details: { max_qty: 10, preorder: false }, message: 'At most 10 per order' };
    assert.equal(apiRefusal(capped, lang, 'x'), REFUSAL_STRINGS.QTY_UNAVAILABLE[lang]);
    assert.ok(REFUSAL_STRINGS.QTY_UNAVAILABLE[lang].trim().length > 0);
  }
  assert.notEqual(REFUSAL_STRINGS.QTY_UNAVAILABLE.ckb, REFUSAL_STRINGS.QTY_UNAVAILABLE.ar, 'ckb is a copy of the Arabic');
  assert.notEqual(REFUSAL_STRINGS.QTY_UNAVAILABLE.ckb, REFUSAL_STRINGS.QTY_UNAVAILABLE.en);
  for (const lang of ['ar', 'ckb'] as const) {
    assert.ok(!/[A-Z]{3,}_[A-Z]/.test(REFUSAL_STRINGS.QTY_UNAVAILABLE[lang]), 'a machine code leaked into the sentence');
  }

  // AND IT NAMES THE COUNTER THE NUMBER CAME OFF. A pre-order is limited by
  // its import quota, never by the shelf, so «لم يبقَ سوى n من هذا المنتج» —
  // a sentence about stock — must not be said about a line whose shelf may be
  // full. `details.preorder` is what the door sends to say which one answered.
  const quota = { code: 'QTY_UNAVAILABLE', details: { available: 2, preorder: true }, message: 'Only 2 left' };
  assert.match(apiRefusal(quota, 'ar', 'x'), /الطلب المسبق/);
  assert.match(apiRefusal(quota, 'en', 'x'), /pre-order place/);
  assert.ok(!/in stock/.test(apiRefusal(quota, 'en', 'x')), 'an import quota was read out as shelf stock');

  // An older server that sends no details at all still gets a sentence, not
  // the English clause it shipped with.
  assert.equal(apiRefusal({ code: 'QTY_UNAVAILABLE', message: 'Only 2 left' }, 'ar', 'x'), REFUSAL_STRINGS.QTY_UNAVAILABLE.ar);
  assert.equal(stockRefusal({ code: 'QTY_UNAVAILABLE', message: 'Only 2 left' }, 'ar'), null);
});

/**
 * THE CODES THE END-TO-END REVIEW OF THE LIVE MERCHANT PLATFORM ADDED (F12):
 * the coupon form's two refusals, the custom order's lifecycle doors and a
 * customer's cancel after the order moved on. Each used to reach its screen as
 * the server's English sentence (or no code at all). Merchant- and
 * customer-facing alike, each has an Arabic and an English sentence that says
 * what to do, and its own Sorani (DECISIONS row 183 — the whole table is
 * checked for copies of the Arabic above).
 */
const REVIEW_E2E_CODES = [
  'BAD_COUPON_CODE',
  'COUPON_CODE_TAKEN',
  'CUSTOM_ORDER_CANNOT_START',
  'CUSTOM_ORDER_CANNOT_DELIVER',
  'CUSTOM_ORDER_CANNOT_CONFIRM',
  'CUSTOM_ORDER_NO_ESCROW',
  'CUSTOM_ORDER_CANCEL_NEEDS_DISPUTE',
  'CUSTOM_ORDER_CANNOT_CANCEL',
  'ORDER_NOT_CANCELLABLE',
] as const;

test('the review codes (F12) are translated, and each is emitted by its route', () => {
  const emitters: Record<string, string> = {
    BAD_COUPON_CODE: 'worker/routes/merchant.ts',
    COUPON_CODE_TAKEN: 'worker/routes/merchant.ts',
    ORDER_NOT_CANCELLABLE: 'worker/routes/orders.ts',
  };
  for (const code of REVIEW_E2E_CODES) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e, `${code} has no sentence`);
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(e[lang]?.trim(), `${code}.${lang} is empty`);
    assert.notEqual(e.ar, e.en);
    assert.ok(!/[A-Z]{3,}_[A-Z]/.test(e.ar + e.en), `${code}: a machine code leaked into the sentence`);
    const file = emitters[code] ?? 'worker/routes/marketplace.ts';
    assert.ok(readFileSync(join(ROOT, file), 'utf8').includes(`'${code}'`), `${file} does not emit ${code}`);
  }
});

/**
 * MEDIA EVERYWHERE IN THE STORE PAGE (P5; docs/MERCHANT_PLATFORM_V2.md
 * storefront §4.7): the three refusals the builder meets when a file is
 * heavier than its slot, a video has no poster, or a library file is still in
 * use. Each is written in all three languages — the §4.7 sentences verbatim —
 * is raised by the layout routes, and is decoded by the builder's own map
 * (src/components/merchant/storeDesign/refusal.ts) with its {size}/{max}/
 * {where} figures filled from `details`.
 */
test('the store page\'s media refusals (P5) are translated, emitted by the layout routes and decoded by the builder', () => {
  const codes = ['LAYOUT_MEDIA_TOO_HEAVY', 'LAYOUT_POSTER_REQUIRED', 'MEDIA_IN_USE', 'MEDIA_NOT_FOUND'] as const;
  const route = readFileSync(join(ROOT, 'worker/routes/storeLayout.ts'), 'utf8');
  const builder = readFileSync(join(ROOT, 'src/components/merchant/storeDesign/refusal.ts'), 'utf8');
  for (const code of codes) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e, `${code} has no sentence`);
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(e[lang]?.trim(), `${code}.${lang} is empty`);
    assert.notEqual(e.ckb, e.ar, `${code}: ckb is a copy of the Arabic`);
    assert.notEqual(e.ckb, e.en);
    assert.ok(!/[A-Z]{3,}_[A-Z]/.test(e.ar + e.ckb), `${code}: a machine code leaked into the sentence`);
    assert.ok(route.includes(`'${code}'`), `worker/routes/storeLayout.ts does not emit ${code}`);
    assert.ok(builder.includes(`case '${code}'`), `the builder does not decode ${code}`);
  }
  // The figures are placeholders the builder fills, in every language.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(REFUSAL_STRINGS.LAYOUT_MEDIA_TOO_HEAVY[lang].includes('{size}') && REFUSAL_STRINGS.LAYOUT_MEDIA_TOO_HEAVY[lang].includes('{max}'), lang);
    assert.ok(REFUSAL_STRINGS.MEDIA_IN_USE[lang].includes('{where}'), lang);
  }
  assert.equal(REFUSAL_STRINGS.LAYOUT_POSTER_REQUIRED.ar, 'اختر صورة ملصق للفيديو حتى يظهر شيء قبل التشغيل.');
});


/**
 * THE PHASE 5 SCREENS SPEAK SORANI (docs/COMMUNITY_ECOSYSTEM.md §4e: «every
 * code is localised … ar/en/ckb»; review 2026-09-30: the accept sheet showed
 * an Arabic OFFER_CHANGED above an otherwise Sorani sheet). Every code the
 * offers, acceptance, discussion, order timeline and custom-order screens can
 * show — and the builder's media codes — carries its own Sorani, never the
 * Arabic standing in, and the pages' words: «ئۆفەر», «وۆرکشۆپ».
 */
test('every Phase 5 refusal code has real Sorani — not the Arabic pasted across — in the pages\' own vocabulary', () => {
  const PHASE5 = [
    'OFFER_FEE_INVALID', 'OFFER_PICKUP_FEE', 'OFFER_FILE_LIMIT', 'UPLOAD_KIND_NOT_ALLOWED', 'OFFER_FILE_NOT_OWNED', 'OWN_REQUEST',
    'OFFER_EXISTS', 'OFFER_DRAFT_EXISTS', 'REQUEST_CHANGED', 'OFFER_NOT_DRAFT', 'OFFER_REQUEST_CLOSED', 'OFFER_CHANGED', 'OFFER_STALE',
    'INSUFFICIENT_FUNDS', 'ADDRESS_NOT_FOUND', 'OFFER_NOT_ELIGIBLE', 'OFFER_EXPIRED', 'ACCEPT_CONFLICT', 'OFFER_NOT_AVAILABLE',
    'MERCHANT_UNAVAILABLE', 'WALLET_ERROR', 'PREFS_TURNAROUND_INVALID', 'PREFS_INTRO_TOO_LONG',
    'COMMENT_KIND_NOT_ALLOWED', 'COMMENT_TOO_LONG', 'COMMENT_PARENT_INVALID', 'COMMENT_INDECENT', 'COMMENT_NOT_FOUND', 'REPORT_TARGET_NOT_FOUND',
    'ORDER_UPDATE_KIND_NOT_ALLOWED', 'ORDER_UPDATE_TOO_LATE', 'ORDER_UPDATE_TOO_LONG', 'ORDER_UPDATE_FILE_NOT_OWNED',
    'CUSTOM_ORDER_CANCEL_NEEDS_DISPUTE', 'CUSTOM_ORDER_CANNOT_START', 'CUSTOM_ORDER_CANNOT_DELIVER', 'CUSTOM_ORDER_CANNOT_CANCEL',
    'CUSTOM_ORDER_CANNOT_CONFIRM', 'LAYOUT_MEDIA_TOO_HEAVY', 'LAYOUT_POSTER_REQUIRED', 'MEDIA_IN_USE', 'MEDIA_NOT_FOUND',
  ];
  const problems: string[] = [];
  for (const code of PHASE5) {
    const e = (REFUSAL_STRINGS as Record<string, { ar: string; en: string; ckb: string } | undefined>)[code];
    if (!e) { problems.push(`${code}: absent`); continue; }
    if (!e.ckb || e.ckb === e.ar) problems.push(`${code}: ckb is the Arabic`);
    if (/پێشنیار|وەرشە/.test(e.ckb)) problems.push(`${code}: ckb says «پێشنیار»/«وەرشە», the pages say «ئۆفەر»/«وۆرکشۆپ»`);
  }
  assert.deepEqual(problems, []);
});

/**
 * THE STORE AND PRODUCT ENTRY DOORS (P1-06, row 268) refuse a workshop's own
 * store with a code of their own. OWN_REQUEST is the offer door's, and its
 * sentence («you cannot make an offer on your own request») is the wrong one
 * for a merchant who pressed «اطلب طباعة» on their own store or product.
 */
test('the entry doors refuse a workshop\'s own store in their own words, emitted by the store rule and decoded in ar, en and ckb', () => {
  const lib = readFileSync(join(ROOT, 'worker/lib/directRequests.ts'), 'utf8');
  assert.ok(lib.includes("'OWN_STORE_REQUEST'"), 'assertStoreTakesDirect emits OWN_STORE_REQUEST');
  assert.ok(!/This is your own store', 'OWN_REQUEST'/.test(lib), 'the store rule no longer borrows the offer code');
  const e = REFUSAL_STRINGS.OWN_STORE_REQUEST;
  assert.ok(e, 'OWN_STORE_REQUEST has no sentence');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(e[lang]?.trim(), `OWN_STORE_REQUEST.${lang} is empty`);
    assert.notEqual(e[lang], REFUSAL_STRINGS.OWN_REQUEST[lang], `OWN_STORE_REQUEST.${lang} is the offer sentence`);
    assert.equal(apiRefusal({ code: 'OWN_STORE_REQUEST', message: 'This is your own store' }, lang, 'x'), e[lang], lang);
  }
  assert.notEqual(e.ckb, e.ar, 'ckb is a copy of the Arabic');
  assert.ok(/[ەێۆڕڵ]/.test(e.ckb), 'the ckb sentence is Sorani');
  assert.ok(!/[A-Z]{3,}_[A-Z]/.test(e.ar + e.en + e.ckb), 'a machine code leaked into the sentence');
});

/**
 * EVERY REFUSAL THE REQUEST EDITOR AND ITS ENTRIES ANSWER (P1-06, row 268):
 * publishing a draft, the same-millisecond draft guard, a project, product or
 * store entry, the copy of a project file and the direct send. The route tests
 * (requestEntryDoor, requestProductEntry, requestProjectHandoff,
 * requestDirectEntry) pin the CODE the server sends and never the words the
 * editor shows, and the whole-table orphan test above only looks the other way
 * (a sentence for a code no route sends). So deleting any of these sentences
 * left every suite green while the editor printed the server English. This
 * list is the parity check: each code has its three sentences, its own Sorani,
 * is decoded by apiRefusal, and is still emitted by the P1-06 doors.
 */
const P1_06_CODES = [
  'REQUEST_TITLE_REQUIRED',
  'REQUEST_DESCRIPTION_REQUIRED',
  'DRAFT_CHANGED',
  'ENTRY_NOT_FOUND',
  'COPY_CHANGED',
  'STORE_UNAVAILABLE',
  'REQUEST_IS_DIRECT',
  'OWN_STORE_REQUEST',
  'STORE_NO_CUSTOM_REQUESTS',
  'STORE_NOT_TAKING_WORK',
  'REQUEST_NOT_DRAFT',
] as const;

/** The P1-06 doors: the entries, the store rule, the copy from a project, the editor routes. */
const P1_06_DOORS = [
  'worker/routes/requestEntries.ts',
  'worker/lib/directRequests.ts',
  'worker/lib/requestHandoff.ts',
  'worker/routes/printRequests.ts',
] as const;

/** A file without its comment lines, so a code named only in a comment never counts as emitted. */
const codeLines = (src: string) =>
  src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');

test('every P1-06 entry and editor refusal has ar, en and its own Sorani, decoded by apiRefusal', () => {
  const table = REFUSAL_STRINGS as Record<string, { ar: string; en: string; ckb: string } | undefined>;
  const problems: string[] = [];
  for (const code of P1_06_CODES) {
    const e = table[code];
    if (!e) {
      problems.push(`${code}: absent`);
      continue;
    }
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const said = e[lang];
      if (typeof said !== 'string' || said.trim().length === 0) {
        problems.push(`${code}.${lang}: empty`);
        continue;
      }
      if (said.includes(code) || /^[A-Z_]{6,}$/.test(said) || /[A-Z]{3,}_[A-Z]/.test(said)) {
        problems.push(`${code}.${lang}: a machine code in the sentence`);
      }
      // What the editor shows: the code decoded, never the server English beside it.
      const shown = apiRefusal({ code, message: `Server sentence (${code})` }, lang, 'fallback');
      if (shown !== said) problems.push(`${code}.${lang}: apiRefusal shows «${shown}»`);
    }
    if (e.ckb === e.ar) problems.push(`${code}: ckb is a copy of the Arabic`);
    if (e.ckb === e.en) problems.push(`${code}: ckb is a copy of the English`);
    if (!/[ەێۆڕڵ]/.test(e.ckb ?? '')) problems.push(`${code}: ckb carries no Sorani-only letter`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every P1-06 refusal code is still emitted by the P1-06 doors', () => {
  const doors = P1_06_DOORS.map((rel) => codeLines(readFileSync(join(ROOT, rel), 'utf8'))).join('\n');
  const missing = P1_06_CODES.filter((code) => {
    // STORE_UNAVAILABLE is the one public answer (C9): the store rule throws it
    // through the shared helper rather than spelling the code itself.
    if (code === 'STORE_UNAVAILABLE') return false;
    return !doors.includes(`'${code}'`);
  });
  assert.deepEqual(missing, [], `no P1-06 door emits: ${missing.join(', ')}`);

  const store = codeLines(readFileSync(join(ROOT, 'worker/lib/directRequests.ts'), 'utf8'));
  assert.ok(/throw publicStoreUnavailable\(\)/.test(store), 'the store rule throws the public STORE_UNAVAILABLE answer');
  const approval = readFileSync(join(ROOT, 'worker/lib/merchantApproval.ts'), 'utf8');
  const helper = approval.match(/export function publicStoreUnavailable\(\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(helper, 'merchantApproval.ts declares publicStoreUnavailable');
  assert.ok(helper[1].includes("'STORE_UNAVAILABLE'"), 'publicStoreUnavailable answers STORE_UNAVAILABLE');
});

test('every promo-code refusal the checkout can meet reads in the customer\'s language, on the quote and on the press', () => {
  // Checkout's COUPON_FAILURES: the codes that mean «the code is the problem».
  // INACTIVE and CODE_NOT_FOUND also come from the order batch's own trigger
  // since S-P1 (0191), on the place-order press, not only on the quote.
  const checkout = readFileSync(join(ROOT, 'src/pages/Checkout.tsx'), 'utf8');
  const set = checkout.match(/const COUPON_FAILURES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(set, 'COUPON_FAILURES is declared in Checkout.tsx');
  const codes = [...set[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.includes('INACTIVE') && codes.includes('CODE_NOT_FOUND'), codes.join(','));
  for (const code of codes) {
    const entry = REFUSAL_STRINGS[code];
    assert.ok(entry, `${code} has no sentence: the checkout shows the server's English`);
    const server = { code, message: `Coupon could not be applied (${code})` };
    for (const lang of ['ar', 'ckb'] as const) {
      const said = apiRefusal(server, lang, 'x');
      assert.equal(said, entry[lang], `${code}.${lang}`);
      assert.ok(!said.includes(code), `${code}.${lang} prints the machine code`);
    }
  }
  // Both checkout paths treat them as the code's failure: the quote and the place-order press.
  assert.ok((checkout.match(/COUPON_FAILURES\.has\(/g) ?? []).length >= 2, 'the place-order catch handles a refused code like the quote does');
});
