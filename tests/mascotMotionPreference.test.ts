import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMotionPreferenceStore, type MotionPreferenceQuery } from '../src/lib/mascotMotionPreference';

function fixture(initial = false, legacy = false) {
  let value = initial, added = 0, removed = 0;
  const changes = new Set<() => void>();
  const add = (fn: () => void) => { added++; changes.add(fn); };
  const remove = (fn: () => void) => { removed++; changes.delete(fn); };
  const media: MotionPreferenceQuery = {
    get matches() { return value; },
    ...(legacy ? { addListener: add, removeListener: remove } : {
      addEventListener: (_type: 'change', fn: () => void) => add(fn),
      removeEventListener: (_type: 'change', fn: () => void) => remove(fn),
    }),
  };
  return {
    store: createMotionPreferenceStore(() => media),
    change(next: boolean) { value = next; for (const fn of changes) fn(); },
    counts: () => ({ added, removed, active: changes.size }),
  };
}

test('preference snapshots are current and server rendering attaches nothing', () => {
  const { store, change, counts } = fixture(true);
  assert.equal(store.serverSnapshot(), false);
  assert.equal(store.snapshot(), true);
  change(false);
  assert.equal(store.snapshot(), false);
  assert.deepEqual(counts(), { added: 0, removed: 0, active: 0 });
});

test('shell and SVG share one listener and react in both directions', () => {
  const { store, change, counts } = fixture();
  const shell: boolean[] = [], svg: boolean[] = [];
  const a = store.subscribe(() => shell.push(store.snapshot()));
  const b = store.subscribe(() => svg.push(store.snapshot()));
  change(true); change(false);
  assert.deepEqual(shell, [true, false]); assert.deepEqual(svg, [true, false]);
  assert.deepEqual(counts(), { added: 1, removed: 0, active: 1 });
  a(); a(); change(true);
  assert.deepEqual(shell, [true, false]); assert.deepEqual(svg, [true, false, true]);
  b(); b();
  assert.deepEqual(counts(), { added: 1, removed: 1, active: 0 });
});

test('strict-mode unsubscribe and resubscribe reads changes made while detached', () => {
  const { store, change, counts } = fixture();
  const first = store.subscribe(() => {}); first(); change(true);
  assert.equal(store.snapshot(), true);
  let latest = true;
  const second = store.subscribe(() => { latest = store.snapshot(); });
  change(false); assert.equal(latest, false); second();
  assert.deepEqual(counts(), { added: 2, removed: 2, active: 0 });
});

test('legacy Safari change listeners receive updates and clean up', () => {
  const { store, change, counts } = fixture(false, true);
  let latest = false;
  const stop = store.subscribe(() => { latest = store.snapshot(); });
  change(true); assert.equal(latest, true); stop();
  assert.deepEqual(counts(), { added: 1, removed: 1, active: 0 });
});

test('an absent browser or media-query API is a safe stable fallback', () => {
  const store = createMotionPreferenceStore(() => null);
  assert.equal(store.snapshot(), false);
  const stop = store.subscribe(() => assert.fail('No event source'));
  stop(); stop(); assert.equal(store.snapshot(), false);
});

test('identical React callbacks still have independent subscription lifetimes', () => {
  const { store, change, counts } = fixture(); let calls = 0;
  const listener = () => { calls++; };
  const a = store.subscribe(listener), b = store.subscribe(listener);
  a(); change(true); assert.equal(calls, 1); b();
  assert.equal(counts().active, 0);
});
