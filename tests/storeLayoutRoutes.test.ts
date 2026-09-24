/**
 * THE STORE PAGE'S DRAFT, PUBLISH, HISTORY AND RESTORE — and what the public
 * storefront serves from them.
 *
 * Real routes (worker/routes/storeLayout.ts, worker/routes/storefront.ts) on a
 * database with every migration applied, only the session stubbed. What is
 * pinned:
 *
 *   - a draft is never public: the storefront reads the revision the store's
 *     pointer names, and nothing else;
 *   - publish is ONE batch fenced on the draft version: two tabs publishing the
 *     same draft make one revision; a draft that moves between the check and
 *     the batch aborts it; a failure inside the batch leaves nothing behind;
 *   - restore copies a revision into the draft, or publishes it as a NEW
 *     revision, fenced the same way;
 *   - fifty revisions are kept, per store;
 *   - every write is cleaned and checked against THIS store's rows, and a
 *     stored layout is cleaned again when the public reads it;
 *   - changing the theme changes the look and nothing else;
 *   - the rows the blocks show are read in a fixed number of statements
 *     whatever the layout holds, each far under D1's 100 parameters;
 *   - a deploy that lands before migration 0122 still serves the classic page.
 *
 * Run: node --import tsx --test tests/storeLayoutRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  asD1,
  count,
  dbThrough,
  failingD1,
  freshDb,
  get,
  json,
  post,
  put,
  row,
  stubApp,
  type App,
  type Mount,
} from './fixtures/app';
import { SqliteD1, type SqliteStatement } from './fixtures/d1';
import { serialD1 } from './fixtures/serialD1';
import { MEDIA, OTHER, OWNER, SLUG, STORE_ID, seedLayoutStore } from './fixtures/storeLayout';
import { storeLayoutRoutes, MAX_REVISIONS } from '../worker/routes/storeLayout';
import { storefrontRoutes } from '../worker/routes/storefront';
import { blockDataFor } from '../worker/lib/storeLayout';
import { storeById } from '../worker/lib/merchantAuth';
import { collectMediaReferences, readLiveSchema } from '../worker/lib/mediaRefs';
import { defaultLayoutFromStore } from '../packages/storeLayout/src/defaults';
import { applyTheme, normalizeLayout } from '../packages/storeLayout/src/normalize';
import { THEME_PRESETS } from '../packages/storeLayout/src/tokens';
import { MAX_LAYOUT_BYTES, MAX_REQUEST_BYTES } from '../packages/storeLayout/src/schema';
import { collectDataNeeds, MAX_PICKED_PRODUCTS, MAX_PRODUCT_QUERIES } from '../packages/storeLayout/src/data';

const BASE = '/api/merchant/store/layout';
const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const mountLayout: Mount = (a) => a.route(BASE, storeLayoutRoutes);
const mountStorefront: Mount = (a) => a.route('/api/storefront', storefrontRoutes);

const T = (ar: string, en = '') => ({ ar, en, ckb: '' });
const text = (id: string, body: string) => ({ id, type: 'text', settings: { title: T('ملاحظة'), body: T(body) } });
const L = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ schema_version: 1, theme: 'classic', blocks, ...extra });

interface World {
  raw: DatabaseSync;
  owner: App;
  other: App;
  customer: App;
  anon: App;
  pub: App;
  host: App;
}

function world(dbFor: (raw: DatabaseSync) => unknown = (raw) => asD1(raw), raw: DatabaseSync = freshDb()): World {
  seedLayoutStore(raw);
  const db = dbFor(raw);
  return {
    raw,
    owner: stubApp(db, { id: OWNER, role: 'merchant', email: 'owner@x.co' }, mountLayout),
    other: stubApp(db, { id: OTHER, role: 'merchant', email: 'other@x.co' }, mountLayout),
    customer: stubApp(db, { id: 'c1', role: 'customer', email: 'c1@x.co' }, mountLayout),
    anon: stubApp(db, null, mountLayout),
    pub: stubApp(db, null, mountStorefront, { env: ENV }),
    host: stubApp(db, null, mountStorefront, { host: `${SLUG}.levonis-iq.com`, env: ENV }),
  };
}

async function ok(res: Response, status = 200) {
  const body = await json(res);
  assert.equal(res.status, status, JSON.stringify(body).slice(0, 600));
  return body;
}

async function saveDraft(w: World, layout: unknown, version: number) {
  return ok(await put(w.owner, `${BASE}/draft`, { layout, version }));
}

async function publish(w: World, version: number, note?: string) {
  return ok(await post(w.owner, `${BASE}/publish`, { version, ...(note ? { note } : {}) }));
}

/** The store as each public address answers it. */
async function publicStores(w: World) {
  const out = [];
  for (const [app, path] of [
    [w.pub, `/api/storefront/${SLUG}`],
    [w.pub, `/api/storefront/by-id/${STORE_ID}`],
    [w.host, '/api/storefront/resolve'],
  ] as const) {
    out.push((await ok(await get(app, path))).store);
  }
  return out;
}

const revisions = (raw: DatabaseSync, store = STORE_ID) =>
  count(raw, 'SELECT COUNT(*) AS n FROM store_layout_revisions WHERE store_id = ?', store);
const pointer = (raw: DatabaseSync) =>
  row<{ id: string | null }>(raw, 'SELECT published_revision_id AS id FROM merchant_stores WHERE id = ?', STORE_ID)?.id ?? null;
const draftVersion = (raw: DatabaseSync) =>
  row<{ v: number }>(raw, 'SELECT version AS v FROM store_layout_drafts WHERE store_id = ?', STORE_ID)?.v ?? 0;
const audits = (raw: DatabaseSync, action: string) =>
  count(raw, 'SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND target = ?', action, STORE_ID);

// ------------------------------------------------------------------ reading

