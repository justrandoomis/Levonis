import type { Env } from './types';
import { HttpError } from './http';
import { newId } from './crypto';
import { deleteMediaObject, headMediaObject, isSafeMediaKey, isAnonymousPublicMediaKey } from './mediaStorage';

type Row = Record<string, unknown>;
interface ForeignKey { id?: number; table: string; from: string; to: string; on_delete: string }
export interface ProductDependency { table: string; predicate: string; orphanPredicate: string; depth: number }
export interface TableInfo { table: string; columns: string[]; foreignKeys: ForeignKey[] }
const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;
const HISTORY = new Set(['order_items', 'order_item_units', 'warranty_receipts', 'reviews', 'review_rewards', 'mystery_allocations', 'mystery_draw_audits', 'offer_redemptions', 'historical_inventory_ledger', 'product_deletion_jobs', 'media_cleanup_jobs']);

export async function productSchema(db: D1Database): Promise<TableInfo[]> {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results;
  const result: TableInfo[] = [];
  for (let i = 0; i < tables.length; i += 30) {
    const batch = tables.slice(i, i + 30);
    const info = await Promise.all(batch.flatMap(({ name }) => [db.prepare(`PRAGMA table_info(${qi(name)})`).all(), db.prepare(`PRAGMA foreign_key_list(${qi(name)})`).all()]));
    batch.forEach(({ name }, j) => result.push({ table: name, columns: (info[j * 2].results as Array<{ name: string }>).map((r) => r.name), foreignKeys: info[j * 2 + 1].results as unknown as ForeignKey[] }));
  }
  return result;
}

/** The graph comes from the deployed schema. Unconstrained polymorphic links
 * are explicitly declared; financial/history tables are never cascaded. */
export function productDependencyGraph(schema: TableInfo[]): ProductDependency[] {
  const owned = new Map<string, ProductDependency>([['products', { table: 'products', predicate: 'id=?1', orphanPredicate: '0', depth: 0 }]]);
  for (let pass = 0; pass < schema.length; pass++) {
    let added = false;
    for (const t of schema) {
      if (owned.has(t.table) || HISTORY.has(t.table)) continue;
      const parents = t.foreignKeys.filter((f) => owned.has(f.table));
      if (!parents.length) continue;
      const direct = parents.filter((f) => f.table === 'products');
      const links = direct.length ? direct : parents;
      const predicate = links.map((f) => `${qi(f.from)} IN (SELECT ${qi(f.to || 'id')} FROM ${qi(f.table)} WHERE ${owned.get(f.table)!.predicate})`).join(' OR ');
      const orphanPredicate = links.map((f) => `(${qi(f.from)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${qi(f.table)} parent WHERE parent.${qi(f.to || 'id')}=${qi(t.table)}.${qi(f.from)}))`).join(' OR ');
      owned.set(t.table, { table: t.table, predicate: `(${predicate})`, orphanPredicate: `(${orphanPredicate})`, depth: Math.max(...links.map((f) => owned.get(f.table)!.depth)) + 1 });
      added = true;
    }
    if (!added) break;
  }
  for (const table of ['price_history']) if (schema.some((t) => t.table === table)) owned.set(table, { table, predicate: 'product_id=?1', orphanPredicate: 'NOT EXISTS (SELECT 1 FROM products WHERE products.id=price_history.product_id)', depth: 1 });
  for (const table of ['offer_windows', 'offer_limits']) if (schema.some((t) => t.table === table)) owned.set(table, { table, predicate: "subject_type='product' AND subject_id=?1", orphanPredicate: `subject_type='product' AND NOT EXISTS (SELECT 1 FROM products WHERE products.id=${qi(table)}.subject_id)`, depth: 1 });
  // Topological depth must include ALL parents, including a table that also
  // has a direct product FK. Otherwise CASCADE deletes grandchildren before
  // their cleanup statement and a RESTRICT edge may prevent deletion.
  for (let pass = 0; pass < schema.length; pass++) {
    let changed = false;
    for (const t of schema) {
      const dep = owned.get(t.table);
      if (!dep || t.table === 'products') continue;
      const parents = t.foreignKeys.filter((f) => f.table !== t.table && owned.has(f.table));
      const depth = Math.max(dep.depth, ...parents.map((f) => owned.get(f.table)!.depth + 1));
      if (depth !== dep.depth) { dep.depth = depth; changed = true; }
    }
    if (!changed) break;
    if (pass === schema.length - 1) throw new Error('Cyclic product ownership requires an explicit cleanup policy');
  }
  // Missing intermediate parents count as orphans too. Group composite FKs
  // by id so product_id + option_id are checked together.
  for (const dep of [...owned.values()].sort((a,b) => a.depth-b.depth)) {
    if (dep.table === 'products') continue;
    const info = schema.find((t) => t.table === dep.table)!;
    const groups = new Map<string, ForeignKey[]>();
    for (const fk of info.foreignKeys.filter((f) => owned.has(f.table))) {
      const key = `${fk.table}:${fk.id ?? fk.from}`;
      groups.set(key, [...groups.get(key) ?? [], fk]);
    }
    const clauses = [...groups.values()].map((links) => {
      const parent = owned.get(links[0].table)!;
      const match = links.map((f) => `${qi(f.table)}.${qi(f.to || 'id')}=${qi(dep.table)}.${qi(f.from)}`).join(' AND ');
      return `(${links.map((f) => `${qi(dep.table)}.${qi(f.from)} IS NOT NULL`).join(' AND ')} AND NOT EXISTS (SELECT 1 FROM ${qi(parent.table)} WHERE ${match} AND NOT (${parent.orphanPredicate})))`;
    });
    if (clauses.length) dep.orphanPredicate = clauses.join(' OR ');
  }
  return [...owned.values()].sort((a, b) => b.depth - a.depth || a.table.localeCompare(b.table));
}

