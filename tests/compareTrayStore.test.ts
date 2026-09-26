/**
 * THE COMPARE TRAY STORE (src/lib/compareTray.ts, CATALOG_DISCOVERY §10.4,
 * stream S3) — pure, with an injected storage and clock.
 *
 * Pinned: max four (the fifth is refused and says so), one product type (a
 * conflict ASKS, it never silently replaces), persistence under
 * `lv_compare_v1` with a version and a 30-day expiry, memory-only when
 * storage throws, two tabs converging through the `storage` event, clear +
 * undo, and `replaceAll` for the compare page's URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPARE_TRAY_KEY,
  COMPARE_TRAY_MAX,
  COMPARE_TRAY_TTL_MS,
  compareHref,
  createCompareTray,
  parseTray,
  type TrayItem,
  type TrayStorage,
} from '../src/lib/compareTray';

class MemoryStorage implements TrayStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

class ThrowingStorage implements TrayStorage {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem() {
    throw new Error('QuotaExceededError');
  }
  removeItem() {
    throw new Error('SecurityError');
  }
}

const item = (id: string): TrayItem => ({ id, slug: `slug-${id}`, name: `Printer ${id}`, image: `/files/${id}.webp` });

test('adds, persists under lv_compare_v1 with a version, and reads back', () => {
  const storage = new MemoryStorage();
  let now = 1_000_000;
  const tray = createCompareTray({ storage, now: () => now });
  assert.deepEqual(tray.add(item('a'), 'printer'), { ok: true, added: true });
  assert.deepEqual(tray.add(item('a'), 'printer'), { ok: true, added: false }, 'an item already in the tray is not added twice');
  assert.equal(tray.has('a'), true);
  const saved = JSON.parse(storage.getItem(COMPARE_TRAY_KEY)!);
  assert.equal(saved.v, 1);
  assert.equal(saved.type, 'printer');
  assert.equal(saved.at, now);
  assert.deepEqual(saved.items, [item('a')]);

  now += 1000;
  const again = createCompareTray({ storage, now: () => now });
  assert.deepEqual(again.getSnapshot().items.map((i) => i.id), ['a']);
});

test('max four: the fifth is refused with `full`, publishes the notice, and asks the tray to open', () => {
  const tray = createCompareTray({ storage: new MemoryStorage(), now: () => 1 });
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(tray.add(item(id), 'printer').ok, true);
  assert.equal(COMPARE_TRAY_MAX, 4);
  assert.deepEqual(tray.add(item('e'), 'printer'), { ok: false, reason: 'full' });
  assert.equal(tray.getNotice(), null, 'plain add publishes nothing');
  const expandBefore = tray.getExpandSeq();
  const r = tray.request(item('e'), 'printer');
  assert.deepEqual(r, { ok: false, reason: 'full' });
  assert.equal(tray.getNotice()?.kind, 'full');
  assert.equal(tray.getExpandSeq(), expandBefore + 1);
  assert.deepEqual(tray.getSnapshot().items.map((i) => i.id), ['a', 'b', 'c', 'd'], 'nothing was dropped to make room');
  tray.consumeNotice(tray.getNotice()!.seq);
  assert.equal(tray.getNotice(), null);
});

test('one type: another type is refused with `type` and a conflict notice; starting over replaces', () => {
  const tray = createCompareTray({ storage: new MemoryStorage(), now: () => 1 });
  tray.add(item('p1'), 'printer');
  tray.add(item('p2'), 'printer');
  assert.deepEqual(tray.add(item('pla'), 'filament'), { ok: false, reason: 'type', current: 'printer' });
  tray.request(item('pla'), 'filament');
  const n = tray.getNotice();
  assert.ok(n && n.kind === 'conflict');
  assert.equal(n.item.id, 'pla');
  assert.equal(n.type, 'filament');
  assert.equal(n.current, 'printer');
  assert.deepEqual(tray.getSnapshot().items.map((i) => i.id), ['p1', 'p2'], 'nothing replaced before the shopper answers');
  // «ابدأ من جديد».
  tray.replaceAll([n.item], n.type);
  assert.equal(tray.getSnapshot().type, 'filament');
  assert.deepEqual(tray.getSnapshot().items.map((i) => i.id), ['pla']);
  // Emptying the tray frees the type.
  tray.clear();
  assert.equal(tray.add(item('p3'), 'printer').ok, true);
});

test('toggle removes what is there and adds what is not', () => {
  const tray = createCompareTray({ storage: new MemoryStorage(), now: () => 1 });
  tray.toggle(item('a'), 'printer');
  assert.equal(tray.has('a'), true);
  assert.deepEqual(tray.toggle(item('a'), 'printer'), { ok: true, added: false, removed: true });
  assert.equal(tray.has('a'), false);
  assert.equal(tray.getSnapshot().type, null, 'an empty tray has no type');
});

test('expires 30 days after the last change; malformed or old versions read as empty', () => {
  const storage = new MemoryStorage();
  const start = 5_000_000_000;
  createCompareTray({ storage, now: () => start }).add(item('a'), 'printer');
  assert.equal(createCompareTray({ storage, now: () => start + COMPARE_TRAY_TTL_MS - 1 }).getSnapshot().items.length, 1);
  assert.equal(createCompareTray({ storage, now: () => start + COMPARE_TRAY_TTL_MS + 1 }).getSnapshot().items.length, 0);

  assert.equal(parseTray('not json', 1).items.length, 0);
  assert.equal(parseTray(JSON.stringify({ v: 2, type: 'printer', items: [item('a')], at: 1 }), 1).items.length, 0);
  assert.equal(parseTray(JSON.stringify({ v: 1, type: 'printer', items: 'x', at: 1 }), 1).items.length, 0);
  // Duplicates and a list longer than four are cut, never trusted.
  const long = parseTray(JSON.stringify({ v: 1, type: 'printer', items: ['a', 'a', 'b', 'c', 'd', 'e'].map(item), at: 1 }), 1);
  assert.deepEqual(long.items.map((i) => i.id), ['a', 'b', 'c', 'd']);
});

test('private mode: storage that throws keeps the tray working in memory', () => {
  const tray = createCompareTray({ storage: new ThrowingStorage(), now: () => 1 });
  assert.equal(tray.getSnapshot().items.length, 0);
  assert.equal(tray.add(item('a'), 'printer').ok, true);
  assert.equal(tray.add(item('b'), 'printer').ok, true);
  assert.deepEqual(tray.getSnapshot().items.map((i) => i.id), ['a', 'b']);
  tray.remove('a');
  assert.deepEqual(tray.getSnapshot().items.map((i) => i.id), ['b']);
  tray.sync();
  assert.deepEqual(tray.getSnapshot().items.map((i) => i.id), ['b'], 'a sync with unreadable storage keeps memory');
  // And no storage at all (server-side render, a worker).
  const none = createCompareTray({ storage: null, now: () => 1 });
  assert.equal(none.add(item('z'), 'printer').ok, true);
});

test('two tabs converge through the storage event', () => {
  const shared = new MemoryStorage();
  const tabA = createCompareTray({ storage: shared, now: () => 10 });
  const tabB = createCompareTray({ storage: shared, now: () => 10 });
  let heardB = 0;
  tabB.subscribe(() => heardB++);

  tabA.add(item('a'), 'printer');
  tabA.add(item('b'), 'printer');
  tabB.sync(); // what the `storage` event does in the other tab
  assert.deepEqual(tabB.getSnapshot().items.map((i) => i.id), ['a', 'b']);
  assert.equal(heardB, 1, 'subscribers hear the other tab once');

  tabB.remove('a');
  tabA.sync();
  assert.deepEqual(tabA.getSnapshot().items.map((i) => i.id), ['b']);

  tabA.clear();
  tabB.sync();
  assert.equal(tabB.getSnapshot().items.length, 0);
  assert.equal(shared.getItem(COMPARE_TRAY_KEY), null, 'an empty tray leaves nothing in storage');

  const before = heardB;
  tabB.sync();
  assert.equal(heardB, before, 'an unchanged storage value notifies nobody');
});

test('clear returns what was there, and restore puts it back (the undo toast)', () => {
  const tray = createCompareTray({ storage: new MemoryStorage(), now: () => 1 });
  tray.add(item('a'), 'printer');
  tray.add(item('b'), 'printer');
  const saved = tray.clear();
  assert.equal(tray.getSnapshot().items.length, 0);
  tray.restore(saved);
  assert.deepEqual(tray.getSnapshot().items.map((i) => i.id), ['a', 'b']);
  assert.equal(tray.getSnapshot().type, 'printer');
});

test('replaceAll takes ids from the compare URL and keeps what it already knows', () => {
  const tray = createCompareTray({ storage: new MemoryStorage(), now: () => 1 });
  tray.add(item('a'), 'printer');
  tray.replaceAll(['b', 'a', 'a', 'c', 'd', 'e']);
  const items = tray.getSnapshot().items;
  assert.deepEqual(items.map((i) => i.id), ['b', 'a', 'c', 'd'], 'de-duplicated and capped at four');
  assert.deepEqual(items[1], item('a'), 'a known item keeps its name and photo');
  assert.equal(items[0].slug, 'b');
  assert.equal(tray.getSnapshot().type, 'printer', 'the type is kept unless given');
  assert.equal(compareHref(tray.getSnapshot()), '/compare?ids=b,a,c,d');
  assert.equal(compareHref({ items: [] }), '/compare');
});
