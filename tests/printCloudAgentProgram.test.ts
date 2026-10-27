/**
 * THE WORKSHOP AGENT PROGRAM (tools/print-cloud-agent; docs/PRINT_CLOUD_AGENT.md)
 * against the REAL Print Cloud app, in process: the agent's CloudClient is
 * handed a `fetch` that calls the Hono app's own `fetch`, so every request
 * goes through the real routers, guards, state machine and database of
 * tests/fixtures/printCloud.ts. Nothing of the cloud is mocked.
 *
 * What stands in for hardware is local and named: the deterministic
 * simulator driver, a fake slicer CLI (a Node script spawned through the
 * agent's own runCli), small HTTP fakes of OctoPrint and Moonraker, and a
 * fake MQTT broker and FTP server over plain sockets for the Bambu path.
 * None of this proves anything about a real printer or a real slicer
 * binary — docs/PRINT_CLOUD_AGENT.md says exactly that.
 *
 * Proven here:
 *   - telemetry is accepted and ORDERED by (boot, seq): a buffered reading
 *     flushes in order after an outage with its age on one clock; a restart
 *     raises the boot and its seq 0 beats the old run's highest seq; a dead
 *     run's late reading is superseded;
 *   - the boot counter only rises; an unreadable, stale or missing state file
 *     is refused, never reset; the CLI exits 78 on it;
 *   - a whole job: slicing claim → model download → fake slicer → measured
 *     estimate → confirm → scheduler → the agent uploads to the simulator,
 *     starts it, reports started → operator pause / resume commands, each
 *     re-send answered already_applied → completed → the job completes;
 *   - a slicer output without figures is a failure, never an invented number;
 *   - an operator's estimate (no slice of the agent's): the agent asks the job
 *     door what to print, downloads, slices and prints it; a finished bed
 *     waits for `--bed-cleared` (the door's own scope:
 *     tests/printCloudAgentJobDoor.test.ts);
 *   - restarts: mid-print, with a completion pending, and with the state lost
 *     (a job the cloud shows started is never started again); a machine
 *     fault; a job taken back after the start command (the print is stopped);
 *   - MQTT packets round-trip (spec vectors), the MQTT client and the Bambu
 *     driver against a fake broker, FTPS command sequencing, OctoPrint and
 *     Moonraker against HTTP fakes, G-code / 3MF figures, config and logs.
 *
 * Run: node --import tsx --test tests/printCloudAgentProgram.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { ctx } from './fixtures/app';
import { ADMIN, AGENT, API, buy, estimatedJob, idem, ok, pcWorld, readyFile, row, rows, seedCatalog, type Catalog, type Json, type World } from './fixtures/printCloud';
import { main, parseArgs } from '../tools/print-cloud-agent/agent.mjs';
import { ConfigError, normalizeConfig, type AgentConfig } from '../tools/print-cloud-agent/lib/config.mjs';
import { FtpError, ftpsStore, parsePasv } from '../tools/print-cloud-agent/lib/ftps.mjs';
import { createLogger } from '../tools/print-cloud-agent/lib/log.mjs';
import {
  MqttClient,
  PacketReader,
  decodePacket,
  decodeRemainingLength,
  encodeConnack,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePingresp,
  encodePublish,
  encodeRemainingLength,
  encodeSuback,
  encodeSubscribe,
  type MqttPacket,
} from '../tools/print-cloud-agent/lib/mqtt.mjs';
import { CloudClient, CloudError, tokenRejected } from '../tools/print-cloud-agent/lib/protocol.mjs';
import { Runner, bedFlagName, printProjection } from '../tools/print-cloud-agent/lib/runner.mjs';
import { AgentState, StateError } from '../tools/print-cloud-agent/lib/state.mjs';
import { readZip } from '../tools/print-cloud-agent/lib/zip.mjs';
import { amsMapping, createBambu, hmsCode } from '../tools/print-cloud-agent/drivers/bambu.mjs';
import { createMoonraker } from '../tools/print-cloud-agent/drivers/moonraker.mjs';
import { createOctoPrint } from '../tools/print-cloud-agent/drivers/octoprint.mjs';
import { createSimulator, type Simulator } from '../tools/print-cloud-agent/drivers/simulator.mjs';
import { buildEstimate, parseDuration, readPrintFileBytes, scanGcodeText } from '../tools/print-cloud-agent/slicers/gcode.mjs';
import { createSlicer, insertPauses, planSlice, runCli } from '../tools/print-cloud-agent/slicers/index.mjs';
import { orcaArgs, orcaProcessOverrides } from '../tools/print-cloud-agent/slicers/orca.mjs';
import { prusaArgs } from '../tools/print-cloud-agent/slicers/prusa.mjs';

const H = 3600;
const TMP = mkdtempSync(join(tmpdir(), 'pc-agent-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (label: string) => {
  const d = join(TMP, `${label}-${++dirs}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// ---------------------------------------------------------------- the in-process cloud

interface Gate {
  down: boolean;
  bodies: Array<{ path: string; body: Json | null }>;
}

/** The agent's fetch: the Print Cloud app's own `fetch`, in process. `gate.down` simulates a dead network. */
function appFetch(w: World, gate: Gate = { down: false, bodies: [] }) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    if (gate.down) throw new TypeError('fetch failed');
    const url = new URL(input);
    gate.bodies.push({ path: url.pathname, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : null });
    const headers = { ...(init?.headers as Record<string, string>), 'CF-Connecting-IP': '10.0.0.7' };
    return w.guest.fetch(new Request(input, { ...init, headers }), undefined, ctx);
  };
}

async function mintAgent(w: World, capabilities: string[], printerId: string, ref = 'lan-sim-1') {
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Workshop PC', capabilities });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${printerId}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: ref });
  return { id: agent.agent_id as string, token: agent.token as string };
}

// ---------------------------------------------------------------- the fake slicer CLI

/**
 * A stand-in for `orca-slicer`: it checks the argument shape the agent built
 * and writes out/plate_1.gcode with OrcaSlicer's comment lines — or, in
 * «noestimate» mode, a G-code that states no time and no weight.
 */
