/**
 * THE SLICING PIPELINE (docs/PRINT_CLOUD.md §7.2; docs/PRINT_CLOUD_AGENT.md
 * §Slicer). The cloud does not slice: it hands a claimed request's input to
 * this agent, which runs the workshop's installed slicer CLI with the
 * workshop's own profiles and posts what the slicer MEASURED — or a failure
 * with a reason. Never a number the slicer did not write.
 *
 *   plan     the job's input → filament slots (one per variant, in the
 *            input's order), objects (each model × quantity × copies, on its
 *            variant's filament), the machine profile for the printer model
 *            and nozzle, a filament profile per variant;
 *   run      the CLI, no shell, with a timeout shorter than the cloud's
 *            10-minute lease (killed when it runs over);
 *   parse    the produced file's own figures (./gcode.mjs);
 *   pauses   `pause_at_layers` inserted as the machine's configured pause
 *            G-code at those layer changes (plain G-code output only).
 *
 * What v1 cannot slice faithfully it refuses with a code, so the customer is
 * told instead of quoted for something else: a fixed plate layout
 * (PLATE_LAYOUT_UNSUPPORTED), one model with parts in different materials
 * (MULTI_PART_ASSIGNMENT_UNSUPPORTED), pauses inside a .gcode.3mf
 * (PAUSE_AT_LAYER_UNSUPPORTED) and, per slicer, what its CLI cannot express.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { silentLogger } from '../lib/log.mjs';
import { buildEstimate, readPrintFileBytes, scanGcodeFile } from './gcode.mjs';
import { orca } from './orca.mjs';
import { prusa } from './prusa.mjs';

export const SLICERS = { orca, 'bambu-studio': orca, prusa };

const fail = (error_code, detail) => ({ ok: /** @type {const} */ (false), error_code, detail: String(detail).slice(0, 500) });

/** A configured profile path, resolved against the profiles directory. */
function profilePath(cfg, p) {
  if (typeof p !== 'string' || !p) return null;
  return isAbsolute(p) ? p : resolve(cfg.profiles_dir ?? '.', p);
}

/** The machine entry for a printer model and nozzle: `machines[code]` is one entry or a list of them. */
function machineFor(cfg, code, nozzleUm) {
  const raw = cfg.machines?.[code];
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return entries.find((e) => (e.nozzle_um ?? 400) === nozzleUm) ?? null;
}

/**
 * The job's input → what to slice, or the reason v1 cannot slice it faithfully.
 * @param {Record<string, any>} input  the claim's `input` (worker/lib/printCloud/jobs.ts SlicingInput)
 * @param {Record<string, any>} cfg    the normalised slicer configuration
 */
