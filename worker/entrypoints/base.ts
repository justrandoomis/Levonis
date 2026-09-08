/**
 * THE NAMED ENTRYPOINTS' SHARED BASE (02-MIGRATION-PLAN.md 1.6, `01-TARGET.md`
 * §4 item 3).
 *
 * A named `WorkerEntrypoint` export is how another Worker calls this one over
 * a service binding: `services: [{ binding: 'IDENTITY', service:
 * 'levonis-core-dark', entrypoint: 'IdentityEntrypoint' }]`. The public methods
 * of those classes ARE the contract — `worker/entrypoints/CONTRACT.md` lists
 * them and `packages/contracts/src/rpc/*.ts` types them.
 *
 * WHY THE BASE CLASS IS RESOLVED THIS WAY. `cloudflare:workers` exists only on
 * the Workers runtime; Node — which runs the unit suite, and which imports
 * `worker/index.ts` in `tests/adminHostGuard.test.ts` to drive every admin
 * route — cannot resolve it at all. A static import would therefore take the
 * whole test suite down. So the base class is imported dynamically at module
 * scope with a Node stand-in as the fallback: on the Workers runtime the real
 * `WorkerEntrypoint` is used (verified against a live `wrangler dev` service
 * binding, RPC call and `this.env` alike), and under Node the classes are
 * still ordinary constructible objects the tests can exercise directly.
 *
 * THE HOP ASSERTION. Every call must carry the caller's signed hop envelope
 * (`{iss, kid, iat, exp, nonce, method, args_hash, principal_hash}`) and it is
 * verified — signature, issuer, per-method allowlist, argument hash, 30-second
 * window, replay — before a method touches anything. Binding identity is
 * account-level trust (03-EVENTS.md, accepted risk 3): any Worker on the
 * account could call these methods, so the hop is what says WHICH one did and
 * WHAT it asked for. While `ALLOWED_CALLER_KIDS` is unset — every deployment
 * today — no caller is registered, the assertion is `off`, and nothing is
 * bound to call these methods anyway.
 */
import type { HopEnvelope, HealthReport, RpcCtx } from '@levonis/contracts/rpc/common';
import { KeyRing } from '@levonis/platform-kit/keys';
import { NonceSet, verifyHop, type MethodAllowlist, allowedIssuersFor } from '@levonis/platform-kit/hop';
import { healthReport } from '@levonis/platform-kit/health';
import { modeVar } from '@levonis/platform-kit/config';
import { configureEventBus, outboxLagSeconds } from '../lib/eventBus';
import type { Env } from '../lib/types';

interface EntrypointBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (ctx: any, env: any): { ctx: ExecutionContext; env: Env };
}

let Resolved: EntrypointBase;
try {
  const mod = (await import('cloudflare:workers')) as unknown as { WorkerEntrypoint: EntrypointBase };
  Resolved = mod.WorkerEntrypoint;
} catch {
  // Node (the unit suite): a structural stand-in with the same two fields.
  Resolved = class {
    constructor(
      public ctx: ExecutionContext,
      public env: Env
    ) {}
  } as unknown as EntrypointBase;
}

/** The real `WorkerEntrypoint` on Workers, a plain class under Node. */
export const RuntimeEntrypoint = Resolved;

export type HopMode = 'off' | 'log' | 'on';
export const HOP_MODES: readonly HopMode[] = ['off', 'log', 'on'];

/**
 * Which service may call which method. A caller not named here is refused even
 * with a valid signature — the gateway, for instance, may introspect a session
 * and count a rate-limit hit, and may never touch money or roles (ADR-015).
 */
