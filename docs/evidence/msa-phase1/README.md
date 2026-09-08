# Phase 1 (dark) — what was actually run, and what it proved

Branch `claude/new-session-2hq4ci`, on top of `37bacd0`. Node 22.22.2,
wrangler 4.127.0, `@cloudflare/workerd-linux-64`.

**Nothing was deployed, created or probed on the Cloudflare account.** No
`wrangler deploy`, no `d1 create`, no `secret put`, no workflow run, no outbound
request to `api.cloudflare.com`. Every route, DNS record, secret and binding of
`levonis-staging` and `levonis-studio-staging` is exactly what it was; the
monolith keeps serving everything. Everything below ran inside `wrangler dev` —
real `workerd`, real service bindings, real local D1 files under
`.wrangler/dark` — and every process it started was killed by PID at the end.

## The gates

| Gate | Result |
|---|---|
| `npm run check` | **pass** — root, `worker/` and `tests/` typechecks; `eslint .` 0 errors (120 pre-existing warnings); `check:workspaces` (4 packages + 5 services + `services/probes`); `check:boundaries` 58 cases; `check:studio` |
| `npm run test:unit` | **pass** — 1915 root tests, 335 workspace tests across 46 workspace files, 0 failures |
| `npm run build` | **pass** — 86 chunks, entry 926.70 kB / 253.03 kB gzip, CSS 241.63 kB / 36.10 kB gzip, `dist/_headers` 9 rules |
| `node scripts/migrate-check.mjs --twice` | **pass** — 57 migration files, second full pass applies 0, `0057` re-run adds no row, 142 tables, 0 foreign-key violations |

## The dark stack, end to end

```bash
npm run build
node scripts/e2e-dark.mjs --all --fresh --port 8787     # 6 phases, 41 checks, 178 s
```

`e2e-dark.log` in this directory is that run, verbatim. Every phase is one
`scripts/dev-stack.mjs` (six Workers in one `wrangler dev`, one shared
`--persist-to`), started and killed by the script; the phases differ only in
which Worker is `--primary`, because `wrangler dev` serves the primary config on
the port and hands the auxiliary ones nothing but `--env` — so exactly one
Worker per run is reachable over HTTP, receives `--var` and answers
`--test-scheduled`.

| # | Phase | Primary | What it proved |
|---|---|---|---|
| 1 | gateway | `levonis-gateway-dark` | register → sign in → admin bootstrap → create the api-tests product → add 2 to cart → address → **order, server-computed total 25 000 IQD** (2 × 10 000 + 5 000 shipping — the number `scripts/api-tests.mjs` asserts), idempotent replay returns the same order, stock 3 → 1, cart emptied. `/api/health` forwarded to CORE **byte-identical** (`{"status":"ok"}`, no `svc` field). Set-Cookie survives the hop; `x-correlation-id` echoed; `x-levonis-principal` / `x-levonis-hop` / `x-levonis-challenge` never reach the client. The anonymous read cache HITs on a second identical read while the client copy stays `private, max-age=0` and a cookie-carrying request bypasses it. |
| 2 | core | `levonis-core-dark` | **13 read routes replayed against the core alone: byte-identical bodies, identical statuses**, and every header the core sets arrives unchanged through the gateway (CSP, HSTS, `x-frame-options`, `x-content-type-options`, `referrer-policy`, `permissions-policy`, content type, cache directives). Then the **cron**: `GET /cdn-cgi/local/scheduled` runs `worker/index.ts` `scheduled()` → `runDurableJobs` step 0 → the outbox pump. |
| 3 | audit | `levonis-audit-dark` | `/health` with a real `checks.db`; `/api/v1/audit/admin/events` **401 without a principal, 403 for a non-admin, 200 for a full admin** — through the service's own `verifyPrincipal` against a key ring built from `ALLOWED_CALLER_KIDS`; **the hash chain verifies, 5 links, head `4b3afdb4db62…`**. |
| 4 | analytics | `levonis-analytics-dark` | `/health` with a real `checks.db`; overview 401 without a principal; **the overview counts this run's events — 6 raw events → users 2, orders 1**; 8 daily points, read back from `analytics_daily_platform`: `add_to_cart` 1, `checkout_value_iqd` 25000, `checkouts_started` 1, `gmv_created_iqd` 25000, `inventory_moves` 1, `order_items` 1, `orders_created` 1, `users_created` 2 — the checkout's own 25 000 IQD, under both names the read model reports it by. |
| 5 | ads | `levonis-ads-dark` | **Sandbox: 5 adapters, 0 configured, every breaker closed**; the 8 deliveries this run produced are terminal (`no_consent` ×8), **0 sent, 0 dead letters**. |
| 6 | notifications | `levonis-notifications-dark` | `/health`; the inbox refuses a reader it cannot identify; **the order this run placed is in the customer's inbox** (1 row, unread 1, `order_update`); `notify_outbox` holds `skipped ×2` and **0 rows in state `sent`** — 0 transport attempts, so nothing could reach a real person. |

