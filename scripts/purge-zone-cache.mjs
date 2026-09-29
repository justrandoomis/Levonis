#!/usr/bin/env node
/**
 * PURGE THE ZONE'S CACHE AFTER A DEPLOY — the precondition of the HTML Cache
 * Rule (docs/MERCHANT_PLATFORM_V2.md §B.2; DECISIONS row 171; P2 review).
 *
 * The rewritten store and product documents leave the Worker with
 * `public, max-age=0, s-maxage=60` (worker/lib/socialPreview.ts). Nothing in
 * the zone stores them until the owner adds the Cache Rule for HTML; once it
 * exists, a colo may hold a document for up to a minute — and a document
 * names content-hashed chunks. Without this step a visitor in that minute
 * would receive the previous build's document, whose chunks the new deploy
 * no longer serves, and the ChunkBoundary card instead of the shop. So every
 * deploy of the Worker that serves levonis-iq.com ends by purging the zone.
 *
 * `purge_everything`, not a URL list: purge by hostname or prefix is an
 * Enterprise feature, and the document set (the apex, every store host, every
 * product page) is not enumerable from here. The cost is a cold cache for the
 * hashed assets (a new build has new names anyway) and the `/files` images
 * (one R2 read per image per colo, once) — bounded and paid once per deploy.
 *
 * Needs CLOUDFLARE_ZONE_ID (the zone of levonis-iq.com) and a
 * CLOUDFLARE_API_TOKEN with «Zone → Cache Purge → Purge». Without the zone id
 * the step prints a notice and exits 0 — and the owner must NOT flip the
 * Cache Rule until it is set; with it, a failed purge fails the step, because
 * the owner asked for it and a silent failure is exactly the stale minute.
 *
 *   CLOUDFLARE_ZONE_ID=… CLOUDFLARE_API_TOKEN=… node scripts/purge-zone-cache.mjs
 *   node scripts/purge-zone-cache.mjs --dry-run   (prints what it would do)
 */
const zone = (process.env.CLOUDFLARE_ZONE_ID || '').trim();
const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
const dryRun = process.argv.includes('--dry-run');

const notice = (msg) => console.log(`::notice::${msg}`);
const fail = (msg) => {
  console.log(`::error::${msg}`);
  process.exit(1);
};

if (!zone) {
  notice(
    'CLOUDFLARE_ZONE_ID is not set: the zone cache was NOT purged. Until it is, do not enable the HTML Cache Rule ' +
      '(a colo could serve the previous build\'s document for up to 60 s after a deploy). Set the secret to the zone id of levonis-iq.com.'
  );
  process.exit(0);
}
if (!token) fail('CLOUDFLARE_ZONE_ID is set but CLOUDFLARE_API_TOKEN is empty: cannot purge.');

const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone)}/purge_cache`;
if (dryRun) {
  console.log(`dry run: POST ${url} {"purge_everything":true}`);
  process.exit(0);
}

let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purge_everything: true }),
  });
} catch (e) {
  fail(`purge request failed: ${e instanceof Error ? e.message : String(e)}`);
}
const body = await res.json().catch(() => ({}));
if (!res.ok || body?.success !== true) {
  const errors = Array.isArray(body?.errors) ? body.errors.map((e) => `${e.code}: ${e.message}`).join('; ') : '';
  fail(`purge refused (${res.status})${errors ? `: ${errors}` : ''} — the token needs Zone → Cache Purge → Purge on this zone.`);
}
console.log(`zone ${zone}: cache purged (purge_everything) — the new build's documents are what every colo serves from now.`);