test('a store that never saved a layout: version 0, the classic page, nothing published, nothing public changes', async () => {
  const w = world();
  const state = await ok(await get(w.owner, BASE));
  assert.equal(state.draft.exists, false);
  assert.equal(state.draft.version, 0);
  assert.deepEqual(state.draft.layout, defaultLayoutFromStore(null));
  assert.equal(state.published, null);
  assert.equal(state.dirty, false);
  assert.deepEqual(state.revisions, []);
  assert.equal(state.revision_count, 0);
  assert.equal(state.limits.max_revisions, MAX_REVISIONS);
  assert.ok(state.themes.includes('premium_dark'));

  for (const store of await publicStores(w)) {
    assert.equal(store.layout_source, 'default');
    assert.equal(store.layout_revision, null);
    assert.deepEqual(store.layout, defaultLayoutFromStore(null));
    // The classic page's first screen arrives with the store: the first page
    // of products, the collections, the deals and the reviews its tabs show.
    assert.equal(store.blocks_data.products.latest.items.length, 8);
    assert.deepEqual(store.blocks_data.collections.map((c: { id: string }) => c.id), ['sec1', 'sec2', 'sec3']);
    assert.deepEqual(store.blocks_data.products.deals.items.map((p: { id: string }) => p.id), ['p7', 'p4', 'p1']);
    assert.equal(store.blocks_data.reviews.count, 3);
  }
});

test('only the owner reaches the layout API: anonymous 401, a customer without a store 404, another merchant sees only their own', async () => {
  const w = world();
  await saveDraft(w, L([text('mine', 'OWNER-ONLY-DRAFT')]), 0);
  assert.equal((await get(w.anon, BASE)).status, 401);
  assert.equal((await put(w.anon, `${BASE}/draft`, { layout: L([]), version: 0 })).status, 401);
  assert.equal((await get(w.customer, BASE)).status, 404);
  const theirs = await ok(await get(w.other, BASE));
  assert.equal(theirs.draft.exists, false, 'another merchant never sees this store\'s draft');
  assert.ok(!JSON.stringify(theirs).includes('OWNER-ONLY-DRAFT'));
  const preview = await ok(await get(w.other, `${BASE}/preview`));
  assert.ok(!JSON.stringify(preview).includes('OWNER-ONLY-DRAFT'));
  assert.equal((await get(w.anon, `${BASE}/preview`)).status, 401);
  // No revision of this store is reachable by number from another account.
  const v = (await saveDraft(w, L([text('mine', 'PUBLISHED')]), 1)).draft.version;
  await publish(w, v);
  assert.equal((await get(w.other, `${BASE}/revisions/1`)).status, 404);
  assert.equal((await post(w.other, `${BASE}/restore/1`, { version: 0 })).status, 404);
});

// ------------------------------------------------------------------- drafts