## The event path, as the databases recorded it

One checkout produced, in the core's own outbox:

```
AuditRecorded ×2   CheckoutStarted ×1   InventoryChanged ×1   OrderCreated ×1   UserCreated ×2
```

- **Inside the request** the `waitUntil` pump delivered 12 of 13 deliveries and
  acked all of them; nothing was dead.
- **Left for the cron** were exactly 2 events — one `AuditRecorded` (the audit
  facade's `pumpAfter` has no `waitUntil`, so whether its floating promise
  finishes is the runtime's choice, not a contract) and the `InventoryChanged`
  written inside the order batch and deliberately not pumped (slice 1.6, D5).
- **One cron tick** acked `audit ×1` and `analytics ×1`, and both stores grew:
  audit 4 → 5 entries, analytics 5 → 6 events.
- **A second tick delivered nothing twice**: both counts unchanged, 0 deliveries
  left pending, and `audit_events` rows = distinct `event_id`s.

`AddToCart` and `CheckoutStarted` reached Ads as `best_effort` — fired at the
subscribers over RPC in `waitUntil` and never written to the outbox, which is
why Ads has 8 delivery rows and the outbox has no `AddToCart`.

Analytics stored no raw identifier: neither address this run registered appears
in `analytics_events.payload`, and no `actor_hash` contains an `@`.

## Two things this run changed, and why

- **`services/{audit,analytics}` `/health`** answered `{success, status,
  version, svc}` and never touched D1, while `services/{ads,notifications}`
  answered §11.3's `{ok, svc, ver, checks}` with a real `SELECT 1`. Two parallel
  slices, two shapes, and `scripts/probe-health.mjs` reads `checks.db` — so for
  half the dark twins the plan-2.1 gate could not tell a Worker with no tables
  from a healthy one. The two now return **both**: the legacy fields are still
  there and the report is added on top.
- **The gateway's anonymous read cache is real, and it is the one reason a
  public read can be stale.** `/api/products` and `/api/products/:slug` are on
  the allowlist with a 60 s TTL, so a read taken straight after an admin write
  answers the pre-write body. The end-to-end run says so explicitly (the cache
  check) and asks its parity questions on cache-busting URLs, so "parity" means
  the gateway and the core computed the same answer rather than that a stored
  copy matched itself.

## What this run did NOT prove

- **The dark deploy.** `levonis-{gateway,core,audit,analytics,ads,notifications}-dark`
  are files. Creating the Workers and their D1 databases changes the Cloudflare
  account and is the owner's G1/G2.
- **The dark zone.** `caches.default` and merchant hosts are inert without a
  real zone (D21), so `cf-cache-status: HIT` here is the local runtime's, and
  `scripts/e2e-subdomains.mjs` and `scripts/gateway-parity.mjs` (the ≥300-request
  corpus, slice 1.5) still need the zone.
- **A real signing key.** `EVENT_BUS` envelopes in this run carry the `fixture`
  marker, accepted only because every dark consumer sets `ACCEPT_FIXTURE_SIG=on`;
  `CORE_SIGNING_KEY` is a secret a workflow uploads. The **principals** in
  phases 3 and 4 are different: a real per-run Ed25519 pair, handed to the
  consumer as `ALLOWED_CALLER_KIDS` and verified by the same `verifyPrincipal`
  the services run in production (`tests/e2eSigning.test.ts` pins the signer).
