/**
 * Least privilege per Worker (`01-TARGET.md` §1.1 "Visibility", §4 item 5,
 * ADR-011, ADR-015). For every `services/<name>/wrangler.jsonc`: `workers_dev`
 * and `preview_urls` are declared in every environment and false in
 * production (dark non-gateway Workers may enable workers.dev); no
 * routes/custom_domains in the repo; no new Worker name contains "staging";
 * every `services` binding is declared in OWNERSHIP.json `calls`; every secret
 * in SECRETS.md is declared in `secrets`; and the gateway's `calls` are pinned
 * to its read-only session/limiter set — never Admin, set, credit, debit,
 * decide or lookupContacts.
 *
 * Rules are proven against inline configs first; then applied to the tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc, checkVisibility, checkBindingsAgainstManifest, checkSecrets, checkGatewayCalls, secretNamesIn, type WranglerLike } from './lib/wrangler';
import { listServices, readManifest } from './lib/boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('jsonc parsing: comments and trailing commas', () => {
  const cfg = parseJsonc(`{
    // a comment
    "name": "levonis-audit", /* block */
    "workers_dev": false,
    "vars": { "A": "http://x//y", },
  }`);
  assert.deepEqual(cfg, { name: 'levonis-audit', workers_dev: false, vars: { A: 'http://x//y' } });
});

test('visibility: both keys in every environment, false in production, dark may enable workers.dev, routes never, no -staging', () => {
  const good: WranglerLike = { name: 'levonis-audit', workers_dev: false, preview_urls: false, env: { dark: { name: 'levonis-audit-dark', workers_dev: true, preview_urls: false } } };
  assert.deepEqual(checkVisibility(good, { isGateway: false, label: 'audit' }), []);
  const bad: WranglerLike = { name: 'levonis-audit-staging', workers_dev: true, preview_urls: true, routes: [{ pattern: 'x' }], env: { dark: { name: 'd' } } };
  const v = checkVisibility(bad, { isGateway: false, label: 'audit' });
  assert.ok(v.some((x) => /top-level: workers_dev must be false/.test(x)));
  assert.ok(v.some((x) => /top-level: preview_urls must be false/.test(x)));
  assert.ok(v.some((x) => /routes\/custom_domains/.test(x)));
  assert.ok(v.some((x) => /env.dark: workers_dev must be declared/.test(x)));
  assert.ok(v.some((x) => /env.dark: preview_urls must be declared/.test(x)));
  assert.ok(v.some((x) => /never contain "staging"/.test(x)));
  // the dark gateway serves the dark zone: workers.dev stays off for it too
  const gw: WranglerLike = { name: 'levonis-gateway', workers_dev: false, preview_urls: false, env: { dark: { name: 'levonis-gateway-dark', workers_dev: true, preview_urls: false } } };
  assert.equal(checkVisibility(gw, { isGateway: true, label: 'gateway' }).length, 1);
});

test('bindings, secrets and the gateway call pin', () => {
  const cfg: WranglerLike = { services: [{ binding: 'IDENTITY', service: 'levonis-core-dark', entrypoint: 'IdentityEntrypoint' }, { binding: 'LEDGER', service: 'x' }] };
  const manifest = { owns: [], reads: [], calls: ['IDENTITY.rateLimitHit', 'AUDIT.deliver'], secrets: ['AUDIT_CHAIN_KEY'] };
  assert.deepEqual(checkBindingsAgainstManifest(cfg, manifest, 'svc'), ['svc top-level: services binding LEDGER is not declared in OWNERSHIP.json calls']);
  assert.deepEqual(secretNamesIn('# Secrets\n\n- `AUDIT_CHAIN_KEY` — the HMAC key\n- HEALTH_PROBE_TOKEN: probes\n| EMAIL_API_KEY | Resend |\nNot a secret line.\n'), ['AUDIT_CHAIN_KEY', 'HEALTH_PROBE_TOKEN', 'EMAIL_API_KEY']);
  assert.deepEqual(checkSecrets(['AUDIT_CHAIN_KEY', 'HEALTH_PROBE_TOKEN'], manifest, 'svc'), ['svc: SECRETS.md names HEALTH_PROBE_TOKEN but OWNERSHIP.json secrets does not declare it']);
  const gwOk = { owns: [], reads: [], calls: ['IDENTITY.resolveSession', 'IDENTITY.revoke', 'IDENTITY.getPublicKeys', 'IDENTITY.rateLimitHit', 'CORE.forward', 'AUDIT.health', '*.deliver'] };
  assert.deepEqual(checkGatewayCalls(gwOk, 'gateway'), []);
  const gwBad = { owns: [], reads: [], calls: ['IDENTITY.setRole', 'LEDGER.credit', 'IDENTITY.lookupContacts', 'ADMIN.overviewAdmin', 'LEDGER.decideDeposit', 'CATALOG.getProductsForCart'] };
  const v = checkGatewayCalls(gwBad, 'gateway');
  for (const call of gwBad.calls) assert.ok(v.some((x) => x.includes(call)), `${call} is refused`);
});

test('every services/*/wrangler.jsonc in the tree passes; OWNERSHIP.json and SECRETS.md agree with it', () => {
  for (const svc of listServices(ROOT)) {
    const dir = join(ROOT, 'services', svc);
    const wranglerPath = join(dir, 'wrangler.jsonc');
    if (!existsSync(wranglerPath)) continue; // probes and pure packages without a Worker
    const cfg = parseJsonc(readFileSync(wranglerPath, 'utf8')) as WranglerLike;
    const manifest = readManifest(dir);
    assert.ok(manifest, `services/${svc}: OWNERSHIP.json missing`);
    const isGateway = svc === 'gateway';
    const violations = [
      ...checkVisibility(cfg, { isGateway, label: `services/${svc}/wrangler.jsonc` }),
      ...checkBindingsAgainstManifest(cfg, manifest!, `services/${svc}`),
    ];
    const secretsMd = join(dir, 'SECRETS.md');
    if (existsSync(secretsMd)) violations.push(...checkSecrets(secretNamesIn(readFileSync(secretsMd, 'utf8')), manifest!, `services/${svc}`));
    else violations.push(`services/${svc}: SECRETS.md (names only) is required`);
    if (isGateway) violations.push(...checkGatewayCalls(manifest!, 'services/gateway'));
    assert.deepEqual(violations, [], violations.join('\n'));
  }
});
