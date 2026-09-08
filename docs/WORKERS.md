# Which Worker serves whom

This is the single source of truth for what is deployed where. It exists
because the Worker names are historically inverted, and that inversion has now
cost three rounds of wasted work: a deploy that reported success while
changing nothing users could see, a "production" workflow that deploys a
Worker no domain points at, and a report that called the live database
unmigrated when the empty one was the one nothing points at.

Everything below was read from **Cloudflare's own configuration** — custom
domains, zone routes, and the live Worker's bindings — by
`12 - Audit Studio Migrations and Routing (read-only)`, runs `33380828524`
and `33382596554`. None of it is inferred from what a URL returns.

## The mapping

| Hostname | Worker | Status | Database | Bucket |
| --- | --- | --- | --- | --- |
| `levonis-iq.com` | **`levonis-staging`** | **LIVE** | `levonis-db-staging` | `levonis-files-staging` |
| `*.levonis-iq.com` (merchant subdomains) | **`levonis-staging`** | **LIVE** | same | same |
| `studio.levonis-iq.com` | **`levonis-studio-staging`** | **LIVE** | `levonis-studio-db-staging` | `levonis-studio-files-staging` |
| — none — | `levonis-studio` | alternate, workers.dev only | `levonis-studio-db` | `levonis-studio-files` |
| — none — | `levonis` | **does not exist on the account** | — | — |

The exact-host route `studio.levonis-iq.com/* -> levonis-studio-staging` wins
over the wildcard `*.levonis-iq.com/* -> levonis-staging`, and the Worker
custom domain names the same service, so both mechanisms agree.

**The `-staging` suffix is a historical name, not an environment.** These are
the production Workers. Nothing called "production" serves a user.

## The dark Workers (Phase 1) — every one of them serves no domain

`docs/architecture/02-MIGRATION-PLAN.md` Phase 1 is fully **dark**: it adds
Workers, and not one of them is reachable from `levonis-iq.com`. They exist so
the gateway, the event bus and the four leaf consumers can be driven end to end
before anything live changes.

| Worker | Serves | Database | Config | Deployed by |
| --- | --- | --- | --- | --- |
| `levonis-core-dark` | `<darkroot>/*` on the **dark zone** only (D21) | `levonis-db-dark` (empty) | `wrangler.jsonc` `env.dark` | `30 - Deploy DARK levonis-core-dark` |
| `levonis-gateway-dark` | `<darkroot>/api/*`, `<darkroot>/files/*`, `*.<darkroot>/api/*`, `*.<darkroot>/files/*` | — (the gateway executes no SQL) | `services/gateway/wrangler.jsonc` `env.dark` | `31 - Deploy DARK levonis-gateway-dark` |
| `levonis-audit-dark` | **nothing** — a service binding is its only door | `levonis-audit-db-dark` | `services/audit/wrangler.jsonc` `env.dark` | `32 - Deploy DARK levonis-audit-dark` |
| `levonis-analytics-dark` | **nothing** | `levonis-analytics-db-dark` | `services/analytics/wrangler.jsonc` `env.dark` | `33 - Deploy DARK levonis-analytics-dark` |
| `levonis-ads-dark` | **nothing** | `levonis-ads-db-dark` | `services/ads/wrangler.jsonc` `env.dark` | `34 - Deploy DARK levonis-ads-dark` |
| `levonis-notifications-dark` | **nothing** | `levonis-notifications-db-dark` | `services/notifications/wrangler.jsonc` `env.dark` | `35 - Deploy DARK levonis-notifications-dark` |
| `levonis-probe-*` | **nothing** (throwaway, deleted after ADR-017 is filled in) | — | `services/probes/*/wrangler.jsonc` | `29 - Platform probes` |

**A dark Worker has no route.** Not a zone route, not a Custom Domain, and —
for the dark core and the dark gateway — not even a workers.dev URL: they
declare `workers_dev: false` and `preview_urls: false`, and the **dark zone**
(a throwaway domain the owner provisions, D21) is the only way to reach them.
The four leaf consumers enable workers.dev deliberately and only because a
Worker with no URL cannot be health-probed before anything binds it; they hold
no live data.

Nothing in the repository declares those routes. As with the live Workers,
routing is a dashboard fact — and for the gateway that is the whole rollback
plan: the six `/api/*` and `/files/*` zone routes are ADDED at G3 and deleting
them is the undo, which only works while they are not in a config file.
`tests/workflowNaming.test.ts` fails on any `routes`, `route` or
`custom_domains` key in any wrangler config in the tree.

### The eventual production names

Every dark Worker has a production twin named without the suffix —
`levonis-gateway`, `levonis-audit`, `levonis-analytics`, `levonis-ads`,
`levonis-notifications` — declared at the top level of the same config and
**not deployed by any workflow in this repository yet**: that is Phase 2.1 and
Phase 3.1, each behind its own owner gate. The legacy core keeps its historical
name `levonis-staging` for ever (ADR-011); no new Worker may carry `-staging`,
and the tests fail on one that does.

