/**
 * THE COURIER NOTE'S CLOCK, RENDERED (DECISIONS row 324, the independent review).
 *
 * The checkout's note «أتمم طلبك قبل الساعة ٧ مساءً ليُسلَّم … اليوم» kept its
 * clock in React state that one setTimeout refreshed. A phone locked at 18:41
 * and unlocked at 20:15 had not fired that timer — timer delays run on a clock
 * that stops while a phone sleeps or a tab is frozen — so the note still
 * promised tonight's handover, even through the page's own re-renders. The
 * clock is now read at every render and `useRerenderAt` renders again once the
 * change has passed: by its timer, or the moment the page is back.
 *
 * This runs the real hook and the real note words in React: a component that
 * draws Checkout's two lines exactly as Checkout computes them (the source pin
 * at the end holds Checkout to that), in a browser just big enough for it —
 * window and document as EventTargets — whose timers run on their OWN clock.
 * `awake(ms)` moves both clocks and fires what falls due; `sleep(ms)` moves the
 * wall clock alone, as a locked phone does.
 *
 * Run: node --import tsx --test tests/courierNoteClock.test.ts
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

// ---------------------------------------------------------------- a browser that draws nothing
type Bag = Record<string, unknown>;
type FakeNode = EventTarget & Bag;
const fake = (fields: Bag): FakeNode => Object.assign(new EventTarget(), fields) as unknown as FakeNode;
const doc = fake({ nodeType: 9, nodeName: '#document', visibilityState: 'visible', activeElement: null, body: null, documentElement: null, defaultView: null });
const element = (name: string): FakeNode => fake({
  nodeType: 1, nodeName: name.toUpperCase(), tagName: name.toUpperCase(), style: {}, attributes: {}, childNodes: [], firstChild: null, lastChild: null, textContent: '', ownerDocument: doc,
  setAttribute(this: Bag, k: string, v: string) { (this.attributes as Bag)[k] = v; }, removeAttribute(this: Bag, k: string) { delete (this.attributes as Bag)[k]; },
  getAttribute(this: Bag, k: string) { return (this.attributes as Bag)[k] ?? null; },
});
doc.createElement = element;
doc.documentElement = element('html');

/** THE TWO CLOCKS: `wall` is what Date.now() says; `mono` runs the page's timers, and stands still in a sleep. */
const clock = { wall: 0, mono: 0 };
type Timer = { id: number; at: number; fn: () => void };
let timers: Timer[] = [];
let nextId = 1;
const win = fake({
  document: doc, HTMLIFrameElement: class {}, navigator: { userAgent: 'node' }, location: { href: 'https://levonis-iq.com/checkout', search: '' },
  setTimeout: (fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, at: clock.mono + Math.max(0, ms), fn });
    return id;
  },
  clearTimeout: (id: number) => { timers = timers.filter((t) => t.id !== id); },
});
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, IS_REACT_ACT_ENVIRONMENT: true });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useRerenderAt } = await import('../src/lib/useRerenderAt');
const { deliveryEta, etaArrivalLine, etaHandoverKind, etaHandoverLine, resolveDeliveryHandover } = await import('../worker/lib/deliveryEta');
const { createElement: h, act } = React;