/** Only first-party delivery URLs or explicit internal keys identify R2 data. */
export function ownedMediaKeys(value: unknown, origin = '', field = ''): Set<string> {
  const found = new Set<string>();
  const walk = (v: unknown, name: string) => {
    if (Array.isArray(v)) { for (const item of v) walk(item, name); return; }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k); return; }
    if (typeof v !== 'string' || !v) return;
    if (v.startsWith('{') || v.startsWith('[')) { try { walk(JSON.parse(v), name); } catch { /* prose */ } return; }
    let path = v;
    if (/^https?:\/\//i.test(v)) {
      try { const url = new URL(v); if (!origin || url.origin !== new URL(origin).origin) return; path = url.pathname; } catch { return; }
    }
    if (path.startsWith('/files/')) path = path.slice(7).split('?')[0];
    else if (!/^(?:r2_key|media_key|object_key|key|image_key|cover_key|file_key|attachment_key)$/.test(name)) return;
    if (name === 'key' && !path.includes('/') && !/\.(?:webp|png|jpe?g|avif|gif|mp4|pdf|stl|3mf)$/i.test(path)) return;
    if (isSafeMediaKey(path)) found.add(path);
  };
  walk(value, field); return found;
}

export const MEDIA_COLUMNS = /(?:image|media|file|attachment|avatar|cover|logo|photo|video|asset|url|snapshot|content|options|colors|usage_guide|ops_policy|^key$)/i;
export const NON_REFERENCES = new Set(['file_objects', 'file_migration_log', 'product_deletion_jobs', 'media_cleanup_jobs', 'product_orphan_reports', 'audit_log', 'core_audit_details', 'historical_inventory_ledger', 'media_cleanup_locks']);

/** Exact JSON scalar matching, not substring ref-counting. Errors fail closed.
 * file_objects is metadata, not a consumer reference. Historical snapshots ARE
 * consumers and retain their images independently of the live product. */
