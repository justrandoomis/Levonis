/**
 * MIGRATION 0208, ON THE DATABASE IT LANDS ON (P1-04, docs/DECISIONS.md
 * row 266).
 *
 * A copy built through 0207 holding the legacy corpus (every class of v1 row,
 * a chat request with no print row among them). Pinned: every statement is
 * additive (CREATE TABLE / CREATE INDEX IF NOT EXISTS, ADD COLUMN with a
 * default — no row written, no CHECK rebuilt, no CASE); it applies; every v1
 * row is unchanged; the model reads synthesise on the 0207 database without
 * throwing, and read exactly the same after 0208; and an older build's INSERT
 * into every table 0208 widened still succeeds through the defaults.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
// @ts-expect-error — plain JS module shared with scripts/
import { splitStatements } from '../scripts/lib/sql-split.mjs';
import { ROOT } from './fixtures/d1';
import { asD1, dbThrough, hasColumn } from './fixtures/app';
import { V1_CORPUS } from './fixtures/v1RequestCorpus';
import { canonicalFor, composeSnapshot } from '../worker/lib/requestRevisions';
import { projectModel, readRequestModel } from '../worker/lib/requestModel';
import { apply0208 } from './fixtures/requestModelWorld';

const SQL = readFileSync(join(ROOT, 'migrations', '0208_request_sources_parts.sql'), 'utf8');

function legacy(): DatabaseSync {
  const raw = dbThrough('0207');
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('cust_1','C','c@x.co','h','customer')`);
  for (const f of V1_CORPUS) {
    const rid = String(f.r.id);
    raw.prepare(
      `INSERT INTO community_requests (id, customer_id, title, description, quantity, material, color, dimensions, governorate, delivery_pref, deadline,
         customer_notes, state, status, visibility, revision, created_at, updated_at)
       VALUES (?, 'cust_1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'open', ?, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
    ).run(rid, String(f.r.title), String(f.r.description), Number(f.r.quantity), String(f.r.material), String(f.r.color), String(f.r.dimensions),
      // (A direct request needs its store; the chat class is stored private here — visibility is not what is tested.)
      String(f.r.governorate), String(f.r.delivery_pref), (f.r.deadline as string | null) ?? null, String(f.r.customer_notes), f.r.visibility === 'direct' ? 'private' : String(f.r.visibility));
    f.files.forEach((x, i) =>
      raw.prepare(`INSERT INTO community_request_files (id, request_id, file_key, file_name, content_type, size_bytes, kind, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(x.id, rid, `requests/cust_1/${x.id}`, x.file_name, x.content_type, x.size_bytes, x.kind, `2026-09-01T00:00:0${i}.000Z`)
    );
    if (!f.p) continue;
    const p = f.p;
    raw.prepare(
      `INSERT INTO community_print_requests (request_id, process, material_id, color_hex, color_name, quality, infill_percent, supports, colors_count,
         post_processing_minutes, primary_file_id, source_kind, source_provider, source_url, source_type, process_unsure, material_unsure, stated_dims, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, '2026-09-01T00:00:00.000Z')`
    ).run(rid, String(p.process), String(p.material_id), String(p.color_hex), String(p.color_name), String(p.quality), Number(p.infill_percent), Number(p.supports),
      Number(p.colors_count), Number(p.post_processing_minutes), (p.primary_file_id as string | null) ?? null, String(p.source_kind), String(p.source_provider),
      String(p.source_url), String(p.source_type), Number(p.process_unsure), Number(p.material_unsure), String(p.stated_dims));
  }
  return raw;
}

const ADDED = new Set([
  'schema_version', 'parts_count', 'pieces_per_set', 'materials_json', 'processes_json', 'colors_total', 'multicolor_parts', 'review_state', 'model_mirror',
  'budget_visible', 'coverage_json', 'substitutions_json', 'covers_all',
]);
const v1Rows = (raw: DatabaseSync) =>
  ['community_requests', 'community_print_requests', 'community_request_files', 'community_offers', 'community_request_revisions', 'community_orders'].map((t) =>
    JSON.stringify(raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => Object.fromEntries(Object.entries({ ...(r as object) }).filter(([k]) => !ADDED.has(k)))))
  );

test('every statement of 0208 is additive: CREATE … IF NOT EXISTS or ADD COLUMN with a default; no row written, no CHECK rebuilt, no CASE', () => {
  const statements = splitStatements(SQL) as string[];
  assert.equal(statements.length, 28);
  for (const s of statements) {
    const body = s.replace(/--[^\n]*\n/g, '').trim();
    assert.match(body, /^(CREATE (UNIQUE )?INDEX IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN)\b/, body.slice(0, 80));
    assert.doesNotMatch(body.replace(/ON DELETE (CASCADE|SET NULL)/g, ''), /\b(DROP|INSERT|UPDATE|DELETE|RENAME|CASE)\b/i, body.slice(0, 80));
    if (/ADD COLUMN/.test(body)) assert.ok(/\bDEFAULT\b/.test(body) || !/NOT NULL/.test(body), `${body.slice(0, 80)}: an older build's INSERT must still succeed`);
  }
});

test('0208 applies on the database it lands on; every v1 row is unchanged; the reads are the same before and after', async () => {
  const raw = legacy();
  assert.equal(hasColumn(raw, 'community_print_requests', 'schema_version'), false);
  const before = v1Rows(raw);
  const db = asD1(raw);
  const readBefore = new Map<string, unknown>();
  for (const f of V1_CORPUS) {
    const read = await readRequestModel(db, String(f.r.id));
    assert.ok(read, f.name);
    assert.equal(read!.schema, false, 'the read knows the schema is not there');
    assert.equal(read!.schema_version, 1);
    readBefore.set(String(f.r.id), [canonicalFor(read!), projectModel(read!, 'owner'), (await composeSnapshot(db, String(f.r.id)))?.hash]);
  }
  apply0208(raw);
  assert.deepEqual(v1Rows(raw), before);
  for (const f of V1_CORPUS) {
    const read = (await readRequestModel(db, String(f.r.id)))!;
    assert.equal(read.schema, true);
    assert.deepEqual([canonicalFor(read), projectModel(read, 'owner'), (await composeSnapshot(db, String(f.r.id)))?.hash], readBefore.get(String(f.r.id)), f.name);
  }
  // Every existing print row reads as version 1, unbuilt, with the v1 summary defaults.
  assert.deepEqual(
    raw.prepare("SELECT DISTINCT schema_version, model_mirror, parts_count FROM community_print_requests").all().map((r) => ({ ...(r as object) })),
    [{ schema_version: 1, model_mirror: '', parts_count: 1 }]
  );
});

test("an older build's INSERTs into every widened table still succeed after 0208, through the defaults", () => {
  const raw = legacy();
  apply0208(raw);
  // Exactly the column lists the 58cd8ce4 writers use.
  raw.exec(`INSERT INTO community_requests (id, customer_id, title, description, status, state) VALUES ('req_old', 'cust_1', 'Old build', 'Written by an older build', 'closed', 'draft')`);
  raw.exec(`INSERT INTO community_print_requests (request_id, process, material_id, color_hex, color_name, quality, infill_percent, supports, colors_count,
              post_processing_minutes, primary_file_id, source_kind, source_provider, source_url, source_meta, analysis, estimate, estimate_low_iqd,
              estimate_high_iqd, estimate_confidence, completeness, updated_at, source_type, process_unsure, material_unsure, stated_dims)
            VALUES ('req_old','fdm','pla','','','standard',20,1,1,0,NULL,'upload','','','{}','{}','{}',NULL,NULL,'',0,'2026-10-01T00:00:00.000Z','description',0,0,'')`);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('mu','M','m@x.co','h','customer');
            INSERT INTO community_merchants (id,user_id,name) VALUES ('mx','mu','M');
            INSERT INTO community_offers (id, request_id, merchant_id, price_iqd, state) VALUES ('off_old', 'req_old', 'mx', 1000, 'pending')`);
  const p = raw.prepare("SELECT schema_version, model_mirror, review_state FROM community_print_requests WHERE request_id = 'req_old'").get() as Record<string, unknown>;
  assert.deepEqual({ ...p }, { schema_version: 1, model_mirror: '', review_state: '' });
  const o = raw.prepare("SELECT coverage_json, substitutions_json, covers_all FROM community_offers WHERE id = 'off_old'").get() as Record<string, unknown>;
  assert.deepEqual({ ...o }, { coverage_json: null, substitutions_json: '[]', covers_all: 1 }, 'an existing offer covers the whole request');
  assert.equal((raw.prepare("SELECT budget_visible AS v FROM community_requests WHERE id = 'req_old'").get() as { v: number }).v, 0, 'Q2: private by default');
});

test('the database refuses what no writer may write: a source on another request’s file, a partial offer without coverage', () => {
  const raw = legacy();
  apply0208(raw);
  assert.throws(() =>
    raw.exec(`INSERT INTO community_request_sources (id, request_id, kind, file_id) VALUES ('rps_x', 'req_link', 'file', 'crf_m1')`), /FOREIGN KEY/);
  assert.throws(() => raw.exec(`INSERT INTO community_request_sources (id, request_id, kind) VALUES ('rps_y', 'req_link', 'project_post')`), /CHECK/);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('mu','M','m@x.co','h','customer');
            INSERT INTO community_merchants (id,user_id,name) VALUES ('mx','mu','M')`);
  assert.throws(() => raw.exec(`INSERT INTO community_offers (id, request_id, merchant_id, price_iqd, state, covers_all) VALUES ('o_p', 'req_link', 'mx', 1, 'pending', 0)`), /CHECK/);
  // The file's own request may; deleting the file takes the source with it.
  raw.exec(`INSERT INTO community_request_sources (id, request_id, kind, file_id) VALUES ('rps_ok', 'req_model', 'file', 'crf_m1')`);
  raw.exec(`DELETE FROM community_request_files WHERE id = 'crf_m1'`);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM community_request_sources WHERE id = 'rps_ok'").get() as { n: number }).n, 0);
});

test('scripts/request-model-compat.ts on an export of the legacy corpus: both directions coherent, the job moves no v1 hash, counts only', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const raw = legacy();
  const file = join(mkdtempSync(join(tmpdir(), 'rm-compat-')), 'export.sqlite');
  raw.exec(`VACUUM INTO '${file}'`);
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/request-model-compat.ts', '--from', file], { cwd: ROOT, encoding: 'utf8' });
  const report = JSON.parse(out.slice(out.indexOf('{')));
  assert.equal(report.failures, 0, out);
  assert.equal(report.applied_0208, true);
  assert.equal(report.requests, V1_CORPUS.length);
  assert.equal(report.legacy_no_print_row, 1);
  assert.equal(report.source_url_on_non_link, 1, 'the pre-0130 class is counted');
  assert.equal(report.mirror_round_trip_differs, 1, '…and is the only round-trip exception');
  assert.equal(report.job_built, V1_CORPUS.length - 1);
  assert.equal(report.v1_hash_moved_by_job, 0);
  assert.doesNotMatch(out, /req_|crf_|bracket/i, 'counts only');
});
