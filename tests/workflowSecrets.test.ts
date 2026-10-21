/**
 * THE EXCHANGE-RATE KEY IS NEVER WRITTEN BY A DEPLOY (FX programme plan §9 §3,
 * critiques F15 and L12).
 *
 * IRAQ_PARALLEL_FX_API_KEY is a dashboard SECRET on the live Worker.
 * `wrangler deploy` leaves secrets alone; workflow 7 does run `wrangler secret
 * put` for other names, so this pins that no workflow ever puts or deletes
 * this one — and that workflow 7 reports its binding TYPE only (never its
 * value), warning when it is a plain-text var (visible in the dashboard and
 * re-sent with every deploy).
 *
 * ANTHROPIC_API_KEY (the support assistant AI layer, DECISIONS row 262) follows
 * the same rule: a dashboard secret, reported by type only, never written.
 *
 * Run: node --import tsx --test tests/workflowSecrets.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const NAME = 'IRAQ_PARALLEL_FX_API_KEY';
const AI_NAME = 'ANTHROPIC_API_KEY';
const dir = join(ROOT, '.github/workflows');
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8') }));

for (const name of [NAME, AI_NAME]) {
  test(`no workflow puts, deletes, bulk-uploads or --vars ${name}`, () => {
    assert.ok(workflows.length > 5);
    for (const { f, text } of workflows) {
      for (const line of text.split('\n')) {
        if (/wrangler\s+secret\s+(put|delete|bulk)/.test(line)) assert.doesNotMatch(line, new RegExp(name), `${f}: ${line.trim()}`);
        if (/--var\b/.test(line)) assert.doesNotMatch(line, new RegExp(name), `${f}: ${line.trim()}`);
      }
      // The secret-upload loops list their names: this one is never among them.
      for (const m of text.matchAll(/for NAME in ([^;]+);/g)) assert.doesNotMatch(m[1]!, new RegExp(name), f);
      // claude.yml runs the Claude Code CLI with a repository secret of the same name. That is its own key, not
      // the Worker secret, and it is never put on a Worker (the checks above still hold for claude.yml).
      if (name === AI_NAME && f === 'claude.yml') continue;
      assert.doesNotMatch(text, new RegExp(`secrets\\.${name}`), `${f} reads a repository secret of that name`);
    }
  });
}

test('workflow 7 prints the key\'s binding type only — never its text — and only warns (L12)', () => {
  const yml = workflows.find((w) => w.f === 'deploy-staging-code.yml')!.text;
  const lines = yml.split('\n').filter((l) => l.includes(NAME));
  assert.ok(lines.length >= 3, 'the notice is there');
  for (const l of lines) assert.doesNotMatch(l, /\.text\b|secret put|exit 1/, l.trim());
  assert.match(yml, /select\(\.name == "IRAQ_PARALLEL_FX_API_KEY"\) \| \.type\]/);
  assert.match(yml, /plain_text\) echo "::warning::IRAQ_PARALLEL_FX_API_KEY is a plain_text var/);
  // Read from the settings answer the vars step already fetched, before anything is migrated.
  const notice = yml.indexOf('FX_KEY_TYPE=');
  const migrate = yml.indexOf('- name: Apply any pending migrations BEFORE the code that needs them');
  assert.ok(notice > 0 && notice < migrate);
});

test('workflow 7 reports the assistant AI key by binding type only, and only warns', () => {
  const yml = workflows.find((w) => w.f === 'deploy-staging-code.yml')!.text;
  const lines = yml.split('\n').filter((l) => l.includes(AI_NAME));
  assert.ok(lines.length >= 3, 'the notice is there');
  for (const l of lines) assert.doesNotMatch(l, /\.text\b|secret put|exit 1/, l.trim());
  assert.match(yml, /select\(\.name == "ANTHROPIC_API_KEY"\) \| \.type\]/);
  assert.match(yml, /plain_text\) echo "::warning::ANTHROPIC_API_KEY is a plain_text var/);
  const notice = yml.indexOf('AI_KEY_TYPE=');
  const migrate = yml.indexOf('- name: Apply any pending migrations BEFORE the code that needs them');
  assert.ok(notice > 0 && notice < migrate);
});

test('.dev.vars.example names the keys with no value', () => {
  const example = readFileSync(join(ROOT, '.dev.vars.example'), 'utf8');
  assert.match(example, /^IRAQ_PARALLEL_FX_API_KEY=$/m);
  assert.match(example, /^ANTHROPIC_API_KEY=$/m);
});
