/**
 * A node --test reporter that prints how long each test FILE took, once, after
 * the run:
 *
 *   # levonis-test-file-seconds tests/addressContract.test.ts 47.312
 *
 * WHY. The TAP the CI shards print names every test but never its file, so a
 * run's log could not say which files make a shard slow. scripts/test-all.mjs
 * adds this reporter beside TAP on every `--shard` run, and
 * scripts/update-test-timings.mjs turns these lines from a run's logs into
 * scripts/test-timings.json — the weights the shards are balanced by.
 *
 * The seconds are node's own figure for the file: process start to exit, the
 * TypeScript load included, measured while the shard runs its usual number of
 * files at a time. The lines start with `#`, a TAP comment, so nothing that
 * reads the TAP sees a test in them. The reporter yields nothing until the run
 * ends and never changes the exit status.
 */
import { relative, resolve, sep } from 'node:path';

export const FILE_SECONDS_PREFIX = '# levonis-test-file-seconds ';

/** node reports each file under process isolation as a nesting-0 test named
 * by its path relative to the working directory, with `file` absolute. */
export function fileSecondsFromEvent(event, cwd = process.cwd()) {
  if (event?.type !== 'test:complete') return null;
  const { file, name, nesting, details } = event.data ?? {};
  if (nesting !== 0 || typeof file !== 'string' || typeof name !== 'string' || resolve(cwd, name) !== file) return null;
  const ms = details?.duration_ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return { file: relative(cwd, file).split(sep).join('/'), seconds: ms / 1000 };
}

export default async function* testFileTimings(source) {
  const seconds = new Map();
  for await (const event of source) {
    const found = fileSecondsFromEvent(event);
    if (found) seconds.set(found.file, found.seconds);
  }
  for (const file of [...seconds.keys()].sort()) yield `${FILE_SECONDS_PREFIX}${file} ${seconds.get(file).toFixed(3)}\n`;
}
