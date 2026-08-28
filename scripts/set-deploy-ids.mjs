#!/usr/bin/env node
/**
 * Substitutes deploy-time resource identifiers into wrangler.jsonc.
 * Values come from environment variables (set by the GitHub Actions
 * workflows from repository secrets) and are never committed or printed.
 *
 *   STAGING_DB_ID  -> replaces STAGING-DB-ID-PLACEHOLDER
 *   PROD_DB_ID     -> replaces PROD-DB-ID-PLACEHOLDER
 *   PROD_DB_NAME   -> replaces the top-level "levonis-db" database_name
 *   PROD_BUCKET    -> replaces the top-level "levonis-files" bucket_name
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../wrangler.jsonc', import.meta.url);
let cfg = readFileSync(path, 'utf8');
const changes = [];

if (process.env.STAGING_DB_ID) {
  cfg = cfg.replace('STAGING-DB-ID-PLACEHOLDER', process.env.STAGING_DB_ID);
  changes.push('staging database_id');
}
if (process.env.PROD_DB_ID) {
  cfg = cfg.replace('PROD-DB-ID-PLACEHOLDER', process.env.PROD_DB_ID);
  changes.push('production database_id');
}
if (process.env.PROD_DB_NAME) {
  // First occurrence only — the staging block uses a distinct name.
  cfg = cfg.replace('"database_name": "levonis-db"', `"database_name": ${JSON.stringify(process.env.PROD_DB_NAME)}`);
  changes.push('production database_name');
}
if (process.env.PROD_BUCKET) {
  cfg = cfg.replace('"bucket_name": "levonis-files"', `"bucket_name": ${JSON.stringify(process.env.PROD_BUCKET)}`);
  changes.push('production bucket_name');
}

writeFileSync(path, cfg);
console.log('wrangler.jsonc updated:', changes.join(', ') || 'no changes');
