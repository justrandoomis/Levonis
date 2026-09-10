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

const runs = [
  { name: 'root', cmd: 'npx', args: ['tsx', '--test', 'tests/*.test.ts'], shell: true },
  { name: 'workspaces', cmd: 'node', args: ['scripts/test-workspaces.mjs'], shell: false },
];

const failed = [];
for (const run of runs) {
  const res = spawnSync(run.cmd, run.args, { stdio: 'inherit', shell: run.shell });
  if (res.status !== 0) failed.push(`${run.name} (exit ${res.status ?? 'signal ' + res.signal})`);
}

if (failed.length > 0) {
  console.error(`\ntest:unit FAILED — ${failed.join(', ')}. Both suites above ran; read both.`);
  process.exit(1);
}
console.log('\ntest:unit: root and workspace suites both green.');
