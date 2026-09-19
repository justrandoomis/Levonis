/**
 * «خبرني لما يرجع» — THE STOREFRONT HALF, PINNED.
 *
 * The server has been live since migration 0092 and nothing on the storefront
 * ever called it. These tests hold the UI to the three things that decide
 * whether the feature tells the truth:
 *
 *   1. THE PICKER MAY ONLY OFFER WHAT ONE STORED ROW CAN NAME. A
 *      `product_stock_alerts` row has exactly one `option_value_id`, so a
 *      per-model list is honest for a one-group product and a lie for a
 *      two-group one — the alert would fire for a completion the customer
 *      never chose. `buildAlertTargets` owns that rule and it is exercised
 *      here for real, not paraphrased.
 *
 *   2. THE COPY MUST NOT SAY THE PRODUCT IS UNAVAILABLE. The whole situation
 *      this screen appears in is «direct sale is sold out, pre-order is open»:
 *      the thing IS buyable, by the dearer route, and the customer arming an
 *      alert is choosing to wait for the cheaper one.
 *
 *   3. 503 IS NOT A FAILURE. ALERT_TEMPORARILY_UNAVAILABLE means the
 *      resolver's context was degraded — «ask again later» — and a screen that
 *      renders it as «فشل» is telling the customer something untrue.
 *
 * There is no browser DOM runner in this repository, so the markup contracts
 * are asserted against the source the way tests/uiSystem.test.ts does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_ALERT_TARGETS,
  alertRefusalText,
  buildAlertTargets,
  channelName,
  decodeAlertIntent,
  encodeAlertIntent,
  isPerTargetRefusal,
  productPathWithIntent,
  wishKey,
  wishOfRow,
  type StockAlertWish,
} from '../src/components/product/stockAlertTargets';
import { sanitizeNextPath } from '../src/components/auth/nextPath';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PANEL = 'src/components/product/StockAlertPanel.tsx';
const TARGETS = 'src/components/product/stockAlertTargets.ts';
const PRODUCT = 'src/pages/Product.tsx';

// ---------------------------------------------------------------- the rule

test('one option group gets per-model rows, exactly as the owner asked', () => {
  const targets = buildAlertTargets({
    models: [
      { id: 'pov_a1', label: 'A1' },
      { id: 'pov_combo', label: 'A1 Combo' },
    ],
    optionGroupCount: 1,
    colorId: '',
    productLabel: 'Any model',
  });
  // The wide row first, then one row per model: a customer who just wants the
  // shelf back must not have to tick every model.
  assert.deepEqual(
    targets.map((t) => t.label),
    ['Any model', 'A1', 'A1 Combo']
  );
  assert.deepEqual(targets[1].wish, { kind: 'option_value', optionValueId: 'pov_a1', colorId: '' });
  assert.deepEqual(targets[2].wish, { kind: 'option_value', optionValueId: 'pov_combo', colorId: '' });
  assert.deepEqual(targets[0].wish, { kind: 'product', optionValueId: '', colorId: '' });
});

test('a single model needs no «any model» row — two rows would arm the same thing twice', () => {
  const targets = buildAlertTargets({
    models: [{ id: 'pov_only', label: 'A1' }],
    optionGroupCount: 1,
    colorId: '',
    productLabel: 'Any model',
  });
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].wish, { kind: 'option_value', optionValueId: 'pov_only', colorId: '' });
});

test('TWO option groups collapse to the product, because no row can name a model there', () => {
  /*
   * The failure this prevents: arming `option_value = A1` on a product whose
   * second group is the nozzle fires the moment ANY completion containing A1
   * is buyable. The customer is told «رجع A1 كومبو», arrives, and finds the
   * nozzle they wanted still gone.
   */
  const targets = buildAlertTargets({
    models: [
      { id: 'pov_a1', label: 'A1' },
      { id: 'pov_combo', label: 'A1 Combo' },
    ],
    optionGroupCount: 2,
    colorId: '',
    productLabel: 'The printer',
  });
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].wish, { kind: 'product', optionValueId: '', colorId: '' });
});

