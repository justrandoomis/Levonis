/**
 * WHAT A REQUEST MODEL SHOWS, AND TO WHOM (P1-04, owner decision Q5,
 * conflicts 5 and 62; docs/DECISIONS.md row 266).
 *
 * Pinned: the public and merchant projections carry no provenance
 * (`origin_*`), no digest (`sha256`), no customer identity and no budget, and
 * no file the customer marked as the SOURCE; a revision's model is
 * re-projected for a reader who is not a party; and a `source` file is
 * refused to a merchant who may only offer — bytes and preview — and served
 * to the merchant whose offer was accepted. No projection below `accepted`
 * names an original as a source, a measured model or a colour reference; the
 * v1 mirror never makes one its link or its `primary_file_id`; and the read of
 * the roles fails closed on any error but a missing schema.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBucket, asD1, get, json, post, row } from './fixtures/app';
import { fileSourceRoles, mirrorFromModel, projectModel, projectSpec, readRequestModel, synthesizeModel, type ModelState } from '../worker/lib/requestModel';
import { addFile, as, fund, newDraft, offerOn, publish, world } from './fixtures/requestModelWorld';

async function withSourceFile() {
  const raw = world();
  const bucket = new MemoryBucket();
  fund(raw, 'buyer', 1_000_000);
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_look', 'reference', 'look.png', { bucket });
  addFile(raw, id, 'crf_src', 'reference', 'design-source.png', { bucket });
  const res = await publish(raw, id, {
    schema_version: 3,
    sources: [
      { kind: 'file', file_id: 'crf_look', is_primary: true, note: 'what it looks like' },
      { kind: 'file', file_id: 'crf_src', role: 'source', note: 'the editable original' },
    ],
    // «As in the reference» — taken from the original: no reader below `accepted` may see which one.
    parts: [{ name: 'Badge', process: 'fdm', materials: [{ material_id: 'pla', colors: [{ mode: 'as_reference', ref: 'rps_crf_src' }] }] }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // Provenance as a server handoff would record it (P1-06): never shown beyond the customer and an admin.
  raw.exec(`UPDATE community_request_sources SET origin_id = 'post_123', origin_meta = '{"author":"someone"}', sha256 = '${'a'.repeat(64)}' WHERE file_id = 'crf_look'`);
  return { raw, bucket, id };
}

test('the public and merchant projections carry no provenance, no digest, no customer identity, no budget and no SOURCE file', async () => {
  const { raw, id } = await withSourceFile();
  const read = (await readRequestModel(asD1(raw), id))!;
  for (const audience of ['public', 'merchant'] as const) {
    const p = projectModel(read, audience);
    const text = JSON.stringify(p);
    assert.doesNotMatch(text, /origin_|sha256|post_123|someone/, audience);
    assert.doesNotMatch(text, /buyer|Sara|customer_id|budget/, audience);
    const sources = p.sources as Array<{ file_id: string | null }>;
    assert.deepEqual(sources.map((s) => s.file_id), ['crf_look'], audience);
    assert.ok((p.parts as Array<{ source_ids: string[] }>).every((x) => !x.source_ids.includes('rps_crf_src')));
  }
  const accepted = JSON.stringify(projectModel(read, 'accepted'));
  assert.match(accepted, /crf_src/, 'the accepted merchant receives the source (Q5)');
  assert.doesNotMatch(accepted, /origin_|sha256/);
  const owner = JSON.stringify(projectModel(read, 'owner'));
  assert.match(owner, /post_123/, 'the customer sees where a copy came from');
});

test("a revision's model holds no provenance, and the board reader's copy is re-projected without the SOURCE file", async () => {
  const { raw, id } = await withSourceFile();
  // A later save records the provenance-bearing model in the revision; it must not carry it.
  assert.equal((await publish(raw, id, { schema_version: 3, quantity: 2 })).status, 200);
  const spec = JSON.parse(row<{ spec: string }>(raw, 'SELECT spec FROM community_request_revisions WHERE request_id = ?', id)!.spec);
  assert.doesNotMatch(JSON.stringify(spec.model), /origin_|sha256|post_123/);
  assert.match(JSON.stringify(spec.model), /rps_crf_src/, 'the snapshot itself carries the original, for the accepted merchant');
  const board = projectSpec(spec, 'public');
  assert.doesNotMatch(JSON.stringify(board.model), /crf_src/, 'not as a source, a part source or a colour reference');
  // Through the route: the eligible merchant reads the current revision without it; the customer with it.
  const asMerchant = await json(await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}/revisions`));
  assert.doesNotMatch(JSON.stringify(asMerchant.revisions.map((r: { spec: unknown }) => r.spec)), /rps_crf_src/);
  const asOwner = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/revisions`));
  assert.match(JSON.stringify(asOwner.revisions.map((r: { spec: unknown }) => r.spec)), /rps_crf_src/);
});

test('Q5: a SOURCE file is refused to a merchant who may only offer, and served to the merchant whose offer was accepted', async () => {
  const { raw, bucket, id } = await withSourceFile();
  const eligible = as(raw, 'owner', { bucket });
  const refused = await get(eligible, `/api/marketplace/requests/${id}/files/crf_src`);
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'FILE_ORIGINAL_RESTRICTED');
  assert.equal((await get(eligible, `/api/marketplace/requests/${id}/files/crf_look`)).status, 200, 'a reference picture stays readable');
  const list = await json(await get(eligible, `/api/marketplace/requests/${id}`));
  const files = list.files as Array<{ id: string; url: string | null; access: string }>;
  assert.deepEqual(files.find((f) => f.id === 'crf_src'), { ...files.find((f) => f.id === 'crf_src')!, url: null, access: 'none' });

  const offer = await offerOn(raw, id, 15_000);
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offer.id}/accept`, { expected_total_iqd: 15_000, offer_revision: offer.revision });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  assert.equal((await get(as(raw, 'owner', { bucket }), `/api/marketplace/requests/${id}/files/crf_src`)).status, 200, 'the accepted merchant reads the source');
  assert.equal((await get(as(raw, 'buyer', { bucket }), `/api/marketplace/requests/${id}/files/crf_src`)).status, 200, 'and the customer, always');
});

/** A one-part model whose original is BOTH the measured file and a colour's reference — as older tables could hold it. */
function originalEverywhere(): ModelState {
  const files = [
    { id: 'crf_look', kind: 'reference', content_type: 'image/png', size_bytes: 1, file_name: 'look.png', created_at: '1', sha256: '', analysis: '' },
    { id: 'crf_src', kind: 'model', content_type: 'model/stl', size_bytes: 1, file_name: 'design-source.stl', created_at: '2', sha256: '', analysis: '' },
  ];
  const m = synthesizeModel(
    { id: 'req_x', quantity: 1 },
    { process: 'fdm', material_id: 'pla', colors_count: 1, primary_file_id: 'crf_src', source_type: 'model', source_kind: 'upload', source_url: '' },
    files
  );
  const src = m.sources.find((x) => x.file_id === 'crf_src')!;
  src.role = 'source';
  m.sources.push({ ...src, id: 'rps_link', kind: 'link', file_id: null, url: 'https://www.printables.com/model/1-secret', canonical_url: 'https://www.printables.com/model/1-secret', role: 'source' });
  m.parts[0].materials[0].colors = [{ mode: 'as_reference', hex: '', label: '', palette: '', ref: src.id }];
  return m;
}

