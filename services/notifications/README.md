# `levonis-notifications`

The durable outbox, the in-app notification store, and the two transports
(Resend email, Telegram bot) taken out of the monolith as adapters.

- **What it is and how to call it:** `CONTRACT.md`.
- **Which secret NAMES it needs, and what happens without them:** `SECRETS.md`.
- **What it owns:** `OWNERSHIP.json` — four tables in its own D1, and it reads
  no other service's.
- **Run it locally together with `levonis-ads`, over real service bindings, with
  no Cloudflare account:** `../ads/dev/README.md`.

Status: **dark, and dual**. Nothing here is deployed and nothing about the live
core changes. The monolith keeps `worker/lib/outbox.ts`,
`worker/lib/telegram.ts`, `worker/lib/notifications.ts` and its own rows, and
keeps sending from them until Phase 3 — `test/migrations.test.ts` fails if those
files disappear.

## The two things to know

1. **`notify_outbox` is the legacy `outbox` shape, column for column**, so the
   monolith's rows can be copied in Phase 3 with an `INSERT SELECT` and no
   transform. The test compares it against `migrations/0003_final_phase.sql`
   read from the repository, so the day someone alters the core's table this
   suite says so.
2. **A transport whose secret NAMES are absent is not called at all.** The row
   is recorded `dropped` with `EMAIL_NOT_CONFIGURED` / `TELEGRAM_NOT_CONFIGURED`
   — the core's own honest behaviour, kept rather than replaced. On top of it,
   `NOTIFY_DELIVERY` must be the exact string `on` before the pump claims
   anything: while the core is still the sender, two Workers sending the same
   mail is the failure to avoid.

## Tests

```bash
npx tsx --test services/notifications/test/*.test.ts
npx tsc --noEmit -p services/notifications/tsconfig.json
```

## What a deploy workflow must do

`svc-notifications.yml` belongs to the deploy-tooling slice (1.9). What it needs
from here:

| | |
|---|---|
| config | `services/notifications/wrangler.jsonc`, `--env dark` for the dark Worker |
| Worker names | `levonis-notifications-dark` / `levonis-notifications` |
| D1 to create by name | `levonis-notifications-db-dark` / `levonis-notifications-db` |
| migrations | `services/notifications/migrations/`, applied **before** the code |
| secret NAMES to upload | exactly the list in `SECRETS.md`, from `NOTIFICATIONS__<NAME>` |
| health | `GET /health` on the dark URL; `checks.outbox_lag_s` is the golden signal |
| vars | `NOTIFY_DELIVERY` ships `off` in production; the dark stack must keep `EMAIL_ALLOWED_RECIPIENTS` set so a dark run cannot mail a real customer |
