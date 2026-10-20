/**
 * SMART SEARCH 1.7 — THE SEARCH UI SAYS WHAT IT UNDERSTOOD, AND A RESULT
 * OPENS ON WHAT IT MATCHED (the assistant plan §6 «Search bar» and «Result
 * cards», Phase 1 item 1.7).
 *
 *   - the understood chips in Arabic, English and Sorani (a Sorani that is
 *     Sorani, never the Arabic), each removable;
 *   - «لا يوجد تطابق دقيق لـ …» with the results under it labelled as near,
 *     and «تطابق دقيق» when a code was carried;
 *   - the three-state availability on each search row (the shared
 *     `cardAvailability` of packages/catalog);
 *   - `?v=`: the link a result carries, and the product page that decodes it
 *     as untrusted input and opens on that selection — on a phone as on a
 *     desktop (one selection state).
 *
 * Run: node --import tsx --test tests/searchUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { BASE_COLOURS } from '../packages/catalog/src/bambuImport/registry/colours';
import { parseNlQuery, nlChipKey } from '../packages/catalog/src/nlQuery';
import { skuComboKey } from '../packages/pricing/src/skuChannel';
import { linkWithSelection, selectionParam, VARIANT_PARAM as LINK_PARAM } from '../src/components/search/resultLink';
import { linkedSelection, VARIANT_PARAM } from '../src/components/product/priceRequestState';
import { formatIqd, type ApiProduct, type SearchChip } from '../src/lib/api';

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { AuthContext } = await import('../src/AuthContext');
const { WalletProvider } = await import('../src/WalletContext');
const { CurrencyProvider } = await import('../src/CurrencyContext');
const { chipLabel, COLOUR_WORDS, RowNote, SearchHead } = await import('../src/components/search/searchKit');

type Lang = 'ar' | 'en' | 'ckb';
const LANGS: readonly Lang[] = ['ar', 'en', 'ckb'];
const locFor = (lang: Lang) => (ar: string, en: string, ckb: string) => (lang === 'ar' ? ar : lang === 'en' ? en : ckb);
/** A signed-out shopper reading in dinars (no shop rate): the money hook writes «30,000 د.ع». */
const render = (node: ReactNode, lang: Lang) => {
  storedLang = lang;
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
        children: createElement(CurrencyProvider, { children: createElement(LanguageProvider, { children: node }) }),
      }),
    })
  );
};
/** The words as read: tags out (a code in its <bdi> sits inside its quotes), spaces collapsed. */
const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The chips of a query, as the route sends them (the parser chip plus `drop`). */
const chipsOf = (q: string): SearchChip[] => {
  const nl = parseNlQuery(q);
  return nl.understood.map((c) => ({ ...c, drop: nl.without[nlChipKey(c)] }));
};

// ================================================================ the chips

test('row 9 said back: «حتى 30,000 د.ع» and «أسود» — in English and in Sorani, not the Arabic', () => {
  const chips = chipsOf('فلامنت اسود اقل من 30 الف');
  const said = (lang: Lang) => chips.map((c) => chipLabel(c, locFor(lang), formatIqd));
  const thirty = (30_000).toLocaleString();
  assert.deepEqual(said('ar'), [`حتى ${thirty} د.ع`, 'أسود']);
  assert.deepEqual(said('en'), [`Up to ${thirty} د.ع`, 'Black']);
  assert.deepEqual(said('ckb'), [`تا ${thirty} د.ع`, 'ڕەش']);
  // Removing a chip searches the words without it.
  assert.deepEqual(chips.map((c) => c.drop), ['فلامنت اسود', 'فلامنت اقل من 30 الف']);
});

