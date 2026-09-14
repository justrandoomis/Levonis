#!/usr/bin/env node
/** Product release checks. Every database statement is read-only. A successful
 * preflight is not permission to clean old orphans or to skip a maintenance
 * window. The live deployment workflow retains its existing confirmation. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const PRODUCT_RELEASE_MIGRATIONS = [
  '0072_model_fulfillment.sql',
  '0073_product_history_dependencies.sql',
  '0074_product_deletion_jobs.sql',
  '0075_legacy_model_availability.sql',
  '0076_product_media_fences_cache.sql',
  '0077_cart_fulfillment_identity.sql',
];
const REQUIRED_COLUMNS = {
  product_option_fulfillment: ['id', 'product_id', 'option_id', 'fulfillment_type', 'stock', 'reserved', 'transports_override'],
  product_option_transports: ['fulfillment_id', 'method', 'surcharge_iqd', 'regular_price_iqd', 'prime_price_iqd', 'pro_price_iqd'],
  product_option_aliases: ['legacy_option_id', 'option_id', 'legacy_snapshot'],
  product_deletion_jobs: ['id', 'revision_matches', 'report'],
  media_cleanup_jobs: ['object_key', 'status', 'not_before'],
  media_cleanup_locks: ['object_key', 'job_id', 'state'],
  product_orphan_reports: ['id', 'report', 'confirmed_at'],
  historical_inventory_ledger: ['id', 'product_id', 'snapshot'],
  catalog_revision: ['id', 'revision'],
  cart_items: ['fulfillment_type', 'local_delivery_method', 'selection_snapshot'],
  order_items: ['selection_snapshot'],
};
const literal = (s) => `'${s.replace(/'/g, "''")}'`;

/** Injected reader makes the actual SQL testable against the migrated schema. */
export async function inspectProductRelease(query) {
  const schema = await query("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = new Set(schema.map((r) => r.name));
  const applied = tables.has('d1_migrations') ? await query('SELECT name FROM d1_migrations') : [];
  const missingMigrations = PRODUCT_RELEASE_MIGRATIONS.filter((name) => !applied.some((r) => r.name === name));
  const columns = await query(`SELECT m.name AS table_name,p.name AS column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name IN (${Object.keys(REQUIRED_COLUMNS).map(literal).join(',')})`);
  const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(([table, names]) => names.filter((name) => !columns.some((r) => r.table_name === table && r.column_name === name)).map((name) => `${table}.${name}`));
  const optionColumns = tables.has('product_option_values') ? await query("SELECT name FROM pragma_table_info('product_option_values')") : [];
  const legacySchema = ['id','product_id','group_id','variant_key','availability_type'].every((name) => optionColumns.some((r) => r.name === name)) && tables.has('products') && tables.has('product_option_groups');
  let legacyRows = null;
  let duplicateLegacyRoutes = [];
  if (legacySchema) {
    const live = "v.availability_type IN ('direct_sale','pre_order') AND EXISTS(SELECT 1 FROM products p WHERE p.id=v.product_id) AND EXISTS(SELECT 1 FROM product_option_groups g WHERE g.id=v.group_id)";
    legacyRows = Number((await query(`SELECT COUNT(*) AS n FROM product_option_values v WHERE ${live}`))[0].n);
    duplicateLegacyRoutes = await query(`SELECT v.product_id,CASE WHEN v.variant_key<>'' THEN v.variant_key ELSE v.id END AS variant_key,v.availability_type,COUNT(*) AS rows FROM product_option_values v WHERE ${live} GROUP BY v.product_id,CASE WHEN v.variant_key<>'' THEN v.variant_key ELSE v.id END,v.availability_type HAVING COUNT(*)>1 LIMIT 101`);
  }
  const counts = {};
  for (const name of ['products','orders','order_items','reviews','review_rewards']) if (tables.has(name)) counts[name] = Number((await query(`SELECT COUNT(*) AS n FROM "${name}"`))[0].n);
  return {
    dry_run: true,
    ready: missingMigrations.length === 0 && missingColumns.length === 0 && legacyRows === 0,
    missing_migrations: missingMigrations,
    missing_columns: missingColumns,
    live_legacy_option_rows: legacyRows,
    ambiguous_legacy_routes: duplicateLegacyRoutes,
    ambiguous_routes_truncated: duplicateLegacyRoutes.length > 100,
    history_counts: counts,
    orphan_cleanup_performed: false,
  };
}

export function assertProductRelease(report, beforeMigration = false) {
  if (report.live_legacy_option_rows === null) throw new Error('Product schema predates the supported upgrade baseline; inspect the live schema before migrating');
  if (report.ambiguous_legacy_routes.length) throw new Error('Ambiguous legacy model/fulfillment rows require review before migration; no rows were changed');
  if (!beforeMigration && !report.ready) throw new Error(`Product schema is not ready: ${report.missing_migrations.join(', ') || report.missing_columns.join(', ') || 'legacy availability rows remain'}. Apply the reviewed upgrade before deploying this code`);
}

export function remoteD1Reader(database, environment = '', config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))) {
  if (!database || database.startsWith('-')) throw new Error('An explicit D1 database name is required');
  return async (sql) => {
    if (!/^SELECT\s/i.test(sql)) throw new Error('Release preflight accepts SELECT statements only');
    const command = [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'd1', 'execute', database, '--remote', '--json', '--config', config, '--env', environment, '--command', sql];
    let response;
    try { response = JSON.parse(execFileSync(process.execPath, command, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], maxBuffer: 8 * 1024 * 1024 })); }
    catch { throw new Error('Could not read the selected live D1 database; refusing to deploy without verifying its schema'); }
    if (!Array.isArray(response) || response.some((r) => r.success === false || !Array.isArray(r.results))) throw new Error('D1 returned an incomplete preflight response');
    return response.flatMap((r) => r.results);
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes('--help')) {
    console.log('node scripts/product-release-preflight.mjs --database <actual D1 name> [--env staging] [--before-migration] [--output report.json]');
  } else {
    const report = await inspectProductRelease(remoteD1Reader(arg('--database'), arg('--env') ?? ''));
    if (arg('--output')) writeFileSync(arg('--output'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
    assertProductRelease(report, args.includes('--before-migration'));
  }
}
