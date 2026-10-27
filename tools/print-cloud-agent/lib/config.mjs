/**
 * THE AGENT'S CONFIGURATION (docs/PRINT_CLOUD_AGENT.md §Configuration;
 * tools/print-cloud-agent/config.example.json).
 *
 * Read once at start and validated strictly — an unknown key is an error, so
 * a misspelt `acess_code_env` cannot silently leave a printer unconfigured.
 *
 * SECRETS. The cloud token comes ONLY from an environment variable
 * (`cloud.token_env`); a token written into the file is refused. Printer
 * credentials may come from the environment (`*_env`, preferred) or the file
 * (keep it mode 0600). All of them are collected into `secrets` so the logger
 * can scrub them, and none is ever sent to the cloud: printer entries are
 * keyed by the cloud's opaque `connection_ref`, and only that name travels.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DRIVERS } from '../drivers/index.mjs';
import { normalizeFingerprint } from './tlstrust.mjs';

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const TOKEN = /^pca_[A-Za-z0-9_-]{20,100}$/;
const STREAM_ID = /^[A-Za-z0-9_-]{1,80}$/;
const comment = (k) => k.startsWith('_') || k.startsWith('//');

/**
 * @param {unknown} raw  the parsed JSON
 * @param {{ env?: Record<string, string | undefined>, baseDir?: string }} [opts]
 */
