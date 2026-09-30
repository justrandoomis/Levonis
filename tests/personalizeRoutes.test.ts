/**
 * «التخصيص · Personalize · تایبەتکردن» — THE CUSTOMER'S DOORS (Programme C,
 * phase C1; docs/LEVO_PROJECT_PROGRAMME.md §0 rows 3, 4, 27 and 28, §B.1
 * hops 1–3, §B.8, P1, P2, P5, P6, P11, P13).
 *
 * Pinned over the real routes (worker/routes/personalize.ts and the upload
 * sessions door), on the world of tests/fixtures/personalizeWorld.ts:
 *   · DARK BY DEFAULT: every door answers 404 PERSONALIZATION_UNAVAILABLE to a
 *     guest, a member and another merchant — while a platform admin (on the
 *     apex) and the product's own merchant preview, `private, no-store`;
 *   · GET /status per viewer, the pilot lists;
 *   · the public blueprint: the P13 lifetime (60/60/60), the declared params
 *     ['rev'], a paused product 404 without `rev` and its revision with it,
 *     nothing private in the body, the edge stores only a guest's answer;
 *   · POST /configs: owner-scoped, one row per equal choices (201 then 200),
 *     the price the engine's own from the live base and the live parts, every
 *     strict refusal with its path, the check's `blocked` and `review`
 *     verdicts, decency without quoting the word, only the owner's pictures;
 *   · GET /configs/:id the owner's alone; GET /assets the owner's picture with
 *     `nosniff` and a sandbox; the `design_asset` upload purpose;
 *   · the admin writes the switch through its normaliser, audited, never public.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { asD1, count, ctx, get, json, pending, post, put, row, all, MERCHANT_HOST, type App, type StubUser } from './fixtures/app';
import {
  ALI, ZAIN, BOSS, BUYER, SAMI, ASSET_KEY, SAMI_ASSET_KEY, PRIVATE_NOTE,
  as, personalizeWorld, publishSign, publishStand, readBlueprint, setSwitch, signSpec, pngBytes, type World,
} from './fixtures/personalizeWorld';
import { BLUEPRINT_READ_PARAMS, PERSONALIZE_LIFETIME } from '../worker/routes/personalize';
import { canonicalKey, cacheControlFor } from '../worker/lib/edgePolicy';
import { rateLimitKey } from '../worker/lib/ratelimit';
import { PUBLIC_SETTING_KEYS, SETTING_DEFAULTS, getSetting } from '../worker/lib/settings';
import { quotaBytesFor } from '../worker/lib/uploadEntity';
import { BLOCKED_SEED } from '../worker/lib/nameGuard';
import { defaultConfig } from '../packages/catalog/src/personalize/config';
import { priceConfig, priceContextFromPublic } from '../packages/catalog/src/personalize/price';
import type { DesignConfig, PublicBlueprint } from '../packages/catalog/src/personalize/types';

const P13 = 'public, max-age=60, s-maxage=60, stale-while-revalidate=60';
const TWIN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

const code = async (res: Response) => (await json(res)).code as string | undefined;

/** The sign's public blueprint, as the studio would read it. */
async function signPub(w: World): Promise<PublicBlueprint> {
  const res = await readBlueprint(w, 'cp_sign');
  assert.equal(res.status, 200, await res.clone().text());
  return (await json(res)).blueprint as PublicBlueprint;
}

/** A filled sign: HOPE, the large size, two magnets. */
function signConfig(pub: PublicBlueprint, over: Partial<Record<keyof DesignConfig, unknown>> = {}): Record<string, unknown> {
  return {
    ...defaultConfig(pub),
    variant: 'pv_sl',
    texts: { name: { value: ['HOPE'], style: 'elegant' } },
    slots: { magnet: { option: 'm10' }, light: { option: null } },
    ...over,
  };
}

const mint = (w: World, user: StubUser, configuration: unknown, productId = 'cp_sign') =>
  post(as(w, user), '/api/personalize/configs', { product_id: productId, configuration });