test('saving a draft: version 0 creates it, every save must name the version it edited, a stale tab gets 409 DRAFT_CHANGED', async () => {
  const w = world();
  const first = await saveDraft(w, L([text('a', 'one')]), 0);
  assert.equal(first.draft.version, 1);
  assert.equal(first.draft.exists, true);

  const again = await put(w.owner, `${BASE}/draft`, { layout: L([text('a', 'two')]), version: 0 });
  const againBody = await ok(again, 409);
  assert.equal(againBody.code, 'DRAFT_CHANGED');
  assert.equal(againBody.details.version, 1);

  assert.equal((await saveDraft(w, L([text('a', 'two')]), 1)).draft.version, 2);
  const stale = await ok(await put(w.owner, `${BASE}/draft`, { layout: L([text('a', 'three')]), version: 1 }), 409);
  assert.equal(stale.code, 'DRAFT_CHANGED');
  assert.equal(stale.details.version, 2);

  const state = await ok(await get(w.owner, BASE));
  assert.equal(state.draft.version, 2);
  assert.equal(state.draft.layout.blocks[0].settings.body.ar, 'two', 'the stale save changed nothing');
  assert.equal(state.dirty, true);

  assert.equal((await ok(await put(w.owner, `${BASE}/draft`, { layout: L([]) }), 400)).code, 'VERSION_REQUIRED');
  assert.equal((await ok(await put(w.owner, `${BASE}/draft`, { layout: L([]), version: -1 }), 400)).code, 'VERSION_REQUIRED');
  const bad = await w.owner.request(`${BASE}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: '{"layout": ',
  });
  assert.equal((await ok(bad, 400)).code, 'INVALID_JSON');
});

test('a draft is checked against THIS store: other stores\' ids and media that is not a live upload of the right kind are removed, with an issue at each place', async () => {
  const w = world();
  const saved = await saveDraft(
    w,
    L([
      { id: 'feat', type: 'featured_products', settings: { product_ids: ['p1', 'q1', 'nope'] } },
      { id: 'grid', type: 'products_grid', settings: { source: 'collection', collection_id: 'osec1' } },
      { id: 'coupon', type: 'coupon_banner', settings: { coupon_id: 'ocp1' } },
      { id: 'mycoupon', type: 'coupon_banner', settings: { coupon_id: 'cp1' } },
      { id: 'banner', type: 'banner', settings: { image: MEDIA.picture, link: { kind: 'collection', id: 'osec1' } } },
      {
        id: 'gallery',
        type: 'gallery',
        settings: {
          images: [
            { image: MEDIA.picture2 },
            { image: MEDIA.deleted },
            { image: MEDIA.unknown },
            { image: MEDIA.mislabelled },
            { image: `/files/${MEDIA.picture}` },
          ],
        },
      },
      { id: 'clip', type: 'video', settings: { video: MEDIA.video, poster: MEDIA.picture } },
      { id: 'clip-wrong', type: 'video', settings: { video: MEDIA.mislabelled.replace('.webp', '.mp4') } },
    ]),
    0
  );
  const blocks = Object.fromEntries(saved.draft.layout.blocks.map((b: { id: string }) => [b.id, b]));
  assert.deepEqual(blocks.feat.settings.product_ids, ['p1'], 'only this store\'s products');
  assert.equal(blocks.grid.settings.source, 'latest', 'a grid whose collection is not this store\'s falls back to latest');
  assert.equal(blocks.grid.settings.collection_id, '');
  assert.equal(blocks.coupon.settings.coupon_id, '');
  assert.equal(blocks.mycoupon.settings.coupon_id, 'cp1');
  assert.equal(blocks.banner.settings.image, MEDIA.picture);
  assert.deepEqual(blocks.banner.settings.link, { kind: 'none' });
  assert.deepEqual(
    blocks.gallery.settings.images.map((i: { image: string }) => i.image),
    [MEDIA.picture2, MEDIA.picture],
    'deleted, never uploaded and wrong-kind pictures are gone; a /files/ path is kept as its key'
  );
  assert.equal(blocks.clip.settings.video, MEDIA.video);
  assert.equal(blocks['clip-wrong'].settings.video, '');
  const at = (code: string) => saved.issues.filter((i: { code: string }) => i.code === code).map((i: { path: string }) => i.path);
  assert.ok(at('unknown_ref').includes('blocks[0].settings.product_ids[1]'), JSON.stringify(saved.issues));
  assert.ok(at('unknown_ref').includes('blocks[0].settings.product_ids[2]'));
  assert.ok(at('unknown_ref').includes('blocks[1].settings.collection_id'));
  assert.ok(at('unknown_ref').includes('blocks[2].settings.coupon_id'));
  assert.ok(at('unknown_ref').includes('blocks[4].settings.link'));
  assert.equal(at('media_not_found').length, 4, JSON.stringify(saved.issues));
  assert.ok(saved.issues.every((i: { fatal: boolean }) => i.fatal === false));
  // What was saved is what the API answered.
  const stored = JSON.parse(row<{ j: string }>(w.raw, 'SELECT layout_json AS j FROM store_layout_drafts WHERE store_id = ?', STORE_ID)!.j);
  assert.deepEqual(stored, saved.draft.layout);
});

test('another merchant cannot reference this store\'s products, collections, coupons or media', async () => {
  const w = world();
  const saved = await ok(
    await put(w.other, `${BASE}/draft`, {
      version: 0,
      layout: L([
        { id: 'feat', type: 'featured_products', settings: { product_ids: ['p1', 'q1'] } },
        { id: 'coupon', type: 'coupon_banner', settings: { coupon_id: 'cp1' } },
        { id: 'grid', type: 'products_grid', settings: { source: 'collection', collection_id: 'sec1' } },
      ]),
    })
  );
  const blocks = saved.draft.layout.blocks;
  assert.deepEqual(blocks[0].settings.product_ids, ['q1']);
  assert.equal(blocks[1].settings.coupon_id, '');
  assert.equal(blocks[2].settings.source, 'latest');
  const media = await ok(
    await put(w.other, `${BASE}/draft`, { version: 1, layout: L([{ id: 'b', type: 'banner', settings: { image: MEDIA.picture } }]) }),
    400
  );
  assert.equal(media.code, 'LAYOUT_REJECTED');
  assert.deepEqual(media.details.issues.map((i: { code: string }) => i.code), ['foreign_media']);
});

test('a fatal issue refuses the whole save with LAYOUT_REJECTED, and the draft stays as it was', async () => {
  const w = world();
  await saveDraft(w, L([text('a', 'kept')]), 0);
  const cases: Array<[string, unknown, string]> = [
    ['javascript link', L([{ id: 'c', type: 'cta', settings: { link: 'javascript:alert(1)' } }]), 'unsafe_link'],
    ['http link', L([{ id: 'c', type: 'cta', settings: { link: { kind: 'external', url: 'http://example.com' } } }]), 'unsafe_link'],
    ['data media', L([{ id: 'b', type: 'banner', settings: { image: 'data:image/png;base64,AAAA' } }]), 'invalid_media'],
    ['foreign media', L([{ id: 'b', type: 'banner', settings: { image: MEDIA.foreign } }]), 'foreign_media'],
    ['future schema', { schema_version: 2, blocks: [] }, 'unsupported_schema_version'],
    ['not an object', 'hello', 'not_an_object'],
  ];
  for (const [name, layout, code] of cases) {
    const res = await ok(await put(w.owner, `${BASE}/draft`, { layout, version: 1 }), 400);
    assert.equal(res.code, 'LAYOUT_REJECTED', name);
    assert.ok(res.details.issues.some((i: { code: string; fatal: boolean }) => i.code === code && i.fatal), `${name}: ${JSON.stringify(res.details)}`);
  }
  assert.equal(draftVersion(w.raw), 1);
  const state = await ok(await get(w.owner, BASE));
  assert.equal(state.draft.layout.blocks[0].settings.body.ar, 'kept');
});

test('size: a body over the request cap is refused before it is parsed (413), a layout over the stored cap after (400)', async () => {
  const w = world();
  const huge = JSON.stringify({ version: 0, layout: L([text('a', 'x'.repeat(MAX_REQUEST_BYTES))]) });
  const res = await w.owner.request(`${BASE}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: huge,
  });
  const body = await ok(res, 413);
  assert.equal(body.code, 'LAYOUT_TOO_LARGE');
  assert.equal(body.details.max_bytes, MAX_LAYOUT_BYTES);

  // Ten text blocks (the most a page may hold) of 2,000 two-byte letters in
  // each language fit the request cap but not the stored one. (Filler, not copy.)
  const long = 'ب'.repeat(2000);
  const big = L(Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, type: 'text', settings: { body: { ar: long, en: long, ckb: long } } })));
  assert.ok(new TextEncoder().encode(JSON.stringify(big)).length < MAX_REQUEST_BYTES);
  const refused = await ok(await put(w.owner, `${BASE}/draft`, { layout: big, version: 0 }), 400);
  assert.equal(refused.code, 'LAYOUT_REJECTED');
  assert.ok(refused.details.issues.some((i: { code: string }) => i.code === 'payload_too_large'));
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM store_layout_drafts'), 0);
});