export async function mediaReferenceExists(db: D1Database, schema: TableInfo[], key: string, origin = '', ignoreOrphans = false): Promise<boolean> {
  const graph = ignoreOrphans ? productDependencyGraph(schema) : [];
  const queries: string[] = [];
  for (const table of schema) {
    if (NON_REFERENCES.has(table.table)) continue;
    const columns = table.columns.filter((c) => MEDIA_COLUMNS.test(c));
    if (!columns.length) continue;
    // Query strings, first-party absolute URLs and relative URLs all refer to
    // the same immutable object. False positives retain a file, never delete it.
    const clauses = columns.map((c) => `EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(${qi(c)}) THEN ${qi(c)} ELSE json_array(${qi(c)}) END) j WHERE j.type='text' AND (j.value=?1 OR j.value=?2 OR j.value=?3 OR substr(j.value,1,length(?2)+1)=?2||'?' OR substr(j.value,1,length(?3)+1)=?3||'?'))`);
    const orphan = graph.find((d) => d.table === table.table)?.orphanPredicate;
    queries.push(`SELECT 1 found FROM ${qi(table.table)} WHERE (${clauses.join(' OR ')})${orphan ? ` AND NOT (${orphan})` : ''}`);
  }
  for (let i = 0; i < queries.length; i += 10) {
    // D1 limits compound SELECT terms more tightly than desktop SQLite.
    // EXISTS groups retain short-circuiting without a compound UNION query.
    const sql = 'SELECT 1 found WHERE ' + queries.slice(i, i + 10).map((q) => `EXISTS (${q})`).join(' OR ') + ' LIMIT 1';
    if (await db.prepare(sql).bind(key, `/files/${key}`, `${origin.replace(/\/$/, '')}/files/${key}`).first()) return true;
  }
  return false;
}

export interface ProductDeleteReport {
  product_deleted: boolean;
  already_deleted: boolean;
  deletion_job_id: string | null;
  rows_deleted_by_table: Record<string, number>;
  r2_objects_deleted: number;
  r2_objects_shared_skipped: number;
  r2_cleanup_pending: number;
  cache_keys_invalidated: string[];
}

export async function processProductMediaCleanup(env: Env, jobId?: string, limit = 30, knownSchema?: TableInfo[]): Promise<{ deleted: number; shared: number; pending: number }> {
  const jobs = (await env.DB.prepare(`SELECT * FROM media_cleanup_jobs WHERE status IN ('pending','retry') AND not_before<=datetime('now') ${jobId ? 'AND deletion_job_id=?' : ''} ORDER BY attempts,id LIMIT ${Math.max(1, Math.min(limit, 200))}`).bind(...(jobId ? [jobId] : [])).all<Row>()).results;
  if (!jobs.length) {
    const pending = Number((await env.DB.prepare(`SELECT COUNT(*) n FROM media_cleanup_jobs WHERE status IN ('pending','retry') ${jobId ? 'AND deletion_job_id=?' : ''}`).bind(...(jobId ? [jobId] : [])).first<{n:number}>())?.n ?? 0);
    return { deleted: 0, shared: 0, pending };
  }
  const schema = knownSchema ?? await productSchema(env.DB);
  let deleted = 0; let shared = 0;
  for (const job of jobs) {
    const key = String(job.object_key);
    try {
      await env.DB.prepare("INSERT OR IGNORE INTO media_cleanup_locks(object_key,job_id,state) VALUES (?,?,'deleting')").bind(key,job.id).run();
      const lock = await env.DB.prepare('SELECT job_id,state FROM media_cleanup_locks WHERE object_key=?').bind(key).first<{job_id:string;state:string}>();
      if (lock?.job_id !== job.id && lock?.state !== 'deleted') throw new Error('Another cleanup owns this object');
      if (await mediaReferenceExists(env.DB, schema, key, env.APP_ORIGIN)) {
        await env.DB.batch([
          env.DB.prepare("UPDATE media_cleanup_jobs SET status='shared',completed_at=datetime('now') WHERE id=?").bind(job.id),
          env.DB.prepare('DELETE FROM media_cleanup_locks WHERE object_key=? AND job_id=?').bind(key,job.id),
        ]); shared++; continue;
      }
      // object_key is a global identity in file_objects. During bucket migration
      // a key can occupy multiple locations; none may resurrect via fallback.
      await deleteMediaObject(env, 'public', key);
      if (env.R2_PRIVATE && env.R2_PRIVATE !== env.BUCKET && env.R2_PRIVATE !== env.R2_PUBLIC) await deleteMediaObject(env, 'private', key);
      if (await headMediaObject(env, 'public', key) || (env.R2_PRIVATE && await headMediaObject(env, 'private', key))) throw new Error('R2 object still exists after deletion');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM file_objects WHERE object_key=?').bind(key),
        env.DB.prepare("UPDATE media_cleanup_locks SET state='deleted' WHERE object_key=?").bind(key),
        env.DB.prepare("UPDATE media_cleanup_jobs SET status='done',attempts=attempts+1,last_error=NULL,completed_at=datetime('now') WHERE id=?").bind(job.id),
      ]);
      deleted++;
    } catch (error) {
      await env.DB.prepare("UPDATE media_cleanup_jobs SET status='retry',attempts=attempts+1,last_error=? WHERE id=?").bind(error instanceof Error ? error.message.slice(0, 300) : 'R2 cleanup failed', job.id).run();
    }
  }
  const pending = Number((await env.DB.prepare(`SELECT COUNT(*) n FROM media_cleanup_jobs WHERE status IN ('pending','retry') ${jobId ? 'AND deletion_job_id=?' : ''}`).bind(...(jobId ? [jobId] : [])).first<{ n: number }>())?.n ?? 0);
  if (jobId && pending === 0) await env.DB.prepare("UPDATE product_deletion_jobs SET status='done' WHERE id=?").bind(jobId).run();
  return { deleted, shared, pending };
}

