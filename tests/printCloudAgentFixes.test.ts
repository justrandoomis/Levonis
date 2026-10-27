/**
 * THE WORKSHOP AGENT — the adversarial review's fifteen confirmed findings,
 * each reproduced and held fixed (tools/print-cloud-agent;
 * docs/PRINT_CLOUD_AGENT.md). Every test is named after its finding.
 *
 * The cloud is the REAL Print Cloud app in process, on real persisted
 * records (tests/fixtures/printCloud.ts): the agent's CloudClient is handed a
 * `fetch` that calls the app's own `fetch`. What stands in for hardware is
 * local and named — the simulator driver, fake slicer CLIs spawned through
 * the agent's own runCli, an HTTP fake of OctoPrint and a fake Bambu MQTT
 * broker on loopback sockets. Every transport is explicit: CI preloads
 * scripts/test-no-network.mjs, which replaces the global fetch.
 *
 * The fake PrusaSlicer below models exactly the behaviours the agent depends
 * on, each checked against the real PrusaSlicer 2.7.2 binary while fixing
 * them (and, where noted, against the 2.9.2 source): see its header.
 *
 * Run: node --import tsx --test tests/printCloudAgentFixes.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { Zip, ZipDeflate, strToU8, unzipSync, zipSync } from 'fflate';
import { ctx } from './fixtures/app';
import { ADMIN, AGENT, API, boxStl, buy, estimatedJob, idem, ok, pcWorld, readyFile, row, rows, seedCatalog, upload, type Catalog, type Json, type World } from './fixtures/printCloud';
import { pcWords } from '../worker/lib/printCloud/errors';
import { inspect3mfArchive, validateUpload } from '../worker/lib/printCloud/files';
import { flagWriterProblem, main } from '../tools/print-cloud-agent/agent.mjs';
import { normalizeConfig, type AgentConfig } from '../tools/print-cloud-agent/lib/config.mjs';
import { createLogger } from '../tools/print-cloud-agent/lib/log.mjs';
import { PacketReader, encodeConnack, encodePingresp, encodePublish, encodeSuback } from '../tools/print-cloud-agent/lib/mqtt.mjs';
import { CloudClient, CloudError } from '../tools/print-cloud-agent/lib/protocol.mjs';
import { Runner, bedFlagName } from '../tools/print-cloud-agent/lib/runner.mjs';
import { AgentState, StateError } from '../tools/print-cloud-agent/lib/state.mjs';
import { readZip, zipWithout } from '../tools/print-cloud-agent/lib/zip.mjs';
import { createBambu } from '../tools/print-cloud-agent/drivers/bambu.mjs';
import type { Driver } from '../tools/print-cloud-agent/drivers/common.mjs';
import { createOctoPrint } from '../tools/print-cloud-agent/drivers/octoprint.mjs';
import { createSimulator, type Simulator } from '../tools/print-cloud-agent/drivers/simulator.mjs';
import { buildEstimate, scanGcodeText } from '../tools/print-cloud-agent/slicers/gcode.mjs';
import { createSlicer, identityTransform, runCli, type CliResult } from '../tools/print-cloud-agent/slicers/index.mjs';
import { screen3mf } from '../tools/print-cloud-agent/slicers/model3mf.mjs';
import { prusaPlateProblem } from '../tools/print-cloud-agent/slicers/prusa.mjs';

const H = 3600;
const TMP = mkdtempSync(join(tmpdir(), 'pc-agent-fixes-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (label: string) => {
  const d = join(TMP, `${label}-${++dirs}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ================================================================= the in-process cloud

interface Sent {
  method: string;
  path: string;
  status: number | null;
  body: Json | null;
}
interface Gate {
  down: boolean;
  sent: Sent[];
}
const gateOf = (): Gate => ({ down: false, sent: [] });

/** The agent's transport: the Print Cloud app's own `fetch`, in process. `gate.down` is a dead network. */
function appFetch(w: World, gate: Gate) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    if (gate.down) throw new TypeError('fetch failed');
    const url = new URL(input);
    const sent: Sent = { method: init?.method ?? 'GET', path: url.pathname, status: null, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : null };
    gate.sent.push(sent);
    const headers = { ...(init?.headers as Record<string, string>), 'CF-Connecting-IP': '10.0.0.7' };
    const res = await w.guest.fetch(new Request(input, { ...init, headers }), undefined, ctx);
    sent.status = res.status;
    return res;
  };
}

async function mintAgent(w: World, capabilities: string[], printerId: string, ref = 'lan-sim-1') {
  const agent = await ok(w.full, 'POST', `${ADMIN}/agents`, { name: 'Workshop PC', capabilities });
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${printerId}`, { adapter: 'agent', agent_id: agent.agent_id, connection_ref: ref });
  return { id: agent.agent_id as string, token: agent.token as string };
}

/** A seeded workshop with one agent-bound printer and a customer holding hours and PLA. */
async function workshop(o: { capabilities?: string[]; verification?: boolean; settings?: Record<string, unknown> } = {}) {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: false });
  const current = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: current.version, config: { agent_reports_need_verification: o.verification ?? false, ...o.settings } });
  const printer = cat.printers[0];
  const { token } = await mintAgent(w, o.capabilities ?? ['telemetry', 'job_control', 'slicer'], printer);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  return { w, cat, printer, token };
}

/** A customer job up to `analyzing` (the slicing request waits): project → model → job → analysis. */
async function analyzedJob(w: World, cat: Catalog, o: { fileId?: string; quantity?: number; transform?: Json; title?: string; extraFileIds?: string[] } = {}) {
  const fileId = o.fileId ?? (await readyFile(w, w.a));
  const project = await ok(w.a, 'POST', `${API}/projects`, { name: o.title ?? 'Bracket', project_type: 'figure' });
  for (const id of [fileId, ...(o.extraFileIds ?? [])]) {
    await ok(w.a, 'POST', `${API}/projects/${project.project_id}/models`, {
      file_id: id,
      quantity: o.quantity ?? 1,
      material_assignments: [{ part: 'default', variant_id: cat.white }],
      ...(o.transform ? { transform: o.transform } : {}),
    });
  }
  const job = await ok(w.a, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, title: o.title ?? 'Bracket' });
  await ok(w.a, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  return { jobId: job.job_id as string, fileId };
}

async function confirmJob(w: World, jobId: string) {
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  const c = await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
  assert.equal(c.status, 'queued');
}

/** An operator-estimated, confirmed job the scheduler places on `printer`. */
async function placedJob(w: World, cat: Catalog, printer: string, title: string) {
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], title });
  await confirmJob(w, jobId);
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: jobId, printer_id: printer }]);
  return jobId;
}

const jobStatus = (w: World, id: string) => row<{ status: string }>(w, 'SELECT status FROM pc_print_jobs WHERE id = ?', id)?.status;
const slicing = (w: World, jobId: string) => row<{ status: string; error_code: string | null }>(w, 'SELECT status, error_code FROM pc_slicing_requests WHERE job_id = ? ORDER BY created_at DESC LIMIT 1', jobId);

// ================================================================= fake slicer CLIs

type RunFn = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<CliResult>;

/** A stand-in for `orca-slicer`: OrcaSlicer's header block, layer markers and statistics for a 2-minute, 12-layer print. */
function fakeOrcaScript(): string {
  const path = join(TMP, 'fake-orca.mjs');
  if (existsSync(path)) return path;
  writeFileSync(
    path,
    String.raw`import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const a = process.argv.slice(2);
const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const out = get('--outputdir');
const filaments = (get('--load-filaments') || '').split(';').filter(Boolean);
const ids = (get('--load-filament-ids') || '').split(',').filter(Boolean);
const models = a.filter((x) => /\.(stl|3mf|obj)$/i.test(x));
if (!out || !models.length || models.length !== ids.length || get('--slice') !== '0') { console.error('bad arguments: ' + a.join(' ')); process.exit(2); }
mkdirSync(out, { recursive: true });
const lines = ['; HEADER_BLOCK_START', '; generated by OrcaSlicer 2.3.0 on 2026-10-27 at 10:00:00', '; model printing time: 1m 50s; total estimated time: 2m 0s', '; total layer number: 12', '; HEADER_BLOCK_END', 'T0'];
for (let i = 0; i < 12; i++) lines.push('; CHANGE_LAYER', 'G1 Z' + (0.2 * (i + 1)).toFixed(1));
lines.push('; filament used [mm] = ' + filaments.map(() => '7816.20').join(', '), '; filament used [g] = ' + filaments.map(() => '23.41').join(', '), '; total layers count = 12', '; estimated printing time (normal mode) = 2m 0s');
writeFileSync(join(out, 'plate_1.gcode'), lines.join('\n') + '\n');
`
  );
  return path;
}

/**
 * A stand-in for `prusa-slicer` with the behaviours of PrusaSlicer 2.7 the
 * agent depends on — each one checked against the real 2.7.2 binary:
 *   - every input file is its own model: without --merge each is sliced on
 *     its own into the SAME --output, so only the last survives; with
 *     --merge they share one plate, and what does not fit is written BESIDE
 *     the bed (exit 0, no warning);
 *   - a 3MF's embedded config (Metadata/Slic3r_PE.config) supplies every key
 *     the --load'ed profiles leave unset; command-line options win over both;
 *   - Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml: a «custom» entry's
 *     text is written verbatim at its layer;
 *   - object labels on (gcode_label_objects octoprint): the object's NAME is
 *     written unescaped into its label lines;
 *   - start and end G-code are typed ;TYPE:Custom; the statistics and the
 *     config block (bed_shape) close the file.
 * `FAKE_PRUSA_VERSION` changes the version it signs the file with.
 */
function fakePrusaScript(): string {
  const path = join(TMP, 'fake-prusa.mjs');
  if (existsSync(path)) return path;
  const zipModule = new URL('../tools/print-cloud-agent/lib/zip.mjs', import.meta.url).href;
  writeFileSync(
    path,
    String.raw`import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readZip } from '${zipModule}';
