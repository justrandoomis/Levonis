/**
 * «سعر تقديري» ON THE STOREFRONT (docs/SMART_PRICING.md §5.3–5.5, §12 WP10;
 * DECISIONS rows 278–281): the cards, the compare row, the product page and
 * the support assistant's door.
 *
 *   - the two eager card labels in src/lib/priceStatus.ts are COPIES of the
 *     contract's (packages/contracts/src/priceEstimates.ts) and are pinned
 *     equal here; every other word comes from the contract itself;
 *   - a card says «سعر تقديري» only on a PRICED estimate: a muted line under a
 *     regular row's price, the compact row's second line after a live offer's
 *     struck price and before the member line — in Arabic, English and Sorani;
 *   - `EstimateNotice` is a lazy chunk the product page mounts only while the
 *     selection on screen is an estimate; the page never imports the contract;
 *   - ⚡ Quick Buy is not offered for an estimated selection;
 *   - «عدة ألوان» names its total and each estimated colour's price, with the
 *     page's label standing in until a colour's own quote answers (rendered in
 *     tests/estimateColourPanel.test.ts);
 *   - «تواصل معنا» opens the support assistant's allow-listed estimate question
 *     with the ticket subject in router state, and sends nothing by itself.
 *
 * Run: node --import tsx --test tests/estimateStorefrontUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import CardPrice from '../src/components/CardPrice';
import PriceRow from '../src/components/compare/PriceRow';
import EstimateNotice, { ESTIMATE_SUPPORT_PATH, estimateSupportState } from '../src/components/product/EstimateNotice';
import { ESTIMATE_SHORT, ESTIMATE_TEXT, isEstimated, UNPRICED_TEXT } from '../src/lib/priceStatus';
import type { ApiProduct } from '../src/lib/api';
import type { CompareProductCard, CompareRow } from '../src/lib/compare';
import {
  ESTIMATE_STRINGS,
  ESTIMATE_SUPPORT_INTENT,
  fillEstimateText,
  type EstimateLang,
} from '../packages/contracts/src/priceEstimates';

const LANGS: readonly EstimateLang[] = ['ar', 'en', 'ckb'];
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code of a file without its comments: a comment may quote a word it explains. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

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
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** A priced card; `price_estimate` added by the caller. */
const card = (over: Partial<ApiProduct> = {}): ApiProduct =>
  ({
    id: 'p_pla',
    slug: 'bambu-pla-basic',
    name: 'Bambu PLA Basic',
    price_status: 'priced',
    price_iqd: 25_000,
    display_price_iqd: 25_000,
    display_regular_iqd: 25_000,
    display_applied_tier: 'regular',
    display_prime_iqd: 24_000,
    display_pro_iqd: 23_000,
    display_from: false,
    ...over,
  }) as ApiProduct;

// ---------------------------------------------------------------- the words

