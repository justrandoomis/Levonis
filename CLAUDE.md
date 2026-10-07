# Working on Levonis

## Branch, push and deploy (owner's instruction, 2026-10-07)

- Work directly on the default branch `claude/new-session-2hq4ci`. Every change
  is committed there and pushed with `git push origin claude/new-session-2hq4ci`.
  No feature branches, no merges, no pull requests. Never force-push it.
- Deploying the live site is a separate step, only with the owner's approval:
  workflow «7 - Deploy LIVE main site levonis-staging»
  (`.github/workflows/deploy-staging-code.yml`) on this branch, input
  `confirm: DEPLOY-CODE`. It runs the full checks and tests, records a Time
  Travel bookmark, applies pending migrations, then deploys.
- A push that touches `migrations/**` also starts «51 - Auto-apply migrations on
  push». Both workflows share the `staging-deploy` concurrency group, so they
  run one after the other.

## Languages

Every user-facing string exists in Arabic, English and Sorani Kurdish (`ckb`).
A `ckb` slot never carries a copy of the Arabic (`docs/DECISIONS.md` row 183).