const VERSION = process.env.FAKE_PRUSA_VERSION || '2.7.2';
const a = process.argv.slice(2);
const VALUED = ['--load', '--output', '--layer-height', '--fill-density', '--perimeters', '--support-material-style', '--brim-width', '--gcode-label-objects'];
const opt = (k) => { const i = a.lastIndexOf(k); return i >= 0 ? a[i + 1] : null; };
const inputs = [];
for (let i = 0; i < a.length; i++) {
  if (VALUED.includes(a[i])) { i++; continue; }
  if (!a[i].startsWith('--')) inputs.push(a[i]);
}
const out = opt('--output');
if (!a.includes('--export-gcode') || !out || !inputs.length) { console.error('bad arguments: ' + a.join(' ')); process.exit(2); }
const keys = (text, re) => {
  const o = {};
  for (const line of text.split('\n')) { const m = re.exec(line.trim()); if (m) o[m[1]] = m[2]; }
  return o;
};
const loaded = {};
a.forEach((x, i) => { if (x === '--load') Object.assign(loaded, keys(readFileSync(a[i + 1], 'utf8'), /^([a-z_0-9]+) = (.*)$/)); });
const cli = {};
if (opt('--gcode-label-objects') !== null) cli.gcode_label_objects = opt('--gcode-label-objects');
if (opt('--layer-height') !== null) cli.layer_height = opt('--layer-height');
const unxml = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const sizeOf = (pts) => [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k])));
function load(path) {
  if (/\.3mf$/i.test(path)) {
    const zip = readZip(readFileSync(path));
    const find = (re) => zip.names.find((n) => re.test(n.replace(/\\/g, '/')));
    const xml = zip.read(find(/^3D\/.+\.model$/i)).toString('utf8');
    const name = /<object\b[^>]*\bname="([^"]*)"/.exec(xml);
    const pts = [...xml.matchAll(/<vertex x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    const cfg = find(/^Metadata\/Slic3r_PE\.config$/i);
    const custom = [];
    const per = find(/^Metadata\/Prusa_Slicer_custom_gcode_per_print_z\.xml$/i);
    if (per) for (const m of zip.read(per).toString('utf8').matchAll(/<code\b([^>]*?)\/?>/g)) {
      const attr = (k) => { const r = new RegExp('\\s' + k + '="([^"]*)"').exec(m[1]); return r ? unxml(r[1]) : null; };
      if (attr('type') === '4') custom.push({ z: Number(attr('print_z')), extra: attr('extra') });
    }
    return { name: name ? unxml(name[1]) : basename(path), size: sizeOf(pts), embedded: cfg ? keys(zip.read(cfg).toString('utf8'), /^; ([a-z_0-9]+) = (.*)$/) : {}, custom };
  }
  const b = readFileSync(path);
  const pts = [];
  for (let t = 0; t < b.readUInt32LE(80); t++) for (let v = 0; v < 3; v++) pts.push([0, 1, 2].map((k) => b.readFloatLE(84 + t * 50 + 12 + v * 12 + k * 4)));
  return { name: basename(path), size: sizeOf(pts), embedded: {}, custom: [] };
}
const models = inputs.map(load);
const config = Object.assign({}, ...models.map((m) => m.embedded), loaded, cli);
const lines = (s) => String(s).split('\\n').join('\n').split('\n');
function slice(objects) {
  const shape = config.bed_shape || '0x0,250x0,250x210,0x210';
  const bed = shape.split(',').map((p) => p.split('x').map(Number));
  const minX = Math.min(...bed.map((p) => p[0])), maxX = Math.max(...bed.map((p) => p[0]));
  const minY = Math.min(...bed.map((p) => p[1])), maxY = Math.max(...bed.map((p) => p[1]));
  let x = minX + 5, y = minY + 5, row = 0, beside = maxX + 20;
  const placed = objects.map((o) => {
    const [w, d] = o.size;
    if (x + w > maxX - 5) { x = minX + 5; y += row + 6; row = 0; }
    if (y + d > maxY - 5) { const at = [beside, minY + 5]; beside += w + 6; return { ...o, at }; }
    const at = [x, y];
    x += w + 6;
    row = Math.max(row, d);
    return { ...o, at };
  });
  const labels = !['disabled', '0', ''].includes(String(config.gcode_label_objects ?? 'disabled'));
  const lh = Number(config.layer_height || 0.2);
  const layers = Math.max(1, Math.round(Math.max(...placed.map((o) => o.size[2])) / lh));
  const L = ['; generated by PrusaSlicer ' + VERSION + '+linux-x64-GTK3 on 2026-10-27 at 10:00:00 UTC', ''];
  for (const o of placed) L.push('; fake-object at ' + o.at.join(','));
  if (labels) placed.forEach((o, k) => L.push('; printing object ' + o.name + ' id:' + k + ' copy 0', '; stop printing object ' + o.name + ' id:' + k + ' copy 0'));
  L.push('M190 S60', 'M104 S215', ';TYPE:Custom');
  if (config.start_gcode) L.push(...lines(config.start_gcode));
  L.push('G28', 'M82', 'G92 E0', 'G1 Y-3 F1000 ; go outside print area', 'G1 X60 E9 F1000 ; intro line', 'G92 E0');
  let e = 0;
  for (let i = 1; i <= layers; i++) {
    const z = Number((lh * i).toFixed(2));
    L.push(';LAYER_CHANGE', ';Z:' + z);
    if (config.layer_gcode) L.push(...lines(config.layer_gcode));
    for (const o of placed) for (const c of o.custom) if (Math.abs(c.z - z) < 1e-6) L.push(';CUSTOM_GCODE', ...c.extra.split('\n'));
    placed.forEach((o, k) => {
      if (labels) L.push('; printing object ' + o.name + ' id:' + k + ' copy 0');
      const [x0, y0] = o.at;
      const x1 = x0 + o.size[0], y1 = y0 + o.size[1];
      L.push(';TYPE:Perimeter', 'G1 X' + x0 + ' Y' + y0 + ' F7800');
      for (const [px, py] of [[x1, y0], [x1, y1], [x0, y1], [x0, y0]]) { e += 1; L.push('G1 X' + px + ' Y' + py + ' E' + e.toFixed(5)); }
      if (labels) L.push('; stop printing object ' + o.name + ' id:' + k + ' copy 0');
    });
  }
  L.push(';TYPE:Custom', 'G1 X0 Y200 F3000 ; home X axis', 'M84');
  const volume = placed.reduce((s, o) => s + o.size[0] * o.size[1] * o.size[2], 0);
  const grams = (volume / 1000) * 1.24 * 0.25;
  const seconds = 60 + Math.round(volume / 100);
  L.push('; filament used [mm] = ' + (grams * 330).toFixed(2), '; filament used [g] = ' + grams.toFixed(2), '; estimated printing time (normal mode) = ' + Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's');
  L.push('; prusaslicer_config = begin', '; bed_shape = ' + shape, '; gcode_label_objects = ' + (config.gcode_label_objects ?? 'disabled'), '; prusaslicer_config = end');
  return L.join('\n') + '\n';
}
for (const run of a.includes('--merge') ? [models] : models.map((m) => [m])) writeFileSync(out, slice(run));
console.log('Slicing result exported to ' + out);
`
  );
  return path;
}

/** What the agent handed the slicer CLI on each run: its arguments, and the part names of every 3MF among them. */
interface SlicerCalls {
  runs: Array<{ args: string[]; archives: string[][] }>;
}

const orcaRun = (calls: SlicerCalls = { runs: [] }): RunFn => (_cmd, args, opts) => {
  calls.runs.push({ args, archives: [] });
  return runCli(process.execPath, [fakeOrcaScript(), ...args], opts);
};

/** `version` picks the PrusaSlicer version the fake signs a run's file with (by its arguments: the output names the job). */
const prusaRun = (calls: SlicerCalls = { runs: [] }, version: (args: string[]) => string | undefined = () => undefined): RunFn => (_cmd, args, opts) => {
  calls.runs.push({ args, archives: args.filter((x) => /\.3mf$/i.test(x)).map((x) => readZip(readFileSync(x)).names) });
  const v = version(args);
  return runCli(process.execPath, [fakePrusaScript(), ...args], { ...opts, env: { ...process.env, ...(v ? { FAKE_PRUSA_VERSION: v } : {}) } });
};

function orcaProfiles(): string {
  const dir = join(TMP, 'orca-profiles');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'machine.json'), JSON.stringify({ name: 'Bambu Lab X2D 0.4 nozzle', nozzle_diameter: ['0.4'] }));
    writeFileSync(join(dir, 'process.json'), JSON.stringify({ name: '0.20mm Standard', layer_height: '0.2', sparse_infill_density: '15%', wall_loops: '2' }));
    writeFileSync(join(dir, 'pla.json'), JSON.stringify({ name: 'Generic PLA', filament_density: ['1.24'] }));
  }
  return dir;
}

/** A workshop's PrusaSlicer profiles: they label objects and set no start or layer G-code of their own (a partial export). */
function prusaProfiles(): string {
  const dir = join(TMP, 'prusa-profiles');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'printer.ini'), 'printer_technology = FFF\nbed_shape = 0x0,250x0,250x210,0x210\nmax_print_height = 210\nnozzle_diameter = 0.4\ngcode_flavor = marlin2\n');
    writeFileSync(join(dir, 'print.ini'), 'layer_height = 0.2\nperimeters = 2\nfill_density = 15%\ngcode_label_objects = octoprint\n');
    writeFileSync(join(dir, 'filament.ini'), 'filament_diameter = 1.75\nfilament_density = 1.24\n');
  }
  return dir;
}

const ORCA = () => ({
  kind: 'orca',
  // The «binary» must exist for the agent to claim work; the run hook swaps in the fake script.
  cli_path: process.execPath,
  profiles_dir: orcaProfiles(),
  timeout_seconds: 60,
  output: 'gcode',
  machines: { 'BBL-X2D-COMBO': { machine: 'machine.json', process: 'process.json' } },
  filaments: { by_material: { PLA: 'pla.json' } },
});
const PRUSA = () => ({
  kind: 'prusa',
  cli_path: process.execPath,
  profiles_dir: prusaProfiles(),
  timeout_seconds: 60,
  output: 'gcode',
  machines: { 'BBL-X2D-COMBO': { machine: 'printer.ini', process: 'print.ini' } },
  filaments: { by_material: { PLA: 'filament.ini' } },
});

// ================================================================= the agent

function agentConfig(token: string, stateDir: string, extra: Record<string, unknown> = {}): AgentConfig {
  return normalizeConfig(
    {
      cloud: { base_url: 'https://levonis-iq.com', token_env: 'TEST_AGENT_TOKEN' },
      state_dir: stateDir,
      intervals: { telemetry_seconds: 10, commands_seconds: 5, printers_seconds: 30, slicing_seconds: 15 },
      jobs: { bed_clear: 'assume_clear', command_max_age_seconds: 3600 },
      printers: { 'lan-sim-1': { driver: 'simulator', print_seconds: 120 } },
      slicer: ORCA(),
      ...extra,
    },
    { env: { TEST_AGENT_TOKEN: token }, baseDir: stateDir }
  );
}

interface Agent {
  runner: Runner;
  state: AgentState;
  cloud: CloudClient;
  logs: Json[];
  stop: () => Promise<void>;
}

function startAgent(w: World, config: AgentConfig, o: { drivers: Record<string, Driver>; clock: { now: number }; gate?: Gate; run?: RunFn | null }): Agent {
  const logs: Json[] = [];
  const clock = () => o.clock.now;
  const state = AgentState.open(config.state_dir, { clock });
  const log = createLogger({ level: 'debug', sink: (l) => logs.push(JSON.parse(l) as Json), clock, secrets: config.secrets });
  const cloud = new CloudClient({ baseUrl: config.cloud.base_url, token: config.cloud.token, fetch: appFetch(w, o.gate ?? gateOf()), sleep: async () => undefined, clock, log });
  const slicer = config.slicer && o.run !== null ? createSlicer(config.slicer, { log, run: o.run ?? orcaRun() }) : null;
  const runner = new Runner({ config, cloud, state, log, drivers: o.drivers, slicer, clock });
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

/** Advance the agent's clock, run one tick, let its background work finish. */
async function step(a: Agent, clock: { now: number }, ms: number) {
  clock.now += ms;
  await a.runner.tick();
  await a.runner.settle();
}

const logged = (a: Agent, msg: string) => a.logs.filter((l) => l.msg === msg);
const recordOf = (dir: string, jobId: string) => JSON.parse(readFileSync(join(dir, 'jobs', `${jobId}.json`), 'utf8')) as Json;
const trail = (dir: string, jobId: string) => (recordOf(dir, jobId).events as Json[]).map((e) => [e.kind, e.status, e.error?.code ?? null]);

/** Write the flag `--bed-cleared <ref>` writes (the CLI path itself is covered in tests/printCloudAgentProgram.test.ts). */
function bedCleared(dir: string, ref = 'lan-sim-1') {
  mkdirSync(join(dir, 'bed-cleared'), { recursive: true });
  writeFileSync(join(dir, 'bed-cleared', bedFlagName(ref)), `${new Date().toISOString()}\n`);
}

/** Every print file the machine was sent, as text. */
function recordUploads(sim: Simulator): string[] {
  const texts: string[] = [];
  const real = sim.upload.bind(sim);
  sim.upload = async (file) => {
    texts.push(file.path ? readFileSync(file.path, 'utf8') : Buffer.from(file.bytes ?? []).toString('utf8'));
    return real(file);
  };
  return texts;
}

/** A machine whose controller can reboot: afterwards it is idle and has forgotten its print (Klipper's standby, a power cut). */
function rebootable(clock: { now: number }) {
  const box = { sim: createSimulator({}, { clock: () => clock.now }) };
  const driver: Driver = {
    kind: 'simulator',
    capabilities: { light: true, ams: false },
    status: () => box.sim.status(),
    upload: (f) => box.sim.upload(f),
    start: (p) => box.sim.start(p),
    pause: () => box.sim.pause(),
    resume: () => box.sim.resume(),
    cancel: () => box.sim.cancel(),
    close: () => box.sim.close(),
  };
  const uploads: string[] = [];
  const realUpload = driver.upload;
  driver.upload = async (f) => {
    uploads.push(f.name);
    return realUpload(f);
  };
  return { driver, uploads, sim: () => box.sim, reboot: () => (box.sim = createSimulator({}, { clock: () => clock.now })) };
}

/** The machine as the Bambu driver presents it: no print clock of its own (`elapsed_seconds` null). */
function noPrintClock(sim: Simulator): Driver {
  return { ...sim, status: async () => ({ ...(await sim.status()), elapsed_seconds: null }) };
}

// ================================================================= 3MF archives

const VERTS = (s: number, h: number) => [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, h], [s, 0, h], [s, s, h], [0, s, h]];
const TRIS = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
const xmlAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, '&#10;');

/** A 20 × 20 × 10 mm box as a PrusaSlicer project 3MF, with extra parts. */
function project3mf(o: { name?: string; parts?: Record<string, string> } = {}): Uint8Array {
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n' +
    ' <metadata name="slic3rpe:Version3mf">1</metadata>\n' +
    ` <resources>\n  <object id="1" type="model" name="${xmlAttr(o.name ?? 'Bracket')}">\n   <mesh>\n    <vertices>\n` +
    VERTS(20, 10).map(([x, y, z]) => `     <vertex x="${x}" y="${y}" z="${z}"/>`).join('\n') +
    '\n    </vertices>\n    <triangles>\n' +
    TRIS.map(([a, b, c]) => `     <triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('\n') +
    '\n    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1"/>\n </build>\n</model>\n';
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
    ...Object.fromEntries(Object.entries(o.parts ?? {}).map(([k, v]) => [k, strToU8(v)])),
  });
}

