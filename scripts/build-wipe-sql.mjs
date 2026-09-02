#!/usr/bin/env node
/**
 * Substitutes the __KEEP_EMAILS__ placeholder in scripts/wipe-live-content.sql
 * with the SQL-escaped, quoted email list from the KEEP env var (comma
 * separated) and writes the result to the path given as argv[2]
 * (default /tmp/wipe-final.sql).
 *
 * Positive selection only: exactly the emails the owner typed survive the
 * wipe. An empty list is an error, never "keep nobody".
 */
import { readFileSync, writeFileSync } from 'node:fs';

const raw = (process.env.KEEP ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (raw.length === 0) {
  console.error('KEEP is empty — refusing to build a wipe that keeps nobody');
  process.exit(1);
}
const list = raw.map((e) => `'${e.replace(/'/g, "''")}'`).join(',');
const tpl = readFileSync('scripts/wipe-live-content.sql', 'utf8');
if (!tpl.includes('__KEEP_EMAILS__')) {
  console.error('scripts/wipe-live-content.sql has no __KEEP_EMAILS__ placeholder');
  process.exit(1);
}
writeFileSync(process.argv[2] ?? '/tmp/wipe-final.sql', tpl.split('__KEEP_EMAILS__').join(list));
console.log('keep-list entries:', raw.length);