test('the eager card labels are the contract’s own words, copied and pinned equal', () => {
  assert.deepEqual({ ...ESTIMATE_TEXT }, { ...ESTIMATE_STRINGS.label });
  assert.deepEqual({ ...ESTIMATE_SHORT }, { ...ESTIMATE_STRINGS.labelShort });
  for (const words of [ESTIMATE_TEXT, ESTIMATE_SHORT]) {
    assert.notEqual(words.ckb as string, words.ar, 'a Sorani slot never carries the Arabic (row 183)');
    assert.match(words.ckb, /[ڕڵێۆە]/, 'the Sorani is written in Sorani letters');
  }
  // EAGER AND TINY: the card module imports nothing, and never the contract (which only lazy chunks import).
  const status = read('src/lib/priceStatus.ts');
  assert.doesNotMatch(status, /^import /m);
  assert.doesNotMatch(status, /\bimport\(/);
  // About 120 bytes of words: the whole eager addition is the two labels and one predicate.
  const bytes = Buffer.byteLength(JSON.stringify([ESTIMATE_TEXT, ESTIMATE_SHORT]), 'utf8');
  assert.ok(bytes < 200, `the eager labels are ${bytes} bytes`);
});

test('isEstimated: a PRICED projection that says so — never an unpriced one, never a truthy look-alike', () => {
  assert.equal(isEstimated({ price_estimate: true }), true, 'an absent status reads as priced');
  assert.equal(isEstimated({ price_status: 'priced', price_estimate: true }), true);
  assert.equal(isEstimated({ price_status: 'unpriced', price_estimate: true }), false, 'a catalog-only card has no price to qualify');
  for (const v of [false, 1, 'true', null, undefined, {}]) assert.equal(isEstimated({ price_estimate: v }), false, String(v));
  assert.equal(isEstimated({}), false);
  assert.equal(isEstimated(null), false);
  assert.equal(isEstimated(undefined), false);
});

test('every estimate word on the storefront comes from the contract or its pinned copy — no second spelling', () => {
  for (const f of [
    'src/components/CardPrice.tsx',
    'src/components/compare/PriceRow.tsx',
    'src/pages/Product.tsx',
    'src/pages/Support.tsx',
    'src/components/product/EstimateNotice.tsx',
    'src/components/product/ColourQuantityPanel.tsx',
  ]) {
    const src = code(f);
    for (const l of LANGS) {
      for (const words of [ESTIMATE_STRINGS.label, ESTIMATE_STRINGS.labelShort, ESTIMATE_STRINGS.notice, ESTIMATE_STRINGS.contact, ESTIMATE_STRINGS.support.chip]) {
        assert.equal(src.includes(`'${words[l]}'`), false, `${f} spells «${words[l]}» itself instead of reading it`);
      }
    }
  }
  // The notice carries no word of its own: every sentence is the contract's.
  assert.doesNotMatch(code('src/components/product/EstimateNotice.tsx'), /[؀-ۿ]/, 'Arabic or Sorani typed into the notice');
  assert.match(code('src/components/product/EstimateNotice.tsx'), /from '\.\.\/\.\.\/\.\.\/packages\/contracts\/src\/priceEstimates'/);
  // The server's answer and chip are the contract's too.
  const route = read('worker/routes/support.ts');
  for (const l of LANGS) {
    assert.match(route, new RegExp(`price_estimate_answer: ESTIMATE_STRINGS\\.support\\.answer\\.${l},`));
    assert.match(route, new RegExp(`c_price_estimate: ESTIMATE_STRINGS\\.support\\.chip\\.${l},`));
    assert.match(route, new RegExp(`price_estimate_label: ESTIMATE_STRINGS\\.label\\.${l},`));
  }
});

// ---------------------------------------------------------------- the cards

test('a regular card: a muted «سعر تقديري» line under the price, in three languages; no other card changes', () => {
  for (const l of LANGS) {
    const html = wrap(createElement(CardPrice, { p: card({ price_estimate: true }) }), l);
    assert.match(html, /data-price-estimate="true"[^>]*text-text-muted/);
    assert.ok(text(html).includes(ESTIMATE_STRINGS.label[l]), `${l}: «${text(html)}»`);
    assert.match(text(html), /25,000/, 'the figure is the card’s own, unchanged');
  }
  const plain = wrap(createElement(CardPrice, { p: card() }));
  assert.doesNotMatch(plain, /data-price-estimate/);
  assert.equal(plain, wrap(createElement(CardPrice, { p: card({ price_estimate: undefined }) })));
  // A catalog-only card never carries the label, whatever it says.
  const unpriced = wrap(createElement(CardPrice, { p: card({ price_status: 'unpriced', price_iqd: null, display_price_iqd: null, price_estimate: true }) }));
  assert.doesNotMatch(unpriced, /data-price-estimate/);
  assert.match(text(unpriced), new RegExp(UNPRICED_TEXT.ar));
});

test('a compact card: «تقديري» takes the second line after a live offer and before the member line', () => {
  for (const l of LANGS) {
    const html = wrap(createElement(CardPrice, { p: card({ price_estimate: true }), density: 'compact' }), l);
    assert.match(html, /data-price-estimate="true"/);
    assert.ok(text(html).includes(ESTIMATE_STRINGS.labelShort[l]), `${l}: «${text(html)}»`);
    assert.doesNotMatch(text(html), /23,000/, 'the member line yields to the estimate');
  }
  // The member line is back on a confirmed price.
  assert.match(text(wrap(createElement(CardPrice, { p: card(), density: 'compact' }))), /23,000 لأعضاء PRO/);
  // A live offer's struck price comes first: the row holds the offer, not the label.
  const offer = wrap(
    createElement(CardPrice, {
      p: card({ price_estimate: true, display_offer_before_iqd: 30_000, display_offer_saving_percent: 17 }),
      density: 'compact',
    })
  );
  assert.match(offer, /line-through[^>]*>30,000</);
  assert.doesNotMatch(offer, /data-price-estimate/);
  // The two fixed rows keep their height.
  assert.match(wrap(createElement(CardPrice, { p: card({ price_estimate: true }), density: 'compact' })), /mt-px flex h-\[15px\]/);
});

test('the compare row carries the card’s label beside an estimated figure, and only there', () => {
  const products = [
    { id: 'p1', slug: 'p1', name: { ar: 'A', en: 'A', ckb: 'A' }, image: null, price_iqd: 1_000_000, price_status: 'priced', price_estimate: true },
    { id: 'p2', slug: 'p2', name: { ar: 'B', en: 'B', ckb: 'B' }, image: null, price_iqd: 1_200_000, price_status: 'priced' },
  ] as unknown as CompareProductCard[];
  const row = {
    field_id: 'price_iqd',
    label: { ar: 'السعر', en: 'Price', ckb: 'نرخ' },
    weight: 0,
    values: [
      { raw: '1000000', num: 1_000_000, text: '1,000,000 IQD', missing: false },
      { raw: '1200000', num: 1_200_000, text: '1,200,000 IQD', missing: false },
    ],
    winners: [],
  } as unknown as CompareRow;
  for (const l of LANGS) {
    const html = wrap(createElement(PriceRow, { products, row }), l);
    assert.equal((html.match(/data-price-estimate/g) ?? []).length, 1, 'one column is an estimate');
    assert.ok(text(html).includes(ESTIMATE_STRINGS.label[l]));
  }
});

// ---------------------------------------------------------------- the product page

test('EstimateNotice is a lazy chunk the page mounts only for an estimated selection; the page never imports the contract', () => {
  const page = read('src/pages/Product.tsx');
  assert.match(page, /const EstimateNotice = React\.lazy\(\(\) => import\('\.\.\/components\/product\/EstimateNotice'\)\);/);
  assert.doesNotMatch(page, /^import EstimateNotice|^import \{[^}]*\} from '\.\.\/components\/product\/EstimateNotice'/m);
  // The contract is reached only through a dynamic import (the refusal sentences), never statically.
  assert.doesNotMatch(page, /^import [^;]*packages\/contracts\/src\/priceEstimates'/m);
  assert.match(page, /const loadEstimateWords = \(\) => import\('\.\.\/\.\.\/packages\/contracts\/src\/priceEstimates'\);/);
  // Under the price card, in one layout only, and only while the selection is an estimate — or, in «عدة ألوان»,
  // while the panel's total is (review r2-multi-notice).
  assert.match(page, /\(selectionEstimate \|\| \(colourMulti && multiEstimate\)\) && source === 'catalog' && wideLayout === wide \?/);
  assert.match(page, /\{priceBlock\}\s*\{estimateNotice\(false\)\}/);
  assert.match(page, /\{priceBlock\}\s*\{estimateNotice\(true\)\}/);
  // The chip beside the price is the eager label, never a lazy fetch.
  assert.match(page, /import \{ ESTIMATE_TEXT, UNPRICED_TEXT \} from '\.\.\/lib\/priceStatus';/);
  assert.match(page, /tr\(ESTIMATE_TEXT\.ar, ESTIMATE_TEXT\.en, ESTIMATE_TEXT\.ckb\)/);
});

test('the selection’s label fails closed: the quote that answers it decides, the product’s label stands in until one does', () => {
  const page = read('src/pages/Product.tsx');
  assert.match(
    page,
    /const selectionEstimate = !noPrice && \(quoteFresh \? quote!\.price_estimate === true : product\.price_estimate === true\);/
  );
  // The quote held in state keeps the answer's label with its figures: the detail's opening one and every quote's.
  assert.match(page, /setQuote\(data\.pricing \? withEstimate\(\{ \.\.\.data\.pricing, qty: 1, line_total_iqd: data\.pricing\.unit_subtotal_iqd \}, data\) : null\);/);
  assert.match(page, /setQuote\(withEstimate\(res\.quote, res\)\);/);
  // The chip stands beside whatever names the figure; the phone bar's figure is named an estimate too.
  assert.match(page, /\{selectionEstimate \? \(\s*<span className="inline-flex flex-wrap items-center gap-1\.5">\s*\{figureLabel\}\s*\{estimateChip\}/);
  assert.match(page, /\{selectionEstimate \? tr\(ESTIMATE_TEXT\.ar, ESTIMATE_TEXT\.en, ESTIMATE_TEXT\.ckb\) : s\.price\}/);
  assert.match(page, /\{selectionEstimate \? `\$\{tr\(ESTIMATE_TEXT\.ar, ESTIMATE_TEXT\.en, ESTIMATE_TEXT\.ckb\)\} ·` : cs\.priceWithColour\}/);
  // An estimate refusal at the cart door is said from the contract first, in the reader's language.
  assert.match(page, /estimateSaid = estimateRefusalText\(code, lang\);/);
  assert.match(page, /estimateSaid \|\| counted \|\|/);
});

test('«عدة ألوان»: the page hands the panel its label; the total and each colour’s price carry the eager words', () => {
  const page = read('src/pages/Product.tsx');
  const at = page.indexOf('<ColourQuantityPanel');
  const element = page.slice(at, page.indexOf('/>', at));
  // The product's or the selection's label stands in for a colour until its own quote answers (fail closed).
  assert.match(element, /\bestimate=\{selectionEstimate \|\| product\.price_estimate === true\}/);
  const panel = code('src/components/product/ColourQuantityPanel.tsx');
  assert.match(panel, /^import \{ ESTIMATE_SHORT, ESTIMATE_TEXT \} from '\.\.\/\.\.\/lib\/priceStatus';$/m);
  assert.doesNotMatch(panel, /^import [^;]*packages\/contracts\/src\/priceEstimates'/m, 'the contract stays a lazy import');
  // Each colour keeps its own quote's label; the rows and the total read it.
  assert.match(panel, /estimate: quoteEstimated\(res\),/);
  assert.match(panel, /const totalEstimate = totalEstimated\(live\.map\(\(r\) => freshQuote\(r\.id\)\), estimate\);/);
  assert.match(panel, /if \(rowEstimated\(q, estimate\)\) \{/);
  // The caption in the bar and the panel, and the total read aloud.
  assert.match(panel, /\{totalEstimate \? `\$\{ESTIMATE_TEXT\[cl\]\} · \$\{cs\.totalCaption\}` : cs\.totalCaption\}/);
  assert.match(panel, /totalEstimate \? `\$\{said\} · \$\{ESTIMATE_TEXT\[cl\]\}` : said/);
  // Each answer becomes a row through the one pure function the tests run (tests/priceEstimateStorefrontRowQuote.test.ts).
  assert.match(panel, /setQuotes\(\(now\) => \(\{ \.\.\.now, \[key\]: rowQuoteOf\(res\) \}\)\);/);
  assert.match(panel, /^export function rowQuoteOf\(res: QuoteAnswer\): RowQuote \{/m);
});

test('«عدة ألوان»: the notice and «تواصل معنا» follow the panel’s total, not only the colour the page holds (review r2-multi-notice)', () => {
  const page = read('src/pages/Product.tsx');
  const panel = code('src/components/product/ColourQuantityPanel.tsx');
  // The panel tells the page its total's label whenever it changes, and «no» once it is gone.
  assert.match(panel, /onEstimateChange\?: \(estimate: boolean\) => void;/);
  assert.match(panel, /useEffect\(\(\) => \{\s*onEstimateChange\?\.\(totalEstimate\);\s*\}, \[totalEstimate, onEstimateChange\]\);/);
  assert.match(panel, /useEffect\(\(\) => \(\) => onEstimateChange\?\.\(false\), \[onEstimateChange\]\);/);
  // The page keeps it (a state setter: one stable callback) and reads it only while «عدة ألوان» is open.
  assert.match(page, /const \[multiEstimate, setMultiEstimate\] = useState\(false\);/);
  const at = page.indexOf('<ColourQuantityPanel');
  assert.match(page.slice(at, page.indexOf('/>', at)), /\bonEstimateChange=\{setMultiEstimate\}/);
  assert.match(page, /\(selectionEstimate \|\| \(colourMulti && multiEstimate\)\) && source === 'catalog' && wideLayout === wide \?/);
  // No new words: the notice is the same lazy chunk.
  assert.equal((page.match(/<EstimateNotice /g) ?? []).length, 1);
});

test('⚡ Quick Buy is not offered for an estimated selection', () => {
  const page = read('src/pages/Product.tsx');
  assert.match(page, /const showQuickBuyToggle = isAuthenticated && source === 'catalog' && !selectionEstimate;/);
  assert.match(page, /const quickBuyOn = !!product && quickBuyFor === product\.id && !selectionEstimate;/);
  assert.match(page, /quickBuyOn=\{quickBuyFor === product\.id && !selectionEstimate\}/);
  // The buy row falls back to the one cart button whenever the toggle is not shown.
  assert.match(page, /showQuickBuyToggle && product \? \(\s*<QuickBuyBar/);
});

test('the notice: the contract’s sentence and a small «تواصل معنا» to the assistant, in three languages', () => {
  assert.equal(ESTIMATE_SUPPORT_PATH, `/support?ask=${ESTIMATE_SUPPORT_INTENT}`);
  assert.equal(ESTIMATE_SUPPORT_PATH, '/support?ask=price_estimate');
  for (const l of LANGS) {
    const html = wrap(createElement(EstimateNotice, { name: 'Bambu PLA Basic' }), l);
    assert.ok(text(html).includes(ESTIMATE_STRINGS.notice[l]), `${l}: the notice`);
    assert.ok(text(html).includes(ESTIMATE_STRINGS.contact[l]), `${l}: the contact link`);
    assert.match(html, /<a [^>]*data-estimate-contact[^>]*href="\/support\?ask=price_estimate"/);
    // No figure, source or measure is ever said here.
    assert.doesNotMatch(text(html), /[0-9٠-٩]|IQD|د\.ع|CNY|EUR|Tmall/);
  }
});

test('the link hands the ticket subject over in the reader’s language — the order too on an order page — and sends nothing', () => {
  for (const l of LANGS) {
    const state = estimateSupportState('  Bambu PLA Basic ', l);
    assert.deepEqual(state, { subject: fillEstimateText(ESTIMATE_STRINGS.support.subject, { name: 'Bambu PLA Basic' })[l] });
    assert.ok(state.subject.endsWith('Bambu PLA Basic'));
  }
  assert.deepEqual(estimateSupportState('A1 mini', 'en', 'ORD-7K2'), { subject: 'Question about the estimated price: A1 mini', orderId: 'ORD-7K2' });
  // A plain router link: no request, no form, no message.
  const notice = code('src/components/product/EstimateNotice.tsx');
  assert.doesNotMatch(notice, /\bapi\b|fetch\(|onClick/);
});

// ---------------------------------------------------------------- the support door

test('support: `?ask=price_estimate` is allow-listed beside the printer question, and asks with the contract’s chip', () => {
  const page = read('src/pages/Support.tsx');
  assert.equal(ESTIMATE_SUPPORT_INTENT, 'price_estimate');
  // Two allow-listed questions, each by name: never an arbitrary intent from a URL.
  assert.match(page, /if \(qAsk !== 'choose_printer'\) return;/);
  assert.match(page, /if \(qAsk !== 'price_estimate'\) return;/);
  assert.doesNotMatch(page, /send\(\{ intent: qAsk/);
  assert.match(page, /send\(\{ intent: 'price_estimate' \}, ESTIMATE_STRINGS\.support\.chip\[lang\]\)/);
  // The words load with the question; the Support page itself never carries the contract.
  assert.match(page, /const loadEstimateWords = \(\) => import\('\.\.\/\.\.\/packages\/contracts\/src\/priceEstimates'\);/);
  assert.doesNotMatch(page, /^import [^;]*packages\/contracts\/src\/priceEstimates'/m);
});

test('support: the answer comes first — the subject waits in the draft for «التحدث مع الفريق», and a sign-in comes back', () => {
  const page = read('src/pages/Support.tsx');
  // A signed-in arrival with a subject opens the form at once — except when the link asked a question.
  assert.match(page, /const askedByLink = searchParams\.get\('ask'\) === 'price_estimate';/);
  assert.match(page, /if \(hasPrefill && isAuthenticated && !askedByLink\) setShowTicketForm\(true\);/);
  // The link's subject (and order) becomes the draft the form opens with, kept for the tab.
  assert.match(page, /setDraft\(\{ subject: prefill\.subject, body: '', \.\.\.\(prefill\.orderId \? \{ orderId: prefill\.orderId \} : \{\}\) \}\);/);
  assert.match(page, /initial=\{draft \?\? prefill\}/);
  assert.match(page, /typeof raw\.draft\.orderId === 'string' \? \{ orderId: raw\.draft\.orderId\.slice\(0, 64\) \}/);
  // «تسجيل الدخول» goes through the shared prompt, which returns to this conversation.
  assert.match(page, /onClick=\{\(\) => \(l\.to === '\/auth' \? signIn\(\) : navigate\(l\.to\)\)\}/);
});
