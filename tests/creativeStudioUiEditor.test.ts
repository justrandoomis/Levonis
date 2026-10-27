/**
 * THE EDITOR'S REVIEW FIXES, WITHOUT A BROWSER — the rules behind the fixes
 * to the editor (src/components/creativeStudio/{editorModel,autosave,
 * editorData}.ts). The browser half (the breakpoint, the chat surviving a tab
 * switch) is in scripts/e2e-creative-studio.mjs.
 *
 *  - a recovery draft is a plain restore only onto the version it was made
 *    on; a newer server copy makes it a copy — clocks never decide;
 *  - a save whose answer was lost is adopted when the server holds it, so it
 *    is never a false «someone else changed this design»; a real conflict
 *    still is one;
 *  - an applied AI answer whose save failed keeps its origin and job until a
 *    person edits on top; a cancelled job's answer is taken back off the
 *    history, and the screen is «saved» again;
 *  - a lock on a layer, its group or anything inside it keeps it from being
 *    selected, dragged, marquee'd or deleted;
 *  - a scoped Claude request on a chip reaches the chip's words;
 *  - a re-layout to a composition the template does not have is refused, not
 *    silently laid out as its first variant (and so never «applied»);
 *  - the editor's keys never take Enter / arrows / Delete from a focused
 *    control;
 *  - a picture is never stretched: another decoded ratio is drawn contained;
 *  - bound words are drawn with the design's pinned kit, and opening a
 *    design never rewrites it.
 *
 * Run: node --import tsx --test tests/creativeStudioUiEditor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../packages/creativeDoc/src/brand';
import { buildFromTemplate } from '../packages/creativeDoc/src/layout';
import { validateEditPatch } from '../packages/creativeDoc/src/aiContracts';
import { FORMATS, type CreativeDocument } from '../packages/creativeDoc/src/schema';
import type { ProductSnapshot } from '../packages/creativeDoc/src/snapshot';
import { NO_EVIDENCE } from '../packages/creativeDoc/src/templates';
import { approximateMeasurer } from '../packages/creativeDoc/src/text';
import type { BrandDto } from '../packages/creativeDoc/src/api';
import {
  chatScope, commit, draftOffer, dropStep, historyOf, imageFit, isInteractive, keyBelongsToControl, lockedAround, marqueeHits, parseDraft, relayoutVariant, selectableId, serializeDraft, topLevel,
} from '../src/components/creativeStudio/editorModel';
import { Autosave, type SaveMeta, type SaveState } from '../src/components/creativeStudio/autosave';
import { allowedAssets, bindingContext, boundRefresh, type EditorData } from '../src/components/creativeStudio/editorData';
import { ApiError } from '../src/lib/api';

const kit = defaultBrandKit();

/** MARKED test data: a `test` snapshot, a TEST name, a fixture price — never a Levonis price. */
function snap(): ProductSnapshot {
  return {
    id: 'snap_test_0001', hash: 'x'.repeat(64), source: 'test', fetched_at: '2026-10-27T09:00:00Z',
    data: {
      product_id: 'p_test_a1', slug: 'test-a1', path: '/product/test-a1', variant_key: null, variant_label: null,
      name: { ar: 'طابعة Bambu Lab A1 Combo مع 4 بكرات (AMS lite)', en: 'TEST Bambu Lab A1 Combo', ckb: 'چاپکەری Bambu Lab A1 Combo تاقیکاری' },
      brand: null, category: null, sku: 'TEST-A1C', short_description: { ar: '', en: '', ckb: '' }, specs: [], contents: [],
      price: { status: 'priced', amount_iqd: 1250000, regular_iqd: null, from: false, offer: null, member_price_iqd: null },
      availability: 'available', sale_types: ['direct_sale'], source_updated_at: null,
      images: [{ url: '/files/products/test/a1-front.webp', width: 1200, height: 800, alt: '', primary: true, variant_key: null, same_origin: true }],
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
const data = (brand: BrandDto = brandDto): EditorData => ({ brand, snapshots: { main: snap() }, claims: [], assets: [], opportunities: [] });
const quietTimers = { setTimer: () => 0, clearTimer: () => undefined };

test('editor-2: a recovery draft is a plain restore only onto the version it was made on — a newer server copy makes it a copy, whatever the clocks say', () => {
  const doc = built();
  const mine = { ...doc, caption: 'mine' };
  // A device clock far behind the server's: the old comparison hid this real, unsaved draft.
  const behind = parseDraft(serializeDraft(mine, 1, new Date('2020-01-01T00:00:00Z')))!;
  assert.equal(draftOffer(behind, { version: 1, content: doc }), 'restore');
  // A clock far ahead, and someone else saved v2 meanwhile: the old comparison offered «restore» over their work.
  const ahead = parseDraft(serializeDraft(mine, 1, new Date('2099-01-01T00:00:00Z')))!;
  assert.equal(draftOffer(ahead, { version: 2, content: { ...doc, caption: 'theirs' } }), 'conflict', 'never laid over a newer version');
  assert.equal(draftOffer(ahead, { version: 2, content: mine }), null, 'the server already says it');
  const reordered = Object.fromEntries(Object.entries(mine).reverse());
  assert.equal(draftOffer(ahead, { version: 2, content: reordered }), null, 'key order is not a difference');
  assert.equal(draftOffer(null, { version: 1, content: doc }), null);
});

/** A stub server: a version-fenced PUT that can lose its answer AFTER writing, and the GET the controller may ask. */
function server(doc: CreativeDocument) {
  const s = { version: 1, content: JSON.parse(JSON.stringify(doc)) as CreativeDocument, puts: [] as Array<{ base: number; origin: string; job: string | null }>, loseNext: false, offline: false };
  const save = async (content: CreativeDocument, base: number, meta: SaveMeta) => {
    s.puts.push({ base, origin: meta.origin, job: meta.job_id });
    if (s.offline) throw new ApiError(0, 'offline', 'NETWORK');
    if (base !== s.version) throw new ApiError(409, 'conflict', 'VERSION_CONFLICT');
    s.version += 1;
    s.content = JSON.parse(JSON.stringify(content)) as CreativeDocument;
    if (s.loseNext) {
      s.loseNext = false;
      throw new ApiError(0, 'network', 'NETWORK');
    }
    return { version: s.version, updated_at: null };
  };
  const load = async () => ({ content: s.content, version: s.version, updated_at: null });
  return { s, save, load };
}

test('editor-5: a save whose answer was lost is adopted when the server holds it — never a false conflict; a real one still is', async () => {
  const doc = built();
  {
    const { s, save, load } = server(doc);
    const states: SaveState[] = [];
    const a = new Autosave({ save, load, onState: (x) => states.push(x), onSaved: () => undefined, ...quietTimers }, { content: doc, version: 1 });
    s.loseNext = true;
    a.change({ ...doc, caption: 'one' });
    await a.flush();
    assert.equal(a.current, 'offline');
    assert.equal(s.version, 2, 'the write landed although its answer was lost');
    a.change({ ...doc, caption: 'two' });
    await a.flush();
    assert.ok(!states.includes('conflict'), `states: ${states.join(' → ')}`);
    assert.equal(a.current, 'saved');
    assert.equal(a.baseVersion, 3);
    assert.equal(s.content.caption, 'two', 'the newer edit went on top of our own landed write');
    assert.deepEqual(s.puts.map((p) => p.base), [1, 1, 2], 'the 409 on the stale base was followed by one read and one save on the adopted base');
  }
  {
    // The retry of the very same content: adopted, nothing sent twice.
    const { s, save, load } = server(doc);
    const saved: number[] = [];
    const a = new Autosave({ save, load, onState: () => undefined, onSaved: (_c, r) => saved.push(r.version), ...quietTimers }, { content: doc, version: 1 });
    s.loseNext = true;
    a.change({ ...doc, caption: 'one' });
    await a.flush();
    await a.retry();
    assert.equal(a.current, 'saved');
    assert.equal(a.baseVersion, 2);
    assert.deepEqual(saved, [2], 'the editor learns the version its lost save became');
  }
  {
    // Lost, and then someone else really did save other content: that is a conflict.
    const { s, save, load } = server(doc);
    const a = new Autosave({ save, load, onState: () => undefined, onSaved: () => undefined, ...quietTimers }, { content: doc, version: 1 });
    s.loseNext = true;
    a.change({ ...doc, caption: 'one' });
    await a.flush();
    s.version += 1;
    s.content = { ...s.content, caption: 'someone else' };
    a.change({ ...doc, caption: 'two' });
    await a.flush();
    assert.equal(a.current, 'conflict');
    assert.equal(s.content.caption, 'someone else', 'their work is untouched');
  }
});

test('editor-11 (3): an AI answer whose save failed keeps its origin and job on the retry — until a person edits on top', async () => {
  const doc = built();
  const aiMeta: SaveMeta = { origin: 'ai', job_id: 'job_test_1' };
  {
    const { s, save, load } = server(doc);
    const a = new Autosave({ save, load, onState: () => undefined, onSaved: () => undefined, ...quietTimers }, { content: doc, version: 1 });
    s.offline = true;
    assert.equal(await a.saveAs({ ...doc, caption: 'from Claude' }, aiMeta), null);
    assert.equal(a.current, 'offline');
    s.offline = false;
    await a.retry();
    assert.equal(a.current, 'saved');
    assert.deepEqual(s.puts[s.puts.length - 1], { base: 1, origin: 'ai', job: 'job_test_1' }, 'Claude’s words are not credited to a person');
  }
  {
    const { s, save, load } = server(doc);
    const a = new Autosave({ save, load, onState: () => undefined, onSaved: () => undefined, ...quietTimers }, { content: doc, version: 1 });
    s.offline = true;
    await a.saveAs({ ...doc, caption: 'from Claude' }, aiMeta);
    a.change({ ...doc, caption: 'from Claude, then by hand' });
    s.offline = false;
    await a.retry();
    assert.deepEqual(s.puts[s.puts.length - 1], { base: 1, origin: 'manual', job: null }, 'a person’s edit on top makes the save theirs');
  }
});

test('worker-4 (client): a save refused because the job was cancelled takes the answer back — and the screen is saved again', async () => {
  const doc = built();
  const answer = { ...doc, caption: 'discarded answer' };
  const h = commit(historyOf(doc), answer);
  const back = dropStep(h, answer);
  assert.equal(back.present, doc);
  assert.equal(back.future.length, 0, 'no redo brings a cancelled answer back');
  assert.equal(dropStep(commit(h, { ...answer, caption: 'later' }), answer).present.caption, 'later', 'a later edit is never dropped');
  const a = new Autosave({
    save: async () => { throw new ApiError(409, 'cancelled', 'JOB_CANCELLED'); },
    onState: () => undefined, onSaved: () => undefined, ...quietTimers,
  }, { content: doc, version: 4 });
  assert.equal(await a.saveAs(answer, { origin: 'ai', job_id: 'job_test_2' }), null);
  assert.equal(a.lastErrorCode, 'JOB_CANCELLED');
  assert.equal(a.current, 'failed');
  a.change(back.present);
  assert.equal(a.hasUnsaved, false);
  assert.equal(a.current, 'saved', 'back to the server copy: no «save failed» left with nothing to save');
});

test('editor-3 (editor): a lock on the layer, its group or anything inside it keeps it from being selected, dragged, marqueed or deleted', () => {
  const doc = built();
  const group = doc.layers.find((l) => l.type === 'group' && doc.layers.some((c) => c.parent === l.id && c.type === 'text'))!;
  const words = doc.layers.find((l) => l.parent === group.id && l.type === 'text')!;
  assert.equal(selectableId(doc, words.id), group.id);
  assert.equal(isInteractive(doc, group.id), true);
  const lockedWords = { ...doc, layers: doc.layers.map((l) => (l.id === words.id ? { ...l, locked: true } : l)) };
  assert.equal(lockedAround(lockedWords, group.id), true, 'a locked child locks its group');
  assert.equal(isInteractive(lockedWords, group.id), false, 'so a click on the chip cannot drag the locked words along');
  assert.ok(!marqueeHits(lockedWords, { x: 0, y: 0, width: 1080, height: 1080 }).includes(group.id), 'nor can a marquee pick the group');
  assert.ok(marqueeHits(lockedWords, { x: 0, y: 0, width: 1080, height: 1080 }).includes('headline'));
  const lockedGroup = { ...doc, layers: doc.layers.map((l) => (l.id === group.id ? { ...l, locked: true } : l)) };
  assert.equal(isInteractive(lockedGroup, words.id), false, 'a locked group locks what is inside it');
  assert.equal(lockedAround(doc, 'headline'), false);
});

test('spec-13: a scoped request on a chip reaches its words — the scope is the selection with what is inside it', () => {
  const doc = built();
  const group = doc.layers.find((l) => l.type === 'group')!;
  const inside = doc.layers.filter((l) => l.parent === group.id).map((l) => l.id);
  const words = doc.layers.find((l) => l.parent === group.id && l.type === 'text')!;
  assert.deepEqual(chatScope(doc, [group.id]), [group.id, ...inside]);
  assert.deepEqual(chatScope(doc, [group.id, words.id]), [group.id, ...inside], 'a child already inside is not listed twice');
  assert.deepEqual(chatScope(doc, ['headline', 'gone']), ['headline'], 'a stale id is dropped');
  const patch = {
    schema_version: 1, document_id: 'doc_test', base_document_version: 3, intent: 'shorten', target_layer_ids: [words.id],
    operations: [{ op: 'set_text', layer_id: words.id, value: 'اطلب الآن' }], reason: '', warnings: [], clarification: '',
  };
  const ctx = (scope: string[]) => ({ documentId: 'doc_test', version: 3, doc, scope, evidence: { offer: false, serviceClaim: false }, ops: { brand: kit, allowed: allowedAssets(doc, data()), measure: approximateMeasurer } });
  const before = validateEditPatch(patch, ctx(topLevel(doc, [group.id])));
  assert.ok(before.ok === false && before.code === 'target_outside_scope', 'the old scope refused every answer');
  const after = validateEditPatch(patch, ctx(chatScope(doc, [group.id])));
  assert.ok(after.ok === true && after.applied, JSON.stringify(after));
});

test('editor-6: Enter, Space, arrows and Delete on a focused control belong to it; the stage and the body keep every shortcut', () => {
  const el = (matches: string[]) => ({ closest: (sel: string) => (sel.split(',').some((s) => matches.includes(s.trim())) ? {} : null) });
  const button = el(['button']);
  const tab = el(['[role="tab"]']);
  const radio = el(['[role="radio"]']);
  const body = el([]);
  const stage = el(['[role="application"]']);
  for (const key of ['Enter', ' ', 'ArrowLeft', 'ArrowDown', 'Backspace', 'Delete']) assert.equal(keyBelongsToControl(key, button, stage), true, `button ${key}`);
  assert.equal(keyBelongsToControl('ArrowLeft', tab, stage), true);
  assert.equal(keyBelongsToControl('ArrowRight', radio, stage), true);
  assert.equal(keyBelongsToControl('z', button, stage), false, 'undo is not a button’s key');
  assert.equal(keyBelongsToControl('Escape', button, stage), false);
  assert.equal(keyBelongsToControl('ArrowLeft', body, stage), false, 'the body keeps the nudge');
  assert.equal(keyBelongsToControl('Delete', stage, stage), false, 'the stage keeps Delete');
  assert.equal(keyBelongsToControl('Enter', null, stage), false);
});

test('editor-8 (renderer): a picture is never stretched — another decoded ratio is drawn whole, contained and centred; a crop follows the decoded pixels', () => {
  // Recorded 400×300 (EXIF ignored on upload), decoded 300×400 (the browser applied the rotation).
  const box = { width: 374, height: 280.5 };
  const f = imageFit({ width: 400, height: 300 }, null, { width: 300, height: 400 }, box);
  assert.ok(Math.abs(f.width / f.height - 300 / 400) < 1e-9, 'the decoded ratio is kept');
  assert.ok(f.width <= box.width + 1e-9 && f.height <= box.height + 1e-9, 'inside the box');
  assert.ok(Math.abs(f.x - (box.width - f.width) / 2) < 1e-9 && Math.abs(f.y - (box.height - f.height) / 2) < 1e-9, 'centred');
  assert.equal(f.crop, undefined);
  // Same picture at half the recorded resolution: the crop is scaled into the decoded pixels, the box is filled.
  const half = imageFit({ width: 2000, height: 1000 }, { x: 500, y: 0, width: 1000, height: 1000 }, { width: 1000, height: 500 }, { width: 540, height: 540 });
  assert.deepEqual(half, { x: 0, y: 0, width: 540, height: 540, crop: { x: 250, y: 0, width: 500, height: 500 } });
  // Within 0.5 %: drawn as recorded.
  assert.deepEqual(imageFit({ width: 1200, height: 800 }, null, { width: 1201, height: 800 }, { width: 600, height: 400 }), { x: 0, y: 0, width: 600, height: 400 });
});

test('spec-2 (editor): bound words are drawn with the design’s pinned kit, and a different drawing is an offer, never a silent rewrite', () => {
  const doc = built();
  const arab = { ...kit, digits: 'arab' as const };
  // The kit in force now writes Arabic-Indic digits; the design was made (and approved) with Latin ones.
  const newer = data({ ...brandDto, kit: arab });
  assert.equal(boundRefresh(doc, bindingContext(doc, newer, kit)), null, 'with its pinned kit, the design draws exactly what it stores');
  const offer = boundRefresh(doc, bindingContext(doc, newer));
  assert.ok(offer, 'the current kit would change it');
  assert.deepEqual(offer!.changed, ['price']);
  assert.notEqual(offer!.doc, doc);
  assert.equal(doc.layers.find((l) => l.id === 'price')!.type === 'text' && (doc.layers.find((l) => l.id === 'price') as { text: string }).text.includes('1,250,000'), true, 'the stored design is left as it is');
});

test('editor-9 (client): a re-layout to a composition the template does not have is refused — never the template’s first variant in disguise', () => {
  const doc = built();
  assert.equal(doc.template?.id, 'product_hero');
  assert.equal(relayoutVariant(doc, { kind: 'priority', priority: 'headline' }, 'priced'), null, 'product_hero has no headline-first composition');
  assert.equal(relayoutVariant(doc, { kind: 'variant', variant: 'headline_first' }, 'priced'), null);
  assert.equal(relayoutVariant(doc, { kind: 'priority', priority: 'price' }, 'priced'), 'price_first');
  assert.equal(relayoutVariant(doc, { kind: 'variant', variant: 'price_first' }, 'priced'), 'price_first');
  assert.equal(relayoutVariant({ ...doc, template: null }, { kind: 'variant', variant: 'price_first' }, 'priced'), null, 'no template, no re-layout');
});