function fakeOrcaScript(mode: 'ok' | 'noestimate'): string {
  const path = join(TMP, `fake-orca-${mode}.mjs`);
  if (existsSync(path)) return path;
  writeFileSync(
    path,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const a = process.argv.slice(2);
const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const out = get('--outputdir');
const filaments = (get('--load-filaments') || '').split(';').filter(Boolean);
const ids = (get('--load-filament-ids') || '').split(',').filter(Boolean);
const models = a.filter((x) => /\\.(stl|3mf|obj)$/i.test(x));
if (!out || !models.length || models.length !== ids.length || get('--slice') !== '0' || !(get('--load-settings') || '').includes(';')) {
  console.error('bad arguments: ' + a.join(' '));
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const lines = ['; HEADER_BLOCK_START', '; generated by OrcaSlicer 2.3.0 on 2026-10-27 at 10:00:00'];
${mode === 'ok' ? "lines.push('; model printing time: 1m 50s; total estimated time: 2m 0s', '; total layer number: 12');" : ''}
lines.push('; HEADER_BLOCK_END', 'T0');
for (let i = 0; i < 12; i++) lines.push('; CHANGE_LAYER', 'G1 Z' + (0.2 * (i + 1)).toFixed(1));
${
  mode === 'ok'
    ? "lines.push('; filament used [mm] = ' + filaments.map(() => '7816.20').join(', '), '; filament used [g] = ' + filaments.map(() => '23.41').join(', '), '; total layers count = 12', '; estimated printing time (normal mode) = 2m 0s');"
    : "lines.push('; filament used [mm] = ' + filaments.map(() => '7816.20').join(', '));"
}
writeFileSync(join(out, 'plate_1.gcode'), lines.join('\\n') + '\\n');
`
  );
  return path;
}

/** Profiles the slicer configuration points at (the fake CLI only checks they were passed). */
function profilesDir(): string {
  const dir = join(TMP, 'profiles');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'machine.json'), JSON.stringify({ name: 'Bambu Lab X2D 0.4 nozzle', nozzle_diameter: ['0.4'] }));
    writeFileSync(join(dir, 'process.json'), JSON.stringify({ name: '0.20mm Standard', layer_height: '0.2', sparse_infill_density: '15%', wall_loops: '2', support_type: 'normal(auto)' }));
    writeFileSync(join(dir, 'pla.json'), JSON.stringify({ name: 'Generic PLA', filament_density: ['1.24'] }));
  }
  return dir;
}

function agentConfig(token: string, stateDir: string, extra: Record<string, unknown> = {}): AgentConfig {
  return normalizeConfig(
    {
      cloud: { base_url: 'https://levonis-iq.com', token_env: 'TEST_AGENT_TOKEN' },
      state_dir: stateDir,
      intervals: { telemetry_seconds: 10, commands_seconds: 5, printers_seconds: 30, slicing_seconds: 15 },
      jobs: { bed_clear: 'assume_clear', command_max_age_seconds: 3600 },
      printers: { 'lan-sim-1': { driver: 'simulator', print_seconds: 120 } },
      slicer: {
        kind: 'orca',
        // The «binary» must exist for the agent to claim work; the run hook below swaps in the fake script.
        cli_path: process.execPath,
        profiles_dir: profilesDir(),
        timeout_seconds: 60,
        output: 'gcode',
        machines: { 'BBL-X2D-COMBO': { machine: 'machine.json', process: 'process.json', pause_gcode: 'M400 U1' } },
        filaments: { by_material: { PLA: 'pla.json' } },
      },
      ...extra,
    },
    { env: { TEST_AGENT_TOKEN: token }, baseDir: stateDir }
  );
}

interface Agent {
  runner: Runner;
  state: AgentState;
  cloud: CloudClient;
  logs: string[];
  stop: () => Promise<void>;
}

function startAgent(
  w: World,
  config: AgentConfig,
  o: { sim: Simulator; clock: { now: number }; gate?: Gate; slicer?: 'ok' | 'noestimate' | null; logs?: string[] }
): Agent {
  const logs = o.logs ?? [];
  const clock = () => o.clock.now;
  const state = AgentState.open(config.state_dir, { clock });
  const log = createLogger({ level: 'debug', sink: (l) => logs.push(l), clock, secrets: config.secrets });
  const cloud = new CloudClient({ baseUrl: config.cloud.base_url, token: config.cloud.token, fetch: appFetch(w, o.gate), sleep: async () => undefined, clock, log });
  const mode = o.slicer === undefined ? 'ok' : o.slicer;
  const slicer =
    mode && config.slicer
      ? createSlicer(config.slicer, { log, run: (_cmd, args, opts) => runCli(process.execPath, [fakeOrcaScript(mode), ...args], opts) })
      : null;
  const runner = new Runner({ config, cloud, state, log, drivers: { 'lan-sim-1': o.sim }, slicer, clock });
  return {
    runner,
    state,
    cloud,
    logs,
    stop: async () => {
      await runner.stop();
      state.close();
    },
  };
}

/** Advance the agent's clock and run one tick, then let its background work finish. */
async function step(a: Agent, clock: { now: number }, ms: number) {
  clock.now += ms;
  await a.runner.tick();
  await a.runner.settle();
}

const logged = (a: Agent, msg: string) => a.logs.map((l) => JSON.parse(l) as Json).filter((l) => l.msg === msg);
const jobStatus = (w: World, id: string) => row<{ status: string }>(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', id)?.status;

/** A customer job up to `analyzing`: the slicing request waits for a slicer. */
async function analyzedJob(w: World, cat: Catalog, title = 'Bracket'): Promise<{ jobId: string; fileId: string }> {
  const fileId = await readyFile(w, w.a);
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: title, project_type: 'figure' });
  await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, { file_id: fileId, quantity: 1, material_assignments: [{ part: 'default', variant_id: cat.white }] });
  const job = await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, title });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  return { jobId: job.job_id, fileId };
}

async function confirmJob(w: World, jobId: string) {
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  const c = await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
  assert.equal(c.status, 'queued');
}

// ================================================================= telemetry and the boot counter

test('telemetry is accepted and ordered by (boot, seq): an outage flushes in order on one clock, a restart outranks the dead run', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const printer = cat.printers[0];
  const { token } = await mintAgent(w, ['telemetry'], printer);
  const dir = freshDir('telemetry');
  const clock = { now: Date.now() };
  const sim = createSimulator({ print_seconds: 60 }, { clock: () => clock.now });
  const gate: Gate = { down: false, bodies: [] };
  const config = agentConfig(token, dir, { slicer: undefined });
  const first = startAgent(w, config, { sim, clock, gate, slicer: null });
  await first.runner.start();
  await step(first, clock, 0);
  const t1 = row<Json>(w, 'SELECT * FROM pc_printer_telemetry WHERE printer_id = ?', printer)!;
  assert.deepEqual([t1.boot, t1.seq, t1.machine_state, t1.nozzle_temp_dc, t1.bed_temp_dc, t1.agent_id !== null], [1, 0, 'idle', 250, 250, true]);
  const fresh = (await ok(w.assistant, 'GET', `${ADMIN}/printers`)).find((p: Json) => p.id === printer);
  assert.equal(fresh.connectivity, 'online');
  assert.equal(fresh.telemetry.live, true);

  // The network dies: two readings wait in the outbox, in order.
  gate.down = true;
  await step(first, clock, 10_000);
  await step(first, clock, 10_000);
  assert.equal(first.runner.printers.get(printer).outbox.length, 2);
  assert.equal(row<Json>(w, 'SELECT seq FROM pc_printer_telemetry WHERE printer_id = ?', printer)!.seq, 0, 'nothing reached the cloud');
  // It comes back: the buffered readings go first, oldest first, each aged by the agent's one clock.
  gate.down = false;
  gate.bodies.length = 0;
  await step(first, clock, 10_000);
  const sent = gate.bodies.filter((b) => b.path.endsWith('/telemetry')).map((b) => b.body!);
  assert.deepEqual(sent.map((b) => [b.boot, b.seq]), [[1, 1], [1, 2], [1, 3]]);
  assert.deepEqual(sent.map((b) => (Date.parse(b.sent_at) - Date.parse(b.reported_at)) / 1000), [20, 10, 0], 'age = sent_at - reported_at, one clock');
  assert.equal(row<Json>(w, 'SELECT seq FROM pc_printer_telemetry WHERE printer_id = ?', printer)!.seq, 3);
  await first.stop();

  // A restart: the counter rises, so the new run's seq 0 is newer than the old run's seq 3.
  const second = startAgent(w, config, { sim, clock, slicer: null });
  assert.equal(second.state.boot, 2);
  await second.runner.start();
  await step(second, clock, 10_000);
  const t2 = row<Json>(w, 'SELECT boot, seq FROM pc_printer_telemetry WHERE printer_id = ?', printer)!;
  assert.deepEqual([t2.boot, t2.seq], [2, 0]);
  // The dead run's reading, arriving late with a high seq, is superseded and changes nothing.
  const late = await second.cloud.telemetry(printer, { machine_state: 'printing', boot: 1, seq: 999, reported_at: new Date().toISOString() });
  assert.equal(late.superseded, true);
  assert.deepEqual(Object.values(row<Json>(w, 'SELECT boot, seq, machine_state FROM pc_printer_telemetry WHERE printer_id = ?', printer)!), [2, 0, 'idle']);
  await second.stop();
});

test('the boot counter only rises; an unreadable, stale or missing state file is refused — never reset to 0', async () => {
  const dir = freshDir('state');
  const s1 = AgentState.open(dir);
  assert.equal(s1.boot, 1);
  assert.deepEqual([s1.nextSeq(), s1.nextSeq(), s1.nextSeq()], [0, 1, 2]);
  s1.close();
  const s2 = AgentState.open(dir);
  assert.equal(s2.boot, 2);
  assert.equal(s2.nextSeq(), 0, 'seq starts again under the higher boot');
  s2.close();
  const s3 = AgentState.open(dir);
  assert.equal(s3.boot, 3);
  s3.close();
  // Two processes must never share one counter.
  writeFileSync(join(dir, 'agent.lock'), JSON.stringify({ pid: process.ppid, since: new Date().toISOString() }));
  assert.throws(() => AgentState.open(dir), (e: unknown) => e instanceof StateError && e.code === 'STATE_LOCKED');
  rmSync(join(dir, 'agent.lock'));
  const good = readFileSync(join(dir, 'state.json'), 'utf8');
  // Unreadable: refused, and the file is left exactly as found.
  writeFileSync(join(dir, 'state.json'), '{"version":1,"boot":');
  assert.throws(() => AgentState.open(dir), (e: unknown) => e instanceof StateError && e.code === 'STATE_UNREADABLE');
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{"version":1,"boot":', 'nothing was rewritten');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, boot: 'seven' }));
  assert.throws(() => AgentState.open(dir), (e: unknown) => e instanceof StateError && e.code === 'STATE_UNREADABLE');
  // Stale: an older copy (restored from a backup) would make every reading superseded.
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, boot: 1 }));
  assert.throws(() => AgentState.open(dir), (e: unknown) => e instanceof StateError && e.code === 'STATE_STALE' && /journal reached 3/.test(e.message));
  // Missing in a used directory.
  rmSync(join(dir, 'state.json'));
  assert.throws(() => AgentState.open(dir), (e: unknown) => e instanceof StateError && e.code === 'STATE_MISSING');
  // The explicit repair continues from the journal: forwards, never back.
  const s4 = AgentState.open(dir, { repair: true });
  assert.equal(s4.boot, 4);
  s4.close();
  assert.deepEqual(
    readFileSync(join(dir, 'boots.log'), 'utf8').trim().split('\n').map((l) => Number(l.split(' ')[0])),
    [1, 2, 3, 4]
  );
  assert.ok(JSON.parse(good).boot === 3);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'atomic writes leave no temp file');

  // The CLI refuses to start on it, with the configuration-error exit code.
  writeFileSync(join(dir, 'state.json'), 'not json');
  const cfgPath = join(dir, '..', `state-cli-${dirs}.json`);
  writeFileSync(cfgPath, JSON.stringify({ cloud: { base_url: 'https://levonis-iq.com', token_env: 'T' }, state_dir: dir, printers: {} }));
  const out: string[] = [];
  const code = await main(['--config', cfgPath], { env: { T: `pca_${'x'.repeat(40)}` }, print: (s) => out.push(s), signals: false });
  assert.equal(code, 78);
  assert.match(out.join('\n'), /STATE_UNREADABLE/);
});

// ================================================================= a whole job

test('a whole job: claim → download → slice → estimate → queue → upload → start → pause/resume commands (re-sends already_applied) → completed', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: settings.version, config: { agent_reports_need_verification: false } });
  const printer = cat.printers[0];
  const { token } = await mintAgent(w, ['telemetry', 'job_control', 'slicer'], printer);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId, fileId } = await analyzedJob(w, cat);
  assert.equal(jobStatus(w, jobId), 'analyzing');

  const dir = freshDir('job');
  const clock = { now: Date.now() };
  const sim = createSimulator({ print_seconds: 999 }, { clock: () => clock.now });
  const gate: Gate = { down: false, bodies: [] };
  const a = startAgent(w, agentConfig(token, dir), { sim, clock, gate });
  await a.runner.start();

  // ---- 1. The slicing worker: claim, download the customer's model, run the slicer, post what it measured.
  await step(a, clock, 0);
  assert.ok(gate.bodies.some((b) => b.path.endsWith(`/files/${fileId}`)), 'the model came through the job-scoped file door');
  assert.equal(jobStatus(w, jobId), 'ready');
  const est = row<Json>(w, 'SELECT e.* FROM pc_estimates e JOIN pc_print_jobs j ON j.estimate_id = e.id WHERE j.id = ?', jobId)!;
  assert.deepEqual(
    [est.provenance, est.duration_seconds, est.layer_count, est.model_grams, est.slicer_name, est.slicer_version, est.printer_profile],
    ['slicer', 120, 12, 24, 'OrcaSlicer', '2.3.0', 'machine'],
    'the slicer\'s own figures: 2m 0s, 12 layers, 23.41 g rounded up'
  );
  assert.deepEqual(row<Json>(w, 'SELECT status FROM pc_slicing_requests WHERE job_id = ?', jobId), { status: 'succeeded' });
  const manifest = JSON.parse(readFileSync(join(dir, 'prints', jobId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, `lv_${jobId}.gcode`);

  // ---- 2. The customer confirms; the scheduler trusts the printer because the agent's telemetry is fresh.
  await confirmJob(w, jobId);
  const run = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  assert.deepEqual(run.assigned, [{ job_id: jobId, printer_id: printer }]);

  // ---- 3. The agent sees the assignment, checks its slice against the job's input, uploads and starts it.
  await step(a, clock, 30_000);
  assert.deepEqual(sim.uploads.map((u) => u.name), [`lv_${jobId}.gcode`]);
  assert.equal(sim.uploads[0].sha256, manifest.sha256, 'the very file whose figures the customer confirmed');
  assert.equal(sim.snapshot().phase, 'printing');
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'printing');
  const telemetry = row<Json>(w, 'SELECT machine_state, job_id FROM pc_printer_telemetry WHERE printer_id = ?', printer)!;
  assert.deepEqual([telemetry.machine_state, telemetry.job_id], ['printing', jobId]);

  // ---- 4. An operator pauses and resumes through commands; each event is reported once, a re-send changes nothing.
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'pause', job_id: jobId });
  await step(a, clock, 5_000);
  assert.equal(sim.snapshot().phase, 'paused');
  await step(a, clock, 1_000);
  assert.equal(jobStatus(w, jobId), 'paused');
  const record = () => JSON.parse(readFileSync(join(dir, 'jobs', `${jobId}.json`), 'utf8'));
  const paused = record().events.find((e: Json) => e.kind === 'paused');
  assert.equal(paused.body.reason, 'operator_command');
  const again = await a.cloud.jobEvent(jobId, paused.body);
  assert.deepEqual([again.data.already_applied, again.data.status], [true, 'paused']);
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'resume', job_id: jobId });
  await step(a, clock, 5_000);
  await step(a, clock, 1_000);
  assert.equal(jobStatus(w, jobId), 'printing');
  const resumed = record().events.find((e: Json) => e.kind === 'resumed');
  const again2 = await a.cloud.jobEvent(jobId, resumed.body);
  assert.deepEqual([again2.data.already_applied, again2.data.status], [true, 'printing']);
  // The paused event, re-sent after the resume, is still recognised by its id: nothing pauses again.
  assert.equal((await a.cloud.jobEvent(jobId, paused.body)).data.already_applied, true);
  assert.equal(jobStatus(w, jobId), 'printing');
  assert.equal(rows(w, "SELECT 1 FROM pc_print_job_events WHERE job_id = ? AND event = 'paused'", jobId).length, 1);

  // ---- 5. The machine finishes: completed, settled on the printed seconds the machine counted.
  await step(a, clock, 200_000);
  assert.equal(jobStatus(w, jobId), 'completed');
  const consumption = row<Json>(w, 'SELECT reported_by_type, printed_seconds, verified FROM pc_consumption_records WHERE job_id = ?', jobId)!;
  assert.deepEqual([consumption.reported_by_type, consumption.printed_seconds, consumption.verified], ['agent', 120, 1]);
  assert.equal(record().phase, 'done');
  assert.equal(a.runner.jobs.size, 0, 'the record is closed once its events are acknowledged');
  const events = rows<{ event: string; actor_type: string }>(w, 'SELECT event, actor_type FROM pc_print_job_events WHERE job_id = ? ORDER BY rowid', jobId);
  assert.deepEqual(
    events.slice(-4).map((e) => [e.event, e.actor_type]),
    [['started', 'agent'], ['paused', 'agent'], ['resumed', 'agent'], ['completed', 'agent']]
  );
  // Every reading of this run carried boot 1 and a strictly increasing seq.
  const seqs = gate.bodies.filter((b) => b.path.endsWith('/telemetry')).map((b) => b.body!);
  assert.ok(seqs.every((b) => b.boot === 1));
  assert.ok(seqs.every((b, i) => i === 0 || b.seq > seqs[i - 1].seq));
  // The job id is never printed again here, even while the cloud still lists it.
  await step(a, clock, 30_000);
  assert.equal(sim.uploads.length, 1);
  assert.ok(!a.logs.some((l) => l.includes(token)), 'the token never reaches a log line');
  await a.stop();
});

/** A sliced, confirmed job already printing on the simulator under a running agent. */
async function printingJob(opts: { verification?: boolean } = {}) {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: settings.version, config: { agent_reports_need_verification: opts.verification ?? false } });
  const printer = cat.printers[0];
  const { token } = await mintAgent(w, ['telemetry', 'job_control', 'slicer'], printer);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId } = await analyzedJob(w, cat);
  const dir = freshDir('printing');
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const gate: Gate = { down: false, bodies: [] };
  const config = agentConfig(token, dir);
  const a = startAgent(w, config, { sim, clock, gate });
  await a.runner.start();
  await step(a, clock, 0);
  await confirmJob(w, jobId);
  assert.equal((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned.length, 1);
  await step(a, clock, 30_000);
  return { w, cat, printer, token, jobId, dir, clock, sim, gate, config, a };
}

test('a restart mid-print watches on without a second upload; a completion queued before a crash is sent after it, same event_id', async () => {
  const { w, jobId, dir, clock, sim, gate, config, a } = await printingJob();
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'printing');
  await a.stop();

  // Run 2 (boot 2) picks the record up and keeps watching the same print.
  const b = startAgent(w, config, { sim, clock, gate });
  assert.equal(b.state.boot, 2);
  await b.runner.start();
  assert.equal(b.runner.jobs.get(jobId)?.phase, 'printing');
  await step(b, clock, 10_000);
  assert.equal(sim.uploads.length, 1, 'never uploaded or started twice');
  // The machine finishes while the network is down: the completion waits in the record, and the process dies.
  gate.down = true;
  await step(b, clock, 200_000);
  const queued = (JSON.parse(readFileSync(join(dir, 'jobs', `${jobId}.json`), 'utf8')).events as Json[]).find((e) => e.kind === 'completed')!;
  assert.equal(queued.status, 'pending');
  await b.stop();
  assert.equal(jobStatus(w, jobId), 'printing');

  // Run 3 sends it — the same event, decided once, by the run that saw the finish.
  gate.down = false;
  const c = startAgent(w, config, { sim, clock, gate });
  await c.runner.start();
  await step(c, clock, 1_000);
  assert.equal(jobStatus(w, jobId), 'completed');
  const sent = gate.bodies.filter((x) => x.path.endsWith(`/jobs/${jobId}/events`) && x.body?.event === 'completed');
  assert.deepEqual(sent.map((x) => x.body!.event_id), [queued.event_id]);
  assert.equal(sim.uploads.length, 1);
  await c.stop();
});

test('an agent that lost its state never starts a job the cloud shows started; a machine still running the job\'s file is adopted', async () => {
  const { w, jobId, clock, sim, token, a } = await printingJob();
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'printing');
  await a.stop();
  // The state directory is gone AND the machine was reset: the cloud says the job started, so it is not started again.
  const reset = createSimulator({}, { clock: () => clock.now });
  const b = startAgent(w, agentConfig(token, freshDir('lost')), { sim: reset, clock });
  await b.runner.start();
  await step(b, clock, 0);
  assert.equal(reset.uploads.length, 0, 'nothing sliced onto it, nothing uploaded');
  assert.equal(reset.snapshot().phase, 'idle');
  assert.equal(logged(b, 'job.not_started')[0]?.cloud_status, 'printing');
  assert.equal(jobStatus(w, jobId), 'printing', 'the cloud record is left for an operator');
  await b.stop();
  // The state is gone but the machine is still printing the job's file: adopted, and its finish reported.
  const c = startAgent(w, agentConfig(token, freshDir('adopt')), { sim, clock });
  await c.runner.start();
  await step(c, clock, 0);
  await step(c, clock, 200_000);
  assert.equal(sim.uploads.length, 1, 'never sent twice');
  assert.equal(jobStatus(w, jobId), 'completed');
  assert.ok(logged(c, 'job.event_sent').some((e) => e.event === 'started' && e.already_applied === true), 'its started answered already_applied');
  await c.stop();
});

test('a machine fault mid-print is reported failed with the machine\'s own code; the failure waits for an operator to judge it', async () => {
  const { w, printer, jobId, clock, sim, a } = await printingJob();
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'printing');
  clock.now += 30_000;
  sim.fail('HMS_0300_0100_0001_0002', 'Nozzle clog detected');
  await step(a, clock, 0);
  assert.equal(jobStatus(w, jobId), 'failed');
  const failure = row<Json>(w, 'SELECT reason_code, responsible, status, printed_seconds FROM pc_failures WHERE job_id = ?', jobId)!;
  assert.deepEqual([failure.reason_code, failure.responsible, failure.status], ['HMS_0300_0100_0001_0002', 'undetermined', 'reported']);
  assert.ok(failure.printed_seconds >= 30, `printed ${failure.printed_seconds} s as the machine counted them`);
  assert.equal(row<Json>(w, 'SELECT machine_state FROM pc_printer_telemetry WHERE printer_id = ?', printer)!.machine_state, 'error');
  assert.ok(rows<Json>(w, "SELECT detail_json FROM pc_printer_events WHERE printer_id = ? AND kind = 'machine_error'", printer).some((e) => e.detail_json.includes('Nozzle clog')));
  await a.stop();
});

test('a job taken back by an operator after the start command: the cloud refuses started, and the orphan print is stopped', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const printer = cat.printers[0];
  const { token } = await mintAgent(w, ['telemetry', 'job_control', 'slicer'], printer);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId } = await analyzedJob(w, cat);
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const a = startAgent(w, agentConfig(token, freshDir('orphan')), { sim, clock });
  await a.runner.start();
  await step(a, clock, 0);
  await confirmJob(w, jobId);
  await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
  await step(a, clock, 30_000);
  assert.equal(sim.snapshot().phase, 'printing', 'started on the machine');
  // Before the agent reports it, an operator takes the job back to the queue.
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/unassign`, { reason: 'wrong plate' });
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'queued', 'the cloud kept its own decision');
  assert.equal(sim.snapshot().phase, 'cancelled', 'a print that belongs to no job is stopped');
  assert.equal(logged(a, 'job.print_cancelled_not_assigned').length, 1);
  assert.equal(a.runner.jobs.has(jobId), false);
  await a.stop();
});