test('every chip kind has three languages, and the Sorani is never the Arabic', () => {
  const all: SearchChip[] = [
    { kind: 'price', min: 25_000, max: 50_000, currency: 'IQD', drop: '' },
    { kind: 'price', min: 1_000_000, max: null, currency: 'IQD', drop: '' },
    { kind: 'price', min: null, max: 500, currency: 'USD', drop: '' },
    { kind: 'sale', value: 'direct', drop: '' },
    { kind: 'sale', value: 'preorder', drop: '' },
    { kind: 'spool', value: 'refill', drop: '' },
    { kind: 'spool', value: 'spool', drop: '' },
    { kind: 'diameter', value: '1.75', drop: '' },
    { kind: 'color', value: 'black', drop: '' },
    { kind: 'color', value: 'white', not: true, drop: '' },
    { kind: 'material', value: 'petg', drop: '' },
    { kind: 'material', value: 'pla', not: true, drop: '' },
    { kind: 'sort', value: 'price_asc', drop: '' },
    { kind: 'sort', value: 'price_desc', drop: '' },
    { kind: 'exclude', value: 'ams', drop: '' },
    { kind: 'exclude', value: 'combo', drop: '' },
  ];
  for (const c of all) {
    const [ar, en, ckb] = LANGS.map((l) => chipLabel(c, locFor(l), formatIqd));
    assert.ok(ar && en && ckb, `${JSON.stringify(c)} has a word in every language`);
    // A label that is only a code or an amount («PETG», «25,000 د.ع – 50,000 د.ع») is the same in all three.
    const languageNeutral = (c.kind === 'material' && !c.not) || (c.kind === 'price' && c.min !== null && c.max !== null);
    if (!languageNeutral) assert.notEqual(ckb, ar, `${JSON.stringify(c)}: the Sorani copies the Arabic («${ar}»)`);
  }
  const ckb = (c: SearchChip) => chipLabel(c, locFor('ckb'), formatIqd);
  assert.equal(ckb({ kind: 'exclude', value: 'ams', drop: '' }), 'بێ AMS');
  assert.equal(ckb({ kind: 'color', value: 'white', not: true, drop: '' }), 'جگە لە سپی');
  assert.equal(ckb({ kind: 'sale', value: 'direct', drop: '' }), 'ئێستا بەردەستە');
  assert.equal(ckb({ kind: 'spool', value: 'refill', drop: '' }), 'پڕکردنەوە بەبێ ماسوورە', 'the import words for the refill option');
  assert.equal(chipLabel({ kind: 'exclude', value: 'ams', drop: '' }, locFor('en'), formatIqd), 'Not AMS');
  assert.equal(chipLabel({ kind: 'price', min: null, max: 500, currency: 'USD', drop: '' }, locFor('en'), formatIqd), 'Up to $500');
});

test('the colour words are the listing filter words, letter for letter', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(COLOUR_WORDS).map(([k, [ar, en, ckb]]) => [k, { ar, en, ckb }])),
    Object.fromEntries(Object.entries(BASE_COLOURS).map(([k, t]) => [k, { ar: t.ar, en: t.en, ckb: t.ckb }]))
  );
});

// ======================================================= the head and a row

const NEAR: ApiProduct = { id: 'p_near', name: 'PLA Basic', sale_types: ['direct_sale'], direct_stock_available: 5 } as unknown as ApiProduct;
const PRE: ApiProduct = { id: 'p_pre', name: 'X2D', sale_types: ['pre_order'] } as unknown as ApiProduct;
const GONE: ApiProduct = { id: 'p_gone', name: 'Old', sale_types: ['direct_sale'], direct_stock_available: 0 } as unknown as ApiProduct;

