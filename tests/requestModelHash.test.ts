/**
 * THE HASH FOLLOWS THE VERSION (P1-04, acceptance 20; docs/DECISIONS.md row 266).
 *
 * A pending offer was priced against a revision whose hash is the v1
 * canonical string. Pinned here, before and after migration 0208's code:
 *
 *   - the v1 string of every class in the corpus, as LITERALS captured from
 *     the code before this change (and from the frozen 58cd8ce4 readers in
 *     tests/fixtures/v1RequestReaders.ts) — byte for byte, with its sha256;
 *   - the read path gives version-1 requests exactly that string;
 *   - the v3 string is version-tagged, ignores what nobody prices (ids,
 *     positions, part names, palette keys, defaults written explicitly) and
 *     moves for what is priced (notes, the primary, colour order, a finish);
 *   - through the routes: a first v3 save that changes nothing priced flips
 *     the version and keeps the revision and the pending offer; a real change
 *     revises and supersedes; an unpriced change (a part's name, the budget's
 *     visibility) does neither.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { V1_CORPUS, type V1Fixture } from './fixtures/v1RequestCorpus';
import * as frozen from './fixtures/v1RequestReaders';
import { canonicalFacts, canonicalFor, factsFromRows, factsHash } from '../worker/lib/requestRevisions';
import { canonicalFactsV3, synthesizeModel, type ModelState } from '../worker/lib/requestModel';
import { count, row } from './fixtures/app';
import { PLA, newDraft, offerOn, publish, readDraft, world } from './fixtures/requestModelWorld';

/** Captured from worker/lib/requestRevisions.ts BEFORE any P1-04 code existed. Never edit to make a test pass. */
const GOLDEN: Record<string, { canonical: string; sha256: string }> = {
  req_model: {
    canonical: "[2,\"model\",\"fdm\",\"pla\",\"#d32f2f\",\"Red\",\"standard\",20,true,1,0,\"crf_m1\",\"\",null,\"erbil\",\"\",\"\",\"keep the holes clean\",[\"crf_i1\",\"crf_m1\"]]",
    sha256: "0704475cb3a0f9e23d13bbcc0bcc49ade1ba098662bc301a491d38ed121c0e54",
  },
  req_link: {
    canonical: "[1,\"link\",null,null,\"\",\"\",\"standard\",20,true,1,0,null,\"https://www.printables.com/model/12345-shelf-bracket\",null,\"baghdad\",\"pickup\",\"2026-12-01\",\"\",[]]",
    sha256: "6f88d04394a3aa89decc6adcdfdb9cf05dbc95cd1c43fe0d063256a9d5848750",
  },
  req_images: {
    canonical: "[5,\"images\",\"fdm\",\"petg\",\"\",\"\",\"standard\",20,true,3,0,null,\"\",null,\"baghdad\",\"\",\"\",\"\",[\"crf_i2\",\"crf_i3\"]]",
    sha256: "e21d7b8779fab14fdb72a625306742678b44902d5f0ceeb613c94e964130273a",
  },
  req_desc: {
    canonical: "[1,\"description\",\"fdm\",\"abs\",\"\",\"Navy\",\"standard\",20,true,1,0,null,\"\",null,\"baghdad\",\"\",\"\",\"\",[]]",
    sha256: "314436cd091354bc52b3987da64b2694d38cedf9cda60caaec24740c52640817",
  },
  req_resin: {
    canonical: "[1,\"description\",\"resin\",\"resin-standard\",\"#abcdef\",\"\",\"fine\",100,false,1,30,null,\"\",[40,25.5,12],\"baghdad\",\"\",\"\",\"\",[]]",
    sha256: "9e477d99214d00c9069a0cfedb973ad862d95d336fb1b689bb5da1f2e4f4cc58",
  },
  req_pre130: {
    canonical: "[1,\"model\",\"fdm\",\"pla\",\"\",\"\",\"standard\",20,true,1,0,\"crf_m2\",\"https://www.thingiverse.com/thing:999\",null,\"baghdad\",\"\",\"\",\"\",[\"crf_m2\"]]",
    sha256: "9d5e09a73e4b7153e8f5fd69b5e526681cf86d592802b699017fcba042f6872e",
  },
  req_pre130_link: {
    canonical: "[1,\"link\",\"fdm\",\"pla\",\"\",\"\",\"standard\",20,true,1,0,null,\"https://www.thingiverse.com/thing:1001\",null,\"baghdad\",\"\",\"\",\"\",[]]",
    sha256: "853d771d15dc415b8dbe4be1ac501a4a052b6e5f13178eed0ff94957a5de8515",
  },
  req_red_word: {
    canonical: "[1,\"description\",\"fdm\",\"pla\",\"#ee1111\",\"Red\",\"standard\",20,true,1,0,null,\"\",null,\"baghdad\",\"\",\"\",\"\",[]]",
    sha256: "6aa9f1af1e9175bc0709895a095ee063410db459ca7221275a099adfe6256ea0",
  },
  req_images_model: {
    canonical: "[1,\"images\",\"fdm\",\"pla\",\"#1976d2\",\"Blue\",\"standard\",20,true,2,0,\"crf_m3\",\"\",null,\"baghdad\",\"\",\"\",\"\",[\"crf_i4\",\"crf_m3\"]]",
    sha256: "0e7676a7fd0ea1c8dad1d9ef2e609aefee3aa206126c0fa4226b6712db201b52",
  },
  req_sixteen: {
    canonical: "[1,\"description\",\"fdm\",\"pla\",\"\",\"\",\"standard\",20,true,16,0,null,\"\",null,\"baghdad\",\"\",\"\",\"\",[]]",
    sha256: "b7fa8e9430a7fd5783170898b011473ac993174a4fe1d464f604104ee53b7fa7",
  },
  req_resin_unsure: {
    canonical: "[1,\"description\",null,null,\"\",\"\",\"standard\",20,true,1,0,null,\"\",null,\"baghdad\",\"\",\"\",\"\",[\"crf_d1\"]]",
    sha256: "a9306fa21f6cf4020f8a1aa7e9a830a51ca790c43acec77d2b401fcb6aeae3bf",
  },
  req_derived_images: {
    canonical: "[1,\"images\",\"fdm\",\"pla\",\"\",\"\",\"standard\",20,true,1,0,null,\"\",null,\"baghdad\",\"\",\"\",\"\",[\"crf_i5\"]]",
    sha256: "88d37ea747dd8d4b49f48966f03c3c83a499026116943b2218b0f4c58f0eaba1",
  },
  req_chat: {
    canonical: "[1,\"images\",null,null,\"\",\"\",\"standard\",20,true,1,0,null,\"\",null,\"baghdad\",\"\",\"\",\"\",[\"crf_c1\"]]",
    sha256: "ca176aac44bf3c9a7b17ffd10e40b44b1ab2adec6630b78c77d83c04b033ef48",
  },
};

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const filesOf = (f: V1Fixture) => f.files.map((x, i) => ({ ...x, created_at: `2026-10-01T00:00:0${i}.000Z`, sha256: '', analysis: '' }));

