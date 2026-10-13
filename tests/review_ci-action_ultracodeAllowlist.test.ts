/** Review (ci-action group, 2026-10-13): the Bash allowlists in
 * .github/workflows/claude.yml are meant to keep the model to inspection and
 * the repository's own checks while ANTHROPIC_API_KEY sits in the CLI's
 * environment. Claude Code Bash rules are prefix rules, so `sed`, `find`,
 * `npx tsx` (and `rg --pre`) let the model run any command; the repository's
 * own checks (`npm run test:unit`, `npm run build`, …) run code it can edit.
 *
 * The fix: those prefixes are gone, and every Bash command and hook runs in
 * the CLI's bubblewrap sandbox with the key scrubbed
 * (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1, which refuses to start without
 * bubblewrap). Probed locally with the real CLI 2.1.296 against a mock API:
 * without the scrub `node -e` printed the key; with it the same command saw
 * no key and no process holding it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/claude.yml', import.meta.url), 'utf8');

function allowlist(marker: string): string[] {
  const line = workflow.split('\n').find((text) => text.includes(marker));
  assert.ok(line, `allowlist line not found: ${marker}`);
  return [...line.matchAll(/Bash\(([^)]*?):\*\)/g)].map((match) => match[1]);
}
const ultracode = allowlist("--allowedTools 'Read,Glob,Grep,Edit,Write,Agent,");
const apply = allowlist("--allowedTools 'Read,Glob,Grep,Edit,Write,Bash(");

/** Prefixes that execute an arbitrary command or script on their own. */
const EXECUTES = ['sed', 'find', 'rg', 'npx', 'npx tsx', 'node', 'node -e', 'awk', 'xargs', 'env', 'bash', 'sh', 'python', 'python3', 'perl', 'make', 'git', 'git -c', 'npm', 'npm exec', 'tsx'];
/** What remains: inspection plus the repository's own checks. */
const ULTRACODE_ALLOWED = ['git status', 'git diff', 'git log', 'git show', 'ls', 'grep', 'npm run check', 'npm run test:unit', 'node --import tsx --test', 'npm run build'];

test('no allowlisted Bash prefix executes arbitrary commands by itself', () => {
  for (const [name, list] of [['ultracode', ultracode], ['apply', apply]] as const) {
    for (const prefix of list) assert.ok(!EXECUTES.includes(prefix), `${name} allows "${prefix} …"`);
  }
  assert.deepEqual([...ultracode].sort(), [...ULTRACODE_ALLOWED].sort());
  assert.deepEqual([...apply].sort(), ['git diff', 'git status', 'ls']);
});

test('every Claude Code subprocess runs sandboxed without the key, and the CLI cannot start unsandboxed', () => {
  const execute = workflow.slice(workflow.indexOf('- name: Run Claude Code directly'), workflow.indexOf('claude "${args[@]}"'));
  assert.match(execute, /^\s+ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}$/m);
  assert.match(execute, /^\s+CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'$/m);
  const sandbox = workflow.indexOf('sudo apt-get install -y --no-install-recommends bubblewrap socat');
  assert.ok(sandbox > 0 && sandbox < workflow.indexOf('- name: Run Claude Code directly'), 'bubblewrap and socat are installed first');
  assert.match(workflow, /bwrap --ro-bind \/ \/ --dev \/dev --proc \/proc --unshare-all --die-with-parent true/);
  // Python reading Claude's output never imports a module Claude wrote.
  for (const line of workflow.split('\n').filter((text) => /^\s*(?:if ! )?python3\b/.test(text))) assert.match(line, /python3 -I\b/, line.trim());
  // The public comment never carries the key.
  assert.match(workflow, /if any\(form and form in message for form in forms\):/);
});

test('the job that runs Claude holds a read-only token; only the publish job, which runs no change code, can push or dispatch', () => {
  const job = (name: string, next: string) => workflow.slice(workflow.indexOf(`\n  ${name}:`), next ? workflow.indexOf(`\n  ${next}:`) : undefined);
  const claude = job('claude', 'verify'), verify = job('verify', 'publish'), publish = job('publish', 'comment'), comment = job('comment', '');
  for (const [name, body] of [['claude', claude], ['verify', verify]] as const) {
    assert.match(body, /^ {4}permissions:\s*\n {6}contents: read\s*\n(?! {6})/m, `${name} is read-only`);
  }
  assert.doesNotMatch(verify, /secrets\./, 'Claude-written code runs with no secrets');
  assert.match(publish, /^ {4}permissions:\s*\n {6}contents: write\s*\n {6}actions: write\s*\n(?! {6})/m);
  assert.doesNotMatch(publish, /npm (?:ci|run|install)|node scripts|npx/, 'the token-holding job runs no repository or change code');
  assert.match(comment, /^ {4}permissions:\s*\n {6}issues: write\s*\n {6}pull-requests: write\s*\n(?! {6})/m);
  assert.doesNotMatch(comment, /actions\/checkout/);
  // The owner-only guard stays, on every job that can run with always().
  assert.match(claude, /github\.actor == 'justrandoomis' && github\.triggering_actor == 'justrandoomis'/);
  assert.match(comment, /github\.actor == 'justrandoomis' && github\.triggering_actor == 'justrandoomis' && needs\.claude\.result != 'skipped'/);
});

test('the proposed change is verified by the same parts as workflow 7, in parallel', () => {
  const verifyAll = readFileSync(new URL('../.github/workflows/verify-all.yml', import.meta.url), 'utf8');
  const shards = /^\s+shard: \[([^\]]+)\]$/m.exec(verifyAll)![1].split(',').map((part) => part.trim());
  const parts = /^\s+part: \[([^\]]+)\]$/m.exec(workflow)![1].split(',').map((part) => part.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(parts, ['checks', ...shards.map((shard) => `root ${shard}/${shards.length}`), 'workspaces', 'studio']);
  assert.match(workflow, /'root '\*\) node scripts\/test-all\.mjs --suite root --shard "\$\{PART#root \}" ;;/);
});

/* Why the prefixes went: each of these, run as the allowlist would have let
 * it run, executes a payload that reads the key from its environment. */
const KEY = 'sk-ant-review-dummy-not-a-real-key';
const repoRoot = new URL('..', import.meta.url).pathname;
const attempts: Array<{ prefix: string; command: (dir: string) => string; cwd?: string }> = [
  { prefix: 'sed', command: (dir) => `sed -n '1e printf %s "$ANTHROPIC_API_KEY"' ${dir}/one-line.txt` },
  { prefix: 'find', command: (dir) => `find ${dir} -maxdepth 0 -exec sh -c 'printf %s "$ANTHROPIC_API_KEY"' \\;` },
  { prefix: 'npx tsx', command: () => `npx tsx -e 'process.stdout.write(process.env.ANTHROPIC_API_KEY ?? "")'`, cwd: repoRoot },
];
for (const attempt of attempts) {
  test(`"${attempt.prefix} …" executes arbitrary code, so it is not allowlisted`, () => {
    assert.ok(!ultracode.includes(attempt.prefix) && !apply.includes(attempt.prefix));
    const dir = mkdtempSync(join(tmpdir(), 'levonis-review-allowlist-'));
    try {
      writeFileSync(join(dir, 'one-line.txt'), 'x\n');
      const result = spawnSync('bash', ['-c', attempt.command(dir)], {
        cwd: attempt.cwd ?? dir, encoding: 'utf8', timeout: 60_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: KEY },
      });
      assert.ok(result.stdout.includes(KEY), `"${attempt.prefix}" is an execution primitive (it printed the key unsandboxed)`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
