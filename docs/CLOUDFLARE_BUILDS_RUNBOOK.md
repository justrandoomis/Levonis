# Deploying from Cloudflare instead of GitHub Actions

**«انقل عملية الـ build والـ deploy من GitHub Actions إلى Cloudflare قدر الإمكان،
بحيث لا يتم استهلاك دقائق GitHub Actions للنشر.»**

This page is the answer to that, and the first thing it has to say is that the
move is mostly **already done** — and was done before the question was asked.

---

## 1. What is already true

**Cloudflare Workers Builds is already the only thing that deploys this site
automatically.** Every GitHub workflow that deploys a Worker is
`workflow_dispatch` only:

| Workflow | Trigger |
|---|---|
| `deploy-staging-code.yml` (7) | `workflow_dispatch` + a typed `DEPLOY-CODE` confirmation |
| `deploy-staging.yml` | `workflow_dispatch` |
| `deploy-production.yml` | `workflow_dispatch` |
| `deploy-studio-*.yml` | `workflow_dispatch` |
| `svc-*.yml` | `workflow_dispatch` |

A `workflow_dispatch` workflow consumes **zero** Actions minutes until a human
presses the button. So the recurring cost was never the existence of these
files — it was pressing 7, which spends ~33 minutes, of which ~31 are a
typecheck-and-test gate that also ran locally before the push.

`scripts/prepare-deploy-config.mjs` already makes a bare `wrangler deploy`
correct inside a Workers Builds container: it folds the chosen environment onto
the top level, resolves the D1 `database_id` **by database name** through
`wrangler d1 list` (no GitHub secret), and merges the plain-text vars.

---

## 2. The one gap that matters: migrations

> **The Cloudflare path applies no migrations.** Nothing in `npm run build` or
> `wrangler deploy` touches the D1 schema. Every `d1 migrations apply` in this
> repository lives inside GitHub Actions.

This is not theoretical. `docs/WORKERS.md` records the date: on **2026-09-17** a
Git-integration push put a Worker carrying migration 0085 onto a database still
at 0083, `/api/home` answered `SERVICE_SETUP`, and the storefront's first screen
went dark. `worker/lib/schemaVersion.ts` exists because of that night.

### Fix it in the dashboard — this is the single most important step

**Workers & Pages → the `levonis-staging` project → Settings → Builds**

```
Build command:   npm run build
Deploy command:  npx wrangler d1 migrations apply levonis-db-staging --remote && npx wrangler deploy
```

Two details in that deploy command, each of which is an outage if you get it
wrong:

1. **`levonis-db-staging`, not `levonis-db`.** `levonis-db` is the *production*
   database name. The live site is the Worker `levonis-staging` bound to
   `levonis-db-staging`; a Worker named `levonis` does not exist on the account.
   Naming `levonis-db` migrates a database nothing serves, **reports success**,
   and lets the deploy beside it ship new code onto an unmigrated live database.
2. **No `--env staging`.** The build folds staging onto the top level, so the
   bare command reads the block it just resolved.

The command is idempotent: on a commit that adds no migration it is a no-op, so
it is safe to leave on permanently.

> ⚠️ **Verify this once before relying on it.** `wrangler d1 list` demonstrably
> works in the build container, which proves a D1 **read**. `migrations apply
> --remote` needs D1 **edit**, and nothing in this repository proves the
> injected credential carries it. Test it on a commit that adds no migration:
> the failure mode is a red build with an authorization error, not a damaged
> database.

---

## 3. Build variables to set

| Name | Value | Why |
|---|---|---|
| `LEVONIS_CI_ENV` | `staging` | Makes the environment choice explicit instead of resting on a default. |
| `STUDIO_ALLOWED_DESTINATIONS` | current value | Now readable by the build (it was silently discarded before). |
| *(Node version)* | from `.nvmrc` | `22.22.2`. `write-asset-headers.mjs` imports a `.ts` file under bare `node`, which needs ≥ 22.18. |

