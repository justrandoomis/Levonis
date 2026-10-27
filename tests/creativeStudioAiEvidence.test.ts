/**
 * WHAT AN AI REQUEST IS ALLOWED TO CLAIM, AND WHAT THE MODEL IS SHOWN
 * (spec §9, §10, §11, §13, §17; acceptance 6, 12; worker/lib/creative/evidence.ts,
 * prompts.ts, files.ts, worker/routes/adminCreativeStudio.ts).
 *
 *   - offer wording needs a live public offer in the store NOW, not in the
 *     design's stored snapshot (an ended offer is no evidence);
 *   - arrival / back-in-stock flags come from the catalogue watch's events,
 *     by the same rule as «شنو أنشر اليوم؟»;
 *   - pointing marks reach the model with their geometry, a selected group
 *     stands for its members, and the variants offered are the template's own;
 *   - compose leads with the owner's visual priority;
 *   - a JPEG turned a quarter by EXIF is recorded at the size it is drawn at.
 *
 * The provider is a stub; model ids are fake.
 *
 * Run: node --import tsx --test tests/creativeStudioAiEvidence.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, json as body, post, put } from './fixtures/app';
import { BASE, MODEL_A, SECRET_KEY, message, modelsPage, stubProvider, studioApp, studioDb, type ProviderHandler } from './fixtures/creativeStudio';
import { buildFromTemplate } from '../packages/creativeDoc/src/layout';
import { defaultBrandKit } from '../packages/creativeDoc/src/brand';
import { FORMATS, layerBox, type Layer } from '../packages/creativeDoc/src/schema';
import type { ProductSnapshot } from '../packages/creativeDoc/src/snapshot';
import { NO_EVIDENCE } from '../packages/creativeDoc/src/templates';
import { approximateMeasurer } from '../packages/creativeDoc/src/text';
import { storeEvidence, watchEvidence } from '../worker/lib/creative/evidence';
import { jpegOrientation, sniffStudioImage } from '../worker/lib/creative/files';
import { layerForModel } from '../worker/lib/creative/prompts';
import { TEMPLATES } from '../packages/creativeDoc/src/templates';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const DAY = 86_400_000;

function offerOn(raw: DatabaseSync, productId: string) {
  raw
    .prepare(
      `INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,offer_price_mode,offer_price_iqd,discount_percent,discount_iqd,plus_price_iqd,locked_preview,active)
       VALUES ('product',?,?,NULL,NULL,'[]','discount_iqd',NULL,NULL,50000,NULL,1,1)`
    )
    .run(productId, `ofw_${productId}`);
}

/** The store with a live public offer on the A1, a live snapshot of it, and a product_hero design bound to that snapshot. */
async function world() {
  const raw = await studioDb(true);
  offerOn(raw, 'p_print');
  const app = studioApp(raw, OWNER, { ANTHROPIC_API_KEY: SECRET_KEY });
  let answer: ProviderHandler = () => message({});
  const stub = stubProvider((call) => (call.url.includes('/v1/models') ? modelsPage() : answer(call)));
  restore = stub.restore;
  assert.equal((await put(app, `${BASE}/provider/settings`, { model: MODEL_A })).status, 200);
  const snapRes = await post(app, `${BASE}/snapshots`, { product_id: 'p_print', variant_key: null });
  assert.equal(snapRes.status, 201);
  const { success: _s, ...snap } = await body(snapRes);
  const snapshot = snap as unknown as ProductSnapshot;
  assert.notEqual(snapshot.data.price.offer, null, 'the offer is live when the design is made');
  const img = snapshot.data.images.find((i) => i.same_origin && i.width && i.height)!;
  const built = buildFromTemplate({
    template: 'product_hero', variant: 'product_first', format: FORMATS.square, locale: 'ar', objective: 'sell', density: 'brief',
    brand: defaultBrandKit(), brandVersion: null, products: [{ slot: 'main', snapshot, image: { url: img.url, width: img.width!, height: img.height! } }],
    service: null, copy: { headline: 'طابعة دقيقة لمشاريعك', cta: 'اطلبها' }, evidence: NO_EVIDENCE, family: null,
    logo: { width: 1254, height: 1254 }, backgroundNatural: null, slide: null, caption: '', alt_text: '', measure: approximateMeasurer,
  }).doc;
  const created = await post(app, `${BASE}/documents`, { title: 'A1', content: built, kind: 'post', idempotency_key: 'create-doc-evid-01' });
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const doc = (await body(created)).document as { id: string; version: number };
  return { raw, app, stub, snapshot, built, doc, set: (h: ProviderHandler) => (answer = h) };
}

