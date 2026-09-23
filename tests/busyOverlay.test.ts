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
 *   THE ARRIVAL is real behaviour too. The character no longer flies from
 *   the header down to the confirmation — the descent the owner called «غير
 *   مرح ... من فوق الى الاسفل بشكل خاطئ ... lagging» — it appears there, so
 *   the arrival and the news are one frame. The controller decides by
 *   DESTINATION, and the test that matters most is the negative one: an
 *   ordinary route arrival must still be a 320ms `arrival` and nothing else.
 *   The entrance itself is tested in tests/orderCelebration.test.ts.
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
import { readFileSync, readdirSync } from 'node:fs';
import { COMMITS, beginBusy, busyStore, createIntentMark, resetBusyForTests } from '../src/lib/busy';
import { CELEBRATION_MOTION_MS, MASCOT_STATES, createMascotController, type MascotClock } from '../src/lib/mascot';
import { characterLayout, setCharacterBooting } from '../src/components/bloub/anchors';

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
const router = read('../src/components/NavigationRouter.tsx');
const wallet = read('../src/pages/Wallet.tsx');

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
  assert.deepEqual(busyStore.serverSnapshot(), { reason: null, session: 0, opener: null, ended: null });
  resetBusyForTests();
});

test('the session remembers what OPENED it, and what was speaking when it ENDED', () => {
  resetBusyForTests();
  // A route wait opens; an order joins it. The opener is fixed for the whole
  // session — the overlay's show delay is chosen from it, and keying that on
  // the live reason would restart the clock on every change of rank.
  const route = beginBusy('route');
  assert.equal(busyStore.snapshot().opener, 'route');
  const order = beginBusy('order');
  assert.equal(busyStore.snapshot().reason, 'order');
  assert.equal(busyStore.snapshot().opener, 'route', 'the opener does not follow the rank');
  route();
  order();
  // The overlay reads `ended` at the moment it goes away: after an order the
  // page behind it is the confirmation and the scrim must not fade over it.
  assert.deepEqual(busyStore.snapshot(), { reason: null, session: 1, opener: null, ended: 'order' });
  const quote = beginBusy('quote');
  assert.equal(busyStore.snapshot().ended, 'order', 'ended describes the LAST session until another ends');
  assert.equal(busyStore.snapshot().opener, 'quote');
  quote();
  assert.equal(busyStore.snapshot().ended, 'quote');
  resetBusyForTests();
});

test('money commits share the top rank, and only they arm the leave prompt', () => {
  resetBusyForTests();
  for (const commit of ['payment', 'subscribe'] as const) {
    const quote = beginBusy('quote');
    const money = beginBusy(commit);
    assert.equal(busyStore.snapshot().reason, commit, `${commit} outranks a re-quote`);
    money();
    quote();
  }
  assert.deepEqual([...COMMITS].sort(), ['order', 'payment', 'subscribe']);
  resetBusyForTests();
});

