/**
 * THE HEADERS THE PROGRESSIVE-WEB-APP FILES ARE SERVED WITH.
 *
 * `/sw.js` and `/icons/*` are answered by the ASSET LAYER, not by the Worker —
 * they are not in `run_worker_first`, and this file asserts that they stay out
 * of it. So the only headers they ever carry are the ones `dist/_headers`
 * gives them, and `dist/_headers` is generated wholesale from
 * `assetHeadersFile()` in worker/lib/securityPolicy.ts.
 *
 * WHY THIS IS NOT A STRING-MATCHING TEST. `_headers` does NOT do what the
 * comment next to the `/assets/*` block claims: the asset layer applies EVERY
 * matching rule in file order and APPENDS to a header an earlier rule already
 * set, rather than replacing it. Live, a built chunk comes back with
 * `Cache-Control: no-cache, public, max-age=31536000, immutable` — the catch-
 * all's `no-cache` wins in every conformant client and the `immutable` block
 * does nothing at all. Asserting "the file contains a line" would therefore
 * have passed for an `/icons/*` rule that revalidates on every single visit.
 * So the file is parsed and the rules are APPLIED, the way the runtime applies
 * them, and the assertions are on the header a browser would actually receive.
 *
 * tests/securityPolicy.test.ts owns the catch-all and the /assets rule; this
 * file owns only what the PWA added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assetHeadersFile,
  ICON_CACHE_CONTROL,
  SERVICE_WORKER_CACHE_CONTROL,
  STATIC_SECURITY_HEADERS,
  STRICT_TRANSPORT_SECURITY,
  spaCsp,
} from '../worker/lib/securityPolicy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ------------------------------------------------ the file, as the edge reads it

interface Rule {
  path: string;
  set: Array<[string, string]>;
  unset: string[];
}

/**
 * The same shape wrangler's own parser produces: a line beginning with `/`
 * opens a rule, `! Name` (two characters, no colon) unsets, `Name: value`
 * sets, `#` and blank lines are ignored, everything is trimmed.
 */
function parseRules(file: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of file.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('/')) {
      rules.push({ path: line, set: [], unset: [] });
      continue;
    }
    const rule = rules[rules.length - 1];
    assert.ok(rule, `header line before any path: ${line}`);
    if (!line.includes(':')) {
      assert.ok(line.startsWith('! '), `not a header and not an unset: ${line}`);
      rule.unset.push(line.slice(2).trim());
      continue;
    }
    const at = line.indexOf(':');
    rule.set.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return rules;
}

const matches = (rulePath: string, path: string) =>
  rulePath.endsWith('/*') ? path.startsWith(rulePath.slice(0, -1)) : rulePath === '/*' || rulePath === path;

/**
 * What the visitor actually receives for `path`. Mirrors the runtime: unset
 * deletes, and a header name already set by an earlier rule is APPENDED to.
 */
function served(file: string, path: string): Map<string, string> {
  const headers = new Map<string, string>();
  const everSet = new Set<string>();
  for (const rule of parseRules(file)) {
    if (!(rule.path === '/*' || matches(rule.path, path))) continue;
    for (const name of rule.unset) headers.delete(name.toLowerCase());
    for (const [name, value] of rule.set) {
      const key = name.toLowerCase();
      const existing = headers.get(key);
      headers.set(key, everSet.has(key) && existing !== undefined ? `${existing}, ${value}` : value);
      everSet.add(key);
    }
  }
  return headers;
}

// ------------------------------------------------------------------ the rules

test('the PWA rules are APPENDED after the catch-all, never before it', () => {
  const rules = parseRules(assetHeadersFile());
  const paths = rules.map((r) => r.path);
  assert.equal(paths[0], '/*', 'the catch-all must stay first or every page loses its policy');
  assert.ok(paths.includes('/sw.js'), 'no rule for the service worker script');
  assert.ok(paths.includes('/icons/*'), 'no rule for the app icons');
  assert.ok(paths.indexOf('/sw.js') > 0 && paths.indexOf('/icons/*') > 0);

  // wrangler's own limits, so a rule can never be silently dropped.
  assert.ok(rules.length <= 100, 'MAX_HEADER_RULES');
  for (const line of assetHeadersFile().split('\n')) assert.ok(line.length <= 2000, 'MAX_LINE_LENGTH');
  // One wildcard per rule path, and no `:splat` placeholder beside it.
  for (const rule of rules) assert.ok((rule.path.match(/\*/g) ?? []).length <= 1, rule.path);
});

test('/sw.js is served a NON-caching Cache-Control, and one value, not two', () => {
  // A stale service worker keeps running after it is fixed. `no-cache` means
  // the browser revalidates on the next navigation, which is when a correction
  // reaches an already-installed visitor instead of up to a day later.
  const headers = served(assetHeadersFile(), '/sw.js');
  const cacheControl = headers.get('cache-control');
  assert.equal(cacheControl, SERVICE_WORKER_CACHE_CONTROL);
  assert.match(String(cacheControl), /no-cache|no-store/);
  assert.doesNotMatch(String(cacheControl), /immutable/);
  assert.doesNotMatch(String(cacheControl), /,/, 'the catch-all value leaked through: unset the header first');
  assert.equal(headers.size >= 7, true, 'the rule must be complete on its own');
});

