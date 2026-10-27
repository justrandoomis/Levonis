/**
 * THE SIMULATOR — a deterministic fake printer, for the tests and for dry
 * runs of the whole agent against a real cloud without a machine
 * (docs/PRINT_CLOUD_AGENT.md §Drivers, «simulator»).
 *
 * Given the same files and the same clock it always answers the same: a
 * print takes the time its own file states (the slicer's estimate in the
 * G-code), else `print_seconds`; it heats for `prepare_seconds` first; layers
 * and progress follow elapsed time; temperatures are fixed per state.
 * `time_scale` runs a dry run faster than real time (60 → an hour in a
 * minute). Nothing it reports is presented as a real machine: the cloud only
 * ever sees it through a printer the operator bound to a simulator entry.
 *
 * Test hooks: fail(code), pauseFromMachine(), setReachable(bool), snapshot().
 */
import { createHash } from 'node:crypto';
import { DriverError, emptyStatus, fileBytes, safePrintName } from './common.mjs';
import { readPrintFileBytes } from '../slicers/gcode.mjs';

const TEMPS = {
  idle: [25, 25],
  preparing: [150, 55],
  printing: [220, 60],
  paused: [180, 60],
  finished: [40, 35],
  cancelled: [40, 35],
  error: [40, 35],
};

/**
 * @param {{ print_seconds?: number, prepare_seconds?: number, layers?: number, time_scale?: number, camera?: { available: boolean, resolution?: string }, ams?: Array<{ slot: number, material: string, color_hex: string, remain_percent: number | null }> | null }} [options]
 * @param {{ clock?: () => number }} [deps]
 */
export function createSimulator(options = {}, deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const scale = options.time_scale && options.time_scale > 0 ? options.time_scale : 1;
  /** @type {Map<string, { bytes: Buffer, seconds: number, layers: number, sha256: string }>} */
  const files = new Map();
  const uploads = [];
  const lights = [];
  let reachable = true;
  let s = {
    phase: 'idle',
    file: /** @type {string | null} */ (null),
    startAt: 0,
    printStartAt: 0,
    pausedAt: /** @type {number | null} */ (null),
    pausedMs: 0,
    prepareMs: 0,
    durationMs: 0,
    layers: 0,
    frozenElapsedMs: /** @type {number | null} */ (null),
    errors: /** @type {Array<{ code: string, message: string }>} */ ([]),
  };

  const advance = () => {
    const now = clock();
    if (s.phase === 'preparing' && now >= s.startAt + s.prepareMs) {
      s.phase = 'printing';
      s.printStartAt = s.startAt + s.prepareMs;
    }
    if (s.phase === 'printing' && now - s.printStartAt - s.pausedMs >= s.durationMs) {
      s.phase = 'finished';
      s.frozenElapsedMs = s.durationMs;
    }
  };

  const elapsedMs = () => {
    if (s.frozenElapsedMs !== null) return s.frozenElapsedMs;
    if (s.phase === 'printing') return Math.max(0, clock() - s.printStartAt - s.pausedMs);
    if (s.phase === 'paused' && s.pausedAt !== null) return Math.max(0, s.pausedAt - s.printStartAt - s.pausedMs);
    return 0;
  };

  const freeze = (phase) => {
    s.frozenElapsedMs = s.phase === 'preparing' ? 0 : elapsedMs();
    s.phase = phase;
  };

  return {
    kind: 'simulator',
    capabilities: { light: true, ams: Array.isArray(options.ams) },
    uploads,
    lights,

    async status() {
      if (!reachable) throw new DriverError('UNREACHABLE', 'the simulated printer is unreachable');
      advance();
      const st = emptyStatus(s.phase);
      const [nozzle, bed] = TEMPS[s.phase] ?? TEMPS.idle;
      st.nozzle_c = nozzle;
      st.bed_c = bed;
      st.file = s.file;
      st.errors = s.errors.map((e) => ({ ...e }));
      st.camera = options.camera ? { ...options.camera } : { available: false };
      st.ams = Array.isArray(options.ams) ? options.ams.map((t) => ({ ...t })) : null;
      if (s.phase !== 'idle' && s.durationMs > 0) {
        const e = Math.min(elapsedMs(), s.durationMs);
        const fraction = e / s.durationMs;
        st.elapsed_seconds = Math.floor((e * scale) / 1000);
        st.progress_permille = Math.min(1000, Math.floor(fraction * 1000));
        st.total_layers = s.layers;
        st.layer = s.phase === 'preparing' ? 0 : Math.min(s.layers, Math.max(1, Math.ceil(fraction * s.layers)));
        st.remaining_seconds = ['printing', 'paused', 'preparing'].includes(s.phase) ? Math.ceil(((s.durationMs - e) * scale) / 1000) : 0;
      }
      return st;
    },

    async upload(file) {
      const name = safePrintName(file.name);
      const bytes = await fileBytes(file);
      let meta = null;
      let info = null;
      try {
        ({ meta, sliceInfo: info } = readPrintFileBytes(bytes));
      } catch {
        meta = null;
      }
      const seconds = meta?.total_seconds ?? meta?.normal_seconds ?? info?.prediction_seconds ?? options.print_seconds ?? 60;
      const layers = meta?.layers_declared ?? (meta && meta.layer_changes > 0 ? meta.layer_changes : null) ?? options.layers ?? 100;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      files.set(name, { bytes, seconds, layers, sha256 });
      uploads.push({ name, size: bytes.length, sha256 });
      return { name };
    },

    async start(p) {
      const name = safePrintName(p.name);
      const f = files.get(name);
      if (!f) throw new DriverError('REFUSED', `no file ${name} on the simulated printer`);
      advance();
      if (['preparing', 'printing', 'paused'].includes(s.phase)) throw new DriverError('BAD_STATE', `the simulated printer is ${s.phase}`);
      s = {
        phase: 'preparing',
        file: name,
        startAt: clock(),
        printStartAt: 0,
        pausedAt: null,
        pausedMs: 0,
        prepareMs: ((options.prepare_seconds ?? 0) * 1000) / scale,
        durationMs: (f.seconds * 1000) / scale,
        layers: f.layers,
        frozenElapsedMs: null,
        errors: [],
      };
      advance();
    },

    async pause() {
      advance();
      if (s.phase !== 'printing') throw new DriverError('BAD_STATE', `cannot pause while ${s.phase}`);
      s.pausedAt = clock();
      s.phase = 'paused';
    },

    async resume() {
      advance();
      if (s.phase !== 'paused' || s.pausedAt === null) throw new DriverError('BAD_STATE', `cannot resume while ${s.phase}`);
      s.pausedMs += clock() - s.pausedAt;
      s.pausedAt = null;
      s.phase = 'printing';
    },

    async cancel() {
      advance();
      if (!['preparing', 'printing', 'paused'].includes(s.phase)) throw new DriverError('BAD_STATE', `nothing to cancel while ${s.phase}`);
      freeze('cancelled');
    },

    async light(on) {
      lights.push(!!on);
    },

    async close() {},

    // ---- test hooks
    /** The machine faults mid-print (an HMS error, a thermal runaway…). */
    fail(code = 'SIM_FAULT', message = 'simulated fault') {
      advance();
      freeze('error');
      s.errors = [{ code, message }];
    },
    /** The machine pauses itself (a filament runout). */
    pauseFromMachine() {
      advance();
      if (s.phase === 'printing') {
        s.pausedAt = clock();
        s.phase = 'paused';
      }
    },
    setReachable(v) {
      reachable = !!v;
    },
    snapshot() {
      advance();
      return { phase: s.phase, file: s.file, files: [...files.keys()] };
    },
  };
}