test('a slicer output that states no time or weight is a FAILURE with a reason — never an invented number', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const { token } = await mintAgent(w, ['telemetry', 'slicer'], cat.printers[0]);
  const { jobId } = await analyzedJob(w, cat);
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const a = startAgent(w, agentConfig(token, freshDir('noestimate')), { sim, clock, slicer: 'noestimate' });
  await a.runner.start();
  await step(a, clock, 0);
  assert.deepEqual(row<Json>(w, 'SELECT status, error_code FROM pc_slicing_requests WHERE job_id = ?', jobId), { status: 'failed', error_code: 'ESTIMATE_INCOMPLETE' });
  assert.equal(jobStatus(w, jobId), 'uploaded', 'back to the customer, told the estimate is unavailable');
  assert.equal(rows(w, 'SELECT 1 FROM pc_estimates WHERE job_id = ?', jobId).length, 0, 'no estimate row: nothing was invented');
  assert.equal(logged(a, 'slicing.failed')[0].error_code, 'ESTIMATE_INCOMPLETE');
  assert.equal(logged(a, 'slicing.result_posted').length, 0);
  await a.stop();
});

test('an operator\'s estimate: the agent asks the job door what to print, slices and prints it; a finished bed waits for --bed-cleared', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: settings.version, config: { agent_reports_need_verification: false } });
  const printer = cat.printers[0];
  const { token } = await mintAgent(w, ['telemetry', 'job_control', 'slicer'], printer);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const one = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }] });
  await confirmJob(w, one.jobId);

  const dir = freshDir('door');
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const gate: Gate = { down: false, bodies: [] };
  const config = agentConfig(token, dir, { jobs: { bed_clear: 'operator', command_max_age_seconds: 3600 } });
  const a = startAgent(w, config, { sim, clock, gate });
  await a.runner.start();
  await step(a, clock, 0);
  assert.equal(logged(a, 'slicing.claimed').length, 0, 'the operator answered the slicing request: nothing to claim');
  // A new agent knows nothing about the bed, so it counts as occupied: the operator clears it, on the workshop PC.
  const cfgPath = join(dir, 'agent.config.json');
  writeFileSync(cfgPath, JSON.stringify({ cloud: { base_url: 'https://levonis-iq.com', token_env: 'TEST_AGENT_TOKEN' }, state_dir: dir, printers: { 'lan-sim-1': { driver: 'simulator' } } }));
  const clearBed = async () => {
    const out: string[] = [];
    assert.equal(await main(['--config', cfgPath, '--bed-cleared', 'lan-sim-1'], { env: { TEST_AGENT_TOKEN: token }, print: (s) => out.push(s), signals: false }), 0, out.join('\n'));
    assert.ok(existsSync(join(dir, 'bed-cleared', bedFlagName('lan-sim-1'))));
  };
  await clearBed();
  await step(a, clock, 1_000);
  assert.equal(logged(a, 'bed.cleared').length, 1);
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: one.jobId, printer_id: printer }]);

  // What the job door states for it (its scope is tested in tests/printCloudAgentJobDoor.test.ts).
  const job = await a.cloud.job(one.jobId);
  assert.deepEqual([job.status, job.printer_id], ['preparing', printer]);

  // No slice of its own: it reads the input, downloads the model through the file door, slices and prints.
  await step(a, clock, 30_000);
  assert.ok(gate.bodies.some((b) => b.path === `${AGENT}/jobs/${one.jobId}`));
  assert.ok(gate.bodies.some((b) => b.path === `${AGENT}/files/${job.input.models[0].file_id}`));
  assert.deepEqual(sim.uploads.map((u) => u.name), [`lv_${one.jobId}.gcode`]);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, one.jobId), 'printing');
  await step(a, clock, 200_000);
  assert.equal(jobStatus(w, one.jobId), 'completed');
  assert.equal(sim.snapshot().phase, 'finished');

  // The next job is placed on the finished machine — the plate is still on the bed, so the agent waits.
  const two = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Second' });
  await confirmJob(w, two.jobId);
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: two.jobId, printer_id: printer }]);
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.equal(sim.uploads.length, 1, 'nothing is put on an occupied bed');
  assert.equal(logged(a, 'job.waiting')[0]?.reason, 'waiting_for_bed_clear');
  assert.equal(jobStatus(w, two.jobId), 'preparing');
  // The operator clears it and says so on the workshop PC.
  await clearBed();
  await step(a, clock, 1_000);
  assert.deepEqual(sim.uploads.map((u) => u.name), [`lv_${one.jobId}.gcode`, `lv_${two.jobId}.gcode`]);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, two.jobId), 'printing');
  await a.stop();
});