export function planSlice(input, cfg) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.models) || !input.models.length) return fail('INPUT_INVALID', 'the request names no model');
  if (input.plate) return fail('PLATE_LAYOUT_UNSUPPORTED', 'a fixed plate layout cannot be passed to the slicer CLI; slice it on a workstation and enter the figures');
  const settings = input.settings ?? {};
  const variants = Array.isArray(input.variants) ? input.variants : [];
  const copies = Number.isInteger(input.copies) && input.copies > 0 ? input.copies : 1;
  const objects = [];
  for (const m of input.models) {
    const used = [...new Set((m.material_assignments ?? []).map((a) => a.variant_id))];
    if (used.length !== 1) return fail('MULTI_PART_ASSIGNMENT_UNSUPPORTED', `model ${m.project_model_id} assigns ${used.length} materials to its parts`);
    const slot = variants.findIndex((v) => v.variant_id === used[0]);
    if (slot < 0) return fail('INPUT_INVALID', `variant ${used[0]} of model ${m.project_model_id} is not in the request`);
    const qty = Number.isInteger(m.quantity) && m.quantity > 0 ? m.quantity : 1;
    for (let i = 0; i < qty * copies; i++) objects.push({ file_id: m.file_id, filament: slot + 1 });
  }
  const maxObjects = cfg.max_objects ?? 200;
  if (objects.length > maxObjects) return fail('TOO_MANY_OBJECTS', `${objects.length} objects (models × quantity × copies) exceed the configured ${maxObjects} on one plate`);
  // Only the variants the objects use are loaded; the request's order is kept, so filament i+1 = slots[i].
  const usedSlots = [...new Set(objects.map((o) => o.filament))].sort((a, b) => a - b);
  const renumber = new Map(usedSlots.map((s, i) => [s, i + 1]));
  for (const o of objects) o.filament = /** @type {number} */ (renumber.get(o.filament));
  const code = input.printer_model?.code;
  const nozzleUm = Number.isInteger(settings.nozzle_um) ? settings.nozzle_um : 400;
  const machine = machineFor(cfg, code, nozzleUm);
  if (!machine) return fail('PROFILE_NOT_CONFIGURED', `no machine profile for printer model ${code} with a ${nozzleUm} µm nozzle`);
  const slots = [];
  for (const s of usedSlots) {
    const v = variants[s - 1];
    const fp = cfg.filaments?.by_sku?.[v.sku] ?? cfg.filaments?.by_material?.[String(v.material ?? '').toUpperCase()];
    if (!fp) return fail('PROFILE_NOT_CONFIGURED', `no filament profile for SKU ${v.sku} (${v.material ?? 'unknown material'})`);
    slots.push({ variant_id: v.variant_id, sku: v.sku, material: v.material, color_hex: v.color_hex, profile: profilePath(cfg, fp) });
  }
  const pauseLayers = Array.isArray(settings.pause_at_layers) ? [...new Set(settings.pause_at_layers)].sort((a, b) => a - b) : [];
  if (pauseLayers.length) {
    if (!machine.pause_gcode) return fail('PAUSE_AT_LAYER_UNSUPPORTED', `no pause_gcode configured for ${code}: the requested pauses cannot be inserted`);
    if ((cfg.output ?? 'gcode') !== 'gcode') return fail('PAUSE_AT_LAYER_UNSUPPORTED', 'pauses are inserted into plain G-code only; configure output "gcode" for this slicer');
  }
  return {
    ok: /** @type {const} */ (true),
    plan: {
      jobId: input.job_id,
      settings,
      orientation: settings.orientation === 'auto' ? 'auto' : 'as_uploaded',
      objects,
      slots,
      machine: { ...machine, machine: profilePath(cfg, machine.machine), process: profilePath(cfg, machine.process) },
      pauseLayers,
    },
  };
}

/**
 * Run a CLI without a shell, bounded by a timeout (SIGTERM, then SIGKILL).
 * @returns {Promise<{ code: number | null, signal: string | null, timedOut: boolean, tail: string }>}
 */
