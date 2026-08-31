/**
 * Does adding a name to SYSTEM_SUBDOMAINS take an existing shop offline?
 *
 * THE FAILURE THIS PREVENTS is the reserved list's own side effect.
 * `classifyHost` checks the reserved list BEFORE looking a slug up, so a name
 * that becomes reserved stops resolving to its store — instantly, on deploy,
 * with no error anywhere. If a merchant already trades as
 * `shop.levonis-iq.com` and `shop` joins the list, their storefront is simply
 * gone, and every link, QR code and printed box pointing at it is dead.
 *
 * The list grew from 44 names to 138 in one commit. That is exactly the
 * change that can do this, so the live slugs are read and compared BEFORE the
 * code that would refuse them is deployed.
 *
 * Read-only: one SELECT, no writes, no deletions. It reports the collision and
 * stops the deploy; what to do about it — rename the store with the merchant's
 * agreement, or drop the name from the list — is not a decision a script makes.
 *
 * Usage:  node scripts/check-live-store-slugs.mjs <wrangler-d1-json-output>
 *
 * The file is whatever `wrangler d1 execute --json` printed. Wrangler prefixes
 * its JSON with banner lines, so the parse starts at the first bracket, and
 * falls back to reading the slugs out of the text if that fails. A file it
 * cannot understand is reported as SKIPPED, never as a pass.
 */
import { readFileSync } from 'node:fs';
import { isSystemSlug } from '../worker/lib/hosts.ts';

const FILE = process.argv[2];
if (!FILE) {
  console.log('usage: node scripts/check-live-store-slugs.mjs <file>');
  console.log('slugs=skipped');
  process.exit(0);
}

let text;
try {
  text = readFileSync(FILE, 'utf8');
} catch (err) {
  console.log(`skipped — cannot read ${FILE} (${err.code || err.message})`);
  console.log('slugs=skipped');
  process.exit(0);
}

/** Slugs, however they can be got out of what wrangler printed. */
function slugsFrom(raw) {
  const start = raw.indexOf('[');
  if (start !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(start));
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r?.results ?? []);
      if (rows.length) return { slugs: rows.map((r) => String(r.slug ?? '')).filter(Boolean), how: 'json' };
      // A real, empty result set. No stores exist yet, and that is an answer.
      if (Array.isArray(parsed) && parsed.some((r) => Array.isArray(r?.results))) {
        return { slugs: [], how: 'json' };
      }
    } catch { /* fall through to the text read */ }
  }
  const found = [...raw.matchAll(/"slug"\s*:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  return found.length ? { slugs: found, how: 'text' } : { slugs: null, how: 'none' };
}

const { slugs, how } = slugsFrom(text);
if (slugs === null) {
  console.log('skipped — no query result could be read from that output');
  console.log('slugs=skipped');
  process.exit(0);
}

console.log(`live store slugs read (${how}): ${slugs.length}`);
const collisions = slugs.filter((s) => isSystemSlug(s) || s === 'www');
for (const s of slugs) {
  console.log(`  ${collisions.includes(s) ? 'FAIL' : 'ok  '} ${s}`);
}

if (collisions.length) {
  console.log('');
  console.log('These stores are LIVE and their names are reserved in code.');
  console.log('Deploying this would take their storefronts offline:');
  console.log(`  ${collisions.join(', ')}`);
  console.log('');
  console.log('Either drop the name from SYSTEM_SUBDOMAINS in worker/lib/hosts.ts,');
  console.log("or move the store to a new slug WITH the merchant's agreement first.");
  console.log('slugs=FAILED');
  process.exit(1);
}
console.log('slugs=ok');
