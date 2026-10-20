/**
 * WRITING A V3 REQUEST (P1-04, acceptance 14 — the server half; docs/
 * DECISIONS.md row 266).
 *
 * Real routes and migrations. Pinned: a draft with two files, a link, a text
 * reference, notes, the link as primary and two parts in different materials
 * comes back from the GET with every source and part in order; sending it back
 * unchanged changes no row and no hash; the v1 row it is mirrored to is a
 * coherent single job (an unsure material, the colour count of the busiest
 * part); a multi-part job is refused at publish until P1-05; an older client's
 * v1 body is folded into a one-part model and refused on a several-part one;
 * the repeat copies the model onto the copied files; deleting the primary file
 * keeps the model fresh; every refusal answers its own code; and a database
 * before 0208 still takes a v1 write and refuses a v3 one honestly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryBucket, asD1, count, ctx, get, json, post, row } from './fixtures/app';
import { canonicalFactsV3, readRequestModel } from '../worker/lib/requestModel';
import { addFile, apply0208, as, dump, newDraft, offerOn, PLA, publish, readDraft, saveDraft, world } from './fixtures/requestModelWorld';

const LINK = 'https://www.printables.com/model/777-hinge?utm_source=share';

function twoPartBody(sfx = '') {
  return {
    schema_version: 3,
    customer_notes: 'two parts, please',
    sources: [
      { kind: 'file', file_id: `crf_model${sfx}`, note: 'the base' },
      { kind: 'file', file_id: `crf_photo${sfx}`, note: 'how it should look' },
      { id: 'tmp_link', kind: 'link', url: LINK, is_primary: true, note: 'the hinge design' },
      { id: 'tmp_text', kind: 'text_ref', ref_text: 'Like the lid on the box in the photo' },
    ],
    parts: [
      {
        name: 'Base', process: 'fdm', measured_file_id: `crf_model${sfx}`, source_ids: [`rps_crf_model${sfx}`, 'tmp_link'],
        materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a' }] }],
      },
      {
        name: 'Lid', quantity: 2, notes: 'snap fit', source_ids: ['tmp_text'],
        materials: [{ material_id: 'petg', colors: [{ mode: 'custom', hex: '#123456', label: 'Teal' }, { mode: 'as_reference', ref: 'tmp_text' }] }],
      },
    ],
  };
}

async function draftWithFiles(raw: DatabaseSync, bucket?: MemoryBucket, sfx = '') {
  const id = await newDraft(raw);
  addFile(raw, id, `crf_model${sfx}`, 'model', 'base.stl', { bucket });
  addFile(raw, id, `crf_photo${sfx}`, 'reference', 'photo.png', { bucket });
  return id;
}

const tables = (raw: DatabaseSync, id: string) => [
  dump(raw, `community_request_sources WHERE request_id = '${id}'`, 'position, id'),
  dump(raw, `community_request_parts WHERE request_id = '${id}'`, 'position, id'),
  dump(raw, `community_request_part_sources WHERE part_id IN (SELECT id FROM community_request_parts WHERE request_id = '${id}')`, 'part_id, source_id'),
  dump(raw, `community_request_part_materials WHERE part_id IN (SELECT id FROM community_request_parts WHERE request_id = '${id}')`, 'part_id, position'),
];

test('acceptance 14: a two-part draft with files, a link, a text reference and notes comes back whole and in order — and resent unchanged, moves nothing', async () => {
  const raw = world();
  const id = await draftWithFiles(raw);
  const saved = await saveDraft(raw, id, twoPartBody());
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const d = await readDraft(raw, id);
  assert.equal(d.schema_version, 3);
  assert.equal(d.model.origin, 'tables');
  assert.deepEqual(d.model.sources.map((s: Record<string, unknown>) => [s.kind, s.file_id, s.note, s.is_primary]), [
    ['file', 'crf_model', 'the base', false],
    ['file', 'crf_photo', 'how it should look', false],
    ['link', null, 'the hinge design', true],
    ['text_ref', null, '', false],
  ]);
  const link = d.model.sources[2];
  assert.equal(link.canonical_url, 'https://www.printables.com/model/777-hinge', 'the link is stored canonical');
  assert.equal(link.provider, 'printables');
  assert.equal(d.model.sources[3].ref_text, 'Like the lid on the box in the photo');
  assert.deepEqual(d.model.parts.map((p: Record<string, unknown>) => [p.name, p.quantity, p.process]), [['Base', 1, 'fdm'], ['Lid', 2, 'fdm']]);
  assert.deepEqual(d.model.parts[0].source_ids, ['rps_crf_model', link.id]);
  const lid = d.model.parts[1];
  assert.deepEqual(lid.materials[0].colors.map((c: Record<string, unknown>) => [c.mode, c.ref]), [['custom', ''], ['as_reference', d.model.sources[3].id]]);
  assert.equal(d.model.parts[0].materials[0].colors[0].palette, 'black');
  assert.equal(d.customer_notes, 'two parts, please');

  // THE V1 MIRROR: a coherent single job an older build reads.
  const p = row<Record<string, unknown>>(raw, 'SELECT * FROM community_print_requests WHERE request_id = ?', id)!;
  assert.deepEqual(
    [p.process, p.process_unsure, p.material_id, p.material_unsure, p.color_hex, p.color_name, p.colors_count, p.primary_file_id, p.source_type, p.source_kind, p.source_url],
    ['fdm', 0, '', 1, '', '', 2, 'crf_model', 'link', 'link', 'https://www.printables.com/model/777-hinge']
  );
  assert.deepEqual(
    [p.schema_version, p.parts_count, p.pieces_per_set, p.materials_json, p.processes_json, p.colors_total, p.multicolor_parts],
    [3, 2, 3, '["petg","pla"]', '["fdm"]', 3, 1]
  );
  assert.equal(row<{ material: string }>(raw, 'SELECT material FROM community_requests WHERE id = ?', id)!.material, '', 'no comma-joined material mirror');

  // Back and reload: the GET's own model, sent back, changes no row and no hash.
  const before = tables(raw, id);
  const h1 = canonicalFactsV3((await readRequestModel(asD1(raw), id))!);
  const again = await saveDraft(raw, id, { schema_version: 3, sources: d.model.sources, parts: d.model.parts });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(tables(raw, id), before);
  assert.equal(canonicalFactsV3((await readRequestModel(asD1(raw), id))!), h1);
  // A body that names only the job carries every part and source (R7).
  assert.equal((await saveDraft(raw, id, { schema_version: 3, quantity: 3 })).status, 200);
  assert.deepEqual(tables(raw, id).slice(0, 2).map((x) => JSON.parse(x).length), [4, 2]);
  assert.equal(row<{ quantity: number }>(raw, 'SELECT quantity FROM community_requests WHERE id = ?', id)!.quantity, 3);
});

test('a several-part job is a draft until P1-05 reads parts: publishing it is REQUEST_PARTS_NOT_YET and writes nothing', async () => {
  const raw = world();
  const id = await draftWithFiles(raw);
  assert.equal((await saveDraft(raw, id, twoPartBody())).status, 200);
  const res = await publish(raw, id, { schema_version: 3 });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'REQUEST_PARTS_NOT_YET');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', id)!.state, 'draft');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_revisions WHERE request_id = ?', id), 0);
});

test('a one-part v3 job publishes from the mirror, is priced like v1, and publishing it again is a replay', async () => {
  const raw = world();
  const id = await draftWithFiles(raw);
  const body = {
    schema_version: 3,
    sources: [{ kind: 'file', file_id: 'crf_model', is_primary: true, note: 'print this' }, { kind: 'link', url: LINK }],
    parts: [{ name: 'Bracket', process: 'fdm', measured_file_id: 'crf_model', materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#d32f2f', label: 'Red' }] }] }],
  };
  const first = await publish(raw, id, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  const p = row<Record<string, unknown>>(raw, 'SELECT material_id, material_unsure, color_hex, color_name, source_type, schema_version FROM community_print_requests WHERE request_id = ?', id)!;
  assert.deepEqual({ ...p }, { material_id: 'pla', material_unsure: 0, color_hex: '#d32f2f', color_name: 'Red', source_type: 'model', schema_version: 3 });
  assert.equal(row<{ material: string; color: string }>(raw, 'SELECT material, color FROM community_requests WHERE id = ?', id)!.material, 'PLA');
  const rev = row<{ spec: string; hash: string }>(raw, 'SELECT spec, hash FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!;
  assert.equal(JSON.parse(rev.spec).schema_version, 3);
  const second = await publish(raw, id, body);
  assert.equal(second.body.replayed, true);
  // The revision the publish recorded is the one composeSnapshot recomputes (merge first, then hash).
  const { composeSnapshot } = await import('../worker/lib/requestRevisions');
  assert.equal((await composeSnapshot(asD1(raw), id))!.hash, rev.hash);
});

test('an older client: its v1 body on a one-part v3 request is folded in (ids, names and notes kept); on a several-part one it is REQUEST_MODEL_V3', async () => {
  const raw = world();
  const one = await draftWithFiles(raw);
  assert.equal((await saveDraft(raw, one, {
    schema_version: 3,
    parts: [{ name: 'Bracket', notes: 'keep the edges sharp', process: 'fdm', materials: [{ material_id: 'pla', colors: [{ mode: 'any' }] }] }],
  })).status, 200);
  const before = await readDraft(raw, one);
  // The old wizard sends a v1 body with a new material.
  const folded = await saveDraft(raw, one, { process: 'fdm', material_id: 'petg', quality: 'standard', quantity: 1 });
  assert.equal(folded.status, 200, JSON.stringify(folded.body));
  const after = await readDraft(raw, one);
  assert.equal(after.schema_version, 3);
  assert.equal(after.model.parts[0].id, before.model.parts[0].id);
  assert.deepEqual([after.model.parts[0].name, after.model.parts[0].notes], ['Bracket', 'keep the edges sharp']);
  assert.equal(after.model.parts[0].materials[0].material_id, 'petg');

  const many = await draftWithFiles(raw, undefined, '_2');
  assert.equal((await saveDraft(raw, many, twoPartBody('_2'))).status, 200);
  const refused = await saveDraft(raw, many, { process: 'fdm', material_id: 'abs', quantity: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'REQUEST_MODEL_V3');
  // …but the same old client changing only what v1 can say (the sets) is folded in.
  // (What v1 can say of this job is its mirror: FDM, material unsure, two colours, the link primary.)
  const sets = await saveDraft(raw, many, { process: 'fdm', material_id: 'unsure', quantity: 4, colors_count: 2, primary_file_id: 'crf_model_2', source_type: 'link', source_url: 'https://www.printables.com/model/777-hinge' });
  assert.equal(sets.status, 200, JSON.stringify(sets.body));
  assert.equal(row<{ q: number }>(raw, 'SELECT quantity AS q FROM community_requests WHERE id = ?', many)!.q, 4);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_parts WHERE request_id = ?', many), 2);
});

test('merge on read: a file attached after the model was saved is a source at the end, and a source of a one-part job', async () => {
  const raw = world();
  const id = await draftWithFiles(raw);
  assert.equal((await saveDraft(raw, id, { schema_version: 3, parts: [{ name: 'Only', materials: [{ material_id: 'pla' }] }] })).status, 200);
  addFile(raw, id, 'crf_late', 'reference', 'late.png');
  const d = await readDraft(raw, id);
  assert.equal(d.schema_version, 3);
  assert.deepEqual(d.model.sources.map((s: Record<string, unknown>) => s.id), ['rps_crf_model', 'rps_crf_photo', 'rps_crf_late']);
  assert.ok(d.model.parts[0].source_ids.includes('rps_crf_late'));
});

test('deleting the primary model file keeps a v3 model fresh: the sources cascade, the part loses its measured file, the stamp is renewed', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const id = await draftWithFiles(raw, bucket);
  assert.equal((await saveDraft(raw, id, {
    schema_version: 3,
    sources: [{ kind: 'file', file_id: 'crf_model', is_primary: true }],
    parts: [{ process: 'fdm', measured_file_id: 'crf_model', materials: [{ material_id: 'pla' }] }],
  })).status, 200);
  const res = await as(raw, 'buyer', { bucket }).request(`/api/marketplace/requests/${id}/files/crf_model`, { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(res.status, 200, await res.text());
  const fresh = row<{ fresh: number; pf: string | null }>(raw, `SELECT (model_mirror = json_array(process, process_unsure, material_id, material_unsure, color_hex, color_name, colors_count, primary_file_id, source_type, source_kind, source_url, source_provider, stated_dims)) AS fresh, primary_file_id AS pf FROM community_print_requests WHERE request_id = ?`, id)!;
  assert.deepEqual({ ...fresh }, { fresh: 1, pf: null });
  const read = (await readRequestModel(asD1(raw), id))!;
  assert.equal(read.schema_version, 3);
  assert.deepEqual(read.sources.map((s) => s.id), ['rps_crf_photo']);
  assert.equal(read.parts[0].measured_file_id, null);
});

test('the repeat copies a v3 model onto the copied files, with new ids and every reference remapped', async () => {
  const raw = world();
  const bucket = new MemoryBucket();
  const id = await draftWithFiles(raw, bucket);
  assert.equal((await saveDraft(raw, id, twoPartBody())).status, 200);
  const res = await post(as(raw, 'buyer', { bucket }), `/api/marketplace/print/requests/${id}/repeat`);
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const copy = String((await json(res)).request_id);
  const a = (await readRequestModel(asD1(raw), id))!;
  const b = (await readRequestModel(asD1(raw), copy))!;
  assert.equal(b.schema_version, 3);
  const newFiles = b.modelFiles.map((f) => f.id);
  assert.equal(newFiles.length, 2);
  assert.ok(newFiles.every((f) => !['crf_model', 'crf_photo'].includes(f)), 'the copy points at its own copied files');
  assert.deepEqual(b.sources.filter((s) => s.file_id).map((s) => s.file_id).sort(), [...newFiles].sort());
  assert.ok(b.parts.every((p) => p.id.startsWith(`rpt_${copy}_`)));
  assert.equal(b.parts[0].measured_file_id, b.modelFiles.find((f) => f.file_name === 'base.stl')!.id, 'measured on the copy of the model');
  const ref = b.parts[1].materials[0].colors[1].ref;
  assert.equal(b.sources.find((s) => s.id === ref)?.kind, 'text_ref', 'the colour still points at the text reference');
  // The priced content is the same job, once each copied file is named by the file it copies.
  // (The copies' ids are random, so the sets are sorted again after renaming.)
  let copied = canonicalFactsV3(b);
  for (const f of b.modelFiles) copied = copied.split(f.id).join(a.modelFiles.find((x) => x.file_name === f.file_name)!.id);
  const resort = (s: string) => {
    const j = JSON.parse(s);
    const by = (x: unknown, y: unknown) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : JSON.stringify(x) > JSON.stringify(y) ? 1 : 0);
    j[2].sort(by);
    for (const part of j[3]) part[7].sort();
    j[3].sort(by);
    return JSON.stringify(j);
  };
  assert.equal(resort(copied), resort(canonicalFactsV3({ ...a, request: b.request })));
});

test('every refusal answers its own code, and sixteen colours are allowed', async () => {
  const raw = world();
  const id = await draftWithFiles(raw);
  const other = await newDraft(raw);
  addFile(raw, other, 'crf_foreign', 'model', 'theirs.stl');
  const part = (extra: Record<string, unknown> = {}) => ({ materials: [{ material_id: 'pla' }], ...extra });
  const colours = (n: number) => Array.from({ length: n }, () => ({ mode: 'any' }));
  const cases: Array<[string, Record<string, unknown>]> = [
    ['PARTS_EMPTY', { parts: [] }],
    ['PARTS_TOO_MANY', { parts: Array.from({ length: 13 }, () => part()) }],
    ['PART_MATERIALS_TOO_MANY', { parts: [{ materials: Array.from({ length: 5 }, () => ({ material_id: 'pla' })) }] }],
    ['COLOURS_TOO_MANY', { parts: [{ materials: [{ material_id: 'pla', colors: colours(17) }] }] }],
    ['LINKS_TOO_MANY', { sources: Array.from({ length: 5 }, (_, i) => ({ kind: 'link', url: `https://www.printables.com/model/${i + 1}-x` })) }],
    ['LINK_DUPLICATE', { sources: [{ kind: 'link', url: LINK }, { kind: 'link', url: 'https://www.printables.com/model/777-hinge' }] }],
    ['TEXT_REFS_TOO_MANY', { sources: Array.from({ length: 5 }, (_, i) => ({ kind: 'text_ref', ref_text: `ref ${i}` })) }],
    ['SOURCE_PRIMARY_MULTIPLE', { sources: [{ kind: 'file', file_id: 'crf_model', is_primary: true }, { kind: 'file', file_id: 'crf_photo', is_primary: true }] }],
    ['SOURCE_NOTE_TOO_LONG', { sources: [{ kind: 'file', file_id: 'crf_model', note: 'x'.repeat(501) }] }],
    ['PART_MEASURED_FILE_INVALID', { parts: [part({ measured_file_id: 'crf_photo' })] }],
    ['PART_SOURCE_INVALID', { parts: [part({ source_ids: ['rps_nowhere'] })] }],
    ['COLOUR_REF_INVALID', { parts: [{ materials: [{ material_id: 'pla', colors: [{ mode: 'as_reference', ref: 'tmp_missing' }] }] }] }],
    ['FILE_NOT_FOUND', { sources: [{ kind: 'file', file_id: 'crf_foreign' }] }],
    ['BAD_URL', { sources: [{ kind: 'link', url: 'javascript:alert(1)' }] }],
  ];
  for (const [code, body] of cases) {
    const res = await saveDraft(raw, id, { schema_version: 3, ...body });
    assert.equal(res.status, 400, `${code}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code, JSON.stringify(res.body));
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_parts WHERE request_id = ?', id), 0, 'no refusal wrote a row');
  const sixteen = await saveDraft(raw, id, { schema_version: 3, parts: [{ materials: [{ material_id: 'pla', colors: colours(16) }] }] });
  assert.equal(sixteen.status, 200, JSON.stringify(sixteen.body));
});

test('a database before 0208: a v1 publish works as it always did, the draft reads a synthesised model, and a v3 body is an honest 503', async () => {
  const raw = world('0207');
  const id = await newDraft(raw);
  const pub = await publish(raw, id, PLA);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const d = await readDraft(raw, id);
  assert.equal(d.schema_version, 1);
  assert.equal(d.model.origin, 'synthesized');
  const v3 = await publish(raw, id, { schema_version: 3, parts: [{ materials: [{ material_id: 'petg' }] }] });
  assert.equal(v3.status, 503);
  assert.equal(v3.body.code, 'REQUEST_MODEL_UNAVAILABLE');
  assert.equal(row<{ m: string }>(raw, 'SELECT material_id AS m FROM community_print_requests WHERE request_id = ?', id)!.m, 'pla', 'nothing was written');
  // The deploy then lands its migration; the same request is read the same way.
  apply0208(raw);
  const again = await readDraft(raw, id);
  assert.equal(again.schema_version, 1);
  assert.deepEqual(again.model, d.model);
});

test('a v3 save on a PUBLISHED request with an offer that changes a priced fact supersedes it; the revision diff names parts and sources', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, PLA)).status, 200);
  const offer = await offerOn(raw, id);
  const d = await readDraft(raw, id);
  const res = await publish(raw, id, {
    schema_version: 3,
    sources: [...d.model.sources, { kind: 'text_ref', ref_text: 'Match the old one' }],
    parts: d.model.parts.map((p: Record<string, unknown>) => ({ ...p, notes: 'thicker walls' })),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.revised, true);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offer.id)!.state, 'superseded');
  const revs = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/revisions`));
  const changes = revs.revisions[1].changes as string[];
  assert.ok(changes.includes('parts') && changes.includes('sources'), JSON.stringify(changes));
  assert.ok(!changes.includes('material_id'), 'the flat facts did not move');
});


