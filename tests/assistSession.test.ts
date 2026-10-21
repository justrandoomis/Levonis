/**
 * THE SUPPORT ASSISTANT'S CONVERSATION BELONGS TO ONE IDENTITY (support
 * assistant v2, push A; review round 2).
 *
 * src/lib/assistSession.ts keeps the transcript (order ids, order status, the
 * masked device names, the customer's own typed lines), the ticket draft with
 * its device, the attachment keys and the server context in this tab's
 * sessionStorage. Signing out navigates inside the app without a reload, so
 * the next account (or a guest) opening /support in the same tab got all of it
 * back. The auth layer now names the owner on every identity change
 * (`adoptAssistOwner`), and a conversation held for a signed-in user is
 * dropped the moment another identity takes the tab; an open Support page
 * resets on the event. A guest who signs in keeps the conversation they
 * started.
 *
 * Run: node --import tsx --test tests/assistSession.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

const storage = new MemoryStorage();
const page = new EventTarget();
Object.assign(globalThis, { sessionStorage: storage, window: page });

const session = await import('../src/lib/assistSession');

/** Customer A, as Support.tsx writes it. */
function customerA() {
  session.saveAssistState({
    messages: [{ role: 'user', text: 'وين وصل طلبي ORD-AAAA1111', typed: true }],
    attachments: [{ key: 'assist/u_A/attachments/abc.webp', url: '/files/assist/u_A/attachments/abc.webp', kind: 'image' }],
    draft: { subject: 'A1 clog', body: '- my typed lines', unitId: 'unit_of_A' },
  });
  session.saveAssistContext({ v: 1, printer: { model: 'A1', unit_id: 'unit_of_A' } });
}

test('signing out, or another account, drops the conversation, the draft, the files and the context, and tells the open page', () => {
  storage.clear();
  session.adoptAssistOwner('u_A');
  customerA();
  let resets = 0;
  const onReset = () => resets++;
  page.addEventListener(session.ASSIST_CLEARED_EVENT, onReset);
  try {
    // A signs out: the identity becomes a guest.
    session.adoptAssistOwner(null);
    assert.equal(session.loadAssistState(), undefined, 'the guest never reads A’s transcript');
    assert.equal(session.loadAssistContext(), undefined, 'nor A’s context');
    assert.equal(resets, 1, 'an open Support page resets');

    // A again, then B signs in in the same tab.
    session.adoptAssistOwner('u_A');
    customerA();
    session.adoptAssistOwner('u_B');
    assert.equal(session.loadAssistState(), undefined, 'B never reads A’s transcript');
    assert.equal(session.loadAssistContext(), undefined);
    assert.equal(resets, 2);
  } finally {
    page.removeEventListener(session.ASSIST_CLEARED_EVENT, onReset);
  }
});

test('the same account (a reload) keeps it, and a guest who signs in keeps the conversation they started', () => {
  storage.clear();
  session.adoptAssistOwner('u_A');
  customerA();
  session.adoptAssistOwner('u_A');
  assert.ok(session.loadAssistState(), 'a reload of the same account keeps the conversation');

  storage.clear();
  session.adoptAssistOwner(null);
  session.saveAssistState({ messages: [{ role: 'user', text: 'كلوب', typed: true }], attachments: [], draft: { subject: 'A1: clog', body: 'steps' } });
  session.adoptAssistOwner('u_B');
  assert.deepEqual((session.loadAssistState() as { draft: { subject: string } }).draft.subject, 'A1: clog', 'the draft survives the trip to the sign-in page');
  // And from then on it is B's: B signing out drops it.
  session.adoptAssistOwner(null);
  assert.equal(session.loadAssistState(), undefined);
});

test('a conversation stored with no owner on record is not trusted', () => {
  storage.clear();
  customerA();
  session.adoptAssistOwner('u_B');
  assert.equal(session.loadAssistState(), undefined);
  assert.equal(session.loadAssistContext(), undefined);
});

test('the auth layer names the owner on every identity change, and the Support page resets on the event', () => {
  const auth = readFileSync(join(ROOT, 'src/AuthContext.tsx'), 'utf8');
  const setUser = auth.slice(auth.indexOf('const setUser = useCallback'), auth.indexOf('useEffect(purgeLegacyPrivateDrafts'));
  assert.match(setUser, /adoptAssistOwner\(next \? next\.id : null\)/);
  const support = readFileSync(join(ROOT, 'src/pages/Support.tsx'), 'utf8');
  assert.match(support, /addEventListener\(ASSIST_CLEARED_EVENT, reset\)/);
  const reset = support.slice(support.indexOf('const reset = () => {'), support.indexOf('window.addEventListener(ASSIST_CLEARED_EVENT'));
  for (const piece of ['contextRef.current = undefined', 'setDraft(undefined)', 'setAttachments([])', 'setMessages(']) assert.ok(reset.includes(piece), piece);
});
