/**
 * A stand-in for the core, for LOCAL multi-config `wrangler dev` only.
 *
 * It exists so the gateway can be exercised as a real Worker — over a real
 * service binding, through workerd, with the real Cache API and the real
 * `ratelimits` binding — without running the monolith and its D1. It is never
 * deployed: no workflow references it, and `tests/leastPrivilege.test.ts` only
 * looks at `services/<name>/wrangler.jsonc`, which this is not.
 *
 * It answers `fetch` by echoing what it was handed (so the rig can assert on
 * the forwarded method, path and headers) and exposes `IdentityEntrypoint`
 * with the four methods the gateway is allowed to call. The signing key is
 * GENERATED IN MEMORY on first use and published through `getPublicKeys()`:
 * the rig therefore exercises the whole mint-forward-verify chain with no key
 * material anywhere in the repository, in a var, or on a command line.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { generateKeyPair, importSigningKey, type SigningKey } from '@levonis/platform-kit/keys';
import { buildPrincipal, signPrincipal } from '@levonis/platform-kit/principal';
import type { HostKind } from '@levonis/contracts/rpc/common';
import { sha256Hex } from '@levonis/contracts/canonical';

let signing: SigningKey | null = null;
async function devKey(): Promise<SigningKey> {
  if (!signing) {
    const pair = await generateKeyPair();
    signing = await importSigningKey(pair.privateKeyB64, pair.publicKeyB64);
  }
  return signing;
}

/** A per-isolate fixed window, standing in for the `rate_limits` table. */
const windows = new Map<string, { start: number; count: number }>();

export class IdentityEntrypoint extends WorkerEntrypoint {
  async resolveSession(input: { sid_hash: string; host_kind: HostKind; cid: string }) {
    // Any cookie resolves to the same dev customer, EXCEPT the literal token
    // `admin`, which is how the rig asks for an admin principal. The gateway
    // only ever sends the hash, so the stub compares hashes.
    const key = await devKey();
    const admin = input.sid_hash === (await sha256Hex('admin'));
    const principal = buildPrincipal(
      {
        sub: 'dev-user',
        sid_hash: input.sid_hash,
        role: admin ? 'admin' : 'customer',
        scope: admin ? 'full' : null,
        investor: false,
        tier: 'free',
        locale: 'en',
        host_kind: input.host_kind,
        cid: input.cid,
      },
      Math.floor(Date.now() / 1000)
    );
    return { principal: await signPrincipal(key, principal), exp: principal.exp };
  }

  async getPublicKeys() {
    const key = await devKey();
    return { keys: [{ kid: key.kid, alg: 'EdDSA' as const, public_key: key.publicKeyB64, service: 'identity', not_after: null }] };
  }

  async rateLimitHit(_cls: string, key: string, limit: number, windowSeconds: number) {
    const now = Math.floor(Date.now() / 1000);
    const start = now - (now % windowSeconds);
    const w = windows.get(key);
    if (!w || w.start !== start) {
      windows.set(key, { start, count: 1 });
      return { allowed: 1 <= limit, count: 1 };
    }
    w.count += 1;
    return { allowed: w.count <= limit, count: w.count };
  }

  async revoke(_sidHash: string) {
    return { revoked: true };
  }

  async health() {
    return { ok: true, svc: 'core-stub', ver: 'dev', checks: { db: 'skipped' as const } };
  }
}

export default class CoreStub extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' });
    }
    if (url.pathname.startsWith('/api/auth/login')) {
      // The internal marker the gateway turns into a Turnstile challenge.
      return Response.json({ success: false, error: 'Invalid credentials' }, { status: 401, headers: { 'x-levonis-challenge': 'turnstile' } });
    }
    return Response.json({
      success: true,
      seen: {
        method: request.method,
        path: url.pathname + url.search,
        host: request.headers.get('host'),
        levonis_host: request.headers.get('x-levonis-host'),
        correlation: request.headers.get('x-correlation-id'),
        principal: request.headers.get('x-levonis-principal') ? 'present' : null,
        hop: request.headers.get('x-levonis-hop') ? 'present' : null,
        cookie: request.headers.get('cookie') ? 'present' : null,
      },
    });
  }

  async health() {
    return { ok: true, svc: 'core-stub', ver: 'dev', checks: { db: 'skipped' as const } };
  }
}
