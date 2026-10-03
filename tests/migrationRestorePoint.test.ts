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
    test(`${file}: ${scenario.name} ${scenario.success ? 'permits' : 'blocks'} migration`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'levonis-restore-test-'));
      try {
        const outputFile = join(dir, 'github-output');
        const script = bookmarkStep(readWorkflow(file)).replaceAll('/tmp/tt.txt', join(dir, 'tt.txt'));
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
    const migrateAt = workflow.indexOf('npx wrangler d1 migrations apply levonis-db-staging --remote --env staging');
    assert.ok(bookmarkAt >= 0 && migrateAt > bookmarkAt);
  });
}

test('automatic live migrations follow the current default branch and permit explicit dispatch', () => {
  const workflow = readWorkflow('auto-migrate-on-push.yml');
  assert.match(workflow, /push:\s*(?:#[^\n]*\n\s*)*branches: \['\*\*'\]/);
  assert.match(workflow, /migrate:\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) \}\}/);
  assert.match(workflow, /^ {4}concurrency: staging-deploy$/m);
  assert.ok(!/^concurrency:/m.test(workflow), 'a skipped feature job must not enter the workflow-level live deploy lock');
  assert.ok(!/^\s+pull_request:/m.test(workflow), 'pull requests must not trigger live migration');
});
