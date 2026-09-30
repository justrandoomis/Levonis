/**
 * THE PERSON'S OWN STANDING ON THE SCREEN (docs/COMMUNITY_ECOSYSTEM.md §9.6
 * Moderation V2, Client 6a) — src/components/community/moderation/
 * {StatusBanner,AppealSheet,ModerationPage,strings}.tsx and the doors that
 * mount the banner.
 *
 *   the words: every key in ar, en AND written Sorani;
 *   the banner, per standing: restricted (a warning, with its end date),
 *   suspended (a danger, with its end date), banned (no end date, ever) —
 *   what it takes away, the desk's reason, the appeal door; an active account
 *   draws nothing; the session's `user.moderation` is read, an older server's
 *   user reads active;
 *   the appeal, once: a decision that may be contested offers «اعتراض»; one
 *   that carries an appeal shows its state (and the desk's answer) and no
 *   door; the page swaps the door for the filed appeal; the server's second
 *   answer (409 APPEAL_EXISTS) is said in the refusal table's words;
 *   the pins: the community home and the composer mount the banner lazily and
 *   only for a sanctioned session; the write doors word USER_RESTRICTED /
 *   USER_SUSPENDED / USER_BANNED through the refusal table.
 *
 * Run: node --import tsx --test tests/statusBannerUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { Appeal, ModerationDecision, Standing } from '../src/components/community/moderation/api';

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { AuthContext } = await import('../src/AuthContext');
const { default: StatusBanner } = await import('../src/components/community/moderation/StatusBanner');
const { DecisionSummary } = await import('../src/components/community/moderation/AppealSheet');
const { DecisionRow, withAppeal } = await import('../src/components/community/moderation/ModerationPage');
const { MODERATION_STRINGS, moderationStrings, appealTone } = await import('../src/components/community/moderation/strings');
const { moderationApi, standingOf } = await import('../src/components/community/moderation/api');
const { apiRefusal, refusalText } = await import('../src/lib/refusalStrings');
const { ApiError } = await import('../src/lib/api');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;
const auth = (user: Record<string, unknown> | null) => ({
  isAuthenticated: !!user,
  user,
  login: async () => {},
  loginWithGoogle: async () => {},
  register: async () => {},
  refreshUser: async () => {},
  logout: async () => {},
  isLoaded: true,
});
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar', user: Record<string, unknown> | null = { id: 'u1', name: 'Eve' }) => {
  storedLang = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, { value: auth(user) as never }, createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }))
  );
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const standing = (status: Standing['status'], reason = 'نشر إعلانات متكررة', until: string | null = inDays(5)): Standing => ({ status, reason, until });

// ------------------------------------------------------------------ words

function leaves(o: unknown, path = ''): Array<[string, string]> {
  if (typeof o === 'string') return [[path, o]];
  if (typeof o === 'function') return [[path, String((o as (...a: unknown[]) => unknown)('ban', 'user', '٣ أكتوبر'))]];
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

test('every word exists in ar, en and written Sorani — no Arabic standing in for ckb', () => {
  const ar = leaves(MODERATION_STRINGS.ar);
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(leaves(MODERATION_STRINGS[lang]).map(([k]) => k), ar.map(([k]) => k), `${lang} has the same keys`);
  const ckb = new Map(leaves(MODERATION_STRINGS.ckb));
  let sorani = 0;
  for (const [k, v] of ar) {
    const c = ckb.get(k) ?? '';
    assert.ok(c, `${k} in ckb`);
    assert.notEqual(c, v, `${k}: the Sorani is the Arabic`);
    if (KURDISH.test(c)) sorani += 1;
  }
  assert.ok(sorani >= ar.length - 2, `only ${sorani} of ${ar.length} Sorani strings carry a Sorani letter`);
  // Each decision the desk can take reads as a sentence in all three.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = moderationStrings(lang);
    for (const action of ['hide', 'restore', 'warn', 'restrict', 'suspend', 'ban'] as const) {
      for (const target of ['post', 'comment', 'request_comment', 'user', 'store'] as const) assert.ok(s.decision(action, target, 'حامل').length > 5, `${lang} ${action} ${target}`);
    }
  }
  assert.equal(moderationStrings('ku').page.title, 'حالة حسابي', 'an unknown code falls back to Arabic');
  assert.deepEqual(['open', 'accepted', 'rejected'].map(appealTone), ['warning', 'success', 'danger']);
});

// ------------------------------------------------------------------ the banner

test('one banner per standing: the title, what it takes away, the reason, the end date, the door', () => {
  const r = html(createElement(StatusBanner, { standing: standing('restricted') }));
  assert.match(r, /data-status-banner="restricted"/);
  assert.match(r, /class="lv-alert lv-alert-warning/, 'a restriction is a warning');
  assert.match(text(r), /حسابك مقيَّد حتى/);
  assert.match(r, /حتى \d+\u00a0[^< ]+\u00a0\d{4}</, 'the end date is one unit (no breaking space inside): the heading breaks before it, never inside it');
  assert.match(text(r), /لا يمكنك النشر أو التعليق أو إرسال العروض والطلبات والرسائل الآن/);
  assert.match(text(r), /السبب: نشر إعلانات متكررة/);
  assert.match(r, /<a[^>]*href="\/moderation"[^>]*>|<a[^>]*data-status-appeal[^>]*href="\/moderation"/);
  assert.match(text(r), /الاعتراض على القرار/);
  assert.match(r, /aria-labelledby="status-banner-restricted"/);
  assert.match(r, /<h2 id="status-banner-restricted"/);

  const s = html(createElement(StatusBanner, { standing: standing('suspended') }), 'en');
  assert.match(s, /lv-alert-danger/, 'a suspension is a danger');
  assert.match(text(s), /Your account is suspended until/);
  assert.match(text(s), /like, follow or message until the suspension ends/);

  const b = html(createElement(StatusBanner, { standing: standing('banned', 'fraud', inDays(10)) }), 'ckb');
  assert.match(b, /data-status-banner="banned"/);
  assert.equal(b.match(/<h2[^>]*>([^<]*)<\/h2>/)?.[1], 'هەژمارەکەت قەدەغە کراوە', 'a ban has no end date, whatever the row holds');
  assert.match(text(b), /هۆکار: fraud/);

  const noReason = html(createElement(StatusBanner, { standing: standing('restricted', '', null) }));
  assert.match(text(noReason), /حسابك مقيَّد/);
  assert.doesNotMatch(noReason, /data-status-reason/, 'no reason written, no reason line');
  assert.doesNotMatch(text(noReason), /حتى/, 'no end date, no «حتى»');

  assert.equal(html(createElement(StatusBanner, { standing: { status: 'active', reason: '', until: null } })), '', 'an active account draws nothing');
  assert.doesNotMatch(html(createElement(StatusBanner, { standing: standing('restricted'), appealHref: null })), /data-status-appeal/, 'the decisions page draws no door to itself');
});

test('the banner reads the session\'s own standing — an older server\'s user reads active', () => {
  const sanctioned = { id: 'u1', name: 'Eve', moderation: { status: 'suspended', reason: 'spam', until: inDays(3) } };
  assert.match(html(createElement(StatusBanner), 'ar', sanctioned), /data-status-banner="suspended"/);
  assert.equal(html(createElement(StatusBanner), 'ar', { id: 'u1', name: 'Eve' }), '', 'no `moderation` on the user: active');
  assert.equal(html(createElement(StatusBanner), 'ar', null), '', 'a guest: nothing');
  assert.equal(html(createElement(StatusBanner), 'ar', { id: 'u1', moderation: { status: 'weird' } }), '', 'an unknown word reads active');
  assert.deepEqual(standingOf({ moderation: { status: 'banned', reason: 7, until: '' } }), { status: 'banned', reason: '', until: null });
});

// ------------------------------------------------------------------ the appeal, once

const decision = (over: Partial<ModerationDecision> = {}): ModerationDecision => ({
  id: 'mod_1',
  action: 'restrict',
  target_type: 'user',
  target_id: 'u1',
  target_label: null,
  target_url: null,
  reason: 'نشر إعلانات متكررة',
  until: inDays(5),
  created_at: new Date().toISOString(),
  appealable: true,
  appeal: null,
  ...over,
});
const appeal = (over: Partial<Appeal> = {}): Appeal => ({
  id: 'apl_1',
  state: 'open',
  body: 'لم أنشر إعلانات',
  decision: '',
  decided_at: null,
  created_at: new Date().toISOString(),
  action: { id: 'mod_1', action: 'restrict', target_type: 'user', target_id: 'u1', reason: '', until: null, created_at: '' },
  ...over,
});

test('a decision that may be contested offers «اعتراض»; one that carries an appeal shows its state and no door', () => {
  let asked: ModerationDecision | null = null;
  const open = html(createElement('ul', null, createElement(DecisionRow, { decision: decision(), lang: 'ar', onAppeal: (d) => (asked = d) })));
  assert.match(text(open), /قُيِّد حسابك/);
  assert.match(text(open), /السبب: نشر إعلانات متكررة/);
  assert.match(text(open), /حتى/);
  assert.match(open, /data-appeal-open="mod_1"/, 'the door');
  assert.equal(asked, null);

  const filed = withAppeal([decision(), decision({ id: 'mod_2' })], 'mod_1', appeal());
  assert.equal(filed[0].appealable, false, 'the page swaps the door for the appeal');
  assert.equal(filed[0].appeal?.state, 'open');
  assert.equal(filed[1].appeal, null, 'only that decision');
  const pending = html(createElement('ul', null, createElement(DecisionRow, { decision: filed[0], lang: 'ar', onAppeal: () => undefined })));
  assert.doesNotMatch(pending, /data-appeal-open/, 'once filed, no second door');
  assert.match(pending, /data-appeal-state="open"/);
  assert.match(text(pending), /اعتراضك قيد المراجعة/);

  const answered = html(createElement('ul', null, createElement(DecisionRow, { decision: decision({ appealable: false, appeal: { id: 'apl_1', state: 'rejected', decision: 'الإعلانات مثبتة في البلاغات.', decided_at: new Date().toISOString(), created_at: '' } }), lang: 'en', onAppeal: () => undefined })));
  assert.match(text(answered), /Your appeal was rejected/);
  assert.match(text(answered), /Moderation’s answer: الإعلانات مثبتة في البلاغات\./);
  assert.match(answered, /data-status-chip="danger"/);

  // A decision the server says may not be appealed (a restore) offers no door either.
  const restore = html(createElement('ul', null, createElement(DecisionRow, { decision: decision({ action: 'restore', appealable: false, until: null }), lang: 'ckb', onAppeal: () => undefined })));
  assert.doesNotMatch(restore, /data-appeal-open/);
  assert.match(text(restore), /هەژمارەکەت گەڕایەوە دۆخی ئاسایی/);

  // The notice's decision is marked, once.
  const marked = html(createElement('ul', null, createElement(DecisionRow, { decision: decision({ target_type: 'post', target_label: 'حامل هاتف', target_url: '/community/projects/p1', action: 'hide', until: null }), lang: 'ar', current: true })));
  assert.match(marked, /aria-current="true"/);
  assert.match(marked, /bg-surface-selected/);
  assert.match(text(marked), /أُخفي مشروعك «حامل هاتف»/);
  assert.match(marked, /href="\/community\/projects\/p1"/);

  // The sheet names the decision it contests.
  const summary = html(createElement(DecisionSummary, { decision: decision(), lang: 'ar' }));
  assert.match(text(summary), /القرار قُيِّد حسابك/);
  assert.match(summary, /data-appeal-decision="mod_1"/);
});

test('the appeal is sent once; the second is the server\'s APPEAL_EXISTS, in the refusal table\'s words', async () => {
  const sent: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({ url, body });
    if (sent.length === 1) return new Response(JSON.stringify({ success: true, appeal: appeal() }), { status: 201, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ success: false, error: 'You have already appealed this decision', code: 'APPEAL_EXISTS' }), { status: 409, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const first = await moderationApi.appeal('mod_1', 'لم أنشر إعلانات');
  assert.equal(first.state, 'open');
  assert.deepEqual(sent[0], { url: '/api/moderation/appeals', body: { action_id: 'mod_1', body: 'لم أنشر إعلانات' } });
  const second = await moderationApi.appeal('mod_1', 'مرة ثانية').catch((e: unknown) => e);
  assert.ok(second instanceof ApiError && second.code === 'APPEAL_EXISTS');
  assert.equal(apiRefusal(second, 'ar', 'x'), refusalText('APPEAL_EXISTS', 'ar'));
  assert.match(apiRefusal(second, 'ckb', 'x'), KURDISH);
  // The body is bounded client-side too.
  await moderationApi.appeal('mod_1', 'x'.repeat(1500)).catch(() => undefined);
  assert.equal((sent[2].body as { body: string }).body.length, 1000);
  // The sheet: 3–1000 characters, the send once, APPEAL_EXISTS reads the page again.
  const sheet = code('src/components/community/moderation/AppealSheet.tsx');
  assert.match(sheet, /if \(text\.length < APPEAL_MIN\)/);
  assert.match(sheet, /maxLength=\{APPEAL_BODY_MAX\}/);
  assert.match(sheet, /if \(e instanceof ApiError && e\.code === 'APPEAL_EXISTS'\) onStale\?\.\(\);/);
  assert.match(sheet, /const filed = decision\?\.appeal \?\? null;/, 'a decision already appealed opens on its state');
  assert.match(sheet, /detents=\{\['medium', 'large'\]\}/, 'Sheet v2');
});

// ------------------------------------------------------------------ the pins

test('the home and the composer mount the banner lazily — only for a sanctioned session', () => {
  const home = code('src/pages/Community.tsx');
  assert.match(home, /const StatusBanner = React\.lazy\(\(\) => import\('\.\.\/components\/community\/moderation\/StatusBanner'\)\);/);
  assert.match(home, /\{sanctioned\(user\) && \(/);
  assert.match(home, /\['restricted', 'suspended', 'banned'\]\.includes/);
  assert.doesNotMatch(home, /^import[^;]*moderation/m, 'no static import on the home');
  const composer = code('src/pages/community/ProjectComposer.tsx');
  assert.match(composer, /const StatusBanner = React\.lazy\(\(\) => import\('\.\.\/\.\.\/components\/community\/moderation\/StatusBanner'\)\);/);
  assert.match(composer, /\['restricted', 'suspended', 'banned'\]\.includes\(String\(\(user as/);
  // Every write door words the server's refusal through the table, so USER_* reads as a sentence.
  for (const f of [
    'src/pages/community/ProjectComposer.tsx',
    'src/components/community/social/CommentsSheet.tsx',
    'src/components/community/social/FollowUserButton.tsx',
    'src/components/community/requests/OfferComposer.tsx',
    'src/components/community/offers/OfferComposer.tsx',
    'src/components/community/requests/Discussion.tsx',
    'src/components/community/requests/RequestWizard.tsx',
  ]) {
    assert.match(code(f), /apiRefusal\(/, `${f} words a refusal through the table`);
  }
  for (const c of ['USER_RESTRICTED', 'USER_SUSPENDED', 'USER_BANNED']) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(refusalText(c, lang).length > 30, `${c} ${lang}`);
  }
  // The page: not behind the community gate, the notice's `?action=` marked.
  const page = code('src/components/community/moderation/ModerationPage.tsx');
  assert.match(page, /const target = actionFromSearch\(search\);/);
  assert.match(page, /current=\{d\.id === target\}/);
  assert.match(page, /const AppealSheet = React\.lazy\(\(\) => import\('\.\/AppealSheet'\)\);/);
  assert.doesNotMatch(page, /^import[^;]*from '\.\/AppealSheet'/m, 'the sheet stays lazy');
});
