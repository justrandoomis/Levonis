#!/usr/bin/env node
/**
 * Resolve the facts `_deploy-worker.yml` needs about one (service, env) pair,
 * from the wrangler config itself rather than from a string built in YAML.
 *
 * WHY THIS EXISTS. The Worker names on this account are inverted
 * (`levonis-staging` IS the live main site — `docs/WORKERS.md`), and every
 * round that guessed a name from a pattern lost time to it: a `wrangler tail`
 * that attached to nothing, a "production" workflow that ships to a Worker no
 * domain points at. A reusable workflow parameterised by directory and
 * environment must therefore never compute `levonis-<service>-<env>`; it asks
 * this script, which reads `"name"` out of the block wrangler itself would use.
 *
 *   node scripts/worker-name.mjs audit dark          -> levonis-audit-dark
 *   node scripts/worker-name.mjs core dark           -> levonis-core-dark
 *   node scripts/worker-name.mjs audit dark --json   -> { name, config, env, d1, r2, migrations, services, crons }
 *   node scripts/worker-name.mjs audit dark --config -> services/audit/wrangler.jsonc
 *   node scripts/worker-name.mjs audit dark --db     -> levonis-audit-db-dark
 *
 * `core` is the legacy monolith at the repository root; every other name is a
 * directory under `services/`.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envBlock, readJsonc } from './lib/jsonc.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The wrangler config a service deploys from. `core` is the root monolith. */
export function configPath(service) {
  const p = service === 'core' ? join(ROOT, 'wrangler.jsonc') : join(ROOT, 'services', service, 'wrangler.jsonc');
  if (!existsSync(p)) {
    throw new Error(
      `worker-name: no wrangler config for service "${service}" (looked at ${relative(ROOT, p)}).\n` +
        '  Services live in services/<name>/; the legacy core is "core".'
    );
  }
  return p;
}

/**
 * Everything the deploy needs, read from the block wrangler would use.
 *
 * A named environment does NOT inherit most top-level keys, so a missing key
 * here means the config really is missing it — which is a deploy that would
 * bind nothing, not a default worth inventing.
 */
export function describe(service, env) {
  const config = configPath(service);
  const cfg = readJsonc(config);
  const block = envBlock(cfg, env);
  const name = block.name ?? (env && env !== 'production' ? `${cfg.name}-${env}` : cfg.name);
  if (!name) throw new Error(`worker-name: the ${env || 'top-level'} block of ${relative(ROOT, config)} has no "name"`);
  const d1 = (block.d1_databases ?? []).map((d) => ({
    binding: d.binding,
    database_name: d.database_name,
    database_id: d.database_id ?? null,
    migrations_dir: d.migrations_dir ?? null,
  }));
  return {
    service,
    env: env || 'production',
    name,
    config: relative(ROOT, config),
    d1,
    r2: (block.r2_buckets ?? []).map((b) => b.bucket_name),
    migrations: d1.find((d) => d.migrations_dir)?.migrations_dir ?? null,
    services: (block.services ?? []).map((s) => ({ binding: s.binding, service: s.service, entrypoint: s.entrypoint ?? null })),
    crons: block.triggers?.crons ?? [],
    workers_dev: block.workers_dev ?? null,
    // `--env dark` is only meaningful when the config declares that block.
    envs: Object.keys(cfg.env ?? {}),
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [service, env = 'production'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!service) {
    console.error('usage: node scripts/worker-name.mjs <service> <env> [--json|--config|--db|--migrations]');
    process.exit(2);
  }
  let info;
  try {
    info = describe(service, env === 'production' ? '' : env);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(info, null, 2));
  else if (process.argv.includes('--config')) console.log(info.config);
  else if (process.argv.includes('--db')) console.log(info.d1[0]?.database_name ?? '');
  else if (process.argv.includes('--migrations')) console.log(info.migrations ?? '');
  else console.log(info.name);
}
