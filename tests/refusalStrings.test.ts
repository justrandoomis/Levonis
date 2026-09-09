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
import { REFUSAL_STRINGS, apiRefusal, refusalText } from '../src/lib/refusalStrings';

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
  // A code this table does not own keeps the server's own sentence — every
  // reused code (`OUT_OF_STOCK`, `CART_SHIPPING_CONFLICT`, …) already has one.
  assert.equal(refusalText('OUT_OF_STOCK', 'ar', 'نفد المخزون'), 'نفد المخزون');
  assert.equal(refusalText(null, 'en', 'fallback'), 'fallback');
  assert.equal(refusalText('UNKNOWN_CODE', 'en', ''), '', 'an unknown code never becomes its own identifier');
});

test('every code the table translates is one the server can actually emit', () => {
  // The other half of the drift: a sentence for a code no route throws is dead
  // weight that reads as coverage. Every key is grepped for in the worker.
  const sources = ['worker/routes/cart.ts', 'worker/routes/orders.ts', 'worker/routes/returns.ts', 'worker/lib/bundleCart.ts', 'worker/lib/offers.ts']
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
  const orphans = Object.keys(REFUSAL_STRINGS).filter(
    // The mystery engine is a later slice; its codes are translated ahead of it
    // deliberately, so the strings land with the table rather than after the
    // first customer has seen one in English.
    (code) => !emitted.includes(code) && !code.startsWith('MYSTERY_')
  );
  assert.deepEqual(orphans, [], `translated codes no route can emit: ${orphans.join(', ')}`);
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
  'src/pages/BundleDetail.tsx',
  'src/components/orders/CancelOrderSheet.tsx',
  'src/components/returns/ReturnsSection.tsx',
  'src/components/orders/PriceProtection.tsx',
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
  assert.equal(apiRefusal({ code: 'OUT_OF_STOCK', message: 'نفد المخزون' }, 'ar', 'x'), 'نفد المخزون');
  // No code at all, and no message: the caller's own fallback, never ''.
  assert.equal(apiRefusal({}, 'en', 'fallback'), 'fallback');
  assert.equal(apiRefusal(null, 'en', 'fallback'), 'fallback');
  // An unknown code is never printed as itself.
  assert.equal(apiRefusal({ code: 'NOPE_NOT_A_CODE' }, 'en', 'fallback'), 'fallback');
});