// ------------------------------------------------------------------ publish

test('a draft is never public; publishing makes the SAVED draft the storefront\'s page, in one batch with its audit row', async () => {
  const w = world();
  const v1 = (await saveDraft(w, L([text('hello', 'DRAFT-ONE')], { theme: 'modern' }), 0)).draft.version;
  for (const store of await publicStores(w)) {
    assert.equal(store.layout_source, 'default');
    assert.ok(!JSON.stringify(store).includes('DRAFT-ONE'), 'an unpublished draft is not public');
  }

  const out = await publish(w, v1, 'first look');
  assert.equal(out.published.revision, 1);
  assert.equal(out.draft.version, v1 + 1, 'publishing moves the draft on, so one version is published once');
  assert.equal(out.draft.base_revision, 1);
  assert.equal(pointer(w.raw), out.published.id);
  assert.equal(audits(w.raw, 'merchant.layout_published'), 1);
  const detail = JSON.parse(row<{ d: string }>(w.raw, "SELECT detail AS d FROM audit_log WHERE action = 'merchant.layout_published'")!.d);
  assert.equal(detail.revision_id, out.published.id);
  assert.equal(detail.draft_version, v1);
  const rev = row<{ note: string; published_by: string; schema_version: number }>(
    w.raw,
    'SELECT note, published_by, schema_version FROM store_layout_revisions WHERE id = ?',
    out.published.id
  )!;
  assert.deepEqual(rev, { note: 'first look', published_by: OWNER, schema_version: 1 });

  for (const store of await publicStores(w)) {
    assert.equal(store.layout_source, 'published');
    assert.equal(store.layout_revision, 1);
    assert.equal(store.layout.theme, 'modern');
    assert.deepEqual(store.layout.tokens, THEME_PRESETS.modern);
    assert.equal(store.layout.blocks[0].settings.body.ar, 'DRAFT-ONE');
  }

  // The next draft is private again until it, too, is published.
  await saveDraft(w, L([text('hello', 'DRAFT-TWO')]), v1 + 1);
  for (const store of await publicStores(w)) {
    assert.ok(JSON.stringify(store).includes('DRAFT-ONE'));
    assert.ok(!JSON.stringify(store).includes('DRAFT-TWO'), 'the public still sees the published revision');
  }
  const state = await ok(await get(w.owner, BASE));
  assert.equal(state.dirty, true);
  assert.equal(state.published.revision, 1);
  assert.equal(state.revisions[0].live, true);
});

test('publish refuses: no draft (DRAFT_MISSING), a stale version (DRAFT_CHANGED), nothing visible (LAYOUT_EMPTY)', async () => {
  const w = world();
  assert.equal((await ok(await post(w.owner, `${BASE}/publish`, { version: 0 }), 409)).code, 'DRAFT_MISSING');
  await saveDraft(w, L([text('a', 'x')]), 0);
  const stale = await ok(await post(w.owner, `${BASE}/publish`, { version: 7 }), 409);
  assert.equal(stale.code, 'DRAFT_CHANGED');
  assert.equal(stale.details.version, 1);
  await saveDraft(w, L([{ ...text('a', 'x'), hidden: true }]), 1);
  assert.equal((await ok(await post(w.owner, `${BASE}/publish`, { version: 2 }), 400)).code, 'LAYOUT_EMPTY');
  assert.equal(revisions(w.raw), 0);
  assert.equal(pointer(w.raw), null);
  assert.equal(audits(w.raw, 'merchant.layout_published'), 0);
});

