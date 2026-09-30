/**
 * THE STORE BUILDER AGAINST THE REAL ROUTES (W4-A).
 *
 *   - GET /api/merchant/store/layout/media: the owner's own uploads a layout
 *     may hold — by the ledger's mime, never deleted, never another owner's,
 *     paged newest first;
 *   - the editor's autosaver driving the real PUT /draft: what lands is the
 *     gate's output, versions advance, two tabs conflict and «keep mine»
 *     resolves it, a server-side reference check comes back as issues;
 *   - a page built entirely through the editor model publishes, and the
 *     public storefront serves exactly it;
 *   - the editor never sends a fatal layout, and if something bypassed it,
 *     the server refuses the same payload.
 *
 * Run: node --import tsx --test tests/storeDesignRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, patch, post, put, row, send, stubApp, type App, type Mount } from './fixtures/app';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { MEDIA, OTHER, OWNER, SLUG, STORE_ID, seedLayoutStore } from './fixtures/storeLayout';
import { storeLayoutRoutes } from '../worker/routes/storeLayout';
import { storefrontRoutes } from '../worker/routes/storefront';
import { normalizeLayout } from '../packages/storeLayout/src/normalize';
import { starterLayout } from '../packages/storeLayout/src/starters';
import type { StoreLayout } from '../packages/storeLayout/src/schema';
import { addBlock, setSetting, validateLayout, type EditResult } from '../src/components/merchant/storeDesign/editorModel';
import { DraftSaver, type SaveAnswer } from '../src/components/merchant/storeDesign/autosave';

const BASE = '/api/merchant/store/layout';
const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const mountLayout: Mount = (a) => a.route(BASE, storeLayoutRoutes);

function world() {
  const raw = freshDb();
  seedLayoutStore(raw);
  const db = asD1(raw);
  return {
    raw,
    owner: stubApp(db, { id: OWNER, role: 'merchant', email: 'owner@x.co' }, mountLayout),
    other: stubApp(db, { id: OTHER, role: 'merchant', email: 'other@x.co' }, mountLayout),
    customer: stubApp(db, { id: 'c1', role: 'customer', email: 'c1@x.co' }, mountLayout),
    anon: stubApp(db, null, mountLayout),
    pub: stubApp(db, null, (a) => a.route('/api/storefront', storefrontRoutes), { env: ENV }),
  };
}

const done = (r: EditResult) => {
  assert.ok(!('refused' in r));
  return r as { layout: StoreLayout; id: string };
};

/** The saver the builder uses, wired to the real route instead of fetch. */
function realSaver(app: App, version: number, initial: StoreLayout, onSaved?: (a: SaveAnswer) => void) {
  const sent: StoreLayout[] = [];
  const saver = new DraftSaver(
    {
      save: async (layout, v) => {
        sent.push(layout);
        const res = await put(app, `${BASE}/draft`, { layout, version: v });
        const body = await json(res);
        if (!res.ok) throw Object.assign(new Error(body.error), { code: body.code, details: body.details ?? body });
        return { version: body.draft.version, layout: body.draft.layout, issues: body.issues };
      },
      onState: () => {},
      onSaved: (a) => onSaved?.(a),
      delay: 0,
    },
    { version, layout: initial }
  );
  return { saver, sent };
}

const gated = (l: StoreLayout) => {
  const v = validateLayout(l, OWNER);
  return [v.result.layout, v.fatal] as const;
};

const draftRow = (raw: DatabaseSync) => row<{ version: number; layout_json: string }>(raw, 'SELECT version, layout_json FROM store_layout_drafts WHERE store_id = ?', STORE_ID);

// ------------------------------------------------------------------ media

