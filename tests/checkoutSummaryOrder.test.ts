/**
 * «هذا السلوك غير مناسب ويسبب ارتباك» — THE CHECKOUT PRICE COLUMN, IN ORDER.
 *
 * The owner read their own checkout screen and could not follow it:
 *
 *   المجموع الفرعي → الشحن → ملاحظة → كود الخصم → استخدام النقاط →
 *   ملاحظة أخرى → استخدام المحفظة
 *
 * Three different KINDS of thing were interleaved — figures, explanations and
 * controls — so a customer adding the column up was interrupted twice by prose
 * and twice by an input box. The instruction was to put every detail under the
 * subtotal, then the notes, then the ways to pay, in that order.
 *
 * WHY THIS FILE IS SOURCE-ORDER ASSERTIONS. The bug is not that any one row
 * renders wrongly — every row rendered correctly before. The bug is the
 * SEQUENCE, and sequence is the one property a render test of a single block
 * cannot see. So this file reads the file and pins the order of the markers,
 * which is exactly the property that regressed.
 *
 * It also pins the three things that are easy to "tidy" back into bugs:
 *
 *   - «تكلفة التوصيل إلى البيت», never «الشحن» — the fee is per product and
 *     per piece, and the word «الشحن» promises one flat figure.
 *   - the cash-on-delivery commission is drawn QUIET and never summed: a
 *     pre-order paid at the door is already priced as a direct sale, so the
 *     difference is inside the subtotal and a second ordinary row would charge
 *     it twice on screen.
 *   - the tax explanation quotes the POLICY MODULE's constants, so the «!»
 *     cannot drift away from the rate the server actually charges.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { COD_TAX_BLOCK_IQD, COD_TAX_PER_BLOCK_IQD } from '../packages/shipping/src/codTax.ts';

const CHECKOUT = readFileSync(new URL('../src/pages/Checkout.tsx', import.meta.url), 'utf8');
const PROMO = readFileSync(new URL('../src/components/PromoCodeField.tsx', import.meta.url), 'utf8');
const INFO = readFileSync(new URL('../src/components/ui/SummaryInfo.tsx', import.meta.url), 'utf8');

/** Where a marker first appears, refusing a marker that is not there at all. */
function at(haystack: string, needle: string): number {
  const i = haystack.indexOf(needle);
  assert.ok(i >= 0, `marker missing from the source: ${needle}`);
  return i;
}

/** Assert markers appear in this order, naming the first pair out of place. */
function inOrder(haystack: string, markers: Array<[string, string]>): void {
  let prevName = '';
  let prevAt = -1;
  for (const [name, needle] of markers) {
    const here = at(haystack, needle);
    assert.ok(
      here > prevAt,
      `«${name}» must come after «${prevName}» in the summary column, but it comes before it`
    );
    prevName = name;
    prevAt = here;
  }
}

test('the money column runs: goods → arrival → notes → settlement', () => {
  // The whole owner instruction, as one ordered list. Each marker is the
  // thing itself, not a comment about it, so moving a block moves the proof.
  inOrder(CHECKOUT, [
    ['المجموع الفرعي', "loc('المجموع الفرعي', 'Subtotal')"],
    ['خصم العضوية', 'data-checkout-member-discount'],
    ['خصم الكود', "loc('خصم الكود', 'Promo discount')"],
    ['خصم النقاط', "loc('خصم النقاط', 'Points Discount')"],
    ['تكلفة التوصيل إلى البيت', 'testId="delivery"'],
    ['ضريبة شركة التوصيل', 'testId="cod-tax"'],
    ['إعفاء العضوية', 'data-checkout-cod-tax-exemption'],
    ['عمولة الدفع عند الاستلام', 'testId="cod-commission"'],
    ['ملاحظة أساس التسعير', 'data-checkout-pricing-basis'],
    ['ملاحظة الطابعة', 'testId="checkout-printer-note"'],
    ['استخدام كود خاص', 'data-checkout-promo-toggle'],
    ['استخدام المحفظة', "loc('استخدام المحفظة', 'Use Wallet')"],
    ['استخدام النقاط', "loc('استخدام النقاط', 'Use points', 'بەکارهێنانی خاڵ')"],
    ['إجمالي الطلب', 'data-testid="checkout-order-total"'],
    ['إجمالي عند الاستلام', 'data-testid="checkout-due-on-delivery"'],
  ]);
});

