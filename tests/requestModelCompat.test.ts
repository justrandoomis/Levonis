/**
 * BOTH BUILDS READ EVERY REQUEST COHERENTLY (P1-04, «done when»; docs/
 * DECISIONS.md row 266).
 *
 * The older build is represented by the FROZEN 58cd8ce4 readers
 * (tests/fixtures/v1RequestReaders.ts, never edited) and, where it acts, by
 * the v1 path of the routes, which is the 58cd8ce4 code unchanged — reached by
 * showing the row to it as the older build sees it (an older build has no
 * `schema_version`).
 *
 *   new build, old rows   the read path's v1 facts, its hash and its snapshot
 *                         hash are the frozen readers' for every corpus class.
 *   old build, new rows   a v3 row's v1 columns read, through the frozen
 *                         readers, as the job the model's mirror says; the old
 *                         build's as-stored republish is a replay; an old
 *                         client's as-stored body sent to the NEW build is a
 *                         replay too; an older build's edit makes the model
 *                         stale and the new build follows the v1 row (and
 *                         hashes it as the older build did); its offers cover
 *                         the whole request; an order accepted on a v3
 *                         revision still carries the flat v1 fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as frozen from './fixtures/v1RequestReaders';
import { V1_CORPUS } from './fixtures/v1RequestCorpus';
import { asD1, get, json, post, row } from './fixtures/app';
import { canonicalFor, composeSnapshot } from '../worker/lib/requestRevisions';
import { mirrorFacts, readRequestModel, synthesizeModel } from '../worker/lib/requestModel';
import { addFile, as, fund, newDraft, offerOn, publish, readDraft, world } from './fixtures/requestModelWorld';

test('new build, old rows: the read path gives every corpus class the frozen v1 facts and hash', () => {
  for (const f of V1_CORPUS) {
    const files = f.files.map((x, i) => ({ ...x, created_at: `2026-10-01T00:00:0${i}.000Z`, sha256: '', analysis: '' }));
    const m = synthesizeModel(f.r, f.p, files);
    const read = { ...m, schema_version: 1 as const, v1: frozen.factsFromRows(f.r, f.p, f.files) as never };
    assert.equal(canonicalFor(read), frozen.canonicalFacts(frozen.factsFromRows(f.r, f.p, f.files)), f.name);
  }
});

async function v3Published() {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_m', 'model', 'bracket.stl');
  addFile(raw, id, 'crf_p', 'reference', 'look.png');
  const res = await publish(raw, id, {
    schema_version: 3,
    customer_notes: 'by Friday if possible',
    sources: [
      { kind: 'file', file_id: 'crf_m', is_primary: true, note: 'the part' },
      { kind: 'link', url: 'https://www.printables.com/model/4242-bracket', note: 'the original design' },
      { kind: 'text_ref', ref_text: 'Same as the one on my balcony' },
    ],
    parts: [{ name: 'Bracket', process: 'fdm', measured_file_id: 'crf_m', stated_dimensions_mm: { x: 80, y: 40, z: 20 }, materials: [{ material_id: 'petg', colors: [{ mode: 'custom', hex: '#334455', label: 'Slate' }], finish: 'sanded' }] }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { raw, id };
}

test('old build, new rows: a v3 row reads, through the frozen readers, as exactly the job its mirror describes', async () => {
  const { raw, id } = await v3Published();
  const read = (await readRequestModel(asD1(raw), id))!;
  assert.equal(read.schema_version, 3);
  const r = row<Record<string, unknown>>(raw, 'SELECT * FROM community_requests WHERE id = ?', id)!;
  const p = row<Record<string, unknown>>(raw, 'SELECT * FROM community_print_requests WHERE request_id = ?', id)!;
  const old = frozen.factsFromRows(r, p, read.files);
  assert.equal(frozen.canonicalFacts(old), frozen.canonicalFacts(mirrorFacts(read, read.files) as never));
  // The single job an older build sees: the material, the one colour, the measured model, the typed size.
  assert.deepEqual(
    [old.source_type, old.process, old.material_id, old.color_hex, old.color_name, old.colors_count, old.primary_file_id, old.source_url, old.stated_dims],
    ['model', 'fdm', 'petg', '#334455', 'Slate', 1, 'crf_m', '', { x: 80, y: 40, z: 20 }]
  );
  // An old order screen reads the revision's flat fields: they are all still there, at the top level.
  const spec = JSON.parse(row<{ spec: string }>(raw, 'SELECT spec FROM community_request_revisions WHERE request_id = ?', id)!.spec);
  const flat = frozen.snapshotSpec(r, old, null);
  for (const k of Object.keys(flat)) assert.ok(k in spec, k);
});

test("an old client's as-stored body (the frozen storedPublishBody) sent to the new build on a v3 request is a replay", async () => {
  const { raw, id } = await v3Published();
  const offer = await offerOn(raw, id);
  const r = row<Record<string, unknown>>(raw, 'SELECT * FROM community_requests WHERE id = ?', id)!;
  const p = row<Record<string, unknown>>(raw, 'SELECT * FROM community_print_requests WHERE request_id = ?', id)!;
  const res = await publish(raw, id, frozen.storedPublishBody(p, r));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.replayed, true);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offer.id)!.state, 'pending');
  const d = await readDraft(raw, id);
  assert.equal(d.schema_version, 3, 'still version 3, every source and note kept');
  assert.deepEqual(d.model.sources.map((s: { kind: string; note: string }) => [s.kind, s.note]), [
    ['file', 'the part'], ['link', 'the original design'], ['text_ref', ''], ['file', ''],
  ]);
});

test('old build, new rows: its as-stored republish is a replay; its offer covers the whole request; an accepted v3 revision is frozen whole', async () => {
  const { raw, id } = await v3Published();
  const hash = row<{ hash: string }>(raw, 'SELECT hash FROM community_request_revisions WHERE request_id = ?', id)!.hash;
  const offer = await offerOn(raw, id, 33_000);
  assert.deepEqual(
    { ...row<Record<string, unknown>>(raw, 'SELECT coverage_json, covers_all FROM community_offers WHERE id = ?', offer.id)! },
    { coverage_json: null, covers_all: 1 }
  );
  // Accept: the order freezes the v3 revision — its hash, its model, and the flat fields beside it.
  const offers = (await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}/offers`))).offers as Array<{ id: string; revision: number; price_iqd: number }>;
  const o = offers.find((x) => x.id === offer.id)!;
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offer.id}/accept`, { expected_total_iqd: o.price_iqd, offer_revision: o.revision });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const snap = JSON.parse(row<{ s: string }>(raw, 'SELECT request_snapshot AS s FROM community_orders WHERE request_id = ?', id)!.s);
  assert.equal(snap.hash, hash);
  assert.equal(snap.spec.schema_version, 3);
  assert.equal(snap.spec.material_id, 'petg');
  assert.ok(Array.isArray(snap.spec.model.parts));
});

test('rollback: an older build edits a v3 row — the new build reads the v1 row it now is (stale), and hashes it as the older build did', async () => {
  const { raw, id } = await v3Published();
  // What the older build's publish writes: the v1 row, nothing of the model.
  raw.exec(`UPDATE community_print_requests SET material_id = 'abs', color_hex = '', color_name = '', colors_count = 2, updated_at = '2026-10-21T00:00:00.000Z' WHERE request_id = '${id}'`);
  const read = (await readRequestModel(asD1(raw), id))!;
  assert.deepEqual([read.schema_version, read.stored_version, read.stale], [1, 3, true]);
  const r = row<Record<string, unknown>>(raw, 'SELECT * FROM community_requests WHERE id = ?', id)!;
  const p = row<Record<string, unknown>>(raw, 'SELECT * FROM community_print_requests WHERE request_id = ?', id)!;
  assert.equal(canonicalFor(read), frozen.canonicalFacts(frozen.factsFromRows(r, p, read.files)));
  assert.equal((await composeSnapshot(asD1(raw), id))!.hash, frozen.v1Sha256(frozen.canonicalFacts(frozen.factsFromRows(r, p, read.files))));
  assert.equal(read.parts[0].materials[0].material_id, 'abs', 'the part is the v1 row as the older build left it');
  // The older build attaching a file: merged into the model on the next read, whatever the version.
  addFile(raw, id, 'crf_late', 'reference', 'late.png');
  assert.ok((await readRequestModel(asD1(raw), id))!.sources.some((s) => s.file_id === 'crf_late'));
});

test('old build, new rows: the older build republishing a v3 request as stored — its own v1 path — is a replay', async () => {
  const { raw, id } = await v3Published();
  const offer = await offerOn(raw, id);
  // An older build sees no schema_version: show the row to the v1 path exactly as it would see it.
  raw.exec(`UPDATE community_print_requests SET schema_version = 1 WHERE request_id = '${id}'`);
  const res = await publish(raw, id, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.replayed, true);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offer.id)!.state, 'pending');
});
