/**
 * «طلب السعر» ON THE PRODUCT PAGE (DECISIONS rows 239 (4) and 240, spec §6.2).
 *
 * The pure half (src/components/product/priceRequestState.ts) answers which
 * row of the panel's table is on screen, and carries the selection through
 * /auth as UNTRUSTED input; the panel itself is rendered for real
 * (renderToStaticMarkup) in the states a first render can reach — signed out,
 * a selection still missing a choice, and a priced selection (no panel). The
 * page's wiring is pinned by reading src/pages/Product.tsx: the panel is lazy,
 * a catalog-only product never asks the quote, and nothing can be bought.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { AuthContext } from '../src/AuthContext';
import { LanguageProvider } from '../src/LanguageContext';
import PriceRequestPanel, { PRICE_REQUEST_TEXT, type PriceRequestPanelProps } from '../src/components/product/PriceRequestPanel';
import {
  decodePriceRequestIntent,
  priceRequestView,
  productPathWithPriceIntent,
  selectionKeyOf,
  withRow,
  type PriceRequestInputs,
  type PriceRequestRow,
} from '../src/components/product/priceRequestState';

const base: PriceRequestInputs = {
  productStatus: 'unpriced',
  selectionUnpriced: false,
  selectionComplete: true,
  authenticated: true,
  mine: [],
  selectionKey: 'o:m1|c:red',
};
const row = (over: Partial<PriceRequestRow> = {}): PriceRequestRow => ({
  id: 'pr_1',
  product_id: 'prd_x',
  selection: 'o:m1|c:red',
  state: 'open',
  notify: true,
  ...over,
});

test('the panel table, row by row, in the order the spec asks the questions', () => {
  // A priced product on a priced selection: no panel.
  assert.deepEqual(priceRequestView({ ...base, productStatus: 'priced' }), { kind: 'none' });
  // A priced product whose chosen SKU has no price: the panel, for that selection.
  assert.equal(priceRequestView({ ...base, productStatus: 'priced', selectionUnpriced: true }).kind, 'ready');
  // A required option or colour not chosen comes first, signed in or not.
  assert.equal(priceRequestView({ ...base, selectionComplete: false }).kind, 'choose');
  assert.equal(priceRequestView({ ...base, selectionComplete: false, authenticated: false }).kind, 'choose');
  assert.equal(priceRequestView({ ...base, authenticated: false, mine: null }).kind, 'signed_out');
  assert.equal(priceRequestView({ ...base, mine: null }).kind, 'loading');
  assert.equal(priceRequestView(base).kind, 'ready');
  const open = priceRequestView({ ...base, mine: [row()] });
  assert.equal(open.kind, 'requested');
  // Another selection's open request does not answer this one.
  assert.equal(priceRequestView({ ...base, mine: [row({ selection: 'o:m1|c:blue' })] }).kind, 'ready');
  // A withdrawn, notified or priced row may be asked again while there is still no price.
  for (const state of ['closed', 'notified', 'priced'] as const) {
    assert.equal(priceRequestView({ ...base, mine: [row({ state })] }).kind, 'ready', state);
  }
});

test('a write replaces the row for its selection; the newest answer wins', () => {
  const rows = withRow([row(), row({ id: 'pr_2', selection: 'o:m2' })], row({ state: 'closed' }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, 'closed');
  assert.equal(withRow(null, row()).length, 1);
});

test('the selection key is the canonical one the server and unpriced_selections speak', () => {
  assert.equal(selectionKeyOf(['b', 'a'], 'red'), 'o:a|o:b|c:red');
  assert.equal(selectionKeyOf([], ''), '');
  assert.equal(selectionKeyOf([], 'red'), 'c:red');
});

test('the /auth round trip: a canonical key out, UNTRUSTED input back', () => {
  assert.equal(productPathWithPriceIntent('h2d', 'o:a|c:red'), '/product/h2d?price_request=o%3Aa%7Cc%3Ared');
  assert.equal(productPathWithPriceIntent('h2d', ''), '/product/h2d?price_request=_');
  assert.deepEqual(decodePriceRequestIntent('o:a|c:red'), { option_value_ids: ['a'], color_id: 'red' });
  assert.deepEqual(decodePriceRequestIntent('_'), { option_value_ids: [], color_id: null });
  for (const bad of ['', null, undefined, 'o:b|o:a', 'x:1', 'c:red|o:a', 'o:<script>', `o:${'a'.repeat(401)}`, 'o:a b']) {
    assert.equal(decodePriceRequestIntent(bad as string | null | undefined), null, String(bad));
  }
});

function render(over: Partial<PriceRequestPanelProps>, authenticated = false): string {
  const props: PriceRequestPanelProps = {
    productId: 'prd_x',
    productSlug: 'levo-e2e-catalog-printer',
    productStatus: 'unpriced',
    selectionUnpriced: false,
    selectionKey: 'o:m1',
    optionValueIds: ['m1'],
    colorId: '',
    selectionComplete: true,
    isAuthenticated: authenticated,
    barSlot: null,
    onPriced: () => {},
    ...over,
  };
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, {
      value: {
        isAuthenticated: authenticated,
        user: null,
        login: async () => {},
        loginWithGoogle: async () => {},
        register: async () => {},
        refreshUser: async () => {},
        logout: async () => {},
        isLoaded: true,
      },
      children: createElement(LanguageProvider, {
        children: createElement(MemoryRouter, null, createElement(PriceRequestPanel, props)),
      }),
    })
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('signed out: the button opens the sign-in sheet, and nothing is sent from here', () => {
  const html = render({});
  assert.match(html, /data-price-request-cta="signed_out"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(text(html), new RegExp(PRICE_REQUEST_TEXT.ar.request));
  assert.match(html, /min-h-12/, 'a 48 px target');
  assert.doesNotMatch(html, /role="switch"/, 'the consent switch is for a signed-in customer');
});

test('a missing choice: the button waits (aria-disabled) and points at the helper sentence', () => {
  const html = render({ selectionComplete: false });
  assert.match(html, /data-price-request-cta="choose"/);
  assert.match(html, /aria-disabled="true"/);
  const helper = /<p id="([^"]+)"[^>]*>([^<]*)</.exec(html);
  assert.ok(helper, 'the helper sentence has an id');
  assert.equal(helper![2], PRICE_REQUEST_TEXT.ar.chooseFirst);
  assert.match(html, new RegExp(`aria-describedby="${helper![1]}"`));
});

test('signed in, rows still loading: the switch is visible and ON before the first tap (D10)', () => {
  const html = render({}, true);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(text(html), new RegExp(PRICE_REQUEST_TEXT.ar.notifyMe));
});

test('a priced selection draws no panel at all', () => {
  assert.equal(render({ productStatus: 'priced', selectionUnpriced: false }), '');
});

test('every word of the panel exists in ar, en and real Sorani (row 183)', () => {
  const keys = Object.keys(PRICE_REQUEST_TEXT.ar) as Array<keyof typeof PRICE_REQUEST_TEXT.ar>;
  for (const k of keys) {
    for (const l of ['en', 'ckb'] as const) assert.ok(PRICE_REQUEST_TEXT[l][k], `${l}.${k} is missing`);
    assert.notEqual(PRICE_REQUEST_TEXT.ckb[k] as string, PRICE_REQUEST_TEXT.ar[k] as string, `ckb.${k} copies the Arabic`);
  }
});

test('the page: the panel is lazy, a catalog-only product never asks the quote, and nothing can be bought', () => {
  const src = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.match(src, /const PriceRequestPanel = React\.lazy\(\(\) => import\('\.\.\/components\/product\/PriceRequestPanel'\)\);/);
  assert.match(src, /if \(catalogOnly \|\| knownUnpriced\) \{\s*setQuoteLoading\(false\);\s*return;/);
  assert.match(src, /const noPrice = catalogOnly \|\| selectionUnpriced;/);
  assert.match(src, /const canBuy =\s*source === 'catalog' &&\s*!noPrice &&/);
  assert.match(src, /const stockAlertOffered = source === 'catalog' && !noPrice && directOutOfStock;/);
  assert.match(src, /const priceBlock = noPrice \? null : \(/);
  assert.match(src, /\{noPrice \? unpricedBlock\(false\) : null\}\s*\{priceBlock\}/);
  assert.match(src, /\{noPrice \? unpricedBlock\(true\) : null\}\s*\{priceBlock\}/);
  assert.match(src, /priceStatus !== 'unpriced' \? giniLinkOf\(/, 'no instalments of a price that does not exist');
  assert.match(src, /ref=\{setRequestBarSlot\}/, 'the phone bar gives the request button its place');
  // The intent coming back from /auth is decoded as untrusted and dropped with a REPLACE.
  assert.match(src, /decodePriceRequestIntent\(params\.get\(PRICE_REQUEST_PARAM\)\)/);
  assert.match(src, /params\.delete\(PRICE_REQUEST_PARAM\);/);
});