test('every note sits BELOW every summed figure, so no prose splits an addition', () => {
  // The two notes the owner named by hand were the ones interrupting the
  // column. Whatever else moves, no note may climb back above the last figure.
  const lastFigure = Math.max(
    at(CHECKOUT, 'testId="cod-tax"'),
    at(CHECKOUT, 'data-checkout-cod-tax-exemption'),
    at(CHECKOUT, 'testId="cod-commission"')
  );
  for (const note of [
    'data-checkout-pricing-basis',
    'testId="checkout-prepaid-by-wallet"',
    'testId="checkout-printer-note"',
  ]) {
    assert.ok(at(CHECKOUT, note) > lastFigure, `the note ${note} is above a summed figure again`);
  }
});

test('every control sits BELOW every note, so the price is read before it is paid', () => {
  const lastNote = at(CHECKOUT, 'testId="checkout-printer-note"');
  for (const control of [
    'data-checkout-promo-toggle',
    "loc('استخدام المحفظة', 'Use Wallet')",
    "loc('استخدام النقاط', 'Use points', 'بەکارهێنانی خاڵ')",
  ]) {
    assert.ok(at(CHECKOUT, control) > lastNote, `the control ${control} climbed back above the notes`);
  }
});

test('the delivery row says «تكلفة التوصيل إلى البيت», and the word «الشحن» is gone from it', () => {
  assert.ok(
    CHECKOUT.includes("loc('تكلفة التوصيل إلى البيت', 'Home delivery cost')"),
    'the delivery label must name what it is: the cost of getting the order to the house'
  );
  assert.ok(
    !CHECKOUT.includes("'الشحن' : 'Shipping'"),
    '«الشحن» promises one flat fee for the parcel; this fee is per product and per piece'
  );
});

test('the delivery «!» answers with the SERVER components and the SERVER reasons', () => {
  const panel = CHECKOUT.slice(at(CHECKOUT, 'testId="delivery"'), at(CHECKOUT, '</SummaryInfo>'));
  assert.ok(panel.includes('quote.shipping.components.map'), 'the breakdown must be inside the answer');
  assert.ok(panel.includes('quote.shipping.reasons.map'), 'the waiver reasons must be inside the answer');
  assert.ok(
    /حسب كل منتج وعدد قطعه/.test(panel),
    'the answer must say the fee is per product and per number of pieces'
  );
  // The breakdown used to be a permanent box below the row, so every customer
  // paid the vertical space whether they wondered or not. It is an answer now.
  assert.ok(
    !CHECKOUT.includes('rounded-lg border border-white/5 bg-white/[0.025] px-3 py-2 space-y-1.5'),
    'the components breakdown is back as an always-open box'
  );
});

