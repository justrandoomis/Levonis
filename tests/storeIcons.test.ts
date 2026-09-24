/**
 * A STORE'S INSTALLED APP CARRIES THE STORE'S OWN ICON (merchant platform W2-D,
 * docs/MERCHANT_PLATFORM.md §2 decision 11, §4.5; audit 01 §3.6).
 *
 * The rendition job (worker/lib/storeIcons.ts) against real migrations, a
 * conditional-put R2 bucket and a stubbed `env.IMAGES` whose answers carry the
 * size each transform chain asked for — so the job's own verification (a PNG,
 * exactly that size) runs against the geometry it requested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { asD1, freshDb, row } from './fixtures/app';
import { fixtureWebp, iconEnv, imagesStub, pngOf } from './fixtures/storeIcons';
import {
  PLATFORM_ICON_FOR_ROLE,
  PLATFORM_ICON_REVISION,
  STORE_ICON_MIN_SOURCE,
  STORE_ICON_PATHS,
  STORE_ICON_RECIPE,
  STORE_ICON_ROLES,
  STORE_ICON_SPECS,
  STORE_SURFACE_PRESETS,
  clearStoreIcons,
  iconFingerprint,
  isRenditionKey,
  logoSourceKey,
  readStoreIcons,
  refreshStoreIcons,
  renditionKey,
  retryDelayMs,
  servableStoreIcons,
  storeIconStatus,
  storeSurface,
  type StoreIconSubject,
} from '../worker/lib/storeIcons';
import { MEDIA_REFERENCE_SOURCES } from '../worker/lib/mediaRefs';
import { PLATFORM_ICONS, PLATFORM_ICON_REVISION as SITE_REVISION } from '../src/lib/siteLogo';

const repo = (p: string) => new URL(`../${p}`, import.meta.url);
const LOGO = 'merchants/owner1/public/aaaa1111.webp';

function seed(logo: string | null = LOGO) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('owner1','Ali','a@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner1','Ali 3D');
  `);
  raw
    .prepare(`INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,logo_key) VALUES ('s1','m1','owner1','ali3d','Ali 3D',?)`)
    .run(logo);
  return raw;
}

const store = (raw: ReturnType<typeof seed>): StoreIconSubject =>
  row<StoreIconSubject>(raw, `SELECT id, user_id, logo_key, accent FROM merchant_stores WHERE id = 's1'`)!;

const queued = (raw: ReturnType<typeof seed>) =>
  (raw.prepare(`SELECT object_key FROM media_cleanup_jobs WHERE state = 'pending' ORDER BY object_key`).all() as { object_key: string }[]).map(
    (r) => r.object_key
  );

// ------------------------------------------------------------------ geometry

test('the five renditions: the sizes every platform reads, all PNG, maskable inside the safe zone', () => {
  assert.deepEqual([...STORE_ICON_ROLES], ['icon192', 'icon512', 'maskable512', 'apple180', 'favicon32']);
  assert.equal(STORE_ICON_SPECS.icon192.size, 192);
  assert.equal(STORE_ICON_SPECS.icon512.size, 512);
  assert.equal(STORE_ICON_SPECS.maskable512.size, 512);
  assert.equal(STORE_ICON_SPECS.apple180.size, 180, 'the size iOS asks for');
  assert.equal(STORE_ICON_SPECS.favicon32.size, 32);
  for (const role of STORE_ICON_ROLES) {
    const { size, inner } = STORE_ICON_SPECS[role];
    assert.ok(inner <= size && inner > 0, role);
    assert.equal((size - inner) % 2, 0, `${role}: the margin must split evenly`);
  }
  // Maskable: the logo's inscribed circle (the circle the storefront itself
  // shows the logo through) must sit inside the spec's safe zone — the
  // centred circle whose diameter is 80% of the tile.
  const { size, inner } = STORE_ICON_SPECS.maskable512;
  assert.ok(inner / 2 <= 0.4 * size, `radius ${inner / 2} exceeds the safe zone ${0.4 * size}`);
  assert.ok(inner / size > 0.75, 'and it is not shrunk further than the safe zone requires');
  // The others are the whole logo, never cropped (iOS rounds its own corners).
  for (const role of ['icon192', 'icon512', 'apple180', 'favicon32'] as const) {
    assert.equal(STORE_ICON_SPECS[role].inner, STORE_ICON_SPECS[role].size, role);
  }
});

test('rendition keys: under the owner, public, content-addressed — and never a key a merchant can paste as a logo', () => {
  const key = renditionKey('owner1', '0123456789abcdef', 'maskable512');
  assert.equal(key, 'merchants/owner1/logos/appicon-0123456789abcdef-maskable512.png');
  assert.ok(isRenditionKey(key));
  assert.ok(isRenditionKey(key, 'maskable512'));
  assert.ok(!isRenditionKey(key, 'icon192'), 'a key is only valid for its own role');
  assert.throws(() => renditionKey('owner1', 'not-a-rev', 'icon192'));
  for (const bad of [
    'merchants/owner1/public/appicon-0123456789abcdef-icon192.png', // the merchant-upload kind
    'merchants/owner1/logos/appicon-0123456789abcdef-icon192.webp',
    'merchants/owner1/logos/../x/appicon-0123456789abcdef-icon192.png',
    '/files/merchants/owner1/logos/appicon-0123456789abcdef-icon192.png',
    'https://evil.example/appicon-0123456789abcdef-icon192.png',
  ]) {
    assert.equal(isRenditionKey(bad), false, bad);
  }
});

test('the logo source: a public key or its /files/ path, nothing else', () => {
  assert.equal(logoSourceKey(LOGO), LOGO);
  assert.equal(logoSourceKey(`/files/${LOGO}`), LOGO);
  assert.equal(logoSourceKey('community/owner1/abcd1234.png'), 'community/owner1/abcd1234.png');
  for (const bad of [null, '', '  ', 'https://evil.example/a.png', 'receipts/u/a.png', 'merchants/u/private/a.webp', '../a.png', 42]) {
    assert.equal(logoSourceKey(bad), null, String(bad));
  }
});

test('the ground: every preset the server allows is covered, and today every one is the document black', () => {
  const merchant = readFileSync(repo('worker/routes/merchant.ts'), 'utf8');
  const allowed = /const ACCENTS = \[([^\]]*)\] as const;/.exec(merchant)?.[1] ?? '';
  const presets = [...allowed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(presets.length >= 7);
  assert.deepEqual([...STORE_SURFACE_PRESETS].sort(), [...presets].sort(), 'a preset the server accepts has no ground here');
  const shell = readFileSync(repo('index.html'), 'utf8');
  const themeColor = /<meta name="theme-color" content="([^"]+)"/.exec(shell)?.[1];
  for (const accent of presets) {
    assert.deepEqual(storeSurface({ accent }), { background: '#000000', theme: '#000000' }, accent);
  }
  assert.equal(themeColor, '#000000', 'the splash must match the document the app opens on');
  // An unknown or hostile value is the black, never an error and never echoed.
  for (const accent of ['nope', 'red; background:url(x)', undefined, null, 5]) {
    assert.equal(storeSurface({ accent }).background, '#000000');
  }
});

test('the platform fallback table is the committed PNGs, named exactly as src/lib/siteLogo.ts names them', () => {
  assert.equal(PLATFORM_ICON_REVISION, SITE_REVISION);
  assert.equal(PLATFORM_ICON_FOR_ROLE.icon192, PLATFORM_ICONS.any192);
  assert.equal(PLATFORM_ICON_FOR_ROLE.icon512, PLATFORM_ICONS.any512);
  assert.equal(PLATFORM_ICON_FOR_ROLE.maskable512, PLATFORM_ICONS.maskable512);
  assert.equal(PLATFORM_ICON_FOR_ROLE.apple180, PLATFORM_ICONS.appleTouch);
  assert.equal(PLATFORM_ICON_FOR_ROLE.favicon32, PLATFORM_ICONS.favicon32);
  for (const path of Object.values(PLATFORM_ICON_FOR_ROLE)) {
    const file = repo(`public${path}`);
    assert.ok(existsSync(file), `${path} is not in public/`);
    assert.deepEqual([...readFileSync(file).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], path);
  }
  // Every stable /store-icon/ name maps to a role.
  assert.deepEqual(Object.keys(STORE_ICON_PATHS).sort(), ['192.png', '512.png', 'apple-touch.png', 'favicon-32.png', 'maskable-512.png']);
});

test('the rendition columns are media references, so the guarded cleanup can see what is live', () => {
  const sources = MEDIA_REFERENCE_SOURCES.filter((s) => s.table === 'merchant_store_icons').map((s) => s.column).sort();
  assert.deepEqual(sources, ['apple180_key', 'favicon32_key', 'icon192_key', 'icon512_key', 'maskable512_key', 'source_key']);
});

// ------------------------------------------------------------- the render job

test('a logo is cut into five verified PNGs, stored content-addressed, and committed as one set', async () => {
  const raw = seed();
  const images = imagesStub();
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));

  const out = await refreshStoreIcons(env, store(raw));
  assert.equal(out.outcome, 'ready');
  assert.ok(out.outcome === 'ready' && out.fresh);

  // Five binding calls, each: the whole logo PADDED (never cropped) on the
  // store's ground, to PNG; the maskable one gains its safe-zone margin.
  assert.equal(images.calls.length, 5);
  for (const call of images.calls) {
    assert.equal(call.output.format, 'image/png', 'never WebP: iOS refuses it for a home-screen icon');
    assert.equal(call.output.anim, false);
    assert.equal(call.transforms[0].fit, 'pad');
    assert.equal(call.transforms[0].background, '#000000');
  }
  const maskable = images.calls.find((c) => c.transforms.length === 2);
  assert.ok(maskable, 'the maskable rendition adds a margin');
  assert.equal(maskable.transforms[0].width, 408);
  assert.deepEqual(maskable.transforms[1], { border: { color: '#000000', width: 52 } });

  const saved = await readStoreIcons(asD1(raw), 's1');
  assert.ok(saved);
  assert.equal(saved.source_key, LOGO);
  assert.equal(saved.recipe, STORE_ICON_RECIPE);
  assert.equal(saved.tile_colour, '#000000');
  assert.match(saved.rev ?? '', /^[0-9a-f]{16}$/);
  assert.match(saved.source_sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(saved.lease_token, null, 'the lease is released on commit');
  for (const role of STORE_ICON_ROLES) {
    const key: string | null = saved[`${role}_key` as const];
    assert.equal(key, renditionKey('owner1', saved.rev!, role));
    const object = publicBucket.objects.get(key!);
    assert.ok(object, `${role} was not stored`);
    assert.equal(object.contentType, 'image/png');
    assert.equal(object.cacheControl, 'public, max-age=31536000, immutable', 'content-addressed, so immutable is true');
    const size = new DataView(object.bytes.buffer).getUint32(16);
    assert.equal(size, STORE_ICON_SPECS[role].size, role);
  }
  // The upload ledger knows them, under the owner.
  const ledger = raw.prepare(`SELECT owner_id, mime_type, width FROM file_objects WHERE object_key LIKE 'merchants/owner1/logos/appicon-%'`).all() as {
    owner_id: string;
    mime_type: string;
  }[];
  assert.equal(ledger.length, 5);
  assert.ok(ledger.every((r) => r.owner_id === 'owner1' && r.mime_type === 'image/png'));

  // Now servable, and current.
  const set = servableStoreIcons(store(raw), saved);
  assert.ok(set?.current);
  assert.equal(storeIconStatus(env, store(raw), saved).state, 'ready');
});

test('a second refresh of the same logo renders nothing', async () => {
  const raw = seed();
  const images = imagesStub();
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  await refreshStoreIcons(env, store(raw));
  const out = await refreshStoreIcons(env, store(raw));
  assert.equal(out.outcome, 'ready');
  assert.ok(out.outcome === 'ready' && !out.fresh);
  assert.equal(images.calls.length, 5, 'no second render');
});

test('A CHANGED LOGO: the old set stops being served at once, a new set is cut, the old one is queued for cleanup', async () => {
  const raw = seed();
  const images = imagesStub();
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  await refreshStoreIcons(env, store(raw));
  const first = (await readStoreIcons(asD1(raw), 's1'))!;
  const oldKeys = STORE_ICON_ROLES.map((r) => first[`${r}_key` as const]!);

  const NEW = 'merchants/owner1/public/bbbb2222.webp';
  publicBucket.seed(NEW, fixtureWebp(800, 800));
  raw.prepare(`UPDATE merchant_stores SET logo_key = ? WHERE id = 's1'`).run(NEW);

  // Never the removed logo's icon for the new logo, not even for a second.
  assert.equal(servableStoreIcons(store(raw), first), null);
  const due = storeIconStatus(env, store(raw), first);
  assert.equal(due.state, 'pending');
  assert.equal(due.due, true);

  const out = await refreshStoreIcons(env, store(raw));
  assert.equal(out.outcome, 'ready');
  const second = (await readStoreIcons(asD1(raw), 's1'))!;
  assert.equal(second.source_key, NEW);
  assert.notEqual(second.rev, first.rev, 'new bytes are a new URL — which is what updates an installed app');
  const newKeys = STORE_ICON_ROLES.map((r) => second[`${r}_key` as const]!);
  assert.ok(newKeys.every((k) => !oldKeys.includes(k)));
  // The replaced renditions are queued (the guarded drain deletes them after
  // re-checking references); the live ones are not.
  assert.deepEqual(queued(raw), [...oldKeys].sort());
});

test('A REMOVED LOGO clears the row and queues its renditions', async () => {
  const raw = seed();
  const { env, publicBucket } = iconEnv(asD1(raw), imagesStub().binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  await refreshStoreIcons(env, store(raw));
  const keys = STORE_ICON_ROLES.map((r) => (row<Record<string, string>>(raw, `SELECT * FROM merchant_store_icons`)!)[`${r}_key`]);

  raw.exec(`UPDATE merchant_stores SET logo_key = NULL WHERE id = 's1'`);
  assert.equal(storeIconStatus(env, store(raw), await readStoreIcons(asD1(raw), 's1')).state, 'none');
  const out = await refreshStoreIcons(env, store(raw));
  assert.equal(out.outcome, 'cleared');
  assert.equal(await readStoreIcons(asD1(raw), 's1'), null);
  assert.deepEqual(queued(raw), [...keys].sort());
  // And clearing nothing is a no-op.
  assert.equal(await clearStoreIcons(env, 's1'), false);
  assert.equal((await refreshStoreIcons(env, store(raw))).outcome, 'none');
});

test('WITHOUT the Images binding nothing is rendered and nothing pretends to have been', async () => {
  const raw = seed();
  const { env, publicBucket } = iconEnv(asD1(raw), undefined);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  const status = storeIconStatus(env, store(raw), null);
  assert.equal(status.state, 'unavailable');
  assert.equal(status.reason, 'IMAGES_UNAVAILABLE');
  assert.equal(status.due, false, 'no job is scheduled that could only fail');
  assert.equal((await refreshStoreIcons(env, store(raw))).outcome, 'unavailable');
  assert.equal(await readStoreIcons(asD1(raw), 's1'), null, 'no row, no fake PNG');
  assert.equal(publicBucket.puts, 0);
});

test('a missing logo object fails with a stable reason and is not retried before its back-off', async () => {
  const raw = seed();
  const images = imagesStub();
  const { env } = iconEnv(asD1(raw), images.binding);
  const t0 = new Date('2026-09-24T10:00:00Z');
  const out = await refreshStoreIcons(env, store(raw), { now: t0 });
  assert.equal(out.outcome, 'failed');
  assert.ok(out.outcome === 'failed' && out.reason === 'SOURCE_MISSING');
  const failed = (await readStoreIcons(asD1(raw), 's1'))!;
  assert.equal(failed.failed_fingerprint, iconFingerprint(LOGO, '#000000'));
  assert.equal(failed.failure_reason, 'SOURCE_MISSING');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lease_token, null);
  assert.equal(failed.source_key, null, 'nothing committed');

  const soon = new Date(t0.getTime() + 60_000);
  const status = storeIconStatus(env, store(raw), failed, soon);
  assert.equal(status.state, 'failed');
  assert.equal(status.reason, 'SOURCE_MISSING');
  assert.equal(status.due, false);
  assert.equal((await refreshStoreIcons(env, store(raw), { now: soon })).outcome, 'deferred');

  // After the back-off it is tried again — and the attempts count on.
  const later = new Date(t0.getTime() + retryDelayMs('SOURCE_MISSING', 1) + 1000);
  assert.equal(storeIconStatus(env, store(raw), failed, later).due, true);
  assert.equal((await refreshStoreIcons(env, store(raw), { now: later })).outcome, 'failed');
  assert.equal((await readStoreIcons(asD1(raw), 's1'))!.attempts, 2);
  assert.equal(images.calls.length, 0, 'no binding call for a source that is not there');
});

test('a logo that is too small, or not an image, is refused for a week — a NEW logo is tried at once', async () => {
  for (const [bytes, reason] of [
    [fixtureWebp(STORE_ICON_MIN_SOURCE - 1, 400), 'SOURCE_TOO_SMALL'],
    [new TextEncoder().encode('<!doctype html><html><body>not a logo</body></html>'), 'SOURCE_NOT_IMAGE'],
    [new Uint8Array(64), 'SOURCE_NOT_IMAGE'],
  ] as const) {
    const raw = seed();
    const images = imagesStub();
    const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
    publicBucket.seed(LOGO, bytes);
    const now = new Date('2026-09-24T10:00:00Z');
    const out = await refreshStoreIcons(env, store(raw), { now });
    assert.ok(out.outcome === 'failed' && out.reason === reason, `${reason}: ${JSON.stringify(out)}`);
    const saved = (await readStoreIcons(asD1(raw), 's1'))!;
    assert.equal(Date.parse(saved.retry_after!) - now.getTime(), 7 * 24 * 60 * 60 * 1000);
    assert.equal(images.calls.length, 0);

    // A new logo is a new fingerprint: tried immediately.
    const NEW = 'merchants/owner1/public/cccc3333.webp';
    publicBucket.seed(NEW, fixtureWebp(512, 512));
    raw.prepare(`UPDATE merchant_stores SET logo_key = ? WHERE id = 's1'`).run(NEW);
    assert.equal((await refreshStoreIcons(env, store(raw), { now })).outcome, 'ready', reason);
  }
});

test('an AVIF logo is measured by the binding itself before it is cut', async () => {
  const raw = seed('merchants/owner1/public/dddd4444.avif');
  const images = imagesStub({ info: { format: 'image/avif', fileSize: 100, width: 300, height: 300 } });
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  // ftyp avif header: the sniffer knows it, the header reader does not.
  const avif = new Uint8Array(32);
  avif.set([0, 0, 0, 32], 0);
  avif.set(new TextEncoder().encode('ftypavif'), 4);
  publicBucket.seed('merchants/owner1/public/dddd4444.avif', avif, 'image/avif');
  assert.equal((await refreshStoreIcons(env, store(raw))).outcome, 'ready');
});

test('a binding answer that is not exactly the size asked for is refused — no icon may lie about its size', async () => {
  const raw = seed();
  const images = imagesStub({ forceSize: 500 });
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  const out = await refreshStoreIcons(env, store(raw));
  assert.ok(out.outcome === 'failed' && out.reason === 'RENDITION_INVALID', JSON.stringify(out));
  const saved = (await readStoreIcons(asD1(raw), 's1'))!;
  assert.equal(saved.source_key, null, 'nothing committed');
  assert.equal(servableStoreIcons(store(raw), saved), null);
  // Transient kinds back off from fifteen minutes.
  assert.equal(retryDelayMs('RENDITION_INVALID', 1), 15 * 60 * 1000);
  assert.equal(retryDelayMs('RENDITION_FAILED', 3), 60 * 60 * 1000);
  assert.equal(retryDelayMs('RENDITION_FAILED', 40), 24 * 60 * 60 * 1000, 'capped at a day');
});

test('a binding that throws is a recorded failure, and what it had stored is queued', async () => {
  const raw = seed();
  let n = 0;
  const images = imagesStub({
    beforeOutput: () => {
      n += 1;
      if (n === 3) throw new Error('binding hiccup');
    },
  });
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  const out = await refreshStoreIcons(env, store(raw));
  assert.ok(out.outcome === 'failed' && out.reason === 'RENDITION_FAILED', JSON.stringify(out));
  // The two renditions stored before the failure are referenced by nothing.
  assert.equal(queued(raw).length, 2);
  assert.ok(queued(raw).every((k) => isRenditionKey(k)));
});

test('TWO REQUESTS AT ONCE render the logo once — the lease decides', async () => {
  const raw = seed();
  const images = imagesStub();
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  const [a, b] = await Promise.all([refreshStoreIcons(env, store(raw)), refreshStoreIcons(env, store(raw))]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['busy', 'ready']);
  assert.equal(images.calls.length, 5, 'rendered once');
});

test('A NEWER LOGO overtakes a render in flight; the old render commits nothing and cleans up after itself', async () => {
  const raw = seed();
  const OLD = LOGO;
  const NEW = 'merchants/owner1/public/eeee5555.webp';
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let gated = true;
  const images = imagesStub({
    beforeOutput: async (n) => {
      // Hold the FIRST render after its first rendition.
      if (gated && n === 1) await gate;
    },
  });
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  publicBucket.seed(OLD, fixtureWebp(640, 480));
  publicBucket.seed(NEW, fixtureWebp(700, 700));

  const oldSubject = store(raw);
  const slow = refreshStoreIcons(env, oldSubject);
  // Let the slow render take its lease and reach the gate.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(row(raw, `SELECT lease_token FROM merchant_store_icons WHERE lease_fingerprint = ?`, iconFingerprint(OLD, '#000000')));

  // The merchant replaces the logo while it renders.
  raw.prepare(`UPDATE merchant_stores SET logo_key = ? WHERE id = 's1'`).run(NEW);
  gated = false;
  const fast = await refreshStoreIcons(env, store(raw));
  assert.equal(fast.outcome, 'ready', 'a different fingerprint takes the lease');

  release();
  const late = await slow;
  assert.equal(late.outcome, 'superseded');
  const saved = (await readStoreIcons(asD1(raw), 's1'))!;
  assert.equal(saved.source_key, NEW, 'the newer logo won and stayed');
  // Everything the overtaken render stored is queued; nothing live is.
  const live = STORE_ICON_ROLES.map((r) => saved[`${r}_key` as const]);
  assert.ok(queued(raw).length > 0);
  assert.ok(queued(raw).every((k) => !live.includes(k)));
});

test('a render never commits for a logo the store no longer has, even holding the lease', async () => {
  const raw = seed();
  const images = imagesStub({
    beforeOutput: (n) => {
      // Mid-render, the logo is removed outright.
      if (n === 5) raw.exec(`UPDATE merchant_stores SET logo_key = NULL WHERE id = 's1'`);
    },
  });
  const { env, publicBucket } = iconEnv(asD1(raw), images.binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  const out = await refreshStoreIcons(env, store(raw));
  assert.equal(out.outcome, 'superseded');
  const saved = await readStoreIcons(asD1(raw), 's1');
  assert.equal(saved?.source_key ?? null, null);
  assert.equal(queued(raw).length, 5);
});

test('a row is not a promise: a tampered or half-foreign key set is never served', async () => {
  const raw = seed();
  const { env, publicBucket } = iconEnv(asD1(raw), imagesStub().binding);
  publicBucket.seed(LOGO, fixtureWebp(640, 480));
  await refreshStoreIcons(env, store(raw));
  const good = (await readStoreIcons(asD1(raw), 's1'))!;
  assert.ok(servableStoreIcons(store(raw), good));
  for (const tamper of [
    { icon192_key: 'merchants/owner1/public/x1234567.png' },
    { apple180_key: 'https://evil.example/a.png' },
    { maskable512_key: good.icon512_key }, // the right shape, the wrong role
    { favicon32_key: renditionKey('owner1', 'ffffffffffffffff', 'favicon32') }, // another revision
    { rev: 'short' },
  ]) {
    assert.equal(servableStoreIcons(store(raw), { ...good, ...tamper }), null, JSON.stringify(tamper));
  }
  // An OLDER recipe of the same logo is still this logo: served, but not current.
  const older = servableStoreIcons(store(raw), { ...good, recipe: STORE_ICON_RECIPE - 1 });
  assert.ok(older && !older.current);
  const status = storeIconStatus(env, store(raw), { ...good, recipe: STORE_ICON_RECIPE - 1 });
  assert.equal(status.state, 'ready');
  assert.equal(status.due, true, 'and a re-cut is due');
});

test('the database refuses a half-written set', () => {
  const raw = seed();
  assert.throws(() =>
    raw.exec(`INSERT INTO merchant_store_icons (store_id, source_key, rev) VALUES ('s1', '${LOGO}', '0123456789abcdef')`)
  );
  assert.throws(() => raw.exec(`INSERT INTO merchant_store_icons (store_id, tile_colour) VALUES ('s1', 'red')`));
  // An empty row (a lease, a failure) is fine.
  raw.exec(`INSERT INTO merchant_store_icons (store_id, lease_token) VALUES ('s1', 't')`);
  // And the store's deletion takes it with it.
  raw.exec(`DELETE FROM merchant_stores WHERE id = 's1'`);
  assert.equal(row(raw, `SELECT 1 AS x FROM merchant_store_icons`), undefined);
});

test('the migration is additive and re-runnable', () => {
  const raw = seed();
  const sql = readFileSync(repo('migrations/0123_store_app_icons.sql'), 'utf8');
  // No statement that changes an existing table or row (`ON DELETE CASCADE`
  // is a clause of the new table, not a statement).
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /^\s*(?:DROP|ALTER|UPDATE|DELETE|INSERT)\b/im);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS merchant_store_icons/);
  assert.doesNotThrow(() => raw.exec(sql), 'IF NOT EXISTS');
});

test('pngOf is what the verification reads (fixture self-check)', () => {
  const png = pngOf(180, 180);
  assert.equal(new DataView(png.buffer).getUint32(16), 180);
});
