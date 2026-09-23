/**
 * THE BLOCKING WAIT, AND THE ONE MOMENT AN ORDER IS ALLOWED TO BE MERRY.
 *
 * Two owner reports, one screen: «حركة البلوب عند تأكيد الطلب خاطئة ومتقطعة،
 * ولا توجد شاشة تحميل مركزية في أي مكان تمنع الضغط المزدوج أو الإرهاق».
 *
 * WHAT THESE GUARD, and why each one is a different KIND of test.
 *
 *   THE STORE is real behaviour and is tested as behaviour: two overlapping
 *   holds, a release that must not lift somebody else's, and the session
 *   counter the overlay times its delay and its ceiling from.
 *
 *   THE ARRIVAL is real behaviour too. `celebrate` used to be triggered when
 *   the HTTP response resolved, and a header-to-stage descent takes about
 *   1.3s — so the 1.5s window was mostly spent before the character got
 *   anywhere near the news. The controller now decides by DESTINATION, and
 *   the test that matters most is the negative one: an ordinary route arrival
 *   must still be a 320ms `arrival` and nothing else.
 *
 *   THE WIRING is source shape, because there is nothing else it could be.
 *   The lesson this whole round exists to encode is that a fix reported done
 *   with its client half missing is not a fix: a primitive nothing calls
 *   protects nobody, and a unit test of the primitive would pass happily
 *   while the owner watched the same double-tap go through. So the call sites
 *   are pinned by name, in the files that own the money path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginBusy, busyStore, resetBusyForTests } from '../src/lib/busy';
import { createMascotController, type MascotClock } from '../src/lib/mascot';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
/**
 * PROSE ABOUT A RULE IS NOT THE RULE. Every contract comment in these files
 * quotes the thing it replaced — `role="dialog"`, `animate-in fade-in
 * zoom-in-95` — so an assertion made against the raw text would be satisfied,
 * or broken, by an explanation rather than by code.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const appBusy = read('../src/components/ui/AppBusy.tsx');
const checkout = read('../src/pages/Checkout.tsx');
const storeCheckout = read('../src/pages/StoreCheckout.tsx');
const app = read('../src/App.tsx');
const overlay = read('../src/components/ui/Overlay.tsx');
const intro = read('../src/components/bloub/AppIntro.tsx');

// ------------------------------------------------------------------ the store

test('two overlapping holds: the first to finish does not free the screen', () => {
  resetBusyForTests();
  const releaseQuote = beginBusy('quote');
  const releaseOrder = beginBusy('order');
  // An order in flight outranks the re-quote it may have been waiting on.
  assert.equal(busyStore.snapshot().reason, 'order');
  releaseOrder();
  assert.equal(busyStore.snapshot().reason, 'quote', 'the quote still has a hold');
  releaseQuote();
  assert.equal(busyStore.snapshot().reason, null);
  resetBusyForTests();
});

test('a release is idempotent — a double release cannot free somebody else', () => {
  resetBusyForTests();
  const first = beginBusy('order');
  const second = beginBusy('order');
  first();
  first();
  first();
  assert.equal(busyStore.snapshot().reason, 'order', 'the second hold is untouched');
  second();
  assert.equal(busyStore.snapshot().reason, null);
  resetBusyForTests();
});

test('the session counter counts WAITS, not holds', () => {
  resetBusyForTests();
  const start = busyStore.snapshot().session;
  const a = beginBusy('quote');
  const b = beginBusy('order');
  assert.equal(busyStore.snapshot().session, start + 1, 'joining an existing wait is not a new one');
  b();
  a();
  const c = beginBusy('order');
  assert.equal(busyStore.snapshot().session, start + 2, 'a wait that starts from idle is');
  c();
  resetBusyForTests();
});

test('subscribers are notified only when the answer changes', () => {
  resetBusyForTests();
  let calls = 0;
  const stop = busyStore.subscribe(() => { calls += 1; });
  const a = beginBusy('order');
  const b = beginBusy('order');
  assert.equal(calls, 1, 'a second hold with the same reason says nothing new');
  b();
  assert.equal(calls, 1);
  a();
  assert.equal(calls, 2);
  stop();
  resetBusyForTests();
});

test('the snapshot is a stable frozen object, so useSyncExternalStore cannot loop', () => {
  resetBusyForTests();
  const first = busyStore.snapshot();
  assert.equal(busyStore.snapshot(), first, 'identity must be stable while nothing changes');
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(busyStore.serverSnapshot(), { reason: null, session: 0 });
  resetBusyForTests();
});

// ------------------------------------------------- the arrival that celebrates

function clockFixture() {
  let now = 0;
  let counter = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: MascotClock = {
    now: () => now,
    setTimer(fn, ms) { const id = ++counter; timers.set(id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer(id) { timers.delete(id as unknown as number); },
  };
  return { controller: createMascotController(clock), advance(ms: number) {
    const end = now + ms;
    for (let n = 0; n < 100; n += 1) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      now = first[1].at; timers.delete(first[0]); first[1].fn();
    }
    now = end;
  } };
}

test('an ordinary arrival is still arrival — the default must not celebrate', () => {
  const { controller: c } = clockFixture();
  c.navigationComplete();
  assert.equal(c.snapshot().state, 'arrival');
  c.dispose();
});

test('landing on a stage celebrates, and it lasts the full window FROM THE LANDING', () => {
  const { controller: c, advance } = clockFixture();
  // The order resolved: the mood is raised while the character is still in
  // the header, and the descent begins.
  c.outcome('ordered');
  assert.equal(c.snapshot().state, 'celebrate');
  // ~1.3s of travel later it touches down. Under the old code the window was
  // already spent and `arrival` was what played here.
  advance(1300);
  c.navigationComplete('stage');
  assert.equal(c.snapshot().state, 'celebrate', 'the landing is the merry moment');
  advance(1400);
  assert.equal(c.snapshot().state, 'celebrate', 'and it is still running 1.4s after the landing');
  advance(200);
  assert.equal(c.snapshot().state, 'idle', 'then calm');
  c.dispose();
});

test('a journey that was in flight during a loading request still lands celebrating', () => {
  // The priority ladder, not the call order, is what decides. `loading` is
  // work at 80 and outranks a reaction at 65 — which is exactly why the
  // post-order wallet read had to be marked background (see below).
  const { controller: c } = clockFixture();
  const release = c.begin('loading');
  c.navigationComplete('stage');
  assert.equal(c.snapshot().state, 'loading', 'work still outranks the reaction');
  release();
  assert.equal(c.snapshot().state, 'celebrate', 'and the reaction is there when the work clears');
  c.dispose();
});

// ------------------------------------------------------ the primitive's shape

test('the overlay is a status, not a dialog, and takes no focus', () => {
  const code = stripComments(appBusy);
  assert.match(code, /role="status"/);
  assert.match(appBusy, /aria-busy="true"/);
  assert.match(appBusy, /aria-live="polite"/);
  assert.ok(!/role="dialog"/.test(code), 'a wait is not a dialog');
  assert.ok(!/aria-modal/.test(code), 'and it is not modal');
  assert.ok(!/\.focus\(/.test(code), 'it must never move focus — the disabled button owns it');
  assert.ok(!/tabIndex/.test(code), 'and must not put a tab stop in front of the page');
});

test('the overlay blocks pointers, which is the entire point of it', () => {
  assert.match(appBusy, /onPointerDown=\{swallow\}/);
  assert.match(appBusy, /onClick=\{swallow\}/);
  assert.match(appBusy, /stopPropagation\(\)/);
  assert.match(appBusy, /touchAction: 'none'/);
  assert.ok(
    !/pointer-events-none/.test(stripComments(appBusy)),
    'the mascot veil is pointer-events:none by design; this layer is the opposite'
  );
});

test('the overlay sits above every other layer, including an open sheet', () => {
  assert.match(appBusy, /zIndex: UI_LAYERS\.overlay \+ 100/);
  assert.match(overlay, /export const UI_LAYERS[\s\S]*?overlay: 200/);
  // `.lv-app-intro` is z-index 121 in src/index.css; 300 covers it too.
  assert.match(read('../src/index.css'), /\.lv-app-intro \{[\s\S]*?z-index: 121;/);
});

test('both escape hatches exist: a ceiling and a key', () => {
  // A request that never settles must not own somebody's phone.
  assert.match(appBusy, /export const BUSY_CEILING_MS = DEFAULT_TIMEOUT_MS \+ BUSY_CEILING_MARGIN_MS;/);
  assert.match(appBusy, /setTimeout\(\(\) => setReleased\(true\), BUSY_CEILING_MS\)/);
  assert.match(appBusy, /event\.key === 'Escape'/);
  assert.match(appBusy, /const visible = !idle && shown && !released;/);
});

/**
 * THE CEILING MUST OUTLAST THE REQUEST, and the number alone cannot say so.
 *
 * It shipped at a flat 15,000 against a 20,000ms API deadline that Checkout
 * does not override, which left a FIVE-SECOND window in which the layer had
 * let go — bottom navigation live, back gesture live — while `POST
 * /api/orders` was still in flight. A customer who navigated away in that
 * window unmounted Checkout, the order committed on the server, and they were
 * never shown an order number. That is the failure the overlay exists to
 * prevent, happening inside the overlay's own lifetime.
 *
 * So this reads BOTH constants and asserts the ORDERING, not a literal:
 * whichever is tuned next, the ceiling stays on the far side of the deadline.
 */
