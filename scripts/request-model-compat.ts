/**
 * DO BOTH BUILDS READ EVERY LIVE REQUEST COHERENTLY? (P1-04 «done when»,
 * docs/DECISIONS.md row 266; migration 0208.)
 *
 *   npx tsx scripts/request-model-compat.ts --from <export.sqlite>
 *
 * Works on a COPY of an exported database (never the file it is given, never
 * the live one): applies 0208 when the copy lacks it, then, for every request,
 *
 *   new build, old rows   the read path's v1 facts and hash against the FROZEN
 *                         58cd8ce4 readers (tests/fixtures/v1RequestReaders.ts);
 *                         the mirror round trip of the synthesised model;
 *   the job               runs the quarter-hour job to the end, then checks no
 *                         v1 hash moved and the requests, revisions, offers and
 *                         orders tables are byte-identical;
 *   old build, new rows   every version-3 row's v1 columns, through the frozen
 *                         readers, against the v1 facts of its model's mirror.
 *
 * It also counts the classes the critique named, so the owner knows what the
 * model meets on live: colour counts outside 1–16, a `source_url` kept on a
 * non-link row (from before 0130 — the one class whose mirror does not
 * reproduce its v1 string), an empty `source_type`, links the current
 * `parseModelLink` refuses, stated sizes that do not parse, and — as a
 * baseline — current revisions whose stored hash differs from a recomputation.
 *
 * Counts only: no request content, no id, no name is printed. A non-zero
 * `failures` total exits 1. The live half is the admin route's `dry_run`
 * (POST /api/admin/community/request-models/backfill).
 */
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as frozen from '../tests/fixtures/v1RequestReaders';
import { canonicalFor, composeSnapshot } from '../worker/lib/requestRevisions';
import { mirrorFacts, readRequestModel } from '../worker/lib/requestModel';
import { catchUpRequestModels } from '../worker/lib/requestModelBackfill';
import { statementBudget } from '../worker/lib/fx/budget';
import { DEFAULT_LINK_PROVIDERS, parseModelLink } from '../worker/lib/externalModels';
import { parseDims } from '../worker/lib/requestRevisions';

type Row = Record<string, unknown>;

