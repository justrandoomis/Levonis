/**
 * THE SHARED COMMUNITY PARTS (community UI plan B2) — what must hold before
 * the screens (C1 to C5) build on them.
 *
 *   * A public request card has NO budget field in its type, renders no budget
 *     even when handed one, draws no picture (a glyph tile, plan R3) and names
 *     no person (R10, acceptance 34).
 *   * Every card is one link, or a stretched link with its button beside it:
 *     never a <button> inside a link.
 *   * The sections menu (IMG_8478) is a lazy chunk; Levo Studio in it is a
 *     plain anchor in a new tab, said aloud, never prefetched; the community
 *     group is hidden while the community is shut to the viewer (presentation
 *     only, the server is the gate).
 *   * The follow button is one look for a person and a store, says its state
 *     with aria-pressed, hits 44px and sits above a card link.
 *   * A liked heart wears the scoped like colour (D-6) and falls back to the
 *     gold it was outside the scope; a save keeps the gold. The colour is on
 *     the mark alone: the number beside it stays in the primary ink.
 *   * The words: the state words and counted nouns of a card in three
 *     languages, the Sorani its own (DECISIONS row 183), Latin digits (R13).
 *
 * Fix round 1 (B2R1): the liked count is ink, not scarlet (FID-1); the row
 * card holds its pill beside the chevron in an end column (FID-2); the
 * section header draws its line under the title (FID-3); a parts job says one
 * count of each thing (FID-4); a count word is never cut (FID-5); the menu
 * popover closes onto its door on Shift+Tab (A11Y-1) and its language row
 * opens the header sheet itself (REG-1); the estimate names Levonis in Latin
 * letters (REG-2).
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

// The language provider reads `levo_lang`; each render below names its own.
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
const { default: RequestListCard } = await import('../src/components/community/requests/RequestListCard');
const words = await import('../src/components/community/requests/requestWords');
const { default: FollowButton } = await import('../src/components/community/kit/FollowButton');
const { default: SectionPageHeader } = await import('../src/components/community/kit/SectionPageHeader');
const { default: CountToggle } = await import('../src/components/community/social/CountToggle');
const { KIT_STRINGS } = await import('../src/components/community/kit/strings');
const { currentSection } = await import('../src/components/community/hub/CommunityMenu');

type Card = Parameters<typeof RequestListCard>[0];

function render(node: ReturnType<typeof createElement>, lang = 'ar'): string {
  LANG = lang;
  return renderToStaticMarkup(createElement(AuthProvider, { children: createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }) }));
}
const card = (props: Card, lang = 'ar') => render(createElement(RequestListCard, props), lang);

/** What the board answers for a request, with what a public card must never print. */
const leaky = {
  id: 'rq_1',
  title: 'حامل تثبيت للحائط',
  quantity: 4,
  material: 'PETG',
  governorate: 'baghdad',
  state: 'receiving_offers',
  offer_count: 3,
  file_count: 2,
  deadline: '2026-11-05T00:00:00.000Z',
  budget_iqd: 45123,
  customer_name: 'Ali Hassan',
  cover_url: '/api/marketplace/requests/rq_1/files/f_1',
};

/** Every anchor body, from its opening tag to its own closing tag. */
function anchors(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>/g)) out.push(html.slice(m.index!, html.indexOf('</a>', m.index!)));
  return out;
}

test('a public request card has no budget field, and prints none, no picture and no person when handed them', () => {
  const src = code('src/components/community/requests/RequestListCard.tsx');
  const type = src.slice(src.indexOf('export interface PublicRequestCard'), src.indexOf('}', src.indexOf('export interface PublicRequestCard')));
  assert.ok(type.length > 40, 'PublicRequestCard is missing');
  assert.doesNotMatch(type, /budget/i, 'the public card type carries a budget field (plan R2)');
  assert.doesNotMatch(type, /customer|author|avatar|user/i, 'the public card type carries a person (R10)');
  assert.doesNotMatch(type, /cover|thumb|image|url/i, 'the public card type carries a picture (R3)');
  for (const variant of ['row', 'aside', 'list'] as const) {
    // The board row carries more than the type names; the card reads only its own fields.
    const html = card({ variant, request: leaky as unknown as Extract<Card, { variant: 'list' }>['request'] });
    assert.doesNotMatch(html, /45[,.٬]?123|45123/, `${variant}: a budget figure reached a public card`);
    assert.doesNotMatch(html, /Ali Hassan/, `${variant}: a person is named on a public card`);
    assert.doesNotMatch(html, /<img\b/, `${variant}: a public card draws a picture`);
    assert.match(html, /data-request-glyph="fdm"/, `${variant}: the neutral glyph tile is missing`);
    assert.match(html, /href="\/requests\/rq_1"/, `${variant}: the card does not open the request page`);
    for (const a of anchors(html)) assert.doesNotMatch(a, /<button\b/, `${variant}: a <button> inside the link`);
    assert.equal(anchors(html).length, 1, `${variant}: the card is not ONE link`);
  }
});

