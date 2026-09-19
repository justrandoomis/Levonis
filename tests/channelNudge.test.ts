/**
 * «فعّل قناة لتصلك الإشعارات» — the rules that decide whether the post-success
 * window is helpful or a nag.
 *
 * Every assertion here is one way the window would be WRONG, not a restatement
 * of the code:
 *
 *   - shown to somebody who is already reachable → pure noise, and the fastest
 *     way to teach a customer to dismiss everything this app ever shows them.
 *   - shown with no activatable channel → a call to action that dead-ends,
 *     which is the same lie in a friendlier voice.
 *   - shown after «ليس الآن» → the owner said declining is a real answer
 *     («إذا يريد أن يفعل إحدى القنوات أو لا»); ignoring it is nagging.
 *   - never shown again, ever → the opposite failure. The quiet period expires.
 *   - one generic sentence → the owner asked for the order, the community
 *     request and the ticket to be named separately.
 *   - a throw from localStorage → a BLANK SCREEN where a paid order's
 *     confirmation should be. Safari private mode throws on access, not on
 *     read, so even reaching for storage is wrapped.
 *   - a missing language → `loc(ar, en, ckb)` falls back to Arabic for ckb,
 *     which silently serves Arabic to Kurdish customers.
 *
 * The component is imported for real (node runs it through tsx), so the
 * predicates under test are the ones that actually ship — not a copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHANNEL_NUDGE_ACTION_LABEL,
  CHANNEL_NUDGE_COPY,
  CHANNEL_NUDGE_DISMISS_KEY,
  CHANNEL_NUDGE_DISMISS_MS,
  browserStorage,
  isChannelNudgeDismissed,
  nudgeActions,
  readChannelNudgeDismissedUntil,
  recordChannelNudgeDismissal,
  shouldOfferChannelNudge,
  type NudgeContext,
} from '../src/components/notify/ChannelNudge';
import type { NotifyChannelReadiness, NotifyChannelState } from '../src/lib/api';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** A memory that behaves, for the tests that are not about storage failing. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** Storage that throws on every operation — Safari private mode, and an
 *  iframe with third-party storage blocked. */
const hostileStorage = {
  getItem(): string {
    throw new Error('SecurityError');
  },
  setItem(): void {
    throw new Error('SecurityError');
  },
  removeItem(): void {
    throw new Error('SecurityError');
  },
};

const channel = (over: Partial<NotifyChannelState> & { channel: string }): NotifyChannelState => ({
  ready: false,
  blocker: 'ACCOUNT_NO_DESTINATION',
  destination_masked: null,
  can_activate: false,
  action: null,
  ...over,
});

const TELEGRAM_HREF = '/settings#settings-linking';

/** The server's answer for an account nobody can reach, on a deployment whose
 *  bot IS answering: Telegram and WhatsApp both point at Telegram linking,
 *  which is `channelReadiness`'s deliberate behaviour (a phone number is only
 *  ever written after Telegram contact verification). */
function unreachable(): NotifyChannelReadiness {
  return {
    channels: [
      channel({ channel: 'inapp', ready: true, blocker: null }),
      channel({ channel: 'telegram', can_activate: true, action: { kind: 'link_telegram', href: TELEGRAM_HREF } }),
      channel({ channel: 'whatsapp', can_activate: true, action: { kind: 'link_telegram', href: TELEGRAM_HREF } }),
      channel({ channel: 'email', blocker: 'ACCOUNT_NOT_VERIFIED', can_activate: true, action: { kind: 'verify_email', href: '/settings' } }),
    ],
    any_outbound_ready: false,
    recommended: 'inapp',
    primary_channel: '',
    delivery: ['inapp'],
  };
}

/** The same account once Telegram is linked. */
function reachable(): NotifyChannelReadiness {
  const r = unreachable();
  r.channels = r.channels.map((c) =>
    c.channel === 'telegram' ? channel({ channel: 'telegram', ready: true, blocker: null, destination_masked: '+964•••1234' }) : c
  );
  r.any_outbound_ready = true;
  r.recommended = 'telegram';
  r.delivery = ['inapp', 'telegram'];
  return r;
}

