/**
 * REPUTATION V2 ON THE SCREEN (docs/COMMUNITY_ECOSYSTEM.md §9.6, Client 6a) —
 * src/components/community/reputation/{BadgeChips,strings}.tsx, the page
 * /community/badges (src/pages/community/Badges.tsx), the merchant's «سمعتك»
 * (src/components/merchant/analytics/ReputationCard.tsx) and the surfaces that
 * mount the chips.
 *
 *   the words: every key in ar, en AND written Sorani; each rule a sentence
 *   built from the server's `rule_params` (a re-tuned number reads right);
 *   the chips: at most three, known keys only, in the catalogue's order, a
 *   card without one draws nothing; every chip is a button asking «لماذا؟»;
 *   the store tone wears the island's ink, never the app's tokens;
 *   the popover: the name, «لماذا؟», the rule, since when, and the page
 *   (/community/badges#key — the platform's origin on a store host);
 *   the catalogue: asked ONCE per page, retried after a failure;
 *   the page: every badge's rule in the reader's language, three languages;
 *   the merchant: the evidence per badge, how far from the rest, the windows;
 *   the pins: the storefront hero, the directory card and the creator page
 *   load the chips lazily, and only for a store that has one.
 *
 * Run: node --import tsx --test tests/badgesUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { MerchantReputation } from '../src/components/community/reputation/api';

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const chips = await import('../src/components/community/reputation/BadgeChips');
const { default: BadgeChips, WhyPanel, badgeHref, chipBadges, loadRules, resetBadgeRules, BADGE_ICONS } = chips;
const strings = await import('../src/components/community/reputation/strings');
const { REPUTATION_STRINGS, reputationStrings, ruleSentence, respondsWithin, withinWords, arCount, DEFAULT_RULE_PARAMS } = strings;
const { BADGE_KEYS, visibleBadges } = await import('../src/components/community/reputation/api');
const { default: BadgesPage } = await import('../src/pages/community/Badges');
const { ReputationBody, evidenceFigures, progressOf } = await import('../src/components/merchant/analytics/ReputationCard');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar', path = '/') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, { initialEntries: [path] }, node) }));
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const attrs = (h: string, name: string) => [...h.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

const ALL = [
  { key: 'high_completion', since: '2026-09-01' },
  { key: 'mystery_badge', since: '2026-09-02' },
  { key: 'custom_specialist', since: '2026-08-20' },
  { key: 'fast_response', since: '2026-09-10' },
  { key: 'verified_merchant', since: '2026-01-05' },
  { key: 'reliable_seller', since: '2026-07-01' },
];

// ------------------------------------------------------------------ words

/** Every leaf of a table, functions called with sample arguments. */
function leaves(o: unknown, path = ''): Array<[string, string]> {
  if (typeof o === 'string') return [[path, o]];
  if (typeof o === 'function') return [[path, String((o as (...a: unknown[]) => unknown)('٣ أكتوبر', 10))]];
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

test('every word exists in ar, en and written Sorani — no Arabic standing in for ckb', () => {
  const ar = leaves(REPUTATION_STRINGS.ar);
  for (const lang of ['en', 'ckb'] as const) {
    assert.deepEqual(leaves(REPUTATION_STRINGS[lang]).map(([k]) => k), ar.map(([k]) => k), `${lang} has the same keys`);
  }
  const ckb = new Map(leaves(REPUTATION_STRINGS.ckb));
  let sorani = 0;
  for (const [k, v] of ar) {
    const c = ckb.get(k) ?? '';
    assert.ok(c, `${k} in ckb`);
    assert.notEqual(c, v, `${k}: the Sorani is the Arabic`);
    if (KURDISH.test(c)) sorani += 1;
  }
  assert.ok(sorani >= ar.length - 3, `only ${sorani} of ${ar.length} Sorani strings carry a Sorani letter`);
  for (const k of BADGE_KEYS) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      assert.ok(REPUTATION_STRINGS[lang].names[k], `${lang} names ${k}`);
      const rule = ruleSentence(k, null, lang);
      assert.ok(rule.length > 20, `${lang} explains ${k}`);
      if (lang === 'ckb') assert.match(rule, KURDISH, `${k}: the Sorani rule is Sorani`);
    }
  }
  assert.equal(reputationStrings('fr').why, 'لماذا؟', 'an unknown language falls back to Arabic');
  assert.equal(REPUTATION_STRINGS.ckb.why, 'بۆچی؟');
});