test('/sw.js still carries the full security policy of every other page', () => {
  const headers = served(assetHeadersFile(), '/sw.js');
  assert.equal(headers.get('strict-transport-security'), STRICT_TRANSPORT_SECURITY);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    assert.equal(headers.get(name.toLowerCase()), value, name);
  }
  assert.equal(headers.get('content-security-policy'), spaCsp(), 'the SAME policy text as every other page');

  // Exactly once, each. The rule unsets before it sets precisely so that an
  // inherited copy cannot be appended to — and a doubled
  // Strict-Transport-Security is not a doubled protection, its grammar has no
  // comma in it, so the browser throws the whole header away.
  for (const [name, value] of headers) assert.doesNotMatch(value, /^(.+), \1$/, `${name} shipped twice`);
});

test('/icons/* is cacheable for a week, and never immutable', () => {
  // The icon names carry the logo's revision (`icon-192.bc80fc2b.png`), but
  // that is a promise a person keeps by running the generator, not one the
  // build enforces on every byte — so they are still not `immutable`: a
  // regeneration that forgot the rename must not be pinned for a year.
  const headers = served(assetHeadersFile(), '/icons/icon-192.bc80fc2b.png');
  const cacheControl = String(headers.get('cache-control'));
  assert.equal(cacheControl, ICON_CACHE_CONTROL);
  assert.doesNotMatch(cacheControl, /immutable/);
  assert.doesNotMatch(cacheControl, /no-cache/, 'the inherited no-cache makes this rule buy nothing');

  const maxAge = /max-age=(\d+)/.exec(cacheControl);
  assert.ok(maxAge, 'a max-age is the whole point of the rule');
  assert.equal(Number(maxAge[1]), 604800, 'seven days');

  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('strict-transport-security'), STRICT_TRANSPORT_SECURITY);
  assert.equal(headers.get('content-security-policy'), spaCsp());
  for (const [name, value] of headers) assert.doesNotMatch(value, /^(.+), \1$/, `${name} shipped twice`);
});

test('/favicon.ico revalidates — the one icon whose name cannot carry the logo revision', () => {
  // Every icon under /icons/ is renamed when the mark changes, so a week of
  // caching there is safe. /favicon.ico is probed under exactly that path by
  // every client that has no <link> to read, so its name can never change —
  // a week here would be the stale-logo bug all over again. It takes the
  // document's `no-cache` (one cheap 304 per revalidation) and no rule of its
  // own; this pins that nobody hands it the icons' week by pattern.
  const file = assetHeadersFile();
  const headers = served(file, '/favicon.ico');
  assert.equal(headers.get('cache-control'), 'no-cache');
  assert.equal(headers.get('strict-transport-security'), STRICT_TRANSPORT_SECURITY);
  assert.ok(!parseRules(file).some((r) => r.path !== '/*' && matches(r.path, '/favicon.ico')));
});

test('the catch-all and /assets/* are untouched by the PWA rules', () => {
  // A regression here would be this change quietly altering the cache policy
  // of the document or of every built chunk.
  const file = assetHeadersFile();
  assert.equal(served(file, '/').get('cache-control'), 'no-cache');
  assert.equal(served(file, '/auth').get('cache-control'), 'no-cache');
  assert.match(String(served(file, '/assets/index-Bxordacj.js').get('cache-control')), /immutable/);
});

// -------------------------------------------------------------- the two copies

test('/sw.js and /icons/* are NOT routed through the Worker', () => {
  // Deliberate: the asset layer answers them straight from dist/, and
  // tests/securityPolicy.test.ts holds the allowlist of the six paths that may
  // appear here. Routing the service worker through the Worker would put a
  // D1 session lookup on every service-worker update check, for nothing.
  const wrangler = read('wrangler.jsonc');
  const blocks = wrangler.match(/"run_worker_first"\s*:\s*\[[^\]]*\]/g) ?? [];
  assert.equal(blocks.length, 3, 'top-level, staging and dark each declare it');
  for (const block of blocks) {
    assert.equal(block.includes('/sw.js'), false, block);
    assert.equal(block.includes('/icons/'), false, block);
  }
});

test('/store-icon/* is the Worker\'s, not the asset layer\'s — no _headers rule may claim it (W2-D)', () => {
  // The per-host home-screen and tab icons are answered by the Worker
  // (worker/routes/manifest.ts `storeIconRoute`, in run_worker_first), which
  // sets their revalidating Cache-Control itself. A `_headers` rule for them
  // would be dead weight at best, and — since the asset layer APPENDS to a
  // header an earlier rule set — a second Cache-Control at worst. The icons
  // the asset layer does serve keep their own week under /icons/*.
  const file = assetHeadersFile();
  assert.ok(!parseRules(file).some((r) => r.path.startsWith('/store-icon')));
  assert.equal(served(file, '/icons/apple-touch-icon.bc80fc2b.png').get('cache-control'), ICON_CACHE_CONTROL);
});

test('the platform-kit copy of securityPolicy.ts is byte-identical', () => {
  // tests/edgeParity.test.ts pins this too, and it also runs outside the unit
  // suite under `npm run check:boundaries`. It is repeated here because this
  // is the file that edits securityPolicy.ts, and a forgotten `cp` is the
  // single most likely way for this change to go red somewhere else.
  assert.equal(
    read('packages/platform-kit/src/edge/securityPolicy.ts'),
    read('worker/lib/securityPolicy.ts'),
    'run: cp worker/lib/securityPolicy.ts packages/platform-kit/src/edge/securityPolicy.ts'
  );
});
