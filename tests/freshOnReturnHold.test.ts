/**
 * A PAGE KEPT HIDDEN HOLDS ITS REFRESHES, AND ONE IT MISSED RUNS WHEN IT IS SHOWN
 * («المال والأرباح» redesign step 2; DECISIONS row 315).
 *
 * The workspace keeps a page the owner left mounted and hidden (FinanceWorkspace's
 * page()), wrapped in FreshOnReturnHold with `true`. useFreshOnReturn must then do
 * nothing — no wake and no poll reads the server for a page nobody sees — and
 * remember a wake that came, so the read the owner came back for runs the moment the
 * page is shown again. This runs the real hook in React: a component that draws
 * nothing, mounted by react-dom in a browser just big enough for that (window and
 * document as EventTargets, one container element), with React's act() flushing
 * each render and its effects.
 *
 * Run: node --import tsx --test tests/freshOnReturnHold.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
const win = fake({ document: doc, HTMLIFrameElement: class {}, navigator: { userAgent: 'node' }, location: { href: 'https://levonis-iq.com/admin', search: '' },
  // Read through, so node's mock timers (enabled per test) drive the hook's poll.
  setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms), clearInterval: (id: ReturnType<typeof setInterval>) => globalThis.clearInterval(id) });
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, IS_REACT_ACT_ENVIRONMENT: true });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { FreshOnReturnHold, useFreshOnReturn } = await import('../src/lib/useFreshOnReturn');
const { createElement: h, act } = React;

/** A page that reads the server through the hook, as PeoplePanel and InvestorProfiles do: it counts its reads. */
function mount(options: { pollWhileVisibleMs?: number; enabled?: boolean } = {}) {
  const reads = { count: 0 };
  function Page() { useFreshOnReturn(() => { reads.count += 1; }, { minIntervalMs: 0, ...options }); return null; }
  const root = createRoot(element('div') as unknown as HTMLElement);
  const show = (hidden: boolean) => act(async () => { root.render(h(FreshOnReturnHold.Provider, { value: hidden }, h(Page))); });
  const wake = () => act(async () => { win.dispatchEvent(new Event('focus')); });
  return { reads, show, wake, unmount: () => act(async () => { root.unmount(); }) };
}

test('a shown page reads again when the owner comes back to the browser tab (the hook as every screen uses it)', async () => {
  const page = mount();
  await page.show(false);
  assert.equal(page.reads.count, 0, 'mounting is not a wake');
  await page.wake();
  assert.equal(page.reads.count, 1);
  await page.unmount();
});

test('a hidden page does not read on a wake, and reads once — the wake it missed — when it is shown again', async () => {
  const page = mount();
  await page.show(true);
  await page.wake();
  await page.wake();
  assert.equal(page.reads.count, 0, 'nothing is read for a page nobody sees');
  await page.show(false);
  assert.equal(page.reads.count, 1, 'the missed wake runs once on show, not once per wake');
  await page.show(false);
  assert.equal(page.reads.count, 1, 'a later render is no wake');
  await page.unmount();
});

test('a page hidden and shown again without a wake in between does not read: keeping it costs no read', async () => {
  const page = mount();
  await page.show(false);
  await page.show(true);
  await page.show(false);
  assert.equal(page.reads.count, 0);
  await page.unmount();
});

test('a hidden page\'s poll does not run; its missed tick runs once when the page is shown', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const page = mount({ pollWhileVisibleMs: 1000 });
  t.after(page.unmount);
  await page.show(true);
  await act(async () => { t.mock.timers.tick(3500); });
  assert.equal(page.reads.count, 0, 'three ticks while hidden, no read');
  await page.show(false);
  assert.equal(page.reads.count, 1, 'the held tick runs on show');
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(page.reads.count, 2, 'and the poll goes on while the page is shown');
});

test('the caller\'s own hold (a dialog open) and the hidden page\'s hold add up: shown, but with a dialog open, it still waits', async () => {
  const reads = { count: 0 };
  function Page({ dialog }: { dialog: boolean }) { useFreshOnReturn(() => { reads.count += 1; }, { minIntervalMs: 0, enabled: !dialog }); return null; }
  const root = createRoot(element('div') as unknown as HTMLElement);
  const render = (hidden: boolean, dialog: boolean) => act(async () => { root.render(h(FreshOnReturnHold.Provider, { value: hidden }, h(Page, { dialog }))); });
  await render(true, true);
  await act(async () => { win.dispatchEvent(new Event('focus')); });
  await render(false, true);
  assert.equal(reads.count, 0, 'shown, but the dialog still holds it');
  await render(false, false);
  assert.equal(reads.count, 1, 'the dialog closes: the missed wake runs');
  await act(async () => { root.unmount(); });
});