// --------------------------------------------------------------- the predicate

test('a customer we can already reach is never asked', () => {
  const storage = memoryStorage();
  assert.equal(shouldOfferChannelNudge(reachable(), storage, Date.now()), false);
});

test('a customer we cannot reach off-site is offered the channels', () => {
  const storage = memoryStorage();
  assert.equal(shouldOfferChannelNudge(unreachable(), storage, Date.now()), true);
});

test('no readiness answer means no window — not knowing is never a reason to interrupt', () => {
  assert.equal(shouldOfferChannelNudge(null, memoryStorage(), Date.now()), false);
  assert.equal(shouldOfferChannelNudge(undefined, memoryStorage(), Date.now()), false);
});

test('the in-app floor alone is not an outbound win, but it is also not an offer', () => {
  // A deployment with no Telegram token, no WhatsApp and no email: nothing is
  // ready, nothing can be activated, and there is nothing honest to offer.
  const nothingConfigured: NotifyChannelReadiness = {
    channels: [
      channel({ channel: 'inapp', ready: true, blocker: null }),
      channel({ channel: 'telegram', blocker: 'DEPLOYMENT_NOT_CONFIGURED' }),
      channel({ channel: 'whatsapp', blocker: 'DEPLOYMENT_NOT_CONFIGURED' }),
      channel({ channel: 'email', blocker: 'DEPLOYMENT_NOT_CONFIGURED' }),
    ],
    any_outbound_ready: false,
    recommended: 'inapp',
    primary_channel: '',
    delivery: ['inapp'],
  };
  assert.equal(nudgeActions(nothingConfigured).length, 0);
  assert.equal(shouldOfferChannelNudge(nothingConfigured, memoryStorage(), Date.now()), false);
});

// ------------------------------------------------------------------ the buttons

test('telegram and whatsapp are one tap, and the label says both', () => {
  const actions = nudgeActions(unreachable());
  assert.equal(actions.length, 2, 'one link_telegram action and one verify_email action');
  const linking = actions[0];
  assert.equal(linking.label, 'link_telegram_whatsapp');
  assert.deepEqual(linking.channels, ['telegram', 'whatsapp']);
  // The href is the SERVER's, never a path invented in the client.
  assert.equal(linking.href, TELEGRAM_HREF);
  assert.equal(actions[1].label, 'verify_email');
});

test('telegram alone keeps the telegram-only label', () => {
  const r = unreachable();
  r.channels = r.channels.filter((c) => c.channel !== 'whatsapp' && c.channel !== 'email');
  const actions = nudgeActions(r);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].label, 'link_telegram');
});

test('a channel that cannot be activated produces no button', () => {
  const r = unreachable();
  // The shop's WhatsApp phone is logged out and the bot is not answering.
  r.channels = r.channels.map((c) => channel({ ...c, can_activate: false, action: null }));
  assert.deepEqual(nudgeActions(r), []);
});

test('a ready channel is never offered as something to turn on', () => {
  assert.equal(
    nudgeActions(reachable()).some((a) => a.channels.includes('telegram')),
    false
  );
});

// ---------------------------------------------------------------- the dismissal

test('«ليس الآن» is honoured, and it expires', () => {
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  const until = recordChannelNudgeDismissal(storage, now);
  assert.equal(until, now + CHANNEL_NUDGE_DISMISS_MS);
  assert.equal(storage.getItem(CHANNEL_NUDGE_DISMISS_KEY), String(until));

  assert.equal(isChannelNudgeDismissed(storage, now), true);
  assert.equal(shouldOfferChannelNudge(unreachable(), storage, now + 1000), false);
  // A day later: still quiet.
  assert.equal(shouldOfferChannelNudge(unreachable(), storage, now + 24 * 60 * 60 * 1000), false);
  // The boundary is exclusive: at exactly `until` the quiet period is over.
  assert.equal(isChannelNudgeDismissed(storage, until), false);
  assert.equal(shouldOfferChannelNudge(unreachable(), storage, until), true);
});