const P = resolveDeliveryHandover(undefined);
/** Baghdad wall-clock → epoch ms. Iraq is UTC+3 all year. */
const baghdad = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00.000+03:00`);
const MIN = 60_000;

/** Time passes with the phone awake: both clocks move, and each timer that falls due runs, in order. */
async function awake(ms: number) {
  const end = clock.mono + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const due = timers[0];
    if (!due || due.at > end) break;
    timers.shift();
    clock.wall += due.at - clock.mono;
    clock.mono = due.at;
    await act(async () => { due.fn(); });
  }
  clock.wall += end - clock.mono;
  clock.mono = end;
}
/** The phone is locked: the wall clock moves on, the timers' clock does not. */
const sleep = (ms: number) => { clock.wall += ms; };
/** The page comes back, by one of the three doors a browser uses. */
const wake = (door: 'visibilitychange' | 'focus' | 'pageshow') =>
  act(async () => { (door === 'visibilitychange' ? doc : win).dispatchEvent(new Event(door)); });

interface Props { governorate: string; courier: boolean; day?: string | null }
/**
 * The note as Checkout draws it: `deliveryEta({ nowMs: Date.now(), … })` at render, then
 * `useRerenderAt(courierEta?.next_change_ms ?? null)` — `courier: false` is a pickup card (no note).
 */
function mount(t: TestContext, startWall: number, props: Props) {
  clock.wall = startWall;
  clock.mono = 0;
  timers = [];
  nextId = 1;
  t.mock.method(Date, 'now', () => clock.wall);
  const seen: Array<{ kind: string; handover: string; arrival: string } | null> = [];
  function Note({ governorate, courier, day }: Props) {
    const courierEta = courier ? deliveryEta({ nowMs: Date.now(), governorate, policy: P, day }) : null;
    useRerenderAt(courierEta?.next_change_ms ?? null);
    seen.push(courierEta ? { kind: etaHandoverKind(courierEta), handover: etaHandoverLine(courierEta, 'en'), arrival: etaArrivalLine(courierEta, 'en') } : null);
    return null;
  }
  const root = createRoot(element('div') as unknown as HTMLElement);
  return {
    render: (p: Props = props) => act(async () => { root.render(h(Note, p)); }),
    last: () => seen[seen.length - 1],
    renders: () => seen.length,
    unmount: () => act(async () => { root.unmount(); }),
  };
}

const TODAY_LINE = "Place your order before 7 pm and it goes to the delivery company's courier today.";
const PASSED_LINE = "Today's 7 pm handover has passed, so your order goes to the delivery company's courier tomorrow at 7 pm.";

test('a phone locked at 18:41 and unlocked at 20:15: the first render after it already says tomorrow — the clock is read at render', async (t) => {
  const page = mount(t, baghdad('2026-11-11', '18:40'), { governorate: 'baghdad', courier: true });
  t.after(page.unmount);
  await page.render();
  assert.equal(page.last()?.handover, TODAY_LINE);
  assert.equal(page.last()?.arrival, 'Expected in Baghdad: tomorrow, between 10 am and 3 pm (estimate).');
  await awake(1 * MIN);
  sleep(94 * MIN); // 18:41 → 20:15; the 19:00 timer has not fired
  assert.ok(timers.length === 1 && timers[0].at > clock.mono, 'the handover timer is still waiting on the stopped clock');
  // Any render — the page's 60-second cart poll, a tap — draws the note from the wall clock.
  await page.render();
  assert.equal(page.last()?.kind, 'passed');
  assert.equal(page.last()?.handover, PASSED_LINE);
  assert.equal(page.last()?.arrival, 'Expected in Baghdad: Friday 13 November, between 10 am and 3 pm (estimate).', '«order B at 7:30 pm adds 24 hrs»');
});

for (const door of ['visibilitychange', 'focus', 'pageshow'] as const) {
  test(`woken past 19:00 with no other render, «${door}» alone renders the post-7 pm line`, async (t) => {
    const page = mount(t, baghdad('2026-11-11', '18:40'), { governorate: 'baghdad', courier: true });
    t.after(page.unmount);
    await page.render();
    assert.equal(page.last()?.kind, 'today');
    sleep(95 * MIN);
    const before = page.renders();
    await wake(door);
    assert.equal(page.renders(), before + 1, 'one render for the change');
    assert.equal(page.last()?.handover, PASSED_LINE);
    // The next change is now Baghdad's midnight, armed afresh from the wall clock.
    assert.equal(timers.length, 1);
    await wake(door);
    assert.equal(page.renders(), before + 1, 'a second wake with nothing changed renders nothing');
  });
}

test('a hidden page is not a wake: «visibilitychange» while hidden renders nothing until the page is shown', async (t) => {
  const page = mount(t, baghdad('2026-11-11', '18:40'), { governorate: 'baghdad', courier: true });
  t.after(() => { doc.visibilityState = 'visible'; });
  t.after(page.unmount);
  await page.render();
  sleep(95 * MIN);
  doc.visibilityState = 'hidden';
  const before = page.renders();
  await wake('visibilitychange');
  assert.equal(page.renders(), before);
  doc.visibilityState = 'visible';
  await wake('visibilitychange');
  assert.equal(page.last()?.kind, 'passed');
});

test('a short sleep before 19:00 re-arms the timer from the wall clock, so 19:00 is not pushed late by the sleep', async (t) => {
  const page = mount(t, baghdad('2026-11-11', '18:30'), { governorate: 'baghdad', courier: true });
  t.after(page.unmount);
  await page.render();
  await awake(1 * MIN);
  sleep(15 * MIN); // 18:31 → 18:46 with the timers' clock stopped
  const before = page.renders();
  await wake('visibilitychange');
  assert.equal(page.renders(), before, 'before the change, a wake renders nothing');
  assert.equal(page.last()?.kind, 'today');
  // 14 minutes and a second of awake time later it is 19:00:01: the line has turned, not at 19:15.
  await awake(14 * MIN + 1_000);
  assert.equal(page.last()?.kind, 'passed');
  assert.equal(new Date(clock.wall).toISOString(), '2026-11-11T16:00:01.000Z');
});

test('left open and awake: 19:00 and then Baghdad midnight, by the timer alone', async (t) => {
  const page = mount(t, baghdad('2026-11-11', '18:59'), { governorate: 'basra', courier: true });
  t.after(page.unmount);
  await page.render();
  assert.equal(page.last()?.arrival, 'Expected in Basra: tomorrow, between 6 and 8 pm (estimate).');
  await awake(1 * MIN + 1_000);
  assert.equal(page.last()?.kind, 'passed');
  assert.equal(page.last()?.arrival, 'Expected in Basra: Friday 13 November, between 6 and 8 pm (estimate).');
  // 19:00:01 → 00:00:01 on the 12th: «tomorrow» is «today» now, and Friday is «tomorrow».
  await awake(5 * 60 * MIN);
  assert.equal(page.last()?.kind, 'today');
  assert.equal(page.last()?.handover, TODAY_LINE);
  assert.equal(page.last()?.arrival, 'Expected in Basra: tomorrow, between 6 and 8 pm (estimate).');
});

test('a timer that fires while the wall clock still reads before 19:00 waits again rather than drawing the same words', async (t) => {
  const page = mount(t, baghdad('2026-11-11', '18:59'), { governorate: 'baghdad', courier: true });
  t.after(page.unmount);
  await page.render();
  clock.wall -= 5_000; // the device clock steps back five seconds after the timer was armed
  const before = page.renders();
  await awake(1 * MIN + 1_000); // the timer fires at 18:59:56 by the wall clock
  assert.equal(page.renders(), before, 'no render for words that have not changed');
  assert.equal(page.last()?.kind, 'today');
  await awake(5_000);
  assert.equal(page.last()?.kind, 'passed', 're-armed, it renders once the wall clock is past 19:00');
});

test('a courier method chosen again after 19:00 shows the post-7 pm line at once (the builder’s accepted one-second edge is gone)', async (t) => {
  const props: Props = { governorate: 'baghdad', courier: true };
  const page = mount(t, baghdad('2026-11-11', '18:50'), props);
  t.after(page.unmount);
  await page.render();
  assert.equal(page.last()?.kind, 'today');
  await page.render({ ...props, courier: false }); // pickup: no note, no timer
  assert.equal(timers.length, 0);
  await awake(20 * MIN); // 19:10
  await page.render(props);
  assert.equal(page.last()?.kind, 'passed', 'the first render back is already right');
});

test('a picked day turns with the same clock: «tomorrow» picked at 18:59 is on time, and at 19:00 the note says it lands later', async (t) => {
  const page = mount(t, baghdad('2026-11-11', '18:59'), { governorate: 'baghdad', courier: true, day: '2026-11-12' });
  t.after(page.unmount);
  await page.render();
  assert.equal(page.last()?.arrival, 'Expected in Baghdad: tomorrow, between 10 am and 3 pm (estimate).');
  await awake(1 * MIN + 1_000);
  assert.equal(page.last()?.arrival, 'Expected in Baghdad: Friday 13 November, between 10 am and 3 pm (estimate) — later than the day you chose.');
});

test('Checkout computes the note exactly so: the clock at render, the picked day, and the hook on the next change', () => {
  const checkout = readFileSync(join(ROOT, 'src/pages/Checkout.tsx'), 'utf8');
  assert.match(checkout, /import \{ useRerenderAt \} from '\.\.\/lib\/useRerenderAt';/);
  assert.match(checkout, /\? deliveryEta\(\{ nowMs: Date\.now\(\), governorate: etaGovernorate, policy: handoverPolicy, day: requestedDay \}\)\s*: null;\s*useRerenderAt\(courierEta\?\.next_change_ms \?\? null\);/);
  assert.doesNotMatch(checkout, /etaNow|setEtaNow/, 'no clock kept in state');
  // The hook listens on the three doors useFreshOnReturn uses, and on nothing else.
  const hook = readFileSync(join(ROOT, 'src/lib/useRerenderAt.ts'), 'utf8');
  for (const door of ["window.addEventListener('focus'", "document.addEventListener('visibilitychange'", "window.addEventListener('pageshow'"]) assert.ok(hook.includes(door), door);
});
