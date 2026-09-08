# levonis-gateway — secrets

Names only. Values live in Cloudflare (`wrangler secret put`, uploaded by the
deploy workflow from a repository secret of the same name) and are never
written down here, in a var, in a log line or in a test fixture.

| Name | What it is | Absent means |
|---|---|---|
| `GATEWAY_SIGNING_KEY` | The gateway's Ed25519 private key (base64url PKCS#8) for the per-hop envelope it signs on every forward (`01-TARGET.md` §4 item 3). The public half is registered in `service_keys` / `ALLOWED_CALLER_KIDS` as `gateway:<kid>:<publicKey>`. | No hop envelope is attached. Legal while every callee runs `GATEWAY_ONLY=off` (Phase 1–3); the moment a callee is `on` it answers `403 NOT_VIA_GATEWAY`, so the key is uploaded before that flip, never after. |
| `TURNSTILE_SECRET` | The Turnstile server secret for `siteverify` (`01-TARGET.md` §3.8). | Turnstile is **off**: no route is challenged, no token is read, `/api/auth/capabilities` advertises no sitekey. This is the state today. |
| `HEALTH_PROBE_TOKEN` | Compared in constant time against `x-health-probe` so `probe-health.mjs` can reach `?deep=1` and can pass `GATEWAY_LOCKED` before G3 (`01-TARGET.md` §3.1, §11.3). | Deep health is available to an `admin:full` principal on the apex only, and a locked gateway has no probe door. |

`GATEWAY_SIGNING_KEY` is the only key material the gateway holds. It carries no
money, email, Telegram, KYC or courier secret — by design (`01-TARGET.md` §4
item 5), and `tests/leastPrivilege.test.ts` fails if this table and
`OWNERSHIP.json` `secrets` ever disagree.
