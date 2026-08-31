/**
 * Does the code protect every subdomain this zone ACTUALLY uses?
 *
 * `SYSTEM_SUBDOMAINS` is a list somebody typed. The zone's DNS records are
 * the list of names that really exist. This compares the two, in the one
 * direction that can hurt:
 *
 *   A NAME WITH A DNS RECORD THAT IS NOT RESERVED IN CODE.
 *
 * The wildcard makes that concrete. `*.levonis-iq.com/*` is bound to the
 * Worker, and a Worker route matches a hostname whether or not that hostname
 * has its own DNS record — the record decides where the request lands, the
 * route decides what answers once it lands on Cloudflare. So a PROXIED record
 * for a name the code does not reserve means the Worker receives that
 * service's traffic and classifies it as a merchant slug. `studio` is the
 * example that already exists: it has its own record AND it is reserved, and
 * only the second half is what makes `studio.levonis-iq.com` serve LEVO
 * Studio instead of a store page.
 *
 * An UNPROXIED record (mail, a TXT, an external host) never reaches the
 * Worker, so it cannot be hijacked that way — but a merchant could still
 * register the slug and own a name the rest of the internet already
 * associates with a service here. That is reported as a warning, not a
 * failure.
 *
 * The reverse direction is deliberately NOT checked: reserving a name with no
 * record is the entire point of the phishing group (`login`, `verify`,
 * `secure`…). Those names are refused because of who would otherwise ask for
 * them.
 *
 * Usage:  DOMAIN=levonis-iq.com node scripts/audit-reserved-subdomains.mjs [dns.json]
 *
 * `dns.json` is a raw Cloudflare `GET /zones/:id/dns_records` response. The
 * script never talks to Cloudflare itself and never sees a token.
 */
import { readFileSync } from 'node:fs';
import { isSystemSlug, isValidSlugSyntax, normalizeHost } from '../worker/lib/hosts.ts';

const DOMAIN = (process.env.DOMAIN || 'levonis-iq.com').toLowerCase();
const FILE = process.argv[2] || '/tmp/dns.json';

let payload;
try {
  payload = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (err) {
  console.log(`skipped — no DNS record list to audit (${FILE}: ${err.code || err.message})`);
  console.log('audit=skipped');
  process.exit(0);
}

const records = Array.isArray(payload?.result) ? payload.result : null;
if (!records) {
  console.log('skipped — the file is not a Cloudflare dns_records response');
  console.log('audit=skipped');
  process.exit(0);
}

/** One label under the root, e.g. `studio` from `studio.levonis-iq.com`. */
function oneLabelUnderRoot(name) {
  const host = String(name || '').toLowerCase().replace(/\.$/, '');
  if (!host.endsWith('.' + DOMAIN)) return null;
  const prefix = host.slice(0, -(DOMAIN.length + 1));
  if (!prefix || prefix.includes('.')) return null;
  return prefix;
}

// Several record types can share one name (A + AAAA, or a CNAME and a TXT).
// One name is one decision, so they are merged: the name reaches the Worker
// if ANY of its records is proxied.
const byName = new Map();
for (const r of records) {
  const label = oneLabelUnderRoot(r?.name);
  if (label === null) continue;
  if (label === '*') continue; // the wildcard itself is not a service
  const seen = byName.get(label) || { label, types: new Set(), proxied: false };
  seen.types.add(String(r?.type || '?'));
  if (r?.proxied === true) seen.proxied = true;
  byName.set(label, seen);
}

const reachable = [];   // proxied, unreserved — the Worker would call it a store
const collides = [];    // unreserved, but never reaches the Worker
const fine = [];        // reserved, or not a hostname label at all

for (const entry of [...byName.values()].sort((a, b) => a.label.localeCompare(b.label))) {
  const { label, proxied } = entry;
  const types = [...entry.types].sort().join('+');

  // `_dmarc`, `_domainkey` and friends are not hostnames a browser reaches
  // and cannot survive Host normalisation, so no merchant can hold one.
  if (normalizeHost(`${label}.${DOMAIN}`) === null || !isValidSlugSyntax(label)) {
    fine.push(`  ok   ${label}  (${types})  — not a usable slug, no merchant can claim it`);
    continue;
  }
  if (label === 'www' || isSystemSlug(label)) {
    fine.push(`  ok   ${label}  (${types}, proxied=${proxied})  — reserved in code`);
    continue;
  }
  if (proxied) {
    reachable.push(`  FAIL ${label}  (${types}, proxied)  — reaches the Worker and is NOT reserved`);
  } else {
    collides.push(`  WARN ${label}  (${types}, not proxied)  — a merchant could claim this slug`);
  }
}

console.log(`one-label names with DNS records under ${DOMAIN}: ${byName.size}`);
for (const line of fine) console.log(line);
for (const line of collides) console.log(line);
for (const line of reachable) console.log(line);

if (reachable.length) {
  console.log('');
  console.log('A name that already has a proxied record is a service that exists.');
  console.log(`Add it to SYSTEM_SUBDOMAINS in worker/lib/hosts.ts, then deploy:`);
  console.log(`  ${reachable.map((l) => l.trim().split(/\s+/)[1]).join(', ')}`);
  console.log('audit=FAILED');
  process.exit(1);
}
console.log(collides.length ? 'audit=warnings' : 'audit=ok');
