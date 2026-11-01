/**
 * «سعر تقديري» FROM THE CART TO THE ORDER (docs/SMART_PRICING.md §5.3–5.5,
 * §6.1–6.7, §12 WP11; DECISIONS rows 280–281):
 *
 *   - the cart: a chip on each estimated line (the eager label) and ONE note
 *     under the total — the contract's words, fetched only for a cart that
 *     holds an estimated line, because the cart page is prefetched for every
 *     visitor;
 *   - the checkout: the notice, the REQUIRED box, «اطلب بالسعر التقديري» and
 *     the cancel line; the order swears to THIS bundle's notice version, a
 *     refused acknowledgement re-renders from the server's fresh quote, and a
 *     tab older than the notice is told to reload;
 *   - the order: a banner while a line's final price is open, proposed or
 *     rejected (stepping aside for the approval card), a chip per estimated
 *     line, the list's «بانتظار تأكيد السعر النهائي», and «تواصل معنا» with the
 *     order handed to the ticket — one lazy chunk with the contract's words;
 *   - the approval card's estimate variant: the localized reason, per-line old
 *     → new rows, what a rejection leads to — and Sorani in every sentence;
 *   - in Arabic, English and Sorani, with no Sorani slot carrying the Arabic.
 *
 * Run: node --import tsx --test tests/estimateOrderUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ts from 'typescript';
import { ROOT } from './fixtures/d1';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import EstimateStatusCard, {
  EstimateLineChip,
  EstimateOrderChip,
  estimateAskedAbove,
  estimateBannerState,
  estimateListState,
  estimateOrderSupport,
  estimateStatesOf,
  estimateSubjectName,
} from '../src/components/orders/EstimateStatusCard';
import { PriceApprovalBody, isEstimateProposal, proposalNoteWords, type PendingAdjustment } from '../src/components/orders/PriceApprovalCard';
import { ESTIMATE_SUPPORT_PATH } from '../src/components/product/EstimateNotice';
import { ESTIMATE_SHORT, ESTIMATE_TEXT } from '../src/lib/priceStatus';
import type { ApiOrder, EstimateLineState } from '../src/lib/api';
import * as contract from '../packages/contracts/src/priceEstimates';
import {
  ESTIMATE_LINE_STATES,
  ESTIMATE_NOTICE_VERSION,
  ESTIMATE_REFUSALS,
  ESTIMATE_STRINGS,
  estimateLineText,
  fillEstimateText,
  type EstimateLang,
} from '../packages/contracts/src/priceEstimates';

const LANGS: readonly EstimateLang[] = ['ar', 'en', 'ckb'];
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code of a file without its comments: a comment may quote a word it explains. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const ARABIC_SCRIPT = /[؀-ۿ]/;

let LANG: EstimateLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => {},
  removeItem: () => {},
};

function wrap(child: ReactElement, lang: EstimateLang = 'ar'): string {
  LANG = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, {
      value: {
        isAuthenticated: false,
        user: null,
        login: async () => {},
        loginWithGoogle: async () => 'ok' as const,
        register: async () => {},
        refreshUser: async () => {},
        adoptSession: async () => 'ok' as const,
        logout: async () => {},
        isLoaded: true,
      },
      children: createElement(WalletProvider, {
        children: createElement(CurrencyProvider, {
          children: createElement(LanguageProvider, { children: createElement(MemoryRouter, null, child) }),
        }),
      }),
    })
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

/** An order with one estimated line per given state, and one ordinary line. */
function order(states: EstimateLineState[], over: Partial<ApiOrder> = {}): ApiOrder {
  return {
    id: 'ORD-7K2',
    status: 'pending',
    can_cancel: true,
    price_hold_id: null,
    total_iqd: 75_000,
    items: [
      ...states.map((state, i) => ({
        id: `oi_${i}`,
        product_id: `p_${i}`,
        name: i === 0 ? 'Bambu PLA Basic' : `Bambu Part ${i}`,
        image: '',
        variant: '',
        qty: 1,
        unit_price_iqd: 25_000,
        line_total_iqd: 25_000,
        price_estimate: { state },
      })),
      { id: 'oi_plain', product_id: 'p_plain', name: 'Nozzle', image: '', variant: '', qty: 1, unit_price_iqd: 5_000, line_total_iqd: 5_000 },
    ],
    ...over,
  } as unknown as ApiOrder;
}