test('a product with no models at all offers the product row', () => {
  const targets = buildAlertTargets({ models: [], optionGroupCount: 0, colorId: '', productLabel: 'Filament' });
  assert.deepEqual(targets, [
    { key: 'all', label: 'Filament', wish: { kind: 'product', optionValueId: '', colorId: '' } },
  ]);
});

test("the page's colour changes the KIND rather than the list", () => {
  const withColour = buildAlertTargets({
    models: [
      { id: 'pov_a1', label: 'A1' },
      { id: 'pov_combo', label: 'A1 Combo' },
    ],
    optionGroupCount: 1,
    colorId: 'pc_black',
    productLabel: 'Any model',
    colorLabel: 'Black',
  });
  assert.deepEqual(withColour[0].wish, { kind: 'color', optionValueId: '', colorId: 'pc_black' });
  assert.deepEqual(withColour[1].wish, { kind: 'combination', optionValueId: 'pov_a1', colorId: 'pc_black' });
  // The wide row is NAMED by the colour, so «أي موديل» never silently means
  // «أي لون» once a colour is in force.
  assert.equal(withColour[0].label, 'Black');
});

test('the row list is capped at what one save may carry', () => {
  const models = Array.from({ length: 40 }, (_, i) => ({ id: `pov_${i}`, label: `M${i}` }));
  const targets = buildAlertTargets({ models, optionGroupCount: 1, colorId: '', productLabel: 'Any' });
  // MAX_WISHES_PER_PRODUCT on the route is 20; a sheet that let somebody tick
  // 40 would be refused wholesale at Save for a limit never shown to them.
  assert.equal(targets.length, MAX_ALERT_TARGETS);
});

test('the four kinds this UI emits are the four the server stores', () => {
  const route = read('worker/routes/stockAlerts.ts');
  assert.match(route, /const ALERT_KINDS = \['product', 'option_value', 'color', 'combination'\] as const;/);
  // The per-model picker is only honest while the SERVER can arm per option
  // value. If that kind ever leaves the route, this test fails here rather
  // than in production with a picker whose choices are discarded.
  const kinds = new Set(
    buildAlertTargets({
      models: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      optionGroupCount: 1,
      colorId: 'c',
      productLabel: 'p',
    }).map((t) => t.wish.kind)
  );
  assert.ok(kinds.has('combination'));
  assert.ok(kinds.has('color'));
});

test('the wish identity is the one the unique index uses', () => {
  // Same three fields, same order, same JSON encoding as the route's wishKey —
  // a joined string would merge two wishes the day an id held the separator.
  assert.equal(
    wishKey({ kind: 'combination', optionValueId: 'a', colorId: 'b' }),
    JSON.stringify(['combination', 'a', 'b'])
  );
  assert.equal(
    wishKey(
      wishOfRow({
        id: 'psa_1',
        product_id: 'p1',
        kind: 'option_value',
        option_value_id: 'pov_a1',
        color_id: '',
        state: 'armed',
        arm_seq: 1,
        armed_channel: 'telegram',
        armed_at: '',
        notified_at: '',
        dead_reason: '',
      })
    ),
    wishKey({ kind: 'option_value', optionValueId: 'pov_a1', colorId: '' })
  );
});

// --------------------------------------------- the choice survives sign-in

test('a choice rides through /auth?next= and comes back intact', () => {
  const wishes: StockAlertWish[] = [
    { kind: 'option_value', optionValueId: 'pov_combo', colorId: '' },
    { kind: 'combination', optionValueId: 'pov_a1', colorId: 'pc_black' },
    { kind: 'product', optionValueId: '', colorId: '' },
  ];
  const dest = productPathWithIntent('bambu-a1', wishes);
  // The existing next-path sanitiser must accept it verbatim: a destination it
  // rewrites to '/' is a customer dumped on the home page after signing in.
  assert.equal(sanitizeNextPath(dest), dest);
  const search = dest.slice(dest.indexOf('?'));
  const back = decodeAlertIntent(new URLSearchParams(search).get('alert'));
  assert.deepEqual(back, wishes);
});

