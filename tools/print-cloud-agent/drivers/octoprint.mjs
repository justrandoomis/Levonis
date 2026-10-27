/**
 * OCTOPRINT DRIVER — OctoPrint's REST API on the LAN
 * (docs/PRINT_CLOUD_AGENT.md §Drivers, «octoprint»; https://docs.octoprint.org/en/master/api/).
 *
 *   status   GET  /api/job      the selected file, progress, state text
 *            GET  /api/printer  temperatures and state flags (409 while the
 *                               printer is not connected to OctoPrint → offline)
 *   upload   POST /api/files/local         multipart `file`, select=true
 *   start    POST /api/files/local/<name>  {"command":"select"} unless it is
 *                                          already the selected file, then
 *            POST /api/job                 {"command":"start"}
 *   pause    POST /api/job  {"command":"pause","action":"pause"}
 *   resume   POST /api/job  {"command":"pause","action":"resume"}
 *   cancel   POST /api/job  {"command":"cancel"}
 *
 * Every request carries `X-Api-Key` (an application key made in OctoPrint's
 * settings); the key stays on the LAN and out of every log.
 *
 * What OctoPrint does not report stays unknown: it has no layer count (a
 * plugin's, if any, is not read), and `remaining_seconds` is OctoPrint's own
 * `printTimeLeft`, passed through as the host computed it. After a print the
 * job keeps its file and its completion: 100 % reads `finished`, a stopped
 * print `cancelled`, until another file is selected.
 */
import { DriverError, emptyStatus, fileBytes, httpCall, int, multipartFile, num, safePrintName } from './common.mjs';

/**
 * @param {{ base_url: string, api_key: string, timeout_seconds?: number, upload_timeout_seconds?: number, camera_stream_id?: string }} options
 * @param {{ fetch?: typeof fetch }} [deps]
 */
export function createOctoPrint(options, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.base_url.replace(/\/+$/, '');
  const timeoutMs = (options.timeout_seconds ?? 10) * 1000;
  const uploadTimeoutMs = (options.upload_timeout_seconds ?? 600) * 1000;
  const headers = { 'X-Api-Key': options.api_key };
  const call = (method, path, body, extra = {}) =>
    httpCall(fetchFn, `${base}${path}`, {
      method,
      headers: body !== undefined && !(body instanceof FormData) ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      timeoutMs,
      ...extra,
    });

  return {
    kind: 'octoprint',
    capabilities: { light: false, ams: false },

    async status() {
      const job = (await call('GET', '/api/job')).body ?? {};
      const printer = await call('GET', '/api/printer?exclude=sd', undefined, { okStatuses: [409] });
      const text = String(job.state ?? '');
      const completion = num(job.progress?.completion);
      const file = typeof job.job?.file?.name === 'string' && job.job.file.name ? job.job.file.name : null;
      const printTime = num(job.progress?.printTime);
      let state;
      if (printer.status === 409 || /^(Offline|Connecting|Opening serial connection|Detecting serial connection|Detecting baudrate|Closed)/i.test(text)) state = /error/i.test(text) ? 'error' : 'offline';
      else if (/error/i.test(text)) state = 'error';
      else if (/^Starting/i.test(text)) state = 'preparing';
      else if (/^(Printing|Finishing|Resuming)/i.test(text)) state = 'printing';
      else if (/^(Pausing|Paused)/i.test(text)) state = 'paused';
      else if (/^Cancelling/i.test(text)) state = 'cancelled';
      else if (/^Operational/i.test(text)) state = file && completion !== null && completion >= 100 ? 'finished' : file && completion !== null && completion > 0 && (printTime ?? 0) > 0 ? 'cancelled' : 'idle';
      else state = 'offline';
      const st = emptyStatus(state);
      st.file = file;
      if (completion !== null) st.progress_permille = Math.max(0, Math.min(1000, Math.round(completion * 10)));
      st.elapsed_seconds = int(printTime);
      st.remaining_seconds = state === 'printing' || state === 'paused' ? int(job.progress?.printTimeLeft) : null;
      const temps = printer.status === 200 ? printer.body?.temperature ?? {} : {};
      st.nozzle_c = num(temps.tool0?.actual);
      st.bed_c = num(temps.bed?.actual);
      st.chamber_c = num(temps.chamber?.actual);
      if (state === 'error') {
        const message = typeof printer.body?.state?.error === 'string' && printer.body.state.error ? printer.body.state.error : text;
        st.errors = [{ code: 'OCTOPRINT_ERROR', message: message.slice(0, 200) }];
      }
      st.camera = options.camera_stream_id ? { available: true } : { available: false };
      return st;
    },

    async upload(file) {
      const name = safePrintName(file.name);
      const form = multipartFile('file', name, await fileBytes(file), { select: 'true', print: 'false' });
      await call('POST', '/api/files/local', form, { timeoutMs: uploadTimeoutMs });
      return { name };
    },

    async start(p) {
      const name = safePrintName(p.name);
      const job = (await call('GET', '/api/job')).body ?? {};
      if (job.job?.file?.name !== name) await call('POST', `/api/files/local/${encodeURIComponent(name)}`, { command: 'select', print: false });
      const check = (await call('GET', '/api/job')).body ?? {};
      if (check.job?.file?.name !== name) throw new DriverError('REFUSED', `OctoPrint did not select ${name}`);
      await call('POST', '/api/job', { command: 'start' });
    },

    async pause() {
      await call('POST', '/api/job', { command: 'pause', action: 'pause' });
    },

    async resume() {
      await call('POST', '/api/job', { command: 'pause', action: 'resume' });
    },

    async cancel() {
      await call('POST', '/api/job', { command: 'cancel' });
    },

    async close() {},
  };
}