const editPatch = (docId: string, ops: unknown[], targets: string[]) => ({
  schema_version: 1, document_id: docId, base_document_version: 1, intent: 'edit', target_layer_ids: targets, operations: ops, reason: 'r', warnings: [], clarification: '',
});

/** The JSON inside one tagged block of the last message sent. */
function sentBlock(stub: ReturnType<typeof stubProvider>, tag: string): Record<string, unknown> {
  const sent = stub.messages().at(-1)!.body as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
  const text = sent.messages[0]!.content.find((b) => b.type === 'text')!.text!;
  const m = text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  assert.ok(m, `<${tag}> was sent`);
  return JSON.parse(m![1]!) as Record<string, unknown>;
}
const sentText = (stub: ReturnType<typeof stubProvider>) => JSON.stringify(stub.messages().at(-1)!.body);

test('worker-1: /ai/edit takes offer evidence from the store at request time — once the offer has ended, an AI discount claim is refused', async () => {
  const { raw, app, doc, set } = await world();
  set(() => message(editPatch(doc.id, [{ op: 'set_text', layer_id: 'headline', value: 'خصم لفترة محدودة على الطابعة' }], ['headline'])));
  const edit = (key: string) => post(app, `${BASE}/ai/edit`, { document_id: doc.id, base_version: 1, instruction: 'اذكر العرض في العنوان', scope_ids: ['headline'], annotations: [], idempotency_key: key });
  // While the offer is live, the wording is supported.
  const live = await edit('edit-offer-live-01');
  assert.equal(live.status, 200, JSON.stringify(await live.clone().json()));
  // The offer ends; the design's stored snapshot still says it is on.
  raw.exec(`UPDATE offer_windows SET active = 0 WHERE id = 'ofw_p_print'`);
  const ended = await edit('edit-offer-ended-01');
  assert.equal(ended.status, 502);
  const b = await body(ended);
  assert.equal(b.code, 'INVALID_OUTPUT');
  assert.equal(b.details.reason, 'text_refused');
});

