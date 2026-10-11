/** All tests remain release requirements when their execution is parallel.
 * These assertions read the actual workflows, rather than a second manifest
 * of tests. Test-file partition coverage belongs to the suite runner tests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
const active = (source: string) => source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** Workflow job keys have exactly two spaces; nested step/matrix keys do not. */
function jobs(source: string): Map<string, string> {
  const body = active(source).split(/^jobs:\s*$/m)[1];
  assert.ok(body, 'workflow must declare jobs');
  const starts = [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_-]*):[ \t]*$/gm)];
  assert.ok(starts.length, 'workflow must contain a job');
  const result = new Map<string, string>();
  starts.forEach((match, index) => {
    assert.ok(!result.has(match[1]), `duplicate job ${match[1]}`);
    result.set(match[1], body.slice(match.index! + match[0].length, starts[index + 1]?.index));
  });
  return result;
}

/** Accept inline or literal-block run steps, preserving actual shell commands. */
function commands(job: string): string[] {
  const lines = job.split('\n'), result: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const found = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[index]);
    if (!found) continue;
    if (!/^\|[+-]?$/.test(found[2])) {
      result.push(found[2].trim());
      continue;
    }
    const indent = found[1].length;
    while (index + 1 < lines.length) {
      const line = lines[index + 1];
      if (line.trim() && /^\s*/.exec(line)![0].length <= indent) break;
      index++;
      if (line.trim() && !/^\s*#/.test(line)) result.push(line.trim());
    }
  }
  return result;
}

const reusable = './.github/workflows/verify-all.yml';
const branchGuard = "${{ github.event_name == 'workflow_dispatch' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}";

