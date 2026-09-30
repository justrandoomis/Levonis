/**
 * THE SURFACE COMPILER (Programme C, C1 lane L2; docs/LEVO_PROJECT_PROGRAMME.md
 * §B.1 «The surface compiler», §A C1.46 and C2.8, §F F9).
 *
 * Pins: the five archetypes compile to exactly the survey's tiles (name stand
 * Name · Look · Size · More + the door = 5 row controls; QR menu stand Logo ·
 * Look · QR · More; request-only photo lamp Photo · Size · Text; name keychain
 * Name · Look · More; group participant Name · Look); 30 generated blueprints
 * all compile to ≤ 4 tiles + 1 door, never a save or share tile, More only
 * when something is left and it lists exactly the declared pages; every
 * declared area reachable exactly once; the photo-only blueprint with no mesh;
 * an icon area on the Name tile or in More; the door for every verdict and
 * state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSurface, type SurfacePlan, type SurfaceState } from '../packages/catalog/src/personalize/surface';
import { sizeValuesInBuild } from '../packages/catalog/src/personalize/rules';
import { blockingCode, checkConfig } from '../packages/catalog/src/personalize/check';
import { priceContextFromPublic } from '../packages/catalog/src/personalize/price';
import { defaultConfig } from '../packages/catalog/src/personalize/config';
import type { BlueprintSpec, MorePage, PublicBlueprint, TileId, Verdict } from '../packages/catalog/src/personalize/types';
import { FIXTURES, NAME_KEYCHAIN } from './fixtures/personalizeBlueprints';
import { generated } from './fixtures/personalizeMoney';

const TILES: readonly TileId[] = ['name', 'text', 'photo', 'logo', 'qr', 'icon', 'look', 'size', 'addons', 'more'];
const PAGES: readonly MorePage[] = ['look', 'tier', 'text', 'photo', 'logo', 'qr', 'icon', 'nfc', 'addons', 'notes', 'ask'];
const READY: SurfaceState = { verdict: 'ready' };
const ids = (s: SurfacePlan) => s.tiles.map((t) => (t.ref ? `${t.id}:${t.ref}` : t.id));
const pages = (s: SurfacePlan) => s.more.map((t) => (t.ref ? `${t.id}:${t.ref}` : t.id));
const controls = (s: SurfacePlan) => s.tiles.length + 1;

// ------------------------------------------------------------ the archetypes

test('the five archetypes compile to exactly the survey\'s tiles — the name stand is 4 tiles + the door = 5 row controls', () => {
  const stand = compileSurface(FIXTURES.nameStand.pub, READY);
  assert.deepEqual(ids(stand), ['name:name', 'look', 'size', 'more']);
  assert.deepEqual(pages(stand), ['look', 'addons', 'notes'], 'More: the finish, the add-ons, a note');
  assert.equal(controls(stand), 5);

  const qr = compileSurface(FIXTURES.qrMenuStand.pub, READY);
  assert.deepEqual(ids(qr), ['logo:logo', 'look', 'qr:qr', 'more'], 'no size: the QR is promoted into its slot');
  assert.deepEqual(pages(qr), ['tier', 'text:shop', 'nfc', 'notes']);

  const lamp = compileSurface(FIXTURES.photoLamp.pub, READY);
  assert.deepEqual(ids(lamp), ['photo:photo', 'size', 'text:caption'], 'one colour only: no Look; the caption fits as a tile, so no More');
  assert.deepEqual(lamp.more, []);

  const keychain = compileSurface(FIXTURES.nameKeychain.pub, READY);
  assert.deepEqual(ids(keychain), ['name:name', 'look', 'more']);
  assert.deepEqual(pages(keychain), ['tier', 'notes']);
  assert.deepEqual(keychain.name_icons, ['badge'], 'the icon rides the Name tile');

  const group = compileSurface(FIXTURES.groupParticipant.pub, READY);
  assert.deepEqual(ids(group), ['name:name', 'look']);
  assert.deepEqual(group.more, []);

  for (const f of Object.values(FIXTURES)) {
    if (!f.tiles) continue;
    assert.deepEqual(compileSurface(f.pub, READY).tiles.map((t) => t.id), f.tiles, `${f.name}: L1's pinned archetype`);
    assert.deepEqual(compileSurface(f.spec, READY).tiles.map((t) => t.id), f.tiles, `${f.name}: the stored spec compiles alike`);
  }
});

test('the photo-only blueprint (no mesh) compiles like any other — its sizes are offered only when the printer makes them', () => {
  const f = FIXTURES.photoOnlySign;
  assert.equal(f.pub.mesh, null);
  assert.ok(f.pub.photos.length > 0);
  assert.deepEqual(ids(compileSurface(f.pub, READY)), ['name:name', 'look'], 'a 300 mm sign is above the 256 mm printer: no Size tile');
  assert.deepEqual(sizeValuesInBuild(f.pub, f.pub.printer), []);
  assert.deepEqual(ids(compileSurface({ ...f.pub, printer: null }, READY)), ['name:name', 'look', 'size']);
  assert.deepEqual(ids(compileSurface({ ...f.pub, printer: { max_mm: [500, 500, 50] } }, READY)), ['name:name', 'look', 'size']);
  assert.deepEqual(ids(compileSurface(f.spec, READY)), ['name:name', 'look', 'size'], 'the stored spec knows no printer');
});

test('an icon area rides the Name tile when there is a name area, else it is a More page', () => {
  const keychain = compileSurface(FIXTURES.nameKeychain.pub, READY);
  assert.deepEqual(keychain.name_icons, ['badge']);
  assert.ok(!keychain.more.some((p) => p.id === 'icon'));
  // The same keychain with its text as a plain text: no name area, so the icon goes to More.
  const plain: BlueprintSpec = { ...NAME_KEYCHAIN, areas: NAME_KEYCHAIN.areas.map((a) => (a.role === 'name' ? { ...a, role: 'text' as const } : a)) };
  const s = compileSurface(plain, READY);
  assert.deepEqual(ids(s), ['text:name', 'look', 'more']);
  assert.deepEqual(pages(s), ['tier', 'icon:badge', 'notes']);
  assert.deepEqual(s.name_icons, []);
  // Icons only, and nothing else to choose: still More, never a tile.
  const bare: BlueprintSpec = { ...plain, areas: plain.areas.filter((a) => a.kind === 'icon'), axes: {} };
  assert.deepEqual(ids(compileSurface(bare, READY)), ['look', 'more']);
  assert.deepEqual(pages(compileSurface(bare, READY)), ['icon:badge', 'notes']);
});

// ------------------------------------------------------------ the door

test('the door for every verdict and state: blocked names the fix; review asks or requests; ready and adjusted add to cart or request', () => {
  const cart = FIXTURES.nameStand.pub;
  const requestOnly = FIXTURES.photoLamp.pub;
  const door = (pub: PublicBlueprint, verdict: Verdict, more: Partial<SurfaceState> = {}) => compileSurface(pub, { verdict, ...more }).door;
  const open = { community_open: true, takes_requests: true };
  assert.deepEqual(door(cart, 'blocked', { fix: 'TEXT_TOO_LONG', ...open }), { kind: 'disabled', fix: 'TEXT_TOO_LONG' });
  assert.deepEqual(door(cart, 'blocked'), { kind: 'disabled' });
  assert.deepEqual(door(cart, 'review', open), { kind: 'request' });
  assert.deepEqual(door(cart, 'review', { community_open: true, takes_requests: false }), { kind: 'ask' });
  assert.deepEqual(door(cart, 'review', { community_open: false, takes_requests: true }), { kind: 'ask' });
  assert.deepEqual(door(cart, 'review'), { kind: 'ask' }, 'unknown is not open');
  for (const v of ['ready', 'adjusted'] as const) {
    assert.deepEqual(door(cart, v), { kind: 'add_to_cart' });
    assert.deepEqual(door(cart, v, open), { kind: 'add_to_cart' });
    assert.deepEqual(door(requestOnly, v, open), { kind: 'request' }, 'a blueprint that does not sell by cart');
    assert.deepEqual(door(requestOnly, v), { kind: 'ask' }, 'requests closed: ask the shop');
  }
  assert.deepEqual(door(requestOnly, 'blocked', { fix: 'CONTENT_MISSING' }), { kind: 'disabled', fix: 'CONTENT_MISSING' });
  // 'ask' closes More only while requests are open.
  assert.deepEqual(pages(compileSurface(cart, { verdict: 'ready', ...open })), ['look', 'addons', 'notes', 'ask']);
});

test('the door from a real check: a fresh name stand is blocked on its empty name; once named it adds to cart', () => {
  const pub = FIXTURES.nameStand.pub;
  const fresh = defaultConfig(pub);
  const blocked = checkConfig(pub, fresh, { price: priceContextFromPublic(pub, fresh.variant) });
  assert.equal(blocked.verdict, 'blocked');
  assert.deepEqual(compileSurface(pub, { verdict: blocked.verdict, fix: blockingCode(blocked.issues) }).door, { kind: 'disabled', fix: 'CONTENT_MISSING' });
  const named = { ...fresh, texts: { name: { style: 'bold' as const, value: ['ALI'] } } };
  const ok = checkConfig(pub, named, { price: priceContextFromPublic(pub, named.variant), fit: (value, _a, o) => ({ lines: [...value], cap_mm: 10, fits: true, code: 'TEXT_OK', style: o.style }) });
  assert.equal(ok.verdict, 'ready');
  assert.deepEqual(compileSurface(pub, { verdict: ok.verdict, fix: blockingCode(ok.issues) }).door, { kind: 'add_to_cart' });
});

// ------------------------------------------------------------ 30 generated blueprints

test('30 generated blueprints: ≤ 4 tiles + 1 door, never a save or share tile, More only when something is left, every area reachable once', () => {
  const doors = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const g = generated(i);
    for (const state of [READY, { verdict: 'blocked', fix: 'COLOR_OUT' }, { verdict: 'review', community_open: true, takes_requests: true }] as SurfaceState[]) {
      const s = compileSurface(g.pub, state);
      const label = `blueprint ${i} (${ids(s).join(' · ')})`;
      doors.add(s.door.kind);
      assert.ok(s.tiles.length <= 4, `${label}: at most 4 tiles`);
      assert.ok(controls(s) <= 5, `${label}: at most 5 row controls`);
      for (const t of s.tiles) {
        assert.ok(TILES.includes(t.id), `${label}: ${t.id} is a tile`);
        assert.ok(!/save|share|start|reset|undo/i.test(t.id), `${label}: never ${t.id} in the row`);
      }
      const more = s.tiles.findIndex((t) => t.id === 'more');
      assert.equal(more >= 0, s.more.length > 0, `${label}: a More tile exactly when More lists something`);
      if (more >= 0) assert.equal(more, s.tiles.length - 1, `${label}: More is last`);
      assert.deepEqual(s.more.map((p) => PAGES.indexOf(p.id)), s.more.map((p) => PAGES.indexOf(p.id)).sort((a, b) => a - b), `${label}: More in page order`);
      for (const p of s.more) assert.ok(PAGES.includes(p.id), `${label}: ${p.id} is a page`);
      // Every declared area is reachable exactly once: a tile, a More page or the Name tile's icons.
      const reached = [...s.tiles.flatMap((t) => (t.ref ? [t.ref] : [])), ...s.more.flatMap((p) => (p.ref ? [p.ref] : [])), ...s.name_icons].sort();
      assert.deepEqual(reached, g.spec.areas.map((a) => a.id).sort(), `${label}: every area once`);
      // Every other declared capability is reachable too.
      const all = [...s.tiles.map((t) => t.id as string), ...s.more.map((p) => p.id as string)];
      assert.equal(all.includes('addons'), g.spec.slots.some((x) => x.choice === 'customer'), `${label}: add-ons iff a customer slot`);
      assert.equal(all.includes('nfc'), !!g.spec.extras.nfc, `${label}: NFC iff declared`);
      assert.equal(s.more.some((p) => p.id === 'look'), Object.keys(g.spec.axes.look?.values ?? {}).length > 1, `${label}: the finish iff two looks`);
      assert.equal(s.more.some((p) => p.id === 'tier'), Object.keys(g.spec.axes.tier?.values ?? {}).length > 1, `${label}: the tier iff two tiers`);
      assert.equal(all.includes('size'), sizeValuesInBuild(g.pub, g.pub.printer).length > 1, `${label}: Size iff two sizes the printer makes`);
      assert.equal(s.name_icons.length > 0, g.spec.areas.some((a) => a.role === 'name') && g.spec.areas.some((a) => a.kind === 'icon'));
      assert.deepEqual(compileSurface(g.pub, state), s, `${label}: deterministic`);
    }
  }
  assert.deepEqual([...doors].sort(), ['add_to_cart', 'ask', 'disabled', 'request'], 'the sweep reaches every door');
});
