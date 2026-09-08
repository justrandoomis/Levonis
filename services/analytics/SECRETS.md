# Secrets — `levonis-analytics`

Names only. No value is ever written here, in `wrangler.jsonc`, in a workflow
file or in a log line; the deploy workflow uploads them from repository secrets
(`02-MIGRATION-PLAN.md` §13.2).

- `ANALYTICS_HASH_SALT` — folded into the per-day actor hash together with the
  day itself (`03-EVENTS.md` §5 rule 3: actor ids are hashed with a daily salt).
  Without it the hash is a digest of the day and the user id alone, which anyone
  holding both this table and a list of user ids could re-derive; with it, the
  pseudonyms are pseudonyms. Rotating it changes future hashes only — past days
  keep the salt they were written with, and a rollup counts events, never
  distinct actors, so a rotation breaks no number.
- `ANALYTICS_SIGNING_KEY` — this Worker's Ed25519 hop key
  (`<SVC>_SIGNING_KEY`, `01-TARGET.md` §4 item 3), used to sign the one outbound
  call Analytics makes: `IDENTITY.getPublicKeys`. base64url PKCS#8; the public
  half is registered in `service_keys`, never here.
- `HEALTH_PROBE_TOKEN` — the constant-time compared `x-health-probe` value; a
  production Worker with no URL is reachable only through the deep-health
  fan-out (`01-TARGET.md` §11.3).

Not secrets, and therefore vars in `wrangler.jsonc`: the caller allowlist, the
fixture-signature switch, the gateway-only mode, the retention window, the
rollup window and the service version.