export function normalizeConfig(raw, opts = {}) {
  const env = opts.env ?? process.env;
  const baseDir = opts.baseDir ?? process.cwd();
  const problems = [];
  const secrets = [];
  const obj = (v, path) => {
    if (v === undefined) return {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      problems.push(`${path}: must be an object`);
      return {};
    }
    return /** @type {Record<string, any>} */ (v);
  };
  const known = (o, keys, path) => {
    for (const k of Object.keys(o)) if (!keys.includes(k) && !comment(k)) problems.push(`${path}.${k}: unknown key (allowed: ${keys.join(', ')})`);
  };
  const intIn = (v, path, def, min, max) => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      problems.push(`${path}: an integer from ${min} to ${max}`);
      return def;
    }
    return v;
  };
  const numIn = (v, path, def, min, max) => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      problems.push(`${path}: a number from ${min} to ${max}`);
      return def;
    }
    return v;
  };
  const bool = (v, path, def) => {
    if (v === undefined) return def;
    if (typeof v !== 'boolean') {
      problems.push(`${path}: true or false`);
      return def;
    }
    return v;
  };
  const strReq = (v, path) => {
    if (typeof v !== 'string' || !v.trim()) {
      problems.push(`${path}: required`);
      return '';
    }
    return v.trim();
  };
  const oneOf = (v, path, values, def) => {
    if (v === undefined) return def;
    if (!values.includes(v)) {
      problems.push(`${path}: one of ${values.join(', ')}`);
      return def;
    }
    return v;
  };
  const filePath = (v) => (isAbsolute(v) ? v : resolve(baseDir, v));
  const httpUrl = (v, path) => {
    const s = strReq(v, path);
    if (!s) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
      return s.replace(/\/+$/, '');
    } catch {
      problems.push(`${path}: an http(s) URL`);
      return '';
    }
  };
  /** A secret from `<key>_env` (preferred) or `<key>` written in the file. */
  const secret = (o, key, path, required) => {
    const envName = o[`${key}_env`];
    let value;
    if (envName !== undefined) {
      if (typeof envName !== 'string' || !envName) problems.push(`${path}.${key}_env: the name of an environment variable`);
      else {
        value = env[envName];
        if (!value) problems.push(`${path}.${key}_env: the environment variable ${envName} is not set`);
      }
    } else if (o[key] !== undefined) {
      if (typeof o[key] !== 'string' || !o[key]) problems.push(`${path}.${key}: a non-empty string`);
      else value = o[key];
    } else if (required) problems.push(`${path}: ${key}_env (or ${key}) is required`);
    if (value) secrets.push(value);
    return value;
  };

  const root = obj(raw, 'config');
  known(root, ['cloud', 'state_dir', 'intervals', 'jobs', 'printers', 'slicer', 'log'], 'config');

  // ---- cloud
  const c = obj(root.cloud, 'cloud');
  known(c, ['base_url', 'token_env', 'timeout_seconds', 'allow_insecure_http', 'token'], 'cloud');
  if ('token' in c) problems.push('cloud.token: never write the agent token into the file — put it in the environment and name the variable in cloud.token_env');
  const baseUrl = httpUrl(c.base_url, 'cloud.base_url');
  if (baseUrl) {
    const u = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'http:' && !local && c.allow_insecure_http !== true) problems.push('cloud.base_url: the token travels in every request — use https (or set allow_insecure_http for a lab)');
  }
  const tokenEnv = c.token_env ?? 'LEVONIS_AGENT_TOKEN';
  const token = typeof tokenEnv === 'string' ? env[tokenEnv] : undefined;
  if (typeof tokenEnv !== 'string' || !tokenEnv) problems.push('cloud.token_env: the name of an environment variable');
  else if (!token) problems.push(`cloud.token_env: the environment variable ${tokenEnv} is not set (the token is shown once when an admin creates the agent)`);
  else if (!TOKEN.test(token)) problems.push(`cloud.token_env: ${tokenEnv} does not hold an agent token (pca_…)`);
  if (token) secrets.push(token);

  // ---- state
  const stateDir = typeof root.state_dir === 'string' && root.state_dir ? filePath(root.state_dir) : (problems.push('state_dir: required (a directory only this agent uses)'), '');

  // ---- intervals
  const iv = obj(root.intervals, 'intervals');
  known(iv, ['telemetry_seconds', 'commands_seconds', 'printers_seconds', 'slicing_seconds', 'tick_ms'], 'intervals');
  const intervals = {
    telemetry_ms: intIn(iv.telemetry_seconds, 'intervals.telemetry_seconds', 10, 2, 600) * 1000,
    commands_ms: intIn(iv.commands_seconds, 'intervals.commands_seconds', 5, 1, 600) * 1000,
    printers_ms: intIn(iv.printers_seconds, 'intervals.printers_seconds', 30, 5, 3600) * 1000,
    slicing_ms: intIn(iv.slicing_seconds, 'intervals.slicing_seconds', 15, 2, 3600) * 1000,
    tick_ms: intIn(iv.tick_ms, 'intervals.tick_ms', 1000, 50, 60_000),
  };

  // ---- jobs
  const j = obj(root.jobs, 'jobs');
  known(j, ['start_mode', 'bed_clear', 'command_max_age_seconds', 'start_timeout_seconds', 'max_start_attempts', 'prints_retention_days'], 'jobs');
  const jobs = {
    start_mode: oneOf(j.start_mode, 'jobs.start_mode', ['auto', 'manual'], 'auto'),
    bed_clear: oneOf(j.bed_clear, 'jobs.bed_clear', ['operator', 'assume_clear'], 'operator'),
    command_max_age_ms: intIn(j.command_max_age_seconds, 'jobs.command_max_age_seconds', 600, 10, 86_400) * 1000,
    start_timeout_ms: intIn(j.start_timeout_seconds, 'jobs.start_timeout_seconds', 300, 10, 3600) * 1000,
    max_start_attempts: intIn(j.max_start_attempts, 'jobs.max_start_attempts', 3, 1, 20),
    prints_retention_days: intIn(j.prints_retention_days, 'jobs.prints_retention_days', 14, 1, 365),
  };

  // ---- printers, keyed by the connection_ref the cloud stores
  const printersRaw = obj(root.printers, 'printers');
  /** @type {Record<string, Record<string, any>>} */
  const printers = {};
  for (const [ref, entryRaw] of Object.entries(printersRaw)) {
    if (comment(ref)) continue;
    const path = `printers.${ref}`;
    if (ref.length > 200) problems.push(`${path}: a connection_ref is at most 200 characters`);
    const e = obj(entryRaw, path);
    const driver = oneOf(e.driver, `${path}.driver`, DRIVERS, null);
    if (!driver) {
      if (e.driver === undefined) problems.push(`${path}.driver: required (${DRIVERS.join(', ')})`);
      continue;
    }
    const common = ['driver', 'camera_stream_id', 'bed_clear', 'timeout_seconds'];
    const out = { driver, ref };
    if (e.camera_stream_id !== undefined) {
      if (typeof e.camera_stream_id !== 'string' || !STREAM_ID.test(e.camera_stream_id)) problems.push(`${path}.camera_stream_id: letters, digits, _ and - (at most 80)`);
      else out.camera_stream_id = e.camera_stream_id;
    }
    if (e.bed_clear !== undefined) out.bed_clear = oneOf(e.bed_clear, `${path}.bed_clear`, ['operator', 'assume_clear'], undefined);
    out.timeout_seconds = intIn(e.timeout_seconds, `${path}.timeout_seconds`, 10, 1, 120);
    if (driver === 'simulator') {
      known(e, [...common, 'print_seconds', 'prepare_seconds', 'layers', 'time_scale', 'camera', 'ams'], path);
      Object.assign(out, {
        print_seconds: intIn(e.print_seconds, `${path}.print_seconds`, 60, 1, 30 * 86_400),
        prepare_seconds: intIn(e.prepare_seconds, `${path}.prepare_seconds`, 0, 0, 3600),
        layers: intIn(e.layers, `${path}.layers`, 100, 1, 1_000_000),
        time_scale: numIn(e.time_scale, `${path}.time_scale`, 1, 0.001, 100_000),
        camera: e.camera === undefined ? undefined : { available: e.camera?.available === true, ...(typeof e.camera?.resolution === 'string' ? { resolution: e.camera.resolution } : {}) },
        ams: Array.isArray(e.ams) ? e.ams : null,
      });
    } else if (driver === 'octoprint' || driver === 'moonraker') {
      known(e, [...common, 'base_url', 'api_key', 'api_key_env', 'upload_timeout_seconds'], path);
      out.base_url = httpUrl(e.base_url, `${path}.base_url`);
      out.api_key = secret(e, 'api_key', path, driver === 'octoprint');
      out.upload_timeout_seconds = intIn(e.upload_timeout_seconds, `${path}.upload_timeout_seconds`, 600, 10, 7200);
    } else if (driver === 'bambu') {
      known(
        e,
        [...common, 'host', 'serial', 'access_code', 'access_code_env', 'tls', 'mqtt_port', 'ftps_port', 'chamber_sensor', 'use_ams', 'color_tolerance', 'timelapse', 'bed_levelling', 'flow_cali', 'vibration_cali', 'layer_inspect', 'plate_param', 'project_url_prefix', 'gcode_path_prefix'],
        path
      );
      out.host = strReq(e.host, `${path}.host`);
      out.serial = strReq(e.serial, `${path}.serial`);
      if (out.serial && !/^[A-Za-z0-9]{6,40}$/.test(out.serial)) problems.push(`${path}.serial: the printer serial (letters and digits)`);
      out.access_code = secret(e, 'access_code', path, true);
      const tls = obj(e.tls, `${path}.tls`);
      known(tls, ['mode', 'fingerprint256', 'ca_file', 'servername'], `${path}.tls`);
      const mode = oneOf(tls.mode, `${path}.tls.mode`, ['pin', 'ca', 'insecure'], null);
      if (!mode && tls.mode === undefined) problems.push(`${path}.tls.mode: required — "pin" (recommended), "ca" or "insecure"; verification is never turned off silently`);
      if (mode === 'pin' && !normalizeFingerprint(tls.fingerprint256)) problems.push(`${path}.tls.fingerprint256: the printer certificate's SHA-256 fingerprint (run: node agent.mjs --print-fingerprint ${out.host || '<host>'}:8883)`);
      if (mode === 'ca') {
        if (typeof tls.ca_file !== 'string' || !tls.ca_file) problems.push(`${path}.tls.ca_file: required for mode "ca"`);
        else if (!existsSync(filePath(tls.ca_file))) problems.push(`${path}.tls.ca_file: ${filePath(tls.ca_file)} does not exist`);
      }
      out.tls = { mode, ...(mode === 'pin' ? { fingerprint256: normalizeFingerprint(tls.fingerprint256) } : {}), ...(mode === 'ca' && typeof tls.ca_file === 'string' ? { ca_file: filePath(tls.ca_file) } : {}), ...(typeof tls.servername === 'string' ? { servername: tls.servername } : {}) };
      out.mqtt_port = intIn(e.mqtt_port, `${path}.mqtt_port`, 8883, 1, 65535);
      out.ftps_port = intIn(e.ftps_port, `${path}.ftps_port`, 990, 1, 65535);
      out.chamber_sensor = bool(e.chamber_sensor, `${path}.chamber_sensor`, false);
      out.use_ams = bool(e.use_ams, `${path}.use_ams`, true);
      out.color_tolerance = numIn(e.color_tolerance, `${path}.color_tolerance`, 48, 0, 442);
      for (const k of ['timelapse', 'flow_cali', 'vibration_cali', 'layer_inspect']) out[k] = bool(e[k], `${path}.${k}`, false);
      out.bed_levelling = bool(e.bed_levelling, `${path}.bed_levelling`, true);
      for (const k of ['plate_param', 'project_url_prefix', 'gcode_path_prefix']) if (e[k] !== undefined) out[k] = strReq(e[k], `${path}.${k}`);
    }
    printers[ref] = out;
  }

  // ---- slicer
  let slicer = null;
  if (root.slicer !== undefined && root.slicer !== null) {
    const s = obj(root.slicer, 'slicer');
    known(s, ['kind', 'cli_path', 'profiles_dir', 'timeout_seconds', 'output', 'machines', 'filaments', 'max_objects', 'brim_width_mm'], 'slicer');
    const kind = oneOf(s.kind, 'slicer.kind', ['orca', 'bambu-studio', 'prusa'], null);
    if (!kind && s.kind === undefined) problems.push('slicer.kind: required (orca, bambu-studio, prusa)');
    const output = oneOf(s.output, 'slicer.output', ['gcode', 'gcode.3mf'], 'gcode');
    if (kind === 'prusa' && output !== 'gcode') problems.push('slicer.output: PrusaSlicer produces "gcode"');
    const machines = obj(s.machines, 'slicer.machines');
    for (const [code, m] of Object.entries(machines)) {
      if (comment(code)) continue;
      for (const [i, entry] of (Array.isArray(m) ? m : [m]).entries()) {
        const p = `slicer.machines.${code}${Array.isArray(m) ? `[${i}]` : ''}`;
        const me = obj(entry, p);
        known(me, ['machine', 'process', 'nozzle_um', 'pause_gcode'], p);
        strReq(me.machine, `${p}.machine`);
        strReq(me.process, `${p}.process`);
        if (me.nozzle_um !== undefined) intIn(me.nozzle_um, `${p}.nozzle_um`, 400, 100, 2000);
        if (me.pause_gcode !== undefined && (typeof me.pause_gcode !== 'string' || !me.pause_gcode.trim())) problems.push(`${p}.pause_gcode: G-code text`);
      }
    }
    const fil = obj(s.filaments, 'slicer.filaments');
    known(fil, ['by_sku', 'by_material'], 'slicer.filaments');
    const bySku = obj(fil.by_sku, 'slicer.filaments.by_sku');
    const byMaterial = Object.fromEntries(Object.entries(obj(fil.by_material, 'slicer.filaments.by_material')).map(([k, v]) => [k.toUpperCase(), v]));
    slicer = {
      kind,
      cli_path: strReq(s.cli_path, 'slicer.cli_path'),
      profiles_dir: typeof s.profiles_dir === 'string' && s.profiles_dir ? filePath(s.profiles_dir) : baseDir,
      // The cloud's lease is 10 minutes, and the download and the answer need time too.
      timeout_ms: intIn(s.timeout_seconds, 'slicer.timeout_seconds', 480, 10, 540) * 1000,
      output,
      machines,
      filaments: { by_sku: bySku, by_material: byMaterial },
      max_objects: intIn(s.max_objects, 'slicer.max_objects', 200, 1, 10_000),
      brim_width_mm: numIn(s.brim_width_mm, 'slicer.brim_width_mm', 5, 0, 100),
    };
  }

  // ---- log
  const lg = obj(root.log, 'log');
  known(lg, ['level'], 'log');
  const log = { level: oneOf(lg.level, 'log.level', ['debug', 'info', 'warn', 'error'], 'info') };

  const cloudTimeoutMs = intIn(c.timeout_seconds, 'cloud.timeout_seconds', 20, 1, 300) * 1000;
  if (problems.length) throw new ConfigError(problems);
  return {
    cloud: { base_url: baseUrl, token: /** @type {string} */ (token), timeout_ms: cloudTimeoutMs },
    state_dir: stateDir,
    intervals,
    jobs,
    printers,
    slicer,
    log,
    secrets,
  };
}

/** Read and validate a configuration file; relative paths in it are relative to the file. */
export function loadConfigFile(path, opts = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError([`${path}: ${/** @type {Error} */ (e).message}`]);
  }
  return normalizeConfig(raw, { ...opts, baseDir: dirname(resolve(path)) });
}
