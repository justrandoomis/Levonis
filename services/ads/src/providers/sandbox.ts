/**
 * The SANDBOX adapter (`01-TARGET.md` §9.1: "all stubs that validate mapping
 * and write `ads_deliveries(status='sandbox')` when their secrets are absent").
 *
 * It WRAPS a real adapter rather than replacing it, so the mapping under test
 * is the same code that would run in production — the only difference is that
 * `send()` returns without touching the network. That is what makes the
 * "unset the secret" emergency switch of §9.1 safe: the mapping keeps being
 * exercised and recorded, and nothing can leave the account.
 *
 * `test/sandbox.test.ts` proves the no-network property the hard way: it hands
 * the registry a `fetchImpl` that throws on any call, and asserts every
 * unconfigured provider still produces a `sandbox` delivery row.
 */
import type { AdsProvider, ProviderEvent, SendOptions, SendResult } from '../types';

export class SandboxProvider implements AdsProvider {
  readonly name;

  constructor(private readonly inner: AdsProvider) {
    this.name = inner.name;
  }

  /** Always false: a sandbox adapter exists precisely because the real one is not configured. */
  configured(): boolean {
    return false;
  }

  /** The real mapping, unchanged — a sandbox delivery still proves the payload is well formed. */
  map(...args: Parameters<AdsProvider['map']>): ProviderEvent | null {
    return this.inner.map(...args);
  }

  /**
   * No fetch, no breaker, no timeout — there is nothing to time out. The count
   * is reported as accepted so the caller records a `sandbox` row rather than a
   * failure: nothing went wrong, the platform is simply not connected.
   */
  async send(events: ProviderEvent[], _env: Record<string, string | undefined>, _opts: SendOptions): Promise<SendResult> {
    return { accepted: events.length, rejected: 0, sandbox: true };
  }
}

/** `noop` — the default provider (`01-TARGET.md` §9.1). It maps nothing and sends nothing. */
export class NoopProvider implements AdsProvider {
  readonly name = 'noop' as const;

  configured(): boolean {
    return false;
  }

  map(): ProviderEvent | null {
    return null;
  }

  async send(): Promise<SendResult> {
    return { accepted: 0, rejected: 0, sandbox: true };
  }
}
