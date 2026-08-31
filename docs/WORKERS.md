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

## Which workflow to run

| To do this | Run | Deploys | Notes |
| --- | --- | --- | --- |
| Ship code to the live main site | **`7 - Deploy LIVE main site levonis-staging`** | `levonis-staging` | Reads the Worker's current vars back and carries them forward. Seeds no test data. **This is the normal path.** |
| Ship code to the live Studio | **`8 - Deploy LIVE Studio levonis-studio-staging`** | `levonis-studio-staging` | Same var-preserving behaviour. **This is the normal path.** |
| Rebuild the main site's resources from scratch and run the API suite | `2 - Rebuild levonis-staging + run API tests` | `levonis-staging` | **Writes test data to live data.** `levonis-db-staging` is the real customer database. Use deliberately. |
| Rebuild Studio's resources and reset its vars | `4 - Rebuild levonis-studio-staging` | `levonis-studio-staging` | **Replaces plain-text vars wholesale.** Running it with the origin secrets unset overwrites `APP_ORIGIN` on a working site with a workers.dev URL. |
| Deploy the alternate main Worker | `3 - Deploy levonis (ALTERNATE …)` | `levonis` | Serves no domain. The Worker does not currently exist. |
| Deploy the alternate Studio Worker | `5 - Deploy levonis-studio (ALTERNATE …)` | `levonis-studio` | Serves no domain. A green run here changes nothing users see. |

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
