/**
 * MOONRAKER DRIVER — Klipper's API server on the LAN
 * (docs/PRINT_CLOUD_AGENT.md §Drivers, «moonraker»; https://moonraker.readthedocs.io/).
 *
 *   status   GET  /printer/objects/query?print_stats&virtual_sdcard&heater_bed&extruder
 *            GET  /server/files/metadata?filename=<file>  (once per file: the
 *                 slicer's estimated_time, for the remaining time)
 *            GET  /printer/info  when the query fails: Klippy shutdown / error
 *   upload   POST /server/files/upload        multipart `file`, root=gcodes
 *   start    POST /printer/print/start?filename=<name>
 *   pause    POST /printer/print/pause
 *   resume   POST /printer/print/resume
 *   cancel   POST /printer/print/cancel
 *
 * `X-Api-Key` is sent when one is configured (Moonraker also admits trusted
 * LAN clients without one).
 *
 * print_stats.state → standby: idle · printing · paused · complete: finished
 * · cancelled · error. Layers come from print_stats.info (null unless the
 * slicer's start G-code calls SET_PRINT_STATS_INFO). `remaining_seconds` is
 * the file's own slicer estimate less the print time so far, and unknown when
 * the file carries no estimate — never extrapolated from progress.
 */
import { DriverError, emptyStatus, fileBytes, httpCall, int, multipartFile, num, safePrintName } from './common.mjs';

const STATE = { standby: 'idle', printing: 'printing', paused: 'paused', complete: 'finished', cancelled: 'cancelled', error: 'error' };

/**
 * @param {{ base_url: string, api_key?: string, timeout_seconds?: number, upload_timeout_seconds?: number, camera_stream_id?: string }} options
 * @param {{ fetch?: typeof fetch }} [deps]
 */
export function createMoonraker(options, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.base_url.replace(/\/+$/, '');
  const timeoutMs = (options.timeout_seconds ?? 10) * 1000;
  const uploadTimeoutMs = (options.upload_timeout_seconds ?? 600) * 1000;
  const headers = options.api_key ? { 'X-Api-Key': options.api_key } : {};
  const call = (method, path, body, extra = {}) =>
    httpCall(fetchFn, `${base}${path}`, { method, headers, body, timeoutMs, ...extra });
  /** @type {Map<string, number | null>} */
  const estimates = new Map();

  const estimatedTime = async (file) => {
    if (estimates.has(file)) return estimates.get(file) ?? null;
    let value = null;
    try {
      const meta = (await call('GET', `/server/files/metadata?filename=${encodeURIComponent(file)}`)).body?.result ?? {};
      value = num(meta.estimated_time);
    } catch (e) {
      // A file without metadata is a file without an estimate; an outage is retried next poll.
      if (!(e instanceof DriverError && e.code === 'REFUSED')) throw e;
    }
    estimates.set(file, value);
    return value;
  };

  return {
    kind: 'moonraker',
    capabilities: { light: false, ams: false },

    async status() {
      let objects;
      try {
        objects = (await call('GET', '/printer/objects/query?print_stats&virtual_sdcard&heater_bed&extruder')).body?.result?.status ?? null;
      } catch (e) {
        if (!(e instanceof DriverError && e.code === 'REFUSED')) throw e;
        // Moonraker answers but Klippy does not: say what Klippy says about itself.
        const info = await call('GET', '/printer/info').catch(() => null);
        const klippy = info?.body?.result?.state;
        const st = emptyStatus(klippy === 'shutdown' || klippy === 'error' ? 'error' : 'offline');
        if (st.state === 'error') st.errors = [{ code: `KLIPPY_${String(klippy).toUpperCase()}`, message: String(info?.body?.result?.state_message ?? '').slice(0, 200) }];
        return st;
      }
      if (!objects) throw new DriverError('PROTOCOL', 'Moonraker answered without printer objects');
      const ps = objects.print_stats ?? {};
      const state = STATE[ps.state] ?? 'offline';
      const st = emptyStatus(state);
      st.file = typeof ps.filename === 'string' && ps.filename ? ps.filename : null;
      const progress = num(objects.virtual_sdcard?.progress);
      if (progress !== null && state !== 'idle') st.progress_permille = Math.max(0, Math.min(1000, Math.round(progress * 1000)));
      st.elapsed_seconds = int(ps.print_duration);
      st.layer = int(ps.info?.current_layer);
      st.total_layers = int(ps.info?.total_layer);
      st.nozzle_c = num(objects.extruder?.temperature);
      st.bed_c = num(objects.heater_bed?.temperature);
      if ((state === 'printing' || state === 'paused') && st.file) {
        const total = await estimatedTime(st.file);
        if (total !== null && st.elapsed_seconds !== null) st.remaining_seconds = Math.max(0, Math.round(total - st.elapsed_seconds));
      }
      if (state === 'error') st.errors = [{ code: 'KLIPPER_ERROR', message: String(ps.message ?? '').slice(0, 200) }];
      st.camera = options.camera_stream_id ? { available: true } : { available: false };
      return st;
    },

    async upload(file) {
      const name = safePrintName(file.name);
      estimates.delete(name);
      const form = multipartFile('file', name, await fileBytes(file), { root: 'gcodes' });
      await call('POST', '/server/files/upload', form, { timeoutMs: uploadTimeoutMs });
      return { name };
    },

    async start(p) {
      const name = safePrintName(p.name);
      await call('POST', `/printer/print/start?filename=${encodeURIComponent(name)}`);
    },

    async pause() {
      await call('POST', '/printer/print/pause');
    },

    async resume() {
      await call('POST', '/printer/print/resume');
    },

    async cancel() {
      await call('POST', '/printer/print/cancel');
    },

    async close() {},
  };
}
