/**
 * Least privilege, read from the CONTRACT rather than from the config
 * (`01-TARGET.md` §1.1 "Visibility", §4 item 5; `02-MIGRATION-PLAN.md` §11).
 *
 * `tests/leastPrivilege.test.ts` already pins the *visibility* keys and holds
 * every `services` binding against `OWNERSHIP.json` `calls`. This file closes
 * the other half of the same rule, and it closes it in BOTH directions:
 *
 *   1. every binding a `services/<name>/wrangler.jsonc` declares — in every
 *      environment, of every kind (D1, R2, KV, services, ratelimits, queues,
 *      Analytics Engine, Durable Objects, Hyperdrive, Workflows, Vectorize,
 *      AI, mTLS, dispatch namespaces, browser rendering) — is named in that
 *      service's `CONTRACT.md`; and
 *   2. every binding `CONTRACT.md` claims exists in the config.
 *
 * WHY BOTH. A binding that is in the config and not in the contract is
 * privilege nobody agreed to: on this account a service binding is
 * account-level trust (`02-MIGRATION-PLAN.md` §13.3 risk 3), so a `LEDGER`
 * binding quietly added to a leaf Worker is a key on the money service's
 * allowlist. A binding that is in the contract and not in the config is the
 * opposite failure and the one that actually happened in Phase 1: a service
 * that documents a dependency it does not hold looks configured and behaves
 * as though the dependency were merely down.
 *
 * The rules are proven against inline configs first, so a green run is a proof
 * of the rules and not of an empty loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc, type WranglerLike } from './lib/wrangler';
import { listServices } from './lib/boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every binding name a wrangler block declares, tagged with its kind and the
 * environment it was found in. The kinds are read from the wrangler config
 * schema (`node_modules/wrangler/config-schema.json`), not guessed: a kind
 * this function does not know is reported as `unknown:<key>` and fails the
 * test, because an unrecognised binding is exactly the one nobody reviewed.
 */
export interface FoundBinding {
  name: string;
  kind: string;
  env: string;
}

const ARRAY_BINDINGS: Record<string, string> = {
  d1_databases: 'd1',
  r2_buckets: 'r2',
  kv_namespaces: 'kv',
  services: 'service',
  analytics_engine_datasets: 'analytics_engine',
  hyperdrive: 'hyperdrive',
  vectorize: 'vectorize',
  mtls_certificates: 'mtls',
  dispatch_namespaces: 'dispatch_namespace',
  send_email: 'send_email',
  pipelines: 'pipeline',
  workflows: 'workflow',
  secrets_store_secrets: 'secrets_store',
  unsafe_hello_world: 'unsafe',
};

/** Keys that carry bindings but are not a flat array of `{binding}`. */
const SPECIAL = ['ratelimits', 'queues', 'durable_objects', 'ai', 'browser', 'images', 'version_metadata', 'assets'];

export function bindingsIn(block: Record<string, unknown>, env: string): FoundBinding[] {
  const out: FoundBinding[] = [];
  const push = (name: unknown, kind: string) => {
    if (typeof name === 'string' && name) out.push({ name, kind, env });
  };
  for (const [key, kind] of Object.entries(ARRAY_BINDINGS)) {
    for (const entry of (block[key] as Array<Record<string, unknown>>) ?? []) push(entry.binding, kind);
  }
  // `ratelimits` entries carry `name`, not `binding`.
  for (const entry of (block.ratelimits as Array<Record<string, unknown>>) ?? []) push(entry.name, 'ratelimit');
  for (const entry of ((block.queues as Record<string, unknown>)?.producers as Array<Record<string, unknown>>) ?? []) push(entry.binding, 'queue_producer');
  for (const entry of ((block.queues as Record<string, unknown>)?.consumers as Array<Record<string, unknown>>) ?? []) push(entry.queue, 'queue_consumer');
  for (const entry of ((block.durable_objects as Record<string, unknown>)?.bindings as Array<Record<string, unknown>>) ?? []) push(entry.name, 'durable_object');
  for (const key of ['ai', 'browser', 'images', 'version_metadata', 'assets']) {
    const b = block[key] as Record<string, unknown> | undefined;
    if (b && typeof b.binding === 'string') push(b.binding, key);
  }
  return out;
}