test('every v1 fixture hashes to its captured literal, through the live code AND the frozen 58cd8ce4 readers', async () => {
  assert.equal(Object.keys(GOLDEN).length, V1_CORPUS.length);
  for (const f of V1_CORPUS) {
    const g = GOLDEN[String(f.r.id)];
    const live = canonicalFacts(factsFromRows(f.r, f.p, f.files));
    const old = frozen.canonicalFacts(frozen.factsFromRows(f.r, f.p, f.files));
    assert.equal(live, g.canonical, f.name);
    assert.equal(old, g.canonical, f.name);
    assert.equal(await factsHash(factsFromRows(f.r, f.p, f.files)), g.sha256, f.name);
    assert.equal(frozen.v1Sha256(old), g.sha256, f.name);
  }
});

test('canonicalFor a version-1 read is the v1 string, never the v3 one — whatever rows a cache holds', () => {
  for (const f of V1_CORPUS) {
    const m = synthesizeModel(f.r, f.p, filesOf(f));
    const read = { ...m, schema_version: 1 as const, v1: factsFromRows(f.r, f.p, f.files) };
    assert.equal(canonicalFor(read), GOLDEN[String(f.r.id)].canonical, f.name);
    assert.equal(canonicalFor({ ...read, schema_version: 3 }), canonicalFactsV3(m), f.name);
  }
});

