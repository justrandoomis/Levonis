#!/usr/bin/env node
/**
 * LEVONIS PRINT CLOUD — THE WORKSHOP AGENT (docs/PRINT_CLOUD_AGENT.md).
 *
 * The program on the workshop's LAN that drives the real printers and the
 * slicer and speaks the cloud's agent protocol (docs/PRINT_CLOUD.md §9).
 * Plain Node 20+, no dependencies.
 *
 *   node tools/print-cloud-agent/agent.mjs --config ./agent.config.json
 *       run until SIGINT / SIGTERM
 *   … --config <file> --check
 *       prove the token, list the bound printers, ask each configured one
 *       for its status once — sends no telemetry, touches no state
 *   … --config <file> --bed-cleared <connection_ref>
 *       tell the running agent the bed of that printer has been cleared
 *   … --config <file> --init | --repair-state
 *       start a new boot counter in a used state directory / rebuild a
 *       missing, unreadable or stale state.json from the boot journal
 *   … --print-fingerprint <host>[:port]
 *       print a printer's TLS certificate fingerprint, to pin it
 *
 * Exit codes: 0 stopped cleanly · 64 bad arguments · 77 the cloud refused the
 * token · 78 configuration or state refused · 1 anything else.
 */
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfigFile } from './lib/config.mjs';
import { createLogger } from './lib/log.mjs';
import { CloudClient, tokenRejected } from './lib/protocol.mjs';
import { bedFlagName, Runner } from './lib/runner.mjs';
import { atomicWriteFile, AgentState, StateError } from './lib/state.mjs';
import { peerFingerprint } from './lib/tlstrust.mjs';
import { createDriver } from './drivers/index.mjs';
import { createSlicer } from './slicers/index.mjs';

export const VERSION = '1.0.0';
export const EXIT = { OK: 0, FAILED: 1, USAGE: 64, NOPERM: 77, CONFIG: 78 };

const USAGE = `usage: node tools/print-cloud-agent/agent.mjs --config <file> [--check | --bed-cleared <connection_ref> | --init | --repair-state]
       node tools/print-cloud-agent/agent.mjs --print-fingerprint <host>[:port]`;

/** @returns {{ config?: string, check: boolean, init: boolean, repair: boolean, bedCleared?: string, fingerprint?: string, help: boolean, version: boolean, error?: string }} */
export function parseArgs(argv) {
  const out = { check: false, init: false, repair: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === '--config') out.config = value();
      else if (a === '--check') out.check = true;
      else if (a === '--init') out.init = true;
      else if (a === '--repair-state') out.repair = true;
      else if (a === '--bed-cleared') out.bedCleared = value();
      else if (a === '--print-fingerprint') out.fingerprint = value();
      else if (a === '--help' || a === '-h') out.help = true;
      else if (a === '--version') out.version = true;
      else return { ...out, error: `unknown argument ${a}` };
    } catch (e) {
      return { ...out, error: /** @type {Error} */ (e).message };
    }
  }
  if (!out.help && !out.version && !out.fingerprint && !out.config) return { ...out, error: '--config is required' };
  if (out.init && out.repair) return { ...out, error: '--init and --repair-state exclude each other' };
  return out;
}

/**
 * Why this process may not write a `--bed-cleared` flag, or null. The running
 * agent must REMOVE a flag to use it (a clearance is used once, then gone), and
 * one written by another user — `sudo … --bed-cleared` — it cannot remove, so
 * it would clear nothing. Only the state directory's owner, the agent's own
 * user, writes it. POSIX only: Windows has no uids.
 */
export function flagWriterProblem(stateDir) {
  if (typeof process.getuid !== 'function') return null;
  let st;
  try {
    st = statSync(stateDir);
  } catch {
    return `the state directory ${stateDir} does not exist yet: start the agent once, then clear the bed`;
  }
  if (st.uid === process.getuid()) return null;
  return `run --bed-cleared as the agent's own user (uid ${st.uid}, the owner of ${stateDir}), e.g. sudo -u <agent user> env $(cat <env file>) node … --bed-cleared <ref>: the agent could not remove a flag another user writes, so it would clear nothing`;
}

