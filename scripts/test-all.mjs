#!/usr/bin/env node
/**
 * Run BOTH suites and report both, then exit non-zero if either failed.
 *
 * `test:unit` used to be `tsx --test tests/*.test.ts && npm run test:workspaces`.
 * The `&&` meant one red root test hid every workspace suite: the deploy that
 * failed on five bundle-budget assertions never ran a single workspace test,
 * and nothing in the log said so. A gate that stops measuring the moment it
 * finds one fault tells you least exactly when you need it most.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Unit suites must not send real notifications when a test misses a stub.
// Preserve other Node options; the preload still permits local fixture servers.
const offline = fileURLToPath(new URL('../tests/fixtures/offline.cjs', import.meta.url));
const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(offline)}`.trim() };

const runs = [
  { name: 'root', cmd: process.execPath, args: ['--import', 'tsx', '--test', '--test-concurrency=6', 'tests/*.test.ts'], shell: true },
  { name: 'workspaces', cmd: 'node', args: ['scripts/test-workspaces.mjs'], shell: false },
];

const failed = [];
for (const run of runs) {
  const res = spawnSync(run.cmd, run.args, { stdio: 'inherit', shell: run.shell, env });
  if (res.status !== 0) failed.push(`${run.name} (exit ${res.status ?? 'signal ' + res.signal})`);
}

if (failed.length > 0) {
  console.error(`\ntest:unit FAILED — ${failed.join(', ')}. Both suites above ran; read both.`);
  process.exit(1);
}
console.log('\ntest:unit: root and workspace suites both green.');
