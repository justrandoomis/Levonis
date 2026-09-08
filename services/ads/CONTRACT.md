# `levonis-ads` — contract

The public methods of `AdsEntrypoint` (`src/index.ts`) **are** the API. Nothing
else about this Worker is callable: it has no zone route, `workers_dev:false`
and `preview_urls:false` in production, so a service binding is the only door.

Status: **dark**. Nothing in this directory is deployed, and creating
`levonis-ads-dark` and `levonis-ads-db-dark` is gated on the owner (G1).

---

## 1. RPC

### `deliver(batch: EventEnvelope[], hop?: HopEnvelope): Promise<DeliverResult>`

The bus consumer (`03-EVENTS.md` §2.3). At most 50 envelopes and 500 KB per
call. Before any state is touched the platform kit checks, in order: envelope
shape, that the type is one of the six below, that `source_service` (and the
hop `iss`) is an allowed producer, the Ed25519 signature, `pii_class ≤
pseudonymous`, and the payload schema. A failure at any of those is
`invalid`/`forged`/`pii_refused` and is **never retried**.

`piiMax` is `pseudonymous`, so a `personal` envelope — `DepositDecided`,
`KycDecided`, `RoleChanged`, every money movement — cannot reach this service
even if someone adds `ads` to its subscriber list by mistake.

| Event | Mapped to | Fires when |
|---|---|---|
| `UserUpdated.v1` | `CompleteRegistration` | `marketing_consent` reaches `ads` for the **first** time |
| `ProductViewed.v1` | `ViewContent` | always (anonymous views have no `viewer_hash` → `no_consent`) |
| `AddToCart.v1` | `AddToCart` | always |
| `CheckoutStarted.v1` | `InitiateCheckout` | always |
| `PurchaseCompleted.v1` | `Purchase` | always (produced on `OrderPaid`/`OrderDelivered`, never `OrderCreated`) |
| `SubscriptionChanged.v1` | `Subscribe` | `active === true` |

`UserCreated` is deliberately **not** here: no consent can exist at signup
(`03-EVENTS.md` §3.1).

Results: `acked` (the delivery rows were written), `replayed` (this
`event_id` was processed before). A provider outage does **not** make the event
retry — it becomes a `failed` delivery row with a backoff that the cron sweeps.
Holding a producer's outbox open on an advertising platform's outage is exactly
the coupling this service exists to avoid.

### `health(): Promise<HealthReport>`

`{ ok, svc: 'ads', ver, checks: { db } }`. In production the Worker has no URL,
so the probe arrives through the gateway's `GET /api/health?deep=1` fan-out
(`01-TARGET.md` §11.3).

### `scheduled()` — cron `* * * * *`

Retries every `failed` delivery whose `next_attempt_at` has passed; a row that
runs out of attempts (8) becomes `dead` and gets an `ads_dead_letters` row,
which is the DLQ the §11.4 alert watches (`> 0`).

---

## 2. HTTP

Everything is behind `gatewayOnly()`; `GET /health` also answers a request
carrying `x-health-probe: <HEALTH_PROBE_TOKEN>`.

`gatewayOnly()` establishes WHERE a request came from, never WHO sent it, so
every `/api/v1/ads/admin/*` route additionally requires an **Identity-signed
principal, verified in this Worker** (`src/keys.ts`, `src/http/admin.ts`):
`role:'admin'`, full scope, `host_kind:'main'`. It fails closed — while no
caller key is registered every admin request is 401 — which matters because
`POST /flags` enables and disables providers and event mappings and the dark
twin ships `workers_dev: true`. `test/auth.test.ts` pins it.

| Route | Response type in `@levonis/contracts` |
|---|---|
| `GET /health` | `HealthReport` |
| `GET /api/v1/ads/admin/providers` | `AdsProvidersResponse` |
| `GET /api/v1/ads/admin/event-map` | `AdsEventMapResponse` |
| `GET /api/v1/ads/admin/deliveries?provider=&status=&limit=&cursor=` | `AdsDeliveriesResponse` |
| `POST /api/v1/ads/admin/flags` | `AdsFlagResponse` |

No route here carries a contact, a user id or a payload field annotated `pii`.
A delivery row names an `event_id` and a provider — never a person.

---

## 3. The adapter interface

```ts
interface AdsProvider {
  readonly name: 'meta_capi' | 'google_ads' | 'tiktok' | 'snapchat' | 'noop';
  configured(env): boolean;                                  // every secret NAME present
  map(event, consent, providerEvent): ProviderEvent | null;  // providerEvent comes from ads_event_map
  send(events, env, opts): Promise<{ accepted; rejected; error?; retryable?; sandbox? }>;
}
```

`meta_capi` covers both Meta surfaces the design names: the **Conversions API**
is the send path and the **Marketing API** graph host
(`https://graph.facebook.com/<version>/<dataset_id>/events`) is what it posts
to, with one credential pair and one recorded exchange. A second adapter would
have differed from it only in a comment, and `AdsProviderName` in
`packages/contracts/src/http/ads.ts` — which `01-TARGET.md` §9.1 fixes — has no
room for one.

`noop` is the default and does nothing at all: it maps to `null` and sends
nothing. It is in the registry, never in `ads_event_map`.

### The four "off" states, which are not the same thing

