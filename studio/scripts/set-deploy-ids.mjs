#!/usr/bin/env node
/**
 * Substitutes deploy-time resource identifiers into studio/wrangler.jsonc.
 * Studio-specific counterpart of the root scripts/set-deploy-ids.mjs — same
 * conventions: values come from environment variables (set by the GitHub
 * Actions workflows) and are never committed or printed.
 *
 *   STUDIO_STAGING_DB_ID -> replaces STUDIO-STAGING-DB-ID-PLACEHOLDER
 *   STUDIO_PROD_DB_ID    -> replaces STUDIO-PROD-DB-ID-PLACEHOLDER
 *   STUDIO_PROD_DB_NAME  -> replaces the top-level "levonis-studio-db" database_name
 *   STUDIO_PROD_BUCKET   -> replaces the top-level "levonis-studio-files" bucket_name
 *
 * Run BEFORE `npm run build` so the Cloudflare Vite plugin bakes the real IDs
 * into the emitted dist/ wrangler config.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../wrangler.jsonc', import.meta.url);
let cfg = readFileSync(path, 'utf8');
const changes = [];

if (process.env.STUDIO_STAGING_DB_ID) {
  cfg = cfg.replace('STUDIO-STAGING-DB-ID-PLACEHOLDER', process.env.STUDIO_STAGING_DB_ID);
  changes.push('staging database_id');
}
if (process.env.STUDIO_PROD_DB_ID) {
  cfg = cfg.replace('STUDIO-PROD-DB-ID-PLACEHOLDER', process.env.STUDIO_PROD_DB_ID);
  changes.push('production database_id');
}
if (process.env.STUDIO_PROD_DB_NAME) {
  // First occurrence only — the staging block uses a distinct name.
  cfg = cfg.replace('"database_name": "levonis-studio-db"', `"database_name": ${JSON.stringify(process.env.STUDIO_PROD_DB_NAME)}`);
  changes.push('production database_name');
}
if (process.env.STUDIO_PROD_BUCKET) {
  cfg = cfg.replace('"bucket_name": "levonis-studio-files"', `"bucket_name": ${JSON.stringify(process.env.STUDIO_PROD_BUCKET)}`);
  changes.push('production bucket_name');
}

writeFileSync(path, cfg);
console.log('studio/wrangler.jsonc updated:', changes.join(', ') || 'no changes');