test('commands: history before the first run is skipped, a stale or foreign one is not executed, a light command reaches the machine', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const printer = cat.printers[0];
  const { token } = await mintAgent(w, ['telemetry', 'job_control'], printer);
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'stop' });
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const a = startAgent(w, agentConfig(token, freshDir('commands'), { slicer: undefined }), { sim, clock, slicer: null });
  await a.runner.start();
  await step(a, clock, 0);
  assert.equal(logged(a, 'commands.history_skipped')[0]?.count, 1, 'a stop queued before the agent existed is history');
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'light_on' });
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'pause', job_id: 'pcj_not_here' });
  await step(a, clock, 5_000);
  assert.deepEqual(sim.lights, [true]);
  // Two commands queued in one millisecond come back in id order (`ORDER BY created_at, id`): compare without order.
  const handled = logged(a, 'command.handled');
  assert.deepEqual(handled.map((h) => [h.command, h.outcome, h.reason ?? null]).sort(), [['light_on', 'executed', null], ['pause', 'skipped', 'job_not_running_here']]);
  // A command older than the configured age is not executed, however it arrives.
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'light_off' });
  clock.now += 2 * H * 1000;
  await step(a, clock, 5_000);
  assert.equal(logged(a, 'command.handled').at(-1)!.reason, 'expired');
  assert.deepEqual(sim.lights, [true]);
  // Each command once: polling again executes nothing.
  await step(a, clock, 5_000);
  assert.equal(logged(a, 'command.handled').length, 3);
  await a.stop();
});

// ================================================================= the cloud client

