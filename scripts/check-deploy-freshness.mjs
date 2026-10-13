#!/usr/bin/env node
/** Refuse a superseded release before any Cloudflare action.
 *
 * Workflow 7 runs this twice: once in its `fresh` job, BEFORE the deploy job
 * queues for the `staging-deploy` lock, and again inside the lock. Verification
 * (eight shards and more) runs outside the lock and finishes out of order, so
 * deploy jobs no longer reach the lock in push order. The first check keeps a
 * superseded release from queueing at all, where it would cancel the newer
 * release's pending deploy (GitHub keeps one pending job per group and a newly
 * queued one cancels it). The second check covers what changed while waiting.
 *
 * A release may deploy only while what it deploys still matches the default
 * branch. That holds for a push AND for a manual or automatic dispatch of the
 * default branch (`.github/workflows/claude.yml` dispatches one after every
 * `@claude apply`): a re-run of an older run keeps its old commit, and must not
 * put older code back over a newer release. A dispatch of another branch or tag
 * stays the owner's deliberate manual path (for example a rollback).
 *
 * Files that cannot change what a release builds, migrates or deploys do not
 * supersede it: prose (matching workflow 7's paths-ignore) and the workflow
 * definitions under `.github/` (each run executes its own commit's workflow
 * file). So a newer `[skip ci]` commit that only edits a workflow, which starts
 * no deploy of its own, no longer strands the tested release.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Paths whose change leaves the deployed Worker, assets and migrations identical. */
export function isNonDeployablePath(path) {
  return path.startsWith('docs/') || path.endsWith('.md') || path.startsWith('.github/');
}

export function assertFreshDeployment({ event, branch, ref, expectedSha, git }) {
  if (event !== 'push' && event !== 'workflow_dispatch') throw new Error('Missing push deployment context.');
  if (!branch || !expectedSha) throw new Error('Missing push deployment context.');
  // A missing ref is treated as the default branch: the stricter check.
  if (event === 'workflow_dispatch' && ref && ref !== `refs/heads/${branch}`) {
    return 'Explicitly confirmed manual deployment of a ref other than the default branch.';
  }
  git(['check-ref-format', '--branch', branch]);
  const checked = git(['rev-parse', 'HEAD']).trim();
  if (checked !== expectedSha) throw new Error('Checkout does not match the tested commit.');
  git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
  const latest = git(['rev-parse', 'FETCH_HEAD']).trim();
  git(['merge-base', '--is-ancestor', checked, latest]);
  // Both ends of a rename matter: moving code into docs still removes code.
  const changed = git(['diff', '--no-renames', '--name-only', '-z', checked, latest]).split('\0').filter(Boolean);
  if (changed.some((path) => !isNonDeployablePath(path))) {
    throw new Error('A newer commit on the default branch changed deployable files. This superseded release must not touch the live site. '
      + 'The newest commit deploys through its own run; if it was pushed with [skip ci], start workflow 7 on the default branch.');
  }
  return 'The tested deployment still matches the default branch (prose-only and workflow-only updates allowed).';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = assertFreshDeployment({
      event: process.env.DEPLOY_EVENT,
      branch: process.env.DEPLOY_DEFAULT_BRANCH,
      ref: process.env.DEPLOY_REF,
      expectedSha: process.env.GITHUB_SHA,
      git(args) {
        const result = spawnSync('git', args, { encoding: 'utf8' });
        if (result.error || result.status !== 0) throw new Error('Could not verify the latest default branch; refusing live deployment.');
        return result.stdout;
      },
    });
    console.log(result);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