test('a customer intent is taken exactly once — it cannot leak onto the next wait', () => {
  const intent = createIntentMark();
  assert.equal(intent.take(), false, 'nothing marked, nothing taken');
  intent.mark();
  intent.mark();
  assert.equal(intent.take(), true, 'the quote the customer caused takes it');
  assert.equal(intent.take(), false, 'and the next one — a background refresh, the wallet default — does not');
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

test('landing on a stage celebrates, and the face outlasts the body', () => {
  const { controller: c, advance } = clockFixture();
  // The order resolved: the mood is raised on the response.
  c.outcome('ordered');
  assert.equal(c.snapshot().state, 'celebrate');
  // The character APPEARS on the stage on the next frame — no journey.
  advance(16);
  c.navigationComplete('stage');
  assert.equal(c.snapshot().state, 'celebrate', 'the landing is the merry moment');
  // The pop and both hops take CELEBRATION_MOTION_MS. A face that went calm
  // while the body was still bouncing reads as losing interest in its news.
  assert.ok(MASCOT_STATES.celebrate.duration > CELEBRATION_MOTION_MS + 500);
  advance(CELEBRATION_MOTION_MS);
  assert.equal(c.snapshot().state, 'celebrate', 'still beaming as the body comes to rest');
  advance(MASCOT_STATES.celebrate.duration - CELEBRATION_MOTION_MS - 50);
  assert.equal(c.snapshot().state, 'celebrate');
  advance(100);
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
  assert.match(appBusy, /const visible = !idle && shown && !released && !standsDown;/);
});

/**
 * «الـ bloub» IS THE BOOT LOADER, AND THE OVERLAY USED TO COVER IT.
 *
 * On every cold load the shell's first wait (host resolve, session) is held
 * as `route` by RouteFallback, and on a phone it outlasts the show delay — so
 * the overlay drew a dimmed spinner over the character's centred intro, and
 * its modal lock set `html[data-overlay-open]`, which hides the character
 * outright. A route wait now stands down while the intro is booting, and the
 * overlay takes no modal lock at all.
 */
test('a route wait during boot is the character\'s to show, never the overlay\'s', () => {
  const code = stripComments(appBusy);
  assert.match(code, /useSyncExternalStore\(characterLayout\.subscribe, characterLayout\.booting, characterLayout\.serverBooting\)/);
  assert.match(code, /const standsDown = reason === 'route' && introBooting;/);
  // Only a ROUTE wait stands down — an order, a payment or a quote during the
  // boot window (there are none today) would still be covered.
  assert.ok(!/standsDown = .*order/.test(code));

  // The flag is the intro's own phase, and only where the intro is visible.
  assert.match(intro, /setCharacterBooting\(!failed && phase === 'loading' && !routeHidden\);/);
  assert.match(intro, /React\.useLayoutEffect\(\(\) => \(\) => setCharacterBooting\(false\), \[\]\);/);

  // And the store behind it notifies, so the overlay re-renders the moment
  // the intro docks (or its six-second pin gives up) with the wait still on.
  let calls = 0;
  const stop = characterLayout.subscribe(() => { calls += 1; });
  setCharacterBooting(true);
  assert.equal(characterLayout.booting(), true);
  setCharacterBooting(true);
  assert.equal(calls, 1, 'no change, no notification');
  setCharacterBooting(false);
  assert.equal(characterLayout.booting(), false);
  assert.equal(calls, 2);
  assert.equal(characterLayout.serverBooting(), false);
  stop();
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

test('nothing is drawn before the flicker threshold — and a route waits longer', () => {
  assert.match(appBusy, /export const BUSY_DELAY_MS = 140;/);
  // Every navigation is watched now, and a heavy page's RENDER on a weak
  // phone can outlast 140ms; a download is what a route wait is for.
  const route = /export const ROUTE_BUSY_DELAY_MS = (\d+);/.exec(appBusy);
  assert.ok(route && Number(route[1]) > 140 && Number(route[1]) <= 300, 'a route delay between the flicker threshold and a noticeable wait');
  assert.match(
    appBusy,
    /setTimeout\(\(\) => setShown\(true\), opener === 'route' \? ROUTE_BUSY_DELAY_MS : BUSY_DELAY_MS\)/
  );
  // Keyed on the session's OPENER, which is fixed for the session, so a hold
  // of another rank joining the wait does not restart the clock.
  assert.match(appBusy, /\}, \[idle, session, opener\]\);/);
});

test('it takes no modal lock — that lock hid the character and reflowed the page twice per wait', () => {
  const code = stripComments(appBusy);
  assert.ok(!/acquireModalLock/.test(code), 'no scroll lock: touch-action and the swallowed events already stop a finger');
  assert.ok(!/data-overlay-open|overlayOpen/.test(code));
  // Touch cannot start a scroll through it, which is what the lock was for.
  assert.match(appBusy, /touchAction: 'none'/);
  assert.match(appBusy, /onTouchStart=\{swallow\}/);
  // Overlay's own lock is untouched for the windows that ARE modal.
  assert.match(overlay, /export function acquireModalLock\(\)/);
});

test('no full-screen backdrop blur — the most expensive pixel in the app, spent on a wait', () => {
  assert.ok(!/backdrop-blur|backdropFilter|backdrop-filter/.test(stripComments(appBusy)));
  assert.match(appBusy, /bg-black\/70/);
});

test('after an order the scrim is simply gone — it does not fade over the celebration', () => {
  const code = stripComments(appBusy);
  assert.match(code, /hidden: \(instant: boolean\) => \(instant \? \{ opacity: 0, transition: \{ duration: 0 \} \} : \{ opacity: 0 \}\)/);
  // Through AnimatePresence's `custom`: a child being removed receives no props.
  assert.match(code, /<AnimatePresence custom=\{ended === 'order'\}>/);
  assert.match(code, /exit="hidden"/);
});

test('beforeunload is armed for the money commits and for nothing else', () => {
  const effect = /useEffect\(\(\) => \{\s*if \(reason === null \|\| !COMMITS\.has\(reason\)\) return;[\s\S]*?\}, \[reason, released\]\);/.exec(stripComments(appBusy));
  assert.ok(effect, 'the beforeunload effect should be findable and gated on the commits');
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
  assert.match(appBusy, /shown: \{ opacity: 1 \}/);
  assert.match(appBusy, /initial="hidden"/);
  assert.match(appBusy, /animate="shown"/);
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
    ['دەنێردرێت…', wallet, "the wallet form's submitting label"],
    ['جێبەجێ دەکرێت…', read('../src/translations.ts'), "the membership screen's working label"],
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
  assert.equal((app.match(/useBusy\(/g) ?? []).length, 1, 'exactly one route holder in App');
});

/**
 * «عند تحميل الصفحة ... لا يوجد أنيميشن يظهر في المنتصف ... يمنع من الضغط
 * المكرر أو الانتقال من صفحة أو الأخرى».
 *
 * THE FALLBACK ABOVE NEVER SHOWED FOR AN IN-SHELL NAVIGATION. BrowserRouter
 * applies every location change in `startTransition`, and a transition that
 * suspends keeps the OLD page on screen — live, tappable — instead of mounting
 * the Suspense fallback. So a tap on a page not yet downloaded did nothing
 * visible for as long as the chunk took. The router is now BrowserRouter's own
 * shape with `useTransition`, whose `isPending` is held as the route wait.
 */
test('a navigation that is still pending holds the screen, not only a mounted fallback', () => {
  const code = stripComments(router);
  assert.match(code, /const \[pending, startTransition\] = React\.useTransition\(\);/);
  assert.match(code, /history\.listen\(\(update\) => \{\s*startTransition\(\(\) => setState\(\{ action: update\.action, location: update\.location \}\)\);/);
  assert.match(code, /useBusy\(pending, 'route'\);/);
  assert.match(code, /createBrowserHistory\(\{ window, v5Compat: true \}\)/);
  assert.match(code, /<Router location=\{state\.location\} navigationType=\{state\.action\} navigator=\{history\}>/);

  // The app actually mounts it, in place of BrowserRouter.
  const appCode = stripComments(app);
  assert.match(appCode, /<NavigationRouter>[\s\S]*<AppBusy \/>[\s\S]*<\/NavigationRouter>/);
  assert.ok(!/BrowserRouter/.test(appCode), 'BrowserRouter would swallow the pending state again');

  // CANARY: this mirrors the library's own BrowserRouter. If an upgrade stops
  // building the history this way, the mirror has to be looked at again.
  const dir = new URL('../node_modules/react-router/dist/development/', import.meta.url);
  const lib = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => readFileSync(new URL(f, dir), 'utf8'))
    .find((src) => src.includes('function BrowserRouter('));
  assert.ok(lib, 'react-router still ships a BrowserRouter');
  const browserRouter = /function BrowserRouter\([\s\S]*?\n\}\n/.exec(lib)![0];
  assert.match(browserRouter, /createBrowserHistory\(\{ window: window2, v5Compat: true \}\)/);
  assert.match(browserRouter, /history\.listen\(setState\)/);
  assert.match(browserRouter, /startTransition\(\(\) => setStateImpl\(newState\)\)/);
});

test('a wallet deposit or withdrawal holds the screen while it is with the server', () => {
  assert.match(wallet, /^import \{ useBusy \} from '\.\.\/lib\/busy';$/m);
  const modal = /function RequestModal\([\s\S]*?\n\}\n/.exec(wallet)?.[0] ?? '';
  assert.ok(modal, 'RequestModal should be findable');
  assert.match(modal, /useBusy\(submitting, 'payment'\);/);
  // `submitting` is the flag the submit's own `finally` clears.
  assert.match(modal, /setSubmitting\(true\);[\s\S]*finally \{\s*setSubmitting\(false\);/);
});

test('only a RE-quote the CUSTOMER asked for blocks — not the first, not one the page made', () => {
  const code = stripComments(checkout);
  assert.match(code, /useBusy\(quoteLoading && quote !== null && quoteAskedFor, 'quote'\);/);
  // And the button's own refusal stays authoritative for EVERY quote: the
  // overlay makes a customer's wait visible, it does not replace the gate.
  assert.match(code, /!submitting && !quoteLoading/);

  // The quote takes the mark, once, in the same breath it starts loading —
  // and a skipped quote consumes it too, so it cannot leak onto a later one.
  assert.match(code, /setQuoteLoading\(true\);\s*setQuoteAskedFor\(customerQuote\.take\(\)\);/);
  assert.match(code, /customerQuote\.take\(\);\s*setQuote\(null\);\s*return;/);

  // THE DEFECT: the page's own wallet-first default re-quoted with the screen
  // blacked out on load. That effect must never mark.
  const walletDefault = /useEffect\(\(\) => \{\s*if \(paymentPickedRef\.current\) return;[\s\S]*?\}, \[quote, quoteLoading, offeredKey, paymentMethod, walletBalanceIQD\]\);/.exec(code)?.[0] ?? '';
  assert.ok(walletDefault, 'the wallet-first default effect should be findable');
  assert.match(walletDefault, /setPaymentMethod\('wallet'\)/);
  assert.ok(!/mark\(\)/.test(walletDefault), 'an automatic switch is not the customer asking');

  // Every control that re-prices the cart marks its change.
  for (const [control, setter] of [
    ['address radio', /customerQuote\.mark\(\); setSelectedAddressId\(addr\.id\);/],
    ['new address', /customerQuote\.mark\(\);\s*setSelectedAddressId\(id\);/],
    ['delivery radio', /customerQuote\.mark\(\); setDeliveryMethod\(method\.id\);/],
    ['payment radio', /paymentPickedRef\.current = true;\s*customerQuote\.mark\(\);\s*setPaymentMethod\(method\.id\);/],
    // The Gini row is a plain button that fires again when Gini is already
    // chosen: that tap starts no quote, so it must leave no mark standing.
    ['Gini', /paymentPickedRef\.current = true;\s*if \(paymentMethod !== 'gini'\) customerQuote\.mark\(\);\s*setPaymentMethod\('gini'\);/],
    ['protected delivery', /customerQuote\.mark\(\);\s*setProtectedDelivery\(e\.target\.checked\);/],
    ['wallet switch', /customerQuote\.mark\(\);\s*setUseWalletBalance\(!useWalletBalance\);/],
    ['points switch', /customerQuote\.mark\(\);\s*setUsePoints\(\(v\) => !v\);/],
    ['coupon', /if \(code !== couponCode\) customerQuote\.mark\(\);\s*setCouponCode\(code\);/],
  ] as const) {
    assert.match(code, setter, `${control} does not mark the re-quote it causes`);
  }
  // …and nothing else does: the forced-wallet and payment-default effects,
  // the price refresh and the coupon auto-drop all stay silent.
  assert.equal((code.match(/customerQuote\.mark\(\)/g) ?? []).length, 9);
});

test('the store checkout re-quote is a real wait: Place refuses it and the customer\'s holds the screen', () => {
  const code = stripComments(storeCheckout);
  assert.match(code, /useBusy\(quoteLoading && quote !== null && quoteAskedFor, 'quote'\);/);
  // The request is a state, set around the call and cleared by the LAST one.
  assert.match(code, /const seq = \+\+quoteSeq\.current;\s*setQuoteLoading\(true\);\s*setQuoteAskedFor\(askedFor\);/);
  assert.match(code, /if \(seq !== quoteSeq\.current\) return false;\s*setQuote\(d\.quote\);/, 'a stale answer must not put the old total back');
  assert.match(code, /finally \{\s*if \(seq === quoteSeq\.current\) setQuoteLoading\(false\);/);
  // Place is refused while the total is about to change, in the button AND in place().
  assert.match(code, /disabled=\{placing \|\| quoteLoading \|\| !addressId \|\| !quote\.wallet_covers\}/);
  assert.match(code, /if \(!addressId \|\| !quote \|\| quoteLoading\) return;/);
  // The coupon controls are the customer asking; the refresh on return is not.
  assert.match(code, /loadQuote\(couponInput\.trim\(\), true\)/);
  assert.match(code, /loadQuote\('', true\)/);
  assert.match(code, /await loadQuote\(couponRef\.current\);/);
  // The refresh never replaces a quote already out: it would take the newest
  // sequence number with the OLD coupon and discard the one being applied.
  assert.match(code, /useFreshOnReturn\(async \(\) => \{\s*if \(quoteLoadingRef\.current\) return;\s*await loadQuote\(couponRef\.current\);/);
  assert.match(code, /quoteLoadingRef\.current = quoteLoading;/);
  assert.match(code, /enabled: !placing && !quoteLoading,/);
  assert.match(code, /disabled=\{!couponInput\.trim\(\) \|\| quoteLoading\}/);
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
  // …and it waits for the celebration to stop moving instead of running its
  // request, parse and provider re-render on the same frames.
  assert.match(
    stripComments(checkout),
    /window\.setTimeout\(\(\) => \{\s*duringBackgroundRefresh\(\(\) => refreshWallet\(\)\)\.catch\(\(\) => \{\}\);\s*\}, CELEBRATION_MOTION_MS\);/
  );
  // The notification-channel offer starts its read only then, too.
  assert.match(checkout, /<ChannelNudge context="order" active=\{celebrated\} \/>/);
  assert.match(
    stripComments(checkout),
    /if \(!placedOrder\) return;\s*const timer = window\.setTimeout\(\(\) => setCelebrated\(true\), CELEBRATION_MOTION_MS\);/
  );
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

test('the stage slot itself has no entrance — it is the box the character measures', () => {
  const stage = /<div className="mb-8 flex items-center justify-center">\s*<OrderCelebration \/>\s*<\/div>/.exec(stripComments(checkout));
  assert.ok(stage, 'the celebration should sit in a plain div');
  assert.ok(!/motion\./.test(stage[0]), 'a panel that moves the stage moves the character with it');
  // Both order doors end on the same moment.
  assert.match(stripComments(storeCheckout), /<OrderCelebration \/>/);
  assert.match(storeCheckout, /mascot\.outcome\('ordered'\);/);
});

test('no journey ever lands on a stage — the old descent and its flag are gone', () => {
  const code = stripComments(intro);
  assert.ok(!/stage: boolean;/.test(code), 'a journey no longer carries a stage flag');
  assert.ok(!/landed\?\.stage/.test(code));
  // The ordinary landing is ordinary punctuation; only `appear` celebrates.
  assert.match(code, /const finishJourney = \(\) => \{\s*journeyRef\.current = null;\s*setPhase\('docked'\);\s*mascot\.navigationComplete\(\);/);
  assert.match(code, /mascot\.navigationComplete\(stage \? 'stage' : 'route'\);/);
});
