/**
 * «التخصيص · Customization · خۆگونجاندن» — THE MERCHANT'S BUILDER DOORS
 * (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 1, §B.2
 * items 1–6, §B.8; worker/routes/merchantBlueprints.ts, worker/lib/personalize/
 * blueprints.ts and the catalogue's gates in worker/routes/merchantCatalog.ts).
 *
 * Pinned over the real routes on tests/fixtures/personalizeWorld.ts:
 *   · ownership and the entitlement: the store owner's own product, the switch
 *     or a pilot list, `customizableProducts` (/me.can.customize) — else 404;
 *   · a REAL 3MF (tests/fixtures/meshParts.ts) compiled into the PRIVATE draft
 *     mesh; part names only in the merchant's answers; BLUEPRINT_TOO_HEAVY
 *     stores nothing; an unreadable file marks a mesh-less draft `failed`;
 *   · the reference checks: this store's parts that fit their slot, the
 *     catalogue's materials, the workshop's bed, the product's own options;
 *   · publish: readiness, the public mesh under merchants/<uid>/public/bp/
 *     without the hidden parts, ONE live revision, a fenced batch that writes
 *     nothing when it loses a race; photo-only without a model; pause; the
 *     purge seams; BLUEPRINT_LOCKED and BLUEPRINT_LIMIT;
 *   · the catalogue: a duplicate copies the blueprint as a DRAFT and a part's
 *     facts without their source; an annotated option stays while live; a part
 *     a live revision builds in is not deleted — archived, yes;
 *   · the parts doors are dark with the builder; the public read is two D1 waves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { count, failingD1, get, json, patch, pending, post, put, row, all, send, type App, type StubUser } from './fixtures/app';
import { wavesD1 } from './fixtures/wavesD1';
import { bambuAssembly3mf, T3 } from './fixtures/meshParts';
import {
  ALI, ZAIN, BOSS, BUYER, MODEL_KEY, HEAVY_KEY, DOC_KEY, ZAIN_MODEL_KEY, PRIVATE_NOTE,
  as, lookBody, personalizeWorld, publishSign, publishStand, readBlueprint, setSwitch, signSpec, standSpec, type World,
} from './fixtures/personalizeWorld';
import { blueprintPaths } from '../worker/lib/personalize/blueprints';
import { readLvr1 } from '../worker/lib/personalize/compile';
import { readPartSpec } from '../packages/catalog/src/personalize/parts';
import { defaultConfig } from '../packages/catalog/src/personalize/config';
import { readRefusal } from '../src/components/merchant/catalog/parts';
import type { Loc } from '../src/components/merchant/catalog/strings';
import { ApiError } from '../src/lib/api';

const BP = (id: string) => `/api/merchant/products/${id}/blueprint`;
const code = async (res: Response) => (await json(res)).code as string | undefined;

/** Every builder door, as the builder calls it. */
const DOORS: Array<[string, string, (id: string) => string, unknown?]> = [
  ['GET', 'state', (id) => BP(id)],
  ['PUT', 'model', (id) => `${BP(id)}/model`, { keys: [MODEL_KEY] }],
  ['GET', 'mesh', (id) => `${BP(id)}/mesh`],
  ['PUT', 'draft', (id) => `${BP(id)}/draft`, { spec: standSpec() }],
  ['PUT', 'look', (id) => `${BP(id)}/look`, lookBody()],
  ['POST', 'publish', (id) => `${BP(id)}/publish`, { rev: 1 }],
  ['POST', 'pause', (id) => `${BP(id)}/pause`, {}],
];
const del = (app: App, path: string) => send(app, 'DELETE', path);
const call = (w: World, user: StubUser | null, method: string, path: string, body?: unknown) =>
  method === 'GET' ? get(as(w, user), path) : method === 'PUT' ? put(as(w, user), path, body) : post(as(w, user), path, body);

/** The lamp: a look axis over the product's own Finish values. */
const lampSpec = (silkMaterial = 'petg') => ({
  v: 1,
  family: 'lamp',
  sell: { cart: true, request: true },
  regions: [{ id: 'shade', role: 'body', parts: [0], tone: 'neutral', paint: { allowed: ['white'], default: 'white' } }],
  colors: { included: 1, per_extra_iqd: 0, max: 1 },
  axes: { look: { group: 'og_look', values: { ov_classic: { look: 'classic', material_id: 'pla' }, ov_silk: { look: 'silk', material_id: silkMaterial } } } },
});

// ================================================================ ownership

test('the builder is the store owner\'s: 404 on every door while dark (a pilot store opens its own), another\'s product 404, no store 404, no session 401', async () => {
  const w = personalizeWorld();
  for (const [method, label, path, body] of DOORS) {
    const res = await call(w, ALI, method, path('cp_stand'), body);
    assert.equal(res.status, 404, `dark ${label}`);
    assert.equal(await code(res), 'PERSONALIZATION_UNAVAILABLE', `dark ${label}`);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_blueprints'), 0, 'nothing was written while dark');

  setSwitch(w.raw, { pilot_store_ids: ['s_ali'] });
  const state = await get(as(w, ALI), BP('cp_stand'));
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('Cache-Control'), 'private, no-store');
  const body = await json(state);
  assert.deepEqual({ draft: body.draft, live: body.live, retired: body.retired, mesh_state: body.mesh_state }, { draft: null, live: null, retired: [], mesh_state: 'none' });
  assert.deepEqual(body.limits, { max_triangles: 60000, max_blueprints_per_store: 200, source_files: 12 });
  const zainOwn = await get(as(w, ZAIN), BP('cp_zprod'));
  assert.equal(zainOwn.status, 404, 'Zain\'s store is not a pilot');
  assert.equal(await code(zainOwn), 'PERSONALIZATION_UNAVAILABLE');

  setSwitch(w.raw, { enabled: true });
  for (const [method, label, path, body] of DOORS) {
    const res = await call(w, ZAIN, method, path('cp_stand'), body);
    assert.equal(res.status, 404, `Zain on Ali's product: ${label}`);
    assert.equal(await code(res), 'NOT_FOUND', label);
  }
  assert.equal((await get(as(w, BUYER), BP('cp_stand'))).status, 404, 'no store at all');
  assert.equal((await get(as(w, null), BP('cp_stand'))).status, 401);
  const quote = await put(as(w, ALI), `${BP('cp_private')}/draft`, { spec: standSpec() });
  assert.equal(quote.status, 409);
  assert.deepEqual(await json(quote).then((b) => [b.code, b.details]), ['BLUEPRINT_PRODUCT_INELIGIBLE', { reason: 'private' }]);
  w.raw.exec("UPDATE community_products SET publish_state = 'archived' WHERE id = 'cp_plain'");
  const archived = await get(as(w, ALI), BP('cp_plain'));
  assert.equal(archived.status, 409);
  assert.deepEqual((await json(archived)).details, { reason: 'archived' });
});

