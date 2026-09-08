# `levonis-analytics` — contract

The public methods of `AnalyticsEntrypoint` (`src/index.ts`) and the three HTTP
routes below **are** the contract. Response types:
`packages/contracts/src/http/analytics.ts`. Design: `01-TARGET.md` row 17 and
§9.2; `02-MIGRATION-PLAN.md` 1.7 and 2.1; `03-EVENTS.md` §5 (PII) and §6 (the
explicit allowlist that replaced the wildcard).

---

## RPC (over a service binding)

Hop-guarded when any caller key is registered (`ALLOWED_CALLER_KIDS`);
allowlist in `src/guard.ts`. Analytics **writes nothing on request** — its only
input is the bus.

| Method | Callers | What it does |
|---|---|---|
| `deliver(batch, hop?)` | every producer (the bus) | Ingests the events whose consumer list contains `analytics`. Refuses a malformed envelope, an unsubscribed type, a `source_service` outside the type's `producers`, a bad signature, and any `personal` envelope (its ceiling is `pseudonymous`). Projects, counts and appends in ONE batch with `analytics_processed_events`, so a redelivery adds neither a row nor a count. |
| `overview(range?, ctx)` | `admin`, `support` | The counter half of today's `GET /api/admin/overview`, from the rollups. `range` is `{from?, to?}` as `YYYY-MM-DD`. |
| `daily(opts?, ctx)` | `admin`, `support` | The platform series: `[{day, metric, value}]`, optionally one metric and a day range. |
| `merchantDaily(merchantId, opts?, ctx)` | `admin`, `support`, `marketplace` | One merchant's series. One merchant per call, always. |
| `health()` | anyone (never hop-guarded) | `{ok, svc:'analytics', ver, checks:{db, outbox_lag_s}}`. Analytics publishes nothing, so `outbox_lag_s` carries the freshness that matters: seconds since the newest event was ingested. |

## HTTP (through the gateway)

| Route | Who | Response |
|---|---|---|
| `GET /api/v1/analytics/admin/overview?from=&to=` | admin, apex | `AnalyticsOverviewResponse` |
| `GET /api/v1/analytics/admin/daily?metric=&from=&to=` | admin, apex | `PlatformDailyResponse` |
| `GET /api/v1/analytics/merchant/daily?merchant_id=&metric=&from=&to=` | the merchant itself, or `admin:full` | `MerchantDailyResponse` |
| `GET /health` | anyone | the legacy health body plus `svc` |

A principal signed by Identity (the core until Phase 9) is required on every
`/api/v1/*` route; Analytics never sees a cookie. The admin routes are
apex-only and need `role:'admin'` — but **not** `admin:full`: these are
aggregates with no money row and no person in them, which is the whole point of
the store. The merchant route is not apex-only (a merchant dashboard lives on
its storefront host) and proves ownership the only way a service with no
merchant table can: the principal's own `sub`, or a full-scope admin.

## Events consumed

The 21 `analytics` rows of `packages/contracts/src/subscriptions.ts` — the
explicit allowlist of `none`/`pseudonymous` events. `test/projection.test.ts`
fails if the mapper set and the subscription set disagree, so a subscription
cannot be half-added. Events produced: **none**.

## What it stores — and what it refuses to

`analytics_events` (the PII projection of each accepted event, rolled at 30
days), `analytics_daily_platform`, `analytics_daily_merchant` (kept
indefinitely), in its **own** database (`levonis-analytics-db`).

The projection is mechanical and driven by the catalogue, not by a list kept
here:

1. every payload field the schema annotates `pii` is **dropped** before the row
   is written (`EVENT_SCHEMAS[key].pii`);
2. the envelope's `actor_id` becomes `sha256(day : ANALYTICS_HASH_SALT : actor)`
   — new every day, so a person cannot be followed across days from this store;
3. `aggregate_id` gets the same treatment when the aggregate IS a person
   (`user`, `wallet`, `membership`, `cart`) — otherwise dropping `user_id` from
   a payload would be theatre, since the wallet events beside it carry the same
   person as their aggregate id;
4. `merchant_id` is lifted into its own column: a merchant is a store, not a
   person, and it is what the merchant rollups are keyed by.

`test/projection.test.ts` asserts (1)–(3) over the whole subscribed catalogue
and then reads the entire store back as text to prove no raw person id is in it.

## The numbers

`src/metrics.ts` maps one event to counters — pure, total, integers only. They
are maintained twice on purpose: **added** in the delivery batch (so a number is
right within a second and its idempotency is the consumer's), and **recomputed**
for the last day or two by the cron, which REPLACES the day. Both call the same
function, so they cannot disagree about what a number means; if they disagree
about a value, the recompute wins and the bug has one home. A day with more raw
rows than `ANALYTICS_ROLLUP_MAX_ROWS` is left to the incremental numbers rather
than half-recomputed.

`overview()` names what it cannot know instead of guessing: `users.total` counts
signups seen since the bus started (Analytics owns no user table),
`users.investors` is always 0 (the flag travels on `RoleChanged`, a `personal`
event this store may never see), `orders.pending` is `created − delivered −
cancelled` over the range. The live lists stay with their owning services
(`01-TARGET.md` §9.2).

## Deployment facts a caller may rely on

- No route, ever. `workers_dev:false` and `preview_urls:false` in production.
- Its own D1 (`levonis-analytics-db`, dark `levonis-analytics-db-dark`) with its
  own migration stream, applied by its own workflow before its code.
- Cron `*/5 * * * *` — repair and retention only; nothing a user waits on.
- Secrets: `ANALYTICS_HASH_SALT`, `ANALYTICS_SIGNING_KEY`, `HEALTH_PROBE_TOKEN`
  (`SECRETS.md`, names only).
- `analytics_engine_datasets: EVENTS_AE` is the later sink (`01-TARGET.md`
  row 17); the D1 tables are the implementation of the same read models, so
  adopting it is a config switch plus a writer, not a rewrite of the contract.

## Bindings (least privilege)

Every binding this Worker holds, in every environment, and nothing else —
`tests/boundariesBindings.test.ts` compares this list against
`wrangler.jsonc` in both directions, so a binding added to the config without a
line here fails `npm run check`.

| Binding | Kind | Why Analytics has it |
|---|---|---|
| `DB` | D1 | its own store, `levonis-analytics-db` (dark: `levonis-analytics-db-dark`) |
| `IDENTITY` | service (`IdentityEntrypoint`) | `getPublicKeys` only, to verify producers' event signatures. A metric store that called the systems it measures would be neither |