/** Binding-shaped keys the walker does not understand — an unreviewed privilege. */
export function unknownBindingKeys(block: Record<string, unknown>): string[] {
  const known = new Set([...Object.keys(ARRAY_BINDINGS), ...SPECIAL]);
  return Object.keys(block).filter((k) => /binding|namespace|bucket|database|queue|_certificates$|^ai$|^browser$/.test(k) && !known.has(k));
}

/** Every environment of a config, including the top level, keyed by name. */
export function blocksOf(cfg: WranglerLike): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [['top-level', cfg as unknown as Record<string, unknown>]];
  for (const [name, block] of Object.entries((cfg as { env?: Record<string, Record<string, unknown>> }).env ?? {})) out.push([`env.${name}`, block]);
  return out;
}

/**
 * A binding is "named in the contract" when the document contains the name as
 * a whole word. Deliberately literal: the point is that a human wrote the name
 * down, not that a parser found a table cell, and a contract that renames a
 * binding in prose has stopped describing the Worker either way.
 */
export function namedInContract(contract: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(contract);
}

/**
 * The binding names a CONTRACT.md claims, taken from the ONE table whose header
 * row has a `Binding` column. Deliberately narrow: the same document also
 * carries a `| Var | Meaning |` table, and reading every SHOUTING_SNAKE token
 * in the section would report `GATEWAY_PHASE` — a plain var — as an
 * undeclared binding. A contract that wants a binding checked puts it in the
 * binding table.
 */
