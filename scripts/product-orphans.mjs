#!/usr/bin/env node
/** Authenticated maintenance client. Default: scan/report only. Never log the
 * session cookie, follow a redirect with credentials, or clean an unreviewed scan. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) {
  console.log('LEVONIS_ADMIN_SESSION=<session> node scripts/product-orphans.mjs --origin https://levonis-iq.com --output report.json');
  console.log('After reviewing that report: same command with --reviewed report.json --confirm CLEANUP_REVIEWED_ORPHANS --output cleanup.json');
  process.exit(0);
}
const origin = new URL(arg('--origin') ?? process.env.LEVONIS_ORIGIN ?? 'https://levonis-iq.com');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') throw new Error('Use an HTTPS origin without credentials or a path');
const session = process.env.LEVONIS_ADMIN_SESSION;
if (!session || /[\r\n;]/.test(session)) throw new Error('Set LEVONIS_ADMIN_SESSION to the authorized admin session value');
const reviewed = arg('--reviewed');
let body = { dry_run: true };
if (reviewed) {
  const previous = JSON.parse(await readFile(reviewed, 'utf8'));
  if (arg('--confirm') !== 'CLEANUP_REVIEWED_ORPHANS' || previous.dry_run !== true || previous.complete !== true || !previous.scan_id) throw new Error('Cleanup requires a complete reviewed scan and --confirm CLEANUP_REVIEWED_ORPHANS');
  body = { dry_run: false, scan_id: previous.scan_id, confirm: 'CLEANUP_REVIEWED_ORPHANS' };
} else if (arg('--confirm')) throw new Error('--confirm needs --reviewed <dry-run report>');
const output = resolve(arg('--output') ?? (reviewed ? 'product-orphans-cleanup.json' : 'product-orphans-dry-run.json'));
if (reviewed && output === resolve(reviewed)) throw new Error('Keep the reviewed report: use a different output file');
const response = await fetch(new URL('/api/admin/products/maintenance/orphans', origin), {
  method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', origin: origin.origin, cookie: `levonis_session=${session}` }, body: JSON.stringify(body),
});
const result = await response.json();
if (!response.ok || result.success !== true) throw new Error(`Maintenance refused (HTTP ${response.status}): ${result.code ?? 'request failed'}`);
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
if (result.tables) console.table(result.tables);
console.log(JSON.stringify({ dry_run: result.dry_run ?? false, r2_objects: result.r2_objects, bytes: result.bytes, complete: result.complete, output }));
