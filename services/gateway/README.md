# `@levonis/svc-gateway`

The API gateway (`docs/architecture/01-TARGET.md` §3, plan slice 1.5). Dark:
nothing in this directory is deployed, and the live Workers keep serving every
request. `CONTRACT.md` is the interface; this file is the map.

## Modules

| File | What lives there |
|---|---|
| `src/index.ts` | the `WorkerEntrypoint`: `fetch`, `health()`, `deliver()`, the Cache API adapter, the per-isolate state |
| `src/app.ts` | the Hono app — `securityHeaders()`, `originCheck()`, host classification, then the pipeline. Separated from `index.ts` so tests drive the real stack without a Workers runtime |
| `src/pipeline.ts` | the thirteen steps of §3.2, in order |
| `src/routes.ts` | the routing table: prefix → hosts, owner, flip phase, requirement, rate class, cacheability. Plus the phase resolver and the `ROUTE_OVERRIDES` kill switch |
| `src/capabilities.ts` | the host + role + financial-scope guard and today's refusal bodies |
| `src/principal.ts` | cookie → `sha256` → `IDENTITY.resolveSession` → **verify** → forward; the `(sid_hash, host_kind)` cache and Identity's key ring |
| `src/limiter.ts` | the class table, the layer choice, and the parity floor |
| `src/cache.ts` | the anonymous-GET allowlist, the key, and every reason not to cache |
| `src/validation.ts` | method allowlist, traversal, framing, content type, size |
| `src/uploadClasses.ts` | the size classes, each naming the call site it was read from |
| `src/turnstile.ts` | the hook, off until the secret exists |
| `src/identity.ts` | the only place the gateway talks to Identity — four methods, one decision about signing |
| `src/env.ts` | bindings and vars; every binding optional, every absence defined |

## Tests (`npm run test:unit` runs them through `scripts/test-workspaces.mjs`)

| Suite | What it holds |
|---|---|
| `test/routing.test.ts` | every `app.route(...)` in `worker/index.ts` resolves to exactly one row, with the owner the design records; at phase 1 every one of them is still CORE |
| `test/capabilities.test.ts` | every admin path DISCOVERED in the core is apex-only and admin-gated; the money surfaces need a non-assistant admin; the refusal bodies are today's |
| `test/pipeline.test.ts` | the whole stack through the real app: header hygiene, cookie scoping, security-header parity, the 410s, the lock, validation, the hop envelope, degradation |
| `test/principal.test.ts` | signature verification, expiry, host-kind mismatch, the cache keying and the classes that never use it |
| `test/cache.test.ts` | every refusal reason, the key, and `s-maxage` never reaching a client |
| `test/validation.test.ts` | the request rules and the Turnstile hook as pure functions |
| `test/uploadClasses.test.ts` | every size class still matches the constant in `worker/routes` it was read from |
| `test/rateLimitParity.test.ts` | no gateway class is tighter than the core's bucket over the same prefix |
| `dev/probe.mjs` | the same behaviours against real workerd over a real service binding (`dev/README.md`) |

The suites read `worker/` as TEXT rather than importing it: a service must not
make the core a build input of its own tests, and
`tests/serviceBoundaries.test.ts` is what says so.