/** `caches.default` as a zone keeps it: what was stored, what was asked for. */
function withZoneCache() {
  const store = new Map<string, Response>();
  const deleted: string[] = [];
  const cache = {
    async match(req: Request) {
      const hit = store.get(req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
    async delete(req: Request) {
      deleted.push(req.url);
      return store.delete(req.url);
    },
  };
  const scope = globalThis as { caches?: unknown };
  scope.caches = { default: cache };
  return { store, deleted, done: () => void delete scope.caches };
}

// ====================================================================== dark

test('dark by default: every door is 404 PERSONALIZATION_UNAVAILABLE for a guest, a member and another merchant', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const minted = await json(await mint(w, BUYER, signConfig(await signPub(w))));
  assert.ok(minted.config_id);
  // The owner switches it off — the default the setting ships with.
  setSwitch(w.raw, SETTING_DEFAULTS.customizationConfig as unknown as Record<string, unknown>);

  for (const who of [null, BUYER, ZAIN] as const) {
    const res = await readBlueprint(w, 'cp_sign', who);
    assert.equal(res.status, 404, `read as ${who?.id ?? 'guest'}`);
    assert.equal(await code(res), 'PERSONALIZATION_UNAVAILABLE');
  }
  for (const who of [BUYER, ZAIN, SAMI]) {
    const res = await mint(w, who, minted.config);
    assert.equal(res.status, 404, `mint as ${who.id}`);
    assert.equal(await code(res), 'PERSONALIZATION_UNAVAILABLE');
  }
  const again = await get(as(w, BUYER), `/api/personalize/configs/${minted.config_id}`);
  assert.equal(again.status, 404);
  assert.equal(await code(again), 'PERSONALIZATION_UNAVAILABLE', 'even the owner\'s own design waits for the switch');
  const asset = await get(as(w, BUYER), `/api/personalize/assets/${ASSET_KEY}`);
  assert.equal(asset.status, 404);
  assert.equal(await code(asset), 'PERSONALIZATION_UNAVAILABLE');
  const upload = await post(as(w, BUYER), '/api/uploads/sessions', { purpose: 'design_asset', entity_id: 'cp_sign', file_name: 'logo.png', bytes: 97, mime: 'image/png', sha256: 'a'.repeat(64) });
  assert.equal(upload.status, 404);
  assert.equal(await code(upload), 'PERSONALIZATION_UNAVAILABLE');
  // And the status says so, to everyone.
  for (const who of [null, BUYER, ZAIN, ALI] as const) {
    const s = await json(await get(as(w, who), '/api/personalize/status'));
    assert.deepEqual({ on: s.on, cart: s.cart, create: s.create, social: s.social }, { on: false, cart: false, create: false, social: false }, who?.id ?? 'guest');
  }
});

test('while dark, a platform admin (on the apex) and the product\'s own merchant PREVIEW — private, no-store, never on a store host', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  setSwitch(w.raw, { enabled: false });
  for (const who of [BOSS, ALI]) {
    const res = await readBlueprint(w, 'cp_sign', who);
    assert.equal(res.status, 200, who.id);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store', `${who.id}: a preview is nobody else's`);
    const body = await json(res);
    assert.equal(body.preview, true);
    assert.equal(body.blueprint.product.id, 'cp_sign');
  }
  // An admin role on a store's own host is not a platform admin.
  const onStoreHost = await get(as(w, BOSS, { host: MERCHANT_HOST }), '/api/personalize/blueprints/cp_sign');
  assert.equal(onStoreHost.status, 404);
  // Zain owns another store: nothing to preview here.
  assert.equal((await readBlueprint(w, 'cp_sign', ZAIN)).status, 404);
  // A previewer may try a design too; the configuration is theirs alone.
  const pub = (await json(await readBlueprint(w, 'cp_sign', BOSS))).blueprint as PublicBlueprint;
  const res = await mint(w, BOSS, signConfig(pub));
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
});

// ==================================================================== status

test('GET /status answers per viewer: the switch, the pilot lists, the builder; a guest answer is edge-kept for P13 and varies on Cookie', async () => {
  const w = personalizeWorld();
  const status = async (who: StubUser | null) => {
    const res = await get(as(w, who), '/api/personalize/status');
    assert.equal(res.status, 200);
    const b = await json(res);
    return { res, s: { on: b.on, may_use: b.may_use, may_build: b.may_build, cart: b.cart, create: b.create, social: b.social } };
  };
  const off = { on: false, may_use: false, may_build: false, cart: false, create: false, social: false };
  const guest = await status(null);
  assert.deepEqual(guest.s, off);
  assert.equal(guest.res.headers.get('Cache-Control'), P13);
  assert.equal(cacheControlFor(PERSONALIZE_LIFETIME), P13);
  assert.match(guest.res.headers.get('Vary') ?? '', /Cookie/);
  const signedIn = await status(BUYER);
  assert.deepEqual(signedIn.s, off);
  assert.equal(signedIn.res.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await status(ALI)).s, off, 'dark: no builder either');
  assert.deepEqual((await status(BOSS)).s, { ...off, may_use: true }, 'an admin may look (preview), and has no store to build in');

  setSwitch(w.raw, { pilot_user_ids: ['buyer'], pilot_store_ids: ['s_ali'] });
  assert.deepEqual((await status(BUYER)).s, { ...off, on: true, may_use: true }, 'a pilot person');
  assert.deepEqual((await status(SAMI)).s, off);
  assert.deepEqual((await status(ALI)).s, { ...off, may_build: true }, 'a pilot store builds; its products are on for everyone (the store path)');
  assert.deepEqual((await status(ZAIN)).s, off);
  assert.deepEqual((await status(null)).s, off);

  setSwitch(w.raw, { enabled: true, cart: true });
  assert.deepEqual((await status(null)).s, { ...off, on: true, may_use: true, cart: true });
  assert.deepEqual((await status(ZAIN)).s, { ...off, on: true, may_use: true, may_build: true, cart: true });
});

test('a pilot store opens its products for everyone, a pilot person only for themselves — nothing else lights up', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  setSwitch(w.raw, { pilot_store_ids: ['s_ali'] });
  for (const who of [null, BUYER, ZAIN]) {
    const res = await readBlueprint(w, 'cp_sign', who);
    assert.equal(res.status, 200, who?.id ?? 'guest');
    assert.equal((await json(res)).preview, false);
  }
  setSwitch(w.raw, { pilot_user_ids: ['buyer'] });
  assert.equal((await readBlueprint(w, 'cp_sign', BUYER)).status, 200);
  assert.equal((await readBlueprint(w, 'cp_sign', SAMI)).status, 404);
  assert.equal((await readBlueprint(w, 'cp_sign', null)).status, 404);
});

// ================================================================ blueprint

test('the blueprint read: P13 lifetime, `rev` the only key parameter, a paused product 404 without it and its revision with it', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const res = await readBlueprint(w, 'cp_sign');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), P13);
  assert.match(res.headers.get('ETag') ?? '', /^W\/"[0-9a-f]{32}"$/);
  const body = await json(res);
  assert.equal(body.preview, false);
  assert.equal(body.blueprint.rev, 1);
  assert.deepEqual([...BLUEPRINT_READ_PARAMS], ['rev']);
  assert.equal(
    canonicalKey('https://levonis-iq.com/api/personalize/blueprints/cp_sign?utm_source=x&rev=1&v=9', BLUEPRINT_READ_PARAMS).url,
    'https://levonis-iq.com/api/personalize/blueprints/cp_sign?rev=1',
    'an undeclared parameter mints no entry'
  );
  // A revalidation is a bodiless 304 with the same policy.
  const again = await get(as(w, null), '/api/personalize/blueprints/cp_sign', { 'If-None-Match': res.headers.get('ETag')! });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('Cache-Control'), P13);

  // Paused: the product is no longer personalised — but the revision a cart line named still renders.
  assert.equal((await post(as(w, ALI), '/api/merchant/products/cp_sign/blueprint/pause', {})).status, 200);
  const paused = await readBlueprint(w, 'cp_sign');
  assert.equal(paused.status, 404);
  assert.equal(await code(paused), 'PERSONALIZATION_UNAVAILABLE');
  const byRev = await readBlueprint(w, 'cp_sign', null, '?rev=1');
  assert.equal(byRev.status, 200);
  assert.equal((await json(byRev)).blueprint.rev, 1);
  // A draft is never served, whatever `rev` says; nor a number that names nothing.
  assert.equal((await put(as(w, ALI), '/api/merchant/products/cp_sign/blueprint/draft', { spec: signSpec() })).status, 200);
  assert.equal(row<{ n: number }>(w.raw, "SELECT COUNT(*) AS n FROM product_blueprints WHERE product_id = 'cp_sign' AND state = 'draft' AND rev = 2")!.n, 1);
  for (const q of ['?rev=2', '?rev=9', '?rev=abc', '?rev=0', '?rev=-1']) {
    assert.equal((await readBlueprint(w, 'cp_sign', null, q)).status, 404, q);
  }
  assert.equal((await readBlueprint(w, 'cp_nothing')).status, 404);
  assert.equal((await readBlueprint(w, 'cp_plain')).status, 404, 'a product without a blueprint');
  assert.equal((await get(as(w, null), '/api/personalize/blueprints/..%2Fetc')).status, 404);
});

test('the public body carries no private note, no fit rule, no hidden part, no part name from the file, no key, no count — booleans only', async () => {
  const w = personalizeWorld({ on: true });
  await publishStand(w);
  await publishSign(w);
  for (const id of ['cp_stand', 'cp_sign']) {
    const res = await readBlueprint(w, id);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const marker of [PRIVATE_NOTE, 'accepts', 'diameter_mm', 'cp_glue', 'Glue', 'Name plate', '"Body"', 'product-files', '/blueprints/', 'draft_mesh_key', 'source_keys', 'grams', 'private', 'cost', '"stock":5', 'part_spec']) {
      assert.ok(!text.includes(marker), `${id}: the public body carries ${marker}`);
    }
  }
  const stand = (await json(await readBlueprint(w, 'cp_stand'))).blueprint;
  assert.match(stand.mesh.url, /^\/files\/merchants\/ali\/public\/bp\/bp_[0-9a-f]{20}-r1-[0-9a-f]{12}\.lvm\.gz$/);
  assert.equal(stand.mesh.triangles, 12, 'the name plate no region takes is not in the public mesh');
  assert.deepEqual(stand.fixed, [], 'the hidden glue is merchant-only');
  assert.deepEqual(stand.variants.map((v: { id: string; price_iqd: number; in_stock: boolean }) => [v.id, v.price_iqd, v.in_stock]), [['pv_s', 20000, true], ['pv_m', 23000, true]]);
  assert.deepEqual(stand.slot_options.magnet, [{ key: 'm10', product_id: 'cp_magnet', variant_id: null, name: 'Round magnet 10 mm', image: null, unit_iqd: 1000, in_stock: true }]);
  assert.deepEqual(stand.printer, { max_mm: [256, 256, 256] });
  assert.equal(stand.from_iqd, 20000);
  assert.deepEqual(stand.stock_names, { black: 'Black PLA', white: 'White PLA' });
  assert.equal(stand.stock.default.black, 'in');
  assert.equal(stand.stock.default.red, 'out');
  const sign = (await json(await readBlueprint(w, 'cp_sign'))).blueprint;
  assert.equal(sign.mesh, null, 'photo-only');
  assert.deepEqual(sign.photos.map((p: { media_id: string; url: string }) => [p.media_id, p.url]), [
    ['pm_wood', '/files/merchants/ali/public/aaaa1111.webp'],
    ['pm_black', '/files/merchants/ali/public/bbbb2222.webp'],
  ]);
  assert.equal(sign.slot_options.light[0].in_stock, false, 'the sold-out light says so, as a boolean');
});

test('a product off the shelf, or a store that is not selling, is 404 to customers — its merchant still previews', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const cases: Array<[string, string, string]> = [
    ['hidden', "UPDATE community_products SET publish_state = 'hidden' WHERE id = 'cp_sign'", "UPDATE community_products SET publish_state = 'published' WHERE id = 'cp_sign'"],
    ['store paused', "UPDATE merchant_stores SET status = 'paused' WHERE id = 's_ali'", "UPDATE merchant_stores SET status = 'active' WHERE id = 's_ali'"],
    ['plan lapsed', "UPDATE memberships SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = 'ali'", "UPDATE memberships SET state = 'active', expires_at = '2099-01-01T00:00:00.000Z' WHERE user_id = 'ali'"],
    ['benefit gated', "INSERT INTO restriction_cases (id, user_id, kind, state, reason, benefit_flags) VALUES ('rc_1', 'ali', 'other', 'active', 'review', '[\"customizableProducts\"]')", "DELETE FROM restriction_cases WHERE id = 'rc_1'"],
  ];
  for (const [label, off, on] of cases) {
    w.raw.exec(off);
    assert.equal((await readBlueprint(w, 'cp_sign')).status, 404, `${label}: guest`);
    assert.equal((await readBlueprint(w, 'cp_sign', BUYER)).status, 404, `${label}: member`);
    const own = await readBlueprint(w, 'cp_sign', ALI);
    assert.equal(own.status, 200, `${label}: the merchant still previews`);
    assert.equal((await json(own)).preview, true, `${label}: and is told it is a preview`);
    w.raw.exec(on);
    assert.equal((await readBlueprint(w, 'cp_sign')).status, 200, `${label}: back`);
  }
});

test('the edge keeps a guest\'s answer under its canonical key, and never a signed-in one', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const zone = withZoneCache();
  try {
    assert.equal((await get(as(w, BUYER), '/api/personalize/blueprints/cp_sign?utm=1')).status, 200);
    await Promise.all(pending);
    assert.equal(zone.store.size, 0, 'a signed-in answer is nobody else\'s');
    const HOST = { Host: 'levonis-iq.com' };
    assert.equal((await get(as(w, null), '/api/personalize/blueprints/cp_sign?utm=1&rev=1', HOST)).status, 200);
    await Promise.all(pending);
    assert.deepEqual([...zone.store.keys()], ['https://levonis-iq.com/api/personalize/blueprints/cp_sign?rev=1']);
    // The stored answer is served while it lives — even after the owner switches it off (P13: at most two minutes).
    setSwitch(w.raw, { enabled: false });
    const hit = await get(as(w, null), '/api/personalize/blueprints/cp_sign?rev=1', HOST);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get('Cache-Control'), P13);
    assert.equal((await get(as(w, null), '/api/personalize/blueprints/cp_sign', HOST)).status, 404, 'a new key is built — and dark');
  } finally {
    zone.done();
  }
});

// ============================================================ configurations

test('POST /configs mints ONE configuration per owner and equal choices (201, then 200 with the same id); the price is the engine\'s from the live rows', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const pub = await signPub(w);
  const res = await mint(w, BUYER, signConfig(pub));
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const first = await json(res);
  assert.match(first.config_id, /^cfg_[0-9a-f]{20}$/);
  assert.match(first.twin_code, TWIN);
  // 50,000 (the large sign's own price) + 2 × 1,000 (the magnets) — and exactly what the engine says for the stored choices.
  assert.equal(first.unit_iqd, 52000);
  assert.equal(first.unit_iqd, priceConfig(pub, first.config, priceContextFromPublic(pub, 'pv_sl')).unit_iqd);
  assert.deepEqual(first.adds, [{ key: 'slot:magnet', iqd: 1000, qty: 2 }]);
  assert.deepEqual(first.check, { verdict: 'ready', issues: [] });
  assert.match(first.words.en, /HOPE/);
  assert.match(first.words.en, /Large/, 'the merchant\'s own name for the size');
  assert.match(first.words.ar, /كبيرة/);
  for (const lang of ['ar', 'en', 'ckb']) assert.ok(first.words[lang].length > 5, lang);
  assert.deepEqual(row(w.raw, 'SELECT owner_id, product_id, rev, public, length(hash) AS h FROM design_configs WHERE id = ?', first.config_id), { owner_id: 'buyer', product_id: 'cp_sign', rev: 1, public: 0, h: 64 });
  assert.ok(!row<{ spec: string }>(w.raw, 'SELECT spec FROM design_configs WHERE id = ?', first.config_id)!.spec.includes('iqd'), 'no price is ever stored');

  // The same choices again: the same row.
  const again = await mint(w, BUYER, signConfig(pub));
  assert.equal(again.status, 200);
  const second = await json(again);
  assert.deepEqual([second.config_id, second.twin_code], [first.config_id, first.twin_code]);
  // Another person with the same choices has their own.
  const sami = await json(await mint(w, SAMI, signConfig(pub)));
  assert.notEqual(sami.config_id, first.config_id);
  assert.notEqual(sami.twin_code, first.twin_code);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM design_configs'), 2);
  // The price is the LIVE one: the magnet goes up, the same configuration answers the new unit.
  w.raw.exec("UPDATE community_products SET price_iqd = 1250 WHERE id = 'cp_magnet'");
  const repriced = await json(await mint(w, BUYER, signConfig(pub)));
  assert.equal(repriced.config_id, first.config_id);
  assert.equal(repriced.unit_iqd, 52500);
});

test('POST /configs is strict: price-like keys, unknown ids, another product, bidi and emoji text, a stale revision — each with its path, nothing stored', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const pub = await signPub(w);
  const cases: Array<[string, unknown, number, string, string | undefined]> = [
    ['a price', { ...signConfig(pub), unit_iqd: 1 }, 400, 'CONFIG_INVALID', 'unit_iqd'],
    ['a nested price', signConfig(pub, { slots: { magnet: { option: 'm10', price: 5 } } }), 400, 'CONFIG_INVALID', 'slots.magnet.price'],
    ['a discount', { ...signConfig(pub), discount: 50 }, 400, 'CONFIG_INVALID', 'discount'],
    ['an unknown option', signConfig(pub, { slots: { magnet: { option: 'm99' } } }), 400, 'CONFIG_INVALID', 'slots.magnet.option'],
    ['an unknown variant', signConfig(pub, { variant: 'pv_nope' }), 400, 'CONFIG_INVALID', 'variant'],
    ['an unknown key', { ...signConfig(pub), extra: true }, 400, 'CONFIG_INVALID', 'extra'],
    ['another product', signConfig(pub, { p: 'cp_stand' }), 400, 'CONFIG_INVALID', 'p'],
    ['a bidi override', signConfig(pub, { texts: { name: { value: ['HOPE‮'], style: 'elegant' } } }), 400, 'DESIGN_TEXT_INVALID', 'texts.name.value.0'],
    ['an emoji', signConfig(pub, { texts: { name: { value: ['HOPE 🔥'], style: 'elegant' } } }), 400, 'DESIGN_TEXT_INVALID', 'texts.name.value.0'],
    ['a stale revision', signConfig(pub, { rev: 7 }), 409, 'BLUEPRINT_CHANGED', 'rev'],
    ['not an object', 'HOPE', 400, 'CONFIG_INVALID', ''],
  ];
  for (const [label, configuration, status, want, path] of cases) {
    const res = await mint(w, BUYER, configuration);
    assert.equal(res.status, status, `${label}: ${await res.clone().text()}`);
    const body = await json(res);
    assert.equal(body.code, want, label);
    if (path !== undefined) assert.equal(body.details.path, path, label);
    if (want === 'BLUEPRINT_CHANGED') assert.equal(body.details.rev, 1, 'the revision the studio should move to');
  }
  for (const productId of ['', 'cp_nothing', 'cp_plain', '../x']) {
    const res = await mint(w, BUYER, signConfig(pub), productId);
    assert.equal(res.status, 404, productId);
    assert.equal(await code(res), 'PERSONALIZATION_UNAVAILABLE');
  }
  assert.equal((await post(as(w, null), '/api/personalize/configs', { product_id: 'cp_sign', configuration: signConfig(pub) })).status, 401);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM design_configs'), 0, 'nothing refused was stored');
});

test('the check decides: a blocked design is CONFIG_NEEDS_CHANGE, a review on a cart-only product is CONFIG_NOT_ACCEPTED — made-on-request takes it', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const pub = await signPub(w);
  const empty = await mint(w, BUYER, signConfig(pub, { texts: {} }));
  assert.equal(empty.status, 409);
  assert.deepEqual((await json(empty)).details, { codes: ['CONTENT_MISSING'], missing: ['texts.name'] });
  const soldOut = await mint(w, BUYER, signConfig(pub, { slots: { magnet: { option: 'm10' }, light: { option: 'rgb' } } }));
  assert.equal(soldOut.status, 409);
  const blocked = await json(soldOut);
  assert.equal(blocked.code, 'CONFIG_NEEDS_CHANGE');
  assert.deepEqual(blocked.details.codes, ['COMPONENT_OUT']);
  // The workshop's printer shrinks after the publish: the large sign needs the shop to look first.
  w.raw.exec(`UPDATE merchant_request_prefs SET max_build_mm = '{"x":220,"y":220,"z":220}' WHERE merchant_id = 'm_ali'`);
  const review = await mint(w, BUYER, signConfig(pub));
  assert.equal(review.status, 409);
  assert.deepEqual(await json(review).then((b) => [b.code, b.details]), ['CONFIG_NOT_ACCEPTED', { verdict: 'review', codes: ['TOO_BIG_FOR_PRINTER'] }]);
  // The small one is made as it is.
  assert.equal((await mint(w, BUYER, signConfig(pub, { variant: 'pv_ss' }))).status, 201);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM design_configs'), 1);
});

test('decency: the seed and the owner\'s own terms are refused by path, and the word is never quoted back', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const pub = await signPub(w);
  const seed = BLOCKED_SEED.find((t) => t.scope === 'any' && /^[a-z]{4,}$/.test(t.term))!.term.toUpperCase();
  w.raw.exec("INSERT INTO blocked_terms (term, scope, owner_added) VALUES ('zorblax', 'word', 1)");
  for (const word of [seed, 'ZORBLAX']) {
    const res = await mint(w, BUYER, signConfig(pub, { texts: { name: { value: ['HOPE', word], style: 'elegant' } } }));
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.toLowerCase().includes(word.toLowerCase()), 'the refusal never names the word');
    const body = JSON.parse(text);
    assert.equal(body.code, 'DESIGN_TEXT_NOT_ALLOWED');
    assert.deepEqual(body.details, { path: 'texts.name.value.1' });
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM design_configs'), 0);
});

test('design pictures: only the owner\'s own `design_asset` is accepted — another person\'s, an unknown one or a model file is refused', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const pub = await signPub(w);
  const withLogo = (key: string) => signConfig(pub, { logo: { logo: { key } } });
  const ok = await mint(w, BUYER, withLogo(ASSET_KEY));
  assert.equal(ok.status, 201, await ok.clone().text());
  assert.equal((await json(ok)).config.logo.logo.key, ASSET_KEY);
  for (const [key, status, want, path] of [
    [SAMI_ASSET_KEY, 400, 'DESIGN_ASSET_NOT_OWNED', 'logo.logo.key'],
    ['users/buyer/design-assets/nothing0001.png', 400, 'DESIGN_ASSET_NOT_OWNED', 'logo.logo.key'],
    ['merchants/ali/product-files/stand0001.3mf', 400, 'CONFIG_INVALID', 'logo.logo.key'],
    ['users/buyer/design-assets/../../x.png', 400, 'CONFIG_INVALID', 'logo.logo.key'],
  ] as const) {
    const res = await mint(w, BUYER, withLogo(key));
    assert.equal(res.status, status, key);
    const body = await json(res);
    assert.deepEqual([body.code, body.details.path], [want, path], key);
  }
  // Sami's own picture is Sami's to use.
  assert.equal((await mint(w, SAMI, withLogo(SAMI_ASSET_KEY))).status, 201);
});

test('GET /configs/:id is the owner\'s alone; after a new revision it says `changed` and prices nothing', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const pub = await signPub(w);
  const minted = await json(await mint(w, BUYER, signConfig(pub)));
  const res = await get(as(w, BUYER), `/api/personalize/configs/${minted.config_id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const body = await json(res);
  assert.deepEqual(
    { id: body.config_id, twin: body.twin_code, p: body.product_id, rev: body.rev, live: body.live_rev, changed: body.changed, unit: body.unit_iqd, verdict: body.check.verdict },
    { id: minted.config_id, twin: minted.twin_code, p: 'cp_sign', rev: 1, live: 1, changed: false, unit: 52000, verdict: 'ready' }
  );
  assert.deepEqual(body.config, minted.config);
  assert.equal(body.words.en, minted.words.en);
  for (const [who, status] of [[SAMI, 404], [ALI, 404], [BOSS, 404]] as const) {
    const other = await get(as(w, who), `/api/personalize/configs/${minted.config_id}`);
    assert.equal(other.status, status, who.id);
    assert.equal(await code(other), 'NOT_FOUND', `${who.id}: nothing says it exists`);
  }
  assert.equal((await get(as(w, null), `/api/personalize/configs/${minted.config_id}`)).status, 401);
  assert.equal((await get(as(w, BUYER), '/api/personalize/configs/cfg_nope')).status, 404);

  // The shop publishes revision 2 (a longer warranty): the design is from revision 1.
  const app = as(w, ALI);
  const draft = await json(await put(app, '/api/merchant/products/cp_sign/blueprint/draft', { spec: { ...signSpec(), warranty_days: 60 } }));
  assert.equal(draft.draft.rev, 2);
  assert.equal((await post(app, '/api/merchant/products/cp_sign/blueprint/publish', { rev: 2 })).status, 200);
  const later = await json(await get(as(w, BUYER), `/api/personalize/configs/${minted.config_id}`));
  assert.deepEqual({ rev: later.rev, live: later.live_rev, changed: later.changed, unit: later.unit_iqd, check: later.check }, { rev: 1, live: 2, changed: true, unit: null, check: null });
  assert.match(later.words.en, /HOPE/, 'its words still come from the revision it was made on');
});

test('GET /assets/<key> hands the owner their own picture inline — type from the bytes, nosniff, a sandbox — and nobody else anything', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const res = await get(as(w, BUYER), `/api/personalize/assets/${ASSET_KEY}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('Content-Disposition'), 'inline');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), pngBytes(800, 800));
  for (const [who, key, status] of [
    [SAMI, ASSET_KEY, 404],
    [ALI, ASSET_KEY, 404],
    [BUYER, SAMI_ASSET_KEY, 404],
    [BUYER, 'merchants/ali/product-files/stand0001.3mf', 404],
    [BUYER, 'users/buyer/design-assets/nothing0001.png', 404],
  ] as const) {
    assert.equal((await get(as(w, who), `/api/personalize/assets/${key}`)).status, status, `${who.id} → ${key}`);
  }
  assert.equal((await get(as(w, null), `/api/personalize/assets/${ASSET_KEY}`)).status, 401);
});

// ===================================================== the design_asset purpose

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const rawSend = (a: App, method: string, path: string, body: Uint8Array) =>
  a.request(path, { method, headers: { 'content-type': 'application/octet-stream', 'CF-Connecting-IP': '1.2.3.4' }, body: body as unknown as BodyInit }, undefined, ctx);

test('the `design_asset` upload: images only, stored private under the PERSON, where a live blueprint asks for a picture, within the quota', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  await publishStand(w);
  const bytes = pngBytes(1200, 900, 400);
  const open = (who: StubUser, over: Record<string, unknown> = {}) =>
    post(as(w, who), '/api/uploads/sessions', { purpose: 'design_asset', entity_id: 'cp_sign', file_name: 'my logo.png', bytes: bytes.length, mime: 'image/png', sha256: sha(bytes), ...over });

  const created = await open(SAMI);
  assert.equal(created.status, 201, await created.clone().text());
  const id = (await json(created)).session_id as string;
  assert.equal((await rawSend(as(w, SAMI), 'PUT', `/api/uploads/sessions/${id}/parts/1`, bytes)).status, 200);
  const done = await post(as(w, SAMI), `/api/uploads/sessions/${id}/complete`, {});
  const body = await json(done);
  assert.equal(done.status, 200, JSON.stringify(body));
  assert.match(body.key, /^users\/sami\/design-assets\/[a-z0-9_]+\.png$/);
  assert.equal(body.visibility, 'private');
  assert.ok(w.priv.objects.has(body.key), 'in the private bucket');
  assert.ok(!w.pub.objects.has(body.key));
  assert.deepEqual(row(w.raw, 'SELECT owner_id, entity_id, purpose, visibility, width, height FROM file_objects WHERE object_key = ?', body.key), {
    owner_id: 'sami', entity_id: 'cp_sign', purpose: 'design_asset', visibility: 'private', width: 1200, height: 900,
  });
  // …and it is theirs to use at once.
  const pub = await signPub(w);
  assert.equal((await mint(w, SAMI, signConfig(pub, { logo: { logo: { key: body.key } } }))).status, 201);

  // Not an image; a product whose live blueprint asks for no picture; no product at all.
  const stl = await open(SAMI, { file_name: 'logo.stl', mime: 'model/stl' });
  assert.equal(stl.status, 400);
  assert.equal(await code(stl), 'UPLOAD_KIND_NOT_ALLOWED');
  for (const entity of ['cp_stand', 'cp_plain', 'cp_private', 'cp_nothing']) {
    const res = await open(SAMI, { entity_id: entity });
    assert.equal(res.status, 404, entity);
    assert.equal(await code(res), 'PERSONALIZATION_UNAVAILABLE', entity);
  }
  // The quota counts kept pictures and open sessions.
  setSwitch(w.raw, { enabled: true, design_quota: 2 });
  const full = await open(SAMI);
  assert.equal(full.status, 400);
  const refusal = await json(full);
  assert.equal(refusal.code, 'UPLOAD_QUOTA_EXCEEDED');
  assert.deepEqual(refusal.details, { limit_files: 2, used_files: 2, purpose: 'design_asset' });
  assert.equal(quotaBytesFor({ post_gb: 2, product_file_gb: 5, request_gb: 1 }, 'design_asset'), 0.5 * 1024 ** 3, 'half a gigabyte unless the owner says otherwise');
});

// ================================================================= the switch

test('the admin writes the switch through its normaliser — audited `admin.customization`, never in the public settings', async () => {
  const w = personalizeWorld();
  const res = await put(as(w, BOSS), '/api/admin/settings/customizationConfig', {
    value: {
      enabled: 'yes', cart: true, social: 1, pilot_store_ids: ['s_ali', 's_ali', 'bad id!', 7], pilot_user_ids: 'buyer',
      max_triangles: 10, max_blueprints_per_store: 1e9, design_quota: 12.7, surprise: true,
    },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const stored = await getSetting(asD1(w.raw), 'customizationConfig');
  assert.deepEqual(stored, {
    enabled: false, cart: true, create: false, groups: false, social: false, gift: false, market: false, parts_levonis: false,
    pilot_store_ids: ['s_ali'], pilot_user_ids: [],
    max_triangles: 1000, max_blueprints_per_store: 10000, max_roster: 100, design_quota: 12,
  });
  assert.ok(!JSON.parse(row<{ value: string }>(w.raw, "SELECT value FROM admin_settings WHERE key = 'customizationConfig'")!.value).surprise, 'an unknown key is never stored');
  const audits = all<{ action: string; target: string; detail: string }>(w.raw, "SELECT action, target, detail FROM audit_log WHERE actor_id = 'boss' ORDER BY id");
  const own = audits.find((a) => a.action === 'admin.customization');
  assert.ok(own, 'its own audit row');
  assert.deepEqual(JSON.parse(own!.detail).pilot_store_ids, ['s_ali']);
  assert.equal((await put(as(w, BOSS), '/api/admin/settings/customizationConfig', { value: [true] })).status, 400);
  assert.equal((await put(as(w, BOSS), '/api/admin/settings/customizationConfig', { value: 'on' })).status, 400);
  assert.equal((await put(as(w, ALI), '/api/admin/settings/customizationConfig', { value: { enabled: true } })).status, 403);
  assert.ok(!PUBLIC_SETTING_KEYS.includes('customizationConfig'), 'the pilot ids never leave through the public settings');
  assert.deepEqual(SETTING_DEFAULTS.customizationConfig, {
    enabled: false, cart: false, create: false, groups: false, social: false, gift: false, market: false, parts_levonis: false,
    pilot_store_ids: [], pilot_user_ids: [], max_triangles: 60000, max_blueprints_per_store: 200, max_roster: 100, design_quota: 300,
  });
});

test('the doors are rate limited: 600 reads and 240 mints an hour', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const pub = await signPub(w);
  const now = Math.floor(Date.now() / 1000);
  const window = now - (now % 3600);
  w.raw.prepare('INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 600), (?, ?, 240), (?, ?, 600)').run(
    rateLimitKey('personalize-read', null, '1.2.3.4'), window,
    rateLimitKey('config-mint', 'buyer', '1.2.3.4'), window,
    rateLimitKey('design-asset-read', 'buyer', '1.2.3.4'), window
  );
  assert.equal((await readBlueprint(w, 'cp_sign')).status, 429);
  assert.equal((await mint(w, BUYER, signConfig(pub))).status, 429);
  assert.equal((await get(as(w, BUYER), `/api/personalize/assets/${ASSET_KEY}`)).status, 429);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM design_configs'), 0);
});