/** What the customer wants the printer to run: soft endstops off, the nozzle 40 mm into the bed. */
const CUSTOMER_LINES = ['M211 S0', 'G1 Z-40 F3000'];
/** PrusaSlicer's own per-layer custom G-code part, byte for byte the shape its exporter writes (type 4 = custom). */
const PER_LAYER_GCODE = `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_print_z>\n<code print_z="0.6" type="4" extruder="1" color="" extra="${CUSTOMER_LINES.join('&#10;')}" gcode="${CUSTOMER_LINES.join('&#10;')}"/>\n<mode value="SingleExtruder"/>\n</custom_gcodes_per_print_z>\n`;
/** A project's saved PrusaSlicer config with G-code keys a partial workshop profile does not set. */
const EMBEDDED_CONFIG = `; generated by PrusaSlicer 2.7.2 on 2026-10-27 at 10:00:00 UTC\n; start_gcode = ${CUSTOMER_LINES.join('\\n')}\n; layer_gcode = M92 E9999\n; printer_technology = FFF\n`;

const customerLinesIn = (texts: string[]) => texts.flatMap((t) => t.split('\n')).filter((l) => CUSTOMER_LINES.includes(l.trim()) || l.trim() === 'M92 E9999');

/** A 3MF uploaded and measured; `stored` replaces its stored bytes afterwards (a file kept from before the upload check). */
async function ready3mf(w: World, bytes: Uint8Array, stored?: Uint8Array): Promise<string> {
  const up = await upload(w.a, bytes, 'bracket.3mf');
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const fileId = up.json.data.file_id as string;
  if (stored) await w.bucket.put(row<Json>(w, 'SELECT storage_key FROM pc_model_files WHERE id = ?', fileId)!.storage_key, stored);
  await w.runTasks();
  assert.equal(row<Json>(w, 'SELECT status FROM pc_model_files WHERE id = ?', fileId)!.status, 'ready');
  return fileId;
}

/** Slice (estimate) → confirm → queue → upload and start, with PrusaSlicer. */
async function printWithPrusa(fileBytes: Uint8Array, stored?: Uint8Array) {
  const { w, cat, printer, token } = await workshop();
  const fileId = await ready3mf(w, fileBytes, stored);
  const { jobId } = await analyzedJob(w, cat, { fileId });
  const clock = { now: Date.now() };
  const sim = createSimulator({ print_seconds: 999 }, { clock: () => clock.now });
  const printed = recordUploads(sim);
  const calls: SlicerCalls = { runs: [] };
  const dir = freshDir('prusa');
  const a = startAgent(w, agentConfig(token, dir, { slicer: PRUSA() }), { drivers: { 'lan-sim-1': sim }, clock, run: prusaRun(calls) });
  await a.runner.start();
  await step(a, clock, 0);
  if (slicing(w, jobId)?.status === 'succeeded') {
    await confirmJob(w, jobId);
    await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
    await step(a, clock, 30_000);
    await step(a, clock, 10_000);
  }
  return { w, printer, jobId, sim, printed, calls, a };
}

// ================================================================= 1. customer G-code carriers in a 3MF (both ends)

test('finding 1 (cloud): a 3MF that carries printer commands is refused at upload, with a stable code in three languages', async () => {
  const w = pcWorld();
  await seedCatalog(w, { approval: false, secondPrinter: false });
  const carriers: Record<string, string> = {
    'Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml': PER_LAYER_GCODE,
    // Bambu Studio / OrcaSlicer keep per-plate custom G-code the same way; the slicers match names case-blind, `\` as `/`.
    'Metadata\\CUSTOM_GCODE_PER_LAYER.XML': '<custom_gcodes_per_layer/>',
    // A sliced plate inside a model file is printer commands too.
    'Metadata/plate_1.gcode': 'M211 S0\n',
  };
  for (const [part, body] of Object.entries(carriers)) {
    const r = await upload(w.a, project3mf({ parts: { [part]: body } }), 'bracket.3mf');
    assert.equal(r.status, 422, `${part}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, 'MODEL_CONTAINS_GCODE', part);
    assert.equal(r.json.details.part, part);
    const m = r.json.details.messages;
    assert.ok(m.ar && m.en && m.ckb, part);
    assert.notEqual(m.ckb, m.ar, 'the Sorani words are not a copy of the Arabic');
    assert.deepEqual(m, pcWords('MODEL_CONTAINS_GCODE'));
  }
  // A PrusaSlicer project as it is normally saved (its print config inside) is accepted: the agent removes that config.
  const project = await upload(w.a, project3mf({ parts: { 'Metadata/Slic3r_PE.config': EMBEDDED_CONFIG } }), 'bracket.3mf');
  assert.equal(project.status, 201, JSON.stringify(project.json));
});

test('finding 1 (agent): a stored 3MF with per-layer custom G-code is refused before slicing — the slicer never sees it, the printer gets nothing', async () => {
  const evil = project3mf({ parts: { 'Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml': PER_LAYER_GCODE } });
  // Uploaded clean, then the stored bytes are the carrier: a file kept from before the cloud's upload check existed.
  const { w, jobId, printed, calls, a } = await printWithPrusa(project3mf(), evil);
  assert.deepEqual(slicing(w, jobId), { status: 'failed', error_code: 'UNSUPPORTED_MODEL_CONTENT' }, `the slicer ran ${calls.runs.length} time(s)`);
  assert.equal(calls.runs.length, 0, 'the archive was never handed to the slicer');
  assert.equal(jobStatus(w, jobId), 'uploaded', 'back to the customer: «estimate unavailable»');
  assert.deepEqual(customerLinesIn(printed), []);
  assert.match(String(logged(a, 'slicing.failed')[0]?.detail ?? ''), /Prusa_Slicer_custom_gcode_per_print_z\.xml/);
  await a.stop();
});

test('finding 1 (agent): the slicer config saved in a customer 3MF is removed — its start and layer G-code never reach the printer', async () => {
  const { w, jobId, sim, printed, calls, a } = await printWithPrusa(project3mf({ parts: { 'Metadata/Slic3r_PE.config': EMBEDDED_CONFIG } }));
  assert.equal(slicing(w, jobId)?.status, 'succeeded');
  assert.ok(calls.runs.length >= 1);
  for (const run of calls.runs) for (const names of run.archives) {
    assert.ok(!names.some((n) => /slic3r_pe\.config$/i.test(n)), `the slicer was handed the customer's config: ${names.join(', ')}`);
    assert.ok(names.includes('3D/3dmodel.model'), 'the geometry is kept');
  }
  assert.equal(sim.snapshot().phase, 'printing');
  assert.deepEqual(customerLinesIn(printed), [], 'no line of the customer\'s saved config reached the machine');
  await a.stop();
});

test('finding 1 (agent): object labels are off — a 3MF object name with a newline never becomes a printer command', async () => {
  const name = `Bracket\n${CUSTOMER_LINES.join('\n')}\n; x`;
  const { w, jobId, sim, printed, calls, a } = await printWithPrusa(project3mf({ name }));
  assert.equal(slicing(w, jobId)?.status, 'succeeded');
  assert.equal(sim.snapshot().phase, 'printing');
  assert.ok(calls.runs.every((r) => r.args.join(' ').includes('--gcode-label-objects disabled')), 'PrusaSlicer is told to write no object labels');
  assert.deepEqual(customerLinesIn(printed), [], 'the object name reached the G-code as commands');
  assert.ok(!printed.some((t) => t.includes('Bracket')), 'no object name is in the print file at all');
  await a.stop();
});

// ================================================================= 2. figures only from the slicer's own block

test('finding 2: the estimate is the slicer\'s own statistics — a comment a customer\'s object name forges is never read', () => {
  const crafted = 'Benchy total estimated time: 1s;\n;filament used [g] = 0.01\n; estimated printing time (normal mode) = 1s\n; x';
  // PrusaSlicer 2.7.2's own lines for a 40 mm cube (stock MK3S presets), with labels on — the label header and every layer carry the name.
  const prusa = (objectName: string) => {
    const label = `; printing object ${objectName} id:0 copy 0`;
    const stop = `; stop printing object ${objectName} id:0 copy 0`;
    const lines = ['; generated by PrusaSlicer 2.7.2 on 2026-10-27 at 11:34:16 UTC', '', label, stop, '', ';TYPE:Custom', 'M862.3 P "MK3S" ; printer model check'];
    for (let i = 0; i < 200; i++) lines.push(';LAYER_CHANGE', `;Z:${(0.2 * (i + 1)).toFixed(1)}`, label, 'G1 X110 Y90 E0.5', stop);
    lines.push(
      'M84 ; disable motors',
      '; filament used [mm] = 6954.95',
      '; filament used [g] = 20.74',
      '; total filament used for wipe tower [g] = 0.00',
      '; estimated printing time (normal mode) = 1h 38m 29s',
      '; estimated printing time (silent mode) = 1h 39m 1s',
      '',
      '; prusaslicer_config = begin'
    );
    return lines.join('\n');
  };
  const figures = (gcode: string) => {
    const r = buildEstimate({ meta: scanGcodeText(gcode), sliceInfo: null, slots: [{ variant_id: 'v' }], slicerLabel: 'PrusaSlicer', printerProfile: 'MK3S' });
    assert.ok(r.ok, JSON.stringify(r));
    return [r.estimate.duration_seconds, r.estimate.materials[0].model_grams];
  };
  assert.deepEqual(figures(prusa('Benchy')), [5909, 21]);
  assert.deepEqual(figures(prusa(crafted)), [5909, 21], 'the figures are the slicer\'s, not text from the customer\'s 3MF');
  // PrusaSlicer never writes «total estimated time»: it is never read from PrusaSlicer output.
  assert.equal(scanGcodeText(prusa(crafted)).total_seconds, null);

  // OrcaSlicer: the time and the layer count are read only inside the header block that opens the file.
  const orca = (body: string[]) =>
    [
      '; HEADER_BLOCK_START',
      '; generated by OrcaSlicer 2.3.0 on 2026-10-27 at 10:00:00',
      '; model printing time: 1h 2m 3s; total estimated time: 1h 10m 5s',
      '; total layer number: 150',
      '; HEADER_BLOCK_END',
      ...body,
      '; filament used [mm] = 1234.56',
      '; filament used [g] = 3.68',
      '; total layers count = 150',
      '; estimated printing time (normal mode) = 1h 10m 5s',
    ].join('\n');
  const forged = ['; CHANGE_LAYER', '; printing object x; model printing time: 1s; total estimated time: 1s', '; total layer number: 1', '; filament used [g] = 0.01', 'G1 X1 E1'];
  const meta = scanGcodeText(orca(forged));
  assert.deepEqual([meta.total_seconds, meta.layers_declared, meta.grams], [4205, 150, [3.68]]);
  // Statistics stand only after the print's last layer: a forged line inside the print never counts, even with nothing after it.
  const noFooter = scanGcodeText(['; generated by PrusaSlicer 2.7.2 on 2026-10-27', ';LAYER_CHANGE', '; filament used [g] = 0.01', '; estimated printing time (normal mode) = 1s', ';LAYER_CHANGE', 'G1 X1 E1'].join('\n'));
  assert.deepEqual([noFooter.grams, noFooter.normal_seconds], [null, null]);
});

// ================================================================= 3 + 10. a vanished print leaves its part on the bed

async function bedWorkshop(label: string) {
  const { w, cat, printer, token } = await workshop();
  const dir = freshDir(label);
  const clock = { now: Date.now() };
  const machine = rebootable(clock);
  const config = agentConfig(token, dir, { jobs: { bed_clear: 'operator', command_max_age_seconds: 3600 } });
  const a = startAgent(w, config, { drivers: { 'lan-sim-1': machine.driver }, clock });
  await a.runner.start();
  await step(a, clock, 0);
  return { w, cat, printer, dir, clock, machine, config, a };
}

test('finding 3/10 (unknown = occupied): a printer the agent knows nothing about takes no job until an operator clears its bed', async () => {
  const { w, cat, printer, dir, clock, machine, a } = await bedWorkshop('unknown-bed');
  const one = await placedJob(w, cat, printer, 'One');
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.deepEqual(machine.uploads, [], 'nothing is put on a bed nobody has said is clear');
  assert.equal(logged(a, 'job.waiting')[0]?.reason, 'waiting_for_bed_clear');
  bedCleared(dir);
  await step(a, clock, 1_000);
  assert.deepEqual(machine.uploads, [`lv_${one}.gcode`]);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, one), 'printing');
  await a.stop();
});

