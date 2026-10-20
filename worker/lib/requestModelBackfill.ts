/**
 * THE REQUEST MODEL'S CACHE, BUILT A QUARTER-HOUR AT A TIME (P1-04,
 * docs/DECISIONS.md row 266; migration 0208).
 *
 * Migration 0208 writes no row: an INSERT…SELECT inside it would be a second
 * synthesis written in SQL, sure to drift from the TypeScript one, and run
 * once — before a deploy, while the old build still edits rows. Instead this
 * job materialises, for every version-1 print row whose model was never built
 * (`model_mirror = ''`, the partial index `idx_print_requests_model_unbuilt`),
 * exactly the model `readRequestModel` synthesises (`synthesizeModel`, one
 * implementation), its summary columns and its stamp.
 *
 * IT IS A CACHE, NOTHING DEPENDS ON IT. A version-1 request is always read by
 * synthesising its v1 row (worker/lib/requestModel.ts), its hash is the v1
 * string, and SQL readers fall back to the v1 columns while a stamp does not
 * match (`requestSummarySql`). What the cache gives is the summary columns an
 * index can serve (the technical-review queue) and part rows a join can read.
 *
 * WHAT IT NEVER DOES. It never touches a version-3 row, never writes a v1
 * column, `community_requests`, a revision, an offer or an order — so no hash
 * can move. Every statement it sends is guarded by the print row it read
 * (`updated_at`, `model_mirror`, `schema_version = 1`), the stamp last, so a
 * writer that lands in between leaves that request for the next pass. A
 * second run finds nothing pending and writes nothing.
 *
 * A REQUEST THAT CANNOT BE WRITTEN NEVER STALLS THE JOB. Each synthesised
 * model is first checked in code against every CHECK and key 0208 declares
 * (`modelRowProblem`); one that fails is marked `model_mirror = 'error'` in a
 * single guarded statement and never joins a batch. A batch that still fails
 * (a file deleted in between, anything the check cannot see) is halved
 * smaller half first (25, 12, 6, 3, 1): the first page of a pass is sized so
 * that this whole descent and its `error` mark fit the budget
 * (`pageWorstCase`), so every pass builds or marks at least one request even
 * when the one that fails sorts first — and the quarter-hour tick, which
 * always starts from the beginning, finds the list shorter each time. An
 * `error` row is off the index and reads as not fresh; `mode: 'drift'` (the
 * admin route, by hand) retries it.
 *
 * A V1 EDIT PUTS ITS CACHE BACK ON THE LIST. This build's v1 publish and
 * draft save reset `model_mirror` to '' in their own batch
 * (`v1CacheResetStatements`), and a file arriving or leaving does the same
 * (`restampAfterFileStatement`), so the scheduled pass rebuilds them. `drift`
 * is for what no writer of this build reset: caches an older build left stale
 * after a rollback, and the rows marked `error`.
 */
import type { Env } from './types';
import { isMissingSchema } from './merchantApproval';
import { canonicalFacts, factsFromRows } from './requestRevisions';
import {
  MIRROR_SQL,
  mirrorFacts,
  modelRowProblem,
  modelWriteStatements,
  revisionFile,
  synthesizeModel,
  type ModelFile,
  type ModelWriteEntry,
} from './requestModel';

/**
 * The statements a pass may spend. The quarter-hour tick hands in its shared
 * `statementBudget` (worker/lib/fx/budget.ts), which has this shape; the admin
 * route a plain one (`requestModelBudget`).
 */
export interface StatementBudget {
  canSpend(n: number): boolean;
  spend(n: number): boolean;
}

/** A budget of `limit` statements, for a run by hand. */
export function requestModelBudget(limit: number): StatementBudget {
  let used = 0;
  return {
    canSpend: (n) => used + n <= limit,
    spend(n) {
      if (used + n > limit) return false;
      used += n;
      return true;
    },
  };
}

/** Requests per page: one select, one batch of three reads, one batch of seven writes. */
export const REQUEST_MODEL_PAGE = 25;
/** Statements one full page costs. */
export const REQUEST_MODEL_PAGE_STATEMENTS = 1 + 3 + 7;

/** Write attempts the smaller-half-first descent takes from `n` entries down to one: n, ⌊n/2⌋, …, 1. */
export function descentAttempts(n: number): number {
  let a = 1;
  for (let k = Math.max(1, Math.floor(n)); k > 1; k = Math.floor(k / 2)) a++;
  return a;
}

/**
 * The most a page of `n` can spend before it has built or marked at least one
 * request: the select, the reads, every write of the descent to a single
 * entry, and that entry's `error` mark. 25 → 40, exactly the tick's share.
 */
export function pageWorstCase(n: number): number {
  return 1 + 3 + 7 * descentAttempts(n) + 1;
}

