/**
 * IS THE DATABASE AS NEW AS THE CODE READING IT?
 *
 * THE NIGHT THIS WAS WRITTEN. A Worker carrying migration 0085 reached
 * production over a database still at 0083. `/api/home` went to a SERVICE_SETUP
 * error card, the storefront's first screen with it — and `/api/health`
 * answered `{"status":"ok"}` throughout, because it was
 *
 *     miscRoutes.get('/health', (c) => c.json({ status: 'ok' }));
 *
 * a literal that touches nothing and therefore cannot be wrong. The deploy
 * workflow's own final gate is `curl -fsS .../api/health`, so the check meant
 * to catch a bad deploy would have passed on a shop that was completely dark.
 *
 * WHAT THIS DOES NOT DO, deliberately: it does not make `/api/health` fail.
 * That endpoint is used as a LIVENESS probe in several places — the staging
 * deploy retries it until the Worker answers at all, and
 * `wildcard-subdomains.yml` uses it to ask whether a subdomain routes to this
 * Worker — and a route that answers "the database is behind" by refusing to
 * answer is useless for both. Drift is REPORTED as data; the deploy gates
 * assert on it, and a human reading the endpoint can see it in one request.
 *
 * WHERE THE EXPECTED VALUE COMES FROM. A Worker has no filesystem, so it
 * cannot count the `migrations/` directory at runtime. `EXPECTED_MIGRATION` is
 * therefore a constant, kept honest by `tests/schemaVersion.test.ts`, which
 * fails if it is not the newest file in that directory — the same
 * registry-plus-parity-test shape this codebase already uses for table
 * ownership and the template families. A constant nobody can forget to update
 * is a constant with a test.
 *
 * WHERE THE APPLIED VALUE COMES FROM. `wrangler d1 migrations apply` records
 * each file it runs in `d1_migrations(name)` — the default table name, which
 * this project does not override (`wrangler.jsonc` sets only `migrations_dir`).
 * A database that was never built by wrangler has no such table, and that is
 * reported as `unknown` rather than as drift: the unit-test harness applies the
 * .sql files directly and must not look like a broken deployment.
 */

/**
 * The newest migration this code expects to have been applied.
 *
 * KEEP THIS IN THE SAME COMMIT AS THE MIGRATION. tests/schemaVersion.test.ts
 * fails otherwise, which is the point: the value exists so that a deploy can
 * notice its own database is behind, and a stale value notices nothing.
 */
export const EXPECTED_MIGRATION = '0095_finance_cost_basis_and_expenses.sql';

/**
 * How many migration files this code expects to have been applied.
 *
 * THE NEWEST NAME ALONE IS NOT ENOUGH, and this project has already lived the
 * counter-example: `repair-staging-db.yml` exists because a database once had
 * TABLES from migration 0018 while `d1_migrations` recorded only 0012. A set
 * with a HOLE in the middle — 0087 applied, 0086 skipped — has the right
 * newest name and is still missing a migration, and a check that reads only
 * the maximum would call that healthy.
 *
 * Counting is what closes it: one row per applied file means a hole shows up
 * as a shortfall whatever its position. Kept honest by the same test as the
 * name above.
 *
 * IT IS NOT THE HIGHEST NUMBER. There are 93 files and the newest is 0095 —
 * the numbering has gaps, which is exactly why the count has to be its own
 * constant rather than something derived from the name.
 */
export const EXPECTED_MIGRATION_COUNT = 93;

/**
 * The leading number of a migration filename, or null when it has none.
 *
 * Numbers rather than string comparison, because the comparison has to survive
 * a file being renamed around its number — `0085_product_condition.sql` and a
 * later `0085_product_condition_v2.sql` are the same migration to a deploy.
 */
export function migrationNumber(name: string): number | null {
  const m = /^(\d{4})/.exec(name.trim());
  return m ? Number(m[1]) : null;
}

export type SchemaState = 'current' | 'behind' | 'ahead' | 'unknown';

export interface SchemaStatus {
  /** The newest migration the CODE expects. */
  expected: string;
  /** The newest migration the DATABASE has recorded, or null when unknowable. */
  applied: string | null;
  state: SchemaState;
  /** How many migrations the database is behind the code; 0 unless `behind`. */
  behind: number;
  /** How many files the code expects, and how many the database recorded. */
  expected_count: number;
  applied_count: number;
}

/**
 * Compare what the code expects against what the database has recorded.
 *
 * NEVER THROWS. This is called from a health endpoint whose whole job is to
 * answer, and a probe that 500s because its own diagnostic query failed tells
 * the reader nothing about the thing they asked about.
 *
 * `ahead` — the database has run a migration this code does not know about —
 * is reported rather than treated as an error: it is the ordinary state during
 * a rollback, and it is information the person reading wants.
 */
export async function readSchemaStatus(db: D1Database): Promise<SchemaStatus> {
  const expected = EXPECTED_MIGRATION;
  const expectedNo = migrationNumber(expected);
  const unknown = (applied: string | null, appliedCount: number): SchemaStatus => ({
    expected,
    applied,
    state: 'unknown',
    behind: 0,
    expected_count: EXPECTED_MIGRATION_COUNT,
    applied_count: appliedCount,
  });

  let applied: string | null = null;
  let appliedCount = 0;
  try {
    const row = await db
      .prepare('SELECT COUNT(*) AS n, MAX(name) AS newest FROM d1_migrations')
      .first<{ n: number; newest: string | null }>();
    appliedCount = Number(row?.n ?? 0);
    applied = row?.newest ?? null;
  } catch {
    // No d1_migrations table: a database not built by `wrangler d1 migrations
    // apply`. Unknowable, which is not the same as behind.
    return unknown(null, 0);
  }

  // MAX(name) rather than ORDER BY id: `id` is insertion order, and a repair
  // that re-applies an out-of-order file would make the last-inserted row the
  // wrong answer. The names sort the way the files do.
  const appliedNo = applied === null ? null : migrationNumber(applied);
  if (appliedNo === null || expectedNo === null) return unknown(applied, appliedCount);

  const short = EXPECTED_MIGRATION_COUNT - appliedCount;
  const behindByNumber = expectedNo - appliedNo;

  // AHEAD only when the database is genuinely past this code AND not short of
  // anything — a rollback, which is information rather than a fault.
  if (appliedNo > expectedNo && short <= 0) {
    return { expected, applied, state: 'ahead', behind: 0, expected_count: EXPECTED_MIGRATION_COUNT, applied_count: appliedCount };
  }

  // BEHIND if either reading says so. The count catches a hole in the middle
  // that the newest name cannot see; the number catches a database whose
  // history was rewritten to the right length with the wrong files.
  const behind = Math.max(behindByNumber, short);
  if (behind > 0) {
    return { expected, applied, state: 'behind', behind, expected_count: EXPECTED_MIGRATION_COUNT, applied_count: appliedCount };
  }
  return { expected, applied, state: 'current', behind: 0, expected_count: EXPECTED_MIGRATION_COUNT, applied_count: appliedCount };
}