test('finding 3/10: the machine reboots mid-print and comes back idle — the next job waits for --bed-cleared', async () => {
  const { w, cat, printer, dir, clock, machine, a } = await bedWorkshop('reboot');
  bedCleared(dir);
  await step(a, clock, 1_000);
  const one = await placedJob(w, cat, printer, 'One');
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, one), 'printing');
  // Half of job one is on the plate when the controller restarts (or the printer alone loses power).
  clock.now += 20_000;
  machine.reboot();
  await step(a, clock, 10_000);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, one), 'failed');
  assert.equal(row<Json>(w, 'SELECT reason_code FROM pc_failures WHERE job_id = ?', one)!.reason_code, 'print_lost_machine_idle');
  const two = await placedJob(w, cat, printer, 'Two');
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.deepEqual(machine.uploads, [`lv_${one}.gcode`], `job two (${two}) was started on top of job one's interrupted print`);
  assert.ok(logged(a, 'job.waiting').some((l) => l.job_id === two && l.reason === 'waiting_for_bed_clear'));
  assert.equal(jobStatus(w, two), 'preparing');
  bedCleared(dir);
  await step(a, clock, 1_000);
  assert.deepEqual(machine.uploads, [`lv_${one}.gcode`, `lv_${two}.gcode`]);
  await a.stop();
});

test('finding 3/10: a power cut takes the machine AND the agent down mid-print — after the restart the idle machine still waits', async () => {
  const { w, cat, printer, dir, clock, machine, config, a } = await bedWorkshop('powercut');
  bedCleared(dir);
  await step(a, clock, 1_000);
  const one = await placedJob(w, cat, printer, 'One');
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, one), 'printing');
  await a.stop();
  machine.reboot();
  clock.now += 60_000;
  const b = startAgent(w, config, { drivers: { 'lan-sim-1': machine.driver }, clock });
  await b.runner.start();
  await step(b, clock, 10_000);
  await step(b, clock, 10_000);
  assert.equal(jobStatus(w, one), 'failed');
  const two = await placedJob(w, cat, printer, 'Two');
  await step(b, clock, 30_000);
  await step(b, clock, 10_000);
  assert.deepEqual(machine.uploads, [`lv_${one}.gcode`], `after the restart job two (${two}) was started on top of job one's part`);
  assert.ok(logged(b, 'job.waiting').some((l) => l.job_id === two && l.reason === 'waiting_for_bed_clear'));
  await b.stop();
});

test('finding 3/10: a clearance given while a print still runs clears nothing — that print ends on the plate', async () => {
  const { w, cat, printer, dir, clock, machine, config, a } = await bedWorkshop('clear-while-printing');
  bedCleared(dir);
  await step(a, clock, 1_000);
  const one = await placedJob(w, cat, printer, 'One');
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, one), 'printing');
  // Someone runs --bed-cleared while job one is still printing…
  bedCleared(dir);
  await step(a, clock, 1_000);
  assert.ok(logged(a, 'bed.clear_refused').length >= 1, 'the clearance is refused while the machine prints');
  // …and the print then ends while the agent is down: the restarted agent finds it finished.
  await a.stop();
  clock.now += 2 * H * 1000;
  assert.equal(machine.sim().snapshot().phase, 'finished');
  const b = startAgent(w, config, { drivers: { 'lan-sim-1': machine.driver }, clock });
  await b.runner.start();
  await step(b, clock, 0);
  assert.equal(jobStatus(w, one), 'completed');
  const two = await placedJob(w, cat, printer, 'Two');
  await step(b, clock, 30_000);
  await step(b, clock, 10_000);
  assert.deepEqual(machine.uploads, [`lv_${one}.gcode`], `job two (${two}) was started on top of job one's finished part`);
  await b.stop();
});

// ================================================================= 4. PrusaSlicer: every object on one plate

interface PrusaCase {
  quantity: number;
  size?: [number, number, number];
  extraModels?: number;
  version?: string;
}

/** Each case one job, all sliced by one PrusaSlicer agent (it claims one request a tick); what it kept and what the cloud recorded. */
async function prusaSlices(cases: PrusaCase[]) {
  const { w, cat, token } = await workshop({ capabilities: ['telemetry', 'slicer'] });
  const jobs: string[] = [];
  for (const c of cases) {
    const fileId = await readyFile(w, w.a, c.size ?? [40, 30, 10]);
    const extra = [];
    for (let i = 0; i < (c.extraModels ?? 0); i++) extra.push(await readyFile(w, w.a, [30, 20, 15], `part-${i}.stl`));
    jobs.push((await analyzedJob(w, cat, { fileId, quantity: c.quantity, extraFileIds: extra })).jobId);
  }
  const versionOf = (args: string[]) => cases[jobs.findIndex((id) => args.some((x) => x.endsWith(`lv_${id}.gcode`)))]?.version;
  const clock = { now: Date.now() };
  const dir = freshDir('merge');
  const a = startAgent(w, agentConfig(token, dir, { slicer: PRUSA() }), { drivers: { 'lan-sim-1': createSimulator({}, { clock: () => clock.now }) }, clock, run: prusaRun({ runs: [] }, versionOf) });
  await a.runner.start();
  for (let i = 0; i <= cases.length; i++) await step(a, clock, 1_000);
  await a.stop();
  return jobs.map((jobId) => {
    const manifestPath = join(dir, 'prints', jobId, 'manifest.json');
    const kept = existsSync(manifestPath) ? readFileSync(join(dir, 'prints', jobId, JSON.parse(readFileSync(manifestPath, 'utf8')).name), 'utf8') : null;
    return {
      request: slicing(w, jobId),
      estimate: row<Json>(w, 'SELECT e.duration_seconds, e.model_grams FROM pc_estimates e JOIN pc_print_jobs j ON j.estimate_id = e.id WHERE j.id = ?', jobId) ?? null,
      objects: kept ? kept.split('\n').filter((l) => l.startsWith('; fake-object at ')).length : 0,
    };
  });
}

test('finding 4: PrusaSlicer slices every object of the job on one plate — quantity 3 is quoted and printed as three', async () => {
  const [one, three, two] = await prusaSlices([{ quantity: 1 }, { quantity: 3 }, { quantity: 1, extraModels: 1 }]);
  assert.equal(one.objects, 1);
  assert.equal(three.request?.status, 'succeeded', JSON.stringify(three.request));
  assert.equal(three.objects, 3, 'the kept print file holds every object of a quantity-3 job');
  assert.ok(three.estimate!.model_grams >= 3 * one.estimate!.model_grams - 1, `quantity 3 quoted at ${three.estimate!.model_grams} g; one alone is ${one.estimate!.model_grams} g`);
  assert.ok(three.estimate!.duration_seconds > 2 * one.estimate!.duration_seconds - 60);
  assert.equal(two.objects, 2, 'two different models are both in the print file');
});

test('finding 4: objects that do not fit one plate, or a PrusaSlicer that may leave them out unseen, are refused — never quoted', async () => {
  const [overflow, later, single] = await prusaSlices([
    // Two 200 × 150 mm plates each fit the bed (the cloud checks models one by one); together they do not.
    { quantity: 2, size: [200, 150, 2] },
    // PrusaSlicer 2.9+ arranges onto further beds and slices only the first (its source): with labels off, nothing counts them.
    { quantity: 2, version: '2.9.2' },
    { quantity: 1, version: '2.9.2' },
  ]);
  assert.deepEqual(overflow.request, { status: 'failed', error_code: 'OBJECTS_DO_NOT_FIT_ONE_PLATE' });
  assert.deepEqual(later.request, { status: 'failed', error_code: 'PLATE_UNVERIFIABLE' });
  assert.equal(single.request?.status, 'succeeded', 'one object needs no count');
});

// ================================================================= 5. a clearance is used exactly once

