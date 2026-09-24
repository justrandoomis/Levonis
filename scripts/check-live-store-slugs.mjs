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
 * RETIRED NAMES COUNT TOO (review F9). A store that was renamed keeps its old
 * slug parked in `merchant_store_slugs` (active = 0), and the storefront
 * redirects that old address to the new one — which is what keeps a QR code
 * printed before the rename working. A reserved word stops that redirect the
 * same way it stops a live store, so the query feeds both, and each row says
 * which it is (`kind`: `live` | `retired`).
 *
 * The list grew from 44 names to 138 in one commit, and wave 1 reserved the
 * storefront's own path words (`resolve`, `by-id`, `p`, `products`, …). Those
 * are exactly the changes that can do this, so the live slugs are read and
 * compared BEFORE the code that would refuse them is deployed.
 *
 * Read-only: one SELECT, no writes, no deletions. It reports the collision and
 * stops the deploy; what to do about it — rename the store with the merchant's
 * agreement, or drop the name from the list — is not a decision a script makes.
 *
 * IT FAILS CLOSED (review F9). A guard whose database read failed used to
 * print `slugs=skipped` and exit 0, and the deploy went on — the one outcome
 * that can take a shop offline without anybody having looked. No answer is now
 * a stop, exactly like a collision: `slugs=unreadable`, exit 1.
 *
 * Usage:  node scripts/check-live-store-slugs.mjs <wrangler-d1-json-output>
 *
 * The file is whatever `wrangler d1 execute --json` printed. Wrangler prefixes
 * its JSON with banner lines, so the parse starts at the first bracket, and
 * falls back to reading the slugs out of the text if that fails.
 */
import { readFileSync } from 'node:fs';
import { isSystemSlug } from '../worker/lib/hosts.ts';

/** No answer is not a pass: say why, and stop the deploy. */
function unreadable(why) {
  console.log(`cannot check the live store slugs — ${why}`);
  console.log('Deploying without this check could take a shop offline, so the deploy stops here.');
  console.log('Fix the read (credentials, the database name, the query) and run it again.');
  console.log('slugs=unreadable');
  process.exit(1);
}

const FILE = process.argv[2];
if (!FILE) {
  console.log('usage: node scripts/check-live-store-slugs.mjs <file>');
  unreadable('no query output was given');
}

let text;
try {
  text = readFileSync(FILE, 'utf8');
} catch (err) {
  unreadable(`cannot read ${FILE} (${err.code || err.message})`);
}

/** Rows `{ slug, kind }`, however they can be got out of what wrangler printed. */
function rowsFrom(raw) {
  const start = raw.indexOf('[');
  if (start !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(start));
      const results = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r?.results ?? []);
      if (results.length) {
        return {
          rows: results
            .map((r) => ({ slug: String(r.slug ?? ''), kind: r.kind === 'retired' ? 'retired' : 'live' }))
            .filter((r) => r.slug),
          how: 'json',
        };
      }
      // A real, empty result set. No stores exist yet, and that is an answer.
      if (Array.isArray(parsed) && parsed.some((r) => Array.isArray(r?.results))) {
        return { rows: [], how: 'json' };
      }
    } catch { /* fall through to the text read */ }
  }
  const found = [...raw.matchAll(/"slug"\s*:\s*"([a-z0-9-]+)"(?:\s*,\s*"kind"\s*:\s*"(live|retired)")?/g)].map((m) => ({
    slug: m[1],
    kind: m[2] === 'retired' ? 'retired' : 'live',
  }));
  return found.length ? { rows: found, how: 'text' } : { rows: null, how: 'none' };
}

const { rows, how } = rowsFrom(text);
if (rows === null) unreadable('no query result could be read from that output');

const live = rows.filter((r) => r.kind === 'live').length;
console.log(`live store slugs read (${how}): ${live}`);
console.log(`retired store names read (${how}): ${rows.length - live}`);
const collides = (s) => isSystemSlug(s) || s === 'www';
const collisions = rows.filter((r) => collides(r.slug));
for (const r of rows) {
  console.log(`  ${collides(r.slug) ? 'FAIL' : 'ok  '} ${r.slug}${r.kind === 'retired' ? ' (retired name, redirects)' : ''}`);
}

if (collisions.length) {
  const liveHits = collisions.filter((r) => r.kind === 'live').map((r) => r.slug);
  const retiredHits = collisions.filter((r) => r.kind === 'retired').map((r) => r.slug);
  console.log('');
  if (liveHits.length) {
    console.log('These stores are LIVE and their names are reserved in code.');
    console.log('Deploying this would take their storefronts offline:');
    console.log(`  ${liveHits.join(', ')}`);
  }
  if (retiredHits.length) {
    console.log('These are the OLD names of renamed stores, and they are reserved in code.');
    console.log('Deploying this would break the redirect every old link and QR code relies on:');
    console.log(`  ${retiredHits.join(', ')}`);
  }
  console.log('');
  console.log('Either drop the name from SYSTEM_SUBDOMAINS in worker/lib/hosts.ts,');
  console.log("or move the store to a new slug WITH the merchant's agreement first.");
  console.log('slugs=FAILED');
  process.exit(1);
}
console.log('slugs=ok');
