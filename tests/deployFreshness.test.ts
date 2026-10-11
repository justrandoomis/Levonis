import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain ESM helper executed by the deployment workflow
import { assertFreshDeployment } from '../scripts/check-deploy-freshness.mjs';

const branch = 'claude/release-freshness-test';
type Git = (args: string[]) => string;

/** Only temporary repositories are used. origin is a local bare repository,
 * so fetch/push exercise real Git without any network or production state. */
function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'levonis-freshness-'));
  const remote = join(directory, 'origin.git'), checkout = join(directory, 'checkout');
  mkdirSync(checkout);
  const git: Git = (args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'diff.renames=true', ...args], {
      cwd: checkout, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    });
    if (result.error || result.status !== 0) throw new Error(`Local fixture Git failed: ${args[0]}`);
    return result.stdout;
  };
  const write = (path: string, text: string) => {
    const file = join(checkout, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
  };
  const publish = () => {
    git(['add', '--all']); git(['commit', '-m', 'fixture']);
    git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  git(['init', '--bare', remote]);
  git(['init', '-b', branch]);
  git(['remote', 'add', 'origin', remote]);
  write('worker/app.ts', 'export const version = 1;\n');
  write('README.md', 'Initial instructions.\n');
  const tested = publish();
  return { directory, remote, git, write, publish, tested,
    assertFresh: () => assertFreshDeployment({ event: 'push', branch, expectedSha: tested, git }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('the tested current commit and later prose-only commits may deploy', () => {
  const repo = repository();
  try {
    assert.match(repo.assertFresh(), /matches/);
    repo.write('README.md', 'Updated instructions.\n');
    repo.write('docs/operations.txt', 'Documentation under the ignored directory.\n');
    repo.write('notes/release.md', 'Nested markdown is ignored too.\n');
    repo.publish();
    repo.git(['checkout', '--detach', repo.tested]);
    assert.match(repo.assertFresh(), /prose-only/);
  } finally { repo.cleanup(); }
});

test('a newer code commit blocks the older tested checkout', () => {
  const repo = repository();
  try {
    repo.write('worker/app.ts', 'export const version = 2;\n'); repo.publish();
    repo.git(['checkout', '--detach', repo.tested]);
    assert.throws(repo.assertFresh, /superseded release/);
  } finally { repo.cleanup(); }
});

test('renaming code into the ignored docs directory is still a deployable change', () => {
  const repo = repository();
  try {
    repo.write('docs/placeholder.md', 'docs\n');
    repo.git(['mv', 'worker/app.ts', 'docs/former-code.md']); repo.publish();
    repo.git(['checkout', '--detach', repo.tested]);
    assert.throws(repo.assertFresh, /superseded release/);
  } finally { repo.cleanup(); }
});

test('NUL-delimited paths cannot disguise a deployable filename as multiple ignored files', () => {
  const repo = repository();
  try {
    repo.write('docs-like\nREADME.md\nworker.ts', 'not documentation\n'); repo.publish();
    repo.git(['checkout', '--detach', repo.tested]);
    assert.throws(repo.assertFresh, /superseded release/);
  } finally { repo.cleanup(); }
});

test('a checkout different from the tested SHA is refused before fetching', () => {
  const calls: string[][] = [];
  const git: Git = (args) => { calls.push(args); return args[0] === 'rev-parse' ? 'another-checkout\n' : ''; };
  assert.throws(() => assertFreshDeployment({ event: 'push', branch, expectedSha: 'tested', git }), /does not match the tested commit/);
  assert.equal(calls.some((args) => args[0] === 'fetch'), false);
});

test('fetch failure and a non-descendant default branch both fail closed', () => {
  for (const failedCommand of ['fetch', 'merge-base']) {
    const calls: string[][] = [];
    const git: Git = (args) => {
      calls.push(args);
      if (args[0] === failedCommand) throw new Error(`Refused ${failedCommand}`);
      return args[0] === 'rev-parse' ? 'tested\n' : '';
    };
    assert.throws(() => assertFreshDeployment({ event: 'push', branch, expectedSha: 'tested', git }), new RegExp(`Refused ${failedCommand}`));
    assert.equal(calls.some((args) => args[0] === 'diff'), false, 'failed ancestry/fetch cannot be replaced by a permissive diff');
  }
});

test('missing push context is refused and explicitly confirmed manual deployment retains its deliberate path', () => {
  const git: Git = () => { assert.fail('invalid context or manual deployment must not contact Git'); };
  for (const context of [{ event: 'pull_request', branch }, { event: 'push', branch: '' }]) {
    assert.throws(() => assertFreshDeployment({ ...context, expectedSha: 'tested', git }), /Missing push deployment context/);
  }
  assert.throws(() => assertFreshDeployment({ event: 'push', branch, expectedSha: '', git }), /Missing push deployment context/);
  assert.match(assertFreshDeployment({ event: 'workflow_dispatch', branch, expectedSha: 'tested', git }), /Explicitly confirmed manual/);
});
