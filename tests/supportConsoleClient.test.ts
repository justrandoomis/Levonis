/**
 * THE CLIENT HALF OF THE SUPPORT CONSOLE — the part the owner actually sees.
 *
 * The recurring failure in this project is a server fix whose screen never
 * uses it. tests/supportConsole.test.ts proves the routes; this file proves
 * the screens are wired to them and keep the promises the owner asked for:
 *
 *   «شريط الكتابة غير ثابت في الأسفل»        → the composer is a sibling of the
 *                                              scrolling list, never inside it
 *   «عند الرد تحمل الصفحة ويظهر جاري التحميل» → replies append; threads refresh
 *                                              silently and merge by id
 *   «لا يمكن إرسال وسائط مثل صور أو فيديو»   → attach on every thread, preview
 *                                              BEFORE the upload, the whole
 *                                              photograph and a way to open it
 *   «لا يوجد صفحة للرد على رسائل المستخدمين ولا على الشكاوى ولا على التذاكر»
 *                                            → one console, three desks, a badge
 *
 * The merge rule is tested as behaviour (it is pure); the wiring is tested
 * against the source with comments stripped, so a commented-out line cannot
 * satisfy an assertion about a live one.
 *
 * Run: node --import tsx --test tests/supportConsoleClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { mergeThread, settleThread, type ThreadRow } from '../src/lib/supportThread';
import MessageMedia from '../src/components/adminSupport/MessageMedia';

const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ------------------------------------------------------- the merge rule

type Row = ThreadRow & { body: string };
const r = (id: string, created_at: string, extra: Partial<Row> = {}): Row => ({ id, created_at, body: id, ...extra });

test('MERGE — the server is the truth for what it returned, and a new reply from the other side appears', () => {
  const current = [r('a', '2026-09-23T10:00:00.000Z'), r('b', '2026-09-23T10:01:00.000Z')];
  const incoming = [...current, r('c', '2026-09-23T10:02:00.000Z', { body: 'staff answered' })];
  const next = mergeThread(current, incoming);
  assert.deepEqual(next.map((m) => m.id), ['a', 'b', 'c']);
});

test('MERGE — a poll that changes nothing returns the SAME array, so nothing re-renders or jumps', () => {
  const current = [r('a', '2026-09-23T10:00:00.000Z'), r('b', '2026-09-23T10:01:00.000Z')];
  const incoming = current.map((m) => ({ ...m }));
  assert.equal(mergeThread(current, incoming), current);
});

test('MERGE — a bubble being sent survives a poll that left before it was written', () => {
  const current = [r('a', '2026-09-23T10:00:00.000Z'), r('temp-1', '2026-09-23T10:05:00.000Z', { pending: true })];
  const next = mergeThread(current, [r('a', '2026-09-23T10:00:00.000Z')]);
  assert.deepEqual(next.map((m) => m.id), ['a', 'temp-1'], 'the pending bubble is not dropped');
});

test('MERGE — a reply that settled after the poll read the thread is not dropped by that stale answer', () => {
  const current = [r('a', '2026-09-23T10:00:00.000Z'), r('srv-2', '2026-09-23T10:05:00.000Z')];
  const next = mergeThread(current, [r('a', '2026-09-23T10:00:00.000Z')]);
  assert.deepEqual(next.map((m) => m.id), ['a', 'srv-2']);
});

test('SETTLE — the server row takes the bubble’s place; if a poll already brought it, the bubble just goes', () => {
  const pendingOnly = [r('a', '1'), r('temp-1', '2', { pending: true })];
  assert.deepEqual(settleThread(pendingOnly, 'temp-1', r('srv-1', '2')).map((m) => m.id), ['a', 'srv-1']);
  const both = [r('a', '1'), r('srv-1', '2'), r('temp-1', '2', { pending: true })];
  assert.deepEqual(settleThread(both, 'temp-1', r('srv-1', '2')).map((m) => m.id), ['a', 'srv-1'], 'never shown twice');
});

// ------------------------------------------------- the photograph, whole

test('MEDIA — an image is shown whole (not cropped) and opens full size; a clip streams on demand', () => {
  const img = renderToStaticMarkup(createElement(MessageMedia, { kind: 'image', url: '/files/support/t/attachments/x.webp', openLabel: 'open' }));
  assert.match(img, /<a href="\/files\/support\/t\/attachments\/x\.webp" target="_blank"/);
  assert.match(img, /object-contain/);
  assert.doesNotMatch(img, /object-cover/);
  const vid = renderToStaticMarkup(createElement(MessageMedia, { kind: 'video', url: '/files/support/t/video/x.mp4', openLabel: 'open' }));
  assert.match(vid, /<video[^>]*controls/);
  assert.match(vid, /preload="metadata"/);
  assert.equal(renderToStaticMarkup(createElement(MessageMedia, { kind: 'text', url: null, openLabel: 'open' })), '');
});

// ------------------------------------------------- the admin console

test('CONSOLE — one screen, three desks: tickets, order messages and complaints, each with its count', () => {
  const q = code('src/components/adminSupport/SupportQueue.tsx');
  for (const desk of ['tickets', 'messages', 'complaints']) assert.match(q, new RegExp(`id: '${desk}'`));
  assert.match(q, /counts\?\.tickets_waiting/);
  assert.match(q, /counts\?\.chats_unread/);
  assert.match(q, /counts\?\.complaints_open/);
  assert.match(q, /<TicketsDesk \/>/);
  assert.match(q, /<MessagesDesk \/>/);
  // The community panel's own complaint desk, not a copy of it.
  assert.match(q, /import\('\.\.\/adminCommunity\/AdminCommunity'\)\.then\(\(m\) => \(\{ default: m\.ComplaintsDesk \}\)\)/);
  assert.match(code('src/components/adminCommunity/AdminCommunity.tsx'), /export function ComplaintsDesk\(/);
});

test('CONSOLE — «الرسائل» lists the shop’s order threads and opens them in the order modal’s own panel', () => {
  const m = code('src/components/adminSupport/MessagesDesk.tsx');
  assert.match(m, /`\/api\/admin\/chats\$\{filter === 'unread' \? '\?filter=unread' : ''\}`/);
  assert.match(m, /<OrderChatPanel orderId=\{open\.order_id\} active \/>/);
  assert.match(m, /import OrderChatPanel from '\.\.\/adminOrders\/OrderChatPanel'/);
});

test('CONSOLE — the ticket composer is pinned: a shrink-0 sibling AFTER a bounded, scrolling list', () => {
  const d = code('src/components/adminSupport/TicketsDesk.tsx');
  const list = d.indexOf('data-support-thread-messages');
  const composer = d.indexOf('data-support-thread-composer');
  assert.ok(list > 0 && composer > list, 'the composer comes after the list, not inside it');
  assert.match(d, /ref=\{listRef\} className="min-h-0 flex-1 [^"]*overflow-y-auto/);
  assert.match(d, /className="shrink-0 [^"]*" data-support-thread-composer/);
  assert.match(d, /flex h-\[calc\(100dvh-12\.5rem\)\] min-h-\[380px\] flex-col/, 'the thread has a height to scroll within');
  assert.match(d, /useThreadScroll\(listRef, /);
  assert.doesNotMatch(d, /scrollIntoView/, 'scrollIntoView would drag the admin page');
});

test('SCROLL — the list is pinned with scrollTop, and re-pinned when a photo in it finishes loading', () => {
  // Measured at 360px: an evidence photo has no height until its bytes arrive,
  // so a thread scrolled once on open ended a photo's height above its newest
  // message. The hook listens for media loads in the capture phase.
  const h = code('src/lib/supportThread.ts');
  const hook = h.slice(h.indexOf('export function useThreadScroll'));
  assert.match(hook, /el\.scrollTop = el\.scrollHeight/);
  assert.match(hook, /addEventListener\('load', onMedia, true\)/);
  assert.match(hook, /addEventListener\('loadedmetadata', onMedia, true\)/);
  assert.doesNotMatch(hook, /scrollIntoView/);
  for (const path of ['src/pages/Support.tsx', 'src/components/adminCommunity/AdminCommunity.tsx']) {
    assert.match(code(path), /useThreadScroll\(listRef, /, path);
  }
});

test('CONSOLE — the open ticket refreshes itself silently, and a reply appends', () => {
  const d = code('src/components/adminSupport/TicketsDesk.tsx');
  assert.match(d, /pollWhileVisible\(\(\) => \{\s*api\s*\.get<[\s\S]*?>\(`\/api\/support\/admin\/tickets\/\$\{id\}`, \{ mascot: 'silent' \}\)/);
  assert.match(d, /messages: mergeThread\(prev\.messages, d\.messages \|\| \[\]\)/);
  assert.match(d, /messages: settleThread\(prev\.messages, tempId, settled\)/);
  // The old reload-on-reply is gone: nothing re-opens the thread after a send.
  const commit = d.slice(d.indexOf('const commitReply'), d.indexOf('const sendReply'));
  assert.doesNotMatch(commit, /openThread\(/);
});

test('CONSOLE — a picked file is on screen BEFORE its upload starts, and is removed if it fails', () => {
  for (const path of ['src/components/adminSupport/TicketsDesk.tsx', 'src/pages/Support.tsx']) {
    const src = code(path);
    const pick = src.slice(src.indexOf('const onPickFile'));
    const pendingAt = pick.indexOf('addPending(');
    const uploadAt = pick.indexOf('await uploadFile(');
    assert.ok(pendingAt > 0 && uploadAt > pendingAt, `${path}: the preview bubble precedes the upload`);
    assert.match(pick.slice(0, pick.indexOf('finally')), /catch \([a-z]+\) \{\s*dropPending\(/, `${path}: a failed upload removes it`);
  }
});

test('COMPLAINTS — the desk can attach, the reply appends, the thread polls, every status has a chip', () => {
  const c = code('src/components/adminCommunity/AdminCommunity.tsx');
  assert.match(c, /await uploadFile\(file, 'complaint', id\)/);
  assert.match(c, /adminCommunityApi\.replyToComplaint\(id, caption, asNote, uploaded\.key\)/);
  assert.match(c, /settleReply\(tempId, r\?\.message\)/);
  assert.match(c, /`\/api\/admin\/community\/complaints\/\$\{id\}`, \{ mascot: 'silent' \}/);
  assert.match(c, /<MessageMedia/);
  assert.match(c, /\['', 'submitted', 'under_review', 'waiting_customer', 'waiting_merchant', 'resolved', 'rejected', 'closed'\]/);
  const reply = code('src/lib/merchant.ts');
  assert.match(reply, /replyToComplaint: \(id: string, body: string, internal: boolean, fileKey\?: string\)/);
  assert.match(code('src/lib/api.ts'), /purpose: 'receipt' \| 'avatar' \| 'chat' \| 'product' \| 'community' \| 'support' \| 'complaint'/);
});

test('SIDEBAR — «الدعم» carries a badge with the number of people waiting, and the layout draws it', () => {
  const admin = code('src/pages/Admin.tsx');
  assert.match(admin, /const supportWaiting = supportTotal\(useSupportCounts\(\)\);/);
  assert.match(admin, /id: 'support'[^\n]*badge: supportWaiting/);
  const layout = code('src/components/DashboardLayout.tsx');
  assert.match(layout, /badge\?: number;/);
  assert.ok((layout.match(/item\.badge/g) ?? []).length >= 3, 'desktop, collapsed and drawer all show it');
  const counts = code('src/components/adminSupport/supportCounts.ts');
  assert.match(counts, /api\s*\.get<SupportCounts>\('\/api\/admin\/chats\/summary', \{ mascot: 'silent' \}\)/);
});

// ------------------------------------------------------- the customer

test('«تذاكري» — the notification’s link opens the ticket or the complaint, on the tickets tab', () => {
  const s = code('src/pages/Support.tsx');
  assert.match(s, /const \[searchParams\] = useSearchParams\(\);/);
  assert.match(s, /searchParams\.get\('ticket'\)/);
  assert.match(s, /searchParams\.get\('complaint'\)/);
  assert.match(s, /useState<'assistant' \| 'tickets'>\(qTab === 'tickets' \|\| qTicket \|\| qComplaint \? 'tickets' : 'assistant'\)/);
  assert.match(s, /<TicketsTab s=\{s\} lang=\{lang\} refreshKey=\{ticketsRefresh\} target=\{threadTarget\} onTargetOpened=\{\(\) => setThreadTarget\(null\)\} \/>/);
  assert.match(s, /void openThread\(target\.kind, target\.id\);/);
  // And the address the server writes is the address this page reads.
  const notify = readFileSync(join(ROOT, 'worker/lib/engagementNotify.ts'), 'utf8');
  assert.match(notify, /`\/support\?tab=tickets&ticket=\$\{encodeURIComponent\(ticketId\)\}`/);
  assert.match(notify, /`\/support\?tab=tickets&complaint=\$\{encodeURIComponent\(complaintId\)\}`/);
});

test('«تذاكري» — an open thread refreshes silently, keeps the composer pinned, and scrolls only itself', () => {
  const s = code('src/pages/Support.tsx');
  const tab = s.slice(s.indexOf('function TicketsTab'), s.indexOf('export default function Support'));
  assert.match(tab, /pollWhileVisible\(\(\) => \{\s*api\s*\.get<[\s\S]*?>\(threadPaths\(kind, id\)\.read, \{ mascot: 'silent' \}\)/);
  assert.match(tab, /mergeThread\(prev\.messages, d\.messages \|\| \[\]\)/);
  const list = tab.indexOf('data-support-thread>');
  const composer = tab.indexOf('data-support-thread-composer');
  assert.ok(list > 0 && composer > list);
  assert.match(tab, /ref=\{listRef\} className="min-h-0 flex-1 overflow-y-auto/);
  assert.doesNotMatch(tab, /scrollIntoView/);
  assert.doesNotMatch(tab, /object-cover/, 'evidence photos are not cropped');
});

test('«شكاواي» — the reporter’s complaints are listed beside the tickets and answered through their own routes', () => {
  const s = code('src/pages/Support.tsx');
  assert.match(s, /api\.get<\{ complaints: Complaint\[\] \}>\('\/api\/marketplace\/complaints'\)/);
  assert.match(s, /read: `\/api\/marketplace\/complaints\/\$\{id\}`, write: `\/api\/marketplace\/complaints\/\$\{id\}\/messages`, purpose: 'complaint' as const/);
  assert.match(s, /openThread\('complaint', c\.id\)/);
});

test('TICKET FORM — one key per confirm step, sent with the ticket', () => {
  const s = code('src/pages/Support.tsx');
  const form = s.slice(s.indexOf('function TicketForm'), s.indexOf('export interface ThreadTarget'));
  const mint = form.indexOf('idemKey.current = newIdempotencyKey();');
  const confirm = form.indexOf("setStep('confirm');");
  assert.ok(mint > 0 && confirm > mint, 'minted as the confirm step opens');
  assert.match(form, /idempotencyKey: idemKey\.current \|\| undefined,/);
});

test('BELL — a row with nowhere to go opens in place instead of closing the panel on a clipped sentence', () => {
  const b = code('src/components/notifications/NotificationBell.tsx');
  assert.match(b, /if \(n\.link\) close\(false\);\s*else setExpandedId\(\(cur\) => \(cur === n\.id \? null : n\.id\)\);/);
  assert.match(b, /expanded \? 'whitespace-pre-wrap break-words' : 'line-clamp-2'/);
  assert.match(b, /expanded=\{expandedId === n\.id\}/);
});

// ------------------------------------------------------------ repair round

test('«الرسائل» — the open order thread refreshes itself silently, merged by id (OrderChatPanel)', () => {
  const p = code('src/components/adminOrders/OrderChatPanel.tsx');
  assert.match(
    p,
    /return pollWhileVisible\(\(\) => \{\s*api\s*\.get<\{ messages: ChatMessage\[\] \}>\(`\/api\/chats\/\$\{chatId\}\/messages`, \{ mascot: 'silent' \}\)\s*\.then\(\(d\) => setMessages\(\(prev\) => mergeThread\(prev, d\.messages \|\| \[\]\)\)\)/
  );
  assert.match(p, /if \(!active \|\| !chatId \|\| error != null\) return;/, 'only while shown, and not over an error');
  assert.match(p, /\}, \[active, chatId, error\]\);/);
  // The console mounts that same panel for the open thread.
  assert.match(code('src/components/adminSupport/MessagesDesk.tsx'), /<OrderChatPanel orderId=\{open\.order_id\} active \/>/);
});

test('«الرسائل» — an attachment-only last message is previewed by its real kind', async () => {
  const { previewLabel, CONSOLE_STRINGS } = await import('../src/components/adminSupport/strings');
  const cs = CONSOLE_STRINGS.ar;
  assert.equal(previewLabel('video', cs), 'فيديو');
  assert.equal(previewLabel('audio', cs), 'رسالة صوتية');
  assert.equal(previewLabel('file', cs), 'ملف');
  assert.equal(previewLabel('image', cs), 'صورة');
  assert.equal(previewLabel('text', cs), '');
  const d = code('src/components/adminSupport/MessagesDesk.tsx');
  assert.match(d, /const preview = r\.last_message\.body \|\| previewLabel\(k, cs\);/);
  assert.match(d, /k === 'audio' && <Mic/);
  assert.match(d, /k === 'file' && <FileText/);
});

test('«تذاكري» — tapping the same reply link again retargets: the effect runs on every navigation key', () => {
  const s = code('src/pages/Support.tsx');
  assert.match(s, /const \{ state, key: locationKey \} = useLocation\(\);/);
  assert.match(s, /\}, \[qTab, qTicket, qComplaint, locationKey\]\);/);
});

test('COMPLAINTS — a row the reporter answered is marked, and leaving a case re-reads the badge', () => {
  const a = code('src/components/adminCommunity/AdminCommunity.tsx');
  assert.match(a, /\{c\.awaiting_reply === 1 && \(\s*<span data-complaint-awaiting/);
  assert.match(a, /onBack=\{\(\) => \{ setOpen\(null\); load\(\); void refreshSupportCounts\(\); \}\}/);
});
