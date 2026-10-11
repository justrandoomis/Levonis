#!/usr/bin/env node
/** Check after acquiring the live deploy lock, before any Cloudflare action.
 * Parallel checks may finish out of order. A push may deploy only while its
 * deployable files still match the default branch. Prose-only commits do not
 * supersede a release, matching workflow 7's paths-ignore policy.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function assertFreshDeployment({ event, branch, expectedSha, git }) {
  if (event === 'workflow_dispatch') return 'Explicitly confirmed manual deployment.';
  if (event !== 'push' || !branch || !expectedSha) throw new Error('Missing push deployment context.');
  git(['check-ref-format', '--branch', branch]);
  const checked = git(['rev-parse', 'HEAD']).trim();
  if (checked !== expectedSha) throw new Error('Checkout does not match the tested commit.');
  git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
  const latest = git(['rev-parse', 'FETCH_HEAD']).trim();
  git(['merge-base', '--is-ancestor', checked, latest]);
  // Both ends of a rename matter: moving code into docs still removes code.
  const changed = git(['diff', '--no-renames', '--name-only', '-z', checked, latest]).split('\0').filter(Boolean);
  if (changed.some((path) => !path.startsWith('docs/') && !path.endsWith('.md'))) {
    throw new Error('A newer push changed deployable files. This superseded release must not touch the live site.');
  }
  return 'The tested deployment still matches the default branch (prose-only updates allowed).';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = assertFreshDeployment({
      event: process.env.DEPLOY_EVENT,
      branch: process.env.DEPLOY_DEFAULT_BRANCH,
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