test('the v3 string is version-tagged and can never equal a v1 string', () => {
  for (const f of V1_CORPUS) {
    const v3 = canonicalFactsV3(synthesizeModel(f.r, f.p, filesOf(f)));
    assert.ok(v3.startsWith('["v3",'), v3.slice(0, 20));
    for (const g of Object.values(GOLDEN)) assert.notEqual(v3, g.canonical);
    assert.match(GOLDEN[String(f.r.id)].canonical, /^\[\d/, 'a v1 string always opens with a number');
  }
});

// ------------------------------------------------------------ what v3 prices

const base = (): ModelState => {
  const f = V1_CORPUS.find((x) => x.r.id === 'req_model')!;
  const m = synthesizeModel(f.r, f.p, filesOf(f));
  m.sources.push({
    ...m.sources[0], id: 'rps_link_1', kind: 'link', file_id: null, url: 'https://www.printables.com/model/1-a', canonical_url: 'https://www.printables.com/model/1-a',
    provider: 'printables', is_primary: false, note: 'the hinge is on this page',
  });
  m.parts.push({
    ...m.parts[0], id: 'rpt_two', name: 'Lid', notes: 'snap fit', source_ids: ['rps_link_1'],
    materials: [{ ...m.parts[0].materials[0], id: 'rpm_two', material_id: 'petg', colors: [{ mode: 'custom', hex: '#123456', label: 'Teal', palette: '', ref: '' }, { mode: 'any', hex: '', label: '', palette: '', ref: '' }] }],
  });
  return m;
};
const v3 = (m: ModelState) => canonicalFactsV3(m);
const clone = (m: ModelState): ModelState => JSON.parse(JSON.stringify(m));

test('v3 ignores what nobody prices: ids, positions, order of sources, parts and materials, part names, palette keys, explicit defaults', () => {
  const m = base();
  const h = v3(m);
  const renamed = clone(m);
  renamed.parts[0].name = 'Bracket';
  renamed.parts[1].name = 'Top lid';
  assert.equal(v3(renamed), h, 'a part name is not priced');

  const reordered = clone(m);
  reordered.sources.reverse();
  reordered.parts.reverse();
  reordered.sources.forEach((s, i) => (s.position = i));
  assert.equal(v3(reordered), h, 'sources and parts are sets');

  const reid = clone(m);
  const map = new Map(reid.sources.map((s, i) => [s.id, `rps_new_${i}`]));
  reid.sources.forEach((s) => (s.id = map.get(s.id)!));
  reid.parts.forEach((p, i) => { p.id = `rpt_new_${i}`; p.source_ids = p.source_ids.map((x) => map.get(x)!); p.materials.forEach((x, k) => (x.id = `rpm_new_${i}_${k}`)); });
  assert.equal(v3(reid), h, 'ids are not priced');

  const explicit = clone(m);
  explicit.sources.forEach((s) => (s.role = 'reference'));
  explicit.parts.forEach((p) => p.materials.forEach((x) => (x.finish = 'standard')));
  explicit.parts[0].materials[0].colors[0] = { ...explicit.parts[0].materials[0].colors[0], mode: 'custom', palette: '' };
  explicit.parts[1].materials[0].colors[0] = { ...explicit.parts[1].materials[0].colors[0], hex: '#123456'.toUpperCase(), label: ' Teal ' };
  assert.equal(v3(explicit), h, "role '' is the kind's default, finish '' is standard, catalogue and custom are one named colour, hex case and padding are noise");

  const noColours = clone(m);
  noColours.parts[0].materials[0].colors = [];
  const anyColour = clone(m);
  anyColour.parts[0].materials[0].colors = [{ mode: 'any', hex: '#ffffff', label: 'ignored', palette: '', ref: '' }];
  assert.equal(v3(noColours), v3(anyColour), 'no colour at all is «any colour»');
});

test('v3 moves for what IS priced: a note, the primary, colour order, a finish, the measured file, a part quantity, the job', () => {
  const m = base();
  const h = v3(m);
  const variants: Array<[string, (x: ModelState) => void]> = [
    ['a source note', (x) => (x.sources[1].note = 'use the other hinge')],
    ['the primary', (x) => { x.sources[0].is_primary = false; x.sources[2].is_primary = true; }],
    ['colour order', (x) => x.parts[1].materials[0].colors.reverse()],
    ['a finish', (x) => (x.parts[0].materials[0].finish = 'sanded')],
    ['the measured file', (x) => (x.parts[0].measured_file_id = null)],
    ['pieces per set', (x) => (x.parts[1].quantity = 4)],
    ['a part note', (x) => (x.parts[1].notes = 'press fit')],
    ['a role', (x) => (x.sources[0].role = 'source')],
    ['a material', (x) => (x.parts[1].materials[0].material_id = 'abs')],
    ['sets', (x) => (x.job.quantity = 3)],
    ['the source type', (x) => (x.job.source_type = 'link')],
    ['the customer notes', (x) => (x.request.customer_notes = 'something else')],
  ];
  for (const [what, change] of variants) {
    const x = clone(m);
    change(x);
    assert.notEqual(v3(x), h, what);
  }
});

// ------------------------------------------------------- through the routes

async function publishedWithOffer() {
  const raw = world();
  const id = await newDraft(raw);
  const pub = await publish(raw, id, { ...PLA, color_hex: '#d32f2f', color_name: 'Red', customer_notes: 'thanks' });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const offer = await offerOn(raw, id);
  return { raw, id, offer };
}

test('a first v3 save that changes nothing priced: version 3, the SAME revision, the offer still pending, answered replayed', async () => {
  const { raw, id, offer } = await publishedWithOffer();
  const before = row<{ hash: string; spec: string }>(raw, 'SELECT hash, spec FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!;
  // Revision 1 carries the v1 hash of the row as the frozen 58cd8ce4 readers read it.
  const r1 = row<Record<string, unknown>>(raw, 'SELECT * FROM community_requests WHERE id = ?', id)!;
  const p1 = row<Record<string, unknown>>(raw, 'SELECT * FROM community_print_requests WHERE request_id = ?', id)!;
  assert.equal(before.hash, sha(frozen.canonicalFacts(frozen.factsFromRows(r1, p1, []))));
  const draft = await readDraft(raw, id);
  assert.equal(draft.schema_version, 1);
  const res = await publish(raw, id, { schema_version: 3, sources: draft.model.sources, parts: draft.model.parts });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.replayed, true);
  assert.equal(res.body.revised, false);
  assert.equal(res.body.revision, 1);
  assert.equal(row<{ v: number }>(raw, 'SELECT schema_version AS v FROM community_print_requests WHERE request_id = ?', id)!.v, 3);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offer.id)!.state, 'pending');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_revisions WHERE request_id = ?', id), 1);
  // The current revision is rewritten in place with the v3 hash and the model; its flat v1 facts did not move.
  const after = row<{ hash: string; spec: string }>(raw, 'SELECT hash, spec FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!;
  const spec = JSON.parse(after.spec);
  assert.equal(spec.schema_version, 3);
  assert.ok(spec.model && Array.isArray(spec.model.parts));
  assert.notEqual(after.hash, before.hash);
  const flat = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'model' && k !== 'schema_version'));
  assert.deepEqual(flat(spec), flat(JSON.parse(before.spec)));
  // The pending offer is still acceptable: it priced the revision that is current.
  const o = row<{ request_revision: number }>(raw, 'SELECT request_revision FROM community_offers WHERE id = ?', offer.id)!;
  assert.equal(o.request_revision, 1);
});

