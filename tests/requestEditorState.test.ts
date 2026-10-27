/**
 * THE REQUEST EDITOR'S PURE PARTS (plan P1-06, acceptance 14; docs/
 * DECISIONS.md row 268): the state and its body, the tab copy, the saving
 * clock, the keyboard rule, the three-language search, the estimate of each
 * part and the viewer's direction. The round trip against the real server is
 * tests/requestEditorDraft.test.ts.
 *
 * Run: node --import tsx --test tests/requestEditorState.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DraftShape, Quote } from '../src/components/community/requests/api';
import {
  addLink,
  addMaterial,
  addPart,
  addTextRef,
  adoptIds,
  anyColour,
  blankState,
  bodyKey,
  deserialise,
  duplicatePart,
  editorBody,
  fileStored,
  hydrate,
  movePart,
  namedColour,
  primaryKey,
  removePart,
  removeSource,
  sentShape,
  serialise,
  setOriginal,
  setPrimary,
  toggleColour,
  updateMaterial,
  updatePart,
  type EditorColour,
} from '../src/components/community/requests/editor/state';
import { REQUEST_EDITOR_COPIES, clearMirror, dropOtherAccounts, forgetTabEntries, mirrorBase, mirrorKey, readMirror, writeMirror, type MirrorStorage } from '../src/components/community/requests/editor/sessionMirror';
import { AUTOSAVE_IDLE_MS, AUTOSAVE_SPACING_MS, autosaveDelay, statusOfError } from '../src/components/community/requests/editor/persistence';
import { keyboardIsOpen, typesText } from '../src/components/community/requests/editor/useKeyboardOpen';
import { matchesSearch, normaliseForSearch } from '../src/components/community/requests/editor/search';
import { filterMaterials } from '../src/components/community/requests/editor/MaterialPicker';
import { filterPalette, paletteHas } from '../src/components/community/requests/editor/ColourPicker';
import { partEstimates } from '../src/components/community/requests/editor/estimate';
import { stepFor } from '../src/components/community/requests/editor/ImageViewer';
import { linkLabel, middleTruncate } from '../src/components/community/requests/editor/SourceThumb';
import { editorStrings } from '../src/components/community/requests/editor/strings';
import { ApiError } from '../src/lib/api';

// ------------------------------------------------------------------ a draft as the server answers it

const file = (id: string, kind: 'model' | 'reference' | 'document', name: string, extra: Partial<DraftShape['files'][number]> = {}) => ({
  id,
  file_name: name,
  content_type: kind === 'reference' ? 'image/png' : kind === 'model' ? 'model/stl' : 'application/pdf',
  size_bytes: 64,
  kind,
  inline: kind === 'reference',
  url: `/api/marketplace/requests/req_1/files/${id}`,
  analysis: null,
  ...extra,
});

function draft(over: Partial<DraftShape> = {}): DraftShape {
  return {
    id: 'req_1',
    state: 'draft',
    revision: 1,
    updated_at: '2026-10-20T10:00:00.000Z',
    title: 'A clip',
    description: 'A cable clip, please',
    customer_notes: '',
    quantity: 2,
    governorate: '',
    delivery_pref: '',
    deadline: '',
    budget_iqd: null,
    expires_at: null,
    live_offers: 0,
    print: null,
    files: [file('crf_stl', 'model', 'clip.stl'), file('crf_pic', 'reference', 'side.png')],
    budget_visible: false,
    schema_version: 3,
    direct: null,
    model: {
      schema_version: 3,
      origin: 'tables',
      stale: false,
      job: { quantity: 2, quality: 'fine', infill_percent: 20, supports: true, post_processing_minutes: 0, source_type: 'model' },
      sources: [
        { id: 'rps_crf_stl', kind: 'file', file_id: 'crf_stl', role: '', url: '', canonical_url: '', provider: '', ref_text: '', note: '', is_primary: true, position: 0 },
        { id: 'rps_crf_pic', kind: 'file', file_id: 'crf_pic', role: '', url: '', canonical_url: '', provider: '', ref_text: '', note: 'the colour', is_primary: false, position: 1 },
      ],
      parts: [
        {
          id: 'rpt_1', position: 0, name: 'Clip', quantity: 1, process: 'fdm', process_unsure: false, stated_dims: null, measured_file_id: 'crf_stl',
          notes: '', assembly_notes: '', legacy_text: '', review_state: '', review_reasons: [], source_ids: ['rps_crf_stl', 'rps_crf_pic'],
          materials: [{ id: 'rpm_1', position: 0, material_id: 'pla', material_unsure: false, colors: [{ mode: 'catalogue', hex: '#1a1a1a', label: 'Black', palette: 'black', ref: '' }], finish: 'standard', region_reference: '', requirements: '', colors_need_review: false }],
        },
      ],
      summary: { parts_count: 1, pieces_per_set: 1, materials: ['pla'], processes: ['fdm'], colors_total: 1, multicolor_parts: 0, review_state: '' },
    },
    ...over,
  } as DraftShape;
}

// ------------------------------------------------------------------ hydrate and the body

test('hydrate then editorBody: every id echoed, the finish kept as stored, never a source_type, the title and description of a draft', () => {
  const s = hydrate(draft());
  const body = editorBody(s);
  assert.equal(body.schema_version, 3);
  assert.equal('source_type' in body, false);
  assert.equal(body.quantity, 2);
  assert.equal(body.quality, 'fine');
  assert.equal(body.title, 'A clip');
  assert.equal(body.description, 'A cable clip, please');
  assert.deepEqual(body.sources.map((x) => [x.id, x.kind, x.file_id, x.is_primary, x.note, x.role]), [
    ['rps_crf_stl', 'file', 'crf_stl', true, '', ''],
    ['rps_crf_pic', 'file', 'crf_pic', false, 'the colour', ''],
  ]);
  assert.deepEqual(body.parts[0], {
    id: 'rpt_1', name: 'Clip', quantity: 1, process: 'fdm', stated_dimensions_mm: null, measured_file_id: 'crf_stl', notes: '', assembly_notes: '',
    source_ids: ['rps_crf_stl', 'rps_crf_pic'],
    materials: [{ id: 'rpm_1', material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a', label: 'Black' }], finish: 'standard', region_reference: '', requirements: '' }],
  });
  // The delivery and budget fields are carried by the server, never sent from here.
  for (const k of ['governorate', 'delivery_pref', 'deadline', 'budget_iqd', 'budget_visible', 'customer_notes']) assert.equal(k in body, false, k);
});

test('a published request: no title, no description, and no main source picked for it', () => {
  const d = draft({ state: 'receiving_offers', live_offers: 2 });
  d.model!.sources[0].is_primary = false;
  const s = hydrate(d);
  const body = editorBody(s);
  assert.equal('title' in body, false);
  assert.equal('description' in body, false);
  assert.equal(primaryKey(s), '', 'a main source is a priced fact: nothing is picked for a published job');
  assert.ok(body.sources.every((x) => !x.is_primary));
  // On a draft the same sources get one: the first model.
  assert.equal(primaryKey({ ...s, requestState: 'draft' }), 'rps_crf_stl');
});

test('the main source on a draft: the one marked, else the first model, else the first link, else the first picture — never the original', () => {
  let s = hydrate(draft());
  s = setPrimary(s, '');
  assert.equal(primaryKey(s), 'rps_crf_stl');
  s = setOriginal(s, 'rps_crf_stl', false)[0];
  const [orig, err] = setOriginal(s, 'rps_crf_stl', true);
  assert.equal(err, 'SOURCE_ORIGINAL_PRIVATE', 'a part is measured from it');
  assert.equal(orig, s);
  s = updatePart(s, s.parts[0].key, { measuredFileId: null });
  s = setOriginal(s, 'rps_crf_stl', true)[0];
  assert.equal(s.sources[0].original, true);
  s = addLink(s, 'https://www.printables.com/model/1-a', 'printables')[0];
  assert.equal(primaryKey(s), s.sources.find((x) => x.kind === 'link')!.key, 'the original is never the main source');
  s = removeSource(s, s.sources.find((x) => x.kind === 'link')!.key);
  assert.equal(primaryKey(s), 'rps_crf_pic');
  assert.equal(editorBody(s).sources.find((x) => x.id === 'rps_crf_stl')!.role, 'source');
});

test('new sources travel under tmp ids that parts and colours point at, and a one-part job references every source', () => {
  let s = hydrate(draft());
  const [withLink, linkKey] = addLink(s, 'https://www.printables.com/model/4242-cable-clip', 'printables');
  s = withLink;
  assert.match(linkKey, /^tmp_link_\d+$/);
  const [withText, textKey] = addTextRef(s, '  Same size as the old one  ');
  s = withText;
  assert.deepEqual(s.parts[0].sourceKeys, ['rps_crf_stl', 'rps_crf_pic', linkKey, textKey]);
  s = updateMaterial(s, s.parts[0].key, s.parts[0].materials[0].key, { colours: [{ mode: 'as_reference', hex: '', label: '', ref: linkKey }] });
  const body = editorBody(s);
  assert.deepEqual(body.sources.slice(2).map((x) => [x.id, x.kind, x.url ?? x.ref_text]), [
    [linkKey, 'link', 'https://www.printables.com/model/4242-cable-clip'],
    [textKey, 'text_ref', 'Same size as the old one'],
  ]);
  assert.deepEqual(body.parts[0].materials[0].colors, [{ mode: 'as_reference', ref: linkKey }]);
  // Refused here before the server: the same link twice, a fifth link, an empty reference.
  assert.equal(addLink(s, 'https://www.printables.com/model/4242-cable-clip', 'printables')[2], 'LINK_DUPLICATE');
  let full = s;
  for (let i = 0; i < 3; i++) full = addLink(full, `https://www.printables.com/model/${i}-x`, 'printables')[0];
  assert.equal(addLink(full, 'https://www.printables.com/model/99-y', 'printables')[2], 'LINKS_TOO_MANY');
  assert.equal(addTextRef(s, '   ')[2], 'EMPTY');
  // Removing a source takes it out of every part and every colour.
  s = removeSource(s, linkKey);
  assert.ok(!s.parts[0].sourceKeys.includes(linkKey));
  assert.deepEqual(s.parts[0].materials[0].colours, [{ mode: 'as_reference', hex: '', label: '', ref: '' }]);
});

test('a stored model measures the first part that has no size yet; a picture measures nothing', () => {
  let s = blankState();
  s = fileStored(s, file('crf_pic', 'reference', 'a.png'));
  assert.equal(s.parts[0].measuredFileId, null);
  s = fileStored(s, file('crf_m1', 'model', 'a.stl'));
  assert.equal(s.parts[0].measuredFileId, 'crf_m1');
  s = fileStored(s, file('crf_m2', 'model', 'b.stl'));
  assert.equal(s.parts[0].measuredFileId, 'crf_m1', 'a part already measured keeps its model');
  assert.equal(fileStored(s, file('crf_m2', 'model', 'b.stl')), s, 'the same file twice is one file');
});

test('parts: add, copy (new keys, no ids), move, remove — twelve at most, four materials a part, the last part stays', () => {
  let s = hydrate(draft());
  const [s1, k2] = addPart(s);
  s = s1;
  assert.equal(s.parts.length, 2);
  const [s2, k3] = duplicatePart(s, 'rpt_1');
  s = s2;
  const copy = s.parts[1];
  assert.equal(copy.key, k3);
  assert.equal(copy.id, null);
  assert.equal(copy.materials[0].id, null);
  assert.notEqual(copy.materials[0].key, s.parts[0].materials[0].key);
  assert.equal(copy.name, 'Clip');
  s = movePart(s, k2, -1);
  assert.deepEqual(s.parts.map((p) => p.key), ['rpt_1', k2, k3]);
  assert.equal(movePart(s, 'rpt_1', -1), s, 'the first part cannot move up');
  s = removePart(s, k2);
  assert.equal(s.parts.length, 2);
  let full = s;
  while (full.parts.length < 12) full = addPart(full)[0];
  assert.equal(addPart(full)[1], '', 'a request has twelve parts at most');
  let mats = s;
  for (let i = 0; i < 5; i++) mats = addMaterial(mats, 'rpt_1')[0];
  assert.equal(mats.parts[0].materials.length, 4, 'four materials a part at most');
  let lone = blankState();
  lone = removePart(lone, lone.parts[0].key);
  assert.equal(lone.parts.length, 1, 'the last part stays');
});

test('colours: «أي لون مناسب» stands alone, «كما في المرجع» sits beside named colours, sixteen at most', () => {
  const black = namedColour('Black', '#1A1A1A');
  assert.deepEqual(black, { mode: 'catalogue', hex: '#1a1a1a', label: 'Black', ref: '' }, 'a palette hex is a catalogue colour');
  assert.equal(namedColour('Rose gold', '').mode, 'custom');
  let list: EditorColour[] = [anyColour()];
  list = toggleColour(list, black);
  assert.deepEqual(list.map((c) => c.mode), ['catalogue'], 'a named colour clears «any»');
  list = toggleColour(list, { mode: 'as_reference', hex: '', label: '', ref: 'tmp_1' });
  assert.deepEqual(list.map((c) => c.mode), ['catalogue', 'as_reference']);
  assert.deepEqual(toggleColour(list, anyColour()).map((c) => c.mode), ['any'], '«any» clears the others');
  assert.deepEqual(toggleColour([black], black).map((c) => c.mode), ['any'], 'nothing chosen is «any»');
  let many: EditorColour[] = [];
  for (let i = 0; i < 20; i++) many = toggleColour(many, namedColour(`c${i}`, ''));
  assert.equal(many.length, 16);
});

test('adoptIds: the server ids land on the editor keys, and an edit made while the save was on its way stays', () => {
  let s = hydrate(draft());
  const [s1, linkKey] = addLink(s, 'https://www.printables.com/model/4242-cable-clip', 'printables');
  const [s2, partKey] = addPart(s1);
  s = s2;
  const sent = sentShape(s);
  const answered = draft();
  answered.updated_at = '2026-10-20T10:00:05.000Z';
  answered.model!.sources.push({ id: 'rps_new', kind: 'link', file_id: null, role: '', url: 'https://www.printables.com/model/4242-cable-clip', canonical_url: 'https://www.printables.com/model/4242-cable-clip', provider: 'printables', ref_text: '', note: '', is_primary: false, position: 2 });
  answered.model!.parts.push({ ...answered.model!.parts[0], id: 'rpt_new', position: 1, materials: [{ ...answered.model!.parts[0].materials[0], id: 'rpm_new' }], review_state: 'needs_technical_review', review_reasons: ['multi_material'] });
  // Meanwhile the customer renamed the new part.
  const meanwhile = updatePart(s, partKey, { name: 'Grip' });
  const next = adoptIds(meanwhile, sent, answered);
  assert.equal(next.updatedAt, '2026-10-20T10:00:05.000Z');
  assert.equal(next.sources.find((x) => x.key === linkKey)!.id, 'rps_new');
  const part = next.parts.find((p) => p.key === partKey)!;
  assert.equal(part.id, 'rpt_new');
  assert.equal(part.name, 'Grip', 'the edit made meanwhile stays');
  assert.equal(part.materials[0].id, 'rpm_new');
  assert.equal(part.reviewState, 'needs_technical_review', 'the review is the server’s');
  // The body now echoes the server ids, under the same keys.
  const body = editorBody(next);
  assert.ok(body.sources.some((x) => x.id === 'rps_new'));
  assert.equal(body.parts[1].id, 'rpt_new');
});

test('the tab copy round-trips, and a copy that does not parse is no copy', () => {
  const s = updatePart(hydrate(draft()), 'rpt_1', { notes: 'matte' });
  const back = deserialise(serialise(s));
  assert.equal(bodyKey(back!), bodyKey(s));
  assert.equal(deserialise('{"requestId": 1}'), null);
  assert.equal(deserialise('not json'), null);
  assert.equal(deserialise(JSON.stringify({ ...s, parts: [{ key: 'p', materials: [] }] })), null);
});

// ------------------------------------------------------------------ the tab copy

class MemoryStorage implements MirrorStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

test('the tab copy is applied only to its account and on top of the version it was made on', () => {
  const store = new MemoryStorage();
  const s = updatePart(hydrate(draft()), 'rpt_1', { notes: 'matte, please' });
  writeMirror(store, 'u1', s);
  assert.ok(store.map.has(mirrorKey('u1', 'req_1')));
  assert.equal(mirrorKey('u1', ''), 'levonis.request-editor.u1.new');
  const base = mirrorBase(s);
  assert.equal(base, 'at:2026-10-20T10:00:00.000Z');
  assert.equal(readMirror(store, 'u1', 'req_1', base)!.parts[0].notes, 'matte, please');
  assert.equal(readMirror(store, 'u1', 'req_1', 'at:2026-10-21T00:00:00.000Z'), null, 'made on an older version: dropped, never laid over a newer one');
  assert.equal(readMirror(store, 'u2', 'req_1', base), null, 'another account never reads it');
  assert.equal(mirrorBase({ requestState: 'receiving_offers', updatedAt: 'x', revision: 3 }), 'rev:3', 'a published request is kept by its revision');
  clearMirror(store, 'u1', 'req_1');
  assert.equal(store.map.size, 0);
});

test('other accounts’ copies go on load, all of them on a sign-out; a storage that throws costs only the copy', () => {
  const store = new MemoryStorage();
  writeMirror(store, 'u1', hydrate(draft()));
  writeMirror(store, 'u2', hydrate(draft()));
  store.setItem('levonis.upload.request:req_1:1:2:a.stl', '{}');
  writeMirror(store, 'u12', hydrate(draft()));
  assert.equal(REQUEST_EDITOR_COPIES, 'levonis.request-editor.');
  dropOtherAccounts(store, 'u1');
  assert.deepEqual([...store.map.keys()].sort(), ['levonis.request-editor.u1.req_1', 'levonis.upload.request:req_1:1:2:a.stl'], 'u12 is another account, not u1');
  // What the app shell does (src/AuthContext.tsx): the first check after a
  // reload names u1, whose copies stay; a sign-out forgets every copy.
  forgetTabEntries(REQUEST_EDITOR_COPIES, `${REQUEST_EDITOR_COPIES}u1.`, store);
  assert.ok(store.map.has('levonis.request-editor.u1.req_1'), 'a reload keeps the copy of the account still signed in');
  forgetTabEntries(REQUEST_EDITOR_COPIES, undefined, store);
  assert.deepEqual([...store.map.keys()], ['levonis.upload.request:req_1:1:2:a.stl'], 'only the editor copies, never the upload resume records');
  const angry: MirrorStorage = {
    get length(): number {
      throw new Error('blocked');
    },
    key: () => {
      throw new Error('blocked');
    },
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.doesNotThrow(() => writeMirror(angry, 'u1', hydrate(draft())));
  assert.equal(readMirror(angry, 'u1', 'req_1', null), null);
  assert.doesNotThrow(() => dropOtherAccounts(angry, 'u1'));
  assert.doesNotThrow(() => forgetTabEntries(REQUEST_EDITOR_COPIES, undefined, angry));
});

// ------------------------------------------------------------------ the saving clock

test('autosave: 2 s idle, and never within 30 s of the last one — 120 an hour is the draft save limit', () => {
  assert.equal(autosaveDelay(1_000_000, 0), AUTOSAVE_IDLE_MS, 'the first autosave waits only for the pause');
  assert.equal(autosaveDelay(1_005_000, 1_000_000), AUTOSAVE_SPACING_MS - 5_000);
  assert.equal(autosaveDelay(1_029_500, 1_000_000), AUTOSAVE_IDLE_MS, 'the pause is never cut short');
  assert.ok(3600_000 / AUTOSAVE_SPACING_MS <= 120);
});

test('what a failed save means: a conflict, a session that ran out, no connection, or a failure to retry', () => {
  assert.equal(statusOfError(new ApiError(409, 'x', 'DRAFT_CHANGED'), true), 'conflict');
  assert.equal(statusOfError(new ApiError(409, 'x', 'REQUEST_NOT_DRAFT'), true), 'failed');
  assert.equal(statusOfError(new ApiError(401, 'x', 'UNAUTHORIZED'), true), 'signedOut');
  assert.equal(statusOfError(new ApiError(0, 'x', 'NETWORK'), false), 'offline');
  assert.equal(statusOfError(new ApiError(0, 'x', 'NETWORK'), true), 'failed');
  assert.equal(statusOfError(new ApiError(400, 'x', 'LINK_DUPLICATE'), true), 'failed');
});

// ------------------------------------------------------------------ the keyboard

test('the keyboard is up only while a field that types is focused and the visual viewport is 150 px shorter', () => {
  assert.equal(keyboardIsOpen({ innerHeight: 740, visualHeight: 420, typing: true }), true);
  assert.equal(keyboardIsOpen({ innerHeight: 740, visualHeight: 420, typing: false }), false, 'a pinch-zoom is no keyboard');
  assert.equal(keyboardIsOpen({ innerHeight: 740, visualHeight: 700, typing: true }), false);
  // Turned to landscape with a field focused: the two heights of the same moment, so no keyboard is read.
  assert.equal(keyboardIsOpen({ innerHeight: 360, visualHeight: 360, typing: true }), false);
  assert.equal(keyboardIsOpen({ innerHeight: 360, visualHeight: null, typing: true }), false);
  const el = (tagName: string, type?: string) => ({ tagName, getAttribute: () => type ?? null }) as unknown as Element;
  assert.equal(typesText(el('TEXTAREA')), true);
  assert.equal(typesText(el('INPUT', 'search')), true);
  assert.equal(typesText(el('INPUT')), true);
  assert.equal(typesText(el('INPUT', 'radio')), false);
  assert.equal(typesText(el('INPUT', 'color')), false);
  assert.equal(typesText(el('BUTTON')), false);
  assert.equal(typesText(null), false);
});

// ------------------------------------------------------------------ search

test('search folds Arabic and Sorani spellings, hamza forms, diacritics and digits', () => {
  assert.equal(normaliseForSearch('أَحْمَر'), normaliseForSearch('احمر'));
  assert.equal(normaliseForSearch('إطار'), normaliseForSearch('اطار'));
  assert.equal(normaliseForSearch('كاربۆن'), normaliseForSearch('کاربون'));
  assert.equal(normaliseForSearch('ڕێزن'), normaliseForSearch('ريزن'));
  assert.equal(normaliseForSearch('مادة'), normaliseForSearch('ماده'));
  assert.equal(normaliseForSearch('٦٢'), '62');
  assert.equal(matchesSearch('pla', ['PLA كربون']), true);
  assert.equal(matchesSearch('', ['anything']), true);
  assert.equal(matchesSearch('xyz', ['PLA', 'PETG']), false);
});

test('the material picker finds a material by any of its names, in three languages', () => {
  // The live catalogue names TPU only by its code; the seed carries the words.
  const catalogue = [
    { id: 'pla', process: 'fdm' as const, name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false },
    { id: 'tpu', process: 'fdm' as const, name_en: 'TPU', name_ar: 'TPU', needs_enclosure: false, abrasive: false },
    { id: 'resin-standard', process: 'resin' as const, name_en: 'Standard Resin', name_ar: 'ريزن قياسي', needs_enclosure: false, abrasive: false },
  ];
  assert.deepEqual(filterMaterials(catalogue, 'PLA', 'all').map((m) => m.id), ['pla']);
  assert.deepEqual(filterMaterials(catalogue, 'مرن', 'all').map((m) => m.id), ['tpu'], 'Arabic: «TPU مرن»');
  assert.deepEqual(filterMaterials(catalogue, 'نەرم', 'all').map((m) => m.id), ['tpu'], 'Sorani: «TPU نەرم»');
  assert.deepEqual(filterMaterials(catalogue, 'flexible', 'all').map((m) => m.id), [], 'English searches the English names');
  assert.deepEqual(filterMaterials(catalogue, 'xyz', 'all'), []);
  assert.deepEqual(filterMaterials(catalogue, '', 'resin').map((m) => m.id), ['resin-standard']);
  assert.deepEqual(filterMaterials(catalogue, 'ڕێزن', 'all').map((m) => m.id), ['resin-standard']);
});

test('the colour field filters the palette in three languages and offers a name it does not have', () => {
  assert.deepEqual(filterPalette('أسود').map((c) => c.hex), ['#1a1a1a']);
  assert.deepEqual(filterPalette('ڕەش').map((c) => c.hex), ['#1a1a1a']);
  assert.deepEqual(filterPalette('bla').map((c) => c.hex), ['#1a1a1a']);
  assert.equal(filterPalette('').length, 7);
  assert.equal(paletteHas('اسود'), true, 'the hamza is folded');
  assert.equal(paletteHas('Rose gold'), false);
});

// ------------------------------------------------------------------ the estimate of each part

test('each part shows its own estimate, by its place: priced, unpriced with the reason, or the refusal a publish would answer', () => {
  const t = editorStrings('ar');
  const quote = {
    priced: true,
    price_low_iqd: 9000,
    price_high_iqd: 14000,
    coverage: {
      complete: false,
      parts_total: 3,
      priced_parts: [{ part_id: 'x', position: 0, price_low_iqd: 4000, price_high_iqd: 6000 }],
      unpriced_parts: [
        { part_id: 'y', position: 1, reason: 'NO_GEOMETRY' },
        { part_id: 'z', position: 2, reason: '', refusal: 'PART_RESIN_MULTI_MATERIAL' },
      ],
    },
  } as unknown as Quote;
  const map = partEstimates(quote, 3, 'ar', t);
  assert.equal(map.get(0)!.kind, 'priced');
  assert.match(map.get(0)!.text, /4,000|٤٬٠٠٠/);
  assert.equal(map.get(1)!.text, `بلا تقدير: ${t.noGeometry}`);
  assert.match(map.get(2)!.text, /ريزن/, 'the refusal words of PART_RESIN_MULTI_MATERIAL');
  const one = partEstimates({ priced: false, reason: 'MATERIAL_UNKNOWN' } as unknown as Quote, 1, 'en', editorStrings('en'));
  assert.equal(one.get(0)!.text, 'No estimate: Choose a material to estimate it');
  assert.equal(partEstimates(null, 2, 'ckb', editorStrings('ckb')).size, 0);
});

// ------------------------------------------------------------------ the viewer and the names

test('the viewer moves the way the reading goes: ← is next in Arabic and Sorani, → in English; a swipe mirrors the same', () => {
  assert.equal(stepFor({ key: 'ArrowLeft' }, 'rtl'), 1);
  assert.equal(stepFor({ key: 'ArrowRight' }, 'rtl'), -1);
  assert.equal(stepFor({ key: 'ArrowRight' }, 'ltr'), 1);
  assert.equal(stepFor({ key: 'ArrowLeft' }, 'ltr'), -1);
  assert.equal(stepFor({ dx: 80 }, 'rtl'), 1, 'a finger moving right brings the next picture in RTL');
  assert.equal(stepFor({ dx: -80 }, 'ltr'), 1);
  assert.equal(stepFor({ dx: 20 }, 'ltr'), 0, 'under 48 px is not a swipe');
});

test('a long file name keeps its end on screen; a link reads as its host and path', () => {
  const cut = middleTruncate('my-very-long-bracket-for-the-left-side-v3-final.stl', 28);
  assert.ok(cut.length <= 28, cut);
  assert.ok(cut.endsWith('.stl'), cut);
  assert.equal(middleTruncate('a.stl', 28), 'a.stl');
  assert.equal(linkLabel('https://www.printables.com/model/4242-cable-clip'), 'printables.com/model/4242-cable-clip');
});