test('each rule is a sentence of the server\'s numbers — a re-tuned rule reads right', () => {
  assert.match(ruleSentence('fast_response', DEFAULT_RULE_PARAMS.fast_response, 'ar'), /آخر 30 يومًا.*خلال ساعة.*10 محادثات/);
  assert.match(ruleSentence('fast_response', DEFAULT_RULE_PARAMS.fast_response, 'en'), /last 30 days.*within an hour.*10 or more conversations/);
  assert.match(ruleSentence('fast_response', DEFAULT_RULE_PARAMS.fast_response, 'ckb'), /30 ڕۆژی ڕابردوودا.*کاتژمێرێکدا.*10 گفتوگۆ/);
  // The owner moves the numbers on the server: the words follow the same night.
  const tuned = { window_days: 14, median_within_minutes: 30, min_threads: 12 };
  assert.match(ruleSentence('fast_response', tuned, 'ar'), /آخر 14 يومًا.*خلال نصف ساعة.*12 محادثة/);
  assert.match(ruleSentence('fast_response', tuned, 'en'), /last 14 days.*within half an hour.*12 or more/);
  assert.match(ruleSentence('reliable_seller', { window_days: 90, min_completed: 25, max_merchant_cancel_percent: 2, max_disputes_lost: 0 }, 'ar'), /25 طلبًا.*90 يومًا.*2٪.*لم يخسر أي نزاع/);
  assert.match(ruleSentence('reliable_seller', { max_disputes_lost: 1 }, 'en'), /lost no more than 1 disputes/);
  assert.match(ruleSentence('high_completion', null, 'en'), /at least 95% of its orders in the last 90 days, across 20 or more orders/);
  assert.match(ruleSentence('custom_specialist', null, 'ar'), /يستقبل طلبات الطباعة المخصصة، وأنجز 10 طلبات/);
  assert.match(ruleSentence('verified_merchant', null, 'ckb'), /Levonis/);
  // The counted nouns and the durations the rules use.
  assert.deepEqual([1, 2, 3, 10, 11, 30, 100, 103].map((n) => arCount(n, { one: 'يوم واحد', two: 'يومان', few: 'أيام', many: 'يومًا', hundred: 'يوم' })), [
    'يوم واحد', 'يومان', '3 أيام', '10 أيام', '11 يومًا', '30 يومًا', '100 يوم', '103 أيام',
  ]);
  assert.deepEqual([15, 30, 60, 120, 240, 480, 1440].map((m) => withinWords(m, 'ar')), ['ربع ساعة', 'نصف ساعة', 'ساعة', 'ساعتين', '4 ساعات', '8 ساعات', 'يوم']);
  assert.deepEqual([30, 60, 120, 1440].map((m) => withinWords(m, 'en')), ['half an hour', 'an hour', '2 hours', 'a day']);
  assert.equal(respondsWithin(60, 'ar'), 'يرد عادةً خلال ساعة');
  assert.equal(respondsWithin(240, 'en'), 'Usually replies within 4 hours');
  assert.equal(respondsWithin(1440, 'ckb'), 'بە زۆری لە ماوەی ڕۆژێکدا وەڵام دەداتەوە');
});

// ------------------------------------------------------------------ the chips