test('«لا يوجد تطابق دقيق لـ 10102», the rows under it labelled near — in three languages', () => {
  const a = { exact_miss: ['10102'] };
  const words: Record<Lang, [string, string, string]> = {
    ar: ['لا يوجد تطابق دقيق لـ «10102»', 'قريبة منه', 'قريب'],
    en: ['No exact match for «10102»', 'near matches', 'Near'],
    ckb: ['هیچ هاوتایەکی ورد نەدۆزرایەوە بۆ «10102»', 'نزیکن', 'نزیک'],
  };
  for (const lang of LANGS) {
    const head = render(createElement(SearchHead, { a, count: 2, onDrop: () => undefined }), lang);
    assert.match(head, /data-exact-miss/);
    assert.ok(text(head).includes(words[lang][0]), `${lang}: ${text(head)}`);
    assert.ok(text(head).includes(words[lang][1]), `${lang}: the results are said to be near`);
    assert.match(head, /<bdi dir="ltr">10102<\/bdi>/, 'the code keeps its own direction');
    const row = render(createElement(RowNote, { p: NEAR, a }), lang);
    assert.match(row, /data-row-near/);
    assert.ok(text(row).includes(words[lang][2]), `${lang}: ${text(row)}`);
  }
  // Nothing listed: no sentence about results that are not there.
  assert.ok(!text(render(createElement(SearchHead, { a, count: 0, onDrop: () => undefined }), 'ar')).includes('قريبة'));
});

test('an exact hit says so, on the line and on its row; a plain search adds nothing at all', () => {
  const a = { exact: [{ product_id: 'p_near', key: 'FAP035' }] };
  const head = render(createElement(SearchHead, { a, count: 1, onDrop: () => undefined }), 'ckb');
  assert.match(head, /data-exact-hit/);
  assert.ok(text(head).includes('هاوتای ورد بۆ «FAP035»'));
  assert.match(render(createElement(RowNote, { p: NEAR, a }), 'en'), /data-row-exact[^>]*>Exact match</);
  assert.equal(render(createElement(SearchHead, { a: {}, count: 3, onDrop: () => undefined }), 'ar'), '');
  assert.equal(render(createElement(SearchHead, { a: { understood: { text: 'x', chips: [] } }, count: 3, onDrop: () => undefined }), 'ar'), '');
});

test('a dinar bound is written by the money hook, like the card prices beside it', () => {
  const a = { understood: { text: 'فلامنت', chips: chipsOf('فلامنت اسود اقل من 30 الف') } };
  for (const [lang, word] of [['ar', 'حتى'], ['en', 'Up to'], ['ckb', 'تا']] as const) {
    assert.ok(text(render(createElement(SearchHead, { a, count: 1, onDrop: () => undefined }), lang)).includes(`${word} ${formatIqd(30_000)}`), lang);
  }
});

test('the chips render as buttons that name what tapping them does, in Sorani too', () => {
  const a = { understood: { text: 'طابعة', chips: chipsOf('طابعة بدون AMS') } };
  const html = render(createElement(SearchHead, { a, count: 2, onDrop: () => undefined }), 'ckb');
  assert.match(html, /role="group" aria-label="ئەوەی لە گەڕانەکەت تێگەیشتین"/);
  assert.match(html, /<button type="button" data-understood-chip="exclude" aria-label="لابردن: بێ AMS"/);
  assert.match(render(createElement(SearchHead, { a, count: 2, onDrop: () => undefined }), 'ar'), /aria-label="أزل: بدون AMS"/);
});

test('three-state availability on a search row: in stock, pre-order, unavailable — the card rule', () => {
  const state = (p: ApiProduct) => /data-availability="([a-z]+)"/.exec(render(createElement(RowNote, { p, a: {} }), 'ckb'))?.[1];
  assert.equal(state(NEAR), 'available');
  assert.equal(state(PRE), 'preorder');
  assert.equal(state(GONE), 'unavailable');
  const words = text(render(createElement(RowNote, { p: PRE, a: {} }), 'ckb'));
  assert.ok(words.includes('پێش-داواکاری'), words);
});

// ================================================================== `?v=`

const PRODUCT = {
  options: [{ id: 'ov_04' }, { id: 'ov_06' }],
  colors: [{ id: 'col_black' }, { id: 'col_white' }],
};
const RELATIONS = {
  option_groups: [
    { values: [{ id: 'ov_04' }, { id: 'ov_06' }] },
    { values: [{ id: 'ov_spool' }, { id: 'ov_refill' }] },
  ],
};