test('the projections name no original as a measured model or a colour reference, whichever way the model got there', () => {
  const m = originalEverywhere();
  for (const audience of ['public', 'merchant'] as const) {
    const text = JSON.stringify(projectModel(m, audience));
    assert.doesNotMatch(text, /crf_src|1-secret/, audience);
  }
  assert.match(JSON.stringify(projectModel(m, 'accepted')), /crf_src/, 'the accepted merchant reads it all');
  const spec = { model: projectModel({ ...m, schema_version: 3 }, 'snapshot') };
  assert.doesNotMatch(JSON.stringify(projectSpec(spec, 'public').model), /crf_src|1-secret/);
});

test('the v1 mirror never takes an original as its link or its primary file', () => {
  const m = originalEverywhere();
  m.job.source_type = 'link';
  const asLink = mirrorFromModel(m, [{ id: 'crf_look', kind: 'reference' }, { id: 'crf_src', kind: 'model' }]);
  assert.equal(asLink.source_url, '');
  assert.equal(asLink.primary_file_id, null);
});

test('the roles read fails CLOSED: only a missing schema reads as «no roles»; any other error is thrown', async () => {
  const failing = (message: string) =>
    ({ prepare: () => ({ bind: () => ({ all: async () => { throw new Error(message); } }) }) }) as unknown as D1Database;
  assert.deepEqual([...(await fileSourceRoles(failing('D1_ERROR: no such table: community_request_sources: SQLITE_ERROR'), 'r'))], []);
  await assert.rejects(fileSourceRoles(failing('D1_ERROR: Network connection lost.'), 'r'), /Network connection lost/);
});