test('the dismissal is one answer for all three contexts, not three', () => {
  // The question is the same question. A person who declined after an order
  // must not be asked again two hours later because the next success was a
  // ticket — that is exactly the nagging «أو لا» rules out.
  const storage = memoryStorage();
  const now = Date.now();
  recordChannelNudgeDismissal(storage, now);
  /**
   * BE HONEST ABOUT WHAT THIS LOOP PROVES. `shouldOfferChannelNudge` takes no
   * context, so the three iterations run one identical assertion three times —
   * it holds the line at the SIGNATURE level ("one answer, not three") and
   * nothing more. If a context parameter is ever added to that function, this
   * loop starts testing three different things and the intent above is what it
   * should be held to; until then, do not read it as covering more than it does.
   */
  const contexts: NudgeContext[] = ['order', 'request', 'ticket'];
  for (const context of contexts) {
    assert.ok(CHANNEL_NUDGE_COPY[context], `${context} has copy`);
    assert.equal(shouldOfferChannelNudge(unreachable(), storage, now), false);
  }
  assert.equal(
    shouldOfferChannelNudge.length,
    3,
    'the memory is context-free by construction: readiness, storage, now — and no context'
  );
});

test('a corrupted or hostile stored value reads as «not dismissed», never as a crash', () => {
  const storage = memoryStorage();
  for (const junk of ['', 'soon', '-1', 'NaN', '0']) {
    storage.setItem(CHANNEL_NUDGE_DISMISS_KEY, junk);
    assert.equal(readChannelNudgeDismissedUntil(storage), 0, `«${junk}» is not an expiry`);
    assert.equal(shouldOfferChannelNudge(unreachable(), storage, Date.now()), true);
  }
});

// ------------------------------------------------- storage that is not there

test('a throwing localStorage never reaches the render', () => {
  // Every read AND every write. The worst outcome allowed here is one extra
  // offer; the worst outcome forbidden is an exception escaping into a success
  // screen the customer has just paid for.
  assert.doesNotThrow(() => readChannelNudgeDismissedUntil(hostileStorage));
  assert.equal(readChannelNudgeDismissedUntil(hostileStorage), 0);
  assert.doesNotThrow(() => recordChannelNudgeDismissal(hostileStorage, Date.now()));
  assert.doesNotThrow(() => isChannelNudgeDismissed(hostileStorage, Date.now()));
  assert.equal(shouldOfferChannelNudge(unreachable(), hostileStorage, Date.now()), true);

  // No storage at all is the same answer, not a different code path.
  assert.equal(readChannelNudgeDismissedUntil(null), 0);
  assert.equal(readChannelNudgeDismissedUntil(undefined), 0);
  assert.equal(shouldOfferChannelNudge(unreachable(), null, Date.now()), true);
});

