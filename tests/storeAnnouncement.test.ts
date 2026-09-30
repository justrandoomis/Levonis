/**
 * «📣 إعلان» — THE COUNTER'S ANNOUNCEMENT SHEET (P5, merchant platform v2
 * §3.2 dock, §4.6; storefront L6).
 *
 *   - the sheet writes `header.notice` (+ `notice_link`, `notice_from`,
 *     `notice_until`) through the layout's own doors — PUT /draft, then
 *     POST /publish — and nothing else in the layout moves: the REAL routes
 *     publish it and the public storefront serves it;
 *   - a second tab saving in between (DRAFT_CHANGED) is met by reading the
 *     draft again and laying the notice over it once — the other tab's work
 *     is published with it, not lost;
 *   - «احفظ في المسودة فقط» writes the draft and publishes nothing;
 *   - the window's dates are validated as the schema's `date` rule (2020 →
 *     2100) plus the order rule the normaliser enforces by DROPPING the end —
 *     the sheet refuses it before;
 *   - a link is none / a page of the store / an https address; anything else is
 *     refused in the sheet (and is fatal at the gate);
 *   - the door is a lazy sheet (Sheet v2), confirm-before-publish with «سيُنشر
 *     فورًا», refusals by sentence, never the server's text.
 *
 * Run: node --import tsx --test tests/storeAnnouncement.test.ts
 */
import { test } from 'node:test';
import { SCHEDULE_LEAD_MS } from '../worker/lib/storeLayout';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, post, put, stubApp, type App } from './fixtures/app';
import { OWNER, SLUG, seedLayoutStore } from './fixtures/storeLayout';
import { storeLayoutRoutes } from '../worker/routes/storeLayout';
import { storefrontRoutes } from '../worker/routes/storefront';
import { normalizeLayout } from '../packages/storeLayout/src/normalize';
import { starterLayout } from '../packages/storeLayout/src/starters';
import type { StoreLayout } from '../packages/storeLayout/src/schema';
import {
  applyNotice,
  clearedNotice,
  hasNoticeText,
  linkProblem,
  noticeFormOf,
  noticeState,
  windowProblem,
  writeAnnouncement,
  type AnnouncementApi,
  type NoticeForm,
} from '../src/components/merchant/counter/AnnouncementSheet';
import { COUNTER_STRINGS } from '../src/components/merchant/counter/strings';
import { ANNOUNCE_STRINGS } from '../src/components/merchant/counter/announceStrings';
import type { LayoutState } from '../src/components/merchant/storeDesign/storeLayoutApi';

const BASE = '/api/merchant/store/layout';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