test('at most three chips — known keys only, in the catalogue\'s order, the verification left to its host; none draws nothing', () => {
  assert.deepEqual(visibleBadges(ALL).map((b) => b.key), ['verified_merchant', 'fast_response', 'reliable_seller']);
  assert.deepEqual(chipBadges(ALL).map((b) => b.key), ['fast_response', 'reliable_seller', 'custom_specialist'], 'the hosts already draw the verification');
  const out = html(createElement(BadgeChips, { badges: ALL }));
  const keys = attrs(out, 'data-badge-chip');
  assert.deepEqual(keys, ['fast_response', 'reliable_seller', 'custom_specialist'], 'three, in order');
  assert.doesNotMatch(out, /mystery_badge/, 'an unknown key is skipped, never drawn as its key');
  assert.match(out, /aria-label="شارات الثقة"/, 'the list is named');
  assert.equal(attrs(out, 'aria-expanded').filter((v) => v === 'false').length, 3, 'each chip is a closed question');
  assert.equal(attrs(out, 'aria-haspopup').filter((v) => v === 'dialog').length, 3);
  assert.equal(attrs(out, 'title').filter((v) => v === 'لماذا؟').length, 3, '«لماذا؟» on each chip');
  assert.match(text(out), /يرد بسرعة.*بائع موثوق.*متخصص بالطباعة حسب الطلب/);
  assert.doesNotMatch(text(out), /تاجر موثّق/, 'one mark for «verified»: the host\'s');
  assert.equal(attrs(out, 'data-badge-chip').length, 3);
  assert.equal(html(createElement(BadgeChips, { badges: [] })), '', 'no badge, no row');
  assert.equal(html(createElement(BadgeChips, { badges: [{ key: 'nope' }] })), '', 'only unknown keys, no row');
  assert.equal(html(createElement(BadgeChips, { badges: null })), '');
  assert.equal(html(createElement(BadgeChips, { badges: [{ key: 'verified_merchant', since: '2026-01-05' }] })), '', 'only the verification: its host already says it');
  // Two chips when the card carries two; a smaller max is honoured.
  assert.equal(attrs(html(createElement(BadgeChips, { badges: ALL, max: 1 })), 'data-badge-chip').length, 1);
  assert.match(html(createElement(BadgeChips, { badges: ALL }), 'en'), /Fast response.*Reliable seller.*Custom printing specialist/);
  assert.match(html(createElement(BadgeChips, { badges: ALL }), 'ckb'), /وەڵامدانەوەی خێرا/);
  for (const k of BADGE_KEYS) assert.ok(BADGE_ICONS[k], `${k} has an icon`);
});