test('worker-1: compose from a live snapshot taken while an offer ran — after it ends, offer wording is refused', async () => {
  const { raw, app, snapshot, set } = await world();
  raw.exec(`UPDATE offer_windows SET active = 0 WHERE id = 'ofw_p_print'`);
  set(() => message({
    proposals: [
      { variant: 'product_first', reason: 'r', headline: 'طابعة دقيقة لمشاريعك', subhead: '', features: ['سهلة'], cta: 'اطلبها', caption: '', alt_text: '' },
      { variant: 'feature_first', reason: 'r', headline: 'خصم لفترة محدودة', subhead: '', features: [], cta: 'اطلبها', caption: '', alt_text: '' },
    ],
    warnings: [],
    missing: [],
  }));
  const res = await post(app, `${BASE}/ai/compose`, {
    snapshot_id: snapshot.id, claim_id: null, objective: 'sell', priority: 'product', density: 'brief', template: 'product_hero', family: null,
    variants: ['product_first', 'feature_first'], locale: 'ar', brief: '', idempotency_key: 'compose-offer-ended-01',
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const b = await body(res);
  assert.deepEqual(b.proposals.map((p: { variant: string }) => p.variant), ['product_first']);
  assert.equal(b.rejected, 1);
});

test('spec-10: /ai/compose leads with the owner\'s visual priority (variantsFor gets the priority)', async () => {
  const { app, stub, snapshot, set } = await world();
  set(() => message({ proposals: [{ variant: 'feature_first', reason: 'r', headline: 'طابعة دقيقة', subhead: '', features: ['سهلة'], cta: 'اطلبها', caption: '', alt_text: '' }], warnings: [], missing: [] }));
  const res = await post(app, `${BASE}/ai/compose`, {
    snapshot_id: snapshot.id, claim_id: null, objective: 'sell', priority: 'feature', density: 'brief', template: 'product_hero', family: null,
    variants: [], locale: 'ar', brief: '', idempotency_key: 'compose-priority-01',
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.match(sentText(stub), /layout variants: feature_first, /);
});

test('editor-9 / model-9 / spec-12: the edit prompt offers the template\'s own variants, expands a selected group to its members, and carries each mark\'s geometry', async () => {
  const { app, stub, built, doc, set } = await world();
  set(() => message(editPatch(doc.id, [], ['cta_group'])));
  const price = layerBox(built.layers.find((l) => l.id === 'price')!, built.layers)!;
  const start = { x: price.x + price.width / 2 + 0.4, y: price.y + price.height / 2 - 0.4 };
  const empty = { x: 3.2, y: 1076.6 };
  const annotations = [
    { id: 'pin1', kind: 'pin', x: 540.4, y: 300.6, width: 0, height: 0, note: 'هنا', layer_ids: [] },
    { id: 'box1', kind: 'box', x: 10.2, y: 20.7, width: 300.4, height: 120.5, note: 'هذه المنطقة مزدحمة', layer_ids: [] },
    { id: 'arr1', kind: 'arrow', x: start.x, y: start.y, width: empty.x - start.x, height: empty.y - start.y, note: 'انقل السعر هنا', layer_ids: ['price'] },
  ];
  const res = await post(app, `${BASE}/ai/edit`, { document_id: doc.id, base_version: 1, instruction: 'غيّر نص الزر', scope_ids: ['cta_group'], annotations, idempotency_key: 'edit-prompt-geom-01' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

  // editor-9: exactly the variants product_hero has — not a fixed list.
  assert.deepEqual(sentBlock(stub, 'allowed').variants, Object.keys(TEMPLATES.product_hero.variants));
  // model-9: the chip's words live in a child of the group the owner tapped.
  assert.match(sentText(stub), /Only these selected layers may be targets: cta_group, cta_chip, cta\./);
  const shown = (sentBlock(stub, 'document').layers as Array<{ id: string }>).map((l) => l.id);
  assert.ok(shown.includes('cta') && shown.includes('cta_chip'), 'the members are shown');
  // spec-12: rounded geometry per kind; the arrow's ends with the layers under each.
  const marks = sentBlock(stub, 'owner_request').pointed_at as Array<Record<string, unknown>>;
  assert.deepEqual(marks[0], { id: 'pin1', kind: 'pin', note: 'هنا', layer_ids: [], x: 540, y: 301 });
  assert.deepEqual(marks[1], { id: 'box1', kind: 'box', note: 'هذه المنطقة مزدحمة', layer_ids: [], x: 10, y: 21, width: 300, height: 121 });
  assert.equal(marks[2]!.kind, 'arrow');
  assert.deepEqual(marks[2]!.from, { x: Math.round(start.x), y: Math.round(start.y) });
  assert.deepEqual(marks[2]!.to, { x: 3, y: 1077 });
  assert.ok((marks[2]!.from_layer_ids as string[]).includes('price'), 'the price is under the start');
  assert.deepEqual(marks[2]!.to_layer_ids, [], 'the end is over empty space');
  assert.match(sentText(stub), /pointed_at are in document pixels/);
});

test('evidence: arrival and back-in-stock come from the watch\'s recent events, by the same rule as the opportunities (read-only)', async () => {
  const raw = await studioDb(true);
  const db = asD1(raw);
  const now = Date.now();
  const at = (ms: number) => new Date(ms).toISOString();
  const event = (id: string, product: string, kind: string, ms: number) =>
    raw.prepare(`INSERT INTO creative_events (id, product_id, kind, detected_at, evidence_json) VALUES (?, ?, ?, ?, '{}')`).run(id, product, kind, at(ms));
  assert.deepEqual(await watchEvidence(db, ['p_print'], now), { arrival: false, backInStock: false }, 'no event, no evidence');
  event('e1', 'p_print', 'arrival', now - 2 * DAY);
  event('e2', 'p_print', 'back_in_stock', now - DAY);
  assert.deepEqual(await watchEvidence(db, ['p_print'], now), { arrival: true, backInStock: true });
  // Another product's events are not this product's evidence.
  assert.deepEqual(await watchEvidence(db, ['p_pre'], now), { arrival: false, backInStock: false });
  // Back in stock must still hold: the pre-order product is not available today.
  event('e3', 'p_pre', 'back_in_stock', now - DAY);
  event('e4', 'p_pre', 'arrival', now - DAY);
  assert.deepEqual(await watchEvidence(db, ['p_pre'], now), { arrival: true, backInStock: false });
  // Older than 14 days is no longer evidence; an unlisted product never is.
  assert.deepEqual(await watchEvidence(db, ['p_print'], now + 20 * DAY), { arrival: false, backInStock: false });
  event('e5', 'p_gone', 'arrival', now - DAY);
  assert.deepEqual(await watchEvidence(db, ['p_gone'], now), { arrival: false, backInStock: false });
  // Through storeEvidence: only a LIVE snapshot names a product; a manual one proves nothing.
  const data = { product_id: 'p_print', variant_key: null, price: { status: 'priced', amount_iqd: 1, regular_iqd: null, from: false, offer: { starts_at: null, ends_at: null }, member_price_iqd: null } };
  const live = { id: 's1', source: 'live', data, hash: 'h', fetched_at: at(now) } as unknown as ProductSnapshot;
  const manual = { ...live, source: 'manual' } as ProductSnapshot;
  assert.deepEqual(await storeEvidence(db, [live], now), { offer: false, arrival: true, backInStock: true }, 'the offer is read from the store, which has none');
  assert.deepEqual(await storeEvidence(db, [manual, null], now), { offer: false, arrival: false, backInStock: false });
  offerOn(raw, 'p_print');
  assert.equal((await storeEvidence(db, [live], now)).offer, true);
  // Read-only: the events and the catalogue are as they were.
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM creative_events').get() as { n: number }).n, 5);
});

test('the edit prompt marks a layer locked when it or any group above it is locked, and a group that holds a locked layer', () => {
  const layers = (groupLocked: boolean, chipLocked: boolean) => [
    { id: 'cta_group', type: 'group', role: 'cta', name: 'g', parent: null, x: 0, y: 0, rotation: 0, opacity: 1, visible: true, locked: groupLocked },
    { id: 'cta_chip', type: 'shape', role: 'decor', name: 'chip', parent: 'cta_group', x: 100, y: 900, width: 300, height: 90, rotation: 0, opacity: 1, visible: true, locked: chipLocked, fill: '#2f6f5e' },
    { id: 'cta', type: 'text', role: 'cta', name: 'cta', parent: 'cta_group', x: 120, y: 910, width: 260, height: 70, rotation: 0, opacity: 1, visible: true, locked: false,
      text: 'اطلبها', source: { kind: 'free' }, font: { family: 'plex-arabic', weight: 700, size: 40, lineHeight: 1.2 }, minSize: 30, maxLines: 1, color: '#ffffff', align: 'center', direction: 'rtl' },
    { id: 'headline', type: 'text', role: 'headline', name: 'h', parent: null, x: 100, y: 100, width: 800, height: 120, rotation: 0, opacity: 1, visible: true, locked: false,
      text: 'عنوان', source: { kind: 'free' }, font: { family: 'plex-arabic', weight: 700, size: 60, lineHeight: 1.2 }, minSize: 40, maxLines: 2, color: '#ffffff', align: 'start', direction: 'rtl' },
  ] as unknown as Layer[];
  const view = (all: Layer[]) => Object.fromEntries(all.map((l) => [l.id, layerForModel(l, all)]));
  const groupLocked = view(layers(true, false));
  assert.equal(groupLocked.cta!.locked, true, 'a child of a locked group is locked');
  assert.equal(groupLocked.cta_chip!.locked, true);
  assert.equal(groupLocked.headline!.locked, false);
  assert.equal(groupLocked.cta_group!.contains_locked, false);
  const chipLocked = view(layers(false, true));
  assert.equal(chipLocked.cta_group!.locked, false);
  assert.equal(chipLocked.cta_group!.contains_locked, true, 'an operation on the group would be refused');
  assert.equal(chipLocked.cta!.locked, false);
});

/** A tiny JPEG: SOI, an EXIF APP1 with one Orientation entry (little- or big-endian), a 400×300 SOF0, EOI. */
function jpeg(orientation: number | null, endian: 'II' | 'MM' = 'II'): Uint8Array {
  const u16 = (n: number) => (endian === 'II' ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (endian === 'II' ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const tiff = orientation === null ? [] : [...Buffer.from(endian), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const app1 = tiff.length ? [0xff, 0xe1, 0, 2 + 6 + tiff.length, ...Buffer.from('Exif\0\0', 'binary'), ...tiff] : [];
  const sof = [0xff, 0xc0, 0, 17, 8, 300 >> 8, 300 & 0xff, 400 >> 8, 400 & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

test('editor-8: a studio JPEG with EXIF orientation 5–8 is recorded with width and height swapped; 1–4 as stored', () => {
  assert.equal(jpegOrientation(jpeg(6)), 6);
  assert.equal(jpegOrientation(jpeg(8, 'MM')), 8);
  assert.equal(jpegOrientation(jpeg(null)), null);
  for (const [o, endian, w, h] of [[6, 'II', 300, 400], [8, 'MM', 300, 400], [5, 'II', 300, 400], [7, 'MM', 300, 400], [1, 'II', 400, 300], [3, 'MM', 400, 300]] as const) {
    const s = sniffStudioImage(jpeg(o, endian));
    assert.deepEqual([s.mime, s.width, s.height], ['image/jpeg', w, h], `orientation ${o} (${endian})`);
  }
  const plain = sniffStudioImage(jpeg(null));
  assert.deepEqual([plain.width, plain.height], [400, 300]);
});

