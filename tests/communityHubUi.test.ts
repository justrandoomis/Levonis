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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { TAB_IDS, canonicalParams, resolveTab } from '../src/components/community/hub/tabs';
import { HUB_STRINGS, colophon, projectsLabel, sectionNumber, workshopsLabel } from '../src/components/community/hub/strings';
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

// ------------------------------------------------------------ the home V3

test('the home has six sections, in the owner\'s order, and the two old names still open the right one', () => {
  assert.deepEqual([...TAB_IDS], ['foryou', 'following', 'projects', 'requests', 'stores', 'creators']);
  const page = code('src/pages/Community.tsx');
  assert.match(page, /items=\{TAB_IDS\.map\(\(id\) => \(\{ id, label: s\.tabs\[id\] \}\)\)\}/, 'the strip draws exactly the six ids');
  assert.match(page, /indicatorClassName="bg-gold"/, 'gold is the ink: the underline');
  assert.match(page, /order=\{\[\.\.\.TAB_IDS\]\}/, 'the panels slide along the same order');

  // ?tab=products → the products list under «لك»; ?tab=merchants → stores.
  assert.deepEqual(resolveTab(new URLSearchParams('tab=products')), { tab: 'foryou', list: 'products', legacy: true });
  assert.deepEqual(resolveTab(new URLSearchParams('tab=merchants&q=x')), { tab: 'stores', list: null, legacy: true });
  assert.equal(canonicalParams(new URLSearchParams('tab=products&q=x')).toString(), 'tab=foryou&q=x&list=products');
  assert.equal(canonicalParams(new URLSearchParams('tab=merchants')).toString(), 'tab=stores');
  assert.deepEqual(resolveTab(new URLSearchParams('tab=foryou&list=products')), { tab: 'foryou', list: 'products', legacy: false });
  assert.deepEqual(resolveTab(new URLSearchParams('tab=stores&list=products')), { tab: 'stores', list: null, legacy: false }, 'the list only lives under «لك»');
  assert.deepEqual(resolveTab(new URLSearchParams('tab=nonsense')), { tab: 'foryou', list: null, legacy: false });
  assert.deepEqual(resolveTab(new URLSearchParams('')), { tab: 'foryou', list: null, legacy: false });
  assert.match(page, /if \(legacy\) setParams\(canonicalParams\(params\), \{ replace: true \}\);/, 'the old name is rewritten, never a history entry');
  assert.match(code('src/pages/FollowedStores.tsx'), /\/community\?tab=merchants/, 'the old link this rewrite exists for is still in the app');
});

test('no <button> inside a link, anywhere in the home\'s cards and sections', () => {
  const dirs = ['src/components/community/hub', 'src/components/community/feed'];
  const files = dirs.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.tsx')).map((f) => `${d}/${f}`));
  assert.ok(files.length >= 12, `expected the home components, found ${files.length}`);
  for (const f of files) {
    const src = code(f).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    for (const tag of ['a', 'Link', 'HubLink']) {
      const open = new RegExp(`<${tag}(?=[\\s>])`, 'g');
      let m: RegExpExecArray | null;
      while ((m = open.exec(src))) {
        if (/^<[^>]*\/>/.test(src.slice(m.index))) continue;
        const close = src.indexOf(`</${tag}>`, m.index);
        const inner = src.slice(m.index, close < 0 ? undefined : close);
        assert.doesNotMatch(inner, /<button\b/, `${f}: a <button> inside <${tag}>:\n${inner.slice(0, 160)}`);
      }
    }
  }
  // The feed's card: one stretched link, the social row beside it.
  const post = code('src/components/community/feed/PostCard.tsx');
  assert.match(post, /after:absolute after:inset-0/, 'the title is the stretched link');
  assert.match(post, /<ActionRow post=\{p\} viewer=\{p\.viewer\}/, 'the social row is the shared one');
});

test('the section numbers read in Arabic-Indic digits for Arabic and Sorani only; the counts stay Latin', () => {
  assert.equal(sectionNumber(1, 'ar'), '٠١');
  assert.equal(sectionNumber(7, 'ckb'), '٠٧');
  assert.equal(sectionNumber(1, 'en'), '01');
  assert.equal(sectionNumber(12, 'ar'), '١٢');
  assert.match(code('src/components/community/hub/parts.tsx'), /\{sectionNumber\(index, lang\)\}/, 'SectionHead draws it');
  assert.equal(projectsLabel(12, 'ar'), '12 مشروعًا');
  assert.equal(projectsLabel(2, 'ar'), 'مشروعان');
  assert.equal(workshopsLabel(3, 'ar'), '3 ورش');
  assert.equal(colophon(12, 3, 'ar'), 'صُنع هذا العدد من 12 مشروعًا و3 ورش');
  assert.equal(colophon(1, 1, 'en'), 'This issue was made from 1 project and 1 workshop');
  assert.equal(colophon(5, 2, 'ckb'), 'ئەم ژمارەیە لە 5 پڕۆژە و 2 وۆرکشۆپ دروست کراوە');
});

test('every word of the home exists in Arabic, English and real Sorani', () => {
  const flat = (o: Record<string, unknown>, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${prefix}${k}.`));
      else out[`${prefix}${k}`] = String(v);
    }
    return out;
  };
  const ar = flat(HUB_STRINGS.ar);
  const en = flat(HUB_STRINGS.en);
  const ckb = flat(HUB_STRINGS.ckb);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort());
  assert.deepEqual(Object.keys(ckb).sort(), Object.keys(ar).sort());
  let same = 0;
  let sorani = 0;
  const keys = Object.keys(ar);
  for (const k of keys) {
    assert.ok(ckb[k].trim(), `ckb.${k} is empty`);
    if (ckb[k] === ar[k]) same += 1;
    // The letters Sorani has and Arabic does not: ە ێ ڕ ڵ گ ک ۆ ی.
    if (/[\u06D5\u06CE\u0695\u06B5\u06AF\u06A9\u06C6\u06CC]/.test(ckb[k])) sorani += 1;
  }
  assert.ok(same <= Math.ceil(keys.length / 10), `${same} Sorani strings are the Arabic pasted across`);
  assert.ok(sorani >= Math.floor(keys.length * 0.9), `only ${sorani} of ${keys.length} Sorani strings carry a Sorani letter`);
});