/** Every `loc(...)` / `tr(...)` call of a file with fewer than three arguments, or whose Sorani literal is the Arabic one. */
function twoLanguageOrCopied(rel: string): string[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const literal = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'loc' || n.expression.text === 'tr')) {
      const ar = literal(n.arguments[0]);
      if (n.arguments.length < 3 || (ar !== null && ar === literal(n.arguments[2])) || n.arguments[0]?.getText() === n.arguments[2]?.getText()) {
        out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText().slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------- the checkout

test('the checkout draws the notice, the REQUIRED box, the cancel line and «اطلب بالسعر التقديري» — in the contract’s words', () => {
  const page = code('src/pages/Checkout.tsx');
  // The words come from the contract, imported by this lazy route chunk.
  assert.match(page, /import \{\s*ESTIMATE_NOTICE_VERSION,\s*ESTIMATE_STRINGS,\s*estimateRefusalText,\s*type EstimateLang,\s*\} from '\.\.\/\.\.\/packages\/contracts\/src\/priceEstimates';/);
  // Drawn only when the quote holds an estimated line, beside the consent and above the button.
  assert.match(page, /const estimate = quote\?\.estimate \?\? null;/);
  assert.match(page, /const estimateBlock = estimate \? \(/);
  assert.match(page, /\{estimateBlock\}\s*\{consentBlock\}/);
  assert.match(page, /<span>\{ESTIMATE_STRINGS\.notice\[estimateLang\]\}<\/span>/);
  // The box: unticked by default, required, and the acknowledgement's own sentence beside it.
  assert.match(page, /const \[estimateAck, setEstimateAck\] = useState\(false\);/);
  const box = /<input\s+type="checkbox"\s+data-checkout-estimate-ack[\s\S]*?\/>\s*<span[^>]*>\{ESTIMATE_STRINGS\.checkoutAck\[estimateLang\]\}<\/span>/.exec(page)?.[0] ?? '';
  assert.ok(box, 'the required box with the acknowledgement beside it');
  assert.match(box, /checked=\{estimateAck\}/);
  assert.match(box, /aria-required="true"/);
  assert.match(box, /onChange=\{\(e\) => setEstimateAck\(e\.target\.checked\)\}/);
  assert.match(page, /\{ESTIMATE_STRINGS\.checkoutCancel\[estimateLang\]\}/);
  // The verb itself says it, after the two waits and before the ordinary label.
  assert.match(
    page,
    /: quoteLoading\s*\? S\.quoteLoading\s*: estimate\s*\? ESTIMATE_STRINGS\.checkoutButton\[estimateLang\]\s*: loc\('تأكيد الطلب', 'Place order', 'دڵنیاکردنەوەی داواکاری'\)/
  );
  // Each estimated line says so in the summary, the quote's word first.
  assert.match(page, /estimate: l\.price_estimate === true \|\| l\.breakdown\?\.price_estimate === true \|\| \(quote\.estimate\?\.lines \?\? \[\]\)\.includes\(l\.cart_item_id\),/);
  assert.equal((page.match(/data-checkout-line-estimate=\{line\.key\}/g) ?? []).length, 2, 'a single line and a colour line');
  assert.equal((page.match(/\{ESTIMATE_STRINGS\.label\[estimateLang\]\}/g) ?? []).length, 2);
  // The placed order is told in the order-placed message's own sentence.
  assert.match(page, /placedOrder\.items\.some\(\(it\) => !!it\.price_estimate\) \? \(/);
  assert.match(page, /\{ESTIMATE_STRINGS\.orderPlaced\[estimateLang\]\}/);
});

test('the acknowledgement is required, swears to THIS bundle’s notice, and asks again when the estimate changes', () => {
  const page = code('src/pages/Checkout.tsx');
  const open = page.indexOf('const blockReason: string | null = (() => {');
  const close = page.indexOf('const canCompleteOrder = blockReason === null');
  const expression = page.slice(open, close);
  assert.ok(open > 0 && close > open);
  assert.ok(expression.includes('if (estimate && !estimateAck) return S.estimateAckBlock;'), 'the box is a conjunct of the ordered expression');
  assert.ok(expression.indexOf('S.policyRequired') < expression.indexOf('S.estimateAckBlock'), 'beside the consent, after it');
  // A tab older than the notice reloads; the owner's pause is the contract's sentence, never «تعذّر تسعير».
  assert.ok(expression.includes('if (estimateStale) return S.estimateStale;'));
  assert.ok(expression.includes("if (estimatePaused) return estimateRefusalText('PRICE_ESTIMATE_ORDERING_PAUSED', estimateLang) ?? S.blockQuote;"));
  assert.ok(expression.indexOf('S.estimateStale') < expression.indexOf('S.estimateAckBlock'));
  assert.ok(expression.indexOf('estimatePaused') < expression.indexOf('!serverAllows'), 'before the generic «could not be priced»');
  assert.match(page, /const estimateStale = !!estimate && estimate\.notice_version !== ESTIMATE_NOTICE_VERSION;/);
  assert.match(page, /quote\.blockers\.includes\('PRICE_ESTIMATE_ORDERING_PAUSED'\)/);
  // The order sends the version of the words on screen — the bundle's constant — and only once ticked.
  const place = /const placeOrder = async \(\) => \{[\s\S]*?\n {2}\};/.exec(page)?.[0] ?? '';
  assert.ok(place, 'placeOrder should be findable');
  assert.match(place, /price_estimate_ack: estimate && estimateAck \? ESTIMATE_NOTICE_VERSION : undefined,/);
  assert.doesNotMatch(place, /price_estimate_ack: [^,]*notice_version/, 'never the quote’s number: that would acknowledge words this tab never showed');
  // A new set of estimated lines, another version or another language asks again.
  assert.match(page, /const estimateAckKey = quote\?\.estimate\s*\? `\$\{quote\.estimate\.notice_version\}\|\$\{\[\.\.\.quote\.estimate\.lines\]\.sort\(\)\.join\(','\)\}`\s*: '';/);
  assert.match(page, /useEffect\(\(\) => \{ setEstimateAck\(false\); \}, \[estimateAckKey, lang\]\);/);
  // The server agrees on every name: the field, the version it compares, the refusal and its fresh quote.
  const orders = read('worker/routes/orders.ts');
  assert.match(orders, /if \(body\.price_estimate_ack !== ESTIMATE_NOTICE_VERSION\) \{\s*throw new HttpError\(409, estimateServerMessage\('PRICE_ESTIMATE_ACK_REQUIRED'\), 'PRICE_ESTIMATE_ACK_REQUIRED', \{\s*quote: quotePayload\(comp, input\),/);
  assert.match(orders, /import \{ ESTIMATE_NOTICE_VERSION, estimateServerMessage \} from '@levonis\/contracts\/priceEstimates';/);
  assert.match(orders, /if \(comp\.estimate\?\.ordering_paused\) blockers\.push\('PRICE_ESTIMATE_ORDERING_PAUSED'\);/);
  assert.match(orders, /notice_version: ESTIMATE_NOTICE_VERSION,/);
  assert.equal(ESTIMATE_NOTICE_VERSION, 1);
});

test('a refused acknowledgement re-renders from the server’s FRESH quote, box unticked; every estimate refusal is the contract’s sentence', () => {
  const page = code('src/pages/Checkout.tsx');
  const branch = /else if \(err instanceof ApiError && err\.code === 'PRICE_ESTIMATE_ACK_REQUIRED'\) \{[\s\S]*?setSubmitError\(msg\);/.exec(page)?.[0] ?? '';
  assert.ok(branch, 'the refusal has its own branch');
  assert.match(branch, /const fresh = err\.details\?\.quote as CheckoutQuoteDto \| undefined;/);
  assert.match(branch, /setQuote\(fresh\);/);
  assert.match(branch, /setEstimateAck\(false\);/);
  // A fresh quote with other totals resets the consent, exactly as a re-quote does.
  assert.match(branch, /const sig = quoteSignature\(fresh\);/);
  assert.match(page, /const sig = quoteSignature\(data\.quote\);/);
  // The one refusal helper of the page reads the contract before the trilingual table.
  assert.match(page, /function refusalWithCounter\(err: unknown, lang: string, fallback: string\): string \{\s*const estimateSaid = estimateRefusalText\(err, estimateLangOf\(lang\)\);\s*if \(estimateSaid\) return estimateSaid;/);
  // A financed method refused for an estimate cart is explained in the estimate box, for the visit.
  assert.match(page, /if \(code === 'PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED'\) setEstimatePaymentRefused\(true\);/);
  assert.match(page, /\{estimateRefusalText\('PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED', estimateLang\)\}/);
  // Every customer refusal the checkout can meet resolves in every language.
  for (const code of ['PRICE_ESTIMATE_ACK_REQUIRED', 'PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED', 'PRICE_ESTIMATE_PREORDER_ONLY', 'PRICE_ESTIMATE_ORDERING_PAUSED', 'PRICE_ESTIMATES_READ_FAILED'] as const) {
    assert.equal(ESTIMATE_REFUSALS[code].audience, 'customer');
    for (const l of LANGS) assert.equal(contract.estimateRefusalText({ code }, l), ESTIMATE_REFUSALS[code][l]);
  }
});

// ---------------------------------------------------------------- the cart

test('the cart: a chip on each estimated line, one note under the total, the contract fetched only for such a cart', () => {
  const page = code('src/pages/Cart.tsx');
  // Never a static import: the cart is prefetched for every visitor.
  assert.doesNotMatch(page, /^import [^;]*packages\/contracts\/src\/priceEstimates'/m);
  assert.match(page, /const loadEstimateWords = \(\) => import\('\.\.\/\.\.\/packages\/contracts\/src\/priceEstimates'\);/);
  assert.match(page, /import \{ ESTIMATE_TEXT \} from '\.\.\/lib\/priceStatus';/);
  // A line is estimated when it, or its price block, says so — the server's `has_estimates` is the same reading.
  assert.match(page, /item\.price_estimate === true \|\| item\.breakdown\?\.price_estimate === true;/);
  assert.match(page, /const hasEstimates = items\.some\(lineEstimated\);/);
  assert.match(page, /if \(hasEstimates\) void loadWords\(\);/);
  assert.match(read('worker/routes/cart.ts'), /\(i as \{ price_estimate\?: unknown \}\)\.price_estimate === true/);
  // The chip beside the line's figure, in the eager label; the note under the total, in the contract's words.
  assert.match(page, /\{lineEstimated\(item\) && \(\s*<span\s+data-cart-line-estimate=\{item\.id\}[\s\S]*?\{ESTIMATE_TEXT\[estimateLang\]\}/);
  const summary = page.slice(page.indexOf("{loc('المجموع الكلي', 'Total', 'کۆی گشتی')}"));
  // (`code()` leaves a JSX comment as `{}`.)
  assert.match(summary, /^[\s\S]*?\{moneyBoth\(total, totalUsd\)\}<\/span>\s*<\/div>\s*(?:\{\}\s*)?\{hasEstimates && estimateWords && \(\s*<p data-cart-estimate-notice[^>]*>\s*\{estimateWords\.ESTIMATE_STRINGS\.cartNotice\[estimateLang\]\}/);
});

test('the cart says an estimate refusal from the contract — at once when its words are here, as soon as they arrive otherwise', () => {
  const page = code('src/pages/Cart.tsx');
  const re = /const ESTIMATE_REFUSAL_CODE = (\/.*\/);/.exec(page)?.[1];
  assert.ok(re, 'the estimate refusal pattern');
  const pattern = new RegExp(re.slice(1, -1));
  // Every customer refusal of the contract is recognised; nothing else is.
  for (const [codeName, r] of Object.entries(ESTIMATE_REFUSALS)) {
    if (r.audience === 'customer') assert.ok(pattern.test(codeName), `${codeName} is not recognised`);
  }
  for (const other of ['PRICE_NOT_AVAILABLE', 'PREORDER_CAPACITY_EXHAUSTED', 'PRICE_APPROVAL_PENDING', 'OUT_OF_STOCK']) assert.equal(pattern.test(other), false, other);
  assert.match(page, /estimateWordsRef\.current\?\.estimateRefusalText\(code, lang as 'ar' \| 'en' \| 'ckb'\) \?\? null/);
  assert.match(page, /if \(said\) put\(\(prev\) => \(prev === first \? said : prev\)\);/, 'a later sentence never overwrites a newer refusal');
  // The three doors that can answer one: a quantity, an option, a route.
  for (const [door, setter] of [['quantity', 'setError'], ['variant', 'setVariantError'], ['shipping method', 'setShippingError']]) {
    assert.match(page, new RegExp(`sayRefusal\\(err, 'Failed to update ${door}', ${setter}\\);`));
  }
});

// ---------------------------------------------------------------- the order: one lazy chunk

test('the order page, its lines and the order list mount the estimate chunk only for an order with an estimated line', () => {
  const detail = code('src/pages/OrderDetail.tsx');
  assert.match(detail, /const EstimateStatusCard = React\.lazy\(\(\) => import\('\.\.\/components\/orders\/EstimateStatusCard'\)\);/);
  assert.match(detail, /const EstimateLineChip = React\.lazy\(\(\) => import\('\.\.\/components\/orders\/EstimateStatusCard'\)\.then\(\(m\) => \(\{ default: m\.EstimateLineChip \}\)\)\);/);
  assert.match(detail, /const estimated = !!order && order\.items\.some\(\(it\) => !!it\.price_estimate\);/);
  assert.match(detail, /\{estimated && \(\s*<ChunkBoundary compact>\s*<React\.Suspense fallback=\{null\}>\s*<EstimateStatusCard order=\{order\} \/>/);
  assert.match(detail, /\{it\.price_estimate && \(\s*<ChunkBoundary compact renderFallback=\{\(\) => null\}>\s*<React\.Suspense fallback=\{null\}>\s*<EstimateLineChip state=\{it\.price_estimate\.state\} \/>/);
  // The banner sits under the approval card, which keeps the top of the page.
  assert.ok(detail.indexOf('<PriceApprovalCard') < detail.indexOf('<EstimateStatusCard order={order} />'));
  const card = code('src/components/orders/OrderCard.tsx');
  assert.match(card, /const EstimateOrderChip = React\.lazy\(\(\) => import\('\.\/EstimateStatusCard'\)\.then\(\(m\) => \(\{ default: m\.EstimateOrderChip \}\)\)\);/);
  assert.match(card, /const estimateStates = order\.items\.flatMap\(\(it\) => \(it\.price_estimate \? \[it\.price_estimate\.state\] : \[\]\)\);/);
  assert.match(card, /\{estimateStates\.length > 0 && \(\s*<ChunkBoundary compact renderFallback=\{\(\) => null\}>\s*<React\.Suspense fallback=\{null\}>\s*<EstimateOrderChip states=\{estimateStates\} \/>/);
  // Neither page, the card nor the approval card carries the contract statically.
  for (const f of ['src/pages/OrderDetail.tsx', 'src/components/orders/OrderCard.tsx', 'src/components/orders/PriceApprovalCard.tsx', 'src/pages/Cart.tsx']) {
    assert.doesNotMatch(code(f), /^import [^;]*packages\/contracts\/src\/priceEstimates'/m, `${f} imports the contract statically`);
    assert.doesNotMatch(code(f), /^import [^;]*components\/orders\/EstimateStatusCard'/m, `${f} imports the estimate chunk statically`);
  }
  assert.match(code('src/components/orders/EstimateStatusCard.tsx'), /from '\.\.\/\.\.\/\.\.\/packages\/contracts\/src\/priceEstimates';/);
});

test('the banner: the state in the contract’s words, the notice while open, «you can still cancel», and «تواصل معنا» with the order', () => {
  for (const l of LANGS) {
    const html = wrap(createElement(EstimateStatusCard, { order: order(['open', 'open']) }), l);
    assert.match(html, /data-estimate-status="open"/);
    const said = text(html);
    assert.ok(said.includes(ESTIMATE_STRINGS.line.open[l]), `${l}: «${said}»`);
    assert.ok(said.includes(ESTIMATE_STRINGS.notice[l]), `${l}: the notice`);
    assert.ok(said.includes(ESTIMATE_STRINGS.checkoutCancel[l]), `${l}: the cancel line`);
    assert.ok(said.includes(ESTIMATE_STRINGS.contact[l]), `${l}: the contact link`);
    const link = /<a [^>]*data-estimate-contact[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(link, /href="\/support\?ask=price_estimate"/, 'the link opens the assistant’s allow-listed question');
    // Never a figure, a source or a measure.
    assert.doesNotMatch(said, /[0-9٠-٩]|IQD|د\.ع|CNY|EUR|Tmall|kg|CBM/);
  }
  // The link hands the ticket the subject in the reader's language and the order itself.
  assert.equal(ESTIMATE_SUPPORT_PATH, '/support?ask=price_estimate');
  const two = order(['open', 'open']);
  assert.equal(estimateSubjectName(two), 'Bambu PLA Basic +1');
  assert.equal(estimateSubjectName(order(['open'])), 'Bambu PLA Basic');
  for (const l of LANGS) {
    assert.deepEqual(estimateOrderSupport(two, l), {
      subject: fillEstimateText(ESTIMATE_STRINGS.support.subject, { name: 'Bambu PLA Basic +1' })[l],
      orderId: 'ORD-7K2',
    });
  }
  // Once the order cannot be cancelled any more, the cancel line is not promised.
  assert.doesNotMatch(wrap(createElement(EstimateStatusCard, { order: order(['open'], { can_cancel: false }) }), 'en'), /data-estimate-cancel/);
});

test('the banner follows the line states: rejected first, then open; it never repeats a held proposal’s question and leaves once settled', () => {
  const held = { price_hold_id: 'padj_0123456789abcdef01234567' };
  assert.equal(estimateBannerState(order(['rejected', 'confirmed'])), 'rejected');
  assert.equal(estimateBannerState(order(['open'])), 'open');
  assert.equal(estimateBannerState(order(['proposed', 'confirmed'], held)), 'proposed');
  assert.equal(estimateAskedAbove(order(['proposed', 'confirmed'], held)), true, 'the approval card asks that question');
  assert.equal(estimateAskedAbove(order(['proposed'])), false, 'with no held proposal the banner asks it');
  assert.equal(estimateAskedAbove(order(['open'], held)), false);
  for (const settled of [['confirmed'], ['approved', 'confirmed'], ['void']] as EstimateLineState[][]) assert.equal(estimateBannerState(order(settled)), null);
  assert.equal(estimateBannerState(order(['open'], { status: 'cancelled' })), null);
  assert.equal(estimateBannerState(order([])), null);
  for (const l of LANGS) {
    const rejected = text(wrap(createElement(EstimateStatusCard, { order: order(['rejected']) }), l));
    assert.ok(rejected.includes(ESTIMATE_STRINGS.line.rejected[l]));
    assert.equal(rejected.includes(ESTIMATE_STRINGS.checkoutCancel[l]), false, 'the rejection’s own sentence already says it');
    assert.equal(rejected.includes(ESTIMATE_STRINGS.notice[l]), false);
    assert.equal(wrap(createElement(EstimateStatusCard, { order: order(['approved']) }), l), '');
    // While the approval card asks, the banner keeps the way out and the way to ask — and nothing else.
    const asked = wrap(createElement(EstimateStatusCard, { order: order(['proposed', 'confirmed'], held) }), l);
    assert.match(asked, /data-estimate-asked-above/);
    assert.equal(text(asked).includes(ESTIMATE_STRINGS.line.proposed[l]), false, 'the same question twice');
    assert.ok(text(asked).includes(ESTIMATE_STRINGS.checkoutCancel[l]));
    assert.ok(text(asked).includes(ESTIMATE_STRINGS.contact[l]));
    assert.match(asked, /href="\/support\?ask=price_estimate"/);
    // With no held proposal to answer it, the banner asks.
    assert.ok(text(wrap(createElement(EstimateStatusCard, { order: order(['proposed']) }), l)).includes(ESTIMATE_STRINGS.line.proposed[l]));
  }
  // The states are read off the estimated lines only, in line order.
  assert.deepEqual(estimateStatesOf(order(['open', 'confirmed'])), ['open', 'confirmed']);
});

test('each estimated line states where its final price stands; the list chip waits only while a line does', () => {
  for (const l of LANGS) {
    for (const state of ESTIMATE_LINE_STATES) {
      const html = wrap(createElement(EstimateLineChip, { state }), l);
      const words = estimateLineText(state, l);
      if (words === null) {
        assert.equal(html, '', 'a void line says nothing');
        continue;
      }
      assert.equal(text(html), words);
      assert.match(html, new RegExp(`data-estimate-line="${state}"`));
      assert.match(html, state === 'confirmed' || state === 'approved' ? /text-success/ : /text-warning/);
    }
    // The order list: «بانتظار تأكيد السعر النهائي» while open or rejected, the approval's words while proposed.
    assert.equal(text(wrap(createElement(EstimateOrderChip, { states: ['open', 'confirmed'] }), l)), ESTIMATE_STRINGS.line.open[l]);
    assert.equal(text(wrap(createElement(EstimateOrderChip, { states: ['rejected'] }), l)), ESTIMATE_STRINGS.line.open[l]);
    assert.equal(text(wrap(createElement(EstimateOrderChip, { states: ['proposed', 'confirmed'] }), l)), ESTIMATE_STRINGS.line.proposed[l]);
    assert.equal(wrap(createElement(EstimateOrderChip, { states: ['confirmed', 'approved'] }), l), '');
    assert.equal(wrap(createElement(EstimateOrderChip, { states: ['void'] }), l), '');
  }
  assert.equal(estimateListState([]), null);
});

test('the order-side chunk carries no word of its own: every sentence is the contract’s', () => {
  assert.doesNotMatch(code('src/components/orders/EstimateStatusCard.tsx'), ARABIC_SCRIPT, 'Arabic or Sorani typed into the chunk');
  // No file of this package spells a contract sentence itself (a second spelling drifts).
  const sentences = [
    ESTIMATE_STRINGS.label, ESTIMATE_STRINGS.labelShort, ESTIMATE_STRINGS.notice, ESTIMATE_STRINGS.contact, ESTIMATE_STRINGS.cartNotice,
    ESTIMATE_STRINGS.checkoutAck, ESTIMATE_STRINGS.checkoutButton, ESTIMATE_STRINGS.checkoutCancel, ESTIMATE_STRINGS.orderPlaced,
    ESTIMATE_STRINGS.estimateReason, ESTIMATE_STRINGS.estimateRejectNote, ...Object.values(ESTIMATE_STRINGS.line),
  ];
  for (const f of ['src/pages/Cart.tsx', 'src/pages/Checkout.tsx', 'src/pages/OrderDetail.tsx', 'src/components/orders/OrderCard.tsx', 'src/components/orders/PriceApprovalCard.tsx', 'src/components/orders/EstimateStatusCard.tsx']) {
    const src = code(f);
    for (const words of sentences) for (const l of LANGS) assert.equal(src.includes(`'${words[l]}'`), false, `${f} spells «${words[l]}» itself`);
  }
  // The eager labels the cart uses are the contract's, pinned (tests/estimateStorefrontUi.test.ts pins them too).
  assert.deepEqual({ ...ESTIMATE_TEXT }, { ...ESTIMATE_STRINGS.label });
  assert.deepEqual({ ...ESTIMATE_SHORT }, { ...ESTIMATE_STRINGS.labelShort });
});

// ---------------------------------------------------------------- the approval card

const estimateProposal = (over: Partial<PendingAdjustment> = {}): PendingAdjustment => ({
  id: 'padj_0123456789abcdef01234567',
  old_total_iqd: 50_000,
  new_total_iqd: 54_000,
  delta_iqd: 4_000,
  new_due_iqd: 54_000,
  wallet_refund_iqd: 0,
  // The stored sentence carries all three languages at once (worker/lib/orderEstimates.ts): never shown whole.
  reason: 'STORED THREE-LANGUAGE SENTENCE',
  note: 'Bambu PLA Basic — Black × 2: 25,000 → 27,000\nThe supplier raised the spool price this week.',
  created_at: '2026-10-31T10:00:00Z',
  reason_code: 'ESTIMATE_FINAL_PRICE',
  lines: [
    { order_item_id: 'oi_0', name: 'Bambu PLA Basic', variant: 'Black', qty: 2, estimate_unit_iqd: 25_000, final_unit_iqd: 27_000 },
    { order_item_id: 'oi_1', name: 'Hotend', variant: '', qty: 1, estimate_unit_iqd: 30_000, final_unit_iqd: 30_000 },
  ],
  ...over,
});

test('the approval card’s estimate variant: the localized reason, per-line old → new rows and what a rejection leads to', () => {
  for (const l of LANGS) {
    const html = wrap(createElement(PriceApprovalBody, { pending: estimateProposal(), words: contract, onAsk: () => {} }), l);
    const said = text(html);
    assert.match(html, /data-price-approval-estimate="true"/);
    assert.ok(said.includes(ESTIMATE_STRINGS.line.proposed[l]), `${l}: the title`);
    assert.ok(said.includes(ESTIMATE_STRINGS.estimateReason[l]), `${l}: the reason`);
    assert.equal(said.includes('STORED THREE-LANGUAGE SENTENCE'), false, 'the stored sentence is never shown whole');
    assert.ok(said.includes(ESTIMATE_STRINGS.estimateRejectNote[l]), `${l}: what a rejection leads to`);
    // One row per line: the unit price ordered at, struck, and the final one; an unchanged line says so.
    assert.equal((html.match(/data-price-approval-line="/g) ?? []).length, 2);
    assert.match(html, /<s[^>]*>[^<]*25,000[^<]*<\/s>/);
    assert.match(said, /27,000/);
    assert.ok(said.includes(l === 'en' ? 'No change' : l === 'ckb' ? 'بەبێ گۆڕانکاری' : 'دون تغيير'));
    // The note keeps the admin's words; its generated rows are the rows above.
    assert.ok(said.includes('The supplier raised the spool price this week.'));
    assert.equal(said.includes('25,000 → 27,000'), false);
  }
  assert.equal(proposalNoteWords('A × 2: 25,000 → 27,000\n+3\nOwn words', true), 'Own words');
  assert.equal(proposalNoteWords('A × 2: 25,000 → 27,000', true), '');
  assert.equal(proposalNoteWords('A × 2: 25,000 → 27,000', false), 'A × 2: 25,000 → 27,000', 'with no rows drawn the note is said whole');
});

test('an ordinary proposal is the card it always was — and speaks Sorani; an estimate whose words did not arrive falls back to it', () => {
  const ordinary = estimateProposal({ reason_code: '', lines: undefined, reason: 'Supplier price change', note: '' });
  assert.equal(isEstimateProposal(ordinary), false);
  assert.equal(isEstimateProposal(estimateProposal()), true);
  for (const [l, title] of [['ar', 'مطلوب موافقتك على السعر الجديد'], ['en', 'Your approval is needed for a new price'], ['ckb', 'پێویستە نرخە نوێیەکە پەسەند بکەیت']] as const) {
    const html = wrap(createElement(PriceApprovalBody, { pending: ordinary, words: contract, onAsk: () => {} }), l);
    const said = text(html);
    assert.ok(said.includes(title), `${l}: «${said}»`);
    assert.ok(said.includes('Supplier price change'), 'the shop’s reason in its own words');
    assert.doesNotMatch(html, /data-price-approval-estimate|data-price-approval-lines|data-price-approval-reject-note/);
  }
  // Sorani everywhere: never the Arabic in the Sorani reader's card.
  const ckb = text(wrap(createElement(PriceApprovalBody, { pending: ordinary, words: null, onAsk: () => {} }), 'ckb'));
  for (const arabic of ['مطلوب موافقتك', 'السعر السابق', 'السعر الجديد', 'السبب', 'تدفع عند الاستلام', 'موافقة', 'رفض']) {
    assert.equal(ckb.includes(arabic), false, `«${arabic}» in the Sorani card`);
  }
  for (const sorani of ['نرخی پێشوو', 'نرخی نوێ', 'هۆکار', 'لە کاتی وەرگرتن دەیدەیت', 'پەسەندکردن', 'ڕەتکردنەوە']) assert.ok(ckb.includes(sorani), sorani);
  // The words could not be fetched: the stored sentence stands in, and the decision is still offered.
  const fallback = text(wrap(createElement(PriceApprovalBody, { pending: estimateProposal(), words: null, onAsk: () => {} }), 'en'));
  assert.ok(fallback.includes('STORED THREE-LANGUAGE SENTENCE'));
  assert.ok(fallback.includes('Approve') && fallback.includes('Reject'));
});

test('the approval card fetches the estimate words only for an estimate proposal, and says every sentence in three languages', () => {
  const card = code('src/components/orders/PriceApprovalCard.tsx');
  assert.match(card, /const loadEstimateWords = \(\) => import\('\.\.\/\.\.\/\.\.\/packages\/contracts\/src\/priceEstimates'\);/);
  assert.match(card, /if \(isEstimateProposal\(r\.pending\)\) \{\s*try \{\s*setWords\(await loadEstimateWords\(\)\);/);
  assert.match(card, /p\?\.reason_code === 'ESTIMATE_FINAL_PRICE'/);
  assert.equal(contract.ESTIMATE_REASON_CODE, 'ESTIMATE_FINAL_PRICE');
  // The rejection's consequence and the after-message are the contract's on an estimate proposal.
  assert.match(card, /: ew\s*\? ew\.ESTIMATE_STRINGS\.estimateRejectNote\[L\]/);
  assert.match(card, /: ew\s*\? ew\.ESTIMATE_STRINGS\.line\.rejected\[L\]/);
  assert.match(card, /ew\?\.estimateRefusalText\(e, L\) \?\?/);
  // A wallet refund stays a wallet amount (FX-1 review #6).
  assert.match(card, /walletMoney\(pending\.wallet_refund_iqd\)/);
  assert.doesNotMatch(card, /[^t]money\(pending\.wallet_refund_iqd\)/);
  // Every sentence in three languages, no Sorani slot copying the Arabic, and the owner's note answered.
  assert.deepEqual(twoLanguageOrCopied('src/components/orders/PriceApprovalCard.tsx'), []);
  assert.doesNotMatch(read('src/components/orders/PriceApprovalCard.tsx'), /OWNER: Sorani to be written by hand/);
  // Real Sorani letters in every Sorani argument.
  const sf = ts.createSourceFile('c.tsx', read('src/components/orders/PriceApprovalCard.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ckbArgs: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'loc' && n.arguments[2]) ckbArgs.push(n.arguments[2].getText());
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(ckbArgs.length >= 20, `${ckbArgs.length} Sorani arguments`);
  // Sorani's own letters — and its yeh and keheh (ی ک), never the Arabic ي ك.
  for (const arg of ckbArgs) {
    assert.match(arg, /[ڕڵێۆەپچژگیک]/, `«${arg.slice(0, 60)}» is not written in Sorani letters`);
    assert.doesNotMatch(arg.replace(/د\.ع/g, ''), /[يكةى]/, `«${arg.slice(0, 60)}» carries an Arabic-only letter`);
  }
});

// ---------------------------------------------------------------- three languages

test('the package’s own words are written three times: no two-language string, no Sorani copied from the Arabic', () => {
  assert.deepEqual(['src/components/orders/EstimateStatusCard.tsx', 'src/components/orders/PriceApprovalCard.tsx'].flatMap(twoLanguageOrCopied), []);
  // The checkout's two own sentences and its reload verb (tests/checkoutSorani.test.ts holds the page to the same rule).
  const page = read('src/pages/Checkout.tsx');
  for (const key of ['estimateAckBlock', 'estimateStale', 'reload']) {
    const values = [...page.matchAll(new RegExp(`\\n {4}${key}: '([^']+)',`, 'g'))].map((m) => m[1]);
    assert.equal(values.length, 3, `${key} in ar, en and ckb`);
    const [ar, en, ckb] = values;
    assert.ok(ARABIC_SCRIPT.test(ar) && !ARABIC_SCRIPT.test(en) && ARABIC_SCRIPT.test(ckb), key);
    assert.notEqual(ckb, ar, `${key}: the Sorani is the Arabic`);
    assert.match(ckb, /[ڕڵێۆە]/, `${key}: Sorani letters`);
  }
});