test('two tabs publishing the same draft version make exactly one revision', async () => {
  // Serialised like real D1: the requests interleave between statements, and
  // each batch runs whole.
  const w = world((raw) => serialD1(raw));
  const v = (await saveDraft(w, L([text('a', 'race')]), 0)).draft.version;
  const [a, b] = await Promise.all([post(w.owner, `${BASE}/publish`, { version: v }), post(w.owner, `${BASE}/publish`, { version: v })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = await json(a.status === 409 ? a : b);
  assert.equal(loser.code, 'DRAFT_CHANGED');
  assert.equal(revisions(w.raw), 1);
  assert.equal(audits(w.raw, 'merchant.layout_published'), 1);
  assert.equal(draftVersion(w.raw), v + 1);
});

test('a draft that moves between the check and the batch aborts the whole publish: no revision, no pointer, no audit', async () => {
  let moveDraft = false;
  const w = world((raw) => {
    const f = failingD1(raw);
    f.failing.beforeBatch = (statements) => {
      if (moveDraft && statements[0]?.sql.includes('INSERT INTO store_layout_revisions')) {
        // Another tab saves in the gap.
        raw.exec(`UPDATE store_layout_drafts SET version = version + 1, layout_json = '{"schema_version":1,"blocks":[]}' WHERE store_id = '${STORE_ID}'`);
      }
    };
    return f.db;
  });
  const v = (await saveDraft(w, L([text('a', 'about to lose')]), 0)).draft.version;
  moveDraft = true;
  const res = await ok(await post(w.owner, `${BASE}/publish`, { version: v }), 409);
  assert.equal(res.code, 'DRAFT_CHANGED');
  assert.equal(res.details.version, v + 1);
  assert.equal(revisions(w.raw), 0);
  assert.equal(pointer(w.raw), null);
  assert.equal(audits(w.raw, 'merchant.layout_published'), 0);
  assert.equal(draftVersion(w.raw), v + 1, 'the other tab\'s save stands');
});

test('a failure inside the publish batch leaves nothing behind', async () => {
  const w = world();
  const v1 = (await saveDraft(w, L([text('a', 'live one')]), 0)).draft.version;
  const first = await publish(w, v1);
  const v2 = (await saveDraft(w, L([text('a', 'never lands')]), v1 + 1)).draft.version;
  // The audit insert — the batch's LAST statement — fails after the revision,
  // the draft and the pointer statements have run.
  w.raw.exec(`CREATE TRIGGER fail_publish_audit BEFORE INSERT ON audit_log
              WHEN NEW.action = 'merchant.layout_published'
              BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;`);
  const res = await post(w.owner, `${BASE}/publish`, { version: v2 });
  assert.equal(res.status, 500);
  assert.equal(revisions(w.raw), 1);
  assert.equal(pointer(w.raw), first.published.id);
  assert.equal(draftVersion(w.raw), v2);
  for (const store of await publicStores(w)) assert.equal(store.layout.blocks[0].settings.body.ar, 'live one');
});

test('publish checks the saved draft again: a picture deleted since the save is taken out, not served', async () => {
  const w = world();
  const v = (
    await saveDraft(w, L([{ id: 'g', type: 'gallery', settings: { images: [{ image: MEDIA.picture }, { image: MEDIA.picture2 }] } }]), 0)
  ).draft.version;
  w.raw.prepare("UPDATE file_objects SET deleted_at = '2026-09-20T00:00:00.000Z' WHERE object_key = ?").run(MEDIA.picture2);
  const out = await publish(w, v);
  assert.deepEqual(out.draft.layout.blocks[0].settings.images.map((i: { image: string }) => i.image), [MEDIA.picture]);
  assert.ok(out.issues.some((i: { code: string }) => i.code === 'media_not_found'));
  const [store] = await publicStores(w);
  assert.ok(!JSON.stringify(store.layout).includes(MEDIA.picture2));
});

// ------------------------------------------------------------ history/restore

test('revisions page newest first, and exactly one is live', async () => {
  const w = world();
  let v = (await saveDraft(w, L([text('a', 'r')]), 0)).draft.version;
  for (let i = 1; i <= 5; i++) v = (await publish(w, v, `n${i}`)).draft.version;
  const p1 = await ok(await get(w.owner, `${BASE}/revisions?limit=2`));
  assert.deepEqual(p1.revisions.map((r: { revision: number }) => r.revision), [5, 4]);
  assert.deepEqual(p1.revisions.map((r: { live: boolean }) => r.live), [true, false]);
  assert.equal(p1.next_cursor, 4);
  const p2 = await ok(await get(w.owner, `${BASE}/revisions?limit=2&cursor=4`));
  assert.deepEqual(p2.revisions.map((r: { revision: number }) => r.revision), [3, 2]);
  const p3 = await ok(await get(w.owner, `${BASE}/revisions?limit=2&cursor=2`));
  assert.deepEqual(p3.revisions.map((r: { revision: number }) => r.revision), [1]);
  assert.equal(p3.next_cursor, null);
  const one = await ok(await get(w.owner, `${BASE}/revisions/3`));
  assert.equal(one.revision.note, 'n3');
  assert.equal(one.revision.layout.blocks[0].type, 'text');
  assert.equal((await ok(await get(w.owner, `${BASE}/revisions/99`), 404)).code, 'REVISION_NOT_FOUND');
  assert.equal((await ok(await get(w.owner, `${BASE}/revisions/x`), 404)).code, 'REVISION_NOT_FOUND');
});

test('restore copies a revision into the draft and leaves the public page alone; with publish it becomes a NEW live revision', async () => {
  const w = world();
  let v = (await saveDraft(w, L([text('a', 'FIRST')], { theme: 'workshop' }), 0)).draft.version;
  v = (await publish(w, v)).draft.version;
  v = (await saveDraft(w, L([text('a', 'SECOND')]), v)).draft.version;
  v = (await publish(w, v)).draft.version;

  const restored = await ok(await post(w.owner, `${BASE}/restore/1`, { version: v }));
  assert.equal(restored.restored_from, 1);
  assert.equal(restored.published, null);
  assert.equal(restored.draft.version, v + 1);
  assert.equal(restored.draft.base_revision, 1);
  assert.equal(restored.draft.layout.blocks[0].settings.body.ar, 'FIRST');
  assert.equal(restored.draft.layout.theme, 'workshop');
  assert.equal(audits(w.raw, 'merchant.layout_restored'), 1);
  for (const store of await publicStores(w)) {
    assert.equal(store.layout_revision, 2);
    assert.equal(store.layout.blocks[0].settings.body.ar, 'SECOND', 'restoring into the draft publishes nothing');
  }

  const stale = await ok(await post(w.owner, `${BASE}/restore/2`, { version: v }), 409);
  assert.equal(stale.code, 'DRAFT_CHANGED');
  assert.equal(stale.details.version, v + 1);

  const live = await ok(await post(w.owner, `${BASE}/restore/1`, { version: v + 1, publish: true }));
  assert.equal(live.published.revision, 3);
  assert.equal(live.draft.version, v + 3, 'the restore write and the publish each move the draft on');
  const r3 = row<{ restored_from: number; note: string }>(
    w.raw,
    'SELECT restored_from, note FROM store_layout_revisions WHERE store_id = ? AND revision = 3',
    STORE_ID
  )!;
  assert.deepEqual(r3, { restored_from: 1, note: '#1' });
  assert.equal(audits(w.raw, 'merchant.layout_published'), 3);
  for (const store of await publicStores(w)) {
    assert.equal(store.layout_revision, 3);
    assert.equal(store.layout.blocks[0].settings.body.ar, 'FIRST');
    assert.deepEqual(store.layout.tokens, THEME_PRESETS.workshop);
  }
  const listed = await ok(await get(w.owner, `${BASE}/revisions`));
  assert.deepEqual(listed.revisions.map((r: { revision: number; restored_from: number | null }) => [r.revision, r.restored_from]), [
    [3, 1],
    [2, null],
    [1, null],
  ]);
});

test('restore-and-publish is fenced like publish: a draft moved in the gap aborts both writes', async () => {
  let moveDraft = false;
  const w = world((raw) => {
    const f = failingD1(raw);
    f.failing.beforeBatch = (statements) => {
      if (moveDraft && statements[0]?.sql.includes('UPDATE store_layout_drafts')) {
        raw.exec(`UPDATE store_layout_drafts SET version = version + 1 WHERE store_id = '${STORE_ID}'`);
      }
    };
    return f.db;
  });
  let v = (await saveDraft(w, L([text('a', 'one')]), 0)).draft.version;
  v = (await publish(w, v)).draft.version;
  moveDraft = true;
  const res = await ok(await post(w.owner, `${BASE}/restore/1`, { version: v, publish: true }), 409);
  assert.equal(res.code, 'DRAFT_CHANGED');
  assert.equal(revisions(w.raw), 1);
  assert.equal(audits(w.raw, 'merchant.layout_published'), 1);
  assert.equal(draftVersion(w.raw), v + 1, 'only the other tab\'s write happened');
});

test('fifty revisions are kept per store: the fifty-sixth publish leaves revisions 6..55 and the live one', async () => {
  const w = world();
  // Another store's history is not this store's to prune.
  const other = JSON.stringify(normalizeLayout(L([text('o', 'theirs')]), { ownerUserId: OTHER }).layout);
  for (let r = 1; r <= 3; r++) {
    w.raw
      .prepare('INSERT INTO store_layout_revisions (id, store_id, revision, schema_version, layout_json) VALUES (?, ?, ?, 1, ?)')
      .run(`other-${r}`, 's2', r, other);
  }
  let v = (await saveDraft(w, L([text('a', 'loop')]), 0)).draft.version;
  let last = '';
  for (let i = 1; i <= 55; i++) {
    const out = await publish(w, v);
    assert.equal(out.published.revision, i);
    v = out.draft.version;
    last = out.published.id;
  }
  assert.equal(revisions(w.raw), MAX_REVISIONS);
  const span = row<{ lo: number; hi: number }>(w.raw, 'SELECT MIN(revision) AS lo, MAX(revision) AS hi FROM store_layout_revisions WHERE store_id = ?', STORE_ID)!;
  assert.deepEqual(span, { lo: 6, hi: 55 });
  assert.equal(pointer(w.raw), last);
  assert.equal(revisions(w.raw, 's2'), 3);
  const state = await ok(await get(w.owner, BASE));
  assert.equal(state.revision_count, MAX_REVISIONS);
  assert.equal(state.revisions.length, 10);
  assert.equal(state.revisions[0].revision, 55);
  assert.equal(state.revisions[0].live, true);
});

// ------------------------------------------------------------- public reads

test('a stored layout is cleaned again when the public reads it — a tampered row serves nothing it should not', async () => {
  const w = world();
  let v = (await saveDraft(w, L([text('a', 'clean')]), 0)).draft.version;
  const out = await publish(w, v);
  v = out.draft.version;
  const tampered = {
    schema_version: 1,
    theme: 'classic',
    tokens: { accent: 'url(javascript:alert(1))', surface: 'ink;background:red', radius: 'round' },
    header: { variant: '<script>' },
    blocks: [
      { id: 'x', type: 'iframe', settings: { src: 'https://evil.example' } },
      { id: 'c', type: 'cta', settings: { title: T('<img src=x onerror=alert(1)>'), link: 'javascript:alert(1)', onClick: 'alert(1)' } },
      { id: 'b', type: 'banner', settings: { image: MEDIA.foreign, link: { kind: 'external', url: 'http://plain.example' } } },
      { id: 'constructor', type: '__proto__', settings: {} },
    ],
  };
  w.raw.prepare('UPDATE store_layout_revisions SET layout_json = ? WHERE id = ?').run(JSON.stringify(tampered), out.published.id);
  for (const store of await publicStores(w)) {
    const s = JSON.stringify(store.layout);
    assert.ok(!s.includes('javascript:'), s);
    assert.ok(!s.includes('iframe'));
    assert.ok(!s.includes('evil.example'));
    assert.ok(!s.includes('plain.example'));
    assert.ok(!s.includes(MEDIA.foreign));
    assert.ok(!s.includes('onClick'));
    assert.ok(!s.includes('background:red'));
    assert.ok(!s.includes('__proto__'));
    assert.deepEqual(store.layout.blocks.map((b: { type: string }) => b.type), ['cta', 'banner']);
    assert.equal(store.layout.tokens.accent, THEME_PRESETS.classic.accent);
    assert.equal(store.layout.tokens.radius, 'round', 'a valid token survives beside invalid ones');
    assert.equal(store.layout.header.variant, 'overlay');
    // Text is text: the markup is kept as characters for React to escape.
    assert.equal(store.layout.blocks[0].settings.title.ar, '<img src=x onerror=alert(1)>');
  }

  // A future schema or garbage in the row: the public gets the classic page.
  for (const junk of ['{"schema_version": 9, "blocks": [{"type": "text"}]}', 'not json', '{"blocks": []}']) {
    w.raw.prepare('UPDATE store_layout_revisions SET layout_json = ? WHERE id = ?').run(junk, out.published.id);
    for (const store of await publicStores(w)) {
      assert.equal(store.layout_source, 'default', junk);
      assert.deepEqual(store.layout, defaultLayoutFromStore(null));
    }
  }
  // A pointer to another store's revision is not followed.
  w.raw.exec(`INSERT INTO store_layout_revisions (id, store_id, revision, schema_version, layout_json) VALUES ('theirs', 's2', 1, 1, '${JSON.stringify(L([text('t', 'NOT-THIS-STORE')]))}')`);
  w.raw.prepare('UPDATE merchant_stores SET published_revision_id = ? WHERE id = ?').run('theirs', STORE_ID);
  for (const store of await publicStores(w)) {
    assert.equal(store.layout_source, 'default');
    assert.ok(!JSON.stringify(store).includes('NOT-THIS-STORE'));
  }
});

test('changing the theme changes the look and nothing else: same blocks, same rows, same content endpoints', async () => {
  const w = world();
  const blocks = [
    { id: 'hero', type: 'hero', variant: 'profile' },
    { id: 'grid', type: 'products_grid', settings: { source: 'collection', collection_id: 'sec1', limit: 6 } },
    { id: 'deals', type: 'deals' },
    { id: 'services', type: 'services' },
    { id: 'reviews', type: 'reviews' },
    { id: 'faq', type: 'faq', settings: { items: [{ q: T('سؤال؟'), a: T('جواب.') }] } },
  ];
  let v = (await saveDraft(w, L(blocks), 0)).draft.version;
  v = (await publish(w, v)).draft.version;
  const content = async () => {
    const out: Record<string, unknown> = {};
    for (const p of ['products', 'products?deals=1', 'sections', 'services', 'showcase', 'reviews', 'products/raf3d-p1']) {
      const body = await ok(await get(w.pub, `/api/storefront/${SLUG}/${p}`));
      if (p === 'products/raf3d-p1') delete body.store.layout_theme;
      out[p] = body;
    }
    return out;
  };
  const tables = () =>
    ['community_products', 'merchant_store_sections', 'merchant_services', 'merchant_showcase', 'merchant_reviews', 'merchant_coupons'].map(
      (t) => [t, count(w.raw, `SELECT COUNT(*) AS n FROM ${t}`)]
    );
  const storeRow = () => row(w.raw, 'SELECT name, tagline, description, accent, profile_links, profile_facts FROM merchant_stores WHERE id = ?', STORE_ID);
  const [before] = await publicStores(w);
  const beforeContent = await content();
  const beforeTables = tables();
  const beforeRow = storeRow();

  const state = await ok(await get(w.owner, BASE));
  const dark = applyTheme(state.draft.layout, 'premium_dark');
  v = (await saveDraft(w, dark, v)).draft.version;
  await publish(w, v);

  const [after] = await publicStores(w);
  assert.equal(after.layout.theme, 'premium_dark');
  assert.deepEqual(after.layout.tokens, THEME_PRESETS.premium_dark);
  assert.deepEqual(after.layout.blocks, before.layout.blocks, 'every block, setting and id is unchanged');
  assert.deepEqual(after.blocks_data, before.blocks_data, 'the same rows are shown');
  const strip = (s: Record<string, unknown>) => {
    const { layout, layout_revision, ...rest } = s;
    void layout;
    void layout_revision;
    return rest;
  };
  assert.deepEqual(strip(after), strip(before), 'the store itself answers the same');
  assert.deepEqual(await content(), beforeContent);
  assert.deepEqual(tables(), beforeTables);
  assert.deepEqual(storeRow(), beforeRow);
  const product = await ok(await get(w.pub, `/api/storefront/${SLUG}/products/raf3d-p1`));
  assert.equal(product.store.layout_theme.theme, 'premium_dark');
  assert.deepEqual(product.store.layout_theme.tokens, THEME_PRESETS.premium_dark);
  assert.ok(!('blocks' in product.store.layout_theme), 'the product page gets the theme only');
});

test('the preview is the owner\'s draft with its rows, never cached', async () => {
  const w = world();
  const first = await get(w.owner, `${BASE}/preview`);
  const body = await ok(first);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(body.source, 'default');
  await saveDraft(w, L([{ id: 'grid', type: 'products_grid', settings: { source: 'featured', limit: 4 } }, text('t', 'PREVIEW-ME')]), 0);
  const draft = await ok(await get(w.owner, `${BASE}/preview`));
  assert.equal(draft.source, 'draft');
  assert.ok(JSON.stringify(draft.layout).includes('PREVIEW-ME'));
  assert.deepEqual(draft.blocks_data.products.featured.items.map((p: { id: string }) => p.id), ['p3', 'p1']);
  await publish(w, 1);
  const rev = await ok(await get(w.owner, `${BASE}/preview?revision=1`));
  assert.equal(rev.source, 'revision');
  assert.equal((await ok(await get(w.owner, `${BASE}/preview?revision=9`), 404)).code, 'REVISION_NOT_FOUND');
});

// --------------------------------------------------------------- statements

/** Counts every statement executed and the parameters each one bound. */
function countingD1(raw: DatabaseSync) {
  const inner = new SqliteD1(raw);
  const executed: Array<{ sql: string; binds: number }> = [];
  const wrap = (s: SqliteStatement, sql: string, binds: number): unknown => ({
    bind: (...values: unknown[]) => wrap(s.bind(...values), sql, values.length),
    run: () => (executed.push({ sql, binds }), s.run()),
    first: () => (executed.push({ sql, binds }), s.first()),
    all: () => (executed.push({ sql, binds }), s.all()),
  });
  const db = { prepare: (sql: string) => wrap(inner.prepare(sql), sql, 0), batch: () => Promise.reject(new Error('read only')) };
  return { db: db as unknown as D1Database, executed };
}

test('the rows a layout shows are read in a fixed number of statements, however many blocks ask, each far under 100 parameters', async () => {
  const raw = freshDb();
  seedLayoutStore(raw);
  const { db, executed } = countingD1(raw);
  const ctx = (await storeById(asD1(raw), STORE_ID))!;
  const every = [
    { type: 'featured_products', settings: { product_ids: ['p1', 'p2'] } },
    { type: 'collections' },
    { type: 'services' },
    { type: 'showcase' },
    { type: 'reviews' },
    { type: 'printers' },
    { type: 'coupon_banner', settings: { coupon_id: 'cp1' } },
    { type: 'products_grid', settings: { source: 'collection', collection_id: 'sec1' } },
  ];
  const small = normalizeLayout(L(every), { ownerUserId: OWNER }).layout;
  // As much as a page may ask for: every grid and carousel a page may hold,
  // each on its own collection, sixty picked products, every coupon, the tabs.
  const lists = (type: string, from: number) =>
    Array.from({ length: 9 }, (_, i) => ({ type, settings: { source: 'collection', collection_id: `c${from + i}` } }));
  const manyPicks = Array.from({ length: 5 }, (_, b) => ({
    type: 'featured_products',
    settings: { product_ids: Array.from({ length: 12 }, (_, i) => `id${b}x${i}`) },
  }));
  const coupons = Array.from({ length: 3 }, (_, i) => ({ type: 'coupon_banner', settings: { coupon_id: `cp${i + 2}` } }));
  const large = normalizeLayout(
    L([...every, ...lists('products_grid', 0), ...lists('products_carousel', 10), { type: 'products_carousel' }, ...manyPicks, ...coupons, { type: 'tabs' }, { type: 'deals' }]),
    { ownerUserId: OWNER }
  ).layout;
  assert.ok(large.blocks.length >= 35, String(large.blocks.length));
  assert.equal(collectDataNeeds(large).products.length, MAX_PRODUCT_QUERIES, 'the product-list cap is reached');
  assert.equal(collectDataNeeds(large).productIds.length, MAX_PICKED_PRODUCTS);

  executed.length = 0;
  const smallData = await blockDataFor(db, ctx, small);
  const smallCount = executed.length;
  const smallBinds = Math.max(...executed.map((e) => e.binds));
  executed.length = 0;
  await blockDataFor(db, ctx, large);
  const largeCount = executed.length;
  const largeBinds = Math.max(...executed.map((e) => e.binds));

  assert.equal(largeCount, smallCount, `statements do not grow with the layout (${smallCount} vs ${largeCount})`);
  assert.ok(smallCount <= 11, `a fixed handful of statements (${smallCount})`);
  assert.ok(largeBinds <= 40, `the widest statement binds ${largeBinds} parameters`);
  assert.ok(smallBinds <= largeBinds);
  // And the rows are the right ones.
  assert.deepEqual(smallData.picked?.map((p) => p.id), ['p1', 'p2']);
  assert.deepEqual(smallData.products['collection:sec1']?.items.map((p) => p.id), ['p5', 'p1']);
  assert.deepEqual(smallData.coupons?.map((c) => c.code), ['RAF10']);
  assert.equal(smallData.services?.length, 2);
  assert.equal(smallData.showcase?.length, 4);
  assert.equal(smallData.reviews?.count, 3);
  assert.ok(smallData.reviews?.reviews.every((r) => !r.customer_name.includes('Kareem')), 'names are masked as on the reviews tab');
});

test('a read that fails costs its blocks their rows, never the page', async () => {
  const w = world();
  w.raw.exec('DROP TABLE merchant_showcase');
  let v = (await saveDraft(w, L([{ id: 's', type: 'showcase' }, { id: 'g', type: 'products_grid' }]), 0)).draft.version;
  v = (await publish(w, v)).draft.version;
  void v;
  for (const store of await publicStores(w)) {
    assert.equal(store.layout_source, 'published');
    assert.equal(store.blocks_data.showcase, null);
    assert.equal(store.blocks_data.products.latest.items.length, 6);
  }
});

test('the media sweep sees every picture and video a draft or a kept revision uses, so it never deletes one', async () => {
  const w = world();
  const v = (
    await saveDraft(
      w,
      L([
        { id: 'g', type: 'gallery', settings: { images: [{ image: MEDIA.picture }, { image: MEDIA.picture2 }] } },
        { id: 'v', type: 'video', settings: { video: MEDIA.video } },
      ]),
      0
    )
  ).draft.version;
  await publish(w, v);
  // The draft moves on without the second picture and the video: only the
  // published revision still holds them — and a revision can be restored.
  await saveDraft(w, L([{ id: 'g', type: 'gallery', settings: { images: [{ image: MEDIA.picture }] } }]), v + 1);
  const db = asD1(w.raw) as unknown as Parameters<typeof readLiveSchema>[0];
  const scan = await collectMediaReferences(db, await readLiveSchema(db));
  assert.deepEqual(scan.failed, []);
  assert.ok(scan.scanned.includes('store_layout_drafts.layout_json'));
  assert.ok(scan.scanned.includes('store_layout_revisions.layout_json'));
  for (const k of [MEDIA.picture, MEDIA.picture2, MEDIA.video]) assert.ok(scan.keys.has(k), k);
});

// ------------------------------------------------------------ deploy ahead

test('a Worker deployed before migration 0122 serves the classic page on every storefront address', async () => {
  const w = world(undefined, dbThrough('0121'));
  for (const store of await publicStores(w)) {
    assert.equal(store.layout_source, 'default');
    assert.deepEqual(store.layout, defaultLayoutFromStore(null));
    assert.equal(store.blocks_data.products.latest.items.length, 8);
  }
  const product = await ok(await get(w.pub, `/api/storefront/${SLUG}/products/raf3d-p1`));
  assert.equal(product.store.layout_theme.theme, 'classic');
});
