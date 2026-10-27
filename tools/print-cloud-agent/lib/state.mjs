/**
 * THE AGENT'S DURABLE STATE (docs/PRINT_CLOUD.md §9 «Order»,
 * docs/PRINT_CLOUD_AGENT.md §State).
 *
 * The cloud orders an agent's telemetry by `(boot, seq)` and by nothing
 * else: `boot` is a counter the agent PERSISTS and raises by one at every
 * start of its process, `seq` strictly increases within that boot. A higher
 * boot is a later run, so a dead process's late reading can never overtake
 * the live one — whatever any clock says.
 *
 * That guarantee rests on this file never going BACKWARDS. A counter that
 * returns to an old value (a lost file reset to 0, a file restored from an
 * old backup) makes every reading of the new run look OLDER than the one the
 * cloud stored: each is answered `superseded`, the printer looks silent, gets
 * no work, and the cloud records `boot_regressed`. So this module refuses to
 * start rather than guess:
 *
 *   state.json unreadable  → STATE_UNREADABLE (never «treat it as 0»);
 *   state.json missing in a directory the agent has used → STATE_MISSING;
 *   state.json older than the boot journal → STATE_STALE (a restored copy).
 *
 * `boots.log` is an append-only journal of every boot ever taken, written
 * after state.json at each start. It is what makes a restored, older
 * state.json detectable, and what `--repair-state` rebuilds the counter from
 * — an explicit operator action, never an automatic one.
 *
 * Every write is atomic: a temp file in the same directory, fsync, rename
 * over the target, fsync of the directory. A crash leaves the old file or
 * the new one, never half of either. A lock file keeps two processes from
 * sharing one counter (two runs interleaving the same boot would reorder
 * each other's readings).
 */
