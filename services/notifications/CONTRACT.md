# `levonis-notifications` — contract

The public methods of `NotificationsEntrypoint` (`src/index.ts`) **are** the API.
Nothing else about this Worker is callable: it has no zone route,
`workers_dev:false` and `preview_urls:false` in production, so a service binding
is the only door.

Status: **dark, and dual**. Nothing here is deployed, and nothing about the live
core changes: the monolith keeps `worker/lib/outbox.ts`,
`worker/lib/telegram.ts`, `worker/lib/notifications.ts`, its own `outbox`,
`user_notifications` and `telegram_updates` rows, and keeps sending from them
until Phase 3 (`02-MIGRATION-PLAN.md` 1.7). This service is a second, dark
implementation — `test/migrations.test.ts` fails if the core's copies disappear.

---

## 1. RPC

### `deliver(batch: EventEnvelope[], hop?: HopEnvelope): Promise<DeliverResult>`

The bus consumer. Envelope shape, producer allowlist, Ed25519 signature,
`piiMax` and payload schema are checked by the platform kit before any state is
touched; a failure is `invalid`/`forged`/`pii_refused` and is never retried.

`piiMax` is `personal`: unlike Ads, this service is allowed the personal
envelopes, because telling a person about their own money is what it is for.

| Event | Effect | Event key |
|---|---|---|
| `UserCreated.v1` | the verification mail, when `email_verified` is false | `user:<id>:verify` |
| `OrderCreated.v1` | the customer's in-app row, plus the admin Telegram message when the group is configured | `order:<id>:created`, `order:<id>:admin` |
| `DepositDecided.v1` | the customer's in-app row | `deposit:<id>:<decision>` |
| `RequestPublished.v1` | one in-app row per matched merchant | `request:<id>` |

Every key is derived from the EVENT, never from request input
(`tests/serviceBoundaries.test.ts` fails on the first one that is not).

`subscriptions.ts` lists `notifications` on more types — `OrderPaid`,
`PaymentCompleted`, `PaymentFailed`, `RefundCompleted`, `OrderStatusChanged`,
`OrderDelivered`, `ReferralUsed`, `SubscriptionChanged`, `DepositRequested`,
`WithdrawalStateChanged`. Their handlers land with the templates they need in
Phase 4; until then this service is not bound as their consumer.
`test/boundaries.test.ts` fails if one of them is neither handled nor named in
`OWNERSHIP.json`, so the gap cannot quietly become an omission.

**`UserCreated` carries no contact, deliberately** — `03-EVENTS.md` §1 forbids a
raw address in any envelope, and Identity owns the contacts. From Phase 4 the
recipient comes from `IDENTITY.contactFor` over a service binding. Until that
binding exists the resolver is absent and the handler writes a `skipped` outbox
row saying `NO_CONTACT_RESOLVER`, which is the core's own
"record the event honestly WITHOUT sending" behaviour. Nothing is invented and
nothing is lost.

### `send(cmd: SendCommand, ctx?: RpcCtx): Promise<{ queued, replayed }>`

`NotificationsApi.send` — what the core's `enqueue()` forwards to from Phase
4b-i, with the same `event_key` semantics it has today: **one delivery per key,
forever**. A replay answers `{ queued: false, replayed: true }`; nothing is
written and nothing is sent twice.

**Who may call it.** A service binding is account-level trust, and this method
addresses a real person with the platform's own mail key and bot token from a
caller-supplied `params.to` / `params.chat_id`. So it asserts the caller's
signed hop first (`src/guard.ts`, `01-TARGET.md` §4 item 3), against this
allowlist — deliberately NOT `*`, because sending is a privilege, not a duty:

| Method | Allowed callers |
|---|---|
| `NotificationsEntrypoint.send` | `core`, `identity`, `commerce`, `marketplace`, `subscriptions`, `ledger`, `admin` |

`deliver()` is not in the table: `defineConsumer` already checks the hop issuer
against the per-event producer allowlist, which is the stronger check. The mode
follows the platform's: `off` while `ALLOWED_CALLER_KIDS` is empty (nothing is
bound to call it), `on` as soon as any caller key is registered, with
`ENTRYPOINT_HOP` overriding both directions.

