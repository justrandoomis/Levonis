/**
 * The audit that compares the code's reserved list against the zone's real
 * records — `scripts/audit-reserved-subdomains.mjs`.
 *
 * WHY THIS IS A TEST AND NOT JUST A WORKFLOW STEP. The audit only ever runs
 * in CI, against a live zone, where a passing run proves nothing about the
 * FAILING path: if the comparison were broken it would report "ok" forever
 * and nobody would notice until a merchant held a name that already meant
 * something. So the interesting cases are supplied here as fixtures.
 *
 * The rule being pinned:
 *
 *   proxied record + not reserved   → FAIL. The wildcard route sends that
 *                                     service's traffic to the Worker, which
 *                                     would classify it as a merchant slug.
 *   unproxied record + not reserved → WARN. Never reaches the Worker, but a
 *                                     merchant could still claim the name.
 *   reserved, or not slug-shaped    → fine, whatever the record says.
 *
 * The reverse direction is deliberately not audited: reserving a name with no
 * record is the whole point of the phishing group.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const DOMAIN = 'levonis-iq.com';
const dir = mkdtempSync(join(tmpdir(), 'zone-'));

/** Run the audit over a synthetic zone. Returns its stdout and exit code. */
function audit(records: Array<Record<string, unknown>>): { out: string; code: number } {
  const file = join(dir, `${records.length}-${Math.abs(JSON.stringify(records).length)}.json`);
  writeFileSync(file, JSON.stringify({ success: true, result: records }));
  try {
    const out = execFileSync('node', ['scripts/audit-reserved-subdomains.mjs', file], {
      cwd: ROOT,
      env: { ...process.env, DOMAIN },
      encoding: 'utf8',
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

const rec = (name: string, type = 'CNAME', proxied = true) => ({ name: `${name}.${DOMAIN}`, type, proxied });

// ------------------------------------------------------------- the failure

test('a proxied name that is NOT reserved fails the audit', () => {
  // The one that matters. `analytics.levonis-iq.com` proxied through
  // Cloudflare reaches the Worker via `*.levonis-iq.com/*`, and an unreserved
  // label is a merchant slug as far as classifyHost is concerned.
  const { out, code } = audit([rec('studio'), rec('analytics')]);
  assert.equal(code, 1, out);
  assert.match(out, /audit=FAILED/);
  assert.match(out, /FAIL analytics/);
  // And it says what to do, naming the file and the name.
  assert.match(out, /SYSTEM_SUBDOMAINS in worker\/lib\/hosts\.ts/);
  assert.match(out, /^ {2}analytics$/m);
});

test('an unproxied unreserved name is a warning, not a failure', () => {
  // It never reaches the Worker, so it cannot be hijacked — but a merchant
  // could still register the slug and own a name people already associate
  // with something here.
  const { out, code } = audit([rec('legacy', 'A', false)]);
  assert.equal(code, 0, out);
  assert.match(out, /audit=warnings/);
  assert.match(out, /WARN legacy/);
});

// -------------------------------------------------------------- the passes

test('the zone as it stands today passes', () => {
  const { out, code } = audit([
    { name: DOMAIN, type: 'CNAME', proxied: true },
    rec('www'),
    { name: `*.${DOMAIN}`, type: 'CNAME', proxied: true },
    rec('studio'),
    rec('mail', 'CNAME', false),
    rec('send', 'CNAME', false),
  ]);
  assert.equal(code, 0, out);
  assert.match(out, /audit=ok/);
  // The four the owner named explicitly.
  for (const n of ['www', 'studio', 'mail', 'send']) {
    assert.match(out, new RegExp(`ok +${n} .*reserved in code`), n);
  }
});

test('the apex, the wildcard and deeper names are not services to protect', () => {
  const { out, code } = audit([
    { name: DOMAIN, type: 'A', proxied: true },
    { name: `*.${DOMAIN}`, type: 'CNAME', proxied: true },
    { name: `deep.sub.${DOMAIN}`, type: 'A', proxied: true },
    { name: 'unrelated.example.com', type: 'A', proxied: true },
  ]);
  assert.equal(code, 0, out);
  assert.match(out, /one-label names with DNS records under levonis-iq\.com: 0/);
});

test('an underscore name is reported as unclaimable rather than as a risk', () => {
  // `_dmarc` cannot survive Host normalisation and can never be a slug, so it
  // needs no entry in the code list — but silence would look like an
  // oversight, so it is stated.
  const { out, code } = audit([{ name: `_dmarc.${DOMAIN}`, type: 'TXT', proxied: false }]);
  assert.equal(code, 0, out);
  assert.match(out, /_dmarc.*not a usable slug/);
});

test('one name with several record types is one decision, and proxied wins', () => {
  // A + AAAA + TXT on the same label is normal. If any of them is proxied the
  // name reaches the Worker, so the audit must not let an unproxied sibling
  // record hide that.
  const { out, code } = audit([
    { name: `analytics.${DOMAIN}`, type: 'TXT', proxied: false },
    { name: `analytics.${DOMAIN}`, type: 'A', proxied: true },
  ]);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL analytics .*proxied/);
});

// ------------------------------------------------------- degrading safely

test('no record list means "skipped", not a green tick and not a crash', () => {
  // The DNS read step tolerates its own failure, so this file may simply not
  // exist. Reporting that as success would be a lie; crashing would take the
  // rest of the run's report down with it.
  try {
    const out = execFileSync('node', ['scripts/audit-reserved-subdomains.mjs', join(dir, 'nope.json')], {
      cwd: ROOT,
      env: { ...process.env, DOMAIN },
      encoding: 'utf8',
    });
    assert.match(out, /audit=skipped/);
  } catch (err) {
    assert.fail(`the audit crashed instead of skipping: ${String(err)}`);
  }
});

test('a Cloudflare error payload is skipped, not read as an empty zone', () => {
  // `{"success":false,"errors":[…]}` has no `result` array. Treating that as
  // "no subdomains exist" would turn a permission problem into a clean bill
  // of health.
  const file = join(dir, 'err.json');
  writeFileSync(file, JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
  const out = execFileSync('node', ['scripts/audit-reserved-subdomains.mjs', file], {
    cwd: ROOT,
    env: { ...process.env, DOMAIN },
    encoding: 'utf8',
  });
  assert.match(out, /audit=skipped/);
});

// ------------------------------------- the reserved list's own side effect
//
// `scripts/check-live-store-slugs.mjs`. Reserving a name is not free:
// `classifyHost` consults the list BEFORE looking a slug up, so a name that
// becomes reserved stops resolving to its store the moment the deploy lands —
// no error, no log line, just a shop that is gone along with every link and QR
// code pointing at it. The list grew from 44 names to 138 in one commit, which
// is exactly the change that can do that, so the live slugs are read and
// compared BEFORE the code that would refuse them ships.

function slugCheck(payload: string): { out: string; code: number } {
  const file = join(dir, `slugs-${payload.length}-${payload.replace(/\W/g, '').slice(0, 20)}.json`);
  writeFileSync(file, payload);
  try {
    return {
      out: execFileSync('node', ['scripts/check-live-store-slugs.mjs', file], { cwd: ROOT, encoding: 'utf8' }),
      code: 0,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

const d1 = (...slugs: string[]) =>
  JSON.stringify([{ results: slugs.map((slug) => ({ slug })), success: true }]);

test('a live store whose name just became reserved STOPS the deploy', () => {
  const { out, code } = slugCheck(d1('ali3d', 'shop', 'login'));
  assert.equal(code, 1, out);
  assert.match(out, /slugs=FAILED/);
  assert.match(out, /FAIL shop/);
  assert.match(out, /FAIL login/);
  assert.match(out, /ok +ali3d/);
  // And it does not decide for anyone what to do about it.
  assert.match(out, /WITH the merchant's agreement/);
});

test('ordinary live slugs pass', () => {
  const { out, code } = slugCheck(d1('ali3d', 'levoshop', 'baghdad-3d'));
  assert.equal(code, 0, out);
  assert.match(out, /slugs=ok/);
});

test('no stores yet is an answer, not a skip', () => {
  const { out, code } = slugCheck(JSON.stringify([{ results: [], success: true }]));
  assert.equal(code, 0, out);
  assert.match(out, /live store slugs read \(json\): 0/);
  assert.match(out, /slugs=ok/);
});

test("wrangler's banner lines before the JSON do not defeat it", () => {
  // wrangler prints its own header to stdout ahead of --json output.
  const { out, code } = slugCheck(`⛅️ wrangler 4.0.0\n-------------------\n${d1('shop')}`);
  assert.equal(code, 1, out);
  assert.match(out, /read \(json\)/);
  assert.match(out, /FAIL shop/);
});

test('output it cannot read FAILS CLOSED — it stops the deploy, never waves it through (review F9)', () => {
  // An auth failure or a changed output format must not read as "no store
  // collides" — that is precisely the report that would let the deploy
  // through and take a shop offline. It used to print `slugs=skipped` and
  // exit 0, and the deploy carried on without anybody having looked.
  for (const payload of [
    'Authentication error [code: 10000]',
    '',
    'null',
    JSON.stringify({ success: false, errors: [{ code: 7500, message: 'no such table: merchant_store_slugs' }] }),
  ]) {
    const { out, code } = slugCheck(payload);
    assert.equal(code, 1, out);
    assert.match(out, /slugs=unreadable/, JSON.stringify(payload));
    assert.doesNotMatch(out, /slugs=ok/);
  }
  // No file at all — the read step failed before writing one.
  const missing = (() => {
    try {
      return { out: execFileSync('node', ['scripts/check-live-store-slugs.mjs', join(dir, 'never-written.json')], { cwd: ROOT, encoding: 'utf8' }), code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { out: e.stdout ?? '', code: e.status ?? 1 };
    }
  })();
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /slugs=unreadable/);
});

const d1Rows = (...rows: Array<[string, 'live' | 'retired']>) =>
  JSON.stringify([{ results: rows.map(([slug, kind]) => ({ slug, kind })), success: true }]);

test('the OLD name of a renamed store that just became reserved STOPS the deploy (review F9)', () => {
  // The storefront redirects a retired name to the shop's new address — the
  // redirect every QR code printed before the rename relies on — and a
  // reserved word breaks it exactly as it breaks a live store.
  const { out, code } = slugCheck(d1Rows(['ali3d', 'live'], ['products', 'retired'], ['old-ali', 'retired']));
  assert.equal(code, 1, out);
  assert.match(out, /slugs=FAILED/);
  assert.match(out, /FAIL products \(retired name, redirects\)/);
  assert.match(out, /ok +old-ali \(retired name, redirects\)/);
  assert.match(out, /ok +ali3d/);
  assert.match(out, /break the redirect/);
  assert.match(out, /retired store names read \(json\): 2/);
});

test('every storefront path word wave 1 reserved stops a store already trading under it', () => {
  for (const word of ['resolve', 'by-id', 'p', 'products', 'sections', 'services', 'showcase', 'reviews']) {
    const { out, code } = slugCheck(d1Rows([word, 'live']));
    assert.equal(code, 1, `${word}: ${out}`);
    assert.match(out, new RegExp(`FAIL ${word}\\b`));
  }
});

test('the deploy workflows read retired names too, and both run the guard before deploying', () => {
  for (const wf of ['deploy-staging-code.yml', 'deploy-staging.yml']) {
    const yml = readFileSync(join(ROOT, '.github/workflows', wf), 'utf8');
    const guard = yml.indexOf('node scripts/check-live-store-slugs.mjs');
    assert.ok(guard > 0, `${wf} does not run the slug guard`);
    assert.match(yml, /FROM merchant_store_slugs WHERE active = 0/, `${wf} does not read the retired names`);
    const deploy = yml.indexOf('npx wrangler deploy', guard);
    assert.ok(deploy > guard, `${wf}: the guard must run BEFORE the deploy`);
    assert.ok(yml.lastIndexOf('npx wrangler deploy', guard) === -1, `${wf}: a deploy runs before the guard`);
  }
});

test('slugs readable only as text are still checked, not skipped', () => {
  // A future wrangler could wrap the array in an object this script does not
  // know. Reading the names out of the text is worse evidence than a parse —
  // and far better than deploying without the check.
  const { out, code } = slugCheck('{"unexpected":{"rows":[{"slug":"checkout"}]}}');
  assert.equal(code, 1, out);
  assert.match(out, /read \(text\)/);
  assert.match(out, /FAIL checkout/);
});
