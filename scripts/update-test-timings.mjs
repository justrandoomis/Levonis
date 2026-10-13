#!/usr/bin/env node
/**
 * Regenerate scripts/test-timings.json — the per-file seconds the CI root
 * shards are balanced by — from the logs of a CI run.
 *
 * Every `--shard` run prints one `# levonis-test-file-seconds <file> <seconds>`
 * line per test file (scripts/test-file-timings.mjs). Download the run's logs
 * (the run page's «Download log archive», or
 * `gh api repos/justrandoomis/Levonis/actions/runs/<run id>/logs > logs.zip`),
 * unzip them, and pass the folder or any job log files:
 *
 *   node scripts/update-test-timings.mjs ./logs --source "run 123 (abc1234)"
 *   node scripts/update-test-timings.mjs ./logs --dry-run
 *
 * A measured file takes its new seconds. A root file these logs did not
 * measure (a shard was cancelled, say) keeps its old value; an entry for a file
 * that no longer exists is dropped. The archive carries each job's lines twice
 * (the whole job and its steps), so a file seen more than once keeps its
 * LARGEST value — the conservative weight. Nothing here touches the network.
 *
 * The output is deterministic: sorted keys, seconds to one decimal. It ends
 * with the plan this file would give the shard count verify-all.yml uses.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_SECONDS_PREFIX } from './test-file-timings.mjs';
import { ROOT_TIMINGS_FILE, discoverRootTests, planRootShards, readRootTimings } from './test-all.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ABOUT = 'Seconds each root test file takes on a GitHub runner, measured by node --test while the shard runs `concurrency` files at a time. scripts/test-all.mjs balances --shard by these; a file missing here weighs the median. Regenerate with scripts/update-test-timings.mjs.';

/** GitHub prefixes every log line with a timestamp; the first line may carry a BOM. */
const LINE = new RegExp(`^(?:\\uFEFF)?(?:\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z )?${FILE_SECONDS_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(tests/[^/\\s]+\\.test\\.ts) (\\d+(?:\\.\\d+)?)\\s*$`);

export function parseFileSeconds(text, into = new Map()) {
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const seconds = Number(match[2]);
    if (!Number.isFinite(seconds)) continue;
    into.set(match[1], Math.max(into.get(match[1]) ?? 0, seconds));
  }
  return into;
}

function logFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? logFiles(child) : name.endsWith('.txt') ? [child] : [];
  });
}

const tenth = (seconds) => Math.max(0.1, Math.round(seconds * 10) / 10);

/** New measurements win; unmeasured current files keep their old seconds;
 * files that are gone are dropped. Keys come back sorted. */
export function mergeTimings(previous, measured, currentFiles) {
  const current = new Set(currentFiles), merged = {};
  for (const file of [...current].sort()) {
    if (measured.has(file)) merged[file] = tenth(measured.get(file));
    else if (Object.hasOwn(previous, file)) merged[file] = previous[file];
  }
  return merged;
}

function shardTotalFromWorkflow(root) {
  const path = join(root, '.github', 'workflows', 'verify-all.yml');
  if (!existsSync(path)) return null;
  const match = /--shard '\$\{\{ matrix\.shard \}\}\/(\d+)'/.exec(readFileSync(path, 'utf8'));
  return match ? Number(match[1]) : null;
}

export function main(argv, { root = ROOT, log = console.log, error = console.error } = {}) {
  const paths = [];
  let source = null, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--source') source = argv[++i] ?? '';
    else if (argv[i].startsWith('--')) { error(`Unknown argument: ${argv[i]}`); return 1; }
    else paths.push(argv[i]);
  }
  if (!paths.length || source === '') {
    error('Usage: node scripts/update-test-timings.mjs <log folder or files>... [--source "run <id> (<sha>)"] [--dry-run]');
    return 1;
  }
  const measured = new Map();
  let read = 0;
  for (const path of paths) {
    if (!existsSync(path)) { error(`No such log file or folder: ${path}`); return 1; }
    for (const file of logFiles(path)) { parseFileSeconds(readFileSync(file, 'utf8'), measured); read++; }
  }
  if (!measured.size) {
    error(`No "${FILE_SECONDS_PREFIX.trim()}" lines in ${read} log file(s). Only runs of a commit whose sharded runs load scripts/test-file-timings.mjs print them.`);
    return 1;
  }
  const previous = readRootTimings(root);
  const currentFiles = discoverRootTests(root);
  const files = mergeTimings(previous.files, measured, currentFiles);
  const stale = [...measured.keys()].filter((file) => !currentFiles.includes(file)).length;
  const kept = currentFiles.filter((file) => !measured.has(file) && Object.hasOwn(previous.files, file)).length;
  const unknown = currentFiles.filter((file) => !Object.hasOwn(files, file));
  const total = Object.values(files).reduce((sum, seconds) => sum + seconds, 0);
  const output = {
    about: ABOUT,
    source: source ?? `scripts/update-test-timings.mjs on ${new Date().toISOString().slice(0, 10)}`,
    concurrency: previous.concurrency,
    files,
  };
  log(`Measured ${measured.size} files in ${read} log file(s); ${stale} of them no longer exist. Kept ${kept} older values; ${unknown.length} current files remain unmeasured and weigh the median.`);
  log(`Total ${Math.round(total)} s of test files (${(total / previous.concurrency / 60).toFixed(1)} min of shard time at ${previous.concurrency} at a time).`);
  const shards = shardTotalFromWorkflow(root);
  if (shards) {
    const plan = planRootShards(currentFiles, shards, output);
    const seconds = plan.map((shard) => shard.seconds);
    log(`verify-all.yml's ${shards} shards: about ${Math.round(Math.max(...seconds))} s for the slowest, ${Math.round(Math.min(...seconds))} s for the quickest.`);
  }
  if (dryRun) { log('Dry run: nothing written.'); return 0; }
  writeFileSync(join(root, ROOT_TIMINGS_FILE), `${JSON.stringify(output, null, 2)}\n`);
  log(`Wrote ${ROOT_TIMINGS_FILE}.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