test('even REACHING for localStorage is wrapped — the getter itself throws when storage is blocked', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: storage is disabled');
    },
  });
  try {
    assert.doesNotThrow(() => browserStorage());
    assert.equal(browserStorage(), null);
    assert.equal(shouldOfferChannelNudge(unreachable(), browserStorage(), Date.now()), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('no raw localStorage access survives in the component', () => {
  const source = read('src/components/notify/ChannelNudge.tsx');
  // Everything goes through browserStorage()/readChannelNudgeDismissedUntil(),
  // which are the wrapped paths the tests above cover. A direct
  // `localStorage.getItem` anywhere else would be an unguarded throw.
  assert.doesNotMatch(source, /localStorage\.(getItem|setItem|removeItem)/);
});

// ----------------------------------------------------------------- the copy

test('three contexts produce three different sentences', () => {
  const contexts: NudgeContext[] = ['order', 'request', 'ticket'];
  for (const lane of ['title', 'body'] as const) {
    const seen = new Set(contexts.map((c) => CHANNEL_NUDGE_COPY[c][lane][0]));
    assert.equal(seen.size, 3, `the Arabic ${lane} is specific to each context`);
    const english = new Set(contexts.map((c) => CHANNEL_NUDGE_COPY[c][lane][1]));
    assert.equal(english.size, 3, `the English ${lane} is specific to each context`);
    const sorani = new Set(contexts.map((c) => CHANNEL_NUDGE_COPY[c][lane][2]));
    assert.equal(sorani.size, 3, `the Sorani ${lane} is specific to each context`);
  }
  // And each names the thing that was just done, as the owner asked.
  assert.match(CHANNEL_NUDGE_COPY.order.body[0], /طلبك/);
  assert.match(CHANNEL_NUDGE_COPY.request.body[0], /عروض|المجتمع/);
  assert.match(CHANNEL_NUDGE_COPY.ticket.body[0], /تذكرت/);
});

test('the title confirms before it offers — a success must never read as a failure', () => {
  // «طلبك تم» first, the offer second. Each title is a statement that the
  // thing SUCCEEDED, so the window cannot be misread as "it did not go
  // through". The offer lives in the body.
  assert.match(CHANNEL_NUDGE_COPY.order.title[0], /^تم /);
  assert.match(CHANNEL_NUDGE_COPY.request.title[0], /^تم /);
  assert.match(CHANNEL_NUDGE_COPY.ticket.title[0], /^تم /);
  for (const context of ['order', 'request', 'ticket'] as const) {
    assert.doesNotMatch(CHANNEL_NUDGE_COPY[context].title[0], /فعّل|قناة/);
  }
});

test('every string carries all three languages, and none falls back to Arabic', () => {
  const trios: Array<[string, readonly string[]]> = [];
  for (const [context, copy] of Object.entries(CHANNEL_NUDGE_COPY)) {
    trios.push([`${context}.title`, copy.title], [`${context}.body`, copy.body]);
  }
  for (const [kind, trio] of Object.entries(CHANNEL_NUDGE_ACTION_LABEL)) {
    trios.push([`action.${kind}`, trio]);
  }
  for (const [name, trio] of trios) {
    assert.equal(trio.length, 3, `${name} is [ar, en, ckb]`);
    for (const [index, text] of trio.entries()) {
      assert.equal(typeof text, 'string');
      assert.ok(text.trim().length > 0, `${name}[${index}] is not empty`);
    }
    // ckb === ar means somebody pasted the Arabic in and a Kurdish customer
    // is being served Arabic — the exact failure `loc`'s own fallback exists
    // to make survivable, and which we must not ship deliberately.
    assert.notEqual(trio[2], trio[0], `${name} has real Sorani, not the Arabic`);
  }
});

test('every inline sentence in the component is trilingual too', () => {
  const source = read('src/components/notify/ChannelNudge.tsx');
  /**
   * COMMENTS ARE PROSE, NOT CODE. This file's own header explains the rule by
   * quoting it, so the walk runs over the source with every block and line
   * comment removed — otherwise the explanation of the bug would read as the
   * bug.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // `loc(` is called with THREE arguments everywhere, or with a spread of a
  // trio. Two arguments is the bug this walks the source to catch: it compiles
  // (ckb is optional) and silently serves Arabic to Kurdish customers.
  let cursor = 0;
  let checked = 0;
  for (;;) {
    const at = code.indexOf('loc(', cursor);
    if (at === -1) break;
    cursor = at + 4;
    let depth = 1;
    let index = cursor;
    let comma = 0;
    /** Quoted text is DATA, not syntax: «Either way, the updates…» carries a
     *  comma of its own, and a scanner that counted it would report a
     *  perfectly good trilingual call as a four-argument one. */
    let quote = '';
    for (; index < code.length && depth > 0; index++) {
      const ch = code[index];
      if (quote) {
        if (ch === '\\') index++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 1) comma++;
    }
    const args = code.slice(cursor, index - 1).trim();
    if (args.startsWith('...')) {
      checked++;
      continue; // a trio, already asserted above
    }
    // A multi-line call ends with a trailing comma, which is a separator with
    // nothing after it rather than a fourth argument.
    const arity = comma + (args.endsWith(',') ? 0 : 1);
    assert.equal(arity, 3, `loc() at offset ${at} passes ar, en and ckb: ${args.slice(0, 60)}`);
    checked++;
  }
  assert.ok(checked >= 4, 'the walk actually found the calls');
  // And the forbidden idiom never appears in the code: 'ckb' is right-to-left
  // too, so that ternary serves Arabic to Kurdish customers.
  assert.doesNotMatch(code, /dir\s*===\s*'rtl'\s*\?/);
});

// ------------------------------------------------------------- the wiring

test('the window is mounted after an order, a request and a ticket — and nowhere else', () => {
  const checkout = read('src/pages/Checkout.tsx');
  const requests = read('src/pages/Requests.tsx');
  const support = read('src/pages/Support.tsx');

  // Checkout: inside the `placedOrder` success branch, so it cannot exist
  // before the order does.
  assert.match(checkout, /<ChannelNudge context="order" active \/>/);
  const successBranch = checkout.indexOf('if (placedOrder) {');
  assert.ok(successBranch > 0);
  assert.ok(checkout.indexOf('<ChannelNudge context="order"') > successBranch);

  // Requests and Support: latched on the creation callback, never on a list.
  assert.match(requests, /setRequestJustCreated\(true\)/);
  assert.match(requests, /<ChannelNudge context="request" active=\{requestJustCreated\} \/>/);
  assert.match(support, /setTicketJustOpened\(true\)/);
  assert.match(support, /<ChannelNudge context="ticket" active=\{ticketJustOpened\} \/>/);
});

test('it is the app’s own sheet, non-blocking, and it never invents a path', () => {
  const source = read('src/components/notify/ChannelNudge.tsx');
  // The primitive, not a twenty-fifth hand-rolled `fixed inset-0 bg-black/80`.
  assert.match(source, /import \{ Sheet \} from '\.\.\/ui\/Overlay'/);
  assert.match(source, /<Sheet/);
  // 'parallel' is the mode with no scrim and no scroll lock: the success
  // screen behind it stays live. A modal here would block a customer who just
  // wants to read their order number.
  assert.match(source, /mode="parallel"/);
  /**
   * AND IT DOES NOT SWALLOW THE PAGE'S TAPS. `Overlay` puts every window in a
   * `fixed inset-0` container; with no scrim to justify it, that container is
   * an invisible pane over the whole success screen unless it is explicitly
   * transparent to the pointer. Without this pair the window would block
   * exactly what it promises not to block, and nothing about it would look
   * wrong on a screenshot.
   */
  assert.match(source, /className="pointer-events-none"/);
  assert.match(source, /panelClassName="pointer-events-auto/);
  // Hit targets and focus, per the UI system.
  assert.match(source, /min-h-\[48px\]/);
  assert.match(source, /min-h-\[44px\]/);
  assert.match(source, /focus-visible:ring-2 focus-visible:ring-focus/);
  // Every arbitrary text size states its own leading.
  for (const size of source.match(/text-\[[\d.]+px\]/g) ?? []) {
    const at = source.indexOf(size);
    const className = source.slice(source.lastIndexOf('"', at) + 1, source.indexOf('"', at));
    assert.match(className, /leading-/, `${size} states its leading`);
  }
  // The href comes from the server's `action`, so it cannot rot when the
  // settings anchor moves.
  assert.match(source, /href: action\.href/);
  assert.doesNotMatch(source, /to="\/settings/);
});

// ------------------------------- the sentence that makes a promise, not an offer

test('the in-app reassurance is only shown to a customer for whom it is TRUE', () => {
  /**
   * THE ONE SENTENCE IN THIS WINDOW THAT CAN BE FALSE. Everything else is an
   * offer; «في كل الأحوال ستجد التحديثات داخل التطبيق» is a PROMISE.
   *
   * worker/lib/channelReadiness.ts keeps 'inapp' in `delivery` for every
   * signed-in account EXCEPT somebody who has switched the in-app inbox off in
   * their own preferences. That person also has `any_outbound_ready === false`,
   * so they are exactly who this window appears for — and telling them their
   * updates are waiting in an inbox they silenced talks the one customer who
   * most needs the offer out of taking it.
   *
   * `delivery` is already on the response the component reads, so the check
   * costs nothing. Asserted at the source because there is no DOM runner here;
   * the branch and both sentences are what is pinned.
   */
  const source = read('src/components/notify/ChannelNudge.tsx');
  assert.match(source, /const inappIsOn = \(readiness\.delivery \?\? \[\]\)\.includes\('inapp'\)/);
  assert.match(source, /\{inappIsOn \? \(/);
  // The true-branch sentence stays exactly as it was for everybody else…
  assert.match(source, /في كل الأحوال ستجد التحديثات داخل التطبيق/);
  // …and the other branch says what is actually true for that customer,
  // instead of the line that would mislead them.
  assert.match(source, /إشعارات التطبيق مطفأة عندك/);
  // A missing field on an older worker's answer must produce a missing
  // sentence, never a thrown render over a paid order.
  assert.match(source, /readiness\.delivery \?\? \[\]/);
});

test('Telegram is spelled the way the rest of the app spells it', () => {
  /**
   * The codebase writes «تيليغرام» with غ in 53 places, including the linking
   * screen these very buttons navigate to. A gold button reading تيليجرام that
   * lands on a page headed تيليغرام makes a customer stop and wonder whether
   * they tapped the right thing — at the exact moment the window is asking them
   * to trust it with a channel.
   */
  const source = read('src/components/notify/ChannelNudge.tsx');
  assert.match(source, /'تفعيل تيليغرام'/);
  assert.match(source, /'تفعيل تيليغرام وواتساب'/);
  assert.doesNotMatch(source, /تيليجرام/, 'the ج spelling appears nowhere in this file');
});

test('publishing a request does not remount the window — one fetch, one answer', () => {
  /**
   * THE DEFECT THIS PINS. `<ChannelNudge context="request">` lived in TWO
   * mutually exclusive returns: a fragment when a request was open, and inside
   * the board `<div>` otherwise. Different positions in the tree, so React
   * unmounted and remounted it on every toggle — and publishing toggles
   * immediately, because `onCreated` moves the URL and the deep-link effect
   * then sets `open`.
   *
   * Two costs. A wasted readiness GET per publish, on a route the server marks
   * `no-store` so neither call could be served from cache. And worse: Escape or
   * a drag records NOTHING deliberately — it means "not this window", not
   * «ليس الآن» — so pressing Back remounted the component with `active` still
   * latched and popped the sheet again 1.6 seconds later. To the customer that
   * is a window refusing to go away, which is the nagging «أو لا» forbids.
   *
   * The fix is structural, so the assertion is structural: ONE return, with the
   * element in the same position in both branches.
   */
  const source = read('src/pages/Requests.tsx');
  // Comments are stripped first: the note ABOVE the element quotes `{nudge}`
  // to explain itself, and an assertion that counted that would pass for the
  // very arrangement it is meant to forbid.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const occurrences = code.match(/\{nudge\}/g) ?? [];
  assert.equal(occurrences.length, 1, 'the window is rendered from exactly one place');
  // And that one place is AFTER the branch closes, so the instance survives the
  // board → detail transition rather than being torn down and rebuilt.
  const branch = code.indexOf('{open ? (');
  assert.ok(branch > 0, 'the two screens are one conditional inside one return');
  assert.ok(code.indexOf('{nudge}') > branch, 'the window sits outside the conditional, not in a arm of it');
  assert.doesNotMatch(code, /if \(open\)\s*\n\s*return \(/, 'the second early return is gone');
});
