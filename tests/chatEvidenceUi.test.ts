/**
 * THE CHAT IN EVIDENCE MODE (docs/COMMUNITY_ECOSYSTEM.md §9.6 «Dispute
 * evidence access», Client 6a) — src/pages/Chat.tsx at /admin/chats/:id (or
 * ?evidence=1), src/components/adminCommunity/moderation/{EvidenceBanner,
 * EvidenceLinks,evidenceStrings}.tsx and the dispute desk's links.
 *
 *   the address: /admin/chats/<id> and ?evidence=1 are evidence mode, nothing
 *   else is;
 *   no composer: the page draws no way to write — before a message has
 *   loaded, whatever the server's `read_only` says;
 *   no actions: every card is drawn with its actions emptied, a link card
 *   without its print door;
 *   the banner: «قراءة فقط — مراقبة نزاع», «كل قراءة مسجَّلة», the request the
 *   case is about — in ar, en and Sorani;
 *   a refused read (EVIDENCE_NOT_LINKED / EVIDENCE_CLOSED) is its own page in
 *   the refusal table's words, never «not found»;
 *   the dispute desk: «المحادثة» / «الطلب» open the evidence in a new tab, and
 *   nothing is drawn for a case without either.
 *
 * Run: node --import tsx --test tests/chatEvidenceUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { ChatCard } from '../src/lib/chatCards';

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { AuthContext } = await import('../src/AuthContext');
const chatPage = await import('../src/pages/Chat');
const { default: Chat, isEvidencePath, withoutActions } = chatPage;
const { default: EvidenceBanner, EvidenceRefused } = await import('../src/components/adminCommunity/moderation/EvidenceBanner');
const { default: EvidenceLinks, evidenceIds } = await import('../src/components/adminCommunity/moderation/EvidenceLinks');
const { EVIDENCE_STRINGS, evidenceChatHref, evidenceRequestHref } = await import('../src/components/adminCommunity/moderation/evidenceStrings');
const { default: ChatCardView } = await import('../src/components/chat/cards/ChatCardView');
const { ChatCardActionsContext } = await import('../src/components/chat/cards/cardContext');
const { refusalText } = await import('../src/lib/refusalStrings');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments (not for src/pages/Chat.tsx, whose `accept="image/*"` opens a false comment — read that raw). */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;
const STAFF = { id: 'staff_1', name: 'Staff', username: 'staff', isAdmin: true, role: 'admin' };
const auth = (user: Record<string, unknown>) => ({
  isAuthenticated: true,
  user,
  login: async () => {},
  loginWithGoogle: async () => {},
  register: async () => {},
  refreshUser: async () => {},
  logout: async () => {},
  isLoaded: true,
});
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar', path = '/', user: Record<string, unknown> = STAFF) => {
  storedLang = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, { value: auth(user) as never }, createElement(LanguageProvider, { children: createElement(MemoryRouter, { initialEntries: [path] }, node) }))
  );
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const chatAt = (path: string, lang: 'ar' | 'en' | 'ckb' = 'ar') =>
  html(
    createElement(
      Routes,
      null,
      createElement(Route, { path: '/admin/chats/:id', element: createElement(Chat) }),
      createElement(Route, { path: '/chat/:id', element: createElement(Chat) })
    ),
    lang,
    path
  );

// ------------------------------------------------------------------ the address

test('/admin/chats/<id> and ?evidence=1 are evidence mode — nothing else is', () => {
  assert.equal(isEvidencePath('/admin/chats/ch_1', ''), true);
  assert.equal(isEvidencePath('/admin/chats/ch_1/', ''), true);
  assert.equal(isEvidencePath('/chat/ch_1', '?evidence=1'), true);
  assert.equal(isEvidencePath('/chat/ch_1', ''), false);
  assert.equal(isEvidencePath('/chat/ch_1', '?evidence=0'), false);
  assert.equal(isEvidencePath('/admin/chats/', ''), false);
  assert.equal(isEvidencePath('/admin/chats/ch_1/messages', ''), false);
  assert.equal(evidenceChatHref('ch 1'), '/admin/chats/ch%201');
  assert.equal(evidenceRequestHref('req_9'), '/requests/req_9');
});

// ------------------------------------------------------------------ no composer