test('the entitlement: /me.can.customize follows the switch and `customizableProducts`; a gated benefit closes the builder and nothing else', async () => {
  const w = personalizeWorld();
  const can = async (who: StubUser) => (await json(await get(as(w, who), '/api/merchant/me'))).can.customize as boolean;
  assert.equal(await can(ALI), false, 'dark');
  setSwitch(w.raw, { pilot_store_ids: ['s_ali'] });
  assert.deepEqual([await can(ALI), await can(ZAIN)], [true, false]);
  setSwitch(w.raw, { pilot_user_ids: ['zain'] });
  assert.deepEqual([await can(ALI), await can(ZAIN)], [false, true], 'a pilot person opens their own store\'s builder');
  setSwitch(w.raw, { enabled: true });
  assert.deepEqual([await can(ALI), await can(ZAIN), await can(BUYER)], [true, true, false]);
  w.raw.exec(`INSERT INTO restriction_cases (id, user_id, kind, state, reason, benefit_flags) VALUES ('rc_1', 'ali', 'other', 'active', 'review', '["customizableProducts"]')`);
  assert.equal(await can(ALI), false);
  const closed = await get(as(w, ALI), BP('cp_stand'));
  assert.equal(closed.status, 404);
  assert.equal(await code(closed), 'PERSONALIZATION_UNAVAILABLE');
  assert.equal((await get(as(w, ALI), '/api/merchant/products')).status, 200, 'the store itself sells on');
});

// ==================================================================== model

