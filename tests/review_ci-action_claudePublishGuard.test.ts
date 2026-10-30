/** Review (ci-action group, 2026-10-13): the "protected files" gate that
 * .github/workflows/claude.yml runs before an owner `@claude apply` change can
 * reach the live-deploying default branch. The gate now lives in
 * scripts/claude-publish-gate.py (the workflow copies it from the trusted
 * commit and runs it with `python3 -I` both when packaging the change and
 * again on the exact staged set before the push). It is run here against
 * throwaway local repositories. The gate claims to refuse anything that could
 * change "agent instructions, credentials, or hidden environment". */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const gateFile = fileURLToPath(new URL('../scripts/claude-publish-gate.py', import.meta.url));

// The gate runs as `python3 -I` (as in CI). Windows often has no python3 (only
// the Microsoft Store stub, exit 9009) and creates symbolic links only with
// Developer Mode or elevation; those tests skip there and run once it can.
const pythonSkip = process.platform === 'win32' && spawnSync('python3', ['--version']).status !== 0
  && 'needs python3, not on this Windows machine';
const symlinkSkip = pythonSkip || (process.platform === 'win32' && (() => {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-symlink-probe-'));
  try { symlinkSync('target', join(dir, 'link')); return false; } catch { return 'needs symbolic links (Developer Mode or elevation), not enabled on this Windows machine'; }
  finally { rmSync(dir, { recursive: true, force: true }); }
})());

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'levonis-review-claude-gate-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' },
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (path: string, text = 'x\n') => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  git('init', '-b', 'main');
  write('CLAUDE.md'); write('.github/workflows/deploy.yml'); write('src/app.ts');
  write('package.json', '{"name":"fixture","scripts":{"test:unit":"node scripts/test-all.mjs"}}\n');
  git('add', '-A'); git('commit', '-m', 'base');
  const gate = () => spawnSync('python3', ['-I', gateFile], { cwd: root, encoding: 'utf8' }).status;
  return { root, git, write, gate, link: (path: string, target: string) => symlinkSync(target, join(root, path)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('control: the gate does refuse an edited workflow file', { skip: pythonSkip }, () => {
  const repo = repository();
  try { repo.write('.github/workflows/deploy.yml', 'changed\n'); assert.equal(repo.gate(), 1); } finally { repo.cleanup(); }
});

/* .claude/settings.json is loaded by the Claude Code CLI in every later run
 * of this workflow (project settings apply in --print mode): hooks there run
 * shell commands with ANTHROPIC_API_KEY in the environment even in the
 * review-only mode whose tools are Read/Glob/Grep. Nested CLAUDE.md and
 * CLAUDE.local.md are agent instructions too. */
for (const path of ['.claude/settings.json', '.claude/skills/x/SKILL.md', 'src/CLAUDE.md', 'CLAUDE.local.md']) {
  test(`the publish gate refuses Claude Code agent configuration/instructions: ${path}`, { skip: pythonSkip }, () => {
    const repo = repository();
    try {
      repo.write(path, path.endsWith('.json') ? '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"env"}]}]}}\n' : 'instructions\n');
      assert.equal(repo.gate(), 1, `${path} would be pushed to the live-deploying default branch`);
    } finally { repo.cleanup(); }
  });
}

/* `git status --porcelain -z` emits a rename as "R  new\0old\0". The gate
 * strips three characters from every NUL field, so the old path of a staged
 * rename is read as "UDE.md" and passes. */
test('the publish gate refuses a staged rename that removes the root CLAUDE.md', { skip: pythonSkip }, () => {
  const repo = repository();
  try {
    repo.git('mv', 'CLAUDE.md', 'notes.txt');
    assert.equal(repo.gate(), 1, 'renaming CLAUDE.md away must be treated as touching CLAUDE.md');
  } finally { repo.cleanup(); }
});

test('control: an ordinary source change, a new file and a dependency-only package.json edit pass', { skip: pythonSkip }, () => {
  const repo = repository();
  try {
    repo.write('src/app.ts', 'export const changed = true;\n');
    repo.write('src/new.ts', 'export {};\n');
    repo.write('package.json', '{"name":"fixture","dependencies":{"x":"1.0.0"},"scripts":{"test:unit":"node scripts/test-all.mjs"}}\n');
    repo.write('docs/notes.md', 'notes\n');
    assert.equal(repo.gate(), 0);
  } finally { repo.cleanup(); }
});

/* The gate's own scope (review fix CI-2/CI-3): deep agent configuration,
 * MCP servers, the release/deploy gate, npm lifecycle/gate scripts, and
 * symbolic links a build could follow out of the repository. */
for (const path of ['.mcp.json', 'studio/.claude/settings.json', 'scripts/check-deploy-freshness.mjs', 'scripts/test-all.mjs', 'scripts/lib/preserve-vars.mjs', 'scripts/claude-publish-gate.py', 'wrangler.jsonc', '.env.production']) {
  test(`the publish gate refuses ${path}`, { skip: pythonSkip }, () => {
    const repo = repository();
    try { repo.write(path, 'changed\n'); assert.equal(repo.gate(), 1); } finally { repo.cleanup(); }
  });
}

test('the publish gate refuses a change to npm scripts (lifecycle hooks and the release gate itself)', { skip: pythonSkip }, () => {
  for (const scripts of ['{"test:unit":"true"}', '{"test:unit":"node scripts/test-all.mjs","postinstall":"node x.js"}']) {
    const repo = repository();
    try {
      repo.write('package.json', `{"name":"fixture","scripts":${scripts}}\n`);
      assert.equal(repo.gate(), 1, scripts);
    } finally { repo.cleanup(); }
  }
  const repo = repository();
  try { repo.write('studio/package.json', '{"name":"s","scripts":{"preinstall":"node x.js"}}\n'); assert.equal(repo.gate(), 1); } finally { repo.cleanup(); }
});

test('the publish gate refuses a symbolic link (a build could publish what it points at)', { skip: symlinkSkip }, () => {
  const repo = repository();
  try { repo.link('src/env.txt', '/proc/self/environ'); assert.equal(repo.gate(), 1); } finally { repo.cleanup(); }
});

test('claude.yml runs this gate from a trusted copy when packaging and again before the push', () => {
  const workflow = readFileSync(new URL('../.github/workflows/claude.yml', import.meta.url), 'utf8');
  assert.match(workflow, /git show "HEAD:scripts\/claude-publish-gate\.py" > "\$gate"\n\s+if ! python3 -I "\$gate"; then/);
  const publish = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  comment:'));
  const copy = publish.indexOf('cp scripts/claude-publish-gate.py "$gate"');
  const apply = publish.indexOf('git apply --index');
  const gate = publish.indexOf('python3 -I "$gate"');
  const commit = publish.indexOf('commit -q --no-verify');
  assert.ok(copy > 0 && apply > copy && gate > apply && commit > gate, 'copy the gate, apply the change, gate the staged set, then commit');
  assert.match(publish, /core\.hooksPath=\/dev\/null/);
});

/* Found while fixing (2026-10-13): with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB the
 * CLI 2.1.296 leaves empty stand-ins (.npmrc, .gitmodules, yarn.lock, .env …)
 * in the working directory. Packaged as-is, every apply would be refused by
 * this gate, so the package step removes exactly those: empty, regular, and
 * absent from the base commit. */
test('claude.yml removes the CLI sandbox stand-ins before staging, and only empty ones the base lacks', () => {
  const workflow = readFileSync(new URL('../.github/workflows/claude.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Package the proposed change'), workflow.indexOf('- name: Refuse a change that carries the API key'));
  const loop = step.indexOf('for stub in .npmrc'), add = step.indexOf('git add -A');
  assert.ok(loop > 0 && add > loop, 'stand-ins are removed before anything is staged');
  for (const name of ['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.gitmodules', 'yarn.lock', 'pnpm-lock.yaml', '.env', '.env.production.local'])
    assert.ok(step.slice(loop, add).includes(` ${name}`), name);
  assert.match(step, /\[ ! -s "\$GITHUB_WORKSPACE\/\$stub" \]/, 'only an empty file');
  assert.match(step, /! git cat-file -e "HEAD:\$stub"/, 'only a path the base commit does not have');
});
