import type { Env } from './types';
import { badRequest } from './http';
import { newId } from './crypto';
import { ownedMediaKeys, productSchema, productDependencyGraph, processProductMediaCleanup, invalidateDeletedProductCache, MEDIA_COLUMNS, NON_REFERENCES } from './productDeletion';
import { headMediaObject, isAnonymousPublicMediaKey } from './mediaStorage';

const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;
type Row = Record<string, unknown>;
interface OrphanRow { table: string; rowid: number; product_id?: string; fingerprint: Row }
export interface ProductOrphanReport {
  dry_run: true;
  scan_id: string;
  tables: Array<{ table: string; orphan_rows: number }>;
  orphan_r2_files: Array<{ key: string; bucket: string; bytes: number }>;
  dangling_db_media_refs: string[];
  r2_objects: number;
  bytes: number;
  complete: boolean;
}

/** No destructive action occurs in this function. The stored candidate set is
 * what a later explicit confirmation may clean; a fresh scan never authorizes
 * files that were not in the reviewed report. */
export async function scanProductOrphans(env: Env, actorId: string, maxObjects = 10000): Promise<ProductOrphanReport> {
  const schema = await productSchema(env.DB);
  const graph = productDependencyGraph(schema).filter((d) => d.table !== 'products');
  const candidates: OrphanRow[] = [];
  const keys = new Set<string>();
  const tables: ProductOrphanReport['tables'] = [];
  for (const dep of graph) {
    const result = (await env.DB.prepare(`SELECT rowid AS __orphan_rowid,* FROM ${qi(dep.table)} WHERE ${dep.orphanPredicate} LIMIT 10001`).all<Row>()).results;
    tables.push({ table: dep.table, orphan_rows: result.length });
    for (const r of result) {
      const { __orphan_rowid, ...fingerprint } = r;
      candidates.push({ table: dep.table, rowid: Number(__orphan_rowid), product_id: typeof r.product_id === 'string' ? r.product_id : undefined, fingerprint });
      for (const k of ownedMediaKeys(r, env.APP_ORIGIN)) keys.add(k);
    }
  }
  // Existing metadata is not ownership by itself: only product-domain objects
  // enter this audit. Other private/user/chat media is never a cleanup target.
  const metadata = (await env.DB.prepare("SELECT object_key,visibility FROM file_objects WHERE domain='products' AND deleted_at IS NULL").all<{ object_key: string; visibility: 'public' | 'private' }>()).results;
  const visibility = new Map(metadata.map((r) => [r.object_key, r.visibility]));
  for (const r of metadata) keys.add(r.object_key);
  // Scan DB consumers once, rather than issuing a full-schema query for
  // every R2 object (which would exceed a Worker's D1 subrequest budget).
  const used = new Set<string>();
  for (const table of schema) {
    if (NON_REFERENCES.has(table.table)) continue;
    const columns = table.columns.filter((c) => MEDIA_COLUMNS.test(c));
    if (!columns.length) continue;
    const orphan = graph.find((g) => g.table === table.table)?.orphanPredicate;
    let offset = 0;
    for (;;) {
      const rows = (await env.DB.prepare(`SELECT ${columns.map(qi).join(',')} FROM ${qi(table.table)} ${orphan ? `WHERE NOT (${orphan})` : ''} LIMIT 500 OFFSET ?`).bind(offset).all<Row>()).results;
      for (const row of rows) for (const key of ownedMediaKeys(row, env.APP_ORIGIN)) { used.add(key); keys.add(key); }
      if (rows.length < 500) break;
      offset += rows.length;
    }
  }
  // Files uploaded by an import still in flight are not old orphans.
  const held = (await env.DB.prepare("SELECT object_key FROM media_cleanup_jobs WHERE status IN ('pending','retry') AND not_before>datetime('now')").all<{object_key:string}>()).results;
  for (const row of held) used.add(row.object_key);
  const objects: ProductOrphanReport['orphan_r2_files'] = [];
  const listed = new Set<string>();
  let complete = !tables.some((t) => t.orphan_rows > 10000);
  let inspected = 0;
  const buckets = [['public', env.R2_PUBLIC ?? env.BUCKET], ...(env.R2_PRIVATE && env.R2_PRIVATE !== env.BUCKET && env.R2_PRIVATE !== env.R2_PUBLIC ? [['private', env.R2_PRIVATE] as const] : []), ...(env.R2_PUBLIC && env.R2_PUBLIC !== env.BUCKET ? [['legacy', env.BUCKET] as const] : [])] as const;
  for (const [name, bucket] of buckets) {
    if (inspected >= maxObjects) { complete = false; break; }
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: 'products/', cursor, limit: Math.min(1000, Math.max(1, maxObjects - inspected)) });
      for (const object of page.objects) {
        listed.add(object.key); inspected++;
        if (!used.has(object.key)) objects.push({ key: object.key, bucket: name, bytes: object.size });
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (inspected >= maxObjects && cursor) { complete = false; break; }
    } while (cursor);
  }
  const dangling: string[] = [];
  // Check referenced legacy keys outside products/ and genuinely missing keys.
  for (const key of keys) {
    if (listed.has(key)) continue;
    const object = await headMediaObject(env, visibility.get(key) ?? (isAnonymousPublicMediaKey(key) ? 'public' : 'private'), key);
    if (!object && used.has(key)) dangling.push(key);
    if (object && !used.has(key)) objects.push({ key, bucket: visibility.get(key) ?? 'public_or_legacy', bytes: object.size });
  }
  const scanId = newId('porphan');
  const report: ProductOrphanReport = { dry_run: true, scan_id: scanId, tables, orphan_r2_files: objects, dangling_db_media_refs: dangling, r2_objects: objects.length, bytes: objects.reduce((n, o) => n + o.bytes, 0), complete };
  await env.DB.prepare('INSERT INTO product_orphan_reports(id,actor_id,report) VALUES (?,?,?)').bind(scanId, actorId, JSON.stringify({ ...report, candidates, candidate_media_keys: [...keys] })).run();
  return report;
}