test('the media library lists only the owner\'s live uploads of the asked kind', async () => {
  const w = world();
  const images = await json(await get(w.owner, `${BASE}/media?kind=image`));
  assert.equal(images.success, true);
  const keys = images.items.map((i: { key: string }) => i.key).sort();
  assert.deepEqual(keys, [MEDIA.picture, MEDIA.picture2].sort(), 'no deleted, foreign or mislabelled file');
  for (const i of images.items) assert.equal(i.kind, 'image');

  const videos = await json(await get(w.owner, `${BASE}/media?kind=video`));
  assert.deepEqual(videos.items.map((i: { key: string }) => i.key), [MEDIA.video]);

  // A kind it does not know is read as image, never as «everything».
  const odd = await json(await get(w.owner, `${BASE}/media?kind=../../etc`));
  assert.deepEqual(odd.items.map((i: { key: string }) => i.key).sort(), keys);

  // Another merchant sees theirs; nobody sees the owner's.
  const theirs = await json(await get(w.other, `${BASE}/media?kind=image`));
  assert.deepEqual(theirs.items.map((i: { key: string }) => i.key), [MEDIA.foreign]);
  assert.equal((await get(w.anon, `${BASE}/media`)).status, 401);
  assert.ok([403, 404].includes((await get(w.customer, `${BASE}/media`)).status));
});