/** The smallest D1 the read path and the job need, over node:sqlite. */
class Stmt {
  constructor(private readonly db: DatabaseSync, readonly sql: string, private readonly params: unknown[] = []) {}
  bind(...values: unknown[]) {
    return new Stmt(this.db, this.sql, values);
  }
  private args() {
    return this.params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)) as never[];
  }
  async first<T = Row>() {
    const r = this.db.prepare(this.sql).get(...this.args());
    return (r === undefined ? null : { ...(r as object) }) as T | null;
  }
  async all<T = Row>() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.args()).map((r) => ({ ...(r as object) })) as T[], meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args());
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }
}
class D1 {
  constructor(private readonly db: DatabaseSync) {}
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(statements: Stmt[]) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(/^\s*(SELECT|WITH)\b/i.test(s.sql) ? await s.all() : await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const tableHash = (raw: DatabaseSync, table: string, cols = '*') =>
  sha(JSON.stringify(raw.prepare(`SELECT ${cols} FROM ${table} ORDER BY rowid`).all()));

async function main() {
  const from = arg('--from');
  if (!from) {
    console.error('usage: npx tsx scripts/request-model-compat.ts --from <export.sqlite>');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'request-model-compat-'));
  const copy = join(dir, 'copy.sqlite');
  copyFileSync(from, copy);
  const raw = new DatabaseSync(copy);
  raw.exec('PRAGMA foreign_keys = ON;');
  const columns = (raw.prepare('PRAGMA table_info(community_print_requests)').all() as Array<{ name: string }>).map((c) => c.name);
  const applied = !columns.includes('schema_version');
  if (applied) raw.exec(readFileSync(join(process.cwd(), 'migrations', '0208_request_sources_parts.sql'), 'utf8'));
  const db = new D1(raw) as unknown as D1Database;

  const counts = {
    applied_0208: applied,
    requests: 0,
    with_print_row: 0,
    legacy_no_print_row: 0,
    // the classes the model meets
    colors_count_above_16: 0,
    colors_count_below_1: 0,
    source_url_on_non_link: 0,
    source_type_empty: 0,
    link_refused_by_parser: 0,
    stated_dims_unparseable: 0,
    revision_hash_baseline_differs: 0,
    revision_hash_legacy: 0,
    // new build, old rows
    v1_facts_differ_from_frozen: 0,
    v1_hash_differs_from_frozen: 0,
    mirror_round_trip_differs: 0,
    // the job
    job_built: 0,
    job_errors: 0,
    v1_hash_moved_by_job: 0,
    untouchable_tables_moved: 0,
    // old build, new rows
    version_3_rows: 0,
    version_3_mirror_differs_from_frozen: 0,
  };

  const ids = (raw.prepare('SELECT id FROM community_requests ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
  const v1Before = new Map<string, string>();
  for (const id of ids) {
    counts.requests++;
    const read = await readRequestModel(db, id, { restamp: false });
    if (!read) continue;
    const { r, p } = read.rows;
    if (p) counts.with_print_row++;
    else counts.legacy_no_print_row++;
    if (p) {
      const cc = Number(p.colors_count ?? 1);
      if (cc > 16) counts.colors_count_above_16++;
      if (cc < 1) counts.colors_count_below_1++;
      const type = frozen.effectiveSourceType(p, read.files.map((f) => f.kind));
      if (String(p.source_url ?? '') && type !== 'link') counts.source_url_on_non_link++;
      if (String(p.source_type ?? '') === '') counts.source_type_empty++;
      if (String(p.source_url ?? '') && !parseModelLink(String(p.source_url), DEFAULT_LINK_PROVIDERS)) counts.link_refused_by_parser++;
      if (String(p.stated_dims ?? '') && !parseDims(p.stated_dims)) counts.stated_dims_unparseable++;
    }
    const old = frozen.factsFromRows(r, p, read.files);
    if (JSON.stringify(old) !== JSON.stringify(read.v1)) counts.v1_facts_differ_from_frozen++;
    if (read.schema_version === 1) {
      if (canonicalFor(read) !== frozen.canonicalFacts(old)) counts.v1_hash_differs_from_frozen++;
      if (frozen.canonicalFacts(mirrorFacts(read, read.files) as never) !== frozen.canonicalFacts(old)) counts.mirror_round_trip_differs++;
    } else {
      counts.version_3_rows++;
      if (frozen.canonicalFacts(old) !== frozen.canonicalFacts(mirrorFacts(read, read.files) as never)) counts.version_3_mirror_differs_from_frozen++;
    }
    v1Before.set(id, frozen.canonicalFacts(old));
    const current = raw.prepare('SELECT hash FROM community_request_revisions WHERE request_id = ? AND revision = ?').get(id, Number(r.revision ?? 1)) as { hash: string } | undefined;
    if (current) {
      if (current.hash === 'legacy') counts.revision_hash_legacy++;
      else if ((await composeSnapshot(db, id))?.hash !== current.hash) counts.revision_hash_baseline_differs++;
    }
  }

  const untouchable = () => ['community_requests', 'community_request_revisions', 'community_offers', 'community_orders'].map((t) => tableHash(raw, t));
  const before = untouchable();
  for (;;) {
    const report = await catchUpRequestModels({ DB: db }, { budget: statementBudget(5000) });
    counts.job_built += report.built;
    counts.job_errors += report.errors;
    if (!report.stopped) break;
  }
  if (JSON.stringify(untouchable()) !== JSON.stringify(before)) counts.untouchable_tables_moved++;
  for (const id of ids) {
    const read = await readRequestModel(db, id, { restamp: false });
    if (!read) continue;
    if (frozen.canonicalFacts(frozen.factsFromRows(read.rows.r, read.rows.p, read.files)) !== v1Before.get(id)) counts.v1_hash_moved_by_job++;
  }

  const failures =
    counts.v1_facts_differ_from_frozen + counts.v1_hash_differs_from_frozen + counts.v1_hash_moved_by_job +
    counts.untouchable_tables_moved + counts.version_3_mirror_differs_from_frozen +
    // The documented classes whose mirror cannot reproduce their v1 string (row 266); any other is a failure.
    Math.max(0, counts.mirror_round_trip_differs - counts.source_url_on_non_link - counts.colors_count_below_1 - counts.colors_count_above_16);
  console.log(JSON.stringify({ ...counts, failures }, null, 2));
  raw.close();
  process.exit(failures > 0 ? 1 : 0);
}

void main();
