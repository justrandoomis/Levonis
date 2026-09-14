/**
 * THE REQUEST PIPELINE (`01-TARGET.md` §3.2), in the documented order.
 *
 *   1  correlation id — minted here; a browser's value is never trusted
 *   2  strip every inbound `x-levonis-*` header (Studio's strip-then-set)
 *   3  classify the host; `foreign && underRoot` is refused
 *   4  origin check (Hono middleware, the core's own) + `Sec-Fetch-Site` sanity
 *   5  request validation: method, traversal, framing, content type, size
 *   6  route lookup — unknown `/api/*` and `/files/*` fall to CORE
 *   7  session → signed principal (skipped while the core resolves it itself)
 *   8  capability guard: host always, role and scope once a principal is held
 *   9  rate limit — after the principal, so user classes key by `sub`
 *   10 Turnstile, on flagged routes, only when the secret exists
 *   11 cache lookup for a safe anonymous GET
 *   12 forward over the binding: principal, hop envelope, correlation id,
 *      `x-levonis-host`; `Cookie` only to CORE and IDENTITY
 *   13 response: correlation echo, `Server-Timing`, `Cache-Control` for
 *      principal-bearing bodies, `Set-Cookie` stripped unless the upstream may
 *      set it, every internal header stripped
 *
 * WHAT MAKES IT SAFE TO PUT IN FRONT OF A LIVE SITE. Every step degrades
 * towards "forward it to the core exactly as it arrived":
 *   - no `IDENTITY` binding → anonymous, cookie forwarded, core decides
 *   - no signing key → no hop envelope (legal while `GATEWAY_ONLY=off`)
 *   - no limiter → the request is REFUSED (503), never silently unlimited
 *   - the resolved target's binding is missing → CORE
 *   - `CORE` missing → 503, because there is nothing left to be transparent to
 *
 * The one deliberate stricture is step 3: a host under the root domain that is
 * too deep to be a store (`a.b.levonis-iq.com`) is refused outright. One
 * wildcard certificate covers one label, and deeper names are where cookie and
 * certificate scoping mistakes get exploited.
 */
import type { Context } from 'hono';
import type { ApiFailure } from '@levonis/contracts/http/common';
import { CORRELATION_HEADER, HOP_HEADER, HOST_HEADER, PRINCIPAL_HEADER, LEGACY_PATH_HEADER, VERSION_HEADER } from '@levonis/contracts/http/common';
import type { HostInfo } from '@levonis/platform-kit/edge/hosts';
import { classifyHost, rootDomainFrom } from '@levonis/platform-kit/edge/hosts';
import { HTTP_FORWARD_METHOD, forwardArgs } from '@levonis/platform-kit/edge/gatewayOnly';
import { signHop, type HopSigner } from '@levonis/platform-kit/hop';
import { importSigningKey } from '@levonis/platform-kit/keys';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import { isHealthProbe, legacyHealthBody, healthReport } from '@levonis/platform-kit/health';
import { modeVar } from '@levonis/platform-kit/config';
import type { Logger } from '@levonis/platform-kit/log';
import type { HealthReport, Principal } from '@levonis/contracts/rpc/common';
import type { Env, ForwardTarget } from './env';
import { isOn, versionOf } from './env';
import { GONE_ROUTES, HEALTH_PATH, ROUTE_TARGETS, parseOverrides, phaseOf, resolve, type RouteRule } from './routes';
import { guard } from './capabilities';
import { validateRequest } from './validation';
import { canCache, canStore, clientCacheControl, storedCacheControl } from './cache';
import { buildLimiter, checkLimit, effectiveSpec, isIpExempt, limitFor, TOO_MANY_BODY } from './limiter';
import { PrincipalCache, PublicKeyCache, resolvePrincipal } from './principal';
import {
  challengeKeyFrom, CHALLENGE_HEADER, ChallengeMarkers, challengeRequired, CONDITIONAL_ROUTES, isChallengedRoute,
  isEnabled as turnstileEnabled, TURNSTILE_TOKEN_HEADER, verifyToken,
} from './turnstile';
import { identityClient } from './identity';

/** Headers a client may never set: the gateway is the only source of all of them. */
export const INTERNAL_HEADER_PREFIX = 'x-levonis-';
export const STRIPPED_REQUEST_HEADERS: readonly string[] = [CORRELATION_HEADER];

