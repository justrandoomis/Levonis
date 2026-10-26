/**
 * Small, pure helpers every Print Cloud module shares: ids, the clock, input
 * validation and EXACT integer arithmetic.
 *
 * MONEY IS NEVER A FLOAT. Prices are integer dinars, per-unit prices are
 * integer thousandths of a dinar, rates are basis points; every product of two
 * of them runs in BigInt and is rounded exactly once, half up, at the end
 * (`mulDivRound`). A 1 kg spool at 24,250 IQD with 500 g left at 50 % is
 * 24,250 × 500 × 5,000 / (1,000 × 10,000) = 6,062.5 → 6,063 IQD, the same on
 * every machine.
 */
import { newId } from '../crypto';
import { invalid } from './errors';

export const pcId = (prefix: string): string => newId(prefix);

export const iso = (d: Date): string => d.toISOString();

export const addSeconds = (d: Date, seconds: number): Date => new Date(d.getTime() + seconds * 1000);

export const SECONDS_PER_HOUR = 3600;

/** a × b / c rounded half up, exactly. All three must be non-negative integers and c > 0. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c) || a < 0 || b < 0 || c <= 0) {
    throw new Error('mulDivRound: non-negative safe integers required');
  }
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  const q = (n * 2n + d) / (d * 2n);
  return Number(q);
}

/** a × b × e / (c × f) rounded half up, exactly (three-factor share, e.g. value × qty × rate). */
export function mulMulDivRound(a: number, b: number, e: number, c: number, f: number): number {
  for (const v of [a, b, e, c, f]) if (!Number.isSafeInteger(v) || v < 0) throw new Error('mulMulDivRound: integers required');
  if (c === 0 || f === 0) throw new Error('mulMulDivRound: zero divisor');
  const n = BigInt(a) * BigInt(b) * BigInt(e);
  const d = BigInt(c) * BigInt(f);
  return Number((n * 2n + d) / (d * 2n));
}

/** a × b / c rounded DOWN (floor), exactly. */
export function mulDivFloor(a: number, b: number, c: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c) || a < 0 || b < 0 || c <= 0) {
    throw new Error('mulDivFloor: non-negative safe integers required');
  }
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

/** Round a dinar amount UP to the next multiple of `step` (0 or 1 = no rounding). */
export function roundUpTo(amount: number, step: number): number {
  if (!step || step <= 1) return amount;
  return Math.ceil(amount / step) * step;
}

/** Round to the nearest multiple of `step`, half up. */
export function roundNearest(amount: number, step: number): number {
  if (!step || step <= 1) return amount;
  return Math.floor((amount + step / 2) / step) * step;
}

/**
 * Split `total` across `weights` so the parts are integers that sum EXACTLY to
 * `total` (largest-remainder). Used to share a discount over lines.
 */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => mulDivFloor(total, w, sum));
  let left = total - raw.reduce((s, v) => s + v, 0);
  const order = weights
    .map((w, i) => ({ i, rem: Number((BigInt(total) * BigInt(w)) % BigInt(sum)) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    raw[i] += 1;
    left -= 1;
  }
  return raw;
}

// ------------------------------------------------------------------ input

export function reqString(v: unknown, field: string, opts: { max?: number; min?: number } = {}): string {
  if (typeof v !== 'string') throw invalid(field, 'required');
  const s = v.trim();
  if (s.length < (opts.min ?? 1)) throw invalid(field, 'required');
  if (s.length > (opts.max ?? 200)) throw invalid(field, 'too_long');
  return s;
}

export function optString(v: unknown, field: string, max = 2000): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw invalid(field, 'not_a_string');
  const s = v.trim();
  if (s.length > max) throw invalid(field, 'too_long');
  return s;
}

/** An integer within bounds; a float, a numeric string or a NaN is refused, never rounded. */
export function reqInt(v: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalid(field, 'integer_required');
  if (opts.min !== undefined && v < opts.min) throw invalid(field, 'too_small');
  if (opts.max !== undefined && v > opts.max) throw invalid(field, 'too_large');
  return v;
}

export function optInt(v: unknown, field: string, opts: { min?: number; max?: number } = {}): number | null {
  if (v === undefined || v === null) return null;
  return reqInt(v, field, opts);
}

export function reqBool01(v: unknown, field: string, def: 0 | 1): 0 | 1 {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw invalid(field, 'boolean_required');
  return v ? 1 : 0;
}

export function reqEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw invalid(field, 'not_allowed');
  return v as T;
}

export function optEnum<T extends string>(v: unknown, field: string, allowed: readonly T[], def: T): T {
  if (v === undefined || v === null) return def;
  return reqEnum(v, field, allowed);
}

export function reqObject(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(field, 'object_required');
  return v as Record<string, unknown>;
}

export function reqArray(v: unknown, field: string, max = 100): unknown[] {
  if (!Array.isArray(v)) throw invalid(field, 'array_required');
  if (v.length > max) throw invalid(field, 'too_many');
  return v;
}

/** A trilingual name: all three present (a ckb slot never defaults to the Arabic). */
export function names(body: Record<string, unknown>, prefix = 'name'): { ar: string; en: string; ckb: string } {
  return {
    ar: reqString(body[`${prefix}_ar`], `${prefix}_ar`),
    en: reqString(body[`${prefix}_en`], `${prefix}_en`),
    ckb: reqString(body[`${prefix}_ckb`], `${prefix}_ckb`),
  };
}

export function optIso(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid(field, 'iso_date_required');
  return new Date(v).toISOString();
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Canonical JSON (sorted keys) — the input of a request hash. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/** Seconds as the customer reads them: { hours, minutes } (display only, never stored). */
export function hoursMinutes(seconds: number): { hours: number; minutes: number; seconds: number } {
  const s = Math.max(0, Math.floor(seconds));
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s };
}

/** Pick a localized name triple from a row carrying name_ar/name_en/name_ckb. */
export function nameOf(row: { name_ar?: unknown; name_en?: unknown; name_ckb?: unknown }): { ar: string; en: string; ckb: string } {
  return { ar: String(row.name_ar ?? ''), en: String(row.name_en ?? ''), ckb: String(row.name_ckb ?? '') };
}