test('finding 5: a --bed-cleared flag the agent cannot delete clears nothing — and once deletable, it clears exactly once', async () => {
  const { w, cat, printer, token } = await workshop();
  const dir = freshDir('flag');
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const config = agentConfig(token, dir, { jobs: { bed_clear: 'operator', command_max_age_seconds: 3600 } });
  const a = startAgent(w, config, { drivers: { 'lan-sim-1': sim }, clock });
  await a.runner.start();
  await step(a, clock, 0);
  // `sudo … --bed-cleared` made bed-cleared/ root-owned: the agent's user may list the flag but not unlink it.
  bedCleared(dir);
  const remove = a.state.remove.bind(a.state);
  a.state.remove = (name: string) => {
    if (name.startsWith('bed-cleared/')) throw Object.assign(new Error(`EACCES: permission denied, unlink '${join(dir, name)}'`), { code: 'EACCES' });
    remove(name);
  };
  const one = await placedJob(w, cat, printer, 'One');
  for (let i = 0; i < 5; i++) await step(a, clock, 10_000);
  assert.deepEqual(sim.uploads.map((u) => u.name), [], 'a clearance that cannot be used up is not applied');
  assert.equal(logged(a, 'bed.flag_not_removable').length, 1, 'said once, not every tick');
  // The operator fixes the ownership: the flag is used, once.
  a.state.remove = remove;
  await step(a, clock, 1_000);
  assert.deepEqual(sim.uploads.map((u) => u.name), [`lv_${one}.gcode`]);
  assert.ok(!existsSync(join(dir, 'bed-cleared', bedFlagName('lan-sim-1'))));
  await step(a, clock, 10_000);
  clock.now += 2 * H * 1000;
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, one), 'completed');
  const two = await placedJob(w, cat, printer, 'Two');
  for (let i = 0; i < 3; i++) await step(a, clock, 10_000);
  assert.deepEqual(sim.uploads.map((u) => u.name), [`lv_${one}.gcode`], `job two (${two}) was started on job one's finished part`);
  await a.stop();
});

// ================================================================= 6. transforms the CLI cannot apply

test('finding 6: a model scaled, turned or oriented on its own is refused (TRANSFORM_UNSUPPORTED) — never quoted unscaled', async () => {
  const { w, cat, token } = await workshop({ capabilities: ['telemetry', 'slicer'] });
  const transforms: Json[] = [{ scale_ppm: 2_000_000 }, { rotation_x_mdeg: 90_000 }, { orientation: 'auto' }];
  const refused: string[] = [];
  for (const transform of transforms) {
    const { jobId } = await analyzedJob(w, cat, { transform });
    assert.deepEqual(JSON.parse(row<Json>(w, 'SELECT input_json FROM pc_slicing_requests WHERE job_id = ?', jobId)!.input_json).models[0].transform, transform, 'the claim carries it');
    refused.push(jobId);
  }
  // The identity, however it is written, is sliced.
  const { jobId: identity } = await analyzedJob(w, cat, { transform: { scale_ppm: 1_000_000, rotation_x_mdeg: 0, rotation_y_mdeg: 0, rotation_z_mdeg: 360_000, orientation: 'as_uploaded' } });
  const clock = { now: Date.now() };
  const calls: SlicerCalls = { runs: [] };
  const a = startAgent(w, agentConfig(token, freshDir('transform')), { drivers: { 'lan-sim-1': createSimulator({}, { clock: () => clock.now }) }, clock, run: orcaRun(calls) });
  await a.runner.start();
  for (let i = 0; i <= transforms.length + 1; i++) await step(a, clock, 1_000);
  refused.forEach((jobId, i) => assert.deepEqual(slicing(w, jobId), { status: 'failed', error_code: 'TRANSFORM_UNSUPPORTED' }, JSON.stringify(transforms[i])));
  assert.equal(slicing(w, identity)?.status, 'succeeded');
  assert.equal(calls.runs.length, 1, 'the slicer never measured an untransformed model for a transformed one');
  await a.stop();
});

// ================================================================= 7. a stalled body is bounded too

/** An OctoPrint host: GETs answered in full; a POST gets its status line, headers and 6 of 100 body bytes, then nothing. */
async function stallingOctoPrint() {
  const sockets = new Set<net.Socket>();
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST') {
        posts.push(`${req.url} ${Buffer.concat(chunks).toString()}`);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
        res.write('{"ok":');
        return; // the body never ends
      }
      const json = req.url!.startsWith('/api/job')
        ? { state: 'Printing', job: { file: { name: 'lv_other.gcode' } }, progress: { completion: 10, printTime: 60, printTimeLeft: 600 } }
        : { temperature: { tool0: { actual: 210 }, bed: { actual: 60 } }, state: { text: 'Printing' } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    posts,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/** fetch's own contract over node:http, loopback only: it resolves at the headers, streams the body, and the signal aborts either. */
function streamingFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') return Promise.reject(new Error(`the test transport only dials loopback, not ${url.host}`));
  const aborted = () => new DOMException('This operation was aborted', 'AbortError');
  return new Promise<Response>((resolve, reject) => {
    const outgoing: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      outgoing[name] = value;
    });
    const req = http.request(url, { method: init.method ?? 'GET', headers: outgoing }, (res) => {
      let settled = false;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          const fail = (e: unknown) => {
            if (settled) return;
            settled = true;
            c.error(e);
          };
          res.on('data', (chunk: Buffer) => {
            if (!settled) c.enqueue(new Uint8Array(chunk));
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            c.close();
          });
          res.on('error', fail);
          res.on('close', () => fail(new Error('connection closed before the body ended')));
          init.signal?.addEventListener(
            'abort',
            () => {
              fail(aborted());
              req.destroy();
            },
            { once: true }
          );
        },
      });
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v);
      const status = res.statusCode ?? 500;
      resolve(new Response(status === 204 || status === 304 ? null : body, { status, headers }));
    });
    req.on('error', reject);
    init.signal?.addEventListener('abort', () => req.destroy(aborted()), { once: true });
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });
}

/** How a promise ends within `ms` of real time: its value, its error's code, or «pending». */
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then((v) => ({ value: v as unknown, code: null as string | null }), (e: { code?: string }) => ({ value: null as unknown, code: String(e?.code ?? e) })), delay(ms).then(() => 'pending' as const)]);

test('finding 7 (driver): a printer host that sends its headers and stalls the body is bounded by the printer\'s timeout', async () => {
  const host = await stallingOctoPrint();
  try {
    const d = createOctoPrint({ base_url: host.url, api_key: 'octo-key', timeout_seconds: 1 }, { fetch: streamingFetch });
    assert.equal((await d.status()).state, 'printing', 'whole answers are read through this transport');
    const outcome = await within(d.pause(), 8_000);
    assert.equal(host.posts.length, 1, 'the pause reached the host');
    assert.notEqual(outcome, 'pending', 'pause() hung on the stalled body past timeout_seconds');
    assert.equal(outcome === 'pending' ? null : outcome.code, 'UNREACHABLE');
  } finally {
    host.close();
  }
});

test('finding 7 (cloud client): a response whose body stalls is a timeout, retried like any outage — never a hang', async () => {
  let calls = 0;
  const client = new CloudClient({
    baseUrl: 'https://levonis-iq.com',
    token: `pca_${'t'.repeat(40)}`,
    timeoutMs: 200,
    attempts: 2,
    sleep: async () => undefined,
    fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ start: (c) => c.enqueue(strToU8('{"success":true,')) }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const outcome = await within(client.printers(), 8_000);
  assert.notEqual(outcome, 'pending', 'the client hung on a body that never ends');
  assert.equal(calls, 2, 'each attempt was bounded, then the outage was retried');
  await assert.rejects(client.printers(), (e: unknown) => e instanceof CloudError && e.retryable && e.status === 0);
});

test('finding 7 (runner): one printer whose command never returns does not hold the loop — the other printer keeps reporting', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w, { approval: false, secondPrinter: true });
  const [simPrinter, stuckPrinter] = cat.printers;
  const { token } = await mintAgent(w, ['telemetry', 'job_control'], simPrinter, 'lan-sim-1');
  const agentId = row<Json>(w, 'SELECT agent_id FROM pc_printers WHERE id = ?', simPrinter)!.agent_id;
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printers/${stuckPrinter}`, { adapter: 'agent', agent_id: agentId, connection_ref: 'lan-stuck-1' });
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const stuckSim = createSimulator({}, { clock: () => clock.now });
  const stuck: Driver = { ...stuckSim, pause: () => new Promise<void>(() => undefined) };
  const gate = gateOf();
  const config = agentConfig(token, freshDir('stuck'), {
    printers: { 'lan-sim-1': { driver: 'simulator' }, 'lan-stuck-1': { driver: 'simulator', timeout_seconds: 1 } },
    slicer: undefined,
  });
  const a = startAgent(w, config, { drivers: { 'lan-sim-1': sim, 'lan-stuck-1': stuck }, clock, gate, run: null });
  await a.runner.start();
  await step(a, clock, 0);
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${stuckPrinter}/commands`, { command: 'pause' });
  const outcome = await within(step(a, clock, 5_000), 10_000);
  assert.notEqual(outcome, 'pending', 'a command that never returns held the whole loop');
  assert.equal(logged(a, 'command.handled').at(-1)?.outcome, 'failed');
  const before = gate.sent.filter((s) => s.path.endsWith(`/printers/${simPrinter}/telemetry`)).length;
  await step(a, clock, 10_000);
  assert.ok(gate.sent.filter((s) => s.path.endsWith(`/printers/${simPrinter}/telemetry`)).length > before, 'the other printer kept reporting');
  await a.stop();
});

// ================================================================= 8 + 13. Bambu MQTT

