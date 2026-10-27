/**
 * THE COMMUNITY DIRECTORY (community UI plan C5): the stores page (IMG_8469)
 * and the makers page (IMG_8476).
 *
 *   - privacy: a store card prints no phone and no place finer than the
 *     governorate, whatever the row carries; a maker card prints no place;
 *   - one link per card, stretched, named for the store or the maker; the
 *     follow button beside it, never inside it; the works `aria-hidden`;
 *   - the filters live in the address and read only the closed lists;
 *   - the governorate sheet is a radio group with the keyboard, and Escape
 *     is left to the sheet;
 *   - every word in Arabic, English and real Sorani;
 *   - the pages: section header with the «الأقسام» door, inside the scope,
 *     the directory a lazy chunk; the home tab of today keeps compiling.
 *
 * scripts/e2e-community-directory.mjs drives the same pages in a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

let LANG = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? LANG : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const { AuthProvider } = await import('../src/AuthContext');
const { LanguageProvider } = await import('../src/LanguageContext');
const { default: StoreDirectoryCard } = await import('../src/components/community/directory/StoreDirectoryCard');
const { default: MakerDirectoryCard } = await import('../src/components/community/directory/MakerDirectoryCard');
const { DIRECTORY_STRINGS, specialtyLine } = await import('../src/components/community/directory/strings');
const filters = await import('../src/components/community/directory/filters');

function render(node: ReturnType<typeof createElement>, lang = 'ar'): string {
  LANG = lang;
  return renderToStaticMarkup(createElement(AuthProvider, { children: createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }) }));
}

const DIR = 'src/components/community/directory';
const files = readdirSync(join(ROOT, DIR)).map((f) => `${DIR}/${f}`);

/** A merchants row with what a directory card must never print. */
const leakyStore = {
  id: 'cm_1',
  user_id: 'u_1',
  name: 'ورشة بغداد',
  bio: '',
  avatarUrl: null,
  verified: true,
  approved_provider: true,
  created_at: '2026-10-01T00:00:00.000Z',
  store_url: '/community/store/cm_1',
  store_name: 'ورشة بغداد',
  tagline: 'طباعة قطع ومنتجات عملية',
  logoUrl: '/files/merchants/cm_1/logo.webp',
  governorate: 'baghdad',
  accepts_custom_requests: true,
  rating: 4.8,
  rating_count: 23,
  works: [
    { id: 'w1', title: 'مصباح', imageUrl: '/files/merchants/cm_1/public/w1.webp' },
    { id: 'w2', title: 'منظم', imageUrl: '/files/merchants/cm_1/public/w2.webp' },
    { id: 'w3', title: 'حامل', imageUrl: '/files/merchants/cm_1/public/w3.webp' },
    { id: 'w4', title: 'رابع', imageUrl: '/files/merchants/cm_1/public/w4.webp' },
  ],
  contact_phone: '07701234567',
  address: 'الكرادة، شارع 62',
  district: 'الكرادة',
};

const maker = {
  id: 'u_sara',
  username: 'sara_hassan',
  name: 'سارة حسن',
  avatarUrl: null,
  bio: 'تصميم ومنتجات عملية\nأطبع منذ 2019',
  badges: { pro: true, premium: false, verified_merchant: false, approved_provider: true },
  stats: { projects: 9, followers: 40 },
  store: null,
  viewer: { following: false },
  works: [{ id: 'p1', title: 'منظم', imageUrl: '/files/community/p1.webp', width: 800, height: 600, url: '/community/projects/p1' }],
  governorate: 'erbil',
  phone: '07709999999',
};

/** Every anchor, from its opening tag to its own closing tag. */
function anchors(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>/g)) out.push(html.slice(m.index!, html.indexOf('</a>', m.index!) + 4));
  return out;
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('a store card prints no phone and no place finer than the governorate', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const html = render(createElement(StoreDirectoryCard, { store: leakyStore as never, follow: null }), lang);
    assert.doesNotMatch(html, /0770\d{7}|الكرادة|شارع/, `${lang}: the card printed a phone or an address`);
    const place = html.slice(html.indexOf('data-store-place'), html.indexOf('</p>', html.indexOf('data-store-place')));
    assert.ok(place.includes({ ar: 'بغداد', en: 'Baghdad', ckb: 'بەغدا' }[lang]), `${lang}: the place line is not the governorate`);
    // The rating is the store own, with its count; a store with none says «جديد».
    assert.match(textOf(place), /4\.8 \(23\)/);
  }
  const fresh = render(createElement(StoreDirectoryCard, { store: { ...leakyStore, rating: null, rating_count: 0 } as never, follow: null }));
  assert.match(fresh, /data-store-rating="new"[^>]*>جديد</);
  for (const f of files) assert.doesNotMatch(code(f), /contact_phone|\.phone\b|\.address\b|district/, `${f} reads a phone or an address`);
});