test('the cloud client retries outages (network, 5xx, 429 with Retry-After, STATE_CHANGED on telemetry) and nothing else', async () => {
  const waits: number[] = [];
  let calls = 0;
  const reply = (status: number, body: Json, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const script: Array<() => Response | Promise<Response>> = [];
  const client = new CloudClient({
    baseUrl: 'https://levonis-iq.com',
    token: `pca_${'t'.repeat(40)}`,
    fetch: async (input, init) => {
      calls++;
      assert.equal(new URL(input).origin, 'https://levonis-iq.com');
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer pca_${'t'.repeat(40)}`);
      const next = script.shift();
      if (!next) throw new Error('unexpected request');
      return next();
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 1,
  });
  const fail = () => {
    throw new TypeError('fetch failed');
  };
  script.push(fail, () => reply(502, { code: 'X' }), () => reply(200, { success: true, data: [{ id: 'p1' }] }));
  assert.deepEqual(await client.printers(), [{ id: 'p1' }]);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000], 'exponential backoff');
  waits.length = 0;
  script.push(() => reply(429, { code: 'RATE_LIMITED' }, { 'retry-after': '2' }), () => reply(200, { success: true, data: null }));
  assert.equal(await client.claimSlicing(), null);
  assert.deepEqual(waits, [2000], 'Retry-After honoured');
  // A 4xx is an answer: once, no retry.
  calls = 0;
  script.push(() => reply(400, { code: 'VALIDATION', details: { field: 'boot' } }));
  await assert.rejects(client.telemetry('p1', { machine_state: 'idle' }), (e: unknown) => e instanceof CloudError && e.code === 'VALIDATION' && !e.retryable);
  assert.equal(calls, 1);
  // STATE_CHANGED: «try again» on telemetry, but on a slicing answer it means «no longer yours».
  script.push(() => reply(409, { code: 'STATE_CHANGED' }), () => reply(200, { success: true, data: { stored: true, mismatch: false } }));
  assert.deepEqual(await client.telemetry('p1', () => ({ machine_state: 'idle' })), { stored: true, mismatch: false });
  calls = 0;
  script.push(() => reply(409, { code: 'STATE_CHANGED', details: { status: 'succeeded' } }));
  await assert.rejects(client.slicingResult('r1', {}), (e: unknown) => e instanceof CloudError && e.code === 'STATE_CHANGED');
  assert.equal(calls, 1);
  // The token never follows a path outside the agent API.
  await assert.rejects(client.downloadFile('/api/admin/print-cloud/settings'), (e: unknown) => e instanceof CloudError && !e.retryable);
  // Exhausted retries surface as a retryable error the caller keeps in its outbox.
  script.push(fail, fail, fail, fail, fail);
  await assert.rejects(client.printers(), (e: unknown) => e instanceof CloudError && e.retryable && e.status === 0);
  // The job door on a cloud that predates it: the request falls through to another router (404, or that
  // router's own 401) — «no input stated», not «token revoked». Only AGENT_UNAUTHORIZED is the token.
  script.push(() => reply(404, { code: 'NOT_FOUND' }), () => reply(401, { code: 'UNAUTHORIZED', error: 'Authentication required' }), () => reply(401, { code: 'AGENT_UNAUTHORIZED' }));
  assert.equal(await client.job('pcj_1'), null);
  assert.equal(await client.job('pcj_1'), null);
  await assert.rejects(client.job('pcj_1'), (e: unknown) => tokenRejected(e));
  assert.equal(tokenRejected(new CloudError({ status: 401, code: 'UNAUTHORIZED', retryable: false })), false);
});

// ================================================================= MQTT, FTPS, Bambu

test('MQTT 3.1.1 packets: the remaining-length table of §2.2.3, exact CONNECT / SUBSCRIBE bytes, and round trips of every packet', () => {
  const table: Array<[number, number[]]> = [
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16_383, [0xff, 0x7f]],
    [16_384, [0x80, 0x80, 0x01]],
    [2_097_151, [0xff, 0xff, 0x7f]],
    [2_097_152, [0x80, 0x80, 0x80, 0x01]],
    [268_435_455, [0xff, 0xff, 0xff, 0x7f]],
  ];
  for (const [n, bytes] of table) {
    assert.deepEqual([...encodeRemainingLength(n)], bytes, String(n));
    assert.deepEqual(decodeRemainingLength(Buffer.from(bytes)), { value: n, bytes: bytes.length });
    if (bytes.length > 1) assert.equal(decodeRemainingLength(Buffer.from(bytes.slice(0, -1))), null, 'incomplete');
  }
  assert.throws(() => encodeRemainingLength(268_435_456));
  assert.throws(() => decodeRemainingLength(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01])), /four bytes/);

  const connect = encodeConnect({ clientId: 'c1', username: 'bblp', password: '12345678', keepalive: 30 });
  assert.deepEqual(
    [...connect],
    [0x10, 30, 0, 4, 77, 81, 84, 84, 4, 0xc2, 0, 30, 0, 2, 99, 49, 0, 4, 98, 98, 108, 112, 0, 8, 49, 50, 51, 52, 53, 54, 55, 56]
  );
  assert.deepEqual([...encodeSubscribe({ packetId: 1, topics: [{ topic: 'a/b', qos: 0 }] })], [0x82, 8, 0, 1, 0, 3, 97, 47, 98, 0]);
  assert.deepEqual([...encodeConnack()], [0x20, 2, 0, 0]);
  assert.deepEqual([...encodePingreq()], [0xc0, 0]);
  assert.deepEqual([...encodePingresp()], [0xd0, 0]);
  assert.deepEqual([...encodeDisconnect()], [0xe0, 0]);
  assert.deepEqual([...encodePublish({ topic: 't', payload: 'hi' })], [0x30, 5, 0, 1, 116, 104, 105]);

  const decoded = (b: Buffer) => {
    const d = decodePacket(b);
    assert.ok(d);
    assert.equal(d.length, b.length);
    return d.packet;
  };
  assert.deepEqual(decoded(connect), { type: 'connect', clientId: 'c1', username: 'bblp', password: '12345678', keepalive: 30, clean: true });
  assert.deepEqual(decoded(encodeSubscribe({ packetId: 7, topics: [{ topic: 'device/SN/report', qos: 1 }] })), { type: 'subscribe', packetId: 7, topics: [{ topic: 'device/SN/report', qos: 1 }] });
  assert.deepEqual(decoded(encodeSuback({ packetId: 7, granted: [0] })), { type: 'suback', packetId: 7, granted: [0] });
  assert.deepEqual(decoded(encodeConnack({ sessionPresent: true, returnCode: 5 })), { type: 'connack', sessionPresent: true, returnCode: 5 });
  const pub1 = decoded(encodePublish({ topic: 'x/y', payload: Buffer.from([1, 2, 3]), qos: 1, packetId: 513, retain: true })) as Extract<MqttPacket, { type: 'publish' }>;
  assert.deepEqual([pub1.topic, pub1.qos, pub1.packetId, pub1.retain, [...pub1.payload]], ['x/y', 1, 513, true, [1, 2, 3]]);
  assert.deepEqual(decoded(encodePingreq()), { type: 'pingreq' });
  assert.deepEqual(decoded(encodeDisconnect()), { type: 'disconnect' });
  // A 200 KB report (a three-byte remaining length) split into 7-byte TCP chunks reassembles exactly.
  const big = Buffer.alloc(200_000, 0x61);
  const stream = Buffer.concat([encodePublish({ topic: 'device/SN/report', payload: big }), encodePingresp()]);
  const reader = new PacketReader();
  const got: MqttPacket[] = [];
  for (let i = 0; i < stream.length; i += 7) got.push(...reader.push(stream.subarray(i, i + 7)));
  assert.equal(got.length, 2);
  assert.equal(Buffer.compare((got[0] as Extract<MqttPacket, { type: 'publish' }>).payload, big), 0);
  assert.equal(got[1].type, 'pingresp');
  assert.throws(() => decodePacket(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x01]), 1024), /exceeds/);
});

/** A fake FTP server over plain sockets: records the commands, stores what STOR sends. */
async function fakeFtp(opts: { password: string }) {
  const commands: string[] = [];
  let stored: Buffer | null = null;
  let control: net.Socket | null = null;
  const data = net.createServer((sock) => {
    const chunks: Buffer[] = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      stored = Buffer.concat(chunks);
      sock.end();
      control?.write('226 Transfer complete\r\n');
    });
  });
  await new Promise<void>((r) => data.listen(0, '127.0.0.1', r));
  const dataPort = (data.address() as net.AddressInfo).port;
  const server = net.createServer((sock) => {
    control = sock;
    sock.write('220-Bambu Lab FTP\r\n220 ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        commands.push(line.startsWith('PASS ') ? `PASS ${line.slice(5) === opts.password ? '<ok>' : '<wrong>'}` : line);
        const [verb] = line.split(' ');
        if (verb === 'USER') sock.write('331 password required\r\n');
        else if (verb === 'PASS') sock.write(line.slice(5) === opts.password ? '230 logged in\r\n' : '530 login incorrect\r\n');
        else if (verb === 'PBSZ' || verb === 'PROT' || verb === 'TYPE') sock.write('200 ok\r\n');
        else if (verb === 'PASV') sock.write(`227 Entering Passive Mode (10,9,8,7,${dataPort >> 8},${dataPort & 255}).\r\n`);
        else if (verb === 'STOR') sock.write('150 Opening BINARY data connection\r\n');
        else if (verb === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('502 not implemented\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    commands,
    stored: () => stored,
    close: () => {
      server.close();
      data.close();
    },
  };
}

const plainConnect = ({ port }: { port: number }) =>
  new Promise<net.Socket>((resolve, reject) => {
    // The PASV answer announces 10.9.8.7: the client must use the CONTROL host instead.
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });

test('FTPS: USER → PASS → PBSZ 0 → PROT P → TYPE I → PASV → STOR → QUIT, the bytes intact, the code never in the transcript', async () => {
  assert.deepEqual(parsePasv('227 Entering Passive Mode (192,168,1,5,195,80).'), { host: '192.168.1.5', port: 50_000 });
  assert.throws(() => parsePasv('227 nothing here'), FtpError);
  const ftp = await fakeFtp({ password: 'lan-code-1234' });
  try {
    const data = Buffer.from('; generated by OrcaSlicer 2.3.0\nG28\n'.repeat(500));
    const secured: string[] = [];
    const r = await ftpsStore({
      host: '127.0.0.1',
      port: ftp.port,
      user: 'bblp',
      password: 'lan-code-1234',
      remoteName: 'lv_pcj_1.gcode',
      data,
      connect: plainConnect,
      secure: async (s, p) => {
        secured.push(p.purpose);
        return s;
      },
    });
    assert.deepEqual(ftp.commands, ['USER bblp', 'PASS <ok>', 'PBSZ 0', 'PROT P', 'TYPE I', 'PASV', 'STOR lv_pcj_1.gcode', 'QUIT']);
    assert.deepEqual(secured, ['control', 'data'], 'implicit TLS on the control channel, PROT P on the data channel');
    assert.equal(Buffer.compare(ftp.stored()!, data), 0);
    assert.equal(r.bytes, data.length);
    assert.ok(r.transcript.includes('-> PASS ****') && !r.transcript.join(' ').includes('lan-code-1234'));
    // A wrong access code stops at PASS: nothing is stored.
    const before = ftp.commands.length;
    await assert.rejects(
      ftpsStore({ host: '127.0.0.1', port: ftp.port, user: 'bblp', password: 'wrong', remoteName: 'lv_pcj_2.gcode', data, connect: plainConnect, secure: async (s) => s }),
      (e: unknown) => e instanceof FtpError && e.code === 530
    );
    assert.deepEqual(ftp.commands.slice(before), ['USER bblp', 'PASS <wrong>']);
    await assert.rejects(ftpsStore({ host: '127.0.0.1', user: 'bblp', password: 'x', remoteName: '../etc/passwd', data, secure: async (s) => s }), FtpError);
  } finally {
    ftp.close();
  }
});

/** A fake Bambu printer's MQTT side: CONNACK, SUBACK, a report after pushall, and every request recorded. */
async function fakeBroker(report: Json) {
  const packets: MqttPacket[] = [];
  const requests: Json[] = [];
  const clients: net.Socket[] = [];
  const server = net.createServer((sock) => {
    clients.push(sock);
    const reader = new PacketReader();
    sock.on('data', (d) => {
      for (const p of reader.push(d)) {
        packets.push(p);
        if (p.type === 'connect') sock.write(encodeConnack({ returnCode: p.username === 'bblp' && p.password === 'abcd1234' ? 0 : 4 }));
        else if (p.type === 'subscribe') sock.write(encodeSuback({ packetId: p.packetId, granted: p.topics.map(() => 0) }));
        else if (p.type === 'pingreq') sock.write(encodePingresp());
        else if (p.type === 'publish') {
          const body = JSON.parse(p.payload.toString()) as Json;
          requests.push(body);
          if (body.pushing?.command === 'pushall') sock.write(encodePublish({ topic: 'device/SN0001/report', payload: { print: report } }));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    packets,
    requests,
    push: (print: Json) => clients.forEach((c) => c.write(encodePublish({ topic: 'device/SN0001/report', payload: { print } }))),
    close: () => {
      clients.forEach((c) => c.destroy());
      server.close();
    },
  };
}

/** Wait for a socket peer to have done something — generous, so a loaded CI machine does not fail it. */
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), what);
};

test('Bambu LAN driver against a fake broker and FTP server: report → status, AMS mapping, project_file, pause / resume / stop', async () => {
  assert.equal(hmsCode({ attr: 0x03000100, code: 0x00010002 }), 'HMS_0300_0100_0001_0002');
  const report = {
    gcode_state: 'RUNNING',
    mc_percent: 42,
    mc_remaining_time: 13,
    layer_num: 5,
    total_layer_num: 100,
    nozzle_temper: 219.6,
    bed_temper: 55,
    chamber_temper: 31,
    subtask_name: 'lv_pcj_7',
    print_error: 0,
    hms: [{ attr: 0x03000100, code: 0x00010002 }],
    ipcam: { ipcam_dev: '1', resolution: '1080p' },
    ams: { ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PETG', tray_color: 'FF0000FF', remain: 80 }, { id: '1', tray_type: 'PLA', tray_color: '000000FF', remain: -1 }, { id: '2', tray_type: 'PLA', tray_color: 'F5F7F9FF', remain: 55 }] }] },
  };
  const broker = await fakeBroker(report);
  const ftp = await fakeFtp({ password: 'abcd1234' });
  const driver = createBambu(
    { host: '127.0.0.1', serial: 'SN0001', access_code: 'abcd1234', tls: { mode: 'insecure' }, chamber_sensor: true },
    {
      connectMqtt: () => plainConnect({ port: broker.port }),
      ftpsConnect: (p) => plainConnect({ port: p.purpose === 'control' ? ftp.port : p.port }),
      ftpsSecure: async (s) => s,
    }
  );
  try {
    await driver.connect!();
    await until(() => driver.debugReport().report !== null, 'the pushall answer arrived');
    const connect = broker.packets.find((p) => p.type === 'connect') as Extract<MqttPacket, { type: 'connect' }>;
    assert.deepEqual([connect.username, connect.password], ['bblp', 'abcd1234']);
    assert.deepEqual((broker.packets.find((p) => p.type === 'subscribe') as Extract<MqttPacket, { type: 'subscribe' }>).topics, [{ topic: 'device/SN0001/report', qos: 0 }]);
    assert.equal(broker.requests[0].pushing.command, 'pushall');
    const st = await driver.status();
    assert.deepEqual(
      [st.state, st.file, st.progress_permille, st.remaining_seconds, st.layer, st.total_layers, st.nozzle_c, st.bed_c, st.chamber_c],
      ['printing', 'lv_pcj_7', 420, 780, 5, 100, 219.6, 55, 31]
    );
    assert.deepEqual(st.errors, [{ code: 'HMS_0300_0100_0001_0002', message: '' }]);
    assert.deepEqual(st.camera, { available: true, resolution: '1080p' });
    assert.deepEqual(st.ams, [
      { slot: 0, material: 'PETG', color_hex: '#FF0000', remain_percent: 80 },
      { slot: 1, material: 'PLA', color_hex: '#000000', remain_percent: null },
      { slot: 2, material: 'PLA', color_hex: '#F5F7F9', remain_percent: 55 },
    ]);
    // Reports after the first are incremental: merged, not replaced.
    broker.push({ mc_percent: 50, gcode_state: 'PAUSE' });
    await until(() => driver.debugReport().report.mc_percent === 50, 'the increment arrived');
    const st2 = await driver.status();
    assert.deepEqual([st2.state, st2.progress_permille, st2.layer], ['paused', 500, 5]);
    // A stop reads as cancelled, not as a fault.
    broker.push({ gcode_state: 'FAILED', print_error: 0x0300400c });
    await until(() => driver.debugReport().report.gcode_state === 'FAILED', 'the stop arrived');
    assert.equal((await driver.status()).state, 'cancelled');

    // Upload through FTPS, then print it with the job's PLA white mapped to tray 3.
    const bytes = Buffer.from('PK fake gcode.3mf bytes');
    await driver.upload({ name: 'lv_pcj_7.gcode.3mf', bytes });
    assert.ok(ftp.commands.includes('STOR lv_pcj_7.gcode.3mf'));
    const variants = [{ variant_id: 'v-white', material: 'PLA', color_hex: '#F4F7FA' }];
    assert.deepEqual(amsMapping(variants, st.ams!), { mapping: [2] });
    await driver.start({ name: 'lv_pcj_7.gcode.3mf', job: { variants } });
    await until(() => broker.requests.some((r) => r.print?.command === 'project_file'), 'project_file published');
    const pf = broker.requests.find((r) => r.print?.command === 'project_file')!.print;
    assert.deepEqual(
      [pf.param, pf.url, pf.subtask_name, pf.md5, pf.use_ams, pf.ams_mapping],
      ['Metadata/plate_1.gcode', 'file:///sdcard/lv_pcj_7.gcode.3mf', 'lv_pcj_7', createHash('md5').update(bytes).digest('hex'), true, [2]]
    );
    // Material not loaded: the print is NOT started.
    const before = broker.requests.length;
    await assert.rejects(driver.start({ name: 'lv_pcj_7.gcode.3mf', job: { variants: [{ variant_id: 'v-gold', material: 'PLA', color_hex: '#D4AF37' }] } }), /material not loaded/);
    await driver.pause();
    await driver.resume();
    await driver.cancel();
    await until(() => broker.requests.length >= before + 3, 'the three commands arrived');
    assert.deepEqual(broker.requests.slice(before).map((r) => r.print.command), ['pause', 'resume', 'stop']);
  } finally {
    await driver.close();
    broker.close();
    ftp.close();
  }
});

test('the MQTT client refuses a broker that refuses the credentials', async () => {
  const broker = await fakeBroker({});
  try {
    const c = new MqttClient({ connect: () => plainConnect({ port: broker.port }), clientId: 'x', username: 'bblp', password: 'wrong', keepaliveSeconds: 0 });
    await assert.rejects(c.open(), /bad user name or password/);
  } finally {
    broker.close();
  }
});

// ================================================================= OctoPrint and Moonraker

interface Seen {
  method: string;
  url: string;
  key: string | undefined;
  body: Buffer;
  type: string | undefined;
}

async function httpFake(handler: (req: Seen) => { status: number; json?: unknown } | Promise<{ status: number; json?: unknown }>) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const s: Seen = { method: req.method!, url: req.url!, key: req.headers['x-api-key'] as string | undefined, body: Buffer.concat(chunks), type: req.headers['content-type'] };
      seen.push(s);
      const r = await handler(s);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen, close: () => server.close() };
}

/**
 * THE DRIVERS' TRANSPORT, GIVEN EXPLICITLY. `npm run test:unit` preloads
 * scripts/test-no-network.mjs, which replaces `globalThis.fetch` with a
 * refusal, so a driver left on the global fetch never reaches the fake above
 * (CI shard 12 said exactly that). This is a fetch over node:http that only
 * dials the loopback fakes; the multipart body is serialized by the platform's
 * own Request, so what the fake receives is what fetch would have sent.
 */
async function localFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') throw new Error(`the test transport only dials the loopback fakes, not ${url.host}`);
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  let body: Buffer | undefined;
  if (init.body !== undefined && init.body !== null) {
    const encoded = new Request(url, { method, headers, body: init.body });
    body = Buffer.from(await encoded.arrayBuffer());
    const type = encoded.headers.get('content-type');
    if (type) headers.set('content-type', type);
  }
  const outgoing: Record<string, string> = {};
  headers.forEach((value, name) => {
    outgoing[name] = value;
  });
  return new Promise<Response>((resolve, reject) => {
    const req = http.request(url, { method, headers: outgoing }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 500;
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out.set(k, v);
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: out }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    init.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    if (body) req.write(body);
    req.end();
  });
}

const formOf = async (s: Seen) => new Response(s.body, { headers: { 'content-type': s.type ?? '' } }).formData();

test('OctoPrint driver against an HTTP fake: X-Api-Key, multipart upload, select + start, the job states read honestly', async () => {
  let job: Json = { state: 'Operational', job: { file: { name: null } }, progress: { completion: null, printTime: null, printTimeLeft: null } };
  let printer: { status: number; json?: unknown } = { status: 200, json: { temperature: { tool0: { actual: 214.8 }, bed: { actual: 60.1 } }, state: { text: 'Operational' } } };
  const fake = await httpFake(async (s) => {
    if (s.method === 'GET' && s.url === '/api/job') return { status: 200, json: job };
    if (s.method === 'GET' && s.url.startsWith('/api/printer')) return printer;
    if (s.method === 'POST' && s.url === '/api/files/local') {
      const form = await formOf(s);
      const file = form.get('file') as File;
      job = { ...job, job: { file: { name: file.name } } };
      return { status: 201, json: { done: true, files: { local: { name: file.name } } } };
    }
    if (s.method === 'POST' && s.url === '/api/job') return { status: 204 };
    return { status: 404, json: { error: 'no' } };
  });
  try {
    const d = createOctoPrint({ base_url: fake.url, api_key: 'octo-key-123' }, { fetch: localFetch });
    assert.equal((await d.status()).state, 'idle');
    await d.upload({ name: 'lv_pcj_9.gcode', bytes: Buffer.from('G28\nG1 X10\n') });
    const up = fake.seen.find((s) => s.url === '/api/files/local')!;
    const form = await formOf(up);
    assert.equal((form.get('file') as File).name, 'lv_pcj_9.gcode');
    assert.equal(Buffer.from(await (form.get('file') as File).arrayBuffer()).toString(), 'G28\nG1 X10\n');
    assert.equal(form.get('select'), 'true');
    await d.start({ name: 'lv_pcj_9.gcode' });
    assert.deepEqual(JSON.parse(fake.seen.filter((s) => s.url === '/api/job' && s.method === 'POST').at(-1)!.body.toString()), { command: 'start' });
    assert.ok(fake.seen.every((s) => s.key === 'octo-key-123'), 'every request carries the key');
    job = { state: 'Printing', job: { file: { name: 'lv_pcj_9.gcode' } }, progress: { completion: 42.5, printTime: 600, printTimeLeft: 812 } };
    const st = await d.status();
    assert.deepEqual([st.state, st.file, st.progress_permille, st.elapsed_seconds, st.remaining_seconds, st.nozzle_c, st.bed_c, st.layer], ['printing', 'lv_pcj_9.gcode', 425, 600, 812, 214.8, 60.1, null]);
    await d.pause();
    await d.resume();
    await d.cancel();
    assert.deepEqual(
      fake.seen.filter((s) => s.url === '/api/job' && s.method === 'POST').slice(-3).map((s) => JSON.parse(s.body.toString())),
      [{ command: 'pause', action: 'pause' }, { command: 'pause', action: 'resume' }, { command: 'cancel' }]
    );
    job = { state: 'Paused', job: { file: { name: 'lv_pcj_9.gcode' } }, progress: { completion: 50, printTime: 700 } };
    assert.equal((await d.status()).state, 'paused');
    job = { state: 'Operational', job: { file: { name: 'lv_pcj_9.gcode' } }, progress: { completion: 100, printTime: 1400 } };
    assert.equal((await d.status()).state, 'finished');
    job = { state: 'Operational', job: { file: { name: 'lv_pcj_9.gcode' } }, progress: { completion: 45, printTime: 640 } };
    assert.equal((await d.status()).state, 'cancelled');
    job = { state: 'Error', job: { file: { name: null } }, progress: {} };
    printer = { status: 200, json: { temperature: {}, state: { text: 'Error', error: 'Thermal Runaway' } } };
    assert.deepEqual((await d.status()).errors, [{ code: 'OCTOPRINT_ERROR', message: 'Thermal Runaway' }]);
    job = { state: 'Offline', job: { file: { name: null } }, progress: {} };
    printer = { status: 409, json: { error: 'Printer is not operational' } };
    assert.equal((await d.status()).state, 'offline', 'OctoPrint up, printer disconnected: offline, not idle');
  } finally {
    fake.close();
  }
  // OctoPrint itself gone: the driver says unreachable (the runner reports offline).
  const gone = createOctoPrint({ base_url: 'http://127.0.0.1:9', api_key: 'k', timeout_seconds: 2 }, { fetch: localFetch });
  await assert.rejects(gone.status(), (e: unknown) => (e as { code?: string }).code === 'UNREACHABLE');
});

test('Moonraker driver against an HTTP fake: objects query, slicer-estimate remaining time, multipart upload, print controls', async () => {
  let stats: Json = { state: 'standby', filename: '', print_duration: 0, info: { current_layer: null, total_layer: null } };
  let klippy = 'ready';
  const fake = await httpFake(async (s) => {
    if (s.url.startsWith('/printer/objects/query')) {
      if (klippy !== 'ready') return { status: 503, json: { error: { message: 'Klippy not ready' } } };
      return { status: 200, json: { result: { status: { print_stats: stats, virtual_sdcard: { progress: 0.315 }, heater_bed: { temperature: 59.9 }, extruder: { temperature: 239.7 } } } } };
    }
    if (s.url === '/printer/info') return { status: 200, json: { result: { state: klippy, state_message: 'MCU shutdown' } } };
    if (s.url.startsWith('/server/files/metadata')) return { status: 200, json: { result: { estimated_time: 3600 } } };
    if (s.url === '/server/files/upload') return { status: 201, json: { item: { path: 'lv_pcj_5.gcode', root: 'gcodes' } } };
    if (s.url.startsWith('/printer/print/')) return { status: 200, json: { result: 'ok' } };
    return { status: 404 };
  });
  try {
    const d = createMoonraker({ base_url: fake.url, api_key: 'moon-key' }, { fetch: localFetch });
    assert.equal((await d.status()).state, 'idle');
    await d.upload({ name: 'lv_pcj_5.gcode', bytes: Buffer.from('G28\n') });
    const form = await formOf(fake.seen.find((s) => s.url === '/server/files/upload')!);
    assert.deepEqual([(form.get('file') as File).name, form.get('root')], ['lv_pcj_5.gcode', 'gcodes']);
    await d.start({ name: 'lv_pcj_5.gcode' });
    await d.pause();
    await d.resume();
    await d.cancel();
    assert.deepEqual(fake.seen.filter((s) => s.url.startsWith('/printer/print/')).map((s) => [s.method, s.url]), [
      ['POST', '/printer/print/start?filename=lv_pcj_5.gcode'],
      ['POST', '/printer/print/pause'],
      ['POST', '/printer/print/resume'],
      ['POST', '/printer/print/cancel'],
    ]);
    stats = { state: 'printing', filename: 'lv_pcj_5.gcode', print_duration: 1000, info: { current_layer: 7, total_layer: 60 } };
    const st = await d.status();
    assert.deepEqual([st.state, st.file, st.progress_permille, st.elapsed_seconds, st.remaining_seconds, st.layer, st.total_layers, st.nozzle_c, st.bed_c], ['printing', 'lv_pcj_5.gcode', 315, 1000, 2600, 7, 60, 239.7, 59.9]);
    assert.ok(fake.seen.every((s) => s.key === 'moon-key'));
    stats = { ...stats, state: 'complete' };
    assert.equal((await d.status()).state, 'finished');
    stats = { ...stats, state: 'error', message: 'Heater extruder not heating at expected rate' };
    assert.deepEqual((await d.status()).errors, [{ code: 'KLIPPER_ERROR', message: 'Heater extruder not heating at expected rate' }]);
    klippy = 'shutdown';
    const down = await d.status();
    assert.deepEqual([down.state, down.errors[0].code], ['error', 'KLIPPY_SHUTDOWN']);
  } finally {
    fake.close();
  }
});

// ================================================================= the slicer's figures

test('slicer figures are read from the produced file — G-code comments and a .gcode.3mf — and a missing figure is a failure', () => {
  assert.deepEqual(['1d 2h 3m 4s', '2h 5m', '45s', '1h 0m 0s', 'n/a', '', '12:30', '3mm'].map(parseDuration), [93_784, 7_500, 45, 3_600, null, null, null, null]);
  const orcaText = [
    '; HEADER_BLOCK_START',
    '; generated by OrcaSlicer 2.1.1 on 2024-07-21 at 10:00:00',
    '; model printing time: 1h 2m 3s; total estimated time: 1h 10m 5s',
    '; total layer number: 150',
    '; HEADER_BLOCK_END',
    'T0',
    '; CHANGE_LAYER',
    'T1',
    '; CHANGE_LAYER',
    'T0',
    '; filament used [mm] = 1234.56, 401.00',
    '; filament used [g] = 3.68, 1.20',
  ].join('\n');
  const orca = scanGcodeText(orcaText);
  assert.deepEqual([orca.generator, orca.total_seconds, orca.model_seconds, orca.layers_declared, orca.layer_changes, orca.grams, orca.tool_changes], [{ name: 'OrcaSlicer', version: '2.1.1' }, 4205, 3723, 150, 2, [3.68, 1.2], 2]);
  const slots = [{ variant_id: 'v-white' }, { variant_id: 'v-black' }];
  const built = buildEstimate({ meta: orca, sliceInfo: null, slots, slicerLabel: 'OrcaSlicer', printerProfile: 'X2D 0.4' });
  assert.ok(built.ok);
  assert.deepEqual(
    [built.estimate.duration_seconds, built.estimate.layer_count, built.estimate.color_changes, built.estimate.materials],
    [4205, 150, 2, [{ variant_id: 'v-white', model_grams: 4 }, { variant_id: 'v-black', model_grams: 2 }]]
  );
  const prusa = scanGcodeText(['; generated by PrusaSlicer 2.7.1+linux-x64-GTK3 on 2024-01-01 at 12:00:00 UTC', ';LAYER_CHANGE', ';Z:0.2', ';LAYER_CHANGE', ';Z:0.4', '; filament used [g] = 12.00', '; estimated printing time (normal mode) = 2h 5m 10s'].join('\n'));
  assert.deepEqual([prusa.generator?.name, prusa.normal_seconds, prusa.layer_changes, prusa.layers_declared], ['PrusaSlicer', 7510, 2, null]);
  const p = buildEstimate({ meta: prusa, sliceInfo: null, slots: [{ variant_id: 'v' }], slicerLabel: 'PrusaSlicer', printerProfile: 'MK4' });
  assert.ok(p.ok);
  assert.deepEqual([p.estimate.duration_seconds, p.estimate.layer_count, p.estimate.materials[0].model_grams], [7510, 2, 12]);

  // A .gcode.3mf: the plate G-code and slice_info.config inside the ZIP.
  const threeMf = Buffer.from(
    zipSync({
      'Metadata/plate_1.gcode': strToU8('; BambuStudio 01.09.00.70\n; CHANGE_LAYER\n; CHANGE_LAYER\n; CHANGE_LAYER\n'),
      'Metadata/slice_info.config': strToU8(
        '<?xml version="1.0"?><config><header><header_item key="X-BBL-Client-Version" value="01.09.00.70"/></header><plate><metadata key="index" value="1"/><metadata key="prediction" value="2869"/><metadata key="weight" value="10.53"/><filament id="1" type="PLA" color="#FFFFFF" used_m="3.53" used_g="10.53" /><warning msg="Floating regions" level="1" error_code="1000C001" /></plate></config>'
      ),
    })
  );
  assert.deepEqual(readZip(threeMf).names.sort(), ['Metadata/plate_1.gcode', 'Metadata/slice_info.config']);
  const read = readPrintFileBytes(threeMf);
  assert.equal(read.format, 'gcode.3mf');
  const b = buildEstimate({ meta: read.meta, sliceInfo: read.sliceInfo, slots: [{ variant_id: 'v' }], slicerLabel: 'OrcaSlicer', printerProfile: 'P' });
  assert.ok(b.ok);
  assert.deepEqual(
    [b.estimate.duration_seconds, b.estimate.layer_count, b.estimate.materials, b.estimate.slicer_name, b.estimate.slicer_version, b.estimate.warnings[0]],
    [2869, 3, [{ variant_id: 'v', model_grams: 11 }], 'BambuStudio', '01.09.00.70', 'Floating regions']
  );

  // Failures, never a filled-in number.
  const fails = (meta: ReturnType<typeof scanGcodeText>, n = 1) => {
    const r = buildEstimate({ meta, sliceInfo: null, slots: slots.slice(0, n), slicerLabel: 'X', printerProfile: 'P' });
    assert.equal(r.ok, false);
    return r.ok ? '' : r.error_code;
  };
  assert.equal(fails(scanGcodeText('; filament used [g] = 3.0')), 'ESTIMATE_INCOMPLETE', 'no time');
  assert.equal(fails(scanGcodeText('; estimated printing time (normal mode) = 1h')), 'ESTIMATE_INCOMPLETE', 'no weight');
  assert.equal(fails(scanGcodeText('; estimated printing time (normal mode) = 1h\n; filament used [mm] = 500.0\n; filament used [g] = 0.00')), 'ESTIMATE_INCOMPLETE', '0 g for 500 mm: no density');
  assert.equal(fails(scanGcodeText('; estimated printing time (normal mode) = 1h\n; filament used [g] = 3.0, 2.0')), 'FILAMENT_MAPPING_MISMATCH', 'a filament no variant was loaded as');
});

test('slicing plans: objects = models × quantity × copies on their variant\'s filament; what v1 cannot slice faithfully is refused with a code', async () => {
  const cfg = {
    kind: 'orca',
    output: 'gcode',
    profiles_dir: '/profiles',
    machines: { M: [{ nozzle_um: 400, machine: 'm4.json', process: 'p.json' }, { nozzle_um: 600, machine: 'm6.json', process: 'p6.json', pause_gcode: 'M400 U1' }] },
    filaments: { by_sku: { 'SKU-W': 'white.json' }, by_material: { PLA: 'pla.json' } },
  };
  const input = {
    job_id: 'pcj_1',
    printer_model: { code: 'M' },
    settings: { nozzle_um: 400, layer_height_um: 120, infill_percent: 25, walls: 3, supports: 'tree', brim: true, orientation: 'auto', pause_at_layers: [] },
    copies: 2,
    plate: null,
    models: [
      { project_model_id: 'pm1', file_id: 'f1', quantity: 2, material_assignments: [{ part: 'default', variant_id: 'v-black' }] },
      { project_model_id: 'pm2', file_id: 'f2', quantity: 1, material_assignments: [{ part: 'default', variant_id: 'v-white' }] },
    ],
    variants: [
      { variant_id: 'v-white', sku: 'SKU-W', material: 'PLA', color_hex: '#FFFFFF' },
      { variant_id: 'v-black', sku: 'SKU-B', material: 'PLA', color_hex: '#000000' },
    ],
  };
  const planned = planSlice(input, cfg);
  assert.ok(planned.ok);
  assert.deepEqual(planned.plan.objects, [
    { file_id: 'f1', filament: 2 },
    { file_id: 'f1', filament: 2 },
    { file_id: 'f1', filament: 2 },
    { file_id: 'f1', filament: 2 },
    { file_id: 'f2', filament: 1 },
    { file_id: 'f2', filament: 1 },
  ]);
  assert.deepEqual(planned.plan.slots.map((s) => [s.variant_id, s.profile]), [['v-white', '/profiles/white.json'], ['v-black', '/profiles/pla.json']]);
  assert.equal(planned.plan.machine.machine, '/profiles/m4.json');
  const refuse = (patch: Record<string, unknown>, c: Record<string, unknown> = cfg) => {
    const r = planSlice({ ...input, ...patch }, c);
    return r.ok ? 'ok' : r.error_code;
  };
  assert.equal(refuse({ plate: [{ project_model_id: 'pm1' }] }), 'PLATE_LAYOUT_UNSUPPORTED');
  assert.equal(refuse({ models: [{ ...input.models[0], material_assignments: [{ part: 'a', variant_id: 'v-black' }, { part: 'b', variant_id: 'v-white' }] }] }), 'MULTI_PART_ASSIGNMENT_UNSUPPORTED');
  assert.equal(refuse({ settings: { ...input.settings, nozzle_um: 200 } }), 'PROFILE_NOT_CONFIGURED');
  assert.equal(refuse({ variants: [input.variants[0], { ...input.variants[1], sku: 'X', material: 'TPU' }] }), 'PROFILE_NOT_CONFIGURED');
  assert.equal(refuse({ settings: { ...input.settings, pause_at_layers: [5] } }), 'PAUSE_AT_LAYER_UNSUPPORTED', 'no pause G-code for that machine');
  assert.equal(refuse({ settings: { ...input.settings, nozzle_um: 600, pause_at_layers: [5] } }), 'ok');
  assert.equal(refuse({ settings: { ...input.settings, nozzle_um: 600, pause_at_layers: [5] } }, { ...cfg, output: 'gcode.3mf' }), 'PAUSE_AT_LAYER_UNSUPPORTED', 'not inside a .gcode.3mf');
  // The CLI slices each file as uploaded: a model scaled or turned on its own is refused, the identity is not.
  assert.equal(refuse({ models: [{ ...input.models[0], transform: { scale_ppm: 2_000_000 } }] }), 'TRANSFORM_UNSUPPORTED');
  assert.equal(refuse({ models: [{ ...input.models[0], transform: { scale_ppm: 1_000_000, rotation_z_mdeg: 0, orientation: 'auto' } }] }), 'ok');

  // Object labels are always off: a customer's 3MF object name never reaches the G-code (tests/printCloudAgentFixes.test.ts, finding 1).
  assert.deepEqual(orcaProcessOverrides(input.settings), { layer_height: '0.12', sparse_infill_density: '25%', wall_loops: '3', enable_support: '1', support_type: 'tree(auto)', brim_type: 'outer_only', gcode_label_objects: '0' });
  assert.deepEqual(
    orcaArgs({ machinePath: 'm.json', processPath: 'p.json', filamentPaths: ['a.json', 'b.json'], objects: [{ filament: 2, path: 'x.stl' }, { filament: 1, path: 'y.stl' }], outDir: 'out', outBase: 'lv_pcj_1', output: 'gcode.3mf', orient: true }),
    ['--slice', '0', '--arrange', '1', '--orient', '1', '--load-settings', 'm.json;p.json', '--load-filaments', 'a.json;b.json', '--load-filament-ids', '2,1', '--outputdir', 'out', '--export-3mf', 'lv_pcj_1.gcode.3mf', 'x.stl', 'y.stl']
  );
  const pr = prusaArgs({ printerIni: 'pr.ini', printIni: 'pp.ini', filamentIni: 'pf.ini', settings: { layer_height_um: 200, infill_percent: 15, walls: 2, supports: 'none', brim: false }, brimWidthMm: 5, outPath: 'o.gcode', objectPaths: ['a.stl'] });
  // --merge: every object on one plate (finding 4); labels off whatever the profile says (finding 1).
  assert.deepEqual(pr.args, ['--export-gcode', '--merge', '--load', 'pr.ini', '--load', 'pp.ini', '--load', 'pf.ini', '--gcode-label-objects', 'disabled', '--layer-height', '0.2', '--fill-density', '15%', '--perimeters', '2', '--no-support-material', '--brim-width', '0', '--output', 'o.gcode', 'a.stl']);

  // Pauses go after the Nth layer marker, and only when every requested layer exists.
  const gcodePath = join(freshDir('pauses'), 'p.gcode');
  writeFileSync(gcodePath, ';LAYER_CHANGE\nG1 Z0.2\n;LAYER_CHANGE\nG1 Z0.4\n;LAYER_CHANGE\nG1 Z0.6\n');
  assert.deepEqual(await insertPauses(gcodePath, [2], 'M601'), { layers: 3, inserted: 1, ok: true });
  assert.equal(readFileSync(gcodePath, 'utf8').split('\n').slice(2, 6).join('|'), ';LAYER_CHANGE|; levonis-agent: pause before layer 2 (pause_at_layers)|M601|G1 Z0.4');
  assert.equal((await insertPauses(gcodePath, [9], 'M601')).ok, false);

  // The pipeline end to end on the fake CLI: a timeout is SLICER_TIMEOUT, a crash SLICER_FAILED.
  const slicer = createSlicer({ ...cfg, profiles_dir: profilesDir(), machines: { M: { machine: 'machine.json', process: 'process.json' } }, filaments: { by_material: { PLA: 'pla.json' } }, timeout_ms: 300, cli_path: process.execPath }, {
    run: (_c, args, o) => runCli(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', '--', ...args], o),
  });
  const work = freshDir('slice-timeout');
  const model = join(work, 'f1.stl');
  writeFileSync(model, 'solid x\nendsolid x\n');
  const one = { ...input, copies: 1, settings: { ...input.settings, orientation: 'as_uploaded' }, models: [input.models[1]], variants: [input.variants[0]] };
  const timedOut = await slicer.slice({ input: one, files: new Map([['f2', model]]), workDir: work });
  assert.deepEqual(timedOut.ok ? null : timedOut.error_code, 'SLICER_TIMEOUT');
  const crashing = createSlicer({ ...cfg, profiles_dir: profilesDir(), machines: { M: { machine: 'machine.json', process: 'process.json' } }, filaments: { by_material: { PLA: 'pla.json' } }, timeout_ms: 120_000, cli_path: process.execPath }, {
    run: (_c, args, o) => runCli(process.execPath, ['-e', 'console.error("Segmentation fault"); process.exit(139)', '--', ...args], o),
  });
  const crashed = await crashing.slice({ input: one, files: new Map([['f2', model]]), workDir: work });
  assert.equal(crashed.ok ? null : crashed.error_code, 'SLICER_FAILED');
  // A slicer binary that is not there fails at once — it never leaves the claim hanging.
  const missing = await runCli(join(TMP, 'no-such-slicer'), ['--slice', '0'], { timeoutMs: 60_000 });
  assert.deepEqual([missing.timedOut, missing.code === 0], [false, false]);
  assert.match(missing.tail, /ENOENT/);
});

// ================================================================= configuration, logs, CLI

test('configuration is strict: the token only from the environment, an explicit TLS choice for Bambu, unknown keys refused; logs never carry a secret', () => {
  const env = { LEVONIS_AGENT_TOKEN: `pca_${'a'.repeat(43)}`, BAMBU_X2D_1_ACCESS_CODE: 'acc3ss-c0de', OCTOPRINT_MK4_1_KEY: 'octo-secret-key', MOONRAKER_VORON_1_KEY: 'moon-secret' };
  const example = JSON.parse(readFileSync(join(process.cwd(), 'tools/print-cloud-agent/config.example.json'), 'utf8'));
  const cfg = normalizeConfig(example, { env, baseDir: TMP });
  assert.deepEqual(Object.keys(cfg.printers).sort(), ['lan-mk4-1', 'lan-sim-1', 'lan-voron-1', 'lan-x2d-1']);
  assert.equal(cfg.printers['lan-x2d-1'].tls.mode, 'pin');
  assert.equal(cfg.printers['lan-x2d-1'].access_code, 'acc3ss-c0de');
  assert.deepEqual(cfg.secrets.sort(), [env.BAMBU_X2D_1_ACCESS_CODE, env.LEVONIS_AGENT_TOKEN, env.MOONRAKER_VORON_1_KEY, env.OCTOPRINT_MK4_1_KEY].sort());
  const problems = (raw: unknown, e: Record<string, string> = env) => {
    try {
      normalizeConfig(raw, { env: e, baseDir: TMP });
      return [];
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      return err.problems;
    }
  };
  const base = { cloud: { base_url: 'https://levonis-iq.com' }, state_dir: './s', printers: {} };
  assert.match(problems({ ...base, cloud: { ...base.cloud, token: env.LEVONIS_AGENT_TOKEN } }).join(), /never write the agent token/);
  assert.match(problems(base, {}).join(), /LEVONIS_AGENT_TOKEN is not set/);
  assert.match(problems({ ...base, cloud: 'https://levonis-iq.com' }).join(), /cloud: must be an object/, 'a malformed section is a problem, not a crash');
  assert.match(problems('not an object').join(), /config: must be an object/);
  assert.match(problems(base, { LEVONIS_AGENT_TOKEN: 'not-a-token' }).join(), /does not hold an agent token/);
  assert.match(problems({ ...base, cloud: { base_url: 'http://levonis-iq.com' } }).join(), /use https/);
  assert.match(problems({ ...base, printers: { b: { driver: 'bambu', host: '10.0.0.5', serial: 'SN1234', access_code: 'x1234567' } } }).join(), /tls\.mode: required/);
  assert.match(problems({ ...base, printers: { b: { driver: 'bambu', host: '10.0.0.5', serial: 'SN1234', access_code: 'x1234567', tls: { mode: 'pin' } } } }).join(), /fingerprint256/);
  assert.match(problems({ ...base, printers: { o: { driver: 'octoprint', base_url: 'http://10.0.0.6', acess_code_env: 'X' } } }).join(), /acess_code_env: unknown key/);
  assert.match(problems({ ...base, slicer: { kind: 'orca', cli_path: '/x', timeout_seconds: 900 } }).join(), /timeout_seconds/);

  // Logs: a secret is cut by key and by value, wherever it hides.
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l), secrets: cfg.secrets });
  log.info('test', { authorization: 'Bearer whatever', nested: { access_code: 'zzz' }, message: `failed GET https://x/?k=${env.OCTOPRINT_MK4_1_KEY}`, error: new Error(`refused ${env.LEVONIS_AGENT_TOKEN}`) });
  const text = lines.join('\n');
  for (const s of cfg.secrets) assert.ok(!text.includes(s), 'a secret leaked into a log line');
  assert.ok(text.includes('[redacted]'));
});

test('the CLI: arguments, the token-in-file refusal (exit 78), and no printer without a configured connection_ref', async () => {
  assert.deepEqual(parseArgs(['--config', 'a.json', '--check']).check, true);
  assert.match(parseArgs([]).error ?? '', /--config is required/);
  assert.match(parseArgs(['--config', 'a', '--init', '--repair-state']).error ?? '', /exclude/);
  assert.match(parseArgs(['--config']).error ?? '', /needs a value/);
  const dir = freshDir('cli');
  const cfgPath = join(dir, 'c.json');
  writeFileSync(cfgPath, JSON.stringify({ cloud: { base_url: 'https://levonis-iq.com', token: `pca_${'z'.repeat(40)}` }, state_dir: dir, printers: {} }));
  const out: string[] = [];
  assert.equal(await main(['--config', cfgPath], { env: {}, print: (s) => out.push(s), signals: false }), 78);
  assert.match(out.join('\n'), /never write the agent token/);
  assert.equal(await main(['--bogus'], { print: () => undefined, signals: false }), 64);
  writeFileSync(cfgPath, JSON.stringify({ cloud: { base_url: 'https://levonis-iq.com' }, state_dir: dir, printers: { 'lan-1': { driver: 'simulator' } } }));
  assert.equal(await main(['--config', cfgPath, '--bed-cleared', 'lan-2'], { env: { LEVONIS_AGENT_TOKEN: `pca_${'z'.repeat(40)}` }, print: () => undefined, signals: false }), 64);
});

test('printProjection: the same input sliced is the same print; a changed setting, copy count or model is not', () => {
  const input = { job_id: 'j', printer_model: { code: 'M', brand: 'B' }, settings: { infill_percent: 15, walls: 2 }, copies: 1, plate: null, models: [{ file_id: 'f', quantity: 1, transform: {}, material_assignments: [{ part: 'default', variant_id: 'v' }] }], variants: [{ variant_id: 'v', color_name: 'White' }] };
  assert.equal(printProjection(input), printProjection({ ...input, variants: [{ variant_id: 'v', color_name: 'Snow' }], settings: { walls: 2, infill_percent: 15 } }), 'a renamed colour or reordered keys print the same');
  assert.notEqual(printProjection(input), printProjection({ ...input, settings: { ...input.settings, infill_percent: 20 } }));
  assert.notEqual(printProjection(input), printProjection({ ...input, copies: 2 }));
  assert.notEqual(printProjection(input), printProjection({ ...input, models: [{ ...input.models[0], file_id: 'g' }] }));
});
