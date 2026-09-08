# `levonis-gateway` — contract

Worker names: `levonis-gateway` (production, no traffic until G3),
`levonis-gateway-dark` (`env.dark`, the dark zone).
Design: `docs/architecture/01-TARGET.md` §3, §4, §11.3 · plan slice 1.5.

## 1. What it is

The only new Worker with zone routes. It holds **no business logic, no domain
table and no SQL** (`OWNERSHIP.json` has empty `owns`/`reads`, and
`tests/serviceBoundaries.test.ts` fails on the first SQL literal that appears
in `src/`). It classifies the host, applies the core's own origin check and
security headers, resolves a session into a signed principal, enforces the
capability table, limits, validates, caches what is safe to cache, and forwards
everything else over a service binding.

## 2. RPC surface (`WorkerEntrypoint`, `src/index.ts`)

| Method | Callers | What it does |
|---|---|---|
| `fetch(request)` | the zone (via routes, from G3) | the pipeline of §3.2 |
| `health()` | `probe-health.mjs` through a bound caller | `{ok, svc:'gateway', ver, checks}` — no database, so `db:'skipped'` |
| `deliver(batch)` | producers of `SessionRevoked` / `RoleChanged` | evicts the principal cache. Idempotent by nature: no `processed_events`, no store |

## 3. HTTP surface it answers ITSELF

Everything else is forwarded.

| Path | Answer |
|---|---|
| `GET /api/health?gw=1` | `{success:true,status:'ok',version,svc:'gateway'}` |
| `GET /api/health?deep=1` | fans `health()` out to every bound service (2-s budget). Requires `x-health-probe` |
| `GET /api/health` | **forwarded to CORE unchanged** — workflow 7's probe must keep proving the core |
| `/api/d1/query`, `/api/d1/init`, `/api/make-all-investors`, `/api/upload` | 410 with `worker/index.ts:193-196`'s bodies, verbatim |

Every refusal it generates uses the platform envelope
`{success, error, code?, details?}` with today's wording: host → `404 {success:false,error:'Not found'}`;
unauthenticated → `401 … UNAUTHORIZED`; wrong role → `403 'Administrator access required'`;
limited → `429 'Too many requests, try again later' RATE_LIMITED`;
challenged → `403 TURNSTILE_REQUIRED` with `details.turnstile_sitekey`.

## 4. Headers it sets on a forward

| Header | Value |
|---|---|
| `x-correlation-id` | a fresh UUIDv7. A client's value is **ignored**, and echoed on the response |
| `x-levonis-host` | `<kind>;<slug>` — the classification, covered by the hop signature |
| `x-levonis-principal` | the Identity-signed principal, when one was resolved and verified |
| `x-levonis-hop` | the signed hop envelope, when `GATEWAY_SIGNING_KEY` exists |
| `Cookie` | forwarded **only** to `CORE` and `IDENTITY` |

On the way back: `Set-Cookie` survives only from `CORE`/`IDENTITY`; every
`x-levonis-*` the upstream set is stripped except `x-levonis-legacy-path: 1` on
a legacy alias; `Cache-Control: private, no-store` on anything carrying a
principal; `Server-Timing: gw;dur=…,svc;dur=…`.

## 5. Bindings and configuration

`services`: `CORE`, `IDENTITY` (the core's `IdentityEntrypoint` until Phase 9) —
and nothing else. The gateway's `calls` are pinned by
`tests/leastPrivilege.test.ts` to `resolveSession`, `revoke`, `getPublicKeys`,
`rateLimitHit` and the HTTP forward; no method containing `Admin`, `set`,
`credit`, `debit`, `decide` or `lookupContacts` may ever appear (ADR-015).
`ratelimits`: `RL_IP`, `RL_PUBLIC_READ` (per colo, no resource to provision).

| Var | Meaning |
|---|---|
| `GATEWAY_PHASE` | the strangler phase; a prefix flips when this reaches its `flipPhase` |
| `ROUTE_OVERRIDES` | `"<prefix>=<TARGET>,…"` — the kill switch; beats the phase |
| `GATEWAY_LOCKED` | `on` until G3: 403 to anything without the probe token |
| `PRINCIPAL_MODE` | `off` \| `shadow` \| `on` |
| `CACHE_MODE` | `on` \| `off` |
| `RATE_LIMIT_MODE` | `memory` for dark/local only; otherwise the authoritative D1 counter |
| `RATE_LIMIT_ENFORCE` | promotes a shadow class (`ip`, `public-read`) to enforcement |
| `TURNSTILE_SITEKEY`, `GATEWAY_SIGNING_PUBLIC_KEY`, `APP_ORIGIN`, `STORE_ROOT_DOMAIN`, `EXTRA_ALLOWED_ORIGINS`, `SVC_VERSION` | as named |

Secrets, by name only: `GATEWAY_SIGNING_KEY`, `TURNSTILE_SECRET`,
`HEALTH_PROBE_TOKEN` (`SECRETS.md`).

## 6. Degradation contract

Every dependency is optional and every absence has one defined behaviour:

| Absent | Behaviour |
|---|---|
| `IDENTITY` | anonymous; the cookie still reaches CORE, which resolves it as today |
| `GATEWAY_SIGNING_KEY` | no hop envelope (legal while every callee runs `GATEWAY_ONLY=off`) |
| `TURNSTILE_SECRET` | Turnstile is off: no route challenged, nothing fetched |
| the target's binding | falls back to `CORE` — a prefix whose owner is not deployed yet is not a 404 |
| `CORE` | `503 DEPENDENCY_UNAVAILABLE` |
| a rate limiter | `503 DEPENDENCY_UNAVAILABLE` — **never** a silent per-isolate fallback (ADR-016) |

## 7. Events

Consumes `SessionRevoked.v1` and `RoleChanged.v1` (cache eviction). Publishes
nothing yet: `RateLimitHit` and `TurnstileFailed` are best-effort telemetry
whose subscribers are Risk and Analytics, and binding a Worker that does not
exist would fail the deploy — Phase 2 adds the bindings and the emitter.
