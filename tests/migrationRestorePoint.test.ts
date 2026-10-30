import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflows = ['auto-migrate-on-push.yml', 'deploy-staging-code.yml'] as const;
const readWorkflow = (file: string) =>
  readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
const bookmark = '00000001-00000002-00000003-0123456789abcdef0123456789abcdef';

// The workflow step is bash. Windows has none on PATH unless Git Bash is put
// there, and bash would read a backslash path as escapes, so Windows paths are
// handed to it with forward slashes. On Linux both are unchanged.
const shellPath = (path: string) => (process.platform === 'win32' ? path.replaceAll('\\', '/') : path);
const bashSkip = process.platform === 'win32'
  && spawnSync('bash', ['-c', 'test -d "$1"', 'bash', shellPath(tmpdir())]).status !== 0
  && 'needs bash (with access to this machine\'s temp directory) on PATH, not on this Windows machine';

/** Execute the actual workflow shell with a local npx stub. No Cloudflare
 * command runs: only grep, tee and the guards under test touch temporary files. */
function bookmarkStep(workflow: string): string {
  const at = workflow.indexOf('      - name: Record a Time Travel bookmark (restore point)');
  assert.ok(at >= 0, 'the live migration path must record a restore point');
  const step = workflow.slice(at).split(/\n {6}- (?:name:|uses:)/, 1)[0];
  const body = step.split('        run: |\n')[1];
  assert.ok(body, 'the bookmark step must have an executable shell block');
  return body.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
}

for (const file of workflows) {
  for (const scenario of [
    { name: 'valid bookmark', output: `Restore point: ${bookmark}`, status: 0, success: true },
    { name: 'successful command without a bookmark', output: 'Database information unavailable', status: 0, success: false },
    { name: 'failed command hidden by tee', output: 'Authentication failed', status: 43, success: false },
    { name: 'failed command that printed a bookmark first', output: bookmark, status: 43, success: false },
  ]) {
    test(`${file}: ${scenario.name} ${scenario.success ? 'permits' : 'blocks'} migration`, { skip: bashSkip }, () => {
      const dir = mkdtempSync(join(tmpdir(), 'levonis-restore-test-'));
      try {
        const outputFile = join(dir, 'github-output');
        const script = bookmarkStep(readWorkflow(file)).replaceAll('/tmp/tt.txt', shellPath(join(dir, 'tt.txt')));
        const result = spawnSync('bash', ['-c', `
npx() {
  [ "$*" = 'wrangler d1 time-travel info levonis-db-staging' ] || return 99
  printf '%s\n' "$BOOKMARK_STUB_OUTPUT"
  return "$BOOKMARK_STUB_STATUS"
}
${script}
printf 'reached-migrations\n' >> "$GITHUB_OUTPUT"
`], {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputFile,
            GITHUB_STEP_SUMMARY: join(dir, 'github-summary'),
            BOOKMARK_STUB_OUTPUT: scenario.output,
            BOOKMARK_STUB_STATUS: String(scenario.status),
          },
        });
        assert.equal(result.error, undefined);
        const saved = (() => {
          try { return readFileSync(outputFile, 'utf8'); } catch { return ''; }
        })();
        if (scenario.success) {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(saved, `bookmark=${bookmark}\nreached-migrations\n`);
        } else {
          assert.notEqual(result.status, 0, 'a failed restore-point read must stop the shell');
          assert.equal(saved, '', 'neither a pretend bookmark nor the migration continuation may be written');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test(`${file}: the restore point precedes live migrations`, () => {
    const workflow = readWorkflow(file);
    const bookmarkAt = workflow.indexOf('      - name: Record a Time Travel bookmark (restore point)');
    const migrateAt = workflow.indexOf('node scripts/apply-remote-migrations.mjs');
    assert.ok(bookmarkAt >= 0 && migrateAt > bookmarkAt);
  });
}

test('the push path to the live database is workflow 7 alone: tests, then migrations, then deploy (DECISIONS row 184)', () => {
  const deploy = readWorkflow('deploy-staging-code.yml');
  assert.match(deploy, /push:\s*(?:#[^\n]*\n\s*)*branches: \['\*\*'\]/);
  const liveJob = deploy.split(/^ {2}deploy:\s*$/m)[1];
  assert.ok(liveJob, 'workflow 7 retains its live deploy job');
  assert.match(liveJob, /^ {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) \}\}$/m);
  // Review 2026-10-13 (CI-5): also the lock-free freshness refusal, which itself needs verify.
  assert.match(liveJob, /^ {4}needs: \[verify, fresh\]$/m,
    'the live job cannot start until the complete reusable verification workflow succeeds');
  assert.match(deploy, /^ {2}fresh:\s*\n[\s\S]*?^ {4}needs: verify$/m, 'the freshness refusal itself waits for verification');
  assert.match(deploy, /^ {2}verify:\s*\n[\s\S]*?^ {4}uses: \.\/\.github\/workflows\/verify-all\.yml$/m);
  assert.doesNotMatch(liveJob, /^ {4}(?:continue-on-error:|if:.*(?:always\(|!cancelled\(|failure\(|cancelled\())/m,
    'a failed or cancelled verification cannot be bypassed by the live job');
  assert.match(deploy, /^ {4}concurrency: staging-deploy$/m);
  assert.ok(!/^concurrency:/m.test(deploy), 'a skipped feature-branch job must not enter the workflow-level live deploy lock');
  assert.ok(!/^\s+pull_request:/m.test(deploy), 'pull requests must not deploy or migrate');
  // Tests now finish through the required reusable job above. Keep every
  // subsequent live safeguard in its original order inside the deploy job.
  const at = (needle: string) => {
    const i = deploy.indexOf(needle);
    assert.ok(i >= 0, `workflow 7 lost: ${needle}`);
    return i;
  };
  const order = [
    'node scripts/migrate-check.mjs --twice',
    '- name: Record a Time Travel bookmark (restore point)',
    'node scripts/apply-remote-migrations.mjs',
    'npx wrangler deploy --env staging',
  ].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'required verification → proof → restore point → migrations → deploy');
});

test('workflow 51 no longer runs on push — two jobs in the same lock from one push could cancel each other', () => {
  const workflow = readWorkflow('auto-migrate-on-push.yml');
  assert.ok(!/^\s+push:/m.test(workflow), 'workflow 51 must not be triggered by a push any more');
  assert.match(workflow, /^\s+workflow_dispatch:/m, 'it stays as the manual hand crank');
  assert.match(workflow, /^ {4}concurrency: staging-deploy$/m);
  assert.ok(!/^\s+pull_request:/m.test(workflow), 'pull requests must not trigger live migration');
});

test('the Workers Builds path refuses its own build, so its deploy command never runs', () => {
  const src = readFileSync(new URL('../scripts/prepare-deploy-config.mjs', import.meta.url), 'utf8');
  const detect = src.indexOf('if (!inWorkersBuilds) process.exit(0);');
  const refuse = src.indexOf("if (process.env.LEVONIS_ALLOW_WORKERS_BUILDS !== '1') {");
  assert.ok(detect >= 0 && refuse > detect, 'the refusal sits right after Workers Builds is detected');
  assert.match(src.slice(refuse, refuse + 800), /process\.exit\(1\)/, 'and it fails the build');
});
