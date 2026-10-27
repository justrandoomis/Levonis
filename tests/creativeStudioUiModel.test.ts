/**
 * THE EDITOR'S RULES, WITHOUT A BROWSER — src/components/creativeStudio/
 * editorModel.ts, autosave.ts, editorData.ts and client.ts.
 *
 *  - history: undo/redo of whole documents, 60 steps deep;
 *  - a gesture becomes bounded operations: a picture only ever scales with
 *    ONE factor (the ratio of the drawn box never changes), a drag is
 *    `nudge_layer` of the top-level selection, snapping lands on the safe
 *    area / centre lines / other layers;
 *  - text is drawn in OUR wrapped lines, aligned by the DOCUMENT's direction,
 *    and the frame handed to the engine is never narrower than a line;
 *  - autosave says «saved» only after the server's answer, stops on a version
 *    conflict, reports offline, and saves an applied AI answer with its job;
 *  - the local recovery draft holds content, base version and time — nothing
 *    else;
 *  - only the bound variant's own same-origin pictures and approved assets
 *    are placeable;
 *  - a response body is decoded strictly (spread or named DTO, never a guess).
 *
 * Run: node --import tsx --test tests/creativeStudioUiModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../packages/creativeDoc/src/brand';
import { buildFromTemplate } from '../packages/creativeDoc/src/layout';
import { FORMATS, layerBox, type CreativeDocument, type ImageLayer, type TextLayer } from '../packages/creativeDoc/src/schema';
import type { ProductSnapshot } from '../packages/creativeDoc/src/snapshot';
import { NO_EVIDENCE } from '../packages/creativeDoc/src/templates';
import { approximateMeasurer } from '../packages/creativeDoc/src/text';
import type { AssetDto, BrandDto } from '../packages/creativeDoc/src/api';
import {
  HISTORY_DEPTH, commit, draftWorthOffering, dragOps, exportFileName, historyOf, marqueeHits, nudgeOps, parseDraft, redo, runHumanOps,
  selectableId, serializeDraft, snapMove, snapTargets, textFrame, topLevel, transformOps, undo,
} from '../src/components/creativeStudio/editorModel';
import { Autosave, type SaveState } from '../src/components/creativeStudio/autosave';
import { allowedAssets, evidenceFor, usesTestData, type EditorData } from '../src/components/creativeStudio/editorData';
import { list, one } from '../src/components/creativeStudio/client';
import { ApiError } from '../src/lib/api';
import { SITE_LOGO_VERSIONED_URL } from '../src/lib/siteLogo';
import { urlForRef } from '../src/components/creativeStudio/media';

const kit = defaultBrandKit();

/** MARKED test data: a `test` snapshot, a TEST name, a fixture price — never a Levonis price. */
function snap(): ProductSnapshot {
  return {
    id: 'snap_test_0001', hash: 'x'.repeat(64), source: 'test', fetched_at: '2026-10-27T09:00:00Z',
    data: {
      product_id: 'p_test_a1', slug: 'test-a1', path: '/product/test-a1', variant_key: 'combo',
      variant_label: { ar: 'كومبو (تجريبي)', en: 'Combo (test)', ckb: 'کۆمبۆ (تاقیکاری)' },
      name: { ar: 'طابعة Bambu Lab A1 Combo مع 4 بكرات (AMS lite)', en: 'TEST Bambu Lab A1 Combo', ckb: 'چاپکەری Bambu Lab A1 Combo تاقیکاری' },
      brand: null, category: null, sku: 'TEST-A1C', short_description: { ar: '', en: '', ckb: '' }, specs: [], contents: [],
      price: { status: 'priced', amount_iqd: 1250000, regular_iqd: null, from: false, offer: null, member_price_iqd: null },
      availability: 'available', sale_types: ['direct_sale'],
      images: [
        { url: '/files/products/test/a1-front.webp', width: 1200, height: 800, alt: '', primary: true, variant_key: 'combo', same_origin: true },
        { url: '/files/products/test/a1-solo.webp', width: 1000, height: 800, alt: '', primary: false, variant_key: 'solo', same_origin: true },
        { url: 'https://cdn.example.com/a1.jpg', width: 1200, height: 800, alt: '', primary: false, variant_key: 'combo', same_origin: false },
      ],
      source_updated_at: null,
    },
  };
}