test('the tax is named after WHO takes it, and the «!» quotes the policy module', () => {
  assert.ok(CHECKOUT.includes("codTax: 'ضريبة شركة التوصيل',"), 'the Arabic name must say whose tax it is');
  assert.ok(CHECKOUT.includes("codTax: 'Delivery company tax',"), 'the English name must match');
  // The hand-written Sorani is left exactly as a Kurdish speaker wrote it.
  assert.ok(
    CHECKOUT.includes("codTax: 'باجی پارەدان لە کاتی گەیاندن',"),
    'the Sorani name is hand-written and must not be machine-renamed'
  );
  /**
   * THE RATE IS THE ADMINISTRATOR'S NOW, so the sentence must quote the
   * CONFIGURED pair rather than the compiled constants.
   *
   * The old assertion — that the sentence interpolates the constants — was
   * right when the rate could only change by a deploy, and became exactly
   * wrong when it could change from a form: a screen quoting 3,000 beside a
   * charge of 10,000 is the drift this whole test exists to prevent, just in
   * the other direction. The constants are still imported, because a client
   * talking to a server older than the setting needs a real number to fall
   * back to, and that fallback is asserted too.
   */
  assert.ok(
    CHECKOUT.includes("import { COD_TAX_BLOCK_IQD, COD_TAX_PER_BLOCK_IQD } from '../../packages/shipping/src/codTax'"),
    'the compiled default must still be imported as the fallback'
  );
  assert.ok(
    CHECKOUT.includes('${formatIqd(codTaxPerBlockIqd)} عن كل ${formatIqd(codTaxBlockIqd)}'),
    'the «!» must state the rate the server was configured with'
  );
  assert.ok(
    CHECKOUT.includes("const codTaxPerBlockIqd = settingRate(settings?.codTaxPerBlockIqd, COD_TAX_PER_BLOCK_IQD);"),
    'and that rate must come from the public settings, falling back to the constant'
  );
  assert.ok(
    CHECKOUT.includes("const codTaxBlockIqd = settingRate(settings?.codTaxBlockIqd, COD_TAX_BLOCK_IQD);"),
    'both halves of the rate, or the sentence divides by the wrong block'
  );
  // The owner halved it: «اجعلها 3 الف لكل 500 الف». This is the DEFAULT an
  // unconfigured shop charges, not a ceiling.
  assert.equal(COD_TAX_PER_BLOCK_IQD, 3_000);
  assert.equal(COD_TAX_BLOCK_IQD, 500_000);
  // WHERE `data-checkout-cod-tax` WENT. The row is a <SummaryInfo> now, and
  // the component stamps `data-summary-row` on every row it owns — so the hook
  // was renamed, not dropped. Nothing in the repo referenced the old name; this
  // assertion is here so the next person looking for it finds the answer.
  assert.ok(!CHECKOUT.includes('data-checkout-cod-tax>'), 'the hand-rolled tax row is back');
  assert.ok(INFO.includes('data-summary-row={testId}'), 'every explained row must stay addressable');
});

test('the cash-on-delivery commission is shown but never summed', () => {
  const block = CHECKOUT.slice(at(CHECKOUT, 'testId="cod-commission"'));
  assert.ok(block.includes('tone="quiet"'), 'a figure that is not summed must not be drawn like one that is');
  assert.ok(
    CHECKOUT.includes('{codDirectPricing && codSurchargeIqd > 0 && ('),
    'the row belongs only to a pre-order the door re-priced as a direct sale'
  );
  assert.ok(
    /محسوب أصلاً داخل أسعار المنتجات/.test(block),
    'the answer must say the money is already inside the subtotal, so nobody adds it twice'
  );
});

test('the promo code is a quiet line that expands, and opens itself when a code is live', () => {
  assert.ok(
    CHECKOUT.includes("loc('استخدام كود خاص', 'Use a special code')"),
    'the owner asked for «سطر ناعم استخدام كود خاص»'
  );
  assert.ok(
    CHECKOUT.includes('const promoOpen = showPromoField || !!quote?.coupon || !!couponCode;'),
    'a customer with a code already applied must find the field open, not hidden'
  );
  assert.ok(
    CHECKOUT.includes('aria-controls="checkout-promo-field"') && CHECKOUT.includes('id="checkout-promo-field"'),
    'the disclosure must announce what it controls'
  );
  // The caller names the control, so the field must not repeat the name.
  assert.ok(CHECKOUT.includes('showLabel={false}'), 'checkout must suppress the field’s own heading');
  assert.ok(PROMO.includes('showLabel = true'), 'the cart, which has no other label, keeps its heading');
});

