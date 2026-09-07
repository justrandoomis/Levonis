/**
 * `gatewayOnly()` (`01-TARGET.md` §4 item 1): every internal Worker — and the
 * core once `GATEWAY_ONLY=on` — verifies the gateway's hop envelope on inbound
 * HTTP. Modes: `off` (today) -> `log` (count requests that did not come
 * through the gateway) -> `on` (`403 NOT_VIA_GATEWAY`). Health probes with the
 * constant-time-compared token pass in every mode.
 */
import type { Context, Next } from 'hono';
import { HOP_HEADER, HOST_HEADER, PRINCIPAL_HEADER } from '@levonis/contracts/http/common';
import type { AppContext } from './types';
import { verifyHop, NonceSet } from '../hop';
import type { KeyRing } from '../keys';
import { isHealthProbe } from '../health';
import { modeVar } from '../config';

export type GatewayOnlyMode = 'off' | 'log' | 'on';
export const GATEWAY_ONLY_MODES: readonly GatewayOnlyMode[] = ['off', 'log', 'on'];

export interface GatewayOnlyOptions {
  /** the `GATEWAY_ONLY` var */
  mode: string | undefined;
  /** the gateway's public key(s) */
  ring: KeyRing;
  /** issuers accepted as "the gateway" */
  issuers?: readonly string[];
  nonces?: NonceSet;
  nowSeconds?: () => number;
  /** `HEALTH_PROBE_TOKEN` — probes pass without a hop */
  probeToken?: string;
  onNotViaGateway?: (info: { path: string; reason: string; mode: GatewayOnlyMode }) => void;
}

/** The hop `method` the gateway signs for a forwarded HTTP request. */
export const HTTP_FORWARD_METHOD = 'http.forward';

/** What the gateway hashes as `args` for a forwarded request: method + path + the internal host header. */
export function forwardArgs(method: string, url: string, hostHeader: string | null): { method: string; path: string; host: string | null } {
  const u = new URL(url);
  return { method: method.toUpperCase(), path: u.pathname + u.search, host: hostHeader };
}

export function gatewayOnly(opts: GatewayOnlyOptions) {
  const nonces = opts.nonces ?? new NonceSet();
  const issuers = opts.issuers ?? ['gateway'];
  const now = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  return async (c: Context<AppContext>, next: Next) => {
    const mode = modeVar(opts.mode, GATEWAY_ONLY_MODES, 'off') as GatewayOnlyMode;
    if (mode === 'off') return next();
    if (isHealthProbe(c.req.raw.headers, opts.probeToken)) return next();
    const raw = c.req.header(HOP_HEADER);
    let reason = 'MISSING_HOP';
    if (raw) {
      let hop: unknown = null;
      try {
        hop = JSON.parse(raw);
      } catch {
        reason = 'MALFORMED';
      }
      if (hop) {
        const v = await verifyHop({
          hop,
          method: HTTP_FORWARD_METHOD,
          args: forwardArgs(c.req.method, c.req.url, c.req.header(HOST_HEADER) ?? null),
          principalHeader: c.req.header(PRINCIPAL_HEADER) ?? null,
          allowedIssuers: issuers,
          ring: opts.ring,
          nonces,
          nowSeconds: now(),
        });
        if (v.ok) {
          c.set('hopIss', v.iss);
          return next();
        }
        reason = v.reason;
      }
    }
    opts.onNotViaGateway?.({ path: new URL(c.req.url).pathname, reason, mode });
    if (mode === 'log') {
      c.set('hopIss', null);
      return next();
    }
    return c.json({ success: false, error: 'Not via gateway', code: 'NOT_VIA_GATEWAY' }, 403);
  };
}