test('the media library pages newest first by keyset, and every key it offers is one a save accepts', async () => {
  const w = world();
  for (let i = 0; i < 5; i++) {
    w.raw
      .prepare(`INSERT INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size,created_at) VALUES (?, 'public','merchants','owner','image/webp',10,?)`)
      .run(`merchants/owner/public/page${i}aaa.webp`, `2026-09-0${i + 1}T00:00:00.000Z`);
  }
  // A row the schema would refuse (a legacy prefix) is never offered.
  w.raw
    .prepare(`INSERT INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size,created_at) VALUES ('merchants/owner/private/x1aaaa.webp','public','merchants','owner','image/webp',10,'2026-09-30T00:00:00.000Z')`)
    .run();
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 20; n++) {
    const page: { items: Array<{ key: string }>; next_cursor: string | null } = (await json(await get(w.owner, `${BASE}/media?kind=image&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))) as { items: Array<{ key: string }>; next_cursor: string | null };
    seen.push(...page.items.map((i: { key: string }) => i.key));
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  assert.equal(new Set(seen).size, seen.length, 'no key twice');
  assert.equal(seen.length, 7);
  assert.ok(!seen.includes('merchants/owner/private/x1aaaa.webp'));
  // The fixture's own two pictures were uploaded «now», so they come first.
  assert.deepEqual(seen.slice(0, 2).sort(), [MEDIA.picture, MEDIA.picture2].sort());
  assert.deepEqual(seen.slice(2), ['page4aaa', 'page3aaa', 'page2aaa', 'page1aaa', 'page0aaa'].map((k) => `merchants/owner/public/${k}.webp`));

  // Each offered key survives a real save.
  const gallery = setSetting(done(addBlock(starterLayout('portfolio'), 'gallery')).layout, 'gallery', 'images', seen.map((image) => ({ image })));
  const res = await json(await put(w.owner, `${BASE}/draft`, { layout: validateLayout(gallery, OWNER).result.layout, version: 0 }));
  assert.equal(res.success, true);
  assert.equal(res.issues.length, 0, JSON.stringify(res.issues));
  assert.equal(res.draft.layout.blocks.find((b: { type: string }) => b.type === 'gallery').settings.images.length, 7);
});

// ------------------------------------------------------------------ autosave against the real draft route

test('the builder\'s autosaver on the real route: saves the gate\'s output, versions advance, the draft is never public', async () => {
  const w = world();
  const start = await json(await get(w.owner, BASE));
  assert.equal(start.draft.version, 0);
  const { saver } = realSaver(w.owner, 0, start.draft.layout);

  // First run: the merchant picks the workshop template.
  let l = starterLayout('workshop');
  saver.update(...gated(l));
  assert.equal(await saver.flush(), true);
  assert.equal(draftRow(w.raw)?.version, 1);
  assert.deepEqual(JSON.parse(draftRow(w.raw)!.layout_json), normalizeLayout(l, { ownerUserId: OWNER }).layout);

  // Then edits: a banner with the owner's picture and a link to one of their products.
  const b = done(addBlock(l, 'banner', 1));
  l = setSetting(b.layout, b.id, 'image', MEDIA.picture);
  l = setSetting(l, b.id, 'title', { ar: '  تشكيلة الشتاء  ', en: 'Winter', ckb: '' });
  l = setSetting(l, b.id, 'link', { kind: 'product', id: 'p1' });
  saver.update(...gated(l));
  assert.equal(await saver.flush(), true);
  assert.equal(saver.snapshot.version, 2);
  const stored = JSON.parse(draftRow(w.raw)!.layout_json) as StoreLayout;
  const banner = stored.blocks[1] as unknown as { settings: { title: { ar: string }; image: string; link: unknown } };
  assert.equal(banner.settings.title.ar, 'تشكيلة الشتاء');
  assert.equal(banner.settings.image, MEDIA.picture);
  assert.deepEqual(banner.settings.link, { kind: 'product', id: 'p1' });

  // Nothing is public until publish.
  const pub = await json(await get(w.pub, `/api/storefront/${SLUG}`));
  assert.equal(pub.store.layout_source, 'default');
});

test('two tabs: the second autosave gets DRAFT_CHANGED; «keep mine» saves over it, «reload» adopts the other', async () => {
  const w = world();
  const base = starterLayout('minimal');
  const v1 = (await json(await put(w.owner, `${BASE}/draft`, { layout: base, version: 0 }))).draft.version;
  const a = realSaver(w.owner, v1, base);
  const b = realSaver(w.owner, v1, base);

  const la = done(addBlock(base, 'faq')).layout;
  a.saver.update(...gated(la));
  assert.equal(await a.saver.flush(), true);

  const lb = done(addBlock(base, 'text')).layout;
  b.saver.update(...gated(lb));
  assert.equal(await b.saver.flush(), false);
  assert.equal(b.saver.snapshot.status, 'conflict');
  assert.equal(b.saver.snapshot.conflictVersion, v1 + 1);
  assert.ok((JSON.parse(draftRow(w.raw)!.layout_json) as StoreLayout).blocks.some((x) => x.type === 'faq'), 'tab A\'s save stands');

  // «Keep mine»: the builder re-reads the version and saves over it.
  const now = (await json(await get(w.owner, BASE))).draft.version;
  assert.equal(await b.saver.keepMine(now), true);
  const after = JSON.parse(draftRow(w.raw)!.layout_json) as StoreLayout;
  assert.ok(after.blocks.some((x) => x.type === 'text') && !after.blocks.some((x) => x.type === 'faq'));

  // Tab A is now stale; «reload» adopts the server's draft and stops.
  a.saver.update(...gated(done(addBlock(la, 'cta')).layout));
  assert.equal(await a.saver.flush(), false);
  const fresh = await json(await get(w.owner, BASE));
  a.saver.adopt(fresh.draft.version, fresh.draft.layout);
  assert.equal(a.saver.snapshot.status, 'saved');
  assert.equal(a.saver.unsaved, false);
});

test('the server\'s own reference check comes back to the editor as issues and a cleaned layout', async () => {
  const w = world();
  let cleaned: SaveAnswer | null = null;
  const { saver } = realSaver(w.owner, 0, starterLayout('classic'), (x) => (cleaned = x));
  const f = done(addBlock(starterLayout('classic'), 'featured_products'));
  // p1 is theirs; `p_gone` is well formed but not a product of this store; the picture was deleted.
  let l = setSetting(f.layout, f.id, 'product_ids', ['p1', 'p_gone']);
  const g = done(addBlock(l, 'gallery'));
  l = setSetting(g.layout, g.id, 'images', [{ image: MEDIA.deleted }, { image: MEDIA.picture }]);
  saver.update(...gated(l));
  assert.equal(await saver.flush(), true);
  assert.ok(cleaned);
  const answer = cleaned as SaveAnswer;
  assert.deepEqual(answer.issues.map((i) => i.code).sort(), ['dropped_item', 'media_not_found', 'unknown_ref']);
  const saved = answer.layout.blocks;
  assert.deepEqual((saved.find((x) => x.id === f.id)!.settings as { product_ids: string[] }).product_ids, ['p1']);
  assert.equal((saved.find((x) => x.id === g.id)!.settings as { images: unknown[] }).images.length, 1);
});

// ------------------------------------------------------------------ publish what the editor built

test('a page built only through the editor publishes, and the storefront serves exactly it', async () => {
  const w = world();
  let l = starterLayout('product_focused');
  const t = done(addBlock(l, 'text', 1));
  l = setSetting(t.layout, t.id, 'title', { ar: 'مرحبًا بكم', en: 'Welcome', ckb: '' });
  l = setSetting(l, t.id, 'body', { ar: '<b>نص</b> عادي', en: '', ckb: '' });
  const { saver } = realSaver(w.owner, 0, starterLayout('classic'));
  saver.update(...gated(l));
  assert.equal(await saver.flush(), true);
  const pub = await json(await post(w.owner, `${BASE}/publish`, { version: saver.snapshot.version, note: 'from the builder' }));
  assert.equal(pub.success, true, JSON.stringify(pub));
  const store = (await json(await get(w.pub, `/api/storefront/${SLUG}`))).store;
  assert.equal(store.layout_source, 'published');
  assert.deepEqual(store.layout, normalizeLayout(l, { ownerUserId: OWNER }).layout);
  assert.equal(store.layout.blocks[1].settings.body.ar, '<b>نص</b> عادي', 'markup stays characters, rendered as text');
});

// ------------------------------------------------------------------ the gate on both sides

test('a fatal layout is never sent by the editor — and the same payload is refused by the server if anything bypassed it', async () => {
  const w = world();
  const { saver, sent } = realSaver(w.owner, 0, starterLayout('classic'));
  const c = done(addBlock(starterLayout('classic'), 'cta'));
  const cases: Array<[string, StoreLayout]> = [
    ['javascript link', setSetting(c.layout, c.id, 'link', { kind: 'external', url: 'javascript:alert(document.cookie)' })],
    ['foreign media', setSetting(done(addBlock(c.layout, 'banner')).layout, 'banner', 'image', MEDIA.foreign)],
    ['data: media', setSetting(done(addBlock(c.layout, 'banner')).layout, 'banner', 'image', 'data:image/svg+xml,<svg onload=alert(1)>')],
  ];
  for (const [what, layout] of cases) {
    saver.update(...gated(layout));
    assert.equal(await saver.flush(), false, what);
    assert.equal(sent.length, 0, `${what} was sent`);
    // Bypassing the builder: the raw editor state straight to the route.
    const res = await put(w.owner, `${BASE}/draft`, { layout, version: 0 });
    assert.equal(res.status, 400, what);
    assert.equal((await json(res)).code, 'LAYOUT_REJECTED', what);
  }
  assert.equal(draftRow(w.raw), undefined, 'no draft was ever written');
});

// ------------------------------------------------------------------ media library v2 (P5, storefront B1)

const del = (app: App, key: string) => send(app, 'DELETE', `${BASE}/media/${key}`);
/** A raw layout straight to the route — what a client outside the editor would send. */
const L = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ schema_version: 1, theme: 'classic', blocks, ...extra });
const byKey = (items: Array<{ key: string }>) => Object.fromEntries(items.map((i) => [i.key, i])) as Record<string, { key: string; byte_size: number; used_in: Array<{ kind: string; id?: string; block_id?: string }> }>;

test('the media library v2: every row carries its byte_size and where it is still shown', async () => {
  const w = world();
  // Nothing uses anything yet: byte_size from the ledger, used_in empty.
  const fresh = byKey((await json(await get(w.owner, `${BASE}/media?kind=image`))).items);
  assert.equal(fresh[MEDIA.picture].byte_size, 1000);
  assert.deepEqual(fresh[MEDIA.picture].used_in, []);
  assert.deepEqual(fresh[MEDIA.picture2].used_in, []);

  // A draft with the picture in a banner and as the page background; publish a layout with it in a gallery.
  const published = L([{ id: 'g', type: 'gallery', settings: { images: [{ image: MEDIA.picture }] } }]);
  const v = (await json(await put(w.owner, `${BASE}/draft`, { layout: published, version: 0 }))).draft.version;
  assert.equal((await post(w.owner, `${BASE}/publish`, { version: v })).status, 200);
  const draft = L([{ id: 'promo', type: 'banner', settings: { image: MEDIA.picture } }], {
    background: { kind: 'image', media: MEDIA.picture2, dim: 'light', phones: true },
  });
  assert.equal((await put(w.owner, `${BASE}/draft`, { layout: draft, version: v + 1 })).status, 200);
  // …and the picture also sits on a showcase entry, a collection cover, a product gallery, a service, the store's logo and the avatar.
  w.raw.prepare('UPDATE merchant_showcase SET image_key = ? WHERE id = ?').run(MEDIA.picture, 'sh3');
  w.raw.prepare('UPDATE merchant_store_sections SET image_key = ? WHERE id = ?').run(MEDIA.picture, 'sec2');
  w.raw.prepare('UPDATE community_products SET images = ? WHERE id = ?').run(JSON.stringify([`/files/${MEDIA.picture}`]), 'p4');
  w.raw.prepare('UPDATE merchant_services SET image_key = ? WHERE id = ?').run(MEDIA.picture, 'sv2');
  w.raw.prepare('UPDATE merchant_stores SET logo_key = ? WHERE id = ?').run(MEDIA.picture, STORE_ID);
  w.raw.prepare('UPDATE community_merchants SET avatar_key = ? WHERE id = ?').run(MEDIA.picture, 'm1');
  // A product of ANOTHER store showing it does not count as this store's use (and could not be this owner's key anyway).
  w.raw.prepare('UPDATE community_products SET images = ? WHERE id = ?').run(JSON.stringify([`/files/${MEDIA.picture2}`]), 'q1');

  const items = byKey((await json(await get(w.owner, `${BASE}/media?kind=image`))).items);
  const uses = items[MEDIA.picture].used_in.map((u) => [u.kind, u.id ?? '', u.block_id ?? ''].join(':')).sort();
  assert.deepEqual(uses, [
    'avatar::',
    'collection:sec2:',
    'layout:draft:promo',
    'layout:published:g',
    'product:p4:',
    'service:sv2:',
    'showcase:sh3:',
    'store:logo:',
  ]);
  assert.deepEqual(items[MEDIA.picture2].used_in, [{ kind: 'layout', id: 'draft', block_id: 'background' }], 'the page background is a use; another store\'s product is not');
  const videos = (await json(await get(w.owner, `${BASE}/media?kind=video`))).items;
  assert.equal(videos[0].byte_size, 9000);
  assert.deepEqual(videos[0].used_in, []);
});

test('DELETE /media/<key>: refused with MEDIA_IN_USE and where while anything shows the file; a free file is dated deleted and leaves the library', async () => {
  const w = world();
  const v = (await json(await put(w.owner, `${BASE}/draft`, { layout: L([{ id: 'g', type: 'gallery', settings: { images: [{ image: MEDIA.picture }] } }]), version: 0 }))).draft.version;
  w.raw.prepare('UPDATE merchant_stores SET banner_key = ? WHERE id = ?').run(MEDIA.picture, STORE_ID);

  // In use: the draft and the store banner say so, and nothing is changed.
  const busy = await del(w.owner, MEDIA.picture);
  assert.equal(busy.status, 409);
  const body = await json(busy);
  assert.equal(body.code, 'MEDIA_IN_USE');
  assert.deepEqual(body.details.where.sort(), ['layout', 'store']);
  assert.deepEqual(body.details.used_in, [{ kind: 'layout', id: 'draft', block_id: 'g' }, { kind: 'store', id: 'banner' }]);
  assert.equal(row(w.raw, 'SELECT deleted_at FROM file_objects WHERE object_key = ?', MEDIA.picture)!.deleted_at, null);

  // Freed from both, it goes: deleted_at is set, the library and the picker stop offering it, and a
  // later save that names it is cleaned like any deleted picture. The R2 bytes are the sweep's.
  assert.equal((await put(w.owner, `${BASE}/draft`, { layout: L([{ id: 't', type: 'text', settings: {} }]), version: v })).status, 200);
  w.raw.prepare('UPDATE merchant_stores SET banner_key = NULL WHERE id = ?').run(STORE_ID);
  const gone = await del(w.owner, MEDIA.picture);
  assert.equal(gone.status, 200, JSON.stringify(await gone.clone().json()));
  const stamped = row<{ deleted_at: string | null }>(w.raw, 'SELECT deleted_at FROM file_objects WHERE object_key = ?', MEDIA.picture)!.deleted_at;
  assert.ok(stamped && !Number.isNaN(Date.parse(stamped)));
  assert.equal(row(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'merchant.media_deleted' AND target = ?", STORE_ID)!.n, 1);
  const left = (await json(await get(w.owner, `${BASE}/media?kind=image`))).items.map((i: { key: string }) => i.key);
  assert.deepEqual(left, [MEDIA.picture2]);
  const again = await json(await put(w.owner, `${BASE}/draft`, { layout: L([{ id: 'b', type: 'banner', settings: { image: MEDIA.picture } }]), version: v + 1 }));
  assert.equal(again.success, true);
  assert.deepEqual(again.issues.map((i: { code: string }) => i.code), ['media_not_found']);
  assert.equal(again.draft.layout.blocks[0].settings.image, '');

  // The same file twice, a deleted one, somebody else's, a never-uploaded one, an encoded traversal, a private-prefix
  // key: one 404, nothing about what exists. (A raw `../` never reaches the route — the URL resolves it away first.)
  for (const key of [MEDIA.picture, MEDIA.deleted, MEDIA.foreign, MEDIA.unknown, encodeURIComponent('../../etc/passwd'), 'merchants/owner/private/x1aaaa.webp']) {
    const res = await del(w.owner, key);
    assert.equal(res.status, 404, key);
    assert.equal((await json(res)).code, 'MEDIA_NOT_FOUND', key);
  }
  assert.equal((await del(w.owner, '../../etc/passwd')).status, 404);
  assert.equal(row(w.raw, 'SELECT deleted_at FROM file_objects WHERE object_key = ?', MEDIA.foreign)!.deleted_at, null, 'the other owner\'s file is untouched');
  // A video is a library file too — and the video quota stops counting it. The percent-encoded spelling is read as well.
  const clip = await del(w.owner, encodeURIComponent(MEDIA.video));
  assert.equal(clip.status, 200);
  assert.deepEqual((await json(await get(w.owner, `${BASE}/media?kind=video`))).items, []);
  // Only the owner: anonymous 401, a customer without a store 403/404, another merchant cannot reach this owner's file.
  assert.equal((await del(w.anon, MEDIA.picture2)).status, 401);
  assert.ok([403, 404].includes((await del(w.customer, MEDIA.picture2)).status));
  assert.equal((await del(w.other, MEDIA.picture2)).status, 404);
  assert.equal(row(w.raw, 'SELECT deleted_at FROM file_objects WHERE object_key = ?', MEDIA.picture2)!.deleted_at, null);
});

test('a library picture a community post of the owner shows is in use (kind post): the delete is refused, the post can still be saved (review 2026-09-30)', async () => {
  const w = world();
  const posts = stubApp(asD1(w.raw), { id: OWNER, role: 'merchant', email: 'owner@x.co' }, (a) => a.route('/api/community', communityPostRoutes));
  const media = [{ key: MEDIA.picture, kind: 'image', width: 1000, height: 800 }];
  const made = await post(posts, '/api/community/posts', { title: 'My dragon print', body: 'PLA', kind: 'project', media });
  assert.equal(made.status, 201, JSON.stringify(await made.clone().json()));
  const postId = (await json(made)).post.id as string;
  assert.equal((await post(posts, `/api/community/posts/${postId}/publish`)).status, 200);
  // The library says where it is shown, and the delete door agrees.
  const items = byKey((await json(await get(w.owner, `${BASE}/media?kind=image`))).items);
  assert.deepEqual(items[MEDIA.picture].used_in, [{ kind: 'post', id: postId }]);
  const busy = await del(w.owner, MEDIA.picture);
  assert.equal(busy.status, 409);
  assert.deepEqual((await json(busy)).details.where, ['post']);
  assert.equal(row(w.raw, 'SELECT deleted_at FROM file_objects WHERE object_key = ?', MEDIA.picture)!.deleted_at, null);
  // So the author's edit that re-sends its own picture still passes the post door.
  assert.equal((await patch(posts, `/api/community/posts/${postId}`, { body: 'PLA, 0.2 mm', media })).status, 200);
  // A variant's picture and a legacy option picture are uses of the product too.
  w.raw.prepare('UPDATE community_products SET options = ? WHERE id = ?').run(JSON.stringify([{ name: 'Colour', values: [{ label: 'Red', image: `/files/${MEDIA.picture2}` }] }]), 'p4');
  const opt = byKey((await json(await get(w.owner, `${BASE}/media?kind=image`))).items);
  assert.deepEqual(opt[MEDIA.picture2].used_in, [{ kind: 'product', id: 'p4' }]);
});

test('a file heavier than its slot refuses the DRAFT save with LAYOUT_MEDIA_TOO_HEAVY and the figures — the picker can say them', async () => {
  const w = world();
  const heavy = 'merchants/owner/public/heavy001.webp';
  w.raw
    .prepare(`INSERT INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size) VALUES (?, 'public','merchants','owner','image/webp', ?)`)
    .run(heavy, 1_300_000);
  // 1.3 MB: fine as a banner (1.5 MB), too heavy as a gallery item (1 MB).
  const asBanner = await put(w.owner, `${BASE}/draft`, { layout: L([{ id: 'b', type: 'banner', settings: { image: heavy } }]), version: 0 });
  assert.equal(asBanner.status, 200);
  const v = (await json(asBanner)).draft.version;
  const asGallery = await put(w.owner, `${BASE}/draft`, { layout: L([{ id: 'g', type: 'gallery', settings: { images: [{ image: heavy }] } }]), version: v });
  assert.equal(asGallery.status, 400);
  const body = await json(asGallery);
  assert.equal(body.code, 'LAYOUT_MEDIA_TOO_HEAVY');
  assert.deepEqual(body.details, {
    path: 'blocks[0].settings.images[0].image',
    block_id: 'g',
    size: 1_300_000,
    max: 1024 * 1024,
    heavy: [{ path: 'blocks[0].settings.images[0].image', block_id: 'g', size: 1_300_000, max: 1024 * 1024 }],
  });
  assert.equal(draftRow(w.raw)!.version, v, 'the draft is untouched');
  // The library says the weight up front, so the picker refuses before the round trip.
  const item = (await json(await get(w.owner, `${BASE}/media?kind=image`))).items.find((i: { key: string }) => i.key === heavy);
  assert.equal(item.byte_size, 1_300_000);
  // The posted preview (the template gallery's door) is the client's layout too: the same refusal.
  assert.equal((await post(w.owner, `${BASE}/preview`, { layout: L([{ id: 'g', type: 'gallery', settings: { images: [{ image: heavy }] } }]) })).status, 400);
});
