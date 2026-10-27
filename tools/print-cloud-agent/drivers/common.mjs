/**
 * THE DRIVER INTERFACE every printer driver implements
 * (docs/PRINT_CLOUD_AGENT.md §Drivers):
 *
 *   status()              → PrinterStatus (below), or throws DriverError
 *                           UNREACHABLE when the agent cannot reach the machine
 *                           (the runner then reports `offline` — never a guess)
 *   upload({ name, path }) put a print file on the machine under `name`
 *   start({ name, job })   start printing that file (`job` = the cloud's
 *                           slicing input, for drivers that map materials)
 *   pause() / resume() / cancel()
 *   light(on)              optional (capabilities.light)
 *   close()                release sockets and timers
 *
 * PrinterStatus — what the MACHINE said, normalised; a field the machine did
 * not report is null, never filled in:
 *   state            idle | preparing | printing | paused | finished |
 *                    cancelled | error | offline
 *   file             the file it is printing, or last printed (null if none)
 *   progress_permille, layer, total_layers, remaining_seconds,
 *   elapsed_seconds  print time so far, as the machine counts it
 *   nozzle_c, bed_c, chamber_c   temperatures in °C (floats)
 *   errors           [{ code, message }]
 *   ams              [{ slot, material, color_hex, remain_percent }] or null
 *   camera           { available, resolution? }
 */
import { readFile } from 'node:fs/promises';

export const PRINTER_STATES = ['idle', 'preparing', 'printing', 'paused', 'finished', 'cancelled', 'error', 'offline'];

export class DriverError extends Error {
  /**
   * @param {'UNREACHABLE' | 'REFUSED' | 'UNSUPPORTED' | 'BAD_STATE' | 'PROTOCOL'} code
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/** A status with every measurement unknown: what a driver starts from before filling what the machine said. */
export function emptyStatus(state) {
  return {
    state,
    file: null,
    progress_permille: null,
    layer: null,
    total_layers: null,
    remaining_seconds: null,
    elapsed_seconds: null,
    nozzle_c: null,
    bed_c: null,
    chamber_c: null,
    errors: [],
    ams: null,
    camera: { available: false },
  };
}

/** A finite number from a machine field, or null — never NaN, never a default. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A non-negative integer from a machine field, or null. */
export function int(v) {
  const n = num(v);
  return n === null || n < 0 ? null : Math.round(n);
}

/** The bytes of a print file handed to upload(): from memory or from disk. */
export async function fileBytes(file) {
  if (file.bytes) return Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes);
  if (file.path) return readFile(file.path);
  throw new DriverError('PROTOCOL', 'upload needs a path or bytes');
}

/**
 * One HTTP exchange with a printer host on the LAN, bounded by a timeout.
 * Answers parsed JSON (or text); throws DriverError UNREACHABLE for a
 * network failure and REFUSED (with the status) for an HTTP refusal.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: any, timeoutMs?: number, okStatuses?: number[] }} [opts]
 */
export async function httpCall(fetchFn, url, opts = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DriverError('UNREACHABLE', `timeout after ${opts.timeoutMs ?? 10_000} ms: ${opts.method ?? 'GET'} ${new URL(url).pathname}`));
    }, opts.timeoutMs ?? 10_000);
  });
  let res;
  try {
    res = await Promise.race([fetchFn(url, { method: opts.method ?? 'GET', headers: opts.headers, body: opts.body, signal: controller.signal }), timeout]);
  } catch (e) {
    if (e instanceof DriverError) throw e;
    throw new DriverError('UNREACHABLE', `${opts.method ?? 'GET'} ${new URL(url).pathname}: ${/** @type {Error} */ (e)?.message ?? String(e)}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) {
    const detail = typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed ?? {}).slice(0, 200);
    throw new DriverError('REFUSED', `${opts.method ?? 'GET'} ${new URL(url).pathname} → HTTP ${res.status} ${detail}`, { status: res.status });
  }
  return { status: res.status, body: parsed };
}

/** A multipart body with one file part (and plain fields), for printer hosts' upload doors. */
export function multipartFile(field, name, bytes, fields = {}) {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: 'application/octet-stream' }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

/** File names the agent gives the machines: the job id inside, nothing a filesystem or URL could misread. */
export function safePrintName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(name) || name.startsWith('.')) throw new DriverError('PROTOCOL', `unsafe print file name: ${String(name)}`);
  return name;
}