function built(): CreativeDocument {
  const s = snap();
  return buildFromTemplate({
    template: 'product_hero', variant: 'product_first', format: FORMATS.square, locale: 'ar', objective: 'sell', density: 'brief', brand: kit, brandVersion: null,
    products: [{ slot: 'main', snapshot: s, image: { url: s.data.images[0].url, width: 1200, height: 800 } }], service: null,
    copy: { headline: 'طباعة ثلاثية الأبعاد بدقة مذهلة', cta: 'اطلبها الآن' }, evidence: NO_EVIDENCE, family: null, logo: { width: 1254, height: 1254 },
    backgroundNatural: null, slide: null, caption: '', alt_text: '', measure: approximateMeasurer,
  }).doc;
}

const brandDto: BrandDto = { migrated: true, version: null, status: 'default', kit, site_logo: { width: 1254, height: 1254 } };
const data = (assets: AssetDto[] = []): EditorData => ({ brand: brandDto, snapshots: { main: snap() }, claims: [], assets, opportunities: [] });

test('history: undo and redo whole documents, and the oldest step falls off past 60', () => {
  const a = built();
  let h = historyOf(a);
  const docs: CreativeDocument[] = [];
  for (let i = 0; i < HISTORY_DEPTH + 5; i++) {
    const d = { ...a, caption: `step ${i}` };
    docs.push(d);
    h = commit(h, d);
  }
  assert.equal(h.past.length, HISTORY_DEPTH);
  h = undo(h);
  assert.equal(h.present.caption, `step ${HISTORY_DEPTH + 3}`);
  h = redo(h);
  assert.equal(h.present, docs[docs.length - 1]);
  assert.equal(commit(h, h.present), h, 'committing the same document is not a step');
  const branched = commit(undo(h), { ...a, caption: 'branch' });
  assert.equal(branched.future.length, 0, 'a new edit drops the redo branch');
});

test('a corner drag on the product scales it with ONE factor: the drawn ratio is unchanged and it lands where the gesture left it', () => {
  const doc = built();
  const p = doc.layers.find((l) => l.id === 'product') as ImageLayer;
  const before = layerBox(p)!;
  // A skewed gesture (1.3 wide, 1.25 tall) still yields one uniform factor.
  const after = { x: before.x - 10, y: before.y - 20, width: before.width * 1.3, height: before.height * 1.25, rotation: 0 };
  const ops = transformOps(p, before, after) as Array<{ op: string; factor?: number }>;
  assert.deepEqual(ops.map((o) => o.op), ['scale_asset_uniform', 'move_layer']);
  const r = runHumanOps(doc, ops, { brand: kit, allowed: allowedAssets(doc, data()), measure: approximateMeasurer });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  const np = r.doc.layers.find((l) => l.id === 'product') as ImageLayer;
  const nb = layerBox(np)!;
  assert.ok(Math.abs(nb.width / nb.height - 1200 / 800) < 1e-9, 'the product keeps the ratio of its own picture');
  assert.ok(Math.abs(np.scale / p.scale - 1.275) < 0.001, `one factor, the mean of the gesture (${np.scale / p.scale})`);
  // A rotation of the product is refused by the same rules a Claude patch meets.
  const rot = runHumanOps(doc, transformOps(p, before, { ...before, rotation: 15 }), { brand: kit, allowed: allowedAssets(doc, data()), measure: approximateMeasurer });
  assert.ok(!rot.ok && rot.refusals[0].code === 'product_rotation');
});

test('a side drag on a text becomes resize_box + move_layer; a drag becomes nudge_layer of the top-level selection only', () => {
  const doc = built();
  const h = doc.layers.find((l) => l.id === 'headline') as TextLayer;
  const before = layerBox(h)!;
  const ops = transformOps(h, before, { x: before.x + 20, y: before.y, width: before.width - 40, height: before.height, rotation: 0 }) as Array<{ op: string }>;
  assert.deepEqual(ops.map((o) => o.op), ['resize_box', 'move_layer']);
  const group = doc.layers.find((l) => l.type === 'group');
  assert.ok(group, 'the CTA chip is a group');
  const child = doc.layers.find((l) => l.parent === group!.id)!;
  assert.equal(selectableId(doc, child.id), group!.id, 'a click on the chip selects its group');
  assert.deepEqual(topLevel(doc, [group!.id, child.id]), [group!.id]);
  const drag = dragOps(doc, [group!.id, child.id], 12, -4) as Array<{ op: string; layer_id: string }>;
  assert.deepEqual(drag, [{ op: 'nudge_layer', layer_id: group!.id, dx: 12, dy: -4 }]);
  assert.deepEqual(nudgeOps(doc, ['headline'], 'ArrowLeft', true), [{ op: 'nudge_layer', layer_id: 'headline', dx: -10, dy: 0 }]);
  assert.deepEqual(dragOps(doc, ['headline'], 0, 0), []);
});