test('the store tone wears the island\'s ink: no app tokens, 44 px targets, the row the hero reserves', () => {
  const out = html(createElement(BadgeChips, { badges: ALL, tone: 'store' }));
  assert.match(out, /data-badge-chips="store"/);
  assert.doesNotMatch(out, /bg-surface|text-text-|border-border-subtle|text-gold/, 'the storefront never wears the app\'s tokens');
  assert.match(out, /border-white\/10/);
  assert.equal((out.match(/lv-hit/g) ?? []).length, 3, 'every chip grows its target to 44 px');
  assert.match(out, /class="-mx-4 -my-2 flex h-11 items-center[^"]*overflow-x-auto/, 'one line, sideways on a phone, its target not clipped');
  const app = html(createElement(BadgeChips, { badges: ALL }));
  assert.match(app, /data-badge-chips="app"/);
  assert.match(app, /border-border-subtle bg-surface/);
  // A chip is ONE line at its 28 px height — a long Sorani name never wraps
  // inside the pill: the store's row scrolls; an app card's chip ellipsizes.
  for (const row of [out, app]) {
    assert.equal((row.match(/<button[^>]*class="[^"]*\bh-7\b[^"]*\bwhitespace-nowrap\b/g) ?? []).length, 3, 'every chip is one line');
    assert.equal((row.match(/<span class="truncate">/g) ?? []).length, 3, 'its name ends in an ellipsis before it wraps');
  }
  assert.equal((app.match(/<li class="min-w-0 max-w-full">/g) ?? []).length, 3, 'an app chip may shrink to its card');
  assert.doesNotMatch(out, /<li class=/, 'a store chip keeps its width: the row scrolls instead');
});

test('«لماذا؟» says the badge, the rule, since when, and where all five are explained', () => {
  const badge = { key: 'fast_response' as const, since: '2026-09-10' };
  const ar = html(createElement(WhyPanel, { badge, tone: 'app', lang: 'ar' }));
  assert.match(text(ar), /يرد بسرعة لماذا؟ في آخر 30 يومًا، جاء نصف ردوده الأولى على الأقل خلال ساعة/);
  assert.match(text(ar), /تحمله منذ/);
  const about = (h: string) => h.match(/<a[^>]*data-badge-about[^>]*>/)?.[0] ?? '';
  assert.match(about(ar), /href="\/community\/badges#fast_response"/, 'a route of this app');
  assert.match(ar, /data-badge-rule/);
  // The published numbers when the catalogue has answered.
  const tuned = html(createElement(WhyPanel, { badge, tone: 'app', lang: 'en', params: { window_days: 14, median_within_minutes: 30, min_threads: 12 } }));
  assert.match(text(tuned), /Why\? Over the last 14 days, at least half of its first replies came within half an hour, across 12 or more conversations\./);
  assert.match(text(tuned), /Held since/);
  const ckb = html(createElement(WhyPanel, { badge, tone: 'app', lang: 'ckb' }));
  assert.match(text(ckb), /بۆچی؟/);
  assert.match(text(ckb), /دەربارەی نیشانەکان/);
  // On a store's own host the page is on the platform's origin — a real navigation.
  const hosted = html(createElement(WhyPanel, { badge, tone: 'store', lang: 'ar', origin: 'https://levonis-iq.com' }));
  assert.match(about(hosted), /href="https:\/\/levonis-iq\.com\/community\/badges#fast_response"/);
  assert.doesNotMatch(hosted, /text-text-|bg-surface/, 'the store popover wears the island\'s ink');
  assert.equal(badgeHref('reliable_seller'), '/community/badges#reliable_seller');
  // No evidence ever reaches the public popover.
  assert.doesNotMatch(code('src/components/community/reputation/BadgeChips.tsx'), /evidence/);
});

test('the catalogue is asked once per page, and again only after a failure', async () => {
  resetBadgeRules();
  let calls = 0;
  let fail = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, '/api/community/badges');
    calls += 1;
    if (fail) return new Response(JSON.stringify({ success: false, code: 'COMMUNITY_CLOSED' }), { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ success: true, badges: [{ key: 'fast_response', rule_params: { window_days: 14, median_within_minutes: 30, min_threads: 12 } }, { key: 'not_a_badge', rule_params: {} }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  assert.equal(await loadRules(), null, 'a refused catalogue is null — the published numbers stand');
  fail = false;
  const [a, b] = await Promise.all([loadRules(), loadRules()]);
  assert.equal(calls, 2, 'one retry, shared by two askers');
  assert.equal(a, b);
  assert.deepEqual(a?.get('fast_response'), { window_days: 14, median_within_minutes: 30, min_threads: 12 });
  assert.equal(a?.has('not_a_badge' as never), false, 'unknown keys are dropped');
  await loadRules();
  assert.equal(calls, 2, 'answered from the page\'s memory');
  resetBadgeRules();
});

// ------------------------------------------------------------------ the page

test('/community/badges explains every badge in the reader\'s language — three languages', () => {
  const want: Record<'ar' | 'en' | 'ckb', RegExp[]> = {
    ar: [/شارات الثقة/, /تُحسب كل ليلة/, /لا تُشترى/, /تاجر موثّق/, /يرد بسرعة/, /بائع موثوق/, /متخصص بالطباعة حسب الطلب/, /نسبة إنجاز عالية/, /القاعدة/],
    en: [/Trust badges/, /computed every night/, /can’t be bought/, /Verified merchant/, /Fast response/, /Reliable seller/, /Custom printing specialist/, /High completion rate/, /The rule/],
    ckb: [/نیشانەکانی متمانە/, /هەموو شەوێک/, /ناکڕدرێن/, /بازرگانی پشتڕاستکراو/, /وەڵامدانەوەی خێرا/, /فرۆشیاری متمانەپێکراو/, /پسپۆڕی چاپی تایبەت/, /ڕێژەی تەواوکردنی بەرز/, /یاساکە/],
  };
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const out = html(createElement(BadgesPage), lang, '/community/badges#reliable_seller');
    const t = text(out);
    for (const re of want[lang]) assert.match(t, re, `${lang}: ${re}`);
    assert.deepEqual(attrs(out, 'data-badge'), [...BADGE_KEYS], `${lang}: all five, in order`);
    assert.equal((out.match(/data-badge-rule/g) ?? []).length, 5, `${lang}: a rule under each`);
    for (const k of BADGE_KEYS) assert.ok(t.includes(ruleSentence(k, null, lang).replace(/\s+/g, ' ')), `${lang}: the rule of ${k}`);
    assert.deepEqual(attrs(out, 'id').filter((id) => (BADGE_KEYS as readonly string[]).includes(id)), [...BADGE_KEYS], 'each badge is an anchor');
    assert.match(out, /<li[^>]*id="reliable_seller"[^>]*aria-current="true"[^>]*class="[^"]*bg-surface-selected/, `${lang}: #reliable_seller is the one marked`);
    assert.equal((out.match(/aria-current="true"/g) ?? []).length, 1, 'one selection cue');
    assert.equal((out.match(/<h1/g) ?? []).length, 1, 'one h1');
  }
});

// ------------------------------------------------------------------ the merchant

const REP: MerchantReputation = {
  badges: [
    { key: 'fast_response', since: '2026-09-20', evidence: { median_within_minutes: 60, threads: 14, window_days: 30 } },
    { key: 'reliable_seller', since: '2026-08-01', evidence: { completed: 23, merchant_cancel_percent: 2, disputes_lost: 0, window_days: 90 } },
  ],
  responds_within_minutes: 60,
  metrics: {
    window_30: { window_days: 30, first_reply_count: 14, median_within_minutes: 60, first_reply_avg_minutes: 41, orders_completed: 9, custom_orders_completed: 4, orders_cancelled_by_merchant: 0, disputes_lost: 0, orders_ended: 9, merchant_cancel_percent: 0, completion_percent: 100 },
    window_90: { window_days: 90, first_reply_count: 30, median_within_minutes: 120, first_reply_avg_minutes: 70, orders_completed: 23, custom_orders_completed: 7, orders_cancelled_by_merchant: 1, disputes_lost: 0, orders_ended: 24, merchant_cancel_percent: 4, completion_percent: null },
  },
  rules: { ...DEFAULT_RULE_PARAMS } as MerchantReputation['rules'],
  through: '2026-09-29',
};

test('«سمعتك»: the evidence that earned each badge, how far from the rest, the two windows', () => {
  const s = reputationStrings('ar');
  assert.deepEqual(evidenceFigures(REP.badges[0], s, 'ar'), [
    { figure: 'ساعة', label: 'نصف ردودك الأولى خلال', labelFirst: true },
    { figure: '14', label: 'محادثات' },
  ]);
  assert.equal(evidenceFigures(REP.badges[0], reputationStrings('ckb'), 'ckb')[0].figure, 'کاتژمێرێکدا', 'Sorani closes «لە ماوەی …دا»');
  assert.deepEqual(evidenceFigures(REP.badges[1], s, 'en').map((f) => f.figure), ['23', '2%', '0']);
  assert.deepEqual(progressOf('custom_specialist', REP), { have: 7, need: 10 });
  assert.deepEqual(progressOf('high_completion', REP), { have: 24, need: 20 });
  assert.equal(progressOf('verified_merchant', REP), null, 'nothing to count toward');
  const out = html(createElement(ReputationBody, { data: REP, lang: 'ar' }));
  const t = text(out);
  assert.deepEqual(attrs(out, 'data-reputation-badge'), ['fast_response', 'reliable_seller', 'verified_merchant', 'custom_specialist', 'high_completion'], 'earned first, then the rest, each in the catalogue order');
  assert.deepEqual(attrs(out, 'data-earned'), ['yes', 'yes', 'no', 'no', 'no']);
  assert.match(t, /شاراتك/);
  assert.match(t, /لم تكسبها بعد/);
  assert.match(t, /يرد عادةً خلال ساعة/, 'the store line the customers read');
  assert.deepEqual(attrs(out, 'data-reputation-progress'), ['7/10'], 'how far — while the count is what is missing');
  assert.match(t, /7 من 10/);
  assert.doesNotMatch(t, /24 من 20|20 من 20/, 'a count already met is not drawn as progress: the rule says what else is missing');
  assert.match(t, /نصف ردودك الأولى خلال ساعة/, 'the median reads in its own order');
  assert.match(t, /آخر 30 يومًا.*آخر 90 يومًا/, 'the windows');
  assert.match(t, /ساعتين/, 'the 90-day median');
  assert.match(t, /—/, 'a rate over nothing is a dash, never 0');
  assert.match(t, /حتى .*2026/, 'through when');
  // Under ten conversations there is no «يرد عادةً» line, and the page says why.
  const fresh = html(createElement(ReputationBody, { data: { ...REP, badges: [], responds_within_minutes: null }, lang: 'en' }));
  assert.match(text(fresh), /No badges yet/);
  assert.match(text(fresh), /The “usually replies” line appears once at least 10 conversations are counted/);
  assert.match(html(createElement(ReputationBody, { data: REP, lang: 'ckb' })), /ناوبانگ|نیشانەکانت/);
});

// ------------------------------------------------------------------ the pins

test('the hero, the directory card and the creator page load the chips lazily — only for a store with one', () => {
  const hero = code('src/components/storefront/blocks/Hero.tsx');
  assert.match(hero, /const BadgeChips = lazy\(\(\) => import\('\.\.\/\.\.\/community\/reputation\/BadgeChips'\)\);/);
  assert.doesNotMatch(hero, /^import[^;]*reputation/m, 'no static import on the storefront (47 KB budget)');
  assert.match(hero, /return badges\?\.some\(\(b\) => b\.key !== 'verified_merchant'\) \? \(/, 'fetched only for a store with a chip to draw');
  assert.match(hero, /<Suspense fallback=\{<div className="h-7" \/>\}>/, 'the row\'s frame is held while the chunk lands');
  assert.match(hero, /<BadgeChips badges=\{badges\} tone="store" \/>/);
  assert.equal((hero.match(/<HeroBadges store=\{store\} \/>/g) ?? []).length, 2, 'under every hero variant');
  const card = code('src/components/community/hub/StoreCard.tsx');
  assert.match(card, /const BadgeChips = lazy\(\(\) => import\('\.\.\/reputation\/BadgeChips'\)\);/);
  assert.match(card, /hasEarned && \(/);
  assert.match(card, /visibleBadges\(earned\)\.some\(\(b\) => b\.key !== 'verified_merchant'\)/);
  assert.match(card, /<BadgeChips badges=\{earned\} className="z-10 w-fit max-w-full" \/>/, 'above the card\'s stretched link, no wider than its chips');
  // The card's last row, its whole width: the card wraps, the row takes the whole line.
  assert.match(card, /className="relative flex min-w-0 flex-wrap items-start gap-3/);
  assert.match(card, /<div className="basis-full">\s*<Suspense fallback=\{<div className="h-7" aria-hidden="true" \/>\}>\s*<BadgeChips badges=\{earned\}/);
  const creator = code('src/pages/community/Creator.tsx');
  assert.match(creator, /const BadgeChips = React\.lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/reputation\/BadgeChips'\)\);/);
  assert.match(creator, /creator\.store as \{ badges\?/);
  // «سمعتك» is a lazy chunk of the analytics screen, shown PLUS or not.
  const analytics = code('src/components/merchant/shell/sections/AnalyticsSection.tsx');
  assert.match(analytics, /const ReputationCard = lazy\(\(\) => import\('\.\.\/\.\.\/analytics\/ReputationCard'\)\);/);
  assert.equal((analytics.match(/<ReputationCard \/>/g) ?? []).length, 2, 'in the report and beside the PLUS notice');
});
