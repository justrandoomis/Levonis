/**
 * «روابط المورّد» OF ONE PRODUCT ON THE OWNER'S SCREENS — HIS OWN LINKS BESIDE
 * THE MATCHED ONES (docs/SMART_PRICING.md §3.10; DECISIONS row 293; the
 * owner's request of 2026-11-05: «i need to save the link so i can easily track
 * price from supplier or on pre order item to order it or when i need to future
 * buy on inventory»).
 *
 *   - a link opens in a new tab without an opener or a referrer, its host shown
 *     left to right; a stored address that does not read back to itself is
 *     never drawn, its text shown instead — in three languages;
 *   - the card (product form) and the strip (purchase line, order line): his
 *     links, the matched ones, the last known supplier price, up to three
 *     pages to open at once, add / edit / remove only with the session's write
 *     hint, none on a saved purchase line, and the «not installed» notice;
 *   - the strip trusts only his own prices and CONFIRMED matches: a suggestion
 *     is never one tap away nor quoted as the supplier's price; the price is
 *     the latest one, per unit as the estimate divides a pack (one function),
 *     with its own words, its day and the SKU it is of;
 *   - each row's edit and remove are named by their link, and the keyboard
 *     lands on the panel's heading when a removed row goes;
 *   - a read with nothing to show (an older Worker's bare 404, a product gone)
 *     is never a red refusal: a strip says nothing, the card the calm notice;
 *   - a note keeps its lines;
 *   - the sheet says the server's refusals beside their fields;
 *   - THE HOSTS: one lazy chunk, mounted only for the owner — the product form
 *     under `v2.owner && productId && v2.mode === 'stored'`, the purchase
 *     wizard and a saved purchase under `can_view_cost === true` (never a
 *     blocker, never in the dock, no new purchase-* id), a pre-order line of an
 *     order under `can_view_cost === true` (never a gift, a bundle or a line
 *     whose product is gone, and never inside a price panel any admin reads);
 *     no browser storage.
 *
 * Run: node --import tsx --test tests/supplierLinksUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codeOf } from './fixtures/source';
import { LanguageProvider } from '../src/LanguageContext';
import { ApiError } from '../src/lib/api';
import SupplierLinksPanel, {
  OwnerLinkAnchor,
  OwnerLinkRow,
  SupplierLinksFailure,
  SupplierLinksView,
  appliesText,
  headingOf,
  isAbsentRead,
  isRouteMissing,
  lastKnownPrice,
  orderLineComboKey,
  quickLinks,
} from '../src/components/adminEstimates/SupplierLinksPanel';
import { skuComboKey } from '../packages/pricing/src/skuChannel';
import { refusalOf, urlErrorText } from '../src/components/adminEstimates/OwnerLinkSheet';
import { BANNER, COMMON, LINKS, OWNER_LINKS, OWNER_LINK_ERROR_TEXT, say, type UiLang } from '../src/components/adminEstimates/strings';
import type { LinkSku, OwnerLink, OwnerLinksAnswer, SupplierLink } from '../src/components/adminEstimates/api';
import { OWNER_LINK_ERRORS, OWNER_LINK_MAX, OWNER_LINKS_PER_PRODUCT } from '../packages/catalog/src/supplierPrices/ownerLink';
import { supplierItemUrl, supplierSkuUrl } from '../packages/catalog/src/supplierPrices/links';
import { unitPriceOf } from '../packages/catalog/src/supplierPrices/format';
import { unitPriceOf as estimateUnitPriceOf } from '../worker/lib/supplierPrices/store';

const LANGS: readonly UiLang[] = ['ar', 'en', 'ckb'];

let LANG: UiLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => {},
  removeItem: () => {},
};
function inLang(child: ReactElement, lang: UiLang): string {
  LANG = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: child }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]?.replace(/&amp;/g, '&') ?? null;

// ---------------------------------------------------------------- fixtures

const AT = '2026-11-05T09:00:00.000Z';
const ownLink = (over: Partial<OwnerLink> = {}): OwnerLink => ({
  id: 'psl_0123456789abcdef0123456789abcdef',
  combo_key: 'o:v_combo|c:c_blk',
  labels: { ar: 'مع AMS · أسود', en: 'H2D AMS Combo · Black', ckb: 'لەگەڵ AMS · ڕەش' },
  url: 'https://detail.tmall.com/item.htm?id=693972799714&skuId=4930331344241',
  host: 'detail.tmall.com',
  source: 'tmall_cn',
  item_key: '693972799714',
  sku_key: '4930331344241',
  label: 'Bambu flagship',
  supplier_name: 'Shenzhen 3D',
  note: 'MOQ 2',
  version: 1,
  created_at: AT,
  updated_at: AT,
  ...over,
});
const matched = (over: Partial<SupplierLink> = {}): SupplierLink => ({
  source: 'bambu_eu',
  state: 'auto',
  item_key: 'h2d',
  sku_key: '596571526982115329',
  title: 'Bambu Lab H2D',
  name_en: 'Bambu Lab H2D',
  options: { option1: 'H2D AMS Combo' },
  options_en: { option1: 'H2D AMS Combo' },
  codes: [],
  price: '1599',
  currency: 'EUR',
  price_label: '',
  captured_on: '2026-10-30',
  quantity: null,
  item_url: supplierItemUrl('bambu_eu', 'h2d'),
  sku_url: supplierSkuUrl('bambu_eu', 'h2d', '596571526982115329'),
  missing: false,
  match_confidence: 'high',
  match_method: 'handle',
  match_reasons: [],
  units_per_offer: 1,
  decided_at: AT,
  note: '',
  ...over,
});
const sku = (supplier_prices: SupplierLink[], combo_key = 'o:v_combo|c:c_blk'): LinkSku => ({
  combo_key,
  labels: { ar: 'مع AMS · أسود', en: 'H2D AMS Combo · Black', ckb: 'لەگەڵ AMS · ڕەش' },
  supplier_prices,
});
const answerOf = (links: OwnerLink[], skus: LinkSku[], over: Partial<OwnerLinksAnswer> = {}): OwnerLinksAnswer => ({
  installed: true,
  scope_key: 'o:v_combo|c:c_blk',
  product: {
    product_id: 'p_h2d',
    name: 'Bambu Lab H2D',
    names: { ar: 'طابعة H2D', en: 'Bambu Lab H2D', ckb: 'چاپکەری H2D' },
    versions: { matches: '1.1.x', manual: '0.0.', links: '1.1.x' },
    skus,
    supplier_links: links,
    choices: [{ combo_key: '', kind: 'product', labels: { ar: '', en: '', ckb: '' } }],
  },
  ...over,
});

// ---------------------------------------------------------------- the link

test('one of his links opens in a new tab without an opener or a referrer; its host shown; what it belongs to, the supplier and the note said — three languages', () => {
  for (const lang of LANGS) {
    const html = inLang(createElement('ul', null, createElement(OwnerLinkRow, { link: ownLink(), lang })), lang);
    const as = anchors(html);
    assert.equal(as.length, 1);
    assert.equal(attr(as[0]!, 'href'), ownLink().url);
    assert.equal(attr(as[0]!, 'target'), '_blank');
    assert.equal(attr(as[0]!, 'rel'), 'noopener noreferrer');
    // React writes the attribute as `referrerPolicy`; HTML reads attribute names without case.
    assert.match(as[0]!, /\sreferrerpolicy="no-referrer"/i, 'no admin address reaches the supplier');
    const t = text(html);
    for (const w of ['Bambu flagship', 'detail.tmall.com', 'MOQ 2', say(LINKS.newTab, lang), say(OWNER_LINKS.supplierName, lang, { name: 'Shenzhen 3D' }), say(OWNER_LINKS.added, lang, { date: '2026-11-05' })]) {
      assert.ok(t.includes(w), `${lang}: «${w}» in ${t}`);
    }
    assert.ok(t.includes(appliesText(ownLink(), lang)), lang);
    assert.match(html, /<bdi dir="ltr"[^>]*>detail\.tmall\.com<\/bdi>/, 'the host, left to right');
    assert.match(html, /data-copy-id="https:\/\/detail\.tmall\.com\/item\.htm\?id=693972799714&amp;skuId=4930331344241"/, 'a copy button for the address');
    assert.doesNotMatch(html, /data-owner-link-unsafe/);
  }
  // No label: the host names it. The whole product, an edited link.
  const plain = text(inLang(createElement('ul', null, createElement(OwnerLinkRow, { link: ownLink({ label: '', combo_key: '', updated_at: '2026-11-06T00:00:00.000Z' }), lang: 'en' })), 'en'));
  assert.ok(plain.includes(say(OWNER_LINKS.appliesWhole, 'en')) && plain.includes(say(OWNER_LINKS.edited, 'en', { date: '2026-11-06' })), plain);
  assert.equal(appliesText({ combo_key: 'c:c_x', labels: { ar: '', en: '', ckb: '' } }, 'en'), say(OWNER_LINKS.appliesLabel, 'en', { name: 'c:c_x' }), 'a key with no name left is named by itself');
});

test('a stored address that does not read back to itself is never drawn: its text is shown, with the reason', () => {
  for (const hostile of [
    'javascript:alert(1)',
    'http://detail.tmall.com/item.htm?id=1',
    '//detail.tmall.com/item.htm?id=1',
    'https://eu.store.bambulab.com/products/h2d"><script>',
    'data:text/html,hi',
    'https://detail.tmall.com/item.htm?id=1&spm=x',
    'https://127.0.0.1/admin',
  ]) {
    for (const lang of LANGS) {
      const html = inLang(createElement('ul', null, createElement(OwnerLinkRow, { link: ownLink({ url: hostile, label: 'X' }), lang })), lang);
      assert.equal(anchors(html).length, 0, `drawn: ${hostile}`);
      assert.match(html, /data-owner-link-unsafe/);
      assert.ok(text(html).includes(say(OWNER_LINKS.unsafe, lang)), lang);
    }
    assert.equal(renderToStaticMarkup(createElement(OwnerLinkAnchor, { href: hostile, label: 'X', lang: 'en' })), '');
  }
  // React writes the text, never markup: the injected tag stays text.
  const injected = inLang(createElement('ul', null, createElement(OwnerLinkRow, { link: ownLink({ url: 'https://x.example/"><script>alert(1)</script>' }), lang: 'en' })), 'en');
  assert.doesNotMatch(injected, /<script>/);
});

test('a note keeps its lines: the box he typed it in takes a few, and the row shows them as lines', () => {
  for (const lang of LANGS) {
    const html = inLang(createElement('ul', null, createElement(OwnerLinkRow, { link: ownLink({ note: 'MOQ 2\nask for the black one' }), lang })), lang);
    const note = /<p[^>]*data-owner-link-note[^>]*>([\s\S]*?)<\/p>/.exec(html);
    assert.ok(note, lang);
    assert.match(note[0], /class="[^"]*\bwhitespace-pre-line\b/, `${lang}: the line break is drawn`);
    assert.ok(note[1]!.includes('MOQ 2\nask for the black one'), `${lang}: ${note[1]}`);
  }
});

// ---------------------------------------------------------------- the card and the strip

test('the card: his links with his acts, the matched links behind their count, the Links tab one tap away; no act without the write hint', () => {
  const a = answerOf([ownLink(), ownLink({ id: 'psl_b', combo_key: '', url: 'https://www.aliexpress.com/item/1.html', host: 'www.aliexpress.com', source: 'other', label: '' })], [sku([matched()])]);
  for (const lang of LANGS) {
    const html = inLang(createElement(SupplierLinksView, { answer: a, variant: 'card', context: 'product', lang, dir: 'rtl', canWrite: true }), lang);
    assert.match(html, /data-supplier-links="product"/);
    assert.equal((html.match(/data-owner-link="/g) ?? []).length, 2);
    assert.equal((html.match(/data-owner-link-edit=/g) ?? []).length, 2);
    assert.equal((html.match(/data-owner-link-remove=/g) ?? []).length, 2);
    assert.match(html, /data-owner-link-add/);
    // Each row's two buttons are named by their link (the label, else the host), the visible word kept in the name.
    const named = (name: string) => [say(OWNER_LINKS.editNamed, lang, { name }), say(OWNER_LINKS.removeNamed, lang, { name })];
    const labels = [...html.matchAll(/<button\b[^>]*\baria-label="([^"]*)"[^>]*data-owner-link-(?:edit|remove)=/g)].map((m) => m[1]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
    assert.deepEqual(labels, [...named('Bambu flagship'), ...named('www.aliexpress.com')], lang);
    for (const [i, word] of [say(OWNER_LINKS.edit, lang), say(OWNER_LINKS.remove, lang)].entries()) assert.ok(labels[i]!.includes(word), `${lang}: «${labels[i]}» holds «${word}»`);
    // The heading takes the keyboard by script (a removed row's buttons go with it).
    assert.match(html, /<h3[^>]*tabindex="-1"[^>]*data-supplier-links-heading/);
    const t = text(html);
    for (const w of [say(OWNER_LINKS.title, lang), say(OWNER_LINKS.intro, lang), say(OWNER_LINKS.yours, lang), say(BANNER.links, lang, { n: 1 }), say(BANNER.allLinks, lang)]) assert.ok(t.includes(w), `${lang}: «${w}»`);
    // The matched list waits for its toggle.
    assert.doesNotMatch(html, /data-supplier-links-matched/);
    const ws = anchors(html).find((x) => attr(x, 'href')?.startsWith('/admin?'));
    assert.equal(attr(ws!, 'href'), '/admin?tab=pricing&view=estimates&etab=links&product=p_h2d');
  }
  const opened = inLang(createElement(SupplierLinksView, { answer: a, variant: 'card', context: 'product', lang: 'en', dir: 'ltr', canWrite: true, open: true }), 'en');
  assert.match(opened, /data-supplier-links-matched/);
  assert.ok(anchors(opened).some((x) => attr(x, 'href') === 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes'), 'the matched variant link, as the server built it');
  // Without the write hint: the links, no act.
  const readOnly = inLang(createElement(SupplierLinksView, { answer: a, variant: 'card', context: 'product', lang: 'en', dir: 'ltr', canWrite: false }), 'en');
  assert.doesNotMatch(readOnly, /data-owner-link-(add|edit|remove)/);
  // None yet: said so; an older server: no act, and the notice.
  const none = text(inLang(createElement(SupplierLinksView, { answer: answerOf([], []), variant: 'card', context: 'product', lang: 'ckb', dir: 'rtl', canWrite: true }), 'ckb'));
  assert.ok(none.includes(say(OWNER_LINKS.none, 'ckb')));
  const old = inLang(createElement(SupplierLinksView, { answer: answerOf([], [sku([matched()])], { installed: false }), variant: 'card', context: 'product', lang: 'ar', dir: 'rtl', canWrite: true }), 'ar');
  assert.match(old, /data-supplier-links-not-installed/);
  assert.doesNotMatch(old, /data-owner-link-add/);
  assert.ok(text(old).includes(say(OWNER_LINKS.notInstalled, 'ar')));
});

test('the strip: its heading per place, up to three pages to open at once (his first), the last known supplier price, the full list behind its count', () => {
  const links = [ownLink(), ownLink({ id: 'psl_b', url: 'https://item.taobao.com/item.htm?id=7788', host: 'item.taobao.com', source: 'other', label: '' })];
  const a = answerOf(links, [sku([matched({ state: 'manual', source: 'typed', price: '1450', currency: 'EUR', captured_on: '2026-11-01', item_url: null, sku_url: null }), matched()])]);
  for (const lang of LANGS) {
    const html = inLang(createElement(SupplierLinksView, { answer: a, variant: 'strip', context: 'purchase', lang, dir: 'rtl', canWrite: true }), lang);
    assert.match(html, /data-supplier-links="purchase"/);
    const hrefs = anchors(html).map((x) => attr(x, 'href'));
    assert.deepEqual(hrefs, [links[0]!.url, links[1]!.url, 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes'], 'his two, then the matched variant');
    for (const x of anchors(html)) assert.equal(attr(x, 'rel'), 'noopener noreferrer');
    const t = text(html);
    assert.ok(t.includes(say(OWNER_LINKS.title, lang)) && t.includes(say(OWNER_LINKS.showAll, lang, { n: 4 })), `${lang}: ${t}`);
    // The latest trusted price: his own, entered on 2026-11-01, after the capture of 2026-10-30.
    assert.ok(t.includes(say(OWNER_LINKS.lastPrice, lang)) && t.includes('EUR 1,450') && t.includes(say(LINKS.entered, lang, { date: '2026-11-01' })), t);
    assert.doesNotMatch(html, /data-supplier-links-price-units/, 'not a pack');
    assert.match(html, /<span[^>]*tabindex="-1"[^>]*data-supplier-links-heading/, 'the heading takes the keyboard by script');
    assert.match(html, /data-owner-link-add/);
    assert.doesNotMatch(html, /data-owner-link="/, 'the full list waits for its toggle');
  }
  const open = inLang(createElement(SupplierLinksView, { answer: a, variant: 'strip', context: 'purchase', lang: 'en', dir: 'ltr', canWrite: true, open: true }), 'en');
  assert.equal((open.match(/data-owner-link="/g) ?? []).length, 2);
  assert.match(open, /data-supplier-links-matched/);
  // A saved purchase line: «buy again», no act at all.
  const saved = inLang(createElement(SupplierLinksView, { answer: a, variant: 'strip', context: 'purchase', lang: 'en', dir: 'ltr', canWrite: true, readOnly: true, open: true }), 'en');
  assert.ok(text(saved).includes(say(OWNER_LINKS.buyAgain, 'en')));
  assert.doesNotMatch(saved, /data-owner-link-(add|edit|remove)/);
  // An order line: «order it from the supplier».
  assert.ok(text(inLang(createElement(SupplierLinksView, { answer: a, variant: 'strip', context: 'order', lang: 'ckb', dir: 'rtl', canWrite: true }), 'ckb')).includes(say(OWNER_LINKS.orderFrom, 'ckb')));
  // Nothing for this option yet: said so, and the add.
  const empty = inLang(createElement(SupplierLinksView, { answer: answerOf([], []), variant: 'strip', context: 'order', lang: 'ar', dir: 'rtl', canWrite: true }), 'ar');
  assert.ok(text(empty).includes(say(LINKS.noLinkForSku, 'ar')));
  assert.match(empty, /data-owner-link-add/);
  assert.equal(anchors(empty).length, 0);
});

test('the strip’s helpers: three pages at most, no address twice, a rejected or own-price fact never offered; the heading per place', () => {
  const own = [ownLink(), ownLink({ id: 'psl_x', url: 'javascript:alert(1)' }), ownLink({ id: 'psl_dup' })];
  const facts = [sku([matched({ state: 'rejected', sku_url: supplierSkuUrl('bambu_eu', 'h2d', '1') }), matched({ state: 'manual', source: 'typed', item_url: null, sku_url: null }), matched(), matched({ sku_url: null })])];
  const q = quickLinks(own, facts);
  assert.deepEqual(
    q.map((x) => (x.kind === 'owner' ? x.link.id : x.href)),
    [ownLink().id, 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes', 'https://eu.store.bambulab.com/products/h2d?skr=yes']
  );
  assert.equal(quickLinks([ownLink(), ownLink({ id: 'a', url: 'https://a.example/' }), ownLink({ id: 'b', url: 'https://b.example/' }), ownLink({ id: 'c', url: 'https://c.example/' })], facts).length, 3);
  // A match he confirmed is offered like an automatic one; a suggestion never is, wherever it is listed.
  const tmall = (over: Partial<SupplierLink>) =>
    matched({ source: 'tmall_cn', item_key: '693972799714', sku_key: '4930331344241', currency: 'CNY', item_url: supplierItemUrl('tmall_cn', '693972799714'), sku_url: supplierSkuUrl('tmall_cn', '693972799714', '4930331344241'), ...over });
  assert.deepEqual(quickLinks([], [sku([tmall({ state: 'confirmed' })])]).map((x) => x.kind === 'matched' && x.href), [supplierSkuUrl('tmall_cn', '693972799714', '4930331344241')]);
  assert.deepEqual(quickLinks([], [sku([tmall({ state: 'suggested', match_confidence: 'low' })])]), [], 'an unconfirmed match is never one tap away');
  assert.deepEqual(
    quickLinks([], [sku([tmall({ state: 'suggested' })], 'o:v_combo|c:c_blk'), sku([matched()], 'o:v_combo|c:c_wht')]).map((x) => x.kind === 'matched' && x.link.state),
    ['auto'],
    'a suggestion on the first SKU does not take a place'
  );
  assert.equal(headingOf('product', false), OWNER_LINKS.title);
  assert.equal(headingOf('purchase', false), OWNER_LINKS.title);
  assert.equal(headingOf('purchase', true), OWNER_LINKS.buyAgain);
  assert.equal(headingOf('order', false), OWNER_LINKS.orderFrom);
});

test('the strip’s last known price: his own or a confirmed match, never a suggestion; the latest; one unit of a pack as the estimate divides it; its words, day and SKU', () => {
  const cny = (over: Partial<SupplierLink>) =>
    matched({ source: 'tmall_cn', state: 'confirmed', item_key: '693972799714', sku_key: '4930331344241', currency: 'CNY', price: '89', price_label: '', captured_on: '2026-10-30', ...over });
  const fields = (skus: LinkSku[]) => {
    const p = lastKnownPrice(skus);
    return p && { price: p.price, units: p.units, label: p.label, date: p.date, entered: p.entered, outOfStock: p.outOfStock, sku: p.sku.combo_key };
  };
  assert.equal(lastKnownPrice([]), null);
  // A suggestion is unconfirmed: no price quoted from it, alone or first.
  assert.equal(lastKnownPrice([sku([cny({ state: 'suggested' })])]), null, 'a suggested match alone');
  assert.equal(lastKnownPrice([sku([cny({ state: 'rejected' })])]), null, 'a rejected match');
  assert.deepEqual(fields([sku([cny({ state: 'suggested', price: '89' })], 'o:v_a|c:c_blk'), sku([cny({ price: '120' })], 'o:v_a|c:c_wht')]), {
    price: 'CNY 120',
    units: 1,
    label: '',
    date: '2026-10-30',
    entered: false,
    outOfStock: false,
    sku: 'o:v_a|c:c_wht',
  });
  // A key gone from the newest capture shows no price; the next trusted fact does.
  assert.deepEqual(fields([sku([matched({ missing: true, price: null }), matched({ price: '1599', currency: 'EUR', captured_on: '2026-10-30' })])])?.price, 'EUR 1,599');
  // The latest day wins: a capture of 2026-10-30 over his price typed on 2026-03-01; on the same day, his own price.
  const typed = (amount: string, on: string) => matched({ state: 'manual', source: 'typed', item_key: null, sku_key: null, price: amount, currency: 'EUR', captured_on: on, item_url: null, sku_url: null, units_per_offer: 1 });
  assert.deepEqual(fields([sku([typed('1399', '2026-03-01'), matched({ price: '1599', captured_on: '2026-10-30' })])])?.price, 'EUR 1,599');
  assert.deepEqual(fields([sku([matched({ price: '1599', captured_on: '2026-10-30' }), typed('1450', '2026-10-30')])]), {
    price: 'EUR 1,450',
    units: 1,
    label: '',
    date: '2026-10-30',
    entered: true,
    outOfStock: false,
    sku: 'o:v_combo|c:c_blk',
  });
  // A pack of four at CNY 400 is CNY 100 a unit — the estimate's own division, by the very function the estimate calls.
  assert.equal(unitPriceOf, estimateUnitPriceOf, 'one rule: the strip and the estimate divide a pack with the same function');
  assert.deepEqual(fields([sku([cny({ price: '400', units_per_offer: 4, price_label: '优惠前' })])]), {
    price: 'CNY 100',
    units: 4,
    label: '优惠前',
    date: '2026-10-30',
    entered: false,
    outOfStock: false,
    sku: 'o:v_combo|c:c_blk',
  });
  assert.equal(fields([sku([cny({ price: '100', units_per_offer: 3 })])])?.price, `CNY ${unitPriceOf('100', 3)}`, 'rounded up, never under');
  // Out of stock at the capture: still the last price known, said so. A price the estimate could not read is never quoted.
  assert.equal(fields([sku([cny({ quantity: 0 })])])?.outOfStock, true);
  assert.equal(lastKnownPrice([sku([cny({ price: '1.2.3' }), cny({ price: '90', units_per_offer: 0 })])]), null);

  // Drawn beside the raw unit price: one unit's figure, «divided by 4 units», the price's own words, the day; never the pack's figure.
  const strip = (skus: LinkSku[], lang: UiLang) => inLang(createElement(SupplierLinksView, { answer: answerOf([], skus), variant: 'strip', context: 'purchase', lang, dir: lang === 'en' ? 'ltr' : 'rtl', canWrite: true }), lang);
  for (const lang of LANGS) {
    const pack = strip([sku([cny({ price: '400', units_per_offer: 4, price_label: '优惠前', quantity: 0 })])], lang);
    const line = text(/<p[^>]*data-supplier-links-price[^>]*>[\s\S]*?<\/p>/.exec(pack)![0]);
    for (const w of [say(OWNER_LINKS.lastPrice, lang), 'CNY 100', '优惠前', say(LINKS.unitsDivided, lang, { n: 4 }), say(LINKS.captured, lang, { date: '2026-10-30' }), say(LINKS.outOfStock, lang)]) {
      assert.ok(line.includes(w), `${lang}: «${w}» in «${line}»`);
    }
    assert.ok(!text(pack).includes('CNY 400'), `${lang}: the pack’s figure is not quoted as the supplier price`);
    assert.ok(!line.includes(sku([]).labels[lang]), `${lang}: one SKU in the row — not named again`);
    // A suggestion alone: no price, no page in one tap; it waits in the full list with its state said.
    const suggested = strip([sku([cny({ state: 'suggested' })])], lang);
    assert.doesNotMatch(suggested, /data-supplier-links-price/, lang);
    assert.equal(anchors(suggested).length, 0, `${lang}: no anchor in the collapsed strip`);
    const opened = inLang(createElement(SupplierLinksView, { answer: answerOf([], [sku([cny({ state: 'suggested' })])]), variant: 'strip', context: 'purchase', lang, dir: 'rtl', canWrite: true, open: true }), lang);
    assert.match(opened, /data-link-state="suggested"/, lang);
    // Several SKUs in the row: the price names the SKU it is of.
    const two = strip([sku([cny({ price: '89' })], 'o:v_combo|c:c_blk'), { ...sku([cny({ price: '95', captured_on: '2026-10-31' })], 'o:v_combo|c:c_wht'), labels: { ar: 'مع AMS · أبيض', en: 'H2D AMS Combo · White', ckb: 'لەگەڵ AMS · سپی' } }], lang);
    const named = text(/<p[^>]*data-supplier-links-price[^>]*>[\s\S]*?<\/p>/.exec(two)![0]);
    assert.ok(named.includes('CNY 95') && named.includes(say(OWNER_LINKS.appliesLabel, lang, { name: { ar: 'مع AMS · أبيض', en: 'H2D AMS Combo · White', ckb: 'لەگەڵ AMS · سپی' }[lang] })), `${lang}: ${named}`);
  }
});

test('an order line is read by its exact SKU, keyed exactly as skuComboKey keys it — its option values, else its one option, and its colour', () => {
  const sel = (option_value_ids: string[], option_id = '', color_id = '') => ({ option_id, option_value_ids, color_id, transport_method: '' as const, warranty_plan_id: '' });
  for (const [s, ids, colour] of [
    [sel(['v_b', 'v_a'], 'v_b', 'c_blk'), ['v_b', 'v_a'], 'c_blk'],
    [sel([], 'v_combo', 'c_wht'), ['v_combo'], 'c_wht'],
    [sel([], '', 'c_blk'), [], 'c_blk'],
    [sel(['v_only']), ['v_only'], null],
    [sel([]), [], null],
    [sel(['Z', 'a', '10', '9']), ['Z', 'a', '10', '9'], null],
  ] as const) {
    assert.equal(orderLineComboKey(s), skuComboKey({ option_value_ids: ids, color_id: colour }), JSON.stringify(s));
  }
  assert.equal(orderLineComboKey(sel(['v_b', 'v_a'], 'v_b', 'c_blk')), 'o:v_a|o:v_b|c:c_blk');
  assert.equal(orderLineComboKey(sel([])), '', 'no selection: the whole product');
});

test('the panel reads nothing on the server render: the card says it is loading, the strip draws nothing', () => {
  assert.match(inLang(createElement(SupplierLinksPanel, { productId: 'p_h2d', variant: 'card', context: 'product' }), 'en'), /data-supplier-links-loading/);
  assert.equal(inLang(createElement(SupplierLinksPanel, { productId: 'p_h2d', scope: { combo_key: 'o:v_combo' }, variant: 'strip', context: 'order' }), 'en'), '');
});

test('a read with nothing to show is not a failure: an older Worker’s bare 404 or a product gone leaves a strip empty and the card calm; any other failure offers a retry', () => {
  // An older Worker answers its bare `{success:false, error:'Not found'}` (no code); a product gone answers NOT_FOUND.
  const older = new ApiError(404, 'Not found');
  const gone = new ApiError(404, 'Not found', 'NOT_FOUND');
  const broken = new ApiError(500, '', undefined);
  assert.deepEqual([isAbsentRead(older), isRouteMissing(older)], [true, true]);
  assert.deepEqual([isAbsentRead(gone), isRouteMissing(gone)], [true, false]);
  assert.deepEqual([isAbsentRead(broken), isRouteMissing(broken), isAbsentRead(new Error('x'))], [false, false, false]);
  const failure = (error: unknown, variant: 'card' | 'strip', lang: UiLang, canWrite = true) =>
    inLang(createElement(SupplierLinksFailure, { error, variant, context: variant === 'card' ? 'product' : 'purchase', lang, dir: 'rtl', canWrite, onRetry: () => {} }), lang);
  for (const lang of LANGS) {
    // Every purchase and pre-order line stays quiet: no error, no retry that can never succeed.
    assert.equal(failure(older, 'strip', lang), '', lang);
    assert.equal(failure(gone, 'strip', lang), '', lang);
    // The card: the calm notice, never the red refusal «Not found».
    const card = failure(older, 'card', lang);
    assert.match(card, /data-supplier-links-not-installed/);
    assert.match(card, /role="status"/);
    assert.doesNotMatch(card, /role="alert"|data-estimates-refusal|lv-alert-danger/, lang);
    assert.ok(text(card).includes(say(OWNER_LINKS.notInstalled, lang)), lang);
    assert.equal(failure(older, 'card', lang, false), '', `${lang}: nothing to save for a reader who cannot write`);
    // Any other failure: a strip offers a retry.
    const retry = failure(broken, 'strip', lang);
    assert.match(retry, /data-supplier-links-error/);
    assert.ok(text(retry).includes(say(COMMON.loadFailed, lang)) && text(retry).includes(say(COMMON.retry, lang)), lang);
  }
  // A product gone while its form is open is a real refusal on the card.
  assert.match(failure(gone, 'card', 'en'), /data-estimates-refusal="NOT_FOUND"/);
  // The panel draws its failure through this one component.
  assert.match(codeOf('src/components/adminEstimates/SupplierLinksPanel.tsx'), /if \(error\) return <SupplierLinksFailure error=\{error\} variant=\{variant\}/);
});

// ---------------------------------------------------------------- the sheet

test('the sheet says each refusal beside its field, in three languages: every parser reason, a duplicate, the cap, a key gone, a text', () => {
  const refused = (details: Record<string, unknown>) => new ApiError(400, 'x', 'PRICING_INPUT_INVALID', details);
  for (const lang of LANGS) {
    for (const reason of OWNER_LINK_ERRORS) {
      assert.deepEqual(refusalOf(refused({ field: 'url', reason }), lang), { errors: { url: urlErrorText(reason, lang) }, form: null });
      assert.ok(urlErrorText(reason, lang).length > 0 && !urlErrorText(reason, lang).includes('{n}'), `${lang} ${reason}`);
    }
    assert.ok(urlErrorText('too_long', lang).includes(String(OWNER_LINK_MAX)), lang);
    assert.equal(urlErrorText('host', lang), say(OWNER_LINK_ERROR_TEXT.host, lang));
    assert.deepEqual(refusalOf(refused({ field: 'url', reason: 'duplicate' }), lang), { errors: { url: say(OWNER_LINKS.duplicate, lang) }, form: null });
    assert.deepEqual(refusalOf(refused({ field: 'url', reason: 'toString' }), lang), { errors: { url: urlErrorText('not_url', lang) }, form: null });
    assert.deepEqual(refusalOf(refused({ field: 'upsert', reason: 'limit' }), lang), { errors: {}, form: say(OWNER_LINKS.limit, lang, { n: OWNER_LINKS_PER_PRODUCT }) });
    assert.deepEqual(refusalOf(refused({ field: 'combo_key' }), lang), { errors: {}, form: say(OWNER_LINKS.keyGone, lang) });
    for (const [field, key] of [['label', 'label'], ['supplier_name', 'supplier'], ['note', 'note']] as const) {
      assert.deepEqual(refusalOf(refused({ field }), lang), { errors: { [key]: say(OWNER_LINKS.textInvalid, lang) }, form: null });
    }
    // Anything else is the shared refusal table's (useAct says it): a stale token, the door, an older database.
    for (const other of [new ApiError(409, 'x', 'PRICING_CHANGED'), new ApiError(503, 'x', 'SUPPLIER_LINKS_NOT_INSTALLED'), refused({ field: 'version' }), new Error('x')]) {
      assert.equal(refusalOf(other, lang), null);
    }
  }
  assert.ok(say(OWNER_LINKS.limit, 'en', { n: OWNER_LINKS_PER_PRODUCT }).includes('40'));
});

// ---------------------------------------------------------------- the hosts

test('the product form mounts the card lazily, for the owner and a stored product only, right after the estimate banner', () => {
  const section = codeOf('src/components/adminProducts/form/v2/PricesSectionV2.tsx');
  assert.match(section, /const SupplierLinksPanel = lazy\(\(\) => import\('\.\.\/\.\.\/\.\.\/adminEstimates\/SupplierLinksPanel'\)\);/);
  assert.match(
    section,
    /\{v2\.owner && productId && v2\.mode === 'stored' \? \(\s*<Suspense fallback=\{null\}>\s*<SupplierLinksPanel productId=\{productId\} variant="card" context="product" \/>/
  );
  // The banner's tag may run over several lines: found by its name alone, and found at all.
  const banner = section.search(/<EstimateBanner\b/);
  assert.ok(banner >= 0 && banner < section.search(/<SupplierLinksPanel\b/), 'after the banner');
  assert.equal((section.match(/<SupplierLinksPanel /g) ?? []).length, 1);
});

test('the purchase wizard: a strip under each step-2 line head and on each saved line, on the owner’s hint — never a blocker, never in the dock, no new purchase id', () => {
  const panel = codeOf('src/components/adminOperations/ProcurementPanel.tsx');
  assert.match(panel, /const SupplierLinksPanel = lazy\(\(\) => import\('\.\.\/adminEstimates\/SupplierLinksPanel'\)\);/);
  assert.doesNotMatch(panel, /from '\.\.\/adminEstimates\//, 'never a static import');
  assert.match(panel, /const ownerCost = useOptionalAuth\(\)\?\.user\?\.can_view_cost === true;/);
  const mounts = [...panel.matchAll(/\{ownerCost && l\.product_id && <div className="mb-3 min-w-0" data-purchase-supplier-links=\{[^}]+\}><Suspense fallback=\{null\}><SupplierLinksPanel productId=\{l\.product_id\} scope=\{\{ scope: l\.scope, scope_id: l\.scope_id \}\} variant="strip" context="purchase"( readOnly)? \/><\/Suspense><\/div>\}/g)];
  assert.equal(mounts.length, 2, 'step 2 and the saved lines');
  assert.deepEqual(mounts.map((m) => !!m[1]), [false, true], 'the saved line is read-only');
  assert.equal((panel.match(/<SupplierLinksPanel /g) ?? []).length, 2);
  // Step 2: under the line's head, before the raw price he types.
  const step2 = panel.indexOf('data-purchase-supplier-links={i}');
  assert.ok(step2 > 0 && step2 < panel.indexOf("loc('طريقة إدخال الشراء الخام'") && step2 > panel.indexOf("loc('الكمية', 'Quantity', 'بڕ')"));
  // Never inside the dock, never a blocker, no id of the wizard's own.
  const dock = panel.indexOf('className="inventory-footer inventory-dock"');
  assert.ok(dock > 0 && !panel.slice(dock, panel.indexOf('</div>', panel.indexOf('inventory-dock-actions'))).includes('SupplierLinksPanel'));
  assert.doesNotMatch(codeOf('src/components/adminOperations/purchaseBlockers.ts'), /supplier[_ -]?link|SupplierLinks/i);
  assert.doesNotMatch(panel, /id=["{`][^"}`]*supplier-link/i, 'no element id: the dock’s «اذهب» targets stay the wizard’s');
  // The gates are the old expressions (tests/purchaseBlockers.test.ts pins them whole).
  assert.match(panel, /const nextBlocked = !nameValid \|\| !fundingValid\(funding\) \|\| \(step > 0 && \(!quantitiesValid \|\| !originsValid\)\) \|\| \(step === 2 && \(!costsValid \|\| !draftSerialsValid \|\| !rateReady \|\| pendingInlinePrices\)\);/);
});

test('the order view: a strip on each pre-order line for the owner — never a gift, a bundle or a gone product, never inside a price panel any admin reads', () => {
  const modal = codeOf('src/components/adminOrders/OrderDetailModal.tsx');
  assert.match(modal, /const SupplierLinksPanel = React\.lazy\(\(\) => import\('\.\.\/adminEstimates\/SupplierLinksPanel'\)\);/);
  assert.doesNotMatch(modal, /from '\.\.\/adminEstimates\//);
  assert.match(modal, /const ownerCost = user\?\.can_view_cost === true;/);
  assert.match(
    modal,
    /\{ownerCost && detail\.shipping_type !== 'direct' && it\.product_id && !it\.is_gift && !it\.bundle && \(\s*<div className="w-full min-w-0" data-order-item-supplier-links=\{it\.id\}>\s*<React\.Suspense fallback=\{null\}>\s*<SupplierLinksPanel productId=\{it\.product_id\} scope=\{it\.selection \? \{ order_selection: it\.selection \} : null\} variant="strip" context="order" \/>/
  );
  assert.equal((modal.match(/<SupplierLinksPanel /g) ?? []).length, 1);
  // The modal itself keys nothing: the owner's chunk does (below), so the screen staff read gains no import.
  assert.doesNotMatch(modal, /skuChannel|orderLineComboKey/);
  // The panels every admin reads never carry supplier data.
  for (const f of ['src/components/adminOrders/EstimateConfirmPanel.tsx', 'src/components/adminOrders/PriceAdjustPanel.tsx', 'src/components/adminOrders/PreorderOriginsPanel.tsx']) {
    assert.doesNotMatch(codeOf(f), /SupplierLinks|owner-links|supplier_links|adminEstimates/, f);
  }
});

test('the chunk: acts only on the session’s write hint, no browser storage, every request through api.ts', () => {
  for (const f of ['src/components/adminEstimates/SupplierLinksPanel.tsx', 'src/components/adminEstimates/OwnerLinkSheet.tsx']) {
    const code = codeOf(f);
    assert.doesNotMatch(code, /\b(localStorage|sessionStorage|indexedDB)\b/, f);
    assert.doesNotMatch(code, /\bapi\.(get|post|put|patch|delete)\b|\bfetch\(|['"`]\/api\//, f);
    assert.doesNotMatch(code, /(can_view_cost|can_write_cost|is_owner)\s*!==?\s*false/, `${f}: fail-open`);
  }
  assert.match(codeOf('src/components/adminEstimates/SupplierLinksPanel.tsx'), /const canWrite = useOptionalAuth\(\)\?\.user\?\.can_write_cost === true && !readOnly;/);
  // A removal moves the keyboard to the panel's heading before the row goes with the reload.
  assert.match(codeOf('src/components/adminEstimates/SupplierLinksPanel.tsx'), /refresh\(\);\s*heading\.current\?\.focus\(\);\s*return \{ tone: 'success', text: say\(OWNER_LINKS\.removed, lang\) \};/);
  const api = codeOf('src/components/adminEstimates/api.ts');
  assert.match(api, /api\.get<OwnerLinksAnswer>\(`\$\{SUPPLIER_PRICES_API\}\/owner-links\/\$\{enc\(productId\)\}\$\{qs\}`, opts\)/);
  assert.match(api, /api\.put<OwnerLinksSaved>\(`\$\{SUPPLIER_PRICES_API\}\/owner-links\/\$\{enc\(productId\)\}`, body\)/);
});
