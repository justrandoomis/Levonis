/**
 * A TABLE'S COLUMNS, ASKED ONCE PER BINDING (the admin save's round trips,
 * measured 2026-10-17: tests/adminSaveRoundTrips.test.ts).
 *
 * The product save asks the live schema whether a deployment is ahead of its
 * migrations before it names a newer column (`productsHaveColumn`, the
 * relation dimension witnesses, the printer-fit and search tables). Each of
 * those asked with its own `PRAGMA table_info`, every time: eleven for
 * `products` alone in one plan, and the plan runs twice per save (the
 * preflight and the real one). On the live Worker each PRAGMA is a round trip
 * to the D1 primary, and four of them were waves of their own.
 *
 * Here the answer is shared: every caller of the same binding and table waits
 * on ONE PRAGMA in flight, and a set that has every column a caller wants is
 * kept for the life of the binding — columns are only ever added by a
 * migration, never removed. A set MISSING a wanted column, an absent table
 * (no rows) and a failed PRAGMA are never kept: the next call asks again, so a
 * migration applied while an isolate lives is seen at once, exactly as before.
 */

const KNOWN = new WeakMap<object, Map<string, Promise<Set<string> | null>>>();

const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function readColumns(db: D1Database, table: string): Promise<Set<string> | null> {
  try {
    const { results } = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    return new Set((results ?? []).map((c) => String(c.name)));
  } catch {
    return null;
  }
}

/**
 * The live columns of `table`: an empty set when the table is absent, null
 * when the PRAGMA itself failed (each caller keeps its own answer for that).
 * `want`: the columns this caller needs; a kept set lacking one is asked again.
 */
export async function tableColumns(db: D1Database, table: string, want: readonly string[] = []): Promise<Set<string> | null> {
  if (!SAFE_TABLE.test(table)) return new Set();
  let byTable = KNOWN.get(db as object);
  if (!byTable) {
    byTable = new Map();
    KNOWN.set(db as object, byTable);
  }
  const held = byTable.get(table);
  if (held) {
    const cols = await held;
    if (cols && cols.size > 0 && want.every((c) => cols.has(c))) return cols;
    if (byTable.get(table) === held) byTable.delete(table);
  }
  const asked = byTable.get(table) ?? readColumns(db, table);
  byTable.set(table, asked);
  const cols = await asked;
  // Never keep an answer that could change: a failure, an absent table, a missing column.
  if (!cols || cols.size === 0 || !want.every((c) => cols.has(c))) {
    if (byTable.get(table) === asked) byTable.delete(table);
  }
  return cols;
}
