# Working on Levonis

## Branch, push and deploy (owner's instruction, 2026-10-07)

- Work directly on the default branch `claude/new-session-2hq4ci`. Every change
  is committed there and pushed with `git push origin claude/new-session-2hq4ci`.
  No feature branches, no merges, no pull requests. Never force-push it.

## EVERY PUSH TO THAT BRANCH IS A LIVE DEPLOY

The live Worker (`levonis-staging`, serving levonis-iq.com) has two deployers
(`docs/WORKERS.md`):

- **Cloudflare Workers Builds** deploys every push to the default branch, at
  once, **without running tests and without applying migrations**.
- Workflow «7 - Deploy LIVE main site levonis-staging»
  (`.github/workflows/deploy-staging-code.yml`, input `confirm: DEPLOY-CODE`)
  runs the checks and tests, records a Time Travel bookmark, applies pending
  migrations, then deploys.

So, before every push:

1. Run `npm run check` and `npm run test:unit` and push only when both are
   green. A push is not a draft.
2. Code that needs a new migration must not reach the branch before the
   migration is applied. Push the migration alone first («51 - Auto-apply
   migrations on push» applies `migrations/**` on push), wait for it to
   succeed, then push the code. Every new read of a new table or column also
   tolerates its absence, because the Worker can still go live ahead of its
   migration.
3. Large or risky changes still go through workflow 7 with the owner's
   approval.

## Languages

Every user-facing string exists in Arabic, English and Sorani Kurdish (`ckb`).
A `ckb` slot never carries a copy of the Arabic (`docs/DECISIONS.md` row 183).