test('the ceiling outlasts the request deadline it is covering', () => {
  const margin = /export const BUSY_CEILING_MARGIN_MS = (\d+);/.exec(appBusy);
  assert.ok(margin, 'the margin is a named constant, not a literal inside the sum');
  assert.ok(Number(margin[1]) > 0, 'a zero margin makes the ceiling and the deadline simultaneous');

  const api = read('../src/lib/api.ts');
  const deadline = /export const DEFAULT_TIMEOUT_MS = (\d+);/.exec(api);
  assert.ok(deadline, 'api.ts must EXPORT the deadline — a copied number is a number that drifts');
  assert.match(appBusy, /import \{ DEFAULT_TIMEOUT_MS \} from '\.\.\/\.\.\/lib\/api'/);

  assert.ok(
    Number(deadline[1]) + Number(margin[1]) > Number(deadline[1]),
    'the ceiling must be strictly later than the deadline it covers'
  );
  // And Checkout must not quietly opt out of that deadline for the order POST.
  assert.ok(
    !/api\.post\('\/api\/orders'[\s\S]{0,200}timeoutMs/.test(checkout),
    'Checkout overriding timeoutMs would put the order back outside the ceiling'
  );
});

test('nothing is drawn before the flicker threshold', () => {
  assert.match(appBusy, /export const BUSY_DELAY_MS = 140;/);
  assert.match(appBusy, /setTimeout\(\(\) => setShown\(true\), BUSY_DELAY_MS\)/);
});

test('it shares the ONE scroll lock rather than keeping a second one', () => {
  assert.match(overlay, /export function acquireModalLock\(\)/);
  assert.match(appBusy, /import \{ UI_LAYERS, acquireModalLock \} from '\.\/Overlay'/);
  assert.match(appBusy, /if \(visible\) return acquireModalLock\(\);/);
});

test('beforeunload is armed for the order and for nothing else', () => {
  const effect = /useEffect\(\(\) => \{\s*if \(reason !== 'order'\) return;[\s\S]*?\}, \[reason, released\]\);/.exec(stripComments(appBusy));
  assert.ok(effect, 'the beforeunload effect should be findable and gated on the order');
  assert.match(effect[0], /addEventListener\('beforeunload'/);
  assert.match(effect[0], /removeEventListener\('beforeunload'/);
  /**
   * AND IT LETS GO WITH THE LAYER. The ceiling and the Escape key both set
   * `released`, and both mean "this layer has stopped claiming the page". A
   * beforeunload that survived them argued with a reload on a screen that had
   * visibly stopped being busy — which teaches people to dismiss the prompt
   * on the one occasion it is telling the truth.
   */
  assert.match(effect[0], /if \(released\) return;/);
  assert.equal(
    (stripComments(appBusy).match(/beforeunload/g) ?? []).length,
    2,
    'exactly one add and one remove — an app that argues with people leaving a price calculation is ignored by the time it matters'
  );
});

test('the overlay animates opacity only, in either motion preference', () => {
  assert.match(appBusy, /initial=\{\{ opacity: 0 \}\}/);
  assert.match(appBusy, /animate=\{\{ opacity: 1 \}\}/);
  const code = stripComments(appBusy);
  assert.ok(!/scale:/.test(code), 'no scale');
  assert.ok(!/\by:\s/.test(code), 'no travel');
  // Taken from the hook at render time, never captured once: the OS
  // preference can change mid-session and has to be honoured when it does.
  assert.match(appBusy, /const m = useMotion\(\);/);
});

test('no Sorani was invented for this screen', () => {
  /**
   * Every sentence in the overlay has to already exist, hand-written,
   * somewhere in the application. These are the three sources.
   */
  for (const [sentence, source, where] of [
    ['داواکاری دەنێردرێت…', checkout, 'the Place-order button'],
    ['حسابکردنی گەیاندن...', checkout, 'S.quoteLoading'],
    ['باردەکرێت…', read('../src/components/ui/Spinner.tsx'), "Spinner's generic trio"],
  ] as const) {
    assert.ok(appBusy.includes(sentence), `the overlay should use the existing ${where} wording`);
    assert.ok(source.includes(sentence), `${where} is where that wording comes from — it must not be new`);
  }
});

// ----------------------------------------------------------------- the wiring

test('the overlay is actually mounted, once, and not behind a lazy chunk', () => {
  assert.match(app, /<AppBusy \/>/);
  assert.match(app, /^import AppBusy from '\.\/components\/ui\/AppBusy';$/m);
  assert.ok(
    !/lazy\(\(\) => import\('\.\/components\/ui\/AppBusy'\)\)/.test(stripComments(app)),
    'a takeover that has to download a chunk arrives after the taps it exists to swallow'
  );
  assert.equal((app.match(/<AppBusy \/>/g) ?? []).length, 1, 'exactly one');
});

test('both order doors hold the screen', () => {
  assert.match(checkout, /useBusy\(submitting, 'order'\);/);
  assert.match(storeCheckout, /useBusy\(placing, 'order'\);/);
  assert.match(storeCheckout, /import \{ useBusy \} from '\.\.\/lib\/busy';/);
});

/**
 * «لا توجد شاشة تحميل مركزية في أي مكان» — ANYWHERE. `route` was declared in
 * the reason union, ranked at 10 and given a hand-written label in all three
 * languages while NOTHING in the application ever took it, so the label and
 * the `reason ?? 'route'` fallback in AppBusy were both unreachable code.
 *
 * The one place it belongs is the shared lazy-route fallback: BottomNav, the
 * header and the back gesture all render outside every Suspense boundary and
 * stayed tappable while a chunk downloaded.
 */
test('the route wait takes the screen too — the third reason is reachable', () => {
  assert.match(app, /useBusy\(true, 'route'\);/);
  assert.match(app, /^import \{ useBusy \} from '\.\/lib\/busy';$/m);
  // And it is held by the ONE fallback every lazy route shares, not sprinkled.
  const fallback = /const RouteFallback = \(\) => \{[\s\S]*?\n\};/.exec(app);
  assert.ok(fallback, 'RouteFallback should be findable');
  assert.match(fallback[0], /useBusy\(true, 'route'\);/);
  assert.equal((app.match(/useBusy\(/g) ?? []).length, 1, 'exactly one route holder');
});

test('only the RE-quote blocks — the first one is a page load', () => {
  assert.match(checkout, /useBusy\(quoteLoading && quote !== null, 'quote'\);/);
  // And the button's own refusal stays authoritative: the overlay makes it
  // visible, it does not replace it.
  assert.match(checkout, /!submitting && !quoteLoading/);
});

test('the overlay is never a precondition for placing an order', () => {
  const place = /const placeOrder = async \(\) => \{[\s\S]*?\n {2}\};/.exec(stripComments(checkout))?.[0] ?? '';
  assert.ok(place, 'placeOrder should be findable');
  assert.ok(!/busy/i.test(place), 'placeOrder must not consult the busy store at all');
  assert.match(place, /if \(!canCompleteOrder\) return;/, 'the existing refusal is the gate');
  assert.match(place, /idempotencyKey: idempotencyKeyRef\.current/, 'and the idempotency key is the real duplicate guard');
  assert.match(place, /setSubmitting\(false\);/, 'the finally releases the hold by flipping the flag it already owns');
});

// ----------------------------------------------- the confirmation path itself

test('the post-order wallet read is background work, so it cannot wear the loading face', () => {
  assert.match(checkout, /duringBackgroundRefresh\(\(\) => refreshWallet\(\)\)\.catch/);
  assert.match(checkout, /import \{ duringBackgroundRefresh \} from '\.\.\/lib\/mascotRequest';/);
  assert.ok(
    !/^\s*refreshWallet\(\)\.catch/m.test(stripComments(checkout)),
    'an unwrapped refreshWallet() takes the loading WORK state at priority 80 and buries celebrate at 65'
  );
  // And it is fixed HERE rather than by widening the silent list, because the
  // wallet page's own refresh is foreground work and must keep its face.
  assert.ok(
    !/api\/wallet/.test(stripComments(read('../src/lib/mascotRequest.ts'))),
    'the silent-route list must not learn about /api/wallet'
  );
});

test('the confirmation panel no longer claims an entrance the build cannot produce', () => {
  const panel = /if \(placedOrder\) \{[\s\S]*?\n {2}\}/.exec(stripComments(checkout))?.[0] ?? '';
  assert.ok(panel, 'the confirmation panel should be findable');
  assert.ok(
    !/animate-in|fade-in|zoom-in-95/.test(panel),
    'those utilities emit no CSS in this build — Tailwind v4 here has no animate plugin'
  );
  assert.match(panel, /initial=\{\{ opacity: 0, y: m\.travel\(12\) \}\}/, 'a real entrance instead');
  // `m.travel` is 0 and `m.spring` is a cross-fade under prefers-reduced-motion,
  // so the reduced path costs nothing extra and cannot be forgotten.
  assert.match(panel, /delay: m\.reduced \? 0 : /, 'and no stagger to sit through when motion is reduced');
});

test('the stage slot itself has no entrance — it is the thing being flown to', () => {
  const stage = /<div className="mb-8 flex items-center justify-center">\s*<MotionCharacterAnchor kind="stage" \/>\s*<\/div>/.exec(stripComments(checkout));
  assert.ok(stage, 'the stage anchor should still be a plain div');
  assert.ok(!/motion\./.test(stage[0]), 'a panel that moves its own anchor retargets the journey mid-flight');
});

test('the journey carries where it is going, so the arrival knows what it is worth', () => {
  assert.match(intro, /stage: boolean;/);
  assert.match(intro, /mascot\.navigationComplete\(landed\?\.stage \? 'stage' : 'route'\)/);
  assert.match(intro, /stage: target\.kind === 'stage'/);
  // A retarget replaces the destination; it must replace its meaning too.
  assert.match(intro, /retargetTravel\(inFlight\.plan, next\), stage: target\.kind === 'stage'/);
});
