/**
 * STRUCTURED LOGS — one JSON object per line, never a secret
 * (docs/PRINT_CLOUD_AGENT.md §Logs).
 *
 * The agent holds three kinds of secrets: its cloud bearer token, the
 * printers' LAN credentials (Bambu access codes, OctoPrint / Moonraker API
 * keys) and nothing else worth stealing. None of them may reach a log line,
 * because logs are what operators paste into chats and tickets. Two guards:
 *
 *   - by KEY: any field whose name looks like a credential (token, password,
 *     access_code, api_key, authorization, cookie, secret) is replaced;
 *   - by VALUE: every secret the configuration resolved is registered, and
 *     any string that contains one — an error message quoting a URL, a
 *     header echoed back — has it cut out.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|passw|secret|access_?code|api_?key|authori[sz]ation|cookie|credential/i;
const REDACTED = '[redacted]';

/**
 * @param {{ level?: string, sink?: (line: string) => void, clock?: () => number, secrets?: string[], fields?: Record<string, unknown> }} [opts]
 */
export function createLogger(opts = {}) {
  const known = new Set();
  const min = LEVELS[opts.level ?? 'info'] ?? LEVELS.info;
  const sink = opts.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const clock = opts.clock ?? (() => Date.now());
  const addSecret = (s) => {
    // A secret shorter than four characters would scrub ordinary words out of every line.
    if (typeof s === 'string' && s.length >= 4) known.add(s);
  };
  for (const s of opts.secrets ?? []) addSecret(s);

  const scrubString = (s) => {
    let out = s;
    for (const k of known) if (out.includes(k)) out = out.split(k).join(REDACTED);
    return out;
  };
  const scrub = (v, depth) => {
    if (typeof v === 'string') return scrubString(v);
    if (v instanceof Error) {
      const e = /** @type {Error & { code?: unknown, status?: unknown }} */ (v);
      return { name: e.name, message: scrubString(String(e.message)), ...(e.code !== undefined ? { code: scrub(e.code, depth + 1) } : {}), ...(e.status !== undefined ? { status: e.status } : {}) };
    }
    if (Array.isArray(v)) return depth > 6 ? '[...]' : v.slice(0, 50).map((x) => scrub(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 6) return '[...]';
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? REDACTED : scrub(x, depth + 1);
      return o;
    }
    return v;
  };

  const make = (base) => {
    const emit = (level, msg, fields) => {
      if (LEVELS[level] < min) return;
      const line = { ts: new Date(clock()).toISOString(), level, msg: scrubString(String(msg)), ...scrub({ ...base, ...(fields ?? {}) }, 0) };
      sink(JSON.stringify(line));
    };
    return {
      debug: (msg, fields) => emit('debug', msg, fields),
      info: (msg, fields) => emit('info', msg, fields),
      warn: (msg, fields) => emit('warn', msg, fields),
      error: (msg, fields) => emit('error', msg, fields),
      addSecret,
      /** A logger that adds these fields to every line (a printer, a job). */
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make(opts.fields ?? {});
}

/** A logger that drops everything — the default for library code a caller did not give one. */
export const silentLogger = createLogger({ level: 'error', sink: () => {} });
