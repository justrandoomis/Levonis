/**
 * Structured JSON logs (`01-TARGET.md` §11.1). One line per event; `info` is
 * head-sampled per isolate (Workers Logs bills per event), `error` and money/
 * audit outcomes are never sampled. Never logs tokens, cookies, secrets, full
 * emails/phones or request bodies — keys matching REDACTED_KEYS are replaced.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface LoggerOptions {
  svc: string;
  ver?: string;
  env?: string;
  /** 0..1 — share of `info`/`debug` lines emitted; `warn`/`error`/`money` are always emitted */
  sampleRate?: number;
  sink?: (line: string) => void;
  now?: () => string;
  random?: () => number;
  /** static fields on every line: cid, rid, hop, principal … */
  base?: LogFields;
}

export const REDACTED_KEYS = /^(authorization|cookie|set-cookie|token|secret|password|password_hash|api_key|apikey|x-levonis-principal|session|sid|otp|nonce|receipt|email|phone|body)$/i;
const REDACTED = '[redacted]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: value.message };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = REDACTED_KEYS.test(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return value.slice(0, 2000) + '…';
  return value;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Money and audit outcomes: level info, never sampled. */
  money(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(opts: LoggerOptions): Logger {
  const sink = opts.sink ?? ((line: string) => console.log(line));
  const now = opts.now ?? (() => new Date().toISOString());
  const random = opts.random ?? Math.random;
  const rate = opts.sampleRate ?? 1;

  const make = (base: LogFields): Logger => {
    const emit = (level: LogLevel, msg: string, fields: LogFields | undefined, sampled: boolean) => {
      if (sampled && rate < 1 && random() >= rate) return;
      const line = { ts: now(), level, svc: opts.svc, ver: opts.ver ?? 'dev', env: opts.env ?? 'local', ...base, ...(redact(fields ?? {}) as LogFields), msg };
      sink(JSON.stringify(line));
    };
    return {
      debug: (m, f) => emit('debug', m, f, true),
      info: (m, f) => emit('info', m, f, true),
      warn: (m, f) => emit('warn', m, f, false),
      error: (m, f) => emit('error', m, f, false),
      money: (m, f) => emit('info', m, { ...f, money: true }, false),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make(opts.base ?? {});
}

/** The `PumpReport` line the bus logs after every run (unsampled). */
export interface PumpReport {
  selected: number;
  delivered: number;
  retried: number;
  dead: number;
  budget_hit: boolean;
  statements: number;
  rpc_calls: number;
}