function world() {
  const raw = freshDb();
  seedLayoutStore(raw);
  const db = asD1(raw);
  const env = { env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' } };
  return {
    raw,
    owner: stubApp(db, { id: OWNER, role: 'merchant', email: 'owner@x.co' }, (a) => a.route(BASE, storeLayoutRoutes), env),
    pub: stubApp(db, null, (a) => a.route('/api/storefront', storefrontRoutes), env),
  };
}

/** The sheet's three calls, on the REAL routes, refusals as the app's ApiError carries them. */
function apiOf(app: App, calls: string[] = []): AnnouncementApi {
  const fail = async (res: Response) => {
    const body = await json(res);
    throw Object.assign(new Error(String(body.error ?? 'refused')), { code: body.code, details: body.details });
  };
  return {
    get: async () => {
      calls.push('get');
      const res = await get(app, BASE);
      if (!res.ok) await fail(res);
      return (await json(res)) as LayoutState;
    },
    saveDraft: async (layout, version) => {
      calls.push(`put:${version}`);
      const res = await put(app, `${BASE}/draft`, { layout, version });
      if (!res.ok) await fail(res);
      return (await json(res)) as { draft: { version: number } };
    },
    publish: async (version, note) => {
      calls.push(`publish:${version}`);
      const res = await post(app, `${BASE}/publish`, note ? { version, note } : { version });
      if (!res.ok) await fail(res);
      return (await json(res)) as { published: { revision: number } };
    },
  };
}

const FORM: NoticeForm = {
  text: { ar: 'توصيل مجاني هذا الأسبوع', en: 'Free delivery this week', ckb: 'گەیاندنی بێ بەرامبەر ئەم هەفتەیە' },
  link: { kind: 'route', route: 'deals' },
  from: '2026-10-01T09:00:00.000Z',
  until: '2026-10-08T21:00:00.000Z',
};

// ------------------------------------------------------------------ the model

test('the form reads and writes the header\'s notice keys only; a blank bound leaves no key', () => {
  const l = starterLayout('workshop');
  const next = applyNotice(l, FORM);
  assert.deepEqual(next.blocks, l.blocks);
  assert.deepEqual(next.tokens, l.tokens);
  assert.deepEqual(next.background, l.background);
  assert.deepEqual(next.footer, l.footer);
  assert.equal(next.header.variant, l.header.variant, 'the header\'s variant is not the sheet\'s');
  assert.deepEqual(noticeFormOf(next), FORM, 'what is written is what is read back');
  const r = normalizeLayout(next, { ownerUserId: OWNER });
  assert.deepEqual(r.issues, [], 'the gate takes it as it is');
  const open = applyNotice(next, { ...FORM, from: '', until: '' });
  assert.equal('notice_from' in open.header || 'notice_until' in open.header, false);
  const gone = applyNotice(next, clearedNotice());
  assert.equal(hasNoticeText(noticeFormOf(gone)), false);
  assert.deepEqual(normalizeLayout(gone, { ownerUserId: OWNER }).layout.header, { variant: l.header.variant, notice: { ar: '', en: '', ckb: '' }, notice_link: { kind: 'none' } });
  // Words are trimmed on the way in; the link a builder chose (a product) is kept as it is.
  const kept = applyNotice(l, { ...FORM, text: { ar: '  عرض  ', en: '', ckb: '' }, link: { kind: 'product', id: 'p1' } });
  assert.deepEqual([kept.header.notice.ar, kept.header.notice_link], ['عرض', { kind: 'product', id: 'p1' }]);
});

test('the window: each bound between 2020 and 2100, the end after the start — the rule the gate would enforce by dropping the end', () => {
  assert.equal(windowProblem('', ''), null);
  assert.equal(windowProblem(FORM.from, FORM.until), null);
  assert.equal(windowProblem(FORM.from, ''), null);
  assert.equal(windowProblem('', FORM.until), null);
  assert.equal(windowProblem(FORM.until, FORM.from), 'order');
  assert.equal(windowProblem(FORM.from, FORM.from), 'order', 'a window that never opens');
  assert.equal(windowProblem('2019-12-31T00:00:00.000Z', ''), 'range');
  assert.equal(windowProblem('', '2100-01-01T00:00:00.000Z'), 'range');
  assert.equal(windowProblem('not a date', ''), 'range');
  // Without the sheet's refusal, the normaliser keeps the start and silently drops the end.
  const r = normalizeLayout(applyNotice(starterLayout('classic'), { ...FORM, from: FORM.until, until: FORM.from }), { ownerUserId: OWNER });
  assert.deepEqual(r.issues.map((i) => [i.path, i.code]), [['header.notice_until', 'invalid_value']]);
  assert.equal(r.layout.header.notice_until, undefined);
});

test('the link: none, a page of the store, or an https address — anything else is refused before it reaches the gate', () => {
  assert.equal(linkProblem({ kind: 'none' }), null);
  assert.equal(linkProblem({ kind: 'route', route: 'about' }), null);
  assert.equal(linkProblem({ kind: 'external', url: 'https://instagram.com/raf3d' }), null);
  for (const url of ['javascript:alert(document.cookie)', 'http://example.com', '', 'data:text/html,<b>x</b>']) {
    assert.equal(linkProblem({ kind: 'external', url }), 'url', url);
  }
  const r = normalizeLayout(applyNotice(starterLayout('classic'), { ...FORM, link: { kind: 'external', url: 'javascript:alert(1)' } }), { ownerUserId: OWNER });
  assert.ok(r.issues.some((i) => i.path === 'header.notice_link' && i.code === 'unsafe_link' && i.fatal), 'and the gate refuses it too');
});

test('what visitors see now: none, live, waiting for its start, ended', () => {
  const at = '2026-10-05T00:00:00.000Z';
  const h = (over: Partial<StoreLayout['header']>) => ({ variant: 'overlay' as const, notice: FORM.text, notice_link: FORM.link, ...over });
  assert.equal(noticeState(null, at), 'none');
  assert.equal(noticeState(h({ notice: { ar: ' ', en: '', ckb: '' } }), at), 'none');
  assert.equal(noticeState(h({}), at), 'live');
  assert.equal(noticeState(h({ notice_from: FORM.from, notice_until: FORM.until }), at), 'live');
  assert.equal(noticeState(h({ notice_from: '2026-11-01T00:00:00.000Z' }), at), 'waiting');
  assert.equal(noticeState(h({ notice_until: '2026-10-01T00:00:00.000Z' }), at), 'ended');
});

// ------------------------------------------------------------ through the routes

test('the sheet writes header.notice through PUT /draft + POST /publish; the storefront serves it; nothing else moved', async () => {
  const w = world();
  const calls: string[] = [];
  const api = apiOf(w.owner, calls);
  const before = await api.get();
  // The sheet hands over the state it opened with, as AnnouncementSheet does.
  const r = await writeAnnouncement(api, FORM, { publish: true, note: ANNOUNCE_STRINGS.ar.historyNote, state: before });
  assert.equal(r.revision, 1);
  assert.deepEqual(calls, ['get', 'put:0', 'publish:1'], 'one read, one draft save, one publish');
  const after = await api.get();
  assert.deepEqual(noticeFormOf(after.published!.layout), FORM);
  assert.deepEqual(after.published!.layout.blocks, before.draft.layout.blocks, 'the page\'s blocks are untouched');
  assert.deepEqual(after.published!.layout.tokens, before.draft.layout.tokens);
  assert.equal(after.dirty, false);
  // The history names the publish in the merchant's words.
  assert.equal(after.revisions[0].note, ANNOUNCE_STRINGS.ar.historyNote);
  // The public store answer carries the notice once its window is within the lead (review 2026-09-30):
  // a notice dated for later is not in the edge-cached page JSON before then.
  const store = (await json(await get(w.pub, `/api/storefront/${SLUG}`))).store;
  assert.equal(store.layout_source, 'published');
  const due = Date.parse(FORM.from) <= Date.now() + SCHEDULE_LEAD_MS && Date.parse(FORM.until) > Date.now();
  assert.deepEqual(store.layout.header.notice, due ? FORM.text : { ar: '', en: '', ckb: '' });
  // A notice whose window is open now is served, with its window.
  const liveForm: NoticeForm = { ...FORM, from: new Date(Date.now() - 3_600_000).toISOString(), until: new Date(Date.now() + 7 * 86_400_000).toISOString() };
  await writeAnnouncement(api, liveForm, { publish: true, note: ANNOUNCE_STRINGS.ar.historyNote, state: await api.get() });
  const live = (await json(await get(w.pub, `/api/storefront/${SLUG}`))).store;
  assert.deepEqual(live.layout.header.notice, FORM.text);
  assert.equal(live.layout.header.notice_until, liveForm.until);
});

test('another tab saved in between: the draft is read again and the notice laid over it once — the other tab\'s edit survives', async () => {
  const w = world();
  // The builder in another tab has a draft (version 1).
  const draft0 = starterLayout('modern');
  assert.equal((await put(w.owner, `${BASE}/draft`, { layout: draft0, version: 0 })).status, 200);
  const calls: string[] = [];
  const real = apiOf(w.owner, calls);
  const state = await real.get();
  // …and saves once more (a new accent) after the sheet read it.
  const theirs: StoreLayout = { ...draft0, tokens: { ...draft0.tokens, accent: 'teal' } };
  assert.equal((await put(w.owner, `${BASE}/draft`, { layout: theirs, version: 1 })).status, 200);
  const r = await writeAnnouncement(real, FORM, { publish: true, state });
  assert.equal(typeof r.revision, 'number');
  assert.deepEqual(calls, ['get', 'put:1', 'get', 'put:2', 'publish:3']);
  const live = (await real.get()).published!.layout;
  assert.equal(live.tokens.accent, 'teal', 'the other tab\'s work is published with the notice, not lost');
  assert.deepEqual(noticeFormOf(live), FORM);
  // Twice in a row is not retried forever: the refusal is the caller's to say.
  let conflicts = 0;
  const hostile: AnnouncementApi = {
    ...real,
    saveDraft: async () => {
      conflicts += 1;
      throw Object.assign(new Error('changed'), { code: 'DRAFT_CHANGED' });
    },
  };
  await assert.rejects(writeAnnouncement(hostile, FORM, { publish: true }), (e: { code?: string }) => e.code === 'DRAFT_CHANGED');
  assert.equal(conflicts, 2);
});

test('«احفظ في المسودة فقط» writes the draft and publishes nothing; removing the bar publishes an empty notice', async () => {
  const w = world();
  const api = apiOf(w.owner);
  assert.equal((await writeAnnouncement(api, FORM, { publish: true })).revision, 1);
  const r = await writeAnnouncement(api, { ...FORM, text: { ...FORM.text, ar: 'عرض جديد' } }, { publish: false });
  assert.equal(r.revision, null);
  const st = await api.get();
  assert.equal(noticeFormOf(st.draft.layout).text.ar, 'عرض جديد');
  assert.equal(noticeFormOf(st.published!.layout).text.ar, FORM.text.ar, 'visitors still see the published one');
  assert.equal(st.dirty, true);
  await writeAnnouncement(api, clearedNotice(), { publish: true });
  const gone = (await api.get()).published!.layout;
  assert.equal(noticeState(gone.header, new Date().toISOString()), 'none');
});

// ------------------------------------------------------------------ the door

test('the door opens a lazy Sheet v2 that confirms before it publishes, says «سيُنشر فورًا», and names refusals by sentence', () => {
  const dock = code('src/components/merchant/counter/QuickDock.tsx');
  assert.match(dock, /const AnnouncementSheet = lazy\(\(\) => import\('\.\/AnnouncementSheet'\)\);/);
  assert.doesNotMatch(dock, /^import[^;]*from '\.\/AnnouncementSheet'/m, 'the sheet is imported statically');
  assert.match(dock, /id: 'announce', open: \(\) => setAnnouncing\(true\)/);
  assert.match(dock, /aria-haspopup="dialog"/);
  const sheet = code('src/components/merchant/counter/AnnouncementSheet.tsx');
  assert.match(sheet, /detents=\{\['medium', 'large'\]\}/);
  assert.match(sheet, /\{a\.publishNow\}/, 'the confirmation says it goes live at once');
  assert.match(sheet, /setStep\('confirm'\)/);
  assert.match(sheet, /step === 'confirm' \? write\(form, true, a\.published\)/, 'only the confirmation publishes');
  assert.match(sheet, /await import\('\.\.\/\.\.\/\.\.\/lib\/refusalStrings'\)/, 'refusal sentences on the first refusal');
  assert.doesNotMatch(sheet, /e\.message|err\.message/);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const a = ANNOUNCE_STRINGS[lang];
    assert.ok(a.publishNow && a.draftToo && a.windowOrder && a.windowRange && a.urlBad, lang);
    assert.ok(COUNTER_STRINGS[lang].dock.announce, lang);
  }
  // The sheet's sentence table rides in the lazy sheet, never in the Today chunk
  // (tests/bundleBudget.test.ts TODAY_SCREEN_BUDGET); the dock keeps its one word.
  assert.equal('announce' in COUNTER_STRINGS.ar, false, 'the sheet\'s words are not in the Counter\'s table');
  assert.match(ANNOUNCE_STRINGS.ar.publishNow, /^سيُنشر فورًا/);
  assert.equal(ANNOUNCE_STRINGS.ckb.published, 'شریتەکە بڵاوکرایەوە');
});