test('the glyph says the process: a page for words alone, a drop for resin; a job of parts says its parts under it and each count once (B2R1-FID-4)', () => {
  assert.equal(words.requestGlyph({ file_count: 0, material: 'PLA' }), 'text');
  assert.equal(words.requestGlyph({ file_count: 2, material: 'Standard Resin' }), 'resin');
  assert.equal(words.requestGlyph({ file_count: 1, material: 'PETG' }), 'fdm');
  // 2 parts, 5 pieces a set, 4 sets: the parts under the glyph in the words of the live card
  // (jobCountWords), the pieces of the job once in the meta, and the sets beside them.
  const job = { ...leaky, material: 'Clear Resin', summary: { parts_count: 2, pieces_per_set: 5 } };
  const want = {
    ar: { parts: 'عدد الأجزاء 2', pieces: '20 قطعة', sets: 'الأطقم', perSet: '5 قطع' },
    en: { parts: '2 parts', pieces: '20 pieces', sets: 'Sets', perSet: '5 pieces' },
    ckb: { parts: '2 بەش', pieces: '20 پارچە', sets: 'سێت', perSet: '5 پارچە' },
  } as const;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const variant of ['row', 'list'] as const) {
      const html = card({ variant, request: job as unknown as Extract<Card, { variant: 'list' }>['request'] }, lang);
      assert.match(html, /data-request-glyph="resin"/);
      assert.ok(html.includes(`data-request-parts="2" class="px-1 text-center text-[12px] font-semibold leading-tight tabular-nums">${want[lang].parts}</span>`), `${lang} ${variant}: the parts under the glyph`);
      assert.ok(html.includes(want[lang].pieces), `${lang} ${variant}: the pieces of the job, 4 sets of 5`);
      assert.ok(!html.includes(want[lang].perSet), `${lang} ${variant}: a second count of pieces (the pieces of a set) is on the card`);
      assert.ok(html.includes(`data-request-sets="4" class="whitespace-nowrap">${want[lang].sets}: <bdi dir="ltr">×4</bdi></span>`), `${lang} ${variant}: the sets, as the live card says them`);
      // The parts are read with the card: the tile hides only its glyph.
      assert.doesNotMatch(html, /data-request-glyph="resin"[^>]*aria-hidden/, `${lang} ${variant}: the parts are hidden from a screen reader`);
    }
  }
  // One part, once per set: no parts under the glyph and no sets.
  const plain = card({ variant: 'list', request: leaky as unknown as Extract<Card, { variant: 'list' }>['request'] });
  assert.doesNotMatch(plain, /data-request-parts|data-request-sets/);
  assert.match(plain, /4 قطع/);
  // One set of a parts job: the parts, and no «×1».
  const once = card({ variant: 'row', request: { ...job, quantity: 1 } as unknown as Extract<Card, { variant: 'row' }>['request'] });
  assert.match(once, /data-request-parts="2"/);
  assert.doesNotMatch(once, /data-request-sets/);
  assert.match(once, /5 قطع/, 'one set of 5: the pieces of the job');
});