## Which workflow to run

| To do this | Run | Deploys | Notes |
| --- | --- | --- | --- |
| Ship code to the live main site | **`7 - Deploy LIVE main site levonis-staging`** | `levonis-staging` | Reads the Worker's current vars back and carries them forward. Seeds no test data. **This is the normal path.** |
| Ship code to the live Studio | **`8 - Deploy LIVE Studio levonis-studio-staging`** | `levonis-studio-staging` | Same var-preserving behaviour. **This is the normal path.** |
| Rebuild the main site's resources from scratch and run the API suite | `2 - Rebuild levonis-staging + run API tests` | `levonis-staging` | **Writes test data to live data.** `levonis-db-staging` is the real customer database. Use deliberately. |
| Rebuild Studio's resources and reset its vars | `4 - Rebuild levonis-studio-staging` | `levonis-studio-staging` | **Replaces plain-text vars wholesale.** Running it with the origin secrets unset overwrites `APP_ORIGIN` on a working site with a workers.dev URL. |
| Deploy the alternate main Worker | `3 - Deploy levonis (ALTERNATE …)` | `levonis` | Serves no domain. The Worker does not currently exist. |
| Deploy the alternate Studio Worker | `5 - Deploy levonis-studio (ALTERNATE …)` | `levonis-studio` | Serves no domain. A green run here changes nothing users see. |
| Deploy one dark Worker | `30`–`35 - Deploy DARK levonis-<svc>-dark` | that Worker only | Thin wrappers around `_deploy-worker.yml`. Each asks for a confirmation phrase and for the Workers Paid confirmation, and creates a database only when told to. **Serves no domain.** |
| Deploy and prove the WHOLE dark stack from a branch | `36 - Verify DARK stack end to end` | the six dark Workers | Consumers, then the core that binds them, then the gateway in front of it; then it seeds the empty dark database and drives the event path through the gateway. **Touches nothing live.** |
| Answer the eleven platform questions of ADR-017 | `29 - Platform probes` | `levonis-probe-*` | Throwaway Workers, one per question; the verdicts land in the run's job summary and are pasted into ADR-017. Re-run with `DELETE-PROBES` to remove them. |

The confirmation phrases for 3 and 5 are `DEPLOY-ALTERNATE-MAIN-WORKER` and
`DEPLOY-ALTERNATE-STUDIO-WORKER`. They previously each contained the word
PRODUCTION; being asked to type it in order to deploy a Worker that serves
nothing is exactly the confusion this file exists to end.

## Read-only workflows

| Workflow | What it reads |
| --- | --- |
| `0 - Diagnose Live Site` | what the live hostnames answer with |
| `1 - Verify Cloudflare Setup` | token, D1, R2, integration config presence |
| `12 - Audit Studio Migrations and Routing` | both Studio databases, zone routes, custom domains, live Worker bindings |
| `14 - Verify Studio Live` | the Studio editor in a real browser on the live origin |
| `15 - Verify Live Auth` | SSO round trip, logout liveness, Resend delivery |

The first four write nothing at all. `15 - Verify Live Auth` is the one
exception and it is worth stating plainly: it registers **one throwaway
account** per run, on a plus-tagged address, because a password-reset email
and a verification email cannot be proved without an account to send them to.
It buys nothing, touches no wallet, no order and no ledger, and everything
else it does is a GET or a SELECT.

## Naming a Worker on the wrangler command line

Say the Worker **once**: either the name or the environment, never both.

```
wrangler tail --env staging            # correct — resolves env.staging.name
wrangler deployments list --name levonis-staging   # correct — no --env
wrangler tail levonis-staging --env staging        # WRONG
```

The last line asks Cloudflare for `levonis-staging-staging`, because under
legacy-env semantics wrangler appends the environment to any name it is given
(`src/utils/getLegacyScriptName.ts`: `args.name && args.env ? name-env : …`).
Cloudflare answers *"This Worker does not exist on your account. [code:
10007]"*.

The inverted names make this easy to write by accident: `levonis-staging`
already reads as "levonis, staging environment", so putting it next to `--env
staging` looks like agreement rather than duplication. It is duplication.

This cost a run: 33424449216 passed all 33 live checks and then failed only
because its `wrangler tail` had attached to nothing — the error went to the
stderr of a backgrounded process, so the run looked healthy until the gate.
`tests/workflowNaming.test.ts` now rejects the combination in any workflow.

## Routing is not managed from this repository

Neither `wrangler.jsonc` nor `studio/wrangler.jsonc` declares `routes` or
`custom_domains`. The bindings above were made in the Cloudflare dashboard and
are changed there. `10 - Merchant Subdomains` is the one workflow that can
write DNS and a zone route, and only when explicitly confirmed.
