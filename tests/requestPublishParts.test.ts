/**
 * PUBLISHING A JOB OF PARTS (P1-05, docs/DECISIONS.md row 267, D2/D3).
 *
 * Real routes and migrations. Pinned: a multi-part job publishes, its
 * revision carries the model and its estimate the coverage; each combination
 * no workshop can print as asked — FDM and resin in one part, a resin part in
 * two materials, a material gone from the catalogue — is refused with its
 * code and the part, and nothing is written; a draft keeps it; and every new
 * code reads in Arabic, English and Sorani, the Sorani its own (→ 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, row } from './fixtures/app';
import { addFile, newDraft, publish, readDraft, saveDraft, world } from './fixtures/requestModelWorld';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { OFFER_COVERAGE_REFUSAL_CODES, REQUEST_PUBLISH_REFUSAL_CODES } from '../packages/contracts/src/requestModel';

const twoParts = {
  schema_version: 3,
  parts: [
    { name: 'Body', process: 'fdm', measured_file_id: 'crf_m', materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a' }] }] },
    { name: 'Grip', process: 'fdm', quantity: 2, materials: [{ material_id: 'tpu', colors: [{ mode: 'any' }] }] },
  ],
};

test('a multi-part job publishes: its revision carries the model, its estimate the coverage, its summary the parts', async () => {
  const raw = world();
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_m', 'model', 'body.stl');
  const res = await publish(raw, id, twoParts);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rev = row<{ spec: string; estimate: string }>(raw, 'SELECT spec, estimate FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!;
  const spec = JSON.parse(rev.spec);
  assert.equal(spec.schema_version, 3);
  assert.deepEqual(spec.model.parts.map((p: Record<string, unknown>) => p.name), ['Body', 'Grip']);
  const est = JSON.parse(rev.estimate);
  assert.equal(est.coverage.parts_total, 2);
  assert.ok(!JSON.stringify(est).includes('cost_'), 'the revision estimate is public');
  const p = row<Record<string, unknown>>(raw, 'SELECT parts_count, pieces_per_set, schema_version FROM community_print_requests WHERE request_id = ?', id)!;
  assert.deepEqual({ ...p }, { parts_count: 2, pieces_per_set: 3, schema_version: 3 });
});

const REFUSED: Array<[string, Record<string, unknown>]> = [
  ['PART_PROCESS_MIXED', { name: 'Mixed', materials: [{ material_id: 'pla' }, { material_id: 'resin-standard' }] }],
  ['PART_RESIN_MULTI_MATERIAL', { name: 'Two resins', materials: [{ material_id: 'resin-standard' }, { material_id: 'resin-tough' }] }],
  ['PART_MATERIAL_UNKNOWN', { name: 'Gone', materials: [{ material_id: 'unobtainium' }] }],
];

for (const [code, bad] of REFUSED) {
  test(`15: ${code} — refused at publish with the part named, nothing written; the draft keeps it`, async () => {
    const raw = world();
    const id = await newDraft(raw);
    const body = { schema_version: 3, parts: [{ name: 'Fine', process: 'fdm', materials: [{ material_id: 'pla' }] }, bad] };
    // A draft keeps any combination.
    const draft = await saveDraft(raw, id, body);
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const d = await readDraft(raw, id);
    const second = d.model.parts[1];

    const res = await publish(raw, id, body);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, code);
    assert.equal(res.body.details?.position ?? res.body.position, 1);
    assert.ok(typeof (res.body.details?.part_id ?? res.body.part_id) === 'string');
    assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', id)!.state, 'draft');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_revisions WHERE request_id = ?', id), 0);
    // The stored draft is as it was: the same parts, the same ids.
    const after = await readDraft(raw, id);
    assert.deepEqual(after.model.parts.map((p: Record<string, unknown>) => p.id), d.model.parts.map((p: Record<string, unknown>) => p.id));
    assert.equal(after.model.parts[1].materials.length, second.materials.length);
  });
}

test('15: every new code reads in Arabic, English and Sorani — the Sorani its own, in Sorani letters', () => {
  const SORANI = /[ەێۆڵڕ]/;
  for (const code of [...REQUEST_PUBLISH_REFUSAL_CODES, ...OFFER_COVERAGE_REFUSAL_CODES]) {
    const t = REFUSAL_STRINGS[code];
    assert.ok(t, `${code}: no words`);
    assert.ok(t.ar && t.en && t.ckb, `${code}: a language is missing`);
    assert.notEqual(t.ckb, t.ar, `${code}: the Sorani is the Arabic pasted across`);
    assert.ok(SORANI.test(t.ckb), `${code}: the Sorani uses no Sorani letter`);
    assert.ok(!/[ەێۆڵڕ]/.test(t.ar), `${code}: the Arabic carries Sorani letters`);
    assert.ok(/^[\x20-\x7e—’]+$/.test(t.en), `${code}: the English is not English`);
  }
  // The old code stays answerable: an older build still sends it.
  assert.ok(REFUSAL_STRINGS.REQUEST_PARTS_NOT_YET?.ckb);
});
