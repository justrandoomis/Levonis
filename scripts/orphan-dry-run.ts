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
  OWNED_TABLES,
  mediaKeyFromRef,
  mediaKeysInJson,
} from '../worker/lib/productDeletion';
import { MAIN_PAGE_PREFIX, isSiteMediaObject } from '../worker/lib/siteMedia';
import {
  MEDIA_REFERENCE_SOURCES,
  auditMediaCoverage,
  type LiveSchema,
} from '../worker/lib/mediaRefs';

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

/**
 * WHAT COUNTS AS "STILL IN USE" — THE WIDE SET, NOT THE PRODUCT ONE.
 *
 * This report used to answer the question with `MEDIA_COLUMNS` +
 * `MEDIA_JSON_COLUMNS`: the four product tables and eight JSON columns on
 * `products`. That is the right set for deleting ONE PRODUCT and the wrong set
 * for judging the bucket — it does not include the home-page banners (their
 * pointers live in a JSON blob in `admin_settings`) or any past order's
 * thumbnail (`order_items.image_snapshot`), so both were reported as orphans.
 *
 * It now walks `MEDIA_REFERENCE_SOURCES` (worker/lib/mediaRefs.ts), which is
 * the same manifest the Worker's destructive path walks. The script and the
 * button must never be able to describe different sets — that is the whole
 * reason this file reads the registries instead of listing tables itself.
 */
const liveSchema: LiveSchema = new Map();
for (const t of query<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
)) {
  const table = String(t.name);
  liveSchema.set(
    table,
    query<{ name: string; type: string | null; dflt_value: string | null }>(
      `SELECT name, type, dflt_value FROM pragma_table_info('${table.replace(/'/g, "''")}')`
    ).map((c) => ({ name: String(c.name), type: c.type ?? null, dflt: c.dflt_value ?? null }))
  );
}
const coverage = auditMediaCoverage(liveSchema);

const liveKeys = new Set<string>();
for (const source of MEDIA_REFERENCE_SOURCES) {
  const cols = liveSchema.get(source.table);
  if (!cols || !cols.some((c) => c.name === source.column)) continue;
  // `mainPageMedia` stores a bare object name, not a key — the same special
  // case `collectMediaReferences` makes, made here too so the two reports
  // cannot disagree about the brand marks on the first screen.
  const isSettings = source.table === 'admin_settings' && source.column === 'value';
  const rows = query<Record<string, unknown>>(
    isSettings
      ? `SELECT "key" AS k, "value" AS v FROM "admin_settings"`
      : `SELECT "${source.column}" AS v FROM "${source.table}" WHERE "${source.column}" IS NOT NULL AND "${source.column}" <> ''`
  );
  for (const row of rows) {
    if (source.kind === 'text') {
      const key = mediaKeyFromRef(row.v);
      if (key) liveKeys.add(key);
      continue;
    }
    const raw = row.v;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    if (isSettings && row.k === 'mainPageMedia') {
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const object of Object.values(parsed as Record<string, unknown>)) {
          if (isSiteMediaObject(object)) liveKeys.add(MAIN_PAGE_PREFIX + object);
        }
      }
      continue;
    }
    for (const k of mediaKeysInJson(parsed)) liveKeys.add(k);
  }
}
// A stranded key ANY live row still names is not an orphan.
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
lines.push('');
if (coverage.unclassified.length) {
  lines.push(
    `> **THE DESTRUCTIVE CLEANUP WILL REFUSE TO RUN.** ${coverage.unclassified.length} column(s) in this ` +
      'schema can hold an R2 object key and are named neither in `MEDIA_REFERENCE_SOURCES` nor in ' +
      '`NON_MEDIA_COLUMNS` (`worker/lib/mediaRefs.ts`), so "nothing points at this object" cannot be ' +
      'proved. Classify each one and re-run.'
  );
  lines.push('');
  for (const id of coverage.unclassified.slice(0, 50)) lines.push(`- \`${id}\``);
  if (coverage.unclassified.length > 50) lines.push(`- … ${coverage.unclassified.length - 50} more`);
} else {
  lines.push(
    `> Reference coverage: every key-bearing column in this schema is classified ` +
      `(${MEDIA_REFERENCE_SOURCES.length} scanned sources). The destructive cleanup is allowed to run.`
  );
}
lines.push('');
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