test('reusable verification runs all four required groups, with eight complete root shards', () => {
  const source = active(read('verify-all.yml'));
  assert.match(source, /^on:\s*\n {2}workflow_call:\s*(?:\{\})?\s*$/m);
  const all = jobs(source);
  assert.deepEqual([...all.keys()].sort(), ['checks', 'root_tests', 'studio_tests', 'workspace_tests']);
  for (const [name, job] of all) {
    assert.match(job, /^ {4}runs-on: ubuntu-latest$/m, name);
    assert.match(job, /uses: actions\/checkout@v4\b/, name);
    assert.match(job, /uses: actions\/setup-node@v4\b/, name);
    assert.match(job, /^\s+node-version: ['"]?22['"]?$/m, name);
    assert.doesNotMatch(job, /^\s*(?:if:|continue-on-error:)/m, `${name} must run and its failures must fail verification`);
  }
  const root = all.get('root_tests')!;
  assert.match(root, /^\s+fail-fast: false$/m, 'one failed shard must not cancel the other seven');
  assert.match(root, /^\s+max-parallel: 8$/m);
  const shard = /^\s+shard: \[([^\]]+)\]$/m.exec(root);
  assert.ok(shard, 'root matrix must enumerate its shards');
  assert.deepEqual(shard[1].split(',').map((part) => Number(part.trim())), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotMatch(root, /^\s+(?:exclude|include):/m, 'matrix edits cannot omit or duplicate a shard');
  const shardCommands = commands(root).filter((line) => line.includes('scripts/test-all.mjs'));
  assert.deepEqual(shardCommands, ["node scripts/test-all.mjs --suite root --shard '${{ matrix.shard }}/8'"]);
  assert.ok(commands(all.get('checks')!).includes('npm run check'), 'the complete type/lint/boundary gate remains');
  for (const [job, suite] of [['workspace_tests', 'workspaces'], ['studio_tests', 'studio']] as const) {
    assert.deepEqual(commands(all.get(job)!).filter((line) => line.includes('scripts/test-all.mjs')), [`node scripts/test-all.mjs --suite ${suite}`]);
  }
});

test('verification is read-only and has no Cloudflare credentials or live deployment commands', () => {
  const source = active(read('verify-all.yml'));
  assert.match(source, /^permissions:\s*\n {2}contents: read\s*$/m);
  assert.doesNotMatch(source, /\bsecrets\s*:|secrets\.|CLOUDFLARE_|staging-deploy|apply-remote-migrations|wrangler\s+(?:deploy|secret|d1)/);
  assert.doesNotMatch(source, /^\s*(?:environment:|continue-on-error:)/m);
  assert.doesNotMatch(source, /^\s+[a-z_-]+: write\s*$/m, 'no job broadens token permissions');
});

test('both CI entry points use the complete verification workflow without inheriting deployment secrets', () => {
  for (const filename of ['ci-push.yml', 'deploy-staging-code.yml']) {
    const callers = [...jobs(read(filename)).entries()].filter(([, body]) => body.includes(`uses: ${reusable}`));
    assert.equal(callers.length, 1, `${filename} must use the shared gate exactly once`);
    const [, call] = callers[0];
    assert.doesNotMatch(call, /^\s*(?:secrets:|continue-on-error:)/m, filename);
    assert.doesNotMatch(call, /secrets\.|always\(|failure\(|cancelled\(/, filename);
    if (filename === 'deploy-staging-code.yml') {
      assert.equal(callers[0][0], 'verify');
      assert.ok(call.split('\n').some((line) => line.trim() === `if: ${branchGuard}`), 'verification uses the same default-branch/manual guard as deployment');
    } else {
      assert.doesNotMatch(call, /^\s*if:/m, 'a PR or feature push cannot skip its verification job');
      assert.equal(jobs(read(filename)).size, 1, 'CI uses the same four-group gate rather than a separate partial run');
    }
  }
});

test('live deployment requires successful verification and alone holds the live deployment lock', () => {
  const source = active(read('deploy-staging-code.yml'));
  const all = jobs(source), deploy = all.get('deploy');
  assert.ok(deploy, 'the live deployment job exists');
  assert.match(deploy, /^ {4}needs: (?:verify|\[verify\])$/m);
  assert.ok(deploy.split('\n').some((line) => line.trim() === `if: ${branchGuard}`),
    'the default success() dependency gate must not be bypassed');
  assert.doesNotMatch(deploy, /^ {4}continue-on-error:/m);
  assert.match(deploy, /^ {4}concurrency: staging-deploy$/m);
  assert.doesNotMatch(source.split(/^jobs:\s*$/m)[0], /^concurrency:/m, 'verification cannot occupy the live deploy lock');
  for (const [name, job] of all) {
    if (name !== 'deploy') assert.doesNotMatch(job, /staging-deploy/, `${name} must not take the live lock`);
  }
});

test('the live lock checks deployment freshness after checkout and before any Cloudflare action', () => {
  const deploy = jobs(read('deploy-staging-code.yml')).get('deploy')!;
  const checkout = deploy.indexOf('uses: actions/checkout@v4');
  const freshness = deploy.indexOf('run: node scripts/check-deploy-freshness.mjs');
  const liveRead = deploy.indexOf('- name: Read the running Worker');
  assert.ok(checkout >= 0 && freshness > checkout && liveRead > freshness,
    'superseded commits must be refused inside the lock, before live settings, migrations or deployment');
  assert.match(deploy.slice(checkout, freshness), /^\s+fetch-depth: 0$/m);
  assert.match(deploy.slice(checkout, freshness), /^\s+DEPLOY_EVENT: \$\{\{ github\.event_name \}\}$/m);
  assert.match(deploy.slice(checkout, freshness), /^\s+DEPLOY_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}$/m);
  const beforeFreshness = deploy.slice(0, freshness);
  assert.doesNotMatch(beforeFreshness, /api\.cloudflare\.com|wrangler\s+(?:deploy|secret|d1)|apply-remote-migrations/);
  const step = beforeFreshness.slice(beforeFreshness.lastIndexOf('      - name:'));
  assert.doesNotMatch(step, /^\s*(?:if:|continue-on-error:)/m, 'the freshness refusal is mandatory');
});