test('after the first v3 save, a real change (a part note) revises and supersedes; re-sending it again is a replay', async () => {
  const { raw, id, offer } = await publishedWithOffer();
  const draft = await readDraft(raw, id);
  assert.equal((await publish(raw, id, { schema_version: 3, sources: draft.model.sources, parts: draft.model.parts })).body.replayed, true);
  const parts = draft.model.parts.map((p: Record<string, unknown>) => ({ ...p, notes: 'leave the support marks off the face' }));
  const changed = await publish(raw, id, { schema_version: 3, parts });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.revised, true);
  assert.equal(changed.body.revision, 2);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offer.id)!.state, 'superseded');
  const again = await publish(raw, id, { schema_version: 3, parts });
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.revision, 2);
});

test('an unpriced change — a part name, the budget shown to merchants — keeps the revision and the offer', async () => {
  const { raw, id, offer } = await publishedWithOffer();
  const draft = await readDraft(raw, id);
  const parts = draft.model.parts.map((p: Record<string, unknown>) => ({ ...p, name: 'Shelf bracket' }));
  const res = await publish(raw, id, { schema_version: 3, parts, budget_visible: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.replayed, true);
  assert.equal(res.body.revision, 1);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offer.id)!.state, 'pending');
  assert.equal(row<{ name: string }>(raw, 'SELECT name FROM community_request_parts WHERE request_id = ?', id)!.name, 'Shelf bracket');
  assert.equal(row<{ v: number }>(raw, 'SELECT budget_visible AS v FROM community_requests WHERE id = ?', id)!.v, 1);
});
