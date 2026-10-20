/**
 * THE V3 MODEL OF A V1 ROW (P1-04, docs/DECISIONS.md row 266) — synthesis,
 * on the anonymised legacy corpus (tests/fixtures/v1RequestCorpus.ts).
 *
 * Pinned here: each class of request synthesises to the model the design
 * table says; a chat or direct request keeps its free text verbatim and is
 * never parsed into a catalogue id; three colours with none chosen is three
 * colour slots and a technical review; the ids are deterministic; a model
 * synthesised on read equals the one the job materialises; the mirror of a
 * synthesised model hashes to the row it came from (the round trip), with the
 * one class of row from before 0130 that cannot; and the no-op property that
 * protects every pending offer when the v3 editor ships — the owner's
 * projection of a model, sent back unchanged, hashes the same.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V1_CORPUS, type V1Fixture } from './fixtures/v1RequestCorpus';
import { canonicalFacts, factsFromRows } from '../worker/lib/requestRevisions';
import {
  canonicalFactsV3,
  mergeFiles,
  mirrorFacts,
  modelFromTables,
  modelWriteStatements,
  projectModel,
  readModelInput,
  readRequestModel,
  summarize,
  synthesizeModel,
  type ModelFile,
  type RequestModelRead,
} from '../worker/lib/requestModel';
import { DEFAULT_LINK_PROVIDERS } from '../worker/lib/externalModels';
import { asD1, freshDb, row } from './fixtures/app';

const filesOf = (f: V1Fixture): ModelFile[] => f.files.map((x, i) => ({ ...x, created_at: `2026-10-01T00:00:0${i}.000Z`, sha256: '', analysis: '' }));
const synth = (f: V1Fixture) => synthesizeModel(f.r, f.p, filesOf(f));
const byId = (id: string) => V1_CORPUS.find((f) => f.r.id === id)!;
const MATS = [
  { id: 'pla', process: 'fdm' }, { id: 'petg', process: 'fdm' }, { id: 'abs', process: 'fdm' },
  { id: 'resin-standard', process: 'resin' },
];

test('a model request: one file source per file, the model primary, one part measured on it, the palette red as a catalogue colour', () => {
  const m = synth(byId('req_model'));
  assert.deepEqual(m.sources.map((s) => [s.id, s.kind, s.file_id, s.is_primary]), [
    ['rps_crf_m1', 'file', 'crf_m1', true],
    ['rps_crf_i1', 'file', 'crf_i1', false],
  ]);
  assert.equal(m.parts.length, 1);
  const p = m.parts[0];
  assert.deepEqual([p.id, p.name, p.quantity, p.process, p.process_unsure, p.measured_file_id], ['rpt_req_model_1', '', 1, 'fdm', false, 'crf_m1']);
  assert.deepEqual(p.source_ids, ['rps_crf_m1', 'rps_crf_i1']);
  assert.deepEqual(p.materials.map((x) => [x.id, x.material_id, x.material_unsure]), [['rpm_req_model_1_1', 'pla', false]]);
  assert.deepEqual(p.materials[0].colors, [{ mode: 'catalogue', hex: '#d32f2f', label: 'Red', palette: 'red', ref: '' }]);
  assert.equal(m.job.quantity, 2, 'the request quantity is the number of SETS');
  assert.equal(m.job.source_type, 'model');
  assert.equal(p.review_state, '');
});

test('a link request: the link is a source and the primary; unsure process and material stay unsure, never a default', () => {
  const m = synth(byId('req_link'));
  assert.deepEqual(m.sources.map((s) => [s.id, s.kind, s.canonical_url, s.provider, s.is_primary]), [
    ['rps_req_link_link', 'link', 'https://www.printables.com/model/12345-shelf-bracket', 'printables', true],
  ]);
  const p = m.parts[0];
  assert.deepEqual([p.process, p.process_unsure], ['', true]);
  assert.deepEqual([p.materials[0].material_id, p.materials[0].material_unsure], ['', true]);
  assert.equal(m.job.source_type, 'link');
});

test('an images request: the first picture is primary; three colours with none chosen are three slots and a technical review', () => {
  const m = synth(byId('req_images'));
  assert.deepEqual(m.sources.map((s) => s.is_primary), [true, false]);
  const p = m.parts[0];
  assert.deepEqual(p.materials[0].colors.map((c) => c.mode), ['any', 'any', 'any']);
  assert.equal(p.review_state, 'needs_technical_review');
  assert.deepEqual(p.review_reasons, ['multicolor_unspecified']);
  assert.equal(p.measured_file_id, null);
  const s = summarize(m);
  assert.deepEqual([s.colors_total, s.multicolor_parts, s.review_state], [3, 1, 'needs_technical_review']);
});

test('a description-only request has no source and no primary; its custom colour word is kept as written', () => {
  const m = synth(byId('req_desc'));
  assert.deepEqual(m.sources, []);
  assert.deepEqual(m.parts[0].materials[0].colors, [{ mode: 'custom', hex: '', label: 'Navy', palette: '', ref: '' }]);
  assert.equal(m.job.source_type, 'description');
});

test('a palette WORD with a non-palette hex stays custom: the hex is never replaced by the word (critique 5)', () => {
  const c = synth(byId('req_red_word')).parts[0].materials[0].colors[0];
  assert.deepEqual(c, { mode: 'custom', hex: '#ee1111', label: 'Red', palette: '', ref: '' });
});

test('rows with no source_type are typed as v1 derives them, and the type is kept on the job', () => {
  assert.equal(synth(byId('req_pre130')).job.source_type, 'model');
  assert.equal(synth(byId('req_pre130_link')).job.source_type, 'link');
  assert.equal(synth(byId('req_derived_images')).job.source_type, 'images');
  // An images request that also names a model: the picture is primary, the part is measured on the model.
  const m = synth(byId('req_images_model'));
  assert.equal(m.sources.find((s) => s.is_primary)?.file_id, 'crf_i4');
  assert.equal(m.parts[0].measured_file_id, 'crf_m3');
});

test('a chat or direct request with no print row keeps its free text as legacy_text, verbatim, and is never given a catalogue id', () => {
  const f = byId('req_chat');
  const m = synth(f);
  const p = m.parts[0];
  assert.deepEqual(JSON.parse(p.legacy_text), { material: 'بلاستيك قوي', color: 'أحمر غامق', dimensions: 'حوالي ١٠ سم' });
  assert.deepEqual([p.materials[0].material_id, p.materials[0].material_unsure], ['', true]);
  assert.deepEqual(p.materials[0].colors, []);
  assert.deepEqual([p.process, p.process_unsure], ['', true]);
  assert.equal(m.origin, 'legacy');
  assert.deepEqual(m.sources.map((s) => [s.file_id, s.is_primary]), [['crf_c1', false]]);
});

test('ids are deterministic: two syntheses of one row are identical, and no id is random', () => {
  for (const f of V1_CORPUS) {
    assert.deepEqual(synth(f), synth(f), f.name);
    const m = synth(f);
    for (const id of [...m.sources.map((s) => s.id), ...m.parts.map((p) => p.id), ...m.parts.flatMap((p) => p.materials.map((x) => x.id))]) {
      assert.match(id, /^rp[stm]_(crf_|req_)/, `${f.name}: ${id}`);
    }
  }
});

test('THE ROUND TRIP: the mirror of the synthesised model hashes to the row it came from — every class but a pre-0130 link on an upload', () => {
  const exceptions: string[] = [];
  for (const f of V1_CORPUS) {
    const files = f.files;
    const before = canonicalFacts(factsFromRows(f.r, f.p, files));
    const after = canonicalFacts(mirrorFacts(synth(f), files));
    if (before !== after) exceptions.push(String(f.r.id));
  }
  // The one documented class (DECISIONS row 266): a source_url kept on a non-link row from before
  // 0130 — the mirror writes a link only for a link request. The compatibility script counts them.
  assert.deepEqual(exceptions, ['req_pre130']);
});

test('THE NO-OP SAVE (critique 3): the owner projection of every synthesised model, sent back as a v3 body, hashes the same', () => {
  for (const f of V1_CORPUS) {
    const files = filesOf(f);
    const m = synth(f);
    const stored = { ...m, summary: summarize(m) } as unknown as RequestModelRead;
    const body = JSON.parse(JSON.stringify(projectModel(m, 'owner'))) as Record<string, unknown>;
    const next = readModelInput(
      { schema_version: 3, sources: body.sources, parts: body.parts },
      { stored, files, mats: MATS, providers: DEFAULT_LINK_PROVIDERS, strict: false, ts: '2026-10-20T00:00:00.000Z', request: m.request }
    );
    assert.equal(canonicalFactsV3(next), canonicalFactsV3(m), f.name);
    // …and changes no id: what the tables would hold is what was read.
    assert.deepEqual(next.sources.map((s) => s.id), m.sources.map((s) => s.id), f.name);
    assert.deepEqual(next.parts.map((p) => p.id), m.parts.map((p) => p.id), f.name);
  }
});

test('the summary of a synthesised model is the SQL derivation of its v1 row (requestSummarySql): never read a summary raw', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('cust_1','C','c@x.co','h','customer')`);
  const { requestSummarySql } = await import('../worker/lib/requestModel');
  const sql = requestSummarySql('p', true);
  for (const f of V1_CORPUS.filter((x) => x.p)) {
    raw.prepare(`INSERT INTO community_requests (id, customer_id, title, description, quantity) VALUES (?, 'cust_1', 't', 'd', 1)`).run(String(f.r.id));
    const p = f.p!;
    raw
      .prepare(
        `INSERT INTO community_print_requests (request_id, process, material_id, color_hex, color_name, colors_count, process_unsure, material_unsure, source_type)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(String(f.r.id), String(p.process), String(p.material_id), String(p.color_hex), String(p.color_name), Number(p.colors_count), Number(p.process_unsure), Number(p.material_unsure), String(p.source_type));
    const got = row<Record<string, unknown>>(
      raw,
      `SELECT ${Object.entries(sql).map(([k, v]) => `${v} AS ${k}`).join(', ')} FROM community_print_requests p WHERE p.request_id = ?`,
      String(f.r.id)
    )!;
    const s = summarize(synth({ ...f, files: [] }));
    assert.deepEqual(
      [got.parts_count, got.pieces_per_set, JSON.parse(String(got.materials_json)), JSON.parse(String(got.processes_json)), got.colors_total, got.multicolor_parts, got.review_state],
      [s.parts_count, s.pieces_per_set, s.materials, s.processes, s.colors_total, s.multicolor_parts, s.review_state],
      f.name
    );
  }
});

test('SYNTHESISED EQUALS MATERIALISED: the job writes the very model the reader synthesises, and the tables read it back identically', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('cust_1','C','c@x.co','h','customer')`);
  const db = asD1(raw);
  for (const f of V1_CORPUS.filter((x) => x.p)) {
    const rid = String(f.r.id);
    raw.prepare(`INSERT INTO community_requests (id, customer_id, title, description, quantity, governorate, customer_notes, deadline, delivery_pref) VALUES (?, 'cust_1', 't', 'd', ?, ?, ?, ?, ?)`)
      .run(rid, Number(f.r.quantity), String(f.r.governorate), String(f.r.customer_notes), (f.r.deadline as string | null) ?? null, String(f.r.delivery_pref));
    f.files.forEach((x, i) =>
      raw.prepare(`INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, kind, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(x.id, rid, `requests/k/${x.id}`, x.file_name, x.content_type, x.kind, `2026-10-01T00:00:0${i}.000Z`)
    );
    const p = f.p!;
    raw.prepare(
      `INSERT INTO community_print_requests (request_id, process, material_id, color_hex, color_name, quality, infill_percent, supports, colors_count,
         post_processing_minutes, primary_file_id, source_kind, source_provider, source_url, source_type, process_unsure, material_unsure, stated_dims)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(rid, String(p.process), String(p.material_id), String(p.color_hex), String(p.color_name), String(p.quality), Number(p.infill_percent), Number(p.supports),
      Number(p.colors_count), Number(p.post_processing_minutes), (p.primary_file_id as string | null) ?? null, String(p.source_kind), String(p.source_provider),
      String(p.source_url), String(p.source_type), Number(p.process_unsure), Number(p.material_unsure), String(p.stated_dims));

    const read = (await readRequestModel(db, rid))!;
    assert.equal(read.origin, 'synthesized');
    await db.batch(modelWriteStatements(db, [{ request_id: rid, model: read, schema_version: 1 }], '2026-10-20T00:00:00.000Z'));
    const t = {
      sources: raw.prepare('SELECT * FROM community_request_sources WHERE request_id = ? ORDER BY position, id').all(rid).map((x) => ({ ...(x as object) })),
      parts: raw.prepare('SELECT * FROM community_request_parts WHERE request_id = ? ORDER BY position, id').all(rid).map((x) => ({ ...(x as object) })),
      links: raw.prepare('SELECT ps.* FROM community_request_part_sources ps JOIN community_request_parts pt ON pt.id = ps.part_id WHERE pt.request_id = ?').all(rid).map((x) => ({ ...(x as object) })),
      materials: raw.prepare('SELECT m.* FROM community_request_part_materials m JOIN community_request_parts pt ON pt.id = m.part_id WHERE pt.request_id = ? ORDER BY m.position').all(rid).map((x) => ({ ...(x as object) })),
    };
    const rRow = row<Record<string, unknown>>(raw, 'SELECT * FROM community_requests WHERE id = ?', rid)!;
    const pRow = row<Record<string, unknown>>(raw, 'SELECT * FROM community_print_requests WHERE request_id = ?', rid)!;
    const materialised = mergeFiles(modelFromTables(rRow, pRow, read.modelFiles, t as never), read.modelFiles);
    assert.equal(canonicalFactsV3(materialised), canonicalFactsV3(read), f.name);
    assert.deepEqual(projectModel({ ...materialised, schema_version: read.schema_version }, 'owner'), projectModel(read, 'owner'), f.name);
    // The stamp is the row's own fingerprint, and the summary columns are the synthesised summary.
    assert.equal(row<{ n: number }>(raw, `SELECT (model_mirror = json_array(process, process_unsure, material_id, material_unsure, color_hex, color_name, colors_count, primary_file_id, source_type, source_kind, source_url, source_provider, stated_dims)) AS n FROM community_print_requests WHERE request_id = ?`, rid)!.n, 1);
    assert.equal(pRow.schema_version, 1, 'the cache never makes a request version 3');
    assert.equal(pRow.colors_total, read.summary.colors_total);
  }
});