export const CORE_METHOD_CALLERS: MethodAllowlist = {
  'IdentityEntrypoint.introspect': ['gateway', 'studio'],
  'IdentityEntrypoint.redeemHandoff': ['studio'],
  'IdentityEntrypoint.resolveSession': ['gateway'],
  'IdentityEntrypoint.revoke': ['gateway'],
  'IdentityEntrypoint.getPublicKeys': ['*'],
  'IdentityEntrypoint.rateLimitHit': ['*'],
  'IdentityEntrypoint.lookupUsers': ['*'],
  // Display names are public-ish; CONTACTS are not. `lookupContacts` returns
  // addresses and phone numbers in bulk, so it goes to the Admin BFF and
  // Support and to nobody else — deliberately NOT the gateway (ADR-015), and
  // deliberately not `*`. Its absence here was not a permissive gap but a
  // fail-closed one: `allowedIssuersFor` answers `[]` for an unknown method,
  // so every caller — including a correctly signed one — was refused
  // `ISSUER_NOT_ALLOWED` the moment `ALLOWED_CALLER_KIDS` was set.
  'IdentityEntrypoint.lookupContacts': ['admin', 'support'],
  'IdentityEntrypoint.contactFor': ['notifications'],
  'LedgerEntrypoint.getBalances': ['commerce', 'marketplace', 'subscriptions', 'admin'],
  'LedgerEntrypoint.getBreakdown': ['commerce', 'admin'],
  'LedgerEntrypoint.hold': ['commerce', 'marketplace', 'subscriptions'],
  'LedgerEntrypoint.commitHoldAndDebit': ['commerce', 'marketplace', 'subscriptions'],
  'LedgerEntrypoint.releaseHold': ['commerce', 'marketplace', 'subscriptions'],
  'LedgerEntrypoint.reconcile': ['admin'],
  'CatalogEntrypoint.isPrinterCatalog': ['*'],
  'CatalogEntrypoint.listForIndex': ['search'],
  'OrdersEntrypoint.canAccessOrder': ['chat', 'files', 'support'],
  'OrdersEntrypoint.itemSnapshots': ['devices', 'fulfilment', 'invoices'],
};

const rings = new WeakMap<object, Promise<KeyRing>>();
const nonces = new NonceSet();

/** One ring per environment object, built once and reused by every call in the isolate. */
function ringFor(env: Env): Promise<KeyRing> {
  const cached = rings.get(env as unknown as object);
  if (cached) return cached;
  const built = KeyRing.fromAllowlist(env.ALLOWED_CALLER_KIDS).catch((e) => {
    console.error('ALLOWED_CALLER_KIDS could not be parsed:', e instanceof Error ? e.message : String(e));
    return new KeyRing();
  });
  rings.set(env as unknown as object, built);
  return built;
}

/** Refused by the hop assertion — the caller sees the reason, never the detail. */
export class HopRefused extends Error {
  constructor(readonly reason: string, readonly method: string) {
    super(`HOP_REFUSED:${reason}`);
    this.name = 'HopRefused';
  }
}

/**
 * The mode: `on` as soon as any caller key is configured, `off` while none is —
 * a Worker with no registered callers is a Worker nothing is bound to. An
 * explicit `ENTRYPOINT_HOP` var overrides both directions.
 */
export function hopMode(env: Env): HopMode {
  const explicit = (env as unknown as { ENTRYPOINT_HOP?: string }).ENTRYPOINT_HOP;
  if (explicit) return modeVar(explicit, HOP_MODES, 'off') as HopMode;
  return (env.ALLOWED_CALLER_KIDS ?? '').trim() ? 'on' : 'off';
}

export class CoreEntrypoint extends RuntimeEntrypoint {
  /** The service name this entrypoint belongs to, for the method allowlist. */
  protected get entrypointName(): string {
    return this.constructor.name;
  }

  /**
   * Verifies the caller's hop for THIS method and THESE arguments. Throws
   * `HopRefused` in `on` mode; logs and continues in `log`; returns at once in
   * `off`. Called first by every public method.
   */
  protected async assertHop(method: string, args: unknown, ctx?: RpcCtx | { hop?: HopEnvelope }): Promise<void> {
    const env = this.env;
    const mode = hopMode(env);
    if (mode === 'off') return;
    const qualified = `${this.entrypointName}.${method}`;
    const hop = (ctx as { hop?: HopEnvelope } | undefined)?.hop;
    let reason = 'MISSING_HOP';
    if (hop) {
      const v = await verifyHop({
        hop,
        method: qualified,
        args,
        principalHeader: (ctx as RpcCtx | undefined)?.principal ?? null,
        allowedIssuers: allowedIssuersFor(CORE_METHOD_CALLERS, qualified),
        ring: await ringFor(env),
        nonces,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (v.ok) return;
      reason = v.reason;
    }
    console.warn(`entrypoint hop refused (${mode})`, qualified, reason);
    if (mode === 'on') throw new HopRefused(reason, qualified);
  }

  /** Configures the event bus for this invocation, exactly as `fetch` does. */
  protected ready(): Env {
    configureEventBus(this.env);
    return this.env;
  }

  /**
   * `health()` — never hop-guarded: a probe that must authenticate cannot
   * report that authentication is broken.
   */
  async health(): Promise<HealthReport> {
    const env = this.ready();
    return healthReport({
      svc: 'core',
      ver: env.LEVONIS_VERSION ?? 'dev',
      db: env.DB,
      outboxLagS: () => outboxLagSeconds(env),
    });
  }
}