`channels: ['inapp']` writes a `user_notifications` row; `['email']` and
`['telegram']` write `notify_outbox` rows keyed `<event_key>:<channel>`.

### `health(): Promise<HealthReport>`

`{ ok, svc: 'notifications', ver, checks: { db, outbox_lag_s } }`. The lag is
the age of the oldest unsent row — the §11.4 golden signal for this service.
`null` means the outbox is empty, which is not the same as zero.

### `scheduled()` — cron `* * * * *`

The outbox pump. The core's cron runs every fifteen minutes, which is why a
verification mail can take a quarter of an hour today.

---

## 2. HTTP

Everything is behind `gatewayOnly()`; `GET /health` also answers a request
carrying `x-health-probe: <HEALTH_PROBE_TOKEN>`.

`gatewayOnly()` establishes WHERE a request came from, never WHO sent it, so
`GET/POST /api/notifications*` and `GET /api/v1/notifications/admin/*` verify
the Identity-signed principal **in this Worker**, against its own key ring
(`src/keys.ts`) — signature, `iat`/`exp`, issuer. Both fail closed: while no
key is registered every request is 401, which is the deployment state until the
gateway mints principals. The inbox binds its reader to a VERIFIED `sub` (never
a decoded one). The admin delivery history additionally requires
`role:'admin'`, full scope, and `host_kind:'main'` — admin surfaces are
apex-only. `test/auth.test.ts` pins all of it.

| Route | Response type in `@levonis/contracts` |
|---|---|
| `GET /api/notifications?limit=&before=&unread=1` | `NotificationListResponse` |
| `GET /api/notifications/unread-count` | `UnreadCountResponse` |
| `POST /api/notifications/read` | `MarkReadResponse` |
| `GET /api/v1/notifications/admin/deliveries?channel=&status=&limit=&cursor=` | `NotifyDeliveriesResponse` |
| `POST /api/telegram/webhook` | `TelegramWebhookResponse` |
| `GET /health` | `HealthReport` |

The public shapes are today's core responses field for field: the Phase 4 prefix
flip must be invisible to the SPA.

**Who the caller is** comes from the gateway's signed principal, forwarded in
`x-levonis-principal`. This service holds no cookie session and reads no
`sessions` table — Identity owns both. Until the gateway mints principals
(`PRINCIPAL_MODE=on`, Phase 3) these routes answer **401**: an inbox that cannot
identify its reader must return nothing, not everything. Marking read is scoped
to the owner IN SQL, so a guessed id belonging to someone else changes nothing.

### The webhook

`POST /api/telegram/webhook` is the one ingress that is unauthenticated from
Telegram's side. Three rules, all load-bearing:

1. **It answers 200 to every well-formed update.** Telegram retries anything
   else, forever, so an error status turns one bad update into a flood. A
   refusal is an accepted update that did nothing.
2. **Dedup is the primary key of `telegram_updates`**, as in the core. A replay
   is `{ ok: true, duplicate: true }`.
3. **The secret token is compared in constant time.** With
   `TELEGRAM_WEBHOOK_SECRET` unset the endpoint still answers 200 and accepts
   **nothing** — an unauthenticated ingress with no shared secret is an open
   door.

Routing is a **stub** in this slice, deliberately: a callback button on an
admin's phone becomes `LEDGER.decideDeposit`, a money command whose approval
nonce Ledger verifies itself and never trusts from Notifications
(`01-TARGET.md` §6.5). `classifyUpdate()` fixes the shape now so the router is
not invented later.

---

## 3. The transports

```ts
interface Transport {
  readonly channel: 'email' | 'telegram';
  configured(env): boolean;          // every secret NAME present
  readonly disabledReason: string;   // recorded on the dropped row
  send(message, env, { eventKey, … }): Promise<{ ok, error?, disabled?, retryable? }>;
}
```

