/**
 * THE COMMUNITY PAGE (src/pages/Community.tsx) — what must not quietly come back.
 *
 *   * Every card is a real link to a real page: a product to the page it can be
 *     bought on (the server's `url`), a store to the store, a request to the
 *     request. The directory used to be `<div onClick>` + `window.open`, which
 *     a keyboard could not reach, and the request cards led nowhere.
 *   * «متابعة» is its own button, never nested inside the card's link.
 *   * A new request is the four-step wizard on /requests, not a two-field sheet
 *     that published a job no workshop could price.
 *   * Search goes to the server (`q`), not a filter over the rows on screen.
 *   * Arabic counts agree with their number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import {
  completedLabel,
  followersLabel,
  offersLabel,
  productsLabel,
  resultsLabel,
  shortDate,
  timeAgo,
} from '../src/components/community/hub/copy';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\}/g, '{}');

test('every card is a link to a real page', () => {
  const page = code('src/pages/Community.tsx');
  assert.doesNotMatch(page, /window\.open/, 'no scripted navigation from a div');
  assert.doesNotMatch(page, /<div[^>]*onClick=/, 'no clickable div');

  const product = code('src/components/community/hub/ProductTile.tsx');
  assert.match(product, /<HubLink\s+href=\{p\.url \|\|/, 'a product opens the page it can be bought on');

  const store = code('src/components/community/hub/StoreCard.tsx');
  assert.match(store, /<HubLink\s+href=\{storeHref\(m\.store_url, m\.id\)\}/);
  const link = store.slice(store.indexOf('<HubLink'), store.indexOf('</HubLink>'));
  assert.doesNotMatch(link, /<button/, 'the follow button is not inside the link');
  assert.match(store, /aria-pressed=\{!!m\.following\}/, 'the follow toggle says its state');

  const request = code('src/components/community/hub/RequestCard.tsx');
  assert.match(request, /to=\{`\/requests\?request=\$\{encodeURIComponent\(r\.id\)\}`\}/, 'a request opens its own page');

  const parts = code('src/components/community/hub/parts.tsx');
  assert.match(parts, /target="_blank" rel="noopener noreferrer"/, 'a shop on its own subdomain opens in its own tab, without an opener');
});

test('the lists never outgrow a 320 px phone', () => {
  // A grid with no column template sizes its one `auto` column to the cards'
  // MIN-CONTENT — and a store name that does not wrap counts at full length —
  // so on a 320 px Android the directory spilled off the screen edge and the
  // page scrolled sideways. `grid-cols-1` is `minmax(0, 1fr)`: the column is
  // the screen's width, and the card's own `min-w-0` lets it shrink into it.
  const page = code('src/pages/Community.tsx');
  const lists = page.match(/className="grid [^"]*md:grid-cols-2"/g) ?? [];
  assert.equal(lists.length, 2, 'the stores list and the requests list');
  for (const list of lists) assert.match(list, /\bgrid-cols-1\b/, list);
  assert.match(code('src/components/community/hub/StoreCard.tsx'), /className="relative flex min-w-0 /);
  assert.match(page, /const PRODUCT_GRID = 'grid grid-cols-2 /, 'the product grid names its columns too');
});

test('a new request is the wizard, and a guest is brought back to it after signing in', () => {
  const page = code('src/pages/Community.tsx');
  assert.match(page, /const NEW_REQUEST_PATH = '\/requests\?view=new';/);
  assert.match(page, /\{ to: '\/auth', state: \{ from: NEW_REQUEST_PATH \} \}/);
  assert.doesNotMatch(page, /api\.post\(['"]\/api\/community\/requests/, 'the two-field sheet is gone');
  assert.doesNotMatch(page, /from '\.\.\/components\/ui\/Overlay'/);

  const requests = code('src/pages/Requests.tsx');
  assert.match(requests, /params\.get\('view'\)/, '/requests opens the section the address names');
  assert.match(requests, /if \(\(asked === 'new' \|\| asked === 'orders'\) && user\) return asked;/, 'the wizard only for a signed-in customer');
});

test('search is the server\'s: the term travels as `q`, and the page filters nothing itself', () => {
  const api = code('src/components/community/hub/api.ts');
  assert.match(api, /if \(q\) p\.set\('q', q\);/);
  const page = code('src/pages/Community.tsx');
  assert.doesNotMatch(page, /\.filter\([^)]*toLowerCase/, 'no client-side search over the loaded rows');
  assert.match(page, /params\.get\('q'\)/, 'the term lives in the URL');
});

test('Arabic counts agree with their number; English and Sorani read naturally', () => {
  assert.equal(followersLabel(1, 'ar'), 'متابع واحد');
  assert.equal(followersLabel(2, 'ar'), 'متابعان');
  assert.equal(followersLabel(5, 'ar'), '5 متابعين');
  assert.equal(followersLabel(12, 'ar'), '12 متابعًا');
  assert.equal(followersLabel(100, 'ar'), '100 متابع');
  assert.equal(followersLabel(103, 'ar'), '103 متابعين', 'the hundreds are skipped, the remainder decides');
  assert.equal(followersLabel(1, 'en'), '1 follower');
  assert.equal(followersLabel(3, 'en'), '3 followers');

  assert.equal(completedLabel(52, 'ar'), '52 طلبًا منجزًا');
  assert.equal(completedLabel(3, 'ar'), '3 طلبات منجزة');
  assert.equal(completedLabel(1, 'en'), '1 completed order');

  assert.equal(offersLabel(0, 'ar'), 'لا عروض بعد');
  assert.equal(offersLabel(1, 'ar'), 'عرض واحد');
  assert.equal(offersLabel(2, 'ar'), 'عرضان');
  assert.equal(offersLabel(3, 'ar'), '3 عروض');
  assert.equal(offersLabel(11, 'ar'), '11 عرضًا');
  assert.equal(offersLabel(0, 'en'), 'No offers yet');
  assert.equal(offersLabel(4, 'ckb'), '4 ئۆفەر', 'the board\'s own hand-written Sorani');

  assert.equal(productsLabel(14, 'ar'), '14 منتجًا');
  assert.equal(resultsLabel(1, 'ar'), 'نتيجة واحدة');
  assert.equal(resultsLabel(2, 'ar'), 'نتيجتان');
  assert.equal(resultsLabel(7, 'en'), '7 results');
});

test('times are the language\'s own words, and a bad date says nothing', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z');
  assert.equal(timeAgo('2026-09-28T09:00:00.000Z', 'en', now), '3 hours ago');
  assert.equal(timeAgo('2026-09-27T12:00:00.000Z', 'en', now), 'yesterday');
  assert.equal(timeAgo('2026-09-28T11:59:30.000Z', 'en', now), 'now');
  assert.match(timeAgo('2026-09-28T09:00:00.000Z', 'ar', now), /3/, 'Latin digits, as every date in the app');
  assert.equal(timeAgo('not a date', 'ar', now), '');
  assert.equal(timeAgo(null, 'en', now), '');
  assert.match(shortDate('2026-10-05', 'en'), /5 Oct/);
  assert.equal(shortDate('', 'ar'), '');
});