test('snapping lands on the safe area, the centre lines and other layers — the background and locked layers are never selected by a marquee', () => {
  const doc = built();
  const targets = snapTargets(doc, ['headline']);
  assert.ok(targets.xs.includes(540) && targets.ys.includes(540), 'canvas centre lines');
  assert.ok(targets.xs.includes(doc.safe_area.left), 'safe-area edge');
  const box = { x: 100, y: 100, width: 200, height: 50 };
  const r = snapMove(box, doc.safe_area.left - 100 + 3, 0, targets, 6);
  assert.equal(r.dx, doc.safe_area.left - 100, 'the start edge snaps to the safe area');
  assert.deepEqual(r.guides.find((g) => g.axis === 'x')?.at, doc.safe_area.left);
  const hits = marqueeHits(doc, { x: 0, y: 0, width: 1080, height: 1080 });
  assert.ok(!hits.includes('background'));
  assert.ok(hits.includes('product') && hits.includes('headline'));
});

test('text is drawn in our own lines, aligned by the DOCUMENT direction, never in a frame narrower than a line', () => {
  const doc = built();
  const name = doc.layers.find((l) => l.id === 'product_name') as TextLayer;
  const latin = { ...name, text: 'Bambu Lab A1 Combo', align: 'start' as const };
  const f = textFrame(latin, 'rtl', approximateMeasurer);
  assert.equal(f.direction, 'ltr', 'the words read left to right');
  assert.equal(f.align, 'right', 'but sit on the Arabic ad’s start edge');
  const narrow = { ...name, width: 40, text: 'كلمةطويلةجدا', align: 'start' as const };
  const n = textFrame(narrow, 'rtl', approximateMeasurer);
  assert.equal(n.lines.length, 1, 'a word is never cut');
  assert.ok(n.width >= n.widest, 'the engine never gets a frame it would break the word in');
  assert.ok(Math.abs(n.x + n.width - (narrow.x + narrow.width)) < 0.001, 'an overflow grows away from the start edge');
});

test('autosave: «saved» only after the server answered, a 409 stops it, a network failure is «offline», an AI answer keeps its job', async () => {
  const doc = built();
  const states: SaveState[] = [];
  const timers: Array<() => void> = [];
  const calls: Array<{ base: number; origin: string; job: string | null }> = [];
  let answer: (base: number) => Promise<{ version: number; updated_at: string | null }> = async (base) => ({ version: base + 1, updated_at: null });
  const a = new Autosave({
    save: (_c, base, meta) => { calls.push({ base, origin: meta.origin, job: meta.job_id }); return answer(base); },
    onState: (s) => states.push(s),
    onSaved: () => undefined,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => undefined,
  }, { content: doc, version: 3 });
  const d1 = { ...doc, caption: 'one' };
  a.change(d1);
  assert.equal(a.current, 'dirty');
  assert.ok(!states.includes('saved'), 'nothing is «saved» before a request');
  timers.shift()!();
  await a.flush();
  assert.equal(a.current, 'saved');
  assert.equal(a.baseVersion, 4);
  assert.deepEqual(calls[0], { base: 3, origin: 'manual', job: null });

  answer = async () => { throw new ApiError(409, 'conflict', 'VERSION_CONFLICT'); };
  a.change({ ...doc, caption: 'two' });
  await a.flush();
  assert.equal(a.current, 'conflict');
  const before = calls.length;
  a.change({ ...doc, caption: 'three' });
  await a.flush();
  assert.equal(calls.length, before, 'a conflict is never retried on top of someone else’s work');

  a.rebase(doc, 9);
  answer = async () => { throw new ApiError(0, 'offline', 'NETWORK'); };
  a.change({ ...doc, caption: 'four' });
  await a.flush();
  assert.equal(a.current, 'offline');
  assert.equal(a.hasUnsaved, true);

  answer = async (base) => ({ version: base + 1, updated_at: null });
  const res = await a.saveAs({ ...doc, caption: 'ai' }, { origin: 'ai', job_id: 'job_1' });
  assert.equal(res?.version, 10);
  assert.deepEqual(calls[calls.length - 1], { base: 9, origin: 'ai', job: 'job_1' });
  assert.equal(a.current, 'saved');
});

