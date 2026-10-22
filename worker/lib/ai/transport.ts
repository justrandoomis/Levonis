/**
 * THE ONE WAY A MODEL PROVIDER IS REACHED OVER HTTP (push B plan §3).
 *
 * Modelled on the FX transport (worker/lib/fx/providers/transport.ts), with
 * the same four rules:
 *
 *   - A FIXED HOST ALLOWLIST. Only `https://api.anthropic.com` is ever
 *     called; any other URL is refused before a request exists.
 *   - NO REDIRECT. `redirect: 'manual'`, and any 3xx is `REDIRECT_REFUSED`,
 *     so the key header can never travel to a second host.
 *   - A RESPONSE BYTE CAP of 64 KB, read through the call's own deadline
 *     (worker/lib/fx/readCapped.ts): a trickling body is `TIMEOUT`, an
 *     oversized one `TOO_LARGE`.
 *   - EVERY FAILURE IS A CODE, NEVER A MESSAGE. A thrown error is mapped from
 *     its name only; its message is never read, logged, stored or returned.
 *
 * No SDK: with nodejs_compat an SDK reads `process.env` on its own (base URL,
 * log level, telemetry), adds Worker weight, and could not run under tests
 * with the network disabled. The transport is injectable (`Transport`), so
 * every test hands in a fake and nothing reaches a real host.
 */
import { readCapped } from '../fx/readCapped';
import type { FailCode, Transport } from './types';

export const PROVIDER_HOSTS: readonly string[] = ['api.anthropic.com'];
export const RESPONSE_CAP_BYTES = 64 * 1024;

export type HttpOutcome = { ok: true; status: number; body: string } | { ok: false; code: FailCode };

/** The platform fetch, looked up at call time so a test's global tripwire still sees it. */
export const defaultTransport: Transport = (url, init) => fetch(url, init);

/** The allowlist, as a question: https, the exact host, no credentials, no port. */
export function allowedProviderUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && PROVIDER_HOSTS.includes(u.hostname) && u.port === '' && u.username === '' && u.password === '';
}

/** A thrown error → a code, from the signal and the error's name only. */
export function codeOfThrown(e: unknown, signal: AbortSignal): FailCode {
  if (signal.aborted) return 'TIMEOUT';
  const name = e instanceof Error ? e.name : '';
  return name === 'AbortError' || name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
}

/**
 * One request to an allowlisted provider URL. A non-2xx status is NOT a
 * failure here: its body is read (capped) and handed back, because the
 * provider adapter maps the status and the error TYPE to a code. Only the
 * transport's own failures (host, redirect, network, deadline, size) are
 * codes at this level.
 */
export async function providerRequest(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal },
  transport: Transport = defaultTransport
): Promise<HttpOutcome> {
  if (!allowedProviderUrl(url)) return { ok: false, code: 'NETWORK' };
  if (init.signal.aborted) return { ok: false, code: 'TIMEOUT' };
  let res: Response;
  try {
    res = await transport(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: 'manual',
    });
  } catch (e) {
    return { ok: false, code: codeOfThrown(e, init.signal) };
  }
  const status = Number(res.status);
  if ((status >= 300 && status < 400) || (res.type as string) === 'opaqueredirect') {
    try {
      await res.body?.cancel();
    } catch {
      /* the body is abandoned either way */
    }
    return { ok: false, code: 'REDIRECT_REFUSED' };
  }
  const read = await readCapped(res, RESPONSE_CAP_BYTES, init.signal);
  if (!read.ok) return { ok: false, code: read.code };
  return { ok: true, status, body: read.text };
}
