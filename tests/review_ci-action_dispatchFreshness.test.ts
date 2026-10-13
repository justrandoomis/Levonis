/** Review (ci-action group, 2026-10-13): reproductions for two holes in the
 * superseded-release check of workflow 7 (scripts/check-deploy-freshness.mjs).
 * Only temporary local repositories; origin is a local bare repository. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain ESM helper executed by the deployment workflow
import { assertFreshDeployment } from '../scripts/check-deploy-freshness.mjs';

const branch = 'claude/new-session-2hq4ci';
type Git = (args: string[]) => string;

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'levonis-review-freshness-'));
  const remote = join(directory, 'origin.git'), checkout = join(directory, 'checkout');
  mkdirSync(checkout);
  const git: Git = (args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: checkout, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    });
    if (result.error || result.status !== 0) throw new Error(`Local fixture Git failed: ${args.join(' ')} ${result.stderr}`);
    return result.stdout;
  };
  const write = (path: string, text: string) => {
    const file = join(checkout, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
  };
  const publish = (message = 'fixture') => {
    git(['add', '--all']); git(['commit', '-m', message]);
    git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  git(['init', '--bare', remote]);
  git(['init', '-b', branch]);
  git(['remote', 'add', 'origin', remote]);
  write('worker/app.ts', 'export const version = 1;\n');
  write('.github/workflows/claude.yml', 'name: v1\n');
  const tested = publish();
  return { git, write, publish, tested, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/* Finding: workflow_dispatch skips the freshness check entirely, and
 * .github/workflows/claude.yml now dispatches workflow 7 automatically
 * (`gh workflow run deploy-staging-code.yml -f confirm=DEPLOY-CODE`). A
 * dispatched run whose deploy job reaches the live lock AFTER a newer push has
 * already deployed (slower verify, re-run of a failed shard) deploys the
 * older code over the newer code, and both runs end green. */
test('a dispatched release that a newer code commit already superseded is refused (dispatch is not exempt)', () => {
  const repo = repository();
  try {
    repo.write('worker/app.ts', 'export const version = 2;\n');
    repo.publish('newer owner push with code');
    repo.git(['checkout', '--detach', repo.tested]);
    assert.throws(
      () => assertFreshDeployment({ event: 'workflow_dispatch', branch, expectedSha: repo.tested, git: repo.git }),
      /superseded/,
      'an automated dispatch of an older commit must not overwrite newer live code',
    );
  } finally { repo.cleanup(); }
});

/* Finding: a newer head commit marked [skip ci] never starts workflow 7, yet
 * any non-prose file in it (the owner pushed eight such commits touching only
 * .github/workflows/claude.yml) makes the in-flight tested release refuse as
 * "superseded". Nothing replaces it, so the tested code never reaches live
 * until some later unrelated push. */
test('a newer [skip ci] head that will never run workflow 7 does not cancel the tested release', () => {
  const repo = repository();
  try {
    repo.write('.github/workflows/claude.yml', 'name: v2\n');
    repo.publish('chore: tweak owner-only Claude workflow [skip ci]');
    repo.git(['checkout', '--detach', repo.tested]);
    assert.doesNotThrow(
      () => assertFreshDeployment({ event: 'push', branch, expectedSha: repo.tested, git: repo.git }),
      'refusing here leaves the tested release undeployed: the [skip ci] head starts no deploy of its own',
    );
  } finally { repo.cleanup(); }
});
