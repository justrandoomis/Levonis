/**
 * WORKFLOW 60 — THE ONE-TIME BAMBU IMPORT — HAS THE SHAPE §K.3 OF THE IMPORT
 * SPEC REQUIRES (DECISIONS row 239; build step 2: snapshot and revoke only).
 *
 * The workflow reads, and from build step 8 writes, the LIVE database of a
 * PUBLIC repository's Actions, so its shape is security, and this test reads
 * the file itself rather than a description of it. The file is parsed into its
 * structure (a block-style YAML reader below; the raw text is cross-counted
 * so a parsing slip cannot hide a step), and the input validation is not read
 * but RUN, under bash, against good and hostile inputs.
 *
 *   - dispatch only, on the default branch only; nothing scheduled;
 *   - top-level `permissions: contents: read`; the import job has no
 *     `actions: write`; a chain job, when it exists, has nothing else;
 *   - every checkout keeps no credential (`persist-credentials: false`);
 *   - inputs reach the shell only through the job's IN_* env, the first step
 *     validates every one against its listed pattern, and no run script holds
 *     an expression;
 *   - CLOUDFLARE_* only in the step-level env of steps that run
 *     scripts/bambu-import/cf.mjs, and nowhere else;
 *   - no token in job env or GITHUB_ENV; GITHUB_ENV carries the deadline only;
 *   - every upload-artifact path ends in `.sealed`;
 *   - concurrency group `bambu-import`, `timeout-minutes` 350, deadline 330;
 *   - only snapshot and revoke run; every other mode stops with "not yet";
 *   - actions are pinned the way every other workflow here pins them.
 *
 * Run: node --import tsx --test tests/bambuImportWorkflow.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
// @ts-expect-error - plain ESM helper run by workflow 60, no types
import { RUN_ID_PATTERN } from '../scripts/bambu-import/cf.mjs';
// @ts-expect-error - plain ESM helper run by workflow 60 and in the sandbox, no types
import { PUBLIC_KEY_PATTERN, generateSealKeys } from '../scripts/bambu-import/seal.mjs';

const FILE = 'bambu-import.yml';
const DIR = join(ROOT, '.github/workflows');
const TEXT = readFileSync(join(DIR, FILE), 'utf8');

// ------------------------------------------------------- a block-YAML reader
//
// Enough YAML for a workflow written in block style: mappings, sequences,
// `- key: value` items, plain/quoted scalars and `|` blocks. Flow collections
// (`{…}`, `[…]`) are refused rather than guessed, so the file stays readable
// by this test; `${{ … }}` is an ordinary plain scalar.
type Node = string | number | boolean | null | Node[] | { [key: string]: Node };
type Map = { [key: string]: Node };

function parseYaml(source: string): Node {
  const lines = source.split('\n');
  let at = 0;
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const blank = (line: string) => /^\s*(?:#.*)?$/.test(line);
  const skip = () => {
    while (at < lines.length && blank(lines[at])) at++;
  };
  const fail = (why: string): never => assert.fail(`${FILE}:${at + 1}: ${why}`);
  const KEY = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/;

  function bare(text: string): string {
    const t = text.trim();
    if (t.startsWith("'") || t.startsWith('"')) {
      const quote = t[0];
      let end = 1;
      for (; end < t.length; end++) {
        if (quote === '"' && t[end] === '\\') end++;
        else if (t[end] === quote) {
          if (quote === "'" && t[end + 1] === "'") end++;
          else break;
        }
      }
      const rest = t.slice(end + 1).trim();
      if (rest && !rest.startsWith('#')) fail(`text after a quoted scalar: ${t}`);
      return t.slice(0, end + 1);
    }
    const hash = t.search(/\s#/);
    return (hash >= 0 ? t.slice(0, hash) : t).trim();
  }
  function scalar(text: string): Node {
    if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
    if (text.startsWith('"')) return JSON.parse(text);
    if (text.startsWith('{') || text.startsWith('[')) fail(`a flow collection: ${text}`);
    if (text === 'true' || text === 'false') return text === 'true';
    if (text === 'null' || text === '~') return null;
    if (/^-?\d+$/.test(text)) return Number(text);
    return text;
  }
  function literal(parent: number, header: string): string {
    if (!/^\|-?$/.test(header)) fail(`only | and |- blocks are read: ${header}`);
    const body: string[] = [];
    let indent = -1;
    while (at < lines.length) {
      const line = lines[at];
      if (line.trim() === '') {
        body.push('');
        at++;
        continue;
      }
      if (indentOf(line) <= parent) break;
      if (indent < 0) indent = indentOf(line);
      if (indentOf(line) < indent) fail('a block line less indented than its first line');
      body.push(line.slice(indent));
      at++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    return body.join('\n') + (header === '|' ? '\n' : '');
  }
  function value(text: string | undefined, indent: number): Node {
    const t = text === undefined ? '' : bare(text);
    if (t === '') {
      skip();
      if (at >= lines.length) return null;
      const next = indentOf(lines[at]);
      if (next > indent || (next === indent && lines[at].trimStart().startsWith('- '))) return block(next);
      return null;
    }
    if (t.startsWith('|') || t.startsWith('>')) return literal(indent, t);
    return scalar(t);
  }
  function mapping(indent: number): Map {
    const out: Map = {};
    for (;;) {
      skip();
      if (at >= lines.length || indentOf(lines[at]) < indent) return out;
      if (indentOf(lines[at]) > indent) fail('unexpected indentation');
      if (lines[at].trimStart().startsWith('- ')) return out;
      const found = KEY.exec(lines[at].trim()) ?? fail(`not a key: ${lines[at].trim()}`);
      if (Object.hasOwn(out, found[1])) fail(`duplicate key ${found[1]}`);
      at++;
      out[found[1]] = value(found[2], indent);
    }
  }
  function sequence(indent: number): Node[] {
    const out: Node[] = [];
    for (;;) {
      skip();
      if (at >= lines.length || indentOf(lines[at]) < indent) return out;
      const line = lines[at];
      if (indentOf(line) > indent || !line.trimStart().startsWith('- ')) return out;
      const item = line.trimStart().slice(2);
      if (KEY.test(item.trim()) && !/^['"]/.test(item.trim())) {
        lines[at] = ' '.repeat(indent + 2) + item.trim();
        out.push(mapping(indent + 2));
      } else {
        at++;
        out.push(scalar(bare(item)));
      }
    }
  }
  function block(indent: number): Node {
    return lines[at].trimStart().startsWith('- ') ? sequence(indent) : mapping(indent);
  }
  skip();
  const root = mapping(0);
  skip();
  if (at < lines.length) fail('unparsed text');
  return root;
}

const map = (node: Node | undefined, what: string): Map => {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${what} is not a mapping`);
  return node as Map;
};
const list = (node: Node | undefined, what: string): Node[] => {
  assert.ok(Array.isArray(node), `${what} is not a sequence`);
  return node;
};

const WF = map(parseYaml(TEXT), FILE);
const JOBS = map(WF.jobs, 'jobs');
const IMPORT = map(JOBS.import, 'jobs.import');
const STEPS = list(IMPORT.steps, 'jobs.import.steps').map((step, index) => map(step, `step ${index + 1}`));
const run = (step: Map) => (typeof step.run === 'string' ? step.run : '');
const envOf = (step: Map) => (step.env === undefined ? {} : map(step.env, `env of ${String(step.name ?? step.uses ?? step.run)}`));
/** Lines that are not comments: what GitHub actually reads. */
const ACTIVE = TEXT.split('\n').filter((line) => !/^\s*#/.test(line));

const INPUTS = ['mode', 'run_id', 'max_items', 'resume', 'chain', 'chain_count', 'item', 'seal_pubkey', 'confirm'];
const MODES = ['snapshot', 'preflight', 'open', 'run', 'close', 'report', 'dryrun', 'withdraw', 'revoke'];
const envName = (input: string) => `IN_${input.toUpperCase()}`;
const DEFAULT_BRANCH_ONLY = "${{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}";
const CF_STEP = /^node scripts\/bambu-import\/cf\.mjs [a-z]+(?: --[a-z]+ "\$[A-Z_]+(?:\/[a-z]+)?")+$/;

// ------------------------------------------------------------------ the tests

test('the reader saw every step, checkout, upload and Cloudflare line the file holds', () => {
  // The import job's own lines: from `  import:` to the next job key.
  const start = ACTIVE.indexOf('  import:');
  const next = ACTIVE.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  const importLines = ACTIVE.slice(start, next < 0 ? ACTIVE.length : next);
  const stepLines = importLines.filter((line) => /^ {6}- (?:name|uses|run|id|if|env|with):/.test(line));
  assert.ok(start > 0 && stepLines.length > 0);
  assert.equal(STEPS.length, stepLines.length, 'one parsed step per "- " line of the import job');
  const count = (pattern: RegExp) => ACTIVE.filter((line) => pattern.test(line)).length;
  assert.equal(STEPS.filter((s) => String(s.uses ?? '').startsWith('actions/checkout@')).length, count(/uses: actions\/checkout@/));
  assert.equal(STEPS.filter((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@')).length, count(/upload-artifact/));
  const cloudflareKeys = STEPS.flatMap((s) => Object.keys(envOf(s)).filter((k) => k.startsWith('CLOUDFLARE_')));
  assert.equal(cloudflareKeys.length, count(/CLOUDFLARE_/), 'every CLOUDFLARE_ line of the file is a step env key the checks below see');
  assert.ok(cloudflareKeys.length >= 2);
});

test('name, trigger and branch: dispatch only, default branch only, nothing scheduled, nothing deployed', () => {
  assert.equal(WF.name, '60 - Bambu one-time import (writes live D1/R2 catalogue, no deployment)');
  const on = map(WF.on, 'on');
  assert.deepEqual(Object.keys(on), ['workflow_dispatch'], 'workflow_dispatch is the only trigger');
  assert.doesNotMatch(ACTIVE.join('\n'), /\b(?:schedule|cron|workflow_run|repository_dispatch|pull_request|push):/);
  assert.equal(IMPORT.if, DEFAULT_BRANCH_ONLY, 'the job runs only for the default branch');
  assert.doesNotMatch(ACTIVE.join('\n'), /wrangler\s+(?:deploy|secret|versions|rollback|d1)|npm run (?:build|deploy)|apply-remote-migrations/,
    'no deploy, secret, migration or direct wrangler call: cf.mjs is the only door to Cloudflare');
});

test('the inputs are exactly those of §K.3, with their defaults', () => {
  const inputs = map(map(map(WF.on, 'on').workflow_dispatch, 'workflow_dispatch').inputs, 'inputs');
  assert.deepEqual(Object.keys(inputs), INPUTS);
  const mode = map(inputs.mode, 'mode');
  assert.equal(mode.type, 'choice');
  assert.equal(mode.required, true);
  assert.deepEqual(mode.options, MODES);
  assert.equal(map(inputs.seal_pubkey, 'seal_pubkey').required, true);
  assert.equal(map(inputs.seal_pubkey, 'seal_pubkey').default, undefined, 'no default key: every dispatch brings its own one-time key');
  for (const [name, fallback] of [['run_id', ''], ['max_items', '1'], ['chain_count', '0'], ['item', ''], ['confirm', '']] as const) {
    assert.equal(map(inputs[name], name).default, fallback, name);
  }
  for (const name of ['resume', 'chain']) {
    assert.equal(map(inputs[name], name).type, 'boolean');
    assert.equal(map(inputs[name], name).default, false);
  }
});

test('permissions: contents read at the top and on the import job; actions write only on a chain job', () => {
  assert.deepEqual(WF.permissions, { contents: 'read' });
  assert.deepEqual(IMPORT.permissions, { contents: 'read' });
  assert.equal(WF.env, undefined, 'no workflow-level environment');
  for (const name of Object.keys(JOBS)) assert.ok(['import', 'chain'].includes(name), `unexpected job ${name}`);
  // The chain job arrives with build step 8 (§J.5). When it does, it may dispatch and do nothing else.
  if (JOBS.chain !== undefined) {
    const chain = map(JOBS.chain, 'jobs.chain');
    assert.deepEqual(chain.permissions, { actions: 'write' });
    assert.equal(chain.needs, 'import');
    for (const step of list(chain.steps, 'chain steps').map((s) => map(s, 'chain step'))) {
      assert.equal(step.uses, undefined, 'the chain job checks nothing out and runs no action');
      assert.doesNotMatch(run(step), /\bnpm\b|\bnode\b|scripts\/|\.\/|\$\{\{/, 'no repository code, and no expression in its script');
      assert.ok(!Object.keys(envOf(step)).some((k) => k.startsWith('CLOUDFLARE_')));
    }
  }
  assert.doesNotMatch(JSON.stringify(IMPORT), /"actions":"write"/);
});

test('concurrency, the 350-minute timeout and the 330-minute deadline', () => {
  assert.deepEqual(WF.concurrency, { group: 'bambu-import', 'cancel-in-progress': false });
  assert.equal(IMPORT['timeout-minutes'], 350);
  assert.equal(IMPORT['runs-on'], 'ubuntu-latest');
  assert.deepEqual(WF.defaults, { run: { shell: 'bash' } });
  const first = STEPS[0];
  assert.equal(first.name, 'Deadline and input validation');
  assert.equal(run(first).split('\n')[0], 'echo "DEADLINE_EPOCH=$(( $(date +%s) + 330*60 ))" >> "$GITHUB_ENV"', 'the deadline is the first thing the job does');
  // GITHUB_ENV carries the deadline and nothing else: never an input, never a token.
  const writes = ACTIVE.filter((line) => /GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH/.test(line));
  assert.deepEqual(writes.map((line) => line.trim()), ['echo "DEADLINE_EPOCH=$(( $(date +%s) + 330*60 ))" >> "$GITHUB_ENV"']);
});

test('inputs reach the shell only through the job env, and no run script holds an expression', () => {
  assert.deepEqual(map(IMPORT.env, 'jobs.import.env'), Object.fromEntries(INPUTS.map((input) => [envName(input), `\${{ inputs.${input} }}`])));
  // Every `inputs.` in the file is one of those env lines.
  const uses = ACTIVE.filter((line) => /\binputs\./.test(line));
  assert.deepEqual(uses.map((line) => line.trim()), INPUTS.map((input) => `${envName(input)}: \${{ inputs.${input} }}`));
  assert.doesNotMatch(TEXT, /github\.event\.inputs/);
  for (const step of STEPS) {
    assert.doesNotMatch(run(step), /\$\{\{/, `${String(step.name ?? step.run)}: an expression inside a run script`);
    for (const value of Object.values(envOf(step))) assert.doesNotMatch(String(value), /inputs\./, 'inputs only in the job env');
  }
});

test('every checkout keeps no credential, and actions are pinned as every other workflow here pins them', () => {
  const checkouts = STEPS.filter((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
  assert.ok(checkouts.length >= 1);
  for (const step of checkouts) assert.equal(map(step.with, 'checkout with')['persist-credentials'], false);
  const elsewhere = new Set<string>();
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.yml') && f !== FILE)) {
    for (const m of readFileSync(join(DIR, file), 'utf8').matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) elsewhere.add(m[1]);
  }
  for (const step of STEPS.filter((s) => s.uses !== undefined)) {
    assert.ok(elsewhere.has(String(step.uses)), `${String(step.uses)} is not the reference the repository's other workflows use`);
  }
});

test('CLOUDFLARE_* only in the step env of steps that run cf.mjs, and those steps run nothing else', () => {
  const holders = STEPS.filter((step) => Object.keys(envOf(step)).some((k) => k.startsWith('CLOUDFLARE_')));
  assert.ok(holders.length >= 1);
  for (const step of STEPS) {
    const keys = Object.keys(envOf(step));
    const cloudflare = keys.filter((k) => k.startsWith('CLOUDFLARE_'));
    if (cloudflare.length === 0) {
      assert.doesNotMatch(run(step), /cf\.mjs/, `${String(step.name ?? step.run)} runs cf.mjs without its credentials step env`);
      continue;
    }
    assert.match(run(step).trim(), CF_STEP, `${String(step.name)}: a credentialed step runs cf.mjs and nothing else`);
    assert.deepEqual(cloudflare.sort(), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
    for (const key of cloudflare) assert.equal(envOf(step)[key], `\${{ secrets.${key} }}`);
    assert.equal(step.uses, undefined);
    assert.equal(keys.length, cloudflare.length, 'nothing else in a credentialed step env');
  }
  assert.equal(IMPORT.env && Object.keys(map(IMPORT.env, 'env')).some((k) => k.startsWith('CLOUDFLARE_')), false);
  // The only secrets the workflow reads are those two.
  const secrets = new Set([...TEXT.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...secrets].sort(), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  // npm ci, which runs package install scripts, sees no credential.
  const install = STEPS.find((s) => /^npm ci\b/.test(run(s)));
  assert.ok(install && Object.keys(envOf(install)).length === 0);
});

test('no token travels through the job env or GITHUB_ENV; an importer step, once it exists, reads it from a file', () => {
  assert.ok(!Object.keys(map(IMPORT.env, 'env')).some((k) => /TOKEN/.test(k)));
  for (const step of STEPS) {
    const tokenKeys = Object.keys(envOf(step)).filter((k) => /TOKEN/.test(k) && k !== 'CLOUDFLARE_API_TOKEN');
    if (!tokenKeys.length) continue;
    // Build step 8: the importer alone, through a file under the runner's temp directory.
    assert.equal(step.id, 'run');
    assert.deepEqual(tokenKeys, ['IMPORT_TOKEN_FILE']);
    assert.match(String(envOf(step).IMPORT_TOKEN_FILE), /^\$\{\{ runner\.temp \}\}\//);
    assert.match(run(step), /scripts\/bambu-import\/run\.ts/);
  }
});

test('only sealed files are uploaded, for three days at most', () => {
  const uploads = STEPS.filter((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(uploads.length, 1);
  for (const step of uploads) {
    const options = map(step.with, 'upload with');
    const paths = String(options.path).split('\n').map((p) => p.trim()).filter(Boolean);
    assert.ok(paths.length >= 1);
    for (const path of paths) assert.match(path, /^\$\{\{ runner\.temp \}\}\/out\/[^\s!]*\.sealed$/, `an unsealed upload path: ${path}`);
    assert.ok(Number(options['retention-days']) >= 1 && Number(options['retention-days']) <= 3);
    assert.equal(options.name, 'bambu-import-sealed');
    assert.equal(options['include-hidden-files'], undefined);
  }
  // The snapshot is written exactly where the upload looks.
  const snapshot = STEPS.find((s) => /cf\.mjs snapshot/.test(run(s)));
  assert.ok(snapshot);
  assert.match(run(snapshot), /--out "\$RUNNER_TEMP\/out"$/);
  assert.doesNotMatch(ACTIVE.join('\n'), /actions\/cache\b/, 'nothing produced by the job leaves it through a cache');
});

test('only snapshot and revoke run in this skeleton; every other mode stops with "not yet" after validation', () => {
  const refuse = STEPS[1];
  assert.equal(refuse.if, "env.IN_MODE != 'snapshot' && env.IN_MODE != 'revoke'");
  assert.match(run(refuse), /not yet built/);
  assert.match(run(refuse).trimEnd(), /\bexit 1$/);
  const credentialed = STEPS.filter((s) => /cf\.mjs/.test(run(s)));
  assert.deepEqual(credentialed.map((s) => [s.if, run(s)]), [
    ["env.IN_MODE == 'snapshot'", 'node scripts/bambu-import/cf.mjs snapshot --seal "$IN_SEAL_PUBKEY" --out "$RUNNER_TEMP/out"'],
    ["env.IN_MODE == 'revoke'", 'node scripts/bambu-import/cf.mjs revoke --run "$IN_RUN_ID"'],
  ]);
  assert.ok(STEPS.indexOf(credentialed[0]) > 1, 'nothing reaches Cloudflare before validation and the refusal');
  assert.ok(!STEPS.some((s) => /run\.ts|playwright/.test(run(s))), 'the importer arrives with build step 8');

  // The refusal, run as GitHub runs it.
  for (const mode of MODES.filter((m) => m !== 'snapshot' && m !== 'revoke')) {
    const result = bash(run(refuse), { IN_MODE: mode });
    assert.equal(result.status, 1, mode);
    assert.match(result.stdout, new RegExp(`^::error::mode ${mode} is not yet built`));
  }
});

// ------------------------------------------- the validation step, under bash

function bash(script: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-wf60-'));
  try {
    const file = join(dir, 'step.sh');
    writeFileSync(file, script);
    const githubEnv = join(dir, 'github_env');
    writeFileSync(githubEnv, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', GITHUB_ENV: githubEnv, ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, githubEnv: readFileSync(githubEnv, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEY = generateSealKeys().publicKey as string;
const GOOD: Record<string, string> = {
  IN_MODE: 'snapshot', IN_RUN_ID: '', IN_MAX_ITEMS: '1', IN_RESUME: 'false', IN_CHAIN: 'false',
  IN_CHAIN_COUNT: '0', IN_ITEM: '', IN_SEAL_PUBKEY: KEY, IN_CONFIRM: '',
};
const RUN = 'cir_0123456789abcdef01234567';

test('the validation step accepts the valid dispatches and sets the deadline 330 minutes ahead', () => {
  const script = run(STEPS[0]);
  for (const env of [
    GOOD,
    { ...GOOD, IN_MODE: 'revoke', IN_RUN_ID: RUN },
    { ...GOOD, IN_MODE: 'run', IN_RUN_ID: RUN, IN_CONFIRM: 'IMPORT-LIVE', IN_MAX_ITEMS: '0', IN_CHAIN: 'true', IN_CHAIN_COUNT: '12', IN_RESUME: 'true' },
    { ...GOOD, IN_MODE: 'withdraw', IN_RUN_ID: RUN, IN_CONFIRM: 'IMPORT-LIVE', IN_ITEM: '552709760709906432' },
    { ...GOOD, IN_MODE: 'open', IN_CONFIRM: 'IMPORT-LIVE', IN_MAX_ITEMS: '9999' },
    { ...GOOD, IN_MODE: 'dryrun' },
    { ...GOOD, IN_MODE: 'preflight' },
    { ...GOOD, IN_MODE: 'report', IN_RUN_ID: RUN },
    { ...GOOD, IN_MODE: 'close', IN_RUN_ID: RUN, IN_CONFIRM: 'IMPORT-LIVE' },
  ]) {
    const before = Math.floor(Date.now() / 1000);
    const result = bash(script, env);
    assert.equal(result.status, 0, `${JSON.stringify(env)}: ${result.stdout}${result.stderr}`);
    const deadline = Number(/^DEADLINE_EPOCH=(\d+)$/m.exec(result.githubEnv)?.[1]);
    assert.ok(deadline >= before + 330 * 60 && deadline <= Math.floor(Date.now() / 1000) + 330 * 60, 'job start + 330 minutes');
    assert.equal(result.githubEnv.trim().split('\n').length, 1, 'GITHUB_ENV gets the deadline and nothing else');
  }
});

test('the validation step refuses every malformed or hostile input, and never echoes it', () => {
  const script = run(STEPS[0]);
  const marker = join(tmpdir(), `levonis-wf60-evaluated-${process.pid}`);
  const hostile = [`$(touch ${marker})`, `\`touch ${marker}\``, "x'; exit 0; '", '::add-mask::x', 'a\nb', ' snapshot', 'snapshot ', ''];
  const refused: Array<[string, string]> = [
    ...hostile.map((v): [string, string] => ['IN_MODE', v]),
    ['IN_MODE', 'SNAPSHOT'], ['IN_MODE', 'snapshotx'], ['IN_MODE', 'mint'],
    ['IN_RUN_ID', 'cir_0123'], ['IN_RUN_ID', `${RUN}0`], ['IN_RUN_ID', RUN.toUpperCase()], ['IN_RUN_ID', `${RUN}' OR '1'='1`], ['IN_RUN_ID', '$(id)'],
    ['IN_MAX_ITEMS', ''], ['IN_MAX_ITEMS', '10000'], ['IN_MAX_ITEMS', '-1'], ['IN_MAX_ITEMS', '1 '], ['IN_MAX_ITEMS', '0x10'],
    ['IN_RESUME', 'yes'], ['IN_RESUME', ''], ['IN_CHAIN', 'True'], ['IN_CHAIN', '1'],
    ['IN_CHAIN_COUNT', '13'], ['IN_CHAIN_COUNT', '012'], ['IN_CHAIN_COUNT', ''], ['IN_CHAIN_COUNT', '-1'],
    ['IN_ITEM', 'abc'], ['IN_ITEM', '1'.repeat(21)], ['IN_ITEM', '12;id'],
    ['IN_SEAL_PUBKEY', KEY.slice(0, 42)], ['IN_SEAL_PUBKEY', `${KEY}A`], ['IN_SEAL_PUBKEY', `${KEY.slice(0, 42)}=`], ['IN_SEAL_PUBKEY', `${KEY.slice(0, 42)}+`],
    ['IN_SEAL_PUBKEY', ''], ['IN_SEAL_PUBKEY', `${KEY.slice(0, 21)} ${KEY.slice(22)}`],
    ['IN_CONFIRM', 'import-live'], ['IN_CONFIRM', 'YES'], ['IN_CONFIRM', 'IMPORT-LIVE '],
  ];
  for (const [name, bad] of refused) {
    const result = bash(script, { ...GOOD, [name]: bad });
    assert.equal(result.status, 1, `${name}=${JSON.stringify(bad)} was accepted`);
    assert.match(result.stdout, /^::error::/m, `${name}: a refusal says why`);
    // The value itself is never printed (unless it is a fragment of the step's own fixed text).
    if (bad.length >= 4 && !script.includes(bad)) {
      assert.ok(!result.stdout.includes(bad) && !result.stderr.includes(bad), `${name}: the refused value was echoed`);
    }
    assert.equal(result.githubEnv.trim().split('\n').length, 1);
  }
  // A mode that writes the live catalogue needs the typed confirmation; revoke needs its run.
  for (const mode of ['open', 'run', 'close', 'withdraw']) {
    assert.equal(bash(script, { ...GOOD, IN_MODE: mode, IN_RUN_ID: RUN }).status, 1, `${mode} without IMPORT-LIVE`);
  }
  assert.equal(bash(script, { ...GOOD, IN_MODE: 'revoke' }).status, 1, 'revoke without run_id');
  assert.equal(bash(script, { ...GOOD, IN_MODE: 'snapshot', IN_CONFIRM: 'IMPORT-LIVE' }).status, 0, 'a read may carry the phrase');
  assert.ok(!existsSync(marker), 'no input was ever evaluated');
});

test('the workflow, cf.mjs and seal.mjs agree on the run id and public key patterns', () => {
  const script = run(STEPS[0]);
  assert.ok(script.includes(`"$IN_RUN_ID" =~ ${RUN_ID_PATTERN.source} ]]`), 'run_id: the pattern cf.mjs enforces');
  assert.ok(script.includes(`"$IN_SEAL_PUBKEY" =~ ${PUBLIC_KEY_PATTERN.source} ]]`), 'seal_pubkey: the pattern seal.mjs enforces');
  assert.ok(script.includes(`"$IN_MODE" =~ ^(${MODES.join('|')})$ ]]`), 'mode: exactly the choice list');
});
