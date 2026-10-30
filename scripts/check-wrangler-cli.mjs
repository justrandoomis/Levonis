#!/usr/bin/env node
/**
 * Cloudflare's build settings once replaced node_modules/.bin/wrangler with a
 * two-line `process.exit(0)` stub. Both build and deploy then reported success
 * while uploading nothing. Keep this check inside the repository so that a
 * dashboard-side install command can never manufacture another green deploy.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJsonPath = resolve('node_modules/wrangler/package.json');
const packageVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
const windows = process.platform === 'win32';
const shim = resolve('node_modules/.bin', windows ? 'wrangler.cmd' : 'wrangler');
// Node starts a .cmd only through a shell (CVE-2024-27980); the quotes keep a
// path with a space in it one word. Everywhere else: no shell, as before.
const binary = windows ? `"${shim}"` : shim;
const result = spawnSync(binary, ['--version'], {
  encoding: 'utf8',
  shell: windows,
  timeout: 15_000,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

if (result.status !== 0 || !output.includes(packageVersion)) {
  console.error(
    'check-wrangler-cli: invalid local Wrangler executable. Remove any Cloudflare build command that overwrites node_modules/.bin/wrangler, then reinstall dependencies.'
  );
  process.exit(1);
}

console.log(`check-wrangler-cli: Wrangler ${packageVersion} verified`);