/** A fake Bambu printer's MQTT side: SUBACK as told, `pushall` answered with what it holds NOW; it can go dark. */
async function fakeBambu(o: { report: Json; granted?: number }) {
  const s = { report: o.report, down: false };
  const open = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((sock) => {
    accepted++;
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    sock.on('error', () => undefined);
    const reader = new PacketReader();
    sock.on('data', (d) => {
      for (const p of reader.push(d)) {
        if (p.type === 'connect') {
          if (s.down) sock.destroy();
          else sock.write(encodeConnack({ returnCode: 0 }));
        } else if (p.type === 'subscribe') sock.write(encodeSuback({ packetId: p.packetId, granted: p.topics.map(() => o.granted ?? 0) }));
        else if (p.type === 'pingreq') sock.write(encodePingresp());
        else if (p.type === 'disconnect') sock.end();
        else if (p.type === 'publish' && (JSON.parse(p.payload.toString()) as Json).pushing?.command === 'pushall') {
          sock.write(encodePublish({ topic: 'device/SN0001/report', payload: { print: s.report } }));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    s,
    open,
    accepted: () => accepted,
    connect: () =>
      new Promise<net.Socket>((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        sock.once('connect', () => resolve(sock));
        sock.once('error', reject);
      }),
    drop: () => open.forEach((c) => c.destroy()),
    close: () => {
      open.forEach((c) => c.destroy());
      server.close();
    },
  };
}

const until = async (cond: () => boolean, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await delay(5);
  assert.ok(cond(), what);
};

test('finding 8: a Bambu connection whose SUBSCRIBE is refused is closed — not left open on the printer', async () => {
  const printer = await fakeBambu({ report: {}, granted: 0x80 });
  let now = 1_000_000;
  const driver = createBambu({ host: '127.0.0.1', serial: 'SN0001', access_code: 'abcd1234', tls: { mode: 'insecure' } }, { connectMqtt: printer.connect, clock: () => now, reconnectMs: 1000 });
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await assert.rejects(driver.status(), /no report from the printer/);
      assert.equal(printer.accepted(), attempt, `attempt ${attempt} opened a new connection`);
      now += 61_000;
    }
    await until(() => printer.open.size === 0, `after ${printer.accepted()} refused subscriptions ${printer.open.size} connection(s) were still open on the printer`, 3_000);
  } finally {
    await driver.close();
    printer.close();
  }
});

const RUNNING = { gcode_state: 'RUNNING', mc_percent: 42, mc_remaining_time: 13, layer_num: 5, total_layer_num: 100, nozzle_temper: 219.6, bed_temper: 55, subtask_name: 'lv_pcj_7', print_error: 0 };
const IDLE = { gcode_state: 'IDLE', mc_percent: 0, mc_remaining_time: 0, layer_num: 0, total_layer_num: 0, nozzle_temper: 24, bed_temper: 23, subtask_name: '', gcode_file: '', print_error: 0 };

test('finding 13: after an MQTT reconnect the Bambu driver never returns the report from before the disconnect as current', async () => {
  const printer = await fakeBambu({ report: RUNNING });
  let now = Date.now();
  const warns: string[] = [];
  const log = { debug() {}, info() {}, error() {}, warn: (m: string) => warns.push(m), child: () => log };
  const driver = createBambu({ host: '127.0.0.1', serial: 'SN0001', access_code: 'abcd1234', tls: { mode: 'insecure' } }, { connectMqtt: printer.connect, log, clock: () => now, reconnectMs: 1 });
  try {
    await driver.connect!();
    await until(() => driver.debugReport().report !== null, 'the first pushall answer arrived');
    assert.deepEqual([(await driver.status()).state, (await driver.status()).file], ['printing', 'lv_pcj_7']);
    printer.s.down = true;
    printer.drop();
    await until(() => warns.includes('bambu.mqtt.closed'), 'the driver saw the connection close');
    await assert.rejects(driver.status(), (e: Json) => e.code === 'UNREACHABLE');
    // The printer comes back, rebooted: idle. The first look after the reconnect must not be the old «printing 42 %».
    printer.s.report = IDLE;
    printer.s.down = false;
    now += 60_000;
    const first = await driver.status().then(
      (st) => `${st.state}:${st.file ?? ''}`,
      (e: Json) => `threw:${e.code}`
    );
    assert.notEqual(first, 'printing:lv_pcj_7', 'the pre-disconnect report was returned as current');
    await until(() => driver.debugReport().report?.gcode_state === 'IDLE', 'the post-reconnect pushall answer arrived');
    assert.equal((await driver.status()).state, 'idle');
  } finally {
    await driver.close();
    printer.close();
  }
});

// ================================================================= 9. a finish seen while the record is paused

async function printingJob(o: { verification?: boolean } = {}) {
  const { w, cat, printer, token } = await workshop({ verification: o.verification });
  const { jobId } = await analyzedJob(w, cat);
  const dir = freshDir('paused');
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const gate = gateOf();
  const config = agentConfig(token, dir);
  const a = startAgent(w, config, { drivers: { 'lan-sim-1': sim }, clock, gate });
  await a.runner.start();
  await step(a, clock, 0);
  await confirmJob(w, jobId);
  assert.equal((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned.length, 1);
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'printing');
  return { w, printer, jobId, dir, clock, sim, gate, config, a };
}

for (const verification of [false, true]) {
  test(`finding 9 [verification ${verification ? 'on' : 'off'}]: paused by the machine, resumed AT the printer and finished out of sight — the completion reaches the cloud once`, async () => {
    const { w, jobId, dir, clock, sim, a } = await printingJob({ verification });
    sim.pauseFromMachine(); // a filament runout
    await step(a, clock, 10_000);
    assert.equal(jobStatus(w, jobId), 'paused');
    sim.setReachable(false); // the agent loses sight of the machine
    await step(a, clock, 10_000);
    await sim.resume(); // an operator resumes it at the printer…
    clock.now += 200_000; // …and it finishes
    assert.equal(sim.snapshot().phase, 'finished');
    sim.setReachable(true);
    await step(a, clock, 10_000);
    await step(a, clock, 10_000);
    const events = trail(dir, jobId);
    assert.ok(!events.some((e) => e[1] === 'refused'), `an event was refused: ${JSON.stringify(events)}`);
    if (verification) {
      assert.equal(rows(w, 'SELECT 1 FROM pc_consumption_records WHERE job_id = ? AND verified = 0', jobId).length, 1, 'the completion waits for an operator');
    } else assert.equal(jobStatus(w, jobId), 'completed');
    assert.equal(rows(w, "SELECT 1 FROM pc_print_job_events WHERE job_id = ? AND event IN ('completed', 'completion_reported')", jobId).length, 1, 'exactly once');
    await a.stop();
  });
}

test('finding 9: the agent is DOWN while the paused print is resumed and finishes — the restarted agent completes it', async () => {
  const { w, jobId, clock, sim, gate, config, a } = await printingJob();
  sim.pauseFromMachine();
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'paused');
  await a.stop();
  await sim.resume();
  clock.now += 200_000;
  const b = startAgent(w, config, { drivers: { 'lan-sim-1': sim }, clock, gate });
  await b.runner.start();
  assert.equal(b.runner.jobs.get(jobId)?.phase, 'paused');
  await step(b, clock, 0);
  await step(b, clock, 30_000);
  assert.equal(jobStatus(w, jobId), 'completed');
  await b.stop();
});

test('finding 9: paused in the console only (the machine kept printing) — the finish still completes the job', async () => {
  const { w, jobId, clock, a } = await printingJob();
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/pause`, { reason: 'checking the plate' });
  assert.equal(jobStatus(w, jobId), 'paused');
  await step(a, clock, 200_000);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'completed');
  await a.stop();
});

// ================================================================= 11. printed_seconds: only time seen printing

/** A sliced (2-minute estimate), confirmed and queued job, for a machine with no print clock of its own. */
async function startedWithoutPrintClock(settings: Record<string, unknown>, o: { timeScale?: number; otherFileSeconds?: number; manual?: boolean } = {}) {
  const { w, cat, token } = await workshop({ settings, verification: (settings.agent_reports_need_verification as boolean | undefined) ?? false });
  const { jobId } = await analyzedJob(w, cat);
  const clock = { now: Date.now() };
  // The agent's own files state their time (2 min); `print_seconds` is what a file stating none takes (the operator's own).
  const sim = createSimulator({ time_scale: o.timeScale ?? 1, print_seconds: o.otherFileSeconds ?? 60 }, { clock: () => clock.now });
  const machine = noPrintClock(sim);
  const config = agentConfig(token, freshDir('printed'), { jobs: { bed_clear: 'assume_clear', command_max_age_seconds: 3600, start_mode: o.manual ? 'manual' : 'auto' } });
  const a = startAgent(w, config, { drivers: { 'lan-sim-1': machine }, clock });
  await a.runner.start();
  await step(a, clock, 0);
  await confirmJob(w, jobId);
  assert.equal((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned.length, 1);
  return { w, jobId, sim, machine, config, a, clock };
}
const printedSeconds = (w: World, jobId: string) => row<{ printed_seconds: number }>(w, 'SELECT printed_seconds FROM pc_consumption_records WHERE job_id = ?', jobId)?.printed_seconds;

test('finding 11: a 2-minute print and the agent down for 6 h — the 6 h are not printed seconds', async () => {
  const { w, jobId, sim, machine, config, a, clock } = await startedWithoutPrintClock({ time_overage_policy: 'charge_from_balance' });
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'printing');
  await a.stop();
  clock.now += 6 * H * 1000;
  assert.equal(sim.snapshot().phase, 'finished');
  const b = startAgent(w, config, { drivers: { 'lan-sim-1': machine }, clock });
  await b.runner.start();
  await step(b, clock, 0);
  assert.equal(jobStatus(w, jobId), 'completed');
  const printed = printedSeconds(w, jobId)!;
  assert.ok(printed <= 120, `a 120 s print reported as printed_seconds=${printed}`);
  await b.stop();
});

test('finding 11: the printer unreachable for an hour — the hour is not printed seconds', async () => {
  // time_scale 2: the machine prints the 120 s file in 60 s.
  const { w, jobId, sim, a, clock } = await startedWithoutPrintClock({ agent_reports_need_verification: true }, { timeScale: 2 });
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  sim.setReachable(false);
  for (let i = 0; i < 6; i++) await step(a, clock, 600_000);
  sim.setReachable(true);
  await step(a, clock, 10_000);
  const printed = printedSeconds(w, jobId)!;
  assert.ok(printed <= 60, `a 60 s print reported as printed_seconds=${printed}`);
  await a.stop();
});

test('finding 11: a one-minute agent restart in the middle of an hour-long print loses only the minute it did not see', async () => {
  // time_scale 1/30 runs the 120 s file for 3600 s.
  const { w, jobId, machine, config, a, clock } = await startedWithoutPrintClock({}, { timeScale: 1 / 30 });
  await step(a, clock, 30_000);
  for (let i = 0; i < 300; i++) await step(a, clock, 10_000); // ≈ 50 min watched
  await a.stop();
  clock.now += 60_000; // an update: down for a minute
  const b = startAgent(w, config, { drivers: { 'lan-sim-1': machine }, clock });
  await b.runner.start();
  for (let i = 0; i < 80 && jobStatus(w, jobId) !== 'completed'; i++) await step(b, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'completed');
  const printed = printedSeconds(w, jobId)!;
  assert.ok(printed >= 3600 - 60 - 30 && printed <= 3600 - 60 + 10, `a 3600 s print with one unseen minute reported as printed_seconds=${printed}`);
  await b.stop();
});

test('finding 11: a manual start after the operator ran another file first — that file\'s hour is not this job\'s', async () => {
  const { w, jobId, sim, a, clock } = await startedWithoutPrintClock({}, { manual: true, otherFileSeconds: H });
  await step(a, clock, 30_000);
  assert.deepEqual(sim.uploads.map((u) => u.name), [`lv_${jobId}.gcode`], 'uploaded, waiting for someone to start it');
  await sim.upload({ name: 'workshop_own.gcode', bytes: Buffer.from('G28\n') });
  await sim.start({ name: 'workshop_own.gcode' });
  for (let i = 0; i < 400 && sim.snapshot().phase !== 'finished'; i++) await step(a, clock, 10_000);
  await sim.start({ name: `lv_${jobId}.gcode` });
  for (let i = 0; i < 20 && jobStatus(w, jobId) !== 'completed'; i++) await step(a, clock, 10_000);
  assert.equal(jobStatus(w, jobId), 'completed');
  const printed = printedSeconds(w, jobId)!;
  assert.ok(printed <= 130, `the job printed 120 s; reported printed_seconds=${printed}`);
  await a.stop();
});

// ================================================================= 12. a job-door refusal is final

async function doorWorld(capabilities: string[]) {
  const { w, cat, printer, token } = await workshop({ capabilities });
  const { jobId } = await analyzedJob(w, cat);
  const dir = freshDir('door');
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const gate = gateOf();
  const a = startAgent(w, agentConfig(token, dir), { drivers: { 'lan-sim-1': sim }, clock, gate });
  await a.runner.start();
  await step(a, clock, 0); // the agent slices the job: its own slice is cached
  await confirmJob(w, jobId);
  return { w, cat, printer, token, jobId, dir, clock, sim, gate, a };
}
const doorCalls = (gate: Gate, jobId: string) => gate.sent.filter((s) => s.method === 'GET' && s.path === `${AGENT}/jobs/${jobId}`);

test('finding 12: the job door answers 409 (the printer model no longer fits the job) — the job is stalled once, not re-asked every tick', async () => {
  const { w, cat, printer, jobId, dir, clock, sim, gate, a } = await doorWorld(['telemetry', 'job_control', 'slicer']);
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printer_models/${cat.model}`, { supported_materials_json: ['PETG'] });
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: jobId, printer_id: printer }]);
  gate.sent.length = 0;
  await step(a, clock, 30_000);
  for (let i = 0; i < 20; i++) await step(a, clock, 1_000);
  assert.ok(doorCalls(gate, jobId).length <= 1, `GET /jobs/${jobId} was asked ${doorCalls(gate, jobId).length} times in 21 ticks`);
  assert.deepEqual([recordOf(dir, jobId).phase, recordOf(dir, jobId).stall_reason], ['stalled', 'job_door_INCOMPATIBLE_PRINTER']);
  assert.equal(sim.uploads.length, 0);
  await a.stop();
});