test('a product with no choice yet still gets a clean return path', () => {
  assert.equal(productPathWithIntent('bambu-a1', []), '/product/bambu-a1');
});

test('the intent is read as untrusted input and never half-trusted', () => {
  assert.deepEqual(decodeAlertIntent(null), []);
  assert.deepEqual(decodeAlertIntent(''), []);
  assert.deepEqual(decodeAlertIntent('nonsense'), []);
  // An id outside the generated charset is dropped WHOLE, never truncated into
  // a different, valid-looking id.
  assert.deepEqual(decodeAlertIntent('o:../../etc'), []);
  assert.deepEqual(decodeAlertIntent('o:a b'), []);
  assert.deepEqual(decodeAlertIntent(`o:${'x'.repeat(61)}`), []);
  assert.deepEqual(decodeAlertIntent('o:~c:'), []);
  // A good token beside a bad one keeps only the good one.
  assert.deepEqual(decodeAlertIntent('o:pov_a1,o:bad id'), [
    { kind: 'option_value', optionValueId: 'pov_a1', colorId: '' },
  ]);
  // Repeats collapse on the same identity the unique index uses.
  assert.deepEqual(decodeAlertIntent('p,p,p'), [{ kind: 'product', optionValueId: '', colorId: '' }]);
  // A hand-written URL cannot make the sheet draw a hundred rows.
  const many = Array.from({ length: 30 }, (_, i) => `o:pov_${i}`).join(',');
  assert.ok(decodeAlertIntent(many).length <= 8);
});

test('an unencodable wish is dropped rather than encoded wrong', () => {
  assert.equal(encodeAlertIntent([{ kind: 'combination', optionValueId: 'a', colorId: '' }]), '');
  assert.equal(encodeAlertIntent([{ kind: 'option_value', optionValueId: '', colorId: '' }]), '');
  assert.equal(encodeAlertIntent([{ kind: 'color', optionValueId: '', colorId: 'pc_1' }]), 'c:pc_1');
});

// ------------------------------------------------------------- the refusals

/** Every code the route can answer with, from worker/routes/stockAlerts.ts. */
const CODES = [
  'ALERT_TEMPORARILY_UNAVAILABLE',
  'ALERT_NOT_A_STOCK_TARGET',
  'ALERT_VARIANT_NOT_MODELLED',
  'ALERT_TARGET_REMOVED',
  'ALERT_TARGET_INACTIVE',
  'ALERT_PRODUCT_UNAVAILABLE',
  'ALERT_UNTRACKED',
  'ALERT_PREORDER_ONLY',
  'ALERT_COMPOSITION',
  'ALERT_LIMIT_REACHED',
  'TOO_MANY_ALERTS',
  'RATE_LIMITED',
  'NOT_FOUND',
];

test('every refusal code has its own sentence in all three languages', () => {
  for (const code of CODES) {
    const err = { code, message: 'server sentence' };
    const ar = alertRefusalText(err, 'ar', 'fallback');
    const en = alertRefusalText(err, 'en', 'fallback');
    const ckb = alertRefusalText(err, 'ckb', 'fallback');
    for (const [name, text] of [['ar', ar], ['en', en], ['ckb', ckb]] as const) {
      assert.notEqual(text, 'fallback', `${code} has no ${name} sentence`);
      assert.notEqual(text, 'server sentence', `${code} falls through to the bilingual server string in ${name}`);
      assert.ok(text.trim().length > 0, `${code} ${name} is empty`);
    }
    /*
     * 'ckb' IS ALSO RTL, which is exactly how 264 sites in this codebase came
     * to serve Arabic to every Kurdish reader. Identical ar and ckb strings
     * are that bug in its finished form, so they fail here.
     */
    assert.notEqual(ckb, ar, `${code} serves Arabic to Kurdish readers`);
    assert.notEqual(ckb, en, `${code} serves English to Kurdish readers`);
    assert.notEqual(ar, en, `${code} is not translated`);
  }
});

