/**
 * Config / feature-flag reader (`01-TARGET.md` §2.4 "CONFIG.get", ADR-008):
 * an interface with an in-memory and a KV implementation. Reads are memoised
 * 30 s per isolate EXCEPT keys flagged `money: true` (`exchangeRate`,
 * `paymentMethods`, `minMarginPercent`, `communityFee*`, `pointsRules`), which
 * are read per request (TTL 0) — an admin rate change must never price a
 * checkout with a 30-s-old rate on another isolate.
 */
import { systemClock, type Clock } from './correlation';

export const CONFIG_MEMO_MS = 30_000;

/** Keys whose value is money-relevant: never memoised. */
export const MONEY_KEYS: ReadonlyArray<string | RegExp> = ['exchangeRate', 'paymentMethods', 'minMarginPercent', 'pointsRules', /^communityFee/];

export function isMoneyKey(key: string): boolean {
  return MONEY_KEYS.some((k) => (typeof k === 'string' ? k === key : k.test(key)));
}

export interface ConfigReader {
  get<T = unknown>(key: string): Promise<T | null>;
  getMany(keys: string[]): Promise<Record<string, unknown>>;
  flag(name: string, fallback?: boolean): Promise<boolean>;
}

export interface ConfigSource {
  read(key: string): Promise<unknown>;
}

/** Wraps a source with the memo rule; the same class serves memory and KV sources. */
export class MemoConfig implements ConfigReader {
  private readonly memo = new Map<string, { value: unknown; at: number }>();

  constructor(private readonly source: ConfigSource, private readonly clock: Clock = systemClock, private readonly memoMs = CONFIG_MEMO_MS) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    if (!isMoneyKey(key)) {
      const hit = this.memo.get(key);
      if (hit && this.clock.now() - hit.at < this.memoMs) return (hit.value ?? null) as T | null;
    }
    const value = await this.source.read(key);
    if (!isMoneyKey(key)) this.memo.set(key, { value, at: this.clock.now() });
    return (value ?? null) as T | null;
  }

  async getMany(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = await this.get(k);
    return out;
  }

  async flag(name: string, fallback = false): Promise<boolean> {
    const v = await this.get(`flag:${name}`);
    if (v === null || v === undefined) return fallback;
    return v === true || v === 'on' || v === 'true' || v === 1 || v === '1';
  }

  /** `SettingChanged`/`FlagChanged` consumers call this — additive invalidation, not the guarantee. */
  invalidate(key?: string): void {
    if (key === undefined) this.memo.clear();
    else this.memo.delete(key);
  }
}

export class MemorySource implements ConfigSource {
  constructor(private readonly values: Record<string, unknown> = {}) {}
  async read(key: string): Promise<unknown> {
    return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
  }
  set(key: string, value: unknown): void {
    this.values[key] = value;
  }
}

/** The subset of KVNamespace the reader needs. */
export interface KvLike {
  get(key: string, type: 'json'): Promise<unknown>;
}

export class KvSource implements ConfigSource {
  constructor(private readonly kv: KvLike, private readonly namespace = 'config') {}
  async read(key: string): Promise<unknown> {
    return this.kv.get(`${this.namespace}:${key}`, 'json');
  }
}

export const memoryConfig = (values: Record<string, unknown> = {}, clock?: Clock) => new MemoConfig(new MemorySource(values), clock);
export const kvConfig = (kv: KvLike, clock?: Clock) => new MemoConfig(new KvSource(kv), clock);

/** `on|off|log|shadow` style vars, read once per request. */
export function modeVar(value: string | undefined, allowed: readonly string[], fallback: string): string {
  const v = (value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}
