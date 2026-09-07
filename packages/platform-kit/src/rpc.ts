/**
 * The RPC client wrapper (`01-TARGET.md` §11.5, `02-MIGRATION-PLAN.md` 1.2):
 * a proxy over a service-binding stub that attaches the call context
 * (`cid`, forwarded principal, idempotency key, a freshly signed hop) as the
 * LAST argument, enforces a budget (3 s default; 10 s for import/media),
 * retries only idempotent methods (every money command is — it carries an
 * `eventKey`), never a mutating HTTP forward, and keeps a circuit breaker per
 * (service, method): open after 5 consecutive failures, half-open after 30 s,
 * open -> `503 DEPENDENCY_UNAVAILABLE`. Money commands are never skipped on an
 * open breaker: they fail the request the same way, and the caller decides.
 */
import type { RpcCtx } from '@levonis/contracts/rpc/common';
import { signHop, type HopSigner } from './hop';
import { dependencyUnavailable, isTransient, TransientError } from './errors';
import { systemClock, type Clock } from './correlation';

export const DEFAULT_RPC_BUDGET_MS = 3_000;
export const LONG_RPC_BUDGET_MS = 10_000;

export class RpcTimeoutError extends TransientError {
  constructor(public readonly method: string, public readonly afterMs: number) {
    super(`RPC ${method} timed out after ${afterMs} ms`);
    this.name = 'RpcTimeoutError';
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold?: number; // default 5
  halfOpenAfterMs?: number; // default 30 s
}

/** One breaker per (service, method) or per external provider. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly halfOpenAfterMs: number;

  constructor(opts: BreakerOptions = {}, private readonly clock: Clock = systemClock) {
    this.threshold = opts.failureThreshold ?? 5;
    this.halfOpenAfterMs = opts.halfOpenAfterMs ?? 30_000;
  }

  get state(): BreakerState {
    if (this.failures < this.threshold) return 'closed';
    return this.clock.now() - this.openedAt >= this.halfOpenAfterMs ? 'half_open' : 'open';
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** True when a request may be attempted; in half-open exactly one trial passes. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half_open' && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.failures = 0;
    this.trialInFlight = false;
  }

  onFailure(): void {
    this.failures += 1;
    this.trialInFlight = false;
    if (this.failures === this.threshold) this.openedAt = this.clock.now();
    else if (this.failures > this.threshold) this.openedAt = this.clock.now(); // a failed trial re-opens for another window
  }
}

export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  constructor(private readonly opts: BreakerOptions = {}, private readonly clock: Clock = systemClock) {}

  for(service: string, method: string): CircuitBreaker {
    const key = `${service}.${method}`;
    let b = this.breakers.get(key);
    if (!b) {
      b = new CircuitBreaker(this.opts, this.clock);
      this.breakers.set(key, b);
    }
    return b;
  }

  snapshot(): Record<string, BreakerState> {
    return Object.fromEntries([...this.breakers].map(([k, b]) => [k, b.state]));
  }
}

/** A request-scoped budget shared by every RPC the request makes. */
export interface Budget {
  readonly deadline: number;
  remaining(): number;
}

export function createBudget(totalMs: number, clock: Clock = systemClock): Budget {
  const deadline = clock.now() + totalMs;
  return { deadline, remaining: () => Math.max(0, deadline - clock.now()) };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error, timers: Timers = realTimers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = timers.setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        timers.clearTimeout(handle);
        resolve(v);
      },
      (e) => {
        timers.clearTimeout(handle);
        reject(e);
      }
    );
  });
}

export interface RpcClientOptions {
  /** the callee's service name, for breakers and logs */
  service: string;
  /** `'LedgerEntrypoint'` — the hop `method` is `<entrypoint>.<method>` */
  entrypoint: string;
  signer: HopSigner;
  cid: string;
  principalHeader?: string | null;
  idempotencyKey?: string;
  budgetMs?: number;
  budget?: Budget;
  retries?: number; // default 2 (3 attempts) for idempotent methods
  isIdempotent?: (method: string) => boolean; // default: every method except those listed in nonIdempotent
  nonIdempotent?: readonly string[];
  breakers?: BreakerRegistry;
  clock?: Clock;
  timers?: Timers;
  sleep?: (ms: number) => Promise<void>;
  onCall?: (info: { method: string; ms: number; ok: boolean; attempt: number }) => void;
}

type Tail<A extends unknown[]> = A extends [...infer Rest, RpcCtx] ? Rest : A;
/** The caller-facing shape: every method minus its trailing `ctx`. */
export type RpcClientOf<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: Tail<A & unknown[]>) => R : never;
};

/** Any service-binding stub: its methods are looked up by name at call time. */
export type RpcTarget = object;

export function createRpcClient<T extends object>(target: RpcTarget, opts: RpcClientOptions): RpcClientOf<T> {
  const clock = opts.clock ?? systemClock;
  const timers = opts.timers ?? realTimers;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => timers.setTimeout(() => r(), ms)));
  const breakers = opts.breakers ?? new BreakerRegistry({}, clock);
  const retries = opts.retries ?? 2;
  const nonIdempotent = new Set(opts.nonIdempotent ?? ['forward']);
  const isIdempotent = opts.isIdempotent ?? ((m: string) => !nonIdempotent.has(m));

  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const fullMethod = `${opts.entrypoint}.${method}`;
    const breaker = breakers.for(opts.service, method);
    const maxAttempts = isIdempotent(method) ? retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!breaker.tryAcquire()) throw dependencyUnavailable(`${opts.service}.${method}`);
      const budgetLeft = opts.budget ? opts.budget.remaining() : opts.budgetMs ?? DEFAULT_RPC_BUDGET_MS;
      if (budgetLeft <= 0) throw new RpcTimeoutError(fullMethod, 0);
      const started = clock.now();
      try {
        const hop = await signHop(opts.signer, { method: fullMethod, args, principalHeader: opts.principalHeader, nowSeconds: Math.floor(clock.now() / 1000) });
        const ctx: RpcCtx = { cid: opts.cid, hop, ...(opts.principalHeader ? { principal: opts.principalHeader } : {}), ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) };
        const fn = (target as Record<string, unknown>)[method];
        if (typeof fn !== 'function') throw new TypeError(`${opts.service} has no method ${method}`);
        const result = await withTimeout(Promise.resolve((fn as (...a: unknown[]) => unknown).call(target, ...args, ctx)), budgetLeft, () => new RpcTimeoutError(fullMethod, budgetLeft), timers);
        breaker.onSuccess();
        opts.onCall?.({ method: fullMethod, ms: clock.now() - started, ok: true, attempt });
        return result;
      } catch (e) {
        lastError = e;
        breaker.onFailure();
        opts.onCall?.({ method: fullMethod, ms: clock.now() - started, ok: false, attempt });
        const retryable = isTransient(e) || e instanceof RpcTimeoutError;
        if (attempt < maxAttempts && retryable) {
          await sleep(Math.min(1000, 50 * 2 ** (attempt - 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  };

  return new Proxy({} as RpcClientOf<T>, {
    get: (_t, prop) => {
      if (typeof prop !== 'string') return undefined;
      return (...args: unknown[]) => call(prop, args);
    },
  });
}