test('the recovery draft holds content, base version and time — nothing else — and is offered only when newer and different', () => {
  const doc = built();
  const raw = serializeDraft(doc, 7, new Date('2026-10-27T10:00:00Z'));
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['base_version', 'content', 'saved_at']);
  assert.doesNotMatch(raw, /api[_-]?key|token|password|sk-ant/i);
  const draft = parseDraft(raw)!;
  assert.equal(draft.base_version, 7);
  assert.equal(parseDraft('{"content":1}'), null);
  assert.equal(parseDraft('not json'), null);
  const server = { version: 7, updated_at: '2026-10-27T09:00:00Z', content: { ...doc, caption: 'server' } };
  assert.equal(draftWorthOffering(draft, server), true);
  assert.equal(draftWorthOffering(draft, { ...server, updated_at: '2026-10-27T11:00:00Z' }), false, 'older than the server copy');
  assert.equal(draftWorthOffering(draft, { ...server, content: doc }), false, 'says nothing new');
});

test('only the bound variant’s own same-origin pictures and APPROVED assets can be placed; test data is flagged', () => {
  const doc = built();
  const approved: AssetDto = { id: 'asset_bg_001', kind: 'background', label: 'bg', mime: 'image/webp', width: 2000, height: 2000, bytes: 1, provenance: 'uploaded', derived_from: null, product_id: null, review: 'approved', note: '', created_at: '', url: '/api/admin/creative-studio/assets/asset_bg_001/file' };
  const pending: AssetDto = { ...approved, id: 'asset_bg_002', review: 'needs_review' };
  const logo: AssetDto = { ...approved, id: 'asset_logo_01', kind: 'logo' };
  const allowed = allowedAssets(doc, data([approved, pending, logo]));
  assert.deepEqual(allowed.products.main.map((p) => p.url), ['/files/products/test/a1-front.webp'], 'not the other variant, not the remote copy');
  assert.deepEqual(allowed.assets.map((a) => a.id), ['asset_bg_001']);
  assert.deepEqual(allowed.logos.map((l) => l.ref), ['site', 'asset_logo_01']);
  assert.equal(usesTestData(doc, data()), true);
  assert.deepEqual(evidenceFor('p_test_a1', snap(), [{ id: 'o1', kind: 'arrival', ref: 'p_test_a1', label: { ar: '', en: '', ckb: '' }, detail: '', detected_at: null }]), { arrival: true, back_in_stock: false, offer: false });
});

test('response bodies are decoded strictly: a spread or a named DTO, a list under its name, anything else is INVALID_RESPONSE', () => {
  assert.deepEqual(one<{ id: string; content: number }>({ success: true, document: { id: 'd', content: 1 } }, 'document', 'content'), { id: 'd', content: 1 });
  assert.equal(one<{ kit: number }>({ success: true, kit: 2, migrated: true }, 'brand', 'kit').kit, 2);
  assert.throws(() => one({ success: true }, 'document', 'content'), (e: unknown) => e instanceof ApiError && e.code === 'INVALID_RESPONSE');
  assert.deepEqual(list({ success: true, documents: [1] }, 'documents'), [1]);
  assert.deepEqual(list({ success: true, migrated: false }, 'documents'), [], 'an un-migrated database answers empty');
  assert.throws(() => list({ success: true }, 'documents'), (e: unknown) => e instanceof ApiError && e.code === 'INVALID_RESPONSE');
  assert.equal(exportFileName('طباعة', 4, 'png', true), 'levonis-design-v4-draft.png');
  assert.equal(exportFileName('A1 Combo launch!', 4, 'webp', false), 'levonis-a1-combo-launch-v4.webp');
});

test('the canvas asks only for same-origin pictures: the site logo by the url src/lib/siteLogo.ts decides, products by their /files path', () => {
  assert.equal(urlForRef({ kind: 'logo', ref: 'site' }), SITE_LOGO_VERSIONED_URL);
  assert.equal(urlForRef({ kind: 'product', ref: '/files/products/a.webp' }), '/files/products/a.webp');
  assert.equal(urlForRef({ kind: 'product', ref: 'https://cdn.example.com/a.webp' }), null, 'a cross-origin picture would taint the canvas');
  assert.equal(urlForRef({ kind: 'product', ref: '//cdn.example.com/a.webp' }), null);
  assert.equal(urlForRef({ kind: 'product', ref: '/files/../secret' }), null);
  assert.equal(urlForRef({ kind: 'asset', ref: 'ast_abc123' }), '/api/admin/creative-studio/assets/ast_abc123/file');
});