| State | Set by | Effect |
|---|---|---|
| global off | `ADS_ENABLED` is not the exact string `on` | acks the event, writes **nothing** — fails closed |
| provider off | `ads_providers.enabled = 0` | that provider gets no delivery row; the rest still run |
| event off | `ads_event_map.enabled = 0` | that (event, provider) pairing produces nothing |
| not configured | a secret NAME is missing | the **SANDBOX** adapter runs: the mapping is validated, the row says `sandbox`, nothing leaves the account |

### `deliver()` never sends

A configured provider's delivery row is written `pending` with
`next_attempt_at = now`, the event is acked, and the per-minute `scheduled()`
makes every outbound call. The bus hands a consumer up to 50 envelopes per
`deliver()`, and each maps onto four seeded providers, so an inline send meant
up to 200 sequential HTTP calls (600 subrequests, ~30 s) inside one RPC — from
the CORE'S PUMP, whose lock lease is 55 s. The sweeper claims each row before
sending it, so overlapping minute ticks cannot send it twice, and stops at an
explicit send/wall-clock budget so a tick fits inside its minute.

The last one is the emergency switch of `01-TARGET.md` §9.1 — and it is the
strongest, because it removes the credential rather than a flag. There is no
code path from an unconfigured provider to a `fetch`: `ProviderRegistry.resolve`
hands back a `SandboxProvider`, whose `send()` returns without touching the
network. `test/delivery.test.ts` proves it with a `fetch` that throws.

### Consent

Ads never receives a raw contact. Identity — the owner of the contacts — hashes
the normalised email and E.164 phone in memory **on a consent change** and puts
the hashes on `UserUpdated`; Ads stores them in `ads_consent_snapshots` keyed by
`user_hash` and joins locally. On any consent value other than `ads` the
consumer writes NULLs, which **erases** a previously stored hash: a withdrawal
removes the identifier rather than flagging it. Without `ads` consent the
delivery is recorded `no_consent`, the payload column is `{}`, and nothing is
sent.

`src/consent.ts` holds the same normalisation and hashing functions so the rule
is executable and testable in one place, and so the local rig can build a
realistic snapshot without inventing a second definition.

**One assumption to confirm with Identity.** `SubscriptionChanged` carries only
`user_id` (a `pii` field), so Ads derives its join key as
`stableUserHash(user_id) = sha256(user_id)` and never stores the id.
`packages/contracts` does not yet fix that function. If Identity's stable
`user_hash` turns out to be something else, the consequence is a `no_consent`
delivery for `Subscribe` — never a leak — and the fix is one function.

### Re-verifying the recorded exchanges

`test/fixtures/<provider>.exchange.json` records the mapped payload, the request
the adapter puts on the wire (method, URL, header **names** — never a value —
and the full body) and the provider's response. The test replays it, so an
accidental change to what a platform is told about a customer fails a test.

What it does **not** prove is that the provider still accepts that shape. The
vendor documentation is not reachable from the build environment, so the
endpoint versions below were written from the adapters and reviewed offline, and
**must be re-checked against the live API before any provider secret is set**:

| Provider | Endpoint recorded |
|---|---|
| `meta_capi` | `POST https://graph.facebook.com/v21.0/<dataset>/events` |
| `google_ads` | `POST https://googleads.googleapis.com/v18/customers/<id>:uploadClickConversions` |
| `tiktok` | `POST https://business-api.tiktok.com/open_api/v1.3/event/track/` |
| `snapchat` | `POST https://tr.snapchat.com/v2/conversion` |

Until then every provider is unconfigured and every delivery is `sandbox`, so a
wrong URL costs nothing.

---

## 4. Idempotency and dedup

Three independent layers, on purpose:

1. `ads_processed_events(event_id)` — inserted in the same batch as the delivery
   rows, so a redelivered envelope is `replayed` and produces no second row;
2. `ads_deliveries UNIQUE (event_id, provider)` — the table itself refuses a
   duplicate even if the processed-events row is gone (a replay from an admin,
   a restored backup);
3. the provider's own dedup on **our** `event_id` — `event_id` for Meta and
   TikTok, `orderId` for Google, `client_dedup_id` for Snapchat — which is what
   makes it safe for `send()` to happen before the batch commits.

## 5. Tables

Owned (`01-TARGET.md` §2.1), in this service's **own** D1: `ads_providers`,
`ads_event_map`, `ads_deliveries`, `ads_consent_snapshots`, `ads_dead_letters`,
plus the platform tables `ads_processed_events` and `ads_idempotency`.

Read from another service: **none**. `test/boundaries.test.ts` proves the
runtime guard refuses a foreign statement rather than logging it.

## Bindings (least privilege)

Every binding this Worker holds, in every environment, and nothing else —
`tests/boundariesBindings.test.ts` compares this list against
`wrangler.jsonc` in both directions, so a binding added to the config without a
line here fails `npm run check`.

| Binding | Kind | Why Ads has it |
|---|---|---|
| `DB` | D1 | its own store, `levonis-ads-db` (dark: `levonis-ads-db-dark`) |

Ads binds no other service. It is a consumer: events arrive on `deliver()` over
someone else's binding, and the only outbound calls are to the ad platforms —
through `fetchWithBudget`, and only when a provider's secret NAMES are all
present. That is why an unconfigured provider has no code path to a `fetch` at
all rather than a flag in front of one.