/** Only these upstreams may set a session cookie, and only they receive one. */
export const COOKIE_TARGETS: readonly string[] = ['CORE', 'IDENTITY'];

/** The Cache API surface the pipeline needs — injectable, because `caches` does not exist in Node. */
export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** Per-isolate state: caches that must survive between requests. */
export class GatewayState {
  readonly principals = new PrincipalCache();
  readonly keys = new PublicKeyCache();
  readonly challenges = new ChallengeMarkers();
  private signer: HopSigner | null | undefined;

  /** Built once per isolate. `null` means "no signing key configured", which is a supported state. */
  async hopSigner(env: Env): Promise<HopSigner | null> {
    if (this.signer !== undefined) return this.signer;
    const priv = (env.GATEWAY_SIGNING_KEY ?? '').trim();
    const pub = (env.GATEWAY_SIGNING_PUBLIC_KEY ?? '').trim();
    if (!priv || !pub) {
      this.signer = null;
      return null;
    }
    try {
      this.signer = { iss: 'gateway', key: await importSigningKey(priv, pub) };
    } catch {
      this.signer = null;
    }
    return this.signer;
  }
}

export interface PipelineDeps {
  state: GatewayState;
  cache?: EdgeCache | null;
  now?: () => number;
  log?: Logger;
  fetchImpl?: typeof fetch;
  /** injected so the shadow sampler is testable */
  random?: () => number;
  waitUntil?: (p: Promise<unknown>) => void;
}

export type GatewayContext = Context<{ Bindings: Env; Variables: { host: HostInfo; cid?: string } }>;

const json = (body: ApiFailure | Record<string, unknown>, status: number, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(headers ?? {}) } });

/** Step 3: the classification every later step reads. */
export function hostOf(c: GatewayContext): HostInfo {
  return c.get('host') ?? classifyHost(c.req.header('Host'), rootDomainFrom(c.env));
}

/**
 * Step 4b: `Sec-Fetch-Site` sanity. Browsers send it; when it says the request
 * came from another site and the method mutates, `originCheck` has already had
 * its say — this catches the case where `Origin` was stripped by an
 * intermediary but the fetch metadata survived.
 */
export function secFetchRefusal(method: string, headers: Headers): ApiFailure | null {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
  const site = headers.get('sec-fetch-site');
  if (site === 'cross-site') return { success: false, error: 'Cross-origin request rejected', code: 'FORBIDDEN' };
  return null;
}

/** Step 1+2: a request with every internal header removed and the correlation id set. */
export function sanitizeHeaders(original: Headers, cid: string): Headers {
  const out = new Headers(original);
  for (const name of [...out.keys()]) {
    if (name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) out.delete(name);
    else if (STRIPPED_REQUEST_HEADERS.includes(name.toLowerCase())) out.delete(name);
  }
  out.set(CORRELATION_HEADER, cid);
  return out;
}

