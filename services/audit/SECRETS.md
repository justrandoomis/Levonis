# Secrets — `levonis-audit`

Names only. No value is ever written here, in `wrangler.jsonc`, in a workflow
file or in a log line; the deploy workflow uploads them from repository secrets
(`02-MIGRATION-PLAN.md` §13.2) and `wrangler secret put` is run by the owner or
by that workflow, never by a developer's shell.

- `AUDIT_CHAIN_KEY` — keys the chain hash (HMAC-SHA256 over each entry's
  canonical core plus its predecessor's hash). Without it the chain falls back
  to a plain digest: still tamper-evident against an edit, but recomputable by
  anyone who can write the table, so the key is what makes a forged chain
  require the Worker's secret rather than just database access. The service
  runs and records with the key absent (dark, local) and says so in `health()`.
- `AUDIT_SIGNING_KEY` — this Worker's Ed25519 hop key (`<SVC>_SIGNING_KEY`,
  `01-TARGET.md` §4 item 3), used to sign the one outbound call Audit makes:
  `IDENTITY.getPublicKeys`. base64url PKCS#8; the public half is registered in
  `service_keys` / `ALLOWED_CALLER_KIDS`, never here.
- `HEALTH_PROBE_TOKEN` — the constant-time compared `x-health-probe` value. A
  production Worker with `workers_dev:false` has no URL, so the deep-health
  fan-out is the only way to reach it (`01-TARGET.md` §11.3).

Not secrets, and therefore declared as vars in `wrangler.jsonc` instead: the
caller allowlist, the fixture-signature switch, the gateway-only mode and the
service version.
