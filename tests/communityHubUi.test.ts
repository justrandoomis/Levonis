/**
 * THE COMMUNITY PAGE (src/pages/Community.tsx) — what must not quietly come back.
 *
 *   * The home of community UI plan C1 (IMG_8487, IMG_8462): the sections are
 *     links to their own pages, the old `?tab=` addresses go there, the top bar
 *     and the verbs are real doors, request rows never carry a budget.
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
import { TAB_IDS, TAB_PAGES, legacyTabTarget } from '../src/components/community/hub/tabs';
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
  assert.match(request, /to=\{`\/requests\/\$\{encodeURIComponent\(r\.id\)\}`\}/, 'a request opens its own page — its own address, not the board\'s redirect');
  assert.doesNotMatch(request, /requests\?request=\$/, 'no card goes through the board\'s redirect');

  const parts = code('src/components/community/hub/parts.tsx');
  assert.match(parts, /target="_blank" rel="noopener noreferrer"/, 'a shop on its own subdomain opens in its own tab, without an opener');
});

test('the lists never outgrow a 320 px phone', () => {
  // A grid with no column template sizes its one `auto` column to the cards'
  // MIN-CONTENT — and a store name that does not wrap counts at full length —
  // so on a 320 px Android the directory spilled off the screen edge and the
  // page scrolled sideways. `grid-cols-1` is `minmax(0, 1fr)`: the column is
  // the screen's width, and the card's own `min-w-0` lets it shrink into it.
  // The stores directory is its own module (community UI plan B4), on /community/stores.
  const lists = code('src/components/community/hub/StoresPanel.tsx').match(/className="grid [^"]*md:grid-cols-2"/g) ?? [];
  assert.equal(lists.length, 1, 'the stores list');
  for (const list of lists) assert.match(list, /\bgrid-cols-1\b/, list);
  assert.match(code('src/components/community/hub/StoreCard.tsx'), /className="relative flex min-w-0 /);
  const page = code('src/pages/Community.tsx');
  // The home's own grids name their columns, and every column of the main and the aside may shrink.
  assert.match(code('src/components/community/hub/HomeSkeleton.tsx'), /export const HOME_GRID = 'flex flex-col gap-6 lg:grid lg:grid-cols-\[minmax\(0,1fr\)_20rem\] lg:items-start';/);
  assert.equal((page.match(/<div className="flex min-w-0 flex-col gap-6">/g) ?? []).length, 2, 'the main column and the aside both shrink');
  assert.match(code('src/components/community/hub/ForYouPanel.tsx'), /grid \$\{wide \? 'grid-cols-3 gap-4' : 'grid-cols-2 gap-3'\}/);
  assert.match(code('src/components/community/hub/ProductsPanel.tsx'), /export const PRODUCT_GRID = 'grid grid-cols-2 /, 'the product grid names its columns too');
});

test('a new request is the wizard, and a guest is brought back to it after signing in', () => {
  const page = code('src/pages/Community.tsx');
  assert.match(page, /const NEW_REQUEST_PATH = '\/requests\/new';/, 'the request editor (community UI plan B4)');
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
  // Sorani is written in Sorani — Intl has none, and a ckb page printed «قبل ساعتين» (review 2026-09-30) —
  // with the timeline's own rule and rounding, so the request page's «last update» and its sheet agree.
  assert.equal(timeAgo('2026-09-28T09:00:00.000Z', 'ckb', now), 'پێش 3 کاتژمێر');
  assert.equal(timeAgo('2026-09-27T12:00:00.000Z', 'ckb', now), 'دوێنێ');
  assert.equal(timeAgo('2026-09-28T11:59:30.000Z', 'ckb', now), 'ئێستا');
  assert.match(shortDate('2026-10-05', 'en'), /5 Oct/);
  assert.equal(shortDate('', 'ar'), '');
});

// ------------------------------------------------------------ the home V3

test('the six sections are links to their own pages, «لك» the page on screen (plan C1 R3, D-7)', () => {
  assert.deepEqual([...TAB_IDS], ['foryou', 'following', 'projects', 'requests', 'stores', 'creators']);
  const nav = code('src/components/community/hub/SectionNav.tsx');
  assert.match(nav, /export const SECTION_LINKS = \[\s*\{ id: 'foryou', to: '\/community' \},\s*\{ id: 'following', to: '\/community\/following' \},\s*\{ id: 'projects', to: '\/community\/projects' \},\s*\{ id: 'requests', to: '\/requests' \},\s*\{ id: 'stores', to: '\/community\/stores' \},\s*\{ id: 'creators', to: '\/community\/makers' \},\s*\] as const;/);
  // A nav of links, not a tablist: no tabs, no panels, the home marked as the page.
  assert.equal((nav.match(/<nav aria-label=\{s\.sections\}/g) ?? []).length, 2, 'the grid and the track are each a named nav');
  assert.doesNotMatch(nav, /role="tab|TabStrip|aria-selected|onClick/);
  assert.equal((nav.match(/aria-current=\{here \? 'page' : undefined\}/g) ?? []).length, 2);
  assert.equal((nav.match(/const here = id === 'foryou';/g) ?? []).length, 2);
  // D-3 (DECISIONS row 270): the current section is the sand selection, with a cue that is not a colour.
  assert.match(nav, /here \? 'cm-sel cm-line font-bold' : 'cm-raised font-semibold'/);
  assert.match(nav, /\{here && <span aria-hidden="true" className="absolute bottom-1 /, 'the track draws the bar under the current section');
  // The page draws the grid on a phone and the track from lg; the tab strip and the per-tab panels are gone.
  const page = code('src/pages/Community.tsx');
  assert.match(page, /const nav = <SectionNav variant=\{wide \? 'track' : 'grid'\} \/>;/);
  assert.doesNotMatch(page, /TabStrip|TabPanels|FollowingPanel|StoresPanel|CreatorsPanel|RequestsPanel|QuickActions|CoverStory/);
  // Sorani never cuts a word: two columns, and under 375px every language stacks the icon over the words.
  assert.match(nav, /\$\{sorani \? 'grid-cols-2' : 'grid-cols-3'\}/);
  assert.match(nav, /const NARROW_QUERY = '\(max-width: 374px\)';/);
});

test('every old `?tab=` address goes to its page with `replace`, keeping the term and never looping (plan §3)', () => {
  const at = (q: string) => legacyTabTarget(new URLSearchParams(q));
  assert.equal(at(''), null, 'the home itself is not redirected');
  assert.equal(at('q=dragon'), null, 'a search on the home stays on the home');
  assert.equal(at('list=products'), null);
  assert.equal(at('tab=following'), '/community/following');
  assert.equal(at('tab=projects&q=lamp'), '/community/projects?q=lamp');
  assert.equal(at('tab=requests&q=x y'), '/requests?q=x+y');
  assert.equal(at('tab=stores&q=baghdad'), '/community/stores?q=baghdad');
  assert.equal(at('tab=merchants'), '/community/stores', 'the oldest name (FollowedStores) lands on the stores page');
  assert.equal(at('tab=creators&q=sara'), '/community/makers?q=sara');
  assert.equal(at('tab=foryou'), '/community');
  assert.equal(at('tab=foryou&q=vase'), '/community?q=vase');
  assert.equal(at('tab=products&q=pla'), '/community?list=products&q=pla', 'the old products tab is the home list');
  assert.equal(at('tab=foryou&list=products'), '/community?list=products');
  assert.equal(at('tab=nonsense&kind=x'), '/community');
  // No answer carries a tab, so a second pass never redirects again.
  for (const q of ['tab=following', 'tab=foryou&q=a', 'tab=products', 'tab=merchants&q=b', 'tab=toString', 'tab=__proto__']) {
    const next = at(q)!;
    assert.ok(next.startsWith('/'), `${q} → ${next}`);
    assert.equal(legacyTabTarget(new URLSearchParams(next.split('?')[1] ?? '')), null, `${q} → ${next} loops`);
  }
  assert.deepEqual(Object.keys(TAB_PAGES).sort(), ['creators', 'following', 'merchants', 'projects', 'requests', 'stores']);
  const page = code('src/pages/Community.tsx');
  assert.match(page, /const moved = legacyTabTarget\(params\);\s*return moved \? <Navigate to=\{moved\} replace \/> : <CommunityHome \/>;/, 'one redirect, never a history entry');
  assert.match(code('src/pages/FollowedStores.tsx'), /\/community\?tab=merchants/, 'the old link this redirect exists for is still in the app');
});

test('the top bar: the wordmark, the h1, the chats with the shared unread, the bell for an account, the menu door (plan C1 R1, D1)', () => {
  const bar = code('src/components/community/hub/TopBar.tsx');
  // «LEVONIS», then the heading: the screen reader hears the wordmark first (D-8).
  assert.match(bar, /<p dir="ltr" lang="en" className=\{`font-bold[^`]*`\}>\s*LEVONIS\s*<\/p>\s*\{!wide && <h1 [^>]*>\{s\.title\}<\/h1>\}/);
  assert.doesNotMatch(bar, /useGoBack|ArrowRight|ArrowLeft/, 'no back arrow on the home');
  assert.match(bar, /const NotificationBell = React\.lazy\(\(\) => import\('\.\.\/\.\.\/notifications\/NotificationBell'\)\);/);
  assert.match(bar, /\{isAuthenticated && \(\s*<Suspense/, 'a guest has no bell');
  // The avatar opens the sections and account menu: a dialog door, the chunk on the first press, focus back on close.
  assert.match(bar, /const CommunityMenu = React\.lazy\(\(\) => import\('\.\/CommunityMenu'\)\);/);
  assert.match(bar, /aria-haspopup="dialog"\s*aria-expanded=\{open\}\s*aria-label=\{s\.sectionsAndAccount\}/);
  assert.match(bar, /door\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(bar, /<CommunityMenu open=\{open\} onClose=\{close\} anchor=\{door\} \/>/);
  // The first chunk names no kit module: the entry lists every chunk it needs (plan R6).
  assert.doesNotMatch(bar, /from '\.\.\/kit\//);
  assert.doesNotMatch(code('src/components/community/hub/HubActions.tsx'), /from '\.\.\/kit\//);
  assert.doesNotMatch(code('src/components/community/hub/SectionNav.tsx'), /from '\.\.\/kit\//);
  assert.match(bar, /<Link to="\/chats" aria-label=\{chats\}/);
  // The page: exactly one h1, in the bar on a phone and the title row from lg.
  const page = code('src/pages/Community.tsx');
  assert.equal((page.match(/<h1\b/g) ?? []).length, 1);
  assert.match(page, /\{wide \? \(\s*<div className="flex items-center justify-between gap-6">\s*<header className="min-w-0">\s*<h1 /);
  assert.match(page, /<TopBar wide=\{wide\} search=\{wide \? searchForm : undefined\} \/>/);
});

test('one GET /api/chats a page: the bottom bar reads it, the top bar shows the same count (plan C1 R1)', () => {
  // The bottom bar keeps its one read and publishes the sum on the root; no new module in the entry.
  const nav = code('src/components/BottomNav.tsx');
  assert.equal((nav.match(/'\/api\/chats'/g) ?? []).length, 1);
  assert.match(nav, /setMessageUnreadCount\(unread\);\s*document\.documentElement\.dataset\.chatUnread = String\(unread\);/);
  assert.doesNotMatch(nav, /useChatUnread/, 'the entry does not import the hook');
  const hook = code('src/lib/useChatUnread.ts');
  assert.match(hook, /const ATTR = 'data-chat-unread';/);
  assert.match(hook, /return useSyncExternalStore\(subscribe, snapshot, \(\) => 0\);/);
  assert.doesNotMatch(hook, /api\.get|fetch\(/, 'the hook never asks the server');
  const bar = code('src/components/community/hub/TopBar.tsx');
  assert.doesNotMatch(bar, /\/api\/chats/);
  assert.match(bar, /const unread = isAuthenticated \? shared : 0;/, 'nothing for a guest');
});

test('the two verbs are real links, the request one gold, and a guest is brought back (plan C1 R2)', () => {
  const verbs = code('src/components/community/hub/HubActions.tsx');
  assert.match(verbs, /<Link to=\{newRequestLink\.to\} state=\{newRequestLink\.state\} data-variant="gold" data-testid="community-new-request" className=\{`lv-button cm-btn-gold /);
  assert.match(verbs, /<Link to=\{composerLink\.to\} state=\{composerLink\.state\} data-variant="secondary" data-testid="community-share-project" className=\{`lv-button lv-button-secondary cm-btn-clay /);
  assert.equal((verbs.match(/cm-btn-gold/g) ?? []).length, 1, 'one gold primary');
  assert.doesNotMatch(verbs, /<button/);
  const page = code('src/pages/Community.tsx');
  assert.match(page, /const composerLink = isAuthenticated \? \{ to: NEW_PROJECT_PATH \} : \{ to: '\/auth', state: \{ from: NEW_PROJECT_PATH \} \};/);
});

test('the featured project is honest, and Studio is one plain external anchor (plan R4, R9, R11, BASE 6)', () => {
  const featured = code('src/components/community/hub/FeaturedProject.tsx');
  assert.match(featured, /\{work \? s\.fromWorkshops : s\.trendingKicker\}/);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.doesNotMatch(HUB_STRINGS[lang].trendingKicker, /مميز|Featured|دیار/);
  assert.equal(HUB_STRINGS.ar.trendingKicker, 'مشروع رائج');
  assert.equal(HUB_STRINGS.ar.trending, 'الرائج هذا الشهر', 'trending reads 30 days (projectsApi.trending), so the head says the month');
  assert.match(code('src/components/community/hub/useHomeData.ts'), /orNull\(projectsApi\.trending\(8\)\)/);
  assert.equal(HUB_STRINGS.ar.studioLine, 'جهّز ملفاتك للطباعة');
  const studio = code('src/components/community/hub/StudioCard.tsx');
  assert.match(studio, /<a\s+href=\{STUDIO_URL\}\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(studio, /<span className="sr-only">\{s\.opensNewTab\}<\/span>/);
  assert.doesNotMatch(studio, /iframe|prefetch|preload|three|<button/);
  assert.equal((studio.match(/<a\b/g) ?? []).length, 1, 'one anchor');
});

test('a request row on the home is the public card: never a budget, a person or a request picture (plan R2, R3, R10)', () => {
  const home = code('src/components/community/hub/ForYouPanel.tsx');
  assert.match(home, /const requests = \(data\.requests \?\? \[\]\)\.slice\(0, 2\)\.map\(publicCard\);/);
  const pick = home.slice(home.indexOf('export function publicCard('), home.indexOf('\n}\n', home.indexOf('export function publicCard(')));
  assert.doesNotMatch(pick, /budget|cover|customer|avatar|user/);
  assert.match(home, /<RequestListCard variant="row" request=\{r\} \/>/);
  assert.match(home, /<RequestListCard variant="aside" request=\{r\} \/>/);
  assert.doesNotMatch(home, /budget/);
  // The numbered kickers are gone from the home: plain heads with the gold «عرض الكل ‹».
  assert.match(home, /import \{ SectionHead \} from '\.\.\/kit\/display';/);
  assert.doesNotMatch(home, /index=\{/);
  // Counts are Latin digits: the card prints the number itself.
  const card = code('src/components/community/projects/ProjectFeatureCard.tsx');
  assert.match(card, /\{comments > 0 && <span aria-hidden="true">\{comments\}<\/span>\}/);
  assert.match(card, /aria-label=\{commentsLabel\(comments, socialLang\(lang\)\)\}/);
});

test('no <button> inside a link, anywhere in the home\'s cards and sections', () => {
  const dirs = ['src/components/community/hub', 'src/components/community/feed'];
  const files = [...dirs.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.tsx')).map((f) => `${d}/${f}`)), 'src/components/community/projects/ProjectFeatureCard.tsx'];
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

// ------------------------------------------------ «طلبات تناسبك» (Phase 5d)
//
// The workshop's own board leads a MERCHANT's «لك» (GET /api/community/requests
// ?for=me, hub/BoardRail.tsx): mounted by the page for a signed-in viewer who
// runs a store — or, on Back, the viewer it led a moment ago — lazily, and
// hidden the moment /api/merchant/me says there is no workshop.

// The language provider reads `levo_lang`; the renders below draw Arabic.
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (k: string) => (k === 'levo_lang' ? 'ar' : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const { AuthProvider } = await import('../src/AuthContext');
const { LanguageProvider } = await import('../src/LanguageContext');
const { WalletProvider } = await import('../src/WalletContext');
const { CurrencyProvider } = await import('../src/CurrencyContext');
const { default: BoardRail, BOARD_RAIL_SIZE, BOARD_ALL_PATH, BOARD_PREFS_PATH } = await import('../src/components/community/hub/BoardRail');
const { BOARD_RAIL_CACHE, boardRailRemembered } = await import('../src/components/community/hub/boardFrame');
const { writePageCache, dropPageCache } = await import('../src/lib/pageCache');
const { offersV2Api } = await import('../src/components/community/requests/api');

type RailMe = Parameters<typeof BoardRail>[0]['me'];
const merchantMe = { eligible: true, tier: 'pro', store: { id: 'st_1', slug: 'eveprints', name: 'Eve Prints' } } as unknown as RailMe;
const memberMe = { eligible: false, tier: 'free', store: null } as unknown as RailMe;
const boardRow = (i: number) => ({
  id: `req_${i}`,
  title: `حامل شاشة ${i}`,
  description: 'أحتاجه خلال أسبوع.',
  category: null,
  quantity: 1,
  material: 'PLA',
  color: '',
  dimensions: '',
  budget_iqd: null,
  deadline: null,
  governorate: 'baghdad',
  delivery_pref: '',
  state: 'open',
  offer_count: i,
  created_at: new Date(Date.now() - i * 60_000).toISOString(),
  expires_at: null,
  file_count: 0,
  revision: 1,
  customer_notes: '',
  status: 'open',
  match_score: 80,
});
const rail = (me: RailMe, viewer = 'u_eve') =>
  renderToStaticMarkup(
    createElement(AuthProvider, {
      children: createElement(LanguageProvider, {
        children: createElement(WalletProvider, {
          children: createElement(CurrencyProvider, { children: createElement(MemoryRouter, null, createElement(BoardRail, { viewer, me })) }),
        }),
      }),
    })
  );

test('«طلبات تناسبك»: the page mounts the rail for a signed-in workshop only, lazily, and the issue keeps its plain title', () => {
  const page = code('src/pages/Community.tsx');
  assert.match(page, /const BoardRail = React\.lazy\(\(\) => import\('\.\.\/components\/community\/hub\/BoardRail'\)\);/, 'a guest or a customer never downloads it');
  // Decided at first paint where the device knows (review 2026-09-30), and the frame reserved while the chunk loads.
  assert.match(page, /const workshop = isAuthenticated && \(!!me\?\.store \|\| boardRailRemembered\(viewer\) \|\| \(!meAsked && workshopHint\(viewer\)\)\);/);
  // Under the sections, at the top of the main column (plan C1), mounted while the home body arrives.
  assert.match(page, /\{nav\}\s*\{workshop && \(\s*<Suspense fallback=\{<BoardRailFrame \/>\}>\s*<BoardRail viewer=\{viewer\} me=\{me\} \/>\s*<\/Suspense>\s*\)\}\s*<Suspense fallback=\{<MainSkeleton wide=\{wide\} \/>\}>\s*<HomeMain viewer=\{viewer\} wide=\{wide\} \/>/);
  // The home body is a lazy chunk of its own; its reads start with the page.
  assert.match(page, /const loadHome = \(\) => import\('\.\.\/components\/community\/hub\/ForYouPanel'\);/);
  assert.match(page, /if \(issue\) warmHome\(viewer\);/);
  assert.doesNotMatch(code('src/components/community/hub/ForYouPanel.tsx'), /requestsForYou/, 'one «طلبات تناسبك» on the page — the rail\'s');
  const src = code('src/components/community/hub/BoardRail.tsx');
  assert.match(src, /offersV2Api\s*\.boardForMe\('', BOARD_RAIL_SIZE\)/);
  assert.match(src, /<RequestCard request=\{boardCard\(r\)\} \/>/, 'the card the requests tab draws');
});

test('«طلبات تناسبك»: the reserved frame IS the rail\'s loading state — the same head and skeleton — so the swap moves nothing', async () => {
  dropPageCache(BOARD_RAIL_CACHE);
  const { BoardRailFrame } = await import('../src/components/community/hub/boardFrame');
  const frame = renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(BoardRailFrame) }));
  const waiting = rail(merchantMe);
  const body = (h: string) => h.slice(h.indexOf('<div class="mb-2.5'), h.lastIndexOf('</section>'));
  // The frame's «عرض الكل» is inert text (the frame is aria-hidden); everything else is the same markup.
  const inert = (h: string) => h.replace(/<a [^>]*>(.*?)<\/a>/s, '$1').replace(/<span class="-me-1[^"]*">/, '').replace(/<svg.*?<\/svg>/gs, '').replace(/<span>|<\/span>/g, '');
  assert.equal(inert(body(frame)), inert(body(waiting)));
  assert.match(frame, /aria-hidden="true"/);
  assert.doesNotMatch(frame, /<a /, 'nothing to tab to inside a hidden frame');
});

test('«طلبات تناسبك»: nothing for a member without a store; the head and a skeleton for a workshop whose board is on its way', () => {
  dropPageCache(BOARD_RAIL_CACHE);
  assert.equal(rail(memberMe), '', 'hidden for a non-merchant');
  const waiting = rail(merchantMe);
  assert.match(waiting, /data-community-board-rail=""/);
  assert.match(waiting, /<h2 id="community-s-board"[^>]*>طلبات تناسبك<\/h2>/);
  assert.ok(waiting.includes('طلبات مفتوحة تستطيع طابعاتك تنفيذها الآن.'));
  assert.ok(waiting.includes('عرض الكل'), 'the head ends in the gold «عرض الكل ‹», as every head of the home');
  assert.match(waiting, /aria-busy="true"/, 'the skeleton says it is loading');
  assert.match(waiting, new RegExp(`href="${BOARD_ALL_PATH.replace(/[?/]/g, '\\$&')}"`), '«عرض الكل» opens the whole board');
  assert.doesNotMatch(waiting, /data-community-request=/);
});

test('«طلبات تناسبك»: the remembered board paints at once, as the requests tab\'s cards; an empty board says so and offers the preferences', () => {
  writePageCache(BOARD_RAIL_CACHE, { viewer: 'u_eve', rows: [boardRow(1), boardRow(2)], total: 2 });
  assert.equal(boardRailRemembered('u_eve'), true);
  assert.equal(boardRailRemembered('u_other'), false, 'another viewer never sees this one\'s board');
  const h = rail(merchantMe);
  assert.deepEqual([...h.matchAll(/data-community-request="([^"]+)"/g)].map((m) => m[1]), ['req_1', 'req_2']);
  assert.ok(h.includes('href="/requests/req_1"'), 'a card opens its request — at its own address, not the board\'s redirect');
  assert.match(h, /class="relative grid w-72 shrink-0 snap-start"/, 'a rail cell the card fills — positioned, so its sr-only words stay inside the rail');
  // Before /api/merchant/me answers, the remembered board is shown as it was.
  assert.match(rail(null), /data-community-request="req_1"/);
  // …but never to a viewer it was not remembered for.
  assert.doesNotMatch(rail(merchantMe, 'u_other'), /data-community-request=/);
  writePageCache(BOARD_RAIL_CACHE, { viewer: 'u_eve', rows: [], total: 0 });
  const empty = rail(merchantMe);
  assert.match(empty, /data-community-board-empty/);
  assert.ok(empty.includes('لا طلبات تناسب ورشتك الآن. نُعلمك حين يصل طلب تستطيع تنفيذه.'));
  assert.ok(empty.includes(`href="${BOARD_PREFS_PATH}"`), 'the request preferences, one tap away');
  assert.equal(BOARD_PREFS_PATH, '/merchant/printers#preferences');
  dropPageCache(BOARD_RAIL_CACHE);
});

test('«طلبات تناسبك» asks the server for THIS workshop\'s board: `?for=me`, a rail\'s few rows', async () => {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return Response.json({ success: true, requests: [], next_cursor: null, total: 0, for: 'me' });
  }) as typeof fetch;
  try {
    const page = await offersV2Api.boardForMe('', BOARD_RAIL_SIZE);
    assert.deepEqual(page.requests, []);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\/api\/community\/requests\?for=me&limit=6$/);
});
