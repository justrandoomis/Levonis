/**
 * THE MODERATION DESK ON THE SCREEN (docs/COMMUNITY_ECOSYSTEM.md §9.6
 * Moderation V2, Client 6a) — src/components/adminCommunity/moderation/
 * {ModerationDesk,TargetPreview,DecisionSheet,AuditTrail,AppealsQueue,strings}
 * and its place in the community admin.
 *
 *   the words: every key in ar, en AND written Sorani;
 *   the queue renders every kind a report names — a post (its card, its
 *   author, the hide in force), a comment, a request comment, an order
 *   update, an account (its standing), a store (its owner), a product, a
 *   request (its customer), and a target that is gone — with the reporter and
 *   how many reports the same target drew; each row offers exactly the
 *   decisions its kind allows (hide/show, the ladder, the report's own);
 *   the ladder: a step lighter than the sanction in force is disabled with the
 *   reason (MODERATION_LADDER), staff accounts have none; a sanction is
 *   CONFIRMED — the reason first, then the ConfirmDialog naming the account,
 *   and only on «yes» the request, carrying the report it answers; «no» sends
 *   nothing; a refusal comes back in the refusal table's words;
 *   the audit trail: each decision with its reason, who, until when, and its
 *   appeal; the history is read when the sheet opens;
 *   the appeals: the person, the decision, their words; accept/reject once;
 *   the pins: «الإشراف» beside the disputes, a lazy chunk.
 *
 * Run: node --import tsx --test tests/moderationDeskUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { DeskAppeal, HistoryAction, RenderedTarget, ReportRow } from '../src/components/adminCommunity/moderation/api';

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const desk = await import('../src/components/adminCommunity/moderation/ModerationDesk');
const { ReportCard, personOf, isHidden, stepAllowed, historyTarget, stepRequest, hideRequest, reportRequest } = desk;
const { default: TargetPreview } = await import('../src/components/adminCommunity/moderation/TargetPreview');
const { runDecision, untilFrom } = await import('../src/components/adminCommunity/moderation/DecisionSheet');
const { HistoryRow } = await import('../src/components/adminCommunity/moderation/AuditTrail');
const { AppealRow, appealRequest } = await import('../src/components/adminCommunity/moderation/AppealsQueue');
const { DESK_STRINGS, deskStrings } = await import('../src/components/adminCommunity/moderation/strings');
const { LADDER_STEPS } = await import('../src/components/adminCommunity/moderation/api');
const { refusalText } = await import('../src/lib/refusalStrings');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const attrs = (h: string, name: string) => [...h.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const noop = () => undefined;
const act = { hide: noop, step: noop, decide: noop, history: noop };

const SARA = { id: 'u_sara', name: 'سارة', username: 'sara', status: 'active' as const };
const TARGETS: Record<string, RenderedTarget> = {
  post: {
    kind: 'post',
    id: 'p1',
    exists: true,
    card: { id: 'p1', kind: 'project', title: 'حامل هاتف', excerpt: 'طُبع بدون دعامات', cover: null, url: '/community/projects/p1' } as never,
    hidden: { at: ago(5), reason: 'إعلان متكرر' },
    author: SARA,
  },
  comment: { kind: 'comment', id: 'c1', exists: true, post_id: 'p1', post_url: '/community/projects/p1', body: 'تعليق مسيء', state: 'visible', created_at: ago(9), author: { ...SARA, status: 'restricted' } },
  request_comment: { kind: 'request_comment', id: 'rc1', exists: true, request_id: 'req_1', comment_kind: 'public_comment', body: 'رابط احتيال', state: 'hidden', hidden_reason: 'احتيال', created_at: ago(12), author: SARA },
  order_update: { kind: 'order_update', id: 'ou1', exists: true, order_id: 'co_1', update_kind: 'note', body: 'صورة غير لائقة', has_file: true, created_at: ago(20), author: SARA },
  user: { kind: 'user', id: 'u_omar', exists: true, name: 'Omar', username: 'omar', staff: false, status: 'suspended', status_until: new Date(Date.now() + 5 * 86_400_000).toISOString(), status_reason: 'spam', creator_public: true, created_at: ago(10_000) },
  staff: { kind: 'user', id: 'u_admin', exists: true, name: 'Levonis staff', username: 'admin', staff: true, status: 'active' },
  store: { kind: 'store', id: 's1', exists: true, slug: 'ali3d', name: 'Ali 3D', status: 'active', merchant_status: 'active', owner_id: 'u_ali', logoUrl: null },
  product: { kind: 'product', id: 'cp1', exists: true, slug: 'dragon', name: 'Dragon', name_ar: 'تنين', status: 'active', lifecycle: 'active', hidden: null, merchant_id: 'm1', store_slug: 'ali3d' },
  request: { kind: 'request', id: 'req_2', exists: true, title: 'حامل شاشة', state: 'open', visibility: 'public', customer: { id: 'u_cust', name: 'زينب' } },
  gone: { kind: 'post', id: 'p_gone', exists: false },
};

const report = (target: RenderedTarget, over: Partial<ReportRow> = {}): ReportRow => ({
  id: `rep_${target.id}`,
  state: 'open',
  reason: 'fraud',
  details: 'رأيته ثلاث مرات اليوم',
  created_at: ago(30),
  reviewed_by: null,
  reviewed_at: null,
  resolution: '',
  reporter: { id: 'u_rep', name: 'نور', username: 'nour' },
  target,
  reports_on_target: 3,
  open_on_target: 2,
  ...over,
});

// ------------------------------------------------------------------ words

function leaves(o: unknown, path = ''): Array<[string, string]> {
  if (typeof o === 'string') return [[path, o]];
  if (typeof o === 'function') return [[path, String((o as (...a: unknown[]) => unknown)('ban', 'سارة'))]];
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

test('every word exists in ar, en and written Sorani — no Arabic standing in for ckb', () => {
  const ar = leaves(DESK_STRINGS.ar);
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(leaves(DESK_STRINGS[lang]).map(([k]) => k), ar.map(([k]) => k), `${lang} has the same keys`);
  const ckb = new Map(leaves(DESK_STRINGS.ckb));
  let sorani = 0;
  for (const [k, v] of ar) {
    const c = ckb.get(k) ?? '';
    assert.ok(c, `${k} in ckb`);
    assert.notEqual(c, v, `${k}: the Sorani is the Arabic`);
    if (KURDISH.test(c)) sorani += 1;
  }
  // «سنووردار», «تا …», «لابردن» are Sorani spelt with letters Arabic shares; the rest carry one Arabic lacks.
  assert.ok(sorani >= ar.length - 3, `only ${sorani} of ${ar.length} Sorani strings carry a Sorani letter`);
  for (const step of LADDER_STEPS) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const s = deskStrings(lang);
      assert.ok(s.steps[step] && s.consequence[step].length > 20 && s.confirmTitle[step]('سارة').includes('سارة'), `${lang} ${step}`);
    }
  }
});

// ------------------------------------------------------------------ the queue

test('the queue renders every kind a report names, with the reporter and the count on the target', () => {
  const post = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.post), lang: 'ar', act })));
  assert.match(post, /data-report="rep_p1"[^>]*data-report-kind="post"[^>]*data-report-state="open"/);
  assert.match(text(post), /احتيال أو نصب/, 'the reason, in the reporter\'s own words');
  assert.match(text(post), /أبلغ: نور/);
  assert.match(text(post), /3 بلاغات على هذا · 2 مفتوحة/);
  assert.match(post, /data-report-count="3\/2"/);
  assert.match(text(post), /رأيته ثلاث مرات اليوم/, 'what the reporter wrote');
  assert.match(post, /data-target="post"/);
  assert.match(text(post), /حامل هاتف/);
  assert.match(post, /data-target-hidden/, 'the hide in force');
  assert.match(text(post), /إعلان متكرر/);
  assert.match(post, /data-target-person="u_sara"/, 'the author');
  assert.match(post, /href="\/community\/projects\/p1"[^>]*target="_blank"|target="_blank"[^>]*href="\/community\/projects\/p1"/, '«فتح» in a new tab');
  assert.deepEqual(attrs(post, 'data-report-hide'), ['show'], 'a hidden post offers «إظهار»');
  assert.deepEqual(attrs(post, 'data-report-ladder'), ['u_sara'], 'the ladder is about the author');
  assert.deepEqual(attrs(post, 'data-report-decide'), ['reviewed', 'dismissed']);
  assert.equal((post.match(/data-report-history/g) ?? []).length, 1);

  const comment = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.comment), lang: 'ar', act })));
  assert.match(text(comment), /تعليق مسيء/);
  assert.deepEqual(attrs(comment, 'data-report-hide'), ['hide']);
  assert.match(comment, /data-status-chip="warning"/, 'the author\'s standing as a chip');
  assert.match(text(comment), /مقيَّد/);

  const rc = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.request_comment), lang: 'en', act })));
  assert.match(rc, /data-target="request_comment"/);
  assert.match(rc, /href="\/requests\/req_1"/);
  assert.deepEqual(attrs(rc, 'data-report-hide'), ['show']);
  assert.match(text(rc), /Unhide/);

  const ou = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.order_update), lang: 'ar', act })));
  assert.match(ou, /data-target="order_update"/);
  assert.match(text(ou), /فيه مرفق/);
  assert.equal(attrs(ou, 'data-report-hide').length, 0, 'an order update is not hidden from here');
  assert.deepEqual(attrs(ou, 'data-report-ladder'), ['u_sara']);

  const user = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.user), lang: 'ar', act })));
  assert.match(user, /data-target="user"/);
  assert.match(text(user), /معلَّق · حتى/);
  assert.deepEqual(attrs(user, 'data-report-ladder'), ['u_omar']);
  assert.match(user, /href="\/u\/omar"/);

  const staff = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.staff), lang: 'ar', act })));
  assert.equal(attrs(staff, 'data-report-ladder').length, 0, 'staff accounts are not moderated here');
  assert.match(text(staff), /حسابات فريق Levonis لا تُدار من هنا/);

  const store = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.store), lang: 'ar', act })));
  assert.deepEqual(attrs(store, 'data-report-ladder'), ['u_ali'], 'the store\'s owner');
  assert.match(store, /href="\/community\/store\/ali3d"/);

  const product = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.product), lang: 'ar', act })));
  assert.match(text(product), /تنين/, 'the Arabic name for an Arabic reader');
  assert.equal(attrs(product, 'data-report-ladder').length + attrs(product, 'data-report-hide').length, 0, 'a product is decided in its own section');
  assert.match(product, /href="\/community\/store\/ali3d\/p\/dragon"/);

  const request = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.request), lang: 'ar', act })));
  assert.deepEqual(attrs(request, 'data-report-ladder'), ['u_cust'], 'the requester');
  assert.match(text(request), /صاحب الطلب: زينب/);

  const gone = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.gone), lang: 'ar', act })));
  assert.match(gone, /data-target-gone/);
  assert.match(text(gone), /لم يعد موجودًا/);
  assert.equal(attrs(gone, 'data-report-ladder').length + attrs(gone, 'data-report-hide').length, 0);
  assert.deepEqual(attrs(gone, 'data-report-decide'), ['reviewed', 'dismissed'], 'the report itself can still be closed');

  // A decided report is a record: no decisions on it.
  const closed = html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.comment, { state: 'dismissed', resolution: 'ليس إساءة' }), lang: 'ar', act })));
  assert.equal(attrs(closed, 'data-report-decide').length, 0);
  assert.match(text(closed), /قرار البلاغ: ليس إساءة/);
  // Nothing sensitive on the desk: no email, no phone, no storage key.
  for (const h of [post, comment, rc, ou, user, store, product, request]) assert.doesNotMatch(h, /@[a-z]+\.[a-z]+|\+964|users\/u_/);
  // Sorani and English readers get their own words.
  assert.match(text(html(createElement('ul', null, createElement(ReportCard, { report: report(TARGETS.post), lang: 'ckb', act })), 'ckb')), /ڕاپۆرتکەر:/);
  // The preview on its own: one frame per kind the server renders, and a target it no longer finds says so.
  for (const [name, target] of Object.entries(TARGETS)) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const alone = html(createElement(TargetPreview, { target, lang }), lang);
      assert.equal(attrs(alone, 'data-target')[0], target.kind, `${name} (${lang})`);
      assert.equal(alone.includes('data-target-gone'), !target.exists, `${name} (${lang}): gone only when the server found nothing`);
    }
  }
});

test('the rules a row draws: the person, the hide in force, the history, the ladder a standing allows', () => {
  assert.deepEqual(personOf(TARGETS.post), { id: 'u_sara', name: 'سارة', status: 'active', role: 'author' });
  assert.equal(personOf(TARGETS.user)?.role, 'account');
  assert.equal(personOf(TARGETS.staff)?.staff, true);
  assert.equal(personOf(TARGETS.store)?.id, 'u_ali');
  assert.equal(personOf(TARGETS.product), null);
  assert.equal(personOf(TARGETS.gone), null);
  assert.equal(isHidden(TARGETS.post), true);
  assert.equal(isHidden(TARGETS.comment), false);
  assert.equal(isHidden({ ...TARGETS.comment, state: 'removed' } as RenderedTarget), null, 'a comment its author removed has nothing to hide');
  const s = deskStrings('ar');
  assert.deepEqual(historyTarget(TARGETS.order_update, s), { type: 'user', id: 'u_sara', label: 'سارة' }, 'an order update: its author\'s history');
  assert.equal(historyTarget(TARGETS.post, s)?.type, 'post');
  // warn → restrict → suspend → ban; restore needs something to lift; lighter than in force is refused.
  const allowed = (status?: 'active' | 'restricted' | 'suspended' | 'banned') => LADDER_STEPS.filter((st) => stepAllowed(st, status));
  assert.deepEqual(allowed('active'), ['warn', 'restrict', 'suspend', 'ban']);
  assert.deepEqual(allowed('restricted'), ['warn', 'restrict', 'suspend', 'ban', 'restore']);
  assert.deepEqual(allowed('suspended'), ['warn', 'suspend', 'ban', 'restore']);
  assert.deepEqual(allowed('banned'), ['warn', 'ban', 'restore']);
  assert.deepEqual(allowed(undefined), [...LADDER_STEPS], 'an unknown standing: the server decides');
  // The menu says why a step is closed.
  const desk = code('src/components/adminCommunity/moderation/ModerationDesk.tsx');
  assert.match(desk, /hint: allowed \? undefined : step === 'restore' \? s\.statuses\.active : s\.lighter/);
  assert.match(desk, /destructive: step === 'suspend' \|\| step === 'ban'/);
});

// ------------------------------------------------------------------ the ladder, confirmed

interface Hit {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
function stubFetch(answer: (hit: Hit) => Response): Hit[] {
  const hits: Hit[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hit = { method: (init?.method ?? 'GET').toUpperCase(), url, body: init?.body ? JSON.parse(String(init.body)) : null };
    hits.push(hit);
    return answer(hit);
  }) as typeof fetch;
  return hits;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a ladder step is confirmed: the reason first, the ConfirmDialog naming the account, the request only on «yes»', async () => {
  const s = deskStrings('ar');
  const r = report(TARGETS.post);
  const sara = personOf(TARGETS.post)!;
  let reloaded = 0;
  const ban = stepRequest(r, sara, 'ban', s, 'ar', () => (reloaded += 1));
  assert.equal(ban.confirm?.title, 'حظر حساب سارة؟');
  assert.equal(ban.destructive, true);
  assert.equal(ban.reason, 'required');
  assert.equal(ban.until, false, 'a ban has no end date');
  assert.equal(stepRequest(r, sara, 'suspend', s, 'ar', noop).until, true);
  assert.equal(stepRequest(r, sara, 'restore', s, 'ar', noop).reason, 'optional', 'lifting needs no reason');
  assert.equal(stepRequest(r, sara, 'warn', s, 'ar', noop).destructive, false);

  const hits = stubFetch(() => json(200, { success: true, action_id: 'mod_9', status: 'banned', until: null, store: { id: 's9', slug: 'sara3d', status: 'suspended' } }));
  const asked: string[] = [];
  // A reason too short: nothing is asked, nothing is sent.
  const short = await runDecision(ban, { reason: 'x', preset: 'none', date: '' }, async (o) => (asked.push(String(o.title)), true), s);
  assert.deepEqual(short, { kind: 'invalid', field: 'reason', error: s.reasonRequired });
  assert.equal(asked.length + hits.length, 0);
  // «لا»: the dialog was asked, nothing was sent.
  const no = await runDecision(ban, { reason: 'احتيال متكرر', preset: 'none', date: '' }, async (o) => (asked.push(String(o.title)), false), s);
  assert.deepEqual(no, { kind: 'cancelled' });
  assert.deepEqual(asked, ['حظر حساب سارة؟']);
  assert.equal(hits.length, 0, '«no» sends nothing');
  // «نعم»: one request, with the step, the reason and the report it answers.
  let options: Record<string, unknown> = {};
  const yes = await runDecision(ban, { reason: '  احتيال متكرر  ', preset: 'none', date: '' }, async (o) => ((options = o as never), true), s);
  assert.deepEqual(yes, { kind: 'done' });
  assert.equal(options.destructive, true, 'drawn destructive, focus on cancel');
  assert.equal(options.confirmLabel, 'حظر', 'the verb itself');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, 'POST');
  assert.equal(hits[0].url, '/api/admin/moderation/users/u_sara/status');
  assert.deepEqual(hits[0].body, { status: 'ban', reason: 'احتيال متكرر', until: null, report_id: 'rep_p1' });
  assert.equal(reloaded, 1, 'the queue is read again');

  // A restriction ends when the desk says: a week from now.
  const now = Date.parse('2026-09-30T10:00:00.000Z');
  const restrict = stepRequest(r, sara, 'restrict', s, 'ar', noop);
  await runDecision(restrict, { reason: 'سبام', preset: 'd7', date: '' }, async () => true, s, () => undefined, now);
  assert.equal(hits[1].body?.until, '2026-10-07T10:00:00.000Z');
  assert.equal(untilFrom('none', ''), null);
  assert.equal(untilFrom('d1', '', now), '2026-10-01T10:00:00.000Z');
  assert.equal(untilFrom('custom', 'bad'), null);
  assert.ok(untilFrom('custom', '2026-12-31')?.startsWith('2026-12-31') || untilFrom('custom', '2026-12-31')?.startsWith('2027-01-01'));
  // «تاريخ» with no day picked: asked again under the date field — never sent as a sanction without an end.
  const blank = await runDecision(restrict, { reason: 'سبام', preset: 'custom', date: '' }, async (o) => (asked.push(String(o.title)), true), s, () => undefined, now);
  assert.deepEqual(blank, { kind: 'invalid', field: 'until', error: s.untilRequired });
  assert.equal(hits.length, 2, 'nothing more was sent');
  await runDecision(restrict, { reason: 'سبام', preset: 'custom', date: '2026-12-31' }, async () => true, s, () => undefined, now);
  assert.equal(hits.length, 3);
  assert.equal(hits[2].body?.until, untilFrom('custom', '2026-12-31'), 'the picked day, at its last minute');

  // The server says lighter-than-in-force: the refusal table's sentence, kept in the sheet.
  stubFetch(() => json(409, { success: false, error: 'lighter', code: 'MODERATION_LADDER' }));
  const refused = await runDecision(restrict, { reason: 'سبام', preset: 'none', date: '' }, async () => true, s);
  assert.deepEqual(refused, { kind: 'refused', error: refusalText('MODERATION_LADDER', 'ar') });
  stubFetch(() => json(403, { success: false, error: 'staff', code: 'MODERATION_STAFF_TARGET' }));
  const staff = await runDecision(ban, { reason: 'سبب', preset: 'none', date: '' }, async () => true, s);
  assert.equal((staff as { error: string }).error, refusalText('MODERATION_STAFF_TARGET', 'ar'));

  // The sheet runs this order, and asks the reason and the end date in its own fields.
  const sheet = code('src/components/adminCommunity/moderation/DecisionSheet.tsx');
  assert.match(sheet, /const out = await runDecision\(request, \{ reason, preset, date \}, confirm, s,/);
  assert.match(sheet, /const \[confirm, confirmDialog\] = useConfirm\(\);/);
  assert.match(sheet, /<Field label=\{s\.untilDate\} error=\{dateError\}>/, 'an unanswered end date is said under the date');
  // The end and the queue's state are pop-ups: five long names (English, Sorani) are never cut into segments.
  assert.match(sheet, /<Select\s+value=\{preset\}[\s\S]*?data-until-preset[\s\S]*?UNTIL_PRESETS\.map/);
  assert.match(code('src/components/adminCommunity/moderation/ModerationDesk.tsx'), /<Select value=\{state\}[\s\S]*?data-reports-state>\s*\{REPORT_STATE_FILTERS\.map/);
  assert.match(sheet, /detents=\{\['medium', 'large'\]\}/, 'Sheet v2');
});

test('hiding content and closing a report go out with the report they answer', async () => {
  const s = deskStrings('en');
  const hits = stubFetch(() => json(200, { success: true, hidden: true, action_id: 'mod_3' }));
  const hide = hideRequest(report(TARGETS.comment), true, s, 'en', noop);
  assert.equal(hide.reason, 'required', 'a hide tells the author why');
  assert.equal(hide.confirm, undefined, 'the sheet is the confirmation: a hide is undone as easily');
  assert.deepEqual(await runDecision(hide, { reason: 'Abusive', preset: 'none', date: '' }, async () => true, s), { kind: 'done' });
  assert.deepEqual(hits[0], { method: 'POST', url: '/api/admin/moderation/comments/c1/hide', body: { hidden: true, reason: 'Abusive', report_id: 'rep_c1' } });
  const show = hideRequest(report(TARGETS.post), false, s, 'en', noop);
  assert.equal(show.reason, 'optional');
  await runDecision(show, { reason: '', preset: 'none', date: '' }, async () => true, s);
  assert.equal(hits[1].url, '/api/admin/moderation/posts/p1/hide');
  assert.equal(hits[1].body?.hidden, false);
  await runDecision(hideRequest(report(TARGETS.request_comment), false, s, 'en', noop), { reason: '', preset: 'none', date: '' }, async () => true, s);
  assert.equal(hits[2].url, '/api/admin/moderation/request-comments/rc1/hide');
  await runDecision(reportRequest(report(TARGETS.gone), 'dismissed', s, 'en', noop), { reason: 'duplicate', preset: 'none', date: '' }, async () => true, s);
  assert.deepEqual(hits[3], { method: 'POST', url: '/api/admin/moderation/reports/rep_p_gone', body: { state: 'dismissed', resolution: 'duplicate' } });
});

// ------------------------------------------------------------------ the audit trail

test('the audit trail: each decision, its reason, who, until when, and its appeal — read when opened', () => {
  const a: HistoryAction = {
    id: 'mod_1',
    action: 'suspend',
    target_type: 'user',
    target_id: 'u_sara',
    reason: 'سبام متكرر',
    until: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    report_id: 'rep_1',
    subject_user_id: 'u_sara',
    created_at: ago(60),
    actor: { id: 'staff_1', name: 'علي' },
    appeal: { id: 'apl_1', state: 'rejected', body: 'لم أفعل', decision: 'الأدلة واضحة', decided_at: ago(10), created_at: ago(30) },
  };
  const out = html(createElement('ul', null, createElement(HistoryRow, { a, lang: 'ar' })));
  assert.match(out, /data-history-action="suspend"/);
  assert.match(text(out), /تعليق · حساب/);
  assert.match(text(out), /سبام متكرر/);
  assert.match(text(out), /بواسطة علي/);
  assert.match(text(out), /حتى/);
  assert.match(out, /data-history-appeal="rejected"/);
  assert.match(text(out), /رُفض الاعتراض عليه/);
  assert.match(text(out), /لم أفعل/);
  assert.match(text(out), /رد الإدارة: الأدلة واضحة/);
  const en = html(createElement('ul', null, createElement(HistoryRow, { a: { ...a, appeal: null, until: null, actor: null }, lang: 'en' })), 'en');
  assert.doesNotMatch(en, /data-history-appeal/);
  assert.match(text(en), /Suspend · Account/);
  const trail = code('src/components/adminCommunity/moderation/AuditTrail.tsx');
  assert.match(trail, /moderationDeskApi\s*\.history\(target\.type, target\.id\)/, 'read when the sheet opens');
  assert.match(trail, /\}, \[target, nonce\]\);/, 'every opening reads it again');
  assert.match(trail, /s\.auditActions\[r\.action\] \?\? r\.action/, 'the audit rows in words');
});

// ------------------------------------------------------------------ the appeals

const deskAppeal = (over: Partial<DeskAppeal> = {}): DeskAppeal => ({
  id: 'apl_7',
  state: 'open',
  body: 'التعليق كان مزحة بين أصدقاء',
  decision: '',
  decided_at: null,
  created_at: ago(15),
  user: { id: 'u_sara', name: 'سارة', username: 'sara', status: 'restricted' },
  action: { id: 'mod_7', action: 'hide', target_type: 'comment', target_id: 'c1', reason: 'إساءة', until: null, created_at: ago(90) },
  ...over,
});

test('an appeal shows the person, the decision and their words; accept or reject — once', async () => {
  const open = html(createElement('ul', null, createElement(AppealRow, { appeal: deskAppeal(), lang: 'ar', onDecide: noop, onHistory: noop })));
  assert.match(text(open), /اعتراض من سارة/);
  assert.match(text(open), /على قرار: إخفاء · تعليق/);
  assert.match(text(open), /إساءة/);
  assert.match(text(open), /التعليق كان مزحة بين أصدقاء/);
  assert.match(open, /data-appeal-accept/);
  assert.match(open, /data-appeal-reject/);
  const decided = html(createElement('ul', null, createElement(AppealRow, { appeal: deskAppeal({ state: 'accepted', decision: 'قُبل — التعليق أُعيد' }), lang: 'en', onDecide: noop, onHistory: noop })), 'en');
  assert.doesNotMatch(decided, /data-appeal-accept|data-appeal-reject/, 'an appeal is decided once');
  assert.match(text(decided), /Moderation’s answer: قُبل — التعليق أُعيد/);
  assert.match(decided, /data-appeal-state="accepted"/);

  const s = deskStrings('ar');
  const hits = stubFetch(() => json(200, { success: true, state: 'accepted', restored: true, restore_action_id: 'mod_8' }));
  const accept = appealRequest(deskAppeal(), 'accepted', s, 'ar', noop);
  assert.equal(accept.reason, 'optional');
  assert.equal(accept.maxLength, 1000);
  assert.deepEqual(await runDecision(accept, { reason: 'مزحة فعلًا', preset: 'none', date: '' }, async () => true, s), { kind: 'done' });
  assert.deepEqual(hits[0], { method: 'POST', url: '/api/admin/moderation/appeals/apl_7', body: { state: 'accepted', decision: 'مزحة فعلًا' } });
  stubFetch(() => json(409, { success: false, error: 'decided', code: 'APPEAL_DECIDED' }));
  const again = await runDecision(appealRequest(deskAppeal(), 'rejected', s, 'ar', noop), { reason: '', preset: 'none', date: '' }, async () => true, s);
  assert.deepEqual(again, { kind: 'refused', error: refusalText('APPEAL_DECIDED', 'ar') });
});

// ------------------------------------------------------------------ the pins

test('«الإشراف» sits beside the disputes, and the desk is a lazy chunk of its own', () => {
  const admin = code('src/components/adminCommunity/AdminCommunity.tsx');
  assert.match(admin, /const ModerationDesk = lazyModeration\(\(\) => import\('\.\/moderation\/ModerationDesk'\)\);/);
  assert.doesNotMatch(admin, /from '\.\/moderation\/ModerationDesk'/, 'never a static import');
  const disputes = admin.indexOf("{ id: 'disputes'");
  const moderation = admin.indexOf("{ id: 'moderation'");
  assert.ok(disputes > 0 && moderation > disputes && moderation - disputes < 300, 'right after the disputes');
  assert.match(admin, /\{section === 'moderation' && \(\s*<ModerationSuspense fallback=\{<Spin \/>\}>\s*<ModerationDesk \/>/);
  assert.match(admin, /label: evidenceStrings\(moderationLang\)\.desk/, 'the section\'s name in three languages');
  // The desk reads the queue a page at a time and asks again after each decision.
  const desk = code('src/components/adminCommunity/moderation/ModerationDesk.tsx');
  assert.match(desk, /moderationDeskApi\s*\.reports\(\{ state, type: type \|\| undefined \}\)/);
  assert.match(desk, /moderationDeskApi\.reports\(\{ state, type: type \|\| undefined \}, next\)/, '«المزيد» with the cursor');
  assert.match(desk, /report_id: r\.id/, 'every decision carries its report');
  // No raw server sentence reaches the desk: refusals go through the table.
  for (const f of ['ModerationDesk.tsx', 'AppealsQueue.tsx']) assert.match(code(`src/components/adminCommunity/moderation/${f}`), /apiRefusal\(e, l, s\.failed\)/);
});