test('a maker card prints no place and no phone, and its specialty is the first line of the bio', () => {
  const html = render(createElement(MakerDirectoryCard, { creator: maker as never }));
  assert.doesNotMatch(html, /أربيل|Erbil|0770/, 'the maker card printed a place or a phone (plan R11)');
  assert.match(html, /data-maker-line[^>]*>تصميم ومنتجات عملية</);
  assert.equal(specialtyLine('\n  first line \nsecond'), 'first line');
  assert.equal(specialtyLine(null), '');
});

test('one link per card, stretched, named for the store or the maker; follow beside it; works hidden', () => {
  const follow = { following: false, onToggle: () => undefined, size: 'sm' as const, name: 'ورشة بغداد', 'data-social': 'follow-store' };
  const store = render(createElement(StoreDirectoryCard, { store: leakyStore as never, follow }));
  const people = render(createElement(MakerDirectoryCard, { creator: maker as never }));
  for (const [html, href, word] of [
    [store, '/community/store/cm_1', 'زيارة المتجر'],
    [people, '/u/sara_hassan', 'عرض الملف'],
  ] as const) {
    const links = anchors(html);
    assert.equal(links.length, 1, `one link per card, not ${links.length}`);
    assert.ok(links[0].includes(`href="${href}"`), links[0]);
    assert.match(links[0], /after:absolute after:inset-0/, 'the link is not stretched over the card');
    // «زيارة المتجر: ورشة بغداد»: the name said after the word, hidden from the eye only.
    assert.match(textOf(links[0]), new RegExp(`${word} : (ورشة بغداد|سارة حسن)`));
    assert.doesNotMatch(links[0], /<button/, 'a button inside the link');
    const strip = html.slice(html.indexOf('data-directory-works') - 40);
    assert.match(strip, /<div aria-hidden="true" data-directory-works="\d"/, 'the works strip is read aloud');
  }
  // Three works at most, never a stand-in; the store follow sits above the link in the gold tone.
  assert.match(store, /data-directory-works="3"/);
  assert.match(store, /<button[^>]*aria-label="متابعة: ورشة بغداد"[^>]*data-tone="gold"[^>]*class="[^"]*relative z-10/);
  const bare = render(createElement(StoreDirectoryCard, { store: { ...leakyStore, works: [] } as never, follow: null }));
  assert.doesNotMatch(bare, /data-directory-works|data-social/, 'an empty strip, or a follow button on the own store');
});

test('the filters live in the address and read only the closed lists', () => {
  const p = (s: string) => new URLSearchParams(s);
  assert.deepEqual(filters.readStoreFilters(p('gov=erbil&tech=resin&design=1')), { governorate: 'erbil', tech: 'resin', service: 'design' });
  assert.deepEqual(filters.readStoreFilters(p('gov=atlantis&tech=sls&design=yes')), { governorate: '', tech: '', service: '' });
  assert.deepEqual(filters.readStoreFilters(p('gov=__proto__')), { governorate: '', tech: '', service: '' });
  assert.deepEqual(filters.readMakerFilters(p('sort=followers&has_store=1&approved=1')), { sort: 'followers', has_store: '1', approved: '1' });
  assert.deepEqual(filters.readMakerFilters(p('sort=random&has_store=true')), { sort: '', has_store: '', approved: '' });
  assert.equal(filters.readQuery(p(`q=${'x'.repeat(80)}`)).length, 60);
  assert.equal(filters.activeCount({ governorate: 'erbil', tech: '', service: 'design' }), 2);
  assert.equal(filters.withParams(p('q=lamp&tech=fdm'), { tech: null, gov: 'basra' }).toString(), 'q=lamp&gov=basra');
  assert.equal(filters.effectiveSort('', ''), 'featured');
  assert.equal(filters.effectiveSort('سارة', ''), 'recent');
  assert.equal(filters.effectiveSort('', 'followers'), 'followers');
  // The pages write them with replace (Back leaves the page), and the list keys its memory by them.
  for (const f of ['StoresDirectory.tsx', 'MakersDirectory.tsx']) {
    const src = code(`${DIR}/${f}`);
    assert.match(src, /setParams\(\(prev\) => withParams\(prev, patch\), \{ replace: true \}\)/, f);
    assert.match(src, /useCommunityFeed<\w+>\('(merchants|creators)', q, viewer, filters\)/, `${f}: the feed is not keyed by the filters`);
  }
  const stores = code(`${DIR}/StoresDirectory.tsx`);
  assert.match(stores, /set\(\{ gov: id \|\| null \}\)/);
  assert.match(stores, /set\(\{ tech: filters\.tech === 'fdm' \? null : 'fdm' \}\)/);
  assert.match(stores, /set\(\{ design: filters\.service === 'design' \? null : '1' \}\)/);
  for (const chip of ['fdm', 'resin', 'design']) assert.match(stores, new RegExp(`aria-pressed=\\{[^}]+\\}[\\s\\S]{0,160}data-directory-filter="${chip}"`), `${chip}: no pressed state`);
});

