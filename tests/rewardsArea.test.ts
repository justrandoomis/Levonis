/**
 * «المكافآت» — THE REWARDS AREA'S FRAME (rewards spec §1.1, §2.1, §2.3, §11).
 *
 * Source assertions on the routes and the frame — this repository has no
 * browser runner, and what is pinned here is structural (which block, which
 * element, which navigation kind) — and the reads themselves, driven through
 * the real api client against a fake `fetch`: loading, ready, stale, the
 * 404, paging, the BAD_CURSOR restart, cancellation and invalidation.
 *
 * Run: node --import tsx --test tests/rewardsArea.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../src/lib/api';
import {
  DETAIL_SPEC,
  HUB_KEY,
  HUB_SPEC,
  LIST_SPEC,
  ListStore,
  ReadStore,
  STALE_AFTER_MS,
  RELOAD_SOON_MS,
  dedupeById,
  detailPath,
  detailState,
  listKey,
  listPath,
  seededDetail,
  skewOf,
  type CompetitionSeed,
  type DetailExtra,
  type Slot,
} from '../src/components/rewards/useRewardsData';
import type { Competition, CompetitionDetailResponse } from '../src/components/rewards/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code only: a comment that names a banned call must not fail the test that bans it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const ROUTES = [
  '/rewards',
  '/rewards/coupons',
  '/rewards/shop',
  '/rewards/rate',
  '/rewards/competitions',
  '/rewards/competitions/:id',
  '/rewards/*',
];

/** The area's files: src/pages/RewardsArea.tsx and everything under src/components/rewards. */
function areaFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(ROOT, rel))) {
      const child = `${rel}/${name}`;
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (/\.tsx?$/.test(name)) out.push(child);
    }
  };
  walk('src/components/rewards');
  out.push('src/pages/RewardsArea.tsx');
  return out;
}

// ------------------------------------------------------------ src/App.tsx (§1.1)

test('the area is one lazy chunk of its own, never prefetched (an account surface)', () => {
  const app = code('src/App.tsx');
  assert.match(
    app,
    /const Rewards = React\.lazy\(\(\) => import\('\.\/pages\/Rewards'\)\);\s*const RewardsArea = React\.lazy\(\(\) => import\('\.\/pages\/RewardsArea'\)\);/,
    'declared right after the /points chunk'
  );
  assert.equal((app.match(/import\('\.\/pages\/RewardsArea'\)/g) ?? []).length, 1, 'one dynamic import');
  assert.doesNotMatch(app, /prefetchable\(\(\) => import\('\.\/pages\/RewardsArea'\)\)/, 'not fetched on idle');
  assert.doesNotMatch(app, /RewardsArea\.prefetch|from '\.\/pages\/RewardsArea'/, 'no prefetch and no static import into the entry');
});

test('/rewards is a full-screen prefix beside /points; /games and /leaderboards stay together', () => {
  const app = code('src/App.tsx');
  const listed = /const isFullScreenRoute = \[([^\]]+)\]/.exec(app);
  assert.ok(listed, 'the full-screen prefix list moved — update this check, do not delete it');
  assert.match(listed[1], /'\/points', '\/rewards'/);
  assert.match(listed[1], /'\/games', '\/leaderboards'/);
  assert.match(app, /\.some\(p => pathForShell === p \|\| pathForShell\.startsWith\(p \+ '\/'\)\) && !isMerchantStart;/);
});

