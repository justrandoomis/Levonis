/**
 * BAMBU LAB DRIVER — LAN mode (docs/PRINT_CLOUD_AGENT.md §Drivers, «bambu»).
 *
 *   MQTT over TLS, port 8883, user `bblp`, password = the printer's LAN
 *   access code (lib/mqtt.mjs). The printer publishes `device/<serial>/report`
 *   and listens on `device/<serial>/request`:
 *     {"pushing":{"command":"pushall"}}               a full report, once at connect
 *     {"print":{"command":"project_file", …}}         print a .gcode.3mf from storage
 *     {"print":{"command":"gcode_file","param":…}}    print a plain .gcode
 *     {"print":{"command":"pause"|"resume"|"stop"}}
 *     {"system":{"command":"ledctrl", …}}             chamber light
 *   Reports after the first are INCREMENTAL (only changed fields), so they
 *   are merged into one picture of the machine.
 *   FTPS, implicit TLS, port 990 (lib/ftps.mjs): the print file is stored on
 *   the printer's storage before the print command names it.
 *
 * Both connections use the operator's explicit TLS trust (lib/tlstrust.mjs):
 * the certificate is self-signed, and the choice — a pinned fingerprint, a
 * CA, or an explicitly insecure mode that warns — is written in the config.
 *
 * gcode_state → IDLE: idle · PREPARE / SLICING: preparing · RUNNING:
 * printing · PAUSE: paused · FINISH: finished · FAILED: error (cancelled
 * when print_error is the «cancelled» code). HMS entries become error codes
 * HMS_AAAA_AAAA_CCCC_CCCC. A chamber temperature is reported only for a
 * printer configured with a chamber sensor; nothing is filled in.
 *
 * The field names follow the community documentation of the LAN protocol
 * (OpenBambuAPI); they were exercised against a fake broker and FTP server
 * only — see the TESTED / NOT TESTED table in the docs.
 */
import { createHash } from 'node:crypto';
import { DriverError, emptyStatus, fileBytes, int, num, safePrintName } from './common.mjs';
import { ftpsStore } from '../lib/ftps.mjs';
import { MqttClient } from '../lib/mqtt.mjs';
import { silentLogger } from '../lib/log.mjs';
import { connectTls } from '../lib/tlstrust.mjs';

