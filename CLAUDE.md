# Working on Levonis

## Branch, push and deploy (owner's instruction, 2026-10-07)

- Work directly on the default branch `claude/new-session-2hq4ci`. Every change
  is committed there and pushed with `git push origin claude/new-session-2hq4ci`.
  No feature branches, no merges, no pull requests. Never force-push it.

## EVERY PUSH TO THAT BRANCH IS A LIVE DEPLOY — THROUGH WORKFLOW 7 ONLY

Owner decision (`docs/DECISIONS.md` row 184): the live Worker
(`levonis-staging`, serving levonis-iq.com) is deployed only by workflow
«7 - Deploy LIVE main site levonis-staging»
(`.github/workflows/deploy-staging-code.yml`). It runs on every push to the
default branch (prose-only pushes under `docs/` or `*.md` are skipped), in
this order, and stops at the first red step:

    npm run check + npm run test:unit
    → migrations proven on a throwaway database (migrate-check --twice)
    → Time Travel restore point
    → pending migrations applied to the live database
    → deploy (existing vars carried forward)
    → live probes

Cloudflare Workers Builds (the dashboard Git integration) is switched off from
the repository: its build refuses in `scripts/prepare-deploy-config.mjs`, so
its deploy command never runs. Workflow 51 is manual only.

So, before every push:

1. Run `npm run check` and `npm run test:unit` locally and push only when
   both are green. A red push is caught by workflow 7 and never deployed, but
   it blocks every push behind it until fixed.
2. A migration and the code that needs it may ship in the same push —
   workflow 7 applies the migration before it deploys. Every new read of a
   new table or column still tolerates its absence (a manual redeploy of an
   older commit, or Workers Builds re-opened in an emergency, can run code
   against an older database).
3. After a push, follow workflow 7 to green and check the live site.

## Languages

Every user-facing string exists in Arabic, English and Sorani Kurdish (`ckb`).
A `ckb` slot never carries a copy of the Arabic (`docs/DECISIONS.md` row 183).