export interface RequestModelReport {
  mode: 'unbuilt' | 'drift';
  scanned: number;
  built: number;
  /** A writer changed the row between the read and the write: left for the next pass. */
  skipped: number;
  errors: number;
  /** v1 rows whose synthesised mirror does not reproduce their own v1 string (counted, never written differently). */
  mirror_mismatch: number;
  /** The request id to continue after, for a paged admin run. */
  next_after: string | null;
  stopped: boolean;
  dry_run: boolean;
}

interface PageRow {
  request_id: string;
  updated_at: string;
  model_mirror: string;
}

const FILES_SQL = `SELECT f.id, f.request_id, f.kind, f.content_type, f.size_bytes, f.file_name, f.created_at, f.analysis,
                          COALESCE(fo.sha256, '') AS sha256
                     FROM community_request_files f LEFT JOIN file_objects fo ON fo.object_key = f.file_key
                    WHERE f.request_id IN (SELECT value FROM json_each(?1))
                    ORDER BY f.request_id, f.created_at, f.id`;

/**
 * One pass. `budget` is the quarter-hour's share (or the admin run's); every
 * statement is charged before it is sent. Never throws for a missing schema.
 */
export async function catchUpRequestModels(
  env: Pick<Env, 'DB'>,
  opts: { budget: StatementBudget; mode?: 'unbuilt' | 'drift'; after?: string; limit?: number; dryRun?: boolean; now?: string }
): Promise<RequestModelReport> {
  const db = env.DB;
  const mode = opts.mode ?? 'unbuilt';
  const report: RequestModelReport = {
    mode, scanned: 0, built: 0, skipped: 0, errors: 0, mirror_mismatch: 0, next_after: null, stopped: false, dry_run: !!opts.dryRun,
  };
  const ts = opts.now ?? new Date().toISOString();
  let after = opts.after ?? '';
  let left = Math.max(1, Math.min(opts.limit ?? Number.MAX_SAFE_INTEGER, 100_000));
  let firstPage = true;

  while (left > 0) {
    // A page is read only when its write fits too: no statement is spent on a page left unwritten.
    // The FIRST page of a pass is sized so that, should its batch fail, the whole descent to one
    // request and that request's `error` mark fit as well: a pass always makes progress.
    let size = Math.min(REQUEST_MODEL_PAGE, left);
    if (firstPage && !opts.dryRun) while (size > 1 && !opts.budget.canSpend(pageWorstCase(size))) size = Math.floor(size / 2);
    const need = opts.dryRun ? 4 : firstPage ? pageWorstCase(size) : REQUEST_MODEL_PAGE_STATEMENTS;
    if (!opts.budget.canSpend(need) || !opts.budget.spend(1)) {
      report.stopped = true;
      report.next_after = after;
      break;
    }
    firstPage = false;
    const cursorBefore = after;
    let page: PageRow[];
    try {
      const sql =
        mode === 'unbuilt'
          ? `SELECT request_id, updated_at, model_mirror FROM community_print_requests
              WHERE model_mirror = '' AND schema_version = 1 AND request_id > ?1 ORDER BY request_id LIMIT ?2`
          : `SELECT p.request_id, p.updated_at, p.model_mirror FROM community_print_requests p
              WHERE p.schema_version = 1 AND p.model_mirror <> '' AND p.model_mirror <> ${MIRROR_SQL('p')}
                AND p.request_id > ?1 ORDER BY p.request_id LIMIT ?2`;
      page = ((await db.prepare(sql).bind(after, size).all<PageRow>()).results ?? []).map((x) => ({ ...x }));
    } catch (e) {
      if (isMissingSchema(e)) break;
      throw e;
    }
    if (!page.length) break;
    report.scanned += page.length;
    left -= page.length;
    after = page[page.length - 1].request_id;
    const last = page.length < size;
    report.next_after = last ? null : after;

    if (!opts.budget.spend(3)) {
      report.stopped = true;
      report.next_after = cursorBefore;
      break;
    }
    const ids = JSON.stringify(page.map((x) => x.request_id));
    const [rs, ps, fs] = (await db.batch([
      db.prepare('SELECT * FROM community_requests WHERE id IN (SELECT value FROM json_each(?1))').bind(ids),
      db.prepare('SELECT * FROM community_print_requests WHERE request_id IN (SELECT value FROM json_each(?1))').bind(ids),
      db.prepare(FILES_SQL).bind(ids),
    ])) as D1Result<Record<string, unknown>>[];
    const requests = new Map((rs.results ?? []).map((r) => [String(r.id), { ...r }]));
    const prints = new Map((ps.results ?? []).map((p) => [String(p.request_id), { ...p }]));
    const filesBy = new Map<string, ModelFile[]>();
    for (const f of fs.results ?? []) {
      const list = filesBy.get(String(f.request_id)) ?? [];
      list.push({
        id: String(f.id), kind: String(f.kind), content_type: String(f.content_type), size_bytes: Number(f.size_bytes ?? 0),
        file_name: String(f.file_name ?? ''), created_at: String(f.created_at ?? ''),
        sha256: /^[0-9a-f]{64}$/.test(String(f.sha256 ?? '')) ? String(f.sha256) : '', analysis: String(f.analysis ?? ''),
      });
      filesBy.set(String(f.request_id), list);
    }

    const entries: ModelWriteEntry[] = [];
    const unwritable: Array<{ rid: string; updated_at: string; mirror: string }> = [];
    for (const row of page) {
      const r = requests.get(row.request_id);
      const p = prints.get(row.request_id);
      if (!r || !p || Number(p.schema_version ?? 1) !== 1) {
        report.skipped++;
        continue;
      }
      const files = filesBy.get(row.request_id) ?? [];
      const guard = { updated_at: String(p.updated_at ?? row.updated_at), model_mirror: String(p.model_mirror ?? row.model_mirror) };
      let problem: string | null;
      let model: ReturnType<typeof synthesizeModel> | null = null;
      try {
        model = synthesizeModel(r, p, files);
        const rev = files.map(revisionFile);
        if (canonicalFacts(mirrorFacts(model, rev)) !== canonicalFacts(factsFromRows(r, p, rev))) report.mirror_mismatch++;
        problem = modelRowProblem(model, new Set(files.map((f) => f.id)));
      } catch (e) {
        problem = `synthesis failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (problem || !model) {
        unwritable.push({ rid: row.request_id, updated_at: guard.updated_at, mirror: guard.model_mirror });
        console.error('request model: not built for', row.request_id, problem);
        continue;
      }
      entries.push({ request_id: row.request_id, model, schema_version: 1, guard });
    }
    if (opts.dryRun) {
      report.built += entries.length;
      report.errors += unwritable.length;
    } else {
      // The rows the tables would refuse leave the work list first, in one guarded statement.
      if (unwritable.length) {
        if (!opts.budget.spend(1)) {
          report.stopped = true;
          report.next_after = cursorBefore;
          break;
        }
        const marked = await db
          .prepare(
            `UPDATE community_print_requests SET model_mirror = 'error'
              WHERE request_id IN (SELECT json_extract(value, '$.rid') FROM json_each(?1))
                AND schema_version = 1
                AND EXISTS (SELECT 1 FROM json_each(?1) g
                             WHERE json_extract(g.value, '$.rid') = community_print_requests.request_id
                               AND json_extract(g.value, '$.updated_at') = community_print_requests.updated_at
                               AND json_extract(g.value, '$.mirror') = community_print_requests.model_mirror)`
          )
          .bind(JSON.stringify(unwritable))
          .run();
        const n = Number(marked.meta?.changes ?? 0);
        report.errors += n;
        report.skipped += unwritable.length - n;
      }
      const written = await writeHalving(db, entries, ts, opts.budget, report);
      if (written === null) {
        report.stopped = true;
        report.next_after = cursorBefore;
        break;
      }
    }
    if (last) break;
  }
  if (report.stopped && report.built === 0 && report.errors === 0 && report.scanned > 0) {
    // Nothing moved this pass although work is pending: say so, the next pass starts where this one did.
    console.warn('request model: a pass stopped on its budget without building a request', JSON.stringify({ mode, scanned: report.scanned, skipped: report.skipped }));
  }
  return report;
}

/**
 * Write a page; on failure, halve it — the SMALLER half first, so the descent
 * to the first entry is n, ⌊n/2⌋, …, 1 (`descentAttempts`) — and try each
 * half; a single request that cannot be written is marked `error` (guarded,
 * so a writer that landed is untouched). Null when the budget ran out.
 */
async function writeHalving(
  db: D1Database,
  entries: ModelWriteEntry[],
  ts: string,
  budget: StatementBudget,
  report: RequestModelReport
): Promise<number | null> {
  if (!entries.length) return 0;
  const statements = modelWriteStatements(db, entries, ts);
  if (!budget.spend(statements.length)) return null;
  try {
    const results = await db.batch(statements);
    // The stamp is last: the rows it changed are the requests built.
    const stamped = Number(results[results.length - 1]?.meta?.changes ?? 0);
    report.built += stamped;
    report.skipped += entries.length - stamped;
    return stamped;
  } catch (e) {
    if (entries.length === 1) {
      if (!budget.spend(1)) return null;
      const g = entries[0].guard!;
      await db
        .prepare(
          `UPDATE community_print_requests SET model_mirror = 'error'
            WHERE request_id = ? AND updated_at = ? AND model_mirror = ? AND schema_version = 1`
        )
        .bind(entries[0].request_id, g.updated_at, g.model_mirror)
        .run();
      report.errors++;
      console.error('request model: not built for', entries[0].request_id, e instanceof Error ? e.message : String(e));
      return 0;
    }
    const half = Math.floor(entries.length / 2);
    const a = await writeHalving(db, entries.slice(0, half), ts, budget, report);
    if (a === null) return null;
    const b = await writeHalving(db, entries.slice(half), ts, budget, report);
    if (b === null) return null;
    return a + b;
  }
}