const GCODE_STATE = { IDLE: 'idle', PREPARE: 'preparing', SLICING: 'preparing', RUNNING: 'printing', PAUSE: 'paused', FINISH: 'finished', FAILED: 'error' };
/** print_error codes that mean the print was stopped on purpose, not a fault. */
const CANCELLED_ERRORS = new Set([0x0300400c]);
const hex8 = (n) => (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** An HMS entry as its published code: HMS_0300_0100_0001_0002. */
export function hmsCode(entry) {
  const a = hex8(entry?.attr);
  const c = hex8(entry?.code);
  return `HMS_${a.slice(0, 4)}_${a.slice(4)}_${c.slice(0, 4)}_${c.slice(4)}`;
}

/** The AMS trays a report describes, normalised; null when the printer has no AMS data. */
export function amsTrays(report) {
  const units = report?.ams?.ams;
  const out = [];
  if (Array.isArray(units)) {
    for (const unit of units) {
      for (const tray of Array.isArray(unit?.tray) ? unit.tray : []) {
        if (!tray || tray.tray_type === undefined || tray.tray_type === '') continue;
        const slot = Number(unit.id) * 4 + Number(tray.id);
        if (!Number.isInteger(slot)) continue;
        const remain = num(tray.remain);
        out.push({ slot, material: String(tray.tray_type), color_hex: typeof tray.tray_color === 'string' && tray.tray_color.length >= 6 ? `#${tray.tray_color.slice(0, 6).toUpperCase()}` : null, remain_percent: remain !== null && remain >= 0 ? remain : null });
      }
    }
  }
  const ext = report?.vt_tray;
  if (ext && ext.tray_type) out.push({ slot: 254, material: String(ext.tray_type), color_hex: typeof ext.tray_color === 'string' && ext.tray_color.length >= 6 ? `#${ext.tray_color.slice(0, 6).toUpperCase()}` : null, remain_percent: null });
  return Array.isArray(units) || ext ? out : null;
}

const rgb = (hex) => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Which tray feeds each filament of the job: variants[i] (filament i+1 of
 * the slice) → a tray of the same material whose colour is within
 * `tolerance` (RGB distance). Returns { mapping } or { missing } naming the
 * variants no loaded tray matches — the print is then not started.
 */
export function amsMapping(variants, trays, tolerance = 48) {
  const mapping = [];
  const missing = [];
  for (const v of variants) {
    const want = rgb(v.color_hex);
    let best = null;
    for (const t of trays) {
      if (t.slot === 254) continue;
      if (v.material && t.material.toUpperCase() !== String(v.material).toUpperCase()) continue;
      const have = rgb(t.color_hex);
      const d = want && have ? Math.hypot(want[0] - have[0], want[1] - have[1], want[2] - have[2]) : want ? Infinity : 0;
      if (d <= tolerance && (!best || d < best.d)) best = { slot: t.slot, d };
    }
    if (best) mapping.push(best.slot);
    else missing.push({ variant_id: v.variant_id, material: v.material, color_hex: v.color_hex });
  }
  return missing.length ? { missing } : { mapping };
}

/**
 * @param {{
 *   host: string, serial: string, access_code: string, tls: { mode: 'pin' | 'ca' | 'insecure', fingerprint256?: string, ca_file?: string },
 *   mqtt_port?: number, ftps_port?: number, chamber_sensor?: boolean, camera_stream_id?: string,
 *   use_ams?: boolean, color_tolerance?: number, timelapse?: boolean, bed_levelling?: boolean, flow_cali?: boolean, vibration_cali?: boolean, layer_inspect?: boolean,
 *   plate_param?: string, project_url_prefix?: string, gcode_path_prefix?: string
 * }} options
 * @param {{ log?: any, clock?: () => number, connectMqtt?: () => Promise<import('node:stream').Duplex>, ftpsConnect?: any, ftpsSecure?: any, reconnectMs?: number }} [deps]
 */
export function createBambu(options, deps = {}) {
  const log = deps.log ?? silentLogger;
  const clock = deps.clock ?? (() => Date.now());
  const trust = { ...options.tls, servername: options.tls?.servername ?? options.serial };
  const reportTopic = `device/${options.serial}/report`;
  const requestTopic = `device/${options.serial}/request`;
  let client = null;
  let connecting = null;
  let nextAttemptAt = 0;
  let failures = 0;
  let closed = false;
  let report = null;
  let lastReportAt = 0;
  let seq = 0;
  /** @type {Map<string, string>} */
  const md5s = new Map();

  const connectMqtt =
    deps.connectMqtt ?? (() => connectTls({ host: options.host, port: options.mqtt_port ?? 8883, trust, log, timeoutMs: 10_000 }));

  const onMessage = (topic, payload) => {
    if (topic !== reportTopic) return;
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (msg && typeof msg.print === 'object' && msg.print) {
      const next = { ...(report ?? {}) };
      for (const [k, v] of Object.entries(msg.print)) {
        // AMS updates arrive as partial objects: merge that one level, replace everything else.
        next[k] = k === 'ams' && v && typeof v === 'object' && !Array.isArray(v) && next.ams && typeof next.ams === 'object' ? { ...next.ams, ...v } : v;
      }
      report = next;
      lastReportAt = clock();
    }
  };

  const open = async () => {
    const c = new MqttClient({ connect: connectMqtt, clientId: `levonis-agent-${options.serial}-${process.pid}`, username: 'bblp', password: options.access_code, keepaliveSeconds: 30, log });
    c.on('message', onMessage);
    c.on('close', (reason) => {
      if (client === c) client = null;
      if (!closed) log.warn('bambu.mqtt.closed', { host: options.host, reason });
    });
    await c.open();
    await c.subscribe(reportTopic, 0);
    client = c;
    failures = 0;
    c.publish(requestTopic, { pushing: { sequence_id: String(++seq), command: 'pushall', version: 1, push_target: 1 } });
    log.info('bambu.mqtt.connected', { host: options.host });
  };

  /** Start (or keep) the connection; reconnects back off from 1 s to 60 s. */
  const ensure = () => {
    if (closed || client || connecting || clock() < nextAttemptAt) return connecting;
    connecting = open()
      .catch((e) => {
        failures++;
        nextAttemptAt = clock() + Math.min(60_000, (deps.reconnectMs ?? 1000) * 2 ** Math.min(6, failures - 1));
        log.warn('bambu.mqtt.connect_failed', { host: options.host, error: e, retry_in_ms: nextAttemptAt - clock() });
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  };

  const command = (body) => {
    if (!client) throw new DriverError('UNREACHABLE', `no MQTT connection to ${options.host}`);
    client.publish(requestTopic, body);
  };

  return {
    kind: 'bambu',
    capabilities: { light: true, ams: true },

    /** Connect now (the runner calls it at start; status() also reconnects lazily). */
    async connect() {
      await ensure();
    },

    async status() {
      const pending = ensure();
      if (!client && pending) await pending;
      if (!client || !report) throw new DriverError('UNREACHABLE', `no report from the printer at ${options.host}`);
      const r = report;
      const printError = num(r.print_error) ?? 0;
      let state = GCODE_STATE[String(r.gcode_state ?? '').toUpperCase()] ?? 'idle';
      if (state === 'error' && CANCELLED_ERRORS.has(printError)) state = 'cancelled';
      const st = emptyStatus(state);
      st.file = (typeof r.subtask_name === 'string' && r.subtask_name) || (typeof r.gcode_file === 'string' && r.gcode_file) || null;
      const percent = num(r.mc_percent);
      if (percent !== null && state !== 'idle') st.progress_permille = Math.max(0, Math.min(1000, Math.round(percent * 10)));
      const minutes = num(r.mc_remaining_time);
      if (minutes !== null && (state === 'printing' || state === 'paused' || state === 'preparing')) st.remaining_seconds = Math.max(0, Math.round(minutes * 60));
      st.layer = int(r.layer_num);
      st.total_layers = int(r.total_layer_num);
      st.nozzle_c = num(r.nozzle_temper);
      st.bed_c = num(r.bed_temper);
      st.chamber_c = options.chamber_sensor ? num(r.chamber_temper) : null;
      const errors = (Array.isArray(r.hms) ? r.hms : []).map((h) => ({ code: hmsCode(h), message: '' }));
      if (printError && !CANCELLED_ERRORS.has(printError)) errors.unshift({ code: `PRINT_ERROR_${hex8(printError)}`, message: '' });
      // The state is what gcode_state says; a print_error beside it (a runout pause, a leftover code) is listed, not promoted.
      st.errors = errors.slice(0, 10);
      st.ams = amsTrays(r);
      st.camera = r.ipcam && typeof r.ipcam === 'object' ? { available: String(r.ipcam.ipcam_dev) === '1', ...(typeof r.ipcam.resolution === 'string' && r.ipcam.resolution ? { resolution: r.ipcam.resolution } : {}) } : { available: false };
      return st;
    },

    async upload(file) {
      const name = safePrintName(file.name);
      const data = await fileBytes(file);
      await ftpsStore({
        host: options.host,
        port: options.ftps_port ?? 990,
        user: 'bblp',
        password: options.access_code,
        remoteName: name,
        data,
        connect: deps.ftpsConnect,
        secure: deps.ftpsSecure ?? ((socket, p) => connectTls({ host: options.host, socket, trust, session: p.session, log, timeoutMs: 15_000 })),
        log,
      });
      md5s.set(name, createHash('md5').update(data).digest('hex'));
      return { name };
    },

    /**
     * Print a stored file. A `.gcode.3mf` goes through `project_file` with the
     * AMS trays mapped to the job's materials; a plain `.gcode` through
     * `gcode_file`, its filament i read from tray i — checked before starting.
     */
    async start(p) {
      const name = safePrintName(p.name);
      const variants = Array.isArray(p.job?.variants) ? p.job.variants : [];
      const useAms = options.use_ams !== false;
      const trays = amsTrays(report) ?? [];
      if (name.endsWith('.3mf')) {
        let mapping = [];
        if (useAms && variants.length) {
          const m = amsMapping(variants, trays, options.color_tolerance ?? 48);
          if (m.missing) throw new DriverError('REFUSED', `material not loaded: ${m.missing.map((x) => `${x.material ?? '?'} ${x.color_hex ?? ''}`.trim()).join(', ')}`);
          mapping = m.mapping;
        }
        command({
          print: {
            sequence_id: String(++seq),
            command: 'project_file',
            param: options.plate_param ?? 'Metadata/plate_1.gcode',
            project_id: '0',
            profile_id: '0',
            task_id: '0',
            subtask_id: '0',
            subtask_name: name.replace(/\.gcode\.3mf$|\.3mf$/, ''),
            url: `${options.project_url_prefix ?? 'file:///sdcard/'}${name}`,
            md5: md5s.get(name) ?? '',
            timelapse: options.timelapse ?? false,
            bed_type: 'auto',
            bed_levelling: options.bed_levelling ?? true,
            flow_cali: options.flow_cali ?? false,
            vibration_cali: options.vibration_cali ?? false,
            layer_inspect: options.layer_inspect ?? false,
            use_ams: useAms && mapping.length > 0,
            ams_mapping: mapping,
          },
        });
        return;
      }
      if (useAms && variants.length) {
        // Plain G-code addresses trays by number: filament i must already sit in tray i.
        for (let i = 0; i < variants.length; i++) {
          const m = amsMapping([variants[i]], trays.filter((t) => t.slot === i), options.color_tolerance ?? 48);
          if (m.missing) throw new DriverError('REFUSED', `tray ${i + 1} does not hold ${variants[i].material ?? '?'} ${variants[i].color_hex ?? ''}`.trim());
        }
      }
      command({ print: { sequence_id: String(++seq), command: 'gcode_file', param: `${options.gcode_path_prefix ?? '/sdcard/'}${name}` } });
    },

    async pause() {
      command({ print: { sequence_id: String(++seq), command: 'pause', param: '' } });
    },

    async resume() {
      command({ print: { sequence_id: String(++seq), command: 'resume', param: '' } });
    },

    async cancel() {
      command({ print: { sequence_id: String(++seq), command: 'stop', param: '' } });
    },

    async light(on) {
      command({ system: { sequence_id: String(++seq), command: 'ledctrl', led_node: 'chamber_light', led_mode: on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } });
    },

    async close() {
      closed = true;
      client?.close();
      client = null;
    },

    /** For tests and `--check`: the merged report and when it last changed. */
    debugReport() {
      return { report, lastReportAt };
    },
  };
}