Both are **moved, not rewritten**, from `worker/lib/outbox.ts` and the transport
part of `worker/lib/telegram.ts`. `test/transports.test.ts` reads
`worker/lib/outbox.ts` off disk and compares — restating the wire format in the
test would only prove the test agrees with itself.

Kept deliberately:

- **`Idempotency-Key: <event_key>`** on the Resend request, truncated to 256.
  Retries of the same business event reuse the key, so an ambiguous first
  attempt — a timeout after the provider accepted — cannot double-send.
- **`EMAIL_ALLOWED_RECIPIENTS`**, the staging guard: a recipient outside the
  allowlist is `skipped` with the reason recorded, never silently dropped and
  never sent. The address itself is never logged.
- **Plain text, no `parse_mode`, capped at 4000** on Telegram, so a
  user-supplied display name cannot inject markup.
- **OTP issuing, challenges and account linking stayed in the core.** They are
  Identity's, and copying them here would have moved an authentication surface
  into a Worker whose job is to deliver messages.

### The two "off" states

| State | Set by | Effect |
|---|---|---|
| delivery off | `NOTIFY_DELIVERY` is not the exact string `on` | rows are enqueued and recorded; the pump claims nothing and sends nothing |
| not configured | a transport's secret NAMES are absent | the transport is not called: the row is `dead` with its `disabledReason`, the delivery is `dropped`, no request is made |

Both fail closed. The first is what makes the hand-over from the monolith a
workflow run rather than a race: while the core is still the sender, two Workers
sending the same mail is the failure to avoid.

---

## 4. Idempotency

Three layers:

1. `notifications_processed_events(event_id)` — in the same batch as the side
   effect, so a redelivered envelope is `replayed` and writes nothing;
2. `notify_outbox.event_key` UNIQUE and `user_notifications (user_id,
   event_key)` UNIQUE — the tables themselves refuse a duplicate even when the
   processed-events row is gone;
3. the provider `Idempotency-Key` (Resend), and for Telegram the
   claim-then-send compare-and-swap on `attempts`, which only one processor can
   win.

`RequestPublished` is the case that shows why the second layer is a composite:
two merchants share one event key for the same request and must **both** be
told, while neither may be told twice.

## 5. Tables

Owned, in this service's **own** D1: `notify_outbox`, `user_notifications`,
`notify_deliveries`, `telegram_updates`, plus the platform tables
`notifications_processed_events` and `notifications_idempotency`.

`notify_outbox` is the legacy `outbox` shape **column for column**, so Phase 3
can copy the monolith's rows with an `INSERT SELECT` and no transform;
`test/migrations.test.ts` compares it against `migrations/0003_final_phase.sql`
read from the repository. `user_notifications` is the legacy table minus the
`REFERENCES users(id)` foreign key, which cannot exist in a database that does
not own `users` — the ordinary consequence of a service owning its store.

`tg_admin_notifications`, `tg_admin_actions` and `notification_preferences` are
this service's in the design too, but stay in the core until the wallet-approval
flow moves (Phase 6): claiming a table this service does not create would be a
claim `tests/ownership.test.ts` cannot check.

Read from another service: **none**. `test/boundaries.test.ts` proves the
runtime guard refuses a foreign statement — including a read of the core's own
`outbox`, which is a different table in a different database and not ours.

## Bindings (least privilege)

Every binding this Worker holds, in every environment, and nothing else —
`tests/boundariesBindings.test.ts` compares this list against
`wrangler.jsonc` in both directions, so a binding added to the config without a
line here fails `npm run check`.

| Binding | Kind | Why Notifications has it |
|---|---|---|
| `DB` | D1 | its own store, `levonis-notifications-db` (dark: `levonis-notifications-db-dark`) |

`IDENTITY.contactFor` (the recipient of a `UserCreated` mail) and
`LEDGER.decideDeposit` (what a Telegram approval button becomes) are Phase 4
and Phase 6 bindings. They are deliberately absent today, and the code says so
rather than pretending: with no `ContactResolver` the handler writes a `skipped`
row saying `NO_CONTACT_RESOLVER`, and the webhook records and acknowledges
without routing anything.
