# levonis-notifications — secrets

Names only. No value appears in this repository, in a var, in a log line or in a
delivery row, and `_deploy-worker.yml` (slice 1.9) uploads only the names listed
here, from repository secrets `NOTIFICATIONS__<NAME>`.

**A transport is enabled only when every one of its names is present.** When one
is missing the transport is not called: the outbox row is recorded `dropped`
with the reason (`EMAIL_NOT_CONFIGURED` / `TELEGRAM_NOT_CONFIGURED`) and no
request is made. That is the behaviour `worker/lib/outbox.ts` already has, kept
verbatim rather than replaced — an honest "not configured" is worth more than a
row that claims to have been sent.

The same names exist on the core today. They stay there: the monolith keeps
sending until Phase 3, and nothing in this slice removes or rotates them.

## Email (Resend)

- `EMAIL_API_KEY` — bearer token for the send endpoint.
- The From address is the `EMAIL_FROM` **var**, not a secret. It is named here
  because a send without it is a disabled transport just the same.

## Telegram

- `TELEGRAM_BOT_TOKEN` — the bot token; the only credential that appears in a
  URL path, which is why nothing in this service ever logs a request URL.
- `TELEGRAM_ADMIN_CHAT_ID` — the admin group. Required for admin
  notifications and for nothing else: a customer message is never routed to it.
- `TELEGRAM_WEBHOOK_SECRET` — compared, in constant time, against the
  `X-Telegram-Bot-Api-Secret-Token` header of an inbound update. When it is
  unset the webhook still dedups and still answers 200, but accepts no update.

## Platform

- `NOTIFICATIONS_SIGNING_KEY` — base64url PKCS#8 Ed25519. This Worker's own key;
  it signs the hop envelope of any call it makes and, from Phase 2, its events.
- `HEALTH_PROBE_TOKEN` — constant-time compared by `GET /health?deep=1`.