export async function handle(c: GatewayContext, deps: PipelineDeps): Promise<Response> {
  const env = c.env;
  const started = (deps.now ?? Date.now)();
  const req = c.req.raw;
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();
  const ver = versionOf(env);

  // ---------------------------------------------------------------- step 1
  const cid = uuidv7();
  const respond = (res: Response, extra?: Record<string, string>): Response => {
    const out = new Response(res.body, res);
    out.headers.set(CORRELATION_HEADER, cid);
    if (ver !== 'dev') out.headers.set(VERSION_HEADER, ver);
    for (const [k, v] of Object.entries(extra ?? {})) out.headers.set(k, v);
    out.headers.set('Server-Timing', `gw;dur=${Math.max(0, (deps.now ?? Date.now)() - started)}`);
    return out;
  };

  // The lock (`01-TARGET.md` §3.1): before G3 the production gateway is not a
  // door at all. The probe token is compared in constant time.
  if (isOn(env.GATEWAY_LOCKED) && !isHealthProbe(req.headers, env.HEALTH_PROBE_TOKEN)) {
    return respond(json({ success: false, error: 'Gateway is not accepting traffic', code: 'FORBIDDEN' }, 403));
  }

  // ---------------------------------------------------------------- step 3
  const host = hostOf(c);
  if (host.underRoot && host.kind === 'foreign') return respond(json({ success: false, error: 'Not found' }, 404));

  // --------------------------------------------------------------- step 4b
  const sec = secFetchRefusal(method, req.headers);
  if (sec) return respond(json(sec, 403));

  // ---------------------------------------------------------------- step 5
  const refusal = validateRequest({ method, path, headers: req.headers, bodyStream: req.body !== null });
  if (refusal) return respond(json(refusal.body, refusal.status));

  // ---------------------------------------------------------------- step 6
  if (Object.prototype.hasOwnProperty.call(GONE_ROUTES, path)) {
    return respond(json({ success: false, error: GONE_ROUTES[path] }, 410));
  }
  if (path === HEALTH_PATH) {
    const own = await gatewayHealth(c, url, ver);
    if (own) return respond(own);
  }

  const phase = phaseOf(env.GATEWAY_PHASE);
  const overrides = parseOverrides(env.ROUTE_OVERRIDES, ROUTE_TARGETS);
  const resolution = resolve(path, method, phase, overrides);
  if (!resolution) return respond(json({ success: false, error: 'Not found' }, 404));
  const { rule } = resolution;

  // ---------------------------------------------------------------- step 7
  // One signer and one Identity client per request: the hop envelope, the
  // principal lookup and the rate counter all go through the same key.
  const signer = await deps.state.hopSigner(env);
  const identity = identityClient(env, signer, cid);
  const principalMode = modeVar(env.PRINCIPAL_MODE, ['off', 'shadow', 'on'], 'off');
  // `shadow` runs the lookup for a sampled share only (`01-TARGET.md` §3.2
  // step 7): the core receives BOTH the cookie and the forwarded principal and
  // compares its own `loadSessionUser()` with `principalToSessionUser()`, so
  // the share is a cost dial (one extra RPC per sampled request), raised from
  // 5 % to 100 % over the week before the class goes `on`.
  const shadowRate = Number.parseFloat((env.PRINCIPAL_SHADOW_RATE ?? '').trim());
  const resolveNow =
    principalMode === 'on' || (principalMode === 'shadow' && Number.isFinite(shadowRate) && (deps.random ?? Math.random)() < shadowRate);
  let principal: Principal | null = null;
  let principalHeader: string | null = null;
  if (resolveNow) {
    const outcome = await resolvePrincipal({
      identity,
      cookieHeader: req.headers.get('cookie'),
      host,
      cid,
      rateClass: rule.rateClass,
      cache: deps.state.principals,
      keys: deps.state.keys,
      ...(env.ALLOWED_CALLER_KIDS ? { bootstrapKids: env.ALLOWED_CALLER_KIDS } : {}),
    });
    if (outcome.kind === 'resolved') {
      principal = outcome.principal;
      principalHeader = outcome.header;
    } else if (outcome.kind === 'rejected') {
      deps.log?.warn('principal.rejected', { cid, reason: outcome.reason, path });
    }
  }

  // ---------------------------------------------------------------- step 8
  const denial = guard({ path, method, host, rule, principal, enforceIdentity: principalMode === 'on' });
  if (denial) return respond(json(denial.body, denial.status));

  // ---------------------------------------------------------------- step 9
  const clientIp = req.headers.get('CF-Connecting-IP') || 'unknown';
  const limiter = buildLimiter(env, identity);
  if (!limiter) {
    return respond(json({ success: false, error: 'Dependency unavailable: rate limiter', code: 'DEPENDENCY_UNAVAILABLE' }, 503));
  }
  const spec = effectiveSpec(limitFor(path, rule.rateClass), env.RATE_LIMIT_ENFORCE);
  // "Exempt from the ip class" means exactly that (§3.6): a bearer
  // server-to-server route keeps its OWN class, it is not left unlimited.
  if (!(spec.cls === 'ip' && isIpExempt(path))) {
    const check = await checkLimit(limiter, spec, principal?.sub ?? null, clientIp);
    if (check.refused) return respond(json(TOO_MANY_BODY, 429));
    if (!check.verdict.allowed) deps.log?.info('ratelimit.shadow', { cid, bucket: spec.bucket, count: check.verdict.count, path });
  }

  // --------------------------------------------------------------- step 10
  // Two ways a route is challenged: it is on the flagged list, or Identity
  // armed it for this caller after three failures (the login case — the
  // gateway never reads the credential body, it only remembers the marker
  // Identity handed back on the previous attempt).
  const turnstileOn = turnstileEnabled(env.TURNSTILE_SECRET);
  const challenged =
    turnstileOn &&
    (isChallengedRoute(path, method) || (isChallengedRoute(path, method, CONDITIONAL_ROUTES) && deps.state.challenges.isArmed(`ip:${clientIp}`)));
  if (challenged) {
    const token = req.headers.get(TURNSTILE_TOKEN_HEADER) ?? '';
    const verified = await verifyToken(env.TURNSTILE_SECRET!, token, req.headers.get('CF-Connecting-IP'), deps.fetchImpl);
    if (!verified.ok) {
      const refuse = challengeRequired(env.TURNSTILE_SITEKEY);
      deps.log?.warn('turnstile.refused', { cid, path, reason: verified.reason });
      return respond(json(refuse.body, refuse.status));
    }
  }

  // --------------------------------------------------------------- step 11
  let decision = rule.cacheable ? canCache(req, isOn(env.CACHE_MODE)) : null;
  if (path === '/api/products/cache-generation') decision = null;
  if (decision && /^(?:\/api\/(?:products|home|bundles|storefront|v1\/search)(?:\/|$)|\/files\/)/.test(path)) {
    try {
      const revisionUrl = new URL('/api/products/cache-generation', req.url).href;
      const revisionHeaders = sanitizeHeaders(new Headers(), cid);
      revisionHeaders.set(HOST_HEADER, `${host.kind};${host.slug ?? ''}`);
      if (signer) revisionHeaders.set(HOP_HEADER, JSON.stringify(await signHop(signer, {
        method: HTTP_FORWARD_METHOD, args: forwardArgs('GET', revisionUrl, revisionHeaders.get(HOST_HEADER)),
        principalHeader: null, nowSeconds: Math.floor((deps.now ?? Date.now)() / 1000),
      })));
      const revisionResponse = await env.CORE!.fetch(new Request(revisionUrl, { headers: revisionHeaders }));
      const generation = await revisionResponse.json() as { revision?: number };
      if (!revisionResponse.ok || !Number.isSafeInteger(generation.revision)) throw new Error('Catalog generation unavailable');
      const key = new URL(decision.key);
      key.searchParams.set('__catalog_revision', String(generation.revision));
      decision = { ...decision, key: key.href };
    } catch { decision = null; } // An unavailable primary cannot authorize stale data.
  }
  if (decision && deps.cache) {
    const hit = await deps.cache.match(decision.key);
    if (hit) {
      const out = new Response(hit.body, hit);
      stripInternal(out.headers);
      out.headers.set('Cache-Control', clientCacheControl());
      deps.log?.info('cache.hit', { cid, path, lang: decision.lang });
      return respond(out, legacyHeader(rule));
    }
  }

  // --------------------------------------------------------------- step 12
  const target = pickTarget(env, resolution.target);
  if (!target.binding) {
    return respond(json({ success: false, error: `Dependency unavailable: ${resolution.target}`, code: 'DEPENDENCY_UNAVAILABLE' }, 503));
  }
  const headers = sanitizeHeaders(req.headers, cid);
  headers.set(HOST_HEADER, `${host.kind};${host.slug ?? ''}`);
  if (principalHeader) headers.set(PRINCIPAL_HEADER, principalHeader);
  if (!COOKIE_TARGETS.includes(target.name)) headers.delete('cookie');

  if (signer) {
    const hop = await signHop(signer, {
      method: HTTP_FORWARD_METHOD,
      args: forwardArgs(method, req.url, headers.get(HOST_HEADER)),
      principalHeader,
      nowSeconds: Math.floor((deps.now ?? Date.now)() / 1000),
    });
    headers.set(HOP_HEADER, JSON.stringify(hop));
  }

  const forwarded = new Request(req.url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? null : req.body,
    redirect: 'manual',
    ...(method === 'GET' || method === 'HEAD' ? {} : { duplex: 'half' } as Record<string, unknown>),
  });

  const svcStarted = (deps.now ?? Date.now)();
  let upstream: Response;
  try {
    upstream = await target.binding.fetch(forwarded);
  } catch (e) {
    deps.log?.error('forward.failed', { cid, target: target.name, path, error: (e as Error).message });
    return respond(json({ success: false, error: `Dependency unavailable: ${target.name}`, code: 'DEPENDENCY_UNAVAILABLE' }, 503));
  }
  const svcMs = (deps.now ?? Date.now)() - svcStarted;

  // --------------------------------------------------------------- step 13
  // The body is materialised only when it is a cache candidate: everything
  // else is streamed through untouched, which is what keeps a 40 MB upload
  // response out of this isolate's memory.
  let body: string | null = null;
  if (decision && deps.cache && (upstream.headers.get('content-type') ?? '').includes('application/json')) {
    body = await upstream.clone().text();
  }

  // Identity's internal "challenge the next attempt for this caller" marker
  // (see ChallengeMarkers for where it is kept and why). The header itself
  // never leaves this Worker.
  const challengeMarker = upstream.headers.get(CHALLENGE_HEADER);
  if (turnstileOn && challengeMarker) deps.state.challenges.arm(challengeKeyFrom(challengeMarker, clientIp));

  const out = new Response(body ?? upstream.body, upstream);
  stripInternal(out.headers);
  if (!COOKIE_TARGETS.includes(target.name)) out.headers.delete('set-cookie');

  if (decision && deps.cache && body !== null && canStore(upstream, body)) {
    // Built from the STRIPPED headers, so nothing internal can be replayed
    // from the cache to a later client.
    const entry = new Response(body, { status: out.status, statusText: out.statusText, headers: new Headers(out.headers) });
    entry.headers.set('Cache-Control', storedCacheControl(decision.rule.ttl));
    const put = deps.cache.put(decision.key, entry);
    if (deps.waitUntil) deps.waitUntil(put);
    else await put;
  }

  if (principalHeader) out.headers.set('Cache-Control', 'private, no-store');
  else if (decision) out.headers.set('Cache-Control', clientCacheControl());
  const res = respond(out, legacyHeader(rule));
  res.headers.set('Server-Timing', `gw;dur=${Math.max(0, (deps.now ?? Date.now)() - started - svcMs)},svc;dur=${svcMs}`);
  return res;
}

