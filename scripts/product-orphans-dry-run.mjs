/** Read-only production audit. SQL is restricted to SELECT / schema PRAGMAs.
 * No D1 mutation, R2 PUT/DELETE, cache purge, migration, or deployment exists
 * in this program. Output contains counts/keys, never customer records. */
import { writeFile } from 'node:fs/promises';
import { productSchema, productDependencyGraph, ownedMediaKeys } from '../worker/lib/productDeletion.ts';
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const origin = process.env.AUDIT_ORIGIN || 'https://levonis-iq.com';
const worker = process.env.AUDIT_WORKER || 'levonis-staging';
if (!token || !account) throw new Error('Cloudflare audit credentials are not available');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function cf(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
  const json = await response.json();
  if (!response.ok || json.success === false) throw new Error(`Cloudflare audit request failed (${response.status}; codes ${(json.errors ?? []).map(e=>e.code).join(',')})`);
  return json;
}
const settings = (await cf(`/workers/scripts/${encodeURIComponent(worker)}/settings`)).result;
const binding = settings.bindings.find(b=>b.type==='d1' && b.name==='DB');
if (!binding?.id) throw new Error('Target worker has no DB binding; audit target must be verified');
const db = { prepare(sql) {
  if (!/^\s*(SELECT\b|PRAGMA\s+(table_info|foreign_key_list)\s*\()/i.test(sql)) throw new Error('Read-only SQL guard refused a statement');
  let params=[];
  const query = async () => (await cf(`/d1/database/${binding.id}/query`,{sql,params})).result[0];
  return { bind(...p){params=p;return this;},async all(){return query();},async first(){return (await query()).results[0] ?? null;} };
}};
const qi = x=>`"${x.replace(/"/g,'""')}"`;
const schema = await productSchema(db); const graph = productDependencyGraph(schema);
const tables=[]; const owned = new Set(); const referenced=new Set();
for (const dep of graph.filter(d=>d.table!=='products')) {
  const result=await db.prepare(`SELECT COUNT(*) n FROM ${qi(dep.table)} WHERE ${dep.orphanPredicate}`).first();
  tables.push({table:dep.table,orphan_rows:Number(result.n)});
}
const ignored=new Set(['file_objects','file_migration_log','product_deletion_jobs','media_cleanup_jobs','media_cleanup_locks','product_orphan_reports','audit_log','core_audit_details','historical_inventory_ledger']);
const media=/(image|media|file|attachment|avatar|cover|logo|photo|video|asset|url|snapshot|content|options|colors|usage_guide|ops_policy|^key$)/i;
for (const table of schema) {
  if (ignored.has(table.table)) continue;
  const cols=table.columns.filter(c=>media.test(c)); if (!cols.length) continue;
  const dep=graph.find(d=>d.table===table.table);
  let offset=0;
  for (;;) {
    const page=(await db.prepare(`SELECT ${cols.map(qi).join(',')}${dep ? `,CASE WHEN ${dep.orphanPredicate} THEN 1 ELSE 0 END __orphan` : ''} FROM ${qi(table.table)} ORDER BY rowid LIMIT 500 OFFSET ?`).bind(offset).all()).results;
    for (const row of page) for (const key of ownedMediaKeys(row,origin)) { if (dep) owned.add(key); if (!row.__orphan) referenced.add(key); }
    if (page.length<500) break; offset+=page.length;
  }
}
if (schema.some(t=>t.table==='file_objects')) for (const r of (await db.prepare("SELECT object_key FROM file_objects WHERE domain='products' AND deleted_at IS NULL").all()).results) owned.add(r.object_key);
const buckets=[...new Set(settings.bindings.filter(b=>b.type==='r2_bucket' && ['BUCKET','R2_PUBLIC'].includes(b.name)).map(b=>b.bucket_name))];
if (!buckets.length) throw new Error('No product R2 bucket binding on the audited worker');
const present=new Set(); const objects=[];
for (const bucket of buckets) {
  let cursor=''; const cursors=new Set();
  do {
    const response=await cf(`/r2/buckets/${encodeURIComponent(bucket)}/objects?per_page=1000${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`);
    const page=Array.isArray(response.result) ? response.result : response.result.objects;
    if (!Array.isArray(page)) throw new Error('Unrecognized R2 list response; audit is incomplete');
    for (const o of page) {
      if (!o.key.startsWith('products/') && !owned.has(o.key)) continue;
      present.add(o.key);
      if (!referenced.has(o.key)) objects.push({key:o.key,bucket,bytes:Number(o.size)});
    }
    if (response.result_info?.is_truncated && !response.result_info.cursor) throw new Error('R2 omitted the next cursor; audit is incomplete');
    cursor=response.result_info?.is_truncated ? response.result_info.cursor : ''; 
    if (cursor && cursors.has(cursor)) throw new Error('R2 cursor repeated; audit is incomplete');
    cursors.add(cursor);
  } while(cursor);
}
let legacy=[];
if (schema.some(t=>t.table==='product_option_values' && t.columns.includes('availability_type'))) legacy=(await db.prepare("SELECT v.product_id,v.variant_key,v.availability_type,COUNT(*) rows FROM product_option_values v JOIN products p ON p.id=v.product_id WHERE v.availability_type IN ('direct_sale','pre_order') GROUP BY v.product_id,CASE WHEN v.variant_key<>'' THEN v.variant_key ELSE v.id END,v.availability_type").all()).results;
const report={dry_run:true,destructive_actions:0,complete:true,checked_at:new Date().toISOString(),origin,worker,db_binding:'DB',tables,orphan_r2_files:objects,r2_objects:objects.length,bytes:objects.reduce((n,o)=>n+o.bytes,0),dangling_db_media_refs:[...owned].filter(k=>referenced.has(k)&&!present.has(k)),legacy_option_rows:legacy.reduce((n,r)=>n+Number(r.rows),0),ambiguous_legacy_models:legacy.filter(r=>Number(r.rows)>1)};
await writeFile(process.env.AUDIT_OUTPUT || 'product-orphans-dry-run.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