**Do NOT set `CLOUDFLARE_ENV`.** Wrangler reads it as `--env`, which changes
which block `wrangler deploy` itself reads. Use `LEVONIS_CI_ENV`.

`VITE_GOOGLE_CLIENT_ID` is **no longer needed for the bundle** — the client id
comes from `/api/auth/capabilities` at runtime. Set it only if you want it
carried into the Worker's `GOOGLE_CLIENT_ID` var.

### Optional, and it upgrades a comment into a real guard

Setting `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` as build **secrets**
(read scope is enough) makes `scripts/lib/preserve-vars.mjs` actually run.
Today it returns `null` on **every** Workers Builds build, so the protection
against blanking a live Worker's variables rests entirely on `keep_vars: true`
plus the rule that `wrangler.jsonc` never declares a var it cannot fill.

> Never re-introduce a `"NAME": ""` into any `vars` block. `keep_vars` does not
> protect a var that is *given* as empty — it is deployed, and it clears the
> live value. That is the other half of the 2026-09-18 outage, and
> `tests/deployVarsSurvive.test.ts` is what holds the line.

---

## 4. What stays in GitHub Actions, and why

**Nothing here should be deleted.** All of it is `workflow_dispatch`, so all of
it costs zero minutes until run.

| Kept | Why it cannot move |
|---|---|
| `deploy-staging-code.yml` (7) | **The only thing that can write a Worker secret.** The build container has no `CLOUDFLARE_API_TOKEN`, so rotating a leaked `EMAIL_API_KEY` or `WASENDER_API_KEY` has no other path. It is also the documented rollback. |
| `auto-migrate-on-push.yml` | Carries safety the deploy command does not: a throwaway-database proof, a **D1 Time Travel restore bookmark**, and a row-count + `foreign_key_check` afterwards. Delete it only *after* the migrate step above is proven. |
| `telegram-*-webhook.yml` | Re-registers a bot webhook after a Telegram-side reset. No Cloudflare equivalent. |
| `verify-*.yml` | Read-only live verification, run on demand. |
| `deploy-studio-*.yml` | `studio/` has **no** Workers Builds support — no `WORKERS_CI` branch, and `studio/wrangler.jsonc` still commits a placeholder id. Moving it is separate work, not a toggle. |
| `svc-*.yml` | One Workers Builds connection deploys **one** Worker. The six service Workers would each need their own. |

### Deleting a workflow breaks `npm run check`

`tests/workflowNaming.test.ts` holds a hardcoded list of six deploy workflows
and reads each file; `tests/migrationsAdditive.test.ts` reads two of them. Both
are in `check:boundaries`. Remove a file without removing its row and the gate
fails.

`scripts/check-live-markers.mjs` — the **last step of `npm run build`** — opens
`.github/workflows/verify-live-product-template.yml` and exits 1 if it is gone.
Deleting that verification workflow breaks every Cloudflare build.

---

## 5. Where the tests run now

`npm run build` does **not** run `npm run check` or `npm run test:unit`. So a
push that fails CI still reaches the live Worker about 60 seconds later.

That is a real trade and it is yours to make:

- **Leave it as is** — fastest deploys; the gate is whatever ran before the push.
- **Add the gate to the build command** —
  `npm ci && npm run check && npm run test:unit && npm run build`.
  Note `npm run check` includes `check:studio`, which *fails* rather than skips
  when `studio/` is not installed, so the command must install that workspace
  too. This roughly triples build time.
- **Run the gate on pull requests instead**, and keep the deploy build thin.

---

## 6. Summary

| | Runs on |
|---|---|
| Build the SPA + Worker, resolve config, deploy | **Cloudflare Workers Builds** (already) |
| Apply D1 migrations | **Cloudflare**, once §2's deploy command is set |
| Write/rotate a Worker secret | GitHub Actions (workflow 7) — no alternative exists |
| Migration safety net (Time Travel bookmark, FK check) | GitHub Actions |
| Telegram webhook registration | GitHub Actions |
| Live read-only verification | GitHub Actions, on demand |
| Studio Worker, service Workers | GitHub Actions — each needs its own connection to move |