test('evidence mode draws no composer — from the first frame, before the server has said read-only', () => {
  const evidence = chatAt('/admin/chats/ch_1');
  assert.doesNotMatch(evidence, /data-chat-composer/, 'no way to write');
  assert.doesNotMatch(evidence, /data-chat-plus|data-chat-voice|aria-label="نص الرسالة"/, 'no attach, no voice, no text box');
  assert.doesNotMatch(evidence, /data-chat-read-only/, 'the store-order note is not doubled under the banner');
  assert.match(evidence, /min-h-11 border-b border-border-subtle\/70 bg-surface" aria-hidden="true"/, 'the banner\'s frame holds its place while its chunk lands');
  const query = chatAt('/chat/ch_1?evidence=1');
  assert.doesNotMatch(query, /data-chat-composer/);
  // An ordinary conversation keeps its composer.
  assert.match(chatAt('/chat/ch_1'), /data-chat-composer/);
  // The pins: the composer and the store-order note both step aside; presence is not asked.
  const page = read('src/pages/Chat.tsx');
  assert.match(page, /\{!readOnly && !evidence && \(/);
  assert.match(page, /\{readOnly && !evidence && \(/);
  assert.match(page, /useChatPresence\(id, !!user && !notFound && !evidenceRoute\)/);
  assert.match(page, /const evidence = evidenceRoute \|\| !!evidenceThread;/, 'the server\'s `chat.evidence` turns it on too');
});

// ------------------------------------------------------------------ no actions

const storeCard: ChatCard = {
  type: 'store',
  kind: 'store_card',
  ref: 's_ali',
  original: { store_id: 's_ali', slug: 'ali3d', name: 'Ali 3D', tagline: 'طباعة', logo: null, url: '/community/store/ali3d' },
  current: { status: 'open', actions: ['view'], name: 'Ali 3D' },
};

test('every card is drawn with its actions emptied — whatever the server sends', () => {
  const stripped = withoutActions(storeCard);
  assert.deepEqual(stripped.current.actions, []);
  assert.deepEqual(storeCard.current.actions, ['view'], 'the thread\'s own card is not mutated');
  assert.equal(stripped.current.status, 'open', 'only the actions go');
  const withAction = html(createElement(ChatCardActionsContext.Provider, { value: null }, createElement(ChatCardView, { card: storeCard, mine: false, fallback: null })));
  assert.match(withAction, /data-card-action="view"/, 'a live card offers its action');
  const evidence = html(createElement(ChatCardActionsContext.Provider, { value: null }, createElement(ChatCardView, { card: stripped, mine: false, fallback: null })));
  assert.doesNotMatch(evidence, /data-card-action/, 'evidence mode: no button at all');
  assert.match(text(evidence), /Ali 3D/, 'the card itself is still read');
  const page = read('src/pages/Chat.tsx');
  assert.match(page, /<ChatCardView card=\{evidence \? withoutActions\(msg\.card\) : msg\.card\}/);
  assert.match(page, /<SystemEventCard card=\{msg\.card \? \(evidence \? withoutActions\(msg\.card\) : msg\.card\) : null\}/);
  assert.match(page, /<LinkCard card=\{link\} variant="compact" printDoor=\{!evidence\} \/>/, 'a link card without its print door');
});

// ------------------------------------------------------------------ the banner

test('the banner: read-only, dispute review, every read recorded — and the request the case is about', () => {
  const words = { ar: ['قراءة فقط — مراقبة نزاع', 'كل قراءة مسجَّلة'], en: ['Read-only — dispute review', 'Every read is recorded'], ckb: ['تەنها خوێندنەوە — چاودێریی ناکۆکی', 'هەموو خوێندنەوەیەک تۆمار دەکرێت'] };
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const out = html(createElement(EvidenceBanner, { evidence: { community_order_id: 'co_1', order_id: null, complaint_id: 'cmp_1', request_id: 'req_9' } }), lang);
    assert.match(out, /role="note"/);
    assert.match(out, /data-chat-evidence/);
    for (const w of words[lang]) assert.ok(text(out).includes(w), `${lang}: ${w}`);
    assert.match(out, /href="\/requests\/req_9"/, `${lang}: the request`);
  }
  // A store order's case has no request: no link, the words stay.
  const storeOrder = html(createElement(EvidenceBanner, { evidence: { community_order_id: null, order_id: 'o_1', complaint_id: 'cmp_2', request_id: null } }));
  assert.doesNotMatch(storeOrder, /data-chat-evidence-request/);
  assert.match(text(storeOrder), /كل قراءة مسجَّلة/);
  // Before `chat.evidence` has come back (the address asked for it), the banner still says what this is.
  assert.match(text(html(createElement(EvidenceBanner, { evidence: null }), 'en')), /Read-only — dispute review/);
  // Every key in three languages, the Sorani written.
  const keys = Object.keys(EVIDENCE_STRINGS.ar);
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(Object.keys(EVIDENCE_STRINGS[lang]), keys);
  for (const k of keys) {
    const ar = EVIDENCE_STRINGS.ar[k as keyof typeof EVIDENCE_STRINGS.ar];
    const ckb = EVIDENCE_STRINGS.ckb[k as keyof typeof EVIDENCE_STRINGS.ckb];
    assert.notEqual(ckb, ar, `${k}: the Sorani is the Arabic`);
    assert.match(ckb, KURDISH, `${k}: written in Sorani`);
  }
});

test('a refused read says why — EVIDENCE_NOT_LINKED before the dispute, EVIDENCE_CLOSED after — never «not found»', () => {
  for (const code of ['EVIDENCE_NOT_LINKED', 'EVIDENCE_CLOSED'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const out = html(createElement(EvidenceRefused, { code, onBack: () => undefined }), lang);
      assert.match(out, new RegExp(`data-chat-evidence-refused="${code}"`));
      assert.ok(text(out).includes(refusalText(code, lang)), `${code} ${lang}`);
      assert.match(text(out), lang === 'en' ? /This conversation can’t be opened/ : lang === 'ckb' ? /ئەم گفتوگۆیە ناکرێتەوە/ : /لا يمكن فتح هذه المحادثة/);
    }
  }
  const page = read('src/pages/Chat.tsx');
  assert.match(page, /if \(err\.code === 'EVIDENCE_NOT_LINKED' \|\| err\.code === 'EVIDENCE_CLOSED'\) setEvidenceRefusal\(err\.code\);/);
  assert.match(page, /if \(notFound && evidenceRefusal\) \{/);
  assert.match(page, /const EvidenceRefused = React\.lazy\(/, 'the refusal page is part of the lazy evidence chunk');
  assert.doesNotMatch(page, /^import[^;]*adminCommunity/m, 'nothing of the admin reaches the chat chunk statically');
});

// ------------------------------------------------------------------ the dispute desk

test('the dispute desk opens «المحادثة» and «الطلب» in a new tab — and draws nothing for a case without either', () => {
  const both = html(createElement(EvidenceLinks, { complaint: { id: 'cmp_1', chat_id: 'ch_7', request_id: 'req_9' } }));
  assert.match(both, /<nav aria-label="أدلة النزاع"/);
  const chat = both.match(/<a[^>]*data-evidence-chat="ch_7"[^>]*>/)?.[0] ?? '';
  assert.match(chat, /href="\/admin\/chats\/ch_7"/);
  assert.match(chat, /target="_blank"/);
  assert.match(chat, /rel="noopener noreferrer"/);
  const req = both.match(/<a[^>]*data-evidence-request="req_9"[^>]*>/)?.[0] ?? '';
  assert.match(req, /href="\/requests\/req_9"/);
  assert.match(text(both), /المحادثة.*الطلب/);
  assert.match(text(html(createElement(EvidenceLinks, { complaint: { chat_id: 'ch_7', request_id: null } }), 'ckb')), /گفتوگۆ/);
  assert.doesNotMatch(html(createElement(EvidenceLinks, { complaint: { chat_id: 'ch_7' } })), /data-evidence-request/, 'a store order: the conversation only');
  assert.equal(html(createElement(EvidenceLinks, { complaint: { id: 'cmp_3' } })), '', 'an older server sends neither: nothing is drawn');
  assert.deepEqual(evidenceIds({ chat_id: '  ', request_id: 7 }), { chatId: null, requestId: null });
  const admin = code('src/components/adminCommunity/AdminCommunity.tsx');
  assert.match(admin, /<EvidenceLinks complaint=\{d\.complaint\} className="mt-3" \/>/);
});
