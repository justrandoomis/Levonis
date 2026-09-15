#!/usr/bin/env node
/**
 * TYPECHECK THE TYPESCRIPT THAT LIVES INSIDE THE WORKFLOWS.
 *
 * Two workflows write a `.gen.ts` runner to `scripts/` with a heredoc and then
 * typecheck it before letting it near R2. That CI step is real and it works —
 * it is what stopped a broken delete runner from running. But the file exists
 * only inside a CI checkout, so `npm run check` locally was typechecking a
 * `scripts/` directory that did not contain it, and passed.
 *
 * The result was a round trip: push, wait for CI, read the compiler error that
 * a local `tsc` would have printed in three seconds. Worse, the failure landed
 * on a run whose second job deletes the owner's only copy of their media — a
 * place where "push and see" is not a debugging strategy.
 *
 * So this extracts every embedded runner exactly as its workflow writes it,
 * puts it where `tests/tsconfig.json` will find it, and runs the same compiler
 * CI runs. Generated files are removed afterwards unless they were already
 * there, so a developer mid-migration keeps whatever they were looking at.
 *
 * Run: node scripts/check-embedded-runners.mjs
 */
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = join(root, '.github', 'workflows');

/**
 * Every `cat > ./scripts/NAME.gen.ts <<'TSEOF' ... TSEOF` block in a workflow,
 * with the heredoc's YAML indentation removed the way the shell sees it.
 */
function extractRunners(yaml) {
  const found = [];
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)cat > \.\/(scripts\/[\w.-]+\.gen\.ts) <<'TSEOF'\s*$/);
    if (!open) continue;
    const [, indent, target] = open;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() === 'TSEOF') break;
      // The heredoc is indented to sit inside the YAML block; the shell writes
      // the text with that indentation stripped, and so must we.
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
    }
    if (j >= lines.length) throw new Error(`${target}: heredoc opened at line ${i + 1} is never closed`);
    found.push({ target, source: body.join('\n') + '\n' });
    i = j;
  }
  return found;
}

const generated = [];
const kept = [];
for (const file of readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
  for (const runner of extractRunners(readFileSync(join(workflowDir, file), 'utf8'))) {
    const path = join(root, runner.target);
    if (existsSync(path)) {
      // Someone is working on it by hand. Leave their copy alone and say so.
      kept.push(runner.target);
      continue;
    }
    writeFileSync(path, runner.source);
    generated.push({ path, target: runner.target, from: file });
  }
}

if (generated.length === 0 && kept.length === 0) {
  console.log('check-embedded-runners: no workflow embeds a .gen.ts runner');
  process.exit(0);
}
for (const g of generated) console.log(`check-embedded-runners: ${g.from} -> ${g.target}`);
for (const k of kept) console.log(`check-embedded-runners: ${k} already exists on disk, left as-is`);

let failed = false;
try {
  execFileSync('npx', ['tsc', '--noEmit', '-p', 'tests/tsconfig.json'], { cwd: root, stdio: 'inherit' });
} catch {
  failed = true;
} finally {
  // Never leave a generated file behind: it is not committed, and a stale one
  // would typecheck against a workflow that has since changed.
  for (const g of generated) rmSync(g.path, { force: true });
}

if (failed) {
  console.error('check-embedded-runners: an embedded workflow runner does not compile against this repository.');
  console.error('The workflow typechecks it before touching anything, so CI would refuse the run — this says so first.');
  process.exit(1);
}
console.log(`check-embedded-runners: ${generated.length} embedded runner(s) typecheck clean`);
