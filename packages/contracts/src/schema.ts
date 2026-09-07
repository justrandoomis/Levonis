/**
 * Hand-written schema combinators — the validators `01-TARGET.md` §4 item 9
 * and `03-EVENTS.md` §1 ask for ("no new runtime dependency"). Every check is
 * `(value, path) => narrowed value` and throws `ContractViolation` naming the
 * exact path. Objects are ALLOWLISTS: a key the schema does not name is a
 * violation, so a payload can never smuggle a whole row.
 */
export class ContractViolation extends Error {
  readonly code = 'CONTRACT_VIOLATION';
  constructor(
    public readonly path: string,
    message: string
  ) {
    super(`${path}: ${message}`);
    this.name = 'ContractViolation';
  }
}

export type Check<T> = (value: unknown, path: string) => T;
export type Infer<C> = C extends Check<infer T> ? T : never;

const fail = (path: string, msg: string): never => {
  throw new ContractViolation(path, msg);
};

export const str: Check<string> = (v, p) => (typeof v === 'string' ? v : fail(p, 'must be a string'));
export const nonEmptyStr: Check<string> = (v, p) => {
  const s = str(v, p);
  return s.length > 0 ? s : fail(p, 'must not be empty');
};
export const maxStr =
  (max: number): Check<string> =>
  (v, p) => {
    const s = str(v, p);
    return s.length <= max ? s : fail(p, `must be at most ${max} characters`);
  };
export const bool: Check<boolean> = (v, p) => (typeof v === 'boolean' ? v : fail(p, 'must be a boolean'));
export const num: Check<number> = (v, p) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(p, 'must be a finite number'));
/** Amounts are integers everywhere (IQD dinars, USD cents, points). */
export const int: Check<number> = (v, p) => (typeof v === 'number' && Number.isInteger(v) ? v : fail(p, 'must be an integer'));
export const nonNegInt: Check<number> = (v, p) => {
  const n = int(v, p);
  return n >= 0 ? n : fail(p, 'must be >= 0');
};
export const posInt: Check<number> = (v, p) => {
  const n = int(v, p);
  return n > 0 ? n : fail(p, 'must be > 0');
};
export const nul: Check<null> = (v, p) => (v === null ? null : fail(p, 'must be null'));
/** ISO 8601 date-time string that Date can parse. */
export const isoDate: Check<string> = (v, p) => {
  const s = str(v, p);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s))
    ? s
    : fail(p, 'must be an ISO 8601 date-time');
};
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const uuidV7: Check<string> = (v, p) => {
  const s = str(v, p);
  return UUID_V7.test(s) ? s : fail(p, 'must be a UUIDv7');
};
/** A hex digest (sha256 → 64 chars). */
export const hex64: Check<string> = (v, p) => {
  const s = str(v, p);
  return /^[0-9a-f]{64}$/.test(s) ? s : fail(p, 'must be a 64-char hex digest');
};

export const oneOf =
  <const T extends readonly (string | number | boolean)[]>(...allowed: T): Check<T[number]> =>
  (v, p) =>
    (allowed as readonly unknown[]).includes(v) ? (v as T[number]) : fail(p, `must be one of ${allowed.map(String).join(', ')}`);

export const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (v, p) =>
    v === null ? null : check(v, p);

export const arr =
  <T>(item: Check<T>, opts: { max?: number; min?: number } = {}): Check<T[]> =>
  (v, p) => {
    if (!Array.isArray(v)) return fail(p, 'must be an array');
    if (opts.max !== undefined && v.length > opts.max) return fail(p, `must have at most ${opts.max} items`);
    if (opts.min !== undefined && v.length < opts.min) return fail(p, `must have at least ${opts.min} items`);
    return v.map((x, i) => item(x, `${p}[${i}]`));
  };

export const record =
  <T>(value: Check<T>, opts: { max?: number } = {}): Check<Record<string, T>> =>
  (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'must be an object');
    const entries = Object.entries(v as Record<string, unknown>);
    if (opts.max !== undefined && entries.length > opts.max) return fail(p, `must have at most ${opts.max} keys`);
    const out: Record<string, T> = {};
    for (const [k, x] of entries) out[k] = value(x, `${p}.${k}`);
    return out;
  };

type Shape = Record<string, Check<unknown>>;
type FromShape<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

/**
 * A strict object: every named key must be present (use `nullable` for
 * "present but null") and no other key may appear. `optional` keys may be
 * absent; when present they are checked.
 */
export const obj =
  <S extends Shape, O extends Shape = Record<never, never>>(shape: S, optional?: O): Check<FromShape<S> & Partial<FromShape<O>>> =>
  (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'must be an object');
    const input = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      if (!(key in shape) && !(optional && key in optional)) fail(`${p}.${key}`, 'is not part of the contract');
    }
    for (const [key, check] of Object.entries(shape)) {
      if (!(key in input)) fail(`${p}.${key}`, 'is required');
      out[key] = check(input[key], `${p}.${key}`);
    }
    if (optional) {
      for (const [key, check] of Object.entries(optional)) {
        if (key in input && input[key] !== undefined) out[key] = check(input[key], `${p}.${key}`);
      }
    }
    return out as FromShape<S> & Partial<FromShape<O>>;
  };

/** Wraps a check into `validate` (asserts) / `is` (predicate) / `parse` (returns). */
export function validator<T>(check: Check<T>, root = '$') {
  return {
    check,
    parse: (value: unknown): T => check(value, root),
    validate: (value: unknown): asserts value is T => {
      check(value, root);
    },
    is: (value: unknown): value is T => {
      try {
        check(value, root);
        return true;
      } catch (e) {
        if (e instanceof ContractViolation) return false;
        throw e;
      }
    },
  };
}