export function runCli(cmd, args, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolvePromise) => {
    let tail = '';
    const keep = (d) => {
      tail = (tail + d.toString('utf8')).slice(-4000);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolvePromise({ code: null, signal: null, timedOut: false, tail: `spawn failed: ${/** @type {Error} */ (e).message}` });
      return;
    }
    let timedOut = false;
    let killer = null;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolvePromise({ code, signal, timedOut, tail });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs ?? 480_000);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    // A binary that cannot be started (ENOENT, EACCES): resolved here even where no 'close' follows.
    child.on('error', (e) => {
      keep(Buffer.from(`\n${e.message}`));
      setImmediate(() => finish(null, null));
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/**
 * Insert `pauseGcode` right after the Nth layer-change marker for each N in
 * `layers` (1-based: before layer N prints). Rewrites the file atomically.
 * Returns the number of layer markers seen.
 */
export async function insertPauses(path, layers, pauseGcode, markers = [';LAYER_CHANGE', '; CHANGE_LAYER']) {
  const want = new Set(layers);
  const tmp = `${path}.pauses.tmp`;
  const out = createWriteStream(tmp);
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let layer = 0;
  let inserted = 0;
  const write = (s) => (out.write(s) ? undefined : new Promise((r) => out.once('drain', r)));
  for await (const line of rl) {
    await write(`${line}\n`);
    if (markers.includes(line.trimEnd())) {
      layer++;
      if (want.has(layer)) {
        await write(`; levonis-agent: pause before layer ${layer} (pause_at_layers)\n${pauseGcode.trim()}\n`);
        inserted++;
      }
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r(undefined))));
  if (inserted !== want.size) {
    await rm(tmp, { force: true });
    return { layers: layer, inserted, ok: false };
  }
  await rename(tmp, path);
  return { layers: layer, inserted, ok: true };
}

async function sha256File(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

/**
 * @param {Record<string, any>} cfg  the normalised slicer configuration (config.mjs)
 * @param {{ log?: any, run?: typeof runCli }} [deps]
 */
export function createSlicer(cfg, deps = {}) {
  const impl = SLICERS[cfg.kind];
  if (!impl) throw new Error(`unknown slicer kind ${String(cfg.kind)}`);
  const log = deps.log ?? silentLogger;
  const run = deps.run ?? runCli;
  return {
    kind: cfg.kind,
    label: impl.label,
    /**
     * Slice a job. `files` maps each model's file_id to its downloaded path.
     * @param {{ input: Record<string, any>, files: Map<string, string>, workDir: string }} p
     * @returns {Promise<{ ok: true, printFile: string, format: 'gcode' | 'gcode.3mf', estimate: Record<string, any>, sha256: string } | { ok: false, error_code: string, detail: string }>}
     */
    async slice(p) {
      const planned = planSlice(p.input, cfg);
      if (!planned.ok) return planned;
      const plan = planned.plan;
      for (const o of plan.objects) if (!p.files.has(o.file_id)) return fail('MODEL_FILE_MISSING', `model file ${o.file_id} was not downloaded`);
      for (const f of [plan.machine.machine, plan.machine.process, ...plan.slots.map((s) => s.profile)]) {
        if (!f || !existsSync(f)) return fail('PROFILE_NOT_FOUND', `profile file missing: ${basename(String(f))}`);
      }
      const outBase = `lv_${String(plan.jobId).replace(/[^A-Za-z0-9_-]/g, '_')}`;
      let command;
      try {
        command = await impl.command({ plan, files: p.files, workDir: p.workDir, outBase, cfg });
      } catch (e) {
        return fail('PROFILE_UNREADABLE', /** @type {Error} */ (e).message);
      }
      if (!command.ok) return command;
      log.info('slicer.run', { job_id: plan.jobId, slicer: cfg.kind, objects: plan.objects.length, filaments: plan.slots.length });
      const result = await run(cfg.cli_path, command.args, { cwd: p.workDir, timeoutMs: cfg.timeout_ms });
      if (result.timedOut) return fail('SLICER_TIMEOUT', `the slicer ran past ${Math.round((cfg.timeout_ms ?? 0) / 1000)} s`);
      if (result.code !== 0) {
        log.warn('slicer.failed', { job_id: plan.jobId, code: result.code, signal: result.signal, tail: result.tail.slice(-1500) });
        return fail('SLICER_FAILED', `exit ${result.code ?? result.signal}: ${result.tail.trim().split('\n').slice(-3).join(' | ')}`);
      }
      const output = await impl.output({ plan, workDir: p.workDir, outBase, cfg });
      if (!output) return fail('SLICER_OUTPUT_MISSING', 'the slicer exited cleanly but wrote no print file');
      if ('error_code' in output) return fail(output.error_code, output.detail);
      let meta = null;
      let sliceInfo = null;
      try {
        if (output.format === 'gcode') meta = await scanGcodeFile(output.path);
        else ({ meta, sliceInfo } = readPrintFileBytes(await readFile(output.path)));
      } catch (e) {
        return fail('SLICER_OUTPUT_UNREADABLE', /** @type {Error} */ (e).message);
      }
      const generatedConfig = {
        agent: 'levonis-print-cloud-agent',
        slicer_kind: cfg.kind,
        machine_profile: basename(plan.machine.machine),
        process_profile: basename(plan.machine.process),
        filament_profiles: plan.slots.map((s) => basename(s.profile)),
        overrides: command.overrides ?? {},
        objects: plan.objects.length,
        output: output.format,
      };
      const built = buildEstimate({ meta, sliceInfo, slots: plan.slots, slicerLabel: impl.label, printerProfile: basename(plan.machine.machine).replace(/\.(json|ini)$/i, ''), generatedConfig });
      if (!built.ok) return built;
      if (plan.pauseLayers.length) {
        const layers = built.estimate.layer_count ?? null;
        if (layers !== null && plan.pauseLayers.some((l) => l > layers)) return fail('PAUSE_LAYER_OUT_OF_RANGE', `a pause is requested past the last layer (${layers})`);
        const r = await insertPauses(output.path, plan.pauseLayers, plan.machine.pause_gcode, impl.layerMarkers);
        if (!r.ok) return fail('PAUSE_AT_LAYER_UNSUPPORTED', `found ${r.layers} layer markers; could not place every requested pause`);
      }
      const sha256 = await sha256File(output.path);
      built.estimate.generated_config = { ...generatedConfig, sha256 };
      return { ok: true, printFile: output.path, format: output.format, estimate: built.estimate, sha256 };
    },
  };
}