export async function confirmProductOrphanCleanup(env: Env, scanId: string, actorId: string) {
  const stored = await env.DB.prepare('SELECT * FROM product_orphan_reports WHERE id=?').bind(scanId).first<Row>();
  if (!stored) throw badRequest('Run and review a dry run first');
  if (stored.confirmed_at) return { already_cleaned: true };
  const report = JSON.parse(String(stored.report)) as ProductOrphanReport & { candidates: OrphanRow[]; candidate_media_keys: string[] };
  if (!report.complete) throw badRequest('The scan was incomplete; finish the dry run before cleanup');
  const schema = await productSchema(env.DB);
  const graph = productDependencyGraph(schema);
  const statements: D1PreparedStatement[] = [];
  const cleanupId = newId('pdel');
  statements.push(env.DB.prepare("INSERT INTO product_deletion_jobs(id,product_id,slug,actor_id,status) VALUES (?,'','orphan-maintenance',?,'committed')").bind(cleanupId, actorId));
  for (const candidate of report.candidates) {
    const dep = graph.find((d) => d.table === candidate.table);
    if (!dep || dep.table === 'products') throw badRequest('Schema changed; run a new dry run');
    const fields = Object.entries(candidate.fingerprint);
    statements.push(env.DB.prepare(`DELETE FROM ${qi(dep.table)} WHERE rowid=? AND (${dep.orphanPredicate}) AND ${fields.map(([k]) => `${qi(k)} IS ?`).join(' AND ')}`).bind(candidate.rowid, ...fields.map(([,v]) => v)));
  }
  // Only reviewed orphan objects and keys from reviewed orphan rows are queued.
  const keys = new Set(report.orphan_r2_files.map((o) => o.key));
  for (const c of report.candidates) for (const k of ownedMediaKeys(c.fingerprint, env.APP_ORIGIN)) keys.add(k);
  for (const key of keys) statements.push(env.DB.prepare('INSERT INTO media_cleanup_jobs(id,deletion_job_id,object_key,visibility) VALUES (?,?,?,?)').bind(newId('mclean'),cleanupId,key, report.orphan_r2_files.find((o) => o.key === key)?.bucket === 'private' || !isAnonymousPublicMediaKey(key) ? 'private' : 'public'));
  statements.push(env.DB.prepare("UPDATE product_orphan_reports SET confirmed_at=datetime('now') WHERE id=? AND confirmed_at IS NULL").bind(scanId));
  await env.DB.batch(statements);
  const cleanup = await processProductMediaCleanup(env, cleanupId, 30, schema);
  const cache = await invalidateDeletedProductCache(env, '', '', keys);
  return { already_cleaned: false, cleanup_job_id: cleanupId, ...cleanup, cache_keys_invalidated: cache };
}
