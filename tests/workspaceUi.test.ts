/**
 * TODAY v2 — THE COUNTER'S HOME (merchant platform v2 §3.2, P3a).
 *
 * What must not quietly come back:
 *   · every word of the Counter exists in Arabic, English AND real Sorani in
 *     its own table (src/components/merchant/counter/strings.ts, D6 / rows
 *     166–168), the three tables share one key set, and the Sorani is not the
 *     Arabic pasted across;
 *   · tokens only — no hex, no `dark:`, no physical left/right utility, no
 *     native dialog, no `fixed bottom-0`; every spring through `useMotion`,
 *     never a `duration` outside the kit;
 *   · the screen, rendered for real (`renderToStaticMarkup`, the technique of
 *     tests/tierPriceDisclosure.test.ts) with a stubbed attention read: zero
 *     rows say «nothing waiting» ONCE; a source that did not answer draws no
 *     row and forbids the claim; the first rows sit under their ticket with
 *     the action on the row; the Pulse names the open state and an
 *     unpublished draft, and nothing for P4's speed slot;
 *   · «تأكيد» on a row calls the order route and re-reads attention;
 *   · the clock sentence follows the server's `open_now`/`next_change_at`,
 *     and re-derives itself from the hours once that instant has passed;
 *   · GET /api/merchant/attention carries `first[]` (≤ 2, owner-scoped) in
 *     the same read and a `returns` source; /api/merchant/me and
 *     /api/storefront/:slug carry `open_now` + `next_change_at`.
 *
 * Run: node --import tsx --test tests/workspaceUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { get, json } from './fixtures/app';
import { OWNER, OWNER2, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import { LanguageProvider } from '../src/LanguageContext';
import { WorkspaceContext, type WorkspaceValue } from '../src/components/merchant/shell/context';
import type { Attention } from '../src/components/merchant/shell/attention';
import CommandCenter, { EVERY_SOURCE, attentionRows, confirmOrder, pulseLines } from '../src/components/merchant/shell/sections/CommandCenter';
import { COUNTER_STRINGS, fill } from '../src/components/merchant/counter/strings';
import { openStateSentence } from '../src/components/merchant/counter/StatusStrip';
import type { MerchantMe } from '../src/lib/merchant';
import { merchantAttentionRoutes, FIRST_ROWS } from '../worker/routes/merchantWorkspace';
import { merchantRoutes } from '../worker/routes/merchant';
import { storefrontRoutes } from '../worker/routes/storefront';

const COUNTER = 'src/components/merchant/counter';
const SCREEN = 'src/components/merchant/shell/sections/CommandCenter.tsx';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const counterFiles = readdirSync(join(ROOT, COUNTER)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${COUNTER}/${f}`);

// ------------------------------------------------------------------ words

test('the Counter has its own table: every key in ar, en and real Sorani; the shell copies, never writes', () => {
  for (const f of ['strings.ts', 'StatusStrip.tsx', 'PulseRow.tsx', 'QuickDock.tsx', 'RestockSheet.tsx']) {
    assert.ok(counterFiles.includes(`${COUNTER}/${f}`), `${COUNTER}/${f} is missing`);
  }
  const flat = (o: unknown, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    if (Array.isArray(o)) o.forEach((v, i) => Object.assign(out, flat(v, `${prefix}${i}.`)));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) Object.assign(out, flat(v, `${prefix}${k}.`));
    else out[prefix.replace(/\.$/, '')] = String(o);
    return out;
  };
  const ar = flat(COUNTER_STRINGS.ar);
  const en = flat(COUNTER_STRINGS.en);
  const ckb = flat(COUNTER_STRINGS.ckb);
  const keys = Object.keys(ar);
  assert.ok(keys.length >= 90, `only ${keys.length} keys`);
  assert.deepEqual(Object.keys(en).sort(), keys.slice().sort(), 'en keys differ from ar');
  assert.deepEqual(Object.keys(ckb).sort(), keys.slice().sort(), 'ckb keys differ from ar');
  let same = 0;
  let kurdish = 0;
  for (const k of keys) {
    for (const [lang, table] of [['ar', ar], ['en', en], ['ckb', ckb]] as const) assert.ok(table[k].trim().length > 0, `${lang}.${k} is empty`);
    if (ckb[k] === ar[k]) same += 1;
    assert.notEqual(ckb[k], en[k], `ckb.${k} is the English`);
    if (/[ەۆێڕڵڤگچپژیک]/.test(ckb[k])) kurdish += 1;
    // A placeholder in one language is a placeholder in all three.
    const vars = (t: string) => (t.match(/\{\w+\}/g) ?? []).sort().join(',');
    assert.equal(vars(en[k]), vars(ar[k]), `${k}: ar/en placeholders differ`);
    assert.equal(vars(ckb[k]), vars(ar[k]), `${k}: ar/ckb placeholders differ`);
  }
  assert.ok(same / keys.length <= 0.1, `${same} of ${keys.length} Sorani strings are the Arabic`);
  assert.ok(kurdish / keys.length >= 0.9, `only ${kurdish} of ${keys.length} Sorani strings use a Kurdish letter`);
  assert.equal(fill('{n} رسالة', { n: 3 }), '3 رسالة');
  assert.equal(fill('opens {day} {time}', { day: '', time: '9:00' }), 'opens 9:00', 'an empty day leaves no double space');
  // The screen reads the table: no two-language `loc()` left behind, no OWNER stand-in.
  const screen = code(SCREEN);
  assert.doesNotMatch(screen, /loc\(\s*(['`])(?:(?!\1).)*\1\s*,\s*(['`])(?:(?!\2).)*\2\s*\)/, 'CommandCenter still writes ar/en inline');
  assert.doesNotMatch(read(SCREEN), /OWNER: Sorani to be written by hand/);
  // The shell's Operate|Design words are the table's, verbatim.
  const shell = read('src/components/merchant/shell/MerchantShell.tsx');
  for (const w of [COUNTER_STRINGS.ckb.mode.operate, COUNTER_STRINGS.ckb.mode.design, COUNTER_STRINGS.ckb.mode.label]) {
    assert.ok(shell.includes(w), `the shell's mode word «${w}» is not the table's`);
  }
});

// ------------------------------------------------------------ source rules

test('tokens only, logical utilities, no native dialog, no fixed bar; springs from useMotion, no invented duration', () => {
  const physical = /(?:^|[\s"'`{])(?:[a-z-]+:)*(?:pl|pr|ml|mr|left|right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)-[\w[\]/.-]+/;
  for (const f of [...counterFiles, SCREEN]) {
    const src = code(f);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f} hard-codes a hex colour`);
    assert.doesNotMatch(src, /(?:^|[\s"'`{])(?:[a-z-]+:)*dark:[a-z-]/, `${f} uses the dark: variant`);
    assert.doesNotMatch(src, physical, `${f} uses a physical left/right utility`);
    assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\(|(?:^|[^.\w])alert\(/, `${f} uses a native dialog`);
    assert.doesNotMatch(src, /fixed bottom-0/, `${f} has a fixed bottom-0 bar`);
    assert.doesNotMatch(src, /transition=\{\{\s*duration/, `${f} invents a duration`);
    assert.doesNotMatch(src, /e\.message|err\.message/, `${f} shows the server's raw sentence`);
    assert.doesNotMatch(src, /tracking-|uppercase/, `${f} spaces or uppercases Arabic`);
  }
  const screen = code(SCREEN);
  assert.match(screen, /const m = useMotion\(\)/, 'the queue does not use the motion kit');
  assert.match(screen, /<Motion\.li key=\{r\.id\} layout initial=\{false\} exit=\{\{ height: 0, opacity: 0 \}\} transition=\{m\.spring\('ui'\)\}/, 'a ticket leaves with `ui`');
  assert.match(screen, /<AnimatePresence initial=\{false\}>/);
  // The screen renders `m.*` under <MotionFeatures> and loads the refusal
  // sentences on the first refusal (perf review 2026-09-30): Today is the
  // merchant's landing screen, and neither the animation-features chunk nor
  // ~20 KB of sentences belongs in front of it.
  assert.match(screen, /import \* as Motion from 'motion\/react-m';/);
  assert.doesNotMatch(screen, /\bmotion\b(?!\/)[^\n]*from 'motion\/react'/, 'CommandCenter imports the motion proxy');
  assert.match(screen, /<MotionFeatures>/);
  for (const f of [SCREEN, `${COUNTER}/StatusStrip.tsx`, `${COUNTER}/RestockSheet.tsx`]) {
    assert.doesNotMatch(code(f), /^import \{ apiRefusal \}/m, `${f} imports refusalStrings statically`);
    assert.match(code(f), /await import\('(?:\.\.\/)+lib\/refusalStrings'\)/, `${f} loads the sentences on demand`);
  }
  assert.match(screen, /const RestockSheet = lazy\(\(\) => import\('\.\.\/\.\.\/counter\/RestockSheet'\)\)/, 'the restock sheet is its own chunk');
  assert.match(screen, /apiRefusal\(e, lang/, 'refusals are rendered by sentence');
  assert.match(code(`${COUNTER}/RestockSheet.tsx`), /apiRefusal\(e, lang, s\.restock\.failed\)/, 'the restock sheet names the refusal');
  assert.match(code(`${COUNTER}/RestockSheet.tsx`), /detents=\{\['medium'\]\}/, 'the restock sheet is Sheet v2');
  assert.match(code(`${COUNTER}/QuickDock.tsx`), /\/api\/community\/access/, 'the reel door is gated by the community access read');
  assert.match(code(`${COUNTER}/StatusStrip.tsx`), /api\.patch\('\/api\/merchant\/store', \{ open: next \}\)/, 'the switch is the pause route');
  // Every `<Door>` leads somewhere real: never an empty string.
  assert.doesNotMatch(screen, /<Door to=""/);
});

// ------------------------------------------------------------- the screen

const NOW = Date.parse('2026-09-26T10:00:00+03:00'); // a Saturday, 10:00 in Baghdad

function me(over: Partial<MerchantMe['store'] & object> = {}): MerchantMe {
  return {
    eligible: true,
    tier: 'plus',
    tier_active: true,
    expires_at: null,
    gated_benefits: [],
    can: { store: true, products: true, orders: true, offers: true, analytics: true, subdomain: true },
    store: {
      id: 's1',
      merchant_id: 'm1',
      slug: 'ali3d',
      url: 'https://ali3d.levonis-iq.com',
      name: 'متجر نور',
      tagline: '',
      description: '',
      logoUrl: null,
      bannerUrl: null,
      accent: 'gold',
      categories: [],
      governorate: 'baghdad',
      service_areas: [],
      contact_phone: null,
      business_hours: [{ day: 'كل الأيام', open: '09:00', close: '21:00' }],
      policies: {},
      social_links: {},
      accepts_custom_requests: true,
      sells_direct_products: true,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      merchant: { id: 'm1', name: 'Ali', verified: true, status: 'active', badge: 'new', rating: null, rating_count: 0, completed_orders: 0 },
      ...over,
    } as MerchantMe['store'] & object,
    selling: { canSell: true, reason: '' },
    suggested_slug: null,
  } as MerchantMe;
}

function render(attention: Attention | null, over: Partial<MerchantMe['store'] & object> = {}): string {
  const m = me({ open_now: true, next_change_at: '2026-09-26T18:00:00.000Z', ...over } as never);
  const ws: WorkspaceValue = {
    me: m,
    store: m.store!,
    canSell: true,
    base: '/merchant',
    onStoreHost: false,
    href: (l) => l,
    mainHref: (p) => p,
    resolveLink: (l) => ({ internal: true, to: l }),
    go: () => {},
    query: { create: false },
    clearQuery: () => {},
    reloadMe: () => {},
    attention: { data: attention, error: null, loading: false, refresh: () => {} },
    setBellUnread: () => {},
  };
  return renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(MemoryRouter, null, createElement(WorkspaceContext.Provider, { value: ws }, createElement(CommandCenter))),
    })
  );
}

const EMPTY: Attention = {
  orders: { total: 0, by_stage: { pending: 0, confirmed: 0, processing: 0 }, link: '/merchant/orders', links: { pending: '/merchant/orders?status=pending', confirmed: '/merchant/orders?status=confirmed', processing: '/merchant/orders?status=processing' }, first: [] },
  custom_orders: { to_start: 0, in_progress: 0, total: 0, link: '/merchant/requests/orders' },
  inbox: { threads: 0, messages: 0, link: '/merchant/inbox', first: [] },
  stock: { low: 0, out: 0, link_low: '/merchant/products?state=published&stock=low', link_out: '/merchant/products?state=published&stock=out', first: [] },
  reviews: { unanswered: 0, link: '/merchant/reviews' },
  returns: { open: 0, link: '/merchant/orders', first: [] },
  store: { problems: [] },
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

test('zero rows: «nothing waiting» is said once, as a claim about every source; no sub-row, no ticket', () => {
  const html = render(EMPTY);
  assert.equal(count(html, COUNTER_STRINGS.ar.today.empty), 1, 'said once');
  assert.match(html, /data-attention-clear="true"/);
  assert.doesNotMatch(html, /data-attention-list/);
  assert.doesNotMatch(html, /data-sub-rows/);
  assert.doesNotMatch(html, /data-store-problem/);
  // The strip and the pulse are there whatever the queue says.
  assert.match(html, /data-status-strip/);
  assert.match(html, /data-pulse-line="open" data-tone="success"/);
  assert.doesNotMatch(html, /data-pulse-line="unpublished"/);
  assert.doesNotMatch(html, /data-pulse-line="speed"/, 'P4\'s slot renders nothing');
  assert.match(html, /role="switch"[^>]*aria-checked="true"/, 'the pause switch reflects an active store');
});

test('a source that did not answer draws no row and forbids the claim', () => {
  const { orders: _o, ...noOrders } = EMPTY;
  const html = render({ ...noOrders, stock: { ...EMPTY.stock!, out: 1, first: [{ id: 'cp2', name: 'Lamp', name_ar: '', stock: 0, link: '/merchant/products/cp2' }] } });
  assert.doesNotMatch(html, /data-attention="orders-pending"/);
  assert.match(html, /data-attention="stock-out"/);
  const silent = render(noOrders);
  assert.equal(count(silent, COUNTER_STRINGS.ar.today.emptyPartial), 1, 'the partial sentence, once');
  assert.doesNotMatch(silent, /data-attention-clear/);
  assert.deepEqual([...EVERY_SOURCE], ['orders', 'custom_orders', 'inbox', 'stock', 'reviews', 'returns']);
  // A zero is a zero: the pure rows say so too.
  assert.deepEqual(attentionRows(EMPTY, COUNTER_STRINGS.ar), []);
  assert.deepEqual(attentionRows({}, COUNTER_STRINGS.ar), []);
});

test('the first rows sit under their ticket with the action on the row; the returns ticket is read-only', () => {
  const a: Attention = {
    ...EMPTY,
    orders: {
      ...EMPTY.orders!,
      total: 3,
      by_stage: { pending: 3, confirmed: 0, processing: 0 },
      first: [
        { id: 'A1F3', customer_name: 'نور', total_iqd: 45000, governorate: 'baghdad', created_at: '2026-09-26T06:00:00.000Z', link: '/merchant/orders/A1F3' },
        { id: 'A1F4', customer_name: 'علي', total_iqd: 12500, governorate: 'erbil', created_at: '2026-09-26T05:00:00.000Z', link: '/merchant/orders/A1F4' },
      ],
    },
    inbox: { threads: 2, messages: 3, link: '/merchant/inbox', first: [{ id: 'ch1', customer_name: 'نور', last_message: 'هل يتوفر بالأسود؟', unread: 2, last_message_at: null, link: '/merchant/inbox/ch1' }] },
    stock: { ...EMPTY.stock!, out: 1, first: [{ id: 'cp2', name: 'Phone stand', name_ar: 'حامل هاتف', stock: 0, link: '/merchant/products/cp2' }] },
    returns: { open: 1, link: '/merchant/orders', first: [{ id: 'rc1', order_id: 'A1F0', state: 'requested', requested_at: '2026-09-25T00:00:00.000Z', link: '/merchant/orders/A1F0' }] },
    store: { problems: [{ code: 'layout_unpublished', link: '/merchant/store/design' }] },
  };
  const html = render(a);
  assert.match(html, /data-attention="orders-pending"/);
  assert.equal(count(html, 'data-row-confirm="'), 2, 'two orders, two confirms');
  assert.match(html, /data-row-confirm="A1F3"/);
  assert.ok(html.indexOf('data-attention="orders-pending"') < html.indexOf('data-sub-rows="orders"'), 'the sub-rows follow their ticket');
  assert.match(html, /هل يتوفر بالأسود؟/);
  assert.match(html, /data-row-reply="ch1"/);
  assert.match(html, /data-row-restock="cp2"/);
  assert.match(html, /حامل هاتف/, 'the Arabic name in Arabic');
  assert.match(html, /data-attention="returns"/);
  assert.match(html, new RegExp(COUNTER_STRINGS.ar.returns.state.requested));
  assert.doesNotMatch(html, /data-row-confirm="rc1"|data-row-restock="rc1"/, 'no action on a return: Levonis decides');
  assert.ok(html.includes(COUNTER_STRINGS.ar.returns.adminDecides));
  // The Pulse names the unpublished draft and points at the design screen; the problem card stands too.
  assert.match(html, /data-pulse-line="unpublished" data-tone="warning"/);
  assert.match(html, /href="\/merchant\/store\/design"/);
  assert.match(html, /data-store-problem="layout_unpublished"/);
  assert.doesNotMatch(html, /data-attention-clear/);
  // The restock sheet is not in the tree until a row asks for it.
  assert.doesNotMatch(html, /data-restock-save/);
});

test('«تأكيد» on a row: the order route, then the one attention read again; a refusal is thrown, not swallowed', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const refreshed: boolean[] = [];
  await confirmOrder({ post: async (path, body) => { calls.push({ path, body }); return {} as never; }, refresh: (force) => refreshed.push(!!force) }, 'ORD-1');
  assert.deepEqual(calls, [{ path: '/api/merchant/orders/ORD-1/status', body: { status: 'confirmed' } }]);
  assert.deepEqual(refreshed, [true], 'refreshed once, forced past the 15 s gap');
  const refused: boolean[] = [];
  await assert.rejects(
    confirmOrder({ post: async () => { throw Object.assign(new Error('x'), { code: 'ORDER_TRANSITION_INVALID' }); }, refresh: (f) => refused.push(!!f) }, 'ORD/2'),
    /x/
  );
  assert.deepEqual(refused, [], 'a refused move re-reads nothing');
  assert.equal(calls[0].path, '/api/merchant/orders/ORD-1/status');
  const encoded: string[] = [];
  await confirmOrder({ post: async (path) => { encoded.push(path); return {} as never; }, refresh: () => {} }, 'a b');
  assert.equal(encoded[0], '/api/merchant/orders/a%20b/status', 'the id is encoded, never spliced');
});

// ------------------------------------------------------------ the clock word

test('the clock sentence follows the server, and re-derives itself from the hours once the instant has passed', () => {
  const en = COUNTER_STRINGS.en;
  const hours = [{ day: 'Every day', open: '09:00', close: '21:00' }];
  const open = { business_hours: hours, open_now: true, next_change_at: '2026-09-26T18:00:00.000Z' }; // 21:00 Baghdad
  assert.equal(openStateSentence(en, open, 'en', NOW), 'Open now · closes 9:00 PM');
  // 21:30 Baghdad: the cached body still says open; the word flips from the same hours.
  assert.equal(openStateSentence(en, open, 'en', Date.parse('2026-09-26T21:30:00+03:00')), 'Closed now · opens tomorrow 9:00 AM');
  // Before opening today: no day word at all.
  const closedToday = { business_hours: hours, open_now: false, next_change_at: '2026-09-26T06:00:00.000Z' };
  assert.equal(openStateSentence(en, closedToday, 'en', Date.parse('2026-09-26T07:00:00+03:00')), 'Closed now · opens 9:00 AM');
  // Friday closed, asked on Thursday night: the weekday is named.
  const weekend = [{ day: 'Sat – Thu', open: '09:00', close: '21:00' }, { day: 'Friday', open: '', close: '', closed: true }];
  const thuNight = { business_hours: weekend, open_now: false, next_change_at: '2026-10-03T06:00:00.000Z' };
  assert.equal(openStateSentence(en, thuNight, 'en', Date.parse('2026-10-01T22:00:00+03:00')), 'Closed now · opens Saturday 9:00 AM');
  // No readable hours: no claim.
  assert.equal(openStateSentence(en, { business_hours: [], open_now: null, next_change_at: null }, 'en', NOW), en.status.byArrangement);
  // An older server without the fields: derived from the hours it did send.
  assert.equal(openStateSentence(en, { business_hours: hours }, 'en', NOW), 'Open now · closes 9:00 PM');
  // Arabic and Sorani carry the same clock, in their own sentence.
  assert.match(openStateSentence(COUNTER_STRINGS.ar, open, 'ar', NOW), /^مفتوح الآن · يغلق /);
  // The clock word follows the APP's language, never the device's (review 2026-09-30): Arabic reads the Iraqi
  // clock in Latin digits, Sorani the 24-hour clock, and in both the time is an unbreakable LTR isolate.
  const arSentence = openStateSentence(COUNTER_STRINGS.ar, open, 'ar', NOW);
  assert.match(arSentence, /\u2068[^\u2069]*9:00[^\u2069]*\u2069/, 'the time is an isolate');
  assert.ok(!/AM|PM/.test(arSentence), 'no English meridiem inside an Arabic sentence');
  assert.ok(!/\u2068[^\u2069]* [^\u2069]*\u2069/.test(arSentence), 'no breaking space inside the time');
  assert.match(openStateSentence(COUNTER_STRINGS.ckb, open, 'ckb', NOW), /\u206821:00\u2069/, 'Sorani reads the 24-hour clock in Latin digits');
  assert.match(openStateSentence(COUNTER_STRINGS.ckb, open, 'ckb', NOW), /^ئێستا کراوەیە · .+ دادەخرێت$/);
  // The Pulse: open in one line, a second only for an unpublished draft, never a third yet.
  const lines = pulseLines({ s: en, statusKey: 'open', statusWord: 'Open', openSentence: 'Open now · closes 9:00 PM', unpublished: true });
  assert.deepEqual(lines.map((l) => [l.id, l.tone, l.to]), [['open', 'success', '/merchant/store/settings'], ['unpublished', 'warning', '/merchant/store/design']]);
  const paused = pulseLines({ s: en, statusKey: 'paused', statusWord: 'Paused', openSentence: 'Open now · closes 9:00 PM', unpublished: false });
  assert.deepEqual(paused.map((l) => [l.tone, l.text]), [['warning', 'Paused · Open now · closes 9:00 PM']]);
});

// ------------------------------------------------------------ the server

function world(): DatabaseSync {
  const raw = seedW2E();
  raw.exec(`
    UPDATE community_products SET publish_state = 'published' WHERE id IN ('cp1','cp2','cp9');
    UPDATE community_products SET stock = 0, updated_at = '2026-09-02T00:00:00.000Z' WHERE id = 'cp2';
    UPDATE community_products SET stock = 0, updated_at = '2026-09-03T00:00:00.000Z' WHERE id = 'cp1';
    UPDATE community_products SET stock = 0 WHERE id = 'cp9';
    UPDATE merchant_stores SET business_hours = '[{"day":"كل الأيام","open":"09:00","close":"21:00"}]' WHERE id = 's1';
    INSERT INTO chats (id, store_id, context_type, context_id, last_message_at) VALUES ('ch1','s1','store','m1','2026-09-01T00:00:00.000Z');
    INSERT INTO chat_participants (chat_id, user_id, role) VALUES ('ch1','owner','merchant'), ('ch1','buyer','customer');
    INSERT INTO chat_messages (id, chat_id, sender_id, body, created_at) VALUES ('mg1','ch1','buyer','هل يتوفر بالأسود؟','2026-09-01T00:00:00.000Z');
  `);
  addOrder(raw, { id: 'ORD-A1', status: 'pending', at: '2026-09-01T00:00:00.000Z' });
  addOrder(raw, { id: 'ORD-A2', status: 'pending', at: '2026-09-02T00:00:00.000Z', user: 'buyer2', governorate: 'erbil' });
  addOrder(raw, { id: 'ORD-A3', status: 'pending', at: '2026-09-03T00:00:00.000Z' });
  addOrder(raw, { id: 'ORD-A4', status: 'delivered', at: '2026-08-01T00:00:00.000Z' });
  addOrder(raw, { id: 'ORD-B1', status: 'pending', merchant: 'm2', store: 's2' });
  raw.exec(`
    INSERT INTO order_items (id, order_id, product_id, qty, name_snapshot, unit_price_iqd, line_total_iqd) VALUES
      ('oi1','ORD-A4','cp1',1,'Vase',1000,1000), ('oi2','ORD-A1','cp2',1,'Lamp',1000,1000), ('oi9','ORD-B1','cp9',1,'Cup',1000,1000);
    INSERT INTO return_cases (id, order_id, order_item_id, user_id, qty, reason, state, requested_at) VALUES
      ('rc1','ORD-A4','oi1','buyer',1,'defective','requested','2026-09-05T00:00:00.000Z'),
      ('rc2','ORD-A1','oi2','buyer',1,'wrong_item','rejected','2026-09-06T00:00:00.000Z'),
      ('rc9','ORD-B1','oi9','buyer',1,'defective','requested','2026-09-07T00:00:00.000Z');
  `);
  return raw;
}

const mount = (a: Parameters<Parameters<typeof appOf>[2]>[0]) => {
  a.route('/api/merchant/attention', merchantAttentionRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/storefront', storefrontRoutes);
};

test('attention: the first rows ride in the same read — ≤ 2 newest, owner-scoped — and returns count only open cases on my orders', async () => {
  const raw = world();
  const res = await get(appOf(raw, OWNER, mount), '/api/merchant/attention');
  assert.equal(res.status, 200);
  const a = (await json(res)).attention;
  assert.equal(FIRST_ROWS, 2);
  assert.deepEqual(a.orders.first.map((o: { id: string }) => o.id), ['ORD-A3', 'ORD-A2'], 'newest first, capped');
  assert.deepEqual(Object.keys(a.orders.first[0]).sort(), ['created_at', 'customer_name', 'governorate', 'id', 'link', 'total_iqd']);
  assert.equal(a.orders.first[0].link, '/merchant/orders/ORD-A3');
  assert.equal(a.orders.first[1].customer_name, 'Omar Najm');
  assert.equal(a.orders.first[1].governorate, 'erbil');
  assert.equal(a.orders.by_stage.pending, 3, 'the count is still the count');
  assert.deepEqual(a.inbox.first.map((t: { id: string; last_message: string; customer_name: string; unread: number }) => [t.id, t.last_message, t.customer_name, t.unread]), [['ch1', 'هل يتوفر بالأسود؟', 'Sara Ahmed', 1]]);
  assert.equal(a.inbox.first[0].link, '/merchant/inbox/ch1');
  assert.deepEqual(a.stock.first.map((p: { id: string }) => p.id), ['cp1', 'cp2'], 'mine, sold out, most recently changed first');
  assert.equal(a.stock.first[0].link, '/merchant/products/cp1');
  assert.equal(a.stock.out, 2);
  assert.deepEqual(a.returns, {
    open: 1,
    first: [{ id: 'rc1', order_id: 'ORD-A4', state: 'requested', requested_at: '2026-09-05T00:00:00.000Z', link: '/merchant/orders/ORD-A4' }],
    link: '/merchant/orders',
  });
  // B sees B's: one return, its own pending order, its own sold-out cup.
  const b = (await json(await get(appOf(raw, OWNER2, mount), '/api/merchant/attention'))).attention;
  assert.deepEqual(b.orders.first.map((o: { id: string }) => o.id), ['ORD-B1']);
  assert.deepEqual(b.stock.first.map((p: { id: string }) => p.id), ['cp9']);
  assert.equal(b.returns.open, 1);
  assert.equal(b.returns.first[0].id, 'rc9');
  assert.equal(b.inbox.threads, 0);
  // The returns source fails alone.
  raw.exec('DROP TABLE return_cases');
  const without = (await json(await get(appOf(raw, OWNER, mount), '/api/merchant/attention'))).attention;
  assert.equal('returns' in without, false);
  assert.equal(without.orders.first.length, 2, 'the other sources still answer');
});

test('/api/merchant/me and /api/storefront/:slug carry open_now + next_change_at from the same rule', async () => {
  const raw = world();
  const mine = await json(await get(appOf(raw, OWNER, mount), '/api/merchant/me'));
  assert.equal(typeof mine.store.open_now, 'boolean', 'a store with readable hours has a verdict');
  assert.ok(Number.isFinite(Date.parse(mine.store.next_change_at)), 'and the instant it changes');
  assert.ok(Date.parse(mine.store.next_change_at) > Date.now(), 'in the future');
  const front = await json(await get(appOf(raw, null, mount), '/api/storefront/ali3d'));
  assert.equal(front.store.open_now, mine.store.open_now);
  assert.equal(front.store.next_change_at, mine.store.next_change_at);
  assert.ok(Array.isArray(front.store.business_hours), 'the client can re-derive from the hours it is sent');
  // No hours: no claim, on both.
  raw.exec(`UPDATE merchant_stores SET business_hours = '[]' WHERE id = 's1'`);
  const none = await json(await get(appOf(raw, null, mount), '/api/storefront/ali3d'));
  assert.deepEqual([none.store.open_now, none.store.next_change_at], [null, null]);
  const mineNone = await json(await get(appOf(raw, OWNER, mount), '/api/merchant/me'));
  assert.deepEqual([mineNone.store.open_now, mineNone.store.next_change_at], [null, null]);
});