test('the governorate sheet is a radio group with the keyboard; Escape is the sheet own', () => {
  const src = code(`${DIR}/GovernorateFilter.tsx`);
  assert.match(src, /role="radiogroup"/);
  assert.match(src, /role="radio"\s+aria-checked=\{on\}\s+tabIndex=\{on \? 0 : -1\}/, 'not one Tab stop with aria-checked');
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) assert.ok(src.includes(`'${key}'`), `${key} is not handled`);
  assert.match(src, /const forward = dir === 'rtl' \? 'ArrowLeft' : 'ArrowRight';/, 'the side arrows ignore the writing direction');
  assert.doesNotMatch(src, /dismissOnEscape=\{false\}/);
  assert.match(src, /initialFocus=\{checkedRef\}/, 'focus does not land on the checked option');
  assert.match(src, /\[\{ id: '', label: d\.allGovernorates \}, \.\.\.GOVERNORATES\.map/, 'not «كل المحافظات» and the eighteen');
  // The sort of the makers sheet is the same kind of group.
  const sheet = code(`${DIR}/MakersFilterSheet.tsx`);
  assert.match(sheet, /role="radiogroup" aria-labelledby="makers-sort"/);
  assert.match(sheet, /aria-pressed=\{filters\.has_store === '1'\}/);
  assert.match(sheet, /aria-pressed=\{filters\.approved === '1'\}/);
  // The sand selection gives the checked row its ink: no utility colour fights it.
  for (const f of ['GovernorateFilter.tsx', 'MakersFilterSheet.tsx']) assert.match(code(`${DIR}/${f}`), /\$\{on \? '' : 'border-transparent text-text-primary hover:bg-surface-selected'\}/, f);
});

test('every word in Arabic, English and real Sorani', () => {
  const keys = Object.keys(DIRECTORY_STRINGS.ar) as Array<keyof typeof DIRECTORY_STRINGS.ar>;
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(Object.keys(DIRECTORY_STRINGS[lang]).sort(), [...keys].sort(), `${lang} misses a key`);
  for (const k of keys) {
    const at = (lang: 'ar' | 'en' | 'ckb') => {
      const v = DIRECTORY_STRINGS[lang][k];
      return typeof v === 'function' ? (v as (n: number) => string)(2) : v;
    };
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(at(lang).trim(), `${lang}.${k} is empty`);
    // «FDM» is the process name in every language, as the printers write it.
    if (k !== 'fdm') assert.notEqual(at('ckb'), at('ar'), `ckb.${k} copies the Arabic (DECISIONS row 183)`);
  }
  // The works rail of the home tab says its title in Sorani too.
  assert.match(code('src/components/community/hub/WorksRail.tsx'), /loc\('من أعمال الورش', 'From the workshops', '[^']+'\)/);
});

test('the pages: the section header with its door, inside the scope, the directory a lazy chunk', () => {
  for (const [file, module, title] of [
    ['src/pages/community/Stores.tsx', 'StoresDirectory', 's.tabs.stores'],
    ['src/pages/community/Makers.tsx', 'MakersDirectory', 's.tabs.creators'],
  ] as const) {
    const src = code(file);
    assert.match(src, /<CommunitySurface\b[^>]*>[\s\S]*<\/CommunitySurface>/, `${file}: the page root is not stamped`);
    assert.ok(src.includes(`<SectionPageHeader title={${title}} trailing={<SectionsButton />} />`), `${file}: no section header with the sections door`);
    assert.match(src, new RegExp(`const ${module} = lazy\\(\\(\\) => import\\('\\.\\./\\.\\./components/community/directory/${module}'\\)\\);`), `${file}: the directory is imported eagerly`);
    // The skeleton is its own module, so the page does not load the cards to show it.
    assert.match(src, /from '\.\.\/\.\.\/components\/community\/directory\/Skeletons';/);
    assert.doesNotMatch(src, /hub\/(StoresPanel|CreatorsPanel|WorksRail)/, `${file}: still the home tab list`);
  }
  // The home tab of today keeps its list (the home lane retires it), with «متجرك» from the directory.
  assert.match(code('src/components/community/hub/StoresPanel.tsx'), /import YourStore from '\.\.\/directory\/YourStore';/);
  // The directory reads no heavy module and adds no stylesheet.
  for (const f of files) {
    assert.doesNotMatch(code(f), /model-viewer|three|\.css'/, `${f} pulls a heavy module or a sheet`);
    assert.doesNotMatch(code(f), /<FilterSelect\b/, `${f}: the kit FilterSelect is a menu; the directory sheet is the radio group`);
  }
});
