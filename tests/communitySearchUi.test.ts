/**
 * THE COMMUNITY SEARCH OVERLAY (src/components/community/search/**) — what
 * must not quietly come back, in the style of tests/communityHubUi.test.ts.
 *
 *   * The overlay is a LAZY chunk of the home and of /community/projects: a
 *     visitor who never touches the box never downloads it, and the
 *     storefront pages import nothing from it (their closure is at budget).
 *   * It is a combobox said out loud: the page's input names ONE listbox
 *     that owns nothing but options and groups, the rows are options with
 *     ids that never carry a typed term, ↑/↓ travel through
 *     `aria-activedescendant`, Enter opens, Delete forgets a recent term,
 *     Escape closes, and a live region says what arrived.
 *   * The page behind the panel holds still while it is open: the URL
 *     debounce waits, so a keystroke is two reads, not three.
 *   * No <button> inside a link; tokens only; springs from the motion kit and
 *     the one CROSS_FADE for new results.
 *   * Every word exists in Arabic, English AND real Sorani (D6).
 *   * «Recent searches» are the browser's alone: a term and a time, never an
 *     email, a phone or an account — and one button forgets them.
 *   * The CSS budget was paid, not raised (D7): the dead animation rules are
 *     gone and Tailwind reads only the UI trees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { SEARCH_STRINGS, boundedCount } from '../src/components/community/search/strings';
import { fallbackMore } from '../src/components/community/search/api';
import { RECENT_KEY, RECENT_MAX, clearRecent, forgetRecent, readRecent, rememberRecent, storableTerm } from '../src/components/community/search/recent';

const DIR = 'src/components/community/search';
const files = readdirSync(join(ROOT, DIR)).filter((f) => /\.tsx?$/.test(f));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

test('the search folder has every module the contract names', () => {
  for (const f of ['api.ts', 'recent.ts', 'strings.ts', 'useSearchBox.ts', 'SearchOverlay.tsx', 'TrendingTags.tsx', 'RecommendRail.tsx']) {
    assert.ok(files.includes(f), `${DIR}/${f} is missing`);
  }
});

test('the overlay is a lazy chunk of the home and the projects page, and the rails are lazy where they hang', () => {
  const home = code('src/pages/Community.tsx');
  assert.match(home, /React\.lazy\(\(\) => import\('\.\.\/components\/community\/search\/SearchOverlay'\)\)/, 'the home imports the overlay eagerly');
  assert.doesNotMatch(home, /^import .*SearchOverlay/m);
  assert.match(home, /\{\.\.\.box\.inputProps\}/, 'the home\'s input does not carry the combobox attributes');
  assert.match(home, /box\.ever && \(/, 'the overlay is mounted before the box was ever opened');
  assert.doesNotMatch(home, /from '\.\.\/components\/ui\/Overlay'/, 'the primitive belongs to the lazy chunk, not the page');

  const projects = code('src/pages/community/Projects.tsx');
  assert.match(projects, /React\.lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/search\/SearchOverlay'\)\)/);
  assert.doesNotMatch(projects, /^import .*SearchOverlay/m);
  assert.match(projects, /\{\.\.\.box\.inputProps\}/);

  const project = code('src/pages/community/Project.tsx');
  assert.match(project, /React\.lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/search\/RecommendRail'\)\)/, '«قد يعجبك» is not lazy');
  assert.match(project, /anchor=\{`post:\$\{post\.id\}`\} kind="projects"/);
  const store = code('src/pages/CommunityStorePage.tsx');
  assert.match(store, /React\.lazy\(\(\) => import\('\.\.\/components\/community\/search\/RecommendRail'\)\)/, '«متاجر مشابهة» is not lazy');
  assert.match(store, /anchor=\{`store:\$\{store\.merchant_id\}`\} kind="stores"/);
  const forYou = code('src/components/community/hub/ForYouPanel.tsx');
  assert.match(forYou, /<TrendingTags tags=\{data\.tags\} \/>/, 'the home\'s «وسوم رائجة» row is not laid out from the composite');
  assert.doesNotMatch(forYou, /useTrending/, 'the home asks /trending on its own, after the composite — the row would arrive late and shift the first screen');
  const homeData = code('src/components/community/hub/useHomeData.ts');
  assert.match(homeData, /searchApi\.trending\(\)/, 'trending is not part of the home composite');
  assert.match(homeData, /if \(hot && hot\.creators\.length > 0\) return hot\.creators;/, 'the featured makers are read even when trending has them');
  assert.match(homeData, /if \(hot && hot\.stores\.length > 0\) \{/, 'the featured stores are read even when trending has them');
  assert.match(homeData, /tags: TrendingTag\[\] \| null;/);
});

test('the store page\'s «متاجر مشابهة» is drawn inside the store\'s theme island, not under it', () => {
  const store = code('src/pages/CommunityStorePage.tsx');
  assert.match(store, /<Storefront\s+store=\{store\}[\s\S]*?footer=\{/, 'the rail is not handed to Storefront as its footer');
  assert.doesNotMatch(store, /pb-28/, 'a second bottom padding after the island\'s own pb-24');
  assert.match(code('src/pages/Storefront.tsx'), /footer=\{footer\}/, 'Storefront does not pass the footer to the renderer');
  const renderer = code('src/components/storefront/StoreRenderer.tsx');
  const island = renderer.slice(renderer.indexOf('<StoreTheme'), renderer.indexOf('</StoreTheme>'));
  assert.match(island, /\{footer\}/, 'the footer is rendered outside the StoreTheme island');
});

test('the storefront pages import nothing from the search module', () => {
  for (const f of ['src/pages/Storefront.tsx', 'src/pages/StorefrontProduct.tsx']) {
    assert.doesNotMatch(code(f), /community\/search/, `${f} reaches into community/search`);
  }
  // CommunityStorePage imports Storefront, never the reverse.
  assert.doesNotMatch(code('src/pages/Storefront.tsx'), /CommunityStorePage/);
});

test('a combobox said out loud: the input names the listbox, the rows are options, the keyboard walks them', () => {
  const box = code(`${DIR}/useSearchBox.ts`);
  assert.match(box, /role: 'combobox'/);
  assert.match(box, /'aria-expanded': open/);
  assert.match(box, /'aria-controls': SEARCH_LIST_ID/);
  assert.match(box, /'aria-autocomplete': 'both'/, 'the box draws an inline completion AND lists rows (LiveSearch says the same)');
  assert.match(box, /'aria-haspopup': 'listbox'/);
  assert.match(box, /params\.get\('search'\) === '1'/, '?search=1 does not open it');

  const overlay = code(`${DIR}/SearchOverlay.tsx`);
  assert.match(overlay, /id=\{SEARCH_LIST_ID\} role="listbox"/, 'the listbox does not carry the id the input names');
  assert.match(overlay, /role="option"/, 'no option rows');
  assert.match(overlay, /role: 'option' as const/, 'the chips are not options');
  assert.match(overlay, /aria-selected=\{activeId === id\}/);
  assert.match(overlay, /el\.setAttribute\('aria-activedescendant', activeId\)/, 'the input never says which row is lit');
  assert.match(overlay, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/, '↑/↓ do not move');
  assert.match(overlay, /e\.key === 'Enter' && active/, 'Enter does not open the lit row');
  assert.match(overlay, /e\.key === 'Delete'/, 'Delete does not forget a lit recent term');
  assert.match(overlay, /e\.key === 'Escape'/, 'Escape does not close');

  // A listbox owns options and groups, nothing else: no heading element, no
  // <section>, no <p> inside it — headings are plain text the group is
  // labelled by, and the skeleton, an error and the live region sit beside it.
  assert.doesNotMatch(overlay, /<h[1-6][\s>]/, 'a heading element inside the listbox');
  assert.doesNotMatch(overlay, /<section[\s>]/, 'a <section> inside the listbox');
  assert.match(overlay, /role="group" aria-labelledby=\{`\$\{SEARCH_LIST_ID\}-h-\$\{type\}`\}/, 'a section is not a labelled group');
  assert.match(overlay, /role="group" aria-label=\{s\.suggestions\}/, 'the chips are not a group');
  assert.match(overlay, /role="group" aria-labelledby=\{`\$\{SEARCH_LIST_ID\}-h-recent`\}/);
  const listbox = overlay.slice(overlay.indexOf('role="listbox"'));
  const listboxEl = listbox.slice(0, listbox.indexOf('</div>'));
  assert.match(listboxEl, /\{list\}/, 'the listbox holds more than the rows');
  assert.match(overlay, /\{aside\}/, 'the skeleton, the error and the copy are not beside the list');
  assert.match(overlay, /aria-live="polite"/, 'nothing announces the results');
  assert.match(overlay, /setAnnouncement\(fillIn\(s\.completes, \{ text: ghostText \}\)\)/, 'the grey word is not said');
  assert.match(overlay, /setAnnouncement\(fillIn\(s\.noResultsFor, \{ q: a\.q \}\)\)/, '«no results» is not said');
  assert.match(overlay, /canFollow=\{false\}/, 'a follow pill inside a store option');
  assert.match(overlay, /<CreatorCard creator=\{c\} follow=\{false\} \/>/, 'a follow pill inside a maker option');
  assert.doesNotMatch(overlay, /<FollowUserButton/, 'a follow control inside the panel');

  // Every option id is positional or a server id — never a typed term or a
  // tag, which may carry spaces or quotes (an IDREF may not).
  const ids = [...overlay.matchAll(/`\$\{(?:SEARCH_LIST_ID|RECENT_PREFIX|id)\}[^`]*`/g)].map((m) => m[0]);
  assert.ok(ids.length >= 12, `only ${ids.length} option id templates found`);
  for (const tpl of ids) {
    for (const [, expr] of tpl.matchAll(/\$\{([^}]+)\}/g)) {
      if (expr === 'SEARCH_LIST_ID' || expr === 'RECENT_PREFIX' || expr === 'id') continue;
      assert.match(expr, /^(i|type|[a-z]+\.id)$/, `${tpl} builds an id from user text`);
    }
  }
  assert.doesNotMatch(overlay, /\$\{r\.term\}`/, 'a recent term inside an id');
  assert.doesNotMatch(overlay, /-tag-\$\{t\.tag\}/, 'a tag inside an id');
  assert.match(overlay, /inputRef\.current\?\.focus\(\{ preventScroll: true \}\)/, 'Escape from inside the panel does not hand focus back');
  assert.match(overlay, /querySelectorAll<HTMLElement>\('\[role="option"\]'\)/, 'the walk is not over every row in order');
  assert.match(overlay, /mode="parallel"/, 'the panel must not trap focus away from the box');
  assert.match(overlay, /trapFocus=\{false\}/);
  assert.match(overlay, /initialFocus=\{inputRef\}/, 'opening moves the caret out of the box');
  assert.match(overlay, /placement=\{phone \? 'dock' : 'top'\}/, 'a phone gets the docked sheet, a wide screen the centred panel');
  assert.match(overlay, /SUGGEST_DEBOUNCE_MS = 200/);
  assert.match(overlay, /SEARCH_DEBOUNCE_MS = 300/);
  // The page behind holds still while the panel is open: its own ?q= debounce waits.
  for (const page of ['src/pages/Community.tsx', 'src/pages/community/Projects.tsx']) {
    const src = code(page);
    assert.match(src, /useEffect\(\(\) => \{\s*if \(box\.open\) return;\s*const next = draft\.trim\(\)\.slice\(0, 60\);/, `${page}: the URL debounce runs under the open overlay`);
    assert.match(src, /dir="auto"/, `${page}: the box has no dir="auto"`);
  }
  assert.match(overlay, /el\.dir = 'auto';/, 'closing removes dir instead of leaving the box on auto');
  assert.doesNotMatch(overlay, /removeAttribute\('dir'\)/);
  // What is remembered is the row's own word, never the fragment behind a suggestion.
  assert.match(overlay, /data-search-remember=\{sg\.text\}/);
  assert.match(overlay, /row\.getAttribute\('data-search-remember'\)/);
  // «الكل» for requests lands on the tab that reads ?q=.
  assert.equal(fallbackMore('requests', 'x y'), '/community?tab=requests&q=x%20y');
  const home = code('src/pages/Community.tsx');
  assert.match(home, /<RequestsPanel q=\{q\}/, 'the requests tab does not read the term');
  assert.match(home, /params\.get\('q'\)/);
  assert.match(overlay, /ac\.abort\(\)/, 'a stale request is not aborted');
  assert.match(overlay, /ghostFor\(value, r\.text, textDir\)/, 'the grey completion is not the shared ghost');
  assert.match(overlay, /acceptOnChange\(v, `\$\{v\} `, g, src\?\.text\)/, 'Space does not take the ghost');
});

test('no <button> inside a link, anywhere in the search components', () => {
  for (const f of files.filter((x) => x.endsWith('.tsx'))) {
    const src = code(`${DIR}/${f}`);
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
});

test('tokens only: no hex, no dark: variant, no physical left/right utility, no native dialog, no scripted window', () => {
  const physical = /(?:^|[\s"'`{])(?:[a-z-]+:)*(?:pl|pr|ml|mr|left|right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)-[\w[\]/.-]+/;
  for (const f of files) {
    const src = code(`${DIR}/${f}`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f} hard-codes a hex colour`);
    assert.doesNotMatch(src, /(?:^|[\s"'`{])(?:[a-z-]+:)*dark:[a-z-]/, `${f} uses the dark: variant`);
    assert.doesNotMatch(src, physical, `${f} uses a physical left/right utility`);
    assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\(/, `${f} uses a native dialog`);
    assert.doesNotMatch(src, /\bwindow\.open\(/, `${f} opens a window by script`);
    assert.doesNotMatch(src, /transition=\{\{\s*duration/, `${f} invents a duration`);
  }
  const overlay = code(`${DIR}/SearchOverlay.tsx`);
  assert.match(overlay, /transition=\{CROSS_FADE\}/, 'new results do not cross-fade with the house constant');
  assert.match(overlay, /<motion\.div animate=\{\{ opacity: stale \? 0\.6 : 1 \}\} transition=\{CROSS_FADE\}/, 'the results block is not one stable node');
  assert.doesNotMatch(overlay, /key=\{a\.q\}/, 'the results remount on every answer');
  assert.doesNotMatch(overlay, /initial=\{\{ opacity: 0 \}\}/, 'the results fade in from transparent on every keystroke');
  assert.doesNotMatch(overlay, /type: 'spring'/, 'a spring written by hand');
  // 44 px targets: «الكل», «مسح السجل», the «×».
  assert.match(overlay, /const TEXT_ROW = '-my-1 inline-flex min-h-11 /);
  assert.match(overlay, /data-search-more=\{type\}\s+className=\{`\$\{TEXT_ROW\}/);
  assert.match(overlay, /data-search-clear-recent=""[\s\S]{0,200}className=\{`\$\{TEXT_ROW\}/);
  assert.match(overlay, /lv-choice inline-flex min-w-11 items-center justify-center rounded-s-none/, 'the «×» is narrower than 44 px');
  // The home's trending chips keep .lv-choice's own focus outline.
  const chips = code(`${DIR}/TrendingTags.tsx`);
  assert.doesNotMatch(chips, /focus-visible:outline-none/, 'a chip switches the outline off without a ring');
  assert.match(overlay, /dir="auto"/, 'user text without dir="auto"');
  assert.match(overlay, /<bdi>/, 'a name without <bdi>');
  assert.match(overlay, /tabular-nums/);
});

test('every word of the search exists in Arabic, English and real Sorani', () => {
  const flat = (o: Record<string, unknown>, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${prefix}${k}.`));
      else out[`${prefix}${k}`] = String(v);
    }
    return out;
  };
  const ar = flat(SEARCH_STRINGS.ar);
  const en = flat(SEARCH_STRINGS.en);
  const ckb = flat(SEARCH_STRINGS.ckb);
  const keys = Object.keys(ar);
  assert.ok(keys.length >= 30, `only ${keys.length} keys`);
  assert.deepEqual(Object.keys(en).sort(), keys.slice().sort(), 'en keys differ from ar');
  assert.deepEqual(Object.keys(ckb).sort(), keys.slice().sort(), 'ckb keys differ from ar');
  let same = 0;
  let sorani = 0;
  for (const k of keys) {
    for (const [lang, table] of [['ar', ar], ['en', en], ['ckb', ckb]] as const) assert.ok(table[k].trim().length > 0, `${lang}.${k} is empty`);
    if (ckb[k] === ar[k]) same += 1;
    assert.notEqual(ckb[k], en[k], `ckb.${k} is the English`);
    // The letters Sorani has and Arabic does not: ە ێ ڕ ڵ گ ک ۆ ی.
    if (/[ەێڕڵگکۆی]/.test(ckb[k])) sorani += 1;
  }
  assert.ok(same / keys.length <= 0.1, `${same} of ${keys.length} Sorani strings are the Arabic pasted across`);
  assert.ok(sorani / keys.length >= 0.9, `only ${sorani} of ${keys.length} Sorani strings carry a Sorani letter`);
  for (const t of ['projects', 'stores', 'creators', 'products', 'requests', 'materials', 'brands']) assert.ok(ar[`sections.${t}`], `no section name for ${t}`);
});

test('the counts are bounded at 200 and say so', () => {
  assert.equal(boundedCount(3, 'ar'), '3 نتائج');
  assert.equal(boundedCount(1, 'ar'), 'نتيجة واحدة');
  assert.equal(boundedCount(200, 'ar'), '+200 نتيجة');
  assert.equal(boundedCount(999, 'ar'), '+200 نتيجة');
  assert.equal(boundedCount(7, 'en'), '7 results');
  assert.equal(boundedCount(250, 'en'), '200+ results');
  assert.equal(boundedCount(200, 'ckb'), '+200 ئەنجام');
  const api = code(`${DIR}/api.ts`);
  assert.match(api, /Math\.max\(1, Math\.min\(12, Math\.floor\(opts\.limit\)\)\)/, 'a section limit above 12 is sent as asked');
  assert.match(api, /SUGGEST_MIN = 2/);
  assert.match(api, /SEARCH_MAX = 60/);
  assert.match(api, /'\/api\/community\/trending'/);
  assert.match(api, /TRENDING_FRESH_MS = 5 \* 60_000/, 'trending is not remembered for the edge\'s five minutes');
  assert.doesNotMatch(api, /api\.(post|put|patch|delete)\(/, 'the search module writes nothing');
});

test('«recent searches» are the browser\'s alone: a term and a time, nothing else, and a button forgets them', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  clearRecent();
  assert.equal(RECENT_KEY, 'levonis.communityRecent.v1', 'the key is versioned like recentlyViewed');
  assert.equal(RECENT_MAX, 10);

  rememberRecent('  تنين   مفصلي ', 1000);
  rememberRecent('vase', 2000);
  rememberRecent('تنين مفصلي', 3000);
  const rows = readRecent();
  assert.deepEqual(rows, [
    { term: 'تنين مفصلي', at: 3000 },
    { term: 'vase', at: 2000 },
  ]);
  const raw = JSON.parse(store.get(RECENT_KEY)!) as Array<Record<string, unknown>>;
  for (const r of raw) assert.deepEqual(Object.keys(r).sort(), ['at', 'term'], 'a stored row carries more than the term and the time');

  // Never an email, a phone or a one-letter term.
  assert.equal(storableTerm('ali@example.com'), null);
  assert.equal(storableTerm('07701234567'), null);
  assert.equal(storableTerm('٠٧٧٠ ١٢٣ ٤٥٦٧'), null);
  assert.equal(storableTerm('x'), null);
  assert.equal(storableTerm('PLA 1.75'), 'PLA 1.75');
  rememberRecent('ali@example.com');
  rememberRecent('0770 123 4567');
  assert.equal(readRecent().length, 2);

  // Ten at most, newest first.
  for (let i = 0; i < 14; i++) rememberRecent(`term ${i}`, 10_000 + i);
  const many = readRecent();
  assert.equal(many.length, RECENT_MAX);
  assert.equal(many[0].term, 'term 13');

  forgetRecent('term 13');
  assert.equal(readRecent()[0].term, 'term 12');
  clearRecent();
  assert.deepEqual(readRecent(), []);
  assert.equal(store.has(RECENT_KEY), false, 'clearing leaves the key behind');

  // Garbage in storage is not a crash.
  store.set(RECENT_KEY, '{"not":"a list"}');
  assert.deepEqual(readRecent(), []);
  store.set(RECENT_KEY, '[{"term":"ok term","at":1,"user":"u1"},{"term":"a@b.c","at":2},{"at":3}]');
  assert.deepEqual(readRecent(), [{ term: 'ok term', at: 1 }], 'a foreign field or a stored email survives a read');

  const src = code(`${DIR}/recent.ts`);
  assert.doesNotMatch(src, /\b(userId|viewer|account_id|user_id)\b/, 'recent.ts names an account');
  assert.doesNotMatch(src, /fetch\(|api\./, 'recent.ts talks to the server');
});

test('the CSS budget was paid, not raised: the dead animations are gone and Tailwind reads only the UI trees', () => {
  const css = read('src/index.css');
  for (const dead of ['fly-to-cart', 'spin-shrink', 'slideUp']) assert.doesNotMatch(css, new RegExp(dead), `${dead} is back in src/index.css`);
  for (const dir of ['docs', 'worker', 'migrations', 'scripts', 'studio', 'services']) {
    assert.match(css, new RegExp(`@source not "\\.\\./${dir}";`), `Tailwind scans ${dir}/ again`);
  }
  assert.doesNotMatch(css, /@source not "\.\.\/tests"/, 'the browser fixtures compile under the dev server and must stay scanned');
  assert.doesNotMatch(css, /@source not "\.\.\/(src|packages)"/);
});