test('the row: the pill beside the chevron in an end column, the short state word, nothing cut (B2R1-FID-2, FID-5)', () => {
  const row = card({ variant: 'row', request: leaky as unknown as Extract<Card, { variant: 'row' }>['request'] });
  // The end column follows the words and holds the pill, then the onward chevron (IMG_8487 row 8).
  assert.match(row, /<span class="ms-auto flex shrink-0 items-center gap-1\.5" data-request-end="true"><span data-state-pill="open"[^>]*>مفتوح<\/span><svg[^>]*lucide-chevron-left[^>]*>/);
  assert.equal(row.match(/data-state-pill=/g)?.length, 1, 'one pill on the row');
  // The words keep 8.5rem beside the tile; a narrower card wraps the end column onto its own line, by width alone.
  assert.match(row, /class="cm-card flex min-h-\[88px\] flex-wrap items-center gap-x-3 gap-y-2 /);
  assert.match(row, /<div class="flex min-w-0 grow basis-\[8\.5rem\] flex-col gap-0\.5">/);
  // The short word on the row, which counts the offers beside it; the board card keeps the full state.
  assert.doesNotMatch(row, /يستقبل عروضًا/);
  assert.match(card({ variant: 'list', request: leaky as unknown as Extract<Card, { variant: 'list' }>['request'] }), /data-state-pill="open"[^>]*>يستقبل عروضًا/);
  assert.match(card({ variant: 'row', request: leaky as unknown as Extract<Card, { variant: 'row' }>['request'] }, 'en'), /data-state-pill="open"[^>]*>Open</);
  assert.deepEqual(words.requestStateWord('receiving_offers', 'ar', { brief: true }), { word: 'مفتوح', tone: 'open' });
  assert.deepEqual(words.requestStateWord('receiving_offers', 'ckb', { brief: true }), { word: 'کراوە', tone: 'open' });
  assert.deepEqual(words.requestStateWord('in_progress', 'ar', { brief: true }), { word: 'قيد التنفيذ', tone: 'progress' }, 'brief folds only the states that take offers');
  assert.deepEqual(words.requestStateWord('receiving_offers', 'ar', { owner: true, offers: 2, brief: true }), { word: 'بانتظار الاختيار', tone: 'waiting' });
  // Nothing is cut: the title alone keeps one line; the meta wraps between its words, each bullet
  // glued to the word before it; the counts wrap whole, each count in one piece.
  assert.equal(row.match(/\btruncate\b/g)?.length, 1, 'only the title is held to one line');
  assert.match(row, /<span class="block break-words text-\[13px\] leading-snug text-text-secondary"><bdi>بغداد<\/bdi><span aria-hidden="true">\u00a0• <\/span>/);
  assert.match(row, /<span class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0\.5 overflow-hidden text-\[13px\] leading-snug text-text-secondary"><span class="inline-flex items-center gap-1 whitespace-nowrap" data-request-offers="3">/);
  // The bar between the counts hangs outside the attachments: at the start of a line it is clipped, never left alone there.
  assert.match(row, /<span class="relative inline-flex items-center gap-1 whitespace-nowrap" data-request-files="2"><span aria-hidden="true" class="absolute end-full me-1\.5 text-text-muted">\|<\/span>/);
  const src = code('src/components/community/requests/RequestListCard.tsx');
  assert.doesNotMatch(src, /className="truncate">\{attachmentsWord/, 'the attachments word is cut again');
});

test('the list card is the board anatomy without a budget: the pill, the meta row, «الموعد المطلوب» across, «عرض الطلب» and the counts', () => {
  const html = card({ variant: 'list', request: leaky as unknown as Extract<Card, { variant: 'list' }>['request'] });
  assert.match(html, /data-state-pill="open"[^>]*>يستقبل عروضًا/);
  assert.match(html, /الموعد المطلوب/);
  assert.match(html, /عرض الطلب/);
  assert.match(html, /3 عروض/);
  assert.match(html, /مرفقان/);
  assert.match(html, /بغداد/);
  assert.match(html, /4 قطع/);
  assert.doesNotMatch(html, /الميزانية/, 'the budget cell is gone, not emptied');
  const flexible = card({ variant: 'list', request: { ...leaky, deadline: null, offer_count: 0 } as unknown as Extract<Card, { variant: 'list' }>['request'] });
  assert.match(flexible, /مرن في الموعد/);
  assert.match(flexible, /بانتظار العروض/, 'no offers yet is a sentence, never «0 عروض»');
  const en = card({ variant: 'list', request: leaky as unknown as Extract<Card, { variant: 'list' }>['request'] }, 'en');
  assert.match(en, /Needed by/);
  assert.match(en, /3 offers/);
  const ckb = card({ variant: 'list', request: leaky as unknown as Extract<Card, { variant: 'list' }>['request'] }, 'ckb');
  assert.match(ckb, /کاتی پێویست/);
  assert.match(ckb, /3 ئۆفەر/);
});

test('the owner card adds what only the owner reads, with its button beside a stretched link, never inside it', () => {
  const html = card({ variant: 'owner', request: { ...leaky, budget_visible: false, estimate_low_iqd: 38000, estimate_high_iqd: 52000, accepted_merchant: 'ورشة بغداد' }, chips: ['تحتاج مراجعة فنية'], onRepeat: () => undefined });
  assert.match(html, /<img\b[^>]*src="\/api\/marketplace\/requests\/rq_1\/files\/f_1\?w=160"/, 'the owner first picture through its authorised route');
  assert.match(html, /45,123/, 'the owner budget, Latin digits');
  assert.match(html, /مخفية عن التجار والعموم/);
  assert.match(html, /38,000/);
  assert.match(html, /ورشة بغداد/);
  assert.match(html, /بانتظار الاختيار/, 'offers waiting on the owner choice');
  assert.match(html, /إعادة الطلب/);
  for (const a of anchors(html)) assert.doesNotMatch(a, /<button\b/, 'the repeat button is inside the link');
  assert.match(html, /after:absolute after:inset-0/, 'the title link stretches over the card');
  const shown = card({ variant: 'owner', request: { ...leaky, budget_visible: true } });
  assert.match(shown, /يراها التجار الذين يمكنهم صنع طلبك، ولا تظهر للعموم/);
  // An older Worker that says nothing of the switch: the figure, and no claim about who sees it.
  const unknown = card({ variant: 'owner', request: { ...leaky } });
  assert.doesNotMatch(unknown, /data-request-budget-visible/);
});

test('the card words: state words and counted nouns in three languages, Latin digits, the Sorani its own', () => {
  assert.equal(words.piecesWord(1, 'ar'), 'قطعة واحدة');
  assert.equal(words.piecesWord(2, 'ar'), 'قطعتان');
  assert.equal(words.piecesWord(4, 'ar'), '4 قطع');
  assert.equal(words.piecesWord(12, 'ar'), '12 قطعة');
  assert.equal(words.piecesWord(1, 'en'), '1 piece');
  assert.equal(words.piecesWord(3, 'ckb'), '3 پارچە');
  assert.equal(words.attachmentsWord(2, 'ar'), 'مرفقان');
  assert.equal(words.attachmentsWord(3, 'ar'), '3 مرفقات');
  assert.equal(words.attachmentsWord(11, 'ar'), '11 مرفقًا');
  assert.equal(words.offersWord(0, 'ar'), 'بانتظار العروض');
  assert.equal(words.offersWord(0, 'ckb'), 'چاوەڕوانی ئۆفەرە');
  assert.equal(words.offersWord(2, 'ar'), 'عرضان');
  assert.equal(words.offersWord(5, 'en'), '5 offers');
  assert.deepEqual(words.requestStateWord('open', 'ar'), { word: 'مفتوح', tone: 'open' });
  assert.deepEqual(words.requestStateWord('receiving_offers', 'ckb'), { word: 'وەرگرتنی ئۆفەر', tone: 'open' });
  assert.deepEqual(words.requestStateWord('receiving_offers', 'ar', { owner: true, offers: 2 }), { word: 'بانتظار الاختيار', tone: 'waiting' });
  assert.deepEqual(words.requestStateWord('receiving_offers', 'ar', { owner: true, offers: 0 }), { word: 'يستقبل عروضًا', tone: 'open' });
  assert.equal(words.requestStateWord('some_new_state', 'en').word, 'In progress', 'a state the client does not know still reads as words');
  // The brand stays Latin in every language (tests/brandName.test.ts, B2R1-REG-2), as the wizard writes the estimate.
  assert.equal(words.CARD_WORDS.ar.estimate, 'تقدير Levonis');
  assert.equal(words.CARD_WORDS.ckb.estimate, 'خەمڵاندنی Levonis');
  assert.equal(words.CARD_WORDS.en.estimate, 'Levonis estimate');
  for (const key of Object.keys(words.CARD_WORDS.ar) as Array<keyof typeof words.CARD_WORDS.ar>) {
    assert.ok(words.CARD_WORDS.en[key] && words.CARD_WORDS.ckb[key], `${key}: a language is empty`);
    assert.notEqual(words.CARD_WORDS.ckb[key], words.CARD_WORDS.ar[key], `${key}: the Sorani is the Arabic (row 183)`);
    assert.doesNotMatch(words.CARD_WORDS.en[key], /[\u0600-\u06ff]/, `${key}: the English carries Arabic script`);
  }
  for (const state of ['draft', 'open', 'receiving_offers', 'in_progress', 'completed', 'cancelled', 'expired', 'disputed', 'delivered', 'offer_selected']) {
    assert.notEqual(words.requestStateWord(state, 'ckb').word, words.requestStateWord(state, 'ar').word, `${state}: the Sorani is the Arabic`);
  }
  // The hub own table: the home card never downloads the request page helpers.
  assert.doesNotMatch(code('src/components/community/requests/requestWords.ts'), /requestStates/);
  assert.doesNotMatch(code('src/components/community/requests/RequestListCard.tsx'), /requestStates/);
});

test('the sections menu: lazy, Studio a plain anchor never prefetched, the community group hidden while shut, the page on screen current', () => {
  const menu = code('src/components/community/hub/CommunityMenu.tsx');
  const header = code('src/components/community/kit/SectionPageHeader.tsx');
  assert.match(header, /const CommunityMenu = React\.lazy\(\(\) => import\('\.\.\/hub\/CommunityMenu'\)\);/, 'the menu is a lazy chunk');
  const sources = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => `src/${f.split('\\').join('/')}`);
  for (const f of sources) assert.doesNotMatch(read(f), /^import [^\n]*hub\/CommunityMenu'/m, `${f} imports the menu statically`);
  // Studio: the kit ListRow with an href, which is a plain <a target="_blank" rel="noopener noreferrer"> with the new-tab words.
  assert.match(menu, /<ListRow label="Levo Studio" icon=\{<Box className=\{glyph\} \/>\} href=\{STUDIO_URL\}/);
  const row = code('src/components/community/kit/display.tsx');
  assert.match(row, /<a href=\{href\} target="_blank" rel="noopener noreferrer"[^>]*>\s*\{body\}\s*<span className="sr-only">\{s\.opensNewTab\}<\/span>/);
  assert.doesNotMatch(menu, /prefetch|preload|iframe/i, 'nothing of Studio loads before the tap');
  assert.match(menu, /\{access\?\.may_enter !== false && \(\s*<MenuGroup/, 'the community group is shown only while the community is open to the viewer');
  assert.match(menu, /useCommunityAccess\(\)/);
  // A sheet on a phone, a popover from lg.
  assert.match(menu, /const DESKTOP_QUERY = '\(min-width: 1024px\)';/);
  assert.match(menu, /<Anchored open=\{open\} onClose=\{onClose\} anchor=\{anchor\}[^>]*role="dialog"[^>]*className="w-full max-w-\[360px\]"/);
  assert.match(menu, /<Sheet\s[^>]*detents=\{\['large'\]\}/);
  // A guest reaches an account row through sign-in, and reads «تسجيل الدخول» where the account would be.
  assert.match(menu, /const gated = \(path: string\) => \(isAuthenticated \? path : authPathWithSupportRef\(path\)\);/);
  assert.match(menu, /row\('signin', hub\.signIn,/);
  // «اللغة والمظهر» opens the sheet of the header globe through its own hook, drawn beside the menu
  // (so a choice outlives the popover closing under it), never a copy of its rules (B2R1-REG-1).
  assert.match(menu, /import \{ useLangThemeSheet \} from '\.\.\/\.\.\/LangThemeSheet';/);
  assert.match(menu, /const \[langThemePanel, langThemeToggle, langThemeRef\] = useLangThemeSheet\(false\);/);
  assert.match(menu, /<MenuBody onNavigate=\{onClose\} onLangTheme=\{langThemeToggle\} langThemeRef=\{langThemeRef\} \/>/);
  assert.match(menu, /\{langThemePanel\}\s*<\/>/);
  assert.match(menu, /<button ref=\{langThemeRef\} type="button" onClick=\{onLangTheme\}/);
  assert.doesNotMatch(menu, /setLang\(|setThemePreference|LangThemePanel|loadedPanel/, 'the menu keeps a copy of the sheet rules');
  // The popover leaves at either edge the way it came in (B2R1-A11Y-1): past its last row on to what
  // follows the door, and before its first control onto the door, never to the end of the page.
  assert.match(menu, /if \(e\.shiftKey\) \{\s*if \(document\.activeElement !== first\.current\) return;\s*e\.preventDefault\(\);\s*onClose\(\);\s*return;\s*\}/);
  assert.match(menu, /if \(all && document\.activeElement === all\[all\.length - 1\]\) onClose\(\);/);
  // The current row.
  assert.equal(currentSection('/community'), 'home');
  assert.equal(currentSection('/community/stores'), 'stores');
  assert.equal(currentSection('/community/projects/p_1'), 'projects');
  assert.equal(currentSection('/requests/rq_1'), 'requests');
  assert.equal(currentSection('/community/makers'), 'makers');
  assert.equal(currentSection('/cart'), null);
  // No <button> inside a link anywhere in the parts.
  for (const f of ['src/components/community/hub/CommunityMenu.tsx', 'src/components/community/kit/SectionPageHeader.tsx', 'src/components/community/kit/FollowButton.tsx', 'src/components/community/requests/RequestListCard.tsx']) {
    const src = code(f);
    for (const tag of ['a', 'Link', 'ListLink']) {
      for (const m of src.matchAll(new RegExp(`<${tag}(?=[\\s>])`, 'g'))) {
        if (/^<[^>]*\/>/.test(src.slice(m.index!))) continue;
        const close = src.indexOf(`</${tag}>`, m.index!);
        assert.doesNotMatch(src.slice(m.index!, close < 0 ? undefined : close), /<button\b/, `${f}: a <button> inside <${tag}>`);
      }
    }
  }
});

test('the section header: an h1, a named back that mirrors, the kicker on request, and the sections door', () => {
  const ar = render(createElement(SectionPageHeader, { title: 'المتاجر', kicker: true }), 'ar');
  assert.match(ar, /<h1[^>]*>المتاجر<\/h1>/);
  assert.match(ar, /aria-label="رجوع"/);
  // The line UNDER the title, as IMG_8486 draws «أتابعهم» over «مجتمع ليفو» (B2R1-FID-3).
  assert.match(ar, /<h1[^>]*>المتاجر<\/h1><p class="text-\[13px\] leading-tight text-text-secondary">مجتمع ليفو<\/p>/);
  assert.match(ar, /lucide-chevron-right/, 'Arabic: the back chevron points to the inline start, the right');
  const en = render(createElement(SectionPageHeader, { title: 'Stores' }), 'en');
  assert.match(en, /aria-label="Back"/);
  assert.match(en, /lucide-chevron-left/);
  assert.doesNotMatch(en, /Levo Community/, 'no kicker unless asked');
  const src = code('src/components/community/kit/SectionPageHeader.tsx');
  assert.match(src, /const goBack = useGoBack\(backTo\);/);
  assert.match(src, /'aria-haspopup': 'dialog',\s*'aria-expanded': open,/, 'the door says it opens a window and whether it is open');
  assert.match(src, /className=\{`top-0 z-30 flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 bg-canvas py-1\.5 lg:sticky/, '56px, sticky from lg only, the door wrapping under a long title');
});

test('the follow button: one look for people and stores, aria-pressed, 44px, above a card link', () => {
  const rest = render(createElement(FollowButton, { following: false, onToggle: () => undefined, size: 'sm' }));
  assert.match(rest, /aria-pressed="false"/);
  assert.match(rest, /متابعة/);
  assert.match(rest, /lv-hit/, 'drawn 36px inside a 44px hit');
  assert.match(rest, /relative z-10/);
  assert.match(rest, /lucide-user-plus/);
  const on = render(createElement(FollowButton, { following: true, onToggle: () => undefined, name: 'سارة حسن' }));
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /تتابعه/);
  assert.match(on, /lucide-check/);
  assert.match(on, /aria-label="تتابعه: سارة حسن"/, 'the name of the person, so two buttons on a page differ');
  assert.match(on, /min-h-11/);
  assert.match(render(createElement(FollowButton, { following: false, onToggle: () => undefined, tone: 'gold' })), /cm-btn-gold/);
  assert.match(render(createElement(FollowButton, { following: false, busy: true, onToggle: () => undefined })), /aria-busy="true"/);
  assert.match(code('src/components/community/social/FollowUserButton.tsx'), /<FollowButton\b/);
  assert.match(code('src/components/community/hub/useStoreFollow.ts'), /const followProps = \(raw: CommunityStore, size: FollowButtonProps\['size'\] = 'sm'\): FollowButtonProps \| null =>/);
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(KIT_STRINGS[lang].follow && KIT_STRINGS[lang].following);
  assert.equal(KIT_STRINGS.ar.following, 'تتابعه', 'one form, no gender stored (plan R12)');
  assert.equal(KIT_STRINGS.ckb.following, 'شوێنی دەکەویت');
});

test('a liked heart wears the scoped like colour and falls back to gold outside the scope; a save stays gold', () => {
  const props = { count: 3, labelOn: 'off', labelOff: 'on', countLabel: (n: number) => String(n), icon: () => null, toggle: async () => ({ on: true, count: 3 }), failText: '' };
  const liked = render(createElement(CountToggle, { ...props, on: true, tone: 'like' }));
  assert.match(liked, /style="color:var\(--cm-like, var\(--color-gold\)\)"/);
  assert.doesNotMatch(liked, /text-gold/);
  // The scarlet is on the mark alone; the number keeps the primary ink (IMG_8486 «إعجاب 24 ♥»): as text the
  // scarlet reads 3.9 to 4.5:1 on a dark card, under AA for 13px (B2R1-FID-1).
  const button = liked.match(/<button[^>]*>/)![0];
  assert.doesNotMatch(button, /--cm-like|style=/, 'the like colour is on the button, so the number inherits it');
  assert.match(button, /\btext-text-primary\b/, 'the number beside a liked heart is in the primary ink');
  assert.match(liked, /<span aria-hidden="true" class="inline-flex" style="color:var\(--cm-like, var\(--color-gold\)\)">/, 'the mark wears the like colour');
  const idle = render(createElement(CountToggle, { ...props, on: false, tone: 'like' }));
  assert.doesNotMatch(idle, /--cm-like/);
  const saved = render(createElement(CountToggle, { ...props, on: true }));
  assert.match(saved, /text-gold/);
  assert.doesNotMatch(saved, /--cm-like/);
  assert.match(code('src/components/community/social/LikeButton.tsx'), /tone="like"/);
  assert.match(code('src/components/community/social/SaveButton.tsx'), /tone="gold"/);
  // The scoped colour exists in both themes of the scope, and nowhere else.
  const sheet = read('src/styles/community.css');
  assert.equal(sheet.match(/--cm-like:/g)?.length, 2);
  assert.doesNotMatch(read('src/index.css'), /--cm-like/);
});

test('the new kit words are in three languages, the Sorani its own', () => {
  for (const key of ['back', 'sections', 'sectionsAndAccount', 'myAccount', 'community', 'communityHint', 'communityHome', 'yourAccount', 'yourAccountHint', 'storesIFollow', 'langTheme', 'myStore', 'openStore', 'close', 'follow', 'following', 'communityName'] as const) {
    assert.ok(KIT_STRINGS.ar[key] && KIT_STRINGS.en[key] && KIT_STRINGS.ckb[key], `${key}: a language is empty`);
    assert.notEqual(KIT_STRINGS.ckb[key], KIT_STRINGS.ar[key], `${key}: the Sorani is the Arabic`);
  }
  assert.equal(KIT_STRINGS.ar.sectionsAndAccount, 'الأقسام والحساب');
  assert.equal(KIT_STRINGS.ckb.sectionsAndAccount, 'بەشەکان و هەژمار');
});