test('the wallet balance is stated twice, not three times', () => {
  // «رصيد مستخدم −X» was a third statement of `walletDiscount`, between the
  // wallet block that had just announced it and the total that accounts for
  // it. Two places, each doing a different job: the toggle's own feedback,
  // and the settlement line under the total.
  assert.ok(!CHECKOUT.includes("'رصيد مستخدم' : 'Used Balance'"), 'the duplicate wallet row is back');
  assert.ok(CHECKOUT.includes("loc('مدفوع من المحفظة', 'Paid from your wallet', 'لە جزدان درا')"));
  assert.ok(CHECKOUT.includes('`خصم ${walletDiscount.toLocaleString()} د.ع`'));
});

test('no money label in the column decides its LANGUAGE from the text DIRECTION', () => {
  // `dir` is 'rtl' for Arabic and for Kurdish alike, so `dir === 'rtl' ? ar :
  // en` is a direction test wearing a language test's clothes: it hands every
  // Sorani reader the Arabic string and hides the gap from anyone grepping for
  // missing translations. `loc(ar, en)` renders exactly the same thing and
  // leaves the empty Kurdish slot in plain sight.
  const column = CHECKOUT.slice(
    at(CHECKOUT, "loc('المجموع الفرعي', 'Subtotal')"),
    at(CHECKOUT, 'data-testid="checkout-order-total"')
  );
  //
  // Scoped to ternaries whose branch is ARABIC TEXT. `dir === 'rtl'` is still
  // the right test for GEOMETRY — the wallet knob below travels
  // `-translate-x-6` in Arabic and `translate-x-6` in English, and that is a
  // direction question with a direction answer. Only the ones choosing a
  // SENTENCE are the bug.
  const ternaries =
    column
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
      .match(/dir === 'rtl'\s*\?\s*["'`][^"'`]*[؀-ۿ]/g) ?? [];
  assert.equal(
    ternaries.length,
    0,
    `${ternaries.length} label(s) in the summary column still pick their language from the text direction: ${ternaries.join(' | ')}`
  );
});

test('the «!» is a disclosure, not a tooltip, because the owner works on an iPad', () => {
  assert.ok(INFO.includes('aria-expanded={open}'), 'it must announce its state');
  assert.ok(INFO.includes('aria-controls={panelId}'), 'it must name the panel it opens');
  assert.ok(INFO.includes('onClick={() => setOpen((v) => !v)}'), 'a tap must both open and close it');
  assert.ok(!/onMouseEnter|onMouseOver|:hover\s*\{/.test(INFO), 'a hover-only affordance never opens on a touch screen');
  // The panel is a SIBLING of the row, below it — never drawn over the next
  // figure, which is the number the customer opened it to check.
  assert.ok(!INFO.includes('absolute'), 'the answer must push the rows down, not cover them');
  assert.ok(INFO.includes("loc('إخفاء', 'Hide', 'شاردنەوە')"), 'it must close the way it opened');
  // «علامة تعجب», the owner's word — an exclamation, not the circled «i» a
  // designer reaches for by habit.
  assert.ok(INFO.includes('<AlertCircle className="h-3.5 w-3.5"'), 'the mark must be an exclamation');
  assert.ok(!INFO.includes("import { Info }"), 'the circled «i» is back');
});

test('the points control kept every guard it had when it was a card', () => {
  const block = CHECKOUT.slice(at(CHECKOUT, "loc('استخدام النقاط', 'Use points', 'بەکارهێنانی خاڵ')"));
  assert.ok(block.includes('checked={usePoints}'));
  assert.ok(block.includes('onChange={() => setUsePoints((v) => !v)}'));
  assert.ok(
    block.includes('disabled={(quote?.points.balance ?? pointBalance) === 0}'),
    'an empty balance must still refuse the switch'
  );
  assert.ok(block.includes('quote.points.eligible_merchandise_iqd'), 'the redemption cap must still be stated');
  assert.ok(block.includes('quote?.points.earn_pending'), 'what the order earns back must still be stated');
  // Quiet means quiet: no card border competing with the wallet block above.
  assert.ok(
    !CHECKOUT.includes('rounded-xl border border-border-subtle bg-surface p-3'),
    'the points card border is back, and it outweighs the wallet again'
  );
});
