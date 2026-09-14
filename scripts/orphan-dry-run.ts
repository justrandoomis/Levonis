/**
 * THE DRY RUN THE OWNER ASKED FOR, BEFORE ANY CLEANUP TOUCHES ANYTHING.
 *
 * Every delete before `worker/lib/productDeletion.ts` ran two statements, so
 * the live database holds residue the new path will never create. This reports
 * it — table by table, with row counts and sample ids — and it CANNOT delete
 * anything: every statement it issues starts with SELECT, and a guard below
 * refuses to run one that does not.
 *
 * It reads the SAME registries the delete uses, so the report and the delete
 * can never describe different sets of tables.
 *
 *   npx tsx scripts/orphan-dry-run.ts --db levonis-db-staging [--local]
 *
 * WHAT IT CANNOT SEE. An R2 object that no database row mentions is invisible
 * from SQL by definition; listing the bucket needs the R2 binding, which only
 * the Worker has. `GET /api/admin/products-v2/maintenance/orphans` on the
 * deployed site reports that half. This script says so in its own output
 * rather than implying the D1 half is the whole picture.
 */
import { execFileSync } from 'node:child_process';
import {
  MEDIA_COLUMNS,
  MEDIA_JSON_COLUMNS,
  OWNED_TABLES,
  mediaKeyFromRef,
  mediaKeysInJson,
} from '../worker/lib/productDeletion';

const args = process.argv.slice(2);
const dbName = args[(args.indexOf('--db') + 1) || -1] ?? 'levonis-db-staging';
const remote = !args.includes('--local');

/** The one thing that makes this script safe to point at production. */
function assertReadOnly(sql: string): void {
  const head = sql.trim().replace(/^\(+/, '').slice(0, 6).toUpperCase();
  if (head !== 'SELECT') throw new Error(`refusing a non-SELECT statement: ${sql.slice(0, 80)}`);
  if (/\b(DELETE|UPDATE|INSERT|DROP|ALTER|CREATE|REPLACE|PRAGMA)\b/i.test(sql)) {
    throw new Error(`refusing a statement that names a write: ${sql.slice(0, 80)}`);
  }
}

function query<T = Record<string, unknown>>(sql: string): T[] {
  assertReadOnly(sql);
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', dbName, remote ? '--remote' : '--local', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start >= 0 ? start : 0)) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

const PARENTS: Record<string, string> = {
  product_id: 'products',
  color_id: 'product_colors',
  option_id: 'product_option_values',
  cart_item_id: 'cart_items',
};

const columnsOf = (table: string): string[] =>
  query<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((r) => String(r.name));

const rows: Array<{ table: string; column: string; orphans: number; sample: string }> = [];
const seen = new Set<string>();

for (const entry of OWNED_TABLES) {
  const cols = columnsOf(entry.table);
  if (!cols.length) continue;
  for (const [col, parent] of Object.entries(PARENTS)) {
    if (!cols.includes(col)) continue;
    const mark = `${entry.table}.${col}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    const idCol = cols.includes('id') ? 'id' : col;
    const found = query<{ ident: string }>(
      `SELECT "${idCol}" AS ident FROM "${entry.table}" ` +
        `WHERE "${col}" IS NOT NULL AND "${col}" NOT IN (SELECT id FROM "${parent}") LIMIT 500`
    );
    if (!found.length) continue;
    rows.push({
      table: entry.table,
      column: col,
      orphans: found.length,
      sample: found.slice(0, 5).map((r) => String(r.ident)).join(', '),
    });
  }
}

// R2 keys held by rows whose product is already gone: these are the objects a
// cleanup would remove, and the only R2 figure SQL alone can establish.
const strandedKeys = new Set<string>();
for (const source of MEDIA_COLUMNS) {
  const cols = columnsOf(source.table);
  if (!cols.includes(source.column) || !cols.includes(source.by)) continue;
  const found = query<{ v: string }>(
    `SELECT "${source.column}" AS v FROM "${source.table}" ` +
      `WHERE "${source.by}" NOT IN (SELECT id FROM products) AND "${source.column}" <> ''`
  );
  for (const r of found) {
    const key = mediaKeyFromRef(r.v);
    if (key) strandedKeys.add(key);
  }
}

const productCols = columnsOf('products');
const liveKeys = new Set<string>();
for (const source of MEDIA_COLUMNS) {
  const cols = columnsOf(source.table);
  if (!cols.includes(source.column)) continue;
  for (const r of query<{ v: string }>(`SELECT "${source.column}" AS v FROM "${source.table}" WHERE "${source.column}" <> ''`)) {
    const key = mediaKeyFromRef(r.v);
    if (key) liveKeys.add(key);
  }
}
const jsonCols = MEDIA_JSON_COLUMNS.filter((c) => productCols.includes(c));
if (jsonCols.length) {
  for (const row of query<Record<string, unknown>>(
    `SELECT ${jsonCols.map((c) => `"${c}"`).join(', ')} FROM products`
  )) {
    for (const col of jsonCols) {
      const raw = row[col];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      for (const k of mediaKeysInJson(parsed)) liveKeys.add(k);
    }
  }
}
// A stranded key a LIVE product also uses is not an orphan.
const orphanKeys = [...strandedKeys].filter((k) => !liveKeys.has(k));

// Migration 0072 may not have reached this database yet — a rolling deploy is
// allowed to run the Worker ahead of it, so its absence is reported, not thrown.
let pendingJobs: number | null = null;
try {
  pendingJobs = Number(
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE state = 'pending'`)[0]?.n ?? 0
  );
} catch {
  pendingJobs = null;
}

const totalRows = rows.reduce((n, r) => n + r.orphans, 0);

const lines: string[] = [];
lines.push(`## Product orphan DRY RUN — \`${dbName}\`${remote ? ' (remote)' : ' (local)'}`);
lines.push('');
lines.push('**Nothing was deleted. Every statement was a SELECT.**');
lines.push('');
lines.push('| table | column | orphan rows | sample ids |');
lines.push('| --- | --- | ---: | --- |');
if (rows.length) {
  for (const r of rows) lines.push(`| \`${r.table}\` | \`${r.column}\` | ${r.orphans} | ${r.sample} |`);
} else {
  lines.push('| _(none)_ | | 0 | |');
}
lines.push('');
lines.push(`- **Total orphan rows:** ${totalRows}${rows.some((r) => r.orphans >= 500) ? ' _(a group at 500 is capped — the real count is higher)_' : ''}`);
lines.push(`- **R2 keys held only by orphan rows:** ${orphanKeys.length}`);
lines.push(
  `- **Pending \`media_cleanup_jobs\`:** ` +
    (pendingJobs === null ? '_table not present — migration 0072 has not reached this database_' : String(pendingJobs))
);
lines.push('');
if (orphanKeys.length) {
  lines.push('<details><summary>R2 keys reachable only from orphan rows</summary>');
  lines.push('');
  for (const k of orphanKeys.slice(0, 200)) lines.push(`- \`${k}\``);
  if (orphanKeys.length > 200) lines.push(`- … ${orphanKeys.length - 200} more`);
  lines.push('');
  lines.push('</details>');
  lines.push('');
}
lines.push(
  '> **Byte totals and objects no row mentions are NOT in this report.** Listing the bucket ' +
    'requires the R2 binding, which only the Worker has — `GET /api/admin/products-v2/maintenance/orphans` ' +
    'on the deployed site reports that half, also as a dry run.'
);

const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
