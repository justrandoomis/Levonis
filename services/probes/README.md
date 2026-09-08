# `services/probes` — throwaway Workers that answer one platform question each

`docs/architecture/04-DECISIONS.md` **ADR-017** is the reason this directory
exists: developers.cloudflare.com is unreachable from the build environment,
and `node_modules/wrangler/config-schema.json` plus
`node_modules/@cloudflare/workers-types` say nothing about account limits,
route-vs-Custom-Domain precedence, cron-trigger counts, self-binding RPC,
`_headers` through `ASSETS.fetch`, or Workflow concurrency accounting. Those are
facts the plan depends on, so they are **measured**, not assumed.

One tiny Worker per question — thirteen of them for eleven questions, because
rows (f) and (k) each ask about a BOUNDARY and one number on one side of it
means nothing. Each answers `GET /` with a JSON verdict and a
one-line `verdict` string; `svc-probes.yml` deploys them, collects the lines
into the run's job summary, and the answers are copied into ADR-017's table.

## Nothing here is deployed by the slice that wrote it

Deploying anything creates a Worker on the Cloudflare account, which is an
owner-gated action (G1). The workflow exists so the owner can run it in one
step; no developer and no automated round may run it.

## The Workers

| Dir | ADR-017 row | Question it answers | How the verdict is produced |
|---|---|---|---|
| `a-worker-name/` | (a) | can the CI token create a **new Worker name**? | the deploy either succeeds or fails with a permission error — the probe body is irrelevant, the deploy IS the answer |
| `b-plan-and-cron/` | (b) | Workers Paid, and what a per-minute cron costs | `scripts/assert-paid-plan.mjs` runs first; the Worker carries `* * * * *` and counts its own scheduled invocations in memory, so a tail over ten minutes shows the real cadence |
| `c-self-binding/` | (c) | can a Worker bind to **its own** named entrypoint? | the config binds `SELF` to this very Worker with `entrypoint: "ProbeEntrypoint"`; `GET /` calls `env.SELF.ping()` |
| `d-assets-binding/` | (d) | does `ASSETS.fetch` honour `_headers`, ETag/304 and SPA fallback? | it fetches its own three fixtures through the binding and reports the headers, the 304 and what an unknown path returns |
| `e-budgets/` | (e) | subrequest and D1-statement budget of one invocation | it makes subrequests to itself and (when a database is bound) runs `SELECT 1` in a loop until the runtime refuses, and reports the number that failed |
| `f-route-precedence/` | (f) | does a `<host>/api/*` **zone route** win over a **Custom Domain** on the same hostname, and `*.<root>/api/*` over `*.<root>/*`? | two Workers that answer with their own name. The owner attaches the Custom Domain to one and the zone route to the other **on the dark zone**, and the workflow curls the hostname: whichever name comes back is the answer |
| `g-cache-api/` | (g) | `caches.default` behaviour on a zone route | it caches a response with a marker, re-reads it, and reports `cf-cache-status`, `Age` and whether the second read was the cached body |
| `h-workflow-sleep/` | (h) | `sleepUntil` ceilings; do sleeping instances count toward concurrency? | **optional** — deployed only with the `include_optional` input, because it declares a Workflow binding |
| `i-do-sqlite/` | (i) | does `wrangler deploy` create a **SQLite Durable Object class** with the current token? | the config declares `migrations[].new_sqlite_classes`; the deploy either creates the class or fails, and `GET /` then writes and reads one row through it |
| `j-analytics-engine/` | (j) | is an Analytics Engine dataset created on the first `writeDataPoint`? | it writes one data point and reports whether the call threw |
| `k-pbkdf2-cpu/` | (k) | PBKDF2 CPU time when the core runs **under a service binding** | the probe hashes with the core's parameters; `caller/` calls it over a binding, so the number is measured on the far side of the hop, which is where the plan's risk is |

## Running them (owner only)

```
Actions → "20 - Platform probes (DARK throwaway Workers — serve no domain)"
  confirm:        DEPLOY-PROBES
  paid_plan:      the Workers Paid plan is confirmed in the dashboard
  dark_root:      the dark zone's root domain (D21), for rows (f) and (g)
```

Row (f) needs one manual step in the dashboard before the run, and the workflow
prints it: attach a **Custom Domain** `probe.<darkroot>` to
`levonis-probe-domain` and add the **zone route** `probe.<darkroot>/api/*` to
`levonis-probe-route`, then also add `*.<darkroot>/*` → `levonis-probe-domain`
and `*.<darkroot>/api/*` → `levonis-probe-route` for the wildcard half.

## Deleting them

```
Actions → the same workflow with  cleanup: DELETE-PROBES
```

which runs `wrangler delete --name levonis-probe-<x>` for every probe. ADR-017
says the results are recorded and the Workers deleted; leaving thirteen Workers
(one with a per-minute cron) on the account is not free.

## Why this directory is not a service

It has no `package.json`, no `OWNERSHIP.json` and no top-level
`wrangler.jsonc`, so `tests/serviceBoundaries.test.ts` and
`tests/leastPrivilege.test.ts` do not treat it as a service — it owns no data,
publishes no events and has no contract. `tests/workflowNaming.test.ts` does
check every config under it — the whole tree, not just the two configs the rule
was written for — for the two rules that apply to anything in this repository:
**no `routes`/`custom_domains`** (routing is a dashboard fact) and **no
`-staging` in a new Worker name** (on this account that suffix means live).
`services/probes/tsconfig.json` typechecks the sources, wired into
`npm run check` through `scripts/check-workspaces.mjs`.