test('the codes the route can send are the codes this table answers', () => {
  const route = read('worker/routes/stockAlerts.ts');
  for (const code of CODES) {
    if (code === 'RATE_LIMITED' || code === 'NOT_FOUND') continue; // from lib/http helpers
    const emitted = code.startsWith('ALERT_') ? code.slice('ALERT_'.length) : code;
    assert.ok(
      route.includes(`'${code}'`) || route.includes(`ALERT_\${refusal}`) || route.includes(`'${emitted}'`),
      `${code} is no longer something the route sends`
    );
  }
});

test('503 reads as «ask again later», never as a failure', () => {
  const err = { code: 'ALERT_TEMPORARILY_UNAVAILABLE', message: 'x' };
  const ar = alertRefusalText(err, 'ar', 'f');
  const en = alertRefusalText(err, 'en', 'f');
  // The request was fine and the next one usually succeeds: the sentence has
  // to invite a retry and must not blame the customer's request.
  assert.match(ar, /جرّب مرة ثانية/);
  assert.doesNotMatch(ar, /فشل|خطأ/);
  assert.match(en, /try again/i);
  assert.doesNotMatch(en, /failed|error/i);
  // It is NOT a per-target refusal: nothing about the ticked rows was wrong,
  // so the sheet must not tell them to remove one.
  assert.equal(isPerTargetRefusal('ALERT_TEMPORARILY_UNAVAILABLE'), false);
  assert.equal(isPerTargetRefusal('ALERT_PREORDER_ONLY'), true);
  assert.equal(isPerTargetRefusal('ALERT_VARIANT_NOT_MODELLED'), true);
});

test('an unknown code still says something, in the server\'s own words', () => {
  assert.equal(alertRefusalText({ code: 'SOMETHING_NEW', message: 'the sentence' }, 'ar', 'f'), 'the sentence');
  assert.equal(alertRefusalText({}, 'en', 'fallback'), 'fallback');
});

test('the channel sentence names the channel the SERVER picked', () => {
  for (const id of ['inapp', 'telegram', 'whatsapp', 'email']) {
    assert.ok(channelName(id, 'ar').length > 0);
    assert.ok(channelName(id, 'ckb').length > 0);
    assert.notEqual(channelName(id, 'ckb'), channelName(id, 'ar'));
  }
  // An unrecognised channel falls back to the floor rather than printing the
  // machine id at a customer.
  assert.equal(channelName('mars', 'ar'), channelName('inapp', 'ar'));
});

// ------------------------------------------------------------- the screen