export function contractBindings(contract: string): string[] {
  const lines = contract.split('\n');
  const out = new Set<string>();
  let inTable = false;
  for (const line of lines) {
    const cells = line.trim().startsWith('|') ? line.split('|').map((c) => c.trim()) : null;
    if (!cells) {
      inTable = false;
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue; // the --- separator row
    if (cells.some((c) => /^\*{0,2}Bindings?\*{0,2}$/i.test(c))) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const m = /^`?([A-Z][A-Z0-9_]{1,})`?$/.exec(cells[1] ?? '');
    if (m) out.add(m[1]);
  }
  return [...out];
}

// -------------------------------------------------------------- the rules
test('the binding walker finds every kind, in every environment, and refuses one it does not know', () => {
  const cfg = parseJsonc(`{
    "name": "levonis-x",
    "d1_databases": [{ "binding": "DB", "database_name": "x" }],
    "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "b" }],
    "kv_namespaces": [{ "binding": "FLAGS", "id": "1" }],
    "services": [{ "binding": "IDENTITY", "service": "levonis-core-dark", "entrypoint": "IdentityEntrypoint" }],
    "ratelimits": [{ "name": "RL_IP", "namespace_id": "1001" }],
    "queues": { "producers": [{ "binding": "Q_AUDIT", "queue": "q" }], "consumers": [{ "queue": "notify-deliver" }] },
    "durable_objects": { "bindings": [{ "name": "WALLET_LOCK", "class_name": "Lock" }] },
    "analytics_engine_datasets": [{ "binding": "EVENTS_AE", "dataset": "d" }],
    "env": { "dark": { "d1_databases": [{ "binding": "DB", "database_name": "x-dark" }] } }
  }`) as WranglerLike;
  const blocks = blocksOf(cfg);
  assert.deepEqual(blocks.map(([n]) => n), ['top-level', 'env.dark']);
  const top = bindingsIn(blocks[0][1], 'top-level').map((b) => `${b.kind}:${b.name}`).sort();
  assert.deepEqual(top, [
    'analytics_engine:EVENTS_AE', 'd1:DB', 'durable_object:WALLET_LOCK', 'kv:FLAGS',
    'queue_consumer:notify-deliver', 'queue_producer:Q_AUDIT', 'r2:BUCKET', 'ratelimit:RL_IP', 'service:IDENTITY',
  ]);
  assert.deepEqual(bindingsIn(blocks[1][1], 'env.dark'), [{ name: 'DB', kind: 'd1', env: 'env.dark' }]);
  // an unreviewed privilege is a failure, not a shrug
  assert.deepEqual(unknownBindingKeys(parseJsonc('{"some_new_bindings":[{"binding":"X"}]}') as Record<string, unknown>), ['some_new_bindings']);
});

test('the contract reader takes the Bindings table, and the name check is a whole word', () => {
  const md = [
    '# levonis-audit',
    '## Bindings (least privilege)',
    '| Binding | Kind | Why |',
    '|---|---|---|',
    '| `DB` | D1 | its own store |',
    '| `IDENTITY` | service | getPublicKeys only |',
    '## Something else',
    '| `LEDGER` | service | not a binding: another section |',
  ].join('\n');
  assert.deepEqual(contractBindings(md).sort(), ['DB', 'IDENTITY']);
  assert.ok(namedInContract(md, 'IDENTITY'));
  assert.ok(!namedInContract('the IDENTITYX binding', 'IDENTITY'), 'a longer name must not satisfy a shorter one');
  assert.ok(namedInContract('`RL_IP`, `RL_PUBLIC_READ` (per colo)', 'RL_IP'));
});

test('every service has a CONTRACT.md, and it names every binding the config declares — in every environment', () => {
  const services = listServices(ROOT);
  assert.ok(services.length > 0, 'no services found — this suite must not pass over an empty tree');
  const violations: string[] = [];
  for (const svc of services) {
    const dir = join(ROOT, 'services', svc);
    const wranglerPath = join(dir, 'wrangler.jsonc');
    if (!existsSync(wranglerPath)) continue; // probes and any pure package without a Worker
    const contractPath = join(dir, 'CONTRACT.md');
    if (!existsSync(contractPath)) {
      violations.push(`services/${svc}: CONTRACT.md is required — the public methods and the bindings ARE the contract`);
      continue;
    }
    const contract = readFileSync(contractPath, 'utf8');
    const cfg = parseJsonc(readFileSync(wranglerPath, 'utf8')) as WranglerLike;
    const declared = new Set<string>();
    for (const [envName, block] of blocksOf(cfg)) {
      for (const key of unknownBindingKeys(block)) {
        violations.push(`services/${svc} ${envName}: "${key}" looks like a binding this test does not know — add it to ARRAY_BINDINGS/SPECIAL and to the contract`);
      }
      for (const b of bindingsIn(block, envName)) {
        declared.add(b.name);
        if (!namedInContract(contract, b.name)) {
          violations.push(`services/${svc} ${envName}: ${b.kind} binding ${b.name} is not named in CONTRACT.md — privilege nobody agreed to`);
        }
      }
    }
    // the other direction: a contract that claims a binding the Worker does not hold
    for (const claimed of contractBindings(contract)) {
      if (!declared.has(claimed)) {
        violations.push(`services/${svc}: CONTRACT.md's Bindings table claims ${claimed}, which no environment of wrangler.jsonc declares`);
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('no wrangler config in the tree declares a route, and no service Worker is bound to a live one by accident', () => {
  // Routing is a dashboard fact (`docs/WORKERS.md`), and for the gateway that
  // is the entire rollback of the Phase 3 cut-over: deleting six routes only
  // works while they are not committed. `tests/workflowNaming.test.ts` checks
  // every config in the repository; this one adds the service-specific half —
  // a `services` binding may name the live core (that IS the strangler), but
  // only under the binding names the design gives it.
  for (const svc of listServices(ROOT)) {
    const wranglerPath = join(ROOT, 'services', svc, 'wrangler.jsonc');
    if (!existsSync(wranglerPath)) continue;
    const raw = readFileSync(wranglerPath, 'utf8');
    const bare = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/"routes?"\s*:/.test(bare), `services/${svc}/wrangler.jsonc declares routes`);
    assert.ok(!/"custom_domains"\s*:/.test(bare), `services/${svc}/wrangler.jsonc declares custom_domains`);
    const cfg = parseJsonc(raw) as WranglerLike;
    for (const [envName, block] of blocksOf(cfg)) {
      for (const s of ((block.services as Array<{ binding: string; service: string }>) ?? [])) {
        if (s.service !== 'levonis-staging') continue;
        assert.ok(
          ['CORE', 'IDENTITY', 'LEDGER', 'ORDERS', 'CATALOG'].includes(s.binding),
          `services/${svc} ${envName}: binding ${s.binding} points at the LIVE core under a name the design does not use`
        );
      }
    }
  }
});