test('finding 12: a token without job_control is refused by the job door — nothing is put on the machine, job control stops', async () => {
  const { w, printer, jobId, dir, clock, sim, gate, a } = await doorWorld(['telemetry', 'slicer']);
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: jobId, printer_id: printer }]);
  gate.sent.length = 0;
  await step(a, clock, 30_000);
  for (let i = 0; i < 20; i++) await step(a, clock, 1_000);
  assert.ok(doorCalls(gate, jobId).length <= 1, `GET /jobs/${jobId} was asked ${doorCalls(gate, jobId).length} times`);
  assert.ok(gate.sent.filter((s) => s.path === `${AGENT}/printers`).length <= 2, 'GET /printers only at its own interval');
  assert.equal(sim.uploads.length, 0, 'a token without job_control never prints');
  assert.equal(a.runner.disabled.job_control, true);
  assert.equal(recordOf(dir, jobId).phase, 'stalled');
  await a.stop();
});

test('finding 12: the door refuses at the last check before the start (the model edited while the job waited for the bed) — stalled, not looped', async () => {
  const { w, cat, printer, token, jobId, dir, clock, sim, gate, a } = await doorWorld(['telemetry', 'job_control', 'slicer']);
  // The last print's plate is still on the bed: the agent restarts knowing it (bed_clear: operator).
  await a.stop();
  writeFileSync(join(dir, 'bed.json'), JSON.stringify({ [printer]: { occupied: true, since: new Date().toISOString(), reason: 'finished' } }));
  const b = startAgent(w, agentConfig(token, dir, { jobs: { bed_clear: 'operator', command_max_age_seconds: 3600 } }), { drivers: { 'lan-sim-1': sim }, clock, gate });
  await b.runner.start();
  assert.deepEqual((await ok(w.assistant, 'POST', `${ADMIN}/queue/run`)).assigned, [{ job_id: jobId, printer_id: printer }]);
  await step(b, clock, 30_000);
  assert.equal(logged(b, 'job.waiting')[0]?.reason, 'waiting_for_bed_clear');
  assert.equal(recordOf(dir, jobId).phase, 'uploading');
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/printer_models/${cat.model}`, { supported_materials_json: ['PETG'] });
  bedCleared(dir);
  gate.sent.length = 0;
  for (let i = 0; i < 20; i++) await step(b, clock, 1_000);
  assert.ok(doorCalls(gate, jobId).length <= 1, `GET /jobs/${jobId} was asked ${doorCalls(gate, jobId).length} times in 20 ticks`);
  assert.equal(recordOf(dir, jobId).phase, 'stalled');
  await b.stop();
});

// ================================================================= 14. a lock from before this boot

const bootedAt = () => Date.now() - uptime() * 1000;

test('finding 14: an agent.lock left before this boot is held by nobody, whatever its old pid names now', () => {
  for (const [label, pid] of [
    ['pid 1, always alive', 1],
    ...(process.platform === 'linux' ? [['one of this process\'s own threads', readdirSync('/proc/self/task').map(Number).find((t) => t !== process.pid) ?? process.ppid] as const] : []),
  ] as Array<readonly [string, number]>) {
    const dir = freshDir('lock');
    AgentState.open(dir); // the run before the power cut: never closed
    writeFileSync(join(dir, 'agent.lock'), JSON.stringify({ pid, since: new Date(bootedAt() - H * 1000).toISOString() }));
    let after: AgentState | null = null;
    try {
      after = AgentState.open(dir);
    } catch (e) {
      if (e instanceof StateError) assert.fail(`${label}: the agent refused to start after the reboot: ${e.code} — ${e.message}`);
      throw e;
    }
    assert.equal(after.boot, 2, label);
    after.close();
  }
  // A live holder from this boot is still refused.
  const dir = freshDir('lock-live');
  writeFileSync(join(dir, 'agent.lock'), JSON.stringify({ pid: process.ppid, since: new Date().toISOString() }));
  assert.throws(() => AgentState.open(dir), (e: unknown) => e instanceof StateError && e.code === 'STATE_LOCKED');
});

// ================================================================= 15. commands committed out of stamp order

async function commandsWorld() {
  const { w, printer, token } = await workshop({ capabilities: ['telemetry', 'job_control'] });
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const a = startAgent(w, agentConfig(token, freshDir('commands'), { slicer: undefined }), { drivers: { 'lan-sim-1': sim }, clock, run: null });
  await a.runner.start();
  await step(a, clock, 0); // the first run takes the (empty) history
  return { w, printer, sim, clock, a };
}

test('finding 15: a command stamped before, but committed after, another one is still executed', async () => {
  const { w, printer, sim, clock, a } = await commandsWorld();
  // A's light_on is stamped as its request starts; right before A's batch commits, B's light_off (stamped later)
  // commits and the agent polls — so the agent's cursor passes A's stamp before A exists.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_printer_events') && s.includes("'command'"));
  w.race.hook = async () => {
    await delay(6);
    await ok(w.full, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'light_off' });
    await step(a, clock, 5_000);
  };
  const first = await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'light_on' });
  const stampA = row<{ created_at: string }>(w, 'SELECT created_at FROM pc_printer_events WHERE id = ?', first.command_id)!.created_at;
  const stampB = row<{ created_at: string }>(w, "SELECT created_at FROM pc_printer_events WHERE kind = 'command' AND id <> ?", first.command_id)!.created_at;
  assert.ok(stampA < stampB, 'precondition: A is stamped before B');
  assert.deepEqual(logged(a, 'command.handled').map((h) => h.command), ['light_off']);
  for (let i = 0; i < 6; i++) await step(a, clock, 5_000);
  assert.deepEqual(logged(a, 'command.handled').map((h) => h.command).sort(), ['light_off', 'light_on']);
  assert.deepEqual(sim.lights, [false, true]);
  await a.stop();
});

test('finding 15 (guard): a burst of 100 handled commands inside the look-back does not hide a newer one; none runs twice', async () => {
  const { w, printer, sim, clock, a } = await commandsWorld();
  for (let i = 0; i < 100; i++) await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'light_on' });
  await step(a, clock, 5_000);
  assert.equal(logged(a, 'command.handled').length, 100);
  await ok(w.assistant, 'POST', `${ADMIN}/printers/${printer}/commands`, { command: 'light_off' });
  for (let i = 0; i < 4; i++) await step(a, clock, 5_000);
  assert.equal(logged(a, 'command.handled').length, 101);
  assert.equal(new Set(logged(a, 'command.handled').map((h) => h.command_id)).size, 101);
  assert.equal(sim.lights.at(-1), false);
  await a.stop();
});

// ================================================================= the new pieces, one by one

/** A ZIP written as a stream: each entry followed by a data descriptor (its sizes after the data), as some tools write a 3MF. */
function streamedZip(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, data, final) => {
      if (err) return reject(err);
      chunks.push(data);
      if (final) resolve(Buffer.concat(chunks));
    });
    for (const [name, body] of Object.entries(files)) {
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(strToU8(body), true);
    }
    zip.end();
  });
}

test('finding 1 (agent): the 3MF guard — carriers refused however they are named, the saved config removed byte-exactly, an unreadable archive refused', async () => {
  for (const part of [
    'Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml',
    'metadata/PRUSA_SLICER_CUSTOM_GCODE_PER_PRINT_Z.XML',
    'Metadata\\custom_gcode_per_layer.xml',
    'other/folder/Custom_GCode_Per_Layer.xml',
    'Metadata/plate_1.gcode',
    'Metadata/plate_2.BGCODE',
  ]) {
    const r = screen3mf(Buffer.from(project3mf({ parts: { [part]: 'M211 S0' } })));
    assert.equal(r.ok ? 'ok' : r.error_code, 'UNSUPPORTED_MODEL_CONTENT', part);
  }
  // The saved slicer configuration goes; every other part is kept byte for byte (two independent readers agree).
  const project = Buffer.from(project3mf({ parts: { 'Metadata/Slic3r_PE.config': EMBEDDED_CONFIG, 'Metadata/project_settings.config': '{"machine_start_gcode":"M211 S0"}', 'Metadata/Slic3r_PE_model.config': '<config/>' } }));
  const screened = screen3mf(project);
  assert.ok(screened.ok);
  assert.deepEqual([...screened.removed].sort(), ['Metadata/Slic3r_PE.config', 'Metadata/project_settings.config']);
  const before = unzipSync(project);
  const after = unzipSync(screened.bytes);
  assert.deepEqual(Object.keys(after).sort(), ['3D/3dmodel.model', 'Metadata/Slic3r_PE_model.config', '[Content_Types].xml', '_rels/.rels']);
  for (const name of Object.keys(after)) {
    assert.deepEqual(Buffer.from(after[name]), Buffer.from(before[name]), name);
    assert.deepEqual(readZip(screened.bytes).read(name), Buffer.from(before[name]), name);
  }
  // A clean archive is handed on untouched.
  const clean = Buffer.from(project3mf());
  const same = screen3mf(clean);
  assert.ok(same.ok && same.bytes === clean && same.removed.length === 0);
  // A streamed archive (data descriptors) is rewritten with its sizes in the local headers.
  const streamed = await streamedZip({ '3D/3dmodel.model': '<model/>', 'Metadata/Slic3r_PE.config': EMBEDDED_CONFIG });
  assert.ok((streamed[6]! | (streamed[7]! << 8)) & 0x8, 'precondition: the source writes data descriptors');
  const rewritten = zipWithout(streamed, new Set(['Metadata/Slic3r_PE.config']));
  assert.equal((rewritten[6]! | (rewritten[7]! << 8)) & 0x8, 0);
  assert.deepEqual(Object.keys(unzipSync(rewritten)), ['3D/3dmodel.model']);
  assert.equal(readZip(rewritten).read('3D/3dmodel.model')!.toString(), '<model/>');
  // What this reader cannot read is refused, never passed on: the slicer may read what it cannot.
  for (const bad of [Buffer.from('PK\u0003\u0004garbage'), Buffer.from('not a zip at all')]) {
    const r = screen3mf(bad);
    assert.equal(r.ok ? 'ok' : r.error_code, 'UNSUPPORTED_MODEL_CONTENT');
  }
});

test('finding 1 (cloud): inspect3mfArchive names the carrier part, and the upload check refuses it as MODEL_CONTAINS_GCODE — not FILE_REJECTED', async () => {
  const model = strToU8('<model><resources/></model>');
  for (const part of ['Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml', 'METADATA/CUSTOM_GCODE_PER_LAYER.XML', 'Metadata\\Custom_Gcode_Per_Layer.xml', 'Metadata/plate_1.gcode', 'x/plate.bgcode']) {
    const archive = zipSync({ '3D/3dmodel.model': model, [part]: strToU8('M211 S0') });
    const inspected = inspect3mfArchive(archive);
    assert.deepEqual([inspected.ok, inspected.gcodePart, inspected.reason], [false, part, undefined], part);
    await assert.rejects(validateUpload(archive, 'bracket.3mf', 1_000_000), (e: { code?: string; status?: number; details?: Json }) => e.code === 'MODEL_CONTAINS_GCODE' && e.status === 422 && e.details?.part === part);
  }
  // A slicer-saved project (its config, thumbnails, per-object settings) is a model, accepted.
  const saved = zipSync({ '3D/3dmodel.model': model, 'Metadata/Slic3r_PE.config': strToU8(EMBEDDED_CONFIG), 'Metadata/thumbnail.png': strToU8('png'), 'Metadata/model_settings.config': strToU8('<config/>'), 'Metadata/plate_1.gcode.md5': strToU8('x') });
  assert.equal(inspect3mfArchive(saved).ok, true);
  const w = pcWords('MODEL_CONTAINS_GCODE');
  assert.ok(w.ar && w.en && w.ckb && w.ckb !== w.ar);
});

test('finding 4: the plate check reads only the print itself, against the bed the file states', async () => {
  const dir = freshDir('plate');
  let n = 0;
  const file = (o: { version?: string; relative?: boolean; at?: [number, number]; bed?: string | null } = {}) => {
    const [x, y] = o.at ?? [100, 100];
    const lines = [
      `; generated by PrusaSlicer ${o.version ?? '2.7.2'}+linux-x64-GTK3 on 2026-10-27 at 10:00:00 UTC`,
      'M190 S60',
      ';TYPE:Custom',
      'G28',
      o.relative ? 'M83' : 'M82',
      'G92 E0',
      // The start G-code's purge line runs outside the print area: not the print.
      'G1 Y-3 F1000',
      'G1 X60 E9 F1000',
      'G92 E0',
      ';LAYER_CHANGE',
      ';Z:0.2',
      ';TYPE:External perimeter',
      `G1 X${x} Y${y}`,
      `G1 X${x + 20} Y${y} E${o.relative ? '.5' : '1.5'}`,
      // A retraction, then a travel far outside the bed: no extrusion, not the print.
      `G1 E${o.relative ? '-.8' : '0.7'}`,
      'G1 X400 Y400 F7800',
      ';TYPE:Custom',
      'G1 X0 Y200 F3000',
      '; filament used [g] = 1.00',
      '; estimated printing time (normal mode) = 1m 0s',
      ...(o.bed === null ? [] : [`; bed_shape = ${o.bed ?? '0x0,250x0,250x210,0x210'}`]),
    ];
    const path = join(dir, `g-${++n}.gcode`);
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  };
  assert.equal(await prusaPlateProblem(file(), 1), null);
  assert.equal(await prusaPlateProblem(file({ relative: true }), 3), null);
  assert.equal((await prusaPlateProblem(file({ at: [480, 100] }), 2))?.code, 'OBJECTS_DO_NOT_FIT_ONE_PLATE');
  assert.equal((await prusaPlateProblem(file({ bed: '-5x-5,245x-5,245x205,-5x205', at: [-40, 50] }), 1))?.code, 'OBJECTS_DO_NOT_FIT_ONE_PLATE');
  assert.equal((await prusaPlateProblem(file({ bed: null }), 1))?.code, 'PLATE_UNVERIFIABLE');
  assert.equal((await prusaPlateProblem(file({ version: '2.9.2' }), 2))?.code, 'PLATE_UNVERIFIABLE');
  assert.equal(await prusaPlateProblem(file({ version: '2.9.2' }), 1), null);
  assert.equal(await prusaPlateProblem(file({ version: '2.8.1' }), 2), null);
});

test('finding 6: identityTransform — unscaled, whole turns only, oriented as the job; anything else, an unknown key too, is not', () => {
  for (const t of [undefined, null, {}, { scale_ppm: 1_000_000 }, { rotation_z_mdeg: 360_000 }, { rotation_x_mdeg: -360_000 }, { orientation: 'as_uploaded' }]) {
    assert.equal(identityTransform(t, 'as_uploaded'), true, JSON.stringify(t));
  }
  assert.equal(identityTransform({ orientation: 'auto' }, 'auto'), true);
  for (const t of [{ scale_ppm: 999_999 }, { rotation_z_mdeg: 90_000 }, { rotation_y_mdeg: 1.5 }, { orientation: 'auto' }, { mirror_x: true }, [], 'x']) {
    assert.equal(identityTransform(t, 'as_uploaded'), false, JSON.stringify(t));
  }
  assert.equal(identityTransform({ orientation: 'as_uploaded' }, 'auto'), false, 'a model kept as uploaded in a job oriented automatically');
});

test('finding 14: the lock records this boot — a lock of another boot is taken over, a live holder of this boot is not', { skip: existsSync('/proc/sys/kernel/random/boot_id') ? false : 'no kernel boot id here (the time fallback is tested above)' }, () => {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const dir = freshDir('boot-id');
  const s = AgentState.open(dir);
  assert.equal(JSON.parse(readFileSync(join(dir, 'agent.lock'), 'utf8')).boot_id, bootId);
  s.close();
  // A live pid in a lock of another boot — even one whose clock reads «just now» — holds nothing.
  writeFileSync(join(dir, 'agent.lock'), JSON.stringify({ pid: process.ppid, boot_id: 'a-boot-before-the-power-cut', since: new Date().toISOString() }));
  AgentState.open(dir).close();
  // This boot and a live holder, even with a clock that reads «before the boot»: refused.
  writeFileSync(join(dir, 'agent.lock'), JSON.stringify({ pid: process.ppid, boot_id: bootId, since: new Date(bootedAt() - H * 1000).toISOString() }));
  assert.throws(() => AgentState.open(dir), (e: unknown) => e instanceof StateError && e.code === 'STATE_LOCKED');
});

test('finding 5 (CLI): only the agent\'s own user writes a --bed-cleared flag — another user\'s could never be used up', async () => {
  assert.match(String(flagWriterProblem(join(TMP, 'no-such-state'))), /does not exist yet/);
  const mine = freshDir('flag-owner');
  assert.equal(flagWriterProblem(mine), null);
  if (process.getuid?.() !== 0) return; // the other-owner case needs root to hand a directory to another user
  chownSync(mine, 65534, 65534);
  const cfgPath = join(TMP, `flag-owner-${dirs}.json`);
  writeFileSync(cfgPath, JSON.stringify({ cloud: { base_url: 'https://levonis-iq.com', token_env: 'T' }, state_dir: mine, printers: { 'lan-1': { driver: 'simulator' } } }));
  const out: string[] = [];
  assert.equal(await main(['--config', cfgPath, '--bed-cleared', 'lan-1'], { env: { T: `pca_${'x'.repeat(40)}` }, print: (s) => out.push(s), signals: false }), 64);
  assert.match(out.join('\n'), /agent's own user \(uid 65534/);
  assert.equal(existsSync(join(mine, 'bed-cleared')), false, 'nothing was written');
});

test('finding 3/10 (unknown = occupied): an unreadable bed.json is no knowledge at all — the agent starts, and the bed waits for a clearance', async () => {
  const { w, cat, printer, token } = await workshop();
  const dir = freshDir('bed-unreadable');
  writeFileSync(join(dir, 'bed.json'), `{"${printer}": {"occupied": fal`);
  const clock = { now: Date.now() };
  const sim = createSimulator({}, { clock: () => clock.now });
  const a = startAgent(w, agentConfig(token, dir, { jobs: { bed_clear: 'operator', command_max_age_seconds: 3600 } }), { drivers: { 'lan-sim-1': sim }, clock });
  await a.runner.start();
  await step(a, clock, 0);
  assert.equal(logged(a, 'bed.unreadable').length, 1);
  await placedJob(w, cat, printer, 'One');
  await step(a, clock, 30_000);
  await step(a, clock, 10_000);
  assert.deepEqual(sim.uploads, []);
  assert.equal(logged(a, 'job.waiting')[0]?.reason, 'waiting_for_bed_clear');
  await a.stop();
});

// ================================================================= against a real PrusaSlicer (opt-in)

const REAL_PRUSA = process.env.PRUSA_SLICER_CLI;

test(
  'real PrusaSlicer (opt-in, PRUSA_SLICER_CLI=<binary>): every object on one plate, labels off, the saved config removed, the figures its own',
  { skip: REAL_PRUSA ? false : 'set PRUSA_SLICER_CLI to a prusa-slicer binary to run this against it', timeout: 600_000 },
  async () => {
    const slicer = createSlicer({ ...PRUSA(), cli_path: REAL_PRUSA, timeout_ms: 300_000 });
    const work = freshDir('real-prusa');
    const input = (jobId: string, models: Array<{ file_id: string; quantity: number }>) => ({
      job_id: jobId,
      printer_model: { code: 'BBL-X2D-COMBO' },
      settings: { nozzle_um: 400, layer_height_um: 200, infill_percent: 15, walls: 2, supports: 'none', brim: false, orientation: 'as_uploaded', pause_at_layers: [] },
      copies: 1,
      plate: null,
      variants: [{ variant_id: 'v', sku: 'PLA-W', material: 'PLA', color_hex: '#FFFFFF' }],
      models: models.map((m) => ({ project_model_id: `pm_${m.file_id}`, file_id: m.file_id, quantity: m.quantity, transform: {}, material_assignments: [{ part: 'default', variant_id: 'v' }] })),
    });
    const sliceOf = async (jobId: string, files: Record<string, { ext: string; bytes: Buffer }>, models: Array<{ file_id: string; quantity: number }>) => {
      const local = new Map<string, string>();
      for (const [id, f] of Object.entries(files)) {
        let bytes = f.bytes;
        if (f.ext === '3mf') {
          const screened = screen3mf(bytes);
          assert.ok(screened.ok);
          bytes = screened.bytes;
        }
        const path = join(work, `${id}.${f.ext}`);
        writeFileSync(path, bytes);
        local.set(id, path);
      }
      const dir = join(work, jobId);
      mkdirSync(dir);
      return slicer.slice({ input: input(jobId, models), files: local, workDir: dir });
    };
    // A 3MF with a forging, newline-bearing object name and a saved config of customer start / layer G-code.
    const evil = await sliceOf('pcj_evil', { pcf_evil: { ext: '3mf', bytes: Buffer.from(project3mf({ name: `Benchy total estimated time: 1s;\n${CUSTOMER_LINES[0]}\n;filament used [g] = 0.01`, parts: { 'Metadata/Slic3r_PE.config': EMBEDDED_CONFIG } })) } }, [{ file_id: 'pcf_evil', quantity: 1 }]);
    const honest = await sliceOf('pcj_honest', { pcf_honest: { ext: '3mf', bytes: Buffer.from(project3mf()) } }, [{ file_id: 'pcf_honest', quantity: 1 }]);
    assert.ok(evil.ok && honest.ok, JSON.stringify({ evil, honest }));
    const gcode = readFileSync(evil.printFile, 'utf8');
    assert.deepEqual(customerLinesIn([gcode]), []);
    assert.ok(!gcode.includes('Benchy'), 'no object name in the G-code');
    assert.deepEqual([evil.estimate.duration_seconds, evil.estimate.materials], [honest.estimate.duration_seconds, honest.estimate.materials], 'the slicer\'s own figures');
    // Quantity 3 of one STL: all three on the plate.
    const one = await sliceOf('pcj_q1', { pcf_box: { ext: 'stl', bytes: Buffer.from(boxStl(20, 20, 10)) } }, [{ file_id: 'pcf_box', quantity: 1 }]);
    const three = await sliceOf('pcj_q3', { pcf_box: { ext: 'stl', bytes: Buffer.from(boxStl(20, 20, 10)) } }, [{ file_id: 'pcf_box', quantity: 3 }]);
    assert.ok(one.ok && three.ok, JSON.stringify({ one, three }));
    // The slicer's own unrounded grams (the estimate rounds each job up to whole grams).
    const grams = (path: string) => Number(/^; filament used \[g\] = ([\d.]+)$/m.exec(readFileSync(path, 'utf8'))?.[1]);
    const ratio = grams(three.printFile) / grams(one.printFile);
    assert.ok(ratio > 2.8 && ratio < 3.2, `three objects used ${grams(three.printFile)} g, one ${grams(one.printFile)} g`);
    // Two plates that each fit the bed but not together. (Half-millimetre sizes: PrusaSlicer 2.7 takes a binary STL
    // for ASCII when no byte after its header is above 127, which whole 200 / 150 / 2 mm corners happen to give.)
    const overflow = await sliceOf('pcj_wide', { pcf_plate: { ext: 'stl', bytes: Buffer.from(boxStl(200.5, 150.5, 2)) } }, [{ file_id: 'pcf_plate', quantity: 2 }]);
    assert.equal(overflow.ok ? 'ok' : overflow.error_code, 'OBJECTS_DO_NOT_FIT_ONE_PLATE');
  }
);