/** `--check`: the token, the bindings, one status per configured printer. Sends no telemetry and opens no state. */
async function check(config, log, print) {
  const cloud = new CloudClient({ baseUrl: config.cloud.base_url, token: config.cloud.token, timeoutMs: config.cloud.timeout_ms, attempts: 2, log });
  const rows = await cloud.printers();
  print(`cloud: ${config.cloud.base_url} — token accepted, ${rows.length} printer(s) bound to this agent`);
  for (const row of rows) {
    const entry = config.printers[row.connection_ref ?? ''];
    if (!entry) {
      print(`  ${row.name} (${row.id}) connection_ref=${JSON.stringify(row.connection_ref)}: NOT CONFIGURED locally — no telemetry will be sent for it`);
      continue;
    }
    const driver = createDriver(entry, { log });
    try {
      await driver.connect?.();
      const st = await driver.status();
      print(`  ${row.name} (${row.id}) via ${entry.driver}: ${st.state}${st.file ? `, file ${st.file}` : ''}${row.current_job_id ? `, cloud job ${row.current_job_id}` : ''}`);
    } catch (e) {
      print(`  ${row.name} (${row.id}) via ${entry.driver}: UNREACHABLE — ${/** @type {Error} */ (e).message}`);
    } finally {
      await Promise.resolve(driver.close?.()).catch(() => undefined);
    }
  }
  for (const ref of Object.keys(config.printers)) {
    if (!rows.some((r) => r.connection_ref === ref)) print(`  local entry ${JSON.stringify(ref)}: no cloud printer is bound to this agent with that connection_ref`);
  }
  print(config.slicer ? `slicer: ${config.slicer.kind} at ${config.slicer.cli_path}` : 'slicer: none configured (this agent claims no slicing work)');
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, print?: (s: string) => void, signals?: boolean }} [io]
 */
export async function main(argv, io = {}) {
  const print = io.print ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.error) {
    print(`${args.error}\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (args.help) {
    print(USAGE);
    return EXIT.OK;
  }
  if (args.version) {
    print(VERSION);
    return EXIT.OK;
  }
  if (args.fingerprint) {
    const [host, port] = args.fingerprint.split(':');
    try {
      print(JSON.stringify(await peerFingerprint(host, Number(port || 8883)), null, 2));
      return EXIT.OK;
    } catch (e) {
      print(`no fingerprint: ${/** @type {Error} */ (e).message}`);
      return EXIT.FAILED;
    }
  }
  let config;
  try {
    config = loadConfigFile(/** @type {string} */ (args.config), { env: io.env ?? process.env });
  } catch (e) {
    if (e instanceof ConfigError) {
      print(e.message);
      return EXIT.CONFIG;
    }
    throw e;
  }
  const log = createLogger({ level: config.log.level, secrets: config.secrets });

  if (args.bedCleared !== undefined) {
    if (!config.printers[args.bedCleared]) {
      print(`no printer with connection_ref ${JSON.stringify(args.bedCleared)} in the configuration`);
      return EXIT.USAGE;
    }
    const problem = flagWriterProblem(config.state_dir);
    if (problem) {
      print(problem);
      return EXIT.USAGE;
    }
    // A flag file the running agent consumes; it never takes the agent's lock.
    const dir = join(config.state_dir, 'bed-cleared');
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(join(dir, bedFlagName(args.bedCleared)), `${new Date().toISOString()}\n`);
    print(`bed of ${args.bedCleared} marked clear; the running agent takes it on its next tick if the machine is not printing (log: bed.cleared, or bed.clear_refused)`);
    return EXIT.OK;
  }

  if (args.check) {
    try {
      await check(config, log, print);
      return EXIT.OK;
    } catch (e) {
      print(`check failed: ${/** @type {Error} */ (e).message}`);
      return tokenRejected(e) ? EXIT.NOPERM : EXIT.FAILED;
    }
  }

  let state;
  try {
    state = AgentState.open(config.state_dir, { init: args.init, repair: args.repair });
  } catch (e) {
    if (e instanceof StateError) {
      print(`state refused (${e.code}): ${e.message}`);
      return EXIT.CONFIG;
    }
    throw e;
  }
  const controller = new AbortController();
  const onSignal = (sig) => {
    if (controller.signal.aborted) {
      log.warn('agent.forced_exit', { signal: sig });
      process.exit(130);
    }
    log.info('agent.stopping', { signal: sig });
    controller.abort();
  };
  if (io.signals !== false) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  try {
    const cloud = new CloudClient({ baseUrl: config.cloud.base_url, token: config.cloud.token, timeoutMs: config.cloud.timeout_ms, log });
    const slicer = config.slicer ? createSlicer(config.slicer, { log }) : null;
    const runner = new Runner({ config, cloud, state, log, slicer });
    await runner.start();
    await runner.run(controller.signal);
    return EXIT.OK;
  } catch (e) {
    if (tokenRejected(e)) {
      log.error('agent.token_rejected', { note: 'create a new agent token in the admin console (Print Cloud → agents) and put it in the environment' });
      return EXIT.NOPERM;
    }
    log.error('agent.crashed', { error: e });
    return EXIT.FAILED;
  } finally {
    state.close();
    if (io.signals !== false) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}

/** Run as a program (not imported by a test) — through a symlinked install too: Node runs the real path. */
const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e?.stack ?? e}\n`);
      process.exit(EXIT.FAILED);
    }
  );
}