test('a real 3MF compiles into the PRIVATE draft mesh: part names only in the merchant\'s answer, the mesh door is the owner\'s', async () => {
  const w = personalizeWorld({ on: true });
  const res = await put(as(w, ALI), `${BP('cp_stand')}/model`, { keys: [MODEL_KEY] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const body = await json(res);
  assert.equal(body.mesh_state, 'ready');
  assert.deepEqual(body.parts.map((p: { n: number; name: string; triangles: number }) => [p.n, p.name, p.triangles]), [[0, 'Body', 12], [1, 'Name plate', 12]]);
  assert.deepEqual(body.suggestions.roles, [{ n: 0, role: 'body' }, { n: 1, role: 'name' }]);
  assert.ok(body.warnings.includes('MODIFIERS_SKIPPED'), 'the modifier is not a part');
  assert.ok(body.warnings.includes('NEEDS_SPEC'), 'a publish still needs the customization itself');
  const draft = body.draft;
  assert.equal(draft.rev, 1);
  assert.equal(draft.mesh.url, '/api/merchant/products/cp_stand/blueprint/mesh?rev=1');
  assert.equal(draft.mesh.public_url, null, 'nothing public before a publish');
  assert.deepEqual([draft.mesh.triangles, draft.mesh.dims_mm, draft.analysis.format], [24, [20, 20, 7], '3mf']);
  assert.deepEqual(draft.source_keys, [MODEL_KEY]);
  const stored = row<{ draft_mesh_key: string; mesh_state: string; mesh_key: string | null }>(w.raw, "SELECT draft_mesh_key, mesh_state, mesh_key FROM product_blueprints WHERE product_id = 'cp_stand'")!;
  assert.match(stored.draft_mesh_key, /^merchants\/ali\/blueprints\/cp_stand-[0-9a-f]{12}\.lvm\.gz$/);
  assert.equal(stored.mesh_key, null);
  assert.ok(w.priv.objects.has(stored.draft_mesh_key), 'in the PRIVATE bucket');
  assert.ok(![...w.pub.objects.keys()].length, 'nothing public');
  assert.deepEqual(row(w.raw, 'SELECT visibility, owner_id, entity_id, mime_type FROM file_objects WHERE object_key = ?', stored.draft_mesh_key), {
    visibility: 'private', owner_id: 'ali', entity_id: 'cp_stand', mime_type: 'application/gzip',
  });
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'blueprint.model_attached' AND target = 'cp_stand'"), 1);

  // The owner's full mesh door: every part, gzip, private, sandboxed.
  const mesh = await get(as(w, ALI), `${BP('cp_stand')}/mesh`);
  assert.equal(mesh.status, 200);
  assert.equal(mesh.headers.get('Content-Type'), 'application/gzip');
  assert.equal(mesh.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(mesh.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(mesh.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  const lvr = readLvr1(new Uint8Array(gunzipSync(new Uint8Array(await mesh.arrayBuffer()))));
  assert.deepEqual(lvr, { triangles: 24, ranges: [[0, 12], [12, 12]] });
  assert.equal((await get(as(w, ALI), `${BP('cp_stand')}/mesh?rev=9`)).status, 404);
  assert.equal((await get(as(w, ZAIN), `${BP('cp_stand')}/mesh`)).status, 404);
  assert.equal((await get(as(w, BUYER), `${BP('cp_stand')}/mesh`)).status, 404);
});

test('model refusals: another\'s file, a document, a damaged model (a mesh-less draft is marked failed, a working mesh kept), a model over max_triangles stores nothing', async () => {
  const w = personalizeWorld({ on: true });
  const app = as(w, ALI);
  const model = (keys: unknown) => put(app, `${BP('cp_stand')}/model`, { keys });
  const zains = await model([ZAIN_MODEL_KEY]);
  assert.equal(zains.status, 400);
  assert.deepEqual(await json(zains).then((b) => [b.code, b.details]), ['PRODUCT_FILE_NOT_OWNED', { key: ZAIN_MODEL_KEY }]);
  const doc = await model([DOC_KEY]);
  assert.equal(doc.status, 422);
  assert.deepEqual(await json(doc).then((b) => [b.code, b.details]), ['BLUEPRINT_MODEL_UNREADABLE', { format: 'unknown', hint: 'export_mesh' }]);
  for (const keys of [[], Array.from({ length: 13 }, (_, i) => `merchants/ali/product-files/k${i}0000.stl`), 'x', [7]]) {
    const res = await model(keys);
    assert.equal(res.status, 400, JSON.stringify(keys));
    assert.deepEqual(await json(res).then((b) => [b.code, b.details.path]), ['BLUEPRINT_INVALID', 'keys']);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_blueprints'), 0, 'no draft for a refused model');

  // Heavier than the switch allows: the exact count, and nothing stored.
  setSwitch(w.raw, { enabled: true, max_triangles: 1000 });
  const heavy = await model([HEAVY_KEY]);
  assert.equal(heavy.status, 413);
  assert.deepEqual(await json(heavy).then((b) => [b.code, b.details]), ['BLUEPRINT_TOO_HEAVY', { triangles: 1212, max: 1000 }]);
  assert.ok(![...w.priv.objects.keys()].some((k) => k.includes('/blueprints/')), 'no mesh stored');
  setSwitch(w.raw, { enabled: true });

  // A damaged 3MF: a draft with no working mesh remembers why…
  const broken = 'merchants/ali/product-files/broken001.3mf';
  w.raw.exec(`INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, purpose) VALUES ('${broken}', 'private', 'merchants', 'ali', 'ali', 'model/3mf', 9, 'product_file')`);
  await w.priv.put(broken, new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 9, 9]));
  assert.equal((await put(app, `${BP('cp_stand')}/draft`, { spec: standSpec() })).status, 200);
  const failed = await model([broken]);
  assert.equal(failed.status, 422);
  assert.equal(await code(failed), 'BLUEPRINT_MODEL_UNREADABLE');
  const after = await json(await get(app, BP('cp_stand')));
  assert.equal(after.mesh_state, 'failed');
  assert.ok(after.warnings.includes('MESH_FAILED'));
  assert.ok(after.warnings.some((x: string) => x.startsWith('HINT_')), JSON.stringify(after.warnings));
  // …a working one is kept as it was.
  assert.equal((await model([MODEL_KEY])).status, 200);
  assert.equal((await model([broken])).status, 422);
  assert.equal((await json(await get(app, BP('cp_stand')))).mesh_state, 'ready');
});

// ================================================================ references

test('reference checks on save: this store\'s parts that fit, the catalogue\'s materials, the printer, the product\'s own options, the mesh — nothing stored when refused', async () => {
  const w = personalizeWorld({ on: true });
  const app = as(w, ALI);
  const save = (id: string, spec: unknown) => put(app, `${BP(id)}/draft`, { spec });
  const edit = (base: () => Record<string, unknown>, fn: (s: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = base();
    fn(s);
    return s;
  };
  w.raw.exec("UPDATE community_products SET admin_hidden_at = '2026-09-01T00:00:00.000Z' WHERE id = 'cp_glue'");
  const cases: Array<[string, string, unknown, string, string, string]> = [
    ['a part of another store', 'cp_stand', edit(standSpec, (s) => { s.slots[0].options[0].part.p = 'cp_zmagnet'; }), 'BLUEPRINT_COMPONENT_NOT_ELIGIBLE', 'slots.0.options.0.part', 'UNKNOWN_REF'],
    ['a part that does not fit its slot', 'cp_stand', edit(standSpec, (s) => { s.slots[0].options[0].part.p = 'cp_bigmag'; }), 'BLUEPRINT_COMPONENT_NOT_ELIGIBLE', 'slots.0.options.0.part', 'INVALID'],
    ['a product that is no part', 'cp_sign', edit(signSpec, (s) => { s.slots[0].options[0].part.p = 'cp_plain'; }), 'BLUEPRINT_COMPONENT_NOT_ELIGIBLE', 'slots.0.options.0.part', 'UNKNOWN_REF'],
    ['the product itself', 'cp_stand', edit(standSpec, (s) => { s.slots[0].options[0].part.p = 'cp_stand'; }), 'BLUEPRINT_COMPONENT_NOT_ELIGIBLE', 'slots.0.options.0.part', 'INVALID'],
    ['a part Levonis hid', 'cp_stand', standSpec(), 'BLUEPRINT_COMPONENT_NOT_ELIGIBLE', 'fixed.0.part', 'UNKNOWN_REF'],
    ['a Levonis item while parts_levonis is off', 'cp_sign', edit(signSpec, (s) => { s.slots[0].options[0].part = { p: 'lv_mag', v: null, src: 'levonis' }; }), 'BLUEPRINT_COMPONENT_NOT_ELIGIBLE', 'slots.0.options.0.part.src', 'NOT_ALLOWED'],
    ['a material not in the catalogue', 'cp_lamp', lampSpec('pla-silk'), 'BLUEPRINT_INVALID', 'axes.look.values.ov_silk.material_id', 'UNKNOWN_REF'],
    ['a size above the printer', 'cp_sign', edit(signSpec, (s) => { s.axes.size.values.ov_sl.dims_mm = [300, 100, 5]; }), 'BLUEPRINT_INVALID', 'axes.size.values.ov_sl.dims_mm', 'RANGE'],
    ['a value the product does not have', 'cp_stand', edit(standSpec, (s) => { s.axes.size.values.ov_xl = { dims_mm: [180, 120, 140], scale: 1.2 }; }), 'BLUEPRINT_INVALID', 'axes.size.values.ov_xl', 'UNKNOWN_REF'],
    ['another product\'s option group', 'cp_stand', edit(standSpec, (s) => { s.axes.size.group = 'og_sign'; }), 'BLUEPRINT_INVALID', 'axes.size.group', 'UNKNOWN_REF'],
    ['a value left unannotated', 'cp_stand', edit(standSpec, (s) => { delete s.axes.size.values.ov_m; }), 'BLUEPRINT_INVALID', 'axes.size.values.ov_m', 'REQUIRED'],
    ['a negative fee', 'cp_sign', edit(signSpec, (s) => { s.areas[0].fee_iqd = -5; }), 'BLUEPRINT_PRICE_INVALID', 'areas.0.fee_iqd', 'PRICE'],
  ];
  for (const [label, id, spec, want, path, errorCode] of cases) {
    const res = await save(id, spec);
    assert.equal(res.status, 400, `${label}: ${await res.clone().text()}`);
    const body = await json(res);
    assert.deepEqual([body.code, body.details.path, body.details.errors[0].code], [want, path, errorCode], label);
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_blueprints'), 0, 'no refused save opened a draft');
  w.raw.exec("UPDATE community_products SET admin_hidden_at = NULL WHERE id = 'cp_glue'");
  assert.equal((await save('cp_lamp', lampSpec())).status, 200, 'PETG is in the catalogue');
  // With the model attached, its parts and its box are the limits.
  assert.equal((await put(app, `${BP('cp_stand')}/model`, { keys: [MODEL_KEY] })).status, 200);
  for (const [label, fn, path] of [
    ['a part index past the model', (s: Record<string, any>) => { s.regions[0].parts = [5]; }, 'regions.0.parts.0'], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['a frame off the model', (s: Record<string, any>) => { s.areas[0].frame.o = [0, -40, 0]; }, 'areas.0.frame.o'], // eslint-disable-line @typescript-eslint/no-explicit-any
  ] as const) {
    const res = await save('cp_stand', edit(standSpec, fn));
    assert.equal(res.status, 400, label);
    assert.equal((await json(res)).details.path, path, label);
  }
  // Parts are allowed from Levonis once the owner says so — never stored as the store's refs.
  setSwitch(w.raw, { enabled: true, parts_levonis: true });
  assert.equal((await save('cp_sign', edit(signSpec, (s) => { s.slots[0].options[0].part = { p: 'lv_mag', v: null, src: 'levonis' }; }))).status, 200);
  assert.deepEqual(all(w.raw, "SELECT slot_key, part_product_id FROM blueprint_part_refs WHERE product_id = 'cp_sign' ORDER BY slot_key"), [{ slot_key: 'light', part_product_id: 'cp_led' }]);
});

// ================================================================== publish

test('publish: not ready without a look; the public mesh drops the hidden part under merchants/<uid>/public/bp/; one live revision with its refs, price and audit', async () => {
  const w = personalizeWorld({ on: true });
  const app = as(w, ALI);
  assert.equal((await put(app, `${BP('cp_stand')}/model`, { keys: [MODEL_KEY] })).status, 200);
  const saved = await json(await put(app, `${BP('cp_stand')}/draft`, { spec: standSpec() }));
  assert.deepEqual(saved.warnings.filter((x: string) => x.startsWith('NEEDS_')), ['NEEDS_LOOK']);
  const early = await post(app, `${BP('cp_stand')}/publish`, { rev: 1 });
  assert.equal(early.status, 409);
  assert.deepEqual(await json(early).then((b) => [b.code, b.details]), ['BLUEPRINT_NOT_READY', { missing: ['look'] }]);

  // The look card: the poster checked by its bytes, every area's quad.
  for (const [label, over, path, errorCode] of [
    ['a poster that is not a picture', { poster: Buffer.from('not a picture at all').toString('base64') }, 'poster', 'TYPE'],
    ['a poster over 400 KB', { poster: Buffer.alloc(410 * 1024, 1).toString('base64') }, 'poster', 'TOO_LARGE'],
    ['an area left out', { quads: {} }, 'quads.name', 'REQUIRED'],
    ['an area it does not have', { quads: { name: [[0, 0], [1, 0], [1, 1], [0, 1]], logo: [[0, 0], [1, 0], [1, 1], [0, 1]] } }, 'quads.logo', 'UNKNOWN_REF'],
    ['a camera of 15 numbers', { camera: Array(15).fill(1) }, 'camera', 'TYPE'],
  ] as const) {
    const res = await put(app, `${BP('cp_stand')}/look`, lookBody(over));
    assert.equal(res.status, 400, label);
    const b = await json(res);
    assert.ok(b.details.errors.some((e: { path: string; code: string }) => e.path === path && e.code === errorCode), `${label}: ${JSON.stringify(b.details)}`);
  }
  const looked = await json(await put(app, `${BP('cp_stand')}/look`, lookBody()));
  assert.match(looked.draft.look.poster_url, /^\/files\/merchants\/ali\/public\/bp\/bp_[0-9a-f]{20}-look-[0-9a-f]{12}\.png$/);
  assert.deepEqual(looked.warnings.filter((x: string) => x.startsWith('NEEDS_')), []);

  const res = await post(app, `${BP('cp_stand')}/publish`, { rev: 1 });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json(res);
  assert.equal(body.draft, null);
  assert.equal(body.live.rev, 1);
  const r = row<Record<string, any>>(w.raw, "SELECT * FROM product_blueprints WHERE product_id = 'cp_stand'")!; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(r.state, 'live');
  assert.equal(r.mesh_key, `merchants/ali/public/bp/${r.id}-r1-${r.mesh_hash.slice(0, 12)}.lvm.gz`);
  assert.deepEqual([r.triangles, r.from_iqd, r.family, JSON.parse(r.tags)], [12, 20000, 'stand', ['occ:birthday', 'for:kids']]);
  assert.ok(r.published_at);
  // The public mesh: every part index kept, the name plate (no region takes it) with no triangles.
  const stored = w.pub.objects.get(r.mesh_key);
  assert.ok(stored, 'in the PUBLIC bucket');
  assert.equal(stored!.contentType, 'application/gzip');
  assert.deepEqual(readLvr1(new Uint8Array(gunzipSync(stored!.bytes))), { triangles: 12, ranges: [[0, 12], [12, 0]] });
  assert.equal(r.mesh_bytes, stored!.bytes.byteLength);
  // The derived part index, the audit row.
  assert.deepEqual(all(w.raw, "SELECT rev, slot_key, option_key, part_product_id, part_variant_id, qty FROM blueprint_part_refs WHERE product_id = 'cp_stand' ORDER BY slot_key"), [
    { rev: 1, slot_key: 'magnet', option_key: 'm10', part_product_id: 'cp_magnet', part_variant_id: '', qty: 2 },
    { rev: 1, slot_key: '~fixed', option_key: '0', part_product_id: 'cp_glue', part_variant_id: '', qty: 1 },
  ]);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'blueprint.published' AND target = 'cp_stand'"), 1);
  // A second press is a no-op.
  assert.equal((await post(app, `${BP('cp_stand')}/publish`, { rev: 1 })).status, 200);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'blueprint.published' AND target = 'cp_stand'"), 1);
  assert.equal((await post(app, `${BP('cp_stand')}/publish`, { rev: 7 })).status, 404);
  assert.equal((await post(app, `${BP('cp_stand')}/publish`, {})).status, 400);
});

test('a new revision starts as a copy of the live one (no re-upload); publishing it retires the old; a retired one republishes as it was; a new model makes the look stale', async () => {
  const w = personalizeWorld({ on: true });
  await publishStand(w);
  const app = as(w, ALI);
  const v1 = row<{ id: string; mesh_key: string; draft_mesh_key: string; look: string }>(w.raw, "SELECT id, mesh_key, draft_mesh_key, look FROM product_blueprints WHERE product_id = 'cp_stand' AND rev = 1")!;
  // A fee change: revision 2, carrying the mesh, parts and look of revision 1.
  const spec2 = { ...standSpec(), colors: { included: 2, per_extra_iqd: 1500, max: 3 } };
  const saved = await json(await put(app, `${BP('cp_stand')}/draft`, { spec: spec2, rev: 1 }));
  assert.equal(saved.draft.rev, 2);
  assert.equal(saved.live.rev, 1, 'the live revision is untouched while the draft is edited');
  const v2 = row<{ draft_mesh_key: string; look: string; mesh_state: string; mesh_key: string | null }>(w.raw, "SELECT draft_mesh_key, look, mesh_state, mesh_key FROM product_blueprints WHERE product_id = 'cp_stand' AND rev = 2")!;
  assert.deepEqual([v2.draft_mesh_key, v2.look, v2.mesh_state, v2.mesh_key], [v1.draft_mesh_key, v1.look, 'ready', null]);
  assert.deepEqual(saved.warnings.filter((x: string) => x.startsWith('NEEDS_')), [], 'the look still fits: same mesh, same regions and frames');
  assert.equal((await post(app, `${BP('cp_stand')}/publish`, { rev: 2 })).status, 200);
  assert.deepEqual(all(w.raw, "SELECT rev, state FROM product_blueprints WHERE product_id = 'cp_stand' ORDER BY rev"), [{ rev: 1, state: 'retired' }, { rev: 2, state: 'live' }]);
  assert.equal((await json(await readBlueprint(w, 'cp_stand'))).blueprint.rev, 2);
  // Back to revision 1, exactly as it was.
  assert.equal((await post(app, `${BP('cp_stand')}/publish`, { rev: 1 })).status, 200);
  assert.deepEqual(all(w.raw, "SELECT rev, state FROM product_blueprints WHERE product_id = 'cp_stand' ORDER BY rev"), [{ rev: 1, state: 'live' }, { rev: 2, state: 'retired' }]);
  assert.equal(row<{ mesh_key: string }>(w.raw, "SELECT mesh_key FROM product_blueprints WHERE product_id = 'cp_stand' AND rev = 1")!.mesh_key, v1.mesh_key);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_blueprints WHERE product_id = 'cp_stand' AND state = 'live'"), 1);
  // A different model: the look was captured from the old one.
  const moved = 'merchants/ali/product-files/stand0002.3mf';
  w.raw.exec(`INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, purpose) VALUES ('${moved}', 'private', 'merchants', 'ali', 'ali', 'model/3mf', 9, 'product_file')`);
  await w.priv.put(moved, bambuAssembly3mf({ plateTransform: T3.translate(2, 8, 5.5) }));
  const remodel = await json(await put(app, `${BP('cp_stand')}/model`, { keys: [moved] }));
  assert.equal(remodel.draft.rev, 3);
  assert.ok(remodel.warnings.includes('NEEDS_LOOK'), JSON.stringify(remodel.warnings));
  const stale = await post(app, `${BP('cp_stand')}/publish`, { rev: 3 });
  assert.equal(stale.status, 409);
  assert.deepEqual((await json(stale)).details, { missing: ['look'] });
  assert.ok(w.priv.objects.has(v1.draft_mesh_key), 'the old draft mesh stays while a revision names it');
});

test('editing a RETIRED revision opens the next draft from it — its model, not the live one\'s; the history is paged (limit + 1)', async () => {
  const w = personalizeWorld({ on: true });
  await publishStand(w);
  const app = as(w, ALI);
  const moved = 'merchants/ali/product-files/stand0003.3mf';
  w.raw.exec(`INSERT INTO file_objects (object_key, visibility, domain, owner_id, entity_id, mime_type, byte_size, purpose) VALUES ('${moved}', 'private', 'merchants', 'ali', 'ali', 'model/3mf', 9, 'product_file')`);
  await w.priv.put(moved, bambuAssembly3mf({ plateTransform: T3.translate(3, 8, 5) }));
  assert.equal((await put(app, `${BP('cp_stand')}/model`, { keys: [moved] })).status, 200);
  assert.equal((await put(app, `${BP('cp_stand')}/look`, lookBody())).status, 200);
  assert.equal((await post(app, `${BP('cp_stand')}/publish`, { rev: 2 })).status, 200);
  const key = (rev: number) => row<{ draft_mesh_key: string }>(w.raw, "SELECT draft_mesh_key FROM product_blueprints WHERE product_id = 'cp_stand' AND rev = ?", rev)!.draft_mesh_key;
  assert.notEqual(key(1), key(2));
  // The builder was looking at revision 1 (retired) and saves from it.
  const saved = await json(await put(app, `${BP('cp_stand')}/draft`, { spec: standSpec(), rev: 1 }));
  assert.equal(saved.draft.rev, 3);
  assert.equal(key(3), key(1), 'the draft starts from the revision the builder was editing');
  assert.deepEqual(saved.retired.map((r: { rev: number }) => r.rev), [1]);
  assert.equal(saved.retired_more, false);
  // A long history: the newest twenty, and a flag for the rest.
  const ts = '2026-09-30T00:00:00.000Z';
  const insert = w.raw.prepare(
    `INSERT INTO product_blueprints (id, product_id, store_id, merchant_id, rev, state, spec, created_at, updated_at, published_at, retired_at)
     VALUES (?, 'cp_stand', 's_ali', 'm_ali', ?, 'retired', '{"v":1}', ?, ?, ?, ?)`
  );
  for (let rev = 10; rev < 32; rev++) insert.run(`bp_old_${rev}`, rev, ts, ts, ts, ts);
  const state = await json(await get(app, BP('cp_stand')));
  assert.equal(state.retired.length, 20);
  assert.equal(state.retired_more, true);
  assert.equal(state.retired[0].rev, 31, 'newest first');
  assert.equal(state.draft.rev, 3, 'the draft is found whatever the history holds');
});

test('photo-only: saved and published with no model and no look; the public read shows the product\'s pictures', async () => {
  const w = personalizeWorld({ on: true });
  const app = as(w, ALI);
  const saved = await json(await put(app, `${BP('cp_sign')}/draft`, { spec: signSpec() }));
  assert.equal(saved.mesh_state, 'photo');
  assert.deepEqual(saved.warnings, []);
  const look = await put(app, `${BP('cp_sign')}/look`, lookBody());
  assert.equal(look.status, 409);
  assert.deepEqual((await json(look)).details, { missing: ['mesh'] });
  const published = await json(await post(app, `${BP('cp_sign')}/publish`, { rev: 1 }));
  assert.equal(published.live.mesh_state, 'photo');
  const r = row<{ state: string; mesh_key: string | null; photo_keys: string; from_iqd: number }>(w.raw, "SELECT state, mesh_key, photo_keys, from_iqd FROM product_blueprints WHERE product_id = 'cp_sign'")!;
  assert.deepEqual([r.state, r.mesh_key, r.from_iqd], ['live', null, 35000]);
  assert.deepEqual(JSON.parse(r.photo_keys), { pm_black: 'merchants/ali/public/bbbb2222.webp', pm_wood: 'merchants/ali/public/aaaa1111.webp' });
  assert.equal(w.pub.objects.size, 0, 'no mesh, no poster');
  const pub = (await json(await readBlueprint(w, 'cp_sign'))).blueprint;
  assert.equal(pub.mesh, null);
  assert.equal(pub.photos.length, 2);
});

test('BLUEPRINT_LOCKED: a stale revision from the builder; a publish or a save that loses its race writes nothing at all', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  const app = as(w, ALI);
  assert.equal((await json(await put(app, `${BP('cp_sign')}/draft`, { spec: signSpec(), rev: 1 }))).draft.rev, 2);
  for (const rev of [1, 5]) {
    const res = await put(app, `${BP('cp_sign')}/draft`, { spec: signSpec(), rev });
    assert.equal(res.status, 409, String(rev));
    assert.deepEqual(await json(res).then((b) => [b.code, b.details]), ['BLUEPRINT_LOCKED', { rev, draft_rev: 2 }]);
  }
  assert.equal((await put(app, `${BP('cp_sign')}/draft`, { spec: signSpec(), rev: 2 })).status, 200);

  // A second tab saves the draft between this publish's checks and its batch.
  const audits = () => count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'blueprint.published'");
  const before = audits();
  const racing = failingD1(w.raw);
  racing.failing.beforeBatch = (stmts) => {
    if (!stmts.some((s) => /SET state = 'retired'/.test(s.sql))) return;
    w.raw.exec("UPDATE product_blueprints SET spec = json_set(spec, '$.warranty_days', 99), updated_at = '2030-01-01T00:00:00.000Z' WHERE product_id = 'cp_sign' AND state = 'draft'");
    racing.failing.beforeBatch = null;
  };
  const lost = await post(as(w, ALI, { db: racing.db }), `${BP('cp_sign')}/publish`, { rev: 2 });
  assert.equal(lost.status, 409, await lost.clone().text());
  assert.deepEqual(await json(lost).then((b) => [b.code, b.details]), ['BLUEPRINT_LOCKED', { reason: 'changed' }]);
  assert.deepEqual(all(w.raw, "SELECT rev, state FROM product_blueprints WHERE product_id = 'cp_sign' ORDER BY rev"), [{ rev: 1, state: 'live' }, { rev: 2, state: 'draft' }]);
  assert.equal(audits(), before, 'no audit row for a publish that did not happen');

  // A save that lands after a publish flipped its draft never touches the live revision's refs.
  const refsOfTwo = () => all(w.raw, "SELECT slot_key, part_product_id FROM blueprint_part_refs WHERE product_id = 'cp_sign' AND rev = 2 ORDER BY slot_key");
  assert.equal((await post(app, `${BP('cp_sign')}/publish`, { rev: 2 })).status, 200);
  const refs = refsOfTwo();
  const saving = failingD1(w.raw);
  const noMagnet = signSpec();
  (noMagnet.slots as unknown[]).splice(0, 1);
  // Revision 3 is opened; a publish of it lands between the next save's read and its batch.
  assert.equal((await put(app, `${BP('cp_sign')}/draft`, { spec: signSpec() })).status, 200);
  saving.failing.beforeBatch = (stmts) => {
    if (!stmts.some((s) => /DELETE FROM blueprint_part_refs/.test(s.sql))) return;
    w.raw.exec("UPDATE product_blueprints SET state = 'retired' WHERE product_id = 'cp_sign' AND state = 'live'");
    w.raw.exec("UPDATE product_blueprints SET state = 'live' WHERE product_id = 'cp_sign' AND rev = 3");
    saving.failing.beforeBatch = null;
  };
  const save = await put(as(w, ALI, { db: saving.db }), `${BP('cp_sign')}/draft`, { spec: noMagnet });
  assert.equal(save.status, 409);
  assert.equal(await code(save), 'BLUEPRINT_LOCKED');
  assert.deepEqual(all(w.raw, "SELECT slot_key FROM blueprint_part_refs WHERE product_id = 'cp_sign' AND rev = 3 ORDER BY slot_key"), [{ slot_key: 'light' }, { slot_key: 'magnet' }], 'the live revision keeps its refs');
  assert.deepEqual(refsOfTwo(), refs);
});

test('pause: the live revision retires and customers stop seeing it; a second press is a no-op; the purge drops the read and the page on every host', async () => {
  const w = personalizeWorld({ on: true });
  await publishSign(w);
  assert.deepEqual(blueprintPaths({ slug: 'ali3d' }, { id: 'cp_sign', slug: 'shop-sign' }), ['/api/personalize/blueprints/cp_sign', '/api/storefront/ali3d/products/shop-sign']);
  const store = new Map<string, Response>();
  const deleted: string[] = [];
  const scope = globalThis as { caches?: unknown };
  scope.caches = {
    default: {
      async match(req: Request) { return store.get(req.url)?.clone(); },
      async put(req: Request, res: Response) { store.set(req.url, res); },
      async delete(req: Request) { deleted.push(req.url); return store.delete(req.url); },
    },
  };
  try {
    const app = as(w, ALI, { env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' } });
    const HOST = { Host: 'levonis-iq.com' };
    const res = await post(app, `${BP('cp_sign')}/pause`, {}, HOST);
    assert.equal(res.status, 200);
    await Promise.all(pending);
    for (const url of [
      'https://levonis-iq.com/api/personalize/blueprints/cp_sign',
      'https://ali3d.levonis-iq.com/api/personalize/blueprints/cp_sign',
      'https://levonis-iq.com/api/storefront/ali3d/products/shop-sign',
      'https://ali3d.levonis-iq.com/api/storefront/ali3d/products/shop-sign',
    ]) {
      assert.ok(deleted.includes(url), `purged ${url}`);
    }
    const body = await json(res);
    assert.equal(body.live, null);
    assert.deepEqual(body.retired.map((r: { rev: number }) => r.rev), [1]);
    assert.equal((await readBlueprint(w, 'cp_sign')).status, 404);
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'blueprint.paused'"), 1);
    // Again: nothing live, nothing to purge, nothing audited.
    deleted.length = 0;
    assert.equal((await post(app, `${BP('cp_sign')}/pause`, {}, HOST)).status, 200);
    assert.ok(!deleted.some((u) => u.includes('/api/personalize/')), 'no blueprint purge for a no-op');
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'blueprint.paused'"), 1);
    // Publishing it again purges the same answers.
    deleted.length = 0;
    const back = await post(app, `${BP('cp_sign')}/publish`, { rev: 1 }, HOST);
    assert.equal(back.status, 200);
    assert.ok(deleted.includes('https://ali3d.levonis-iq.com/api/personalize/blueprints/cp_sign'));
    assert.equal((await readBlueprint(w, 'cp_sign')).status, 200);
  } finally {
    delete scope.caches;
  }
});

test('BLUEPRINT_LIMIT: `max_blueprints_per_store` counts products with a blueprint; the first draft over it and a model for it store nothing', async () => {
  const w = personalizeWorld();
  setSwitch(w.raw, { enabled: true, max_blueprints_per_store: 1 });
  await publishSign(w);
  const app = as(w, ALI);
  for (const [label, res] of [
    ['draft', await put(app, `${BP('cp_stand')}/draft`, { spec: standSpec() })],
    ['model', await put(app, `${BP('cp_stand')}/model`, { keys: [MODEL_KEY] })],
  ] as const) {
    assert.equal(res.status, 409, label);
    assert.deepEqual(await json(res).then((b) => [b.code, b.details]), ['BLUEPRINT_LIMIT', { max: 1 }], label);
  }
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_blueprints WHERE product_id = 'cp_stand'"), 0);
  assert.ok(![...w.priv.objects.keys()].some((k) => k.includes('/blueprints/')), 'no mesh stored for a store over its limit');
  // The product that has one keeps editing it.
  assert.equal((await put(app, `${BP('cp_sign')}/draft`, { spec: signSpec() })).status, 200);
  // A copy is made — without its blueprint.
  const copy = await post(app, '/api/merchant/products/cp_sign/duplicate', {});
  assert.equal(copy.status, 201);
  const copyId = (await json(copy)).product.id as string;
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM product_blueprints WHERE product_id = ?', copyId), 0);
});

// ================================================================= catalogue

test('duplicate: the copy\'s blueprint is a DRAFT with the copy\'s own option and picture ids, the model and look by reference; it publishes as it is', async () => {
  const w = personalizeWorld({ on: true });
  await publishStand(w);
  const app = as(w, ALI);
  const res = await post(app, '/api/merchant/products/cp_stand/duplicate', {});
  assert.equal(res.status, 201, await res.clone().text());
  const copy = (await json(res)).product;
  const group = copy.option_groups[0];
  assert.notEqual(group.id, 'og_size');
  const [small, medium] = group.values.map((v: { id: string }) => v.id);
  const src = row<{ draft_mesh_key: string; look: string; parts: string }>(w.raw, "SELECT draft_mesh_key, look, parts FROM product_blueprints WHERE product_id = 'cp_stand'")!;
  const bp = row<{ rev: number; state: string; spec: string; private_json: string; draft_mesh_key: string; look: string; parts: string; mesh_state: string; mesh_key: string | null }>(
    w.raw,
    'SELECT rev, state, spec, private_json, draft_mesh_key, look, parts, mesh_state, mesh_key FROM product_blueprints WHERE product_id = ?',
    copy.id
  )!;
  assert.deepEqual([bp.rev, bp.state, bp.mesh_state, bp.mesh_key], [1, 'draft', 'ready', null]);
  assert.deepEqual([bp.draft_mesh_key, bp.look, bp.parts], [src.draft_mesh_key, src.look, src.parts], 'never uploaded again');
  const spec = JSON.parse(bp.spec);
  assert.equal(spec.axes.size.group, group.id);
  assert.deepEqual(Object.keys(spec.axes.size.values).sort(), [small, medium].sort());
  assert.equal(spec.axes.size.values[medium].recommended, true);
  assert.match(bp.private_json, new RegExp(PRIVATE_NOTE), 'the merchant\'s own notes come along');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM blueprint_part_refs WHERE product_id = ? AND rev = 1', copy.id), 2);
  // The builder sees it as a draft of its own, and it publishes with no new upload.
  const state = await json(await get(app, BP(copy.id)));
  assert.equal(state.draft.rev, 1);
  assert.deepEqual(state.warnings.filter((x: string) => x.startsWith('NEEDS_')), []);
  assert.equal((await post(app, `${BP(copy.id)}/publish`, { rev: 1 })).status, 200);
  const published = row<{ mesh_key: string; id: string }>(w.raw, "SELECT id, mesh_key FROM product_blueprints WHERE product_id = ? AND state = 'live'", copy.id)!;
  assert.match(published.mesh_key, new RegExp(`^merchants/ali/public/bp/${published.id}-r1-[0-9a-f]{12}\\.lvm\\.gz$`));
});

test('duplicate: a part\'s facts are copied WITHOUT their Levonis source, each option line moved to the copy\'s own value', async () => {
  const w = personalizeWorld({ on: true });
  w.raw.exec(`
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, price_iqd, publish_state, variant_mode, track_stock, stock, part_spec) VALUES
      ('cp_magkit', 'm_ali', 's_ali', 'magnet-kit', 'Magnet kit', 1000, 'hidden', 'variants', 1, 0,
       '{"part_kind":"magnet","part_shape":"round","diameter_mm":"10","height_mm":"3","source":"levonis:lv_mag","variant_specs":"ov_d15: diameter_mm=15"}');
    INSERT INTO community_product_options (id, product_id, store_id, name, position) VALUES ('og_d', 'cp_magkit', 's_ali', 'Size', 0);
    INSERT INTO community_product_option_values (id, option_id, product_id, name, position) VALUES
      ('ov_d10', 'og_d', 'cp_magkit', '10 mm', 0), ('ov_d15', 'og_d', 'cp_magkit', '15 mm', 1);
    INSERT INTO community_product_variants (id, product_id, store_id, value1_id, price_iqd, stock, position) VALUES
      ('pv_d10', 'cp_magkit', 's_ali', 'ov_d10', NULL, 5, 0), ('pv_d15', 'cp_magkit', 's_ali', 'ov_d15', 1500, 5, 1);
  `);
  const res = await post(as(w, ALI), '/api/merchant/products/cp_magkit/duplicate', {});
  assert.equal(res.status, 201, await res.clone().text());
  const copy = (await json(res)).product;
  const ids = copy.option_groups[0].values.map((v: { id: string }) => v.id) as string[];
  assert.ok(!ids.includes('ov_d15'));
  const facts = readPartSpec(copy.part_spec, ids)!;
  assert.equal(facts.source, undefined, 'the copy is the merchant\'s own part — «from Levonis» stays with the original');
  assert.deepEqual({ kind: facts.kind, d: facts.diameter_mm, variants: facts.variants }, { kind: 'magnet', d: 10, variants: { [ids[1]]: { diameter_mm: 15 } } });
  const stored = JSON.parse(row<{ part_spec: string }>(w.raw, 'SELECT part_spec FROM community_products WHERE id = ?', copy.id)!.part_spec);
  assert.equal(stored.source, undefined);
  assert.deepEqual(copy.part_spec, stored);
  // The original keeps its source.
  assert.match(row<{ part_spec: string }>(w.raw, "SELECT part_spec FROM community_products WHERE id = 'cp_magkit'")!.part_spec, /levonis:lv_mag/);
});

test('the write gate: an option the LIVE revision annotates stays (BLUEPRINT_AXIS_IN_USE); new values are welcome; paused, anything goes', async () => {
  const w = personalizeWorld({ on: true });
  await publishStand(w);
  const app = as(w, ALI);
  const model = (values: Array<{ ref: string; name: string }>, groupRef = 'og_size') => ({
    variant_model: {
      groups: [{ ref: groupRef, name: 'Size', values }],
      variants: values.map((v, i) => ({ values: [v.ref], stock: 5, ...(i === 1 ? { price_iqd: 23000 } : {}) })),
    },
  });
  const dropM = await patch(app, '/api/merchant/products/cp_stand', model([{ ref: 'ov_s', name: 'Small' }]));
  assert.equal(dropM.status, 409);
  assert.deepEqual(await json(dropM).then((b) => [b.code, b.details]), ['BLUEPRINT_AXIS_IN_USE', { group: 'og_size', value: 'ov_m' }]);
  const newGroup = await patch(app, '/api/merchant/products/cp_stand', model([{ ref: 's2', name: 'Small' }, { ref: 'm2', name: 'Medium' }], 'size2'));
  assert.equal(newGroup.status, 409);
  assert.deepEqual((await json(newGroup)).details, { group: 'og_size' });
  const grow = await patch(app, '/api/merchant/products/cp_stand', model([{ ref: 'ov_s', name: 'Small' }, { ref: 'ov_m', name: 'Medium' }, { ref: 'l_new', name: 'Large' }]));
  assert.equal(grow.status, 200, await grow.clone().text());
  // The studio does not offer the new value until a revision annotates it.
  const pub = (await json(await readBlueprint(w, 'cp_stand'))).blueprint;
  assert.deepEqual(pub.variants.map((v: { id: string }) => v.id), ['pv_s', 'pv_m']);
  // Paused: the options are the merchant's again.
  assert.equal((await post(app, `${BP('cp_stand')}/pause`, {})).status, 200);
  assert.equal((await patch(app, '/api/merchant/products/cp_stand', model([{ ref: 'ov_s', name: 'Small' }]))).status, 200);
});

test('a part a LIVE revision builds in is not deleted (PART_IN_USE {products}), alone or in bulk — archived, yes; after a pause it goes', async () => {
  const w = personalizeWorld({ on: true });
  await publishStand(w);
  const app = as(w, ALI);
  const refused = await del(app, '/api/merchant/products/cp_magnet');
  assert.equal(refused.status, 409);
  assert.deepEqual(await json(refused).then((b) => [b.code, b.details]), ['PART_IN_USE', { products: ['cp_stand'] }]);
  const bulk = await json(await post(app, '/api/merchant/products/bulk', { action: 'delete', ids: ['cp_magnet', 'cp_bigmag'] }));
  assert.deepEqual(bulk.results, [{ id: 'cp_magnet', ok: false, code: 'PART_IN_USE' }, { id: 'cp_bigmag', ok: true }]);
  assert.deepEqual(all(w.raw, "SELECT id FROM community_products WHERE id IN ('cp_magnet', 'cp_bigmag')"), [{ id: 'cp_magnet' }]);
  // A publish landing between the bulk's check and its write: the statement's own fence keeps the part.
  w.raw.exec(`
    INSERT INTO product_blueprints (id, product_id, store_id, merchant_id, rev, state, spec, created_at, updated_at)
      VALUES ('bp_plain', 'cp_plain', 's_ali', 'm_ali', 1, 'draft', '{"v":1}', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
    INSERT INTO blueprint_part_refs (product_id, rev, slot_key, option_key, part_product_id) VALUES ('cp_plain', 1, 'light', 'rgb', 'cp_led');
  `);
  const racing = failingD1(w.raw);
  racing.failing.beforeBatch = (stmts) => {
    if (!stmts.some((s) => /DELETE FROM community_products/.test(s.sql))) return;
    w.raw.exec("UPDATE product_blueprints SET state = 'live' WHERE id = 'bp_plain'");
    racing.failing.beforeBatch = null;
  };
  const raced = await json(await post(as(w, ALI, { db: racing.db }), '/api/merchant/products/bulk', { action: 'delete', ids: ['cp_led'] }));
  assert.deepEqual(raced.results, [{ id: 'cp_led', ok: false, code: 'PART_IN_USE' }]);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM community_products WHERE id = 'cp_led'"), 1);
  // Archiving it is allowed: the studio shows it sold out.
  const archived = await json(await post(app, '/api/merchant/products/bulk', { action: 'archive', ids: ['cp_magnet'] }));
  assert.deepEqual(archived.results, [{ id: 'cp_magnet', ok: true }]);
  const option = (await json(await readBlueprint(w, 'cp_stand'))).blueprint.slot_options.magnet[0];
  assert.deepEqual([option.key, option.in_stock], ['m10', false]);
  // Paused, the part is the merchant's to delete; its refs go with it.
  assert.equal((await post(app, `${BP('cp_stand')}/pause`, {})).status, 200);
  assert.equal((await del(app, '/api/merchant/products/cp_magnet')).status, 200);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM blueprint_part_refs WHERE part_product_id = 'cp_magnet'"), 0);
});

test('the parts doors (from Levonis, refresh) are dark with the builder, and open with it', async () => {
  const w = personalizeWorld();
  for (const path of ['/api/merchant/parts/from-levonis', '/api/merchant/parts/cp_magnet/refresh']) {
    const res = await post(as(w, ALI), path, { product_id: 'lv_mag' });
    assert.equal(res.status, 404, path);
    assert.equal(await code(res), 'PERSONALIZATION_UNAVAILABLE', path);
  }
  setSwitch(w.raw, { pilot_store_ids: ['s_ali'] });
  const open = await post(as(w, ALI), '/api/merchant/parts/cp_magnet/refresh', {});
  assert.notEqual(await code(open), 'PERSONALIZATION_UNAVAILABLE', 'past the switch: the door answers for the part itself');
  assert.equal(await code(await post(as(w, ZAIN), '/api/merchant/parts/from-levonis', { product_id: 'lv_mag' })), 'PERSONALIZATION_UNAVAILABLE');
});

// ==================================================================== cost

test('the public blueprint read costs TWO D1 waves (a guest and a member); the status ONE; a mint three (four for equal choices); a design read three', async () => {
  const w = personalizeWorld({ on: true });
  await publishStand(w);
  await publishSign(w);
  const { waves, db } = wavesD1(w.raw);
  const within = (ceiling: number, label: string) =>
    assert.ok(waves.counts.waves <= ceiling, `${label}: ${waves.counts.waves} waves (ceiling ${ceiling}) — ${JSON.stringify(waves.counts.sqls, null, 1)}`);
  for (const who of [null, BUYER] as const) {
    const app = as(w, who, { db });
    assert.equal((await get(app, '/api/personalize/blueprints/cp_stand')).status, 200, 'warm the rate limiter');
    waves.reset();
    assert.equal((await get(app, '/api/personalize/blueprints/cp_stand')).status, 200);
    within(2, `read as ${who?.id ?? 'guest'}`);
    waves.reset();
    assert.equal((await get(app, '/api/personalize/status')).status, 200);
    within(1, `status as ${who?.id ?? 'guest'}`);
  }
  const app = as(w, BUYER, { db });
  const pub = (await json(await get(app, '/api/personalize/blueprints/cp_sign'))).blueprint;
  const design = { ...defaultConfig(pub), variant: 'pv_sl', texts: { name: { value: ['HOPE'], style: 'elegant' } } };
  assert.equal((await post(app, '/api/personalize/configs', { product_id: 'cp_sign', configuration: { ...design, notes: 'warm the limiter' } })).status, 201);
  waves.reset();
  const minted = await post(app, '/api/personalize/configs', { product_id: 'cp_sign', configuration: design });
  assert.equal(minted.status, 201);
  within(3, 'a new design');
  waves.reset();
  assert.equal((await post(app, '/api/personalize/configs', { product_id: 'cp_sign', configuration: design })).status, 200);
  within(4, 'the same choices again');
  waves.reset();
  assert.equal((await get(app, `/api/personalize/configs/${(await json(minted)).config_id}`)).status, 200);
  within(3, 'a design read');
});

test('the builder\'s own view: its private notes and part names, the studio preview through its own mesh door, suggestions', async () => {
  const w = personalizeWorld({ on: true });
  await publishStand(w);
  const app = as(w, ALI);
  await put(app, `${BP('cp_stand')}/draft`, { spec: standSpec() });
  const res = await get(app, BP('cp_stand'));
  const body = await json(res);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.match(body.draft.spec.private.notes, new RegExp(PRIVATE_NOTE));
  assert.deepEqual(body.draft.spec.slots[0].accepts, { shape: 'round', diameter_mm: { min: 8, max: 12 } }, 'the fit rule is the merchant\'s to see');
  assert.equal(body.preview.mesh.url, '/api/merchant/products/cp_stand/blueprint/mesh?rev=2', 'the preview reads the draft through the owner\'s door');
  assert.equal(body.preview.mesh.triangles, 24);
  assert.ok(!JSON.stringify(body.preview).includes(PRIVATE_NOTE), 'the preview is what a customer would get');
  assert.ok(body.suggestions.grams.ov_s < body.suggestions.grams.ov_m, JSON.stringify(body.suggestions.grams));
  // Nobody else reads any of it.
  for (const who of [ZAIN, BUYER, BOSS]) assert.equal((await get(as(w, who), BP('cp_stand'))).status, 404, who.id);
});

// ====================================================================== UI

test('the catalogue editor puts a lone PART_SPEC_INVALID {path} on that field (parts.tsx `readRefusal`)', () => {
  const en: Loc = (_ar, e) => e;
  const named = readRefusal(new ApiError(400, 'A part fact is not valid — check the highlighted field.', 'PART_SPEC_INVALID', { path: 'part_spec.diameter_mm' }), en, 'Could not save');
  assert.deepEqual(Object.keys(named.fields), ['part_spec.diameter_mm']);
  assert.equal(named.message, '', 'the field says it; no second sentence');
  assert.ok(named.fields['part_spec.diameter_mm'].length > 3);
  const bare = readRefusal(new ApiError(400, 'x', 'PART_SPEC_INVALID'), en, 'Could not save');
  assert.deepEqual(Object.keys(bare.fields), ['part_spec']);
});
