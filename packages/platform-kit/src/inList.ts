/**
 * D1 binds at most 100 parameters per statement, so every list-taking query
 * splits at 90 (`01-TARGET.md` §2.4; `lib/printerIdentity.ts` already chunks
 * at 90) and merges the pages. Pinned by a test that runs 200 ids through a
 * real SQLite database.
 */
export const IN_LIST_MAX = 90;

export function chunk<T>(items: readonly T[], size = IN_LIST_MAX): T[][] {
  if (size < 1) throw new RangeError('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `?,?,?` for `n` bound values. */
export function placeholders(n: number): string {
  if (n < 1) throw new RangeError('placeholders needs at least one value');
  return new Array(n).fill('?').join(',');
}

/**
 * Runs `query` once per chunk of at most 90 ids and concatenates the rows.
 * `query` receives the chunk and the matching `?,?,…` placeholder string.
 * Empty input runs nothing and returns [].
 */
export async function inList<Id, Row>(
  ids: readonly Id[],
  query: (chunk: Id[], marks: string) => Promise<Row[]>,
  size = IN_LIST_MAX
): Promise<Row[]> {
  const unique = [...new Set(ids)];
  const out: Row[] = [];
  for (const part of chunk(unique, size)) out.push(...(await query(part, placeholders(part.length))));
  return out;
}

/** Convenience over a D1 database: `SELECT … FROM t WHERE id IN (…)` per chunk. */
export async function selectIn<Row = Record<string, unknown>>(
  db: D1Database,
  sqlWithMarks: (marks: string) => string,
  ids: readonly (string | number)[],
  extraParams: readonly unknown[] = []
): Promise<Row[]> {
  return inList(ids, async (part, marks) => {
    const res = await db.prepare(sqlWithMarks(marks)).bind(...extraParams, ...part).all<Row>();
    return res.results ?? [];
  });
}