test('a result link carries the matched selection as ?v=, in the one canonical key', () => {
  assert.equal(LINK_PARAM, VARIANT_PARAM, 'the link and the page read one parameter');
  const sel = { option_value_ids: ['ov_refill', 'ov_04'], color_id: 'col_black' };
  assert.equal(selectionParam(sel), skuComboKey(sel), 'the same key every SKU is stored under');
  assert.equal(linkWithSelection('/product/pla-basic', sel), `/product/pla-basic?v=${encodeURIComponent('o:ov_04|o:ov_refill|c:col_black')}`);
  assert.equal(linkWithSelection('/product/pla-basic', null), '/product/pla-basic', 'nothing matched: the plain link');
  assert.equal(linkWithSelection('/product/pla-basic', { option_value_ids: [], color_id: null }), '/product/pla-basic');
  assert.equal(linkWithSelection('/bundles/starter', sel), '/bundles/starter', 'a bundle has no selection to carry');
});

test('the product page decodes ?v= as untrusted input and keeps only what the product owns', () => {
  const back = (href: string) => linkedSelection(new URL(href, 'https://levonis-iq.com').searchParams.get(VARIANT_PARAM), PRODUCT, RELATIONS);
  // The round trip: what the result matched is what the page opens on.
  assert.deepEqual(back(linkWithSelection('/product/x', { option_value_ids: ['ov_04', 'ov_refill'], color_id: 'col_black' })), {
    option_value_ids: ['ov_04', 'ov_refill'],
    color_id: 'col_black',
  });
  assert.deepEqual(back(linkWithSelection('/product/x', { option_value_ids: [], color_id: 'col_white' })), { option_value_ids: [], color_id: 'col_white' });
  // Another product's ids are dropped; nothing of this product left is nothing.
  assert.deepEqual(linkedSelection('o:ov_04|o:ov_other|c:col_red', PRODUCT, RELATIONS), { option_value_ids: ['ov_04'], color_id: null });
  assert.equal(linkedSelection('o:ov_other|c:col_red', PRODUCT, RELATIONS), null);
  // One value per group, in the page own group order.
  assert.deepEqual(linkedSelection('o:ov_04|o:ov_06', PRODUCT, RELATIONS)?.option_value_ids, ['ov_04']);
  // Malformed, unsorted, oversized or empty: nothing.
  for (const raw of ['', '_', 'x:1', 'o:ov_06|o:ov_04', 'c:col_black|o:ov_04', `o:${'a'.repeat(500)}`, 'o:<script>', null, undefined]) {
    assert.equal(linkedSelection(raw, PRODUCT, RELATIONS), null, String(raw));
  }
  // A product without relational groups: its own options, one at most.
  assert.deepEqual(linkedSelection('o:ov_06', PRODUCT, null), { option_value_ids: ['ov_06'], color_id: null });
});

test('Product.tsx applies ?v= before the first paint, once per product and link, with no layout condition', () => {
  const src = read('src/pages/Product.tsx');
  const block = /const linkedFor = useRef\(''\);\s*useLayoutEffect\(\(\) => \{([\s\S]*?)\}, \[product, relations, location\.search\]\);/.exec(src);
  assert.ok(block, 'the ?v= effect is missing');
  const body = block![1];
  assert.match(body, /new URLSearchParams\(location\.search\)\.get\(VARIANT_PARAM\)/);
  assert.match(body, /linkedFor\.current === `\$\{product\.slug\}\|\$\{raw\}`/, 'applied once: a later choice is never overwritten');
  assert.match(body, /const linked = linkedSelection\(raw, product, relations\);/);
  assert.match(body, /setOptionValueIds\(linked\.option_value_ids\)/);
  assert.match(body, /setColorId\(linked\.color_id\)/);
  // The phone and the desktop share one selection state: nothing here asks which one it is.
  assert.doesNotMatch(body, /wideLayout|useMediaQuery|innerWidth/);
  // The link never prices: nothing in it reaches the quote but the ids.
  assert.doesNotMatch(body, /setQuote|price/i);
});