import { closeSync, constants as fsConstants, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STATE_FILE = 'state.json';
export const BOOT_JOURNAL = 'boots.log';
export const LOCK_FILE = 'agent.lock';
const STATE_VERSION = 1;
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

export class StateError extends Error {
  /**
   * @param {'STATE_UNREADABLE' | 'STATE_MISSING' | 'STATE_STALE' | 'STATE_LOCKED' | 'STATE_INVALID_NAME'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

/** Write `data` to `path` so that a crash leaves either the old file or the new one. */
export function atomicWriteFile(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(dir);
}

function fsyncDir(dir) {
  // A rename is durable only once the directory entry is: fsync the directory where the platform allows it.
  let fd;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Windows cannot open a directory for fsync; NTFS journals the rename itself.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function appendLine(path, line) {
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The highest boot the journal recorded, or null when there is no journal. Torn last lines are ignored. */
export function journalHighWater(dir) {
  let text;
  try {
    text = readFileSync(join(dir, BOOT_JOURNAL), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw new StateError('STATE_UNREADABLE', `cannot read ${join(dir, BOOT_JOURNAL)}: ${/** @type {Error} */ (e).message}`);
  }
  let high = null;
  for (const line of text.split('\n')) {
    const m = /^(\d{1,16}) /.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && (high === null || n > high)) high = n;
  }
  return high;
}

/**
 * Read state.json. Returns null when it does not exist; throws STATE_UNREADABLE
 * for anything else that is not a well-formed state.
 */
export function readStateFile(dir) {
  const path = join(dir, STATE_FILE);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw new StateError('STATE_UNREADABLE', `cannot read ${path}: ${/** @type {Error} */ (e).message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StateError('STATE_UNREADABLE', `${path} is not valid JSON — refusing to start rather than reset the boot counter to 0 (see docs/PRINT_CLOUD_AGENT.md, «State»)`);
  }
  if (!parsed || typeof parsed !== 'object' || !Number.isSafeInteger(parsed.boot) || parsed.boot < 0) {
    throw new StateError('STATE_UNREADABLE', `${path} has no valid "boot" counter — refusing to start rather than reset it (see docs/PRINT_CLOUD_AGENT.md, «State»)`);
  }
  return parsed;
}

/** Has this directory been used by an agent before (anything of ours in it besides state.json)? */
function usedBefore(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => n === BOOT_JOURNAL || n === 'jobs' || n === 'commands.json' || n === 'prints');
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

function takeLock(dir, clock) {
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, since: new Date(clock()).toISOString() }));
      fsyncSync(fd);
      closeSync(fd);
      return path;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        holder = null;
      }
      if (holder && pidAlive(holder.pid) && holder.pid !== process.pid) {
        throw new StateError('STATE_LOCKED', `another agent process (pid ${holder.pid}) is using ${dir}: two processes must never share one boot counter`);
      }
      // A lock left by a process that is gone (or by this very process in a test that reopened the state).
      rmSync(path, { force: true });
    }
  }
  throw new StateError('STATE_LOCKED', `could not take the lock ${path}`);
}

/** Store keys are relative paths of plain names: never `..`, never absolute, never a separator trick. */
function storePath(dir, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(name) || name.split('/').some((s) => s === '..' || s === '.')) {
    throw new StateError('STATE_INVALID_NAME', `invalid state entry name: ${String(name)}`);
  }
  return join(dir, name);
}

export class AgentState {
  /**
   * Open the state directory, take its lock, raise the boot counter by one and
   * persist it BEFORE anything is reported with it.
   *
   * @param {string} dir
   * @param {{ init?: boolean, repair?: boolean, clock?: () => number }} [opts]
   *   init    start a NEW counter in a directory that has been used (its printers must
   *           then be re-bound to a fresh agent token — docs §State);
   *   repair  rebuild a missing, unreadable or stale state.json from the boot journal.
   */
  static open(dir, opts = {}) {
    const clock = opts.clock ?? (() => Date.now());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = takeLock(dir, clock);
    try {
      const journal = journalHighWater(dir);
      let current;
      if (opts.repair || opts.init) {
        // An explicit operator action: continue from the highest counter that survives anywhere.
        let fromFile = null;
        try {
          fromFile = readStateFile(dir);
        } catch {
          fromFile = null;
        }
        const candidates = [journal, fromFile?.boot].filter((n) => Number.isSafeInteger(n));
        if (!candidates.length && opts.repair) {
          throw new StateError('STATE_MISSING', `nothing to repair the boot counter from in ${dir} (no ${BOOT_JOURNAL}, no readable ${STATE_FILE})`);
        }
        // --init with nothing left starts a new counter at 0: the printers must be re-bound to a fresh token.
        current = candidates.length ? Math.max(.../** @type {number[]} */ (candidates)) : 0;
      } else {
        const state = readStateFile(dir);
        if (state === null) {
          if (usedBefore(dir) || journal !== null) {
            throw new StateError(
              'STATE_MISSING',
              `${join(dir, STATE_FILE)} is missing but this directory has been used by an agent before${journal !== null ? ` (the boot journal reached ${journal})` : ''}. ` +
                'Restore the file, run once with --repair-state to rebuild it from the boot journal, or --init to start a new counter and re-bind the printers to a fresh agent token.'
            );
          }
          // A directory never used: the very first start.
          current = 0;
        } else {
          if (journal !== null && state.boot < journal) {
            throw new StateError(
              'STATE_STALE',
              `${join(dir, STATE_FILE)} says boot ${state.boot}, but the boot journal reached ${journal}: the file is an older copy. ` +
                'Readings sent with it would be superseded by the cloud. Run once with --repair-state to continue from the journal.'
            );
          }
          current = state.boot;
        }
      }
      if (current >= MAX_SEQ) throw new StateError('STATE_UNREADABLE', 'the boot counter is exhausted');
      const boot = current + 1;
      const startedAt = new Date(clock()).toISOString();
      // state.json FIRST, then the journal: a crash between the two leaves state.json ahead of the
      // journal, which is safe; the journal ahead of state.json would refuse the next start.
      atomicWriteFile(join(dir, STATE_FILE), `${JSON.stringify({ version: STATE_VERSION, boot, started_at: startedAt }, null, 2)}\n`);
      appendLine(join(dir, BOOT_JOURNAL), `${boot} ${startedAt}`);
      return new AgentState(dir, boot, lock);
    } catch (e) {
      rmSync(lock, { force: true });
      throw e;
    }
  }

  /** @private */
  constructor(dir, boot, lockPath) {
    this.dir = dir;
    /** The boot counter of THIS process run. */
    this.boot = boot;
    this.lockPath = lockPath;
    this.seq = -1;
    this.closed = false;
  }

  /** The next reading's place in this boot: 0, 1, 2, … strictly increasing for the life of the process. */
  nextSeq() {
    if (this.seq >= MAX_SEQ) throw new StateError('STATE_UNREADABLE', 'the sequence is exhausted for this boot; restart the agent');
    this.seq += 1;
    return this.seq;
  }

  /** Read a JSON entry of the store (`commands.json`, `jobs/<id>.json`); `fallback` when it does not exist. */
  readJson(name, fallback = null) {
    const path = storePath(this.dir, name);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return fallback;
      throw e;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new StateError('STATE_UNREADABLE', `${path} is not valid JSON`);
    }
  }

  writeJson(name, value) {
    atomicWriteFile(storePath(this.dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }

  remove(name) {
    rmSync(storePath(this.dir, name), { force: true, recursive: true });
  }

  /** Entry names directly under a store directory (`jobs`), or [] when it does not exist. */
  list(dirName) {
    try {
      return readdirSync(storePath(this.dir, dirName));
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
      throw e;
    }
  }

  /** An absolute path inside the state directory (work and print files). */
  path(...parts) {
    return storePath(this.dir, parts.join('/'));
  }

  exists(name) {
    try {
      statSync(storePath(this.dir, name));
      return true;
    } catch {
      return false;
    }
  }

  /** Release the lock. The counter stays where it is: the next start raises it again. */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already gone.
    }
  }
}
