/**
 * THE ONE WAY AN FX PROVIDER IS CALLED (FX programme plan §6).
 *
 * `fetchWithBudget` with a per-attempt header timeout, one retry, the SSRF
 * guard, NO redirect (`maxRedirects: 0`: a 3xx is refused, never followed, so
 * a header never reaches a second host), the run's single 12-second
 * `AbortSignal` as `init.signal` (it bounds connect, body and the retry
 * together, and aborting it cancels the request), and a body read with a cap.
 *
 * EVERY FAILURE IS A CODE, NEVER A MESSAGE. A thrown error is mapped from its
 * class or `name` only; its `message` — which, for a malformed header value,
 * would carry the whole value — is never stored, logged or returned. The
 * `last_error_code` CHECK (`[A-Z0-9_]`, at most 40) refuses anything else.
 *
 * Imported only by the two adapters beside it.
 */
import { fetchWithBudget } from '@levonis/platform-kit/httpx';
import { KitError, TransientError } from '@levonis/platform-kit/errors';
import { readCapped } from '../readCapped';

export type TransportCode = 'TIMEOUT' | 'NETWORK' | 'REDIRECT_REFUSED' | 'TOO_LARGE' | 'KEY_REJECTED' | 'QUOTA' | `HTTP_${number}`;

export type TransportResult = { ok: true; text: string } | { ok: false; code: TransportCode };

/** The provider budget of plan §6: 8 s for headers per attempt, one retry on 5xx, a timeout or the network. */
export const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;

/** A thrown error → a code, from its class or name only. */
export function codeOfThrown(e: unknown, signal: AbortSignal): TransportCode {
  if (signal.aborted) return 'TIMEOUT';
  if (e instanceof KitError) return e.code === 'BAD_UPSTREAM' ? 'REDIRECT_REFUSED' : 'NETWORK';
  const name = e instanceof Error ? e.name : '';
  if (name === 'FetchTimeoutError' || name === 'AbortError' || name === 'TimeoutError') return 'TIMEOUT';
  if (e instanceof TransientError) {
    const cause = e.cause instanceof Error ? e.cause.name : '';
    return cause === 'AbortError' || cause === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
  }
  return 'NETWORK';
}

/**
 * One GET to a constant URL. `keyed` says whether a 401/403 means the key was
 * refused (IQWealth) or is just another status (the ECB has no key).
 */
export async function providerGet(
  url: string,
  headers: Record<string, string>,
  opts: {
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    provider: 'iqwealth' | 'ecb';
    maxBytes: number;
    keyed: boolean;
    /** Always 0: the type admits nothing else, so no caller can follow a redirect. */
    maxRedirects: 0;
  }
): Promise<TransportResult> {
  let res: Response;
  try {
    res = await fetchWithBudget(
      url,
      { method: 'GET', headers, signal: opts.signal },
      {
        timeoutMs: PROVIDER_ATTEMPT_TIMEOUT_MS,
        retries: 1,
        retryOn: [502, 503, 504, 'timeout', 'network'],
        maxRedirects: opts.maxRedirects,
        ssrfGuard: true,
        provider: opts.provider,
        fetchImpl: opts.fetchImpl,
      }
    );
  } catch (e) {
    return { ok: false, code: codeOfThrown(e, opts.signal) };
  }
  const status = res.status;
  if (status !== 200) {
    try {
      await res.body?.cancel();
    } catch {
      /* abandoned */
    }
    if (opts.keyed && (status === 401 || status === 403)) return { ok: false, code: 'KEY_REJECTED' };
    if (status === 429) return { ok: false, code: 'QUOTA' };
    if (status >= 300 && status < 400) return { ok: false, code: 'REDIRECT_REFUSED' };
    const n = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : 0;
    return { ok: false, code: `HTTP_${n}` };
  }
  const body = await readCapped(res, opts.maxBytes, opts.signal);
  if (!body.ok) return { ok: false, code: body.code };
  return { ok: true, text: body.text };
}