test('the seven addresses are literal routes of the full-screen block, one element each, open to guests', () => {
  const app = code('src/App.tsx');
  const start = app.indexOf('if (isFullScreenRoute) {');
  const end = app.indexOf('const navHidden = isBottomNavHidden');
  assert.ok(start > 0 && end > start, 'the full-screen shell block moved');
  const full = app.slice(start, end);
  const rest = app.slice(end);
  assert.deepEqual(
    [...full.matchAll(/<Route path="([^"]+)" element=\{<RewardsArea \/>\} \/>/g)].map((m) => m[1]),
    ROUTES,
    'exactly the seven, in order, each `<Route path="X"` with one space (tests/serviceSlots.test.ts parses that)'
  );
  assert.equal((full.match(/<RewardsArea \/>/g) ?? []).length, ROUTES.length, 'the element appears nowhere else in the block');
  assert.match(full, /<Route path="\/points" element=\{<Rewards \/>\} \/>\s*<Route path="\/rewards" element=\{<RewardsArea \/>\} \/>/, 'right after /points');
  assert.doesNotMatch(rest, /RewardsArea|path="\/rewards/, 'the main block never sees a full-screen path');
  assert.doesNotMatch(app, /<ProtectedRoute>\s*<RewardsArea/, 'no guard: each page shows its own sign-in state');
});

test('App.tsx keeps exactly five ChunkBoundary', () => {
  assert.equal((read('src/App.tsx').match(/<ChunkBoundary\b/g) ?? []).length, 5);
});

// ------------------------------------------------------------ the frame (§2.1, §1.3, §1.4)

test('the frame: useGoBack, never navigate(-1), its header carries the mascot anchor, its test id, REPLACE for the tabs and the filter', () => {
  const page = code('src/pages/RewardsArea.tsx');
  const chrome = code('src/components/rewards/AreaChrome.tsx');
  assert.match(page, /const goBack = useGoBack\(PARENT\[section\]\);/);
  for (const [name, src] of [['RewardsArea.tsx', page], ['AreaChrome.tsx', chrome]] as const) {
    assert.doesNotMatch(src, /navigate\(\s*-1\s*\)/, `${name}: Back from a shared link would leave the shop`);
  }
  assert.match(page, /data-testid="rewards-area"/);
  assert.match(page, /<AreaHeader title=\{t\(TITLE\[section\]\)\} onBack=\{goBack\} wide=\{section === 'competition'\} titleRef=\{titleRef\}>/);
  assert.equal(
    (chrome.match(/<MotionCharacterHome kind="top-header" compact \/>/g) ?? []).length,
    1,
    "AreaHeader renders the page's mascot anchor, so the shell's fallback strip is not drawn"
  );
  assert.match(chrome, /<h1 ref=\{titleRef\} tabIndex=\{-1\}/);

  // Links push; the frame's own navigations are the tabs and the filter, and
  // each REPLACES: Back leaves the page, not the tab.
  const navigations = [...page.matchAll(/\bnavigate\(([\s\S]*?)\);/g)].map((m) => m[1].trim());
  assert.ok(navigations.length >= 2, `the tabs and the filter navigate: ${navigations.join(' | ')}`);
  for (const args of navigations) assert.match(args, /, \{ replace: true \}$/, `the frame navigates without replace: ${args}`);
  assert.match(page, /navigate\(next === 'results' \? '\/rewards\/competitions\?view=results' : '\/rewards\/competitions', \{ replace: true \}\);/);
  assert.match(page, /navigate\('\/rewards\/competitions\?view=results' \+ \(on \? '&mine=1' : ''\), \{ replace: true \}\);/);
});

test('the frame keeps its own scroll memory and focus, one keyed scroller, and the CTA slot outside it', () => {
  const page = code('src/pages/RewardsArea.tsx');
  assert.match(page, /^const OFFSETS = new Map<string, number>\(\);$/m, 'module-level, so a remounted area finds it');
  assert.match(page, /const OFFSETS_MAX = 40;/);
  assert.match(page, /const RESTORE_WINDOW_MS = 2_000;/);
  assert.match(
    page,
    /<div key=\{screenKey\} ref=\{scroller\} onScroll=\{saveOffset\} data-rewards-scroll className="flex-1 min-h-0 overflow-y-auto overscroll-contain">/
  );
  assert.match(page, /saveFrame\.current = requestAnimationFrame\(/, 'the offset write is rAF-throttled');
  assert.match(page, /navigationType === 'POP' \? \{ key: location\.key, at: Date\.now\(\), done: false \} : null/);
  assert.match(page, /if \(navigationType === 'PUSH'\) titleRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(page, /if \(same && navigationType === 'REPLACE'\) scroller\.current\?\.scrollTo\(\{ top: 0 \}\);/);
  assert.match(page, /if \(section === 'competitions' && lastOpened\.current\) focusRow\(el, lastOpened\.current\);/);
  assert.match(page, /<p role="status" aria-live="polite" className="sr-only">\s*\{announcement\}\s*<\/p>/);
  assert.match(
    page,
    /\{related && <RelatedDoors current=\{related\} \/>\}\s*<\/div>\s*<\/div>\s*<div ref=\{setCtaSlot\} data-rewards-cta-slot className="shrink-0" \/>/,
    'the bar is portalled after the scroller, so it never covers content'
  );
  assert.doesNotMatch(page, /\bfixed\b|min-h-screen|bg-canvas/, 'no fixed bar, no page wrapper: the shell paints the canvas');
});

test('personal reads run only for a signed-in customer, each on its own pages', () => {
  const page = code('src/pages/RewardsArea.tsx');
  assert.match(page, /const authed = authLoaded && isAuthenticated;/);
  assert.match(page, /useRewardsHub\(authed && HUB_SECTIONS\.has\(section\)\)/);
  assert.match(page, /const HUB_SECTIONS: ReadonlySet<Section> = new Set<Section>\(\['home', 'coupons', 'shop', 'rate'\]\);/);
  assert.match(page, /useCompetitionsList\(authed && onList, view, mine\)/);
  assert.match(page, /useCompetition\(id, authed && section === 'competition' && id !== undefined, seed\)/);
});

test('one h1 per screen: only the header draws it', () => {
  for (const f of areaFiles()) {
    if (f === 'src/components/rewards/AreaChrome.tsx') continue;
    assert.doesNotMatch(code(f), /<h1\b/, `${f} draws a second h1`);
  }
});

// ------------------------------------------------------------ the whole area (§11 items 6 and 7)

test('no area file reaches for a page snapshot, the DOM by id, a scroll-into-view, the hash or an ?enter link', () => {
  const files = areaFiles();
  for (const f of ['src/pages/RewardsArea.tsx', 'src/components/rewards/useRewardsData.ts', 'src/components/rewards/AreaChrome.tsx']) {
    assert.ok(files.includes(f) && existsSync(join(ROOT, f)), `${f} is an area file`);
  }
  const bad: string[] = [];
  for (const f of files) {
    const src = code(f);
    for (const banned of ['pageCache', 'getElementById(', 'scrollIntoView', 'location.hash', 'enter=1']) {
      if (src.includes(banned)) bad.push(`${f}: ${banned}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the area decides nothing: no balance comparison, no fee or review-points arithmetic', () => {
  const bad: string[] = [];
  for (const f of areaFiles()) {
    const src = code(f);
    for (const re of [/\b(point_balance|balance)\s*[<>]=?/, /entry_points\s*-/, /review_points\s*\*/]) {
      const m = re.exec(src);
      if (m) bad.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [], 'gates, shortfalls, holdings and the no-level points come from the server');
});

test('a refusal that changes the gate turns entering off in both windows, and the refusal (else the gate) says why (§3.7)', () => {
  const src = code('src/components/rewards/EntrySheet.tsx');
  const at = src.indexOf('export function EntryConfirm(');
  assert.ok(at > 0, 'EntryConfirm moved — update this check, do not delete it');
  const [sheet, confirm] = [src.slice(0, at), src.slice(at)];
  // The sheet: its send.
  assert.match(sheet, /const gateNo = !!gate && gate\.can_enter !== true;/);
  assert.match(sheet, /const reason = alert \?\? \(gateNo && gateKey \? t\(gateKey\) : null\);/);
  assert.match(sheet, /disabled=\{gateNo\}/);
  // The one-tap dialog: its «شارك», never pressable again into the same refusal.
  assert.match(confirm, /const gateNo = !!c\.gate && c\.gate\.can_enter !== true;/);
  assert.match(confirm, /const reason = error \?\? \(gateNo && gateKey \? t\(gateKey\) : null\);/);
  assert.match(confirm, /error=\{reason\}\s*confirmDisabled=\{gateNo\}/);
  assert.match(confirm, /if \(refusal\.to === 'alert' && refusal\.regate\) void reload\(\);/, 'the gate is read again after such a refusal');
});

test('the old stacked hub is gone (spec §10), and nothing imports it', () => {
  for (const f of ['src/components/rewards/RewardsHub.tsx', 'src/components/rewards/CompetitionCard.tsx']) {
    assert.equal(existsSync(join(ROOT, f)), false, `${f} is back: /points is the old points page again, and the rewards have pages of their own`);
  }
  const importer = /(?:from|import\()\s*'[^']*\/(RewardsHub|CompetitionCard)'/;
  const walk = (rel: string, out: string[] = []): string[] => {
    for (const name of readdirSync(join(ROOT, rel))) {
      const child = `${rel}/${name}`;
      if (statSync(join(ROOT, child)).isDirectory()) walk(child, out);
      else if (/\.tsx?$/.test(name)) out.push(child);
    }
    return out;
  };
  assert.deepEqual(walk('src').filter((f) => importer.test(read(f))), []);
});

// ------------------------------------------------------------ the reads (§2.3), against a fake server

interface Reply {
  status?: number;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with `handler`, honouring the request's abort signal as a real fetch does. Returns the paths asked. */
function serve(handler: (path: string) => Reply | Promise<Reply>): string[] {
  const asked: string[] = [];
  globalThis.fetch = ((input: unknown, init: RequestInit = {}) => {
    const path = String(input);
    asked.push(path);
    const signal = init.signal;
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort);
      Promise.resolve(handler(path)).then((reply) => {
        const status = reply.status ?? 200;
        resolve({ ok: status < 400, status, json: async () => reply.body } as unknown as Response);
      }, reject);
    });
  }) as typeof fetch;
  return asked;
}

function deferred<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const SERVER_TIME = '2031-06-15T10:00:00.000Z';
const comp = (id: string) => ({ id, phase: 'finished' }) as unknown as Competition;
const hubAnswer = () => ({ success: true, installed: true, server_time: SERVER_TIME, point_balance: 120, coupons: [], printers: [], shop: [], competitions: [] });
const listAnswer = (ids: string[], next: string | null, counts = { current: 2, results: 25 }) => ({
  success: true,
  installed: true,
  server_time: SERVER_TIME,
  point_balance: 120,
  view: 'results',
  counts,
  competitions: ids.map(comp),
  next_cursor: next,
});
const refusal = (status: number, code: string): Reply => ({ status, body: { success: false, error: code, code } });

test('the addresses: one list key per view (mine only with the results), the detail id encoded, the skew from the server', () => {
  assert.equal(listKey('current', false), 'current');
  assert.equal(listKey('current', true), 'current', '«مشاركاتي فقط» exists only with the results');
  assert.equal(listKey('results', false), 'results');
  assert.equal(listKey('results', true), 'results:mine');
  assert.equal(listPath('current'), '/api/rewards/program/competitions?view=current');
  assert.equal(listPath('results'), '/api/rewards/program/competitions?view=results');
  assert.equal(listPath('results:mine'), '/api/rewards/program/competitions?view=results&mine=1');
  assert.equal(detailPath('cmp_1'), '/api/rewards/program/competitions/cmp_1');
  assert.equal(detailPath('a/b'), '/api/rewards/program/competitions/a%2Fb');
  const now = Date.parse('2031-06-15T09:00:00.000Z');
  assert.equal(skewOf(SERVER_TIME, now), 3_600_000, 'a device an hour slow');
  assert.equal(skewOf('not a time', now), 0);
  assert.equal(skewOf(undefined, now), 0);
  assert.equal(STALE_AFTER_MS, 60_000);
  assert.equal(RELOAD_SOON_MS, 1_500);
  assert.deepEqual(dedupeById([[comp('a'), comp('b')], [comp('b'), comp('c')], []]).map((c) => c.id), ['a', 'b', 'c']);
});

test('a read: loading, then ready with the skew; a failed re-read keeps the data and says stale; a success clears it', async () => {
  let fail = false;
  const asked = serve(() => (fail ? refusal(503, 'SERVICE_BUSY') : { body: hubAnswer() }));
  const store = new ReadStore(HUB_SPEC, 'u1');
  const heard: number[] = [];
  store.subscribe(() => heard.push(store.getVersion()));

  const first = store.fetch(HUB_KEY);
  assert.equal(store.slot(HUB_KEY).status, 'loading');
  assert.equal(store.busy(HUB_KEY), true);
  await first;
  const ready = store.slot(HUB_KEY);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.data?.point_balance, 120);
  assert.ok(Math.abs(ready.skewMs - (Date.parse(SERVER_TIME) - Date.now())) < 60_000, 'the server clock minus the device clock');
  assert.ok(ready.settledAt > 0);
  assert.deepEqual(asked, ['/api/rewards/program']);
  assert.ok(heard.length >= 2, 'subscribers hear each change');

  fail = true;
  await store.fetch(HUB_KEY);
  const stale = store.slot(HUB_KEY);
  assert.equal(stale.status, 'ready', 'still drawn');
  assert.equal(stale.stale, true);
  assert.equal(stale.data?.point_balance, 120, 'the old data stays');
  assert.ok(stale.error instanceof ApiError && stale.error.status === 503);

  fail = false;
  await store.fetch(HUB_KEY);
  assert.equal(store.slot(HUB_KEY).stale, false);
  assert.equal(store.slot(HUB_KEY).error, null);
});

test('a first read that fails is an error with no data, and the next read starts from loading', async () => {
  serve(() => refusal(500, 'SERVICE_SETUP'));
  const store = new ReadStore(HUB_SPEC, 'u1');
  await store.fetch(HUB_KEY);
  assert.equal(store.slot(HUB_KEY).status, 'error');
  assert.equal(store.slot(HUB_KEY).data, null);
  assert.equal(store.slot(HUB_KEY).stale, false);
  serve(() => ({ body: hubAnswer() }));
  const again = store.fetch(HUB_KEY);
  assert.equal(store.slot(HUB_KEY).status, 'loading');
  await again;
  assert.equal(store.slot(HUB_KEY).status, 'ready');
});

test('the detail: a 404 is notFound (even after data), and a later answer clears it', async () => {
  let answer: Reply = refusal(404, 'NOT_FOUND');
  const asked = serve(() => answer);
  const store = new ReadStore(DETAIL_SPEC, 'u1');
  await store.fetch('cmp_1');
  assert.equal(store.slot('cmp_1').x.notFound, true);
  assert.equal(store.slot('cmp_1').status, 'error');
  assert.deepEqual(asked, ['/api/rewards/program/competitions/cmp_1']);

  answer = { body: { success: true, server_time: SERVER_TIME, point_balance: 0, competition: comp('cmp_1') } };
  await store.fetch('cmp_1');
  assert.equal(store.slot('cmp_1').x.notFound, false);
  answer = refusal(404, 'NOT_FOUND');
  await store.fetch('cmp_1');
  assert.equal(store.slot('cmp_1').x.notFound, true, 'withdrawn while open: the 404 wins over the data');
  answer = refusal(503, 'SERVICE_BUSY');
  await store.fetch('cmp_1');
  assert.equal(store.slot('cmp_1').x.notFound, true, 'a network failure does not undo a 404');
  assert.equal(store.slot('cmp_2').status, 'idle', 'one slot per id');
});

test('the seed draws the competition at once; its own answer replaces it; a failed read marks it stale; a 404 wins', () => {
  const seed: CompetitionSeed = { competition: comp('cmp_1'), server_time: SERVER_TIME, point_balance: 70, skewMs: 1234 };
  assert.equal(seededDetail(seed, 'cmp_2'), null, 'a seed for another competition is ignored');
  assert.equal(seededDetail(null, 'cmp_1'), null);
  const seeded = seededDetail(seed, 'cmp_1');
  assert.ok(seeded);
  assert.equal(seeded.data.competition.id, 'cmp_1');
  assert.equal(seeded.data.server_time, SERVER_TIME, 'dated by the clock of the answer the row came in');
  assert.equal(seeded.data.point_balance, 70);

  const slot = (over: Partial<Slot<CompetitionDetailResponse, DetailExtra>>): Slot<CompetitionDetailResponse, DetailExtra> => ({
    status: 'loading',
    data: null,
    error: null,
    stale: false,
    skewMs: 0,
    settledAt: 0,
    invalid: false,
    x: { notFound: false },
    ...over,
  });
  const loading = detailState(slot({}), 'cmp_1', seeded);
  assert.equal(loading.status, 'ready');
  assert.equal(loading.data?.competition.id, 'cmp_1');
  assert.equal(loading.skewMs, 1234);
  assert.equal(loading.stale, false);

  const failed = detailState(slot({ status: 'error', error: new ApiError(503, 'busy') }), 'cmp_1', seeded);
  assert.equal(failed.status, 'ready');
  assert.equal(failed.stale, true, 'the seed is shown with the StaleLine');

  const gone = detailState(slot({ status: 'error', x: { notFound: true } }), 'cmp_1', seeded);
  assert.equal(gone.notFound, true);
  assert.equal(gone.data, null, 'the seed is not shown over a 404');

  const own: CompetitionDetailResponse = { success: true, server_time: SERVER_TIME, point_balance: 5, competition: comp('cmp_1') };
  const answered = detailState(slot({ status: 'ready', data: own, skewMs: 9 }), 'cmp_1', seeded);
  assert.equal(answered.data, own);
  assert.equal(answered.skewMs, 9);
  assert.equal(detailState(slot({ status: 'idle' }), null, null).notFound, false, 'no id: nothing to be missing');
});

test('«عرض المزيد»: pages in order, each competition once, the cursor carried; a quiet re-read keeps the later pages', async () => {
  const asked = serve((path) => {
    if (path === '/api/rewards/program/competitions?view=results') return { body: listAnswer(['a', 'b'], '2031-06-01T00:00:00.000Z|b') };
    if (path === '/api/rewards/program/competitions?view=results&cursor=2031-06-01T00%3A00%3A00.000Z%7Cb') return { body: listAnswer(['b', 'c'], null) };
    return refusal(404, 'NOT_FOUND');
  });
  const store = new ListStore(LIST_SPEC, 'u1');
  await store.fetch('results');
  assert.equal(store.slot('results').x.more, 'idle');
  assert.equal(await store.loadMore('results'), true);
  const s = store.slot('results');
  assert.deepEqual(dedupeById(s.x.pages).map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(s.x.more, 'end');
  assert.equal(s.x.cursor, null);
  assert.equal(store.moreLoaded, 1);
  assert.equal(await store.loadMore('results'), false, 'nothing after the end');
  assert.equal(asked.length, 2);

  serve(() => ({ body: listAnswer(['z', 'a'], '2031-06-10T00:00:00.000Z|a') }));
  await store.fetch('results');
  const again = store.slot('results');
  assert.deepEqual(dedupeById(again.x.pages).map((c) => c.id), ['z', 'a', 'b', 'c'], 'page 1 replaced, page 2 kept');
  assert.equal(again.x.cursor, null, 'the cursor after the last page loaded stands');
  assert.equal(again.x.more, 'end');
});

test('a BAD_CURSOR reads page 1 again and starts the pages over; a failed page says so and can be asked again', async () => {
  let failMore = true;
  serve((path) => {
    if (path.endsWith('view=results')) return { body: listAnswer(['a'], 'c1') };
    if (path.endsWith('cursor=c1')) return { body: listAnswer(['b'], 'c2') };
    if (path.endsWith('cursor=c2')) return failMore ? refusal(503, 'SERVICE_BUSY') : refusal(400, 'BAD_CURSOR');
    return refusal(404, 'NOT_FOUND');
  });
  const store = new ListStore(LIST_SPEC, 'u1');
  await store.fetch('results');
  await store.loadMore('results');
  assert.equal(store.slot('results').x.pages.length, 2);

  assert.equal(await store.loadMore('results'), false);
  assert.equal(store.slot('results').x.more, 'error', '«تعذّر تحميل المزيد.»');
  assert.equal(store.slot('results').x.pages.length, 2, 'nothing lost');

  failMore = false;
  await store.loadMore('results');
  const reset = store.slot('results');
  assert.equal(reset.x.pages.length, 1, 'the later pages are dropped');
  assert.deepEqual(reset.x.pages[0].map((c) => c.id), ['a']);
  assert.equal(reset.x.cursor, 'c1');
  assert.equal(reset.x.more, 'idle');
  assert.equal(store.moreLoaded, 1, 'only the page that arrived counts');
});

test('the counts are global: a view not read yet shows the freshest any view answered with', async () => {
  serve((path) => ({ body: listAnswer([], null, path.includes('view=results') ? { current: 3, results: 26 } : { current: 3, results: 25 }) }));
  const store = new ListStore(LIST_SPEC, 'u1');
  assert.equal(store.counts('results'), undefined);
  await store.fetch('current');
  assert.deepEqual(store.counts('results'), { current: 3, results: 25 });
  await store.fetch('results');
  assert.deepEqual(store.counts('results'), { current: 3, results: 26 });
  assert.deepEqual(store.counts('current'), { current: 3, results: 25 }, 'a view with its own answer reads its own');
});

test('a cancelled read writes nothing (the key reads again on its next enable); stop cancels every read and «عرض المزيد»', async () => {
  const gate = deferred<Reply>();
  serve(() => gate.promise);
  const store = new ListStore(LIST_SPEC, 'u1');
  const pending = store.fetch('current');
  assert.equal(store.busy('current'), true);
  store.cancel('current');
  assert.equal(store.busy('current'), false);
  gate.release({ body: listAnswer(['a'], null) });
  await pending;
  assert.equal(store.slot('current').data, null, 'the late answer is dropped');
  assert.equal(store.slot('current').status, 'loading', 'left for the next enable to read again');

  serve(() => ({ body: listAnswer(['a'], 'c1') }));
  await store.fetch('results');
  const slow = deferred<Reply>();
  serve(() => slow.promise);
  const more = store.loadMore('results');
  assert.equal(store.slot('results').x.more, 'loading');
  const page = store.fetch('current');
  let heard = 0;
  store.subscribe(() => (heard += 1));
  store.stop();
  assert.equal(store.busy('current'), false);
  assert.equal(store.slot('results').x.more, 'idle', 'a cancelled «عرض المزيد» can be pressed again');
  const before = heard;
  slow.release({ body: listAnswer(['b'], null) });
  assert.equal(await more, false);
  await page;
  assert.equal(store.slot('results').x.pages.length, 1);
  store.patch('results', (s) => s);
  assert.equal(heard, before, 'a stopped store tells nobody');
  store.start();
  store.patch('results', (s) => s);
  assert.equal(heard, before + 1);
});

test('invalidate marks every key; one that lands during a read survives its answer; the next read clears it', async () => {
  serve(() => ({ body: listAnswer(['a'], null) }));
  const store = new ListStore(LIST_SPEC, 'u1');
  await store.fetch('current');
  await store.fetch('results');
  store.invalidate();
  assert.equal(store.slot('current').invalid, true);
  assert.equal(store.slot('results').invalid, true);
  await store.fetch('current');
  assert.equal(store.slot('current').invalid, false);
  assert.equal(store.slot('results').invalid, true, 'still due when its view is shown');

  const gate = deferred<Reply>();
  serve(() => gate.promise);
  const hub = new ReadStore(HUB_SPEC, 'u1');
  const pending = hub.fetch(HUB_KEY);
  hub.invalidate();
  gate.release({ body: hubAnswer() });
  await pending;
  assert.equal(hub.slot(HUB_KEY).status, 'ready');
  assert.equal(hub.slot(HUB_KEY).invalid, true, 'that answer may predate the change it was for');
});
