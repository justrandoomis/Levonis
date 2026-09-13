import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the production build refuses a silent fake Wrangler executable', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const guard = read('scripts/check-wrangler-cli.mjs');
  assert.match(pkg.scripts.build, /^node scripts\/check-wrangler-cli\.mjs /);
  assert.match(guard, /spawnSync\(binary, \['--version'\]/);
  assert.match(guard, /output\.includes\(packageVersion\)/);
  assert.match(guard, /process\.exit\(1\)/);
});