export async function invalidateDeletedProductCache(env: Env, id: string, slug: string, media: Iterable<string>): Promise<string[]> {
  const store = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const revision = Number((await env.DB.prepare('SELECT revision FROM catalog_revision WHERE id=1').first<{revision:number}>())?.revision ?? 0);
  const invalidated = [`catalog-generation:${revision}:all-languages-all-queries-all-edge-locations`];
  if (!store || !env.APP_ORIGIN) return invalidated;
  const paths = [`/api/products/${id}`, `/api/products/${slug}`, '/api/products', '/api/home', '/api/bundles', ...[...media].map((k) => `/files/${k}`)];
  const deleted: string[] = [...invalidated];
  const host = new URL(env.APP_ORIGIN).hostname;
  for (const path of paths) {
    const urls = [new URL(path, env.APP_ORIGIN).href, ...['ar', 'en', 'ckb'].map((lang) => `https://gateway-cache.levonis.internal/${lang}/${host}${path}`)];
    for (const url of urls) { try { if (await store.delete(url)) deleted.push(url); } catch { /* generation makes old entries unreachable */ } }
  }
  return deleted;
}

export async function deleteProductPermanently(env: Env, id: string, actorId: string): Promise<ProductDeleteReport> {
  const before = await env.DB.prepare('SELECT revision FROM catalog_revision WHERE id=1').first<{revision:number}>();
  const row = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(id).first<Row>();
  if (!row) {
    const old = await env.DB.prepare('SELECT id FROM product_deletion_jobs WHERE product_id=? ORDER BY created_at DESC LIMIT 1').bind(id).first<{ id: string }>();
    const clean = old ? await processProductMediaCleanup(env, old.id) : { deleted: 0, shared: 0, pending: 0 };
    return { product_deleted: false, already_deleted: true, deletion_job_id: old?.id ?? null, rows_deleted_by_table: {}, r2_objects_deleted: clean.deleted, r2_objects_shared_skipped: clean.shared, r2_cleanup_pending: clean.pending, cache_keys_invalidated: [] };
  }
  const schema = await productSchema(env.DB);
  const graph = productDependencyGraph(schema);
  const keys = ownedMediaKeys(row, env.APP_ORIGIN);
  const counts: Record<string, number> = {};
  const archive: D1PreparedStatement[] = [];
  for (const dep of graph) {
    const rows = (await env.DB.prepare(`SELECT * FROM ${qi(dep.table)} WHERE ${dep.predicate}`).bind(id).all<Row>()).results;
    counts[dep.table] = rows.length;
    for (const r of rows) for (const key of ownedMediaKeys(r, env.APP_ORIGIN)) keys.add(key);
    if (dep.table === 'inventory_ledger') for (const r of rows) archive.push(env.DB.prepare('INSERT OR IGNORE INTO historical_inventory_ledger (id,product_id,snapshot) VALUES (?,?,?)').bind(r.id, id, JSON.stringify(r)));
  }
  const keyVisibility = new Map<string, string>();
  for (const r of (await env.DB.prepare("SELECT object_key,visibility FROM file_objects WHERE (domain='products' AND entity_id=?) OR object_key IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify([...keys])).all<{ object_key: string; visibility: string }>()).results) {
    if (isSafeMediaKey(r.object_key)) { keys.add(r.object_key); keyVisibility.set(r.object_key, r.visibility); }
  }
  const jobId = newId('pdel');
  const statements = [
    // An optimistic fence aborts if another editor changed the product after
    // media collection. Product writes use the same updated_at contract.
    env.DB.prepare("INSERT INTO product_deletion_jobs(id,product_id,slug,actor_id,status,revision_matches) VALUES (?,?,?,?,'committed',(SELECT COUNT(*) FROM products WHERE id=? AND updated_at=? AND (SELECT revision FROM catalog_revision WHERE id=1)=?))").bind(jobId,id,row.slug,actorId,id,row.updated_at,before?.revision ?? -1),
    ...[...keys].map((key) => env.DB.prepare('INSERT INTO media_cleanup_jobs(id,deletion_job_id,object_key,visibility) VALUES (?,?,?,?)').bind(newId('mclean'),jobId,key,keyVisibility.get(key) ?? (isAnonymousPublicMediaKey(key) ? 'public' : 'private'))),
    ...archive,
    env.DB.prepare("UPDATE file_objects SET entity_id='' WHERE domain='products' AND entity_id=?").bind(id),
    // Completed template fingerprints must not replay a now-deleted product.
    env.DB.prepare("DELETE FROM rate_limits WHERE key IN (SELECT 'tplfp:'||json_extract(detail,'$.fingerprint') FROM audit_log WHERE action='template.apply' AND target=? AND json_valid(detail))").bind(id),
    // A bundle cannot silently become a smaller, differently priced bundle.
    env.DB.prepare("UPDATE products SET status='hidden',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (SELECT bundle_product_id FROM bundle_components WHERE member_product_id=?) AND id<>?").bind(id,id),
    ...graph.map((dep) => env.DB.prepare(`DELETE FROM ${qi(dep.table)} WHERE ${dep.predicate}`).bind(id)),
  ];
  try { await env.DB.batch(statements); } catch (error) {
    if (!(await env.DB.prepare('SELECT id FROM products WHERE id=?').bind(id).first())) return deleteProductPermanently(env, id, actorId);
    throw error;
  }
  if (await env.DB.prepare('SELECT id FROM products WHERE id=?').bind(id).first()) throw new HttpError(500, 'Product delete verification failed');
  // Relational deletion is committed before any R2 operation is attempted.
  let clean = { deleted: 0, shared: 0, pending: keys.size };
  try { clean = await processProductMediaCleanup(env, jobId, 12, schema); } catch { /* committed outbox is retried by scheduled jobs */ }
  const cache = await invalidateDeletedProductCache(env, id, String(row.slug), keys);
  const after = await env.DB.prepare('SELECT revision FROM catalog_revision WHERE id=1').first<{revision:number}>();
  cache.push(`catalog-generation:${before?.revision}->${after?.revision}`);
  const report: ProductDeleteReport = { product_deleted: true, already_deleted: false, deletion_job_id: jobId, rows_deleted_by_table: counts, r2_objects_deleted: clean.deleted, r2_objects_shared_skipped: clean.shared, r2_cleanup_pending: clean.pending, cache_keys_invalidated: cache };
  await env.DB.prepare('UPDATE product_deletion_jobs SET report=? WHERE id=?').bind(JSON.stringify(report), jobId).run();
  return report;
}