/** Every `x-levonis-*` header the upstream set is internal and never leaves this Worker. */
export function stripInternal(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) headers.delete(name);
  }
}

function legacyHeader(rule: RouteRule): Record<string, string> {
  return rule.legacy ? { [LEGACY_PATH_HEADER]: '1' } : {};
}

/** The binding for a target, falling back to CORE — a prefix whose owner is not deployed yet is not a 404. */
export function pickTarget(env: Env, target: string): { name: string; binding: ForwardTarget | undefined } {
  const direct = (env as unknown as Record<string, ForwardTarget | undefined>)[target];
  if (direct && typeof direct.fetch === 'function') return { name: target, binding: direct };
  return { name: 'CORE', binding: env.CORE };
}

/**
 * `/api/health` (`01-TARGET.md` §3.3, §11.3). The bare path is FORWARDED to
 * the core — workflow 7's post-deploy probe must keep proving the Worker that
 * still runs auth, checkout and money — so this returns null for it and the
 * pipeline continues. Only `?gw=1` and `?deep=1` are answered here.
 */
export async function gatewayHealth(c: GatewayContext, url: URL, ver: string): Promise<Response | null> {
  const env = c.env;
  if (url.searchParams.get('gw') === '1') {
    return json({ ...legacyHealthBody(ver), svc: 'gateway' }, 200);
  }
  if (url.searchParams.get('deep') !== '1') return null;

  const probe = isHealthProbe(c.req.raw.headers, env.HEALTH_PROBE_TOKEN);
  if (!probe) return json({ success: false, error: 'Not found' }, 404);
  const deps: Record<string, { health(): Promise<HealthReport> } | undefined> = {};
  for (const name of ROUTE_TARGETS) {
    const b = (env as unknown as Record<string, ForwardTarget | undefined>)[name];
    if (b && typeof b.health === 'function') deps[name] = b as { health(): Promise<HealthReport> };
  }
  const report = await healthReport({ svc: 'gateway', ver, db: null, deps });
  return json({ success: report.ok, gateway: report }, report.ok ? 200 : 503);
}