test('the affordance sits under «طريقة التوفر» and only where an alert can be honest', () => {
  const product = read(PRODUCT);
  assert.match(product, /import StockAlertPanel from '\.\.\/components\/product\/StockAlertPanel';/);
  // Offered exactly when the SERVER says direct sale is offered and empty.
  assert.match(product, /const directOutOfStock = modesArr\.some\(/);
  assert.match(product, /m\.type === 'direct_sale' && !m\.usable && m\.reason === 'OUT_OF_STOCK'/);
  assert.match(product, /const stockAlertOffered = source === 'catalog' && directOutOfStock;/);
  assert.match(product, /\{stockAlertOffered \? \([\s\S]{0,400}<StockAlertPanel/);
  // Placed between the fulfilment chooser and the transports, i.e. directly
  // under the disabled «بيع مباشر» card the customer just read.
  const chooser = product.indexOf('data-fulfilment-chooser');
  const panel = product.indexOf('<StockAlertPanel');
  const transports = product.indexOf('{showTransports ? (');
  assert.ok(chooser > 0 && panel > chooser, 'the panel comes after the fulfilment chooser');
  assert.ok(panel < transports, 'the panel comes before the transports');
  // The existing sold-out-but-orderable sentence is still the page's, and the
  // panel is built on the same server verdict rather than a second guess.
  assert.match(product, /const directSoldOutPreorderOpen = preUsable && directOutOfStock;/);
});

test('the page hands the panel the model list the per-model rule needs', () => {
  const product = read(PRODUCT);
  assert.match(product, /optionGroupCount=\{relationOptionGroups\.length\}/);
  assert.match(product, /const alertModels: AlertModel\[\] =\s*\n\s*relationOptionGroups\.length === 1/);
  assert.match(product, /selectedColorId=\{colorId\}/);
  assert.match(product, /isAuthenticated=\{isAuthenticated\}/);
});

test('the choice from the URL opens the sheet and is then dropped from the URL', () => {
  const product = read(PRODUCT);
  assert.match(product, /decodeAlertIntent\(new URLSearchParams\(location\.search\)\.get\('alert'\)\)/);
  assert.match(product, /params\.delete\('alert'\)/);
  // REPLACE, not push: a Back that only removes a query parameter is a Back
  // that appears not to work.
  assert.match(product, /navigate\(`\$\{location\.pathname\}[^\n]*\{ replace: true \}\)/);
});

test('the copy never says the product is unavailable, because it is not', () => {
  const source = read(PANEL);
  const targets = read(TARGETS);
  // Only the STRINGS table — the module note quotes the forbidden sentence in
  // order to forbid it, and a test that could not tell the two apart would be
  // a test nobody could document around.
  const from = source.indexOf('const STRINGS = {');
  const to = source.indexOf('} as const;', from);
  assert.ok(from > 0 && to > from, 'the sheet has no STRINGS table');
  const panel = source.slice(from, to);
  /*
   * Direct sale is sold out and PRE-ORDER IS OPEN. The product can be bought
   * today by the other route at a higher price; the customer arming an alert
   * is choosing to wait for the cheaper one. «هذا المنتج غير متوفر» would be
   * false, and it would talk a buyer out of a purchase they could make now.
   */
  assert.doesNotMatch(panel, /هذا المنتج غير متوفر|المنتج غير متوفر/);
  assert.doesNotMatch(panel, /out of stock[^—]*unavailable/i);
  // The sheet names what the wait is FOR.
  assert.match(panel, /الطلب المسبق مفتوح/);
  assert.match(panel, /سعر البيع المباشر/);
  assert.match(panel, /cheaper direct-sale price/);
  // The panel takes the page's own per-type verdict as its reason to exist.
  assert.match(source, /preorderOpen \? s\.introPreorder : s\.introPlain/);
  // The refusal that IS about the product being off display stays available
  // for the server to send — it is just never the panel's own voice.
  assert.match(targets, /ALERT_PRODUCT_UNAVAILABLE/);
});

test('every sheet string exists in ar, en and ckb', () => {
  const panel = read(PANEL);
  const block = (name: string): string[] => {
    const start = panel.indexOf(`  ${name}: {`);
    assert.ok(start > 0, `no ${name} block`);
    const end = panel.indexOf('\n  },', start);
    assert.ok(end > start, `${name} block is unterminated`);
    return [...panel.slice(start, end).matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort();
  };
  const ar = block('ar');
  const en = block('en');
  const ckb = block('ckb');
  assert.ok(ar.length >= 20, 'the sheet has fewer strings than it renders');
  assert.deepEqual(en, ar, 'en is missing a string ar has');
  assert.deepEqual(ckb, ar, 'ckb is missing a string ar has');
});

/**
 * KEY NAMES ARE NOT TRANSLATIONS.
 *
 * The test above extracts KEY NAMES and compares the three lists, so pasting
 * the whole `ar` block's VALUES into `ckb` leaves it green — which is the
 * 264-site bug in its finished form, inside the file written to avoid it. The
 * refusal table has always had this guard (`ckb !== ar && ckb !== en`); the
 * sheet's own strings did not. Values, not keys.
 */
test('no Kurdish sheet string is a copy of its Arabic or English twin', () => {
  const panel = read(PANEL);
  const values = (name: string): Map<string, string> => {
    const start = panel.indexOf(`  ${name}: {`);
    assert.ok(start > 0, `no ${name} block`);
    const end = panel.indexOf('\n  },', start);
    assert.ok(end > start, `${name} block is unterminated`);
    const out = new Map<string, string>();
    // Only plain string literals — a key whose value is a function (the
    // templates) has nothing to compare and is skipped by this pattern.
    for (const m of panel.slice(start, end).matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*): '((?:[^'\\]|\\.)*)',?$/gm)) {
      out.set(m[1], m[2]);
    }
    return out;
  };
  const ar = values('ar');
  const en = values('en');
  const ckb = values('ckb');
  assert.ok(ckb.size >= 15, 'too few plain strings were read to be a real check');
  for (const [key, text] of ckb) {
    assert.notEqual(text, ar.get(key), `ckb.${key} is the Arabic string — a Kurdish reader gets Arabic`);
    assert.notEqual(text, en.get(key), `ckb.${key} is the English string`);
  }
});

/**
 * THE CHANNEL SENTENCE IS THE ONE THE CUSTOMER ACTS ON.
 *
 * It names where the «رجع!» message will arrive. With bare channel nouns it
 * read «راح نخبرك تيليغرام» — no preposition — in the language most of these
 * customers read, and "We will tell you Telegram" in English. Nothing tested
 * the rendered sentence; `channelName(id, lang).length > 0` passes on any
 * word at all.
 */
test('the confirmation names the channel with a preposition, in every language', () => {
  for (const channel of ['telegram', 'whatsapp', 'email', 'inapp'] as const) {
    assert.match(channelName(channel, 'ar'), /^(على|داخل) /, `ar/${channel}`);
    assert.match(channelName(channel, 'ckb'), /^(لە |بە |لەناو )/, `ckb/${channel}`);
    assert.match(channelName(channel, 'en'), /^(on|by|in) /, `en/${channel}`);
  }
});

/** The armed tick is drawn only under aria-pressed — see src/index.css. */
test('the armed trigger says so in a way the stylesheet and a screen reader can read', () => {
  const panel = read(PANEL);
  assert.match(panel, /aria-pressed=\{hasArmed\}/, 'the trigger must carry aria-pressed');
  assert.match(panel, /data-stock-alert-armed/);
});

test('neither new file reaches for the two-language idiom', () => {
  for (const path of [PANEL, TARGETS]) {
    const source = read(path);
    /*
     * `dir === 'rtl' ? ar : en` serves Arabic to every Kurdish reader, because
     * 'ckb' is RTL too. There are already 264 of these in this codebase and
     * these two files add none.
     */
    assert.doesNotMatch(source, /dir\s*===\s*'rtl'\s*\?/);
    assert.doesNotMatch(source, /lang\s*===\s*'ar'\s*\?[^\n]*:\s*[^\n]*\ben\b/);
  }
});

test('the save is the server\'s one atomic batch, never delete-then-add', () => {
  const panel = read(PANEL);
  assert.match(panel, /api\.put<StockAlertSaveResponse>\(`\/api\/stock-alerts\/product\/\$\{productId\}`/);
  assert.match(panel, /api\.get<StockAlertsForProductResponse>\(`\/api\/stock-alerts\/product\/\$\{productId\}`\)/);
  // Cancelling everything is a save of an EMPTY SET through the same batch, so
  // a failure can never leave the customer half-cancelled.
  assert.match(panel, /void save\(\[\]\)/);
  assert.doesNotMatch(panel, /api\.delete\(`\/api\/stock-alerts/);
  // Armed rows the current sheet cannot represent are carried through the
  // replace, or Save would silently cancel something off screen.
  assert.match(panel, /const selectedWishes = useMemo\(\s*\n\s*\(\) => \[\.\.\.carried,/);
});

test('a signed-out visitor is sent to sign in and back with the choice', () => {
  const panel = read(PANEL);
  assert.match(panel, /productPathWithIntent\(productSlug, selectedWishes\)/);
  assert.match(panel, /navigate\(`\/auth\?next=\$\{encodeURIComponent\(dest\)\}`\)/);
  // A 401 arriving mid-flight is the same bounce, not a red error line.
  assert.match(panel, /e instanceof ApiError && e\.status === 401[\s\S]{0,80}toSignIn\(\)/);
  // …and the sheet says so BEFORE the tap, so the redirect is not a surprise.
  assert.match(panel, /data-stock-alert-signin/);
});

test('every state the customer can be in has its own honest line', () => {
  const panel = read(PANEL);
  for (const probe of [
    'data-stock-alert-trigger', // not armed / armed
    'data-stock-alert-armed', // armed, with what it is armed for
    'data-stock-alert-save', // arming (busy)
    'data-stock-alert-done', // confirmed, naming the server's channel
    'data-stock-alert-error', // refused
    'data-stock-alert-carried', // an alert this sheet cannot represent
    'data-stock-alert-signin', // needs sign-in
    'data-stock-alert-colour', // which colour the wish carries
  ]) {
    assert.ok(panel.includes(probe), `${probe} is missing`);
  }
  // The option that disappeared is SAID, never rendered as a bare id.
  assert.match(panel, /gone: 'خيار ما عاد معروض'/);
  assert.match(panel, /models\.find\(\(m\) => m\.id === wish\.optionValueId\)/);
  // The confirmation names the channel the server picked, from its answer.
  assert.match(panel, /s\.doneOn\(channelName\(done\.channel, L\)\)/);
  // The retry label appears only for the answer that deserves one.
  assert.match(panel, /errorCode === 'ALERT_TEMPORARILY_UNAVAILABLE' \? s\.retry/);
});

test('the sheet obeys the design system', () => {
  const panel = read(PANEL);
  // Hit targets: nothing tappable under 44px.
  for (const target of ['min-h-\\[52px\\]', 'min-h-\\[48px\\]', 'min-h-\\[44px\\]', 'h-11 w-11']) {
    assert.match(panel, new RegExp(target));
  }
  // Selection uses the canonical primitive with a real accessible state.
  assert.match(panel, /className="lv-choice[^"]*"[\s\S]{0,40}/);
  assert.match(panel, /aria-pressed=\{on\}/);
  // Focus is visible on every control this file draws itself.
  const interactive = [...panel.matchAll(/<button[\s\S]{0,900}?className="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(interactive.length >= 4);
  for (const cls of interactive) {
    assert.ok(
      cls.includes('focus-visible:ring') || cls.includes('lv-button'),
      `a control has no visible focus: ${cls}`
    );
  }
  // Logical properties only: 'ckb' and 'ar' are RTL and 'en' is not, so a
  // physical side is wrong in one of them.
  assert.doesNotMatch(panel, /className="[^"]*\b(ml|mr|pl|pr)-\d/);
  assert.doesNotMatch(panel, /className="[^"]*\b(left|right)-\d/);
  assert.doesNotMatch(panel, /text-(left|right)\b/);
  assert.doesNotMatch(panel, /border-(l|r)-\d/);
  // An arbitrary text size with no leading inherits a line height meant for a
  // different size — the bug that makes Arabic diacritics clip.
  for (const [, cls] of panel.matchAll(/className="([^"]+)"/g)) {
    if (/text-\[\d/.test(cls)) assert.ok(/leading-/.test(cls), `no explicit leading: ${cls}`);
  }
  // The sheet scrolls inside itself and clears the home indicator, rather
  // than pinning anything to the viewport bottom.
  assert.match(panel, /overflow-y-auto overscroll-contain/);
  assert.match(panel, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(panel, /fixed bottom-0/);
});
